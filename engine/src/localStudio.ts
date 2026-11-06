import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { acquireRuntimeLease } from './runtimeLease';
import * as zlib from 'zlib';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { digestMatches, download, engineEnv, hfFileMeta, verifiedHfDownload, type DownloadProgress } from './localEngine';
import type { DiffusionBundle, DiffusionRole } from './localCatalog';

/**
 * zer0ne Studio — images and videos on this computer with
 * stable-diffusion.cpp (MIT; ggml, like llama.cpp): one small engine for
 * every OS and GPU (Vulkan on NVIDIA / AMD / Intel, Metal on Apple Silicon,
 * CPU), started as `sd-server` with one model bundle, driven through its
 * native async API (`/sdcpp/v1/img_gen` and `/vid_gen` jobs, base64 results).
 *
 * Same rules as zer0ne Engine: a tested build by default, checked against
 * GitHub's SHA-256, started once (`--version`) before it is kept; downloads
 * resume; nothing runs in the background when the Studio is closed.
 */

/** The stable-diffusion.cpp build zer0ne is tested with (bump after a live generation on the new build). */
export const STUDIO_PIN = 'master-929-3f8527a';
const RELEASE_TAG = (tag: string) => (process.env.ZER0NE_SD_TAG_URL || 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/tags/{tag}').replace('{tag}', encodeURIComponent(tag));
const RELEASES = () => process.env.ZER0NE_SD_RELEASES || 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=6';

export type StudioBackend = 'vulkan' | 'cuda' | 'rocm' | 'metal' | 'cpu';

export interface StudioInstall {
	version: string;
	backend: StudioBackend;
	server: string;
}

/**
 * Pure: the release asset for this system. Vulkan by default on Windows and
 * Linux — one 30 MB build for every GPU vendor (CUDA needs ~900 MB of
 * runtimes); Metal on Apple Silicon. undefined = no build for this system
 * (Linux on ARM, Intel Macs, Windows on ARM).
 */
export function pickStudioAsset(names: string[], backend: StudioBackend, platform = process.platform, arch = process.arch): string | undefined {
	const find = (re: RegExp) => names.find((n) => re.test(n));
	if (platform === 'darwin') return arch === 'arm64' ? find(/^sd-.+-bin-Darwin-macOS-[\d.]+-arm64\.zip$/) : undefined;
	if (arch !== 'x64') return undefined;
	if (platform === 'win32') {
		if (backend === 'cuda') return find(/^sd-.+-bin-win-cuda\d*-x64\.zip$/);
		if (backend === 'rocm') return find(/^sd-.+-bin-win-rocm-[\d.]+-x64\.zip$/);
		if (backend === 'cpu') return find(/^sd-.+-bin-win-(cpu|avx2)-x64\.zip$/);
		return find(/^sd-.+-bin-win-vulkan-x64\.zip$/);
	}
	if (platform === 'linux') {
		if (backend === 'rocm') return find(/^sd-.+-bin-Linux-Ubuntu-[\d.]+-x86_64-rocm-[\d.]+\.zip$/);
		if (backend === 'cpu') return find(/^sd-.+-bin-Linux-Ubuntu-[\d.]+-x86_64\.zip$/);
		return find(/^sd-.+-bin-Linux-Ubuntu-[\d.]+-x86_64-vulkan\.zip$/);
	}
	return undefined;
}

/** Can the Studio run on this system at all (a build exists)? */
export function studioSupported(platform = process.platform, arch = process.arch): boolean {
	return platform === 'darwin' ? arch === 'arm64' : arch === 'x64' && (platform === 'win32' || platform === 'linux');
}

export function autoStudioBackend(platform = process.platform): StudioBackend {
	return platform === 'darwin' ? 'metal' : 'vulkan';
}

export function installedStudio(dir: string): StudioInstall | undefined {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(dir, 'studio.json'), 'utf8')) as StudioInstall;
		return fs.existsSync(meta.server) ? meta : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pure enough: unpack a .zip with Node alone (stored + deflate entries) —
 * the release archives are zips on every OS, and Linux has no tar that reads
 * zip by default. Entries that would land outside `dest` are refused.
 */
