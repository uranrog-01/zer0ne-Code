import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { compileDeny } from '../tools/deny';

/**
 * The repository map (Aider's repo map, smaller): the project's folders, its key files and
 * the top-level symbols of its main source files, in a few thousand characters at the end of
 * the system prompt. The agent starts a task knowing where things are instead of spending
 * its first steps on list_files.
 *
 * The prompt cache needs a prefix that does not change, so the map is cached per folder and
 * only rebuilt when the set of files changes (never when a file's content does), and at most
 * every few minutes. Deny rules hide paths from the map as they do from the tools.
 */

const MAX_FILES = 6000;
const SYMBOL_FILES = 40;
const SYMBOLS_PER_FILE = 8;
const SYMBOL_READ_BYTES = 64_000;
const RECHECK_MS = 5 * 60_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', 'vendor', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'bin', 'obj']);
const SOURCE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|cpp|cc|c|h|hpp|vue|svelte)$/i;
const KEY_FILES = /^(?:readme(?:\.\w+)?|package\.json|tsconfig\.json|cargo\.toml|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|makefile|dockerfile|agents\.md|claude\.md|\.zer0ne[\\/]instructions\.md)$/i;
const ENTRY = /(?:^|[\\/])(?:index|main|app|server|cli|lib|mod)\.\w+$/i;

/** Top-level declarations, by language family: names only. */
const DECLARATIONS: RegExp[] = [
	/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|abstract\s+class)\s+([A-Za-z_$][\w$]*)/,
	/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
	/^class\s+([A-Za-z_$][\w$]*)/,
	/^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
	/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
	/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/,
	/^(?:public|internal)\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+)*(?:class|interface|record|struct|enum)\s+([A-Za-z_]\w*)/,
	/^module\.exports\s*=\s*\{\s*([^}]{1,200})\}/
];

export function symbolsOf(text: string, limit = SYMBOLS_PER_FILE): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line || line[0] === ' ' || line[0] === '\t') continue;
		for (const re of DECLARATIONS) {
			const m = line.match(re);
			if (!m) continue;
			for (const name of m[1]!.split(',').map((s) => s.trim().split(/[\s:]/)[0]!).filter(Boolean)) if (!out.includes(name)) out.push(name);
			break;
		}
		if (out.length >= limit) break;
	}
	return out.slice(0, limit);
}

/** The project's files, relative with forward slashes: Git's list when there is one, else a bounded walk. */
export function listProjectFiles(root: string): string[] {
	try {
		const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		const files = out.split('\n').map((s) => s.trim()).filter(Boolean);
		if (files.length) return files.slice(0, MAX_FILES);
	} catch { /* not a Git repository, or Git is missing */ }
	const files: string[] = [];
	const walk = (dir: string, rel: string, depth: number) => {
		if (files.length >= MAX_FILES || depth > 8) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (files.length >= MAX_FILES) return;
			if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1); }
			else if (e.isFile()) files.push(rel ? `${rel}/${e.name}` : e.name);
		}
	};
	walk(root, '', 0);
	return files;
}

/** Larger, shallower, conventionally named source files first: they say the most about the project. */
function rankSources(files: string[]): string[] {
	const score = (f: string) => {
		const depth = f.split('/').length - 1;
		return (ENTRY.test(f) ? 3 : 0) - depth + (/(?:^|\/)(?:src|lib|app|engine|server|core)\//i.test(f) ? 1 : 0) - (/(?:test|spec|fixture|mock|\.d\.ts$|\.min\.)/i.test(f) ? 6 : 0);
	};
	return files.filter((f) => SOURCE.test(f)).sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

export function buildRepoMap(root: string, files: string[], maxChars = 6000): string {
	if (files.length < 3) return '';
	// Folders: file counts and the main extensions, two levels deep for the bigger ones.
	const dirs = new Map<string, { n: number; ext: Map<string, number> }>();
	for (const f of files) {
		const parts = f.split('/');
		for (let d = 1; d <= Math.min(2, parts.length - 1); d++) {
			const key = parts.slice(0, d).join('/');
			const entry = dirs.get(key) ?? { n: 0, ext: new Map() };
			entry.n++;
			const ext = path.extname(f).slice(1).toLowerCase() || 'other';
			entry.ext.set(ext, (entry.ext.get(ext) ?? 0) + 1);
			dirs.set(key, entry);
		}
	}
	const top = [...dirs.entries()].filter(([k]) => !k.includes('/')).sort((a, b) => b[1].n - a[1].n);
	const describe = (k: string, e: { n: number; ext: Map<string, number> }) => `${k}/ (${e.n} files: ${[...e.ext.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([x, n]) => `${x} ${n}`).join(', ')})`;
	const lines: string[] = [`Repository map (${files.length} files; generated from the file list — read files before relying on details):`];
	for (const [k, e] of top.slice(0, 14)) {
		lines.push(describe(k, e));
		if (e.n >= 15) for (const [sk, se] of [...dirs.entries()].filter(([x]) => x.startsWith(k + '/') && x.split('/').length === 2).sort((a, b) => b[1].n - a[1].n).slice(0, 6)) lines.push(`  ${describe(sk, se)}`);
	}
	const rootFiles = files.filter((f) => !f.includes('/'));
	const keys = files.filter((f) => KEY_FILES.test(f) && f.split('/').length <= 2);
	if (keys.length) lines.push(`Key files: ${keys.slice(0, 12).join(', ')}`);
	else if (rootFiles.length) lines.push(`Top-level files: ${rootFiles.slice(0, 12).join(', ')}`);
	const symbolLines: string[] = [];
	for (const f of rankSources(files).slice(0, SYMBOL_FILES * 2)) {
		if (symbolLines.length >= SYMBOL_FILES) break;
		let text: string;
		try {
			const fd = fs.openSync(path.join(root, f), 'r');
			try { const buf = Buffer.alloc(SYMBOL_READ_BYTES); text = buf.subarray(0, fs.readSync(fd, buf, 0, SYMBOL_READ_BYTES, 0)).toString('utf8'); }
			finally { fs.closeSync(fd); }
		} catch { continue; }
		const names = symbolsOf(text);
		if (names.length) symbolLines.push(`  ${f}: ${names.join(', ')}`);
	}
	if (symbolLines.length) lines.push('Main symbols:', ...symbolLines);
	let out = '';
	for (const line of lines) {
		if (out.length + line.length + 1 > maxChars) { out += '[…map trimmed]\n'; break; }
		out += line + '\n';
	}
	return out.trimEnd();
}

const cache = new Map<string, { at: number; list: string; text: string }>();

/**
 * The map for a folder, stable across turns: rebuilt only when the file list changed and the
 * last check is a few minutes old. Empty for tiny projects and folders without access.
 */
export function repoMapFor(root: string, denyPaths = '', now = Date.now()): string {
	const key = path.resolve(root).toLowerCase() + '\0' + denyPaths;
	const hit = cache.get(key);
	if (hit && now - hit.at < RECHECK_MS) return hit.text;
	const denied = compileDeny(denyPaths);
	const files = listProjectFiles(root).filter((f) => !denied(f) && !f.split('/').some((p) => SKIP_DIRS.has(p)));
	const list = createHash('sha1').update(files.join('\n')).digest('hex');
	if (hit && hit.list === list) { hit.at = now; return hit.text; }
	const text = buildRepoMap(root, files);
	cache.set(key, { at: now, list, text });
	return text;
}
