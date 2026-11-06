// Usage accounting, drilldowns, CSV export, and notification behavior without network calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createShim, install } = require('./vscode-shim');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-usage-test-'));
const shim = createShim({ dataDir: temp });
install(shim.vscode);
const { UsageStats, usageCsv } = require('../out/host/usageStats');
const { ProviderStore } = require('../out/providerStore');
const provider = (id, extra = {}) => ({ id, name: id, apiFormat: 'openai', baseUrl: 'https://example.com/v1', models: [{ id: 'shared', smart: true }], enabled: true, catalogId: id, weeklyTokenLimit: 1000, fiveHourTokenLimit: 1000, ...extra });
const now = Date.now();
const sample = (providerId, extra = {}) => ({ t: now - 1000, providerId, model: 'shared', tokensIn: 1000000, tokensOut: 1000000, tokensCached: 500000, ...extra });
const windows = { weekly: { used: 0, limit: 1000, remainingPct: 100, resetsInMs: 1000 }, fiveHour: { used: 0, limit: 1000, remainingPct: 100, resetsInMs: 1000 } };
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const fixture = (providers, events, catalog) => ({ store: { list: async () => providers, getUsageEvents: () => events, listSessions: async () => [], loadMessages: async () => [], usageWindows: () => windows, getSettings: () => ({ usageBudgetAlerts: false }) }, catalog });

test('same model on different providers uses the right price; subscriptions, local and unknown costs are excluded', async () => {
	const providers = [provider('a'), provider('b'), provider('free'), provider('unknown'), provider('plan', { preset: 'zai-coding-plan' }), provider('copilot', { apiFormat: 'vscode-lm' }), provider('local', { preset: 'ollama', baseUrl: 'http://127.0.0.1:8181/v1' })];
	const calls = [];
	const prices = { a: { priceIn: 2, priceOut: 8, priceCacheRead: 0.2 }, b: { priceIn: 4, priceOut: 10 }, free: { priceIn: 0, priceOut: 0 } };
	const data = await new UsageStats(fixture(providers, [...providers.map((p) => sample(p.id)), sample('deleted'), sample('a', { t: now - 40 * 86400000 }), sample('a', { t: now + 86400000 })], { lookup: async (_, hint) => { calls.push(hint); return prices[hint]; } })).usageData(30);
	const row = (id) => data.models.find((m) => m.providerId === id);
	assert.equal(row('a').cost, 9.1);
	assert.equal(row('b').cost, 14);
	assert.equal(row('free').costKind, 'free');
	assert.equal(row('unknown').costKind, 'unknown');
	assert.equal(row('deleted').costKind, 'unknown');
	assert.equal(row('plan').costKind, 'subscription');
	assert.equal(row('copilot').costKind, 'subscription');
	assert.equal(row('local').costKind, 'local');
	assert.equal(data.totals.cost, 23.1);
	assert.equal(data.totals.prevCost, 9.1);
	assert.equal(data.totals.saved, 0.9, 'no invented cache discount when a cache price is missing');
	assert.equal(data.totals.requests, 8);
	assert.deepEqual(data.totals.costCoverage, { estimated: 2, free: 1, subscription: 2, local: 1, unknown: 2 });
	assert.deepEqual(calls.sort(), ['a', 'b', 'free', 'unknown']);
});

test('manual zero prices stay free, incomplete pricing stays unknown, and a failed lookup uses configured rates', async () => {
	const p = provider('manual', { models: [{ id: 'shared', smart: true, manualFields: ['priceIn', 'priceOut'], priceIn: 0, priceOut: 0 }] });
	const stats = new UsageStats(fixture([p], [sample(p.id)], { lookup: async () => ({ priceIn: 20, priceOut: 80 }) }));
	assert.equal((await stats.usageData(7)).models[0].costKind, 'free');
	assert.equal(await stats.turnCost(p, 'shared', 1000, 1000, 0), 0);
	p.models = [{ id: 'shared', smart: false, priceIn: 2 }];
	const incomplete = new UsageStats(fixture([p], [sample(p.id)], { lookup: async () => ({ priceIn: 2 }) }));
	assert.equal((await incomplete.usageData(7)).models[0].costKind, 'unknown');
	p.models[0].priceOut = 8;
	const offline = new UsageStats(fixture([p], [sample(p.id)], { lookup: async () => { throw new Error('offline'); } }));
	assert.equal(await offline.turnCost(p, 'shared', 1000000, 1000000, 500000), 10);
	assert.equal(await offline.turnCost(provider('account', { auth: 'account' }), 'shared', 1000, 1000, 0), undefined);
	p.baseUrl = 'http://127.0.0.1:8181/v1';
	assert.equal(await offline.turnCost(p, 'shared', 1000000, 1000000, 0), 10, 'a priced localhost proxy is not assumed to be a local model');
});

