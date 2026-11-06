/*
 * The Quick window: a small floating prompt on a global shortcut (Ctrl+Alt+Space, Cmd+Alt+Space
 * on macOS). It sends what you type to the project of the window you used last and brings that
 * window forward. It hides when it loses focus, on Escape, and after sending.
 */
'use strict';
const path = require('path');
const { BrowserWindow, globalShortcut, screen } = require('electron');
const paths = require('./paths');

const SHORTCUT = 'CommandOrControl+Alt+Space';
const LABEL = process.platform === 'darwin' ? '⌘⌥Space' : 'Ctrl+Alt+Space';

class QuickWindow {
	constructor() {
		/** @type {BrowserWindow | null} */
		this.win = null;
		this.registered = false;
	}

	/** Claims the global shortcut; another app may already hold it, and then the tray item still opens the window. */
	register() {
		try {
			this.registered = globalShortcut.register(SHORTCUT, () => this.toggle());
		} catch {
			this.registered = false;
		}
		return this.registered;
	}

	unregister() {
		if (this.registered) globalShortcut.unregister(SHORTCUT);
		this.registered = false;
	}

	/** True when the IPC call comes from the Quick window's own page (its main frame). */
	owns(event) {
		return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents && event.senderFrame === event.sender.mainFrame;
	}

	create() {
		this.win = new BrowserWindow({
			width: 680,
			height: 168,
			frame: false,
			transparent: true,
			resizable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			show: false,
			backgroundColor: '#00000000',
			title: 'zer0ne Code — Quick prompt',
			webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true }
		});
		this.win.setAlwaysOnTop(true, 'floating');
		this.win.webContents.on('will-navigate', (e) => e.preventDefault());
		this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		this.win.on('blur', () => this.hide());
		void this.win.loadFile(path.join(paths.appRoot(), 'ui', 'quick.html'));
	}

	toggle() {
		if (this.win && !this.win.isDestroyed() && this.win.isVisible()) void this.hide();
		else this.show();
	}

	/** Opens on the display under the pointer, a quarter of the way down. */
	show() {
		if (!this.win || this.win.isDestroyed()) this.create();
		const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
		const [w] = this.win.getSize();
		this.win.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.22));
		this.win.show();
		this.win.focus();
		this.win.webContents.executeJavaScript('window.__zcQuickShown && window.__zcQuickShown()', false).catch(() => undefined);
	}

	/** The page plays its closing animation first; blur, Escape and the page itself end here. */
	async hide() {
		if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
		try { await this.win.webContents.executeJavaScript('window.__zcQuickHide ? window.__zcQuickHide() : true', true); }
		catch { /* the page is gone or busy; hide anyway */ }
		if (this.win && !this.win.isDestroyed()) this.win.hide();
	}
}

module.exports = { QuickWindow, SHORTCUT, LABEL };
