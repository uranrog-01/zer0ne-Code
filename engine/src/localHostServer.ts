import * as http from 'http';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * Local Host (Settings → Local models → Runtimes): one OpenAI-compatible
 * address for every model on this computer, for other tools (Cline, Continue,
 * OpenCode, Cursor, scripts, the phone). The model name in a request picks the
 * model: zer0ne Engine GGUFs are loaded on demand (one at a time — requests
 * queue so a swap never cuts a stream), Ollama tags are passed to Ollama.
 * A key is required; the LAN switch binds all interfaces. No vscode dependency.
 */

export interface LocalHostSettings {
	enabled: boolean;
	port: number;
	/** Listen on all interfaces (other devices on the network) instead of 127.0.0.1. */
	lan: boolean;
	key: string;
}

export interface LocalHostDeps {
	/** Engine models (GGUF ids) and Ollama tags available now. */
	models(): Promise<{ engine: string[]; ollama: string[] }>;
	/** Load an engine model (swapping if needed); resolves with the engine's port. */
	ensureEngine(model: string, signal: AbortSignal): Promise<number>;
	ollamaBase(): string;
	/** Embeddings / rerank served by the private-search models, when running: their port. */
	embedPort(kind: 'embed' | 'rerank'): Promise<number | undefined>;
	onActivity(e: { model: string; path: string; ok: boolean; ms: number; from: string }): void;
	onState?(): void;
	loadedEngine?(): { model?: string; context?: number } | undefined;
}

export const newKey = (): string => 'zk-' + crypto.randomBytes(18).toString('base64url');

/** Addresses other devices can use (LAN mode) (pure enough; tested via shape). */
export function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
	return out;
}

/** Which route a request takes (pure; tested). */
const routePath = (pathname: string) => pathname.replace(/^(?:\/v1)+(?=\/|$)/, '').replace(/\/+$/, '');
const targets = {
	chat: '/v1/chat/completions', completions: '/v1/completions', embeddings: '/v1/embeddings', rerank: '/v1/rerank',
	responses: '/v1/responses', messages: '/v1/messages', messageTokens: '/v1/messages/count_tokens',
	responseTokens: '/v1/responses/input_tokens', chatTokens: '/v1/chat/completions/input_tokens'
};
export function routeFor(pathname: string, method: string): 'models' | 'health' | keyof typeof targets | undefined {
	const p = routePath(pathname);
	if (method === 'GET' && p === '/models') return 'models';
	if (method === 'GET' && (p === '/health' || p === '')) return 'health';
	if (method !== 'POST') return undefined;
	if (p === '/reranking') return 'rerank';
	for (const [route, target] of Object.entries(targets)) if (p === target.slice(3)) return route as keyof typeof targets;
	return undefined;
}

// Fetch and browser clients reject these ports even if a TCP listener can bind them.
const blockedPorts = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
	87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 138, 139, 143, 161, 179,
	389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990,
	993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6001, 6002, 6003, 6004, 6005,
	6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 9418, 10080]);
export function browserPortAllowed(port: number): boolean {
	return Number.isInteger(port) && port >= 1 && port <= 65535 && !blockedPorts.has(port);
}

