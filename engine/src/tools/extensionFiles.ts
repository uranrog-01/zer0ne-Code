import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';

export const identity = (file: string): string => createHash('sha256').update(process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)).digest('hex').slice(0, 24);

export function relativePath(value: string, allowRoot = false): string {
	if (allowRoot && (value === '' || value === '.')) return '';
	const clean = value.replace(/^\.\//, '').replace(/\/$/, '');
	if (!clean || /[\\:\x00-\x1f\x7f]/.test(clean) || path.posix.isAbsolute(clean) || clean.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe extension path: ${value}`);
	return clean;
}

export function noLinks(file: string): void {
	const absolute = path.resolve(file), parsed = path.parse(absolute);
	let current = parsed.root;
	for (const part of absolute.slice(parsed.root.length).split(path.sep)) {
		current = path.join(current, part);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Extension paths cannot contain symlinks or junctions: ${current}`); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
	}
}

export function within(root: string, relative: string, allowRoot = false): string {
	const clean = relativePath(relative, allowRoot), base = path.resolve(root), target = path.resolve(base, ...clean.split('/'));
	const rel = path.relative(base, target);
	if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Extension path escapes its root.');
	noLinks(target); return target;
}

export function readText(file: string, max = 2_000_000): string {
	noLinks(file); const fd = fs.openSync(file, 'r');
	try {
		const info = fs.fstatSync(fd);
		if (!info.isFile() || info.size > max) throw new Error('Extension file is not regular or exceeds its size limit.');
		return fs.readFileSync(fd, 'utf8');
	} finally { fs.closeSync(fd); }
}

/** Sync mutations fail busy rather than blocking the engine while another project owns the installation. */
export function pathLock<T>(files: string[], work: () => T): T {
	const locks: Array<{ file: string; fd: number; nonce: string }> = [];
	const release = () => { for (const lock of locks.splice(0).reverse()) { fs.closeSync(lock.fd); try { if (JSON.parse(fs.readFileSync(lock.file, 'utf8')).nonce === lock.nonce) fs.unlinkSync(lock.file); } catch {} } };
	try {
		for (const target of [...new Set(files.map(file => path.resolve(file)))].sort()) {
			const file = path.join(os.tmpdir(), 'zer0ne-extension-' + identity(target) + '.lock'), nonce = randomBytes(16).toString('hex');
			let fd: number;
			try { fd = fs.openSync(file, 'wx', 0o600); }
			catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
				try {
					const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
					try { process.kill(owner.pid, 0); }
					catch (dead) { if ((dead as NodeJS.ErrnoException).code === 'ESRCH' && JSON.parse(fs.readFileSync(file, 'utf8')).nonce === owner.nonce) fs.unlinkSync(file); }
				} catch {}
				try { fd = fs.openSync(file, 'wx', 0o600); }
				catch { throw new Error('This extension is being changed by another project. Try again when it finishes.'); }
			}
			locks.push({ file, fd, nonce }); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
		}
		const result = work();
		if (result instanceof Promise) return result.finally(release) as T;
		release(); return result;
	} catch (e) { release(); throw e; }
}

export function stageFor(dest: string): string {
	noLinks(dest); fs.mkdirSync(path.dirname(dest), { recursive: true });
	return fs.mkdtempSync(path.join(path.dirname(dest), '.zer0ne-stage-'));
}

/** Validate before calling; publication reuses the directory transaction for a single file. */
export function publishText(dest: string, text: string, previous = dest): void {
	pathLock([dest, previous], () => {
		noLinks(dest); noLinks(previous);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		const stage = path.join(path.dirname(dest), '.zer0ne-stage-' + randomBytes(12).toString('hex'));
		try {
			fs.writeFileSync(stage, text, { flag: 'wx', mode: 0o600 });
			publish(stage, dest, previous);
		} finally { if (fs.existsSync(stage)) removeStage(stage); }
	});
}

export function removeStage(stage: string): void {
	if (!/^\.zer0ne-(stage|backup)-/.test(path.basename(stage))) throw new Error('Invalid extension temporary directory.');
	noLinks(stage); fs.rmSync(stage, { recursive: true, force: true });
}

/** Readers may observe the brief rename gap; failed publication always restores the previous directory. */
export function publish(stage: string, dest: string, previous = dest): void {
	if (path.dirname(stage) !== path.dirname(dest) || !path.basename(stage).startsWith('.zer0ne-stage-')) throw new Error('Invalid extension staging path.');
	noLinks(stage); noLinks(dest); noLinks(previous);
	if (previous !== dest && fs.existsSync(dest)) throw new Error('An extension with that name already exists.');
	const backup = path.join(path.dirname(previous), '.zer0ne-backup-' + randomBytes(12).toString('hex'));
	let moved = false;
	try {
		if (fs.existsSync(previous)) { fs.renameSync(previous, backup); moved = true; }
		fs.renameSync(stage, dest);
	} catch (e) { if (moved) fs.renameSync(backup, previous); throw e; }
	if (moved) { try { removeStage(backup); } catch { /* A locked backup is retained, outside discovery, without losing the new installation. */ } }
}

export function validateTree(root: string, max = 32_000_000): void {
	noLinks(root); let bytes = 0, files = 0;
	const walk = (dir: string, depth: number) => {
		if (depth > 20) throw new Error('Extension folders exceed 20 levels.');
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (['.git', 'node_modules'].includes(entry.name)) continue;
			relativePath(entry.name); const file = path.join(dir, entry.name); noLinks(file);
			if (entry.isDirectory()) walk(file, depth + 1);
			else if (entry.isFile()) { bytes += fs.statSync(file).size; if (++files > 5000 || bytes > max) throw new Error('Extension exceeds 5000 files or its byte limit.'); }
			else throw new Error('Extension contains an unsupported filesystem entry.');
		}
	}; walk(root, 0);
}

export async function responseBytes(response: Response, max: number): Promise<Buffer> {
	if (!response.ok) { await response.body?.cancel(); throw new Error(`Download failed (HTTP ${response.status}).`); }
	if (!response.body) throw new Error('Download returned no body.');
	const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
	try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > max) throw new Error('Extension download exceeds its byte limit.'); chunks.push(next.value); } return Buffer.concat(chunks); }
	finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
