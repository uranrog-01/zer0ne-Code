// A tiny Agent Client Protocol agent for tests: JSON-RPC over stdio, one object per line.
// Behaviour follows the prompt text so one process can exercise every path.
const readline = require('readline');

const signedIn = process.env.MOCK_AUTH_FILE ? require('fs').existsSync(process.env.MOCK_AUTH_FILE) : process.env.MOCK_SIGNED_IN !== '0';
const rl = readline.createInterface({ input: process.stdin });
let nextId = 1000;
const waiting = new Map();
let auth = signedIn;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let cancelled = false;
let sessionCwd = process.cwd();

rl.on('line', async (line) => {
	let m;
	try { m = JSON.parse(line); } catch { return; }
	if (m.method === undefined) { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } return; }
	if (m.id === undefined) { if (m.method === 'session/cancel') cancelled = true; return; }
	const reply = (result) => send({ jsonrpc: '2.0', id: m.id, result });
	const fail = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
	switch (m.method) {
		case 'initialize':
			return reply({ protocolVersion: 1, agentInfo: { name: 'mock-agent', title: 'Mock Agent', version: '1.0.0' }, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: process.env.MOCK_AUTH_FILE ? m.params.clientCapabilities.auth?.terminal ? [{ id: 'mock-terminal', name: 'Sign in with Mock', type: 'terminal', args: ['--mock-login'], env: { MOCK_LOGIN: '1' } }] : [] : [{ id: 'mock-login', name: 'Sign in with Mock', description: 'Agent-run OAuth' }] });
		case 'authenticate':
			// Like Antigravity: print the sign-in link outside the protocol, then finish.
			process.stdout.write('Open the following link to authenticate the ACP server: https://mock.example.com/oauth?state=abc\n');
			await new Promise((r) => setTimeout(r, 30));
			auth = true;
			return reply({});
		case 'session/new':
			if (!auth) return fail(-32000, 'Authentication required');
			sessionCwd = m.params.cwd || sessionCwd;
			return reply({ sessionId: 'sess-1', configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'mock-fast', options: [{ value: 'mock-fast', name: 'Mock Fast' }, { value: 'mock-pro', name: 'Mock Pro' }] }], modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } });
		case 'session/set_config_option':
			process.env.MOCK_MODEL = m.params.value;
			return reply({});
		case 'session/set_mode':
			return reply({});
		case 'session/prompt': {
			cancelled = false;
			const sid = m.params.sessionId;
			const text = (m.params.prompt || []).map((b) => b.text || '').join('\n');
			update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking… ' } });
			update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'model=' + (process.env.MOCK_MODEL || 'mock-fast') + ' ' } });
			if (/RUN:(\S+)/.test(text)) {
				const cmd = /RUN:(\S+)/.exec(text)[1];
				update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc1', title: 'Run ' + cmd, kind: 'execute', status: 'pending', rawInput: { command: cmd } });
				const r = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'tc1', title: 'Run ' + cmd, kind: 'execute', rawInput: { command: cmd } }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
				const allowed = r.result && r.result.outcome && r.result.outcome.optionId === 'ok';
				update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'ran ' + cmd : 'rejected' } }] });
				update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'done ' : 'skipped ' } });
			}
			if (/OWNWRITE:(\S+)/.test(text)) {
				// Like OpenCode: the agent edits the file itself, with no permission and no fs request.
				const file = /OWNWRITE:(\S+)/.exec(text)[1];
				const full = require('path').join(sessionCwd, file);
				update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc3', title: 'write', kind: 'edit', status: 'in_progress', locations: [{ path: full }] });
				require('fs').writeFileSync(full, 'own edit\n');
				update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc3', status: 'completed' });
				update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'edited ' } });
			}
			if (/(^|\s)WRITE:(\S+)/.test(text)) {
				const file = /(^|\s)WRITE:(\S+)/.exec(text)[2];
				update(sid, { sessionUpdate: 'tool_call', toolCallId: 'tc2', title: 'Edit ' + file, kind: 'edit', status: 'in_progress', locations: [{ path: file }] });
				const w = await ask('fs/write_text_file', { sessionId: sid, path: file, content: 'written by mock\n' });
				update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc2', status: w.error ? 'failed' : 'completed' });
				update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w.error ? 'write refused ' : 'wrote ' } });
			}
			if (/READ:(\S+)/.test(text)) {
				const file = /READ:(\S+)/.exec(text)[1];
				const r = await ask('fs/read_text_file', { sessionId: sid, path: file });
				update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'read=' + JSON.stringify(r.result && r.result.content) + ' ' } });
			}
			if (/SLOW/.test(text)) {
				for (let i = 0; i < 60 && !cancelled; i++) await new Promise((r) => setTimeout(r, 50));
				return reply({ stopReason: cancelled ? 'cancelled' : 'end_turn' });
			}
			update(sid, { sessionUpdate: 'plan', entries: [{ content: 'step one', status: 'completed', priority: 'medium' }] });
			return reply({ stopReason: 'end_turn' });
		}
		default:
			return fail(-32601, 'Method not found: ' + m.method);
	}
});
