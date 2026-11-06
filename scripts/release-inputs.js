'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function snapshot(directory = root) {
	const files = {};
	function walk(relative) {
		const absolute = path.join(directory, relative);
		if (!fs.existsSync(absolute)) return;
		const stat = fs.lstatSync(absolute);
		if (stat.isSymbolicLink()) throw new Error('Release inputs cannot contain links: ' + relative);
		if (stat.isDirectory()) {
			for (const name of fs.readdirSync(absolute).sort()) if (!['node_modules', 'output', '.git'].includes(name)) walk(relative + '/' + name);
		} else if (stat.isFile() && relative !== 'app/release-integrity.json') files[relative] = digest(fs.readFileSync(absolute));
	}
	for (const relative of ['app', 'host', 'ui', 'assets', 'engine/src', 'engine/media', 'engine/scripts', 'engine/test', 'engine/eval', 'engine/data', 'engine/bin', 'engine/vscode-shim.js', 'engine/LICENSE', 'engine/THIRD_PARTY_NOTICES.md', 'scripts', 'test', 'package.json', 'package-lock.json', 'engine/package.json', 'engine/tsconfig.json', 'biome.json', 'build.bat', 'AGENTS.md', 'CHANGELOG.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.github']) walk(relative);
	const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
	let revision = null, dirty = true;
	try {
		revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','ignore'] }).trim();
		dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd:directory, encoding:'utf8', windowsHide:true }).trim();
	} catch { /* A source archive has no Git metadata; its content hash is still authoritative. */ }
	return { schema:1, sourceHash:digest(JSON.stringify(entries)), revision, dirty, files:Object.fromEntries(entries) };
}

function assertUnchanged(before, directory = root) {
	const after = snapshot(directory);
	if (before.sourceHash !== after.sourceHash) {
		const changed = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
		throw new Error('Source changed during validation/build: ' + [...changed].filter(file => before.files[file] !== after.files[file]).slice(0, 12).join(', ') + '. Run validation again on stable inputs.');
	}
	return after;
}

module.exports = { snapshot, assertUnchanged, digest };
