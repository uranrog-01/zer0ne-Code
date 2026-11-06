import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

/**
 * Fast search with the ripgrep binary VS Code already ships (no download).
 * It honors .gitignore / .ignore / .rgignore plus an optional .zer0neignore,
 * searches hidden folders like .github (but never .git), and falls back to
 * PCRE2 for look-arounds. Callers fall back to the slower JS search when no
 * binary is found (e.g. VS Code for the Web).
 */

let cached: string | null | undefined;

/** VS Code's install folder when running inside VS Code (the CLI / ACP server run without it). */
function vscodeAppRoot(): string {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return (require('vscode') as { env?: { appRoot?: string } }).env?.appRoot ?? '';
	} catch {
		return '';
	}
}

export function ripgrepPath(): string | undefined {
	if (cached !== undefined) {
		return cached ?? undefined;
	}
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const plat = `${process.platform}-${process.arch}`;
	const roots = [process.env.ZER0NE_RG ? path.dirname(process.env.ZER0NE_RG) : '', vscodeAppRoot()].filter(Boolean);
	const candidates: string[] = process.env.ZER0NE_RG ? [process.env.ZER0NE_RG] : [];
	for (const root of roots) {
		for (const mod of ['node_modules.asar.unpacked', 'node_modules']) {
			candidates.push(
				path.join(root, mod, '@vscode', 'ripgrep', 'bin', exe),
				path.join(root, mod, '@vscode', 'ripgrep-universal', 'bin', plat, exe),
				path.join(root, mod, 'vscode-ripgrep', 'bin', exe)
			);
		}
	}
	// Outside VS Code: an rg on the PATH.
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (dir) {
			candidates.push(path.join(dir, exe));
		}
	}
	cached = candidates.find((c) => {
		try {
			return fs.statSync(c).isFile();
		} catch {
			return false;
		}
	}) ?? null;
	return cached ?? undefined;
}

function baseArgs(root: string): string[] {
	const args = ['--no-require-git', '--hidden', '--glob', '!.git/', '--glob', '!node_modules/', '--path-separator', '/', '--color', 'never', '--no-messages'];
	const ignore = path.join(root, '.zer0neignore');
	if (fs.existsSync(ignore)) {
		args.push('--ignore-file', ignore);
	}
	return args;
}

/** Run rg and collect up to `max` output lines. Resolves undefined when rg is unavailable. */
function run(root: string, args: string[], max: number, signal?: AbortSignal): Promise<{ lines: string[]; code: number | null; stderr: string; truncated: boolean } | undefined> {
	const rg = ripgrepPath();
	if (!rg) {
		return Promise.resolve(undefined);
	}
	return new Promise((resolve) => {
		const child = spawn(rg, args, { cwd: root, windowsHide: true });
		const lines: string[] = [];
		let buf = '';
		let stderr = '';
		let truncated = false;
		const stop = () => child.kill();
		signal?.addEventListener('abort', stop, { once: true });
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			if (truncated) {
				return;
			}
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).replace(/\r$/, '');
				buf = buf.slice(nl + 1);
				if (line) {
					lines.push(line.replace(/^\.\//, ''));
				}
				if (lines.length >= max) {
					truncated = true;
					child.kill();
					break;
				}
			}
		});
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (c: string) => (stderr = (stderr + c).slice(-2000)));
		child.on('error', () => resolve(undefined));
		child.on('close', (code) => {
			signal?.removeEventListener('abort', stop);
			if (buf.trim() && !truncated) {
				lines.push(buf.trim().replace(/^\.\//, ''));
			}
			resolve({ lines, code, stderr, truncated });
		});
	});
}

export interface RgMatches {
	matches: string[];
	files: number;
	truncated: boolean;
}

/** Options of the content search: what the grep tool passes through. */
export interface RgSearchOptions {
	/** Case-sensitive when true (default: case-insensitive). */
	caseSensitive?: boolean;
	/** Literal (non-regex) pattern. */
	fixed?: boolean;
	/** Matched lines plus this many lines after each match (rg -A). */
	after?: number;
	/** This many lines before each match (rg -B). */
	before?: number;
	/** Output mode: matched lines (default), file paths, or per-file counts. */
	output?: 'content' | 'files' | 'count';
}

const isCounting = (o: RgSearchOptions | undefined) => o?.output === 'files' || o?.output === 'count';

