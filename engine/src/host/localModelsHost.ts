import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ensureOllama, managedOllama } from '../ollamaSetup';
import type * as vscode from 'vscode';
import { HostContext, HostFeature, HostSurface } from './context';
import { OLLAMA_URL, SUGGESTED, contextAlias, describeMachine, detectMachine, detectServers, engineFit, fitAdvice, inspectTag, listInstalled, machineCapacity, ollamaBinary, pullModel, rateFit, removeModel, startOllama, freeDisk, Machine } from '../localModels';
import { planTurbo, type TurboPlan } from '../turboFit';
import { fitModel, prefersPlainAttention, readModelShape } from '../modelFit';
import { applyTuning, kvMemoryOf, probeModelSpeed, tuneKey, tuneModel, type TuneResult } from '../localTune';
import { catalogFor, setEngineLightKv } from '../localCatalog';
import { Backend, ENGINE_PIN, EngineChannel, EngineInstall, EngineOptions, EngineServer, LocalGguf, autoBackend, markEngineProven, rollbackEngine, installEngine, installedEngine, listDevices, lmsLoad, lmsModels, lmsPath, lmsUnload, scanGguf, setHfToken, hfWhoAmI, hfAccess, hfCard, hfTree, ggufFiles, safeGgufParts, sanitizeEngineSettings, validRepoId } from '../localEngine';
import { GgufConverter, convertFiles, convertQuant, findPython } from '../ggufConvert';
import { LocalPlus } from './localPlus';
import { LocalCatalogHost, type ChatMedia } from './localCatalogHost';
import { ModelFitHost } from './modelFitHost';
import { hfCached } from '../hfCache';
import { fitHubFiles, seedFromHub } from '../modelDiscovery';
import { verifiedHfDownload, searchHfPage } from '../localEngine';
import { hubSearchModels, rateHubSearch } from '../modelDiscovery';
import { architectureReason } from '../nativeSupport';
import { currentMeasurement, experienceKey, hardwareKey, measureLocalModel, modelStamp, groupHubModels, modelStatus, type ModelMeasurement } from '../localExperience';
import { integratedGpu } from '../localModels';
import { hfRepoFromInput } from '../localEngine';
import { setupPicks, type SetupPick } from '../localSetup';

const HF_TOKEN_KEY = 'zer0ne.hfToken';

const TAG = /^[\w./:-]+(:[\w.-]+)?$/;
export const ENGINE_PRESET = 'zer0ne-engine';

/** First-run setup: whether the guided path ran, and the task to prefill after it. */
const SETUP_DONE_KEY = 'zer0ne.setup.done';
const SETUP_TASK_KEY = 'zer0ne.setup.firstTask';

interface EngineSettings {
	/** 'auto' = CUDA on NVIDIA, Metal on Apple, Vulkan on other GPUs, CPU otherwise. */
	backend: Backend | 'auto';
	/** 0 = auto: a context tier sized to this machine's RAM (16k / 32k / 64k), fitted by llama.cpp. */
	context: number;
	gpu: 'auto' | 'cpu';
	lightKv: boolean;
	port: number;
	/** N-gram speculative decoding for every engine model (same output, faster on code). */
	speedBoost: boolean;
	/** 'tested' = the llama.cpp build zer0ne is tested with (ENGINE_PIN); 'latest' = the newest release. */
	channel: EngineChannel;
	/** The local helper model loads beside the chat model (port + 1) when both fit in memory. */
	helperSlot: boolean;
	firstLoadTest: boolean;
}

interface Job {
	key: string;
	label: string;
	stage: string;
	received: number;
	total: number;
	rate: number;
	ctl: AbortController;
}

/**
 * Settings → Local models: Discover (Hugging Face), My models (engine GGUFs,
 * LM Studio's folder, Ollama), Runtimes (zer0ne Engine = llama.cpp, Ollama,
 * detected servers) and the machine check.
 */
/** zer0ne code's version (engine/engine.json is written by the build), for Models Fit Studio's About card. */
function appVersion(): string {
	try { return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'engine.json'), 'utf8')).appVersion ?? ''); } catch { return ''; }
}

/** Measured tok/s per local model (see recordSpeed). */
const SPEED_KEY = 'zer0ne.local.speeds';

export class LocalModelsHost implements HostFeature {
	private readonly jobs = new Map<string, Job>();
	private readonly server: EngineServer;
	/** Second slot: the local helper model, beside the chat model, so helper work never unloads it. */
	private readonly helperServer: EngineServer;
	private devicesCache?: { gpuName?: string; bytes?: number; freeBytes?: number };
	private devicesLoading = false;
	private readonly hfReady: Promise<string | undefined>;

	constructor(
		private readonly ctx: HostContext,
		private readonly storageDir: string,
		private readonly memento: vscode.Memento,
		private readonly secrets?: vscode.SecretStorage,
		private readonly focusChat?: () => void
	) {
		// The catalogue rates models against the KV cache the engine loads with.
		setEngineLightKv(this.settings().lightKv);
		this.server = new EngineServer(() => this.ctx.postAll({ type: 'engineState', engine: this.engineState() }));
		this.helperServer = new EngineServer(() => this.ctx.postAll({ type: 'engineState', engine: this.engineState() }));
		this.hfReady = this.loadHfToken();
		this.plus = new LocalPlus({
			ctx,
			memento,
			storageDir,
			enginePort: () => this.settings().port,
			enginePid: () => this.server.pid,
			engineRunning: () => (this.server.running ? { model: this.server.model, context: this.server.run?.ctx } : undefined),
			engineBusy: () => !!this.tuning || !!this.testing,
			engineServerPath: () => installedEngine(this.engineDir)?.server,
			engineBackend: () => installedEngine(this.engineDir)?.backend,
			engineModels: () => scanGguf(this.modelsDir).map((g) => g.id),
			ensureLoaded: (model, signal) => this.ensureLoaded(model, signal, 'main').then(() => undefined),
			stopEngine: () => {
				this.server.stop();
				this.helperServer.stop();
			},
			ollama: async () => {
				const running = (await detectServers()).some((s) => s.id === 'ollama' && s.running);
				return { base: OLLAMA_URL.replace(/\/+$/, '') + '/v1', tags: running ? (await listInstalled(this.machine()).catch(() => [])).map((m) => m.tag) : [] };
			},
			refresh: (surface) => this.snapshot(surface),
			installEngine: (surface) => this.install(surface, this.resolveBackend(this.settings().backend)),
			secrets
		});
		this.catalog = new LocalCatalogHost({
			ctx,
			memento,
			storageDir,
			machine: (refresh) => { if (refresh) this.devicesCache = undefined; return this.machine(refresh); },
			prepareHardware: async () => {
				const eng = installedEngine(this.engineDir);
				if (!eng || eng.backend === 'cpu') return;
				const best = (await listDevices(eng.server)).sort((a, b) => b.freeMiB - a.freeMiB)[0];
				this.devicesCache = best ? { gpuName: best.name, bytes: best.totalMiB * 1048576, freeBytes: best.freeMiB * 1048576 } : {};
			},
			freeGpuMemory: () => {
				if (this.devicesCache?.freeBytes === undefined || integratedGpu(this.machine().gpuName) || this.machine().unifiedMemory) return undefined;
				const fit = this.server.run?.fit;
				// The main slot is replaced on selection; reclaim is an estimate, not GPU telemetry.
				const reclaim = this.server.running && this.server.run?.gpu !== 'cpu' && fit && !fit.cpuExpertLayers ? Math.min(this.machine().gpuMemoryBytes ?? 0, fit.memoryBytes) : 0;
				return Math.min(this.machine().gpuMemoryBytes ?? Infinity, this.devicesCache.freeBytes + reclaim);
			},
			engineVersion: () => installedEngine(this.engineDir)?.version ?? ENGINE_PIN,
			gguf: () => scanGguf(this.modelsDir),
			measurements: () => this.modelMeasurements(),
			freeMemory: () => {
				const m = this.machine(), shared = m.unifiedMemory || integratedGpu(m.gpuName) || !m.gpuMemoryBytes || this.server.run?.gpu === 'cpu';
				return Math.min(m.totalMemoryBytes, os.freemem() + (this.server.running && shared ? this.server.run?.fit?.memoryBytes ?? 0 : 0));
			},
			jobs: this.jobs,
			progress: (job) => this.progress(job),
			download: (surface, repo, file) => this.hfDownload(surface, repo, file, 'engine'),
			chat: (surface, id) => this.chatWith(surface, id),
			removeGguf: (id) => this.removeGguf(id),
			speeds: () => {
				// Benchmarks first (a controlled run), then the moving average of real chats.
				const out: Record<string, number> = Object.fromEntries(Object.entries(this.speeds()).map(([k, v]) => [k, v.tokS]));
				for (const [k, v] of Object.entries(this.plus.benchAll())) if (v?.latest?.tokS) out[k] = v.latest.tokS;
				return out;
			},
			refresh: (surface) => this.snapshot(surface),
			toChat: (media) => (this.mediaToChat ? this.mediaToChat(media) : Promise.resolve()),
			focusChat: () => this.focusChat?.(),
			saveDialog: async (name, kind) => {
				try {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const vs = require('vscode') as typeof vscode;
					const folder = path.join(require('os').homedir(), kind === 'video' ? 'Videos' : kind === 'voice' ? 'Music' : 'Pictures');
					const uri = await vs.window.showSaveDialog({ defaultUri: vs.Uri.file(path.join(fs.existsSync(folder) ? folder : require('os').homedir(), name)), filters: kind === 'video' ? { Video: ['webm'] } : kind === 'voice' ? { Audio: ['wav'] } : { Image: ['png'] }, saveLabel: 'Save' });
					return uri?.fsPath;
				} catch {
					return undefined;
				}
			},
			openExternal: (target) => this.openExternal(target)
		});
		this.modelfit = new ModelFitHost({
			ctx,
			memento,
			modelsDir: this.modelsDir,
			storageDir: this.storageDir,
			engineDir: this.engineDir,
			appVersion: appVersion(),
			machine: () => this.machine(),
			catalog: this.catalog,
			gguf: () => scanGguf(this.modelsDir),
			measurements: () => this.modelMeasurements(),
			measure: async (id, signal) => {
				await this.ensureLoaded(id, signal, 'main');
				const model = scanGguf(this.modelsDir).find((g) => g.id === id);
				if (model) await this.testLoaded(this.server, model, signal, true);
				return this.modelMeasurements().find((r) => r.model === id);
			},
			quality: async (surface, id, onQuestion, signal) => {
				const r = await this.plus.runQuality(surface, id, onQuestion, signal);
				return r ? { score: r.score, correct: r.correct, total: r.total, parts: r.parts, error: r.error } : { score: 0, correct: 0, total: 0, parts: {}, error: signal.aborted ? 'Cancelled.' : 'The quality test did not run.' };
			},
			qualityScores: () => this.plus.qualityAll(),
			download: async (surface, repo, file) => {
				const key = `hf:${repo}/${file.name}`;
				this.downloadErrors.delete(key);
				await this.hfDownload(surface, repo, file, 'engine');
				return this.downloadErrors.get(key);
			},
			job: (key) => this.jobs.get(key),
			removeGguf: (id) => this.removeGguf(id),
			chatWith: (surface, id) => this.chatWith(surface, id),
			ensureLoaded: (id) => this.ensureLoaded(id, undefined, 'main').then(() => undefined),
			stopEngine: () => { this.server.stop(); this.helperServer.stop(); },
			engine: () => {
				const inst = installedEngine(this.engineDir);
				return { installed: !!inst, version: inst?.version, backend: inst?.backend, server: inst?.server, running: this.server.running, model: this.server.model, ctx: this.server.run?.ctx, gpu: this.server.run?.gpu };
			},
			installEngine: (surface) => this.install(surface, this.resolveBackend(this.settings().backend)),
			engineLatest: () => ({ build: ENGINE_PIN }),
			hfToken: async () => (await this.secrets?.get(HF_TOKEN_KEY).then((t) => t, () => undefined)) ?? undefined,
			setHfToken: async (surface, token) => { await this.handle(surface, { type: 'hfToken', token: token ?? '' }); },
			openExternal: (target) => this.openExternal(target),
			saveImage: async (name) => {
				try {
					// eslint-disable-next-line @typescript-eslint/no-var-requires
					const vs = require('vscode') as typeof vscode;
					const folder = path.join(os.homedir(), 'Pictures');
					const uri = await vs.window.showSaveDialog({ defaultUri: vs.Uri.file(path.join(fs.existsSync(folder) ? folder : os.homedir(), name)), filters: { Image: ['png'] }, saveLabel: 'Save' });
					return uri?.fsPath;
				} catch {
					return undefined;
				}
			},
			clearMeasurements: async () => {
				const n = this.memento.get<ModelMeasurement[]>('zer0ne.local.measurements', []).length;
				await this.memento.update('zer0ne.local.measurements', []);
				return n;
			}
		});
	}

