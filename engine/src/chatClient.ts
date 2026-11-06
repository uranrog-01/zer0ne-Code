/**
 * Streaming client for the two wire protocols a provider can speak:
 *
 *  - openai:    POST {baseUrl}/chat/completions (Bearer auth). Text at
 *               choices[0].delta.content, reasoning at delta.reasoning_content
 *               / delta.reasoning, tool calls at delta.tool_calls.
 *  - anthropic: POST {baseUrl}/v1/messages (x-api-key). text_delta,
 *               thinking_delta and tool_use blocks (input_json_delta).
 *
 * Both formats support agent tools, reasoning streams and exact usage.
 * VS Code's extension host runs on modern Node, so the global `fetch`
 * covers everything — zero runtime dependencies.
 */

import { fetchNativeModels, streamBedrock, streamGemini, streamVertex } from './nativeProviders';
import { streamCodex } from './codexClient';
import type { AcpTurnHooks } from './acp/types';
import { RequestTrace, type RequestAttempt, type RequestContext } from './requestDiagnostics';
import { createHash, randomUUID } from 'crypto';
import { anthropicUsage, openaiUsage, type ModelUsage } from './usage';
import { stableTools } from './prefixStability';
import { textToolCalls } from './core/textToolCalls';
import { advertisedReasoning, reasoningHints, type ReasoningControl, type ReasoningEffort } from './reasoning';
import { continuation, nativeItems, type NativeState } from './continuation';
import { executableCall, functionTool } from './toolSchema';

/** `acp` = an agent that signs the user in itself and does its own tool work (src/acp). */
export type ApiFormat = 'openai' | 'responses' | 'anthropic' | 'vscode-lm' | 'gemini' | 'bedrock' | 'vertex' | 'codex' | 'acp';

export interface MessageImage {
	mime: string;
	base64: string;
	name: string;
}

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON argument string, as the model produced it. */
	arguments: string;
	/** Nullable strict-schema optionals are omitted only for local execution, never for replay. */
	executionArguments?: string;
	/** Provider state that must travel back with the call (Gemini thought signatures). */
	signature?: string;
	/** Responses namespace, retained independently of the executable local tool name. */
	namespace?: string;
}

export interface ToolDef {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export type ChatMessage =
	| { role: 'user'; content: string; images?: MessageImage[] }
	| {
			role: 'assistant';
			content: string;
			toolCalls?: ToolCall[];
			/**
			 * The model's reasoning for this step. Interleaved-thinking models (DeepSeek V3.2+,
			 * Kimi K2/K3 Thinking, GLM-4.6+, MiniMax M-series) expect it back on the tool-call
			 * steps of the current turn; it is sent only there.
			 */
			reasoning?: string;
			native?: NativeState;
	  }
	/** `failed`: the call failed; pruning keeps the gist of failures so the model does not repeat them. */
	| { role: 'tool'; toolCallId: string; name: string; content: string; images?: MessageImage[]; failed?: boolean };

export interface StreamOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	apiFormat: ApiFormat;
	/** ChatGPT plan OAuth has a narrower Responses contract than regular API-key access. */
	chatgptPlan?: boolean;
	system: string;
	messages: ChatMessage[];
	signal: AbortSignal;
	tools?: ToolDef[];
	/** reasoning_effort hint (OpenAI format; Gemini maps it to a thinking budget); undefined = omit. */
	effort?: ReasoningEffort;
	reasoningControl?: ReasoningControl;
	/** Stable per-conversation key: routes requests to the same cache (OpenAI prompt_cache_key). */
	cacheKey?: string;
	/** Output token cap (required by the Anthropic format). */
	maxTokens?: number;
	/** Anthropic prompt-cache lifetime: '1h' keeps it across longer pauses (writes cost 2× instead of 1.25×). */
	cacheTtl?: '5m' | '1h';
	promptCache?: { mode?: 'implicit' | 'explicit'; ttl?: '30m' | '12h' };
	strictTools?: boolean;
	onCapabilityDowngrade?: (fields: string[]) => void;
	/**
	 * Ask for JSON output (OpenAI response_format / Gemini responseMimeType).
	 * 'json' → any valid JSON object; 'schema' → a named JSON Schema. Formats
	 * without an equivalent (Anthropic family) ignore it.
	 */
	responseFormat?: { type: 'json' } | { type: 'schema'; name: string; schema: Record<string, unknown> };
	/** OpenRouter: route only to zero-retention providers. Off/undefined = the provider's default routing. */
	zeroRetention?: boolean;
	onText?: (text: string) => void;
	onReasoning?: (text: string) => void;
	/** A tool call finished streaming (complete JSON arguments) — before the whole answer ends. */
	onToolCall?: (call: ToolCall) => void;
	/** `acp` providers: the workspace, approvals, file access and cards for this turn. */
	acp?: AcpTurnHooks;
	/** The provider this call belongs to (agent sessions are kept per provider and chat). */
	providerId?: string;
	requestContext?: RequestContext;
	onAttempt?: (attempt: RequestAttempt) => void;
	/** Internal observer shared with native adapters; never serialized. */
	requestTrace?: RequestTrace;
	stablePrefix?: boolean;
	beforeAttempt?: (url: string, body: unknown) => Promise<import('./core/taskBudget').AttemptLease>;
}

export interface StreamResult {
	text: string;
	reasoning: string;
	toolCalls: ToolCall[];
	native?: NativeState;
	/** cached = prompt tokens served from the provider's prompt cache. */
	usage?: ModelUsage;
	attempts?: RequestAttempt[];
	/** 'length' / 'max_tokens' means the answer was cut off. */
	stopReason?: string;
}

const ANTHROPIC_VERSION = '2023-06-01';

function trimBase(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, '');
}

/**
 * The Anthropic endpoint owns the `/v1` segment. Accept base URLs with or
 * without it (and even a pasted full endpoint) without doubling it.
 */
