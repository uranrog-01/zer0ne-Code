import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * zer0ne as an MCP server (stdio JSON-RPC 2.0): Claude Code, Codex, Zed or any
 * MCP client can drive a zer0ne turn as a tool. The protocol layer here is
 * small on purpose — every request becomes one headless engine run
 * (`host/main.js --headless --json`), which owns models, approvals and safety,
 * so the MCP surface adds no second policy path.
 *
 * Tools:
 *   zer0ne_prompt  run one agent turn in a project folder; returns the answer
 *                  and the files it changed
 *   zer0ne_status  engine availability and version
 *
 * `handle` is pure and tested; start reads stdin line-delimited JSON.
 */

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

export interface McpToolInfo {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface HeadlessOutcome {
	outcome: string;
	text: string;
	files?: string[];
}

/** What the server needs from the outside; tests inject fakes. */
export interface ServerDeps {
	version: string;
	/** Run one headless turn. */
	runPrompt(prompt: string, project: string | undefined, timeoutSec: number): Promise<HeadlessOutcome>;
	/** The default project folder (the server's working directory). */
	cwd(): string;
	write(chunk: string): void;
}

export const TOOLS: McpToolInfo[] = [
	{
		name: 'zer0ne_prompt',
		description:
			'Run one zer0ne coding-agent turn in a project folder. The agent reads and edits files, runs commands and answers with what it did. Returns its answer plus the list of files it changed. Use for delegated coding work ("fix the failing test in <folder>").',
		inputSchema: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: 'Complete, standalone instructions for the agent' },
				project: { type: 'string', description: 'Absolute path of the project folder (default: the server start folder)' },
				timeout_seconds: { type: 'number', description: 'Wall-clock budget, 30–3600 (default 600)' }
			},
			required: ['prompt']
		}
	},
	{
		name: 'zer0ne_status',
		description: 'Report whether the zer0ne engine can run, with its version.',
		inputSchema: { type: 'object', properties: {} }
	}
];

/** The largest prompt one tool call accepts: a work order, not a codebase. */
const MAX_PROMPT_CHARS = 100_000;

function err(id: unknown, code: number, message: string): Record<string, unknown> {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

function result(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
	return { jsonrpc: '2.0', id, result };
}

/** Handle one JSON-RPC message. Returns the reply (or null for notifications). */
export async function handle(msg: any, deps: ServerDeps): Promise<Record<string, unknown> | null> {
	const id = msg?.id ?? null;
	if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
		return id === null ? null : err(id, -32600, 'Invalid JSON-RPC request.');
	}
	if (id === null || msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled' || msg.method === 'initialized') {
		return null; // notifications get no reply
	}
	if (msg.method === 'initialize') {
		const wanted = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
		const protocol = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(wanted) ? wanted : MCP_PROTOCOL_VERSIONS[0];
		return result(id, {
			protocolVersion: protocol,
			capabilities: { tools: {} },
			serverInfo: { name: 'zer0ne', version: deps.version, title: 'zer0ne Code' }
		});
	}
	if (msg.method === 'ping') return result(id, {});
	if (msg.method === 'tools/list') {
		return result(id, { tools: TOOLS });
	}
	if (msg.method === 'tools/call') {
		const name = String(msg.params?.name ?? '');
		if (!TOOLS.some((t) => t.name === name)) {
			return result(id, { content: [{ type: 'text', text: `Unknown tool "${name}".` }], isError: true });
		}
		if (name === 'zer0ne_status') {
			return result(id, { content: [{ type: 'text', text: `zer0ne engine ${deps.version}: ready.` }] });
		}
		const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
		const prompt = String(args.prompt ?? '').trim();
		if (!prompt) return result(id, { content: [{ type: 'text', text: 'zer0ne_prompt needs a prompt.' }], isError: true });
		if (prompt.length > MAX_PROMPT_CHARS) return result(id, { content: [{ type: 'text', text: `The prompt is ${prompt.length} characters — the limit is ${MAX_PROMPT_CHARS}. State the task instead of pasting the codebase.` }], isError: true });
		let project: string | undefined;
		if (typeof args.project === 'string' && args.project.trim()) {
			project = path.resolve(args.project.trim());
			let stat: fs.Stats | undefined;
			try { stat = fs.statSync(project); } catch { stat = undefined; }
			if (!stat?.isDirectory()) return result(id, { content: [{ type: 'text', text: `Project folder "${args.project}" is not an accessible directory.` }], isError: true });
		}
		const rawTimeout = Number(args.timeout_seconds);
		const timeoutSec = Math.min(3600, Math.max(30, Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600));
		try {
			const report = await deps.runPrompt(prompt, project, timeoutSec);
			const files = (report.files ?? []).filter(Boolean);
			const text = [report.text || '(the agent finished without an answer)', files.length ? `\n\nChanged files:\n${files.map((f) => `- ${f}`).join('\n')}` : ''].join('');
			return result(id, { content: [{ type: 'text', text: text.slice(0, 400_000) }], isError: report.outcome !== 'completed' });
		} catch (error) {
			return result(id, { content: [{ type: 'text', text: `The zer0ne run failed: ${error instanceof Error ? error.message : String(error)}` }], isError: true });
		}
	}
	if (msg.method === 'shutdown') return result(id, {});
	return err(id, -32601, `Method not found: ${msg.method}`);
}

