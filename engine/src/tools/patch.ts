/**
 * Text-matching helpers for the editing tools.
 *
 *  - findUnique: locate the text an edit should replace. Exact match first,
 *    then exact matches after a fixed rewrite of old_string (read line-number
 *    prefixes, over-escaped \n / \", \uXXXX escapes), then progressively
 *    looser line-based matches (trailing whitespace, surrounding whitespace,
 *    indentation, collapsed whitespace and typographic quotes) — never when a
 *    match is ambiguous, and never by similarity: a block whose content differs
 *    (call(100) vs call(900)) is refused, unlike block-anchor / Levenshtein
 *    matchers.
 *  - adaptReplacement: carry the same correction over to new_string.
 *  - parsePatch / applyChunks: the Codex `apply_patch` envelope
 *    (*** Begin Patch / Add File / Update File / Move to / Delete File / End Patch).
 */

export type MatchStrategy = 'line numbers' | 'escaped text' | 'unicode escapes' | 'trailing whitespace' | 'indentation' | 'whitespace and quotes';

export interface Match {
	index: number;
	text: string;
	/** Which strategy matched (for the tool summary). */
	how: 'exact' | 'fuzzy';
	/** What made a non-exact match work — told to the model so it can check. */
	strategy?: MatchStrategy;
	/** 1-based line of the match's start. */
	line: number;
}

