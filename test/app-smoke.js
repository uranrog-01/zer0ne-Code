// End-to-end: the real app on a temporary data folder with two projects. Checks the desktop
// layer and bridge in the engine page, command permissions, a project switch (the idle engine
// retires), Liquid Glass settings, and that killing the app leaves no process behind.
//   ZER0NE_APP_EXE=<built exe>  test the packaged app instead of this checkout.
//   ZER0NE_SMOKE_ONLY=oauth   run the OAuth dialog checks on the real app alone.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { performance } = require('perf_hooks');
const { spawn, execFileSync } = require('child_process');
const { connect, targets } = require('./cdp');

const root = path.join(__dirname, '..');
const shots = path.join(root, 'test', 'output');
let watchedApp, expectedExit = false;

function freePort() {
	return new Promise((resolve) => {
		const s = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30000) {
	const end = performance.now() + ms;
	for (;;) {
		if (watchedApp && !expectedExit && (watchedApp.exitCode !== null || watchedApp.signalCode !== null)) throw new Error(`App exited while waiting for ${what}: code=${watchedApp.exitCode}, signal=${watchedApp.signalCode}`);
		const v = await fn().catch(() => undefined);
		if (v) return v;
		if (performance.now() > end) throw new Error('timed out: ' + what);
		await sleep(250);
	}
}

/** Every process started from `pid` (Windows), so the test can prove none outlives the app. */
function descendants(pid) {
	if (process.platform !== 'win32') return [];
	const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' });
	const rows = out.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number));
	const found = new Set([pid]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const [p, parent] of rows) if (found.has(parent) && !found.has(p)) { found.add(p); grew = true; }
	}
	found.delete(pid);
	return [...found];
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

