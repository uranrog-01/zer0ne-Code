'use strict';
// Disposable fixtures only: no provider accounts, real browser actions or repository commits.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert'), Module = require('module');
const root = path.resolve(__dirname, '../..'), out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(root, 'engine/out');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-agent-regressions-')), workspace = path.join(tmp, 'workspace');
fs.mkdirSync(workspace);
const homedir = os.homedir; os.homedir = () => path.join(tmp, 'home');
const shim = require('./vscode-shim').createShim({ dataDir: path.join(tmp, 'data'), workspace }).vscode;
const load = Module._load; Module._load = function (name, ...args) { return name === 'vscode' ? shim : load.call(this, name, ...args); };
const { DEFAULT_SETTINGS } = require(out + '/providerStore');
const { TurnAgents, AgentRegistry, watchdog } = require(out + '/host/turnAgents');
const { ToolExecutor } = require(out + '/host/toolExecutor');
const { agentTools, agentModel } = require(out + '/host/subagentRuntime');
const { PluginHost } = require(out + '/tools/plugins');
const { SubagentsHost, agentMarkdown } = require(out + '/host/subagentsHost');
const { runAgentTurn } = require(out + '/core/turn');
const { CoreTools } = require(out + '/core/tools');
const { runTool, READ_ONLY_TOOLS } = require(out + '/tools/agentTools');
const { parseSkill } = require(out + '/tools/skills');
const results = [], delay = ms => new Promise(r => setTimeout(r, ms));
const write = (f, text) => { assert.ok(path.resolve(f).startsWith(tmp + path.sep)); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
function junction(target, link) {
	assert.ok(path.resolve(link).startsWith(tmp + path.sep));
	fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
	assert.ok(fs.lstatSync(link).isSymbolicLink(), 'The fixture must be a real symlink/junction before testing the guard');
}
async function test(id, name, fn) { try { await fn(); results.push({ id, name, passed: true }); console.log(id + ' PASS ' + name); } catch (e) { results.push({ id, name, passed: false, error: e.stack }); console.error(id + ' FAIL ' + e.stack); } }
const provider = { id: 'p', name: 'Fixture', baseUrl: 'https://fixture.invalid', apiFormat: 'openai', enabled: true, models: [{ id: 'm', enabled: true }] };
const call = (id, name, args = {}) => ({ id, name, arguments: JSON.stringify(args) }), answer = (text = 'report') => ({ text, toolCalls: [] });
function runtime(personas = [], overrides = {}) {
	const registry = new AgentRegistry(), settings = { ...DEFAULT_SETTINGS, subagents: true, hybrid: false, skills: false, includeAgentsMd: false, browserAgent: true, redactSecrets: false, ...overrides };
	const store = { getSettings: () => settings, list: async () => [provider], getApiKey: async () => '', keyInfoOf: async () => undefined, recordUsage: async () => {} };
	const plugins = { agents: () => personas }, mcp = { resolve: () => undefined, isTrusted: () => false };
	const services = { store, plugins, registry, mcp, browser: {}, skills: {}, writers: {}, storageDir: tmp, extensionDir: root + '/engine', hooks: () => [], hookBase: { workspace }, scheduleState() {}, tools: new ToolExecutor({ plugins, mcp, scheduleState() {} }), callModel: async () => answer() };
	const info = { sessionId: 's1', convo: [], provider, model: provider.models[0], apiKey: '', settings, signal: new AbortController().signal };
	const agents = new TurnAgents(services, info), ctx = { store, settings, sessionId: 's1', signal: info.signal, requestApproval: async () => ({ approved: false, finish() {} }), readOnly: false };
	agents.attach(ctx); return { registry, settings, store, services, info, agents, ctx };
}
function paired(messages) {
	for (let i = 0; i < messages.length; i++) if (messages[i].toolCalls?.length) {
		const calls = messages[i].toolCalls; let j = i + 1, ids = [];
		while (messages[j]?.role === 'tool') ids.push(messages[j++].toolCallId);
		assert.deepEqual(ids.slice().sort(), calls.map(c => c.id).sort());
	}
}
async function writerFixture(id, fn) {
	const wt = require(out + '/worktrees'), core = require(out + '/core/loop'), cp = require('child_process');
	const old = { create: wt.createWorktree, run: core.runCore, exec: cp.execFile };
	const dir = path.join(tmp, id); fs.mkdirSync(dir); const ops = [];
	wt.createWorktree = async () => ({ path: dir, branch: 'fixture' });
	cp.execFile = (file, args, options, callback) => { ops.push(args); queueMicrotask(() => callback(null, args.includes('--show-toplevel') ? options.cwd : args.includes('rev-parse') ? 'fixture-base\n' : '', '')); return { stdin: { end() {} } }; };
	try { const { WriterPool } = require(out + '/host/writers'); await fn({ dir, core, ops, pool: new WriterPool(() => {}), start: { root: workspace, description: 'fixture', prompt: 'fixture task', provider: {}, signal: new AbortController().signal, approveCommand: async () => false } }); }
	finally { wt.createWorktree = old.create; core.runCore = old.run; cp.execFile = old.exec; }
}
(async () => {
await test('A01', 'Unadvertised and denied child tools are blocked at dispatch', async () => {
	write(path.join(workspace, 'denied.txt'), 'FIXTURE_DENIED_READ');
	const r = runtime([{ name: 'restricted', canWrite: false, prompt: 'read', tools: ['Read'], disallowedTools: ['Read'] }]); let n = 0, output, advertised;
	const real = r.services.tools.runWithGates.bind(r.services.tools);
	r.services.tools.runWithGates = async (...args) => output = await real(...args);
	r.services.callModel = async (p, k, o) => { advertised ??= o.tools.map(d => d.name); return n++ === 0 ? { text: '', toolCalls: [call('c1', 'read_file', { path: 'denied.txt' })] } : answer(); };
	await r.ctx.runSubagent('read', 'read', 'restricted'); assert.ok(!advertised.includes('read_file')); assert.equal(output.error, true); assert.ok(!output.api.includes('FIXTURE_DENIED_READ'));
	let hooks = 0; const hooksModule = require(out + '/tools/hooks'), original = hooksModule.runHooks;
	hooksModule.runHooks = async () => { hooks++; throw Error('must not run denied hook'); };
	try { await real(call('c2', 'run_command'), { ...r.ctx, allowedTools: new Set(['read_file']) }, [{ enabled: true }], {}, r.settings); assert.equal(hooks, 0); } finally { hooksModule.runHooks = original; }
});
await test('A02', 'Wildcard deny rules and MCP names remain precise', () => {
	const defs = ['read_file', 'mcp__Fixture__danger'].map(name => ({ name, parameters: {}, description: '' }));
	assert.deepEqual(agentTools(defs, { tools: ['*'], disallowedTools: ['mcp__*'] }).map(d => d.name), ['read_file']);
	assert.equal(agentTools(defs, { tools: ['*'], disallowedTools: ['*'] }).length, 0);
	assert.equal(agentTools(defs, { tools: ['mcp__Fixture__danger'] })[0].name, 'mcp__Fixture__danger');
});
await test('A03', 'Unsupported argument restrictions fail closed', () => {
	assert.throws(() => agentTools([], { tools: ['Bash(git status)'] }), /Unsupported argument restriction/);
	assert.throws(() => agentTools([], { tools: ['*', 'Bash(git status)'] }), /Unsupported argument restriction/);
});
await test('A04', 'Disabled model overrides cannot be selected', async () => {
	await assert.rejects(agentModel({ list: async () => [{ ...provider, models: [{ id: 'disabled', enabled: false }] }], getApiKey: async () => '' }, { modelOverride: 'p::disabled' }, { provider }), /disabled/);
	assert.equal((await agentModel({ list: async () => [provider], getApiKey: async () => '' }, { modelOverride: 'p::m' }, { provider })).model.id, 'm');
});
await test('A05', 'Writers inherit protected paths, command switches and hooks', () => writerFixture('A05', async ({ dir, core, pool, start }) => {
	write(path.join(dir, '.env'), 'FIXTURE_SECRET'); let hookRuns = 0;
	const hooks = require(out + '/tools/hooks'), original = hooks.runHooks;
	hooks.runHooks = async (_h, event) => { hookRuns++; return { blocked: event === 'PreToolUse', feedback: 'fixture deny', log: [] }; };
	core.runCore = async o => {
		const read = await o.tools.run('read_file', { path: '.env' }); assert.equal(read.error, true); assert.ok(!read.output.includes('FIXTURE_SECRET'));
		assert.equal((await o.tools.run('run_command', { command: 'echo must-not-run' })).error, true);
		const denied = await o.executeTool(call('hook', 'write_file'), { path: 'no.txt', content: 'no' }, start.signal);
		assert.equal(denied.error, true); assert.ok(!fs.existsSync(path.join(dir, 'no.txt'))); return { text: 'done', stopReason: 'end_turn' };
	};
	try { const job = await pool.start({ ...start, denyPaths: '.env', commandEnabled: false, hooks: [{}] }).done; assert.equal(job.status, 'done'); assert.equal(hookRuns, 1); } finally { hooks.runHooks = original; }
}));
await test('A06', 'Writer rules are inherited and cancellation never stages or commits', () => writerFixture('A06', async ({ core, ops, pool, start }) => {
	write(path.join(workspace, 'AGENTS.md'), 'FIXTURE_PROJECT_RULE'); write(path.join(workspace, '.zer0ne/instructions.md'), 'FIXTURE_SECOND_RULE');
	core.runCore = async o => { assert.ok(o.system.includes('FIXTURE_PROJECT_RULE')); assert.ok(o.system.includes('FIXTURE_SECOND_RULE')); return { text: 'done', stopReason: 'cancelled' }; };
	assert.equal((await pool.start(start).done).status, 'failed'); assert.ok(!ops.some(a => a.includes('add') || a.includes('commit')));
}));
await test('A07', 'Foreign-chat writer review, merge and discard are blocked', async () => {
	const r = runtime(); r.registry.add({ id: 'w9', sessionId: 'other-chat', kind: 'writer', status: 'completed' }); let touches = 0;
	for (const name of ['diff', 'merge', 'discard']) r.services.writers[name] = async () => { touches++; throw Error('must not touch writer'); };
	for (const name of ['diff', 'merge', 'discard']) await assert.rejects(r.ctx.writers[name]('w9'), /this chat/);
	r.registry.add({ id: 'w1', sessionId: 's1', kind: 'writer', status: 'completed' }); r.ctx.readOnly = true;
	for (const name of ['merge', 'discard']) await assert.rejects(r.ctx.writers[name]('w1'), /read-only/);
	assert.equal(touches, 0);
});
await test('A08', 'Late child responses remain stopped', async () => {
	const r = runtime(); r.services.callModel = async () => { r.registry.stopOne(r.registry.list()[0].id); return answer('late response'); };
	await r.ctx.runSubagent('fixture', 'fixture'); assert.equal(r.registry.list()[0].status, 'stopped'); assert.ok(!r.registry.list()[0].report);
});
await test('A09', 'Stop suppresses completed notices and scheduled wakes', async () => {
	const registry = new AgentRegistry(); registry.add({ id: 'a1', sessionId: 's1', background: true, collected: false, status: 'completed' });
	let wakes = 0; registry.scheduleWake('s1', () => wakes++); registry.stopSession('s1'); assert.equal(registry.hasNotices('s1'), false); await delay(1250); assert.equal(wakes, 0);
});
await test('A10', 'Failed child batches are paired before continuation', async () => {
	const r = runtime(); let n = 0;
	r.services.callModel = async () => n++ === 0 ? { text: '', toolCalls: [call('c1', 'read_file'), call('c2', 'read_file')] } : answer();
	r.services.tools.runWithGates = async () => { throw Error('fixture tool failure'); };
	await r.ctx.runSubagent('fixture', 'fixture'); const run = r.registry.list()[0]; assert.equal(run.status, 'failed'); paired(run.msgs); assert.equal(run.msgs.filter(m => m.role === 'tool').length, 2);
	r.services.callModel = async (p, k, o) => { paired(o.messages); return answer(); }; await r.ctx.sendToAgent(run.id, 'continue', false); assert.equal(run.status, 'completed');
});
await test('A11', 'Child replay protection survives continuation', async () => {
	const r = runtime(); let n = 0, executed = 0;
	r.services.callModel = async () => n++ % 2 === 0 ? { text: '', toolCalls: [call('same-id', 'read_file')] } : answer();
	r.services.tools.runWithGates = async () => { executed++; return { api: 'fixture', summary: 'fixture' }; };
	await r.ctx.runSubagent('fixture', 'fixture'); await r.ctx.sendToAgent(r.registry.list()[0].id, 'continue', false); assert.equal(executed, 1); paired(r.registry.list()[0].msgs);
});
await test('A12', 'Main loop executes repeated mutation IDs only once', async () => {
	let n = 0, executed = 0; const messages = [];
	await runAgentTurn({ messages, maxSteps: 3, signal: new AbortController().signal, call: async () => n++ < 2 ? { text: '', toolCalls: [call('duplicate', 'write_file')] } : answer(), execute: async () => { executed++; return { api: 'fixture' }; } });
	assert.equal(executed, 1); paired(messages); assert.match(messages.find(m => m.role === 'tool' && m.toolCallId.includes('replay')).content, /not run again/);
});
await test('A13', 'Child overflow compacts outputs and bounded continuation context', async () => {
	const r = runtime(); let n = 0, originalSize;
	r.services.callModel = async (p, k, o) => { if (n++ === 0) return { text: '', toolCalls: [call('c1', 'read_file')] }; if (n === 2) { originalSize = o.messages.reduce((s, m) => s + m.content.length, 0); throw Error('context_length_exceeded fixture'); } assert.ok(o.messages.reduce((s, m) => s + m.content.length, 0) < originalSize); paired(o.messages); return answer(); };
	r.services.tools.runWithGates = async () => ({ api: 'x'.repeat(30000), summary: 'fixture' });
	await r.ctx.runSubagent('fixture', 'fixture'); assert.equal(r.registry.list()[0].status, 'completed'); assert.equal(n, 3);
});
await test('A14', 'Failed write and publication preserve saved agent', async () => {
	const storage = path.join(tmp, 'agent-save'), plugins = new PluginHost(storage, () => undefined, () => []), posts = [];
	const host = new SubagentsHost({ store: { list: async () => [], getSettings: () => DEFAULT_SETTINGS }, status() {} }, plugins, { get: (k, d) => d, update: async () => {} });
	const file = path.join(storage, 'agents/fixture.md'), oldText = '---\nname: fixture\ndescription: Fixture\ntools: Read\n---\nOLD_INSTRUCTIONS'; write(file, oldText);
	const draft = { name: 'fixture', description: 'new', prompt: 'new', tools: 'read', scope: 'user' };
	for (const failure of ['write', 'rename']) {
		const writeOld = fs.writeFileSync, renameOld = fs.renameSync;
		if (failure === 'write') fs.writeFileSync = (f, ...a) => { if (path.basename(String(f)).startsWith('.zer0ne-stage-')) { writeOld(f, 'PARTIAL'); throw Error('fixture disk failure'); } return writeOld(f, ...a); };
		else fs.renameSync = (a, b) => { if (path.basename(String(a)).startsWith('.zer0ne-stage-')) throw Error('fixture publish failure'); return renameOld(a, b); };
		try { await host.handle({ post: m => posts.push(m) }, { type: 'subagentSave', original: 'fixture', draft }); } finally { fs.writeFileSync = writeOld; fs.renameSync = renameOld; }
		assert.equal(fs.readFileSync(file, 'utf8'), oldText);
	}
	assert.equal(posts.filter(m => m.type === 'subagentError').length, 2); assert.ok(!posts.some(m => m.type === 'subagentSaved'));
	await host.handle({ post: m => posts.push(m) }, { type: 'subagentSave', original: 'fixture', draft }); assert.equal(parseSkill(fs.readFileSync(file, 'utf8')).body, 'new');
});
await test('A15', 'YAML-looking description text round trips', () => {
	for (const description of ['false', 'true', 'null', '123', 'quoted: "text"']) assert.equal(parseSkill(agentMarkdown({ name: 'false', description, prompt: 'instructions', tools: 'all', scope: 'user' })).description, description);
});
await test('A16', 'Read-only browser side effects fail and regular actions require approval', async () => {
	let evaluated = 0, approvals = 0; const r = runtime(); const ctx = { ...r.ctx, readOnly: true, browser: { evaluate: async () => { evaluated++; return 'fixture'; } } };
	for (const name of ['browser_evaluate', 'browser_click', 'browser_type', 'browser_press', 'browser_tabs', 'browser_navigate']) { assert.ok(!READ_ONLY_TOOLS.has(name)); assert.equal((await runTool(call('fixture', name, { expression: "fetch('/fixture',{method:'POST'})" }), ctx)).error, true); }
	let shown; ctx.readOnly = false; ctx.requestApproval = async request => { approvals++; shown = request.command; return { approved: false, finish() {} }; };
	assert.equal((await runTool(call('fixture', 'browser_evaluate', { expression: '1+1' }), ctx)).error, true); assert.equal(evaluated, 0); assert.equal(approvals, 1);
	const expression = '/*' + 'x'.repeat(5000) + '*/ fetch("/fixture", {method:"POST"})';
	await runTool(call('long', 'browser_evaluate', { expression }), ctx);
	assert.ok(shown.includes(JSON.stringify(expression)), 'approval includes the whole expression'); assert.equal(evaluated, 0);
});
await test('A17', 'Activity resets idle timeout and silent calls stop even if provider ignores abort', async () => {
	const stop = new AbortController();
	const result = await watchdog(stop, async (_signal, activity) => { for (let i = 0; i < 8; i++) { await delay(15); activity(); } return 'healthy'; }, 70);
	assert.equal(result, 'healthy'); await assert.rejects(watchdog(stop, () => new Promise(() => {}), 25), /No answer/);
	const cancelled = new AbortController(), pending = watchdog(cancelled, () => new Promise(() => {}), 200); cancelled.abort(); await assert.rejects(pending, /Stopped/);
});
await test('A18', 'Child URL authorization is an isolated copy of parent provenance', async () => {
	const r = runtime([], { webfetchProvenance: true }); r.ctx.urlProvenance = new Set(['https://fixture.invalid/allowed']); let childContext, n = 0;
	r.services.callModel = async () => n++ === 0 ? { text: '', toolCalls: [call('c1', 'web_fetch')] } : answer();
	r.services.tools.runWithGates = async (_c, ctx) => { childContext = ctx; return { api: 'fixture', summary: 'fixture' }; };
	await r.ctx.runSubagent('fixture', 'fixture'); assert.ok(childContext.urlProvenance.has('https://fixture.invalid/allowed')); assert.notEqual(childContext.urlProvenance, r.ctx.urlProvenance);
	r.ctx.urlProvenance.add('https://fixture.invalid/later'); assert.ok(!childContext.urlProvenance.has('https://fixture.invalid/later'));
});
await test('A19', 'Stopping a run terminates active shell hooks', async () => {
	const marker = path.join(tmp, 'hook-started'), after = path.join(tmp, 'hook-after-stop'), script = path.join(tmp, 'hook.cjs');
	write(script, 'const fs=require("fs");fs.writeFileSync(' + JSON.stringify(marker) + ',"START");setTimeout(()=>fs.writeFileSync(' + JSON.stringify(after) + ',"AFTER_STOP"),1800);');
	const r = runtime(), ctl = new AbortController(); r.ctx.signal = ctl.signal;
	const quote = v => "'" + v.replaceAll("'", "''") + "'", command = (process.platform === 'win32' ? '& ' : '') + quote(process.execPath) + ' ' + quote(script);
	const running = r.services.tools.runWithGates(call('hook-call', 'read_file', { path: 'denied.txt' }), r.ctx, [{ id: 'fixture', event: 'PreToolUse', enabled: true, matcher: 'read_file', command, timeoutSec: 10 }], { workspace }, r.settings);
	const observed = running.then(() => null, e => e);
	for (let i = 0; i < 400 && !fs.existsSync(marker); i++) await delay(20);
	assert.ok(fs.existsSync(marker), 'hook started'); ctl.abort(); const error = await observed; assert.equal(error.name, 'AbortError'); await delay(1900); assert.ok(!fs.existsSync(after));
});
await test('A20', 'Writer file tools reject junction escapes and changes made while awaiting approval', async () => {
	const dir = path.join(tmp, 'writer-links'), external = path.join(tmp, 'outside-writer'); fs.mkdirSync(dir); fs.mkdirSync(external);
	junction(external, path.join(dir, 'linked'));
	const tools = new CoreTools({ root: dir, approve: async () => true });
	assert.equal((await tools.run('write_file', { path: 'linked/marker.txt', content: 'ESCAPED' })).error, true); assert.ok(!fs.existsSync(path.join(external, 'marker.txt')));
	const swap = new CoreTools({ root: dir, approve: async () => { junction(external, path.join(dir, 'newdir')); return true; } });
	assert.equal((await swap.run('write_file', { path: 'newdir/late.txt', content: 'ESCAPED' })).error, true); assert.ok(!fs.existsSync(path.join(external, 'late.txt')));
});
await test('A21', 'Isolated writers receive the agent named in the task call', async () => {
	const r = runtime([]), seen = [];
	r.ctx.spawnWriter = async (description, prompt, agent) => { seen.push({ description, prompt, agent }); return 'w1'; };
	const outcome = await runTool(call('t1', 'task', { prompt: 'do it', isolated: true, agent: 'editor' }), r.ctx);
	assert.equal(outcome.error, undefined);
	assert.deepEqual(seen, [{ description: 'Writer task', prompt: 'do it', agent: 'editor' }]);
});
await test('A22', 'Isolated writers refuse a read-only agent before starting work', async () => {
	const r = runtime([{ name: 'Explore', canWrite: false, prompt: 'read', tools: ['*'] }]);
	await assert.rejects(r.agents.spawnWriter(r.ctx, 'fixture', 'fixture task', 'Explore'), /read-only agent/);
});
await test('R01', 'Eager calls and duplicates in one batch execute once', async () => {
	let n = 0, executed = 0; const messages = [];
	await runAgentTurn({ messages, maxSteps: 3, signal: new AbortController().signal, parallelSafe: () => true, call: async (_step, eager) => { const c = call('same', 'read_file'); if (n++ < 2) { eager(c); eager(c); return { text: '', toolCalls: [c, c] }; } return answer(); }, execute: async () => { executed++; return { api: 'fixture' }; } });
	assert.equal(executed, 1); paired(messages);
});
await test('R02', 'Main failed batches complete results before another turn', async () => {
	const messages = []; await assert.rejects(runAgentTurn({ messages, maxSteps: 1, signal: new AbortController().signal, call: async () => ({ text: '', toolCalls: [call('x', 'write_file'), call('y', 'write_file')] }), execute: async () => { throw Error('fixture failure'); } }), /fixture failure/); paired(messages); assert.equal(messages.filter(m => m.role === 'tool').length, 2);
});
await test('R03', 'Main late answers after Stop remain cancelled', async () => {
	const stop = new AbortController(); let answers = 0; const messages = [];
	const r = await runAgentTurn({ messages, maxSteps: 1, signal: stop.signal, call: async () => { stop.abort(); return answer('late'); }, execute: async () => ({ api: '' }), onAnswer: () => answers++ });
	assert.equal(r.stopReason, 'cancelled'); assert.equal(answers, 0); assert.equal(messages.length, 0);
});
await test('R04', 'Writer diff includes unstaged tracked and untracked files without changing index', async () => {
	const cp = require('child_process'), old = cp.execFile, ops = [], dir = path.join(tmp, 'writer-diff'); fs.mkdirSync(dir); write(path.join(dir, 'new.txt'), 'new');
	cp.execFile = (_file, args, _options, callback) => { ops.push(args); const value = args.includes('--name-only') ? 'tracked.txt\0' : args[0] === 'ls-files' ? 'new.txt\0' : args.includes('--no-index') ? 'NEW_PATCH' : 'TRACKED_PATCH'; queueMicrotask(() => callback(args.includes('--no-index') ? Object.assign(Error('diff'), { code: 1 }) : null, value, '')); return { stdin: { end() {} } }; };
	try { const { WriterPool } = require(out + '/host/writers'), pool = new WriterPool(() => {}); pool.jobs.set('w1', { id: 'w1', status: 'done', dir, base: 'fixture' }); const diff = await pool.diff('w1'); assert.deepEqual(diff.files, ['tracked.txt', 'new.txt']); assert.equal(diff.patch, 'TRACKED_PATCHNEW_PATCH'); assert.ok(!ops.some(a => a.includes('HEAD') || a.includes('add') || a.includes('commit')));
		await assert.rejects(pool.merge('w1', dir, () => assert.fail('must not record'), 'outdated approved patch'), /changed during approval/);
		assert.ok(!ops.some(a => a[0] === 'apply')); const stop = new AbortController(); stop.abort(); await assert.rejects(pool.merge('w1', dir, () => {}, diff.patch, stop.signal), /abort/i);
	} finally { cp.execFile = old; }
});
const report = { at: new Date().toISOString(), platform: process.platform, node: process.version, results };
fs.mkdirSync(root + '/test/output', { recursive: true });
fs.writeFileSync(root + '/test/output/' + (process.env.ZER0NE_TEST_ENGINE_OUT ? 'agents-packaged-regression-results.json' : 'agents-regression-results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${results.filter(r => r.passed).length}/${results.length} passed`); process.exitCode = results.some(r => !r.passed) ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
	os.homedir = homedir; Module._load = load;
	assert.equal(path.dirname(tmp), path.resolve(os.tmpdir())); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
