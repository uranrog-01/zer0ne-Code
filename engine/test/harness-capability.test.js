'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { continuation, nativeItems, assistantMessage } = require('../out/continuation');
const { TranscriptStore } = require('../out/transcript');
const { codexBody } = require('../out/codexClient');
const { anthropicAccumulator, toAnthropicMessages, streamChat } = require('../out/chatClient');
const { toGeminiContents } = require('../out/nativeProviders');
const { runAgentTurn } = require('../out/core/turn');
const { responseLimit, ContextEstimator } = require('../out/responseBudget');
const { openaiUsage, priceUsage } = require('../out/usage');
const { serializedRequest } = require('../out/requestDiagnostics');
const { functionTool, executableCall } = require('../out/toolSchema');
const { runProduction } = require('../out/eval/production');
const { runEvals, summarize } = require('../out/eval/harness');
const { evalProfile, evalOptions } = require('../out/eval/profiles');
const { requestProfileFor, replayOutputLimit } = require('../out/requestProfile');
const { JSDOM } = require('jsdom');
const tests = [];
const test = (name, run) => tests.push([name, run]);
const opts = { baseUrl: 'https://api.openai.com/v1', providerId: 'p', apiKey: '', model: 'gpt-6.1', apiFormat: 'responses', messages: [], signal: new AbortController().signal };
const result = (text, stopReason = 'stop', extra = {}) => ({ text, reasoning: '', toolCalls: [], stopReason, ...extra });

