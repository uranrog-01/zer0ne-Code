import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import type { Machine } from './localModels';
import type { Profile } from './localCatalog';
import { download, digestMatches, validRepoId } from './localEngine';
import { scrubEnv } from './tools/proc';
import type { LlmfitFitRow } from './suggest';

export const ADVISOR_VERSION = 'v1.1.17';
const RELEASES: Record<string, [string, string]> = {
	'win32-x64': ['x86_64-pc-windows-msvc.zip', '661b6ea57d835f681fbabcf3366649ff681d0081267fd3a05db254e67af6073f'],
	'win32-arm64': ['aarch64-pc-windows-msvc.zip', '639695966d90559a0cd2b27d42fcad2079bbada7cb553663ce6818f536a2c0e9'],
	'darwin-arm64': ['aarch64-apple-darwin.tar.gz', '294abbb9faa62315acbdb5ee55a2558f327c98df6644922d493d1dde1518a858'],
	'darwin-x64': ['x86_64-apple-darwin.tar.gz', 'a859d79292e961e9b9ed21b29bbeb787206c036668a7ec833f23c26e5ef7ca45'],
	'linux-x64': ['x86_64-unknown-linux-gnu.tar.gz', '76915a48416aa1bfc6c2d481a951e0ae38b690a9d849eb8b9af136c281bcea95'],
	'linux-arm64': ['aarch64-unknown-linux-gnu.tar.gz', 'a43cba391f98132f8696dd73c828fdba3942d62fcdd5daca6dc1ed0621619ea2']
};
export const TRUSTED_MODEL_REPO = /^(unsloth|bartowski|lmstudio-community|ggml-org|Qwen|google|mistralai|microsoft|ibm-granite|nvidia|openai|zai-org|deepseek-ai|LiquidAI|HuggingFaceTB|allenai)\//i;

export interface AdvisorModel {
	name: string;
	parameters_raw: number;
	active_parameters?: number;
	context_length: number;
	use_case?: string;
	capabilities?: string[];
	architecture?: string;
	hf_downloads?: number;
	release_date?: string;
	license?: string;
	gguf_sources?: Array<{ repo: string }>;
	num_hidden_layers?: number;
	num_key_value_heads?: number;
	head_dim?: number;
}
export interface AdvisorFit {
	name: string;
	quant: string;
	quality: number;
	score: number;
	tokS?: number;
	context: number;
	confidence: string;
	ggufSources: string[];
}

export function advisorFits(value: unknown): AdvisorFit[] {
	const rows = (value as { models?: unknown[] })?.models;
	if (!Array.isArray(rows)) throw new Error('The model advisor returned an invalid response.');
	return rows.slice(0, 1000).flatMap((row: any) => {
		// A forced runtime can still label native FP4 weights as llama.cpp; those are not GGUF downloads.
		if (!validRepoId(row?.name) || !/^(llamacpp|llama\.cpp)$/i.test(row.runtime ?? '') || !/^(Q[2-8]_|IQ[1-4]_)/i.test(row.best_quant ?? '') || !Number.isFinite(row.score)) return [];
		return [{ name: row.name, quant: row.best_quant, quality: Number.isFinite(row.score_components?.quality) ? row.score_components.quality : 40, score: row.score,
			tokS: Number.isFinite(row.estimated_tps) && row.estimated_tps > 0 ? row.estimated_tps : undefined,
			context: Math.max(512, Math.min(32768, Number(row.effective_context_length) || 8192)), confidence: String(row.estimate_confidence ?? 'estimated'),
			ggufSources: (Array.isArray(row.gguf_sources) ? row.gguf_sources : []).map((s: any) => s.repo).filter(validRepoId) }];
	});
}

let snapshot: AdvisorModel[] | undefined;
export function advisorCatalog(): AdvisorModel[] {
	if (!snapshot) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'llmfit-catalog.json'), 'utf8'));
			snapshot = raw.version === ADVISOR_VERSION && Array.isArray(raw.models) ? raw.models.filter((m: any) => validRepoId(m.name) && Number.isFinite(m.parameters_raw) && m.parameters_raw >= 3e8 && m.parameters_raw <= 400e9) : [];
		} catch { snapshot = []; }
	}
	return snapshot!;
}

export function advisorProfile(machine: Machine, p: Profile) {
	const shared = p.gpu === 'shared' || p.gpu === 'unified';
	return { schema_version: 1, name: 'zer0ne-machine', hardware: {
		total_ram_gb: Math.max(0.5, (shared ? p.fastBytes : p.ceilingBytes) / 1024 ** 3), unified_memory: shared,
		ddr_bandwidth_gbps: Math.max(1, p.cpuGBs), ...(p.gpu !== 'none' ? { gpu_memory_bandwidth_gbps: Math.max(1, p.gpuGBs) } : {})
	} };
}

function run(file: string, args: string[], signal: AbortSignal, timeout = 60_000, maxBuffer = 16 * 1024 ** 2): Promise<string> {
	return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, env: scrubEnv(), signal, timeout, maxBuffer }, (err, stdout, stderr) => err ? reject(new Error(signal.aborted ? 'Model discovery cancelled.' : String(stderr || err.message).slice(0, 300))) : resolve(stdout)));
}

