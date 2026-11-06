'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), path = require('path'), vm = require('vm');
const out = path.resolve(process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out'));
const { LocalHostServer, newKey, routeFor, browserPortAllowed } = require(path.join(out, 'localHostServer'));
const { benchmarkModel } = require(path.join(out, 'localBench'));
const listen = async fn => { const server = http.createServer(fn); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server; };
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const tests = [], test = (name, run) => tests.push([name, run]);

test('native protocols preserve messages, images, tools, headers, SSE events, token counts and upstream errors', async () => {
 const seen = [], activity = [], loads = [], key = newKey();
 const events = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
 const upstream = await listen((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
   const body = JSON.parse(raw); seen.push({ url: req.url, headers: req.headers, body });
   if (body.fail) { res.writeHead(400, { 'Content-Type': 'application/json', 'Retry-After': '7', 'X-Request-Id': 'context-fixture' }); return res.end('{"type":"error","error":{"type":"context_exceeded","message":"too many tokens"}}'); }
   if (req.url.includes('tokens')) { res.setHeader('Content-Type', 'application/json'); return res.end('{"input_tokens":26123}'); }
   if (body.stream) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(events.slice(0, 23)); return setTimeout(() => res.end(events.slice(23)), 10); }
   res.setHeader('Content-Type', 'application/json'); res.end('{"id":"response-fixture","output":[{"type":"function_call","arguments":"{}"}]}');
  });
 });
 let loaded;
 const host = new LocalHostServer({ models: async () => ({ engine: ['same'], ollama: ['same'] }), loadedEngine: () => loaded,
  ensureEngine: async model => { loads.push(model); loaded = { model, context: 12288 }; return upstream.address().port; }, ollamaBase: () => `http://127.0.0.1:${upstream.address().port}/v1`, embedPort: async () => undefined, onActivity: e => activity.push(e) });
 await host.start({ enabled: true, port: 0, lan: false, key });
 const base = `http://127.0.0.1:${host.server.address().port}`;
 const headers = { 'x-api-key': key, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'fixture-beta', 'OpenAI-Beta': 'fixture-responses', Accept: 'text/event-stream' };
 const ask = (route, body, h = headers) => fetch(base + route, { method: 'POST', headers: h, body: JSON.stringify(body) });
 try {
  assert.equal((await (await fetch(base + '/health')).json()).hasModel, undefined, 'health needs the key like every other route');
  assert.equal((await (await fetch(base + '/health', { headers })).json()).hasModel, false);
  for (const route of ['/v1/responses', '/v1/messages', '/v1/messages/count_tokens', '/v1/responses/input_tokens', '/v1/chat/completions/input_tokens']) {
   assert.equal((await ask(route, { model: 'engine/same' }, { 'Content-Type': 'application/json' })).status, 401);
  }
  const body = { model: 'engine/same', stream: true, system: [{ type: 'text', text: 'Keep everything.' }], max_tokens: 400,
   messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_file', input: { path: 'src/server.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'file text' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture' } }] }],
   tools: [{ name: 'read_file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }] };
  const streamed = await ask('/v1/v1/messages/', body); assert.equal(await streamed.text(), events);
  assert.deepEqual(seen.at(-1).body, { ...body, model: 'same' }); assert.equal(seen.at(-1).url, '/v1/messages');
  assert.equal(seen.at(-1).headers['anthropic-version'], headers['anthropic-version']); assert.equal(seen.at(-1).headers['anthropic-beta'], 'fixture-beta');
  assert.equal(seen.at(-1).headers['openai-beta'], 'fixture-responses'); assert.equal(seen.at(-1).headers.accept, 'text/event-stream');
  assert.equal(seen.at(-1).headers.authorization, undefined); assert.equal(seen.at(-1).headers['x-api-key'], undefined);
  const responses = { model: 'engine/same', instructions: 'A fixture', input: [{ type: 'function_call_output', call_id: 't', output: 'full result' }], tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }], store: false };
  assert.equal((await (await ask('/responses', responses, { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' })).json()).id, 'response-fixture');
  assert.deepEqual(seen.at(-1).body, { ...responses, model: 'same' }); assert.equal(seen.at(-1).url, '/v1/responses');
  for (const route of ['/messages/count_tokens', '/v1/responses/input_tokens', '/v1/chat/completions/input_tokens']) {
   assert.deepEqual(await (await ask(route, { model: 'engine/same', messages: body.messages, tools: body.tools })).json(), { input_tokens: 26123 });
   assert.equal(seen.at(-1).url, route.startsWith('/v1/') ? route : '/v1' + route);
  }
  const failed = await ask('/v1/messages', { model: 'engine/same', fail: true }); assert.equal(failed.status, 400);
  assert.equal(failed.headers.get('retry-after'), '7'); assert.equal(failed.headers.get('x-request-id'), 'context-fixture');
  assert.equal((await failed.json()).error.type, 'context_exceeded');
  await new Promise(r => setTimeout(r, 10)); assert.equal(activity.at(-1).ok, false);
  const status = await (await fetch(base + '/v1/status', { headers })).json(); assert.equal(status.engineContextTokens, 12288); assert.equal(status.engineModel, 'same');
  assert.equal((await (await fetch(base + '/health', { headers })).json()).engineContextTokens, 12288);
  const count = seen.length;
  const unsupported = await ask('/v1/messages', { model: 'ollama/same' }); assert.equal(unsupported.status, 501); assert.equal((await unsupported.json()).type, 'error'); assert.equal(seen.length, count);
  for (const body of [null, [], { model: 10 }]) { const invalid = await ask('/messages', body); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).type, 'error'); }
  assert.equal(routeFor('/v1/v1/responses', 'POST'), 'responses'); assert.equal(routeFor('/v1/responses', 'GET'), undefined); assert.equal(routeFor('/v10/messages', 'POST'), undefined);
  assert.equal(loads.length, count);
 } finally { await host.stop(); await close(upstream); }
});

test('interrupted native streams remain failed streams instead of successful partial responses', async () => {
 const upstream = await listen((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: response.output_text.delta\ndata: {"delta":"partial"}\n\n'); setTimeout(() => res.destroy(), 30); }); });
 const activity = [], key = newKey();
 const host = new LocalHostServer({ models: async () => ({ engine: ['a'], ollama: [] }), ensureEngine: async () => upstream.address().port, ollamaBase: () => '', embedPort: async () => undefined, onActivity: e => activity.push(e) });
 await host.start({ enabled: true, port: 0, lan: false, key });
 try {
  const response = await fetch(`http://127.0.0.1:${host.server.address().port}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{"model":"a","stream":true}' });
  await assert.rejects(() => response.text()); await new Promise(r => setTimeout(r, 10)); assert.equal(activity.at(-1).ok, false); assert.equal(host.active, 0);
 } finally { await host.stop(); await close(upstream); }
});

test('browser-blocked ports are refused without stopping a serving router or saving invalid settings', async () => {
 const key = newKey(), host = new LocalHostServer({ models: async () => ({ engine: [], ollama: [] }), ensureEngine: async () => 0, ollamaBase: () => '', embedPort: async () => undefined, onActivity() {} });
 await host.start({ enabled: true, port: 0, lan: false, key });
 try {
  for (const port of [6000, 6667, 10080, -1, 65536, 1.5]) { assert.equal(browserPortAllowed(port), false); await assert.rejects(() => host.start({ enabled: true, port, lan: false, key }), /browser clients/); assert(host.listening); }
  assert(browserPortAllowed(11435));
  const { LocalPlus } = require(path.join(out, 'host/localPlus')); let saves = 0, posts = 0, notice;
  const plus = Object.assign(Object.create(LocalPlus.prototype), { d: { ctx: { status: text => notice = text } }, saveHost: async () => saves++, post: () => posts++ });
  await plus.handle({}, { type: 'localHostSet', patch: { port: 6000 } }); assert.equal(saves, 0); assert.equal(posts, 1); assert.match(notice, /browser clients/);
 } finally { await host.stop(); }
});

test('router UI exposes separate client URLs, engine-only APIs and actual loaded context safely', () => {
 const ts = require('typescript-classic'), { JSDOM } = require('jsdom'), source = fs.readFileSync(path.join(out, '../media/settings.js'), 'utf8');
 const ast = ts.createSourceFile('settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); let code;
 const visit = node => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'localHostCard') code = node.getText(ast); ts.forEachChild(node, visit); }; visit(ast);
 const dom = new JSDOM(''), S = { localPlus: { host: { enabled: true, running: true, port: 11435, key: 'fixture', models: ['a'], activity: [], loaded: { model: '<unsafe>', context: 12288 } } } };
 const context = { S, I: () => '', ctxLabel: n => n / 1024 + 'K', esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') };
 vm.createContext(context); vm.runInContext(code, context);
 try {
  const root = dom.window.document.createElement('div'); root.innerHTML = context.localHostCard();
  assert(root.textContent.includes('12K actual context')); assert(root.textContent.includes('Responses')); assert(root.textContent.includes('Anthropic URL')); assert(!root.querySelector('unsafe'));
  const copies = [...root.querySelectorAll('[data-copy]')].map(n => n.dataset.copy); assert(copies.includes('http://127.0.0.1:11435/v1')); assert(copies.includes('http://127.0.0.1:11435'));
  assert(copies.some(s => s.startsWith('ANTHROPIC_BASE_URL=http://127.0.0.1:11435\n')));
  S.localPlus.host.loaded = undefined; assert(context.localHostCard().includes('No engine model loaded'));
 } finally { dom.window.close(); }
});

test('agent benchmarks reject wrong paths, ineffective edits, argument arrays and malformed restraint calls', async () => {
 let variant = 'good';
 const upstream = await listen((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
   const body = JSON.parse(raw), prompt = body.messages.at(-1).content;
   const call = (name, args) => ({ content: null, tool_calls: [{ function: { name, arguments: args } }] });
   let message = { content: 'The requested resource was not found.' };
   if (body.tools && prompt.includes('server.ts')) message = call('read_file', JSON.stringify({ path: variant === 'wrong-path' ? 'other/server.ts' : 'src/server.ts' }));
   if (body.tools && prompt.includes('8080')) message = call('edit_file', JSON.stringify({ path: 'src/config.ts', old_string: 'const PORT = 3000;', new_string: variant === 'bad-edit' ? 'const PORT = 3000; // use 8080' : 'const PORT = 8080;' }));
   if (body.tools && prompt.includes('404') && variant !== 'good') message = call('grep', variant === 'array' ? '[]' : 'broken-json');
   res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message }], timings: { predicted_per_second: 20 } }));
  });
 });
 try {
  for (variant of ['good', 'wrong-path', 'bad-edit', 'array', 'invalid-json']) {
   const result = await benchmarkModel(`http://127.0.0.1:${upstream.address().port}/v1`, 'fixture');
   const checks = Object.fromEntries(result.checks.map(c => [c.id, c.ok]));
   assert.equal(checks.tool_pick, variant !== 'wrong-path'); assert.equal(checks.tool_args, variant !== 'bad-edit');
   assert.equal(checks.json, variant === 'good'); assert.equal(checks.restraint, variant === 'good');
   if (variant === 'good') assert.equal(result.score, 100);
  }
 } finally { await close(upstream); }
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } } process.exitCode = failed ? 1 : 0; })().catch(e => { console.error(e); process.exitCode = 1; });
