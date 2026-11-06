import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Continue a Claude Code or Codex chat in zer0ne (oh-my-pi's foreign session
 * import). Reads their local session logs — never their credentials:
 *
 *  - Claude Code: ~/.claude/projects/<folder>/<id>.jsonl, one record per line
 *    ({ type: user|assistant, message: { content: string | blocks[] }, cwd }).
 *    Sidechain (subagent) and meta records are skipped, as omp does.
 *  - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *    ({ type: session_meta|response_item, payload }). Injected context
 *    (<environment_context>, <user_instructions>, AGENTS.md) is skipped.
 *
 * Messages come back in zer0ne's stored shape: user and assistant text, and
 * tool calls as tool cards (name, argument, output excerpt).
 */

export type ForeignSource = 'claude' | 'codex';

export interface ForeignSessionInfo {
	source: ForeignSource;
	path: string;
	cwd: string;
	title: string;
	modified: number;
}

export interface ForeignMessage {
	role: 'user' | 'assistant';
	content: string;
	tool?: { name: string; arg: string; summary: string; detail?: string };
}

const home = () => process.env.ZER0NE_FOREIGN_HOME ?? os.homedir();
const HEAD_BYTES = 256 * 1024;
/** The biggest session log that is read into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** The most messages one import brings in. */
const MAX_MESSAGES = 2000;

/**
 * Blocks the other agents inject into a user message. They are not the
 * user's words and must not be replayed as instructions — and they are not
 * always at the start of the message, so they are stripped wherever they are.
 */
const INJECTED_TAG = 'environment_context|user_instructions|recommended_plugins|system-reminder|command-name|command-message|local-command|local-command-stdout|user-prompt-submit-hook|[\\w-]+_(context|instructions)';
const INJECTED_BLOCK = new RegExp(`<(${INJECTED_TAG})>[\\s\\S]*?<\\/\\1>`, 'gi');
const INJECTED_OPEN = new RegExp(`<(${INJECTED_TAG})>`, 'gi');
/** Header lines of an injected block: everything from such a line down was added by the harness. */
const INJECTED_HEADER = /^(?:permissions\s*:?\s*$|#\s*AGENTS\.md\b.*|Caveat:\s*The messages below\b.*)$/im;

/** The message without the parts the harness added. */
function stripInjected(text: string): string {
	if (!text) return '';
	let out = text.replace(INJECTED_BLOCK, '').replace(INJECTED_OPEN, '');
	const header = INJECTED_HEADER.exec(out);
	if (header) out = out.slice(0, header.index);
	return out.trim();
}

function readHead(file: string): string {
	let fd: number;
	try {
		fd = fs.openSync(file, 'r');
	} catch {
		return '';
	}
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
		return buf.subarray(0, n).toString('utf8');
	} catch {
		return '';
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
	}
}

function* records(text: string): Generator<any> {
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			yield JSON.parse(line);
		} catch {
			// a torn last line of the head, or a corrupt record: skip it
		}
	}
}

function textOf(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.map((b) => (b && typeof b === 'object' && typeof (b as any).text === 'string' && /^(text|input_text|output_text)$/.test((b as any).type ?? 'text') ? (b as any).text : ''))
		.filter(Boolean)
		.join('\n');
}

const oneLine = (s: string, n = 90) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function walk(dir: string, match: RegExp, out: string[], depth = 0): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory() && depth < 4) {
			walk(p, match, out, depth + 1);
		} else if (e.isFile() && match.test(e.name)) {
			out.push(p);
		}
	}
	return out;
}

/** Sessions of both agents, newest first; those in `cwd` first when given. */
export function listForeignSessions(cwd?: string, limit = 60): ForeignSessionInfo[] {
	const files: Array<{ source: ForeignSource; file: string; mtime: number }> = [];
	// A log can be deleted between the walk and the stat: skip it, do not fail.
	const mtimeOf = (file: string): number | undefined => {
		try {
			return fs.statSync(file).mtimeMs;
		} catch {
			return undefined;
		}
	};
	for (const file of walk(path.join(home(), '.claude', 'projects'), /\.jsonl$/, [])) {
		const mtime = mtimeOf(file);
		if (mtime !== undefined) files.push({ source: 'claude', file, mtime });
	}
	for (const file of walk(path.join(home(), '.codex', 'sessions'), /^rollout-.*\.jsonl$/, [])) {
		const mtime = mtimeOf(file);
		if (mtime !== undefined) files.push({ source: 'codex', file, mtime });
	}
	files.sort((a, b) => b.mtime - a.mtime);
	const out: ForeignSessionInfo[] = [];
	for (const f of files.slice(0, limit * 3)) {
		const info = describe(f.source, f.file, f.mtime);
		if (info) {
			out.push(info);
		}
		if (out.length >= limit * 2) {
			break;
		}
	}
	const norm = (p: string) => path.resolve(p).toLowerCase();
	const here = cwd ? norm(cwd) : undefined;
	out.sort((a, b) => (here ? Number(norm(b.cwd || '.') === here) - Number(norm(a.cwd || '.') === here) : 0) || b.modified - a.modified);
	return out.slice(0, limit);
}

