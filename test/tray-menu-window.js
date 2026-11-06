'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

async function windowTest() {
	const electron = require('electron'), { app, ipcMain } = electron;
	app.setPath('userData', process.env.ZER0NE_DATA_DIR);
	const { TrayMenu } = require('../app/tray-menu'), { allowed, validated } = require('../app/permissions');
	let tray, lastKey, quitting = false, failed = false; const actions = [];
	const record = key => { assert(!tray.visible(), 'hide before running ' + key); actions.push(key); };
	const shell = { showWindows:() => record('zc:show'), openWindow:() => record('zc:new-window'), openProjectDialog:() => record('zc:open-project'), quick:{ show:() => record('zc:quick') }, notch:{ summon:() => record('zc:notch') } };
	electron.shell.openPath = async () => { record('zc:logs'); return ''; };
	ipcMain.on('zc:boot', event => { event.returnValue = { page:'tray' }; });
	ipcMain.handle('zc:invoke', (event, cmd, args = {}) => {
		assert(tray.owns(event), 'only the menu main frame may invoke its commands');
		assert(allowed('tray', cmd)); const clean = validated(cmd, args); assert(clean);
		if (cmd === 'tray_data') return { version:'test', theme:'dark', side:'above', running:0, quickKeys:'Ctrl+Alt+Space', notchKeys:'Ctrl+Alt+Z' };
		assert.equal(cmd, 'tray_action'); lastKey = clean.key; tray.run(clean.key); return null;
	});
	const fail = error => { failed = true; console.error(error.stack || error); tray?.win?.destroy(); app.exit(1); };
	app.on('before-quit', () => {
		if (failed) return;
		try { assert(quitting); assert.equal(lastKey, 'zc:quit'); assert(!tray.visible()); console.log('Native tray window: every button, icon click, Enter, Space and real Quit passed through the preload bridge.'); }
		catch (error) { console.error(error); app.exit(1); }
	});
	await app.whenReady(); tray = new TrayMenu(shell);
	const until = async fn => { const end = Date.now() + 10000; while (!await fn()) { if (Date.now() > end) throw Error('Tray action timed out: ' + lastKey); await new Promise(resolve => setTimeout(resolve, 20)); } };
	const show = async () => { tray.show(); await until(() => tray.win.webContents.executeJavaScript(`document.getElementById('version')?.textContent==='vtest'`)); };
	const click = async key => {
		const point = await tray.win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-key="${key}"] .row-ic').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
		tray.win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...point });
		tray.win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, ...point });
	};
	try {
		for (const key of ['zc:show','zc:new-window','zc:open-project','zc:quick','zc:notch','zc:logs']) {
			await show(); const before = actions.length; await click(key); await until(() => actions.length === before + 1); assert.equal(actions.at(-1), key);
		}
		for (const [key, code] of [['zc:show','Enter'],['zc:quick','Space']]) {
			await show(); await tray.win.webContents.executeJavaScript(`document.querySelector('[data-key="${key}"]').focus()`); const before = actions.length;
			tray.win.webContents.sendInputEvent({ type:'keyDown', keyCode:code });
			tray.win.webContents.sendInputEvent({ type:'char', keyCode:code === 'Enter' ? '\r' : ' ' });
			tray.win.webContents.sendInputEvent({ type:'keyUp', keyCode:code });
			await until(() => actions.length === before + 1); assert.equal(actions.at(-1), key);
		}
		await show(); quitting = true; await click('zc:quit'); setTimeout(() => fail(Error('Quit did not exit the tray app')), 3000);
	} catch (error) { fail(error); }
}

if (process.versions.electron) windowTest().catch(error => { console.error(error); require('electron').app.exit(1); });
else {
	const release = require('./gui-lock').acquire();
	const parent = fs.realpathSync(os.tmpdir()), base = fs.mkdtempSync(path.join(parent, 'z0-tray-window-'));
	const cleanup = () => {
		const target = fs.realpathSync(base);
		if (path.dirname(target) !== parent || !path.basename(target).startsWith('z0-tray-window-')) throw Error('Unexpected tray test directory');
		fs.rmSync(target, { recursive:true, force:true, maxRetries:30, retryDelay:100 });
	};
	try {
		const env = { ...require('./test-env').testEnv(), ZER0NE_DATA_DIR:base }; delete env.ELECTRON_RUN_AS_NODE;
		const result = spawnSync(require('electron'), [__filename], { env, stdio:'inherit', windowsHide:true, timeout:45000 });
		if (result.error) throw result.error; assert.equal(result.signal, null, 'tray test exited normally'); process.exitCode = result.status ?? 1;
	} finally {
		try { cleanup(); } finally { release(); }
	}
}
