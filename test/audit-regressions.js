'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { fork, spawnSync } = require('child_process');
const crypto = require('crypto');
const { keyedSecrets, sharedGlobalMemento, transaction } = require('../host/storage');
const { createPrompts } = require('../host/prompts');
const { createDesktopShim } = require('../host/desktop-shim');
const { githubAuthentication } = require('../host/authentication');
const root = path.resolve(__dirname, '..');

if (process.argv[2] === 'fresh-lock-worker') {
	process.send('ready');
	process.once('message', () => {
		transaction(process.argv[3], value => { fs.writeFileSync(process.argv[4], 'entered'); value.after = true; });
		process.exit(0);
	});
} else if (['credential-worker', 'session-worker'].includes(process.argv[2])) {
	const credential = process.argv[2] === 'credential-worker';
	const store = credential ? keyedSecrets(process.argv[3], Buffer.from(process.argv[4], 'base64')) : sharedGlobalMemento(process.argv[3]);
	const sessions = [];
	process.send('ready');
	process.once('message', async () => {
		for (let i = 0; i < 30; i++) {
			if (credential) await store.store(`${process.pid}.${i}`, `secret-${i}`);
			else { sessions.push({ id: `${process.pid}.${i}`, title: `Chat ${i}` }); await store.update('aiChat.sessions', sessions); }
		}
		process.exit(0);
	});
} else {
	main().catch(error => { console.error(error); process.exitCode = 1; });
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-regression-'));
	const waitingFile = path.join(tmp, 'fresh-lock.json'), entered = path.join(tmp, 'fresh-lock-entered');
	const descriptor = fs.openSync(waitingFile + '.lock', 'wx');
	const waiter = fork(__filename, ['fresh-lock-worker', waitingFile, entered], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
	const waitingExit = new Promise(resolve => { waiter.once('exit', code => resolve(code)); });
	try {
		await new Promise(resolve => waiter.once('message', resolve));
		waiter.send('write');
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal(fs.existsSync(entered), false, 'a contender must not steal a live writer\'s still-empty lock');
		fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
		await new Promise(resolve => setTimeout(resolve, 50));
		assert.equal(fs.existsSync(entered), false, 'publishing the owner must retain the same exclusive lock');
		fs.writeFileSync(waitingFile, '{"before":true}');
	} finally { fs.closeSync(descriptor); fs.rmSync(waitingFile + '.lock', { force: true }); }
	assert.equal(await waitingExit, 0);
	assert.deepEqual(JSON.parse(fs.readFileSync(waitingFile, 'utf8')), { before: true, after: true });
	fs.rmSync(entered); fs.rmSync(waitingFile); fs.rmSync(waitingFile + '.bak');
	fs.writeFileSync(waitingFile + '.lock', '');
	const abandonedAt = new Date(Date.now() - 60000);
	fs.utimesSync(waitingFile + '.lock', abandonedAt, abandonedAt);
	transaction(waitingFile, value => { value.recovered = true; });
	assert.deepEqual(JSON.parse(fs.readFileSync(waitingFile, 'utf8')), { recovered: true });
	fs.rmSync(waitingFile);
	console.log('ok   a fresh lock cannot be reclaimed before its owner pid is published');
	if (process.platform === 'win32') {
		const retryFile = path.join(tmp, 'retry.json');
		transaction(retryFile, value => { value.before = true; });
		const rename = fs.renameSync;
		let attempts = 0;
		try {
			fs.renameSync = (...args) => {
				if (++attempts <= 3) throw Object.assign(new Error('Reader holds file'), { code: 'EPERM' });
				return rename(...args);
			};
			transaction(retryFile, value => { value.after = true; });
		} finally { fs.renameSync = rename; }
		assert.strictEqual(attempts, 4);
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(retryFile, 'utf8')), { before: true, after: true });
		try {
			fs.renameSync = () => { throw Object.assign(new Error('Disk failure'), { code: 'EIO' }); };
			assert.throws(() => transaction(retryFile, value => { value.bad = true; }), /Disk failure/);
		} finally { fs.renameSync = rename; }
		assert.deepStrictEqual(JSON.parse(fs.readFileSync(retryFile, 'utf8')), { before: true, after: true });
		// The last good copy is kept beside the data file; no temporary file and no lock is left behind.
		assert.deepStrictEqual(fs.readdirSync(tmp).sort(), ['retry.json', 'retry.json.bak'], 'failed replacement preserves data and cleans temporary files and locks');
		console.log('ok   Windows save retries temporary reader conflicts and preserves data on real errors');
	}
	const file = path.join(tmp, 'credentials.json');
	const key = crypto.randomBytes(32);
	const workers = Array.from({ length: 4 }, () => fork(__filename, ['credential-worker', file, key.toString('base64')], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
	const exits = workers.map(worker => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`))); }));
	await Promise.all(workers.map(worker => new Promise(resolve => worker.once('message', resolve))));
	workers.forEach(worker => worker.send('write'));
	await Promise.all(exits);
	const store = keyedSecrets(file, key);
	assert.strictEqual((await store.keys()).length, 120, 'overlapping processes preserve all credentials');
	for (const name of await store.keys()) assert.match(await store.get(name), /^secret-\d+$/);
	const other = keyedSecrets(file, key);
	await store.store('fresh', 'latest'); assert.strictEqual(await other.get('fresh'), 'latest');
	await other.delete('fresh'); assert.strictEqual(await store.get('fresh'), undefined);
	console.log('ok   concurrent credential writes and fresh reads');
	const concurrent = path.join(tmp, 'concurrent-sessions.json');
	const writers = Array.from({ length: 4 }, () => fork(__filename, ['session-worker', concurrent], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
	const finished = writers.map(worker => new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`))); }));
	await Promise.all(writers.map(worker => new Promise(resolve => worker.once('message', resolve))));
	writers.forEach(worker => worker.send('write')); await Promise.all(finished);
	assert.strictEqual(sharedGlobalMemento(concurrent).get('aiChat.sessions').length, 120, 'repeated stale writers cannot delete peer additions discovered only during merges');
	console.log('ok   concurrent session additions preserve unseen peer records');

	const state = path.join(tmp, 'state.json');
	const a = sharedGlobalMemento(state), b = sharedGlobalMemento(state);
	const ownersKey = 'aiChat.memoryMigrationOwners';
	a.get(ownersKey, {}); b.get(ownersKey, {});
	await a.update(ownersKey, { 'aiChat.memories.app': 'first-project' });
	await b.update(ownersKey, { 'aiChat.memories.app': 'second-project', 'aiChat.memories.other': 'another-project' });
	assert.deepStrictEqual(a.get(ownersKey), { 'aiChat.memories.app': 'first-project', 'aiChat.memories.other': 'another-project' }, 'stale project startup cannot claim another project’s legacy memories');
	console.log('ok   concurrent memory migration claims preserve the first owner and independent groups');
	await a.update('aiChat.sessions', [{ id: 'chat', title: 'First', messages: [{ content: 'first' }] }]);
	const stale = a.get('aiChat.sessions');
	const latest = b.get('aiChat.sessions'); latest[0].title = 'Renamed'; latest[0].messages.push({ content: 'second' });
	await b.update('aiChat.sessions', latest);
	stale[0].pinned = true;
	await a.update('aiChat.sessions', stale);
	assert.deepStrictEqual(b.get('aiChat.sessions')[0], { id: 'chat', title: 'Renamed', messages: [{ content: 'first' }, { content: 'second' }], pinned: true });
	stale[0].archived = true;
	await a.update('aiChat.sessions', stale);
	assert.strictEqual(b.get('aiChat.sessions')[0].title, 'Renamed', 'repeated stale edits preserve peer metadata');
	assert.strictEqual(b.get('aiChat.sessions')[0].messages.length, 2);
	const beforeDelete = a.get('aiChat.sessions');
	await b.update('aiChat.sessions', []);
	beforeDelete[0].title = 'Stale edit'; await a.update('aiChat.sessions', beforeDelete); a.flush();
	assert.deepStrictEqual(sharedGlobalMemento(state).get('aiChat.sessions'), []);
	fs.writeFileSync(state, '{damaged'); await assert.rejects(a.update('other', 1), /preserved/);
	assert.strictEqual(fs.readFileSync(state, 'utf8'), '{damaged');
	console.log('ok   stale chat edits merge by field; deletion and damaged data survive');

	const prompts = createPrompts(); const posted = [];
	prompts.attach(message => posted.push(message));
	const answer = prompts.request({ kind: 'pick', many: true, items: [{ label: 'one' }, { label: 'two' }] });
	prompts.replay(); assert.strictEqual(posted.length, 2);
	prompts.handle({ type: 'zcPromptReply', id: posted[0].id, value: [0, 1] }); assert.deepStrictEqual(await answer, [0, 1]);
	const invalid = prompts.request({ kind: 'pick', items: [{ label: 'header', disabled: true }] });
	prompts.handle({ type: 'zcPromptReply', id: posted.at(-1).id, value: 0 }); assert.strictEqual(await invalid, undefined);
	const closed = prompts.request({ kind: 'input' }); prompts.dispose(); assert.strictEqual(await closed, undefined);

	const answers = [5, [0, 5], undefined]; const requests = [];
	const { shim } = createDesktopShim({ engineDir: path.join(root, 'engine'), dataDir: path.join(tmp, 'shim'), key, rpc: async (op, args) => requests.push({ op, args }), prompt: async options => { requests.push(options); return answers.shift(); } });
	const items = Array.from({ length: 6 }, (_, id) => ({ label: 'duplicate', id }));
	assert.strictEqual(await shim.vscode.window.showQuickPick(items), items[5]);
	assert.deepStrictEqual(await shim.vscode.window.showQuickPick(items, { canPickMany: true }), [items[0], items[5]]);
	assert.strictEqual(requests[0].items.length, 6); assert.strictEqual(requests[1].many, true);
	assert.strictEqual(await shim.vscode.window.showQuickPick(items), undefined);
	await shim.vscode.window.showTextDocument(shim.vscode.Uri.file(path.join(tmp, '%ENV% $(hello).txt')), { selection: { start: { line: 8 } } });
	assert.strictEqual(requests.at(-1).op, 'openTextDocument'); assert.strictEqual(requests.at(-1).args.line, 9);
	testDialog();
	console.log('ok   complete picker identity, multiple selection, cancellation and dialog rendering');

	let authPrompts = 0, calls = 0;
	const auth = githubAuthentication({ secrets: () => store, prompt: async opts => { authPrompts++; assert(opts.password); return 'test-token'; }, fetch: async (_, opts) => {
		calls++; assert.strictEqual(opts.headers.Authorization, 'Bearer test-token');
		return { ok: true, headers: { get: () => 'read:user' }, json: async () => ({ id: 7, login: 'test-account' }) };
	} });
	assert.strictEqual(await auth.getSession('github', ['read:user'], { silent: true }), undefined);
	const signed = await auth.getSession('github', ['read:user'], { createIfNone: true });
	assert.strictEqual(signed.account.label, 'test-account'); assert.strictEqual(signed.accessToken, 'test-token');
	assert.strictEqual((await auth.getSession('github', ['read:user'], { silent: true })).id, signed.id);
	assert.strictEqual(authPrompts, 1); assert.strictEqual(calls, 2);
	assert(!fs.readFileSync(file, 'utf8').includes('test-token'));
	await assert.rejects(githubAuthentication({ secrets: () => store, prompt: async () => undefined }).getSession('github', ['repo'], { createIfNone: true }), /cancelled/);
	console.log('ok   GitHub sign-in validates, encrypts, reuses and cancels credentials');

	await testRemote();
	testBuild(tmp);
	console.log('Audit regression tests passed.');
}

