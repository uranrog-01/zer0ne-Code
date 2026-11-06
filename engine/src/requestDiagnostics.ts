import { createHash, randomUUID } from 'crypto';
import type { StreamOptions, StreamResult } from './chatClient';
import type { ModelUsage, UsagePrices } from './usage';
import type { AttemptLease } from './core/taskBudget';

export interface RequestContext {
	rootTaskId?: string;
	prefixReason?: string;
	sessionId?: string;
	turnId?: string;
	parentTurnId?: string;
	step?: number;
	taskId?: string;
	purpose?: 'main' | 'child' | 'summary' | 'title' | 'warm' | 'helper' | 'autocomplete';
}
export interface RequestAttempt extends RequestContext {
	id: string;
	providerId?: string;
	model: string;
	format: string;
	startedAt: number;
	durationMs: number;
	prepareMs?: number;
	responseMs?: number;
	firstEventMs?: number;
	firstTextMs?: number;
	firstReasoningMs?: number;
	firstToolMs?: number;
	stopReason?: string;
	outcome: 'completed' | 'failed' | 'cancelled';
	status?: number;
	providerRequestId?: string;
	usage?: ModelUsage;
	request?: { basis: 'serialized'; bytes: number; route: string; system: string; tools: string; history: string; configuration?: string; prefixStable?: boolean; changed?: string; stability?: number };
	cost?: number;
	costKind?: 'estimated' | 'free' | 'subscription' | 'local' | 'unknown';
	prices?: UsagePrices;
	priceVersion?: string;
	capabilityDowngrades?: string[];
}

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? '').digest('hex');
// Cache markers and transport flags are not model text. Preserve array/property
// order, reasoning, signatures and attachment representations from the adapter.
function modelContent(v: any): any {
	if (Array.isArray(v)) return v.map(modelContent);
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([key]) => key !== 'cache_control').map(([key, value]) => [key, modelContent(value)]));
	return v;
}
type Prefix = { route: string; system: string; tools: string; configuration: string; history: string[]; checks: number; stable: number };
const prefixes = new Map<string, Prefix>();

export function serializedRequest(url: string, body: any, scope?: string): NonNullable<RequestAttempt['request']> {
	const endpoint = new URL(url);
	const route = hash([endpoint.origin, endpoint.pathname, body.model]);
	const system = hash(modelContent(body.system ?? body.instructions ?? body.systemInstruction ?? null));
	const tools = hash(modelContent(body.tools ?? body.toolConfig ?? []));
	const configuration = hash(modelContent(Object.fromEntries(['reasoning', 'reasoning_effort', 'reasoning_budget_tokens', 'thinking', 'output_config', 'response_format', 'text', 'parallel_tool_calls', 'tool_choice', 'generationConfig', 'context_management', 'prompt_cache_options', 'prompt_cache_retention', 'chat_template_kwargs'].filter(key => body[key] !== undefined).map(key => [key, body[key]]))));
	const history = (body.messages ?? body.input ?? body.contents ?? (body.prompt !== undefined ? [{ prompt: body.prompt, suffix: body.suffix }] : [])).map((m: any) => hash(modelContent(m)));
	// The [OI]-compatible format carries the system prompt as the first message rather than
	// in a top-level field. A user reads this label to explain a bad cache number, so name
	// it as the system prompt instead of "history message 1".
	const systemInMessages = Array.isArray(body.messages) && body.messages[0]?.role === 'system';
	const previous = scope ? prefixes.get(scope) : undefined;
	let changed: string | undefined;
	if (previous) {
		if (previous.route !== route) changed = 'route';
		else if (previous.configuration !== configuration) changed = 'configuration';
		else {
			const order = body.system !== undefined ? ['tools', 'system'] as const : ['system', 'tools'] as const;
			for (const part of order) if (previous[part] !== (part === 'system' ? system : tools)) { changed = part; break; }
			if (!changed) {
				const index = previous.history.findIndex((value, i) => value !== history[i]);
				if (index >= 0) changed = index === 0 && systemInMessages ? 'system' : `history message ${index + 1}`;
			}
		}
	}
	const checks = (previous?.checks ?? 0) + (previous ? 1 : 0);
	const stable = (previous?.stable ?? 0) + (previous && !changed ? 1 : 0);
	if (scope) {
		prefixes.delete(scope);
		prefixes.set(scope, { route, system, tools, configuration, history, checks, stable });
		if (prefixes.size > 128) prefixes.delete(prefixes.keys().next().value!);
	}
	return { basis: 'serialized', bytes: Buffer.byteLength(JSON.stringify(body)), route, system, tools, configuration, history: hash(history),
		prefixStable: previous ? !changed : undefined, changed, stability: checks ? stable / checks * 100 : undefined };
}

