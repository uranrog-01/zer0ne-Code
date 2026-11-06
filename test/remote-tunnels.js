'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const os=require('os');
const http=require('http');
const cp=require('child_process');
const {EventEmitter}=require('events');
const {PassThrough}=require('stream');
const {createDesktopShim}=require('../host/desktop-shim');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-tunnel-regression-'));
const {shim,install}=createDesktopShim({engineDir:path.join(root,'engine'),workspace:tmp,dataDir:path.join(tmp,'data'),rpc:async()=>null});install(shim.vscode);
const spawn=cp.spawn,spawnSync=cp.spawnSync;
cp.spawnSync=()=>({status:1,stdout:''});
const {QuickTunnel,SshTunnel,sshArgs,installCloudflared}=require('../engine/out/tunnel');
if(process.argv[2]==='installer') {
 installCloudflared(process.argv[3],()=>{}).then(file=>{process.send({file});shim.dispose();process.exit(0);},error=>{process.send({error:error.stack});process.exit(1);});
} else main().then(()=>{console.log('Remote tunnels passed: cancellation, duplicate starts, stale exits, spawn failures, SSH ports and shared helper installation.');process.exit(0);},error=>{console.error(error);process.exit(1);});
function child() {
 const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.exitCode=null;
 p.kill=()=>{p.exitCode=0;p.emit('exit',0);return true;};return p;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function main() {
 const processes=[];cp.spawn=()=>{const p=child();processes.push(p);return p;};
 try {
  let finish;const canceled=new QuickTunnel(tmp,()=>{});canceled.install=()=>new Promise(resolve=>finish=resolve);
  const waiting=canceled.start(7654);canceled.stop();finish('fixture-helper');await waiting;
  assert.equal(processes.length,0,'Turning Remote off during installation cannot reopen a tunnel');assert.equal(canceled.status.state,'off');
  let installs=0;const quick=new QuickTunnel(tmp,()=>{});quick.install=async()=>{installs++;return 'fixture-helper';};
  const first=quick.start(7654),duplicate=quick.start(7654);await tick();
  assert.equal(installs,1);assert.equal(processes.length,1,'Repeated state updates start only one helper');
  processes[0].stderr.write('https://first-fixture.trycloudflare.com');await Promise.all([first,duplicate]);assert.equal(quick.url,'https://first-fixture.trycloudflare.com');
  const second=quick.start(7655);await tick();processes[1].stderr.write('https://second-fixture.trycloudflare.com');await second;
  processes[0].emit('exit',1);assert.equal(quick.url,'https://second-fixture.trycloudflare.com','A retired process cannot fail its replacement');quick.stop();assert.equal(quick.status.state,'off');
  cp.spawn=()=>{const p=child();process.nextTick(()=>p.emit('error',new Error('fixture spawn failed')));return p;};
  const failed=new QuickTunnel(tmp,()=>{});failed.install=async()=> 'fixture-helper';await failed.start(7654);assert.match(failed.status.error,/fixture spawn failed/);
  const sshFailed=new SshTunnel(()=>{});sshFailed.helper=()=>({installed:true,path:'fixture-ssh'});await sshFailed.start(7654,'user@fixture.invalid',80);assert.match(sshFailed.status.error,/fixture spawn failed/);
  cp.spawn=()=>{const p=child();processes.push(p);return p;};
  const ssh=new SshTunnel(()=>{});ssh.helper=()=>({installed:true,path:'fixture-ssh'});
  const sshFirst=ssh.start(7654,'user@fixture.invalid:2222',80),sshDuplicate=ssh.start(7654,'user@fixture.invalid:2222',80);
  const pending=processes.at(-1);assert.equal(processes.length,3);ssh.stop();pending.stderr.write('https://stale.fixture.invalid');await Promise.all([sshFirst,sshDuplicate]);assert.equal(ssh.status.state,'off');
  const args=sshArgs('user@fixture.invalid:2222',8080,7654);assert.equal(args.at(-1),'user@fixture.invalid');assert.equal(args[args.indexOf('-p')+1],'2222');assert(args.includes('BatchMode=yes'));assert(args.includes('8080:127.0.0.1:7654'));
 } finally {cp.spawn=spawn;}
 const bin=path.join(tmp,'shared-bin'),bytes=Buffer.from('fixture helper contents');let downloads=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/releases/latest') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tag_name:'fixture',assets:[{name:'cloudflared-windows-amd64.exe',size:bytes.length,browser_download_url:'http://127.0.0.1:'+server.address().port+'/binary'}]}));}
  else {downloads++;res.setHeader('Content-Length',bytes.length);setTimeout(()=>res.end(bytes),150);}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={...process.env,ZER0NE_CLOUDFLARED_RELEASES:'http://127.0.0.1:'+server.address().port+'/releases/latest'};
 function installer() {return new Promise((resolve,reject)=>{const p=cp.fork(__filename,['installer',bin],{env,stdio:['ignore','ignore','inherit','ipc'],windowsHide:true});let result;p.on('message',message=>result=message);p.once('exit',code=>code===0?resolve(result):reject(new Error(result?.error||'Installer exited '+code)));});}
 try {
  const results=await Promise.all([installer(),installer()]);assert.equal(downloads,1,'Two project hosts share one helper download');assert.equal(results[0].file,results[1].file);assert.equal(fs.readFileSync(results[0].file,'utf8'),bytes.toString());assert(!fs.existsSync(path.join(bin,'.cloudflared-install.json')));
  fs.writeFileSync(path.join(bin,'.cloudflared-install.json'),JSON.stringify({pid:9999999,nonce:'crashed'}));await installer();assert(!fs.existsSync(path.join(bin,'.cloudflared-install.json')),'A crashed installer cannot block later projects');
 } finally {await new Promise(resolve=>server.close(resolve));cp.spawnSync=spawnSync;shim.dispose();}
}
