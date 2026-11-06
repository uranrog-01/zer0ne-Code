import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { closeAcpAgents } from '../acp/stream';
import type { CheckpointFile, CheckpointStore } from '../checkpoints';
import type { StoredMessage } from '../providerStore';
import { resolveInWorkspace, writeText } from '../tools/agentTools';
import { compileDeny } from '../tools/deny';
import { noLinks } from '../tools/extensionFiles';
import { applyHunks, diffHunks } from '../tools/diffStats';
import { redactSecrets } from '../tools/redact';
import type { HostContext, HostFeature, HostSurface } from './context';

export function checkpointHunks(file: CheckpointFile) {
	return file.before === null || file.after === null
		? [{ aStart: 0, aEnd: (file.before ?? '').split('\n').length, bStart: 0, bEnd: (file.after ?? '').split('\n').length }]
		: diffHunks(file.before, file.after);
}

export function reviewedContent(file: CheckpointFile): string | null {
	const hunks = checkpointHunks(file), rejected = new Set(file.review?.undone ?? (file.undone ? hunks.map((_, i) => i) : []));
	if (!rejected.size) return file.after;
	if (rejected.size === hunks.length) return file.before;
	return applyHunks(file.before ?? '', file.after ?? '', hunks, rejected);
}

interface Deps {
	checkpoints: CheckpointStore;
	session(): string;
	messages(): StoredMessage[];
	busy(): boolean;
}

