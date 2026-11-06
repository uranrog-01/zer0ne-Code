// Standalone host-contract tests: node --test test/terminal-host.test.js
// Transpile only the owned host so concurrent changes in other modules cannot mask failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const test = require('node:test');
const ts = require('typescript-classic');

const source = fs.readFileSync(path.join(__dirname, '../src/host/terminalHost.ts'), 'utf8');
const code = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

/** Load the host module with `vscode` mocked; rootDir becomes the open folder. */
function load(rootDir, overrides = {}) {
	const module = { exports: {} };
	const vscode = { workspace: { workspaceFolders: rootDir ? [{ uri: { scheme: 'file', fsPath: rootDir } }] : [] } };
	vm.runInNewContext(code, {
		require: (id) => (id === 'vscode' ? vscode : overrides[id] || require(id)),
		module,
		exports: module.exports,
		process: overrides.process || process,
		console,
		Buffer,
		setTimeout,
		clearTimeout
	});
	return module.exports;
}

function setup(rootDir, overrides) {
	const posts = [];
	const statuses = [];
	const activity = [];
	const surface = { kind: 'chat', post: (m) => posts.push(m) };
	const ctx = { store: {}, postAll: (m) => activity.push(m), status: (m, k) => statuses.push([m, k]), sendState: async () => {} };
	const { TerminalHost } = load(rootDir, overrides);
	const host = new TerminalHost(ctx);
	/** Wait until a message matching the predicate arrives (or time out). */
	const waitFor = (pred, ms = 10000) =>
		new Promise((resolve, reject) => {
			const started = Date.now();
			const iv = setInterval(() => {
				const hit = posts.find(pred);
				if (hit) { clearInterval(iv); resolve(hit); }
				else if (Date.now() - started > ms) { clearInterval(iv); reject(new Error('timed out; got ' + JSON.stringify(posts.slice(-6)))); }
			}, 20);
		});
	const outputOf = (id) => posts.filter((m) => m.type === 'terminalChunk' && m.id === id).map((m) => m.text).join('');
	return { host, surface, posts, statuses, activity, waitFor, outputOf };
}

test('stripAnsi removes colors, cursor moves and OSC titles', () => {
	const { stripAnsi } = load();
	assert.equal(stripAnsi('\u001b[31mred\u001b[0m plain'), 'red plain');
	assert.equal(stripAnsi('\u001b]0;title\u0007body'), 'body');
	assert.equal(stripAnsi('a\u001b[2Kb\u001b[1;2Hc'), 'abc');
	assert.equal(stripAnsi('no escapes'), 'no escapes');
});

test('parseCd understands plain, quoted, home and windows forms', () => {
	const { parseCd: parse } = load();
	const parseCd = (cmd) => parse(cmd, 'linux');
	assert.equal(parseCd('cd'), '');
	assert.equal(parseCd('cd .'), '');
	assert.equal(parseCd('cd src'), 'src');
	assert.equal(parseCd('cd "/a/b c"'), '/a/b c');
	assert.equal(parseCd("cd 'x y'"), 'x y');
	assert.equal(parse('CD /d D:\\work', 'win32'), 'D:\\work');
	assert.equal(parseCd('cd ~'), os.homedir());
	assert.equal(parseCd('cd ~/sub'), path.join(os.homedir(), '/sub'));
	assert.equal(parseCd('cd a && b'), null);
	assert.equal(parseCd('cdx'), null);
	assert.equal(parseCd('echo cd'), null);
});

test('shellSpec picks cmd on windows and the login shell elsewhere', () => {
	const { shellSpec } = load();
	const win = shellSpec('win32', { ComSpec: 'C:\\Windows\\cmd.exe' });
	assert.match(win.file, /cmd\.exe$/i);
	assert.deepEqual([...win.args('dir')], ['/d', '/s', '/c', '"dir"']);
	const nix = shellSpec('linux', { SHELL: '/usr/bin/zsh' });
	assert.equal(nix.file, '/usr/bin/zsh');
	assert.deepEqual([...nix.args('ls')], ['-lc', 'ls']);
});

test('terminal: runs a command, streams output, reports the exit code', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zterm-'));
	const { host, surface, waitFor, outputOf } = setup(dir);
	await host.handle(surface, { type: 'terminalRun', id: 1, command: `${JSON.stringify(process.execPath)} -e "console.log('hello from term')"` });
	const done = await waitFor((m) => m.type === 'terminalDone' && m.id === 1);
	assert.equal(done.code, 0);
	assert.match(outputOf(1), /hello from term/);
	assert.equal(done.cwd, dir);
});

test('terminal: a failing command reports its code and stderr', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zterm-'));
	const { host, surface, waitFor, outputOf } = setup(dir);
	await host.handle(surface, { type: 'terminalRun', id: 2, command: `${JSON.stringify(process.execPath)} -e "console.error('boom'); process.exit(3)"` });
	const done = await waitFor((m) => m.type === 'terminalDone' && m.id === 2);
	assert.equal(done.code, 3);
	assert.match(outputOf(2), /boom/);
});

