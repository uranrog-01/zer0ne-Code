// The MCP server protocol layer, offline: initialize negotiation, tools/list,
// tools/call validation and routing against injected fake deps — no engine, no
// network. The stdio loop is covered by a line-level test with a fake stream.
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.ZER0NE_ENGINE_OUT || path.join(__dirname, '..', 'out');
const { handle, start, TOOLS } = require(OUT + '/mcpServer.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const deps = (over = {}) => ({
	version: '9.9.9',
	cwd: () => os.tmpdir(),
	write: () => undefined,
	runPrompt: async () => ({ outcome: 'completed', text: 'did it' }),
	...over
});

const call = async (msg, d = deps()) => handle(msg, d);

test('initialize negotiates a known protocol version and identifies zer0ne', async () => {
	const r = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
	assert.equal(r.result.protocolVersion, '2025-06-18');
	assert.equal(r.result.serverInfo.name, 'zer0ne');
	assert.equal(r.result.serverInfo.version, '9.9.9');
	assert.ok(r.result.capabilities.tools, 'tools capability declared');
	const unknown = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
	assert.notEqual(unknown.result.protocolVersion, '1999-01-01', 'an unknown version falls back');
});

test('notifications get no reply; ping and tools/list answer', async () => {
	assert.equal(await call({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
	const ping = await call({ jsonrpc: '2.0', id: 3, method: 'ping' });
	assert.deepEqual(ping.result, {});
	const list = await call({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
	assert.ok(list.result.tools.some((t) => t.name === 'zer0ne_prompt'));
});

test('zer0ne_prompt runs the engine with the requested project and timeout', async () => {
	let seen;
	const d = deps({ runPrompt: async (prompt, project, timeoutSec) => { seen = { prompt, project, timeoutSec }; return { outcome: 'completed', text: 'patched', files: ['a.ts'] }; } });
	const r = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'zer0ne_prompt', arguments: { prompt: 'fix it', project: os.tmpdir(), timeout_seconds: 90 } } }, d);
	assert.equal(r.result.isError, false, 'a completed run is not an error');
	assert.ok(r.result.content[0].text.includes('patched'), 'the answer is returned');
	assert.ok(r.result.content[0].text.includes('a.ts'), 'changed files are listed');
	assert.equal(seen.project, path.resolve(os.tmpdir()), 'the project path is resolved');
	assert.equal(seen.timeoutSec, 90, 'the timeout passes through');
});

test('zer0ne_prompt validates prompt, project and timeout', async () => {
	const empty = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'zer0ne_prompt', arguments: { prompt: '  ' } } });
	assert.equal(empty.result.isError, true, 'an empty prompt is refused');
	const missing = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'zer0ne_prompt', arguments: { prompt: 'x', project: path.join(os.tmpdir(), 'definitely-missing-folder') } } });
	assert.ok(missing.result.content[0].text.includes('not an accessible directory'), 'a bad project is refused');
	const tooLong = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'zer0ne_prompt', arguments: { prompt: 'x'.repeat(100_001) } } });
	assert.ok(tooLong.result.content[0].text.includes('limit'), 'an oversized prompt is refused');
	const unknown = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nope' } });
	assert.equal(unknown.result.isError, true, 'an unknown tool is refused without throwing');
});

test('engine failures surface as tool errors, not protocol crashes', async () => {
	const d = deps({ runPrompt: async () => { throw new Error('engine exploded'); } });
	const r = await call({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'zer0ne_prompt', arguments: { prompt: 'work' } } }, d);
	assert.equal(r.result.isError, true);
	assert.ok(r.result.content[0].text.includes('engine exploded'));
});

test('unknown methods answer -32601; malformed requests answer -32600', async () => {
	const r = await call({ jsonrpc: '2.0', id: 11, method: 'workspace/x' });
	assert.equal(r.error.code, -32601, 'unknown method');
	const bad = await call({ jsonrpc: '1.0', id: 12, method: 'ping' });
	assert.equal(bad.error.code, -32600, 'invalid request');
});

test('start() answers line-delimited requests on a fake stream', async () => {
	const stream = new EventEmitter();
	const written = [];
	const running = start(deps({ write: (c) => written.push(c) }), stream);
	stream.setEncoding = () => undefined;
	stream.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
	stream.emit('end');
	await running;
	assert.equal(written.length, 1, 'one reply');
	assert.ok(JSON.parse(written[0]).result.tools.length >= 1, 'the reply is on the wire');
});

test('the shipped TOOLS schema is well-formed for MCP clients', () => {
	for (const t of TOOLS) {
		assert.equal(t.inputSchema.type, 'object');
		assert.ok(t.description.length > 20, `${t.name} has a description`);
	}
	assert.ok(fs && typeof fs.statSync === 'function', 'fs available for path checks');
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
	process.exit(failed ? 1 : 0);
})();
