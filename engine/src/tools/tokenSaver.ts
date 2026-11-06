import * as fs from 'fs';
import * as path from 'path';
/**
 * Token Saver (RTK-style output compression). Tool outputs — build/test/
 * install logs, diffs, search results — are mostly noise for a model. When
 * enabled, outputs are cleaned before they enter the context window.
 *
 * Content-aware filters (ideas from rtk and 9router's JS port, MIT):
 *  - git diff: index/mode headers dropped, per-file +/- totals, hunks capped
 *  - grep-style "path:line: text": grouped by file, path printed once
 *  - build/install logs: "Compiling x" / "Downloading x" / deprecation spam
 *    counted instead of listed — but, unlike a pure errors-only filter,
 *    every other line is kept, so test failures and stack traces survive
 * Then the generic pass: ANSI + progress bars removed, identical lines
 * collapsed, near-identical runs folded, blank runs squeezed, and very long
 * output keeps the start and the (usually decisive) end.
 *
 * The original is never lost for the user: cards still show the full text.
 */

const PROGRESS = /(\d{1,3}%\s*[|█▓▒░#=>-]{3,})|(^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]\s)|(npm (WARN|notice) (deprecated|old lockfile))/i;

export interface SaverStats {
	before: number;
	after: number;
	filter?: string;
}

export type OutputKind = 'auto' | 'diff' | 'grep' | 'build' | 'log';

/** Running totals for the session in tokens (shown in the context popover and Features Health). */
const totals = { before: 0, after: 0 };
export function saverTotals(): { before: number; after: number } {
	return { ...totals };
}

/** Tokens of a possibly huge tool output: counted on the first 200k chars, scaled to the rest. */
function tokensOf(s: string): number {
	const cap = 200_000;
	return s.length <= cap ? countTokens(s) : Math.round((countTokens(s.slice(0, cap)) * s.length) / cap);
}

export function compressOutput(input: string, maxChars = 12_000, kind: OutputKind = 'auto'): { text: string; stats: SaverStats } {
	const before = input.length;
	let text = minifyJson(clean(input));
	const detected = kind === 'auto' ? detect(text) : kind;
	let filter: string | undefined;
	if (text.length >= 400) {
		const fn = detected === 'diff' ? compactDiff : detected === 'grep' ? groupGrep : detected === 'build' ? quietBuild : undefined;
		if (fn) {
			try {
				const out = fn(text);
				if (out && out.length < text.length) {
					text = out;
					filter = detected;
				}
			} catch {
				// a filter must never break a tool result
			}
		}
	}
	if (detected !== 'diff') {
		text = foldRepeats(text);
	}
	if (text.length > maxChars) {
		const head = Math.floor(maxChars * 0.35);
		text = `${text.slice(0, head)}\n[… ${text.length - maxChars} chars trimmed by Token Saver …]\n${text.slice(text.length - (maxChars - head))}`;
	}
	if (!text.trim() && input.trim()) {
		text = input.slice(0, maxChars);
	}
	const inTokens = tokensOf(input);
	totals.before += inTokens;
	totals.after += text === input ? inTokens : tokensOf(text);
	return { text, stats: { before, after: text.length, filter } };
}

/** ANSI codes, OSC sequences and \r-rewritten progress lines. */
function clean(input: string): string {
	// eslint-disable-next-line no-control-regex
	const noAnsi = input.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
	return noAnsi
		.split('\n')
		.map((l) => (l.includes('\r') ? l.split('\r').filter(Boolean).pop() ?? '' : l).replace(/\s+$/, ''))
		.join('\n');
}

function detect(text: string): OutputKind {
	const head = text.slice(0, 2000);
	if (/^diff --git /m.test(head) || (/^@@ .* @@/m.test(head) && /^[+-]/m.test(head))) {
		return 'diff';
	}
	if (/^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ packages?|\[(ERROR|INFO)\]|BUILD (SUCCESS|FAILED)|Successfully (installed|built))/im.test(head)) {
		return 'build';
	}
	const lines = head.split('\n').filter((l) => l.trim()).slice(0, 8);
	if (lines.length >= 3 && lines.filter((l) => /^[^\s:][^:]*:\d+:/.test(l)).length >= Math.ceil(lines.length * 0.7)) {
		return 'grep';
	}
	return 'log';
}

/** git diff → file headers, hunk headers and changed lines; per-file totals; long hunks capped. */
function compactDiff(diff: string, hunkMax = 120): string {
	const out: string[] = [];
	let file = '';
	let added = 0;
	let removed = 0;
	let shown = 0;
	let skipped = 0;
	const flushHunk = () => {
		if (skipped) {
			out.push(`  … ${skipped} more changed lines in this hunk`);
			skipped = 0;
		}
	};
	const flushFile = () => {
		flushHunk();
		if (file) {
			out.push(`  (+${added} −${removed})`);
		}
	};
	for (const line of diff.split('\n')) {
		if (line.startsWith('diff --git ')) {
			flushFile();
			file = line.split(' b/').slice(1).join(' b/') || line.slice(11);
			out.push(`\n${file}`);
			added = removed = 0;
		} else if (/^(index |similarity |rename |new file mode|deleted file mode|old mode|new mode|--- |\+\+\+ )/.test(line)) {
			if (/^(new file|deleted file|rename )/.test(line)) {
				out.push(`  ${line}`);
			}
		} else if (line.startsWith('@@')) {
			flushHunk();
			shown = 0;
			out.push(`  ${line}`);
		} else if (line.startsWith('+') || line.startsWith('-')) {
			line.startsWith('+') ? added++ : removed++;
			if (shown < hunkMax) {
				out.push(`  ${line}`);
				shown++;
			} else {
				skipped++;
			}
		} else if (line.startsWith(' ') && shown < hunkMax) {
			out.push(`  ${line}`);
			shown++;
		}
	}
	flushFile();
	return out.join('\n').trim();
}

/** "path:line: text" lines grouped per file; the path is printed once. */
function groupGrep(text: string, perFile = 25): string {
	const byFile = new Map<string, string[]>();
	const other: string[] = [];
	for (const line of text.split('\n')) {
		const m = line.match(/^([^\s:][^:]*):(\d+):\s?(.*)$/);
		if (m) {
			const list = byFile.get(m[1]) ?? [];
			list.push(`  ${m[2].padStart(4)}: ${m[3].trim()}`);
			byFile.set(m[1], list);
		} else if (line.trim()) {
			other.push(line);
		}
	}
	if (!byFile.size) {
		return text;
	}
	const out: string[] = [];
	for (const [file, list] of byFile) {
		out.push(`${file} (${list.length})`, ...list.slice(0, perFile));
		if (list.length > perFile) {
			out.push(`  … ${list.length - perFile} more in this file`);
		}
	}
	return [...out, ...other].join('\n');
}

/** Build/install logs: count the chatter, keep every other line (errors, test failures, summaries). */
function quietBuild(text: string): string {
	const out: string[] = [];
	let compiling = 0;
	let downloading = 0;
	const deprecations: string[] = []; // counted only
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (/^(Compiling|Checking|Building)\s+\S+\s+v?\d/i.test(t)) {
			compiling++;
		} else if (/^(Downloading|Downloaded|Fetching|Resolving|Unpacking)\s+\S+/i.test(t) || /^Collecting\s+\S+/.test(t)) {
			downloading++;
		} else if (/^npm warn deprecated/i.test(t) || /^warning .*deprecated/i.test(t)) {
			deprecations.push(line);
		} else if (/^(npm (notice|http fetch|timing|sill|verb))/i.test(t) || /^(Using cached|Requirement already satisfied)/i.test(t)) {
			// pure chatter
		} else {
			out.push(line);
		}
	}
	const head: string[] = [];
	if (compiling) {
		head.push(`[compiled ${compiling} packages]`);
	}
	if (downloading) {
		head.push(`[downloaded/resolved ${downloading} packages]`);
	}
	if (deprecations.length) {
		head.push(`[${deprecations.length} deprecation warning${deprecations.length > 1 ? 's' : ''} hidden]`);
	}
	return [...head, ...out].join('\n');
}

