const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JSDOM } = require('jsdom');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname,'../out');
const media = path.resolve(OUT,'../media');
const control = require(path.join(OUT,'tools/computerControl'));

test('screenshot review is bounded, follows chat changes and never loads remote image URLs', () => {
	const dom = new JSDOM('<body><button id="origin">Review</button></body>', {runScripts:'outside-only'}), w = dom.window;
	w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
	w.eval(fs.readFileSync(path.join(media, 'computer-history.js'), 'utf8'));
	const review = w.ComputerHistory.create();
	const messages = Array.from({length:12}, (_,i) => [{tool:{name:'computer',status:'done',summary:'click '+i}},{tool:{name:'computer',status:'done',image:'data:image/jpeg;base64,'+Buffer.from(String(i)).toString('base64')}}]).flat();
	messages.push({tool:{name:'computer',image:'https://outside.test/tracker'}});
	w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',currentSessionId:'one',messages}}));
	w.document.getElementById('origin').focus(); review.open();
	assert.equal(w.document.querySelectorAll('.cu-history img').length,8);
	assert.match(w.document.querySelector('figcaption').textContent,/click 4/);
	assert(w.document.querySelector('.cu-history-list').textContent.includes('click 11'));
	w.document.querySelector('.cu-history button').click(); assert.equal(w.document.activeElement.id,'origin');
	review.open(); w.dispatchEvent(new w.MessageEvent('message',{data:{type:'state',currentSessionId:'two',messages:[]}}));
	assert.equal(w.document.querySelector('dialog'),null); review.open(); assert.equal(w.document.querySelectorAll('img').length,0);
	dom.window.close();
});

test('desktop monitor readiness is tied to the exact observation and session cleanup cannot clear another chat', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(),'zc-computer-monitor-'));
	try {
		control.changeComputerPolicy(dir,p=>{p.allowed=['C:\\Editor.exe'];p.paused=false;});
		const folder=path.join(dir,'computer-use'), epoch=control.computerPolicy(dir).epoch;
		const p=control.presentComputer(dir,{session:'one',epoch,windowId:'42',processId:77,action:'click'});
		fs.writeFileSync(path.join(folder,'monitor-required.json'),JSON.stringify({pid:process.pid}));
		fs.writeFileSync(path.join(folder,'monitor-ready.json'),JSON.stringify({id:'older',epoch,pid:process.pid,at:Date.now()}));
		let resolved=false; const pending=control.awaitComputerMonitor(dir,p.id,epoch,new AbortController().signal).then(()=>{resolved=true;});
		await new Promise(r=>setTimeout(r,60)); assert.equal(resolved,false);
		fs.writeFileSync(path.join(folder,'monitor-ready.json'),JSON.stringify({id:p.id,epoch,pid:process.pid,at:Date.now()})); await pending;
		control.endComputerSession(dir,'other'); assert(fs.existsSync(path.join(folder,'presentation.json')));
		control.endComputerSession(dir,'one'); assert.equal(fs.existsSync(path.join(folder,'presentation.json')),false);
		const abort=new AbortController();abort.abort(); await assert.rejects(control.awaitComputerMonitor(dir,'missing',epoch,abort.signal),{name:'AbortError'});
	} finally {assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});

test('desktop permissions verify live app identity; remote requests cannot grant or resume',async()=>{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(),'zc-computer-host-'));
	const computer = require(path.join(OUT,'tools/computer')), original = computer.computerWindows;
	computer.computerWindows = async()=>[{path:'C:\\Tools\\Editor.exe',name:'Editor',title:'Work',windowId:'55',processId:99}];
	let changed, enabled=true;
	const host = new (require(path.join(OUT,'host/computerUseHost')).ComputerUseHost)({store:{getSettings:()=>({computerUse:enabled}),onSettingsChanged:cb=>(changed=cb,{dispose(){}})}},dir,'source');
	const messages=[], surface={kind:'chat',post:m=>messages.push(m)};
	try {
		await host.handle(surface,{type:'computerUseResume'}); assert.equal(messages.at(-1).type,'computerUseError');
		await host.handle(surface,{type:'computerUseAllow',windowId:'missing',processId:99,path:'C:\\Forged.exe'}); assert.equal(control.computerPolicy(dir).allowed.length,0);
		await host.handle(surface,{type:'computerUseAllow',windowId:'55',processId:99,path:'C:\\Forged.exe'});
		assert.deepEqual(control.computerPolicy(dir).allowed,['C:\\Tools\\Editor.exe']); assert.equal(control.computerPolicy(dir).paused,true);
		await host.handle({kind:'remote',post:m=>messages.push(m)},{type:'computerUseResume'}); assert.equal(control.computerPolicy(dir).paused,true);
		await host.handle(surface,{type:'computerUseResume'}); assert.equal(control.computerPolicy(dir).paused,false);
		enabled=false; changed(); assert.equal(control.computerPolicy(dir).paused,true);
		await host.handle(surface,{type:'computerUseResume'}); assert.equal(messages.at(-1).type,'computerUseError');
		await host.handle(surface,{type:'computerUseRevoke',path:'C:\\Tools\\Editor.exe'}); assert.deepEqual(control.computerPolicy(dir).allowed,[]);
	} finally {host.dispose();computer.computerWindows=original;assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});