	private openExternal(target: string): void {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const vs = require('vscode') as typeof vscode;
			void vs.env.openExternal(/^https?:/i.test(target) ? vs.Uri.parse(target) : vs.Uri.file(target));
		} catch {
			/* no editor host (tests) */
		}
	}

	/** Models by category, the machine check and image / video generation (src/host/localCatalogHost.ts). */
	readonly catalog: LocalCatalogHost;

	/** Local models is Models Fit Studio's page; this answers it with zer0ne Engine (src/host/modelFitHost.ts). */
	readonly modelfit: ModelFitHost;
	/** Why the last download of a key ("hf:repo/file") stopped, for that page's download list. */
	private readonly downloadErrors = new Map<string, string>();

	/** Set by the chat controller: puts an approved picture / clip into the current chat. */
	mediaToChat?: (media: ChatMedia) => Promise<void>;

	/** Benchmark, live monitor, Local Host, private code search, idle unload (src/host/localPlus.ts). */
	readonly plus: LocalPlus;

	/** Code search on this computer (Settings → Local models → Private code search). */
	privateSearchTarget() {
		return this.plus.privateSearchTarget();
	}

	/** Hugging Face sign-in: our own token, else the Hugging Face provider's key. */
	private hf: { connected: boolean; user?: string; source?: 'token' | 'provider' } = { connected: false };
	private async loadHfToken(): Promise<string | undefined> {
		let token = await this.secrets?.get(HF_TOKEN_KEY).then((t) => t, () => undefined);
		let source: 'token' | 'provider' | undefined = token ? 'token' : undefined;
		if (!token) {
			const p = (await this.ctx.store.list().catch(() => [])).find((x) => x.preset === 'huggingface' && x.enabled);
			token = p ? await this.ctx.store.getApiKey(p.id).catch(() => undefined) : undefined;
			if (token) source = 'provider';
		}
		setHfToken(token);
		this.hf = { ...this.hf, connected: !!token, source };
		return token;
	}

	private get engineDir(): string {
		return path.join(this.storageDir, 'engine');
	}
	private get modelsDir(): string {
		return path.join(this.storageDir, 'models');
	}
	private get hfCacheDir(): string {
		return path.join(this.storageDir, 'hf-cache');
	}
	/** The last Hugging Face request found no network (Discover shows cached answers). */
	private offline = false;
	private settings(): EngineSettings {
		const saved = this.memento.get<Partial<EngineSettings> & { v?: number; gpuLayers?: number }>('zer0ne.engine', {});
		// v1 stored a fixed context / layer count — that is what failed on big models; start over on auto.
		const fresh = saved.v === 2 ? saved : { backend: saved.backend, lightKv: saved.lightKv, port: saved.port, gpu: saved.gpuLayers === 0 ? 'cpu' : 'auto' };
		const s = { backend: 'auto', context: 0, gpu: 'auto', lightKv: true, port: 8181, speedBoost: true, channel: 'tested', helperSlot: true, firstLoadTest: true, ...Object.fromEntries(Object.entries(fresh).filter(([, v]) => v !== undefined)) } as EngineSettings;
		// The catalogue rates models against the KV cache the engine really loads with.
		setEngineLightKv(s.lightKv);
		return s;
	}

	private async saveSettings(patch: Partial<EngineSettings>): Promise<void> {
		await this.memento.update('zer0ne.engine', { ...this.settings(), ...patch, v: 2 });
		setEngineLightKv(this.settings().lightKv);
	}

	/** The concrete backend to install for this device. */
	private resolveBackend(b: EngineSettings['backend']): Backend {
		return b === 'auto' ? autoBackend(/nvidia/i.test(this.machine().gpuName ?? '')) : b;
	}

	/** Engine options for this machine: context tier, fit margin and cache reserve from engineFit (raw detection —
	 *  llama.cpp's device list reports an integrated GPU's shared pool as dedicated memory, which would defeat the margin). */
	private engineOptions(): EngineOptions {
		const s = this.settings();
		const fit = engineFit(detectMachine());
		return {
			context: s.context > 0 ? s.context : fit.context,
			gpu: installedEngine(this.engineDir)?.backend === 'cpu' ? 'cpu' : s.gpu,
			lightKv: s.lightKv,
			port: s.port,
			fitMarginMiB: fit.fitMarginMiB,
			cacheRamMiB: fit.cacheRamMiB
		};
	}

	dispose(): void {
		this.disposed = true;
		this.tuning?.ctl.abort();
		this.testing?.ctl.abort();
		for (const j of this.jobs.values()) {
			j.ctl.abort();
		}
		this.plus.dispose();
		this.catalog.dispose();
		this.server.stop();
		this.helperServer.stop();
	}

	/** Machine budget, using the GPU llama.cpp actually sees (integrated GPUs share RAM through Vulkan). */
	private machine(refresh = false): Machine {
		const m = detectMachine(refresh);
		const dev = this.devices();
		if (!m.unifiedMemory && !m.gpuMemoryBytes && dev.bytes) {
			return machineCapacity({ ...m, gpuName: dev.gpuName ?? m.gpuName, gpuMemoryBytes: dev.bytes });
		}
		return m;
	}

	/** GPUs the installed engine sees (asynchronous; the page refreshes when it arrives). */
	private devices(): { gpuName?: string; bytes?: number } {
		if (this.devicesCache) {
			return this.devicesCache;
		}
		const eng = installedEngine(this.engineDir);
		if (!eng || eng.backend === 'cpu' || this.devicesLoading) {
			return {};
		}
		this.devicesLoading = true;
		void listDevices(eng.server).then((list) => {
			const best = list.sort((a, b) => b.freeMiB - a.freeMiB)[0];
			this.devicesCache = best ? { gpuName: best.name, bytes: best.totalMiB * 1048576, freeBytes: best.freeMiB * 1048576 } : {};
			this.devicesLoading = false;
			this.ctx.postAll({ type: 'engineState', engine: this.engineState() });
		});
		return {};
	}

	/** Report a problem: the engine's state without paths or model files. */
	diagnostics(): Record<string, unknown> {
		const e = this.engineState();
		return { installed: e.installed, version: e.version, backend: e.backend, pin: e.pin, channel: e.channel, previous: e.previous, proven: e.proven, running: e.running, model: e.model, run: e.run, helper: e.helper, crashes: e.crashes, lastCrash: e.lastCrash, gpu: e.devices?.gpuName, log: e.log || undefined, settings: e.settings };
	}

	private engineState() {
		const inst = installedEngine(this.engineDir);
		const s = this.settings();
		const crash = [this.server.lastCrash, this.helperServer.lastCrash].filter((c) => !!c).sort((a, b) => b!.at - a!.at)[0];
		return {
			installed: !!inst,
			version: inst?.version,
			backend: inst?.backend,
			pin: ENGINE_PIN,
			channel: s.channel,
			previous: inst?.previous ? { version: inst.previous.version, backend: inst.previous.backend } : undefined,
			proven: !!inst?.proven,
			helper: this.helperServer.model ? { model: this.helperServer.model, running: this.helperServer.running, ctx: this.helperServer.run?.ctx, port: s.port + 1 } : undefined,
			crashes: this.server.recentCrashes + this.helperServer.recentCrashes,
			lastCrash: crash,
			autoBackend: this.resolveBackend('auto'),
			running: this.server.running,
			model: this.server.model,
			run: this.server.run,
			tuning: this.tuning ? { stage: this.tuning.stage } : undefined,
			testing: this.testing ? { model: this.testing.model, stage: 'Measuring first response, speed and process RAM…' } : undefined,
			devices: this.devicesCache,
			settings: s,
			log: this.server.running ? '' : this.server.log.trim().split('\n').filter((l) => / E |error|failed/i.test(l)).slice(-4).join('\n')
		};
	}

	private async engineProvider(create: boolean) {
		const providers = await this.ctx.store.list();
		let p = providers.find((x) => x.preset === ENGINE_PRESET);
		const base = `http://127.0.0.1:${this.settings().port}/v1`;
		if (!p && create) {
			p = await this.ctx.store.add({ name: 'zer0ne Engine', baseUrl: base, apiFormat: 'openai', preset: ENGINE_PRESET, models: [] });
		} else if (p && p.baseUrl !== base) {
			p = await this.ctx.store.update(p.id, { baseUrl: base });
		}
		return p;
	}

	/** Turbo Fit per model: true / false when the user chose; missing = automatic. */
	private turboMap(): Record<string, boolean> {
		return this.memento.get<Record<string, boolean>>('zer0ne.turbo', {});
	}

	private turboPlan(model: { id: string; sizeBytes: number; path?: string; mmproj?: string }): TurboPlan {
		let projectorBytes = 0;
		if (model.mmproj) { try { projectorBytes = fs.statSync(model.mmproj).size; } catch { /* Load reports a missing projector. */ } }
		return planTurbo({ name: model.id, sizeBytes: model.sizeBytes, machine: this.machine(), projectorBytes, shape: model.path ? readModelShape(model.path) : undefined });
	}

	/**
	 * Is Turbo Fit on for this model? Automatic unless the user chose: on for
	 * MoE models that only fit with experts in RAM (the plan that clearly
	 * helps), off otherwise. A plan without flags (the model fits) never applies.
	 */
	private turboActive(model: { id: string; sizeBytes: number }, plan = this.turboPlan(model)): boolean {
		if (!plan.flags.length) return false;
		const chosen = this.turboMap()[model.id];
		return chosen ?? plan.tier === 'hybrid';
	}

	/** Engine options for one model: machine defaults + speed boost + its Turbo Fit plan. */
	private optionsFor(model: LocalGguf, freeMemoryBytes = os.freemem()): EngineOptions {
		const o = this.engineOptions();
		const shape = readModelShape(model.path);
		// Large prompt snapshots must not compete with weights on a busy or small machine.
		o.cacheRamMiB = Math.max(64, Math.min(o.cacheRamMiB, Math.floor(Math.max(0, freeMemoryBytes - this.machine().totalMemoryBytes * 0.08 - model.sizeBytes) / (1024 ** 2) * 0.04)));
		if (this.settings().context <= 0 && !shape.kvBytesPerToken) o.context = this.catalog.contextFor(model, o.context, o.lightKv);
		// The context asked for, before the fit narrows it to what fits right now.
		const requested = o.context;
		let projectorBytes = 0;
		if (model.mmproj) { try { projectorBytes = fs.statSync(model.mmproj).size; } catch { throw new Error('The vision projector file is missing. Download the model again.'); } }
		// The draft head is loaded beside the model and takes memory like the projector does.
		const draft = this.settings().speedBoost && o.gpu !== 'cpu' ? model.draft : undefined;
		let draftBytes = 0;
		if (draft) { try { draftBytes = fs.statSync(draft).size; } catch { /* Gone since the scan: the model loads alone. */ } }
		o.fit = fitModel({ name: model.id, sizeBytes: model.sizeBytes, projectorBytes: projectorBytes + draftBytes, machine: this.machine(), freeMemoryBytes, context: o.context, lightKv: o.lightKv, cpu: o.gpu === 'cpu', shape, cacheRamMiB: o.cacheRamMiB, turbo: this.turboMap()[model.id] === true, expertOffload: this.turboMap()[model.id],
			plainAttention: prefersPlainAttention(this.machine(), installedEngine(this.engineDir)?.backend, shape.arch) });
		o.context = o.fit.context;
		o.untuned = o.fit;
		o.tuneKey = this.tuningKey(model, o, requested);
		o.fit = applyTuning(o.fit, this.memento.get<Record<string, TuneResult>>('zer0ne.local.tuning', {})[o.tuneKey], this.machine().cores, kvMemoryOf(o.fit, model.sizeBytes, shape));
		const extra: string[] = [];
		if (this.settings().speedBoost) {
			// Long n-gram drafts only (8–48 tokens): +43% tok/s rewriting code on an Arc iGPU, ~no cost otherwise.
			// A draft head guesses the next tokens for the model to confirm: on the same chip Gemma 4 E4B wrote
			// 21 tok/s alone and 29 (prose) to 47 (rewriting code) with its head. Both kinds work together.
			// A build with those layers inside drafts for itself: Qwen3.5 2B wrote code at 36 tok/s unasked and 43 asked.
			const inside = !draftBytes && o.gpu !== 'cpu' && !!shape.mtp;
			extra.push('--spec-type', draftBytes || inside ? 'draft-mtp,ngram-mod' : 'ngram-mod', '--spec-ngram-mod-n-min', '8', '--spec-ngram-mod-n-max', '48');
			if (draftBytes) extra.push('--spec-draft-model', draft!);
		}
		return { ...o, extra };
	}

	private tuning?: { ctl: AbortController; done: Promise<void>; stage: string };
	private disposed = false;
	/**
	 * The key a saved tuning is stored under.
	 *
	 * Only stable facts belong in it: the model, the machine, the engine build and
	 * the settings the tuning was measured with. The plan's own numbers (its
	 * context, cache type, flash attention, expert split) move with the memory
	 * that happens to be free — the very memory that differs between measuring and
	 * applying — so a saved tuning would silently stop applying. The plan is
	 * therefore priced against the whole machine, not against what is free now.
	 */
	private tuningKey(model: LocalGguf, o: EngineOptions, requestedContext: number): string {
		const m = this.machine(), inst = installedEngine(this.engineDir);
		let mtime = 0;
		try { mtime = fs.statSync(model.path).mtimeMs; } catch { /* A missing file cannot be tuned. */ }
		const shape = readModelShape(model.path);
		const stable = fitModel({ name: model.id, sizeBytes: model.sizeBytes, machine: m, freeMemoryBytes: m.totalMemoryBytes, context: requestedContext, lightKv: o.lightKv, cpu: o.gpu === 'cpu', shape, turbo: this.turboMap()[model.id] === true,
			plainAttention: prefersPlainAttention(m, inst?.backend, shape.arch) });
		return tuneKey([3, model.path, model.sizeBytes, mtime, m.platform, m.cpu, m.cores, m.totalMemoryBytes, m.gpuName, m.gpuMemoryBytes, inst?.version, inst?.backend, stable.context, stable.kv, stable.flash, o.gpu, stable.cpuExpertLayers, this.settings().speedBoost, !!model.draft, !!model.mtp]);
	}

	private async tune(surface: HostSurface): Promise<void> {
		if (this.tuning) return;
		const model = scanGguf(this.modelsDir).find((m) => m.id === this.server.model);
		const eng = installedEngine(this.engineDir);
		if (!model || !eng || !this.server.run) { this.ctx.status('Load a model before tuning its speed.', 'error'); return; }
		const ctl = new AbortController();
		let release!: () => void;
		this.tuning = { ctl, done: new Promise<void>((resolve) => { release = resolve; }), stage: 'Checking whether the engine is idle…' };
		const stage = (text: string) => { if (this.tuning) this.tuning.stage = text; this.ctx.postAll({ type: 'engineState', engine: this.engineState() }); };
		let original: EngineOptions | undefined;
		let started = false;
		try {
			for (const port of [this.settings().port, ...(this.helperServer.running ? [this.settings().port + 1] : [])]) {
				const res = await fetch(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(5000) });
				if (!res.ok) throw new Error('Cannot check the engine slots.');
				const slots = await res.json() as Array<{ is_processing?: boolean }>;
				if (!Array.isArray(slots) || slots.some((s) => s.is_processing)) throw new Error('Wait for the current response to finish before tuning.');
			}
			this.plus.touch();
			original = this.optionsFor(model, Math.min(this.machine().totalMemoryBytes, os.freemem() + (this.server.run.fit?.memoryBytes ?? model.sizeBytes)));
			const options = original;
			// Tuning starts from the automatic plan, not from an earlier tuning, so what it stores is what it measured.
			const plan = options.untuned ?? options.fit!;
			const gpu = options.gpu !== 'cpu' && !!this.machine().gpuName;
			// The other attention mode is worth a load only when its cache fits at this context.
			const sizeOf = (f?: string) => { try { return f ? fs.statSync(f).size : 0; } catch { return 0; } };
			const full = fitModel({ name: model.id, sizeBytes: model.sizeBytes, projectorBytes: sizeOf(model.mmproj) + sizeOf(model.draft), machine: this.machine(), freeMemoryBytes: Math.min(this.machine().totalMemoryBytes, os.freemem() + (this.server.run.fit?.memoryBytes ?? model.sizeBytes)), context: plan.context, lightKv: false, shape: readModelShape(model.path), cacheRamMiB: options.cacheRamMiB });
			const attention = !gpu ? undefined : plan.flash === false ? { kv: 'q8_0' as const, flash: true } : full.fits && full.context === plan.context && full.memoryBytes <= this.machine().fastBudgetBytes ? { kv: 'f16' as const, flash: false } : undefined;
			// A long prompt is where settings differ: about 6,000 tokens, or what the window leaves.
			const depth = Math.max(840, Math.min(6000, Math.floor((this.server.run.ctx ?? plan.context) * 0.6)));
			const result = await tuneModel(plan, {
				stage, signal: ctl.signal,
				other: { attention, cpuThreads: gpu ? Math.max(1, Math.ceil(this.machine().cores / 2)) : undefined },
				start: async (config) => {
					ctl.signal.throwIfAborted(); started = true;
					this.server.stop();
					await this.loadInto(this.server, eng, model, { ...options, fit: { ...plan, ...config, flash: config.flash === false ? false : undefined, cpuExpertLayers: config.cpu ? 0 : plan.cpuExpertLayers } }, ctl.signal);
					if (this.server.run?.attempt) throw new Error('Settings required a memory fallback; keep the automatic fit.');
				},
				probe: () => probeModelSpeed(`http://127.0.0.1:${options.port}`, model.id, AbortSignal.any([ctl.signal, AbortSignal.timeout(240_000)]), depth)
			});
			const all = this.memento.get<Record<string, TuneResult>>('zer0ne.local.tuning', {});
			all[options.tuneKey ?? this.tuningKey(model, options, options.context)] = result;
			await this.memento.update('zer0ne.local.tuning', Object.fromEntries(Object.entries(all).slice(-64)));
			await this.memento.update('zer0ne.local.measurements', this.memento.get<ModelMeasurement[]>('zer0ne.local.measurements', []).filter(r => r.model !== model.id));
			this.ctx.status(result.gain > 1 ? `Tuning saved: ${result.kept} is ${(result.gain * 100 - 100).toFixed(0)}% faster on a long code prompt · reads ${Math.round(result.speed.promptTokS)} tok/s, writes ${result.speed.tokS.toFixed(1)}.` : `Automatic settings kept · reads ${Math.round(result.speed.promptTokS)} tok/s, writes ${result.speed.tokS.toFixed(1)}. Nothing else was reliably faster.`);
		} catch (e) {
			let restored = !started;
			if (started && original && !this.disposed) {
				this.server.stop();
				restored = await this.loadInto(this.server, installedEngine(this.engineDir) ?? eng, model, original).then(() => true, () => false);
			}
			this.ctx.status(ctl.signal.aborted ? `Speed tuning cancelled${restored ? '; previous settings restored.' : '; load the model again.'}` : `Speed tuning stopped: ${e instanceof Error ? e.message : String(e)}${restored ? '' : ' Load the model again.'}`, 'error');
		} finally {
			this.tuning = undefined; release(); await this.snapshot(surface);
		}
	}

	/**
	 * Measured generation speed per model (tokens/s after the first token),
	 * a moving average over real chats — shown instead of the estimate once
	 * known, so "≈" becomes a number this machine actually did.
	 */
	recordSpeed(modelId: string, tokS: number): void {
		if (!(tokS > 0.2 && tokS < 5000)) return;
		const all = this.memento.get<Record<string, { tokS: number; n: number; at: number }>>(SPEED_KEY, {});
		const prev = all[modelId];
		const tok = prev ? prev.tokS * 0.7 + tokS * 0.3 : tokS;
		all[modelId] = { tokS: Math.round(tok * 10) / 10, n: Math.min(99, (prev?.n ?? 0) + 1), at: Date.now() };
		void this.memento.update(SPEED_KEY, all);
	}

	private speeds(): Record<string, { tokS: number; n: number; at: number }> {
		return this.memento.get(SPEED_KEY, {});
	}
	private testing?: { ctl: AbortController; done: Promise<void>; model: string };
	private measurementSettings(): string {
		const s = this.settings(), e = installedEngine(this.engineDir);
		return experienceKey([e?.version, e?.backend, s.context, s.gpu, s.lightKv, s.speedBoost]);
	}
	private modelMeasurements() {
		const records = this.memento.get<ModelMeasurement[]>('zer0ne.local.measurements', []), hardware = hardwareKey(this.machine()), settings = this.measurementSettings();
		return scanGguf(this.modelsDir).map(g => currentMeasurement(records, g, hardware, settings)).filter((r): r is ModelMeasurement => !!r);
	}
	private async waitForTest(signal?: AbortSignal): Promise<void> {
		if (!this.testing) return;
		signal?.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const abort = () => reject(signal?.reason ?? new Error('Cancelled'));
			signal?.addEventListener('abort', abort, { once: true });
			this.testing!.done.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
		});
	}
	private async testLoaded(slot: EngineServer, model: LocalGguf, signal?: AbortSignal, force = false): Promise<void> {
		await this.waitForTest(signal);
		if (this.testing) { await this.waitForTest(signal); return this.testLoaded(slot, model, signal, force); }
		if (this.disposed || !slot.running || slot.model !== model.id || this.tuning || (!force && !this.settings().firstLoadTest)) return;
		const records = this.memento.get<ModelMeasurement[]>('zer0ne.local.measurements', []), hardware = hardwareKey(this.machine()), settings = this.measurementSettings();
		const run = slot.run, eng = installedEngine(this.engineDir);
		if (!run || !eng) return;
		const stamp = modelStamp(model), key = experienceKey([hardware, settings, stamp, run.ctx, run.gpu, run.fit?.threads, run.fit?.ubatch, run.fit?.kv, run.fit?.cpuExpertLayers, run.cacheFallback]);
		if (!force && currentMeasurement(records.filter(r => r.key === key), model, hardware, settings)) return;
		const ctl = new AbortController(), probeSignal = AbortSignal.any([ctl.signal, AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]); let release!: () => void;
		this.testing = { ctl, done: new Promise<void>(r => { release = r; }), model: model.id };
		this.ctx.status(`Checking ${model.id}'s local speed — up to 45 seconds. The check can be cancelled from Local models.`);
		this.ctx.postAll({ type: 'engineState', engine: this.engineState() });
		const result: ModelMeasurement = { key, hardware, settings, stamp, model: model.id, repo: model.repo, file: path.basename(model.path), quant: model.quant,
			bytes: model.sizeBytes, at: Date.now(), context: run.ctx, engine: eng.version, backend: run.gpu === 'cpu' ? 'cpu' : eng.backend, status: 'incomplete' };
		try {
			try {
				const slots = await fetch(this.baseOf(slot).replace(/\/v1$/, '/slots'), { signal: AbortSignal.any([probeSignal, AbortSignal.timeout(3000)]) }).then(r => r.ok ? r.json() : undefined) as Array<{ is_processing?: boolean }> | undefined;
				if (!Array.isArray(slots)) throw new Error('The engine could not confirm it was idle for a speed check.');
				if (slots.some(s => s.is_processing)) { this.ctx.status('Wait for the current response to finish before checking speed.'); return; }
				Object.assign(result, await measureLocalModel(this.baseOf(slot).replace(/\/v1$/, ''), probeSignal, slot.pid), { status: 'measured' });
			} catch (e) {
				if (this.disposed) return;
				if (ctl.signal.aborted || signal?.aborted) result.status = 'cancelled';
				else result.error = e instanceof Error ? e.message.slice(0, 200) : 'Speed check incomplete';
			}
			if (slot.model !== model.id || !slot.running || stamp !== modelStamp(model) || settings !== this.measurementSettings() || hardware !== hardwareKey(this.machine())) return;
			const latest = this.memento.get<ModelMeasurement[]>('zer0ne.local.measurements', []);
			await this.memento.update('zer0ne.local.measurements', [...latest.filter(r => r.key !== key), result].slice(-128));
			this.ctx.postAll({ type: 'modelMeasurement', measurement: result });
			this.ctx.status(result.status === 'measured' ? `${model.id}: ${result.tokS} tok/s measured · first token ${result.ttftMs} ms.` : `${model.id} loaded; its speed check was ${result.status === 'cancelled' ? 'cancelled' : 'incomplete'}. You can test again from My models.`);
		} finally {
			this.testing = undefined; release();
			this.ctx.postAll({ type: 'engineState', engine: this.engineState() });
		}
	}

	/**
	 * Before a chat request to the engine: load that model and return the base
	 * URL of the server that has it. Two slots: the local helper model (hybrid
	 * routing) loads beside the chat model on port + 1 when both fit in memory,
	 * so compaction or a subagent never unloads the chat model. `only: 'main'`
	 * (benchmark, Local Host, private search) always uses the main port.
	 */
	async ensureLoaded(modelId: string, signal?: AbortSignal, only?: 'main'): Promise<string> {
		await this.waitForTest(signal);
		if (this.tuning) await this.tuning.done;
		signal?.throwIfAborted();
		this.plus?.touch();
		let eng = installedEngine(this.engineDir);
		if (!eng) {
			const surface: HostSurface = { kind: 'local', post: message => this.ctx.postAll(message) };
			await this.install(surface, this.resolveBackend(this.settings().backend));
			signal?.throwIfAborted();
			eng = installedEngine(this.engineDir);
			if (!eng) throw new Error('Automatic engine setup did not complete. See Local models → Runtimes for details.');
		}
		const models = scanGguf(this.modelsDir);
		const model = models.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`No runnable standalone model file was found for "${modelId}". It may be missing, incomplete, or a helper that requires its matching main model. Check Settings → Local models.`);
		}
		if (this.server.running && this.server.model === modelId) {
			await this.testLoaded(this.server, model, signal);
			signal?.throwIfAborted();
			return this.baseOf(this.server);
		}
		if (!only && this.helperServer.running && this.helperServer.model === modelId) {
			await this.testLoaded(this.helperServer, model, signal);
			signal?.throwIfAborted();
			return this.baseOf(this.helperServer);
		}
		const beside = (other?: string) => {
			const o = other ? models.find((m) => m.id === other) : undefined;
			// Both models, their caches and the OS margin inside the fast budget.
			if (!o) return false;
			const main = this.optionsFor(o, this.machine().totalMemoryBytes).fit!;
			const next = this.optionsFor(model, this.machine().totalMemoryBytes).fit!;
			return main.fits && next.fits && main.memoryBytes + next.memoryBytes <= this.machine().fastBudgetBytes;
		};
		const helper = !only && this.settings().helperSlot !== false && this.server.running && (await this.isHelperModel(modelId)) && beside(this.server.model);
		const slot = helper ? this.helperServer : this.server;
		// The chat model always takes the main slot; the helper stays beside it only while both fit.
		if (!helper && this.helperServer.model && !beside(this.helperServer.model)) {
			this.helperServer.stop();
		}
		this.ctx.status(`Loading ${modelId}${helper ? ' beside the chat model' : ''} — fitting it to this machine's memory…`, '');
		// Include memory released by the slot being replaced; a helper still running is excluded.
		const replaced = slot.model ? models.find((m) => m.id === slot.model) : undefined;
		const reclaim = slot.running ? slot.run?.fit?.memoryBytes ?? (replaced?.sizeBytes ?? 0) : 0;
		const freeMemory = Math.min(this.machine().totalMemoryBytes, os.freemem() + reclaim);
		const opts = helper ? this.helperOptions(model, freeMemory) : this.optionsFor(model, freeMemory);
		if (model.sizeBytes + (model.mmproj ? fs.statSync(model.mmproj).size : 0) > opts.fit!.budgetBytes) {
			throw new Error('This model exceeds the memory available now. Close other applications or choose a smaller quantisation or model.');
		}
		await this.loadInto(slot, eng, model, opts, signal);
		await this.testLoaded(slot, model, signal);
		signal?.throwIfAborted();
		const run = slot.run;
		// Tell the chat the real window llama.cpp gave the model.
		const p = await this.engineProvider(false);
		if (p && run?.ctx && !helper) {
			await this.ctx.store.update(p.id, { models: p.models.map((m) => (m.id === modelId ? { ...m, contextWindow: run.ctx } : m)) });
		}
		this.ctx.status(`${modelId} is loaded${helper ? ' as the helper, beside the chat model' : ''}${run?.ctx ? ` · ${Math.round(run.ctx / 1024)}K context` : ''}${run?.gpu === 'cpu' ? ' · on the CPU' : ''}${run && run.attempt ? ' (reduced to fit memory)' : ''}.`);
		return this.baseOf(slot);
	}

	private baseOf(slot: EngineServer): string {
		return `http://127.0.0.1:${this.settings().port + (slot === this.helperServer ? 1 : 0)}/v1`;
	}

	/** Is this engine model the one picked as the local helper (Settings → Local models → hybrid routing)? */
	private async isHelperModel(modelId: string): Promise<boolean> {
		const [pid, mid] = String(this.ctx.store.getSettings().localHelper || '').split('::');
		if (mid !== modelId) return false;
		return (await this.engineProvider(false))?.id === pid;
	}

	/** The helper slot: its own port, a 16K window and a light cache — helper prompts are short. */
	private helperOptions(model: LocalGguf, freeMemoryBytes = os.freemem()): EngineOptions {
		const o = this.optionsFor(model, freeMemoryBytes);
		const fit = { ...o.fit!, context: Math.min(o.context, 16_384) };
		return { ...o, fit, port: o.port + 1, context: fit.context };
	}

	/** Load into a slot. A fresh engine build that cannot load a model rolls back to the kept build (once). */
	private async loadInto(slot: EngineServer, eng: EngineInstall, model: LocalGguf, opts: EngineOptions, signal?: AbortSignal): Promise<void> {
		try {
			await slot.ensure(eng.server, model, opts, signal);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (signal?.aborted || eng.proven || !eng.previous || /does not fit|already used by another|Cancelled/i.test(msg)) throw e;
			const back = rollbackEngine(this.engineDir);
			if (!back) throw e;
			this.ctx.status(`zer0ne Engine ${eng.version} could not load ${model.id} (${msg.slice(0, 140)}) — rolled back to ${back.version}, the build that worked before.`, 'error');
			await slot.ensure(back.server, model, opts, signal);
			return;
		}
		markEngineProven(this.engineDir, eng.server);
	}

	/**
	 * A request to the engine failed: did the engine serving `modelId` crash
	 * under it? Then the chat restarts it and retries once — unless it keeps
	 * crashing (3 times in 30 minutes), which needs the user's decision.
	 */
	async engineCrash(modelId: string, err: unknown): Promise<{ restart: boolean; message: string } | undefined> {
		const msg = err instanceof Error ? err.message : String(err);
		if (!/Could not reach|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|terminated|other side closed|UND_ERR/i.test(msg)) return undefined;
		const slot = [this.server, this.helperServer].find((s) => s.model === modelId);
		if (!slot) return undefined;
		// The process exit can land a second after the broken connection (Windows, GPU teardown: 1.2 s measured).
		for (let i = 0; i < 30 && slot.running; i++) await new Promise((r) => setTimeout(r, 100));
		if (slot.running) {
			if (await slot.healthy(this.settings().port + (slot === this.helperServer ? 1 : 0))) return undefined; // alive: a different failure
			slot.abandon(); // hung: clear it so the restart starts a fresh process
		}
		const detail = slot.lastCrash?.detail ? ` (${slot.lastCrash.detail})` : '';
		if (slot.recentCrashes >= 3) {
			return { restart: false, message: `zer0ne Engine crashed ${slot.recentCrashes} times in 30 minutes running ${modelId}${detail}. It is not restarted by itself again: try "CPU only" or a smaller quantisation under Local models → Engine${installedEngine(this.engineDir)?.previous ? ', or switch back to the previous engine build there' : ''}.` };
		}
		return { restart: true, message: `zer0ne Engine stopped unexpectedly${detail} — restarting ${modelId} and trying again…` };
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		await this.hfReady;
		if (msg.type === 'engineTestCancel') { this.testing?.ctl.abort(); return true; }
		if (msg.type === 'engineTest') {
			if (this.testing || this.tuning) return true;
			const model = scanGguf(this.modelsDir).find(g => g.id === this.server.model);
			if (model) void this.testLoaded(this.server, model, undefined, true).then(() => this.snapshot(surface), e => this.ctx.status(String(e), 'error'));
			return true;
		}
		if (this.testing && ['engineOptions', 'engineInstall', 'engineRollback', 'engineStop', 'turboToggle', 'ggufRemove', 'catalogRemove', 'localBench', 'localQuality', 'hfConvert', 'engineTune'].includes(msg.type)) {
			this.ctx.status('Finish or cancel the first-load check before changing the engine.', 'error'); return true;
		}
		if (msg.type === 'engineTuneCancel') { this.tuning?.ctl.abort(); return true; }
		if (msg.type === 'engineTune') { void this.tune(surface); return true; }
		if (this.tuning && ['engineOptions', 'engineInstall', 'engineRollback', 'engineStop', 'turboToggle', 'ggufRemove', 'catalogRemove', 'localBench', 'localQuality', 'hfConvert'].includes(msg.type)) {
			this.ctx.status('Finish or cancel speed tuning before changing the engine.', 'error');
			return true;
		}
		if (await this.modelfit?.handle(surface, msg)) return true;
		if (await this.plus.handle(surface, msg)) return true;
		if (await this.catalog.handle(surface, msg)) return true;
		switch (msg.type) {
			case 'setupStatus':
				this.setupStatus(surface);
				return true;
			case 'setupPlan':
				this.setupPlan(surface);
				return true;
			case 'setupInstall':
				void this.setupInstall(surface, String(msg.id ?? ''));
				return true;
			case 'setupDone':
				await this.setupDone(surface, msg.firstTask);
				return true;
			case 'setupConsumed':
				await this.setupConsumed(surface);
				return true;
			case 'localModels':
				await this.snapshot(surface, msg.refresh === true);
				this.plus.post();
				return true;
			case 'hfSearch': {
				const machine = this.machine();
				try {
					const query = String(msg.query ?? '').trim(), repo = hfRepoFromInput(query);
					if (/^https?:\/\//i.test(query) && !repo) throw new Error('Paste a Hugging Face model-page link (https://huggingface.co/owner/model).');
					const format = ['gguf', 'llm', 'vision', 'any'].includes(msg.format) ? msg.format : 'gguf';
					const size = msg.size && typeof msg.size === 'object' ? { min: Number(msg.size.min) || 0, max: Number(msg.size.max) || 0 } : undefined;
					// Offline mode: the last answer for this search is kept on disk and served when the network is gone.
					const got = await hfCached(this.hfCacheDir, `search-v2|${format}|${msg.sort || 'downloads'}|${query}|${JSON.stringify(size ?? {})}|${msg.cursor || ''}`, async () => repo ? { items: [await this.catalog.discovery.info(repo)], cursor: undefined as string | undefined } : searchHfPage(query, msg.sort || 'downloads', 40, format, size, typeof msg.cursor === 'string' ? msg.cursor : undefined), 120_000, true);
					const items = repo ? got.value.items : hubSearchModels(this.catalog.discovery.current(), got.value.items, query, format, size, !!msg.cursor, msg.sort || 'downloads');
					this.offline = !!got.offline;
					const profile = this.catalog.modelProfile();
					const support = await this.catalog.discovery.support();
					const measurements = this.modelMeasurements();
					const rated = items.map(m => {
						const seed = this.catalog.discovery.find(m.id), r = rateHubSearch(m, seed, profile, support, { lightKv: this.settings().lightKv });
						const file = seed ? fitHubFiles(m, seed.files ?? [], profile, seed, support, undefined, { lightKv: this.settings().lightKv }).find(f => 'recommended' in f && f.recommended) : undefined;
						const measurement = file ? measurements.find(v => v.repo?.toLowerCase() === m.id.toLowerCase() && v.file === file.name && v.bytes === file.sizeBytes) : undefined;
						const runtimeReason = m.format === 'gguf' ? architectureReason(m.arch, support) : undefined;
						return { ...m, ...r, selectedFile: file?.name, measurement, compatibility: m.format === 'gguf' ? modelStatus({ id: m.id, rating: r.rating, measurement, runtimeReason }, profile.diskBytes) : 'GGUF build needed', turbo: m.params ? planTurbo({ name: m.id, sizeBytes: m.params * 0.6, params: m.params, machine }) : undefined };
					});
					surface.post({ type: 'hfResults', query: msg.query ?? '', rid: msg.rid, format, exact: !!repo, cursor: got.value.cursor, append: !!msg.cursor, offline: got.offline || (repo && this.catalog.discovery.offline), cachedAt: got.cachedAt, items: groupHubModels(rated) });
				} catch (e) {
					surface.post({ type: 'hfResults', query: msg.query ?? '', rid: msg.rid, append: !!msg.cursor, items: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'hfFiles': {
				try {
					if (!validRepoId(msg.id)) throw new Error('That is not a Hugging Face model id (owner/name).');
					const info = await this.catalog.discovery.info(String(msg.id));
					const files = await this.catalog.discovery.files(String(msg.id), info);
					this.offline = this.catalog.discovery.offline;
					const have = new Set(scanGguf(this.modelsDir).map((g) => g.id));
					// No GGUF here (safetensors, MLX…): GGUF builds of the same model — tagged, or found by
					// name (quantizers like mradermacher often skip the tag) — and the local converter.
					let builds: Array<{ id: string; downloads: number; likes: number; exact?: boolean }> = [];
					let convert: { python?: string; ready: boolean; bytes?: number; problem?: string; quant?: string } | undefined;
					if (!files.some((f) => !f.mmproj)) {
						const [found, tree] = await Promise.all([this.catalog.discovery.builds(String(msg.id)), hfTree(String(msg.id)).catch(() => [])]);
						builds = found;
						const plan = convertFiles(tree);
						convert = { python: findPython()?.version, ready: this.converter.status().ready, bytes: plan.bytes, problem: plan.problem, quant: convertQuant(Number(msg.params) || undefined) };
					}
					const rated = fitHubFiles(info, files, this.catalog.modelProfile(), this.catalog.discovery.find(info.id), await this.catalog.discovery.support(), undefined, { lightKv: this.settings().lightKv });
					const measurements = this.modelMeasurements();
					surface.post({ type: 'hfFiles', id: msg.id, model: info, builds, convert, offline: this.offline, files: rated.map(f => ({ ...f, installed: have.has(f.name.replace(/\.gguf$/i, '')), measurement: measurements.find(r => r.repo?.toLowerCase() === info.id.toLowerCase() && r.file === f.name && r.bytes === f.sizeBytes) })) });
				} catch (e) {
					surface.post({ type: 'hfFiles', id: msg.id, files: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'hfCard': {
				const id = String(msg.id);
				if (!validRepoId(id)) return true;
				const card = await hfCached(this.hfCacheDir, `card|${id}`, () => hfCard(id), 3600_000, true).then((r) => r.value, () => undefined);
				// Gated: check whether this account can already download (after accepting the terms).
				let access: 'ok' | number | undefined;
				if (card?.gated && typeof msg.file === 'string') access = await hfAccess(id, msg.file).catch(() => undefined);
				surface.post({ type: 'hfCard', id, card: card ? { ...card, access } : null, hf: this.hf });
				return true;
			}
			case 'hfToken': {
				const token = String(msg.token ?? '').trim();
				if (!this.secrets) return true;
				if (!token) {
					await this.secrets.delete(HF_TOKEN_KEY);
					this.hf = { connected: false };
					await this.loadHfToken();
					this.ctx.status('Hugging Face token removed.');
				} else {
					let who: { name: string } | null;
					try { who = await hfWhoAmI(token); } catch (e) {
						this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
						return true;
					}
					if (!who) {
						this.ctx.status('Hugging Face did not accept that token. Create a "Read" token at huggingface.co/settings/tokens.', 'error');
						surface.post({ type: 'hfCard', id: msg.id ?? '', card: null, hf: this.hf, tokenError: true });
						return true;
					}
					await this.secrets.store(HF_TOKEN_KEY, token);
					await this.loadHfToken();
					this.hf.user = who.name;
					this.ctx.status(`Connected to Hugging Face as ${who.name}.`);
				}
				await this.snapshot(surface);
				return true;
			}
			case 'localChat':
				await this.chatWith(surface, String(msg.id));
				return true;
			case 'hfConvert':
				if (!validRepoId(msg.id)) return true;
				void this.hfConvert(surface, String(msg.id), Number(msg.params) || undefined);
				return true;
			case 'hfDownload':
				// The id becomes a folder and the parts become URLs: only well-formed ones get through.
				if (!validRepoId(msg.id) || (msg.target !== 'ollama' && !safeGgufParts(msg.file?.parts))) {
					this.ctx.status('That download request was not valid — refresh the model and try again.', 'error');
					return true;
				}
				void this.hfDownload(surface, String(msg.id), msg.file as { name: string; parts: string[]; sizeBytes: number; quant: string }, msg.target === 'ollama' ? 'ollama' : 'engine');
				return true;
			case 'jobCancel':
				this.jobs.get(String(msg.key))?.ctl.abort();
				return true;
			case 'engineInstall': {
				const asked = sanitizeEngineSettings({ backend: msg.backend }).backend as EngineSettings['backend'] | undefined;
				void this.install(surface, this.resolveBackend(asked || this.settings().backend));
				return true;
			}
			case 'lmsList':
				try {
					surface.post({ type: 'lmsModels', items: await lmsModels() });
				} catch (e) {
					surface.post({ type: 'lmsModels', items: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			case 'lmsLoad': {
				const key = String(msg.key ?? '');
				this.ctx.status(`LM Studio is loading ${key}…`, '');
				try {
					await lmsLoad(key);
					await this.useOllama(key, 'http://127.0.0.1:1234/v1');
				} catch (e) {
					this.ctx.status(`LM Studio could not load ${key}: ${e instanceof Error ? e.message : String(e)}`, 'error');
				}
				surface.post({ type: 'lmsModels', items: await lmsModels().catch(() => []) });
				await this.snapshot(surface);
				return true;
			}
			case 'lmsUnload':
				await lmsUnload(msg.key ? String(msg.key) : undefined).catch((e) => this.ctx.status(String(e.message ?? e), 'error'));
				surface.post({ type: 'lmsModels', items: await lmsModels().catch(() => []) });
				return true;
			case 'engineOptions': {
				const patch = sanitizeEngineSettings(msg.patch) as Partial<EngineSettings>;
					const onlyPolicy = Object.keys(patch).every((k) => k === 'channel' || k === 'helperSlot' || k === 'firstLoadTest');
				await this.saveSettings(patch);
				if (patch.helperSlot === false) this.helperServer.stop();
				if (!onlyPolicy) {
					// Takes effect on the next load.
					this.server.stop();
					this.helperServer.stop();
				}
				await this.engineProvider(false);
				await this.snapshot(surface);
				return true;
			}
			case 'engineRollback': {
				const back = rollbackEngine(this.engineDir);
				if (back) {
					this.server.stop();
					this.helperServer.stop();
					this.devicesCache = undefined;
					this.ctx.status(`zer0ne Engine switched to ${back.version} (${back.backend}). ${back.previous?.version ?? 'The other build'} is kept — switch back the same way.`);
				}
				await this.snapshot(surface);
				return true;
			}
			case 'engineLoad':
				try {
					await this.ensureLoaded(String(msg.id), undefined, 'main');
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
					surface.post({ type: 'engineError', error: e instanceof Error ? e.message : String(e) });
				}
				await this.snapshot(surface);
				return true;
			case 'engineStateGet':
				// The chat asks once on load: model menu badges and the first-run check.
				surface.post({ type: 'engineState', engine: this.engineState() });
				return true;
			case 'engineStop':
				this.server.stop();
				this.helperServer.stop();
				await this.snapshot(surface);
				return true;
			case 'turboToggle': {
				const map = { ...this.turboMap(), [String(msg.id)]: msg.on === true };
				await this.memento.update('zer0ne.turbo', map);
				if (this.server.running && this.server.model === msg.id) {
					this.server.stop(); // reloads with the new plan on the next message
				}
				this.ctx.status(msg.on ? `Turbo Fit on for ${msg.id} — it loads with the plan on the next message.` : `Turbo Fit off for ${msg.id}.`);
				await this.snapshot(surface);
				return true;
			}
			case 'modelToggle':
				await this.toggle(String(msg.id), String(msg.source), msg.enabled === true);
				await this.snapshot(surface);
				return true;
			case 'ggufRemove':
				this.removeGguf(String(msg.id));
				await this.snapshot(surface);
				return true;
			// ---- Ollama (unchanged behaviour)
			case 'localStart': {
				try { await this.ollamaReady(surface); this.ctx.status('Ollama is running.'); }
				catch (e) { this.ctx.status(e instanceof Error ? e.message : String(e), 'error'); }
				await this.snapshot(surface);
				return true;
			}
			case 'localInspect': {
				const tag = String(msg.tag ?? '').trim();
				const info = TAG.test(tag) ? await inspectTag(tag, this.machine()) : undefined;
				surface.post({ type: 'localInspect', tag, info: info ?? null, advice: info ? fitAdvice(tag, info.sizeGb, this.machine()) : 'Not found in the Ollama library (check the name and tag).' });
				return true;
			}
			case 'localPull':
				void this.ollamaPull(surface, String(msg.tag ?? '').trim());
				return true;
			case 'localCancel':
				this.jobs.get('ollama:' + String(msg.tag))?.ctl.abort();
				return true;
			case 'localRemove': {
				try {
					await removeModel(String(msg.tag ?? ''));
					this.ctx.status(`Removed ${msg.tag}.`);
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
				}
				await this.snapshot(surface);
				return true;
			}
			case 'localUse':
				await this.useOllama(String(msg.tag ?? ''), msg.server as string | undefined);
				return true;
		}
		return false;
	}

	/** One click from a downloaded model to chatting with it: in the picker, selected, loading, chat open. */
	private async chatWith(surface: HostSurface, id: string): Promise<void> {
		await this.ensureLoaded(id);
		await this.toggle(id, 'zer0ne', true);
		const p = await this.engineProvider(true);
		if (p) await this.ctx.store.setSelection(p.id, id);
		await this.ctx.sendState();
		this.focusChat?.();
		this.ctx.status(`Ready to chat with ${id}.`);
		await this.snapshot(surface);
	}

	/**
	 * Delete a downloaded GGUF model: ours, or one in LM Studio's or Models Fit Studio's folder
	 * (the page warns that the other app loses it too). Only that model's own files — a sibling quant sharing a name prefix stays;
	 * the last model in a folder takes its vision projector along. Returns whether something was deleted.
	 */
	removeGguf(id: string): boolean {
		const g = scanGguf(this.modelsDir).find((x) => x.id === id);
		if (!g) return false;
		if (this.server.model === g.id) this.server.stop();
		if (this.helperServer.model === g.id) this.helperServer.stop();
		const dir = path.dirname(g.path);
		for (const f of ggufFiles(g.path, fs.readdirSync(dir))) fs.rmSync(f, { force: true });
		const left = fs.readdirSync(dir);
		if (!left.some((f) => /\.gguf(\.part)?$/i.test(f) && !/mmproj/i.test(f))) {
			for (const f of left.filter((x) => /mmproj.*\.gguf$/i.test(x))) fs.rmSync(path.join(dir, f), { force: true });
			// Empty folders go only inside our own models folder; another app's tree is left as it is.
			for (let d = dir; d.startsWith(this.modelsDir + path.sep) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
		}
		void this.toggle(g.id, 'zer0ne', false);
		this.ctx.status(`Deleted ${g.id}.`);
		return true;
	}

	/**
	 * First-run setup: the Fast / Balanced / Quality models this machine can
	 * run, the same rule the catalog and Models Fit Studio use. No network: the
	 * catalog is bundled and the machine profile is local.
	 */
	private planPicks(): SetupPick[] {
		const profile = this.catalog.modelProfile();
		const installed = new Map(scanGguf(this.modelsDir).filter((g) => g.repo).map((g) => [g.repo!.toLowerCase(), g.id]));
		return setupPicks(catalogFor('coding', profile, { strict: false, cores: this.machine().cores }), installed, freeDisk(this.storageDir) ?? profile.diskBytes);
	}

	private setupStatus(surface: HostSurface): void {
		const firstTask = this.memento.get<string>(SETUP_TASK_KEY, '');
		surface.post({ type: 'setupStatus', done: this.memento.get<boolean>(SETUP_DONE_KEY, false) === true, ...(firstTask ? { firstTask } : {}) });
	}

	private setupPlan(surface: HostSurface): void {
		try {
			const machine = this.machine();
			surface.post({
				type: 'setupPlan',
				picks: this.planPicks(),
				machine: {
					ramGb: Math.round(machine.totalMemoryBytes / 1e9),
					cores: machine.cores,
					cpu: machine.cpu,
					gpuName: machine.gpuName,
					gpuGb: machine.gpuMemoryBytes ? Math.round(machine.gpuMemoryBytes / 1e9) : undefined,
					fastGb: Math.round((machine.fastBudgetBytes ?? 0) / 1e9)
				}
			});
		} catch (e) {
			surface.post({ type: 'setupPlan', picks: [], error: e instanceof Error ? e.message : String(e) });
		}
	}

	/** The page names a pick from the plan, never a repo or file: the host resolves the download itself. */
	private async setupInstall(surface: HostSurface, id: string): Promise<void> {
		const pick = this.planPicks().find((p) => p.id === id);
		if (!pick) {
			surface.post({ type: 'setupFailed', id, error: 'That model is no longer offered for this computer. Refresh the list.' });
			return;
		}
		const repo = pick.repo.toLowerCase();
		const installed = scanGguf(this.modelsDir).find((g) => g.repo?.toLowerCase() === repo);
		if (installed) {
			await this.useSetupModel(installed.id);
			surface.post({ type: 'setupInstalled', id, modelId: installed.id });
			return;
		}
		if ([...this.jobs.keys()].some((key) => key.toLowerCase().startsWith('hf:' + repo + '/'))) {
			surface.post({ type: 'setupInstalling', id, already: true });
			return;
		}
		surface.post({ type: 'setupInstalling', id });
		const result = await this.catalog.install(surface, id);
		if (!result.ok || !result.modelId) {
			surface.post({ type: 'setupFailed', id, error: result.error ?? 'The download did not finish.' });
			return;
		}
		await this.useSetupModel(result.modelId);
		surface.post({ type: 'setupInstalled', id, modelId: result.modelId });
	}

	/** Enable and select the model without loading it: the first prompt loads it, so setup can finish at once. */
	private async useSetupModel(modelId: string): Promise<void> {
		await this.toggle(modelId, 'zer0ne', true);
		const provider = (await this.ctx.store.list()).find((p) => p.preset === ENGINE_PRESET);
		if (provider) await this.ctx.store.setSelection(provider.id, modelId);
		await this.ctx.sendState();
	}

	private async setupDone(surface: HostSurface, firstTask?: unknown): Promise<void> {
		const task = typeof firstTask === 'string' && firstTask.trim() ? firstTask.trim().slice(0, 600) : '';
		await this.memento.update(SETUP_DONE_KEY, true);
		await this.memento.update(SETUP_TASK_KEY, task);
		// The task is not echoed here: a folder change replaces this page, and the
		// next page reads it from setupStatus to prefill the composer there.
		surface.post({ type: 'setupStatus', done: true });
	}

	private async setupConsumed(surface: HostSurface): Promise<void> {
		await this.memento.update(SETUP_TASK_KEY, '');
		surface.post({ type: 'setupStatus', done: this.memento.get<boolean>(SETUP_DONE_KEY, false) === true });
	}

	private jobList() {
		return [...this.jobs.values()].map(({ ctl: _c, ...j }) => j);
	}

	private progress(job: Job): void {
		this.modelfit?.onJob(job);
		this.ctx.postAll({ type: 'localJob', job: { key: job.key, label: job.label, stage: job.stage, received: job.received, total: job.total, rate: job.rate } });
	}

	private async snapshot(surface: HostSurface, refresh = false): Promise<void> {
		if (refresh) {
			this.devicesCache = undefined;
		}
		const machine = this.machine(refresh);
		const servers = await detectServers();
		const ollama = servers.find((s) => s.id === 'ollama');
		let installed: Awaited<ReturnType<typeof listInstalled>> = [];
		let discoveryError: string | undefined;
		if (ollama?.running) {
			try { installed = await listInstalled(machine); }
			catch (e) { discoveryError = `Ollama is running, but its models could not be listed: ${e instanceof Error ? e.message : String(e)}`; }
		}
		const providers = await this.ctx.store.list();
		const engineP = providers.find((p) => p.preset === ENGINE_PRESET);
		const ollamaP = providers.find((p) => p.preset === 'ollama' || /:11434\b/.test(p.baseUrl));
		const enabled = (p: typeof engineP, id: string) => !!p?.models.find((m) => m.id === id || m.id.startsWith(id.replace(/:.*$/, '') + '-zer0ne'))?.enabled;
		const turbo = this.turboMap();
		const measured = this.speeds();
		const measurements = this.modelMeasurements();
		const gguf = scanGguf(this.modelsDir).map((g) => {
			const plan = this.turboPlan(g);
			return { ...g, fit: rateFit(g.sizeBytes / 1e9, machine), enabled: enabled(engineP, g.id), loaded: this.server.running && this.server.model === g.id, turboOn: this.turboActive(g, plan), turboAuto: turbo[g.id] === undefined, turbo: plan, measured: measured[g.id], measurement: measurements.find(r => r.model === g.id) };
		});
		const have = new Set(installed.map((m) => m.tag));
		surface.post({
			type: 'localModels',
			data: {
				machine: { ...machine, summary: describeMachine(machine) },
				servers,
				discoveryError,
				ollamaInstalled: !!(ollamaBinary() ?? managedOllama(path.join(this.storageDir, 'ollama'))),
				installed: installed.map((m) => ({ ...m, enabled: enabled(ollamaP, m.tag) })),
				gguf,
				engine: this.engineState(),
				lms: !!lmsPath(),
				jobs: this.jobList(),
				hf: this.hf,
				offline: this.offline,
				suggested: SUGGESTED.map((s) => ({ ...s, fit: rateFit(s.sizeGb, machine), installed: have.has(s.tag) || have.has(s.tag + ':latest') }))
			}
		});
	}

	private engineSetup?: Promise<void>;
	private install(surface: HostSurface, backend: Backend): Promise<void> {
		return this.engineSetup ??= this.installRun(surface, backend).finally(() => { this.engineSetup = undefined; });
	}
	private async installRun(surface: HostSurface, backend: Backend): Promise<void> {
		if (this.jobs.has('engine')) {
			return;
		}
		const job: Job = { key: 'engine', label: 'zer0ne Engine (llama.cpp)', stage: 'Starting…', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.jobs.set('engine', job);
		try {
			this.server.stop();
			this.helperServer.stop();
			const meta = await installEngine(
				this.engineDir,
				backend,
				(p) => {
					Object.assign(job, { stage: p.stage, received: p.received, total: p.total, rate: p.bytesPerSec });
					this.progress(job);
				},
				job.ctl.signal,
				{ channel: this.settings().channel }
			);
			await this.saveSettings({ backend: this.settings().backend === 'auto' ? 'auto' : backend });
			this.devicesCache = undefined;
			this.ctx.status(`zer0ne Engine ${meta.version} (${backend}) is installed and starts on this machine.${meta.previous ? ` ${meta.previous.version} is kept for rollback.` : ''}${meta.note ? ' ' + meta.note : ''}`);
		} catch (e) {
			this.ctx.status(job.ctl.signal.aborted ? 'Engine install cancelled.' : `Engine install failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
		} finally {
			this.jobs.delete('engine');
			this.ctx.postAll({ type: 'localJob', job: { key: 'engine', done: true } });
		}
		await this.snapshot(surface);
	}

	/** The first model for the engine installs the engine too (in parallel with the download). */
	private ensureEngine(surface: HostSurface): void {
		if (installedEngine(this.engineDir) || this.jobs.has('engine')) return;
		this.ctx.status('Installing zer0ne Engine alongside the download — the model runs as soon as both finish.', '');
		void this.install(surface, this.resolveBackend(this.settings().backend));
	}

	private _converter?: GgufConverter;
	private get converter(): GgufConverter {
		this._converter ??= new GgufConverter(
			path.join(this.storageDir, 'converter'),
			() => {
				const e = installedEngine(this.engineDir);
				return e ? path.dirname(e.server) : undefined;
			},
			() => installedEngine(this.engineDir)?.version
		);
		return this._converter;
	}

	/** Safetensors → GGUF on this machine (what `ollama create` does), then into the chat picker. */
	private async hfConvert(surface: HostSurface, id: string, params?: number): Promise<void> {
		const key = 'convert:' + id;
		if (this.jobs.has(key)) return;
		this.ensureEngine(surface);
		const job: Job = { key, label: (id.split('/').pop() || id) + ' → GGUF', stage: 'Starting…', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.jobs.set(key, job);
		this.progress(job);
		try {
			if (!installedEngine(this.engineDir)) await this.install(surface, this.resolveBackend(this.settings().backend));
			if (!installedEngine(this.engineDir)) throw new Error('Automatic engine installation did not complete.');
			const out = await this.converter.convert(id, await hfTree(id), path.join(this.modelsDir, ...id.split('/')), params, (p) => {
				Object.assign(job, { stage: p.stage, received: p.received ?? 0, total: p.total ?? 0, rate: p.bytesPerSec ?? 0 });
				this.progress(job);
			}, job.ctl.signal);
			const modelId = path.basename(out).replace(/\.gguf$/i, '');
			await this.toggle(modelId, 'zer0ne', true);
			this.ctx.status(`Converted ${id} to ${path.basename(out)}. It is in the model picker as "zer0ne Engine".`);
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			if (!job.ctl.signal.aborted) this.ctx.postAll({ type: 'hfDownloadError', id, file: 'Convert to GGUF', error });
			this.ctx.status(job.ctl.signal.aborted ? 'Conversion cancelled — downloaded weights are kept, press Convert to continue.' : `Conversion failed: ${error}`, job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.jobs.delete(key);
			this.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		await this.snapshot(surface);
	}

	private async hfDownload(surface: HostSurface, id: string, file: { name: string; parts: string[]; sizeBytes: number; quant: string }, target: 'engine' | 'ollama'): Promise<void> {
		if (target === 'ollama') {
			try {
				if (!validRepoId(id)) throw new Error('Invalid Hugging Face repository.');
				const info = await this.catalog.discovery.info(id, true), files = await this.catalog.discovery.files(id, info, true);
				const build = fitHubFiles(info, files, this.catalog.modelProfile(), this.catalog.discovery.find(id), await this.catalog.discovery.support(), undefined, { lightKv: this.settings().lightKv }).find(f => f.name === file.name && 'fit' in f);
				if (!build || !('fit' in build) || !['fits', 'tight'].includes(build.fit)) throw new Error(build && 'reason' in build ? build.reason || 'This build does not fit this computer.' : 'No compatible complete model build found.');
			} catch (e) { this.ctx.status(e instanceof Error ? e.message : String(e), 'error'); return; }
			// huggingface.co, not hf.co: newer Ollama checks that the auth realm (huggingface.co) matches the host.
			return this.ollamaPull(surface, `huggingface.co/${id}:${file.quant}`);
		}
		const key = `hf:${id}/${file.name}`;
		if (this.jobs.has(key) || !Array.isArray(file.parts) || !file.parts.length) {
			return;
		}
		const job: Job = { key, label: file.name, stage: 'Checking Hugging Face files and memory', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.jobs.set(key, job);
		this.progress(job);
		const dir = path.join(this.modelsDir, ...id.split('/'));
		let done = 0;
		try {
			if (!validRepoId(id) || !safeGgufParts(file.parts)) throw new Error('Invalid model download.');
			const info = await this.catalog.discovery.info(id, true);
			const runtimeReason = architectureReason(info.arch, await this.catalog.discovery.support());
			if (runtimeReason) throw new Error(runtimeReason);
			const current = await this.catalog.discovery.files(id, info, true);
			const model = current.find((f) => !f.mmproj && f.name === file.name && f.parts.join('|') === file.parts.join('|'));
			if (model?.assembly) throw new Error('These raw GGUF parts require assembly with the publisher tools and cannot be downloaded as a runnable model here.');
			if (!model || !model.metadata?.length) throw new Error('That complete model build is no longer available. Refresh its Hugging Face files.');
			file = model;
			const existing = scanGguf(this.modelsDir).find((g) => g.repo?.toLowerCase() === id.toLowerCase() && g.mmproj);
			const projectors = current.filter((f) => f.mmproj).sort((a, b) => Number(/bf16|f32/i.test(a.name)) - Number(/bf16|f32/i.test(b.name)) || a.sizeBytes - b.sizeBytes);
			const proj = projectors.find((f) => f.name === path.basename(existing?.mmproj ?? '')) ?? projectors[0];
			if (info.vision && !proj) throw new Error('This vision model is missing its projector. Choose a complete GGUF repository.');
			if (existing?.mmproj && !projectors.some((f) => f.name === path.basename(existing.mmproj!))) throw new Error('The installed projector is no longer in this repository. Remove this model and download the current complete build.');
			const projectorBytes = proj?.sizeBytes ?? 0;
			const seed = seedFromHub(info, this.catalog.discovery.find(id));
			const plan = fitModel({ name: id, sizeBytes: model.sizeBytes, projectorBytes, machine: this.machine(), freeMemoryBytes: os.freemem(), context: Math.min(8192, info.context ?? 8192), lightKv: this.settings().lightKv,
				cpu: this.engineOptions().gpu === 'cpu', shape: seed?.kvBytes ? { kvBytesPerToken: seed.kvBytes, context: info.context } : undefined, cacheRamMiB: 64, turbo: false });
			if (!plan.fits) throw new Error('The complete model, projector and minimum context exceed available memory. Free memory or choose a smaller build.');
			// A draft head, when the repository has one, comes with the model: it is small and makes it write faster.
			const head = await this.catalog.discovery.draftHead(id, info);
			const selected = [model, ...(proj ? [proj] : []), ...(head ? [head] : [])];
			const parts = selected.flatMap((f) => f.metadata ?? []);
			if (parts.length !== selected.reduce((n, f) => n + f.parts.length, 0) || new Set(parts.map((p) => path.posix.basename(p.path))).size !== parts.length) throw new Error('The repository contains incomplete or ambiguous model files.');
			const needDisk = parts.reduce((n, part) => { const dest = path.join(dir, path.posix.basename(part.path)); return n + (fs.existsSync(dest) && fs.statSync(dest).size === part.size ? 0 : part.size); }, 0);
			const availableDisk = freeDisk(this.storageDir);
			if (availableDisk !== undefined && needDisk + 0.25e9 > availableDisk) throw new Error('Not enough free disk space for the complete model and its projector.');
			if (job.ctl.signal.aborted) throw new Error('Download cancelled.');
			this.ensureEngine(surface);
			job.total = parts.reduce((n, p) => n + p.size, 0);
			fs.mkdirSync(dir, { recursive: true });
			// A model becomes selectable only after every shard and its projector pass verification.
			const pending = path.join(dir, '.pending-' + path.posix.basename(model.parts[0]) + '.json');
			fs.writeFileSync(pending, JSON.stringify({ revision: model.revision, parts: parts.map((p) => p.path) }));
			for (const part of parts) {
				job.stage = /mmproj/i.test(part.path) ? 'Downloading and verifying projector' : head?.parts[0] === part.path ? 'Downloading and verifying draft head' : 'Downloading and verifying model';
				await verifiedHfDownload(id, part, model.revision, path.join(dir, path.posix.basename(part.path)), (p) => {
					Object.assign(job, { received: done + p.received, rate: p.bytesPerSec }); this.progress(job);
				}, job.ctl.signal);
				done += part.size;
			}
			const modelId = file.name.replace(/(-00001-of-\d{5})?\.gguf$/i, '');
			job.ctl.signal.throwIfAborted();
			fs.rmSync(pending, { force: true });
			await this.toggle(modelId, 'zer0ne', true);
			this.ctx.status(`Downloaded ${file.name}. It is in the model picker as "zer0ne Engine".`);
		} catch (e) {
			// The detail pane shows the reason next to the file, with the fix (accept terms / connect a token).
			if (!job.ctl.signal.aborted) this.downloadErrors?.set(key, e instanceof Error ? e.message : String(e));
			if (!job.ctl.signal.aborted) this.ctx.postAll({ type: 'hfDownloadError', id, file: file.name, error: e instanceof Error ? e.message : String(e), gated: /gated|terms|token|signed in/i.test(String(e)) });
			this.ctx.status(job.ctl.signal.aborted ? `Paused ${file.name} — press Download to resume.` : `Download failed: ${e instanceof Error ? e.message : String(e)}`, job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.jobs.delete(key);
			this.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		await this.snapshot(surface);
	}

	/** Show / hide a local model in the chat model picker. */
	private async toggle(id: string, source: string, on: boolean): Promise<void> {
		const store = this.ctx.store;
		if (source === 'ollama') {
			if (on) {
				await this.useOllama(id, undefined, false);
				return;
			}
			const p = (await store.list()).find((x) => x.preset === 'ollama' || /:11434\b/.test(x.baseUrl));
			if (p) {
				await store.update(p.id, { models: p.models.map((m) => (m.id === id || m.id.startsWith(id.replace(/:.*$/, '') + '-zer0ne') ? { ...m, enabled: false } : m)) });
			}
			return;
		}
		const p = await this.engineProvider(on);
		if (!p) {
			return;
		}
		const existing = p.models.find((m) => m.id === id);
		if (existing) {
			await store.update(p.id, { models: p.models.map((m) => (m.id === id ? { ...m, enabled: on, contextWindow: this.settings().context } : m)) });
		} else if (on) {
			await store.upsertModel(p.id, { id, enabled: true, smart: false, contextWindow: this.settings().context });
		}
		if (on) {
			const sel = await store.resolveSelection();
			if (!sel.model) {
				await store.setSelection(p.id, id);
			}
		}
		await this.ctx.sendState();
	}

	private ollamaSetup?: Promise<void>;
	private ollamaReady(surface: HostSurface): Promise<void> {
		return this.ollamaSetup ??= (async () => {
			if ((await detectServers()).some(s => s.id === 'ollama' && s.running)) return;
			if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/i.test(OLLAMA_URL)) throw new Error('The configured remote Ollama is unavailable. Start it on its own computer.');
			const job: Job = { key: 'ollama-setup', label: 'Ollama runtime', stage: 'Checking official runtime…', received: 0, total: 0, rate: 0, ctl: new AbortController() };
			this.jobs.set(job.key, job); this.progress(job);
			try {
				const binary = await ensureOllama(path.join(this.storageDir, 'ollama'), p => { Object.assign(job, { stage: p.stage, received: p.received, total: p.total, rate: p.bytesPerSec }); this.progress(job); }, job.ctl.signal);
				job.ctl.signal.throwIfAborted();
				if (!await startOllama(binary)) throw new Error('Ollama was installed but did not start. Check its port and GPU drivers in Runtimes.');
			} finally { this.jobs.delete(job.key); this.ctx.postAll({ type: 'localJob', job: { key: job.key, done: true } }); await this.snapshot(surface); }
		})().finally(() => { this.ollamaSetup = undefined; });
	}
	private async ollamaPull(surface: HostSurface, tag: string): Promise<void> {
		const key = 'ollama:' + tag;
		if (!TAG.test(tag) || this.jobs.has(key)) {
			return;
		}
		const job: Job = { key, label: tag, stage: 'Ollama pull', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.jobs.set(key, job);
		let last = 0;
		try {
			await this.ollamaReady(surface);
			job.ctl.signal.throwIfAborted();
			await pullModel(
				tag,
				(p) => {
					const now = Date.now();
					if (now - last < 250 && p.completed < p.total) {
						return;
					}
					last = now;
					Object.assign(job, { stage: p.status, received: p.completed, total: p.total });
					this.progress(job);
					this.ctx.postAll({ type: 'localPull', tag, status: p.status, completed: p.completed, total: p.total });
				},
				job.ctl.signal
			);
			this.ctx.postAll({ type: 'localPull', tag, done: true });
			this.ctx.status(`Downloaded ${tag}. Press "Use in chat" to pick it.`);
		} catch (e) {
			const aborted = job.ctl.signal.aborted;
			this.ctx.postAll({ type: 'localPull', tag, error: aborted ? 'Cancelled' : e instanceof Error ? e.message : String(e) });
			if (!aborted) {
				this.ctx.status(`Download failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
			}
		} finally {
			this.jobs.delete(key);
			this.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		await this.snapshot(surface);
	}

	/** Add an Ollama / LM Studio / other-server model to a provider and select it. */
	private async useOllama(tag: string, serverUrl?: string, select = true): Promise<void> {
		const store = this.ctx.store;
		const providers = await store.list();
		const machine = this.machine();
		if (serverUrl && !serverUrl.includes(':11434')) {
			let p = providers.find((x) => x.baseUrl.replace(/\/+$/, '') === serverUrl.replace(/\/+$/, ''));
			if (!p) {
				p = await store.add({ name: serverUrl.includes(':1234') ? 'LM Studio' : 'Local server', baseUrl: serverUrl, apiFormat: 'openai', preset: serverUrl.includes(':1234') ? 'lmstudio' : undefined, models: [] });
			}
			await store.upsertModel(p.id, { id: tag, enabled: true, smart: false });
			if (select) {
				await store.setSelection(p.id, tag);
			}
			this.ctx.status(`Using ${tag} from ${p.name}.`);
			await this.ctx.sendState();
			return;
		}
		const installed = await listInstalled(machine).catch(() => []);
		const info = installed.find((m) => m.tag === tag);
		const { model, context } = await contextAlias(tag, info?.fit);
		let p = providers.find((x) => x.preset === 'ollama' || /:11434\b/.test(x.baseUrl));
		if (!p) {
			p = await store.add({ name: 'Ollama', baseUrl: 'http://localhost:11434/v1', apiFormat: 'openai', preset: 'ollama', models: [] });
		}
		await store.upsertModel(p.id, { id: model, enabled: true, smart: false, contextWindow: context, vision: info?.vision || undefined, tools: info?.tools === false ? false : undefined });
		if (select) {
			await store.setSelection(p.id, model);
		}
		this.ctx.status(
			model === tag
				? `Using ${tag}. This Ollama is old and runs models at a 4K context — update Ollama for longer prompts.`
				: `Using ${tag} with a ${context / 1024}K context (${model}).${info?.tools === false ? ' It has no tool calling, so agent mode is off for it.' : ''}`
		);
		await this.ctx.sendState();
	}
}

export type { LocalGguf };
