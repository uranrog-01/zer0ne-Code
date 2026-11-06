'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) { return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: { env: { appHost: 'desktop' }, workspace: {} } };
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { ProviderStore } = require(path.join(OUT, 'providerStore'));
const { ProvidersHost } = require(path.join(OUT, 'host/providersHost'));
const { sharedGlobalMemento } = require('../../host/storage');

function fixture(t, catalog = {}) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-provider-safety-'));
	t.after(() => {
		assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
		assert(path.basename(folder).startsWith('zc-provider-safety-'));
		fs.rmSync(folder, { recursive: true, force: true });
	});
	const secrets = new Map();
	const context = { globalState: sharedGlobalMemento(path.join(folder, 'state.json')), secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } } };
	const store = new ProviderStore(context);
	const events = [];
	const surface = { kind: 'chat', post: message => events.push(message) };
	const host = new ProvidersHost({ store, status() {}, sendState: async () => {} }, { lookup: async () => undefined, all: async () => [], ...catalog });
	return { store, host, surface, context, events };
}
const models = [{ id: 'one', enabled: true, smart: false, maxOutput: 4096 }, { id: 'two', enabled: true, smart: false }];
const provider = store => store.add({ name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiFormat: 'openai', models });
const json = data => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('saving a key after a keyless URL edit rejects public HTTP before storage or network access', async t => {
	const { store, host, surface } = fixture(t);
	const p = await provider(store);
	await host.handle(surface, { type: 'updateProvider', id: p.id, patch: { baseUrl: 'http://api.fixture.invalid/v1' } });
	let requests = 0;
	const original = global.fetch;
	global.fetch = async () => { requests++; return json([]); };
	try {
		await assert.rejects(host.handle(surface, { type: 'setApiKey', id: p.id, apiKey: 'fixture-only-key' }), /unencrypted/);
		assert.equal(await store.hasApiKey(p.id), false);
		assert.equal(requests, 0);
	} finally { global.fetch = original; }
});

test('a concurrent key save and URL edit cannot leave a key on a public HTTP endpoint', async t => {
	const { store } = fixture(t);
	for (const keyFirst of [true, false]) {
		const p = await provider(store);
		const key = () => store.setApiKey(p.id, 'fixture-only-key');
		const url = () => store.update(p.id, { baseUrl: 'http://api.fixture.invalid/v1' });
		const results = await Promise.allSettled(keyFirst ? [key(), url()] : [url(), key()]);
		assert(results.some(r => r.status === 'rejected' && /unencrypted/.test(r.reason.message)));
		assert(!await store.hasApiKey(p.id) || (await store.get(p.id)).baseUrl.startsWith('https:'));
	}
});

test('subscription copies require their own sign-in and retain no borrowed access or refresh token', async t => {
	const { store, host, surface, events } = fixture(t);
	const p = await store.add({ name: 'Subscription', auth: 'account', preset: 'chatgpt-account', apiFormat: 'responses', baseUrl: 'https://fixture.invalid/v1', models });
	const credential = { kind: 'account', account: 'chatgpt', access: 'fixture-only-access', refresh: 'fixture-only-refresh', expires: Date.now() + 3600000 };
	await store.setAccount(p.id, credential);
	await host.handle(surface, { type: 'duplicateProvider', id: p.id });
	const copy = await store.get(events.find(e => e.type === 'focusProvider').id);
	assert.equal(copy.auth, 'account');
	assert.equal(copy.enabled, false);
	assert.equal(copy.health.signIn, true);
	assert.equal(await store.hasApiKey(copy.id), false);
	assert.equal(await store.getAccountCredential(copy.id), undefined);
	assert.deepEqual(await store.getAccountCredential(p.id), credential);
	assert.deepEqual(copy.models, (await store.get(p.id)).models);
});

test('API provider copies retain the entire key pool with independent rotation', async t => {
	const { store } = fixture(t);
	const p = await provider(store);
	await store.setApiKey(p.id, 'fixture-one, fixture-two\nfixture-three');
	await store.rotateKey(p.id);
	const copy = await store.duplicate(p.id);
	assert.equal(await store.keyCount(copy.id), 3);
	assert.equal(await store.getApiKey(copy.id), 'fixture-one');
	assert.equal(await store.getApiKey(p.id), 'fixture-two');
	await store.rotateKey(copy.id);
	await store.rotateKey(copy.id);
	assert.equal(await store.getApiKey(copy.id), 'fixture-three');
	assert.equal(await store.getApiKey(p.id), 'fixture-two');
});