/** Identical lines collapsed, near-identical runs folded, progress and blank runs removed. */
function foldRepeats(text: string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (PROGRESS.test(line)) {
			i++;
			continue;
		}
		let j = i + 1;
		while (j < lines.length && lines[j] === line) {
			j++;
		}
		if (j - i > 2) {
			out.push(line, `… (repeated ${j - i - 1}× more)`);
			i = j;
			continue;
		}
		// near-identical runs: same first 24 chars, 8+ lines → head 3 + tail 2
		const key = line.slice(0, 24);
		if (key.trim().length >= 8) {
			let k = i + 1;
			while (k < lines.length && lines[k].slice(0, 24) === key) {
				k++;
			}
			if (k - i >= 8) {
				out.push(...lines.slice(i, i + 3), `… ${k - i - 5} similar lines …`, ...lines.slice(k - 2, k));
				i = k;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Pretty-printed JSON (API / MCP / web responses) → compact JSON: same data, far fewer tokens. */
export function minifyJson(text: string): string {
	const t = text.trim();
	if (t.length < 300 || !/^[[{]/.test(t) || !/[\]}]$/.test(t) || !/\n\s+"/.test(t)) {
		return text;
	}
	try {
		return JSON.stringify(JSON.parse(t));
	} catch {
		return text;
	}
}

// ---------------------------------------------------------------- System-One style decisions (JEV-inspired)
// Fast, structured, deterministic decisions that spend no model tokens.

/** Tools whose output is a pure function of the workspace/page state: a repeat is exact. */
const REPEATABLE = new Set(['read_file', 'grep', 'list_files', 'git_diff', 'git_status', 'git_log', 'get_diagnostics', 'web_fetch', 'semantic_search', 'code_intel', 'browser_console', 'browser_network', 'session_search']);

function fnv(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	}
	return (h >>> 0).toString(36) + s.length.toString(36);
}

/**
 * The model already has this exact output in its context (an earlier call
 * still in the transcript): send a one-line pointer instead of repeating it.
 * Checked against the live transcript, so after compaction the full text
 * comes back by itself.
 */
export function elideRepeat(messages: ReadonlyArray<{ role: string; name?: string; content?: string }>, name: string, content: string): string {
	if (!REPEATABLE.has(name) || content.length < 600) {
		return content;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'tool' && m.name === name && m.content === content) {
			const pointer = `[Identical to the earlier ${name} result above (${content.length.toLocaleString('en-US')} chars) — nothing changed, so it is not repeated. Token Saver]`;
			totals.before += tokensOf(content);
			totals.after += countTokens(pointer);
			return pointer;
		}
	}
	return content;
}

/**
 * Cache Guard: prompt caches only reuse an identical prefix. Every request's
 * prefix (system + tools, then each message) is fingerprinted; if the part
 * sent last time is not an exact prefix of this request, the cache was broken
 * and we record where — so breaks can be seen and fixed instead of guessed.
 */
export class CacheGuard {
	private last: string[] = [];
	private session = '';
	checks = 0;
	breaks = 0;
	lastBreak?: string;

	check(session: string, head: string, messages: ReadonlyArray<unknown>): boolean {
		if (session !== this.session) {
			this.session = session;
			this.last = [];
		}
		const fp = [fnv(head), ...messages.map((m) => fnv(JSON.stringify(m)))];
		this.checks++;
		let stable = true;
		if (this.last.length) {
			const at = this.last.findIndex((h, i) => h !== fp[i]);
			if (at !== -1) {
				stable = false;
				this.breaks++;
				this.lastBreak = at === 0 ? 'system prompt or tools changed' : `message ${at} was changed after it was sent`;
			}
		}
		this.last = fp;
		return stable;
	}

	/** Compaction rewrites history on purpose: start a fresh baseline. */
	reset(): void {
		this.last = [];
	}

	get stability(): number | undefined {
		return this.checks ? Math.round(((this.checks - this.breaks) / this.checks) * 1000) / 10 : undefined;
	}
}

/**
 * Is refreshing an Anthropic prompt cache worth it? (pi's cache-warmer gate.)
 * Missing the cache after it expires costs the write premium on the whole
 * prefix (1.25× instead of 0.1×); a refresh costs one cached read. Worth it
 * when the avoided premium is at least $0.05 (pure; tested).
 */
export function cacheWarmValue(promptTokens: number, priceInPerM: number | undefined): { worth: boolean; saves: number; costs: number } {
	if (!priceInPerM || promptTokens < 4_000) return { worth: false, saves: 0, costs: 0 };
	const saves = (promptTokens * (1.25 - 0.1) * priceInPerM) / 1e6;
	const costs = (promptTokens * 0.1 * priceInPerM) / 1e6;
	return { worth: saves >= 0.05, saves: Math.round(saves * 1e4) / 1e4, costs: Math.round(costs * 1e4) / 1e4 };
}

const SPILL_DIR = ['.zer0ne', 'spill'];
const SPILL_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * Output spill (OpenCode): when Token Saver has to cut a long output, the
 * whole text is kept in the project at .zer0ne/spill/ (git-ignored, pruned
 * after 7 days) and the model gets a pointer to read or grep the part it
 * needs — nothing is lost. Returns the note to append ('' when nothing was cut).
 */
export function spillOutput(root: string | undefined, full: string, compressed: string, label: string): string {
	if (!/chars trimmed by Token Saver|characters omitted …\]/.test(compressed)) return '';
	const rel = spillText(root, full, label);
	return rel ? `\n[Full output (${full.split('\n').length} lines) saved to ${rel} — read_file it with offset/limit, or grep it, for the part that was trimmed.]` : '';
}

