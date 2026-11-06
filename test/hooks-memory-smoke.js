'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
module.exports = async function hooksMemorySmoke(page, shots, until) {
	await page.eval(`window.__hmBaseline=null;window.__hmListener=e=>{if(e.data?.type==='state'&&!e.data.__hmFixture)window.__hmBaseline=e.data};window.addEventListener('message',window.__hmListener);window.Bridge.post({type:'setMode',mode:'agent'})`);
	await until('Hooks & Memory baseline',()=>page.eval(`!!window.__hmBaseline`));
	await page.eval(`window.__hmPost=window.Bridge.post;window.__hmCalls=[];window.Bridge.post=m=>window.__hmCalls.push(m);window.__hmDispatch=window.dispatchEvent;window.dispatchEvent=function(e){if(e.type==='message'&&e.data?.type==='state'&&!e.data.__hmFixture)return true;return window.__hmDispatch.call(this,e)}`);
	const base = await page.eval(`window.__hmBaseline`);
	const fixture = {...base,__hmFixture:true,settings:{...base.settings,uiMode:'simple'},hooks:[{id:'merged-fixture',event:'PostToolUse',command:'Write-Output fixture',timeoutSec:60,enabled:true}],memories:[]};
	const send = patch=>page.eval('window.dispatchEvent(new MessageEvent("message",{data:'+JSON.stringify({...fixture,...patch})+'}))');
	try {
		await send({}); await page.eval(`window.Settings.open('hooks')`);
		assert(await page.eval(`document.querySelectorAll('[data-nav="hooks-memory"]').length===1&&!document.querySelector('[data-nav="hooks"],[data-nav="memory"]')`));
		assert.equal(await page.eval(`document.querySelector('.page-title').textContent`),'Hooks & Memory');
		assert(await page.eval(`!!document.querySelector('[data-hook="merged-fixture"] [data-act="hook-test"]')`));
		await page.screenshot(path.join(shots,'hooks-memory-hooks.png'));
		await page.eval(`document.querySelector('[data-act="hook-add"]').click()`);
		assert(await page.eval(`!!document.getElementById('hk-command')`));
		await page.eval(`document.querySelector('[data-cancel]').click();document.getElementById('hooks-memory-tab-memory').click();document.getElementById('mem-add').value='Keep this unsaved memory draft';document.getElementById('hooks-memory-tab-hooks').click();document.getElementById('hooks-memory-tab-hooks').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`);
		assert.equal(await page.eval(`document.activeElement.id`),'hooks-memory-tab-memory');
		assert.equal(await page.eval(`document.getElementById('mem-add').value`),'Keep this unsaved memory draft');
		await page.eval(`document.querySelector('[data-act="memory-add"]').click()`);
		assert(await page.eval(`window.__hmCalls.some(m=>m.type==='saveMemory'&&m.text==='Keep this unsaved memory draft')`));
		await send({memories:[{id:'merged-memory',text:'Use concise answers',ts:1,category:'preferences'}]});
		assert(await page.eval(`document.querySelector('.memory-page').textContent.includes('Use concise answers')`));
		await page.screenshot(path.join(shots,'hooks-memory-memory.png'));
		await page.eval(`window.Settings.open('hooks');const q=document.querySelector('.settings-search input');q.value='Include sensitive topics';q.dispatchEvent(new Event('input'));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
		assert.equal(await page.eval(`document.activeElement.dataset.setting`),'memorySensitive');
		await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
		await page.eval(`document.body.classList.add('remote');document.querySelector('.settings-search input').value='';document.querySelector('.settings-search input').dispatchEvent(new Event('input'))`);
		assert(await page.eval(`(()=>{const p=document.querySelector('.hooks-memory-page');return p.scrollWidth<=p.clientWidth+1&&[...p.querySelectorAll('[role="tab"]')].every(b=>b.getBoundingClientRect().right<=innerWidth)})()`),'merged controls fit a narrow viewport');
		await page.screenshot(path.join(shots,'hooks-memory-narrow.png'));
	} finally {
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.eval(`document.body.classList.remove('remote');window.dispatchEvent=window.__hmDispatch;window.Bridge.post=window.__hmPost;window.removeEventListener('message',window.__hmListener);window.Settings.close();if(window.__hmBaseline)window.dispatchEvent(new MessageEvent('message',{data:window.__hmBaseline}))`);
	}
};
