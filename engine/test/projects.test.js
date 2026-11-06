// Project/session backend only; no network, editor, or installed extension writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShim, install } = require('./vscode-shim');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-projects-test-'));
const folders = ['alpha', 'beta', 'picked'].map((name) => {
	const dir = path.join(temp, name);
	fs.mkdirSync(dir);
	return dir;
});
const [alpha, beta, picked] = folders;
const missing = path.join(temp, 'missing');
const notDirectory = path.join(temp, 'file.txt');
fs.writeFileSync(notDirectory, 'not a folder');
const shim = createShim({ dataDir: path.join(temp, 'state'), workspace: alpha });
install(shim.vscode);
const { ProviderStore, normalizeProjectPath, projectPathKey, PROJECT_CURRENT_SESSION_PREFIX } = require('../out/providerStore');
const { ProjectsHost, PROJECTS_KEY, PROJECT_HANDOFF_PREFIX, UNASSIGNED_PROJECT_ID } = require('../out/host/projectsHost');
const { SessionsHost } = require('../out/host/sessionsHost');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const message = { id: 'm1', role: 'user', content: 'Do work' };
const meta = (id, projectPath, messages = [message]) => ({ id, projectPath, title: id, messages, updatedAt: 1 });
function memory(initial = {}) {
	const data = new Map(Object.entries(initial));
	return {
		get: (key, fallback) => data.has(key) ? structuredClone(data.get(key)) : fallback,
		update: async (key, value) => value === undefined ? data.delete(key) : data.set(key, structuredClone(value)),
		keys: () => [...data.keys()]
	};
}
function fixture(sessions = [meta('a', alpha), meta('b', beta)], initial = {}) {
	shim.setWorkspace(alpha);
	shim.vscode.window.showOpenDialog = async () => undefined;
	const state = memory({ 'aiChat.sessions': sessions, 'aiChat.currentSession': 'global-other', ...initial });
	const store = new ProviderStore({ globalState: state });
	const calls = { switches: [], creates: 0, opens: [], statuses: [], posts: [] };
	let current = 'a';
	const deps = {
		currentId: () => current,
		switchSession: async (id) => { calls.switches.push(id); current = id; },
		newChat: async () => { calls.creates++; current = (await store.createSession()).id; }
	};
	const ctx = { store, postAll: (m) => calls.posts.push(m), status: (...args) => calls.statuses.push(args), sendState: async () => {} };
	const host = new ProjectsHost(ctx, state, deps);
	const surface = { kind: 'chat', post: (m) => calls.posts.push(m) };
	shim.vscode.commands.executeCommand = async (...args) => { calls.opens.push(args); };
	return { store, state, calls, deps, ctx, host, surface, setCurrent: (id) => { current = id; } };
}
const handoffKey = (folder) => PROJECT_HANDOFF_PREFIX + projectPathKey(folder);

test('chapters persist without rewriting messages and reject missing messages or stale sessions', async () => {
	const f = fixture();
	await f.store.toggleChapter('a','m1');
	assert.deepEqual((await f.store.getSession('a')).chapters,['m1']);
	await f.store.saveMessages('a',[message,{id:'m2',role:'assistant',content:'Answer'}]);
	assert.deepEqual((await f.store.getSession('a')).chapters,['m1']);
	await f.store.toggleChapter('a','missing');
	assert.deepEqual((await f.store.getSession('a')).chapters,['m1']);
	let saves=0;
	const host=new SessionsHost(f.ctx,{...f.deps,busy:()=>false,saveCurrent:async()=>{saves++;}});
	await host.handle(f.surface,{type:'toggleChapter',sessionId:'b',id:'m1'});
	assert.equal(saves,0);
	await host.handle(f.surface,{type:'toggleChapter',sessionId:'a',id:'m1'});
	assert.equal(saves,1);assert.deepEqual((await f.store.getSession('a')).chapters,[]);
	assert.deepEqual((await f.store.getSession('a')).messages,[message,{id:'m2',role:'assistant',content:'Answer'}]);
});

