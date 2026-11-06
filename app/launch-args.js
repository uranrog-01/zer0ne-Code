'use strict';
const path = require('path');

function folderArgs(argv, { packaged, entry, cwd = process.cwd() }) {
	let skippedEntry = packaged;
	const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
	const folders = [];
	for (const arg of argv.slice(1)) {
		if (arg.startsWith('-')) continue;
		const folder = path.resolve(cwd, arg);
		if (!skippedEntry && key(folder) === key(path.resolve(entry))) { skippedEntry = true; continue; }
		folders.push(folder);
	}
	return folders;
}

module.exports = { folderArgs };
