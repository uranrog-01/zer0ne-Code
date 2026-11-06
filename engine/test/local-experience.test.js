'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const X = require(path.join(out, 'localExperience')), { machineCapacity } = require(path.join(out, 'localModels'));
const { LocalModelsHost } = require(path.join(out, 'host/localModelsHost'));
const tests = [], test = (name, fn) => tests.push([name, fn]);
const machine = more => machineCapacity({ platform: 'win32', cpu: 'CPU', cores: 8, totalMemoryBytes: 32 * 1024 ** 3, ...more });
const rating = { verdict: 'good', tokS: 35, needBytes: 2e9, downloadBytes: 1e9, ctx: 8192, strict: true, score: 70 };
const candidate = (id, more = {}) => ({ id, tools: true, rating: { ...rating }, quality: 70, ...more });
const measurement = { status: 'measured', tokS: 25, ttftMs: 500, promptTokS: 200, context: 8192 };

test('recommendations never turn failed, unknown, oversized, unsupported or disk-limited builds into a fit', () => {
 const safe = candidate('safe'), blocked = [candidate('oversized', { rating: { ...rating, verdict: 'no', tokS: 900 } }), candidate('unknown', { runtimeReason: 'Architecture unknown' }), candidate('new-engine', { runtimeReason: 'Architecture is not supported by engine b1234', measurement }), candidate('no-tools', { tools: false }), candidate('failed', { measurement: { status: 'incomplete' } })];
 assert.equal(X.modelStatus(blocked[2]), 'Needs engine update'); assert.equal(X.modelStatus(blocked[1]), 'Compatibility unconfirmed');
 assert.equal(X.modelStatus(candidate('metadata', { rating: undefined })), 'Compatibility unconfirmed');
 assert.equal(X.modelStatus(safe, 1), 'Not enough disk space');
 for (const x of Object.values(X.recommendModels([safe, ...blocked], 10e9))) assert.equal(x.id, 'safe');
 assert(Object.values(X.recommendModels([safe], 1)).every(x => !x));
 assert.equal(X.modelStatus(candidate('tested', { measurement })), 'Tested successfully');
 assert.equal(X.modelStatus(candidate('tested-too-large', { measurement, rating: { ...rating, verdict: 'no' } })), 'Too large');
});

test('measured speed and latency guide presets without claiming a quality benchmark', () => {
 const a = candidate('measured-fast', { quality: 50, measurement: { ...measurement, tokS: 50, ttftMs: 400 } });
 const b = candidate('measured-slow-start', { quality: 95, measurement: { ...measurement, tokS: 100, ttftMs: 15000 } });
 const c = candidate('quality-estimate', { quality: 99, rating: { ...rating, tokS: 200 } });
 const picks = X.recommendModels([a, b, c]); assert.equal(picks.fast.id, a.id); assert.equal(picks.balanced.id, b.id); assert.equal(picks.quality.id, c.id);
 assert.match(X.recommendationReason(a, 'fast'), /50.0 tok\/s measured at 8K/);
 assert.match(X.recommendationReason(c, 'quality'), /estimated coding capability/);
 assert.match(X.recommendationReason(c, 'quality'), /estimated/);
 assert.equal(X.recommendModels([candidate('skipped', { measurement: { status: 'cancelled' } })]).fast.id, 'skipped');
});

