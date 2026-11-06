import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { HostContext, HostFeature, HostSurface } from './context';

const MAX_BYTES = 20 * 1024 * 1024;
/** Every format Chromium (the webview) can paint, animated ones included. */
const TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.apng': 'image/apng',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.jfif': 'image/jpeg',
	'.pjpeg': 'image/jpeg',
	'.pjp': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.ico': 'image/x-icon',
	'.cur': 'image/x-icon',
	'.svg': 'image/svg+xml'
};

/**
 * Background pictures for the chat. The webview CSP only allows data: images,
 * so the file is read here and sent once as a data URL (not with every state
 * snapshot).
 */
export class AppearanceHost implements HostFeature {
	private cache?: { file: string; mtime: number; data: string };

	constructor(private readonly ctx: HostContext) {}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'pickBackground': {
				const exts = Object.keys(TYPES).map((e) => e.slice(1));
				const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Use as background', title: 'Choose a background picture or GIF', filters: { 'Images and GIFs': exts, 'Animated (GIF, APNG, WebP)': ['gif', 'apng', 'webp'], 'All files': ['*'] } });
				const file = picked?.[0]?.fsPath;
				if (!file) {
					return true;
				}
				if (!TYPES[path.extname(file).toLowerCase()]) {
					this.ctx.status('That file type can\'t be shown — use PNG, JPG, WebP, AVIF, GIF, APNG, BMP, SVG or ICO.', 'error');
					return true;
				}
				if (fs.statSync(file).size > MAX_BYTES) {
					this.ctx.status('That image is over 20 MB — pick a smaller one.', 'error');
					return true;
				}
				await this.ctx.store.updateSettings({ background: 'image', backgroundImage: file });
				await this.ctx.sendState();
				this.sendImage(undefined);
				return true;
			}
			case 'getBackground':
				this.sendImage(surface);
				return true;
			case 'clearBackground': {
				// Forget the picture (the file itself is untouched); fall back to the theme's own scene.
				const s = this.ctx.store.getSettings();
				await this.ctx.store.updateSettings({ backgroundImage: '', background: s.background === 'image' ? 'auto' : s.background });
				this.cache = undefined;
				await this.ctx.sendState();
				this.sendImage(undefined);
				this.ctx.status('Picture removed from the background.');
				return true;
			}
		}
		return false;
	}

	/** Post the current picture (or null) to one surface, or to all. */
	sendImage(surface: HostSurface | undefined): void {
		const s = this.ctx.store.getSettings();
		let data: string | null = null;
		if (s.backgroundImage) {
			try {
				const st = fs.statSync(s.backgroundImage);
				if (this.cache?.file === s.backgroundImage && this.cache.mtime === st.mtimeMs) {
					data = this.cache.data;
				} else if (st.size <= MAX_BYTES) {
					const type = TYPES[path.extname(s.backgroundImage).toLowerCase()] ?? 'image/png';
					data = `data:${type};base64,${fs.readFileSync(s.backgroundImage).toString('base64')}`;
					this.cache = { file: s.backgroundImage, mtime: st.mtimeMs, data };
				}
			} catch {
				data = null;
			}
		}
		const message = { type: 'backgroundImage', data };
		if (surface) {
			surface.post(message);
		} else {
			this.ctx.postAll(message);
		}
	}
}
