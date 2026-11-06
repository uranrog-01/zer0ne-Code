import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { StringDecoder } from 'string_decoder';
import { workspaceRoot } from '../tools/agentTools';
import type { HostContext, HostFeature, HostSurface } from './context';

interface Session { id: string; name: string; child: ChildProcessWithoutNullStreams; output: string; sequence: number; closed: boolean; closing: boolean; done: Promise<void>; }
export class InteractiveTerminalHost implements HostFeature {
	private readonly sessions = new Map<string, Session>();
	private opening = 0;
	private disposed = false;
	private readonly compilation = new AbortController();
	constructor(private readonly ctx: HostContext, private readonly source: string, private readonly storage: string) {}
	private async helper(): Promise<string> {
		if (process.platform !== 'win32') throw new Error('Interactive terminals currently require Windows. Use the command pane on this platform.');
		const digest = createHash('sha256').update(fs.readFileSync(this.source)).digest('hex').slice(0, 20);
		const dir = path.join(this.storage, 'terminal'), target = path.join(dir, 'conpty-' + digest + '.exe');
		if (fs.existsSync(target)) return target;
		const csc = ['Framework64','Framework'].map(f => path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(f => fs.existsSync(f));
		if (!csc) throw new Error('The Windows .NET Framework compiler is required for interactive terminals.');
		fs.mkdirSync(dir, { recursive: true });
		const temp = path.join(dir, randomUUID() + '.exe');
		try {
			await new Promise<void>((resolve, reject) => execFile(csc, ['/nologo','/optimize', '/out:' + temp, this.source], { windowsHide: true, timeout: 60_000, signal:this.compilation.signal }, error => error ? reject(new Error('Could not prepare interactive terminal: ' + error.message)) : resolve()));
			try { fs.renameSync(temp, target); } catch (error) { if (!fs.existsSync(target)) throw error; }
		} finally { fs.rmSync(temp, { force: true }); }
		return target;
	}
	private state(surface?: HostSurface): void {
		const message = { type:'ptySessions', sessions: [...this.sessions.values()].map(s => ({ id:s.id, name:s.name, output:s.output, sequence:s.sequence, closed:s.closed, closing:s.closing })) };
		if (surface) surface.post(message); else this.ctx.postAll(message);
		this.ctx.postAll({ type:'ptyActivity', running: this.opening > 0 || [...this.sessions.values()].some(s => !s.closed) });
	}
	async handle(surface: HostSurface, msg: { type: string; [key: string]: unknown }): Promise<boolean> {
		if (!msg.type.startsWith('pty')) return false;
		if (msg.type === 'ptyList') { this.state(surface); return true; }
		if (surface.kind === 'remote') throw new Error('Interactive terminal input and session controls are desktop-only.');
		if (msg.type === 'ptyOpen') {
			if (this.disposed || this.sessions.size + this.opening >= 6) throw new Error('Close a terminal before opening another (maximum six).');
			const root = workspaceRoot();
			if (!root || root.scheme !== 'file') throw new Error('Open a local project first.');
			this.opening++; this.state();
			try {
				const helper = await this.helper();
				if (this.disposed) throw new Error('The project is closing.');
				const child = spawn(helper, [root.fsPath, '100', '28'], { cwd:root.fsPath, windowsHide:true, stdio:'pipe', env:{ ...process.env, TERM:'xterm-256color' } });
				let finish!: () => void;
				const session: Session = { id:randomUUID(), name:'Terminal ' + (this.sessions.size + 1), child, output:'', sequence:0, closed:false, closing:false, done:new Promise(resolve => { finish = resolve; }) };
				this.sessions.set(session.id, session);
				const decoder = new StringDecoder('utf8');
				let shellExit: number | undefined;
				const append = (text: string) => {
					if (!text || this.disposed) return;
					session.output = (session.output + text).slice(-256 * 1024);
					this.ctx.postAll({ type:'ptyOutput', id:session.id, sequence:++session.sequence, text });
				};
				const lines = createInterface({ input:child.stdout });
				lines.on('line', line => { if (line.startsWith('D ')) append(decoder.write(Buffer.from(line.slice(2), 'base64'))); else if (/^E \d+$/.test(line)) shellExit = Number(line.slice(2)); });
				child.stderr.on('data', data => append('\r\n' + data.toString('utf8')));
				child.stdin.on('error', error => { if (!session.closed && !session.closing) append('\r\nTerminal input closed: ' + error.message); });
				child.once('error', error => append('\r\n' + error.message));
				child.once('close', code => { append(decoder.end() + '\r\n[Terminal closed: ' + (shellExit ?? code) + ']\r\n'); session.closed = true; this.state(); finish(); });
				this.state();
			} finally { this.opening--; this.state(); }
			return true;
		}
		const session = this.sessions.get(String(msg.id));
		if (!session) throw new Error('Choose an existing terminal.');
		if (msg.type === 'ptyClose') {
			await this.close(session); this.sessions.delete(session.id); this.state(); return true;
		}
		if (session.closed || session.closing) throw new Error('This terminal is closing or has closed.');
		if (msg.type === 'ptyInput') {
			const input = String(msg.text ?? '');
			if (input.length > 32768 || session.child.stdin.writableLength > 256 * 1024) throw new Error('Terminal input is too large or the terminal is busy.');
			session.child.stdin.write('I ' + Buffer.from(input).toString('base64') + '\n'); return true;
		}
		if (msg.type === 'ptyResize') {
			const cols = Number(msg.cols), rows = Number(msg.rows);
			if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 10 || cols > 400 || rows < 2 || rows > 200) throw new Error('Invalid terminal dimensions.');
			session.child.stdin.write(`R ${cols} ${rows}\n`); return true;
		}
		return false;
	}
	private async close(session: Session): Promise<void> {
		if (session.closed) return;
		if (session.closing) { await session.done; return; }
		session.closing = true; this.state();
		session.child.stdin.end('C\n');
		const timer = setTimeout(() => session.child.kill(), 2500); timer.unref();
		try { await session.done; } finally { clearTimeout(timer); }
	}
	async stop(): Promise<void> { this.disposed = true; this.compilation.abort(); await Promise.all([...this.sessions.values()].map(session => this.close(session))); }
	dispose(): void { void this.stop(); }
}
