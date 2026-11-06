// Quick static check of the app's own JavaScript (npm run check): every file parses,
// and the files the app needs at runtime are present.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;
for (const dir of ['app', 'host', 'ui', 'scripts', 'test']) {
	for (const file of fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js'))) {
		const r = spawnSync(process.execPath, ['--check', path.join(root, dir, file)], { encoding: 'utf8' });
		if (r.status !== 0) {
			failed++;
			console.error(`${dir}/${file}: ${r.stderr.trim()}`);
		}
	}
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const file of [pkg.main, 'app/preload.js', 'app/desktop-ui.js', 'app/desktop-glass.js', 'ui/index.html', 'host/main.js', 'host/protocol.js','engine/vscode-shim.js', 'assets/icon.ico', 'assets/icon.png', 'assets/loadingbanner.png']) {
	if (!fs.existsSync(path.join(root, file))) {
		failed++;
		console.error('missing: ' + file);
	}
}
if (failed) process.exit(1);
console.log('app ok');
