import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { HostContext, HostSurface } from './context';
import type { Machine } from '../localModels';
import { freeDisk } from '../localModels';
import { CALIBRATION, CATEGORIES, DIFFUSION_BUNDLES, LLM_QUANTS, LLM_SEEDS, VOICE_BUNDLES, catalogFor, diffusionSeconds, machineProfile, pickLlmFile, rateDiffusion, rateLlmAt, rateVoice, voiceThreads, type Category, type DiffusionBundle, type LlmSeed, type MachineCheck } from '../localCatalog';
import { calibration, runMachineCheck } from '../machineCheck';
import { autoStudioBackend, bundleFilePath, bundleState, downloadBundle, installStudio, installedStudio, StudioServer, studioSupported, type StudioBackend } from '../localStudio';
import { downloadVoice, installVoice, installedVoice, speak, voiceDir, voiceInstalled, voiceSupported } from '../localVoice';
import { hfRepoFromInput, paramsFromName, type HfFile, type LocalGguf } from '../localEngine';
import { moeInfo } from '../turboFit';
import { ModelDiscovery, ratedProfile } from '../modelDiscovery';
import { architectureReason } from '../nativeSupport';
import { modelFiles } from '../repoFiles';
import type { ModelShape } from '../modelFit';
import { fitHubFiles, seedFromHub } from '../modelDiscovery';
import { hardwareKey, modelStatus, recommendModels, recommendationReason, type ModelMeasurement } from '../localExperience';
import { advisorCatalog } from '../localAdvisor';
import { categoryOf, pickSuggestions, suggestRows, usable, type SuggestCandidate } from '../suggest';
import { gpuClass, machineGbPerSec, speedCalibration } from '../speedEstimate';
import type { LocalImageRequest, LocalImageResult } from '../tools/imageSpec';

const CHECK_KEY = 'zer0ne.local.machineCheck';
const STUDIO_KEY = 'zer0ne.studio';
/** The image / video / voice model picked in the chat (kept here: the desktop app's page storage is per launch). */
const PICK_KEY = 'zer0ne.media.pick';

export interface CatalogJob {
	key: string;
	label: string;
	stage: string;
	received: number;
	total: number;
	rate: number;
	ctl: AbortController;
}

export interface CatalogDeps {
	ctx: HostContext;
	memento: vscode.Memento;
	storageDir: string;
	machine: (refresh?: boolean) => Machine;
	prepareHardware?: () => Promise<void>;
	freeGpuMemory?: () => number | undefined;
	engineVersion?: () => string;
	gguf: () => LocalGguf[];
	measurements?: () => ModelMeasurement[];
	freeMemory?: () => number;
	jobs: Map<string, CatalogJob>;
	progress: (job: CatalogJob) => void;
	/** The engine's downloader (same validation and folder layout as Discover). */
	download: (surface: HostSurface, repo: string, file: HfFile) => Promise<void>;
	/** Open a downloaded language model in the chat (picker + selection + load). */
	chat: (surface: HostSurface, modelId: string) => Promise<void>;
	/** Delete a downloaded GGUF (by its file id). */
	removeGguf?: (id: string) => boolean;
	/** Measured speeds: benchmark results and chat averages. */
	speeds: () => Record<string, number>;
	refresh: (surface: HostSurface) => Promise<void>;
	openExternal?: (target: string) => void;
	/** Put an approved picture / clip into the current chat (the controller's transcript). */
	toChat?: (media: ChatMedia) => Promise<void>;
	/** Bring the chat forward (after picking an image / video model from Local models). */
	focusChat?: () => void;
	/** Ask where to save a file (VS Code / desktop dialog); undefined = cancelled or no dialog. */
	saveDialog?: (defaultName: string, kind: 'image' | 'video' | 'voice') => Promise<string | undefined>;
}

/** An approved Studio result on its way into the chat transcript. */
export interface ChatMedia {
	prompt: string;
	kind: 'image' | 'video' | 'voice';
	mime: string;
	base64: string;
	name: string;
	caption: string;
}

/**
 * Local models → Models: the category lists rated for this machine
 * (src/localCatalog.ts), the machine check (src/machineCheck.ts), one click
 * to get a model and one to use it. Language models open in the chat; image
 * and video models are picked in the chat's model menu too — a prompt then
 * opens the generation popup (stable-diffusion.cpp, src/localStudio.ts), and
 * an approved result lands in the chat.
 */
export class LocalCatalogHost {
	readonly studio: StudioServer;
	readonly discovery: ModelDiscovery;
	private checking = false;
	private checkRun?: Promise<MachineCheck>;
	/** For Models Fit Studio's page (modelFitHost.ts): measure the machine again. */
	recheckMachine(): Promise<MachineCheck> {
		return this.recheck();
	}
	/** The Fast / Balanced / Best quality picks of the coding catalog, against this computer. */
	/**
	 * Suggest, the way Models Fit Studio does it: llmfit's own list of models that fit, the speed
	 * range from this computer's decode rate, the same pick rule (suggest.ts, speedEstimate.ts).
	 * Without llmfit, the catalog this app rates itself stands in.
	 */
	async suggestions() {
		if (!this.check()) await this.recheck();
		const profile = this.modelProfile();
		const machine = this.d.machine();
		try {
			const models = await this.discovery.advisor.fit(profile.fastBytes / 1e9);
			const cls = gpuClass(machine.gpuName, profile.gpu !== 'none', machine.unifiedMemory);
			const gbPerSec = machineGbPerSec(models.slice(0, 200) as Array<{ estimated_tps?: number; disk_size_gb?: number }>);
			const calibration = speedCalibration((this.d.measurements?.() ?? []).filter((r) => r.status === 'measured' && r.hardware === hardwareKey(machine) && (r.bytes ?? 0) >= 0.7e9 && !/\d+(\.\d+)?b-a\d+(\.\d+)?b/i.test(r.file ?? '')).map((r) => ({ measuredTps: r.tokS ?? 0, rawTps: gbPerSec > 0 ? Math.round((gbPerSec / ((r.bytes ?? 0) / 1e9)) * 10) / 10 : 0 })));
			const rows = suggestRows(models, profile.fastBytes / 1e9, gbPerSec, cls, calibration);
			if (rows.length) return { profile, picks: pickSuggestions(rows) };
		} catch { /* llmfit could not run here: the app's own catalog below. */ }
		const items = catalogFor('coding', profile, { strict: false, cores: this.d.machine().cores });
		const snapshot = new Map(advisorCatalog().map((m) => [m.name.toLowerCase(), m]));
		const rows: SuggestCandidate[] = items.flatMap((x) => {
			const r = x.rating;
			if (x.kind !== 'llm' || !r || (r.verdict !== 'perfect' && r.verdict !== 'good') || x.runtimeReason) return [];
			const seed = this.discovery.find(x.repo);
			const origin = seed?.modelId ?? x.repo;
			const category = categoryOf(origin, snapshot.get(origin.toLowerCase())?.use_case);
			if (!usable(origin, x.repo.split('/')[0], category, !!seed?.active)) return [];
			const tok = 'tokS' in r ? r.tokS ?? 0 : 0;
			return [{ repo: x.repo, origin, paramsB: seed?.params ?? 0, quality: seed?.quality.coding ?? 0, sizeGb: (r.downloadBytes ?? 0) / 1e9, memGb: (r.needBytes ?? 0) / 1e9,
				tpsLow: tok * 0.8, tpsHigh: tok * 1.15, category, released: seed?.released, vision: !!x.vision }];
		});
		return { profile, picks: pickSuggestions(rows) };
	}
	private recheck(): Promise<MachineCheck> {
		return this.checkRun ??= (async () => {
			this.d.machine(true);
			await this.d.prepareHardware?.();
			const next = await runMachineCheck(this.check());
			const result = { ...next, ...this.calibrate(next), hardware: hardwareKey(this.d.machine()) };
			await this.d.memento.update(CHECK_KEY, result);
			return result;
		})().finally(() => { this.checkRun = undefined; });
	}
	private studioLoading?: string;
	private results: Array<{ id: string; bundle: string; kind: string; prompt: string; file: string; seconds: number; at: number }> = [];

