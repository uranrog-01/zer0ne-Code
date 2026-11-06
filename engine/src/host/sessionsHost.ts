import { listForeignSessions, loadForeignSession } from '../foreignSessions';
import { StoredMessage, newId, normalizeProjectPath, projectPathKey, type Session } from '../providerStore';
import { workspaceRoot } from '../tools/agentTools';
import { HostContext, HostFeature, HostSurface } from './context';

/** The controller state the chat list needs. */
export interface SessionsDeps {
	/** A turn is running (no branching or importing mid-turn). */
	busy(): boolean;
	currentId(): string;
	/** Persist the open chat before another one becomes current. */
	saveCurrent(): Promise<void>;
	/** Show the (new) current chat with an empty composer. */
	openCurrent(): Promise<void>;
	createWorktree(task: string): Promise<string>;
	/** Roll back a checkout whose branch could not be created. */
	removeWorktree?(path: string): Promise<void>;
	openSession(id: string): Promise<void>;
	/** Reload the current chat after the list changed under it. */
	loadCurrent(): Promise<void>;
	newChat(): Promise<void>;
	switchSession(id: string): Promise<void>;
	cancelRun(): void;
	/** Checkpoints, transcript and picture archive of a deleted chat. */
	removeData(id: string): void;
}

/**
 * The chat list: new / switch / delete / rename, folders, search, "Branch in
 * new chat", and continuing a Claude Code or Codex chat. Split out of
 * ChatController.
 */
