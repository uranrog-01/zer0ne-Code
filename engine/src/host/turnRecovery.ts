import type { StoredMessage } from '../providerStore';
import type { Transcript } from '../transcript';

/** Preserve earlier exact tool results; only the interrupted tail comes from display checkpoints. */
export function recoverTranscript(transcript: Transcript, messages: StoredMessage[], interrupted: ReadonlySet<string>): void {
	const first = messages.findIndex(message => interrupted.has(message.id));
	if (first < 0) return;
	const start = transcript.marks[messages[first].id] ?? transcript.entries.length;
	transcript.entries = transcript.entries.slice(0, start);
	for (const [id, mark] of Object.entries(transcript.marks)) if (mark >= start) delete transcript.marks[id];
	for (const message of messages.slice(first)) {
		if (message.local || message.compacted || message.isError) continue;
		if (message.role === 'user') {
			transcript.marks[message.id] = transcript.entries.length;
			transcript.entries.push({ role: 'user', content: message.apiContent ?? message.content });
		} else if (message.kind === 'tool') {
			const note = message.tool ? `${message.tool.name}: ${message.tool.summary}` : message.approval ? `Approval ${message.approval.status}` : message.question ? `Question ${message.question.status}` : '';
			if (note) transcript.entries.push({ role: 'assistant', content: `[Interrupted tool activity: ${note.slice(0, 1000)}]` });
		} else if (message.content.trim()) transcript.entries.push({ role: 'assistant', content: message.content });
	}
}

/** Live background cards belong to their registry even when their chat is not selected. */
export function recoverInterrupted(messages: StoredMessage[], liveCards: ReadonlySet<string> = new Set(), now = Date.now(), undoableTurns: ReadonlySet<string> = new Set()): boolean {
	let changed = false;
	for (const message of messages) {
		if (liveCards.has(message.id)) continue;
		if (message.approval?.status === 'pending') { message.approval.status = 'rejected'; changed = true; }
		if (message.approval?.execution === 'running') {
			message.approval.execution = 'error'; message.approval.failed = true;
			message.approval.result = 'Interrupted before an execution result was recorded.'; changed = true;
		}
		if (message.question?.status === 'pending') { message.question.status = 'skipped'; changed = true; }
		if (message.tool?.status === 'running') { message.tool.status = 'error'; message.tool.summary = 'interrupted'; changed = true; }
		if (message.turn) {
			if (!message.turn.endedAt) { message.turn.endedAt = now; message.turn.outcome = 'stopped'; changed = true; }
			if (message.turn.undoable && !undoableTurns.has(message.id)) { message.turn.undoable = false; changed = true; }
		}
	}
	return changed;
}

/** Serialize detached snapshots so a slow checkpoint cannot overwrite the finished turn. */
export class TurnCheckpoint {
	private pending: Promise<void> = Promise.resolve();
	private previous?: string;
	private timer: ReturnType<typeof setInterval>;
	constructor(private snapshot: () => StoredMessage[], private save: (messages: StoredMessage[]) => Promise<void>, private onError: (error: unknown) => void, interval = 1000) {
		this.timer = setInterval(() => { void this.write(); }, interval);
		this.timer.unref();
	}
	write(): Promise<void> {
		const json = JSON.stringify(this.snapshot());
		if (json === this.previous) return this.pending;
		this.previous = json;
		const messages: StoredMessage[] = JSON.parse(json);
		this.pending = this.pending.then(() => this.save(messages)).catch(error => { this.previous = undefined; this.onError(error); });
		return this.pending;
	}
	async stop(): Promise<void> { clearInterval(this.timer); await this.pending; }
}
