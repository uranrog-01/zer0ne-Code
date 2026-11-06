/*
 * The extension's own `vscode` shim (engine/vscode-shim.js), wired to the
 * desktop app: dialogs, clipboard and links go through the app shell (rpc),
 * "Open folder" switches the project, files open in VS Code when it is
 * installed (else the system's default app), and API keys are encrypted with
 * a key kept in the OS keychain.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { githubAuthentication } = require('./authentication');

/** Filters as VS Code gives them ({ Images: ['png'] }) → [{ name, extensions }]. */
function filters(f) {
	return f && typeof f === 'object' ? Object.entries(f).map(([name, extensions]) => ({ name, extensions: (extensions || []).map(String) })) : [];
}

/** First executable named `name` on PATH (Windows tries .cmd/.exe). */
function onPath(name) {
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
	for (const dir of (process.env.PATH || '').split(path.delimiter)) {
		for (const e of exts) {
			const p = path.join(dir.replace(/^"|"$/g, ''), name + e);
			try {
				if (fs.statSync(p).isFile()) return p;
			} catch {
				/* next */
			}
		}
	}
	return undefined;
}

const { keyedSecrets, sharedGlobalMemento } = require('./storage');

/**
 * @param {{ engineDir: string, workspace?: string, dataDir: string, rpc: (op: string, args?: object) => Promise<any>, key?: Buffer }} o
 */
