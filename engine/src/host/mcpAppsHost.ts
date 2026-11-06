import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { HostFeature, HostSurface } from './context';
import type { StoredMessage } from '../providerStore';
import type { McpManager } from '../tools/mcp';
import type { McpClient } from '../tools/mcpClient';
import { object } from '../tools/mcpProtocol';

export function appResourceUri(tool: { _meta?: Record<string, any> }): string | undefined {
	const uri = tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
	return typeof uri === 'string' && /^ui:\/\//.test(uri) && uri.length <= 2048 ? uri : undefined;
}
function domains(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((d): d is string => typeof d === 'string' && /^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(d)).slice(0, 30) : [];
}
type View = { client: McpClient; sessionId: string; cardId: string; document: string; ready: boolean; expires: number; pending: number; rateAt: number; count: number };

/** The document token selects a native-bound server and card, never a server supplied by a View. */
export class McpAppsHost implements HostFeature {
	private views = new Map<string, View>();
	private expiryTimer?: ReturnType<typeof setTimeout>;
	constructor(private readonly mcp: McpManager, private readonly current: () => { sessionId: string; messages: StoredMessage[] }) {}
	private expireViews(): void {
		clearTimeout(this.expiryTimer);
		this.expiryTimer = undefined;
		const now = Date.now();
		for (const [key, view] of this.views) if (view.expires <= now) this.views.delete(key);
		if (this.views.size) {
			const next = Math.min(...[...this.views.values()].map(view => view.expires));
			this.expiryTimer = setTimeout(() => this.expireViews(), Math.max(1, next - now));
			this.expiryTimer.unref();
		}
	}
	document(key: string): string | undefined {
		const view = this.views.get(key);
		return view && view.sessionId === this.current().sessionId && this.current().messages.some(m => m.id === view.cardId) && view.expires > Date.now() && view.client.state === 'ready' ? view.document : undefined;
	}
	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		if (!['mcpAppOpen', 'mcpAppRequest', 'mcpAppClose'].includes(msg.type)) return false;
		if (surface.kind !== 'chat') throw new Error('MCP Apps are available in the desktop chat.');
		const state = this.current();
		if (msg.type === 'mcpAppClose') { this.views.delete(String(msg.key)); this.expireViews(); return true; }
		if (msg.type === 'mcpAppOpen') {
			if (msg.sessionId !== state.sessionId) throw new Error('The chat changed. Open the app again.');
			const card = state.messages.find(m => m.id === msg.id), app = card?.mcpApp;
			const hit = app && this.mcp.resolve(app.toolName);
			if (!app || !hit || appResourceUri(hit.tool) !== app.resourceUri) throw new Error('This MCP App is no longer available.');
			const resource = await hit.client.request('resources/read', { uri: app.resourceUri }, 30000);
			const content = resource?.contents?.find((c: any) => c.uri === app.resourceUri && c.mimeType === 'text/html;profile=mcp-app');
			if (!content || (typeof content.text !== 'string' && typeof content.blob !== 'string')) throw new Error('The server did not return an MCP App HTML resource.');
			const html = typeof content.text === 'string' ? content.text : Buffer.from(content.blob, 'base64').toString('utf8');
			if (Buffer.byteLength(html) > 2_000_000) throw new Error('This app exceeds the 2 MB display limit.');
			if (this.current().sessionId !== state.sessionId) throw new Error('The chat changed while the app loaded.');
			const csp = content._meta?.ui?.csp || {}, connect = domains(csp.connectDomains), resources = domains(csp.resourceDomains);
			let allow = false;
			if (connect.length || resources.length) allow = await vscode.window.showWarningMessage('This MCP App requests access to these network domains:\n' + [...new Set([...connect, ...resources])].join('\n'), { modal: true }, 'Allow domains') === 'Allow domains';
			if (this.current().sessionId !== state.sessionId || this.mcp.resolve(app.toolName)?.client !== hit.client) throw new Error('The app connection changed while loading.');
			const key = randomUUID(), policy = `default-src 'none'; script-src 'unsafe-inline' ${allow ? resources.join(' ') : ''}; style-src 'unsafe-inline' ${allow ? resources.join(' ') : ''}; img-src data: blob: ${allow ? resources.join(' ') : ''}; font-src data: ${allow ? resources.join(' ') : ''}; connect-src ${allow && connect.length ? connect.join(' ') : "'none'"}; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
			const safeHtml = `<meta http-equiv="Content-Security-Policy" content="${policy}">` + html;
			const data = JSON.stringify(safeHtml).replace(/</g, '\\u003c');
			const document = `<!doctype html><meta charset="utf-8"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;color-scheme:light dark}</style><iframe sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"></iframe><script>const frame=document.querySelector('iframe');let loaded=false;const waiting=[];addEventListener('message',e=>{if(e.source===parent){if(loaded)frame.contentWindow.postMessage(e.data,'*');else waiting.push(e.data)}else if(e.source===frame.contentWindow&&e.data&&typeof e.data==='object'&&!String(e.data.method||'').startsWith('ui/notifications/sandbox-'))parent.postMessage(e.data,'*')});frame.onload=()=>{loaded=true;for(const message of waiting.splice(0))frame.contentWindow.postMessage(message,'*')};frame.srcdoc=${data};</script>`;
			for (const [id, old] of this.views) if (old.expires < Date.now() || old.sessionId !== state.sessionId) this.views.delete(id);
			if (this.views.size >= 20) this.views.delete(this.views.keys().next().value!);
			this.views.set(key, { client: hit.client, sessionId: state.sessionId, cardId: card!.id, document, ready: false, expires: Date.now() + 60 * 60 * 1000, pending: 0, rateAt: Date.now(), count: 0 });
			this.expireViews();
			surface.post({ type: 'mcpAppOpened', key, id: card!.id, sessionId: state.sessionId, input: app.input, result: app.result, tool: hit.tool });
			return true;
		}
		const view = this.views.get(String(msg.key)), request = msg.request;
		if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || JSON.stringify(request).length > 65536 || request.id !== undefined && !['string', 'number'].includes(typeof request.id)) return true;
		const response = (result?: unknown, error?: string) => surface.post({ type: 'mcpAppResponse', key: msg.key, response: { jsonrpc: '2.0', id: request.id, ...(error ? { error: { code: -32601, message: error } } : { result }) } });
		const valid = () => !!view && this.views.get(String(msg.key)) === view && view.sessionId === this.current().sessionId && view.client.state === 'ready' && view.expires > Date.now() && this.current().messages.some(m => m.id === view.cardId && m.mcpApp && this.mcp.resolve(m.mcpApp.toolName)?.client === view.client);
		if (!view || !valid()) { if (request.id !== undefined) response(undefined, 'This MCP App connection has expired.'); return true; }
		if (Date.now() - view.rateAt > 1000) { view.rateAt = Date.now(); view.count = 0; }
		if (++view.count > 30 || view.pending >= 2) { if (request.id !== undefined) response(undefined, 'Too many app requests. Try again shortly.'); return true; }
		if (request.method === 'ui/initialize') {
			response({ protocolVersion: '2026-01-26', hostInfo: { name: 'zer0ne Code', version: '0.3.0' }, hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {} }, hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline'] } }); return true;
		}
		if (request.method === 'ui/notifications/initialized') { view.ready = true; surface.post({ type: 'mcpAppReady', key: msg.key }); return true; }
		if (!view.ready) { response(undefined, 'Initialize this app first.'); return true; }
		view.pending++;
		try {
			if (request.method === 'tools/list') {
				response({ tools: view.client.tools.filter(t => !view.client.config.disabledTools?.includes(t.name) && (!Array.isArray(t._meta?.ui?.visibility) || t._meta!.ui.visibility.includes('app'))) });
			} else if (request.method === 'tools/call') {
				const tool = view.client.tools.find(t => t.name === request.params?.name);
				const name = this.mcp.toolDefs().find(d => this.mcp.resolve(d.name)?.client === view.client && this.mcp.resolve(d.name)?.tool === tool)?.name;
				// App-only tools are still subject to the server's disabled-tool switches.
				if (!tool || view.client.config.disabledTools?.includes(tool.name) || Array.isArray(tool._meta?.ui?.visibility) && !tool._meta!.ui.visibility.includes('app') || !object(request.params?.arguments ?? {})) throw new Error('This app tool is unavailable.');
				const approved = await vscode.window.showWarningMessage(`Allow ${view.client.config.name} › ${tool.name}?\n${JSON.stringify(request.params.arguments || {}).slice(0, 3000)}`, { modal: true }, 'Run tool') === 'Run tool';
				if (!approved || !valid() || view.client.config.disabledTools?.includes(tool.name) || !view.client.tools.includes(tool)) throw new Error('The app action was cancelled.');
				response(name ? (await this.mcp.call(name, request.params.arguments || {}, undefined, { client: view.client, tool })).result : await view.client.request('tools/call', { name: tool.name, arguments: request.params.arguments || {} }, 120000));
			} else if (request.method === 'resources/list') {
				const result = await view.client.request('resources/list', {}, 30000);
				response({ resources: Array.isArray(result?.resources) ? result.resources.filter((r: any) => typeof r?.uri === 'string' && r.uri.startsWith('ui://')).slice(0, 100) : [] });
			} else if (request.method === 'resources/read') {
				if (typeof request.params?.uri !== 'string' || !request.params.uri.startsWith('ui://')) throw new Error('Only this server’s UI resources are available.');
				response(await view.client.request('resources/read', { uri: request.params.uri }, 30000));
			} else if (request.method === 'ui/open-link') {
				const url = new URL(request.params?.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links are allowed.');
				const allow = await vscode.window.showWarningMessage('Open this link in your browser?\n' + url.href, { modal: true }, 'Open link');
				response({ isError: allow !== 'Open link' || !valid() || !await vscode.env.openExternal(vscode.Uri.parse(url.href)) });
			} else if (request.id !== undefined) response(undefined, 'This host does not support ' + request.method);
		} catch (error) { response(undefined, error instanceof Error ? error.message : String(error)); }
		finally { view.pending--; }
		return true;
	}
	dispose(): void { clearTimeout(this.expiryTimer); this.expiryTimer = undefined; this.views.clear(); }
}
