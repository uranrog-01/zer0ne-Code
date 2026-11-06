import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { ChildProcess } from 'child_process';
import { spawnMcp } from './mcpProtocol';
import { killTree, scrubEnv } from './proc';
import { projectFile } from './projectChecks';
import { redactSecrets } from './redact';

type Pending = { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; cleanup(): void };
const MAX_FRAME = 8 * 1024 * 1024;
const languageId = (file: string) => ({'.ts':'typescript','.tsx':'typescriptreact','.js':'javascript','.jsx':'javascriptreact','.py':'python','.rs':'rust','.go':'go','.json':'json','.css':'css','.html':'html','.cpp':'cpp','.c':'c','.cs':'csharp'}[path.extname(file)] || 'plaintext');

/** A read-only LSP client; it never installs a server or accepts edits from one. */
export class LanguageService {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private buffer = Buffer.alloc(0);
	private seq = 0;
	private pending = new Map<number, Pending>();
	private documents = new Map<string, {text:string; version:number}>();
	private diagnostics = new Map<string, {version?:number; items:unknown[]; at:number}>();
	private capabilities: Record<string, any> = {};
	private idle?: ReturnType<typeof setTimeout>;
	private closed = false;
	constructor(readonly root: string, readonly command: string, readonly args: string[], readonly deny = '') {}
	get connected(): boolean { return !!this.child && this.child.exitCode === null && !this.closed; }
	private touch(): void { clearTimeout(this.idle); this.idle = setTimeout(() => this.dispose(),5 * 60_000); this.idle.unref?.(); }
	private send(message: Record<string, unknown>): void {
		if (!this.child?.stdin?.writable) throw new Error('Language server is not connected.');
		const body = Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));
		this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]));
	}
	private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
		signal?.throwIfAborted(); this.touch();
		return new Promise((resolve,reject) => {
			const id = ++this.seq;
			const finish = (error?: Error) => { const p = this.pending.get(id); if (!p) return; this.pending.delete(id); p.cleanup(); if (error) p.reject(error); };
			const abort = () => { try { this.send({method:'$/cancelRequest',params:{id}}); } catch { /* disconnected */ } finish(Object.assign(new Error('Language request cancelled.'),{name:'AbortError'})); };
			const timer = setTimeout(() => finish(new Error(`Language server timed out: ${method}`)),15_000);
			const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort',abort); };
			this.pending.set(id,{resolve,reject,timer,cleanup});
			signal?.addEventListener('abort',abort,{once:true});
			try { this.send({id,method,params}); } catch (error) { finish(error as Error); }
		});
	}
	private fail(error: Error): void {
		for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
		this.pending.clear(); this.dispose();
	}
	private receive(chunk: Buffer): void {
		if (this.closed) return;
		this.buffer = Buffer.concat([this.buffer,chunk]);
		try {
			while (true) {
				const split = this.buffer.indexOf('\r\n\r\n');
				if (split < 0) { if (this.buffer.length > 8192) throw new Error('Invalid language-server frame header.'); return; }
				const match = /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i.exec(this.buffer.subarray(0,split).toString('ascii'));
				const size = Number(match?.[1]);
				if (!match || size > MAX_FRAME || size <= 0) throw new Error('Invalid or oversized language-server frame.');
				if (this.buffer.length < split + 4 + size) return;
				const message = JSON.parse(this.buffer.subarray(split+4,split+4+size).toString('utf8'));
				this.buffer = this.buffer.subarray(split+4+size);
				if (message.jsonrpc !== '2.0') throw new Error('Invalid language-server message.');
				if (message.method) {
					if (message.id !== undefined) {
						// Servers cannot apply edits, launch commands or gain configuration outside this workspace.
						this.send(message.method === 'workspace/configuration' ? {id:message.id,result:(message.params?.items || []).slice(0,100).map(() => null)} : {id:message.id,error:{code:-32601,message:'Read-only client: method not supported'}});
					} else if (message.method === 'textDocument/publishDiagnostics' && typeof message.params?.uri === 'string' && this.documents.has(message.params.uri)) {
						const version = message.params.version, doc = this.documents.get(message.params.uri)!;
						if (version === undefined || version === doc.version) this.diagnostics.set(message.params.uri,{version,items:Array.isArray(message.params.diagnostics) ? message.params.diagnostics.slice(0,500) : [],at:Date.now()});
					}
				} else {
					const item = this.pending.get(message.id);
					if (!item) continue;
					this.pending.delete(message.id); item.cleanup();
					message.error ? item.reject(new Error(String(message.error.message || 'Language-server error'))) : item.resolve(message.result);
				}
			}
		} catch (error) { this.fail(error as Error); }
	}
	async connect(signal?: AbortSignal): Promise<void> {
		if (this.closed) throw new Error('Language server closed. Run a new check to reconnect.');
		if (!this.command.trim() || this.command.includes('\0')) throw new Error('Configure a local language-server executable and its JSON argument array in Features.');
		if (!this.starting) this.starting = (async () => {
			const child = this.child = spawnMcp(this.command,this.args,this.root,scrubEnv());
			child.stdout?.on('data',(chunk:Buffer) => this.receive(chunk));
			child.stderr?.on('data',() => {});
			child.stdin?.on('error',error => this.fail(error));
			child.on('error',error => this.fail(error));
			child.on('exit',() => this.fail(new Error('Language server exited.')));
			const result = await this.request('initialize',{
				processId:process.pid,rootUri:pathToFileURL(this.root).href,
				workspaceFolders:[{uri:pathToFileURL(this.root).href,name:path.basename(this.root)}],
				capabilities:{workspace:{configuration:true,applyEdit:false},textDocument:{synchronization:{dynamicRegistration:false},publishDiagnostics:{versionSupport:true},diagnostic:{dynamicRegistration:false}}}
			},signal);
			this.capabilities = result?.capabilities || {};
			this.send({method:'initialized',params:{}});
		})();
		try { await this.starting; signal?.throwIfAborted(); this.touch(); }
		catch (error) { this.dispose(); throw error; }
	}
	async inspect(operation: string, relative: string, position: {line?:number; character?:number; symbol?:string; query?:string}, signal?: AbortSignal): Promise<unknown> {
		await this.connect(signal);
		const methods: Record<string,[string,string]> = {definition:['textDocument/definition','definitionProvider'],references:['textDocument/references','referencesProvider'],implementation:['textDocument/implementation','implementationProvider'],hover:['textDocument/hover','hoverProvider'],document_symbols:['textDocument/documentSymbol','documentSymbolProvider'],workspace_symbols:['workspace/symbol','workspaceSymbolProvider']};
		if (operation === 'workspace_symbols') {
			if (!this.capabilities.workspaceSymbolProvider) throw new Error('This server does not advertise workspace symbols.');
			return this.safeResult(await this.request('workspace/symbol',{query:String(position.query || '').slice(0,500)},signal));
		}
		const file = projectFile(this.root,relative,this.deny);
		if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error('Language-service input is limited to 2 MiB per file.');
		const text = fs.readFileSync(file,'utf8');
		if (text.includes('\0')) throw new Error('Language services require a text file.');
		const uri = pathToFileURL(file).href, previous = this.documents.get(uri);
		if (!previous) { this.documents.set(uri,{text,version:1}); this.send({method:'textDocument/didOpen',params:{textDocument:{uri,languageId:languageId(file),version:1,text}}}); }
		else if (previous.text !== text) { const version = previous.version+1; this.documents.set(uri,{text,version}); this.diagnostics.delete(uri); this.send({method:'textDocument/didChange',params:{textDocument:{uri,version},contentChanges:[{text}]}}); }
		if (operation === 'diagnostics') {
			if (this.capabilities.diagnosticProvider) {
				const result = await this.request('textDocument/diagnostic',{textDocument:{uri}},signal);
				if (result?.kind !== 'full' || !Array.isArray(result.items)) throw new Error('The server did not return a full diagnostic report.');
				return this.safeResult(result.items.slice(0,500));
			}
			const until = Date.now()+5000;
			while (!this.diagnostics.has(uri) && Date.now() < until) { signal?.throwIfAborted(); await new Promise(resolve => setTimeout(resolve,50)); }
			const result = this.diagnostics.get(uri);
			if (!result) throw new Error('No diagnostics received. This server may not publish diagnostics for this file.');
			return this.safeResult(result.items);
		}
		const spec = methods[operation];
		if (!spec || !this.capabilities[spec[1]]) throw new Error('This operation is not supported by the configured language server.');
		const lines = text.split(/\r?\n/), line = Number(position.line ?? 1)-1;
		if (!Number.isInteger(line) || line < 0 || line >= lines.length) throw new Error('Choose a valid 1-based line.');
		const character = position.symbol ? lines[line].indexOf(position.symbol) : Number(position.character ?? 1)-1;
		if (!Number.isInteger(character) || character < 0 || character > lines[line].length) throw new Error('Choose a valid character or symbol on that line.');
		return this.safeResult(await this.request(spec[0],{textDocument:{uri},position:{line,character},...(operation === 'references' ? {context:{includeDeclaration:true}} : {})},signal));
	}
	private safeResult(value: unknown, depth = 0): unknown {
		if (depth > 20) return undefined;
		if (Array.isArray(value)) return value.slice(0,500).map(v => this.safeResult(v,depth+1)).filter(v => v !== undefined);
		if (!value || typeof value !== 'object') return value;
		const obj = value as Record<string, unknown>, out: Record<string, unknown> = {};
		for (const [key,item] of Object.entries(obj)) {
			if ((key === 'uri' || key === 'targetUri') && typeof item === 'string') {
				try { const file = projectFile(this.root,fileURLToPath(item),this.deny); out[key === 'uri' ? 'path' : 'targetPath'] = path.relative(this.root,file); } catch { return undefined; }
			} else out[key] = this.safeResult(item,depth+1);
		}
		return out;
	}
	describe(): string[] { return Object.keys(this.capabilities).filter(key => this.capabilities[key] && key.endsWith('Provider')); }
	dispose(): void {
		if (this.closed) return;
		this.closed = true; clearTimeout(this.idle);
		for (const item of this.pending.values()) { item.cleanup(); item.reject(new Error('Language server closed.')); }
		this.pending.clear(); this.documents.clear(); this.diagnostics.clear(); this.buffer = Buffer.alloc(0);
		killTree(this.child);
	}
}

const services = new Map<string,LanguageService>();
export function configuredLanguageService(root: string, settings: {languageServerCommand:string; languageServerArgs:string; denyPaths:string}): LanguageService {
	let args: unknown;
	try { args = JSON.parse(settings.languageServerArgs || '[]'); } catch { throw new Error('Language-server arguments must be a JSON string array.'); }
	if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4000 || arg.includes('\0'))) throw new Error('Use at most 64 string arguments for the language server.');
	const base = fs.realpathSync(root), key = JSON.stringify([base,settings.languageServerCommand,args,settings.denyPaths]);
	let service = services.get(key);
	if (!service?.connected) {
		for (const [other,existing] of services) if (existing.root === base) { existing.dispose(); services.delete(other); }
		service = new LanguageService(base,settings.languageServerCommand,args as string[],settings.denyPaths); services.set(key,service);
	}
	return service;
}
export function closeLanguageServices(root?: string): void { for (const [key,service] of services) if (!root || service.root === root) { service.dispose(); services.delete(key); } }
export function languageResult(value: unknown): string { return redactSecrets(JSON.stringify(value ?? null,null,2)).text.slice(0,64000); }
