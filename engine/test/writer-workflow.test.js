const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-writer-flow-'));
const project = path.join(base, 'project'); fs.mkdirSync(project);
const shim = require('./vscode-shim').createShim({ dataDir: path.join(base, 'data'), workspace: project }).vscode;
const loader = Module._load; Module._load = function(name, ...args) { return name === 'vscode' ? shim : loader.call(this, name, ...args); };
const { WriterPool } = require('../out/host/writers');
const { WriterReviewHost } = require('../out/host/writerReviewHost');
const { TurnAgents, AgentRegistry } = require('../out/host/turnAgents');
const { ToolScheduler } = require('../out/core/toolScheduler');
const { DEFAULT_SETTINGS } = require('../out/providerStore');
const { normalizeWorkflow } = require('../out/host/subagentWorkflow');
const wt = require('../out/worktrees'), cp = require('node:child_process');
let serial = 0;
async function fixture(fn) {
	const saved = { create: wt.createWorktree, list: wt.listWorktrees, remove: wt.removeWorktree, exec: cp.execFile };
	const registered = [], commands = [];
	wt.createWorktree = async (_root, description) => {
		const dir = path.join(project + '.worktrees', 'task-' + ++serial); fs.mkdirSync(dir, { recursive: true });
		const entry = { path: dir, branch: 'zer0ne/task-' + serial, main: false }; registered.push(entry); return entry;
	};
	wt.listWorktrees = async () => registered;
	wt.removeWorktree = async (_root, dir) => fs.rmSync(dir, { recursive: true, force: true });
	cp.execFile = (_exe, args, options, callback) => {
		commands.push(args);
		let out = '';
		if (args.includes('rev-parse')) out = args.includes('--show-toplevel') ? options.cwd : 'fixture-base';
		else if (args[0] === 'ls-files' && fs.existsSync(path.join(options.cwd, 'created.txt'))) out = 'created.txt\0';
		else if (args.includes('--no-index')) out = 'FIXTURE_PATCH\n';
		else if (args.includes('--numstat')) out = '1\t0\tcreated.txt\n';
		queueMicrotask(() => callback(null, out, ''));
		return { stdin: { end() {} } };
	};
	try { await fn({ commands, registered }); }
	finally { wt.createWorktree = saved.create; wt.listWorktrees = saved.list; wt.removeWorktree = saved.remove; cp.execFile = saved.exec; }
}

test('isolated writers inherit command denies from the original project before any approval', async () => fixture(async () => {
	const dir = path.join(project, '.zer0ne'), rules = path.join(dir, 'command-rules'); fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(rules, 'deny: *writer-policy-marker*\n');
	try {
		let calls = 0, approvals = 0;
		const pool = new WriterPool(() => {});
		const { job, done } = pool.start({ root: project, sessionId: 'policy', description: 'Policy fixture', prompt: 'Check the command policy',
			provider: { apiFormat: 'openai', baseUrl: 'http://fixture.invalid', model: 'fixture' }, signal: new AbortController().signal,
			approveCommand: async () => { approvals++; return true; }, requestCommandApproval: async () => { approvals++; return { approved: true, finish() {} }; },
			callModel: async o => {
				if (++calls === 1) return { text: '', toolCalls: [{ id: 'denied-command', name: 'run_command', arguments: JSON.stringify({ command: 'echo writer-policy-marker' }) }] };
				assert.ok(o.messages.some(m => m.role === 'tool' && /command rules/.test(m.content)));
				return { text: 'The command was blocked by project policy.', toolCalls: [] };
			} });
		await done; assert.equal(job.status, 'done'); assert.equal(calls, 2); assert.equal(approvals, 0);
	} finally { fs.rmSync(rules, { force: true }); }
}));

test('writers explain the Git prerequisite without starting a model call in a non-repository folder', async () => fixture(async () => {
	cp.execFile = (_exe, _args, _options, callback) => { queueMicrotask(() => callback(new Error('fatal: not a git repository'), '', '')); return {}; };
	let calls = 0;
	const { job, done } = new WriterPool(() => {}).start({ root: project, sessionId: 'no-git', description: 'Missing Git', prompt: 'Inspect',
		provider: { model: 'fixture' }, signal: new AbortController().signal, approveCommand: async () => false,
		callModel: async () => { calls++; return { text: 'should not run', toolCalls: [] }; } });
	await done; assert.equal(job.status, 'failed'); assert.equal(calls, 0); assert.match(job.error, /Git repository with an existing commit/);
}));

