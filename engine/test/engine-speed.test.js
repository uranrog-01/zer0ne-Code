'use strict';
// What makes a loaded model faster: the attention mode, the device and attention the tuner tries,
// the draft head beside a model, and the header read from Hugging Face before a download.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { fitModel, parseModelShape, readModelShape, prefersPlainAttention } = require(path.join(out, 'modelFit'));
const { applyTuning, tuneCandidates, tuneModel, tuneLabel, probeModelSpeed } = require(path.join(out, 'localTune'));
const { machineCapacity } = require(path.join(out, 'localModels'));
const { moeInfo, planTurbo } = require(path.join(out, 'turboFit'));
const { draftHeadName, helperFile, modelFiles } = require(path.join(out, 'repoFiles'));
const tests = [], test = (name, run) => tests.push([name, run]);
const GiB = 1024 ** 3;

const machine = (o = {}) => machineCapacity({ platform: 'win32', cpu: 'Core Ultra 9 285H', cores: 16, totalMemoryBytes: 32 * GiB, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)', unifiedMemory: false, ...o });
const input = (o = {}) => ({ name: 'Coder-7B', sizeBytes: 4 * GiB, machine: machine(), freeMemoryBytes: 24 * GiB, context: 16384, lightKv: true, shape: { kvBytesPerToken: 131072, layers: 28 }, ...o });

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
/** A GGUF header from key/value pairs (strings and 32-bit numbers), with padding standing in for the tensors. */
const gguf = (pairs, padding = 0) => Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(pairs.length), ...pairs.map(([k, v]) => Buffer.concat([str(k), u32(typeof v === 'string' ? 8 : 4), typeof v === 'string' ? str(v) : u32(v)])), Buffer.alloc(padding)]);
const MODEL = [['general.architecture', 'gemma4'], ['gemma4.block_count', 42], ['gemma4.context_length', 131072], ['gemma4.embedding_length', 2560], ['gemma4.attention.head_count', 8], ['gemma4.attention.head_count_kv', 2], ['gemma4.attention.key_length', 256], ['gemma4.attention.value_length', 256]];
const HEAD = [['general.architecture', 'gemma4-assistant'], ['gemma4-assistant.block_count', 4], ['gemma4-assistant.context_length', 131072], ['gemma4-assistant.embedding_length', 256], ['gemma4-assistant.attention.head_count', 4], ['gemma4-assistant.nextn_predict_layers', 4]];

test('plain attention is the default only where it was measured faster, and never costs context', () => {
	for (const arch of ['qwen2', 'qwen3', 'qwen35']) assert.ok(prefersPlainAttention(machine(), 'vulkan', arch), arch);
	// Gemma 4 read its first prompt faster with plain attention and then waited twice as long on every turn.
	for (const arch of ['gemma4', 'qwen35moe', 'llama', undefined]) assert.ok(!prefersPlainAttention(machine(), 'vulkan', arch), String(arch));
	assert.ok(!prefersPlainAttention(machine(), 'cpu', 'qwen3'));
	assert.ok(!prefersPlainAttention(machine({ gpuName: 'NVIDIA GeForce RTX 4060', gpuMemoryBytes: 8 * GiB }), 'vulkan', 'qwen3'), 'a card with its own memory keeps the engine default');
	assert.ok(!prefersPlainAttention(machine({ platform: 'darwin', gpuName: 'Apple M3', unifiedMemory: true }), 'metal', 'qwen3'));
	const compact = fitModel(input()), plain = fitModel(input({ plainAttention: true }));
	assert.strictEqual(compact.kv, 'q8_0'); assert.strictEqual(compact.flash, undefined);
	assert.strictEqual(plain.kv, 'f16'); assert.strictEqual(plain.flash, false);
	assert.strictEqual(plain.context, compact.context); assert.ok(plain.memoryBytes > compact.memoryBytes);
	// When the 16-bit cache would not fit fast memory, the compact cache and its context stay.
	const big = fitModel(input({ sizeBytes: 12 * GiB, shape: { kvBytesPerToken: 262144, layers: 40 }, plainAttention: true }));
	assert.strictEqual(big.kv, 'q8_0'); assert.strictEqual(big.flash, undefined);
	assert.strictEqual(fitModel(input({ plainAttention: true, cpu: true })).flash, undefined, 'the processor is not what was measured');
	assert.strictEqual(fitModel(input({ plainAttention: true, turbo: true })).flash, undefined, 'Turbo Fit asks for the compact cache');
});

