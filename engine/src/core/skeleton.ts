/*
 * Token Saver for reads and edits (ideas from oh-my-pi and tau, both MIT):
 *
 *  - skeleton(): a large source file is shown as its structure — imports,
 *    signatures and short blocks stay, long function bodies and comment
 *    blocks fold into one marker line that says how to read them. The model
 *    reads the one body it needs instead of the whole file.
 *  - contentTag() + applyLineEdits(): "hashline" edits. Every read carries a
 *    4-hex tag of the file's content; edit_lines replaces numbered line
 *    ranges and refuses a stale tag, so the model never retypes old text and
 *    never edits a file that changed under it.
 *
 * Pure functions, no VS Code: shared by the extension, the CLI and tests.
 */

/** 4-hex FNV-1a of the file's text (line endings normalized). */
export function contentTag(text: string): string {
	const s = text.replace(/\r\n/g, '\n');
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return ((h >>> 0) & 0xffff).toString(16).padStart(4, '0');
}

export interface SkeletonOptions {
	/** Files shorter than this are read in full. */
	minLines?: number;
	/** Bodies shorter than this stay visible. */
	minFold?: number;
}

export interface Skeleton {
	text: string;
	totalLines: number;
	shownLines: number;
	folds: Array<[number, number]>;
}

const BRACE = /\.(ts|tsx|js|jsx|mjs|cjs|java|c|h|cc|cpp|hpp|cs|go|rs|php|swift|kt|kts|scala|dart|css|scss|less)$/i;
const INDENT = /\.(py|pyi)$/i;
const CONTAINER = /\b(class|interface|namespace|module|impl|trait|enum|struct|object|extension|protocol)\b/;

/**
 * The structural view of `text`, or null when the file is short, not a
 * language we fold, or folding would not save at least a third.
 */
export function skeleton(path: string, text: string, opts: SkeletonOptions = {}): Skeleton | null {
	const lines = text.split(/\r?\n/);
	const minLines = opts.minLines ?? 350;
	const minFold = opts.minFold ?? 8;
	if (lines.length < minLines) {
		return null;
	}
	let folds: Array<[number, number]>;
	if (BRACE.test(path)) {
		folds = braceFolds(lines, minFold);
	} else if (INDENT.test(path)) {
		folds = indentFolds(lines, minFold);
	} else {
		return null;
	}
	folds = folds.concat(commentFolds(lines, 6)).sort((a, b) => a[0] - b[0]);
	// Drop folds nested inside an earlier one.
	const merged: Array<[number, number]> = [];
	for (const f of folds) {
		const last = merged[merged.length - 1];
		if (last && f[0] <= last[1]) {
			continue;
		}
		merged.push(f);
	}
	const hidden = merged.reduce((n, [a, b]) => n + (b - a + 1), 0);
	if (hidden < lines.length / 3) {
		return null;
	}
	let out = '';
	let shown = 0;
	let i = 1;
	for (const [a, b] of merged) {
		for (; i < a; i++, shown++) {
			out += `${i}\t${clipLine(lines[i - 1])}\n`;
		}
		out += `\t⋯ ${b - a + 1} lines folded (${a}–${b}) — read_file offset=${a} limit=${b - a + 1}\n`;
		i = b + 1;
	}
	for (; i <= lines.length; i++, shown++) {
		out += `${i}\t${clipLine(lines[i - 1])}\n`;
	}
	return { text: out, totalLines: lines.length, shownLines: shown, folds: merged };
}

const clipLine = (l: string) => (l.length > 2000 ? l.slice(0, 2000) + '…' : l);

/**
 * Blocks opened with `{`: top-level bodies fold whole; containers (class,
 * interface, impl…) stay open and their members' bodies fold instead.
 * Strings, template literals and comments are skipped while counting braces.
 */
