import * as vscode from 'vscode';
import * as fs from 'fs';
import { createHash, randomUUID } from 'crypto';
import { closeAcpAgents } from '../acp/stream';
import { isDesktopHost } from './capabilities';
import type { Checkpoint, CheckpointStore } from '../checkpoints';
import { isBinaryBytes } from '../checkpoints';
import type { StoredMessage } from '../providerStore';
import { resolveInWorkspace, writeText } from '../tools/agentTools';
import { applyHunks, diffHunks, lineStats } from '../tools/diffStats';
import { redactSecrets } from '../tools/redact';
import { HostContext, HostFeature, HostSurface } from './context';

/** The controller state turn history reads. */
export interface TurnHistoryDeps {
	checkpoints: CheckpointStore;
	/** Original contents served to the diff editor (zer0ne-orig: scheme). */
	originals: Map<string, string>;
	busy(): boolean;
	sessionId(): string;
	messages(): StoredMessage[];
	rewind?(beforeMessage: string): Promise<void>;
}

/**
 * Codex-style turn actions: what each agent turn changed, Undo, Restore to a
 * message (every later turn, newest first), and Review in the diff editor —
 * with checkpoints on disk so they survive a restart. Split out of
 * ChatController.
 */
export class TurnHistory implements HostFeature {
	private restoring = false;
	constructor(
		private readonly ctx: HostContext,
		private readonly d: TurnHistoryDeps
	) {}

	async handle(_surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		if (msg.type === 'undoTurn' || msg.type === 'restoreTo' || msg.type === 'rewindTo') {
			if (this.restoring) throw new Error('Wait for the current file restore to finish.');
			this.restoring = true;
			try {
				if (msg.type === 'undoTurn') await this.undoTurn(String(msg.id), typeof msg.path === 'string' ? msg.path : undefined, msg.redo === true);
				else await this.restoreTo(String(msg.id), msg.type === 'rewindTo');
			} finally { this.restoring = false; }
			return true;
		}
		switch (msg.type) {
			case 'reviewTurn':
				await this.reviewTurn(String(msg.id), typeof msg.path === 'string' ? msg.path : undefined);
				return true;
		}
		return false;
	}


