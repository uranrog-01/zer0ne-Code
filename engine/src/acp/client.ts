import { ChildProcess, spawn } from 'child_process';
import { loginTerminalSpec } from '../host/loginTerminal';
import { AgentOutputLines, googleVerificationUrl, verifyUrlIn } from './verification';
import { thoughtControl, variantControls } from './reasoning';
import type { ReasoningControl } from '../reasoning';
export { verifyUrlIn } from './verification';

/**
 * Agent Client Protocol client: JSON-RPC 2.0 over an agent's stdin/stdout,
 * one JSON object per line. Enough of the protocol to sign in, open a
 * session, run prompts with streamed updates, answer permission requests and
 * serve file reads/writes — what an editor does for Zed's or JetBrains' agents.
 * https://agentclientprotocol.com. Nothing here depends on VS Code.
 */

export interface AcpSpawn {
	command: string;
	args: string[];
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	/** Windows .cmd shims only; every argument is validated before it gets here. */
	shell?: boolean;
}

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string;
	/** 'agent' (default): the agent runs the sign-in and opens the browser. 'terminal': run `args` interactively. */
	type?: 'agent' | 'terminal' | 'env_var' | string;
	args?: string[];
	env?: Record<string, string>;
}

/** Older agents put the terminal descriptor under _meta; preserve its launch values without coercing malformed data. */
export function authMethodsFrom(raw: unknown): AcpAuthMethod[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((m: any): AcpAuthMethod[] => {
		if (!m || typeof m.id !== 'string' || !m.id || m.id.length > 200) return [];
		const legacy = m._meta?.['terminal-auth'];
		const type = typeof m.type === 'string' ? m.type : legacy ? 'terminal' : 'agent';
		const descriptor = legacy && typeof legacy === 'object' ? legacy : m;
		const args = m.args ?? descriptor.args;
		const env = m.env ?? descriptor.env;
		if (args !== undefined && (!Array.isArray(args) || args.length > 32 || !args.every(a => typeof a === 'string' && a.length <= 4096 && !a.includes('\0')))) return [];
		if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) || typeof v !== 'string' || v.length > 4096 || v.includes('\0')))) return [];
		return [{ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, description: typeof m.description === 'string' ? m.description : undefined, type, args, env }];
	});
}

export interface AcpConfigOption {
	id: string;
	name?: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: Array<{ value: string; name?: string; description?: string } | { name?: string; options: Array<{ value: string; name?: string; description?: string }> }>;
}

export interface AcpSessionInfo {
	sessionId: string;
	configOptions?: AcpConfigOption[];
	models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string; description?: string }> };
	modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
}

export interface AcpPermissionOption {
	optionId: string;
	name: string;
	kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
}

export interface AcpToolCall {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: 'pending' | 'in_progress' | 'completed' | 'failed' | string;
	content?: Array<{ type: string; content?: { type: string; text?: string }; path?: string; oldText?: string | null; newText?: string; terminalId?: string }>;
	locations?: Array<{ path: string; line?: number }>;
	rawInput?: unknown;
	rawOutput?: unknown;
}

