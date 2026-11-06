import * as path from 'path';
import type * as vscode from 'vscode';
import type { HostContext, HostSurface } from './context';
import { benchmarkModel, type BenchResult } from '../localBench';
import { qualityTest, type QualityResult } from '../localQuality';
import { validRepoId } from '../localEngine';
import { LiveMonitor } from '../localLive';
import { LocalHostServer, lanAddresses, newKey, browserPortAllowed, type LocalHostSettings } from '../localHostServer';
import { EMBED_PREFIX, LocalEmbedService, PRIVATE_MODELS, type EmbedKind } from '../localEmbed';
import type { EmbedTarget } from '../tools/codeIndex';
import { OLLAMA_URL } from '../localModels';

/**
 * The Local models "next level" services, owned by LocalModelsHost:
 * on-machine benchmark and quality test, live monitor, Local Host (OpenAI-compatible router for
 * other tools), private code search (local embeddings + reranker) and idle
 * unload. Messages are `localPlus*`; state goes out as `localPlus`.
 */

/** A server base URL on this computer only (loopback, any port) — the page cannot point the benchmark elsewhere (pure; tested). */
export function loopbackBase(url: string): string | undefined {
	const m = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(\/api)?(\/v1)?\/?$/i.exec(String(url).trim());
	return m && Number(m[2]) > 0 && Number(m[2]) < 65536 ? `http://127.0.0.1:${m[2]}${m[3] ?? ''}/v1` : undefined;
}

/** Ollama's OpenAI endpoint, wherever the user runs it (OLLAMA_HOST may point to another port or machine). */
const ollamaV1 = (): string => OLLAMA_URL.replace(/\/+$/, '') + '/v1';

const KEY_SECRET = 'zer0ne.localHost.key';
const BENCH_KEY = 'zer0ne.local.bench';
const QUALITY_KEY = 'zer0ne.local.quality';
const BATTLE_KEY = 'zer0ne.local.battle';

/** The battle as the page sent it, reduced to what a fighter is: text and numbers of sane size, four at most (pure; tested). */
export function battleFighters(items: unknown): Array<Record<string, string | number>> {
	if (!Array.isArray(items)) return [];
	const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
	return items.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && validRepoId((e as { repo?: unknown }).repo)).slice(0, 4).map((e) => ({
		repo: text(e.repo, 200), name: text(e.name, 200), file: text(e.file, 300), quant: text(e.quant, 40), reason: text(e.reason, 400),
		verdict: ['perfect', 'good', 'marginal', 'slow', 'no'].includes(String(e.verdict)) ? String(e.verdict) : 'no',
		sizeBytes: num(e.sizeBytes), needBytes: num(e.needBytes), util: num(e.util), ctx: num(e.ctx), tokS: num(e.tokS), quality: Math.min(100, num(e.quality))
	}));
}
const HOST_KEY = 'zer0ne.localHost';
const IDLE_KEY = 'zer0ne.local.idleMinutes';

/** What LocalPlus needs from the Local models host. */
export interface LocalPlusDeps {
	ctx: HostContext;
	memento: vscode.Memento;
	storageDir: string;
	enginePort(): number;
	enginePid(): number | undefined;
	engineRunning(): { model?: string; context?: number } | undefined;
	engineBusy?(): boolean;
	engineServerPath(): string | undefined;
	engineBackend(): string | undefined;
	engineModels(): string[];
	ensureLoaded(model: string, signal?: AbortSignal): Promise<void>;
	stopEngine(): void;
	ollama(): Promise<{ base: string; tags: string[] }>;
	refresh(surface: HostSurface): Promise<void>;
	/** Install zer0ne Engine (private code search runs on it). */
	installEngine(surface: HostSurface): Promise<void>;
	/** The OS keychain (the Local Host key lives there). */
	secrets?: vscode.SecretStorage;
}

export class LocalPlus {
	readonly embed: LocalEmbedService;
	private readonly live: LiveMonitor;
	private readonly host: LocalHostServer;
	private benchRunning = new Set<string>();
	private qualityRunning = new Map<string, AbortController>();
	private lastUse = Date.now();
	private idleTimer?: ReturnType<typeof setInterval>;
	private activity: Array<{ at: number; model: string; path: string; ok: boolean; ms: number; from: string }> = [];
	private downloads = new Map<EmbedKind, { received: number; total: number; ctl: AbortController }>();