export class LocalAdvisor {
	private installing?: Promise<string>;
	private ctl = new AbortController();
	private cached?: { key: string; at: number; fits: AdvisorFit[] };
	private fitCache?: { budget: string; at: number; rows: LlmfitFitRow[] };
	error?: string;
	constructor(private readonly dir: string) {}
	get supported(): boolean { return !!RELEASES[`${process.platform}-${process.arch}`]; }
	private bundledChecked?: { key: string; ok: boolean };
	private binary(): string | undefined {
		const exe = process.platform === 'win32' ? 'llmfit.exe' : 'llmfit';
		const bundled = path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`, exe);
		if (fs.existsSync(bundled) && this.bundledIntact(bundled, exe)) return bundled;
		const downloaded = path.join(this.dir, ADVISOR_VERSION, exe);
		return fs.existsSync(downloaded) ? downloaded : undefined;
	}
	/** The bundled binary runs only when it matches the digest shipped beside it in SHA256SUMS. */
	private bundledIntact(file: string, exe: string): boolean {
		const stat = fs.statSync(file), key = `${stat.size}:${stat.mtimeMs}`;
		if (this.bundledChecked?.key === key) return this.bundledChecked.ok;
		let ok = false;
		try {
			const line = fs.readFileSync(path.join(path.dirname(file), 'SHA256SUMS'), 'utf8').split(/\r?\n/).find((l) => l.trim().endsWith(' ' + exe));
			const digest = line?.trim().split(/\s+/)[0];
			ok = !!digest && digestMatches(file, 'sha256:' + digest);
		} catch { ok = false; }
		if (!ok) this.error = 'The bundled model advisor failed its checksum and was not started.';
		this.bundledChecked = { key, ok };
		return ok;
	}
	state() { return { version: ADVISOR_VERSION, supported: this.supported, installed: !!this.binary(), running: !!this.installing, error: this.error }; }
	dispose() { this.ctl.abort(); }
	private ensure(): Promise<string> {
		const binary = this.binary();
		if (binary) return Promise.resolve(binary);
		if (this.installing) return this.installing;
		this.installing = this.install().finally(() => { this.installing = undefined; });
		return this.installing;
	}
	private async install(): Promise<string> {
		const asset = RELEASES[`${process.platform}-${process.arch}`];
		if (!asset) throw new Error('No model advisor build for this system; the bundled catalog remains available.');
		const [suffix, digest] = asset, name = `llmfit-${ADVISOR_VERSION}-${suffix}`;
		const dir = path.join(this.dir, ADVISOR_VERSION);
		fs.mkdirSync(dir, { recursive: true });
		const archive = path.join(dir, name);
		await download(`https://github.com/AlexsJones/llmfit/releases/download/${ADVISOR_VERSION}/${name}`, archive, () => {}, this.ctl.signal);
		if (digestMatches(archive, 'sha256:' + digest) !== true) { fs.rmSync(archive, { force: true }); throw new Error('The model advisor download failed checksum verification.'); }
		const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
		await run(tar, ['-xf', archive, '-C', dir, '--strip-components=1'], this.ctl.signal);
		fs.rmSync(archive, { force: true });
		const binary = this.binary();
		if (!binary) throw new Error('The downloaded model advisor has no executable.');
		if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
		await run(binary, ['--version'], this.ctl.signal);
		return binary;
	}
	/**
	 * Every model llmfit rates for this computer, asked the way Models Fit Studio asks (its own
	 * hardware detection, the memory budget given): Suggest reads both apps' picks from it.
	 */
	async fit(budgetGb: number): Promise<LlmfitFitRow[]> {
		const budget = budgetGb > 0 ? String(Math.round(budgetGb * 10) / 10) : '';
		if (this.fitCache?.budget === budget && Date.now() - this.fitCache.at < 6 * 3600_000) return this.fitCache.rows;
		const binary = await this.ensure();
		const raw = await run(binary, [...(budget ? [`--memory=${budget}G`] : []), 'fit', '--json', '-n', '6000'], this.ctl.signal, 90_000, 64 * 1024 ** 2);
		const rows = (JSON.parse(raw) as { models?: LlmfitFitRow[] }).models;
		if (!Array.isArray(rows)) throw new Error('The model advisor returned an invalid response.');
		this.fitCache = { budget, at: Date.now(), rows };
		return rows;
	}
	async recommendations(machine: Machine, p: Profile): Promise<AdvisorFit[]> {
		const profile = advisorProfile(machine, p);
		const key = JSON.stringify([profile, machine.cpu, machine.gpuName, machine.gpuMemoryBytes, machine.cores]);
		if (this.cached?.key === key && Date.now() - this.cached.at < 6 * 3600_000) return this.cached.fits;
		const folder = path.join(this.dir, 'profiles');
		const name = 'zer0ne-' + crypto.randomUUID();
		const file = path.join(folder, name + '.json');
		try {
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ ...profile, name }));
			const binary = await this.ensure();
			// llmfit 1.1.17 rejects --profile with --force-runtime. Runtime filtering still excludes MLX/vLLM rows.
			const args = p.gpu === 'dedicated' ? ['--ram', `${Math.max(0.5, (p.availableRamBytes ?? p.ramBytes * 0.8) / 1024 ** 3).toFixed(2)}G`, '--memory', `${(p.fastBytes / 1024 ** 3).toFixed(2)}G`, '--cpu-cores', String(machine.cores)] : ['--profile', file];
			const raw = await run(binary, [...args, '--max-context', '8192', 'recommend', '--runtime', 'llamacpp', '--limit', '250', '--json', '--no-dashboard'], this.ctl.signal);
			const fits = advisorFits(JSON.parse(raw));
			this.cached = { at: Date.now(), key, fits }; this.error = undefined;
			return fits;
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			return [];
		} finally { try { fs.rmSync(file, { force: true }); } catch { /* Cleanup must not hide an advisor failure. */ } }
	}
}
