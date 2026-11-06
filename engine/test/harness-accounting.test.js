'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createShim, install } = require('./vscode-shim');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-harness-accounting-'));
const shim = createShim({ dataDir: temp });
install(shim.vscode);
const { openaiUsage, anthropicUsage, geminiUsage, priceUsage, usageSource } = require('../out/usage');
const { serializedRequest } = require('../out/requestDiagnostics');
const { streamChat, anthropicAccumulator } = require('../out/chatClient');
const { TranscriptStore } = require('../out/transcript');
const { ProviderStore, DEFAULT_SETTINGS } = require('../out/providerStore');
const { UsageStats } = require('../out/host/usageStats');
const { buildToolContext } = require('../out/host/toolContext');
const { usageCost } = require('../out/host/turnHelpers');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Messages usage merges partial cumulative samples, preserves write tiers and authoritative zero', () => {
	const a = anthropicAccumulator({});
	a.handle({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 80,
		cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 } } } });
	a.handle({ type: 'message_delta', usage: { output_tokens: 0 } });
	const u = a.result().usage;
	assert.equal(u.input, 120); assert.equal(u.output, 0);
	assert.equal(u.uncached, 10); assert.equal(u.cached, 80);
	assert.equal(u.cacheWrite, 30); assert.equal(u.cacheWrite5m, 20); assert.equal(u.cacheWrite1h, 10);
	assert.equal(u.raw.input_tokens, 10);
	assert.equal(priceUsage({ priceIn: 2, priceOut: 8, priceCacheRead: 0.2, priceCacheWrite: 2.5, priceCacheWrite1h: 4 }, u), 126 / 1e6);
	assert.equal(priceUsage({ priceIn: 2, priceOut: 8, priceCacheRead: 0.2, priceCacheWrite: 2.5 }, u), undefined);
	assert.equal(usageSource(anthropicUsage({ output_tokens: 0 })), 'partial');
});

test('compatible usage uses a reconciled alternate breakdown, retains absent fields and never double-bills reasoning', () => {
	const u = openaiUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 },
		prompt_cache_hit_tokens: 90, prompt_cache_miss_tokens: 10, completion_tokens_details: { reasoning_tokens: 12 } });
	assert.equal(u.cached, 90); assert.equal(u.uncached, 10); assert.equal(u.reasoning, 12);
	assert.equal(priceUsage({ priceIn: 2, priceOut: 8, priceCacheRead: 0.2 }, u), 198 / 1e6);
	assert.equal(usageCost({}, 100, 20, 90), undefined);
	assert.equal(usageCost({ priceIn: 2, priceOut: 8 }, 100, 20, 110), undefined);
	const next = openaiUsage({ completion_tokens: 0 }, u);
	assert.equal(next.input, 100); assert.equal(next.output, 0);
	assert.equal(openaiUsage({ prompt_tokens: 0, completion_tokens: 0 }).cached, undefined);
	assert.equal(usageSource(openaiUsage({ prompt_tokens: -1, completion_tokens: 5 })), 'partial');
	assert.equal(usageSource(openaiUsage({ prompt_tokens: 10, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 2 } })), 'partial');
	assert.equal(usageSource(openaiUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 9, prompt_cache_miss_tokens: 9 })), 'partial');
	const early = openaiUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 90 } });
	assert.equal(usageSource(early), 'partial');
	const final = openaiUsage({ prompt_tokens: 100, completion_tokens: 20 }, early);
	assert.equal(final.cached, 90); assert.equal(usageSource(final), 'provider', 'late totals can reconcile initial cache counts');
});

test('native usage keeps cumulative prompt/cache/thought counts through late output updates', () => {
	const first = geminiUsage({ promptTokenCount: 100, candidatesTokenCount: 4, thoughtsTokenCount: 3, cachedContentTokenCount: 80 });
	const last = geminiUsage({ candidatesTokenCount: 0 }, first);
	assert.equal(last.input, 100); assert.equal(last.cached, 80); assert.equal(last.output, 3); assert.equal(last.reasoning, 3);
	assert.equal(last.raw.candidatesTokenCount, 0);
	assert.equal(usageSource(geminiUsage({ promptTokenCount: 1, candidatesTokenCount: 0, cachedContentTokenCount: 2 })), 'partial');
});