	constructor(private readonly d: LocalPlusDeps) {
		this.embed = new LocalEmbedService(path.join(d.storageDir, 'private-search'), () => d.engineServerPath(), () => d.enginePort(), () => this.post());
		this.live = new LiveMonitor(() => (d.engineRunning() ? { port: d.enginePort(), pid: d.enginePid() } : undefined), (sample) => d.ctx.postAll({ type: 'localLive', sample }));
		this.host = new LocalHostServer({
			onState: () => this.post(),
			loadedEngine: () => d.engineRunning(),
			models: async () => ({ engine: d.engineModels(), ollama: (await d.ollama().catch(() => ({ tags: [] as string[] }))).tags }),
			ensureEngine: async (model, signal) => {
				this.touch();
				await d.ensureLoaded(model, signal);
				return d.enginePort();
			},
			ollamaBase: () => ollamaV1(),
			embedPort: async (kind) => (this.embed.installed(kind) ? this.embed.ensure(kind) : undefined),
			onActivity: (e) => {
				this.touch();
				this.activity = [{ at: Date.now(), ...e }, ...this.activity].slice(0, 12);
				this.post();
			}
		});
		void this.loadKey().then(() => this.startHost());
		this.idleTimer = setInterval(() => this.idleCheck(), 60_000);
		this.idleTimer.unref?.();
	}

	dispose(): void {
		this.live.stop();
		void this.host.stop();
		this.embed.stop();
		if (this.idleTimer) clearInterval(this.idleTimer);
		for (const dl of this.downloads.values()) dl.ctl.abort();
		for (const ctl of this.qualityRunning.values()) ctl.abort();
	}

	/** The engine was used (chat, Local Host): the idle clock restarts. */
	touch(): void {
		this.lastUse = Date.now();
	}

	// ---------------------------------------------------------------- state

	/** The Local Host key, from the OS keychain (older versions kept it in settings: moved over once). */
	private key = '';
	private async loadKey(): Promise<void> {
		const stored = await this.d.secrets?.get(KEY_SECRET).then((k) => k, () => undefined);
		const legacy = this.d.memento.get<Partial<LocalHostSettings>>(HOST_KEY, {}).key;
		this.key = stored || (typeof legacy === 'string' && legacy.length >= 16 ? legacy : '');
		if (!stored && this.key && this.d.secrets) {
			await this.d.secrets.store(KEY_SECRET, this.key);
			const { key: _drop, ...rest } = this.d.memento.get<Partial<LocalHostSettings>>(HOST_KEY, {});
			await this.d.memento.update(HOST_KEY, rest);
		}
	}

	private hostSettings(): LocalHostSettings {
		const s = this.d.memento.get<Partial<LocalHostSettings>>(HOST_KEY, {});
		return { enabled: s.enabled === true, port: Number.isInteger(s.port) && s.port! >= 1024 && s.port! <= 65535 ? s.port! : 11435, lan: s.lan === true, key: this.key };
	}

	private async saveHost(patch: Partial<LocalHostSettings>): Promise<LocalHostSettings> {
		const { key, ...rest } = { ...this.hostSettings(), ...patch };
		this.key = key || this.key || newKey();
		// The key goes to the OS keychain; without one (tests, other hosts) it stays in memory only.
		if (this.d.secrets) await this.d.secrets.store(KEY_SECRET, this.key);
		await this.d.memento.update(HOST_KEY, rest);
		return { ...rest, key: this.key };
	}

	private idleMinutes(): number {
		const v = this.d.memento.get<number>(IDLE_KEY, 0);
		return [0, 5, 10, 15, 30, 60].includes(v) ? v : 0;
	}

	benchAll(): Record<string, { latest: BenchResult; byBackend: Record<string, BenchResult> }> {
		return this.d.memento.get(BENCH_KEY, {});
	}

	/** Each model's latest quality test (the 40 questions of localQuality.ts). */
	qualityAll(): Record<string, QualityResult> {
		return this.d.memento.get(QUALITY_KEY, {});
	}

