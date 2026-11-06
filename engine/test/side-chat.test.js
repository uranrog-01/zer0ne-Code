const assert = require('node:assert/strict');
const { SideChatHost, sideChatContext, recentContext } = require('../out/host/sideChat');
const messages = [{ id:'u1',role:'user',content:'Investigate the timeout',apiContent:'Investigate the timeout\nAttached log: socket closed' }, { id:'t1',role:'assistant',kind:'tool',content:'Read log',tool:{detail:'The service exited with status 2'} }, { id:'a1',role:'assistant',content:'The socket closed when the service restarted.' }];
const snapshot = JSON.stringify(messages);
let sessionId = 'session-1';
const provider = {id:'api',name:'Mock API',enabled:true,apiFormat:'openai',models:[{id:'model',enabled:true,contextWindow:32768}]};
const events = [], requests = [];
const surface = {kind:'chat',post:msg=>events.push(msg)};
const ctx = { store:{list:async()=>[provider],resolveSelection:async()=>({provider,model:provider.models[0]}),getApiKey:async()=>'key'}, postAll(){throw Error('Side Chat must not broadcast');},sendState(){throw Error('Side Chat must not change main state');} };
const saved = new Map();
ctx.store.getSideChat = id => saved.get(id);
ctx.store.saveSideChat = async (id, history) => history === undefined ? saved.delete(id) : saved.set(id, JSON.parse(JSON.stringify(history)));
const result = text => ({text,reasoning:'',toolCalls:[]});
let pending;
const host = new SideChatHost(ctx,()=>({sessionId,messages}),async(p,key,options)=>{requests.push(options); if(pending) return pending(options); options.onText('A separate answer'); return result('A separate answer');});
const ask = (requestId,extra={}) => host.handle(surface,{type:'sideChatAsk',sideChatId:'client-one',sessionId,requestId,question:'Why did it close?',excerpt:'socket closed',providerId:'api',model:'model',...extra});
async function main(){
 assert.equal(await host.handle(surface,{type:'other'}),false);
 await ask('one');
 assert.equal(JSON.stringify(messages),snapshot,'main messages stay unchanged');
 assert.match(requests[0].messages[0].content,/Attached log: socket closed/);
 assert.match(requests[0].messages[0].content,/service exited with status 2/);
 assert.match(requests[0].messages.at(-1).content,/Selected excerpt/);
 assert.equal(requests[0].tools,undefined,'no execution tools');
 assert.equal(requests[0].requestContext.sessionId,sessionId);
 assert(events.some(e=>e.text==='A separate answer'));
 await ask('two',{excerpt:'',question:'Explain more'});
 assert(requests[1].messages.some(m=>m.role==='assistant'&&m.content==='A separate answer'),'follow-up remembers the side conversation');
 await host.handle(surface,{type:'sideChatRemember',sideChatId:'client-one',sessionId,remember:true});
 assert.equal(saved.get(sessionId).length,4,'opt-in saves existing exchanges');
 await host.handle(surface,{type:'sideChatRestore',sideChatId:'restored-client',sessionId});
 assert.equal(events.at(-1).remember,true); assert.equal(events.at(-1).history.length,4);
 await host.handle(surface,{type:'sideChatReset',sideChatId:'restored-client',sessionId});
 assert.equal(saved.get(sessionId).length,4,'closing retains an explicitly saved helper');
 await host.handle(surface,{type:'sideChatRestore',sideChatId:'restored-client',sessionId:'another-chat'});
 assert.equal(saved.get(sessionId).length,4,'stale restores cannot change saved data');
 await host.handle(surface,{type:'sideChatReset',sideChatId:'client-one',sessionId,clear:true});
 assert.equal(saved.has(sessionId),false,'explicit clear removes persisted exchanges');
 const otherEvents=[]; const other={kind:'remote',post:e=>otherEvents.push(e)};
 await host.handle(other,{type:'sideChatAsk',sideChatId:'client-two',sessionId,requestId:'remote',question:'Other client',excerpt:''});
 assert(!requests.at(-1).messages.some(m=>m.role==='assistant'),'clients have isolated side histories');
 await ask('same-surface',{sideChatId:'another-tab'}); assert(!requests.at(-1).messages.some(m=>m.role==='assistant'),'tabs on one broadcast surface have isolated side histories');
 const count=requests.length;
 await ask('stale',{sessionId:'old-session'}); assert.equal(requests.length,count); assert.match(events.at(-1).error,/session changed/);
 await ask('oversize',{excerpt:'x'.repeat(24001)}); assert.equal(requests.length,count);
 provider.models[0].enabled=false; await ask('disabled'); assert.equal(requests.length,count); provider.models[0].enabled=true;
 provider.apiFormat='acp'; await ask('agent'); assert.equal(requests.length,count); assert.match(events.at(-1).error,/API or local model/); provider.apiFormat='openai';
 pending=options=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 const running=ask('running'); while(requests.length===count) await new Promise(r=>setImmediate(r));
 await ask('duplicate'); assert.match(events.at(-1).error,/Stop the current/);
 await host.handle(surface,{type:'sideChatStop',sideChatId:'client-one',sessionId,requestId:'wrong'}); assert(requests.at(-1).signal.aborted,'a stale stop still ends the answer: tokens are paid for');
 await host.handle(surface,{type:'sideChatStop',sideChatId:'client-one',sessionId,requestId:'running'}); await running;
 assert(events.at(-1).stopped); assert.equal(JSON.stringify(messages),snapshot);
 pending=null;
 await host.handle(surface,{type:'sideChatReset',sideChatId:'client-one',sessionId}); await ask('reset');
 assert(!requests.at(-1).messages.some(m=>m.role==='assistant'),'clear removes only Side Chat history');
 sessionId='session-2'; await ask('new-session'); assert(!requests.at(-1).messages.some(m=>m.role==='assistant'),'new session has no previous side history');
 const context=sideChatContext([...messages,{role:'assistant',content:'secret local command',local:true},{role:'assistant',content:'failed',isError:true}],10000);
 assert(!context.trimmed); assert(!context.text.includes('secret local command')); assert(!context.text.includes('failed'));
 const trimmed=sideChatContext(messages,80); assert(trimmed.trimmed); assert(Buffer.byteLength(trimmed.text)<=80);
 const unicode=sideChatContext([{role:'user',content:'你好'.repeat(300)}],100); assert(unicode.trimmed); assert(Buffer.byteLength(unicode.text)<=100);
 host.dispose();

 // Recent context: the summary replaces what it covers, and the start stays put so the prompt cache keeps serving it.
 const long=Array.from({length:40},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:`msg ${i} `+'x'.repeat(200)}));
 const summed=recentContext(long,100000,{summary:{text:'Earlier: set up the project',upTo:'m9'}});
 assert(summed.summarized); assert.match(summed.text,/Earlier: set up the project/); assert(!summed.text.includes('msg 9 ')); assert(summed.text.includes('msg 10 '));
 assert(!recentContext(long,100000,{summary:{text:'old pictures',upTo:'m9',frames:3}}).summarized,'retired picture summaries are ignored');
 const first=recentContext(long,3000); assert(first.trimmed); assert(first.anchor); assert(Buffer.byteLength(first.text)<=3000);
 const grown=[...long,{id:'m40',role:'user',content:'msg 40 '}];
 const second=recentContext(grown,3000,{anchor:first.anchor});
 assert.equal(second.anchor,first.anchor,'the anchor stays while the context fits'); assert(second.text.startsWith(first.text),'the request start stays identical between questions');
 const flood=[...grown,...Array.from({length:20},(_,i)=>({id:'n'+i,role:'user',content:'y'.repeat(200)}))];
 const moved=recentContext(flood,3000,{anchor:first.anchor}); assert.notEqual(moved.anchor,first.anchor,'the anchor moves forward once the context outgrows the budget'); assert(Buffer.byteLength(moved.text)<=3000);

 // Look-ups: only the chosen sources' read-only tools, activity while they run, sources afterwards.
 const toolDefs=[{name:'read_file',description:'',parameters:{}},{name:'grep',description:'',parameters:{}},{name:'git_status',description:'',parameters:{}}];
 const lookCalls=[]; const lookups={defs:()=>toolDefs,run:async(call,sid)=>{lookCalls.push({call,sid}); return {api:'export const timeout = 30;',summary:'1 file'};}};
 const lookEvents=[], lookRequests=[]; const lookSurface={kind:'chat',post:m=>lookEvents.push(m)};
 let script=()=>result('');
 const looker=new SideChatHost(ctx,()=>({sessionId,messages}),async(p,key,options)=>{lookRequests.push({...options,messages:[...options.messages]}); return script(options,lookRequests.length);},lookups);
 const lookAsk=(requestId,extra={})=>looker.handle(lookSurface,{type:'sideChatAsk',sideChatId:'look-client',sessionId,requestId,question:'What is the timeout?',excerpt:'',providerId:'api',model:'model',sources:['project','bogus'],...extra});
 await looker.handle(lookSurface,{type:'sideChatRestore',sideChatId:'look-client',sessionId});
 assert.deepEqual(lookEvents.at(-1).sources,['project','changes'],'only sources with tools on this host are offered');
 script=(options,n)=>{ if(n===1) return {text:'',reasoning:'',toolCalls:[{id:'c1',name:'read_file',arguments:'{"path":"src/net.ts","offset":12}'},{id:'c2',name:'run_command',arguments:'{}'}]}; options.onText('The timeout is 30 seconds.'); return result('The timeout is 30 seconds.'); };
 await lookAsk('look');
 assert.deepEqual(lookRequests[0].tools.map(t=>t.name),['read_file','grep'],'only the chosen source tools are offered');
 assert.equal(lookRequests[0].cacheKey,`side-chat:${sessionId}`);
 assert.equal(lookCalls.length,1,'tools outside Side Chat never run'); assert.equal(lookCalls[0].sid,sessionId);
 const toolReplies=lookRequests[1].messages.filter(m=>m.role==='tool'); assert.equal(toolReplies.length,2,'every tool call gets a reply'); assert.match(toolReplies[1].content,/not available/);
 assert(lookEvents.some(e=>e.activity==='Read src/net.ts'&&e.source==='project'),'each look-up names its source');
 assert(lookEvents.some(e=>e.activityDone&&e.detail==='1 file'&&!e.failed),'a finished look-up reports what it found');
 assert(lookEvents.find(e=>e.started&&e.requestId==='look').lookups);
 const lookDone=lookEvents.find(e=>e.done&&e.requestId==='look');
 assert.equal(lookDone.answer,'The timeout is 30 seconds.'); assert.deepEqual(lookDone.sources,[{label:'Read src/net.ts',path:'src/net.ts',line:12}]);
 lookRequests.length=0; script=()=>({text:'Checking.',reasoning:'',toolCalls:[{id:'g',name:'grep',arguments:'{"pattern":"timeout"}'}]});
 await lookAsk('loop');
 assert.equal(lookRequests.length,5,'look-ups stop after four rounds'); assert.match(lookRequests.at(-1).system,/look-up limit is reached/);
 assert.match(lookEvents.find(e=>e.done&&e.requestId==='loop').answer,/^Checking\./);
 lookRequests.length=0; provider.models[0].tools=false; script=()=>result('From the chat.');
 await lookAsk('no-tools');
 assert.equal(lookRequests[0].tools,undefined,'models without tool support answer from the chat'); assert(lookEvents.find(e=>e.started&&e.requestId==='no-tools').lookupsUnavailable);
 delete provider.models[0].tools;
 lookRequests.length=0; await lookAsk('plain',{sources:[]}); assert.equal(lookRequests[0].tools,undefined,'no source chosen, no tools offered');
 assert.equal(JSON.stringify(messages),snapshot,'look-ups leave the main session untouched');
 looker.dispose();
 const {fitSideChatMessages}=require('../out/host/sideChat');
 const largeOutput='你好 source line\n'.repeat(2000);
 const beforeWindow=provider.models[0].contextWindow;
 try {
  for (const window of [4096,8192]) {
   provider.models[0].contextWindow=window;
   const boundedEvents=[], wire=[];
   const bounded=new SideChatHost(ctx,()=>({sessionId,messages}),async(p,key,options)=>{
    const bytes=Buffer.byteLength(JSON.stringify({system:options.system,messages:options.messages,tools:options.tools}));
    assert(bytes+options.maxTokens+1024<=window,'every lookup request fits its input and output allowance');
    wire.push(options);
    if(wire.length===1) return {text:'',reasoning:'',toolCalls:Array.from({length:6},(_,i)=>({id:'read-'+i,name:'read_file',arguments:JSON.stringify({path:'file-'+i})}))};
    assert.equal(options.messages.filter(m=>m.role==='tool').length,6,'clipping keeps every tool reply paired');
    assert(options.messages.some(m=>m.role==='user'&&m.content.includes('Compare the files')),'the question is retained');
    assert(!JSON.stringify(options.messages).includes('\ufffd'),'UTF-8 clipping preserves complete characters');
    return result('The files were compared.');
   },{defs:()=>toolDefs,run:async()=>({api:largeOutput,summary:'read'})});
   try {
    await bounded.handle({kind:'chat',post:m=>boundedEvents.push(m)},{type:'sideChatAsk',sideChatId:'bounded-client',sessionId,requestId:'bounded',question:'Compare the files',excerpt:'',sources:['project']});
    assert.equal(wire.length,2);
    assert.equal(boundedEvents.at(-1).answer,'The files were compared.');
   } finally {bounded.dispose();}
  }
  const original=[{role:'user',content:'reference'.repeat(500)},{role:'user',content:'actual question'},{role:'assistant',content:'',toolCalls:[{id:'large-call',name:'read_file',arguments:'x'.repeat(5000)}]},{role:'tool',name:'read_file',toolCallId:'large-call',content:'evidence'}];
  const copy=JSON.stringify(original);
  assert.throws(()=>fitSideChatMessages(original,'system',undefined,1000),/too large/,'irreducible arguments fail before sending an oversized request');
  assert.equal(JSON.stringify(original),copy,'fitting never mutates the retained conversation');
 } finally {provider.models[0].contextWindow=beforeWindow;}

 // Saved turns follow the session: each client keeps its own last six exchanges, and a stopped answer is kept.
 const kept=new Map(); const keptCtx={...ctx,store:{...ctx.store,getSideChat:id=>kept.get(id),saveSideChat:async(id,history)=>history===undefined?kept.delete(id):kept.set(id,JSON.parse(JSON.stringify(history.slice(-48))))}};
 const keptEvents=[]; const keptSurface={kind:'chat',post:m=>keptEvents.push(m)}; let hold=null;
 const keeper=new SideChatHost(keptCtx,()=>({sessionId,messages}),async(p,key,options)=>{ if(hold) return hold(options); options.onText('ok'); return result('ok'); });
 const keepAsk=(client,requestId,extra={})=>keeper.handle(keptSurface,{type:'sideChatAsk',sideChatId:client,sessionId,requestId,question:'Q '+requestId,excerpt:'',providerId:'api',model:'model',remember:true,...extra});
 const savedText=()=>JSON.stringify(kept.get(sessionId)||[]);
 await keepAsk('desk-client','d1');
 for(let i=0;i<10;i++) await keepAsk('phone-client','p'+i);
 assert(savedText().includes('Q d1'),'a busy client cannot push another client’s saved turns out');
 assert.equal((savedText().match(/Q p\d/g)||[]).length,6,'each client keeps its last six exchanges');
 await keepAsk('tab-client','t1',{remember:false}); assert(!savedText().includes('Q t1'),'a client that does not save leaves the store alone');
 hold=options=>new Promise((resolve,reject)=>{options.onText('Half an answer');options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
 const half=keepAsk('desk-client','d2'); while(!keptEvents.some(e=>e.requestId==='d2'&&e.text)) await new Promise(r=>setImmediate(r));
 await keeper.handle(keptSurface,{type:'sideChatStop',sideChatId:'desk-client',sessionId,requestId:'d2'}); await half;
 assert(keptEvents.find(e=>e.requestId==='d2'&&e.done).stopped);
 assert(savedText().includes('Half an answer'),'a stopped answer stays in the saved thread');
 hold=null; const before=kept.get(sessionId).length;
 await keeper.handle(keptSurface,{type:'sideChatRestore',sideChatId:'desk-client',sessionId});
 assert(keptEvents.at(-1).history.some(m=>m.content==='Half an answer'),'a follow-up continues from the stopped answer');
 assert.equal(kept.get(sessionId).length,before);
 keeper.dispose();
 console.log('Side Chat: isolated context and follow-ups, clients, validation, cancellation, session boundaries, bounded and cache-stable context, read-only look-ups, per-client saved turns and stopped answers passed.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