/** Constant-time check of "Authorization: Bearer <key>" (or x-api-key) (pure; tested). */
export function authorized(headers: http.IncomingHttpHeaders, key: string): boolean {
	const given = String(headers.authorization ?? '').replace(/^Bearer\s+/i, '') || String(headers['x-api-key'] ?? '');
	const a = Buffer.from(given);
	const b = Buffer.from(key);
	return !!key && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class LocalHostServer {
	private server?: http.Server;
	private queue: Promise<unknown> = Promise.resolve();
	private controllers = new Set<AbortController>();
	private pending = 0;
	get active(): number { return Math.max(0, this.pending - this.queued); }
	queued = 0;
	requests = 0;
	lastError = '';

	constructor(private readonly deps: LocalHostDeps) {}

	get listening(): boolean {
		return !!this.server?.listening;
	}

	async start(s: LocalHostSettings): Promise<void> {
		if (!s.key || s.key.length < 16) throw new Error('Generate an API key before starting Local Host.');
		if (s.port !== 0 && !browserPortAllowed(s.port)) throw new Error(`Port ${s.port} cannot be used by browser clients. Choose 11435 or another unblocked port.`);
		await this.stop();
		const server = http.createServer((req, res) => void this.handle(req, res, s).catch(e => {
			this.lastError = e instanceof Error ? e.message : String(e);
			if (!res.headersSent && !res.destroyed) this.json(res, 502, { error: { message: this.lastError } });
			else res.end();
		}));
		// The body of a request must arrive in reasonable time; the answer may take long.
		server.requestTimeout = 300_000;
		server.headersTimeout = 30_000;
		server.setTimeout(0); // a generation streams for minutes: the socket stays open on purpose
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(s.port, s.lan ? '0.0.0.0' : '127.0.0.1', () => {
				server.off('error', reject);
				resolve();
			});
		}).catch((e: NodeJS.ErrnoException) => {
			throw new Error(e.code === 'EADDRINUSE' ? `Port ${s.port} is already in use — pick another port for Local Host.` : e.message);
		});
		this.server = server;
		this.lastError = '';
	}

	stop(): Promise<void> {
		const s = this.server;
		this.server = undefined;
		for (const ctl of this.controllers) ctl.abort();
		s?.closeAllConnections();
		return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
	}

	private json(res: http.ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(body));
	}

	private async handle(req: http.IncomingMessage, res: http.ServerResponse, s: LocalHostSettings): Promise<void> {
		const started = Date.now();
		const url = new URL(req.url ?? '/', 'http://localhost');
		const route = routeFor(url.pathname, req.method ?? 'GET');
		const from = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
		const error = (status: number, message: string, type = 'invalid_request_error') => this.json(res, status, { ...(route === 'messages' || route === 'messageTokens' ? { type: 'error' } : {}), error: { message, type } });
		const loaded = this.deps.loadedEngine?.();
		// A key is required for every route, including /health: on the LAN that would tell
		// any host which model is loaded and how much context it runs with.
		if (!authorized(req.headers, s.key)) return error(401, 'Missing or wrong API key. Use the key shown under Local models → Runtimes → Local Host.', 'invalid_api_key');
		if (route === 'health') return this.json(res, 200, { status: 'ok', name: 'zer0ne Local Host', hasModel: !!loaded?.model, engineContextTokens: loaded?.context });
		if (req.method === 'GET' && routePath(url.pathname) === '/status') return this.json(res, 200, { active: this.active, queued: this.queued, requests: this.requests, engineModel: loaded?.model, engineContextTokens: loaded?.context });
		if (!route) return error(404, `No route for ${req.method} ${url.pathname}. Use /v1/models, /v1/chat/completions, /v1/responses, /v1/messages or /v1/embeddings.`);
		if (route === 'models') {
			const m = await this.deps.models();
			const data = [...m.engine.map((id) => ({ id, object: 'model', owned_by: 'zer0ne-engine' })), ...m.ollama.filter(id => !m.engine.includes(id)).map((id) => ({ id, object: 'model', owned_by: 'ollama' })), ...m.engine.map(id => ({ id: 'engine/' + id, object: 'model', owned_by: 'zer0ne-engine' })), ...m.ollama.map(id => ({ id: 'ollama/' + id, object: 'model', owned_by: 'ollama' }))];
			return this.json(res, 200, { object: 'list', data });
		}
		let raw: Buffer;
		try {
			raw = await readBody(req, 64 * 1024 * 1024);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return error(/stopped arriving/.test(message) ? 408 : 413, message);
		}
		let body: { model?: unknown };
		try {
			body = JSON.parse(raw.toString('utf8'));
			if (!body || typeof body !== 'object' || Array.isArray(body) || (body.model !== undefined && typeof body.model !== 'string')) throw new Error('Invalid request object.');
		} catch {
			return error(400, 'The request body is not valid JSON.');
		}
		const model = String(body.model ?? '');
		this.requests++;
		const ctl = new AbortController();
		this.controllers.add(ctl);
		this.pending++; this.deps.onState?.();
		res.on('close', () => !res.writableEnded && ctl.abort());
		try {
			if (route === 'embeddings' || route === 'rerank') {
				const port = await this.deps.embedPort(route === 'rerank' ? 'rerank' : 'embed');
				if (!port) return this.json(res, 503, { error: { message: 'No local embedding or reranking model is configured for this router.' } });
				const ok = await proxy(`http://127.0.0.1:${port}${route === 'rerank' ? '/v1/rerank' : '/v1/embeddings'}`, raw, res, ctl.signal);
				this.deps.onActivity({ model, path: route, ok, ms: Date.now() - started, from });
				return;
			}
			const { engine, ollama } = await this.deps.models();
			const target = targets[route];
			const engineId = model.startsWith('engine/') ? model.slice(7) : model;
			const ollamaId = model.startsWith('ollama/') ? model.slice(7) : model;
			let ok = false;
			if (!model.startsWith('ollama/') && (engine.includes(engineId) || (!model && engine.length))) {
				const id = engineId || engine[0];
				const payload = Buffer.from(JSON.stringify({ ...body, model: id }));
				// One engine, one model: requests queue so a swap never interrupts a running stream.
				this.queued++; this.deps.onState?.();
				const run = this.queue.catch(() => undefined).then(async () => {
					this.queued--; this.deps.onState?.();
					ctl.signal.throwIfAborted();
					const port = await this.deps.ensureEngine(id, ctl.signal);
					ctl.signal.throwIfAborted();
					ok = await proxy(`http://127.0.0.1:${port}${target}`, payload, res, ctl.signal, req.headers);
				});
				this.queue = run.catch(() => undefined);
				await run;
			} else if (!model.startsWith('engine/') && (ollama.includes(ollamaId) || ollama.includes(ollamaId + ':latest'))) {
				if (route !== 'chat' && route !== 'completions') {
					this.deps.onActivity({ model, path: route, ok: false, ms: Date.now() - started, from });
					return error(501, 'This API route requires a zer0ne Engine model. Select engine/model-id, or use Chat Completions for Ollama.', 'not_supported_error');
				}
				ok = await proxy(`${this.deps.ollamaBase().replace(/\/v1\/?$/, '')}${target}`, Buffer.from(JSON.stringify({ ...body, model: ollamaId })), res, ctl.signal, req.headers);
			} else {
				return error(404, `Model "${model}" is not on this computer. GET /v1/models lists what is.`, 'model_not_found');
			}
			this.deps.onActivity({ model, path: route, ok, ms: Date.now() - started, from });
		} catch (e) {
			if (!ctl.signal.aborted) this.lastError = e instanceof Error ? e.message : String(e);
			this.deps.onActivity({ model, path: route, ok: false, ms: Date.now() - started, from });
			if (!res.headersSent && !res.destroyed) error(502, ctl.signal.aborted ? 'Request cancelled.' : this.lastError, 'api_error');
			else res.destroy();
		} finally {
			this.controllers.delete(ctl); this.pending--; this.deps.onState?.();
		}
	}
}

