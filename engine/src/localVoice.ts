import * as fs from 'fs';
import * as path from 'path';
import { acquireRuntimeLease } from './runtimeLease';
import { spawn, spawnSync } from 'child_process';
import { digestMatches, download, engineEnv, type DownloadProgress } from './localEngine';
import type { VoiceBundle } from './localCatalog';

/**
 * Local text to speech with sherpa-onnx (Apache-2.0, k2-fsa): one small CPU
 * engine for every OS — Windows x64, macOS (Apple Silicon and Intel, one
 * universal build), Linux x64 and ARM64 — and ready-made voice packages
 * (Kokoro, Kitten, Piper). Speech is made per request by
 * `sherpa-onnx-offline-tts` into a WAV file: no server stays running.
 *
 * Same rules as the other engines: a tested build by default, checked
 * against GitHub's SHA-256, started once (`--help`) before it is kept;
 * downloads resume.
 */

export const VOICE_PIN = 'v1.13.8';
const RELEASE_TAG = (tag: string) => (process.env.ZER0NE_TTS_TAG_URL || 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/{tag}').replace('{tag}', encodeURIComponent(tag));
/** Voice packages live in one release of the same repository. */
export const VOICE_MODELS_URL = (file: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${encodeURIComponent(file)}`;

export interface VoiceInstall {
	version: string;
	tts: string;
}

/** Pure: the release asset for this system (undefined = no build, e.g. Windows on ARM). */
export function pickVoiceAsset(names: string[], platform = process.platform, arch = process.arch): string | undefined {
	const find = (re: RegExp) => names.find((n) => re.test(n));
	if (platform === 'win32') return arch === 'x64' ? find(/^sherpa-onnx-v[\d.]+-win-x64-shared-MD-Release\.tar\.bz2$/) : undefined;
	if (platform === 'darwin') return find(/^sherpa-onnx-v[\d.]+-osx-universal2-shared\.tar\.bz2$/);
	if (platform === 'linux') return arch === 'x64' ? find(/^sherpa-onnx-v[\d.]+-linux-x64-shared\.tar\.bz2$/) : arch === 'arm64' ? find(/^sherpa-onnx-v[\d.]+-linux-aarch64-shared-cpu\.tar\.bz2$/) : undefined;
	return undefined;
}

export function voiceSupported(platform = process.platform, arch = process.arch): boolean {
	return platform === 'darwin' || (platform === 'win32' && arch === 'x64') || (platform === 'linux' && (arch === 'x64' || arch === 'arm64'));
}

export function installedVoice(dir: string): VoiceInstall | undefined {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(dir, 'voice.json'), 'utf8')) as VoiceInstall;
		return fs.existsSync(meta.tts) ? meta : undefined;
	} catch {
		return undefined;
	}
}

/** Unpack a .tar.bz2 with the system tar (bsdtar on Windows 10+ and macOS, GNU tar on Linux — all read bzip2). */
function untar(archive: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	const r = spawnSync(tar, ['-xf', archive, '-C', dest], { windowsHide: true, timeout: 600_000 });
	if (r.status !== 0) throw new Error(`Could not unpack ${path.basename(archive)}: ${String(r.stderr || r.error?.message || '').trim().slice(0, 200)}`);
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

async function getJson(url: string): Promise<any> {
	const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`);
	return res.json();
}

/** Download, verify, unpack and start-check the voice engine. */
export async function installVoice(dir: string, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal): Promise<VoiceInstall> {
	const release = acquireRuntimeLease(dir);
	if (!release) throw new Error('This runtime is being installed or maintained in another project. Retry shortly.');
	try { return await installVoiceUnlocked(dir, onProgress, signal); }
	finally { release(); }
}