/** Decisions are bound to the displayed snapshot, never to text supplied by a page. */
export class HunkReviewHost implements HostFeature {
	private reviews = new Map<string, { owner: HostSurface; session: string; id: string; path: string; snapshot: string; at: number }>();
	private changing = false;
	get busy(): boolean { return this.changing; }
	constructor(private readonly ctx: HostContext, private readonly d: Deps) {}
	async handle(surface: HostSurface, msg: { type: string; [key: string]: unknown }): Promise<boolean> {
		if (msg.type !== 'hunkReview' && msg.type !== 'hunkDecision') return false;
		let release: (() => void) | undefined;
		try {
			const session = this.d.session();
			if (msg.sessionId !== session) throw new Error('Open this review again in its original chat.');
			const token = msg.type === 'hunkDecision' ? this.reviews.get(String(msg.reviewId)) : undefined;
			if (msg.type === 'hunkDecision' && (!token || token.owner !== surface || token.session !== session || Date.now() - token.at > 900_000)) throw new Error('This review expired. Open Review hunks again.');
			const messages = this.d.messages(), id = token?.id ?? String(msg.id), rel = token?.path ?? String(msg.path);
			if (!messages.some(m => m.id === id)) throw new Error('That turn is not in this chat.');
			const denied = compileDeny(this.ctx.store.getSettings().denyPaths ?? '');
			if (rel.split(/[\\/]/).some(part => part.toLowerCase() === '.git') || denied(rel)) throw new Error('This path is protected.');
			if (msg.type === 'hunkDecision') {
				release = this.d.checkpoints.acquireReview(session, id);
				if (!release) throw new Error('Another window is reviewing this checkpoint. Try again when it finishes.');
			}
			const cp = this.d.checkpoints.load(session, id), file = cp?.files[rel];
			if (!cp || !file) throw new Error('This file has no saved checkpoint.');
			if (file.binary) throw new Error('This file was changed as binary content: Undo restores it whole, but hunks cannot be reviewed.');
			if ([file.before, file.after].some(text => text?.includes('\0'))) throw new Error('Binary files cannot be reviewed as text hunks.');
			const hunks = checkpointHunks(file);
			if (msg.type === 'hunkDecision') {
				if (this.changing || this.d.busy() || this.ctx.store.getMode() !== 'full') throw new Error('Hunk decisions need an idle chat in Full Access.');
				if (token!.snapshot !== JSON.stringify(file)) throw new Error('The checkpoint changed. Open Review hunks again.');
				const later = messages.slice(messages.findIndex(m => m.id === id) + 1);
				if (later.some(m => { const f = this.d.checkpoints.load(session, m.id)?.files[rel]; return f ? !f.undone : m.turn?.edits?.some(e => e.path === rel && !e.undone); })) throw new Error('Review the newer change to this file first.');
				const index = Number(msg.index), action = String(msg.action);
				if (!Number.isInteger(index) || !hunks[index] || !['keep', 'undo', 'redo'].includes(action)) throw new Error('Unknown hunk decision.');
				const hunk = hunks[index];
				if ((file.before ?? '').split('\n').slice(hunk.aStart, hunk.aEnd).join('\n').length > 16000 || (file.after ?? '').split('\n').slice(hunk.bStart, hunk.bEnd).join('\n').length > 16000) throw new Error('This block is too large for a complete hunk preview. Use full-file Review and Undo instead.');
				const uri = resolveInWorkspace(rel);
				noLinks(uri.fsPath);
				try { if (fs.statSync(uri.fsPath).nlink > 1) throw new Error('Hard-linked files cannot be changed from hunk review.'); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
				if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString() && doc.isDirty)) throw new Error('Save your manual edits before reviewing this file.');
				const read = (): string | null => { try { return new TextDecoder().decode(fs.readFileSync(uri.fsPath)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
				const before = reviewedContent(file);
				if (read() !== before) throw new Error('The file changed outside this review. Your edits were left intact.');
				const write = async (text: string | null, expected: string | null) => {
					resolveInWorkspace(rel); noLinks(uri.fsPath);
					if (read() !== expected) throw new Error('The file changed while applying this decision. Your edits were left intact.');
					if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri.toString())) {
						if (text === null) await vscode.workspace.fs.delete(uri, { useTrash: true }); else await writeText(uri, text);
					} else if (text === null) fs.unlinkSync(uri.fsPath);
					else {
						const bytes = expected === null ? undefined : fs.readFileSync(uri.fsPath), bom = bytes?.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
						fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
						fs.writeFileSync(uri.fsPath, (bom ? '\ufeff' : '') + text, 'utf8');
					}
				};
				const original = JSON.parse(JSON.stringify(file)) as CheckpointFile;
				const undone = new Set(file.review?.undone ?? (file.undone ? hunks.map((_, i) => i) : [])), kept = new Set(file.review?.kept ?? []);
				if (action === 'undo') { undone.add(index); kept.delete(index); }
				else { undone.delete(index); if (action === 'keep') kept.add(index); else kept.delete(index); }
				file.review = { kept: [...kept], undone: [...undone] };
				file.undone = hunks.length > 0 && undone.size === hunks.length;
				const after = reviewedContent(file);
				this.changing = true;
				try {
					if (after !== before) {
						await write(after, before);
					}
					try { this.d.checkpoints.save(session, cp); }
					catch (error) {
						if (read() === after && after !== before) await write(before, after);
						cp.files[rel] = original; throw error;
					}
					const user = messages.find(m => m.id === id);
					if (user?.turn) {
						for (const edit of user.turn.edits ?? []) if (cp.files[edit.path]) edit.undone = !!cp.files[edit.path].undone;
						user.turn.undone = Object.values(cp.files).every(f => f.undone);
						user.turn.undoable = Object.values(cp.files).some(f => !f.undone);
					}
					if (after !== before) {
						messages.push({ id:'restore-' + randomUUID(), role:'assistant', content:`Workspace file ${action}: a change block in ${rel} was restored. Conversation history was retained. Inspect the file before editing it again; commands and connected-system effects remain.` });
						closeAcpAgents(undefined, session);
					}
					await this.ctx.store.saveMessages(session, messages);
					await this.ctx.sendState();
				} finally { this.changing = false; }
			}
			const reviewId = randomUUID();
			this.reviews.clear();
			this.reviews.set(reviewId, { owner: surface, session, id, path: rel, snapshot: JSON.stringify(file), at: Date.now() });
			const a = (file.before ?? '').split('\n'), b = (file.after ?? '').split('\n');
			surface.post({ type: 'hunkReviewResult', sessionId: session, id, path: rel, reviewId, hunks: hunks.map((h, index) => {
				const before = a.slice(h.aStart, h.aEnd).join('\n'), after = b.slice(h.bStart, h.bEnd).join('\n');
				return { index, line: h.bStart + 1, before: redactSecrets(before).text.slice(0, 16000), after: redactSecrets(after).text.slice(0, 16000), truncated: before.length > 16000 || after.length > 16000, undone: file.review?.undone.includes(index) ?? !!file.undone, kept: file.review?.kept.includes(index) ?? false };
			}) });
		} catch (error) { surface.post({ type: 'hunkReviewResult', sessionId: this.d.session(), error: error instanceof Error ? error.message : String(error) }); }
		finally { release?.(); }
		return true;
	}
}
