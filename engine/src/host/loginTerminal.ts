import { spawn, execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const abortError = () => Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' });
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export function terminalLaunch(platform: NodeJS.Platform, wrapper: string, find: (name: string) => string | undefined): { command: string; args: string[] } {
	if (platform === 'darwin') return { command: '/usr/bin/osascript', args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(shellQuote(wrapper))}`, '-e', 'tell application "Terminal" to activate'] };
	for (const [name, args] of [
		['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--wait', '--']], ['konsole', ['--nofork', '-e']], ['xterm', ['-e']]
	] as Array<[string, string[]]>) {
		const command = find(name);
		if (command) return { command, args: [...args, wrapper] };
	}
	throw new Error('This provider needs an interactive sign-in terminal. Install xterm, GNOME Terminal or Konsole, then try again.');
}

const RUNNER = `const fs = require('fs'), { spawn, execFile } = require('child_process');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.unlinkSync(process.argv[2]);
const env = { ...process.env, ...config.overrides };
for (const key of config.unset) delete env[key];
const child = spawn(config.command, config.args, { cwd: config.cwd, env, stdio: 'inherit' });
let monitor;
let finished = false;
let stopping = false;
const stop = () => {
  if (stopping || finished || !child.pid) return;
  stopping = true;
  if (process.platform === 'win32') { execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide:true }, () => {}); return; }
  execFile('/bin/ps', ['-eo', 'pid=,ppid='], { timeout:2000, maxBuffer:1048576 }, (error, out) => {
    if (finished) return;
    const ids = new Set([child.pid]);
    const rows = String(out || '').trim().split(/\\n/).map(line => line.trim().split(/\\s+/).map(Number));
    for (let i = 0; i < 32; i++) { const before = ids.size; for (const [pid, parent] of rows) if (pid > 1 && ids.has(parent)) ids.add(pid); if (ids.size === before) break; }
    for (const pid of [...ids].reverse()) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  });
};
const finish = result => { if (finished) return; finished = true; clearInterval(monitor); try { fs.writeFileSync(config.result, JSON.stringify(result), { mode: 0o600 }); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
const cancelled = () => !fs.existsSync(config.dir) || fs.existsSync(config.cancel);
child.once('spawn', () => { try { fs.writeFileSync(config.pid, JSON.stringify({ runner: process.pid, child: child.pid }), { mode: 0o600 }); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (cancelled()) stop(); });
child.once('error', error => { finish({ code: null, error: error.message }); process.exitCode = 1; });
child.once('close', code => { finish({ code }); process.exitCode = code === 0 ? 0 : 1; });
process.once('SIGTERM', stop);
monitor = setInterval(() => { if (cancelled()) stop(); }, 100);
`;

/** Private, short-lived launch data contains only environment changes, never a dump of the app's inherited credentials. */
export function createLoginRunner(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-plan-login-'));
	fs.chmodSync(dir, 0o700);
	const runner = path.join(dir, 'runner.cjs'), config = path.join(dir, 'launch.json'), wrapper = path.join(dir, 'login.command');
	const result = path.join(dir, 'result.json'), pid = path.join(dir, 'pid.json'), cancel = path.join(dir, 'cancel.json');
	const overrides = Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && value !== process.env[key]));
	const unset = Object.keys(process.env).filter(key => env[key] === undefined);
	fs.writeFileSync(config, JSON.stringify({ command, args, cwd, overrides, unset, result, pid, dir, cancel }), { mode: 0o600 });
	fs.writeFileSync(runner, RUNNER, { mode: 0o600 });
	fs.writeFileSync(wrapper, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(runner)} ${shellQuote(config)}\n`, { mode: 0o700 });
	const cleanup = () => {
		if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('zc-plan-login-')) throw new Error('Invalid sign-in temporary folder.');
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	};
	return { dir, runner, config, wrapper, result, pid, cancel, cleanup };
}

function terminalOnPath(name: string): string | undefined {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		const file = path.join(dir, name);
		try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* try next */ }
	}
	return undefined;
}