export function anthropicUrl(baseUrl: string, resource: 'messages' | 'models'): string {
	let base = trimBase(baseUrl);
	base = base.replace(/\/v1\/(?:messages|models)$/i, '').replace(/\/(?:messages|models)$/i, '');
	return /\/v1$/i.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`;
}

/** Accept a pasted full endpoint (…/chat/completions) as the base URL. */
export function openaiUrl(baseUrl: string, resource: 'chat/completions' | 'models'): string {
	const base = trimBase(baseUrl).replace(/\/(?:chat\/completions|models)$/i, '');
	return `${base}/${resource}`;
}

/** The OpenAI-compatible images endpoint; a pasted full endpoint is accepted too. */
export function imagesUrl(baseUrl: string): string {
	const base = trimBase(baseUrl).replace(/\/(?:images\/generations|images\/edits|chat\/completions|models)$/i, '');
	return `${base}/images/generations`;
}

function describeHttpError(status: number, body: string, model?: string): Error {
	let detail = body.trim();
	try {
		const json = JSON.parse(detail);
		detail = json?.error?.message ?? json?.message ?? json?.error ?? detail;
		if (typeof detail !== 'string') {
			detail = JSON.stringify(detail);
		}
	} catch {
		// not JSON — keep the raw text
	}
	if (model && /model[_ ]not[_ ]found|no available channel|does not exist|unknown model/i.test(detail)) {
		return new Error(
			`The provider does not serve model "${model}" (HTTP ${status}). Open Providers & models → Fetch models to pick an exact model ID.`
		);
	}
	if (status === 401 || status === 403) {
		return new Error(`Authentication failed (HTTP ${status}). Check the API key in Providers & models. ${detail.slice(0, 200)}`);
	}
	if (status === 429) {
		return new Error(`Rate limited by the provider (HTTP 429). Wait a moment and retry. ${detail.slice(0, 200)}`);
	}
	return new Error(`Provider error ${status}: ${detail.slice(0, 400) || 'no details'}`);
}

/**
 * Stream watchdog (as oh-my-pi's per-provider watchdogs): a provider that
 * never answers, or goes silent mid-stream, is cut off with a retryable
 * "timed out" error instead of hanging the turn. Local servers get far more
 * time — loading a model and reading a long prompt on a CPU takes minutes.
 */
export const WATCHDOG = { firstByteMs: 120_000, idleMs: 180_000, localFirstByteMs: 30 * 60_000, localIdleMs: 10 * 60_000 };
const isLocalUrl = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
/** Idle limit for an SSE body, keyed by the response it belongs to. */
const idleLimit = new WeakMap<Response, number>();

export async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, model: string, trace?: RequestTrace): Promise<Response> {
	await trace?.begin(url, body);
	let response: Response;
	const local = isLocalUrl(url);
	const firstByte = new AbortController();
	const timer = setTimeout(() => firstByte.abort(), local ? WATCHDOG.localFirstByteMs : WATCHDOG.firstByteMs);
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: AbortSignal.any([signal, firstByte.signal])
		});
	} catch (error) {
		trace?.finish(signal.aborted ? 'cancelled' : 'failed');
		if (firstByte.signal.aborted && !signal.aborted) {
			throw new Error(`No response from ${new URL(url).host} within ${Math.round((local ? WATCHDOG.localFirstByteMs : WATCHDOG.firstByteMs) / 1000)} s (timed out).`);
		}
		if ((error as Error).name === 'AbortError' || signal.aborted) {
			throw error;
		}
		const cause = (error as { cause?: { code?: string } }).cause?.code;
		throw new Error(`Could not reach ${url}${cause ? ` (${cause})` : ''} — check the Base URL and your connection.`);
	} finally {
		clearTimeout(timer);
	}
	idleLimit.set(response, local ? WATCHDOG.localIdleMs : WATCHDOG.idleMs);
	trace?.response(response);
	if (!response.ok) {
		trace?.finish(signal.aborted ? 'cancelled' : 'failed');
		const error = describeHttpError(response.status, await readResponseText(response), model);
		const after = retryAfterMs(response.headers);
		if (after !== undefined) {
			Object.assign(error, { retryAfterMs: after });
		}
		throw error;
	}
	return response;
}

/** Retry-After / retry-after-ms / x-ratelimit-reset-* → milliseconds, when the provider says. */
export function retryAfterMs(headers: Headers): number | undefined {
	const ms = Number(headers.get('retry-after-ms'));
	if (ms > 0) return ms;
	const ra = headers.get('retry-after');
	if (ra) {
		const s = Number(ra);
		if (Number.isFinite(s) && s >= 0) return s * 1000;
		const at = Date.parse(ra);
		if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
	}
	const reset = headers.get('x-ratelimit-reset-requests') ?? headers.get('x-ratelimit-reset-tokens');
	const m = reset && /^(?:(\d+)m)?(?:([\d.]+)s)?(?:(\d+)ms)?$/.exec(reset.trim());
	if (m && (m[1] || m[2] || m[3])) return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000 + Number(m[3] ?? 0);
	return undefined;
}

/** Hard ceiling for one streamed response. */
export interface ResponseLimits {
	/** Bytes read from the response body. */
	maxBytes: number;
	/** Characters of response text (the SSE payloads the provider actually sent). */
	maxTextChars: number;
}

/**
 * A provider's `max_tokens` is a server-side hint the client cannot rely on, and the task
 * budget is off by default, so one response is bounded here. 32 MiB is orders of magnitude
 * above a real answer. Callers may narrow or widen it.
 */
export const responseLimits: ResponseLimits = { maxBytes: 32 * 1024 * 1024, maxTextChars: 32 * 1024 * 1024 };

/**
 * Counts the text a provider has sent for one response. The provider's `max_tokens` is a
 * server-side hint the client cannot rely on, so the client bounds what one answer may cost.
 */
export class ResponseTextGuard {
	private length = 0;
	constructor(private readonly limit: number = responseLimits.maxTextChars) {}
	/** Count newly received characters; throws when the ceiling is passed. */
	add(text: string): void {
		this.length += text.length;
		if (this.length > this.limit) {
			throw new Error(`The provider's response exceeded the ${Math.round(this.limit / 1048576)} MB text limit and was aborted.`);
		}
	}
}

async function* responseChunks(response: Response, limits: ResponseLimits): AsyncGenerator<string> {
	if (!response.body) {
		throw new Error('The provider returned an empty response body.');
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let chars = 0;
	const idle = idleLimit.get(response) ?? WATCHDOG.idleMs;
	// Each read races the idle limit: a stream that stops sending is cancelled, not waited on forever.
	const read = () =>
		new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
			const t = setTimeout(() => {
				void reader.cancel().catch(() => undefined);
				reject(new Error(`The stream stalled — no data for ${Math.round(idle / 1000)} s (timed out).`));
			}, idle);
			reader.read().then(
				(r) => (clearTimeout(t), resolve(r)),
				(e) => (clearTimeout(t), reject(e))
			);
		});
	try {
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > limits.maxBytes) throw new Error(`The provider's response is larger than the ${Math.round(limits.maxBytes / 1048576)} MB limit.`);
		while (true) {
			const { done, value } = await read();
			bytes += value?.byteLength ?? 0;
			if (bytes > limits.maxBytes) {
				throw new Error(`The provider's response exceeded the ${Math.round(limits.maxBytes / 1048576)} MB limit and was aborted.`);
			}
			const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
			chars += text.length;
			if (chars > limits.maxTextChars) throw new Error(`The provider's response exceeded the ${Math.round(limits.maxTextChars / 1048576)} MB text limit and was aborted.`);
			if (text) yield text;
			if (done) break;
		}
	} finally {
		void reader.cancel().catch(() => undefined);
		try {
			reader.releaseLock();
		} catch {
			/* a cancelled read still holds the lock */
		}
	}
}