	/** Record what a finished turn changed (edits, +/−) and save its checkpoint for Undo / Review / Restore. */
	async finish(user: StoredMessage, snapshots: Map<string, string | null>, sessionId: string): Promise<void> {
		if (!user.turn) {
			return;
		}
		user.turn.endedAt = Date.now();
		const edits = [];
		const files: Checkpoint['files'] = {};
		const binQueue: Array<{ ref: string; bytes: Uint8Array }> = [];
		for (const [relPath, before] of snapshots) {
			let bytes: Uint8Array | undefined;
			try {
				bytes = await vscode.workspace.fs.readFile(resolveInWorkspace(relPath));
			} catch {
				bytes = undefined; // deleted since
			}
			// A binary file (a command produced an image, archive, …) is kept as bytes
			// in a sidecar; its text snapshot (if any) still drives plain undo.
			if (bytes && isBinaryBytes(bytes)) {
				const ref = createHash('sha256').update(bytes).digest('hex');
				binQueue.push({ ref, bytes });
				files[relPath] = { before, after: null, binary: { afterRef: ref, size: bytes.byteLength } };
				const kB = (bytes.byteLength / 1024).toFixed(0);
				edits.push({ path: relPath, added: 0, removed: 0, created: before === null || undefined, previewBefore: before === null ? 'Not present' : 'Text replaced', previewAfter: `Binary content, ${kB} kB` });
				continue;
			}
			const after = bytes === undefined ? null : new TextDecoder().decode(bytes);
			if (after === before) {
				continue;
			}
			files[relPath] = { before, after };
			const stats = lineStats(before, after);
			const oldLines = redactSecrets(before ?? '').text.split(/\r?\n/), newLines = redactSecrets(after ?? '').text.split(/\r?\n/);
			let changed = 0;
			while (changed < oldLines.length && changed < newLines.length && oldLines[changed] === newLines[changed]) changed++;
			const preview = (text: string | null, lines: string[]) => text === null ? 'Not present' : text === '' ? 'Empty file' : redactSecrets(lines.slice(changed).join(' ').trim() || '(end of file)').text.slice(0, 160);
			edits.push({ path: relPath, ...stats, created: before === null || undefined, deleted: after === null || undefined, previewBefore: preview(before, oldLines), previewAfter: preview(after, newLines) });
		}
		if (edits.length) {
			user.turn.edits = edits;
			// On disk, so Undo / Review / Restore survive a VS Code restart.
			try {
				// Binary after-contents go to sidecars first: the JSON checkpoint only carries the ref.
				for (const bin of binQueue) {
					this.d.checkpoints.saveBinary(sessionId, user.id, bin.ref, bin.bytes);
				}
				// Files too large to snapshot are recorded but cannot be restored:
				// the turn says so instead of claiming a full Undo.
				const skipped = this.d.checkpoints.save(sessionId, { userId: user.id, at: Date.now(), files });
				if (skipped.length) {
					user.turn.undoSkipped = skipped;
					this.ctx.status(`${skipped.length} file${skipped.length === 1 ? '' : 's'} changed by this turn ${skipped.length === 1 ? 'is' : 'are'} too large to snapshot, so ${skipped.length === 1 ? 'it' : 'they'} cannot be undone from here.`, '');
				}
				// Undo only works when at least one file can actually be restored.
				user.turn.undoable = Object.keys(this.d.checkpoints.load(sessionId, user.id)?.files ?? {}).length > 0;
			} catch (error) {
				this.ctx.status(`Could not save the undo checkpoint: ${error instanceof Error ? error.message : error}`, 'error');
			}
		}
	}

	private async undoTurn(userId: string, onlyPath?: string, redo = false): Promise<void> {
		if (this.d.busy()) {
			throw new Error('Wait for the agent to finish before undoing.');
		}
		const cp = this.d.checkpoints.load(this.d.sessionId(), userId);
		const user = this.d.messages().find((m) => m.id === userId);
		if (!cp || !user?.turn || (onlyPath !== undefined && !Object.hasOwn(cp.files, onlyPath))) {
			throw new Error('There is nothing left to undo for this turn.');
		}
		const paths = Object.keys(cp.files).filter(p => (!onlyPath || p === onlyPath) && !!cp.files[p].undone === redo);
		if (!paths.length) throw new Error('There is nothing left to ' + (redo ? 'redo' : 'undo') + ' for this change.');
		const messages = this.d.messages(), from = messages.indexOf(user);
		const sessionId = this.d.sessionId();
		const checkCurrent = () => { if (this.d.busy() || this.d.sessionId() !== sessionId) throw new Error('The chat changed while restoring. Try again after the agent finishes.'); };
		if (redo) {
			const blocked = messages.some((m, i) => m.role === 'user' && m.turn?.edits?.some(e => paths.includes(e.path) && (i < from ? e.undone || m.turn?.undone : i > from && !e.undone && !m.turn?.undone)));
			if (blocked) throw new Error('Redo earlier changes to this file first, and undo any newer changes before redoing this row.');
			const expected = { ...cp, files: Object.fromEntries(paths.map(p => [p, { before: cp.files[p].after, after: cp.files[p].before }])) };
			if (!(await this.confirmOverwrite([expected]))) return;
			checkCurrent();
			await this.revertCheckpoint({ ...cp, files: Object.fromEntries(paths.map(p => [p, cp.files[p]])) }, true, sessionId);
			await this.ctx.sendState();
			this.ctx.status(`Redid ${paths.length} file${paths.length === 1 ? '' : 's'}.`, '');
			return;
		}
		// Later snapshots of the same path build on this one. Revert those first;
		// unrelated files in those turns stay intact.
		if (messages.slice(from + 1).some(m => m.turn?.edits?.some(e => paths.includes(e.path) && !e.undone && !m.turn?.undone && !this.d.checkpoints.load(sessionId, m.id)?.files[e.path]))) throw new Error('A later edit to this file has no undo snapshot. Review that change before restoring an earlier version.');
		const cps = messages.slice(from).filter(m => m.role === 'user').map(m => this.d.checkpoints.load(this.d.sessionId(), m.id)).filter((c): c is Checkpoint => !!c).map(c => ({ ...c, files: Object.fromEntries(Object.entries(c.files).filter(([p, f]) => paths.includes(p) && !f.undone)) })).filter(c => Object.keys(c.files).length).reverse();
		if (cps.length > 1 && await vscode.window.showWarningMessage(`Undo this change and ${cps.length - 1} later turn${cps.length === 2 ? '' : 's'} that edited the same file${paths.length === 1 ? '' : 's'}? Commands and connected-system effects will remain.`, { modal: true }, 'Undo changes') !== 'Undo changes') return;
		if (!(await this.confirmOverwrite(cps))) {
			return;
		}
		checkCurrent();
		let count = 0;
		for (const c of cps) count += await this.revertCheckpoint(c, false, sessionId);
		const skipped = cp.skipped?.length ?? 0;
		this.ctx.status(
			`Reverted ${count} file${count === 1 ? '' : 's'}.` +
			(skipped ? ` ${skipped} file${skipped === 1 ? '' : 's'} changed by this turn ${skipped === 1 ? 'was' : 'were'} too large to snapshot and ${skipped === 1 ? 'was' : 'were'} not restored.` : ''),
			skipped ? 'error' : ''
		);
		await this.ctx.store.saveMessages(this.d.sessionId(), this.d.messages());
		await this.ctx.sendState();
	}

