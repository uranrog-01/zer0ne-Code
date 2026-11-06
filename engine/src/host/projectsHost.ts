import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizeProjectPath, projectPathKey, type SessionMeta } from '../providerStore';
import { type HostContext, type HostFeature, type HostSurface } from './context';

export const PROJECTS_KEY = 'aiChat.projects';
/** One memento entry per normalized folder avoids overwriting another folder's handoff. */
export const PROJECT_HANDOFF_PREFIX = 'aiChat.projectHandoff.';
export const UNASSIGNED_PROJECT_ID = 'unassigned';

export interface ProjectsDeps {
	/** The controller's window-local current chat, not the global store's current chat. */
	currentId(): string;
	switchSession(id: string): Promise<void>;
	newChat(): Promise<void>;
}

export interface ProjectEntry {
	id: string;
	/** Empty only for the explicit legacy/unassigned group; never a pretend root. */
	path: string;
	name: string;
	current: boolean;
	available: boolean;
	chats: SessionMeta[];
}

interface ProjectHandoff {
	kind: 'session' | 'create';
	sessionId?: string;
}

function firstRoot(): string | undefined {
	const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
	return uri?.scheme === 'file' ? normalizeProjectPath(uri.fsPath) : undefined;
}

async function directoryAvailable(folder: string): Promise<boolean> {
	try { return (await fs.promises.stat(folder)).isDirectory(); } catch { return false; }
}

/** Actual local workspace roots and recorded chat roots, never git/user-created chat folders. */
export class ProjectsHost implements HostFeature {
	private actions: Promise<void> = Promise.resolve();

	constructor(
		private readonly ctx: HostContext,
		private readonly globalState: vscode.Memento,
		private readonly d: ProjectsDeps
	) {}

