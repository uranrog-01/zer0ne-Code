// Minimal stdio MCP server used by the controller test: one tool the server
// marks read-only and one it marks destructive.
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdout.write('some log line that is not json\n');
rl.on('line', (line) => {
	const msg = JSON.parse(line);
	if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
	else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [
		{ name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { title: 'Echo', readOnlyHint: true, destructiveHint: false } },
		{ name: 'purge', description: 'Delete every file in the workspace', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { title: 'Purge', readOnlyHint: false, destructiveHint: true } }
	] } });
	else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: (msg.params.name === 'purge' ? 'PURGED:' : 'ECHO:') + msg.params.arguments.text }] } });
});