export function unzip(archive: string, dest: string): string[] {
	const buf = fs.readFileSync(archive);
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('Not a zip archive.');
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const root = path.resolve(dest);
	const out: string[] = [];
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip directory.');
		const method = buf.readUInt16LE(p + 10);
		const csize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const attrs = buf.readUInt32LE(p + 38);
		const local = buf.readUInt32LE(p + 42);
		const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;
		const target = path.resolve(root, name);
		if (!target.startsWith(root + path.sep) && target !== root) throw new Error(`Refusing a zip entry outside the folder: ${name}`);
		if (name.endsWith('/')) {
			fs.mkdirSync(target, { recursive: true });
			continue;
		}
		const lNameLen = buf.readUInt16LE(local + 26);
		const lExtraLen = buf.readUInt16LE(local + 28);
		const start = local + 30 + lNameLen + lExtraLen;
		const raw = buf.subarray(start, start + csize);
		const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : undefined;
		if (!data) throw new Error(`Unsupported zip compression (${method}) for ${name}.`);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, data);
		// Unix permissions live in the high 16 bits: keep executables executable.
		const mode = attrs >>> 16;
		if (process.platform !== 'win32' && mode & 0o111) fs.chmodSync(target, 0o755);
		out.push(target);
	}
	return out;
}

/** Does this sd-server start here? `--version` loads its libraries and exits at once. */
export function studioSmoke(server: string): { ok: boolean; detail: string } {
	const r = spawnSync(server, ['--version'], { timeout: 60_000, windowsHide: true, cwd: path.dirname(server), env: engineEnv(server), encoding: 'utf8' });
	const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
	if (r.error) return { ok: false, detail: r.error.message };
	return r.status === 0 && /stable-diffusion|commit/i.test(out) ? { ok: true, detail: out.split('\n').pop()!.trim() } : { ok: false, detail: out.slice(-240) || `exit code ${r.status}` };
}

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
	return res.json();
}

/** Download, verify, unpack and start-check the Studio engine. The previous build is replaced only after the new one starts. */
export async function installStudio(dir: string, backend: StudioBackend, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal, opts: { smoke?: typeof studioSmoke } = {}): Promise<StudioInstall> {
	const release = acquireRuntimeLease(dir);
	if (!release) throw new Error('This runtime is being installed or maintained in another project. Retry shortly.');
	try { return await installStudioUnlocked(dir, backend, onProgress, signal, opts); }
	finally { release(); }
}

async function installStudioUnlocked(dir: string, backend: StudioBackend, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal, opts: { smoke?: typeof studioSmoke }): Promise<StudioInstall> {
	if (!studioSupported()) throw new Error(`stable-diffusion.cpp publishes no build for ${process.platform}-${process.arch}.`);
	onProgress({ received: 0, total: 0, bytesPerSec: 0, stage: `Finding the tested stable-diffusion.cpp build…` });
	let rel: any = await getJson(RELEASE_TAG(STUDIO_PIN)).catch(() => undefined);
	let name = rel ? pickStudioAsset((rel.assets ?? []).map((a: any) => a.name), backend) : undefined;
	if (!name) {
		const list = await getJson(RELEASES());
		for (const r of Array.isArray(list) ? list : []) {
			name = pickStudioAsset((r.assets ?? []).map((a: any) => a.name), backend);
			if (name) {
				rel = r;
				break;
			}
		}
	}
	if (!rel || !name) throw new Error(`stable-diffusion.cpp has no ${backend} build for this system.`);
	const asset = rel.assets.find((a: any) => a.name === name);
	fs.mkdirSync(dir, { recursive: true });
	const archive = path.join(dir, name);
	await download(asset.browser_download_url, archive, (p) => onProgress({ ...p, stage: `Downloading ${name}` }), signal, asset.size);
	if (digestMatches(archive, asset.digest) !== true) {
		fs.rmSync(archive, { force: true });
		throw new Error(`The downloaded ${name} does not match the checksum GitHub publishes, so it was deleted and not installed.`);
	}
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Unpacking…' });
	const target = path.join(dir, `${rel.tag_name}-${backend}`);
	fs.rmSync(target, { recursive: true, force: true });
	try {
		unzip(archive, target);
	} finally {
		fs.rmSync(archive, { force: true });
	}
	const exe = process.platform === 'win32' ? 'sd-server.exe' : 'sd-server';
	const server = findFile(target, exe);
	if (!server) {
		fs.rmSync(target, { recursive: true, force: true });
		throw new Error('sd-server was not found in the downloaded build.');
	}
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Checking that it starts…' });
	const smoke = (opts.smoke ?? studioSmoke)(server);
	if (!smoke.ok) {
		fs.rmSync(target, { recursive: true, force: true });
		throw new Error(`The ${backend} build does not start on this machine (${smoke.detail}). Try the CPU build.`);
	}
	const meta: StudioInstall = { version: String(rel.tag_name), backend, server };
	fs.writeFileSync(path.join(dir, 'studio.json'), JSON.stringify(meta, null, 2));
	// The old build's folder is dropped only now that the new one started; every other leftover build folder goes too.
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory() && path.join(dir, e.name) !== target) { try { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); } catch { /* in use */ } }
	}
	return meta;
}

