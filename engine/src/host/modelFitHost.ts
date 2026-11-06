import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import type { HostContext, HostSurface } from './context';
import type { LocalCatalogHost } from './localCatalogHost';
import type { Machine } from '../localModels';
import { freeDisk } from '../localModels';
import { hfRepoFromInput, installedEngine, lmsPath, scanGguf, searchHfPage, type HfFile, type HfModel, type LocalGguf } from '../localEngine';
import { fitHubFiles, rateHubSearch, seedFromHub } from '../modelDiscovery';
import { removeEmptyDirs } from './storageSweep';
import { draftArchitecture, helperBySize, modelFiles } from '../repoFiles';
import { readModelShape } from '../modelFit';
import { planTurbo } from '../turboFit';
import { FIT } from '../localCatalog';
import type { ModelMeasurement } from '../localExperience';
import type { ModelShape } from '../modelFit';

/**
 * Local models is Models Fit Studio's own page (media/modelfit). That page asks its host
 * for everything with { id, cmd, args } and listens for pushed updates; in the Windows app a
 * .NET host answers. Here zer0ne code answers, with its own engine and rules behind it: the
 * hardware check, the shared fit rule, Hugging Face search, downloads into its models folder,
 * zer0ne Engine for running, speed checks and the quality test. A model downloaded or run here
 * is in Providers & models as "zer0ne Engine" at once, because it is the same download and the
 * same engine the rest of zer0ne code uses.
 *
 * The answers keep the shapes the page reads (ModelFitStudio/MainWindow.xaml.cs and Core/*):
 * names in camelCase, sizes in GB, speeds as a range.
 */

const GB = 1e9;
const GiB = 1024 ** 3;

/** Interrupted download and checksum-verification leftovers, the files the storage card can purge. */
const LEFTOVER = /\.(part|verify\.part|verify)$/i;

type DownloadState = 'Queued' | 'Downloading' | 'Paused' | 'Done' | 'Failed' | 'Cancelled';
interface DownloadRow { repo: string; file: string; state: DownloadState; received: number; total: number; mbPerSec: number; error?: string; note?: string; path?: string; pause?: boolean }

export interface QualityOutcome { score: number; correct: number; total: number; parts: Record<string, number>; error?: string }

export interface ModelFitDeps {
	ctx: HostContext;
	memento: vscode.Memento;
	modelsDir: string;
	/** Global storage root: the storage card accounts for every store under it, not just models. */
	storageDir: string;
	/** Where the engine builds and engine.json live, so Remove engine can delete them. */
	engineDir: string;
	appVersion: string;
	machine(): Machine;
	catalog: LocalCatalogHost;
	gguf(): LocalGguf[];
	measurements(): ModelMeasurement[];
	/** Load the model in zer0ne Engine and time it; the result is kept with zer0ne code's other measurements. */
	measure(id: string, signal: AbortSignal): Promise<ModelMeasurement | undefined>;
	quality(surface: HostSurface, id: string, onStage: (n: number, total: number) => void, signal: AbortSignal): Promise<QualityOutcome>;
	qualityScores(): Record<string, { score: number }>;
	/** zer0ne code's own download: verified parts, the projector and draft head, then the model is on in the picker. Resolves with an error, or nothing when done. */
	download(surface: HostSurface, repo: string, file: HfFile): Promise<string | undefined>;
	/** The running download for a key ("hf:repo/file"). */
	job(key: string): { received: number; total: number; rate: number; ctl: AbortController } | undefined;
	removeGguf(id: string): boolean;
	chatWith(surface: HostSurface, id: string): Promise<void>;
	ensureLoaded(id: string): Promise<void>;
	stopEngine(): void;
	engine(): { installed: boolean; version?: string; backend?: string; server?: string; running: boolean; model?: string; ctx?: number; gpu?: string };
	installEngine(surface: HostSurface): Promise<void>;
	engineLatest(): { build: string };
	hfToken(): Promise<string | undefined>;
	setHfToken(surface: HostSurface, token: string | undefined): Promise<void>;
	openExternal(target: string): void;
	saveImage(name: string): Promise<string | undefined>;
	clearMeasurements(): Promise<number>;
}

/** The fit words Models Fit Studio shows, from the rule both apps share. */
const LEVEL: Record<string, string> = { perfect: 'Perfect', good: 'Good', marginal: 'Marginal', slow: 'Slower', no: 'Too tight' };
const VERDICT: Record<string, string> = { perfect: 'runs', good: 'runs', marginal: 'tight', slow: 'slow', no: 'no' };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const paramsText = (p?: number) => (!p ? undefined : p >= 1e9 ? round(p / 1e9, p >= 1e10 ? 0 : 1) + 'B' : Math.round(p / 1e6) + 'M');

export class ModelFitHost {
	private readonly downloads = new Map<string, DownloadRow>();
	private bench?: { key: string; ctl: AbortController };
	private engineInstalling?: Promise<void>;

	constructor(private readonly d: ModelFitDeps) {}

	/** Messages from the page: { type: 'modelfit', id, cmd, args }. */
	async handle(surface: HostSurface, msg: any): Promise<boolean> {
		if (msg?.type !== 'modelfit') return false;
		const id = Number(msg.id) || 0, cmd = String(msg.cmd ?? ''), args = msg.args && typeof msg.args === 'object' ? msg.args : {};
		try {
			const data = await this.dispatch(surface, cmd, args);
			if (id) surface.post({ type: 'modelfitReply', id, ok: true, data });
		} catch (e) {
			if (id) surface.post({ type: 'modelfitReply', id, ok: false, error: e instanceof Error ? e.message : String(e) });
		}
		return true;
	}

