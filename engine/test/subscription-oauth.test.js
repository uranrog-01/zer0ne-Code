'use strict';
const assert = require('assert');
const http = require('http');
const { getEventListeners } = require('events');
const { generateKeyPairSync, sign, createHash } = require('crypto');
const { signIn, ensureFresh, accountModels, checkAccount, revokeAccount, parseCredential, serializeCredential } = require('../out/accounts');
const { signInWithOpenRouter } = require('../out/oauth');
const { codexBody, toResponsesInput, streamCodex } = require('../out/codexClient');
const { testModel } = require('../out/chatClient');
const tests = [], test = (name, run) => tests.push([name, run]);
const realFetch = global.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const listen = port => new Promise((resolve, reject) => {
 const server = http.createServer(); server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const fixture = (refresh = 'refresh') => ({ kind: 'account', account: 'xai', access: 'fixture-access', refresh, expires: 0 });
const hostId = 'urn:uuid:12345678-1234-4123-8123-123456789012';
const signing = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...signing.publicKey.export({ format: 'jwk' }), kid: 'fixture-openai-rsa', alg: 'RS256', use: 'sig' };
const signedIdentity = claims => {
 const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
 const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
 return head + '.' + body + '.' + sign('sha256', Buffer.from(head + '.' + body), signing.privateKey).toString('base64url');
};
async function modernLogin(options = {}) {
 let auth, exchange; const events = [], calls = [];
 global.fetch = async (url, init) => {
  calls.push(String(url));
  if (String(url) === 'https://auth.openai.com/.well-known/jwks.json') return json({ keys: [jwk] });
  if (String(url) === 'https://auth.openai.com/api/accounts/oauth/token') {
   exchange = Object.fromEntries(new URLSearchParams(init.body));
   const now = Date.now() / 1000;
   const claims = { iss: 'https://auth.openai.com', aud: exchange.client_id, sub: 'fixture-subject', exp: now + 3600, iat: now, nonce: auth.searchParams.get('nonce'), email: 'fixture@example.invalid', ...options.claims };
   let token = signedIdentity(claims); if (options.badSignature) token = token.slice(0, -6) + 'AAAAAA';
   return json({ access_token: 'plan-access', refresh_token: 'plan-refresh', token_type: 'Bearer', expires_in: 3600, scope: options.scope ?? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', id_token: token });
  }
  return realFetch(url, init);
 };
 try {
  const credential = await signIn('chatgpt', { hostId, previous: options.previous, signal: new AbortController().signal, onEvent: e => events.push(e), open: async url => {
   auth = new URL(url);
   const callback = new URL(auth.searchParams.get('redirect_uri'));
   callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', auth.searchParams.get('state'));
   if (!options.omitClient) callback.searchParams.set('client_id', options.clientId ?? options.previous?.clientId ?? 'oaiapp_fixture');
   const forged = new URL(callback); forged.searchParams.set('state', 'unrelated-state');
   assert.equal((await realFetch(forged)).status, 400);
   await realFetch(callback); return true;
  } });
  return { credential, auth, exchange, events, calls };
 } finally { global.fetch = realFetch; }
}

test('cancelled flows never open the browser or retain callback ports', async () => {
 const ctl = new AbortController(); ctl.abort(); let opened = false;
 const createServer = http.createServer; let serversCreated = 0;
 http.createServer = (...args) => { serversCreated++; return createServer(...args); };
 try {
  await assert.rejects(signInWithOpenRouter(async () => { opened = true; return true; }, ctl.signal), /cancelled/);
  await assert.rejects(signIn('chatgpt', { signal: ctl.signal, open: () => { opened = true; }, onEvent: () => {} }), /cancelled/);
 } finally { http.createServer = createServer; }
 assert.equal(opened, false);
 assert.equal(serversCreated, 0, 'already-cancelled flows never allocate a callback listener');
});

test('browser launch failures promptly reject and clean up the signal listener', async () => {
 for (const result of ['false', 'throw']) {
  const ctl = new AbortController(); const errors = []; const unhandled = e => errors.push(e);
  process.on('unhandledRejection', unhandled);
  try {
   await assert.rejects(signInWithOpenRouter(async () => { if (result === 'throw') throw Error('browser unavailable'); return false; }, ctl.signal), /browser/i);
   assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
   await new Promise(resolve => setTimeout(resolve, 10)); assert.deepEqual(errors, []);
  } finally { process.removeListener('unhandledRejection', unhandled); }
 }
 const ctl = new AbortController(); let callbackPort;
 await assert.rejects(signIn('chatgpt', { hostId, signal: ctl.signal, open: url => { callbackPort = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port); return false; }, onEvent: () => {} }), /browser/i);
 assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
 assert(callbackPort > 0); const server = await listen(callbackPort); await close(server);
});

test('OpenRouter uses a free port even when all formerly hard-coded ports are occupied', async () => {
 const servers = []; const ctl = new AbortController(); let callback;
 try {
  for (const port of [3000, 3001, 3017, 8765]) { try { servers.push(await listen(port)); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; } }
  global.fetch = async (url, init) => String(url).startsWith('https://openrouter.ai/') ? json({ key: 'fixture-key' }) : realFetch(url, init);
  const key = await signInWithOpenRouter(async url => {
   const auth = new URL(url); callback = new URL(auth.searchParams.get('callback_url'));
   assert(![3000, 3001, 3017, 8765].includes(Number(callback.port)));
   const forged = await realFetch(callback.origin + '/callback?code=forged'); assert.equal(forged.status, 404);
   const reply = await realFetch(callback.href + '?code=fixture-code'); assert.equal(reply.headers.get('cache-control'), 'no-store');
   return true;
  }, ctl.signal);
  assert.equal(key, 'fixture-key'); assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
  const reused = await listen(Number(callback.port)); await close(reused);
 } finally { global.fetch = realFetch; for (const server of servers) await close(server); }
});

test('cancelling OpenRouter cancels the pending key exchange', async () => {
 const ctl = new AbortController(); let exchangeStarted = false;
 global.fetch = async (url, init) => {
  if (!String(url).startsWith('https://openrouter.ai/')) return realFetch(url, init);
  exchangeStarted = true;
  setImmediate(() => ctl.abort());
  return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('fixture exchange cancelled')), { once: true }));
 };
 try {
  await assert.rejects(signInWithOpenRouter(async url => {
   const callback = new URL(url).searchParams.get('callback_url'); await realFetch(callback + '?code=fixture-code'); return true;
  }, ctl.signal), /cancelled/);
  assert.equal(exchangeStarted, true); assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
 } finally { global.fetch = realFetch; }
});

