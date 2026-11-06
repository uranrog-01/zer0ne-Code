// Exercises out/chatClient.js against a local mock SSE server (both wire formats).
const http = require('http');
const assert = require('assert');
const client = require(require('path').join(__dirname, '..', 'out') + '/chatClient.js');

const seen = [];
function sse(res, events) {
	res.writeHead(200, { 'Content-Type': 'text/event-stream' });
	for (const e of events) res.write(`data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
	res.end();
}
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		const json = body ? JSON.parse(body) : {};
		seen.push({ url: req.url, headers: req.headers, json });
		if (req.url === '/v1/chat/completions') {
			if (json.model === 'boom') return sse(res, [{ error: { message: 'upstream exploded' } }]);
			if (json.model === 'm404') { res.writeHead(404); return res.end('{"error":{"message":"model_not_found"}}'); }
			if (json.model === 'empty') return sse(res, []);
			if (json.model === 'strict' && ('reasoning_effort' in json || 'stream_options' in json)) { res.writeHead(422); return res.end('{"detail":[{"msg":"Extra inputs are not permitted","loc":["body","reasoning_effort"]}]}'); }
			if (json.model === 'think') return sse(res, [
				{ choices: [{ delta: { content: '<thi' } }] }, { choices: [{ delta: { content: 'nk>pondering</th' } }] },
				{ choices: [{ delta: { content: 'ink>\n\nAnswer' } }] }, '[DONE]']);
			return sse(res, [
				{ choices: [{ delta: { reasoning_content: 'hmm ' } }] },
				{ choices: [{ delta: { content: 'Hel' } }] },
				{ choices: [{ delta: { content: 'lo' } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
				{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] },
				{ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
				'[DONE]'
			]);
		}
		if (req.url === '/v1/messages') {
			if (json.model === 'boom') return sse(res, [{ type: 'error', error: { message: 'overloaded' } }]);
			return sse(res, [
				{ type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1 } } },
				{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
				{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
				{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Sure' } },
				{ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'grep', input: {} } },
				{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pattern":' } },
				{ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"foo"}' } },
				{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }
			]);
		}
		if (req.url.startsWith('/v1/models')) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ data: [{ id: 'b' }, { id: 'a', context_length: 1000 }, { id: 'a' }] }));
		}
		res.writeHead(404); res.end();
	});
});

server.listen(0, async () => {
	const base = `http://127.0.0.1:${server.address().port}`;
	const common = { apiKey: 'k', system: 'sys', signal: new AbortController().signal };
	try {
		// OpenAI: text, reasoning, fragmented tool call, usage
		let text = '', reasoning = '';
		const r1 = await client.streamChat({ ...common, baseUrl: base + '/v1/', apiFormat: 'openai', model: 'x',
			messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }],
			onText: (t) => (text += t), onReasoning: (t) => (reasoning += t) });
		assert.strictEqual(r1.text, 'Hello'); assert.strictEqual(text, 'Hello'); assert.strictEqual(reasoning, 'hmm ');
		assert.deepStrictEqual(r1.toolCalls, [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }]);
		assert.deepStrictEqual({ input: r1.usage.input, output: r1.usage.output, cached: r1.usage.cached }, { input: 11, output: 7, cached: undefined });
		const req1 = seen.at(-1).json;
		assert.strictEqual(req1.tools[0].function.name, 'read_file'); assert.ok(req1.stream_options.include_usage);
		assert.strictEqual(seen.at(-1).headers.authorization, 'Bearer k');
		console.log('ok  openai stream + tool call assembly + usage');

		// OpenAI: pasted full endpoint as base URL, <think> splitting
		const r2 = await client.streamChat({ ...common, baseUrl: base + '/v1/chat/completions', apiFormat: 'openai', model: 'think', messages: [{ role: 'user', content: 'q' }] });
		assert.strictEqual(r2.reasoning, 'pondering'); assert.strictEqual(r2.text, 'Answer');
		console.log('ok  <think> tag split + full-endpoint base URL');

		// OpenAI: in-stream error surfaces; HTTP 404 gives a model hint
		await assert.rejects(client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'openai', model: 'boom', messages: [{ role: 'user', content: 'q' }] }), /upstream exploded/);
		await assert.rejects(client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'openai', model: 'm404', messages: [{ role: 'user', content: 'q' }] }), /does not serve model "m404"/);
		console.log('ok  openai errors surface (stream error + 404 hint)');

		// Strict servers: optional fields dropped after a 422 (and remembered); Mistral 9-char tool ids
		const before = seen.length;
		const r4 = await client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'openai', model: 'strict', effort: 'high', messages: [{ role: 'user', content: 'q' }] });
		assert.strictEqual(r4.text, 'Hello');
		assert.strictEqual(seen.length - before, 2, 'one retry');
		assert.ok(!('reasoning_effort' in seen.at(-1).json) && !('stream_options' in seen.at(-1).json));
		await client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'openai', model: 'strict', effort: 'high', messages: [{ role: 'user', content: 'q' }] });
		assert.strictEqual(seen.length - before, 3, 'remembered: no second 422');
		const id = client.shortToolId('toolu_01ABCdefGHIjkl');
		assert.ok(/^[a-zA-Z0-9]{9}$/.test(id) && id === client.shortToolId('toolu_01ABCdefGHIjkl') && id !== client.shortToolId('toolu_02'));
		assert.ok(client.strictToolIds('https://api.mistral.ai/v1') && !client.strictToolIds('https://api.openai.com/v1'));
		console.log('ok  strict servers: optional fields retried away; Mistral tool ids');

		// Zero-retention routing: an opt-in preference for OpenRouter only — never silently dropped.
		assert.deepStrictEqual(client.providerPrefs('https://openrouter.ai/api/v1', true), { data_collection: 'deny' });
		assert.strictEqual(client.providerPrefs('https://openrouter.ai/api/v1', false), undefined, 'off by default');
		assert.strictEqual(client.providerPrefs('https://api.openai.com/v1', true), undefined, 'direct providers keep their own terms');
		assert.strictEqual(client.providerPrefs('', true), undefined, 'no base URL, no preference');
		console.log('ok  zero-retention: providerPrefs routes OpenRouter to data_collection deny, only when asked');

		// Reasoning is replayed on every turn that produced it, so one turn has
		// the same bytes in every request and the provider's cached prefix holds.
		const turn = [
			{ role: 'user', content: 'old question' },
			{ role: 'assistant', content: '', reasoning: 'OLD plan', toolCalls: [{ id: 'o1', name: 'grep', arguments: '{}' }] },
			{ role: 'tool', toolCallId: 'o1', name: 'grep', content: 'x' },
			{ role: 'assistant', content: 'done', reasoning: 'OLD answer' },
			{ role: 'user', content: 'new question' },
			{ role: 'assistant', content: '', reasoning: 'NEW plan', toolCalls: [{ id: 'n1', name: 'read_file', arguments: '{}' }] },
			{ role: 'tool', toolCallId: 'n1', name: 'read_file', content: 'y' }
		];
		await client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'openai', model: 'thinker', messages: turn });
		const sent = seen.at(-1).json.messages.filter((m) => m.role === 'assistant');
		assert.strictEqual(sent[0].reasoning_content, 'OLD plan', 'earlier turns replay their reasoning');
		assert.strictEqual(sent[1].reasoning_content, 'OLD answer', 'a plain answer replays its reasoning too');
		assert.strictEqual(sent.at(-1).reasoning_content, 'NEW plan', 'current tool step carries its reasoning');
		console.log('ok  reasoning is replayed on every turn, so the request prefix stays byte-identical');

		// Anthropic: thinking, text, tool_use, usage; history conversion
		const r3 = await client.streamChat({ ...common, baseUrl: base, apiFormat: 'anthropic', model: 'c', maxTokens: 100,
			tools: [{ name: 'grep', description: 'd', parameters: { type: 'object' } }],
			messages: [
				{ role: 'assistant', content: 'orphan leading assistant' },
				{ role: 'user', content: 'hi' },
				{ role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'grep', arguments: '{"pattern":"x"}' }, { id: 't2', name: 'grep', arguments: '{}' }] },
				{ role: 'tool', toolCallId: 't1', name: 'grep', content: 'r1' },
				{ role: 'tool', toolCallId: 't2', name: 'grep', content: 'r2' }
			] });
		assert.strictEqual(r3.text, 'Sure'); assert.strictEqual(r3.reasoning, 'plan');
		assert.deepStrictEqual(r3.toolCalls, [{ id: 'toolu_1', name: 'grep', arguments: '{"pattern":"foo"}' }]);
		assert.deepStrictEqual({ input: r3.usage.input, output: r3.usage.output, cached: r3.usage.cached }, { input: 20, output: 9, cached: undefined });
		const req3 = seen.at(-1);
		assert.strictEqual(req3.url, '/v1/messages'); assert.strictEqual(req3.headers['x-api-key'], 'k');
		const msgs = req3.json.messages;
		assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user'], 'alternating, starts with user');
		assert.strictEqual(msgs[1].content.length, 2); assert.strictEqual(msgs[1].content[0].type, 'tool_use');
		assert.deepStrictEqual(msgs[2].content.map((b) => b.type), ['tool_result', 'tool_result'], 'tool results merged');
		assert.strictEqual(req3.json.tools[0].input_schema.type, 'object');
		console.log('ok  anthropic stream + tool_use + history conversion');

		await assert.rejects(client.streamChat({ ...common, baseUrl: base + '/v1', apiFormat: 'anthropic', model: 'boom', messages: [{ role: 'user', content: 'q' }] }), /overloaded/);
		console.log('ok  anthropic stream error surfaces (was swallowed before)');

		// URL normalization + models
		assert.strictEqual(client.anthropicUrl('https://x.com/v1/', 'messages'), 'https://x.com/v1/messages');
		assert.strictEqual(client.anthropicUrl('https://x.com', 'models'), 'https://x.com/v1/models');
		const models = await client.fetchModels(base + '/v1', 'k', 'openai');
		assert.deepStrictEqual(models, [{ id: 'a', contextWindow: 1000 }, { id: 'b', contextWindow: undefined }]);
		console.log('ok  fetchModels dedupe/sort/context');

		const t = await client.testModel({ baseUrl: base + '/v1', apiKey: 'k', apiFormat: 'openai', model: 'x' });
		assert.ok(t.ok, JSON.stringify(t));
		const t2 = await client.testModel({ baseUrl: base + '/v1', apiKey: 'k', apiFormat: 'openai', model: 'm404' });
		assert.ok(!t2.ok);
		const t3 = await client.testModel({ baseUrl: base + '/v1', apiKey: 'k', apiFormat: 'openai', model: 'empty' });
		assert.ok(!t3.ok && /empty response/.test(t3.error), 'a 200 with no tokens is a failure: ' + JSON.stringify(t3));
		console.log('ok  testModel ok/fail/empty');

		// OpenCode Go: the gateway 400s without client identification
		assert.deepStrictEqual(client.opencodeSessionHeaders('https://opencode.ai/zen/go/v1', 'zer0ne-s1'),
			{ 'User-Agent': 'zer0ne-coding', 'x-opencode-session': 'zer0ne-s1' }, 'the conversation key becomes the session id');
		const ocFresh = client.opencodeSessionHeaders('https://opencode.ai/zen/go/v1', undefined);
		assert.match(ocFresh['x-opencode-session'], /^[0-9a-f-]{36}$/, 'a fresh session id per conversation-less call');
		assert.deepStrictEqual(client.opencodeSessionHeaders('https://api.xiaomimimo.com/v1', 'k'), {}, 'other hosts stay untouched');
		console.log('ok  opencode go session header selection');

		// ...and it reaches the wire through the real stream path (mock serves it locally).
		const realFetch = globalThis.fetch;
		let ocSeen;
		globalThis.fetch = (url, init) => (/opencode\.ai/.test(String(url))
			? (ocSeen = { headers: init.headers }, realFetch(base + '/v1/chat/completions', init))
			: realFetch(url, init));
		try {
			await client.streamChat({ ...common, baseUrl: 'https://opencode.ai/zen/go/v1', apiFormat: 'openai', model: 'x', messages: [{ role: 'user', content: 'q' }] });
		} finally { globalThis.fetch = realFetch; }
		assert.ok(ocSeen, 'the opencode.ai call went through fetch');
		assert.strictEqual(ocSeen.headers['User-Agent'], 'zer0ne-coding');
		assert.match(ocSeen.headers['x-opencode-session'], /^[0-9a-f-]{36}$/);
		assert.strictEqual(ocSeen.headers['Authorization'], 'Bearer k');
		console.log('ok  opencode go session header on the wire');
		const compatibility = [];
		const endpoints = [true, false].map(strict => http.createServer((request, response) => {
			let raw = '';
			request.on('data', chunk => raw += chunk);
			request.on('end', () => {
				const body = JSON.parse(raw);
				compatibility.push({ port:request.socket.localPort, path:request.url, body });
				if (strict && request.url.startsWith('/strict/') && body.stream_options) {
					response.writeHead(400, { 'Content-Type':'application/json' });
					return response.end(JSON.stringify({ error:{message:'Unsupported parameter stream_options'} }));
				}
				sse(response, [{ choices:[{delta:{content:'ok'}}] }, ...(body.stream_options ? [{ choices:[], usage:{prompt_tokens:5,completion_tokens:1} }] : []), '[DONE]']);
			});
		}));
		try {
			for (const endpoint of endpoints) await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
			const address = (i, route) => `http://127.0.0.1:${endpoints[i].address().port}/${route}/v1`;
			const call = baseUrl => client.streamChat({ ...common, apiKey:'', baseUrl, apiFormat:'openai', model:'default', messages:[{role:'user',content:'hi'}] });
			await call(address(0, 'strict'));
			const afterRetry = compatibility.length;
			await call(address(0, 'strict') + '/chat/completions');
			assert.equal(compatibility.length, afterRetry + 1, 'equivalent endpoint URLs share their learned refusal');
			for (const baseUrl of [address(0, 'flexible'), address(1, 'strict')]) {
				const result = await call(baseUrl);
				assert.equal(compatibility.at(-1).body.stream_options?.include_usage, true, baseUrl);
				assert.equal(result.usage.input, 5, 'another port or gateway path still reports usage');
			}
		} finally { for (const endpoint of endpoints) { endpoint.closeAllConnections(); await new Promise(resolve => endpoint.close(resolve)); } }

		for (const contentType of ['application/json', 'text/event-stream']) {
			for (const headers of [{}, {'content-length':'1'}]) {
				let cancelled = false;
				const response = new Response(new ReadableStream({
					start(controller) { controller.enqueue(Buffer.from('data: "你好世界"\n')); },
					cancel() { cancelled = true; }
				}), { headers:{...headers,'content-type':contentType} });
				await assert.rejects(client.readSse(response, () => assert.fail('oversized payload must not be delivered'), {maxBytes:12,maxTextChars:100}), /limit/);
				assert.ok(cancelled, 'an undeclared or misleading byte count cannot leave the upstream running');
			}
			const oldIdle = client.WATCHDOG.idleMs;
			client.WATCHDOG.idleMs = 15;
			try {
				let cancelled = false;
				const response = new Response(new ReadableStream({cancel() { cancelled = true; }}), { headers:{'content-type':contentType} });
				await assert.rejects(client.readSse(response, () => {}), /stalled/);
				assert.ok(cancelled, 'JSON fallback and SSE both cancel stalled readers');
			} finally { client.WATCHDOG.idleMs = oldIdle; }
		}
		const unicode = Buffer.from(JSON.stringify({answer:'你好'}));
		const chunks = new ReadableStream({ start(controller) { for (const byte of unicode) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
		let decoded;
		await client.readSse(new Response(chunks, {headers:{'content-type':'application/json'}}), value => decoded = JSON.parse(value));
		assert.equal(decoded.answer, '你好', 'fragmented UTF-8 survives bounded JSON reading');
		await assert.rejects(client.readSse(new Response('"long"', {headers:{'content-type':'application/json'}}), () => {}, {maxBytes:100,maxTextChars:3}), /text limit/);
		console.log('ok endpoint compatibility isolation and bounded JSON/SSE bodies, UTF-8, cancellation and idle timeouts');
		console.log('\nALL CLIENT TESTS PASSED');
	} catch (e) {
		console.error('FAIL', e); process.exitCode = 1;
	} finally { server.close(); }
});