	state() {
		const h = this.hostSettings();
		return {
			bench: this.benchAll(),
			benchRunning: [...this.benchRunning],
			quality: this.qualityAll(),
			battle: battleFighters(this.d.memento.get(BATTLE_KEY, [])),
			qualityRunning: [...this.qualityRunning.keys()],
			host: { ...h, running: this.host.listening, requests: this.host.requests, active: this.host.active, queued: this.host.queued, models: this.d.engineModels(), loaded: this.d.engineRunning(), lastError: this.host.lastError, lan: h.lan, addresses: h.lan ? lanAddresses() : [], activity: this.activity },
			idleMinutes: this.idleMinutes(),
			private: { models: this.embed.status(), on: this.d.ctx.store.getSettings().embeddingProvider === 'local', downloads: Object.fromEntries([...this.downloads].map(([k, v]) => [k, { received: v.received, total: v.total }])) },
			live: this.live.on
		};
	}

	post(): void {
		this.d.ctx.postAll({ type: 'localPlus', data: this.state() });
	}

	// ---------------------------------------------------------------- services

	private async startHost(): Promise<void> {
		const s = this.hostSettings();
		if (!s.enabled) return;
		try {
			await this.host.start(s.key ? s : await this.saveHost({}));
		} catch (e) {
			this.host.lastError = e instanceof Error ? e.message : String(e);
		}
		this.post();
	}

	private idleCheck(): void {
		const min = this.idleMinutes();
		if (!min || !this.d.engineRunning() || this.benchRunning.size || this.qualityRunning.size || this.host.active || this.host.queued || this.d.engineBusy?.()) return;
		if (Date.now() - this.lastUse > min * 60_000) {
			this.d.stopEngine();
			this.d.ctx.status(`Unloaded the local model after ${min} idle minutes — it loads again on the next message.`, '');
		}
	}

	/** Code search target on this computer (embeddings + reranker when downloaded). */
	async privateSearchTarget(): Promise<EmbedTarget | undefined> {
		if (!this.embed.installed('embed')) return undefined;
		const port = await this.embed.ensure('embed');
		const rerank = this.embed.installed('rerank') ? await this.embed.ensure('rerank').catch(() => undefined) : undefined;
		return {
			baseUrl: `http://127.0.0.1:${port}/v1`,
			apiKey: '',
			model: PRIVATE_MODELS.embed.alias,
			queryPrefix: EMBED_PREFIX.query,
			docPrefix: EMBED_PREFIX.document,
			rerank: rerank ? { baseUrl: `http://127.0.0.1:${rerank}/v1`, model: PRIVATE_MODELS.rerank.alias } : undefined
		};
	}