test('editing personas use isolated worktrees in a mixed batch and obey two-worker concurrency', async () => fixture(async ({ commands }) => {
	assert.equal(normalizeWorkflow({}).maxConcurrency, 2);
	const settings = { ...DEFAULT_SETTINGS, subagents: true, hybrid: false, skills: false, includeAgentsMd: false, childConcurrency: 2 };
	const provider = { id: 'p', name: 'Fixture', baseUrl: 'http://fixture.invalid', apiFormat: 'openai', enabled: true, models: [{ id: 'm', enabled: true }] };
	const registry = new AgentRegistry(), pool = new WriterPool(() => {});
	let running = 0, peak = 0;
	const services = { registry, writers: pool, store: { getSettings: () => settings, list: async () => [provider], getApiKey: async () => '' },
		plugins: { agents: () => [{ name: 'Coder', canWrite: true, prompt: 'Owned coding task', tools: ['Read','Write'] }] },
		mcp: {}, skills: {}, browser: {}, storageDir: base, extensionDir: path.resolve(__dirname, '..'), tools: { scheduler: new ToolScheduler() }, hooks: () => [], hookBase: {}, scheduleState() {},
		callModel: async (_p, _k, o) => { peak = Math.max(peak, ++running); await new Promise(r => setTimeout(r, 20)); running--; return { text: 'Task finished', toolCalls: [] }; }
	};
	const t = { sessionId: 'route', convo: [], provider, model: provider.models[0], apiKey: '', settings, signal: new AbortController().signal };
	const agents = new TurnAgents(services, t), ctx = { settings, signal: t.signal, readOnly: false, requestApproval: async () => ({ approved: false, finish() {} }) };
	agents.attach(ctx);
	await ctx.runBatch([{ description: 'One', prompt: 'Owned first task', agent: 'Coder' }, { description: 'Two', prompt: 'Owned second task', agent: 'Coder' }, { description: 'Research', prompt: 'Read only investigation' }]);
	assert.equal(registry.list().filter(r => r.kind === 'writer').length, 2);
	assert.equal(registry.list().filter(r => r.kind === 'subagent').length, 1);
	assert.equal(new Set([...pool.jobs.values()].map(j => j.dir)).size, 2);
	assert.equal(peak, 2);
	assert.ok(!commands.some(a => a.includes('commit') || a.includes('add')));
}));

test('writer instructions, exact tool journal and interrupted checkout survive restart and explicit resume', async () => fixture(async ({ commands }) => {
	const storage = path.join(base, 'recovery'), pool = new WriterPool(() => {}); pool.configure(storage, project);
	let calls = 0, checkpoint, job;
	const start = { root: project, sessionId: 'recover', description: 'Recovery test', prompt: 'Create one file', providerId: 'p', providerName: 'Fixture', provider: { apiFormat: 'openai', baseUrl: 'http://fixture.invalid', apiKey: 'fixture-key-must-not-be-saved', model: 'm' }, signal: new AbortController().signal, approveCommand: async () => false,
		callModel: async o => {
			if (++calls === 1) { pool.steer(job.id, 'Check the file before finishing.'); return { text: '', toolCalls: [{ id: 'write-once', name: 'write_file', arguments: JSON.stringify({ path: 'created.txt', content: 'hello' }) }] }; }
			assert.ok(o.messages.some(m => m.role === 'user' && m.content.includes('Check the file')));
			assert.ok(o.messages.some(m => m.role === 'tool' && m.toolCallId === 'write-once'));
			checkpoint = fs.readFileSync(path.join(pool.storage, job.id + '.json'), 'utf8');
			const liveReader = new WriterPool(() => {}); liveReader.configure(storage, project); assert.equal(liveReader.jobs.size, 0, 'another window must not recover a live writer');
			return { text: 'Created and checked', toolCalls: [] };
		}
	};
	start.workflow = true; start.requestContext = {rootTaskId:'workflow-root'};
	const run = pool.start(start); job = run.job; await run.done;
	assert.equal(job.status, 'done'); assert.equal(fs.readFileSync(path.join(job.dir, 'created.txt'), 'utf8'), 'hello');
	assert.equal(job.steerRead, 1, 'the loop drained the instruction into its transcript');
	assert.deepEqual(job.steering, ['Check the file before finishing.']);
	assert.ok(checkpoint.includes('"steerRead":1'), 'the drained count survives the checkpoint');
	const staleWindow = new WriterPool(() => {}); staleWindow.configure(storage, project);
	let releaseCall; const gate = new Promise(resolve => { releaseCall = resolve; });
	const activeResume = pool.start({ ...start, resumeId: job.id, prompt: 'Inspect only.', callModel: async () => { await gate; return { text: 'Checked', toolCalls: [] }; } });
	try {
		assert.throws(() => staleWindow.start({ ...start, resumeId: job.id, prompt: 'Duplicate resume' }), /already active/);
		await assert.rejects(staleWindow.merge(job.id, project, () => {}), /already active/);
		await assert.rejects(staleWindow.discard(job.id, project), /already active/);
		assert.ok(fs.existsSync(job.dir), 'a stale window must not remove an active writer checkout');
	}
	finally { releaseCall(); await activeResume.done; }
	assert.ok(!checkpoint.includes('fixture-key-must-not-be-saved'));
	fs.writeFileSync(path.join(pool.storage, job.id + '.json'), JSON.stringify({ ...JSON.parse(checkpoint), ownerPid: 0 }));
	const recovered = new WriterPool(() => {}); recovered.configure(storage, project);
	const saved = recovered.jobs.get(job.id); assert.equal(saved.interrupted, true); assert.equal(saved.status, 'failed');
	const registry = new AgentRegistry(); registry.restoreWriter(saved); assert.equal(registry.get(job.id).status, 'stopped');
	assert.equal(registry.get(job.id).worktree.path, job.dir);
	assert.equal(saved.rootTaskId, 'workflow-root');
	assert.equal(registry.get(job.id).rootTaskId, 'workflow-root');
	assert.equal(registry.get(job.id).workflowRole, 'worker');
	let resumeCalls = 0;
	const resumed = recovered.start({ ...start, resumeId: job.id, prompt: 'Continue after inspecting files.', callModel: async o => { resumeCalls++; assert.ok(o.messages.some(m => m.role === 'tool' && m.toolCallId === 'write-once')); return { text: 'Existing file checked', toolCalls: [] }; } });
	await resumed.done;
	assert.equal(resumed.job.id, job.id); assert.equal(resumed.job.dir, job.dir); assert.equal(resumeCalls, 1);
	assert.equal(fs.readFileSync(path.join(job.dir, 'created.txt'), 'utf8'), 'hello');
	assert.ok(!commands.some(a => a.includes('add') || a.includes('commit')));
}));