async function readResponseText(response: Response, limits = responseLimits): Promise<string> {
	let text = '';
	for await (const chunk of responseChunks(response, limits)) text += chunk;
	return text;
}

/** Parse an SSE stream, calling `onData` with each `data:` payload. */
export async function readSse(response: Response, onData: (data: string) => void, limits: ResponseLimits = responseLimits): Promise<void> {
	if ((response.headers.get('content-type') ?? '').includes('application/json')) {
		onData(await readResponseText(response, limits));
		return;
	}
	const flushLine = (line: string): boolean => {
		const trimmed = line.trim();
		if (!trimmed.startsWith('data:')) return false;
		const payload = trimmed.slice(5).trim();
		if (payload === '[DONE]') return true;
		if (payload) onData(payload);
		return false;
	};
	let buffer = '';
	for await (const chunk of responseChunks(response, limits)) {
		buffer += chunk;
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';
		for (const line of lines) if (flushLine(line)) return;
	}
	if (buffer) flushLine(buffer);
}

export function parseJson(payload: string): any {
	try {
		return JSON.parse(payload);
	} catch {
		return undefined; // keep-alive / comment lines from proxies
	}
}

/**
 * Some models (DeepSeek-R1 distills, QwQ…) inline reasoning as
 * <think>…</think> in the content stream. Split it into its own channel.
 */
class ThinkSplitter {
	private mode: 'detect' | 'think' | 'text' = 'detect';
	private pending = '';

	constructor(private readonly onText: (t: string) => void, private readonly onThink: (t: string) => void) {}

	push(chunk: string): void {
		this.pending += chunk;
		while (this.pending) {
			if (this.mode === 'detect') {
				const trimmed = this.pending.trimStart();
				if (trimmed.startsWith('<think>')) {
					this.pending = trimmed.slice('<think>'.length);
					this.mode = 'think';
				} else if ('<think>'.startsWith(trimmed)) {
					return; // could still become <think>
				} else {
					this.mode = 'text';
				}
			} else if (this.mode === 'think') {
				const end = this.pending.indexOf('</think>');
				if (end >= 0) {
					this.onThink(this.pending.slice(0, end));
					this.pending = this.pending.slice(end + '</think>'.length).replace(/^\s+/, '');
					this.mode = 'text';
				} else {
					// Hold back a possible partial closing tag.
					const safe = this.pending.length - '</think>'.length;
					if (safe > 0) {
						this.onThink(this.pending.slice(0, safe));
						this.pending = this.pending.slice(safe);
					}
					return;
				}
			} else {
				this.onText(this.pending);
				this.pending = '';
			}
		}
	}

	flush(): void {
		if (this.pending) {
			(this.mode === 'think' ? this.onThink : this.onText)(this.pending);
			this.pending = '';
		}
	}
}

export async function streamChat(options: StreamOptions): Promise<StreamResult> {
	const routed = { ...options, apiFormat: modelApiFormat(options) };
	let official = false;
	try { official = new URL(options.baseUrl).hostname === 'api.openai.com'; } catch { /* Invalid endpoints fail at the transport boundary. */ }
	const strictTools = ['openai', 'responses', 'codex'].includes(routed.apiFormat) && (options.strictTools ?? (official && routed.apiFormat === 'responses'));
	const normalized = { ...routed, strictTools, onToolCall: options.onToolCall ? (call: ToolCall) => options.onToolCall!(executableCall(call, options.tools, strictTools)) : undefined };
	const stable = options.stablePrefix !== false ? { ...normalized, tools: stableTools(options.tools) } : normalized;
	const result = await new RequestTrace(stable).run(o => {
		if (options.strictTools && !strictTools) o.onCapabilityDowngrade?.(['strict tool arguments (unsupported transport)']);
		return dispatchChat(o);
	});
	result.toolCalls = result.toolCalls.map(call => executableCall(call, options.tools, strictTools));
	// A model that wrote its tool calls as text (the server's template did not convert them) still gets them run.
	if (!result.toolCalls.length && options.tools?.length && routed.apiFormat !== 'acp') {
		const found = textToolCalls(result.text, new Set(options.tools.map((t) => t.name)), `call_text_${Date.now().toString(36)}`);
		if (found.calls.length) return { ...result, text: found.text, toolCalls: found.calls, stopReason: result.stopReason === 'stop' || result.stopReason === 'end_turn' ? 'tool_calls' : result.stopReason };
	}
	return result;
}

/** Go publishes one model list but requires a different wire protocol for each family. */
export function modelApiFormat(options: Pick<StreamOptions, 'apiFormat' | 'baseUrl' | 'model'>): ApiFormat {
	if (options.apiFormat !== 'openai') return options.apiFormat;
	try {
		const url = new URL(options.baseUrl);
		if (url.hostname === 'api.openai.com' && /^gpt-(?:5\.6|6(?:\.|-))/i.test(options.model)) return 'responses';
		if (url.hostname !== 'opencode.ai' || !/^\/zen\/go\/v1\/?$/.test(url.pathname)) return options.apiFormat;
		if (/^(gpt-|grok-|muse-)/i.test(options.model)) return 'responses';
		if (/^claude-/i.test(options.model) || /^(minimax-m3|minimax-m2\.7|qwen3\.8-(max|flash)|qwen3\.7-plus)$/i.test(options.model)) return 'anthropic';
	} catch { /* Endpoint validation reports malformed URLs at the request boundary. */ }
	return options.apiFormat;
}

async function dispatchChat(options: StreamOptions): Promise<StreamResult> {
	switch (options.apiFormat) {
		case 'anthropic':
			return streamAnthropic(options);
		case 'gemini':
			return streamGemini(options);
		case 'bedrock':
			return streamBedrock(options);
		case 'vertex':
			return streamVertex(options);
		case 'codex':
		case 'responses':
			return streamCodex(options);
		case 'acp':
			return (await import('./acp/stream')).streamAcp(options);
		default:
			return streamOpenAI(options);
	}
}

// ---------------------------------------------------------------- OpenAI

/**
 * Mistral only accepts 9-character alphanumeric tool-call ids. Ids from
 * other providers (after a model switch or a fallback) are mapped to a
 * stable 9-character hash, the same for the call and its result.
 */
