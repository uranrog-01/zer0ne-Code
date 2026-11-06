import * as path from 'path';
import { createHash } from 'crypto';
import { AcpConnection, AcpError, AcpPermissionOption, AcpSessionInfo, AcpToolCall, agentErrorMessage, applyPlanScope, modelOption, sessionModels, verificationMessage } from './client';
import { PLAN_AGENTS } from './registry';
import { getAcpRuntime } from './runtime';
import type { AcpToolEvent, AcpTurnHooks } from './types';
import type { StreamOptions, StreamResult } from '../chatClient';
import { applyThoughtLevel, thoughtControl, thoughtOption } from './reasoning';
import { verificationFailureText, verifyUrlIn } from './verification';

/**
 * A chat turn on an ACP agent (Claude, Antigravity, Cursor, Gemini, OpenCode…).
 * The agent is the whole agent: it reads, edits and runs on its own; zer0ne
 * shows what it does, asks the user when the agent asks, and routes its file
 * access through Undo and review. One agent process + session per chat.
 */

const IDLE_MS = 20 * 60_000;
export const ACP_PREFIX = 'acp:';

interface Turn {
	hooks: AcpTurnHooks;
	text: string;
	reasoning: string;
	onText?: (t: string) => void;
	onReasoning?: (t: string) => void;
	signal: AbortSignal;
	/** Paths the user already allowed this turn (an allowed edit is not asked about again when the agent writes it through us). */
	allowedPaths: Set<string>;
}

interface Slot {
	key: string;
	agentId: string;
	cwd: string;
	conn: AcpConnection;
	session: AcpSessionInfo;
	model?: string;
	mode?: string;
	effortDefaults?: Map<string, string>;
	turn?: Turn;
	last: number;
	seen?: { length: number; digest: string };
}

const slots = new Map<string, Slot>();
let sweeper: NodeJS.Timeout | undefined;

function sweep(): void {
	for (const [k, s] of slots) {
		if (!s.turn && (Date.now() - s.last > IDLE_MS || !s.conn.alive)) {
			s.conn.close();
			slots.delete(k);
		}
	}
	if (!slots.size && sweeper) {
		clearInterval(sweeper);
		sweeper = undefined;
	}
}

/** Close every agent (the editor is shutting down, or a provider was removed). */
export function closeAcpAgents(agentId?: string, chatId?: string): void {
	for (const [k, s] of slots) {
		if ((!agentId || s.agentId === agentId) && (!chatId || s.key.endsWith('::' + chatId))) {
			s.conn.close();
			slots.delete(k);
		}
	}
}

/** One spelling of a path for "was this approved" checks (Windows is case- and slash-insensitive). */
export const normPath = (p: string): string => {
	const n = path.resolve(p);
	return process.platform === 'win32' ? n.toLowerCase() : n;
};

const textOf = (c?: { type?: string; text?: string }): string => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : '');

/** What a permission request is about, in the terms of an approval card (pure; tested). */
export function describePermission(tc: AcpToolCall): { title: string; kind: string; path?: string; command?: string; oldText?: string | null; newText?: string } {
	const diff = tc.content?.find((c) => c.type === 'diff');
	const raw = (tc.rawInput ?? {}) as Record<string, unknown>;
	const cmd = typeof raw.command === 'string' ? raw.command : Array.isArray(raw.command) ? raw.command.join(' ') : undefined;
	const rawPath = [raw.file_path, raw.path, raw.filePath].find((p) => typeof p === 'string') as string | undefined;
	return { title: String(tc.title ?? tc.kind ?? 'Action'), kind: String(tc.kind ?? 'other'), path: diff?.path ?? tc.locations?.[0]?.path ?? rawPath, command: tc.kind === 'execute' ? cmd ?? tc.title : cmd, oldText: diff?.oldText, newText: diff?.newText };
}

/** The reply option for a yes / no: allow_once, else allow_always; reject_once, else reject_always (pure; tested). */
export function pickOption(options: AcpPermissionOption[], allow: boolean): string | undefined {
	const order = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
	for (const kind of order) {
		const o = options.find((x) => x.kind === kind);
		if (o) return o.optionId;
	}
	return undefined;
}