function findFile(dir: string, name: string): string | undefined {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, e.name);
		if (e.isFile() && e.name === name) return full;
		if (e.isDirectory()) {
			const hit = findFile(full, name);
			if (hit) return hit;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------- model bundles

/**
 * Where a bundle file lives: `<models>/<owner>--<repo>/<file name>`. Shared files (one VAE,
 * one text encoder) are stored once. Flat on purpose: repo sub-folders such as
 * `split_files/diffusion_models/` pushed paths past Windows' 260-character limit, and
 * sd.cpp then cannot open the file (seen with Wan 2.1).
 */
export function bundleFilePath(modelsDir: string, f: { repo: string; file: string }): string {
	return path.join(modelsDir, f.repo.replace('/', '--'), path.posix.basename(f.file));
}

/** Which of a bundle's files are already on disk (complete, not .part). */
export function bundleState(modelsDir: string, b: DiffusionBundle): { installed: boolean; missingBytes: number } {
	let missing = 0;
	for (const f of b.files) {
		const p = bundleFilePath(modelsDir, f);
		if (!fs.existsSync(p)) missing += f.bytes;
	}
	return { installed: missing === 0, missingBytes: missing };
}

/** Download every missing file of a bundle (resumable; progress over the whole bundle). */
export async function downloadBundle(modelsDir: string, b: DiffusionBundle, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal): Promise<void> {
	const total = b.files.reduce((n, f) => n + f.bytes, 0);
	let done = 0;
	for (const f of b.files) {
		const dest = bundleFilePath(modelsDir, f);
		const label = roleLabel(f.role);
		// The Hub publishes the file's size and SHA-256: check both, so a truncated
		// file is never kept as if it were complete.
		const meta = await hfFileMeta(f.repo, f.file);
		if (!meta) throw new Error(`Hugging Face does not list ${f.file} in ${f.repo} any more.`);
		await verifiedHfDownload(f.repo, { path: f.file, size: meta.size, sha256: meta.sha256 }, undefined, dest, (p) => onProgress({ received: done + p.received, total, bytesPerSec: p.bytesPerSec, stage: `${label} · ${path.posix.basename(f.file)}` }), signal);
		done += f.bytes;
	}
	onProgress({ received: total, total, bytesPerSec: 0, stage: 'Ready' });
}

export function roleLabel(role: DiffusionRole): string {
	return role === 'diffusion' || role === 'model' ? 'Model' : role === 'vae' ? 'Image decoder' : role === 'audio-vae' ? 'Audio decoder' : role === 'connectors' ? 'Text connector' : 'Text encoder';
}

/** Pure: sd-server arguments for a bundle (model paths, address, memory-saving flags). */
export function serverArgs(b: DiffusionBundle, modelsDir: string, port: number, backend: StudioBackend): string[] {
	const flag: Record<DiffusionRole, string> = { model: '-m', diffusion: '--diffusion-model', vae: '--vae', llm: '--llm', t5xxl: '--t5xxl', 'audio-vae': '--audio-vae', connectors: '--embeddings-connectors' };
	const args: string[] = [];
	for (const f of b.files) args.push(flag[f.role], bundleFilePath(modelsDir, f));
	args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port));
	// No --offload-to-cpu / --vae-tiling: sd.cpp's default auto-fit already places weights on the
	// GPU, RAM or disk by free memory, and the VAE retries in smaller tiles when it runs short.
	// Forcing both made a Wan 2.1 decode run on the CPU for 20+ minutes on an Intel Arc
	// (23 s without them — measured).
	// Flash attention saves memory where ggml has it (CUDA / ROCm / Metal / CPU).
	if (backend !== 'vulkan') args.push('--diffusion-fa');
	if (b.flowShift) args.push('--flow-shift', String(b.flowShift));
	args.push('--cfg-scale', String(b.cfg), '--steps', String(b.steps));
	if (b.sampler) args.push('--sampling-method', b.sampler);
	return args;
}

