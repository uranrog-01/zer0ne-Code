'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { sharedGlobalMemento } = require('../host/storage');
const { connect } = require('./cdp');

module.exports = async (page, until, output, startupMs, projects) => {
	const budget = require('./performance-budgets.json');
	const metrics = { startupMs };
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-perf-'));
	try {
		const store = sharedGlobalMemento(path.join(temporary, 'state.json'));
		const turns = Array.from({ length:10000 }, (_, i) => ({ id:'perf-' + i, role:i % 2 ? 'assistant' : 'user', content:'A repeatable long-history fixture. '.repeat(8) + i }));
		let start = performance.now(); await store.update('aiChat.messages.perf', turns); metrics.storageWriteMs = performance.now() - start;
		assert.equal(sharedGlobalMemento(path.join(temporary, 'state.json')).get('aiChat.messages.perf').length, 10000);
		await page.send('Performance.enable');
		await page.eval(`window.__perf={state:null,sessions:[],outputs:new Map(),rejected:[]};window.__perf.listen=e=>{const m=e.data;if(m?.type==='state'){if(!m.__performance){if(!window.__perf.state)window.__perf.state=m;else e.stopImmediatePropagation();}}if(m?.type==='transportRejected')window.__perf.rejected.push(m.action?.type);if(m?.type==='ptySessions')window.__perf.sessions=m.sessions;if(m?.type==='ptyOutput')window.__perf.outputs.set(m.id,(window.__perf.outputs.get(m.id)||'')+m.text);};window.addEventListener('message',window.__perf.listen,true);window.Bridge.post({type:'setMode',mode:'agent'});0`);
		await until('benchmark source state', () => page.eval('!!window.__perf.state'));
		await page.send('HeapProfiler.collectGarbage');
		const heap = async () => (await page.send('Performance.getMetrics')).metrics.find(m => m.name === 'JSHeapUsedSize')?.value || 0;
		const beforeHeap = await heap();
		await page.eval('window.__perf.post=window.Bridge.post;window.Bridge.post=()=>{};0');
		const render = [];
		for (let sample = 0; sample < 20; sample++) render.push(await page.eval(`(async()=>{const p=window.__perf,base=p.state,messages=Array.from({length:200},(_,i)=>({id:'perf-${sample}-'+i,role:i%2?'assistant':'user',content:i%2?'## Result '+i+'\\n\\n'+('Measured content for a long conversation. '.repeat(8)):'Check step '+i}));const t=performance.now();window.dispatchEvent(new MessageEvent('message',{data:{...base,__performance:true,messages,isStreaming:false,streaming:null,historyWindow:{hasMore:true,total:10000}}}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return performance.now()-t;})()`));
		await page.eval('window.Bridge.post=window.__perf.post;0');
		metrics.rendererP95Ms = render.sort((a,b)=>a-b)[Math.ceil(render.length * .95) - 1];
		assert(await page.eval(`document.querySelectorAll('#messages .msg').length<=250`), 'paged long histories must keep a bounded visible transcript');
		start = performance.now();
		await page.eval(`document.getElementById('btn-auxiliary').click();document.getElementById('aux-tab-terminal').click();document.getElementById('workbench-tab-shells').click();0`);
		for (let count = 1; count <= 6; count++) { await new Promise(r=>setTimeout(r,300)); await page.eval("window.Bridge.post({type:'ptyOpen'});0"); await until('benchmark shell ' + count, () => page.eval('window.__perf.sessions.length>=' + count), 30000); console.log('benchmark shell ready: ' + count); }
		metrics.ptyReadyMs = performance.now() - start;
		await page.eval(`for(const s of window.__perf.sessions)window.Bridge.post({type:'ptyInput',id:s.id,text:'echo PERF_RESULT_%COMSPEC%\\r'});0`);
		await until('all benchmark shells answer', () => page.eval(`window.__perf.sessions.every(s=>window.__perf.outputs.get(s.id)?.includes('PERF_RESULT_C:'))`));
		const burstInput = 'for /L %i in (1,1,400) do @echo performance-output-for-terminal-benchmark\r' + 'echo PERF_BURST_DONE_%COMSPEC%\r';
		start = performance.now();
		await page.eval("for(const s of window.__perf.sessions)window.Bridge.post({type:'ptyInput',id:s.id,text:" + JSON.stringify(burstInput) + '});0');
		await until('real terminal output burst', () => page.eval("window.__perf.sessions.every(s=>window.__perf.outputs.get(s.id)?.includes('PERF_BURST_DONE_C:'))"));
		await page.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
		metrics.terminalBurstMs = performance.now() - start;
		metrics.heapGrowthMb = Math.max(0, (await heap() - beforeHeap) / 1024 / 1024);
		if (projects) {
			const originalPort = new URL(page.url).port;
			start = performance.now();
			await page.eval('window.Bridge.post({type:"projectOpen",path:' + JSON.stringify(projects.b) + '});0');
			const other = await connect(projects.port, url => /^http:\/\/127\.0\.0\.1:\d+\//.test(url) && new URL(url).port !== originalPort, 30000);
			try {
				await until('cold project activation', () => other.eval('document.visibilityState==="visible" && innerWidth>=560 && !!document.querySelector(".workbench")'));
				metrics.projectColdSwitchMs = performance.now() - start;
				assert(await other.eval('window.__zcShell.invoke("host_status").then(rows=>rows.length===2)'), 'background shells retain the original project engine');
				start = performance.now();
				await other.eval('window.Bridge.post({type:"projectOpen",path:' + JSON.stringify(projects.a) + '});0');
				await until('warm project activation', () => page.eval('document.visibilityState==="visible" && innerWidth>=560'));
				metrics.projectWarmSwitchMs = performance.now() - start;
			} finally { other.close(); }
		}
		const sessionIds = await page.eval('window.__perf.sessions.map(s=>s.id)');
		for (const id of sessionIds) { await new Promise(r=>setTimeout(r,300)); await page.eval("window.Bridge.post({type:'ptyClose',id:" + JSON.stringify(id) + '});window.__perf.lastClose=' + JSON.stringify(id)); await until('benchmark shell closed', () => page.eval('!window.__perf.sessions.some(s=>s.id===' + JSON.stringify(id) + ')')); }
		await until('benchmark shells closed', () => page.eval('window.__perf.sessions.length===0'));
		await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:{...window.__perf.state,__performance:true}}));window.removeEventListener('message',window.__perf.listen,true);delete window.__perf;0`);
		const failed = Object.entries(metrics).filter(([key,value]) => !Number.isFinite(value) || value > budget[key]);
		const report = { schema:1, at:new Date().toISOString(), runtime:process.env.ZER0NE_APP_EXE ? 'packaged' : 'source', platform:process.platform, arch:process.arch, cpuCount:os.cpus().length, node:process.version, scenarios:{ storedMessages:10000, renderedMessages:200, shells:6, projects:2, outputLines:2400, renderSamples:20 }, metrics, budgets:budget, status:failed.length ? 'failed' : 'passed' };
		fs.writeFileSync(path.join(output, 'performance-' + report.runtime + '.json'), JSON.stringify(report, null, 2) + '\n');
		for (const [key,value] of Object.entries(metrics)) console.log(`benchmark ${key}: ${value.toFixed(1)} / ${budget[key]}`);
		assert.equal(failed.length, 0, 'Performance budgets exceeded: ' + failed.map(([name])=>name).join(', '));
		console.log('Performance budgets passed: long-history storage and rendering, six real shells, output burst and JS heap.');
	} catch (error) { console.error('Benchmark diagnostics:', await page.eval("({sessions:window.__perf?.sessions?.map(s=>({id:s.id,closed:s.closed,closing:s.closing,tail:s.closed?s.output.slice(-600):''})),lastClose:window.__perf?.lastClose,rejected:window.__perf?.rejected,delivery:document.querySelector('.command-state')?.textContent,toast:document.querySelector('.toast')?.textContent})").catch(()=>null)); throw error; } finally { if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('zer0ne-perf-')) fs.rmSync(temporary, { recursive:true, force:true }); }
};