	private push(type: string, data: unknown): void {
		this.d.ctx.postAll({ type: 'modelfitPush', push: type, data });
	}

	private async dispatch(surface: HostSurface, cmd: string, a: any): Promise<unknown> {
		const s = (k: string) => (typeof a[k] === 'string' ? a[k] : '');
		switch (cmd) {
			case 'ping': return { version: this.d.appVersion, llmfit: null };
			case 'log': case 'dumpDom': return { logged: true };
			case 'scanHardware': return this.hardware(true);
			case 'analyze': return this.analyze(s('input'));
			case 'hfSearch': return this.search(s('q'), s('sort') || 'downloads', s('format') || 'gguf', a.fitsOnly === true);
			case 'suggest': return this.suggest();
			case 'installed': return this.installed();
			case 'storageBreakdown': return this.storage();
			case 'purgeIncomplete': return this.purge();
			// zer0ne code keeps its models in its own folder; Models Fit Studio's is read beside it.
			case 'pickFolder': case 'setLibDir': return { ok: false, dir: this.d.modelsDir, freeGb: this.freeGb() };
			case 'deleteFile': return { ok: this.delete(s('repo'), s('file')) };
			case 'openFolder': this.d.openExternal(this.d.modelsDir); return { opened: true };
			case 'openUrl': if (/^https?:\/\//i.test(s('url'))) this.d.openExternal(s('url')); return { opened: true };
			case 'getSettings': return this.settings();
			case 'saveSettings': return this.saveSettings(surface, a);
			case 'download': return this.download(surface, s('repo'), s('file'), Number(a.size) || 0);
			case 'downloads': return { files: [...this.downloads.values()].map((r) => this.row(r)) };
			case 'pauseDownload': return { ok: this.pause(s('key')) };
			case 'cancelDownload': return { ok: this.cancel(s('key')) };
			case 'resumeDownload': return { ok: this.resume(surface, s('key')) };
			case 'resumeAllDownloads': return { resumed: [...this.downloads.keys()].filter((k) => this.resume(surface, k)).length };
			case 'discardDownload': return { ok: this.discard(s('key')) };
			case 'engineStatus': return this.engineStatus();
			case 'engineLatest': return { build: this.d.engineLatest().build, asset: 'zer0ne Engine', mb: 32 };
			case 'installEngine': return this.installEngine(surface);
			case 'removeEngine': return this.removeEngine();
			case 'nvidiaLatest': case 'installNvidia': throw new Error('zer0ne Engine picks the NVIDIA build by itself: Engine & more → Engine.');
			case 'cancelNvidia': case 'removeNvidia': return { ok: true };
			case 'measure': return this.measure(s('repo'), s('file'));
			case 'testQuality': return this.quality(surface, s('repo'), s('file'));
			case 'cancelMeasure': this.bench?.ctl.abort(); return { ok: true };
			case 'clearMeasurements': return { cleared: await this.d.clearMeasurements() };
			case 'runLocal': return this.run(surface, s('repo'), s('file'));
			case 'runList': return this.running();
			case 'runStop': {
				const g = this.find(s('repo'), s('file'));
				if (g && this.d.engine().model === g.id) { this.d.stopEngine(); this.push('running', this.running()); return { ok: true }; }
				return { ok: false };
			}
			case 'runOpen': {
				const g = this.find(s('repo'), s('file'));
				if (g) await this.d.chatWith(surface, g.id);
				return { ok: !!g };
			}
			case 'runTools': return this.tools(s('repo'), s('file'));
			case 'lmsImport': return this.lmsImport(s('repo'), s('file'));
			case 'saveImage': return this.saveImage(s('name') || 'battle.png', s('dataUrl'));
			case 'sharePrepare': case 'shareSend': return { ok: false, error: 'Sharing speeds with the llmfit community is done from the Models Fit Studio app.' };
			case 'shareCancel': return { ok: true };
		}
		throw new Error(`unknown command '${cmd}'`);
	}

	// ------------------------------------------------------------------ this machine

	private async hardware(recheck = false) {
		if (recheck || !this.d.catalog.check()) await this.d.catalog.recheckMachine().catch(() => undefined);
		const m = this.d.machine(), p = this.d.catalog.modelProfile(), check = this.d.catalog.check();
		const gpu = p.gpu === 'dedicated' ? 'discrete' : p.gpu === 'none' ? 'cpu' : 'integrated';
		const notes: string[] = [];
		if (check?.ramGBs) notes.push(`Memory reads at ${round(check.ramGBs)} GB/s, measured: speed estimates use it.`);
		if (gpu === 'integrated') notes.push('The graphics chip shares system memory: models up to the budget run on it at full speed, larger ones run slower.');
		const eng = this.d.engine();
		return {
			hw: {
				cpuName: m.cpu, cpuCores: m.cores, totalRamGb: round(m.totalMemoryBytes / GiB), freeRamGb: round(os.freemem() / GiB),
				gpuName: m.gpuName ?? '', hasGpu: gpu !== 'cpu', gpuCount: gpu === 'cpu' ? 0 : 1, unified: m.unifiedMemory, gpuClass: gpu,
				isNvidia: /nvidia/i.test(m.gpuName ?? ''), backend: eng.backend ? eng.backend[0].toUpperCase() + eng.backend.slice(1) : gpu === 'cpu' ? 'CPU' : 'Vulkan',
				budgetGb: round(p.fastBytes / GB), ceilingGb: round((p.ceilingBytes * FIT.ceiling) / GB),
				detectedVramGb: m.gpuMemoryBytes ? round(m.gpuMemoryBytes / GB) : 0, poolGb: m.gpuMemoryBytes ? round(m.gpuMemoryBytes / GB) : 0,
				poolFreeGb: 0, vramCorrected: false, correctedFrom: 0
			},
			notes
		};
	}

	// ------------------------------------------------------------------ one model, checked

	private async analyze(input: string) {
		const text = input.trim();
		const res: any = { ok: false, input: text, kind: 'hf', role: 'Chat / general', quants: [], notes: [], suggestions: [], mmprojFiles: [], draftFiles: [], downloads: 0, likes: 0, isMoe: false, quality: 0 };
		if (!text) { res.error = 'Paste a Hugging Face link or owner/model.'; return res; }
		const discovery = this.d.catalog.discovery;
		// A name is looked up: the first GGUF build Hugging Face finds for it is checked.
		let repo = hfRepoFromInput(text);
		if (!repo) {
			const found = (await searchHfPage(text, 'downloads', 5, 'gguf').catch(() => ({ items: [] as HfModel[] }))).items[0];
			if (!found) { res.error = `Nothing named "${text}" with a GGUF build on Hugging Face.`; return res; }
			repo = found.id;
		}
		try {
			const { info, files, offline } = await discovery.scan(repo);
			const profile = this.d.catalog.modelProfile(), support = await discovery.support(), machine = this.d.machine();
			const builds = modelFiles(files.filter((f) => !f.mmproj), info.params ? info.params / 1e9 : undefined);
			const shape: ModelShape = builds.length && !offline ? await discovery.shape(repo, builds[0]) : {};
			const seed = seedFromHub(info, discovery.find(repo), shape);
			const rated = fitHubFiles(info, files, profile, discovery.find(repo), support, shape).filter((f): f is Extract<typeof f, { fit: string }> => !f.mmproj && 'fit' in f);
			const projector = files.filter((f) => f.mmproj).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
			const head = offline ? undefined : await discovery.draftHead(repo, info);
			const measured = this.d.measurements(), quality = this.d.qualityScores(), have = this.d.gguf();
			Object.assign(res, {
				repoId: info.id, hfUrl: `https://huggingface.co/${info.id}`, baseModel: info.baseModel, modelName: info.id.split('/')[1].replace(/[-_]GGUF$/i, ''),
				provider: info.author, role: info.vision ? 'Vision + chat' : /cod(er|e)|devstral/i.test(info.id) ? 'Coding' : 'Chat / general',
				architecture: shape.arch ?? info.arch, paramsText: paramsText(info.params), paramsTotal: info.params,
				paramsActive: seed?.active ? seed.active * 1e9 : undefined, isMoe: !!seed?.active, contextMax: shape.context ?? info.context,
				license: info.license, downloads: info.downloads ?? 0, likes: info.likes ?? 0, quality: seed?.quality.coding ?? 0,
				estimateCalibrated: profile.measured, speedCalibrated: measured.some((r) => r.status === 'measured'),
				llmfitEstimateBasis: 'zer0ne Engine: memory from the file sizes and the model file\'s own header, speed from this computer\'s memory speed'
			});
			if (projector) res.mmprojFiles.push(projector.name);
			if (head) res.draftFiles.push(head.name);
			for (const f of rated.sort((a, b) => a.sizeBytes - b.sizeBytes)) {
				const r = f.rating;
				const g = have.find((x) => x.repo?.toLowerCase() === info.id.toLowerCase() && path.basename(x.path) === f.name);
				const m = g ? measured.find((x) => x.model === g.id && x.status === 'measured') : undefined;
				const unusable = f.fit === 'unsupported' || f.fit === 'too-large' || !r;
				// The architecture is known and this engine build cannot load it (not merely unknown or not cached).
				const engineUpdate = !f.assembly && !draftArchitecture(res.architecture) && f.fit === 'unsupported' && !!res.architecture && support.exact && !support.architectures.includes(res.architecture);
				const overMemory = f.sizeBytes > machine.totalMemoryBytes || r?.verdict === 'no';
				const compatibilityTitle = f.assembly ? 'Cannot run this download' : overMemory ? 'Exceeds this machine’s memory' : engineUpdate ? 'Not supported by this engine' : unusable ? 'Compatibility not confirmed' : undefined;
				const memoryHint = overMemory ? `The model weights alone are ${(f.sizeBytes / GB).toFixed(1)} GB; this PC has ${(machine.totalMemoryBytes / GiB).toFixed(1)} GiB of system RAM. An engine update cannot increase that memory. ` : '';
				const compatibilityHint = unusable ? memoryHint + (f.reason ?? 'No complete compatible chat model was found.') : undefined;
				const tok = unusable ? 0 : m?.tokS ?? r?.tokS ?? 0;
				res.quants.push({
					file: f.name, sizeGb: round(f.sizeBytes / GB, 2), sizeBytes: f.sizeBytes, quant: f.quant,
					fitLevel: f.assembly ? 'Requires assembly' : overMemory ? 'Too large' : engineUpdate ? 'Not supported' : unusable ? 'Unconfirmed' : LEVEL[r.verdict] ?? 'Unknown', unsupported: engineUpdate, blocked: unusable, compatibilityTitle, compatibilityHint, utilPct: r ? round(r.util * 100) : 0,
					estTps: round(tok), tpsLow: m ? round(tok) : round(tok * 0.8), tpsHigh: m ? round(tok) : round(tok * 1.15), measured: !unusable && !!m,
					firstTokenMs: m?.ttftMs ?? 0, qualityTested: g ? quality[g.id]?.score ?? 0 : 0,
					memoryRequiredGb: r ? round(r.needBytes / GB, 2) : round(f.sizeBytes / GB, 2), score: r?.score ?? 0,
					runMode: unusable || !r ? '' : profile.gpu === 'none' ? 'CPU' : r.verdict === 'slow' ? 'GPU + RAM' : 'GPU', usableContext: r?.ctx ?? 0,
					verdict: unusable ? 'no' : VERDICT[r.verdict] ?? 'no',
					// Why a build does not run well; zer0ne code's agent shortlist reasons are not about fit.
					reasons: f.reason && (unusable || r.verdict === 'slow' || r.verdict === 'marginal') ? [f.reason] : [], recommended: !unusable && !!f.recommended
				});
			}
			const primary = res.quants.find((q: any) => q.recommended) ?? res.quants.find((q: any) => q.verdict === 'runs') ?? res.quants.find((q: any) => q.verdict !== 'no') ?? res.quants[0];
			if (primary && !primary.blocked) primary.recommended = true;
			res.primary = primary;
			if (primary) {
				res.pickReason = primary.verdict === 'runs' ? 'The largest version that fits with room to spare and still writes at working pace.' : primary.verdict === 'no' ? 'No compatible runnable build was found for this computer.' : 'The version that needs the least of this computer.';
				if (!primary.blocked) {
					const plan = planTurbo({ name: info.id, sizeBytes: primary.sizeBytes, params: info.params, machine, context: res.contextMax, projectorBytes: projector?.sizeBytes, shape });
					res.turbo = { tier: plan.tier, label: plan.label, ctx: plan.context, kv: plan.kv, estTps: plan.estTokS, args: plan.flags.join(' '), suggestQuant: plan.suggestQuant ?? null, notes: plan.notes };
					res.serveCommand = `llama-server -m "${primary.file}" -c ${Math.min(res.contextMax || 8192, 16384)} --jinja --port 8080` + (projector ? ` --mmproj "${projector.name}"` : '') + (head ? ` --spec-type draft-mtp --spec-draft-model "${head.name}"` : '');
					res.downloadCommand = `hf download ${info.id} ${primary.file} --local-dir .`;
				}
			}
			if (res.isMoe) res.notes.push('MoE uses only some experts per token, but memory is estimated from the complete model weights, not the active parameter count.');
			if (projector) res.notes.push(`Vision files detected (${projector.name}): zer0ne code downloads the projector with the model.`);
			if (head) res.notes.push(`Draft head detected (${head.name}): zer0ne code downloads it with the model and uses it while Speed boost is on.`);
			if (offline) res.notes.push('Hugging Face could not be reached: these are the saved results.');
			if (!res.quants.length) {
				res.compatibilityTitle = 'No standalone chat model found';
				res.compatibilityHint = 'No complete runnable chat-model GGUF was found. Draft helpers such as DFlash, MTP and EAGLE need a matching main model and cannot run alone. Check the publisher’s model files and runtime requirements.';
				res.notes.push(res.compatibilityHint);
				res.suggestions.push(...(await discovery.builds(info.id).catch(() => [])).map((b) => b.id));
			}
			res.ok = true;
		} catch (e) {
			res.error = e instanceof Error ? e.message : String(e);
		}
		return res;
	}

	// ------------------------------------------------------------------ the model list

	private async search(q: string, sort: string, format: string, fitsOnly: boolean) {
		const fmt = format === 'all' ? 'any' : format === 'mlx' ? 'any' : 'gguf';
		try {
			const { items } = await searchHfPage(q, (['downloads', 'likes', 'lastModified', 'trendingScore'].includes(sort) ? sort : 'downloads') as any, 100, fmt as any);
			const profile = this.d.catalog.modelProfile(), discovery = this.d.catalog.discovery, support = await discovery.support();
			const rows = items.filter((m) => format !== 'mlx' || /mlx/i.test(m.id + ' ' + (m.tags ?? []).join(' '))).map((m) => {
				const rated = rateHubSearch(m, discovery.find(m.id), profile, support), r = rated.rating;
				const p = m.params;
				let estFit = 'est';
				if (r && m.format === 'gguf' && m.arch && support.exact && !support.architectures.includes(m.arch)) estFit = 'engine';
				else if (r && m.format === 'gguf') {
					if (r.verdict === 'perfect' || r.verdict === 'good') estFit = 'good';
					else if (r.verdict === 'marginal') estFit = 'marginal';
					// The usual build is too big; a 2-bit one may still fit with room to spare.
					else if (p && p * 0.42 + FIT.runtimeBytes <= profile.fastBytes * FIT.tight) estFit = 'small';
					else if (r.verdict === 'slow') estFit = 'slow';
					else estFit = 'tight';
				}
				const mem = r ? round(r.needBytes / GB) : 0;
				// The words Models Fit Studio's list uses (Core/HfCatalog.cs).
				const estFitText = ({ est: 'size unknown — run a check', good: `≈${mem} GB — fits`, marginal: `≈${mem} GB — very tight`, small: `≈${mem} GB as a smaller version`, slow: `≈${mem} GB — runs slower, partly from system memory`, tight: `≈${mem} GB — over budget`, engine: 'zer0ne Engine cannot run this architecture yet' } as Record<string, string>)[estFit];
				// tok/s means something only for a model that writes text, not for a detector or a voice.
				const writesText = !m.pipeline || /^(text-generation|text2text-generation|any-to-any)$|text-to-text$|image-text-to-text$/.test(m.pipeline);
				const runs = estFit !== 'tight' && estFit !== 'est' && estFit !== 'engine' && writesText && r;
				return {
					repoId: m.id, pipeline: m.pipeline ?? null, downloads: m.downloads ?? 0, likes: m.likes ?? 0, paramsB: p ? round(p / 1e9, 2) : null,
					estSizeGb: r ? round(r.downloadBytes / GB, 2) : p ? round((p * 4.85) / 8 / GB, 2) : 0, estFit, estFitText,
					memGb: r ? round(r.needBytes / GB, 2) : 0, tpsLow: runs ? round(r.tokS * 0.8) : 0, tpsHigh: runs ? round(r.tokS * 1.15) : 0,
					format: m.format === 'gguf' ? 'gguf' : /mlx/i.test(m.id) ? 'mlx' : m.format ?? 'other'
				};
			});
			const kept = fitsOnly ? rows.filter((x) => ['good', 'marginal', 'small', 'slow'].includes(x.estFit)) : rows;
			return { items: kept.slice(0, 48), error: null };
		} catch (e) {
			return { items: [], error: e instanceof Error ? e.message : String(e) };
		}
	}

	private async suggest() {
		const { profile, picks } = await this.d.catalog.suggestions();
		const out = picks.map(({ kind, model: m }) => ({ kind, repo: m.repo, name: m.origin.split('/').pop(), origin: m.origin, paramsB: m.paramsB, sizeGb: round(m.sizeGb, 2), memGb: round(m.memGb, 2), tpsLow: round(m.tpsLow), tpsHigh: round(m.tpsHigh), vision: !!m.vision }));
		return { budgetGb: round(profile.fastBytes / GB), picks: out };
	}

	// ------------------------------------------------------------------ the library

	/** Where a model sits, as the page names it: its repository and its file. */
	private repoOf(g: LocalGguf): string {
		return g.repo ?? (g.source === 'lmstudio' ? 'lmstudio/' + g.id : 'local/' + g.id);
	}
	private find(repo: string, file: string): LocalGguf | undefined {
		return this.d.gguf().find((g) => this.repoOf(g).toLowerCase() === repo.toLowerCase() && path.basename(g.path) === path.basename(file));
	}

	private installed() {
		const measured = this.d.measurements(), quality = this.d.qualityScores();
		const models = this.d.gguf();
		const helpers = scanGguf(this.d.modelsDir, true).filter(g => g.helper && g.source === 'zer0ne' && !models.some(m => this.repoOf(m) === this.repoOf(g) && path.basename(m.path) === path.basename(g.path)));
		const files = [...models, ...helpers].map((g) => {
			let written = '';
			try { written = fs.statSync(g.path).mtime.toISOString().slice(0, 19); } catch { /* listed a moment ago */ }
			const m = measured.find((x) => x.model === g.id && x.status === 'measured');
			return { chatCompatible: !g.helper && this.chatCompatible(this.repoOf(g), path.basename(g.path)), verification: g.helper ? 'Helper file · cannot run alone' : m ? 'Speed tested' : 'Downloaded · load not verified', repo: this.repoOf(g), file: path.basename(g.path), bytes: g.sizeBytes, complete: true, helper: !!g.helper, shared: false, written, path: g.path, measuredTps: g.helper ? 0 : m?.tokS ?? 0, qualityScore: g.helper ? 0 : quality[g.id]?.score ?? 0, firstTokenMs: g.helper ? 0 : m?.ttftMs ?? 0 };
		});
		return { root: this.d.modelsDir, freeGb: this.freeGb(), files };
	}

	private freeGb(): number {
		const free = freeDisk(this.d.modelsDir) ?? freeDisk(path.dirname(this.d.modelsDir));
		return free ? round(free / GB) : 0;
	}

	/** Every store under global storage the storage card accounts for: models alone are not the whole disk story. */
	private storeRoots(): Array<{ name: string; dir: string }> {
		return [
			{ name: 'models', dir: this.d.modelsDir },
			{ name: 'studio', dir: path.join(this.d.storageDir, 'studio') },
			{ name: 'voice', dir: path.join(this.d.storageDir, 'voice') },
			{ name: 'engine', dir: this.d.engineDir },
			{ name: 'converter', dir: path.join(this.d.storageDir, 'converter') },
			{ name: 'private-search', dir: path.join(this.d.storageDir, 'private-search') }
		].filter((r) => fs.existsSync(r.dir));
	}

	private walk(dir: string): Array<{ path: string; bytes: number }> {
		const out: Array<{ path: string; bytes: number }> = [];
		const walkDir = (d: string, depth: number) => {
			let list: fs.Dirent[] = [];
			try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
			for (const e of list) {
				const p = path.join(d, e.name);
				if (e.isDirectory() && depth < 4) walkDir(p, depth + 1);
				else if (e.isFile()) { try { out.push({ path: p, bytes: fs.statSync(p).size }); } catch { /* removed meanwhile */ } }
			}
		};
		walkDir(dir, 0);
		return out;
	}

	private storage() {
		const models = this.walk(this.d.modelsDir);
		const done = models.filter((f) => /\.gguf$/i.test(f.path));
		const roots = this.storeRoots().map(({ name, dir }) => {
			const files = this.walk(dir);
			const leftovers = files.filter((f) => LEFTOVER.test(f.path));
			return { name, gb: round(files.reduce((n, f) => n + f.bytes, 0) / GB, 2), leftoverGb: round(leftovers.reduce((n, f) => n + f.bytes, 0) / GB, 2), leftoverFileCount: leftovers.length };
		});
		return {
			totalModelGb: round(done.reduce((n, f) => n + f.bytes, 0) / GB, 2), incompletePartGb: round(models.filter((f) => /\.part$/i.test(f.path)).reduce((n, f) => n + f.bytes, 0) / GB, 2),
			completedFileCount: done.length, incompleteFileCount: roots.reduce((n, r) => n + r.leftoverFileCount, 0),
			totalGb: round(roots.reduce((n, r) => n + r.gb, 0), 2), leftoverGb: round(roots.reduce((n, r) => n + r.leftoverGb, 0), 2), roots,
			freeDiskGb: this.freeGb(), rootDir: this.d.modelsDir
		};
	}

	private purge() {
		const busy = new Set([...this.downloads.values()].filter((r) => r.state === 'Downloading' || r.state === 'Queued').map((r) => r.file));
		let count = 0, bytes = 0;
		for (const { dir } of this.storeRoots()) {
			for (const f of this.walk(dir).filter((x) => LEFTOVER.test(x.path))) {
				// A part still being written belongs to a running download.
				if ([...busy].some((name) => path.basename(f.path).startsWith(name))) continue;
				try { fs.rmSync(f.path, { force: true }); count++; bytes += f.bytes; } catch { /* in use */ }
			}
		}
		// Deletions leave empty owner/repo folders behind.
		for (const dir of [this.d.modelsDir, path.join(this.d.storageDir, 'studio', 'models')]) removeEmptyDirs(dir);
		return { count, reclaimedGb: round(bytes / GB, 2) };
	}

	private delete(repo: string, file: string): boolean {
		const g = this.find(repo, file);
		if (g) return this.d.removeGguf(g.id);
		const helper = scanGguf(this.d.modelsDir, true).find(g => g.helper && g.source === 'zer0ne' && this.repoOf(g) === repo && path.basename(g.path) === file);
		if (!helper) return false;
		try {
			const target = fs.realpathSync(helper.path), relative = path.relative(fs.realpathSync(this.d.modelsDir), target);
			if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
			const running = this.d.engine();
			if (running.running && this.d.gguf().some(g => g.id === running.model && [g.mmproj, g.draft].includes(helper.path))) return false;
			fs.unlinkSync(target);
			return true;
		} catch { return false; }
	}

	// ------------------------------------------------------------------ downloads

	private key(repo: string, file: string) { return `${repo}/${file}`; }

	private row(r: DownloadRow) {
		const job = this.d.job(`hf:${r.repo}/${r.file}`);
		if (job && r.state === 'Downloading') { r.received = job.received; r.total = job.total || r.total; r.mbPerSec = round((job.rate || 0) / 1e6); }
		return { key: this.key(r.repo, r.file), repo: r.repo, file: r.file, state: r.state, received: r.received, total: r.total, fraction: r.total ? Math.min(1, r.received / r.total) : 0, mbPerSec: r.mbPerSec, error: r.error ?? null, note: r.note ?? null, path: r.path ?? null };
	}

	/** zer0ne code's own downloads move the bars: called whenever one reports progress. */
	onJob(job: { key: string; received: number; total: number }): void {
		if (job.key === 'engine') { if (this.engineInstalling) this.push('engine', { received: job.received, total: job.total }); return; }
		const key = job.key;
		const m = /^hf:([^/]+\/[^/]+)\/(.+)$/.exec(key);
		const r = m && this.downloads.get(this.key(m[1], m[2]));
		if (r && r.state === 'Downloading') this.push('download', this.row(r));
	}

	private async download(surface: HostSurface, repo: string, file: string, size: number) {
		if (!repo || !file) return { started: false, error: 'No file was given.' };
		const have = this.find(repo, file);
		if (have) return { started: false, already: true, path: have.path };
		const existing = this.downloads.get(this.key(repo, file));
		if (existing && (existing.state === 'Queued' || existing.state === 'Downloading')) return { started: true };
		const row: DownloadRow = existing ?? { repo, file, state: 'Queued', received: 0, total: size, mbPerSec: 0 };
		Object.assign(row, { state: 'Queued', error: undefined, pause: false });
		this.downloads.set(this.key(repo, file), row);
		this.push('download', this.row(row));
		void this.runDownload(surface, row);
		return { started: true };
	}

	private async runDownload(surface: HostSurface, row: DownloadRow): Promise<void> {
		try {
			const discovery = this.d.catalog.discovery;
			const info = await discovery.info(row.repo, true);
			const target = (await discovery.files(row.repo, info, true)).find((f) => !f.mmproj && (f.name === row.file || f.parts.some((p) => p === row.file || path.posix.basename(p) === row.file)));
			if (!target) throw new Error('No standalone chat model matches this file. Check the model again.');
			if (target.assembly || helperBySize(target.name, target.sizeBytes)) throw new Error('This file is a helper or a raw split download, not a runnable chat model. Check the publisher’s main model and runtime requirements.');
			row.total = target.sizeBytes;
			row.state = 'Downloading';
			this.push('download', this.row(row));
			const error = await this.d.download(surface, row.repo, target);
			const done = this.find(row.repo, target.name);
			if (done) Object.assign(row, { state: 'Done', received: row.total, mbPerSec: 0, path: done.path });
			else if (row.pause) Object.assign(row, { state: 'Paused', mbPerSec: 0, note: 'The part already downloaded is kept.' });
			else if ((row.state as DownloadState) === 'Cancelled') row.mbPerSec = 0; // cancel() may have set it meanwhile
			else Object.assign(row, { state: 'Failed', mbPerSec: 0, error: error ?? 'The download stopped.' });
		} catch (e) {
			Object.assign(row, { state: 'Failed', mbPerSec: 0, error: e instanceof Error ? e.message : String(e) });
		}
		this.push('download', this.row(row));
		if (row.state === 'Done') this.push('installed', { repo: row.repo, file: row.file });
	}

	private active(key: string) {
		const r = this.downloads.get(key);
		return r && (r.state === 'Downloading' || r.state === 'Queued') ? r : undefined;
	}
	private pause(key: string): boolean {
		const r = this.active(key);
		if (!r) return false;
		r.pause = true;
		this.d.job(`hf:${key}`)?.ctl.abort();
		return true;
	}
	private cancel(key: string): boolean {
		const r = this.active(key);
		if (!r) return false;
		r.state = 'Cancelled';
		this.d.job(`hf:${key}`)?.ctl.abort();
		return true;
	}
	private resume(surface: HostSurface, key: string): boolean {
		const r = this.downloads.get(key);
		if (!r || !['Paused', 'Failed', 'Cancelled'].includes(r.state)) return false;
		Object.assign(r, { state: 'Queued', pause: false, error: undefined, note: undefined });
		this.push('download', this.row(r));
		void this.runDownload(surface, r);
		return true;
	}
	private discard(key: string): boolean {
		const r = this.downloads.get(key);
		if (!r) return false;
		this.d.job(`hf:${key}`)?.ctl.abort();
		this.downloads.delete(key);
		// The partial files of this one model only, inside zer0ne code's folder.
		const dir = path.join(this.d.modelsDir, ...r.repo.split('/'));
		const stem = path.posix.basename(r.file).replace(/\.gguf$/i, '');
		try { for (const f of fs.readdirSync(dir)) if (f.startsWith(stem) && LEFTOVER.test(f)) fs.rmSync(path.join(dir, f), { force: true }); } catch { /* nothing on disk */ }
		this.push('downloadRemoved', { key });
		return true;
	}

	// ------------------------------------------------------------------ the engine

	private engineStatus() {
		const e = this.d.engine();
		const m = this.d.machine();
		return {
			installed: e.installed, source: 'zer0ne Engine', build: e.version ?? null, removable: e.installed && !e.running, serverPath: e.server ?? null,
			nvidia: { card: false, active: e.backend === 'cuda', build: null, cuda: null, text: /nvidia/i.test(m.gpuName ?? '') ? 'zer0ne Engine uses the NVIDIA build on this card by itself.' : '', removable: false },
			measurements: this.d.measurements().filter((r) => r.status === 'measured').length,
			calibrated: this.d.measurements().some((r) => r.status === 'measured')
		};
	}

	/**
	 * Delete the downloaded engine builds (current and rollback). A load in any
	 * window keeps the DLLs locked on Windows, so this stops this window's idle
	 * server first and reports instead of half-deleting.
	 */
	private removeEngine(): { ok: boolean } {
		const e = this.d.engine();
		if (!e.installed) throw new Error('zer0ne Engine is not installed.');
		if (e.running) throw new Error('A model is running in zer0ne Engine. Stop it first.');
		this.d.stopEngine();
		const meta = installedEngine(this.d.engineDir);
		const top = (p: string) => path.resolve(this.d.engineDir, path.relative(this.d.engineDir, p).split(/[\\/]/)[0]);
		const targets = new Set<string>();
		for (const b of [meta, meta?.previous]) { try { targets.add(top(b!.server)); } catch { /* no server path */ } }
		for (const dir of targets) {
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { throw new Error('The engine files are in use by another window. Close it and try again.'); }
		}
		try { fs.rmSync(path.join(this.d.engineDir, 'engine.json'), { force: true }); } catch { /* already gone */ }
		removeEmptyDirs(this.d.engineDir);
		this.push('engine', { removed: true });
		return { ok: true };
	}

	private async installEngine(surface: HostSurface) {
		if (this.d.engine().installed) return { ok: true, build: this.d.engine().version };
		this.engineInstalling ??= this.d.installEngine(surface).finally(() => { this.engineInstalling = undefined; });
		await this.engineInstalling;
		const e = this.d.engine();
		if (!e.installed) throw new Error('zer0ne Engine could not be installed. See Engine & more → Engine.');
		return { ok: true, build: e.version };
	}

	// ------------------------------------------------------------------ speed and quality

	private async measure(repo: string, file: string) {
		if (!this.chatCompatible(repo, file)) return { started: false, error: 'This speed test requires a chat language model.' };
		if (this.bench) return { started: false, error: 'Another model is being measured. Wait for it to finish.' };
		const g = this.find(repo, file);
		if (!g) return { started: false, error: 'Download this file first: a real measurement runs it.' };
		if (!this.d.engine().installed) return { started: false, needEngine: true };
		const key = this.key(repo, file), ctl = new AbortController();
		this.bench = { key, ctl };
		void (async () => {
			try {
				this.push('bench', { key, repo, file, phase: 'loading', run: 0, runs: 1 });
				const began = Date.now();
				const timer = setInterval(() => this.push('bench', { key, repo, file, phase: 'measuring', run: 1, runs: 1 }), 4000);
				let m: ModelMeasurement | undefined;
				try { m = await this.d.measure(g.id, ctl.signal); } finally { clearInterval(timer); }
				if (ctl.signal.aborted) { this.push('bench', { key, repo, file, phase: 'cancelled' }); return; }
				if (!m || m.status !== 'measured') throw new Error(m?.error ?? 'The speed check did not finish.');
				this.push('bench', { key, repo, file, phase: 'done', genTps: m.tokS, promptTps: m.promptTokS ?? 0, firstTokenMs: m.ttftMs ?? 0, loadSeconds: round((Date.now() - began) / 1000), fallback: m.backend === 'cpu' && this.d.machine().gpuName ? true : false });
			} catch (e) {
				this.push('bench', ctl.signal.aborted ? { key, repo, file, phase: 'cancelled' } : { key, repo, file, phase: 'failed', error: e instanceof Error ? e.message : String(e) });
			} finally {
				this.bench = undefined;
			}
		})();
		return { started: true, key };
	}

	private async quality(surface: HostSurface, repo: string, file: string) {
		if (!this.chatCompatible(repo, file)) return { started: false, error: 'This quality test requires a chat language model.' };
		if (this.bench) return { started: false, error: 'Another model is being measured. Wait for it to finish.' };
		const g = this.find(repo, file);
		if (!g) return { started: false, error: 'Download this file first: the test runs it.' };
		if (!this.d.engine().installed) return { started: false, needEngine: true };
		const key = this.key(repo, file), ctl = new AbortController(), kind = 'quality';
		this.bench = { key, ctl };
		void (async () => {
			try {
				this.push('bench', { key, repo, file, kind, phase: 'loading', run: 0, runs: 40 });
				const r = await this.d.quality(surface, g.id, (n, total) => this.push('bench', { key, repo, file, kind, phase: 'testing', run: n, runs: total }), ctl.signal);
				if (ctl.signal.aborted || r.error === 'Cancelled.') { this.push('bench', { key, repo, file, kind, phase: 'cancelled' }); return; }
				if (r.error) throw new Error(r.error);
				this.push('bench', { key, repo, file, kind, phase: 'done', quality: r.score, correct: r.correct, total: r.total, parts: r.parts });
			} catch (e) {
				this.push('bench', { key, repo, file, kind, phase: 'failed', error: e instanceof Error ? e.message : String(e) });
			} finally {
				this.bench = undefined;
			}
		})();
		return { started: true, key };
	}

	// ------------------------------------------------------------------ running

	private running() {
		const e = this.d.engine();
		if (!e.running || !e.model) return [];
		const g = this.d.gguf().find((x) => x.id === e.model);
		return g ? [{ repo: this.repoOf(g), file: path.basename(g.path), url: '', ready: true, context: e.ctx ?? 0, gpu: e.gpu !== 'cpu' }] : [];
	}

	/** Run = zer0ne Engine loads it, it is on in Providers & models, and the chat opens with it. */
	private chatCompatible(repo: string, file: string): boolean {
		const g = this.find(repo, file);
		if (helperBySize(file, g?.sizeBytes ?? 0) || (g && readModelShape(g.path).draft)) return false;
		return !/(?:^|[\/_ .-])(whisper|asr|tts|embedding|embeddings|reranker|stable-diffusion|flux|mmproj)(?:[\/_ .-]|$)/i.test(repo + '/' + file); }
	private async run(surface: HostSurface, repo: string, file: string) {
		if (!this.chatCompatible(repo, file)) return { ok: false, error: 'This is a speech, image, embedding or helper model. Choose a chat language model here.' };
		const g = this.find(repo, file);
		if (!g) return { ok: false, error: 'Download this file first.' };
		try {
			await this.d.ensureLoaded(g.id);
			await this.d.chatWith(surface, g.id);
			this.push('running', this.running());
			return { ok: true, url: '' };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	private tools(repo: string, file: string) {
		const g = this.find(repo, file), e = this.d.engine();
		const lms = lmsPath();
		let mode = '--copy';
		try { if (lms && g && fs.statSync(g.path).dev === fs.statSync(os.homedir()).dev) mode = '--hard-link'; } catch { /* a copy is always possible */ }
		return { path: g?.path ?? '', hasGpu: this.d.catalog.modelProfile().gpu !== 'none', engine: e.installed, serverPath: e.server ?? null, lms: !!lms, lmsMode: mode, ollama: false };
	}

	private async lmsImport(repo: string, file: string) {
		const g = this.find(repo, file), lms = lmsPath();
		if (!g) return { ok: false, error: 'Download this file first.' };
		if (!lms) return { ok: false, error: 'LM Studio\'s command-line tool is not on this computer.' };
		const { lmsMode } = this.tools(repo, file);
		return new Promise((resolve) => {
			let said = '';
			const p = spawn(lms, ['import', g.path, lmsMode, '--user-repo', repo, '-y'], { windowsHide: true });
			p.stdout?.on('data', (c) => (said += c)); p.stderr?.on('data', (c) => (said += c));
			const stop = setTimeout(() => p.kill(), 10 * 60_000);
			p.on('error', (e) => { clearTimeout(stop); resolve({ ok: false, error: 'LM Studio\'s tool did not run: ' + e.message }); });
			p.on('exit', (code) => { clearTimeout(stop); resolve(code === 0 ? { ok: true, error: '' } : { ok: false, error: said.trim().split('\n').pop() || 'LM Studio did not take the file.' }); });
		});
	}

	// ------------------------------------------------------------------ settings

	private async settings() {
		const token = await this.d.hfToken();
		return { minimizeToTrayOnClose: false, startWithWindows: false, hfToken: token ?? null, theme: 'default', language: this.d.memento.get<string>('zer0ne.modelfit.language', 'en') };
	}

	private async saveSettings(surface: HostSurface, a: any) {
		if ('hfToken' in a) await this.d.setHfToken(surface, typeof a.hfToken === 'string' && a.hfToken.trim() ? a.hfToken.trim() : undefined);
		if (typeof a.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(a.language)) await this.d.memento.update('zer0ne.modelfit.language', a.language);
		return { ok: true, settings: await this.settings() };
	}

	private async saveImage(name: string, dataUrl: string) {
		if (!dataUrl.startsWith('data:image/png;base64,')) return { ok: false, error: 'No picture was given.' };
		const target = await this.d.saveImage(name.replace(/[\\/:*?"<>|]/g, '_'));
		if (!target) return { ok: false, cancelled: true };
		fs.writeFileSync(target, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
		return { ok: true, path: target, copied: false };
	}
}

