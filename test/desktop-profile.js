'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { JSDOM } = require('jsdom');
const { createDesktopShim } = require('../host/desktop-shim');
const { startHost, createBusyReporter } = require('../host/host');
const root = path.resolve(__dirname, '..');
const engineDir = path.join(root, 'engine');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-profile-'));
const workspace = path.join(tmp,'project'); fs.mkdirSync(workspace);
const dataDir = path.join(tmp,'data');
const rpc = async () => null;

async function main() {
 for (const file of fs.readdirSync(path.join(engineDir,'media')).filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath,['--check',path.join(engineDir,'media',file)],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
 const { shim, install } = createDesktopShim({engineDir,workspace,dataDir,rpc}); install(shim.vscode);
 const { ProviderStore, DEFAULT_SETTINGS } = require('../engine/out/providerStore');
 const { buildToolDefs, runTool } = require('../engine/out/tools/agentTools');
 const capabilities = require('../engine/out/host/capabilities');
 const store = new ProviderStore(shim.context(engineDir));
 const settings = capabilities.hostSettings({...DEFAULT_SETTINGS,debugTools:true,scheduledTasks:true,verifyDiagnostics:true,autocomplete:true,remoteEnabled:true,mods:true});
 for (const key of ['debugTools','scheduledTasks','verifyDiagnostics','autocomplete','mods']) assert.equal(settings[key],false,key);
 assert.equal(settings.remoteEnabled,true); assert.equal(settings.glass,true);
 const appearance = capabilities.hostSettings({...settings,theme:'terminal',background:'image',backgroundImage:'saved.gif',glow:'subtle',textReveal:'on',notificationSound:true});
 for (const [key,value] of Object.entries({theme:'terminal',background:'image',backgroundImage:'saved.gif',glow:'subtle',textReveal:'on',notificationSound:true})) assert.equal(appearance[key],value);
 assert.equal(store.getSettings().glow,'off','New desktop profiles stay quiet, while saved appearance choices are honored');
 // Turning an effect on matches the engine-wide default; it must still be saved on the desktop.
 await store.updateSettings({glow:'subtle',glass:true,textReveal:'auto'});
 const reopened = new ProviderStore(shim.context(engineDir)).getSettings();
 assert.deepEqual([reopened.glow,reopened.glass,reopened.textReveal],['subtle',true,'auto'],'Desktop effects switched on are saved');
 await store.updateSettings({glow:'off',glass:false,textReveal:'off'});
 assert.equal(new ProviderStore(shim.context(engineDir)).getSettings().glow,'off');
 for (const readOnly of [false,true]) {
  const names = buildToolDefs(settings,{readOnly}).map(t => t.name);
  assert(names.includes('read_file'));
  for (const name of names) assert(capabilities.hostToolAllowed(name),name);
 }
 for (const name of ['get_diagnostics','get_editor_context','code_intel','rename_symbol','edit_symbol','debug_start','schedule_task']) {
  assert.equal(capabilities.hostToolAllowed(name),false);
  assert.equal((await runTool({name,arguments:'{}'},{})).error,true);
 }
 for (const message of ['jobs','saveJob','finderLoad','analysisLoad','cliStatus','modsReload','telegramStart','discordStart','ntfyToggle','channelsStatus','openBrowserWindow']) assert.equal(capabilities.hostMessageAllowed(message),false,message);
 // Cloud tasks run in GitHub Actions, so the desktop app offers them too.
 assert.equal(capabilities.DESKTOP_CAPABILITIES.cloud,true);
 for (const message of ['cloudStatus','cloudSignIn','cloudToken','cloudSetup','cloudStart','cloudFollowUp','cloudCancel','cloudTeleport','cloudRefresh']) assert(capabilities.hostMessageAllowed(message),message);
 for (const message of ['toggleMod','hideMod','restartMod','newMod','reloadMods','installMod','installModSample','removeMod','openModsFolder','keepMod','validateMod']) assert.equal(capabilities.hostMessageAllowed(message),false,message);
 for (const message of ['models','modelSelect','toggleModel','setModelsEnabled','updateSettings','previewFile','reviewTurn','saveMcp','saveSkill','installPlugin','mktSources','mktInstall','remotePairCode','remoteRegenerate','remoteInstallHelper','saveHook']) assert(capabilities.hostMessageAllowed(message),message);
 assert(!capabilities.hostProviderAllowed({apiFormat:'vscode-lm'})); assert(capabilities.hostProviderAllowed({apiFormat:'acp'}));
 for (const message of ['acpAgents','acpSignIn','acpSignInCode','acpCancel']) assert(capabilities.hostMessageAllowed(message),message);
 assert(capabilities.hostProviderAllowed({apiFormat:'openai'}));

 fs.writeFileSync(path.join(workspace,'broken.js'),'const broken = ;');
 const { Verifier } = require('../engine/out/host/verify');
 const verifier = new Verifier({scheduleState() {}});
 const commandContext = {settings, signal:new AbortController().signal, requestApproval:async()=>({approved:true,auto:true,finish(){}}), sandbox:{mode:'off',network:true,storageDir:dataDir,sourceFile:path.join(engineDir,'media/sandbox/lowil.cs')}};
 const conversation = [];
 await verifier.verifyTurn(conversation,['broken.js'],{...settings,verifyCommand:'',verifyAutoDetect:false},{edits:1,checked:0,rounds:0},new AbortController().signal);
 assert.equal(conversation.length,0,'No language service cannot produce a successful verification card');
 const feedback = await verifier.verifyTurn(conversation,['broken.js'],{...settings,verifyCommand:`${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" --check broken.js`},{edits:1,checked:0,rounds:0},new AbortController().signal,commandContext);
 assert.match(feedback,/failed/); assert.match(feedback,/SyntaxError/); assert.equal(conversation[0].tool.status,'error');
 const canceled = [];
 await assert.rejects(verifier.verifyTurn(canceled,['broken.js'],{...settings,verifyCommand:'node --check broken.js'},{edits:1,checked:0,rounds:0},AbortSignal.abort()), {name:'AbortError'});
 assert(!canceled.some(m => m.tool?.summary === 'passed'));
 assert.equal(canceled[0].tool.status,'error','A canceled check cannot show a successful completion mark');
 const commandExecution = require('../engine/out/tools/command');
 const originalShell = commandExecution.executeCommand;
 fs.writeFileSync(path.join(workspace,'package.json'),JSON.stringify({scripts:{test:'missing-test-command'}}));
 const skipped = [];
 try {
  commandExecution.executeCommand=async()=>({code:1,out:"'npm' is not recognized",timedOut:false});
  await verifier.verifyTurn(skipped,['broken.js'],{...settings,verifyCommand:'',verifyAutoDetect:true},{edits:1,checked:0,rounds:0},new AbortController().signal,commandContext);
  assert.equal(skipped[0].tool.status,'error','A missing auto-detected checker cannot show a successful completion mark');
  assert.match(skipped[0].tool.summary,/skipped/);
 } finally {commandExecution.executeCommand=originalShell;fs.unlinkSync(path.join(workspace,'package.json'));}

 const { TurnHistory } = require('../engine/out/host/turnHistory');
 const posts = [];
 const cp = {files:{'broken.js':{before:'before',after:'after'},'deleted.txt':{before:'deleted',after:null}}};
 const history = new TurnHistory({postAll:m=>posts.push(m)},{checkpoints:{load:()=>cp},sessionId:()=> 's'});
 await history.handle({}, {type:'reviewTurn',id:'turn'});
 assert.deepEqual(posts[0].files,[{path:'broken.js',before:'before',after:'const broken = ;'},{path:'deleted.txt',before:'deleted',after:null}]);
 const { runMoreTool } = require('../engine/out/tools/moreTools');
 const artifact = await runMoreTool('publish_artifact',{name:'report',title:'Report',html:'<!doctype html><html><head></head><body>Report</body></html>'},{settings,requestApproval:async()=>({approved:true,finish(){}}),openArtifact:async()=>{throw new Error('preview failed');}});
 assert.match(artifact.api,/Preview unavailable: preview failed/); assert(fs.existsSync(path.join(workspace,'.zer0ne/artifacts/report.html')));
 const { Attachments } = require('../engine/out/host/attachments');
 const attachmentFile = path.join(tmp,'pending-attachments.json');
 const attachmentContext = {status(message) {throw Error(message);}};
 const uploads = new Attachments(attachmentContext,attachmentFile);
 uploads.items.push({id:'text',name:'notes.txt',kind:'text',content:'unsent notes'});
 uploads.addImage('test.png','image/png','aGVsbG8='); uploads.view();
 const restored = new Attachments(attachmentContext,attachmentFile);
 assert.deepEqual(restored.items,uploads.items,'Pending text and image uploads survive engine retirement');
 const savedAt = fs.statSync(attachmentFile).mtimeMs; restored.view();
 assert.equal(fs.statSync(attachmentFile).mtimeMs,savedAt,'State broadcasts do not rewrite unchanged upload bytes');
 restored.clear(); assert.equal(new Attachments(attachmentContext,attachmentFile).items.length,0,'Sent uploads cannot reappear on restart');
 shim.dispose();

 // Both live hosts see the same saved job; neither constructs its retired scheduler.
 const key = crypto.createHash('sha1').update(process.platform==='win32'?path.resolve(workspace).toLowerCase():path.resolve(workspace)).digest('hex').slice(0,16);
 const statePath = path.join(dataDir,'workspaces',key,'state.json');
 fs.mkdirSync(path.dirname(statePath),{recursive:true});
 const jobs = [{id:'old-job',name:'Retired project',enabled:true,schedule:{kind:'once',at:Date.now()-1000},prompt:'do not run'}];
 fs.writeFileSync(statePath,JSON.stringify({'zer0ne.scheduledJobs':jobs,'zer0ne.scheduledResults':[{id:'r',status:'running'}]}));
 const a = await startHost({engineDir,workspace,dataDir,rpc});
 const b = await startHost({engineDir,workspace,dataDir,rpc});
 try {
  const htmlA = await (await fetch(a.url)).text(); const htmlB = await (await fetch(b.url)).text();
  assert(!htmlA.includes('aux-tab-tasks')); assert(!htmlA.includes('/media/analysis.js'));
  for(const id of ['btn-mods','mods-popup','mod-band']) assert(!new JSDOM(htmlA).window.document.getElementById(id),id+' cannot appear in the desktop composer');
  await assert.rejects(a.activate({kind:'session',sessionId:'missing'},'bad'),/unavailable/);
  await a.activate(null,'recovered');
  for (const host of [a,b]) await host.activate(null,'refresh');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath))['zer0ne.scheduledJobs'],jobs);
  assert.equal(JSON.parse(fs.readFileSync(statePath))['zer0ne.scheduledResults'][0].status,'running','No retired scheduler rewrites another host’s results');
  const headers = {'Content-Type':'application/json','X-Zer0ne-Token':new URL(a.url).searchParams.get('t'),'X-Zer0ne-Protocol':'1'};
  await fetch(new URL('/api/msg',a.url),{method:'POST',headers,body:JSON.stringify({type:'zcViewState',state:{draft:'unsent project text'}})});
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.match(await (await fetch(a.url)).text(),/unsent project text/);
  assert(htmlA.includes('zc-dialog')); assert(htmlB.includes('zc-dialog'));
 } finally { await b.stop(); await a.stop(); }
 assert.equal(fs.readdirSync(path.join(dataDir,'service-owners')).length,0);
 const {projectServiceOwner} = require('../host/ownership');
 const first=projectServiceOwner(dataDir,workspace),second=projectServiceOwner(dataDir,workspace);
 assert(first.owned); assert(!second.owned); second.release();
 assert(!projectServiceOwner(dataDir,workspace).owned,'Secondary release cannot steal an owner'); first.release();
 const replacement=projectServiceOwner(dataDir,workspace); assert(replacement.owned); replacement.release();

 const uiPosts = [];
 const dom = new JSDOM('<body><div id="settings-root"></div><div id="dialog-root"></div><div id="toast"></div></body>',{runScripts:'outside-only'});
 const w = dom.window;
 w.Bridge={desktop:true,remote:false,getState:()=>({settingsSection:'mods'}),patchState(){},post:m=>uiPosts.push(m)};
 w.Icons={svg:()=>'<svg></svg>'};
 w.eval(fs.readFileSync(path.join(engineDir,'media/settings-remote.js'),'utf8'));
 w.eval(require('../engine/test/page-scripts').readPage('settings.js', path.join(engineDir, 'media')));
 w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',version:'test',settings,capabilities:capabilities.DESKTOP_CAPABILITIES,providers:[],presets:[]}}));
 w.Settings.open('models');
 const nav=[...w.document.querySelectorAll('[data-nav]')].map(n=>n.dataset.nav);
 for(const removed of ['finder','mods','tasks','cli']) assert(!nav.includes(removed),removed);
 for(const restored of ['appearance','plugins','hooks-memory','remote']) assert(nav.includes(restored),restored);
 assert(!nav.includes('hooks') && !nav.includes('memory'),'Hooks and Memory share one navigation entry');
 for(const section of ['general','appearance','features','about','remote','plugins','hooks']) { w.Settings.open(section); const text=w.document.getElementById('s-page').textContent; assert(!/Model finder|Scheduled & Cloud tasks|Telegram|Discord/.test(text),section); if(section !== 'appearance') assert(!/Copilot/.test(text),section); }
 w.Settings.open('appearance'); for(const label of ['Classic themes','Terminal','Customize','Background picture','Glass panels','Prism glow']) assert(w.document.getElementById('s-page').textContent.includes(label),label);
 w.document.querySelector('[data-theme-tab="terminal"]').click(); w.document.querySelector('[data-theme-pick="terminal"]').click(); assert(uiPosts.some(m=>m.type==='updateSettings'&&m.patch.theme==='terminal'));
 w.Settings.open('plugins'); assert.equal(w.document.querySelector('[data-plugin-tab="installed"]').getAttribute('aria-selected'),'true');
 w.document.querySelector('[data-plugin-tab="market"]').click(); assert(uiPosts.some(m=>m.type==='mktSources'));
 w.document.querySelector('.marketplace [data-plugin-tab="installed"]').click(); assert.equal(w.document.querySelector('[data-plugin-tab="installed"]').getAttribute('aria-selected'),'true');
 w.Settings.open('hooks'); assert(w.document.querySelector('[data-act="hook-add"]'));
 w.Settings.open('skills'); assert(w.document.getElementById('s-page').textContent.includes('Skills'));
 w.Bridge.desktop=false; w.Bridge.desktopHost=true; w.Settings.open('remote');
 assert(!/Telegram|Discord|Push alerts/.test(w.document.getElementById('s-page').textContent));
 for(const label of ['Same Wi-Fi','Anywhere','Own tunnel']) assert(w.document.getElementById('s-page').textContent.includes(label),label);
 for(const access of ['anywhere','ssh']) {
  w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',settings:{...settings,remoteAccess:access},remote:{running:true,access,urls:['http://127.0.0.1:7654/?t=fixture'],tunnel:{state:'off'},ssh:{state:'off'},helper:{installed:false},sshHelper:{installed:true}},capabilities:capabilities.DESKTOP_CAPABILITIES,providers:[],presets:[]}}));
  w.Settings.open('remote');const text=w.document.getElementById('s-page').textContent;
  assert(text.includes(access==='anywhere'?'Secure link helper':'SSH target'));assert(!/Telegram|Discord|Push alerts/.test(text));
  assert(text.includes('not ready'),'A local pairing link is not described as a working public tunnel');
 }
 w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',settings:{...settings,remoteAccess:'anywhere'},capabilities:{...capabilities.DESKTOP_CAPABILITIES,optionalServiceOwner:false},remote:{running:false,access:'anywhere',helper:{installed:false}}}}));w.Settings.open('remote');
 assert([...w.document.querySelectorAll('#s-page input, #s-page button')].every(control=>control.disabled),'All Remote actions, including helper installation, are disabled in a secondary host');
 assert(!uiPosts.some(m=>/^(telegram|discord|ntfy|channels)/.test(m.type)),'Remote never queries removed bot services');
 dom.window.close();

 for (const token of ['first-project','second-project']) {
  const phone=new JSDOM('<body></body>',{runScripts:'outside-only',url:'http://localhost:7654/'});const streams=[];
  phone.window.__REMOTE__={token,desktopHost:true};phone.window.EventSource=class {constructor(url){streams.push(url);}};
  phone.window.eval(fs.readFileSync(path.join(engineDir,'media/bridge.js'),'utf8'));
  assert.deepEqual(streams,['/api/events?t='+token+'&v=1'],'Each phone page authenticates its own versioned stream even when another project replaced the shared cookie');
  assert.equal(phone.window.Bridge.desktopHost,true);assert.equal(phone.window.Bridge.desktop,false);assert.equal(phone.window.Bridge.remote,true);phone.window.close();
 }
 const calls=[]; const busy=createBusyReporter((op,args)=>{calls.push(args);return Promise.resolve();});
 busy.observe({type:'state',isStreaming:false,desktopBackgroundRuns:[{sessionId:'background',status:'running'}]});
 assert.equal(calls[0].on,true); busy.observe({type:'state',isStreaming:false,desktopBackgroundRuns:[]}); assert.equal(calls[1].on,false);
 const serviceCalls=[]; const serviceBusy=createBusyReporter((op,args)=>{serviceCalls.push({op,args});return Promise.resolve();});
 serviceBusy.observe({type:'state',isStreaming:false,remote:{running:true}});
 assert.deepEqual(serviceCalls,[{op:'retainRemote',args:{on:true}},{op:'busy',args:{on:false,sessionId:null,activity:'idle',phase:'idle',detail:null}}]);
 serviceBusy.observe({type:'state',isStreaming:false,remote:{running:false}}); assert.deepEqual(serviceCalls.at(-1),{op:'retainRemote',args:{on:false}});
 serviceBusy.observe({type:'terminalActivity',running:true});
 assert.deepEqual(serviceCalls.at(-1),{op:'retainTerminal',args:{on:true}});
 const beforeRefresh=serviceCalls.length;
 serviceBusy.observe({type:'state',isStreaming:false,remote:{running:false}});
 serviceBusy.observe({type:'terminalDone',id:99,code:-1});
 serviceBusy.observe({type:'terminalActivity',running:true});
 assert.equal(serviceCalls.length,beforeRefresh,'Idle refresh, rejected commands and duplicate activity cannot release a running terminal');
 serviceBusy.observe({type:'terminalActivity',running:false});
 assert.deepEqual(serviceCalls.at(-1),{op:'retainTerminal',args:{on:false}});
 assert(!serviceCalls.some(c=>c.op==='busy'&&c.args.on),'Terminal activity never impersonates an agent run');
 console.log('Desktop profile passed: removed capabilities, real verification, review, saved artifacts, activation retry, drafts, retired scheduling and exclusive project service ownership.');
}
main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
