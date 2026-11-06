import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

export const MCP_MAX_BYTES = 16 * 1024 * 1024;
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Cancelling one caller stops its wait without cancelling work shared by other callers. */
export function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
		const done = (fn: (v: any) => void) => (v: any) => { signal.removeEventListener('abort', abort); fn(v); };
		work.then(done(resolve), done(reject));
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	});
}

export function validateMessage(v: unknown): Record<string, any> {
	if (!object(v) || v.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC message.');
	if (v.id !== undefined && typeof v.id !== 'string' && typeof v.id !== 'number') throw new Error('Invalid MCP request ID.');
	if (typeof v.method === 'string') return v;
	if (v.id === undefined || (!('result' in v) && !object(v.error))) throw new Error('Invalid MCP response.');
	return v;
}

export async function readJsonBody(res: Response): Promise<any> {
	if (!res.body) throw new Error('The MCP server returned an empty response.');
	const reader = res.body.getReader();
	let bytes = 0, text = '';
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MCP_MAX_BYTES) throw new Error('MCP response exceeds 16 MiB.');
			text += decoder.decode(value, { stream: true });
		}
		return JSON.parse(text + decoder.decode());
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Stop after the matching response; a server need not close its physical SSE stream first. */
export async function readSse(res: Response, onMessage: (msg: Record<string, any>) => Promise<boolean>): Promise<void> {
	if (!res.body) throw new Error('The MCP server returned an empty SSE stream.');
	const reader = res.body.getReader(), decoder = new TextDecoder();
	let buffer = '', data: string[] = [], eventBytes = 0;
	const dispatch = async (): Promise<boolean> => {
		const raw = data.join('\n'); data = []; eventBytes = 0;
		return raw ? onMessage(validateMessage(JSON.parse(raw))) : false;
	};
	try {
		while (true) {
			const { done, value } = await reader.read();
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			if (Buffer.byteLength(buffer) > MCP_MAX_BYTES) throw new Error('MCP SSE line exceeds 16 MiB.');
			let end: number;
			while ((end = buffer.search(/[\r\n]/)) >= 0) {
				if (!done && buffer[end] === '\r' && end === buffer.length - 1) break;
				const line = buffer.slice(0, end), width = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
				buffer = buffer.slice(end + width);
				if (!line) { if (await dispatch()) return; }
				else if (line.startsWith('data:')) {
					const field = line.slice(5).replace(/^ /, ''); eventBytes += Buffer.byteLength(field) + 1;
					if (eventBytes > MCP_MAX_BYTES) throw new Error('MCP SSE event exceeds 16 MiB.');
					data.push(field);
				}
			}
			if (done) return;
		}
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export function spawnMcp(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): ChildProcess {
	if (process.platform !== 'win32') return spawn(command, args, { cwd, env });
	const extensions = path.extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat', ''];
	const dirs = /[\\/]/.test(command) ? [''] : (env.PATH ?? env.Path ?? process.env.PATH ?? '').split(path.delimiter);
	const file = dirs.flatMap(dir => extensions.map(ext => path.resolve(dir || cwd || '.', command + ext))).find(candidate => fs.existsSync(candidate)) ?? command;
	if (!/\.(cmd|bat)$/i.test(file)) return spawn(file, args, { cwd, env, windowsHide: true });
	if (/^(npx|npm)\.cmd$/i.test(path.basename(file))) {
		const cli = path.join(path.dirname(file), 'node_modules', 'npm', 'bin', path.basename(file).toLowerCase().startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js');
		const node = path.join(path.dirname(file), 'node.exe');
		if (fs.existsSync(cli) && fs.existsSync(node)) return spawn(node, [cli, ...args], { cwd, env, windowsHide: true });
	}
	// Batch files necessarily reparse arguments. Reject forms cmd cannot preserve instead of changing their meaning.
	if ([file, ...args].some(arg => /[%!"\r\n\0]/.test(arg))) throw new Error('This Windows batch MCP command cannot preserve %, ! or quoted arguments. Select its .exe or Node script instead.');
	const quote = (arg: string) => `"${arg.replace(/\\+$/, slashes => slashes + slashes)}"`;
	return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quote).join(' ')}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
}
