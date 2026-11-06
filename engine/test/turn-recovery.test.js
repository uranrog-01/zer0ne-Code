'use strict';
const assert = require('assert/strict'), path = require('path');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { recoverInterrupted, recoverTranscript, TurnCheckpoint } = require(path.join(out, 'host/turnRecovery'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
	const messages = [
		{ id: 'prompt', role: 'user', content: 'Keep my prompt', turn: { startedAt: 10, undoable: true } },
		{ id: 'partial', role: 'assistant', content: 'Partial answer' },
		{ id: 'tool', role: 'assistant', kind: 'tool', content: '', tool: { status: 'running' }, approval: { status: 'pending' }, question: { status: 'pending' } },
		{ id: 'live', role: 'assistant', content: '', tool: { status: 'running' } },
		{ id: 'complete', role: 'user', content: 'Earlier prompt', turn: { startedAt: 1, endedAt: 9, outcome: 'completed', undoable: true } }
	];
	assert(recoverInterrupted(messages, new Set(['live']), 100, new Set(['complete'])));
	assert.equal(messages[0].turn.outcome, 'stopped'); assert.equal(messages[0].turn.endedAt, 100); assert.equal(messages[0].turn.undoable, false);
	assert.equal(messages[1].content, 'Partial answer'); assert.equal(messages[2].tool.summary, 'interrupted');
	assert.equal(messages[2].approval.status, 'rejected'); assert.equal(messages[2].question.status, 'skipped');
	assert.equal(messages[3].tool.status, 'running'); assert.equal(messages[4].turn.outcome, 'completed'); assert.equal(messages[4].turn.undoable, true);
	assert.equal(recoverInterrupted(messages, new Set(['live']), 200, new Set(['complete'])), false, 'recovery is idempotent');
	console.log('ok  orphaned decisions and turns recover; live cards and retained Undo stay intact');
	const approvals = [
		{ id: 'unfinished', role: 'assistant', content: '', approval: { status: 'applied', execution: 'running' } },
		{ id: 'finished', role: 'assistant', content: '', approval: { status: 'applied', execution: 'done', result: '' } },
		{ id: 'background', role: 'assistant', content: '', approval: { status: 'applied', execution: 'running' } }
	];
	assert(recoverInterrupted(approvals, new Set(['background'])));
	assert.equal(approvals[0].approval.execution, 'error'); assert.equal(approvals[0].approval.failed, true); assert.match(approvals[0].approval.result, /Interrupted/);
	assert.equal(approvals[1].approval.execution, 'done'); assert.equal(approvals[1].approval.result, ''); assert.equal(approvals[2].approval.execution, 'running');
	assert.equal(recoverInterrupted(approvals, new Set(['background'])), false);
	const transcript = { v: 1, entries: [{ role: 'user', content: 'Earlier prompt' }, { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', arguments: '{}' }] }, { role: 'tool', name: 'read_file', toolCallId: 'read', content: 'Earlier exact file contents' }], marks: { earlier: 0 }, reads: { 'a.ts': 1 } };
	recoverTranscript(transcript, messages.slice(0, 3), new Set(['prompt']));
	assert.equal(transcript.entries[2].content, 'Earlier exact file contents'); assert.equal(transcript.marks.prompt, 3);
	assert(transcript.entries.some(m => m.content === 'Partial answer')); assert.equal(transcript.reads['a.ts'], 1);
	const copy = JSON.stringify(transcript); recoverTranscript(transcript, messages.slice(0, 3), new Set(['prompt'])); assert.equal(JSON.stringify(transcript), copy);
	assert.equal(transcript.entries[4].role, 'assistant'); assert.equal(transcript.entries[5].toolCalls, undefined, 'recovery notes cannot reexecute a pending tool');
	console.log('ok  recovered model context retains the exact earlier tool results and appends an idempotent interrupted tail');
	let text = 'First', release, saves = [], errors = [];
	const gate = new Promise(resolve => { release = resolve; });
	const checkpoint = new TurnCheckpoint(() => [{ id: 'm', role: 'assistant', content: text }], async copy => { await gate; saves.push(copy); }, error => errors.push(error), 10000);
	const first = checkpoint.write(); text = 'Second'; const second = checkpoint.write();
	let stopped = false; const stop = checkpoint.stop().then(() => { stopped = true; });
	await pause(5); assert.equal(stopped, false); release(); await Promise.all([first, second, stop]);
	assert.deepEqual(saves.map(s => s[0].content), ['First', 'Second']); assert.equal(errors.length, 0);
	console.log('ok  checkpoints detach their data and drain before the final save');
	let fail = true, writes = 0;
	const retry = new TurnCheckpoint(() => messages, async () => { writes++; if (fail) throw Error('fixture disk failure'); }, error => errors.push(error), 10000);
	try { await retry.write(); fail = false; await retry.write(); assert.equal(writes, 2); assert.match(errors[0].message, /disk failure/); } finally { await retry.stop(); }
	console.log('ok  a failed checkpoint retains the previous copy and can save again');
})().catch(error => { console.error(error); process.exitCode = 1; });
