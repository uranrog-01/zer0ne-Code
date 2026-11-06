'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const http=require('http');
const {fork}=require('child_process');
const root=path.resolve(__dirname,'..');
if(process.argv[2]==='worker') {
 const {startHost}=require('../host/host');
 let host;
 startHost({engineDir:path.join(root,'engine'),workspace:process.argv[3],dataDir:process.argv[4],rpc:async(op,args)=>{process.send({rpc:op,args});return op==='openDialog'?[path.join(process.argv[4],'plugin-source')]:null;}}).then(h=>{host=h;process.send({url:h.url});}).catch(error=>{process.send({error:error.stack});process.exit(1);});
 process.on('message',async message=>{
  try {
   if(message.stop) {await host.stop();process.exit(0);}
   if(message.preview) {await require('vscode').commands.executeCommand('zer0ne.previewArtifact',message.preview,'Test artifact');process.send({previewed:true});}
   if(message.report) {void require('vscode').commands.executeCommand('zer0ne.showReport','A safe report','Problem report');}
   if(message.runHooks) {const result=await require('../engine/out/tools/hooks').runHooks(message.runHooks,'UserPromptSubmit',{},process.argv[3]);process.send({hookResult:result});}
  } catch(error) {process.send({error:error.message});}
 });
} else main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});