function createDesktopShim(o) {
	const { createShim, install } = require(path.join(o.engineDir, 'vscode-shim.js'));
	const rpc = o.rpc;
	const prompt = options => o.prompt ? o.prompt(options) : Promise.reject(new Error('The desktop dialog is unavailable.'));
	const message = (level, text, items) => items.length > 2
		? prompt({ kind: 'pick', title: text, items: items.map(label => ({ label })) }).then(i => i === undefined ? undefined : items[i])
		: rpc('message', { level, message: text, items }).then(r => r ?? undefined);
	const ui = {
		info: (text, items) => message('info', text, items),
		warn: (text, items) => message('warning', text, items),
		error: (message) => rpc('message', { level: 'error', message, items: [] }).then(() => undefined),
		openDialog: async (opts) =>
			(await rpc('openDialog', {
				folders: !!opts.canSelectFolders && !opts.canSelectFiles,
				many: !!opts.canSelectMany,
				title: opts.title || opts.openLabel || '',
				filters: filters(opts.filters),
				defaultPath: opts.defaultUri && opts.defaultUri.fsPath ? opts.defaultUri.fsPath : undefined
			})) || [],
		saveDialog: async (opts) =>
			(await rpc('saveDialog', {
				title: opts.title || opts.saveLabel || '',
				filters: filters(opts.filters),
				defaultPath: opts.defaultUri && opts.defaultUri.fsPath ? opts.defaultUri.fsPath : undefined
			})) || undefined,
		openExternal: (url) => rpc('openExternal', { url: String(url) }).then((r) => r !== false),
		clipboard: {
			readText: () => rpc('clipboardRead').then((s) => (typeof s === 'string' ? s : '')),
			writeText: (text) => rpc('clipboardWrite', { text: String(text) }).then(() => undefined)
		}
	};
	const shim = createShim({ workspace: o.workspace, dataDir: o.dataDir, ui });
	const vscode = shim.vscode;
	let currentContext;
	const disposables = new Set();
	const { filesystemWatcher } = require('./filesystem-watcher');
	vscode.workspace.createFileSystemWatcher = (pattern, ...ignore) => {
		const watcher = filesystemWatcher(pattern, o.workspace, ...ignore);
		for (const name of ['onDidCreate', 'onDidChange', 'onDidDelete']) {
			const subscribe = watcher[name];
			watcher[name] = (listener, thisArg, subscriptions) => subscribe(file => listener.call(thisArg, vscode.Uri.file(file)), undefined, subscriptions);
		}
		disposables.add(watcher); return watcher;
	};
	const { outputChannel } = require('./output-channel');
	vscode.window.createOutputChannel = name => {
		const channel = outputChannel(String(name), path.join(o.dataDir, 'workspaces', crypto.createHash('sha256').update(o.workspace || '').digest('hex').slice(0, 20)), prompt);
		disposables.add(channel); return channel;
	};
	shim.dispose = () => { for (const item of disposables) item.dispose(); disposables.clear(); };

	vscode.env.appName = 'zer0ne Code';
	vscode.env.desktopServiceOwner = o.serviceOwner !== false;
	vscode.env.uriScheme = 'zer0ne-code';

	// Open folder: no argument → pick one; a folder → switch this window in place.
	// The shell keeps one engine alive per project, so the run left behind keeps
	// going in the background — the app never reboots and never spawns a second
	// window from inside the page (a second app window only comes from the OS:
	// opening a folder file in Explorer, the taskbar, the command line).
	vscode.commands.registerCommand('vscode.openFolder', async (uri) => {
		const folder = uri && uri.fsPath ? uri.fsPath : null;
		const state = currentContext && currentContext.globalState;
		const key = folder ? 'aiChat.projectHandoff.' + require(path.join(o.engineDir, 'out', 'providerStore.js')).projectPathKey(folder) : null;
		const handoff = state && key ? state.get(key) : undefined;
		// The destination receives this out-of-band; ready must not consume it again.
		if (state) {
			if (key) await state.update(key, undefined);
			state.flush();
		}
		await rpc('openFolder', { path: folder, newWindow: false, handoff: handoff || null });
	});
	vscode.commands.registerCommand('revealFileInOS', async (uri) => {
		if (uri && uri.fsPath) await rpc('reveal', { path: uri.fsPath });
	});

	vscode.commands.registerCommand('simpleBrowser.show', async value => { const url = new URL(value); if (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)) return rpc('openApplet', {url:url.href}); return ui.openExternal(url.href); });
	vscode.commands.registerCommand('zer0ne.showReport', (content, title) => prompt({ kind: 'report', content, title }));
	vscode.commands.registerCommand('zer0ne.previewArtifact', (file, title) => o.previewArtifact(file, title));

	// Files open in VS Code when it is installed (at the line), else in the default app.
	vscode.window.showTextDocument = async (docOrUri, opts) => {
		const uri = docOrUri && docOrUri.uri ? docOrUri.uri : docOrUri;
		const file = uri && uri.fsPath;
		if (!file || uri.scheme !== 'file') return undefined;
		const line = opts && opts.selection && opts.selection.start ? opts.selection.start.line + 1 : 0;
		await rpc('openTextDocument', { path: file, line });
		return undefined;
	};
	vscode.window.showQuickPick = async (items, opts) => {
		const list = await Promise.resolve(items);
		if (!list?.length) return opts?.canPickMany ? [] : undefined;
		const pick = await prompt({ kind: 'pick', title: opts?.title || opts?.placeHolder || 'Choose', many: !!opts?.canPickMany, items: list.map(i => typeof i === 'string' ? { label: i } : { label: i.label, description: i.description, detail: i.detail, disabled: i.kind === -1 }) });
		return Array.isArray(pick) ? pick.map(i => list[i]) : pick === undefined ? undefined : list[pick];
	};
	vscode.window.showInputBox = async (opts = {}) => {
		let failure = '';
		while (true) {
			const value = await prompt({ kind: 'input', title: opts.title || 'Enter a value', prompt: failure || opts.prompt, value: opts.value, placeholder: opts.placeHolder, password: !!opts.password });
			if (value === undefined) return undefined;
			const validation = opts.validateInput ? await opts.validateInput(value) : undefined;
			if (!validation) return value;
			if (typeof validation === 'object' && validation.severity !== 3) return value;
			failure = typeof validation === 'string' ? validation : validation.message;
		}
	};
	const authEvents = new vscode.EventEmitter();
	vscode.authentication = { ...githubAuthentication({ secrets: () => currentContext?.secrets, prompt, fetch: o.fetch, changed: event => authEvents.fire(event) }), onDidChangeSessions: authEvents.event };

	const baseContext = shim.context;
	shim.context = (extensionRoot) => {
		const ctx = baseContext(extensionRoot);
		if (o.key) ctx.secrets = keyedSecrets(path.join(o.dataDir, 'secrets.v2.json'), o.key);
		// Several engines stay alive at once (one per project) and all share the
		// global state file, so its writes merge instead of clobbering each other.
		const { DEFAULT_SETTINGS, DESKTOP_SETTING_DEFAULTS } = require(path.join(o.engineDir, 'out', 'providerStore.js'));
		ctx.globalState = sharedGlobalMemento(path.join(o.dataDir, 'global-state.json'), { ...DEFAULT_SETTINGS, ...DESKTOP_SETTING_DEFAULTS });
		// Like VS Code, workspace state and storage belong to the open folder.
		if (o.workspace) {
			const id = crypto.createHash('sha1').update((process.platform === 'win32' ? path.resolve(o.workspace).toLowerCase() : path.resolve(o.workspace))).digest('hex').slice(0, 16);
			const dir = path.join(o.dataDir, 'workspaces', id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'folder.txt'), path.resolve(o.workspace));
			ctx.workspaceState = sharedGlobalMemento(path.join(dir, 'state.json'));
			ctx.storageUri = vscode.Uri.file(path.join(dir, 'storage'));
		}
		currentContext = ctx;
		return ctx;
	};
	return { shim, install };
}

module.exports = { createDesktopShim, keyedSecrets, onPath, sharedGlobalMemento };
