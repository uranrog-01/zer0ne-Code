'use strict';
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const paths = require('./paths');
const { requestStop, requestPause } = require('./computer-stop');

/**
 * The Design cursor for Computer Use: a see-through, click-through window over the primary
 * display that draws what app/computer-overlay.cs reports. That process keeps the input hooks,
 * Stop and the heartbeat, and keeps its own outline until this window has loaded. This window
 * only draws, and tells it when the visual for an action is on screen; it never takes focus and
 * is left out of screenshots, so the model sees only the app.
 */
class ComputerEffects {
	constructor(visuals, directory, onResume) {
		this.visuals = visuals;
		this.directory = directory;
		this.onResume = onResume;
		this.win = null;
		this.ready = false;
		this.state = { mode: 'hidden' };
		this.retryAt = 0;
		this.lastId = '';
		this.capturing = false;
		visuals.listeners.add((message) => this.update(message));
	}

	/** True when the IPC call comes from this window's own page (its main frame). */
	owns(event) {
		return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents && event.senderFrame === event.sender.mainFrame;
	}

	update(message) {
		this.state = message;
		const wanted = message.mode !== 'hidden' && message.effects === 'design';
		if (wanted) this.ensure();
		if (!this.win || this.win.isDestroyed() || !this.ready) return;
		const view = wanted && message.design ? this.view(message) : { mode: 'hidden' };
		this.push({ type: 'state', ...view });
		if (view.mode !== 'hidden') {
			clearTimeout(this.hideTimer);
			this.hideTimer = null;
			if (!this.win.isVisible()) this.win.showInactive();
		} else if (this.win.isVisible() && !this.hideTimer) {
			// The page fades its cursor and bar out first.
			this.hideTimer = setTimeout(() => {
				this.hideTimer = null;
				if (this.win && !this.win.isDestroyed() && (this.state.mode === 'hidden' || !this.state.design)) this.win.hide();
			}, 700);
		}
		if (view.mode === 'active' && message.id !== this.lastId) {
			this.lastId = message.id;
			if (message.action === 'screenshot') void this.frame(message.id);
		}
	}

	/** Physical pixels from the overlay, as positions in this window (DIPs from the primary display's corner). */
	local(rect) {
		const origin = screen.getPrimaryDisplay().bounds;
		const r = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
		return { x: r.x - origin.x, y: r.y - origin.y, w: r.width, h: r.height };
	}

	view(m) {
		const origin = screen.getPrimaryDisplay().bounds;
		const point = Number.isFinite(m.x) && Number.isFinite(m.y) ? screen.screenToDipPoint({ x: m.x, y: m.y }) : null;
		return {
			mode: m.mode === 'paused' ? 'paused' : 'active',
			id: String(m.id || ''),
			window: String(m.window || ''),
			action: String(m.action || ''),
			title: String(m.title || '').slice(0, 200),
			dark: !!m.dark,
			focused: !!m.focused,
			handoff: !!m.handoff,
			rect: m.rect ? this.local(m.rect) : null,
			point: point ? { x: point.x - origin.x, y: point.y - origin.y } : null
		};
	}

	/** Each observation brings the window's pixels, so the page can redraw what changed. */
	async frame(id) {
		if (this.capturing) return;
		this.capturing = true;
		try {
			const shot = await this.visuals.capture();
			if (!shot || !this.ready || !this.win || this.win.isDestroyed() || this.state.id !== id) return;
			this.push({ type: 'frame', id, image: 'data:image/png;base64,' + shot.image.toString('base64'), rect: this.local(shot.rect) });
		} finally {
			this.capturing = false;
		}
	}

	push(message) {
		if (!this.win || this.win.isDestroyed()) return;
		this.win.webContents.executeJavaScript(`window.__zcEffects && window.__zcEffects(${JSON.stringify(message)})`, false).catch(() => undefined);
	}

	/** The pointer over the bar takes clicks; anywhere else they reach the app below. */
	hover(on) {
		if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(!on, { forward: true });
	}

	/** The page drew the visual for this action: the overlay may now let its input through. */
	shown(id) {
		if (id && id === this.state.id) this.visuals.shown(id);
	}

	control(action) {
		if (action === 'stop') requestStop(this.directory);
		else if (action === 'pause' && this.state.mode === 'active') requestPause(this.directory);
		else if (action === 'resume') this.onResume();
	}

	place() {
		if (this.win && !this.win.isDestroyed()) this.win.setBounds(screen.getPrimaryDisplay().bounds);
		if (this.ready) this.update(this.state);
	}

	ensure() {
		if ((this.win && !this.win.isDestroyed()) || Date.now() < this.retryAt) return;
		this.ready = false;
		this.win = new BrowserWindow({
			...screen.getPrimaryDisplay().bounds,
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			focusable: false,
			skipTaskbar: true,
			hasShadow: false,
			thickFrame: false,
			roundedCorners: false,
			alwaysOnTop: true,
			show: false,
			title: 'zer0ne Code — Computer Use',
			webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false }
		});
		const win = this.win;
		win.setAlwaysOnTop(true, 'screen-saver');
		win.setIgnoreMouseEvents(true, { forward: true });
		win.setContentProtection(true);
		win.webContents.on('will-navigate', (e) => e.preventDefault());
		win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		win.webContents.on('did-finish-load', () => {
			if (this.win !== win) return;
			this.ready = true;
			this.visuals.setDesign(true);
			this.update(this.state);
		});
		win.webContents.on('render-process-gone', () => this.fail(win));
		win.webContents.on('unresponsive', () => this.fail(win));
		win.on('closed', () => { if (this.win === win) { this.win = null; this.ready = false; this.visuals.setDesign(false); } });
		if (!this.listening) {
			this.listening = true;
			for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => this.place());
		}
		void win.loadFile(path.join(paths.appRoot(), 'ui', 'computer-effects.html'));
	}

	/** The overlay draws its classic outline again; the window is retried later. */
	fail(win) {
		if (this.win !== win) return;
		this.visuals.setDesign(false);
		this.retryAt = Date.now() + 10000;
		this.win = null;
		this.ready = false;
		if (!win.isDestroyed()) win.destroy();
	}

	dispose() {
		clearTimeout(this.hideTimer);
		const win = this.win;
		this.win = null;
		if (win && !win.isDestroyed()) win.destroy();
	}
}

module.exports = { ComputerEffects };
