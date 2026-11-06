'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-command-input-')));
const script = path.join(base, 'echo-stdin.js');
fs.writeFileSync(
	script,
	"process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{process.stdout.write('got:'+d.trim()+'\\n');if(d.includes('quit'))process.exit(0)});"
);
// moreTools loads the editor API at require time; agentTools first keeps the module cycle intact (as the app loads it).
const { createShim, install } = require('./vscode-shim');
install(createShim({ workspace: base, dataDir: path.join(base, 'data') }).vscode);
require(path.join(OUT, 'tools/agentTools'));
const { startBackground, writeStdin, takeOutput, waitForOutput, killAllBackground } = require(path.join(OUT, 'tools/moreTools'));

const ctx = (sessionId = 'session-1') => ({ sessionId, taskId: 'turn-1' });
const quote = (value) => (process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`);
const command = process.platform === 'win32' ? `& ${quote(process.execPath)} ${quote(script)}` : `${quote(process.execPath)} ${quote(script)}`;
const settle = async (p, ms = 5000) => {
	const deadline = Date.now() + ms;
	while (p.code === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
};

test.after(() => {
	killAllBackground();
	fs.rmSync(base, { recursive: true, force: true });
});

test('command_input writes to a background command stdin', async () => {
	const p = startBackground(command, base, undefined, process.env, ctx());
	writeStdin(p.id, ctx(), 'hello');
	await waitForOutput(p, 5);
	assert.match(takeOutput(p, false), /got:hello/);
	writeStdin(p.id, ctx(), 'quit');
	await settle(p);
	assert.equal(p.code, 0);
});

test('another chat cannot write to that command', async () => {
	const p = startBackground(command, base, undefined, process.env, ctx('session-2'));
	try {
		assert.throws(() => writeStdin(p.id, ctx('other-session'), 'hello'), /No background command/);
	} finally {
		writeStdin(p.id, ctx('session-2'), 'quit');
		await settle(p);
	}
});

test('a finished command refuses more input', async () => {
	const p = startBackground(command, base, undefined, process.env, ctx('session-3'));
	writeStdin(p.id, ctx('session-3'), 'quit');
	await settle(p);
	assert.throws(() => writeStdin(p.id, ctx('session-3'), 'again'), /already finished/);
});
