/*
 * Host protocol test: starts host/main.js the way the app does (app/engines.js), checks
 * the engine comes up and serves the extension UI, that a request from the
 * engine reaches the "shell" and its answer gets back, and that the host exits
 * on shutdown and when stdin closes.  Run: npm test (after npm run engine).
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const root = path.join(__dirname, '..');
const engineDir = path.join(root, 'engine');
if (!fs.existsSync(path.join(engineDir, 'out', 'chatController.js'))) {
	console.error('Build the engine first: npm run engine');
	process.exit(1);
}

function get(url, headers = {}) {
	return new Promise((resolve, reject) => {
		http.get(url, { headers }, (res) => {
			let body = '';
			res.on('data', (c) => (body += c));
			res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
		}).on('error', reject);
	});
}

function startHost(extra = {}, env = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-host-'));
	const workspace = path.join(tmp, 'project');
	fs.mkdirSync(workspace);
	fs.writeFileSync(path.join(workspace, 'README.md'), '# test\n');
	const child = spawn(process.execPath, [path.join(root, 'host', 'main.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
	let stderr = '';
	child.stderr.on('data', (c) => (stderr += c));
	const messages = [];
	const waiters = [];
	readline.createInterface({ input: child.stdout }).on('line', (line) => {
		const msg = JSON.parse(line); // stdout must carry only protocol JSON
		messages.push(msg);
		waiters.splice(0).forEach((w) => w());
	});
	const next = (pred, ms = 20000) =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timeout waiting for a message; stderr:\n' + stderr.slice(-2000))), ms);
			const check = () => {
				const m = messages.find(pred);
				if (m) {
					clearTimeout(timer);
					messages.splice(messages.indexOf(m), 1);
					resolve(m);
				} else waiters.push(check);
			};
			check();
		});
	const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
	const key = require('crypto').randomBytes(32).toString('base64');
	send({ t: 'init', engineDir, dataDir: path.join(tmp, 'data'), workspace, key, ...extra });
	const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
	return { child, next, send, exited, tmp, workspace: extra.workspace || workspace, messages, stderr: () => stderr };
}

function postMessage(url, message) {
	const target = new URL('/api/msg', url);
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(message);
		const req = http.request(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': new URL(url).searchParams.get('t'), 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID(), 'Content-Length': Buffer.byteLength(body) } }, (res) => {
			res.resume();
			res.on('end', () => [202, 204].includes(res.statusCode) ? resolve() : reject(new Error(`POST returned ${res.statusCode}`)));
		});
		req.on('error', reject);
		req.end(body);
	});
}

function events(url) {
	const messages = [];
	const waiters = new Set();
	let response;
	const req = http.get(new URL('/api/events?t=' + new URL(url).searchParams.get('t'), url), (res) => {
		response = res;
		let buffer = '';
		res.setEncoding('utf8');
		res.on('data', (chunk) => {
			buffer += chunk;
			let end;
			while ((end = buffer.indexOf('\n\n')) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (frame.startsWith('data: ')) {
					messages.push(JSON.parse(frame.slice(6)));
					for (const check of [...waiters]) check();
				}
			}
		});
	});
	return {
		messages,
		clear: () => { messages.length = 0; },
		next: (pred, ms = 20000) => new Promise((resolve, reject) => {
			const check = () => {
				const index = messages.findIndex(pred);
				if (index < 0) return;
				clearTimeout(timer);
				waiters.delete(check);
				resolve(messages.splice(index, 1)[0]);
			};
			const timer = setTimeout(() => { waiters.delete(check); reject(new Error('timeout waiting for SSE message: ' + pred.toString())); }, ms);
			waiters.add(check);
			check();
		}),
		close: () => { response?.destroy(); req.destroy(); }
	};
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('starts the engine and serves the extension UI on 127.0.0.1', async () => {
	const h = startHost();
	try {
		const ready = await h.next((m) => m.t === 'ready');
		assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/);
		assert.strictEqual(path.resolve(ready.workspace), path.resolve(h.workspace));
		assert.ok(ready.engine && ready.engine.extensionVersion, 'engine.json reported');
		const page = await get(ready.url);
		assert.strictEqual(page.status, 200);
		assert.match(page.body, /chat\.js/);
		assert.match(page.body, /desktop: true/);
		const unauth = await get(ready.url.replace(/\?t=.*/, ''));
		assert.strictEqual(unauth.status, 401, 'the UI needs the token');
		const css = await get(ready.url.replace(/\/\?t=.*/, '/media/chat.css'));
		assert.strictEqual(css.status, 200);
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('engine requests reach the shell and answers come back', async () => {
	const h = startHost();
	try {
		const ready = await h.next((m) => m.t === 'ready');
		const token = /t=([\w-]+)/.exec(ready.url)[1];
		const base = ready.url.replace(/\/\?t=.*/, '');
		// The UI asks to open a link → the engine calls vscode.env.openExternal → a request to the shell.
		await new Promise((resolve, reject) => {
			const body = JSON.stringify({ type: 'openExternal', url: 'https://example.com/docs' });
			const req = http.request(base + '/api/msg', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': token, 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID(), 'Content-Length': Buffer.byteLength(body) } }, (res) => {
				res.resume();
				res.on('end', resolve);
			});
			req.on('error', reject);
			req.end(body);
		});
		const req = await h.next((m) => m.t === 'req' && m.op === 'openExternal');
		assert.strictEqual(req.url, 'https://example.com/docs');
		h.send({ t: 'res', id: req.id, value: true });
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('ready names the protocol version the app checks', async () => {
	const h = startHost();
	try {
		const ready = await h.next((m) => m.t === 'ready');
		assert.strictEqual(ready.protocol, require('../host/protocol').PROTOCOL);
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('a request the app never answers times out instead of hanging the engine', async () => {
	const h = startHost({}, { ZER0NE_RPC_TIMEOUT_MS: '300' });
	try {
		const ready = await h.next((m) => m.t === 'ready');
		const fire = (url) => postMessage(ready.url, { type: 'openExternal', url });
		await fire('https://example.com/first');
		const first = await h.next((m) => m.t === 'req' && m.op === 'openExternal');
		const deadline = Date.now() + 5000;
		while (!/\[rpc\] openExternal: no answer/.test(h.stderr()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.match(h.stderr(), /\[rpc\] openExternal: no answer from the app/);
		// A late answer to the expired request is ignored, and the next request still round-trips.
		h.send({ t: 'res', id: first.id, value: true });
		await fire('https://example.com/second');
		const second = await h.next((m) => m.t === 'req' && m.op === 'openExternal' && m.url === 'https://example.com/second');
		h.send({ t: 'res', id: second.id, value: true });
		assert.ok(second.id > first.id);
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('full screen: only the native window changes and the desktop chat page remains intact', async () => {
	const h = startHost();
	try {
		const ready = await h.next((m) => m.t === 'ready');
		const token = /t=([\w-]+)/.exec(ready.url)[1];
		const base = ready.url.replace(/\/\?t=.*/, '');
		const postMsg = (m) =>
			new Promise((resolve, reject) => {
				const body = JSON.stringify(m);
				const req = http.request(base + '/api/msg', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': token, 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID(), 'Content-Length': Buffer.byteLength(body) } }, (res) => {
					res.resume();
					res.on('end', resolve);
				});
				req.on('error', reject);
				req.end(body);
			});
		assert.doesNotMatch((await get(ready.url)).body, /<body class="vscode-dark desktop fullscreen/);
		await postMsg({ type: 'fullscreen', on: true });
		const on = await h.next((m) => m.t === 'req' && m.op === 'fullscreen');
		assert.strictEqual(on.on, true);
		h.send({ t: 'res', id: on.id, value: true });
		const page = (await get(ready.url)).body;
		assert.match(page, /<body class="vscode-dark desktop">/);
		assert.doesNotMatch(page, /desktop fullscreen|<body class="vscode-dark remote/);
		await postMsg({ type: 'fullscreen', on: false });
		const off = await h.next((m) => m.t === 'req' && m.op === 'fullscreen');
		assert.strictEqual(off.on, false);
		h.send({ t: 'res', id: off.id, value: false });
		assert.doesNotMatch((await get(ready.url)).body, /desktop fullscreen/);
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('API keys are encrypted with the shell key, never stored in plain text', async () => {
	const h = startHost();
	try {
		await h.next((m) => m.t === 'ready');
		const { keyedSecrets } = require('../host/desktop-shim');
		const file = path.join(h.tmp, 'secrets-check.json');
		const key = require('crypto').randomBytes(32);
		const s = keyedSecrets(file, key);
		await s.store('provider.key', 'sk-live-123456');
		assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-live-123456'));
		assert.strictEqual(await keyedSecrets(file, key).get('provider.key'), 'sk-live-123456');
		await assert.rejects(keyedSecrets(file, require('crypto').randomBytes(32)).get('provider.key'), /could not be decrypted/, 'key failures are reported without discarding saved credentials');
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('each folder gets its own workspace state', async () => {
	const h = startHost();
	try {
		await h.next((m) => m.t === 'ready');
		const dirs = fs.readdirSync(path.join(h.tmp, 'data', 'workspaces'));
		assert.strictEqual(dirs.length, 1);
		assert.strictEqual(fs.readFileSync(path.join(h.tmp, 'data', 'workspaces', dirs[0], 'folder.txt'), 'utf8'), path.resolve(h.workspace));
	} finally {
		h.send({ t: 'shutdown' });
		await h.exited;
	}
});

test('the shared global memento keeps the other engine\'s keys and chats on flush', async () => {
	const { sharedGlobalMemento } = require('../host/desktop-shim');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-memento-')), 'global-state.json');
	// The other engine (a background project) saved its state while this one was starting.
	fs.writeFileSync(file, JSON.stringify({ 'aiChat.projects': ['C:\\other'], 'aiChat.sessions': [{ id: 's-other', title: 'Other chat' }] }));
	const m = sharedGlobalMemento(file);
	await m.update('aiChat.sessions', [...m.get('aiChat.sessions'), { id: 's-mine', title: 'My chat' }]);
	await m.update('aiChat.settings', { theme: 'dark' });
	m.flush();
	const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.deepStrictEqual(saved['aiChat.projects'], ['C:\\other'], 'a key this engine never wrote takes the disk value');
	assert.deepStrictEqual(
		saved['aiChat.sessions'].map((s) => s.id).sort(),
		['s-mine', 's-other'],
		'the sessions lists of both engines merge by id'
	);
	assert.deepStrictEqual(saved['aiChat.settings'], { theme: 'dark' }, 'this engine\'s own writes stand');
	// Damaged saved data is preserved so it can be recovered.
	fs.writeFileSync(file, '{oops');
	assert.throws(() => m.flush(), /file was preserved/);
	assert.strictEqual(fs.readFileSync(file, 'utf8'), '{oops');
});

test('session deletes survive stale writes, reads, flush and restart', async () => {
	const { sharedGlobalMemento } = require('../host/desktop-shim');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-memento-')), 'global-state.json');
	fs.writeFileSync(file, JSON.stringify({ 'aiChat.sessions': [{ id: 'keep' }, { id: 'delete' }] }));
	const m = sharedGlobalMemento(file);
	await m.update('aiChat.sessions', [{ id: 'keep' }]);
	assert.deepStrictEqual(m.get('aiChat.sessions').map((s) => s.id), ['keep']);
	m.keys();
	await m.update('aiChat.currentSession', 'keep');
	assert.deepStrictEqual(m.get('aiChat.sessions').map((s) => s.id), ['keep'], 'engine deletion routing must not see the deleted session again');
	const stale = sharedGlobalMemento(file);
	await stale.update('aiChat.sessions', [{ id: 'keep' }, { id: 'delete' }, { id: 'external' }]);
	assert.deepStrictEqual(m.get('aiChat.sessions').map((s) => s.id), ['keep', 'external'], 'fresh additions still arrive alongside pending deletes');
	m.flush();
	assert.deepStrictEqual(sharedGlobalMemento(file).get('aiChat.sessions').map((s) => s.id).sort(), ['external', 'keep'], 'flush and restart cannot resurrect a deleted session');
});

test('shared memento reads fresh additions and does not resurrect consumed handoffs or removed projects', async () => {
	const { sharedGlobalMemento } = require('../host/desktop-shim');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-memento-')), 'global-state.json');
	const a = sharedGlobalMemento(file);
	await a.update('aiChat.projects', ['/project-a']);
	await a.update('aiChat.sessions', [{ id: 'a', title: 'A' }]);
	a.flush();
	const b = sharedGlobalMemento(file);
	await b.update('aiChat.projects', ['/project-a', '/project-b']);
	await b.update('aiChat.sessions', [{ id: 'a', title: 'External edit' }, { id: 'b', title: 'B' }]);
	await b.update('aiChat.projectHandoff.b', { kind: 'create' });
	b.flush();
	assert.deepStrictEqual(a.get('aiChat.projects'), ['/project-a', '/project-b']);
	assert.deepStrictEqual(a.get('aiChat.sessions').map((s) => s.id), ['a', 'b']);
	assert.strictEqual(a.get('aiChat.sessions')[0].title, 'External edit', 'latest external session edits remain visible');
	assert.deepStrictEqual(a.get('aiChat.projectHandoff.b'), { kind: 'create' });
	await a.update('aiChat.projectHandoff.b', undefined);
	assert.strictEqual(a.get('aiChat.projectHandoff.b'), undefined, 'fresh disk reads cannot undo a pending deletion');
	a.flush();
	assert.strictEqual(b.get('aiChat.projectHandoff.b'), undefined, 'a reader must observe an externally cleared handoff');
	assert.ok(!b.keys().includes('aiChat.projectHandoff.b'));
	b.flush();
	assert.strictEqual(a.get('aiChat.projectHandoff.b'), undefined, 'the publisher cannot put consumed mail back on flush');
	// A later legitimate handoff must still be delivered after the first was consumed.
	await b.update('aiChat.projectHandoff.b', { kind: 'create', sessionId: 'new' });
	assert.deepStrictEqual(a.get('aiChat.projectHandoff.b'), { kind: 'create', sessionId: 'new' });
	await a.update('aiChat.projectHandoff.b', undefined);
	await a.update('aiChat.projects', ['/project-a']);
	a.flush();
	assert.deepStrictEqual(a.get('aiChat.projects'), ['/project-a'], 'merge must not undo a local removal');
	b.get('aiChat.projects');
	await b.update('aiChat.projects', ['/project-a', '/project-b', '/project-c']);
	b.flush();
	assert.deepStrictEqual(a.get('aiChat.projects'), ['/project-a', '/project-b', '/project-c'], 'explicitly re-added projects and new projects remain visible');
	a.flush();
});

test('settings whole-object saves merge changed fields against disk and release ownership immediately', async () => {
	const { sharedGlobalMemento } = require('../host/desktop-shim');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-settings-')), 'global-state.json');
	const defaults = { theme: 'auto', accent: 'blue', language: 'en', fontUi: 'system' };
	const a = sharedGlobalMemento(file, defaults);
	const b = sharedGlobalMemento(file, defaults);
	const stale = { ...defaults, ...a.get('aiChat.settings', {}) };
	await b.update('aiChat.settings', { ...defaults, theme: 'dracula', accent: 'custom' });
	await a.update('aiChat.settings', { ...stale, language: 'de' });
	assert.deepStrictEqual(a.get('aiChat.settings'), { theme: 'dracula', accent: 'custom', language: 'de' }, 'default fields do not revert the latest palette or pollute sparse disk');
	const staleB = { ...defaults, ...b.get('aiChat.settings') };
	await a.update('aiChat.settings', { ...defaults, ...a.get('aiChat.settings'), theme: 'light' });
	await b.update('aiChat.settings', { ...staleB, fontUi: 'serif' });
	a.flush(); b.flush();
	assert.deepStrictEqual(a.get('aiChat.settings'), { theme: 'light', accent: 'custom', language: 'de', fontUi: 'serif' });
	await a.update('anotherKey', 1); a.flush();
	assert.strictEqual(b.get('aiChat.settings').theme, 'light', 'unrelated saves cannot resurrect an older theme');
});

test('two sidecars refresh global theme and notification preferences on cold and retained activation without ready routing', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-global-'));
	const dataDir = path.join(tmp, 'data');
	const folderA = path.join(tmp, 'a'), folderB = path.join(tmp, 'b');
	fs.mkdirSync(folderA); fs.mkdirSync(folderB);
	const a = startHost({ workspace: folderA, dataDir });
	let b, ea, eb;
	try {
		const ra = await a.next(m => m.t === 'ready');
		ea = events(ra.url);
		await ea.next(m => m.type === 'state');
		await postMessage(ra.url, { type: 'updateSettings', patch: { theme: 'dracula', accent: 'purple', fontUi: 'serif' } });
		await ea.next(m => m.type === 'state' && m.settings.theme === 'dracula');
		await postMessage(ra.url, { type: 'zcDesktopPrefs', prefs: { notify: false } });
		await ea.next(m => m.type === 'zcDesktopPrefs' && m.prefs.notify === false);
		b = startHost({ workspace: folderB, dataDir });
		b.send({ t: 'activate', handoff: null, activationId: 'cold' });
		const rb = await b.next(m => m.t === 'ready');
		// Let cold activation finish before SSE, so all its initial replies can be lost.
		await new Promise(resolve => setTimeout(resolve, 300));
		eb = events(rb.url);
		const cold = await eb.next(m => m.type === 'state' && m.settings.theme === 'dracula');
		assert.strictEqual(cold.settings.accent, 'purple');
		assert.strictEqual(cold.settings.fontUi, 'serif');
		const prefs = await eb.next(m => m.type === 'zcDesktopPrefs');
		assert.deepStrictEqual(prefs.prefs, { notify: false });
		await eb.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'cold');
		await postMessage(rb.url, { type: 'updateSettings', patch: { language: 'de', theme: 'light' } });
		await eb.next(m => m.type === 'state' && m.settings.theme === 'light');
		await postMessage(ra.url, { type: 'updateSettings', patch: { fontCode: 'mono' } });
		await ea.next(m => m.type === 'state' && m.settings.fontCode === 'mono' && m.settings.theme === 'light');
		ea.clear();
		a.send({ t: 'activate', handoff: null, activationId: 'retained' });
		await ea.next(m => m.type === 'state' && m.settings.theme === 'light' && m.settings.language === 'de');
		await ea.next(m => m.type === 'zcDesktopPrefs' && m.prefs.notify === false);
		await ea.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'retained');
		assert.ok(!ea.messages.some(m => m.type === 'appearance'), 'activation is not a ready lifecycle');
	} finally {
		ea?.close(); eb?.close();
		for (const h of [a, b].filter(Boolean)) { h.send({ t: 'shutdown' }); await h.exited; }
	}
});

test('Show Files activation is replayed after cold-page ready and on a retained host', async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-project-files-'));
	const folder = path.join(tmp, 'project'); fs.mkdirSync(folder);
	const host = startHost({ workspace: folder, dataDir: path.join(tmp, 'data') });
	let stream;
	try {
		host.send({ t: 'activate', handoff: { kind: 'files' }, activationId: 'files-cold' });
		const ready = await host.next(m => m.t === 'ready');
		stream = events(ready.url);
		await stream.next(m => m.type === 'state');
		await postMessage(ready.url, { type: 'ready' });
		await stream.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'files-cold' && m.view === 'files');
		host.send({ t: 'activate', handoff: { kind: 'files' }, activationId: 'files-retained' });
		await stream.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'files-retained' && m.view === 'files');
		host.send({ t: 'activate', handoff: null, activationId: 'plain' });
		const plain = await stream.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'plain');
		assert.equal(plain.view, undefined, 'a later plain project switch does not force the Files panel open');
	} finally { stream?.close(); host.send({ t: 'shutdown' }); await host.exited; }
});

for (const kind of ['session', 'create']) {
	test(`independent sidecars activate ${kind} handoffs across cold and cached projects`, async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-switch-'));
		const dataDir = path.join(tmp, 'data');
		const folderA = path.join(tmp, 'a');
		const folderB = path.join(tmp, 'b');
		fs.mkdirSync(folderA);
		fs.mkdirSync(folderB);
		fs.mkdirSync(dataDir);
		const session = (id, folder) => ({ id, title: id, projectPath: folder, updatedAt: Date.now(), messages: [{ id: 'm-' + id, role: 'user', content: 'Conversation ' + id }] });
		const globalFile = path.join(dataDir, 'global-state.json');
		fs.writeFileSync(globalFile, JSON.stringify({ 'aiChat.projects': [folderA, folderB], 'aiChat.sessions': [session('a1', folderA), session('a2', folderA), session('b1', folderB), session('b2', folderB)] }));
		const a = startHost({ workspace: folderA, dataDir });
		let b, ea, eb;
		try {
			const ra = await a.next((m) => m.t === 'ready');
			ea = events(ra.url);
			await ea.next((m) => m.type === 'state');
			const requested = kind === 'create' ? { kind } : { kind, sessionId: 'b2' };
			await postMessage(ra.url, { type: kind === 'create' ? 'projectNewChat' : 'projectOpen', path: folderB, ...(kind === 'session' ? { sessionId: 'b2' } : {}) });
			const openB = await a.next((m) => m.t === 'req' && m.op === 'openFolder');
			assert.strictEqual(openB.path, folderB);
			assert.strictEqual(openB.newWindow, false);
			assert.deepStrictEqual(openB.handoff, requested);
			const saved = JSON.parse(fs.readFileSync(globalFile, 'utf8'));
			assert.ok(!Object.keys(saved).some((k) => k.startsWith('aiChat.projectHandoff.')), 'source clears and flushes handoff before shell RPC');
			b = startHost({ workspace: folderB, dataDir });
			b.send({ t: 'activate', handoff: openB.handoff }); // immediately after init, before ready
			const rb = await b.next((m) => m.t === 'ready');
			a.send({ t: 'res', id: openB.id, value: true });
			eb = events(rb.url);
			const cold = await eb.next((m) => m.type === 'projects' && (kind === 'session' ? m.currentSessionId === 'b2' : m.projects.some((p) => p.current && p.chats.some((s) => s.id === m.currentSessionId && s.count === 0))));
			assert.strictEqual(cold.projects.find((p) => p.current).path, folderB);
			const target = cold.currentSessionId;
			await eb.next((m) => m.type === 'state' && m.currentSessionId === target);
			// Same operation back to A, which has stayed alive (no new init/ready).
			ea.clear();
			await postMessage(rb.url, { type: kind === 'create' ? 'projectNewChat' : 'projectOpen', path: folderA, ...(kind === 'session' ? { sessionId: 'a2' } : {}) });
			const openA = await b.next((m) => m.t === 'req' && m.op === 'openFolder');
				await postMessage(rb.url, { type: 'zcDesktopPrefs', prefs: { notify: false } });
				await eb.next((m) => m.type === 'zcDesktopPrefs' && m.prefs.notify === false);
				a.send({ t: 'activate', handoff: openA.handoff });
				await ea.next((m) => m.type === 'zcDesktopPrefs' && m.prefs.notify === false);
			b.send({ t: 'res', id: openA.id, value: true });
			const cached = await ea.next((m) => m.type === 'projects' && (kind === 'session' ? m.currentSessionId === 'a2' : m.projects.some((p) => p.current && p.chats.some((s) => s.id === m.currentSessionId && s.count === 0))));
			assert.strictEqual(cached.projects.find((p) => p.current).path, folderA);
			await ea.next((m) => m.type === 'state' && m.currentSessionId === cached.currentSessionId);
			assert.ok(!ea.messages.some((m) => m.type === 'appearance'), 'activation does not synthesize ready');
			// New project and session records added after both sidecars started are read on activation.
			const { sharedGlobalMemento } = require('../host/desktop-shim');
			const external = sharedGlobalMemento(globalFile);
			await external.update('aiChat.sessions', [...external.get('aiChat.sessions'), session('b-external', folderB)]);
			const folderC = path.join(tmp, 'c');
			fs.mkdirSync(folderC);
			await external.update('aiChat.projects', [...external.get('aiChat.projects'), folderC]);
			external.flush();
			eb.clear();
			b.send({ t: 'activate', handoff: { kind: 'session', sessionId: 'b-external' } });
			const fresh = await eb.next((m) => m.type === 'projects' && m.currentSessionId === 'b-external');
			assert.ok(fresh.projects.some((p) => p.path === folderC));
			// Invalid destination session cannot cross project boundaries.
			eb.clear();
			b.send({ t: 'activate', handoff: { kind: 'session', sessionId: 'a1' } });
			await b.next((m) => m.t === 'activationError');
			b.send({ t: 'activate', handoff: null });
			await eb.next((m) => m.type === 'projects' && m.currentSessionId === 'b-external');
			// Rapid activations are serialized; a plain switch only refreshes projects.
			eb.clear();
			b.send({ t: 'activate', handoff: { kind: 'create' } });
			b.send({ t: 'activate', handoff: { kind: 'session', sessionId: 'b1' } });
			await eb.next((m) => m.type === 'projects' && m.currentSessionId === 'b1');
			eb.clear();
			b.send({ t: 'activate', handoff: null });
			await eb.next((m) => m.type === 'projects' && m.currentSessionId === 'b1');
			assert.ok(!b.messages.some((m) => m.t === 'ready'), 'cached activation never re-emits protocol ready');
			assert.ok(!b.messages.some((m) => m.t === 'req' && ['openPath', 'openFolder'].includes(m.op)), 'plain activation does not open Explorer or switch again');
			await postMessage(rb.url, { type: 'projectOpen', path: folderB });
			const explorer = await b.next((m) => m.t === 'req' && m.op === 'openPath');
			assert.strictEqual(explorer.path, folderB);
			b.send({ t: 'res', id: explorer.id, value: true });
		} finally {
			ea?.close();
			eb?.close();
			for (const h of [a, b].filter(Boolean)) {
				h.send({ t: 'shutdown' });
				await h.exited;
			}
		}
	});
}

test('an engine reports a run start and end to the shell (busy)', async () => {
	// Unit-level, like createNotifier in desktop-features.js: the reporter watches
	// the engine's state messages and tells the shell on each transition only.
	const { createBusyReporter } = require('../host/host');
	const rpcs = [];
	const rpc = (op, args) => (rpcs.push({ op, args }), Promise.resolve(null));
	const r = createBusyReporter(rpc);
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's1' });
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's1' });
	assert.deepStrictEqual(rpcs, [{ op: 'busy', args: { on: true, sessionId: 's1', activity: 'running', phase: 'thinking', detail: null } }], 'one report per start, repeats ignored');
	r.observe({ type: 'projects', projects: [] });
	r.observe({ type: 'state', isStreaming: false });
	assert.strictEqual(rpcs.length, 2, 'the end is reported');
	assert.deepStrictEqual(rpcs[1], { op: 'busy', args: { on: false, sessionId: null, activity: 'idle', phase: 'idle', detail: null } });
	r.observe({ type: 'state', isStreaming: true });
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's2' });
	assert.deepStrictEqual(rpcs[3], { op: 'busy', args: { on: true, sessionId: 's2', activity: 'running', phase: 'thinking', detail: null } }, 'session identity arriving after run start is reported');
	const other = createBusyReporter(rpc);
	other.observe({ type: 'state', isStreaming: true, runningSessionId: 'other-project' });
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's3' });
	assert.deepStrictEqual(rpcs[5], { op: 'busy', args: { on: true, sessionId: 's3', activity: 'running', phase: 'thinking', detail: null } }, 'busy sessions may change without an idle transition');
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's3', runState: 'waiting' });
	assert.deepStrictEqual(rpcs[6], { op: 'busy', args: { on: true, sessionId: 's3', activity: 'waiting', phase: 'waiting', detail: null } }, 'approval wait keeps the engine busy and exposes attention state');
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's3', runState: 'waiting' });
	assert.strictEqual(rpcs.length, 7, 'repeated waiting states do not flood the shell');
	r.observe({ type: 'state', isStreaming: true, runningSessionId: 's3', runState: 'running' });
	assert.strictEqual(rpcs.at(-1).args.activity, 'running', 'answering resumes the running state');
});

