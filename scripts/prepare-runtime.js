'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const development = path.join(root, 'node_modules', 'electron', 'dist');
const packaged = path.join(root, 'dist', 'win-unpacked');

function prepareRuntime(directory = development) {
	const target = path.resolve(directory);
	if (target !== development && target !== packaged) throw new Error('Unexpected runtime directory: ' + target);
	// The idempotent installer also repairs missing executables, stale versions and absent path metadata.
	if (target === development) {
		execFileSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'install.js')], { windowsHide: true, stdio: 'inherit' });
		const executable = path.join(target, process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron');
		if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('Electron installation did not produce the expected runtime executable: ' + executable);
	}
	if (process.platform !== 'win32') return;
	if (target === packaged) {
		const executable = path.join(target, 'zer0ne Code.exe');
		if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) throw new Error('The packaged runtime executable is missing. Rebuild the app: ' + executable);
	}
	// A Low label inherited from an extracted workspace lowers the broker's token and
	// prevents sandboxed renderers from loading DLLs. Change only our runtime binaries.
	const binaries = fs.readdirSync(target, { withFileTypes: true })
		.filter(entry => entry.isFile() && /\.(exe|dll)$/i.test(entry.name))
		.map(entry => path.join(target, entry.name));
	for (const binary of binaries) execFileSync('icacls.exe', [binary, '/setintegritylevel', 'M'], { windowsHide: true, stdio: 'pipe' });
}

module.exports = { prepareRuntime };
if (require.main === module) {
	if (process.argv.length > 2) throw new Error('Usage: node scripts/prepare-runtime.js');
	prepareRuntime();
}
