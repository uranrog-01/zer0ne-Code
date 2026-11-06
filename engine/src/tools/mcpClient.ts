import { type ChildProcess } from 'child_process';
import { pathToFileURL } from 'url';
import type { McpServerConfig } from '../providerStore';
import type { McpAuthStore, McpStatus, McpToolInfo, McpToolAnnotations } from './mcp';
import { canonicalResource } from './mcpOAuth';
import { storedBearer } from './mcpRefresh';
import { MCP_MAX_BYTES, MCP_VERSIONS, object, readJsonBody, readSse, spawnMcp, validateMessage, waitFor } from './mcpProtocol';
import { killTree } from './proc';

export class AuthRequired extends Error {
	constructor(readonly wwwAuthenticate: string | null) { super('Sign in required — this server uses OAuth.'); }
}
class SessionExpired extends Error { constructor(readonly session: string) { super('MCP session expired.'); } }
/** How long a task-run MCP tool may take (and the time-to-live zer0ne asks the server for). */
const TASK_LIMIT_MS = 60 * 60_000;

function annotations(value: unknown): McpToolAnnotations | undefined {
	if (!object(value)) return undefined;
	const result: McpToolAnnotations = {};
	if (typeof value.title === 'string') result.title = value.title;
	for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) if (typeof value[key] === 'boolean') result[key] = value[key];
	return Object.keys(result).length ? result : undefined;
}

export class McpClient {
	state: McpStatus['state'] = 'stopped';
	error?: string;
	tools: McpToolInfo[] = [];
	wwwAuthenticate: string | null = null;
	hasToken = false;
	private proc?: ChildProcess;
	private seq = 0;
	private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private readonly lifetime = new AbortController();
	private stderr = '';
	private sessionId?: string;
	private protocol?: string;
	private capabilities: Record<string, any> = {};
	private lastToken?: string;
	private closing?: Promise<void>;
	private catalogTask?: Promise<void>;
	private refreshAgain = false;
	private recovery?: Promise<void>;
	private events?: AbortController;

	constructor(readonly config: McpServerConfig, private readonly cwd: string | undefined, private readonly onChange: () => void, private readonly auth?: McpAuthStore, private readonly predecessor: Promise<void> = Promise.resolve()) {}

	get signal(): AbortSignal { return this.lifetime.signal; }
	get signature(): string {
		const { enabled: _e, trusted: _t, disabledTools: _d, ...rest } = this.config;
		return JSON.stringify(rest);
	}

	async start(): Promise<void> {
		this.state = 'connecting'; this.error = undefined; this.onChange();
		try {
			await this.predecessor; this.signal.throwIfAborted();
			if (this.config.transport === 'stdio') this.spawnStdio();
			await this.initialize(); this.signal.throwIfAborted();
			this.state = 'ready'; this.onChange(); this.startEvents();
		} catch (e) {
			if (this.signal.aborted) return;
			this.state = e instanceof AuthRequired ? 'auth' : 'error';
			this.error = (e instanceof Error ? e.message : String(e)) + (this.stderr.trim() ? ` — ${this.stderr.trim().slice(-300)}` : '');
			await this.stop(false).catch(() => undefined); this.onChange();
		}
	}

	private async initialize(discover = true): Promise<void> {
		const result = await this.request('initialize', { protocolVersion: MCP_VERSIONS[0], capabilities: { roots: {}, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } }, clientInfo: { name: 'zer0ne-coding', version: '0.33.5' } }, 30_000);
		if (!object(result) || !MCP_VERSIONS.includes(result.protocolVersion) || !object(result.capabilities) || !object(result.serverInfo) || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') throw new Error('The MCP server returned an unsupported or invalid initialization result.');
		this.protocol = result.protocolVersion; this.capabilities = result.capabilities;
		await this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
		if (this.capabilities.tools && discover) await this.refreshTools(); else if (!this.capabilities.tools) this.tools = [];
		this.signal.throwIfAborted();
	}

