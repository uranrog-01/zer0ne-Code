'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createDesktopShim } = require('../../host/desktop-shim');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname,'../out');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-features-')));
const project = path.join(base,'project'), storage = path.join(base,'storage'); fs.mkdirSync(project); fs.mkdirSync(storage);
const { shim, install } = createDesktopShim({engineDir:path.resolve(__dirname,'..'),workspace:project,dataDir:path.join(base,'data'),rpc:async () => null}); install(shim.vscode);
const { DEFAULT_SETTINGS } = require(path.join(OUT,'providerStore'));
const { featureCatalog } = require(path.join(OUT,'host/featureRegistry'));
const checks = require(path.join(OUT,'tools/projectChecks'));
const { LanguageService, closeLanguageServices } = require(path.join(OUT,'tools/languageService'));
const { browserScenarios, runBrowserScenarios } = require(path.join(OUT,'tools/browserChecks'));
const { featureToolDefs, runFeatureTool } = require(path.join(OUT,'tools/featureTools'));
const { FeatureToolsHost } = require(path.join(OUT,'host/featureToolsHost'));
const { FeaturesHealthHost } = require(path.join(OUT,'host/featuresHealth'));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
let dom;
let host;
async function main() {
	const defs = featureCatalog(true); assert(!defs.some(d => d.editorOnly)); assert.equal(new Set(defs.map(d => d.key)).size,defs.length);
	for (const d of defs) assert.equal(typeof DEFAULT_SETTINGS[d.key],'boolean',d.key+' has a persisted boolean default');
	assert(!featureCatalog(true,true).some(d => d.key === 'remoteEnabled'));
	const settings = {...DEFAULT_SETTINGS,commandTool:true,sandbox:'off',codeIntelligence:true,dependencyAudit:true,browserChecks:true,browserAgent:true,workspaceWatch:true};
	assert.deepEqual(featureToolDefs({...settings,commandTool:false}).map(d => d.name).sort(),['browser_regression','project_code_intel']);
	console.log('ok registry defaults, host filtering and execution dependencies');

	fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({scripts:{typecheck:'node check.cjs pass',lint:'node check.cjs fail',test:'node check.cjs never'}}));
	fs.writeFileSync(path.join(project,'check.cjs'),"const fs=require('fs'); console.log(process.argv[2]); if(process.argv[2]==='fail')process.exit(2); if(process.argv[2]==='never')fs.writeFileSync('should-not-run','bad');");
	const plan = await checks.createProjectPlan(project,'verify'); assert.deepEqual(plan.stages.map(s => s.name),['typecheck','lint','test']);
	const release = checks.acquireProjectCheck(project); assert.throws(() => checks.acquireProjectCheck(project),/already running/); release(); checks.acquireProjectCheck(project)();
	const context = {settings,signal:new AbortController().signal,requestApproval:async () => ({approved:true,auto:false,finish(){}})};
	let updates = 0;
	const report = await checks.runProjectPlan(plan,context,() => updates++);
	assert.equal(report.status,'failed'); assert.deepEqual(report.stages.map(s => s.status),['passed','failed']); assert(!fs.existsSync(path.join(project,'should-not-run'))); assert(updates >= 3); assert.equal(report.stale,false);
	fs.appendFileSync(path.join(project,'check.cjs'),'\n// changed'); await assert.rejects(checks.runProjectPlan(plan,context,() => {}),/changed after preview/);
	await assert.rejects(checks.runProjectPlan({...plan,createdAt:0},context,() => {}),/expired/);
	await assert.rejects(checks.runProjectPlan({...plan,configuration:'outdated'},context,() => {}),/settings changed after preview/);
	assert.throws(() => checks.projectFile(project,'../project-other/file'),/ENOENT|inside/);
	assert.throws(() => checks.projectFile(project,'check.cjs','*.cjs'),/allowed file/);
	assert.throws(() => checks.auditFindings('{"error":{"summary":"Registry unavailable"}}'),/Registry unavailable/);
	assert.equal(checks.auditFindings('{"vulnerabilities":{"pkg":{"severity":"high","isDirect":true,"fixAvailable":true}}}')[0].severity,'high');
	assert.deepEqual(checks.auditFindings('{"vulnerabilities":{}}'),[]);
	const before = await checks.projectFingerprint(project,'ignored.txt'); fs.writeFileSync(path.join(project,'ignored.txt'),'secret'); assert.equal(await checks.projectFingerprint(project,'ignored.txt'),before);
	fs.mkdirSync(path.join(project,'target')); fs.writeFileSync(path.join(project,'target','compiled'),'generated'); fs.mkdirSync(path.join(project,'.pytest_cache')); fs.writeFileSync(path.join(project,'.pytest_cache','data'),'generated'); assert.equal(await checks.projectFingerprint(project,'ignored.txt'),before);
	console.log('ok real verification commands, fail-fast stages, project lease, snapshot binding, deny paths and audit errors');

	fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({scripts:{test:'node slow.cjs'}}));
	fs.writeFileSync(path.join(project,'slow.cjs'),"require('fs').writeFileSync('started','1'); setTimeout(()=>require('fs').writeFileSync('late','bad'),15000);");
	const slow = await checks.createProjectPlan(project,'verify'), abort = new AbortController();
	const running = checks.runProjectPlan(slow,{...context,signal:abort.signal},() => {});
	const until = Date.now()+10000; while (!fs.existsSync(path.join(project,'started')) && Date.now()<until) await delay(30);
	assert(fs.existsSync(path.join(project,'started'))); abort.abort(); assert.equal((await running).status,'cancelled'); assert(!fs.existsSync(path.join(project,'late'))); checks.acquireProjectCheck(project)();
	console.log('ok cancellation terminates a real project check and releases its lease');

	const fixture = path.join(base,'lsp.cjs');
	fs.writeFileSync(fixture,`
const {pathToFileURL}=require('url');let buffer=Buffer.alloc(0);let uri;
function send(m){const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',...m}));const frame=Buffer.concat([Buffer.from('Content-Length: '+b.length+'\\r\\n\\r\\n'),b]);process.stdout.write(frame.subarray(0,13));process.stdout.write(frame.subarray(13));}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const at=buffer.indexOf('\\r\\n\\r\\n');if(at<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,at).toString())[1]);if(buffer.length<at+4+n)return;const m=JSON.parse(buffer.subarray(at+4,at+4+n));buffer=buffer.subarray(at+4+n);
if(m.method==='initialize')send({id:m.id,result:{capabilities:{definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,diagnosticProvider:true,workspaceSymbolProvider:true}}});
else if(m.method==='textDocument/didOpen')uri=m.params.textDocument.uri;
else if(m.method==='textDocument/diagnostic')send({id:m.id,result:{kind:'full',items:[{message:'fixture error',severity:1,range:{start:{line:0,character:0},end:{line:0,character:1}}}]}});
else if(m.method==='textDocument/definition'){send({id:900,method:'workspace/applyEdit',params:{edit:{changes:{[uri]:[]}}}});send({id:m.id,result:[{uri,range:{start:{line:0,character:0},end:{line:0,character:1}}},{uri:pathToFileURL(${JSON.stringify(path.join(base,'outside.ts'))}).href,range:{}}]});}
else if(m.method==='textDocument/references'){if(process.argv.includes('respond-references'))send({id:m.id,result:[{uri:pathToFileURL(${JSON.stringify(path.join(project,'source.test.ts'))}).href,range:{start:{line:0,character:0},end:{line:0,character:1}}}]});}
else if(m.method==='textDocument/documentSymbol')send({id:m.id,result:[{name:'café',kind:13,selectionRange:{start:{line:0,character:6},end:{line:0,character:10}},range:{start:{line:0,character:0},end:{line:0,character:14}}}]});
else if(m.method==='workspace/symbol')send({id:m.id,result:[]});
else if(m.id===900)require('fs').writeFileSync(${JSON.stringify(path.join(base,'edit-denied'))},String(m.error?.code));
}});`);
	fs.writeFileSync(path.join(project,'source.ts'),'const café = 1;'); fs.writeFileSync(path.join(base,'outside.ts'),'outside');
	const language = new LanguageService(project,process.execPath,[fixture]);
	try {
		const diagnostics = await language.inspect('diagnostics','source.ts',{}); assert.equal(diagnostics[0].message,'fixture error');
		const locations = await language.inspect('definition','source.ts',{line:1,character:1}); assert.equal(locations.length,1); assert.equal(locations[0].path,'source.ts');
		await delay(60); assert.equal(fs.readFileSync(path.join(base,'edit-denied'),'utf8'),'-32601');
		await assert.rejects(language.inspect('hover','source.ts',{}),/not supported/);
		await assert.rejects(language.inspect('definition','source.ts',{line:0}),/valid 1-based/);
		const cancel = new AbortController(); const pending = language.inspect('references','source.ts',{line:1},cancel.signal); setTimeout(() => cancel.abort(),80); await assert.rejects(pending,/cancelled/);
	} finally { language.dispose(); }
	fs.writeFileSync(path.join(project,'source.test.ts'),"import {café} from './source';");
	const { runMoreTool } = require(path.join(OUT,'tools/moreTools'));
	const impact = await runMoreTool('impact',{path:'source.ts'},{...context,settings:{...settings,languageServerCommand:process.execPath,languageServerArgs:JSON.stringify([fixture,'respond-references'])}});
	assert.match(impact.api,/Semantic references for café/); assert.match(impact.api,/Tests with server-reported references: source.test.ts/); closeLanguageServices();
	console.log('ok real stdio language server: fragmented frames, diagnostics, scoped definitions, denied edits, unsupported operations and cancellation');

	fs.mkdirSync(path.join(project,'.zer0ne')); const config = path.join(project,'.zer0ne','browser-checks.json');
	fs.writeFileSync(config,JSON.stringify([{name:'fixture',url:'http://localhost:3000',assertions:[{kind:'selector',value:'main'}]}])); assert.equal(browserScenarios(project)[0].assertions.length,1);
	fs.writeFileSync(config,JSON.stringify([{name:'bad',url:'http://user:secret@localhost',assertions:[]} ])); assert.throws(() => browserScenarios(project),/credentials/);
	const browserModule = require(path.join(OUT,'tools/browser')), Original = browserModule.BrowserAgent; let closed = false;
	browserModule.BrowserAgent = class { consoleLogs(){return '';} async navigate(){} async evaluate(){return 'false';} async snapshot(){return {screenshot:Buffer.from('fixture').toString('base64')};} async close(){closed=true;} };
	try {
		const result = {...report,id:require('crypto').randomUUID(),stages:[]}; await runBrowserScenarios([{name:'failure',url:'http://localhost:3000',assertions:[{kind:'selector',value:'main'}]}],result,storage,{path:'',headless:true},new AbortController().signal,() => {});
		assert.equal(result.stages[0].status,'failed'); assert.match(result.stages[0].output,/Assertion failed/); assert(fs.readdirSync(path.join(storage,'feature-shots')).length); assert(closed);
	} finally { browserModule.BrowserAgent = Original; }
	console.log('ok browser scenario validation, assertion failure evidence and browser cleanup');

	let settingsListener, changed; let currentSession='a';
	const originalWatcher = shim.vscode.workspace.createFileSystemWatcher;
	shim.vscode.workspace.createFileSystemWatcher = () => ({onDidCreate(fn){changed=fn;},onDidChange(fn){changed=fn;},onDidDelete(fn){changed=fn;},dispose(){}});
	const messages=[], surface={kind:'chat',post:m => messages.push(m)}, store={getSettings:() => settings,getMode:()=>'agent',onSettingsChanged:fn => {settingsListener=fn;return {dispose(){}};}};
	host = new FeatureToolsHost({store,postAll:m => messages.push(m),status(){}},storage,() => currentSession,()=>false,()=>messages.push({type:'invalidated'}));
	await host.handle(surface,{type:'featurePlan',kind:'verify',requestId:'p'}); const preview=messages.find(m=>m.type==='featurePlan'); assert(preview);
	await host.handle({...surface},{type:'featureRun',id:preview.plan.id,approved:true}); assert.match(messages.at(-1).error,/fresh plan/);
	currentSession='b'; await host.handle(surface,{type:'featureRun',id:preview.plan.id,approved:true}); assert.match(messages.at(-1).error,/fresh plan/);
	host.record(report); host.record({...report,id:require('crypto').randomUUID(),startedAt:report.startedAt+1}); assert.equal(fs.readdirSync(path.join(storage,'reports')).length,2);
	if (process.platform === 'win32') {
		fs.writeFileSync(path.join(project,'package.json'),JSON.stringify({scripts:{test:'node check.cjs pass'}})); settings.sandbox='auto'; settingsListener();
		await host.handle(surface,{type:'featurePlan',kind:'verify',requestId:'manual-windows'});
		const manual=messages.find(m=>m.type==='featurePlan' && m.requestId==='manual-windows'); assert.equal(manual.plan.outsideSandbox,true); assert.match(manual.plan.execution,/user permissions/);
		await host.handle(surface,{type:'featureRun',id:manual.plan.id,approved:true});
		assert(messages.some(m=>m.type==='featureReport' && m.report.id===manual.plan.id && m.report.status==='passed'));
		settings.sandbox='off'; settingsListener();
	}
	changed(shim.vscode.Uri.file(path.join(project,'source.ts'))); await delay(400); assert(messages.some(m=>m.type==='invalidated')); assert(messages.find(m=>m.type==='featureWorkspace').reports.every(r=>r.stale));
	settings.languageServerCommand=process.execPath; settings.languageServerArgs=JSON.stringify([fixture]); settingsListener();
	const query = host.handle(surface,{type:'featureLanguage',requestId:'disable-query',operation:'references',path:'source.ts',line:1});
	await delay(120); settings.codeIntelligence=false; settingsListener(); await query;
	assert(messages.some(m=>m.type==='featureToolsError' && m.requestId==='disable-query')); settings.codeIntelligence=true; settings.languageServerCommand=''; settings.languageServerArgs='[]';
	settings.workspaceWatch=false; settingsListener(); host.dispose(); host=undefined; shim.vscode.workspace.createFileSystemWatcher=originalWatcher;
	console.log('ok host plan surface/session ownership, concurrent-safe report files and debounced watch invalidation');

	const healthMessages=[]; const healthSurface={kind:'chat',post:m=>healthMessages.push(m)};
	store.resolveSelection=async()=>({provider:{name:'Fixture',apiFormat:'openai'},model:{id:'fixture',vision:true,tools:true}});
	const actualHealth = new FeaturesHealthHost({store,status(){},postAll(){}},{sessionId:()=>currentSession,checkReady:async()=>undefined,storageDir:storage,extensionDir:path.resolve(__dirname,'..'),codeIndexStats:()=>undefined,mcp:{statuses:()=>[]},mcpConfigs:()=>[],skills:{list:()=>[]},cacheStats:{input:0,cached:0}});
	const automatic = await actualHealth.check();
	for (const definition of defs) assert(automatic.some(item=>item.id===definition.check),'health covers '+definition.key);
	assert.equal(automatic.find(item=>item.id==='index').evidence,'configuration'); assert.equal(automatic.find(item=>item.id==='cache').evidence,'configuration');
	assert.equal(automatic.find(item=>item.id==='codeIntelligence').readiness,'setup'); actualHealth.dispose();
	const health = new FeaturesHealthHost({store,status(){},postAll(){}},{sessionId:()=>currentSession});
	health.check=async()=>{throw new Error('fixture failure');}; await health.handle(healthSurface,{type:'featuresCheck',requestId:'h',revision:4}); assert.equal(healthMessages[0].error,'fixture failure'); assert.equal(healthMessages[0].requestId,'h');
	let done; health.check=()=>new Promise(resolve=>{done=resolve;}); const pending=health.handle(healthSurface,{type:'featuresCheck',requestId:'old',revision:5}); await delay(0); await health.handle(healthSurface,{type:'featuresCancel'}); await pending; done([]); assert(healthMessages.at(-1).cancelled); health.dispose();
	await assert.rejects(runFeatureTool('project_verify',{}, {...context,settings:{...settings,projectVerification:false}}),/Enable this capability/);
	console.log('ok health failure/cancellation contracts and disabled-tool enforcement');

	dom = new JSDOM('<body><div id="settings-root"></div><div id="dialog-root"></div><div id="toast"></div></body>',{runScripts:'outside-only',pretendToBeVisual:true}); const w=dom.window, sent=[]; const errors=[];
	w.addEventListener('error',e=>errors.push(e.error||e.message));
	w.Bridge={desktop:true,getState:()=>({}),patchState(){},post:m=>sent.push(m)}; w.Icons={svg:()=>'<svg></svg>'}; w.UI={toast(){}}; w.HTMLElement.prototype.scrollIntoView=function(){};
	w.SettingsRemote={create:()=>({remotePage:()=>w.document.createElement('div')})};
	w.eval(require('./page-scripts').readPage('settings.js').replace('window.Settings = { open, close };','window.Settings = { open, close }; window.featureTest={S,featuresPage,requestFeaturesHealth,featureStatus,reviewFeaturePlan,renderPage};'));
	const state={type:'state',capabilities:{id:'desktop'},featureCatalog:defs,settings,selection:{providerId:'p',model:'m'},providers:[{id:'p',name:'Fixture'}],workspace:{name:'Fixture',path:project,where:'local'},hasWorkspace:true,mode:'agent',currentSessionId:'b'};
	const send=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m})); send(state); w.Settings.open('features');
	assert(w.document.querySelector('.features-hub')); assert.equal(w.document.querySelector('.cap-stat b').textContent,String(defs.length));
	const h1=sent.find(m=>m.type==='featuresCheck'); assert(h1); send({type:'featuresHealth',requestId:'old',revision:h1.revision,at:Date.now(),items:[]}); assert(w.featureTest.S.healthBusy);
	send({type:'featuresHealth',requestId:h1.requestId,revision:h1.revision,at:Date.now(),items:defs.map(d=>({id:d.check,label:d.name,state:'warn',evidence:'configuration',readiness:'available',detail:'Configured only'}))}); assert(!w.featureTest.S.healthBusy);
	w.featureTest.S.featureConfiguration='fixture'; w.featureTest.S.featureReports=[{kind:'verify',configuration:'fixture',status:'passed',stale:false,startedAt:Date.now()}];
	assert.equal(w.featureTest.featureStatus(defs.find(d=>d.key==='projectVerification')).label,'Last run passed');
	w.featureTest.S.featureReports[0].stale=true; assert.notEqual(w.featureTest.featureStatus(defs.find(d=>d.key==='projectVerification')).label,'Last run passed'); w.featureTest.S.featureReports=[];
	w.featureTest.reviewFeaturePlan({kind:'verify',root:project,fingerprint:'a'.repeat(64),scope:'Fixture',stages:[{name:'test',command:'npm run test'}],execution:'Runs outside an OS command sandbox with your user permissions.',outsideSandbox:true});
	assert.equal(w.document.querySelector('#dialog-root [data-ok]').textContent,'Run outside sandbox'); w.document.querySelector('#dialog-root [data-cancel]').click();
	w.document.querySelector('[data-feature-tab="capabilities"]').click(); const search=w.document.querySelector('#feature-search'); search.focus(); search.value='Code intelligence'; search.setSelectionRange(4,8); search.dispatchEvent(new w.Event('input',{bubbles:true})); assert.equal(w.document.querySelectorAll('[data-feature]').length,1); assert.equal(w.document.activeElement.id,'feature-search'); assert.equal(w.document.activeElement.selectionStart,4);
	const composing=w.document.activeElement; composing.dispatchEvent(new w.CompositionEvent('compositionstart',{bubbles:true})); send({...state,selection:{providerId:'p',model:'new'}}); assert.equal(w.document.activeElement,composing,'state update must preserve active IME composition'); composing.dispatchEvent(new w.CompositionEvent('compositionend',{bubbles:true})); assert.notEqual(w.document.activeElement,composing);
	const fresh=sent.filter(m=>m.type==='featuresCheck').at(-1); send({type:'featuresHealth',requestId:fresh.requestId,revision:fresh.revision,error:'offline',items:[],at:Date.now()}); assert(!w.featureTest.S.healthBusy); assert(w.document.body.textContent.includes('offline'));
	w.document.querySelector('[data-act="features-check"]').click(); const retry=sent.filter(m=>m.type==='featuresCheck').at(-1); assert.notEqual(retry.requestId,fresh.requestId); w.document.querySelector('[data-act="features-cancel"]').click(); assert(!w.featureTest.S.healthBusy);
	w.featureTest.S.featureHealthError=''; w.featureTest.S.health={at:Date.now()-700000,items:[]}; w.featureTest.featuresPage(); assert(w.featureTest.S.healthBusy,'expired checks refresh after the first result');
	Object.assign(w.featureTest.S,{section:'local',localView:'more',localTab:'activity',liveOn:true});
	const stops=()=>sent.filter(m=>m.type==='localLive' && m.on===false).length, stopCount=stops();
	w.featureTest.renderPage(true); w.featureTest.renderPage(); assert.equal(w.featureTest.S.liveOn,true); assert.equal(stops(),stopCount,'settings refresh must retain the active CPU sampling interval');
	w.Settings.close(); assert.equal(w.featureTest.S.liveOn,false); assert.equal(stops(),stopCount+1,'closing settings stops activity sampling');
	assert.deepEqual(errors,[]); dom.window.close(); dom=undefined;
	console.log('ok full settings UI: navigation, search/focus, IME preservation, late results, failures, retry, cancellation and TTL refresh');
}
main().then(()=>console.log('Features dashboard regression suite passed.')).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{host?.dispose();dom?.window.close();closeLanguageServices();shim.dispose();await fs.promises.rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
