'use strict';
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { LocalHostServer, newKey } = require('../out/localHostServer');
const { LocalCatalogHost } = require('../out/host/localCatalogHost');
const { machineCapacity } = require('../out/localModels');
const { machineProfile, quantSpec } = require('../out/localCatalog');
const { nativeSupport, parseTensorTypes, quantizationReason } = require('../out/nativeSupport');
const { fitHubFiles, seedFromAdvisor } = require('../out/modelDiscovery');
const { parseMetrics, LiveMonitor } = require('../out/localLive');
const { measureBandwidth } = require('../out/machineCheck');
const { ollamaAsset, managedOllama } = require('../out/ollamaSetup');
const { localHelper } = require('../out/host/localRouting');
const tests = [], test = (name, run) => tests.push([name, run]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-hardware-'));
const listen = async fn => { const s = http.createServer(fn); await new Promise(r => s.listen(0, '127.0.0.1', r)); return s; };
const close = s => new Promise(r => { s.closeAllConnections(); s.close(r); });
const delay = ms => new Promise(r => setTimeout(r, ms));
const machine = machineCapacity({ platform: 'win32', cpu: 'Fixture CPU', cores: 8, totalMemoryBytes: 32 * 1024 ** 3, freeDiskBytes: 200e9 });
const info = { id: 'Qwen/Fixture-GGUF', author: 'Qwen', params: 1.7e9, context: 32768, arch: 'qwen3', tools: false, tags: ['gguf'], format: 'gguf', downloads: 1, likes: 0 };
const file = { name: 'Fixture-MXFP4.gguf', quant: 'MXFP4', sizeBytes: 1.2e9, parts: ['Fixture-MXFP4.gguf'] };

test('all supported weight families are estimated from exact GGUF sizes, with unsupported types refused', async () => {
 const support = await nativeSupport(dir), p = machineProfile(machine);
 assert(support.tensorTypes.includes('MXFP4') && support.tensorTypes.includes('NVFP4'));
 for (const quant of ['MXFP4','NVFP4','F32','F16','BF16','Q1_0','Q2_0','TQ1_0','TQ2_0','IQ2_XXS','IQ4_NL','UD-Q4_K_XL']) {
  assert(quantSpec(quant), quant);
  const r = fitHubFiles(info,[{...file, quant}],p,undefined,support)[0];
  assert.equal(r.fit,'fits',quant); assert(r.rating.tokS > 0 && Number.isFinite(r.rating.util));
 }
 assert.equal(quantSpec('UNKNOWN'),undefined);
 assert.equal(fitHubFiles(info,[{...file,quant:'UNKNOWN'}],p,undefined,support)[0].fit,'unsupported');
 assert.match(quantizationReason('NVFP4',{version:'b7000',exact:true,architectures:['qwen3'],tensorTypes:['F16']}),/not available/);
 assert.deepEqual(parseTensorTypes('GGML_TYPE_F32 = 0, // GGML_TYPE_OLD = 1\n GGML_TYPE_NVFP4 = 40, GGML_TYPE_COUNT = 41'),['F32','NVFP4']);
 const row = {name:'Qwen/General',parameters_raw:1.7e9,context_length:8192,capabilities:[],gguf_sources:[{repo:'unsloth/General-GGUF'}]};
 assert.equal(seedFromAdvisor(row).tools,false);
});

test('hardware popup measures this machine, shares concurrent checks and rejects stale files and invalid repositories', async () => {
 const store = new Map(), messages=[], surface={kind:'local',post:m=>messages.push(m)};
 let refreshes=0;
 const host = new LocalCatalogHost({ctx:{store:{},postAll(){},status(){},sendState:async()=>{}}, storageDir:dir, memento:{get:(k,d)=>store.get(k)??d,update:async(k,v)=>store.set(k,v)}, machine:refresh=>{if(refresh)refreshes++;return machine;},gguf:()=>[],measurements:()=>[],freeMemory:()=>20e9,jobs:new Map(),progress(){},download:async()=>{},chat:async()=>{},speeds:()=>({}),refresh:async()=>{}});
 host.discovery.scan=async()=>({info,files:[file],offline:false}); host.discovery.builds=async()=>[];
 try {
  await Promise.all(['one','two'].map(rid=>host.handle(surface,{type:'modelHardwareCheck',id:info.id,rid})));
  assert.equal(refreshes,1,'only one benchmark for concurrent popups');
  const result=messages.find(m=>m.rid==='one'&&m.done); assert(result.check.ramGBs>0); assert.equal(result.selected.fit,'fits'); assert(result.selected.rating.util>0);
  assert.equal(result.measurement,undefined,'bandwidth measurements never become inference measurements');
  const check=host.check(); assert(check.hardware); store.set('zer0ne.local.machineCheck',{...check,hardware:'another-machine'}); assert.equal(host.check(),undefined);
  await host.handle(surface,{type:'modelHardwareCheck',id:'../../etc',rid:'invalid'}); assert(messages.find(m=>m.rid==='invalid'&&m.error));
  await host.handle(surface,{type:'modelHardwareCheck',id:info.id,file:'gone.gguf',rid:'gone'}); assert.match(messages.find(m=>m.rid==='gone'&&m.done).error,/no longer/);
 } finally {host.dispose();}
 const bw=await measureBandwidth({threads:1,ms:30,mb:8}); assert(bw.gbs>0);
});

test('router validates JSON, selects backend namespaces, forwards default models and records upstream failures', async () => {
 const seen=[], activity=[];
 const upstream=await listen((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{seen.push(JSON.parse(raw).model);res.statusCode=seen.at(-1)==='bad'?503:200;res.end(JSON.stringify({ok:res.statusCode===200}));});});
 const host=new LocalHostServer({models:async()=>({engine:['same','bad'],ollama:['same']}),ensureEngine:async()=>upstream.address().port,ollamaBase:()=>`http://127.0.0.1:${upstream.address().port}/v1`,embedPort:async()=>undefined,onActivity:e=>activity.push(e)});
 const key=newKey();await host.start({enabled:true,port:0,lan:false,key});const base=`http://127.0.0.1:${host.server.address().port}/v1`,headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const ask=body=>fetch(base+'/chat/completions',{method:'POST',headers,body:JSON.stringify(body)});
 try {
  for(const body of [null,[],{model:34}])assert.equal((await ask(body)).status,400);
  assert.equal((await fetch(base+'/status')).status,401);
  for(const body of [{},{model:'engine/same'},{model:'ollama/same'}]){const r=await ask(body);assert.equal(r.status,200);await r.text();}
  assert.deepEqual(seen,['same','same','same']);
  const failed=await ask({model:'bad'});assert.equal(failed.status,503);await failed.text();await delay(20);assert.equal(activity.at(-1).ok,false);
  const ids=(await(await fetch(base+'/models',{headers})).json()).data.map(m=>m.id);assert.equal(new Set(ids).size,ids.length);assert(ids.includes('engine/same')&&ids.includes('ollama/same'));
  const status=await(await fetch(base+'/status',{headers})).json();assert.equal(status.active,0);assert.equal(status.queued,0);
 } finally {await host.stop();await close(upstream);}
});