test('the busy report names the run phase the notch shows, and the notch settings reach the shell on change', async () => {
	const { createBusyReporter, createNotchSync, runPhase } = require('../host/host');
	const user = { role: 'user', content: 'Fix the build' };
	const run = (messages, extra) => ({ type: 'state', isStreaming: true, runningSessionId: 's', messages: [user, ...messages], ...extra });
	const at = (phase, detail, steps = 0, plan = null) => ({ phase, detail, plan, steps, stuck: null, budget: null, agents: null, goal: null, health: null });
	assert.deepStrictEqual(runPhase(run([], { streaming: { text: '', reasoning: 'hmm' } })), at('thinking', null));
	assert.deepStrictEqual(runPhase(run([], { streaming: { text: 'Done.', reasoning: '' } })), at('writing', null));
	assert.deepStrictEqual(runPhase(run([{ kind: 'tool', tool: { name: 'read_file', arg: 'C:/repo/src/app.ts', status: 'running' } }])), at('tool', 'Reading app.ts', 1));
	assert.deepStrictEqual(runPhase(run([{ approval: { kind: 'command', command: 'npm test', status: 'approved', execution: 'running' } }])), at('tool', 'Running npm test', 1));
	assert.deepStrictEqual(runPhase(run([{ kind: 'tool', tool: { name: 'grep', arg: 'x', status: 'done' } }], { streaming: { text: 'ok' } })), at('writing', null, 1), 'a finished step is not running');
	assert.deepStrictEqual(runPhase(run([{ approval: { kind: 'command', command: 'rm -rf build', status: 'pending' } }], { runState: 'waiting' })), at('waiting', 'Approval needed: run "rm -rf build"'));
	assert.deepStrictEqual(runPhase({ type: 'state', isStreaming: false, desktopBackgroundRuns: [{ sessionId: 'b', status: 'running' }] }), at('working', null), 'a run in another chat is just working');
	const todos = { todos: [{ text: 'Read the test', done: true }, { text: 'Fix the parser', done: false }, { text: 'Run the suite', done: false }] };
	assert.deepStrictEqual(runPhase(run([{ todos: [{ text: 'old', done: false }] }, todos, { kind: 'tool', tool: { name: 'grep', arg: 'parse', status: 'running' } }])), at('tool', 'Searching parse', 1, { done: 1, total: 3, current: 'Fix the parser' }), 'the latest plan of this turn');
	assert.deepStrictEqual(runPhase({ ...run([]), messages: [{ todos: [{ text: 'last turn', done: false }] }, user] }).plan, null, 'a plan from an earlier turn is not this run');
	// What the notch can answer: the pending approval (by its id) or the agent's question; and the run's health.
	const asked = runPhase(run([{ approval: { id: 'ap1', kind: 'command', command: 'git push   # background', status: 'pending', sandboxed: true, projectRule: 'ask' } }], { runState: 'waiting' }));
	assert.deepStrictEqual(asked.approval, { id: 'ap1', kind: 'command', text: 'git push', sandboxed: true, escalate: false, rule: 'ask' });
	const q = runPhase(run([{ question: { id: 'q1', text: 'Which DB?', options: ['Postgres', '', 'SQLite'], status: 'pending' } }], { runState: 'waiting' }));
	assert.deepStrictEqual(q.question, { id: 'q1', text: 'Which DB?', options: ['Postgres', 'SQLite'] });
	const healthy = runPhase(run([{ approval: { kind: 'edit', path: 'a.ts', status: 'approved' } }, { approval: { kind: 'write', path: 'b.ts', status: 'rejected' } }], { context: { used: 64000, window: 128000 }, streaming: { text: 'x' } }));
	assert.deepStrictEqual(healthy.health, { files: 1, checks: null, context: 50 });

	const calls = [];
	const rpc = (op, args) => (calls.push({ op, args }), Promise.resolve(null));
	const busy = createBusyReporter(rpc);
	busy.observe(run([], { streaming: { text: '', reasoning: 'a' } }));
	busy.observe(run([], { streaming: { text: '', reasoning: 'ab' } }));
	busy.observe(run([], { streaming: { text: 'Hi', reasoning: 'ab' } }));
	assert.deepStrictEqual(calls.map((c) => c.args.phase), ['thinking', 'writing'], 'phase changes only, not every stream tick');
	busy.observe({ type: 'state', isStreaming: false, messages: [{ ...user, turn: { outcome: 'failed' } }] });
	assert.strictEqual(calls.at(-1).args.failed, true, 'a failed run is marked for the notch');

	const sync = createNotchSync(rpc);
	calls.length = 0;
	sync.observe({ type: 'state', settings: { notch: true } });
	sync.observe({ type: 'state', settings: { notch: true } });
	sync.observe({ type: 'state', settings: { notch: true, notchThinking: false, notchPresence: 'always', notchAlerts: 'notch' } });
	assert.deepStrictEqual(calls.map((c) => c.op), ['setNotch', 'setNotch']);
	assert.deepStrictEqual(calls[1].args.prefs, { on: true, thinking: false, writing: true, tools: true, waiting: true, finished: true, presence: 'always', covered: 'line', fullscreen: true, alerts: 'notch', keepAwake: true, battery: false, network: false, mic: false, welcome: false, stuck: true, results: true, agents: true, cost: true, shortcut: true, private: false, actions: true, steer: true, drop: true, discreet: true, health: true, next: true, keys: true, display: 'active', sound: false, calm: false });
	calls.length = 0;
	sync.observe({ type: 'state', mic: { state: 'idle' } });
	sync.observe({ type: 'state', mic: { state: 'listening' } });
	sync.observe({ type: 'state', mic: { state: 'listening' } });
	sync.observe({ type: 'state', mic: { state: 'transcribing' } });
	assert.deepStrictEqual(calls.map((c) => [c.op, c.args.on]), [['notchMic', false], ['notchMic', true], ['notchMic', false]], 'the microphone is reported when it opens and closes');
});

