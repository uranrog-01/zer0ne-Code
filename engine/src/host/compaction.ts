import type { ChatMessage, StreamOptions, StreamResult, ToolDef } from '../chatClient';
import { ModelEntry, ProviderConfig, ProviderStore, StoredMessage, newId } from '../providerStore';
import type { CacheGuard } from '../tools/tokenSaver';
import { countMessageTokens } from '../tools/tokenSaver';
import type { Transcript, TranscriptStore } from '../transcript';
import { repairToolPairs } from '../transcript';
import { abortError, formatTokens } from './turnHelpers';
import { fitToWindow, localHelper } from './localRouting';
import { summaryMessage } from './turnRequest';
import { CONTEXT_OVERFLOW } from '../core/turn';
import { replayOutputLimit, requestProfileFor, type RequestProfile } from '../requestProfile';
import { responseLimit } from '../responseBudget';

/** What compaction needs from the controller. */
export interface CompactorDeps {
	store: ProviderStore;
	sessionId(): string;
	transcripts: TranscriptStore;
	cacheGuard: CacheGuard;
	status(message: string, kind?: 'ok' | 'error' | ''): void;
	scheduleState(): void;
	callModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>): Promise<StreamResult>;
	/** PreCompact hooks (fire and forget from the caller's perspective; awaited here, best effort). */
	notifyHook?(event: 'PreCompact', payload: Record<string, unknown>): Promise<void>;
}

/**
 * What the conversation request looked like. The summary request replays it so the
 * provider serves the replayed region from its cache instead of reading it again
 * at full price: a summary request that starts with a different system prompt
 * shares no prefix with the conversation at all.
 */
export interface CompactionPrefix extends RequestProfile {
	/** The system prompt of the conversation request, byte for byte. */
	system: string;
	/** The tool list of the conversation request: part of the cached token sequence. */
	tools?: ToolDef[];
}

/** The instruction rides at the end of the replayed conversation, never at its front. */
const COMPACTION_INSTRUCTION =
	'You are now acting as a compaction engine. The conversation above is the part of a coding session that is about to be replaced by a summary. ' +
	"Write a dense summary that preserves: the user's goals and preferences, decisions made, files and functions touched (with paths), current state of the work, errors seen and their fixes, and open TODOs. " +
	'Use short markdown bullets. No preamble. Do not call a tool, do not answer the user, and do not mention this instruction.';

/** The summarizer's own system prompt: only for requests that cannot replay the conversation. */
const SUMMARY_SYSTEM =
	"You compress coding conversations. Write a dense summary that preserves: the user's goals and preferences, decisions made, files and functions touched (with paths), current state of the work, errors seen and their fixes, and open TODOs. Use short markdown bullets. No preamble.";

/** Auto compaction pauses for a chat after this many failures in a row (ZCode's circuit breaker). */
export const MAX_COMPACT_FAILURES = 3;

/** The token count at which auto compaction starts: the window percentage, or the fixed ceiling when that comes first. */
export function compactAt(window: number, settings: { compactThreshold: number; compactMaxTokens?: number }): number {
	const share = (window * settings.compactThreshold) / 100;
	return settings.compactMaxTokens ? Math.min(share, settings.compactMaxTokens) : share;
}
/** Summary requests that overflow the writer's window are retried this often with the oldest part dropped (Codex). */
const OVERFLOW_RETRIES = 3;

/**
 * Auto compact: when a chat nears the context limit, the older turns become a
 * written summary (one model call). The last two user turns stay verbatim.
 * Split out of ChatController.
 */
export class Compactor {
	/** Consecutive failed auto compactions per chat; reset by a success or a manual compaction. */
	private readonly failures = new Map<string, number>();

	constructor(private readonly d: CompactorDeps) {}

	/**
	 * What the context holds now (Pi): the provider's own count of the last
	 * request since the latest summary, plus an estimate of the messages after
	 * that turn. Provider counts use the model's real tokenizer (Claude,
	 * Gemini, Qwen, DeepSeek differ from any local estimate); the estimate is
	 * only the fallback when no turn has one.
	 */
	contextTokens(convo: StoredMessage[], start: number, upto: number, summaryAt: number | undefined, exact: { entries: Parameters<typeof countMessageTokens>[0] } | undefined): number {
		const text = (m: StoredMessage) => ({ content: (m.apiContent ?? m.content) + (m.tool?.detail ?? '') });
		for (let i = upto - 1; i >= start; i--) {
			const m = convo[i];
			const turn = m.role === 'user' && !m.kind ? m.turn : undefined;
			if (!turn?.contextTokens || (summaryAt !== undefined && turn.startedAt < summaryAt)) continue;
			const next = convo.findIndex((x, j) => j > i && x.role === 'user' && !x.kind);
			const after = next === -1 || next > upto ? [] : convo.slice(next, upto + 1);
			return turn.contextTokens + countMessageTokens(after.map(text));
		}
		// With the exact transcript, the real history (tool outputs included) is what fills the window.
		return Math.max(countMessageTokens(convo.slice(start, upto + 1).map(text)), exact ? countMessageTokens(exact.entries) : 0);
	}