test('the engine starts plain attention with the 16-bit cache, and a retry for memory goes back to the compact one', () => {
	const { EngineServer } = require(path.join(out, 'localEngine'));
	const fit = fitModel(input({ plainAttention: true }));
	const o = { context: fit.context, gpu: 'auto', lightKv: true, port: 8181, fitMarginMiB: 1024, cacheRamMiB: 64, fit };
	const model = { id: 'test', path: 'test.gguf', sizeBytes: 10 };
	const first = new EngineServer(() => {}).args(model, o, 0), retry = new EngineServer(() => {}).args(model, o, 1);
	assert.strictEqual(first[first.indexOf('-fa') + 1], 'off'); assert.strictEqual(first[first.indexOf('-ctk') + 1], 'f16'); assert.strictEqual(first[first.indexOf('-ctv') + 1], 'f16');
	assert.ok(!retry.includes('-fa')); assert.strictEqual(retry[retry.indexOf('-ctk') + 1], 'q8_0');
	const fallback = new EngineServer(() => {}).args(model, { ...o, cacheFallback: true, fit: { ...fit, flash: undefined, kv: 'q8_0' } }, 0);
	assert.ok(!fallback.includes('-fa'));
	// A measured "processor only" keeps every layer off the graphics chip, and drops the draft head with it.
	const extra = ['--spec-type', 'draft-mtp,ngram-mod', '--spec-ngram-mod-n-min', '8', '--spec-draft-model', 'mtp.gguf'];
	const cpu = new EngineServer(() => {}).args(model, { ...o, fit: { ...fit, cpu: true }, extra }, 0);
	assert.strictEqual(cpu[cpu.indexOf('-ngl') + 1], '0'); assert.ok(!cpu.includes('--spec-draft-model')); assert.strictEqual(cpu[cpu.indexOf('--spec-type') + 1], 'ngram-mod');
	const gpu = new EngineServer(() => {}).args(model, { ...o, extra }, 0);
	assert.strictEqual(gpu[gpu.indexOf('--spec-draft-model') + 1], 'mtp.gguf'); assert.strictEqual(gpu[gpu.indexOf('--spec-type') + 1], 'draft-mtp,ngram-mod'); assert.ok(!gpu.includes('-ngl'));
	assert.ok(!new EngineServer(() => {}).args(model, { ...o, extra }, 1).includes('--spec-draft-model'), 'a retry drops the extras');
});