test('the busy report says when a run looks stuck, what it spends, how its workers do and what it changed; cloud tasks reach the shell', async () => {
	const { createBusyReporter, createNotchSync, runStuck, runBudget, runAgents, runResult, cloudLanes } = require('../host/host');
	const user = { role: 'user', content: 'Fix the build' };
	const failed = { approval: { kind: 'command', command: 'npm test', status: 'approved', failed: true } };
	const passed = { approval: { kind: 'command', command: 'npm test', status: 'approved' } };
	const read = { kind: 'tool', tool: { name: 'read_file', arg: 'C:/repo/a.ts', status: 'done' } };
	assert.strictEqual(runStuck([user, failed, failed, failed]), 'npm test failed 3×');
	assert.strictEqual(runStuck([user, failed, passed, failed, failed]), null, 'a success in between: not stuck');
	assert.strictEqual(runStuck([user, failed, failed, failed, read, read, read]), null, 'moved on since');
	assert.strictEqual(runStuck([user, read, read, read, read, read]), 'Repeating a.ts (5×)');
	assert.strictEqual(runStuck([{ ...user }, failed, failed, failed, { role: 'user', content: 'again' }, failed]), null, 'only this turn counts');
	const turn = (t) => [{ ...user, turn: { startedAt: 1, ...t } }];
	assert.deepStrictEqual(runBudget(turn({ taskBudget: { limits: { cost: 2, tokens: 0 }, spentCost: 1.234, uncertainCost: 0.4 } })), { kind: 'cost', spent: 1.63, limit: 2 });
	assert.deepStrictEqual(runBudget(turn({ taskBudget: { limits: { cost: 0, tokens: 0 }, spentCost: 0.42 } })), { kind: 'cost', spent: 0.42, limit: 0 }, 'a known cost shows without a limit');
	assert.deepStrictEqual(runBudget(turn({ taskBudget: { limits: { cost: 0, tokens: 200000 }, spentTokens: 48400 } })), { kind: 'tokens', spent: 48000, limit: 200000 });
	assert.strictEqual(runBudget(turn({ taskBudget: { limits: { cost: 0, tokens: 0 }, spentCost: 0 } })), null);
	const agentRuns = [
		{ rootTaskId: 'r', workflow: true, workflowRole: 'worker', status: 'completed' },
		{ rootTaskId: 'r', workflow: true, workflowRole: 'worker', status: 'running', executionState: 'active' },
		{ rootTaskId: 'r', workflow: true, workflowRole: 'worker', status: 'running', executionState: 'queued' },
		{ rootTaskId: 'r', workflow: true, workflowRole: 'reviewer', status: 'running' },
		{ rootTaskId: 'old', workflow: true, workflowRole: 'worker', status: 'completed' }
	];
	assert.deepStrictEqual(runAgents({ workflowTaskId: 'r', agentRuns }), { workflow: true, total: 3, running: 1, queued: 1, done: 1, failed: 0, review: 'running' });
	assert.strictEqual(runAgents({ workflowTaskId: 'r', agentRuns: [] }), null);
	const { runGoal, runPhase } = require('../host/host');
	assert.deepStrictEqual(runGoal({ goal: { objective: 'tests pass', status: 'active', rounds: 1, maxRounds: 5, check: 'npm test' } }), { objective: 'tests pass', rounds: 1, max: 5, check: 'npm test' });
	assert.strictEqual(runGoal({ goal: { objective: 'x', status: 'met', rounds: 1, maxRounds: 5 } }), null, 'only an active goal shows');
	const priced = runPhase({ isStreaming: true, context: { cacheRate: 61.7 }, messages: turn({ taskBudget: { limits: { cost: 2, tokens: 0 }, spentCost: 1 } }) });
	assert.strictEqual(priced.budget.cache, 62, 'the cache share rides with the budget');
	const edits = [{ path: 'a.ts', added: 10, removed: 2 }, { path: 'a.ts', added: 3, removed: 0 }, { path: 'b.ts', added: 5, removed: 1 }, { path: 'c.ts', added: 9, removed: 9, undone: true }];
	const verification = [{ kind: 'verify', root: 'C:/repo', scope: 'all', finishedAt: 2, status: 'passed', stages: [{ status: 'passed', code: 0 }] }];
	assert.deepStrictEqual(runResult(turn({ edits, verification, review: 'pass' })), { files: 2, added: 18, removed: 3, tests: 'passed', review: 'pass' });
	assert.strictEqual(runResult(turn({ edits: [] })), null, 'nothing changed or checked: no card');

	// No progress for the stall period: stuck, until something moves.
	const calls = [];
	let clock = 1000;
	const busy = createBusyReporter((op, args) => (calls.push(args), Promise.resolve()), 50, () => clock);
	const running = { type: 'state', isStreaming: true, runningSessionId: 's', messages: [user], streaming: { text: '', reasoning: 'a' } };
	busy.observe(running);
	clock += 60;
	await new Promise((r) => setTimeout(r, 120));
	assert.match(calls.at(-1).stuck || '', /^No progress for 0 min$/);
	busy.observe({ ...running, streaming: { text: '', reasoning: 'ab' } });
	assert.strictEqual(calls.at(-1).stuck, undefined, 'moving again');
	busy.observe({ type: 'state', isStreaming: false, currentSessionId: 's', messages: turn({ edits, verification }) });
	assert.deepStrictEqual(calls.at(-1).result, { files: 2, added: 18, removed: 3, tests: 'passed', review: null }, 'the finished run says what it changed');
	busy.dispose();

	const lanes = cloudLanes([
		{ id: 'old', task: 'Old', status: 'completed', createdAt: Date.now() - 3 * 86_400_000 },
		{ id: 'a', task: 'Add tests', status: 'in_progress', createdAt: Date.now() - 1000, jobSteps: [{ status: 'completed' }, { status: 'in_progress' }], runUrl: 'https://github.com/o/r/actions/runs/1' }
	]);
	assert.deepStrictEqual(lanes.map((t) => [t.id, t.status, t.done, t.total]), [['a', 'in_progress', 1, 2]], 'running and recent tasks only');
	const sent = [];
	const sync = createNotchSync((op, args) => (sent.push([op, args.tasks.length]), Promise.resolve()));
	const createdAt = Date.now();
	sync.observe({ type: 'cloudTasks', tasks: [{ id: 'a', task: 'x', status: 'queued', createdAt }] });
	sync.observe({ type: 'cloudStatus', data: { tasks: [{ id: 'a', task: 'x', status: 'queued', createdAt }] } });
	assert.deepStrictEqual(sent, [['notchCloud', 1]], 'cloud tasks are sent on change');
});

