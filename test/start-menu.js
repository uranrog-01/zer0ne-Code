'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ensureStartMenuShortcut } = require('../app/start-menu');

const appData = 'C:\\Users\\u\\AppData\\Roaming', programData = 'C:\\ProgramData';
const programs = (base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const userRoot = programs(appData), userFolder = path.join(userRoot, 'zer0ne'), machineFolder = path.join(programs(programData), 'zer0ne');
const exe = 'C:\\Users\\u\\AppData\\Local\\Programs\\zer0ne Code\\zer0ne Code.exe';
const AUMID = 'dev.zer0ne.code.electron';

function run(links, execPath = exe) {
	const writes = [], made = [];
	const result = ensureStartMenuShortcut({
		execPath, aumid: AUMID, appData, programData, description: 'd',
		exists: (link) => link in links,
		read: (link) => links[link] || null,
		write: (link, operation, options) => writes.push({ link, operation, target: options.target, aumid: options.appUserModelId }),
		mkdir: (dir) => made.push(dir),
	});
	return { result, writes, made };
}

test('an installer shortcut in the zer0ne folder is kept, per user or for all users', () => {
	for (const folder of [userFolder, machineFolder]) {
		const { result, writes } = run({ [path.join(folder, 'zer0ne Code.lnk')]: { target: exe.toUpperCase(), appUserModelId: AUMID } });
		assert.equal(result, null);
		assert.deepEqual(writes, []);
	}
});

test('without any shortcut the app creates one in the per-user zer0ne folder', () => {
	const { result, writes, made } = run({});
	assert.equal(result, path.join(userFolder, 'zer0ne Code.lnk'));
	assert.deepEqual(writes, [{ link: result, operation: 'create', target: exe, aumid: AUMID }]);
	assert.deepEqual(made, [userFolder]);
});

test('an older shortcut of ours is updated in place instead of adding a second entry', () => {
	const old = path.join(userRoot, 'zer0ne Code.lnk');
	const { writes } = run({ [old]: { target: 'C:\\old\\zer0ne Code.exe', appUserModelId: AUMID } });
	assert.deepEqual(writes, [{ link: old, operation: 'replace', target: exe, aumid: AUMID }]);
});

test("another app's shortcut with the same name is never taken over", () => {
	const theirs = path.join(userFolder, 'zer0ne Code.lnk');
	const { writes } = run({ [theirs]: { target: 'C:\\other.exe', appUserModelId: 'someone.else' } });
	assert.deepEqual(writes, [{ link: path.join(userFolder, 'zer0ne Code (Electron).lnk'), operation: 'create', target: exe, aumid: AUMID }]);
});
