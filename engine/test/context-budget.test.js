'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { contextBudgetText } = require(path.join(OUT, 'tools/contextBudget'));

test('context_remaining states the window, the last request and what is left', () => {
	const out = contextBudgetText({ remaining: 2500, window: 10000, used: 7500, source: 'provider' });
	assert.match(out.api, /10000 tokens/);
	assert.match(out.api, /7500 used/);
	assert.match(out.api, /2500 left \(25%\)/);
	assert.equal(out.summary, '25% left');
	assert.match(out.detail, /provider/);
});

test('context_remaining is honest when the figures are unknown', () => {
	const out = contextBudgetText(undefined);
	assert.match(out.api, /unknown/);
	assert.equal(out.summary, 'unknown');
	assert.equal(out.detail, undefined);
});

test('an estimated count is labelled as one', () => {
	assert.match(contextBudgetText({ remaining: 1, window: 2, used: 1, source: 'estimated' }).api, /\(estimated\)/);
});