test('retired scheduling cannot keep an idle engine alive', async () => {
 const { createBusyReporter } = require('../host/host');
 const calls = []; const reporter = createBusyReporter((op, args) => { calls.push(args); return Promise.resolve(); });
 reporter.observe({type:'state',isStreaming:false});
 reporter.observe({type:'jobs',results:[{sessionId:'retired-project',status:'running'}]});
 assert.deepStrictEqual(calls,[{on:false,sessionId:null,activity:'idle',phase:'idle',detail:null}]);
});

test('a serving local router retains its project until the server stops', async () => {
 const { createBusyReporter } = require('../host/host');
 const calls=[]; const reporter=createBusyReporter((op,args)=>{calls.push({op,args});return Promise.resolve();});
 reporter.observe({type:'localPlus',data:{host:{running:true,active:0}}});
 reporter.observe({type:'localPlus',data:{host:{running:true,active:1}}});
 reporter.observe({type:'localPlus',data:{host:{running:false,enabled:true}}});
 assert.deepEqual(calls,[{op:'retainRouter',args:{on:true}},{op:'retainRouter',args:{on:false}}]);
});

test('removing a project hides it (chats kept) until it is added again', async () => {
	const { desktopProjects } = require('../host/host');
	const data = {};
	const state = { get: (k, d) => (k in data ? data[k] : d), update: async (k, v) => void (data[k] = v) };
	const key = (p) => p.toLowerCase();
	const p = desktopProjects({ globalState: state }, key);
	data['aiChat.projects'] = ['C:\\A', 'C:\\B'];
	const sent = [];
	await p.handle({ type: 'projectRemove', path: 'C:\\B' }, async (m) => void sent.push(m.type));
	assert.deepStrictEqual(data['aiChat.projects'], ['C:\\A']);
	assert.deepStrictEqual(sent, ['getProjects']);
	const list = { type: 'projects', projects: [{ id: 'c:\\a' }, { id: 'c:\\b' }, { id: 'c:\\b2', current: true }] };
	assert.deepStrictEqual(p.filter(list).projects.map((x) => x.id), ['c:\\a', 'c:\\b2']);
	// Adding B again (the pick adds it to the recorded list) brings it back.
	await p.handle({ type: 'projectPick' }, async (m) => {
		if (m.type === 'projectPick') data['aiChat.projects'] = ['C:\\A', 'C:\\B'];
	});
	assert.deepStrictEqual(p.filter(list).projects.map((x) => x.id), ['c:\\a', 'c:\\b', 'c:\\b2']);
	assert.strictEqual(p.filter({ type: 'state', x: 1 }).x, 1, 'other messages pass through');
});

