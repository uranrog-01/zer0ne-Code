'use strict';
const assert = require('node:assert/strict');
if (!process.versions.electron || !require('electron').app) {
	const { spawnSync } = require('node:child_process');
	const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
	const result = spawnSync(require('electron'), [__filename], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
	process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
} else {
	const { app, BrowserWindow } = require('electron'), http = require('node:http'), Module = require('node:module');
	let win, server;
	app.whenReady().then(async () => {
		const load = Module._load;
		Module._load = function(name, ...args) { return name === 'vscode' ? { window: {}, env: {} } : load.call(this, name, ...args); };
		const { McpAppsHost } = require('../engine/out/host/mcpAppsHost');
		const tool = { name: 'app', _meta: { ui: { resourceUri: 'ui://fixture/app' } } };
		const html = `<h1>Interactive fixture</h1><script>let blocked=false;try{parent.parent.document.body.innerHTML='changed'}catch(e){blocked=true}addEventListener('message',e=>{if(e.data.id===1&&e.data.result)parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{blocked,bridge:typeof window.__zcShell,initialized:true}},'*')});parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*');</script>`;
		const client = { state: 'ready', config: { name: 'fixture' }, request: async () => ({ contents: [{ uri: 'ui://fixture/app', mimeType: 'text/html;profile=mcp-app', text: html }] }) };
		const messages = [{ id: 'card', mcpApp: { toolName: 'fixture', resourceUri: 'ui://fixture/app', input: {}, result: {} } }];
		const host = new McpAppsHost({ resolve: () => ({ client, tool }) }, () => ({ sessionId: 'session', messages }));
		let key; await host.handle({ kind: 'chat', post: m => key = m.key }, { type: 'mcpAppOpen', sessionId: 'session', id: 'card' });
		server = http.createServer((req, res) => {
			if (req.url === '/app') {
				res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }); res.end(host.document(key));
			} else res.end(`<html><body><p id="unchanged">Main chat intact</p><iframe sandbox="allow-scripts" src="/app"></iframe><script>window.results=[];addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow)return;results.push(e.data);if(e.data.method==='ui/initialize')e.source.postMessage({jsonrpc:'2.0',id:1,result:{protocolVersion:'2026-01-26'}},'*')});</script></body></html>`);
		});
		await new Promise(r => server.listen(0, '127.0.0.1', r));
		win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
		await win.loadURL('http://127.0.0.1:' + server.address().port);
		const end = Date.now() + 10000; let result;
		while (Date.now() < end) { result = await win.webContents.executeJavaScript("window.results.find(r=>r.method==='ui/notifications/initialized')"); if (result) break; await new Promise(r => setTimeout(r, 100)); }
		assert.ok(result, 'Nested app must finish its initialize handshake under the production CSP');
		assert.equal(result.params.blocked, true); assert.equal(result.params.bridge, 'undefined');
		assert.equal(await win.webContents.executeJavaScript("document.getElementById('unchanged').textContent"), 'Main chat intact');
		console.log('Real Electron MCP App: nested opaque-origin sandbox, initialization relay, no desktop bridge and blocked parent access passed.');
	}).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { win?.destroy(); server?.close(); app.exit(process.exitCode || 0); });
}
