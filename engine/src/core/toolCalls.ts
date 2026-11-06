import type { ChatMessage, ToolCall } from '../chatClient';

export const REPLAY_ERROR = 'Error: this tool call id was already answered — the provider replayed it and the tool was not run again.';

/** Call IDs remain reserved even when outputs are compacted or a child is continued. */
export class ToolCallLedger {
	readonly seen: Set<string>;
	constructor(messages: ChatMessage[], seen?: Set<string>) {
		this.seen = seen ?? new Set();
		for (const message of messages) if (message.role === 'assistant') for (const call of message.toolCalls ?? []) this.seen.add(call.id);
	}
	prepare(calls: ToolCall[], eager = new Set<string>()): { calls: ToolCall[]; blocked: Set<string> } {
		const blocked = new Set<string>(), claimed = new Set<string>();
		return { calls: calls.map(call => {
			if (!this.seen.has(call.id) || (eager.has(call.id) && !claimed.has(call.id))) {
				this.seen.add(call.id); claimed.add(call.id); return call;
			}
			let n = 1, id: string;
			do { id = `${call.id}_replay_${n++}`; } while (this.seen.has(id));
			this.seen.add(id); blocked.add(id);
			return { ...call, id };
		}), blocked };
	}
}

/** A failed/aborted batch must be complete before a later user message is appended. */
export function pairPendingToolResults(messages: ChatMessage[], reason: string): void {
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
		let end = i + 1;
		while (end < messages.length && messages[end].role === 'tool') end++;
		const answered = new Set(messages.slice(i + 1, end).filter(m => m.role === 'tool').map(m => (m as Extract<ChatMessage, { role: 'tool' }>).toolCallId));
		const missing: ChatMessage[] = message.toolCalls.filter(c => !answered.has(c.id)).map(c => ({ role: 'tool', toolCallId: c.id, name: c.name, content: `Error: ${reason}; the tool did not complete.` }));
		messages.splice(end, 0, ...missing); i = end + missing.length - 1;
	}
}