test('new sessions use the first local workspace root; empty reuse is project-scoped', async () => {
	const f = fixture([]);
	const a = await f.store.createSession();
	assert.equal(a.projectPath, alpha);
	assert.equal((await f.store.createSession()).id, a.id);
	shim.setWorkspace(beta);
	const b = await f.store.createSession();
	assert.notEqual(b.id, a.id);
	assert.equal(b.projectPath, beta);
	shim.setWorkspace(alpha);
	assert.equal((await f.store.createSession()).id, a.id);
	assert.equal((await f.store.listSessions()).find((s) => s.id === a.id).projectPath, alpha);
});

test('legacy migration and legacy empty chats stay unassigned', async () => {
	const f = fixture([], { 'aiChat.messages': [message] });
	const legacy = (await f.store.listSessions())[0];
	assert.equal(legacy.projectPath, undefined);
	assert.equal((await f.store.createSession()).projectPath, alpha);
	const old = fixture([meta('legacy-empty', undefined, [])]);
	assert.notEqual((await old.store.createSession()).id, 'legacy-empty');
	assert.equal((await old.store.getSession('legacy-empty')).projectPath, undefined);
});

test('save, branch, import and metadata preserve roots without assigning legacy branches', async () => {
	const f = fixture([meta('a', alpha), meta('legacy', undefined)]);
	shim.setWorkspace(beta);
	const branch = await f.store.branchSession('a', 'm1');
	assert.equal(branch.projectPath, alpha);
	assert.equal((await f.store.branchSession('legacy', 'm1')).projectPath, undefined);
	const imported = await f.store.importSession('Imported', [message], alpha);
	assert.equal(imported.projectPath, alpha);
	assert.equal((await f.store.importSession('Current project', [message])).projectPath, beta);
	assert.equal((await f.store.importSession('Unknown root', [message], '')).projectPath, undefined);
	await f.store.saveMessages(imported.id, [{ ...message, content: 'changed' }]);
	await f.store.updateSession(imported.id, { title: 'Renamed', pinned: true });
	assert.equal((await f.store.getSession(imported.id)).projectPath, alpha);
	assert.equal((await f.store.listSessions()).find((s) => s.id === imported.id).projectPath, alpha);
});

test('branching carries the chat workflow into the new chat', async () => {
	const f = fixture([meta('a', alpha)]);
	const profile = { enabled: true, workerModel: 'p::worker', reviewerModel: 'p::reviewer', maxConcurrency: 4, review: true, dispatchOnly: true };
	await f.store.setSubagentWorkflow('a', profile);
	const branch = await f.store.branchSession('a', 'm1');
	assert.deepEqual(await f.store.getSubagentWorkflow(branch.id), profile);
});

test('saved workflow runs report an unfinished turn as running', async () => {
	const f = fixture([meta('a', alpha, [{ id: 'turn', role: 'user', content: 'Work', turn: { startedAt: 1, providerId: 'p', model: 'm', workflow: { enabled: true } } }])]);
	const runs = await f.store.workflowRuns();
	assert.equal(runs.length, 1);
	assert.equal(runs[0].status, 'running');
});

