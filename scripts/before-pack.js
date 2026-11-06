'use strict';
const fs = require('fs');
const path = require('path');
const { packager } = require('./check-shipped');
const { snapshot, digest } = require('./release-inputs');

module.exports = async () => {
	const root = path.resolve(__dirname, '..');
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const ships = packager(pkg.build.files);
	const external = packager(pkg.build.asarUnpack);
	const files = {};
	function walk(relative) {
		const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
		if (stat.isSymbolicLink()) throw new Error('Packaged runtime cannot contain links: ' + relative);
		if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) walk(relative + '/' + name);
		else if (stat.isFile() && external(relative) && ships(relative)) files[relative] = digest(fs.readFileSync(absolute));
	}
	for (const relative of ['host', 'engine/out', 'engine/media', 'engine/eval', 'engine/bin', 'ui', 'assets', 'app', 'engine/package.json', 'engine/engine.json', 'engine/vscode-shim.js', 'engine/LICENSE', 'engine/THIRD_PARTY_NOTICES.md']) if (fs.existsSync(path.join(root, relative))) walk(relative);
	fs.writeFileSync(path.join(root, 'app/release-integrity.json'), JSON.stringify({ schema:1, version:pkg.version, source:snapshot(root), files }, null, 2) + '\n');
};
