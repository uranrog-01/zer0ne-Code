/*
 * zer0ne Code — the desktop app. Native windows that show the coding engine's own
 * UI, served by the engine running on Electron's Node (engines.js). The shell adds
 * what a web page cannot do: native dialogs, the clipboard, the OS key store, links
 * in the real browser, project folders, the tray and notifications.
 *
 * One app instance: launching it again (or "open in new window") opens another
 * window in this process. Closing the last window, or one with work still running,
 * hides it to the tray; Quit in the tray stops every engine.
 */
'use strict';
const path = require('path');
const { app, ipcMain, Menu, Tray, nativeImage, nativeTheme, session, shell: electronShell } = require('electron');
const paths = require('./paths');

if (app.isPackaged) require('./integrity').verifyInstalled();
paths.configure();
// Tests and diagnostics only: the pages become inspectable over the DevTools protocol on this local port.
// A packaged build must never open a debugging port: an attaching process can read the engine
// token from the renderer target list and then approve tool calls on the user's behalf.
if (!app.isPackaged && /^\d{4,5}$/.test(process.env.ZER0NE_DEBUG_PORT || '')) app.commandLine.appendSwitch('remote-debugging-port', process.env.ZER0NE_DEBUG_PORT);
const folderArgs = (argv, cwd) => require('./launch-args').folderArgs(argv, { packaged: app.isPackaged, entry: path.join(__dirname, '..'), cwd });

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	const { ShellState } = require('./state');
	const { EngineWindow, folderKey, isDir } = require('./engines');
	const { DesktopIcons, hideRequested, hideTaskbarRequested } = require('./desktop-icons');
	const glass = require('./glass');

		const { allowed, validated } = require('./permissions');
		const { QuickWindow, LABEL: QUICK_LABEL } = require('./quick-window');
		const { Notch } = require('./notch');
		const { TrayMenu } = require('./tray-menu');
		const { TrayBadge } = require('./tray-badge');
		const { WorkerPool } = require('./workers');

		class Shell {
			constructor() {
				this.state = ShellState.load(paths.configDir());
				/** @type {Set<EngineWindow>} */
				this.windows = new Set();
				/** webContents id → its window */
				this.views = new Map();
				this.lastFocused = null;
				this.quitting = false;
				this.stopped = false;
				this.devtools = !app.isPackaged || process.env.ZER0NE_DEVTOOLS === '1';
				/** The bell's feed: run finishes and engine crashes in every window, newest first (in memory: the OS notification already rang). */
				this.feed = [];
				this.feedSeq = 0;
				this.projectCreation = new (require('./project-creation').ProjectCreation)();
				this.icons = new DesktopIcons(paths.configDir());
				this.quick = new QuickWindow();
				/** What each project's agent is doing, at the top of the screen (Settings → Notch). */
				this.notch = new Notch(this);
				/** The tray's menu: a floating glass panel (app/tray-menu.js), not the native one. */
				this.trayMenu = new TrayMenu(this);
				/** The tray icon's badge: a dot for waiting, running or unread (app/tray-badge.js). */
				this.badge = new TrayBadge(nativeImage.createFromPath(path.join(paths.appRoot(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')));
				/** Heavy work off the main event loop: a utility process (app/workers/misc.js). */
				this.worker = new WorkerPool('zer0ne-misc');
				const saved = glass.savedPrefs();
				this.transparency = saved && Number.isFinite(saved.transparency) ? Math.max(0, Math.min(100, saved.transparency)) : 0;
				this.startStallSampler();
			}

			/** Log what blocks the main thread (diagnostics only; the sampler cannot fix a stall). */
			startStallSampler() {
				const log = paths.logDir();
				require('fs').mkdirSync(log, { recursive: true });
				this.stallSampler = require('./stall-sampler').start((capture) => {
					const frames = capture.frames.map((f) => `${f.selfMs}ms ${f.fn} ${f.url}:${f.line}`).join('\n  ');
					const line = `${new Date().toISOString()} main thread stalled ${capture.startLagMs}ms\n  ${frames}\n`;
					try {
						require('fs').appendFileSync(path.join(log, 'stalls.log'), line);
					} catch {
						// losing a stall record is fine; writing must never throw
					}
				});
			}

		startFile() {
			return path.join(paths.appRoot(), 'ui', 'index.html');
		}

		startUrl() {
			return require('url').pathToFileURL(this.startFile()).href;
		}

		saveState() {
			this.state.save(paths.configDir());
			// The bell's mute and the notch settings live here; the notch follows both.
			this.notch.refresh();
		}

		openWindow(folder, handoff) {
			// A project already open in a window: bring that window forward instead of a second engine.
			const key = folderKey(folder);
			const open = key && [...this.windows].find((x) => folderKey(x.folder) === key || (x.pending && x.pending.key === key));
			if (open) {
				open.reveal();
				return open;
			}
			const w = new EngineWindow(this);
			this.windows.add(w);
			this.lastFocused = w;
			if (folder) {
				this.state.setFolder(folder);
				this.saveState();
			}
			w.start(folder || null, handoff || null);
			return w;
		}

		/** Close: the last window, or one whose projects still work, hides to the tray; others close. */
		windowClosing(w) {
			if (this.windows.size <= 1 || w.retainsWork()) {
				w.win.hide();
				this.syncIcons();
				return;
			}
			this.windows.delete(w);
			w.win.hide();
			void w.stopAll().then(() => {
				w.closeViews();
				if (!w.win.isDestroyed()) w.win.destroy();
			});
		}

		windowClosed(w) {
			this.windows.delete(w);
			for (const [id, owner] of this.views) if (owner === w) this.views.delete(id);
			if (this.lastFocused === w) this.lastFocused = [...this.windows].pop() || null;
			this.syncIcons();
		}

		/** Back from the tray: retain each window's size and focus the last one used. */
		showWindows() {
			if (!this.windows.size) {
				this.openWindow(this.state.folder && isDir(this.state.folder) ? this.state.folder : null);
				return;
			}
			const focus = this.lastFocused && this.windows.has(this.lastFocused) ? this.lastFocused : [...this.windows].pop();
			for (const w of this.windows) if (w !== focus) w.reveal(false);
			focus.reveal();
			this.syncIcons();
		}

		/** One bell notification, pushed to every window's page on screen (others catch up when they poll). */
		feedNotify(kind, message, meta) {
			this.feed.unshift({
				id: ++this.feedSeq,
				kind,
				message,
				folder: meta?.folder || null,
				session: meta?.session || null,
				project: meta?.project || null,
				duration: meta?.duration || null,
				failed: meta?.failed === true,
				ts: Date.now(),
				read: false
			});
			this.feed.length = Math.min(this.feed.length, 50);
			this.feedPush();
		}

		/** The feed to every window's page on screen and to the notch, which share its read state. */
		feedPush() {
			const js = `window.__zcFeed && window.__zcFeed(${JSON.stringify(this.feed)})`;
			for (const w of this.windows) w.evalActive(js);
			this.notch.refresh();
			this.refreshTray();
		}

		feedRead(id) {
			for (const item of this.feed) if (id === null || id === undefined || item.id === id) item.read = true;
			this.notch.refresh();
		}

		/** Desktop icons hide while a see-through window shows a project over the desktop. */
		syncIcons() {
			const level = glass.transparentSupported() ? this.transparency : 0;
			const on = [...this.windows].some((w) => !w.win.isDestroyed() && hideRequested(w.win.isVisible(), w.win.isMinimized(), !!w.active, level));
			const taskbarOn = [...this.windows].some((w) => !w.win.isDestroyed() && hideTaskbarRequested(w.win.isVisible(), w.win.isMinimized(), !!w.active, level, w.isFullscreen()));
			this.icons.sync(on, taskbarOn);
			this.refreshTray();
		}

		/** Glass settings for the whole app: saved, then shown on every other open project page. */
		glassPrefs(sender, prefs) {
			const r = glass.savePrefs(prefs);
			if (r.newer) {
				sender.executeJavaScript(`window.__zgSync && window.__zgSync(${JSON.stringify(r.newer)});`, false).catch(() => undefined);
				return true;
			}
			if (!r.text) return false;
			const wasTransparent = this.transparency > 0;
			this.transparency = Math.max(0, Math.min(100, Number(prefs.transparency) || 0));
			// 0% is an opaque window; anything above it needs a see-through one.
			if ((this.transparency > 0) !== wasTransparent) for (const w of this.windows) w.setGlassMode();
			this.syncIcons();
			const js = `window.__zgSync && window.__zgSync(${r.text});`;
			for (const w of this.windows) {
				for (const e of w.engines.values()) {
					if (e.view && e.view.webContents.id !== sender.id && !e.view.webContents.isDestroyed()) e.view.webContents.executeJavaScript(js, false).catch(() => undefined);
				}
			}
			return r.saved;
		}

		/** The window a quick prompt goes to: the one used last, else any open one. */
		quickTarget() {
			const w = this.lastFocused && this.windows.has(this.lastFocused) ? this.lastFocused : [...this.windows].pop();
			return w && !w.win.isDestroyed() ? w : null;
		}

		async invoke(event, cmd, args) {
			const sender = event.sender;
			const quick = this.quick.owns(event);
			const notch = !quick && this.notch.owns(event);
			const popup = !quick && !notch && this.trayMenu.owns(event);
			const w = quick || notch || popup ? null : this.views.get(sender.id);
			// Only a main frame of this app's own pages; frames inside a page (artifact previews) never reach the shell.
			if (!quick && !notch && !popup && (!w || event.senderFrame !== sender.mainFrame)) throw new Error('not allowed');
			const page = quick ? 'quick' : notch ? 'notch' : popup ? 'tray' : w.startView && sender.id === w.startView.webContents.id ? 'start' : 'engine';
			if (!allowed(page, cmd)) throw new Error(`${cmd} is not available here`);
			// Arguments are type-checked and coerced per command; malformed ones refuse the call.
			args = validated(cmd, args && typeof args === 'object' ? args : {});
			if (args === undefined) throw new Error(`${cmd}: invalid arguments`);
			switch (cmd) {
				case 'show_help':
					if (args && args.action === 'copy_device_id') {
						try { require('electron').clipboard.writeText(require('./device-id').deviceId(paths.configDir())); return { ok: true, copied: true }; }
						catch (error) { void require('electron').dialog.showMessageBox(w.win, { type: 'error', message: 'Could not copy device ID', detail: error.message }); return { ok: false, error: error.message }; }
					}
					if (args && args.action === 'open_logs') {
						require('fs').mkdirSync(paths.logDir(), { recursive: true });
						void electronShell.openPath(paths.logDir());
						return { ok: true };
					}
					Menu.buildFromTemplate([
						{ label: 'Copy device ID', click: () => {
							try { require('electron').clipboard.writeText(require('./device-id').deviceId(paths.configDir())); }
							catch (error) { void require('electron').dialog.showMessageBox(w.win, { type: 'error', message: 'Could not copy device ID', detail: error.message }); }
						} },
						{ label: 'Open logs', click: () => {
							require('fs').mkdirSync(paths.logDir(), { recursive: true });
							void electronShell.openPath(paths.logDir());
						} }
					]).popup({ window: w.win });
					return null;
				case 'plugin:window|minimize':
					w.win.minimize();
					return null;
				case 'plugin:window|toggle_maximize':
					w.toggleMaximize();
					return null;
				case 'plugin:window|close':
					w.win.close();
					return null;
				case 'plugin:window|is_maximized':
					return w.isMaximized();
				case 'plugin:window|is_fullscreen':
					return w.isFullscreen();
				case 'plugin:window|start_dragging':
					return null; // the bar is a native drag region (desktop-ui.js)
				case 'zc_page_ready':
					return w.pageReady(sender, String(args.activationId || ''));
				case 'restart_engine':
					w.restart(w.folder);
					return null;
				case 'choose_folder':
					void w.openFolder(null, false, null);
					return null;
				case 'pick_project_folder':
					return this.projectCreation.pick(sender, () => require('./ops').pickFolder(w.win));
				case 'create_project':
					return this.projectCreation.create(sender, args, (folder, handoff) => w.openFolder(folder, false, handoff));
				case 'open_logs':
					require('fs').mkdirSync(paths.logDir(), { recursive: true });
					void electronShell.openPath(paths.logDir());
					return null;
				case 'host_status':
					return w.status();
				case 'profile_backup':
				case 'profile_restore':
					return require('./profile-actions').run(this, w.win, cmd === 'profile_restore');
				case 'notify_feed':
					return this.feed;
				case 'notify_read':
					this.feedRead(Number.isFinite(args.id) ? args.id : null);
					return null;
				case 'glass_blur':
					return glass.setBlur(w.win, args.on === true);
				case 'glass_panels':
					return w.active?.view?.webContents.id === sender.id ? w.panelGlass.update(args) : false;
				case 'desktop_wallpaper':
					// Through the utility worker: the reg reads are synchronous and must not
					// stall the main event loop; a worker failure falls back to a direct read.
					return this.worker
						.request('wallpaper', { since: Number.isFinite(args.since) ? args.since : null }, 10_000)
						.catch(() => glass.wallpaper(Number.isFinite(args.since) ? args.since : null));
				case 'glass_prefs':
					return this.glassPrefs(sender, args.prefs);
				case 'quick_target': {
					const target = this.quickTarget();
					return { project: target && target.active && target.folder ? path.basename(target.folder) : null, shortcut: QUICK_LABEL };
				}
				case 'quick_send': {
					const text = String(args.text || '').slice(0, 20000).trim();
					if (!text) return { ok: false, error: 'Type a prompt first.' };
					const target = this.quickTarget();
					if (!target || !target.active || !target.active.view) {
						this.showWindows();
						return { ok: false, error: 'Open a project first, then send again.' };
					}
					// The page shows its sent check and closes itself (quick_close) after; the window still comes forward now.
					target.reveal();
					target.evalActive(`window.__zcQuickPrompt && window.__zcQuickPrompt(${JSON.stringify(text)});`);
					return { ok: true };
				}
				case 'quick_close':
					this.quick.hide();
					return null;
				case 'notch_state':
					return this.notch.state();
				case 'notch_hover':
					this.notch.hover(args.on);
					return null;
				case 'notch_open':
					return this.notch.open(args.key, args.to);
				case 'notch_dismiss':
					return this.notch.dismiss(args.key);
				case 'notch_read':
					return this.notch.read(Number.isFinite(args.id) ? args.id : null);
				case 'notch_act':
					return this.notch.act(args.key, args.action, { answer: args.answer, text: args.text });
				case 'notch_ask':
					return this.notch.ask(args.text, args.files, args.clipboard);
				case 'notch_pin':
					this.notch.pin(args.on, args.height);
					return null;
				case 'tray_data':
					return this.trayData();
				case 'tray_action':
					this.trayMenu.run(args.key);
					return null;
				default:
					throw new Error(`unknown command: ${cmd}`);
			}
		}

		/**
		 * The tray: left-click restores; right-click opens the menu — a floating glass panel
		 * (app/tray-menu.js) in the app's own style, not the native context menu. The panel
		 * pulls its data (tray_data) each time it opens or changes under it, so it is never
		 * stale on arrival.
		 */
		setupTray() {
			const icon = nativeImage.createFromPath(path.join(paths.appRoot(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
			this.tray = new Tray(icon);
			this.refreshTray();
			this.tray.on('click', () => this.showWindows());
			this.tray.on('double-click', () => this.showWindows());
			this.tray.on('right-click', () => this.toggleTrayMenu());
		}

		/** Open or close the tray panel; a second right click closes it, like the native menu it replaces. */
		toggleTrayMenu() {
			if (this.trayMenu.visible()) this.trayMenu.hide();
			else this.trayMenu.show();
		}

		/** The tooltip, the badge and an open panel all follow state: projects and runs change under them. */
		refreshTray() {
			if (!this.tray) return;
			this.tray.setToolTip(this.trayTooltip());
			this.trayMenu.refresh();
			void this.badge.apply(this.tray, this.badgeState());
		}

		/** What the tray icon's badge says: only the most urgent thing (a run waiting for you wins). */
		badgeState() {
			const engines = [...this.windows].flatMap((w) => [...w.engines.values()]);
			if (engines.some((r) => r.activity === 'waiting')) return 'waiting';
			if (engines.some((r) => r.busy)) return 'running';
			if (this.feed.some((n) => !n.read)) return 'unread';
			return '';
		}

		/** zer0ne Code, then what needs attention: running agents and unread notifications. */
		trayTooltip() {
			const engines = [...this.windows].flatMap((w) => [...w.engines.values()]);
			const busy = engines.filter((r) => r.busy).length;
			const unread = this.feed.filter((n) => !n.read).length;
			const parts = ['zer0ne Code'];
			if (busy) parts.push(`${busy} agent${busy === 1 ? '' : 's'} running`);
			if (unread) parts.push(`${unread} new notification${unread === 1 ? '' : 's'}`);
			return parts.join(' — ');
		}

		/**
		 * The tray panel's small data: version, theme, which way it opens, the shortcut
		 * labels and the running count for its status line. The rows are fixed in the page;
		 * each sends back its fixed key, which the TrayMenu resolves to a shell action.
		 */
		trayData() {
			return {
				version: app.getVersion(),
				theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
				side: this.trayMenu.side,
				running: [...this.windows].flatMap((w) => [...w.engines.values()]).filter((r) => r.busy).length,
				quickKeys: QUICK_LABEL,
				notchKeys: process.platform === 'darwin' ? '⌘⌥Z' : 'Ctrl+Alt+Z'
			};
		}

		/** Pick a folder in the native dialog and open it like a project given on the command line. */
		openProjectDialog() {
			return require('./ops').pickFolder(null).then((folder) => {
				if (folder) this.openWindow(folder);
			}).catch(() => undefined);
		}
	}

	const AUMID = 'dev.zer0ne.code.electron';

	function ensureStartMenuShortcut() {
		try {
			require('./start-menu').ensureStartMenuShortcut({
				execPath: process.execPath,
				aumid: AUMID,
				appData: app.getPath('appData'),
				programData: process.env.ProgramData,
				description: 'A desktop coding agent for your project folders',
				read: (link) => {
					try {
						return electronShell.readShortcutLink(link);
					} catch {
						return null;
					}
				},
				write: (link, operation, options) => electronShell.writeShortcutLink(link, operation, options),
			});
		} catch {
			// Notifications stay silent; everything else works.
		}
	}

	const shell = new Shell();
	app.setAppUserModelId(AUMID);
	nativeTheme.themeSource = 'system';
	Menu.setApplicationMenu(null);

	ipcMain.on('zc:boot', (event) => {
		const w = shell.views.get(event.sender.id);
		event.returnValue = w && event.senderFrame === event.sender.mainFrame ? w.boot(event.sender) : null;
	});
	ipcMain.handle('zc:invoke', (event, cmd, args) => shell.invoke(event, String(cmd), args));

	app.on('second-instance', (_e, argv, cwd) => {
		const folder = folderArgs(argv, cwd).find(isDir);
		if (folder) shell.openWindow(folder);
		else shell.showWindows();
	});

	// The tray keeps the app alive; only Quit ends it.
	app.on('window-all-closed', () => undefined);
	// macOS: the Dock icon brings the windows back.
	app.on('activate', () => shell.showWindows());

	app.on('will-quit', () => {
		shell.computerVisuals?.dispose();
		shell.stopComputerShortcut?.();
		shell.quick.unregister();
		shell.notch.dispose();
		if (shell.stallSampler) shell.stallSampler.stop();
		shell.worker.kill();
	});

	app.on('before-quit', (e) => {
		if (shell.stopped) return;
		e.preventDefault();
		shell.quitting = true;
		if (!shell.profileRestored) for (const w of shell.windows) w.rememberSize();
		void Promise.all([...shell.windows].map((w) => w.stopAll())).then(() => {
			shell.icons.restore();
			shell.stopped = true;
			app.quit();
		});
	});

	app.whenReady().then(() => {
		shell.stopComputerShortcut = require('./computer-stop').start(path.join(paths.dataDir(),'global','computer-use'), require('electron').globalShortcut);
		shell.computerVisuals = new (require('./computer-visuals').ComputerVisuals)(path.join(paths.dataDir(), 'global', 'computer-use'), path.join(paths.appRoot(), 'app', 'computer-overlay.cs'), () => {
			const target = shell.quickTarget();
			if (!target?.active?.view) { shell.showWindows(); return; }
			target.reveal();
			target.evalActive('window.__zcComputerUse && window.__zcComputerUse.open()');
		});
		// The app's own pages may use the clipboard and nothing else (Electron would otherwise grant every request).
		const PAGE_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write']);
		session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(!!contents && shell.views.has(contents.id) && PAGE_PERMISSIONS.has(permission)));
		session.defaultSession.setPermissionCheckHandler((contents, permission) => !!contents && shell.views.has(contents.id) && PAGE_PERMISSIONS.has(permission));
		shell.setupTray();
		shell.quick.register();
		if (process.platform === 'win32' && app.isPackaged && !process.env.ZER0NE_DATA_DIR) ensureStartMenuShortcut();
		// A folder on the command line ("Open with zer0ne Code") wins over the last one.
		const arg = folderArgs(process.argv).find(isDir);
		const folder = arg || (shell.state.folder && isDir(shell.state.folder) ? shell.state.folder : null);
		shell.openWindow(folder);
	});

	module.exports = { shell };
}