test('branch destinations preserve history and route the worktree chat without switching the source project', async () => {
	const messages = [message, { id: 'answer', role: 'assistant', content: 'First answer' }, { id: 'later', role: 'user', content: 'Next turn' }];
	const f = fixture([meta('a', alpha, messages)]);
	await f.store.setCurrentSession('a');
	let creates = 0, localOpens = 0;
	const host = new SessionsHost(f.ctx, {
		...f.deps, busy: () => false, saveCurrent: async () => {},
		createWorktree: async title => { creates++; assert.equal(title, 'a'); return beta; },
		openSession: id => f.host.routeSession(id), openCurrent: async () => { localOpens++; }
	});
	await host.handle(f.surface, { type: 'branchChat', id: 'answer', sessionId: 'stale', destination: 'worktree' });
	await host.handle(f.surface, { type: 'branchChat', id: 'missing', sessionId: 'a', destination: 'worktree' });
	await host.handle(f.surface, { type: 'branchChat', id: 'answer', sessionId: 'a', destination: 'invalid' });
	assert.equal(creates, 0);
	await assert.rejects(host.handle({ kind: 'remote' }, { type: 'branchChat', id: 'answer', destination: 'worktree' }), /desktop/);
	await host.handle(f.surface, { type: 'branchChat', id: 'answer', sessionId: 'a', destination: 'worktree' });
	assert.equal(creates, 1);
	const branch = (await f.store.listSessions()).find(s => s.id !== 'a');
	assert.equal(branch.projectPath, beta);
	const saved = await f.store.getSession(branch.id);
	assert.deepEqual(saved.messages, messages.slice(0, 2));
	assert.equal(saved.branchedFrom.id, 'a');
	assert.equal(saved.branchedFrom.afterId, 'answer');
	assert.equal(await f.store.currentSessionId(), 'a');
	assert.deepEqual((await f.store.getSession('a')).messages, messages);
	assert.deepEqual(f.calls.switches, []);
	assert.equal(localOpens, 0);
	assert.equal(f.calls.opens[0][1].fsPath, beta);
	assert.deepEqual(f.state.get(handoffKey(beta)), { kind: 'session', sessionId: branch.id });
	shim.setWorkspace(beta);
	await f.host.handoff();
	assert.deepEqual(f.calls.switches, [branch.id]);
	shim.setWorkspace(alpha);
	f.setCurrent('a');
	await host.handle(f.surface, { type: 'branchChat', id: 'answer', destination: 'workspace' });
	assert.equal(localOpens, 1);
	assert.equal((await f.store.getSession(await f.store.currentSessionId())).projectPath, alpha);
});

test('failed worktree creation leaves the original chat current and allows retry', async () => {
	const f = fixture();
	await f.store.setCurrentSession('a');
	let fail = true;
	const host = new SessionsHost(f.ctx, {
		...f.deps, busy: () => false, saveCurrent: async () => {}, openCurrent: async () => {}, openSession: async () => {},
		createWorktree: async () => { if (fail) throw new Error('The repository has no commits yet'); return beta; }
	});
	await assert.rejects(host.handle(f.surface, { type: 'branchChat', id: 'm1', destination: 'worktree' }), /no commits/);
	assert.equal((await f.store.listSessions()).length, 2);
	assert.equal(await f.store.currentSessionId(), 'a');
	fail = false;
	await host.handle(f.surface, { type: 'branchChat', id: 'm1', destination: 'worktree' });
	assert.equal((await f.store.listSessions()).length, 3);
});

test('a worktree whose branch fails is removed and the original chat stays current', async () => {
	const f = fixture([meta('a', alpha)]);
	await f.store.setCurrentSession('a');
	const removed = [];
	const original = f.store.branchSession;
	f.store.branchSession = async () => { throw new Error('The chat changed before the branch was created'); };
	try {
		const host = new SessionsHost(f.ctx, {
			...f.deps, busy: () => false, saveCurrent: async () => {}, openSession: async () => {},
			createWorktree: async () => beta,
			removeWorktree: async path => removed.push(path)
		});
		await assert.rejects(host.handle(f.surface, { type: 'branchChat', id: 'm1', destination: 'worktree' }), /chat changed/);
		assert.deepEqual(removed, [beta], 'the new checkout is rolled back');
		assert.equal(await f.store.currentSessionId(), 'a');
	} finally {
		f.store.branchSession = original;
	}
});

test('a worktree whose branch was not created is removed without touching the source chat', async () => {
	const f = fixture([meta('a', alpha)]);
	await f.store.setCurrentSession('a');
	const removed = [];
	const original = f.store.branchSession;
	f.store.branchSession = async () => undefined;
	try {
		const host = new SessionsHost(f.ctx, {
			...f.deps, busy: () => false, saveCurrent: async () => {}, openSession: async () => {},
			createWorktree: async () => beta,
			removeWorktree: async path => removed.push(path)
		});
		await assert.rejects(host.handle(f.surface, { type: 'branchChat', id: 'm1', destination: 'worktree' }), /chat changed/);
		assert.deepEqual(removed, [beta]);
		assert.equal((await f.store.listSessions()).length, 1);
	} finally {
		f.store.branchSession = original;
	}
});

