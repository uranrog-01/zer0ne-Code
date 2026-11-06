import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { newId } from '../providerStore';
import { workspaceRoot } from '../tools/agentTools';
import { HostContext, HostFeature, HostSurface } from './context';
import { folderContext } from './mentions';

export interface PendingAttachment {
	id: string;
	name: string;
	kind: 'text' | 'image';
	content?: string;
	mime?: string;
	base64?: string;
}

const MAX_ATTACHMENT_CHARS = 100_000;
const MAX_IMAGE_BYTES = 5_000_000;
const IMAGE_MIMES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/**
 * What waits in the composer for the next message: attached files and
 * folders (as text) and images (picked, pasted or dropped). Split out of
 * ChatController; the controller reads `items` when it sends.
 */
export class Attachments implements HostFeature {
	items: PendingAttachment[] = [];

	private saved: PendingAttachment[] = [];
	private sessionId = '';
	private savedSessionId = '';
	private readonly drafts = new Map<string, PendingAttachment[]>();
	constructor(private readonly ctx: HostContext, private readonly draftFile?: string) {
		if (!draftFile) return;
		try {
			if (fs.statSync(draftFile).size > 64_000_000) throw new Error('Attachment draft is too large.');
			const value = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
			const valid = (items: unknown): PendingAttachment[] => Array.isArray(items) ? items.filter(a => a && typeof a.id === 'string' && typeof a.name === 'string' && (a.kind === 'text' || a.kind === 'image')) : [];
			if (Array.isArray(value)) this.items = valid(value);
			else if (value?.version === 1 && Array.isArray(value.drafts)) {
				for (const entry of value.drafts) if (Array.isArray(entry) && typeof entry[0] === 'string') this.drafts.set(entry[0], valid(entry[1]));
				this.sessionId = typeof value.sessionId === 'string' ? value.sessionId : '';
				this.items = this.drafts.get(this.sessionId) ?? [];
			}
			this.saved = [...this.items];
			this.savedSessionId = this.sessionId;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ctx.status('Could not restore pending attachments: ' + String(error), 'error'); }
	}
	private persist(force = false): void {
		if (!this.draftFile || (!force && this.sessionId === this.savedSessionId && this.items.length === this.saved.length && this.items.every((item,i) => item === this.saved[i]))) return;
		if (this.items.length) this.drafts.set(this.sessionId, [...this.items]);
		else this.drafts.delete(this.sessionId);
		try { fs.mkdirSync(path.dirname(this.draftFile), {recursive:true}); fs.writeFileSync(this.draftFile + '.tmp', JSON.stringify({ version: 1, sessionId: this.sessionId, drafts: [...this.drafts] })); fs.renameSync(this.draftFile + '.tmp', this.draftFile); this.saved = [...this.items]; this.savedSessionId = this.sessionId; }
		catch (error) { this.ctx.status('Could not save pending attachments: ' + String(error), 'error'); }
	}

	selectSession(id: string): void {
		if (id === this.sessionId) return;
		if (this.sessionId) {
			if (this.items.length) this.drafts.set(this.sessionId, [...this.items]);
			else this.drafts.delete(this.sessionId);
			this.items = [...(this.drafts.get(id) ?? [])];
		}
		// Legacy drafts had no session ID; the first active chat owns them.
		this.drafts.delete('');
		this.sessionId = id;
		this.persist();
	}

	removeSession(id: string): void {
		if (id === this.sessionId) this.items = [];
		this.drafts.delete(id);
		this.persist(true);
	}

	async handle(_surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'pickFolder':
				await this.pickFolders();
				return true;
			case 'pickAttachment':
				await this.pickFiles();
				return true;
			case 'addImage':
				this.addImage(String(msg.name ?? 'pasted-image.png'), String(msg.mime ?? ''), String(msg.base64 ?? ''));
				await this.ctx.sendState();
				return true;
			case 'addText':
				this.addText(String(msg.name ?? 'attachment.txt'), String(msg.content ?? ''));
				await this.ctx.sendState();
				return true;
			case 'removeAttachment':
				this.items = this.items.filter((a) => a.id !== msg.id);
				await this.ctx.sendState();
				return true;
			// The webview draws thumbnails from this; the bytes stay out of the state message.
			case 'readAttachmentImages':
				_surface.post({ type: 'attachmentImages', images: this.items.filter((a) => a.kind === 'image').map((a) => ({ id: a.id, url: `data:${a.mime};base64,${a.base64}` })) });
				return true;
		}
		return false;
	}

	clear(): void {
		this.items = [];
		this.persist();
	}

	/** What the webview shows (no contents). */
	view(): Array<{ id: string; name: string; kind: 'text' | 'image' }> {
		this.persist();
		return this.items.map(({ id, name, kind }) => ({ id, name, kind }));
	}

	addImage(name: string, mime: string, base64: string): void {
		if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || !base64) {
			this.ctx.status('Only PNG, JPEG, GIF or WebP images can be attached.', 'error');
			return;
		}
		if (base64.length * 0.75 > MAX_IMAGE_BYTES) {
			this.ctx.status(`"${name}" is larger than 5 MB.`, 'error');
			return;
		}
		this.items.push({ id: newId('a'), name, kind: 'image', mime, base64 });
	}

	/** A text file from a phone (or anywhere without a file picker): logs, notes, small data files. */
	addText(name: string, content: string): void {
		if (!content.trim()) {
			this.ctx.status(`"${name}" is empty.`, 'error');
			return;
		}
		const text = content.length > MAX_ATTACHMENT_CHARS ? content.slice(0, MAX_ATTACHMENT_CHARS) + `\n[… truncated, file has ${content.length} characters]` : content;
		this.items.push({ id: newId('a'), name: (name || 'attachment.txt').slice(0, 200), kind: 'text', content: text });
	}

	private async pickFolders(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Attach folder', defaultUri: workspaceRoot() });
		for (const uri of picked ?? []) {
			const label = (workspaceRoot() && uri.fsPath.startsWith(workspaceRoot()!.fsPath) ? vscode.workspace.asRelativePath(uri, false) : uri.path.split('/').pop() ?? uri.fsPath) + '/';
			const ctx = await folderContext(uri, label);
			if (ctx) {
				this.items.push({ id: newId('a'), name: label, kind: 'text', content: ctx.content });
			} else {
				this.ctx.status(`${label} has no readable files.`, 'error');
			}
		}
		await this.ctx.sendState();
	}

	private async pickFiles(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: workspaceRoot() });
		for (const uri of uris ?? []) {
			const name = uri.path.split('/').pop() ?? uri.fsPath;
			try {
				const bytes = await vscode.workspace.fs.readFile(uri);
				const mime = IMAGE_MIMES[name.toLowerCase().split('.').pop() ?? ''];
				if (mime) {
					this.addImage(name, mime, Buffer.from(bytes).toString('base64'));
					continue;
				}
				if (bytes.subarray(0, 8000).includes(0)) {
					this.ctx.status(`"${name}" looks binary and was skipped.`, 'error');
					continue;
				}
				let content = new TextDecoder().decode(bytes);
				if (content.length > MAX_ATTACHMENT_CHARS) {
					content = content.slice(0, MAX_ATTACHMENT_CHARS) + `\n[… truncated, file has ${content.length} characters]`;
				}
				this.items.push({ id: newId('a'), name, kind: 'text', content });
			} catch (error) {
				this.ctx.status(`Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`, 'error');
			}
		}
		await this.ctx.sendState();
	}
}