test('hardware and model fingerprints invalidate measurements on other computers, settings, shards or projectors', () => {
	assert.equal(X.hardwareKey(machine({ gpuName: 'Intel Arc 140T', gpuMemoryBytes: 16e9 })), X.hardwareKey(machine({ gpuName: 'Intel Arc 140T', gpuMemoryBytes: 8e9 })), 'shared GPU availability is not hardware identity');
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-measurement-'));
 try {
  const first = path.join(dir, 'Tiny-Q4_K_M-00001-of-00002.gguf'), second = first.replace('00001-of', '00002-of'), projector = path.join(dir, 'mmproj.gguf');
  fs.writeFileSync(first, 'first'); fs.writeFileSync(second, 'second'); fs.writeFileSync(projector, 'projector');
  const g = { id: 'Tiny', path: first, mmproj: projector, sizeBytes: 11 }, hardware = X.hardwareKey(machine()), settings = 'settings';
  const record = { ...measurement, key: 'key', at: Date.now(), hardware, settings, model: g.id, stamp: X.modelStamp(g), bytes: g.sizeBytes };
  assert.equal(X.currentMeasurement([record], g, hardware, settings), record);
  assert(!X.currentMeasurement([record], g, X.hardwareKey(machine({ cores: 16 })), settings));
  assert(!X.currentMeasurement([record], g, hardware, 'new settings'));
  assert(!X.currentMeasurement([{ ...record, tokS: NaN }], g, hardware, settings));
  fs.appendFileSync(second, 'changed'); assert(!X.currentMeasurement([record], g, hardware, settings));
  record.stamp = X.modelStamp(g); fs.appendFileSync(projector, 'changed'); assert(!X.currentMeasurement([record], g, hardware, settings));
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recognized GGUF conversions group together while distinct sizes and fine-tunes retain their identity', () => {
 const model = (id, more = {}) => ({ id, baseModel: 'Qwen/Qwen3-8B', format: 'gguf', author: id.split('/')[0], downloads: 1, likes: 1, tags: [], ...more });
 const a = model('unsloth/Qwen3-8B-GGUF', { fit: 'unsupported', measurement }), b = model('bartowski/Qwen3-8B-GGUF', { fit: 'fits' });
 const groups = X.groupHubModels([a, b, model('unsloth/Qwen3-4B-GGUF'), model('unsloth/Qwen3-8B-Custom-GGUF'), model('unknown/Qwen3-8B-GGUF')]);
 assert.equal(groups.length, 4); assert.equal(groups[0].variants.length, 2); assert.equal(groups[0].id, b.id);
 assert.equal(X.groupHubModels([a, a]).length, 1); assert.equal(X.groupHubModels([a, a])[0].variants.length, 1);
 assert.equal(X.groupHubModels([a, model('bartowski/Qwen_Qwen3-8B-GGUF')]).length, 1);
});

test('bundled curated architectures use GGUF identifiers supported by the pinned engine', async () => {
 const { LLM_SEEDS } = require(path.join(out, 'localCatalog')), { nativeSupport, architectureReason } = require(path.join(out, 'nativeSupport'));
 const support = await nativeSupport(os.tmpdir());
 for (const s of LLM_SEEDS) { assert(s.modelId.includes('/')); assert.equal(architectureReason(s.arch, support), undefined, s.repo); }
});

async function probeServer(fn) {
 const bodies = [], connections = new Set(); let mode = 'ok', streams = 0, processing = false;
 const server = http.createServer((req, res) => {
  if (req.url === '/slots') { res.end(JSON.stringify([{ is_processing: processing }])); return; }
  let body = ''; req.on('data', b => body += b); req.on('end', () => {
   const j = JSON.parse(body); bodies.push(j);
   if (!j.stream) { res.end('{}'); return; }
   streams++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
   if (mode === 'hang') { res.write(': waiting\n\n'); return; }
   const timings = mode === 'missing' ? { predicted_per_second: 20, prompt_per_second: 100 } : { predicted_n: mode === 'short' ? 8 : 96, predicted_per_second: 38.26, prompt_per_second: 200 };
   const chunk = (delta, more = {}) => JSON.stringify({ choices: [{ index: 0, delta }], ...more });
   const data = 'data: ' + chunk({ role: 'assistant', content: null }) + '\n\ndata: ' + chunk({ content: 'Map lookup ' }) + '\r\n\r\ndata: ' + chunk({ content: 'is efficient.' }) + '\n\ndata: ' + chunk({}, { timings }) + '\n\ndata: [DONE]\n\n';
   res.write(data.slice(0, 9)); setTimeout(() => res.end(data.slice(9)), 5);
  });
 });
 server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 try { await fn({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, bodies, mode: m => mode = m, processing: v => processing = v, streams: () => streams }); }
 finally { connections.forEach(s => s.destroy()); await new Promise(r => server.close(r)); }
}

test('the streamed probe uses synthetic prompts and engine timings; short or incomplete responses never count as measured', async () => {
 await probeServer(async p => {
  const r = await X.measureLocalModel(p.base, AbortSignal.timeout(2000));
  assert.equal(r.tokS, 38.3); assert.equal(r.promptTokS, 200); assert(Number.isFinite(r.ttftMs));
  assert(p.bodies.every(b => b.cache_prompt === false && typeof b.messages[0].content === 'string' && b.prompt === undefined), 'chat requests, so the model answers through its own template');
  assert.equal(p.bodies[1].max_tokens, 96); assert.equal(p.bodies[1].stream, true);
  for (const mode of ['short', 'missing']) { p.mode(mode); await assert.rejects(X.measureLocalModel(p.base, AbortSignal.timeout(2000)), /too short|timings/); }
  p.mode('hang'); await assert.rejects(X.measureLocalModel(p.base, AbortSignal.timeout(150)), /aborted|timeout/i);
 });
});

test('first-load probes run once per actual configuration, serialize safely, can be cancelled and leave a busy engine alone', async () => {
 await probeServer(async p => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-first-load-')), values = new Map(), messages = [];
  try {
   fs.mkdirSync(path.join(dir, 'engine')); const executable = path.join(dir, 'server.fixture'); fs.writeFileSync(executable, 'fixture');
   fs.writeFileSync(path.join(dir, 'engine/engine.json'), JSON.stringify({ server: executable, version: 'b11169', backend: 'vulkan' }));
   const file = path.join(dir, 'Tiny-Q4_K_M.gguf'); fs.writeFileSync(file, 'fixture');
   const g = { id: 'Tiny', path: file, quant: 'Q4_K_M', sizeBytes: 7 }, slot = { running: true, model: g.id, run: { ctx: 8192, gpu: 'auto', fit: { threads: 4, ubatch: 128, kv: 'q8_0' } } };
   values.set('zer0ne.engine', { v: 2, port: p.port });
   const host = Object.assign(Object.create(LocalModelsHost.prototype), { storageDir: dir, server: slot, machine: () => machine(), engineState: () => ({}), ctx: { postAll: m => messages.push(m), status() {} }, memento: { get: (k, fallback) => values.get(k) ?? fallback, update: async (k, v) => { await new Promise(r => setTimeout(r, 5)); values.set(k, v); } } });
   await Promise.all([host.testLoaded(slot, g), host.testLoaded(slot, g)]); assert.equal(p.streams(), 1); assert(!host.testing);
   assert.equal(values.get('zer0ne.local.measurements')[0].status, 'measured');
   slot.run.ctx = 4096; await host.testLoaded(slot, g); assert.equal(p.streams(), 2, 'a different actual context is retested');
   slot.run.ctx = 8192; await host.testLoaded(slot, g); assert.equal(p.streams(), 2, 'restoring an already tested context reuses its own result'); slot.run.ctx = 4096;
   p.processing(true); await host.testLoaded(slot, g, undefined, true); assert.equal(p.streams(), 2); p.processing(false);
   p.mode('hang'); const running = host.testLoaded(slot, g, undefined, true);
   while (!host.testing || p.streams() < 3) await new Promise(r => setTimeout(r, 5));
   await host.handle({}, { type: 'engineStop' }); assert(slot.running, 'destructive changes wait for the check');
   await host.handle({}, { type: 'engineTestCancel' }); await running;
   assert(!host.testing); assert.equal(values.get('zer0ne.local.measurements').at(-1).status, 'cancelled');
   await host.testLoaded(slot, g); assert.equal(p.streams(), 3, 'cancellation is remembered, avoiding another automatic delay');
   values.set('zer0ne.engine', { v: 2, port: p.port, firstLoadTest: false }); slot.run.ctx = 2048;
   await host.testLoaded(slot, g); assert.equal(p.streams(), 3);
   assert(messages.some(m => m.type === 'modelMeasurement'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
 });
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } } process.exitCode = failed ? 1 : 0; })();