test('terminal: cd changes the tracked directory and the next command runs there', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zterm-'));
	fs.mkdirSync(path.join(dir, 'sub'));
	const { host, surface, posts, waitFor } = setup(dir);
	await host.handle(surface, { type: 'terminalInfo' });
	const info = posts.find((m) => m.type === 'terminalInfo');
	assert.equal(info.cwd, dir);
	await host.handle(surface, { type: 'terminalRun', id: 3, command: 'cd sub' });
	const done = await waitFor((m) => m.type === 'terminalDone' && m.id === 3);
	assert.equal(done.code, 0);
	assert.equal(done.cwd, path.join(dir, 'sub'));
	assert.equal(fs.existsSync(done.cwd), true);
	// cd to nowhere: error, cwd untouched.
	await host.handle(surface, { type: 'terminalRun', id: 4, command: 'cd not-there' });
	const bad = await waitFor((m) => m.type === 'terminalDone' && m.id === 4);
	assert.equal(bad.code, 1);
	assert.equal(bad.cwd, path.join(dir, 'sub'));
});

test('terminal: stop kills a running command once, without a second done', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zterm-'));
	const { host, surface, posts, waitFor } = setup(dir);
	await host.handle(surface, { type: 'terminalRun', id: 5, command: `${JSON.stringify(process.execPath)} -e "setTimeout(()=>{},60000)"` });
	await new Promise((r) => setTimeout(r, 500));
	await host.handle(surface, { type: 'terminalStop', id: 5 });
	await waitFor((m) => m.type === 'terminalDone' && m.id === 5);
	const done = posts.filter((m) => m.type === 'terminalDone' && m.id === 5);
	assert.equal(done.length, 1, 'exactly one done message');
	assert.equal(done[0].stopped, true);
	assert.equal(done[0].code, 130);
	await new Promise((r) => setTimeout(r, 900));
	assert.equal(posts.filter((m) => m.type === 'terminalDone' && m.id === 5).length, 1, 'the close event does not post a second done');
	// A new command may start only after shutdown has completed.
	await host.handle(surface, { type: 'terminalRun', id: 6, command: `${JSON.stringify(process.execPath)} -e "console.log('next')"` });
	const next = await waitFor((m) => m.type === 'terminalDone' && m.id === 6);
	assert.equal(next.code, 0);
});

test('decoder preserves byte-split Unicode and removes split CSI, OSC and DCS', () => {
	const { TerminalTextDecoder } = load();
	const decoder = new TerminalTextDecoder();
	const bytes = Buffer.from('😀中文\x1b[38:2:1:2:3mred\x1b[0m\x1b]0;secret\x1b\\ok\x1bPprivate\x1b\\!');
	let output = '';
	for (const byte of bytes) output += decoder.write(Buffer.from([byte]));
	output += decoder.end();
	assert.equal(output, '😀中文redok!');
	const broken = new TerminalTextDecoder();
	assert.equal(broken.write(Buffer.from('text\x1b]unterminated')), 'text');
	assert.equal(broken.write(Buffer.alloc(100000, 65)), '');
});

test('cd respects quoted metacharacters, environment and shell syntax', () => {
	const { parseCd } = load();
	const env = { HOME: '/home/test', TARGET: '/x & y', ROOT: 'C:\\work & play' };
	assert.equal(parseCd('cd "x & y; z"', 'linux', env), 'x & y; z');
	assert.equal(parseCd('cd "$TARGET"', 'linux', env), '/x & y');
	assert.equal(parseCd("cd '$TARGET'", 'linux', env), '$TARGET');
	assert.equal(parseCd('cd "${HOME}/src"', 'linux', env), '/home/test/src');
	assert.equal(parseCd('cd "%root%"', 'win32', env), 'C:\\work & play');
	assert.equal(parseCd('cd "x & y"', 'win32'), 'x & y');
	for (const command of ['cd "unclosed', 'cd $(pwd)', 'cd `pwd`', 'cd x && echo hi', 'cd x y', 'cd x "y"', 'cd *.txt']) {
		assert.equal(parseCd(command, 'linux', env), null, command);
	}
});

test('terminal: cwd persists without an open workspace', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zterm-'));
	const { host, surface, posts } = setup();
	await host.handle(surface, { type: 'terminalRun', id: 11, command: 'cd "' + dir + '"' });
	await host.handle(surface, { type: 'terminalInfo' });
	assert.equal(posts.at(-1).cwd, dir);
	assert.ok(posts.at(-1).shell);
	fs.rmSync(dir, { recursive: true });
	await host.handle(surface, { type: 'terminalInfo' });
	assert.equal(posts.at(-1).cwd, os.homedir());
});

function fakeChildren() {
	const { EventEmitter } = require('node:events');
	const children = [];
	const spawn = (file, args, options) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
		child.kill = () => { child.killCount = (child.killCount || 0) + 1; };
		// No pid: exercises the child.kill fallback without touching OS processes.
		children.push(child);
		return child;
	};
	return { children, overrides: { child_process: { spawn } } };
}

