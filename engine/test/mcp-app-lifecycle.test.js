'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const load = Module._load;
Module._load = function(name, ...args) { return name === 'vscode' ? { env: {}, window: {} } : load.call(this, name, ...args); };
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { McpManager } = require(path.join(out, 'tools/mcp'));
const { McpAppsHost } = require(path.join(out, 'host/mcpAppsHost'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
	const deadline = Date.now() + 10000;
	while (!fn()) { if (Date.now() > deadline) throw new Error('MCP fixture timed out'); await pause(20); }
}

(async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-documents-'));
	const script = path.join(directory, 'server.cjs'), starts = path.join(directory, 'starts');
	fs.writeFileSync(script, `
const fs = require('node:fs');
fs.appendFileSync(process.argv[2], process.pid + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); if (m.id === undefined) return;
 const result = m.method === 'initialize' ? {protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{}},serverInfo:{name:'documents',version:'1'}}
  : m.method === 'tools/list' ? {tools:[{name:'document',inputSchema:{type:'object'},_meta:{ui:{resourceUri:'ui://documents/view'}}}]}
  : {contents:[{uri:'ui://documents/view',mimeType:'text/html;profile=mcp-app',text:'<p>Process ' + process.pid + '</p>'}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result}) + '\\n');
});
`);
	const manager = new McpManager(() => directory, () => {});
	const config = { id: 'documents', name: 'documents', transport: 'stdio', command: process.execPath, args: [script, starts], env: { ELECTRON_RUN_AS_NODE: '1' }, url: '', headers: {}, enabled: true, trusted: false };
	const card = id => ({ id, role: 'assistant', mcpApp: { toolName: 'mcp__documents__document', resourceUri: 'ui://documents/view', input: {}, result: {} } });
	const state = { sessionId: 'chat', messages: [card('first'), card('second')] };
	const documents = new McpAppsHost(manager, () => state), posted = [];
	const surface = { kind: 'chat', post: message => posted.push(message) };
	let pid;
	try {
		manager.sync([config], true);
		await until(() => ['ready', 'error'].includes(manager.statuses([config])[0].state));
		assert.equal(manager.statuses([config])[0].state, 'ready', manager.statuses([config])[0].error);
		pid = Number(fs.readFileSync(starts, 'utf8').trim());
		await Promise.all(state.messages.map(message => documents.handle(surface, { type: 'mcpAppOpen', sessionId: 'chat', id: message.id })));
		const keys = posted.filter(message => message.type === 'mcpAppOpened').map(message => message.key);
		assert.equal(keys.length, 2);
		assert.notEqual(keys[0], keys[1]);
		for (const key of keys) assert.ok(documents.document(key).includes('Process ' + pid));
		assert.deepEqual(fs.readFileSync(starts, 'utf8').trim().split(/\r?\n/), [String(pid)], 'opening documents must reuse the configured server process');
		await documents.handle(surface, { type: 'mcpAppClose', key: keys[0] });
		assert.equal(documents.document(keys[0]), undefined);
		assert.ok(documents.document(keys[1]), 'closing one document preserves its sibling');
		process.kill(pid, 0);
		await manager.dispose();
		await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
		assert.equal(documents.document(keys[1]), undefined, 'stopping the server revokes retained documents');
		console.log('MCP documents passed: concurrent cards reuse one real server process, independent close, shutdown revokes cards and terminates the process.');
	} finally {
		documents.dispose(); await manager.dispose(); Module._load = load;
		fs.rmSync(directory, { recursive: true, force: true });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