	/**
	 * The conversation messages a summary replaces, exactly as the conversation
	 * sent them: everything before the second-to-last user turn. The transcript's
	 * marks say where that turn starts, so the replay is the conversation's own
	 * bytes and not a flattened retelling of them.
	 */
	private replayedRegion(transcript: Transcript | undefined, summary: { text: string; upTo: string } | undefined, convo: StoredMessage[], cut: number): ChatMessage[] | undefined {
		if (!transcript?.entries.length) {
			return undefined;
		}
		const kept = convo[cut + 1];
		if (!kept) {
			return undefined;
		}
		const at = transcript.marks?.[kept.id];
		if (typeof at !== 'number' || at <= 0) {
			return undefined;
		}
		// The summary of an earlier compaction rides at the head of the conversation;
		// the replay carries it too when the stored transcript does not.
		const seed = summary?.text && transcript.summaryUpTo !== summary.upTo ? [summaryMessage(summary.text)] : [];
		return [...seed, ...transcript.entries.slice(0, at)];
	}

	/** Summarize older turns so long chats keep fitting the context window. */
	async maybeCompact(convo: StoredMessage[], current: StoredMessage, provider: ProviderConfig, model: ModelEntry, apiKey: string, force: boolean, signal: AbortSignal, prefix?: CompactionPrefix): Promise<void> {
		const settings = this.d.store.getSettings();
		if (!force && !settings.autoCompact) {
			return;
		}
		const sessionId = this.d.sessionId();
		if (!force && (this.failures.get(sessionId) ?? 0) >= MAX_COMPACT_FAILURES) {
			return; // paused for this chat; /compact still works and resets it
		}
		try {
			// PreCompact hooks observe (matcher unused); their output is informational only.
			await this.d.notifyHook?.('PreCompact', { session_id: sessionId, reason: force ? 'manual' : 'auto' });
			await this.compact(convo, current, provider, model, apiKey, force, signal, sessionId, settings, prefix);
			this.failures.delete(sessionId);
		} catch (error) {
			if (signal.aborted || (error as Error)?.name === 'AbortError') throw error;
			const n = (this.failures.get(sessionId) ?? 0) + 1;
			this.failures.set(sessionId, n);
			const why = error instanceof Error ? error.message : String(error);
			if (!force && n >= MAX_COMPACT_FAILURES) this.d.status(`Auto compact failed ${n} times in a row and is paused for this chat (last error: ${why.slice(0, 120)}). Run /compact to retry.`, 'error');
			throw error;
		}
	}