test('foreign import uses the recorded original cwd, not the active workspace', async () => {
	const f = fixture();
	const foreign = require('../out/foreignSessions');
	const originalList = foreign.listForeignSessions;
	const originalLoad = foreign.loadForeignSession;
	try {
		foreign.listForeignSessions = () => [{ source: 'codex', path: 'known-import', cwd: beta, title: 'Foreign chat' }];
		foreign.loadForeignSession = () => [{ role: 'user', content: 'hello' }];
		const host = new SessionsHost(f.ctx, { busy: () => false, saveCurrent: async () => {}, openCurrent: async () => {} });
		await host.handle(f.surface, { type: 'foreignImport', source: 'codex', path: 'known-import' });
		const imported = (await f.store.listSessions()).find((s) => s.title === 'Foreign chat · Codex');
		assert.equal(imported.projectPath, beta);
	} finally {
		foreign.listForeignSessions = originalList;
		foreign.loadForeignSession = originalLoad;
	}
});

test('project list includes actual multi-root folders, recorded roots, availability and unassigned chats', async () => {
	const f = fixture([meta('a', alpha), meta('b', beta), meta('missing', missing), meta('file', notDirectory), meta('legacy', undefined), meta('bad', 'relative')], { [PROJECTS_KEY]: [picked, beta, 'relative', 'https://example.com'] });
	const original = Object.getOwnPropertyDescriptor(shim.vscode.workspace, 'workspaceFolders');
	Object.defineProperty(shim.vscode.workspace, 'workspaceFolders', { configurable: true, get: () => [
		{ uri: shim.vscode.Uri.file(alpha), name: 'Workspace label', index: 0 },
		{ uri: shim.vscode.Uri.file(beta), name: 'Second root', index: 1 },
		{ uri: { scheme: 'ssh', fsPath: '/remote' }, name: 'Remote', index: 2 }
	] });
	try {
		assert.equal(await f.host.handle(f.surface, { type: 'getProjects' }), true);
		const result = f.calls.posts.at(-1);
		assert.equal(result.type, 'projects');
		assert.equal(result.currentSessionId, 'a', 'window-local dependency beats the global current session');
		assert.equal(result.currentProjectId, projectPathKey(alpha));
		const entry = (p) => result.projects.find((e) => e.path === p);
		assert.equal(entry(alpha).name, 'Workspace label');
		assert.equal(entry(alpha).current, true);
		assert.equal(entry(beta).current, false);
		assert.equal(entry(beta).name, 'Second root');
		assert.equal(entry(picked).available, true);
		assert.equal(entry(missing).available, false);
		assert.equal(entry(notDirectory).available, false);
		const unassigned = result.projects.find((e) => e.id === UNASSIGNED_PROJECT_ID);
		assert.equal(unassigned.path, '');
		assert.equal(unassigned.name, 'Unassigned chats');
		assert.equal(unassigned.current, false);
		assert.deepEqual(unassigned.chats.map((s) => s.id), ['legacy', 'bad']);
		assert.equal(result.projects.length, 6);
	} finally {
		Object.defineProperty(shim.vscode.workspace, 'workspaceFolders', original);
	}
});

test('current project and unassigned navigation stay local and skip same-session switching', async () => {
	const f = fixture([meta('a', alpha), meta('a2', alpha), meta('legacy', undefined)]);
	await f.host.handle(f.surface, { type: 'projectOpen', path: alpha, sessionId: 'a' });
	assert.deepEqual(f.calls.switches, []);
	await f.host.handle(f.surface, { type: 'projectOpen', path: alpha, sessionId: 'a2' });
	await f.host.handle(f.surface, { type: 'projectOpen', path: '', sessionId: 'legacy' });
	assert.deepEqual(f.calls.switches, ['a2', 'legacy']);
	assert.deepEqual(f.calls.opens, []);
	await f.host.handle(f.surface, { type: 'projectNewChat', path: alpha });
	assert.equal(f.calls.creates, 1);
});

