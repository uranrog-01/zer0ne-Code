// The Projects panel reads like the DeepSeek sidebar and keeps its footer actions.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { connect } = require('./cdp');

const root = path.join(__dirname, '..');
const shots = path.join(root, 'test', 'output');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
	return new Promise((resolve) => {
		const server = net.createServer().listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

(async () => {
	const releaseGui = require('./gui-lock').acquire();
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-panel-')));
	const data = path.join(base, 'appdata');
	const project = path.join(base, 'project');
	const other = path.join(base, 'other-project');
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(other);
	fs.writeFileSync(path.join(project, 'current-project.txt'), 'Current project file');
	fs.writeFileSync(path.join(other, 'other-project.txt'), 'Other project file');
	fs.mkdirSync(path.join(data, 'data'), { recursive: true });
	fs.writeFileSync(path.join(data, 'data', 'global-state.json'), JSON.stringify({ 'aiChat.projects': [project, other] }));
	fs.mkdirSync(shots, { recursive: true });
	const port = await freePort();
	const exe = process.env.ZER0NE_APP_EXE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
	const switches = ['--remote-debugging-port=' + port, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
	const args = process.env.ZER0NE_APP_EXE ? [...switches, project] : [...switches, root, project];
	const env = { ...process.env, ZER0NE_DATA_DIR: data, ZER0NE_DEBUG_PORT: String(port) };
	delete env.ELECTRON_RUN_AS_NODE;
	const log = fs.openSync(path.join(shots, 'projects-panel-app.log'), 'w');
	const app = spawn(exe, args, { env, stdio: ['ignore', log, log] });
	let page;
	const until = async (what, fn, ms = 20000) => {
		const end = Date.now() + ms;
		for (;;) {
			if (app.exitCode !== null) throw new Error(`app exited while waiting for ${what}`);
			const value = await fn().catch(() => undefined);
			if (value) return value;
			if (Date.now() > end) throw new Error('timed out: ' + what);
			await sleep(150);
		}
	};
	const step = async (name, fn) => {
		await fn();
		console.log('ok  ' + name);
	};
	try {
		page = await connect(port, (url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url), 60000);
		await page.send('Page.bringToFront');
		await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
		await until('engine active', () => page.eval(`window.__zcDesktop === true && !!document.getElementById('session-title')`));
		await sleep(350);
		await until('sidebar', () => page.eval(`document.body.classList.contains('desktop') && !document.getElementById('sidebar').classList.contains('hidden')`));
		await until('brand line', () => page.eval(`!!document.querySelector('#sidebar .zc-side-brand .zc-side-word')`));

		await step('the panel has the DeepSeek brand line and a filled New Project button', async () => {
			const view = await page.eval(`(() => {
				const brand = document.querySelector('#sidebar .zc-side-brand');
				const fresh = document.querySelector('#sidebar .zc-side-new');
				const style = getComputedStyle(fresh);
				return {
					word: brand?.querySelector('.zc-side-word')?.textContent,
					badge: brand?.querySelector('.zc-side-badge')?.textContent,
					logo: !!brand?.querySelector('.brand-logo'),
					label: fresh?.textContent.trim(),
					height: Math.round(fresh.getBoundingClientRect().height),
					background: style.backgroundColor,
					radius: style.borderRadius
				};
			})()`);
			assert.equal(view.word, 'zer0ne');
			assert.equal(view.badge, 'code');
			assert.strictEqual(view.logo, true);
			assert.ok(view.label.includes('New Project'), view.label);
			assert.ok(view.height >= 36, 'a full-width action, not a bare row: ' + view.height);
			assert.notEqual(view.background, 'rgba(0, 0, 0, 0)', 'the button has a surface');
			assert.match(view.radius, /9px/);
		});

		await step('the Projects section label and command search are back, quietly', async () => {
			const view = await page.eval(`(() => {
				const controls = document.querySelector('#sidebar .project-panel-controls');
				const command = controls?.querySelector('.project-command');
				return {
					display: getComputedStyle(controls).display,
					label: getComputedStyle(controls, '::before').content,
					command: !!command && getComputedStyle(command).display !== 'none',
					titleHidden: getComputedStyle(document.querySelector('#sidebar .sidebar-title')).clip !== 'auto'
				};
			})()`);
			assert.equal(view.display, 'flex');
			assert.ok(view.label.includes('Projects'), view.label);
			assert.strictEqual(view.command, true);
			assert.strictEqual(view.titleHidden, true, 'the visible title is the brand line; the engine title stays for screen readers');
		});

		await step('the footer keeps Settings, Remote, Notch and notifications at the bottom', async () => {
			const view = await page.eval(`(() => {
				const foot = document.querySelector('#sidebar .zc-side-foot');
				const buttons = ['.zc-settings', '.zc-remote', '.zc-notch', '.zc-bell'].map((selector) => foot?.querySelector(selector));
				const rect = foot?.getBoundingClientRect();
				return {
					rect: rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) } : null,
					innerHeight,
					visible: !!foot && getComputedStyle(foot).display !== 'none' && rect.height > 0 && rect.bottom <= innerHeight + 1,
					buttons: buttons.map((button) => {
						const r = button?.getBoundingClientRect();
						return !!button && !!r && r.width > 0 && r.height > 0 && getComputedStyle(button).visibility !== 'hidden';
					}),
					remoteLabel: foot.querySelector('.zc-remote')?.getAttribute('aria-label'),
					remoteIcon: !!foot.querySelector('.zc-remote svg'),
					labels: [...foot.querySelectorAll('button span')].map((span) => span.textContent.trim()).filter(Boolean)
				};
			})()`);
			assert.strictEqual(view.visible, true, 'the footer sits at the bottom of the visible panel: ' + JSON.stringify(view));
			assert.deepStrictEqual(view.buttons, [true, true, true, true]);
			assert.ok(view.labels.includes('Settings'), JSON.stringify(view.labels));
			assert.equal(view.remoteLabel, 'Remote'); assert.equal(view.remoteIcon, true);
			assert.equal(view.labels.includes('Remote'), false, 'Remote is an accessible icon without a visible label');
			if (await page.eval(`document.visibilityState === 'visible'`)) await page.screenshot(path.join(shots, 'projects-panel.png'));
		});

		await step('Archive / History replaces the size button and opens the chat library', async () => {
			assert.equal(await page.eval(`!!document.querySelector('#sidebar .zc-size-btn')`), false);
			await page.eval(`document.querySelector('.zc-archive-btn').click()`);
			await until('history open', () => page.eval(`document.getElementById('history').classList.contains('open') && document.querySelector('.zc-archive-btn').getAttribute('aria-expanded') === 'true'`));
			assert.equal(await page.eval(`[...document.querySelectorAll('#hl-tree .hl-tree-row')].some((row) => row.textContent.includes('All chats'))`), true, 'the library lists its views');
			// A real click focuses the button first; the drawer returns focus to its trigger.
			await page.eval(`document.getElementById('btn-history-close').focus(); document.getElementById('btn-history-close').click()`);
			await until('history closed', () => page.eval(`!document.getElementById('history').classList.contains('open')`));
			await until('history focus restored', () => page.eval(`document.activeElement === document.querySelector('.zc-archive-btn')`));
		});

		await step('project names and pins save through the real host', async () => {
			assert.equal(await page.eval(`document.querySelector('.project-row .project-tools').querySelectorAll('button').length`), 3);
			assert.equal(await page.eval(`!!document.querySelector('.project-row .project-show-files, .project-row .project-rename, .project-row .project-pin, .project-row .zc-remove')`), false);
			await page.eval(`document.querySelector('.project-folder-more').click()`);
			assert.equal(await page.eval(`document.activeElement.classList.contains('project-show-files')`), true);
			await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`);
			assert.equal(await page.eval(`document.activeElement.classList.contains('project-rename')`), true);
			await page.eval(`document.querySelector('.project-rename').click()`);
			await until('rename dialog', () => page.eval(`!!document.querySelector('dialog.project-action-dialog[open]')`));
			assert.equal(await page.eval(`document.activeElement.id`), 'project-action-name');
			await page.eval(`document.getElementById('project-action-name').value = 'My pinned project'; document.querySelector('.project-action-dialog form').requestSubmit()`);
			await until('renamed project', () => page.eval(`document.querySelector('.zc-project-title')?.textContent === 'My pinned project'`));
			await page.eval(`document.querySelector('.project-folder-more').click(); document.querySelector('.project-pin').click()`);
			await until('pinned project', () => page.eval(`!!document.querySelector('.project-group.project-pinned')`));
			await until('project metadata saved', async () => {
				const values = JSON.parse(fs.readFileSync(path.join(data, 'data/global-state.json'), 'utf8'));
				return Object.entries(values).some(([key, value]) => key.startsWith('zer0neDesktop.projectName.') && value === 'My pinned project') && Object.entries(values).some(([key, value]) => key.startsWith('zer0neDesktop.projectPinned.') && value === true);
			});
			await page.screenshot(path.join(shots, 'projects-pinned.png'));
			await page.eval(`document.querySelector('.project-folder-more').click()`);
			assert.equal(await page.eval(`document.querySelector('.project-pin').textContent.includes('Unpin project')`), true);
			await page.screenshot(path.join(shots, 'project-folder-menu.png'));
			await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
			assert.equal(await page.eval(`!document.querySelector('.project-folder-menu') && document.activeElement === document.querySelector('.project-folder-more') && document.activeElement.getAttribute('aria-expanded') === 'false'`), true);
			await page.eval(`document.querySelector('.project-folder-more').click(); document.body.click()`);
			assert.equal(await page.eval(`!document.querySelector('.project-folder-menu')`), true, 'clicking outside closes the menu');
		});

		await step('Show Files opens Work Details for the current project and across project switches', async () => {
			const firstPort = new URL(page.url).port;
			const show = async folder => {
				await page.eval(`(() => { const row=[...document.querySelectorAll('.project-row')].find(row => row.querySelector('.project-name')?.title === ${JSON.stringify(folder)}); row.querySelector('.project-folder-more').click(); document.querySelector('.project-folder-menu .project-show-files').click(); })()`);
			};
			const checkFiles = async expected => {
				await until(expected + ' in Work Details', () => page.eval(`!document.getElementById('auxiliary').classList.contains('hidden') && document.getElementById('aux-tab-explorer').getAttribute('aria-selected') === 'true' && [...document.querySelectorAll('#aux-explorer-tree .fs-name')].some(n => n.textContent === ${JSON.stringify(expected)})`)).catch(async error => {
					console.error('Work Details state:', await page.eval(`JSON.stringify({ url: location.href, width: innerWidth, hidden: document.getElementById('auxiliary').classList.contains('hidden'), tab: document.getElementById('aux-tab-explorer').getAttribute('aria-selected'), names: [...document.querySelectorAll('#aux-explorer-tree .fs-name')].map(n => n.textContent), tree: document.getElementById('aux-explorer-tree').textContent.slice(0, 300) })`).catch(String));
					throw error;
				});
				assert.equal(await page.eval(`document.getElementById('aux-explorer-filter').value`), '');
			};
			await page.eval(`document.getElementById('aux-tab-terminal').click(); document.getElementById('aux-explorer-filter').value='no-match'; document.getElementById('aux-explorer-filter').dispatchEvent(new Event('input',{bubbles:true})); if(!document.getElementById('auxiliary').classList.contains('hidden')) document.getElementById('btn-auxiliary').click()`);
			await show(project); await checkFiles('current-project.txt');
			await page.eval(`document.getElementById('btn-auxiliary').click()`);
			await show(project); await checkFiles('current-project.txt');
			await show(other); page.close();
			page = await connect(port, url => /^http:\/\/127\.0\.0\.1:\d+\//.test(url) && new URL(url).port !== firstPort, 60000);
			await checkFiles('other-project.txt');
			const otherPort = new URL(page.url).port;
			assert.equal(await page.eval(`document.getElementById('aux-explorer-tree').textContent.includes('current-project.txt')`), false);
			await show(project); page.close();
			page = await connect(port, url => /^http:\/\/127\.0\.0\.1:\d+\//.test(url) && new URL(url).port !== otherPort, 60000);
			await checkFiles('current-project.txt');
			await page.screenshot(path.join(shots, 'project-show-files.png'));
		});

		console.log('Projects panel passed.');
	} catch (error) {
		console.error(error);
		if (page) await page.screenshot(path.join(shots, 'projects-panel-failure.png')).catch(() => undefined);
		process.exitCode = 1;
	} finally {
		page?.close();
		app.kill();
		await sleep(800);
		try {
			fs.rmSync(base, { recursive: true, force: true });
		} catch {
			/* a process may still hold a file */
		}
		releaseGui();
	}
})();
