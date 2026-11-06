import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceRoot } from '../tools/agentTools';
import { createWorktree, isDirty, listWorktrees, pruneWorktrees, removeWorktree, type WorktreeInfo } from '../worktrees';
import { HostContext, HostFeature, HostSurface } from './context';

const WORKTREE_HANDOFF_KEY = 'aiChat.worktreeHandoff';

/**
 * Git worktrees you open yourself: "New task in a worktree" (new branch +
 * folder, opened in its own window, the task pre-filled there) and a picker
 * to open or remove them. Split out of ChatController. (The agent's own
 * parallel writers live in writers.ts.)
 */
export class WorktreesHost implements HostFeature {
	prepare?: (directory: string) => Promise<void>;
	/** A run or an agent is active; its checkout must not be removed under it. */
	busy?: () => boolean;
	constructor(
		private readonly ctx: HostContext,
		private readonly globalState: vscode.Memento
	) {}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'getWorktrees': {
				try {
					const root = this.localRoot();
					const current = this.pathKey(root.fsPath);
					const items = (await listWorktrees(root.fsPath)).map((w) => {
						const relative = path.relative(this.pathKey(w.path), current);
						return {
							path: w.path,
							branch: w.branch ?? '',
							head: w.head ?? '',
							main: w.main,
							locked: w.locked === true,
							current: relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
						};
					});
					surface.post({ type: 'worktrees', items });
				} catch (e) {
					surface.post({ type: 'worktrees', items: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'openWorktree': {
				const root = this.localRoot();
				if (typeof msg.path !== 'string' || !msg.path.trim() || !path.isAbsolute(msg.path)) {
					throw new Error('Choose a listed Git worktree to open.');
				}
				const key = this.pathKey(msg.path);
				const worktree = (await listWorktrees(root.fsPath)).find((w) => this.pathKey(w.path) === key);
				if (!worktree) {
					throw new Error('This path is not a worktree of the current repository. Refresh the worktree list and try again.');
				}
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), { forceNewWindow: true });
				return true;
			}
			case 'removeWorktree': {
				const root = this.localRoot();
				if (this.busy?.()) {
					throw new Error('Wait for the current run and its agents to finish before removing a worktree.');
				}
				if (typeof msg.path !== 'string' || !msg.path.trim() || !path.isAbsolute(msg.path)) {
					throw new Error('Choose a listed Git worktree to remove.');
				}
				const key = this.pathKey(msg.path);
				const worktree = (await listWorktrees(root.fsPath)).find((w) => this.pathKey(w.path) === key);
				if (!worktree) {
					throw new Error('This path is not a worktree of the current repository. Refresh the worktree list and try again.');
				}
				if (worktree.main) {
					throw new Error('The main checkout cannot be removed.');
				}
				if (worktree.locked) {
					throw new Error('This checkout is locked. Unlock it with Git before removing it.');
				}
				// A folder deleted outside Git cannot be inspected; forget its registration.
				if (!fs.existsSync(worktree.path)) {
					await pruneWorktrees(root.fsPath);
					this.ctx.status(`Removed the missing checkout${worktree.branch ? ` (branch ${worktree.branch} is kept)` : ''}.`);
					surface.post({ type: 'worktreeRemoved', path: worktree.path });
					return true;
				}
				const dirty = await isDirty(worktree.path);
				if (dirty) {
					const confirmed = await vscode.window.showWarningMessage(`${worktree.branch ?? worktree.path} has uncommitted changes. Remove it anyway? Those changes are lost.`, { modal: true }, 'Remove anyway');
					if (confirmed !== 'Remove anyway') {
						return true;
					}
				}
				await removeWorktree(root.fsPath, worktree.path, dirty);
				this.ctx.status(`Removed the worktree folder${worktree.branch ? ` (branch ${worktree.branch} is kept)` : ''}.`);
				surface.post({ type: 'worktreeRemoved', path: worktree.path });
				return true;
			}
			case 'worktree':
				if (msg.action === 'create' && !(typeof msg.task === 'string' && msg.task.trim())) {
					surface.post({ type: 'worktreeTaskEntry' });
					return true;
				}
				await this.action(String(msg.action), typeof msg.task === 'string' ? msg.task : undefined);
				return true;
			default:
				return false;
		}
	}

