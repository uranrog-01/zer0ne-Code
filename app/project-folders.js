'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function contains(parent, child) {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function deletionTarget(raw, protectedPaths = []) {
	if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw new Error('Choose a known absolute project folder.');
	const folder = path.resolve(raw);
	const stat = fs.lstatSync(folder);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a project directory, not a linked folder.');
	const real = fs.realpathSync.native(folder);
	const protectedRoots = [path.parse(real).root, os.homedir()];
	for (const root of protectedRoots.filter(Boolean)) {
		let resolved = path.resolve(root);
		try { resolved = fs.realpathSync.native(resolved); } catch { /* A new data folder may not exist yet. */ }
		if (contains(real, resolved)) throw new Error('This folder contains application, system or user data and cannot be deleted here.');
	}
	for (const root of protectedPaths.filter(Boolean)) {
		let resolved = path.resolve(root);
		try { resolved = fs.realpathSync.native(resolved); } catch { /* The application data folder may not exist yet. */ }
		if (contains(real, resolved) || contains(resolved, real)) throw new Error('Application and system folders cannot be deleted here.');
	}
	return real;
}

async function deleteFolder(raw, { protectedPaths, confirm, check, release, trash }) {
	const folder = deletionTarget(raw, protectedPaths);
	check(folder);
	if (!await confirm(folder)) return false;
	if (deletionTarget(raw, protectedPaths) !== folder) throw new Error('The project folder changed while confirming deletion.');
	check(folder);
	await release(folder);
	if (deletionTarget(raw, protectedPaths) !== folder) throw new Error('The project folder changed before deletion.');
	check(folder);
	await trash(folder);
	return true;
}

module.exports = { contains, deletionTarget, deleteFolder };