test('review requires this chat, idle full access, and the exact preview; conflicts retain the checkout', async () => {
	const posts = [], pool = { jobs: new Map([['w1', { sessionId: 's1', root: project, status: 'done', dir: '/fixture/worktree' }]]) };
	let patch = 'FIRST', applied = 0, discarded = 0, busy = false, readOnly = false, recorded;
	const run = { id: 'w1', sessionId: 's1', kind: 'writer', status: 'completed' };
	pool.diff = async () => ({ patch, files: ['one.txt'] });
	pool.merge = async (_id, _root, record, reviewed) => { if (reviewed !== patch) throw Error('Diff changed'); applied++; record('one.txt', 'before', 'after'); return 'Applied'; };
	pool.discard = async (_id, _root, reviewed) => { assert.equal(reviewed, patch); discarded++; return 'Discarded'; };
	const host = new WriterReviewHost({ pool, session: () => 's1', root: () => project, readOnly: () => readOnly, busy: () => busy, find: () => run, refresh: async () => {}, resume: async () => {}, record: async (_id, before, session) => { recorded = { before, session }; } });
	const surface = { post: msg => posts.push(msg) }, msg = { sessionId: 's1', id: 'w1' };
	await assert.rejects(host.handle(surface, { ...msg, sessionId: 'foreign', action: 'diff' }), /active/);
	await assert.rejects(host.handle(surface, { ...msg, action: 'apply' }), /View diff/);
	await host.handle(surface, { ...msg, action: 'diff' }); const reviewId = posts.at(-1).reviewId;
	busy = true; await assert.rejects(host.handle(surface, { ...msg, action: 'apply', reviewId }), /idle/); busy = false;
	readOnly = true; await assert.rejects(host.handle(surface, { ...msg, action: 'apply', reviewId }), /Full Access/); readOnly = false;
	patch = 'CHANGED'; await assert.rejects(host.handle(surface, { ...msg, action: 'apply', reviewId }), /retained/); assert.equal(applied, 0); assert.equal(discarded, 0);
	await host.handle(surface, { ...msg, action: 'diff' });
	await host.handle(surface, { ...msg, action: 'apply', reviewId: posts.at(-1).reviewId });
	assert.equal(applied, 1); assert.equal(recorded.before.get('one.txt'), 'before'); assert.equal(recorded.session, 's1');
	await assert.rejects(host.handle(surface, { ...msg, action: 'discard', reviewId }), /View diff/);
});