export interface AcpClientHandlers {
	requestPermission(params: { sessionId: string; toolCall: AcpToolCall; options: AcpPermissionOption[] }): Promise<{ outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }>;
	readTextFile?(params: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
	writeTextFile?(params: { sessionId: string; path: string; content: string }): Promise<Record<string, never> | null>;
	sessionUpdate(sessionId: string, update: { sessionUpdate: string; [k: string]: any }): void;
	/** A line the agent printed outside the protocol (some print their sign-in link this way). */
	log?(line: string, stream: 'stdout' | 'stderr'): void;
	exit?(code: number | null): void;
}

export class AcpError extends Error {
	constructor(message: string, readonly code: number, readonly data?: any) {
		super(message);
	}
	/** ACP "authentication required" (-32000) or a message that says so. */
	get authRequired(): boolean {
		if (this.verificationRequired || this.subscriptionUnsupported) return false;
		return this.code === -32000 || /auth(entication)?[ _-]?required|not (logged|signed) in|please (log|sign) ?in|\/login|invalid api key/i.test(this.message);
	}
	get verificationRequired(): boolean {
		return /VALIDATION_REQUIRED|verify your account|account.{0,30}verification|verification.{0,30}required/i.test(this.message + ' ' + JSON.stringify(this.data ?? ''));
	}
	get subscriptionUnsupported(): boolean {
		return this.data?.reason === 'claude_subscription_not_supported' || /does not support using .{0,30}subscriptions|subscription.{0,30}not supported/i.test(this.message);
	}
}

/** The markdown error for an account the vendor wants verified, with its page when known. */
export function verificationMessage(name: string, url?: string, detail = ''): string {
	url = googleVerificationUrl(url);
	return (
		`**${name} needs your account verified.** Google requires account verification before this request can continue.` +
		(url ? `\n\n[Verify your account](${url}) — sign in there, finish Google's check, then press Retry.` : ` Open Antigravity, sign in and finish Google's check, then press Retry.`) +
		`\n\nIf Google's page returns HTTP 500, open [Google account security](https://myaccount.google.com/security) and sign in again in Antigravity for a fresh link. For account eligibility and supported integrations, see [Antigravity sign-in help](https://antigravity.google/docs/faq).` +
		(detail ? `\n\n${detail}` : '')
	);
}

/** Keep provider account restrictions distinct from an expired login or a transport failure. */
export function agentErrorMessage(error: unknown, name = 'agent', verifyUrl?: string): string {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof AcpError && error.subscriptionUnsupported) return `${name} does not permit this integration to use your subscription. Use the provider's supported client or connect a dedicated API key; signing in again will not change this restriction.\n\n${message}`;
	if (/needs your account verified/.test(message)) return message; // already explained (stream.ts)
	if ((error instanceof AcpError && error.verificationRequired) || /verify your account/i.test(message)) {
		const url = verifyUrl ?? verifyUrlIn(message + ' ' + JSON.stringify((error as AcpError)?.data ?? ''));
		return verificationMessage(name, url, url ? '' : message);
	}
	if (error instanceof AcpError && error.authRequired) return `${name} requires authentication. Its saved model list does not confirm an active login. Open Settings → Providers & models → Plans & subscriptions and sign in again.\n\n${message}`;
	return message;
}