function toolEvent(u: any, prev?: AcpToolEvent): AcpToolEvent {
	const status = u.status === 'completed' ? 'done' : u.status === 'failed' ? 'error' : u.status === 'in_progress' ? 'running' : u.status === 'pending' ? 'pending' : prev?.status ?? 'running';
	const out = (u.content as AcpToolCall['content'])?.map((c) => (c.type === 'content' ? textOf(c.content) : c.type === 'diff' ? `edited ${c.path ?? ''}` : '')).filter(Boolean)[0];
	return { id: String(u.toolCallId), title: String(u.title ?? prev?.title ?? u.kind ?? 'Working'), kind: String(u.kind ?? prev?.kind ?? 'other'), status, detail: out ? out.split('\n')[0].slice(0, 160) : prev?.detail, path: u.locations?.[0]?.path ?? prev?.path };
}

function bind(agentId: string, key: string): { handlers: import('./client').AcpClientHandlers; slotRef: { slot?: Slot } } {
	const slotRef: { slot?: Slot } = {};
	const events = new Map<string, AcpToolEvent>();
	const turn = () => slotRef.slot?.turn;
	const handlers: import('./client').AcpClientHandlers = {
		sessionUpdate(_sid, u) {
			const slot = slotRef.slot;
			if (slot && u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) slot.session = { ...slot.session, configOptions: u.configOptions };
			const t = turn();
			if (!t) return;
			switch (u.sessionUpdate) {
				case 'agent_message_chunk': {
					const s = textOf(u.content);
					if (s) {
						t.text += s;
						t.onText?.(s);
					}
					break;
				}
				case 'agent_thought_chunk': {
					const s = textOf(u.content);
					if (s) {
						t.reasoning += s;
						t.onReasoning?.(s);
					}
					break;
				}
				case 'tool_call':
				case 'tool_call_update': {
					const ev = toolEvent(u, events.get(String(u.toolCallId)));
					events.set(ev.id, ev);
					t.hooks.tool(ev);
					break;
				}
				case 'plan':
					if (Array.isArray(u.entries)) t.hooks.plan?.(u.entries.map((e: any) => ({ content: String(e.content ?? ''), status: String(e.status ?? 'pending') })));
					break;
				default:
					break;
			}
		},
		async requestPermission({ toolCall, options }) {
			const t = turn();
			if (!t || t.signal.aborted) return { outcome: { outcome: 'cancelled' } };
			const d = describePermission(toolCall);
			const ok = await t.hooks.permission({ toolCallId: toolCall.toolCallId, ...d, options });
			if (ok && d.path) t.allowedPaths.add(normPath(d.path));
			const optionId = pickOption(options, ok);
			return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
		},
		async readTextFile({ path: p, line, limit }) {
			const t = turn();
			if (!t) throw new AcpError('No turn is running.', -32603);
			return { content: await t.hooks.readFile(p, line, limit) };
		},
		async writeTextFile({ path: p, content }) {
			const t = turn();
			if (!t) throw new AcpError('No turn is running.', -32603);
			await t.hooks.writeFile(p, content, t.allowedPaths.has(normPath(p)));
			return null;
		},
		exit() {
			const s = slotRef.slot;
			if (s && slots.get(key) === s) slots.delete(key);
		}
	};
	void agentId;
	return { handlers, slotRef };
}

/** The agent session of this chat: reused while it lives, else a fresh process + session. */
async function slotFor(agentId: string, hooks: AcpTurnHooks, providerId: string, signal: AbortSignal): Promise<{ slot: Slot; fresh: boolean }> {
	const rt = getAcpRuntime();
	if (!rt) throw new Error('Agents are not available in this app.');
	const key = `${providerId}::${hooks.chatId}`;
	const existing = slots.get(key);
	if (existing && existing.conn.alive && existing.agentId === agentId && path.resolve(existing.cwd) === path.resolve(hooks.cwd)) return { slot: existing, fresh: false };
	existing?.conn.close();
	const entry = await rt.entry(agentId);
	if (!entry) throw new Error(`The agent “${agentId}” is not in the registry any more — remove this provider or update the extension.`);
	hooks.status?.(`Starting ${entry.name}…`);
	const { handlers, slotRef } = bind(agentId, key);
	const conn = await rt.connect(entry, handlers, { cwd: hooks.cwd, fs: true, signal });
	let session: AcpSessionInfo;
	try {
		session = await conn.newSession(hooks.cwd, signal);
		// The plan inside the agent (Cline: billing = ClinePass) before any model is chosen.
		session = await applyPlanScope(conn, session, PLAN_AGENTS[agentId]?.planScope);
	} catch (e) {
		conn.close();
		if (signal.aborted || (e instanceof Error && e.name === 'AbortError')) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
		throw new Error(agentErrorMessage(e, entry.name));
	}
	const slot: Slot = { key, agentId, conn, session, cwd: hooks.cwd, last: Date.now() };
	slotRef.slot = slot;
	slots.set(key, slot);
	sweeper ??= setInterval(sweep, 60_000);
	sweeper.unref?.();
	return { slot, fresh: true };
}