/** Rewrites of old_string that make a copy-paste slip exact again (ZCode / Gemini CLI). */
const REWRITES: Array<[MatchStrategy, (s: string) => string | null]> = [
	['line numbers', stripLineNumbers],
	['escaped text', (s) => (s.includes('\n') || !/\\[nrt"'`\\]/.test(s) ? null : unescapeVisible(s))],
	['unicode escapes', (s) => (/\\u[0-9a-fA-F]{4}/.test(s) ? decodeUnicode(s) : null)]
];

/** Find `find` in `content`; throws a model-friendly error when missing or ambiguous. */
export function findUnique(content: string, find: string, file: string): Match {
	const exact = countOf(content, find);
	if (exact === 1) {
		const index = content.indexOf(find);
		return { index, text: find, how: 'exact', line: lineAt(content, index) };
	}
	if (exact > 1) {
		throw new Error(`old_string matches ${exact} places in ${file}. Include more surrounding lines to make it unique, or set replace_all.`);
	}
	for (const [strategy, rewrite] of REWRITES) {
		const fixed = rewrite(find);
		if (fixed === null || fixed === find || !fixed) continue;
		const n = countOf(content, fixed);
		if (n === 1) {
			const index = content.indexOf(fixed);
			return { index, text: fixed, how: 'fuzzy', strategy, line: lineAt(content, index) };
		}
		if (n > 1) {
			throw new Error(`old_string matches ${n} places in ${file} (after removing ${strategy}). Include more surrounding lines to make it unique.`);
		}
	}
	const lines = content.split('\n');
	const want = find.replace(/\n$/, '').split('\n');
	const strategies: Array<[MatchStrategy, (a: string, b: string) => boolean]> = [
		['trailing whitespace', (a, b) => a.trimEnd() === b.trimEnd()],
		['indentation', (a, b) => a.trim() === b.trim()],
		['whitespace and quotes', (a, b) => norm(a) === norm(b)]
	];
	for (const [strategy, same] of strategies) {
		const hits = seekAll(lines, want, same);
		if (hits.length === 1) {
			return { ...spanOf(lines, hits[0], want.length), strategy };
		}
		if (hits.length > 1) {
			throw new Error(`old_string matches ${hits.length} places in ${file} (ignoring whitespace). Include more surrounding lines to make it unique.`);
		}
	}
	throw new Error(`old_string was not found in ${file}. Re-read the file and copy the exact current text (without line-number prefixes).`);
}

/**
 * The new text for a match: the correction that made old_string match is
 * applied to new_string only when new_string shows the same slip, so a real
 * "\n" or "é" the code needs is never rewritten.
 */
export function adaptReplacement(m: Match, find: string, replace: string): string {
	let out = replace;
	switch (m.strategy) {
		case 'line numbers':
			out = stripLineNumbers(replace) ?? replace;
			break;
		case 'escaped text':
			// Only a payload escaped as a whole (no real newline anywhere) is unescaped.
			if (!replace.includes('\n')) out = unescapeVisible(replace);
			break;
		case 'unicode escapes':
			if (!/\\u[0-9a-fA-F]{4}/.test(m.text)) out = decodeUnicode(replace);
			break;
		case 'trailing whitespace':
		case 'indentation':
		case 'whitespace and quotes':
			out = reindent(m.text, find, replace);
			break;
	}
	return m.how === 'exact' ? out : keepQuoteStyle(m.text, find, out);
}

/** "edit applied by matching …" — appended to the tool result for non-exact matches. */
export function matchNote(m: Match): string {
	return m.how === 'exact' || !m.strategy ? '' : ` Matched at line ${m.line} after allowing for ${m.strategy} — check the result.`;
}

function lineAt(content: string, index: number): number {
	let n = 1;
	for (let i = content.indexOf('\n'); i !== -1 && i < index; i = content.indexOf('\n', i + 1)) n++;
	return n;
}

/** "12\tcode" / "12: code" / "  12→code" on every line (copied read output) → the code. */
function stripLineNumbers(s: string): string | null {
	const lines = s.split('\n');
	const last = lines[lines.length - 1] === '' ? lines.pop() : undefined;
	if (!lines.length) return null;
	const out: string[] = [];
	for (const l of lines) {
		const m = /^\s*\d+(?:\t|: |→)(.*)$/.exec(l);
		if (!m) return null;
		out.push(m[1]);
	}
	return out.join('\n') + (last !== undefined ? '\n' : '');
}

function unescapeVisible(s: string): string {
	return s.replace(/\\([nrt"'`\\])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

function decodeUnicode(s: string): string {
	return s.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (m, escaped: string | undefined, hex: string) => (escaped !== undefined ? m : String.fromCharCode(parseInt(hex, 16))));
}

const CURLY = { '"': ['“', '”'], "'": ['‘', '’'] } as const;

/**
 * The file region uses typographic quotes and the model wrote straight ones:
 * write typographic quotes back instead of silently changing the file's style.
 * Only when the region has no straight quote of that kind (so code stays code).
 */
function keepQuoteStyle(matched: string, find: string, replace: string): string {
	let out = replace;
	for (const q of ['"', "'"] as const) {
		const [open, close] = CURLY[q];
		if ((matched.includes(open) || matched.includes(close)) && !matched.includes(q) && !find.includes(open) && !find.includes(close)) {
			const chars = [...out];
			out = chars
				.map((c, i) => {
					if (c !== q) return c;
					const prev = chars[i - 1];
					if (q === "'" && prev !== undefined && /\p{L}/u.test(prev) && /\p{L}/u.test(chars[i + 1] ?? '')) return close; // don't, it's
					return i === 0 || /[\s([{—–]/.test(prev ?? '') ? open : close;
				})
				.join('');
		}
	}
	return out;
}

function norm(s: string): string {
	return s
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, '-')
		.replace(/\s+/g, ' ')
		.trim();
}

function countOf(haystack: string, needle: string): number {
	return needle ? haystack.split(needle).length - 1 : 0;
}

function seekAll(lines: string[], want: string[], same: (a: string, b: string) => boolean, from = 0): number[] {
	const out: number[] = [];
	if (!want.length) {
		return out;
	}
	for (let i = from; i <= lines.length - want.length; i++) {
		let ok = true;
		for (let j = 0; j < want.length && ok; j++) {
			ok = same(lines[i + j], want[j]);
		}
		if (ok) {
			out.push(i);
		}
	}
	return out;
}

function spanOf(lines: string[], start: number, count: number): Match {
	let index = 0;
	for (let k = 0; k < start; k++) {
		index += lines[k].length + 1;
	}
	return { index, text: lines.slice(start, start + count).join('\n'), how: 'fuzzy', line: start + 1 };
}

/**
 * Re-indent replacement text when a fuzzy match found the block at a
 * different indentation than the model wrote it.
 */
export function reindent(matched: string, find: string, replace: string): string {
	const lead = (s: string) => (s.split('\n').find((l) => l.trim()) ?? '').match(/^\s*/)![0];
	const have = lead(matched);
	const wrote = lead(find);
	if (have === wrote) {
		return replace;
	}
	return replace
		.split('\n')
		.map((l) => (l.startsWith(wrote) ? have + l.slice(wrote.length) : l))
		.join('\n');
}

// ---------------------------------------------------------------- apply_patch

export type PatchHunk =
	| { type: 'add'; path: string; contents: string }
	| { type: 'delete'; path: string }
	| { type: 'update'; path: string; movePath?: string; chunks: PatchChunk[] };

export interface PatchChunk {
	context?: string;
	oldLines: string[];
	newLines: string[];
	eof?: boolean;
}

export function parsePatch(text: string): PatchHunk[] {
	const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
	const begin = lines.findIndex((l) => l.trim() === '*** Begin Patch');
	const end = lines.findIndex((l) => l.trim() === '*** End Patch');
	if (begin === -1 || end === -1 || end < begin) {
		throw new Error('Invalid patch: it must start with "*** Begin Patch" and end with "*** End Patch".');
	}
	const hunks: PatchHunk[] = [];
	let i = begin + 1;
	while (i < end) {
		const line = lines[i];
		const header = (prefix: string) => (line.startsWith(prefix) ? line.slice(prefix.length).trim() : undefined);
		const add = header('*** Add File:');
		const del = header('*** Delete File:');
		const upd = header('*** Update File:');
		if (add) {
			const body: string[] = [];
			i++;
			while (i < end && !lines[i].startsWith('*** ')) {
				if (lines[i].startsWith('+')) {
					body.push(lines[i].slice(1));
				}
				i++;
			}
			hunks.push({ type: 'add', path: add, contents: body.join('\n') + '\n' });
		} else if (del) {
			hunks.push({ type: 'delete', path: del });
			i++;
		} else if (upd) {
			i++;
			let movePath: string | undefined;
			if (i < end && lines[i].startsWith('*** Move to:')) {
				movePath = lines[i].slice('*** Move to:'.length).trim();
				i++;
			}
			const chunks: PatchChunk[] = [];
			let cur: PatchChunk | undefined;
			while (i < end && !(lines[i].startsWith('*** ') && lines[i] !== '*** End of File')) {
				const l = lines[i];
				if (l.startsWith('@@')) {
					cur = { context: l.slice(2).trim() || undefined, oldLines: [], newLines: [] };
					chunks.push(cur);
				} else if (l === '*** End of File') {
					if (cur) {
						cur.eof = true;
					}
				} else {
					if (!cur) {
						cur = { oldLines: [], newLines: [] };
						chunks.push(cur);
					}
					const body = l.slice(1);
					if (l.startsWith('-')) {
						cur.oldLines.push(body);
					} else if (l.startsWith('+')) {
						cur.newLines.push(body);
					} else {
						// Context line (" x", or a bare empty line).
						cur.oldLines.push(l.startsWith(' ') ? body : l);
						cur.newLines.push(l.startsWith(' ') ? body : l);
					}
				}
				i++;
			}
			hunks.push({ type: 'update', path: upd, movePath, chunks: chunks.filter((c) => c.oldLines.length || c.newLines.length) });
		} else {
			i++;
		}
	}
	if (!hunks.length) {
		throw new Error('The patch contains no file operations.');
	}
	return hunks;
}

/** Apply update chunks to a file's text (line endings preserved by the caller). */
export function applyChunks(original: string, chunks: PatchChunk[], file: string): string {
	const lines = original.split('\n');
	const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
	if (trailingNewline) {
		lines.pop();
	}
	const replacements: Array<[number, number, string[]]> = [];
	let cursor = 0;
	const compares: Array<(a: string, b: string) => boolean> = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim(), (a, b) => norm(a) === norm(b)];
	const seek = (want: string[], from: number, eof?: boolean): number => {
		for (const same of compares) {
			if (eof) {
				const at = lines.length - want.length;
				if (at >= from && want.every((w, j) => same(lines[at + j], w))) {
					return at;
				}
			}
			const hits = seekAll(lines, want, same, from);
			if (hits.length) {
				return hits[0];
			}
		}
		return -1;
	};
	for (const chunk of chunks) {
		if (chunk.context) {
			const at = seek([chunk.context], cursor);
			if (at === -1) {
				throw new Error(`Could not find the context line "@@ ${chunk.context}" in ${file}.`);
			}
			cursor = at + 1;
		}
		if (!chunk.oldLines.length) {
			replacements.push([chunk.eof || !chunk.context ? lines.length : cursor, 0, chunk.newLines]);
			continue;
		}
		let want = chunk.oldLines;
		let next = chunk.newLines;
		let at = seek(want, cursor, chunk.eof);
		if (at === -1 && want[want.length - 1] === '') {
			want = want.slice(0, -1);
			next = next[next.length - 1] === '' ? next.slice(0, -1) : next;
			at = seek(want, cursor, chunk.eof);
		}
		if (at === -1) {
			throw new Error(`Could not find these lines in ${file}:\n${chunk.oldLines.join('\n')}\nRe-read the file and make the - and context lines match it exactly.`);
		}
		replacements.push([at, want.length, next]);
		cursor = at + want.length;
	}
	replacements.sort((a, b) => a[0] - b[0]);
	for (let k = replacements.length - 1; k >= 0; k--) {
		const [start, count, add] = replacements[k];
		lines.splice(start, count, ...add);
	}
	return lines.join('\n') + (trailingNewline || !original ? '\n' : '');
}