(async () => {
	const releaseGui = require('./gui-lock').acquire();
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-app-')));
	const data = path.join(base, 'appdata');
	const a = path.join(base, 'projA');
	const b = path.join(base, 'projB');
	for (const p of [a, b]) {
		fs.mkdirSync(p, { recursive: true });
		fs.writeFileSync(path.join(p, 'readme.md'), '# ' + path.basename(p));
	}
	fs.mkdirSync(path.join(data, 'data'), { recursive: true });
	fs.writeFileSync(path.join(data, 'data', 'global-state.json'), JSON.stringify({ 'aiChat.projects': [a, b] }));
	const agentCache = path.join(data, 'data', 'global', 'acp');
	fs.mkdirSync(agentCache, { recursive:true });
	fs.writeFileSync(path.join(agentCache, 'registry.json'), JSON.stringify(require('../engine/out/acp/registrySnapshot').REGISTRY_SNAPSHOT));
	fs.mkdirSync(shots, { recursive: true });

	const port = await freePort();
	// Regression runs must not consume the user's shared Hub quota.
	const hub = http.createServer((req, res) => res.writeHead(429, { 'Retry-After': '42', RateLimit: '"api";r=0;t=42' }).end());
	hub.keepAliveTimeout = 0;
	await new Promise(resolve => hub.listen(0, '127.0.0.1', resolve));
	const sideRequests = [];
	const sideModel = http.createServer((req, res) => {
		if (req.url.endsWith('/models')) return res.writeHead(200, {'Content-Type':'application/json'}).end(JSON.stringify({data:[{id:'side-smoke'}]}));
		let body = ''; req.on('data', chunk => body += chunk);
		req.on('end', () => {
			const input = JSON.parse(body); sideRequests.push(input);
			res.writeHead(200, {'Content-Type':'text/event-stream'});
			res.write('data: ' + JSON.stringify({choices:[{delta:{content:'The service restarted, closing the socket.\n\n'}}]}) + '\n\n');
			setTimeout(() => { if (!res.destroyed) res.end('data: ' + JSON.stringify({choices:[{delta:{content:'**Check the restart log** to confirm the timing.'},finish_reason:'stop'}]}) + '\n\ndata: [DONE]\n\n'); }, 300);
		});
	});
	sideModel.keepAliveTimeout = 0;
	await new Promise(resolve => sideModel.listen(0, '127.0.0.1', resolve));
	const exe = process.env.ZER0NE_APP_EXE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
	const args = process.env.ZER0NE_APP_EXE ? [a] : [root, a];
	// Packaged builds ignore the development-only debug environment variable. The
	// test explicitly opts into Chromium debugging on its disposable app instance.
	if (process.env.ZER0NE_APP_EXE) args.push('--remote-debugging-port=' + port);
	// Test windows can be covered by the automation host; keep their renderers active.
	args.push('--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling');
	const env = { ...process.env, ZER0NE_DATA_DIR: data, ZER0NE_DEBUG_PORT: String(port), HF_ENDPOINT: `http://127.0.0.1:${hub.address().port}` };
	delete env.ELECTRON_RUN_AS_NODE;
	const variant = process.env.ZER0NE_APP_EXE ? 'packaged' : 'source';
	const logFile = path.join(shots, `app-${variant}.log`);
	const log = fs.openSync(logFile, 'w');
	const launchedAt = performance.now();
	const app = watchedApp = spawn(exe, args, { env, stdio: ['ignore', log, log] });
	let spawnError;
	app.on('error', error => { spawnError = error; });
	let failed = 0;
	let failedCheck;
	const check = async (name, fn) => {
		if (process.env.ZER0NE_SMOKE_ONLY === 'chat-branch' && !name.startsWith('answer footer,') && !name.startsWith('message right-click menu')) return;		if (process.env.ZER0NE_SMOKE_ONLY === 'repository-panels' && !name.startsWith('chat polish:')) return;
		if (process.env.ZER0NE_SMOKE_ONLY === 'reading' && !name.startsWith('chat resizing')) return;
		if (process.env.ZER0NE_SMOKE_ONLY === 'graph' && !name.startsWith('Subagents monitor')) return;
		if (process.env.ZER0NE_SMOKE_ONLY === 'workflow' && !name.startsWith('/workflow') && !name.startsWith('Workflow flow') && !name.startsWith('Workflow chip') && !name.startsWith('Find in chat')) return;
		if (process.env.ZER0NE_SMOKE_ONLY === 'stats' && !name.startsWith('Stats reveals')) return;
		try {
			if (spawnError) throw spawnError;
			if (!expectedExit && !alive(app.pid)) throw new Error(`App exited before ${name}: code=${app.exitCode}, signal=${app.signalCode}`);
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failedCheck = name;
			throw e;
		}
	};

	try {
		const engine = (u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u);
		let page = await connect(port, engine, 60000);
		// Each engine serves its page on its own port (the URL's ?t= token is stripped after load).
		const firstPort = new URL(page.url).port;
		// A window minimized by the desktop has no viewport and cannot enter full screen; the
		// renderer keeps reporting a visible, working page, so restore it through its own HWND.
		const restoreWindow = async (target = page) => {
			if (!await target.eval(`screenX <= -20000 || screenY <= -20000`)) return;
			// SC_RESTORE is the native taskbar command, sent only to this disposable app's HWND.
			execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures/taskbar-restore.ps1'), '-TargetProcess', String(app.pid)], { windowsHide: true, timeout: 15000 });
			await until('window restored', () => target.eval(`screenX > -20000 && screenY > -20000`));
		};
		await until('page ready', () => page.eval("document.getElementById('session-title') && window.__zcDesktop === true && !!document.querySelector('.topbar .zc-win')"));
		await page.send('Emulation.setFocusEmulationEnabled', { enabled:true });
		await page.send('Page.bringToFront');
		await until('native page viewport', () => page.eval("innerWidth >= 560"));
		if (process.env.ZER0NE_SMOKE_ONLY === 'performance') {
			await require('./performance-smoke')(page, until, shots, performance.now() - launchedAt, { port, a, b });
			page.close(); return;
		}
		if (!process.env.ZER0NE_SMOKE_ONLY || process.env.ZER0NE_SMOKE_ONLY === 'scroll') {
			await check('chat follows the latest reply after send, streaming and layout changes', () => require('./chat-scroll-smoke')(page, until));
			if (process.env.ZER0NE_SMOKE_ONLY === 'scroll') { page.close(); console.log('Focused chat scrolling smoke passed.'); return; }
		}
		if (process.platform === 'win32' && (!process.env.ZER0NE_SMOKE_ONLY || process.env.ZER0NE_SMOKE_ONLY === 'workbench')) {
			await check('project actions and interactive terminal use the real desktop transport', () => require('./workbench-smoke')(page, until, shots));
			if (process.env.ZER0NE_SMOKE_ONLY === 'workbench') { page.close(); console.log('Focused workbench smoke passed.'); return; }
		}
		if (process.platform === 'win32' && !['reading', 'oauth', 'polish', 'terminal-theme', 'hooks-memory', 'streaming', 'stats', 'thinking', 'graph', 'workflow', 'chat-branch'].includes(process.env.ZER0NE_SMOKE_ONLY)) {
			await check('taskbar restore preserves the project page, draft and normal/maximized/full-screen size', async () => {
				await page.send('Emulation.setFocusEmulationEnabled', { enabled:false });
				await page.eval(`window.addEventListener('message',event=>{if(event.data?.type==='state')window.__restoreState=event.data});window.Bridge.post({type:'setMode',mode:'agent'});0`);
				await until('restore fixture chat initialized', () => page.eval(`!!window.__restoreState`));
				const initial = await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized')`);
				await page.eval(`window.__restoreInput=document.getElementById('input'); window.__restoreInput.value='Unsent restore regression draft';window.__restoreInput.dispatchEvent(new Event('input',{bubbles:true}));`);
				try {
					for (const mode of ['normal', 'normal', 'maximized', 'maximized', 'fullscreen']) {
						if (mode === 'normal' && await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized')`)) await page.eval(`window.__zcShell.invoke('plugin:window|toggle_maximize')`);
						if (mode === 'maximized' && !await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized')`)) await page.eval(`window.__zcShell.invoke('plugin:window|toggle_maximize')`);
						if (mode === 'fullscreen') {
							await page.eval(`window.Bridge.post({type:'fullscreen',on:true});0`);
							await until('restore fixture full screen', () => page.eval(`window.__zcShell.invoke('plugin:window|is_fullscreen')`));
						}
						await sleep(300);
						const before = await page.eval(`({width:innerWidth,height:innerHeight})`);
						await page.eval(`window.__zcShell.invoke('plugin:window|minimize')`);
						// Windows can accept the request before the frame is iconic, or refuse it for a
						// background process; wait for the minimized position, else minimize the window
						// through the OS (the same state the taskbar restore starts from).
						const minimized = () => page.eval(`screenX <= -20000 || screenY <= -20000`);
						if (!await until(`window minimized ${mode}`, minimized, 4000).catch(() => false)) {
							execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures/taskbar-restore.ps1'), '-TargetProcess', String(app.pid), '-Minimize'], { windowsHide: true, timeout: 15000 });
							await until(`window minimized ${mode} (OS)`, minimized, 4000);
						}
						// SC_RESTORE is the native taskbar command, sent only to this disposable app's HWND.
						execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'fixtures/taskbar-restore.ps1'), '-TargetProcess', String(app.pid)], { windowsHide: true, timeout: 15000 });
						await until(`taskbar restored ${mode}`, () => page.eval(`document.visibilityState==='visible' && screenX > -20000 && screenY > -20000 && Math.abs(innerWidth-${before.width})<=2 && Math.abs(innerHeight-${before.height})<=2`));
						assert.ok(await page.eval(`document.getElementById('input')===window.__restoreInput && window.__restoreInput.value==='Unsent restore regression draft'`), 'restoring must retain the page and unsent draft');
						if (mode === 'fullscreen') assert.equal(await page.eval(`window.__zcShell.invoke('plugin:window|is_fullscreen')`), true);
					}
				} finally {
					await page.eval(`window.Bridge.post({type:'fullscreen',on:false});document.getElementById('input').value='';0`);
					await until('restore fixture leaves full screen', () => page.eval(`window.__zcShell.invoke('plugin:window|is_fullscreen').then(on=>!on)`));
					if (await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized')`) !== initial) await page.eval(`window.__zcShell.invoke('plugin:window|toggle_maximize')`);
					await page.send('Emulation.setFocusEmulationEnabled', { enabled:true });
				}
			});
			if (process.env.ZER0NE_SMOKE_ONLY === 'restore') { page.close(); console.log('Focused taskbar restore smoke passed.'); return; }
		}
		if (['reading', 'stats', 'chat-branch'].includes(process.env.ZER0NE_SMOKE_ONLY)) {
			await page.eval(`window.addEventListener('message',e=>{if(e.data?.type==='state')window.__zcSmokeState=e.data});void window.Bridge.post({type:'setMode',mode:'agent'})`);
			await until('reading fixture baseline', () => page.eval(`!!window.__zcSmokeState`));
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'oauth') {
			await require('./oauth-recovery-smoke')(page, shots, until);
			page.close(); expectedExit = true; app.kill();
			await until('focused OAuth app exits', async () => !alive(app.pid), 15000);
			console.log('Focused OAuth UI smoke passed.');
			return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'polish') {
			await require('./ui-polish-smoke')(page, shots, until);
			page.close();
			console.log('Focused composer, document and UI smoke passed.');
			return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'terminal-theme') {
			await require('./terminal-theme-smoke')(page, shots, until);
			page.close();
			console.log('Focused Terminal appearance and accessibility smoke passed.');
			return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'hooks-memory') {
			await require('./hooks-memory-smoke')(page, shots, until);
			page.close();
			console.log('Focused Hooks & Memory settings smoke passed.');
			return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'computer') {
			await require('./computer-use-smoke')(page,shots,until,exe); page.close(); return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'streaming') {
			await require('./streaming-message-smoke')(page, shots, until);
			page.close();
			console.log('Focused streaming message design smoke passed.');
			return;
		}
		if (process.env.ZER0NE_SMOKE_ONLY === 'thinking') {
			await require('./thinking-ui-smoke')(page, shots, until);
			page.close();
			return;
		}

		await check('engine page: desktop layer, bridge boot values, frame controls and drag region', async () => {
			const r = await page.eval(`({ glass: window.__zcGlass, boot: window.__zcShell.boot, act: window.__zcActivationId, region: getComputedStyle(document.querySelector('.topbar')).getPropertyValue('-webkit-app-region'), button: getComputedStyle(document.querySelector('.topbar .zc-win button')).getPropertyValue('-webkit-app-region') })`);
			assert.strictEqual(r.glass, true);
			assert.strictEqual(r.boot.page, 'engine');
			assert.strictEqual(typeof r.act, 'string');
			assert.strictEqual(r.region, 'drag');
			assert.strictEqual(r.button, 'no-drag');
			assert.strictEqual(r.boot.support.os, process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform);
			await page.screenshot(path.join(shots, 'engine-page.png'));
		});

		await check('the start page renderer is released while a project page is up', async () => {
			const pages = (await targets(port)).filter((t) => t.type === 'page').map((t) => t.url);
			assert.ok(!pages.some((url) => /\/ui\/index\.html($|[?#])/.test(url)), 'the hidden start page is gone: ' + pages.join(', '));
			assert.ok(pages.some((url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url)), 'the project page is still there: ' + pages.join(', '));
		});

		await check('New Project opens a modal with safe defaults and restores focus on Escape', async () => {
			await page.eval(`document.querySelector('.zc-side-new').focus(); document.querySelector('.zc-side-new').click()`);
			assert.equal(await page.eval(`document.querySelector('.zc-project-dialog').matches(':modal')`), true);
			assert.equal(await page.eval(`document.activeElement.id`), 'zc-project-name');
			assert.equal(await page.eval(`document.querySelector('.zc-project-dialog [type="submit"]').disabled`), true);
			assert.equal(await page.eval(`document.querySelector('.zc-project-device').textContent`), 'This computer');
			await page.screenshot(path.join(shots, 'create-project.png'));
			await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
			await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
			await until('create dialog dismissed', () => page.eval(`!document.querySelector('.zc-project-dialog')`));
			assert.equal(await page.eval(`document.activeElement.classList.contains('zc-side-new')`), true);
			assert.equal(await page.eval(`window.__zcShell.invoke('create_project',{selection:'invented',trusted:true,name:'test'}).then(()=>false,()=>true)`), true, 'an unpicked path cannot create a project');
		});

		await check('title-bar double-click toggles maximize and leaves controls alone', async () => {
			const original = await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized',{})`);
			await page.eval(`document.querySelector('.topbar').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`);
			await until('title-bar maximize toggle', () => page.eval(`window.__zcShell.invoke('plugin:window|is_maximized',{}).then(value=>value!==${original})`));
			await page.eval(`document.querySelector('.topbar').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`);
			await until('title-bar restore', () => page.eval(`window.__zcShell.invoke('plugin:window|is_maximized',{}).then(value=>value===${original})`));
			await page.eval(`document.querySelector('.zc-max svg').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,button:0}))`);
			await sleep(150);
			assert.equal(await page.eval(`window.__zcShell.invoke('plugin:window|is_maximized',{})`), original, 'a control is excluded from caption gestures');
			assert.ok(await page.eval(`!document.querySelector('.zc-project-subtitle') && Array.from(document.querySelectorAll('#sidebar .project-badge')).every(node=>getComputedStyle(node).display==='none')`), 'project counts and the current-project dot are absent');
		});

		await check('engine page commands answer; start-page-only commands are refused', async () => {
			const r = await page.eval(`(async () => { const s = window.__zcShell; const out = {}; for (const c of ['host_status', 'notify_feed', 'plugin:window|is_maximized', 'restart_engine', 'choose_folder', 'open_logs', 'no_such']) { try { out[c] = await s.invoke(c, {}); } catch (e) { out[c] = 'refused'; } } return out; })()`);
			assert.strictEqual(r.host_status.length, 1);
			assert.strictEqual(r.host_status[0].path.toLowerCase(), a.toLowerCase());
			assert.deepStrictEqual(r.notify_feed, []);
			assert.strictEqual(typeof r['plugin:window|is_maximized'], 'boolean');
			for (const c of ['restart_engine', 'choose_folder', 'open_logs', 'no_such']) assert.strictEqual(r[c], 'refused', c);
		});

		await check('turning the AI Dock off frees its renderer and turning it on restores it', async () => {
			await page.eval("document.querySelector('.zc-side-foot .zc-notch').click()");
			await until('AI Dock settings open', () => page.eval("!!document.getElementById('s-notch')"));
			const notchTarget = async () => (await targets(port)).some((t) => t.type === 'page' && /\/ui\/notch\.html/.test(t.url));
			assert.deepStrictEqual(await page.eval("document.getElementById('s-notch').checked"), true, 'the fixture starts with the AI Dock on');
			await page.eval("document.getElementById('s-notch').click()");
			await until('AI Dock window released', async () => !(await notchTarget()), 15000);
			await page.eval("document.getElementById('s-notch').click()");
			await until('AI Dock switch on', () => page.eval("document.getElementById('s-notch').checked === true"), 15000);
			// With zer0ne in front the notch rests away; Preview forces a real window.
			await page.eval("document.querySelector('[data-act=\"notch-preview\"]').click()");
			await until('AI Dock window restored', async () => await notchTarget(), 15000).catch(async (error) => {
				console.log('AI Dock diagnostics:', JSON.stringify({ checked: await page.eval("document.getElementById('s-notch')?.checked"), targets: (await targets(port)).map((t) => t.url) }));
				throw error;
			});
			await page.eval("document.querySelector('[data-act=\"close-settings\"]').click()");
		});

		await check('more menu integrates Help and invokes show_help, and the sidebar foot opens Notch settings', async () => {
			assert.strictEqual(await page.eval("getComputedStyle(document.getElementById('btn-side-chat')).display"), 'none', 'Side Chat button is hidden from the topbar');
			assert.strictEqual(await page.eval("!document.querySelector('.zc-help')"), true, 'Help button is removed from window controls');
			assert.equal(await page.eval("!!document.querySelector('.zc-side-foot .zc-side-chat')"), false, 'Side Chat is replaced in the sidebar footer');
			assert.equal(await page.eval("document.querySelector('.zc-side-foot .zc-notch')?.getAttribute('aria-label')"), 'AI Dock');
			await page.eval("document.querySelector('.zc-side-foot .zc-notch').click()");
			await until('Notch settings open', () => page.eval("!!document.querySelector('#settings-root .notch-card')"));
			await page.eval("document.querySelector('[data-act=\"close-settings\"]').click()");
			await page.eval("document.getElementById('btn-more').click()");
			const menuItems = await page.eval(`(() => {
				const menu = document.querySelector('.chat-menu');
				if (!menu) return null;
				return [...menu.querySelectorAll('.menu-item')].map(b => b.textContent.trim());
			})()`);
			assert.ok(menuItems && menuItems.some(label => label.includes('Help')), 'Help is in the ... menu: ' + JSON.stringify(menuItems));
			await page.eval(`(() => {
				const menu = document.querySelector('.chat-menu');
				const helpBtn = [...menu.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Help'));
				helpBtn.click();
			})()`);
			assert.ok(await page.eval(`(() => {
				const menu = document.querySelector('.chat-menu');
				if (!menu) return false;
				const items = [...menu.querySelectorAll('.menu-item')].map(b => b.textContent);
				return items.some(t => t.includes('Copy device ID')) && items.some(t => t.includes('Open logs'));
			})()`), 'Help view renders Copy device ID and Open logs inside the menu');
			await page.eval(`(() => {
				const menu = document.querySelector('.chat-menu');
				const copyBtn = [...menu.querySelectorAll('.menu-item')].find(b => b.textContent.includes('Copy device ID'));
				copyBtn.click();
			})()`);
			assert.equal(await page.eval("!document.querySelector('.chat-menu')"), true, 'menu closes after choosing Help action');
			assert.equal(await page.eval("window.__zcShell.invoke('show_help')"), null, 'show_help command succeeds');
		});

		await check('panel edges resize Projects, and Work Details keeps its size controls', async () => {
			const initialVisibility = await page.eval(`Object.fromEntries(['sidebar','auxiliary'].map(id => [id, document.getElementById(id).classList.contains('hidden')]))`);
			await page.eval(`(() => { for (const [id, toggle] of [['sidebar','btn-sidebar'],['auxiliary','btn-auxiliary']]) if(document.getElementById(id).classList.contains('hidden')) document.getElementById(toggle).click(); })()`);
			await page.eval(`new Promise(resolve => setTimeout(resolve, 300))`);
			for (const [id, width, arrow] of [['sidebar',410,'ArrowRight'],['auxiliary',350,'ArrowLeft']]) {
				if (id === 'auxiliary') {
				await page.eval(`document.querySelector('#${id} .zc-size-btn').click()`);
				assert.equal(await page.eval(`!!document.querySelector('.zc-size-pop[role="dialog"]')`), true);
				await page.eval(`(() => { const range=document.querySelector('.zc-size-pop input'); range.value='${width}'; range.dispatchEvent(new Event('input',{bubbles:true})); range.dispatchEvent(new Event('change',{bubbles:true})); })()`);
				await until(id + ' slider changes actual width', () => page.eval(`Math.abs(document.getElementById('${id}').getBoundingClientRect().width-${width})<1`));
				assert.equal(await page.eval(`document.querySelector('.zc-size-pop output').textContent`), width + ' px');
				await page.eval(`document.querySelector('.zc-size-pop').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
				assert.equal(await page.eval(`document.activeElement === document.querySelector('#${id} .zc-size-btn') && !document.getElementById('${id}').classList.contains('hidden')`), true, 'Escape closes the size menu without closing its panel');
				} else {
					assert.equal(await page.eval(`!!document.querySelector('#sidebar .zc-size-btn')`), false);
					await page.eval(`document.querySelector('#sidebar .zc-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true})); for(let i=0;i<13;i++) document.querySelector('#sidebar .zc-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
				}
				await page.eval(`document.querySelector('#${id} .zc-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'${arrow}',bubbles:true}))`);
				await until(id + ' keyboard width', () => page.eval(`Math.abs(document.getElementById('${id}').getBoundingClientRect().width-${width + 10})<1`));
				const edge = await page.eval(`(() => { const r=document.querySelector('#${id} .zc-resize').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+200}; })()`);
				await page.send('Input.dispatchMouseEvent', { type:'mousePressed', x:edge.x, y:edge.y, button:'left', clickCount:1 });
				await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:edge.x+(id==='sidebar'?20:-20), y:edge.y, button:'left', buttons:1 });
				await page.send('Input.dispatchMouseEvent', { type:'mouseReleased', x:edge.x+(id==='sidebar'?20:-20), y:edge.y, button:'left', clickCount:1 });
				await until(id + ' drag width', () => page.eval(`Math.abs(document.getElementById('${id}').getBoundingClientRect().width-${width + 30})<1`));
			}
			await page.eval(`document.querySelector('#sidebar .zc-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); document.querySelector('#auxiliary .zc-size-btn').click(); document.querySelector('.zc-size-reset').click()`);
			await until('reset panel sizes', () => page.eval(`document.getElementById('sidebar').offsetWidth===320 && document.getElementById('auxiliary').offsetWidth===360`));
			await page.screenshot(path.join(shots, 'panels-size-controls.png'));
			await page.eval(`document.querySelector('#auxiliary .zc-size-btn').click()`);
			await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:650, y:60 });
			await page.screenshot(path.join(shots, 'panels-workspace-modern.png'));
			await page.eval(`document.querySelector('#sidebar .zc-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); document.querySelector('#auxiliary .zc-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);
			assert.equal(await page.eval(`document.querySelector('.primary-chat').getBoundingClientRect().width >= 439`), true, 'wide panels reserve space for chat');
			await page.eval(`document.querySelector('#sidebar .zc-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); document.querySelector('#auxiliary .zc-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
			await until('defaults restored', () => page.eval(`document.getElementById('sidebar').offsetWidth===320 && document.getElementById('auxiliary').offsetWidth===360`));
			for (const [id, width] of [['sidebar',343],['auxiliary',377]]) {
				const edge = await page.eval(`(() => { const r=document.querySelector('#${id} .zc-resize').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+200,from:document.getElementById('${id}').getBoundingClientRect().width}; })()`);
				const x = edge.x + (width-edge.from)*(id==='sidebar'?1:-1);
				await page.send('Input.dispatchMouseEvent', {type:'mousePressed',x:edge.x,y:edge.y,button:'left',clickCount:1});
				await page.send('Input.dispatchMouseEvent', {type:'mouseMoved',x,y:edge.y,button:'left',buttons:1});
				await page.send('Input.dispatchMouseEvent', {type:'mouseReleased',x,y:edge.y,button:'left',clickCount:1});
			}
			await until('custom widths retained', () => page.eval(`document.getElementById('sidebar').offsetWidth===343 && document.getElementById('auxiliary').offsetWidth===377`));
			await until('custom widths saved to disk', async () => { const widths=JSON.parse(fs.readFileSync(path.join(data,'data','global-state.json'),'utf8'))['zer0neDesktop.preferences']?.widths; return widths?.sidebar===343 && widths?.auxiliary===377; });
			await page.eval(`(() => { for (const [id, toggle] of [['sidebar','btn-sidebar'],['auxiliary','btn-auxiliary']]) if(document.getElementById(id).classList.contains('hidden') !== ${JSON.stringify(initialVisibility)}[id]) document.getElementById(toggle).click(); })()`);
		});

		await check('project folder tools, Remote shortcut and modern About screen', async () => {
			await until('project folder actions', () => page.eval(`!!document.querySelector('.zc-delete-project') && document.querySelector('.zc-open-btn').style.display !== 'none'`));
			assert.equal(await page.eval(`document.querySelectorAll('.zc-about').length`), 0);
			await page.eval(`document.querySelector('.zc-remote').click()`);
			assert.equal(await page.eval(`!!document.querySelector('.settings-overlay') && document.querySelector('#s-nav .nav-item.active')?.dataset.nav === 'remote'`), true);
			await page.eval(`window.Settings.open('about')`);
			await until('About overview', () => page.eval(`document.querySelectorAll('.about-desktop .about-capability').length === 4`));
			await page.screenshot(path.join(shots, 'project-about-modern.png'));
			await page.eval(`window.Settings.close()`);
			await until('Settings closed', () => page.eval(`!document.querySelector('.settings-overlay')`));
			const sidebarWasHidden = await page.eval(`document.getElementById('sidebar').classList.contains('hidden')`);
			if (sidebarWasHidden) await page.eval(`document.getElementById('btn-sidebar').click()`);
			await until('sidebar visible', () => page.eval(`document.getElementById('sidebar').getBoundingClientRect().width > 100 && !document.getElementById('sidebar').classList.contains('hidden')`));
			await page.eval(`new Promise(resolve => setTimeout(resolve, 250))`);
			await page.eval(`document.querySelector('.zc-open-btn').click()`);
			assert.equal(await page.eval(`(() => { const menu=document.querySelector('.zc-open-menu'); return ['File manager','Visual Studio Code','Cursor','Terminal','Copy path'].every(label => menu.textContent.includes(label)); })()`), true);
			await page.screenshot(path.join(shots, 'project-folder-tools.png'));
			await page.eval(`document.querySelector('.zc-open-btn').click()`);
			// Host state refreshes reconcile the keyed chat list during screenshot capture.
			await page.eval(`(() => { const row=document.createElement('div'); row.id='neon-smoke'; row.className='project-chat'; row.dataset.activity='running'; row.innerHTML='<button class="project-chat-open"><span class="project-chat-title">Running session preview</span><em class="project-chat-state">Running</em></button>'; document.getElementById('sidebar-content').before(row); })()`);
			await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
			assert.equal(await page.eval(`getComputedStyle(document.querySelector('#neon-smoke button'),'::before').animationName`), 'easyui-neon-rotate');
			await page.send('Emulation.setEmulatedMedia', { features: [] });
			await page.screenshot(path.join(shots, 'project-running-neon.png'));
			const originalTheme=await page.eval(`document.body.dataset.theme || 'auto'`);
			await page.eval(`window.applyAppearance({theme:'light'})`);
			assert.equal(await page.eval(`getComputedStyle(document.querySelector('#neon-smoke button'),'::after').backgroundColor === 'rgb(5, 5, 5)'`), false, 'running row does not force a black surface in light mode');
			await page.screenshot(path.join(shots, 'project-running-light.png'));
			await page.eval(`window.applyAppearance({theme:${JSON.stringify(originalTheme)}})`);
			await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
			assert.equal(await page.eval(`getComputedStyle(document.querySelector('#neon-smoke button'),'::before').animationName`), 'none');
			await page.send('Emulation.setEmulatedMedia', { features: [] });
			await page.eval(`document.getElementById('neon-smoke').dataset.activity='waiting'; window.__zcDecorateProjects(document.getElementById('sidebar-content'))`);
			assert.equal(await page.eval(`getComputedStyle(document.querySelector('#neon-smoke button'),'::before').animationName`), 'none');
			await page.eval(`document.getElementById('neon-smoke').remove()`);
			if (sidebarWasHidden) await page.eval(`document.getElementById('btn-sidebar').click()`);
		});

		await check('Computer Use permissions and Stop work through the real desktop transport', () => require('./computer-use-smoke')(page,shots,until,exe,path.join(data,'data','global')));
		await check('Subagents monitor renders workflow phases without retired Team fields', async () => {
			await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
			await page.eval(`window.addEventListener('message', e => { if (e.data?.type === 'state') window.__zcSmokeState = e.data; }); window.Bridge.post({ type:'setMode', mode:'agent' });`);
			await until('chat state', () => page.eval(`!!window.__zcSmokeState?.currentSessionId`));
			try {
				assert.equal(await page.eval(`!!document.querySelector('#btn-team-workflow, #btn-team-models, .sag-role-picker')`), false);
				await page.eval(`if(document.getElementById('auxiliary').classList.contains('hidden')) document.getElementById('btn-auxiliary').click(); document.getElementById('aux-tab-subagents').click()`);
				assert.equal(await page.eval(`!!document.querySelector('[data-sag-workflow-toggle], [data-sag-field]')`), false);
				assert.ok(await page.eval(`!!document.querySelector('#aux-content-subagents [data-wf-configure]')`), 'the panel offers Configure');
				assert.equal(await page.eval(`window.__zcSmokeState.subagentWorkflow.enabled`), false);
				await page.eval(`window.__zcMonitorPost = window.Bridge.post; window.Bridge.post = m => { if (m.type !== 'getAgentRuns') window.__zcMonitorPost(m); }`);
				await sleep(500);
				await page.eval(`(() => {
					const sid=window.__zcSmokeState.currentSessionId;
					window.__zcTeamFixture=[
						{id:'fixture-worker',kind:'subagent',agentName:'Builder',workflowRole:'worker',status:'running',parentSessionId:sid,description:'Build the project panel',activity:'Updating theme-aware running states',prompt:'Refine project navigation.',tools:[{id:'graph-read',name:'read_file',status:'completed',startedAt:Date.now()-6000},{id:'graph-command',name:'run_command',status:'running',startedAt:Date.now()-1000}],stats:{model:'smoke-worker',startedAt:Date.now()-8000,toolUses:3,input:220,output:100,cost:.012}},
						{id:'fixture-completed',kind:'subagent',workflowRole:'worker',status:'completed',parentSessionId:sid,description:'Validate memory retention',report:'Retention regression passed.',taskReview:{reviewerId:'fixture-reviewer'},artifacts:[{path:'retention.test.js',preview:'assert.equal(pinnedMemoryRetained, true);'}],stats:{model:'smoke-worker',ms:5400,toolUses:2}},
						{id:'fixture-reviewer',kind:'subagent',agentName:'Reviewer',workflowRole:'reviewer',status:'running',parentSessionId:sid,description:'Review retention evidence',reviewTaskIds:['fixture-completed'],tools:[{id:'graph-review',name:'read_file',status:'completed',startedAt:Date.now()-800},{id:'graph-search',name:'search_code',status:'completed',startedAt:Date.now()-500}],stats:{model:'smoke-reviewer',startedAt:Date.now()-1200}}
					];
					window.dispatchEvent(new MessageEvent('message',{data:{type:'agentRuns',sessionId:sid,items:window.__zcTeamFixture}}));
				})()`);
				await until('populated teamwork', () => page.eval(`!!document.querySelector('[data-sag-key="fixture-worker"]')`));
				await until('agent graph laid out', () => page.eval(`document.querySelectorAll('.ag-node[data-agent]').length===3 && document.querySelector('.ag-canvas').getBoundingClientRect().height>=420`));
				assert.equal(await page.eval(`document.querySelectorAll('.ag-tool').length`), 3, 'shared tools appear once, connected to their recorded callers');
				const compactWidth=await page.eval(`document.getElementById('auxiliary').getBoundingClientRect().width`);
				await page.eval(`document.querySelector('[data-sag-expand]').click()`);
				assert.ok(await page.eval(`document.getElementById('auxiliary').getBoundingClientRect().width`) > compactWidth + 100, 'expanded canvas actually grows in the desktop flex layout');
				await until('graph follows the expanded pane', () => page.eval(`(() => {const c=document.querySelector('.ag-canvas'),s=c.querySelector('svg'),r=c.querySelector('.ag-lead .ag-disc').getBoundingClientRect(),b=c.getBoundingClientRect();return Math.abs(s.viewBox.baseVal.width-c.clientWidth)<3&&Math.abs(r.left+r.width/2-b.left-b.width/2)<3;})()`));
				await until('graph labels clear neighbouring nodes', () => page.eval(`(() => {const nodes=[...document.querySelectorAll('.ag-node')];return nodes.every(n=>{const label=n.querySelector('.ag-label').getBoundingClientRect();return nodes.every(other=>{if(other===n)return true;const disc=other.querySelector('.ag-disc').getBoundingClientRect();return label.right<=disc.left+1||label.left>=disc.right-1||label.bottom<=disc.top+1||label.top>=disc.bottom-1;});});})()`));
				assert.equal(await page.eval(`getComputedStyle(document.querySelector('.ag-edge[data-flow="running"]')).animationName`), 'ag-flow');
				await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
				assert.equal(await page.eval(`[...document.querySelectorAll('.ag-edge,.ag-disc,.ag-body')].every(n=>getComputedStyle(n).animationName==='none')`),true,'Reduce Motion stops graph movement');
				await page.send('Emulation.setEmulatedMedia',{features:[]});
				assert.match(await page.eval(`document.querySelector('[data-sag-key="fixture-completed"] .wf-row-main small')?.textContent || ''`), /Being checked/);
				assert.ok(await page.eval(`!!document.querySelector('[data-sag-key="fixture-reviewer"] .wf-role')`), 'the reviewer row names its role');
				await page.screenshot(path.join(shots,'teamwork-expanded.png'));
				await page.eval(`(() => {
					const sid=window.__zcSmokeState.currentSessionId;
					window.__zcTeamFixture.push({id:'fixture-writer',kind:'writer',status:'completed',parentSessionId:sid,description:'Isolated navigation update',report:'Changes ready for review.',worktree:{path:'C:/project.worktrees/navigation',branch:'zer0ne/navigation',status:'done',files:1,added:3,removed:1},stats:{model:'smoke-worker',startedAt:Date.now()-12000,writerSteps:4}});
					window.postMessage({type:'state',currentSessionId:sid,agentRuns:window.__zcTeamFixture},'*');
				})()`);
				await until('writer row',()=>page.eval(`!!document.querySelector('[data-sag-open="fixture-writer"]')`));
				await page.eval(`document.querySelector('[data-sag-open="fixture-writer"]').click(); document.querySelector('[data-sag-tab="changes"]').click()`);
				assert.ok(await page.eval(`document.getElementById('sag-inline-details').textContent.includes('zer0ne/navigation') && !!document.querySelector('[data-writer-review="diff"]')`));
				assert.equal(await page.eval(`!!document.querySelector('[data-writer-review="apply"]')`),false,'Apply requires the reviewed diff');
				await page.eval(`window.postMessage({type:'writerDiff',sessionId:window.__zcSmokeState.currentSessionId,id:'fixture-writer',reviewId:'fixture-review',files:['demo.ts'],patch:'diff --git a/demo.ts b/demo.ts\\n-old\\n+new',truncated:false},'*')`);
				await until('writer review actions',()=>page.eval(`!!document.querySelector('[data-writer-review="apply"]') && !!document.querySelector('[data-writer-review="discard"]')`));
				await page.screenshot(path.join(shots,'isolated-writer-review.png'));
				await page.eval(`document.querySelector('[data-sag-detail-close]').click(); document.getElementById('auxiliary-content').scrollTop=0`);
				await page.eval(`document.querySelector('[data-sag-expand]').click()`);
				await page.send('Emulation.setDeviceMetricsOverride',{width:700,height:900,deviceScaleFactor:1,mobile:false});
				await until('narrow drawer visible',()=>page.eval(`(() => {const r=document.getElementById('auxiliary').getBoundingClientRect(); return r.width>200 && r.height>200 && r.left>=0 && r.right<=innerWidth+1;})()`));
				assert.ok(await page.eval(`document.querySelector('.ag-node[data-agent="fixture-worker"] .ag-disc').getBoundingClientRect().width >= 40`));
				await page.screenshot(path.join(shots,'teamwork-narrow.png'));
				await page.send('Emulation.clearDeviceMetricsOverride');
				await page.eval(`window.Bridge.post({type:'setMode',mode:'agent'})`);
				await until('agent mode retained', () => page.eval(`window.__zcSmokeState.mode === 'agent' && !window.__zcSmokeState.subagentWorkflow.enabled`));
			} finally {
				await page.eval(`(() => { window.Bridge.post = window.__zcMonitorPost || window.Bridge.post; window.Bridge.post({type:'setMode',mode:'agent'}); const dialog = document.querySelector('#aux-content-subagents'); if (dialog?.open) dialog.close(); })()`);
				await page.send('Emulation.setEmulatedMedia',{features:[]});
			}
		});

		await check('/workflow opens the Workflow menu', async () => {
			await page.eval(`(() => { const i = document.getElementById('input'); i.value = '/workflow'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
			await until('workflow command listed', () => page.eval(`Array.from(document.querySelectorAll('#mention-popup .menu-item')).some(b => b.textContent.includes('/workflow'))`));
			await page.eval(`Array.from(document.querySelectorAll('#mention-popup .menu-item')).find(b => b.textContent.includes('/workflow')).click()`);
			await until('workflow menu open', () => page.eval(`!!document.querySelector('.wfm')`));
			assert.deepEqual(await page.eval(`[...document.querySelectorAll('.wfm [data-wf-pick]')].map(n => n.dataset.wfPick)`), ['orchestrator', 'worker', 'reviewer'], 'main agent, workers and reviewers');
			assert.equal(await page.eval(`document.querySelector('.wfm [data-wf-enabled]').disabled`), true, 'the switch waits for Full Access');
			assert.ok(await page.eval(`!!document.querySelector('.wfm [data-wf-fix="full"]')`), 'the menu offers to switch to Full Access');
			assert.ok(await page.eval(`(() => { const r = document.querySelector('.wfm').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.activeElement.matches('[data-wf-pick]'); })()`), 'the menu fits the window and keeps role selection keyboard focused');
			await page.screenshot(path.join(shots, 'workflow-menu.png'));
			await page.eval(`document.querySelector('.wfm [data-wf-pick="worker"]').click()`);
			await until('worker models listed', () => page.eval(`!!document.querySelector('.wfm.picking [data-wf-back]')`));
			await page.screenshot(path.join(shots, 'workflow-menu-models.png'));
			await page.eval(`document.querySelector('.wfm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
			await until('back to the roles', () => page.eval(`!!document.querySelector('.wfm [data-wf-pick="worker"]')`));
			await page.eval(`document.querySelector('.wfm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
			await until('workflow menu closed', () => page.eval(`!document.querySelector('.wfm')`));
			await page.eval(`(() => { const i = document.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
		});

		await check('Find in chat highlights matches and steps through them', async () => {
			await page.eval(`(() => { const m = document.getElementById('messages'); const probe = document.createElement('div'); probe.id = 'find-probe'; probe.textContent = 'zebra one, zebra two, zebra three'; m.appendChild(probe); })()`);
			try {
				await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))`);
				await until('find bar open', () => page.eval(`!!document.querySelector('.find-bar input')`));
				await page.eval(`(() => { const i = document.querySelector('.find-bar input'); i.value = 'zebra'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
				await until('find matches', () => page.eval(`document.querySelector('.find-count').textContent === '1 of 3'`));
				assert.equal(await page.eval(`CSS.highlights.get('zc-find').size`), 3, 'every match is highlighted');
				await page.eval(`document.querySelector('.find-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
				assert.equal(await page.eval(`document.querySelector('.find-count').textContent`), '2 of 3', 'Enter goes to the next match');
				await page.eval(`document.querySelector('.find-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }))`);
				assert.equal(await page.eval(`document.querySelector('.find-count').textContent`), '1 of 3', 'Shift+Enter goes back');
				await page.screenshot(path.join(shots, 'find-in-chat.png'));
				await page.eval(`document.querySelector('.find-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
				await until('find bar closed', () => page.eval(`!document.querySelector('.find-bar') && !CSS.highlights.has('zc-find')`));
			} finally {
				await page.eval(`document.getElementById('find-probe')?.remove(); document.querySelector('.find-bar')?.remove();`);
			}
		});

		await check('Workflow chip sits beside Stats and opens its menu', async () => {
			assert.ok(await page.eval(`(() => { const w=document.getElementById('btn-workflow'), s=document.getElementById('btn-stats'); return !!w && w.parentElement===s.parentElement && w.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING && w.getAttribute('role')==='switch'; })()`), 'the Workflow switch comes right before Stats');
			assert.equal(await page.eval(`!!document.getElementById('btn-workflow-config')`), false, 'the standalone configure icon is gone');
			await sleep(350);
			await page.screenshot(path.join(shots, 'workflow-chip.png'));
			await page.eval(`document.getElementById('btn-workflow').click()`);
			await until('workflow menu from the chip', () => page.eval(`!!document.querySelector('.wfm [data-wf-pick="orchestrator"]')`));
			await page.eval(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
			await until('workflow menu closed outside', () => page.eval(`!document.querySelector('.wfm')`));
		});

		await check('Workflow flow shows real outcomes and fits narrow layouts', async () => {
			const workflowPanels = await page.eval(`(() => { const sidebar=!document.getElementById('sidebar').classList.contains('hidden'), auxiliary=!document.getElementById('auxiliary').classList.contains('hidden'); if(sidebar) document.getElementById('btn-sidebar').click(); if(auxiliary) document.getElementById('btn-auxiliary-close').click(); return {sidebar,auxiliary}; })()`);
			await page.eval(`window.addEventListener('message',e=>{if(e.data?.type==='state') window.__zcWorkflowState=e.data;}); window.Bridge.post({type:'setMode',mode:'agent'});`);
			await until('workflow state',()=>page.eval(`!!window.__zcWorkflowState?.currentSessionId`));
			await page.eval(`window.__zcWorkflowPost=window.Bridge.post; window.Bridge.post=m=>{if(m.type!=='getAgentRuns') window.__zcWorkflowPost(m);};`);
			try {
				await sleep(500);
				await page.eval(`(() => { const sid=window.__zcWorkflowState.currentSessionId; window.__zcWorkflowFixture=[{id:'tree-worker',kind:'subagent',agentName:'Builder',description:'Build the plaza',workflowRole:'worker',status:'completed',parentSessionId:sid,stats:{model:'worker'}},{id:'tree-worker-2',kind:'subagent',agentName:'Skater',description:'Add the skater',workflowRole:'worker',status:'completed',parentSessionId:sid,stats:{model:'worker'}},{id:'tree-reviewer',kind:'subagent',agentName:'Reviewer',workflowRole:'reviewer',status:'completed',reviewVerdict:'changes',parentSessionId:sid,stats:{model:'reviewer'}}]; window.postMessage({type:'state',currentSessionId:sid,subagentWorkflow:{enabled:true,workerModel:'p::worker',reviewerModel:'p::reviewer',maxConcurrency:3,review:true},agentRuns:window.__zcWorkflowFixture},'*'); })()`);
				await until('review flow',()=>page.eval(`document.querySelector('.wff-outcome[data-picked]')?.dataset.outcome==='changes'`));
				assert.equal(await page.eval(`document.querySelectorAll('.wff-outcome').length`),3);
				assert.equal(await page.eval(`document.querySelectorAll('#wf-card .wff-mid .wff-card[data-wf-agent]').length`),2,'each worker has its own card');
				assert.equal(await page.eval(`document.getElementById('btn-workflow').getAttribute('aria-checked')`),'true','the Workflow chip shows the chat is on');
				await sleep(350);
				await page.screenshot(path.join(shots, 'workflow-chip-on.png'));
				await until('wide workflow layout',()=>page.eval(`innerWidth<1000 || getComputedStyle(document.querySelector('.wff-flow')).gridTemplateColumns.split(' ').length>1`));
				const flowGeometry = await page.eval(`(() => {const c=document.getElementById('wf-card');return {width:innerWidth,height:innerHeight,scroll:c.scrollHeight,client:c.clientHeight,card:c.getBoundingClientRect().toJSON(),columns:getComputedStyle(document.querySelector('.wff-flow')).gridTemplateColumns};})()`);
				assert.ok(flowGeometry.width<1000 || flowGeometry.height<700 || flowGeometry.scroll<=flowGeometry.client+1,'the desktop flow shows every card without being compressed by the conversation: '+JSON.stringify(flowGeometry));
				await page.screenshot(path.join(shots,'workflow-flow.png'));
				await page.send('Emulation.setDeviceMetricsOverride',{width:420,height:850,deviceScaleFactor:1,mobile:false});
				await page.eval(`if(!document.getElementById('sidebar').classList.contains('hidden')) document.getElementById('btn-sidebar').click()`);
				await until('stacked workflow flow',()=>page.eval(`getComputedStyle(document.querySelector('.wff-flow')).gridTemplateColumns.split(' ').length===1`));
				assert.ok(await page.eval(`(() => {const c=document.getElementById('wf-card'); return c.scrollWidth<=c.clientWidth+1 && c.getBoundingClientRect().right<=innerWidth+1 && document.getElementById('input').getBoundingClientRect().height>20;})()`),'the flow stays inside the viewport and leaves the composer usable');
				await page.screenshot(path.join(shots,'workflow-flow-narrow.png'));
				await page.eval(`document.getElementById('wf-card').scrollTop=document.getElementById('wf-card').scrollHeight`);
				assert.ok(await page.eval(`(() => {const c=document.getElementById('wf-card').getBoundingClientRect(),b=document.querySelector('#wf-card [data-wf-configure]').getBoundingClientRect(); return b.top>=c.top && b.bottom<c.bottom;})()`),'run controls remain visible while the narrow flow scrolls');
				await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
				assert.equal(await page.eval(`getComputedStyle(document.querySelector('#wf-card .wff-card')).transitionDuration`),'0s');
				await page.eval(`document.querySelector('#wf-card [data-wf-configure]').click()`);
				await until('narrow workflow menu',()=>page.eval(`!!document.querySelector('.wfm')`));
				assert.ok(await page.eval(`(() => {const r=document.querySelector('.wfm').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`),'the menu fits a narrow window');
				await page.screenshot(path.join(shots,'workflow-menu-narrow.png'));
				await page.eval(`document.querySelector('.wfm').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
			} finally {
				await page.send('Emulation.clearDeviceMetricsOverride');
				await page.send('Emulation.setEmulatedMedia',{features:[]});
				await page.eval(`window.Bridge.post=window.__zcWorkflowPost; window.Bridge.post({type:'setMode',mode:'agent'}); document.querySelector('.wfm')?.remove();`);
				await page.eval(`(() => { const previous=${JSON.stringify(workflowPanels)}; if(previous.sidebar===document.getElementById('sidebar').classList.contains('hidden')) document.getElementById('btn-sidebar').click(); if(previous.auxiliary===document.getElementById('auxiliary').classList.contains('hidden')) document.getElementById('btn-auxiliary').click(); })()`);
			}
		});

		await check('General settings pages preserve navigation and controls across updates', async () => {
			await page.eval(`window.Settings.open('general')`);
			try {
				assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('[data-general-page]')).map(b=>b.textContent)`), ['Language','Interaction','Message stream','Dictation','Notifications','AI Dock','Diagnostics']);
				await page.eval(`document.querySelector('[data-general-page="interaction"]').click()`);
				assert.ok(await page.eval(`!!document.getElementById('s-followUp') && !document.getElementById('s-showReasoning') && document.activeElement.id==='general-page-title'`));
				await page.eval(`document.querySelector('[data-general-page="stream"]').click()`);
				assert.ok(await page.eval(`!!document.getElementById('s-showReasoning') && !document.getElementById('s-followUp')`));
				await page.screenshot(path.join(shots,'settings-general-stream.png'));
				await page.eval(`window.Settings.open('appearance'); window.Settings.open('general')`);
				assert.equal(await page.eval(`document.querySelector('[data-general-page][aria-current="page"]').dataset.generalPage`), 'stream');
				await page.eval(`document.querySelector('[data-general-page="notch"]').click()`);
				assert.ok(await page.eval(`!!document.querySelector('.notch-card') && !document.getElementById('s-notificationSound')`));
				await page.eval(`document.querySelector('[data-general-page="diagnostics"]').click()`);
				assert.ok(await page.eval(`!!document.querySelector('[data-act="report-problem"]') && !document.querySelector('.notch-card')`));
				assert.ok(await page.eval(`!!document.querySelector('[data-act="profile-backup"]') && !!document.querySelector('[data-act="profile-restore"]')`));
				await page.eval(`document.querySelector('[data-general-page="language"]').click()`);
				assert.ok(await page.eval(`!!document.getElementById('s-language') && !!document.getElementById('s-replyLanguage')`));
				await page.screenshot(path.join(shots,'settings-general-language.png'));
				try {
					await page.send('Emulation.setDeviceMetricsOverride', { width:600, height:780, deviceScaleFactor:1, mobile:false });
					await until('compact General pages', () => page.eval(`innerWidth===600`));
					assert.ok(await page.eval(`(()=>{const p=document.getElementById('s-page'),n=document.querySelector('.general-pages');return p.scrollWidth<=p.clientWidth+1 && n.scrollWidth<=n.clientWidth+1;})()`), 'General page navigation and controls fit narrow windows');
					await page.screenshot(path.join(shots,'settings-general-compact.png'));
				} finally { await page.send('Emulation.clearDeviceMetricsOverride'); }
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('Agent settings separates behavior and specialists; Mobile remote has no Feishu', async () => {
			await page.eval(`window.Settings.open('agent')`);
			try {
				assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('[data-agent-tab]')).map(b=>b.textContent)`), ['Behavior','Subagents']);
				assert.ok(await page.eval(`!!document.querySelector('.agent-advanced') && !document.querySelector('.agent-advanced').open && !document.querySelector('.sub-list')`));
				await page.screenshot(path.join(shots,'agent-behavior-simplified.png'));
				await page.eval(`document.querySelector('[data-agent-tab="subagents"]').click()`);
				await until('specialist settings loaded', () => page.eval(`!!document.querySelector('[data-sub="new"]') && !!document.querySelector('.sub-list')`));
				assert.ok(await page.eval(`!document.querySelector('.agent-advanced') && !!document.querySelector('#s-subagents')`));
				await page.screenshot(path.join(shots,'subagents-settings-simplified.png'));
				await page.eval(`window.Settings.open('remote')`);
				assert.ok(await page.eval(`!!document.getElementById('s-remotePort') && !document.querySelector('#s-page').textContent.includes('Feishu')`));
				await page.screenshot(path.join(shots,'mobile-remote-simplified.png'));
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('Features dashboard shows scoped evidence, search and dated activity', async () => {
			await page.eval(`window.Settings.open('features')`);
			try {
				await until('Features catalog and checks', () => page.eval(`!!document.querySelector('.features-hub .cap-stat') && !document.querySelector('[data-act="features-check"]').disabled`));
				assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.cap-tabs [data-feature-tab]')).map(b=>b.textContent)`),['Overview','Capabilities','Checks & activity','Benchmark']);
				await page.screenshot(path.join(shots,'features-overview.png'));
				await page.eval(`document.querySelector('[data-feature-tab="capabilities"]').click()`);
				await until('Features cards', () => page.eval(`document.querySelectorAll('[data-feature]').length > 15`));
				assert(await page.eval(`!document.querySelector('[data-feature="debugTools"]') && !!document.querySelector('[data-feature="projectVerification"]') && !!document.querySelector('[data-feature="codeIntelligence"]')`));
				await page.screenshot(path.join(shots,'features-capabilities.png'));
				await page.eval(`(() => { const input=document.getElementById('feature-search'); input.focus(); input.value='dependency'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				assert.equal(await page.eval(`document.querySelectorAll('[data-feature]').length`),1);
				assert.equal(await page.eval(`document.activeElement.id`),'feature-search');
				await page.eval(`document.querySelector('[data-feature-tab="checks"]').click()`);
				await until('Features health evidence and empty project activity', () => page.eval(`!!document.querySelector('.feature-check-results details') && document.querySelector('.feature-reports').textContent.includes('No project runs yet')`));
				await page.screenshot(path.join(shots,'features-checks.png'));
				await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
				try {
					await page.eval(`document.body.classList.add('remote'); document.querySelector('[data-feature-tab="capabilities"]').click(); const input=document.getElementById('feature-search'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true}));`);
					assert(await page.eval(`(() => { const page=document.querySelector('.features-hub'); return page.scrollWidth <= page.clientWidth+1 && getComputedStyle(document.querySelector('.cap-stats')).gridTemplateColumns.split(' ').length===2; })()`),'Features stays within the mobile viewport');
					await page.screenshot(path.join(shots,'features-mobile.png'));
				} finally { await page.send('Emulation.clearDeviceMetricsOverride'); await page.eval(`document.body.classList.remove('remote')`); }
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('Reasoning uses Auto and only the selected model capabilities', async () => {
			await page.eval(`window.Bridge.post({type:'addCustom', name:'Reasoning smoke fixture',baseUrl:'http://127.0.0.1:9/v1',apiFormat:'responses',smart:false,models:[{id:'gpt-6-sol',tools:true,smart:false},{id:'unadjustable-fixture',tools:true,smart:false}]})`);
			await until('reasoning fixture provider', () => page.eval(`window.__zcSmokeState.providers.some(p=>p.name==='Reasoning smoke fixture')`));
			try {
				await page.eval(`window.Bridge.post({type:'selectModel',providerId:window.__zcSmokeState.providers.find(p=>p.name==='Reasoning smoke fixture').id,model:'gpt-6-sol'})`);
				await until('adjustable model selected', () => page.eval(`window.__zcSmokeState.selection.model==='gpt-6-sol' && !document.getElementById('btn-effort').parentElement.classList.contains('hidden')`));
				assert.equal(await page.eval(`document.getElementById('effort-label').textContent`), 'Auto');
				await page.eval(`(() => { window.__reasoningTrace=[]; const menu=document.getElementById('effort-menu'), toggle=menu.classList.toggle.bind(menu.classList); menu.classList.toggle=function(...args){if(args[0]==='hidden')window.__reasoningTrace.push({args,stack:new Error().stack});return toggle(...args);}; })()`);
				await page.eval(`document.getElementById('btn-effort').click()`);
				assert.ok(await page.eval(`!!document.querySelector('.ef-slider') && !document.querySelector('#effort-menu button, #effort-menu .ef-note, #effort-menu .ef-captions')`), 'reasoning contains only the banner and its heading');
				await until('provider notification settled', () => page.eval(`document.getElementById('toast').classList.contains('hidden')`));
				await page.screenshot(path.join(shots,'reasoning-menu-simplified.png'));
				await page.eval(`(() => { const slider=document.querySelector('.ef-slider'); slider.value=slider.max; slider.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				assert.ok(await page.eval(`!!document.querySelector('.ef-galaxy.ef-deep') && document.getElementById('effort-label').textContent==='Auto'`), 'slider preview does not change the saved model effort');
				await until('reasoning grab handle reaches its endpoint', () => page.eval(`(() => { const brain=document.querySelector('.ef-brain').getBoundingClientRect(), track=document.querySelector('.ef-orbit').getBoundingClientRect(); return Math.abs(brain.width-44)<0.1 && Math.abs(brain.right-track.right)<1 && getComputedStyle(document.querySelector('.ef-slider')).cursor==='grab'; })()`));
				await page.screenshot(path.join(shots,'reasoning-galaxy-preview.png'));
				await page.eval(`document.querySelector('.ef-slider').dispatchEvent(new Event('change',{bubbles:true}))`);
				await until('slider effort saved', () => page.eval(`document.getElementById('effort-label').textContent!=='Auto'`));
				await page.eval(`document.getElementById('btn-effort').click(); document.querySelector('.ef-slider').focus()`);
				await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
				await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Home', code:'Home', windowsVirtualKeyCode:36 });
				await until('native slider keyboard saved Auto', () => page.eval(`document.getElementById('effort-label').textContent==='Auto' && document.activeElement.id==='btn-effort'`));
				await page.eval(`document.getElementById('btn-effort').click()`);
				await page.eval(`(() => { const slider=document.querySelector('.ef-slider'); slider.value='3'; slider.dispatchEvent(new Event('input',{bubbles:true})); slider.dispatchEvent(new Event('change',{bubbles:true})); })()`);
				await until('manual effort saved', () => page.eval(`document.getElementById('effort-label').textContent==='Medium'`));
				await page.eval(`document.getElementById('btn-effort').click(); const slider=document.querySelector('.ef-slider'); slider.value='0'; slider.dispatchEvent(new Event('change',{bubbles:true}));`);
				await until('Auto restored', () => page.eval(`document.getElementById('effort-label').textContent==='Auto'`));
				await page.eval(`window.Bridge.post({type:'selectModel',providerId:window.__zcSmokeState.providers.find(p=>p.name==='Reasoning smoke fixture').id,model:'unadjustable-fixture'})`);
				await until('no redundant reasoning control', () => page.eval(`window.__zcSmokeState.selection.model==='unadjustable-fixture' && document.getElementById('btn-effort').parentElement.classList.contains('hidden')`));
			} catch(error) {
				console.error('Reasoning failure:', error);
				console.log('Reasoning layout diagnostics:', await page.eval(`(() => {const menu=document.getElementById('effort-menu'),brain=document.querySelector('.ef-brain'),orbit=document.querySelector('.ef-orbit'),slider=document.querySelector('.ef-slider');return {menu:menu.className,brain:brain?.getBoundingClientRect().toJSON(),orbit:orbit?.getBoundingClientRect().toJSON(),slider:slider?.value,trace:window.__reasoningTrace?.slice(-8)};})()`).catch(error => error.message));
				throw error;
			} finally { await page.eval(`delete document.getElementById('effort-menu').classList.toggle; window.Bridge.post({type:'deleteProvider',id:window.__zcSmokeState.providers.find(p=>p.name==='Reasoning smoke fixture').id})`).catch(() => undefined); }
		});

		await check('completed thinking and tool activity remain expandable; compaction summaries stay visible', async () => {
			await page.eval(`(() => {
				window.__zcSummaryOriginal=window.__zcSmokeState; window.__zcSummaryDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__summaryFixture){window.__zcSummaryOriginal=event.data;return true;}return window.__zcSummaryDispatch.call(this,event);};
				window.__zcSummaryState={...window.__zcSummaryOriginal,__summaryFixture:true,isStreaming:false,streaming:null,messages:[
					{id:'summary-user',role:'user',content:'Review the project',turn:{startedAt:1,endedAt:1001,model:'fixture'}},
					{id:'summary-tool',role:'assistant',kind:'tool',content:'',tool:{name:'read_file',arg:'README.md',status:'done',summary:'Read the project guide'}},
					{id:'summary-answer',role:'assistant',content:'Project review completed.',reasoning:'Review explanation supplied by the model.'},
					{id:'summary-divider',role:'assistant',compacted:true,content:'Context compacted',reasoning:'## Conversation summary\\n\\nPreserved project decisions and remaining work.'},
					{id:'summary-next',role:'user',content:'Continue from the summary'}]};
				window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryState}));
			})()`);
			try {
				assert.ok(await page.eval(`(() => { const button=document.querySelector('[data-toggle="summary-divider"]'); return !!button && button.getBoundingClientRect().height>0 && button.getAttribute('aria-expanded')==='false'; })()`), 'summary is visible before opening completed tool activity');
				assert.ok(await page.eval(`(() => { const d=document.querySelector('#msg-summary-answer .thinking'); return !!d && !d.classList.contains('open') && d.querySelector('.tk-head').getBoundingClientRect().height>0 && d.querySelector('.tk-body').inert && d.querySelector('.tk-text').textContent.includes('Review explanation supplied by the model'); })()`), 'completed replies keep their reasoning folded behind a header');
				assert.ok(await page.eval(`!!document.querySelector('.worked:not(.open) [data-toggle="w:summary-user"]') && !document.querySelector('.worked-body')`), 'tool activity starts collapsed beside the completed answer');
				await page.eval(`document.querySelector('[data-toggle="w:summary-user"]').click();`);
				assert.ok(await page.eval(`!document.querySelector('#msg-summary-answer .thinking').classList.contains('open') && document.querySelector('.worked.open .worked-body').textContent.includes('README.md')`), 'opening tool activity leaves the folded reasoning receipt alone');
				await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryState}))`);
				assert.ok(await page.eval(`!document.querySelector('#msg-summary-answer .thinking').classList.contains('open') && !!document.querySelector('.worked.open .worked-body')`), 'folded reasoning and open activity survive a state refresh');
				await page.eval(`document.querySelector('#msg-summary-answer .thinking .tk-head').click(); document.querySelector('[data-toggle="w:summary-user"]').click();`);
				assert.ok(await page.eval(`(() => { const d=document.querySelector('#msg-summary-answer .thinking'); return d.classList.contains('open') && d.querySelector('.tk-head').getBoundingClientRect().height>0 && d.querySelector('.tk-body').inert === false && !document.querySelector('.worked-body') && document.getElementById('messages').textContent.includes('Project review completed.'); })()`), 'a click opens the reasoning, and activity collapses while the final answer stays visible');
				await page.eval(`document.querySelector('#msg-summary-answer .thinking .tk-head').click();`);
				assert.ok(await page.eval(`(() => { const d=document.querySelector('#msg-summary-answer .thinking'); return !d.classList.contains('open') && d.querySelector('.tk-head').getBoundingClientRect().height>0 && d.querySelector('.tk-body').inert && document.getElementById('messages').textContent.includes('Project review completed.'); })()`), 'the header folds the reasoning again');
				await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryState}))`);
				assert.ok(await page.eval(`!document.querySelector('#msg-summary-answer .thinking').classList.contains('open')`), 'a folded thinking card stays folded after a state refresh');
				await page.screenshot(path.join(shots,'chat-activity-summary-restored.png'));
				await page.eval(`document.querySelector('[data-toggle="summary-divider"]').click()`);
				assert.ok(await page.eval(`document.querySelector('[data-toggle="summary-divider"]').getAttribute('aria-expanded')==='true' && document.getElementById('messages').textContent.includes('Preserved project decisions') && document.getElementById('messages').textContent.includes('Project review completed.')`));
				await page.screenshot(path.join(shots,'chat-summary-restored.png'));
				await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryState}))`);
				assert.ok(await page.eval(`document.querySelector('[data-toggle="summary-divider"]').getAttribute('aria-expanded')==='true'`), 'summary expansion survives a state refresh');
				await page.eval(`document.querySelector('[data-toggle="summary-divider"]').click()`);
				assert.ok(await page.eval(`!document.getElementById('messages').textContent.includes('Preserved project decisions')`));
				await page.eval(`window.__zcSummaryState.settings={...window.__zcSummaryState.settings,showReasoning:false}; window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryState}));`);
				assert.ok(await page.eval(`!document.querySelector('#msg-summary-answer .thinking') && !!document.querySelector('[data-toggle="summary-divider"]')`), 'Show reasoning affects model thinking, while conversation summaries remain accessible');
			} finally { await page.eval(`window.dispatchEvent=window.__zcSummaryDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcSummaryOriginal}));`); }
		});

		await check('streamed reasoning stays folded until clicked, then shows live steps on a timeline', async () => {
			const send = (data) => page.eval(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(data)}}))`);
			await page.eval(`(() => {
				window.__zcStreamOriginal=window.__zcSmokeState; window.__zcStreamDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__streamFixture){window.__zcStreamOriginal=event.data;return true;}return window.__zcStreamDispatch.call(this,event);};
				window.__zcStreamState={...window.__zcStreamOriginal,__streamFixture:true,isStreaming:true,streaming:null,settings:{...window.__zcStreamOriginal.settings,showReasoning:true},messages:[{id:'stream-user',role:'user',content:'Fix the login bug',turn:{startedAt:Date.now(),model:'fixture'}}]};
				window.__zcStreamDispatch.call(window,new MessageEvent('message',{data:window.__zcStreamState}));
			})()`);
			try {
				await send({ type: 'streamStart' });
				await send({ type: 'delta', reasoning: '**Reading the auth flow**\n\nThe session cookie is set before the redirect.' });
				await new Promise((r) => setTimeout(r, 200));
				assert.ok(await page.eval(`(() => { const d=document.querySelector('.msg.streaming .thinking'); return !!d && d.classList.contains('busy') && !d.classList.contains('open') && d.querySelector('.tk-head').getAttribute('aria-expanded')==='false' && d.querySelector('.tk-title').textContent.startsWith('Thinking') && /^\\d+s$/.test(d.querySelector('.tk-clock').textContent); })()`), 'live reasoning stays folded as a thinking receipt');
				await page.eval(`document.querySelector('.msg.streaming .thinking .tk-head').click()`);
				await new Promise((r) => setTimeout(r, 320));
				assert.ok(await page.eval(`(() => { const d=document.querySelector('.msg.streaming .thinking'); const item=d.querySelector('.tk-item[data-status="active"]'); return d.classList.contains('open') && !!item && item.querySelector('.tk-label').textContent==='Reading the auth flow' && !!item.querySelector('.tk-glyph') && d.querySelector('.tk-text').textContent.includes('The session cookie is set before the redirect.'); })()`), 'a click opens the live trace and marks the current step');
				await send({ type: 'delta', reasoning: '\n\n**Checking the redirect**\n\nThe guard reads it too early.' });
				await new Promise((r) => setTimeout(r, 700));
				assert.ok(await page.eval(`(() => { const d=document.querySelector('.msg.streaming .thinking'); const items=d.querySelectorAll('.tk-item'); return items.length===2 && items[1].dataset.status==='active' && items[0].dataset.status==='done'; })()`), 'each reasoning step joins the timeline and the newest is active');
				await page.screenshot(path.join(shots, 'chat-thinking-state.png'));
				await send({ type: 'delta', text: 'The guard ran before the **cookie** was written. ' });
				await new Promise((r) => setTimeout(r, 120));
				assert.ok(await page.eval(`(() => { const line=document.querySelector('#messages .status-line'); return !!line && line.hidden; })()`), 'the status line yields to the reasoning receipt instead of showing a second Thinking');
				assert.ok(await page.eval(`(() => { const s=document.querySelector('.msg.streaming'); const d=s.querySelector('.thinking'); return d.classList.contains('done') && !d.querySelector('.tk-item[data-status="active"]') && /^Thought for$/.test(d.querySelector('.tk-title').textContent) && s.querySelectorAll('.md .stream-block.stream-enter').length>0 && !!s.querySelector('.md .ans-caret'); })()`), 'answer blocks reveal behind a caret once reasoning is done');
				await page.screenshot(path.join(shots, 'chat-answer-streaming.png'));
				await new Promise((r) => setTimeout(r, 1000));
				assert.ok(await page.eval(`(() => { const d=document.querySelector('.msg.streaming .thinking'); return !d.classList.contains('open') && d.querySelector('.tk-head').getBoundingClientRect().height>0 && /^Thought for$/.test(d.querySelector('.tk-title').textContent); })()`), 'a finished trace folds itself back to its header');
				await page.eval(`document.querySelector('.msg.streaming .thinking .tk-head').click()`);
				await new Promise((r) => setTimeout(r, 320));
				assert.ok(await page.eval(`document.querySelector('.msg.streaming .thinking').classList.contains('open')`), 'the header opens it again');
			} finally { await page.eval(`window.dispatchEvent=window.__zcStreamDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcStreamOriginal}));`); }
		});

		await check('active agents show as a live tree with status, rolled-up cost, time and folding branches', async () => {
			await page.eval(`(() => {
				window.__zcAgtOriginal=window.__zcSmokeState; window.__zcAgtDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='agentRuns')return true;if(event.type==='message'&&event.data?.type==='state'&&!event.data.__agtFixture){window.__zcAgtOriginal=event.data;return true;}return window.__zcAgtDispatch.call(this,event);};
				const t=Date.now()-60000, run=(id,parentId,agentName,description,status,cost,ms,extra)=>({id,sessionId:window.__zcAgtOriginal.currentSessionId,kind:'subagent',agentName,description,parentId,status,stats:{model:'Sonnet 5.5',startedAt:t+5000,ms,cost},...extra});
				window.__zcAgtState={...window.__zcAgtOriginal,__agtFixture:true,isStreaming:true,streaming:null,runState:'running',messages:[{id:'agt-user',role:'user',content:'Launch the new pricing page by Friday',turn:{startedAt:t,model:'Opus 5.5'}}],agentRuns:[
					run('research',undefined,'Researcher','Compare the pricing of five competitors','running',0.12,40000),
					run('scrape','research','Scraper','Read the pricing pages of Linear, Notion and three more','completed',0.03,12000),
					run('build',undefined,'Coder','Build the page and wire up checkout','running',0.2,50000),
					run('tests','build','Tester','Write and run the checkout tests','failed',0.02,9000,{error:'2 of 14 checkout tests fail – coupon codes are not applied'}),
					run('retry','build','Tester','Fix the coupon test and run all again','running',undefined,4000,{executionState:'queued'})]};
				window.__zcAgtDispatch.call(window,new MessageEvent('message',{data:window.__zcAgtState}));
			})()`);
			try {
				await new Promise((r) => setTimeout(r, 600));
				const tree = await page.eval(`(() => { const b=document.querySelector('.msg.agt'); if(!b) return null; const card=id=>b.querySelector('[data-agent="'+id+'"] > .agt-node'); return {
					nodes:b.querySelectorAll('.agt-node').length, links:b.querySelectorAll('.agt-links path').length, wide:b.classList.contains('wide'),
					root:b.querySelector('.agt-root .agt-status').textContent, research:card('research').querySelector('.agt-amount').textContent,
					queued:card('retry').dataset.status, sum:b.querySelector('.agt-sum').textContent }; })()`);
				assert.ok(tree, 'the turn shows an agent tree');
				assert.equal(tree.nodes, 6, JSON.stringify(tree));
				assert.ok(tree.links >= 5, 'links connect every card: ' + JSON.stringify(tree));
				assert.equal(tree.root, 'Running');
				assert.equal(tree.research, '$0.150', 'a branch rolls up its sub-agents’ cost');
				assert.equal(tree.queued, 'queued');
				assert.ok(/6 agents/.test(tree.sum) && /3 running/.test(tree.sum) && /1 failed/.test(tree.sum), tree.sum);
				await page.screenshot(path.join(shots, 'chat-agent-tree.png'));
				await page.eval(`document.querySelector('[data-agent="build"] > .agt-node .agt-fold').click()`);
				assert.ok(await page.eval(`(() => { const hang=document.querySelector('[data-agent="build"]'); return hang.classList.contains('folded') && hang.querySelector('.agt-fold').textContent.trim()==='+2' && hang.querySelector('.agt-below').getBoundingClientRect().height===0; })()`), 'a branch folds to one line');
				await page.eval(`document.querySelector('.msg.agt [data-agt-pop]').click()`);
				assert.ok(await page.eval(`/coupon codes/.test(document.querySelector('.msg.agt .agt-pop').textContent)`), 'the failed chip lists what went wrong');
				await page.screenshot(path.join(shots, 'chat-agent-tree-folded.png'));
			} finally { await page.eval(`window.dispatchEvent=window.__zcAgtDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcAgtOriginal}));`); }
		});

		await check('thinking shows one view across classic, terminal and light themes', () => require('./thinking-ui-smoke')(page, shots, until));

		await check('tool rows, approvals and toasts use the card designs', async () => {
			await page.eval(`(() => {
				window.__zcCardsOriginal=window.__zcSmokeState; window.__zcCardsDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__cardsFixture){window.__zcCardsOriginal=event.data;return true;}return window.__zcCardsDispatch.call(this,event);};
				const tool=(id,name,arg,status,summary,extra)=>({id,role:'assistant',kind:'tool',content:'',tool:{name,arg,status,summary,durationMs:1400,...extra}});
				window.__zcCardsState={...window.__zcCardsOriginal,__cardsFixture:true,isStreaming:true,streaming:null,runState:'waiting',agentRuns:[],messages:[
					{id:'cards-user',role:'user',content:'Fix the checkout coupon bug',turn:{startedAt:Date.now()-20000,model:'fixture'}},
					tool('cards-read1','read_file','src/checkout.ts','done','120 lines'),
					tool('cards-read2','grep','applyCoupon','done','4 matches'),
					tool('cards-fetch','web_fetch','https://api.example.test/coupons','done','200 OK',{detail:JSON.stringify({status:200,coupons:[{code:'SPRING',percent:15,active:true},{code:'OLD',percent:5,active:false}],cached:null})}),
					tool('cards-diag','get_diagnostics','src/checkout.ts','error','Type check failed',{detail:"src/checkout.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."}),
					{id:'cards-approval',role:'assistant',kind:'tool',content:'',approval:{id:'cards-approval',kind:'command',status:'pending',command:'npm test -- checkout'}}]};
				window.__zcCardsDispatch.call(window,new MessageEvent('message',{data:window.__zcCardsState}));
			})()`);
			try {
				await new Promise((r) => setTimeout(r, 400));
				await page.eval(`document.querySelector('[data-toggle="g:cards-read1"]').click()`);
				await new Promise((r) => setTimeout(r, 200));
				await page.eval(`document.querySelector('[data-toggle="cards-fetch"]').click()`);
				await new Promise((r) => setTimeout(r, 400));
				const view = await page.eval(`(() => { const card=document.querySelector('.msg.approval.apc'); return {
					approval: !!card && card.querySelector('.apc-risk').textContent==='Medium risk' && card.querySelector('.tool-status').textContent==='Needs approval' && !!card.querySelector('[data-approve] kbd'),
					panel: !!document.querySelector('.tcc-panel .tcc-key') && document.querySelector('.tcc-panel .tcc-label').textContent==='Result',
					failed: !!document.querySelector('.tool-row.error .tcc-err'),
					group: document.querySelector('.tool-group > .tool-head .tool-time')?.textContent, tiles: document.querySelectorAll('.tool-group > .tool-head .tcc-tile').length,
					time: document.querySelector('[data-toggle="cards-fetch"] .tool-time')?.textContent }; })()`);
				assert.ok(view.approval, 'the pending approval is an Approval Card with its risk and shortcuts: ' + JSON.stringify(view));
				assert.ok(view.panel, 'expanded JSON output is labelled and coloured');
				assert.ok(view.failed, 'a failed step shows the red mark');
				assert.equal(view.time, '1.4s');
				assert.equal(view.group, '5.6s', 'a group adds up its steps’ time');
				assert.ok(view.tiles >= 2, 'a group stacks its tools as tiles');
				await page.eval(`window.UI.toast('Copied the coupon report', 'ok')`);
				await new Promise((r) => setTimeout(r, 600));
				assert.ok(await page.eval(`!!document.querySelector('#toast .toast-icon[data-type="success"] .toast-check') && !document.getElementById('toast').classList.contains('hidden')`), 'the toast draws its status mark');
				await page.screenshot(path.join(shots, 'chat-cards.png'));
				await page.eval(`(() => { const list=document.getElementById('messages'); list.scrollTop=list.scrollHeight; })()`);
				await new Promise((r) => setTimeout(r, 300));
				await page.screenshot(path.join(shots, 'chat-approval-card.png'));
				await page.eval(`document.getElementById('toast').classList.add('hidden')`);
			} finally { await page.eval(`window.dispatchEvent=window.__zcCardsDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcCardsOriginal}));`); }
		});

		await check('the progress checklist uses the Agent Plan design', async () => {
			await page.eval(`(() => {
				window.__zcPlanOriginal=window.__zcSmokeState; window.__zcPlanDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__planFixture){window.__zcPlanOriginal=event.data;return true;}return window.__zcPlanDispatch.call(this,event);};
				const todos=(n)=>['Read the checkout flow','Find where coupons apply','Fix the coupon rounding','Add a regression test','Run the checkout tests'].map((text,i)=>({text,done:i<n}));
				window.__zcPlanState=(n)=>({...window.__zcPlanOriginal,__planFixture:true,isStreaming:true,streaming:null,runState:'running',agentRuns:[],settings:{...window.__zcPlanOriginal.settings,showTodos:true},messages:[
					{id:'plan-user',role:'user',content:'Fix the checkout coupon bug',turn:{startedAt:Date.now()-30000,model:'fixture'}},
					{id:'plan-todos',role:'assistant',kind:'tool',content:'',todos:todos(n),tool:{name:'todo_write',arg:'',status:'done',summary:'Plan'}}]});
				window.__zcPlanDispatch.call(window,new MessageEvent('message',{data:window.__zcPlanState(1)}));
			})()`);
			try {
				await new Promise((r) => setTimeout(r, 300));
				await page.eval(`window.__zcPlanDispatch.call(window,new MessageEvent('message',{data:window.__zcPlanState(2)}))`);
				await page.eval(`(() => { const card=document.getElementById('git-tools'); if (card && card.classList.contains('mini')) document.getElementById('sp-mini')?.click(); })()`);
				await new Promise((r) => setTimeout(r, 1200));
				const view = await page.eval(`(() => { const p=document.getElementById('progress'); const steps=[...p.querySelectorAll('.plc-step')]; return {
					states: steps.map((s) => s.dataset.step).join(','), spinner: !!p.querySelector('.plc-step[data-step="active"] .plc-spinner line'),
					nums: [...p.querySelectorAll('.plc-num')].map((n) => n.textContent).join(','), rails: p.querySelectorAll('.plc-rail').length,
					time: p.querySelector('.plc-step:nth-child(2) .plc-time')?.textContent || '', foot: p.querySelector('.plc-foot')?.textContent || '' }; })()`);
				assert.equal(view.states, 'done,done,active,pending,pending', JSON.stringify(view));
				assert.ok(view.spinner, 'the step at work spins');
				assert.equal(view.nums, '4,5', 'pending steps keep their numbers');
				assert.equal(view.rails, 4, 'a rail joins every step to the next');
				assert.match(view.time, /^\d+(\.\d)?s$/, 'a step finished in this window shows how long it took');
				assert.match(view.foot, /^Running · 3 of 5\d/, view.foot);
				await page.screenshot(path.join(shots, 'chat-agent-plan.png'));
			} finally { await page.eval(`window.dispatchEvent=window.__zcPlanDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcPlanOriginal}));`); }
		});

		await check('answer footer, inline diff, context, command and model menus use the card designs', async () => {
			await page.eval(`(() => {
				window.__zcPolishOriginal=window.__zcSmokeState; window.__zcPolishDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__polishFixture){window.__zcPolishOriginal=event.data;return true;}return window.__zcPolishDispatch.call(this,event);};
				const o=window.__zcPolishOriginal;
				window.__zcPolishState={...o,__polishFixture:true,isStreaming:false,streaming:null,agentRuns:[],
					providers:[{id:'polish-p',name:'Fixture AI',enabled:true,efforts:{},models:[{id:'fixture-model',name:'Fixture Sonnet',enabled:true,contextWindow:200000},{id:'fixture-mini',name:'Fixture Mini',enabled:true,contextWindow:128000}]}],
					selection:{providerId:'polish-p',model:'fixture-model'},
					context:{used:124000,window:200000,source:'provider',parts:{messages:62,systemTools:18,systemPrompt:9,skills:5,mcpTools:4,meta:2}},
					messages:[
						{id:'polish-user',role:'user',content:'Round the checkout total',turn:{startedAt:Date.now()-9000,endedAt:Date.now()-1000,model:'fixture-model',provider:'Fixture AI',usage:{input:44000,output:14}}},
						{id:'polish-answer',role:'assistant',content:'The total now rounds to cents before tax is added.',model:'fixture-model',at:Date.now()},
						{id:'polish-edit-user',role:'user',content:'Review the next edit'},
						{id:'polish-edit',role:'assistant',kind:'tool',content:'',approval:{id:'polish-edit',kind:'edit',status:'pending',path:'src/checkout.ts',find:'const total = price * qty;\\nreturn total;',replace:'const total = Math.round(price * qty * 100) / 100;\\nreturn total;'}}]};
				window.__zcPolishDispatch.call(window,new MessageEvent('message',{data:window.__zcPolishState}));
			})()`);
			try {
				await new Promise((r) => setTimeout(r, 400));
				assert.ok(await page.eval(`!!document.querySelector('.msg.apc .ln.add mark.dw') && document.querySelector('.msg.apc .ln.add mark.dw').textContent.includes('Math.round')`), 'the edit shows its changed words marked');
				assert.ok(await page.eval(`(() => { const footer=document.querySelector('#msg-polish-answer .msg-actions'); return !!footer.querySelector('.msg-time') && footer.querySelector('.msg-usage').textContent.includes('44k in') && !footer.querySelector('.msg-model') && !footer.textContent.includes('Fixture AI') && !footer.textContent.includes('fixture-model'); })()`), 'the answer footer keeps time, usage and actions without provider or model labels');
				await page.eval(`document.querySelector('.mac-btn.mac-copy').click()`);
				await new Promise((r) => setTimeout(r, 150));
				assert.ok(await page.eval(`document.querySelector('.mac-btn.mac-copy').hasAttribute('data-done') && document.querySelector('.mac-copy + .mac-tip').textContent==='Copied'`), 'copy morphs to a check and flashes Copied');
				await page.screenshot(path.join(shots, 'chat-polish-answer.png'));
				await page.eval(`document.getElementById('btn-context').click()`);
				await new Promise((r) => setTimeout(r, 700));
				const cw = await page.eval(`(() => { const m=document.getElementById('context-menu'); return { big: m.querySelector('.cw-big')?.textContent, pill: m.querySelector('.cw-pill')?.textContent, cells: m.querySelectorAll('.cw-cell:not(.free)').length, parts: m.querySelectorAll('.cw-part').length, compact: !!m.querySelector('.cw-action') }; })()`);
				assert.equal(cw.pill, '62%', JSON.stringify(cw));
				assert.ok(cw.cells > 80 && cw.cells < 95 && cw.parts === 6 && cw.compact, 'context cells follow the used share: ' + JSON.stringify(cw));
				await page.screenshot(path.join(shots, 'chat-context-window.png'));
				await page.eval(`document.body.click()`);
				await page.eval(`document.getElementById('btn-model').click()`);
				await new Promise((r) => setTimeout(r, 400));
				assert.ok(await page.eval(`!!document.querySelector('.popover.mdp .mdp-glyph') && !document.querySelector('.popover.mdp .mdp-foot')`), 'the model menu shows provider tiles without the repeated current-model footer');
				const pickerStyle = await page.eval(`(() => { const hadGlass=document.body.classList.contains('zg-on'); document.body.classList.add('zg-on'); const menu=document.getElementById('model-menu'), style=getComputedStyle(menu); const result={image:style.backgroundImage,color:style.backgroundColor,blur:style.backdropFilter,width:menu.offsetWidth}; if(!hadGlass)document.body.classList.remove('zg-on'); return result; })()`);
				assert.ok(pickerStyle.image==='none' && pickerStyle.color.startsWith('rgb(') && pickerStyle.blur==='none' && pickerStyle.width>=390, 'the larger model picker stays opaque with Liquid Glass enabled: '+JSON.stringify(pickerStyle));
				await page.screenshot(path.join(shots, 'chat-model-picker.png'));
				await page.eval(`document.body.click()`);
				await page.eval(`(() => { const input=document.getElementById('input'); input.focus(); input.value='/co'; input.setSelectionRange(3,3); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				await new Promise((r) => setTimeout(r, 400));
				assert.ok(await page.eval(`(() => { const p=document.getElementById('mention-popup'); return p.classList.contains('cmc') && !!p.querySelector('.cmc-pill[data-lit]') && !!p.querySelector('.cmc-item mark') && !!p.querySelector('.cmc-foot'); })()`), 'the slash menu marks matches and glides its highlight');
				await page.screenshot(path.join(shots, 'chat-command-menu.png'));
				await page.eval(`(() => { const input=document.getElementById('input'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				await page.eval(`window.__zcPolishDispatch.call(window,new MessageEvent('message',{data:{...window.__zcPolishState,messages:[],providers:[],selection:{},sessions:[]}}))`);
				await new Promise((r) => setTimeout(r, 900));
				assert.ok(await page.eval(`(() => { const w=document.querySelector('.welcome'); return !!w && !w.querySelector('.sgc') && !w.querySelector('.welcome-status') && !!w.querySelector('.welcome-hero') && w.textContent.includes('Connect your first model'); })()`), 'the welcome screen has no setup guide or get-started badge');
				await page.screenshot(path.join(shots, 'chat-welcome.png'));
			} finally { await page.eval(`window.dispatchEvent=window.__zcPolishDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcPolishOriginal}));`); }
		});

		await check('message right-click menu offers Side Chat, context, chapters, Markdown and fork actions', async () => {
			await page.eval(`(() => {
				window.__zcMenuOriginal=window.__zcSmokeState;window.__zcMenuPost=window.Bridge.post;window.__zcMenuPosts=[];
				window.__zcMenuClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');window.__zcMenuCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.__zcMenuCopies.push(text)}});
				window.__zcMenuDispatch=window.dispatchEvent;window.dispatchEvent=function(e){if(e.type==='message'&&e.data?.type==='state'&&!e.data.__menuFixture){window.__zcMenuOriginal=e.data;return true;}return window.__zcMenuDispatch.call(this,e);};
				window.Bridge.post=m=>{if(['toggleChapter','branchChat'].includes(m.type)){window.__zcMenuPosts.push(m);return;}return window.__zcMenuPost(m);};
				window.__zcMenuState={...window.__zcMenuOriginal,__menuFixture:true,messages:[{id:'menu-question',role:'user',content:'Explain this connection',turn:{startedAt:Date.now()-2000,endedAt:Date.now()-1000}},{id:'menu-answer',role:'assistant',content:'## Connection diagnosis\\n\\nThe **socket closed** when the service restarted.'}],chapters:[]};
				window.dispatchEvent(new MessageEvent('message',{data:window.__zcMenuState}));document.getElementById('msg-menu-answer').scrollIntoView();
				const range=document.createRange();range.selectNodeContents(document.querySelector('#msg-menu-answer .md p'));window.getSelection().removeAllRanges();window.getSelection().addRange(range);document.dispatchEvent(new Event('selectionchange'));document.getElementById('input').value='Keep my main draft';
			})()`);
			try {
				// Reopening a menu after native capture or focused-menu removal can clear the browser selection.
				const clickMenu = (index, select = true) => page.eval(`if(${select}){const r=document.createRange();r.selectNodeContents(document.querySelector('#msg-menu-answer .md p'));window.getSelection().removeAllRanges();window.getSelection().addRange(r);}document.querySelector('#msg-menu-answer .md p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:700,clientY:400})); document.querySelectorAll('.chat-message-menu button')[${index}].click()`);
				const point=await page.eval(`(() => {const r=document.querySelector('#msg-menu-answer .md p').getBoundingClientRect();return {x:r.left+50,y:r.top+8};})()`);
				await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'right',clickCount:1});
				await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'right',clickCount:1});
				await until('custom message menu',()=>page.eval(`!!document.querySelector('.chat-message-menu')`));
				const labels=await page.eval(`[...document.querySelectorAll('.chat-message-menu button .grow')].map(n=>n.childNodes[0].textContent)`);
				assert.deepEqual(labels,['Copy','Copy message','Copy message as Markdown','Send to Side Chat','Attach selection as context','Pin as chapter','Fork from here']);
				await page.eval(`document.getElementById('toast').classList.add('hidden')`);
				await page.screenshot(path.join(shots,'message-right-click.png'));
				// Native captures can resize or scroll the page, which dismisses menus.
				await clickMenu(3);
				assert.equal(await page.eval(`document.querySelector('#side-chat blockquote').textContent`),'The socket closed when the service restarted.');
				await page.eval(`document.querySelector('[data-side-close]').click()`);
				await page.eval(`(() => { const r=document.createRange();r.selectNodeContents(document.querySelector('#msg-menu-answer .md p'));window.getSelection().removeAllRanges();window.getSelection().addRange(r); })()`);
				const openMenu=()=>page.eval(`document.querySelector('#msg-menu-answer .md p').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:700,clientY:400}))`);
				for(const index of [0,1,2]) await clickMenu(index);
				const copies=await page.eval(`window.__zcMenuCopies`);assert.equal(copies[0],'The socket closed when the service restarted.');assert(!copies[1].includes('**'));assert.equal(copies[2],'## Connection diagnosis\n\nThe **socket closed** when the service restarted.');
				await clickMenu(4);
				assert.match(await page.eval(`document.getElementById('input').value`),/^Keep my main draft\n\nSelected context:\n> The socket closed when the service restarted\./);
				await clickMenu(5);
				assert.deepEqual(await page.eval(`window.__zcMenuPosts[0]`),{type:'toggleChapter',id:'menu-answer',sessionId:await page.eval(`window.__zcMenuState.currentSessionId`)});
				await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:{...window.__zcMenuState,chapters:['menu-answer']}}))`);
				assert.equal(await page.eval(`document.querySelector('.prompt-tick.chapter')?.dataset.promptId`),'menu-answer');
				await openMenu();assert.equal(await page.eval(`document.querySelectorAll('.chat-message-menu button')[5].textContent`),'Unpin chapter');
				await clickMenu(6);
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).type`),'toggleChapter', 'opening the chooser does not branch');
				assert.equal(await page.eval(`document.querySelector('.chat-branch-dialog').open`),true);
				assert.deepEqual(await page.eval(`[...document.querySelectorAll('.chat-branch-choice')].map(b=>b.dataset.destination)`),['workspace','worktree']);
				await page.screenshot(path.join(shots,'chat-branch-destination.png'));
				await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
				await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
				await until('branch chooser dismissed',()=>page.eval(`!document.querySelector('.chat-branch-dialog')`));
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).type`),'toggleChapter');
				await clickMenu(6);
				await page.eval(`document.querySelector('.chat-branch-choice[data-destination="workspace"]').click()`);
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).type`),'branchChat');
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).id`),'menu-answer');
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).destination`),'workspace');
				await page.eval(`document.querySelector('#msg-menu-answer [data-branch]').click(); document.querySelector('.chat-branch-choice[data-destination="worktree"]').click()`);
				assert.equal(await page.eval(`window.__zcMenuPosts.at(-1).destination`),'worktree');
				await page.eval(`window.getSelection().removeAllRanges()`);await openMenu();
				assert.equal(await page.eval(`document.querySelectorAll('.chat-message-menu button')[0].disabled && document.querySelectorAll('.chat-message-menu button')[4].disabled`),true);
				await clickMenu(3, false);
				assert.match(await page.eval(`document.querySelector('#side-chat blockquote').textContent`),/## Connection diagnosis/);
			} finally {
				await page.eval(`if(window.__zcMenuClipboard)Object.defineProperty(navigator,'clipboard',window.__zcMenuClipboard);else delete navigator.clipboard;window.dispatchEvent=window.__zcMenuDispatch;window.Bridge.post=window.__zcMenuPost;document.querySelector('[data-side-new]').click();document.querySelector('[data-side-close]').click();window.dispatchEvent(new MessageEvent('message',{data:window.__zcMenuOriginal}));document.getElementById('input').value=''`);
			}
		});

		await check('selected text opens isolated streaming Side Chat and full transparency frosts both panels', async () => {
			await page.eval(`void window.Bridge.post({type:'addCustom',name:'Side Chat smoke',baseUrl:'http://127.0.0.1:${sideModel.address().port}/v1',apiFormat:'openai',smart:false,models:[{id:'side-smoke',tools:false,smart:false}]}); 0`);
			await until('Side Chat model available', () => page.eval(`window.__zcSmokeState.providers.some(p=>p.name==='Side Chat smoke') && [...document.querySelector('#side-chat select').options].some(o=>o.textContent==='side-smoke')`));
			const mainBefore = await page.eval(`JSON.stringify({messages:window.__zcSmokeState.messages,selection:window.__zcSmokeState.selection})`);
			await page.eval(`(() => { const msg=document.createElement('article'); msg.id='side-smoke-message';msg.className='msg assistant';msg.innerHTML='<div class="md"><h2>Connection diagnosis</h2><p>The socket closed when the service restarted.</p><p>Review the restart log to confirm whether the disconnect was expected.</p></div>';document.getElementById('messages').appendChild(msg);msg.scrollIntoView(); const range=document.createRange();range.selectNodeContents(msg.querySelector('p'));window.getSelection().removeAllRanges();window.getSelection().addRange(range);document.getElementById('input').value='Keep my main draft'; document.dispatchEvent(new Event('selectionchange')); })()`);
			await until('selected text action', () => page.eval(`!!document.querySelector('.side-chat-selection')`));
			await page.screenshot(path.join(shots,'side-chat-selection.png'));
			await page.eval(`(() => { document.querySelector('.side-chat-selection button').click(); const select=document.querySelector('#side-chat select'); const p=window.__zcSmokeState.providers.find(p=>p.name==='Side Chat smoke');select.value=JSON.stringify([p.id,'side-smoke']);select.dispatchEvent(new Event('change')); })()`);
			assert.equal(await page.eval(`document.getElementById('side-chat').hidden === false && document.activeElement === document.querySelector('#side-chat textarea')`),true);
			await page.screenshot(path.join(shots,'side-chat-excerpt.png'));
			await page.eval(`(() => { const field=document.querySelector('#side-chat textarea');field.value='Why did this connection close?';field.dispatchEvent(new Event('input'));document.querySelector('#side-chat form').dispatchEvent(new Event('submit',{cancelable:true})); })()`);
			await until('Side Chat streamed answer', () => page.eval(`document.querySelector('.side-chat-answer strong')?.textContent==='Check the restart log' && document.querySelector('.side-chat-stop').hidden`));
			assert.equal(sideRequests.length,1);assert(sideRequests[0].messages.at(-1).content.includes('The socket closed when the service restarted.'));assert(!sideRequests[0].tools?.length);
			assert.equal(await page.eval(`document.getElementById('input').value`),'Keep my main draft');
			assert.equal(await page.eval(`JSON.stringify({messages:window.__zcSmokeState.messages,selection:window.__zcSmokeState.selection})`),mainBefore);
			await page.screenshot(path.join(shots,'side-chat-answer.png'));
			await page.eval(`document.querySelector('[data-side-close]').click();document.getElementById('btn-side-chat').click()`);
			assert.equal(await page.eval(`document.querySelector('.side-chat-answer strong').textContent`),'Check the restart log');
			await page.eval(`document.querySelector('[data-side-new]').click();document.querySelector('[data-side-close]').click();document.getElementById('side-smoke-message')?.remove();document.getElementById('input').value=''`);
			const initial = await page.eval(`({prefs:JSON.parse(localStorage.getItem('zg.prefs')),sidebar:document.getElementById('sidebar').classList.contains('hidden'),auxiliary:document.getElementById('auxiliary').classList.contains('hidden')})`);
			try {
				await page.eval(`(() => { for (const [id,toggle] of [['sidebar','btn-sidebar'],['auxiliary','btn-auxiliary']])if(document.getElementById(id).classList.contains('hidden'))document.getElementById(toggle).click(); window.__zgSync({...${JSON.stringify(initial.prefs)},transparency:100,blur:false,autoSolid:false,haze:false,at:Date.now()+1}); })()`);
				await until('full transparency class',()=>page.eval(`document.body.classList.contains('zg-full')`));
				assert.deepEqual(await page.eval(`['sidebar','auxiliary'].map(id=>getComputedStyle(document.getElementById(id)).backdropFilter)`),['blur(32px) saturate(1.35)','blur(32px) saturate(1.35)']);
				assert.equal(await page.eval(`document.querySelector('.zg-blur-cb').checked || document.querySelector('.zg-blur-cb').disabled`),false,'Full transparency keeps whole-window blur optional');
				if(process.platform==='win32') {
					await sleep(2000);
					assert.equal(await page.eval(`window.__zcShell.boot.support.panelBlur`),true);
					// PowerShell started from Electron cannot compile the helper on hosted CI runners.
					if(!process.env.GITHUB_ACTIONS) assert(!fs.readFileSync(logFile,'utf8').includes('Panel glass:'),'The real app must initialize native panel surfaces without helper errors');
				}
				await page.screenshot(path.join(shots,'panels-full-transparency.png'));
			} finally {
				await page.eval(`(() => { window.__zgSync({...${JSON.stringify(initial.prefs)},at:Date.now()+10}); for(const [id,toggle]of[['sidebar','btn-sidebar'],['auxiliary','btn-auxiliary']])if(document.getElementById(id).classList.contains('hidden')!==${JSON.stringify(initial)}[id])document.getElementById(toggle).click(); })()`);
			}
			await page.eval(`void window.Bridge.post({type:'deleteProvider',id:window.__zcSmokeState.providers.find(p=>p.name==='Side Chat smoke').id}); 0`);
			await until('Side Chat test provider removed', () => page.eval(`!window.__zcSmokeState.providers.some(p=>p.name==='Side Chat smoke')`));
		});

		await check('chat resizing retains the visible paragraph and queued edits retain focus during updates', async () => {
			await page.send('Page.bringToFront');
			await page.eval(`(() => {
				window.__reliabilityState = window.__zcSmokeState;
				window.__reliabilityMessages = Array.from({length:30},(_,i)=>({id:'resize-'+i,role:'assistant',content:Array.from({length:4},(_,j)=>'Paragraph '+i+'.'+j+' — '+('Reading position should remain stable while the chat column changes width. '.repeat(5))).join('\\n\\n')}));
				window.dispatchEvent(new MessageEvent('message',{data:{...window.__reliabilityState,currentSessionId:'resize-fixture',messages:window.__reliabilityMessages,queue:[]}}));
			})()`);
			await page.eval(`new Promise(resolve=>setTimeout(resolve,250))`);
			await page.eval(`(() => { const list=document.getElementById('messages'); list.dispatchEvent(new WheelEvent('wheel',{deltaY:-1})); list.scrollTop=1300; list.dispatchEvent(new Event('scroll')); })()`);
			// Let the native scroll and any prior ResizeObserver restoration finish before resizing.
			await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
			await page.eval(`(() => { const list=document.getElementById('messages'); list.dispatchEvent(new Event('scroll')); const top=list.getBoundingClientRect().top; window.__resizeAnchor=[...list.querySelectorAll('.md p')].find(p=>p.getBoundingClientRect().bottom>top+8); window.__resizeOffset=window.__resizeAnchor.getBoundingClientRect().top-top; list.style.width='calc(100% - 180px)'; })()`);
			await page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
			const reading = await page.eval(`({offset:window.__resizeAnchor.getBoundingClientRect().top-document.getElementById('messages').getBoundingClientRect().top,expected:window.__resizeOffset,connected:window.__resizeAnchor.isConnected,message:window.__resizeAnchor.closest('.msg')?.id,session:window.__zcSmokeState.currentSessionId,scroll:document.getElementById('messages').scrollTop})`);
			assert.ok(reading.connected && Math.abs(reading.offset-reading.expected)<2, 'resize must keep the same paragraph at the same offset: ' + JSON.stringify(reading));
			await page.eval(`(() => {
				window.__queuePost=window.Bridge.post; window.__queuePosts=[]; window.Bridge.post=m=>{if(['beginQueueEdit','editQueued'].includes(m.type))window.__queuePosts.push(m);else window.__queuePost(m)};
				const data={...window.__reliabilityState,currentSessionId:'resize-fixture',messages:window.__reliabilityMessages,queue:[{id:'editing',text:'original',attachments:[]}]}; window.__queueFixture=data;
				window.dispatchEvent(new MessageEvent('message',{data})); document.querySelector('.queue-item .q-act:not(.q-del)').click(); window.__editor=document.querySelector('.q-edit'); window.__editor.value='my edited question'; window.__editor.setSelectionRange(3,6);
				window.dispatchEvent(new MessageEvent('message',{data:{...data,isStreaming:true,streaming:{text:'Another streamed update',reasoning:''}}}));
			})()`);
			assert.ok(await page.eval(`document.querySelector('.q-edit')===window.__editor&&document.activeElement===window.__editor&&window.__editor.value==='my edited question'&&window.__editor.selectionStart===3`));
			await page.eval(`window.__editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
			assert.equal(await page.eval(`window.__queuePosts.at(-1).text`), 'my edited question');
			await page.eval(`window.Bridge.post=window.__queuePost; document.getElementById('messages').style.width=''; window.dispatchEvent(new MessageEvent('message',{data:window.__reliabilityState}));`);
		});

		await check('Stats reveals a compact row and opens anchored detail popups', async () => {
			await page.eval(`(() => {
				window.__zcStatsSmokeState = window.__zcSmokeState;
				window.__zcStatsDispatch=window.dispatchEvent;
				window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__statsFixture){window.__zcStatsSmokeState=event.data;return true;}return window.__zcStatsDispatch.call(this,event);};
				const messages = Array.from({length:5}, (_, i) => ({id:'stats-prompt-'+i, role:'user', content:'Session statistics preview', turn:{startedAt:Date.now()-10000, endedAt:Date.now(), attempts:Array.from({length:21}, (_,step) => ({id:'request-'+i+'-'+step, purpose:'main', step, durationMs:3000, firstTextMs:1000, outcome:'completed', usage:{input:1000, output:68, cached:860}})), usage:{input:2878000, output:22000, cached:2475080, attempts:21, knownAttempts:21, cacheKnownAttempts:21}, toolTimings:[{durationMs:1250}]}}));
				messages.push({id:'stats-answer', role:'assistant', content:'Your session statistics are available below the message box. Select a section to see timing, token and context details.'});
				window.__zcStatsFixture = {...window.__zcStatsSmokeState, type:'state', __statsFixture:true, isStreaming:false, streaming:null, messages, context:{used:197000, window:262000, source:'provider', parts:{systemPrompt:0.8, systemTools:2.8, messages:96.4}}};
				const button = document.getElementById('btn-stats');
				if(button.getAttribute('aria-expanded')==='true') button.click();
			})()`);
			await page.eval(`new Promise(resolve => setTimeout(resolve, 400))`);
			assert.equal(await page.eval(`document.getElementById('stats-banner').getBoundingClientRect().height`), 0);
			await page.eval(`document.getElementById('btn-stats').click()`);
			await page.eval(`new Promise(resolve => setTimeout(resolve, 500))`);
			await page.eval(`window.dispatchEvent(new MessageEvent('message', {data:window.__zcStatsFixture}))`);
			await page.eval(`document.getElementById('toast').classList.add('hidden'); new Promise(resolve => setTimeout(resolve, 500))`);
			// Covered native windows can pause compositor animations despite renderer timers advancing.
			await page.eval(`document.getElementById('stats-banner').getAnimations({subtree:true}).forEach(animation => animation.finish())`);
			const statsView = await page.eval(`(() => {
				const b=document.getElementById('stats-banner'), input=document.getElementById('input-card');
				return {inert:b.inert, top:b.getBoundingClientRect().top, inputBottom:input.getBoundingClientRect().bottom, text:b.textContent, fixtureType:window.__zcStatsFixture?.type, fixtureMessages:window.__zcStatsFixture?.messages?.length, receivedMessages:window.__zcSmokeState?.messages?.length};
			})()`);
			await page.screenshot(path.join(shots, 'session-stats-banner.png'));
			assert.equal(statsView.inert, false, JSON.stringify(statsView));
			assert.ok(statsView.top>=statsView.inputBottom-0.5, JSON.stringify(statsView));
			for (const text of ['105 steps','34 tok/s','14.5M','86%','75%']) assert.ok(statsView.text.includes(text), text + ': ' + JSON.stringify(statsView));
			assert.equal(await page.eval(`document.getElementById('stats-banner').getBoundingClientRect().height<=32 && !document.querySelector('#stats-banner details') && !document.getElementById('stats-popup')`), true);
			for (const [key, title] of [['session','Session statistics'],['tokens','Token usage'],['context','75% of context used']]) {
				await page.eval('document.getElementById("stats-' + key + '").click()');
				await page.eval(`new Promise(resolve => setTimeout(resolve, 220))`);
				assert.equal(await page.eval(`document.querySelectorAll('#stats-popup[role="dialog"]').length`), 1);
				assert.equal(await page.eval(`document.getElementById('stats-popup-title').textContent`), title);
				assert.equal(await page.eval(`document.getElementById('stats-banner').getBoundingClientRect().height<=32`), true, 'popup never expands the row');
				const popupBounds = await page.eval(`(() => { const p=document.getElementById('stats-popup').getBoundingClientRect(), r=document.querySelector('#stats-content [aria-expanded="true"]').getBoundingClientRect(); return {popup:p.toJSON(),anchor:r.toJSON(),width:innerWidth,height:innerHeight}; })()`);
				assert(popupBounds.popup.top>=0 && popupBounds.popup.bottom<=popupBounds.anchor.top && popupBounds.popup.left>=0 && popupBounds.popup.right<=popupBounds.width, JSON.stringify({key,...popupBounds}));
				await page.screenshot(path.join(shots, 'session-stats-' + key + '-popup.png'));
			}
			await page.eval(`document.getElementById('stats-popup').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
			assert.equal(await page.eval(`!document.getElementById('stats-popup') && document.activeElement.id==='stats-context' && document.getElementById('btn-stats').getAttribute('aria-expanded')==='true'`), true);
			await page.eval(`document.getElementById('stats-tokens').click(); document.getElementById('input-card').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
			assert.equal(await page.eval(`!document.getElementById('stats-popup')`), true);
			await page.eval(`document.getElementById('stats-context').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
			assert.equal(await page.eval(`document.getElementById('stats-banner').inert && document.activeElement.id==='btn-stats' && document.getElementById('btn-stats').getAttribute('aria-expanded')==='false'`), true);
			await page.eval(`window.dispatchEvent=window.__zcStatsDispatch; window.dispatchEvent(new MessageEvent('message',{data:window.__zcStatsSmokeState})); delete window.__zcStatsSmokeState; delete window.__zcStatsFixture; delete window.__zcStatsDispatch`);
		});

		await check('provider model switches save and update the chat picker through the desktop host', async () => {
			await page.eval(`window.Bridge.post({type:'addCustom',name:'Model smoke fixture',baseUrl:'http://127.0.0.1:9/v1',apiFormat:'openai',smart:false,models:[{id:'smoke-main',tools:true,smart:false},{id:'smoke-worker',tools:true,smart:false}]})`);
			await until('model fixture ready', () => page.eval(`window.__zcSmokeState.providers.some(p=>p.name==='Model smoke fixture')`));
			await page.eval(`window.Settings.open('models')`);
			try {
				await until('provider model settings', () => page.eval(`(() => { const p=window.__zcSmokeState.providers.find(p=>p.name==='Model smoke fixture'); const button=document.querySelector('[data-provider="'+p.id+'"]'); if (!button) return false; button.click(); return !!document.querySelector('[data-model="smoke-worker"] [data-act="toggle-model"]'); })()`));
				await page.eval(`document.querySelector('[data-model="smoke-worker"] [data-act="toggle-model"]').click()`);
				await until('model disabled in host state', () => page.eval(`window.__zcSmokeState.providers.find(p=>p.name==='Model smoke fixture').models.find(m=>m.id==='smoke-worker').enabled === false`));
				await page.eval(`window.Settings.close(); document.getElementById('btn-model').click()`);
				assert.ok(await page.eval(`!Array.from(document.querySelectorAll('#model-menu .model-item')).some(el=>el.textContent.includes('smoke-worker'))`), 'disabled model is absent from chat picker');
				await page.eval(`document.getElementById('btn-model').click(); window.Settings.open('models')`);
				await until('disabled switch rendered', () => page.eval(`document.querySelector('[data-model="smoke-worker"] [data-act="toggle-model"]')?.checked === false`));
				await page.eval(`document.querySelector('[data-model="smoke-worker"] [data-act="toggle-model"]').click()`);
				await until('model enabled in host state', () => page.eval(`window.__zcSmokeState.providers.find(p=>p.name==='Model smoke fixture').models.find(m=>m.id==='smoke-worker').enabled === true`));
				await page.eval(`window.Settings.close(); document.getElementById('btn-model').click()`);
				assert.ok(await page.eval(`Array.from(document.querySelectorAll('#model-menu .model-item')).some(el=>el.textContent.includes('smoke-worker'))`), 'enabled model appears in chat picker');
				await page.eval(`document.querySelector('#model-menu .model-item[data-model="smoke-worker"]').click()`);
				await until('chat model selected', () => page.eval(`window.__zcSmokeState.selection.model==='smoke-worker' && document.getElementById('model-label').textContent.includes('Model smoke fixture')`));
				await page.eval(`document.getElementById('btn-model').click(); document.querySelector('#model-menu .model-item[data-model="smoke-worker"]').parentElement.querySelector('.mm-favorite').click()`);
				await until('favorite saved', () => page.eval(`window.__zcSmokeState.modelPreferences.favorites.some(s=>s.model==='smoke-worker') && document.getElementById('model-menu').textContent.includes('Favorites')`));
				await page.screenshot(path.join(shots, 'model-switch-favorites.png'));
				await page.eval(`document.getElementById('btn-model').click(); window.__zcModelChat=window.__zcSmokeState.currentSessionId; window.Bridge.post({type:'forkSession',id:window.__zcModelChat})`);
				await until('fork inherits its model', () => page.eval(`window.__zcSmokeState.currentSessionId!==window.__zcModelChat && window.__zcSmokeState.selection.model==='smoke-worker'`));
				await page.eval(`document.getElementById('btn-model').click(); document.querySelector('#model-menu .model-item[data-model="smoke-main"]').click()`);
				await until('fork model saved', () => page.eval(`window.__zcSmokeState.selection.model==='smoke-main'`));
				await page.eval(`window.Bridge.post({type:'switchSession',id:window.__zcModelChat})`);
				await until('original chat keeps its model', () => page.eval(`window.__zcSmokeState.currentSessionId===window.__zcModelChat && window.__zcSmokeState.selection.model==='smoke-worker'`));
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('Local Models is Models Fit Studio\'s page on zer0ne Engine, with Engine & more beside it', async () => {
			await page.eval(`window.__zcLocalSmokeErrors=[]; window.addEventListener('error', e=>window.__zcLocalSmokeErrors.push(e.message)); window.Settings.open('local')`);
			const inFrame = (js) => page.eval(`(() => { const f = document.querySelector('.mfs-frame'); const d = f && f.contentDocument; if (!d || !d.getElementById('tabsBar')) return null; const $ = (id) => d.getElementById(id); return (${js}); })()`);
			try {
				await until('Models Fit Studio page', () => inFrame(`$('tabsBar').querySelectorAll('.tab').length === 5`)).catch(async e => { console.log(await page.eval(`JSON.stringify({errors:window.__zcLocalSmokeErrors,frame:document.querySelector('.mfs-frame')?.src,text:document.querySelector('#s-page')?.textContent.slice(0,800)})`)); throw e; });
				assert.deepEqual(await inFrame(`[...$('tabsBar').querySelectorAll('.tab')].map(b => b.textContent.trim())`), ['Models', 'Battle', 'Library', 'Settings', 'Engine & more']);
				// the page asks zer0ne Engine about this machine and gets its answer
				await until('hardware from zer0ne Engine', () => inFrame(`/Memory budget/.test($('hwBody').innerText) && /GB/.test($('hwBody').innerText)`));
				// zer0ne code's theme, not the page's own lime
				assert.equal(await inFrame(`d.documentElement.dataset.host`), 'zer0ne');
				assert.equal(await page.eval(`(() => { const f = document.querySelector('.mfs-frame'); return f.contentWindow.getComputedStyle(f.contentDocument.documentElement).getPropertyValue('--accent').trim() === getComputedStyle(document.body).getPropertyValue('--accent').trim(); })()`), true);
				// Windows-only controls are hidden
				assert.equal(await inFrame(`getComputedStyle($('themeBtn')).display`), 'none');
				// the Library answers from zer0ne code's models folder
				await inFrame(`(d.querySelector('[data-tab="library"]').click(), true)`);
				await until('library folder', () => inFrame(`/models/.test($('libDirPath').textContent)`));
				// Settings → Local models keeps the page loaded while Settings refreshes around it
				const marker = await inFrame(`(d.body.dataset.smoke = 'kept', 'kept')`);
				await page.eval(`window.postMessage({ type: 'machineChecking', on: false }, '*')`);
				await sleep(400);
				assert.equal(await inFrame(`d.body.dataset.smoke`), marker, 'the page was not reloaded');
				await page.screenshot(path.join(shots, 'local-models-modelfit-real.png'));

				// Engine & more: the engine (with the assistant and Local Host folded under it) and activity
				await inFrame(`(d.querySelector('.tab.zc-more').click(), true)`);
				await until('Engine & more', () => page.eval(`!document.querySelector('.mfs-frame') && !!document.querySelector('[data-act="mfs-back"]') && !!document.querySelector('[data-local-tab="runtimes"]')`));
				assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('.local-tabs .local-tab')).map(b => b.textContent.trim())`).then(a => a.map(s => s.replace(/\s*on$/, ''))), ['Local models', 'Engine', 'Activity']);
				assert.ok(await page.eval(`!!document.querySelector('[data-runtime-section="host"]') && !!document.querySelector('[data-runtime-section="assistant"]') && !document.querySelector('#lh-enabled').checked`), 'Local Host and the assistant are under Engine, the router off');
				await page.eval(`document.querySelector('[data-local-tab="activity"]').click()`);
				await until('Activity', () => page.eval(`!!document.querySelector('.act .act-status') && !!document.querySelector('.act-now')`));
				await until('system Activity without a loaded model', () => page.eval(`document.querySelector('#lv-live-ram-t')?.textContent.includes('/') && /[0-9]+\\.[0-9]+%/.test(document.querySelector('#lv-live-cpu-t')?.textContent || '')`));
				assert.equal(await page.eval(`document.querySelector('#lv-live-state').textContent`), 'engine off');
				await page.eval(`document.querySelector('[data-local-tab="runtimes"]').click()`);
				assert.ok(await page.eval(`Array.from(document.querySelectorAll('[data-runtime-section]')).every(d => !d.open)`));
				await page.eval(`document.querySelector('[data-runtime-section="engine"]').open = true`);
				assert.ok(await page.eval(`document.querySelector('#eng-firsttest').checked`));
				await page.eval(`document.querySelector('#eng-firsttest').click()`);
				await until('first-load policy saved', () => page.eval(`document.querySelector('#eng-firsttest')?.checked === false`));
				await sleep(100);
				await page.eval(`document.querySelector('[data-local-tab="activity"]').click(); document.querySelector('[data-local-tab="runtimes"]').click()`);
				assert.ok(await page.eval(`document.querySelector('[data-runtime-section="engine"]').open`));
				await page.screenshot(path.join(shots, 'local-models-engine-real.png'));
				// back to Models Fit Studio's page
				await page.eval(`document.querySelector('[data-act="mfs-back"]').click()`);
				await until('back on the page', () => inFrame(`$('tabsBar').querySelectorAll('.tab').length === 5`));
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('desktop plans expose vendor agents, setup guidance and all custom API formats', async () => {
			await page.eval(`window.__zcSmokeErrors=[]; window.addEventListener('error', e=>window.__zcSmokeErrors.push(e.message)); window.addEventListener('message', e => { if (e.data?.type === 'acpAgents') window.__zcSmokeAgents = e.data; })`);
			await page.eval(`window.Settings.open('models'); document.querySelector('[data-act="add-provider"]').click()`);
			try {
				await until('desktop subscription agent list', () => page.eval(`!!document.querySelector('#plan-grid [data-acp-signin="github-copilot-cli"]')`));
				assert.ok(await page.eval(`['Claude','Cursor','Copilot','Factory','Augment','JetBrains'].every(name => document.querySelector('#plan-grid').textContent.includes(name))`));
				assert.ok(await page.eval(`document.querySelectorAll('#plan-grid [data-acp-signin]').length >= 10`));
				assert.ok(await page.eval(`['grok-build','kimi','minimax-code'].every(id => document.querySelector('#plan-grid [data-acp-signin="' + id + '"]'))`));
				assert.ok(await page.eval(`!document.querySelector('[data-plan-filter], [data-effort-toggle], .acp-more')`));
				assert.ok(await page.eval(`!document.querySelector('#plan-grid [data-acp-signin="codex-acp"], #plan-grid [data-acp-signin="gemini"]')`));
				assert.equal(await page.eval(`Array.from(document.querySelectorAll('#plan-grid .ac-id b')).filter(e => e.textContent === 'Google Antigravity').length`), 1);
				assert.equal(await page.eval(`Array.from(document.querySelectorAll('#plan-grid .ac-id b')).filter(e => e.textContent === 'ChatGPT').length`), 1);
				assert.ok(await page.eval(`!document.querySelector('#plan-grid [data-preset="copilot"]') && !document.querySelector('#plan-grid [data-preset="github-models"]')`));
				assert.ok(await page.eval(`!!document.querySelector('.connections-overview')`));
				await page.eval(`(() => { const q=document.getElementById('plan-q'); q.value='ChatGPT'; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				assert.equal(await page.eval(`document.querySelectorAll('#plan-grid .acct-card').length`), 1, 'plan search returns the single ChatGPT connection');
				await page.eval(`(() => { const q=document.getElementById('plan-q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); })()`);
				await page.screenshot(path.join(shots, 'providers-plans-real.png'));
				await page.eval(`document.querySelector('[data-act="custom-open"]').click()`);
				assert.deepEqual(await page.eval(`Array.from(document.querySelectorAll('[data-cp-format]')).map(b => b.dataset.cpFormat)`), ['openai','responses','anthropic','gemini']);
				await page.eval(`document.querySelector('[data-cp-format="responses"]').click()`);
				assert.equal(await page.eval(`document.querySelector('[data-cp-format="responses"]').getAttribute('aria-checked')`), 'true');
			} catch (error) {
				console.log('Agent list diagnostics:', await page.eval(`JSON.stringify({cards:window.__zcSmokeAgents?.cards?.length,error:window.__zcSmokeAgents?.error,errors:window.__zcSmokeErrors,page:document.querySelector('#s-page')?.textContent})`));
				throw error;
			} finally { await page.eval(`window.Settings.close()`); }
		});

		await check('Liquid Glass settings are saved app-wide (glass.json)', async () => {
			const at = Date.now();
			const saved = await page.eval(`window.__zcShell.invoke('glass_prefs', { prefs: { transparency: 0, haze: true, blur: false, dim: 0, autoSolid: true, matchColors: true, at: ${at} } })`);
			assert.strictEqual(saved, true);
			const file = JSON.parse(fs.readFileSync(path.join(data, 'glass.json'), 'utf8'));
			assert.strictEqual(file.at, at);
			const big = await page.eval(`window.__zcShell.invoke('glass_prefs', { prefs: { pad: 'x'.repeat(5000) } })`);
			assert.strictEqual(big, false, 'oversized settings refused');
			// 0% is an opaque window; raising it swaps the native window. The page must survive
			// the swap with the same webContents, DOM and bridge.
			await page.eval(`window.__glassSwap = 'kept'`);
			const up = Date.now();
			assert.strictEqual(await page.eval(`window.__zcShell.invoke('glass_prefs', { prefs: { transparency: 50, haze: true, blur: false, dim: 0, autoSolid: true, matchColors: true, at: ${up} } })`), true);
			await until('window swapped for a see-through one', () => page.eval(`window.__glassSwap === 'kept' && document.visibilityState === 'visible' && innerWidth >= 560 && window.__zcShell.invoke('plugin:window|is_maximized').then((v) => typeof v === 'boolean')`));
			const down = Date.now();
			assert.strictEqual(await page.eval(`window.__zcShell.invoke('glass_prefs', { prefs: { transparency: 0, haze: true, blur: false, dim: 0, autoSolid: true, matchColors: true, at: ${down} } })`), true);
			await until('window swapped back to opaque', () => page.eval(`window.__glassSwap === 'kept' && document.visibilityState === 'visible' && innerWidth >= 560`));
		});

		await check('native full screen fills the display and reveals floating window controls at the top edge', async () => {
			// Focus emulation does not restore a native window covered or minimized by the desktop,
			// and full screen cannot size a minimized one: put it back on screen first.
			await restoreWindow();
			await page.send('Page.bringToFront');
			await page.send('Emulation.setFocusEmulationEnabled', { enabled:true });
			try {
				await page.eval(`(() => { const input = document.getElementById('input'); input.value = 'Keep this draft'; input.focus(); document.getElementById('btn-fullscreen').click(); })()`);
				await until('native full screen', () => page.eval(`window.__zcShell.invoke('plugin:window|is_fullscreen').then(on => on && document.body.classList.contains('zc-native-fullscreen'))`));
				// Window resizing can place the desktop pointer over the reveal strip.
				await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:300, y:200 });
				await until('window controls hidden', () => page.eval(`getComputedStyle(document.querySelector('.topbar')).visibility === 'hidden' && document.querySelector('.topbar').inert`));
				await until('full screen resize complete', () => page.eval(`Math.abs(innerWidth - screen.width) <= 1 && Math.abs(innerHeight - screen.height) <= 1`)).catch(async error => {
					console.log('Full-screen geometry:', await page.eval(`({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,screenLeft:screenX,screenTop:screenY,dpr:devicePixelRatio,visible:document.visibilityState,viewport:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}})`));
					throw error;
				});
				const layout = await page.eval(`(() => {
					const box = document.querySelector('.coding-workspace').getBoundingClientRect();
					return { width:innerWidth, height:innerHeight, screenWidth:screen.width, screenHeight:screen.height, top:box.top, workspaceHeight:box.height, draft:document.getElementById('input').value };
				})()`);
				assert.ok(Math.abs(layout.width - layout.screenWidth) <= 1 && Math.abs(layout.height - layout.screenHeight) <= 1, 'native full screen covers the display: ' + JSON.stringify(layout));
				assert.equal(layout.top, 0); assert.equal(layout.workspaceHeight, layout.height);
				assert.equal(layout.draft, 'Keep this draft');
				await page.screenshot(path.join(shots, 'fullscreen-hidden.png'));
				await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:300, y:2 });
				await until('floating bar revealed', () => page.eval(`getComputedStyle(document.querySelector('.topbar')).opacity === '1' && document.querySelector('.topbar').getBoundingClientRect().top >= 8`));
				const bar = await page.eval(`(() => {
					const b = document.querySelector('.topbar'), css = getComputedStyle(b);
					return { position:css.position, region:css.getPropertyValue('-webkit-app-region'), radius:css.borderRadius, blur:css.backdropFilter, controls:[...b.querySelectorAll('.zc-win button')].map(x => x.getAttribute('aria-label')), top:document.querySelector('.coding-workspace').getBoundingClientRect().top };
				})()`);
				assert.equal(bar.position, 'fixed'); assert.equal(bar.region, 'no-drag');
				assert.equal(bar.radius, '14px'); assert.ok(bar.blur.includes('blur'));
				assert.deepEqual(bar.controls, ['Minimize', 'Exit full screen', 'Close']);
				assert.equal(bar.top, layout.top, 'revealing the bar does not move the chat');
				await page.screenshot(path.join(shots, 'fullscreen-revealed.png'));
				await page.send('Emulation.setEmulatedMedia', { features:[{ name:'prefers-reduced-motion', value:'reduce' }] });
				await until('reduced motion disables the floating bar animation', () => page.eval(`getComputedStyle(document.querySelector('.topbar')).transitionProperty === 'none'`));
				await page.send('Emulation.setEmulatedMedia', { features:[] });
				await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x:300, y:200 });
				await until('floating bar hides after leaving', () => page.eval(`getComputedStyle(document.querySelector('.topbar')).visibility === 'hidden'`));
				await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key:'F6', bubbles:true, cancelable:true }))`);
				await until('keyboard reaches controls', () => page.eval(`document.querySelector('.topbar').contains(document.activeElement) && getComputedStyle(document.querySelector('.topbar')).opacity === '1'`));
				await page.eval(`document.querySelector('.zc-max').click()`);
				await until('restore exits full screen', () => page.eval(`window.__zcShell.invoke('plugin:window|is_fullscreen').then(on => !on && !document.body.classList.contains('zc-native-fullscreen'))`));
				assert.equal(await page.eval(`document.getElementById('input').value`), 'Keep this draft');
				assert.ok(await page.eval(`!document.querySelector('.topbar').inert && getComputedStyle(document.querySelector('.topbar')).visibility === 'visible'`));
			} finally {
				await page.eval(`window.Bridge.post({ type:'fullscreen', on:false }); document.getElementById('input').value = '';`);
				await page.send('Emulation.setEmulatedMedia', { features:[] });
				await page.send('Emulation.setFocusEmulationEnabled', { enabled:false });
			}
		});

		await check('prompt rail previews safely, jumps during streaming and resets between chats', async () => {
			await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
			try {
			await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
			await page.eval(`(() => {
				window.__promptTestMessages = Array.from({ length: 60 }, (_, i) => [
					{ id: 'nav-u-' + i, role: 'user', content: i === 0 ? '<script>unsafe</script> Explore the project' : 'Prompt ' + (i + 1) + ': explain the next change', timestamp: Date.now() },
					{ id: 'nav-a-' + i, role: 'assistant', content: 'Response ' + (i + 1) + ': Here is the explanation.\\n\\n' + 'More details about the project. '.repeat(35), timestamp: Date.now() }
				]).flat();
				window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', currentSessionId: 'prompt-rail-test', messages: window.__promptTestMessages } }));
			})()`);
			await until('all prompt markers', () => page.eval(`document.querySelectorAll('.prompt-tick').length === 60 && !!document.querySelector('.prompt-tick[aria-current]')`));
			const preview = await page.eval(`(() => {
				const first = document.querySelector('.prompt-tick');
				first.focus({ preventScroll: true });
				return { title: document.getElementById('prompt-preview-title').textContent, answer: document.getElementById('prompt-preview-answer').textContent, injected: !!document.querySelector('#prompt-preview script') };
			})()`);
			assert.ok(preview.title.includes('<script>unsafe</script>'), JSON.stringify(preview));
			assert.ok(preview.answer.startsWith('Response 1:'));
			assert.strictEqual(preview.injected, false);
			await page.eval(`(() => {
				const rail = document.getElementById('prompt-nav'), first = document.querySelector('.prompt-tick');
				first.blur();
				first.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
			})()`);
			assert.ok(await page.eval(`!document.getElementById('prompt-preview').classList.contains('hidden')`), 'hover shows the preview');
			await page.eval(`document.getElementById('prompt-nav').dispatchEvent(new PointerEvent('pointerleave'))`);
			assert.ok(await page.eval(`document.getElementById('prompt-preview').classList.contains('hidden')`), 'leaving the rail hides the preview');
			await page.eval(`document.querySelector('.prompt-tick').focus({ preventScroll: true })`);
			await page.eval(`document.querySelector('.prompt-tick').click()`);
			await until('jump to first prompt', () => page.eval(`document.getElementById('messages').scrollTop < 30 && document.querySelector('.prompt-tick[aria-current]').dataset.promptId === 'nav-u-0'`));
			await page.eval(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', currentSessionId: 'prompt-rail-test', messages: window.__promptTestMessages, isStreaming: true, streaming: { text: 'Live answer for the last prompt', reasoning: '' } } }))`);
			assert.ok(await page.eval(`document.getElementById('messages').scrollTop < 30`), 'streaming updates keep the selected prompt in view');
			await page.eval(`(() => { const first = document.querySelector('.prompt-tick'); first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); })()`);
			assert.strictEqual(await page.eval(`document.activeElement.dataset.promptId`), 'nav-u-59');
			assert.ok(await page.eval(`document.getElementById('messages').scrollTop < 30`), 'keyboard preview only scrolls the rail');
			assert.strictEqual(await page.eval(`document.getElementById('prompt-preview-answer').textContent`), 'Live answer for the last prompt');
			await page.screenshot(path.join(shots, 'prompt-navigation.png'));
			const escaped = await page.eval(`(() => {
				const focusedPrompt = document.activeElement.dataset.promptId;
				const wasVisible = !document.getElementById('prompt-preview').classList.contains('hidden');
				const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
				document.activeElement.dispatchEvent(event);
				return { focusedPrompt, wasVisible, consumed:event.defaultPrevented, hidden:document.getElementById('prompt-preview').classList.contains('hidden') };
			})()`);
			assert.ok(escaped.consumed && escaped.hidden, 'Escape dismisses the preview before the chat stop shortcut: ' + JSON.stringify(escaped));
			await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 1, mobile: false });
			await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
			await until('preview fits narrow chat', () => page.eval(`(() => { const r = document.getElementById('prompt-preview').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= document.querySelector('.conversation').getBoundingClientRect().bottom; })()`));
			await page.screenshot(path.join(shots, 'prompt-navigation-narrow.png'));
			await page.send('Emulation.clearDeviceMetricsOverride');
			await page.eval(`window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', currentSessionId: 'empty-rail-test', messages: [] } })); delete window.__promptTestMessages;`);
			assert.ok(await page.eval(`document.getElementById('prompt-nav').classList.contains('hidden') && document.getElementById('prompt-preview').classList.contains('hidden') && !document.querySelector('.prompt-tick')`));
			} finally {
				await page.send('Emulation.clearDeviceMetricsOverride');
				await page.send('Emulation.setEmulatedMedia', { features: [] });
				await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
			}
		});

		await check('chat polish: real tool states, IME, keyboard menus, image zoom and responsive themes', () => require('./ui-polish-smoke')(page, shots, until));
		await check('Terminal appearance: palette, navigation, live shell settings and accessibility', () => require('./terminal-theme-smoke')(page, shots, until));
		await check('Hooks & Memory share one page with preserved controls, links and drafts', () => require('./hooks-memory-smoke')(page, shots, until));
		await check('OAuth recovery links and browser fallback work inside the real sign-in dialog', () => require('./oauth-recovery-smoke')(page, shots, until));

		await check('a crashed project page reloads itself; the engine keeps running', async () => {
			await page.send('Page.crash').catch(() => undefined);
			page.close();
			await sleep(1000);
			page = await connect(port, (u) => engine(u) && new URL(u).port === firstPort, 30000);
			await until('page back', () => page.eval("window.__zcDesktop === true && !!document.getElementById('session-title') && !!document.querySelector('.topbar .zc-win')"), 30000);
			const status = await page.eval(`window.__zcShell.invoke('host_status')`);
			assert.strictEqual(status.length, 1);
		});

		await check('switching projects keeps a serving router available; its engine retires after the router stops', async () => {
			const routerPort = await freePort();
			await page.eval(`window.addEventListener('message',e=>{if(e.data?.type==='localPlus')window.__routerSmokeHost=e.data.data.host}); window.Bridge.post({type:'localHostSet',patch:{enabled:true,port:${routerPort},lan:false}})`);
			await until('router serving',()=>page.eval(`window.__routerSmokeHost?.running && !!window.__routerSmokeHost.key`)).catch(async error => {
				console.log('Router diagnostics:', await page.eval(`JSON.stringify({host:window.__routerSmokeHost,statuses:[...document.querySelectorAll('[role="status"],.toast,.status')].map((n) => n.textContent.trim()).filter(Boolean).slice(-4)})`));
				throw error;
			});
			const routerKey=await page.eval(`window.__routerSmokeHost.key`);
			// A minimized window sizes the new project's view to 0×0 until it is restored.
			await restoreWindow();
			await page.eval(`void window.Bridge.post({ type: 'projectOpen', path: ${JSON.stringify(b)} }); 0`);
			await until('project B page', async () => {
				const pages = (await targets(port)).filter((t) => t.type === 'page' && engine(t.url)).map((t) => t.url);
				return pages.length === 2 && pages.some(u=>new URL(u).port!==firstPort) ? pages : null;
			}, 60000);
			const next=await connect(port,u=>engine(u)&&new URL(u).port!==firstPort);
			await next.send('Emulation.setFocusEmulationEnabled', { enabled:true });
			await next.send('Page.bringToFront');
			await restoreWindow(next);
			await until('new project viewport', () => next.eval("innerWidth >= 560")).catch(async error => {
				console.log('Activation diagnostics:', await next.eval("({width:innerWidth,visibility:document.visibilityState,boot:window.__zcShell.boot,activation:window.__zcActivationId,styles:document.body.style.cssText,offline:document.body.classList.contains('offline')})"));
				throw error;
			});
			await until('both project engines retained',()=>next.eval(`window.__zcShell.invoke('host_status').then(s=>s.length===2)`));
			const base=`http://127.0.0.1:${routerPort}/v1/models`;
			assert.equal((await fetch(base)).status,401);
			const response=await fetch(base,{headers:{Authorization:'Bearer '+routerKey}});
			assert.equal(response.status,200);assert.equal((await response.json()).object,'list');
			await page.eval(`void window.Bridge.post({type:'localHostSet',patch:{enabled:false}});0`).catch(()=>undefined);
			await until('stopped router project retires',async()=>{
				const pages=(await targets(port)).filter(t=>t.type==='page'&&engine(t.url));
				return pages.length===1&&new URL(pages[0].url).port!==firstPort;
			},60000);
			page.close();
			page = next;
			const status = await until('B on screen', () => page.eval(`window.__zcShell.invoke('host_status').then((s) => s.length === 1 ? s : null)`));
			assert.strictEqual(status[0].path.toLowerCase(), b.toLowerCase());
			const shown = await page.eval(`document.body.innerText.includes('PROJB') || document.body.innerText.includes('projB')`);
			assert.ok(shown, 'project B is shown');
			await until('panel sizes follow project switch', async () => {
				const widths=JSON.parse(fs.readFileSync(path.join(data,'data','global-state.json'),'utf8'))['zer0neDesktop.preferences']?.widths;
				if(widths?.sidebar!==343 || widths?.auxiliary!==377) return false;
				return page.eval(`(() => { const side=parseFloat(document.body.style.getPropertyValue('--zc-side-w')), aux=parseFloat(document.body.style.getPropertyValue('--zc-aux-w')); return innerWidth>=1160 ? side===343 && aux===377 : side>=280 && side<=343 && aux>=280 && aux<=377; })()`);
			}).catch(async error => {
				console.log('Panel size diagnostics:', await page.eval(`(() => { const info={width:innerWidth,rootWidth:document.documentElement.clientWidth,visibility:document.visibilityState,resizeObserver:typeof ResizeObserver,buttons:document.querySelectorAll('.zc-size-btn').length,side:document.body.style.getPropertyValue('--zc-side-w'),aux:document.body.style.getPropertyValue('--zc-aux-w')}; window.dispatchEvent(new Event('resize')); return {...info,afterResizeSide:document.body.style.getPropertyValue('--zc-side-w'),afterResizeAux:document.body.style.getPropertyValue('--zc-aux-w')}; })()`), JSON.parse(fs.readFileSync(path.join(data,'data','global-state.json'),'utf8'))['zer0neDesktop.preferences']);
				throw error;
			});
			await page.screenshot(path.join(shots, 'switched.png'));
		});

		await check('window state remembers the project folder', async () => {
			const state = JSON.parse(fs.readFileSync(path.join(data, 'window.json'), 'utf8'));
			assert.strictEqual(state.folder.toLowerCase(), b.toLowerCase());
			assert.strictEqual(state.recent[0].toLowerCase(), b.toLowerCase());
		});

		page.close();
		const enginePages = async () => (await targets(port)).filter((t) => t.type === 'page' && engine(t.url));
		const launchAgain = (folder) => new Promise((resolve) => spawn(exe, process.env.ZER0NE_APP_EXE ? [folder] : [root, folder], { env, stdio: 'ignore' }).once('exit', resolve));

		await check('launching again opens a second window; an open project is focused, not started twice', async () => {
			await launchAgain(a);
			await until('second window with project A', async () => (await enginePages()).length === 2, 60000);
			await launchAgain(b);
			await sleep(2500);
			assert.strictEqual((await enginePages()).length, 2, 'project B was already open: no third engine');
		});

		await check('closing one of two idle windows closes it; the last window hides to the tray', async () => {
			const pages = await enginePages();
			const pa = await connect(port, (u) => u === pages.find((p) => p.url !== pages[0].url || true).url);
			const shown = await pa.eval(`window.__zcShell.invoke('host_status').then((s) => s[0].path)`);
			await pa.eval(`setTimeout(() => window.__zcShell.invoke('plugin:window|close'), 50); 0`, 5000).catch(() => undefined);
			pa.close();
			await until('one window left', async () => (await enginePages()).length === 1, 15000);
			const last = await connect(port, engine);
			const other = await last.eval(`window.__zcShell.invoke('host_status').then((s) => s[0].path)`);
			assert.notStrictEqual(other.toLowerCase(), shown.toLowerCase(), 'the other window remains');
			await last.eval(`setTimeout(() => window.__zcShell.invoke('plugin:window|close'), 50); 0`, 5000).catch(() => undefined);
			await until('hidden, still running', () => last.eval('document.visibilityState === "hidden"'), 10000);
			assert.ok(alive(app.pid), 'the app keeps running in the tray');
			assert.strictEqual((await enginePages()).length, 1, 'its project keeps its engine');
			last.close();
		});

		await check('killing the app leaves no engine or helper process behind', async () => {
			const kids = descendants(app.pid);
			assert.ok(kids.length > 0, 'the app has child processes');
			expectedExit = true;
			app.kill();
			await until('all processes gone', async () => !alive(app.pid) && kids.every((p) => !alive(p)), 15000);
		});
	} catch (e) {
		failed++;
		console.log('FAIL ' + (failedCheck || 'app startup') + '\n' + (e && e.stack ? e.stack : e));
		const engineLog = path.join(data,'logs','engine.log');
		if (fs.existsSync(engineLog)) fs.copyFileSync(engineLog,path.join(shots,`app-${variant}-engine-failure.log`));
		fs.writeFileSync(path.join(shots, `app-${variant}-failure.json`), JSON.stringify({ check: failedCheck, error: String(e.stack || e), pid: app.pid, exitCode: app.exitCode, signal: app.signalCode, log: logFile, savedWindow: fs.existsSync(path.join(data, 'window.json')) ? JSON.parse(fs.readFileSync(path.join(data, 'window.json'), 'utf8')) : undefined }, null, 2));
		console.log('App diagnostics: ' + logFile);
	} finally {
		const cleanupPids = alive(app.pid) ? [app.pid, ...descendants(app.pid)] : [];
		expectedExit = true;
		if (alive(app.pid)) app.kill();
		hub.closeAllConnections();
		await new Promise(resolve => hub.close(resolve));
		sideModel.closeAllConnections();
		await new Promise(resolve => sideModel.close(resolve));
		await until('test app processes released their files', async () => cleanupPids.every(pid => !alive(pid)), 15000);
		fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
		fs.closeSync(log);
		releaseGui();
	}
	console.log(failed ? `${failed} app check(s) failed.` : 'App smoke test passed.');
	process.exit(failed ? 1 : 0);
})().catch(error => { console.error(error); process.exitCode = 1; });