/** Content search (case-insensitive by default, options per call). Throws on an invalid pattern; undefined = no ripgrep. */
export async function rgSearch(root: string, pattern: string, glob: string, signal?: AbortSignal, max = 150, exclude: string[] = [], options: RgSearchOptions = {}): Promise<RgMatches | undefined> {
	const args = [...baseArgs(root).filter(arg => arg !== '--no-messages'), '-n', options.caseSensitive ? undefined : '-i', options.fixed ? '-F' : undefined, '--no-heading', '--max-columns', '300', '--max-columns-preview', '--max-count', '40'].filter((a): a is string => !!a);
	const ctx = options.after ?? options.before ? [...args, '--context-separator', '--'] : args;
	if (options.after) ctx.push('-A', String(Math.min(20, Math.max(0, Math.floor(options.after)))));
	if (options.before) ctx.push('-B', String(Math.min(20, Math.max(0, Math.floor(options.before)))));
	if (options.output === 'files') ctx.push('-l');
	if (options.output === 'count') ctx.push('-c');
	if (glob.trim()) {
		args.push('--glob', glob.trim().replace(/^\.?\//, ''));
	}
	// Deny rules last: in ripgrep the last matching glob wins.
	args.push(...exclude.flatMap((x) => ['--glob', x]));
	let res = await run(root, [...ctx, '-e', pattern, '--', '.'], max, signal);
	if (res && res.code === 2 && /regex parse error|look-?around|backreference/i.test(res.stderr)) {
		res = await run(root, [...ctx, '--pcre2', '-e', pattern, '--', '.'], max, signal);
	}
	if (!res) {
		return undefined;
	}
	if (res.code === 2 && !res.lines.length) {
		const detail = res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
		throw new Error(`Search failed (ripgrep exit ${res.code}): ${detail || 'No diagnostic was returned. Check the search pattern, workspace access and ignore files.'}`);
	}
	// Parallel search returns files in any order; sort so results (and the prompt cache) are stable.
	// Counting and context modes carry different line shapes and pass through as-is.
	if (isCounting(options)) {
		const matches = res.lines.map(l => l.replace(/^\.\//, ''));
		const files = options.output === 'count' ? matches.length : matches.length;
		return { matches, files, truncated: res.truncated };
	}
	const parsed = res.lines.map((l) => {
		if (l === '--') return { file: '', line: 0, text: '⋯' };
		const m = l.match(/^(.*?):(\d+):?(.*)$/);
		// -l file lines and context lines (path-line without the second colon) keep their raw text.
		if (!m || (options.after !== undefined || options.before !== undefined) && m[3] === '' && !l.includes(': ')) {
			return { file: '', line: 0, text: l };
		}
		return m ? { file: m[1], line: Number(m[2]), text: `${m[1]}:${m[2]}: ${m[3].trim().slice(0, 200)}` } : { file: '', line: 0, text: l };
	});
	parsed.sort((a, b) => (a.file && b.file ? (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line) : 0));
	const matches = parsed.map((p) => p.text);
	return { matches, files: new Set(parsed.filter(p => p.file).map((p) => p.file)).size, truncated: res.truncated };
}

/** File listing by glob. undefined = no ripgrep. */
export async function rgFiles(root: string, glob: string, max = 1000, exclude: string[] = []): Promise<{ files: string[]; truncated: boolean } | undefined> {
	const args = [...baseArgs(root), '--files'];
	const g = glob.trim().replace(/^\.?\//, '');
	if (g && g !== '**/*' && g !== '**') {
		args.push('--glob', g);
	}
	args.push(...exclude.flatMap((x) => ['--glob', x])); // deny rules last (last glob wins)
	const res = await run(root, [...args, '.'], max);
	return res ? { files: res.lines.sort(), truncated: res.truncated } : undefined;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', 'coverage', '__pycache__', '.venv']);

/**
 * Content search that always answers: ripgrep, then a plain JavaScript walk
 * (for a machine without ripgrep — VS Code itself always ships it). Same
 * result shape as rgSearch.
 */
export async function searchAnywhere(root: string, pattern: string, glob: string, signal?: AbortSignal, max = 150): Promise<RgMatches> {
	const rg = await rgSearch(root, pattern, glob, signal, max);
	if (rg) {
		return rg;
	}
	const re = new RegExp(pattern, 'i');
	const out: Array<{ file: string; line: number; text: string }> = [];
	let truncated = false;
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (truncated || signal?.aborted) {
				return;
			}
			const abs = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP_DIRS.has(e.name)) walk(abs);
				continue;
			}
			const rel = path.relative(root, abs).split(path.sep).join('/');
			let text: string;
			try {
				if (fs.statSync(abs).size > 2_000_000) continue;
				text = fs.readFileSync(abs, 'utf8');
			} catch {
				continue;
			}
			if (text.slice(0, 8000).includes('\u0000')) continue;
			let perFile = 0;
			const lines = text.split('\n');
			for (let i = 0; i < lines.length && perFile < 40; i++) {
				if (re.test(lines[i])) {
					out.push({ file: rel, line: i + 1, text: `${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}` });
					perFile++;
					if (out.length >= max) {
						truncated = true;
						return;
					}
				}
			}
		}
	};
	walk(root);
	const matches = out.map((m) => m.text);
	return { matches, files: new Set(out.map((m) => m.file)).size, truncated };
}