/** Apply the chat's model / plan mode to the session when they changed. */
async function configure(slot: Slot, model: string | undefined, planMode: boolean | undefined, effort?: StreamOptions['effort']): Promise<void> {
	const { conn } = slot;
	let session = slot.session;
	const advertised = sessionModels(session).models.find(m => m.id === model)?.reasoningControl;
	const variant = effort && !thoughtControl(session) ? advertised?.choices?.find(c => c.effort === effort && c.model) : undefined;
	if (variant) model = variant.value;
	if (model && model !== slot.model) {
		const opt = modelOption(session);
		try {
			const result: any = opt ? await conn.setConfigOption(session.sessionId, opt.id, model) : session.models?.availableModels?.length ? await conn.setModel(session.sessionId, model) : undefined;
			if (Array.isArray(result?.configOptions)) session = { ...session, configOptions: result.configOptions };
			slot.model = model;
		} catch (e) {
			throw new Error(`Could not select model “${model}”. ${agentErrorMessage(e, conn.agentName)}`);
		}
	}
	if (!variant) {
		const option = thoughtOption(session);
		const key = `${model ?? ''}::${option?.id ?? ''}`;
		const defaults = slot.effortDefaults ??= new Map();
		if (option?.currentValue && !defaults.has(key)) defaults.set(key, option.currentValue);
		session = await applyThoughtLevel(conn, session, effort, defaults.get(key));
	}
	slot.session = session;
	const modes = session.modes?.availableModes ?? [];
	const want = planMode ? modes.find((m) => /plan/i.test(m.id) || /plan/i.test(m.name ?? '')) : modes.find((m) => session.modes?.currentModeId && /default|ask|manual/i.test(m.id) && m.id !== slot.mode);
	if (planMode && want && slot.mode !== want.id) {
		try {
			await conn.setMode(session.sessionId, want.id);
			slot.mode = want.id;
		} catch {
			/* not supported */
		}
	} else if (!planMode && slot.mode && /plan/i.test(slot.mode)) {
		const back = modes.find((m) => m.id === session.modes?.currentModeId && !/plan/i.test(m.id)) ?? modes.find((m) => /default|ask|manual/i.test(m.id));
		if (back) {
			await conn.setMode(session.sessionId, back.id).catch(() => undefined);
			slot.mode = back.id;
		}
	}
}

/** Earlier messages as one context block, for an agent session that starts mid-chat (pure; tested). */
export function contextDigest(messages: StreamOptions['messages'], maxChars = 14_000): string {
	const parts: string[] = [];
	let used = 0;
	for (let i = messages.length - 2; i >= 0 && used < maxChars; i--) {
		const m = messages[i];
		if (!m.content?.trim()) continue;
		const label = m.role === 'tool' ? `Tool (${m.name})` : m.role === 'user' ? 'User' : 'Assistant';
		const line = `${label}: ${m.content.trim().slice(0, 4000)}`.slice(0, Math.max(0, maxChars - used - 2));
		if (!line) break;
		parts.unshift(line);
		used += line.length;
	}
	return parts.length ? `[Earlier in this chat, for context]\n${parts.join('\n\n')}\n\n[Now]\n` : '';
}

// Native sessions cannot rewind. A changed/pruned prefix must start a new session;
// otherwise only turns after the last successful response are owed to this agent.
function historyDigest(messages: StreamOptions['messages']): string {
	const hash = createHash('sha256');
	for (const m of messages) hash.update(JSON.stringify([m.role, m.content, m.role === 'user' ? m.images : undefined]));
	return hash.digest('hex');
}