	private spawnStdio(): void {
		const proc = spawnMcp(this.config.command.trim(), this.config.args, this.cwd, { ...process.env, ...this.config.env });
		this.proc = proc; let buffer = '';
		proc.stdout?.setEncoding('utf8');
		proc.stdout?.on('data', (chunk: string) => {
			if (this.signal.aborted) return;
			buffer += chunk;
			if (Buffer.byteLength(buffer) > MCP_MAX_BYTES) { this.transportError(new Error('MCP stdout message exceeds 16 MiB.')); return; }
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
				if (line) this.onMessage(line);
			}
		});
		proc.stderr?.setEncoding('utf8'); proc.stderr?.on('data', (chunk: string) => this.stderr = (this.stderr + chunk).slice(-4000));
		proc.stdin?.on('error', e => { if (!this.signal.aborted) this.transportError(e); });
		proc.on('error', e => { if (!this.signal.aborted) this.transportError(new Error(`Could not start MCP server: ${e.message}`)); });
		proc.on('exit', code => { if (!this.signal.aborted) this.transportError(new Error(`Server exited (code ${code}).`)); });
	}

	private transportError(error: Error): void {
		this.state = 'error'; this.error = error.message;
		void this.stop(false).catch(() => undefined); this.onChange();
	}
	private failAll(error: Error): void {
		for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
		this.pending.clear();
	}
	private onMessage(line: string): void {
		let msg: unknown;
		try { msg = JSON.parse(line); } catch { return; }
		try { void this.handleMessage(validateMessage(msg)).catch(e => { if (!this.signal.aborted) this.transportError(e); }); }
		catch (e) { this.transportError(e instanceof Error ? e : new Error(String(e))); }
	}
	private async handleMessage(msg: Record<string, any>): Promise<void> {
		this.signal.throwIfAborted();
		if (typeof msg.method === 'string') {
			if (msg.id !== undefined) {
				let result: unknown;
				if (msg.method === 'ping') result = {};
				else if (msg.method === 'roots/list') result = { roots: this.cwd ? [{ uri: pathToFileURL(this.cwd).href, name: 'workspace' }] : [] };
				const reply = result === undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not supported by client' } } : { jsonrpc: '2.0', id: msg.id, result };
				await this.send(reply);
			} else if (msg.method === 'notifications/tools/list_changed' && this.capabilities.tools) {
				void this.refreshTools().then(() => { if (!this.signal.aborted) this.onChange(); }).catch(e => {
					if (!this.signal.aborted) { this.error = `MCP tool refresh failed: ${e instanceof Error ? e.message : String(e)}`; this.onChange(); }
				});
			}
			return;
		}
		const p = this.pending.get(msg.id);
		if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); msg.error ? p.reject(new Error(msg.error.message ?? 'MCP error')) : p.resolve(msg.result); }
	}

	private async bearer(force: boolean, signal: AbortSignal): Promise<string | undefined> {
		if (!this.auth || Object.keys(this.config.headers).some(k => k.toLowerCase() === 'authorization')) return undefined;
		const token = await storedBearer(this.auth, canonicalResource(this.config.url), force, signal);
		signal.throwIfAborted(); this.lastToken = token; this.hasToken = !!token;
		return token;
	}
	private headers(token?: string, session = this.sessionId): Record<string, string> {
		const headers = new Headers(this.config.headers);
		headers.set('Content-Type', 'application/json'); headers.set('Accept', 'application/json, text/event-stream');
		headers.delete('MCP-Protocol-Version'); headers.delete('Mcp-Session-Id');
		if (this.protocol) headers.set('MCP-Protocol-Version', this.protocol);
		if (session) headers.set('Mcp-Session-Id', session);
		if (token) headers.set('Authorization', `Bearer ${token}`);
		return Object.fromEntries(headers.entries());
	}
	private startEvents(): void {
		if (this.config.transport !== 'http' || this.signal.aborted) return;
		this.events?.abort(); const events = new AbortController(); this.events = events;
		const signal = AbortSignal.any([this.signal, events.signal]);
		void (async () => {
			const token = await this.bearer(false, signal);
			const res = await fetch(this.config.url, { redirect: 'error', method: 'GET', headers: { ...this.headers(token), accept: 'text/event-stream' }, signal });
			if (res.status === 405 || res.status === 404) { await res.body?.cancel(); return; }
			if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) { await res.body?.cancel(); return; }
			await readSse(res, async msg => { await this.handleMessage(msg); return false; });
		})().catch(e => { if (!signal.aborted) { this.error = `MCP event stream unavailable: ${e instanceof Error ? e.message : String(e)}`; this.onChange(); } });
	}

	private async httpPost(payload: Record<string, any>, signal: AbortSignal, refreshed = false): Promise<any> {
		const token = await this.bearer(refreshed, signal), session = this.sessionId;
		const res = await fetch(this.config.url, { redirect: 'error', method: 'POST', headers: this.headers(token), body: JSON.stringify(payload), signal });
		if ((res.status === 401 || res.status === 403) && this.auth && !Object.keys(this.config.headers).some(k => k.toLowerCase() === 'authorization')) {
			this.wwwAuthenticate = res.headers.get('www-authenticate'); await res.body?.cancel();
			if (res.status === 401 && token && !refreshed) return this.httpPost(payload, signal, true);
			throw new AuthRequired(this.wwwAuthenticate);
		}
		if (res.status === 404 && session && payload.method !== 'initialize') { await res.body?.cancel(); throw new SessionExpired(session); }
		if (!res.ok) { await res.body?.cancel(); throw new Error(`MCP HTTP ${res.status}.`); }
		if (payload.method === 'initialize') {
			const id = res.headers.get('mcp-session-id');
			if (id && !/^[\x21-\x7e]+$/.test(id)) { await res.body?.cancel(); throw new Error('Invalid MCP session ID.'); }
			this.sessionId = id ?? undefined;
		}
		const request = typeof payload.method === 'string' && payload.id !== undefined;
		if (!request) { await res.body?.cancel(); return undefined; }
		if (res.status === 202) { await res.body?.cancel(); throw new Error('The MCP server accepted a request without returning its JSON-RPC response.'); }
		let result: any, matched = false;
		const accept = async (msg: Record<string, any>): Promise<boolean> => {
			if (typeof msg.method === 'string') { await this.handleMessage(msg); return false; }
			if (msg.id !== payload.id) return false;
			if (msg.error) throw new Error(typeof msg.error.message === 'string' ? msg.error.message : 'MCP error');
			result = msg.result; matched = true; return true;
		};
		const type = res.headers.get('content-type') ?? '';
		if (type.includes('text/event-stream')) await readSse(res, accept);
		else if (type.includes('application/json')) await accept(validateMessage(await readJsonBody(res)));
		else { await res.body?.cancel(); throw new Error('The MCP server returned an unsupported response content type.'); }
		if (!matched) throw new Error('The MCP server returned no response for the request.');
		return result;
	}

	private async send(payload: Record<string, any>, signal = this.signal): Promise<void> {
		signal.throwIfAborted();
		if (this.config.transport === 'http') {
			await this.httpPost(payload, AbortSignal.any([signal, this.signal, AbortSignal.timeout(30_000)])); return;
		}
		const stream = this.proc?.stdin;
		if (!stream || stream.destroyed) throw new Error('MCP server is not running.');
		await new Promise<void>((resolve, reject) => stream.write(JSON.stringify(payload) + '\n', e => e ? reject(e) : resolve()));
	}
	notify(method: string, params: Record<string, unknown> = {}): void {
		void this.send({ jsonrpc: '2.0', method, params }).catch(e => { if (!this.signal.aborted) { this.error = `MCP notification failed: ${e instanceof Error ? e.message : String(e)}`; this.onChange(); } });
	}

	async request(method: string, params: Record<string, unknown> = {}, timeoutMs = 120_000, signal?: AbortSignal): Promise<any> {
		this.signal.throwIfAborted(); signal?.throwIfAborted();
		const id = ++this.seq, scope = AbortSignal.any([this.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
		const payload = { jsonrpc: '2.0', id, method, params };
		try {
			if (this.config.transport === 'http') {
				try { return await this.httpPost(payload, scope); }
				catch (e) {
					if (!(e instanceof SessionExpired)) throw e;
					if (!this.recovery && (!this.sessionId || this.sessionId === e.session)) {
						this.sessionId = undefined; this.protocol = undefined;
						this.events?.abort();
						this.recovery = this.initialize(false).then(() => this.startEvents()).finally(() => this.recovery = undefined);
					}
					if (this.recovery) await waitFor(this.recovery, scope); scope.throwIfAborted();
					if (method === 'tools/call') {
						const previous = this.tools.find(t => t.name === params.name);
						await waitFor(this.refreshTools(), scope); scope.throwIfAborted();
						const current = this.tools.find(t => t.name === params.name);
						if (!current || JSON.stringify(previous) !== JSON.stringify(current)) throw new Error('MCP tool is unavailable or changed after session recovery; request it again.');
					}
					return await this.httpPost(payload, scope);
				}
			}
			return await new Promise((resolve, reject) => {
				const abort = () => {
					const p = this.pending.get(id); if (!p) return;
					this.pending.delete(id); clearTimeout(p.timer);
					if (!this.signal.aborted && method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: 'Request stopped or timed out' });
					p.reject(scope.reason ?? new Error(`MCP ${method} timed out.`));
				};
				const done = (fn: (v: any) => void) => (v: any) => { scope.removeEventListener('abort', abort); fn(v); };
				const timer = setTimeout(abort, timeoutMs);
				this.pending.set(id, { resolve: done(resolve), reject: done(reject), timer }); scope.addEventListener('abort', abort, { once: true });
				if (scope.aborted) abort();
				else void this.send(payload, scope).catch(e => { const p = this.pending.get(id); if (p) { this.pending.delete(id); clearTimeout(p.timer); p.reject(e); } });
			});
		} catch (e) {
			if (this.config.transport === 'http' && scope.aborted && !this.signal.aborted && method !== 'initialize') this.notify('notifications/cancelled', { requestId: id, reason: 'Request stopped or timed out' });
			if (e instanceof AuthRequired && !this.signal.aborted) { this.state = 'auth'; this.error = e.message; void this.stop(false).catch(() => undefined); this.onChange(); }
			throw e;
		}
	}

	private refreshTools(): Promise<void> {
		if (this.catalogTask) { this.refreshAgain = true; return this.catalogTask; }
		this.catalogTask = (async () => {
			let batches = 0;
			do {
				this.refreshAgain = false;
				const tools: McpToolInfo[] = [], cursors = new Set<string>(), names = new Set<string>();
				const scope = AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]);
				let cursor: string | undefined;
				do {
					if (cursors.size >= 100) throw new Error('MCP tool discovery exceeds 100 pages.');
					const res = await this.request('tools/list', cursor ? { cursor } : {}, 30_000, scope);
					if (!object(res) || !Array.isArray(res.tools)) throw new Error('Invalid MCP tool list.');
					for (const t of res.tools) {
						if (!object(t) || typeof t.name !== 'string' || !t.name || t.name.length > 1024 || (t.description !== undefined && typeof t.description !== 'string') || !object(t.inputSchema) || names.has(t.name)) throw new Error('Invalid or duplicate MCP tool metadata.');
						if (t.outputSchema !== undefined && !object(t.outputSchema)) throw new Error('Invalid MCP output schema.');
						const taskSupport = object(t.execution) && ['forbidden', 'optional', 'required'].includes(t.execution.taskSupport) ? t.execution.taskSupport : undefined;
						names.add(t.name); tools.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: annotations(t.annotations), _meta: object(t._meta) ? t._meta : undefined, taskSupport });
						if (tools.length > 5000) throw new Error('MCP tool discovery exceeds 5000 tools.');
					}
					cursor = res.nextCursor;
					if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('Invalid or repeated MCP pagination cursor.');
					if (cursor) cursors.add(cursor);
				} while (cursor);
				this.signal.throwIfAborted(); this.tools = tools;
			} while (this.refreshAgain && ++batches < 5);
		})().finally(() => this.catalogTask = undefined);
		return this.catalogTask;
	}

	/**
	 * tools/call. On MCP 2025-11-25 a tool that supports tasks runs as one: started, polled
	 * (at the server's interval) and its result fetched, so a long job outlives the 2-minute
	 * request limit. Stopping cancels the task on the server.
	 */
	async callTool(tool: McpToolInfo, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
		const tasks = object(this.capabilities.tasks) && object(this.capabilities.tasks.requests) && object(this.capabilities.tasks.requests.tools) && object(this.capabilities.tasks.requests.tools.call);
		if (this.protocol !== '2025-11-25' || !tasks || (tool.taskSupport !== 'required' && tool.taskSupport !== 'optional')) {
			return this.request('tools/call', { name: tool.name, arguments: args }, 120_000, signal);
		}
		const created = await this.request('tools/call', { name: tool.name, arguments: args, task: { ttl: TASK_LIMIT_MS } }, 120_000, signal);
		if (!object(created) || !object(created.task)) return created; // answered at once
		let task: Record<string, any> = created.task;
		const id = task.taskId;
		if (typeof id !== 'string' || !id || id.length > 1024) throw new Error('Invalid MCP task.');
		const deadline = Date.now() + TASK_LIMIT_MS;
		try {
			while (!['completed', 'failed', 'cancelled', 'input_required'].includes(task.status)) {
				if (Date.now() > deadline) throw new Error(`MCP tool ${tool.name} did not finish within an hour.`);
				const wait = Math.min(10_000, Math.max(250, Number(task.pollInterval) || 1000));
				await waitFor(new Promise((resolve) => setTimeout(resolve, wait)), AbortSignal.any([this.signal, ...(signal ? [signal] : [])]));
				task = await this.request('tasks/get', { taskId: id }, 30_000, signal);
				if (!object(task) || typeof task.status !== 'string') throw new Error('Invalid MCP task status.');
			}
			if (task.status === 'input_required') throw new Error(`MCP tool ${tool.name} asked for input, which zer0ne cannot answer yet.`);
			if (task.status === 'cancelled') throw new Error(`MCP tool ${tool.name} was cancelled by the server${typeof task.statusMessage === 'string' ? `: ${task.statusMessage.slice(0, 300)}` : ''}.`);
			return await this.request('tasks/result', { taskId: id }, 120_000, signal);
		} catch (error) {
			if (task.status !== 'completed' && task.status !== 'failed' && !this.signal.aborted) void this.request('tasks/cancel', { taskId: id }, 10_000).catch(() => undefined);
			throw error;
		}
	}

	// ---- resources and prompts (MCP capabilities the server declared at initialize) ----

	get hasResources(): boolean { return object(this.capabilities.resources); }
	get hasPrompts(): boolean { return object(this.capabilities.prompts); }

	/** One page of resource descriptors. `cursor` comes from the previous call. */
	async listResources(cursor?: string, signal?: AbortSignal): Promise<{ resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>; nextCursor?: string }> {
		const res = await this.request('resources/list', cursor ? { cursor } : {}, 30_000, signal);
		if (!object(res) || !Array.isArray(res.resources)) throw new Error('Invalid MCP resource list.');
		const resources = res.resources.slice(0, 1000).map((r) => object(r) && typeof r.uri === 'string' ? { uri: r.uri, name: typeof r.name === 'string' ? r.name : undefined, description: typeof r.description === 'string' ? r.description : undefined, mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined } : null).filter((r): r is NonNullable<typeof r> => r !== null);
		return { resources, nextCursor: typeof res.nextCursor === 'string' ? res.nextCursor : undefined };
	}

	/** One resource's contents. Text arrives as text; binary as base64 with its mime type. */
	async readResource(uri: string, signal?: AbortSignal): Promise<Array<{ uri: string; mimeType?: string; text?: string; base64?: string }>> {
		const res = await this.request('resources/read', { uri }, 60_000, signal);
		if (!object(res) || !Array.isArray(res.contents)) throw new Error('Invalid MCP resource contents.');
		return res.contents.slice(0, 50).map((c) => object(c) && typeof c.uri === 'string' ? {
			uri: c.uri,
			mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
			text: typeof c.text === 'string' ? c.text : undefined,
			base64: typeof c.blob === 'string' ? c.blob : undefined
		} : null).filter((c): c is NonNullable<typeof c> => c !== null);
	}

	async listPrompts(signal?: AbortSignal): Promise<Array<{ name: string; description?: string; args: string[] }>> {
		const out: Array<{ name: string; description?: string; args: string[] }> = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const res = await this.request('prompts/list', cursor ? { cursor } : {}, 30_000, signal);
			if (!object(res) || !Array.isArray(res.prompts)) throw new Error('Invalid MCP prompt list.');
			for (const p of res.prompts) {
				if (!object(p) || typeof p.name !== 'string' || !p.name) continue;
				out.push({
					name: p.name,
					description: typeof p.description === 'string' ? p.description : undefined,
					args: Array.isArray(p.arguments) ? p.arguments.map((a) => object(a) && typeof a.name === 'string' ? a.name : '').filter(Boolean) : []
				});
			}
			if (out.length > 1000) break;
			cursor = typeof res.nextCursor === 'string' ? res.nextCursor : undefined;
			if (!cursor) break;
		}
		return out;
	}

	/** One prompt rendered by the server: its messages and description. */
	async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<{ description?: string; messages: Array<{ role: string; text: string }> }> {
		if (typeof name !== 'string' || name.length > 1024) throw new Error('Invalid MCP prompt name.');
		for (const [k, v] of Object.entries(args)) if (typeof k !== 'string' || k.length > 256 || typeof v !== 'string' || v.length > 100_000) throw new Error('Invalid MCP prompt argument.');
		const res = await this.request('prompts/get', { name, arguments: args }, 60_000, signal);
		if (!object(res) || !Array.isArray(res.messages)) throw new Error('Invalid MCP prompt result.');
		const messages = res.messages.slice(0, 100).map((m) => object(m) && (m.role === 'user' || m.role === 'assistant')
			? { role: m.role, text: object(m.content) && typeof m.content.text === 'string' ? m.content.text : object(m.content) && typeof m.content.type === 'string' ? `[${m.content.type} content]` : '[unusable content]' }
			: null).filter((m): m is { role: string; text: string } => !!m);
		return { description: typeof res.description === 'string' ? res.description : undefined, messages };
	}

	stop(markStopped = true): Promise<void> {
		if (markStopped) this.state = 'stopped';
		if (this.closing) return this.closing;
		const session = this.sessionId, token = this.lastToken, proc = this.proc;
		this.lifetime.abort(new Error('MCP server stopped.')); this.events?.abort(); this.failAll(new Error('MCP server stopped.')); this.tools = []; this.sessionId = undefined;
		this.closing = (async () => {
			const tasks: Promise<unknown>[] = [this.predecessor];
			if (session && this.config.transport === 'http') tasks.push(fetch(this.config.url, { redirect: 'error', method: 'DELETE', headers: this.headers(token, session), signal: AbortSignal.timeout(5000) }).then(async res => { await res.body?.cancel(); }).catch(() => undefined));
			if (proc && proc.exitCode === null && proc.pid) tasks.push(new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { proc.removeListener('close', closed); reject(new Error('The old MCP process did not exit; restart was stopped.')); }, 5000);
				const closed = () => { clearTimeout(timer); this.proc = undefined; resolve(); };
				proc.once('close', closed); killTree(proc);
			}));
			await Promise.all(tasks);
		})();
		// Callers may intentionally dispose without awaiting; restart still observes teardown failure.
		void this.closing.catch(() => undefined);
		return this.closing;
	}
}