test('notification preferences follow the latest engine write after both engines have saved', async () => {
	const { sharedGlobalMemento } = require('../host/desktop-shim');
	const { desktopPreferences } = require('../host/host');
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-preferences-')), 'global-state.json');
	const a = sharedGlobalMemento(file), b = sharedGlobalMemento(file);
	const pa = desktopPreferences({ globalState: a }), pb = desktopPreferences({ globalState: b });
	await pa.handle({ type: 'zcDesktopPrefs', prefs: { notify: false } }, () => {});
	await pb.handle({ type: 'zcDesktopPrefs', prefs: { notify: true } }, () => {});
	assert.deepStrictEqual(pa.read(), { notify: true });
	a.flush();
	assert.strictEqual(pb.read().notify, true, 'an old writer cannot restore its muted setting');
	await pa.handle({ type: 'zcDesktopPrefs', prefs: { notify: false } }, () => {});
	assert.deepStrictEqual(pb.read(), { notify: false });
});

test('notification preferences are saved by the host', async () => {
	const h = startHost();
	try {
		const ready = await h.next((m) => m.t === 'ready');
		const token = /t=([\w-]+)/.exec(ready.url)[1];
		const base = ready.url.replace(/\/\?t=.*/, '');
		const postMsg = (m) =>
			new Promise((resolve, reject) => {
				const body = JSON.stringify(m);
				const req = http.request(base + '/api/msg', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': token, 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID(), 'Content-Length': Buffer.byteLength(body) } }, (res) => {
					res.resume();
					res.on('end', resolve);
				});
				req.on('error', reject);
				req.end(body);
			});
		await postMsg({ type: 'zcDesktopPrefs', prefs: { notify: false } });
		// The engine writes its global state shortly after a change; shutdown flushes it.
		h.send({ t: 'shutdown' });
		await h.exited;
		const saved = JSON.parse(fs.readFileSync(path.join(h.tmp, 'data', 'global-state.json'), 'utf8'));
		assert.deepStrictEqual(saved['zer0neDesktop.preferences'], { notify: false }, 'persisted');
	} finally {
		if (h.child.exitCode === null) {
			h.send({ t: 'shutdown' });
			await h.exited;
		}
	}
});

test('exits when the shell goes away (stdin closes)', async () => {
	const h = startHost();
	await h.next((m) => m.t === 'ready');
	h.child.stdin.end();
	const code = await Promise.race([h.exited, new Promise((r) => setTimeout(() => r('still running'), 8000))]);
	assert.notStrictEqual(code, 'still running');
});

test('reports a missing engine instead of crashing silently', async () => {
	const h = startHost({ engineDir: path.join(os.tmpdir(), 'no-engine-here') });
	const fatal = await h.next((m) => m.t === 'fatal');
	assert.match(fatal.message, /engine is missing/);
	h.child.stdin.end();
	await h.exited;
});

(async () => {
	let failed = 0;
	for (const t of tests) {
		try {
			await t.fn();
			console.log('ok   ' + t.name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + t.name + '\n     ' + (e && e.stack ? e.stack : e));
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
