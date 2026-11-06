// Headless end-to-end test of out/chatController.js with a fake `vscode` module,
// a temp workspace and a scripted mock LLM (OpenAI + Anthropic formats).
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const assert = require('assert');

const OUT = require('path').join(__dirname, '..', 'out') + '';

// Use the ripgrep binary VS Code ships, when we can find one (search tests).
(() => {
	if (process.env.ZER0NE_RG) return;
	const bases = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code'), 'C:/Program Files/Microsoft VS Code', '/usr/share/code', '/Applications/Visual Studio Code.app/Contents/Resources/app'];
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const tails = [['node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', process.platform + '-' + process.arch, exe], ['node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe], ['node_modules', '@vscode', 'ripgrep', 'bin', exe]];
	for (const base of bases) {
		let dirs = [];
		try { dirs = [base, ...fs.readdirSync(base).map((d) => path.join(base, d))]; } catch { continue; }
		for (const d of dirs) for (const root of [path.join(d, 'resources', 'app'), d]) for (const t of tails) {
			const p = path.join(root, ...t);
			if (fs.existsSync(p)) { process.env.ZER0NE_RG = p; return; }
		}
	}
})();
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zws-'));
// Personal agent/skill catalogs must not affect fixture prompts, timing or tool names.
const fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zhome-'));
const realHomedir = os.homedir;
os.homedir = () => fixtureHome;
fs.writeFileSync(path.join(ws, 'a.ts'), 'const x = 1;\r\nconst y = 2;\r\n');
fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'Use tabs.');

// ---------------- fake vscode
class Uri {
	constructor(fsPath) { this.fsPath = path.resolve(fsPath); this.scheme = 'file'; this.path = this.fsPath.replace(/\\/g, '/'); }
	static file(p) { return new Uri(p); }
	static joinPath(u, ...parts) { return new Uri(path.join(u.fsPath, ...parts)); }
	static parse(s) { return { toString: () => s }; }
	static from(o) { return { ...o, toString: () => o.scheme + ':' + o.path + '?' + (o.query || '') }; }
	toString() { return 'file://' + this.path; }
}
const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : d), update: async (k, v) => (v === undefined ? m.delete(k) : m.set(k, JSON.parse(JSON.stringify(v)))), keys: () => [...m.keys()] }; };
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
// VS Code glob semantics for findFiles: * and ? stay inside a folder, ** spans folders, {a,b} alternates.
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]*)\}/g, (_, alts) => '(' + alts.split(',').join('|') + ')').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
const findFiles = async (include, exclude) => {
	const inc = include && typeof include === 'object' ? include.pattern : include || '**/*';
	const exc = exclude && typeof exclude === 'object' ? exclude.pattern : exclude;
	const incRe = globToRe(inc);
	const excRe = exc ? globToRe(exc) : null;
	return walk(ws).map((p) => path.relative(ws, p).replace(/\\/g, '/')).filter((r) => incRe.test(r) && !(excRe && excRe.test(r))).map((r) => new Uri(path.join(ws, r)));
};
const fake = {
	Uri,
	Disposable: class { constructor(f) { this.dispose = f; } },
	RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
	Range: class { constructor(...a) { this.a = a; } },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	TabInputText: class {},
	WorkspaceEdit: undefined,
	TabInputTextDiff: undefined,
	Position: undefined,
	FileType: { File: 1, Directory: 2 },
	workspace: {
		name: 'zws',
		workspaceFolders: [{ uri: new Uri(ws) }],
		textDocuments: [],
		asRelativePath: (u) => path.relative(ws, u.fsPath).replace(/\\/g, '/'),
		findFiles,
		fs: {
			readFile: async (u) => new Uint8Array(fs.readFileSync(u.fsPath)),
			writeFile: async (u, b) => fs.writeFileSync(u.fsPath, Buffer.from(b)),
			stat: async (u) => { const s = fs.statSync(u.fsPath); return { size: s.size, type: s.isDirectory() ? 2 : 1 }; },
			createDirectory: async (u) => fs.mkdirSync(u.fsPath, { recursive: true }),
			delete: async (u) => fs.rmSync(u.fsPath, { force: true }),
			rename: async (a, b) => fs.renameSync(a.fsPath, b.fsPath),
			readDirectory: async (u) => fs.readdirSync(u.fsPath, { withFileTypes: true }).map((d) => [d.name, d.isDirectory() ? 2 : 1])
		},
		applyEdit: async () => true
	},
	window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }), showSaveDialog: async (o) => fake.nextSave, showErrorMessage: (m) => console.log('  [showError]', m), showWarningMessage: async (msg, opts, ...items) => (fake.autoConfirm ? items[0] : undefined), showInformationMessage: async () => undefined, tabGroups: { all: [] }, activeTextEditor: undefined, state: { focused: true } },
	languages: { getDiagnostics: () => [] },
	commands: { executeCommand: async () => {} },
	env: { openExternal: async () => {}, clipboard: { text: '', writeText: async (s) => { fake.env.clipboard.text = s; } } }
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: fake };

const { ChatController } = require(OUT + '/chatController.js');
const { ProviderStore } = require(OUT + '/providerStore.js');

// ---------------- scripted LLM
let script = [];
// Optional: pick the response by request (for concurrent subagents).
let router = null;
const requests = [];
const FENCE = /^<tool_output tool="[^"]*" trust="untrusted">\n([\s\S]*)\n<\/tool_output>$/;
const unfence = (s) => FENCE.test(s) ? s.replace(FENCE, '$1').replace(/<\\\/tool_output>/g, '</tool_output>') : s;
const sse = (res, events) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n'); res.end(); };
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		// Tool results reach the provider fenced as untrusted (core/untrusted.ts); the assertions below read them unfenced.
		const raw = JSON.parse(body || '{}');
		const json = JSON.parse(body || '{}');
		for (const m of Array.isArray(json.messages) ? json.messages : []) if (m.role === 'tool' && typeof m.content === 'string') m.content = unfence(m.content);
		requests.push({ url: req.url, json, raw, auth: req.headers.authorization });
		const step = router ? router(requests.at(-1).json, requests.at(-1)) : script.shift();
		if (!step) { res.writeHead(500); return res.end('no script'); }
		step(res);
	});
});
// Prompt construction runs real subprocesses; keep fixture connections alive until test teardown.
server.keepAliveTimeout = 0;
const oaText = (t) => (res) => sse(res, [{ choices: [{ delta: { content: t } }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }]);
let toolResponseId = 0;
const oaTools = (calls) => {
	const responseId = ++toolResponseId;
	return (res) => sse(res, [{ choices: [{ delta: { tool_calls: calls.map((c, i) => ({ index: i, id: `c${responseId}_${i}`, function: { name: c[0], arguments: JSON.stringify(c[1]) } })) }, finish_reason: 'tool_calls' }] }]);
};

function makeController(catalogOverride) {
	const ctx = { globalState: memento(), subscriptions: [], secrets: (() => { const m = new Map(); return { get: async (k) => m.get(k), store: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) }; })(), globalStorageUri: new Uri(path.join(ws, '.gs')), extensionUri: new Uri(path.join(__dirname, '..')), workspaceState: memento() };
	const store = new ProviderStore(ctx);
	// The mock provider runs on 127.0.0.1 but stands in for a cloud model: no local-tuned (lean) agent here.
	// Permission-policy tests opt into sandboxing explicitly; unrelated shell tests use Off.
	void store.updateSettings({ localTuned: false, sandbox: 'off' });
	const catalog = catalogOverride || { lookup: async () => undefined, all: async () => [], search: async () => [], get: async () => undefined };
	const posts = [];
	const c = new ChatController(ctx, store, catalog, () => {});
	const surface = { kind: 'chat', post: (m) => posts.push(m) };
	c.attach(surface);
	return { c, ctx, store, surface, posts, send: (m) => c.handle(surface,m) };
}
const lastState = (posts) => [...posts].reverse().find((p) => p.type === 'state');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for a pending approval card (instead of a fixed sleep — slow machines took longer than 400 ms). */
const untilPending = async (t, ms = 8000) => {
	const end = Date.now() + ms;
	while (Date.now() < end && !(lastState(t.posts)?.messages ?? []).some((m) => m.approval && m.approval.status === 'pending')) await sleep(20);
};
/** Wait for a condition (instead of a fixed sleep). */
const until = async (cond, ms = 8000) => {
	const end = Date.now() + ms;
	while (Date.now() < end && !cond()) await sleep(20);
};

