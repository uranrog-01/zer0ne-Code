'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { outputLock, retryPackaging } = require('../scripts/package-retry');

const directory = 'C:\\fixture\\dist\\win-unpacked';
const busy = { status:1, output:`EBUSY: resource busy or locked, open '${directory}\\zer0ne Code.exe'` };

test('both reported Windows lock failures are recognized only within the configured release output', () => {
	assert(outputLock(busy.output, directory));
	assert(outputLock(`EPERM: operation not permitted, rename '${directory}.tmp' -> '${directory}'`, directory));
	assert(outputLock(`EACCES: permission denied, unlink '${directory}/resources/app.asar'`, directory));
	assert.equal(outputLock(`EBUSY: resource busy or locked, open '${directory}-other/another.exe'`, directory), false);
	assert.equal(outputLock("EBUSY: resource busy or locked, open 'C:/unrelated/private.exe'", directory), false);
	assert.equal(outputLock('A signing error occurred at ' + directory, directory), false);
});

test('transient executable locks retry and succeed with source/running-app guards before every retry', async () => {
	let calls = 0, guards = 0;
	const delays = [];
	const result = await retryPackaging(async () => ++calls < 3 ? busy : { status:0, output:'done' }, directory, {
		platform:'win32', beforeRetry:() => { guards++; }, wait:async ms => { delays.push(ms); }, report() {}
	});
	assert.equal(result.status, 0);
	assert.equal(calls, 3);
	assert.equal(guards, 2);
	assert.deepEqual(delays, [1000, 2000]);
});

test('a persistent lock stops after three retries and preserves the failure', async () => {
	let calls = 0;
	const result = await retryPackaging(async () => { calls++; return busy; }, directory, { platform:'win32', wait:async () => {}, report() {} });
	assert.equal(calls, 4);
	assert.equal(result, busy);
});

test('signing errors, other paths and non-Windows failures do not retry', async () => {
	for (const [result, platform] of [[{ status:7, output:'Code signing certificate unavailable' }, 'win32'], [{ status:1, output:"EPERM: open 'C:/unrelated/file'" }, 'win32'], [busy, 'linux'], [{ status:0, output:busy.output }, 'win32']]) {
		let calls = 0;
		assert.equal(await retryPackaging(async () => { calls++; return result; }, directory, { platform, report() {}, wait:async () => {} }), result);
		assert.equal(calls, 1);
	}
});

test('source changes or an app started during packaging abort the retry', async () => {
	for (const message of ['Source changed during validation/build', 'Quit zer0ne Code from the tray']) {
		let calls = 0;
		await assert.rejects(retryPackaging(async () => { calls++; return busy; }, directory, { platform:'win32', beforeRetry:() => { throw new Error(message); }, report() {}, wait:async () => assert.fail('must not wait after a guard failure') }), { message });
		assert.equal(calls, 1);
	}
});

test('a real Windows executable-file lock is retried after its owner releases the handle', { skip:process.platform !== 'win32' }, async t => {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-package-lock-'));
	const output = path.join(folder, 'win-unpacked');
	fs.mkdirSync(output);
	const file = path.join(output, 'fixture.exe');
	fs.writeFileSync(file, 'before');
	const script = "$stream=[IO.File]::Open('" + file.replace(/'/g, "''") + "',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('locked'); [Console]::In.ReadLine() | Out-Null } finally { $stream.Dispose() }";
	const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide:true, env:require('./test-env').testEnv(), stdio:['pipe','pipe','pipe'] });
	const closed = new Promise(resolve => child.once('close', resolve));
	t.after(async () => {
		child.stdin.end();
		if (child.exitCode === null) child.kill();
		await closed;
		assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
		assert(path.basename(folder).startsWith('zc-package-lock-'));
		fs.rmSync(folder, { recursive:true, force:true });
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('File-lock fixture did not start')), 10000);
		child.once('error', error => { clearTimeout(timer); reject(error); });
		child.once('close', () => { clearTimeout(timer); reject(new Error('File-lock fixture exited before acquiring its handle')); });
		child.stdout.once('data', chunk => { clearTimeout(timer); assert.match(chunk.toString(), /locked/); resolve(); });
	});
	let attempts = 0;
	const result = await retryPackaging(async () => {
		attempts++;
		try { fs.writeFileSync(file, 'after'); return { status:0, output:'' }; }
		catch (error) { return { status:1, output:String(error) }; }
	}, output, { report() {}, wait:async () => { child.stdin.end('\n'); assert.equal(await closed, 0); } });
	assert.equal(result.status, 0);
	assert.equal(attempts, 2);
	assert.equal(fs.readFileSync(file, 'utf8'), 'after');
});
