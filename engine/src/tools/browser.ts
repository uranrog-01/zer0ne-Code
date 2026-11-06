import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { snapshotScript, nodeExpression, pointScript } from './browserDom';
import { browserSteps } from './browserBatch';
import { killTree } from './proc';

/**
 * Browser agent: drives a real Chrome / Edge window over the Chrome
 * DevTools Protocol (CDP) — no Puppeteer, no downloads. It runs in its own
 * profile so it never touches the user's everyday browser.
 *
 * While the agent is in control, an overlay (Antigravity-style) frames the
 * page with a soft blue glow, shows an "agent is controlling" pill and
 * animates a cursor with click ripples. The overlay is hidden for
 * screenshots so the model sees the real page.
 *
 * Each action returns a snapshot: URL, title, numbered interactive
 * elements ([ref] tags the agent can click/type into), visible text, and
 * a JPEG screenshot (full size for vision models, thumbnail for the chat).
 */

export interface BrowserSnapshot {
	url: string;
	title: string;
	elements: string;
	text: string;
	scroll: string;
	screenshot?: string; // base64 jpeg
	thumbnail?: string; // data: URL
	warnings?: string[];
}

interface FrameContext { id: number; frame: string; session?: string; }

interface Pending {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
}

const OVERLAY = `(() => {
	if (window.__zer0ne) { window.__zer0ne.show(); return; }
	const mk = (tag, css) => { const e = document.createElement(tag); e.style.cssText = css; return e; };
	let root, cursor, label, box;
	const build = () => {
		if (root && root.isConnected) return;
		root = mk('div', 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;');
		const frame = mk('div', 'position:absolute;inset:0;box-shadow:inset 0 0 0 2px rgba(96,165,250,.8),inset 0 0 26px 5px rgba(59,130,246,.3);');
		const pill = mk('div', 'position:absolute;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:6px 13px 6px 10px;border-radius:999px;background:rgba(15,23,42,.9);color:#dbeafe;font:500 12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;border:1px solid rgba(96,165,250,.45);box-shadow:0 6px 22px rgba(37,99,235,.3);');
		const dot = mk('span', 'width:8px;height:8px;border-radius:50%;background:#60a5fa;box-shadow:0 0 10px #60a5fa;');
		label = mk('span', 'max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		label.textContent = sessionStorage.getItem('__z_status') || 'zer0ne agent is controlling this browser';
		pill.append(dot, label);
		cursor = mk('div', 'position:absolute;left:0;top:0;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(96,165,250,.28);border:2px solid #60a5fa;box-shadow:0 0 14px rgba(96,165,250,.75);opacity:0;transition:transform .5s cubic-bezier(.2,.8,.2,1),opacity .25s;');
		box = mk('div', 'position:absolute;border:2px solid #60a5fa;border-radius:6px;background:rgba(96,165,250,.12);box-shadow:0 0 0 4px rgba(96,165,250,.18);opacity:0;transition:opacity .2s;');
		root.append(frame, box, pill, cursor);
		// The cursor stays where it was across page loads (it used to reset to the corner).
		const last = (sessionStorage.getItem('__z_cursor') || '').split(',');
		if (last.length === 2) { cursor.style.transition = 'none'; cursor.style.opacity = '1'; cursor.style.transform = 'translate(' + last[0] + 'px,' + last[1] + 'px)'; requestAnimationFrame(() => (cursor.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1),opacity .25s')); }
		document.documentElement.appendChild(root);
		dot.animate([{ opacity: 1 }, { opacity: 0.3 }, { opacity: 1 }], { duration: 1400, iterations: Infinity });
		frame.animate([{ opacity: 0.7 }, { opacity: 1 }, { opacity: 0.7 }], { duration: 2600, iterations: Infinity });
	};
	window.__zer0ne = {
		show() { build(); root.style.display = 'block'; },
		hide() { if (root) root.style.display = 'none'; },
		move(x, y) { build(); cursor.style.opacity = '1'; cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)'; try { sessionStorage.setItem('__z_cursor', x + ',' + y); } catch {} },
		say(text) { build(); label.textContent = text; try { sessionStorage.setItem('__z_status', text); } catch {} },
		mark(x, y, w, h) { build(); Object.assign(box.style, { left: x - 3 + 'px', top: y - 3 + 'px', width: w + 6 + 'px', height: h + 6 + 'px', opacity: '1' }); clearTimeout(box._t); box._t = setTimeout(() => (box.style.opacity = '0'), 1400); },
		ripple(x, y) {
			build();
			const r = mk('div', 'position:absolute;left:' + x + 'px;top:' + y + 'px;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid #60a5fa;');
			root.appendChild(r);
			r.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(5)', opacity: 0 }], { duration: 650, easing: 'ease-out' }).onfinish = () => r.remove();
		}
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.__zer0ne.show());
	else window.__zer0ne.show();
})();`;

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
	Enter: { code: 'Enter', vk: 13, text: '\r' },
	Tab: { code: 'Tab', vk: 9 },
	Escape: { code: 'Escape', vk: 27 },
	Backspace: { code: 'Backspace', vk: 8 },
	Delete: { code: 'Delete', vk: 46 },
	ArrowUp: { code: 'ArrowUp', vk: 38 },
	ArrowDown: { code: 'ArrowDown', vk: 40 },
	ArrowLeft: { code: 'ArrowLeft', vk: 37 },
	ArrowRight: { code: 'ArrowRight', vk: 39 },
	PageUp: { code: 'PageUp', vk: 33 },
	PageDown: { code: 'PageDown', vk: 34 },
	Home: { code: 'Home', vk: 36 },
	End: { code: 'End', vk: 35 },
	Space: { code: 'Space', vk: 32, text: ' ' }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function findBrowser(custom?: string): string | undefined {
	if (custom && fs.existsSync(custom)) {
		return custom;
	}
	const env = process.env;
	const candidates =
		process.platform === 'win32'
			? [
					`${env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
					`${env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
					`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
					`${env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
					`${env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
					`${env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
					`${env.ProgramFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
					`${env.LOCALAPPDATA}\\Google\\Chrome SxS\\Application\\chrome.exe`,
					`${env.LOCALAPPDATA}\\Chromium\\Application\\chrome.exe`
			]
			: process.platform === 'darwin'
				? [
						'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
						'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
						'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
						'/Applications/Chromium.app/Contents/MacOS/Chromium'
					]
				: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser', '/snap/bin/chromium'];
	return candidates.find((p) => p && !p.includes('undefined') && fs.existsSync(p));
}

export class BrowserAgent {
	preview?: { url: string; title: string; thumbnail?: string; at: number };
	get activity(): string[] { return this.logs.slice(-30); }
	private proc?: ChildProcess;
	private ws?: WebSocket;
	private seq = 0;
	private readonly pending = new Map<number, Pending>();
	private logs: string[] = [];
	private net: string[] = [];
	private readonly requests = new Map<string, { method: string; url: string }>();
	private connecting?: Promise<void>;
	private port?: number;
	private targetId?: string;
	/** A tab the current page just opened (target=_blank, window.open). */
	private openedTab?: string;
	private readonly contexts = new Map<string, FrameContext>();
	private readonly parents = new Map<string, string>();
	private readonly refs = new Map<number, FrameContext>();
	private readonly frameSetup = new Set<Promise<void>>();
	private mainFrame?: string;
	private nextRef = 0;
	private batching = false;
	private readonly ownedTabs = new Set<string>();

	constructor(
		private readonly storageDir: string,
		private readonly options: () => { path: string; headless: boolean }
	) {}

	get active(): boolean {
		return !!this.ws && this.ws.readyState === 1;
	}

	private get profileDir(): string {
		return path.join(this.storageDir, 'browser-profile');
	}

	// ------------------------------------------------------------ connection

	private async ensure(): Promise<void> {
		if (this.active) {
			return;
		}
		this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
		await this.connecting;
	}

	private async readPort(): Promise<number | undefined> {
		try {
			const [port] = fs.readFileSync(path.join(this.profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
			return Number(port) || undefined;
		} catch {
			return undefined;
		}
	}

	private async targets(port: number): Promise<Array<{ id: string; type: string; webSocketDebuggerUrl?: string; url: string; title: string }>> {
		const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()) as Array<{ id: string; type: string; webSocketDebuggerUrl?: string; url: string; title: string }>;
		return list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
	}

	private async pageSocketUrl(port: number): Promise<string | undefined> {
		try {
			const page = (await this.targets(port)).find((t) => t.webSocketDebuggerUrl && this.ownedTabs.has(t.id));
			if (page) {
				this.targetId = page.id;
				this.ownedTabs.add(page.id);
				return page.webSocketDebuggerUrl;
			}
			const created = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(2000) })).json()) as { id: string; webSocketDebuggerUrl?: string };
			this.targetId = created.id;
			this.ownedTabs.add(created.id);
			return created.webSocketDebuggerUrl;
		} catch {
			return undefined;
		}
	}

	private async connect(): Promise<void> {
		if (typeof WebSocket === 'undefined') {
			throw new Error('This editor runs an older Node.js without WebSocket support; the browser agent needs VS Code 1.90+.');
		}
		fs.mkdirSync(this.profileDir, { recursive: true });
		// Reuse a browser this profile already has open.
		let port = await this.readPort();
		let wsUrl = port ? await this.pageSocketUrl(port) : undefined;
		if (!wsUrl) {
			const exe = findBrowser(this.options().path);
			if (!exe) {
				throw new Error('No Chrome, Edge or Brave installation found. Set the browser path in Settings → Browser use.');
			}
			try {
				fs.rmSync(path.join(this.profileDir, 'DevToolsActivePort'), { force: true });
			} catch {
				// stale file is fine
			}
			const args = [
				'--remote-debugging-port=0',
				`--user-data-dir=${this.profileDir}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--no-startup-window',
				'--disable-features=Translate,MediaRouter',
				'--window-size=1280,900',
				...(this.options().headless ? ['--headless=new'] : [])
			];
			this.proc = spawn(exe, args, { stdio: 'ignore', detached: false });
			this.proc.on('exit', () => (this.proc = undefined));
			// A browser's first start on a slow disk can take most of a minute.
			for (let i = 0; i < 240 && !wsUrl; i++) {
				await sleep(250);
				port = await this.readPort();
				wsUrl = port ? await this.pageSocketUrl(port) : undefined;
			}
			if (!wsUrl) {
				this.proc?.kill();
				throw new Error(`Launched ${path.basename(exe)} but could not connect to it over DevTools.`);
			}
		}
		this.port = port;
		await this.attach(wsUrl);
	}

	/** Attach to one page target and turn on what the tools need. */
	private async attach(wsUrl: string): Promise<void> {
		this.contexts.clear();
		this.parents.clear();
		this.refs.clear();
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(wsUrl as string);
			const timer = setTimeout(() => reject(new Error('Timed out connecting to the browser.')), 8000);
			ws.onopen = () => {
				clearTimeout(timer);
				this.ws = ws;
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error('Could not connect to the browser DevTools socket.'));
			};
			ws.onclose = () => {
				if (this.ws === ws) {
					this.ws = undefined;
					this.rejectPending('The browser page was closed.');
				}
			};
			ws.onmessage = (event) => { if (this.ws === ws) this.onMessage(String(event.data)); };
		});
		await this.send('Page.enable');
		const tree = await this.send('Page.getFrameTree');
		this.mainFrame = tree.frameTree.frame.id;
		this.rememberFrames(tree.frameTree);
		await this.send('Runtime.enable');
		await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
		await this.send('Network.enable', { maxTotalBufferSize: 0 }).catch(() => undefined);
		// New tabs (target=_blank, window.open) are reported so the agent can switch to them.
		await this.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined);
		await this.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
		await this.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY });
		await this.eval(OVERLAY).catch(() => undefined);
	}

	private onMessage(raw: string): void {
		let msg: any;
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id === 'number') {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				clearTimeout(p.timer);
				msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
			}
			return;
		}
		const session = msg.sessionId as string | undefined;
		if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'iframe') {
			const child = msg.params.sessionId;
			const setup = (async () => {
				await this.send('Page.enable', {}, 5000, child);
				this.rememberFrames((await this.send('Page.getFrameTree', {}, 5000, child)).frameTree);
				await this.send('Runtime.enable', {}, 5000, child);
				await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, 5000, child);
			})().catch(e => { this.log(`[frame unavailable] ${String(e)}`); });
			this.frameSetup.add(setup);
			void setup.finally(() => this.frameSetup.delete(setup));
			return;
		}
		if (msg.method === 'Runtime.executionContextCreated') {
			const c = msg.params.context;
			if (c.auxData?.isDefault && c.auxData.frameId) this.contexts.set(`${session || ''}:${c.id}`, { id: c.id, frame: c.auxData.frameId, session });
		} else if (msg.method === 'Runtime.executionContextDestroyed' || msg.method === 'Runtime.executionContextsCleared' || msg.method === 'Target.detachedFromTarget') {
			const removedSession = msg.method === 'Target.detachedFromTarget' ? msg.params.sessionId : session;
			for (const [key, c] of this.contexts) {
				if (c.session === removedSession && (msg.method !== 'Runtime.executionContextDestroyed' || c.id === msg.params.executionContextId)) {
					this.contexts.delete(key);
					for (const [ref, owner] of this.refs) if (owner === c) this.refs.delete(ref);
				}
			}
		} else if (msg.method === 'Page.frameAttached') {
			this.parents.set(msg.params.frameId, msg.params.parentFrameId);
		} else if (msg.method === 'Page.frameNavigated' && msg.params.frame.parentId) {
			this.parents.set(msg.params.frame.id, msg.params.frame.parentId);
		}
		if (msg.method === 'Runtime.consoleAPICalled') {
			const text = (msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ');
			this.log(`[console.${msg.params.type}] ${text}`);
		} else if (msg.method === 'Runtime.exceptionThrown') {
			const d = msg.params.exceptionDetails;
			this.log(`[uncaught] ${d?.exception?.description ?? d?.text ?? 'exception'}`);
		} else if (msg.method === 'Page.frameNavigated' && !msg.params.frame.parentId) {
			this.log(`[navigated] ${msg.params.frame.url}`);
		} else if (msg.method === 'Page.javascriptDialogOpening') {
			// alert / confirm / prompt would block every later command: accept and report it.
			const p = msg.params;
			this.log(`[dialog ${p.type}] ${String(p.message).slice(0, 300)} → accepted`);
			void this.send('Page.handleJavaScriptDialog', { accept: true, promptText: p.defaultPrompt ?? '' }).catch(() => undefined);
		} else if (msg.method === 'Network.requestWillBeSent') {
			const r = msg.params.request;
			if (this.requests.size > 400) {
				this.requests.clear();
			}
			this.requests.set(msg.params.requestId, { method: r.method, url: r.url });
		} else if (msg.method === 'Network.responseReceived') {
			const req = this.requests.get(msg.params.requestId);
			const res = msg.params.response;
			if (req && !/^data:/.test(req.url)) {
				this.netLog(`${res.status >= 400 ? '✗' : '·'} ${res.status} ${req.method} ${req.url.slice(0, 200)} (${msg.params.type ?? ''})`);
			}
		} else if (msg.method === 'Network.loadingFailed') {
			const req = this.requests.get(msg.params.requestId);
			if (req && !msg.params.canceled) {
				this.netLog(`✗ FAILED ${req.method} ${req.url.slice(0, 200)} — ${msg.params.errorText}`);
			}
		} else if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page' && msg.params.targetInfo.openerId) {
			if (this.ownedTabs.has(msg.params.targetInfo.openerId)) this.ownedTabs.add(msg.params.targetInfo.targetId);
			if (msg.params.targetInfo.openerId === this.targetId) {
				this.openedTab = msg.params.targetInfo.targetId;
			}
			this.log(`[new tab] ${msg.params.targetInfo.url || 'about:blank'}`);
		}
	}

	private netLog(line: string): void {
		this.net.push(line);
		if (this.net.length > 300) {
			this.net.splice(0, this.net.length - 300);
		}
	}

	private log(line: string): void {
		this.logs.push(line.slice(0, 500));
		if (this.logs.length > 200) {
			this.logs.splice(0, this.logs.length - 200);
		}
	}

	private rejectPending(message: string): void {
		for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); }
		this.pending.clear();
	}

	private rememberFrames(tree: any): void {
		if (tree.frame.parentId) this.parents.set(tree.frame.id, tree.frame.parentId);
		for (const child of tree.childFrames || []) {
			this.parents.set(child.frame.id, tree.frame.id);
			this.rememberFrames(child);
		}
	}

	private send(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000, sessionId?: string): Promise<any> {
		const ws = this.ws;
		if (!ws || ws.readyState !== 1) {
			return Promise.reject(new Error('The browser is not connected.'));
		}
		const id = ++this.seq;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Browser command ${method} timed out.`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try { ws.send(JSON.stringify({ id, method, params, sessionId })); }
			catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
		});
	}

	private async eval<T = any>(expression: string, awaitPromise = false, context?: FrameContext): Promise<T> {
		const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, ...(context ? { contextId: context.id } : {}), timeout: 10_000 }, 15_000, context?.session);
		if (res.exceptionDetails) {
			throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Script error');
		}
		return res.result?.value as T;
	}

	private async settle(maxMs = 15_000): Promise<void> {
		const start = Date.now();
		await sleep(150);
		while (Date.now() - start < maxMs) {
			const state = await this.eval<string>('document.readyState').catch(() => 'loading');
			if (state === 'complete') {
				break;
			}
			await sleep(200);
		}
		await sleep(350); // let client-side rendering catch up
		await this.eval(OVERLAY).catch(() => undefined);
	}

	// ------------------------------------------------------------ actions

	async snapshot(withImage = true): Promise<BrowserSnapshot> {
		await this.ensure();
		if (this.batching) return { url: '', title: '', text: '', elements: '', scroll: '' };
		await Promise.all([...this.frameSetup]);
		const frames = [...this.contexts.values()].sort((a, b) => Number(b.frame === this.mainFrame) - Number(a.frame === this.mainFrame));
		const snap: BrowserSnapshot = { url: '', title: '', text: '', elements: '', scroll: '', warnings: [] };
		let count = 0;
		for (const frame of frames.slice(0, 32)) {
			if (count >= 200) { snap.warnings!.push('Element limit reached; scroll or inspect a smaller region.'); break; }
			try {
				const part = await this.eval<BrowserSnapshot & { refs: number[]; next: number; truncated: boolean }>(snapshotScript(this.nextRef, 200 - count), false, frame);
				this.nextRef = Math.max(this.nextRef, part.next);
				for (const ref of part.refs) this.refs.set(ref, frame);
				count += part.refs.length;
				if (frame.frame === this.mainFrame) Object.assign(snap, { url: part.url, title: part.title, scroll: part.scroll });
				const heading = frame.frame === this.mainFrame ? '' : `\nFrame: ${part.url}\n`;
				snap.elements += heading + part.elements + '\n';
				snap.text = (snap.text + heading + part.text + '\n').slice(0, 8000);
				if (part.truncated) snap.warnings!.push(`Snapshot truncated in ${part.url}.`);
			} catch { snap.warnings!.push('A frame changed or could not be inspected; refresh the snapshot before acting there.'); }
		}
		if (!snap.url) throw new Error('The page changed while taking its snapshot. Retry browser_snapshot.');
		if (frames.length > 32) snap.warnings!.push('Only the first 32 frames were inspected.');
		if (withImage) {
			await this.eval('window.__zer0ne && window.__zer0ne.hide()').catch(() => undefined);
			try {
				const full = await this.send('Page.captureScreenshot', { format: 'jpeg', quality: 70, optimizeForSpeed: true });
				snap.screenshot = full.data;
				const metrics = await this.send('Page.getLayoutMetrics');
				const vp = metrics.cssVisualViewport ?? metrics.visualViewport;
				const thumb = await this.send('Page.captureScreenshot', {
					format: 'jpeg',
					quality: 55,
					clip: { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: Math.min(1, 480 / Math.max(1, vp.clientWidth)) }
				});
				snap.thumbnail = 'data:image/jpeg;base64,' + thumb.data;
			} finally {
				await this.eval('window.__zer0ne && window.__zer0ne.show()').catch(() => undefined);
			}
		}
		this.preview = { url: snap.url, title: snap.title, thumbnail: snap.thumbnail, at: Date.now() };
		return snap;
	}

	async navigate(rawUrl: string): Promise<BrowserSnapshot> {
		await this.ensure();
		let url = rawUrl.trim();
		// "localhost:3000" has a colon but no scheme.
		if (!/^[a-z][\w+.-]*:\/\//i.test(url) && !/^(about|file):/i.test(url)) {
			url = (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)(:|\/|$)/.test(url) ? 'http://' : 'https://') + url;
		}
		if (!/^(https?|file|about):/i.test(url)) {
			throw new Error('Only http(s), file and about: URLs can be opened.');
		}
		const res = await this.send('Page.navigate', { url });
		if (res.errorText) {
			throw new Error(`Navigation failed: ${res.errorText} (${url})`);
		}
		await this.settle();
		await this.status('Opened ' + url.replace(/^https?:\/\//, '').slice(0, 60));
		return this.snapshot();
	}

	private refContext(ref: number): FrameContext {
		nodeExpression(ref);
		const context = this.refs.get(ref);
		if (!context || ![...this.contexts.values()].includes(context)) throw new Error(`Stale element [${ref}]. Take a new browser_snapshot.`);
		return context;
	}

	private async pointOf(ref: number): Promise<{ x: number; y: number; name?: string }> {
		let context = this.refContext(ref);
		const pt = await this.eval<{ x: number; y: number; name?: string }>(pointScript(ref), false, context);
		const seen = new Set<string>();
		while (context.frame !== this.mainFrame) {
			if (seen.has(context.frame)) throw new Error('Frame hierarchy changed. Take a new snapshot.');
			seen.add(context.frame);
			const parent = [...this.contexts.values()].find(c => c.frame === this.parents.get(context.frame));
			if (!parent) throw new Error('Frame parent unavailable. Take a new snapshot.');
			const owner = await this.send('DOM.getFrameOwner', { frameId: context.frame }, 5000, parent.session);
			const resolved = await this.send('DOM.resolveNode', { backendNodeId: owner.backendNodeId, executionContextId: parent.id }, 5000, parent.session);
			try {
				const result = await this.send('Runtime.callFunctionOn', {
					objectId: resolved.object.objectId, returnByValue: true,
					functionDeclaration: `function(x,y) {
						this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
						const r=this.getBoundingClientRect();
						for (let node=this; node; node=node.parentElement || node.getRootNode()?.host) {
							if (getComputedStyle(node).transform !== 'none') throw new Error('Transformed iframe: use a visual coordinate action.');
						}
						if (Math.abs(r.width-this.offsetWidth)>1 || Math.abs(r.height-this.offsetHeight)>1) throw new Error('Scaled iframe: use a visual coordinate action.');
						const px=r.left+this.clientLeft+x, py=r.top+this.clientTop+y;
						if (px < r.left || px >= r.right || py < r.top || py >= r.bottom || this.getRootNode().elementFromPoint(px,py) !== this) throw new Error('The iframe is clipped or covered.');
						return {x:px,y:py};
					}`, arguments: [{value:pt.x},{value:pt.y}]
				}, 5000, parent.session);
				if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Frame is not actionable.');
				Object.assign(pt, result.result.value);
			} finally { await this.send('Runtime.releaseObject', { objectId: resolved.object.objectId }, 5000, parent.session).catch(() => undefined); }
			context = parent;
		}
		return pt;
	}

	/** What the agent is doing, shown in the page's pill (the user watches the browser). */
	private async status(text: string): Promise<void> {
		await this.eval(`window.__zer0ne && window.__zer0ne.say && window.__zer0ne.say(${JSON.stringify('zer0ne · ' + text)})`).catch(() => undefined);
	}

	private async clickAt(x: number, y: number, ref?: number): Promise<void> {
		await this.eval(`window.__zer0ne && window.__zer0ne.move(${x}, ${y})`).catch(() => undefined);
		if (!this.batching && !this.options().headless) await sleep(420);
		await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
		// Moving the pointer can close hover menus and shift the layout: aim again.
		if (ref !== undefined) {
			await sleep(120);
			const again = await this.pointOf(ref);
			if (again && (again.x !== x || again.y !== y)) {
				x = again.x;
				y = again.y;
				await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
			}
		}
		await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
		await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
		await this.eval(`window.__zer0ne && window.__zer0ne.ripple(${x}, ${y})`).catch(() => undefined);
	}

	async click(target: { ref?: number; x?: number; y?: number }): Promise<BrowserSnapshot> {
		await this.ensure();
		const pt = typeof target.ref === 'number' ? await this.pointOf(target.ref) : { x: Number(target.x), y: Number(target.y) };
		if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
			throw new Error('Give a ref from the last snapshot (or x/y viewport coordinates).');
		}
		this.openedTab = undefined;
		await this.status(`Clicking “${'name' in pt && pt.name ? pt.name : pt.x + ',' + pt.y}”`);
		await this.clickAt(pt.x, pt.y, typeof target.ref === 'number' ? target.ref : undefined);
		await this.settle(8000);
		// The click opened a new tab: follow it, as a person would.
		if (this.openedTab && this.port) {
			const id = this.openedTab;
			this.openedTab = undefined;
			await sleep(300);
			const t = (await this.targets(this.port).catch(() => [])).find((x) => x.id === id && x.webSocketDebuggerUrl);
			if (t) {
				await this.switchTo(t.id, t.webSocketDebuggerUrl as string);
				await this.settle(8000);
				this.log(`[switched to new tab] ${t.url}`);
			}
		}
		return this.snapshot();
	}

	async type(ref: number, text: string, opts: { submit?: boolean; clear?: boolean }): Promise<BrowserSnapshot> {
		await this.ensure();
		const pt = await this.pointOf(ref);
		await this.status(`Typing into “${pt.name ?? 'field'}”`);
		await this.clickAt(pt.x, pt.y, ref);
		if (opts.clear !== false) {
			await this.eval(`(() => { const el = ${nodeExpression(ref)}; if (!el) return; el.focus(); if ('value' in el) { el.select && el.select(); } else { document.execCommand('selectAll'); } })()`, false, this.refContext(ref));
		}
		// Short text is typed key by key so the user sees it happen; long text at once.
		if (text.length <= 80 && !this.batching && !this.options().headless) {
			for (const ch of text) {
				await this.send('Input.insertText', { text: ch });
				await sleep(28);
			}
		} else {
			await this.send('Input.insertText', { text });
		}
		if (opts.submit) {
			await this.press('Enter', false);
		}
		await this.settle(opts.submit ? 10_000 : 1500);
		return this.snapshot();
	}

	async press(combo: string, snapshot = true): Promise<BrowserSnapshot | undefined> {
		await this.ensure();
		const parts = combo.length > 1 ? combo.split('+').map((p) => p.trim()).filter(Boolean) : [combo];
		const key = parts.pop() || combo;
		const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
		let modifiers = 0;
		for (const m of parts) {
			const bit = MODS[m.toLowerCase()];
			if (!bit) {
				throw new Error(`Unknown modifier "${m}". Use Control, Shift, Alt or Meta (e.g. "Control+a").`);
			}
			modifiers |= bit;
		}
		const k = KEYS[key] ?? (key.length === 1 ? { code: /\d/.test(key) ? 'Digit' + key : 'Key' + key.toUpperCase(), vk: key.toUpperCase().charCodeAt(0), text: key } : undefined);
		if (!k) {
			throw new Error(`Unsupported key "${key}". Use one of: ${Object.keys(KEYS).join(', ')} or a single character, optionally with modifiers ("Control+a", "Shift+Tab").`);
		}
		// With Control/Alt/Meta held, no text is typed (the shortcut runs instead).
		const text = modifiers & 7 ? undefined : k.text;
		const base = { key: key === 'Space' ? ' ' : key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
		await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
		await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
		if (!snapshot) {
			return undefined;
		}
		await this.settle(5000);
		return this.snapshot();
	}

	async scroll(direction: 'up' | 'down', amount = 0.8): Promise<BrowserSnapshot> {
		await this.ensure();
		const sign = direction === 'up' ? -1 : 1;
		await this.status(`Scrolling ${direction}`);
		await this.eval(`window.scrollBy({ top: ${sign} * innerHeight * ${Math.min(3, Math.max(0.1, amount))}, behavior: 'smooth' })`);
		await sleep(650);
		return this.snapshot();
	}

	async back(): Promise<BrowserSnapshot> {
		await this.ensure();
		await this.eval('history.back()');
		await this.settle();
		return this.snapshot();
	}

	async forward(): Promise<BrowserSnapshot> {
		await this.ensure();
		await this.eval('history.forward()');
		await this.settle();
		return this.snapshot();
	}

	async reload(): Promise<BrowserSnapshot> {
		await this.ensure();
		await this.status('Reloading');
		await this.send('Page.reload', { ignoreCache: true });
		await this.settle();
		return this.snapshot();
	}

	/** Move the pointer over an element (menus, tooltips, hover states). */
	async hover(ref: number): Promise<BrowserSnapshot> {
		await this.ensure();
		const pt = await this.pointOf(ref);
		await this.status(`Hovering “${pt.name ?? ''}”`);
		await this.eval(`window.__zer0ne && window.__zer0ne.move(${pt.x}, ${pt.y})`).catch(() => undefined);
		await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
		await sleep(500);
		return this.snapshot();
	}

	/** Pick an option in a <select> by its value or visible label. */
	async select(ref: number, value: string): Promise<BrowserSnapshot> {
		await this.ensure();
		await this.pointOf(ref);
		const picked = await this.eval<string | null>(`(() => {
			const el = ${nodeExpression(ref)};
			if (!el || el.tagName !== 'SELECT') return 'NOT_SELECT';
			const want = ${JSON.stringify(String(value))}.trim().toLowerCase();
			const opt = [...el.options].find((o) => o.value.toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase() === want) || [...el.options].find((o) => o.text.trim().toLowerCase().includes(want));
			if (!opt) return null;
			el.value = opt.value;
			el.dispatchEvent(new Event('input', { bubbles: true }));
			el.dispatchEvent(new Event('change', { bubbles: true }));
			return opt.text.trim();
		})()`, false, this.refContext(ref));
		if (picked === 'NOT_SELECT') {
			throw new Error(`[${ref}] is not a <select>. For custom dropdowns, click it and then click the option.`);
		}
		if (picked === null) {
			throw new Error(`No option matching "${value}" in [${ref}].`);
		}
		await this.settle(3000);
		return this.snapshot();
	}

	/** Wait until text appears (or disappears), or just wait a few seconds. */
	async waitFor(opts: { text?: string; gone?: string; seconds?: number }, signal?: AbortSignal): Promise<BrowserSnapshot> {
		await this.ensure();
		const limit = Date.now() + Math.min(60, Math.max(0.5, opts.seconds ?? (opts.text || opts.gone ? 15 : 2))) * 1000;
		if (!opts.text && !opts.gone) {
			await sleep(limit - Date.now());
			return this.snapshot();
		}
		for (;;) {
			signal?.throwIfAborted();
			const body = (await Promise.all([...this.contexts.values()].slice(0, 32).map(c => this.eval<{text:string}>(snapshotScript(this.nextRef, 0), false, c).then(s => s.text).catch(() => '')))).join('\n');
			const ok = (!opts.text || body.includes(opts.text)) && (!opts.gone || !body.includes(opts.gone));
			if (ok) {
				break;
			}
			if (Date.now() > limit) {
				throw new Error(opts.text ? `"${opts.text}" did not appear within the time limit.` : `"${opts.gone}" was still on the page.`);
			}
			await sleep(300);
		}
		await sleep(200);
		return this.snapshot();
	}

	/** Emulate a phone / tablet / custom viewport (or back to the window size). */
	async resize(opts: { preset?: 'mobile' | 'tablet' | 'desktop'; width?: number; height?: number }): Promise<BrowserSnapshot> {
		await this.ensure();
		const size = opts.preset === 'mobile' ? { width: 390, height: 844, mobile: true } : opts.preset === 'tablet' ? { width: 820, height: 1180, mobile: true } : opts.width && opts.height ? { width: Math.round(opts.width), height: Math.round(opts.height), mobile: opts.width < 768 } : { width: 0, height: 0, mobile: false };
		await this.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: size.mobile ? 2 : 1 });
		await this.send('Emulation.setTouchEmulationEnabled', { enabled: size.mobile, maxTouchPoints: size.mobile ? 5 : 0 }).catch(() => undefined);
		await sleep(400);
		return this.snapshot();
	}

	/** List / switch to / open / close tabs of the agent browser. */
	async tabs(action: 'list' | 'select' | 'new' | 'close', index?: number, url?: string): Promise<string | BrowserSnapshot> {
		await this.ensure();
		const port = this.port ?? (await this.readPort());
		if (!port) {
			throw new Error('The browser is not running.');
		}
		const list = (await this.targets(port)).filter(t => this.ownedTabs.has(t.id));
		if (action === 'list') {
			return list.map((t, i) => `[${i}] ${t.id === this.targetId ? '(current) ' : ''}${t.title || '(untitled)'} — ${t.url}`).join('\n') || '(no tabs)';
		}
		if (action === 'new') {
			const created = (await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT', signal: AbortSignal.timeout(2000) })).json()) as { id: string; webSocketDebuggerUrl: string };
			this.ownedTabs.add(created.id);
			await this.switchTo(created.id, created.webSocketDebuggerUrl);
			return url ? this.navigate(url) : this.snapshot();
		}
		const t = list[index ?? -1];
		if (!t) {
			throw new Error(`No tab [${index}]. Call browser_tabs with action "list" first.`);
		}
		if (action === 'close') {
			await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
			this.ownedTabs.delete(t.id);
			if (t.id === this.targetId) {
				this.ws?.close();
				this.ws = undefined;
				const rest = list.filter((x) => x.id !== t.id && x.webSocketDebuggerUrl);
				if (rest[0]) {
					await this.switchTo(rest[0].id, rest[0].webSocketDebuggerUrl as string);
				}
			}
			return `Closed tab [${index}].`;
		}
		if (!t.webSocketDebuggerUrl) {
			throw new Error('That tab is already attached to another debugger.');
		}
		await this.switchTo(t.id, t.webSocketDebuggerUrl);
		await fetch(`http://127.0.0.1:${port}/json/activate/${t.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
		await this.settle(3000);
		return this.snapshot();
	}

	private async switchTo(id: string, wsUrl: string): Promise<void> {
		const old = this.ws;
		this.ws = undefined;
		this.rejectPending('Switched browser tab.');
		try {
			old?.close();
		} catch {
			// already closed
		}
		this.targetId = id;
		await this.attach(wsUrl);
	}

	/** Recent network responses; failures (4xx/5xx, blocked, DNS) first when `failedOnly`. */
	networkLog(failedOnly: boolean, clear: boolean): string {
		const lines = failedOnly ? this.net.filter((l) => l.startsWith('✗')) : this.net.slice(-120);
		if (clear) {
			this.net = [];
		}
		return lines.join('\n') || (failedOnly ? 'No failed requests.' : 'No requests captured yet.');
	}

	async evaluate(expression: string): Promise<string> {
		await this.ensure();
		const value = await this.eval(`(async () => { return (${expression}); })()`, true);
		const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
		return text === undefined ? 'undefined' : text;
	}

	async batch(raw: unknown, signal?: AbortSignal, withImage = true): Promise<{ completed: number; snapshot?: BrowserSnapshot; error?: string }> {
		const steps = browserSteps(raw);
		if (this.batching) throw new Error('A browser batch is already running.');
		signal?.throwIfAborted();
		await this.ensure();
		this.batching = true;
		let completed = 0, error: string | undefined;
		const deadline = Date.now() + 120_000;
		try {
			for (const step of steps) {
				signal?.throwIfAborted();
				if (Date.now() > deadline) throw new Error('Browser batch time limit reached.');
				switch (step.action) {
					case 'click': await this.click({ ref: step.ref }); break;
					case 'hover': await this.hover(step.ref); break;
					case 'type': await this.type(step.ref, step.text, step); break;
					case 'select': await this.select(step.ref, step.value); break;
					case 'press': await this.press(step.key, false); break;
					case 'wait_for': await this.waitFor(step, signal); break;
				}
				completed++;
			}
		} catch (e) { error = String(e instanceof Error ? e.message : e); }
		finally { this.batching = false; }
		if (signal?.aborted) return { completed, error: error || 'Browser batch cancelled.' };
		try { return { completed, error, snapshot: await this.snapshot(withImage) }; }
		catch (e) { return { completed, error: [error, `Final snapshot failed: ${String(e)}`].filter(Boolean).join('\n') }; }
	}

	consoleLogs(clear: boolean): string {
		const out = this.logs.join('\n');
		if (clear) {
			this.logs = [];
		}
		return out;
	}

	async close(terminateOwnedProcess = false): Promise<void> {
		const owned = terminateOwnedProcess ? this.proc : undefined;
		// Only isolated regression profiles opt in: ordinary browsers may contain user-created tabs.
		if (owned && owned.exitCode === null) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(done,5000);
				function done() { clearTimeout(timer); owned!.removeListener('close',done); resolve(); }
				owned.once('close',done); killTree(owned);
			});
		} else if (this.port) {
			const targets = await this.targets(this.port).catch(() => []);
			if (targets.length && targets.every(t => this.ownedTabs.has(t.id)) && this.active) {
				await this.send('Browser.close', {}, 3000).catch(() => undefined);
			} else {
				for (const tab of targets.filter(t => this.ownedTabs.has(t.id))) {
					await fetch(`http://127.0.0.1:${this.port}/json/close/${tab.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
				}
			}
		}
		try {
			this.ws?.close();
		} catch {
			// ignore
		}
		this.ws = undefined;
		this.rejectPending('Browser closed.');
		this.contexts.clear();
		this.refs.clear();
		this.ownedTabs.clear();
		this.proc?.unref();
		this.proc = undefined;
	}
}

/** Format a snapshot as tool output text. */
export function describeSnapshot(s: BrowserSnapshot, textChars = 2500): string {
	return [
		`URL: ${s.url}`,
		`Title: ${s.title || '(untitled)'}`,
		`Scroll: ${s.scroll}`,
		'',
		'Interactive elements in view (use the [ref] number with browser_click / browser_type):',
		s.elements || '(none)',
		'',
		'Visible text:',
		s.text.slice(0, textChars) || '(none)',
		...(s.warnings || []).map(w => 'Note: ' + w)
	].join('\n');
}