	/** Undo every agent turn from this message onward (newest first). */
	private async restoreTo(userId: string, rewind = false): Promise<void> {
		if (this.d.busy()) {
			throw new Error('Wait for the agent to finish before restoring.');
		}
		const from = this.d.messages().findIndex((m) => m.id === userId);
		const sessionId = this.d.sessionId();
		if (from < 0) {
			return;
		}
		if (rewind) {
			if (!this.d.rewind) throw new Error('Conversation rewind is unavailable in this host.');
			for (const message of this.d.messages().slice(from)) {
				if (!message.turn || message.turn.undone) continue;
				const cp = this.d.checkpoints.load(sessionId, message.id);
				if (cp?.skipped?.length || message.turn.undoSkipped?.length || message.turn.edits?.some(e => !e.undone && !cp?.files[e.path])) throw new Error('Some later edits have no complete checkpoint. Restore or review them manually before rewinding.');
			}
		}
		const cps = this.d.messages()
			.slice(from)
			.filter((m) => m.role === 'user' && m.turn && !m.turn.undone)
			.map((m) => this.d.checkpoints.load(this.d.sessionId(), m.id))
			.filter((c): c is Checkpoint => !!c && Object.values(c.files).some(f => !f.undone))
			.reverse();
		if (!cps.length && !rewind) {
			throw new Error('No file changes to restore after this message.');
		}
		const files = new Set(cps.flatMap(c => Object.entries(c.files).filter(([, f]) => !f.undone).map(([p]) => p)));
		const ok = await vscode.window.showWarningMessage(
			`Restore ${files.size} file${files.size === 1 ? '' : 's'} to how they were before this message? This undoes the agent's changes from ${cps.length} turn${cps.length === 1 ? '' : 's'}. ` + (rewind ? 'Create a new chat before this message; the original conversation remains available. ' : 'The conversation will be retained. ') + 'Commands and connected-system effects remain.',
			{ modal: true },
			rewind ? 'Restore and create new chat' : 'Restore files'
		);
		if (!ok || !(await this.confirmOverwrite(cps))) {
			return;
		}
		if (this.d.busy() || this.d.sessionId() !== sessionId) throw new Error('The chat changed while restoring. Try again after the agent finishes.');
		for (const cp of cps) {
			await this.revertCheckpoint(cp, false, sessionId);
		}
		const skipped = cps.reduce((n, c) => n + (c.skipped?.length ?? 0), 0);
		this.ctx.status(
			`Restored ${files.size} file${files.size === 1 ? '' : 's'}.` +
			(skipped ? ` ${skipped} file${skipped === 1 ? '' : 's'} ${skipped === 1 ? 'was' : 'were'} too large to snapshot and ${skipped === 1 ? 'was' : 'were'} not restored.` : ''),
			skipped ? 'error' : ''
		);
		await this.ctx.store.saveMessages(this.d.sessionId(), this.d.messages());
		if (rewind) { closeAcpAgents(undefined, sessionId); await this.d.rewind!(userId); }
		await this.ctx.sendState();
	}