test('terminal: stale stop is ignored, stopping stays busy until close, done is once', async () => {
	const fake = fakeChildren();
	const { host, surface, posts } = setup(undefined, fake.overrides);
	await host.handle(surface, { type: 'terminalRun', id: 20, command: 'long command' });
	const child = fake.children[0];
	await host.handle(surface, { type: 'terminalStop', id: 19 });
	assert.equal(child.killCount, undefined);
	assert.equal(posts.length, 0);
	await host.handle(surface, { type: 'terminalStop', id: 20 });
	assert.equal(child.killCount, 1);
	assert.equal(posts.at(-1).running, true);
	assert.equal(posts.at(-1).stopping, true);
	assert.equal(posts.some((m) => m.type === 'terminalDone'), false);
	await host.handle(surface, { type: 'terminalStop', id: 20 });
	assert.equal(child.killCount, 1);
	await host.handle(surface, { type: 'terminalRun', id: 21, command: 'another' });
	assert.equal(fake.children.length, 1);
	child.stdout.emit('data', Buffer.from('last output'));
	child.emit('close', null);
	child.emit('close', null);
	const done = posts.filter((m) => m.type === 'terminalDone' && m.id === 20);
	assert.equal(done.length, 1);
	assert.equal(done[0].stopped, true);
	await host.handle(surface, { type: 'terminalRun', id: 22, command: 'next' });
	assert.equal(fake.children.length, 2);
	fake.children[1].emit('close', 0);
});

test('terminal: output cap applies inside huge chunks and does not split surrogate pairs', async () => {
	const fake = fakeChildren();
	const { host, surface, posts, outputOf } = setup(undefined, fake.overrides);
	await host.handle(surface, { type: 'terminalRun', id: 30, command: 'output' });
	const child = fake.children[0];
	child.stdout.emit('data', Buffer.from('x'.repeat(256 * 1024 - 1) + '😀' + 'y'.repeat(100000)));
	child.stderr.emit('data', Buffer.alloc(500000, 65));
	child.stdout.emit('end'); child.stderr.emit('end'); child.emit('close', 0);
	const chunks = posts.filter((m) => m.type === 'terminalChunk' && m.id === 30);
	assert.equal(chunks.filter((m) => m.text.includes('output truncated')).length, 1);
	assert.ok(chunks.filter((m) => m.stream).reduce((sum, m) => sum + m.text.length, 0) <= 256 * 1024);
	assert.doesNotMatch(outputOf(30), /[\uD800-\uDFFF]/);
});

test('Windows stop waits for both taskkill and command close', async () => {
	const fake = fakeChildren();
	fake.overrides.process = { platform: 'win32', env: process.env };
	const { host, surface, posts } = setup(undefined, fake.overrides);
	await host.handle(surface, { type: 'terminalRun', id: 40, command: 'long command' });
	const child = fake.children[0]; child.pid = 123;
	await host.handle(surface, { type: 'terminalStop', id: 40 });
	const killer = fake.children[1];
	child.emit('close', null);
	assert.equal(posts.some((m) => m.type === 'terminalDone'), false);
	killer.emit('close', 0);
	assert.equal(posts.filter((m) => m.type === 'terminalDone').length, 1);
});

test('POSIX stop targets a process group including detached-output descendants', async () => {
	const fake = fakeChildren(), signals = [];
	fake.overrides.process = { platform: 'linux', env: process.env, kill: (pid, signal) => signals.push([pid, signal]) };
	const { host, surface, posts } = setup(undefined, fake.overrides);
	await host.handle(surface, { type: 'terminalRun', id: 50, command: 'long command' });
	const child = fake.children[0]; child.pid = 456;
	await host.handle(surface, { type: 'terminalStop', id: 50 });
	assert.deepEqual(signals, [[-456, 'SIGTERM']]);
	child.emit('close', null);
	assert.deepEqual(signals.at(-1), [-456, 'SIGKILL']);
	assert.equal(posts.at(-1).stopped, true);
});

test('desktop shutdown and retention wait for taskkill and command close in either order', async () => {
	for (const commandFirst of [true, false]) {
		const fake = fakeChildren();
		fake.overrides.process = { platform: 'win32', env: process.env };
		const { host, surface, activity } = setup(undefined, fake.overrides);
		await host.handle(surface, { type: 'terminalRun', id: 60, command: 'long command' });
		const child = fake.children[0]; child.pid = 123;
		let exited = false;
		const stopped = host.stop().then(() => { exited = true; });
		const killer = fake.children[1];
		(commandFirst ? child : killer).emit('close', 0);
		await Promise.resolve();
		assert.equal(exited, false, 'Shutdown cannot exit while either process is still closing');
		assert.deepEqual(activity.map(m => m.running), [true]);
		(commandFirst ? killer : child).emit('close', 0);
		await stopped;
		assert.deepEqual(activity.map(m => m.running), [true, false]);
		await host.stop();
	}
});