/** Keeps `full` in the project's spill folder; returns its project-relative path, or undefined when it could not be saved. */
export function spillText(root: string | undefined, full: string, label: string): string | undefined {
	if (!root) return undefined;
	try {
		const dir = path.join(root, ...SPILL_DIR);
		fs.mkdirSync(dir, { recursive: true });
		const ignore = path.join(dir, '.gitignore');
		if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
		const now = Date.now();
		for (const f of fs.readdirSync(dir)) {
			if (f === '.gitignore') continue;
			try {
				if (now - fs.statSync(path.join(dir, f)).mtimeMs > SPILL_KEEP_MS) fs.rmSync(path.join(dir, f), { force: true });
			} catch {
				/* already gone */
			}
		}
		const name = `${new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}-${label.replace(/[^\w-]+/g, '-').slice(0, 40) || 'output'}.log`;
		fs.writeFileSync(path.join(dir, name), full);
		return [...SPILL_DIR, name].join('/');
	} catch {
		return undefined;
	}
}

/**
 * Token count without a tokenizer download: the o200k pre-tokenizer split,
 * then a per-piece cost fitted against the real o200k encoder on code, CSS,
 * markdown, JSON, logs, CJK and other scripts (mean error ≈ 2%, every kind
 * within ±8% — chars/3.5 was ≈ 10% and up to 42% off on CJK).
 */
