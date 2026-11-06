// Prompt-cache reuse: how much of each request the provider can serve from its cache.
//
// A prefix-caching provider (DeepSeek, Anthropic, [OI], …) serves a request from cache
// only up to the first token that differs from an already-persisted prefix. So the number
// that predicts the bill is the share of the later request that is byte-identical to the
// earlier one, measured over the parts the provider tokenizes in order:
// tools → system → messages.
//
// This suite measures that share on real request bodies for the two shapes where the
// prefix used to break: a new turn (which used to drop the previous turn's thinking) and
// a compaction summary request (which used to start from a different system prompt).
const assert = require('assert');
const http = require('http');
const path = require('path');
const client = require(path.join(__dirname, '..', 'out') + '/chatClient.js');

const seen = [];
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		seen.push(JSON.parse(body));
		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
		res.end('data: [DONE]\n\n');
	});
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** Bytes of the leading messages two requests share (the provider's cached region). */
function sharedMessageChars(a, b) {
	const size = (m) => JSON.stringify(m).length;
	let shared = 0;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) break;
		shared += size(a[i]);
	}
	return shared;
}

const totalChars = (messages) => messages.reduce((n, m) => n + JSON.stringify(m).length, 0);

/** Share of `later`'s prompt that `earlier` already sent, byte for byte. */
function carriedOver(earlier, later) {
	const total = totalChars(later);
	return total ? sharedMessageChars(earlier, later) / total : 1;
}

/** True when the earlier request is a strict prefix of the later one. */
function extendsPrefix(earlier, later) {
	return sharedMessageChars(earlier, later) === totalChars(earlier);
}

// Realistic sizes for a coding agent on a reasoning model.
const SYSTEM = 'You are zer0ne, an expert autonomous coding agent.\n' + 'How to work: investigate, edit, verify.\n'.repeat(80);
const TOOLS = Array.from({ length: 8 }, (_, i) => ({
	name: 'tool_' + i,
	description: 'Does thing ' + i + '. '.repeat(20),
	parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }
}));
const user = (t) => ({ role: 'user', content: t });
const plan = (r) => ({ role: 'assistant', content: '', reasoning: r, toolCalls: [{ id: 'c' + r.length, name: 'tool_0', arguments: '{"path":"src/a.ts"}' }] });
const result = (t) => ({ role: 'tool', toolCallId: 'c' + t.length, name: 'tool_0', content: t });
const answer = (text, r) => ({ role: 'assistant', content: text, reasoning: r });

/** Emulate the pre-fix serializer: reasoning only on turns after the last user message. */
function stripOldReasoning(messages) {
	let lastUser = -1;
	messages.forEach((m, i) => m.role === 'user' && (lastUser = i));
	return messages.map((m, i) => (m.role === 'assistant' && i <= lastUser ? { ...m, reasoning: undefined } : m));
}

async function wire(messages, base, system = SYSTEM, tools = TOOLS) {
	await client.streamChat({ baseUrl: base + '/v1', apiKey: 'k', apiFormat: 'openai', model: 'm', system, tools, messages, maxTokens: 100, signal: new AbortController().signal });
	return seen.at(-1);
}

/** The requests an agent actually sends, one per step, for a two-turn session. */
function session() {
	const u1 = user('Fix the failing test in src/a.ts');
	const p1 = plan('Read the file first, then look at the assertion. '.repeat(20));
	const t1 = result('export function a() { return 1; } // 3 KB of source\n'.repeat(60));
	const a1 = answer('The test expected 2. I changed the return value. '.repeat(12), 'The fix is a one-line change. '.repeat(10));
	const u2 = user('Now add a test for the zero case');
	const p2 = plan('Write the new case next to the existing one. '.repeat(20));
	const t2 = result('it("returns zero", () => { expect(a(0)).toBe(0); });\n'.repeat(20));
	const a2 = answer('Added the zero case to the suite. '.repeat(10), 'The suite now covers zero. '.repeat(10));
	return [
		[u1],
		[u1, p1],
		[u1, p1, t1],
		[u1, p1, t1, a1],
		[u1, p1, t1, a1, u2],
		[u1, p1, t1, a1, u2, p2],
		[u1, p1, t1, a1, u2, p2, t2],
		[u1, p1, t1, a1, u2, p2, t2, a2]
	];
}

