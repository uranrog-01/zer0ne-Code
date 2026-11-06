import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { newId } from '../providerStore';
import { resolveInWorkspace, workspaceRoot } from '../tools/agentTools';
import { searchSymbols } from './mentions';
import { HostContext, HostFeature, HostSurface } from './context';

export type GitChange = { path: string; status: string; added?: number; removed?: number; staged?: boolean; originalPath?: string };

/**
 * The workspace around the chat: the @-mention file list, the Git tools card
 * (status with +/− counts, branches, checkout, HEAD ↔ working-tree diffs),
 * file previews and symbol search for the full-screen layers, the folder chip,
 * and opening files / links. Split out of ChatController.
 */
export class WorkspaceHost implements HostFeature {
	private files: string[] = [];
	private filesAt = 0;
	/** The change list from the last git status — tells untracked from tracked when a diff opens. */
	private gitLast: GitChange[] = [];

	constructor(
		private readonly ctx: HostContext,
		/** Original contents served to the diff editor (zer0ne-orig: scheme). */
		private readonly originals: Map<string, string>,
		subscriptions: { push(d: vscode.Disposable): unknown } | undefined
	) {
		// @-mention file list: warm it once, drop it only when files appear or disappear.
		const watcher = vscode.workspace.createFileSystemWatcher?.('**/*', false, true, false);
		if (watcher) {
			const stale = () => (this.filesAt = 0);
			watcher.onDidCreate(stale);
			watcher.onDidDelete(stale);
			subscriptions?.push(watcher);
		}
		setTimeout(() => void this.refreshFiles().catch(() => undefined), 3000).unref?.();
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'getFiles':
				surface.post({ type: 'files', files: await this.workspaceFiles((msg as { refresh?: boolean }).refresh === true) });
				return true;
			case 'getGitStatus':
				await this.sendGitStatus(surface);
				return true;
			case 'gitBranches':
				surface.post({ type: 'gitBranches', ...(await this.gitBranchList()) });
				return true;
			case 'gitCheckout': {
				const ok = await this.gitSwitchBranch(String(msg.name ?? ''), msg.create === true);
				this.ctx.status(ok ? (msg.create === true ? `Created and switched to ${String(msg.name)}` : `Switched to ${String(msg.name)}`) : `Could not switch to ${String(msg.name)} — commit or stash conflicting changes first.`, ok ? 'ok' : 'error');
				await this.sendGitStatus(surface);
				await this.ctx.sendState();
				return true;
			}
			case 'gitOpenDiff':
				if (msg.inPage === true) {
					await this.sendTextDiff(surface, String(msg.path ?? ''));
				} else {
					await this.gitOpenDiff(String(msg.path ?? ''));
				}
				return true;
			case 'workspaceAction': {
				// Folder chip under the chat box.
				const root = workspaceRoot();
				if (msg.action === 'open') {
					await vscode.commands.executeCommand('vscode.openFolder');
				} else if (msg.action === 'reveal' && root) {
					await vscode.commands.executeCommand('revealFileInOS', root);
				}
				return true;
			}
			case 'previewFile': {
				// Full screen → Files layer / Work Details: a read-only look at a workspace file.
				const raw = String(msg.path ?? '').trim();
				const m = raw.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/);
				const rel = m ? m[1] : raw;
				try {
					const root = workspaceRoot();
					let uri = resolveInWorkspace(rel);
					if (root?.scheme === 'file') {
						const base = fs.realpathSync(root.fsPath);
						const file = fs.realpathSync(uri.fsPath);
						const relative = path.relative(base, file);
						// Lexical containment alone permits junctions and sibling prefix matches.
						if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || (process.platform === 'win32' && relative.includes(':'))) {
							throw new Error('File previews must stay inside the workspace.');
						}
						uri = vscode.Uri.file(file);
					}
					const bytes = await vscode.workspace.fs.readFile(uri);
					const binary = bytes.subarray(0, 8000).includes(0);
					const lines = binary ? [] : new TextDecoder().decode(bytes).split(/\r?\n/);
					surface.post({ type: 'filePreview', sessionId: msg.sessionId, path: raw, content: lines.slice(0, 2000).join('\n'), lines: lines.length, size: bytes.length, binary, truncated: lines.length > 2000 });
				} catch (e) {
					surface.post({ type: 'filePreview', sessionId: msg.sessionId, path: raw, error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'getSymbols':
				surface.post({ type: 'symbols', query: String(msg.query ?? ''), items: await searchSymbols(String(msg.query ?? '')) });
				return true;
			case 'openExternal':
				if (typeof msg.url === 'string' && /^https?:\/\//i.test(msg.url)) {
					try {
						if (!await vscode.env.openExternal(vscode.Uri.parse(msg.url))) this.ctx.status('Could not open your browser. Copy the link and open it in your browser.', 'error');
					} catch { this.ctx.status('Could not open your browser. Copy the link and open it in your browser.', 'error'); }
				}
				return true;
			case 'openFile': {
				// Only workspace files. The path can come from the model (a markdown
				// link in its answer), so an absolute path or a file:// URL is
				// refused instead of being handed to the operating system.
				if (typeof msg.path !== 'string') return true;
				try {
					const raw = msg.path.trim();
					if (/^[a-zA-Z]:[\\/]/.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) {
						throw new Error('Only files inside the workspace can be opened here.');
					}
					const uri = resolveInWorkspace(raw);
					const line = Math.max(0, (Number(msg.line) || 1) - 1);
					await vscode.window.showTextDocument(uri, { selection: new vscode.Range(line, 0, line, 0), preview: true });
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
				}
				return true;
			}
			case 'openPath': {
				if (typeof msg.path !== 'string') return true;
				try {
					await vscode.window.showTextDocument(this.containedFile(msg.path), { preview: true });
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
				}
				return true;
			}
		}
		return false;
	}

	/**
	 * A file opened by absolute path (the Skills page). It must be a text file
	 * the app can show, and it must live where the user's own files are: inside
	 * the workspace or inside their home folder (skills live there too). The
	 * desktop app hands a file it cannot open in the editor to the system's
	 * default handler, so an executable must never get this far.
	 */
	private containedFile(p: string): vscode.Uri {
		const abs = path.resolve(p);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			throw new Error('That file no longer exists.');
		}
		if (!stat.isFile()) {
			throw new Error('That path is not a file.');
		}
		if (!this.inUserArea(abs)) {
			throw new Error('This path is outside the workspace and your home folder.');
		}
		const fd = fs.openSync(abs, 'r');
		try {
			const buf = Buffer.alloc(8000);
			const n = fs.readSync(fd, buf, 0, 8000, 0);
			if (buf.subarray(0, n).includes(0)) {
				throw new Error('That file is not a text file.');
			}
		} finally {
			fs.closeSync(fd);
		}
		return vscode.Uri.file(abs);
	}

