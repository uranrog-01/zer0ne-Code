import type { ChatMessage, MessageImage, StreamResult, ToolCall } from '../chatClient';
import { pairPendingToolResults, REPLAY_ERROR, ToolCallLedger } from './toolCalls';
import { fenceToolOutput } from './untrusted';
import { assistantMessage } from '../continuation';

/**
 * The agent turn engine, shared by every surface (VS Code chat, CLI, ACP,
 * worktree writers). It owns the loop — model call → tool calls (read-only
 * ones in parallel, results in order) → steering → verify-before-finish →
 * step limit — and nothing else. Surfaces plug in how to call the model,
 * run a tool and show progress, so the loop behaves the same everywhere.
 */

export interface ToolOutcome {
	/** What the model sees. */
	api: string;
	images?: MessageImage[];
	error?: boolean;
}

export interface TurnHooks {
	/** The conversation as the model sees it; the engine appends to it. */
	messages: ChatMessage[];
	/** Model ↔ tool round-trips before the turn pauses; 0 = run until the model finishes. */
	maxSteps: number;
	/** Additional requests allowed to finish a response cut off by its output allowance. */
	maxContinuations?: number;
	onContinue?(count: number): void;
	signal: AbortSignal;
	/**
	 * One model call for this step (the surface adds retries, streaming UI, usage).
	 * Pass `onToolCall` on to the client: read-only calls then start while the model is still streaming.
	 */
	call(step: number, onToolCall: (call: ToolCall) => void): Promise<StreamResult>;
	/** Run one tool call. */
	execute(call: ToolCall): Promise<ToolOutcome>;
	/** Calls that may run side by side with their neighbours (no side effects). */
	parallelSafe?(call: ToolCall): boolean;
	/** Rewrite a tool result before it joins the context (token saver, redaction). */
	transform?(call: ToolCall, api: string): string;
	/** The model answered (text and/or tool calls); `cutOff` = hit the output limit. */
	onAnswer?(result: StreamResult, cutOff: boolean, continuing?: boolean): void;
	/** After each batch of tool results (e.g. refresh the UI). */
	onBatch?(): void;
	/**
	 * The model wants to finish: return feedback to send it back to work
	 * (auto-verify), or undefined to end the turn.
	 */
	beforeFinish?(result: StreamResult): Promise<string | undefined>;
	/** Follow-ups typed while the agent works, delivered between steps. */
	drainSteer?(): string[];
	/** Reports of background agents that finished, delivered between steps. */
	drainNotices?(): string[];
	/** Screenshots kept in context (older ones are dropped). Default 2. */
	keepImages?: number;
	/**
	 * A reply with neither text nor a tool call gets one reminder to answer (default on).
	 * Off for agents that act on their own (ACP), where an empty reply can follow real work.
	 */
	nudgeEmpty?: boolean;
}

export interface TurnOutcome {
	stopReason: 'end_turn' | 'max_turn_requests' | 'cancelled';
	steps: number;
	/** The last answer's text. */
	text: string;
	/** The model ended the turn without answering, even after a reminder. */
	empty?: boolean;
	truncated?: boolean;
	continuations?: number;
}

/** What the model reads when a call it wrote was cut off by the output limit (it was not run). */
export const TRUNCATED_CALL = 'Error: this tool call was cut off at the output token limit before its arguments were complete, so it was NOT run (running it would have used partial input, e.g. half a file). Make the same change in smaller pieces: several edit_file calls, or write_file for a short file followed by edits.';
/** The reminder after an empty reply. */
export const EMPTY_NUDGE = 'Your last reply was empty. Continue the task: call the next tool you need, or answer the user directly.';

/** Arguments that arrived complete: strict JSON (an empty string means no arguments). */
export function completeArgs(args: string | undefined): boolean {
	if (!args || !args.trim()) return true;
	try {
		const v = JSON.parse(args);
		return !!v && typeof v === 'object' && !Array.isArray(v);
	} catch {
		return false;
	}
}

/**
 * The calls of a cut-off answer that must never run: their arguments were still being streamed
 * when the output limit ended the reply, so they carry partial input (half a file, an unclosed
 * command). Every engine that executes tool calls must use this, not just the main loop — a
 * second loop without the guard turns a truncated write into a silently truncated file.
 */
export function truncatedCallIds(calls: ReadonlyArray<{ id: string; arguments?: string }>, cutOff: boolean): Set<string> {
	if (!cutOff) return new Set();
	return new Set(calls.filter((c) => !completeArgs(c.arguments)).map((c) => c.id));
}