server.listen(0, async () => {
	const base = `http://127.0.0.1:${server.address().port}/v1`;
	try {
		{
			const t = makeController(); await t.send({ type:'ready' });
			const sessionId = lastState(t.posts).currentSessionId;
			t.c.messages = Array.from({length:501}, (_, index) => ({ id:'page-'+index, role:'user', content:'Message '+index }));
			t.c.messages[0] = { id:'pending-old', role:'assistant', kind:'tool', content:'', approval:{id:'pending-approval',kind:'command',command:'echo fixture',status:'pending'} };
			await t.store.saveMessages(sessionId, t.c.messages); await t.send({ type:'ready' });
			let state = lastState(t.posts); assert.equal(state.messages.length,201); assert.equal(state.historyWindow.hasMore,true); assert(state.messages.some(m=>m.id==='pending-old'));
			await t.send({type:'historyMore',sessionId}); state=lastState(t.posts); assert.equal(state.messages.length,401);
			await t.send({type:'historyMore',sessionId}); state=lastState(t.posts); assert.equal(state.messages.length,501); assert.equal(state.historyWindow.hasMore,false);
			assert.equal((await t.store.loadMessages(sessionId)).length,501,'paging must not truncate persisted context');
			t.c.dispose(); console.log('  conversation history pages while retaining old pending approvals');
		}
		{
			const t = makeController();
			await t.send({ type: 'ready' });
			const a = await t.store.add({ name: 'Switch A', baseUrl: base, models: [{ id: 'shared' }] });
			const b = await t.store.add({ name: 'Switch B', baseUrl: base, models: [{ id: 'shared' }, { id: 'off', enabled: false }] });
			const first = lastState(t.posts).currentSessionId;
			await t.send({ type: 'selectModel', providerId: a.id, model: 'shared', sessionId: first });
			await t.store.saveMessages(first, [{ id: 'first-prompt', role: 'user', content: 'first chat' }]);
			await t.send({ type: 'newSession' });
			const second = lastState(t.posts).currentSessionId;
			await t.send({ type: 'selectModel', providerId: b.id, model: 'shared', sessionId: second });
			await t.send({ type: 'selectModel', providerId: a.id, model: 'shared', sessionId: first });
			assert.equal(lastState(t.posts).selection.providerId, b.id, 'late picker messages cannot change the new chat');
			await t.send({ type: 'selectModel', providerId: b.id, model: 'off', sessionId: second });
			assert.equal(lastState(t.posts).selection.model, 'shared', 'disabled models are refused by the host');
			t.c.turning = true;
			await t.send({ type: 'selectModel', providerId: a.id, model: 'shared', sessionId: second });
			t.c.turning = false;
			assert.equal(lastState(t.posts).selection.providerId, b.id, 'host refuses a switch while a turn is starting');
			await t.send({ type: 'setModelFavorite', providerId: b.id, model: 'shared', favorite: true });
			assert.equal(lastState(t.posts).modelPreferences.favorites[0].providerId, b.id);
			await t.send({ type: 'switchSession', id: first });
			assert.equal(lastState(t.posts).selection.providerId, a.id, 'switching chats restores its own provider');
			t.c.dispose();
			console.log('ok  per-chat model picker, stale/busy/disabled switch guards and persisted favorites');
		}
		// ======== 1. OpenAI agent loop: todo + read + edit(approval, CRLF) → final answer once
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.send({ type: 'ready' });
			script = [
				oaTools([['todo_write', { items: [{ text: 'read', done: true }, { text: 'edit', done: false }] }], ['read_file', { path: 'a.ts' }], ['edit_file', { path: 'a.ts', old_string: 'const x = 1;\nconst y = 2;', new_string: 'const x = 10;\nconst y = 20;' }]]),
				oaText('Done.')
			];
			const run = t.send({ type: 'send', text: 'bump the numbers' });
			await untilPending(t);
			let st = lastState(t.posts);
			const pending = st.messages.find((m) => m.approval && m.approval.status === 'pending');
			assert.ok(pending, 'approval card pending');
			assert.ok(st.isStreaming, 'still running while waiting');
			await t.send({ type: 'approve', id: pending.approval.id });
			await run;
			st = lastState(t.posts);
			const kinds = st.messages.map((m) => (m.role === 'user' ? 'user' : m.todos ? 'todo' : m.tool ? 'tool:' + m.tool.name : m.approval ? 'approval:' + m.approval.status : 'text:' + m.content));
			console.log('  transcript:', kinds.join(' | '));
			assert.deepStrictEqual(kinds, ['user', 'todo', 'tool:read_file', 'approval:applied', 'tool:verify', 'text:Done.'], 'final answer appears exactly once, after the automatic check');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'a.ts'), 'utf8'), 'const x = 10;\r\nconst y = 20;\r\n', 'edit applied, CRLF preserved');
			assert.ok(!st.isStreaming);
			const req2 = requests.at(-1).json;
			assert.deepStrictEqual(req2.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'tool'], 'tool results fed back');
			assert.match(req2.messages[0].content, /Project instructions from AGENTS\.md/);
			assert.match(req2.messages[4].content, /1\tconst x = 1;/, 'read_file numbered output');
			const usage = t.store.getUsageEvents();
			assert.strictEqual(usage.length, 2, 'one record per model request');
			assert.strictEqual(usage[0].usageSource, 'unknown', 'tool-call fixture does not report usage');
			assert.strictEqual(usage[1].tokensIn, 100);
			assert.strictEqual(st.messages[0].turn.usage.knownAttempts, 1);
			assert.equal(new Set(usage.map((e) => e.attemptId)).size, 2);
			assert.ok(usage.every((e) => e.turnId === st.messages[0].id && e.purpose === 'main'));
			assert.deepEqual(st.messages[0].turn.toolTimings.map((t) => t.name).sort(), ['edit_file', 'read_file', 'todo_write']);
			assert.ok(st.messages[0].turn.toolTimings.every((t) => t.durationMs >= 0));
			const saved = await t.store.loadMessages(st.currentSessionId);
			assert.strictEqual(saved.length, 6, 'session persisted');
			console.log('ok  openai agent loop, approval, CRLF edit, no duplicate answer, persistence');

			// retry regenerates the last answer in place
			script = [oaText('Again.')];
			await t.send({ type: 'retry' });
			st = lastState(t.posts);
			assert.strictEqual(st.messages.at(-1).content, 'Again.'); assert.strictEqual(st.messages.length, 2);
			console.log('ok  retry replaces everything after the last user message');

			// path escape refused; rejection flows back to the model
			script = [oaTools([['read_file', { path: '../outside.txt' }], ['edit_file', { path: 'a.ts', old_string: 'const x = 10;', new_string: 'nope' }]]), oaText('ok')];
			const r2 = t.send({ type: 'send', text: 'try escaping' });
			await untilPending(t);
			st = lastState(t.posts);
			const pend = st.messages.find((m) => m.approval && m.approval.status === 'pending');
			await t.send({ type: 'reject', id: pend.approval.id });
			await r2;
			const toolMsgs = requests.at(-1).json.messages.filter((m) => m.role === 'tool').map((m) => m.content);
			assert.match(toolMsgs.at(-2), /outside the workspace/); assert.match(toolMsgs.at(-1), /rejected/);
			assert.strictEqual(fs.readFileSync(path.join(ws, 'a.ts'), 'utf8').includes('nope'), false);
			console.log('ok  ../ path refused; rejected edit not applied and reported to model');

			// stop while waiting for approval → no deadlock
			script = [oaTools([['write_file', { path: 'new.txt', content: 'hi' }]])];
			const r3 = t.send({ type: 'send', text: 'write a file' });
			await untilPending(t);
			await t.send({ type: 'stop' });
			await Promise.race([r3, sleep(3000).then(() => { throw new Error('deadlock: run did not finish after stop'); })]);
			st = lastState(t.posts);
			assert.ok(!st.isStreaming); assert.ok(!fs.existsSync(path.join(ws, 'new.txt')));
			assert.strictEqual(st.messages.at(-1).content, '_Stopped._');
			console.log('ok  stop during pending approval ends the run (old code deadlocked)');

			// switching session mid-stream keeps the reply out of the new session
			let partialResponse;
			script = [(res) => { partialResponse = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'partial ' } }] }) + '\n\n'); }];
			const oldSession = lastState(t.posts).currentSessionId;
			const r4 = t.send({ type: 'send', text: 'long answer' });
			for (let i = 0; i < 250 && !lastState(t.posts).messages.some(m => m.role === 'assistant' && m.content === 'partial '); i++) await sleep(20);
			assert.ok(partialResponse, 'stream has started');
			await t.send({ type: 'newSession' });
			partialResponse.end();
			await r4;
			st = lastState(t.posts);
			assert.notStrictEqual(st.currentSessionId, oldSession);
			assert.strictEqual(st.messages.length, 0, 'new session stays clean');
			const old = await t.store.loadMessages(oldSession);
			assert.strictEqual(old.at(-2).content, 'partial ', 'partial text kept in the original session');
			console.log('ok  session switch mid-stream: reply stays in its own session');

			// Branch in new chat: a copy up to that answer, titled "(2)", marked where it continues.
			await t.send({ type: 'switchSession', id: oldSession });
			const src = lastState(t.posts);
			const answer = src.messages.find((m) => m.role === 'assistant' && !m.kind && m.content.trim());
			await t.send({ type: 'branchChat', id: answer.id });
			st = lastState(t.posts);
			assert.notStrictEqual(st.currentSessionId, oldSession, 'switched to the branch');
			assert.ok(/\(2\)$/.test(st.sessions.find((s) => s.id === st.currentSessionId).title), 'titled (2)');
			assert.strictEqual(st.branch.id, oldSession);
			assert.ok(st.messages.some((m) => m.id === answer.id) && st.messages.length <= src.messages.length);
			assert.strictEqual((await t.store.loadMessages(oldSession)).length, src.messages.length, 'source untouched');
			console.log('ok  branch in new chat');
		}

		// ======== 1b. A model on this computer gets the local-tuned (lean) agent: short prompt, core tools only
		{
			const t = makeController();
			await t.store.updateSettings({ localTuned: true, browserTools: true });
			const p = await t.store.add({ name: 'zer0ne Engine', baseUrl: base, apiFormat: 'openai', preset: 'zer0ne-engine-test', models: [{ id: 'local-8b' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setSelection(p.id, 'local-8b');
			script = [oaText('Hello from the lean agent.')];
			await t.send({ type: 'send', text: 'hi' });
			const req = requests.at(-1);
			const names = req.json.tools.map((x) => x.function?.name ?? x.name);
			assert.ok(names.includes('edit_file') && names.includes('read_file'), 'core tools stay');
			assert.ok(!names.includes('web_search') && !names.includes('browser_navigate') && !names.includes('tool_search'), 'no browser / deferred tools for a local model');
			const sys = req.json.messages[0].content;
			assert.match(sys, /Call ONE tool at a time/, 'the lean prompt');
			assert.ok(sys.length < 3500, 'short system prompt (' + sys.length + ' chars)');
			console.log('ok  local model: lean agent (' + names.length + ' tools, ' + sys.length + '-char prompt)');
		}

		// ======== 2. Anthropic-format agent loop (was chat-only before)
		{
			const t = makeController();
			const p = await t.store.add({ name: 'KiosLike', baseUrl: base, apiFormat: 'anthropic', models: [{ id: 'claude-x' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			script = [
				(res) => sse(res, [
					{ type: 'message_start', message: { usage: { input_tokens: 50 } } },
					{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'grep', input: {} } },
					{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"const"}' } },
					{ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu2', name: 'write_file', input: {} } },
					{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"sub/dir/n.txt","content":"hello"}' } },
					{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }
				]),
				(res) => sse(res, [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Found and wrote.' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }])
			];
			await t.send({ type: 'send', text: 'grep and write' });
			const st = lastState(t.posts);
			const kinds = st.messages.map((m) => (m.role === 'user' ? 'user' : m.tool ? 'tool:' + m.tool.name + ':' + m.tool.summary : m.approval ? 'approval:' + m.approval.status + (m.approval.auto ? ':auto' : '') : 'text:' + m.content));
			console.log('  transcript:', kinds.join(' | '));
			assert.strictEqual(kinds.at(-1), 'text:Found and wrote.');
			assert.ok(kinds.includes('approval:applied:auto'), 'full access auto-approves');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'sub/dir/n.txt'), 'utf8'), 'hello', 'write_file creates parent dirs');
			const req = requests.at(-1);
			assert.strictEqual(req.url, '/v1/messages');
			assert.deepStrictEqual(req.json.messages.map((m) => m.role), ['user', 'assistant', 'user']);
			assert.deepStrictEqual(req.json.messages[2].content.map((b) => b.type), ['tool_result', 'tool_result']);
			assert.ok(Array.isArray(req.json.system) && req.json.system[0].cache_control, 'system prompt carries a cache breakpoint');
			assert.ok(req.json.messages.at(-1).content.at(-1).cache_control, 'latest turn carries a cache breakpoint');
			assert.match(req.json.system[0].text, /served by the provider "KiosLike"/, 'model identity in the system prompt');
			assert.ok(req.json.tools.some((x) => x.name === 'web_search'), 'browser tools offered to the agent');
			console.log('ok  anthropic agent loop with tool_use + full-access auto approval');
		}

		// ======== 3. setup errors keep the user message and allow retry
		{
			const t = makeController();
			await t.send({ type: 'send', text: 'hello?' });
			const st = lastState(t.posts);
			assert.deepStrictEqual(st.messages.map((m) => m.role + (m.isError ? ':error' : '')), ['user', 'assistant:error']);
			console.log('ok  no-provider error keeps the message (Retry available)');
		}
		// ======== 4. v0.3: plan mode, queue, ask_user, $skill, MCP round-trip
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			// Plan mode: write tools are not offered, and blocked if called anyway.
			script = [oaTools([['write_file', { path: 'plan.txt', content: 'x' }]]), oaText('1. Do this\n2. Then that')];
			await t.send({ type: 'send', text: 'plan it', plan: true });
			const planReq = requests.at(-2).json;
			assert.ok(!planReq.tools.some((x) => x.function.name === 'write_file'), 'no write tools in plan mode');
			assert.match(planReq.messages[0].content, /PLAN MODE/);
			assert.ok(!fs.existsSync(path.join(ws, 'plan.txt')), 'plan mode blocked the write');
			assert.match(requests.at(-1).json.messages.at(-1).content, /not available in Plan mode/);
			console.log('ok  plan mode is read-only (tools hidden + execution blocked)');

			// Queue: a message sent while running waits, then runs.
			script = [(res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'first' } }] }) + '\n\n'); setTimeout(() => res.end(), 300); }, oaText('second answer')];
			const run1 = t.send({ type: 'send', text: 'first question' });
			await sleep(80);
			await t.send({ type: 'send', text: 'follow-up question' });
			assert.strictEqual(lastState(t.posts).queue.length, 1, 'follow-up queued');
			await run1;
			await sleep(200);
			let st = lastState(t.posts);
			assert.deepStrictEqual(st.messages.slice(-4).map((m) => m.content), ['first question', 'first', 'follow-up question', 'second answer']);
			assert.strictEqual(st.queue.length, 0);
			console.log('ok  follow-up queued during a run, then sent automatically');

			// ask_user: question card, answer flows back to the model.
			script = [oaTools([['ask_user', { question: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }]]), oaText('Using tabs.')];
			const run2 = t.send({ type: 'send', text: 'format the file' });
			// Wait for the card instead of a fixed pause (a busy machine took longer than 200 ms).
			const pendingQuestion = () => (lastState(t.posts)?.messages || []).find((m) => m.question && m.question.status === 'pending');
			for (let waited = 0; !pendingQuestion() && waited < 5000; waited += 50) await sleep(50);
			const q = pendingQuestion();
			assert.ok(q, 'question card shown');
			await t.send({ type: 'answer', id: q.question.id, answer: 'Tabs' });
			await run2;
			assert.match(requests.at(-1).json.messages.at(-1).content, /User answered: Tabs/);
			console.log('ok  ask_user question card → answer returned to the model');

			// $skill mention loads the skill into the turn.
			t.c.skills.save({ name: 'house-style', description: 'Our code style', body: 'Always use tabs. Never semicolons.', scope: 'user' });
			script = [oaText('ok')];
			await t.send({ type: 'send', text: 'refactor this with $house-style please' });
			const skillReq = requests.at(-1).json;
			assert.match(skillReq.messages.at(-1).content, /<skill name="house-style">[\s\S]*Never semicolons/);
			assert.match(skillReq.messages[0].content, /house-style: Our code style/, 'skill catalog in system prompt');
			console.log('ok  skills: catalog in prompt + $skill mention loads instructions');

			// MCP: stdio server → tool offered → approved (full access) → result back.
			await t.store.saveMcpServer({ name: 'fake', transport: 'stdio', command: 'node', args: [path.join(__dirname, 'fake-mcp.js')] });
			await t.send({ type: 'updateSettings', patch: { mcp: true } });
			for (let i = 0; i < 50 && lastState(t.posts).mcp[0].status.state !== 'ready'; i++) { await sleep(100); await t.c.sendState(); }
			const mcpState = lastState(t.posts).mcp[0];
			assert.strictEqual(mcpState.status.state, 'ready', 'MCP server ready: ' + JSON.stringify(mcpState.status));
			assert.deepStrictEqual(mcpState.status.tools.map((x) => x.name), ['echo', 'purge']);
			script = [oaTools([['mcp__fake__echo', { text: 'hello' }]]), oaText('done')];
			await t.send({ type: 'send', text: 'use the echo tool' });
			const mcpReq = requests.at(-2).json;
			assert.ok(mcpReq.tools.find((x) => x.function.name === 'tool_search').function.description.includes('mcp__fake__echo'), 'MCP tool offered (deferred, listed in tool_search)');
			assert.match(requests.at(-1).json.messages.at(-1).content, /ECHO:hello/);
			const card = lastState(t.posts).messages.find((m) => m.approval && m.approval.kind === 'mcp');
			assert.ok(card && card.approval.auto && /ECHO:hello/.test(card.approval.result), 'MCP approval card auto-approved in full access');
			t.c.dispose();
			console.log('ok  MCP stdio server: initialize → tools/list → tools/call round-trip');
		}

		// ======== 5. v0.4: hooks (UserPromptSubmit context, PreToolUse block, PostToolUse payload) + turn edits + undo
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.writeFileSync(path.join(ws, 'c.ts'), 'let a = 1;\nlet b = 2;\n');
			// Hooks run in the platform shell: PowerShell on Windows, /bin/sh elsewhere.
			const win = process.platform === 'win32';
			const hookCmd = {
				context: win ? 'Write-Output "current branch: main"' : 'echo "current branch: main"',
				block: win ? "[Console]::Error.WriteLine('no shell allowed'); exit 2" : "echo 'no shell allowed' >&2; exit 2",
				post: win
					? '$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; Add-Content -Path post.log -Value $j.tool_name'
					: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').appendFileSync('post.log',JSON.parse(s).tool_name+'\\n'))"`
			};
			await t.send({ type: 'saveHook', hook: { event: 'UserPromptSubmit', matcher: '', command: hookCmd.context, enabled: true, timeoutSec: 30 } });
			await t.send({ type: 'saveHook', hook: { event: 'PreToolUse', matcher: '^run_command$', command: hookCmd.block, enabled: true, timeoutSec: 30 } });
			await t.send({ type: 'saveHook', hook: { event: 'PostToolUse', matcher: 'edit_file|write_file', command: hookCmd.post, enabled: true, timeoutSec: 30 } });
			assert.strictEqual(lastState(t.posts).hooks.length, 3, 'hooks in state');
			script = [
				oaTools([['run_command', { command: 'echo hi' }], ['write_file', { path: 'b.txt', content: 'new file\n' }], ['read_file', { path: 'c.ts' }], ['edit_file', { path: 'c.ts', old_string: 'let b = 2;', new_string: 'let b = 3;\nlet c = 4;' }]]),
				oaText('All set.')
			];
			await t.send({ type: 'send', text: 'make the changes' });
			const firstReq = requests.at(-2).json;
			assert.match(firstReq.messages.at(-1).content, /<hook-context>\s*current branch: main/, 'UserPromptSubmit stdout added as context');
			const toolMsgs = requests.at(-1).json.messages.filter((m) => m.role === 'tool');
			assert.match(toolMsgs[0].content, /Blocked by a PreToolUse hook: no shell allowed/, 'PreToolUse exit 2 blocks the tool');
			assert.deepStrictEqual(fs.readFileSync(path.join(ws, 'post.log'), 'utf8').trim().split(/\r?\n/), ['write_file', 'edit_file'], 'PostToolUse got JSON payload on stdin');
			let st = lastState(t.posts);
			const user = st.messages.find((m) => m.role === 'user');
			assert.ok(user.turn && user.turn.endedAt >= user.turn.startedAt, 'turn timing recorded');
			const edits = Object.fromEntries(user.turn.edits.map((e) => [e.path, e]));
			assert.deepStrictEqual(Object.keys(edits).sort(), ['b.txt', 'c.ts']);
			assert.ok(edits['b.txt'].created && edits['b.txt'].added === 1, JSON.stringify(edits['b.txt']));
			assert.strictEqual(edits['c.ts'].added, 2); assert.strictEqual(edits['c.ts'].removed, 1);
			assert.ok(user.turn.undoable, 'turn undoable');
			await t.send({ type: 'undoTurn', id: user.id });
			assert.strictEqual(fs.readFileSync(path.join(ws, 'c.ts'), 'utf8'), 'let a = 1;\nlet b = 2;\n', 'undo restored the edit');
			assert.ok(!fs.existsSync(path.join(ws, 'b.txt')), 'undo removed the created file');
			st = lastState(t.posts);
			assert.ok(st.messages.find((m) => m.id === user.id).turn.undone, 'turn marked undone');
			t.c.dispose();
			console.log('ok  hooks: prompt context, PreToolUse block, PostToolUse stdin; turn edits (+/-) and undo');
		}

		// ======== 6. v0.5: identity, saved facts outside the system prompt, apply_patch, multi_edit,
		//          fuzzy edit, background commands, per-turn usage, undo of all of it, export
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.writeFileSync(path.join(ws, 'p.ts'), 'function a() {\n\treturn 1;\n}\n\nfunction b() {\n\treturn 2;\n}\n');
			fs.writeFileSync(path.join(ws, 'gone.txt'), 'bye\n');
			fs.writeFileSync(path.join(ws, 'm.ts'), 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
			fs.writeFileSync(path.join(ws, 'f.ts'), 'if (x) {\n\t\tdoIt();\n}\n');
			await t.store.retainMemory('The user prefers tabs over spaces');
			const patch = ['*** Begin Patch', '*** Add File: newdir/n.ts', '+export const n = 1;', '*** Update File: p.ts', '@@ function b() {', '-\treturn 2;', '+\treturn 22;', '*** Delete File: gone.txt', '*** End Patch'].join('\n');
			const bg = process.platform === 'win32' ? 'Write-Output "server ready on 5173"; Start-Sleep -Seconds 30' : 'echo "server ready on 5173"; sleep 30';
			script = [
				oaTools([
					['apply_patch', { patch }],
					['read_file', { path: 'm.ts' }],
					['multi_edit', { path: 'm.ts', edits: [{ old_string: 'const one = 1;', new_string: 'const one = 10;' }, { old_string: 'const three = 3;', new_string: 'const three = 30;' }] }],
					['read_file', { path: 'f.ts' }],
					['edit_file', { path: 'f.ts', old_string: '    doIt();', new_string: '    doIt(2);' }],
					['run_command', { command: bg, background: true }]
				]),
				oaTools([['command_output', { id: 'bg1', wait_seconds: 1 }], ['command_kill', { id: 'bg1' }]]),
				oaText('Done.')
			];
			await t.send({ type: 'send', text: 'apply the refactor using tabs' });
			const first = requests.at(-3).json;
			assert.match(first.messages[0].content, /served by the provider "Mock"/, 'identity');
			assert.ok(!/prefers tabs/.test(first.messages[0].content), 'saved facts are not in the (cached) system prompt');
			assert.match(first.messages.at(-1).content, /<saved-facts>[\s\S]*prefers tabs/, 'saved facts ride on the user message');
			assert.ok(first.tools.some((x) => x.function.name === 'apply_patch') && first.tools.some((x) => x.function.name === 'code_intel'), 'new tools offered');
			// Reads (indexes 1 and 3) come first: edits need the agent to have seen the file.
			const results = requests.at(-2).json.messages.filter((m) => m.role === 'tool').map((m) => m.content).filter((_, i) => i !== 1 && i !== 3);
			assert.match(results[0], /Patch applied: created newdir\/n.ts, updated p.ts, deleted gone.txt/, results[0]);
			assert.match(results[1], /Applied 2 edits to m.ts/, results[1]);
			assert.match(results[2], /Edited f.ts/, results[2]);
			assert.match(results[3], /background as bg1[\s\S]*server ready on 5173/, results[3]);
			const results2 = requests.at(-1).json.messages.filter((m) => m.role === 'tool').map((m) => m.content).slice(-2);
			assert.match(results2[0], /running \(id bg1/, results2[0]);
			assert.match(results2[1], /Stopped bg1/);
			assert.strictEqual(fs.readFileSync(path.join(ws, 'newdir/n.ts'), 'utf8'), 'export const n = 1;\n');
			assert.match(fs.readFileSync(path.join(ws, 'p.ts'), 'utf8'), /return 1;[\s\S]*return 22;/);
			assert.ok(!fs.existsSync(path.join(ws, 'gone.txt')));
			assert.strictEqual(fs.readFileSync(path.join(ws, 'm.ts'), 'utf8'), 'const one = 10;\nconst two = 2;\nconst three = 30;\n');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'f.ts'), 'utf8'), 'if (x) {\n\t\tdoIt(2);\n}\n', 'fuzzy edit re-indented to the file');
			let st = lastState(t.posts);
			const user = st.messages.find((m) => m.role === 'user');
			assert.ok(user.turn.usage && user.turn.usage.input >= 100, 'per-turn usage recorded: ' + JSON.stringify(user.turn.usage));
			assert.strictEqual(user.turn.provider, 'Mock');
			assert.deepStrictEqual(user.turn.edits.map((e) => e.path).sort(), ['f.ts', 'gone.txt', 'm.ts', 'newdir/n.ts', 'p.ts']);
			// Export (Markdown + JSON) and copy
			fake.nextSave = new Uri(path.join(ws, 'chat-export.md'));
			await t.send({ type: 'chatAction', action: 'export', format: 'md' });
			const md = fs.readFileSync(path.join(ws, 'chat-export.md'), 'utf8');
			assert.match(md, /## You[\s\S]*apply the refactor using tabs[\s\S]*Changes: [\s\S]*## zer0ne · m1[\s\S]*Done\./, md.slice(0, 600));
			fake.nextSave = new Uri(path.join(ws, 'chat-export.json'));
			await t.send({ type: 'chatAction', action: 'export', format: 'json' });
			const json = JSON.parse(fs.readFileSync(path.join(ws, 'chat-export.json'), 'utf8'));
			assert.strictEqual(json.format, 'zer0ne-chat');
			await t.send({ type: 'chatAction', action: 'copyWorkdir' });
			assert.strictEqual(fake.env.clipboard.text, ws);
			// Undo reverts the patch (incl. the created + deleted files), multi_edit and fuzzy edit.
			await t.send({ type: 'undoTurn', id: user.id });
			assert.ok(!fs.existsSync(path.join(ws, 'newdir/n.ts')), 'undo removed the added file');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'gone.txt'), 'utf8'), 'bye\n', 'undo restored the deleted file');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'm.ts'), 'utf8'), 'const one = 1;\nconst two = 2;\nconst three = 3;\n');
			t.c.dispose();
			console.log('ok  v0.5: identity, saved facts, apply_patch/multi_edit/fuzzy edit, background command, usage, export, undo');
		}

		// ======== 7. v0.5: plugins (ZCode / Claude Code format), custom commands, custom agents
		{
			const pdir = path.join(ws, '.zer0ne', 'plugins', 'demo-plugin');
			const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(pdir, rel)), { recursive: true }); fs.writeFileSync(path.join(pdir, rel), text); };
			w('.zcode-plugin/plugin.json', JSON.stringify({ name: 'demo-plugin', version: '1.2.0', description: 'Demo' }));
			w('commands/greet.md', '---\ndescription: Greet someone\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS in one line.');
			w('agents/reviewer.md', '---\nname: reviewer\ndescription: Strict code reviewer\n---\nYou are a strict code reviewer. Report only real bugs.');
			w('skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: Demo skill from a plugin\n---\nDo the demo.');
			w('hooks/hooks.json', JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'echo ${CLAUDE_PLUGIN_ROOT}' }] }] } }));
			w('.mcp.json', JSON.stringify({ mcpServers: { fake2: { command: 'node', args: [path.join(__dirname, 'fake-mcp.js')] } } }));
			fs.mkdirSync(path.join(ws, '.claude', 'commands'), { recursive: true });
			fs.writeFileSync(path.join(ws, '.claude', 'commands', 'deploy.md'), 'Deploy the app to $1 and report the URL.');
			fs.mkdirSync(path.join(ws, '.cursor', 'rules'), { recursive: true });
			fs.writeFileSync(path.join(ws, '.cursor', 'rules', 'style.mdc'), '---\nglobs: *.ts\n---\nPrefer early returns.');

			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'updateSettings', patch: { mcp: true, skills: true, subagents: true } });
			await t.send({ type: 'ready' });
			let st = lastState(t.posts);
			const plug = st.plugins.find((x) => x.name === 'demo-plugin');
			assert.ok(plug, 'plugin discovered');
			assert.strictEqual(plug.enabled, false, 'project plugins await activation');
			await t.send({ type: 'togglePlugin', name: plug.id, enabled: true });
			st = lastState(t.posts);
			assert.deepStrictEqual(plug.counts, { commands: 1, skills: 1, agents: 1, hooks: 1, mcp: 1 });
			for (const name of ['demo-plugin:greet', 'deploy']) assert.ok(st.commands.some((c) => c.name === name), name); // commands from the user's own profile vary per machine
			assert.ok(st.agents.some((a) => a.name === 'demo-plugin-reviewer' && a.source === 'plugin:demo-plugin'));
			assert.ok(st.skills.some((s) => s.name === 'demo-skill' && s.source === 'plugin'), 'plugin skill listed');
			const ph = st.hooks.find((h) => h.id.startsWith(plug.id + ':'));
			assert.strictEqual(ph.matcher, '^(?:write_file|edit_file|multi_edit|apply_patch)$', 'Claude tool names mapped');
			assert.ok(ph.command.includes(pdir), 'plugin root expanded');
			for (let i = 0; i < 50 && !(lastState(t.posts).mcp.find((m) => m.plugin) || {}).status?.tools?.length; i++) { await sleep(100); await t.c.sendState(); }
			const pm = lastState(t.posts).mcp.find((m) => m.plugin === plug.id);
			assert.strictEqual(pm.status.state, 'ready', 'plugin MCP server started: ' + JSON.stringify(pm.status));

			// custom command expands $1 / $ARGUMENTS for the model, the bubble keeps what you typed
			script = [oaText('ok')];
			await t.send({ type: 'send', text: '/deploy staging' });
			assert.match(requests.at(-1).json.messages.at(-1).content, /Deploy the app to staging and report the URL\./);
			assert.match(requests.at(-1).json.messages[0].content, /from AGENTS\.md:\nUse tabs\.[\s\S]*from \.cursor\/rules\/style\.mdc:\nPrefer early returns\./, 'rules from several agents combined');
			st = lastState(t.posts);
			assert.strictEqual(st.messages.find((m) => m.role === 'user').content, '/deploy staging');
			script = [oaText('ok')];
			await t.send({ type: 'send', text: '/demo-plugin:greet Ada' });
			assert.match(requests.at(-1).json.messages.at(-1).content, /Say hello to Ada in one line\./);

			// task with a custom agent persona
			script = [oaTools([['task', { description: 'review diff', prompt: 'Review a.ts', agent: 'demo-plugin-reviewer' }]]), oaText('Found nothing.'), oaText('Done.')];
			const reviewStart = requests.length;
			await t.send({ type: 'send', text: 'get a review' });
			const reviewRequests = requests.slice(reviewStart);
			const agentProp = reviewRequests[0].json.tools.find((x) => x.function.name === 'task').function.parameters.properties.agent;
			assert.ok(agentProp && agentProp.enum.includes('demo-plugin-reviewer'), 'task offers custom agents');
			assert.ok(reviewRequests.some(r => /strict code reviewer/.test(r.json.messages[0].content)), 'subagent runs with the persona prompt: ' + JSON.stringify(t.c.agentRuns.list().map(r => ({ id: r.id, status: r.status, error: r.error }))));

			// install from a folder (marketplace layout: plugins/<name>) and remove
			const market = fs.mkdtempSync(path.join(os.tmpdir(), 'zmk-'));
			fs.mkdirSync(path.join(market, 'plugins', 'extra', '.claude-plugin'), { recursive: true });
			fs.writeFileSync(path.join(market, 'plugins', 'extra', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'extra' }));
			fs.mkdirSync(path.join(market, 'plugins', 'extra', 'commands'), { recursive: true });
			fs.writeFileSync(path.join(market, 'plugins', 'extra', 'commands', 'hi.md'), 'Hi!');
			assert.deepStrictEqual(t.c.plugins.installFromFolder(market, 'workspace'), ['extra']);
			await t.send({ type: 'togglePlugin', name: 'extra', enabled: true });
			await t.c.sendState();
			assert.ok(lastState(t.posts).commands.some((c) => c.name === 'extra:hi'));
			await t.send({ type: 'togglePlugin', name: 'extra', enabled: false });
			assert.ok(!lastState(t.posts).commands.some((c) => c.name === 'extra:hi'), 'disabled plugin contributes nothing');
			await t.send({ type: 'removePlugin', name: 'extra' });
			assert.ok(!lastState(t.posts).plugins.some((x) => x.name === 'extra'));
			fs.rmSync(market, { recursive: true, force: true });

			// Granular auto-approve (Agent mode): allowlisted simple commands run, chained ones still ask.
			await t.store.setMode('agent');
			script = [oaTools([['run_command', { command: 'git status' }]]), oaText('clean')];
			await t.send({ type: 'send', text: 'status?' });
			let card = lastState(t.posts).messages.filter((m) => m.approval).at(-1);
			assert.strictEqual(card.approval.autoRule, 'allowlist', 'allowlisted command auto-approved');
			script = [oaTools([['run_command', { command: 'git status && echo pwned' }]]), oaText('stopped')];
			const run = t.send({ type: 'send', text: 'status again' });
			await untilPending(t);
			card = lastState(t.posts).messages.filter((m) => m.approval).at(-1);
			assert.strictEqual(card.approval.status, 'pending', 'chained command needs approval');
			await t.send({ type: 'reject', id: card.approval.id });
			await run;
			// read_file on a folder lists it; on a notebook shows cells
			fs.writeFileSync(path.join(ws, 'nb.ipynb'), JSON.stringify({ cells: [{ cell_type: 'code', source: ['x = 1\n', 'print(x)'], outputs: [{ text: ['1\n'] }] }] }));
			script = [oaTools([['read_file', { path: '.cursor' }], ['read_file', { path: 'nb.ipynb' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'look' });
			const reads = requests.at(-1).json.messages.filter((m) => m.role === 'tool').map((m) => m.content).slice(-2);
			assert.match(requests.at(-1).raw.messages.filter((m) => m.role === 'tool').at(-1).content, /^<tool_output tool="read_file" trust="untrusted">\n/, 'tool results reach the provider fenced');
			assert.strictEqual(reads[0], 'rules/', 'folder listing');
			assert.match(reads[1], /## Cell 1 · code[\s\S]*print\(x\)[\s\S]*Output:\n.*1/, reads[1]);
			await t.send({ type: 'updateSettings', patch: { autoApproveEdits: true } });
			script = [oaTools([['write_file', { path: 'auto.txt', content: 'x' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'write it' });
			card = lastState(t.posts).messages.filter((m) => m.approval).at(-1);
			assert.strictEqual(card.approval.autoRule, 'edits');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'auto.txt'), 'utf8'), 'x');

			// An MCP tool the server itself declares destructive always asks, whatever autoApproveMcp says.
			await t.send({ type: 'updateSettings', patch: { autoApproveMcp: true } });
			script = [oaTools([['mcp__fake2__echo', { text: 'hi' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'echo it' });
			card = lastState(t.posts).messages.filter((m) => m.approval && m.approval.kind === 'mcp').at(-1);
			assert.strictEqual(card.approval.autoRule, 'MCP', 'tool without the hint follows the setting');
			assert.strictEqual(card.approval.destructive, false);
			script = [oaTools([['mcp__fake2__purge', { text: 'all' }]]), oaText('stopped')];
			const purge = t.send({ type: 'send', text: 'purge it' });
			await untilPending(t);
			card = lastState(t.posts).messages.filter((m) => m.approval && m.approval.kind === 'mcp').at(-1);
			assert.strictEqual(card.approval.destructive, true, 'server hint carried onto the approval');
			assert.strictEqual(card.approval.status, 'pending', 'destructive MCP tool asks even with autoApproveMcp on');
			await t.send({ type: 'reject', id: card.approval.id });
			await purge;
			t.c.dispose();
			console.log('ok  v0.5: plugins (commands, skills, agents, hooks, MCP), custom commands + agents, install/toggle/remove, rules, auto-approve');
		}

		// ======== 8. v0.6: secret redaction, ripgrep search (.gitignore, look-arounds), parallel read-only tools
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.writeFileSync(path.join(ws, '.env'), 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123\nPORT=8080\n');
			fs.writeFileSync(path.join(ws, '.gitignore'), 'ignored-dir/\n');
			fs.mkdirSync(path.join(ws, 'ignored-dir'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'ignored-dir', 'x.ts'), 'const needle = 1;\n');
			fs.writeFileSync(path.join(ws, 'found.ts'), 'const needle = 2;\nconst needleX = 3;\n');
			script = [oaTools([['read_file', { path: '.env' }], ['grep', { pattern: 'needle(?!X)' }], ['list_files', { glob: '**/*.ts' }]]), oaText('ok')];
			const started = Date.now();
			await t.send({ type: 'send', text: 'look around' });
			const res = requests.at(-1).json.messages.filter((m) => m.role === 'tool').map((m) => m.content);
			assert.ok(!res[0].includes('sk-proj') && res[0].includes('«redacted-secret»') && res[0].includes('PORT=8080'), 'secret hidden from the model: ' + res[0]);
			const cards = lastState(t.posts).messages.filter((m) => m.tool);
			assert.match(cards.find((c) => c.tool.name === 'read_file').tool.summary, /1 secret hidden/);
			if (process.env.ZER0NE_RG) {
				assert.match(res[1], /found\.ts:1: const needle = 2;/);
				assert.ok(!res[1].includes('needleX'), 'PCRE2 look-around works');
				assert.ok(!res[1].includes('ignored-dir') && !res[2].includes('ignored-dir'), '.gitignore respected');
				assert.ok(res[2].includes('found.ts'));
				console.log('    (ripgrep: ' + process.env.ZER0NE_RG + ')');
			} else {
				console.log('    (no ripgrep found — JS fallback checked only)');
			}
			// A write that would put a redacted value back is refused.
			script = [oaTools([['write_file', { path: '.env', content: 'OPENAI_API_KEY=«redacted-secret»\nPORT=9090\n' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'change the port' });
			assert.match(requests.at(-1).json.messages.at(-1).content, /hidden from you/);
			assert.match(fs.readFileSync(path.join(ws, '.env'), 'utf8'), /sk-proj-abcdef/, '.env untouched');
			fs.rmSync(path.join(ws, '.gitignore'));
			t.c.dispose();
			console.log('ok  v0.6: secret redaction (+ write guard), ripgrep search, parallel read-only calls (' + (Date.now() - started) + ' ms)');
		}

		// ======== 9. v0.6: checkpoints on disk — undo after restart, restore to a message, overwrite guard
		{
			const mk = async () => {
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.store.setMode('full');
				await t.send({ type: 'ready' });
				return t;
			};
			const t = await mk();
			const rf = (n) => fs.readFileSync(path.join(ws, n), 'utf8');
			fs.writeFileSync(path.join(ws, 'r.txt'), 'v1\n');
			script = [oaTools([['read_file', { path: 'r.txt' }], ['write_file', { path: 'r.txt', content: 'v2\n' }]]), oaText('turn one')];
			await t.send({ type: 'send', text: 'make v2' });
			script = [oaTools([['write_file', { path: 'r.txt', content: 'v3\n' }], ['write_file', { path: 's.txt', content: 'new\n' }]]), oaText('turn two')];
			await t.send({ type: 'send', text: 'make v3' });
			let st = lastState(t.posts);
			const users = st.messages.filter((m) => m.role === 'user');
			assert.deepStrictEqual(st.undoable, users.map((u) => u.id), 'both turns have checkpoints on disk');
			const cpDir = path.join(ws, '.gs', 'checkpoints', st.currentSessionId);
			assert.strictEqual(fs.readdirSync(cpDir).length, 2);

			// Overwrite guard: user edits r.txt after the agent → undo asks; declining changes nothing.
			fs.writeFileSync(path.join(ws, 'r.txt'), 'v3 + my edit\n');
			fake.autoConfirm = false;
			await t.send({ type: 'undoTurn', id: users[1].id });
			assert.strictEqual(rf('r.txt'), 'v3 + my edit\n', 'declined → untouched');
			fs.writeFileSync(path.join(ws, 'r.txt'), 'v3\n');

			// Restore to the first message (undoes both turns, newest first).
			fake.autoConfirm = true;
			await t.send({ type: 'restoreTo', id: users[0].id });
			assert.strictEqual(rf('r.txt'), 'v1\n', 'restored to before the first message');
			assert.ok(!fs.existsSync(path.join(ws, 's.txt')), 'file created later is removed');
			st = lastState(t.posts);
			assert.deepStrictEqual(st.undoable, [], 'checkpoints consumed');
			assert.ok(st.messages.filter((m) => m.role === 'user').every((u) => u.turn.undone));
			fake.autoConfirm = false;
			t.c.dispose();

			// A new controller (= VS Code restart) can still undo an older turn from disk.
			const t2 = await mk();
			script = [oaTools([['read_file', { path: 'r.txt' }], ['write_file', { path: 'r.txt', content: 'v9\n' }]]), oaText('ok')];
			await t2.send({ type: 'send', text: 'make v9' });
			const sid = lastState(t2.posts).currentSessionId;
			const uid = lastState(t2.posts).messages.find((m) => m.role === 'user').id;
			const saved = await t2.store.loadMessages(sid);
			t2.c.dispose();
			const t3 = makeController();
			Object.assign(t3.ctx.globalState, t2.ctx.globalState);
			const c3 = new (require(OUT + '/chatController.js').ChatController)(t2.ctx, t2.store, { lookup: async () => undefined, all: async () => [], search: async () => [], get: async () => undefined }, () => {});
			const posts3 = [];
			const surf3 = { kind: 'chat', post: (m) => posts3.push(m) };
			c3.attach(surf3);
			await c3.handle(surf3, { type: 'ready' });
			assert.ok(lastState(posts3).undoable.includes(uid), 'undo still available after restart');
			await c3.handle(surf3, { type: 'undoTurn', id: uid });
			assert.strictEqual(rf('r.txt'), 'v1\n', 'undone after restart');
			assert.ok(saved.length > 0);
			c3.dispose();
			t3.c.dispose();
			console.log('ok  v0.6: checkpoints on disk — restore to message, overwrite guard, undo after restart');
		}

		// ======== 10. v0.6: in-editor review — proposal in the buffer, revert one block, accept keeps the rest
		{
			// Minimal editor-buffer model for the fake VS Code.
			class FakeDoc {
				constructor(uri) { this.uri = uri; this.text = fs.readFileSync(uri.fsPath, 'utf8'); this.isDirty = false; }
				getText() { return this.text; }
				get lineCount() { return this.text.split('\n').length; }
				validateRange(r) { return r; }
				async save() { fs.writeFileSync(this.uri.fsPath, this.text); this.isDirty = false; return true; }
			}
			const docs = fake.workspace.textDocuments;
			const saved = { open: fake.workspace.openTextDocument, apply: fake.workspace.applyEdit, WE: fake.WorkspaceEdit, exec: fake.commands.executeCommand };
			const commands = [];
			fake.commands.executeCommand = async (...a) => { commands.push(a[0]); };
			fake.WorkspaceEdit = class { constructor() { this.ops = []; } replace(uri, _r, text) { this.ops.push([uri, text]); } };
			fake.workspace.openTextDocument = async (uri) => {
				let d = docs.find((x) => x.uri.toString() === uri.toString());
				if (!d) { d = new FakeDoc(uri); docs.push(d); }
				return d;
			};
			fake.workspace.applyEdit = async (edit) => {
				for (const [uri, text] of edit.ops) { const d = await fake.workspace.openTextDocument(uri); d.text = text; d.isDirty = true; }
				return true;
			};
			fake.TabInputTextDiff = class {};

			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('agent');
			await t.send({ type: 'ready' });
			const original = 'a = 1\nb = 2\nc = 3\nd = 4\ne = 5\n';
			fs.writeFileSync(path.join(ws, 'rv.txt'), original);
			script = [oaTools([['read_file', { path: 'rv.txt' }], ['multi_edit', { path: 'rv.txt', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'e = 5', new_string: 'e = 50' }] }]]), oaText('done')];
			const run = t.send({ type: 'send', text: 'bump a and e' });
			// Wait for the proposal (a fixed 300 ms raced when the suites run in parallel).
			await until(() => docs.some((d) => d.uri.fsPath.endsWith('rv.txt') && d.isDirty));
			const doc = docs.find((d) => d.uri.fsPath.endsWith('rv.txt'));
			assert.ok(doc && doc.isDirty, 'proposal is in the editor buffer: '+JSON.stringify({review:t.store.getSettings().reviewInEditor,mode:t.store.getMode(),cards:lastState(t.posts)?.messages.map(m=>({tool:m.tool?.name,status:m.approval?.status,summary:m.tool?.summary,error:m.isError ? m.content : undefined}))}));
			assert.strictEqual(doc.text, 'a = 10\nb = 2\nc = 3\nd = 4\ne = 50\n');
			assert.strictEqual(fs.readFileSync(path.join(ws, 'rv.txt'), 'utf8'), original, 'disk untouched while reviewing');
			assert.ok(commands.includes('vscode.diff'), 'diff opened');
			assert.ok(commands.includes('setContext'), 'review context set for the title buttons');
			// The user reverts the first block in the diff editor…
			doc.text = 'a = 1\nb = 2\nc = 3\nd = 4\ne = 50\n';
			// …and accepts from the editor title.
			t.c.resolveReview(true);
			await run;
			assert.strictEqual(fs.readFileSync(path.join(ws, 'rv.txt'), 'utf8'), 'a = 1\nb = 2\nc = 3\nd = 4\ne = 50\n', 'only the kept block was saved');
			assert.match(requests.at(-1).json.messages.at(-1).content, /Applied 2 edits|kept only part/);

			// Rejecting restores the original buffer and file.
			script = [oaTools([['edit_file', { path: 'rv.txt', old_string: 'b = 2', new_string: 'b = 99' }]]), oaText('ok')];
			const run2 = t.send({ type: 'send', text: 'change b' });
			await untilPending(t);
			assert.strictEqual(doc.text.includes('b = 99'), true);
			const pending = lastState(t.posts).messages.filter((m) => m.approval).at(-1);
			await t.send({ type: 'reject', id: pending.approval.id });
			await run2;
			assert.ok(!doc.isDirty && !doc.text.includes('b = 99'), 'buffer restored');
			assert.ok(!fs.readFileSync(path.join(ws, 'rv.txt'), 'utf8').includes('b = 99'));
			t.c.dispose();
			docs.length = 0;
			Object.assign(fake.workspace, { openTextDocument: saved.open, applyEdit: saved.apply });
			fake.WorkspaceEdit = saved.WE;
			fake.commands.executeCommand = saved.exec;
			console.log('ok  v0.6: in-editor review (partial accept, reject restores)');
		}

		// ======== 11. v0.6: auto-verify (errors + command) sends failures back; cost per answer
		{
			const catalog = { lookup: async (id) => (id === 'm1' ? { id, priceIn: 2, priceOut: 8, priceCacheRead: 0.5 } : undefined), all: async () => [], search: async () => [], get: async () => undefined };
			const t = makeController(catalog);
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			const verifyCmd = process.platform === 'win32'
				? `if ((Get-Content v.txt -Raw) -match 'bug') { Write-Output 'test failed: found bug in v.txt'; exit 1 } else { Write-Output 'all tests pass' }`
				: "if grep -q bug v.txt; then echo 'test failed: found bug in v.txt'; exit 1; else echo 'all tests pass'; fi";
			await t.send({ type: 'updateSettings', patch: { verifyDiagnostics: true, verifyCommand: verifyCmd } });
			await t.send({ type: 'ready' });
			const diag = fake.languages.getDiagnostics;
			fake.languages.getDiagnostics = (uri) => (uri && /v\.txt$/.test(uri.fsPath || '') && /typo/.test(fs.readFileSync(uri.fsPath, 'utf8')) ? [{ severity: 0, message: 'Cannot find name typo', source: 'ts', range: { start: { line: 0, character: 0 } } }] : []);
			script = [
				oaTools([['write_file', { path: 'v.txt', content: 'bug typo\n' }]]),
				oaText('Done!'),
				oaTools([['write_file', { path: 'v.txt', content: 'fixed\n' }]]),
				oaText('Fixed and verified.')
			];
			await t.send({ type: 'send', text: 'write v.txt' });
			fake.languages.getDiagnostics = diag;
			const feedback = requests.at(-2).json.messages.at(-1).content;
			assert.match(feedback, /\[Automatic check after your edits\][\s\S]*Cannot find name typo[\s\S]*found bug in v\.txt/, feedback);
			const st = lastState(t.posts);
			const checks = st.messages.filter((m) => m.tool && m.tool.name === 'verify');
			assert.strictEqual(checks.length, 2, 'checked twice');
			assert.strictEqual(checks[0].tool.status, 'error');
			assert.strictEqual(checks[1].tool.status, 'done');
			assert.match(checks[1].tool.summary, /no errors in 1 changed file · .* passed/);
			assert.strictEqual(st.messages.at(-1).content, 'Fixed and verified.');
			const usage = st.messages.find((m) => m.role === 'user').turn.usage;
			assert.strictEqual(usage.cost, undefined, 'a full-turn bill is unknown when two tool-call responses omitted usage');
			assert.strictEqual(usage.knownAttempts, 2); assert.strictEqual(usage.attempts, 4);
			const pricedAttempts = t.store.getUsageEvents().filter((e) => e.usageSource === 'provider');
			assert.ok(pricedAttempts.every((e) => e.cost === (2 * e.tokensIn + 8 * e.tokensOut) / 1e6));
			const ud = await new Promise((resolve) => { t.surface.post = (m) => m.type === 'usageData' && resolve(m); t.send({ type: 'getUsage', days: 7 }); });
			assert.ok(ud.totals.cost > 0, 'usage page cost');
			assert.strictEqual(ud.totals.costCoverage.unknown, 2);
			const detail = await new Promise((resolve) => { t.surface.post = (m) => m.type === 'usageModelData' && resolve(m); t.send({ type: 'getUsageModel', days: 7, providerId: p.id, model: 'm1', requestId: 17 }); });
			assert.equal(detail.requestId, 17);
			assert.ok(detail.related.some((s) => s.turns > 0), 'model drilldown links the chat');
			let remoteCsv;
			await t.c.handle({ kind: 'remote', post: (m) => { if (m.type === 'usageCsv') remoteCsv = m; } }, { type: 'exportUsage', days: 7 });
			assert.ok(remoteCsv.csv.includes('Estimated cost (USD)') && remoteCsv.csv.includes('"estimated"'), 'remote CSV response includes billing labels');
			await t.c.handle({ kind: 'remote', post: (m) => { if (m.type === 'usageCsv') remoteCsv = m; } }, { type: 'exportUsage', days: 7, attempts: true });
			assert.match(remoteCsv.filename, /usage-requests/); assert.match(remoteCsv.csv, /Turn tool wall timings/); assert.match(remoteCsv.csv, /write_file/);
			const saveDialog = fake.window.showSaveDialog;
			const csvPath = path.join(ws, 'usage-export-test.csv');
			try {
				let exported;
				t.surface.post = (m) => { if (m.type === 'usageExportDone') exported = m; };
				fake.window.showSaveDialog = async () => Uri.file(csvPath);
				await t.send({ type: 'exportUsage', days: 7 });
				assert.equal(exported.cancelled, false);
				assert.ok(fs.readFileSync(csvPath, 'utf8').includes('Cached input tokens'), 'native CSV saved to the chosen file');
				fake.window.showSaveDialog = async () => undefined;
				await t.send({ type: 'exportUsage', days: 7 });
				assert.equal(exported.cancelled, true, 'cancelled export completes without writing');
			} finally { fake.window.showSaveDialog = saveDialog; }
			t.c.dispose();
			console.log('ok  v0.6: auto-verify loop (diagnostics + command), cost per answer & usage cost');
		}

		// Named editing workers use a separate checkout; explicit UI application records Undo.
		{
			fs.mkdirSync(path.join(ws, '.zer0ne', 'agents'), { recursive: true });
			fs.writeFileSync(path.join(ws, '.zer0ne', 'agents', 'fixer.md'), '---\nname: fixer\ndescription: Fixes small bugs\ntools: Read, Edit, Write\n---\nYou fix bugs with minimal edits.');
			const wt = require(OUT + '/worktrees'), cp = require('child_process');
			const oldCreate = wt.createWorktree, oldRemove = wt.removeWorktree, oldExec = cp.execFile;
			const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'z-writer-checkout-'));
			wt.createWorktree = async () => { fs.writeFileSync(path.join(checkout, 'w.txt'), 'broken\n'); return { path: checkout, branch: 'zer0ne/fixer' }; };
			wt.removeWorktree = async () => fs.rmSync(checkout, { recursive: true, force: true });
			cp.execFile = (exe, args, options, callback) => {
				if (exe !== 'git' || (options.cwd !== checkout && !['apply','branch','rev-parse'].includes(args[0]))) return oldExec(exe, args, options, callback);
				let out = '';
				if (args[0] === 'rev-parse') out = args.includes('--show-toplevel') ? options.cwd : 'fixture-base';
				else if (args.includes('--name-only')) out = 'w.txt\0';
				else if (args[0] === 'diff' && args.includes('--binary')) out = 'diff --git a/w.txt b/w.txt\n--- a/w.txt\n+++ b/w.txt\n@@ -1 +1 @@\n-broken\n+working\n';
				else if (args.includes('--numstat')) out = '1\t1\tw.txt\n';
				else if (args[0] === 'apply' && !args.includes('--check')) fs.writeFileSync(path.join(ws, 'w.txt'), 'working\n');
				queueMicrotask(() => callback(null, out, '')); return { stdin: { end() {} } };
			};
			const t = makeController();
			try {
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k'); await t.store.setMode('agent');
				await t.send({ type: 'updateSettings', patch: { subagents: true, verifyDiagnostics: false, verifyCommand: '' } });
				await t.send({ type: 'ready' }); fs.writeFileSync(path.join(ws, 'w.txt'), 'broken\n');
				script = [oaTools([['task', { description: 'fix w', prompt: 'Fix w.txt', agent: 'fixer' }]]), oaTools([['read_file', { path: 'w.txt' }], ['write_file', { path: 'w.txt', content: 'working\n' }]]), oaText('Fixed w.txt in the worktree.'), oaText('Ready for review.')];
				await t.send({ type: 'send', text: 'delegate the fix' });
				assert.equal(fs.readFileSync(path.join(ws, 'w.txt'), 'utf8'), 'broken\n');
				assert.equal(fs.readFileSync(path.join(checkout, 'w.txt'), 'utf8'), 'working\n');
				const writer = t.c.agentRuns.list().find(r => r.kind === 'writer');
				assert.ok(writer && writer.worktree.path === checkout);
				assert.ok(requests.some(r => /isolated git worktree[\s\S]*You fix bugs with minimal edits/.test(r.json.messages[0]?.content || '')), 'writer gets the isolation contract and persona instructions');
				const sessionId = lastState(t.posts).currentSessionId;
				await t.send({ type: 'writerReview', sessionId, id: writer.id, action: 'diff' });
				const review = t.posts.filter(p => p.type === 'writerDiff').at(-1); assert.match(review.patch, /working/);
				await t.store.setMode('full');
				await t.send({ type: 'writerReview', sessionId, id: writer.id, action: 'apply', reviewId: review.reviewId });
				assert.equal(fs.readFileSync(path.join(ws, 'w.txt'), 'utf8'), 'working\n');
				const st = lastState(t.posts), apply = st.messages.find(m => m.role === 'user' && /Apply changes from writer/.test(m.content));
				assert.ok(apply && st.undoable.includes(apply.id) && apply.turn.edits.some(e => e.path === 'w.txt'), 'explicit writer application is undoable');
			} finally { t.c.dispose(); wt.createWorktree = oldCreate; wt.removeWorktree = oldRemove; cp.execFile = oldExec; fs.rmSync(checkout, { recursive: true, force: true }); }
			console.log('ok isolated editing worker, explicit diff application and Undo');
		}

		// ======== 13. v0.6: semantic_search tool over the project code index
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'lib', 'invoice.ts'), 'export function computeInvoiceTotal(items: Item[]) {\n  return items.reduce((s, i) => s + i.price * i.qty, 0);\n}\n');
			script = [oaTools([['semantic_search', { query: 'invoice total computation' }]]), oaText('It is in lib/invoice.ts.')];
			await t.send({ type: 'send', text: 'where are invoice totals computed?' });
			const out = requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			assert.match(out, /^## lib\/invoice\.ts:1-\d+ {2}\(code, match: keywords\)/m, out);
			assert.ok(lastState(t.posts).codeIndex.chunks > 0, 'index stats in state');
			t.c.dispose();
			console.log('ok  v0.6: semantic_search through the agent (local keyword index)');
		}

		// ======== 14. core: exact transcript — cacheable prefix across turns, memory, retry, reminders, pruning
		{
			// Share of request N+1 that repeats request N byte-for-byte from the start (system + messages):
			// that is what a provider's prefix cache can serve.
			// For consecutive model calls: how much of the previous request is reused as the next
			// request's prefix (whole messages, as provider prefix caches work). 100% = nothing
			// that was already sent (and cached) is thrown away.
			const size = (r) => r.messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
			const shared = (a, b) => {
				let same = 0;
				for (let i = 0; i < a.messages.length && i < b.messages.length; i++) {
					if (JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i])) break;
					same += JSON.stringify(b.messages[i]).length;
				}
				return same;
			};
			const session = async (exactHistory) => {
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.store.setMode('full');
				await t.send({ type: 'updateSettings', patch: { exactHistory, verifyDiagnostics: false } });
				await t.send({ type: 'ready' });
				fs.writeFileSync(path.join(ws, 'big.ts'), Array.from({ length: 300 }, (_, i) => 'export const value' + i + ' = ' + i + ';').join('\n'));
				const firsts = [];
				const calls = [];
				for (let turn = 0; turn < 4; turn++) {
					script = [oaTools([['read_file', { path: 'big.ts' }], ['grep', { pattern: 'value1' + turn }]]), oaText('Turn ' + turn + ' answer.')];
					const before = requests.length;
					await t.send({ type: 'send', text: 'question number ' + turn });
					firsts.push(requests[before].json); // first model call of each turn
					calls.push(...requests.slice(before).map((r) => r.json));
				}
				const reuse = calls.slice(1).map((r, i) => shared(calls[i], r) / size(calls[i]));
				const total = calls.reduce((n, r) => n + size(r), 0);
				const cacheable = calls.slice(1).reduce((n, r, i) => n + shared(calls[i], r), 0);
				return { t, firsts, reuse, cachedShare: cacheable / total };
			};
			const lossy = await session(false);
			const exact = await session(true);
			const avg = (xs) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 10;
			const min = (xs) => Math.round(Math.min(...xs) * 1000) / 10;
			console.log('    previous request reused as prefix — old engine: avg ' + avg(lossy.reuse) + '% / worst ' + min(lossy.reuse) + '%   exact: avg ' + avg(exact.reuse) + '% / worst ' + min(exact.reuse) + '%');
			console.log('    input that a prefix cache can serve — old engine: ' + Math.round(lossy.cachedShare * 1000) / 10 + '%   exact: ' + Math.round(exact.cachedShare * 1000) / 10 + '%');
			assert.strictEqual(min(exact.reuse), 100, 'exact transcript: every request fully reuses the previous one');
			assert.ok(min(lossy.reuse) < 90, 'the old engine threw away cached context at turn boundaries');
			// Memory: turn 3's request still contains turn 0's file contents (no re-reading needed).
			assert.ok(JSON.stringify(exact.firsts[3].messages).includes('export const value299 = 299;'), 'earlier tool results kept');
			assert.ok(!JSON.stringify(lossy.firsts[3].messages).includes('export const value299 = 299;'), 'old engine forgot them');
			lossy.t.c.dispose();

			// Retry replaces the last attempt in the transcript instead of stacking it.
			const t = exact.t;
			script = [oaText('Retried answer.')];
			await t.send({ type: 'retry' });
			const retried = requests.at(-1).json.messages;
			assert.strictEqual(retried.filter((m) => m.role === 'user' && /question number 3/.test(m.content)).length, 1, 'no duplicate user turn after retry');
			assert.ok(!retried.some((m) => m.role === 'assistant' && m.content === 'Turn 3 answer.'), 'old attempt dropped');

			// Change reminder: the user edits a file the agent read.
			await sleep(20);
			fs.appendFileSync(path.join(ws, 'big.ts'), '\nexport const edited = true;');
			script = [oaText('ok')];
			await t.send({ type: 'send', text: 'anything new?' });
			assert.match(requests.at(-1).json.messages.at(-1).content, /<system-reminder>These files changed since you last read them[^<]*big\.ts/);
			script = [oaText('ok')];
			await t.send({ type: 'send', text: 'and now?' });
			assert.ok(!/system-reminder/.test(requests.at(-1).json.messages.at(-1).content), 'reminded once');

			// Pruning: lots of tool output → the oldest outputs are replaced in one batch.
			const huge = Array.from({ length: 1500 }, (_, i) => 'line ' + i + ' ' + 'y'.repeat(40)).join('\n');
			fs.writeFileSync(path.join(ws, 'huge.txt'), huge);
			for (let k = 0; k < 4; k++) {
				fs.writeFileSync(path.join(ws, 'huge.txt'), 'version ' + k + '\n' + huge);
				script = [oaTools([['read_file', { path: 'huge.txt' }]]), oaText('read ' + k)];
				await t.send({ type: 'send', text: 'read it again ' + k });
			}
			// Token Saver: re-reading an unchanged file sends a pointer, not the file again.
			script = [oaTools([['read_file', { path: 'huge.txt' }]]), oaText('same')];
			await t.send({ type: 'send', text: 'read it once more' });
			assert.ok(requests.at(-1).json.messages.some((m) => m.role === 'tool' && /^\[Identical to the earlier read_file result/.test(m.content)), 'unchanged re-read elided');
			script = [oaText('ok')];
			await t.send({ type: 'send', text: 'final' });
			const last = requests.at(-1).json.messages;
			const pruned = last.filter((m) => m.role === 'tool' && /old tool output (?:pruned|moved out of context|shortened)/.test(m.content)).length;
			const kept = last.filter((m) => m.role === 'tool' && m.content.length > 50_000).length;
			assert.ok(pruned >= 2 && kept >= 2, 'old outputs pruned, recent kept: pruned=' + pruned + ' kept=' + kept);
			t.c.dispose();
			fs.rmSync(path.join(ws, 'huge.txt'));
			console.log('ok  core: exact transcript (prefix-stable, remembers tool results), retry, change reminders, pruning');
		}


		// Compaction keeps instructions cacheable and migrates previously saved summary context once.
		for (const exactHistory of [true, false]) {
			const t = makeController();
			const p = await t.store.add({ name: 'Summary fixture', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k'); await t.store.setMode('full');
			await t.send({ type: 'updateSettings', patch: { exactHistory, autoCompact: false, verifyDiagnostics: false } });
			await t.send({ type: 'ready' });
			for (let i = 0; i < 3; i++) { script = [oaText('Answer ' + i)]; await t.send({ type: 'send', text: 'Requirement ' + i }); }
			const before = requests.at(-1).json;
			script = [oaText('Preserve the original requirements and continue.')];
			await t.send({ type: 'compact' });
			script = [oaText('Continued.')]; await t.send({ type: 'send', text: 'Continue after compaction' });
			const after = requests.at(-1).json;
			assert.deepStrictEqual(after.messages.filter(m => m.role === 'system'), before.messages.filter(m => m.role === 'system'));
			assert.deepStrictEqual(after.tools, before.tools);
			assert.equal(after.messages.filter(m => m.content?.includes('Preserve the original requirements and continue.')).length, 1);
			assert(after.messages.find(m => m.content?.includes('Preserve the original requirements and continue.')).role === 'user');
			if (exactHistory) {
				const sid = lastState(t.posts).currentSessionId, legacy = t.c.transcripts.load(sid);
				assert(legacy.summaryUpTo); legacy.entries.shift(); delete legacy.summaryUpTo;
				for (const id of Object.keys(legacy.marks)) legacy.marks[id]--;
				t.c.transcripts.save(sid, legacy);
				script = [oaText('Migrated.')]; await t.send({ type: 'send', text: 'Reopen older context' });
				script = [oaText('Retried.')]; await t.send({ type: 'retry' });
				const retried = requests.at(-1).json.messages;
				assert.equal(retried.filter(m => m.content?.includes('Preserve the original requirements and continue.')).length, 1);
				assert.equal(retried.filter(m => m.content?.includes('Reopen older context')).length, 1);
				assert(!retried.some(m => m.content === 'Migrated.'), 'retry removes only the previous attempt');
				assert(t.c.transcripts.load(sid).summaryUpTo, 'migration marker survives save/reload');
			}
			t.c.dispose();
			console.log('ok  compaction: stable system/tools, summary retained, migration and retry; exact=' + exactHistory);
		}

		// ======== 15. deferred tools: smaller tool list, tool_search loads schemas, use_tool runs the real tool
		{
			const mk = async (deferTools) => {
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.store.setMode('agent');
				await t.send({ type: 'updateSettings', patch: { deferTools, browserAgent: true, verifyDiagnostics: false } });
				await t.send({ type: 'ready' });
				return t;
			};
			const full = await mk(false);
			script = [oaText('ok')];
			await full.send({ type: 'send', text: 'hi' });
			const fullTools = JSON.stringify(requests.at(-1).json.tools);
			full.c.dispose();
			const t = await mk(true);
			fs.writeFileSync(path.join(ws, 'old-name.txt'), 'x\n');
			script = [
				oaText('ok'),
				oaTools([['tool_search', { query: 'move_file' }]]),
				oaTools([['use_tool', { name: 'move_file', arguments: { from: 'old-name.txt', to: 'new-name.txt' } }]]),
				oaText('Moved.')
			];
			await t.send({ type: 'send', text: 'hi' });
			const slimTools = JSON.stringify(requests.at(-1).json.tools);
			console.log('    tool definitions per request: ' + fullTools.length + ' → ' + slimTools.length + ' chars (' + Math.round((1 - slimTools.length / fullTools.length) * 100) + '% smaller)');
			assert.ok(slimTools.length < fullTools.length * 0.8, 'deferring saves tokens');
			assert.ok(!slimTools.includes('"browser_navigate"') && /browser_\* \(\d+\): [^"]*\bnavigate\b/.test(slimTools), 'browser tools listed (as one family line), not loaded');
			const run = t.send({ type: 'send', text: 'rename old-name.txt' });
			await untilPending(t);
			const searched = requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			assert.match(searched, /### move_file[\s\S]*parameters: \{/, 'schema loaded on demand');
			const card = lastState(t.posts).messages.filter((m) => m.approval).at(-1);
			assert.ok(card && card.approval.status === 'pending' && /old-name\.txt → new-name\.txt/.test(card.approval.path), 'use_tool goes through the normal approval card');
			await t.send({ type: 'approve', id: card.approval.id });
			await run;
			assert.ok(fs.existsSync(path.join(ws, 'new-name.txt')) && !fs.existsSync(path.join(ws, 'old-name.txt')));
			assert.match(requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content, /Moved old-name\.txt → new-name\.txt/);
			fs.rmSync(path.join(ws, 'new-name.txt'));
			t.c.dispose();
			console.log('ok  deferred tools: tool_search + use_tool (approvals intact)');
		}

		// ======== 16. batch reads; errors reported right after an edit
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.writeFileSync(path.join(ws, 'b1.ts'), 'const one = 1;\n');
			fs.writeFileSync(path.join(ws, 'b2.ts'), 'const two = 2;\n');
			const saved = { open: fake.workspace.openTextDocument, on: fake.languages.onDidChangeDiagnostics, get: fake.languages.getDiagnostics };
			fake.workspace.openTextDocument = async (uri) => ({ uri, languageId: 'typescript' });
			fake.languages.onDidChangeDiagnostics = (cb) => { const h = setTimeout(() => cb({ uris: [new Uri(path.join(ws, 'b1.ts'))] }), 30); return { dispose: () => clearTimeout(h) }; };
			fake.languages.getDiagnostics = (uri) => (uri && /b1\.ts$/.test(uri.fsPath || '') && /undefinedThing/.test(fs.readFileSync(uri.fsPath, 'utf8')) ? [{ severity: 0, message: "Cannot find name 'undefinedThing'.", source: 'ts', range: { start: { line: 0, character: 12 } } }] : []);
			script = [oaTools([['read_file', { paths: ['b1.ts', 'b2.ts', 'missing.ts'] }], ['edit_file', { path: 'b1.ts', old_string: 'const one = 1;', new_string: 'const one = undefinedThing;' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'read both and edit' });
			Object.assign(fake.workspace, { openTextDocument: saved.open });
			Object.assign(fake.languages, { onDidChangeDiagnostics: saved.on, getDiagnostics: saved.get });
			const [batch, edit] = requests.at(-1).json.messages.filter((m) => m.role === 'tool').slice(-2).map((m) => m.content);
			assert.match(batch, /==> b1\.ts <==\n1\tconst one = 1;[\s\S]*==> b2\.ts <==\n1\tconst two = 2;[\s\S]*==> missing\.ts <==\nError:/, batch);
			assert.match(edit, /Edited b1\.ts[\s\S]*VS Code now reports 1 error in this file:\n {2}1:13 \[ts\] Cannot find name 'undefinedThing'\./, edit);
			t.c.dispose();
			console.log('ok  batch read_file (paths) + errors right after an edit');
		}

		// ======== 17. run_script: programmatic tool calling in a sandboxed Node process
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('agent');
			await t.send({ type: 'ready' });
			fs.mkdirSync(path.join(ws, 'ptc'), { recursive: true });
			for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(ws, 'ptc', 'f' + i + '.ts'), Array.from({ length: 200 }, (_, k) => (k % (i + 2) === 0 ? '// TODO item ' + k : 'const x' + k + ' = ' + k + ';')).join('\n'));
			const code = [
				"const list = await tools.list_files({ glob: 'ptc/*.ts' });",
				'let total = 0;',
				"for (const f of list) { const text = await tools.read_file({ path: f }); total += (text.match(/TODO/g) || []).length; }",
				"print(list.length + ' files, ' + total + ' TODOs');",
				"try { process.mainModule.require('fs').writeFileSync('escape.txt', 'x'); print('WRITE ALLOWED'); } catch (e) { print('write blocked: ' + e.code); }",
				'return { files: list.length };'
			].join('\n');
			script = [oaTools([['run_script', { code }]]), oaText('Counted.')];
			await t.send({ type: 'send', text: 'count the TODOs in ptc/' });
			const out = requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			const expected = Array.from({ length: 12 }, (_, i) => Array.from({ length: 200 }, (_, k) => k).filter((k) => k % (i + 2) === 0).length).reduce((a, b) => a + b, 0);
			assert.match(out, new RegExp('Output:\\n12 files, ' + expected + ' TODOs'), out);
			assert.match(out, /write blocked: ERR_ACCESS_DENIED/, 'sandbox blocks file writes');
			assert.ok(!fs.existsSync(path.join(ws, 'escape.txt')));
			assert.match(out, /Return value:\n\{\n {2}"files": 12\n\}/);
			assert.match(out, /\(13 tool calls\)/);
			const direct = Array.from({ length: 12 }, (_, i) => fs.readFileSync(path.join(ws, 'ptc', 'f' + i + '.ts'), 'utf8').length).reduce((a, b) => a + b, 0);
			console.log('    run_script: 13 tool calls, ' + out.length + ' chars into the context (reading the 12 files directly: ~' + direct + ' chars)');
			assert.ok(!lastState(t.posts).messages.some((m) => m.approval && m.approval.status === 'pending'), 'sandboxed script needs no approval');
			fs.rmSync(path.join(ws, 'ptc'), { recursive: true });
			t.c.dispose();
			// The exact patterns from real runs that used to fail: .map on list_files,
			// looping over it, batch reads, grep as data, and string-style use of lists.
			const code2 = [
				"const files = (await tools.list_files({ glob: 'src2/**/*.ts' })).map((f) => f.replace(/\\\\/g, '/'));",
				'const counts = {};',
				"for (const f of files) { const content = await tools.read_file({ path: f }); counts[f] = content.split('\\n').length; }",
				"const both = await tools.read_file({ paths: files });",
				"const hits = await tools.grep({ pattern: 'export', glob: 'src2/**/*.ts' });",
				"const asText = (await tools.list_files({ glob: 'src2/**/*.ts' })).split('\\n').filter(Boolean).length;",
				"print(JSON.stringify({ counts, keys: Object.keys(both), firstLine: both[files[0]].split('\\n')[0], hits: hits.map((h) => h.file + ':' + h.line), asText }));"
			].join('\n');
			fs.mkdirSync(path.join(ws, 'src2'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'src2', 'a.ts'), 'export const a = 1;\nconst b = 2;\nconst c = 3;');
			fs.writeFileSync(path.join(ws, 'src2', 'b.ts'), 'export function f() {}\n');
			script = [oaTools([['run_script', { code: code2 }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'measure src2' });
			const out2 = requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			const data = JSON.parse(out2.match(/Output:\n(\{.*\})/)[1]);
			assert.deepStrictEqual(data.counts, { 'src2/a.ts': 3, 'src2/b.ts': 2 }, 'exact file text (b.ts ends with a newline), not line-numbered');
			assert.deepStrictEqual(data.keys, ['src2/a.ts', 'src2/b.ts']);
			assert.strictEqual(data.firstLine, 'export const a = 1;');
			assert.deepStrictEqual(data.hits, ['src2/a.ts:1', 'src2/b.ts:1']);
			assert.strictEqual(data.asText, 2, 'lists also work with string methods');
			fs.rmSync(path.join(ws, 'src2'), { recursive: true });
			console.log('ok  run_script: sandboxed programmatic tool calling');
		}

		// ======== 18. multi-agent: background subagents in parallel, collected with agent_result
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('agent');
			await t.send({ type: 'updateSettings', patch: { subagents: true } });
			await t.send({ type: 'ready' });
			let main = 0;
			const started = [];
			const slowText = (text, ms) => (res) => setTimeout(() => oaText(text)(res), ms);
			router = (json) => {
				const sys = json.messages[0].content;
				if (/focused research subagent/.test(sys)) {
					const task = json.messages[1].content;
					started.push(Date.now());
					return slowText(/frontend/.test(task) ? 'Frontend: React 19, 42 components.' : 'Backend: Express, 7 routes.', 400);
				}
				main++;
				if (main === 1) return oaTools([['task', { description: 'survey frontend', prompt: 'Survey the frontend', background: true }], ['task', { description: 'survey backend', prompt: 'Survey the backend', background: true }]]);
				if (main === 2) return oaTools([['agent_result', { ids: t.c.agentRuns.list(t.c.sessionId).filter(r => r.description.startsWith('survey ')).map(r => r.id), wait_seconds: 10 }]]);
				return oaText('Both surveys are in.');
			};
			await t.send({ type: 'send', text: 'survey the project in parallel' });
			router = null;
			const results = requests.filter((r) => !/focused research subagent/.test(r.json.messages[0].content)).at(-1).json.messages.filter((m) => m.role === 'tool').map((m) => m.content);
			assert.match(results[0], /Started background agent a\d+-[a-f0-9]{8}/);
			assert.match(results[2], /## a\d+-[a-f0-9]{8} — survey frontend\nFrontend: React 19[\s\S]*## a\d+-[a-f0-9]{8} — survey backend\nBackend: Express/, results[2]);
			assert.ok(Math.abs(started[0] - started[1]) < 300, 'both subagents ran at the same time');
			assert.strictEqual(lastState(t.posts).messages.at(-1).content, 'Both surveys are in.');
			t.c.dispose();
			console.log('ok  multi-agent: parallel background subagents + agent_result');
		}

		// ======== 18b. multi-agent v2 (ZCode / Pi): background reports come back by themselves, agent_send,
		//          parallel batches, chains, subagent env + notes + tool policy, workflow commands, Stop
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('agent');
			await t.send({ type: 'updateSettings', patch: { subagents: true, verifyDiagnostics: false, verifyCommand: '' } });
			await t.send({ type: 'ready' });
			const isSub = (json) => /focused research subagent|full toolset/.test(json.messages[0].content);
			const mainReqs = () => requests.filter((r) => !isSub(r.json));
			const idle = async (ms = 8000) => {
				const end = Date.now() + ms;
				while (Date.now() < end && (t.c.run || t.c.turning)) await sleep(20);
			};

			// (1) A background agent outlives its turn; its report starts a short follow-up turn. An agent that
			//     can edit keeps its instructions in the background but runs read-only (the bug fix).
			let main = 0;
			const before = requests.length;
			let releaseBackground;
			const backgroundReady = new Promise(resolve => { releaseBackground = resolve; });
			// Hold the response until the first turn has finished; machine speed must
			// not decide whether the background report races this assertion.
			const backgroundTimeout = setTimeout(releaseBackground, 10000);
			router = (json) => {
				if (isSub(json)) return (res) => { void backgroundReady.then(() => oaText('Found 3 routes in server.ts:10-40.')(res)); };
				main++;
				if (main === 1) return oaTools([['task', { description: 'map routes', prompt: 'Map the routes', background: true, agent: 'general-purpose' }]]);
				if (main === 2) return oaText('Started a background agent.');
				return oaText('The background agent found 3 routes.');
			};
			try {
				await t.send({ type: 'send', text: 'map the routes in the background' });
				assert.strictEqual(main, 2, 'the first turn ends without waiting for the agent');
			} finally { clearTimeout(backgroundTimeout); releaseBackground(); }
			for (let i = 0; i < 200 && main < 3; i++) await sleep(25);
			await idle();
			const sub = requests.slice(before).find((r) => isSub(r.json)).json;
			assert.match(sub.messages[0].content, /You are a general-purpose subagent[\s\S]*focused research subagent[\s\S]*read-only: investigate/, 'background keeps the persona, read-only');
			assert.match(sub.messages[0].content, /Notes:[\s\S]*Do not write report[\s\S]*<env>\nWorking directory: [\s\S]*Platform: [\s\S]*<\/env>/, 'notes and environment');
			assert.match(sub.messages[0].content, /Use tabs\./, 'project rules reach general-purpose');
			const subTools = sub.tools.map((x) => x.function.name);
			for (const n of ['task', 'agent_result', 'agent_send', 'ask_user', 'write_file', 'run_command']) assert.ok(!subTools.includes(n), `child has no ${n}: ${subTools}`);
			const follow = mainReqs().at(-1).json.messages.at(-1).content;
			assert.match(follow, /<agent-notifications>[\s\S]*## a\d+-[a-f0-9]{8} \(general-purpose\) — map routes · completed[\s\S]*Found 3 routes in server\.ts:10-40\.[\s\S]*<usage>tokens: 110 \(in 100, out 10\)/, follow);
			let st = lastState(t.posts);
			assert.ok(st.messages.some((m) => m.role === 'user' && m.content === '↩ A background agent finished'), 'follow-up shown as a short note');
			assert.strictEqual(st.messages.at(-1).content, 'The background agent found 3 routes.');
			const card = st.messages.find((m) => m.tool && m.tool.name === 'task');
			assert.ok(card.tool.status === 'done' && /^a\d+-[a-f0-9]{8} · 0 tool calls · 1 turn · ↑100 ↓10 · cost unavailable · \d+s$/.test(card.tool.summary), card.tool.summary);
			assert.ok(t.store.getUsageEvents().some((e) => e.tokensIn === 100 && e.tokensOut === 10), 'the agent records its own usage');

			// (2) agent_send continues a finished agent with its context; Explore gets no project rules.
			let main2 = 0;
			router = (json) => {
				if (isSub(json)) return oaText(/lead agent/.test(json.messages.at(-1).content) ? 'Line 12 has the bug.' : 'The bug is in parse().');
				main2++;
				if (main2 === 1) return oaTools([['task', { description: 'find bug', prompt: 'Find the bug', agent: 'Explore' }]]);
				if (main2 === 2) return oaTools([['agent_send', { id: t.c.agentRuns.list(t.c.sessionId).filter(r => r.agentName === 'Explore' && r.description === 'find bug').at(-1).id, message: 'Which line exactly?' }]]);
				return oaText('Line 12.');
			};
			await t.send({ type: 'send', text: 'find the bug' });
			await idle();
			const explore = requests.filter((r) => isSub(r.json)).at(-1).json;
			assert.doesNotMatch(explore.messages[0].content, /Use tabs\./, 'Explore leaves the project rules out');
			assert.deepStrictEqual(explore.messages.slice(1).map((m) => m.role), ['user', 'assistant', 'user'], 'continued with its whole context');
			assert.match(explore.messages.at(-1).content, /\[Message from the lead agent\]\nWhich line exactly\?/);
			const sendResult = mainReqs().at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			assert.match(sendResult, /Line 12 has the bug\.[\s\S]*agent: a\d+-[a-f0-9]{8} \(Explore\) · completed[\s\S]*agent_send/, sendResult);

			// (3) Parallel batch: three agents at the same time, every report back.
			const starts = [];
			let main3 = 0;
			router = (json) => {
				if (isSub(json)) {
					starts.push(Date.now());
					const what = json.messages[1].content.replace(/\n\n<runtime-context>Current UTC date:.*?<\/runtime-context>$/, '');
					return (res) => setTimeout(() => oaText(`Report on ${what}.`)(res), 300);
				}
				main3++;
				if (main3 === 1) return oaTools([['task', { tasks: [{ description: 'ui', prompt: 'the UI' }, { description: 'api', prompt: 'the API', agent: 'reviewer' }, { description: 'db', prompt: 'the DB' }] }]]);
				return oaText('All three are in.');
			};
			await t.send({ type: 'send', text: 'survey in parallel' });
			const batch = mainReqs().at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			assert.match(batch, /^3 agents ran in parallel: 3 completed\.[\s\S]*## \[1\/3\] a\d+-[a-f0-9]{8} — ui · completed\nReport on the UI\.[\s\S]*## \[2\/3\] a\d+-[a-f0-9]{8} \(reviewer\) — api · completed\nReport on the API\.[\s\S]*## \[3\/3\] a\d+-[a-f0-9]{8} — db/, batch);
			assert.ok(Math.abs(starts[0] - starts[1]) < 250, 'the first two agents run side by side');
			assert.ok(starts[2] - Math.min(starts[0], starts[1]) >= 200, 'the third agent waits for a slot under the two-worker default');

			// (4) Chain: {previous} hands Explore's report to Plan; Plan has only its own tools.
			let planReq;
			let turn4 = 0;
			router = (json) => {
				if (isSub(json)) {
					if (/You are Plan/.test(json.messages[0].content)) {
						planReq = json;
						return oaText('1. Edit x.ts:3.');
					}
					return oaText('Explore found x.ts:3.');
				}
				turn4++;
				return turn4 === 1 ? oaTools([['task', { chain: [{ agent: 'Explore', prompt: 'Find x' }, { agent: 'Plan', prompt: 'Plan from: {previous}' }] }]]) : oaText('Planned.');
			};
			await t.send({ type: 'send', text: 'plan it' });
			assert.strictEqual(planReq.messages[1].content, require('../out/prefixStability').runtimeDate('Plan from: Explore found x.ts:3.'), 'previous report handed over with runtime date context');
			const planTools = planReq.tools.map((x) => x.function.name);
			assert.ok(planTools.length && planTools.every((n) => ['read_file', 'grep', 'list_files', 'web_fetch', 'web_search'].includes(n)), planTools.join());
			assert.ok(!planReq.tools.some((x) => x.function.name === 'git_diff'), 'Plan runs with its own tool list');
			const chain = mainReqs().at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
			assert.match(chain, /^Chain of 2 steps:\n1\. a\d+-[a-f0-9]{8} \(Explore\)[\s\S]*2\. a\d+-[a-f0-9]{8} \(Plan\)[\s\S]*## Final step \(a\d+-[a-f0-9]{8}\)\n1\. Edit x\.ts:3\./, chain);

			// (5) Built-in workflow commands expand into a chain request.
			router = null;
			script = [oaText('ok')];
			await t.send({ type: 'send', text: '/scout-and-plan add caching' });
			assert.match(requests.at(-1).json.messages.at(-1).content, /Request: add caching[\s\S]*chain of two steps[\s\S]*agent Explore[\s\S]*agent Plan/);
			assert.ok(['implement', 'scout-and-plan', 'implement-and-review'].every((n) => lastState(t.posts).commands.some((c) => c.name === n)), 'workflows listed');

			// (6) Stop stops the chat's background agents; their reports are not delivered.
			let main6 = 0;
			router = (json) => {
				if (isSub(json)) return (res) => setTimeout(() => { try { oaText('late')(res); } catch { /* aborted */ } }, 1500);
				main6++;
				return main6 === 1 ? oaTools([['task', { description: 'slow survey', prompt: 'Survey slowly', background: true }]]) : oaText('Working in the background.');
			};
			await t.send({ type: 'send', text: 'start a slow survey' });
			await t.send({ type: 'stop' });
			await sleep(2200);
			assert.strictEqual(main6, 2, 'no follow-up turn after Stop');
			const slow = lastState(t.posts).messages.filter((m) => m.tool && m.tool.name === 'task').at(-1);
			assert.ok(slow.tool.status === 'error' && /stopped/.test(slow.tool.summary), slow.tool.summary);
			router = null;
			t.c.dispose();
			console.log('ok  multi-agent v2: notifications, agent_send, parallel, chain, env/notes/tools, workflows, Stop');
		}

		// ======== 19. reliability: retries, then the fallback model finishes the turn
		{
			const t = makeController();
			const primary = await t.store.add({ name: 'Primary', baseUrl: base, apiFormat: 'openai', models: [{ id: 'big-model' }] });
			const backup = await t.store.add({ name: 'Backup', baseUrl: base, apiFormat: 'openai', models: [{ id: 'small-model' }] });
			await t.store.setApiKey(primary.id, 'k1');
			await t.store.setApiKey(backup.id, 'k2');
			await t.send({ type: 'selectModel', providerId: primary.id, model: 'big-model' });
			await t.send({ type: 'updateSettings', patch: { fallbackModels: backup.id + '::small-model' } });
			await t.send({ type: 'ready' });
			const overloaded = (res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'The server is overloaded' } })); };
			router = (json) => (json.model === 'big-model' ? overloaded : oaText('Answered by the backup.'));
			const statuses = [];
			const post = t.surface.post;
			t.surface.post = (m) => (m.type === 'status' && statuses.push(m.message), post(m));
			const t0 = Date.now();
			await t.send({ type: 'send', text: 'hello?' });
			router = null;
			const models = requests.slice(-4).map((r) => r.json.model);
			assert.deepStrictEqual(models, ['big-model', 'big-model', 'big-model', 'small-model'], 'two retries, then the fallback');
			const st = lastState(t.posts);
			assert.strictEqual(st.messages.at(-1).content, 'Answered by the backup.');
			assert.strictEqual(st.messages.at(-1).model, 'small-model');
			assert.ok(statuses.some((s) => /retrying in 1\.5s/.test(s)) && statuses.some((s) => /continuing with small-model \(Backup\)/.test(s)), statuses.join(' | '));
			console.log('    recovered in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's (2 retries + fallback)');
			// Circuit breaker: the next turn skips the failing model instead of retrying it again.
			const count = requests.length;
			script = [oaText('Backup again.')];
			const statusCount = statuses.length;
			await t.send({ type: 'send', text: 'and again?' });
			assert.deepStrictEqual(requests.slice(count).map((r) => r.json.model), ['small-model'], 'breaker open: straight to the fallback');
			assert.ok(!statuses.slice(statusCount).some(s => /retrying in/.test(s)), 'breaker does not enter retry backoff');
			t.c.dispose();
			console.log('ok  reliability: retry with backoff, then fallback model');
		}

		// ======== 20. deny rules (read / search / list) and read_document on a PDF
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.mkdirSync(path.join(ws, 'keys'), { recursive: true });
			fs.writeFileSync(path.join(ws, 'keys', 'server.pem'), 'SUPERSECRETKEYMATERIAL');
			fs.writeFileSync(path.join(ws, 'notes.md'), 'nothing SUPERSECRETKEYMATERIAL here? no, just notes');
			const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n2 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 700 Td (Quarterly report: revenue up 12%) Tj ET\nendstream\nendobj\n%%EOF', 'latin1');
			fs.writeFileSync(path.join(ws, 'report.pdf'), pdf);
			script = [oaTools([['read_file', { path: 'keys/server.pem' }], ['grep', { pattern: 'SUPERSECRET' }], ['list_files', { glob: 'keys/*' }], ['read_file', { path: 'report.pdf' }]]), oaText('ok')];
			await t.send({ type: 'send', text: 'look' });
			const [r1, r2, r3, r4] = requests.at(-1).json.messages.filter((m) => m.role === 'tool').slice(-4).map((m) => m.content);
			assert.match(r1, /keys\/server\.pem is protected by the user's deny rules/);
			assert.ok(!/server\.pem/.test(r2) && /notes\.md/.test(r2), 'grep skips denied files: ' + r2);
			assert.ok(!/server\.pem/.test(r3), 'list skips denied files');
			assert.match(r4, /report\.pdf — 1 pages, via text layer[\s\S]*Quarterly report: revenue up 12%/, r4);
			fs.rmSync(path.join(ws, 'keys'), { recursive: true });
			fs.rmSync(path.join(ws, 'notes.md'));
			fs.rmSync(path.join(ws, 'report.pdf'));
			t.c.dispose();
			console.log('ok  deny rules (read, grep, list) + read_document for PDFs');
		}
		// ======== 21. OS sandbox: boxed commands write only in the workspace; leaving the box asks
		{
			const sb = require('../out/tools/sandbox.js');
			const src = path.join(__dirname, '..', 'media', 'sandbox', 'lowil.cs');
			const status = sb.sandboxStatus(ws, path.join(ws, '.gs'), src);
			if (!status.available) {
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.store.setMode('agent');
				await t.store.updateSettings({ sandbox: 'always', autoApproveCommands: true, commandAllowlist: 'echo', verifyDiagnostics: false, verifyAutoDetect: false });
				await t.send({ type: 'ready' });
				const marker = path.join(ws, 'unavailable-sandbox.txt');
				const command = 'echo approval > unavailable-sandbox.txt';
				for (const background of [false, true]) {
					script = [oaTools([['run_command', { command, background }]]), oaText('done')];
					const run = t.send({ type: 'send', text: 'run with an unavailable sandbox' });
					await untilPending(t);
					const pending = lastState(t.posts).messages.filter(m => m.approval?.status === 'pending').at(-1).approval;
					assert(pending.escalate && !pending.sandboxed && !pending.auto);
					assert(!fs.existsSync(marker), 'commands wait for explicit approval');
					await t.send({ type: 'reject', id: pending.id });
					await run;
					assert(!fs.existsSync(marker), 'declined commands never launch');
				}
				t.c.dispose();
				console.log('ok  unavailable OS sandbox: foreground and background commands ask, despite automatic command approval');
			} else {
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.store.setMode('agent');
				await t.store.updateSettings({ sandbox: 'always' });
				await t.send({ type: 'ready' });
				// Temp folders are writable inside the sandbox by design (bwrap / Seatbelt): "outside" is in the home folder.
				const outside = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : os.homedir(), '.zout-'));
				const esc = path.join(outside, 'escape.txt');
				const cmd = process.platform === 'win32'
					? 'echo in>boxed.txt & echo x>"' + esc + '"'
					: "echo in > boxed.txt; echo x > '" + esc + "'";
				script = [oaTools([['run_command', { command: cmd }]]), oaText('done')];
				await t.send({ type: 'send', text: 'write files' });
				const out = requests.at(-1).json.messages.filter((m) => m.role === 'tool').at(-1).content;
				assert.ok(fs.existsSync(path.join(ws, 'boxed.txt')), 'writes inside the workspace work');
				assert.ok(!fs.existsSync(esc), 'writes outside are blocked');
				assert.match(out, /\(sandboxed\)[\s\S]*\[sandbox\][\s\S]*sandbox: false/, out);
				const card = lastState(t.posts).messages.filter((m) => m.approval).at(-1).approval;
				assert.ok(card.auto && card.autoRule === 'sandbox' && card.sandboxed, 'boxed command ran without a card');
				// Escaping the sandbox always asks, then runs unboxed.
				script = [oaTools([['run_command', { command: cmd, sandbox: false }]]), oaText('done')];
				const run = t.send({ type: 'send', text: 'again, unsandboxed' });
				await untilPending(t);
				const pending = lastState(t.posts).messages.filter((m) => m.approval).at(-1).approval;
				assert.ok(pending.status === 'pending' && pending.escalate && !pending.sandboxed, 'escalation needs approval');
				await t.send({ type: 'approve', id: pending.id });
				await run;
				assert.ok(fs.existsSync(esc), 'approved unsandboxed run can write outside');
				fs.rmSync(outside, { recursive: true, force: true });
				fs.rmSync(path.join(ws, 'boxed.txt'));
				t.c.dispose();
				console.log('ok  OS sandbox (' + status.kind + '): workspace-only writes, escalation asks');
			}
		}
		// ======== 22. scheduled tasks: the agent schedules (approved), the run gets its own read-only chat
		
		// Scheduled turns run beside a held foreground turn without consuming its composer state.
		
		// Background decisions remain pending when the foreground is stopped and stay in the inbox.
		
		// ======== 23. edit by name + impact map (Empryo-style)
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
			await t.store.setApiKey(p.id, 'k');
			await t.store.setMode('full');
			await t.send({ type: 'ready' });
			fs.mkdirSync(path.join(ws, 'lib'), { recursive: true });
			const src = 'export class Cart {\n\ttotal(items) {\n\t\treturn items.length;\n\t}\n\n\tclear() {}\n}\n';
			fs.writeFileSync(path.join(ws, 'lib', 'cart.ts'), src);
			fs.writeFileSync(path.join(ws, 'lib', 'checkout.ts'), "import { Cart } from './cart';\nexport const c = new Cart();\n");
			fs.writeFileSync(path.join(ws, 'app.ts'), "import { Cart } from './lib/cart.js';\n");
			fs.writeFileSync(path.join(ws, 'other.ts'), "import { x } from './cartography';\n");
			// Fake language server outline + document for lib/cart.ts.
			const saved = { exec: fake.commands.executeCommand, open: fake.workspace.openTextDocument, Pos: fake.Position };
			const R = (a, b, c, d) => ({ start: { line: a, character: b }, end: { line: c, character: d } });
			fake.Position = class { constructor(line, character) { this.line = line; this.character = character; } };
			fake.commands.executeCommand = async (cmd, uri) => (cmd === 'vscode.executeDocumentSymbolProvider' && /cart\.ts$/.test(uri.fsPath) ? [{ name: 'Cart', kind: 4, range: R(0, 0, 6, 1), children: [{ name: 'total', kind: 5, range: R(1, 1, 3, 2), children: [] }, { name: 'clear', kind: 5, range: R(5, 1, 5, 11), children: [] }] }] : undefined);
			fake.workspace.openTextDocument = async (uri) => {
				const text = fs.readFileSync(uri.fsPath, 'utf8');
				const lines = text.split('\n');
				return { uri, getText: () => text, lineAt: (n) => ({ text: lines[n] }), offsetAt: (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character };
			};
			try {
				script = [oaTools([['impact', { path: 'lib/cart.ts' }], ['read_file', { path: 'lib/cart.ts' }], ['edit_symbol', { path: 'lib/cart.ts', symbol: 'Cart.total', new_code: 'total(items) {\n\treturn items.reduce((n, i) => n + i.price, 0);\n}' }]]), oaText('done')];
				await t.send({ type: 'send', text: 'make total sum prices' });
				const [imp, , ed] = requests.at(-1).json.messages.filter((m) => m.role === 'tool').slice(-3).map((m) => m.content);
				assert.match(imp, /Defines: Cart:1/);
				assert.match(imp, /Imported by \(2\): app\.ts, lib\/checkout\.ts/, imp);
				assert.ok(!/Imported by.*other\.ts/.test(imp), 'cartography is not cart');
				assert.match(ed, /Replaced Cart\.total \(lib\/cart\.ts:2-4\)/, ed);
				assert.strictEqual(fs.readFileSync(path.join(ws, 'lib', 'cart.ts'), 'utf8'), 'export class Cart {\n\ttotal(items) {\n\t\treturn items.reduce((n, i) => n + i.price, 0);\n\t}\n\n\tclear() {}\n}\n', 'only the method replaced, indentation kept');
			} finally {
				fake.commands.executeCommand = saved.exec;
				fake.workspace.openTextDocument = saved.open;
				fake.Position = saved.Pos;
				for (const f of ['lib', 'app.ts', 'other.ts']) fs.rmSync(path.join(ws, f), { recursive: true, force: true });
			}
			t.c.dispose();
			console.log('ok  edit_symbol (edit by name) + impact (importers / imports / defines)');
		}
		// ======== key pool: a rate-limited key hands over to the next one at once (no retry wait), and it sticks
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Pool', baseUrl: base, apiFormat: 'openai', models: [{ id: 'pool-model' }] });
			await t.store.setApiKey(p.id, 'key-one, key-two\nkey-three');
			await t.send({ type: 'selectModel', providerId: p.id, model: 'pool-model' });
			await t.send({ type: 'ready' });
			assert.strictEqual(lastState(t.posts).providers.find((x) => x.id === p.id).keys, 3, 'pool size shown');
			const limited = (res) => { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests' } })); };
			router = (json, r) => (r.auth === 'Bearer key-one' ? limited : oaText('Answered with key two.'));
			const statuses = [];
			const post = t.surface.post;
			t.surface.post = (m) => (m.type === 'status' && statuses.push(m.message), post(m));
			const count = requests.length;
			await t.send({ type: 'send', text: 'hello?' });
			router = null;
			assert.deepStrictEqual(requests.slice(count).map((r) => r.auth), ['Bearer key-one', 'Bearer key-two'], 'each key once, no retry of the limited key');
			assert.ok(!statuses.some(s => /retrying in/.test(s)), 'key rotation does not enter retry backoff');
			assert.strictEqual(lastState(t.posts).messages.at(-1).content, 'Answered with key two.');
			assert.ok(statuses.some((s) => /key 1 hit a limit — trying the next key/.test(s)), statuses.join(' | '));
			script = [oaText('Still key two.')];
			const next = requests.length;
			await t.send({ type: 'send', text: 'again' });
			assert.deepStrictEqual(requests.slice(next).map((r) => r.auth), ['Bearer key-two'], 'the next turn stays on the working key');
			t.c.dispose();
			console.log('ok  key pool: rate-limited key rotates to the next at once, and stays there');
		}
		// ======== chat image thumbnails: served per message, and kept on disk so a reload keeps them
		{
			const t = makeController();
			const p = await t.store.add({ name: 'Vis', baseUrl: base, apiFormat: 'openai', models: [{ id: 'gpt-4o', vision: true }] });
			await t.store.setApiKey(p.id, 'k');
			await t.send({ type: 'selectModel', providerId: p.id, model: 'gpt-4o' });
			await t.send({ type: 'ready' });
			const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
			await t.send({ type: 'addImage', name: 'auto.png', mime: 'image/png', base64: png });
			script = [oaText('Looked at it.')];
			await t.send({ type: 'send', text: 'what can we do with what we have' });
			const user = lastState(t.posts).messages.find((m) => m.role === 'user' && (m.attachments || []).length);
			assert.deepStrictEqual(user.attachments, ['auto.png'], 'the attachment name is in the state');
			await t.send({ type: 'readMessageImages', id: user.id });
			const first = [...t.posts].reverse().find((m) => m.type === 'messageImages');
			assert.ok(first.urls[0].startsWith('data:image/png;base64,'), 'thumbnail served while the bytes are fresh');
			// A reload forgets the memory cache — the on-disk copy must keep the thumbnail alive.
			t.c.imageCache.clear();
			t.posts.length = 0;
			await t.send({ type: 'readMessageImages', id: user.id });
			const again = [...t.posts].reverse().find((m) => m.type === 'messageImages');
			assert.ok(again && again.urls[0] === first.urls[0], 'the same thumbnail is served from disk');
			assert.ok(
				fs.readdirSync(path.join(ws, '.gs', 'images')).some((n) => n.startsWith(user.id + '-')),
				'the disk copy is named after the message'
			);
			t.c.dispose();
			console.log('ok  chat image thumbnails: per message, and the disk copy survives a reload (no more tiny icon)');
		}
		// ======== History management: one bulk action preserves every chat.
		{
			const t = makeController();
			await t.send({ type: 'ready' });
			const first = await t.store.importSession('First chat', [{ id: 'h1', role: 'user', content: 'Keep this message.' }]);
			const second = await t.store.importSession('Second chat', [{ id: 'h2', role: 'user', content: 'Keep this too.' }]);
			const folder = await t.store.saveFolder({ name: 'Project work', color: 'blue' });
			await t.store.updateSession(first.id, { pinned: true });
			t.posts.length = 0;
			await t.send({ type: 'updateSessions', ids: [first.id, second.id, first.id, null, 'missing'], patch: { folderId: folder.id, archived: true, title: 'Do not rename' } });
			const changed = (await t.store.listSessions()).filter((s) => [first.id, second.id].includes(s.id));
			assert.strictEqual(changed.length, 2);
			assert.ok(changed.every((s) => s.archived && s.folderId === folder.id && !s.pinned));
			assert.deepStrictEqual(changed.map((s) => s.title).sort(), ['First chat', 'Second chat']);
			assert.strictEqual(t.posts.filter((m) => m.type === 'state').length, 1, 'one state after the whole action');
			assert.strictEqual((await t.store.loadMessages(first.id))[0].content, 'Keep this message.');
			await t.send({ type: 'updateSessions', ids: [first.id, second.id], patch: { archived: false, folderId: null } });
			assert.ok((await t.store.listSessions()).filter((s) => [first.id, second.id].includes(s.id)).every((s) => !s.archived && !s.folderId));
			await t.send({ type: 'updateSessions', ids: [first.id], patch: { folderId: 'unknown-folder' } });
			assert.ok(!(await t.store.getSession(first.id)).folderId, 'unknown folders are ignored');
			await t.send({ type: 'updateSessions', ids: 'invalid', patch: { archived: true } });
			assert.ok(!(await t.store.getSession(first.id)).archived, 'malformed selections are ignored');
			t.c.dispose();
			console.log('ok  history bulk management: archive, restore, move, validation, messages preserved');
		}
		// ======== continue a Claude Code / Codex chat
		{
			const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zfh-'));
			const savedHome = process.env.ZER0NE_FOREIGN_HOME;
			process.env.ZER0NE_FOREIGN_HOME = home;
			try {
				const cx = path.join(home, '.codex', 'sessions', '2026', '09', '28');
				fs.mkdirSync(cx, { recursive: true });
				const file = path.join(cx, 'rollout-2026-09-28T09-00-00-x.jsonl');
				fs.writeFileSync(file, [
					{ type: 'session_meta', payload: { id: 'x', cwd: ws } },
					{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rename the helper' }] } },
					{ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c', arguments: '{"command":["rg","helper"]}' } },
					{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'a.ts:1: helper()' } },
					{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found one use in a.ts.' }] } }
				].map((r) => JSON.stringify(r)).join('\n'));
				const t = makeController();
				const p = await t.store.add({ name: 'Mock', baseUrl: base, apiFormat: 'openai', models: [{ id: 'm1' }] });
				await t.store.setApiKey(p.id, 'k');
				await t.send({ type: 'ready' });
				await t.send({ type: 'foreignList' });
				const list = t.posts.filter((m) => m.type === 'foreignSessions').at(-1).items;
				assert.deepStrictEqual(list.map((s) => [s.source, s.title]), [['codex', 'Rename the helper']]);
				await t.send({ type: 'foreignImport', source: 'codex', path: path.join(home, 'elsewhere.jsonl') });
				assert.ok(!lastState(t.posts).sessions.some((s) => /Codex/.test(s.title)), 'only files the list offered');
				await t.send({ type: 'foreignImport', source: 'codex', path: list[0].path });
				let st = lastState(t.posts);
				assert.strictEqual(st.sessions.find((s) => s.id === st.currentSessionId).title, 'Rename the helper · Codex');
				assert.deepStrictEqual(st.messages.map((m) => (m.tool ? 'tool:' + m.tool.name : m.role + ':' + m.content.slice(0, 22))), ['user:Rename the helper', 'tool:shell', 'assistant:Found one use in a.ts.', 'assistant:Imported from Codex (1']);
				script = [oaText('Continuing.')];
				await t.send({ type: 'send', text: 'go on' });
				const sent = JSON.stringify(requests.at(-1).json.messages);
				assert.ok(sent.includes('Rename the helper') && sent.includes('Found one use in a.ts.'), 'the model sees the imported chat');
				t.c.dispose();
				console.log('ok  continue a Codex chat: listed, imported as a new chat, the model sees it');
			} finally {
				if (savedHome === undefined) delete process.env.ZER0NE_FOREIGN_HOME;
				else process.env.ZER0NE_FOREIGN_HOME = savedHome;
				fs.rmSync(home, { recursive: true, force: true });
			}
		}
		// ======== a plan agent over ACP (Claude, Antigravity…): no key needed, it asks through approval cards, and what it edits on its own reaches Undo
		{
			const { execFileSync } = require('child_process');
			const git = (...a) => execFileSync('git', a, { cwd: ws, stdio: 'pipe' });
			git('init', '-q'); git('config', 'user.email', 't@t.t'); git('config', 'user.name', 't'); git('add', '-A'); git('commit', '-qm', 'base');
			const t = makeController();
			const { AcpRuntime, setAcpRuntime } = require(OUT + '/acp/runtime.js');
			const rt = new AcpRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'zla-acpctl-')));
			rt.entry = async () => ({ id: 'mock', name: 'Mock Agent', version: '1', description: '', authors: [], distribution: { npx: { package: 'mock' } } });
			rt.spawnSpec = () => ({ command: process.execPath, args: [path.join(__dirname, 'acp-mock-agent.js')], env: { ...process.env } });
			setAcpRuntime(rt);
			try {
				const p = await t.store.add({ name: 'Mock Agent', baseUrl: 'acp:mock', apiFormat: 'acp', preset: 'acp:mock', agent: { id: 'mock', plan: 'pro' }, models: [{ id: 'mock-fast' }, { id: 'mock-pro' }] });
				await t.store.setSelection(p.id, 'mock-pro');
				await t.send({ type: 'ready' });
				assert.strictEqual(lastState(t.posts).providers.find((x) => x.id === p.id).hasKey, true, 'an agent needs no key');
				const requestsBefore = requests.length;
				// the agent asks before running a command → an approval card; it also edits a file by itself
				const run = t.send({ type: 'send', text: 'go RUN:ls OWNWRITE:agent-made.txt' });
				await untilPending(t);
				let st = lastState(t.posts);
				const pend = st.messages.find((m) => m.approval && m.approval.status === 'pending');
				assert.ok(pend && pend.approval.kind === 'command' && pend.approval.command === 'ls', 'the agent\'s permission request became an approval card');
				await t.send({ type: 'approve', id: pend.approval.id });
				await run;
				st = lastState(t.posts);
				const answer = st.messages.filter((m) => m.role === 'assistant' && !m.kind && !m.approval).at(-1);
				assert.match(answer.content, /model=mock-pro done edited/, 'the agent\'s text, on the model chosen in the picker');
				assert.strictEqual(requests.length, requestsBefore, 'nothing went to an HTTP model: the agent is the model');
				assert.strictEqual(fs.readFileSync(path.join(ws, 'agent-made.txt'), 'utf8'), 'own edit\n');
				const user = st.messages.find((m) => m.role === 'user' && m.turn);
				assert.ok((user.turn.edits || []).some((e) => e.path === 'agent-made.txt' && e.created), 'the file the agent made itself is in the turn\'s changes (git tree tracker), so Undo and Review cover it');
				assert.ok(!st.isStreaming);
				// a rejection reaches the agent, which carries on
				const run2 = t.send({ type: 'send', text: 'again RUN:rm' });
				await untilPending(t);
				await t.send({ type: 'reject', id: lastState(t.posts).messages.find((m) => m.approval && m.approval.status === 'pending').approval.id });
				await run2;
				assert.match(lastState(t.posts).messages.filter((m) => m.role === 'assistant' && !m.kind && !m.approval).at(-1).content, /skipped/);
				// helpers that call a model outside a chat turn refuse an agent politely
				const helper = await t.send({ type: 'textAssist', action: 'improve', text: 'hello there', context: 'hello there' }).catch((e) => e);
				const out = [...t.posts].reverse().find((m) => m.error || m.text);
				assert.ok(!out || /agent|chat/i.test(String(out.error || '')) || out.text === undefined, 'text tools do not spawn an agent: ' + JSON.stringify(out || helper).slice(0, 120));
				t.c.dispose();
				console.log('ok  ACP agent: no key, permission → approval card, own edits reach Undo, rejection reaches the agent, no HTTP model call');
			} finally {
				setAcpRuntime(undefined);
				try { fs.rmSync(path.join(ws, '.git'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); fs.rmSync(path.join(ws, 'agent-made.txt'), { force: true }); } catch {}
			}
		}
		console.log('\nALL CONTROLLER TESTS PASSED');
	} catch (e) {
		console.error('FAIL', e);
		process.exitCode = 1;
		// A failed step can leave a run waiting on an approval forever: end the suite instead of
		// letting the runner kill it after 10 minutes (unref'd: a clean exit still wins).
		setTimeout(() => process.exit(1), 3000).unref();
	} finally {
		server.close();
		os.homedir = realHomedir;
		assert.equal(path.dirname(fixtureHome), path.resolve(os.tmpdir()));
		fs.rmSync(fixtureHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
		try { fs.rmSync(ws, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
	}
});