test('serialized diagnostics distinguish append-only history from changed IDs, tools and routes without retaining content', () => {
	const scope = randomUUID();
	const body = { model: 'm', system: [{ type: 'text', text: 'private prompt', cache_control: { type: 'ephemeral' } }],
		tools: [{ name: 'read', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'private input' }] };
	const first = serializedRequest('https://api.example/v1/messages?key=secret', body, scope);
	assert.equal(first.prefixStable, undefined);
	const next = { ...body, system: [{ ...body.system[0], cache_control: { type: 'ephemeral', ttl: '1h' } }],
		messages: [...body.messages, { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read', input: {} }] }] };
	assert.equal(serializedRequest('https://api.example/v1/messages?key=secret', next, scope).prefixStable, true);
	next.messages[1].content[0].id = 'b';
	assert.equal(serializedRequest('https://api.example/v1/messages', next, scope).changed, 'history message 2');
	next.tools = [];
	assert.equal(serializedRequest('https://api.example/v1/messages', next, scope).changed, 'tools');
	assert.equal(serializedRequest('https://other.example/v1/messages', next, scope).changed, 'route');
	assert.doesNotMatch(JSON.stringify(first), /private prompt|private input|secret|api\.example/);
});

test('deferred MCP accounting measures only exposed definitions, is nonnegative and reconciles exactly', () => {
	const defs = Array.from({ length: 12 }, (_, i) => ({ name: `mcp__fixture__read_${i}`, description: 'large schema '.repeat(2000), parameters: { type: 'object' } }));
	for (const deferTools of [true, false]) {
		const result = buildToolContext({ ...DEFAULT_SETTINGS, mcp: true, deferTools }, false, true,
			{ mcpDefs: () => defs, agentDefs: () => [], skillCatalogChars: () => 0 });
		assert.ok(result.chars.mcp >= 0 && result.chars.tools >= 0);
		assert.equal(result.chars.mcp + result.chars.tools, JSON.stringify(result.tools).length);
		if (deferTools) assert.equal(result.chars.mcp, 0);
	}
	assert.equal(buildToolContext(DEFAULT_SETTINGS, false, false, { mcpDefs: () => defs, agentDefs: () => [], skillCatalogChars: () => 0 }).chars.mcp, 0);
});

test('transcript recovery preserves the valid backup and failed publication leaves the previous primary intact', () => {
	const notices = [];
	const dir = path.join(temp, 'transcripts');
	const store = new TranscriptStore(dir, (notice) => notices.push(notice));
	const file = path.join(dir, 's.json');
	const first = { v: 1, entries: [{ role: 'user', content: 'first' }], marks: { u: 0 }, reads: {} };
	const second = { ...first, entries: [...first.entries, { role: 'assistant', content: 'second' }] };
	store.save('s', first); store.save('s', second);
	assert.deepEqual(store.load('s'), second);
	fs.writeFileSync(file, '{truncated');
	assert.deepEqual(store.load('s'), first);
	assert.equal(notices.at(-1).kind, 'recovered');
	store.save('s', second);
	assert.equal(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).entries[0].content, 'first');
	assert.ok(fs.readdirSync(dir).some((n) => n.includes('.corrupt-')));
	const rename = fs.renameSync;
	fs.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return rename(from, to); };
	try { assert.throws(() => store.save('s', first), /locked/); } finally { fs.renameSync = rename; }
	assert.deepEqual(store.load('s'), second);
	assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')));
	fs.writeFileSync(file, JSON.stringify({ v: 2, entries: [] }));
	assert.equal(store.load('s'), undefined);
	assert.throws(() => store.save('s', first), /Unsupported transcript version/);
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
	store.remove('s'); assert.equal(store.load('s'), undefined);
	assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith('s.json')));
});

