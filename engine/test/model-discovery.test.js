'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { machineCapacity } = require(path.join(out,'localModels'));
const { machineProfile, LLM_SEEDS, catalogFor } = require(path.join(out,'localCatalog'));
const { LocalAdvisor, advisorCatalog, advisorFits, advisorProfile } = require(path.join(out,'localAdvisor'));
const { ModelDiscovery, liveProfile, seedFromAdvisor, seedFromHub, fitHubFiles, modelKey, hubSearchModels, rateHubSearch } = require(path.join(out,'modelDiscovery'));
const E = require(path.join(out,'localEngine'));
const { nativeSupport, architectureReason, parseArchitectures } = require(path.join(out,'nativeSupport'));
const tests = [], test = (name, run) => tests.push([name, run]);
const GiB = 1024 ** 3;
const machine = (more = {}) => machineCapacity({ platform: 'win32', cpu: 'CPU', cores: 16, totalMemoryBytes: 32 * GiB, unifiedMemory: false, freeDiskBytes: 100 * GiB, ...more });
const info = (more = {}) => ({ id: 'Qwen/Tiny-GGUF', params: 1.7e9, context: 32768, tools: true, format: 'gguf', tags: [], author: 'Qwen', downloads: 10, likes: 1, ...more });
const file = (size = 1.2 * GiB, more = {}) => ({ name: 'Tiny-Q4_K_M.gguf', quant: 'Q4_K_M', parts: ['Tiny-Q4_K_M.gguf'], sizeBytes: size, ...more });

test('model-page inputs stay on Hugging Face and preserve repository boundaries', () => {
 for (const input of ['Qwen/Tiny-GGUF',' https://huggingface.co/Qwen/Tiny-GGUF/?utm_source=fixture#card ']) assert.equal(E.hfRepoFromInput(input),'Qwen/Tiny-GGUF');
 for (const input of ['tiny','../..','https://example.com/Qwen/Tiny-GGUF','https://huggingface.co.evil.test/Qwen/Tiny-GGUF','https://user:pass@huggingface.co/Qwen/Tiny-GGUF','https://huggingface.co:8443/Qwen/Tiny-GGUF','https://huggingface.co/Qwen/Tiny-GGUF/blob/old/model.gguf','http://huggingface.co/Qwen/Tiny-GGUF']) assert.equal(E.hfRepoFromInput(input),undefined,input);
});