test('permissions dialog, search, escaped app titles, Stop and focus restoration',()=>{
	const dom=new JSDOM('<body><div class="topbar-right"></div><button data-computer-use>Manage app permissions</button></body>',{runScripts:'outside-only'}), w=dom.window, sent=[];
	w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
	w.eval(fs.readFileSync(path.join(media,'computer-use.js'),'utf8'));
	const ui=w.ComputerUse.create({B:{post:m=>sent.push(m)},I:()=>'<svg></svg>'});
	const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));
	const state={type:'computerUseState',supported:true,enabled:true,paused:true,apps:[]};
	message(state);
	const button=w.document.querySelector('[data-computer-use]'); button.focus(); button.click();
	assert(w.document.querySelector('dialog').open); assert.equal(sent.at(-1).type,'computerUseApps');
	message({type:'computerUseApps',requestId:sent.at(-1).requestId,apps:[{path:'C:\\Editor.exe',name:'Editor',title:'<img src=x onerror=bad()>',windowId:'1',processId:2},{path:'C:\\Other.exe',name:'Other',title:'Other',windowId:'3',processId:4}]});
	assert.equal(w.document.querySelectorAll('dialog img').length,0);
	const search=w.document.querySelector('.cu-search'); search.value='Editor'; search.dispatchEvent(new w.Event('input',{bubbles:true})); assert.equal(w.document.querySelectorAll('[data-cu-allow]').length,1);
	w.document.querySelector('[data-cu-allow]').click(); assert.equal(sent.at(-1).windowId,'1'); assert.equal(sent.at(-1).processId,2);
	message({...state,requestId:sent.at(-1).requestId,apps:[{path:'C:\\Editor.exe',name:'Editor'}]});
	w.document.querySelector('[data-cu-resume]').click(); assert.equal(sent.at(-1).type,'computerUseResume');
	message({...state,requestId:sent.at(-1).requestId,paused:false,shortcut:true,active:{action:'type',at:Date.now()},apps:[{path:'C:\\Editor.exe',name:'Editor'}]});
	assert.match(w.document.querySelector('.cu-status-open').textContent,/Active/); assert.match(w.document.querySelector('[data-cu-shortcut]').textContent,/Ctrl/);
	w.document.querySelector('[data-cu-close]').click(); assert.equal(w.document.querySelector('dialog'),null); assert.equal(w.document.activeElement,button);
	w.document.querySelector('.cu-stop').click(); assert.equal(sent.at(-1).type,'computerUseStop');
	ui.open(); message({...state,requestId:sent.at(-1).requestId}); assert.equal(w.document.querySelector('[data-cu-resume]').disabled,true);
	w.document.querySelector('dialog').dispatchEvent(new w.Event('cancel',{cancelable:true})); assert.equal(w.document.querySelector('dialog'),null);
	dom.window.close();
});

test('global Stop persists across concurrent permission changes and starts paused after relaunch',async()=>{
	const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zc-computer-stop-')), folder=path.join(dir,'computer-use');
	const shell=require('../../app/computer-stop'); let registered, callback;
	const shortcuts={register:(_key,cb)=>(callback=cb,registered=true),unregister:()=>{registered=false;}};
	control.changeComputerPolicy(dir,p=>{p.allowed=['C:\\Editor.exe'];p.paused=false;});
	const close=shell.start(folder,shortcuts);
	try {
		assert.equal(control.computerPolicy(dir).paused,true);
		control.changeComputerPolicy(dir,p=>{p.paused=false;});
		await new Promise(resolve=>setTimeout(resolve,250)); assert.equal(registered,true);
		callback(); assert.equal(control.computerPolicy(dir).paused,true); assert.equal(registered,false);
		control.changeComputerPolicy(dir,p=>{p.paused=false;}); assert.equal(control.computerPolicy(dir).paused,false);
	} finally {close();assert.equal(control.computerPolicy(dir).paused,true);assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});

test('unavailable global Stop shortcuts are advertised honestly and retried',async()=>{
	const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zc-computer-stop-')), folder=path.join(dir,'computer-use');
	const shell=require('../../app/computer-stop'); let attempts=0, callback, unregistered=false;
	const close=shell.start(folder,{register:(_key,cb)=>{attempts++;if(attempts===1)throw new Error('unavailable');if(attempts===2)return false;callback=cb;return true;},unregister:()=>{unregistered=true;}});
	try {
		control.changeComputerPolicy(dir,p=>{p.allowed=['C:\\Editor.exe'];p.paused=false;});
		const deadline=Date.now()+5000;
		while(attempts<3&&Date.now()<deadline){
			assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'shortcut.json'),'utf8')).registered,false);
			await new Promise(resolve=>setTimeout(resolve,25));
		}
		assert.equal(attempts,3);
		assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'shortcut.json'),'utf8')).registered,true);
		callback();assert.equal(control.computerPolicy(dir).paused,true);assert.equal(unregistered,true);
		assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'shortcut.json'),'utf8')).registered,false);
	} finally {close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});

test('stopping a Computer Use approval retires its card and removes the pending callback',async()=>{
	const {createDesktopShim}=require('../../host/desktop-shim');
	const {shim,install}=createDesktopShim({engineDir:path.resolve(OUT,'..'),dataDir:os.tmpdir(),rpc:async()=>null}); install(shim.vscode);
	const {ChatController}=require(path.join(OUT,'chatController'));
	const receiver={sessionGrants:new Map(),approvals:new Map(),store:{getSettings:()=>({redactSecrets:false,sandbox:'off'})},scheduleState(){},sendState:async()=>{},notify(){},reviews:{has:()=>false}};
	const messages=[], abort=new AbortController();
	const pending=ChatController.prototype.requestApproval.call(receiver,messages,{kind:'command',command:'computer: type sample',signal:abort.signal});
	assert.equal(receiver.approvals.size,1); assert.equal(messages[0].approval.signal,undefined);
	abort.abort(); const result=await pending;
	assert.equal(result.approved,false);assert.equal(messages[0].approval.status,'rejected');assert.equal(receiver.approvals.size,0);
});
