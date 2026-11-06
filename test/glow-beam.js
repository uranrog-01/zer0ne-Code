// The composer's handoff beam: a real canvas, a short draw, and a clean clear.
// This tests the renderer directly so a background test window cannot race app settings.
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
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'z0-beam-')));
	const data = path.join(base, 'appdata');
	const project = path.join(base, 'project');
	fs.mkdirSync(project, { recursive: true });
	fs.mkdirSync(path.join(data, 'data'), { recursive: true });
	fs.writeFileSync(path.join(data, 'data', 'global-state.json'), JSON.stringify({ 'aiChat.projects': [project] }));
	fs.mkdirSync(shots, { recursive: true });
	const port = await freePort();
	const exe = process.env.ZER0NE_APP_EXE || path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
	const switches = ['--remote-debugging-port=' + port, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
	const args = process.env.ZER0NE_APP_EXE ? [...switches, project] : [...switches, root, project];
	const env = { ...process.env, ZER0NE_DATA_DIR: data, ZER0NE_DEBUG_PORT: String(port) };
	delete env.ELECTRON_RUN_AS_NODE;
	const log = fs.openSync(path.join(shots, 'glow-beam-app.log'), 'w');
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
	const pixels = () =>
		page.eval(`(() => {
			const card = document.getElementById('input-card');
			const c = card && card.querySelector('canvas.beam-canvas');
			if (!c) return { canvas: false, lit: 0, maxA: 0, beam: card ? card.dataset.beam || null : null };
			const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
			let lit = 0;
			let maxA = 0;
			for (let i = 3; i < d.length; i += 4) if (d[i] > 0) { lit++; if (d[i] > maxA) maxA = d[i]; }
			return { canvas: true, w: c.width, h: c.height, lit, maxA, beam: card.dataset.beam || null };
		})()`);
	const ensureVisible = async () => {
		await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
		await page.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
		await page.send('Page.bringToFront').catch(() => {});
	};
	const flash = async (kind) => {
		await ensureVisible();
		await page.eval(`(() => { document.body.dataset.glow = 'subtle'; window.ComposerBeam.flash(document.getElementById('input-card'), ${JSON.stringify(kind)}); return true; })()`);
	};
	try {
		page = await connect(port, (url) => /^http:\/\/127\.0\.0\.1:\d+\//.test(url), 60000);
		await until('page ready', () => page.eval(`window.__zcDesktop === true && !!document.querySelector('.topbar .zc-win') && !!document.querySelector('#input-card canvas.beam-canvas')`));
		await ensureVisible();
		await page.eval(`window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));true`);

		await step('the beam canvas sits on the composer and the old ring is retired', async () => {
			const dimensions = () => page.eval(`(() => { const c=document.querySelector('#input-card canvas.beam-canvas');return {canvas:!!c,w:c?.width||0,h:c?.height||0}; })()`);
			await until('beam canvas sized', () => dimensions().then((r) => r.canvas && r.w > 300), 10000);
			const r = await dimensions();
			assert.strictEqual(r.canvas, true, 'beam.js attached a canvas');
			assert.ok(r.w > 300 && r.h >= 12, 'the canvas has the card width and reach: ' + r.w + '×' + r.h);
			assert.strictEqual(await page.eval(`document.body.classList.contains('beam-ready')`), true);
			assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('#input-card .streak')).opacity`), '0', 'the CSS fallback ring stays invisible');
		});

		await step('the focus beam draws, then clears itself', async () => {
			await flash('touch');
			await until('touch beam starts', () => page.eval(`document.getElementById('input-card').dataset.beam === 'touch'`));
			const r = await until('touch beam draws', async () => {
				const sample = await pixels();
				return sample.beam === 'touch' && sample.lit > 400 && sample.maxA > 30 ? sample : false;
			}, 2000);
			assert.strictEqual(r.beam, 'touch');
			assert.ok(r.lit > 400, 'the canvas has lit pixels: ' + r.lit);
			assert.ok(r.maxA > 30, 'the light is opaque enough: ' + r.maxA);
			await page.screenshot(path.join(shots, 'glow-beam.png'));
			await sleep(2600);
			const after = await pixels();
			assert.strictEqual(after.beam, null, 'the beam clears itself');
			assert.strictEqual(after.lit, 0, 'no pixel is left behind');
		});

		await step('the Enter beam draws a brighter sweep', async () => {
			await flash('sweep');
			await until('sweep beam starts', () => page.eval(`document.getElementById('input-card').dataset.beam === 'sweep'`));
			const r = await until('sweep beam draws', async () => {
				const sample = await pixels();
				return sample.beam === 'sweep' && sample.lit > 300 ? sample : false;
			}, 2000);
			assert.strictEqual(r.beam, 'sweep');
			assert.ok(r.lit > 300, 'the sweep has lit pixels: ' + r.lit);
			await page.screenshot(path.join(shots, 'glow-beam-sweep.png'));
			await sleep(2600);
			assert.strictEqual((await pixels()).lit, 0, 'the sweep clears itself');
		});

		await step('no page errors', async () => {
			assert.deepStrictEqual(await page.eval(`window.__errs`), []);
		});

		console.log('Glow beam passed.');
	} catch (error) {
		console.error(error);
		const engineLog = path.join(data, 'logs', 'engine.log');
		if (fs.existsSync(engineLog)) fs.copyFileSync(engineLog, path.join(shots, 'glow-beam-engine-failure.log'));
		if (page) await page.screenshot(path.join(shots, 'glow-beam-failure.png')).catch(() => undefined);
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
