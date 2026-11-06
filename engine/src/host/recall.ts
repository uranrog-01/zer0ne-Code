import { fenceToolOutput } from '../core/untrusted';
import type { BackgroundProc } from '../tools/moreTools';
import type { ThreadTable } from './threads';
import { formatDuration, type AgentRun } from './turnAgents';
import { reportOutcome } from './reportStatus';

/**
 * recall: Chain of Recall over what a chat has — agents, background commands, threads and their events.
 * Every record inlines what is short and likely needed next, and points at the rest by id or by the call
 * that returns it, so the model follows references one hop at a time instead of rereading transcripts.
 */

export interface RecallSources {
	sessionId: string;
	agents: AgentRun[];
	commands: BackgroundProc[];
	threads: ThreadTable;
	board?: Array<{ status: string }>;
	/** Project event decisions, newest last. */
	events?: ReadonlyArray<{ at: number; label: string; decision: string; reason: string }>;
	now?: number;
}

const INLINE = 600;
const RECENT_EVENTS = 8;

const clipped = (text: string, max: number, more: string) => (text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters: ${more})`);

function agentRecord(r: AgentRun, s: RecallSources): string {
	const now = s.now ?? Date.now();
	const age = formatDuration((r.endedAt ?? now) - r.stats.startedAt);
	const last = r.tools?.at(-1);
	const threads = s.threads.ofAgent(r.id).map((id) => `${id} (${s.threads.get(id)?.label ?? ''})`);
	const done = s.board?.filter((t) => t.status === 'done').length;
	const ended = r.status === 'completed' ? reportOutcome(r.report) : {};
	return [
		`agent ${r.id}${r.agentName ? ` (${r.agentName})` : ''} · ${r.kind} · ${r.status} ${age} · "${r.description}"`,
		`progress: ${r.stats.toolUses} tool call${r.stats.toolUses === 1 ? '' : 's'}${last ? ` · last step: ${last.name} ${last.args} (${last.status})` : ''}${s.board?.length ? ` · board: ${done}/${s.board.length} done` : ''}`,
		threads.length ? `threads: ${threads.join(', ')}` : '',
		r.worktree?.branch ? `branch: ${r.worktree.branch}${r.worktree.files !== undefined ? ` · ${r.worktree.files} files changed` : ''} · review: agent_diff {"id":"${r.id}"}` : '',
		r.watchdog ? `watchdog: ${r.watchdog.state} — ${r.watchdog.reason}` : '',
		ended.state ? `outcome: ${ended.state}` : '',
		ended.question ? `question for the user: ${ended.question}` : '',
		r.steering?.length ? `instructions sent: ${r.steering.length} (latest: ${r.steering.at(-1)!.slice(0, 120)})` : '',
		r.error ? `error: ${r.error.slice(0, 300)}` : '',
		r.report ? `report: ${clipped(r.report, INLINE, `agent_result {"ids":["${r.id}"]}`)}` : r.status === 'running' ? `report: not yet — continue it with agent_send {"id":"${r.id}","message":"…"}` : ''
	].filter(Boolean).join('\n');
}

function commandRecord(p: BackgroundProc, now: number): string {
	const state = p.code === undefined ? `running ${formatDuration(now - p.startedAt)}` : p.signal ? `stopped by ${p.signal}` : `exited with code ${p.code} after ${formatDuration((p.endedAt ?? now) - p.startedAt)}`;
	const lines = p.out.replace(/\s+$/, '').split(/\r?\n/);
	const tail = p.out.trim() ? fenceToolOutput('run_command', lines.slice(-15).join('\n').slice(-1500)) : '(no output yet)';
	const unread = p.out.length - p.read;
	return [`command ${p.id} · \`${p.command.slice(0, 200)}\` · ${state}`, `last lines:\n${tail}`, unread > 0 ? `unread output: ${unread} characters — command_output {"id":"${p.id}"}` : ''].filter(Boolean).join('\n');
}

function threadRecord(id: string, before: string | undefined, s: RecallSources): string | undefined {
	const t = s.threads.get(id);
	if (!t || t.sessionId !== s.sessionId) return undefined;
	const cut = before ? t.events.findIndex((e) => e.id === before) : -1;
	const pool = cut >= 0 ? t.events.slice(0, cut) : t.events;
	const shown = pool.slice(-RECENT_EVENTS);
	const earlier = pool.length - shown.length;
	const agents = [...t.agents].map((a) => `${a} (${s.agents.find((r) => r.id === a)?.status ?? 'gone'})`);
	return [
		`thread ${t.id} · ${t.label} · ${t.events.length} event${t.events.length === 1 ? '' : 's'}${t.dropped ? ` (${t.dropped} older ones not kept)` : ''}`,
		`subscribed: ${agents.join(', ') || 'none — new messages go to you'}`,
		shown.length ? `${before ? 'before ' + before : 'recent'}:\n${shown.map((e) => `${e.id} [${e.source}] ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}` : '(no events)',
		earlier > 0 ? `earlier: ${earlier} more — recall {"id":"${t.id}","before":"${shown[0].id}"}` : '',
		'Full text of one event: recall {"id":"<event id>"}'
	].filter(Boolean).join('\n');
}

/** The record for one id, or what the chat has for "list" (pure given its sources; tested). */
export function recallText(id: string, before: string | undefined, s: RecallSources): string {
	const now = s.now ?? Date.now();
	if (id === 'list') {
		const agents = s.agents.map((r) => `${r.id} · ${r.status} · ${r.description.slice(0, 80)}`);
		const commands = s.commands.map((p) => `${p.id} · ${p.code === undefined ? 'running' : `exit ${p.code}`} · ${p.command.slice(0, 80)}`);
		const threads = s.threads.list(s.sessionId).map((t) => `${t.id} · ${t.label} · ${t.events.length} events`);
		const events = (s.events ?? []).slice(-10).map((e) => `${new Date(e.at).toISOString().slice(11, 16)} ${e.label} — ${e.decision}: ${e.reason}`);
		return [`agents:\n${agents.join('\n') || '(none)'}`, `background commands:\n${commands.join('\n') || '(none)'}`, `threads:\n${threads.join('\n') || '(none)'}`, ...(events.length ? [`project events (latest decisions):\n${events.join('\n')}`] : [])].join('\n\n');
	}
	const agent = s.agents.find((r) => r.id === id || r.id.split('-')[0] === id);
	if (agent) return agentRecord(agent, s);
	const command = s.commands.find((p) => p.id === id);
	if (command) return commandRecord(command, now);
	if (id.startsWith('th-')) {
		const thread = threadRecord(id, before, s);
		if (thread) return thread;
	}
	const ev = s.threads.event(id);
	if (ev && ev.thread.sessionId === s.sessionId) {
		return `event ${ev.event.id} · thread ${ev.thread.id} (${ev.thread.label}) · ${ev.event.source} · ${new Date(ev.event.at).toISOString()}\n${fenceToolOutput('thread_event', ev.event.text)}`;
	}
	return `Nothing has the id "${id}" in this chat. recall {"id":"list"} shows the agents, commands and threads it has.`;
}
