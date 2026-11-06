'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), http = require('node:http');
const { JSDOM } = require('jsdom');
const { createShim, install } = require('./vscode-shim');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-workbench-')), project = path.join(base, 'project'); fs.mkdirSync(project);
const shim = createShim({ workspace:project, dataDir:path.join(base, 'data'), ui:{ warn:(_text, items) => items[0] } }); install(shim.vscode);
shim.vscode.window.showQuickPick = async items => items[0];
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { CommandLedger, EventReplay } = require(path.join(out, 'commandLedger'));
const { RemoteServer } = require(path.join(out, 'remote'));
const { ProjectActionsHost, parseProjectActions } = require(path.join(out, 'host/projectActions'));
const { InteractiveTerminalHost } = require(path.join(out, 'host/interactiveTerminal'));
const { TurnHistory } = require(path.join(out, 'host/turnHistory'));
const { CheckpointStore } = require(path.join(out, 'checkpoints'));
const { ProviderStore } = require(path.join(out, 'providerStore'));
const until = async (predicate, detail, timeout = 15000) => { const end = Date.now() + timeout; while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Timed out: ' + detail); };

test('command reservations survive independent processes and never store prompt text', async () => {
 const dir = path.join(base, 'commands'), modulePath = path.join(out, 'commandLedger');
 const script = `const {CommandLedger}=require(${JSON.stringify(modulePath)});const l=new CommandLedger(${JSON.stringify(dir)});console.log(JSON.stringify(l.begin('device-a','command-shared',{type:'send',text:'private fixture prompt'})));`;
 const results = await Promise.all(Array.from({length:4}, () => new Promise((resolve, reject) => cp.execFile(process.execPath, ['-e', script], (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))))));
 assert.equal(results.filter(r => r.fresh).length, 1);
 const ledger = new CommandLedger(dir);
 assert.equal(ledger.get('device-a','command-shared').status, 'uncertain', 'a dead owner cannot establish an execution outcome');
 assert.equal(ledger.get('device-b','command-shared'), undefined, 'receipts are scoped to the authenticated caller');
 assert.throws(() => ledger.begin('device-a','command-shared',{type:'send',text:'different'}), /different content/);
 assert.throws(() => ledger.get('device-a','../unsafe'), /identity/);
 assert(!fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('').includes('private fixture prompt'));
});

test('HTTP commands negotiate, deduplicate, settle, and retain uncertain receipts after stop', async () => {
 let calls = 0, release, token = 'fixture-token';
 const server = new RemoteServer(path.resolve(__dirname, '../media'), { token:()=>token, attach:() => ({ dispose(){}, handle:async msg => { if(msg.type==='send') { calls++; await new Promise(resolve => { release=resolve; }); } } }) }, { desktop:true, commandDir:path.join(base, 'http-commands') });
 await server.start(0); const url = 'http://127.0.0.1:' + server.info().port;
 const headers = { 'Content-Type':'application/json', 'X-Zer0ne-Token':'fixture-token', 'X-Zer0ne-Protocol':'1', 'X-Zer0ne-Command':'http-command-1' };
 const post = h => fetch(url+'/api/msg',{method:'POST',headers:h,body:JSON.stringify({type:'send',text:'one prompt'})});
 try {
  assert.equal((await post({...headers,'X-Zer0ne-Protocol':'0'})).status,426); assert.equal(calls,0);
  assert.equal((await post(headers)).status,202); assert.equal((await post(headers)).status,202); assert.equal(calls,1);
  const receipt = async id => { const r=await fetch(url+'/api/receipt?id='+id,{headers}); return r.json(); };
  assert.equal((await receipt('http-command-1')).status,'running'); release();
  await until(() => !server.inFlight.size, 'command settlement');
  assert.equal((await receipt('http-command-1')).status,'completed');
  assert.equal((await post({...headers,'X-Zer0ne-Command':'http-command-2'})).status,202);
  await server.stop(); release();
  const saved = new CommandLedger(path.join(base, 'http-commands')).get('desktop','http-command-2');
  assert.equal(saved.status,'uncertain'); assert.equal(calls,2);
  token='new-token-after-restart'; await server.start(0);
  const recovered=await fetch('http://127.0.0.1:'+server.info().port+'/api/receipt?id=http-command-2',{headers:{'X-Zer0ne-Token':token}});
  assert.equal((await recovered.json()).status,'uncertain','a new desktop token and port retain receipt lookup'); assert.equal(calls,2);
 } finally { release?.(); await server.stop(); }
});

