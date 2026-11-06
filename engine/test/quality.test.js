'use strict';
// The quality test: the same questions and marking as Models Fit Studio (fixtures/quality-cases.json),
// and a run against a mock server.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const Q = require(path.join(out, 'localQuality'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'quality-cases.json'), 'utf8'));
const tests = [], test = (name, run) => tests.push([name, run]);

test('the questions are the same in both apps', () => {
	assert.strictEqual(Q.QUALITY_ENDING, cases.ending);
	assert.deepStrictEqual(Q.QUALITY_QUESTIONS.map((q) => ({ ...q })), cases.questions);
	assert.strictEqual(Q.QUALITY_QUESTIONS.length, 40);
	const perSkill = {};
	for (const q of Q.QUALITY_QUESTIONS) perSkill[q.skill] = (perSkill[q.skill] || 0) + 1;
	assert.deepStrictEqual(Object.values(perSkill), [8, 8, 8, 8, 8]);
});

test('every question accepts its own answer and replies are marked as in the other app', () => {
	for (const q of Q.QUALITY_QUESTIONS) assert.ok(Q.gradeAnswer(q, q.answer), q.prompt);
	for (const g of cases.grading) assert.strictEqual(Q.gradeAnswer(g, g.reply), g.right, `${g.kind} ${g.answer}: ${g.reply}`);
});

test('a run asks every question once, counts per skill and reports its progress', async () => {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const input = JSON.parse(body);
			seen.push(input);
			const prompt = input.messages[0].content;
			const q = Q.QUALITY_QUESTIONS.find((x) => prompt === x.prompt + Q.QUALITY_ENDING);
			// Right on reasoning and math, wrong on the rest.
			const right = q && (q.skill === 'Reasoning' || q.skill === 'Math');
			res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'Thinking.\nFinal answer: ' + (right ? q.answer : 'no idea') } }] }));
		});
	});
	server.keepAliveTimeout = 0;
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const stages = [];
	try {
		const r = await Q.qualityTest(`http://127.0.0.1:${server.address().port}/v1`, 'fixture', { backend: 'mock', onStage: (s) => stages.push(s) });
		assert.strictEqual(r.total, 40); assert.strictEqual(r.correct, 16); assert.strictEqual(r.score, 40); assert.strictEqual(r.error, undefined);
		assert.deepStrictEqual(r.parts, { Reasoning: 8, Math: 8, Knowledge: 0, Instructions: 0, Code: 0 });
		assert.deepStrictEqual(Object.values(r.of), [8, 8, 8, 8, 8]);
		assert.strictEqual(seen.length, 40);
		assert.ok(seen.every((x) => x.model === 'fixture' && x.temperature === 0 && x.max_tokens === 320 && x.chat_template_kwargs.enable_thinking === false));
		assert.strictEqual(stages[0], 'Question 1 of 40…'); assert.strictEqual(stages.length, 40);
	} finally { await new Promise((r) => server.close(r)); }
});

test('a server that stops answering ends the test with an error, not a score of zero', async () => {
	const server = http.createServer((req, res) => { req.resume(); req.on('end', () => res.writeHead(500).end('down')); });
	server.keepAliveTimeout = 0;
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const r = await Q.qualityTest(`http://127.0.0.1:${server.address().port}/v1`, 'fixture');
		assert.ok(/HTTP 500/.test(r.error)); assert.strictEqual(r.correct, 0);
	} finally { await new Promise((r) => server.close(r)); }
});

test('the battle is saved as plain fighters: real repositories, sane text and numbers, four at most', () => {
	const { battleFighters } = require(path.join(out, 'host', 'localPlus'));
	const saved = battleFighters([{ repo: 'a/b', name: 'x', verdict: 'good', tokS: 12, util: 0.5, quality: 900, extra: {} }, { repo: '../evil' }, null, { repo: 'c/d', verdict: 'weird', tokS: -1 }, { repo: 'e/f' }, { repo: 'g/h' }, { repo: 'i/j' }]);
	assert.deepStrictEqual(saved.map((f) => f.repo), ['a/b', 'c/d', 'e/f', 'g/h']);
	assert.deepStrictEqual(saved[0], { repo: 'a/b', name: 'x', file: '', quant: '', reason: '', verdict: 'good', sizeBytes: 0, needBytes: 0, util: 0.5, ctx: 0, tokS: 12, quality: 100 });
	assert.strictEqual(saved[1].verdict, 'no'); assert.strictEqual(saved[1].tokS, 0);
	assert.deepStrictEqual(battleFighters('nope'), []);
});

(async () => {
	let failed = 0;
	for (const [name, run] of tests) {
		try { await run(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
	}
	process.exit(failed ? 1 : 0);
})();