/** Line-delimited stdio server. Resolves when stdin closes or "exit" arrives. */
export function start(deps: ServerDeps, input: NodeJS.ReadableStream, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		let buf = '';
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			resolve();
		};
		input.setEncoding?.('utf8');
		input.on('data', (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				void (async () => {
					let msg: any;
					try { msg = JSON.parse(line); } catch { return; }
					try {
						const reply = await handle(msg, deps);
						if (reply) deps.write(JSON.stringify(reply) + '\n');
						if (msg.method === 'exit') done();
					} catch (error) {
						deps.write(JSON.stringify(err(msg?.id ?? null, -32603, `Internal error: ${error instanceof Error ? error.message : String(error)}`)) + '\n');
					}
				})();
			}
		});
		input.on('end', done);
		input.on('error', done);
		signal?.addEventListener('abort', done, { once: true });
	});
}

/** The real deps: one headless engine run per prompt call. */
export function liveDeps(engineDir: string, version: string): { deps: ServerDeps; stop(): void } {
	const children = new Set<ReturnType<typeof spawn>>();
	return {
		deps: {
			version,
			cwd: () => process.cwd(),
			write: (chunk) => process.stdout.write(chunk),
			runPrompt: (prompt, project, timeoutSec) =>
				new Promise<HeadlessOutcome>((resolve, reject) => {
					const argv = [path.join(engineDir, '..', 'host', 'main.js'), '--headless', '--json', '--timeout-sec', String(timeoutSec)];
					if (project) argv.push('--project', project);
					const child = spawn(process.execPath, argv, { cwd: project ?? process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
					children.add(child);
					let out = '';
					let stderrTail = '';
					const timer = setTimeout(() => {
						child.kill();
						reject(new Error(`The headless engine exceeded its ${timeoutSec} s budget.`));
					}, (timeoutSec + 60) * 1000);
					timer.unref?.();
					const finish = (report: HeadlessOutcome | undefined, error?: Error) => {
						clearTimeout(timer);
						children.delete(child);
						if (error) reject(error);
						else if (!report) reject(new Error(`The engine produced no report. ${stderrTail.slice(-300)}`));
						else resolve(report);
					};
					child.stdout.setEncoding('utf8');
					child.stdout.on('data', (chunk: string) => (out += chunk));
					child.stderr.setEncoding('utf8');
					child.stderr.on('data', (chunk: string) => (stderrTail = (stderrTail + chunk).slice(-2000)));
					child.on('error', (e) => finish(undefined, e));
					child.on('close', (code) => {
						// stdout may carry logging before the JSON report: take the last JSON object.
						let report: HeadlessOutcome | undefined;
						for (const candidate of out.split('\n').reverse()) {
							const line = candidate.trim();
							if (!line.startsWith('{')) continue;
							try {
								const parsed = JSON.parse(line);
								if (parsed && typeof parsed.outcome === 'string') {
									report = parsed;
									break;
								}
							} catch { /* not the report line */ }
						}
						finish(report, code !== 0 && !report ? new Error(`The engine exited with code ${code}. ${stderrTail.slice(-300)}`) : undefined);
					});
					child.stdin.on('error', () => undefined);
					child.stdin.end(prompt + '\n');
				})
		},
		stop: () => {
			for (const child of children) child.kill();
			children.clear();
		}
	};
}