export function strictToolIds(baseUrl: string): boolean {
	return /(^|\.)mistral\.ai|codestral/i.test(hostOf(baseUrl));
}
export function shortToolId(id: string): string {
	if (/^[a-zA-Z0-9]{9}$/.test(id)) {
		return id;
	}
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < id.length; i++) {
		h1 = Math.imul(h1 ^ id.charCodeAt(i), 16777619);
		h2 = Math.imul(h2 + id.charCodeAt(i), 2246822507);
	}
	const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let out = '';
	for (let i = 0; i < 9; i++) {
		const n = i < 5 ? h1 >>> (i * 6) : h2 >>> ((i - 5) * 6);
		out += chars[n % 62];
	}
	return out;
}
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/**
 * Optional OpenAI-format fields a server may refuse (Mistral, older vLLM / llama.cpp, strict
 * gateways). `stream_options` is deliberately not here: it carries the usage chunk, so
 * dropping it disables usage reporting for the endpoint. It is only dropped when the server
 * itself refuses it (or refuses unknown fields as a class) — never as collateral damage of an
 * unrelated refusal.
 */
const OPTIONAL_PARAMS = ['reasoning_effort', 'prompt_cache_key', 'response_format'] as const;

/** What a generic refusal drops: the compatibility fields, never the usage reporter. */
const DEFAULT_STRIP = withCompanions(new Set<string>([...OPTIONAL_PARAMS]));

/** Every optional body field, for a server that refuses unknown fields as a class. */
const ALL_OPTIONAL_PARAMS = ['reasoning_effort', 'thinking', 'prompt_cache_key', 'stream_options', 'reasoning', 'response_format'] as const;

/** The server refuses unknown fields as a class ("Extra inputs are not permitted"). */
const STRICT_SCHEMA = /extra (?:inputs|fields)|additional propert/i;

/** The error looks like a complaint about a request field the server did not accept. */
const REJECTS_OPTIONAL = /reasoning_effort|reasoning_content|stream_options|prompt_cache_key|response_format|json_schema|unrecognized (request )?(argument|field|param)|unknown (field|param|argument)|extra (fields|inputs)|not permitted|additional propert|unsupported (parameter|field)/i;

/** The optional fields an error answer names, e.g. "unknown parameter reasoning_effort". */
function namedOptionalFields(message: string): Set<string> {
	const found = new Set<string>();
	for (const field of ALL_OPTIONAL_PARAMS) if (new RegExp(`\\b${field}\\b`, 'i').test(message)) found.add(field);
	if (/\breasoning_content\b/i.test(message)) found.add('reasoning_content');
	return found;
}

/** What one endpoint refuses, learned from its own 400/422 answers. */
interface EndpointLimits {
	host: string;
	model: string;
	/** A non-reversible identity of the key in use (the key itself is never kept). */
	keyId: string;
	/** Body fields this endpoint refuses; they are never sent to it again. */
	refused: Set<string>;
	/** The endpoint refuses the replayed assistant reasoning field. */
	noReasoningContent: boolean;
	/** When the refusal was learned (ms epoch). */
	since: number;
}

/**
 * URL|model|key endpoints and what they refuse. The key identity is part of it: a shared
 * gateway serves several keys, and one key a server refuses must not degrade the others.
 */
const endpointLimits = new Map<string, EndpointLimits>();

/** The most endpoints kept; the oldest are dropped so the map cannot grow without bound. */
const MAX_TRACKED_ENDPOINTS = 500;

/** A stable, non-reversible identity for the key in use (the key itself is never kept). */
function keyIdentity(apiKey: string): string {
	return apiKey ? createHash('sha256').update(apiKey).digest('hex').slice(0, 16) : 'none';
}

/** Ports and gateway paths can serve different APIs on the same hostname. */
function endpointKey(url: string, model: string, apiKey: string): string {
	return JSON.stringify([new URL(url).href, model, keyIdentity(apiKey)]);
}

/** Fields that always travel together: DeepSeek rejects the thinking toggle with the effort. */
function withCompanions(fields: Set<string>): Set<string> {
	if (fields.has('reasoning_effort')) fields.add('thinking');
	if (fields.has('thinking')) fields.add('reasoning_effort');
	return fields;
}

function toOpenAIMessages(system: string, messages: ChatMessage[], mapId: (id: string) => string = (id) => id, reasoningField: 'reasoning_content' | 'reasoning' | '' = 'reasoning_content'): unknown[] {
	const out: unknown[] = [{ role: 'system', content: system }];
	// Reasoning travels back on every turn that produced it, not only on the
	// current one: DeepSeek asks for reasoning_content in all later requests, and
	// a turn whose bytes differ between two requests ends the provider's cached
	// prefix exactly there. The replayed text is the same text the model streamed.
	// Tool messages can't carry images in this format: screenshots from a
	// batch of tool results follow as one user message after the batch.
	let pendingImages: MessageImage[] = [];
	const flushImages = () => {
		if (pendingImages.length) {
			out.push({
				role: 'user',
				content: [
					{ type: 'text', text: '[Screenshots returned by the tool calls above]' },
					...pendingImages.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }))
				]
			});
			pendingImages = [];
		}
	};
	for (const m of messages) {
		if (m.role !== 'tool') {
			flushImages();
		}
		if (m.role === 'tool') {
			out.push({ role: 'tool', tool_call_id: mapId(m.toolCallId), content: m.content || '(empty)' });
			pendingImages.push(...(m.images ?? []));
		} else if (m.role === 'assistant') {
			const reasoning = reasoningField && m.reasoning?.trim() ? { [reasoningField]: m.reasoning } : {};
			if (m.toolCalls?.length) {
				out.push({
					role: 'assistant',
					content: m.content || null,
					...reasoning,
					tool_calls: m.toolCalls.map((c) => ({
						id: mapId(c.id),
						type: 'function',
						function: { name: c.name, arguments: c.arguments || '{}' }
					}))
				});
			} else if (m.content || Object.keys(reasoning).length) {
				out.push({ role: 'assistant', content: m.content, ...reasoning });
			}
		} else if (m.images?.length) {
			out.push({
				role: 'user',
				content: [
					{ type: 'text', text: m.content },
					...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } }))
				]
			});
		} else {
			out.push({ role: 'user', content: m.content });
		}
	}
	flushImages();
	return out;
}

/**
 * Prompt caching. OpenAI, DeepSeek, GLM, Kimi, Qwen and most OpenAI-style
 * APIs cache the longest repeated prefix automatically. Claude (and Gemini
 * via OpenRouter) only cache up to explicit `cache_control` breakpoints, so
 * we mark the system prompt and the two most recent messages; each request
 * then reads everything the previous one wrote.
 */
