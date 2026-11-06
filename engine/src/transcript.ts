import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage } from './chatClient';
import { randomUUID } from 'crypto';

/**
 * Exact conversation transcript (what Claude Code, Codex and opencode keep).
 *
 * Every request of a session is the previous request plus new messages —
 * tool calls and tool results included — so the provider's prompt cache
 * matches the whole history and the model still "remembers" the files it
 * read in earlier turns (no re-reading).
 *
 * It only shrinks in two rare, batched steps (so the cache breaks rarely):
 *  - prune: old tool outputs are replaced by a short marker once they add up
 *    to a lot of tokens, keeping the most recent ~40k tokens of tool output
 *    (opencode's PRUNE_PROTECT / PRUNE_MINIMUM idea);
 *  - compaction: the session is summarized; the transcript restarts from the
 *    summary. The exact transcript from before is kept beside it
 *    (<sessionId>.json.compacted-<time>, the newest ARCHIVES_KEPT) until the chat is deleted.
 * One JSON file per session: <globalStorage>/transcripts/<sessionId>.json
 */

export interface Transcript {
	v: 1;
	entries: ChatMessage[];
	/** user message id → index of that user message in `entries` (for retry). */
	marks: Record<string, number>;
	/** Files the agent has read → mtime at that moment (for change reminders). */
	reads: Record<string, number>;
	/** Identifies the summary already seeded into history, including if overflow trims it. */
	summaryUpTo?: string;
}

const PRUNE_PROTECT_CHARS = 140_000; // ≈ 40k tokens of the most recent tool output stay
const PRUNE_MINIMUM_CHARS = 70_000; // prune only when it saves ≈ 20k tokens
const PROTECTED_TOOLS = new Set(['skill', 'todo_write']);
export const PRUNED_MARK = '[old tool output pruned to save context — run the tool again if you need it]';
const PRUNED_PREFIX = '[old tool output';
/** What a pruned failure keeps: its opening and its (usually decisive) end. */
const FAILURE_KEEP_CHARS = 4000;

const safe = (s: string) => s.replace(/[^\w.-]/g, '_');
/** Pre-compaction transcripts kept per chat. */
export const ARCHIVES_KEPT = 3;

export class TranscriptStore {
	constructor(private readonly dir: string, private readonly report?: (notice: { session: string; kind: 'recovered' | 'corrupt'; message: string }) => void) {}

	private file(session: string): string {
		return path.join(this.dir, safe(session) + '.json');
	}

	load(session: string): Transcript | undefined {
		const file = this.file(session);
		let missing = false;
		try {
			return validateTranscript(JSON.parse(fs.readFileSync(file, 'utf8')));
		} catch (error) {
			missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
			if ((error as Error).message === 'Unsupported transcript version') {
				this.report?.({ session, kind: 'corrupt', message: 'This transcript uses an unsupported version. Its saved files have been preserved.' });
				return undefined;
			}
		}
		try {
			const recovered = validateTranscript(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')));
			this.report?.({ session, kind: 'recovered', message: 'Recovered the previous saved transcript. Newer conversation may be missing from model context.' });
			return recovered;
		} catch (error) {
			if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.report?.({ session, kind: 'corrupt', message: 'The saved transcript could not be read or recovered. Conversation context will be rebuilt from chat history; saved files have been preserved.' });
			}
			return undefined;
		}
	}

	save(session: string, t: Transcript): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const file = this.file(session);
		const json = JSON.stringify(validateTranscript(t));
		let previous: string | undefined;
		try { previous = fs.readFileSync(file, 'utf8'); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (previous !== undefined) {
			try { validateTranscript(JSON.parse(previous)); } catch (error) {
				if ((error as Error).message === 'Unsupported transcript version') throw error;
				// A corrupt primary must never overwrite the last valid recovery copy.
				atomicWrite(file + '.corrupt-' + randomUUID(), previous);
				previous = undefined;
			}
			if (previous !== undefined) atomicWrite(file + '.bak', previous);
		}
		atomicWrite(file, json);
	}