function testDialog() {
	class Element {
		constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.isConnected = true; }
		append(...items) { items.forEach(item => this.appendChild(item)); }
		appendChild(item) { this.children.push(item); item.parent = this; return item; }
		get classList() { return {add(){}}; } setAttribute() {} focus() {} showModal() {} close() {}
		replaceChildren() { this.children = []; }
		remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
	}
	const document = { adoptedStyleSheets: [], body: new Element('body'), createElement: tag => new Element(tag) };
	let listener; const replies = [];
	vm.runInNewContext(fs.readFileSync(path.join(root, 'host/dialog-ui.js'), 'utf8'), { document, window: { addEventListener: (_, fn) => { listener = fn; }, Bridge: { post: message => replies.push(message) } }, CSSStyleSheet: class { replaceSync() {} } });
	listener({ data: { type: 'zcPrompt', id: 1, options: { kind: 'pick', many: true, items: Array.from({ length: 7 }, (_, i) => ({ label: 'Choice ' + i })) } } });
	const form = document.body.children[0].children[0];
	const list = form.children.find(el => el.className === 'zc-dialog-list'); assert.strictEqual(list.children.length, 7);
	for (const i of [2, 6]) { const control = list.children[i].children[0]; control.checked = true; control.onchange(); }
	form.onsubmit({ preventDefault() {} }); assert.deepStrictEqual(JSON.parse(JSON.stringify(replies[0])), { type: 'zcPromptReply', id: 1, value: [2, 6] });
	assert.strictEqual(document.body.children.length, 0);
	listener({ data: { type: 'zcPrompt', id: 2, options: { kind: 'log', title: 'Mods logs', content: '<diagnostic> registration failed' } } });
	const logForm = document.body.children[0].children[0];
	assert.strictEqual(logForm.children.find(el => el.tag === 'pre').textContent, '<diagnostic> registration failed');
	const foot = logForm.children.find(el => el.className === 'zc-dialog-foot');
	assert.strictEqual(foot.children.length, 1); assert.strictEqual(foot.children[0].textContent, 'Close');
	foot.children[0].onclick(); assert.strictEqual(document.body.children.length, 0);
}

