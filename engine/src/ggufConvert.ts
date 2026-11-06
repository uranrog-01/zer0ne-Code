import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { scrubEnv } from './tools/proc';
import { download, hfFileMeta, verifiedHfDownload, type DownloadProgress } from './localEngine';

/**
 * zer0ne Engine — Convert: run models that have no GGUF build.
 *
 * Ollama imports safetensors models by converting them to GGUF on the
 * machine (`ollama create` from a safetensors folder). zer0ne does the same
 * with llama.cpp's own converter (MIT, the same project as the engine):
 *
 *   1. download the original weights from Hugging Face (resumable, token-aware)
 *   2. convert_hf_to_gguf.py  → one f16 GGUF (a private Python venv, set up once)
 *   3. llama-quantize          → Q4_K_M (Q8_0 for small models), from the engine build
 *
 * The result lands in the models folder, so it shows in My models and the
 * chat picker like any downloaded GGUF. ZER0NE_LLAMA_SRC overrides the source
 * archive (tests, mirrors) and ZER0NE_LLAMA_SRC_SHA256 its expected digest.
 */

const SRC = (tag: string) => process.env.ZER0NE_LLAMA_SRC || `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${tag}.tar.gz`;

/**
 * The SHA-256 of the llama.cpp source archive, per engine build tag.
 *
 * The converter installs Python packages from this tree and then runs it, so
 * an archive that is not the one upstream published must never be unpacked.
 * The digests below are the ones the app was tested against; a build whose
 * tag is not listed is checked against the tag's published git tree instead
 * (see verifySourceTree), and ZER0NE_LLAMA_SRC_SHA256 pins the digest of a
 * mirror explicitly.
 */
const SRC_SHA256: Record<string, string> = {
	b11169: '06f55b8549ce09229a9c5f57830b8f6ae432769a39d8dd5a40ca726c6fd90367',
};

/** The blob hash git gives a file: sha1("blob <size>\0" + content). */
function gitBlobSha(file: string): string {
	const data = fs.readFileSync(file);
	return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

/** Every file under a folder, relative to it. */
function filesUnder(root: string, dir = root, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) filesUnder(root, full, out);
		else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
	}
	return out;
}

/** The SHA-256 of a file on disk. */
function sha256File(file: string): string {
	const hash = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
	} finally {
		fs.closeSync(fd);
	}
	return hash.digest('hex');
}

/**
 * The git tree of a llama.cpp tag: every file it publishes with the blob hash
 * git gives it. The blob hash covers the file's bytes exactly, so it proves
 * that an unpacked archive is the tree upstream published — even when the
 * archive itself is served from somewhere else.
 */
