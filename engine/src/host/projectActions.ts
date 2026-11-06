import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { workspaceRoot } from '../tools/agentTools';
import { beginExecution } from '../core/executionJournal';
import { shellSpec, TerminalTextDecoder } from './terminalHost';
import type { HostContext, HostFeature, HostSurface } from './context';

export interface ProjectAction { name: string; command: string; cwd?: string; previewUrl?: string; prepareWorktree?: boolean; }
export function parseProjectActions(raw: unknown): ProjectAction[] {
	if (!Array.isArray(raw) || raw.length > 20) throw new Error('Provide an array of at most 20 project actions.');
	const names = new Set<string>();
	return raw.map(value => {
		if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 60 || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 4000) throw new Error('Each action needs a name (1–60 characters) and command (1–4000 characters).');
		const name = value.name.trim(); if (names.has(name)) throw new Error('Action names must be unique.'); names.add(name);
		const cwd = typeof value.cwd === 'string' ? value.cwd : '.';
		if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..') || cwd.includes('\0')) throw new Error('Action directories must stay inside the project.');
		let previewUrl: string | undefined;
		if (value.previewUrl) { const url = new URL(value.previewUrl); if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Preview URLs must use HTTP or HTTPS without credentials.'); previewUrl = url.href; }
		return { name, command:value.command.trim(), cwd, previewUrl, prepareWorktree:value.prepareWorktree === true };
	});
}

