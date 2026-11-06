/*
 * Requests from an engine that need the shell: native dialogs, the clipboard,
 * opening links and files, switching folders, applet windows and notifications.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserWindow, Notification, clipboard, dialog, shell, Menu } = require('electron');

/** Hosts on this machine are pages the agent is building: they open in an applet window. */
function isLoopbackHost(host) {
	return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
}

/** FNV-1a of a folder path (case-insensitive on Windows): one storage partition per project. */
function stableKey(s) {
	let h = 0xcbf29ce484222325n;
	for (const b of Buffer.from(process.platform === 'win32' ? s.toLowerCase() : s, 'utf8')) {
		h ^= BigInt(b);
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return h.toString(16).padStart(16, '0');
}

/** Only web links, mail links, local files and Windows settings pages leave the app. */
function openExternal(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	switch (parsed.protocol) {
		case 'http:':
		case 'https:':
		case 'mailto:':
		case 'ms-settings:':
			try { return Promise.resolve(shell.openExternal(url)).then(() => true, () => false); }
			catch { return false; }
		case 'file:': {
			let file;
			try {
				file = require('url').fileURLToPath(parsed);
			} catch {
				return false;
			}
			void shell.openPath(file).then(error => { if (error) dialog.showErrorBox('Could not open file', error); }).catch(error => dialog.showErrorBox('Could not open file', error.message));
			return true;
		}
		default:
			return false;
	}
}

/** VS Code's executable: PATH first, then the usual install folders. */
function findCode() {
	const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
	if (process.platform === 'win32') {
		const names = ['Code.exe'];
		const extra = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code')].filter(Boolean);
		for (const d of [...dirs, ...dirs.filter(d => path.basename(d).toLowerCase() === 'bin').map(d => path.dirname(d)), ...extra]) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
		return null;
	}
	return dirs.some((d) => fs.existsSync(path.join(d, 'code'))) ? 'code' : null;
}

function findTool(target) {
	if (target === 'vscode') return findCode();
	const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
	if (process.platform === 'win32') {
		const names = target === 'cursor' ? ['Cursor.exe'] : ['wt.exe', 'powershell.exe'];
		const extra = target === 'cursor'
			? [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor'), process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Cursor')]
			: [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'), process.env.SystemRoot && path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')];
		for (const name of names) for (const dir of [...dirs, ...extra.filter(Boolean)]) {
			const file = path.join(dir, name);
			if (fs.existsSync(file)) return file;
		}
	} else {
		if (target === 'terminal' && process.platform === 'darwin') return '/usr/bin/open';
		const names = target === 'cursor' ? ['cursor'] : ['x-terminal-emulator', 'gnome-terminal', 'konsole'];
		for (const name of names) for (const dir of dirs) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
	}
	return null;
}

function folderToolArgs(target, executable, folder) {
	if (target !== 'terminal') return ['--new-window', folder];
	const name = path.basename(executable).toLowerCase();
	if (name === 'wt.exe') return ['-d', folder];
	if (name === 'powershell.exe') return ['-NoProfile', '-NoLogo', '-NoExit'];
	if (process.platform === 'darwin') return ['-a', 'Terminal', folder];
	return [];
}