	/** Files the user changed after the agent: ask before overwriting them. */
	private async confirmOverwrite(cps: Checkpoint[]): Promise<boolean> {
		const latest = new Map<string, string | null>();
		const binaryLatest = new Map<string, { userId: string; ref: string }>();
		for (const cp of [...cps].reverse()) {
			for (const [rel, f] of Object.entries(cp.files)) {
				if (f.undone) continue;
				if (f.binary) {
					// Binary files compare by the SHA-256 the checkpoint committed to, not by decoded text.
					binaryLatest.set(rel, { userId: cp.userId, ref: f.binary.afterRef });
					latest.delete(rel);
					continue;
				}
				latest.set(rel, f.review ? applyHunks(f.before ?? '', f.after ?? '', diffHunks(f.before ?? '', f.after ?? ''), new Set(f.review.undone)) : f.after); // newest turn wins
			}
		}
		const changed: string[] = [];
		for (const [rel, after] of latest) {
			let now: string | null = null;
			try {
				now = new TextDecoder().decode(await vscode.workspace.fs.readFile(resolveInWorkspace(rel)));
			} catch {
				now = null;
			}
			if (now !== after && (now ?? '').replace(/\r\n/g, '\n') !== (after ?? '').replace(/\r\n/g, '\n')) {
				changed.push(rel);
			}
		}
		for (const [rel, bin] of binaryLatest) {
			let now: Buffer | undefined;
			try {
				now = Buffer.from(await vscode.workspace.fs.readFile(resolveInWorkspace(rel)));
			} catch {
				now = undefined;
			}
			const expected = this.d.checkpoints.readBinary(this.d.sessionId(), bin.userId, bin.ref);
			if (!now !== !expected || (now && expected && !now.equals(expected))) {
				changed.push(rel);
			}
		}
		if (!changed.length) {
			return true;
		}
		const pick = await vscode.window.showWarningMessage(
			`${changed.length} file${changed.length === 1 ? ' was' : 's were'} changed after the agent edited ${changed.length === 1 ? 'it' : 'them'} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}). Undoing overwrites those later changes.`,
			{ modal: true },
			'Undo anyway'
		);
		return pick === 'Undo anyway';
	}