test('other project chat opens a separate window and consumes handoff only in its first root', async () => {
	const f = fixture();
	await f.host.handle(f.surface, { type: 'projectOpen', path: path.join(beta, '..', 'beta'), sessionId: 'b' });
	assert.equal(f.calls.opens[0][0], 'vscode.openFolder');
	assert.equal(f.calls.opens[0][1].fsPath, beta);
	assert.equal(f.calls.opens[0][2], true);
	assert.deepEqual(f.calls.switches, []);
	assert.deepEqual(f.state.get(handoffKey(beta)), { kind: 'session', sessionId: 'b' });
	await f.host.handoff();
	assert.ok(f.state.get(handoffKey(beta)), 'wrong window leaves handoff alone');
	shim.setWorkspace(beta);
	assert.equal(await f.host.handle(f.surface, { type: 'ready' }), false, 'controller must still handle ready');
	await f.host.handoff();
	assert.deepEqual(f.calls.switches, ['b']);
	assert.equal(f.state.get(handoffKey(beta)), undefined);
});

test('secondary workspace root opens a new window rather than switching local context', async () => {
	const f = fixture();
	const original = Object.getOwnPropertyDescriptor(shim.vscode.workspace, 'workspaceFolders');
	Object.defineProperty(shim.vscode.workspace, 'workspaceFolders', { configurable: true, get: () => folders.slice(0, 2).map((p, index) => ({ uri: shim.vscode.Uri.file(p), name: path.basename(p), index })) });
	try {
		await f.host.handle(f.surface, { type: 'projectOpen', path: beta, sessionId: 'b' });
		await f.host.handoff();
		assert.equal(f.calls.opens.length, 1);
		assert.deepEqual(f.calls.switches, []);
		assert.ok(f.state.get(handoffKey(beta)));
	} finally { Object.defineProperty(shim.vscode.workspace, 'workspaceFolders', original); }
});

test('cross-project new chat is created only in the destination; ready is one-shot', async () => {
	const f = fixture();
	await f.host.handle(f.surface, { type: 'projectNewChat', path: beta });
	assert.equal(f.calls.creates, 0);
	assert.deepEqual(f.state.get(handoffKey(beta)), { kind: 'create' });
	shim.setWorkspace(beta);
	await Promise.all([f.host.handle(f.surface, { type: 'ready' }), f.host.handle(f.surface, { type: 'ready' })]);
	assert.equal(f.calls.creates, 1);
	assert.equal((await f.store.getSession(f.deps.currentId())).projectPath, beta);
	assert.equal(f.state.get(handoffKey(beta)), undefined);
});

test('handoff rejects deleted or wrongly-associated chats and does not switch the current chat again', async () => {
	const f = fixture();
	await f.state.update(handoffKey(alpha), { kind: 'session', sessionId: 'b' });
	await f.host.handoff();
	await f.state.update(handoffKey(alpha), { kind: 'session', sessionId: 'deleted' });
	await f.host.handoff();
	await f.state.update(handoffKey(alpha), { kind: 'session', sessionId: 'a' });
	await f.host.handoff();
	assert.deepEqual(f.calls.switches, []);
	assert.equal(f.calls.statuses.length, 2);
	assert.equal(f.state.get(handoffKey(alpha)), undefined);
});

