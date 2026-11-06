'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { denyReadPaths, appDenyReadPaths, sandboxDenyPaths, sameDenyRead, seatbeltProfile, bwrapArgs } = require(path.join(OUT, 'tools/sandbox'));

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-deny-read-')));

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('sandbox deny-read paths expand ~ and ignore comments, blanks and relative paths', () => {
	const home = path.join(base, 'home');
	const absolute = path.join(base, 'keys');
	const list = ['~/.ssh', '~\\aws', '# a comment', '', 'relative/dir', absolute].join('\n');
	assert.deepEqual(denyReadPaths(list, home), [path.join(home, '.ssh'), path.join(home, 'aws'), absolute]);
	assert.deepEqual(denyReadPaths('', home), []);
});

test('the seatbelt profile denies reads after its allow rules', () => {
	const target = '/home/u/.ssh';
	const profile = seatbeltProfile(false, [target]);
	assert.ok(profile.includes(`(deny file-read* (subpath "${target}"))`), profile);
	assert.ok(profile.lastIndexOf('(deny file-read*') > profile.lastIndexOf('(allow file-read*'));
	assert.ok(!seatbeltProfile(true).includes('(deny file-read*'));
});

test('bwrap masks an existing denied directory and file, and skips missing ones', () => {
	const dir = path.join(base, 'ssh');
	const file = path.join(base, 'netrc');
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(file, 'secret');
	const args = bwrapArgs(base, '/bin/sh', 'true', false, [dir, file, path.join(base, 'missing')]);
	const dirMask = args.indexOf('--tmpfs');
	assert.equal(args[dirMask + 1], dir);
	const fileMask = args.indexOf('--ro-bind', dirMask);
	assert.equal(args[fileMask + 1], '/dev/null');
	assert.equal(args[fileMask + 2], file);
	assert.ok(dirMask < args.indexOf('--die-with-parent'), 'masks apply before the command starts');
	assert.ok(!args.includes(path.join(base, 'missing')));
});

test('the app always blocks its own keys, settings, chats and checkpoints', () => {
	const data = path.join(base, 'data');
	const storage = path.join(data, 'global');
	const paths = appDenyReadPaths(storage, true);
	assert.ok(paths.includes(path.join(data, 'secrets.v2.json')));
	assert.ok(paths.includes(path.join(data, 'global-state.json')));
	assert.ok(paths.includes(path.join(data, 'workspaces')));
	assert.ok(paths.includes(path.join(storage, 'transcripts')));
	assert.ok(paths.includes(path.join(storage, 'images')));
	assert.ok(paths.includes(path.join(storage, 'checkpoints')));
	assert.deepEqual(appDenyReadPaths(storage, false), [], 'editor hosts keep secrets in the OS keychain');
	assert.deepEqual(appDenyReadPaths(path.join(base, 'other'), true), [], 'only the desktop data layout is protected');
});

test('sandboxDenyPaths merges the user list with the app paths without duplicates', () => {
	const storage = path.join(base, 'data', 'global');
	const transcripts = path.join(storage, 'transcripts');
	const merged = sandboxDenyPaths({ sandboxDenyRead: transcripts }, storage, true);
	assert.equal(merged.filter((p) => p === transcripts).length, 1);
	assert.ok(merged.includes(path.join(path.dirname(storage), 'secrets.v2.json')));
});

test('sameDenyRead compares the same paths regardless of order', () => {
	const one = path.join(base, 'one');
	const two = path.join(base, 'two');
	assert.equal(sameDenyRead([one, two], [two, one]), true);
	assert.equal(sameDenyRead([one], [one, two]), false);
	assert.equal(sameDenyRead([], []), true);
});
