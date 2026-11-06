/*
 * The part of the VS Code API the zer0ne engine uses, implemented on plain
 * Node.js (and Electron when available) — so the same ChatController runs
 * in the desktop app without VS Code. Anything editor-only (diagnostics,
 * open editors, VS Code's Copilot models) is empty here.
 *
 * createShim({ workspace, dataDir, ui }) → the `vscode` module object.
 *   ui: optional { info(msg, items), warn(msg, items), error(msg), openDialog(opts), saveDialog(opts), openExternal(url), clipboard }
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function createShim(opts) {
	const dataDir = opts.dataDir;
	fs.mkdirSync(dataDir, { recursive: true });
	const ui = opts.ui || {};
	let workspaceDir = opts.workspace ? path.resolve(opts.workspace) : undefined;

	class Uri {
		constructor(scheme, fsPath, query) {
			this.scheme = scheme;
			this.fsPath = scheme === 'file' ? path.resolve(fsPath) : fsPath;
			this.path = this.fsPath.replace(/\\/g, '/');
			this.query = query || '';
		}
		static file(p) {
			return new Uri('file', p);
		}
		static joinPath(u, ...parts) {
			return new Uri(u.scheme, path.join(u.fsPath, ...parts));
		}
		static parse(s) {
			const m = /^([a-z][\w+.-]*):/i.exec(s);
			if (m && m[1].toLowerCase() === 'file') return new Uri('file', decodeURIComponent(s.replace(/^file:\/\/\/?/i, process.platform === 'win32' ? '' : '/')));
			const u = new Uri(m ? m[1] : 'file', s);
			u.toString = () => s;
			return u;
		}
		static from(o) {
			const u = new Uri(o.scheme, o.path, o.query);
			u.toString = () => o.scheme + ':' + o.path + (o.query ? '?' + o.query : '');
			return u;
		}
		with(o) {
			return Uri.from({ scheme: this.scheme, path: this.path, query: this.query, ...o });
		}
		toString() {
			return this.scheme === 'file' ? 'file:///' + this.path.replace(/^\//, '') : this.scheme + ':' + this.path;
		}
	}

	/** Memento persisted as JSON (globalState / workspaceState). */
	function fileMemento(file) {
		let data = {};
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			data = {};
		}
		let timer;
		// A debounced state write must never take the app down: the data folder can
		// be gone (uninstalled, moved, a test that cleaned up) by the time it fires.
		const flush = () => {
			try {
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, JSON.stringify(data));
			} catch {
				/* the memento is best-effort on disk */
			}
		};
		return {
			get: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
			update: async (k, v) => {
				if (v === undefined) delete data[k];
				else data[k] = JSON.parse(JSON.stringify(v));
				clearTimeout(timer);
				timer = setTimeout(flush, 150);
			},
			keys: () => Object.keys(data),
			setKeysForSync() {},
			flush
		};
	}

	/** Secrets: Electron safeStorage when available (OS keychain), else AES with a per-user key file. */
	function secretStore(file) {
		let safe = null;
		try {
			safe = require('electron').safeStorage;
			if (!safe || !safe.isEncryptionAvailable()) safe = null;
		} catch {
			safe = null;
		}
		const keyFile = path.join(dataDir, '.key');
		let key;
		if (!safe) {
			try {
				key = fs.readFileSync(keyFile);
			} catch {
				key = crypto.randomBytes(32);
				fs.writeFileSync(keyFile, key, { mode: 0o600 });
			}
		}
		const enc = (s) => {
			if (safe) return safe.encryptString(s).toString('base64');
			const iv = crypto.randomBytes(12);
			const c = crypto.createCipheriv('aes-256-gcm', key, iv);
			const out = Buffer.concat([c.update(s, 'utf8'), c.final()]);
			return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
		};
		const dec = (b64) => {
			const buf = Buffer.from(b64, 'base64');
			if (safe) return safe.decryptString(buf);
			const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
			d.setAuthTag(buf.subarray(12, 28));
			return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
		};
		let data = {};
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {
			data = {};
		}
		const save = () => fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
		const listeners = new Set();
		return {
			get: async (k) => {
				try {
					return k in data ? dec(data[k]) : undefined;
				} catch {
					return undefined;
				}
			},
			store: async (k, v) => {
				data[k] = enc(v);
				save();
				listeners.forEach((l) => l({ key: k }));
			},
			delete: async (k) => {
				delete data[k];
				save();
			},
			onDidChange: (l) => (listeners.add(l), { dispose: () => listeners.delete(l) })
		};
	}

	class EventEmitter {
		constructor() {
			this.ls = new Set();
			this.event = (l) => (this.ls.add(l), { dispose: () => this.ls.delete(l) });
		}
		fire(e) {
			this.ls.forEach((l) => l(e));
		}
		dispose() {
			this.ls.clear();
		}
	}
	class Disposable {
		constructor(f) {
			this.dispose = f || (() => undefined);
		}
		static from(...ds) {
			return new Disposable(() => ds.forEach((d) => d && d.dispose && d.dispose()));
		}
	}
	const noop = () => new Disposable();
	const SKIP = /(^|[\\/])(node_modules|\.git|dist|out|build|\.next|coverage|__pycache__|\.venv)([\\/]|$)/;
	function walk(dir, out, limit) {
		let entries = [];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const e of entries) {
			if (out.length >= limit) break;
			const p = path.join(dir, e.name);
			if (SKIP.test(p)) continue;
			if (e.isDirectory()) walk(p, out, limit);
			else out.push(p);
		}
		return out;
	}
	const globRe = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?') + '$');
	const configDefaults = {};
	const commands = new Map();
	const tabs = { all: [], onDidChangeTabs: noop, onDidChangeTabGroups: noop };

	const vscode = {
		version: '1.99.0-zer0ne-desktop',
		Uri,
		EventEmitter,
		Disposable,
		RelativePattern: class {
			constructor(base, pattern) {
				this.base = typeof base === 'string' ? base : base.uri ? base.uri.fsPath : base.fsPath;
				this.pattern = pattern;
			}
		},
		Range: class {
			constructor(a, b, c, d) {
				this.start = typeof a === 'object' ? a : { line: a, character: b };
				this.end = typeof a === 'object' ? b : { line: c, character: d };
			}
		},
		Position: class {
			constructor(line, character) {
				this.line = line;
				this.character = character;
			}
		},
		Selection: class {},
		ThemeIcon: class {
			constructor(id) {
				this.id = id;
			}
		},
		ThemeColor: class {},
		MarkdownString: class {
			constructor(v) {
				this.value = v || '';
			}
		},
		TabInputText: class {},
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		StatusBarAlignment: { Left: 1, Right: 2 },
		ViewColumn: { Active: -1, Beside: -2, One: 1 },
		ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
		InlineCompletionItem: class {},
		LanguageModelChatMessage: { User: (c) => ({ role: 'user', content: c }), Assistant: (c) => ({ role: 'assistant', content: c }) },
		workspace: {
			get name() {
				return workspaceDir ? path.basename(workspaceDir) : undefined;
			},
			get workspaceFolders() {
				return workspaceDir ? [{ uri: Uri.file(workspaceDir), name: path.basename(workspaceDir), index: 0 }] : undefined;
			},
			textDocuments: [],
			asRelativePath: (u) => (workspaceDir ? path.relative(workspaceDir, typeof u === 'string' ? u : u.fsPath).replace(/\\/g, '/') : String(u.fsPath || u)),
			getWorkspaceFolder: (u) => (workspaceDir && (u.fsPath || '').startsWith(workspaceDir) ? { uri: Uri.file(workspaceDir), name: path.basename(workspaceDir), index: 0 } : undefined),
			findFiles: async (include, _exclude, max) => {
				if (!workspaceDir) return [];
				const pattern = typeof include === 'string' ? include : include && include.pattern ? include.pattern : '**/*';
				const re = globRe(pattern);
				return walk(workspaceDir, [], max || 20000)
					.filter((f) => re.test(path.relative(workspaceDir, f).replace(/\\/g, '/')))
					.map((f) => Uri.file(f));
			},
			fs: {
				readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
				writeFile: async (u, b) => {
					fs.mkdirSync(path.dirname(u.fsPath), { recursive: true });
					fs.writeFileSync(u.fsPath, Buffer.from(b));
				},
				stat: async (u) => {
					const s = fs.statSync(u.fsPath);
					return { size: s.size, type: s.isDirectory() ? 2 : 1, mtime: s.mtimeMs, ctime: s.ctimeMs };
				},
				createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
				delete: async (u, o) => fs.rmSync(u.fsPath, { force: true, recursive: !!(o && o.recursive) }),
				rename: async (a, b) => fs.renameSync(a.fsPath, b.fsPath),
				copy: async (a, b) => fs.cpSync(a.fsPath, b.fsPath, { recursive: true }),
				readDirectory: async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1])
			},
			getConfiguration: (section) => ({
				get: (k, d) => {
					const full = section ? section + '.' + k : k;
					return full in configDefaults ? configDefaults[full] : d;
				},
				has: () => false,
				inspect: () => ({}),
				update: async (k, v) => {
					configDefaults[section ? section + '.' + k : k] = v;
				}
			}),
			openTextDocument: async (u) => {
				const p = typeof u === 'string' ? u : u.fsPath;
				const text = fs.readFileSync(p, 'utf8');
				return { uri: Uri.file(p), getText: () => text, lineCount: text.split('\n').length, languageId: path.extname(p).slice(1), isDirty: false, save: async () => true };
			},
			applyEdit: async () => true,
			onDidChangeConfiguration: noop,
			onDidChangeWorkspaceFolders: noop,
			onDidSaveTextDocument: noop,
			onDidChangeTextDocument: noop,
			onDidOpenTextDocument: noop,
			createFileSystemWatcher: () => ({ onDidCreate: noop, onDidDelete: noop, onDidChange: noop, dispose() {} }),
			registerTextDocumentContentProvider: noop,
			isTrusted: true
		},
		window: {
			activeTextEditor: undefined,
			visibleTextEditors: [],
			terminals: [],
			tabGroups: tabs,
			state: { focused: true },
			showInformationMessage: async (msg, ...items) => (ui.info ? ui.info(String(msg), items.filter((x) => typeof x === 'string')) : (console.log('[info]', msg), undefined)),
			showWarningMessage: async (msg, ...items) => (ui.warn ? ui.warn(String(msg), items.filter((x) => typeof x === 'string')) : (console.log('[warn]', msg), undefined)),
			showErrorMessage: async (msg) => (ui.error ? ui.error(String(msg)) : console.error('[error]', msg)),
			showOpenDialog: async (o) => (ui.openDialog ? (await ui.openDialog(o || {})).map((p) => Uri.file(p)) : undefined),
			showSaveDialog: async (o) => (ui.saveDialog ? ((p) => (p ? Uri.file(p) : undefined))(await ui.saveDialog(o || {})) : undefined),
			showQuickPick: async () => undefined,
			showInputBox: async () => undefined,
			showTextDocument: async () => undefined,
			createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
			createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
			createTerminal: () => ({ show() {}, sendText() {}, dispose() {} }),
			withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: noop }),
			onDidChangeActiveTextEditor: noop,
			onDidChangeTextEditorSelection: noop,
			onDidChangeWindowState: noop,
			onDidChangeVisibleTextEditors: noop,
			onDidCloseTerminal: noop,
			registerWebviewViewProvider: noop,
			createWebviewPanel: () => {
				throw new Error('Not available in the desktop app.');
			}
		},
		languages: { getDiagnostics: () => [], registerInlineCompletionItemProvider: noop, onDidChangeDiagnostics: noop },
		commands: {
			registerCommand: (id, fn) => (commands.set(id, fn), new Disposable(() => commands.delete(id))),
			executeCommand: async (id, ...a) => (commands.has(id) ? commands.get(id)(...a) : undefined),
			getCommands: async () => [...commands.keys()]
		},
		env: {
			appName: 'zer0ne coding',
			appRoot: path.dirname(process.execPath),
			language: 'en',
			machineId: crypto.createHash('sha256').update(os.hostname()).digest('hex'),
			uriScheme: 'zer0ne',
			openExternal: async (u) => (ui.openExternal ? ui.openExternal(String(u)) : false),
			asExternalUri: async (u) => u,
			clipboard: ui.clipboard || { text: '', readText: async function () { return this.text; }, writeText: async function (s) { this.text = s; } }
		},
		authentication: { getSession: async () => undefined, onDidChangeSessions: noop },
		lm: { selectChatModels: async () => [], onDidChangeChatModels: noop },
		extensions: { getExtension: () => undefined, all: [] }
	};

	/** The ExtensionContext the controller is built with. */
	function context(extensionRoot) {
		return {
			extensionUri: Uri.file(extensionRoot),
			extensionPath: extensionRoot,
			globalStorageUri: Uri.file(path.join(dataDir, 'global')),
			storageUri: Uri.file(path.join(dataDir, 'workspace')),
			globalState: fileMemento(path.join(dataDir, 'global-state.json')),
			workspaceState: fileMemento(path.join(dataDir, 'workspace-state.json')),
			secrets: secretStore(path.join(dataDir, 'secrets.json')),
			subscriptions: [],
			extension: { packageJSON: require(path.join(extensionRoot, 'package.json')) }
		};
	}

	return {
		vscode,
		context,
		setWorkspace(dir) {
			workspaceDir = dir ? path.resolve(dir) : undefined;
		}
	};
}

/** Make `require('vscode')` return the shim for everything loaded afterwards. */
function install(shimVscode) {
	const Module = require('module');
	const resolve = Module._resolveFilename;
	Module._resolveFilename = function (req, ...rest) {
		return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest);
	};
	require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: shimVscode };
}

module.exports = { createShim, install };