async function unixLoginTerminal(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, signal?: AbortSignal): Promise<void> {
	const files = createLoginRunner(command, args, cwd, env);
	let launcher: ReturnType<typeof spawn> | undefined;
	let timer: NodeJS.Timeout | undefined;
	let poll: NodeJS.Timeout | undefined;
	const stop = () => {
		if (fs.existsSync(files.result)) return;
		try { fs.writeFileSync(files.cancel, 'cancelled', { mode: 0o600 }); } catch { /* temporary folder already closed */ }
		let running = false;
		try {
			const ids = JSON.parse(fs.readFileSync(files.pid, 'utf8'));
			if (Number.isInteger(ids.runner) && ids.runner > 1) { running = true; try { process.kill(ids.runner, 'SIGTERM'); } catch { /* already finished */ } }
		} catch { /* login has not started */ }
		if (!running && launcher?.pid) { try { process.kill(-launcher.pid, 'SIGTERM'); } catch { /* launcher exited or has no group */ } }
	};
	try {
		const spec = terminalLaunch(process.platform, files.wrapper, terminalOnPath);
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer); clearInterval(poll);
				signal?.removeEventListener('abort', cancel);
				if (error) reject(error); else resolve();
			};
			const cancel = () => { stop(); finish(abortError()); };
			const check = () => {
				try {
					const result = JSON.parse(fs.readFileSync(files.result, 'utf8'));
					finish(result.code === 0 ? undefined : new Error(result.error ? `Could not start the sign-in tool: ${result.error}` : `The sign-in terminal closed before login finished${result.code !== null ? ` (exit ${result.code})` : ''}.`));
				} catch { /* the foreground login has not finished */ }
			};
			launcher = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore', windowsHide: true });
			launcher.once('error', error => finish(new Error(`Could not open the sign-in terminal: ${error.message}`)));
			launcher.once('close', code => { check(); if (code !== 0 && code !== null) finish(new Error(`Could not open the sign-in terminal (exit ${code}).`)); });
			// macOS's launcher exits as soon as Terminal opens; only the foreground runner's completion means login finished.
			poll = setInterval(check, 100);
			timer = setTimeout(() => { stop(); finish(new Error('The sign-in was not finished in 10 minutes.')); }, 10 * 60_000);
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) cancel();
		});
	} finally { clearTimeout(timer); clearInterval(poll); files.cleanup(); }
}

export function loginTerminalSpec(command: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[]; verbatim?: boolean } {
	if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
		const quote = (value: string) => {
			if (/["%!?&|<>\r\n]/.test(value)) throw new Error('This sign-in command contains unsupported Windows shell characters.');
			return '"' + value + '"';
		};
		return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + [command, ...args].map(quote).join(' ') + '"'], verbatim: true };
	}
	if (platform === 'darwin') {
		const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
		const text = [command, ...args].map(shellQuote).join(' ');
		return { command: 'osascript', args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(text)}`, '-e', 'tell application "Terminal" to activate'] };
	}
	if (platform === 'linux') return { command: 'x-terminal-emulator', args: ['-e', command, ...args] };
	return { command, args };
}

/** Sign-in explicitly needs an interactive console; background engines never call this. */
export function openLoginTerminal(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortError());
	if (process.platform === 'darwin' || process.platform === 'linux') return unixLoginTerminal(command, args, cwd, env, signal);
	const spec = loginTerminalSpec(command, args);
	return new Promise((resolve, reject) => {
		const child = spawn(spec.command, spec.args, { cwd, env: env ?? process.env, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: spec.verbatim });
		const stop = () => {
			if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => undefined);
			else if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already closed */ } }
		};
		signal?.addEventListener('abort', stop, { once: true });
		child.once('error', error => { signal?.removeEventListener('abort', stop); reject(new Error(`Could not open the sign-in terminal: ${error.message}`)); });
		child.once('close', (code) => {
			signal?.removeEventListener('abort', stop);
			if (signal?.aborted) reject(abortError());
			else if (code === 0) resolve();
			else reject(new Error(`The sign-in terminal closed before login finished${code !== null ? ` (exit ${code})` : ''}.`));
		});
		child.once('spawn', () => { if (signal?.aborted) { stop(); reject(abortError()); } });
		child.unref();
	});
}
