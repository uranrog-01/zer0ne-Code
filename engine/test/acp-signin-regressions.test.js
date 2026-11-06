'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');
const { getEventListeners } = require('events');
const OUT = path.join(__dirname, '../out');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? 'vscode' : originalResolve.call(this, request, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: {
  env: { appHost: 'desktop' }, workspace: {}, window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
  StatusBarAlignment: { Right: 2 }, InlineCompletionTriggerKind: { Automatic: 1 }
} };
const signIn = require(OUT + '/acp/signIn');
const { AcpConnection, AcpError, authMethodsFrom, agentErrorMessage, planModels } = require(OUT + '/acp/client');
const { AcpRuntime } = require(OUT + '/acp/runtime');
const { AcpHost } = require(OUT + '/host/acpHost');
const { ProviderStore } = require(OUT + '/providerStore');
const { cardsFrom, launchFor, PLAN_AGENTS } = require(OUT + '/acp/registry');
const { REGISTRY_SNAPSHOT } = require(OUT + '/acp/registrySnapshot');
const { terminalLaunch, createLoginRunner } = require(OUT + '/host/loginTerminal');
const entry = { id: 'fixture-agent', name: 'Fixture agent', version: '1', description: '', authors: [], distribution: { npx: { package: 'fixture' } } };
const modelSession = { sessionId: 'fixture-session', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model', name: 'Fixture model' }] } };
const makeIo = () => ({ signal: new AbortController().signal, open() {}, terminal: async () => {}, event() {}, code: async () => '' });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
function store() {
  const state = new Map(), secrets = new Map();
  return new ProviderStore({ globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => state.set(key, value) }, secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) } });
}
async function until(predicate) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await pause(10);
  assert(predicate(), 'fixture reached expected stage');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-acp-auth-regressions-'));
  const realSignIn = signIn.signInAgent;
  try {
    const legacy = authMethodsFrom([{ id: 'legacy', name: 'Interactive login', _meta: { 'terminal-auth': { args: ['--login', 'path with spaces'], env: { LOGIN_FLOW: 'browser' } } } }]);
    assert.equal(legacy[0].type, 'terminal');
    assert.deepEqual(legacy[0].args, ['--login', 'path with spaces']);
    assert.deepEqual(legacy[0].env, { LOGIN_FLOW: 'browser' });
    assert.equal(authMethodsFrom([{ id: 'bad', type: 'terminal', args: [null] }]).length, 0);
    assert.equal(authMethodsFrom([{ id: 'bad', type: 'terminal', env: ['unexpected'] }]).length, 0);
    assert.equal(authMethodsFrom([{ id: 'future', type: 'new-unsupported-method' }])[0].type, 'new-unsupported-method');
    assert.deepEqual(planModels({ current: 'unrelated-billing/model', models: [{ id: 'unrelated-billing/model' }] }, { models: ['required-plan/'] }), { models: [] }, 'a missing subscription never falls back to separately billed gateway models');

    let authenticated = false, terminalCalled = false, spawned;
    const conn = {
      agentName: 'Fixture', authMethods: legacy, close() {},
      newSession: async () => { if (!authenticated) throw new AcpError('Authentication required', -32000); return modelSession; },
      authenticate: async () => { throw Error('Terminal descriptor must not be sent to authenticate'); }
    };
    const rt = {
      connect: async () => conn, launch: () => ({ kind: 'binary' }),
      spawnSpec: (_entry, cwd, args, env) => (spawned = { command: 'configured-agent', args: ['acp', ...args], env, cwd })
    };
    const result = await realSignIn(rt, entry, { name: 'Fixture', loginCommand: { command: 'nonexistent-vendor', args: ['wrong', 'login'] } }, tmp, {
      ...makeIo(), terminal: async (_title, command, args, env) => {
        terminalCalled = true; assert.equal(command, 'configured-agent'); assert.deepEqual(args, ['acp', '--login', 'path with spaces']); assert.equal(env.LOGIN_FLOW, 'browser'); authenticated = true;
      }
    });
    assert(terminalCalled); assert.equal(spawned.cwd, tmp); assert.equal(result.models[0].id, 'fixture-model');
    console.log('PASS: typed and legacy terminal auth keeps the configured agent, args and environment over curated fallbacks.');

    const googleMeta = PLAN_AGENTS['antigravity-acp'], reconnectCalls = [];
    const googleConn = {
      ...conn, capabilities: { auth: { logout: {} } },
      authMethods: [{ id: 'oauth-business', name: 'Business', type: 'agent' }, { id: 'oauth-personal', name: 'Google', type: 'agent' }],
      request: async (method, params) => { assert.equal(method, 'logout'); assert.deepEqual(params, {}); reconnectCalls.push('logout'); },
      authenticate: async method => { reconnectCalls.push(method); },
      newSession: async () => { reconnectCalls.push('session'); return modelSession; },
      close: () => reconnectCalls.push('close')
    };
    const reconnectIo = { ...makeIo(), reauthenticate: true };
    const googleEntry = { ...entry, id: 'antigravity-acp' };
    const googleRt = { ...rt, connect: async () => googleConn };
    await realSignIn(googleRt, googleEntry, googleMeta, tmp, reconnectIo);
    assert.deepEqual(reconnectCalls, ['logout', 'oauth-personal', 'session', 'close'], 'explicit reconnect cannot reuse an already-openable stale session or select Enterprise billing');
    reconnectCalls.length = 0;
    await realSignIn(googleRt, googleEntry, googleMeta, tmp, makeIo());
    assert.deepEqual(reconnectCalls, ['session', 'close'], 'ordinary retry retains the saved login');
    for (const capabilities of [{}, { auth: { logout: false } }, { auth: { logout: null } }]) {
      reconnectCalls.length = 0;
      await assert.rejects(realSignIn({ ...googleRt, connect: async () => ({ ...googleConn, capabilities }) }, googleEntry, googleMeta, tmp, reconnectIo), /cannot restart its saved login/);
      assert.deepEqual(reconnectCalls, ['close'], 'unadvertised logout never changes the vendor login');
    }
    reconnectCalls.length = 0;
    await assert.rejects(realSignIn({ ...googleRt, connect: async () => ({ ...googleConn, request: async () => { reconnectCalls.push('logout-failed'); throw Error('fixture logout failure'); } }) }, googleEntry, googleMeta, tmp, reconnectIo), /fixture logout failure/);
    assert.deepEqual(reconnectCalls, ['logout-failed', 'close'], 'failed logout stops before authentication or session reuse');
    reconnectCalls.length = 0;
    await assert.rejects(realSignIn({ ...googleRt, connect: async () => ({ ...googleConn, authMethods: [googleConn.authMethods[0]] }) }, googleEntry, googleMeta, tmp, reconnectIo), /does not advertise the browser sign-in/);
    assert.deepEqual(reconnectCalls, ['close'], 'missing personal OAuth cannot silently switch accounts or clear the old login');
    const cancelledReconnect = new AbortController();
    await assert.rejects(realSignIn({ ...googleRt, connect: async () => ({ ...googleConn, request: async () => { cancelledReconnect.abort(); } }) }, googleEntry, googleMeta, tmp, { ...makeIo(), reauthenticate: true, signal: cancelledReconnect.signal }), error => error.name === 'AbortError');
    console.log('PASS: explicit Antigravity reconnect negotiates logout then personal OAuth; retry, missing capabilities, failures and cancellation cannot replace the login accidentally.');

    const oauthUrl = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=fixture-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F&code_challenge=fixture-challenge&code_challenge_method=S256';
    const challengeUrl = 'https://accounts.google.com/signin/continue?sarp=fixture-signed-challenge&continue=fixture';
    for (const reauthenticate of [false, true]) {
      const opened = [], events = [];
      let authorized = false;
      const diagnosticsRt = { ...googleRt, connect: async (_entry, handlers) => {
        return { ...googleConn,
          request: async () => ({}),
          newSession: async () => { if (!authorized) throw new AcpError('Authentication required', -32000); return modelSession; },
          authenticate: async () => {
            handlers.log('Authentication warning: verify your account at ' + challengeUrl, 'stderr');
            handlers.log('Authentication help: https://antigravity.google/docs/install', 'stderr');
            handlers.log('Authentication help: https://accounts.google.com.evil.example/o/oauth2/v2/auth', 'stderr');
            handlers.log('Authentication help: https://user:password@accounts.google.com/o/oauth2/v2/auth', 'stderr');
            handlers.log('Open the following link to authenticate the ACP server: ' + oauthUrl, 'stderr');
            authorized = true;
          }
        };
      } };
      await realSignIn(diagnosticsRt, googleEntry, googleMeta, tmp, { ...makeIo(), reauthenticate, open: url => opened.push(url), event: event => events.push(event) });
      assert.deepEqual(opened, [oauthUrl], 'a verification diagnostic cannot replace the personal OAuth URL or block the later authorization link');
      assert.deepEqual(events.filter(event => event.stage === 'browser').map(event => event.url), [oauthUrl]);
    }
    console.log('PASS: Antigravity login opens the exact OAuth URL even when an earlier diagnostic contains a verification challenge.');

    const routed = [], routeHost = new AcpHost({ store: store(), sendState: async () => {}, status() {} }, rt);
    routeHost.signIn = async (...args) => { routed.push(args); };
    await routeHost.handle({ post() {} }, { type: 'acpSignIn', agent: 'antigravity-acp', id: 'saved-provider', reauthenticate: true });
    await routeHost.handle({ post() {} }, { type: 'acpSignIn', agent: 'antigravity-acp' });
    await routeHost.handle({ post() {} }, { type: 'acpSignIn', agent: 'claude-acp', reauthenticate: true });
    assert.deepEqual(routed.map(args => [args[1], args[2], args[3]]), [['antigravity-acp', 'saved-provider', true], ['antigravity-acp', undefined, false], ['claude-acp', undefined, false]]);
    routeHost.dispose();

    for (const reconnect of [false, true]) {
      const calls = [], catalogHost = new AcpHost({ store: store(), sendState: async () => {}, status() {} }, {
        registry: async force => { calls.push(['refresh', force]); },
        entry: async id => { calls.push(['entry', id]); return { ...googleEntry, version: '1.4.1' }; },
        setup: selected => { calls.push(['setup', selected.version]); return { available: false, setupIssue: 'fixture stops before login' }; }
      });
      await catalogHost.signIn({ post() {} }, 'antigravity-acp', undefined, reconnect);
      assert.deepEqual(calls, [['refresh', true], ['entry', 'antigravity-acp'], ['setup', '1.4.1']], 'adding and reconnecting Antigravity resolve the updated registry before choosing an installer');
      catalogHost.dispose();
    }
    let cancelCatalog, enteredAfterCancellation = false;
    const cancelledCatalogHost = new AcpHost({ store: store(), sendState: async () => {}, status() {} }, {
      registry: () => new Promise(resolve => { cancelCatalog = resolve; }),
      entry: async () => { enteredAfterCancellation = true; }
    });
    const cancelledCatalogSignIn = cancelledCatalogHost.signIn({ post() {} }, 'antigravity-acp');
    await until(() => !!cancelCatalog);
    await cancelledCatalogHost.handle({ post() {} }, { type: 'acpCancel' }); cancelCatalog([]); await cancelledCatalogSignIn;
    assert.equal(enteredAfterCancellation, false, 'cancelling an update check cannot start a late login');
    cancelledCatalogHost.dispose();
    console.log('PASS: Antigravity sign-in refreshes the vendor registry before installer selection, including reconnect and cancellation.');

    const claudeMeta = PLAN_AGENTS['claude-acp'];
    const sources = claudeMeta.planOnly.sessionMeta.claudeCode.options.settingSources.join(',');
    for (const command of [claudeMeta.statusCommand, claudeMeta.loginCommand]) {
      assert.equal(command.args[command.args.indexOf('--setting-sources') + 1], sources, 'CLI and session settings must match');
    }
    assert(claudeMeta.loginCommand.args.includes('--claudeai'), 'the plan card explicitly selects subscription login');
    const fakeClaude = path.join(tmp, 'claude-fixture.cjs');
    fs.writeFileSync(fakeClaude, `const fs = require('node:fs'); const args = process.argv.slice(2);
const isolated = args[args.indexOf('--setting-sources') + 1] === 'project,local';
if (args.includes('status')) process.stdout.write(JSON.stringify({loggedIn: !isolated || fs.existsSync('.fixture-login'), authMethod: isolated && !fs.existsSync('.fixture-login') ? 'none' : 'oauth_token', apiProvider: 'firstParty'}));
else if (args.includes('login')) { if (!isolated || !args.includes('--claudeai')) process.exit(2); fs.writeFileSync('.fixture-login', JSON.stringify({cwd: process.cwd(), args, proxyPresent: Boolean(process.env.ANTHROPIC_AUTH_TOKEN)})); }
else process.exit(3);`);
    const fakeCommand = command => ({ command: process.execPath, args: [fakeClaude, ...command.args] });
    const fakeMeta = { ...claudeMeta, statusCommand: fakeCommand(claudeMeta.statusCommand), loginCommand: fakeCommand(claudeMeta.loginCommand) };
    assert.equal((await signIn.readStatus({ command: process.execPath, args: [fakeClaude, 'auth', 'status', '--json'] }, process.env, tmp)).loggedIn, true, 'unfiltered status can see only a proxy credential');
    assert.equal((await signIn.readStatus(fakeMeta.statusCommand, process.env, tmp)).loggedIn, false, 'the same settings as chat expose a missing subscription login');
    const priorProxy = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-only-proxy';
    try {
      await realSignIn({ ...rt, connect: async () => {
        const login = JSON.parse(fs.readFileSync(path.join(tmp, '.fixture-login')));
        assert.equal(login.cwd, tmp, 'login runs in the session project');
        assert.equal(login.proxyPresent, false, 'separate proxy billing is removed from subscription login');
        return { ...conn, newSession: async () => modelSession };
      } }, { ...entry, id: 'claude-acp' }, fakeMeta, tmp, makeIo());
    } finally { if (priorProxy === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = priorProxy; }
    assert.equal((await signIn.readStatus(fakeMeta.statusCommand, process.env, tmp)).loggedIn, true, 'post-login status reads the same project and settings');
    assert(!agentErrorMessage(new AcpError('Authentication required', -32000), 'Claude').includes('expired'), 'missing credentials do not establish an expired login');
    console.log('PASS: proxy-only CLI status cannot skip subscription login; status, browser login and ACP use matching settings and project cwd.');

    for (const subscription of ['absent', null, 'max']) {
      const status = { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' };
      if (subscription !== 'absent') status.subscriptionType = subscription;
      const statusCommand = { command: process.execPath, args: ['-e', 'process.stdout.write(' + JSON.stringify(JSON.stringify(status)) + ')'] };
      const reported = await signIn.readStatus(statusCommand);
      assert.equal(reported.loggedIn, true);
      assert.equal(reported.plan, subscription === 'max' ? 'max' : undefined);
      assert.equal(signIn.claudePlanStatusIssue(reported), undefined, 'missing/null optional subscription metadata is not a denial');
      let sessionOpened = false;
      const claudeRt = { ...rt, connect: async () => ({ ...conn, newSession: async () => { sessionOpened = true; return modelSession; } }) };
      const claudeEntry = { ...entry, id: 'claude-acp', name: 'Claude' };
      const meta = { name: 'Claude', statusCommand, loginCommand: { command: 'unused-login', args: [] } };
      const connected = await realSignIn(claudeRt, claudeEntry, meta, tmp, makeIo());
      assert(sessionOpened, 'OAuth login with unknown plan still reaches provider session validation');
      assert.equal(connected.models[0].id, 'fixture-model');
      const denied = new AcpError('This integration does not support using claude.ai subscriptions.', -32000, { reason: 'claude_subscription_not_supported' });
      await assert.rejects(realSignIn({ ...claudeRt, connect: async () => ({ ...conn, newSession: async () => { throw denied; } }) }, claudeEntry, meta, tmp, makeIo()), error => error === denied);
    }
    for (const status of [
      { loggedIn: true, authMethod: 'api_key', plan: 'max' },
      { loggedIn: true, authMethod: 'oauth_token', apiKeySource: 'apiKeyHelper', plan: 'max' },
      { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'bedrock', plan: 'max' }
    ]) assert.match(signIn.claudePlanStatusIssue(status), /API or external-cloud billing/);
    console.log('PASS: Claude missing/null OAuth subscription metadata defers to the agent; explicit provider refusals and API billing remain blocked.');

    let browserSignedIn = false;
    const oauthTokenAgent = {
      ...conn, authMethods: [{ id: 'oauth-token', name: 'Browser OAuth', type: 'agent' }],
      authenticate: async id => { assert.equal(id, 'oauth-token'); browserSignedIn = true; },
      newSession: async () => { if (!browserSignedIn) throw new AcpError('Authentication required', -32000); return modelSession; }
    };
    await realSignIn({ ...rt, connect: async () => oauthTokenAgent }, entry, undefined, tmp, makeIo());
    assert(browserSignedIn, 'an OAuth auth-method ID containing token is not confused with asking for a raw token');

    for (const method of [{ id: 'api-key', name: 'API key', type: 'env_var' }, { id: 'future', name: 'Future flow', type: 'new-unsupported-method' }, { id: 'different-plan', name: 'Other browser account', type: 'agent' }]) {
      let called = false;
      const blocked = { ...conn, authMethods: [method], newSession: async () => { throw new AcpError('Authentication required', -32000); }, authenticate: async () => { called = true; } };
      await assert.rejects(realSignIn({ ...rt, connect: async () => blocked }, entry, { name: 'Fixture', planScope: { authMethod: 'required-plan' } }, tmp, makeIo()), /offers no sign-in/);
      assert.equal(called, false, 'unsupported/key/another billing method is not used as OAuth');
    }
    const restricted = new AcpError('This integration does not support using claude.ai subscriptions.', -32000, { reason: 'claude_subscription_not_supported' });
    assert.equal(restricted.authRequired, false);
    assert.match(agentErrorMessage(restricted, 'Claude'), /signing in again will not change/);
    await assert.rejects(realSignIn({ ...rt, connect: async () => ({ ...conn, newSession: async () => { throw restricted; } }) }, entry, undefined, tmp, makeIo()), error => error === restricted);
    console.log('PASS: unsupported auth, plan-specific auth and subscription restrictions are distinguished from expired sign-in.');

    const signal = new AbortController().signal;
    const wire = new AcpConnection({ command: process.execPath, args: [path.join(__dirname, 'acp-mock-agent.js')] }, { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate() {} });
    wire.start();
    try {
      await wire.initialize({ fs: false, authTerminal: true });
      for (let i = 0; i < 20; i++) await wire.newSession(tmp, signal);
      assert.equal(getEventListeners(signal, 'abort').length, 0, 'completed protocol requests release abort handlers');
    } finally { wire.close(); }
    const runtime = new AcpRuntime(tmp);
    const hang = path.join(tmp, 'hang.js'); fs.writeFileSync(hang, 'process.stdin.resume();');
    runtime.spawnSpec = () => ({ command: process.execPath, args: [hang], cwd: tmp });
    const ctl = new AbortController();
    const connecting = runtime.connect(entry, { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate() {} }, { cwd: tmp, fs: false, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 50);
    await assert.rejects(connecting, error => error.name === 'AbortError');
    console.log('PASS: real stdio requests release listeners; cancelling an unresponsive agent startup returns cancellation.');

    const agentStore = store(), events = [], surface = { post: event => events.push(event) };
    const hostRt = { entry: async () => entry, setup: () => ({ available: true }), isInstalled: () => true };
    const host = new AcpHost({ store: agentStore, sendState: async () => {}, status() {} }, hostRt);
    let runs = 0, secondCode, verificationSignal;
    signIn.signInAgent = async (_rt, _entry, _meta, _cwd, io) => {
      const run = ++runs;
      if (run === 1) { await new Promise(resolve => io.signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true })); throw abortError(); }
      secondCode = await io.code();
      return { agent: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture model' }], current: 'fixture-model' };
    };
    host.check = async (_provider, _model, checkSignal) => { verificationSignal = checkSignal; return { ok: true, ms: 1 }; };
    const first = host.signIn(surface, entry.id);
    await until(() => runs === 1);
    const second = host.signIn(surface, entry.id);
    await until(() => runs === 2 && !!host.codeWaiter);
    await first;
    await host.handle(surface, { type: 'acpSignInCode', code: 'fixture-code' });
    await second;
    assert.equal(secondCode, 'fixture-code', 'retired login did not clear newer login code waiter');
    assert(verificationSignal instanceof AbortSignal, 'plan verification participates in the current sign-in cancellation');
    assert.equal(events.filter(event => event.stage === 'done').length, 1);
    host.dispose();

    const cancelledEvents = [], cancelHost = new AcpHost({ store: store(), sendState: async () => {}, status() {} }, hostRt);
    signIn.signInAgent = async () => ({ agent: 'Fixture', models: [{ id: 'fixture-model', name: 'Fixture model' }] });
    cancelHost.check = async (_provider, _model, checkSignal) => {
      if (!checkSignal.aborted) await new Promise(resolve => checkSignal.addEventListener('abort', resolve, { once: true }));
      return { ok: false, ms: 1, error: 'Cancelled' };
    };
    const signing = cancelHost.signIn({ post: event => cancelledEvents.push(event) }, entry.id);
    await until(() => cancelledEvents.some(event => event.stage === 'verify'));
    await cancelHost.handle(surface, { type: 'acpCancel' });
    await signing;
    assert(!cancelledEvents.some(event => event.stage === 'done'));
    assert(cancelledEvents.some(event => event.stage === 'cancelled'));
    cancelHost.dispose();
    console.log('PASS: overlapping logins retain the latest code waiter; verification cancellation cannot publish connected success.');

    const cards = cardsFrom(REGISTRY_SNAPSHOT);
    for (const id of ['codex-acp', 'gemini']) assert.equal(cards.find(card => card.id === id)?.plan, false, 'Alternate CLI stays outside the plan picker');
    for (const id of ['grok-build', 'kimi', 'minimax-code']) assert(cards.find(card => card.id === id)?.plan, id + ' offers vendor-agent sign-in as a plan card');
    const kimi = REGISTRY_SNAPSHOT.find(agent => agent.id === 'kimi');
    assert.equal(launchFor(kimi, 'darwin', 'x64'), undefined, 'missing vendor architecture is not disguised as a supported agent');
    assert.equal(launchFor(kimi, 'win32', 'arm64').kind, 'binary');
    console.log('PASS: vendor-agent cards expose platform limitations without inventing downloads.');

    for (const [name, expected] of [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--wait', '--']], ['konsole', ['--nofork', '-e']], ['xterm', ['-e']]]) {
      const launch = terminalLaunch('linux', '/private/login.command', wanted => wanted === name ? '/usr/bin/' + wanted : undefined);
      assert.equal(launch.command, '/usr/bin/' + name);
      assert.deepEqual(launch.args, [...expected, '/private/login.command']);
    }
    assert.throws(() => terminalLaunch('linux', '/private/login.command', () => undefined), /Install xterm/);
    const mac = terminalLaunch('darwin', "/private/a' b/login.command", () => undefined);
    assert.equal(mac.command, '/usr/bin/osascript');
    assert(mac.args[1].includes('login.command'));

    const inheritedKey = 'ZC_FIXTURE_INHERITED_CREDENTIAL', removedKey = 'ZC_FIXTURE_REMOVE_ROUTING';
    const beforeCredential = process.env[inheritedKey], beforeRemoved = process.env[removedKey];
    process.env[inheritedKey] = 'fixture-inherited-credential-not-copied'; process.env[removedKey] = 'fixture-routing';
    try {
      const runEnv = { ...process.env, LOGIN_DESCRIPTOR_FIXTURE: 'descriptor value with spaces' }; delete runEnv[removedKey];
      const files = createLoginRunner(process.execPath, ['-e', `require('fs').writeFileSync('observed.json', JSON.stringify({ cwd:process.cwd(), value:process.env.LOGIN_DESCRIPTOR_FIXTURE, removed:process.env.${removedKey} || null }));`], tmp, runEnv);
      try {
        const config = fs.readFileSync(files.config, 'utf8');
        assert(!config.includes('fixture-inherited-credential-not-copied'), 'inherited credentials are not copied into a launch file');
        assert(JSON.parse(config).unset.includes(removedKey));
        const child = spawn(process.execPath, [files.runner, files.config], { stdio: 'pipe' });
        let printed = ''; child.stdout.on('data', chunk => { printed += chunk; }); child.stderr.on('data', chunk => { printed += chunk; });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(Error('runner exit ' + code))); });
        assert.equal(printed, '', 'launch configuration is not echoed into the sign-in terminal');
        assert.equal(fs.existsSync(files.config), false, 'runner removes launch data before the vendor process runs');
        assert.deepEqual(JSON.parse(fs.readFileSync(files.result)), { code: 0 });
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'observed.json'))), { cwd: tmp, value: 'descriptor value with spaces', removed: null });
      } finally { files.cleanup(); }
      const failed = createLoginRunner(path.join(tmp, 'not-a-vendor-program'), [], tmp, runEnv);
      try {
        const child = spawn(process.execPath, [failed.runner, failed.config], { stdio: 'ignore' });
        await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        const result = JSON.parse(fs.readFileSync(failed.result)); assert.equal(result.code, null); assert.match(result.error, /ENOENT/);
      } finally { failed.cleanup(); }
      const cancelledRunner = createLoginRunner(process.execPath, ['-e', 'setInterval(()=>{},1000)'], tmp, runEnv);
      try {
        const child = spawn(process.execPath, [cancelledRunner.runner, cancelledRunner.config], { stdio: 'ignore' });
        const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        await until(() => fs.existsSync(cancelledRunner.pid));
        fs.writeFileSync(cancelledRunner.cancel, 'cancelled');
        await Promise.race([closed, pause(4000).then(() => { child.kill(); throw Error('cancelled login runner did not stop'); })]);
        assert.notEqual(JSON.parse(fs.readFileSync(cancelledRunner.result)).code, 0);
      } finally { cancelledRunner.cleanup(); }
    } finally {
      if (beforeCredential === undefined) delete process.env[inheritedKey]; else process.env[inheritedKey] = beforeCredential;
      if (beforeRemoved === undefined) delete process.env[removedKey]; else process.env[removedKey] = beforeRemoved;
    }
    console.log('PASS: Linux terminal selection and macOS invocation fixtures; real private runner preserves cwd/env changes, removes credential launch data and reports vendor exit.');
  } finally {
    signIn.signInAgent = realSignIn;
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert(path.basename(tmp).startsWith('zc-acp-auth-regressions-'));
    await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
