import * as vscode from 'vscode';

/**
 * In-editor review of a pending agent edit (Cline / Copilot style).
 *
 * The proposed text is put into the real file's editor buffer (unsaved) and
 * a diff opens: original ↔ proposed. The user can revert single blocks with
 * the diff editor's own "Revert Block" gutter arrows, or edit the proposal by
 * hand, then Accept (chat card or editor title) — whatever is in the buffer
 * is what gets saved. Reject restores the original text.
 *
 * Files with unsaved changes of their own are never used for a review (we
 * would mix the user's edits with the agent's), the chat card alone is used.
 */

interface Session {
	id: string;
	uri: vscode.Uri;
	before: string;
	origKey: string;
}

export class ReviewManager {
	private readonly sessions = new Map<string, Session>();

	constructor(private readonly originals: Map<string, string>) {}

	/** Start a review; returns false when it cannot be shown (caller falls back to the card). */
	async start(id: string, uri: vscode.Uri, before: string, after: string, title: string): Promise<boolean> {
		let doc: vscode.TextDocument;
		try {
			doc = await vscode.workspace.openTextDocument(uri);
		} catch {
			return false;
		}
		if (doc.isDirty || doc.getText() !== before) {
			return false;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), after);
		if (!(await vscode.workspace.applyEdit(edit))) {
			return false;
		}
		const origKey = `review/${id}`;
		this.originals.set(origKey, before);
		this.sessions.set(id, { id, uri, before, origKey });
		await this.syncContext();
		const left = vscode.Uri.from({ scheme: 'zer0ne-orig', path: uri.path, query: origKey });
		await vscode.commands.executeCommand('vscode.diff', left, uri, `${title} — review agent edit`, { preview: false, preserveFocus: true });
		return true;
	}

	has(id: string): boolean {
		return this.sessions.has(id);
	}

	/** The review whose file is in the active editor (for the editor-title buttons). */
	activeId(): string | undefined {
		const active = vscode.window.activeTextEditor?.document.uri.toString();
		const hit = [...this.sessions.values()].find((s) => s.uri.toString() === active);
		return hit?.id ?? [...this.sessions.keys()].pop();
	}

	/**
	 * Finish a review. Accept → returns the buffer text (with any blocks the
	 * user reverted or edited). Reject → restores the original. The buffer is
	 * left for the caller to save (accept) or saved back to the original.
	 */
	async finish(id: string, accept: boolean): Promise<string | undefined> {
		const s = this.sessions.get(id);
		if (!s) {
			return undefined;
		}
		this.sessions.delete(id);
		await this.syncContext();
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === s.uri.toString());
		let content: string | undefined;
		if (doc) {
			if (accept) {
				content = doc.getText();
			} else {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(s.uri, doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), s.before);
				await vscode.workspace.applyEdit(edit);
				await doc.save();
			}
		}
		await this.closeDiff(s);
		this.originals.delete(s.origKey);
		return content;
	}

	async dispose(): Promise<void> {
		for (const id of [...this.sessions.keys()]) {
			await this.finish(id, false);
		}
	}

	private async closeDiff(s: Session): Promise<void> {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const input = tab.input;
				if (input instanceof vscode.TabInputTextDiff && input.original.scheme === 'zer0ne-orig' && input.original.query === s.origKey) {
					await vscode.window.tabGroups.close(tab).then(undefined, () => undefined);
				}
			}
		}
	}

	private async syncContext(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'zer0ne.reviewActive', this.sessions.size > 0).then(undefined, () => undefined);
	}
}