function readBody(req: http.IncomingMessage, limit: number, timeoutMs = 300_000): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const parts: Buffer[] = [];
		let size = 0;
		// A body that stops arriving must not hold the connection forever.
		const timer = setTimeout(() => {
			reject(new Error('The request body stopped arriving.'));
			req.destroy();
		}, timeoutMs);
		timer.unref?.();
		const done = (fn: () => void) => {
			clearTimeout(timer);
			fn();
		};
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				done(() => reject(new Error('Request too large.')));
				req.destroy();
			} else parts.push(c);
		});
		req.on('end', () => done(() => resolve(Buffer.concat(parts))));
		req.on('error', (e) => done(() => reject(e)));
	});
}

/** Forward the request and stream the answer back as it arrives (SSE included). */
async function proxy(url: string, body: Buffer, res: http.ServerResponse, signal: AbortSignal, incoming: http.IncomingHttpHeaders = {}): Promise<boolean> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	// Protocol hints pass through; router credentials stay at this boundary.
	for (const name of ['accept', 'anthropic-version', 'anthropic-beta', 'openai-beta']) {
		const value = incoming[name];
		if (typeof value === 'string') headers[name] = value;
	}
	const up = await fetch(url, { method: 'POST', headers, body, signal });
	const responseHeaders: Record<string, string> = { 'Content-Type': up.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };
	for (const name of ['retry-after', 'x-request-id']) { const value = up.headers.get(name); if (value) responseHeaders[name] = value; }
	res.writeHead(up.status, responseHeaders);
	if (!up.body) { res.end(); return up.ok; }
	const reader = up.body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!res.write(Buffer.from(value))) await new Promise<void>((resolve, reject) => {
			const cleanup = () => { res.off('drain', drained); signal.removeEventListener('abort', aborted); };
			const drained = () => { cleanup(); resolve(); };
			const aborted = () => { cleanup(); reject(new Error('Request cancelled.')); };
			res.once('drain', drained); signal.addEventListener('abort', aborted, { once: true });
			if (signal.aborted) aborted();
		});
	}
	res.end();
	return up.ok;
}
