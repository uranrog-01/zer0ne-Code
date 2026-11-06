'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const development = path.join(root, 'node_modules/electron/dist');
const packaged = path.join(root, 'dist/win-unpacked');
function fixture({ platform = 'win32', complete = false, installerError, installs = true } = {}) {
	const calls = [], files = new Set([development]);
	const executable = path.join(development, platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : platform === 'win32' ? 'electron.exe' : 'electron');
	if (complete) files.add(executable);
	const context = {
		__dirname: path.join(root, 'scripts'), module: { exports: {} },
		process: { platform, execPath: process.execPath, argv: [] },
		require(name) {
			if (name === 'path') return path;
			if (name === 'fs') return {
				existsSync: file => files.has(file),
				statSync: file => ({ isFile: () => files.has(file) && file !== development && file !== packaged }),
				readdirSync: folder => {
					assert(files.has(folder), 'runtime directory must exist');
					return [...files].filter(file => path.dirname(file) === folder && file !== folder).map(file => ({ name: path.basename(file), isFile: () => true }));
				}
			};
			if (name === 'child_process') return { execFileSync(command, args, options) {
				calls.push({ command, args: Array.from(args), windowsHide: options.windowsHide });
				if (command === process.execPath) {
					assert.equal(args[0], path.join(root, 'node_modules/electron/install.js'));
					if (installerError) throw installerError;
					if (installs) files.add(executable);
				}
			} };
			throw new Error('Unexpected dependency: ' + name);
		}
	};
	vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/prepare-runtime.js'), 'utf8'), context);
	return { prepare: context.module.exports.prepareRuntime, calls, files, executable };
}

test('an existing empty runtime directory is repaired before its binaries are prepared', () => {
	const f = fixture();
	f.prepare();
	assert.equal(f.calls[0]?.command, process.execPath);
	assert(f.files.has(f.executable));
	assert.deepEqual(f.calls[1], { command: 'icacls.exe', args: [f.executable, '/setintegritylevel', 'M'], windowsHide: true });
});

test('development setup delegates version and metadata checks to the idempotent installer', () => {
	const f = fixture({ complete: true });
	f.prepare();
	assert.equal(f.calls.filter(call => call.command === process.execPath).length, 1);
});

test('installer failure propagates and incomplete installation cannot report success', () => {
	const failed = fixture({ installerError: new Error('download failed') });
	assert.throws(() => failed.prepare(), /download failed/);
	assert.equal(failed.calls.length, 1);
	const missing = fixture({ installs: false });
	assert.throws(() => missing.prepare(), /runtime|installation/i);
});

test('packaged setup never downloads Electron and refuses a missing executable', () => {
	const f = fixture();
	f.files.add(packaged);
	assert.throws(() => f.prepare(packaged), /runtime|executable/i);
	assert.equal(f.calls.length, 0);
	const executable = path.join(packaged, 'zer0ne Code.exe');
	f.files.add(executable);
	f.prepare(packaged);
	assert.deepEqual(f.calls, [{ command: 'icacls.exe', args: [executable, '/setintegritylevel', 'M'], windowsHide: true }]);
});

test('non-Windows development setup checks installation without invoking Windows permissions', () => {
	for (const platform of ['linux', 'darwin']) {
		const f = fixture({ platform });
		f.prepare();
		assert(f.files.has(f.executable));
		assert.equal(f.calls.length, 1);
	}
});

test('unknown runtime directories are refused before any installer or permissions command', () => {
	const f = fixture();
	assert.throws(() => f.prepare(path.join(root, 'another-runtime')), /Unexpected runtime directory/);
	assert.equal(f.calls.length, 0);
});
