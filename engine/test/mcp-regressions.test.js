'use strict';
// Local audit fixtures only: no configured MCP server or real account is contacted.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), assert = require('assert'), Module = require('module');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'engine/out');
const load = Module._load;
Module._load = function (name, ...rest) { return name === 'vscode' ? { env: { appName: 'zer0ne Code' } } : load.call(this, name, ...rest); };
const { McpManager, parseMcpJson, searchMcpRegistry } = require(path.join(out, 'tools/mcp'));
const { ProviderStore } = require(path.join(out, 'providerStore'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-mcp-probes-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const body = req => new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });
const tool = name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const config = (url, extra = {}) => ({ id: 'test', name: 'test', transport: 'http', command: '', args: [], env: {}, url, headers: {}, enabled: true, trusted: false, ...extra });
const init = (extra = {}) => ({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' }, ...extra });
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
async function fixture(fn, extra = {}, auth) {
 const log = [], sockets = new Set();
 const server = http.createServer(async (req, res) => {
  try {
   const raw = await body(req); const msg = raw ? JSON.parse(raw) : undefined;
   log.push({ method: req.method, msg, headers: req.headers });
   const respond = result => json(res, { jsonrpc: '2.0', id: msg.id, result });
   if (await fn?.({ req, res, msg, respond, log })) return;
   if (req.method === 'GET') { res.writeHead(405); return res.end(); }
   if (!msg || msg.id === undefined) { res.writeHead(202); return res.end(); }
   respond(msg.method === 'initialize' ? init() : msg.method === 'tools/list' ? { tools: [tool('echo')] } : { content: [{ type: 'text', text: 'ok' }] });
  } catch (e) { json(res, { error: String(e) }, 500); }
 });
 server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const cfg = config('http://127.0.0.1:' + server.address().port + '/mcp', extra);
 const mgr = new McpManager(() => tmp, () => {}, auth);
 return { mgr, cfg, log, async ready() {
  mgr.sync([cfg], true);
  for (let i = 0; i < 200; i++) { const s = mgr.statuses([cfg])[0]; if (['ready', 'error', 'auth'].includes(s.state)) return s; await pause(5); }
  throw Error('fixture startup deadline');
 }, async close() { await mgr.dispose(); await pause(20); for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
async function probe(id, name, fn) {
 try { const evidence = await fn(); results.push({ id, name, passed: true, evidence }); console.log(id + ' passed: ' + name); }
 catch (e) { results.push({ id, name, passed: false, error: e.stack }); console.error(id + ' FAILED: ' + e.message); }
}
async function withFixture(fn, handler, extra, auth) { const f = await fixture(handler, extra, auth); try { return await fn(f); } finally { await f.close(); } }
(async () => {
 await probe('F01a', 'F01a corrected behavior', async () => {
  const disk = new Map(), state = { get: (k, d) => disk.has(k) ? structuredClone(disk.get(k)) : d, update: async (k, v) => disk.set(k, structuredClone(v)) };
  const store = new ProviderStore({ globalState: state, workspaceState: state });
  await store.saveMcpServer({ ...config('http://127.0.0.1:1'), disabledTools: ['echo'] });
  assert.deepEqual(disk.get('aiChat.mcpServers')[0].disabledTools, ['echo']);
  assert.deepEqual(store.getMcpServers()[0].disabledTools, ['echo']);
  await store.saveMcpServer({ name: 'other', transport: 'stdio', command: 'node' });
  assert.deepEqual(disk.get('aiChat.mcpServers')[0].disabledTools, ['echo']);
  return { disabledTools: ['echo'], preservedOnReadAndOtherSave: true };
 });
 await probe('F01b', 'F01b corrected behavior', () => withFixture(async f => {
  assert.equal((await f.ready()).state, 'ready'); assert.equal(f.mgr.toolDefs().length, 0);
  await assert.rejects(f.mgr.call('mcp__test__echo', {}), /not available/);assert.equal(f.log.some(l=>l.msg?.method==='tools/call'),false);
  return { advertisedTools: 0, callAccepted: false };
 }, undefined, { disabledTools: ['echo'], trusted: true }));
 await probe('F02a', 'F02a corrected behavior', () => withFixture(async f => {
  await f.ready(); const defs = f.mgr.toolDefs(); assert.notEqual(defs[0].name, defs[1].name);
  const answer = await f.mgr.call(defs[1].name, {}); assert.equal(answer.text, 'a_b');
  return { names: defs.map(d => d.name), selectedSecondTool: 'a_b', actualTool: answer.text };
 }, ({msg, respond}) => { if (msg?.method === 'tools/list') { respond({ tools: [tool('a.b'), tool('a_b')] }); return true; } if (msg?.method === 'tools/call') { respond({content:[{type:'text',text:msg.params.name}]}); return true; } }));
 await probe('F02b', 'F02b corrected behavior', () => withFixture(async f => {
  await f.ready(); const names = f.mgr.toolDefs().map(d => d.name); assert.notEqual(names[0], names[1]);assert.ok(names.every(n=>n.length<=64));
  return { rawNamesDiffer: true, exportedNames: names };
 }, ({msg, respond}) => { if (msg?.method === 'tools/list') { respond({ tools:[tool('a'.repeat(80)+'one'),tool('a'.repeat(80)+'two')] }); return true; } }));
 await probe('F02c', 'F02c corrected behavior', async () => {
  const a = await fixture(({msg,respond}) => { if(msg?.method==='tools/call'){respond({content:[{type:'text',text:'manual'}]});return true;} }, {id:'manual',trusted:true});
  const b = await fixture(({msg,respond}) => { if(msg?.method==='tools/call'){respond({content:[{type:'text',text:'plugin'}]});return true;} }, {id:'plugin:test:test',plugin:'test',trusted:false});
  try {
   a.mgr.sync([a.cfg,b.cfg],true); for(let i=0;i<200 && a.mgr.toolDefs().length<2;i++)await pause(5);
   const defs=a.mgr.toolDefs(); assert.equal(defs.length,2);assert.notEqual(defs[0].name,defs[1].name);
   const response=await a.mgr.call(defs[1].name,{});assert.equal(response.text,'plugin');assert.equal(a.mgr.isTrusted(defs[1].name),false);
   return { intendedServer:'plugin',actualServer:response.text,trustResolvedToManual:false };
  } finally {await a.close();await b.close();}
 });
 await probe('F03a', 'F03a corrected behavior', () => withFixture(async f => {
  await f.ready();const r=await f.mgr.call('mcp__test__echo', {}, AbortSignal.timeout(1000));assert.equal(r.text,'already complete');return {resolvedBeforeStreamClosed:true};
 }, ({msg,res}) => { if(msg?.method==='tools/call'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:'already complete'}]}})+'\n\n');return true;} }));
 await probe('F03b', 'F03b corrected behavior', () => withFixture(async f => {
  await f.ready();assert.equal((await f.mgr.call('mcp__test__echo',{})).text,'ok');
  return { validMultilineDataEvent:true, observed:'ok' };
 }, ({msg,res})=>{if(msg?.method==='tools/call'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"jsonrpc":"2.0","id":'+msg.id+',\n'+'data: "result":{"content":[{"type":"text","text":"ok"}]}}\n\n');return true;}}));
 await probe('F04', 'F04 corrected behavior', () => withFixture(async f => {
  await f.ready(); await f.mgr.call('mcp__test__echo',{});await pause(20);
  assert.equal(f.log.some(l=>l.msg?.id===999 && l.msg.result),true);
  return { advertisedRoots:true, serverRootsRequestAnswered:true };
 }, ({msg,res})=>{if(msg?.method==='tools/call'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:999,method:'roots/list'})+'\n\n'+'data: '+JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:'ok'}]}})+'\n\n');return true;}}));
 await probe('F05', 'F05 corrected behavior', () => withFixture(async f => {
  await f.ready();await assert.rejects(f.mgr.call('mcp__test__echo',{}),/without returning/);return {falseSuccessPrevented:true};
 }, ({msg,res})=>{if(msg?.method==='tools/call'){res.writeHead(202);res.end();return true;}}));
 await probe('F06a', 'F06a corrected behavior', () => withFixture(async f => {
  const st=await f.ready();assert.equal(st.state,'error');assert.match(st.error,/unsupported/);assert.equal(f.log.some(l=>l.msg?.method==='tools/list'),false);return {unsupportedVersionRejected:true};
 }, ({msg,respond})=>{if(msg?.method==='initialize'){respond(init({protocolVersion:'2099-01-01'}));return true;}}));
 await probe('F06b', 'F06b corrected behavior', () => withFixture(async f => {
  const st=await f.ready();assert.equal(st.state,'ready');const defs=f.mgr.toolDefs();assert.equal(defs.filter(t=>t.name.startsWith('mcp__')).length,0);assert.deepEqual(defs.map(t=>t.name),['mcp_resources']);assert.equal(f.log.some(l=>l.msg?.method==='tools/list'),false);return {state:st.state,serverToolCount:0,resourceBridgeAvailable:true};
 }, ({msg,respond,res})=>{if(msg?.method==='initialize'){respond(init({capabilities:{resources:{}}}));return true;}if(msg?.method==='tools/list'){json(res,{jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'no tools capability'}});return true;}}));
 await probe('F07a', 'F07a corrected behavior', () => withFixture(async f => {
  f.mgr.sync([f.cfg],true);for(let i=0;i<100 && !f.log.length;i++)await pause(2);
  const client=f.mgr.clients.get(f.cfg.id);f.mgr.sync([f.cfg],false);assert.equal(client.state,'stopped');await pause(130);
  assert.equal(client.state,'stopped');assert.equal(f.log.some(l=>l.msg?.method==='tools/list'),false);assert.equal(f.mgr.toolDefs().length,0);
  return { stateImmediatelyAfterDisable:'stopped',detachedClientFinalState:client.state,requestsAfterDisable:f.log.slice(1).map(l=>l.msg?.method) };
 }, async ({msg,respond})=>{if(msg?.method==='initialize'){await pause(70);respond(init());return true;}}));
 await probe('F07b', 'F07b corrected behavior', async () => {
  const script=path.join(tmp,'fake.cjs');fs.writeFileSync(script,"require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'ok'}]}}));});");
  const cfg=config('',{transport:'stdio',command:process.execPath,args:[script]});const mgr=new McpManager(()=>tmp,()=>{});
  try {mgr.sync([cfg],true);for(let i=0;i<200 && mgr.statuses([cfg])[0].state!=='ready';i++)await pause(5);assert.equal(mgr.statuses([cfg])[0].state,'ready');mgr.restart(cfg.id);for(let i=0;i<400 && mgr.statuses([cfg])[0].state!=='ready';i++)await pause(5);const st=mgr.statuses([cfg])[0];assert.equal(st.state,'ready');assert.equal((await mgr.call('mcp__test__echo',{})).text,'ok');return {state:st.state};}finally{mgr.dispose();await pause(150);}
 });
 await probe('F08', 'F08 corrected behavior', () => withFixture(async f => {
  await f.ready();const r=await f.mgr.call('mcp__test__echo',{});assert.match(r.text,/invoice123/);assert.deepEqual(r.result.structuredContent,{id:'invoice123',total:10});return {canonicalStructuredResultPreserved:true};
 }, ({msg,respond})=>{if(msg?.method==='tools/call'){respond({content:[{type:'text',text:'See structured payload'}],structuredContent:{id:'invoice123',total:10}});return true;}}));
 await probe('F09a', 'F09a corrected behavior', async () => {
  const vault=new Map(),auth={get:async k=>vault.get(k),set:async(k,v)=>v?vault.set(k,v):vault.delete(k)};
  return withFixture(async f=>{await f.ready();await assert.rejects(f.mgr.call('mcp__test__echo',{}),/Sign in required/);const s=f.mgr.statuses([f.cfg])[0];assert.equal(s.state,'auth');assert.match(s.error,/Sign in required/);return {state:s.state,error:s.error};},({msg,res})=>{if(msg?.method==='tools/call'){json(res,{},401,{'WWW-Authenticate':'Bearer scope="read"'});return true;}},undefined,auth);
 });
 await probe('F09b', 'F09b corrected behavior', async () => {
  let access;const auth={get:async()=>({accessToken:'fixture-token',tokenEndpoint:'unused',clientId:'fixture',resource:'fixture'}),set:async()=>{}};
  const f=await fixture(({msg,respond,res,req})=>{if(req.method==='DELETE'){access=req.headers;res.writeHead(401);res.end();return true;}if(msg?.method==='initialize'){json(res,{jsonrpc:'2.0',id:msg.id,result:init()},200,{'Mcp-Session-Id':'fixture-session'});return true;}},undefined,auth);
  try {await f.ready();f.mgr.dispose();for(let i=0;i<50 && !access;i++)await pause(5);assert.ok(access);assert.equal(access.authorization,'Bearer fixture-token');assert.equal(access['mcp-protocol-version'],'2025-06-18');return {sessionHeader:access['mcp-session-id'],authorization:'Bearer fixture-token',protocolHeader:access['mcp-protocol-version']};}finally{await f.close();}
 });
 await probe('F10', 'F10 corrected behavior', async () => {
  const vault=new Map(), auth={get:async k=>structuredClone(vault.get(k)),set:async(k,v)=>v?vault.set(k,v):vault.delete(k)};
  let count=0;const tokenServer=http.createServer(async(req,res)=>{await body(req);if(++count===1)json(res,{access_token:'AT2',refresh_token:'RT2',expires_in:3600});else{await pause(35);json(res,{error:'invalid_grant'},400);}});
  await new Promise(r=>tokenServer.listen(0,'127.0.0.1',r));
  try {return await withFixture(async f=>{await f.ready();await pause(20);vault.set(f.cfg.url,{accessToken:'AT1',refreshToken:'RT1',expiresAt:Date.now()-1000,tokenEndpoint:'http://127.0.0.1:'+tokenServer.address().port+'/token',clientId:'fixture',resource:f.cfg.url});const replies=await Promise.allSettled([f.mgr.call('mcp__test__echo',{}),f.mgr.call('mcp__test__echo',{})]);assert.equal(count,1);assert.equal(vault.size,1);assert.deepEqual(replies.map(r=>r.status),['fulfilled','fulfilled']);assert.equal(vault.get(f.cfg.url).refreshToken,'RT2');return {refreshRequests:count,callStatuses:replies.map(r=>r.status),credentialStoreEmpty:false};},({msg,req,res})=>{if(msg?.method==='tools/call' && req.headers.authorization!=='Bearer AT2'){json(res,{},401);return true;}},undefined,auth);}finally{tokenServer.closeAllConnections();await new Promise(r=>tokenServer.close(r));}
 });
 await probe('F11', 'F11 corrected behavior', async()=>{assert.throws(()=>parseMcpJson(JSON.stringify({mcpServers:{legacy:{type:'sse',url:'http://127.0.0.1:1/sse'}}})),/legacy SSE/);return {unsupportedTransportRejected:true};});
 await probe('F12', 'F12 corrected behavior', async()=>{
  if(process.platform!=='win32')throw Error('Windows-only probe');
  const script=path.join(tmp,'argv.cjs');fs.writeFileSync(script,"require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify(process.argv.slice(2))}]}}));});");
  process.env.ZER0NE_MCP_AUDIT='expanded-by-cmd';const cfg=config('',{transport:'stdio',command:process.execPath,args:[script,'%ZER0NE_MCP_AUDIT%']});const mgr=new McpManager(()=>tmp,()=>{});
  try{mgr.sync([cfg],true);for(let i=0;i<200 && mgr.statuses([cfg])[0].state!=='ready';i++)await pause(5);const r=await mgr.call('mcp__test__echo',{});assert.equal(r.text,'["%ZER0NE_MCP_AUDIT%"]');return {literalArgumentPreserved:true};}finally{delete process.env.ZER0NE_MCP_AUDIT;mgr.dispose();await pause(150);}
 });
 await probe('F13', 'F13 corrected behavior', async()=>{
  const errors=[],listener=e=>errors.push(e.message);process.on('unhandledRejection',listener);
  const script=path.join(tmp,'change.cjs');fs.writeFileSync(script,"let lists=0;require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:true}},serverInfo:{name:'test',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'ok'}]};console.log(JSON.stringify(m.method==='tools/list'&&++lists>1?{jsonrpc:'2.0',id:m.id,error:{code:-32603,message:'refresh failed'}}:{jsonrpc:'2.0',id:m.id,result}));if(m.method==='tools/call')setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})),10);});");
  const cfg=config('',{transport:'stdio',command:process.execPath,args:[script]}),mgr=new McpManager(()=>tmp,()=>{});
  try{mgr.sync([cfg],true);for(let i=0;i<200&&mgr.statuses([cfg])[0].state!=='ready';i++)await pause(5);await mgr.call('mcp__test__echo',{});await pause(100);assert.deepEqual(errors,[]);assert.match(mgr.statuses([cfg])[0].error,/refresh failed/);assert.equal(mgr.statuses([cfg])[0].state,'ready');return {unhandledRejections:errors};}finally{mgr.dispose();await pause(150);process.removeListener('unhandledRejection',listener);}
 });
 await probe('F14', 'F14 corrected behavior', async()=>{const cfg=parseMcpJson(JSON.stringify({mcpServers:{disabled:{enabled:false,command:'node'}}}))[0];assert.equal(cfg.enabled,false);return {configuredEnabled:false,importedEnabled:cfg.enabled};});
 await probe('F15', 'F15 corrected behavior',async()=>{
  const original=global.fetch;global.fetch=async()=>new Response(JSON.stringify({servers:[{server:{name:'example/audit',packages:[{registryType:'npm',identifier:'audit-fixture',version:'1.0.0',transport:{type:'stdio'},packageArguments:[{type:'named',name:'--mode',value:'read'}]}]}}]}),{headers:{'Content-Type':'application/json'}});
  try{const [r]=await searchMcpRegistry('audit');assert.deepEqual(r.config.args,['-y','audit-fixture@1.0.0','--mode','read']);return {registryArgs:['--mode','read'],configuredArgs:r.config.args};}finally{global.fetch=original;}
 });
 await probe('F16', 'F16 corrected behavior',()=>withFixture(async f=>{
  await f.ready();const client=f.mgr.clients.get(f.cfg.id);client.cwd=path.join(tmp,'project # one');client.onMessage(JSON.stringify({jsonrpc:'2.0',id:991,method:'roots/list'}));
  for(let i=0;i<50&&!f.log.some(l=>l.msg?.id===991);i++)await pause(5);
  const uri=f.log.find(l=>l.msg?.id===991).msg.result.roots[0].uri;assert.equal(new URL(uri).hash,'');assert.equal(uri,require('url').pathToFileURL(client.cwd).href);return {rootURIEncoded:true};
 }));
 await probe('F17', 'F17 corrected behavior',async()=>{
  const original=global.fetch;global.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('oauth-protected-resource')?{resource:'https://other.invalid/mcp',authorization_servers:['https://issuer.invalid']}:{issuer:'https://wrong-issuer.invalid',authorization_endpoint:'http://public-auth.invalid/authorize',token_endpoint:'http://public-auth.invalid/token',registration_endpoint:'http://public-auth.invalid/register'}),{headers:{'Content-Type':'application/json'}});
  try{await assert.rejects(require(path.join(out,'tools/mcpOAuth')).discover('https://resource.invalid/mcp',null),/does not match/);return {invalidMetadataRejected:true};}finally{global.fetch=original;}
 });
 await probe('F18', 'F18 corrected behavior',async()=>{
  const originalFetch=global.fetch,originalTimer=global.setTimeout,errors=[],listener=e=>errors.push(e.message);process.on('unhandledRejection',listener);
  global.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('oauth-protected-resource')?{resource:'https://fixture.invalid/mcp',authorization_servers:['https://fixture.invalid']} : String(url).includes('register')?{client_id:'fixture'}:{issuer:'https://fixture.invalid',authorization_endpoint:'https://fixture.invalid/authorize',token_endpoint:'https://fixture.invalid/token',registration_endpoint:'https://fixture.invalid/register'}),{headers:{'Content-Type':'application/json'}});
  global.setTimeout=(fn,ms,...args)=>originalTimer(fn,ms===300000?30:ms,...args);
  try{await assert.rejects(require(path.join(out,'tools/mcpOAuth')).signIn('https://fixture.invalid/mcp',null,async()=>{throw Error('browser launch failed');}),/browser launch failed/);await pause(80);assert.deepEqual(errors,[]);return {launchErrorSurfaced:true,unhandledRejections:errors,timerShortenedForProbe:true};}finally{global.fetch=originalFetch;global.setTimeout=originalTimer;process.removeListener('unhandledRejection',listener);}
 });
 await probe('F19', 'F19 corrected behavior',()=>withFixture(async f=>{
  await f.ready();assert.equal((await f.mgr.call('mcp__test__echo',{})).text,'ok');assert.equal((await f.mgr.call('mcp__test__echo',{})).text,'ok');assert.equal(f.log.filter(l=>l.msg?.method==='initialize').length,2);return {expiredSessionRecovered:true};
 },({msg,res,req,log})=>{if(msg?.method==='initialize'){json(res,{jsonrpc:'2.0',id:msg.id,result:init()},200,{'Mcp-Session-Id':log.filter(l=>l.msg?.method==='initialize').length===1?'expired-session':'replacement'});return true;}if(msg?.method==='tools/call'&&req.headers['mcp-session-id']==='expired-session'){json(res,{},404);return true;}}));
 await probe('F20', 'F20 corrected behavior',async()=>{
  const {ExtensionsHost}=require(path.join(out,'host/extensionsHost'));let saves=0;const messages=[];
  const ctx={store:{saveMcpServer:async()=>{saves++;throw Error('duplicate server');}},status:(...m)=>messages.push(m),sendState:async()=>{}};
  const host=new ExtensionsHost(ctx,{applyServices:async()=>{}});
  await host.handle({post:()=>{}},{type:'importMcp',json:JSON.stringify({mcpServers:{one:{command:'node'},two:{command:'node'}}})});assert.equal(saves,2);assert.match(messages.at(-1)[0],/Imported 0 MCP servers/);assert.match(messages.at(-1)[0],/2 failed/);assert.equal(messages.at(-1)[1],'error');return {actualSaved:0,reportedSaved:0,finalStatus:messages.at(-1)[0]};
 });
 await probe('F21','Argument editor preserves quotes and empty values',async()=>{require('./mcp-settings.test.js');return {uiRoundTripPassed:true};});
 await probe('F22', 'F22 corrected behavior',()=>withFixture(async f=>{
  f.mgr.sync([f.cfg],true);for(let i=0;i<100&&f.mgr.clients.get(f.cfg.id).state!=='ready';i++)await pause(5);
  const st=f.mgr.statuses([f.cfg])[0];assert.equal(st.state,'error');assert.match(st.error,/metadata/);return {malformedMetadataRejected:true};
 },({msg,respond})=>{if(msg?.method==='tools/list'){respond({tools:[{...tool('echo'),description:42}]});return true;}}));
 await probe('C01', 'Approval cannot authorize a replacement client', () => withFixture(async f => {
  await f.ready(); const expected=f.mgr.resolve('mcp__test__echo'); f.mgr.restart(f.cfg.id);
  for(let i=0;i<200&&f.mgr.statuses([f.cfg])[0].state!=='ready';i++)await pause(5);
  assert.equal(f.mgr.statuses([f.cfg])[0].state,'ready');
  await assert.rejects(f.mgr.call('mcp__test__echo',{},undefined,expected),/not available/);
  assert.equal(f.log.some(l=>l.msg?.method==='tools/call'),false);
  assert.equal((await f.mgr.call('mcp__test__echo',{})).text,'ok');
  return {oldApprovalRejected:true,newCallWorks:true};
 }));
 await probe('C02', 'Caller timeout cancels HTTP work and notifies server', () => withFixture(async f => {
  await f.ready(); const client=f.mgr.clients.get(f.cfg.id),started=Date.now();
  await assert.rejects(client.request('tools/call',{name:'echo'},40),/timeout|abort/i);
  for(let i=0;i<100&&!f.log.some(l=>l.msg?.method==='notifications/cancelled');i++)await pause(5);
  assert.ok(Date.now()-started<1000);assert.ok(f.log.some(l=>l.msg?.method==='notifications/cancelled'));
  return {timeoutRespected:true,cancellationSent:true};
 }, ({msg})=>msg?.method==='tools/call'));
 await probe('C03', 'Negotiated protocol overrides reserved config headers', () => withFixture(async f => {
  assert.equal((await f.ready()).state,'ready');
  const list=f.log.find(l=>l.msg?.method==='tools/list'); assert.equal(list.headers['mcp-protocol-version'],'2025-03-26');
  await pause(30);const get=f.log.find(l=>l.method==='GET'); assert.equal(get.headers.accept,'text/event-stream');
  await f.mgr.dispose();const del=f.log.find(l=>l.method==='DELETE');assert.equal(del.headers['mcp-protocol-version'],'2025-03-26');
  return {negotiatedHeadersCorrect:true};
 },({msg,respond,res})=>{if(msg?.method==='initialize'){json(res,{jsonrpc:'2.0',id:msg.id,result:init({protocolVersion:'2025-03-26'})},200,{'Mcp-Session-Id':'control'});return true;}}, {headers:{'mcp-protocol-version':'wrong','mcp-session-id':'wrong'}}));
 await probe('C04','HTTP GET stream answers server requests',()=>withFixture(async f=>{
  await f.ready();for(let i=0;i<100&&!f.log.some(l=>l.msg?.id===771);i++)await pause(5);
  assert.deepEqual(f.log.find(l=>l.msg?.id===771).msg.result,{});return {pingAnswered:true};
 },({req,res})=>{if(req.method==='GET'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:771,method:'ping'})+'\n\n');return true;}}));
 await probe('C05','Repeated pagination cursor fails promptly',()=>withFixture(async f=>{
  assert.equal((await f.ready()).state,'error');assert.match(f.mgr.statuses([f.cfg])[0].error,/cursor/);
  assert.equal(f.log.filter(l=>l.msg?.method==='tools/list').length,2);return {bounded:true};
 },({msg,respond})=>{if(msg?.method==='tools/list'){respond({tools:[],nextCursor:'again'});return true;}}));
 await probe('C06','OAuth issuer mismatch and insecure endpoints rejected independently',async()=>{
  const original=global.fetch;const oauth=require(path.join(out,'tools/mcpOAuth'));
  try {
   global.fetch=async url=>new Response(JSON.stringify(String(url).includes('oauth-protected-resource')?{resource:'https://resource.invalid/mcp',authorization_servers:['https://issuer.invalid']}:{issuer:'https://wrong.invalid',authorization_endpoint:'https://issuer.invalid/authorize',token_endpoint:'https://issuer.invalid/token'}));
   await assert.rejects(oauth.discover('https://resource.invalid/mcp',null),/issuer/);
   global.fetch=async url=>new Response(JSON.stringify(String(url).includes('oauth-protected-resource')?{resource:'https://resource.invalid/mcp',authorization_servers:['https://issuer.invalid']}:{issuer:'https://issuer.invalid',authorization_endpoint:'http://public.invalid/authorize',token_endpoint:'https://issuer.invalid/token'}));
   await assert.rejects(oauth.discover('https://resource.invalid/mcp',null),/insecure endpoint/);
   return {issuerRejected:true,insecureEndpointRejected:true};
  } finally {global.fetch=original;}
 });
 await probe('C07','OAuth transient refresh failure preserves credentials',async()=>{
  const original=global.fetch;let token={accessToken:'old',refreshToken:'refresh',expiresAt:1,tokenEndpoint:'https://issuer.invalid/token',clientId:'fixture',resource:'https://fixture-transient.invalid'};
  global.fetch=async()=>new Response('{}',{status:503});
  try {await assert.rejects(require(path.join(out,'tools/mcpRefresh')).storedBearer({get:async()=>token,set:async(_r,v)=>token=v},token.resource,false,new AbortController().signal));assert.equal(token.accessToken,'old');return {preserved:true};}finally{global.fetch=original;}
 });
 await probe('C08','Windows executable arguments preserve literal values',async()=>{
  const values=['', 'two words', 'a"b', '%PATH%', '!literal!', 'trail\\', '你好'];const script=path.join(tmp,'argv.cjs');fs.writeFileSync(script,'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const proc=require(path.join(out,'tools/mcpProtocol')).spawnMcp(process.execPath,[script,...values],tmp,process.env);let output='';proc.stdout.on('data',x=>output+=x);
  await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',code=>code===0?resolve():reject(Error('exit '+code)));});assert.deepEqual(JSON.parse(output),values);return {literalRoundTrip:true};
 });
 await probe('C09','Caller cancellation does not wait for shared session recovery',()=>withFixture(async f=>{
  await f.ready();const started=Date.now();await assert.rejects(f.mgr.call('mcp__test__echo',{},AbortSignal.timeout(50)),/timeout|abort/i);
  assert.ok(Date.now()-started<500);assert.equal(f.log.filter(l=>l.msg?.method==='initialize').length,2);return {cancelledPromptly:true};
 },({msg,res,log})=>{if(msg?.method==='initialize'){if(log.filter(l=>l.msg?.method==='initialize').length>1)return true;json(res,{jsonrpc:'2.0',id:msg.id,result:init()},200,{'Mcp-Session-Id':'expired'});return true;}if(msg?.method==='tools/call'){json(res,{},404);return true;}}));
 fs.mkdirSync(path.join(root,'test/output'),{recursive:true});
 fs.writeFileSync(path.join(root,'test/output/mcp-regression-results.json'),JSON.stringify({at:new Date().toISOString(),platform:process.platform,node:process.version,source:'fresh engine/out built from local engine/src',results},null,2)+'\n');
 console.log(JSON.stringify({probes:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length}));
 process.exitCode=results.some(r=>!r.passed)?1:0;
 assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));
 fs.rmSync(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
})().catch(e=>{console.error(e);process.exitCode=1;});
