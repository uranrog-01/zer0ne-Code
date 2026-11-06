/*
 * What the shell remembers between runs (window.json): the last folder, recent
 * folders, window size, whether finished runs may ring an OS notification and the
 * notch's settings (the engine's Settings → Notch, synced by every engine).
 */
'use strict';
const fs = require('fs');
const path = require('path');

class ShellState {
	constructor(values = {}) {
		this.folder = typeof values.folder === 'string' ? values.folder : null;
		this.recent = Array.isArray(values.recent) ? values.recent.filter((p) => typeof p === 'string') : [];
		this.width = Number.isFinite(values.width) ? values.width : null;
		this.height = Number.isFinite(values.height) ? values.height : null;
		this.maximized = values.maximized === true;
		this.notify_on_done = values.notify_on_done !== false;
		this.notch = values.notch && typeof values.notch === 'object' ? values.notch : null;
	}

	static load(dir) {
		try {
			return new ShellState(JSON.parse(fs.readFileSync(path.join(dir, 'window.json'), 'utf8')));
		} catch {
			return new ShellState();
		}
	}

	save(dir) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			const tmp = path.join(dir, 'window.json.tmp');
			const { folder, recent, width, height, maximized, notify_on_done, notch } = this;
			fs.writeFileSync(tmp, JSON.stringify({ folder, recent, width, height, maximized, notify_on_done, notch }, null, 2));
			fs.renameSync(tmp, path.join(dir, 'window.json'));
		} catch {
			// Best effort: the window still works without remembering its size.
		}
	}

	/** The folder this window works in; recent folders keep the newest first. */
	setFolder(folder) {
		if (folder) {
			this.recent = [folder, ...this.recent.filter((r) => r !== folder)].slice(0, 12);
		}
		this.folder = folder || null;
	}
}

module.exports = { ShellState };