test('a load that fails with the draft head is tried once more without it', async () => {
	const { EngineServer, withoutDraftHead } = require(path.join(out, 'localEngine'));
	assert.deepStrictEqual(withoutDraftHead(['--spec-type', 'draft-mtp', '--spec-draft-model', 'x.gguf', '-v']), ['-v']);
	assert.deepStrictEqual(withoutDraftHead(undefined), []);
	const { draftsAhead } = require(path.join(out, 'localEngine'));
	assert.ok(draftsAhead(['--spec-type', 'draft-mtp,ngram-mod'])); assert.ok(!draftsAhead(['--spec-type', 'ngram-mod'])); assert.ok(!draftsAhead(undefined));
	// A build that drafts for itself has no second file: the retry still drops the request to draft.
	const alone = new EngineServer(() => {}), tries = []; alone.readCtx = async () => 8192;
	alone.launch = async (_exe, model, options, attempt) => { tries.push(alone.args(model, options, attempt)); if (tries.length === 1) { alone.log = 'error: failed to create MTP draft context'; throw Error(alone.log); } };
	await alone.ensure('runner', { id: 'test', path: 'model.gguf', sizeBytes: 1 }, { context: 8192, gpu: 'auto', lightKv: true, port: 8181, cacheRamMiB: 64, fitMarginMiB: 1024, extra: ['--spec-type', 'draft-mtp,ngram-mod'] });
	assert.strictEqual(tries.length, 2); assert.strictEqual(tries[1][tries[1].indexOf('--spec-type') + 1], 'ngram-mod'); assert.strictEqual(alone.run.draft, undefined);
	const server = new EngineServer(() => {}), launches = [];
	server.readCtx = async () => 8192;
	server.launch = async (_exe, model, options, attempt) => {
		launches.push(server.args(model, options, attempt));
		if (launches.length === 1) { server.log = 'error: draft model is not compatible with the target model'; throw Error(server.log); }
	};
	await server.ensure('runner', { id: 'test', path: 'model.gguf', sizeBytes: 1 }, { context: 8192, gpu: 'auto', lightKv: true, port: 8181, cacheRamMiB: 64, fitMarginMiB: 1024, extra: ['--spec-type', 'draft-mtp,ngram-mod', '--spec-draft-model', 'mtp.gguf'] });
	assert.strictEqual(launches.length, 2);
	assert.ok(launches[0].includes('--spec-draft-model')); assert.ok(!launches[1].includes('--spec-draft-model')); assert.ok(launches[1].includes('ngram-mod'));
	assert.strictEqual(server.run.draft, undefined); assert.strictEqual(server.run.attempt, 0);
	const fine = new EngineServer(() => {}); fine.readCtx = async () => 8192; fine.launch = async () => {};
	await fine.ensure('runner', { id: 'test', path: 'model.gguf', sizeBytes: 1 }, { context: 8192, gpu: 'auto', lightKv: true, port: 8181, cacheRamMiB: 64, fitMarginMiB: 1024, extra: ['--spec-type', 'draft-mtp', '--spec-draft-model', 'mtp.gguf'] });
	assert.strictEqual(fine.run.draft, true);
});

