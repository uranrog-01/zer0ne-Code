/*
 * One app window and the engines behind it. The window shows the start page in its
 * own view; every project gets an engine process (host/main.js on Electron's Node)
 * and its own page view on top. Switching projects reveals another retained view
 * only after its UI acknowledges readiness (zc_page_ready), so the screen never
 * blanks; a project left behind keeps running while it has an agent run, a
 * terminal command or Mobile Remote, and idle ones retire. Engines serve their UI on
 * 127.0.0.1 and ask the shell for what only it can do (ops.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { app, BaseWindow, WebContentsView, Menu, safeStorage, clipboard, dialog, shell, screen } = require('electron');
const paths = require('./paths');
const { readAppearance } = require('./appearance');
const ops = require('./ops');
const glass = require('./glass');
const { PanelGlass } = require('./panel-glass');
const { engineKey } = require('./keychain');
const { PROTOCOL } = require('../host/protocol');

const PRELOAD = path.join(__dirname, 'preload.js');
const ACTIVATION_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 3000;
const LOG_LIMIT = 5_000_000;
/** A background engine quiet for this long is retired to free its memory; opening the project starts fresh. */
const IDLE_RETIRE_MS = 10 * 60_000;
const IDLE_SWEEP_MS = 60_000;
/** Under this much free RAM (or share of it), a quiet engine is retired at the next sweep. */
const MEMORY_PRESSURE_FREE_KB = 1.5 * 1024 * 1024;
const MEMORY_PRESSURE_RATIO = 0.1;