function worker(workspace,dataDir) {
 const child=fork(__filename,['worker',workspace,dataDir],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
 const messages=[];let stderr='';child.stderr.on('data',c=>stderr+=c);
 child.on('message',m=>messages.push(m));
 const wait=async predicate=>{const until=Date.now()+12000;while(Date.now()<until){const i=messages.findIndex(predicate);if(i>=0)return messages.splice(i,1)[0];if(child.exitCode!==null)throw Error('Worker exited: '+stderr);await new Promise(r=>setTimeout(r,20));}throw Error('Worker timed out: '+stderr);};
 return {child,messages,wait,async stop(){if(child.exitCode===null){const exit=new Promise(r=>child.once('exit',r));child.send({stop:true});await exit;}}};
}
function events(url) {
 const messages=[];
 const request=http.get(new URL('/api/events?t='+new URL(url).searchParams.get('t'),url),res=>{let buffer='';res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('data: '))messages.push(JSON.parse(frame.slice(6)));}});});
 return {messages,close:()=>request.destroy(),async wait(predicate){const until=Date.now()+12000;while(Date.now()<until){const i=messages.findIndex(predicate);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,20));}throw Error('SSE timed out');}};
}
async function post(url,message) {
 const response=await fetch(new URL('/api/msg',url),{method:'POST',headers:{'Content-Type':'application/json','X-Zer0ne-Token':new URL(url).searchParams.get('t'),'X-Zer0ne-Protocol':'1', 'X-Zer0ne-Command': require('crypto').randomUUID()},body:JSON.stringify(message)});assert.ok([202,204].includes(response.status),String(response.status));
}
async function freePort() {
 const server=require('net').createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
async function main() {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-live-hosts-'));const folder=path.join(tmp,'retired-project');fs.mkdirSync(folder);
 const dataDir=path.join(tmp,'data');const key=crypto.createHash('sha1').update(process.platform==='win32'?folder.toLowerCase():folder).digest('hex').slice(0,16);
 const stateFile=path.join(dataDir,'workspaces',key,'state.json');fs.mkdirSync(path.dirname(stateFile),{recursive:true});
 const jobs=[{id:'legacy',enabled:true,prompt:'never execute',schedule:{kind:'once',at:1}}];
 fs.writeFileSync(stateFile,JSON.stringify({'zer0ne.scheduledJobs':jobs,'zer0ne.scheduledResults':[{id:'live-legacy-result',status:'running'}]}));
 const fixture=path.join(dataDir,'plugin-source');
 for(const dir of ['.claude-plugin','commands','skills/fixture','hooks']) fs.mkdirSync(path.join(fixture,dir),{recursive:true});
 fs.writeFileSync(path.join(fixture,'.claude-plugin/plugin.json'),JSON.stringify({name:'restore-fixture',version:'1.0.0'}));
 fs.writeFileSync(path.join(fixture,'commands/check.md'),'---\ndescription: Fixture command\n---\nCheck $ARGUMENTS');
 fs.writeFileSync(path.join(fixture,'skills/fixture/SKILL.md'),'---\nname: fixture\ndescription: Fixture instructions\n---\nRead the current project.');
 const hookScript=path.join(fixture,'hook.js');fs.writeFileSync(hookScript,"require('fs').writeFileSync('hook-ran.txt',process.cwd());console.log('plugin hook ran')");
 const hookCommand=(process.platform==='win32'?'& ':'')+'"'+process.execPath+'" "${CLAUDE_PLUGIN_ROOT}/hook.js"';
 fs.writeFileSync(path.join(fixture,'hooks/hooks.json'),JSON.stringify({hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:hookCommand}]}]}}));
 fs.writeFileSync(path.join(fixture,'.mcp.json'),JSON.stringify({mcpServers:{fixture:{url:'http://127.0.0.1:1',enabled:false}}}));
 const a=worker(folder,dataDir);let b,c,ea,eb,ec,phone;
 try {
  const ra=await a.wait(m=>m.url);ea=events(ra.url);
  const sa=await ea.wait(m=>m.type==='state');assert.equal(sa.capabilities.optionalServiceOwner,true);
  b=worker(folder,dataDir);const rb=await b.wait(m=>m.url);eb=events(rb.url);
  const sb=await eb.wait(m=>m.type==='state');assert.equal(sb.capabilities.optionalServiceOwner,false);assert.equal(sb.settings.mcp,false);assert.equal(sb.settings.browserAgent,false);
  await post(rb.url,{type:'runJob',id:'legacy'});assert.match((await eb.wait(m=>m.type==='status'&&m.kind==='error')).message,/unavailable|not available|desktop/i);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile))['zer0ne.scheduledJobs'],jobs);
  assert.equal(JSON.parse(fs.readFileSync(stateFile))['zer0ne.scheduledResults'][0].status,'running');
  const artifactDir=path.join(folder,'.zer0ne/artifacts');fs.mkdirSync(artifactDir,{recursive:true});const artifact=path.join(artifactDir,'report.html');fs.writeFileSync(artifact,'<html><head></head><body><script>window.example=true</script><h1>Preview result</h1></body></html>');
  a.child.send({preview:artifact});await a.wait(m=>m.previewed);const dialog=await ea.wait(m=>m.type==='zcPrompt'&&m.options.kind==='artifact');
  const preview=await fetch(new URL(dialog.options.url,ra.url),{headers:{Cookie:'zr='+new URL(ra.url).searchParams.get('t')}});assert.equal(preview.status,200);assert.match(preview.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);assert.match(preview.headers.get('Content-Security-Policy'),/connect-src 'none'/);assert.match(await preview.text(),/Preview result/);
  assert(!dialog.options.url.includes(new URL(ra.url).searchParams.get('t')),'Artifact documents never receive the engine credential');
  assert.equal((await fetch(new URL('/api/artifacts/forged-id',ra.url),{headers:{Cookie:'zr='+new URL(ra.url).searchParams.get('t')}})).status,404);
  await post(ra.url,{type:'zcPromptReply',id:dialog.id});
  a.child.send({report:true});const report=await ea.wait(m=>m.type==='zcPrompt'&&m.options.kind==='report');assert.equal(report.options.content,'A safe report');
  await post(ra.url,{type:'zcReportAction',id:report.id,action:'copy',text:'untrusted replacement'});assert.equal((await a.wait(m=>m.rpc==='clipboardWrite')).args.text,'A safe report');
  await post(ra.url,{type:'zcPromptReply',id:report.id});
  await post(ra.url,{type:'reportProblem',note:'Actual desktop report regression'});
  const generatedReport=await ea.wait(m=>m.type==='zcPrompt'&&m.options.kind==='report');
  assert.match(generatedReport.options.content,/Actual desktop report regression/);
  assert.match(generatedReport.options.content,/zer0ne Code/);assert(!generatedReport.options.content.includes('VS Code'));
  await post(ra.url,{type:'zcPromptReply',id:generatedReport.id});
  a.child.send({preview:path.join(tmp,'outside.html')});await a.wait(m=>m.error);
  await post(ra.url,{type:'saveMcp',server:{name:'owned',transport:'http',url:'http://127.0.0.1:1',enabled:false}});await ea.wait(m=>m.type==='state'&&m.mcp.some(s=>s.name==='owned'));
  assert(JSON.parse(fs.readFileSync(stateFile))['aiChat.mcpServers'].some(s=>s.name==='owned'));
  assert(!JSON.parse(fs.readFileSync(path.join(dataDir,'global-state.json')))['aiChat.mcpServers']);
  await post(ra.url,{type:'installPlugin',from:'folder',scope:'workspace'});
  const installedState=await ea.wait(m=>m.type==='state'&&m.plugins.some(p=>p.name==='restore-fixture'));
  const installedPlugin=installedState.plugins.find(p=>p.name==='restore-fixture');
  assert.equal(installedPlugin.enabled,false,'Code-running plugin installs switched off');
  assert(!installedState.hooks.some(h=>h.command.includes('hook.js')));
  await post(ra.url,{type:'togglePlugin',name:installedPlugin.id,enabled:true});
  const pluginState=await ea.wait(m=>m.type==='state'&&m.plugins.some(p=>p.id===installedPlugin.id&&p.enabled));
  assert(pluginState.commands.some(command=>command.name==='restore-fixture:check'));
  assert(!pluginState.commands.some(command=>command.name==='mod'));
  assert(pluginState.skills.some(skill=>skill.name==='fixture'));
  assert(pluginState.hooks.some(hook=>hook.command.includes('hook.js')));
  assert(pluginState.mcp.some(server=>server.name.includes('fixture')),'Plugins expose their MCP servers to the project owner');
  await post(ra.url,{type:'mktSources'});assert((await ea.wait(m=>m.type==='mktSources')).sources.length);
  a.child.send({runHooks:pluginState.hooks});assert.match((await a.wait(m=>m.hookResult)).hookResult.context,/plugin hook ran/);
  assert.equal(fs.realpathSync.native(fs.readFileSync(path.join(folder,'hook-ran.txt'),'utf8')).toLowerCase(),fs.realpathSync.native(folder).toLowerCase(),'Plugin hooks run in their originating project');
  await post(ra.url,{type:'togglePlugin',name:'restore-fixture',enabled:false});
  const disabled=await ea.wait(m=>m.type==='state'&&m.plugins.some(p=>p.name==='restore-fixture'&&!p.enabled));
  assert(!disabled.commands.some(command=>command.name==='restore-fixture:check'));assert(!disabled.hooks.some(hook=>hook.command.includes('hook.js')));
  await post(ra.url,{type:'saveHook',hook:{event:'PreToolUse',matcher:'read_file',command:'echo hook',enabled:true}});
  assert((await ea.wait(m=>m.type==='state'&&m.hooks.some(h=>h.command==='echo hook'))).hooks.some(h=>h.matcher==='read_file'));
  const other=path.join(tmp,'other-project');fs.mkdirSync(other);c=worker(other,dataDir);const rc=await c.wait(m=>m.url);ec=events(rc.url);
  const sc=await ec.wait(m=>m.type==='state');assert.equal(sc.settings.remoteEnabled,false);
  const port=await freePort();await post(ra.url,{type:'updateSettings',patch:{remoteEnabled:true,remotePort:port,remoteAccess:'lan',remoteSshTarget:'owner@fixture.invalid:2222',remoteSshRemotePort:8080}});
  const remote=await ea.wait(m=>m.type==='state'&&m.remote.running);
  assert.equal(remote.remote.access,'lan');assert.equal(remote.remote.tunnel.state,'off');assert.equal(remote.remote.project,folder);
  assert.equal((await a.wait(m=>m.rpc==='retainRemote'&&m.args.on)).args.on,true);
  const phoneUrl='http://127.0.0.1:'+port+'/?t='+JSON.parse(fs.readFileSync(stateFile))['aiChat.remoteToken'];
  const phoneHtml=await(await fetch(phoneUrl)).text();assert(phoneHtml.includes('desktopHost: true'));assert(!phoneHtml.includes('aux-tab-tasks'));assert(!phoneHtml.includes('/media/analysis.js'));
  for(const id of ['btn-mods','mods-popup','mod-band']) assert(!phoneHtml.includes('id="'+id+'"'),id+' cannot appear in the phone composer');
  assert.equal((await fetch(new URL('/api/events?t=invalid',phoneUrl))).status,401);
  phone=events(phoneUrl);const phoneState=await phone.wait(m=>m.type==='state');assert(phoneState.sessions.every(session=>session.projectPath===folder));
  const phoneProjects=await phone.wait(m=>m.type==='projects');assert(phoneProjects.projects.every(project=>project.current));
  await post(phoneUrl,{type:'projectOpen',path:other});assert.match((await phone.wait(m=>m.type==='status'&&m.kind==='error')).message,/paired project/);
  await post(phoneUrl,{type:'switchSession',id:sc.currentSessionId});assert.match((await phone.wait(m=>m.type==='status'&&m.kind==='error')).message,/paired project/);
  await post(rb.url,{type:'remoteRegenerate'});assert.match((await eb.wait(m=>m.type==='status'&&m.kind==='error')).message,/owns.*Remote/);
  await post(rb.url,{type:'updateSettings',patch:{remoteAccess:'ssh'}});assert.match((await eb.wait(m=>m.type==='status'&&m.kind==='error')).message,/owns.*Remote/);
  const tokenBefore=JSON.parse(fs.readFileSync(stateFile))['aiChat.remoteToken'];
  await post(rb.url,{type:'updateSettings',patch:{theme:'terminal',glass:true,background:'image',backgroundImage:'saved.gif',glow:'subtle'}});
  const peer=await eb.wait(m=>m.type==='state'&&m.settings.theme==='terminal');assert.equal(peer.settings.remoteEnabled,false);
  assert.equal(JSON.parse(fs.readFileSync(stateFile))['zer0neDesktop.remote'].remoteEnabled,true,'Unrelated edits in a secondary host preserve the owner’s Remote setting');
  assert.equal(JSON.parse(fs.readFileSync(stateFile))['aiChat.remoteToken'],tokenBefore);
  await post(rc.url,{type:'updateSettings',patch:{remoteEnabled:true,remotePort:port}});
  const conflict=await ec.wait(m=>m.type==='state'&&m.remote.error);assert.match(conflict.remote.error,/already in use/);assert.equal(conflict.remote.running,false);
  const otherPort=await freePort();await post(rc.url,{type:'updateSettings',patch:{remotePort:otherPort}});
  const otherRemote=await ec.wait(m=>m.type==='state'&&m.remote.running);assert.equal(otherRemote.remote.port,otherPort);
  assert.equal(otherRemote.settings.remoteAccess,'lan');assert.equal(otherRemote.settings.remoteSshTarget,'','Other projects do not inherit this project’s SSH target');
  assert.equal(JSON.parse(fs.readFileSync(stateFile))['zer0neDesktop.remote'].remoteSshTarget,'owner@fixture.invalid:2222');
  const otherKey=crypto.createHash('sha1').update(process.platform==='win32'?other.toLowerCase():other).digest('hex').slice(0,16);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(dataDir,'workspaces',otherKey,'state.json')))['aiChat.remoteToken'],tokenBefore,'Projects use independent pairing credentials');
  await post(ra.url,{type:'remotePairCode'});const oneUse=await ea.wait(m=>m.type==='state'&&m.remote.pairCode);
  const pairRequest=code=>fetch(new URL('/api/pair',phoneUrl),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
  const paired=await pairRequest(oneUse.remote.pairCode);assert.equal(paired.status,200);
  const cookie=paired.headers.get('Set-Cookie').split(';')[0];assert.equal((await fetch(new URL('/',phoneUrl),{headers:{Cookie:cookie}})).status,200);
  assert.equal((await pairRequest(oneUse.remote.pairCode)).status,403,'Pairing codes work only once');
  await post(ra.url,{type:'remotePairCode'});const pairing=await ea.wait(m=>m.type==='state'&&m.remote.pairCode&&m.remote.pairCode!==oneUse.remote.pairCode);
  await post(ra.url,{type:'remoteRegenerate'});await ea.wait(m=>m.type==='status'&&m.message.startsWith('New pairing'));
  assert.equal((await fetch(phoneUrl)).status,401,'Regenerating signs out an old pairing link');
  assert.equal((await pairRequest(pairing.remote.pairCode)).status,403,'Regenerating also revokes an unused pairing code');
  assert.equal((await fetch(new URL('/',phoneUrl),{headers:{Cookie:cookie}})).status,401,'Regenerating signs out paired cookies');
  await post(ra.url,{type:'updateSettings',patch:{remoteEnabled:false}});await ea.wait(m=>m.type==='state'&&!m.remote.running&&!m.settings.remoteEnabled);
  await a.wait(m=>m.rpc==='retainRemote'&&!m.args.on);
  await post(rc.url,{type:'updateSettings',patch:{remoteEnabled:false}});await ec.wait(m=>m.type==='state'&&!m.remote.running&&!m.settings.remoteEnabled);
  await a.stop();await post(rb.url,{type:'getProjects'});await eb.wait(m=>m.type==='projects');
  assert.equal(JSON.parse(fs.readFileSync(stateFile))['zer0ne.scheduledResults'][0].status,'running');
 } finally {phone?.close();ea?.close();eb?.close();ec?.close();await c?.stop();await b?.stop();await a.stop();}
 const native=fs.readFileSync(path.join(root,'app/engines.js'),'utf8');assert(!native.includes('MAX_ENGINES'));assert(native.includes('this.retireIdle(r.key)'));assert(native.includes("this.retireIdle('')"));
 const {idleRetirable}=require('../app/engines');assert(!idleRetirable(false,false,false,true,false),'Mobile Remote keeps a project alive');assert(!idleRetirable(false,false,false,false,true),'a terminal command keeps a project alive');assert(!idleRetirable(false,false,true,false,false),'an agent run keeps a project alive');assert(idleRetirable(false,false,false,false,false));
 console.log('Real live hosts passed: exclusive services, project Remote pairing/routing/revocation, Plugins and Hooks, project MCP, untouched retired jobs, artifact previews and reports.');
}