function needsExplicitCache(baseUrl: string, model: string): boolean {
	// OpenRouter routes Claude / Gemini / Qwen with explicit breakpoints; Alibaba DashScope
	// (Qwen) only caches marked prefixes. Everyone else caches prefixes automatically.
	return (/openrouter\.ai/i.test(baseUrl) && /^(anthropic|google|qwen)\//i.test(model)) || /dashscope(-intl)?\.aliyuncs\.com/i.test(baseUrl);
}

/**
 * Provider-routing preferences for one request (pure; tested). Today only
 * OpenRouter has one zer0ne can set: data_collection "deny" routes to
 * zero-retention providers only. The preference is never silently dropped —
 * a rejected request fails instead of routing to a data-collecting provider
 * (it is deliberately absent from OPTIONAL_PARAMS).
 */
export function providerPrefs(baseUrl: string, zeroRetention?: boolean): Record<string, unknown> | undefined {
	return zeroRetention === true && /openrouter\.ai/i.test(baseUrl) ? { data_collection: 'deny' } : undefined;
}

/** Hosts that accept `prompt_cache_key` (keeps a conversation on the same cache shard). */
function acceptsCacheKey(baseUrl: string): boolean {
	return /(^|\.|\/\/)(api\.openai\.com|api\.x\.ai|api\.mistral\.ai|api\.deepinfra\.com|api\.cerebras\.ai)(\/|$)/i.test(baseUrl) || /\.openai\.azure\.com/i.test(baseUrl);
}

/**
 * OpenCode Go only routes requests that identify their client: a distinct
 * user agent plus a stable x-opencode-session per conversation, else it
 * answers 400 "Request is missing x-opencode-session"
 * (https://opencode.ai/docs/go). Calls without a conversation behind them
 * (model tests, model lists) send a fresh id — each is its own session.
 */
export function opencodeSessionHeaders(baseUrl: string, cacheKey: string | undefined): Record<string, string> {
	if (!/(^|\.)opencode\.ai$/i.test(hostOf(baseUrl))) {
		return {};
	}
	return { 'User-Agent': 'zer0ne-coding', 'x-opencode-session': cacheKey ?? randomUUID() };
}

function markOpenAICache(messages: unknown[]): void {
	const mark = (m: any) => {
		if (!m || m.role === 'tool' || m.content == null) {
			return;
		}
		if (typeof m.content === 'string') {
			if (!m.content) {
				return;
			}
			m.content = [{ type: 'text', text: m.content }];
		}
		const last = [...m.content].reverse().find((p: any) => p.type === 'text');
		if (last) {
			last.cache_control = { type: 'ephemeral' };
		}
	};
	mark(messages[0]);
	const users = messages.filter((m: any) => m.role === 'user');
	users.slice(-2).forEach(mark);
}

async function streamOpenAI(options: StreamOptions): Promise<StreamResult> {
	const url = openaiUrl(options.baseUrl, 'chat/completions');
	const host = hostOf(options.baseUrl);
	const serverKey = endpointKey(url, options.model, options.apiKey);
	const known = endpointLimits.get(serverKey);
	// The live set of fields this endpoint refuses: `remember` adds to it, so the rest of
	// this request (and the diagnostic below) always sees the current state.
	const refused = known?.refused ?? new Set<string>();
	// OpenRouter names the field "reasoning"; direct APIs use "reasoning_content". Servers that refused it once get none.
	const reasoningField = known?.noReasoningContent ? '' : /openrouter\.ai/i.test(options.baseUrl) ? 'reasoning' : 'reasoning_content';
	const messages = toOpenAIMessages(options.system, options.messages, strictToolIds(options.baseUrl) ? shortToolId : undefined, reasoningField);
	if (needsExplicitCache(options.baseUrl, options.model)) {
		markOpenAICache(messages);
	}
	const body: Record<string, unknown> = {
		model: options.model,
		messages,
		stream: true,
		// Usage reporting rides on this field: it is only dropped when the server refuses it.
		...(refused.has('stream_options') ? {} : { stream_options: { include_usage: true } })
	};
	if (options.maxTokens !== undefined) {
		// The output allowance is never an optional compatibility field: retries must retain it.
		const field = /(^|\.|\/\/)(api\.openai\.com)(\/|$)|\.openai\.azure\.com/i.test(options.baseUrl) ? 'max_completion_tokens' : 'max_tokens';
		body[field] = options.maxTokens;
	}
	if (options.responseFormat) {
		body.response_format = options.responseFormat.type === 'json'
			? { type: 'json_object' }
			: { type: 'json_schema', json_schema: { name: options.responseFormat.name || 'response', schema: options.responseFormat.schema, strict: true } };
	}
	if (options.tools?.length) {
		body.tools = options.tools.map((t) => ({
			type: 'function',
			function: functionTool(t, options.strictTools)
		}));
	}
	Object.assign(body, reasoningHints(options));
	// Fields this endpoint already refused never go out again.
	const omitted = [...refused].filter(field => field !== 'reasoning_content' && field in body);
	if (omitted.length) options.onCapabilityDowngrade?.(omitted);
	for (const field of refused) if (field !== 'reasoning_content') delete body[field];
	if (options.cacheKey && acceptsCacheKey(options.baseUrl) && !refused.has('prompt_cache_key')) {
		body.prompt_cache_key = options.cacheKey;
	}
	const prefs = providerPrefs(options.baseUrl, options.zeroRetention);
	if (prefs) body.provider = prefs;
	const headers: Record<string, string> = {
		...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
		...opencodeSessionHeaders(options.baseUrl, options.cacheKey)
	};
	/** Drop the refused fields from the outgoing request; returns what was actually removed. */
	const strip = (fields: Set<string>, echo: boolean): Set<string> => {
		const removed = new Set<string>();
		for (const field of fields) {
			if (field === 'reasoning_content' || !(field in body)) continue;
			delete body[field];
			removed.add(field);
		}
		if (echo) {
			for (const m of messages as Array<Record<string, unknown>>) {
				if (m.role !== 'assistant') continue;
				if (!('reasoning_content' in m) && !('reasoning' in m)) continue;
				delete m.reasoning_content;
				delete m.reasoning;
				removed.add('reasoning_content');
			}
		}
		return removed;
	};
	/** Remember what this endpoint refuses, so later requests go out without it. */
	const remember = (removed: Set<string>, echo: boolean) => {
		if (removed.size) options.onCapabilityDowngrade?.([...removed]);
		const state = endpointLimits.get(serverKey) ?? { host, model: options.model, keyId: keyIdentity(options.apiKey), refused, noReasoningContent: false, since: Date.now() };
		for (const field of removed) if (field !== 'reasoning_content') state.refused.add(field);
		if (echo) state.noReasoningContent = true;
		endpointLimits.set(serverKey, state);
		if (endpointLimits.size > MAX_TRACKED_ENDPOINTS) {
			const oldest = endpointLimits.keys().next().value!;
			endpointLimits.delete(oldest);
		}
	};
	/**
	 * Which fields the server refused.
	 *
	 *  - It names them: only those go, so usage reporting and prompt caching stay alive for
	 *    the fields the server does accept.
	 *  - It refuses unknown fields as a class ("Extra inputs are not permitted"): every
	 *    optional field has to go, including the usage reporter — that endpoint then reports
	 *    no token counts, which is surfaced as a diagnostic instead of a silent zero.
	 *  - It names a field this request does not carry: the complaint is about something else,
	 *    so the compatibility fields go and the usage reporter stays.
	 */
	const refusal = (msg: string): { drop: Set<string>; echo: boolean } => {
		const named = withCompanions(namedOptionalFields(msg));
		const drop = STRICT_SCHEMA.test(msg) ? new Set(ALL_OPTIONAL_PARAMS) : named.size ? named : new Set(DEFAULT_STRIP);
		// The reasoning family travels together: a server that refuses the effort knob
		// refuses the echoed reasoning as well.
		const echo = drop.has('reasoning_effort') || drop.has('thinking') || drop.has('reasoning_content');
		return { drop, echo };
	};
	let response: Response;
	try {
		response = await post(url, headers, body, options.signal, options.model, options.requestTrace);
	} catch (error) {
		// A strict server refused an optional field: retry once without the fields it named,
		// and remember them for this host+model+key only.
		const msg = error instanceof Error ? error.message : String(error);
		if (!/Provider error (400|422)/.test(msg) || !REJECTS_OPTIONAL.test(msg)) {
			throw error;
		}
		const { drop, echo } = refusal(msg);
		remember(strip(drop, echo), echo);
		response = await post(url, headers, body, options.signal, options.model, options.requestTrace);
	}

	let text = '';
	let reasoning = '';
	const guard = new ResponseTextGuard();
	let usage: StreamResult['usage'];
	let stopReason: string | undefined;
	const fragments = new Map<number, ToolCall>();
	const stamp = Date.now().toString(36);
	const emitted = new Set<number>();
	const emitCall = (i: number) => {
		const f = fragments.get(i);
		if (!options.onToolCall || !f || !f.name || emitted.has(i)) return;
		try {
			JSON.parse(f.arguments || '{}');
		} catch {
			return; // not complete yet
		}
		emitted.add(i);
		options.onToolCall({ id: f.id, name: f.name, arguments: f.arguments || '{}' });
	};
	const emitReasoning = (t: string) => {
		reasoning += t;
		guard.add(t);
		options.onReasoning?.(t);
	};
	const splitter = new ThinkSplitter((t) => {
		text += t;
		guard.add(t);
		options.onText?.(t);
	}, emitReasoning);

	const handle = (json: any) => {
		if (json.error) {
			throw new Error(`Provider error: ${json.error.message ?? JSON.stringify(json.error).slice(0, 300)}`);
		}
		const choice = json.choices?.[0];
		// Non-streamed fallback bodies carry `message` instead of `delta`.
		const delta = choice?.delta ?? choice?.message;
		if (delta) {
			const r = delta.reasoning_content ?? delta.reasoning;
			if (typeof r === 'string' && r) {
				emitReasoning(r);
			}
			if (typeof delta.content === 'string' && delta.content) {
				splitter.push(delta.content);
			}
			if (Array.isArray(delta.tool_calls)) {
				for (const [position, tc] of delta.tool_calls.entries()) {
					const index = typeof tc.index === 'number' ? tc.index : position;
					// A new call index means the previous ones are complete: hand them out early.
					for (const [i] of fragments) if (i < index) emitCall(i);
					const existing = fragments.get(index) ?? { id: '', name: '', arguments: '' };
					fragments.set(index, {
						// Stable id from the first sighting (early callers and the final result must agree).
						id: existing.id || tc.id || `call_${stamp}_${index}`,
						name: existing.name || tc.function?.name || '',
						arguments: existing.arguments + (tc.function?.arguments ?? '')
					});
				}
			}
		}
		if (choice?.finish_reason) {
			stopReason = choice.finish_reason;
		}
		if (json.usage) {
			usage = openaiUsage(json.usage, usage);
			options.requestTrace?.usage(usage);
		}
	};

	await readSse(response, (payload) => {
		options.requestTrace?.event();
		const json = parseJson(payload);
		if (json) {
			handle(json);
		}
	});
	splitter.flush();

	const toolCalls = [...fragments.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([i, c]) => ({ ...c, id: c.id || `call_${stamp}_${i}` }))
		.filter((c) => c.name);
	// The provider refused the usage-reporting field: it sends no usage chunk, so the token
	// counts are unknown. Say so instead of reporting zero tokens as if they were measured.
	if (!usage && refused.has('stream_options')) {
		usage = {
			input: 0,
			output: 0,
			inputReported: false,
			outputReported: false,
			issues: [`${host} does not report token usage for ${options.model} (it refused the usage-reporting field); token counts and cost are unknown for this endpoint.`]
		};
		options.requestTrace?.usage(usage);
	}
	return { text, reasoning, toolCalls, usage, stopReason };
}

/**
 * Endpoints whose usage accounting is degraded: the provider refused the usage-reporting
 * field, so no token counts arrive for it. The Usage page shows these as unknown.
 */
export function degradedAccounting(): Array<{ host: string; model: string; keyId: string; since: number }> {
	return [...endpointLimits.values()]
		.filter((s) => s.refused.has('stream_options'))
		.map((s) => ({ host: s.host, model: s.model, keyId: s.keyId, since: s.since }));
}

// ---------------------------------------------------------------- Anthropic

type AnthropicBlock = Record<string, unknown>;

export function toAnthropicMessages(messages: ChatMessage[], options?: StreamOptions): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
	const out: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
	const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
		if (!blocks.length) {
			return;
		}
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...blocks); // the API requires alternating roles
		} else {
			out.push({ role, content: blocks });
		}
	};
	for (const m of messages) {
		if (m.role === 'tool') {
			const content: AnthropicBlock[] = [{ type: 'text', text: m.content || '(empty)' }];
			for (const img of m.images ?? []) {
				content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
			}
			push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content }]);
		} else if (m.role === 'assistant') {
			const native = nativeItems(m, options, 'anthropic');
			if (native) { push('assistant', native); continue; }
			const blocks: AnthropicBlock[] = [];
			const retained = !m.native && m.toolCalls?.find(call => call.signature?.startsWith('{"type":"anthropic_thinking"'))?.signature;
			if (retained) {
				try { const saved = JSON.parse(retained); if (Array.isArray(saved.blocks)) blocks.push(...saved.blocks); }
				catch { /* A damaged provider state cannot be reconstructed from visible reasoning text. */ }
			}
			if (m.content.trim()) {
				blocks.push({ type: 'text', text: m.content });
			}
			for (const call of m.toolCalls ?? []) {
				let input: unknown = {};
				try {
					input = JSON.parse(call.arguments || '{}');
				} catch {
					input = {};
				}
				blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
			}
			push('assistant', blocks);
		} else {
			const blocks: AnthropicBlock[] = [];
			for (const img of m.images ?? []) {
				blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
			}
			if (m.content.trim()) {
				blocks.push({ type: 'text', text: m.content });
			}
			push('user', blocks);
		}
	}
	// The conversation must open with a user turn.
	while (out.length && out[0].role !== 'user') {
		out.shift();
	}
	return out;
}