	remove(session: string): void {
		const file = this.file(session);
		fs.rmSync(file, { force: true });
		fs.rmSync(file + '.bak', { force: true });
		// Recovery files and compaction archives are conversation data too; deleting a chat removes them.
		const corrupt = path.basename(file) + '.corrupt-';
		for (const name of this.names()) if (name.startsWith(corrupt) && /^[0-9a-f-]{36}$/.test(name.slice(corrupt.length))) fs.rmSync(path.join(this.dir, name), { force: true });
		for (const name of this.archives(session)) fs.rmSync(path.join(this.dir, name), { force: true });
	}

	/**
	 * Compaction: the transcript restarts from the summary, and the exact one from before is kept
	 * (not deleted), so what the model saw can still be inspected or recovered.
	 */
	archive(session: string): void {
		const file = this.file(session);
		if (fs.existsSync(file)) fs.renameSync(file, `${file}.compacted-${Date.now()}`);
		fs.rmSync(file + '.bak', { force: true });
		for (const name of this.archives(session).slice(ARCHIVES_KEPT)) fs.rmSync(path.join(this.dir, name), { force: true });
	}

	/** This chat's compaction archives, newest first. */
	archives(session: string): string[] {
		const prefix = path.basename(this.file(session)) + '.compacted-';
		return this.names().filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length))).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
	}

	private names(): string[] {
		try { return fs.readdirSync(this.dir); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
	}
}

function validateTranscript(value: any): Transcript {
	if (value?.v !== 1) throw new Error(typeof value?.v === 'number' && value.v > 1 ? 'Unsupported transcript version' : 'Invalid transcript version');
	if (!Array.isArray(value.entries) || value.entries.some((m: any) => !m || !['user', 'assistant', 'tool'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Invalid transcript entries');
	for (const message of value.entries) if (message.native !== undefined) {
		const state = message.native;
		if (!state || !['responses', 'anthropic', 'gemini'].includes(state.format) || typeof state.model !== 'string' || !/^[a-f0-9]{64}$/.test(state.route) || !/^[a-f0-9]{64}$/.test(state.textHash) || !Array.isArray(state.items) || state.items.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)) || state.outputTokens !== undefined && (!Number.isSafeInteger(state.outputTokens) || state.outputTokens < 0)) delete message.native;
	}
	const marks = value.marks ?? {};
	const reads = value.reads ?? {};
	if (!marks || Array.isArray(marks) || typeof marks !== 'object' || Object.values(marks).some((n) => !Number.isSafeInteger(n) || (n as number) < 0)) throw new Error('Invalid transcript marks');
	if (!reads || Array.isArray(reads) || typeof reads !== 'object' || Object.values(reads).some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('Invalid transcript reads');
	return { ...value, marks, reads };
}

function atomicWrite(file: string, json: string): void {
	const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, 'wx', 0o600);
		fs.writeFileSync(fd, json, 'utf8');
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = undefined;
		fs.renameSync(temporary, file);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
		fs.rmSync(temporary, { force: true });
	}
}

export function transcriptChars(entries: ChatMessage[]): number {
	let n = 0;
	for (const m of entries) {
		n += m.content.length + (m.role === 'assistant' ? (m.reasoning?.length ?? 0) + (m.native ? JSON.stringify(m.native.items).length : 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) : 0);
	}
	return n;
}

/** What is stored: images are not kept between turns (they were sent once). */
export function forStorage(m: ChatMessage): ChatMessage {
	if (m.role === 'assistant' || !m.images?.length) {
		return m;
	}
	// The picture archive keeps its note verbatim; its frames are re-attached from the archive file.
	if (m.role === 'user' && m.content.startsWith('[Archive of the earlier conversation, drawn as images')) {
		return { ...m, images: undefined };
	}
	const n = m.images.length;
	return { ...m, images: undefined, content: `${m.content}\n[${n} image${n > 1 ? 's' : ''} shown earlier — not kept in context]` };
}