test('writer check receipts and tool ceilings survive continuation without allowing new tools', async () => fixture(async () => {
	const storage = path.join(base, 'evidence-writer'), pool = new WriterPool(() => {}); pool.configure(storage, project);
	const { readExecutions } = require('../out/core/executionJournal');
	const { evidenceStatus } = require('../out/host/taskEvidence');
	let step = 0;
	const options = { root: project, sessionId: 'writer-evidence', description: 'Check evidence', prompt: 'Check the worktree', allowedTools: new Set(['run_command']),
		provider: { apiFormat: 'openai', baseUrl: 'http://fixture.invalid', apiKey: '', model: 'm' }, signal: new AbortController().signal, commandEnabled: true, approveCommand: async () => true,
		callModel: async () => {
			if (step++) return { text: 'Checked', toolCalls: [] };
			const job = [...pool.jobs.values()][0];
			fs.writeFileSync(path.join(job.dir, 'package.json'), JSON.stringify({ name: 'writer-check', scripts: { check: 'node -e "process.exit(0)"' } }));
			return { text: '', toolCalls: [{ id: 'check-worktree', name: 'run_command', arguments: '{"command":"npm run check"}' }] };
		} };
	const first = pool.start(options); await first.done;
	assert.equal(first.job.status, 'done', first.job.error); assert.deepEqual(first.job.allowedTools, ['run_command']);
	assert.equal(evidenceStatus(first.job.verification), 'passed'); assert.equal(first.job.verification[0].stages[0].code, 0);
	assert.equal(readExecutions(storage, options.sessionId, first.job.id)[0].events.at(-1).outcome, 'completed');
	let resumedStep = 0;
	const next = pool.start({ ...options, allowedTools: new Set(['run_command', 'write_file']), resumeId: first.job.id, callModel: async o => {
		assert.deepEqual(o.tools.map(t => t.name), ['run_command']);
		return resumedStep++ ? { text: 'Restricted tool rejected', toolCalls: [] } : { text: '', toolCalls: [{ id: 'forbidden-write', name: 'write_file', arguments: '{"path":"forbidden.txt","content":"bad"}' }] };
	} });
	await next.done; assert.deepEqual(next.job.allowedTools, ['run_command']); assert.ok(!fs.existsSync(path.join(next.job.dir, 'forbidden.txt')));
	assert.equal(readExecutions(storage, options.sessionId, next.job.id).find(r => r.callId === 'forbidden-write').events.at(-1).outcome, 'refused');
}));

test.after(() => { Module._load = loader; fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

test('research monitor recovery keeps context, pairs interrupted calls and does not save credentials or auto-run', () => {
	const registry = new AgentRegistry(), journal = path.join(base, 'agent-history.json'); registry.configure(journal);
	registry.add({ id: 'a9', sessionId: 's1', rootTaskId:'workflow-root', kind: 'subagent', description: 'Investigate', prompt: 'Read the relevant files', status: 'running',
		apiKey: 'never-save-key', background: true, msgs: [{ role: 'user', content: 'Read the relevant files' }, { role: 'assistant', content: '', toolCalls: [{ id: 'interrupted-read', name: 'read_file', arguments: '{"path":"a.ts"}' }] }], inbox: [], stop: new AbortController(), promise: Promise.resolve(), collected: false,
		card: { id: 'card', role: 'assistant', content: '', tool: { name: 'task', status: 'running' } }, stats: { turns: 1, toolUses: 1, input: 100, output: 20, cached: 0, startedAt: Date.now(), ms: 0 } });
	registry.checkpoint(); assert.ok(!fs.readFileSync(path.join(journal.replace(/\.json$/, ''), 'a9.json'), 'utf8').includes('never-save-key'));
	const liveReader = new AgentRegistry(); liveReader.configure(journal); assert.equal(liveReader.list().length, 0);
	const file = path.join(journal.replace(/\.json$/, ''), 'a9.json'); fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ownerPid: 0 }));
	const restored = new AgentRegistry(); restored.configure(journal);
	assert.equal(restored.get('a9').status, 'stopped'); assert.equal(restored.get('a9').collected, true);
	assert.equal(restored.get('a9').msgs.at(-1).toolCallId, 'interrupted-read'); assert.match(restored.nextId(), /^a10-[a-f0-9]{8}$/);
	assert.equal(restored.hasNotices('s1'), false);
	assert.equal(restored.get('a9').rootTaskId, 'workflow-root');
	assert.equal(require('../out/host/turnAgents').agentMonitorPayload(restored.get('a9')).rootTaskId, 'workflow-root');
});