const PRETOKEN = /[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]*[\p{Ll}\p{Lm}\p{Lo}\p{M}]+|[^\r\n\p{L}\p{N}]?[\p{Lu}\p{Lt}\p{Lm}\p{Lo}\p{M}]+[\p{Ll}\p{Lm}\p{Lo}\p{M}]*|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n/]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const NON_LATIN = /[^\u0000-\u024f\u1e00-\u1eff]/;
const LETTER = /\p{L}/u;
const NUMBER = /\p{N}/u;
export function countTokens(text: string): number {
	let n = 0;
	for (const m of text.matchAll(PRETOKEN)) {
		const p = m[0];
		const L = p.length;
		if (CJK.test(p)) n += Math.ceil(L * 0.7);
		else if (NON_LATIN.test(p) && LETTER.test(p)) n += Math.max(1, Math.ceil(p.replace(/[^\p{L}\p{M}]/gu, '').length * 0.5));
		else if (LETTER.test(p)) n += L <= 8 ? 1 : 1 + Math.ceil((L - 8) / 3);
		else if (NUMBER.test(p) || /^\s+$/.test(p)) n += 1;
		else n += Math.max(1, Math.ceil(L / 4));
	}
	return n;
}

/** Tokens of a conversation as a model sees it (content + tool calls + a small per-message overhead). */
export function countMessageTokens(messages: ReadonlyArray<{ content?: string; reasoning?: string; native?: { items: unknown[]; outputTokens?: number }; images?: ReadonlyArray<{ base64: string }>; toolCalls?: ReadonlyArray<{ name: string; arguments: string; signature?: string }> }>): number {
	let n = 0;
	for (const m of messages) {
		let visible = countTokens(m.content ?? '') + countTokens(m.reasoning ?? '');
		for (const c of m.toolCalls ?? []) visible += 8 + countTokens(c.name) + countTokens(c.arguments) + (!m.native && c.signature ? Math.ceil(c.signature.length / 4) : 0);
		n += 4 + (m.native ? Math.max(visible, m.native.outputTokens ?? Math.ceil(JSON.stringify(m.native.items).length / 4)) : visible);
		// Image cost varies with provider/detail/resolution; keep an explicit conservative allowance.
		for (const image of m.images ?? []) n += Math.max(1024, Math.min(16_384, Math.ceil(image.base64.length / 750)));
	}
	return n;
}