	private localRoot(): vscode.Uri {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			throw new Error('Open a local folder to use Git worktrees.');
		}
		return root;
	}

	private pathKey(value: string): string {
		const resolved = path.resolve(value);
		return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	}

	async create(task: string): Promise<WorktreeInfo> {
		const root = this.localRoot();
		const wt = await createWorktree(root.fsPath, task);
		await this.prepare?.(wt.path);
		return wt;
	}

	async action(action: string, task?: string): Promise<void> {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			throw new Error('Open a local folder to use Git worktrees.');
		}
		if (action === 'create') {
			const what = task?.trim();
			if (!what) {
				this.ctx.postAll({ type: 'worktreeTaskEntry' });
				return;
			}
			const wt = await this.create(what);
			const handoff = { ...this.globalState.get<Record<string, { task: string; branch: string }>>(WORKTREE_HANDOFF_KEY, {}) };
			handoff[this.pathKey(wt.path)] = { task: what.trim(), branch: wt.branch ?? '' };
			await this.globalState.update(WORKTREE_HANDOFF_KEY, handoff);
			this.ctx.status(`Created worktree ${wt.branch} — opening its project folder.`);
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.path), { forceNewWindow: true });
			return;
		}
		// manage: pick a worktree, then open or remove it
		const list = (await listWorktrees(root.fsPath)).filter((w) => !w.main);
		if (!list.length) {
			const pick = await vscode.window.showInformationMessage('No extra worktrees yet.', 'New task in a worktree…');
			if (pick) {
				await this.action('create');
			}
			return;
		}
		const chosen = await vscode.window.showQuickPick(
			list.map((w) => ({ label: w.branch ?? '(detached)', description: w.head, detail: w.path, w })),
			{ title: 'Git worktrees', placeHolder: 'Pick a worktree to open or remove' }
		);
		if (!chosen) {
			return;
		}
		const verb = await vscode.window.showQuickPick(['Open in a new window', 'Remove worktree folder (the branch is kept)'], { title: chosen.label });
		if (verb?.startsWith('Open')) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(chosen.w.path), { forceNewWindow: true });
		} else if (verb) {
			if (this.busy?.()) {
				throw new Error('Wait for the current run and its agents to finish before removing a worktree.');
			}
			if (chosen.w.locked) {
				throw new Error('This checkout is locked. Unlock it with Git before removing it.');
			}
			if (!fs.existsSync(chosen.w.path)) {
				await pruneWorktrees(root.fsPath);
				this.ctx.status(`Removed the missing checkout (branch ${chosen.label} is kept).`);
				return;
			}
			const dirty = await isDirty(chosen.w.path);
			if (dirty) {
				const ok = await vscode.window.showWarningMessage(`${chosen.label} has uncommitted changes. Remove it anyway? Those changes are lost.`, { modal: true }, 'Remove anyway');
				if (!ok) {
					return;
				}
			}
			await removeWorktree(root.fsPath, chosen.w.path, dirty);
			this.ctx.status(`Removed the worktree folder (branch ${chosen.label} is kept).`);
		}
	}

	/** In a window opened for a worktree task: pre-fill the task and say where we are. */
	async handoff(): Promise<void> {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			return;
		}
		const all = { ...this.globalState.get<Record<string, { task: string; branch: string }>>(WORKTREE_HANDOFF_KEY, {}) };
		const key = this.pathKey(root.fsPath);
		const hit = all[key];
		if (!hit) {
			return;
		}
		delete all[key];
		await this.globalState.update(WORKTREE_HANDOFF_KEY, all);
		this.ctx.postAll({ type: 'prefill', text: hit.task });
		this.ctx.status(`This window is a Git worktree on branch ${hit.branch}. Changes here don't touch your main folder.`);
	}
}