const AUTH_LINE = /(authenticat|sign.?in|log.?in|authoriz|open the following|visit)/i;
/** An https link on a line that is about signing in (pure; tested). */
export function authUrlIn(line: string): string | undefined {
	if (!AUTH_LINE.test(line)) return undefined;
	const m = /https:\/\/[^\s"'<>)]+/.exec(line);
	return m ? m[0].replace(/[.,;]+$/, '') : undefined;
}

export class AcpConnection {
	private proc?: ChildProcess;
	private buf = '';
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
	private exited = false;
	agentName = '';
	agentVersion = '';
	capabilities: Record<string, any> = {};
	authMethods: AcpAuthMethod[] = [];
	/** Last stderr lines, for error messages. */
	stderrTail = '';
	private readonly diagnostics = new AgentOutputLines();
	/** The vendor's "verify your account" page, when it asked for one (Antigravity's 403 VALIDATION_REQUIRED). */
	verifyUrl?: string;

	constructor(private readonly spec: AcpSpawn, private readonly h: AcpClientHandlers) {}

	get alive(): boolean {
		return !!this.proc && !this.exited;
	}

	start(): void {
		const cmd = this.spec.shell && process.platform === 'win32' ? loginTerminalSpec(this.spec.command, this.spec.args, 'win32') : { command: this.spec.command, args: this.spec.args, verbatim: false };
		const proc = spawn(cmd.command, cmd.args, { cwd: this.spec.cwd, env: this.spec.env ?? process.env, windowsHide: true, windowsVerbatimArguments: cmd.verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
		this.proc = proc;
		proc.stdin?.on('error', () => undefined);
		proc.stdout?.setEncoding('utf8');
		proc.stdout?.on('data', (d: string) => this.onData(d));
		proc.stderr?.setEncoding('utf8');
		proc.stderr?.on('data', (d: string) => {
			this.stderrTail = (this.stderrTail + d).slice(-3000);
			const lines = this.diagnostics.push(d);
			const verify = verifyUrlIn(this.diagnostics.tail);
			if (verify) this.verifyUrl = verify;
			for (const line of lines) if (line.trim()) this.h.log?.(line, 'stderr');
		});
		proc.stderr?.on('end', () => {
			const lines = this.diagnostics.push('', true);
			const verify = verifyUrlIn(this.diagnostics.tail);
			if (verify) this.verifyUrl = verify;
			for (const line of lines) if (line.trim()) this.h.log?.(line, 'stderr');
		});
		proc.on('error', (e) => this.fail(new Error(`Could not start the agent: ${e.message}`)));
		proc.on('exit', (code) => {
			this.fail(new Error(`The agent stopped${code ? ` (exit ${code})` : ''}${this.lastError() ? ': ' + this.lastError() : '.'}`));
			this.h.exit?.(code);
		});
	}

	private lastError(): string {
		const lines = this.stderrTail.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter((l) => /error|fail|denied|not found|cannot|unable|invalid/i.test(l));
		return (lines.pop() ?? '').slice(0, 240);
	}

	private fail(error: Error): void {
		this.exited = true;
		for (const p of this.pending.values()) p.reject(error);
		this.pending.clear();
	}

	private onData(chunk: string): void {
		this.buf += chunk;
		let nl: number;
		while ((nl = this.buf.indexOf('\n')) >= 0) {
			const line = this.buf.slice(0, nl).trim();
			this.buf = this.buf.slice(nl + 1);
			if (!line) continue;
			let msg: any;
			try {
				msg = JSON.parse(line);
			} catch {
				this.h.log?.(line, 'stdout');
				continue;
			}
			if (!msg || typeof msg !== 'object') continue;
			void this.dispatch(msg);
		}
	}

	private async dispatch(msg: any): Promise<void> {
		if (typeof msg.method === 'string') {
			if (msg.id === undefined || msg.id === null) {
				if (msg.method === 'session/update' && msg.params?.sessionId && msg.params.update) this.h.sessionUpdate(String(msg.params.sessionId), msg.params.update);
				return;
			}
			// A request from the agent: answer it.
			try {
				const result = await this.handleAgentRequest(msg.method, msg.params ?? {});
				this.send({ jsonrpc: '2.0', id: msg.id, result: result ?? null });
			} catch (e) {
				const err = e instanceof AcpError ? e : new AcpError(e instanceof Error ? e.message : String(e), -32603);
				this.send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code, message: err.message } });
			}
			return;
		}
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.error) p.reject(new AcpError(String(msg.error.message ?? 'Agent error'), Number(msg.error.code ?? -32603), msg.error.data));
		else p.resolve(msg.result);
	}

	private async handleAgentRequest(method: string, params: any): Promise<unknown> {
		switch (method) {
			case 'session/request_permission':
				return this.h.requestPermission({ sessionId: String(params.sessionId), toolCall: params.toolCall ?? { toolCallId: '' }, options: Array.isArray(params.options) ? params.options : [] });
			case 'fs/read_text_file':
				if (!this.h.readTextFile) throw new AcpError('File reading is not available.', -32601);
				return this.h.readTextFile({ sessionId: String(params.sessionId), path: String(params.path), line: params.line, limit: params.limit });
			case 'fs/write_text_file':
				if (!this.h.writeTextFile) throw new AcpError('File writing is not available.', -32601);
				return this.h.writeTextFile({ sessionId: String(params.sessionId), path: String(params.path), content: String(params.content ?? '') });
			default:
				throw new AcpError(`Method not found: ${method}`, -32601);
		}
	}

	private send(obj: unknown): void {
		if (!this.proc?.stdin || this.exited) return;
		try {
			this.proc.stdin.write(JSON.stringify(obj) + '\n');
		} catch {
			/* the process is going away; pending requests fail on exit */
		}
	}

	request<T = any>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
		if (this.exited || !this.proc) return Promise.reject(new Error('The agent is not running.'));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const settle = (f: (value: any) => void, value: any) => { signal?.removeEventListener('abort', onAbort); f(value); };
			this.pending.set(id, { resolve: value => settle(resolve, value), reject: error => settle(reject, error), method });
			const onAbort = () => {
				this.pending.delete(id);
				signal?.removeEventListener('abort', onAbort);
				reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
			};
			if (signal) {
				if (signal.aborted) return onAbort();
				signal.addEventListener('abort', onAbort, { once: true });
			}
			this.send({ jsonrpc: '2.0', id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params });
	}

	async initialize(caps: { fs: boolean; authTerminal?: boolean }, info = { name: 'zer0ne-coding', title: 'zer0ne coding', version: '1' }): Promise<void> {
		const r = await this.request<any>('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: caps.fs, writeTextFile: caps.fs }, terminal: false, ...(caps.authTerminal ? { auth: { terminal: true }, _meta: { 'terminal-auth': true } } : {}) }, clientInfo: info });
		this.agentName = String(r?.agentInfo?.title ?? r?.agentInfo?.name ?? '');
		this.agentVersion = String(r?.agentInfo?.version ?? '');
		this.capabilities = r?.agentCapabilities ?? {};
		this.authMethods = authMethodsFrom(r?.authMethods);
	}

	authenticate(methodId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request('authenticate', { methodId }, signal);
	}

	/** Agent-specific `_meta` for every new session (Claude: which settings files it may read). */
	sessionMeta?: Record<string, unknown>;

	async newSession(cwd: string, signal?: AbortSignal): Promise<AcpSessionInfo> {
		const r = await this.request<any>('session/new', { cwd, mcpServers: [], ...(this.sessionMeta ? { _meta: this.sessionMeta } : {}) }, signal);
		return { sessionId: String(r.sessionId), configOptions: r.configOptions, models: r.models, modes: r.modes };
	}

	prompt(sessionId: string, prompt: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<{ stopReason: string }> {
		return this.request('session/prompt', { sessionId, prompt }, signal);
	}

	cancel(sessionId: string): void {
		this.notify('session/cancel', { sessionId });
	}

	setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
		return this.request('session/set_config_option', { sessionId, configId, value });
	}

	setModel(sessionId: string, modelId: string): Promise<unknown> {
		return this.request('session/set_model', { sessionId, modelId });
	}

	setMode(sessionId: string, modeId: string): Promise<unknown> {
		return this.request('session/set_mode', { sessionId, modeId });
	}

	close(): void {
		const proc = this.proc;
		this.fail(new Error('The agent was closed.'));
		if (!proc || proc.exitCode !== null) return;
		try {
			if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
			else proc.kill();
		} catch {
			/* already gone */
		}
	}
}