function describe(source: ForeignSource, file: string, modified: number): ForeignSessionInfo | undefined {
	let cwd = '';
	let title = '';
	let first = '';
	for (const r of records(readHead(file))) {
		if (source === 'claude') {
			cwd ||= typeof r.cwd === 'string' ? r.cwd : '';
			if (r.type === 'custom-title' && r.customTitle) title = String(r.customTitle);
			if (r.type === 'summary' && r.summary && !title) title = String(r.summary);
			if (!first && r.type === 'user' && !r.isSidechain && !r.isMeta) {
				const t = stripInjected(textOf(r.message?.content));
				if (t) first = t;
			}
		} else {
			if (r.type === 'session_meta') cwd ||= String(r.payload?.cwd ?? '');
			if (r.type === 'event_msg' && r.payload?.type === 'thread_name_updated' && r.payload.thread_name) title = String(r.payload.thread_name);
			if (!first && r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user') {
				const t = stripInjected(textOf(r.payload.content));
				if (t) first = t;
			}
		}
	}
	if (!first && !title) {
		return undefined;
	}
	return { source, path: file, cwd, title: oneLine(title || first), modified };
}

function toolArg(input: unknown): string {
	if (!input || typeof input !== 'object') {
		return oneLine(String(input ?? ''), 80);
	}
	const o = input as Record<string, unknown>;
	const pick = o.file_path ?? o.path ?? o.command ?? o.cmd ?? o.pattern ?? o.query ?? o.url ?? o.description;
	return oneLine(Array.isArray(pick) ? pick.join(' ') : String(pick ?? JSON.stringify(o)), 80);
}

/** The whole chat, in zer0ne's message shape. */
export function loadForeignSession(info: Pick<ForeignSessionInfo, 'source' | 'path'>): ForeignMessage[] {
	// A log can be huge (and can vanish between listing and reading): read at
	// most the cap, and stop the import at the message cap.
	let text = '';
	try {
		const stat = fs.statSync(info.path);
		if (stat.size <= MAX_FILE_BYTES) {
			text = fs.readFileSync(info.path, 'utf8');
		} else {
			const fd = fs.openSync(info.path, 'r');
			try {
				const buf = Buffer.alloc(MAX_FILE_BYTES);
				const n = fs.readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
				text = buf.subarray(0, n).toString('utf8');
			} finally {
				fs.closeSync(fd);
			}
		}
	} catch {
		return [];
	}
	const out: ForeignMessage[] = [];
	const pending = new Map<string, ForeignMessage>();
	const result = (id: string, output: string, isError = false) => {
		const card = pending.get(id);
		if (card?.tool) {
			card.tool.summary = isError ? 'error' : oneLine(output.split('\n').find((l) => l.trim()) ?? 'done', 70) || 'done';
			card.tool.detail = output.slice(0, 2000);
			pending.delete(id);
		}
	};
	for (const r of records(text)) {
		if (out.length >= MAX_MESSAGES) break;
		if (info.source === 'claude') {
			if (r.isSidechain || r.isMeta || (r.type !== 'user' && r.type !== 'assistant')) continue;
			const content = r.message?.content;
			if (typeof content === 'string') {
				const clean = stripInjected(content);
				if (clean) out.push({ role: r.type, content: clean });
				continue;
			}
			for (const b of Array.isArray(content) ? content : []) {
				if (b?.type === 'text' && b.text?.trim()) {
					const clean = stripInjected(b.text);
					if (clean) out.push({ role: r.type, content: clean });
				} else if (b?.type === 'tool_use') {
					const card: ForeignMessage = { role: 'assistant', content: '', tool: { name: String(b.name), arg: toolArg(b.input), summary: 'done' } };
					pending.set(String(b.id), card);
					out.push(card);
				} else if (b?.type === 'tool_result') {
					result(String(b.tool_use_id), textOf(b.content) || (typeof b.content === 'string' ? b.content : ''), b.is_error === true);
				}
			}
		} else if (r.type === 'response_item') {
			const p = r.payload ?? {};
			if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
				const t = stripInjected(textOf(p.content));
				if (t) out.push({ role: p.role, content: t });
			} else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
				let args: unknown = p.arguments ?? p.input;
				try {
					args = typeof args === 'string' ? JSON.parse(args) : args;
				} catch {
					/* plain text input */
				}
				const card: ForeignMessage = { role: 'assistant', content: '', tool: { name: String(p.name), arg: toolArg(args), summary: 'done' } };
				pending.set(String(p.call_id), card);
				out.push(card);
			} else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
				const o = typeof p.output === 'string' ? p.output : textOf(p.output?.content ?? p.output);
				result(String(p.call_id), o);
			}
		}
	}
	// Merge consecutive assistant text pieces (Claude Code writes one record per block).
	const merged: ForeignMessage[] = [];
	for (const m of out) {
		const last = merged[merged.length - 1];
		if (last && !last.tool && !m.tool && last.role === m.role && m.role === 'assistant') {
			last.content += '\n\n' + m.content;
		} else {
			merged.push(m);
		}
	}
	return merged;
}