	/** Inside the workspace, or inside the user's own home folder. */
	private inUserArea(abs: string): boolean {
		const real = (x: string) => {
			try {
				return fs.realpathSync(x);
			} catch {
				return x;
			}
		};
		const file = real(abs);
		return [workspaceRoot()?.fsPath, os.homedir()].filter((r): r is string => !!r).some(root => {
			const rel = path.relative(real(root), file);
			return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
		});
	}

	// ------------------------------------------------------------ @-mention file list

	/** Workspace-relative paths (kept fresh by a file watcher, not a timer). */
	async workspaceFiles(force = false): Promise<string[]> {
		await this.refreshFiles(force);
		return this.files;
	}

	private async refreshFiles(force = false): Promise<void> {
		const root = workspaceRoot();
		if (!root) {
			this.files = [];
			return;
		}
		if (!force && this.files.length && this.filesAt) {
			return;
		}
		const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), '**/{node_modules,.git,out,dist,build}/**', 3000);
		this.files = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort();
		this.filesAt = Date.now();
	}

	// ------------------------------------------------------------ git tools card

	private gitRun(args: string[]): Promise<string> {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			return Promise.reject(new Error('no file workspace'));
		}
		return new Promise((resolve, reject) =>
			execFile('git', args, { cwd: root.fsPath, windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15_000 }, (err, out, stderr) =>
				err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(out))
			)
		);
	}

	/** Working-tree status for the Git tools card: per-file and total +/− line counts. */
	private async gitChanges(): Promise<{ branch?: string; changes: GitChange[]; added: number; removed: number }> {
		// Status failure is not a clean tree. NUL records preserve spaces, quotes,
		// tabs, newlines and rename-looking text in literal filenames.
		const status = await this.gitRun(['status', '--porcelain=v1', '-z']);
		const numstat = await this.gitRun(['diff', 'HEAD', '--numstat', '-z']).catch(() => '');
		const stats = new Map<string, { added: number; removed: number }>();
		const numbers = numstat.split('\0');
		for (let i = 0; i < numbers.length; i++) {
			const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(numbers[i]);
			if (!m) continue;
			let rel = m[3];
			if (!rel) { i++; rel = numbers[++i]; } // rename: old path, then new path
			if (rel) stats.set(rel, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]) });
		}
		const changes: GitChange[] = [];
		let added = 0;
		let removed = 0;
		const records = status.split('\0');
		for (let i = 0; i < records.length; i++) {
			const line = records[i];
			if (!line) continue;
			const code = line.slice(0, 2);
			const rel = line.slice(3);
			const originalPath = /[RC]/.test(code) ? records[++i] : undefined; // destination before source
			const s = stats.get(rel);
			if (s) {
				added += s.added;
				removed += s.removed;
			}
			changes.push({
				path: rel,
				originalPath,
				status: code === '??' ? '?' : code[0] !== ' ' ? code[0] : code[1],
				staged: code !== '??' && code[0] !== ' ',
				added: s?.added,
				removed: s?.removed
			});
		}
		const branch = await this.gitRun(['rev-parse', '--abbrev-ref', 'HEAD']).then((b) => b.trim()).catch(() => undefined);
		return { branch, changes, added, removed };
	}

	private async sendGitStatus(surface: HostSurface): Promise<void> {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			surface.post({ type: 'gitStatus', changes: [], added: 0, removed: 0, error: 'Open a local Git project to view repository changes.' });
			return;
		}
		try {
			const info = await this.gitChanges();
			this.gitLast = info.changes;
			surface.post({ type: 'gitStatus', ...info });
		} catch (e) {
			this.gitLast = [];
			surface.post({ type: 'gitStatus', changes: [], added: 0, removed: 0, error: e instanceof Error ? e.message : String(e) });
		}
	}

	/** Desktop has no native diff editor. Return bounded plain text, never markup. */
	private async sendTextDiff(surface: HostSurface, rel: string): Promise<void> {
		try {
			const root = workspaceRoot();
			if (!root || root.scheme !== 'file') throw new Error('Open a local Git project to view diffs.');
			const info = await this.gitChanges();
			const change = info.changes.find((c) => c.path === rel);
			if (!change) throw new Error('This file is no longer in the change list. Refresh and try again.');
			const absolute = path.resolve(root.fsPath, rel);
			const relative = path.relative(root.fsPath, absolute);
			if (!rel || path.isAbsolute(rel) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('The diff path must stay inside the workspace.');
			const realRoot = await fs.promises.realpath(root.fsPath);
			const realFile = await fs.promises.realpath(absolute).catch((e: NodeJS.ErrnoException) => {
				if (e.code === 'ENOENT' && change.status === 'D') return path.join(realRoot, relative);
				throw e;
			});
			const realRelative = path.relative(realRoot, realFile);
			if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error('Cannot preview a diff outside the workspace.');
			const limit = 256 * 1024;
			const st = await fs.promises.stat(absolute).catch((e: NodeJS.ErrnoException) => {
				if (e.code === 'ENOENT' && change.status === 'D') return undefined;
				throw e;
			});
			if (st && (!st.isFile() || st.size > limit)) throw new Error('This file is too large or is not a regular text file.');
			const bytes = st ? await fs.promises.readFile(absolute) : Buffer.alloc(0);
			let original = '';
			if (change.status !== '?' && change.status !== 'A') {
				try { original = await this.gitRun(['show', 'HEAD:' + (change.originalPath || rel)]); }
				catch { throw new Error('The HEAD version is unavailable (the file may have been renamed).'); }
			}
			if (bytes.includes(0) || original.includes('\0')) throw new Error('Binary files cannot be shown as a text diff.');
			if (Buffer.byteLength(original, 'utf8') > limit) throw new Error('The HEAD version is too large for an in-page diff.');
			surface.post({ type: 'gitTextDiff', path: rel, original, modified: bytes.toString('utf8') });
		} catch (e) {
			surface.post({ type: 'gitTextDiff', path: rel, error: e instanceof Error ? e.message : String(e) });
		}
	}

	private async gitBranchList(): Promise<{ branches: string[]; current?: string }> {
		const out = await this.gitRun(['branch', '--list', '--format=%(refname:short)']).catch(() => '');
		const branches = out.split('\n').map((b) => b.trim()).filter(Boolean);
		const current = await this.gitRun(['rev-parse', '--abbrev-ref', 'HEAD']).then((b) => b.trim()).catch(() => undefined);
		return { branches, current };
	}

	/** Checkout a listed branch, or create it with -b. Uncommitted changes come along. */
	private async gitSwitchBranch(name: string, create: boolean): Promise<boolean> {
		const clean = name.trim().replace(/^[\/-]+|[^\w.\-/]/g, '');
		if (!clean) {
			return false;
		}
		try {
			if (create) {
				await this.gitRun(['checkout', '-b', clean]);
				return true;
			}
			const { branches } = await this.gitBranchList();
			if (!branches.includes(clean)) {
				return false;
			}
			await this.gitRun(['checkout', clean]);
			return true;
		} catch {
			return false;
		}
	}

	/** Open the diff editor: HEAD ↔ working tree for one changed file. */
	private async gitOpenDiff(rel: string): Promise<void> {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file' || !rel) {
			return;
		}
		const relNorm = rel.replace(/\\/g, '/');
		const fileUri = vscode.Uri.joinPath(root, relNorm);
		if (this.gitLast.find((c) => c.path === relNorm && c.status === '?')) {
			await vscode.window.showTextDocument(fileUri, { preview: true });
			return;
		}
		let head = '';
		try {
			head = await this.gitRun(['show', 'HEAD:' + relNorm]);
		} catch {
			head = ''; // added file with no HEAD version — the left side is empty
		}
		if (head.slice(0, 8000).includes('\u0000')) {
			await vscode.window.showTextDocument(fileUri, { preview: true });
			return;
		}
		const key = newId('git');
		this.originals.set(key, head);
		const left = vscode.Uri.from({ scheme: 'zer0ne-orig', path: '/' + relNorm, query: key });
		await vscode.commands.executeCommand('vscode.diff', left, fileUri, `${relNorm} — HEAD ↔ working tree`, { preview: false, preserveFocus: false });
	}

	/** Composer chips ("Local · my-app", ⎇ branch) and the terminal status line (read from .git/HEAD, no git process). */
	info(): { name: string; branch?: string; path?: string; where: string; worktree?: boolean } | undefined {
		const root = workspaceRoot();
		// Where the agent runs: this machine, or VS Code's remote (SSH, WSL, container, Codespaces).
		const where = vscode.env.remoteName ?? 'local';
		if (!root || root.scheme !== 'file') {
			return root ? { name: root.path.split('/').pop() || root.path, where: root.scheme } : undefined;
		}
		let branch: string | undefined;
		try {
			const head = fs.readFileSync(path.join(root.fsPath, '.git', 'HEAD'), 'utf8').trim();
			branch = head.startsWith('ref: ') ? head.replace(/^ref: refs\/heads\//, '') : head.slice(0, 7);
		} catch {
			// not a git repository (or a worktree file)
		}
		let worktree = false;
		try {
			worktree = fs.statSync(path.join(root.fsPath, '.git')).isFile();
		} catch {
			// no .git entry
		}
		return { name: path.basename(root.fsPath), branch, path: root.fsPath, where, worktree };
	}
}