async function upstreamTree(tag: string): Promise<Map<string, string>> {
	const url = `https://api.github.com/repos/ggml-org/llama.cpp/git/trees/${encodeURIComponent(tag)}?recursive=1`;
	const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zer0ne' }, signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the llama.cpp source tree of ${tag}.`);
	const body = (await res.json()) as { tree?: Array<{ path?: string; type?: string; sha?: string }>; truncated?: boolean };
	if (body.truncated) throw new Error(`The llama.cpp source tree of ${tag} is too large for GitHub to list completely — cannot verify it.`);
	const out = new Map<string, string>();
	for (const entry of Array.isArray(body.tree) ? body.tree : []) {
		if (entry?.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string') out.set(entry.path, entry.sha);
	}
	if (!out.size) throw new Error(`GitHub published no files for the llama.cpp tag ${tag}.`);
	return out;
}

/**
 * Prove that the unpacked converter is the tree upstream published: every
 * extracted file must exist in the tag's git tree with the same blob hash.
 * A file that upstream does not know, or whose bytes differ, fails the check.
 */
async function verifySourceTree(src: string, tag: string): Promise<void> {
	const tree = await upstreamTree(tag);
	const files = filesUnder(src);
	if (!files.length) throw new Error('The unpacked converter is empty.');
	for (const rel of files) {
		const sha = tree.get(rel);
		if (!sha) throw new Error(`The unpacked converter contains ${rel}, which is not part of the llama.cpp ${tag} source tree.`);
		if (gitBlobSha(path.join(src, rel)) !== sha) throw new Error(`The unpacked converter file ${rel} does not match the llama.cpp ${tag} source tree.`);
	}
}


export interface PythonInfo {
	cmd: string;
	args: string[];
	version: string;
}

/** A Python 3.9–3.14 on this machine (python, py -3, python3). */
export function findPython(): PythonInfo | undefined {
	const tries: Array<[string, string[]]> = process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
	for (const [cmd, args] of tries) {
		const r = spawnSync(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
		const v = r.status === 0 ? String(r.stdout).trim() : '';
		const m = /^3\.(\d+)\./.exec(v);
		if (m && Number(m[1]) >= 9 && Number(m[1]) <= 14) return { cmd, args, version: v };
	}
	return undefined;
}

/** Which repository files the converter needs (pure; tested). */
export function convertFiles(files: Array<{ path: string; size: number }>): { files: string[]; bytes: number; problem?: string } {
	const names = files.map((f) => f.path);
	const has = (re: RegExp) => names.some((n) => re.test(n));
	if (has(/(^|\/)adapter_config\.json$/) && !has(/(^|\/)(model|pytorch_model)[^/]*\.(safetensors|bin)$/)) {
		return { files: [], bytes: 0, problem: 'This repository is a LoRA adapter, not a full model. Convert its base model instead, or look for a merged version.' };
	}
	if (!has(/(^|\/)config\.json$/)) return { files: [], bytes: 0, problem: 'No config.json in this repository — it is not a Transformers model the converter can read.' };
	const safetensors = has(/\.safetensors$/);
	const weights = safetensors ? /\.safetensors$/ : /(^|\/)pytorch_model[^/]*\.bin$/;
	if (!has(weights)) return { files: [], bytes: 0, problem: 'No model weights (safetensors or pytorch .bin) in this repository.' };
	const keep = files.filter((f) => {
		if (f.path.includes('/')) return false; // top level only (no onnx/, original/, checkpoints/)
		if (weights.test(f.path)) return true;
		if (/\.safetensors\.index\.json$|pytorch_model\.bin\.index\.json$/.test(f.path)) return true;
		return /^(config|generation_config|tokenizer|tokenizer_config|special_tokens_map|added_tokens|preprocessor_config|chat_template)\.json$|^(tokenizer\.model|vocab\.json|vocab\.txt|merges\.txt|chat_template\.jinja|tiktoken\.model|.*\.tiktoken)$/.test(f.path);
	});
	return { files: keep.map((f) => f.path), bytes: keep.reduce((n, f) => n + f.size, 0) };
}

/** Quantisation for the converted model: small models keep more precision. */
export function convertQuant(params?: number): 'Q8_0' | 'Q4_K_M' {
	return params && params <= 3.5e9 ? 'Q8_0' : 'Q4_K_M';
}

export type ConvertProgress = Partial<DownloadProgress> & { stage: string };

/** The converter's own folder: llama.cpp sources (converter only) + a venv. */
export class GgufConverter {
	constructor(
		private readonly dir: string,
		private readonly engineBinDir: () => string | undefined,
		private readonly engineTag: () => string | undefined
	) {}

	private get venvPython(): string {
		return process.platform === 'win32' ? path.join(this.dir, 'venv', 'Scripts', 'python.exe') : path.join(this.dir, 'venv', 'bin', 'python');
	}
	private get marker(): string {
		return path.join(this.dir, 'ready.json');
	}

	/** Set up once: tools present and matching the engine build. */
	status(): { ready: boolean; tag?: string; python?: string } {
		try {
			const m = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
			return { ready: fs.existsSync(this.venvPython) && fs.existsSync(path.join(this.dir, 'src', 'convert_hf_to_gguf.py')), tag: m.tag, python: m.python };
		} catch {
			return { ready: false };
		}
	}

	private quantizeBin(): string | undefined {
		const d = this.engineBinDir();
		if (!d) return undefined;
		const exe = path.join(d, process.platform === 'win32' ? 'llama-quantize.exe' : 'llama-quantize');
		return fs.existsSync(exe) ? exe : undefined;
	}

	/** Download the converter sources and create the venv (~400 MB with PyTorch CPU). */
	async setup(onProgress: (p: ConvertProgress) => void, signal: AbortSignal): Promise<void> {
		const tag = this.engineTag();
		if (!tag) throw new Error('Install zer0ne Engine first (Runtimes) — the converter matches its llama.cpp build.');
		const py = findPython();
		if (!py) throw new Error('Converting needs Python 3.9–3.14. Install it from python.org (tick "Add to PATH"), then try again.');
		fs.mkdirSync(this.dir, { recursive: true });
		const archive = path.join(this.dir, `llama.cpp-${tag}.tar.gz`);
		// GitHub serves the source archive chunked, without a size: the digest below
		// is what proves the file complete, so the size check is waived for it.
		await download(SRC(tag), archive, (p) => onProgress({ ...p, stage: 'Downloading the llama.cpp converter' }), signal, undefined, { requireSize: true, sizeUnknown: true });
		// A pinned digest is checked before anything is unpacked.
		const pinned = (process.env.ZER0NE_LLAMA_SRC_SHA256 || SRC_SHA256[tag] || '').trim().toLowerCase();
		if (/^[0-9a-f]{64}$/.test(pinned)) {
			const got = sha256File(archive);
			if (got !== pinned) {
				fs.rmSync(archive, { force: true });
				throw new Error(`The llama.cpp source archive for ${tag} does not match its expected SHA-256 (expected ${pinned}, got ${got}). The file was deleted and nothing was installed.`);
			}
		}
		onProgress({ stage: 'Unpacking the converter' });
		const src = path.join(this.dir, 'src');
		fs.rmSync(src, { recursive: true, force: true });
		fs.mkdirSync(src, { recursive: true });
		const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
		// Only what the converter needs (the full source tree is ~10× larger).
		const root = `llama.cpp-${tag}`;
		const want = ['convert_hf_to_gguf.py', 'conversion', 'gguf-py', 'requirements', 'requirements.txt'].map((p) => `${root}/${p}`);
		let r = spawnSync(tar, ['-xzf', archive, '-C', src, '--strip-components=1', ...want], { windowsHide: true, timeout: 300_000, encoding: 'utf8' });
		if (r.status !== 0) {
			// Older trees have no conversion/ folder: take the rest.
			r = spawnSync(tar, ['-xzf', archive, '-C', src, '--strip-components=1', ...want.filter((w) => !w.endsWith('/conversion'))], { windowsHide: true, timeout: 300_000, encoding: 'utf8' });
		}
		fs.rmSync(archive, { force: true });
		if (r.status !== 0 || !fs.existsSync(path.join(src, 'convert_hf_to_gguf.py'))) throw new Error('Could not unpack the converter: ' + String(r.stderr || '').trim().slice(0, 200));
		// The converter and the Python package it installs must both be there: a
		// truncated archive leaves one of them out, and nothing may be pip-installed
		// from a half-unpacked tree.
		const ggufPy = ['pyproject.toml', 'setup.py'].some((f) => fs.existsSync(path.join(src, 'gguf-py', f)));
		if (!ggufPy) {
			fs.rmSync(src, { recursive: true, force: true });
			throw new Error('The llama.cpp source archive for ' + tag + ' is incomplete — it does not contain the converter package. Nothing was installed; try again.');
		}
		// No pinned digest for this build: the unpacked tree must still be the tree
		// upstream published. Nothing is installed before this passed.
		if (!/^[0-9a-f]{64}$/.test(pinned)) {
			onProgress({ stage: 'Checking the converter sources against llama.cpp' });
			try {
				await verifySourceTree(src, tag);
			} catch (e) {
				fs.rmSync(src, { recursive: true, force: true });
				const why = e instanceof Error ? e.message : String(e);
				throw new Error(`${why} The llama.cpp ${tag} archive has no pinned SHA-256 in this app, so the unpacked files were checked against the tree upstream published instead — and that check did not pass. Nothing was installed.`);
			}
		}
		onProgress({ stage: 'Creating a private Python environment' });
		await run(py.cmd, [...py.args, '-m', 'venv', path.join(this.dir, 'venv')], this.dir, signal, () => undefined);
		onProgress({ stage: 'Installing PyTorch (CPU) and the converter packages — one time, about 400 MB' });
		const req = path.join(src, 'requirements', 'requirements-convert_hf_to_gguf.txt');
		let last = '';
		const pipLine = (line: string) => {
			const m = /^(Collecting|Downloading|Installing collected packages|Successfully installed)\s*(.{0,80})/.exec(line.trim());
			if (m && m[0] !== last) {
				last = m[0];
				onProgress({ stage: 'Setting up: ' + m[0] });
			}
		};
		try {
			// Prebuilt packages only: a source build (no wheel for this Python) would need a C compiler.
			await run(this.venvPython, ['-m', 'pip', 'install', '--no-input', '--only-binary=:all:', '-r', req], path.join(src, 'requirements'), signal, pipLine);
		} catch (e) {
			if (signal.aborted) throw e;
			// The pinned versions have no build for this Python (e.g. numpy 2.2 on 3.14): same packages, newest builds.
			onProgress({ stage: 'Setting up: newest package builds for Python ' + py.version });
			await run(this.venvPython, ['-m', 'pip', 'install', '--no-input', '--only-binary=:all:', '--extra-index-url', 'https://download.pytorch.org/whl/cpu', 'torch', 'numpy', 'sentencepiece<0.3', 'transformers>=4.57,<5', 'protobuf<6'], src, signal, pipLine);
		}
		// gguf-py from the same tree (the converter expects this exact version).
		await run(this.venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', path.join(src, 'gguf-py')], src, signal, () => undefined);
		fs.writeFileSync(this.marker, JSON.stringify({ tag, python: py.version, at: Date.now() }));
	}

	/**
	 * Download → convert → quantize. Returns the GGUF path (in outDir).
	 * `tree` is the repository's file list (path + size).
	 */
	async convert(id: string, tree: Array<{ path: string; size: number }>, outDir: string, params: number | undefined, onProgress: (p: ConvertProgress) => void, signal: AbortSignal): Promise<string> {
		const plan = convertFiles(tree);
		if (plan.problem) throw new Error(plan.problem);
		const quantize = this.quantizeBin();
		if (!quantize) throw new Error('llama-quantize is missing from the engine build — reinstall zer0ne Engine under Runtimes.');
		if (!this.status().ready) await this.setup(onProgress, signal);
		const work = path.join(this.dir, 'work', id.replace(/[\\/]/g, '--'));
		fs.mkdirSync(work, { recursive: true });
		let done = 0;
		for (const f of plan.files) {
			const dest = path.join(work, f);
			const size = tree.find((t) => t.path === f)?.size ?? 0;
			// The Hub publishes the file's size and, for LFS files, its SHA-256:
			// download it and check both, so a truncated file never reaches the converter.
			const meta = await hfFileMeta(id, f);
			if (!meta) throw new Error(`Hugging Face does not list ${f} in ${id} any more.`);
			if (size && meta.size !== size) throw new Error(`${f} changed on Hugging Face while it was being downloaded. Try again.`);
			await verifiedHfDownload(id, { path: f, size: meta.size, sha256: meta.sha256 }, undefined, dest, (p) => onProgress({ stage: 'Downloading the original weights', received: done + p.received, total: plan.bytes, bytesPerSec: p.bytesPerSec }), signal);
			done += meta.size;
		}
		const name = (id.split('/').pop() || id).replace(/[^\w.-]+/g, '-');
		const f16 = path.join(work, `${name}-F16.gguf`);
		const quant = convertQuant(params);
		const out = path.join(outDir, `${name}-${quant}.gguf`);
		fs.mkdirSync(outDir, { recursive: true });
		onProgress({ stage: 'Converting to GGUF (llama.cpp converter)' });
		let tail = '';
		try {
			await run(this.venvPython, [path.join(this.dir, 'src', 'convert_hf_to_gguf.py'), work, '--outfile', f16, '--outtype', 'f16'], work, signal, (line) => {
				tail = (tail + line + '\n').slice(-3000);
				const m = /Writing:\s+(\d+)%/.exec(line);
				if (m) onProgress({ stage: 'Converting to GGUF', received: Number(m[1]), total: 100 });
			});
		} catch (e) {
			const arch = /Model (\S+) is not supported/.exec(tail)?.[1];
			throw new Error(arch ? `llama.cpp cannot convert the ${arch} architecture yet, so no engine can run it as GGUF.` : (e instanceof Error ? e.message : String(e)) + '\n' + tail.split('\n').filter((l) => /error|Error|exception/i.test(l)).slice(-2).join(' '));
		}
		onProgress({ stage: `Quantizing to ${quant}` });
		await run(quantize, [f16, out, quant], work, signal, (line) => {
			const m = /\[\s*(\d+)\/\s*(\d+)\]/.exec(line);
			if (m) onProgress({ stage: `Quantizing to ${quant}`, received: Number(m[1]), total: Number(m[2]) });
		});
		// Keep the tokenizer files for the chat template; drop the heavy parts.
		fs.rmSync(work, { recursive: true, force: true });
		return out;
	}
}

/** Run a process, stream its lines, reject on a non-zero exit (the last lines in the message). */
function run(cmd: string, args: string[], cwd: string, signal: AbortSignal, onLine: (line: string) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { cwd, windowsHide: true, env: { ...scrubEnv(), PYTHONUNBUFFERED: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
		let tail = '';
		let buf = '';
		const read = (c: Buffer) => {
			buf += c.toString();
			const lines = buf.split(/\r?\n|\r/);
			buf = lines.pop() ?? '';
			for (const l of lines) {
				tail = (tail + l + '\n').slice(-2000);
				onLine(l);
			}
		};
		p.stdout.on('data', read);
		p.stderr.on('data', read);
		const stop = () => {
			if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
			else p.kill();
		};
		signal.addEventListener('abort', stop, { once: true });
		p.on('error', (e) => reject(e));
		p.on('close', (code) => {
			signal.removeEventListener('abort', stop);
			if (signal.aborted) return reject(new Error('Cancelled.'));
			if (code === 0) return resolve();
			reject(new Error(`${path.basename(cmd)} exited with code ${code}. ${tail.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`));
		});
	});
}
