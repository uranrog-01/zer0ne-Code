'use strict';
const assert = require('node:assert/strict'), path = require('node:path');

module.exports = async function terminalThemeSmoke(page, shots, until) {
	await page.eval(`window.__terminalBaseline=null;window.__terminalListener=e=>{if(e.data?.type==='state'&&!e.data.__terminalFixture)window.__terminalBaseline=e.data};window.addEventListener('message',window.__terminalListener);window.Bridge.post({type:'setMode',mode:'agent'})`);
	await until('Terminal baseline', () => page.eval(`!!window.__terminalBaseline?.currentSessionId`));
	await page.eval(`window.__terminalPost=window.Bridge.post;window.__terminalCalls=[];window.Bridge.post=m=>window.__terminalCalls.push(m);window.__terminalDispatch=window.dispatchEvent;window.dispatchEvent=function(e){if(e.type==='message'&&e.data?.type==='state'&&!e.data.__terminalFixture)return true;return window.__terminalDispatch.call(this,e)}`);
	const settings = { theme:'terminal', glass:false, glow:'off', groupTerminal:false, groupChanges:false, terminalFontSize:0, terminalLineHeight:1.3, terminalCursorStyle:'block', terminalCursorBlink:true, terminalScreenReader:false, terminalEffects:'off', terminalProse:'mono' };
	const fixture = { type:'state', __terminalFixture:true, currentSessionId:'terminal-theme-smoke', providers:[], selection:{}, settings, messages:[
		{ id:'terminal-u', role:'user', content:'Review the build.' },
		{ id:'terminal-read', role:'assistant', kind:'tool', content:'', tool:{name:'read_file',status:'done',arg:'src/main.ts',summary:'Read 214 lines'} },
		{ id:'terminal-rejected', role:'assistant', kind:'tool', content:'', approval:{id:'rejected',kind:'command',status:'rejected',command:'npm run deploy'} },
		{ id:'terminal-failed', role:'assistant', kind:'tool', content:'', approval:{id:'failed',kind:'command',status:'applied',execution:'done',failed:true,command:'npm test',result:'exit code 1'} },
		{ id:'terminal-a', role:'assistant', content:'## Build results\n\n**One test failed.** Review `src/main.ts`.\n\n```javascript\nconst passed = 41;\n```' }
	] };
	const send = patch => page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify({...fixture,...patch}) + '}))');
	try {
		await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
		await page.send('Emulation.setEmulatedMedia',{features:[]});
		await send({});
		await until('Terminal tools rendered', () => page.eval(`document.body.dataset.theme==='terminal'&&!!document.querySelector('.tool-status.rejected')`));
		const summary = await page.eval(`getComputedStyle(document.querySelector('.tool-sum')).color`);
		const rgb = summary.match(/[\d.]+/g).map(Number), background = [26,25,24];
		const luminance = channels => channels.map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126,.7152,.0722][i], 0);
		const alpha = rgb[3] ?? 1, composed = rgb.slice(0,3).map((v,i) => v * alpha + background[i] * (1-alpha));
		assert((luminance(composed)+.05)/(luminance(background)+.05)>=4.5, 'tool summary meets normal text contrast');
		assert(await page.eval(`getComputedStyle(document.querySelector('.tool-head'),'::before').content==='none' && document.querySelector('.tool-status.error').textContent==='Failed'`));
		await page.screenshot(path.join(shots,'terminal-theme-chat.png'));
		await page.eval(`window.Settings.open('appearance');document.querySelector('[data-theme-tab="classic"]').click()`);
		assert(await page.eval(`document.querySelector('[data-theme-tab="classic"]').getAttribute('aria-selected')==='true'`), 'Classic shelf can be browsed while Terminal stays active');
		await page.eval(`document.querySelector('[data-theme-tab="terminal"]').click();document.getElementById('s-terminalFontSize').value='18';document.getElementById('s-terminalFontSize').dispatchEvent(new Event('change',{bubbles:true}))`);
		assert(await page.eval(`window.__terminalCalls.some(m=>m.type==='updateSettings'&&m.patch.terminalFontSize===18)`), 'numeric terminal setting is sent as a number');
		await page.screenshot(path.join(shots,'terminal-theme-settings.png'));
		await page.eval(`window.Settings.close()`);
		await page.eval(`window.__terminalWasGlass=document.body.classList.contains('zg-on');document.body.classList.add('zg-on');document.getElementById('input').blur()`);
		await send({settings:{...settings,themeBackground:'#ffffff',themeForeground:'#222222'}});
		try { await until('custom light palette reaches headings and composer', () => page.eval(`getComputedStyle(document.getElementById('input')).color==='rgb(34, 34, 34)'&&getComputedStyle(document.querySelector('.input-card')).backgroundColor==='rgb(251, 251, 251)'&&getComputedStyle(document.querySelector('.md h2')).color==='rgb(34, 34, 34)'`)); }
		catch (error) { throw new Error(error.message + ': ' + JSON.stringify(await page.eval(`({input:getComputedStyle(document.getElementById('input')).color,composer:getComputedStyle(document.querySelector('.input-card')).backgroundColor,heading:getComputedStyle(document.querySelector('.md h2')).color,classes:document.body.className})`))); }
		await page.screenshot(path.join(shots,'terminal-theme-custom-light.png'));
		await send({settings:{...settings,themeBackground:'#ffffff',themeForeground:'#eeeeee'}});
		await page.eval(`window.Settings.open('appearance')`);
		assert(await page.eval(`!!document.querySelector('[data-readable-fg]')`), 'low contrast exposes an explicit readable-text adjustment');
		await page.eval(`document.querySelector('[data-readable-fg]').click()`);
		assert(await page.eval(`window.__terminalCalls.some(m=>m.patch?.themeForeground==='#000000')`));
		await page.eval(`window.Settings.close()`);
		await send({messages:[]});
		assert(await page.eval(`!document.body.classList.contains('filament-on')&&document.getElementById('filament-canvas').hidden&&getComputedStyle(document.getElementById('filament-canvas')).display==='none'`), 'Terminal never activates the ambient effect');
		await page.screenshot(path.join(shots,'terminal-theme-welcome.png'));
		await send({settings:{...settings,terminalFontSize:18}});
		await page.eval(`if(document.getElementById('auxiliary').classList.contains('hidden'))document.getElementById('btn-auxiliary').click();document.getElementById('aux-tab-terminal').click();document.getElementById('workbench-tab-shells').click()`);
		await page.eval(`new Promise((resolve,reject)=>{if(window.Terminal)return resolve();const s=document.createElement('script');s.src='/media/terminal/xterm.min.js';s.onload=resolve;s.onerror=reject;document.head.appendChild(s)}).then(()=>{window.__terminalConstructor=window.Terminal;window.Terminal=new Proxy(window.Terminal,{construct(target,args){window.__terminalInstance=new target(...args);return window.__terminalInstance}});window.dispatchEvent(new MessageEvent('message',{data:{type:'ptySessions',sessions:[{id:'theme-fixture',name:'Palette preview',sequence:1,closed:true,output:'\\x1b[31mError\\x1b[0m  \\x1b[32mSuccess\\x1b[0m  \\x1b[34mLink\\x1b[0m\\r\\nTerminal palette preview'}]}}))})`);
		await until('Terminal renderer ready', () => page.eval(`!!window.__terminalInstance?.element`));
		assert.equal(await page.eval(`window.__terminalInstance.options.fontSize`),18);
		assert(await page.eval(`!!window.__terminalInstance.options.theme.brightRed&&!!window.__terminalInstance.options.theme.selectionInactiveBackground`));
		await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
		await until('open shell honors reduced motion', () => page.eval(`!window.__terminalInstance.options.cursorBlink&&window.__terminalInstance.options.smoothScrollDuration===0`));
		assert.equal(await page.eval(`getComputedStyle(document.querySelector('.msg.assistant')).animationName`),'none');
		await send({settings:{...settings,terminalFontSize:20,terminalLineHeight:1.5,terminalCursorStyle:'bar',terminalScreenReader:true}});
		await until('shell settings update in place', () => page.eval(`window.__terminalInstance.options.fontSize===20&&window.__terminalInstance.options.screenReaderMode&&window.__terminalInstance.options.cursorStyle==='bar'`));
		assert.equal(await page.eval(`window.__terminalInstance.options.lineHeight`),1.5);
		assert(await page.eval(`!!document.querySelector('.xterm-accessibility')`), 'accessible terminal output is mounted');
		await page.screenshot(path.join(shots,'terminal-theme-shell.png'));
		await send({settings:{...settings,terminalFontSize:0,themeBackground:'#ffffff',themeForeground:'#222222'}});
		await page.eval(`document.body.style.setProperty('--code-font-size','19px')`);
		await until('shell follows code font live', () => page.eval(`window.__terminalInstance.options.fontSize===19&&window.__terminalInstance.options.theme.red==='#a33530'`));
		await send({settings:{...settings,terminalProse:'reading',terminalEffects:'retro',density:'compact'}});
		assert(await page.eval(`getComputedStyle(document.querySelector('.conversation'),'::after').content==='""'&&getComputedStyle(document.querySelector('.msg.assistant .session-text')).fontFamily.includes('Segoe')`));
		await page.send('Emulation.setDeviceMetricsOverride',{width:820,height:900,deviceScaleFactor:1,mobile:false});
		await page.eval(`if(!document.getElementById('sidebar').classList.contains('hidden'))document.getElementById('btn-sidebar').click();if(!document.getElementById('auxiliary').classList.contains('hidden'))document.getElementById('btn-auxiliary').click()`);
		await page.screenshot(path.join(shots,'terminal-theme-narrow.png'));
	} finally {
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.send('Emulation.setEmulatedMedia',{features:[]});
		await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:{type:'ptySessions',sessions:[]}}));if(window.__terminalConstructor)window.Terminal=window.__terminalConstructor;window.dispatchEvent=window.__terminalDispatch;window.Bridge.post=window.__terminalPost;window.removeEventListener('message',window.__terminalListener);if(window.__terminalBaseline)window.dispatchEvent(new MessageEvent('message',{data:window.__terminalBaseline}));window.Settings.close()`);
		await page.eval(`if(!window.__terminalWasGlass)document.body.classList.remove('zg-on')`);
	}
};