/**
 * The session's model selector: the config option named "model" first — Cline
 * also files its billing "provider" switch under the model category, ahead of
 * the real model list (pure; tested).
 */
export function modelOption(s: Pick<AcpSessionInfo, 'configOptions'>): AcpConfigOption | undefined {
	const opts = (s.configOptions ?? []).filter((o) => o.options?.length);
	return opts.find((o) => o.id === 'model') ?? opts.find((o) => o.category === 'model' && /model/i.test(`${o.id} ${o.name ?? ''}`)) ?? opts.find((o) => o.category === 'model');
}

/** A plan inside an agent that serves more (see AcpPlanMeta.planScope). */
export interface AcpPlanScope {
	option?: { id: string; value: string };
	models?: string[];
	authMethod?: string;
}

/** Switch the session to the plan (Cline: billing = ClinePass); the agent answers with the new options (model list included). */
export async function applyPlanScope(conn: Pick<AcpConnection, 'setConfigOption'>, session: AcpSessionInfo, scope: AcpPlanScope | undefined): Promise<AcpSessionInfo> {
	const o = scope?.option;
	if (!o) return session;
	const opt = session.configOptions?.find((c) => c.id === o.id);
	if (!opt || opt.currentValue === o.value) return session;
	const r: any = await conn.setConfigOption(session.sessionId, o.id, o.value);
	return Array.isArray(r?.configOptions) ? { ...session, configOptions: r.configOptions } : session;
}

/** Only the plan's models: the first id prefix that has any (pure; tested). */
export function planModels<T extends { id: string }>(found: { current?: string; models: T[] }, scope: AcpPlanScope | undefined): { current?: string; models: T[] } {
	for (const prefix of scope?.models ?? []) {
		const models = found.models.filter((m) => m.id.startsWith(prefix));
		if (models.length) return { current: models.some((m) => m.id === found.current) ? found.current : models[0].id, models };
	}
	return scope?.models?.length ? { models: [] } : found;
}

export interface AcpModel {
	id: string;
	name: string;
	/** The agent's one-line note ("Best for everyday, complex tasks"); dropped when it only repeats the id. */
	description?: string;
	reasoningControl?: ReasoningControl;
}

/** The model choices in a session (config option "model", or the older models list) (pure; tested). */
export function sessionModels(s: Pick<AcpSessionInfo, 'configOptions' | 'models'>): { current?: string; models: AcpModel[] } {
	const model = (id: string, name?: string, description?: string): AcpModel => {
		const d = description?.trim();
		return { id, name: name?.trim() || id, ...(d && d !== id && !d.endsWith(`(${id})`) ? { description: d } : {}) };
	};
	const opt = modelOption(s);
	const seen = new Set<string>();
	const unique = (list: AcpModel[]) => {
		const unique = list.filter((m) => m.id && !seen.has(m.id) && seen.add(m.id));
		const thought = thoughtControl(s), variants = variantControls(unique);
		return unique.map(m => ({ ...m, ...(thought ?? variants.get(m.id) ? { reasoningControl: thought ?? variants.get(m.id) } : {}) }));
	};
	if (opt?.options?.length) {
		const models: AcpModel[] = [];
		for (const o of opt.options) {
			if ('value' in o) models.push(model(o.value, o.name, o.description));
			else for (const g of o.options) models.push(model(g.value, g.name, g.description));
		}
		return { current: opt.currentValue, models: unique(models) };
	}
	return { current: s.models?.currentModelId, models: unique((s.models?.availableModels ?? []).map((m) => model(m.modelId, m.name, m.description))) };
}
