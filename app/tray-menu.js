/*
 * The tray menu as a floating glass panel (ui/tray.html) instead of the native context
 * menu: the app's own Liquid Glass style, anchored above the tray icon (below it under a
 * top menu bar). It takes focus, so a click anywhere else dismisses it; a second right
 * click on the tray toggles it again. The page's rows are fixed and each sends back one
 * fixed key ('zc:…'), which this class resolves to one of the shell's own actions — the
 * page never names folders, sessions or ids.
 */
'use strict';
const path = require('path');
const { app, BrowserWindow, screen, shell: electronShell } = require('electron');
const paths = require('./paths');

/** The transparent canvas the panel draws in (logical px); the page scrolls inside it. */
const WIDTH = 340;
const HEIGHT = 620;
/** Margin that keeps the panel clear of the screen edges. */
const EDGE = 10;
/** The gap between the panel and the tray icon. */
const GAP = 6;

class TrayMenu {
	/** @param {import('./main').Shell} shell */
	constructor(shell) {
		this.shell = shell;
		/** @type {BrowserWindow | null} */
		this.win = null;
		/** The rows' fixed actions (key → run); the page sends keys back, never details. */
		this.actions = new Map([
			['zc:close', () => this.hide()],
			['zc:show', () => this.shell.showWindows()],
			['zc:new-window', () => this.shell.openWindow(null)],
			['zc:open-project', () => this.shell.openProjectDialog()],
			['zc:quick', () => this.shell.quick.show()],
			['zc:notch', () => this.shell.notch.summon()],
			['zc:logs', () => {
				require('fs').mkdirSync(paths.logDir(), { recursive: true });
				void electronShell.openPath(paths.logDir());
			}],
			['zc:quit', () => app.quit()]
		]);
		/** Which way the panel opens: above the icon (a bottom taskbar) or below it (a top menu bar). */
		this.side = 'above';
	}

	/** True when the IPC call comes from the tray panel's own page (its main frame). */
	owns(event) {
		return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents && event.senderFrame === event.sender.mainFrame;
	}

	visible() {
		return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
	}

	ensure() {
		if (this.win && !this.win.isDestroyed()) return;
		this.win = new BrowserWindow({
			width: WIDTH,
			height: HEIGHT,
			frame: false,
			transparent: true,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			show: false,
			backgroundColor: '#00000000',
			title: 'zer0ne Code — Menu',
			webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
		});
		this.win.setAlwaysOnTop(true, 'floating');
		this.win.webContents.on('will-navigate', (e) => e.preventDefault());
		this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		this.win.on('blur', () => this.hide());
		// Every open re-pulls: unread counts, projects and runs change between openings.
		this.win.on('focus', () => void this.win.webContents.executeJavaScript('window.__zcPull && window.__zcPull()', false).catch(() => undefined));
		void this.win.loadFile(path.join(paths.appRoot(), 'ui', 'tray.html'));
	}

	/** Above the tray icon, right-aligned to it; without icon bounds (the icon hides behind the flyout chevron) the pointer display's bottom-right corner. */
	position() {
		if (!this.win || this.win.isDestroyed()) return;
		const tray = this.shell.tray && !this.shell.tray.isDestroyed() ? this.shell.tray.getBounds() : null;
		const icon = tray && tray.width > 0 && tray.height > 0 ? tray : null;
		const point = icon ? { x: Math.round(icon.x + icon.width / 2), y: Math.round(icon.y + icon.height / 2) } : screen.getCursorScreenPoint();
		const work = screen.getDisplayNearestPoint(point).workArea;
		const height = Math.min(HEIGHT, work.height - EDGE * 2);
		let x, y;
		if (icon) {
			this.side = icon.y + icon.height / 2 > work.y + work.height / 2 ? 'above' : 'below';
			x = Math.min(Math.max(icon.x + icon.width / 2 - WIDTH / 2, work.x + EDGE), work.x + work.width - WIDTH - EDGE);
			y = this.side === 'above' ? icon.y - height - GAP : icon.y + icon.height + GAP;
			y = Math.min(Math.max(y, work.y), work.y + work.height - height);
		} else {
			this.side = 'above';
			x = work.x + work.width - WIDTH - EDGE;
			y = work.y + work.height - height - EDGE;
		}
		this.win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIDTH, height: Math.round(height) });
	}

	/** Open with fresh data; the page pulls it over the bridge (tray_data) once its frame is up. */
	show() {
		this.ensure();
		this.position();
		if (!this.visible()) this.win.show();
		this.win.focus();
	}

	/** The page re-pulls while the panel is open (a run finished, a notification arrived). */
	refresh() {
		if (!this.visible()) return;
		void this.win.webContents.executeJavaScript('window.__zcPull && window.__zcPull()', false).catch(() => undefined);
	}

	hide() {
		if (this.visible()) this.win.hide();
	}

	/** Run one action by its key (the panel closes first, like a native menu); unknown keys are ignored. */
	run(key) {
		const act = this.actions.get(String(key));
		if (!act) return;
		this.hide();
		act();
	}
}

module.exports = { TrayMenu };
