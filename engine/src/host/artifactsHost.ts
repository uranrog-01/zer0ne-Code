import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { isDesktopHost } from './capabilities';

/**
 * Artifact previews: the HTML an agent publishes (publish_artifact) opens in
 * a webview panel locked down by a strict CSP — no network egress, no
 * frames, no local resources; libraries only from the CDNs the artifact
 * contract allows. Republishing the same file updates the panel in place:
 * the artifact is one file, and iterating means republishing it.
 *
 * The rendered document is also kept briefly under a random id so a phone
 * (Mobile Remote) can open the same preview: /api/artifacts/<id>.
 */

/** Published previews kept in memory; the newest wins. */
const MAX_PREVIEWS = 12;
const MAX_PREVIEW_BYTES = 2_000_000;
/** A preview id stops working after this, like an artifact panel left open all day. */
const PREVIEW_TTL = 6 * 60 * 60_000;

export interface ArtifactPreview {
	id: string;
	title: string;
	at: number;
}

const CSP =
	`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; media-src data: https:; ` +
	`style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; ` +
	`script-src 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

/** Inject the CSP before anything it governs, keeping the artifact's own markup. */
export function sandboxHtml(html: string, title: string): string {
	const tag = `<title>${title.replace(/[<>&]/g, '')}</title>`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${CSP}${tag}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${CSP}${tag}</head>`);
	}
	return `<!doctype html><html><head><meta charset="utf-8">${CSP}${tag}</head><body>${html}</body></html>`;
}

export class ArtifactHost {
	private readonly panels = new Map<string, vscode.WebviewPanel>();
	/** Rendered documents for phone previews, newest last; seq keeps same-millisecond publishes ordered. */
	private readonly previews = new Map<string, { title: string; at: number; seq: number; html: string }>();
	private seq = 0;

	/** The previews a phone may open, newest first (no documents). */
	list(): ArtifactPreview[] {
		const now = Date.now();
		return [...this.previews.entries()]
			.filter(([, p]) => now - p.at < PREVIEW_TTL)
			.sort(([, a], [, b]) => b.at - a.at || b.seq - a.seq)
			.map(([id, p]) => ({ id, title: p.title, at: p.at }));
	}

	/** The sandboxed document behind a preview id. */
	get(id: string): string | undefined {
		const entry = this.previews.get(id);
		if (!entry || Date.now() - entry.at >= PREVIEW_TTL) return undefined;
		return entry.html;
	}

	private remember(title: string, html: string): void {
		const id = randomUUID();
		this.previews.set(id, { title, at: Date.now(), seq: ++this.seq, html });
		while (this.previews.size > MAX_PREVIEWS) {
			this.previews.delete(this.previews.keys().next().value!);
		}
	}

	async show(file: string, title: string): Promise<void> {
		let html: string | undefined;
		try {
			// The same sandbox the panel gets; large artifacts are still shown, just not on a phone.
			if (fs.statSync(file).size <= MAX_PREVIEW_BYTES) html = sandboxHtml(fs.readFileSync(file, 'utf8'), title);
		} catch {
			html = undefined;
		}
		if (html) this.remember(title, html);
		if (isDesktopHost()) { await vscode.commands.executeCommand('zer0ne.previewArtifact', file, title); return; }
		if (!html) {
			return;
		}
		const key = path.normalize(file).toLowerCase();
		let panel = this.panels.get(key);
		if (!panel) {
			panel = vscode.window.createWebviewPanel('zer0ne.artifact', title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: []
			});
			panel.onDidDispose(() => this.panels.delete(key));
			this.panels.set(key, panel);
		} else {
			panel.title = title;
		}
		try {
			panel.webview.html = html;
			panel.reveal(undefined, true);
		} catch {
			// The panel can be disposed between its close and the onDidDispose event
			// firing — drop it so the next publish opens a fresh one instead of
			// throwing "Webview is disposed" on every later republish.
			this.panels.delete(key);
		}
	}
}
