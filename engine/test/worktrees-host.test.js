// Standalone host-contract tests: node --test test/worktrees-host.test.js
// Transpile only the owned host so concurrent changes in other modules cannot mask failures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript-classic');

const source = fs.readFileSync(path.join(__dirname, '../src/host/worktreesHost.ts'), 'utf8');
const code = ts.transpileModule(source, {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function setup() {
	const main = path.resolve('fixture-repo');
	const extra = path.resolve('fixture-repo.worktrees', 'task');
	let root = { scheme: 'file', fsPath: main };
	let items = [
		{ path: main, branch: 'main', head: '1234567', main: true },
		{ path: extra, head: '7654321', main: false, locked: true }
	];
	let listError;
	let dirty = false;
	let warning = 'Remove anyway';
	let exists = true;
	const commands = [];
	const messages = [];
	const updates = [];
	const statuses = [];
	const listCalls = [];
	const removed = [];
	const mocks = {
		vscode: {
			Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
			commands: { executeCommand: async (...args) => commands.push(args) },
			window: {
				showInformationMessage: async () => undefined,
				showWarningMessage: async () => warning
			}
		},
		'../tools/agentTools': { workspaceRoot: () => root },
		'../worktrees': {
			listWorktrees: async (cwd) => {
				listCalls.push(cwd);
				if (listError) throw listError;
				return items;
			},
			createWorktree: async () => ({ path: extra, branch: 'zer0ne/task', main: false }),
			isDirty: async () => dirty,
			removeWorktree: async (cwd, dir, force) => removed.push({ cwd, dir, force }),
			pruneWorktrees: async (cwd) => removed.push({ cwd, pruned: true })
		}
	};
	const module = { exports: {} };
	vm.runInNewContext(code, {
		exports: module.exports, module, process, Error,
		require: (name) => name === 'path' ? path : name === 'fs' ? { existsSync: () => exists } : mocks[name]
	});
	const host = new module.exports.WorktreesHost(
		{ status: (...args) => statuses.push(args), postAll: (message) => messages.push(message) },
		{ get: (_key, fallback) => fallback, update: async (...args) => updates.push(args) }
	);
	return {
		host, main, extra, commands, updates, statuses, listCalls, removed,
		surface: { kind: 'chat', post: (message) => messages.push(message) },
		messages,
		setRoot: (value) => { root = value; },
		setItems: (value) => { items = value; },
		setListError: (value) => { listError = value; },
		setDirty: (value) => { dirty = value; },
		setWarning: (value) => { warning = value; },
		setExists: (value) => { exists = value; }
	};
}

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test('getWorktrees projects every requested field, including detached and locked worktrees', async () => {
	const f = setup();
	assert.equal(await f.host.handle(f.surface, { type: 'getWorktrees' }), true);
	assert.deepEqual(plain(f.messages), [{ type: 'worktrees', items: [
		{ path: f.main, branch: 'main', head: '1234567', main: true, locked: false, current: true },
		{ path: f.extra, branch: '', head: '7654321', main: false, locked: true, current: false }
	] }]);
	assert.deepEqual(f.listCalls, [f.main]);
});

test('current recognizes workspace subfolders but not sibling prefix matches', async () => {
	const f = setup();
	f.setRoot({ scheme: 'file', fsPath: path.join(f.extra, 'src') });
	await f.host.handle(f.surface, { type: 'getWorktrees' });
	assert.deepEqual(plain(f.messages[0].items.map((item) => item.current)), [false, true]);
	f.setRoot({ scheme: 'file', fsPath: f.extra + '-other' });
	await f.host.handle(f.surface, { type: 'getWorktrees' });
	assert.ok(f.messages[1].items.every((item) => !item.current));
});

test('getWorktrees returns structured errors for missing, remote, and failed Git workspaces', async () => {
	for (const root of [undefined, { scheme: 'vscode-remote', fsPath: '/repo' }]) {
		const f = setup();
		f.setRoot(root);
		assert.equal(await f.host.handle(f.surface, { type: 'getWorktrees' }), true);
		assert.deepEqual(plain(f.messages[0]), { type: 'worktrees', items: [], error: 'Open a local folder to use Git worktrees.' });
		assert.equal(f.listCalls.length, 0);
	}
	const f = setup();
	f.setListError(new Error('Not a Git repository'));
	await f.host.handle(f.surface, { type: 'getWorktrees' });
	assert.deepEqual(plain(f.messages[0]), { type: 'worktrees', items: [], error: 'Not a Git repository' });
});

test('openWorktree validates against a fresh list and opens the canonical path in a separate window', async () => {
	const f = setup();
	const requested = process.platform === 'win32' ? f.extra.toUpperCase() : f.extra;
	assert.equal(await f.host.handle(f.surface, { type: 'openWorktree', path: requested }), true);
	assert.deepEqual(plain(f.commands), [['vscode.openFolder', { scheme: 'file', fsPath: f.extra }, { forceNewWindow: true }]]);
	assert.deepEqual(f.listCalls, [f.main]);
});

test('openWorktree rejects arbitrary, missing, relative, stale, and failed-list paths without opening', async () => {
	const f = setup();
	for (const target of [undefined, 42, '', ' ', 'relative', path.resolve('unrelated'), path.join(f.extra, 'src')]) {
		await assert.rejects(f.host.handle(f.surface, { type: 'openWorktree', path: target }));
	}
	f.setItems([]);
	await assert.rejects(f.host.handle(f.surface, { type: 'openWorktree', path: f.extra }), /not a worktree/);
	f.setListError(new Error('Git failed'));
	await assert.rejects(f.host.handle(f.surface, { type: 'openWorktree', path: f.extra }), /Git failed/);
	f.setRoot(undefined);
	await assert.rejects(f.host.handle(f.surface, { type: 'openWorktree', path: f.extra }), /local folder/);
	assert.equal(f.commands.length, 0);
});

test('removeWorktree validates the checkout, never removes the main checkout, and reports success', async () => {
	const f = setup();
	for (const target of [undefined, 42, '', ' ', 'relative', path.resolve('unrelated'), path.join(f.extra, 'src')]) {
		await assert.rejects(f.host.handle(f.surface, { type: 'removeWorktree', path: target }));
	}
	await assert.rejects(f.host.handle(f.surface, { type: 'removeWorktree', path: f.main }), /main checkout/);
	assert.equal(f.removed.length, 0);
	f.setItems([
		{ path: f.main, branch: 'main', head: '1234567', main: true },
		{ path: f.extra, branch: 'zer0ne/task', head: '7654321', main: false }
	]);
	assert.equal(await f.host.handle(f.surface, { type: 'removeWorktree', path: f.extra }), true);
	assert.deepEqual(f.removed, [{ cwd: f.main, dir: f.extra, force: false }]);
	assert.deepEqual(plain(f.messages.at(-1)), { type: 'worktreeRemoved', path: f.extra });
	assert.match(f.statuses.at(-1)[0], /branch zer0ne\/task is kept/);
});

test('removeWorktree asks before dropping uncommitted changes and honours a refusal', async () => {
	const f = setup();
	f.setDirty(true);
	f.setItems([
		{ path: f.main, branch: 'main', head: '1234567', main: true },
		{ path: f.extra, branch: 'zer0ne/task', head: '7654321', main: false }
	]);
	f.setWarning(undefined);
	await f.host.handle(f.surface, { type: 'removeWorktree', path: f.extra });
	assert.equal(f.removed.length, 0, 'a refused confirmation keeps the checkout');
	assert.ok(!f.messages.some((m) => m.type === 'worktreeRemoved'));
	f.setWarning('Remove anyway');
	await f.host.handle(f.surface, { type: 'removeWorktree', path: f.extra });
	assert.deepEqual(f.removed, [{ cwd: f.main, dir: f.extra, force: true }]);
});

test('removeWorktree waits for active runs and agents', async () => {
	const f = setup();
	f.host.busy = () => true;
	await assert.rejects(f.host.handle(f.surface, { type: 'removeWorktree', path: f.extra }), /Wait for the current run/);
	assert.equal(f.removed.length, 0);
});

test('removeWorktree forgets a registration whose folder was deleted outside Git', async () => {	const f = setup();
	f.setItems([
		{ path: f.main, branch: 'main', head: '1234567', main: true },
		{ path: f.extra, branch: 'zer0ne/task', head: '7654321', main: false }
	]);
	f.setExists(false);
	await f.host.handle(f.surface, { type: 'removeWorktree', path: f.extra });
	assert.deepEqual(f.removed, [{ cwd: f.main, pruned: true }]);
	assert.deepEqual(plain(f.messages.at(-1)), { type: 'worktreeRemoved', path: f.extra });
});

test('missing create tasks request in-page entry without native input dialogs', async () => {
 const f = setup();
 for (const task of [undefined, '', '   ']) await f.host.handle(f.surface, { type: 'worktree', action: 'create', task });
 await f.host.action('create');
 assert.equal(f.messages.length, 4); assert.ok(f.messages.every(m => m.type === 'worktreeTaskEntry'));
 assert.equal(f.commands.length, 0); assert.equal(f.updates.length, 0);
});

test('legacy create/manage routing and unhandled messages remain available', async () => {
	const f = setup();
	assert.equal(await f.host.handle(f.surface, { type: 'unknown' }), false);
	assert.equal(await f.host.handle(f.surface, { type: 'worktree', action: 'create', task: 'A task' }), true);
	assert.equal(f.updates.length, 1);
	assert.equal(f.statuses.length, 1);
	assert.equal(f.commands.length, 1);
	f.setItems([{ path: f.main, main: true }]);
	assert.equal(await f.host.handle(f.surface, { type: 'worktree', action: 'manage' }), true);
});
