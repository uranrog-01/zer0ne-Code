// The eval harness, offline: a scripted fake model plays the agent, so the
// grader, sandboxing, case parsing and failure reporting are testable with no
// provider, no network and no keys.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const OUT = process.env.ZER0NE_ENGINE_OUT || path.join(__dirname, '..', 'out');
const { runEval, grade, parseCases, seedProject, summarize, loadCaseDir } = require(OUT + '/eval/harness.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A scripted model: one entry per round-trip; tool calls carry [name, args] pairs. */
function scripted(steps) {
	let i = 0;
	return async () => {
		const s = steps[Math.min(i, steps.length - 1)];
		i++;
		if (typeof s === 'string') return { text: s, reasoning: '', toolCalls: [] };
		return { text: s.text ?? '', reasoning: '', toolCalls: (s.calls ?? []).map((c, j) => ({ id: `c${i}_${j}`, name: c[0], arguments: JSON.stringify(c[1] ?? {}) })) };
	};
}

const provider = { baseUrl: 'http://127.0.0.1:0', apiKey: '', apiFormat: 'openai', model: 'scripted' };

test('runEval: a compliant scripted run passes file and tool expectations', async () => {
	const { report, root } = await runEval(
		{ id: 't-write', prompt: 'make hello.txt', expect: [{ kind: 'file', path: 'hello.txt', contains: 'Hi' }, { kind: 'tool', name: 'write_file', max: 1 }] },
		{ provider, callModel: scripted([{ calls: [['write_file', { path: 'hello.txt', content: 'Hi there' }]] }, 'Done — hello.txt says Hi.']) }
	);
	assert.ok(report.pass, 'passes: ' + JSON.stringify(report.failures));
	assert.equal(report.steps, 2, 'one tool round-trip plus the answer');
	assert.ok(report.text.includes('hello.txt'), 'the report carries the reply text');
	fs.rmSync(root, { recursive: true, force: true });
	assert.ok(!fs.existsSync(root), 'the sandbox folder is removable after runEval');
});

test('runEval: each unmet expectation fails with a reason', async () => {
	const { report } = await runEval(
		{ id: 't-fail', prompt: 'break it', expect: [{ kind: 'file', path: 'gone.txt' }, { kind: 'tool', name: 'grep', min: 1 }, { kind: 'reply', contains: 'ELEPHANT' }] },
		{ provider, callModel: scripted([{ calls: [['write_file', { path: 'other.txt', content: 'x' }]] }, 'nope']) }
	);
	assert.ok(!report.pass, 'a non-compliant run fails');
	assert.equal(report.failures.length, 3, 'all failures listed: ' + JSON.stringify(report.failures));
	assert.ok(report.failures.some((f) => f.includes('gone.txt')), 'missing file reported');
	assert.ok(report.failures.some((f) => f.includes('grep')), 'tool min reported');
	assert.ok(report.failures.some((f) => f.includes('ELEPHANT')), 'reply expectation reported');
});

test('grade: file, steps and absent expectations without a run', () => {
	const root = seedProject({ 'notes/a.md': 'keep me\nalpha\n' });
	try {
		assert.equal(grade({ kind: 'file', path: 'notes/a.md', contains: 'alpha' }, { root, text: '', toolCounts: new Map(), steps: 1 }), null, 'contains holds');
		assert.ok(grade({ kind: 'file', path: 'notes/a.md', matches: 'beta' }, { root, text: '', toolCounts: new Map(), steps: 1 }), 'regex miss reported');
		assert.ok(grade({ kind: 'file', path: 'nope.md' }, { root, text: '', toolCounts: new Map(), steps: 1 }), 'missing file reported');
		assert.equal(grade({ kind: 'file', path: 'nope.md', absent: true }, { root, text: '', toolCounts: new Map(), steps: 1 }), null, 'absent holds');
		assert.ok(grade({ kind: 'steps', max: 3 }, { root, text: '', toolCounts: new Map(), steps: 5 }), 'step budget reported');
		assert.equal(grade({ kind: 'steps', max: 6 }, { root, text: '', toolCounts: new Map(), steps: 5 }), null, 'step budget holds');
		assert.equal(grade({ kind: 'tool', name: 'grep', min: 1 }, { root, text: '', toolCounts: new Map([['grep', 2]]), steps: 1 }), null, 'tool min holds');
		assert.ok(grade({ kind: 'tool', name: 'grep', max: 1 }, { root, text: '', toolCounts: new Map([['grep', 2]]), steps: 1 }), 'tool max reported');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('parseCases: the JSON shape works and malformed input is rejected', () => {
	const list = parseCases(JSON.stringify([{ id: 'a', prompt: 'p', expect: [{ kind: 'reply', contains: 'x' }] }]));
	assert.equal(list.length, 1, 'one parsed case');
	assert.throws(() => parseCases(JSON.stringify([{ prompt: 'no id' }])), /id/, 'missing id is rejected');
	assert.throws(() => parseCases('{broken'), 'broken JSON is rejected');
	assert.throws(() => parseCases(JSON.stringify([{ id: 'b', prompt: 'p', expect: [{ kind: 'file' }] }])), /path/, 'file expectation without a path is rejected');
});

test('the shipped smoke fixture parses', () => {
	const cases = parseCases(fs.readFileSync(path.join(__dirname, '..', 'eval', 'cases', 'smoke.json'), 'utf8'), 'smoke.json');
	assert.ok(cases.length >= 2, 'the smoke fixture holds cases');
	const edit = cases.find((c) => c.id === 'edit-existing');
	assert.ok(edit?.files && edit.files['notes.md'].includes('alpha'), 'seeded files with content');
});

test('runEval: a scripted read-then-edit run edits the seeded file', async () => {
	const { report } = await runEval(
		{ id: 't-edit', prompt: 'swap alpha for beta in notes.md', files: { 'notes.md': 'alpha\n' }, expect: [{ kind: 'file', path: 'notes.md', contains: 'beta', notContains: 'alpha' }] },
		{ provider, callModel: scripted([{ calls: [['read_file', { path: 'notes.md' }]] }, { calls: [['edit_file', { path: 'notes.md', old_string: 'alpha', new_string: 'beta' }]] }, 'Swapped.']) }
	);
	assert.ok(report.pass, 'passes: ' + JSON.stringify(report.failures));
});

test('runEval: a failing model surfaces as a failed report, not a throw', async () => {
	const { report } = await runEval(
		{ id: 't-throw', prompt: 'anything', expect: [] },
		{ provider, callModel: async () => { throw new Error('simulated provider outage'); } }
	);
	assert.ok(!report.pass, 'a throwing run fails');
	assert.ok(report.failures[0].includes('simulated provider outage'), 'the cause is reported');
});

test('runEval: hidden graders arrive after the run and a check script decides', async () => {
	const c = { id: 't-hidden', category: 'bugfix', prompt: 'fix add.js', files: { 'add.js': 'module.exports = (a, b) => a - b;\n' }, hidden: { 'grade.js': "require('assert').strictEqual(require('./add.js')(2, 3), 5);\n" }, expect: [{ kind: 'check', script: 'grade.js' }] };
	let sawGrader = false;
	const play = scripted([{ calls: [['list_files', {}], ['read_file', { path: 'add.js' }]] }, { calls: [['write_file', { path: 'add.js', content: 'module.exports = (a, b) => a + b;\n' }]] }, 'Fixed.']);
	const fixed = await runEval(c, { provider, callModel: (o) => { sawGrader ||= JSON.stringify(o.messages).includes('grade.js'); return play(o); } });
	assert.ok(fixed.report.pass, 'a correct fix passes: ' + JSON.stringify(fixed.report.failures));
	assert.equal(fixed.report.category, 'bugfix');
	assert.equal(fixed.report.toolCalls, 3, 'tool calls are counted');
	fs.rmSync(fixed.root, { recursive: true, force: true });
	const lazy = await runEval(c, { provider, callModel: async () => ({ text: 'Done.', reasoning: '', toolCalls: [] }) });
	assert.ok(!lazy.report.pass && /check grade\.js failed/.test(lazy.report.failures[0]), 'an unfixed project fails the check: ' + JSON.stringify(lazy.report.failures));
	fs.rmSync(lazy.root, { recursive: true, force: true });
	assert.ok(!sawGrader, 'the model never saw the hidden grader');
});

test('summarize: score, categories, tokens, cache and cost', () => {
	const r = (id, category, pass, cost, costKnown = true) => ({ id, category, pass, failures: [], steps: 2, toolCalls: 3, text: '', usage: { input: 100, output: 10, cached: 50 }, cost, costKnown, ms: 1000 });
	const s = summarize([r('a', 'bugfix', true, 0.01), r('b', 'bugfix', false, 0.02), r('c', 'shell', true, 0, false)]);
	assert.equal(s.total, 3); assert.equal(s.passed, 2); assert.ok(Math.abs(s.rate - 2 / 3) < 1e-9);
	assert.deepEqual(s.byCategory, { bugfix: { total: 2, passed: 1 }, shell: { total: 1, passed: 1 } });
	assert.equal(s.cacheRate, 0.5); assert.ok(Math.abs(s.cost - 0.03) < 1e-9); assert.equal(s.costKnown, false);
	assert.equal(summarize([]).rate, 0, 'an empty run scores 0, not NaN');
});

test('the bundled benchmark parses, every case is graded, and graders separate a fix from no fix', () => {
	const dir = path.join(__dirname, '..', 'eval', 'cases');
	const cases = loadCaseDir(dir), ids = new Set();
	const reference = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'eval', 'reference.json'), 'utf8'));
	assert.ok(cases.length >= 30, 'the benchmark holds at least 30 tasks');
	assert.ok(new Set(cases.map((c) => c.category)).size >= 6, 'it covers at least six categories');
	for (const c of cases) {
		assert.ok(!ids.has(c.id), 'duplicate id ' + c.id); ids.add(c.id);
		assert.ok(c.category, c.id + ' has a category');
		assert.ok(c.expect.length, c.id + ' has expectations');
		for (const e of c.expect) if (e.matches) new RegExp(e.matches);
		if (!c.hidden) continue;
		assert.ok(reference[c.id], c.id + ' has a reference fix');
		const seeded = seedProject({ ...c.files, ...c.hidden }), solved = seedProject({ ...c.files, ...reference[c.id], ...c.hidden });
		try {
			const ctx = (root) => ({ root, text: '', toolCounts: new Map(), steps: 1 });
			assert.ok(grade({ kind: 'check', script: 'grade.js' }, ctx(seeded)), c.id + ': the grader passes an unfixed project');
			assert.equal(grade({ kind: 'check', script: 'grade.js' }, ctx(solved)), null, c.id + ': the grader fails the reference fix');
		} finally {
			fs.rmSync(seeded, { recursive: true, force: true });
			fs.rmSync(solved, { recursive: true, force: true });
		}
	}
});

test('grade: a check script outside the project is refused', () => {
	const root = seedProject({});
	try { assert.match(grade({ kind: 'check', script: '../x.js' }, { root, text: '', toolCounts: new Map(), steps: 1 }), /outside/); }
	finally { fs.rmSync(root, { recursive: true, force: true }); }
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
	process.exit(failed ? 1 : 0);
})();
