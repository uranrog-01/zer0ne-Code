'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), Module = require('module');
const OUT = path.join(__dirname, '../out');
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(req, ...rest) { return req === 'vscode' ? 'vscode' : resolveFilename.call(this, req, ...rest); };
require.cache.vscode = { id:'vscode', filename:'vscode', loaded:true, exports:{ env:{appHost:'desktop'}, workspace:{}, window:{createStatusBarItem:()=>({show(){},dispose(){}})}, StatusBarAlignment:{Right:2}, InlineCompletionTriggerKind:{Automatic:1} } };
const { streamChat, modelApiFormat } = require(OUT + '/chatClient');
const { ProviderStore } = require(OUT + '/providerStore');
const { ProvidersHost, customProviderInput } = require(OUT + '/host/providersHost');
const { AcpHost, pickModels, refreshAgentModels } = require(OUT + '/host/acpHost');
const { AcpRuntime, getAcpRuntime, setAcpRuntime } = require(OUT + '/acp/runtime');
const { signInAgent, readStatus, loginWithCommand } = require(OUT + '/acp/signIn');
const { loginTerminalSpec, openLoginTerminal } = require(OUT + '/host/loginTerminal');
const { PRESETS } = require(OUT + '/presets');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'zc-provider-fit-'));
const originalFetch = global.fetch;
const originalRuntime = getAcpRuntime();
function makeStore() {
 const state = new Map(), secrets = new Map();
 return new ProviderStore({globalState:{get:(k,f)=>state.has(k)?state.get(k):f,update:async(k,v)=>state.set(k,v)},secrets:{get:async k=>secrets.get(k),store:async(k,v)=>secrets.set(k,v),delete:async k=>secrets.delete(k)}});
}
const sse = events => new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
(async()=>{
 try {
  const registry=require(OUT+'/acp/registry');
  assert(registry.safeUvPackage('fast-agent-acp==0.10.1'));
  assert(registry.safeUvPackage('minion-code@0.1.44'));
  assert(!registry.safeUvPackage('agent==1;whoami'));
  assert.equal(registry.parseRegistry([{id:'uv-test',name:'UV test',version:'1',distribution:{uvx:{package:'fast-agent-acp==0.10.1'}}}]).length,1,'Python version pins are not npm package names');
  const families = {
   responses:['gpt-6-luna','gpt-5.6-luna','grok-4.5','grok-4.6','grok-4.7','muse-spark-1.3-contributor','muse-spark-1.2-contributor'],
   anthropic:['claude-haiku-5-5','minimax-m3','minimax-m2.7','qwen3.8-max','qwen3.8-flash','qwen3.7-plus'],
   openai:['minimax-m2.5','kimi-k3','kimi-k2.7-code','kimi-k2.6','longcat-2.0','kimi-k2.5','glm-5.2','glm-5.3-flash','glm-5.3','glm-5.1','glm-5','deepseek-v4-pro','deepseek-v4-flash','deepseek-flash','deepseek-v4.1-flash','deepseek-v4-flash-vision-exp','qwen3.7-max','qwen3.6-plus','qwen3.5-plus','mimo-v2-pro','mimo-v2-omni','mimo-v2.6-pro','mimo-v2.6-flash','longcat-2.5-preview-free','step-5-preview-free','mimo-v2.5-pro','mimo-v2.5','hy4-preview','hy3','hy3-preview','omen-alpha','space-bunny']
  };
  let request;
  global.fetch = async(url,init)=>{
   request = {url:String(url),body:JSON.parse(init.body),headers:new Headers(init.headers)};
   if(String(url).endsWith('/responses')) return sse([{type:'response.output_text.delta',delta:'Hello'},{type:'response.completed',response:{usage:{input_tokens:2,output_tokens:1}}}]);
   if(String(url).endsWith('/messages')) return sse([{type:'message_start',message:{usage:{input_tokens:2,output_tokens:0}}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}]);
   return sse([{choices:[{delta:{content:'Hello'},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}}]);
  };
  let models=0;
  for(const [format,ids] of Object.entries(families)) for(const model of ids) {
   const options={apiFormat:'openai',baseUrl:'https://opencode.ai/zen/go/v1/',model,apiKey:'test-only-key',system:'Say hello.',messages:[{role:'user',content:'hi'}],cacheKey:'same-conversation',signal:AbortSignal.timeout(5000),maxTokens:128};
   assert.equal(modelApiFormat(options),format,model);
   const result=await streamChat(options); assert.equal(result.text,'Hello',model);
   assert.equal(request.url,'https://opencode.ai/zen/go/v1/'+{responses:'responses',anthropic:'messages',openai:'chat/completions'}[format],model);
   assert.equal(request.headers.get('x-opencode-session'),'same-conversation');
   assert(request.headers.get('user-agent')?.includes('zer0ne'));
   assert.equal(result.usage.input,2); assert.equal(result.usage.output,1);
   if(format==='responses') { assert.equal(request.body.max_output_tokens,128); assert(!request.headers.has('chatgpt-account-id')); assert(!request.body.reasoning); }
   models++;
  }
  assert.equal(modelApiFormat({apiFormat:'openai',baseUrl:'https://api.example.com/v1',model:'claude-haiku-5-5'}),'openai','unrelated gateways keep the selected protocol');
  assert.equal(modelApiFormat({apiFormat:'anthropic',baseUrl:'https://opencode.ai/zen/go/v1',model:'gpt-6-luna'}),'anthropic','explicit format stays authoritative');
  console.log('PASS: '+models+' Go model routes, three streaming formats, usage and stable sessions (fixture requests).');

  const store=makeStore(), events=[], surface={post:m=>events.push(m)};
  const catalog={get:async id=>({id,baseUrl:'https://wrong-billing.example/v1',apiFormat:'openai',models:[]}),all:async()=>[],lookup:async()=>undefined};
  const host=new ProvidersHost({store,status(){},sendState:async()=>{}},catalog);
  global.fetch=async()=>new Response(JSON.stringify({data:[{id:'fixture-model'}]}),{headers:{'content-type':'application/json'}});
  let presets=0;
  for(const p of PRESETS.filter(p=>p.kind==='apiKey'&&/^https?:\/\//.test(p.baseUrl||''))) {
   await host.handle(surface,{type:'addPreset',presetId:p.id,apiKey:'test-only-key'});
   const saved=(await store.list()).find(x=>x.preset===p.id);
   assert(saved,p.id); assert.equal(saved.baseUrl,p.baseUrl,p.id+' must retain its own billing endpoint');
   assert.equal(saved.apiFormat,p.apiFormat||'openai',p.id);
   assert.equal(await store.getApiKey(saved.id),'test-only-key'); presets++;
  }
  for(const apiFormat of ['openai','responses','anthropic','gemini']) {
   assert.equal(customProviderInput({baseUrl:'https://example.com/v1',apiKey:'test-only-key',apiFormat}).apiFormat,apiFormat);
  }
  const generic=await store.add({name:'Responses',apiFormat:'responses',baseUrl:'https://example.com/v1',models:[]});
  assert.equal((await store.get(generic.id)).apiFormat,'responses','protocol survives storage');
  host.dispose(); console.log('PASS: '+presets+' preset creation flows keep their endpoint, key and protocol; four custom formats persist.');

  const entry={id:'mock-terminal',name:'Mock terminal',version:'1',description:'',authors:[],distribution:{npx:{package:'fixture'}}};
  const authFile=path.join(tmp,'signed-in'), rt=new AcpRuntime(tmp);
  rt.registry=async()=>[entry];
  rt.spawnSpec=(_entry,cwd,args=[],env={})=>({command:process.execPath,args:[path.join(__dirname,'acp-mock-agent.js'),...args],env:{...process.env,MOCK_AUTH_FILE:authFile,...env},cwd});
  let terminals=0;
  const io={signal:AbortSignal.timeout(5000),open(){throw Error('terminal auth must not be sent to browser authenticate');},event(){},code:async()=>'',terminal:async(_name,cmd,args,env)=>{
   terminals++; assert.equal(cmd,process.execPath); assert(args.includes('--mock-login')); assert.equal(env.MOCK_LOGIN,'1'); fs.writeFileSync(authFile,'fixture login');
  }};
  const signed=await signInAgent(rt,entry,undefined,tmp,io);
  assert.equal(terminals,1); assert.deepEqual(signed.models.map(m=>m.id),['mock-fast','mock-pro'],'new agent reads credentials saved after its predecessor started');
  fs.unlinkSync(authFile);
  await assert.rejects(signInAgent(rt,entry,undefined,tmp,{...io,terminal:async()=>{throw Error('No terminal installed');}}),/No terminal installed/);
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(signInAgent(rt,entry,undefined,tmp,{...io,signal:cancelled.signal}),e=>e.name==='AbortError');
  await assert.rejects(openLoginTerminal('unused',[],tmp,{},cancelled.signal),e=>e.name==='AbortError');
  fs.writeFileSync(authFile,'fixture login');
  const agentStore=makeStore(), agent=await agentStore.add({name:'Mock agent',baseUrl:'acp:mock-terminal',apiFormat:'acp',agent:{id:entry.id},models:[{id:'mock-fast',enabled:true}]});
  const acp=new AcpHost({store:agentStore,status(){},sendState:async()=>{}},rt);
  setAcpRuntime(rt);
  assert.equal(await acp.handle(surface,{type:'checkProvider',id:agent.id}),true);
  assert(events.some(m=>m.type==='providerCheck'&&m.id===agent.id&&m.ok&&m.count===2));
  await acp.handle(surface,{type:'fetchModels',id:agent.id});
  const until=Date.now()+5000; while(!events.some(m=>m.type==='fetchedModels'&&m.providerId===agent.id)&&Date.now()<until) await new Promise(r=>setTimeout(r,20));
  assert.equal(events.find(m=>m.type==='fetchedModels'&&m.providerId===agent.id).models.length,2);
  const listed = await agentStore.get(agent.id);
  assert.equal(listed.models.find(m=>m.id==='mock-fast').enabled,true);
  assert.equal(listed.models.find(m=>m.id==='mock-pro').enabled,false,'new catalog choices wait for the user to enable them');
  const agentProvidersHost=new ProvidersHost({store:agentStore,status(){},sendState:async()=>{}},catalog);
  await agentProvidersHost.handle(surface,{type:'addModels',id:agent.id,models:[{id:'mock-pro'}]});
  assert.equal((await agentStore.get(agent.id)).models.find(m=>m.id==='mock-pro').enabled,true,'ACP fetched picker enables a model already synchronized into the catalog');
  agentProvidersHost.dispose();
  const control={protocol:'agent',levels:['low','high'],note:'Live agent controls',configId:'effort',choices:[{effort:'low',value:'low'},{effort:'high',value:'high'}]};
  const refreshed=refreshAgentModels([{id:'removed-old',enabled:true,smart:false},{id:'still-off',enabled:false,smart:false,contextWindow:12345,name:'Old name',reasoningControl:control},{id:'still-on',enabled:true,smart:false,maxOutput:321}], [{id:'still-off',name:'Current name'},{id:'still-on',name:'Current active',reasoningControl:control},{id:'fresh-model',name:'Fresh model'}]);
  assert.deepEqual(refreshed.map(m=>m.id),['still-off','still-on','fresh-model']);
  assert.equal(refreshed[0].enabled,false); assert.equal(refreshed[0].contextWindow,12345); assert.equal(refreshed[0].name,'Current name'); assert.equal(refreshed[0].reasoningControl,undefined,'withdrawn reasoning controls are cleared');
  assert.equal(refreshed[1].enabled,true); assert.equal(refreshed[1].maxOutput,321); assert.deepEqual(refreshed[1].reasoningControl,control);
  assert.equal(refreshed[2].enabled,false);
  const vendorModels=[{id:'default',name:'Default (recommended)'},{id:'opus',name:'Opus 5.5'},{id:'sonnet',name:'Sonnet 5.5'},{id:'fable',name:'Fable 5.1'},{id:'haiku',name:'Haiku 5.5'},...['haiku-4-5-20251001','sonnet-5','opus-5','fable-5','opus-4-8','opus-4-7','opus-4-6','sonnet-4-6'].map(id=>({id:'claude-'+id,name:'Vendor '+id}))];
  const rolling=pickModels(vendorModels,'sonnet',8,true);
  assert.equal(rolling.length,13,'all vendor-advertised legacy versions remain available');
  assert.deepEqual(rolling.filter(m=>m.enabled).map(m=>m.id),['sonnet','default','opus','fable','haiku']);
  assert.equal(rolling.find(m=>m.id==='haiku').name,'Haiku 5.5','vendor current alias names remain exact');
  assert(pickModels(vendorModels,'claude-haiku-4-5-20251001',8,true).find(m=>m.id==='claude-haiku-4-5-20251001').enabled,'a selected legacy model remains enabled');
  assert.equal(pickModels(vendorModels,'sonnet').filter(m=>m.enabled).length,8,'other agents keep their original activation policy');
  let finishListing;
  acp.listModels=async()=>new Promise(resolve=>{finishListing=resolve;});
  const refreshing=acp.refreshModels(surface,await agentStore.get(agent.id));
  await agentStore.update(agent.id,{models:(await agentStore.get(agent.id)).models.map(m=>({...m,enabled:false}))});
  finishListing({models:[{id:'mock-fast',name:'Updated fast'},{id:'replacement',name:'Replacement'}]});
  await refreshing;
  assert.deepEqual((await agentStore.get(agent.id)).models.map(m=>[m.id,m.enabled]),[['mock-fast',false],['replacement',false]],'catalog refresh prunes removed IDs without restoring toggles changed during startup');
  const beforeRemoved=await agentStore.get(agent.id);
  const deletedRefresh=acp.refreshModels(surface,beforeRemoved);
  await agentStore.delete(agent.id);
  finishListing({models:[{id:'mock-fast',name:'Updated fast'}]});
  await deletedRefresh;
  assert.equal(await agentStore.get(agent.id),undefined,'late catalog responses cannot recreate a removed provider');
  acp.dispose(); console.log('PASS: real stdio terminal-auth negotiation, login/reconnect, cancellation, launch errors, agent connection and model-list checks.');
  console.log('PASS: fresh agent catalogs prune withdrawn models, refresh names and reasoning, preserve limits and in-flight toggles, and enable selected new choices.');
  console.log('PASS: Claude defaults prefer current rolling aliases while preserving every advertised version and an explicitly selected legacy model.');

  const windows=loginTerminalSpec('C:\\A Folder\\vendor.cmd',['auth','login'],'win32');
  assert.equal(windows.args.at(-1),'""C:\\A Folder\\vendor.cmd" "auth" "login""');
  assert.throws(()=>loginTerminalSpec('vendor.cmd',['auth&whoami'],'win32'),/unsupported Windows shell/);
  if(process.platform==='win32') {
   const folder=path.join(tmp,'A Folder');fs.mkdirSync(folder);
   const file=path.join(folder,'mock-vendor.cmd');
   fs.writeFileSync(file,'@echo off\r\nif "%~2"=="status" (\r\necho {"loggedIn":true,"email":"fixture@example.test","plan":"fixture"}\r\nexit /b 0\r\n)\r\nif "%~2"=="login" exit /b 0\r\nexit /b 1\r\n');
   const status=await readStatus({command:file,args:['auth','status']}); assert.equal(status.loggedIn,true); assert.equal(status.plan,'fixture');
   await loginWithCommand({command:file,args:['auth','login']},{...io,signal:AbortSignal.timeout(5000)});
  }
  console.log('PASS: Windows vendor shims in paths with spaces, shell argument validation and hidden command login.');
 } finally {
  global.fetch=originalFetch;
  setAcpRuntime(originalRuntime);
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));
  assert(path.basename(tmp).startsWith('zc-provider-fit-'));
  // Windows may release the terminal-auth fixture's files after the child exit callback.
  await fs.promises.rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
