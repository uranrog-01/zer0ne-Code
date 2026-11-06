const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readModelShape, fitModel } = require('../out/modelFit');
const { machineCapacity } = require('../out/localModels');
const { EngineServer } = require('../out/localEngine');
const { applyTuning, tuneModel, tuneKey, probeModelSpeed } = require('../out/localTune');
const GiB = 1024 ** 3;
const tests = [];
const test = (name, run) => tests.push([name, run]);
const machine = (patch = {}) => machineCapacity({ platform: 'win32', cpu: 'test CPU', cores: 16, totalMemoryBytes: 32 * GiB, gpuName: 'Intel Arc 140T', unifiedMemory: false, ...patch });
const input = (patch = {}) => ({ name: 'Coder-8B', sizeBytes: 5 * GiB, machine: machine(), freeMemoryBytes: 25 * GiB, context: 32768, lightKv: true, shape: { layers: 32, context: 32768, kvBytesPerToken: 32768 }, ...patch });

test('GGUF header provides actual layers, KV dimensions, context and expert counts', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shape-'));
	const u32 = n => { const b=Buffer.alloc(4); b.writeUInt32LE(n); return b; };
	const u64 = n => { const b=Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
	const str = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
	const data = [['general.architecture','qwen2'], ['qwen2.block_count',32], ['qwen2.context_length',131072], ['qwen2.embedding_length',4096], ['qwen2.attention.head_count',32], ['qwen2.attention.head_count_kv',8], ['qwen2.expert_count',8], ['qwen2.expert_used_count',2]];
	const file = path.join(dir,'model.gguf');
	try {
		fs.writeFileSync(file,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(data.length),...data.map(([k,v])=>Buffer.concat([str(k),u32(typeof v==='string'?8:4),typeof v==='string'?str(v):u32(v)]))]));
		assert.deepStrictEqual(readModelShape(file), { context:131072,layers:32,kvBytesPerToken:131072,experts:8,expertsUsed:2,arch:'qwen2' });
		assert.deepStrictEqual(readModelShape(file),readModelShape(file));
		fs.writeFileSync(file,'invalid'); assert.deepStrictEqual(readModelShape(file),{});
		assert.deepStrictEqual(readModelShape(path.join(dir,'missing')),{});
	} finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('fits any hardware, never counts integrated VRAM twice, adapts to live memory and projector size', () => {
	const first = fitModel(input());
	assert.ok(first.fits && first.context===32768);
	const shared = fitModel(input({ machine:machine({gpuMemoryBytes:16*GiB}) }));
	assert.strictEqual(first.budgetBytes,shared.budgetBytes);
	const constrained = fitModel(input({freeMemoryBytes:7*GiB}));
	assert.ok(!constrained.fits || constrained.context < first.context);
	const vision = fitModel(input({projectorBytes:2*GiB}));
	assert.ok(vision.memoryBytes>first.memoryBytes || vision.context<first.context);
	for (const m of [machine({totalMemoryBytes:8*GiB,gpuName:undefined,cores:4}), machine({gpuName:'NVIDIA RTX 4060',gpuMemoryBytes:8*GiB}), machine({platform:'darwin',gpuName:'Apple M3 Max',unifiedMemory:true,totalMemoryBytes:64*GiB})]) {
		const p = fitModel(input({machine:m,freeMemoryBytes:m.totalMemoryBytes*.8}));
		assert.ok(p.threads>=1 && p.threads<=m.cores && p.ubatch<=512);
		if(p.fits) assert.ok(p.memoryBytes<=p.budgetBytes);
	}
});

test('quantized caches, explicit contexts and GGUF limits are budgeted accurately', () => {
	const small = input({sizeBytes:1*GiB,shape:{context:8192,kvBytesPerToken:262144}});
	const q8 = fitModel(small), f16=fitModel({...small,lightKv:false});
	assert.strictEqual(q8.context,8192); assert.strictEqual(f16.context,8192);
	assert.ok(q8.memoryBytes<f16.memoryBytes);
	assert.strictEqual(f16.kv,'f16');
	const tight=fitModel(input({sizeBytes:1*GiB,freeMemoryBytes:5*GiB,context:2048,shape:{kvBytesPerToken:2*GiB/2048},turbo:true}));
	assert.ok(tight.fits && tight.kv==='q4_0',JSON.stringify(tight));
});