test('an unrelated ChatGPT callback does not terminate the active sign-in', async () => {
 const { credential, auth, exchange } = await modernLogin();
 assert.equal(credential.subject, 'fixture-subject'); assert.equal(credential.clientId, 'oaiapp_fixture'); assert.equal(credential.hostId, hostId);
 assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(auth.searchParams.get('agent_name_hint'), 'zer0ne Code');
 assert.equal(auth.searchParams.get('ext_agent_host_id'), hostId); assert.equal(auth.pathname, '/api/accounts/authorize');
 assert.equal(new URL(auth.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
 assert.equal(exchange.redirect_uri, auth.searchParams.get('redirect_uri')); assert.equal(exchange.resource, 'https://api.openai.com/v1');
 assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
});

test('ChatGPT callback timeout rejects instead of leaving the flow waiting forever', async () => {
 const nativeTimer = global.setTimeout;
 global.setTimeout = (fn, ms, ...args) => nativeTimer(fn, ms === 10 * 60_000 ? 5 : ms, ...args);
 const ctl = new AbortController(); let callbackPort;
 try { await assert.rejects(signIn('chatgpt', { hostId, signal: ctl.signal, open: url => { callbackPort = Number(new URL(new URL(url).searchParams.get('redirect_uri')).port); return true; }, onEvent: () => {} }), /timed out/); }
 finally { global.setTimeout = nativeTimer; }
 assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
 assert(callbackPort > 0); const server = await listen(callbackPort); await close(server);
});

test('different refresh credentials with the same suffix never share refreshed tokens', async () => {
 const calls = [];
 global.fetch = async (url, init) => {
  const refresh = new URLSearchParams(init.body).get('refresh_token'); calls.push(refresh);
  await new Promise(resolve => setTimeout(resolve, 5)); return json({ access_token: 'access-' + refresh, refresh_token: refresh, expires_in: 3600 });
 };
 try {
  const one = fixture('account-one-1234567890123456'), two = fixture('account-two-1234567890123456');
  const [a, b, duplicate] = await Promise.all([ensureFresh(one), ensureFresh(two), ensureFresh(one)]);
  assert.equal(calls.length, 2); assert.notEqual(a.access, b.access); assert.strictEqual(a, duplicate);
 } finally { global.fetch = realFetch; }
});

test('invalid account records cannot be interpreted as usable credentials', () => {
 const valid = fixture(); assert.deepEqual(parseCredential(serializeCredential(valid)), valid);
 for (const patch of [{ account: '__proto__' }, { access: '' }, { expires: null }, { refresh: {} }]) assert.equal(parseCredential(serializeCredential({ ...valid, ...patch })), undefined);
});

test('model-list authentication failure is surfaced instead of enabling a fallback catalog', async () => {
 global.fetch = async () => json({}, 403);
 try { await assert.rejects(accountModels(fixture()), /refused access.*403/); }
 finally { global.fetch = realFetch; }
 const ctl = new AbortController(); ctl.abort(); await assert.rejects(accountModels(fixture(), ctl.signal), /cancelled/);
});

test('ChatGPT rejects bad ID-token signature, nonce, issuer, audience, expiry and missing plan scope', async () => {
 for (const [options, error] of [
  [{ badSignature: true }, /signature/],
  [{ claims: { nonce: 'wrong-attempt' } }, /nonce/],
  [{ claims: { iss: 'https://attacker.invalid' } }, /identity/],
  [{ claims: { aud: 'another-client' } }, /audience/],
  [{ claims: { exp: Date.now() / 1000 - 30 } }, /expiry/],
  [{ scope: 'openid profile email offline_access' }, /not authorized/],
  [{ omitClient: true }, /incomplete/],
  [{ clientId: 'dynamic_agent_client' }, /incomplete/]
 ]) await assert.rejects(modernLogin(options), error);
});

test('ChatGPT reauthorization retains the issued client and identity without leaking the ID token to events', async () => {
 const previous = (await modernLogin()).credential;
 const { credential, auth, events } = await modernLogin({ previous, omitClient: true });
 assert.equal(auth.searchParams.get('client_id'), previous.clientId); assert.equal(auth.searchParams.has('agent_name_hint'), false);
 assert.equal(auth.searchParams.get('id_token_hint'), previous.idToken); assert.equal(credential.subject, previous.subject);
 assert(events.every(event => !JSON.stringify(event).includes(previous.idToken)));
 await assert.rejects(modernLogin({ previous, clientId: 'oaiapp_other' }), /different client/);
 await assert.rejects(modernLogin({ previous, claims: { sub: 'another-subject' } }), /another ChatGPT account/);
});

test('ChatGPT renewal uses its issued client, resource grant and rotating credentials', async () => {
 const previous = (await modernLogin()).credential; let fields;
 global.fetch = async (url, init) => {
  assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
  fields = Object.fromEntries(new URLSearchParams(init.body));
  return json({ access_token: 'plan-access-rotated', refresh_token: 'plan-refresh-rotated', token_type: 'Bearer', expires_in: 3600, scope: previous.scopes.join(' ') });
 };
 try {
  const fresh = await ensureFresh({ ...previous, expires: 0 });
  assert.equal(fields.client_id, previous.clientId); assert.equal(fields.resource, 'https://api.openai.com/v1'); assert.equal(fields.scope, undefined);
  assert.equal(fresh.access, 'plan-access-rotated'); assert.equal(fresh.refresh, 'plan-refresh-rotated'); assert.equal(fresh.subject, previous.subject); assert.equal(fresh.idToken, previous.idToken);
 } finally { global.fetch = realFetch; }
});

test('unsupported copied-client OAuth routes explain the official agent or plan-key route', async () => {
 for (const account of ['xai', 'kimi', 'minimax']) await assert.rejects(signIn(account, { hostId, signal: new AbortController().signal, open: () => { throw Error('must not open'); }, onEvent: () => {} }), /official agent or dedicated plan key/);
 await assert.rejects(signIn('chatgpt', { hostId, method: 'device', signal: new AbortController().signal, open: () => { throw Error('must not open'); }, onEvent: () => {} }), /requires browser sign-in/);
});

test('ChatGPT account catalog preserves displayed text-model slugs and never fabricates a list after failure', async () => {
 const cred = (await modernLogin()).credential;
 global.fetch = async () => json({ models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol', visibility: 'list', context_window: 400000, input_modalities: ['text', 'image'], output_modalities: ['text'] },
  { slug: 'gpt-6-astra', visibility: 'hide' }, { slug: 'gpt-4o-audio-preview', visibility: 'list' },
  { id: 'text-embedding-3-small' }, { id: 'gpt-image-1' }, { slug: 'o4-mini', visibility: 'list' }
 ] });
 try {
  const models = await accountModels(cred);
  assert.deepEqual(models.map(model => model.id), ['gpt-6.1-sol', 'o4-mini']); assert.equal(models[0].name, 'GPT 6.1 Sol'); assert.equal(models[0].vision, true); assert.equal(models[0].contextWindow, 400000);
  for (const status of [429, 503]) { global.fetch = async () => json({}, status); await assert.rejects(accountModels(cred), new RegExp('HTTP ' + status)); }
  global.fetch = async () => json({ models: [] }); await assert.rejects(accountModels(cred), /no text models/);
  global.fetch = async () => { throw Error('fixture timeout'); }; await assert.rejects(accountModels(cred), /fixture timeout/);
 } finally { global.fetch = realFetch; }
});

test('a failed modern ChatGPT catalog stops the connection test before inference or forced refresh', async () => {
 const cred = (await modernLogin()).credential; let inference = false;
 global.fetch = async () => json({}, 429);
 try {
  const result = await checkAccount(cred, async () => { inference = true; throw Error('must not run'); }, new AbortController().signal);
  assert.equal(result.ok, false); assert.match(result.steps[0].text, /HTTP 429/); assert.equal(inference, false); assert.equal(result.refreshed, undefined);
 } finally { global.fetch = realFetch; }
});

const planOptions = patch => ({ baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-plan-token', apiFormat: 'responses', chatgptPlan: true, model: 'gpt-6.1-sol', system: 'Fixture', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, maxTokens: 256, ...patch });
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
const completed = { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } };

test('ChatGPT plan requests namespace tools and omit unsupported output caps; generic Responses retain their contract', () => {
 const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
 const plan = codexBody(planOptions({ tools: [tool] }));
 assert.equal(plan.max_output_tokens, undefined); assert.equal(plan.stream, true); assert.equal(plan.store, false);
 assert.equal(plan.tools[0].type, 'namespace'); assert.equal(plan.tools[0].name, 'zer0ne');
 assert.equal(plan.tools[0].tools[0].name, 'read_file'); assert.deepEqual(plan.tools[0].tools[0].parameters, tool.parameters);
 const generic = codexBody(planOptions({ chatgptPlan: false, tools: [tool] }));
 assert.equal(generic.max_output_tokens, 256); assert.equal(generic.tools[0].type, 'function'); assert.equal(generic.tools[0].name, 'read_file');
 const history = [{ role: 'assistant', content: '', toolCalls: [{ id: 'call_one', name: 'read_file', arguments: '{"path":"README.md"}', namespace: 'zer0ne' }] }, { role: 'tool', toolCallId: 'call_one', name: 'read_file', content: 'Fixture text' }];
 const replay = toResponsesInput(history, true); assert.equal(replay[0].namespace, 'zer0ne'); assert.equal(replay[0].name, 'read_file'); assert.equal(replay[1].call_id, 'call_one');
 assert.equal(toResponsesInput(history)[0].namespace, undefined);
 assert.equal(toResponsesInput([{ role: 'assistant', content: '', toolCalls: [{ id: 'call_old', name: 'read_file', arguments: '{}' }] }], true)[0].namespace, 'zer0ne');
});

test('ChatGPT tool streams retain namespace separately from executable names and replay reasoning', async () => {
 let body, endpoint; const emitted = [];
 global.fetch = async (url, init) => {
  body = JSON.parse(init.body); endpoint = String(url);
  return sse([
   { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_read', name: 'read_file', namespace: 'zer0ne', arguments: '' } },
   { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"README.md"}' },
   { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"README.md"}' },
   { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'reason_one', encrypted_content: 'fixture-reasoning', summary: [] } },
   { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_read', name: 'read_file', namespace: 'zer0ne', arguments: '{"path":"README.md"}' } }, completed
  ]);
 };
 try {
  const result = await streamCodex(planOptions({ onToolCall: call => emitted.push(call), tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }] }));
  assert.equal(endpoint, 'https://api.openai.com/v1/responses'); assert.equal(body.max_output_tokens, undefined);
  assert.equal(result.stopReason, 'tool_calls'); assert.equal(result.toolCalls[0].name, 'read_file'); assert.equal(result.toolCalls[0].namespace, 'zer0ne');
  assert.equal(emitted.length, 1); assert.equal(emitted[0].name, 'read_file'); assert.equal(emitted[0].namespace, 'zer0ne');
  const replay = toResponsesInput([{ role: 'assistant', content: '', toolCalls: result.toolCalls }], true);
  assert.equal(replay[0].type, 'reasoning'); assert.equal(replay[1].namespace, 'zer0ne'); assert.equal(replay[1].call_id, 'call_read');
 } finally { global.fetch = realFetch; }
});

test('ChatGPT plan streams reject truncated, failed and incomplete responses after partial text', async () => {
 try {
  for (const [tail, error] of [
   [[], /before response.completed/],
   [[{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }], /did not complete/],
   [[{ type: 'response.failed', response: { error: { message: 'account limit reached' } } }], /ChatGPT: account limit/]
  ]) {
   global.fetch = async () => sse([{ type: 'response.output_text.delta', delta: 'Partial' }, ...tail]);
   await assert.rejects(streamCodex(planOptions()), error);
  }
  global.fetch = async () => sse([{ type: 'response.output_text.delta', delta: 'Complete' }, completed]);
  assert.equal((await streamCodex(planOptions())).text, 'Complete');
  global.fetch = async () => sse([{ type: 'response.output_text.delta', delta: 'Generic response' }]);
  assert.equal((await streamCodex(planOptions({ chatgptPlan: false }))).text, 'Generic response');
 } finally { global.fetch = realFetch; }
});

test('ChatGPT cannot invoke a different tool namespace', async () => {
 let executed = false;
 global.fetch = async () => sse([{ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_other', name: 'read_file', namespace: 'other_app', arguments: '{}' } }, completed]);
 try { await assert.rejects(streamCodex(planOptions({ onToolCall: () => { executed = true; } })), /outside the zer0ne namespace/); assert.equal(executed, false); }
 finally { global.fetch = realFetch; }
});

test('ChatGPT model tests await terminal completion rather than approving the first token', async () => {
 const options = planOptions();
 try {
  global.fetch = async (_url, init) => { assert.equal(JSON.parse(init.body).max_output_tokens, undefined); return sse([{ type: 'response.output_text.delta', delta: 'OK' }]); };
  const failed = await testModel(options); assert.equal(failed.ok, false); assert.match(failed.error, /before response.completed/);
  global.fetch = async () => sse([{ type: 'response.output_text.delta', delta: 'OK' }, completed]);
  assert.equal((await testModel(options)).ok, true);
 } finally { global.fetch = realFetch; }
});

test('ChatGPT connection checks forward the plan contract to inference', async () => {
 const cred = (await modernLogin()).credential; let received;
 global.fetch = async (url, init) => String(url).endsWith('/models') ? json({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }) : json({ access_token: 'rotated', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: cred.scopes.join(' ') });
 try {
  const result = await checkAccount(cred, async options => { received = options; return { text: 'OK', reasoning: '' }; }, new AbortController().signal);
  assert.equal(result.ok, true); assert.equal(received.chatgptPlan, true); assert.equal(received.apiFormat, 'responses'); assert.equal(received.baseUrl, 'https://api.openai.com/v1');
 } finally { global.fetch = realFetch; }
});

test('ChatGPT sign-out revokes its renewable session at the pinned discovery endpoint with bounded retries', async () => {
 const cred = (await modernLogin()).credential; let attempts = 0;
 global.fetch = async (url, init) => {
  assert.equal(init.redirect, 'error');
  if (String(url).endsWith('/openid-configuration')) return json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' });
  assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/revoke'); assert.equal(init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(init.body)), { token: cred.refresh, token_type_hint: 'refresh_token', client_id: cred.clientId });
  attempts++; return attempts < 3 ? json({}, 503) : new Response('', { status: 200 });
 };
 try { const result = await revokeAccount(cred); assert.equal(result.confirmed, true); assert.equal(attempts, 3); assert(!JSON.stringify(result).includes(cred.refresh)); }
 finally { global.fetch = realFetch; }
});

test('ChatGPT sign-out rejects foreign revocation endpoints and reports unconfirmed revocation without token disclosure', async () => {
 const cred = (await modernLogin()).credential;
 try {
  for (const endpoint of ['https://attacker.invalid/revoke', 'http://auth.openai.com/revoke', 'https://user:pass@auth.openai.com/revoke']) {
   let requests = 0; global.fetch = async () => { requests++; return json({ issuer: 'https://auth.openai.com', revocation_endpoint: endpoint }); };
   assert.equal((await revokeAccount(cred)).confirmed, false); assert.equal(requests, 1);
  }
  let attempts = 0;
  global.fetch = async url => String(url).endsWith('/openid-configuration') ? json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/revoke' }) : (++attempts, new Response('', { status: 400 }));
  const denied = await revokeAccount(cred); assert.equal(denied.confirmed, false); assert.equal(attempts, 1); assert.match(denied.message, /not confirmed/);
  assert.equal((await revokeAccount(fixture())).confirmed, false);
  const ctl = new AbortController(); ctl.abort(); global.fetch = () => { throw Error('must not request'); }; assert.equal((await revokeAccount(cred, ctl.signal)).confirmed, false);
 } finally { global.fetch = realFetch; }
});

(async () => {
 let failed = 0;
 for (const [name, run] of tests) { try { await run(); console.log('PASS ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } }
 console.log(`${tests.length - failed}/${tests.length} subscription OAuth checks passed.`); process.exitCode = failed ? 1 : 0;
})();