/** The registry key of a folder: absolute, case-insensitive on Windows (like the engine's projectPathKey). */
function folderKey(folder) {
	if (!folder) return '';
	let p = path.resolve(folder);
	try {
		p = fs.realpathSync.native(p);
	} catch {
		// A folder that disappeared keeps its spelling.
	}
	return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isDir(p) {
	try {
		return !!p && fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

const nameOf = (folder) => (folder ? path.basename(folder) : null);
const formatDuration = (ms) => {
	const s = Math.max(1, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const mins = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
};

/** The share of a run's task budget that, once spent, the notch warns about. */
const BUDGET_WARN = 0.8;
const count = (n) => (Number.isInteger(n) && n > 0 ? Math.min(n, 999) : 0);
const amount = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/** What an engine says about a run's budget, agents, result and cloud tasks, kept to its shape. */
function cleanBudget(b) {
	if (!b || typeof b !== 'object' || !['cost', 'tokens'].includes(b.kind)) return null;
	const cache = Number.isInteger(b.cache) && b.cache >= 0 && b.cache <= 100 ? b.cache : null;
	return { kind: b.kind, spent: amount(b.spent), limit: amount(b.limit), cache };
}

function cleanAgents(a) {
	if (!a || typeof a !== 'object' || !count(a.total)) return null;
	return { workflow: a.workflow === true, total: count(a.total), running: count(a.running), queued: count(a.queued), done: count(a.done), failed: count(a.failed), review: ['running', 'pass', 'changes', 'blocked', 'failed'].includes(a.review) ? a.review : null };
}

function cleanGoal(g) {
	if (!g || typeof g !== 'object' || typeof g.objective !== 'string' || !count(g.max)) return null;
	return { objective: g.objective.slice(0, 160), rounds: Math.min(count(g.rounds), count(g.max)), max: count(g.max), check: typeof g.check === 'string' ? g.check.slice(0, 80) : null };
}

/** A pending approval the notch can answer: its id and what it would run or change. */
function cleanApproval(a) {
	if (!a || typeof a !== 'object' || typeof a.id !== 'string' || !a.id || a.id.length > 200) return null;
	return { id: a.id, kind: ['command', 'mcp', 'write', 'edit', 'patch'].includes(a.kind) ? a.kind : 'edit', text: String(a.text || '').slice(0, 2000), sandboxed: a.sandboxed === true, escalate: a.escalate === true, rule: a.rule === 'ask' || a.rule === 'pending' ? a.rule : null };
}

function cleanQuestion(q) {
	if (!q || typeof q !== 'object' || typeof q.id !== 'string' || !q.id || q.id.length > 200) return null;
	return { id: q.id, text: String(q.text || '').slice(0, 600), options: (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o === 'string' && o.trim()).slice(0, 6).map((o) => o.slice(0, 120)) };
}

function cleanHealth(h) {
	if (!h || typeof h !== 'object') return null;
	const context = Number.isInteger(h.context) && h.context >= 0 && h.context <= 100 ? h.context : null;
	const checks = ['passed', 'failed', 'running'].includes(h.checks) ? h.checks : null;
	const files = count(h.files);
	return files || checks || context !== null ? { files, checks, context } : null;
}

function cleanResult(x) {
	if (!x || typeof x !== 'object') return null;
	return { files: count(x.files), added: Number.isInteger(x.added) && x.added > 0 ? x.added : 0, removed: Number.isInteger(x.removed) && x.removed > 0 ? x.removed : 0, tests: ['passed', 'failed'].includes(x.tests) ? x.tests : null, review: ['pass', 'changes', 'blocked'].includes(x.review) ? x.review : null };
}

/** Links are kept only when they lead to GitHub: the notch opens them in the browser. */
const github = (u) => (typeof u === 'string' && /^https:\/\/github\.com\/[^\s]+$/.test(u) && u.length < 600 ? u : null);

function cleanCloud(list) {
	if (!Array.isArray(list)) return [];
	return list.slice(0, 5).filter((t) => t && typeof t.id === 'string' && /^[\w-]{1,80}$/.test(t.id)).map((t) => ({
		id: t.id,
		task: String(t.task || 'Cloud task').slice(0, 120),
		status: ['dispatching', 'queued', 'in_progress', 'completed', 'failed'].includes(t.status) ? t.status : 'queued',
		done: count(t.done),
		total: count(t.total),
		since: amount(t.since) || Date.now(),
		prUrl: github(t.prUrl),
		runUrl: github(t.runUrl)
	}));
}

/** An engine may be stopped only when nothing needs it. */
function idleRetirable(shown, pending, busy, remote, terminal, router, cloud) {
	return !shown && !pending && !busy && !remote && !terminal && !router && !cloud;
}

/**
 * The timed sweep's rule: idle in every way idleRetirable checks, and quiet
 * for IDLE_RETIRE_MS (or retired at once when the machine is short of memory).
 * The event-driven calls keep their no-age behavior; only the sweep reads this,
 * so an engine just used is never taken by anything else.
 */
function retirableNow(r, shown, pending, now, pressure = false) {
	return (pressure || now - r.lastTouch >= IDLE_RETIRE_MS) && idleRetirable(shown, pending, r.busy, r.remote, r.terminal, r.router, r.cloud);
}

/** Electron reports system memory in KB; no API (plain Node tests) means no pressure. */
function memoryPressure() {
	try {
		const info = process.getSystemMemoryInfo?.();
		if (!info || !(info.total > 0)) return false;
		return info.free < MEMORY_PRESSURE_FREE_KB || info.free / info.total < MEMORY_PRESSURE_RATIO;
	} catch {
		return false;
	}
}

/** The engine log: all engines share one file, kept under 5 MB. */
function trimEngineLog() {
	const file = path.join(paths.logDir(), 'engine.log');
	try {
		if (fs.statSync(file).size > LOG_LIMIT) fs.truncateSync(file, 0);
	} catch {
		// No log yet.
	}
}

function logStream() {
	const dir = paths.logDir();
	fs.mkdirSync(dir, { recursive: true });
	trimEngineLog();
	return fs.createWriteStream(path.join(dir, 'engine.log'), { flags: 'a' });
}

/** Right-click menu for text: what the system webview offered. */
function attachContextMenu(contents) {
	contents.on('context-menu', (_e, p) => {
		const items = [];
		if (p.isEditable) {
			items.push({ role: 'undo', enabled: p.editFlags.canUndo }, { role: 'redo', enabled: p.editFlags.canRedo }, { type: 'separator' });
			items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' });
			if (p.misspelledWord && p.dictionarySuggestions.length) {
				items.unshift(...p.dictionarySuggestions.slice(0, 5).map((s) => ({ label: s, click: () => contents.replaceMisspelling(s) })), { type: 'separator' });
			}
		} else if (p.selectionText && p.selectionText.trim()) {
			items.push({ role: 'copy' });
		}
		if (p.linkURL && /^https?:/i.test(p.linkURL)) items.push({ label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) });
		if (items.length) Menu.buildFromTemplate(items).popup();
	});
}

/** Ctrl +/-/0 zoom (the menu-less window has no accelerators), and DevTools in development. */
function attachKeys(contents, devtools) {
	contents.on('before-input-event', (e, input) => {
		if (input.type !== 'keyDown') return;
		const mod = process.platform === 'darwin' ? input.meta : input.control;
		if (mod && !input.alt && (input.key === '=' || input.key === '+')) {
			contents.setZoomLevel(Math.min(5, contents.getZoomLevel() + 0.5));
			e.preventDefault();
		} else if (mod && !input.alt && input.key === '-') {
			contents.setZoomLevel(Math.max(-3, contents.getZoomLevel() - 0.5));
			e.preventDefault();
		} else if (mod && !input.alt && input.key === '0') {
			contents.setZoomLevel(0);
			e.preventDefault();
		} else if (devtools && (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i'))) {
			contents.toggleDevTools();
			e.preventDefault();
		}
	});
}

let windowSeq = 0;

class EngineWindow {
	/**
	 * @param {import('./main').Shell} shell
	 */
	constructor(shell) {
		this.shell = shell;
		this.id = `${process.pid}-${++windowSeq}`;
		/** @type {Map<string, any>} engines by folder key */
		this.engines = new Map();
		/** Engine keys, most recently shown first. */
		this.order = [];
		/** A booting or waking engine that takes the screen once its page says it is ready. */
		this.pending = null;
		this.activations = 0;
		/** The engine on screen (null: the start page). */
		this.active = null;
		/** The folder and port the window shows. */
		this.folder = null;
		this.port = 0;
		this.fsMaximized = false;
		this.fullscreen = false;
		this.rebuilding = false;
		this.transparent = glass.transparentSupported() && shell.transparency > 0;
		// Engines are retired on events (a run ends, a router stops); a hidden window's idle
		// background engines see no event, so a sweep frees them after IDLE_RETIRE_MS.
		this.idleSweep = setInterval(() => this.retireIdle('', true), IDLE_SWEEP_MS);
		this.idleSweep.unref?.();

		this.createWindow();
		this.startView = this.makeView();
		this.win.contentView.addChildView(this.startView);
		this.guardStart(this.startView.webContents);
		this.layout();
	}

	/**
	 * Build the native window. Electron fixes `transparent` at creation, so a change of the
	 * glass mode swaps the window (rebuildWindow); the views belong to this EngineWindow.
	 */
	createWindow() {
		const st = this.shell.state;
		const win = new BaseWindow({
			width: Math.round(st.width || 1280),
			height: Math.round(st.height || 860),
			minWidth: 560,
			minHeight: 480,
			frame: false,
			transparent: this.transparent,
			backgroundColor: this.transparent ? '#00000000' : '#161616',
			show: false,
			title: 'zer0ne Code',
			icon: path.join(paths.appRoot(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
		});
		this.win = win;
		this.panelGlass = new PanelGlass(win);
		// A replaced window can still deliver events while it is being torn down.
		const live = () => this.win === win && !win.isDestroyed();
		win.on('resize', () => {
			if (!live()) return;
			this.layout();
			this.shell.syncIcons();
		});
		win.on('enter-full-screen', () => {
			if (!live()) return;
			this.fullscreen = true;
			this.evalActive('window.__zcSetFullscreen && window.__zcSetFullscreen(true);');
			this.shell.syncIcons();
		});
		win.on('leave-full-screen', () => {
			if (!live()) return;
			this.fullscreen = false;
			this.evalActive('window.__zcSetFullscreen && window.__zcSetFullscreen(false);');
			this.shell.syncIcons();
		});
		for (const ev of ['minimize', 'show', 'hide', 'maximize', 'unmaximize']) win.on(ev, () => { if (live()) this.shell.syncIcons(); });
		for (const ev of ['minimize', 'hide', 'closed']) win.on(ev, () => { if (live()) this.cancelReveal(); });
		// The notch skips the project you are looking at (Settings → Notch), so it follows focus.
		for (const ev of ['focus', 'blur', 'minimize', 'restore', 'show', 'hide']) win.on(ev, () => { if (live()) this.shell.notch.refresh(); });
		win.on('restore', () => { if (live()) this.reveal(); });
		win.on('focus', () => {
			if (!live()) return;
			this.shell.lastFocused = this;
			this.focusPage();
		});
		win.on('close', (e) => {
			if (!live()) return;
			this.rememberSize();
			if (!this.shell.quitting) {
				e.preventDefault();
				this.shell.windowClosing(this);
			}
		});
		win.on('closed', () => {
			if (!live()) return;
			this.panelGlass.dispose();
			this.closeViews();
			this.shell.windowClosed(this);
		});
		// A transparent frameless window ignores a title-bar double-click; maximize it here.
		if (process.platform === 'win32') {
			win.hookWindowMessage(0x00a3 /* WM_NCLBUTTONDBLCLK */, (wParam) => {
				if (live() && wParam.readUInt32LE(0) === 2 /* HTCAPTION */) this.toggleMaximize();
			});
			win.hookWindowMessage(0x0112 /* WM_SYSCOMMAND */, (wParam) => {
				if (live() && (wParam.readUInt32LE(0) & 0xfff0) === 0xf120 /* SC_RESTORE */) this.requestReveal();
			});
		}
		return win;
	}

	/** Follow a glass-mode change (Settings → Liquid Glass): opaque at 0%, see-through above it. */
	setGlassMode() {
		const transparent = glass.transparentSupported() && this.shell.transparency > 0;
		if (transparent === this.transparent) return;
		this.transparent = transparent;
		this.rebuildWindow();
	}

	/** Swap the window for one with the current transparency, keeping its views and state. */
	rebuildWindow() {
		if (!this.win || this.win.isDestroyed() || this.rebuilding) return;
		this.rebuilding = true;
		const old = this.win;
		const bounds = old.getBounds();
		const maximized = this.isMaximized();
		const fullscreen = this.isFullscreen();
		const shown = old.isVisible();
		const minimized = old.isMinimized();
		const focused = old.isFocused();
		const views = [this.startView, ...[...this.engines.values()].map((r) => r.view)].filter(Boolean);
		for (const view of views) old.contentView.removeChildView(view);
		this.panelGlass.dispose();
		try {
			this.createWindow();
			for (const view of views) this.win.contentView.addChildView(view);
			this.win.setBounds(bounds);
			if (shown) this.win.show();
			if (fullscreen) this.win.setFullScreen(true);
			else if (maximized) this.win.maximize();
			if (minimized) this.win.minimize();
			this.layout();
			if (shown && focused) {
				this.win.focus();
				this.focusPage();
			}
			this.shell.syncIcons();
			this.shell.notch.refresh();
		} finally {
			this.rebuilding = false;
		}
		old.destroy();
	}

	focusPage() {
		const contents = (this.active ? this.active.view : this.startView)?.webContents;
		if (contents && !contents.isDestroyed()) contents.focus();
	}

	/** A taskbar restore can arrive before the transparent window's visibility catches up. */
	requestReveal() {
		if (this.revealPending || this.revealing) return;
		this.revealPending = setImmediate(() => {
			this.revealPending = null;
			if (!this.win.isDestroyed()) this.reveal();
		});
	}

	cancelReveal() {
		if (this.revealPending) clearImmediate(this.revealPending);
		this.revealPending = null;
	}

	/** Restore the native window and its retained page together, without changing its size. */
	reveal(focus = true) {
		if (this.win.isDestroyed() || this.revealing) return;
		this.revealing = true;
		try {
			if (this.win.isMinimized()) this.win.restore();
			if (focus) this.win.show();
			else if (!this.win.isVisible()) this.win.showInactive();
			this.layout();
			if (focus) { this.win.focus(); this.focusPage(); }
			this.shell.syncIcons();
		} finally { this.revealing = false; }
	}

	makeView() {
		const view = new WebContentsView({ webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true } });
		if (this.transparent) view.setBackgroundColor('#00000000');
		attachContextMenu(view.webContents);
		attachKeys(view.webContents, this.shell.devtools);
		this.shell.views.set(view.webContents.id, this);
		return view;
	}

	/** The start page may show itself; any other link leaves the app (applet window or browser). */
	guardStart(contents) {
		contents.on('will-navigate', (e, url) => {
			if (url.split('#')[0] === this.shell.startUrl()) return;
			e.preventDefault();
			this.route(url, this.folder);
		});
		contents.setWindowOpenHandler(({ url }) => {
			this.route(url, this.folder);
			return { action: 'deny' };
		});
	}

	/** Local pages become applet windows, everything else opens in the system browser. */
	route(url, folder) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch {
			return;
		}
		if (parsed.protocol === 'http:' && ops.isLoopbackHost(parsed.hostname)) {
			try {
				ops.openApplet(parsed.href, folder);
			} catch {
				// Not a local page after all.
			}
		} else ops.openExternal(url);
	}

	/** One engine page: its own origin stays inside; everything else is routed out. */
	guardEngine(contents, r) {
		const own = (url) => {
			try {
				const u = new URL(url);
				return u.protocol === 'about:' || (u.protocol === 'http:' && ops.isLoopbackHost(u.hostname) && Number(u.port) === r.port);
			} catch {
				return false;
			}
		};
		contents.on('will-navigate', (e, url) => {
			if (own(url)) return;
			e.preventDefault();
			this.route(url, r.folder);
		});
		contents.on('will-redirect', (e, url) => {
			if (own(url)) return;
			e.preventDefault();
		});
		contents.setWindowOpenHandler(({ url }) => {
			this.route(url, r.folder);
			return { action: 'deny' };
		});
	}

	size() {
		const [width, height] = this.win.getContentSize();
		return { width: Math.max(1, width), height: Math.max(1, height) };
	}

	offscreen() {
		const { width, height } = this.size();
		return { x: -width - 32, y: 0, width, height };
	}

	/** Keep the page on screen (and the prepared ones beside it) sized to the window. */
	layout() {
		const { width, height } = this.size();
		const full = { x: 0, y: 0, width, height };
		if (this.startView) this.startView.setBounds(full);
		for (const r of this.engines.values()) {
			if (!r.view) continue;
			r.view.setBounds(r === this.active ? full : this.offscreen());
		}
	}

	rememberSize() {
		if (this.win.isDestroyed() || this.isFullscreen()) return;
		const st = this.shell.state;
		st.maximized = this.isMaximized();
		if (!st.maximized) {
			const [width, height] = this.win.getSize();
			st.width = width;
			st.height = height;
		}
		this.shell.saveState();
	}

	toggleMaximize() {
		if (this.isFullscreen()) {
			this.setFullscreen(false);
			return;
		}
		if (this.isMaximized()) {
			this.win.unmaximize();
			// A transparent window only took the work area's bounds; put its own size back.
			if (this.isMaximized()) this.win.setBounds(this.restoreBounds || this.centeredBounds());
		} else {
			this.restoreBounds = this.win.getBounds();
			this.win.maximize();
		}
	}

	/**
	 * Windows never reports a transparent frameless window as maximized: maximize() only gives
	 * it the work area's bounds. Filling the work area counts as maximized here.
	 */
	isMaximized() {
		if (this.win.isMaximized()) return true;
		if (!this.transparent || this.win.isFullScreen()) return false;
		const b = this.win.getBounds(), a = screen.getDisplayMatching(b).workArea;
		return Math.abs(b.x - a.x) <= 2 && Math.abs(b.y - a.y) <= 2 && Math.abs(b.width - a.width) <= 2 && Math.abs(b.height - a.height) <= 2;
	}

	/** The remembered window size, centered in the work area (restoring a window that started maximized). */
	centeredBounds() {
		const a = screen.getDisplayMatching(this.win.getBounds()).workArea;
		const st = this.shell.state;
		const width = Math.min(a.width, Math.round(st.width && st.width < a.width - 8 ? st.width : 1280));
		const height = Math.min(a.height, Math.round(st.height && st.height < a.height - 8 ? st.height : 860));
		return { x: a.x + Math.round((a.width - width) / 2), y: a.y + Math.round((a.height - height) / 2), width, height };
	}

	isFullscreen() {
		// Electron's transparent Windows fullscreen changes the monitor bounds without setting
		// isFullScreen(). Keep its enter/leave state for restore, activation and saved window size.
		return this.win.isFullScreen() || (process.platform === 'win32' && this.transparent && this.fullscreen);
	}

	/** A maximized window keeps the taskbar visible, so full screen starts from the restored size. */
	setFullscreen(on) {
		if (on === this.isFullscreen()) return on;
		if (on) {
			this.rememberSize();
			if (this.isMaximized()) {
				this.fsMaximized = true;
				this.win.unmaximize();
			}
			this.fullscreen = true;
			this.win.setFullScreen(true);
		} else {
			this.fullscreen = false;
			this.win.setFullScreen(false);
			if (this.fsMaximized) {
				this.fsMaximized = false;
				this.win.maximize();
			}
		}
		this.evalActive(`window.__zcSetFullscreen && window.__zcSetFullscreen(${on ? 'true' : 'false'});`);
		this.shell.syncIcons();
		return on;
	}

	setTitle(folder, busy) {
		if (this.win.isDestroyed()) return;
		const name = nameOf(folder);
		this.win.setTitle(name ? `${busy ? '● ' : ''}${name} — zer0ne Code` : 'zer0ne Code');
	}

	/** Run JavaScript in the page on screen (an engine page, else the start page). */
	evalActive(js) {
		const view = this.active && this.active.view ? this.active.view : this.startView;
		if (!view || view.webContents.isDestroyed()) return;
		view.webContents.executeJavaScript(js, false).catch(() => undefined);
	}

	note(text) {
		this.evalActive(`window.__zcNote && window.__zcNote(${JSON.stringify(String(text))});`);
	}

	/**
	 * The start page is only needed while no project page is on screen: keeping it loaded for
	 * a project's whole session costs a renderer. It is made again (and reloaded) on demand.
	 */
	ensureStartView() {
		if (this.startView && !this.startView.webContents.isDestroyed()) return this.startView;
		this.startView = this.makeView();
		this.guardStart(this.startView.webContents);
		this.win.contentView.addChildView(this.startView);
		this.startView.setVisible(!this.active);
		this.layout();
		return this.startView;
	}

	releaseStartView() {
		const view = this.startView;
		if (!view) return;
		this.startView = null;
		try {
			this.win.contentView.removeChildView(view);
		} catch {
			// The window is closing.
		}
		this.shell.views.delete(view.webContents.id);
		if (!view.webContents.isDestroyed()) view.webContents.close();
	}

	/** Put the start page on screen; with an error it explains and offers Retry. */
	showStartPage(error) {
		const hash = error ? 'error=' + encodeURIComponent(error) : '';
		const start = this.ensureStartView();
		const load = this.startLoad = (this.startLoad || 0) + 1;
		void start.webContents.loadFile(this.shell.startFile(), { hash }).catch(() => undefined).finally(() => {
			if (load === this.startLoad && this.initialShowPending && !this.win.isDestroyed()) {
				this.initialShowPending = false;
				if (this.shell.state.maximized) this.win.maximize();
				this.win.show();
			}
		});
		this.revealStart();
		this.shell.syncIcons();
	}

	revealStart() {
		this.panelGlass.clear();
		if (this.active && this.active.view) this.active.view.setVisible(false);
		this.active = null;
		this.ensureStartView().setVisible(true);
	}

	isShown(key) {
		return folderKey(this.folder) === key;
	}

	hasLiveShown() {
		return this.engines.has(folderKey(this.folder));
	}

	/** Which projects have an agent run in flight (the sidebar's working hints). */
	status() {
		return [...this.engines.values()].map((r) => ({ path: r.folder || '', busy: r.busy, sessionId: r.session, activity: r.activity }));
	}

	/** Engines that must outlive a hidden window: running agents and cloud tasks, terminals or Mobile Remote. */
	retainsWork() {
		return [...this.engines.values()].some((r) => r.busy || r.terminal || r.remote || r.router || r.cloud);
	}

	select(key) {
		const activationId = String(++this.activations);
		this.pending = { key, activationId, viewId: null };
		return activationId;
	}

	cancelActivation(activationId) {
		if (this.pending && this.pending.activationId === activationId) this.pending = null;
	}

	reorder(key) {
		this.order = [key, ...this.order.filter((k) => k !== key)];
	}

	/** Show `folder` in this window: wake its engine or start one. */
	activate(folder, handoff) {
		const key = folderKey(folder);
		const running = this.engines.get(key);
		if (running) this.show(running, handoff);
		else this.spawn(folder, key, handoff);
		const p = this.pending;
		if (p) {
			setTimeout(() => {
				if (this.pending && this.pending.activationId === p.activationId) {
					this.cancelActivation(p.activationId);
					if (this.hasLiveShown()) this.note('Project opening timed out. Try opening it again.');
					else this.showStartPage('Project opening timed out. Try again.');
					this.retireIdle('');
				}
			}, ACTIVATION_TIMEOUT_MS).unref();
		}
	}

	/** The start page's Retry: the engine of `folder` from scratch. */
	restart(folder) {
		const r = this.engines.get(folderKey(folder));
		if (r) this.retire(r);
		this.activate(folder, null);
	}

	/** Switch this window to a folder (none = ask), or open it in a new window. */
	async openFolder(p, newWindow, handoff) {
		if (handoff?.kind === 'project' && !isDir(p)) throw new Error('The selected folder is unavailable. Choose it again.');
		const folder = isDir(p) ? path.resolve(p) : await ops.pickFolder(this.win);
		if (!folder) return;
		if (newWindow) {
			this.shell.openWindow(folder);
			return;
		}
		this.shell.state.setFolder(folder);
		this.shell.saveState();
		this.activate(folder, handoff);
	}

	/** Put an already running engine on screen. */
	show(r, handoff) {
		if (this.shell.deletingFolder && r.folder && require('./project-folders').contains(this.shell.deletingFolder, folderKey(r.folder))) { this.note('Finish deleting this project before opening it.'); return; }
		if (!this.engines.has(r.key)) return; // retired in between
		this.reorder(r.key);
		const activationId = this.select(r.key);
		if (r.port && r.url) this.prepareView(r, activationId);
		this.send(r, { t: 'activate', handoff: handoff || null, activationId });
		// The old page, port, folder and title stay until the new page acknowledges.
	}

	/** Start a fresh engine. Another project on screen stays exactly as it is while this one boots. */
	spawn(folder, key, handoff) {
		if (this.shell.deletingFolder && folder && require('./project-folders').contains(this.shell.deletingFolder, folderKey(folder))) { this.note('Finish deleting this project before opening it.'); return; }
		this.retireIdle(key);
		const activationId = this.select(key);
		this.reorder(key);
		const keepsScreen = this.hasLiveShown();
		if (keepsScreen) this.note(`Opening ${nameOf(folder) || 'the project'}…`);
		else {
			this.port = 0;
			this.folder = folder || null;
			this.showStartPage(null);
			this.setTitle(folder, false);
		}
		const fail = (message) => {
			this.cancelActivation(activationId);
			if (keepsScreen) this.note(message);
			else this.showStartPage(message);
		};

		const root = paths.appRoot();
		try { if (app?.isPackaged) require('./integrity').verifyInstalled(); }
		catch (error) { fail(error.message); return; }
		const script = path.join(root, 'host', 'main.js');
		const engine = path.join(root, 'engine');
		const data = paths.dataDir();
		fs.mkdirSync(data, { recursive: true });
		if (!fs.existsSync(path.join(engine, 'out', 'chatController.js'))) {
			fail(`The engine is missing at ${engine} — run "npm run engine" and start again.`);
			return;
		}
		let key64;
		try {
			key64 = engineKey(data, safeStorage);
		} catch (e) {
			fail(e.message);
			return;
		}
		let child;
		try {
			child = spawn(process.execPath, [script], {
				cwd: folder || root,
				// Electron runs the engine as plain Node; host/main.js clears the flag for everything it starts.
				env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_DESKTOP: '1', ZER0NE_WINDOW_ID: this.id },
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true
			});
		} catch (e) {
			fail(`Could not start the engine: ${e.message}`);
			return;
		}
		const r = { key, folder: folder || null, child, port: 0, url: null, view: null, busy: false, remote: false, terminal: false, router: false, busySince: 0, lastTouch: Date.now(), session: null, activity: 'idle', stopping: false, exited: false };
		this.engines.set(key, r);
		this.shell.refreshTray?.();
		child.on('error', (e) => {
			if (r.exited) return;
			r.exited = true;
			this.retire(r);
			fail(`Could not start the engine: ${e.message}`);
		});
		child.stdin.on('error', () => undefined);
		const log = logStream();
		child.stderr.pipe(log);
		readline.createInterface({ input: child.stdout }).on('line', (line) => {
			let msg;
			try {
				msg = JSON.parse(line);
			} catch {
				return;
			}
			this.onMessage(r, msg);
		});
		child.on('exit', (code, signal) => {
			r.exited = true;
			this.onExit(r, code, signal);
		});
		r.bootMessages = [{ t: 'activate', handoff: handoff || null, activationId }];
		r.bootPending = true;
		r.bootRelease = require('./startup-queue').queueEngineStartup(release => {
			if (r.stopping || r.exited) { release(); return; }
			r.bootPending = false;
			r.bootTimer = setTimeout(() => { if (!r.port && !r.stopping && !r.exited) { this.retire(r); fail('This project took too long to start. Retry opening it.'); } }, 120000);
			r.bootTimer.unref?.();
			this.send(r, { t: 'init', engineDir: engine, dataDir: data, workspace: folder || null, key: key64 });
			for (const message of r.bootMessages.splice(0)) this.send(r, message);
		});
	}

	/** What the notch asks of this project's agent (host.notchAct checks it again). */
	notchAct(r, act) {
		this.send(r, { t: 'notch', act });
	}

	send(r, obj) {
		if (r.bootPending && obj.t !== 'shutdown') { r.bootMessages.push(obj); return; }
		try {
			if (r.child && r.child.stdin.writable) r.child.stdin.write(JSON.stringify(obj) + '\n');
		} catch {
			// The engine is exiting.
		}
	}

	onMessage(r, msg) {
		r.lastTouch = Date.now();
		switch (msg.t) {
			case 'ready':
				clearTimeout(r.bootTimer);
				r.bootRelease?.();
				if (msg.protocol !== PROTOCOL) {
					this.onMessage(r, { t: 'fatal', message: `The engine host speaks protocol ${msg.protocol ?? 1}, this app speaks ${PROTOCOL}. Reinstall zer0ne Code.` });
					return;
				}
				this.onReady(r, msg);
				return;
			case 'activationError': {
				const p = this.pending;
				if (p && p.key === r.key && msg.activationId === p.activationId) {
					this.cancelActivation(p.activationId);
					const message = typeof msg.message === 'string' ? msg.message : 'Could not activate this project. Try again.';
					if (this.hasLiveShown()) this.note(message);
					else this.showStartPage(message);
					this.retireIdle('');
				}
				return;
			}
			case 'fatal': {
				// The engine gave up before it was usable: drop it, so Retry starts clean.
				if (r.stopping) return;
				const wasPending = !!this.pending && this.pending.key === r.key;
				const wasShown = this.isShown(r.key);
				this.retire(r);
				const message = typeof msg.message === 'string' ? msg.message : 'The engine could not start.';
				if (wasPending) {
					const body = r.folder ? `${nameOf(r.folder)}: ${message}` : message;
					ops.notifyDesktop(this.ctx(), 'crash', 'zer0ne Code', body, true);
					this.shell.feedNotify('crash', body);
				}
				if (wasShown && !this.hasLiveShown()) this.showStartPage(message);
				return;
			}
			case 'req':
				this.onRequest(r, msg);
				return;
			default:
		}
	}

	onRequest(r, msg) {
		const reply = (value) => this.send(r, { t: 'res', id: msg.id, value: value === undefined ? null : value });
		if (msg.op === 'deleteProjectFolder') {
			void this.deleteProjectFolder(r, msg.path).then(reply, error => this.send(r, { t: 'res', id: msg.id, error: error.message || String(error) }));
			return;
		}
		if (msg.op === 'projectFolderDeleted') {
			if (!r.deletedFolder || folderKey(msg.path) !== folderKey(r.deletedFolder)) { reply(false); return; }
			const { contains } = require('./project-folders');
			const folder = r.deletedFolder;
			const removed = p => contains(folder, path.resolve(p)) || contains(r.deletedRealFolder || folder, path.resolve(p));
			this.shell.state.recent = this.shell.state.recent.filter(p => !removed(p));
			if (this.shell.state.folder && removed(this.shell.state.folder)) this.shell.state.folder = null;
			this.shell.saveState();
			reply(true);
			for (const w of this.shell.windows) {
				if (w.folder && (removed(w.folder) || w.active === r && r.deletedCurrent)) { w.folder = null; w.showStartPage(null); }
				for (const engine of [...w.engines.values()]) if (engine.folder && (removed(engine.folder) || engine === r && r.deletedCurrent)) w.retire(engine);
			}
			return;
		}
		if (msg.op === 'retainRouter') {
			r.router = msg.on === true;
			reply(null);
			if (!r.router) this.retireIdle('');
			return;
		}
		if (msg.op === 'retainRemote') {
			r.remote = msg.on === true;
			reply(null);
			if (!r.remote) this.retireIdle('');
			return;
		}
		if (msg.op === 'retainTerminal') {
			r.terminal = msg.on === true;
			reply(null);
			if (!r.terminal) this.retireIdle('');
			return;
		}
		if (msg.op === 'setNotch') {
			this.shell.notch.setPrefs(msg.prefs);
			reply(null);
			return;
		}
		if (msg.op === 'notchPreview') {
			reply(this.shell.notch.preview());
			return;
		}
		if (msg.op === 'notchMic') {
			// This engine's dictation opened or closed the microphone (createNotchSync in host.js).
			r.mic = msg.on === true;
			r.micSince = r.mic ? Date.now() : 0;
			reply(null);
			this.shell.notch.refresh();
			return;
		}
		if (msg.op === 'notchCloud') {
			// The project's cloud tasks changed (createNotchSync in host.js). A task that just
			// ended is a notification; while one runs the engine stays, to keep following it.
			const before = new Map((r.cloudTasks || []).map((t) => [t.id, t.status]));
			r.cloudTasks = cleanCloud(msg.tasks);
			for (const t of r.cloudTasks) {
				const was = before.get(t.id);
				if (!was || was === 'completed' || was === 'failed' || (t.status !== 'completed' && t.status !== 'failed')) continue;
				const proj = nameOf(r.folder) || 'the project';
				const failed = t.status === 'failed';
				const what = failed ? 'Cloud task failed' : t.prUrl ? 'Cloud task done · pull request opened' : 'Cloud task done';
				this.shell.feedNotify('done', `${proj}: ${what} — ${t.task}`, { folder: r.folder, session: null, project: proj, failed });
				this.shell.notch.flashCloud(r, t);
			}
			const cloud = r.cloudTasks.some((t) => t.status !== 'completed' && t.status !== 'failed');
			const released = r.cloud && !cloud;
			r.cloud = cloud;
			reply(null);
			this.shell.notch.refresh();
			if (released) this.retireIdle('');
			return;
		}
		if (msg.op === 'busy') {
			// A run started, changed phase or ended in this engine (createBusyReporter in host.js).
			const on = msg.on === true;
			const wasActivity = r.activity;
			r.activity = !on ? 'idle' : msg.activity === 'waiting' ? 'waiting' : 'running';
			r.phase = on && ['thinking', 'writing', 'tool', 'waiting', 'working'].includes(msg.phase) ? msg.phase : on ? 'working' : null;
			r.detail = on && typeof msg.detail === 'string' ? msg.detail.slice(0, 200) : null;
			const plan = msg.plan;
			r.plan = on && plan && Number.isInteger(plan.done) && Number.isInteger(plan.total) && plan.total > 0 ? { done: Math.min(plan.done, plan.total), total: plan.total, current: typeof plan.current === 'string' ? plan.current.slice(0, 120) : null } : null;
			r.steps = on && Number.isInteger(msg.steps) && msg.steps > 0 ? msg.steps : 0;
			r.stuck = on && typeof msg.stuck === 'string' ? msg.stuck.slice(0, 120) : null;
			r.budget = on ? cleanBudget(msg.budget) : null;
			r.agents = on ? cleanAgents(msg.agents) : null;
			r.goal = on ? cleanGoal(msg.goal) : null;
			r.approval = on ? cleanApproval(msg.approval) : null;
			r.question = on && !r.approval ? cleanQuestion(msg.question) : null;
			r.health = on ? cleanHealth(msg.health) : null;
			r.current = on && msg.current === true;
			if (!on) r.lastTurn = typeof msg.turn === 'string' && msg.turn.length <= 200 ? msg.turn : null;
			const was = r.busy;
			r.busy = on;
			if (on || typeof msg.sessionId === 'string') r.session = typeof msg.sessionId === 'string' ? msg.sessionId : null;
			const proj = nameOf(r.folder) || 'the project';
			if (was && !on) {
				const elapsed = Date.now() - (r.busySince || Date.now());
				r.busySince = 0;
				const dur = formatDuration(elapsed);
				const text = msg.summary ? `${proj}: ${msg.summary} (${dur})` : `${proj} — finished in ${dur}`;
				if (msg.summary) this.shell.feedNotify('done', text, { folder: r.folder, session: r.session, project: proj, duration: dur, failed: msg.failed === true });
				if (msg.summary) this.shell.notch.flash(r, msg.failed === true, String(msg.summary).slice(0, 200), dur, cleanResult(msg.result));
			} else if (on && !was) {
				r.busySince = Date.now();
				r.budgetWarned = false;
			}
			// Most of the task budget gone: once per run, the notch says so.
			if (on && r.budget && r.budget.limit > 0 && r.budget.spent >= r.budget.limit * BUDGET_WARN && !r.budgetWarned) {
				r.budgetWarned = true;
				this.shell.notch.warnBudget(r);
			}
			if (r.activity === 'waiting' && wasActivity !== 'waiting') {
				const reason = msg.waitingReason || 'waiting for your approval or input';
				this.shell.feedNotify('waiting', `${proj} — ${reason}`, { folder: r.folder, session: r.session, project: proj });
				ops.notifyDesktop(this.ctx(), 'waiting', `${proj} (Needs Input)`, reason, false);
			}
			reply(null);
			this.shell.notch.refresh();
			this.shell.refreshTray?.();
			if (this.isShown(r.key)) this.setTitle(r.folder, on);
			if (!on) this.retireIdle('');
			return;
		}
		ops.handle(this.ctx(), msg, r.folder).then(
			(value) => reply(value),
			(e) => this.send(r, { t: 'res', id: msg.id, error: e && e.message ? e.message : String(e) })
		);
	}

	async deleteProjectFolder(source, raw) {
		if (this.shell.deletingProject) throw new Error('Another project deletion is already in progress.');
		this.shell.deletingProject = true;
		const { contains, deleteFolder } = require('./project-folders');
		const affected = folder => [...this.shell.windows].flatMap(w => [...w.engines.values()].filter(r => r.folder && contains(folder, folderKey(r.folder))).map(r => ({ w, r })));
		let canonical, deletesSource = false;
		try {
			const deleted = await deleteFolder(raw, {
				protectedPaths: [paths.appRoot(), paths.configDir(), path.dirname(process.execPath), process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData],
				confirm: async folder => (await dialog.showMessageBox(this.win, { type: 'warning', title: 'Delete project folder', message: 'Are you sure you want to delete “' + path.basename(folder) + '”?', detail: folder + '\n\nThe folder and all its files will move to the Recycle Bin or Trash. Saved chats are kept. You can restore the folder from there.', buttons: ['No', 'Yes'], defaultId: 0, cancelId: 0, noLink: true })).response === 1,
				check: folder => {
					canonical = folder;
					deletesSource = affected(folder).some(({ r }) => r === source);
					this.shell.deletingFolder = folder;
					if (affected(folder).some(({ w, r }) => r.busy || r.remote || r.terminal || r.router || w.pending?.key === r.key)) throw new Error('Stop the running sessions, terminal, Remote and Local Host for this folder before deleting it.');
				},
				release: async folder => {
					const others = affected(folder).filter(({ r }) => r !== source);
					for (const { w, r } of others) { if (w.isShown(r.key)) { w.folder = null; w.showStartPage(null); } w.retire(r); }
					const started = Date.now();
					while (others.some(({ r }) => !r.exited)) {
						if (Date.now() - started > STOP_GRACE_MS + 2000) throw new Error('A project engine is still closing. Try deleting the folder again.');
						await new Promise(resolve => setTimeout(resolve, 50));
					}
				},
				trash: folder => shell.trashItem(folder)
			});
			if (deleted) { source.deletedFolder = path.resolve(raw); source.deletedRealFolder = canonical; source.deletedCurrent = deletesSource; }
			return deleted;
		} finally { this.shell.deletingProject = false; this.shell.deletingFolder = null; }
	}

	/** What ops.js needs from this window. */
	ctx() {
		return {
			win: this.win,
			state: this.shell.state,
			saveState: () => this.shell.saveState(),
			focused: () => !this.win.isDestroyed() && this.win.isFocused(),
			openFolder: (p, newWindow, handoff) => this.openFolder(p, newWindow, handoff),
			isFullscreen: () => this.isFullscreen(),
			setFullscreen: (on) => this.setFullscreen(on)
		};
	}

	onReady(r, msg) {
		let url;
		try {
			url = new URL(String(msg.url));
		} catch {
			const p = this.pending;
			if (p && p.key === r.key) this.cancelActivation(p.activationId);
			if (this.isShown(r.key)) this.showStartPage('The engine sent no address.');
			return;
		}
		r.port = Number(url.port) || 0;
		r.url = url.href;
		// HTTP readiness only permits preparing the page, never revealing it.
		const p = this.pending;
		if (p && p.key === r.key) this.prepareView(r, p.activationId);
	}

	/** Create this engine's page view, offscreen, pointed at its UI. */
	spawnEngineView(r, activationId) {
		const p = this.pending;
		if (!p || p.key !== r.key || p.activationId !== activationId || !r.url) return false;
		const view = this.makeView();
		r.view = view;
		r.bootActivation = activationId;
		p.viewId = view.webContents.id;
		this.guardEngine(view.webContents, r);
		view.webContents.on('render-process-gone', (_e, details) => {
			if (details.reason === 'clean-exit' || r.stopping || r.view !== view) return;
			// The engine keeps running: reload its page once; a second crash soon after shows the start page.
			const now = Date.now();
			if (!r.pageCrashAt || now - r.pageCrashAt > 30_000) {
				r.pageCrashAt = now;
				void view.webContents.loadURL(r.url).catch(() => undefined);
				return;
			}
			const wasActive = this.active === r;
			this.retire(r);
			if (wasActive) this.showStartPage('The project page stopped unexpectedly twice. Open the project again to restart it.');
		});
		this.win.contentView.addChildView(view);
		view.setBounds(this.offscreen());
		view.setVisible(true);
		void view.webContents.loadURL(r.url).catch(() => undefined);
		return true;
	}

	/** Wake a retained page offscreen (or create it) for the pending activation. */
	prepareView(r, activationId) {
		if (!r.view) {
			if (!this.spawnEngineView(r, activationId)) {
				this.cancelActivation(activationId);
				this.note('Could not open the project page. Try opening it again.');
			}
			return;
		}
		const p = this.pending;
		if (!p || p.key !== r.key || p.activationId !== activationId) return;
		p.viewId = r.view.webContents.id;
		if (this.active !== r) {
			r.view.setBounds(this.offscreen());
			r.view.setVisible(true);
		}
		r.view.webContents.executeJavaScript(`window.__zcActivationId = ${JSON.stringify(activationId)};`, false).catch(() => undefined);
	}

	/** Only the pending engine's own page with the current activation may take the screen. */
	pageReady(contents, activationId) {
		const p = this.pending;
		if (!p || p.viewId !== contents.id || p.activationId !== activationId) return false;
		const r = this.engines.get(p.key);
		if (!r || r.stopping || !r.view || r.view.webContents.id !== contents.id) return false;
		if (this.active !== r) {
			this.panelGlass.clear();
			// Reordering an existing native child can reset its viewport; size it after attaching.
			this.win.contentView.addChildView(r.view);
			const { width, height } = this.size();
			r.view.setBounds({ x: 0, y: 0, width, height });
			r.view.setVisible(true);
			const previous = this.active && this.active.view ? this.active.view : this.startView;
			if (previous && previous !== r.view) {
				previous.setVisible(false);
				if (this.active && this.active.view) this.active.view.setBounds(this.offscreen());
			}
			this.active = r;
			r.view.webContents.focus();
		}
		this.folder = r.folder;
		this.port = r.port;
		this.pending = null;
		this.setTitle(r.folder, r.busy);
		this.shell.syncIcons();
		this.shell.notch.refresh();
		this.retireIdle(r.key);
		// A project page is on screen: its window does not need the start page beside it.
		this.releaseStartView();
		return true;
	}

	/** Boot values a page reads before its scripts run (preload, sendSync). */
	boot(contents) {
		const r = [...this.engines.values()].find((x) => x.view && x.view.webContents.id === contents.id);
		if (!r) return { page: 'start', appearance: readAppearance(path.join(paths.dataDir(), 'global-state.json')) };
		const p = this.pending;
		const activationId = p && p.viewId === contents.id ? p.activationId : r.bootActivation || null;
		return { page: 'engine', activationId, appVersion: require('../package.json').version, prefs: glass.savedPrefs(), support: glass.support() };
	}

	onExit(r, code, signal) {
		clearTimeout(r.bootTimer); r.bootRelease?.();
		if (r.stopping) return;
		const wasPending = !!this.pending && this.pending.key === r.key;
		const wasShown = this.isShown(r.key);
		this.retire(r);
		if (wasPending) this.pending = null;
		const name = nameOf(r.folder);
		const body = name ? `${name}: the engine stopped unexpectedly — details are in the log.` : 'The engine stopped unexpectedly — details are in the log.';
		if (r.busy) this.shell.notch.flash(r, true, 'The engine stopped unexpectedly', null);
		ops.notifyDesktop(this.ctx(), 'crash', 'zer0ne Code', body, true);
		this.shell.feedNotify('crash', body);
		if (wasShown) this.showStartPage(`The engine stopped unexpectedly (${signal ? 'signal ' + signal : 'exit code ' + code}). Details are in the log: ${path.join(paths.logDir(), 'engine.log')}`);
	}

		/** Stop one engine: gone from the registry, asked to shut down, killed if it lingers. */
		retire(r) {
			clearTimeout(r.bootTimer); r.bootRelease?.();
			r.stopping = true;
			this.engines.delete(r.key);
			this.order = this.order.filter((k) => k !== r.key);
			this.shell.notch.refresh();
			this.shell.refreshTray?.();
			if (this.pending && this.pending.key === r.key) this.pending = null;
		if (r.view) {
			const view = r.view;
			r.view = null;
			const wasActive = this.active === r;
			if (wasActive) this.active = null;
			this.shell.views.delete(view.webContents.id);
			try {
				this.win.contentView.removeChildView(view);
			} catch {
				// The window is closing.
			}
			if (!view.webContents.isDestroyed()) view.webContents.close();
			if (wasActive) {
				if (this.startView) this.startView.setVisible(true);
				else this.showStartPage(null);
			}
		}
		this.send(r, { t: 'shutdown' });
		const child = r.child;
		setTimeout(() => {
			if (!r.exited) {
				try {
					child.kill();
				} catch {
					// Already gone.
				}
			}
		}, STOP_GRACE_MS).unref();
	}

	retireIdle(keep, timed = false) {
		const now = Date.now();
		const pressure = timed && memoryPressure();
		const pending = (r) => !!this.pending && this.pending.key === r.key;
		const victims = [...this.engines.values()].filter((r) => r.key !== keep && (timed
			? retirableNow(r, this.isShown(r.key), pending(r), now, pressure)
			: idleRetirable(this.isShown(r.key), pending(r), r.busy, r.remote, r.terminal, r.router, r.cloud)));
		for (const r of victims) this.retire(r);
	}

	/** Stop every engine and wait (app exit, window closed): no process outlives its window. */
	stopAll() {
		clearInterval(this.idleSweep);
		trimEngineLog(); // the size check otherwise runs only when a new engine spawns
		this.panelGlass.clear();
		const all = [...this.engines.values()];
		this.engines.clear();
		this.pending = null;
		this.active = null;
		for (const r of all) {
			r.stopping = true;
			this.send(r, { t: 'shutdown' });
			if (r.view) {
				this.shell.views.delete(r.view.webContents.id);
				if (!r.view.webContents.isDestroyed()) r.view.webContents.close();
				r.view = null;
			}
		}
		return new Promise((resolve) => {
			const started = Date.now();
			const tick = () => {
				const left = all.filter((r) => !r.exited);
				if (!left.length) return resolve();
				if (Date.now() - started > STOP_GRACE_MS) {
					for (const r of left) {
						try {
							r.child.kill();
						} catch {
							// Already gone.
						}
					}
					return resolve();
				}
				setTimeout(tick, 100);
			};
			tick();
		});
	}

	/** Page views are not destroyed with their window: close every one this window made. */
	closeViews() {
		const views = [this.startView, ...[...this.engines.values()].map((r) => r.view)].filter(Boolean);
		for (const r of this.engines.values()) r.view = null;
		for (const view of views) {
			this.shell.views.delete(view.webContents.id);
			if (!view.webContents.isDestroyed()) view.webContents.close();
		}
	}

	/** The window's first look: the start page while the engine of `folder` boots (spawn shows it). */
	start(folder, handoff) {
		// The start page applies its saved palette before the first visible frame.
		this.initialShowPending = true;
		this.activate(folder, handoff);
	}
}

module.exports = { EngineWindow, folderKey, idleRetirable, retirableNow, memoryPressure, isDir, cleanBudget, cleanAgents, cleanGoal, cleanResult, cleanCloud, cleanApproval, cleanQuestion, cleanHealth };