test('expert offload uses real layers on discrete GPUs and avoids CPU contention on shared GPUs', () => {
	const opts=input({name:'Coder-30B-A3B',sizeBytes:18*GiB,shape:{layers:28,experts:64,expertsUsed:8,kvBytesPerToken:32768},context:8192});
	const shared=fitModel(opts); assert.strictEqual(shared.cpuExpertLayers,0);
	const discrete=fitModel({...opts,machine:machine({gpuName:'RTX 4060',gpuMemoryBytes:8*GiB})});
	assert.ok(discrete.fits && discrete.cpuExpertLayers>0 && discrete.cpuExpertLayers<=28);
});

test('retry contexts stay below a small requested window; CPU fallback preserves vision', () => {
	const p=fitModel(input({context:2048}));
	const opts={context:2048,gpu:'auto',lightKv:true,port:8181,fitMarginMiB:2048,cacheRamMiB:512,fit:p};
	const model={id:'test',path:'test.gguf',sizeBytes:10,mmproj:'projector.gguf'};
	for(let attempt=0;attempt<3;attempt++) {
		const a=new EngineServer(()=>{}).args(model,opts,attempt);
		assert.ok(Number(a[a.indexOf('--fit-ctx')+1])<=2048);
		assert.ok(Number(a[a.indexOf('-c')+1])<=2048);
		assert.ok(a.includes('--mmproj'));
		if(attempt===2) assert.ok(a.includes('--no-mmproj-offload'));
	}
});

test('tuning saves measurable improvements, keeps noisy baselines, skips failures and honours cancellation', async () => {
	const plan=fitModel(input()); let current, starts=[];
	const tune=(speed)=>tuneModel(plan,{stage:()=>{},start:async c=>{current=c;starts.push(c);},probe:async()=>speed(current)});
	const better=await tune(c=>({tokS:c.threads===1?60:30,promptTokS:200}));
	assert.strictEqual(better.threads,1); assert.ok(better.gain>1.15); assert.strictEqual(better.kept,'1 thread'); assert.strictEqual(starts.at(-1).threads,1);
	const noise=await tune(c=>({tokS:c.threads===1?31:30,promptTokS:200})); assert.strictEqual(noise.gain,1);
	const badPrefill=await tune(c=>({tokS:c.threads===1?60:30,promptTokS:c.threads===1?50:200})); assert.strictEqual(badPrefill.gain,1);
	const failure=await tune(c=>{if(c.threads===1)throw Error('failed');return {tokS:30,promptTokS:200};});assert.strictEqual(failure.gain,1);
	const ctl=new AbortController();ctl.abort();await assert.rejects(tuneModel(plan,{signal:ctl.signal,stage:()=>{},start:async()=>{},probe:async()=>({tokS:30,promptTokS:200})}));
	assert.notStrictEqual(tuneKey(['machine A','runtime 1']),tuneKey(['machine B','runtime 1']));
});

test('speed probe uses unique uncached prompts and rejects tiny outputs', async () => {
	const previous=global.fetch, prompts=[];
	try {
		global.fetch=async (url,o)=>{const b=JSON.parse(o.body); assert.ok(String(url).endsWith('/v1/chat/completions'),'a chat request, so the model answers through its own template'); prompts.push(b.messages[0].content);assert.strictEqual(b.cache_prompt,b.messages.length>1,'the first read is uncached, the follow-up turn reuses it');assert.strictEqual(b.max_tokens,96);assert.strictEqual(b.model,'model');return {ok:true,json:async()=>({timings:{predicted_n:96,predicted_per_second:40,prompt_per_second:200}})};};
		assert.deepStrictEqual(await probeModelSpeed('http://127.0.0.1:8181','model',new AbortController().signal),{tokS:40,promptTokS:200});
		await probeModelSpeed('http://127.0.0.1:8181','model',new AbortController().signal);assert.strictEqual(prompts.length,4);assert.strictEqual(prompts[0],prompts[1],'the follow-up turn continues the same conversation');assert.notStrictEqual(prompts[0],prompts[2],'every probe is a new conversation');
		global.fetch=async()=>({ok:true,json:async()=>({timings:{predicted_n:1,predicted_per_second:40,prompt_per_second:200}})});
		await assert.rejects(probeModelSpeed('http://127.0.0.1:8181','model',new AbortController().signal));
	} finally { global.fetch=previous; }
});

test('saved tuning retains safe threads when available memory reduces the prompt batch', () => {
	const plan={...fitModel(input()),ubatch:128};
	assert.deepStrictEqual(applyTuning(plan,{threads:1,ubatch:512},16),{...plan,threads:1,ubatch:128});
	assert.strictEqual(applyTuning(plan,{threads:100,ubatch:512},16),plan);
	assert.strictEqual(applyTuning(plan,{threads:1,ubatch:10000},16),plan);
});