test('attempt IDs replace earlier samples, price snapshots survive catalog changes and missing usage stays unknown', async () => {
	const store = new ProviderStore(shim.context(path.join(__dirname, '..')));
	let rate = 2;
	const provider = { id: 'harness-fixture', name: 'fixture', apiFormat: 'openai', baseUrl: 'https://api.example/v1', models: [{ id: 'm', smart: true }], enabled: true };
	await store.add(provider);
	const session = await store.createBackgroundSession('Accounting fixture');
	const stats = new UsageStats({ store, catalog: { lookup: async () => ({ priceIn: rate, priceOut: 8, priceCacheRead: 0.2 }) } });
	const a = { id: randomUUID(), providerId: provider.id, model: 'm', format: 'openai', startedAt: Date.now(), durationMs: 10, outcome: 'completed',
		sessionId: session.id, turnId: 'turn', purpose: 'main', usage: openaiUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 90 } }) };
	await stats.recordAttempt(provider, a); await stats.recordAttempt(provider, a);
	assert.equal(store.getUsageEvents().filter((e) => e.attemptId === a.id).length, 1);
	rate = 200;
	await stats.recordAttempt(provider, { ...a, prices: undefined, priceVersion: undefined });
	const unknown = { ...a, id: randomUUID(), usage: undefined, outcome: 'failed', purpose: 'child', parentTurnId: 'turn' };
	await stats.recordAttempt(provider, unknown);
	const data = await stats.usageData(7);
	const row = data.models.find((r) => r.providerId === provider.id);
	assert.equal(row.cost, 198 / 1e6); assert.equal(row.unknownUsage, 1); assert.equal(row.unknownCost, 1);
	assert.equal(data.totals.costCoverage.unknown, 1);
	assert.equal(unknown.cost, undefined);
	await store.saveMessages(session.id, [{ id: 'turn', role: 'user', content: 'private input', turn: { startedAt: a.startedAt, toolTimings: [{ callId: 'read-1', name: 'read_file', step: 0, startedAt: a.startedAt, durationMs: 12, outcome: 'completed' }] } }]);
	const csv = await stats.requestsCsv(7);
	assert.match(csv, /First text ms/); assert.match(csv, /Raw usage JSON/); assert.match(csv, /"child"/);
	assert.match(csv, /read_file/); assert.doesNotMatch(csv, /private input/);
});