test('path validation, known-folder allowlist, chat association and unavailable roots block forged actions', async () => {
	const f = fixture([meta('a', alpha), meta('b', beta), meta('missing', missing), meta('file', notDirectory), meta('legacy', undefined)]);
	const attacks = [
		{ path: 'relative', sessionId: 'a' }, { path: 'file:///etc', sessionId: 'a' },
		{ path: alpha + '\0', sessionId: 'a' }, { path: picked, sessionId: 'a' },
		{ path: alpha, sessionId: 'b' }, { path: beta, sessionId: 'a' },
		{ path: beta, sessionId: { id: 'b' } }, { path: missing, sessionId: 'missing' },
		{ path: notDirectory }, { path: '', sessionId: 'b' }, { path: undefined }
	];
	for (const payload of attacks) await f.host.handle(f.surface, { type: 'projectOpen', ...payload });
	await f.host.handle(f.surface, { type: 'projectNewChat', path: '' });
	assert.equal(f.calls.statuses.length, attacks.length + 1);
	assert.deepEqual(f.calls.switches, []);
	assert.deepEqual(f.calls.opens, []);
	assert.equal(f.calls.creates, 0);
	assert.equal(normalizeProjectPath('relative'), undefined);
	assert.equal(normalizeProjectPath('https://example.com'), undefined);
	if (process.platform === 'win32') assert.equal(normalizeProjectPath('\\relative-to-drive'), undefined);
});

test('folder picker records valid folders, opens new windows, and ignores cancellation', async () => {
	const f = fixture();
	await f.host.handle(f.surface, { type: 'projectPick' });
	assert.deepEqual(f.calls.opens, []);
	shim.vscode.window.showOpenDialog = async (opts) => {
		assert.equal(opts.canSelectFiles, false);
		assert.equal(opts.canSelectFolders, true);
		assert.equal(opts.canSelectMany, false);
		return [shim.vscode.Uri.file(picked)];
	};
	await f.host.handle(f.surface, { type: 'projectPick' });
	await f.host.handle(f.surface, { type: 'projectPick' });
	assert.deepEqual(f.state.get(PROJECTS_KEY), [picked]);
	assert.equal(f.calls.opens[0][2], true);
	assert.equal((await f.host.getProjects()).projects.find((p) => p.path === picked).chats.length, 0);
	shim.vscode.window.showOpenDialog = async () => [{ scheme: 'ssh', fsPath: picked }];
	await f.host.handle(f.surface, { type: 'projectPick' });
	assert.equal(f.calls.opens.length, 2);
	assert.equal(f.calls.statuses.length, 1);
});

test('failed open removes pending handoff and reports the actual error', async () => {
	const f = fixture();
	shim.vscode.commands.executeCommand = async () => { throw new Error('window failed'); };
	await f.host.handle(f.surface, { type: 'projectOpen', path: beta, sessionId: 'b' });
	assert.equal(f.state.get(handoffKey(beta)), undefined);
	assert.equal(f.calls.statuses[0][0], 'window failed');
});

test('generic History navigation routes another project to its own window without switching locally', async () => {
	const f = fixture([meta('a', alpha), meta('a2', alpha), meta('b', beta), meta('legacy', undefined)]);
	const fallback = new SessionsHost(f.ctx, { currentId: f.deps.currentId, switchSession: f.deps.switchSession });
	const dispatch = async (id) => {
		if (!await f.host.handle(f.surface, { type: 'switchSession', id, path: alpha })) {
			await fallback.handle(f.surface, { type: 'switchSession', id });
		}
	};
	await dispatch('b');
	assert.deepEqual(f.calls.switches, []);
	assert.equal(f.deps.currentId(), 'a');
	assert.equal(f.calls.opens[0][1].fsPath, beta, 'root comes from metadata, not the message');
	assert.equal(f.calls.opens[0][2], true);
	assert.deepEqual(f.state.get(handoffKey(beta)), { kind: 'session', sessionId: 'b' });
	await dispatch('a');
	await dispatch('a2');
	await dispatch('legacy');
	assert.deepEqual(f.calls.switches, ['a2', 'legacy']);
});