	private async revertCheckpoint(cp: Checkpoint, redo = false, sessionId = this.d.sessionId()): Promise<number> {
		const messages = this.d.messages();
		let count = 0, failed = false;
		const restored: string[] = [];
		try {
			for (const [rel, f] of Object.entries(cp.files)) {
				if (!!f.undone !== redo) continue;
				if (this.d.busy() || this.d.sessionId() !== sessionId) throw new Error('The chat changed while restoring. Remaining files were left intact.');
				const uri = resolveInWorkspace(rel);
				if (f.binary) {
					// Redo writes the binary sidecar back; undo restores the text snapshot (or deletes a created binary file).
					if (redo) {
						const bytes = this.d.checkpoints.readBinary(sessionId, cp.userId, f.binary.afterRef);
						if (!bytes) throw new Error(`The binary content of ${rel} is missing from its checkpoint; restore it manually.`);
						await vscode.workspace.fs.writeFile(uri, bytes);
					} else if (f.before === null) {
						try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
					} else {
						await writeText(uri, f.before);
					}
				} else {
					const text = redo ? f.after : f.before;
					if (text === null) {
						try { await vscode.workspace.fs.delete(uri, { useTrash: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
					} else {
						await writeText(uri, text);
					}
				}
				count++;
				restored.push(rel);
				f.undone = !redo;
				f.review = undefined;
			}
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			// Keep successful rows accurate even if a later file cannot be restored.
			if (count) {
				messages.push({ id:'restore-' + randomUUID(), role:'assistant', content:`Workspace file ${redo ? 'redo' : 'restore'}${failed ? ' (partially completed)' : ''}: ${restored.join(', ')}. Conversation history was retained. Commands and connected-system effects remain. Inspect these files before editing them again.` });
				closeAcpAgents(undefined, sessionId);
				const saved = this.d.checkpoints.load(sessionId, cp.userId) ?? cp;
				Object.assign(saved.files, cp.files);
				this.d.checkpoints.save(sessionId, saved);
				const user = messages.find(m => m.id === cp.userId);
				if (user?.turn) {
					for (const edit of user.turn.edits ?? []) if (saved.files[edit.path]) edit.undone = !!saved.files[edit.path].undone;
					user.turn.undone = (user.turn.edits ?? []).every(e => e.undone);
					user.turn.undoable = Object.values(saved.files).some(f => !f.undone);
				}
				await this.ctx.store.saveMessages(sessionId, messages);
				if (failed) await this.ctx.sendState();
			}
		}
		return count;
	}

	private async reviewTurn(userId: string, onlyPath?: string): Promise<void> {
		const cp = this.d.checkpoints.load(this.d.sessionId(), userId);
		if (!cp) {
			if (onlyPath) {
				await vscode.window.showTextDocument(resolveInWorkspace(onlyPath), { preview: true });
				return;
			}
			throw new Error(isDesktopHost() ? 'This turn was undone, so there is nothing to compare. Use Work Details → Changes.' : 'This turn was undone, so there is nothing to compare. Use the Source Control view.');
		}
		if (isDesktopHost()) {
			const files = Object.entries(cp.files).filter(([name]) => !onlyPath || name === onlyPath).map(([name, value]) => {
				const uri = resolveInWorkspace(name);
				let after: string | null = null;
				try { const data = fs.readFileSync(uri.fsPath); if (data.length > 2_000_000 || data.includes(0)) throw new Error('Binary or large file'); after = data.toString('utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
				return { path: name, before: value.before, after: onlyPath ? value.after : after };
			});
			this.ctx.postAll({ type: 'zcCheckpointReview', files });
			return;
		}
		const entries: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
		for (const [relPath, { before }] of Object.entries(cp.files)) {
			if (onlyPath && relPath !== onlyPath) {
				continue;
			}
			const key = `${userId}/${relPath}`;
			this.d.originals.set(key, before ?? '');
			const original = vscode.Uri.from({ scheme: 'zer0ne-orig', path: '/' + relPath, query: key });
			const current = resolveInWorkspace(relPath);
			entries.push([current, original, current]);
		}
		if (entries.length === 1) {
			await vscode.commands.executeCommand('vscode.diff', entries[0][1], entries[0][2], `${onlyPath ?? entries[0][0].path.split('/').pop()} (before ↔ after)`);
			return;
		}
		try {
			await vscode.commands.executeCommand('vscode.changes', 'zer0ne · changes in this turn', entries);
		} catch {
			for (const [, left, right] of entries) {
				await vscode.commands.executeCommand('vscode.diff', left, right);
			}
		}
	}
}