	async getProjects(): Promise<{ type: 'projects'; projects: ProjectEntry[]; currentProjectId: string | null; currentSessionId: string }> {
		const sessions = await this.ctx.store.listSessions();
		const root = firstRoot();
		const currentProjectId = root ? projectPathKey(root) : null;
		const projects = new Map<string, ProjectEntry>();
		const add = (raw: unknown, name?: string): ProjectEntry | undefined => {
			const folder = normalizeProjectPath(raw);
			if (!folder) return undefined;
			const id = projectPathKey(folder);
			let entry = projects.get(id);
			if (!entry) {
				entry = { id, path: folder, name: name || path.basename(folder) || folder, current: id === currentProjectId, available: false, chats: [] };
				projects.set(id, entry);
			}
			return entry;
		};
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme === 'file') add(folder.uri.fsPath, folder.name);
		}
		const recorded = this.globalState.get<unknown>(PROJECTS_KEY, []);
		if (Array.isArray(recorded)) for (const folder of recorded) add(folder);
		const unassigned: SessionMeta[] = [];
		for (const session of sessions) {
			const entry = add(session.projectPath);
			if (entry) entry.chats.push(session);
			else unassigned.push(session);
		}
		await Promise.all([...projects.values()].map(async (entry) => { entry.available = await directoryAvailable(entry.path); }));
		const entries = [...projects.values()];
		if (unassigned.length) entries.push({ id: UNASSIGNED_PROJECT_ID, path: '', name: 'Unassigned chats', current: false, available: true, chats: unassigned });
		return { type: 'projects', projects: entries, currentProjectId, currentSessionId: this.d.currentId() };
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'sessionSeen':
				if (msg.id === this.d.currentId() && typeof msg.completedAt === 'number') {
					await this.ctx.store.markSessionRead(this.d.currentId(), msg.completedAt);
					surface.post(await this.getProjects());
				}
				return true;
			case 'getProjects':
				surface.post(await this.getProjects());
				return true;
			case 'switchSession':
				// History/search/remote navigation uses the same routing as the project sidebar.
				await this.routeSession(msg.id);
				surface.post(await this.getProjects());
				return true;
			case 'ready':
				// Do not swallow ready: appearance/state/worktree initialization still belongs to the controller.
				if (surface.kind === 'chat') await this.handoff();
				surface.post(await this.getProjects());
				return false;
			case 'projectOpen':
			case 'projectPick':
			case 'projectNewChat':
				await this.serialize(async () => {
					try {
						if (msg.type === 'projectPick') await this.pick();
						else await this.open(msg.path, msg.sessionId, msg.type === 'projectNewChat');
					} catch (e) {
						this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
					}
					surface.post(await this.getProjects());
				});
				return true;
		}
		return false;
	}

	/** Route a generic chat selection using stored metadata, never a client-supplied root. */
	async routeSession(id: unknown): Promise<void> {
		await this.serialize(async () => {
			try {
				if (typeof id !== 'string' || !id) throw new Error('Choose an existing chat.');
				const session = await this.ctx.store.getSession(id);
				if (!session) throw new Error('That chat no longer exists.');
				await this.open(normalizeProjectPath(session.projectPath) ?? '', id, false);
			} catch (e) {
				this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
			}
		});
	}

	private serialize(action: () => Promise<void>): Promise<void> {
		const next = this.actions.then(action);
		this.actions = next.catch(() => undefined);
		return next;
	}

	private async open(raw: unknown, sessionId: unknown, create: boolean): Promise<void> {
		const folder = normalizeProjectPath(raw);
		if (raw !== '' && !folder) throw new Error('Choose a known absolute project folder.');
		const id = folder ? projectPathKey(folder) : UNASSIGNED_PROJECT_ID;
		const entry = (await this.getProjects()).projects.find((p) => p.id === id);
		if (!entry) throw new Error('That project is not in the project list.');
		if (sessionId !== undefined && (typeof sessionId !== 'string' || !entry.chats.some((s) => s.id === sessionId))) {
			throw new Error('That chat does not belong to this project.');
		}
		if (!folder) {
			if (create || typeof sessionId !== 'string') throw new Error('Unassigned chats have no project folder.');
			await this.switchIfNeeded(sessionId);
			return;
		}
		if (!entry.available) throw new Error(`Project folder is unavailable: ${entry.path}`);
		if (entry.current) {
			if (create) await this.d.newChat();
			else if (typeof sessionId === 'string') await this.switchIfNeeded(sessionId);
			return;
		}
		await this.openWindow(entry.path, create ? { kind: 'create' } : typeof sessionId === 'string' ? { kind: 'session', sessionId } : undefined);
	}

	private async switchIfNeeded(id: string): Promise<void> {
		if (id !== this.d.currentId()) await this.d.switchSession(id);
	}

	private async pick(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Open project in new window' });
		if (!picked?.length) return;
		const folder = picked[0].scheme === 'file' ? normalizeProjectPath(picked[0].fsPath) : undefined;
		if (!folder || !await directoryAvailable(folder)) throw new Error('Choose an available local project folder.');
		const raw = this.globalState.get<unknown>(PROJECTS_KEY, []);
		const recorded = Array.isArray(raw) ? raw.map(normalizeProjectPath).filter((p): p is string => !!p) : [];
		if (!recorded.some((p) => projectPathKey(p) === projectPathKey(folder))) {
			await this.globalState.update(PROJECTS_KEY, [...recorded, folder]);
		}
		await this.openWindow(folder);
	}

	private async openWindow(folder: string, handoff?: ProjectHandoff): Promise<void> {
		const key = PROJECT_HANDOFF_PREFIX + projectPathKey(folder);
		if (handoff) await this.globalState.update(key, handoff);
		try {
			// Keep the source window (and any run in it) alive.
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), true);
		} catch (e) {
			if (handoff) await this.globalState.update(key, undefined);
			throw e;
		}
	}

	/** Consume only the first local root's handoff, once, before callbacks can re-enter ready. */
	async handoff(): Promise<void> {
		await this.serialize(async () => {
			const root = firstRoot();
			if (!root) return;
			const key = PROJECT_HANDOFF_PREFIX + projectPathKey(root);
			const hit = this.globalState.get<ProjectHandoff>(key);
			if (!hit) return;
			await this.globalState.update(key, undefined);
			if (hit.kind === 'create') await this.d.newChat();
			else if (hit.kind === 'session' && typeof hit.sessionId === 'string') {
				const session = await this.ctx.store.getSession(hit.sessionId);
				const folder = normalizeProjectPath(session?.projectPath);
				if (folder && projectPathKey(folder) === projectPathKey(root)) await this.switchIfNeeded(hit.sessionId);
				else this.ctx.status('The requested chat is no longer in this project.', 'error');
			}
		});
	}
}