	constructor(private readonly d: CatalogDeps) {
		this.discovery = new ModelDiscovery(d.storageDir, d.machine, () => this.profile(), d.engineVersion);
		this.studio = new StudioServer(() => this.d.ctx.postAll({ type: 'studioState', studio: this.studioState() }), path.join(d.storageDir, 'studio', 'server.pid'));
		this.results = this.loadResults();
	}

	private get studioDir(): string {
		return path.join(this.d.storageDir, 'studio');
	}
	private get studioModels(): string {
		return path.join(this.studioDir, 'models');
	}
	private get voiceEngineDir(): string {
		return path.join(this.d.storageDir, 'voice', 'engine');
	}
	private get voiceModels(): string {
		return path.join(this.d.storageDir, 'voice', 'models');
	}
	private get outputs(): string {
		return path.join(this.studioDir, 'outputs');
	}

	dispose(): void {
		this.discovery.dispose();
		clearTimeout(this.idleTimer);
		this.studio.stop();
	}

	check(): MachineCheck | undefined {
		const saved = this.d.memento.get<MachineCheck>(CHECK_KEY);
		return saved?.hardware === hardwareKey(this.d.machine()) ? saved : undefined;
	}

	private studioSettings(): { backend: StudioBackend | 'auto' } {
		return { backend: 'auto', ...this.d.memento.get<{ backend?: StudioBackend | 'auto' }>(STUDIO_KEY, {}) } as { backend: StudioBackend | 'auto' };
	}

	private studioBackend(): StudioBackend {
		const b = this.studioSettings().backend;
		return b === 'auto' ? autoStudioBackend() : b;
	}