	private async compact(convo: StoredMessage[], current: StoredMessage, provider: ProviderConfig, model: ModelEntry, apiKey: string, force: boolean, signal: AbortSignal, sessionId: string, settings: ReturnType<ProviderStore['getSettings']>, prefix?: CompactionPrefix): Promise<void> {
		const summary = await this.d.store.getSummary(sessionId);
		const start = summary ? convo.findIndex((m) => m.id === summary.upTo) + 1 : 0;
		const upto = convo.indexOf(current);
		const window = model.contextWindow ?? 128_000;
		const exact = settings.exactHistory ? this.d.transcripts.load(sessionId) : undefined;
		const tokens = this.contextTokens(convo, start, upto, summary?.at, exact);
		if (!force && tokens < compactAt(window, settings)) {
			return;
		}
		// Keep the last 2 user turns verbatim; summarize everything before.
		const userIdx = convo.map((m, i) => (m.role === 'user' && !m.kind && !m.local && i <= upto ? i : -1)).filter((i) => i >= start);
		if (userIdx.length < 3) {
			if (force) {
				this.d.status('Not enough conversation to compact yet.', '');
			}
			return;
		}
		const cut = userIdx[userIdx.length - 2] - 1;
		const older = convo.slice(start, cut + 1).filter((m) => !m.isError && !m.compacted && !m.local);
		const transcript = older
			.map((m) =>
				m.role === 'user' && !m.kind
					? `USER: ${(m.apiContent ?? m.content).slice(0, 6000)}`
					: m.tool
						? `TOOL ${m.tool.name}(${m.tool.arg}) → ${m.tool.summary}`
						: m.approval
							? `ACTION ${m.approval.kind} ${m.approval.path ?? m.approval.command ?? ''} → ${m.approval.status}`
							: `ASSISTANT: ${m.content.slice(0, 6000)}`
			)
			.join('\n\n');
		const prior = summary && !summary.frames ? `Existing summary of even earlier conversation:\n${summary.text}\n\n` : '';
		// Hybrid routing: the summary is helper work — the local helper model writes it when one is set (free, private).
		const helper = await localHelper(this.d.store, 'compaction');
		const writer = helper ?? { provider, model, apiKey };
		// The same route as the conversation can serve the region from the provider's
		// cache: replay the conversation's own prefix and put the instruction at the
		// end. A helper model (or a request without a known prefix) keeps the flat form.
		let region = helper || !prefix?.system ? undefined : this.replayedRegion(exact, summary, convo, cut);
		let text = transcript.slice(-200_000);
		let result: StreamResult | undefined;
		const profile = { ...requestProfileFor(settings, writer.provider, writer.model, await this.d.store.getEffort?.(writer.provider.id, writer.model.id)), maxTokens: responseLimit(writer.model) };
		for (let attempt = 0; ; attempt++) {
			const request = region
				? {
						system: prefix!.system,
						tools: prefix!.tools,
						messages: [...repairToolPairs(region), { role: 'user' as const, content: COMPACTION_INSTRUCTION }]
					}
				: {
						system: SUMMARY_SYSTEM,
						messages: [{ role: 'user' as const, content: helper ? fitToWindow(`${prior}Conversation to summarize:\n\n${text}`, helper.model) : `${prior}Conversation to summarize:\n\n${text}` }]
					};
			try {
				result = await this.d.callModel(writer.provider, writer.apiKey, {
					...(region ? prefix : profile),
					requestContext: { sessionId, turnId: current.id, rootTaskId: current.rootTaskId, purpose: 'summary' },
					model: writer.model.id,
					...request,
					signal,
					maxTokens: Math.min(responseLimit(writer.model), replayOutputLimit({ ...(region ? prefix : profile), model: writer.model.id, baseUrl: writer.provider.baseUrl, apiFormat: writer.provider.apiFormat }, 2000))
				});
				break;
			} catch (error) {
				// Too big even to summarize: drop the oldest part and retry instead of failing (Codex).
				if (signal.aborted || attempt >= OVERFLOW_RETRIES || !CONTEXT_OVERFLOW.test(error instanceof Error ? error.message : String(error))) throw error;
				// Dropping the oldest messages forfeits the cache reuse; the summary must still be written.
				if (region) region = region.slice(Math.floor(region.length / 3));
				else text = text.slice(Math.floor(text.length / 3));
			}
		}
		if (signal.aborted) throw abortError();
		if (result.stopReason === 'length' || result.stopReason === 'max_tokens' || result.toolCalls?.length) {
			throw new Error('The summary was incomplete; the original conversation has been kept.');
		}
		if (!result.text.trim()) {
			throw new Error('the summary came back empty');
		}
		// Paths come from the record, not from what the summary writer chose to mention (Pi).
		const summaryText = result.text.trim() + fileLists(older);
		const upToId = convo[cut].id;
		await this.d.store.setSummary(sessionId, { text: summaryText, upTo: upToId, at: Date.now() });
		this.d.cacheGuard.reset();
		this.d.transcripts.archive(sessionId); // restarts from the summary next turn; the exact history is kept
		convo.splice(cut + 1, 0, {
			id: newId('c'),
			role: 'assistant',
			content: `Context compacted — ${older.length} earlier messages summarized (${formatTokens(Math.round(tokens))} tokens before).`,
			compacted: true,
			reasoning: summaryText
		});
		this.d.scheduleState();
	}
}

/** "Files read / modified" from the summarized turns' own records, appended to the summary. */
export function fileLists(older: StoredMessage[]): string {
	const read = new Set<string>();
	const modified = new Set<string>();
	for (const m of older) {
		if (m.tool?.name === 'read_file' && m.tool.status === 'done' && m.tool.arg) read.add(m.tool.arg);
		if (m.role === 'user' && m.turn && !m.turn.undone) for (const e of m.turn.edits ?? []) modified.add(e.path);
	}
	for (const f of modified) read.delete(f);
	const list = (s: Set<string>) => [...s].slice(0, 60).join(', ') + (s.size > 60 ? `, … (${s.size - 60} more)` : '');
	return (read.size ? `\n\nFiles read: ${list(read)}` : '') + (modified.size ? `\n\nFiles modified: ${list(modified)}` : '');
}
