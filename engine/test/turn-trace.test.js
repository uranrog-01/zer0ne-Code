// The turn trace: the JSONL file, and the OpenTelemetry export built from the same events.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_ENGINE_OUT || path.join(__dirname, '..', 'out');
const { createTurnTrace, toOtlp, otlpUrl } = require(OUT + '/host/turnTrace.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const events = (t0) => [
	{ t: t0, kind: 'turn_start', promptChars: 42, plan: false, model: 'm1' },
	{ t: t0 + 900, kind: 'request', step: 1, providerId: 'p', model: 'm1', input: 1000, output: 50, cached: 600, stopReason: 'tool_use' },
	{ t: t0 + 1500, kind: 'tool', step: 1, name: 'read_file', ms: 400, outcome: 'completed', summaryChars: 0, startedAt: t0 + 1000 },
	{ t: t0 + 1600, kind: 'tool', step: 1, name: 'run_command', ms: 100, outcome: 'failed', summaryChars: 0 },
	{ t: t0 + 2400, kind: 'request', step: 2, providerId: 'p', model: 'm1', input: 1200, output: 80, error: 'boom' },
	{ t: t0 + 2500, kind: 'turn_end', outcome: 'failed', steps: 2, tokensIn: 2200, tokensOut: 130 }
];

test('toOtlp: one root span, a chat span per request and an execute_tool span per tool', () => {
	const t0 = 1_700_000_000_000;
	const doc = toOtlp(events(t0), { sessionId: 's1', turnId: 'u1', version: '1.2.3' });
	const rs = doc.resourceSpans[0];
	assert.deepEqual(rs.resource.attributes.map((a) => a.key), ['service.name', 'service.version']);
	const spans = rs.scopeSpans[0].spans;
	assert.equal(spans.length, 5);
	const [root, chat1, read, cmd, chat2] = spans;
	assert.equal(root.name, 'invoke_agent zer0ne');
	assert.match(root.traceId, /^[a-f0-9]{32}$/);
	assert.equal(toOtlp(events(t0), { sessionId: 's1', turnId: 'u1' }).resourceSpans[0].scopeSpans[0].spans[0].traceId, root.traceId, 'the same turn keeps its trace id');
	assert.ok(spans.slice(1).every((s) => s.parentSpanId === root.spanId && s.traceId === root.traceId));
	assert.equal(root.status.code, 2, 'a failed turn is an error span');
	assert.equal(root.startTimeUnixNano, `${t0}000000`);
	assert.equal(root.endTimeUnixNano, `${t0 + 2500}000000`);
	const val = (span, key) => { const a = span.attributes.find((x) => x.key === key); return a && (a.value.stringValue ?? a.value.intValue ?? a.value.boolValue); };
	assert.equal(val(root, 'gen_ai.usage.input_tokens'), '2200');
	assert.equal(chat1.name, 'chat m1');
	assert.equal(val(chat1, 'gen_ai.operation.name'), 'chat');
	assert.equal(val(chat1, 'zer0ne.usage.cached_tokens'), '600');
	assert.equal(chat1.startTimeUnixNano, `${t0}000000`, 'a request starts where the previous event ended');
	assert.equal(read.name, 'execute_tool read_file');
	assert.equal(read.startTimeUnixNano, `${t0 + 1000}000000`);
	assert.equal(read.endTimeUnixNano, `${t0 + 1400}000000`);
	assert.equal(cmd.status.code, 2);
	assert.equal(chat2.status.code, 2);
	assert.doesNotMatch(JSON.stringify(doc), /"(prompt|content|text)"/, 'no message text is exported');
});

test('otlpUrl: http(s) only, a bare collector gets /v1/traces', () => {
	assert.equal(otlpUrl('http://localhost:4318'), 'http://localhost:4318/v1/traces');
	assert.equal(otlpUrl(' https://otel.example.com/v1/traces '), 'https://otel.example.com/v1/traces');
	assert.equal(otlpUrl('file:///etc/passwd'), undefined);
	assert.equal(otlpUrl('not a url'), undefined);
	assert.equal(otlpUrl(''), undefined);
});

test('createTurnTrace: off without a folder or endpoint; the export posts once on close', async () => {
	const saved = process.env.ZER0NE_TRACE_DIR;
	delete process.env.ZER0NE_TRACE_DIR;
	try {
		assert.equal(createTurnTrace(undefined, 's', 'u'), undefined);
		assert.equal(createTurnTrace(undefined, 's', 'u', { endpoint: 'ftp://x' }), undefined, 'an unusable endpoint is off');
		const posts = [];
		const trace = createTurnTrace(undefined, 's', 'u', { endpoint: 'http://127.0.0.1:4318', post: async (url, body) => posts.push([url, JSON.parse(body)]) });
		trace.write({ kind: 'turn_start', promptChars: 1, plan: false, model: 'm' });
		trace.write({ kind: 'turn_end', outcome: 'completed', steps: 1, tokensIn: 1, tokensOut: 1 });
		trace.close(); trace.close();
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(posts.length, 1);
		assert.equal(posts[0][0], 'http://127.0.0.1:4318/v1/traces');
		assert.equal(posts[0][1].resourceSpans[0].scopeSpans[0].spans[0].status.code, 1);
		const failing = createTurnTrace(undefined, 's', 'u2', { endpoint: 'http://127.0.0.1:1', post: async () => { throw new Error('collector down'); } });
		failing.write({ kind: 'turn_end', outcome: 'completed', steps: 0, tokensIn: 0, tokensOut: 0 });
		failing.close();
		await new Promise((r) => setTimeout(r, 20));
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-trace-'));
		const file = createTurnTrace(dir, 's/x', 'u');
		file.write({ kind: 'steer', chars: 3 });
		const lines = fs.readFileSync(path.join(dir, 's_x-u.jsonl'), 'utf8').trim().split('\n');
		assert.equal(JSON.parse(lines[0]).kind, 'steer');
		fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		if (saved !== undefined) process.env.ZER0NE_TRACE_DIR = saved;
	}
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n ' + (e && e.stack ? e.stack : e));
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
