'use strict';
const assert = require('assert');
const { reasoningControl, reasoningHints, advertisedReasoning } = require('../out/reasoning');
const { thoughtControl, variantControls, applyThoughtLevel } = require('../out/acp/reasoning');
const { sessionModels } = require('../out/acp/client');
const { anthropicRequestBody, anthropicAccumulator, toAnthropicMessages, modelApiFormat, fetchModels, streamChat } = require('../out/chatClient');
const { codexBody } = require('../out/codexClient');
const { geminiBody } = require('../out/nativeProviders');
const tests = [], test = (name, run) => tests.push([name, run]);
const options = patch => ({ apiFormat: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture', model: 'gpt-6.1-sol', system: 'Fixture', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, maxTokens: 8192, ...patch });
const thoughtSession = values => ({ sessionId: 'fixture', configOptions: [{ id: 'reasoning_setting', category: 'thought_level', type: 'select', currentValue: 'provider_high', options: [{ name: 'Allowed', options: values ?? [{ value: 'provider_low', name: 'Low' }, { value: 'provider_high', name: 'High' }] }] }] });

test('OpenAI models expose only supported efforts and Auto emits no override', () => {
 assert.deepEqual(reasoningControl(options()).levels, ['low', 'medium', 'high', 'xhigh', 'maximum']);
 assert.equal(reasoningHints(options({ effort: 'maximum' })).reasoning.effort, 'max');
 assert.deepEqual(reasoningHints(options()), {});
 assert.deepEqual(reasoningControl(options({ model: 'gpt-4.1' })).levels, []);
 assert.deepEqual(reasoningHints(options({ model: 'gpt-4.1', effort: 'high' })), {});
 assert.deepEqual(reasoningControl(options({ model: 'gpt-5.1' })).levels, ['none', 'low', 'medium', 'high']);
 assert.equal(modelApiFormat(options({ apiFormat: 'openai' })), 'responses', 'GPT-6.1 requires Responses for reasoning with tools');
 const plan = codexBody(options({ chatgptPlan: true, effort: 'high' }));
 assert.equal(plan.reasoning.effort, 'high'); assert.equal(plan.max_output_tokens, undefined); assert.deepEqual(plan.include, ['reasoning.encrypted_content']);
});

test('Provider model metadata controls mandatory thinking and exact gateway levels', () => {
 const metadata = advertisedReasoning({ reasoning: { supported_efforts: ['none', 'minimal', 'low', 'high'], mandatory: true } }, 'openai', 'https://openrouter.ai/api/v1');
 assert.deepEqual(metadata.levels, ['minimal', 'low', 'high']);
 assert.deepEqual(reasoningHints(options({ reasoningControl: metadata, effort: 'low' })), { reasoning: { effort: 'low' } });
 assert.deepEqual(reasoningHints(options({ reasoningControl: metadata, effort: 'none' })), {});
 assert.deepEqual(reasoningControl(options({ baseUrl: 'https://openrouter.ai/api/v1' })).levels, [], 'unknown gateway model is not assigned fabricated controls');
 assert.equal(advertisedReasoning({ supported_reasoning_efforts: ['max', 'low'] }, 'responses', 'https://api.openai.com/v1').levels[0], 'maximum');
});

test('Gemini 3 uses supported thinking levels and 2.5 budgets stay in model bounds', () => {
 const native = patch => options({ apiFormat: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', ...patch });
 assert.deepEqual(geminiBody(native({ model: 'gemini-3.6-flash', effort: 'minimal' })).generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'minimal' });
 assert.deepEqual(reasoningControl(native({ model: 'gemini-3.8-flash' })).levels, ['low', 'medium', 'high']);
 assert(!reasoningControl(native({ model: 'gemini-3.1-pro' })).levels.includes('none'));
 assert.equal(geminiBody(native({ model: 'gemini-2.5-flash', effort: 'xhigh' })).generationConfig.thinkingConfig.thinkingBudget, 24576);
 assert.equal(geminiBody(native({ model: 'gemini-2.5-pro', effort: 'xhigh' })).generationConfig.thinkingConfig.thinkingBudget, 32768);
 assert.equal(geminiBody(native({ model: 'gemini-2.0-flash', effort: 'high' })).generationConfig.thinkingConfig, undefined);
});

test('Claude effort and legacy thinking use their native parameters without overriding Auto', () => {
 const claude = patch => options({ apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', ...patch });
 const adaptive = anthropicRequestBody(claude({ model: 'claude-opus-5-5', effort: 'maximum' }));
 assert.deepEqual(adaptive.output_config, { effort: 'max' }); assert.deepEqual(adaptive.thinking, { type: 'adaptive' });
 const legacy = anthropicRequestBody(claude({ model: 'claude-sonnet-4-5', effort: 'high', maxTokens: 4096 }));
 assert.deepEqual(legacy.thinking, { type: 'enabled', budget_tokens: 3072 });
 assert.equal(anthropicRequestBody(claude({ model: 'claude-sonnet-4-5', effort: 'high', maxTokens: 1024 })).thinking, undefined);
 assert.equal(anthropicRequestBody(claude({ model: 'claude-opus-5-5' })).thinking, undefined);
 assert.deepEqual(reasoningControl(claude({ model: 'MiniMax-M3' })).levels, []);
});

test('Claude signed and redacted thinking survive a streamed tool round-trip', () => {
 const acc = anthropicAccumulator({});
 for (const event of [
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Consider the file' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-fixture' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'redacted-fixture' } },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'read_one', name: 'read_file' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
 ]) acc.handle(event);
 const result = acc.result();
 const replay = toAnthropicMessages([{ role: 'user', content: 'Read' }, { role: 'assistant', content: '', toolCalls: result.toolCalls }, { role: 'tool', toolCallId: 'read_one', name: 'read_file', content: 'File text' }]);
 assert.deepEqual(replay[1].content.slice(0, 2), [{ type: 'thinking', thinking: 'Consider the file', signature: 'signed-fixture' }, { type: 'redacted_thinking', data: 'redacted-fixture' }]);
 assert.equal(replay[1].content[2].type, 'tool_use'); assert.equal(replay[2].content[0].tool_use_id, 'read_one');
});

test('Local thinking budgets use fields implemented by the pinned engine and unsupported templates stay Auto', () => {
 const qwen = options({ apiFormat: 'openai', model: 'Qwen3-1.7B-Q4_K_M', baseUrl: 'http://127.0.0.1:9070/v1' });
 const capability = reasoningControl({ ...qwen, localEngine: true });
 assert.deepEqual(reasoningHints({ ...qwen, reasoningControl: capability, effort: 'high' }), { reasoning_budget_tokens: 8192 });
 assert.deepEqual(reasoningHints({ ...qwen, reasoningControl: capability, effort: 'none' }), { reasoning_budget_tokens: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
 assert.deepEqual(reasoningControl({ ...qwen, model: 'Llama-3.2-3B', localEngine: true }).levels, []);
 const oss = reasoningControl({ ...qwen, model: 'gpt-oss-20b', localEngine: true });
 assert.deepEqual(reasoningHints({ ...qwen, reasoningControl: oss, effort: 'low' }), { reasoning_effort: 'low' });
});

test('ACP reads grouped thought-level choices and Auto restores the session default after empty responses', async () => {
 const session = thoughtSession();
 const advertised = thoughtControl(session); assert.deepEqual(advertised.levels, ['low', 'high']); assert.equal(advertised.configId, 'reasoning_setting');
 const sent = [], conn = { setConfigOption: async (sessionId, id, value) => { sent.push([sessionId, id, value]); return {}; } };
 const low = await applyThoughtLevel(conn, session, 'low', 'provider_high');
 assert.equal(low.configOptions[0].currentValue, 'provider_low');
 const restored = await applyThoughtLevel(conn, low, undefined, 'provider_high');
 assert.equal(restored.configOptions[0].currentValue, 'provider_high'); assert.deepEqual(sent.map(item => item[2]), ['provider_low', 'provider_high']);
 await assert.rejects(applyThoughtLevel(conn, session, 'xhigh'), /unavailable/);
 await assert.rejects(applyThoughtLevel(conn, { sessionId: 'no-controls' }, 'high'), /does not advertise/);
});

test('ACP dependent controls use the agent’s full response and unknown option names are not invented', async () => {
 const session = thoughtSession();
 const returned = thoughtSession([{ value: 'provider_low', name: 'Low' }]).configOptions;
 const changed = await applyThoughtLevel({ setConfigOption: async () => ({ configOptions: returned }) }, session, 'low');
 assert.deepEqual(thoughtControl(changed).levels, ['low']);
 assert.equal(thoughtControl({ configOptions: [{ id: 'temperature', category: 'model_config', type: 'select', options: [{ value: 'high' }] }] }), undefined);
});

test('ACP effort variants include all advertised siblings and retain exact model IDs', () => {
 const models = [{ modelId: 'gemini-3.6-flash-high', name: 'Gemini 3.6 Flash (High)' }, { modelId: 'gemini-3.6-flash-low', name: 'Gemini 3.6 Flash (Low)' }, { modelId: 'different-high', name: 'Different (High)' }];
 const found = sessionModels({ models: { currentModelId: models[0].modelId, availableModels: models } });
 const high = found.models[0].reasoningControl;
 assert.deepEqual(high.levels, ['high', 'low']); assert.equal(high.choices.find(c => c.effort === 'low').value, 'gemini-3.6-flash-low');
 assert.equal(high.choices[1].model, true); assert.equal(found.models[2].reasoningControl, undefined);
 assert.equal(variantControls([{ id: 'one-high', name: 'One (High)' }]).size, 0);
});

test('OpenRouter model discovery preserves the server’s exact reasoning metadata', async () => {
 const previous = global.fetch;
 global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'fixture/model', reasoning: { supported_efforts: ['low', 'high'], mandatory: true } }] }), { headers: { 'Content-Type': 'application/json' } });
 try { const models = await fetchModels('https://openrouter.ai/api/v1', 'fixture', 'openai'); assert.deepEqual(models[0].reasoningControl.levels, ['low', 'high']); }
 finally { global.fetch = previous; }
});

test('OpenRouter and DeepSeek chat transports send their documented reasoning fields', async () => {
 const previous = global.fetch; let body;
 global.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); };
 try {
  const advertised = advertisedReasoning({ reasoning: { supported_efforts: ['low', 'high'] } }, 'openai', 'https://openrouter.ai/api/v1');
  await streamChat(options({ apiFormat: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'fixture/model', effort: 'low', reasoningControl: advertised }));
  assert.deepEqual(body.reasoning, { effort: 'low' }); assert.equal(body.reasoning_effort, undefined);
  await streamChat(options({ apiFormat: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', effort: 'maximum' }));
  assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'max');
 } finally { global.fetch = previous; }
});

(async () => {
 let failed = 0;
 for (const [name, run] of tests) { try { await run(); console.log('PASS ' + name); } catch (error) { failed++; console.error('FAIL ' + name, error); } }
 console.log(`${tests.length - failed}/${tests.length} reasoning checks passed.`); process.exitCode = failed ? 1 : 0;
})();
