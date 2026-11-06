'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), ts = require('typescript-classic');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) { return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: { env: {}, workspace: {} } };
const { verifyUrlIn, googleVerificationUrl, verificationFailureText } = require('../out/acp/verification');
const { AcpConnection, AcpError, verificationMessage } = require('../out/acp/client');
const { streamAcp, closeAcpAgents } = require('../out/acp/stream');
const { getAcpRuntime, setAcpRuntime } = require('../out/acp/runtime');
const { agentFailureText, ProviderStore, normalizeModel } = require('../out/providerStore');
const { AcpHost } = require('../out/host/acpHost');
const { loginWithCommand } = require('../out/acp/signIn');
const { JSDOM } = require('jsdom');
const challenge = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https%3A%2F%2Fdevelopers.google.com%2Fdone&plt=fixture_signed-value&authuser=0';

(async () => {
  assert.equal(verifyUrlIn('Verify your account to continue.\nVerify your account: ' + challenge), challenge);
  assert.equal(verifyUrlIn('VALIDATION_REQUIRED ' + JSON.stringify({ validation_url: challenge.replace(/&/g, '\\u0026') })), challenge);
  assert.equal(verifyUrlIn('VALIDATION_REQUIRED ' + challenge.replace(/&/g, '&amp;')), challenge);
  assert.equal(verifyUrlIn('Unrelated documentation: ' + challenge), undefined);
  for (const unsafe of ['http://accounts.google.com/x', 'https://accounts.google.com.evil.example/x', 'https://accounts.google.com@evil.example/x', 'https://user:pass@accounts.google.com/x', 'https://accounts.google.com:8443/x']) {
    assert.equal(googleVerificationUrl(unsafe), undefined); assert.equal(verifyUrlIn('VALIDATION_REQUIRED ' + unsafe), undefined);
  }
  assert.equal(new AcpError('Permission denied', -32000, { reason: 'VALIDATION_REQUIRED' }).authRequired, false);
  for (const text of ['Verify your account to continue.', '**Verify your account**', '**Account verification required**', 'VALIDATION_REQUIRED', 'Further action is required to use Antigravity.']) assert(verificationFailureText(text) && agentFailureText(text), text);
  for (const text of ['Hi! The previous request asked you to verify your account.', 'To implement the verification page, return a 403.', 'Hello! How can I help?']) assert.equal(verificationFailureText(text), false, text);
  const diagnostic = verificationMessage('Google Antigravity', challenge);
  assert(diagnostic.includes('(' + challenge + ')')); assert.match(diagnostic, /HTTP 500/); assert.match(diagnostic, /myaccount.google.com\/security/);
  assert(!verificationMessage('Google', 'https://evil.example/').includes('evil.example'));
  console.log('PASS: structured/plain verification links retain the signed query, reject foreign origins and distinguish a refusal from ordinary discussion.');

  const source = require('./page-scripts').readPage('settings.js');
  const ast = ts.createSourceFile('settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set(['VERIFY_LINK', 'errorText', 'verifyButton']), declarations = [];
  const visit = n => { if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.has(d.name.getText(ast)))) declarations.push(n.getText(ast)); if (ts.isFunctionDeclaration(n) && n.name?.text === 'signInFailureTitle') declarations.push(n.getText(ast)); ts.forEachChild(n, visit); }; visit(ast);
  assert.equal(declarations.length, 4);
  const context = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'), I: () => '' };
  vm.createContext(context); vm.runInContext(declarations.join('\n') + '\nglobalThis.buttons = verifyButton; globalThis.errorText = errorText; globalThis.failureTitle = signInFailureTitle;', context);
  assert.equal(context.failureTitle(diagnostic), 'Account verification required');
  assert.equal(context.failureTitle('Signed in, but VALIDATION_REQUIRED'), 'Account verification required');
  assert.equal(context.failureTitle('This provider does not permit this integration.'), 'Plan unavailable for this connection');
  assert.equal(context.failureTitle('Signed in, but the agent returned no text'), 'Signed in — connection needs attention');
  assert.equal(context.failureTitle('Authentication required'), 'Sign-in did not finish');
  const buttons = context.buttons(diagnostic);
  assert.equal((buttons.match(/data-act="open-url"/g) || []).length, 3);
  assert(buttons.includes('authuser=0')); assert(!context.errorText(diagnostic).includes('[Google account security]'));
  assert.equal(context.buttons('[Verify your account](https://accounts.google.com.evil.example/x)'), '');
  assert.equal(context.buttons(diagnostic), buttons, 'Repeated renders cannot lose a global-regex match');
  console.log('PASS: settings exposes three trusted recovery actions, preserves the full query and safely rerenders them.');

  const functions = new Map();
  const collect = node => { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast)); ts.forEachChild(node, collect); }; collect(ast);
  const dom = new JSDOM('<body><div id="settings-root"></div><div id="dialog-root"></div></body>', { runScripts: 'outside-only' }), w = dom.window, opened = [], copied = [], signIns = [];
  w.$ = id => w.document.getElementById(id); w.h = (tag, cls, html) => { const el = w.document.createElement(tag); el.className = cls || ''; if (html) el.innerHTML = html; return el; };
  w.esc = context.esc; w.I = () => '<svg><path></path></svg>'; w.toast = () => {};
  w.post = message => { if (message.type === 'openExternal') opened.push(message.url); if (message.type === 'copyText') copied.push(message.text); if (message.type === 'acpSignIn') signIns.push(message); };
  w.tile = () => ''; w.paintTiles = () => {}; w.SIGN_STEPS = [['authorize', 'Authorize'], ['connect', 'Connect'], ['ready', 'Ready']];
  w.eval(declarations.join('\n') + '\n' + ['openDialog', 'renderAcpSignIn', 'acpAction'].map(name => functions.get(name)).join('\n'));
  try {
    const dialog = w.openDialog({ title: 'Sign in', small: true });
    w.acpDlg = { d: dialog, c: { name: 'Google Antigravity', plans: 'Google AI Pro', manageUrl: 'https://antigravity.google' }, agentId: 'antigravity-acp', stage: 'error', error: 'Signed in, but ' + diagnostic };
    for (let render = 0; render < 2; render++) {
      w.renderAcpSignIn();
      const actions = [...dialog.dlg.querySelectorAll('[data-act="open-url"]')]; assert.equal(actions.length, 3);
      actions.forEach(action => action.querySelector('path').dispatchEvent(new w.MouseEvent('click', { bubbles: true })));
      dialog.dlg.querySelector('[data-act="copy-verification-url"]').click();
    }
    assert.deepEqual(opened, [challenge, 'https://myaccount.google.com/security', 'https://antigravity.google/docs/faq', challenge, 'https://myaccount.google.com/security', 'https://antigravity.google/docs/faq']);
    assert.deepEqual(copied, [challenge, challenge]);
    dialog.dlg.querySelector('[data-si="reauthorize"]').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(signIns[0].reauthenticate, true, 'the explicit Google reconnect requests fresh OAuth');
    Object.assign(w.acpDlg, { stage: 'error', error: 'Signed in, but ' + diagnostic }); w.renderAcpSignIn();
    dialog.dlg.querySelector('[data-si="retry"]').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(signIns[1].reauthenticate, undefined, 'retry after completing verification only rechecks the current login');
    const freshLogin = 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture%2Bstate&code_challenge=fixture-challenge&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F';
    Object.assign(w.acpDlg, { stage: 'error', error: diagnostic, url: challenge }); w.renderAcpSignIn();
    dialog.dlg.querySelector('[data-si="copyfresh"]').click();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(signIns[2].reauthenticate, true, 'copying a fresh link starts vendor reauthorization');
    assert.equal(copied.length, 2, 'the previous verification URL is never copied as the fresh OAuth link');
    Object.assign(w.acpDlg, { stage: 'browser', url: freshLogin }); w.renderAcpSignIn(); w.renderAcpSignIn();
    assert.deepEqual(copied, [challenge, challenge, freshLogin], 'the newly generated link is copied exactly once through the app bridge');
    assert.equal(dialog.dlg.querySelector('[data-acp-login-link]').value, freshLogin, 'the live URL is also selectable without clipboard access');
    dialog.dlg.querySelector('[data-si="copylink"]').click();
    assert.equal(copied.at(-1), freshLogin, 'manual copying uses the app clipboard even while the browser has focus');
    Object.assign(w.acpDlg, { stage: 'error', error: diagnostic }); w.renderAcpSignIn();
    dialog.dlg.querySelector('[data-si="reauthorize"]').click(); dialog.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(signIns.length, 3, 'closing a scheduled reconnect prevents its later logout/login request');
    const generic = w.openDialog({ title: 'Provider OAuth' }); generic.body.innerHTML = '<button data-act="open-url" data-url="https://example.test/oauth?state=a%2Bb&amp;redirect_uri=http%3A%2F%2Flocalhost%2Fcallback">Open</button>';
    generic.body.querySelector('button').click(); assert.equal(opened.at(-1), 'https://example.test/oauth?state=a%2Bb&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback');
    generic.close(); dialog.close();
  } finally { w.close(); }
  console.log('PASS: actual sign-in dialogs launch all recovery links once after rerendering and copy the signed query without modification.');

  const signed = 'https://accounts.google.com/signin/continue?plt=' + 'A'.repeat(5000) + '&continue=https%3A%2F%2Fexample.test%2Fdone&authuser=0';
  const first = 'VALIDATION_REQUIRED validation_url=' + signed.slice(0, 2000), second = signed.slice(2000) + '\n';
  const childCode = `const readline=require('readline');const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){process.stderr.write(${JSON.stringify(first)});send(m.id,{protocolVersion:1});}else{process.stderr.write(${JSON.stringify(second)});send(m.id,{});}});`;
  const diagnostics = new AcpConnection({ command: process.execPath, args: ['-e', childCode] }, { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate() {} });
  try {
    diagnostics.start(); await diagnostics.initialize({ fs: false });
    assert.equal(diagnostics.verifyUrl, undefined, 'a partial pipe chunk must not publish a truncated challenge');
    await diagnostics.request('fixture/finish', {});
    const deadline = Date.now() + 3000; while (!diagnostics.verifyUrl && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(diagnostics.verifyUrl, signed, 'a challenge longer than the old stderr tail survives pipe fragmentation');
  } finally { diagnostics.close(); }
  assert.equal(verifyUrlIn('VALIDATION_REQUIRED ' + challenge + '\nVALIDATION_REQUIRED ' + signed), signed, 'a fresh challenge replaces an older one');
  console.log('PASS: real ACP stderr fragmentation cannot publish a partial signed challenge, and long/fresh challenges stay intact.');

  const oauthUrl = 'https://example.test/oauth?state=' + 's'.repeat(4500) + '&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback';
  for (const browser of ['false', 'reject']) {
    const events = [], links = [];
    const login = `process.stdout.write(${JSON.stringify('Sign in: ' + oauthUrl.slice(0, 2000))});setTimeout(()=>process.stdout.write(${JSON.stringify(oauthUrl.slice(2000) + '\nEnter code: ')}),40);process.stdin.once('data',()=>process.exit(0));`;
    await loginWithCommand({ command: process.execPath, args: ['-e', login] }, { signal: new AbortController().signal, event: event => events.push(event), open: url => { links.push(url); return browser === 'false' ? false : Promise.reject(Error('fixture browser failure')); }, terminal() {}, code: async () => 'fixture-code' });
    assert.deepEqual(links, [oauthUrl]); assert(events.some(event => event.browserError && event.url === oauthUrl));
  }
  console.log('PASS: vendor CLI OAuth links are complete across chunks; unavailable browsers retain the manual page/copy fallback.');

  const state = new Map(), secrets = new Map();
  const store = new ProviderStore({ globalState: { get: (k, fallback) => state.has(k) ? state.get(k) : fallback, update: async (k, v) => state.set(k, v) }, secrets: { get: async k => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async k => secrets.delete(k) } });
  const provider = await store.add({ name: 'Verification fixture', baseUrl: 'acp:verification-fixture', apiFormat: 'acp', models: [] });
  const advertised = { protocol: 'agent', levels: ['low', 'high'], note: 'Agent thought choices', configId: 'effort', defaultValue: 'high', choices: [{ effort: 'low', value: 'low' }, { effort: 'high', value: 'high' }] };
  await store.update(provider.id, { models: [{ id: 'fixture-model', enabled: true, reasoningControl: advertised }] });
  assert.deepEqual((await store.get(provider.id)).models[0].reasoningControl, advertised, 'Agent controls survive saving and reloading provider models');
  assert.equal(normalizeModel({ id: 'm', reasoningControl: { protocol: 'arbitrary-field', levels: ['high'] } }).reasoningControl, undefined);
  assert.deepEqual(normalizeModel({ id: 'm', reasoningControl: { protocol: 'openrouter', levels: ['low', 'invented'], note: 'Catalog efforts' } }).reasoningControl.levels, ['low']);
  console.log('PASS: provider persistence retains advertised reasoning controls and rejects unsupported metadata fields.');
  const host = new AcpHost({ store }, {});
  const longChallenge = 'https://accounts.google.com/signin/continue?plt=' + 'A'.repeat(1800) + '&authuser=0';
  await host.recordHealth(provider.id, { ok: false, error: verificationMessage('Google', longChallenge) });
  assert((await store.get(provider.id)).health.error.includes(longChallenge));
  assert((await store.get(provider.id)).health.error.includes('https://antigravity.google/docs/faq'));
  host.dispose();
  console.log('PASS: saved account diagnostics keep a long signed challenge and its recovery links complete.');

  const previous = getAcpRuntime(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-verification-')), script = path.join(tmp, 'agent.cjs');
  fs.writeFileSync(script, `const readline = require('node:readline');
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); let result = {};
 if (m.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'Verification fixture', version: '1' }, agentCapabilities: {}, authMethods: [] };
 if (m.method === 'session/new') result = { sessionId: 'fixture', models: { currentModelId: 'fixture-model', availableModels: [{ modelId: 'fixture-model' }] } };
 if (m.method === 'session/prompt') {
  const answer = process.env.FIXTURE_VERIFICATION === '1' ? 'Verify your account to continue.\\nVerify your account: '+${JSON.stringify(challenge)} : 'Hello! How can I help?';
  for (let i=0; i<answer.length; i+=17) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fixture', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.slice(i,i+17) } } } });
  result = { stopReason: 'end_turn' };
 }
 if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result });
});`);
  let verification = true, connections = 0;
  const fixtureRuntime = { entry: async () => ({ id: 'verification-fixture', name: 'Verification fixture' }), connect: async (_entry, handlers) => {
    connections++; const conn = new AcpConnection({ command: process.execPath, args: [script], env: { ...process.env, FIXTURE_VERIFICATION: verification ? '1' : '0' } }, handlers);
    conn.start(); await conn.initialize({ fs: true }); return conn;
  } };
  setAcpRuntime(fixtureRuntime);
  const options = { baseUrl: 'acp:verification-fixture', apiFormat: 'acp', apiKey: '', model: 'fixture-model', system: '', messages: [{ role: 'user', content: 'Hi' }], signal: new AbortController().signal, acp: { cwd: tmp, chatId: 'fixture', permission: async () => false, readFile: async () => '', writeFile: async () => {}, tool() {} } };
  try {
    await store.update(provider.id, { agent: { id: 'verification-fixture' }, health: { ok: false, at: Date.now(), error: diagnostic, signIn: true } });
    const checkEvents = [], checking = new AcpHost({ store, sendState: async () => {}, status() {} }, fixtureRuntime);
    await checking.handle({ post: m => checkEvents.push(m) }, { type: 'checkProvider', id: provider.id });
    assert.equal(checkEvents.at(-1).type, 'providerCheck');
    assert.equal(checkEvents.at(-1).count, 1, 'the refused plan still advertises its model catalog');
    assert.equal(checkEvents.at(-1).ok, false, 'a model list cannot clear a real account verification refusal');
    assert.equal((await store.get(provider.id)).health.ok, false);
    assert((await store.get(provider.id)).health.error.includes(challenge));
    verification = false;
    await checking.handle({ post: m => checkEvents.push(m) }, { type: 'checkProvider', id: provider.id });
    assert.equal(checkEvents.at(-1).ok, true);
    assert.equal((await store.get(provider.id)).health.ok, true, 'a genuine agent greeting clears the failure');
    checking.dispose();
    verification = true;
    const beforeRetry = connections;
    await assert.rejects(streamAcp(options), error => /needs your account verified/.test(error.message) && error.message.includes(challenge));
    verification = false;
    assert.equal((await streamAcp(options)).text, 'Hello! How can I help?');
    assert.equal(connections, beforeRetry + 2, 'Retry replaces the refused agent session');
    console.log('PASS: checking an advertised plan requires a real answer; account verification remains failed until a greeting succeeds.');
    console.log('PASS: a real ACP child streaming a plain verification refusal fails the turn; retry starts a fresh session and accepts a greeting.');
  } finally { closeAcpAgents(); setAcpRuntime(previous); fs.unlinkSync(script); fs.rmdirSync(tmp); }
})().catch(error => { console.error(error); process.exitCode = 1; });