/**
 * Every assistant tool call must be answered by a tool message before the
 * next user/assistant turn (OpenAI and Anthropic both reject gaps). A run
 * stopped mid-tool leaves gaps; fill them. Orphaned tool results are dropped.
 */
export function repairToolPairs(entries: ChatMessage[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (let i = 0; i < entries.length; i++) {
		const m = entries[i];
		// A tool result without its call right before it (context trimmed from the front) is rejected
		// by every API ("role 'tool' must be a response to a preceding message with 'tool_calls'").
		if (m.role === 'tool') continue;
		out.push(m);
		if (m.role === 'assistant' && m.toolCalls?.length) {
			const answered = new Set<string>();
			let j = i + 1;
			for (let next = entries[j]; next && next.role === 'tool'; next = entries[++j]) {
				answered.add(next.toolCallId);
				out.push(next);
			}
			for (const call of m.toolCalls) {
				if (!answered.has(call.id)) {
					out.push({ role: 'tool', toolCallId: call.id, name: call.name, content: '(not run — the turn was stopped)' });
				}
			}
			i = j - 1;
		}
	}
	return out;
}

/**
 * Replace old tool outputs with a marker, newest-first protection. Only
 * acts when the saving is worth a cache break. Returns chars saved.
 */
export function pruneToolOutputs(entries: ChatMessage[], protectChars = PRUNE_PROTECT_CHARS, minimumChars = PRUNE_MINIMUM_CHARS, spill?: (content: string, tool: string) => string | undefined): number {
	let seen = 0;
	const candidates: number[] = [];
	let saving = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const m = entries[i];
		if (m.role !== 'tool' || PROTECTED_TOOLS.has(m.name)) {
			continue;
		}
		if (m.content.startsWith(PRUNED_PREFIX)) {
			break; // everything older was pruned before
		}
		seen += m.content.length;
		// A failure stays (its decisive end at least): it is what keeps the model from repeating the mistake.
		const keep = m.failed ? FAILURE_KEEP_CHARS : 0;
		if (seen > protectChars && m.content.length > Math.max(keep, PRUNED_MARK.length) + 200) {
			candidates.push(i);
			saving += m.content.length - Math.max(keep, PRUNED_MARK.length);
		}
	}
	if (saving < minimumChars) {
		return 0;
	}
	const pruned = new Set(candidates);
	for (const i of candidates) {
		const m = entries[i];
		if (m.role !== 'tool') {
			continue;
		}
		// Token Saver pointers ("Identical to the earlier … result") must not
		// point at pruned text: the first surviving pointer takes the content.
		const pointer = `[Identical to the earlier ${m.name} result`;
		let moved = false;
		for (let j = i + 1; j < entries.length; j++) {
			const later = entries[j];
			if (later.role === 'tool' && !pruned.has(j) && later.name === m.name && later.content.startsWith(pointer)) {
				entries[j] = { ...later, content: m.content };
				saving -= m.content.length - later.content.length;
				moved = true;
				break;
			}
		}
		const saved = moved ? undefined : spill?.(m.content, m.name);
		const where = saved ? ` The full text is saved at ${saved}: read_file (offset/limit) or grep it instead of running the tool again.` : '';
		const content = m.failed
			? `${PRUNED_PREFIX} shortened — this call failed; its start and end are kept.${where}]\n${m.content.slice(0, 1000)}\n[…]\n${m.content.slice(-(FAILURE_KEEP_CHARS - 1000))}`
			: saved ? `${PRUNED_PREFIX} moved out of context to save space.${where}]` : PRUNED_MARK;
		entries[i] = { ...m, content, images: undefined };
	}
	return saving;
}