async function installVoiceUnlocked(dir: string, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal): Promise<VoiceInstall> {
	if (!voiceSupported()) throw new Error(`sherpa-onnx publishes no build for ${process.platform}-${process.arch}.`);
	onProgress({ received: 0, total: 0, bytesPerSec: 0, stage: 'Finding the tested sherpa-onnx build…' });
	const rel = await getJson(RELEASE_TAG(VOICE_PIN));
	const name = pickVoiceAsset((rel.assets ?? []).map((a: any) => a.name));
	if (!name) throw new Error('sherpa-onnx has no build for this system in the tested release.');
	const asset = rel.assets.find((a: any) => a.name === name);
	fs.mkdirSync(dir, { recursive: true });
	const archive = path.join(dir, name);
	await download(asset.browser_download_url, archive, (p) => onProgress({ ...p, stage: `Downloading ${name}` }), signal, asset.size);
	if (digestMatches(archive, asset.digest) !== true) {
		fs.rmSync(archive, { force: true });
		throw new Error(`The downloaded ${name} does not match the checksum GitHub publishes, so it was deleted and not installed.`);
	}
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Unpacking…' });
	const target = path.join(dir, String(rel.tag_name));
	fs.rmSync(target, { recursive: true, force: true });
	try {
		untar(archive, target);
	} finally {
		fs.rmSync(archive, { force: true });
	}
	const tts = findFile(target, process.platform === 'win32' ? 'sherpa-onnx-offline-tts.exe' : 'sherpa-onnx-offline-tts');
	if (!tts) {
		fs.rmSync(target, { recursive: true, force: true });
		throw new Error('sherpa-onnx-offline-tts was not found in the downloaded build.');
	}
	if (process.platform !== 'win32') fs.chmodSync(tts, 0o755);
	const smoke = spawnSync(tts, ['--help'], { timeout: 60_000, windowsHide: true, cwd: path.dirname(tts), env: engineEnv(tts), encoding: 'utf8' });
	if (smoke.error || !/kokoro|vits/i.test(`${smoke.stdout}${smoke.stderr}`)) {
		fs.rmSync(target, { recursive: true, force: true });
		throw new Error(`The voice engine does not start on this machine (${smoke.error?.message ?? 'no output'}).`);
	}
	const meta: VoiceInstall = { version: String(rel.tag_name), tts };
	fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify(meta, null, 2));
	// A pin bump leaves the previous version's folder behind with nothing pointing at it.
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.isDirectory() && e.name !== path.basename(target)) { try { fs.rmSync(path.join(dir, e.name), { recursive: true, force: true }); } catch { /* in use */ } }
	}
	return meta;
}

// ---------------------------------------------------------------- voice packages

/** Where a voice package is unpacked: `<models>/<package folder>`. */
export function voiceDir(modelsDir: string, v: VoiceBundle): string {
	return path.join(modelsDir, v.folder);
}

export function voiceInstalled(modelsDir: string, v: VoiceBundle): boolean {
	return fs.existsSync(path.join(voiceDir(modelsDir, v), v.files.model));
}

/** Download and unpack a voice package (the .tar.bz2 is resumable and removed after unpacking). */
export async function downloadVoice(modelsDir: string, v: VoiceBundle, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal): Promise<void> {
	if (voiceInstalled(modelsDir, v)) return;
	fs.mkdirSync(modelsDir, { recursive: true });
	const archive = path.join(modelsDir, v.archive);
	// The catalogue pins the archive's size and SHA-256: a short or changed
	// download is deleted, never unpacked.
	await download(VOICE_MODELS_URL(v.archive), archive, (p) => onProgress({ ...p, total: p.total || v.archiveBytes, stage: v.name }), signal, v.archiveBytes);
	if (digestMatches(archive, `sha256:${v.sha256}`) !== true) {
		fs.rmSync(archive, { force: true });
		throw new Error(`The downloaded ${v.name} does not match its published checksum, so it was deleted and not installed.`);
	}
	onProgress({ received: v.archiveBytes, total: v.archiveBytes, bytesPerSec: 0, stage: 'Unpacking…' });
	try {
		untar(archive, modelsDir);
	} finally {
		fs.rmSync(archive, { force: true });
	}
	if (!voiceInstalled(modelsDir, v)) throw new Error(`${v.name} unpacked without its model file — try again.`);
}