async function testRemote() {
	const http = require('http');
	const { RemoteServer } = require('../engine/out/remote');
	const server = new RemoteServer(path.join(root, 'engine/media'), { token: () => 'regression-token', attach: () => ({ dispose() {}, handle: async () => {} }) }, { desktop: true });
	await server.start(0);
	const get = (route, headers = {}) => new Promise((resolve, reject) => {
		const request = http.get(`http://127.0.0.1:${server.info().port}${route}`, { headers }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
		request.setTimeout(2000, () => request.destroy(new Error('Request hung'))); request.on('error', reject);
	});
	try {
		assert.strictEqual(await get('/', { Cookie: 'zr=%' }), 401);
		assert.strictEqual(await get('/?t=regression-token', { Cookie: 'zr=%' }), 200);
		server.route = async () => { throw new Error('test routing failure'); };
		assert.strictEqual(await get('/?t=regression-token'), 500);
	} finally { await server.stop(); }
	console.log('ok   malformed cookies and rejected routes return bounded HTTP responses');
}

function testBuild(tmp) {
	// A copy of the project layout: scripts/build-engine.js, an engine whose compile fails, and the last good build.
	const fixture = path.join(tmp, 'build');
	for (const dir of ['scripts', 'engine/out', 'node_modules/typescript/bin']) fs.mkdirSync(path.join(fixture, dir), { recursive: true });
	fs.copyFileSync(path.join(root, 'scripts/build-engine.js'), path.join(fixture, 'scripts/build-engine.js'));
	fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"0.0.0"}');
	fs.writeFileSync(path.join(fixture, 'engine/package.json'), '{"version":"0.0.0"}');
	fs.writeFileSync(path.join(fixture, 'engine/tsconfig.json'), '{}');
	fs.writeFileSync(path.join(fixture, 'node_modules/typescript/bin/tsc'), 'process.exit(1)');
	fs.writeFileSync(path.join(fixture, 'engine/out/sentinel'), 'last successful engine');
	const result = spawnSync(process.execPath, [path.join(fixture, 'scripts/build-engine.js')], { encoding: 'utf8' });
	assert.strictEqual(result.status, 1); assert.match(result.stderr, /TypeScript errors/);
	assert.strictEqual(fs.readFileSync(path.join(fixture, 'engine/out/sentinel'), 'utf8'), 'last successful engine');
	assert.deepStrictEqual(fs.readdirSync(path.join(fixture, 'engine')).sort(), ['out', 'package.json', 'tsconfig.json'], 'no half-built folder is left behind');
	console.log('ok   failed compilation fails the build and preserves its previous engine');
}
