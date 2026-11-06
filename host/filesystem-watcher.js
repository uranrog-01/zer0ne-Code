'use strict';
const fs = require('fs');
const path = require('path');

function filesystemWatcher(pattern, workspace, ignoreCreate = false, ignoreChange = false, ignoreDelete = false) {
	const base = path.resolve(typeof pattern === 'object' ? pattern.baseUri?.fsPath || pattern.base || workspace || '.' : workspace || '.');
	const glob = String(typeof pattern === 'object' ? pattern.pattern : pattern).replace(/\\/g, '/');
	const prefix = glob.split('/').filter((part, i, all) => !all.slice(0, i + 1).some(p => /[*?{]/.test(p))).join('/');
	const root = path.resolve(base, prefix);
	const escaped = glob.replace(/[.+^$()|[\]\\]/g, '\\$&');
	const regex = new RegExp('^' + escaped.replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
	const events = { create: new Set(), change: new Set(), delete: new Set() };
	let disposed = false;
	let native, nativeIdentity, pending;
	const collect = () => {
		const files = new Map();
		const walk = file => {
			let stat;
			try { stat = fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
			if (stat.isSymbolicLink()) return;
			if (stat.isDirectory()) {
				if (!prefix && ['.git', 'node_modules', 'target'].includes(path.basename(file))) return;
				if (regex.test(path.relative(base, file).replace(/\\/g, '/'))) files.set(file, 'directory');
				for (const name of fs.readdirSync(file)) walk(path.join(file, name));
			} else if (regex.test(path.relative(base, file).replace(/\\/g, '/'))) files.set(file, `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
		};
		walk(root);
		return files;
	};
	let previous = collect();
	const emit = (event, file) => { for (const listener of events[event]) { try { listener(file); } catch (err) { console.error('File watcher listener failed:', err.message); } } };
	const scan = () => {
		if (disposed) return;
		try {
			const current = collect();
			for (const [file, stamp] of current) {
				if (!previous.has(file)) { if (!ignoreCreate) emit('create', file); }
				else if (previous.get(file) !== stamp && !ignoreChange) emit('change', file);
			}
			if (!ignoreDelete) for (const file of previous.keys()) if (!current.has(file)) emit('delete', file);
			previous = current;
		} catch (err) { console.error('File watcher failed:', err.message); }
	};
	const watch = () => {
		try {
			const stat = fs.statSync(root); const identity = `${stat.dev}:${stat.ino}`;
			if (native && identity === nativeIdentity) return;
			native?.close(); native = undefined;
			// Windows libuv compares event paths with the watched root; 8.3 aliases can crash that comparison.
			const canonical = fs.realpathSync.native(root);
			native = fs.watch(canonical, { recursive: true, persistent: false }, (_event, filename) => {
				if (filename && !prefix && String(filename).split(/[\\/]/).some(part => ['.git', 'node_modules', 'target'].includes(part))) return;
				clearTimeout(pending); pending = setTimeout(scan, 40); pending.unref?.();
			});
			nativeIdentity = identity;
			native.on('error', () => { native?.close(); native = undefined; });
		} catch { native?.close(); native = undefined; }
	};
	watch();
	// Poll only when native watching is unavailable; metadata polling also repairs a removed root.
	const timer = setInterval(() => { if (!native) scan(); watch(); }, 150);
	timer.unref?.();
	const on = event => (listener, thisArg, disposables) => {
		const wrapped = value => listener.call(thisArg, value);
		events[event].add(wrapped);
		const subscription = { dispose: () => events[event].delete(wrapped) };
		disposables?.push(subscription); return subscription;
	};
	return { onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'), ignoreCreateEvents: ignoreCreate, ignoreChangeEvents: ignoreChange, ignoreDeleteEvents: ignoreDelete,
		dispose() { disposed = true; clearInterval(timer); clearTimeout(pending); native?.close(); for (const listeners of Object.values(events)) listeners.clear(); } };
}

module.exports = { filesystemWatcher };