/**
 * Messages-API body shared by Anthropic, Bedrock and Vertex (callers add model / version / stream).
 *
 * Cache breakpoint plan (OpenCode's planner, within Anthropic's budget of
 * four): the last tool definition, the system prompt, and the last two
 * messages. The prefix order is tools → system → messages, so tools stay
 * cached even when the system prompt changes (a new summary, a new day).
 * `plan.toolBreakpoint` is for the Anthropic API itself; Bedrock and Vertex
 * keep the three shared breakpoints.
 */
export function anthropicRequestBody(options: StreamOptions, plan: { toolBreakpoint?: boolean; ttl?: '1h' } = {}): Record<string, unknown> {
	const messages = toAnthropicMessages(options.messages, options);
	const cc = plan.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
	for (const m of messages.slice(-2)) {
		const last = m.content[m.content.length - 1];
		if (last) {
			last.cache_control = cc;
		}
	}
	const body: Record<string, unknown> = {
		system: options.system ? [{ type: 'text', text: options.system, cache_control: cc }] : undefined,
		max_tokens: options.maxTokens ?? 8192,
		messages
	};
	Object.assign(body, reasoningHints(options));
	if (options.tools?.length) {
		const tools: Array<Record<string, unknown>> = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
		if (plan.toolBreakpoint) tools[tools.length - 1].cache_control = cc;
		body.tools = tools;
	}
	return body;
}