	studioState() {
		const inst = installedStudio(path.join(this.studioDir, 'engine'));
		const profile = this.profile();
		return {
			supported: studioSupported(),
			installed: !!inst,
			version: inst?.version,
			backend: inst?.backend ?? this.studioBackend(),
			setting: this.studioSettings().backend,
			running: this.studio.running,
			ready: this.studio.ready,
			bundle: this.studio.bundle,
			loading: this.studioLoading,
			url: this.studio.ready ? this.studio.base : undefined,
			bundles: DIFFUSION_BUNDLES.map((b) => {
				const rec = rateDiffusion(b, b.kind === 'video' ? 'videos' : 'images', profile);
				return { id: b.id, name: b.name, kind: b.kind, sizes: b.sizes, frames: b.frames, step: b.patch || 64, installed: bundleState(this.studioModels, b).installed, bytes: rec.downloadBytes, rec: { size: rec.size, seconds: rec.seconds, strict: rec.strict, verdict: rec.verdict }, nonCommercial: !!b.nonCommercial };
			}),
			results: this.results.slice(0, 24).map((r) => ({ ...r, file: undefined, name: path.basename(r.file) })),
			voices: VOICE_BUNDLES.map((v) => {
				const rec = this.rateVoiceHere(v);
				return { id: v.id, name: v.name, kind: 'voice', installed: voiceInstalled(this.voiceModels, v), bytes: v.bytes, speakers: v.speakers, langs: v.langs, rec: { rtf: rec.rtf, strict: rec.strict, verdict: rec.verdict } };
			}),
			picked: this.d.memento.get<{ id: string; name: string; kind: string } | null>(PICK_KEY, null),
			voiceEngine: { supported: voiceSupported(), installed: !!installedVoice(this.voiceEngineDir), version: installedVoice(this.voiceEngineDir)?.version }
		};
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		switch (msg.type) {
			case 'catalog':
				await this.post(surface, msg.cat, msg.strict !== false);
				return true;
			case 'catalogRefresh':
				void this.discovery.refresh(() => { void this.post(surface, 'coding', msg.strict !== false); }, true);
				await this.post(surface, 'coding', msg.strict !== false);
				return true;
			case 'machineCheck': {
				if (this.checking) return true;
				this.checking = true;
				surface.post({ type: 'machineChecking', on: true });
				try {
					await this.recheck();
				} finally {
					this.checking = false;
					surface.post({ type: 'machineChecking', on: false });
				}
				await this.post(surface, msg.cat, msg.strict !== false);
				return true;
			}
			case 'modelHardwareCheck': {
				const id = String(msg.id ?? '');
				try {
					const repo = hfRepoFromInput(id);
					if (!repo) throw new Error('Enter owner/model or a Hugging Face model-page link, such as https://huggingface.co/Qwen/model.');
					surface.post({ type: 'modelHardwareCheck', rid: msg.rid, id, stage: 'Measuring memory bandwidth and checking model files…' });
					const check = await this.recheck();
					const { info, files, offline } = await this.discovery.scan(repo);
					const profile = this.modelProfile(), machine = this.d.machine();
					// Every build of a model has the same layers and heads: one header, a megabyte, answers for all of them.
					const weights = modelFiles(files.filter((f) => !f.mmproj), info.params ? info.params / 1e9 : undefined);
					const shape: ModelShape = weights.length && !offline ? await this.discovery.shape(repo, weights[0]) : {};
					const variants = fitHubFiles(info, files, profile, this.discovery.find(repo), await this.discovery.support(), shape).filter((f): f is Extract<typeof f, { fit: string }> => !f.mmproj && 'fit' in f);
					const selected = msg.file ? variants.find(f => f.name === msg.file) : variants.find(f => 'recommended' in f && f.recommended) ?? variants.find(f => f.fit === 'fits') ?? variants.find(f => f.fit === 'tight') ?? variants[0];
					const head = offline ? undefined : await this.discovery.draftHead(repo, info);
					if (msg.file && !selected) throw new Error('That build is no longer available. Refresh this model’s files.');
					const measurement = selected ? this.d.measurements?.().find(r => r.hardware === hardwareKey(machine) && r.repo?.toLowerCase() === repo.toLowerCase() && r.file === selected.name && r.bytes === selected.sizeBytes) : undefined;
					surface.post({ type: 'modelHardwareCheck', rid: msg.rid, id, repo, model: info, variants, quality: seedFromHub(info, this.discovery.find(repo))?.quality.coding, done: true, check, profile, gpuMemoryMeasured: this.d.freeGpuMemory?.() !== undefined, machine: { cpu: machine.cpu, gpuName: machine.gpuName, ramBytes: machine.totalMemoryBytes }, selected, measurement, offline,
						header: !!shape.kvBytesPerToken, draft: head ? { name: head.name, sizeBytes: head.sizeBytes } : undefined,
						builds: !selected ? await this.discovery.builds(repo) : [],
						reason: selected?.reason ?? 'This repository needs a compatible GGUF build or conversion before it can run in zer0ne Engine.' });
				} catch (e) {
					surface.post({ type: 'modelHardwareCheck', rid: msg.rid, id, done: true, error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'catalogGet':
				void this.get(surface, String(msg.id), 'coding', typeof msg.file === 'string' ? msg.file : undefined);
				return true;
			case 'catalogUse':
				await this.use(surface, String(msg.id));
				return true;
			case 'catalogRemove': {
				const id = String(msg.id);
				const voice = VOICE_BUNDLES.find((v) => v.id === id);
				if (voice) {
					fs.rmSync(voiceDir(this.voiceModels, voice), { recursive: true, force: true });
					this.d.ctx.status('Deleted ' + voice.name + '.');
				} else if (DIFFUSION_BUNDLES.some((b) => b.id === id)) this.removeBundle(id);
				else {
					// A language model card: every file downloaded from its repo.
					const seed = [...this.discovery.current(), ...LLM_SEEDS].find((x) => x.id === id);
					for (const g of seed ? this.d.gguf().filter((x) => x.repo?.toLowerCase() === seed.repo.toLowerCase()) : []) this.d.removeGguf?.(g.id);
				}
				await this.d.refresh(surface);
				surface.post({ type: 'studioState', studio: this.studioState() });
				await this.post(surface, msg.cat, msg.strict !== false);
				return true;
			}
			case 'studioState':
				surface.post({ type: 'studioState', studio: this.studioState() });
				return true;
			case 'mediaPick': {
				const known = [...DIFFUSION_BUNDLES, ...VOICE_BUNDLES].find((b) => b.id === msg.id);
				await this.d.memento.update(PICK_KEY, known ? { id: known.id, name: known.name, kind: 'kind' in known ? known.kind : 'voice' } : null);
				return true;
			}
			case 'studioInstall': {
				const b = ['vulkan', 'cuda', 'rocm', 'metal', 'cpu', 'auto'].includes(msg.backend) ? msg.backend : undefined;
				if (b) await this.d.memento.update(STUDIO_KEY, { ...this.studioSettings(), backend: b });
				this.studio.stop();
				void this.installEngine(surface);
				return true;
			}
			case 'studioStart':
				void this.startStudio(surface, String(msg.id));
				return true;
			case 'studioStop':
				this.studio.stop();
				return true;
			case 'studioCancel':
				// Also a job still waiting for its model to load: it must not start after Stop.
				this.cancelSeq++;
				this.studio.cancel();
				this.speakCtl?.abort();
				return true;
			case 'studioGenerate':
				void this.generate(surface, msg);
				return true;
			case 'studioOpenFolder':
				fs.mkdirSync(this.outputs, { recursive: true });
				this.d.openExternal?.(this.outputs);
				return true;
			case 'studioOpenResult': {
				const r = this.results.find((x) => x.id === msg.id);
				if (r && fs.existsSync(r.file)) this.d.openExternal?.(r.file);
				return true;
			}
			case 'studioLoadResult': {
				const r = this.results.find((x) => x.id === msg.id);
				if (r && fs.existsSync(r.file)) surface.post({ type: 'studioResult', id: r.id, bundle: r.bundle, kind: r.kind, prompt: r.prompt, seconds: r.seconds, mime: r.kind === 'video' ? 'video/webm' : r.kind === 'voice' ? 'audio/wav' : 'image/png', b64: fs.readFileSync(r.file).toString('base64'), old: true });
				return true;
			}
			case 'studioOpenWeb':
				if (this.studio.ready) this.d.openExternal?.(this.studio.base + '/');
				return true;
			// The chat's generation popup: keep it (into the chat), save a copy, or throw it away.
			case 'studioToChat': {
				const r = this.results.find((x) => x.id === msg.id);
				if (!r || !fs.existsSync(r.file) || !this.d.toChat) return true;
				const b = DIFFUSION_BUNDLES.find((x) => x.id === r.bundle) ?? VOICE_BUNDLES.find((x) => x.id === r.bundle);
				const video = r.kind === 'video';
				const voice = r.kind === 'voice';
				await this.d.toChat({
					prompt: r.prompt,
					kind: voice ? 'voice' : video ? 'video' : 'image',
					mime: voice ? 'audio/wav' : video ? 'video/webm' : 'image/png',
					base64: fs.readFileSync(r.file).toString('base64'),
					name: path.basename(r.file),
					caption: `${voice ? 'Speech' : video ? 'Video' : 'Image'} made on this computer with **${b?.name ?? r.bundle}** in ${r.seconds} s.`
				});
				return true;
			}
			case 'studioSaveAs': {
				const r = this.results.find((x) => x.id === msg.id);
				if (!r || !fs.existsSync(r.file)) return true;
				const dest = await this.d.saveDialog?.(path.basename(r.file), r.kind === 'video' ? 'video' : r.kind === 'voice' ? 'voice' : 'image');
				if (!dest) return true;
				fs.copyFileSync(r.file, dest);
				this.d.ctx.status(`Saved ${path.basename(dest)}.`, 'ok');
				return true;
			}
			case 'studioDiscard': {
				const r = this.results.find((x) => x.id === msg.id);
				if (!r) return true;
				fs.rmSync(r.file, { force: true });
				this.results = this.results.filter((x) => x.id !== r.id);
				this.saveResults();
				surface.post({ type: 'studioState', studio: this.studioState() });
				return true;
			}
		}
		return false;
	}

	/** Calibration from what this machine really did: benchmarks and chats over the estimate for the same files. */
	private calibrate(check: MachineCheck): Partial<MachineCheck> {
		const p = machineProfile(this.d.machine(), { ...check, llmFactor: 1 });
		const speeds = Object.fromEntries((this.d.measurements?.() ?? []).filter(r => r.status === 'measured' && r.hardware === hardwareKey(this.d.machine())).map(r => [r.model, r.tokS]));
		const pairs: Array<{ measured: number; estimated: number }> = [];
		for (const g of this.d.gguf()) {
			const measured = speeds[g.id];
			if (!measured) continue;
			const params = paramsFromName(g.id) ?? paramsFromName(g.repo ?? '') ?? (g.sizeBytes * 8) / 4.85;
			const { active } = moeInfo(g.id, params);
			const seed: LlmSeed = { id: g.id, name: g.id, repo: g.repo ?? '', family: '', params: params / 1e9, active: active ? active / 1e9 : undefined, q4Gb: g.sizeBytes / 1e9, ctx: 32768, released: '', tools: true, quality: { coding: 50 }, blurb: '', license: '' };
			const est = rateLlmAt(seed, 'coding', p, { q: 'Q4_K_M', bits: 4.85, keep: 0 });
			// Only models that ran from fast memory say something about its bandwidth.
			if (est.verdict === 'perfect' || est.verdict === 'good') pairs.push({ measured, estimated: est.tokS });
		}
		const c = calibration(pairs);
		return { llmFactor: c.factor, llmSamples: c.samples };
	}

	private freshNow(surface: HostSurface, cat: 'coding', strict: boolean): LlmSeed[] {
		void this.discovery.refresh(() => { void this.post(surface, cat, strict); });
		return this.discovery.current();
	}

	private rateVoiceHere(v: (typeof VOICE_BUNDLES)[number]) {
		const m = this.d.machine();
		const p = this.profile();
		return rateVoice(v, { cores: m.cores, ramBytes: m.totalMemoryBytes }, p.diffFactor['voice:' + v.id] ?? 1);
	}

	private profile() {
		return machineProfile(this.d.machine(), this.check());
	}
	/** What ratings are made against: the computer's own limits, with what is free now beside them. */
	modelProfile() {
		return ratedProfile(this.profile(), this.d.freeMemory?.(), this.d.freeGpuMemory?.());
	}

	/** Recompute against the actual local files; machine or cache settings may have changed since downloading. */
	contextFor(model: LocalGguf, maxContext: number, lightKv: boolean): number {
		const known = [...this.discovery.current(), ...LLM_SEEDS].find((s) => s.repo.toLowerCase() === model.repo?.toLowerCase());
		const params = paramsFromName(model.id) ?? paramsFromName(model.repo ?? '') ?? model.sizeBytes * 8 / 4.85;
		const { active } = moeInfo(model.id, params);
		const seed: LlmSeed = known ?? { id: model.id, name: model.id, repo: model.repo ?? '', family: '', params: params / 1e9, active: active ? active / 1e9 : undefined, q4Gb: model.sizeBytes / 1e9, ctx: maxContext, released: '', tools: true, quality: { coding: 50 }, blurb: '', license: '' };
		const cat = 'coding';
		const q = LLM_QUANTS.find((x) => model.quant === x.q || model.quant === 'UD-' + x.q) ?? LLM_QUANTS[3];
		const projectorBytes = model.mmproj ? fs.statSync(model.mmproj).size : 0;
		return rateLlmAt(seed, cat, this.profile(), q, { fileBytes: model.sizeBytes, projectorBytes, maxContext: Math.min(maxContext, 32768), lightKv }).ctx;
	}

	private async post(surface: HostSurface, rawCat: unknown, strict: boolean): Promise<void> {
		const cat: Category = CATEGORIES.some((c) => c.id === rawCat) ? (rawCat as Category) : 'coding';
		// First visit: measure the machine before the first list (≈1 s).
		if (!this.check()) {
			await this.recheck();
		}
		const p = this.modelProfile();
		const fresh = cat === 'coding' ? this.freshNow(surface, cat, strict) : [];
		const have = this.d.gguf();
		const m = this.d.machine();
		const measured = this.d.measurements?.() ?? [], support = await this.discovery.support();
		const seeds = [...this.discovery.current(), ...LLM_SEEDS];
		const items = catalogFor(cat, p, { strict: false, fresh, cores: m.cores }).map((x) => ({
			...x,
			...(x.kind === 'llm' ? (() => {
				const seed = seeds.find(s => s.repo.toLowerCase() === x.repo.toLowerCase());
				const runtimeReason = architectureReason(seed?.arch, support);
				const info = { id: x.repo, author: x.repo.split('/')[0], downloads: 0, likes: 0, tags: ['gguf'], format: 'gguf', arch: seed?.arch, params: seed ? seed.params * 1e9 : undefined, context: seed?.ctx, tools: x.tools, vision: x.vision };
				const variants = seed?.files ? fitHubFiles(info, seed.files, p, seed, support).filter(f => !f.mmproj).map(f => {
					const g = have.find(g => g.repo?.toLowerCase() === x.repo.toLowerCase() && path.basename(g.path) === f.name);
					const measurement = g ? measured.find(r => r.model === g.id && r.file === f.name && r.bytes === f.sizeBytes) : undefined;
					return { ...f, modelId: g?.id, installed: !!g, measurement };
				}) : [];
				const selected = variants.find(f => 'recommended' in f && f.recommended);
				const measurement = selected?.measurement;
				const value = { ...x, runtimeReason, measurement };
				return { runtimeReason, quality: seed?.quality.coding, params: seed?.params, variants, measurement, installedModel: selected?.modelId,
					compatibility: modelStatus(value, p.diskBytes), speed: measurement?.status === 'measured' ? measurement.tokS!.toFixed(1) + ' tok/s' : x.speed };
			})() : {}),
			installed: x.kind === 'llm' ? have.some((g) => g.repo?.toLowerCase() === x.repo.toLowerCase()) : x.kind === 'voice' ? voiceInstalled(this.voiceModels, VOICE_BUNDLES.find((v) => v.id === x.id)!) : bundleState(this.studioModels, DIFFUSION_BUNDLES.find((b) => b.id === x.id)!).installed
		}));
		const picks = cat === 'coding' ? recommendModels(items, p.diskBytes) : undefined;
		const recommendations = picks ? Object.fromEntries(Object.entries(picks).map(([preset, x]) => [preset, x ? { id: x.id, reason: recommendationReason(x, preset), measured: x.measurement?.status === 'measured' } : undefined])) : undefined;
		surface.post({
			type: 'catalog',
			cat,
			strict,
			items,
			recommendations,
			counts: Object.fromEntries(CATEGORIES.map((c) => [c.id, catalogFor(c.id, p, { strict: false, fresh: c.id === cat ? fresh : this.discovery.current(), cores: m.cores }).length])),
			profile: p,
			check: this.check(),
			machine: { cpu: m.cpu, cores: m.cores, platform: m.platform, ramBytes: m.totalMemoryBytes, gpuName: m.gpuName, gpuBytes: m.gpuMemoryBytes, unified: m.unifiedMemory, diskBytes: m.freeDiskBytes, fastBytes: m.fastBudgetBytes },
			studio: this.studioState(),
			discovery: this.discovery.state()
		});
	}

	/** One click: download what this machine should run (the quant picked for it, or the whole bundle). */
	private async get(surface: HostSurface, id: string, cat: 'coding', requestedFile?: string): Promise<void> {
		const bundle = DIFFUSION_BUNDLES.find((b) => b.id === id);
		if (bundle) return this.getBundle(surface, bundle.id);
		if (VOICE_BUNDLES.some((v) => v.id === id)) return this.getVoice(surface, id);
		const seed = [...this.discovery.current(), ...LLM_SEEDS].find((s) => s.id === id);
		if (!seed) return;
		try {
			const info = await this.discovery.info(seed.repo, true);
			const files = await this.discovery.files(seed.repo, info, true);
			const existing = this.d.gguf().find((g) => g.repo?.toLowerCase() === seed.repo.toLowerCase() && g.mmproj);
			// The downloader reuses an existing projector; rate that file rather than a smaller one in the repo.
			const candidates = existing?.mmproj ? [...files.filter((f) => !f.mmproj), { name: path.basename(existing.mmproj), quant: 'GGUF', sizeBytes: fs.statSync(existing.mmproj).size, mmproj: true, parts: [] }] : files;
			const runtimeReason = architectureReason(info.arch, await this.discovery.support());
			if (runtimeReason) throw new Error(runtimeReason);
			const allowed = requestedFile ? candidates.filter(f => f.mmproj || f.name === requestedFile) : candidates;
			const choice = pickLlmFile({ ...seed, runtimeReason: undefined }, cat, { ...this.modelProfile(), diskBytes: freeDisk(this.d.storageDir) }, allowed);
			if (!choice) throw new Error('No complete GGUF build fits this machine’s memory and free disk space. Try a smaller model or free disk space.');
			const { file, rating } = choice;
			this.d.ctx.status(`Downloading ${seed.name} (${file.quant}, ${(file.sizeBytes / 1e9).toFixed(1)} GB, ${rating.ctx / 1024}K context) — picked for this machine.`, '');
			await this.d.download(surface, seed.repo, file);
		} catch (e) {
			this.d.ctx.status(`Could not download ${seed.name}: ${e instanceof Error ? e.message : String(e)}`, 'error');
		}
	}

	/**
	 * First-run setup's install: the same one-click download, but with an
	 * outcome the page can show. The download itself reports progress and its
	 * precise error through the existing job events/status.
	 */
	async install(surface: HostSurface, id: string): Promise<{ ok: boolean; error?: string; modelId?: string }> {
		const seed = [...this.discovery.current(), ...LLM_SEEDS].find((s) => s.id === id);
		if (!seed) return { ok: false, error: 'That model is no longer in the catalog. Refresh the list.' };
		await this.get(surface, id, 'coding');
		const installed = this.d.gguf().find((g) => g.repo?.toLowerCase() === seed.repo.toLowerCase());
		return installed ? { ok: true, modelId: installed.id } : { ok: false, error: 'The download did not finish. Open Local models to see why and retry.' };
	}

	private async getBundle(surface: HostSurface, id: string): Promise<void> {
		const b = DIFFUSION_BUNDLES.find((x) => x.id === id);
		if (!b) return;
		const key = 'studio:' + b.id;
		if (this.d.jobs.has(key)) return;
		if (!studioSupported()) {
			this.d.ctx.status(`Images and videos need stable-diffusion.cpp, which has no build for ${process.platform}-${process.arch}.`, 'error');
			return;
		}
		// The Studio engine installs alongside the first model.
		if (!installedStudio(path.join(this.studioDir, 'engine'))) void this.installEngine(surface);
		const job: CatalogJob = { key, label: b.name, stage: 'Starting…', received: 0, total: b.files.reduce((n, f) => n + f.bytes, 0), rate: 0, ctl: new AbortController() };
		this.d.jobs.set(key, job);
		this.d.progress(job);
		try {
			await downloadBundle(this.studioModels, b, (p) => {
				Object.assign(job, { stage: p.stage, received: p.received, total: p.total, rate: p.bytesPerSec });
				this.d.progress(job);
			}, job.ctl.signal);
			this.d.ctx.status(`${b.name} is ready — open it in the Studio.`);
		} catch (e) {
			this.d.ctx.status(job.ctl.signal.aborted ? `Paused ${b.name} — press Get to resume.` : `Download failed: ${e instanceof Error ? e.message : String(e)}`, job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.d.jobs.delete(key);
			this.d.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		await this.d.refresh(surface);
		surface.post({ type: 'studioState', studio: this.studioState() });
	}

	private async getVoice(surface: HostSurface, id: string): Promise<void> {
		const v = VOICE_BUNDLES.find((x) => x.id === id);
		if (!v) return;
		const key = 'voice:' + v.id;
		if (this.d.jobs.has(key)) return;
		if (!voiceSupported()) {
			this.d.ctx.status('Voices need sherpa-onnx, which has no build for ' + process.platform + '-' + process.arch + '.', 'error');
			return;
		}
		// The voice engine installs alongside the first voice.
		if (!installedVoice(this.voiceEngineDir)) void this.installVoiceEngine(surface);
		const job: CatalogJob = { key, label: v.name, stage: 'Starting…', received: 0, total: v.bytes, rate: 0, ctl: new AbortController() };
		this.d.jobs.set(key, job);
		this.d.progress(job);
		try {
			await downloadVoice(this.voiceModels, v, (pr) => {
				Object.assign(job, { stage: pr.stage, received: pr.received, total: pr.total, rate: pr.bytesPerSec });
				this.d.progress(job);
			}, job.ctl.signal);
			this.d.ctx.status(v.name + ' is ready — pick it in the chat under Voice · Local.');
		} catch (e) {
			this.d.ctx.status(job.ctl.signal.aborted ? 'Paused ' + v.name + ' — press Get to resume.' : 'Download failed: ' + (e instanceof Error ? e.message : String(e)), job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.d.jobs.delete(key);
			this.d.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		await this.d.refresh(surface);
		surface.post({ type: 'studioState', studio: this.studioState() });
	}

	private async installVoiceEngine(surface: HostSurface): Promise<void> {
		const key = 'voice-engine';
		if (this.d.jobs.has(key)) return;
		const job: CatalogJob = { key, label: 'Voice engine (sherpa-onnx)', stage: 'Starting…', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.d.jobs.set(key, job);
		this.d.progress(job);
		try {
			const meta = await installVoice(this.voiceEngineDir, (pr) => {
				Object.assign(job, { stage: pr.stage, received: pr.received, total: pr.total, rate: pr.bytesPerSec });
				this.d.progress(job);
			}, job.ctl.signal);
			this.d.ctx.status('Voice engine ready (' + meta.version + ').');
		} catch (e) {
			this.d.ctx.status(job.ctl.signal.aborted ? 'Voice engine install cancelled.' : 'Voice engine install failed: ' + (e instanceof Error ? e.message : String(e)), job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.d.jobs.delete(key);
			this.d.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		surface.post({ type: 'studioState', studio: this.studioState() });
	}

	private async installEngine(surface: HostSurface): Promise<void> {
		const key = 'studio-engine';
		if (this.d.jobs.has(key)) return;
		const job: CatalogJob = { key, label: 'zer0ne Studio engine (stable-diffusion.cpp)', stage: 'Starting…', received: 0, total: 0, rate: 0, ctl: new AbortController() };
		this.d.jobs.set(key, job);
		this.d.progress(job);
		try {
			const meta = await installStudio(path.join(this.studioDir, 'engine'), this.studioBackend(), (p) => {
				Object.assign(job, { stage: p.stage, received: p.received, total: p.total, rate: p.bytesPerSec });
				this.d.progress(job);
			}, job.ctl.signal);
			this.d.ctx.status(`Studio engine ready (${meta.backend}).`);
		} catch (e) {
			this.d.ctx.status(job.ctl.signal.aborted ? 'Studio engine install cancelled.' : `Studio engine install failed: ${e instanceof Error ? e.message : String(e)}`, job.ctl.signal.aborted ? '' : 'error');
		} finally {
			this.d.jobs.delete(key);
			this.d.ctx.postAll({ type: 'localJob', job: { key, done: true } });
		}
		surface.post({ type: 'studioState', studio: this.studioState() });
	}

	/** Use: a language model opens in the chat; an image / video model loads in the Studio. */
	private async use(surface: HostSurface, id: string): Promise<void> {
		const voice = VOICE_BUNDLES.find((v) => v.id === id);
		if (voice) {
			await this.d.memento.update(PICK_KEY, { id: voice.id, name: voice.name, kind: 'voice' });
			this.d.ctx.postAll({ type: 'mediaModel', id: voice.id, name: voice.name, kind: 'voice' });
			this.d.focusChat?.();
			this.d.ctx.status(voice.name + ' is picked in the chat — type the text to speak and press Enter.');
			return;
		}
		const bundle = DIFFUSION_BUNDLES.find((b) => b.id === id);
		if (bundle) {
			// Picked like any chat model: the chat's model menu switches to it; a prompt then opens the generation popup.
			await this.d.memento.update(PICK_KEY, { id: bundle.id, name: bundle.name, kind: bundle.kind });
			this.d.ctx.postAll({ type: 'mediaModel', id: bundle.id, name: bundle.name, kind: bundle.kind });
			this.d.focusChat?.();
			this.d.ctx.status(`${bundle.name} is picked in the chat — type what to ${bundle.kind === 'video' ? 'film' : 'draw'} and press Enter.`);
			void this.startStudio(surface, id);
			return;
		}
		const seed = [...this.discovery.current(), ...LLM_SEEDS].find((s) => s.id === id);
		const g = seed && this.d.gguf().filter((x) => x.repo?.toLowerCase() === seed.repo.toLowerCase()).sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
		if (!g) {
			this.d.ctx.status('Download the model first.', 'error');
			return;
		}
		await this.d.chat(surface, g.id);
	}

	private loadError?: string;

	private async startStudio(surface: HostSurface | undefined, id: string): Promise<void> {
		const b = DIFFUSION_BUNDLES.find((x) => x.id === id);
		const inst = installedStudio(path.join(this.studioDir, 'engine'));
		if (!b) return;
		if (!inst) {
			this.loadError = this.d.jobs.has('studio-engine') ? 'The image & video engine is still installing — try again when it finishes.' : 'The image & video engine is not installed — get an image or video model in Local Models, it installs with it.';
			return;
		}
		if (!bundleState(this.studioModels, b).installed) {
			this.loadError = `${b.name} is not downloaded (any more) — get it again in Local Models.`;
			return;
		}
		this.studioLoading = b.id;
		surface?.post({ type: 'studioState', studio: this.studioState() });
		this.loadError = undefined;
		try {
			await this.studio.start(inst.server, b, this.studioModels, inst.backend);
			this.touchIdle();
		} catch (e) {
			// Shown in the Studio itself, next to the model that failed.
			this.loadError = e instanceof Error ? e.message : String(e);
			surface?.post({ type: 'studioError', id: b.id, source: 'load', error: this.loadError });
		} finally {
			this.studioLoading = undefined;
			this.d.ctx.postAll({ type: 'studioState', studio: this.studioState() });
		}
	}

	/** A loaded image / video model holds GBs of memory: unload it after 10 idle minutes (it reloads on the next prompt). */
	private idleTimer?: NodeJS.Timeout;
	private touchIdle(): void {
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			if (this.studio.running && !this.busy) this.studio.stop();
		}, 10 * 60_000);
		this.idleTimer.unref?.();
	}
	private busy = false;

	/** Text to speech: one engine run into a WAV file (no server), then the same result flow as images. */
	private async speakNow(surface: HostSurface, msg: { [k: string]: any }): Promise<void> {
		const v = VOICE_BUNDLES.find((x) => x.id === msg.id)!;
		const source = typeof msg.source === 'string' ? msg.source.slice(0, 20) : undefined;
		const rid = Number.isInteger(msg.rid) ? msg.rid : undefined;
		const text = String(msg.prompt ?? '').trim().slice(0, 6000);
		const inst = installedVoice(this.voiceEngineDir);
		try {
			if (!text) return;
			if (!inst) throw new Error(this.d.jobs.has('voice-engine') ? 'The voice engine is still installing — try again when it finishes.' : 'The voice engine is not installed — get a voice in Local Models, it installs with it.');
			if (!voiceInstalled(this.voiceModels, v)) throw new Error(v.name + ' is not downloaded (any more) — get it again in Local Models.');
			const speaker = Number.isInteger(msg.speaker) && v.speakers.some((x) => x.id === msg.speaker) ? Number(msg.speaker) : v.speakers[0].id;
			const speed = Math.min(1.6, Math.max(0.6, Number(msg.speed) || 1));
			surface.post({ type: 'studioBusy', id: v.id, source, rid, elapsed: 0, status: 'speaking' });
			this.speakCtl?.abort();
			this.speakCtl = new AbortController();
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'speech';
			const file = path.join(this.outputs, stamp + '-' + slug + '.wav');
			const t0 = Date.now();
			const tick = setInterval(() => surface.post({ type: 'studioBusy', id: v.id, source, rid, elapsed: (Date.now() - t0) / 1000, status: 'speaking' }), 800);
			let res: { seconds: number; audioSeconds?: number };
			try {
				res = await speak(inst.tts, v, this.voiceModels, text, { speaker, speed, threads: voiceThreads(this.d.machine().cores), out: file, signal: this.speakCtl.signal });
			} finally {
				clearInterval(tick);
			}
			const entry = { id: stamp + '-' + Math.random().toString(36).slice(2, 6), bundle: v.id, kind: 'voice', prompt: text, file, seconds: Math.round(res.seconds), at: Date.now() };
			this.results.unshift(entry);
			this.results = this.results.slice(0, 200);
			this.saveResults();
			// A real run calibrates this voice's speed here (real-time factor against the estimate).
			if (res.audioSeconds && res.audioSeconds > 1) {
				const est = rateVoice(v, { cores: this.d.machine().cores, ramBytes: this.d.machine().totalMemoryBytes }).rtf;
				const check = this.check() ?? { at: Date.now() };
				const same = check.calibV === CALIBRATION;
				const key = 'voice:' + v.id;
				const prev = same ? check.diffFactor?.[key] : undefined;
				const ratio = res.seconds / res.audioSeconds / Math.max(0.01, est);
				void this.d.memento.update(CHECK_KEY, { ...check, calibV: CALIBRATION, diffFactor: { ...(same ? check.diffFactor : {}), [key]: prev ? prev * 0.6 + ratio * 0.4 : ratio } });
			}
			surface.post({ type: 'studioResult', id: entry.id, source, rid, bundle: v.id, kind: 'voice', prompt: text, seconds: entry.seconds, mime: 'audio/wav', b64: fs.readFileSync(file).toString('base64'), name: path.basename(file), audioSeconds: res.audioSeconds });
		} catch (e) {
			surface.post({ type: 'studioError', id: v.id, source, rid, error: e instanceof Error ? e.message : String(e) });
		}
	}
	private speakCtl?: AbortController;
	private cancelSeq = 0;

	private async generate(surface: HostSurface, msg: { [k: string]: any }): Promise<void> {
		if (VOICE_BUNDLES.some((x) => x.id === msg.id)) return this.speakNow(surface, msg);
		const b = DIFFUSION_BUNDLES.find((x) => x.id === msg.id);
		const prompt = String(msg.prompt ?? '').trim().slice(0, 4000);
		if (!b || !prompt) return;
		const source = typeof msg.source === 'string' ? msg.source.slice(0, 20) : undefined;
		const rid = Number.isInteger(msg.rid) ? msg.rid : undefined;
		const seq = this.cancelSeq;
		// A shape the window chose (square / portrait / landscape): on the model's grid, no more pixels than its largest size.
		const asked = Array.isArray(msg.size) && msg.size.length === 2 ? msg.size.map((n: unknown) => Math.floor(Number(n))) : [];
		const size = this.studioSize(b, asked[0], asked[1]);
		try {
			if (!this.studio.ready || this.studio.bundle !== b.id) await this.startStudio(surface, b.id);
			if (!this.studio.ready || this.studio.bundle !== b.id) throw new Error(this.loadError || `${b.name} did not load — try again.`);
			if (seq !== this.cancelSeq) throw new Error('Cancelled.');
			surface.post({ type: 'studioBusy', id: b.id, source, rid, elapsed: 0, status: 'queued' });
			this.busy = true;
			const r = await this.studio.generate(b, { prompt, negative: typeof msg.negative === 'string' ? msg.negative.slice(0, 2000) : undefined, width: size[0], height: size[1], seed: Number.isInteger(msg.seed) ? msg.seed : undefined, frames: b.kind === 'video' && Number.isInteger(msg.frames) ? Math.min(121, Math.max(5, Math.floor((msg.frames - 1) / 4) * 4 + 1)) : undefined }, (t) => surface.post({ type: 'studioBusy', id: b.id, source, rid, ...t }));
			fs.mkdirSync(this.outputs, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'studio';
			const file = path.join(this.outputs, `${stamp}-${slug}.${r.kind === 'video' ? 'webm' : 'png'}`);
			fs.writeFileSync(file, Buffer.from(r.b64, 'base64'));
			const entry = { id: stamp + '-' + Math.random().toString(36).slice(2, 6), bundle: b.id, kind: r.kind, prompt, file, seconds: Math.round(r.seconds), at: Date.now() };
			this.results.unshift(entry);
			this.results = this.results.slice(0, 200);
			this.saveResults();
			if (!r.cold) this.learn(b.id, size, r.seconds, b.kind === 'video' ? Number(msg.frames) || b.frames : undefined);
			surface.post({ type: 'studioResult', id: entry.id, source, rid, bundle: b.id, kind: r.kind, prompt, seconds: entry.seconds, mime: r.mime, b64: r.b64, name: path.basename(file), size });
		} catch (e) {
			surface.post({ type: 'studioError', id: b.id, source, rid, error: e instanceof Error ? e.message : String(e) });
		} finally {
			this.busy = false;
			this.touchIdle();
			surface.post({ type: 'studioState', studio: this.studioState() });
		}
	}

	/** The requested shape on the model's grid, or the largest size its quick estimate allows. */
	private studioSize(b: DiffusionBundle, width?: number, height?: number): [number, number] {
		const step = b.patch || 64;
		const maxArea = Math.max(...b.sizes.map(([w, h]) => w * h)) * 1.05;
		const ok =
			Number.isInteger(width) && Number.isInteger(height) &&
			width! >= 256 && width! <= 1536 && height! >= 256 && height! <= 1536 &&
			width! % step === 0 && height! % step === 0 && width! * height! <= maxArea;
		return ok ? [width!, height!] : rateDiffusion(b, b.kind === 'video' ? 'videos' : 'images', this.profile()).size;
	}

	/** Image bundles the Studio can generate with right now (its engine and the model files are installed). */
	installedImages(): Array<{ id: string; name: string }> {
		if (!installedStudio(path.join(this.studioDir, 'engine'))) return [];
		const picked = this.d.memento.get<{ id?: string }>(PICK_KEY)?.id;
		// The one picked in the chat first: the agent's automatic choice matches what the user sees.
		return DIFFUSION_BUNDLES.filter((b) => b.kind === 'image' && bundleState(this.studioModels, b).installed)
			.sort((a, b) => Number(b.id === picked) - Number(a.id === picked))
			.map((b) => ({ id: b.id, name: b.name }));
	}

	/**
	 * image_generate: one image for the agent, outside the chat popup. It shares
	 * the single Studio server with the popup, so a generation already running
	 * there is never interrupted.
	 */
	async generateForTool(
		req: LocalImageRequest,
		onTick: (tick: { elapsed: number; status: string; queue?: number }) => void,
		signal: AbortSignal
	): Promise<LocalImageResult> {
		if (this.busy) throw new Error('The Studio is already generating another image. Wait for it to finish, then try again.');
		const b = this.toolBundle(req.bundleId);
		if (!b) {
			throw new Error(
				installedStudio(path.join(this.studioDir, 'engine'))
					? 'No image model is downloaded in Local models.'
					: 'The image & video engine is not installed. Get an image model in Local models, or set an image model (provider/model) in Settings → Features → Image generation.'
			);
		}
		if (!this.studio.ready || this.studio.bundle !== b.id) await this.startStudio(undefined, b.id);
		if (!this.studio.ready || this.studio.bundle !== b.id) throw new Error(this.loadError || `${b.name} did not load — try again.`);
		if (signal.aborted) throw new Error('Cancelled.');
		const size = this.studioSize(b, req.width, req.height);
		this.busy = true;
		try {
			const r = await this.studio.generate(b, { prompt: req.prompt, width: size[0], height: size[1], seed: req.seed }, onTick, signal);
			if (r.kind !== 'image') throw new Error('That Studio model makes video, not images.');
			return { b64: r.b64, mime: r.mime, seconds: r.seconds, width: size[0], height: size[1], bundle: { id: b.id, name: b.name } };
		} finally {
			this.busy = false;
			this.touchIdle();
			this.d.ctx.postAll({ type: 'studioState', studio: this.studioState() });
		}
	}

	/** The bundle an agent generation uses: the named one, the one picked in the chat, else the first installed. */
	private toolBundle(id?: string): DiffusionBundle | undefined {
		if (!installedStudio(path.join(this.studioDir, 'engine'))) return undefined;
		const usable = DIFFUSION_BUNDLES.filter((b) => b.kind === 'image' && bundleState(this.studioModels, b).installed);
		if (id) return usable.find((b) => b.id === id);
		const picked = this.d.memento.get<{ id?: string }>(PICK_KEY)?.id;
		return usable.find((b) => b.id === picked) ?? usable[0];
	}

	/** A real generation time calibrates that model's estimate (moving average). */
	private learn(id: string, size: [number, number], seconds: number, frames?: number): void {
		const check = this.check() ?? { at: Date.now() };
		const b = DIFFUSION_BUNDLES.find((x) => x.id === id);
		if (!b || seconds < 1) return;
		const p = machineProfile(this.d.machine(), { ...check, diffFactor: {} });
		const est = diffusionSeconds(b, p, size, frames ?? b.frames ?? 1);
		const ratio = seconds / Math.max(1, est);
		const same = check.calibV === CALIBRATION;
		const prev = same ? check.diffFactor?.[id] : undefined;
		void this.d.memento.update(CHECK_KEY, { ...check, calibV: CALIBRATION, diffFactor: { ...(same ? check.diffFactor : {}), [id]: prev ? prev * 0.6 + ratio * 0.4 : ratio } });
	}

	/** Delete a bundle's files — shared files (a VAE or text encoder another downloaded bundle uses) stay. */
	private removeBundle(id: string): void {
		const b = DIFFUSION_BUNDLES.find((x) => x.id === id);
		if (!b) return;
		if (this.studio.bundle === id) this.studio.stop();
		const keep = new Set(DIFFUSION_BUNDLES.filter((o) => o.id !== id && bundleState(this.studioModels, o).installed).flatMap((o) => o.files.map((f) => bundleFilePath(this.studioModels, f))));
		for (const f of b.files) {
			const p = bundleFilePath(this.studioModels, f);
			if (!keep.has(p)) fs.rmSync(p, { force: true });
		}
		this.d.ctx.status(`Deleted ${b.name}.`);
	}

	private loadResults() {
		try {
			const list = JSON.parse(fs.readFileSync(path.join(this.studioDir, 'results.json'), 'utf8'));
			return Array.isArray(list) ? list.filter((r: any) => r && typeof r.file === 'string' && fs.existsSync(r.file)) : [];
		} catch {
			return [];
		}
	}

	private saveResults(): void {
		try {
			fs.mkdirSync(this.studioDir, { recursive: true });
			fs.writeFileSync(path.join(this.studioDir, 'results.json'), JSON.stringify(this.results));
		} catch {
			/* the gallery is a convenience */
		}
	}
}