test('HTTP retries have distinct attempts and partial stream errors retain usage as incomplete', async () => {
	const observed = [];
	const server = http.createServer((req, res) => {
		let json = ''; req.on('data', (chunk) => { json += chunk; });
		req.on('end', () => {
			const body = JSON.parse(json);
			if (body.model === 'strict-audit' && body.stream_options) { res.writeHead(422); res.end('{"message":"Extra inputs are not permitted: stream_options"}'); return; }
			res.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'fixture-request' });
			if (body.model === 'partial-audit') {
				res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } } }) + '\n\n');
				res.end('data: ' + JSON.stringify({ error: { message: 'interrupted' } }) + '\n\n'); return;
			}
			if (body.model === 'cancel-audit') {
				res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 }, choices: [{ delta: { content: 'started' } }] }) + '\n\n');
				return;
			}
			res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) + '\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'private-key', apiFormat: 'openai', model: 'strict-audit', system: 'private-system',
		messages: [{ role: 'user', content: 'private-message' }], signal: new AbortController().signal,
		requestContext: { sessionId: 'http-fixture', turnId: 'turn', purpose: 'main' }, onAttempt: (attempt) => observed.push(attempt) };
	try {
		const result = await streamChat(options);
		assert.equal(result.attempts.length, 2); assert.equal(observed.length, 2);
		assert.notEqual(observed[0].id, observed[1].id);
		assert.equal(observed[0].status, 422); assert.equal(observed[0].outcome, 'failed');
		assert.equal(observed[1].usage.input, 0); assert.ok(observed[1].firstTextMs >= 0);
		assert.doesNotMatch(JSON.stringify(observed), /private-key|private-system|private-message/);
		await assert.rejects(streamChat({ ...options, model: 'partial-audit' }), /interrupted/);
		const partial = observed.at(-1);
		assert.equal(partial.outcome, 'failed'); assert.equal(partial.usage.input, 100);
		assert.equal(usageSource(partial.usage), 'partial');
		const cancel = new AbortController();
		await assert.rejects(streamChat({ ...options, model: 'cancel-audit', signal: cancel.signal, onText: () => cancel.abort() }));
		assert.equal(observed.at(-1).outcome, 'cancelled');
		assert.equal(usageSource(observed.at(-1).usage), 'partial');
	} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('host retries, fallback, pool-key changes and writer calls retain their actual route and lineage', async () => {
	const { ChatController } = require('../out/chatController');
	const { ModelCaller } = require('../out/host/modelCaller');
	const { runCore } = require('../out/core/loop');
	const store = new ProviderStore(shim.context(path.join(__dirname, '..')));
	const server = http.createServer((req, res) => {
		let text = ''; req.on('data', (chunk) => { text += chunk; });
		req.on('end', () => {
			const body = JSON.parse(text);
			if (body.model === 'fallback-primary') { res.writeHead(503, { 'Retry-After': '0' }); res.end('overloaded'); return; }
			if (body.model === 'key-audit' && req.headers.authorization.includes('1111')) { res.writeHead(401); res.end('rejected key'); return; }
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 0 } }) + '\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const baseUrl = `http://127.0.0.1:${server.address().port}`;
		const p = await store.add({ name: 'primary', baseUrl, apiFormat: 'openai', models: [{ id: 'fallback-primary', smart: true }, { id: 'key-audit', smart: true }] });
		const q = await store.add({ name: 'backup', baseUrl, apiFormat: 'openai', models: [{ id: 'fallback-backup', smart: true }] });
		await store.setApiKey(p.id, 'first-key-1111,second-key-2222'); await store.setApiKey(q.id, 'backup-key');
		const stats = new UsageStats({ store, catalog: { lookup: async (model) => ({ priceIn: model === 'fallback-backup' ? 9 : 2, priceOut: 8 }) } });
		const host = Object.create(ChatController.prototype);
		Object.assign(host, { store, usage: stats, taskBudgets: new (require('../out/core/taskBudget').TaskBudgets)(), tools: { scheduler: new (require('../out/core/toolScheduler').ToolScheduler)() }, sessionId: 'routing-fixture', status() {} });
		const caller = new ModelCaller({ store, status() {}, callModel: (provider, key, options) => host.callModel(provider, key, options) }, 1000);
		const signal = new AbortController().signal;
		const turnId = randomUUID();
		const build = ({ model }) => ({ model, system: 'private route test', messages: [{ role: 'user', content: 'private input' }], signal,
			requestContext: { sessionId: 'routing-fixture', turnId, purpose: 'main' } });
		const active = { provider: p, model: p.models[0], apiKey: await store.getApiKey(p.id) };
		await caller.callResilient(active, { ...DEFAULT_SETTINGS, retryErrors: true, offlineFallback: false, fallbackModels: `${q.id}::fallback-backup` }, signal, { text: '', reasoning: '' }, build);
		const events = store.getUsageEvents().filter((e) => e.turnId === turnId);
		assert.equal(events.length, 4); assert.equal(new Set(events.map((e) => e.attemptId)).size, 4);
		assert.ok(events.slice(0, 3).every((e) => e.providerId === p.id && e.model === 'fallback-primary' && e.usageSource === 'unknown'));
		assert.equal(events[3].providerId, q.id); assert.equal(events[3].model, 'fallback-backup'); assert.equal(events[3].cost, 90 / 1e6);
		assert.equal(active.provider.id, q.id);
		const keyTurn = randomUUID();
		await caller.callResilient({ provider: p, model: p.models[1], apiKey: await store.getApiKey(p.id) }, { ...DEFAULT_SETTINGS, retryErrors: true, noModelFallback: true }, signal, { text: '', reasoning: '' }, (o) => ({ ...build(o), requestContext: { turnId: keyTurn, purpose: 'main' } }));
		assert.deepEqual(store.getUsageEvents().filter((e) => e.turnId === keyTurn).map((e) => e.keyIndex), [0, 1]);
		await runCore({ provider: { baseUrl, apiKey: 'backup-key', apiFormat: 'openai', model: 'fallback-backup' }, system: 'writer fixture', tools: { root: temp, defs: () => [] }, messages: [{ role: 'user', content: 'private writer input' }], signal,
			requestContext: { sessionId: 'routing-fixture', parentTurnId: turnId, taskId: 'writer-fixture', purpose: 'child' }, callModel: (options) => host.callModel(q, 'backup-key', options) });
		const writer = store.getUsageEvents().find((e) => e.request?.taskId === 'writer-fixture');
		assert.equal(writer.providerId, q.id); assert.equal(writer.parentTurnId, turnId); assert.equal(writer.purpose, 'child'); assert.equal(writer.request.step, 0);
		assert.doesNotMatch(await stats.requestsCsv(7), /private route test|private writer input|first-key|backup-key/);
	} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

(async () => {
	for (const [name, fn] of tests) { await fn(); console.log('ok  ' + name); }
	console.log('Harness accounting and recovery tests passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
