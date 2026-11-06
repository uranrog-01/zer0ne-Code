import * as fs from 'fs';
import * as path from 'path';
import { installedEngine } from '../localEngine';
import { acquireRuntimeLease } from '../runtimeLease';

/**
 * Startup storage sweep. Interrupted downloads, cancelled conversions and old
 * runtime builds leave files behind that nothing else ever deletes, which is
 * how a long-lived install silently grows by gigabytes. Everything here is
 * best-effort and gated on age: only leftovers older than STALE_MS are
 * touched, so an in-flight or resumable download — also one a sibling engine
 * process is writing in the same shared folder — is never affected. Complete
 * model files are never considered.
 */

const STALE_MS = 7 * 24 * 3600 * 1000;

/** Interrupted download and checksum-verification leftovers (see verifiedHfDownload). */
const LEFTOVER = /\.(part|verify\.part|verify)$/i;

/** Folders under global storage whose download leftovers are swept. */
const LEFTOVER_DIRS = ['engine', 'models', 'private-search', path.join('converter', 'work'), path.join('studio', 'engine'), path.join('studio', 'models'), path.join('voice', 'engine'), path.join('voice', 'models')];

const rm = (target: string): void => {
	try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* in use or already gone */ }
};

const stale = (p: string, now: number): boolean => {
	try { return fs.statSync(p).mtimeMs < now - STALE_MS; } catch { return false; }
};

function list(dir: string): fs.Dirent[] {
	try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Newest mtime of anything under dir (0 when unreadable): a dir still being written to is not stale. */
function newestUnder(dir: string): number {
	let newest = stale0(dir);
	for (const e of list(dir)) {
		const p = path.join(dir, e.name);
		if (e.isFile()) newest = Math.max(newest, stale0(p));
		else if (e.isDirectory()) newest = Math.max(newest, newestUnder(p));
	}
	return newest;
}
const stale0 = (p: string): number => {
	try { return fs.statSync(p).mtimeMs; } catch { return 0; }
};

function walk(dir: string, depth: number, onFile: (p: string) => void): void {
	for (const e of list(dir)) {
		const p = path.join(dir, e.name);
		if (e.isFile()) onFile(p);
		else if (e.isDirectory() && depth < 5) walk(p, depth + 1, onFile);
	}
}

/** Remove now-empty directories bottom-up; a non-empty dir makes every try fail, so only truly empty ones go. */
export function removeEmptyDirs(dir: string, depth = 0): void {
	if (depth > 5) return;
	for (const e of list(dir)) if (e.isDirectory()) removeEmptyDirs(path.join(dir, e.name), depth + 1);
	try { fs.rmdirSync(dir); } catch { /* not empty */ }
}

/**
 * Delete unreferenced version directories next to a runtime's json pointer
 * (voice.json, studio.json): a bumped pin leaves the previous build behind
 * with nothing pointing at it. `keep` is the directory the pointer's binary
 * lives in.
 */
function sweepVersions(dir: string, keep: string | undefined, now: number): void {
	if (!keep || !fs.existsSync(dir)) return;
	const top = (p: string) => path.resolve(dir, path.relative(dir, p).split(/[\\/]/)[0]);
	try { const held = top(keep); for (const e of list(dir)) if (e.isDirectory() && path.resolve(dir, e.name) !== held && newestUnder(path.join(dir, e.name)) < now - STALE_MS) rm(path.join(dir, e.name)); } catch { /* unreadable pointer */ }
}

/** Everything an install keeps: the engine.json current and rollback build dirs. */
function sweepEngineBuilds(engineDir: string, now: number): void {
	const meta = installedEngine(engineDir);
	const keep = new Set<string>();
	if (meta) {
		const top = (p: string) => path.resolve(engineDir, path.relative(engineDir, p).split(/[\\/]/)[0]);
		try { keep.add(top(meta.server)); } catch { /* missing server path */ }
		if (meta.previous) { try { keep.add(top(meta.previous.server)); } catch { /* missing server path */ } }
	}
	for (const e of list(engineDir)) {
		const full = path.join(engineDir, e.name);
		if (e.isDirectory() && /^b\d+-\w+$/.test(e.name) && !keep.has(path.resolve(full)) && newestUnder(full) < now - STALE_MS) rm(full);
	}
}

/** One pass over global storage. Synchronous on purpose: it only stats files, and callers defer it past boot. */
export function sweepStorage(root: string, now = Date.now()): void {
	const runtimes = ['engine', path.join('voice', 'engine'), path.join('studio', 'engine')];
	for (const rel of LEFTOVER_DIRS) {
		if (runtimes.includes(rel)) continue;
		walk(path.join(root, rel), 0, (p) => {
			if (LEFTOVER.test(p) && stale(p, now)) rm(p);
		});
	}
	// A stale .pending marker hides a complete model from the picker forever (scanGguf skips it).
	walk(path.join(root, 'models'), 0, (p) => {
		if (/^\.pending-.*\.json$/i.test(path.basename(p)) && stale(p, now)) rm(p);
	});
	// Cancelled conversions keep the downloaded weights and the F16 intermediate: whole work dirs go.
	for (const e of list(path.join(root, 'converter', 'work'))) {
		if (e.isDirectory() && newestUnder(path.join(root, 'converter', 'work', e.name)) < now - STALE_MS) rm(path.join(root, 'converter', 'work', e.name));
	}
	for (const models of [path.join(root, 'models'), path.join(root, 'studio', 'models')]) removeEmptyDirs(models);
	// Unreferenced runtime versions and engine builds beyond current + rollback.
	for (const rel of runtimes) {
		const dir = path.join(root, rel);
		if (!fs.existsSync(dir)) continue;
		const release = acquireRuntimeLease(dir);
		if (!release) continue;
		try {
			walk(dir, 0, p => { if (LEFTOVER.test(p) && stale(p, now)) rm(p); });
			if (rel === 'engine') {
				sweepEngineBuilds(dir, now);
				for (const e of list(dir)) if (e.isFile() && /\.(zip|tar\.gz|tgz)$/i.test(e.name) && stale(path.join(dir, e.name), now)) rm(path.join(dir, e.name));
			} else {
				const kind = rel === path.join('voice', 'engine') ? 'voice' : 'studio';
				try {
					const meta = JSON.parse(fs.readFileSync(path.join(dir, kind + '.json'), 'utf8'));
					sweepVersions(dir, path.dirname(kind === 'voice' ? meta.tts : meta.server), now);
				} catch { /* Missing or unreadable install pointer. */ }
			}
		} finally { release(); }
	}
}