/** Pure: the job body for one generation. */
export function jobBody(b: DiffusionBundle, req: { prompt: string; negative?: string; width: number; height: number; seed?: number; frames?: number; initImage?: string }): Record<string, unknown> {
	const sample: Record<string, unknown> = { sample_steps: b.steps, guidance: { txt_cfg: b.cfg } };
	if (b.sampler) sample.sample_method = b.sampler;
	if (b.flowShift) sample.flow_shift = b.flowShift;
	const body: Record<string, unknown> = {
		prompt: req.prompt,
		negative_prompt: req.negative ?? b.negative ?? '',
		width: req.width,
		height: req.height,
		seed: Number.isInteger(req.seed) ? req.seed : -1,
		sample_params: sample
	};
	if (b.kind === 'video') {
		body.video_frames = req.frames ?? b.frames ?? 33;
		body.fps = b.fps ?? 16;
		body.output_format = 'webm';
		if (req.initImage) body.init_image = req.initImage;
	} else {
		body.batch_count = 1;
		body.output_format = 'png';
	}
	return body;
}

export interface StudioResult {
	kind: 'image' | 'video';
	mime: string;
	b64: string;
	seconds: number;
	seed?: number;
	/** The first job after a load also reads the weights from disk: not a fair speed sample. */
	cold?: boolean;
}

/** A free port, starting at `from` (the Studio prefers 8191; the engine uses 8181/8182). */
export function freePort(from: number): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.once('error', () => resolve(freePort(from + 1)));
		s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
	});
}

/** One sd-server process with one bundle loaded. */
export class StudioServer {
	private proc?: ChildProcess;
	bundle?: string;
	port = 0;
	ready = false;
	log = '';
	private job?: { id: string; ctl: AbortController };
	private warm = false;
	private starting?: { id: string; p: Promise<void> };

	/** `pidFile`: where the running server's pid is kept, so a server left by a crashed editor is stopped next time. */
	constructor(private readonly onChange: () => void, private readonly pidFile?: string) {}

	get running(): boolean {
		return !!this.proc && this.proc.exitCode === null;
	}

	/** Start (or keep) the server for a bundle; resolves when the model answers. A second call for the same bundle joins the load in progress. */
	start(server: string, b: DiffusionBundle, modelsDir: string, backend: StudioBackend, signal?: AbortSignal): Promise<void> {
		if (this.running && this.bundle === b.id && this.ready) return Promise.resolve();
		if (this.starting?.id === b.id) return this.starting.p;
		const p = this.load(server, b, modelsDir, backend, signal).finally(() => {
			if (this.starting?.p === p) this.starting = undefined;
		});
		this.starting = { id: b.id, p };
		return p;
	}

