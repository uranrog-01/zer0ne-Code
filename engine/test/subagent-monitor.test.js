// Focused runtime/payload contract tests. Run after npm run compile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-sag-'));
const shim = require('./vscode-shim').createShim({ dataDir: dir }).vscode;
const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, ...rest) { return name === 'vscode' ? 'vscode' : resolve.call(this, name, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: shim };
const { AgentRegistry, TurnAgents, agentMonitorPayload } = require('../out/host/turnAgents');
const { ProviderStore } = require('../out/providerStore');
const { ToolScheduler } = require('../out/core/toolScheduler');

(async () => {
	try {
		const run = { id: 'a1', sessionId: 's1', kind: 'subagent', description: 'Task', agentName: 'Explore', prompt: '<prompt>', parentId: 'a0', providerId: 'provider', providerName: 'Actual provider', status: 'running', background: true, stats: { input: 0, output: 0, cached: 0, turns: 0, toolUses: 0, startedAt: 100, ms: 0 }, card: { tool: { summary: 'Working' } }, msgs: [{ role: 'user', content: 'private transcript' }], stop: new AbortController(), apiKey: 'secret', tools: [{ id: 'c1', name: 'read_file', args: 'a.ts', status: 'completed', startedAt: 100, endedAt: 200, summary: 'Read' }] };
		let payload = agentMonitorPayload(run, 1100);
		assert.equal(payload.stats.ms, 1000);
		assert.equal(payload.parentSessionId, 's1');
		assert.equal(payload.prompt, '<prompt>');
		assert.equal(payload.providerName, 'Actual provider');
		assert.equal(payload.stats.input, undefined, 'no usage is not a reported zero');
		assert.equal(payload.stats.usageCoverage, 'not-reported');
		assert.equal(payload.stats.toolUses, 0, 'runtime knows zero tool calls');
		assert.ok(!('msgs' in payload) && !('apiKey' in payload) && !('stop' in payload));
		payload.tools[0].summary = 'Changed'; assert.equal(run.tools[0].summary, 'Read');
		run.stats.usageTurns = 1; run.stats.turns = 2;
		payload = agentMonitorPayload(run); assert.equal(payload.stats.input, 0); assert.equal(payload.stats.cached, undefined, 'absent cache metrics are not zero'); assert.equal(payload.stats.usageCoverage, 'partial');
		run.stats.cachedReported = true; assert.equal(agentMonitorPayload(run).stats.cached, 0);
		run.stats.usageTurns = 2; run.status = 'completed'; run.endedAt = 200; run.stats.ms = 100; run.report = 'Genuine report';
		payload = agentMonitorPayload(run); assert.equal(payload.stats.usageCoverage, 'complete'); assert.equal(payload.stats.ms, 100); assert.equal(payload.report, 'Genuine report');
		payload = agentMonitorPayload({ ...run, kind: 'writer', stats: { ...run.stats, usageTurns: undefined, toolUses: 8 } });
		assert.equal(payload.stats.writerSteps, 8); assert.equal(payload.stats.toolUses, undefined); assert.equal(payload.stats.turns, undefined); assert.equal(payload.stats.output, undefined);
		const controller = fs.readFileSync(path.join(__dirname, '../src/chatController.ts'), 'utf8');
		assert.equal((controller.match(/\.map\(\(run\) => agentMonitorPayload\(run\)\)/g) || []).length, 2, 'initial state and polling use the same payload');

		// Exercise actual subagent start, routed metadata, tool lifecycle, resume and error paths.
		const state = new Map(), memento = { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) };
		const store = new ProviderStore({ globalState: memento, workspaceState: memento, secrets: { get: async () => 'key', store: async () => {}, delete: async () => {} }, globalStorageUri: shim.Uri.file(dir) });
		await store.updateSettings({ subagents: true, skills: false, includeAgentsMd: false, hybrid: false });
		const provider = await store.add({ name: 'Runtime provider', baseUrl: 'https://example.invalid/v1', apiFormat: 'openai', models: [{ id: 'runtime-model' }] });
		const registry = new AgentRegistry(); let calls = 0, liveTool = false, shouldFail = false;
		const services = { store, registry, plugins: { agents: () => [] }, mcp: {}, browser: {}, skills: {}, writers: {}, storageDir: dir, extensionDir: path.join(__dirname, '..'), hooks: () => [], hookBase: {}, scheduleState() {}, tools: { runWithGates: async () => { liveTool = registry.list()[0].tools[0].status === 'running'; return { api: 'contents', summary: 'Read file' }; } }, callModel: async () => { if (shouldFail) throw new Error('Provider unavailable'); calls++; return calls === 1 ? { text: '', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }], usage: { input: 10, output: 2 } } : { text: 'Actual findings', toolCalls: [], usage: { input: 20, output: 4 } }; } };
		const info = { sessionId: 'runtime-chat', convo: [], provider, model: provider.models[0], apiKey: 'key', settings: store.getSettings(), signal: new AbortController().signal };
		services.tools.scheduler = new ToolScheduler();
		const agents = new TurnAgents(services, info), ctx = { settings: info.settings, signal: info.signal, requestApproval: async () => ({ approved: false, finish() {} }) };
		agents.attach(ctx);
		const result = await ctx.runSubagent('Inspect file', 'Read and summarize');
		const actual = registry.list()[0]; assert.equal(actual.prompt, 'Read and summarize'); assert.equal(actual.providerId, provider.id); assert.equal(actual.providerName, 'Runtime provider'); assert.ok(actual.endedAt >= actual.stats.startedAt); assert.equal(actual.report, 'Actual findings'); assert.ok(liveTool); assert.equal(actual.tools[0].status, 'completed'); assert.equal(actual.tools[0].summary, 'Read file'); assert.equal(actual.stats.input, 30); assert.match(result, /Actual findings/);
		assert.equal(agentMonitorPayload(actual).stats.usageCoverage, 'complete');
		await ctx.sendToAgent(actual.id, 'Continue review', false); assert.equal(registry.list().length, 1, 'continuation preserves run identity'); assert.ok(actual.msgs.some(m => String(m.content).includes('Continue review')));
		shouldFail = true; await ctx.sendToAgent(actual.id, 'Retry', false); assert.equal(actual.status, 'failed'); assert.equal(actual.error, 'Provider unavailable'); assert.equal(actual.report, undefined, 'failed continuation cannot display an old completed report');
		assert.equal(registry.stopOne(actual.id), false);

		// Steering receipts: queued → read when the agent's next step drains the inbox;
		// an instruction that outlives the run is swept to missed, never silently dropped.
		const receiptCtx = (sessionId, callModel) => {
			const receiptRegistry = new AgentRegistry();
			const receiptServices = { store, registry: receiptRegistry, plugins: { agents: () => [] }, mcp: {}, browser: {}, skills: {}, writers: {}, storageDir: dir, extensionDir: path.join(__dirname, '..'), hooks: () => [], hookBase: {}, scheduleState() {}, tools: { runWithGates: async () => ({ api: 'contents', summary: 'Read file' }), scheduler: new ToolScheduler() }, callModel };
			const receiptInfo = { sessionId, convo: [], provider, model: provider.models[0], apiKey: 'key', settings: store.getSettings(), signal: new AbortController().signal };
			const receiptAgents = new TurnAgents(receiptServices, receiptInfo);
			const receiptToolCtx = { settings: receiptInfo.settings, signal: receiptInfo.signal, requestApproval: async () => ({ approved: false, finish() {} }) };
			receiptAgents.attach(receiptToolCtx);
			return { registry: receiptRegistry, ctx: receiptToolCtx };
		};
		const waitTurn = async (run, n) => { while (run.stats.turns < n) await new Promise((resolve) => setTimeout(resolve, 5)); };
		{
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			let calls = 0;
			const { registry: readRegistry, ctx: readCtx } = receiptCtx('receipt-read', async () => {
				const step = ++calls;
				if (step === 2) await gate;
				return step < 3 ? { text: '', toolCalls: [{ id: 'c' + step, name: 'read_file', args: { path: 'a.ts' } }], usage: { input: 5, output: 1 } } : { text: 'Receipt done', toolCalls: [], usage: { input: 5, output: 2 } };
			});
			const readId = readCtx.spawnSubagent('Receipt read', 'Work until told otherwise');
			const readRun = readRegistry.get(readId);
			await waitTurn(readRun, 1);
			await readCtx.sendToAgent(readId, 'Then stop after this file', true);
			assert.equal(readRun.steerReceipts[0].state, 'queued', 'a sent instruction starts as queued');
			release();
			await readRun.promise;
			assert.equal(readRun.steerReceipts[0].state, 'read', 'the next step drains the inbox and marks it read');
			assert.deepEqual(agentMonitorPayload(readRun).steerReceipts, [{ text: 'Then stop after this file', state: 'read' }]);
		}
		{
			let release;
			const gate = new Promise((resolve) => (release = resolve));
			const { registry: failRegistry, ctx: failCtx } = receiptCtx('receipt-fail', async () => {
				await gate;
				throw new Error('Provider unavailable');
			});
			const failId = failCtx.spawnSubagent('Receipt missed', 'Work until told otherwise');
			const failRun = failRegistry.get(failId);
			await new Promise((resolve) => setTimeout(resolve, 25));
			await failCtx.sendToAgent(failId, 'Do this instead', true);
			assert.equal(failRun.steerReceipts[0].state, 'queued');
			release();
			await failRun.promise;
			assert.equal(failRun.status, 'failed');
			assert.equal(failRun.steerReceipts[0].state, 'missed', 'a run that ends with the instruction queued reports it as missed');
		}

		console.log('Subagent monitor runtime/payload passed: metadata, honest metrics, tool activity, shared projection, continuation, errors and steering receipts.');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
