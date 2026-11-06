/*
 * The tray icon's badge: a small dot in its corner that says what needs attention —
 * amber while a run waits for you, green while agents run, blue when notifications
 * are unread, nothing otherwise. Electron cannot draw on an image in the main process,
 * so a hidden sandboxed page composites the dot over the app icon with a canvas and
 * hands back PNGs; each variant is made once and cached.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, nativeImage } = require('electron');
const paths = require('./paths');

/** The dot's colours, matching the app's status colours: waiting, running, unread. */
const COLORS = { waiting: '#f59e0b', running: '#22c55e', unread: '#6ea8ff' };
/** The dot takes a third of the icon's side, sits near the corner, and carries a dark ring so it reads over any taskbar. */
const DOT = 0.34;
const RING = 2.5;
const INSET = 0.05;

/**
 * The hidden page's compositor: one icon, one job per state, PNG data URLs out.
 * Runs on about:blank (no CSP), so data: images load.
 */
const SCRIPT = `(async (icon, jobs) => {
	const load = (url) => new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = () => fail(new Error('icon decode failed')); i.src = url; });
	const img = await load(icon);
	const out = {};
	for (const [state, color] of jobs) {
		const c = document.createElement('canvas');
		c.width = img.naturalWidth; c.height = img.naturalHeight;
		const g = c.getContext('2d');
		g.drawImage(img, 0, 0);
		const s = Math.min(c.width, c.height);
		const d = s * ${DOT};
		const cx = c.width - d / 2 - s * ${INSET};
		const cy = s - d / 2 - s * ${INSET};
		g.beginPath(); g.arc(cx, cy, d / 2 + ${RING}, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,0.85)'; g.fill();
		g.beginPath(); g.arc(cx, cy, d / 2, 0, Math.PI * 2); g.fillStyle = color; g.fill();
		out[state] = c.toDataURL('image/png');
	}
	return out;
})`;

class TrayBadge {
	/** @param {nativeImage} base the plain icon the tray shows when nothing needs attention */
	constructor(base) {
		this.base = base;
		/** @type {BrowserWindow | null} */
		this.win = null;
		/** state → composited nativeImage, made once */
		this.cache = new Map();
		this.state = '';
		this.gen = 0;
	}

	ensure() {
		if (this.win && !this.win.isDestroyed()) return this.ready;
		this.win = new BrowserWindow({
			show: false,
			skipTaskbar: true,
			webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
		});
		this.ready = this.win.loadURL('about:blank').catch(() => undefined);
		return this.ready;
	}

	/** All the badge variants, made in one pass by the hidden page. */
	async compose(states) {
		await this.ensure();
		if (!this.win || this.win.isDestroyed()) throw new Error('the compositor page is gone');
		const icon = path.join(paths.appRoot(), 'assets', 'icon.png');
		const data = `data:image/png;base64,${fs.readFileSync(icon).toString('base64')}`;
		const jobs = states.map((state) => [state, COLORS[state]]);
		const made = await this.win.webContents.executeJavaScript(`(${SCRIPT})(${JSON.stringify(data)}, ${JSON.stringify(jobs)})`, false);
		for (const state of states) this.cache.set(state, nativeImage.createFromDataURL(made[state]));
	}

	/** Swap the tray icon for `state`'s badge ('' = plain); the newest request wins. */
	async apply(tray, state) {
		if (state === this.state) return;
		this.state = state;
		const gen = ++this.gen;
		try {
			if (state && !this.cache.has(state)) await this.compose([state]);
		} catch {
			return; // the plain icon stays; the tooltip still says what is happening
		}
		if (!tray || tray.isDestroyed() || gen !== this.gen) return;
		tray.setImage(state ? this.cache.get(state) : this.base);
	}
}

module.exports = { TrayBadge };
