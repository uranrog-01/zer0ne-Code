'use strict';
// One Suggest rule for zer0ne code and Models Fit Studio: both suites read
// fixtures/suggest-cases.json (Models Fit Studio keeps the other copy in CoreTests).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../out/suggest');
const E = require('../out/speedEstimate');

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'suggest-cases.json'), 'utf8'));
let failed = 0;
const test = (name, fn) => { try { fn(); console.log('ok  ' + name); } catch (e) { failed++; console.error('FAIL ' + name + '\n', e); } };

test('the paces are the same in both apps', () => {
	assert.deepStrictEqual(cases.constants, { comfortPace: S.COMFORT_PACE, readingPace: S.READING_PACE });
});
test('llmfit\'s category comes from the use case and the name', () => {
	for (const c of cases.categories) assert.strictEqual(S.categoryOf(c.name, c.useCase), c.category, c.name);
});
test('the same models are usable', () => {
	for (const u of cases.usable) assert.strictEqual(S.usable(u.origin, u.provider, u.category, u.moe), u.usable, u.origin);
});
test('the same models are suggested', () => {
	for (const p of cases.picks) {
		const rows = p.rows.map(([origin, paramsB, quality, tps, category]) => ({ repo: 'unsloth/' + origin.split('/').pop() + '-GGUF', origin, paramsB, quality,
			sizeGb: Math.round((paramsB * 0.606 + 0.1) * 10) / 10, memGb: Math.round((paramsB * 0.64 + 1.6) * 10) / 10, tpsLow: tps * 0.85, tpsHigh: tps * 1.15, category, released: '2026-01-01' }));
		assert.deepStrictEqual(S.pickSuggestions(rows).map((s) => [s.kind, S.nameOf(s.model)]), p.picks, p.name);
	}
});
test('the same speed estimate as Models Fit Studio', () => {
	for (const c of cases.speed.gpuClass) assert.strictEqual(E.gpuClass(c.name, c.hasGpu, c.unified), c.gpuClass, c.name);
	for (const c of cases.speed.range) assert.deepStrictEqual(E.speedRange(c.raw, c.gpuClass, c.calibration), c.range, JSON.stringify(c));
	for (const c of cases.speed.rawTps) assert.strictEqual(E.rawTps(c.gbPerSec, c.sizeGb), c.rawTps, JSON.stringify(c));
	for (const c of cases.speed.calibration) assert.strictEqual(E.speedCalibration(c.runs.map(([measuredTps, rawTps]) => ({ measuredTps, rawTps }))), c.calibration, JSON.stringify(c.runs));
});
test('llmfit\'s list gives the same rows and the same picks', () => {
	const L = cases.llmfit;
	assert.strictEqual(E.machineGbPerSec(L.models.slice(0, 200)), L.gbPerSec);
	const rows = S.suggestRows(L.models, L.budgetGb, L.gbPerSec, L.gpuClass, L.calibration);
	assert.strictEqual(rows.length, L.rowCount);
	assert.deepStrictEqual(S.pickSuggestions(rows).map((p) => [p.kind, S.nameOf(p.model), p.model.tpsLow, p.model.tpsHigh]), L.picks);
});
test('the shared cases are the same file in both projects', () => {
	const other = path.join(__dirname, '..', '..', '..', 'CoreTests', 'suggest-cases.json');
	if (fs.existsSync(other)) assert.strictEqual(fs.readFileSync(other, 'utf8'), fs.readFileSync(path.join(__dirname, 'fixtures', 'suggest-cases.json'), 'utf8'));
});
console.log(failed ? `\n${failed} SUGGEST TEST(S) FAILED` : '\nALL SUGGEST TESTS PASSED');
process.exitCode = failed ? 1 : 0;
