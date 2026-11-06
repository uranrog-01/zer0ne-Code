'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') process.exit(0);
require('./gui-lock').acquire();
const root = path.resolve(__dirname, '..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-overlay-native-'));
const source = process.env.ZER0NE_APP_EXE ? path.join(path.dirname(process.env.ZER0NE_APP_EXE), 'resources/app.asar.unpacked/app/computer-overlay.cs') : path.join(root, 'app/computer-overlay.cs');
try {
	const compiler = ['Framework64', 'Framework'].map(f => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319/csc.exe')).find(p => fs.existsSync(p));
	const exe = path.join(dir, 'overlay-fixture.exe');
	const built = spawnSync(compiler, ['/nologo', '/main:OverlayFixture', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/out:${exe}`, source, path.join(__dirname, 'computer-overlay-native.cs')], {encoding:'utf8',windowsHide:true,timeout:60000});
	assert.equal(built.status,0,built.stdout+built.stderr);
	const input = path.join(dir,'input.exe');
	const inputBuilt=spawnSync(compiler,['/nologo','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',`/out:${input}`,path.join(path.dirname(source),'../engine/media/sandbox/input.cs')],{encoding:'utf8',windowsHide:true,timeout:60000});
	assert.equal(inputBuilt.status,0,inputBuilt.stdout+inputBuilt.stderr);
	const monitor=path.join(dir,'overlay.exe');
	const monitorBuilt=spawnSync(compiler,['/nologo','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Web.Extensions.dll',`/out:${monitor}`,source],{encoding:'utf8',windowsHide:true,timeout:60000});
	assert.equal(monitorBuilt.status,0,monitorBuilt.stdout+monitorBuilt.stderr);
	assert.equal(spawnSync('icacls',[exe,'/setintegritylevel','M'],{windowsHide:true}).status,0);
	assert.equal(spawnSync('icacls',[input,'/setintegritylevel','M'],{windowsHide:true}).status,0);
	assert.equal(spawnSync('icacls',[monitor,'/setintegritylevel','M'],{windowsHide:true}).status,0);
	const output=path.join(root,'test/output');fs.mkdirSync(output,{recursive:true});
	const result=spawnSync(exe,[dir,output,input,monitor],{encoding:'utf8',windowsHide:true,timeout:20000});
	assert.equal(result.status,0,result.stdout+result.stderr);console.log(result.stdout.trim());
} finally {assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
