// Settings → Features → Benchmark: who may start a run, what it records, stopping and clearing.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createShim, install } = require('./vscode-shim');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-bench-'));
install(createShim({ dataDir: path.join(ws, '.data'), workspace: ws }).vscode);
const { BenchmarkHost } = require('../out/host/benchmarkHost');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };

function setup({ mode = 'full', reply = () => '4', busy = () => false } = {}) {
	const storage = fs.mkdtempSync(path.join(ws, 'storage-'));
	const provider = { id: 'p', name: 'Prov', enabled: true, apiFormat: 'openai', baseUrl: 'http://127.0.0.1:0', models: [{ id: 'm', name: 'Model M', enabled: true, contextWindow: 32000 }] };
	const store = { getMode: () => mode, list: async () => [provider], getApiKey: async () => '' };
	const posted = [], statuses = [];
	const ctx = { store, postAll: (m) => posted.push(m), status: (m) => statuses.push(m), sendState: async () => {} };
	const calls = [];
	const host = new BenchmarkHost(ctx, { storage, extension: path.join(__dirname, '..'), busy, callModel: async (_p, _k, o) => { calls.push(o); return { text: reply(o), reasoning: '', toolCalls: [] }; } });
	const sent = [];
	const desktop = { kind: 'webview', post: (m) => sent.push(m) };
	return { host, posted, statuses, calls, sent, desktop, storage };
}

test('the list shows the bundled tasks by category and an empty history', async () => {
	const { host, sent, desktop } = setup();
	assert.equal(await host.handle(desktop, { type: 'benchmarkList' }), true);
	const s = sent.at(-1);
	assert.equal(s.type, 'benchmarkState');
	assert.ok(s.total >= 30);
	assert.ok(s.categories.bugfix >= 5 && s.categories.explore >= 3);
	assert.deepEqual(s.history, []);
	assert.equal(s.running, null);
	assert.equal(await host.handle(desktop, { type: 'somethingElse' }), false);
});

test('runs need the desktop, Full Access, a confirmation, an idle chat and 1–4 known models', async () => {
	const cases = [
		[setup(), { kind: 'remote', post() {} }, { approved: true, models: ['p::m'] }, /desktop/],
		[setup({ mode: 'agent' }), null, { approved: true, models: ['p::m'] }, /Full Access/],
		[setup(), null, { models: ['p::m'] }, /Confirm/],
		[setup({ busy: () => true }), null, { approved: true, models: ['p::m'] }, /Wait for the chat/],
		[setup(), null, { approved: true, models: [] }, /1–4 models/],
		[setup(), null, { approved: true, models: ['p::nope'] }, /unavailable/],
		[setup(), null, { approved: true, models: ['p::m'], categories: ['no-such'] }, /No benchmark tasks/]
	];
	for (const [s, surface, msg, error] of cases) {
		const out = [];
		await s.host.handle(surface ? { ...surface, post: (m) => out.push(m) } : { ...s.desktop, post: (m) => out.push(m) }, { type: 'benchmarkStart', ...msg });
		assert.equal(out.at(-1).type, 'benchmarkError');
		assert.match(out.at(-1).error, error);
		assert.equal(s.calls.length, 0, 'nothing ran');
	}
});

test('a run grades every chosen task, records the scorecard and reports progress', async () => {
	const s = setup();
	await s.host.handle(s.desktop, { type: 'benchmarkStart', approved: true, models: ['p::m'], categories: ['explore'] });
	assert.ok(s.host.busy);
	await until(() => !s.host.busy);
	const progress = s.posted.filter((m) => m.type === 'benchmarkState' && m.running);
	assert.ok(progress.length >= 2 && progress.at(-1).running.done >= 1, 'progress is published while it runs');
	const final = s.posted.at(-1);
	assert.equal(final.running, null);
	const run = final.history[0];
	assert.equal(run.model, 'Model M'); assert.equal(run.provider, 'Prov'); assert.deepEqual(run.categories, ['explore']);
	assert.equal(run.summary.total, run.cases.length);
	assert.ok(run.cases.every((c) => c.category === 'explore'));
	assert.equal(run.cases.find((c) => c.id === 'count-usages').pass, true, 'a correct answer passes');
	assert.equal(run.cases.find((c) => c.id === 'explain-config').pass, false, 'a wrong answer fails');
	assert.ok(run.cases.find((c) => !c.pass).failures.length);
	assert.match(s.statuses.at(-1), /Benchmark finished/);
	assert.ok(fs.existsSync(path.join(s.storage, 'benchmark', 'history.json')));
	const reread = new BenchmarkHost({ store: {}, postAll() {}, status() {}, sendState: async () => {} }, { storage: s.storage, extension: path.join(__dirname, '..'), busy: () => false, callModel: async () => ({}) });
	const out = []; await reread.handle({ kind: 'webview', post: (m) => out.push(m) }, { type: 'benchmarkList' });
	assert.equal(out[0].history[0].id, run.id, 'results survive a restart and are shared by project engines');
	await s.host.handle(s.desktop, { type: 'benchmarkClear' });
	assert.deepEqual(s.posted.at(-1).history, []);
});

test('profiles and repeats are separate scored runs and unsupported settings fail before spending', async () => {
	const s = setup();
	await s.host.handle(s.desktop, { type: 'benchmarkStart', approved: true, models: ['p::m'], categories: ['explore'], profiles: ['current', 'lean'], trials: 3 });
	await until(() => !s.host.busy);
	const history = s.posted.at(-1).history;
	assert.equal(history.length, 2); assert.deepEqual(new Set(history.map(r => r.profile.name)), new Set(['current', 'lean']));
	assert.ok(history.every(r => r.trials === 3 && r.summary.total === r.summary.measurement.cases * 3));
	assert.ok(history.every(r => r.cases.every(c => c.trial >= 1 && c.trial <= 3)));
	await s.host.handle(s.desktop, { type: 'benchmarkApplyProfile', id: history[0].id });
	assert.match(s.sent.at(-1).error, /production run/);
	const count = s.calls.length;
	await s.host.handle(s.desktop, { type: 'benchmarkStart', approved: true, models: ['p::m'], profiles: ['unknown'] });
	assert.match(s.sent.at(-1).error, /known benchmark profiles/); assert.equal(s.calls.length, count);
});

test('stop ends the run after the current task and keeps what finished', async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	const s = setup();
	s.host.d.callModel = async () => { await gate; return { text: '4', reasoning: '', toolCalls: [] }; };
	await s.host.handle(s.desktop, { type: 'benchmarkStart', approved: true, models: ['p::m'], categories: ['explore'] });
	await s.host.handle(s.desktop, { type: 'benchmarkStop' });
	release();
	await until(() => !s.host.busy);
	const run = s.posted.at(-1).history[0];
	assert.ok(!run || run.stopped, 'a stopped run is marked stopped');
	assert.match(s.statuses.at(-1), /stopped/);
	assert.ok(!run || run.cases.length < 5, 'it did not run every task');
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
	console.log(`\n${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