async function streamAnthropic(options: StreamOptions): Promise<StreamResult> {
	const url = anthropicUrl(options.baseUrl, 'messages');
	// The 1-hour cache lifetime is an Anthropic API feature; compatible gateways get the default.
	const official = /(^|\.)anthropic\.com$/i.test(hostOf(options.baseUrl));
	const ttl = options.cacheTtl === '1h' && official ? '1h' : undefined;
	const body = { model: options.model, ...anthropicRequestBody(options, { toolBreakpoint: true, ttl }), stream: true };
	// Anthropic-compatible gateways differ on auth; send both header styles.
	const headers: Record<string, string> = {
		'x-api-key': options.apiKey,
		Authorization: `Bearer ${options.apiKey}`,
		'anthropic-version': ANTHROPIC_VERSION,
		...opencodeSessionHeaders(options.baseUrl, options.cacheKey)
	};
	if (ttl) headers['anthropic-beta'] = 'extended-cache-ttl-2025-04-11';
	const response = await post(url, headers, body, options.signal, options.model, options.requestTrace);
	const acc = anthropicAccumulator(options);
	await readSse(response, (payload) => {
		const json = parseJson(payload);
		if (json) {
			acc.handle(json);
		}
	});
	return acc.result();
}

/** Folds Messages-API stream events (SSE, Bedrock event-stream, Vertex) into a StreamResult. */
export function anthropicAccumulator(options: Pick<StreamOptions, 'onText' | 'onReasoning' | 'onToolCall' | 'requestTrace'> & Partial<StreamOptions>): { handle(json: any): void; result(): StreamResult } {
	let text = '';
	let reasoning = '';
	const guard = new ResponseTextGuard();
	let stopReason: string | undefined;
	let usage: StreamResult['usage'];
	const blocks = new Map<number, { type: string; id?: string; name?: string; json: string; text?: string; thinking?: string; signature?: string; data?: string }>();

	const handle = (json: any) => {
		options.requestTrace?.event();
		switch (json.type) {
			case 'error':
				throw new Error(`Provider error: ${json.error?.message ?? 'unknown error'}`);
			case 'message_start': {
				const u = json.message?.usage;
				if (u) {
					usage = anthropicUsage(u, usage);
					options.requestTrace?.usage(usage);
				}
				break;
			}
			case 'content_block_start': {
				const b = json.content_block ?? {};
				blocks.set(json.index ?? 0, { type: b.type, id: b.id, name: b.name, json: b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : '', text: b.text, thinking: b.thinking, signature: b.signature, data: b.data });
				if (b.type === 'thinking' && b.thinking) { reasoning += b.thinking; guard.add(b.thinking); options.onReasoning?.(b.thinking); }
				if (b.type === 'text' && b.text) {
					text += b.text;
					guard.add(b.text);
					options.onText?.(b.text);
				}
				break;
			}
			case 'content_block_stop': {
				const b = blocks.get(json.index ?? 0);
				if (b && b.type === 'tool_use' && b.name && options.onToolCall) {
					try {
						JSON.parse(b.json || '{}');
						options.onToolCall({ id: b.id || 'toolu_' + (json.index ?? 0), name: b.name, arguments: b.json || '{}' });
					} catch {
						/* incomplete — the final result carries it */
					}
				}
				break;
			}
			case 'content_block_delta': {
				const d = json.delta ?? {};
				if (d.type === 'text_delta' && d.text) {
					const block = blocks.get(json.index ?? 0); if (block) block.text = (block.text ?? '') + d.text;
					text += d.text;
					guard.add(d.text);
					options.onText?.(d.text);
				} else if (d.type === 'thinking_delta' && d.thinking) {
					const block = blocks.get(json.index ?? 0); if (block) block.thinking = (block.thinking ?? '') + d.thinking;
					reasoning += d.thinking;
					guard.add(d.thinking);
					options.onReasoning?.(d.thinking);
				} else if (d.type === 'signature_delta' && typeof d.signature === 'string') {

					const block = blocks.get(json.index ?? 0); if (block) block.signature = (block.signature ?? '') + d.signature;
				} else if (d.type === 'input_json_delta') {
					const block = blocks.get(json.index ?? 0);
					if (block) {
						block.json += d.partial_json ?? '';
					}
				}
				break;
			}
			case 'message_delta':
				if (json.delta?.stop_reason) {
					stopReason = json.delta.stop_reason;
				}
				if (json.usage) {
					// The final usage is cumulative; many gateways only report input and cache reads here
					// (message_start then says 0) — ignoring them showed real cache hits as 0%.
					usage = anthropicUsage(json.usage, usage);
					options.requestTrace?.usage(usage);
				}
				break;
			case 'message': {
				// Non-streamed fallback body.
				if (json.usage) {
					usage = anthropicUsage(json.usage, usage);
					options.requestTrace?.usage(usage);
				}
				for (const b of json.content ?? []) {
					if (b.type === 'text') {
						blocks.set(blocks.size, { type: 'text', json: '', text: b.text });
						text += b.text;
						guard.add(b.text);
						options.onText?.(b.text);
					} else if (b.type === 'tool_use') {
						blocks.set(blocks.size, { type: 'tool_use', id: b.id, name: b.name, json: JSON.stringify(b.input ?? {}) });
					} else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
						blocks.set(blocks.size, { type: b.type, json: '', thinking: b.thinking, signature: b.signature, data: b.data });
						if (b.thinking) { reasoning += b.thinking; guard.add(b.thinking); options.onReasoning?.(b.thinking); }
					}
				}
				stopReason = json.stop_reason;
				break;
			}
		}
	};

	const result = (): StreamResult => {
		const toolCalls: ToolCall[] = [...blocks.entries()]
			.sort((a, b) => a[0] - b[0])
			.filter(([, b]) => b.type === 'tool_use' && b.name)
			.map(([i, b]) => ({ id: b.id || `toolu_${i}`, name: b.name as string, arguments: b.json || '{}' }));
		const thinking = [...blocks.entries()].sort((a, b) => a[0] - b[0]).flatMap<AnthropicBlock>(([, b]) => b.type === 'thinking' && b.signature ? [{ type: 'thinking', thinking: b.thinking ?? '', signature: b.signature }] : b.type === 'redacted_thinking' && b.data ? [{ type: 'redacted_thinking', data: b.data }] : []);
		if (thinking.length && toolCalls.length) toolCalls[0].signature = JSON.stringify({ type: 'anthropic_thinking', blocks: thinking });
		const items = [...blocks.entries()].sort(([a], [b]) => a - b).flatMap<AnthropicBlock>(([i, b]) => {
			if (b.type === 'thinking' && b.signature) return [{ type: b.type, thinking: b.thinking ?? '', signature: b.signature }];
			if (b.type === 'redacted_thinking' && b.data) return [{ type: b.type, data: b.data }];
			if (b.type === 'text' && b.text) return [{ type: 'text', text: b.text }];
			if (b.type === 'tool_use') { try { return [{ type: b.type, id: b.id || `toolu_${i}`, name: b.name, input: JSON.parse(b.json || '{}') }]; } catch { return []; } }
			return [];
		});
		return { text, reasoning, toolCalls, usage, stopReason, native: options.baseUrl && options.model ? continuation(options as StreamOptions, 'anthropic', items, text, usage?.output) : undefined };
	};
	return { handle, result };
}

