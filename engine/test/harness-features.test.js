// Features added in the harness gap pass: checkpoint binary sidecars, the
// turn trace, the browser host allow-list and the shared agent task board.
// All offline: the vscode API comes from the test shim.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.ZER0NE_ENGINE_OUT || path.join(__dirname, '..', 'out');
const { createShim, install } = require('./vscode-shim');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-features-'));
install(createShim({ dataDir: path.join(ws, '.data'), workspace: ws }).vscode);

const { isBinaryBytes, CheckpointStore } = require(OUT + '/checkpoints.js');
const { createTurnTrace } = require(OUT + '/host/turnTrace.js');
const { browserUrlAllowed } = require(OUT + '/tools/agentTools.js');
const { AgentRegistry } = require(OUT + '/host/turnAgents.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('isBinaryBytes: NUL and invalid UTF-8 are binary; text is not', () => {
	assert.equal(isBinaryBytes(Buffer.from('plain text\nwith lines\r\n')), false, 'text');
	assert.equal(isBinaryBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true, 'PNG (NUL)');
	assert.equal(isBinaryBytes(new Uint8Array([0xff, 0xfe, 0xfd])), true, 'invalid UTF-8');
	assert.equal(isBinaryBytes(new Uint8Array()), false, 'empty is text (an empty file)');
});

test('CheckpointStore: binary sidecars round-trip and are cleaned with the checkpoint', () => {
	const store = new CheckpointStore(path.join(ws, 'checkpoints'));
	const bytes = Buffer.from([0x00, 0x01, 0x02, 0xff]);
	const ref = require('crypto').createHash('sha256').update(bytes).digest('hex');
	store.saveBinary('s1', 'u1', ref, bytes);
	assert.deepEqual([...store.readBinary('s1', 'u1', ref)], [...bytes], 'the bytes survive');
	assert.equal(store.readBinary('s1', 'u1', 'nope'), undefined, 'a missing ref is undefined');
	assert.equal(store.readBinary('s1', 'u1', '../escape'), undefined, 'a non-digest ref is refused');
	store.save('s1', { userId: 'u1', at: 1, files: { 'img.png': { before: null, after: null, binary: { afterRef: ref, size: bytes.length } } } });
	assert.ok(store.load('s1', 'u1'), 'the checkpoint loads');
	store.remove('s1', 'u1');
	assert.equal(store.readBinary('s1', 'u1', ref), undefined, 'the sidecar goes with the checkpoint');
});

test('createTurnTrace: off without ZER0NE_TRACE_DIR, JSONL when set, capped', () => {
	delete process.env.ZER0NE_TRACE_DIR;
	assert.equal(createTurnTrace(undefined, 'sess', 'turn1'), undefined, 'no dir, no trace');
	const dir = path.join(ws, 'traces');
	process.env.ZER0NE_TRACE_DIR = dir;
	try {
		const trace = createTurnTrace(undefined, 'sess', 'turn1');
		assert.ok(trace, 'a trace exists when the env var is set');
		trace.write({ kind: 'turn_start', promptChars: 10, plan: false });
		trace.write({ kind: 'turn_end', outcome: 'completed', steps: 2, tokensIn: 100, tokensOut: 50 });
		trace.close();
		const lines = fs.readFileSync(path.join(dir, 'sess-turn1.jsonl'), 'utf8').trim().split('\n');
		assert.equal(lines.length, 2, 'one line per event');
		assert.equal(JSON.parse(lines[1]).outcome, 'completed', 'events are JSON');
		assert.ok(JSON.parse(lines[0]).t > 0, 'each line is timestamped');
	} finally {
		delete process.env.ZER0NE_TRACE_DIR;
	}
});

test('browserUrlAllowed: empty list allows all; a listed host and its subdomains pass', () => {
	assert.deepEqual(browserUrlAllowed('https://example.com/x', ''), { allowed: true, host: 'example.com' }, 'no list, any host');
	const list = 'example.com\nlocalhost';
	assert.ok(browserUrlAllowed('https://example.com', list).allowed, 'exact host');
	assert.ok(browserUrlAllowed('https://api.example.com', list).allowed, 'subdomain');
	assert.ok(browserUrlAllowed('http://localhost:5173', list).allowed, 'localhost with port');
	assert.ok(!browserUrlAllowed('https://notexample.com', list).allowed, 'a lookalike domain is refused');
	assert.ok(!browserUrlAllowed('https://evil-example.com', list).allowed, 'a prefix lookalike is refused');
	assert.ok(!browserUrlAllowed('not a url', list).allowed, 'an unparsable URL is refused');
});

test('AgentRegistry.board: add, claim, complete, reopen, per-session isolation', () => {
	const registry = new AgentRegistry();
	const board = registry.board('chatA');
	const { id } = board.add('Fix the failing login test');
	assert.ok(id, 'a task gets an id');
	assert.equal(board.claim(id, 'a1').includes('Claimed'), true, 'claim');
	assert.equal(board.claim(id, 'a2').includes('already'), false, 're-claim allowed but reported');
	assert.equal(board.complete(id, 'test passes').includes('done'), true, 'complete');
	const listed = board.list().find((t) => t.id === id);
	assert.equal(listed.status, 'done', 'the task is done');
	assert.equal(listed.note, 'test passes', 'the note is kept');
	assert.equal(board.reopen(id).includes('open again'), true, 'reopen');
	assert.equal(registry.board('chatB').list().length, 0, 'another chat starts empty');
	registry.dropBoard('chatA');
	assert.equal(registry.board('chatA').list().length, 0, 'a dropped board is gone');
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n ' + (e && e.stack ? e.stack : e));
		}
	}
	fs.rmSync(ws, { recursive: true, force: true });
	process.exit(failed ? 1 : 0);
})();