test('automatic model fetching preserves edits and deletions made while the endpoint is pending', async t => {
	const { store, host, surface } = fixture(t);
	const p = await provider(store);
	const started = deferred(), response = deferred();
	const original = global.fetch;
	global.fetch = async () => { started.resolve(); return response.promise; };
	try {
		const fetching = host.handle(surface, { type: 'setApiKey', id: p.id, apiKey: 'fixture-only-key' });
		await started.promise;
		await host.handle(surface, { type: 'saveModel', id: p.id, originalId: 'one', model: { ...models[0], enabled: false, maxOutput: 1024 } });
		await host.handle(surface, { type: 'deleteModel', id: p.id, modelId: 'two' });
		response.resolve(json([{ id: 'one' }, { id: 'two' }, { id: 'new' }]));
		await fetching;
		const current = (await store.get(p.id)).models;
		assert.deepEqual(current.map(m => m.id), ['one', 'new']);
		assert.equal(current[0].enabled, false);
		assert.equal(current[0].maxOutput, 1024);
	} finally { global.fetch = original; }
});

test('a model list from a previous endpoint cannot populate the edited provider', async t => {
	const { store, host, surface } = fixture(t);
	const p = await provider(store);
	const started = deferred(), response = deferred();
	const original = global.fetch;
	global.fetch = async () => { started.resolve(); return response.promise; };
	try {
		const fetching = host.handle(surface, { type: 'setApiKey', id: p.id, apiKey: 'fixture-only-key' });
		await started.promise;
		await store.update(p.id, { baseUrl: 'https://other.fixture.invalid/v1' });
		response.resolve(json([{ id: 'old-endpoint-model' }]));
		await fetching;
		assert.deepEqual((await store.get(p.id)).models.map(m => m.id), ['one', 'two']);
	} finally { global.fetch = original; }
});

test('concurrent model toggles and additions preserve every operation on desktop storage', async t => {
	const { store, host, surface } = fixture(t);
	const p = await provider(store);
	await Promise.all(models.map(m => host.handle(surface, { type: 'toggleModel', id: p.id, modelId: m.id, enabled: false })));
	assert.deepEqual((await store.get(p.id)).models.map(m => m.enabled), [false, false]);
	await Promise.all(['three', 'four'].map(id => store.upsertModel(p.id, { id, enabled: true, smart: false })));
	assert.deepEqual((await store.get(p.id)).models.map(m => m.id), ['one', 'two', 'three', 'four']);
	await Promise.all([
		host.handle(surface, { type: 'setModelsEnabled', id: p.id, ids: ['three'], enabled: false }),
		store.removeModel(p.id, 'four')
	]);
	assert.deepEqual((await store.get(p.id)).models.map(m => [m.id, m.enabled]), [['one', false], ['two', false], ['three', false]]);
});

test('provider stores sharing one memento share the mutation queue and recover after a rejected edit', async t => {
	const { store, context } = fixture(t);
	const other = new ProviderStore(context);
	const p = await provider(store);
	await Promise.all([
		store.update(p.id, current => ({ models: current.models.map(m => m.id === 'one' ? { ...m, enabled: false } : m) })),
		other.update(p.id, current => ({ models: current.models.map(m => m.id === 'two' ? { ...m, enabled: false } : m) }))
	]);
	assert.deepEqual((await store.get(p.id)).models.map(m => m.enabled), [false, false]);
	await assert.rejects(store.update(p.id, { name: '' }), /cannot be empty/);
	await other.update(p.id, { name: 'Still works' });
	assert.equal((await store.get(p.id)).name, 'Still works');
});

test('catalog refresh preserves a manual edit made while the catalog request is pending', async t => {
	const started = deferred(), catalog = deferred();
	const { store, host, surface } = fixture(t, { all: async () => { started.resolve(); return catalog.promise; }, lookup: async () => ({ id: 'one', maxOutput: 8192 }) });
	const p = await provider(store);
	const refreshing = host.handle(surface, { type: 'refreshModelInfo', id: p.id });
	await started.promise;
	await store.upsertModel(p.id, { ...models[0], smart: true, maxOutput: 1024, manualFields: ['maxOutput'] });
	catalog.resolve([]);
	await refreshing;
	assert.equal((await store.get(p.id)).models[0].maxOutput, 1024);
});