test('event replay has a bounded window and rejects cursors from another engine', () => {
 const replay = new EventReplay(); replay.append({type:'state',messages:[]}); const first = replay.cursor;
 replay.append({type:'token',text:'next'}); assert.match(replay.since(first)[0], /next/);
 assert.equal(replay.since('another:1'),undefined); assert.deepEqual(replay.since(replay.cursor),[]);
 for(let i=0;i<600;i++) replay.append({type:'token',text:String(i)});
 assert.equal(replay.since(first),undefined);
});

test('modern SSE emits state patches and resumes without another ready action', async () => {
 let publish, ready = 0;
 const server = new RemoteServer(path.resolve(__dirname,'../media'), {token:()=>'fixture',attach:post => { publish=post; return {dispose(){},handle:async msg=>{if(msg.type==='ready'){ready++;post({type:'state',currentSessionId:'s',messages:[],settings:{theme:'dark'}});}}};}}, {desktop:true});
 await server.start(0); let url='http://127.0.0.1:'+server.info().port;
 const connect = cursor => {
  const events=[], waiters=[]; let response;
  const request=http.get(url+'/api/events?v=1&t=fixture'+(cursor?'&cursor='+encodeURIComponent(cursor):''),res=>{response=res;res.setEncoding('utf8');let buffer='';res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').find(l=>l.startsWith('data: '));if(data){events.push({data:JSON.parse(data.slice(6)),id:frame.split('\n').find(l=>l.startsWith('id: '))?.slice(4)});waiters.splice(0).forEach(fn=>fn());}}});});request.on('error',()=>{});
  return {events,close(){request.destroy();response?.destroy();}};
 };
 let stream=connect();
 try {
  const state=await until(()=>stream.events.find(e=>e.data.type==='state'),'initial SSE snapshot');
  publish({type:'state',currentSessionId:'s',messages:[{id:'a',content:'new'}],settings:{theme:'dark'}});
  await until(()=>stream.events.find(e=>e.data.type==='statePatch'),'state patch');
  const count=ready; stream.close(); stream=connect(state.id);
  await until(()=>stream.events.find(e=>e.data.type==='transportSynced'),'replay caught up');
  assert.equal(ready,count); assert(stream.events.some(e=>e.data.type==='statePatch'));
  const previousEpoch=stream.events.find(e=>e.data.type==='transportHello').data.epoch, oldPublish=publish;
  stream.close(); await server.stop(); await server.start(0); url='http://127.0.0.1:'+server.info().port; stream=connect(state.id);
  await until(()=>stream.events.find(e=>e.data.type==='state'),'fresh snapshot after restarting Remote');
  assert.notEqual(stream.events.find(e=>e.data.type==='transportHello').data.epoch,previousEpoch);
  oldPublish({type:'staleCallback'}); publish({type:'newGeneration'});
  await until(()=>stream.events.find(e=>e.data.type==='newGeneration'),'new generation event');
  assert(!stream.events.some(e=>e.data.type==='staleCallback'),'a retired stream cannot publish into its replacement');
 } finally {stream.close();await server.stop();}
});

test('browser reconnect rechecks receipts without submitting the prompt again', async () => {
 const dom=new JSDOM('<body></body>',{url:'http://localhost',runScripts:'outside-only'}), w=dom.window, streams=[];
 let submissions=0, queries=0; w.__REMOTE__={token:'fixture',desktop:true};
 w.EventSource=class{constructor(url){this.url=url;streams.push(this);}close(){}};
 w.fetch=async (url,options)=>{if(url.startsWith('/api/receipt')){queries++;return {ok:true,status:200,json:async()=>({status:'completed'})};}if(JSON.parse(options.body).type==='zcViewState')return{ok:true,status:204};submissions++;throw new Error('lost response');};
 try {
  w.eval(fs.readFileSync(path.resolve(__dirname,'../media/bridge.js'),'utf8')); w.Bridge.post({type:'ready'});
  const receive=data=>streams[0].onmessage({data:JSON.stringify(data),lastEventId:'epoch:1'});
  receive({type:'transportHello',protocol:1,epoch:'epoch',capabilities:{receipts:true}}); receive({type:'state',currentSessionId:'s'});
  await w.Bridge.post({type:'send',text:'submit once'}); assert.equal(submissions,1);
  receive({type:'transportHello',protocol:1,epoch:'epoch',replaying:true,capabilities:{receipts:true}});
  receive({type:'statePatch',patch:{currentSessionId:'new-session'},removed:[]});
  await w.Bridge.post({type:'send',text:'must wait for all replayed events'}); assert.equal(submissions,1);
  receive({type:'transportSynced'});
  await until(()=>queries>0,'receipt lookup'); assert.equal(submissions,1);
 } finally {w.close();}
});

test('project actions require review, reject escape paths, and run saved actions with evidence', async () => {
 assert.throws(()=>parseProjectActions([{name:'escape',command:'echo no',cwd:'../outside'}]),/inside/);
 assert.throws(()=>parseProjectActions([{name:'unsafe',command:'echo no',previewUrl:'javascript:alert(1)'}]),/HTTP/);
 const posts=[], host=new ProjectActionsHost({store:{},postAll:m=>posts.push(m),status(){},sendState:async()=>{}},path.join(base,'actions'));
 const surface={kind:'chat',post:m=>posts.push(m)};
 const action={name:'Check fixture',command:'echo PROJECT_ACTION_OK',prepareWorktree:true};
 try {
  await assert.rejects(()=>host.handle({kind:'remote',post(){}},{type:'projectActionsSave',json:'[]'}),/desktop-only/);
  await host.handle(surface,{type:'projectActionsSave',json:JSON.stringify([action])});
  await host.handle(surface,{type:'projectActionRun',name:action.name});
  assert(posts.some(m=>m.type==='projectActionOutput'&&m.text.includes('PROJECT_ACTION_OK')));
  assert.equal(posts.filter(m=>m.type==='projectActions').at(-1).last.status,'completed');
  await host.handle(surface,{type:'projectActionsList'}); assert(posts.at(-1).output.includes('PROJECT_ACTION_OK'),'refresh retains the action output');
  assert(fs.existsSync(path.join(base,'actions','execution-journal')));
 } finally {await host.stop();}
});

test('embedded frames cannot forge workbench state', () => {
 const dom=new JSDOM('<body><div id="aux-content-terminal"></div><textarea id="input"></textarea><div class="msg user" data-turn-id="no-edits"><div class="user-actions"></div></div></body>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window,posts=[];
 w.Bridge={remote:false,post:message=>posts.push(message)};
 try {
  w.eval(fs.readFileSync(path.resolve(__dirname,'../media/workbench.js'),'utf8'));
  const data={type:'projectActions',actions:[{name:'Injected',command:'untrusted'}],running:false,last:{}};
  w.dispatchEvent(new w.MessageEvent('message',{data,source:w,origin:'https://untrusted.example'}));
  assert(!w.document.querySelector('.workbench-action-list').textContent.includes('Injected'));
  w.dispatchEvent(new w.MessageEvent('message',{data:{...data,actions:[{name:'Trusted',command:'echo fixture'}]}}));
  w.document.querySelector('.workbench-action-list button').click();
  assert(posts.some(message=>message.type==='projectActionRun'&&message.name==='Trusted'));
  w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',currentSessionId:'s',messages:[{id:'no-edits',role:'user',content:'Read-only turn'}],isStreaming:false}}));
  w.document.querySelector('[data-rewind]').click(); assert(posts.some(message=>message.type==='rewindTo'&&message.id==='no-edits'),'rewind is available even when there are no file edits');
 } finally {w.close();}
});

test('terminal views have keyboard navigation and never start a shell merely by opening a tab', () => {
 const dom=new JSDOM('<body><div id="aux-content-terminal"><input id="term-input"></div></body>',{runScripts:'outside-only'}),w=dom.window,posts=[],saved=[];
 const input=w.document.getElementById('term-input');
 w.Bridge={remote:false,post:m=>posts.push(m),getState:()=>({}),patchState:p=>saved.push(p)};
 try {
  w.eval(fs.readFileSync(path.resolve(__dirname,'../media/workbench.js'),'utf8'));
  assert.equal(w.document.getElementById('term-input'),input,'existing command controls retain their identity');
  const shell=w.document.getElementById('workbench-tab-shells');shell.click();
  assert.equal(shell.getAttribute('aria-selected'),'true'); assert(!w.document.getElementById('workbench-view-shells').hidden);
  shell.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
  assert.equal(w.document.activeElement.id,'workbench-tab-actions');
  assert.equal(w.document.getElementById('workbench-tab-actions').tabIndex,0);
  assert.equal(w.document.getElementById('workbench-tab-commands').tabIndex,-1);
  assert(saved.some(s=>s.terminalView==='actions')); assert(!posts.some(m=>m.type==='ptyOpen'));
 } finally {w.close();}
});

test('terminal snapshots retain selection and burst output is written once per frame', async () => {
 const dom=new JSDOM('<body><div id="aux-content-terminal"></div></body>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window,posts=[],frames=[],instances=[];
 w.Bridge={remote:false,post:m=>posts.push(m),getState:()=>({})};
 w.requestAnimationFrame=fn=>{frames.push(fn);return frames.length;};
 w.Terminal=class {constructor(options){this.options=options;this.cols=options.cols;this.rows=options.rows;this.writes=[];this.resets=0;instances.push(this);}open(){}write(s){this.writes.push(s);}reset(){this.resets++;}getSelection(){return 'selected output';}onData(){}onSelectionChange(){}resize(c,r){this.cols=c;this.rows=r;}dispose(){}};
 const receive=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 try {
  w.eval(fs.readFileSync(path.resolve(__dirname,'../media/workbench.js'),'utf8'));w.document.getElementById('workbench-tab-shells').click();
  const snapshot={type:'ptySessions',sessions:[{id:'s',name:'Terminal 1',output:'initial',sequence:1,closed:false}]};
  receive(snapshot);await new Promise(resolve=>setImmediate(resolve));
  const terminal=instances[0];assert(terminal);receive(snapshot);
  assert.equal(terminal.resets,0);assert.equal(terminal.getSelection(),'selected output');
  receive({type:'ptyOutput',id:'s',sequence:2,text:' one'});receive({type:'ptyOutput',id:'s',sequence:3,text:' two'});
  assert.deepEqual(terminal.writes,['initial']);assert.equal(frames.length,1);frames.shift()();assert.deepEqual(terminal.writes,['initial',' one two']);
  const before=posts.filter(m=>m.type==='ptyList').length;
  receive({type:'ptyOutput',id:'s',sequence:5,text:'gap'});receive({type:'ptyOutput',id:'s',sequence:6,text:'gap'});
  assert.equal(posts.filter(m=>m.type==='ptyList').length,before+1,'one snapshot request handles a replay gap');
  receive({type:'ptySessions',sessions:[{...snapshot.sessions[0],output:'recovered',sequence:6}]});frames.shift()();
  assert.equal(terminal.resets,1);assert.equal(terminal.writes.at(-1),'recovered');
 } finally {w.close();}
});

test('file restore records context; rewind preserves the original and refuses incomplete checkpoints', async () => {
 const state=new Map(), memory={get:(key,fallback)=>state.has(key)?state.get(key):fallback,update:async(key,value)=>{state.set(key,value);}};
 const store=new ProviderStore({globalState:memory,workspaceState:memory});
 const session=await store.currentSessionId(), cpStore=new CheckpointStore(path.join(base,'checkpoints'));
 const messages=[{id:'earlier',role:'user',content:'keep this'}, {id:'target',role:'user',content:'change file',turn:{startedAt:1,edits:[{path:'rewind.txt'}]}}];
 fs.writeFileSync(path.join(project,'rewind.txt'),'after');cpStore.save(session,{userId:'target',at:1,files:{'rewind.txt':{before:'before',after:'after'}}});await store.saveMessages(session,messages);
 let rewound;
 const history=new TurnHistory({store,postAll(){},status(){},sendState:async()=>{}},{checkpoints:cpStore,originals:new Map(),busy:()=>false,sessionId:()=>session,messages:()=>messages,rewind:async id=>{rewound=await store.rewindSession(session,id);}});
 await history.handle({kind:'chat',post(){}},{type:'rewindTo',id:'target'});
 assert.equal(fs.readFileSync(path.join(project,'rewind.txt'),'utf8'),'before');
 assert(messages.some(m=>m.content.includes('Workspace file restore')));
 assert(rewound); assert.equal(rewound.messages[0].content,'keep this'); assert(!rewound.messages.some(m=>m.id==='target'));
 assert((await store.getSession(session)).messages.some(m=>m.id==='target'),'original history is retained'); assert.equal(rewound.summary,undefined);
 const skipped=[{id:'missing',role:'user',content:'cannot undo',turn:{startedAt:1,edits:[{path:'large.bin'}],undoSkipped:['large.bin']}}];
 const unsafe=new TurnHistory({store,postAll(){},status(){},sendState:async()=>{}},{checkpoints:cpStore,originals:new Map(),busy:()=>false,sessionId:()=>session,messages:()=>skipped,rewind:async()=>{throw Error('must not rewind');}});
 await assert.rejects(()=>unsafe.handle({kind:'chat',post(){}},{type:'rewindTo',id:'missing'}),/complete checkpoint/);
});

test('Windows PTY accepts interactive input, reports real TTYs, resizes, and kills descendants', {skip:process.platform!=='win32',timeout:45000}, async () => {
 const posts=[], host=new InteractiveTerminalHost({postAll:m=>posts.push(m),store:{},status(){},sendState:async()=>{}},path.resolve(__dirname,'../media/terminal/conpty.cs'),path.join(base,'pty'));
 const surface={kind:'chat',post:m=>posts.push(m)};
 try {
  await assert.rejects(()=>host.handle({kind:'remote',post(){}},{type:'ptyOpen'}),/desktop-only/);
  await host.handle(surface,{type:'ptyOpen'});
  const id=posts.filter(m=>m.type==='ptySessions').at(-1).sessions[0].id;
  const output=()=>posts.filter(m=>m.type==='ptyOutput'&&m.id===id).map(m=>m.text).join('');
  const command='"'+process.execPath+'" -e "console.log(\'TTY_CHECK_\'+process.stdin.isTTY+\'_\'+process.stdout.isTTY)"\r';
  await host.handle(surface,{type:'ptyInput',id,text:command});
  try { await until(()=>output().includes('TTY_CHECK_true_true'),'real TTY output'); } catch(error) { error.message += '\nTerminal output: ' + JSON.stringify(output()); throw error; }
  await host.handle(surface,{type:'ptyResize',id,cols:80,rows:24});
  await host.handle(surface,{type:'ptyInput',id,text:'set /p ZC_FIXTURE=Fixture input:\r'});
  await until(()=>output().includes('Fixture input:'),'interactive prompt');
  await host.handle(surface,{type:'ptyInput',id,text:'answered\r'});
  await host.handle(surface,{type:'ptyInput',id,text:'echo RESULT_%ZC_FIXTURE%\r'});
  await until(()=>output().includes('RESULT_answered'),'interactive answer');
  await host.handle(surface,{type:'ptyInput',id,text:'"'+process.execPath+'" -e "console.log(\'CHILD_PID_\'+process.pid);setInterval(()=>{},1000)"\r'});
  const match=await until(()=>output().match(/CHILD_PID_(\d+)/),'terminal descendant');
  const pid=Number(match[1]); const closing=host.handle(surface,{type:'ptyClose',id});
  await assert.rejects(()=>host.handle(surface,{type:'ptyInput',id,text:'late input'}),/closing|closed/);
  await closing;
  await until(()=>{try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}},'descendant exits with its PTY');
 } finally {await host.stop();}
});