test('reasoning replay keeps the whole previous turn inside the cacheable prefix', async () => {
	const base = 'http://127.0.0.1:' + server.address().port;
	const steps = session();
	const now = [];
	const before = [];
	for (const step of steps) {
		now.push((await wire(step, base)).messages);
		before.push((await wire(stripOldReasoning(step), base)).messages);
	}
	const rates = (bodies) => bodies.slice(1).map((body, i) => carriedOver(bodies[i], body));
	const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
	const wasRate = avg(rates(before));
	const nowRate = avg(rates(now));
	console.log(`  per-step prompt carried over: ${(wasRate * 100).toFixed(1)}% before, ${(nowRate * 100).toFixed(1)}% now`);
	// The invariant the serializer must hold: each request is the previous one, extended.
	const extendsAll = now.slice(1).every((body, i) => extendsPrefix(now[i], body));
	assert.ok(extendsAll, 'every step is the previous request plus new messages: ' + rates(now).map((r) => r.toFixed(3)).join(' '));
	assert.ok(!before.slice(1).every((body, i) => extendsPrefix(before[i], body)), 'the old serializer did not hold it (the regression this pins)');
	assert.ok(nowRate > wasRate, `carried-over share improved: ${(nowRate * 100).toFixed(1)}% > ${(wasRate * 100).toFixed(1)}%`);
	console.log('ok  reasoning replay: every step is a byte-exact extension of the previous one');
});

test('a compaction summary request shares the conversation prefix instead of starting over', async () => {
	const base = 'http://127.0.0.1:' + server.address().port;
	const steps = session();
	const conversation = await wire(steps.at(-1), base);
	// Old shape: a summarizer system prompt plus the history flattened into one user message.
	const flattened = steps.at(-1).map((m) => m.role.toUpperCase() + ': ' + (m.content || '')).join('\n\n');
	const oldSummary = await wire([{ role: 'user', content: 'Conversation to summarize:\n\n' + flattened }], base, 'You compress coding conversations.');
	// New shape: the conversation's own system prompt and tools, the region replayed, the
	// instruction appended as the last message.
	const region = steps.at(-1).slice(0, -2);
	const newSummary = await wire([...region, { role: 'user', content: 'You are now acting as a compaction engine.' }], base);
	const oldShared = oldSummary.system === conversation.system ? carriedOver(conversation.messages, oldSummary.messages) : 0;
	const newShared = carriedOver(conversation.messages, newSummary.messages);
	console.log(`  summary request served from cache: ${(oldShared * 100).toFixed(1)}% before, ${(newShared * 100).toFixed(1)}% now`);
	assert.strictEqual(oldShared, 0, 'the old summarizer prompt shared nothing: a different first token');
	// Everything but the trailing instruction is the conversation's own bytes.
	assert.ok(newShared > 0.99, 'the summary replays the conversation prefix: ' + newShared.toFixed(3));
	assert.ok(extendsPrefix(conversation.messages.slice(0, region.length), newSummary.messages), 'the replayed region is a byte-exact prefix of the conversation');
	console.log('ok  compaction: the summary request replays the conversation prefix');
});

test('the prefix-stability diagnostic names the real cause of a break', async () => {
	// What the chat shows as "Request prefix stable N%" / "Last change: …" is what a
	// user reads to explain a bad cache number, so it must attribute the cause right.
	const { serializedRequest } = require(path.join(__dirname, '..', 'out') + '/requestDiagnostics.js');
	const base = 'http://127.0.0.1:' + server.address().port;
	const url = base + '/v1/chat/completions';
	const u1 = user('one');
	const a1 = answer('done', 'my thinking');
	// A session grows: appending a turn is not a break.
	serializedRequest(url, await wire([u1], base), 'grow');
	const grown = serializedRequest(url, await wire([u1, a1], base), 'grow');
	assert.strictEqual(grown.changed, undefined, 'a new turn that replays its thinking is stable');
	assert.strictEqual(grown.prefixStable, true);
	// Dropping the previous turn's thinking is a history break, at that turn.
	const stripped = serializedRequest(url, await wire([u1, { ...a1, reasoning: undefined }], base), 'grow');
	assert.match(String(stripped.changed), /^history message \d+$/, 'the old serializer broke at the answer: ' + stripped.changed);
	assert.strictEqual(stripped.prefixStable, false);
	// A changed system prompt and a changed tool list are breaks at the head, named.
	serializedRequest(url, await wire([u1], base), 'head');
	const system = serializedRequest(url, await wire([u1], base, SYSTEM + '\n'), 'head');
	assert.strictEqual(system.changed, 'system', 'a changed system prompt is named');
	const tools = serializedRequest(url, await wire([u1], base, SYSTEM + '\n', TOOLS.slice(1)), 'head');
	assert.strictEqual(tools.changed, 'tools', 'a changed tool list is named');
	const same = serializedRequest(url, await wire([u1], base, SYSTEM + '\n', TOOLS.slice(1)), 'head');
	assert.strictEqual(same.changed, undefined, 'an unchanged head stays stable');
	console.log('ok  the diagnostic names the cause: history message N, system, tools');
});

(async () => {
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n ' + (e && e.stack ? e.stack : e));
		}
	}
	server.close();
	process.exit(failed ? 1 : 0);
})();