test('the tuner tries the other attention mode and the processor, and stores what it kept', async () => {
	const plan = fitModel(input({ plainAttention: true }));
	const other = { attention: { kv: 'q8_0', flash: true }, cpuThreads: 8 };
	const list = tuneCandidates(plan, other);
	assert.strictEqual(list.length, 5);
	assert.deepStrictEqual(list[0], { threads: plan.threads, ubatch: plan.ubatch, kv: 'f16', flash: false });
	assert.deepStrictEqual(list[3], { threads: plan.threads, ubatch: plan.ubatch, kv: 'q8_0', flash: true });
	assert.deepStrictEqual(list[4], { threads: 8, ubatch: plan.ubatch, kv: 'f16', flash: false, cpu: true });
	assert.strictEqual(tuneCandidates(plan).length, 3, 'nothing else to try on a machine without a choice');
	assert.strictEqual(tuneLabel(list[3], list[0]), 'flash attention'); assert.strictEqual(tuneLabel(list[4], list[0]), 'processor only'); assert.strictEqual(tuneLabel(list[0], list[0]), 'automatic settings');

	let current; const stages = [];
	const run = (speed, p = plan, o = other) => tuneModel(p, { other: o, stage: (s) => stages.push(s), start: async (c) => { current = c; }, probe: async () => speed(current) });
	// The numbers measured on the Arc 140T with a 9,000-token prompt: flash attention reads at 348, plain at 631.
	const compact = fitModel(input());
	const toPlain = await run((c) => (c.cpu ? { tokS: 9.7, promptTokS: 231 } : c.flash === false ? { tokS: 27.5, promptTokS: 631 } : { tokS: 26.5, promptTokS: 348 }), compact, { attention: { kv: 'f16', flash: false }, cpuThreads: 8 });
	assert.strictEqual(toPlain.flash, false); assert.strictEqual(toPlain.kv, 'f16'); assert.strictEqual(toPlain.kept, 'plain attention'); assert.ok(toPlain.gain > 1.2);
	assert.ok(stages.some((s) => /plain attention/.test(s)) && stages.some((s) => /processor only/.test(s)));
	const tunedPlan = applyTuning(compact, toPlain, 16);
	assert.strictEqual(tunedPlan.kv, 'f16'); assert.strictEqual(tunedPlan.flash, false);
	// A processor that writes faster but reads far slower is not kept: an agent reads more than it writes.
	const cpuFastWrite = await run((c) => (c.cpu ? { tokS: 13, promptTokS: 164 } : { tokS: 7.7, promptTokS: 283 }));
	assert.strictEqual(cpuFastWrite.cpu, undefined); assert.strictEqual(cpuFastWrite.gain, 1);
	// A processor that is faster at both is.
	const cpuWins = await run((c) => (c.cpu ? { tokS: 14, promptTokS: 300 } : { tokS: 8, promptTokS: 280 }));
	assert.strictEqual(cpuWins.cpu, true); assert.strictEqual(cpuWins.kept, 'processor only');
	const onCpu = applyTuning(plan, cpuWins, 16);
	assert.strictEqual(onCpu.cpu, true); assert.strictEqual(onCpu.threads, 8); assert.strictEqual(onCpu.cpuExpertLayers, 0);
	// From plain attention back to flash, when that is what the machine prefers.
	const toFlash = await run((c) => (c.cpu ? { tokS: 1, promptTokS: 10 } : c.flash === false ? { tokS: 20, promptTokS: 200 } : { tokS: 21, promptTokS: 400 }));
	assert.strictEqual(toFlash.flash, true); assert.strictEqual(toFlash.kept, 'flash attention');
	const back = applyTuning(plan, toFlash, 16); assert.strictEqual(back.kv, 'q8_0'); assert.strictEqual(back.flash, undefined);
	// Measured on Gemma 4 E4B: plain attention reads the first prompt twice as fast and then makes every
	// follow-up turn wait twice as long. That is not kept, whatever the first read gains.
	const gemma = await run((c) => (c.cpu ? { tokS: 5, promptTokS: 90, turnS: 9 } : c.flash === false ? { tokS: 18.5, promptTokS: 401, turnS: 7.7 } : { tokS: 16.3, promptTokS: 188, turnS: 4.1 }), compact, { attention: { kv: 'f16', flash: false }, cpuThreads: 8 });
	assert.strictEqual(gemma.flash, true); assert.strictEqual(gemma.kept, 'automatic settings'); assert.strictEqual(gemma.gain, 1); assert.strictEqual(gemma.speed.turnS, 4.1);
	// Measured on Qwen3 1.7B: faster at the first read and at every turn. Kept.
	const qwen = await run((c) => (c.cpu ? { tokS: 9, promptTokS: 200, turnS: 4 } : c.flash === false ? { tokS: 32, promptTokS: 1177, turnS: 0.75 } : { tokS: 32, promptTokS: 616, turnS: 1.75 }), compact, { attention: { kv: 'f16', flash: false }, cpuThreads: 8 });
	assert.strictEqual(qwen.flash, false); assert.strictEqual(qwen.kept, 'plain attention'); assert.ok(qwen.gain > 1.15); assert.strictEqual(qwen.speed.turnS, 0.75);
	// A stored result that names an attention mode without its cache is not applied half-way.
	assert.strictEqual(applyTuning(compact, { threads: 4, ubatch: 512, flash: false }, 16).flash, undefined);
});

