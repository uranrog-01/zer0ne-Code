'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CacheWarmer } = require('../out/host/cacheWarmer');

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function fixture(t) {
	const timers = new Set(), calls = [], warmed = [], usage = [];
	t.mock.method(global, 'setTimeout', fn => {
		const timer = { fn, unref() {} };
		timers.add(timer);
		return timer;
	});
	t.mock.method(global, 'clearTimeout', timer => timers.delete(timer));
	const h = {
		store: {
			getSettings: () => ({ cacheWarm: true, cacheTtl: '5m' }),
			getApiKey: async () => 'test-key',
			keyInfoOf: async () => undefined,
			recordUsage: async item => { usage.push(item); }
		},
		currentSessionId: () => 'session',
		busy: () => false,
		loadTranscript: () => ({ entries: [{ role: 'user', content: 'hello' }] }),
		callModel: async (_provider, _key, options) => {
			const result = deferred();
			calls.push({ options, result });
			return result.promise;
		},
		warmed: info => warmed.push(info),
		stateChanged() {}
	};
	const warmer = new CacheWarmer(h);
	t.after(() => warmer.cancel());
	const request = () => ({
		sessionId: 'session', provider: { id: 'provider', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com' },
		model: { id: 'claude-test', priceIn: 3 }, system: 'test', promptTokens: 100_000
	});
	const fire = async () => {
		const timer = timers.values().next().value;
		assert.ok(timer, 'a refresh is scheduled');
		timers.delete(timer);
		timer.fn();
		await flush();
	};
	return { h, warmer, request, fire, timers, calls, warmed, usage };
}

test('cancel aborts an in-flight refresh and suppresses its late UI update', async t => {
	const f = fixture(t);
	f.warmer.schedule(f.request());
	await f.fire();
	f.warmer.cancel();
	assert.equal(f.calls[0].options.signal.aborted, true);
	f.calls[0].result.resolve({ usage: { input: 10, output: 1, cached: 9 } });
	await flush();
	assert.equal(f.warmed.length, 0);
	assert.equal(f.timers.size, 0);
	assert.equal(f.usage.length, 1, 'completed paid requests are still accounted for');
});

for (const outcome of ['resolve', 'reject']) {
	test(`a replaced refresh cannot cancel the new schedule after it ${outcome}s`, async t => {
		const f = fixture(t);
		f.warmer.schedule(f.request());
		await f.fire();
		f.warmer.schedule(f.request());
		f.calls[0].result[outcome](outcome === 'resolve' ? { usage: { cached: 9 } } : new Error('old refresh failed'));
		await flush();
		assert.equal(f.warmed.length, 0, 'the old request must not update the current chat');
		assert.equal(f.timers.size, 1, 'the new schedule survives the old completion');
		await f.fire();
		assert.equal(f.calls.length, 2);
		f.calls[1].result.resolve({ usage: { cached: 20 } });
		await flush();
		assert.deepEqual(f.warmed, [{ count: 1, cachedTokens: 20 }]);
	});
}

test('cancelling while the key loads prevents the paid request from starting', async t => {
	const f = fixture(t), key = deferred();
	f.h.store.getApiKey = () => key.promise;
	f.warmer.schedule(f.request());
	await f.fire();
	f.warmer.cancel();
	key.resolve('test-key');
	await flush();
	assert.equal(f.calls.length, 0);
});

test('a queued timer from a replaced schedule cannot start or cancel a refresh', async t => {
	const f = fixture(t), request = f.request();
	f.warmer.schedule(request);
	const stale = f.timers.values().next().value;
	f.warmer.schedule(request);
	stale.fn();
	await flush();
	assert.equal(f.calls.length, 0);
	assert.equal(f.timers.size, 1);
});

test('a chat switch during key loading prevents a refresh for the old chat', async t => {
	const f = fixture(t), key = deferred();
	f.h.store.getApiKey = () => key.promise;
	f.warmer.schedule(f.request());
	await f.fire();
	f.h.currentSessionId = () => 'another-session';
	key.resolve('test-key');
	await flush();
	assert.equal(f.calls.length, 0);
	assert.equal(f.timers.size, 0);
});

test('ordinary refreshes stop at three and legacy thinking requests stay unscheduled', async t => {
	const f = fixture(t);
	f.warmer.schedule(f.request());
	for (let i = 0; i < 3; i++) {
		await f.fire();
		f.calls[i].result.resolve({ usage: { cached: 20 } });
		await flush();
	}
	assert.deepEqual(f.warmed.map(info => info.count), [1, 2, 3]);
	assert.equal(f.timers.size, 0);
	f.warmer.schedule({ ...f.request(), model: { id: 'claude-sonnet-4-20250514', priceIn: 3 }, effort: 'high' });
	assert.equal(f.timers.size, 0);
});