	/**
	 * Benchmark a model: zer0ne Engine (loaded first), or any server on this
	 * computer — Ollama, LM Studio, a llama-server you run — by its loopback URL.
	 */
	private async bench(surface: HostSurface, id: string, server?: string): Promise<void> {
		// "ollama" = the configured Ollama (OLLAMA_HOST honoured); any other server must be on this computer.
		const base = server === 'ollama' ? ollamaV1() : server ? loopbackBase(server) : undefined;
		if (server && !base) {
			this.d.ctx.status('Benchmarks run on servers on this computer only.', 'error');
			return;
		}
		if (this.benchRunning.has(id) || this.qualityRunning.has(id)) return;
		this.benchRunning.add(id);
		this.post();
		const stage = (text: string) => this.d.ctx.postAll({ type: 'localBenchStage', id, text });
		try {
			let url = base;
			let backend = base ? (server === 'ollama' ? 'ollama' : /:1234\b/.test(base) ? 'lmstudio' : 'server') : undefined;
			if (!url) {
				stage('Loading the model…');
				await this.d.ensureLoaded(id);
				this.touch();
				url = `http://127.0.0.1:${this.d.enginePort()}/v1`;
				backend = this.d.engineBackend();
			} else stage('Loading the model in ' + backend + '…');
			const r = await benchmarkModel(url, id, { backend, onStage: stage });
			const all = this.benchAll();
			const prev = all[id];
			all[id] = { latest: r, byBackend: { ...(prev?.byBackend ?? {}), [r.backend ?? 'engine']: r } };
			await this.d.memento.update(BENCH_KEY, all);
			this.d.ctx.status(r.error ? `Benchmark of ${id} failed: ${r.error}` : `${id}: ${r.tokS ?? '?'} tok/s · agent readiness ${r.score}%${r.backend ? ' on ' + r.backend : ''}.`, r.error ? 'error' : 'ok');
		} catch (e) {
			this.d.ctx.status(`Benchmark of ${id} failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
		} finally {
			this.benchRunning.delete(id);
			stage('');
			this.post();
			await this.d.refresh(surface);
		}
	}

	/**
	 * The quality test of a model: zer0ne Engine (loaded first), or a server on this computer.
	 * One test at a time per model, and never beside a benchmark of it: both would share the model's one slot.
	 */
	/** The quality test for Models Fit Studio's page: its progress as question numbers, its result returned. */
	async runQuality(surface: HostSurface, id: string, onQuestion: (n: number, total: number) => void, signal: AbortSignal): Promise<QualityResult | undefined> {
		const stop = () => this.qualityRunning.get(id)?.abort();
		signal.addEventListener('abort', stop, { once: true });
		try {
			await this.quality(surface, id, undefined, (text) => { const m = /Question (\d+) of (\d+)/.exec(text); if (m) onQuestion(Number(m[1]), Number(m[2])); }, true);
			return this.lastQuality.get(id);
		} finally { signal.removeEventListener('abort', stop); this.lastQuality.delete(id); }
	}
	private readonly lastQuality = new Map<string, QualityResult>();

	private async quality(surface: HostSurface, id: string, server?: string, onStage?: (text: string) => void, keep = false): Promise<void> {
		const base = server === 'ollama' ? ollamaV1() : server ? loopbackBase(server) : undefined;
		if (server && !base) {
			this.d.ctx.status('Quality tests run on servers on this computer only.', 'error');
			return;
		}
		if (this.qualityRunning.has(id) || this.benchRunning.has(id)) return;
		const ctl = new AbortController();
		this.qualityRunning.set(id, ctl);
		this.post();
		const stage = (text: string) => { this.d.ctx.postAll({ type: 'localBenchStage', id, text }); onStage?.(text); };
		try {
			let url = base;
			let backend = base ? (server === 'ollama' ? 'ollama' : /:1234\b/.test(base) ? 'lmstudio' : 'server') : undefined;
			if (!url) {
				stage('Loading the model…');
				await this.d.ensureLoaded(id, ctl.signal);
				url = `http://127.0.0.1:${this.d.enginePort()}/v1`;
				backend = this.d.engineBackend();
			}
			const r = await qualityTest(url, id, { backend, signal: ctl.signal, onStage: (text) => { this.touch(); stage(text); } });
			if (keep) this.lastQuality.set(id, r);
			if (r.error) this.d.ctx.status(r.error === 'Cancelled.' ? `Quality test of ${id} stopped.` : `Quality test of ${id} failed: ${r.error}`, r.error === 'Cancelled.' ? '' : 'error');
			else {
				await this.d.memento.update(QUALITY_KEY, { ...this.qualityAll(), [id]: r });
				this.d.ctx.status(`${id}: ${r.correct} of ${r.total} questions right (${r.score}%).`, 'ok');
			}
		} catch (e) {
			this.d.ctx.status(`Quality test of ${id} failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
		} finally {
			this.qualityRunning.delete(id);
			stage('');
			this.post();
			await this.d.refresh(surface);
		}
	}

	private async setupPrivate(surface: HostSurface): Promise<void> {
		// Both models run on zer0ne Engine: users of Ollama / LM Studio get it installed first (32 MB, the right build for their GPU).
		if (!this.d.engineServerPath()) {
			this.d.ctx.status('Installing zer0ne Engine first — private code search runs on it…', '');
			await this.d.installEngine(surface).catch(() => undefined);
			if (!this.d.engineServerPath()) {
				this.d.ctx.status('Private code search needs zer0ne Engine, and it could not be installed — see Local models → Runtimes.', 'error');
				return;
			}
		}
		for (const kind of ['embed', 'rerank'] as EmbedKind[]) {
			if (this.embed.installed(kind) || this.downloads.has(kind)) continue;
			const dl = { received: 0, total: PRIVATE_MODELS[kind].bytes, ctl: new AbortController() };
			this.downloads.set(kind, dl);
			this.post();
			let last = 0;
			try {
				await this.embed.download(kind, (p) => {
					Object.assign(dl, { received: p.received, total: p.total || dl.total });
					if (Date.now() - last > 400) {
						last = Date.now();
						this.post();
					}
				}, dl.ctl.signal);
			} catch (e) {
				this.d.ctx.status(`Could not download ${PRIVATE_MODELS[kind].label}: ${e instanceof Error ? e.message : String(e)}`, 'error');
				this.downloads.delete(kind);
				this.post();
				return;
			}
			this.downloads.delete(kind);
		}
		// Turn it on: the code index uses the local models from now on (it re-embeds once for the new model).
		await this.d.ctx.store.updateSettings({ embeddingProvider: 'local', embeddingModel: PRIVATE_MODELS.embed.alias, codeIndex: true });
		await this.d.ctx.sendState();
		this.d.ctx.status('Private code search is on — embeddings and reranking run on this computer.', 'ok');
		this.post();
	}

	// ---------------------------------------------------------------- messages

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		switch (msg.type) {
			case 'localPlus':
				this.post();
				return true;
			case 'localBench':
				if (typeof msg.id === 'string' && msg.id) void this.bench(surface, msg.id, typeof msg.server === 'string' ? msg.server : undefined);
				return true;
			case 'localBattle':
				// Saved without echoing it back: the page that sent it already shows it.
				await this.d.memento.update(BATTLE_KEY, battleFighters(msg.items));
				return true;
			case 'localQuality':
				if (typeof msg.id !== 'string' || !msg.id) return true;
				if (msg.cancel === true) this.qualityRunning.get(msg.id)?.abort();
				else void this.quality(surface, msg.id, typeof msg.server === 'string' ? msg.server : undefined);
				return true;
			case 'localLive':
				if (msg.on === true) this.live.start();
				else this.live.stop();
				return true;
			case 'localHostSet': {
				const p = msg.patch ?? {};
				if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1024 || !browserPortAllowed(p.port))) {
					this.d.ctx.status(`Port ${p.port} cannot be used by browser clients. Choose 11435 or another unblocked port from 1024 to 65535.`, 'error');
					this.post();
					return true;
				}
				const patch: Partial<LocalHostSettings> = {};
				if (typeof p.enabled === 'boolean') patch.enabled = p.enabled;
				if (typeof p.lan === 'boolean') patch.lan = p.lan;
				if (Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535) patch.port = p.port;
				if (p.newKey === true) patch.key = newKey();
				const s = await this.saveHost(patch);
				if (s.enabled) {
					try {
						await this.host.start(s);
						this.host.lastError = '';
						this.d.ctx.status(`Local Host is serving on http://${s.lan ? (lanAddresses()[0] ?? '0.0.0.0') : '127.0.0.1'}:${s.port}/v1`, 'ok');
					} catch (e) {
						this.host.lastError = e instanceof Error ? e.message : String(e);
						this.d.ctx.status(this.host.lastError, 'error');
					}
				} else {
					await this.host.stop();
				}
				this.post();
				return true;
			}
			case 'localHostCheck': {
				const h = this.hostSettings();
				try {
					if (!this.host.listening) throw new Error('Turn on Local Host router first.');
					const response = await fetch(`http://127.0.0.1:${h.port}/v1/models`, { headers: { Authorization: 'Bearer ' + h.key }, signal: AbortSignal.timeout(5000) });
					if (!response.ok) throw new Error(`Router HTTP ${response.status}`);
					const data = await response.json() as { data?: Array<{ id: string }> };
					surface.post({ type: 'localHostCheck', models: (data.data ?? []).map(m => m.id) });
				} catch (e) { surface.post({ type: 'localHostCheck', error: e instanceof Error ? e.message : String(e) }); }
				return true;
			}
			case 'localIdle': {
				const v = Number(msg.minutes);
				await this.d.memento.update(IDLE_KEY, [0, 5, 10, 15, 30, 60].includes(v) ? v : 0);
				this.post();
				return true;
			}
			case 'privateSearch':
				if (msg.action === 'setup') void this.setupPrivate(surface);
				else if (msg.action === 'cancel') for (const dl of this.downloads.values()) dl.ctl.abort();
				else if (msg.action === 'off') {
					this.embed.stop();
					await this.d.ctx.store.updateSettings({ embeddingProvider: '' });
					await this.d.ctx.sendState();
					this.post();
				}
				return true;
		}
		return false;
	}
}