test('unsupported quantized caches retry in full precision', async () => {
	const server=new EngineServer(()=>{}), attempts=[];
	server.readCtx=async()=>2048;
	server.launch=async(_exe,model,options,attempt)=>{
		attempts.push(server.args(model,options,attempt));
		if(attempt===0){server.log='V cache quantization requires flash_attn';throw Error(server.log);}
	};
	await server.ensure('runner',{id:'test',path:'model.gguf',sizeBytes:1},{context:4096,gpu:'auto',lightKv:true,port:8181,cacheRamMiB:64,fitMarginMiB:1024});
	assert.strictEqual(attempts.length,2);
	assert.strictEqual(attempts[1][attempts[1].indexOf('-ctk')+1],'f16');
	assert.strictEqual(attempts[1][attempts[1].indexOf('-ctv')+1],'f16');
});

test('Engine exposes tuning with cancellation and fit details', () => {
	const ts=require('typescript-classic'),vm=require('vm'),{JSDOM}=require('jsdom');
	const source=require('./page-scripts').readPage('settings.js');
	const ast=ts.createSourceFile('settings.js',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS), declarations=[];
	const visit=node=>{
		if(ts.isFunctionDeclaration(node)&&['runtimesTab','runtimeDisclosure'].includes(node.name?.text))declarations.push(node.getText(ast));
		ts.forEachChild(node,visit);
	};visit(ast);
	const document=new JSDOM('').window.document;
	const S={}, context={S,h:(tag,cls,html)=>{const e=document.createElement(tag);e.className=cls;if(html)e.innerHTML=html;return e;},I:()=>'',esc:s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),gb:n=>(n/GiB).toFixed(1)+' GB',ctxLabel:n=>n/1024+'K',backendCompare:()=>'',localHostCard:()=>'',routingCard:()=>'',privateSearchCard:()=>'',lmsCard:()=>'',pullBar:()=>'',LOCAL_SERVERS:{}};
	vm.createContext(context);vm.runInContext(declarations.join('\n'),context);
	const engine={installed:true,running:true,model:'test',version:'b11169',backend:'vulkan',autoBackend:'vulkan',settings:{context:0,gpu:'auto',port:8181},run:{ctx:8192,gpu:'auto',loadMs:2000,attempt:0,fit:fitModel(input())}};
	const L={engine,machine:machine(),servers:[]};
	let page=context.runtimesTab(L);assert.ok(page.querySelector('[data-act="engine-tune"]'));assert.match(page.textContent,/q8_0 cache/);
	engine.tuning={stage:'Measuring <settings>'};page=context.runtimesTab(L);
	assert.ok(page.querySelector('[data-act="engine-tune-cancel"]'));assert.ok(!page.querySelector('[data-act="engine-tune"]'));assert.match(page.innerHTML,/&lt;settings&gt;/);
});

test('tuning blocks idle unload and model removal, while cancellation remains available', async () => {
	const {LocalPlus}=require('../out/host/localPlus');
	const {LocalModelsHost}=require('../out/host/localModelsHost');
	let busy=true,stops=0;
	const idle={idleMinutes:()=>5,benchRunning:new Set(),qualityRunning:new Map(),host:{active:0,queued:0},lastUse:Date.now()-600000,d:{engineRunning:()=>({model:'test'}),engineBusy:()=>busy,stopEngine:()=>stops++,ctx:{status:()=>{}}}};
	LocalPlus.prototype.idleCheck.call(idle);assert.strictEqual(stops,0);
	busy=false;idle.host.active=1;LocalPlus.prototype.idleCheck.call(idle);assert.strictEqual(stops,0);
	idle.host.active=0;idle.host.queued=1;LocalPlus.prototype.idleCheck.call(idle);assert.strictEqual(stops,0);
	idle.host.queued=0;LocalPlus.prototype.idleCheck.call(idle);assert.strictEqual(stops,1);
	const ctl=new AbortController(),host={tuning:{ctl},ctx:{status:()=>{}},plus:{handle:()=>{throw Error('Unsafe dispatch');}}};
	for(const type of ['catalogRemove','engineStop','hfConvert'])assert.strictEqual(await LocalModelsHost.prototype.handle.call(host,{}, {type}),true);
	await LocalModelsHost.prototype.handle.call(host,{}, {type:'engineTuneCancel'});assert.ok(ctl.signal.aborted);
});

(async()=>{let failed=0;for(const [name,run]of tests){try{await run();console.log('ok '+name);}catch(e){failed++;console.error('FAIL '+name,e);}}process.exitCode=failed?1:0;})();