test('the speed probe asks for the prompt length the tuner wants', async () => {
	const previous = global.fetch, prompts = [];
	try {
		const bodies = [];
		global.fetch = async (_url, o) => {
			const b = JSON.parse(o.body); bodies.push(b); prompts.push(b.messages[0].content);
			// the first read of a conversation, then its follow-up turn
			const turn = b.messages.length > 1;
			return { ok: true, json: async () => ({ choices: [{ message: { content: 'A review.' } }], timings: turn ? { predicted_n: 96, predicted_per_second: 30, prompt_per_second: 150, prompt_ms: 2500 } : { predicted_n: 96, predicted_per_second: 40, prompt_per_second: 200, prompt_ms: 30000 } }) };
		};
		const signal = new AbortController().signal;
		const speed = await probeModelSpeed('http://127.0.0.1:8181', 'm', signal);
		assert.deepStrictEqual(speed, { tokS: 35, promptTokS: 200, turnS: 2.5 }, 'reading speed from the first read, the wait from the follow-up turn');
		await probeModelSpeed('http://127.0.0.1:8181', 'm', signal, 6000); await probeModelSpeed('http://127.0.0.1:8181', 'm', signal, 9e9);
		const count = (p) => (p.match(/export function/g) || []).length;
		assert.strictEqual(count(prompts[0]), 24); assert.strictEqual(count(prompts[2]), 171); assert.strictEqual(count(prompts[4]), 400);
		assert.strictEqual(bodies.length, 6);
		assert.deepStrictEqual(bodies[1].messages.map((m) => m.role), ['user', 'assistant', 'user']); assert.strictEqual(bodies[1].messages[1].content, 'A review.');
		assert.strictEqual(bodies[0].cache_prompt, false); assert.strictEqual(bodies[1].cache_prompt, true);
		assert.ok(bodies.every((b) => b.prompt === undefined && b.chat_template_kwargs.enable_thinking === false));
	} finally { global.fetch = previous; }
});