// ---------------------------------------------------------------- models

export interface FetchedModel {
	id: string;
	contextWindow?: number;
	reasoningControl?: ReasoningControl;
}

/** GET the endpoint's model list. */
export async function fetchModels(baseUrl: string, apiKey: string, apiFormat: ApiFormat): Promise<FetchedModel[]> {
	if (apiFormat === 'gemini' || apiFormat === 'bedrock' || apiFormat === 'vertex') {
		return fetchNativeModels(baseUrl, apiKey, apiFormat);
	}
	const isAnthropic = apiFormat === 'anthropic';
	const url = isAnthropic ? anthropicUrl(baseUrl, 'models') + '?limit=1000' : openaiUrl(baseUrl, 'models');
	const headers: Record<string, string> = {
		...(isAnthropic
			? { 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_VERSION }
			: apiKey
				? { Authorization: `Bearer ${apiKey}` }
				: {}),
		...opencodeSessionHeaders(baseUrl, undefined)
	};

	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
	} catch {
		throw new Error(`Could not reach ${url} — check the Base URL.`);
	}
	if (!response.ok) {
		throw new Error(`Could not list models (HTTP ${response.status}). Check the Base URL and API key.`);
	}
	const json: unknown = await response.json().catch(() => undefined);
	const container = (json ?? {}) as { data?: unknown[]; models?: unknown[] };
	const items = Array.isArray(json) ? json : container.data ?? container.models ?? [];
	const seen = new Set<string>();
	const out: FetchedModel[] = [];
	for (const item of items as Array<Record<string, unknown>>) {
		const id = typeof item?.id === 'string' ? item.id : typeof item?.name === 'string' ? item.name : '';
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const ctx = item.context_length ?? item.context_window ?? item.max_context_length;
		const reasoningControl = advertisedReasoning(item, apiFormat, baseUrl);
		out.push({ id, contextWindow: typeof ctx === 'number' && ctx > 0 ? ctx : undefined, ...(reasoningControl ? { reasoningControl } : {}) });
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Send a tiny request to check that a model answers. */
export async function testModel(opts: {
	baseUrl: string;
	apiKey: string;
	apiFormat: ApiFormat;
	model: string;
	chatgptPlan?: boolean;
}): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45_000);
	let answered = false;
	try {
		const result = await streamChat({
			...opts,
			system: 'Reply with the single word OK.',
			messages: [{ role: 'user', content: 'ping' }],
			maxTokens: 16,
			signal: controller.signal,
			// Plan access is confirmed only by response.completed; other APIs can stop after the first token.
			onText: () => {
				answered = true;
				if (!opts.chatgptPlan) controller.abort();
			},
			onReasoning: () => {
				answered = true;
				if (!opts.chatgptPlan) controller.abort();
			}
		});
		// A 200 with an empty body (or a stream that ends without tokens) is not a working model.
		if (!answered && !result.text.trim() && !result.reasoning.trim() && !result.toolCalls.length) {
			return { ok: false, error: 'The model finished without sending any text (empty response). Check the model ID and the provider.' };
		}
		return { ok: true, ms: Date.now() - started };
	} catch (error) {
		if (controller.signal.aborted) {
			return answered && !opts.chatgptPlan ? { ok: true, ms: Date.now() - started } : { ok: false, error: 'Timed out after 45 s.' };
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}