test('generic History refuses unavailable and deleted chats and routes from a folderless window safely', async () => {
	const f = fixture([meta('a', alpha), meta('b', beta), meta('missing', missing)]);
	await f.host.handle(f.surface, { type: 'switchSession', id: 'missing' });
	await f.host.handle(f.surface, { type: 'switchSession', id: 'deleted' });
	assert.equal(f.calls.statuses.length, 2);
	assert.deepEqual(f.calls.opens, []);
	assert.deepEqual(f.calls.switches, []);
	shim.setWorkspace(undefined);
	await f.host.routeSession('b');
	assert.equal(f.calls.opens[0][1].fsPath, beta);
	assert.deepEqual(f.calls.switches, []);
});

test('SessionsHost and direct store switches fail closed without project routing', async () => {
	const f = fixture([meta('a', alpha), meta('a2', alpha), meta('b', beta), meta('legacy', undefined)]);
	const host = new SessionsHost(f.ctx, { currentId: f.deps.currentId, switchSession: f.deps.switchSession });
	await host.handle(f.surface, { type: 'switchSession', id: 'b' });
	await host.handle(f.surface, { type: 'switchSession', id: 'deleted' });
	assert.deepEqual(f.calls.switches, []);
	assert.equal(f.calls.statuses.length, 2);
	await f.store.setCurrentSession('a');
	await assert.rejects(f.store.setCurrentSession('b'), /project window/);
	assert.equal(await f.store.currentSessionId(), 'a');
	await host.handle(f.surface, { type: 'switchSession', id: 'a2' });
	await host.handle(f.surface, { type: 'switchSession', id: 'legacy' });
	assert.deepEqual(f.calls.switches, ['a2', 'legacy']);
	shim.setWorkspace(undefined);
	await assert.rejects(f.store.setCurrentSession('a'), /project window/);
});

test('controller direct switches route foreign chats before cancelling and do not recurse for local chats', async () => {
	const f = fixture([meta('a', alpha), meta('a2', alpha), meta('b', beta)]);
	const { ChatController } = require('../out/chatController');
	let cancelled = 0;
	let warmerCancelled = 0;
	let uploadsCleared = 0;
	const notices = [];
	// Exercise the actual entry method without starting unrelated controller services.
	const controller = Object.create(ChatController.prototype);
	Object.assign(controller, {
		store: f.store, sessionId: 'a', queue: ['keep queued prompt'], sessionQueues: new Map(),
		attachments: { clear: () => { uploadsCleared++; } },
		warmer: { cancel: () => { warmerCancelled++; } },
		cancelRun: () => { cancelled++; },
		loadCurrent: async () => { controller.sessionId = await f.store.currentSessionId(); },
		agentRuns: { hasNotices: () => false },
		status: (...args) => notices.push(args)
	});
	controller.projects = new ProjectsHost(f.ctx, f.state, {
		currentId: () => controller.sessionId,
		switchSession: (id) => controller.switchSession(id),
		newChat: async () => {}
	});
	await controller.switchSession('b');
	assert.equal(controller.sessionId, 'a');
	assert.equal(cancelled, 0);
	assert.equal(warmerCancelled, 0);
	assert.deepEqual(controller.queue, ['keep queued prompt']);
	assert.equal(uploadsCleared, 0, 'foreign-project routing leaves this window drafts intact');
	assert.equal(f.calls.opens[0][1].fsPath, beta);
	await controller.switchSession('deleted');
	assert.equal(notices.length, 1);
	assert.equal(cancelled, 0);
	assert.equal(uploadsCleared, 0, 'invalid-session navigation leaves drafts intact');
	await controller.projects.routeSession('a2');
	assert.equal(controller.sessionId, 'a2');
	assert.equal(cancelled, 1);
	assert.equal(warmerCancelled, 1);
	assert.equal(uploadsCleared, 0, 'a successful local switch leaves draft restoration to loadCurrent instead of deleting uploads');
	assert.equal(f.calls.opens.length, 1);
	await controller.switchSession('a2');
	assert.equal(cancelled, 1);
	assert.equal(uploadsCleared, 0, 'same-session navigation preserves the current draft');
});

