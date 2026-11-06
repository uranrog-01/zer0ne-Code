import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

export interface ExecutionIdentity { sessionId: string; taskId: string; callId: string; tool: string; }
export interface ExecutionEvent { at: number; kind: 'requested' | 'approval' | 'finished'; outcome?: 'completed' | 'failed' | 'refused' | 'unknown'; approved?: boolean; automatic?: boolean; }
export interface ExecutionRecord extends ExecutionIdentity { argumentHash: string; events: ExecutionEvent[]; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
// Keep paths below Windows toolchain limits even when profile and storage paths are long.
const key = (value: string) => digest(value).slice(0, 24);
function directory(storage: string, sessionId: string, taskId: string): string {
	return path.join(storage, 'execution-journal', key(sessionId + '\0' + taskId));
}

/** The exclusive request record is durable before effects. Reusing its identity never executes it again. */
export function beginExecution(storage: string, identity: ExecutionIdentity, args: string) {
	const dir = directory(storage, identity.sessionId, identity.taskId);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, key(identity.callId) + '.jsonl');
	let declined = false;
	const append = (value: unknown, exclusive = false) => {
		const fd = fs.openSync(file, exclusive ? 'wx' : 'a');
		try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
	};
	try {
		append({ ...identity, argumentHash: digest(args), at: Date.now(), kind: 'requested' }, true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This tool-call identity is already recorded. Inspect its execution history and current state before requesting a new action.');
		throw error;
	}
	return {
		approval: (approved: boolean, automatic?: boolean) => { declined ||= !approved; append({ at: Date.now(), kind: 'approval', approved, automatic: automatic === true }); },
		finish: (outcome: NonNullable<ExecutionEvent['outcome']>) => append({ at: Date.now(), kind: 'finished', outcome: declined && outcome !== 'unknown' ? 'refused' : outcome })
	};
}

/** Raw arguments, outputs, credentials and approval contents never enter this journal. */
export function readExecutions(storage: string, sessionId: string, taskId: string): ExecutionRecord[] {
	const dir = directory(storage, sessionId, taskId);
	if (!fs.existsSync(dir)) return [];
	const records: ExecutionRecord[] = [];
	for (const name of fs.readdirSync(dir)) {
		if (!/^[a-f0-9]{24}\.jsonl$/.test(name)) continue;
		const file = path.join(dir, name);
		if (fs.statSync(file).size > 1024 * 1024) throw new Error('Execution history contains an oversized record.');
		const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
		const events: ExecutionEvent[] = [];
		let first: ExecutionRecord | undefined;
		for (const line of lines) {
			try {
				const row = JSON.parse(line);
				if (!first) {
					if (row.kind !== 'requested' || row.sessionId !== sessionId || row.taskId !== taskId || typeof row.callId !== 'string' || key(row.callId) + '.jsonl' !== name || typeof row.tool !== 'string' || typeof row.argumentHash !== 'string') break;
					first = { sessionId, taskId, callId: row.callId, tool: row.tool, argumentHash: row.argumentHash, events };
				}
				if (!Number.isFinite(row.at) || !['requested', 'approval', 'finished'].includes(row.kind)) break;
				events.push({ at: row.at, kind: row.kind, outcome: ['completed', 'failed', 'refused', 'unknown'].includes(row.outcome) ? row.outcome : undefined, approved: typeof row.approved === 'boolean' ? row.approved : undefined, automatic: row.automatic === true });
			} catch { break; /* A torn final row cannot prove completion. */ }
		}
		if (first && events.length) records.push(first);
	}
	return records.sort((a, b) => b.events[0].at - a.events[0].at).slice(0, 200);
}