test('final native reasoning survives disk restart, tool-ID repair, and portable fallback', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-continuation-'));
	try {
		const items = [{ type: 'reasoning', encrypted_content: 'opaque-one', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }, { type: 'reasoning', encrypted_content: 'opaque-two', summary: [] }];
		const entry = assistantMessage(result('Done.', 'stop', { native: continuation(opts, 'responses', items, 'Done.', 300) }));
		new TranscriptStore(root).save('s', { v: 1, entries: [entry], marks: {}, reads: {} });
		const restored = new TranscriptStore(root).load('s').entries[0];
		assert.deepEqual(codexBody({ ...opts, messages: [restored] }).input, items);
		assert.equal(nativeItems(restored, { ...opts, providerId: 'other' }, 'responses'), undefined);
		assert.equal(nativeItems(restored, { ...opts, apiKey: 'different-account' }, 'responses'), undefined);
		assert.equal(nativeItems({ ...restored, content: 'Edited' }, opts, 'responses'), undefined);
		assert.equal(nativeItems(restored, { ...opts, model: 'other' }, 'responses'), undefined);
		assert.deepEqual(codexBody({ ...opts, providerId: 'other', messages: [restored] }).input, [{ role: 'assistant', content: 'Done.' }]);
		const tool = { role: 'assistant', content: '', toolCalls: [{ id: 'repaired', name: 'read_file', arguments: '{"path":"a"}' }], native: continuation(opts, 'responses', [{ type: 'function_call', call_id: 'old', name: 'read_file', arguments: '{"path":"a"}' }], '') };
		assert.equal(nativeItems(tool, opts, 'responses')[0].call_id, 'repaired');
		assert.equal(nativeItems({ ...tool, toolCalls: [{ ...tool.toolCalls[0], arguments: '{"path":"b"}' }] }, opts, 'responses'), undefined);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('signed Claude final thinking and Gemini text parts keep their order', () => {
	const o = { ...opts, model: 'claude-test', apiFormat: 'anthropic' };
	const acc = anthropicAccumulator(o);
	for (const [index, content_block] of [{ type: 'thinking', thinking: 'reason', signature: 'sig' }, { type: 'text', text: 'answer' }, { type: 'redacted_thinking', data: 'opaque' }].entries()) acc.handle({ type: 'content_block_start', index, content_block });
	const answer = assistantMessage(acc.result());
	assert.deepEqual(toAnthropicMessages([{ role: 'user', content: 'hello' }, answer], o)[1].content.map(b => b.type), ['thinking', 'text', 'redacted_thinking']);
	const parts = [{ text: 'answer', thoughtSignature: 'signed-text' }];
	const gem = assistantMessage(result('answer', 'stop', { native: continuation(opts, 'gemini', parts, 'answer') }));
	assert.deepEqual(toGeminiContents([{ role: 'user', content: 'hello' }, gem], opts)[1].parts, parts);
});

test('Responses streaming retains every reasoning item after a final answer without tools', async () => {
	const seen = [], output = [{ type: 'reasoning', encrypted_content: 'opaque-first', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] }, { type: 'reasoning', encrypted_content: 'opaque-last', summary: [] }];
	const server = http.createServer((req, res) => { let data = ''; req.on('data', chunk => data += chunk); req.on('end', () => { seen.push(JSON.parse(data)); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const event of [{ type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed', response: { output, usage: { input_tokens: 10, output_tokens: 3 } } }]) res.write('data: ' + JSON.stringify(event) + '\n\n'); res.end(); }); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const o = { ...opts, baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', messages: [{ role: 'user', content: 'hello' }] };
		const first = await streamChat(o); assert.deepEqual(first.native.items, output);
		await streamChat({ ...o, messages: [...o.messages, assistantMessage(first), { role: 'user', content: 'next' }] });
		assert.deepEqual(seen[1].input.slice(1, 4), output);
	} finally { await new Promise(resolve => server.close(resolve)); }
});

test('truncated answers continue automatically but the allowance is bounded', async () => {
	const messages = [{ role: 'user', content: 'finish' }], seen = [];
	const out = await runAgentTurn({ messages, maxSteps: 0, signal: opts.signal, call: async step => result('part' + step, step < 1 ? 'length' : 'stop'), execute: async () => { throw Error('unexpected'); }, onAnswer: (_r, _cut, continuing) => seen.push(continuing) });
	assert.equal(out.truncated, undefined); assert.equal(out.continuations, 1); assert.deepEqual(seen, [true, false]);
	assert.equal(out.text, 'part0part1', 'all continued answer segments remain in the report');
	let calls = 0;
	const cutoff = await runAgentTurn({ messages: [], maxSteps: 0, signal: opts.signal, call: async () => { calls++; return result('part', 'length'); }, execute: async () => ({ api: '' }) });
	assert.equal(calls, 3); assert.equal(cutoff.truncated, true);
});

test('model limits, native context estimates, and legacy replay budgets stay valid', () => {
	assert.equal(responseLimit({ maxOutput: 64000, contextWindow: 128000 }), 64000);
	assert.equal(responseLimit({ maxOutput: 64000, contextWindow: 8192 }), 7168);
	const estimator = new ContextEstimator(), messages = [{ role: 'assistant', content: 'ok', native: { items: [], outputTokens: 9000 } }];
	const first = estimator.estimate('m', messages, 0); assert.ok(first >= 9000);
	estimator.observe('m', first, first * 2); const second = estimator.estimate('m', messages, 0); assert.ok(second > first * 2);
	estimator.observe('m', second, second * 2); assert.ok(estimator.estimate('m', messages, 0) > second);
	const budget = replayOutputLimit({ ...opts, model: 'claude-3-7-sonnet', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', effort: 'high' }, 2000);
	assert.ok(budget > 2000);
});

test('cache writes reconcile with total usage and effort changes break the diagnostic prefix', () => {
	const usage = openaiUsage({ input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 } });
	assert.equal(usage.uncached, 500); assert.equal(usage.cacheWrite, 300);
	assert.equal(priceUsage({ priceIn: 1, priceOut: 2, priceCacheRead: 0.1, priceCacheWrite: 1.25, priceCacheWrite12h: 2.5 }, { ...usage, cacheTtlRequested: '12h' }), (500 + 20 + 750 + 40) / 1e6);
	const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' };
	serializedRequest('https://example.test/v1/chat/completions', body, 'cap-test');
	assert.equal(serializedRequest('https://example.test/v1/chat/completions', { ...body, reasoning_effort: 'high' }, 'cap-test').changed, 'configuration');
});

test('strict schemas retain wire nulls and restore absent optional arguments only for execution', () => {
	const tool = { name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' }, options: { type: 'object', properties: { line: { type: 'integer' } } }, nullable: { type: ['string', 'null'] } }, required: ['path'] } };
	const schema = functionTool(tool, true); assert.equal(schema.strict, true); assert.equal(schema.parameters.additionalProperties, false);
	const raw = { id: 'c', name: 'read', arguments: '{"path":"a","options":{"line":null},"nullable":null}' };
	const call = executableCall(raw, [tool], true); assert.equal(call.arguments, raw.arguments); assert.deepEqual(JSON.parse(call.executionArguments), { path: 'a', options: {}, nullable: null });
	assert.equal(functionTool({ ...tool, parameters: { type: 'object', additionalProperties: { type: 'string' } } }, true).strict, false);
	assert.equal(functionTool({ ...tool, parameters: { type: 'object', properties: { forbidden: false } } }, true).strict, false, 'boolean constraints retain their original non-strict contract');
});

test('profiles are reproducible and transport-aware', () => {
	const provider = { ...opts, id: 'p', models: [] }, model = { id: 'gpt-6.1', maxOutput: 64000, contextWindow: 128000 };
	assert.deepEqual(evalOptions({ execution: 'production', profiles: ['lean', 'lean'], trials: 3 }).profiles, ['lean']);
	assert.throws(() => evalOptions({ trials: 11 }));
	const profile = evalProfile('strict', 'production', {}, provider, model, 'high');
	assert.equal(profile.request.strictTools, true); assert.equal(profile.settings.strictTools, 'on');
	assert.equal(profile.id, evalProfile('strict', 'production', {}, provider, model, 'high').id);
	assert.deepEqual(requestProfileFor({ openaiCache: 'explicit', openaiCacheTtl: '12h' }, provider, model).promptCache, { mode: 'explicit', ttl: '12h' });
	assert.equal(requestProfileFor({ openaiCache: 'explicit' }, { ...provider, baseUrl: 'https://gateway.test' }, model).promptCache, undefined);
});

test('repeated core trials keep follow-up history and report independent samples', async () => {
	const reports = await runEvals([{ id: 'history', prompt: 'remember orange', followUps: ['which color?'], expect: [{ kind: 'reply', contains: 'orange' }] }], { provider: opts, trials: 3, callModel: async o => result(o.messages.length > 1 && o.messages[0].content.includes('orange') ? 'orange' : 'remembered') }, { quiet: true });
	assert.equal(reports.length, 3); assert.ok(reports.every(r => r.pass)); assert.equal(summarize(reports).measurement.cases, 1);
});

test('benchmark controls retain the chosen mode, trials, profiles and measured adoption action', () => {
	const dom = new JSDOM('<main></main>', { runScripts: 'outside-only' });
	try {
		dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../media/settings-benchmark-profiles.js'), 'utf8'));
		const posted = [], S = { settings: {} };
		const api = dom.window.SettingsBenchmarkProfiles.create({ S, esc: s => String(s).replace(/</g, '&lt;'), post: m => posted.push(m), renderPage() {} });
		const main = dom.window.document.querySelector('main'); main.innerHTML = api.form() + api.settings(); api.bind(main);
		assert.equal(api.options().execution, 'production'); assert.equal(api.options().trials, 3);
		const mode = main.querySelector('[data-bench-execution]'); mode.value = 'core'; mode.dispatchEvent(new dom.window.Event('change'));
		assert.equal(api.options().execution, 'core');
		const trials = main.querySelector('[data-bench-trials]'); trials.value = '8'; trials.dispatchEvent(new dom.window.Event('change')); assert.equal(api.options().trials, 8);
		const strict = main.querySelector('[data-bench-profile="strict"]'); strict.checked = true; strict.dispatchEvent(new dom.window.Event('change')); assert.ok(api.options().profiles.includes('strict'));
		assert.equal(main.querySelector('[data-setting="openaiCacheTtl"]').options.length, 2);
		main.innerHTML = api.details({ id: 'run', at: Date.now(), profile: { kind: 'production', name: 'lean', tools: 'lean' }, trials: 3, summary: { rate: 1, measurement: { cases: 2, samples: 6, requests: 12, retries: 0, truncations: 0, toolFailures: 0, cacheWrites: 40, cacheKnown: 12, medianMs: 100, p95Ms: 200, firstUsefulMedianMs: 50, warmMedianMs: 90, coldMedianMs: 120, costPerSuccess: 0.01 } }, cases: [] }); api.bind(main);
		assert.ok(main.textContent.includes('6 samples')); main.querySelector('[data-bench-apply]').click(); assert.equal(posted[0].type, 'benchmarkApplyProfile');
	} finally { dom.window.close(); }
});

test('production controller runs consecutive isolated turns and records real request/cache metrics', async () => {
	const requests = [];
	const server = http.createServer((req, res) => { let data = ''; req.on('data', c => data += c); req.on('end', () => { const body = JSON.parse(data); requests.push(body); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'orange' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } } }) + '\n\ndata: [DONE]\n\n'); }); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-prod-case-'));
	try {
		const provider = { id: 'mock', name: 'Mock', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiFormat: 'openai', enabled: true, models: [{ id: 'mock-model', smart: false, enabled: true, contextWindow: 128000, maxOutput: 4096, priceIn: 0, priceOut: 0 }] };
		const out = await runProduction(root, 'Remember orange. Reply orange.', { providers: [{ provider, apiKey: '' }], primary: 'mock', model: 'mock-model', settings: { sandbox: 'off', autoVerify: false, autoTitle: false, memory: false, skills: false, repoMap: false, subagents: false, toolProfile: 'lean' } }, { engineDir: path.resolve(__dirname, '..'), timeoutSeconds: 30, followUps: ['Which color? Reply orange.'] });
		assert.equal(out.outcome, 'completed', out.text); assert.equal(out.text, 'orange'); assert.ok(out.attempts.length >= 2);
		assert.ok(out.attempts.every(a => a.providerId === 'mock')); assert.ok(out.attempts.some(a => a.usage?.cached === 50));
		const main = requests.filter(r => r.messages?.some(m => m.content?.includes?.('Which color?')));
		assert.ok(main.some(r => r.messages.some(m => m.role === 'assistant' && m.content === 'orange')), 'second turn replays the prior answer');
	} finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

(async () => { let failed = 0; for (const [name, run] of tests) { try { await run(); console.log('ok  ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error.stack); } } process.exitCode = failed ? 1 : 0; })();