test('startup ignores another root global pointer and restores each project independently', async () => {
	const f = fixture([meta('a', alpha), meta('b', beta)], { 'aiChat.currentSession': 'b' });
	assert.equal(await f.store.currentSessionId(), 'a');
	await f.store.setCurrentSession('a');
	shim.setWorkspace(beta);
	await f.store.setCurrentSession('b');
	assert.equal(await f.store.currentSessionId(), 'b');
	shim.setWorkspace(alpha);
	assert.equal(await new ProviderStore({ globalState: f.state }).currentSessionId(), 'a');
	assert.equal(f.state.get(PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(beta)), 'b');
	await f.state.update('aiChat.currentSession', 'b');
	await f.state.update(PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(alpha), 'b');
	assert.equal(await f.store.currentSessionId(), 'a', 'another window cannot change the in-memory current chat');
	assert.equal(await new ProviderStore({ globalState: f.state }).currentSessionId(), 'a', 'a poisoned per-root pointer is rejected too');
	await assert.rejects(f.store.setCurrentSession('deleted'), /no longer exists/);
});

test('a project with no local or legacy chat creates a scoped chat instead of loading another root', async () => {
	const f = fixture([meta('b', beta)], { 'aiChat.currentSession': 'b' });
	const id = await f.store.currentSessionId();
	assert.notEqual(id, 'b');
	assert.equal((await f.store.getSession(id)).projectPath, alpha);
	assert.equal((await f.store.listSessions()).length, 2);
	await f.store.deleteSession(id);
	assert.notEqual(await f.store.currentSessionId(), 'b');
	assert.equal((await f.store.getSession(await f.store.currentSessionId())).projectPath, alpha);
});

test('explicit legacy selection remains local and an imported foreign root never poisons local startup', async () => {
	const f = fixture([meta('a', alpha), meta('b', beta), meta('legacy', undefined)]);
	await f.store.setCurrentSession('legacy');
	assert.equal(await f.store.currentSessionId(), 'legacy');
	await f.store.setCurrentSession('a');
	const imported = await f.store.importSession('Foreign', [message], beta);
	assert.equal(await f.store.currentSessionId(), imported.id, 'explicit imports still open immediately');
	assert.equal(await new ProviderStore({ globalState: f.state }).currentSessionId(), 'a', 'restart never opens the foreign root by accident');
	const onlyLegacy = fixture([meta('b', beta), meta('legacy', undefined)], { 'aiChat.currentSession': 'b' });
	assert.equal(await onlyLegacy.store.currentSessionId(), 'legacy');
});

test('same-instance concurrent session create, import and save operations do not lose chats', async () => {
	const f = fixture([meta('a', alpha)]);
	const result = await Promise.all([
		f.store.createSession(), f.store.createSession(),
		f.store.importSession('one', [message], alpha), f.store.importSession('two', [message], alpha),
		f.store.saveMessages('a', [{ ...message, content: 'updated' }])
	]);
	assert.equal(result[0].id, result[1].id);
	assert.equal((await f.store.listSessions()).length, 4);
	assert.equal((await f.store.loadMessages('a'))[0].content, 'updated');
});

test('no local workspace means no current project and no handoff consumption', async () => {
	const f = fixture();
	shim.setWorkspace(undefined);
	await f.state.update(handoffKey(alpha), { kind: 'create' });
	const result = await f.host.getProjects();
	assert.equal(result.currentProjectId, null);
	assert.ok(result.projects.every((p) => !p.current));
	await f.host.handoff();
	assert.equal(f.calls.creates, 0);
	assert.ok(f.state.get(handoffKey(alpha)));
	assert.equal((await f.store.createSession()).projectPath, undefined);
});

(async () => {
	let failed = 0;
	try {
		for (const [name, fn] of tests) {
			try { await fn(); console.log(`PASS ${name}`); }
			catch (e) { failed++; console.error(`FAIL ${name}`, e); }
		}
		console.log(`${tests.length - failed}/${tests.length} project backend tests passed`);
	} finally { fs.rmSync(temp, { recursive: true, force: true }); }
	process.exitCode = failed ? 1 : 0;
})();