test('daily charts include usage from the first partial day of a rolling period', async () => {
	const deps = fixture([provider('a')], [sample('a', { t: now - 7 * 86400000 + 5000 })], { lookup: async () => ({ priceIn: 2, priceOut: 8 }) });
	const stats = new UsageStats(deps);
	const data = await stats.usageData(7);
	assert.equal(data.daily.reduce((n, d) => n + Object.values(d.byModel).reduce((a, b) => a + b, 0), 0), data.totals.tokens);
	const detail = await stats.modelDetails(7, 'a', 'shared');
	assert.equal(detail.daily.reduce((n, d) => n + d.input + d.output, 0), data.totals.tokens);
});

test('model details use provider identity and exclude ambiguous legacy chats', async () => {
	const providers = [provider('a', { name: 'Same name' }), provider('b', { name: 'Same name' })];
	const deps = fixture(providers, [sample('a', { sessionId: 'linked' }), sample('b')], { lookup: async () => ({}) });
	deps.store.listSessions = async () => ['correct', 'other', 'ambiguous', 'linked', 'old'].map((id) => ({ id, title: id, updatedAt: now }));
	deps.store.loadMessages = async (id) => [{ role: 'user', turn: { startedAt: id === 'old' ? now - 40 * 86400000 : now - 1000, model: 'shared', provider: 'Same name', providerId: id === 'correct' || id === 'old' ? 'a' : id === 'other' ? 'b' : undefined } }];
	const detail = await new UsageStats(deps).modelDetails(7, 'a', 'shared');
	assert.equal(detail.daily.reduce((n, r) => n + r.input, 0), 1000000);
	assert.equal(detail.daily.reduce((n, r) => n + r.cached, 0), 500000);
	assert.deepEqual(detail.related.map((s) => s.id), ['correct', 'linked']);
	assert.equal(detail.relatedTruncated, false);
});

test('budget alerts are optional, deduplicate concurrent checks, survive restart and rearm after usage drops', async () => {
	const deps = fixture([provider('a')], [], { lookup: async () => ({}) });
	let enabled = false;
	let used = 750;
	deps.store.getSettings = () => ({ usageBudgetAlerts: enabled });
	deps.store.usageWindows = () => ({ ...windows, weekly: { ...windows.weekly, used } });
	const state = new Map();
	const alerts = [];
	deps.alertState = { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } };
	deps.notify = (message) => alerts.push(message);
	let stats = new UsageStats(deps);
	await stats.checkBudgetAlerts();
	assert.equal(alerts.length, 0);
	enabled = true;
	await Promise.all([stats.checkBudgetAlerts(), stats.checkBudgetAlerts(), stats.checkBudgetAlerts()]);
	assert.equal(alerts.length, 1);
	assert.match(alerts[0], /75% used/);
	stats = new UsageStats(deps);
	await stats.checkBudgetAlerts();
	assert.equal(alerts.length, 1);
	used = 900;
	await stats.checkBudgetAlerts();
	assert.match(alerts[1], /90% used/);
	used = 1200;
	await stats.checkBudgetAlerts();
	assert.match(alerts[2], /exhausted/);
	used = 700;
	await stats.checkBudgetAlerts();
	assert.equal(alerts.length, 3);
	used = 750;
	await stats.checkBudgetAlerts();
	assert.equal(alerts.length, 4);
	state.get('aiChat.usageBudgetAlerts')[JSON.stringify(['a', 'weekly'])].at = now - 8 * 86400000;
	await stats.checkBudgetAlerts();
	assert.equal(alerts.length, 5, 'alerts rearm after the previous rolling window has fully elapsed');
});

