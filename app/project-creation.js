'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A selection belongs to the calling page, never a path supplied by that page.
class ProjectCreation {
	constructor() { this.selections = new WeakMap(); }
	async pick(sender, picker) {
		const selected = await picker();
		if (!selected) return null;
		const folder = fs.realpathSync.native(selected);
		const stat = fs.statSync(folder);
		if (!stat.isDirectory()) throw new Error('Choose an available project folder.');
		const selection = crypto.randomBytes(24).toString('hex');
		this.selections.set(sender, { selection, folder, selected, dev: stat.dev, ino: stat.ino });
		return { selection, path: folder, name: path.basename(folder) || folder };
	}
	async create(sender, args, open) {
		const chosen = this.selections.get(sender);
		if (!chosen || chosen.selection !== args.selection || args.trusted !== true) throw new Error('Choose a folder and confirm that you trust it.');
		const name = typeof args.name === 'string' ? args.name.trim() : '';
		if (!name || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Enter a project name of 1–100 characters.');
		const folder = fs.realpathSync.native(chosen.selected);
		const stat = fs.statSync(folder);
		if (folder !== chosen.folder || !stat.isDirectory() || stat.dev !== chosen.dev || stat.ino !== chosen.ino) {
			this.selections.delete(sender);
			throw new Error('The folder changed. Choose it again before trusting it.');
		}
		this.selections.delete(sender);
		await open(folder, { kind: 'project', name });
		return true;
	}
}

module.exports = { ProjectCreation };
