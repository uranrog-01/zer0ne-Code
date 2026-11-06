const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
require('../../test/gui-lock').acquire();
const engineOut = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const source = path.resolve(engineOut, '../media/sandbox/input.cs');

function fixture(platform = 'win32') {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-computer-test-'));
	const calls = [], children = [], timers = new Map();
	fs.mkdirSync(path.join(dir,'computer-use')); fs.writeFileSync(path.join(dir,'computer-use/permissions.json'),JSON.stringify({epoch:'fixture',paused:false,allowed:['C:\\allowed.exe']}));
	let bounds = { width: 1280, height: 720, screenWidth: 2560, screenHeight: 1440, left: 0, top: 0, windowId: '42', processId: 77 };
	let mode = '', now = Date.now();
	const fakeFs = { ...fs };
	fakeFs.existsSync = file => /csc\.exe$/.test(file) || fs.existsSync(file);
	const fakeProcess = Object.create(process);
	Object.defineProperty(fakeProcess, 'platform', { value: platform });
	fakeProcess.env = {};
	class Clock extends Date { static now() { return now; } }
	function spawn(file, args, options) {
		const p = new EventEmitter();
		p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.stdin = new PassThrough();
		let input = '', closed = false;
		p.stdin.on('data', c => { input += c.toString('utf8'); });
		const call = { file, args: Array.from(args), options, input: () => input }; calls.push(call); children.push(p);
		const close = code => { if (!closed) { closed = true; options.signal.removeEventListener('abort', abort); p.emit('close', code); } };
		const abort = () => { p.emit('error', Object.assign(new Error('stopped'), { name: 'AbortError' })); close(1); };
		options.signal.addEventListener('abort', abort, { once: true });
		p.kill = () => { close(1); return true; };
		queueMicrotask(() => {
			if (closed || mode === 'hang') return;
			if (/csc\.exe$/.test(file)) fs.writeFileSync(args.find(a => a.startsWith('-out:')).slice(5), 'fixture executable');
			else if (args[0] === 'windows') p.stdout.write(JSON.stringify([{path:'C:\\allowed.exe',name:'allowed',title:'Allowed app',windowId:'42',processId:77},{path:'C:\\blocked.exe',name:'blocked',title:'Private app',windowId:'43',processId:78}]));
			else if (args[0] === 'screenshot') {
				fs.writeFileSync(args[1], 'fixture image');
				p.stdout.write(mode === 'bad-geometry' ? '{}' : JSON.stringify({ windowId: '42', processId: 77, ...bounds }));
			} else if (file === 'gnome-screenshot') {
				const png = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20); fs.writeFileSync(args[1], png);
			} else if (file === 'convert') fs.writeFileSync(args.at(-1), 'fixture jpeg');
			if (mode === 'fail') p.stderr.write('Windows rejected input');
			if (mode === 'overflow') p.stdout.write('x'.repeat(65537));
			close(mode === 'fail' ? 1 : 0);
		});
		return p;
	}
	const module = { exports: {} };
	const requireFixture = name => name === './computerControl' ? require(path.join(engineOut,'tools/computerControl')) : name === '../runtimeLease' ? require(path.join(engineOut, 'runtimeLease')) : name === 'child_process' ? { spawn, spawnSync: () => ({ status: 0 }) } : name === 'fs' ? fakeFs : name === 'timers/promises' ? { setTimeout: async (_ms, _value, options) => options.signal.throwIfAborted() } : require(name);
	vm.runInNewContext(fs.readFileSync(path.join(engineOut, 'tools/computer.js'), 'utf8'), { module, exports: module.exports, require: requireFixture, process: fakeProcess, setTimeout: callback => { const id = {}; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), setInterval, clearInterval, Date: Clock }, { filename: 'computer.js' });
	const controller = new AbortController();
	let approvals = 0;
	const options = { storageDir: dir, sourceFile: source, sessionId: 'a', vision: true, signal: controller.signal, approve: async () => { approvals++; return true; } };
	const run = (args, patch = {}) => module.exports.runComputer(args, { ...options, ...patch });
	const shot = (patch = {}) => run({ action: 'screenshot' }, patch);
	return { dir, calls, children, run, shot, controller, options, expire: () => timers.values().next().value(), approvals: () => approvals, setMode: value => { mode = value; }, setBounds: value => { bounds = value; }, advance: value => { now += value; }, cleanup: () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('invalid, disabled, non-vision and read-only Computer Use never reaches native input', async () => {
	const f = fixture();
	try {
		assert.equal((await f.run({ action: 'click', x: 1, y: 1 }, { vision: false })).error, true);
		await assert.rejects(f.run({ action: 'surprise', x: 1, y: 1 }), /Unknown/);
		await assert.rejects(f.run({ action: 'click', x: 1, y: 1 }), /screenshot/);
		assert.equal(f.calls.length, 0);
		await f.shot(); const captured = f.calls.length;
		for (const args of [{ action: 'click', x: -1, y: 0 }, { action: 'click', x: 1280, y: 0 }, { action: 'move', x: '2', y: 2 }, { action: 'click', x: NaN, y: 1 }, { action: 'scroll', x: 1, y: 1, amount: Infinity }, { action: 'scroll', x: 1, y: 1, amount: 0 }, { action: 'scroll', x: 1, y: 1, amount: 1.5 }, { action: 'type', text: '' }, { action: 'type', text: 'x'.repeat(20001) }, { action: 'type', text: '\0' }, { action: 'key', keys: 'ctrl++s' }]) await assert.rejects(f.run(args));
		assert.equal(f.approvals(), 0); assert.equal(f.calls.length, captured);
		assert.equal((await f.run({ action: 'click', x: 1, y: 1 }, { approve: async () => false })).summary, 'rejected');
		assert.equal(f.calls.length, captured);
		const { createDesktopShim } = require('../../host/desktop-shim');
		const { shim, install } = createDesktopShim({ engineDir: path.dirname(engineOut), workspace: f.dir, dataDir: path.join(f.dir, 'data'), rpc: async () => null }); install(shim.vscode);
		const { runTool, buildToolDefs } = require(path.join(engineOut, 'tools/agentTools'));
		const { DEFAULT_SETTINGS } = require(path.join(engineOut, 'providerStore'));
		const ctx = { ...f.options, mediaDir: path.dirname(path.dirname(source)), settings: { ...DEFAULT_SETTINGS, computerUse: false }, requestApproval: async () => { throw Error('must not ask'); } };
		const call = { id: 'computer-policy', name: 'computer', arguments: '{"action":"screenshot"}' };
		assert.equal(buildToolDefs(ctx.settings).some(t => t.name === 'computer'), false);
		assert.match((await runTool(call, ctx)).api, /turned off/);
		assert.match((await runTool(call, { ...ctx, settings: { ...ctx.settings, computerUse: true }, readOnly: true })).api, /read-only/);
		assert.match((await runTool(call, { ...ctx, allowedTools: new Set() })).api, /not permitted/);
	} finally { f.cleanup(); }
});

test('coordinates belong to a chat, map each axis and origin, and expire after any action', async () => {
	const f = fixture();
	try {
		await f.shot();
		await assert.rejects(f.run({ action: 'click', x: 100, y: 100 }, { sessionId: 'b' }), /screenshot/);
		f.setBounds({ width: 1000, height: 667, screenWidth: 1501, screenHeight: 1000, left: -100, top: 20 });
		await f.shot({ sessionId: 'b' });
		await f.run({ action: 'click', x: 100, y: 100 });
		assert.deepEqual(f.calls.at(-1).args.slice(0, 5), ['click', '200', '200', 'left', '1']);
		await assert.rejects(f.run({ action: 'click', x: 1, y: 1 }, { sessionId: 'b' }), /screenshot/);
		await f.shot({ sessionId: 'b' }); await f.run({ action: 'move', x: 999.99, y: 666.99 }, { sessionId: 'b' });
		assert.deepEqual(f.calls.at(-1).args.slice(0, 3), ['move', '1400', '1019']);
		await f.shot(); f.advance(300001);
		await assert.rejects(f.run({ action: 'key', keys: 'enter' }), /screenshot/);
	} finally { f.cleanup(); }
});

test('approval cannot revive stopped input or a superseded screenshot', async () => {
	const f = fixture();
	try {
		await f.shot(); let release;
		const pending = f.run({ action: 'type', text: 'must not type' }, { approve: () => new Promise(r => { release = r; }) });
		await f.shot(); const captured = f.calls.length; release(true);
		await assert.rejects(pending, /changed/); assert.equal(f.calls.length, captured);
		await assert.rejects(f.run({ action: 'key', keys: 'ctrl+s' }, { approve: async () => { f.controller.abort(); return true; } }), { name: 'AbortError' });
		assert.equal(f.calls.length, captured);
	} finally { f.cleanup(); }
});

test('independent project engines invalidate old observations and cannot overlap desktop actions', async () => {
	const a = fixture(), b = fixture();
	const shared = { storageDir: a.dir, sessionId: 'other-project' };
	try {
		await a.shot(); await b.shot(shared);
		await b.run({ action: 'key', keys: 'enter' }, shared);
		const before = a.calls.length;
		await assert.rejects(a.run({ action: 'type', text: 'stale desktop' }), /Another project changed/);
		assert.equal(a.calls.length, before, 'stale input never starts a helper');
		await a.shot(); a.setMode('hang');
		const running = a.run({ action: 'key', keys: 'enter' });
		const stopped = assert.rejects(running, { name: 'AbortError' });
		await new Promise(resolve => setImmediate(resolve));
		const bBefore = b.calls.length;
		await assert.rejects(b.shot(shared), /Another project is using/);
		assert.equal(b.calls.length, bBefore);
		a.controller.abort(); await stopped;
		await b.shot(shared);
		assert(!fs.existsSync(path.join(a.dir, 'computer-use/.maintenance.lock')), 'Stop and errors release the desktop lease');
	} finally { a.cleanup(); b.cleanup(); }
});

test('every approved Windows action carries the screenshot window identity', async () => {
	const f = fixture();
	try {
		await f.shot(); await f.run({ action: 'type', text: 'approved text' });
		assert.deepEqual(f.calls.at(-1).args.slice(f.calls.at(-1).args.indexOf('--focus'), f.calls.at(-1).args.indexOf('--focus')+2), ['--focus', '42,77']);
		await f.shot(); await f.run({ action: 'click', x: 1, y: 1 });
		assert.deepEqual(f.calls.at(-1).args.slice(f.calls.at(-1).args.indexOf('--focus'), f.calls.at(-1).args.indexOf('--focus')+2), ['--focus', '42,77']);
		f.setBounds({ width: 1280, height: 720, screenWidth: 2560, screenHeight: 1440, left: 0, top: 0, windowId: '0', processId: 0 });
		await assert.rejects(f.shot(), /no active window/);
	} finally { f.cleanup(); }
});

test('app selection exposes only allowed windows and cannot select a disallowed app', async () => {
	const f=fixture();
	try {
		const listed=JSON.parse((await f.run({action:'apps'})).api);
		assert.equal(listed.windows.length,1); assert.equal(listed.windows[0].name,'allowed'); assert(!JSON.stringify(listed).includes('Private app'));
		await f.shot({app:'ignored'});
		const before=f.calls.length;
		await assert.rejects(f.run({action:'screenshot',app:'blocked'}),/allowed open/);
		assert.equal(f.calls.slice(before).some(call=>call.args[0]==='screenshot'),false);
		await f.run({action:'screenshot',app:'42'});
		const shot=f.calls.at(-1).args; assert.equal(shot[0],'screenshot'); assert.deepEqual(shot.slice(-2),['--focus','42,77']);
	} finally {f.cleanup();}
});

test('permissions default paused, survive restart and invalidate observations after changes',async()=>{
	const f=fixture(), control=require(path.join(engineOut,'tools/computerControl'));
	try {
		fs.unlinkSync(control.computerPolicyFile(f.dir));
		assert.equal(control.computerPolicy(f.dir).paused,true);
		await assert.rejects(f.shot(),/paused/); assert.equal(f.calls.length,0);
		control.changeComputerPolicy(f.dir,p=>{p.allowed=['C:\\allowed.exe'];p.paused=false;});
		await f.shot();
		control.changeComputerPolicy(f.dir,p=>{p.allowed=[];});
		await assert.rejects(f.run({action:'type',text:'no access'}),/Allow an app/);
		control.changeComputerPolicy(f.dir,p=>{p.allowed=['C:\\allowed.exe'];});
		await assert.rejects(f.run({action:'type',text:'old screenshot'}),/screenshot/);
		assert.deepEqual(control.computerPolicy(f.dir).allowed,['C:\\allowed.exe']);
		fs.writeFileSync(control.computerPolicyFile(f.dir),'{broken');
		await assert.rejects(f.shot(),/could not be read/);
	} finally {f.cleanup();}
});

test('Stop cancels pending approval and running input across independent engines; resume cannot revive either',async()=>{
	const f=fixture(), control=require(path.join(engineOut,'tools/computerControl'));
	try {
		await f.shot(); let approve;
		const pending=f.run({action:'type',text:'must not arrive'},{approve:()=>new Promise(resolve=>{approve=resolve;})});
		const rejected=assert.rejects(pending,/stopped|permissions changed/);
		assert.equal(control.computerActivity(f.dir).action,'type');
		require('../../app/computer-stop').requestStop(path.join(f.dir,'computer-use'));
		await rejected; const before=f.calls.length; approve(true); await new Promise(resolve=>setImmediate(resolve));
		assert.equal(f.calls.length,before); assert.equal(control.computerActivity(f.dir),undefined);
		control.changeComputerPolicy(f.dir,p=>{p.paused=false;});
		await assert.rejects(f.run({action:'key',keys:'enter'}),/screenshot/);
		await f.shot(); f.setMode('hang');
		const input=f.run({action:'key',keys:'enter'}), stopped=assert.rejects(input,/stopped|permissions changed/);
		await new Promise(resolve=>setImmediate(resolve));
		control.changeComputerPolicy(f.dir,p=>{p.allowed=[];p.paused=true;}); await stopped;
		assert(!fs.existsSync(path.join(f.dir,'computer-use/.maintenance.lock')));
	} finally {f.cleanup();}
});

test('Stop kills a running helper, failures propagate, and captures leave no files', async () => {
	const f = fixture();
	try {
		await f.shot(); const capturedFile = f.calls.at(-1).args[1]; assert.equal(fs.existsSync(path.dirname(capturedFile)), false);
		f.setMode('fail'); await assert.rejects(f.run({ action: 'type', text: 'Zażółć 中文 😀' }), /Windows rejected/);
		assert.equal(f.calls.at(-1).input(), 'Zażółć 中文 😀');
		await assert.rejects(f.run({ action: 'key', keys: 'enter' }), /screenshot/);
		f.setMode('bad-geometry'); await assert.rejects(f.shot(), /geometry/);
		assert.equal(fs.existsSync(path.dirname(f.calls.at(-1).args[1])), false);
		f.setMode(''); await f.shot(); f.setMode('hang');
		const pending = f.run({ action: 'key', keys: 'enter' });
		const stopped = assert.rejects(pending, { name: 'AbortError' });
		await new Promise(r => setImmediate(r)); f.controller.abort(); await stopped;
	} finally { f.cleanup(); }
});

test('unimplemented platform permissions fail closed before native capture or input', async () => {
	for(const platform of ['linux','darwin']) { const f=fixture(platform); try { await assert.rejects(f.shot(),/require Windows/); assert.equal(f.calls.length,0); } finally { f.cleanup(); } }
});

test('helper versions follow source changes, and hung or noisy helpers are terminated', async () => {
	const f = fixture();
	try {
		fs.mkdirSync(path.join(f.dir, 'sandbox')); fs.writeFileSync(path.join(f.dir, 'sandbox/zer0ne-input-v1.exe'), 'stale');
		await f.shot(); await f.shot();
		assert.equal(f.calls.filter(c => /csc\.exe$/.test(c.file)).length, 1);
		const newer = path.join(f.dir, 'input.cs'); fs.writeFileSync(newer, fs.readFileSync(source, 'utf8') + '\n// updated fixture\n');
		await f.shot({ sourceFile: newer });
		assert.equal(f.calls.filter(c => /csc\.exe$/.test(c.file)).length, 2);
		f.setMode('hang');
		const pending = f.run({ action: 'key', keys: 'enter' });
		const timedOut = assert.rejects(pending, /timed out/);
		await new Promise(r => setImmediate(r)); f.expire(); await timedOut;
		f.setMode(''); await f.shot(); f.setMode('overflow');
		await assert.rejects(f.run({ action: 'key', keys: 'enter' }), /output exceeded/);
	} finally { f.cleanup(); }
});

test('Windows helper compiles, captures only an owned app and refuses disallowed capture and input', { skip: process.platform !== 'win32' }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-computer-native-'));
	try {
		const { computerWindows } = require(path.join(engineOut, 'tools/computer'));
		const windows = await computerWindows({storageDir:dir,sourceFile:source,signal:new AbortController().signal});
		assert(windows.every(w=>typeof w.path==='string' && typeof w.windowId==='string'));
		const exe = path.join(dir, 'sandbox', fs.readdirSync(path.join(dir, 'sandbox')).find(n => n.endsWith('.exe')));
		for (const args of [['key', 'enter', '--bounds', '0,0,1,1'], ['move', '-1', '-1'], ['key', 'ctrl+unknown'], ['key', 'enter', '--focus', '0,1']]) {
			const bad = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true }); assert.equal(bad.status, 1); assert.match(bad.stderr, /layout changed|outside|unknown key|screenshot window|permissions|window is unavailable/);
		}
		const helpers = fs.readdirSync(path.join(dir, 'sandbox'));
		assert.equal(helpers.length, 1); assert.match(helpers[0], /zer0ne-input-[a-f0-9]{20}\.exe/);
		const compiler = ['Framework64', 'Framework'].map(f => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(p => fs.existsSync(p));
		const fixtureExe = path.join(dir, 'computer-fixture.exe');
		const compiled = spawnSync(compiler, ['-nologo', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Web.Extensions.dll', `-out:${fixtureExe}`, path.join(__dirname, 'computer-native.cs')], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
		assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
		// This workspace can inherit a Low integrity label; a GUI fixture must run at normal desktop integrity.
		for (const file of [exe, fixtureExe]) assert.equal(spawnSync('icacls', [file, '/setintegritylevel', 'M'], { windowsHide: true }).status, 0);
		const native = spawnSync(fixtureExe, [exe], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
		assert.equal(native.status, 0, native.stdout + native.stderr);
		assert.match(native.stdout, /Native Unicode.*passed/);
	} finally {
		// mkdtemp creates this exact task-owned directory under the OS temp folder.
		assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

