// Compaction: provider-count anchor (Pi), circuit breaker (ZCode), overflow retry (Codex), file lists (Pi).
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'out');

const { createShim, install } = require('./vscode-shim');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-compact-'));
install(createShim({ dataDir: path.join(ws, '.data'), workspace: ws }).vscode);
const { Compactor, fileLists, MAX_COMPACT_FAILURES } = require(OUT + '/host/compaction.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const user = (id, content, turn) => ({ id, role: 'user', content, turn });
const answer = (id, content) => ({ id, role: 'assistant', content });

function compactor(over = {}) {
	const calls = [];
	const requests = [];
	const statuses = [];
	const saved = {};
	const settings = { autoCompact: true, compactThreshold: 80, exactHistory: false, localHelper: '', ...(over.settings ?? {}) };
	const deps = {
		store: {
			getSettings: () => settings,
			getSummary: async () => saved.summary,
			setSummary: async (_s, v) => (saved.summary = v),
			list: async () => [],
			getApiKey: async () => ''
		},
		sessionId: () => 's1',
		transcripts: over.transcripts ?? { load: () => undefined, remove: () => {}, archive: () => {} },
		cacheGuard: { reset: () => {} },
		status: (m) => statuses.push(m),
		scheduleState: () => {},
		callModel: async (_p, _k, o) => {
			calls.push(o.messages[0].content);
			requests.push(o);
			return over.callModel ? over.callModel(o, calls.length) : { text: '- summary' };
		}
	};
	return { c: new Compactor(deps), calls, requests, statuses, saved };
}

test('the provider count of the last turn anchors the context size; turns before a summary do not', () => {
	const { c } = compactor();
	const convo = [user('u1', 'first', { startedAt: 1000, contextTokens: 50_000 }), answer('a1', 'ok'), user('u2', 'second question')];
	const n = c.contextTokens(convo, 0, 2, undefined, undefined);
	assert.ok(n >= 50_000 && n < 50_100, 'anchor + new message: ' + n);
	const est = c.contextTokens(convo, 0, 2, 2000, undefined);
	assert.ok(est < 1000, 'an anchor older than the summary is ignored: ' + est);
});

test('the summary request replays the conversation prefix, so the provider serves the replayed region from its cache', async () => {
	// The transcript holds exactly what the conversation sent; the marks say where
	// each user turn starts.
	const entries = [
		{ role: 'user', content: 'first question' },
		{ role: 'assistant', content: '', reasoning: 'plan', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{}' }] },
		{ role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'file text' },
		{ role: 'user', content: 'second question' },
		{ role: 'assistant', content: 'answer' }
	];
	const transcript = { v: 1, entries, marks: { u1: 0, u2: 3 }, reads: {} };
	const { c, requests } = compactor({
		settings: { exactHistory: true },
		transcripts: { load: () => transcript, remove: () => {}, archive: () => {} }
	});
	const convo = [user('u1', 'first question'), answer('a1', ''), user('u2', 'second question'), answer('a2', 'answer'), user('u3', 'third question')];
	const tools = [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }];
	await c.maybeCompact(convo, convo.at(-1), {}, { id: 'm', contextWindow: 1000 }, '', true, new AbortController().signal, { system: 'THE CONVERSATION SYSTEM PROMPT', tools });
	const request = requests.at(-1);
	assert.strictEqual(request.system, 'THE CONVERSATION SYSTEM PROMPT', 'the conversation system prompt is replayed, not a summarizer prompt');
	assert.deepStrictEqual(request.tools, tools, 'the tool list rides along: it is part of the cached token sequence');
	assert.deepStrictEqual(request.messages.slice(0, 3), entries.slice(0, 3), 'the region is replayed as the conversation sent it');
	const last = request.messages.at(-1);
	assert.strictEqual(last.role, 'user', 'the instruction is a trailing message');
	assert.match(last.content, /compaction engine/i, 'the instruction asks for the summary');
	assert.ok(!request.messages.slice(0, 3).some((m) => /compaction engine/i.test(String(m.content ?? ''))), 'the instruction is not in the replayed region');
	console.log('ok  the summary request replays the conversation prefix with the instruction at the end');
});

test('a summary request without a known prefix keeps the flat form', async () => {
	const { c, requests } = compactor();
	const convo = [user('u1', 'first'), answer('a1', 'ok'), user('u2', 'second'), answer('a2', 'ok'), user('u3', 'now')];
	await c.maybeCompact(convo, convo.at(-1), {}, { id: 'm', contextWindow: 1000 }, '', true, new AbortController().signal);
	const request = requests.at(-1);
	assert.match(request.system, /compress coding conversations/i, 'the flat form has its own summarizer prompt');
	assert.strictEqual(request.messages.length, 1);
	console.log('ok  without a known prefix the summary request stays flat');
});

test('summary lists files read and modified from the record; modified wins', () => {
	const older = [
		{ id: 't1', role: 'assistant', kind: 'tool', content: '', tool: { name: 'read_file', arg: 'src/a.ts', status: 'done' } },
		{ id: 't2', role: 'assistant', kind: 'tool', content: '', tool: { name: 'read_file', arg: 'src/b.ts', status: 'done' } },
		user('u', 'x', { startedAt: 1, edits: [{ path: 'src/b.ts' }] }),
		user('v', 'y', { startedAt: 2, undone: true, edits: [{ path: 'src/c.ts' }] })
	];
	assert.strictEqual(fileLists(older), '\n\nFiles read: src/a.ts\n\nFiles modified: src/b.ts');
});

test('auto compaction pauses after repeated failures; an overflowing summary request is retried smaller', async () => {
	const window = { id: 'm', contextWindow: 1000 };
	const big = 'x '.repeat(3000);
	const convo = () => [user('u1', big, { startedAt: 1 }), answer('a1', big), user('u2', big, { startedAt: 2 }), answer('a2', 'ok'), user('u3', big, { startedAt: 3 }), answer('a3', 'ok'), user('u4', 'now')];
	const failing = compactor({ callModel: () => { throw new Error('upstream 500'); } });
	for (let i = 0; i < MAX_COMPACT_FAILURES; i++) {
		const cv = convo();
		await assert.rejects(failing.c.maybeCompact(cv, cv.at(-1), {}, window, '', false, new AbortController().signal));
	}
	assert.strictEqual(failing.calls.length, MAX_COMPACT_FAILURES);
	assert.ok(failing.statuses.some((s) => /paused for this chat/.test(s)), failing.statuses.join(' | '));
	const cv = convo();
	await failing.c.maybeCompact(cv, cv.at(-1), {}, window, '', false, new AbortController().signal);
	assert.strictEqual(failing.calls.length, MAX_COMPACT_FAILURES, 'no further summary calls while paused');

	const overflow = compactor({ callModel: (_o, n) => { if (n < 3) throw new Error('prompt is too long: 250000 tokens > 200000 maximum'); return { text: '- short' }; } });
	const cv2 = convo();
	await overflow.c.maybeCompact(cv2, cv2.at(-1), {}, window, '', false, new AbortController().signal);
	assert.strictEqual(overflow.calls.length, 3);
	assert.ok(overflow.calls[2].length < overflow.calls[0].length, 'retried with the oldest part dropped');
	assert.ok(overflow.saved.summary && overflow.saved.summary.at > 0, 'summary saved with its time');
	assert.ok(cv2.some((m) => m.compacted), 'marker inserted');
});

test('truncated, tool-calling and cancelled summaries never replace the original conversation', async () => {
	for (const reason of ['length', 'max_tokens', 'tool', 'cancelled']) {
		const abort = new AbortController();
		const { c, saved } = compactor({ callModel: () => {
			if (reason === 'cancelled') abort.abort();
			return { text: 'partial summary', stopReason: reason, toolCalls: reason === 'tool' ? [{ id: '1', name: 'read_file' }] : [] };
		} });
		const convo = [user('u1', 'Keep all requirements'), answer('a1', 'done'), user('u2', 'more'), answer('a2', 'done'), user('u3', 'continue')];
		const before = JSON.stringify(convo);
		await assert.rejects(c.maybeCompact(convo, convo.at(-1), {}, { id: 'm' }, '', true, abort.signal), reason === 'cancelled' ? /abort/i : /incomplete/);
		assert.equal(saved.summary, undefined);
		assert.equal(JSON.stringify(convo), before);
	}
});

test('compaction keeps the exact pre-compaction transcript (newest few); deleting the chat removes them', async () => {
	const { TranscriptStore, ARCHIVES_KEPT } = require(OUT + '/transcript.js');
	const dir = path.join(ws, 'transcripts');
	const store = new TranscriptStore(dir);
	const exact = (n) => ({ v: 1, entries: [{ role: 'user', content: 'read it ' + n }, { role: 'tool', toolCallId: 'c', name: 'read_file', content: 'file text ' + n }], marks: {}, reads: {} });
	const big = 'x '.repeat(3000);
	const convo = [user('u1', big, { startedAt: 1 }), answer('a1', big), user('u2', big, { startedAt: 2 }), answer('a2', 'ok'), user('u3', 'now')];
	const { c } = compactor({ transcripts: store });
	store.save('s1', exact(0)); store.save('s1', exact(0));
	await c.maybeCompact(convo, convo.at(-1), {}, { id: 'm', contextWindow: 1000 }, '', true, new AbortController().signal);
	assert.equal(store.load('s1'), undefined, 'the next turn restarts from the summary');
	assert.equal(store.archives('s1').length, 1);
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, store.archives('s1')[0]), 'utf8')).entries[1].content, 'file text 0');
	assert.ok(!fs.existsSync(path.join(dir, 's1.json.bak')), 'no recovery copy resurrects the old transcript');
	for (let i = 1; i <= ARCHIVES_KEPT + 1; i++) { store.save('s1', exact(i)); await new Promise((r) => setTimeout(r, 3)); store.archive('s1'); }
	assert.equal(store.archives('s1').length, ARCHIVES_KEPT, 'only the newest archives are kept');
	assert.match(JSON.parse(fs.readFileSync(path.join(dir, store.archives('s1')[0]), 'utf8')).entries[1].content, new RegExp(`file text ${ARCHIVES_KEPT + 1}`));
	store.save('s2', exact(9)); store.archive('s2');
	store.remove('s1');
	assert.deepEqual(store.archives('s1'), []);
	assert.equal(store.archives('s2').length, 1, 'another chat keeps its archive');
});

test('subagent context trimming measures characters per token from the provider count', () => {
	const { measuredCharsPerToken, messageChars } = require(OUT + '/core/turn.js');
	assert.equal(messageChars([{ role: 'user', content: 'abcd' }, { role: 'assistant', content: 'ef', toolCalls: [{ id: '1', name: 'x', arguments: '{"a":1}' }] }]), 13);
	assert.equal(measuredCharsPerToken(3000, 1000), 3);
	assert.equal(measuredCharsPerToken(10_000, 1000), 4, 'clamped high');
	assert.equal(measuredCharsPerToken(1000, 1000), 1.5, 'clamped low (dense code, CJK)');
	assert.equal(measuredCharsPerToken(1000, 0), undefined, 'no count, no measure');
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