test('direct search and pre-download scans read metadata only, pin file listings and recover from cached scans', async () => {
 const revision='c'.repeat(40), seen=[];let unavailable=false;
 const server=http.createServer((req,res)=>{
  seen.push(req.url);if(unavailable){res.writeHead(503).end();return;}
  res.setHeader('Content-Type','application/json');
  if(req.url.startsWith('/api/models/Qwen/Tiny-GGUF?'))res.end(JSON.stringify({id:'Qwen/Tiny-GGUF',sha:revision,gguf:{total:1.7e9,context_length:8192,architecture:'qwen3'},tags:['gguf']}));
  else if(req.url.includes('/tree/'+revision))res.end(JSON.stringify([{type:'file',path:'Tiny-Q4_K_M.gguf',size:1e9},{type:'file',path:'Tiny-F16.gguf',size:4e9}]));
  else res.writeHead(404).end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const prior=process.env.HF_ENDPOINT, dir=fs.mkdtempSync(path.join(os.tmpdir(),'zc-prescan-'));process.env.HF_ENDPOINT='http://127.0.0.1:'+server.address().port;
 const profile=machineProfile(machine()), discovery=new ModelDiscovery(dir,machine,()=>profile),messages=[];
 try {
  const scan=await discovery.scan('Qwen/Tiny-GGUF');assert.equal(scan.offline,false);assert.equal(scan.files.length,2);assert(scan.files.every(f=>f.revision===revision));
  unavailable=true;assert.equal((await discovery.scan('Qwen/Tiny-GGUF')).offline,true);
  unavailable=false;assert.equal((await discovery.scan('Qwen/Tiny-GGUF')).offline,false);
  const {LocalModelsHost}=require(path.join(out,'host/localModelsHost'));
  const host={plus:{handle:async()=>false},catalog:{handle:async()=>false,discovery,modelProfile:()=>profile},machine,modelMeasurements:()=>[],hfCacheDir:path.join(dir,'hf-cache'),settings:()=>({lightKv:true})};
  await LocalModelsHost.prototype.handle.call(host,{post:m=>messages.push(m)},{type:'hfSearch',query:'https://huggingface.co/Qwen/Tiny-GGUF',format:'vision',size:{max:1},rid:'direct'});
  const reply=messages.at(-1);assert(!reply.error,reply.error);assert(reply.exact);assert.equal(reply.items[0].id,'Qwen/Tiny-GGUF');assert.equal(reply.cursor,undefined);
  const before=seen.length;await LocalModelsHost.prototype.handle.call(host,{post:m=>messages.push(m)},{type:'hfSearch',query:'https://example.com/Qwen/Tiny-GGUF',rid:'bad'});assert(messages.at(-1).error);assert.equal(seen.length,before);
  assert(seen.every(url=>url.startsWith('/api/models/Qwen/Tiny-GGUF')));assert(!seen.some(url=>url.includes('/resolve/')||url.startsWith('/api/models?')),'no weights, engine binary or generic search fetched');
 } finally {discovery.dispose();if(prior===undefined)delete process.env.HF_ENDPOINT;else process.env.HF_ENDPOINT=prior;await new Promise(r=>{server.closeAllConnections();server.close(r);});fs.rmSync(dir,{recursive:true,force:true});}
});

test('bundled catalog retains license, sources and real architecture metadata', () => {
 assert.ok(advisorCatalog().length > 1000);
 const row = advisorCatalog().find(m => m.name === 'Qwen/Qwen3-8B');
 const seed = seedFromAdvisor(row, { quality: 70, quant: 'Q5_K_M', score: 82, confidence: 'estimated' });
 assert.ok(seed.repo.includes('GGUF')); assert.equal(seed.kvBytes, 147456); assert.equal(seed.tools, true);
 assert.equal(seed.quality.coding, 70); assert.equal(seed.advisor.quant, 'Q5_K_M'); assert.equal(seed.source, 'llmfit');
 assert.equal(seedFromAdvisor({ ...row, capabilities: [] }).tools, false, 'general language models remain discoverable without claiming tool support');
});

test('native JSON rejects FP4, foreign runtimes, malformed repos and invalid scores', () => {
 const row = { name: 'Qwen/Qwen3-8B', runtime: 'llama.cpp', best_quant: 'Q4_K_M', score: 80, score_components: { quality: 65 }, effective_context_length: 8192, gguf_sources: [{ repo: 'unsloth/Qwen3-8B-GGUF' }], estimate_confidence: 'measured_community', estimated_tps: 50 };
 const fit = advisorFits({ models: [row, { ...row, best_quant: null }, { ...row, runtime: 'vllm' }, { ...row, name: '../../bad' }, { ...row, score: NaN }] });
 assert.equal(fit.length, 1); assert.equal(fit[0].confidence, 'measured_community'); assert.deepEqual(fit[0].ggufSources, ['unsloth/Qwen3-8B-GGUF']);
 assert.throws(() => advisorFits({}), /invalid/);
});

test('engine support is tied to the exact runtime release and refuses unknown architectures', async () => {
 const support = await nativeSupport(os.tmpdir()); assert.equal(support.version, E.ENGINE_PIN); assert.equal(support.exact, true);
 assert.equal(architectureReason('qwen3', support), undefined); assert.match(architectureReason('future-architecture', support), /engine update/); assert.match(architectureReason(undefined, support), /unknown/);
 assert.match(architectureReason('qwen3', { version: 'b99999', architectures: [], exact: false }), /online/);
 assert.deepEqual(parseArchitectures('{ LLM_ARCH_QWEN3, "qwen3" }, { LLM_ARCH_CLIP, "clip" }'), ['qwen3', 'clip']);
 assert.equal(fitHubFiles(info({ arch: 'future-architecture' }), [file()], machineProfile(machine()), undefined, support)[0].fit, 'unsupported');
});

test('CPU, integrated and dedicated recommendations respect available memory without double counting', () => {
 const cpu = liveProfile(machineProfile(machine({ totalMemoryBytes: 8 * GiB })), 3 * GiB);
 assert.ok(cpu.ceilingBytes <= 2 * GiB); assert.equal(cpu.availableRamBytes, cpu.ceilingBytes);
 const ig = machine({ gpuName: 'Intel Arc 140T', gpuMemoryBytes: 16 * GiB }), p = liveProfile(machineProfile(ig, { at: 1, ramGBs: 80 }), 10 * GiB);
 assert.equal(p.gpu, 'shared'); assert.ok(p.fastBytes < 8 * GiB);
 const native = advisorProfile(ig, p); assert.equal(native.hardware.unified_memory, true); assert.ok(native.hardware.total_ram_gb < 8);
 assert.equal(native.hardware.ddr_bandwidth_gbps, 80);
 const dedicated = liveProfile(machineProfile(machine({ gpuName: 'NVIDIA RTX 4090', gpuMemoryBytes: 24 * GiB })), 3 * GiB);
 assert.ok(dedicated.fastBytes > 20 * GiB); assert.ok(dedicated.availableRamBytes < 1 * GiB);
});

test('Hub facts override old tool, license, context and parameter metadata', () => {
 const seed = seedFromHub(info({ tools: false, license: 'apache-2.0', baseModel: 'Qwen/Tiny', context: 8192 }), LLM_SEEDS[0]);
 assert.equal(seed.tools, false); assert.equal(seed.license, 'apache-2.0'); assert.equal(seed.ctx, 8192); assert.equal(seed.params, 1.7); assert.equal(seed.modelId, 'Qwen/Tiny');
 assert.equal(seedFromHub(info({ tools: undefined }), { ...LLM_SEEDS[0], tools: true }).tools, false, 'catalog tags do not confirm a new build supports tools');
 assert.equal(modelKey('unsloth/Tiny-GGUF'), modelKey('Qwen/Tiny'));
});

test('exact file ratings include projector, context, disk, F16 and low RAM', () => {
 const p = machineProfile(machine({ gpuName: 'Intel Arc 140T' }));
 const files = [file(), file(3.4 * GiB, { name: 'Tiny-F16.gguf', quant: 'F16' }), file(.4 * GiB, { name: 'mmproj-Q8_0.gguf', mmproj: true, quant: 'Q8_0' })];
 let rated = fitHubFiles(info({ vision: true }), files, p);
 assert.ok(rated[0].rating.downloadBytes > files[0].sizeBytes); assert.equal(rated[0].projectorBytes, files[2].sizeBytes); assert.equal(rated[1].fit, 'fits'); assert.ok(rated[0].recommended);
 assert.equal(fitHubFiles(info({ vision: true }), [file()], p)[0].fit, 'too-large');
 assert.equal(fitHubFiles(info(), [file()], { ...p, diskBytes: 1 })[0].fit, 'too-large');
 assert.equal(fitHubFiles(info(), [file()], liveProfile(p, GiB))[0].fit, 'too-large');
});

test('checked builds replace estimated curated cards without duplicate repositories', () => {
 const s = LLM_SEEDS[0], checked = { ...s, source: 'llmfit', verified: true, files: [file(1.2 * GiB)] };
 const rows = catalogFor('coding', machineProfile(machine()), { strict: false, fresh: [checked] });
 assert.equal(rows.filter(r => r.repo === s.repo).length, 1); assert.equal(rows.find(r => r.repo === s.repo).verified, true);
});

test('Hub browsing includes checked catalog builds, respects search and pagination, and rates exact files', async () => {
 const s = { ...seedFromHub(info({ arch: 'qwen3' })), q4Gb: 90, files: [file(.5 * GiB)] };
 const merged = hubSearchModels([s], [info(), info({ id: 'Qwen/Other-GGUF' })], '', 'gguf');
 assert.equal(merged.length, 2); assert.equal(merged.filter(m => m.id === s.repo).length, 1);
 const popular = hubSearchModels([s], [info({ gated: true, downloads: 100 }), info({ id: 'Qwen/Popular-GGUF', downloads: 999 })], '', 'gguf');
 assert.equal(popular[0].id, 'Qwen/Popular-GGUF'); assert.equal(popular[1].gated, true); assert.equal(popular[1].downloads, 100);
 const trending = hubSearchModels([s], [info({ id: 'Qwen/Trending-GGUF' })], '', 'gguf', undefined, false, 'trendingScore');
 assert.equal(trending[0].id, 'Qwen/Trending-GGUF'); assert.equal(trending[1].id, s.repo);
 assert.equal(hubSearchModels([s], [], 'not-found', 'gguf').length, 0);
 assert.equal(hubSearchModels([s], [], '', 'gguf', { max: 1e9 }).length, 0);
 assert.equal(hubSearchModels([s], [], '', 'gguf', undefined, true).length, 0);
 const support = await nativeSupport(os.tmpdir()), p = machineProfile(machine());
 const rating = rateHubSearch(merged[0], s, p, support); assert.equal(rating.fit, 'fits'); assert.equal(rating.evidence, 'checked-build'); assert.ok(rating.rating.downloadBytes < GiB);
 assert.equal(rateHubSearch(info({ format: 'safetensors' }), undefined, p, support).fit, 'build-needed');
 assert.equal(rateHubSearch(info({ arch: 'future-model' }), s, p, support).fit, 'unsupported');
});

test('paginated trees require every shard; authenticated cursors stay on the Hub', async () => {
 const revision = 'a'.repeat(40), payload = Buffer.from('a complete GGUF fixture'), hash = crypto.createHash('sha256').update(payload).digest('hex');
 let base, downloads = 0;
 const server = http.createServer((req, res) => {
  const u = new URL(req.url, base);
  if (u.pathname === '/api/models') { if (!u.searchParams.has('cursor')) res.setHeader('Link', `<${base}/api/models?cursor=next>; rel="next"`); res.end(JSON.stringify([{ id: 'Qwen/Tiny-GGUF', tags: ['gguf'] }])); return; }
  if (u.pathname.includes('/tree/')) {
   assert.equal(req.headers.authorization, 'Bearer test-token');
   if (!u.searchParams.has('cursor')) { res.setHeader('Link', `<${base}${u.pathname}?cursor=next>; rel="next"`); res.end(JSON.stringify([{ type: 'file', path: 'full-Q4_K_M-00001-of-00002.gguf', size: 10 }, { type: 'file', path: 'missing-Q4_K_M-00001-of-00002.gguf', size: 10 }])); }
   else res.end(JSON.stringify([{ type: 'file', path: 'full-Q4_K_M-00002-of-00002.gguf', size: 20 }, { type: 'file', path: 'Tiny-Q4_K_M.gguf', size: payload.length, lfs: { size: payload.length, oid: hash } }]));
   return;
  }
  if (u.pathname.includes('/resolve/')) { downloads++; assert.ok(u.pathname.includes('/' + revision + '/')); res.setHeader('Content-Length', payload.length); res.end(payload); return; }
  res.statusCode = 404; res.end();
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
 const prior = process.env.HF_ENDPOINT, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-hf-integrity-'));
 process.env.HF_ENDPOINT = base; E.setHfToken('test-token');
 try {
  const page = await E.searchHfPage('tiny'); assert.ok(page.cursor); assert.equal((await E.searchHfPage('tiny', 'downloads', 40, 'gguf', undefined, page.cursor)).items.length, 1);
  await assert.rejects(E.searchHfPage('', 'downloads', 40, 'gguf', undefined, 'https://example.com/api/models'), /Invalid/);
  const files = await E.hfFiles('Qwen/Tiny-GGUF', revision); assert.equal(files.length, 2); assert.equal(files.find(f => f.name.startsWith('full')).sizeBytes, 30); assert.ok(!files.some(f => f.name.startsWith('missing')));
  const metadata = files.find(f => f.name === 'Tiny-Q4_K_M.gguf').metadata[0], dest = path.join(dir, 'model.gguf');
  await E.verifiedHfDownload('Qwen/Tiny-GGUF', metadata, revision, dest, () => {}, new AbortController().signal); assert.deepEqual(fs.readFileSync(dest), payload);
  await E.verifiedHfDownload('Qwen/Tiny-GGUF', metadata, revision, dest, () => {}, new AbortController().signal); assert.equal(downloads, 1);
  fs.writeFileSync(dest, Buffer.alloc(payload.length, 1)); await E.verifiedHfDownload('Qwen/Tiny-GGUF', metadata, revision, dest, () => {}, new AbortController().signal); assert.equal(downloads, 2);
  fs.rmSync(dest); await assert.rejects(E.verifiedHfDownload('Qwen/Tiny-GGUF', { ...metadata, sha256: '0'.repeat(64) }, revision, dest, () => {}, new AbortController().signal), /checksum/); assert.ok(!fs.existsSync(dest));
 } finally { E.setHfToken(undefined); if (prior === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prior; await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('local model scanning hides incomplete shards and downloads awaiting a projector', () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-complete-model-'));
 const name = 'Discovery-fixture-Q4_K_M-00001-of-00002.gguf';
 try {
  fs.writeFileSync(path.join(dir, name), 'first');
  assert.ok(!E.scanGguf(dir).some(m => m.id.startsWith('Discovery-fixture')));
  fs.writeFileSync(path.join(dir, name.replace('00001-of', '00002-of')), 'second');
  assert.ok(E.scanGguf(dir).some(m => m.id.startsWith('Discovery-fixture')));
  fs.writeFileSync(path.join(dir, '.pending-' + name + '.json'), '{}');
  assert.ok(!E.scanGguf(dir).some(m => m.id.startsWith('Discovery-fixture')));
  fs.rmSync(path.join(dir, '.pending-' + name + '.json'));
  assert.equal(E.scanGguf(dir).find(m => m.id.startsWith('Discovery-fixture')).sizeBytes, 11);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('discovery enriches multiple models, saves results and survives Hub outages', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-discovery-')), m = machine(), discovery = new ModelDiscovery(dir, () => m, () => machineProfile(m));
 discovery.advisor.recommendations = async () => [];
 discovery.info = async repo => info({ id: repo, params: 3e9, revision: 'a'.repeat(40) }); discovery.files = async () => [file()];
 const prior = process.env.HF_ENDPOINT; process.env.HF_ENDPOINT = 'http://127.0.0.1:1';
 try {
  await discovery.refresh(() => {}); assert.ok(discovery.current().length > 24); assert.ok(discovery.state().offline); assert.ok(!discovery.state().loading);
  const copy = new ModelDiscovery(dir, () => m, () => machineProfile(m)); assert.equal(copy.current().length, discovery.current().length); copy.dispose();
 } finally { discovery.dispose(); if (prior === undefined) delete process.env.HF_ENDPOINT; else process.env.HF_ENDPOINT = prior; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('download preflight ignores forged sizes and does not enable an oversized model', async () => {
 const { LocalModelsHost } = require(path.join(out,'host/localModelsHost'));
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-hf-preflight-')), statuses = [], enabled = [];
 let installs = 0;
 const host = { storageDir: dir, modelsDir: path.join(dir, 'models'), jobs: new Map(), progress: () => {}, ensureEngine: () => installs++, machine: () => machine({ totalMemoryBytes: 2 * GiB }), settings: () => ({ lightKv: true }), engineOptions: () => ({ gpu: 'cpu' }),
  catalog: { discovery: { info: async () => info({ arch: 'qwen3' }), support: () => nativeSupport(dir), find: () => undefined, files: async () => [file(80 * GiB, { metadata: [{ path: 'Tiny-Q4_K_M.gguf', size: 80 * GiB }] })] } },
  ctx: { status: s => statuses.push(s), postAll: () => {} }, snapshot: async () => {}, toggle: async id => enabled.push(id) };
 try { await LocalModelsHost.prototype.hfDownload.call(host, {}, 'Qwen/Tiny-GGUF', file(1), 'engine'); assert.equal(installs, 0); assert.equal(enabled.length, 0); assert.ok(statuses.some(s => /available memory/.test(s))); assert.ok(!fs.existsSync(host.modelsDir)); }
 finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Hugging Face numbers read from a projector or a draft head are not the model\'s', () => {
 assert.deepEqual(E.ggufOfModel('cdiamond/Qwen3.8-27B-iMatrix-NVFP4-MTP-GGUF', { total: 460730096, architecture: 'clip' }), {}, 'a vision projector');
 assert.deepEqual(E.ggufOfModel('unsloth/gemma-4-26B-A4B-it-GGUF', { total: 0.46e9, architecture: 'gemma4' }), {}, 'far below the count in the name');
 assert.deepEqual(E.ggufOfModel('Qwen/Qwen3-8B-GGUF', { total: 8.19e9, architecture: 'qwen3', context_length: 40960 }), { total: 8.19e9, architecture: 'qwen3', context: 40960 });
 assert.deepEqual(E.ggufOfModel('mudler/locate-anything.cpp-gguf', { total: 3.8e9, architecture: 'locateanything' }).architecture, 'locateanything', 'no count in the name: the header stands');
});

test('bundled native advisor accepts the generated shared-memory profile offline', async () => {
 if (process.platform !== 'win32' || process.arch !== 'x64') return;
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-advisor-native-'));
 const advisor = new LocalAdvisor(dir), m = machine({ gpuName: 'Intel Arc 140T' });
 try { const fits = await advisor.recommendations(m, machineProfile(m)); assert.ok(!advisor.error, advisor.error); assert.ok(fits.length > 0); assert.ok(fits.every(f => Number.isFinite(f.score) && f.quant)); }
 finally { advisor.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('raw main-model chunks are counted together and never replaced by the small DFlash helper', async () => {
 const tree=[
  {type:'file',path:'MiMo-V2.6-Pro-RL-DFlash-Q8_0.gguf',size:2941587648},
  {type:'file',path:'MiMo-V2.6-Pro-RL-MXFP4.gguf.part2',size:77146510560},
  {type:'file',path:'MiMo-V2.6-Pro-RL-MXFP4.gguf.part1',size:480000000000}
 ];
 const server=http.createServer((req,res)=>res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(tree)));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const previous=process.env.HF_ENDPOINT;process.env.HF_ENDPOINT=`http://127.0.0.1:${server.address().port}`;
 try {
  const files=await E.hfFiles('kernelpool/MiMo-V2.6-Pro-RL-MXFP4-GGUF');
  assert.equal(files.length,1);assert.equal(files[0].sizeBytes,557146510560);assert.equal(files[0].assembly,true);
  assert(files[0].parts[0].endsWith('.part1')); assert.equal(E.safeGgufParts(files[0].parts),undefined,'chunks cannot enter the native download path');
  assert.deepEqual(E.ggufOfModel('kernelpool/MiMo-V2.6-Pro-RL-MXFP4-GGUF',{architecture:'dflash',total:3e9,context_length:1048576}),{});
  const rated=fitHubFiles(info({arch:'qwen3'}),files,machineProfile(machine()),undefined,{version:'test',exact:true,architectures:['qwen3']});
  assert.equal(rated[0].fit,'unsupported'); assert.match(rated[0].reason,/raw.*chunks/); assert.equal(rated[0].recommended,false);
  assert.deepEqual(fitHubFiles(info({arch:'dflash'}),[file()],machineProfile(machine())),[]);
 } finally {if(previous===undefined)delete process.env.HF_ENDPOINT;else process.env.HF_ENDPOINT=previous;await new Promise(r=>server.close(r));}
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } } process.exitCode = failed ? 1 : 0; })();
