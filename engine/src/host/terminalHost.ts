import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import * as vscode from 'vscode';
import type { HostContext, HostFeature, HostSurface } from './context';

/** Maximum retained UTF-16 units per command, shared by stdout and stderr. */
const MAX_OUTPUT = 256 * 1024;

/** Decode each pipe independently: UTF-8 and terminal controls can span arbitrary chunks.
 * Escape strings are discarded incrementally, never buffered (even an unterminated OSC). */
export class TerminalTextDecoder {
	private readonly utf8 = new StringDecoder('utf8');
	private state: 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'stringEscape' = 'text';
	write(chunk: Buffer): string { return this.clean(this.utf8.write(chunk)); }
	end(): string { return this.clean(this.utf8.end()); }
	clean(text: string): string {
		let out = '';
		for (const c of text) {
			if (this.state === 'string' || this.state === 'stringEscape') {
				if (c === '\x07' || c === '\u009c' || (this.state === 'stringEscape' && c === '\\')) this.state = 'text';
				else this.state = c === '\x1b' ? 'stringEscape' : 'string';
			} else if (c === '\x1b') this.state = 'escape';
			else if (this.state === 'escape') {
				if (c === '[') this.state = 'csi';
				else if (']PX^_'.includes(c)) this.state = 'string';
				else this.state = /[ -/]/.test(c) ? 'intermediate' : 'text';
			} else if (this.state === 'csi') {
				if (/[@-~]/.test(c)) this.state = 'text';
			} else if (this.state === 'intermediate') {
				if (/[0-~]/.test(c)) this.state = 'text';
			} else if (c === '\u009b') this.state = 'csi';
			else if ('\u0090\u009d\u009e\u009f'.includes(c)) this.state = 'string';
			else if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(c)) out += c;
		}
		return out;
	}
}

export function stripAnsi(s: string): string { return new TerminalTextDecoder().clean(s); }