test('a draft head is told by its own header, on disk and in a model folder', () => {
	const { findDraftHead, scanGguf } = require(path.join(out, 'localEngine'));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-'));
	const previous = process.env.ZER0NE_MODELFIT_DIR; process.env.ZER0NE_MODELFIT_DIR = '';
	try {
		const repo = path.join(dir, 'unsloth', 'gemma-4-E4B-it-GGUF'); fs.mkdirSync(repo, { recursive: true });
		fs.writeFileSync(path.join(repo, 'gemma-4-E4B-it-Q4_K_M.gguf'), gguf(MODEL, 4096));
		fs.writeFileSync(path.join(repo, 'mtp-gemma-4-E4B-it.gguf'), gguf(HEAD, 512));
		fs.writeFileSync(path.join(repo, 'mtp-gemma-4-E4B-it-BF16.gguf'), gguf(HEAD, 2048));
		// Named like a head, but its header says it is an ordinary model: not used as one.
		fs.writeFileSync(path.join(repo, 'mtp-fake.gguf'), gguf(MODEL, 16));
		assert.strictEqual(readModelShape(path.join(repo, 'mtp-gemma-4-E4B-it.gguf')).draft, true);
		assert.strictEqual(readModelShape(path.join(repo, 'gemma-4-E4B-it-Q4_K_M.gguf')).draft, undefined);
		assert.strictEqual(readModelShape(path.join(repo, 'gemma-4-E4B-it-Q4_K_M.gguf')).kvBytesPerToken, 2 * 42 * 2 * 512);
		assert.strictEqual(path.basename(findDraftHead(repo)), 'mtp-gemma-4-E4B-it.gguf', 'the smallest real head');
		const found = scanGguf(dir).filter((g) => g.source === 'zer0ne');
		assert.deepStrictEqual(found.map((g) => g.id), ['gemma-4-E4B-it-Q4_K_M'], 'heads are never models');
		assert.strictEqual(path.basename(found[0].draft), 'mtp-gemma-4-E4B-it.gguf');
		assert.strictEqual(findDraftHead(path.join(dir, 'nowhere')), undefined);
		// A full model that carries next-token layers inside is still a model.
		const inside = parseModelShape(gguf([['general.architecture', 'qwen35'], ['qwen35.block_count', 25], ['qwen35.nextn_predict_layers', 1]]));
		assert.strictEqual(inside.draft, undefined); assert.strictEqual(inside.mtp, true, 'it drafts for itself');
		assert.strictEqual(readModelShape(path.join(repo, 'gemma-4-E4B-it-Q4_K_M.gguf')).mtp, undefined); assert.strictEqual(readModelShape(path.join(repo, 'mtp-gemma-4-E4B-it.gguf')).mtp, undefined);
		// In the list, a build is opened for this only when its name or folder says MTP.
		const twin = path.join(dir, 'unsloth', 'Qwen3.5-2B-MTP-GGUF'); fs.mkdirSync(twin, { recursive: true });
		fs.writeFileSync(path.join(twin, 'Qwen3.5-2B-Q4_K_M.gguf'), gguf([['general.architecture', 'qwen35'], ['qwen35.block_count', 25], ['qwen35.nextn_predict_layers', 1]], 64));
		const listed = scanGguf(dir).find((g) => g.id === 'Qwen3.5-2B-Q4_K_M');
		assert.strictEqual(listed.mtp, true); assert.strictEqual(listed.draft, undefined); assert.strictEqual(found[0].mtp, undefined);
		assert.deepStrictEqual(parseModelShape(Buffer.from('not a model')), {});
		// A header cut short still gives what was read.
		const whole = gguf(MODEL); assert.strictEqual(parseModelShape(whole.subarray(0, whole.length - 20)).layers, 42);
	} finally { if (previous === undefined) delete process.env.ZER0NE_MODELFIT_DIR; else process.env.ZER0NE_MODELFIT_DIR = previous; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('names: a draft head is a helper, and only "mtp" nominates one', () => {
	for (const f of ['mtp-gemma-4-E4B-it.gguf', 'MTP/mtp-gemma-4-26B-A4B-it-Q8_0.gguf', 'model.mtp.gguf']) { assert.ok(draftHeadName(f), f); assert.ok(helperFile(f), f); }
	for (const f of ['gemma-4-E4B-it-Q4_K_M.gguf', 'mmproj-mtp-F16.gguf', 'Qwen3.8-27B-MTPish-Q4.gguf', undefined]) assert.ok(!draftHeadName(f), String(f));
	assert.deepStrictEqual(modelFiles([{ name: 'a-Q4_K_M.gguf', sizeBytes: 5e9 }, { name: 'mtp-a.gguf', sizeBytes: 1e8 }], 7.5).map((f) => f.name), ['a-Q4_K_M.gguf']);
});

test('the header and the draft head are read from Hugging Face with one small request each', async () => {
	const requests = [];
	const body = { 'gemma-4-E4B-it-Q4_K_M.gguf': gguf(MODEL, 3 * 1024 * 1024), 'mtp-gemma-4-E4B-it.gguf': gguf(HEAD, 4096), 'mtp-not-a-head.gguf': gguf(MODEL, 64) };
	const tree = [
		{ type: 'file', path: 'gemma-4-E4B-it-Q4_K_M.gguf', size: 5e9, lfs: { size: 5e9, oid: 'a'.repeat(64) } },
		{ type: 'file', path: 'gemma-4-E4B-it-Q8_0.gguf', size: 8e9, lfs: { size: 8e9, oid: 'b'.repeat(64) } },
		{ type: 'file', path: 'mmproj-F16.gguf', size: 9e8, lfs: { size: 9e8, oid: 'c'.repeat(64) } },
		{ type: 'file', path: 'mtp-not-a-head.gguf', size: 5e7, lfs: { size: 5e7, oid: 'd'.repeat(64) } },
		{ type: 'file', path: 'mtp-gemma-4-E4B-it.gguf', size: 1e8, lfs: { size: 1e8, oid: 'e'.repeat(64) } },
		{ type: 'file', path: 'imatrix.gguf', size: 1e6, lfs: { size: 1e6, oid: 'f'.repeat(64) } }
	];
	const server = http.createServer((req, res) => {
		requests.push({ url: req.url, range: req.headers.range });
		if (req.url.startsWith('/api/models/unsloth/gemma-4-E4B-it-GGUF/tree/')) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(tree));
		const file = body[decodeURIComponent(req.url.split('/').pop())];
		if (!file) return res.writeHead(404).end();
		const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
		// One of the files is served whole, as a server that ignores ranges would: the reader must stop by itself.
		if (!m || req.url.includes('mtp-not-a-head')) return res.writeHead(200).end(file);
		res.writeHead(206, { 'Content-Range': `bytes ${m[1]}-${m[2]}/${file.length}` }).end(file.subarray(Number(m[1]), Number(m[2]) + 1));
	});
	server.keepAliveTimeout = 0;
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shape-'));
	const previous = process.env.HF_ENDPOINT; process.env.HF_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
	try {
		// The endpoint is read when the module loads its helpers, so load a fresh copy for this server.
		for (const k of Object.keys(require.cache)) if (k.startsWith(path.resolve(out))) delete require.cache[k];
		const { hfFiles, hfModelShape } = require(path.join(out, 'localEngine'));
		const { ModelDiscovery, fitHubFiles } = require(path.join(out, 'modelDiscovery'));
		const { machineProfile } = require(path.join(out, 'localCatalog'));
		const repo = 'unsloth/gemma-4-E4B-it-GGUF';
		const plain = await hfFiles(repo);
		assert.deepStrictEqual(plain.map((f) => f.name), ['gemma-4-E4B-it-Q4_K_M.gguf', 'gemma-4-E4B-it-Q8_0.gguf', 'mmproj-F16.gguf'], 'heads are not listed unless asked for');
		const withHeads = await hfFiles(repo, undefined, true);
		assert.deepStrictEqual(withHeads.filter((f) => f.draft).map((f) => f.name), ['mtp-not-a-head.gguf', 'mtp-gemma-4-E4B-it.gguf']);
		assert.ok(!withHeads.some((f) => /imatrix/.test(f.name)));

		const shape = await hfModelShape(repo, 'gemma-4-E4B-it-Q4_K_M.gguf');
		assert.strictEqual(shape.layers, 42); assert.strictEqual(shape.kvBytesPerToken, 2 * 42 * 2 * 512); assert.strictEqual(shape.context, 131072); assert.strictEqual(shape.arch, 'gemma4');
		assert.strictEqual(requests.at(-1).range, 'bytes=0-1048575', 'a megabyte, not the model');

		const m = machineCapacity({ platform: 'win32', cpu: 'x', cores: 16, totalMemoryBytes: 32 * GiB, gpuName: 'Intel Arc 140T', unifiedMemory: false });
		const discovery = new ModelDiscovery(dir, () => m, () => machineProfile(m));
		const info = { id: repo, author: 'unsloth', params: 7.5e9, context: 8192, format: 'gguf', tags: ['gguf'], downloads: 1, likes: 0 };
		const files = await discovery.files(repo, info);
		assert.ok(files.every((f) => !f.draft) && files.length === 3, 'builds and the projector only');
		const head = await discovery.draftHead(repo, info);
		assert.strictEqual(head.name, 'mtp-gemma-4-E4B-it.gguf', 'the file that says it is a head, not the one only named like it');
		const before = requests.length;
		assert.strictEqual((await discovery.draftHead(repo, info)).name, 'mtp-gemma-4-E4B-it.gguf'); assert.strictEqual(requests.length, before, 'read once, then remembered');
		// The header replaces the estimate: the cache size and the longest context are the file's own.
		const read = await discovery.shape(repo, files[0]);
		const estimated = fitHubFiles(info, files, machineProfile(m)).find((f) => f.quant === 'Q4_K_M').rating;
		const exact = fitHubFiles(info, files, machineProfile(m), undefined, undefined, read).find((f) => f.quant === 'Q4_K_M').rating;
		assert.strictEqual(estimated.ctx, 8192); assert.strictEqual(exact.ctx, 32768, 'the file allows a longer context than the listing said');
		assert.notStrictEqual(exact.needBytes, estimated.needBytes);
		// A repository without a head, or an unreachable one, is no error.
		assert.strictEqual(await discovery.draftHead('nobody/none-GGUF', { ...info, id: 'nobody/none-GGUF' }), undefined);
		discovery.dispose();
	} finally {
		if (previous === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = previous;
		for (const k of Object.keys(require.cache)) if (k.startsWith(path.resolve(out))) delete require.cache[k];
		await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a distill is not a mixture of experts, and shared graphics memory gets no split advice', () => {
	assert.deepStrictEqual(moeInfo('bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF', 9e9), { moe: false });
	assert.strictEqual(moeInfo('XiaomiMiMo/MiMo-V2-Flash', 309e9).moe, true);
	assert.strictEqual(moeInfo('unsloth/Qwen3.6-35B-A3B-GGUF', 35e9).active, 3e9);
	const shared = planTurbo({ name: 'Dense-32B', sizeBytes: 19e9, params: 32e9, machine: machine() });
	assert.strictEqual(shared.tier, 'ram'); assert.ok(!/split|GPU \+ RAM/i.test(shared.label), shared.label); assert.match(shared.label, /runs slower/);
	assert.ok(shared.notes.some((n) => /smaller build/.test(n)));
	const own = planTurbo({ name: 'Dense-32B', sizeBytes: 19e9, params: 32e9, machine: machine({ gpuName: 'NVIDIA GeForce RTX 4060', gpuMemoryBytes: 8 * GiB }) });
	assert.strictEqual(own.label, 'Split GPU + RAM');
});


test('draft architectures cannot become standalone models after renaming, and load errors are not assumed to be memory', async () => {
 const { EngineServer, scanGguf, modelLoadFailure } = require(path.join(out, 'localEngine'));
 assert.match(modelLoadFailure('E error loading model: unknown model architecture dflash\nE cleanup failed\nE failed to load model'), /unknown model architecture dflash/);
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dflash-safety-'));
 try {
  const file = path.join(dir,'renamed.gguf');
  fs.writeFileSync(file, gguf([['general.architecture','dflash'], ['dflash.block_count',5], ['dflash.context_length',1048576]]));
  assert.equal(readModelShape(file).draft, true);
  assert.equal(scanGguf(dir).some(m=>m.path===file), false);
  assert.equal(scanGguf(dir,true).find(m=>m.path===file).helper, true);
  const server = new EngineServer(()=>{}); let launches = 0;
  server.launch = async()=>{ launches++; throw Error('must not launch'); };
  await assert.rejects(server.ensure('runner',{id:'renamed',path:file,sizeBytes:fs.statSync(file).size},{gpu:'auto'}), /helper file.*not a standalone/);
  assert.equal(launches,0);
  const bad = new EngineServer(()=>{});
  bad.launch=async()=>{ launches++; bad.log='error: unknown model architecture\nerror: failed to load model'; throw Error(bad.log); };
  await assert.rejects(bad.ensure('runner',{id:'bad',path:'missing-fixture.gguf',sizeBytes:1},{gpu:'auto'}),e=> /unknown model architecture/.test(e.message) && !/does not fit/.test(e.message));
  assert.equal(launches,1,'unsupported formats do not trigger CPU/memory retries');
  const oom = new EngineServer(()=>{}); let retries=0;
  oom.launch=async()=>{ retries++; oom.log='error: failed to allocate model buffer: out of memory'; throw Error(oom.log); };
  await assert.rejects(oom.ensure('runner',{id:'large',path:'missing-fixture.gguf',sizeBytes:1},{gpu:'auto'}),/does not fit/);
  assert.equal(retries,3,'real memory failures retain the fallback ladder');
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

(async () => {
	let failed = 0;
	for (const [name, run] of tests) {
		try { await run(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
	}
	process.exit(failed ? 1 : 0);
})();
