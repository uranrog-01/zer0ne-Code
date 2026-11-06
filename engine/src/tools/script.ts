import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import type { AgentSettings } from '../providerStore';
import { hostToolAllowed } from '../host/capabilities';

/**
 * run_script — programmatic tool calling (DeepSeek Harness PTC, Codex code
 * mode, omp eval). The model writes one async JavaScript program that calls
 * read-only tools as functions and prints only what it needs: reading 40
 * files and counting something costs one round trip and a few hundred
 * tokens instead of 40 tool results in the context.
 *
 * Isolation: the program runs in a separate Node process under Node's
 * permission model — no file writes, no child processes, no workers, and it
 * can read only its own runner file. Everything else goes through the host's
 * tools over IPC (same path confinement, redaction and Token Saver).
 *
 * `keep` turns it into a REPL (like ZCode's Node REPL): the chat's process stays alive between
 * runs and `state` keeps what the program put there, until 10 idle minutes, a reset, a
 * timeout or a stop.
 */

const RUNNER = `
const pending = new Map();
let seq = 0;
const out = [];
let size = 0;
const state = {};
const LIMIT = 40000;
function print(...a) {
	const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ');
	if (size < LIMIT) { out.push(line); size += line.length + 1; }
}
// Arrays that also answer the string methods models reach for (split/trim/match…),
// so code written for either shape works.
function listOf(items, text) {
	const a = Array.isArray(items) ? items.slice() : [];
	const t = String(text ?? '');
	for (const k of ['split', 'trim', 'match', 'matchAll', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'toLowerCase', 'toUpperCase', 'search']) {
		Object.defineProperty(a, k, { value: (...args) => t[k](...args), enumerable: false });
	}
	Object.defineProperty(a, 'toString', { value: () => t, enumerable: false });
	return a;
}
const tools = new Proxy({}, {
	get: (_t, name) => (args = {}) => new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve, reject });
		process.send({ type: 'call', id, name: String(name), args });
	})
});
process.on('message', async (m) => {
	if (m.type === 'result') {
		const p = pending.get(m.id);
		pending.delete(m.id);
		if (!p) return;
		if (m.error) return p.reject(new Error(m.error));
		p.resolve(m.kind === 'list' ? listOf(m.data, m.text) : m.data !== undefined ? m.data : m.text);
		return;
	}
	if (m.type === 'run') {
		out.length = 0;
		size = 0;
		try {
			const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
			const value = await new AsyncFunction('tools', 'print', 'state', m.code)(tools, print, state);
			process.send({ type: 'done', output: out.join('\\n'), value: value === undefined ? undefined : JSON.stringify(value, null, 2) });
		} catch (e) {
			process.send({ type: 'done', output: out.join('\\n'), error: String((e && e.stack) || e).split('\\n').slice(0, 6).join('\\n') });
		}
	}
});
`;

export const SCRIPT_TOOLS = ['list_files', 'read_file', 'grep', 'semantic_search', 'code_intel', 'get_diagnostics', 'git_status', 'git_diff', 'git_log', 'web_fetch', 'web_search', 'memory_recall'];

export function availableScriptTools(settings: AgentSettings, allowed?: ReadonlySet<string>): string[] {
	return SCRIPT_TOOLS.filter(name => hostToolAllowed(name) && (!allowed || allowed.has(name))
		&& (name !== 'semantic_search' || settings.codeIndex)
		&& (!name.startsWith('git_') || settings.gitTools)
		&& (!name.startsWith('web_') || settings.browserTools)
		&& (name !== 'memory_recall' || settings.agentMemory !== false));
}

let flag: string | null | undefined;

/** Whether scripts can run sandboxed here (Node permission model available). */
export function scriptSandboxAvailable(): boolean {
	return permissionFlag(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }) !== null;
}

/** Which permission flag this Node/Electron supports ('' = none → no sandbox). */
function permissionFlag(exe: string, env: NodeJS.ProcessEnv): string | null {
	if (flag !== undefined) {
		return flag;
	}
	for (const f of ['--permission', '--experimental-permission']) {
		const r = spawnSync(exe, [f, '-e', 'process.exit(require("fs").existsSync ? 0 : 1)'], { env, timeout: 15_000, windowsHide: true });
		if (r.status === 0) {
			return (flag = f);
		}
	}
	return (flag = null);
}

/** What a script's tools.NAME(...) resolves to: plain data where that is what code expects. */
export interface ScriptValue {
	text: string;
	data?: unknown;
	kind?: 'list';
}

export interface ScriptResult {
	output: string;
	value?: string;
	error?: string;
	calls: number;
	sandboxed: boolean;
	timedOut: boolean;
}