async function openFolderIn(target, folder) {
	if (!folder || !['explorer', 'vscode', 'cursor', 'terminal'].includes(target)) throw new Error('Choose an available project tool.');
	if (target === 'explorer') {
		const error = await shell.openPath(folder);
		if (error) throw new Error(error);
		return true;
	}
	const executable = findTool(target);
	if (!executable) throw new Error('This application is not installed.');
	await new Promise((resolve, reject) => {
		const child = spawn(executable, folderToolArgs(target, executable, folder), { cwd: folder, detached: true, stdio: 'ignore', windowsHide: target !== 'terminal', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
		child.once('error', reject);
		child.once('spawn', () => { child.unref(); resolve(); });
	});
	return true;
}

/** The file stays one literal argument: no shell sees it. */
function editorArgs(file, line) {
	return line > 0 ? ['--goto', `${file}:${line}`] : [file];
}

function openTextDocument(msg) {
	const file = typeof msg.path === 'string' && msg.path ? msg.path : null;
	if (!file) throw new Error('Choose a file to open.');
	const code = findCode();
	if (code) {
		try {
			const child = spawn(code, editorArgs(file, Number(msg.line) > 0 ? Math.floor(Number(msg.line)) : 0), { detached: true, stdio: 'ignore', windowsHide: true });
			child.on('error', () => undefined);
			child.unref();
			return true;
		} catch {
			// Fall back to the system's default app.
		}
	}
	void shell.openPath(file);
	return true;
}

/** Applet windows: a real browser window (sites that refuse iframes work too), one per project profile. */
const applets = new Map(); // label → { win, key }
function floatWindow(label, url, folder, title = 'Applet — zer0ne Code') {
	const key = `${label}-${folder ? stableKey(folder) : 'default'}`;
	const existing = applets.get(label);
	if (existing && !existing.win.isDestroyed()) {
		if (existing.key === key) {
			void existing.win.loadURL(url);
			existing.win.focus();
			return true;
		}
		existing.win.destroy();
	}
	const win = new BrowserWindow({
		width: 940,
		height: 720,
		minWidth: 360,
		minHeight: 280,
		title,
		autoHideMenuBar: true,
		webPreferences: { partition: 'persist:' + key, contextIsolation: true, sandbox: true, nodeIntegration: false }
	});
	win.setMenu(null);
	const permissions = require('./site-permissions').installSitePermissions(win, dialog);
	win.webContents.on('context-menu', (_e, p) => Menu.buildFromTemplate([
		{ role: 'copy', enabled: !!p.selectionText },
		...(p.linkURL ? [{ label: 'Open link externally', click: () => openExternal(p.linkURL) }] : []),
		{ type: 'separator' }, { label: 'Site permissions…', click: () => permissions.manage() }
	]).popup({ window: win }));
	const stays = (u) => {
		try {
			const p = new URL(u);
			return p.protocol === 'http:' && isLoopbackHost(p.hostname);
		} catch {
			return false;
		}
	};
	win.webContents.on('will-navigate', (e, u) => {
		if (!stays(u)) {
			e.preventDefault();
			openExternal(u);
		}
	});
	win.webContents.setWindowOpenHandler(({ url: u }) => {
		openExternal(u);
		return { action: 'deny' };
	});
	win.on('page-title-updated', (e) => e.preventDefault());
	applets.set(label, { win, key });
	win.on('closed', () => {
		if (applets.get(label)?.win === win) applets.delete(label);
	});
	void win.loadURL(url);
	return true;
}

function openApplet(url, folder) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('Choose a valid http or https address.');
	}
	if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) throw new Error('Applet windows open local project apps only.');
	return floatWindow('applet', parsed.href, folder);
}

/** VS Code-style message: up to two choices plus Cancel; returns the chosen label or null. */
async function message(win, msg) {
	const items = Array.isArray(msg.items) ? msg.items.filter((i) => typeof i === 'string') : [];
	const buttons = items.length === 0 ? ['OK'] : items.length === 1 ? [items[0], 'Cancel'] : [items[0], items[1], 'Cancel'];
	const type = msg.level === 'error' ? 'error' : msg.level === 'warning' ? 'warning' : 'info';
	const options = { type, title: 'zer0ne Code', message: String(msg.message || ''), buttons, cancelId: buttons.length - 1, defaultId: 0, noLink: true };
	const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
	return items.length && response < Math.min(items.length, 2) ? items[response] : null;
}