	/** A server this class started in an earlier session that is still running (the editor crashed or was killed). */
	private stopLeftover(): void {
		if (!this.pidFile) return;
		try {
			const pid = Number(fs.readFileSync(this.pidFile, 'utf8'));
			fs.rmSync(this.pidFile, { force: true });
			if (!pid || pid === this.proc?.pid) return;
			// Only an sd-server: a reused pid of another program is left alone.
			const name = process.platform === 'win32'
				? spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout
				: spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).stdout;
			if (!/sd-server/i.test(name || '')) return;
			if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
			else process.kill(pid);
		} catch {
			/* no leftover */
		}
	}

	private async load(server: string, b: DiffusionBundle, modelsDir: string, backend: StudioBackend, signal?: AbortSignal): Promise<void> {
		this.stop();
		this.stopLeftover();
		this.port = await freePort(8191);
		this.bundle = b.id;
		this.ready = false;
		this.warm = false;
		this.log = '';
		const proc = spawn(server, serverArgs(b, modelsDir, this.port, backend), { cwd: path.dirname(server), env: engineEnv(server), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		this.proc = proc;
		if (this.pidFile && proc.pid) {
			try {
				fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
				fs.writeFileSync(this.pidFile, String(proc.pid));
			} catch {
				/* best effort */
			}
		}
		const keep = (d: Buffer) => {
			this.log = (this.log + d.toString()).slice(-12_000);
		};
		proc.stdout?.on('data', keep);
		proc.stderr?.on('data', keep);
		proc.once('exit', () => {
			if (this.proc === proc) {
				this.proc = undefined;
				this.ready = false;
				this.onChange();
			}
		});
		this.onChange();
		// Loading a model takes from seconds to a few minutes (first run reads several GB from disk).
		const until = Date.now() + 15 * 60_000;
		while (Date.now() < until) {
			if (signal?.aborted) {
				this.stop();
				throw new Error('Cancelled.');
			}
			if (!this.running) throw new Error(studioFailure(this.log));
			try {
				const res = await fetch(`${this.base}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(2000) });
				if (res.ok) {
					this.ready = true;
					this.onChange();
					return;
				}
			} catch {
				/* still loading */
			}
			await new Promise((r) => setTimeout(r, 700));
		}
		this.stop();
		throw new Error('The model did not finish loading in 15 minutes.');
	}

	get base(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	/** Submit a job and wait for it (polling); `onTick` reports seconds elapsed and the job state. */
	async generate(b: DiffusionBundle, req: Parameters<typeof jobBody>[1], onTick: (s: { elapsed: number; status: string; queue?: number }) => void, signal?: AbortSignal): Promise<StudioResult> {
		if (!this.ready) throw new Error('The Studio model is not loaded.');
		const mode = b.kind === 'video' ? 'vid_gen' : 'img_gen';
		const submit = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
		const res = await fetch(`${this.base}/sdcpp/v1/${mode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jobBody(b, req)), signal: submit });
		const sub: any = await res.json().catch(() => ({}));
		if (!res.ok || !sub.id) throw new Error(sub?.error?.message || sub?.error || `The Studio refused the job (HTTP ${res.status}).`);
		const ctl = new AbortController();
		this.job = { id: String(sub.id), ctl };
		// A stopped turn cancels the server job instead of leaving it to finish unseen.
		const cancel = () => this.cancel();
		signal?.addEventListener('abort', cancel, { once: true });
		const t0 = Date.now();
		try {
			for (;;) {
				if (signal?.aborted || ctl.signal.aborted) throw new Error('Cancelled.');
				if (!this.running) throw new Error(studioFailure(this.log));
				await new Promise((r) => setTimeout(r, 800));
				const j: any = await fetch(`${this.base}/sdcpp/v1/jobs/${encodeURIComponent(sub.id)}`, { signal: AbortSignal.timeout(15_000) })
					.then((r) => r.json())
					.catch(() => undefined);
				if (!j) continue;
				onTick({ elapsed: (Date.now() - t0) / 1000, status: String(j.status), queue: j.queue_position });
				if (j.status === 'completed') {
					const started = Number(j.started) || 0;
					const completed = Number(j.completed) || 0;
					const seconds = started && completed > started ? completed - started : (Date.now() - t0) / 1000;
					const cold = !this.warm;
					this.warm = true;
					if (b.kind === 'video') {
						if (!j.result?.b64_json) throw new Error('The Studio returned no video.');
						return { kind: 'video', mime: String(j.result.mime_type || 'video/webm'), b64: String(j.result.b64_json), seconds, cold };
					}
					const img = j.result?.images?.[0];
					if (!img?.b64_json) throw new Error('The Studio returned no image.');
					return { kind: 'image', mime: 'image/' + String(j.result.output_format || 'png'), b64: String(img.b64_json), seconds, cold };
				}
				if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error?.message || 'The generation failed.');
			}
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.job = undefined;
		}
	}

	cancel(): void {
		const job = this.job;
		if (!job) return;
		job.ctl.abort();
		void fetch(`${this.base}/sdcpp/v1/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
	}

	stop(): void {
		this.cancel();
		if (this.proc && this.proc.exitCode === null) {
			if (process.platform === 'win32' && this.proc.pid) spawnSync('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { windowsHide: true });
			else this.proc.kill();
			if (this.pidFile) fs.rmSync(this.pidFile, { force: true });
		}
		this.proc = undefined;
		this.ready = false;
		this.bundle = undefined;
		this.onChange();
	}
}

/** Pure: what a failed start means, from sd-server's log. */
export function studioFailure(log: string): string {
	if (/out of memory|ErrorOutOfDeviceMemory|failed to allocate|cudaMalloc failed|bad_alloc/i.test(log)) return 'Not enough memory for this model here — close other apps or pick a smaller model.';
	if (/vulkan-1\.dll|libvulkan|ErrorIncompatibleDriver|no vulkan devices/i.test(log)) return 'The Vulkan runtime is missing or too old — update the GPU driver, or switch the Studio to CPU.';
	if (/cannot inspect model source|get sd version from file failed|failed to open|No such file/i.test(log)) return 'A model file is missing or cannot be read — delete the model in My models and get it again.';
	if (/error while loading shared libraries|Library not loaded|was not found/i.test(log)) return 'The Studio build is missing a system library — reinstall it, or switch to CPU.';
	const last = log.split('\n').filter((l) => /error|failed/i.test(l)).slice(-2).join(' ').trim();
	return last ? `The Studio stopped: ${last.slice(0, 220)}` : 'The Studio stopped unexpectedly.';
}