test('cancelled queued requests never load a model and stopping the router releases streams', async () => {
 let release; const blocked=new Promise(r=>release=r), loads=[];
 const upstream=await listen((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200);res.write('started');});});
 const host=new LocalHostServer({models:async()=>({engine:['first','cancelled'],ollama:[]}),ensureEngine:async(m,signal)=>{loads.push(m);await blocked;signal.throwIfAborted();return upstream.address().port;},ollamaBase:()=>'',embedPort:async()=>undefined,onActivity(){}});
 const key=newKey();await host.start({enabled:true,port:0,lan:false,key});const base=`http://127.0.0.1:${host.server.address().port}/v1/chat/completions`,headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
 const first=fetch(base,{method:'POST',headers,body:'{"model":"first"}'}).catch(()=>undefined);
 try {
  while(!loads.length)await delay(5);
  const ctl=new AbortController(),second=fetch(base,{method:'POST',headers,body:'{"model":"cancelled"}',signal:ctl.signal}).catch(()=>undefined);
  while(host.queued<1)await delay(5);ctl.abort();await second;await delay(30);release();
  const result=await first;assert(result);await host.stop();await result.text().catch(()=>undefined);await delay(30);assert.deepEqual(loads,['first']);
 } finally {release();await host.stop();await close(upstream);}
});

test('Activity sums slot counters, ignores NaN, and does not report engine-off as idle inference', async () => {
 assert.deepEqual(parseMetrics('llamacpp:tokens_predicted_total{slot="0"} 10\nllamacpp:tokens_predicted_total{slot="1"} 7\nllamacpp:kv_cache_usage_ratio NaN'),{tokens_predicted_total:17});
 const samples=[],monitor=new LiveMonitor(()=>undefined,s=>samples.push(s));monitor.start();await delay(60);monitor.stop();assert(samples.length);assert.equal(samples[0].engineOn,false);assert.equal(samples[0].metricsAvailable,false);assert(samples[0].ramTotalBytes>0);
});

test('portable Ollama setup selects official builds per platform and never uses incomplete installs', () => {
 assert.equal(ollamaAsset('win32','x64'),'ollama-windows-amd64.zip');assert.equal(ollamaAsset('win32','arm64'),'ollama-windows-arm64.zip');assert.equal(ollamaAsset('darwin','arm64'),'ollama-darwin.tgz');assert.equal(ollamaAsset('linux','x64'),'ollama-linux-amd64.tar.zst');assert.equal(ollamaAsset('win32','ia32'),undefined);
 const root=path.join(dir,'ollama');fs.mkdirSync(path.join(root,'runtime'),{recursive:true});fs.writeFileSync(path.join(root,'runtime','ollama.exe'),'fixture');assert.equal(managedOllama(root),undefined);fs.writeFileSync(path.join(root,'runtime','.ready'),'official build checked');assert(managedOllama(root));
});

