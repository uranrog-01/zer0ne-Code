'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
module.exports = async function computerUseSmoke(page, shots, until, executable, storage) {
	await page.eval(`window.__cuMessages=[];window.__cuListener=e=>{if(e.data?.type?.startsWith('computerUse'))window.__cuMessages.push(e.data)};window.addEventListener('message',window.__cuListener);window.__zcComputerUse.open()`);
	try {
		await until('Computer Use app list',()=>page.eval(`window.__cuMessages.some(m=>m.type==='computerUseApps')`));
		assert.equal(await page.eval(`document.querySelectorAll('.cu-dialog').length`),1);
		assert(await page.eval(`document.querySelector('[data-cu-enable]').checked===false`));
		await page.eval(`document.querySelector('[data-cu-enable]').click()`);
		await until('Computer Use enabled',()=>page.eval(`document.querySelector('[data-cu-enable]').checked`));
		const windows=await page.eval(`window.__cuMessages.findLast(m=>m.type==='computerUseApps').apps`);
		const own=windows.find(w=>w.path.toLowerCase()===executable.toLowerCase()); assert(own,'test app appears in the native running-app picker');
		await page.eval(`document.querySelector('[data-cu-allow="${own.windowId}"]').click()`);
		await until('app permission saved',()=>page.eval(`!!document.querySelector('[data-cu-revoke]')&&!document.querySelector('[data-cu-resume]').disabled`));
		assert.equal(await page.eval(`document.querySelector('[data-cu-status]').textContent`),'Paused');
		await page.eval(`document.querySelector('[data-cu-resume]').click()`);
		await until('Computer Use ready',()=>page.eval(`document.querySelector('[data-cu-status]').textContent==='Ready'`));
		// Another desktop app can own the shortcut; the UI must reflect the shell's actual registration.
		await until('global Stop shortcut status matches the shell',async()=>{
			const shortcut=JSON.parse(fs.readFileSync(path.join(storage,'computer-use','shortcut.json'),'utf8'));
			assert.equal(typeof shortcut.registered,'boolean');
			process.kill(shortcut.pid,0);
			return page.eval(`document.querySelector('[data-cu-shortcut]').textContent === ${JSON.stringify(shortcut.registered ? 'Stop from any app: Ctrl + Alt + Esc' : 'Stop pauses Computer Use across all projects.')}`);
		});
		await page.screenshot(path.join(shots,'computer-use-permissions.png'));
		await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
		assert(await page.eval(`(()=>{const d=document.querySelector('.cu-dialog'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&d.scrollWidth<=d.clientWidth+1})()`),'permissions fit a narrow window');
		await page.screenshot(path.join(shots,'computer-use-narrow.png'));
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.eval(`window.__cuTheme=document.body.dataset.theme;window.applyAppearance({theme:'light'})`);
		await page.screenshot(path.join(shots,'computer-use-light.png'));
		await page.eval(`window.applyAppearance({theme:window.__cuTheme});document.querySelector('[data-cu-close]').click();document.querySelector('.cu-stop').click()`);
		await until('Stop pauses across projects',()=>page.eval(`document.querySelector('.cu-status-open').textContent.includes('Paused')`));
		await page.eval(`window.__zcComputerUse.open()`);
		await until('permissions loaded again',()=>page.eval(`!document.querySelector('[data-cu-revoke]').disabled`));
		await page.eval(`document.querySelector('[data-cu-revoke]').click()`);
		await until('app permission removed',()=>page.eval(`!document.querySelector('[data-cu-revoke]')&&document.querySelector('[data-cu-resume]').disabled`));
		await page.eval(`document.querySelector('[data-cu-enable]').click();document.querySelector('[data-cu-close]').click()`);
		await until('Computer Use disabled',()=>page.eval(`document.querySelector('.cu-status').hidden`));
		console.log('Computer Use UI passed: native app discovery, allow/resume/Stop/revoke, actual shortcut availability, dark/light and narrow layouts.');
	} finally {
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.eval(`document.querySelector('.cu-dialog [data-cu-close]')?.click();window.removeEventListener('message',window.__cuListener);window.Bridge.post({type:'updateSettings',patch:{computerUse:false}})`);
	}
};