export class ProjectActionsHost implements HostFeature {
	private child?: ChildProcess;
	private disposed = false;
	private last: Record<string, unknown> = {};
	private preparations: Promise<void> = Promise.resolve();
	private done?: Promise<void>;
	private stopping = false;
	private output = '';
	constructor(private readonly ctx: HostContext, private readonly storage: string) {}
	private async confirm(title: string, detail: string, accept: string): Promise<boolean> {
		const choice = await vscode.window.showQuickPick([{ label:accept, detail }, { label:'Cancel' }], { title, placeHolder:'Review the command and directory before continuing.' });
		return choice?.label === accept;
	}
	private root(): string { const root = workspaceRoot(); if (!root || root.scheme !== 'file') throw new Error('Open a local project first.'); return fs.realpathSync(root.fsPath); }
	private file(): string { return path.join(this.storage, 'project-actions', createHash('sha256').update(this.root().toLowerCase()).digest('hex') + '.json'); }
	private actions(): ProjectAction[] { try { return parseProjectActions(JSON.parse(fs.readFileSync(this.file(), 'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; } }
	private view(surface?: HostSurface): void { const message = { type:'projectActions', actions:this.actions(), running:!!this.child, last:this.last, output:this.output }; if (surface) surface.post(message); else this.ctx.postAll(message); }
	async handle(surface: HostSurface, msg: { type:string; [key:string]:unknown }): Promise<boolean> {
		if (!msg.type.startsWith('projectAction')) return false;
		if (msg.type === 'projectActionsList') { if (workspaceRoot()) this.view(surface); else surface.post({ type:'projectActions', actions:[], running:false, last:{} }); return true; }
		if (surface.kind === 'remote') throw new Error('Project action configuration and execution are desktop-only.');
		if (msg.type === 'projectActionsImport' || msg.type === 'projectActionsSave') {
			let raw: unknown;
			if (msg.type === 'projectActionsImport') {
				const file = path.join(this.root(), 'zer0ne.actions.json');
				if (fs.statSync(file).size > 128 * 1024) throw new Error('Project actions file is too large.');
				raw = JSON.parse(fs.readFileSync(file, 'utf8'));
			} else { const text = String(msg.json ?? ''); if (text.length > 128 * 1024) throw new Error('Project actions are too large.'); raw = JSON.parse(text); }
			const actions = parseProjectActions(raw);
			const detail = actions.map(a => `${a.name}: ${a.command}\nDirectory: ${a.cwd}${a.prepareWorktree ? '\nRun before NEW worktree tasks (each run still asks permission)' : ''}${a.previewUrl ? '\nPreview: ' + a.previewUrl : ''}`).join('\n\n');
			if (!await this.confirm('Save project actions', 'Commands run only when requested or when preparing a new worktree.\n\n' + detail, 'Save actions')) return true;
			const file = this.file(); fs.mkdirSync(path.dirname(file), { recursive:true });
			const temp = file + '.' + randomUUID() + '.tmp';
			try { fs.writeFileSync(temp, JSON.stringify(actions, null, 2)); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force:true }); }
			this.view(); return true;
		}
		if (msg.type === 'projectActionStop') { this.kill(); return true; }
		if (msg.type === 'projectActionPreview') {
			const action = this.actions().find(a => a.name === msg.name);
			if (!action?.previewUrl) throw new Error('This action has no preview URL.');
			await vscode.env.openExternal(vscode.Uri.parse(action.previewUrl)); return true;
		}
		if (msg.type === 'projectActionRun') {
			const action = this.actions().find(a => a.name === msg.name); if (!action) throw new Error('Choose a saved project action.');
			await this.run(action, this.root()); return true;
		}
		return false;
	}
	async prepare(directory: string, signal?: AbortSignal): Promise<void> {
		const queued = this.preparations.catch(() => undefined).then(async () => { for (const action of this.actions().filter(a => a.prepareWorktree)) { signal?.throwIfAborted(); await this.run(action, directory, signal); } });
		this.preparations = queued; await queued;
	}
	private async run(action: ProjectAction, root: string, signal?: AbortSignal): Promise<void> {
		if (this.disposed || this.child) throw new Error('Wait for the current project action to stop.');
		const realRoot = fs.realpathSync(root), cwd = fs.realpathSync(path.resolve(root, action.cwd || '.'));
		const relative = path.relative(realRoot, cwd);
		if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Action directory resolves outside the project.');
		if (!await this.confirm(`Run ${action.name}?`, `${action.command}\n\nIn: ${cwd}\nRuns with your account's permissions.`, 'Run action')) throw new Error('Project action was not approved.');
		signal?.throwIfAborted();
		if (this.disposed || this.child) throw new Error('The project closed or another action started.');
		if (fs.realpathSync(realRoot) !== realRoot || fs.realpathSync(cwd) !== cwd) throw new Error('The action directory changed after review. Run it again to review its current location.');
		const taskId = randomUUID();
		const journal = beginExecution(this.storage, { sessionId:'project-actions', taskId, callId:taskId, tool:'project_action' }, JSON.stringify(action));
		journal.approval(true, false);
		const spec = shellSpec(), child = spawn(spec.file, spec.args(action.command), { cwd, windowsHide:true, windowsVerbatimArguments:process.platform === 'win32', detached:process.platform !== 'win32', stdio:['ignore','pipe','pipe'] });
		let settle!: () => void; this.done = new Promise(resolve => { settle = resolve; }); this.stopping = false;
		this.child = child; this.output = ''; this.last = { name:action.name, status:'running', at:Date.now() };
		const abort = () => this.kill(); signal?.addEventListener('abort', abort, { once:true });
		const exited = new Promise<void>((resolve, reject) => {
				let sent = 0, failure: Error | undefined;
				for (const pipe of [child.stdout, child.stderr]) {
					const decoder = new TerminalTextDecoder();
					pipe?.on('data', data => { const text = decoder.write(data).slice(0, Math.max(0, 256 * 1024 - sent)); sent += text.length; if (text) { this.output += text; try { this.ctx.postAll({ type:'projectActionOutput', name:action.name, taskId, text }); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); this.kill(); } } });
				}
				child.once('error', error => { failure = error; });
				child.once('close', code => { if (failure || code !== 0 || signal?.aborted || this.stopping) reject(failure ?? new Error('Project action exited with code ' + code)); else resolve(); });
			});
		// Child lifecycle listeners must exist before configuration reads or UI publication can throw.
		void exited.catch(() => undefined);
		try {
			this.view(); this.ctx.postAll({ type:'projectActionActivity', running:true });
			await exited;
			journal.finish('completed'); this.last = { name:action.name, status:'completed', at:Date.now(), taskId };
		} catch (error) { const stopped = this.stopping || signal?.aborted; this.kill(); await exited.catch(() => undefined); journal.finish('failed'); this.last = { name:action.name, status:stopped ? 'stopped' : 'failed', at:Date.now(), taskId }; throw error; }
		finally { signal?.removeEventListener('abort', abort); this.child = undefined; try { this.view(); } finally { try { this.ctx.postAll({ type:'projectActionActivity', running:false }); } finally { settle(); } } }
	}
	private kill(): void {
		const child = this.child; if (!child || child.exitCode !== null || child.signalCode !== null) return;
		this.stopping = true;
		if (process.platform === 'win32' && child.pid) { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' }); killer.on('error', () => child.kill()); }
		else { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
	}
	async stop(): Promise<void> { this.disposed = true; this.kill(); await this.done; }
	dispose(): void { void this.stop(); }
}