export class SessionsHost implements HostFeature {
	private branching = false;
	constructor(
		private readonly ctx: HostContext,
		private readonly d: SessionsDeps
	) {}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		const store = this.ctx.store;
		switch (msg.type) {
			case 'newSession':
				await this.d.newChat();
				return true;
			case 'switchSession':
				if (typeof msg.id === 'string') {
					// ProjectsHost normally handles this first. Fail closed if it is absent or reordered.
					const session = await store.getSession(msg.id);
					const folder = normalizeProjectPath(session?.projectPath);
					const uri = workspaceRoot();
					const root = uri?.scheme === 'file' ? normalizeProjectPath(uri.fsPath) : undefined;
					if (!session) this.ctx.status('That chat no longer exists.', 'error');
					else if (folder && (!root || projectPathKey(folder) !== projectPathKey(root))) {
						this.ctx.status('Open this chat in its project window from the project sidebar.', 'error');
					} else if (msg.id !== this.d.currentId()) await this.d.switchSession(msg.id);
				}
				return true;
			case 'deleteSession':
				if (typeof msg.id === 'string') {
					if (msg.id === this.d.currentId()) {
						this.d.cancelRun();
					}
					await store.deleteSession(msg.id);
					this.d.removeData(msg.id);
					await this.d.loadCurrent();
				}
				return true;
			case 'updateSession':
				await store.updateSession(String(msg.id), msg.patch ?? {});
				await this.ctx.sendState();
				return true;
			case 'updateSessions': {
				// Apply one management action in sequence; parallel writes can lose changes.
				if (!Array.isArray(msg.ids) || !msg.patch || typeof msg.patch !== 'object') return true;
				const patch: { folderId?: string | null; archived?: boolean; pinned?: boolean } = {};
				if (typeof msg.patch.archived === 'boolean') patch.archived = msg.patch.archived;
				if (typeof msg.patch.pinned === 'boolean') patch.pinned = msg.patch.pinned;
				if (msg.patch.folderId === null || (typeof msg.patch.folderId === 'string' && store.getFolders().some((f) => f.id === msg.patch.folderId))) patch.folderId = msg.patch.folderId;
				if (!Object.keys(patch).length) return true;
				const known = new Set((await store.listSessions()).map((s) => s.id));
				const ids = [...new Set(msg.ids.filter((id: unknown): id is string => typeof id === 'string' && known.has(id)))];
				for (const id of ids) await store.updateSession(id, patch);
				await this.ctx.sendState();
				return true;
			}
			case 'saveFolder': {
				const folder = await store.saveFolder({ id: msg.id, name: String(msg.name ?? ''), color: msg.color });
				if (typeof msg.moveSession === 'string') {
					await store.updateSession(msg.moveSession, { folderId: folder.id });
				}
				await this.ctx.sendState();
				return true;
			}
			case 'deleteFolder':
				await store.deleteFolder(String(msg.id));
				await this.ctx.sendState();
				return true;
			case 'searchChats':
				surface.post({ type: 'chatSearch', query: String(msg.query ?? ''), hits: await store.searchSessions(String(msg.query ?? '')) });
				return true;
			case 'toggleChapter': {
				if (this.d.busy() || msg.sessionId !== this.d.currentId() || typeof msg.id !== 'string') return true;
				await this.d.saveCurrent();
				await store.toggleChapter(this.d.currentId(), msg.id);
				await this.ctx.sendState();
				return true;
			}
			case 'branchChat': {
				if (this.branching || this.d.busy() || typeof msg.id !== 'string' || (msg.sessionId && msg.sessionId !== this.d.currentId())) {
					return true;
				}
				if (msg.destination !== undefined && msg.destination !== 'workspace' && msg.destination !== 'worktree') return true;
				if (msg.destination === 'worktree' && surface.kind === 'remote') throw new Error('Branching into a worktree is available on desktop.');
				this.branching = true;
				const sourceId = this.d.currentId();
				try {
					await this.d.saveCurrent();
					if (msg.destination === 'worktree') {
						const source = await store.getSession(sourceId);
						if (!source?.messages.some(m => m.id === msg.id)) return true;
						const projectPath = await this.d.createWorktree(source.title);
						// A failed branch must not leave an empty checkout (and its branch) behind.
						let branched: Session | undefined;
						try {
							// A chat for another project must never become current in the source engine.
							branched = await store.branchSession(sourceId, msg.id, { projectPath, activate: false });
							if (!branched) throw new Error('The chat changed before the branch could be created.');
							await this.d.openSession(branched.id);
						} catch (error) {
							if (!branched) await this.d.removeWorktree?.(projectPath).catch(() => undefined);
							throw error;
						}
						await this.ctx.sendState();
					} else if (await store.branchSession(sourceId, msg.id)) {
						await this.d.openCurrent();
					}
				} finally {
					this.branching = false;
				}
				return true;
			}
			case 'forkSession': {
				// "Fork session" from a chat list: copy that whole chat into a new one and open it.
				if (this.d.busy() || typeof msg.id !== 'string') {
					return true;
				}
				await this.d.saveCurrent();
				if (await store.forkSession(msg.id)) {
					await this.d.openCurrent();
				}
				return true;
			}
			case 'foreignList':
				// Chats of Claude Code and Codex on this machine (this project's first).
				try {
					surface.post({ type: 'foreignSessions', items: listForeignSessions(workspaceRoot()?.fsPath, 40) });
				} catch (e) {
					surface.post({ type: 'foreignSessions', items: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			case 'foreignImport':
				await this.importForeign(msg.source, msg.path);
				return true;
		}
		return false;
	}

	private async importForeign(source: unknown, file: unknown): Promise<void> {
		if (this.d.busy() || typeof file !== 'string' || (source !== 'claude' && source !== 'codex')) {
			return;
		}
		// Only files the list offered: a path under ~/.claude/projects or ~/.codex/sessions.
		const known = listForeignSessions(undefined, 400).find((s) => s.path === file && s.source === source);
		if (!known) {
			this.ctx.status('That chat was not found any more.', 'error');
			return;
		}
		const imported = loadForeignSession(known);
		const label = known.source === 'claude' ? 'Claude Code' : 'Codex';
		const messages: StoredMessage[] = imported.map((m) =>
			m.tool
				? { id: newId('m'), role: 'assistant', content: '', kind: 'tool', tool: { ...m.tool, status: m.tool.summary === 'error' ? 'error' : 'done' } }
				: { id: newId('m'), role: m.role, content: m.content }
		);
		if (!messages.length) {
			this.ctx.status('That chat has no messages to import.', 'error');
			return;
		}
		messages.push({ id: newId('m'), role: 'assistant', content: `Imported from ${label} (${imported.filter((m) => m.role === 'user' && !m.tool).length} prompts, ${imported.filter((m) => m.tool).length} tool calls). Continue here — the model sees this conversation with tool outputs shortened.`, compacted: true });
		await this.d.saveCurrent();
		await this.ctx.store.importSession(`${known.title} · ${label}`, messages, known.cwd || '');
		await this.d.openCurrent();
	}
}
