#!/usr/bin/env node
/*
 * zer0ne as an MCP server over stdio — the entry outside agents add to their
 * MCP configuration:
 *
 *   { "command": "node", "args": ["<repo>/host/mcp-server.js"] }
 *
 * One tool call = one headless engine run (host/main.js --headless --json);
 * models, keys and safety stay inside the engine.
 */
'use strict';
delete process.env.ELECTRON_RUN_AS_NODE;
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const engineDir = process.env.ZER0NE_ENGINE_DIR || path.join(root, 'engine');
const out = path.join(engineDir, 'out');
if (!fs.existsSync(path.join(out, 'mcpServer.js'))) {
	process.stderr.write('mcp-server: the engine is missing at ' + engineDir + ' — run "npm run engine" first.\n');
	process.exit(1);
}
let version = '0.0.0';
try {
	version = JSON.parse(fs.readFileSync(path.join(engineDir, 'engine.json'), 'utf8')).extensionVersion || version;
} catch { /* dev engine without metadata */ }

const { start, liveDeps } = require(path.join(out, 'mcpServer.js'));
const operating = liveDeps(engineDir, version);
process.on('SIGINT', () => { operating.stop(); process.exit(0); });
process.on('SIGTERM', () => { operating.stop(); process.exit(0); });
// stdout carries only the protocol; engine logs go to stderr (host/main.js forwards them there).
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
	console[level] = (...args) => process.stderr.write(`[${level}] ${args.map(String).join(' ')}\n`);
}
start(operating.deps, process.stdin).then(() => {
	operating.stop();
	process.exit(0);
});