test('automatic Ollama installation verifies checksums and executable startup before publishing readiness', async () => {
 const cp=require('child_process'),runtime=require('../out/ollamaSetup'),downloads=require('../out/localEngine'),models=require('../out/localModels'),crypto=require('crypto');
 const original={fetch:global.fetch,download:downloads.download,execFile:cp.execFile,ollamaBinary:models.ollamaBinary,freeDisk:models.freeDisk};
 const name=ollamaAsset(),archive=Buffer.from('Official archive fixture'),digest='sha256:'+crypto.createHash('sha256').update(archive).digest('hex');
 let checksum=digest,unsafe=false,startupFails=false,unpacks=0,versions=0;
 const asset={name,size:archive.length,digest,browser_download_url:'https://github.com/ollama/ollama/releases/download/v-fixture/'+name};
 try {
  models.ollamaBinary=()=>undefined;models.freeDisk=()=>20e9;
  global.fetch=async()=>({ok:true,json:async()=>({assets:[{...asset,digest:checksum}]})});
  downloads.download=async(url,file,progress,signal)=>{signal.throwIfAborted();assert.equal(url,asset.browser_download_url);fs.writeFileSync(file,archive);};
  cp.execFile=(command,args,options,callback)=>{
   if(args[0]==='-tf')callback(null,unsafe?'../escape\n':'ollama.exe\n','');
   else if(args[0]==='-xf'){unpacks++;fs.writeFileSync(path.join(args[3],'ollama.exe'),'executable fixture');callback(null,'','');}
   else {versions++;assert.deepEqual(args,['--version']);callback(startupFails?new Error('Cannot start on this hardware'):null,'ollama fixture','');}
  };
  const install=folder=>runtime.ensureOllama(path.join(dir,folder),()=>{},new AbortController().signal);
  checksum='sha256:'+'0'.repeat(64);
  await assert.rejects(install('bad-checksum'),/could not be verified/);assert.equal(unpacks,0);
  checksum=digest;unsafe=true;
  await assert.rejects(install('unsafe-archive'),/unsafe path/);assert.equal(unpacks,0);
  unsafe=false;startupFails=true;
  await assert.rejects(install('unsupported-binary'),/Cannot start/);assert.equal(managedOllama(path.join(dir,'unsupported-binary')),undefined);
  startupFails=false;
  const binary=await install('verified-install');assert(fs.existsSync(binary));assert.equal(versions,2);assert.equal(managedOllama(path.join(dir,'verified-install')),binary);
  const count=unpacks;assert.equal(await install('verified-install'),binary);assert.equal(unpacks,count,'ready runtime is reused');
 } finally {global.fetch=original.fetch;downloads.download=original.download;cp.execFile=original.execFile;models.ollamaBinary=original.ollamaBinary;models.freeDisk=original.freeDisk;}
});

test('local assistant never routes to disabled or cloud models and reserves research for tool-capable models', async () => {
 const provider={id:'local',enabled:true,baseUrl:'http://127.0.0.1:8181/v1',apiFormat:'openai',models:[{id:'tiny',enabled:true,tools:false}]};
 const store={getSettings:()=>({localHelper:'local::tiny',localHelperTasks:'text,compaction,subagents'}),list:async()=>[provider],getApiKey:async()=>''};
 assert(await localHelper(store,'text')); assert.equal(await localHelper(store,'subagents'),undefined);
 provider.models[0].enabled=false; assert.equal(await localHelper(store,'text'),undefined);
 provider.models[0].enabled=true; provider.baseUrl='https://example.com/v1'; assert.equal(await localHelper(store,'text'),undefined);
});

test('background local-model paints are coalesced and do not depend on animation frames', async () => {
 const ts=require('typescript-classic'),vm=require('vm'),source=require('./page-scripts').readPage('settings.js');
 const ast=ts.createSourceFile('settings.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let code;
 const visit=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='renderLocal')code=node.getText(ast);ts.forEachChild(node,visit);};visit(ast);assert(code);
 let paints=0;const context={S:{open:true,section:'local'},setTimeout,clearTimeout,requestAnimationFrame:()=>1,cancelAnimationFrame(){},renderPage:()=>paints++};
 vm.createContext(context);vm.runInContext('let localFrame=0,localTimer=0;\n'+code,context);
 context.renderLocal();context.renderLocal();await delay(150);assert.equal(paints,1,'background paints are coalesced and do not depend on RAF');
});

(async()=>{let failed=0;for(const[name,run]of tests){try{await run();console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name,e);}}fs.rmSync(dir,{recursive:true,force:true});process.exitCode=failed?1:0;})().catch(e=>{console.error(e);process.exitCode=1;});