interface ScriptProcess { child: ChildProcess; dir: string; sandboxed: boolean; stderr: string; idle?: ReturnType<typeof setTimeout> }

/** Kept REPL processes, one per chat. */
const kept = new Map<string, ScriptProcess>();
const KEEP_IDLE_MS = 10 * 60_000;

function startProcess(): ScriptProcess {
	const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' };
	const exe = process.execPath;
	const perm = permissionFlag(exe, env);
	// The real path: Node's permission model checks resolved paths, and macOS temp (/var/folders) is a symlink to /private/var.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-script-')));
	const runner = path.join(dir, 'runner.js');
	fs.writeFileSync(runner, RUNNER);
	const args = perm ? [perm, `--allow-fs-read=${runner}`, runner] : [runner];
	const proc: ScriptProcess = { child: spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }), dir, sandboxed: !!perm, stderr: '' };
	proc.child.stderr?.on('data', (d) => (proc.stderr = (proc.stderr + d).slice(-2000)));
	return proc;
}

function endProcess(proc: ScriptProcess): void {
	clearTimeout(proc.idle);
	proc.child.kill();
	fs.rmSync(proc.dir, { recursive: true, force: true });
	for (const [key, value] of kept) if (value === proc) kept.delete(key);
}

/** Forget a chat's kept REPL (its `state` is gone). */
export function resetScriptSession(key: string): boolean {
	const proc = kept.get(key);
	if (proc) endProcess(proc);
	return !!proc;
}

export async function runScript(
	code: string,
	call: (name: string, args: Record<string, unknown>) => Promise<ScriptValue>,
	opts: { timeoutMs: number; maxCalls: number; signal?: AbortSignal; keep?: string; tools?: readonly string[] }
): Promise<ScriptResult> {
	let proc = opts.keep ? kept.get(opts.keep) : undefined;
	if (proc && proc.child.exitCode !== null) { endProcess(proc); proc = undefined; }
	if (!proc) {
		proc = startProcess();
		if (opts.keep) kept.set(opts.keep, proc);
	}
	clearTimeout(proc.idle);
	const { child } = proc;
	let calls = 0;
	const available = (opts.tools ?? SCRIPT_TOOLS).filter(name => SCRIPT_TOOLS.includes(name));
	return await new Promise<ScriptResult>((resolve) => {
		let finished = false;
		const finish = (r: Omit<ScriptResult, 'calls' | 'sandboxed'>, reusable: boolean) => {
			if (finished) {
				return;
			}
			finished = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener('abort', onAbort);
			child.removeListener('message', onMessage);
			child.removeListener('exit', onExit);
			child.removeListener('error', onError);
			// A kept REPL survives a finished run; a timeout, a stop or a crash ends it.
			if (opts.keep && reusable) proc!.idle = setTimeout(() => endProcess(proc!), KEEP_IDLE_MS);
			else endProcess(proc!);
			resolve({ ...r, calls, sandboxed: proc!.sandboxed });
		};
		const onAbort = () => finish({ output: '', error: 'Stopped.', timedOut: false }, false);
		const timer = setTimeout(() => finish({ output: '', error: `Timed out after ${opts.timeoutMs / 1000}s.`, timedOut: true }, false), opts.timeoutMs);
		opts.signal?.addEventListener('abort', onAbort, { once: true });
		const onMessage = async (m: any) => {
			if (m.type === 'call') {
				let reply: { text?: string; data?: unknown; kind?: string; error?: string };
				if (++calls > opts.maxCalls) {
					reply = { error: `Too many tool calls (limit ${opts.maxCalls}).` };
				} else if (!available.includes(m.name)) {
					reply = { error: `tools.${m.name} is not available in scripts. Available: ${available.join(', ')}` };
				} else {
					try {
						reply = await call(m.name, m.args && typeof m.args === 'object' ? m.args : {});
					} catch (e) {
						reply = { error: e instanceof Error ? e.message : String(e) };
					}
				}
				if (!finished) {
					child.send({ type: 'result', id: m.id, ...reply });
				}
			} else if (m.type === 'done') {
				finish({ output: String(m.output ?? ''), value: m.value, error: m.error, timedOut: false }, true);
			}
		};
		const onExit = (code: number | null) => finish({ output: '', error: `The script process exited (code ${code}).${proc!.stderr ? ' ' + proc!.stderr.trim().split('\n').slice(-2).join(' ') : ''}`, timedOut: false }, false);
		const onError = (e: Error) => finish({ output: '', error: e.message, timedOut: false }, false);
		child.on('message', onMessage);
		child.on('exit', onExit);
		child.on('error', onError);
		child.send({ type: 'run', code });
	});
}
