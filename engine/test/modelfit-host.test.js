'use strict';
// Local models is Models Fit Studio's page; ModelFitHost answers its calls with zer0ne Engine.
// These hold the answers to the shapes that page reads, and the paths a download, a run, a
// speed check and a quality test take. A mock Hugging Face serves the Check.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const tests = [], test = (name, run) => tests.push([name, run]);
const GiB = 1024 ** 3;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const gguf = (pairs, padding = 0) => Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(pairs.length), ...pairs.map(([k, v]) => Buffer.concat([str(k), u32(typeof v === 'string' ? 8 : 4), typeof v === 'string' ? str(v) : u32(v)])), Buffer.alloc(padding)]);

/** A ModelFitHost over a temporary models folder, with every engine action recorded. */
function harness(over = {}) {
	const { ModelFitHost } = require(path.join(out, 'host', 'modelFitHost'));
	const { machineCapacity } = require(path.join(out, 'localModels'));
	const { machineProfile } = require(path.join(out, 'localCatalog'));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfit-'));
	const models = path.join(dir, 'models');
	fs.mkdirSync(path.join(models, 'unsloth', 'Tiny-GGUF'), { recursive: true });
	const tiny = path.join(models, 'unsloth', 'Tiny-GGUF', 'Tiny-Q4_K_M.gguf');
	fs.writeFileSync(tiny, Buffer.alloc(2048));
	fs.writeFileSync(path.join(models, 'unsloth', 'Tiny-GGUF', 'Big-Q8_0.gguf.part'), Buffer.alloc(4096));
	const machine = machineCapacity({ platform: 'win32', cpu: 'Intel Core Ultra 9 285H', cores: 16, totalMemoryBytes: 32 * GiB, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)', unifiedMemory: false });
	const profile = machineProfile(machine, { at: Date.now(), ramGBs: 80 });
	const pushes = [], replies = [], calls = [], store = new Map();
	let files = [{ id: 'Tiny-Q4_K_M', path: tiny, sizeBytes: 2048, repo: 'unsloth/Tiny-GGUF', source: 'zer0ne', quant: 'Q4_K_M' }];
	const jobs = new Map();
	const engine = { installed: true, version: 'b11169', backend: 'vulkan', server: 'llama-server', running: false };
	const d = {
		ctx: { postAll: (m) => pushes.push(m), status: () => {} },
		memento: { get: (k, def) => (store.has(k) ? store.get(k) : def), update: async (k, v) => { store.set(k, v); } },
		modelsDir: models, storageDir: dir, engineDir: path.join(dir, 'engine'), appVersion: '0.2.0',
		machine: () => machine,
		catalog: { modelProfile: () => profile, check: () => ({ at: Date.now(), ramGBs: 80 }), recheckMachine: async () => ({}), suggestions: async () => ({ profile, picks: [] }), discovery: over.discovery },
		gguf: () => files,
		measurements: () => [{ model: 'Tiny-Q4_K_M', status: 'measured', tokS: 41.5, ttftMs: 120 }],
		measure: async (id) => { calls.push(['measure', id]); return { model: id, status: 'measured', tokS: 40, promptTokS: 900, ttftMs: 150, backend: 'vulkan' }; },
		quality: async (_s, id, onQuestion) => { calls.push(['quality', id]); onQuestion(1, 40); onQuestion(40, 40); return { score: 43, correct: 17, total: 40, parts: { Math: 4 } }; },
		qualityScores: () => ({ 'Tiny-Q4_K_M': { score: 43 } }),
		download: async (_s, repo, file) => {
			calls.push(['download', repo, file.name]);
			const job = { received: 0, total: file.sizeBytes, rate: 5e6, ctl: new AbortController() };
			jobs.set(`hf:${repo}/${file.name}`, job);
			if (over.downloadWaits) await new Promise((r) => job.ctl.signal.addEventListener('abort', r));
			jobs.delete(`hf:${repo}/${file.name}`);
			if (job.ctl.signal.aborted) return undefined;
			if (over.downloadFails) return 'Hugging Face answered HTTP 403.';
			const p = path.join(models, ...repo.split('/'), file.name);
			fs.writeFileSync(p, Buffer.alloc(16));
			files = [...files, { id: file.name.replace(/\.gguf$/, ''), path: p, sizeBytes: 16, repo, source: 'zer0ne', quant: file.quant }];
			return undefined;
		},
		job: (key) => jobs.get(key),
		removeGguf: (id) => { calls.push(['remove', id]); files = files.filter((g) => g.id !== id); return true; },
		chatWith: async (_s, id) => { calls.push(['chat', id]); },
		ensureLoaded: async (id) => { calls.push(['load', id]); Object.assign(engine, { running: true, model: id, ctx: 16384, gpu: 'auto' }); },
		stopEngine: () => { calls.push(['stop']); engine.running = false; },
		engine: () => engine,
		installEngine: async () => {},
		engineLatest: () => ({ build: 'b11169' }),
		hfToken: async () => store.get('token'),
		setHfToken: async (_s, token) => { store.set('token', token); },
		openExternal: (t) => calls.push(['open', t]),
		saveImage: async () => path.join(dir, 'battle.png'),
		clearMeasurements: async () => 1,
		...over.deps
	};
	const host = new ModelFitHost(d);
	const surface = { post: (m) => replies.push(m) };
	let id = 0;
	const ask = async (cmd, args = {}) => {
		const n = ++id;
		assert.strictEqual(await host.handle(surface, { type: 'modelfit', id: n, cmd, args }), true);
		const r = replies.find((x) => x.id === n);
		if (!r.ok) throw new Error(r.error);
		return r.data;
	};
	const pushed = (type) => pushes.filter((m) => m.type === 'modelfitPush' && m.push === type).map((m) => m.data);
	return { host, ask, pushed, calls, dir, models, files: () => files, store, engine, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('only the page\'s own messages are taken, and an unknown command is an error, not silence', async () => {
	const h = harness();
	try {
		assert.strictEqual(await h.host.handle({ post() {} }, { type: 'hfSearch' }), false);
		await assert.rejects(h.ask('nonsense'), /unknown command 'nonsense'/);
		assert.deepStrictEqual(await h.ask('ping'), { version: '0.2.0', llmfit: null });
	} finally { h.done(); }
});

test('this machine, in the shape the page reads: the budget and ceiling of the shared fit rule', async () => {
	const h = harness();
	try {
		const { hw, notes } = await h.ask('scanHardware');
		assert.strictEqual(hw.gpuClass, 'integrated'); assert.strictEqual(hw.hasGpu, true); assert.strictEqual(hw.cpuCores, 16);
		assert.strictEqual(hw.totalRamGb, 32); assert.ok(hw.budgetGb > 14 && hw.budgetGb < 17, String(hw.budgetGb)); assert.ok(hw.ceilingGb > hw.budgetGb);
		assert.strictEqual(hw.backend, 'Vulkan');
		assert.ok(notes.some((n) => /80 GB\/s/.test(n)));
	} finally { h.done(); }
});

test('the library lists zer0ne code\'s models with their measured speed and quality; storage counts parts', async () => {
	const h = harness();
	try {
		const lib = await h.ask('installed');
		assert.strictEqual(lib.root, h.models);
		assert.deepStrictEqual(lib.files.map((f) => [f.repo, f.file, f.measuredTps, f.qualityScore, f.helper]), [['unsloth/Tiny-GGUF', 'Tiny-Q4_K_M.gguf', 41.5, 43, false]]);
		const s = await h.ask('storageBreakdown');
		assert.strictEqual(s.completedFileCount, 1); assert.strictEqual(s.incompleteFileCount, 1); assert.strictEqual(s.rootDir, h.models);
		assert.deepStrictEqual(await h.ask('purgeIncomplete'), { count: 1, reclaimedGb: 0 });
		assert.strictEqual((await h.ask('storageBreakdown')).incompleteFileCount, 0);
		assert.deepStrictEqual(await h.ask('deleteFile', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' }), { ok: true });
		assert.deepStrictEqual(h.calls.at(-1), ['remove', 'Tiny-Q4_K_M']);
		assert.deepStrictEqual(await h.ask('deleteFile', { repo: 'unsloth/Tiny-GGUF', file: '../../etc' }), { ok: false });
		// zer0ne code keeps its own folder: the page cannot move it
		assert.strictEqual((await h.ask('pickFolder')).dir, h.models);
	} finally { h.done(); }
});

test('storage counts and purges leftovers in every store, not only the models folder', async () => {
	const h = harness();
	try {
		fs.mkdirSync(path.join(h.dir, 'private-search'), { recursive: true });
		fs.writeFileSync(path.join(h.dir, 'private-search', 'embed.gguf.verify'), Buffer.alloc(512));
		fs.mkdirSync(path.join(h.dir, 'studio', 'models', 'owner--repo'), { recursive: true });
		fs.writeFileSync(path.join(h.dir, 'studio', 'models', 'owner--repo', 'vae.safetensors.verify.part'), Buffer.alloc(128));
		const s = await h.ask('storageBreakdown');
		// models .part + private-search .verify + studio .verify.part
		assert.strictEqual(s.incompleteFileCount, 3);
		assert.ok(s.roots.some((r) => r.name === 'private-search' && r.leftoverFileCount === 1), JSON.stringify(s.roots));
		assert.ok(s.totalGb >= s.totalModelGb, 'all-stores total covers models');
		const purged = await h.ask('purgeIncomplete');
		assert.strictEqual(purged.count, 3);
		assert.strictEqual(fs.existsSync(path.join(h.dir, 'private-search', 'embed.gguf.verify')), false);
		assert.strictEqual(fs.existsSync(path.join(h.dir, 'studio', 'models', 'owner--repo', 'vae.safetensors.verify.part')), false);
		// The now-empty owner--repo folder is gone too.
		assert.strictEqual(fs.existsSync(path.join(h.dir, 'studio', 'models', 'owner--repo')), false);
	} finally { h.done(); }
});

test('Remove engine deletes the builds and the pointer; a running model refuses', async () => {
	const h = harness();
	try {
		const engineDir = path.join(h.dir, 'engine');
		const current = path.join(engineDir, 'b11169-vulkan');
		const rollback = path.join(engineDir, 'b11000-vulkan');
		for (const dir of [current, rollback]) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'x');
		}
		fs.writeFileSync(path.join(engineDir, 'engine.json'), JSON.stringify({ version: 'b11169', backend: 'vulkan', server: path.join(current, 'llama-server.exe'), previous: { version: 'b11000', backend: 'vulkan', server: path.join(rollback, 'llama-server.exe') } }));
		h.engine.server = path.join(current, 'llama-server.exe');
		let status = await h.ask('engineStatus');
		assert.strictEqual(status.removable, true);
		assert.deepStrictEqual(await h.ask('removeEngine'), { ok: true });
		assert.deepStrictEqual(h.calls.filter((c) => c[0] === 'stop').length, 1, 'the idle server is stopped first');
		assert.strictEqual(fs.existsSync(current), false);
		assert.strictEqual(fs.existsSync(rollback), false);
		assert.strictEqual(fs.existsSync(path.join(engineDir, 'engine.json')), false);
		// Not installed anymore: removing again says so instead of half-deleting.
		h.engine.installed = false;
		await assert.rejects(h.ask('removeEngine'), /not installed/);
		h.engine.installed = true;
		h.engine.running = true;
		status = await h.ask('engineStatus');
		assert.strictEqual(status.removable, false);
		await assert.rejects(h.ask('removeEngine'), /Stop it first/);
	} finally { h.done(); }
});

test('Run loads the model in zer0ne Engine and opens its chat; Stop unloads it; the running list follows', async () => {
	const h = harness();
	try {
		assert.deepStrictEqual(await h.ask('runList'), []);
		assert.deepStrictEqual(await h.ask('runLocal', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf', ctx: 8192 }), { ok: true, url: '' });
		assert.deepStrictEqual(h.calls.slice(-2), [['load', 'Tiny-Q4_K_M'], ['chat', 'Tiny-Q4_K_M']]);
		assert.deepStrictEqual(await h.ask('runList'), [{ repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf', url: '', ready: true, context: 16384, gpu: true }]);
		assert.ok(h.pushed('running').length);
		assert.deepStrictEqual(await h.ask('runStop', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' }), { ok: true });
		assert.deepStrictEqual(await h.ask('runList'), []);
		assert.strictEqual((await h.ask('runLocal', { repo: 'nobody/none', file: 'x.gguf' })).ok, false);
		const tools = await h.ask('runTools', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' });
		assert.strictEqual(tools.engine, true); assert.strictEqual(tools.hasGpu, true);
	} finally { h.done(); }
});

test('a speed check and the quality test report their progress as the page expects, one at a time', async () => {
	let release; const gate = new Promise((r) => (release = r));
	const h = harness({ deps: { measure: async (id) => { await gate; return { model: id, status: 'measured', tokS: 40, promptTokS: 900, ttftMs: 150, backend: 'vulkan' }; } } });
	try {
		const started = await h.ask('measure', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' });
		assert.deepStrictEqual(started, { started: true, key: 'unsloth/Tiny-GGUF/Tiny-Q4_K_M.gguf' });
		assert.match((await h.ask('testQuality', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' })).error, /Another model/);
		release();
		await settle();
		const bench = h.pushed('bench');
		assert.deepStrictEqual(bench.map((b) => b.phase), ['loading', 'done']);
		assert.strictEqual(bench[1].genTps, 40); assert.strictEqual(bench[1].firstTokenMs, 150); assert.strictEqual(bench[1].fallback, false);
		assert.strictEqual((await h.ask('testQuality', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' })).started, true);
		await settle();
		const q = h.pushed('bench').filter((b) => b.kind === 'quality');
		assert.deepStrictEqual(q.map((b) => [b.phase, b.run]), [['loading', 0], ['testing', 1], ['testing', 40], ['done', undefined]]);
		assert.deepStrictEqual([q.at(-1).quality, q.at(-1).correct, q.at(-1).total], [43, 17, 40]);
		assert.strictEqual((await h.ask('measure', { repo: 'unsloth/Tiny-GGUF', file: 'Missing.gguf' })).started, false);
	} finally { h.done(); }
});

test('downloads go through zer0ne code\'s own download, can pause, resume and be discarded', async () => {
	const discovery = {
		info: async (id) => ({ id, author: 'unsloth', downloads: 1, likes: 0, format: 'gguf', tags: ['gguf'] }),
		files: async () => [{ name: 'Tiny-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 16, parts: ['Tiny-Q8_0.gguf'], metadata: [{ path: 'Tiny-Q8_0.gguf', size: 16 }] }]
	};
	const h = harness({ discovery, downloadWaits: true });
	try {
		assert.deepStrictEqual(await h.ask('download', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q4_K_M.gguf' }), { started: false, already: true, path: h.files()[0].path });
		assert.deepStrictEqual(await h.ask('download', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q8_0.gguf', size: 16 }), { started: true });
		await settle();
		const key = 'unsloth/Tiny-GGUF/Tiny-Q8_0.gguf';
		assert.strictEqual((await h.ask('downloads')).files[0].state, 'Downloading');
		assert.deepStrictEqual(await h.ask('pauseDownload', { key }), { ok: true });
		await settle();
		const row = (await h.ask('downloads')).files[0];
		assert.strictEqual(row.state, 'Paused'); assert.strictEqual(row.key, key);
		assert.deepStrictEqual(await h.ask('discardDownload', { key }), { ok: true });
		assert.deepStrictEqual((await h.ask('downloads')).files, []);
		assert.deepStrictEqual(h.pushed('downloadRemoved').at(-1), { key });
	} finally { h.done(); }
	const ok = harness({ discovery });
	try {
		await ok.ask('download', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q8_0.gguf', size: 16 });
		await settle();
		const states = ok.pushed('download').map((r) => r.state);
		assert.deepStrictEqual([states[0], states.at(-1)], ['Queued', 'Done']);
		assert.deepStrictEqual(ok.pushed('installed'), [{ repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q8_0.gguf' }]);
		assert.ok((await ok.ask('installed')).files.some((f) => f.file === 'Tiny-Q8_0.gguf'), 'in the library at once');
	} finally { ok.done(); }
	const bad = harness({ discovery, downloadFails: true });
	try {
		await bad.ask('download', { repo: 'unsloth/Tiny-GGUF', file: 'Tiny-Q8_0.gguf' });
		await settle();
		const last = bad.pushed('download').at(-1);
		assert.strictEqual(last.state, 'Failed'); assert.strictEqual(last.error, 'Hugging Face answered HTTP 403.');
		assert.deepStrictEqual(await bad.ask('resumeDownload', { key: 'unsloth/Tiny-GGUF/Tiny-Q8_0.gguf' }), { ok: true });
	} finally { bad.done(); }
});

test('settings: the Hugging Face token is zer0ne code\'s own, the language is kept, Windows-only parts are off', async () => {
	const h = harness();
	try {
		const s = await h.ask('getSettings');
		assert.deepStrictEqual([s.minimizeToTrayOnClose, s.startWithWindows, s.theme, s.language, s.hfToken], [false, false, 'default', 'en', null]);
		await h.ask('saveSettings', { hfToken: '  hf_abc  ', language: 'de' });
		assert.strictEqual(h.store.get('token'), 'hf_abc');
		assert.strictEqual((await h.ask('getSettings')).language, 'de');
		await h.ask('saveSettings', { language: 'not a language' });
		assert.strictEqual((await h.ask('getSettings')).language, 'de');
		await assert.rejects(h.ask('installNvidia'), /NVIDIA build by itself/);
		assert.match((await h.ask('sharePrepare')).error, /Models Fit Studio app/);
		await h.ask('openUrl', { url: 'javascript:alert(1)' });
		assert.ok(!h.calls.some((c) => c[0] === 'open'), 'only web links are opened');
		await h.ask('openUrl', { url: 'https://huggingface.co/unsloth' });
		assert.deepStrictEqual(h.calls.at(-1), ['open', 'https://huggingface.co/unsloth']);
		const st = await h.ask('engineStatus');
		// An installed engine with no model running is removable.
		assert.deepStrictEqual([st.installed, st.source, st.build, st.removable, st.measurements], [true, 'zer0ne Engine', 'b11169', true, 1]);
	} finally { h.done(); }
});

test('Check and the model list answer from Hugging Face with the shared fit rule, in the page\'s words', async () => {
	const MODEL = [['general.architecture', 'qwen3'], ['qwen3.block_count', 28], ['qwen3.context_length', 40960], ['qwen3.embedding_length', 2048], ['qwen3.attention.head_count', 16], ['qwen3.attention.head_count_kv', 8], ['qwen3.attention.key_length', 128], ['qwen3.attention.value_length', 128]];
	const repo = 'unsloth/Qwen3-1.7B-GGUF';
	const info = { id: repo, downloads: 900, likes: 9, gguf: { total: 1.7e9, architecture: 'qwen3', context_length: 40960 }, tags: ['gguf', 'text-generation'], pipeline_tag: 'text-generation', cardData: { license: 'apache-2.0' }, sha: 'a'.repeat(40) };
	const tree = [
		{ type: 'file', path: 'Qwen3-1.7B-Q4_K_M.gguf', size: 1.1e9, lfs: { size: 1.1e9, oid: 'b'.repeat(64) } },
		{ type: 'file', path: 'Qwen3-1.7B-Q8_0.gguf', size: 1.8e9, lfs: { size: 1.8e9, oid: 'c'.repeat(64) } },
		{ type: 'file', path: 'Qwen3-1.7B-BF16.gguf', size: 3.4e9, lfs: { size: 3.4e9, oid: 'd'.repeat(64) } }
	];
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://x');
		if (url.pathname === `/api/models/${repo}`) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(info));
		if (url.pathname.startsWith(`/api/models/${repo}/tree/`)) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(tree));
		if (url.pathname === '/api/models') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([info, { id: 'someone/Detector-GGUF', downloads: 5, likes: 0, gguf: { total: 3.8e9 }, tags: ['gguf'], pipeline_tag: 'object-detection' }, { id: 'big/Huge-400B-GGUF', downloads: 3, likes: 0, gguf: { total: 4e11 }, tags: ['gguf'], pipeline_tag: 'text-generation' }, { id: 'someone/Locate-3B-GGUF', downloads: 2, likes: 0, gguf: { total: 3e9, architecture: 'locateanything' }, tags: ['gguf'], pipeline_tag: 'text-generation' }]));
		if (url.pathname.includes('/resolve/')) {
			const body = gguf(MODEL, 64);
			return res.writeHead(206, { 'Content-Range': `bytes 0-${body.length - 1}/${body.length}` }).end(body);
		}
		res.writeHead(404).end();
	});
	server.keepAliveTimeout = 0;
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const previous = process.env.HF_ENDPOINT; process.env.HF_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
	for (const k of Object.keys(require.cache)) if (k.startsWith(path.resolve(out))) delete require.cache[k];
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfit-hub-'));
	try {
		const { ModelDiscovery } = require(path.join(out, 'modelDiscovery'));
		const { machineCapacity } = require(path.join(out, 'localModels'));
		const { machineProfile } = require(path.join(out, 'localCatalog'));
		const m = machineCapacity({ platform: 'win32', cpu: 'x', cores: 16, totalMemoryBytes: 32 * GiB, gpuName: 'Intel Arc 140T', unifiedMemory: false });
		const discovery = new ModelDiscovery(cache, () => m, () => machineProfile(m));
		const h = harness({ discovery });
		try {
			const res = await h.ask('analyze', { input: `https://huggingface.co/${repo}` });
			assert.strictEqual(res.ok, true, res.error); assert.strictEqual(res.repoId, repo); assert.strictEqual(res.hfUrl, `https://huggingface.co/${repo}`);
			assert.strictEqual(res.architecture, 'qwen3'); assert.strictEqual(res.paramsText, '1.7B'); assert.strictEqual(res.contextMax, 40960); assert.strictEqual(res.license, 'apache-2.0');
			assert.deepStrictEqual(res.quants.map((q) => q.file), ['Qwen3-1.7B-Q4_K_M.gguf', 'Qwen3-1.7B-Q8_0.gguf', 'Qwen3-1.7B-BF16.gguf'], 'smallest first');
			for (const q of res.quants) {
				assert.ok(['Perfect', 'Good', 'Marginal', 'Slower', 'Too tight'].includes(q.fitLevel), q.fitLevel);
				assert.ok(['runs', 'tight', 'slow', 'no'].includes(q.verdict), q.verdict);
				assert.ok(q.tpsLow <= q.estTps && q.estTps <= q.tpsHigh && q.memoryRequiredGb > q.sizeGb && q.usableContext > 0);
			}
			assert.strictEqual(res.quants.filter((q) => q.recommended).length, 1); assert.ok(res.primary.recommended);
			assert.notStrictEqual(res.primary.file, 'Qwen3-1.7B-BF16.gguf', 'never an unquantised build');
			assert.ok(res.pickReason && res.turbo && res.turbo.label && res.serveCommand.includes(res.primary.file));
			const missing = await h.ask('analyze', { input: '' });
			assert.strictEqual(missing.ok, false); assert.ok(missing.error);

			const list = await h.ask('hfSearch', { q: 'qwen', sort: 'downloads', format: 'gguf', fitsOnly: false });
			assert.strictEqual(list.error, null);
			const [qwen, detector, huge, locate] = list.items;
			assert.strictEqual(qwen.repoId, repo); assert.strictEqual(qwen.estFit, 'good'); assert.match(qwen.estFitText, /^≈[\d.]+ GB — fits$/); assert.ok(qwen.tpsHigh > qwen.tpsLow && qwen.tpsLow > 0);
			assert.strictEqual(detector.tpsLow, 0, 'no speed for a model that does not write text');
			assert.strictEqual(huge.estFit, 'tight'); assert.match(huge.estFitText, /over budget/);
			assert.strictEqual(locate.estFit, 'engine', 'an architecture the engine cannot load is not a fit'); assert.strictEqual(locate.tpsLow, 0);
			const fits = await h.ask('hfSearch', { q: 'qwen', fitsOnly: true });
			assert.ok(!fits.items.some((x) => x.repoId === 'big/Huge-400B-GGUF' || x.repoId === 'someone/Locate-3B-GGUF'));
		} finally { h.done(); discovery.dispose(); }
	} finally {
		if (previous === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = previous;
		for (const k of Object.keys(require.cache)) if (k.startsWith(path.resolve(out))) delete require.cache[k];
		await new Promise((r) => server.close(r)); fs.rmSync(cache, { recursive: true, force: true });
	}
});

test('the page is shipped with its bridge, and the server keeps it inside its folder', async () => {
	const target = path.join(__dirname, '..', 'media', 'modelfit');
	const html = fs.readFileSync(path.join(target, 'index.html'), 'utf8');
	assert.ok(html.includes('<script src="zer0ne-bridge.js"></script>') && html.includes('<link rel="stylesheet" href="zer0ne.css">'));
	assert.ok(!/<script>\s/.test(html), 'no inline script: the frame\'s policy allows none');
	for (const f of ['app.js', 'styles.css', 'i18n.js', 'zer0ne-bridge.js', 'zer0ne.css', 'zer0ne-text.css']) assert.ok(fs.existsSync(path.join(target, f)), f);
	const { RemoteServer } = require(path.join(out, 'remote'));
	if (!RemoteServer) return;
	const media = path.join(__dirname, '..', 'media');
	const srv = new RemoteServer(media, { token: () => 't', attach: () => ({ handle: async () => {}, dispose() {} }) }, { desktop: true });
	await srv.start(0);
	try {
		const base = `http://127.0.0.1:${srv.port}`;
		const page = await fetch(base + '/modelfit/index.html');
		assert.strictEqual(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
		assert.strictEqual((await fetch(base + '/modelfit/lang/de.json')).headers.get('content-type'), 'application/json');
		for (const bad of ['/modelfit/../settings.js', '/modelfit/%2e%2e/settings.js', '/modelfit/..%2fsettings.js', '/modelfit/', '/modelfit/nope.exe']) { const r = await fetch(base + bad); assert.notStrictEqual(r.status, 200, bad); assert.ok(!(await r.text()).includes('function renderPage'), bad); }
	} finally { await srv.stop(); }
});


test('Check explains the full split model, blocks its helper, and leaves no false speed or run command', async () => {
 const repo='kernelpool/MiMo-V2.6-Pro-RL-MXFP4-GGUF';
 const main={name:'MiMo-V2.6-Pro-RL-MXFP4.gguf',quant:'MXFP4',sizeBytes:557146510560,parts:['main.gguf.part1','main.gguf.part2'],assembly:true};
 const helper={name:'MiMo-V2.6-Pro-RL-DFlash-Q8_0.gguf',quant:'Q8_0',sizeBytes:2941587648,parts:['MiMo-V2.6-Pro-RL-DFlash-Q8_0.gguf']};
 let files=[helper,main];
 const discovery={scan:async()=>({info:{id:repo,author:'kernelpool',tags:[],arch:undefined},files}),support:async()=>({version:'fixture',exact:true,architectures:['mimo2']}),shape:async()=>({arch:'mimo2'}),find:()=>undefined,draftHead:async()=>undefined,builds:async()=>[],info:async()=>({id:repo}),files:async()=>files};
 const h=harness({discovery});
 try {
  const res=await h.ask('analyze',{input:repo});
  assert.equal(res.ok,true);assert.equal(res.quants.length,1);assert.equal(res.primary.sizeBytes,557146510560);
  assert.equal(res.primary.blocked,true);assert.equal(res.primary.recommended,false);assert.equal(res.primary.estTps,0);
  assert.match(res.primary.compatibilityHint,/557\.1 GB/);assert.match(res.primary.compatibilityHint,/engine update cannot increase/);
  assert.match(res.primary.compatibilityHint,/raw.*chunks/);assert.equal(res.serveCommand,undefined);assert.equal(res.turbo,undefined);
  assert.equal(res.paramsTotal,undefined);assert.equal(res.isMoe,false,'no fabricated active parameter count from the helper');
  files=[helper];const only=await h.ask('analyze',{input:repo});
  assert.equal(only.quants.length,0);assert.match(only.compatibilityHint,/Draft helpers/);
  await h.ask('download',{repo,file:helper.name,size:helper.sizeBytes});await settle();
  assert.equal(h.calls.filter(c=>c[0]==='download').length,0);
  assert.equal((await h.ask('runLocal',{repo,file:helper.name})).ok,false);
  const dir=path.join(h.models,'kernelpool','MiMo-V2.6-Pro-RL-MXFP4-GGUF');fs.mkdirSync(dir,{recursive:true});
  const dest=path.join(dir,helper.name);fs.writeFileSync(dest,gguf([['general.architecture','dflash']]));
  const row=(await h.ask('installed')).files.find(f=>f.file===helper.name);
  assert.equal(row.helper,true);assert.equal(row.chatCompatible,false);assert.match(row.verification,/cannot run alone/);
  assert.equal((await h.ask('deleteFile',{repo,file:helper.name})).ok,true);assert.equal(fs.existsSync(dest),false);
 } finally {h.done();}
});

(async () => {
	let failed = 0;
	for (const [name, run] of tests) {
		try { await run(); console.log('ok  ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n' + (e && e.stack || e)); }
	}
	process.exit(failed ? 1 : 0);
})();