function abortError(): Error {
	const e = new Error('Aborted');
	e.name = 'AbortError';
	return e;
}

export async function runAgentTurn(h: TurnHooks): Promise<TurnOutcome> {
	let text = '';
	let nudged = false;
	let continuations = 0;
	let continuedText = '';
	const ledger = new ToolCallLedger(h.messages);
	pairPendingToolResults(h.messages, 'Previous turn stopped');
	for (let step = 0; ; step++) {
		if (h.signal.aborted) {
			return { stopReason: 'cancelled', steps: step, text };
		}
		if (h.maxSteps > 0 && step >= h.maxSteps) {
			return { stopReason: 'max_turn_requests', steps: step, text };
		}
		// Eager execution: a read-only call starts the moment its arguments are complete.
		// Only a leading run of read-only calls starts early, so results and cards keep the call order.
		const early = new Map<string, Promise<ToolOutcome>>();
		let blocked = false;
		const onToolCall = (call: ToolCall) => {
			if (blocked || ledger.seen.has(call.id) || early.has(call.id)) return;
			if (!h.parallelSafe?.(call)) {
				blocked = true;
				return;
			}
			if (!h.signal.aborted) {
				ledger.seen.add(call.id);
				const p = h.execute(call.executionArguments ? { ...call, arguments: call.executionArguments } : call);
				p.catch(() => undefined);
				early.set(call.id, p);
			}
		};
		let result: StreamResult;
		try { result = await h.call(step, onToolCall); }
		catch (error) {
			// A model failure must not leave eager tools changing cards after turn finalization.
			await Promise.allSettled(early.values());
			throw error;
		}
		if (h.signal.aborted) { await Promise.allSettled(early.values()); return { stopReason: 'cancelled', steps: step, text }; }
		const prepared = ledger.prepare(result.toolCalls, new Set(early.keys()));
		result = { ...result, toolCalls: prepared.calls };
		text = continuedText + result.text;
		const cutOff = result.stopReason === 'length' || result.stopReason === 'max_tokens';
		const continuing = cutOff && !result.toolCalls.length && continuations < (h.maxContinuations ?? 2);
		h.onAnswer?.(result, cutOff, continuing);
		if (!result.toolCalls.length) {
			if (continuing) {
				continuedText = text;
				h.messages.push(assistantMessage(result));
				h.messages.push({ role: 'user', content: 'The response reached its output allowance. Continue the unfinished work from this point without repeating completed work. Preserve the original request and constraints. Finish the answer, or use tools if more work is necessary.' });
				continuations++;
				h.onContinue?.(continuations);
				continue;
			}
			if (cutOff) {
				h.messages.push(assistantMessage(result));
				return { stopReason: 'end_turn', steps: step + 1, text, truncated: true, continuations };
			}
			// An empty reply (nothing, or only reasoning) is not an answer: remind once, then report it.
			if (!result.text.trim() && h.nudgeEmpty !== false) {
				if (!nudged && !cutOff) {
					nudged = true;
					h.messages.push({ role: 'assistant', content: '(no reply)' });
					h.messages.push({ role: 'user', content: EMPTY_NUDGE });
					continue;
				}
				return { stopReason: 'end_turn', steps: step + 1, text, empty: true };
			}
			const feedback = h.beforeFinish ? await h.beforeFinish(result) : undefined;
			if (h.signal.aborted) return { stopReason: 'cancelled', steps: step, text };
			if (feedback) {
				continuedText = '';
				h.messages.push(assistantMessage(result));
				h.messages.push({ role: 'user', content: feedback });
				continue;
			}
			if (result.text.trim()) {
				h.messages.push(assistantMessage(result));
			}
			return { stopReason: 'end_turn', steps: step + 1, text, continuations };
		}
		h.messages.push(assistantMessage(result));
		const calls = result.toolCalls;
		// A reply cut off by the output limit can end inside a call's arguments. Argument repair would
		// close the open string and run it with partial input, so those calls are answered with an error.
		const truncated = new Set(cutOff ? calls.filter((c) => !early.has(c.id) && !completeArgs(c.arguments)).map((c) => c.id) : []);
		for (let i = 0; i < calls.length; ) {
			if (h.signal.aborted) {
				await Promise.allSettled(early.values());
				pairPendingToolResults(h.messages, 'Stopped');
				throw abortError();
			}
			let j = i + 1;
			if (h.parallelSafe?.(calls[i])) {
				while (j < calls.length && h.parallelSafe(calls[j])) {
					j++;
				}
			}
			const batch = calls.slice(i, j);
			const run = (c: ToolCall) => prepared.blocked.has(c.id) ? Promise.resolve({ api: REPLAY_ERROR }) : truncated.has(c.id) ? Promise.resolve({ api: TRUNCATED_CALL }) : early.get(c.id) ?? h.execute(c.executionArguments ? { ...c, arguments: c.executionArguments } : c);
			const settled = await Promise.allSettled(batch.map(run));
			const failure = settled.find((r) => r.status === 'rejected');
			const outcomes = settled.map((r): ToolOutcome => r.status === 'fulfilled' ? r.value : { api: `Error: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, error: true });
			batch.forEach((call, k) => {
				const own = prepared.blocked.has(call.id) || truncated.has(call.id);
				const fenced = own ? outcomes[k].api : fenceToolOutput(call.name, outcomes[k].api);
				const api = h.transform ? h.transform(call, fenced) : fenced;
				h.messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: api, images: outcomes[k].images, failed: outcomes[k].error || own || undefined });
			});
			if (failure?.status === 'rejected') { pairPendingToolResults(h.messages, 'Batch failed'); await Promise.allSettled(early.values()); throw failure.reason; }
			h.onBatch?.();
			i = j;
		}
		dropOldImages(h.messages, h.keepImages ?? 2);
		const steer = h.drainSteer?.() ?? [];
		const notices = h.drainNotices?.() ?? [];
		if (steer.length || notices.length) {
			const parts = [...(steer.length ? [`[The user added while you were working]\n${steer.join('\n')}`] : []), ...notices];
			h.messages.push({ role: 'user', content: parts.join('\n\n') });
		}
	}
}

/** Only the latest `keep` screenshots stay in context (they are expensive). */
export function dropOldImages(messages: ChatMessage[], keep: number): void {
	let kept = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'tool' && m.images?.length && ++kept > keep) {
			m.images = undefined;
			m.content += '\n[older screenshot removed]';
		}
	}
}

// ---------------------------------------------------------------- resilient calls

/** Errors worth retrying (rate limits, overload, gateways, network) — not auth or bad requests. */
export const RETRYABLE = /\b(408|409|425|429|500|502|503|504|520|522|524|529)\b|overload|rate.?limit|too many requests|quota|capacity|temporarily|timed? ?out|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|network/i;

export interface RetryOptions {
	signal: AbortSignal;
	/** Retries after the first failure (default 2). */
	retries?: number;
	/** Backoff when the provider gives no Retry-After (ms per attempt). */
	backoff?: number[];
	/** Never retry once output has streamed (it would be duplicated). */
	streamed?(): boolean;
	/** Errors that are not retried here (the caller has a better move, e.g. the next key of a pool). */
	skip?: RegExp;
	onRetry?(message: string, waitMs: number, attempt: number): void;
}

/** Retry-After from the error (seconds or ms, set by chatClient), capped at 60 s. */
export function retryDelay(error: unknown, fallbackMs: number): number {
	const ms = (error as { retryAfterMs?: number })?.retryAfterMs;
	return typeof ms === 'number' && ms > 0 ? Math.min(ms, 60_000) : fallbackMs;
}

/** Call `fn`, retrying transient failures with the provider's Retry-After or a backoff. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
	const backoff = o.backoff ?? [1500, 4000, 9000];
	const retries = o.retries ?? 2;
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = o.signal.aborted || (error as Error)?.name === 'AbortError';
			if (aborted || attempt >= retries || o.streamed?.() || !RETRYABLE.test(message) || o.skip?.test(message)) {
				throw error;
			}
			const wait = retryDelay(error, backoff[Math.min(attempt, backoff.length - 1)]);
			o.onRetry?.(message, wait, attempt + 1);
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(resolve, wait);
				o.signal.addEventListener(
					'abort',
					() => {
						clearTimeout(t);
						reject(abortError());
					},
					{ once: true }
				);
			});
		}
	}
}

// ---------------------------------------------------------------- context overflow

/** "The prompt is longer than the model's window" in the words of the providers we speak to. */
export const CONTEXT_OVERFLOW = /context[_ ]?(length|window)[_ ]?(exceeded|is|of)|maximum context|context length|too many tokens|prompt is too long|input is too long|exceeds? (the )?(model'?s? )?(max(imum)?|context)|token limit|reduce the length|request (entity )?too large|input tokens? exceed|available context|context size|\b413\b/i;

/**
 * The numbers some servers put in an overflow error — llama.cpp: "request (38099 tokens) exceeds
 * the available context size (32768 tokens)"; OpenAI-style: "maximum context length is 8192 tokens
 * … your messages resulted in 9000 tokens". `limit` is the real window, `need` the prompt (pure; tested).
 */
export function overflowNumbers(message: string): { limit?: number; need?: number } {
	const num = (re: RegExp) => {
		const n = Number(re.exec(message)?.[1]?.replace(/,/g, ''));
		return n > 0 ? n : undefined;
	};
	return {
		limit: num(/context size \(([\d,]+) tokens?\)/i) ?? num(/maximum context length (?:is|of) ([\d,]+)/i) ?? num(/context window (?:is|of) ([\d,]+)/i) ?? num(/n_ctx[^\d]{0,12}([\d,]+)/i) ?? num(/tokens? > ([\d,]+) maximum/i),
		need: num(/request \(([\d,]+) tokens?\)/i) ?? num(/resulted in ([\d,]+) tokens/i) ?? num(/prompt is too long: ([\d,]+) tokens/i) ?? num(/n_prompt_tokens[^\d]{0,12}([\d,]+)/i)
	};
}

const DROPPED = '[output dropped to fit the context window — run the tool again if you still need it]';
const size = (m: ChatMessage) => (m.role !== 'assistant' ? m.images?.length ?? 0 : 0) * 3072 + (m.role === 'assistant' && m.native ? Math.max(m.content.length, (m.native.outputTokens ?? 0) * 3, JSON.stringify(m.native.items).length) : (m.content?.length ?? 0) + (m.role === 'assistant' ? (m.reasoning?.length ?? 0) + (m.toolCalls ?? []).reduce((n, c) => n + (c.arguments?.length ?? 0) + (c.signature?.length ?? 0), 0) : 0));

/** Characters the messages put on the wire (content and tool-call arguments). */
export function messageChars(messages: ChatMessage[]): number {
	return messages.reduce((n, m) => n + size(m), 0);
}

/**
 * Characters per token, measured from a request the provider counted. Tool definitions are in the
 * provider's count but not in `chars`, so the measure errs towards trimming early (pure; tested).
 */
export function measuredCharsPerToken(chars: number, providerTokens: number): number | undefined {
	if (!(providerTokens > 0) || !(chars > 0)) return undefined;
	return Math.min(4, Math.max(1.5, chars / providerTokens));
}

/**
 * Shrink a conversation in place until it fits `maxChars` (OpenCode-style
 * progressive compaction, without a model call): old tool outputs go first,
 * then long old messages are cut to their head, then the newest outputs are
 * clipped. The first user message and the last exchange stay. Returns the
 * characters removed (pure; tested).
 */
export function shrinkToFit(messages: ChatMessage[], maxChars: number): number {
	const total = () => messages.reduce((n, m) => n + size(m), 0);
	const start = total();
	if (start <= maxChars) return 0;
	const keepTail = 4;
	// Only overflow recovery may discard old opaque reasoning; the newest exchange stays exact.
	for (let i = 0; i < messages.length - 2; i++) {
		const message = messages[i];
		if (message.role !== 'assistant' || !message.native && !message.reasoning) continue;
		messages[i] = { ...message, native: undefined, reasoning: undefined, toolCalls: message.toolCalls?.map(call => ({ ...call, signature: undefined })) };
		if (total() <= maxChars) return start - total();
	}
	// 1. Old tool outputs (all but the newest few).
	const tools = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
	for (const i of tools.slice(0, Math.max(0, tools.length - keepTail))) {
		const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
		if (m.content.length > 200) messages[i] = { ...m, content: DROPPED, images: undefined };
		if (total() <= maxChars) return start - total();
	}
	// 2. Long older messages keep their head.
	const firstUser = messages.findIndex((m) => m.role === 'user');
	for (let i = 0; i < messages.length - 2; i++) {
		const m = messages[i];
		if (i === firstUser || m.role === 'tool' || m.content.length <= 2000) continue;
		messages[i] = { ...m, content: m.content.slice(0, 1500) + '\n[… trimmed to fit the context window …]' } as ChatMessage;
		if (total() <= maxChars) return start - total();
	}
	// 3. The newest tool outputs share what is left of the budget (head and tail kept), and no images.
	const newest = tools.filter((i) => messages[i].content.length > 200);
	const rest = total() - newest.reduce((n, i) => n + messages[i].content.length, 0);
	const marker = '\n[… trimmed to fit the context window …]\n';
	const per = Math.max(600, Math.floor((maxChars - rest) / Math.max(1, newest.length)) - marker.length);
	for (const i of newest) {
		const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>;
		if (m.content.length > per + marker.length) messages[i] = { ...m, content: m.content.slice(0, per >> 1) + marker + m.content.slice(-(per >> 1)), images: undefined };
	}
	return start - total();
}

/**
 * Run a model call; when the provider says the prompt is too long, shrink the
 * conversation to 70%, then 50%, then 35% of the window and call again.
 * When the error names the real window (local servers often run a smaller
 * one than the model advertises), that window is used and reported through
 * `onWindow`; when it names the prompt size, characters per token are
 * measured from it instead of assumed.
 */
export async function withOverflowRecovery<T>(fn: () => Promise<T>, o: { messages: ChatMessage[]; windowTokens?: number; systemChars: number; reservedTokens?: number; streamed?(): boolean; onShrink?(removedTokens: number, tier: number): void; onWindow?(tokens: number): void }): Promise<T> {
	const tiers = [0.7, 0.5, 0.35];
	let tier = 0;
	let window = o.windowTokens ?? 128_000;
	let perToken = 3.5;
	for (;;) {
		try {
			return await fn();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (o.streamed?.() || !CONTEXT_OVERFLOW.test(message)) throw error;
			const { limit, need } = overflowNumbers(message);
			if (!limit && !need && tier === 0) window = Math.min(window, (o.messages.reduce((n, m) => n + size(m), 0) + o.systemChars) / perToken);
			if (limit && limit < window) {
				window = limit;
				o.onWindow?.(limit);
			}
			if (need && need > 0) perToken = Math.min(3.5, Math.max(1.5, (o.messages.reduce((n, m) => n + size(m), 0) + o.systemChars) / need));
			// A tier with nothing left to cut (the last one over-trimmed) falls through to the next.
			let removed = 0;
			while (!removed && tier < tiers.length) {
				removed = shrinkToFit(o.messages, Math.max(0, (window * tiers[tier] - (o.reservedTokens ?? 0)) * perToken - o.systemChars));
				// perToken is calibrated from the provider's own count when its error states one.
				if (removed) o.onShrink?.(Math.round(removed / perToken), tier);
				tier++;
			}
			if (!removed) throw new Error(`The request cannot fit the model's ${window}-token context without removing the task instructions. Shorten the task or worker reports, split the review into smaller tasks, or select a model with a larger context. Provider detail: ${message}`, { cause: error });
		}
	}
}

/** Preserve the task instructions: reject oversized inputs before a paid request rather than silently cutting requirements. */
export function prepareAgentContext(messages: ChatMessage[], o: { windowTokens: number; systemChars: number; toolChars: number; perToken?: number; maxTokens?: number }): number {
	const perToken = Math.min(3.5, Math.max(1.5, o.perToken ?? 3));
	const available = o.windowTokens - Math.ceil((messageChars(messages) + o.systemChars + o.toolChars) / perToken) - 1024;
	const output = Math.max(1, Math.min(o.maxTokens ?? 8000, Math.max(1024, available)));
	const maxChars = Math.max(0, Math.floor((o.windowTokens - output - 1024) * perToken - o.systemChars - o.toolChars));
	shrinkToFit(messages, maxChars);
	if (messageChars(messages) > maxChars || o.systemChars + o.toolChars >= (o.windowTokens - output - 1024) * perToken) {
		throw new Error(`The agent request is too large for this model's ${o.windowTokens}-token context after reserving instructions, tools and ${output} response tokens. Shorten the task or worker reports, split the review into smaller tasks, or select a model with a larger context. The task instructions were preserved.`);
	}
	return output;
}

/**
 * Output budgeting (oh-my-pi): the output cap fits what is left of the
 * window after the prompt, so a long conversation never fails with
 * "max_tokens + input > context" (pure; tested).
 */
export function outputBudget(maxTokens: number, windowTokens: number | undefined, promptTokens: number): number {
	if (!windowTokens) return maxTokens;
	const room = windowTokens - promptTokens - 1024;
	if (room <= 0) throw new Error('Prompt is too long: no context remains for the response after reserving provider overhead.');
	return Math.max(1, Math.min(maxTokens, Math.floor(room)));
}

/** Circuit breaker: a model that just failed its retries is skipped for a while. */
export class Breaker {
	private readonly until = new Map<string, number>();
	constructor(private readonly ms = 5 * 60_000) {}
	tripped(key: string): boolean {
		return (this.until.get(key) ?? 0) > Date.now();
	}
	trip(key: string): void {
		this.until.set(key, Date.now() + this.ms);
	}
	reset(key: string): void {
		this.until.delete(key);
	}
}