export async function streamAcp(o: StreamOptions & { providerId?: string }): Promise<StreamResult> {
	const hooks = o.acp;
	if (!hooks) throw new Error('This provider runs an agent: use it from the chat.');
	const agentId = o.baseUrl.startsWith(ACP_PREFIX) ? o.baseUrl.slice(ACP_PREFIX.length) : o.baseUrl;
	let { slot, fresh } = await slotFor(agentId, hooks, o.providerId ?? agentId, o.signal);
	if (slot.turn) throw new Error('The agent is still working on the previous message.');
	if (!fresh && (!slot.seen || slot.seen.length >= o.messages.length || historyDigest(o.messages.slice(0, slot.seen.length)) !== slot.seen.digest)) {
		slot.conn.close();
		slots.delete(slot.key);
		({ slot, fresh } = await slotFor(agentId, hooks, o.providerId ?? agentId, o.signal));
	}
	const turn: Turn = { hooks, text: '', reasoning: '', onText: o.onText, onReasoning: o.onReasoning, signal: o.signal, allowedPaths: new Set() };
	slot.turn = turn;
	slot.last = Date.now();
	const lastUser = [...o.messages].reverse().find((m) => m.role === 'user');
	const blocks: Array<Record<string, unknown>> = [];
	const preface = contextDigest(fresh ? o.messages : o.messages.slice(slot.seen!.length));
	blocks.push({ type: 'text', text: preface + (lastUser?.content ?? '') });
	if (slot.conn.capabilities?.promptCapabilities?.image) for (const img of lastUser?.images ?? []) blocks.push({ type: 'image', mimeType: img.mime, data: img.base64 });
	const onAbort = () => slot.conn.cancel(slot.session.sessionId);
	o.signal.addEventListener('abort', onAbort, { once: true });
	try {
		await configure(slot, o.model, hooks.planMode, o.effort);
		const res = await slot.conn.prompt(slot.session.sessionId, blocks);
		// The agent answered "cancelled": end the turn the way every other client does (partial text is kept by the runner).
		if (o.signal.aborted || res.stopReason === 'cancelled') throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
		// The agent reported the vendor's "verify your account" (Antigravity) as its answer: an error with the verification page.
		const failedText = /^\s*(agent execution error|error:|request failed)/i.test(turn.text);
		if ((slot.conn.verifyUrl && (failedText || !turn.text.trim())) || verificationFailureText(turn.text)) {
			const url = verifyUrlIn(turn.text) ?? slot.conn.verifyUrl;
			slot.conn.close();
			slots.delete(slot.key);
			// With the page in hand, Google's raw 403 text adds nothing; without it, it is the only clue.
			throw new Error(verificationMessage(slot.conn.agentName || 'The agent', url, url ? '' : turn.text.trim().slice(0, 300)));
		}
		const out = Math.ceil((turn.text.length + turn.reasoning.length) / 3.6);
		const seen: StreamOptions['messages'] = [...o.messages, { role: 'assistant', content: turn.text }];
		slot.seen = { length: seen.length, digest: historyDigest(seen) };
		return { text: turn.text, reasoning: turn.reasoning, toolCalls: [], usage: { input: Math.ceil((preface.length + (lastUser?.content.length ?? 0)) / 3.6), output: out }, stopReason: res.stopReason === 'max_tokens' ? 'length' : res.stopReason };
	} catch (e) {
		// A failed/cancelled prompt may have partly reached the agent. Reconstruct
		// from the saved transcript on retry instead of duplicating that prompt.
		slot.conn.close();
		slots.delete(slot.key);
		if (o.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
		if (e instanceof AcpError && (e.authRequired || e.verificationRequired)) {
			slot.conn.close();
			slots.delete(slot.key);
			throw new Error(agentErrorMessage(e, slot.conn.agentName || 'agent', slot.conn.verifyUrl));
		}
		if (!slot.conn.alive) slots.delete(slot.key);
		throw e;
	} finally {
		o.signal.removeEventListener('abort', onAbort);
		slot.turn = undefined;
		slot.last = Date.now();
	}
}

export { sessionModels };