export class RequestTrace {
	readonly attempts: RequestAttempt[] = [];
	private current?: RequestAttempt;
	private start = performance.now();
	private clock = this.start;
	private lease?: AttemptLease;
	private downgrades: string[] = [];
	constructor(private readonly options: StreamOptions) {}
	async begin(url: string, body: unknown): Promise<void> {
		this.finish('failed');
		this.lease = await this.options.beforeAttempt?.(url, body);
		this.clock = performance.now();
		const context = this.options.requestContext;
		this.current = { ...context, id: randomUUID(), providerId: this.options.providerId, model: this.options.model, format: this.options.apiFormat,
			startedAt: Date.now(), durationMs: 0, prepareMs: this.clock - this.start, outcome: 'failed',
		};
		this.current.request = serializedRequest(url, body, context?.sessionId ? JSON.stringify([this.options.providerId, context.sessionId, context.purpose ?? 'helper', context.taskId]) : undefined);
		if (this.downgrades.length) this.current.capabilityDowngrades = [...this.downgrades];
	}
	response(response: Response): void {
		if (!this.current) return;
		this.current.status = response.status;
		this.current.responseMs = performance.now() - this.clock;
		this.current.providerRequestId = (response.headers.get('request-id') ?? response.headers.get('x-request-id'))?.slice(0, 256);
	}
	event(): void { if (this.current) this.current.firstEventMs ??= performance.now() - this.clock; }
	content(kind: 'text' | 'reasoning'): void {
		if (!this.current) return;
		this.event();
		if (kind === 'text') this.current.firstTextMs ??= performance.now() - this.clock;
		else this.current.firstReasoningMs ??= performance.now() - this.clock;
	}
	usage(usage: ModelUsage): void {
		if (this.current) this.current.usage = { ...usage, cacheTtlRequested: this.options.promptCache?.ttl ?? this.options.cacheTtl };
	}
	finish(outcome: RequestAttempt['outcome'], usage?: ModelUsage): void {
		if (!this.current) return;
		if (usage) this.usage(usage);
		const attempt = this.current;
		this.current = undefined;
		attempt.durationMs = performance.now() - this.clock;
		attempt.outcome = outcome;
		if (outcome !== 'completed' && attempt.usage) attempt.usage = { ...attempt.usage, outputReported: false };
		this.attempts.push(attempt);
		this.lease?.finish(attempt); this.lease = undefined;
		try { this.options.onAttempt?.(attempt); } catch { /* Diagnostics must not interrupt model/tool execution. */ }
	}
	async run(call: (options: StreamOptions) => Promise<StreamResult>): Promise<StreamResult> {
		const options = { ...this.options, requestTrace: this,
			onToolCall: (call: import('./chatClient').ToolCall) => { if (this.current) this.current.firstToolMs ??= performance.now() - this.clock; this.options.onToolCall?.(call); },
			onCapabilityDowngrade: (fields: string[]) => {
				this.downgrades = [...new Set([...this.downgrades, ...fields])];
				if (this.current) this.current.capabilityDowngrades = [...new Set([...(this.current.capabilityDowngrades ?? []), ...fields])];
				else if (this.attempts.length) this.attempts[this.attempts.length - 1]!.capabilityDowngrades = [...this.downgrades];
				this.options.onCapabilityDowngrade?.(fields);
			},
			onText: (text: string) => { if (text) this.content('text'); this.options.onText?.(text); },
			onReasoning: (text: string) => { if (text) this.content('reasoning'); this.options.onReasoning?.(text); } };
		// Agent/LM transports do not expose their wire payload to this client.
		if (options.apiFormat === 'acp' || options.apiFormat === 'vscode-lm') {
			this.lease = await options.beforeAttempt?.('', { system: options.system, tools: options.tools, messages: options.messages });
			this.current = { ...options.requestContext, id: randomUUID(), providerId: options.providerId, model: options.model,
				format: options.apiFormat, startedAt: Date.now(), durationMs: 0, outcome: 'failed' };
		}
		try {
			const result = await call(options);
			if (this.current) this.current.stopReason = result.stopReason;
			this.finish('completed', result.usage);
			return { ...result, attempts: this.attempts };
		} catch (error) {
			this.finish(options.signal.aborted || (error as Error)?.name === 'AbortError' ? 'cancelled' : 'failed');
			throw error;
		}
	}
}