function braceFolds(lines: string[], minFold: number): Array<[number, number]> {
	// Collect every block first; decide what folds once sizes are known.
	const blocks: Array<{ start: number; end: number; keyword: boolean; parent: number }> = [];
	const stack: number[] = [];
	let depth = 0;
	let inBlockComment = false;
	let inTemplate = false;
	for (let n = 0; n < lines.length; n++) {
		const line = lines[n];
		let quote = '';
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlockComment) {
				if (ch === '*' && next === '/') {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (inTemplate) {
				if (ch === '\\') i++;
				else if (ch === '`') inTemplate = false;
				continue;
			}
			if (quote) {
				if (ch === '\\') i++;
				else if (ch === quote) quote = '';
				continue;
			}
			if (ch === '/' && next === '/') break;
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === '`') {
				inTemplate = true;
				continue;
			}
			if (ch === '{') {
				// A block's "opener" is the line where it starts; a lone "{" belongs to the line above.
				const opener = line.trim() === '{' && n > 0 ? lines[n - 1] : line;
				blocks.push({ start: n + 1, end: lines.length, keyword: CONTAINER.test(opener) && !/=>|\bfunction\b/.test(opener), parent: stack.length ? stack[stack.length - 1] : -1 });
				stack.push(blocks.length - 1);
				depth++;
			} else if (ch === '}') {
				depth = Math.max(0, depth - 1);
				const open = stack.pop();
				if (open !== undefined) blocks[open].end = n + 1;
			}
		}
	}
	// A container stays open so its members fold: class/interface/impl…, or any
	// block wrapping most of the file (an IIFE, a module-level describe()).
	const children = blocks.map(() => 0);
	for (const b of blocks) if (b.parent >= 0) children[b.parent]++;
	const container = blocks.map((b, i) => b.keyword || (b.end - b.start > lines.length * 0.45 && children[i] >= 3));
	const openChain = (i: number): boolean => i < 0 || (container[i] && openChain(blocks[i].parent));
	const folds: Array<[number, number]> = [];
	blocks.forEach((b, i) => {
		// Fold the outermost non-container blocks; keep the opener and the closing line.
		if (!container[i] && openChain(b.parent) && b.end - b.start - 1 >= minFold) {
			folds.push([b.start + 1, b.end - 1]);
		}
	});
	return folds;
}

/** Python: bodies of def/class-level functions longer than minFold. */
function indentFolds(lines: string[], minFold: number): Array<[number, number]> {
	const folds: Array<[number, number]> = [];
	const indentOf = (l: string) => l.length - l.trimStart().length;
	for (let n = 0; n < lines.length; n++) {
		const m = /^(\s*)(async\s+)?def\s/.exec(lines[n]);
		if (!m || m[1].length > 4) continue;
		const base = m[1].length;
		// The signature may span lines until the one ending with ':'.
		let body = n + 1;
		while (body < lines.length && !/:\s*(#.*)?$/.test(lines[body - 1])) body++;
		let end = body;
		while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > base)) end++;
		while (end > body && lines[end - 1].trim() === '') end--;
		if (end - body >= minFold) folds.push([body + 1, end]);
		n = end - 1;
	}
	return folds;
}

/** Long block comments and runs of line comments (keep their first line). */
function commentFolds(lines: string[], min: number): Array<[number, number]> {
	const folds: Array<[number, number]> = [];
	for (let n = 0; n < lines.length; n++) {
		const t = lines[n].trim();
		if (t.startsWith('/*')) {
			let end = n;
			while (end < lines.length && !lines[end].includes('*/')) end++;
			if (end - n >= min) folds.push([n + 2, end + 1]);
			n = end;
		} else if (/^(\/\/|#(?!!|include|define|if|endif|pragma))/.test(t)) {
			let end = n;
			while (end + 1 < lines.length && /^(\/\/|#)/.test(lines[end + 1].trim())) end++;
			if (end - n >= min) folds.push([n + 2, end + 1]);
			n = end;
		}
	}
	return folds;
}

export interface LineEdit {
	/** First line to replace (1-based, as read_file shows it). */
	start: number;
	/** Last line to replace (inclusive). end = start - 1 inserts before `start`. */
	end: number;
	/** Replacement text (may be empty to delete; several lines allowed). */
	text: string;
}

/**
 * Apply numbered-range edits to `text`. Ranges refer to the file as it was
 * read (all of them, not after each other) and must not overlap. Line
 * endings follow the file's.
 */
export function applyLineEdits(text: string, edits: LineEdit[]): string {
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const lines = text.split(/\r?\n/);
	const list = edits
		.map((e) => ({ start: Math.floor(Number(e.start)), end: Math.floor(Number(e.end)), text: String(e.text ?? '') }))
		.sort((a, b) => a.start - b.start);
	if (!list.length) {
		throw new Error('No edits given.');
	}
	let prevEnd = 0;
	for (const e of list) {
		if (!Number.isFinite(e.start) || !Number.isFinite(e.end) || e.start < 1 || e.start > lines.length + 1) {
			throw new Error(`Line ${e.start} is outside the file (1–${lines.length}).`);
		}
		if (e.end < e.start - 1 || e.end > lines.length) {
			throw new Error(`Range ${e.start}–${e.end} is invalid for a file of ${lines.length} lines.`);
		}
		if (e.start <= prevEnd) {
			throw new Error(`Edits overlap at line ${e.start}. Merge them into one range.`);
		}
		prevEnd = Math.max(prevEnd, e.end);
	}
	// Bottom-up so earlier line numbers stay valid.
	for (const e of [...list].reverse()) {
		const replacement = e.text === '' ? [] : e.text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
		lines.splice(e.start - 1, e.end - e.start + 1, ...replacement);
	}
	return lines.join(eol);
}
