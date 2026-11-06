'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-session-tools-')));
const project = path.join(base, 'project'); fs.mkdirSync(project);
const { createShim, install } = require('./vscode-shim');
const shim = createShim({ workspace: project, dataDir: path.join(base, 'data') });
shim.vscode.env.appName = 'zer0ne Code'; install(shim.vscode);
const { DEFAULT_SETTINGS } = require(path.join(OUT, 'providerStore'));
const { CoreTools } = require(path.join(OUT, 'core/tools'));
const { runCore } = require(path.join(OUT, 'core/loop'));
const { prepareAgentContext, withOverflowRecovery } = require(path.join(OUT, 'core/turn'));
const { buildToolDefs, runTool } = require(path.join(OUT, 'tools/agentTools'));
const { startBackground, killAllBackground } = require(path.join(OUT, 'tools/moreTools'));
const { availableScriptTools, runScript, resetScriptSession } = require(path.join(OUT, 'tools/script'));
const { ToolExecutor } = require(path.join(OUT, 'host/toolExecutor'));
const { readExecutions } = require(path.join(OUT, 'core/executionJournal'));
const settings = { ...DEFAULT_SETTINGS, runScript: true, commandTool: true, sandbox: 'off', hideCommandSecrets: true, tokenSaver: false };
const signal = new AbortController().signal;
const context = (sessionId, extra = {}) => ({ settings, signal, sessionId, taskId: 'turn', vision: false, storageDir: path.join(base, 'journal'),
  requestApproval: async () => ({ approved: true, finish() {} }), ...extra });
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
const executor = new ToolExecutor({ scheduleState() {}, mcp: {}, plugins: { agents: () => [] } });
const markerCommand = process.platform === 'win32' ? 'Write-Output session-marker' : 'echo session-marker';
const wait = async p => {
  const deadline = Date.now() + 10000;
  while (p.code === undefined && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.notEqual(p.code, undefined, 'fixture process must settle');
};
test.after(() => {
  killAllBackground(); delete process.env.ZC_SESSION_API_KEY;
  assert.equal(path.dirname(base), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(base).startsWith('zer0ne-session-tools-'));
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('core and worktree commands obey the originating project deny rules before approval', async () => {
  fs.mkdirSync(path.join(project, '.zer0ne'));
  fs.writeFileSync(path.join(project, '.zer0ne/command-rules'), 'deny: *session-marker*\n');
  let approvals = 0;
  const approve = async () => { approvals++; return true; };
  const direct = await new CoreTools({ root: project, approve }).run('run_command', { command: markerCommand }, signal);
  assert.equal(direct.error, true); assert.match(direct.output, /command rules/);
  const worktree = path.join(base, 'worktree'); fs.mkdirSync(worktree); fs.mkdirSync(path.join(worktree, '.zer0ne'));
  fs.writeFileSync(path.join(worktree, '.zer0ne/command-rules'), 'allow: *\n');
  const worker = new CoreTools({ root: worktree, approve, commandContext: { ...context('writer'), commandRulesRoot: project,
    requestApproval: async () => { approvals++; return { approved: true, finish() {} }; } } });
  const result = await worker.run('run_command', { command: markerCommand }, signal);
  assert.equal(result.error, true); assert.match(result.output, /command rules/); assert.equal(approvals, 0);
  fs.writeFileSync(path.join(project, '.zer0ne/command-rules'), '');
});

test('worker approvals carry ask rules and finish with actual command failure after execution', async () => {
  fs.writeFileSync(path.join(project, '.zer0ne/command-rules'), 'ask: *session-marker*\n');
  const finishes = []; let request;
  const worker = new CoreTools({ root: project, approve: async () => false, commandContext: { ...context('writer'),
    requestApproval: async req => { request = req; assert.equal(finishes.length, 0); return { approved: true, finish: (...args) => finishes.push(args) }; } } });
  const result = await worker.run('run_command', { command: markerCommand + '; exit 17', timeout_seconds: 5 }, signal);
  assert.equal(request.projectRule, 'ask'); assert.equal(result.exitCode, 17); assert.equal(result.error, true);
  assert.equal(finishes.length, 1); assert.equal(finishes[0][1], true); assert.match(finishes[0][0], /exit code 17/);
  assert.match(finishes[0][0], /session-marker/);
  fs.writeFileSync(path.join(project, '.zer0ne/command-rules'), '');
});

test('core commands filter inherited and explicit dummy secrets and honor the opt-out', async () => {
  process.env.ZC_SESSION_API_KEY = 'fixture-inherited';
  const command = process.platform === 'win32' ? '[Console]::Write($env:ZC_SESSION_API_KEY)' : 'printf "%s" "$ZC_SESSION_API_KEY"';
  for (const hidden of [true, false]) {
    const worker = new CoreTools({ root: project, approve: async () => true, hideCommandSecrets: hidden, env: { ZC_SESSION_API_KEY: 'fixture-explicit' } });
    const result = await worker.run('run_command', { command, timeout_seconds: 5 }, signal);
    assert.equal(result.exitCode, 0); assert.equal(result.output.includes('fixture-explicit'), !hidden);
  }
  delete process.env.ZC_SESSION_API_KEY;
});

test('background output belongs to its chat and agent; failed exits update cards and journals', async () => {
  const owner = context('A', { guardScope: 'agent-A' });
  const p = startBackground(markerCommand + '; exit 17', project, undefined, undefined, owner); await wait(p);
  for (const ctx of [context('B', { guardScope: 'agent-A' }), context('A', { guardScope: 'agent-B' })]) {
    const refused = await runTool(call('foreign-output', 'command_output', { id: p.id, wait_seconds: 0.01 }), ctx);
    assert.equal(refused.error, true); assert.doesNotMatch(refused.api, /session-marker/);
  }
  const cards = [];
  const result = await executor.executeCall(call('owned-output', 'command_output', { id: p.id, wait_seconds: 0.01 }), owner, cards, [], {}, settings);
  assert.equal(result.error, true); assert.match(result.api, /session-marker/); assert.match(result.api, /exited with code 17/);
  assert.equal(cards[0].tool.status, 'error');
  assert.equal(readExecutions(owner.storageDir, 'A', 'turn')[0].events.at(-1).outcome, 'failed');
  const next = await runTool(call('owned-next', 'command_output', { id: p.id, wait_seconds: 0.01 }), owner);
  assert.match(next.api, /no new output/);
});

test('a foreign chat cannot stop a background command or enumerate another command', async () => {
  const owner = context('A');
  const p = startBackground(process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', project, undefined, undefined, owner);
  const cards = [];
  const denied = await executor.executeCall(call('foreign-kill', 'command_kill', { id: p.id }), context('B'), cards, [], {}, settings);
  assert.equal(denied.error, true); assert.equal(p.code, undefined);
  assert.equal(cards[0].tool.status, 'error');
  const unknown = await runTool(call('unknown', 'command_output', { id: 'missing' }), context('B'));
  assert.doesNotMatch(unknown.api, /Start-Sleep|sleep 30|Running:/);
  const running = await runTool(call('running', 'command_output', { id: p.id, wait_seconds: 0.01 }), owner);
  assert.equal(running.error, false); assert.match(running.summary, /running/);
  const stopped = await runTool(call('owned-kill', 'command_kill', { id: p.id }), owner);
  assert.ok(!stopped.error); await wait(p);
  assert.throws(() => startBackground(markerCommand, project, undefined, undefined, {}), /owning chat/);
});

test('background success and launch failures have truthful status', async () => {
  const owner = context('status');
  const success = startBackground(markerCommand, project, undefined, undefined, owner); await wait(success);
  const good = await runTool(call('good', 'command_output', { id: success.id, wait_seconds: 0.01 }), owner);
  assert.equal(good.error, false); assert.match(good.summary, /code 0/);
  const failed = startBackground('missing', project, { file: path.join(base, 'missing-executable'), args: [], env: process.env }, undefined, owner); await wait(failed);
  const bad = await runTool(call('launch-failure', 'command_output', { id: failed.id, wait_seconds: 0.01 }), owner);
  assert.equal(bad.error, true); assert.match(bad.api, /failed to start/);
});

test('a background Windows command remains owned and stoppable after its launching shell exits', { skip: process.platform !== 'win32' }, async () => {
  const { approveCommand } = require(path.join(OUT, 'tools/command'));
  const owner = context('job-owner'), marker = path.join(base, 'descendant-pid'), script = path.join(base, 'descendant.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const command = 'Start-Process -FilePath ' + quote(process.execPath) + ' -ArgumentList ' + quote('"' + script + '"') + ' -WindowStyle Hidden';
  const plan = await approveCommand(command, project, project, owner, true);
  assert.ok(plan.guard, 'exercise the real Windows process supervisor');
  const p = startBackground(command, project, plan.spec, plan.env, owner, plan.guard);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(marker));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(p.code, undefined, 'the descendant must survive its shell while remaining tracked');
  const stopped = await runTool(call('stop-descendant', 'command_kill', { id: p.id }), owner);
  assert.ok(!stopped.error); await wait(p);
  const pid = Number(fs.readFileSync(marker, 'utf8'));
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});

test('script failures after progress output mark cards and journals failed, including inner tools', async () => {
  for (const [id, code] of [['throw', 'print("progress"); throw new Error("fixture failure");'],
    ['inner', 'print("progress"); await tools.read_file({path:"absent.txt"});']]) {
    const ctx = context('script-' + id), cards = [];
    const result = await executor.executeCall(call(id, 'run_script', { code, timeout_seconds: 5 }), ctx, cards, [], {}, settings);
    assert.equal(result.error, true); assert.match(result.api, /progress/); assert.match(result.detail, /Error:/);
    assert.equal(cards[0].tool.status, 'error');
    assert.equal(readExecutions(ctx.storageDir, ctx.sessionId, 'turn')[0].events.at(-1).outcome, 'failed');
  }
});

test('desktop script catalog and kept bridge honor host, settings and current tool policy', async () => {
  const off = { ...settings, gitTools: false, codeIndex: false, browserTools: false, agentMemory: false };
  const defs = buildToolDefs(off), script = defs.find(t => t.name === 'run_script');
  for (const name of ['code_intel', 'get_diagnostics', 'git_status', 'semantic_search', 'web_fetch', 'memory_recall']) {
    assert.ok(!availableScriptTools(off).includes(name)); assert.ok(!script.description.includes(name));
  }
  const example = script.description.split('Example: ')[1];
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/todo.ts'), '// TODO: fixture\n');
  const result = await runTool(call('example', 'run_script', { code: example }), context('example', { settings: off }));
  assert.ok(!result.error, result.api); assert.match(result.api, /1 TODOs/);
  let calls = 0;
  try {
    const first = await runScript('await tools.read_file({path:"x"})', async () => { calls++; return { text: 'fixture' }; }, { timeoutMs: 5000, maxCalls: 5, keep: 'policy', tools: ['read_file'] });
    assert.ok(!first.error);
    const second = await runScript('await tools.read_file({path:"x"})', async () => { calls++; return { text: 'wrong' }; }, { timeoutMs: 5000, maxCalls: 5, keep: 'policy', tools: [] });
    assert.match(second.error, /not available/); assert.equal(calls, 1);
  } finally { resetScriptSession('policy'); }
});

test('context preflight preserves task instructions, budgets tools and response, and prevents oversized model calls', async () => {
  const messages = [{ role: 'user', content: 'x'.repeat(200000) }];
  assert.throws(() => prepareAgentContext(messages, { windowTokens: 32768, systemChars: 1000, toolChars: 5000 }), /too large.*32768-token/);
  assert.equal(messages[0].content.length, 200000);
  let calls = 0;
  await assert.rejects(runCore({ provider: { model: 'fixture' }, contextWindow: 32768,
    tools: new CoreTools({ root: project, approve: async () => false }), messages: [{ role: 'user', content: 'x'.repeat(200000) }],
    callModel: async () => { calls++; throw Error('must not dispatch'); } }), /Shorten the task/);
  assert.equal(calls, 0);
  const small = [{ role: 'user', content: 'keep requirements' }, { role: 'assistant', content: '', toolCalls: [] },
    { role: 'tool', toolCallId: 'fixture', content: 'old output '.repeat(5000) }];
  const output = prepareAgentContext(small, { windowTokens: 8192, systemChars: 1000, toolChars: 2000 });
  assert.equal(small[0].content, 'keep requirements');
  assert.ok(small.reduce((n, m) => n + m.content.length, 0) + 3000 <= (8192 - output - 1024) * 3);
  await assert.rejects(withOverflowRecovery(async () => { throw Error('request (40248 tokens) exceeds the available context size (32768 tokens)'); },
    { messages, windowTokens: 32768, systemChars: 0, reservedTokens: 8000 }), /split the review/);
});

test('invalid searches return actionable diagnostics instead of an empty Invalid search label', async () => {
  const { rgSearch, ripgrepPath } = require(path.join(OUT, 'tools/ripgrep'));
  if (!ripgrepPath()) return;
  await assert.rejects(rgSearch(project, '[', '**/*', signal), /Search failed \(ripgrep exit 2\): .+/);
});