test('CSV exports every model with billing type, quoted names and unknown costs left blank', () => {
	const base = { providerId: 'a', provider: '=SUM(1,2)', model: 'name,"quoted"', requests: 2, tokensIn: 100, tokensOut: 20, tokensCached: 50, cost: 0, costKind: 'unknown' };
	const csv = usageCsv({ days: 7, since: now - 7 * 86400000, at: now, models: Array.from({ length: 25 }, (_, i) => ({ ...base, providerId: String(i), ...(i === 1 ? { costKind: 'free' } : {}) })) });
	assert.ok(csv.startsWith('\uFEFF'));
	assert.equal(csv.trimEnd().split('\r\n').length, 26);
	assert.ok(csv.includes('"\'=SUM(1,2)"'));
	assert.ok(csv.includes('"name,""quoted"""'));
	assert.ok(csv.includes('"unknown",""'));
	assert.ok(csv.includes('"free","0.000000"'));
});

test('usage subscribers only run after persistence and are disposable; alerts default off', async () => {
	const store = new ProviderStore(shim.context(path.join(__dirname, '..')));
	assert.equal(store.getSettings().usageBudgetAlerts, false);
	let count = 0;
	const subscription = store.onUsageRecorded(() => { count++; assert.equal(store.getUsageEvents().length, count); });
	await Promise.all([store.recordUsage(sample('a')), store.recordUsage(sample('b'))]);
	assert.equal(count, 2);
	subscription.dispose();
	await store.recordUsage(sample('c'));
	assert.equal(count, 2);
	await store.updateSettings({ usageBudgetAlerts: true });
	assert.equal(store.getSettings().usageBudgetAlerts, true);
});

test('per-key attribution: pool keys are masked and rotated, rollups and the CSV name the key that served', async () => {
	const { poolKeyHint } = require('../out/providerStore');
	assert.equal(poolKeyHint('sk-abcdefghij1234567890'), '…7890', 'only the last four characters survive');
	assert.equal(poolKeyHint('short'), '…', 'a short key shows no characters at all');

	const store = new ProviderStore(shim.context(path.join(__dirname, '..')));
	assert.equal(await store.keyInfoOf('pooltest'), undefined, 'no key, no attribution');
	await store.setApiKey('pooltest', 'sk-aaaabbbbccccdddd1111, sk-eeeeffffgggghhhh2222');
	assert.deepEqual(await store.keyInfoOf('pooltest'), { index: 0, hint: '…1111' });
	assert.ok(await store.rotateKey('pooltest'));
	assert.deepEqual(await store.keyInfoOf('pooltest'), { index: 1, hint: '…2222' });
	assert.deepEqual(await store.keyInfoOf('pooltest', 'sk-aaaabbbbccccdddd1111'), { index: 0, hint: '…1111' }, 'attribute the served key even when another request rotated the pool');
	assert.equal(await store.keyInfoOf('pooltest', 'unrecorded-key'), undefined);
	await store.setApiKey('solo', 'sk-onlyonekey9999');
	assert.equal(await store.keyInfoOf('solo'), undefined, 'a single key needs no attribution');

	const events = [sample('a', { keyIndex: 1, keyHint: '…2222', tokensIn: 2000000, tokensOut: 2000000 }), sample('a', { keyIndex: 0, keyHint: '…1111' }), sample('a')];
	const data = await new UsageStats(fixture([provider('a')], events, { lookup: async () => ({ priceIn: 2, priceOut: 8 }) })).usageData(7);
	const row = data.models[0];
	assert.deepEqual(row.keys.map((k) => [k.index, k.requests]), [[1, 1], [0, 1]], 'the busiest key first');
	assert.equal(row.keyless, 1, 'records without attribution are counted, never guessed');
	const csv = usageCsv(data);
	assert.ok(csv.includes('"Pool keys"'));
	assert.ok(csv.includes('"key #2 …2222 (1); key #1 …1111 (1); not recorded (1)"'));
});

(async () => {
	for (const [name, fn] of tests) { await fn(); console.log('ok  ' + name); }
	console.log('Usage tests passed.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
