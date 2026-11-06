'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const base = fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-profile-actions-'));
const profile = path.join(base,'profile'); fs.mkdirSync(path.join(profile,'data'),{recursive:true});
fs.writeFileSync(path.join(profile,'window.json'),'{"width":1200}');
fs.writeFileSync(path.join(profile,'data/global-state.json'),'{"chats":["original"]}');
const file = path.join(base,'profile.zcbackup');
let accept = false, busy = false, stops = 0, restarts = 0, failStop = false;
const window = { retainsWork:()=>busy, pending:null, rememberSize(){}, async stopAll(){stops++;if(failStop)throw Error('fixture shutdown failure');} };
const shell = { windows:new Set([window]) };
const electron = { app:{getVersion:()=> 'fixture',getPath:()=>base,relaunch:()=>restarts++,quit(){}}, safeStorage:{}, dialog:{showSaveDialog:async()=>({filePath:file}),showOpenDialog:async()=>({filePaths:[file]}),showMessageBox:async()=>({response:accept?1:0,checkboxChecked:false})} };
const load = Module._load;
Module._load = function(name,parent,...rest){if(name==='electron')return electron;if(name==='./paths'&&parent?.filename.endsWith('profile-actions.js'))return{configDir:()=>profile};return load.call(this,name,parent,...rest);};
let run;try{({run}=require('../app/profile-actions'));}finally{Module._load=load;}
(async()=>{try{
	busy=true;await assert.rejects(run(shell,{},false),/Finish or stop/);assert.equal(stops,0);busy=false;
	assert.equal((await run(shell,{},false)).cancelled,true);assert.equal(stops,0);assert.equal(restarts,0);
	accept=true;assert.equal((await run(shell,{},false)).ok,true);assert.equal(stops,1);assert.equal(restarts,1);assert(fs.existsSync(file));
	fs.writeFileSync(path.join(profile,'data/global-state.json'),'{"chats":["changed"]}');
	assert.equal((await run(shell,{},true)).ok,true);assert.equal(restarts,2);assert.equal(shell.profileRestored,true);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'data/global-state.json'))).chats,['original']);
	failStop=true;assert.equal((await run(shell,{},false)).ok,false);assert.equal(restarts,3);assert.equal(shell.profileOperation,false);
	console.log('Profile actions passed: active-work refusal, cancellation, quiesced backup/restore, restart and failed-shutdown recovery.');
}finally{if(path.dirname(base)===os.tmpdir()&&path.basename(base).startsWith('zer0ne-profile-actions-'))fs.rmSync(base,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
