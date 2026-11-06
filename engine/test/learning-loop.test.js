// Compaction ceiling, MCP 2025-11-25 (tasks, portable schemas), corrections turned into rules
// (command rules, AGENTS.md), and the goal judge's audit against seeded defects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const OUT = path.join(__dirname, '..', 'out');

const stub = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub };

(async () => {
	// ---- compaction starts at the window share or the token ceiling, whichever comes first
	const { compactAt } = require(OUT + '/host/compaction.js');
	assert.equal(compactAt(128_000, { compactThreshold: 80, compactMaxTokens: 200_000 }), 102_400, 'a small window keeps its percentage');
	assert.equal(compactAt(1_000_000, { compactThreshold: 80, compactMaxTokens: 200_000 }), 200_000, 'a huge window compacts at the ceiling');
	assert.equal(compactAt(1_000_000, { compactThreshold: 80, compactMaxTokens: 0 }), 800_000, '0 turns the ceiling off');

	// ---- MCP: 2025-11-25 is offered first; 2020-12 schemas are made portable
	const { MCP_VERSIONS } = require(OUT + '/tools/mcpProtocol.js');
	assert.equal(MCP_VERSIONS[0], '2025-11-25');
	const { portableSchema } = require(OUT + '/tools/mcp.js');
	const schema = portableSchema({
		$schema: 'https://json-schema.org/draft/2020-12/schema',
		type: 'object',
		$defs: { Point: { type: 'object', properties: { x: { type: 'number' } } }, Tree: { type: 'object', properties: { child: { $ref: '#/$defs/Tree' } } } },
		properties: { at: { $ref: '#/$defs/Point', description: 'where' }, tree: { $ref: '#/$defs/Tree' }, $defs: { type: 'string' } }
	});
	assert.equal(schema.$schema, undefined); assert.equal(schema.$defs, undefined);
	assert.deepEqual(schema.properties.at, { type: 'object', properties: { x: { type: 'number' } }, description: 'where' }, 'a local $ref is inlined, its siblings kept');
	assert.deepEqual(schema.properties.tree.properties.child, { type: 'object' }, 'a cycle ends in a plain object');
	assert.deepEqual(schema.properties.$defs, { type: 'string' }, 'a property named like a keyword stays');

	// A task-run tool: started, polled, its result fetched; stopping cancels it on the server.
	const { McpClient } = require(OUT + '/tools/mcpClient.js');
	const client = (statuses, onCall) => {
		const c = new McpClient({ name: 't', transport: 'stdio', command: 'x', args: [], env: {}, url: '', headers: {}, enabled: true, trusted: false }, undefined, () => {});
		Object.assign(c, { protocol: '2025-11-25', capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } } });
		const calls = [];
		c.request = async (method, params) => {
			calls.push([method, params]);
			onCall?.(method);
			if (method === 'tools/call') return params.task ? { task: { taskId: 'T1', status: 'working', pollInterval: 1 } } : { content: [{ type: 'text', text: 'direct' }] };
			if (method === 'tasks/get') return { taskId: 'T1', status: statuses.shift() ?? 'completed', pollInterval: 1 };
			if (method === 'tasks/result') return { content: [{ type: 'text', text: 'from task' }] };
			if (method === 'tasks/cancel') return {};
			throw new Error('unexpected ' + method);
		};
		return { c, calls };
	};
	let { c, calls } = client(['working', 'completed']);
	assert.equal((await c.callTool({ name: 'build', taskSupport: 'optional' }, { a: 1 })).content[0].text, 'from task');
	assert.deepEqual(calls.map(([m]) => m), ['tools/call', 'tasks/get', 'tasks/get', 'tasks/result']);
	assert.equal(calls[0][1].task.ttl > 0, true, 'the call asks for a task');
	({ c, calls } = client([]));
	assert.equal((await c.callTool({ name: 'quick' }, {})).content[0].text, 'direct', 'a tool without task support is called as before');
	assert.equal(calls[0][1].task, undefined);
	({ c, calls } = client(['input_required']));
	await assert.rejects(c.callTool({ name: 'ask', taskSupport: 'required' }, {}), /asked for input/);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.at(-1)[0], 'tasks/cancel', 'a task zer0ne cannot finish is cancelled');
	const stop = new AbortController();
	({ c, calls } = client(['working', 'working', 'working'], (m) => { if (m === 'tasks/get') stop.abort(); }));
	await assert.rejects(c.callTool({ name: 'long', taskSupport: 'required' }, {}, stop.signal));
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(calls.at(-1)[0], 'tasks/cancel', 'stopping cancels the task');

	// ---- corrections become rules: a rejected command → an ask/deny line; a memory → AGENTS.md
	const { addCommandRule, commandVerdict, readCommandRules, COMMAND_RULES_FILE } = require(OUT + '/tools/commandRules.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-learn-'));
	assert.equal(addCommandRule(root, 'deny', 'git push*'), true);
	assert.equal(addCommandRule(root, 'deny', 'git  push*'), false, 'the same rule is not added twice');
	assert.equal(addCommandRule(root, 'ask', 'npm publish*'), true);
	assert.equal(commandVerdict(readCommandRules(root), 'git push --force'), 'deny', 'a new deny line applies without trust');
	assert.equal(commandVerdict(readCommandRules(root), 'npm publish'), 'ask');
	assert.match(fs.readFileSync(path.join(root, COMMAND_RULES_FILE), 'utf8'), /^# Command rules[^\n]*\ndeny: git push\*\nask: npm publish\*\n$/);
	assert.throws(() => addCommandRule(root, 'deny', 'rm\nallow: *'), /one line/);

	const { addProjectInstruction } = require(OUT + '/host/projectRules.js');
	fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\r\n\r\nUse tabs.\r\n');
	assert.equal(addProjectInstruction(root, 'Run   pnpm, not npm.'), true);
	assert.equal(addProjectInstruction(root, 'Never edit generated files in out/.'), true);
	assert.equal(addProjectInstruction(root, 'Run pnpm, not npm.'), false, 'a line already there is not repeated');
	assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '# Rules\r\n\r\nUse tabs.\r\n\r\n## Learned from corrections\r\n\r\n- Run pnpm, not npm.\r\n- Never edit generated files in out/.\r\n', 'one section, the file\'s own line endings');
	const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-learn-'));
	addProjectInstruction(fresh, 'Prefer small commits.');
	assert.equal(fs.readFileSync(path.join(fresh, 'AGENTS.md'), 'utf8'), '## Learned from corrections\n\n- Prefer small commits.\n');

	// ---- the goal judge audit: seeded defects must be caught, finished work accepted
	const { auditJudge, loadJudgeCases, parseJudgeCases } = require(OUT + '/eval/judgeAudit.js');
	const cases = loadJudgeCases(path.join(__dirname, '..', 'eval', 'judge'));
	const defects = cases.filter((x) => x.expect === 'not met');
	assert(defects.length >= 10 && cases.length - defects.length >= 3, 'enough seeded defects and controls');
	assert(defects.every((x) => x.defect), 'each defect is named');
	const yes = await auditJudge(cases, async () => ({ met: true, missing: '', evidence: '' }));
	assert.equal(yes.caught, 0, 'a judge that approves everything catches nothing');
	assert.equal(yes.controlsPassed, yes.controls);
	assert.equal(yes.misses.length, defects.length);
	const no = await auditJudge(cases, async () => ({ met: false, missing: 'x', evidence: '' }));
	assert.equal(no.caught, no.defects); assert.equal(no.controlsPassed, 0, 'one that rejects everything fails the controls');
	const perfect = await auditJudge(cases, async (x) => ({ met: x.expect === 'met', missing: x.expect === 'met' ? '' : 'x', evidence: '' }));
	assert.deepEqual([perfect.caught, perfect.controlsPassed, perfect.misses.length], [perfect.defects, perfect.controls, 0]);
	const silent = await auditJudge(cases.slice(0, 2), async () => { throw new Error('offline'); });
	assert.deepEqual([silent.unanswered, silent.caught], [2, 0], 'no answer never counts as a catch');
	assert.throws(() => parseJudgeCases([{ id: 'a', goal: 'g', record: 'r', expect: 'not met' }]), /seeded defect/);
	const { judgeMessage } = require(OUT + '/host/goal.js');
	assert.equal(judgeMessage('G', 'R'), 'Goal: G\n\nRecord of the work:\n\nR');

	console.log('Learning loop passed: compaction ceiling, MCP tasks and portable schemas, rejected commands and memories as rules, judge audit.');
})().catch((error) => { console.error(error); process.exit(1); });