/** Pure: the engine arguments for one voice and speaker. */
export function voiceArgs(v: VoiceBundle, modelsDir: string, speaker: number, speed: number, threads: number, out: string): string[] {
	const d = voiceDir(modelsDir, v);
	const f = (name?: string) => (name ? path.join(d, name) : '');
	const args: string[] = [];
	const spk = v.speakers.find((s) => s.id === speaker) ?? v.speakers[0];
	if (v.engine === 'kokoro') {
		args.push(`--kokoro-model=${f(v.files.model)}`, `--kokoro-voices=${f(v.files.voices)}`, `--kokoro-tokens=${f(v.files.tokens)}`, `--kokoro-data-dir=${f(v.files.data)}`);
		// Kokoro 1.0: English and Chinese read through lexicons; the other languages by name.
		if (spk?.lang === 'en-gb') args.push(`--kokoro-lexicon=${f('lexicon-gb-en.txt')}`);
		else if (spk?.lang === 'zh') args.push(`--kokoro-lexicon=${f('lexicon-us-en.txt')},${f('lexicon-zh.txt')}`);
		else if (spk && spk.lang !== 'en-us') args.push(`--kokoro-lang=${spk.lang}`);
		else args.push(`--kokoro-lexicon=${f('lexicon-us-en.txt')}`);
		args.push(`--kokoro-length-scale=${(1 / speed).toFixed(2)}`);
	} else if (v.engine === 'kitten') {
		args.push(`--kitten-model=${f(v.files.model)}`, `--kitten-voices=${f(v.files.voices)}`, `--kitten-tokens=${f(v.files.tokens)}`, `--kitten-data-dir=${f(v.files.data)}`, `--kitten-length-scale=${(1 / speed).toFixed(2)}`);
	} else {
		args.push(`--vits-model=${f(v.files.model)}`, `--vits-tokens=${f(v.files.tokens)}`, `--vits-data-dir=${f(v.files.data)}`, `--vits-length-scale=${(1 / speed).toFixed(2)}`);
	}
	if (v.speakers.length > 1) args.push(`--sid=${spk.id}`);
	args.push(`--num-threads=${threads}`, `--output-filename=${out}`);
	return args;
}

/** Speak `text` into `out` (WAV). Resolves with the engine's audio length and time taken. */
export function speak(tts: string, v: VoiceBundle, modelsDir: string, text: string, opts: { speaker: number; speed: number; threads: number; out: string; signal?: AbortSignal }): Promise<{ seconds: number; audioSeconds?: number }> {
	return new Promise((resolve, reject) => {
		const t0 = Date.now();
		fs.mkdirSync(path.dirname(opts.out), { recursive: true });
		const proc = spawn(tts, [...voiceArgs(v, modelsDir, opts.speaker, opts.speed, opts.threads, opts.out), text], { cwd: path.dirname(tts), env: engineEnv(tts), windowsHide: true });
		let log = '';
		proc.stdout.on('data', (d) => (log = (log + d).slice(-6000)));
		proc.stderr.on('data', (d) => (log = (log + d).slice(-6000)));
		const abort = () => proc.kill();
		opts.signal?.addEventListener('abort', abort, { once: true });
		proc.once('error', (e) => reject(e));
		proc.once('exit', (code) => {
			opts.signal?.removeEventListener('abort', abort);
			if (opts.signal?.aborted) return reject(new Error('Cancelled.'));
			if (code !== 0 || !fs.existsSync(opts.out)) return reject(new Error(log.split('\n').filter((l) => /error|failed|cannot/i.test(l)).slice(-2).join(' ').slice(0, 240) || `The voice engine stopped (exit ${code}).`));
			const audio = Number(/Audio duration:\s*([\d.]+)/.exec(log)?.[1]);
			resolve({ seconds: (Date.now() - t0) / 1000, audioSeconds: Number.isFinite(audio) ? audio : undefined });
		});
	});
}
