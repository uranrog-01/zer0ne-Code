'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function verifyRuntime(root, manifest) {
	if (manifest?.schema !== 1 || !manifest.files || !Object.keys(manifest.files).length) throw new Error('The runtime integrity manifest is missing. Reinstall the app.');
	const canonical = fs.realpathSync(root);
	for (const [relative, expected] of Object.entries(manifest.files)) {
		if (!/^[a-f0-9]{64}$/.test(expected) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Invalid runtime integrity entry.');
		const file = path.join(canonical, relative);
		const resolved = fs.realpathSync(file), inside = path.relative(canonical, resolved);
		if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('The installed runtime contains an unexpected link. Reinstall the app.');
		const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
		if (actual !== expected) throw new Error('Installed runtime integrity check failed: ' + relative + '. Reinstall the app; your profile was not changed.');
	}
	for (const folder of SEALED) {
		if (!Object.keys(manifest.files).some(relative => relative.startsWith(folder + '/'))) continue;
		for (const relative of listFiles(canonical, folder)) {
			if (!Object.hasOwn(manifest.files, relative)) throw new Error('The installed runtime contains an unexpected file: ' + relative + '. Reinstall the app; your profile was not changed.');
		}
	}
	return true;
}

// The benchmark loads every file in these folders, so a file added after packaging is refused too.
const SEALED = ['engine/eval/cases', 'engine/eval/judge'];

function listFiles(root, folder) {
	const absolute = path.join(root, folder);
	if (!fs.existsSync(absolute)) return [];
	return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
		const relative = folder + '/' + entry.name;
		return entry.isDirectory() ? listFiles(root, relative) : [relative];
	});
}

function verifyInstalled() {
	const { app } = require('electron');
	if (app.isPackaged) verifyRuntime(path.join(process.resourcesPath, 'app.asar.unpacked'), require('./release-integrity.json'));
}

module.exports = { verifyRuntime, verifyInstalled };