/** cmd requires verbatim outer quotes; Node's normal quoting mangles embedded quotes. */
export function shellSpec(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { file: string; args: (cmd: string) => string[] } {
	if (platform === 'win32') return { file: env.ComSpec || 'cmd.exe', args: (cmd) => ['/d', '/s', '/c', '"' + cmd + '"'] };
	return { file: env.SHELL || '/bin/sh', args: (cmd) => ['-lc', cmd] };
}

/** Only intercept a single literal/variable directory argument. Compounds, substitutions,
 * globs and other shell syntax stay shell commands and cannot change the tracked cwd. */
export function parseCd(command: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
	const m = command.trim().match(/^cd(?:\s+\/d)?(?:\s+(.*))?$/i);
	if (!m) return null;
	const raw = (m[1] ?? '').trim();
	if (!raw || raw === '.') return '';
	const win = platform === 'win32';
	let quote = '', arg = '', tokens = 0, inToken = false;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (c === quote) { quote = ''; continue; }
		if (!quote && (c === '"' || (!win && c === "'"))) { quote = c; if (!inToken) tokens++; inToken = true; continue; }
		if (!quote && /[&|;<>\r\n]/.test(c)) return null;
		if (win && ((!quote && /[()^]/.test(c)) || c === '!')) return null;
		if (!win && quote !== "'" && (c === '`' || (c === '$' && raw[i + 1] === '('))) return null;
		if (!win && !quote && /[*?(){}]/.test(c) && !(c === '{' && raw[i - 1] === '$')) return null;
		if (!win && c === '\\' && quote !== "'") {
			const next = raw[i + 1];
			if (!next) return null;
			if (!quote || /[$`"\\]/.test(next)) { arg += next; i++; inToken = true; tokens ||= 1; continue; }
		}
		if (!win && c === '$' && quote !== "'") {
			const variable = raw.slice(i).match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/);
			if (!variable) return null;
			arg += env[variable[1] || variable[2]] ?? '';
			i += variable[0].length - 1;
		} else if (win && c === '%') {
			const variable = raw.slice(i).match(/^%([^%]+)%/);
			if (!variable) return null;
			const key = Object.keys(env).find((k) => k.toLowerCase() === variable[1].toLowerCase());
			arg += (key && env[key]) || variable[0];
			i += variable[0].length - 1;
		} else if (!quote && /\s/.test(c) && !win) { inToken = false; continue; }
		else {
			if (!win && !quote && c === '^') return null;
			arg += c;
		}
		if (!inToken) { tokens++; inToken = true; }
	}
	if (quote || (!win && tokens > 1) || !arg) return null;
	if (raw.startsWith('~') && /^~([\\/].*)?$/.test(arg)) arg = path.join(os.homedir(), arg.slice(1));
	return arg;
}

type Run = {
	id: number; child: ChildProcess; stopping: boolean; closed: boolean; killPending: boolean;
	timer?: ReturnType<typeof setTimeout>; finish: () => void;
	settled: Promise<void>;
};

/** A noninteractive command runner, not a PTY. Cwd persists per workspace (including no folder). */
export class TerminalHost implements HostFeature {
	private readonly cwds = new Map<string, string>();
	private running: Run | null = null;
	constructor(private readonly ctx: HostContext) {}
	dispose(): void { this.kill(); }
	/** Desktop shutdown must wait for the process tree, not just signal it. */
	async stop(): Promise<void> {
		const run = this.running;
		if (!run) return;
		this.kill();
		await run.settled;
	}
	private root(): string | undefined {
		const f = vscode.workspace.workspaceFolders?.[0];
		return f?.uri.scheme === 'file' ? f.uri.fsPath : undefined;
	}
	private dir(): string {
		const root = this.root() || '';
		const cwd = this.cwds.get(root);
		try { if (cwd && fs.statSync(cwd).isDirectory()) return cwd; } catch { /* deleted directory */ }
		const fallback = root || os.homedir();
		this.cwds.set(root, fallback);
		return fallback;
	}
	private info(surface: HostSurface): void {
		surface.post({ type: 'terminalInfo', cwd: this.dir(), shell: path.basename(shellSpec().file), running: !!this.running, stopping: !!this.running?.stopping, id: this.running?.id || 0 });
	}
	private kill(): void {
		const run = this.running;
		if (!run || run.stopping) return;
		run.stopping = true;
		if (process.platform === 'win32' && run.child.pid) {
			run.killPending = true;
			const killer = spawn('taskkill', ['/pid', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
			const finished = () => { run.killPending = false; run.finish(); };
			killer.once('error', () => { run.child.kill(); finished(); });
			killer.once('close', (code) => { if (code && !run.closed) run.child.kill(); finished(); });
		} else {
			const signal = (sig: NodeJS.Signals) => {
				try { if (run.child.pid) process.kill(-run.child.pid, sig); else run.child.kill(sig); }
				catch { try { run.child.kill(sig); } catch { /* already exited */ } }
			};
			signal('SIGTERM');
			// A command may ignore TERM, and descendants may still own the output pipes.
			run.timer = setTimeout(() => signal('SIGKILL'), 1500);
			run.timer.unref();
		}
	}
	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'terminalInfo':
			case 'terminalReset': this.info(surface); return true;
			case 'terminalRun': {
				const command = String(msg.command ?? '').trim();
				const id = Number(msg.id) || Date.now();
				if (!command) return true;
				if (this.running) {
					if (id !== this.running.id) {
						surface.post({ type: 'terminalChunk', id, text: 'A command is already running — wait for it to stop.\n' });
						surface.post({ type: 'terminalDone', id, code: -1, cwd: this.dir() });
					}
					this.info(surface);
					return true;
				}
				const cd = parseCd(command);
				if (cd !== null) {
					if (!cd) surface.post({ type: 'terminalChunk', id, text: this.dir() + '\n' });
					else {
						const next = path.resolve(this.dir(), cd);
						try {
							if (!fs.statSync(next).isDirectory()) throw new Error('not a directory');
							this.cwds.set(this.root() || '', next);
						} catch (e) {
							surface.post({ type: 'terminalChunk', id, stream: 'err', text: `cd: ${e instanceof Error ? e.message : String(e)}\n` });
							surface.post({ type: 'terminalDone', id, code: 1, cwd: this.dir() });
							return true;
						}
					}
					surface.post({ type: 'terminalDone', id, code: 0, cwd: this.dir() });
					return true;
				}
				const spec = shellSpec();
				const child = spawn(spec.file, spec.args(command), {
					cwd: this.dir(), env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
					windowsHide: true, windowsVerbatimArguments: process.platform === 'win32',
					detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
				});
				let sent = 0, noted = false, exitCode = -1, done = false;
				const send = (stream: 'out' | 'err', text: string) => {
					if (!text) return;
					let size = Math.min(text.length, MAX_OUTPUT - sent);
					if (size < text.length && size > 0 && /[\uD800-\uDBFF]/.test(text[size - 1])) size--;
					if (size) { surface.post({ type: 'terminalChunk', id, stream, text: text.slice(0, size) }); sent += size; }
					if (size < text.length && !noted) {
						noted = true;
						surface.post({ type: 'terminalChunk', id, text: '\n… output truncated.\n' });
					}
				};
				let settle!: () => void;
				const settled = new Promise<void>((resolve) => { settle = resolve; });
				const run: Run = { id, child, settled, stopping: false, closed: false, killPending: false, finish: () => {
					if (done || !run.closed || run.killPending) return;
					done = true;
					if (run.timer) clearTimeout(run.timer);
					if (this.running === run) this.running = null;
					if (run.stopping) this.ctx.status('Command stopped.', '');
					surface.post({ type: 'terminalDone', id, code: run.stopping ? 130 : exitCode, cwd: this.dir(), stopped: run.stopping });
					this.ctx.postAll({ type: 'terminalActivity', running: false });
					settle();
				} };
				this.running = run;
				// Retain the project until close and any process-tree stop have completed.
				this.ctx.postAll({ type: 'terminalActivity', running: true });
				for (const [pipe, stream] of [[child.stdout, 'out'], [child.stderr, 'err']] as const) {
					const decoder = new TerminalTextDecoder();
					pipe?.on('data', (buf: Buffer) => send(stream, decoder.write(buf)));
					pipe?.on('end', () => send(stream, decoder.end()));
				}
				child.on('error', (e) => send('err', e.message + '\n'));
				child.on('close', (code) => {
					// Descendants with redirected pipes can outlive the shell's close event.
					if (run.stopping && process.platform !== 'win32' && child.pid) {
						try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
					}
					run.closed = true; exitCode = code ?? -1; run.finish();
				});
				return true;
			}
			case 'terminalStop': {
				const run = this.running;
				if (!run || Number(msg.id) !== run.id) return true;
				this.kill();
				this.info(surface);
				return true;
			}
		}
		return false;
	}
}