function dialogOptions(msg) {
	const options = {};
	if (typeof msg.title === 'string' && msg.title) options.title = msg.title;
	if (typeof msg.defaultPath === 'string' && msg.defaultPath) options.defaultPath = msg.defaultPath;
	const filters = (Array.isArray(msg.filters) ? msg.filters : []).map((f) => ({ name: String((f && f.name) || 'Files'), extensions: Array.isArray(f && f.extensions) ? f.extensions.filter((e) => typeof e === 'string') : [] })).filter((f) => f.extensions.length);
	if (filters.length) options.filters = filters;
	return options;
}

async function openDialog(win, msg) {
	const properties = [msg.folders ? 'openDirectory' : 'openFile'];
	if (msg.many) properties.push('multiSelections');
	const options = { ...dialogOptions(msg), properties };
	const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return r.canceled ? [] : r.filePaths;
}

async function saveDialog(win, msg) {
	const options = dialogOptions(msg);
	const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
	return r.canceled || !r.filePath ? null : r.filePath;
}

/** Pick a project folder. */
async function pickFolder(win) {
	const options = { title: 'Open a project folder', properties: ['openDirectory'] };
	const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	return r.canceled ? null : r.filePaths[0] || null;
}

/**
 * A desktop notification; background crashes may bypass focus, every notification obeys mute,
 * and what the notch shows skips Windows when Settings → Notch says so.
 */
function notifyDesktop(ctx, kind, title, body, force) {
	if ((!force && ctx.focused()) || !body) return false;
	if (!ctx.state.notify_on_done || !Notification.isSupported()) return false;
	if (require('./notch').covers(ctx.state.notch, kind)) return false;
	new Notification({ title, body }).show();
	return true;
}

/**
 * One engine request. `ctx` is the window it belongs to:
 * { win, state, saveState(), folder, focused(), openFolder(p, newWindow, handoff), setFullscreen(on) }.
 */
async function handle(ctx, msg, folder) {
	switch (String(msg.op || '')) {
		case 'message':
			return message(ctx.win, msg);
		case 'openDialog':
			return openDialog(ctx.win, msg);
		case 'saveDialog':
			return saveDialog(ctx.win, msg);
		case 'clipboardRead':
			return clipboard.readText() || '';
		case 'clipboardWrite':
			clipboard.writeText(String(msg.text || ''));
			return null;
		case 'openExternal':
			return openExternal(String(msg.url || ''));
		case 'openPath': {
			const p = String(msg.path || '');
			return !!p && (await shell.openPath(p)) === '';
		}
		case 'openTextDocument':
			return openTextDocument(msg);
		case 'reveal': {
			const p = String(msg.path || '');
			if (!p) return false;
			shell.showItemInFolder(p);
			return true;
		}
		case 'openFolder':
			await ctx.openFolder(typeof msg.path === 'string' && msg.path ? msg.path : null, msg.newWindow === true, msg.handoff && typeof msg.handoff === 'object' ? msg.handoff : null);
			return null;
		case 'openIn':
			return openFolderIn(msg.target, folder);
		case 'openInTargets':
			return { folder: folder || null, name: folder ? path.basename(folder) : null, targets: { explorer: !!folder, vscode: !!folder && !!findTool('vscode'), cursor: !!folder && !!findTool('cursor'), terminal: !!folder && !!findTool('terminal') } };
		case 'fullscreen': {
			const on = typeof msg.on === 'boolean' ? msg.on : !ctx.isFullscreen();
			return ctx.setFullscreen(on);
		}
		case 'openApplet':
			return openApplet(String(msg.url || ''), folder);
		case 'notify':
			return notifyDesktop(ctx, msg.kind || 'done', msg.title || 'zer0ne Code', String(msg.body || ''), false);
		case 'setNotify':
			ctx.state.notify_on_done = msg.on !== false;
			ctx.saveState();
			return null;
		default:
			throw new Error(`unknown request: ${msg.op}`);
	}
}

module.exports = { handle, openExternal, openApplet, notifyDesktop, pickFolder, isLoopbackHost, stableKey, editorArgs, findTool, folderToolArgs };
