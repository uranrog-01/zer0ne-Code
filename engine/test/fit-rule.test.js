'use strict';
// One fit rule for two apps: Models Fit Studio (C#) and this engine answer the cases in
// fixtures/fit-cases.json the same way. scripts are not involved; both suites read the file.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const C = require(path.join(out, 'localCatalog'));
const R = require(path.join(out, 'repoFiles'));
const D = require(path.join(out, 'modelDiscovery'));
const { machineCapacity } = require(path.join(out, 'localModels'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fit-cases.json'), 'utf8'));
const GB = 1e9;
const tests = [], test = (name, run) => tests.push([name, run]);

test('the numbers are the same in both apps', () => {
	assert.deepStrictEqual(cases.constants, { perfect: C.FIT.perfect, good: C.FIT.good, tight: C.FIT.tight, ceiling: C.FIT.ceiling, runtimeGb: C.FIT.runtimeBytes / GB, lightKv: C.FIT.lightKv, longestContext: C.FIT.longest, floorGbPerB: R.FLOOR_GB_PER_B, readingPace: C.FIT.readingPace, sharedSpill: C.FIT.sharedSpill, draftMaxGb: R.DRAFT_MAX_BYTES / GB });
});

test('helper files are told by their names', () => {
	for (const h of cases.helpers) assert.strictEqual(R.helperFile(h.path), h.helper, h.path);
});

test('only the weights are left as the model', () => {
	for (const m of cases.models) assert.deepStrictEqual(R.modelFiles(m.files.map(([name, gb]) => ({ name, sizeBytes: gb * GB })), m.paramsB).map((f) => f.name), m.kept, m.name);
});

test('memory gets its verdict, context and need', () => {
	for (const m of cases.memory) {
		const r = C.fitMemory({ fileBytes: m.fileGb * GB, projectorBytes: m.projectorGb * GB, kvBytesPerToken: m.kvBytesPerToken, maxContext: m.maxContext, fastBytes: m.fastGb * GB, ceilingBytes: m.ceilingGb * GB });
		assert.strictEqual(r.verdict, m.verdict, m.name);
		assert.strictEqual(r.ctx, m.context, m.name);
		assert.ok(Math.abs(r.needBytes / GB - m.needGb) < 0.001, m.name);
	}
	for (const c of cases.cache) assert.strictEqual(Math.round(C.kvBytesPerToken(c.paramsB, c.activeB || undefined)), c.bytesPerToken);
});

test('the recommended build follows one rule', () => {
	for (const c of cases.picks) {
		const got = C.pickBuild(c.builds.map(([quant, sizeGb, verdict, tokS, needGb]) => ({ quant, sizeBytes: sizeGb * GB, rating: { verdict, tokS, needBytes: needGb * GB } })), c.pace);
		assert.strictEqual(got ? got.quant : null, c.pick, c.name);
	}
});

test('ratings use what the computer has; what is free now only stands beside them', () => {
	const GiB = 1024 ** 3;
	const base = C.machineProfile(machineCapacity({ platform: 'win32', cpu: 'CPU', cores: 16, totalMemoryBytes: 32 * GiB, unifiedMemory: false, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)', freeDiskBytes: 300 * GiB }));
	const busy = D.ratedProfile(base, 6 * GiB), idle = D.ratedProfile(base, 30 * GiB);
	assert.strictEqual(busy.fastBytes, base.fastBytes); assert.strictEqual(busy.ceilingBytes, base.ceilingBytes);
	assert.strictEqual(idle.fastBytes, busy.fastBytes, 'opening another app does not change a rating');
	assert.ok(busy.availableFastBytes < 4 * GiB && idle.availableFastBytes === base.fastBytes);
	// The usual Q4 of a 26B model is past this chip's memory and still runs, slower: the answer Models Fit Studio gives too.
	const info = { id: 'unsloth/gemma-4-26B-A4B-it-GGUF', author: 'unsloth', params: 25.2e9, context: 262144, tools: true, vision: true, format: 'gguf', tags: [], downloads: 1, likes: 1 };
	const f = (name, quant, gb, more = {}) => ({ name, quant, sizeBytes: gb * GB, parts: [name], ...more });
	const rated = D.fitHubFiles(info, [f('g-UD-IQ3_XXS.gguf', 'UD-IQ3_XXS', 11.42), f('g-UD-Q4_K_M.gguf', 'UD-Q4_K_M', 16.948), f('mmproj-F16.gguf', 'F16', 1.193, { mmproj: true })], busy);
	const q4 = rated.find((x) => x.name.includes('Q4_K_M'));
	assert.strictEqual(q4.rating.verdict, 'slow'); assert.strictEqual(q4.fit, 'tight');
	const fits = rated.find((x) => x.name.includes('IQ3_XXS')).rating;
	assert.ok(Math.abs(q4.rating.tokS / fits.tokS - C.FIT.sharedSpill * (11.42 / 16.948)) < 0.02, 'past shared graphics memory: the measured share of the speed');
	const dedicated = D.ratedProfile(C.machineProfile(machineCapacity({ platform: 'win32', cpu: 'CPU', cores: 16, totalMemoryBytes: 64 * GiB, unifiedMemory: false, gpuName: 'NVIDIA GeForce RTX 4090', gpuMemoryBytes: 24 * GiB, freeDiskBytes: 300 * GiB })), 40 * GiB, 8 * GiB);
	assert.strictEqual(dedicated.fastBytes, 24 * GiB); assert.ok(dedicated.availableFastBytes < 8 * GiB);
});

test('a draft head is never the recommended build of a repository', () => {
	const GiB = 1024 ** 3;
	const p = D.ratedProfile(C.machineProfile(machineCapacity({ platform: 'win32', cpu: 'CPU', cores: 16, totalMemoryBytes: 32 * GiB, unifiedMemory: false, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)', freeDiskBytes: 300 * GiB })), 30 * GiB);
	const info = { id: 'unsloth/gemma-4-26B-A4B-it-GGUF', author: 'unsloth', params: 25.2e9, context: 262144, tools: true, vision: true, format: 'gguf', tags: [], downloads: 1, likes: 1 };
	const f = (name, quant, gb, more = {}) => ({ name, quant, sizeBytes: gb * GB, parts: [name], ...more });
	// A listing saved before the rule existed still holds the draft heads.
	const files = [f('mtp-gemma-4-26B-A4B-it-Q8_0.gguf', 'Q8_0', 0.462, { parts: ['MTP/mtp-gemma-4-26B-A4B-it-Q8_0.gguf'] }), f('mtp-gemma-4-26B-A4B-it.gguf', 'GGUF', 0.462),
		f('gemma-4-26B-A4B-it-UD-IQ3_S.gguf', 'UD-IQ3_S', 11.29), f('gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', 'UD-Q4_K_M', 16.948), f('gemma-4-26B-A4B-it-Q8_0.gguf', 'Q8_0', 26.86), f('mmproj-F16.gguf', 'F16', 1.193, { mmproj: true })];
	const rated = D.fitHubFiles(info, files, p);
	assert.deepStrictEqual(rated.filter((x) => !x.mmproj).map((x) => x.name), ['gemma-4-26B-A4B-it-UD-IQ3_S.gguf', 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf', 'gemma-4-26B-A4B-it-Q8_0.gguf']);
	assert.strictEqual(rated.find((x) => x.recommended)?.name, 'gemma-4-26B-A4B-it-UD-IQ3_S.gguf');
	assert.strictEqual(rated.find((x) => x.name.includes('Q4_K_M')).rating.verdict, 'slow');
	assert.strictEqual(C.fileForQuant(files, 'Q8_0').name, 'gemma-4-26B-A4B-it-Q8_0.gguf');
});


test('DFlash and DSpark are helpers regardless of size, while integrated MTP models remain models', () => {
 for (const name of ['MiMo-V2.6-Pro-RL-DFlash-Q8_0.gguf', 'dflash-unknown-Q8_0.gguf', 'DSpark-9B-Q8_0.gguf']) {
  assert.equal(R.helperFile(name), true);
  assert.equal(R.helperBySize(name, 8e9), true);
  assert.deepEqual(R.modelFiles([{name, sizeBytes: 8e9}]), []);
 }
 assert.equal(R.helperBySize('Qwen3.8-27B-MTP-Q4_K_M.gguf', 17e9), false);
 const chunks = { name:'Main-MXFP4.gguf', quant:'MXFP4', sizeBytes:1e9, assembly:true };
 assert.equal(C.fileForQuant([chunks], 'MXFP4'), undefined);
});

(async () => {
	let failed = 0;
	for (const [name, run] of tests) {
		try { await run(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
	}
	process.exit(failed ? 1 : 0);
})();
