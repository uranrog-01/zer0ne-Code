import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { constants as zlibConstants, createGzip } from 'zlib';
import { qrSvg } from './qr';
import { CHAT_BODY } from './webviewMarkup';
import { BROWSER_PROTOCOL, CommandLedger, EventReplay, RECEIPTED_COMMANDS, type CommandReceipt } from './commandLedger';

/**
 * Mobile Remote: serves the same chat UI to a phone on the local network.
 * The phone gets live state/streaming over Server-Sent Events and posts
 * the same UI messages the webview does, so everything (chat, approvals,
 * stop, model switch, settings) works from the phone.
 *
 * Access requires a random token (in the QR/URL); a phone that pairs once
 * keeps a device session, so it survives restarts and can be revoked alone.
 */

/** One paired phone. The token is a per-device secret, never the link token. */
export interface RemoteDevice {
	id: string;
	token: string;
	name: string;
	ip: string;
	created: number;
	seen: number;
}

/** What Settings shows: no tokens. */
export interface RemoteDeviceView {
	id: string;
	name: string;
	ip: string;
	created: number;
	seen: number;
}

export interface RemoteHooks {
	mcpApp?(key: string): string | undefined;
	attach(post: (message: Record<string, unknown>) => void): { dispose(): void; handle(msg: Record<string, unknown>): Promise<void> };
	token(): string;
	changed?(): void;
	preview?(id: string): string | undefined;
	/** Addresses that work from outside the Wi-Fi (secure link, Tailscale), best first. */
	publicBases?(): string[];
	/** Approve or reject the pending request behind a notification action; false when it is gone. */
	decide?(id: string, approve: boolean): boolean | Promise<boolean>;
	/** Paired phones, persisted by the host so a phone stays paired across restarts. */
	devices?: { list(): RemoteDevice[]; save(list: RemoteDevice[]): void };
}

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
/** Messages that only make sense on the desktop are ignored from the phone. */
const DESKTOP_ONLY = new Set(['pickAttachment', 'micStart', 'micStop', 'openFile', 'modelfit']);
/** Local models is Models Fit Studio's own page (media/modelfit), framed by Settings on the desktop. */
const MODELFIT_TYPES: Record<string, string> = { ...TYPES, '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

/** Failed-token lockout and a message budget per client address. */
const FAIL_LIMIT = 10;
const FAIL_WINDOW = 10 * 60_000;
const LOCKOUT = 15 * 60_000;
const MSG_BURST = 40;
const MSG_REFILL_PER_SEC = 4;
const COOKIE = 'zr';
/** Wrong pairing codes from all clients together before the code is voided (a public link can be probed from many addresses). */
const PAIR_GLOBAL_LIMIT = 30;
/** How long an Approve/Reject link in a notification stays valid. */
const ACTION_TTL = 15 * 60_000;
/** Paired phones kept; the oldest is dropped past this. */
const MAX_DEVICES = 20;

export function newRemoteToken(): string {
	return randomBytes(18).toString('base64url');
}

export function lanAddresses(): string[] {
	const out: string[] = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list ?? []) {
			if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
				out.push(a.address);
			}
		}
	}
	// Private LAN ranges first (192.168 → 10 → 172).
	return out.sort((a, b) => rank(a) - rank(b));
	function rank(ip: string) {
		return ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
	}
}

/** "iPhone · Safari", "Android · Chrome" — enough to tell two phones apart, no fingerprinting. */
export function deviceName(userAgent: string | undefined): string {
	const ua = String(userAgent ?? '');
	const device = /iPhone/i.test(ua) ? 'iPhone' : /iPad/i.test(ua) ? 'iPad' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Macintosh|Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Phone';
	const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Chrome\/|CriOS/i.test(ua) ? 'Chrome' : /Firefox\/|FxiOS/i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
	return device + ' · ' + browser;
}

/** The pairing page: scan the QR again, or type the 6-digit code from Settings. */
function pairPage(nonce: string): string {
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08080a"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon.png"><title>Connect this phone · zer0ne</title>
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:22px;background:radial-gradient(120% 80% at 50% -10%,#1c2430,#0b0d11 55%,#07080a);color:#eef2f6;font:15px/1.55 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;-webkit-tap-highlight-color:transparent}
main{width:min(372px,100%);text-align:center}
.logo{width:58px;height:58px;border-radius:16px;box-shadow:0 18px 40px -18px #f7931e;background:url(/icon.png) center/contain no-repeat}
h1{margin:18px 0 6px;font-size:21px;font-weight:600;letter-spacing:-.02em}
p{margin:0 auto 22px;max-width:30ch;color:#98a4b3;font-size:13.5px}
.code{display:flex;gap:8px;justify-content:center;margin-bottom:14px}
input{width:100%;padding:15px 14px;border-radius:14px;border:1px solid #2a3038;background:#111418;color:#fff;font:600 27px/1 ui-monospace,Menlo,monospace;letter-spacing:.42em;text-align:center;outline:none;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:#3c4552;letter-spacing:.3em}
input:focus{border-color:#f7931e;box-shadow:0 0 0 3px rgba(247,147,30,.16)}
button{width:100%;margin-top:4px;padding:14px;border:0;border-radius:14px;background:#f7931e;color:#161209;font-weight:650;font-size:15px;cursor:pointer;transition:filter .15s,opacity .15s}
button:disabled{opacity:.45;cursor:default}
button:active{filter:brightness(.94)}
.err{min-height:20px;margin-top:12px;color:#f87171;font-size:13px}
.tip{margin-top:26px;padding:12px 14px;border:1px solid #23282f;border-radius:12px;background:#0e1115;color:#7d8896;font-size:12px;line-height:1.6;text-align:left}
.tip b{color:#c9d2dc;font-weight:600}
</style></head><body><main>
<div class="logo" role="img" aria-label="zer0ne"></div>
<h1>Connect this phone</h1>
<p>Scan the QR code in zer0ne → Settings → <b>Mobile remote</b>, or type the 6-digit code shown there.</p>
<div class="code"><input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="Pairing code" autofocus></div>
<button id="go" disabled>Connect</button>
<div class="err" id="e" role="status"></div>
<div class="tip">No app to install. Make it feel like one: <b>iPhone</b> Share → Add to Home Screen · <b>Android</b> ⋮ → Add to Home screen. Only this phone gets access; you can revoke it in zer0ne at any time.</div>
</main><script nonce="${nonce}">
const c=document.getElementById('c'),e=document.getElementById('e'),go=document.getElementById('go');
const set=()=>{go.disabled=c.value.length!==6;};
async function pair(){
  if(c.value.length!==6)return;
  e.textContent='';go.disabled=true;go.textContent='Connecting…';
  const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c.value.trim()})}).catch(()=>null);
  if(r&&r.ok){location.replace('/');return;}
  go.textContent='Connect';
  e.textContent=r&&r.status===429?'Too many tries — wait a few minutes.':'That code is wrong or expired — make a new one in zer0ne.';
  c.select();set();
}
go.onclick=pair;
c.oninput=()=>{c.value=c.value.replace(/\\D/g,'');set();if(c.value.length===6)pair();};
c.onkeydown=(ev)=>{if(ev.key==='Enter')pair();};
</script></body></html>`;
}

export class RemoteServer {
	private replay = new EventReplay();
	private ledger?: CommandLedger;
	private readonly disconnects = new Map<string, ReturnType<typeof setTimeout>>();
	private latestState?: Record<string, unknown>;
	private readonly inFlight = new Map<string, { scope: string; receipt: CommandReceipt }>();
	private server?: http.Server;
	private port = 0;
	/** One entry per open event stream; gzip keeps long chats light on mobile data. */
	private readonly streams = new Map<http.ServerResponse, { out: NodeJS.WritableStream; device?: string; modern: boolean }>();
	private readonly pendingMessages = new Map<http.IncomingMessage, { response: http.ServerResponse; device?: string }>();
	private surface?: ReturnType<RemoteHooks['attach']>;
	lastError?: string;

	private readonly failures = new Map<string, { count: number; since: number; lockedUntil?: number }>();
	/** 6-digit pairing code for phones that lost the link (home-screen apps keep their own cookies). */
	private pair?: { code: string; until: number };

	/** A fresh code, valid for 10 minutes. */
	newPairCode(): string {
		this.pairFails = 0;
		this.pair = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), until: Date.now() + 10 * 60_000 };
		return this.pair.code;
	}
	private readonly buckets = new Map<string, { tokens: number; at: number }>();

	/**
	 * `desktop`: the zer0ne desktop app hosts its window through this server —
	 * bound to 127.0.0.1 only, the full UI (not the phone layout), desktop-only
	 * messages allowed.
	 */
	constructor(
		private readonly mediaDir: string,
		private readonly hooks: RemoteHooks,
		private readonly opts: { desktop?: boolean; desktopHost?: boolean; commandDir?: string } = {}
	) { if (opts.commandDir) this.ledger = new CommandLedger(opts.commandDir, this.replay.epoch); }

	private pairFails = 0;
	private commandScope(device?: RemoteDevice): string { return this.opts.desktop ? 'desktop' : device?.id ?? this.hooks.token(); }

	/**
	 * The phone's address. Behind the secure link every request arrives from
	 * 127.0.0.1 (cloudflared), so the address Cloudflare saw is used instead —
	 * otherwise one bad client would lock everyone out.
	 */
	private clientIp(req: http.IncomingMessage): string {
		const direct = req.socket.remoteAddress ?? '?';
		const cf = req.headers['cf-connecting-ip'];
		return /^(127\.|::1$|::ffff:127\.)/.test(direct) && typeof cf === 'string' && cf ? 'cf:' + cf.slice(0, 64) : direct;
	}

	/** Cookie flags: Secure when the page came over HTTPS (the secure link). */
	private cookie(req: http.IncomingMessage, token: string): string {
		const https = req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(String(req.headers['cf-visitor'] ?? ''));
		return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${https ? '; Secure' : ''}`;
	}

	/* ---------------------------------------------------------------- paired phones */

	private deviceCache?: RemoteDevice[];

	private devices(): RemoteDevice[] {
		if (!this.hooks.devices) return [];
		if (!this.deviceCache) {
			try { this.deviceCache = this.hooks.devices.list().filter((d) => d && typeof d.token === 'string' && typeof d.id === 'string'); }
			catch { this.deviceCache = []; }
		}
		return this.deviceCache;
	}

	private saveDevices(list: RemoteDevice[]): void {
		this.deviceCache = list;
		try { this.hooks.devices?.save(list); } catch { /* A read-only settings store keeps the session for this run. */ }
	}

	/** Mint a per-phone secret; the link token only ever bootstraps it. */
	private mintDevice(req: http.IncomingMessage, ip: string): RemoteDevice | undefined {
		if (!this.hooks.devices) return undefined;
		const record: RemoteDevice = {
			id: randomBytes(8).toString('hex'),
			token: randomBytes(24).toString('base64url'),
			name: deviceName(req.headers['user-agent']),
			ip,
			created: Date.now(),
			seen: Date.now()
		};
		const list = [...this.devices(), record];
		// Drop the least recently used phone past the cap.
		while (list.length > MAX_DEVICES) list.sort((a, b) => a.seen - b.seen).shift();
		this.saveDevices(list);
		return record;
	}

	private touch(device: RemoteDevice): RemoteDevice {
		if (Date.now() - device.seen < 60_000) return device;
		device.seen = Date.now();
		this.saveDevices([...this.devices()]);
		return device;
	}

	private findDevice(token: string): RemoteDevice | undefined {
		for (const device of this.devices()) if (device.token === token) return this.touch(device);
		return undefined;
	}

	/** Settings lists them; revoking one signs only that phone out. */
	devicesView(): RemoteDeviceView[] {
		return this.devices().map(({ id, name, ip, created, seen }) => ({ id, name, ip, created, seen })).sort((a, b) => b.seen - a.seen);
	}

	revokeDevice(id: string): boolean {
		const list = this.devices();
		const found = list.find((d) => d.id === id);
		if (!found) return false;
		for (const [res, stream] of this.streams) {
			if (stream.device === id) { try { res.end(); } catch { /* already closed */ } this.streams.delete(res); }
		}
		this.saveDevices(list.filter((d) => d.id !== id));
		this.cancelMessages(id);
		clearTimeout(this.disconnects.get(id)); this.disconnects.delete(id);
		void this.surface?.handle({ type: 'zcClientLeft', zcDevice: id }).catch(() => undefined);
		return true;
	}

	private cancelMessages(device?: string): void {
		for (const [request, pending] of this.pendingMessages) {
			if (device !== undefined && pending.device !== device) continue;
			this.pendingMessages.delete(request);
			if (!pending.response.headersSent) pending.response.writeHead(401);
			pending.response.end(() => request.destroy());
		}
	}

	revokeAll(): void {
		for (const device of this.devices()) void this.surface?.handle({ type:'zcClientLeft', zcDevice:device.id }).catch(() => undefined);
		for (const res of [...this.streams.keys()]) { try { res.end(); } catch { /* closed */ } }
		this.streams.clear();
		this.saveDevices([]);
		this.cancelMessages();
		for (const timer of this.disconnects.values()) clearTimeout(timer);
		this.disconnects.clear();
	}

	/** Too many bad tokens from this address → locked out for a while. */
	private lockedOut(ip: string): boolean {
		const f = this.failures.get(ip);
		return !!f?.lockedUntil && f.lockedUntil > Date.now();
	}

	private recordFailure(ip: string): void {
		const now = Date.now();
		const f = this.failures.get(ip);
		const entry = f && now - f.since < FAIL_WINDOW ? { ...f, count: f.count + 1 } : { count: 1, since: now };
		if (entry.count >= FAIL_LIMIT) {
			entry.lockedUntil = now + LOCKOUT;
		}
		this.failures.set(ip, entry);
		if (this.failures.size > 1000) {
			this.failures.delete(this.failures.keys().next().value!);
		}
	}

	/** Token bucket for /api/msg: bursts are fine, floods are not. */
	private allowMessage(ip: string, interactive = false): boolean {
		if (interactive) ip += ':terminal';
		const now = Date.now();
		// Desktop state saves, receipts and panel polling share this budget with clicks.
		const burst = interactive || this.opts.desktop ? 160 : MSG_BURST, rate = interactive ? 80 : this.opts.desktop ? 40 : MSG_REFILL_PER_SEC;
		const b = this.buckets.get(ip) ?? { tokens: burst, at: now };
		b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
		b.at = now;
		const ok = b.tokens >= 1;
		if (ok) {
			b.tokens -= 1;
		}
		this.buckets.set(ip, b);
		return ok;
	}

	get running(): boolean {
		return !!this.server?.listening;
	}

	/** Every base that can reach this server, public links first. */
	private bases(): string[] {
		const pub = this.running ? (this.hooks.publicBases?.() ?? []) : [];
		return [...pub, ...(this.running ? lanAddresses().map((ip) => `http://${ip}:${this.port}`) : [])];
	}

	info(): { running: boolean; port: number; urls: string[]; qr?: string; clients: number; error?: string; pairCode?: string; pairUntil?: number; home?: string; devices: RemoteDeviceView[]; secure: boolean } {
		const bases = this.bases();
		const urls = bases.map((b) => `${b}/?t=${this.hooks.token()}`);
		const pair = this.pair && this.pair.until > Date.now() ? this.pair : undefined;
		return {
			running: this.running, port: this.port, urls, qr: urls[0] ? qrSvg(urls[0], 5) : undefined,
			clients: this.streams.size, error: this.lastError, pairCode: pair?.code, pairUntil: pair?.until,
			home: bases[0] ? `${bases[0]}/pair` : undefined,
			devices: this.devicesView(), secure: bases.some((b) => b.startsWith('https://'))
		};
	}

	/**
	 * An Approve/Reject link for a push notification. It carries a short-lived
	 * signature, never the token, and only exists while this server is reachable.
	 */
	actionUrl(id: string, approve: boolean): string | undefined {
		if (!this.running || !this.hooks.decide) return undefined;
		const base = this.bases()[0];
		if (!base || !id) return undefined;
		const exp = Date.now() + ACTION_TTL;
		const sig = createHmac('sha256', this.hooks.token()).update(`${id}|${approve ? 'y' : 'n'}|${exp}`).digest('base64url');
		return `${base}/api/action?id=${encodeURIComponent(id)}&a=${approve ? 'y' : 'n'}&exp=${exp}&sig=${sig}`;
	}

	async start(port: number): Promise<void> {
		if (this.running && this.port === port) {
			return;
		}
		await this.stop();
		// Events while the server was detached were not recorded; an old cursor cannot prove freshness.
		this.replay = new EventReplay(); this.latestState = undefined;
		if (this.opts.commandDir) this.ledger = new CommandLedger(this.opts.commandDir, this.replay.epoch);
		this.lastError = undefined;
		const server = http.createServer((req, res) => {
			void this.route(req, res).catch(() => {
				if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
				res.end('The request could not be completed.');
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once('error', (err: NodeJS.ErrnoException) => {
				this.lastError = err.code === 'EADDRINUSE' ? `Port ${port} is already in use — pick another port.` : err.message;
				reject(new Error(this.lastError));
			});
			server.listen(port, this.opts.desktop ? '127.0.0.1' : '0.0.0.0', () => resolve());
		});
		this.server = server;
		// Port 0 = any free port (the desktop app); report the real one.
		const addr = server.address();
		this.port = addr && typeof addr === 'object' ? addr.port : port;
		this.surface = this.hooks.attach((message) => {
			if (this.server !== server) return;
			if (message.type === 'state') {
				// Store a detached baseline: the controller mutates its message objects in place.
				const next = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
				if (this.latestState) {
					const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(this.latestState![key]) !== JSON.stringify(value)));
					const removed = Object.keys(this.latestState).filter(key => !(key in next));
					message = { type:'statePatch', patch, removed };
				}
				this.latestState = next;
			}
			const line = this.replay.append(message);
			for (const [response, stream] of this.streams) {
				if (response.writableLength + ((stream.out as NodeJS.WritableStream & { writableLength?:number }).writableLength ?? 0) > 4 * 1024 * 1024) { response.destroy(); continue; }
				stream.out.write(stream.modern ? line : `data: ${JSON.stringify(message.type === 'statePatch' ? this.latestState : message)}\n\n`);
			}
		});
	}

	async stop(): Promise<void> {
		this.cancelMessages();
		for (const pending of this.inFlight.values()) { try { this.ledger?.update(pending.scope, pending.receipt, 'uncertain'); } catch { console.error('Could not save interrupted command outcome.'); } }
		this.inFlight.clear();
		for (const timer of this.disconnects.values()) clearTimeout(timer);
		this.disconnects.clear();
		this.lastError = undefined;
		this.pair = undefined;
		this.pairFails = 0;
		for (const res of this.streams.keys()) {
			res.end();
		}
		this.streams.clear();
		this.surface?.dispose();
		this.surface = undefined;
		const server = this.server;
		this.server = undefined;
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private cookieToken(req: http.IncomingMessage): string | undefined {
		const cookie = /(?:^|;\s*)zr=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
		if (!cookie) return undefined;
		try { return decodeURIComponent(cookie); } catch { return undefined; }
	}

	private tokens(req: http.IncomingMessage, url: URL): string[] {
		const header = req.headers['x-zer0ne-token'];
		return [url.searchParams.get('t') ?? undefined, this.cookieToken(req), typeof header === 'string' ? header : undefined].filter((v): v is string => !!v);
	}

	private same(given: string, want: string): boolean {
		const a = Buffer.from(given), b = Buffer.from(want);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/**
	 * Who is asking: a paired phone (its own token — revocable on its own) or the
	 * link token (the QR/URL, which only bootstraps a phone session). `stale` marks
	 * a phone that presents a session this server no longer knows (it was signed
	 * out): it gets the pairing page instead of silently pairing again.
	 */
	private identify(req: http.IncomingMessage, url: URL): { device?: RemoteDevice; link: boolean; stale: boolean } {
		const candidates = this.tokens(req, url);
		for (const token of candidates) {
			const device = this.findDevice(token);
			if (device) return { device, link: false, stale: false };
		}
		const want = this.hooks.token();
		const cookie = this.cookieToken(req);
		// A link cookie from before per-phone sessions is still valid and upgrades on the
		// next page load; a cookie this server does not know was signed out on purpose.
		const stale = !!this.hooks.devices && !this.opts.desktop && cookie !== undefined && !this.same(cookie, want);
		return { link: candidates.some((t) => this.same(t, want)), stale };
	}

	/* ---------------------------------------------------------------- routes */

	private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? '/', 'http://x');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Referrer-Policy', 'no-referrer');
		if (url.pathname.startsWith('/media/')) {
			const relative = url.pathname.slice('/media/'.length);
			const name = ['terminal/xterm.min.js', 'terminal/xterm.css'].includes(relative) ? relative : path.basename(url.pathname);
			const file = path.join(this.mediaDir, name);
			if (!TYPES[path.extname(name)] || !fs.existsSync(file)) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-cache' });
			fs.createReadStream(file).pipe(res);
			return;
		}
		if (this.opts.desktop && url.pathname.startsWith('/modelfit/')) {
			const base = path.join(this.mediaDir, 'modelfit');
			const file = path.resolve(base, '.' + path.posix.normalize(decodeURIComponent(url.pathname.slice('/modelfit'.length))));
			const type = MODELFIT_TYPES[path.extname(file).toLowerCase()];
			if (!file.startsWith(base + path.sep) || !type || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, {
				'Content-Type': type, 'Cache-Control': 'no-cache',
				// Framed by Settings only; it talks to the engine through the page that frames it, never by itself.
				...(type.startsWith('text/html') ? { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" } : {})
			});
			fs.createReadStream(file).pipe(res);
			return;
		}
		// Public: the web-app manifest and icon (no secrets), and the pairing page.
		if (url.pathname === '/manifest.webmanifest') {
			res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }).end(
				JSON.stringify({ name: 'zer0ne remote', short_name: 'zer0ne', description: 'Chat with your zer0ne coding agent from your phone', start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait', background_color: '#08080a', theme_color: '#0b0b0d', icons: [{ src: '/icon.png', sizes: '1254x1254', type: 'image/png', purpose: 'any' }, { src: '/icon.png', sizes: '192x192 512x512', type: 'image/png', purpose: 'maskable' }] })
			);
			return;
		}
		if (url.pathname === '/icon.png') {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
			fs.createReadStream(path.join(this.mediaDir, 'icon.png')).pipe(res);
			return;
		}
		const ip = this.clientIp(req);
		if (this.lockedOut(ip)) {
			res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(LOCKOUT / 1000) }).end('Too many failed attempts. Try again later.');
			return;
		}
		// Notification actions arrive from the phone's browser, so they authenticate by
		// their own short-lived signature instead of the session cookie.
		if (url.pathname === '/api/action' && req.method === 'GET') {
			const id = url.searchParams.get('id') ?? '';
			const approve = url.searchParams.get('a') === 'y';
			const exp = Number(url.searchParams.get('exp'));
			const sig = url.searchParams.get('sig') ?? '';
			const want = id && Number.isFinite(exp) && exp > Date.now() ? createHmac('sha256', this.hooks.token()).update(`${id}|${approve ? 'y' : 'n'}|${exp}`).digest('base64url') : '';
			const good = !!want && !!sig && this.same(sig, want) && !!this.hooks.decide;
			if (!good) {
				this.recordFailure(ip);
				res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
					.end(actionPage({ state: 'expired', approve }));
				return;
			}
			let applied = false;
			try { applied = await this.hooks.decide!(id, approve); } catch { applied = false; }
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
				.end(actionPage({ state: applied ? (approve ? 'approved' : 'rejected') : 'gone', approve }));
			return;
		}
		if (url.pathname === '/api/pair' && req.method === 'POST') {
			let body = '';
			req.setEncoding('utf8');
			req.on('data', (c) => {
				body += c;
				if (body.length > 200) req.destroy();
			});
			req.on('end', () => {
				const code = /"code"\s*:\s*"(\d{6})"/.exec(body)?.[1] ?? '';
				const ok = !!this.pair && this.pair.until > Date.now() && code.length === 6 && timingSafeEqual(Buffer.from(code), Buffer.from(this.pair.code));
				if (!ok) {
					this.recordFailure(ip);
					if (++this.pairFails >= PAIR_GLOBAL_LIMIT) {
						this.pair = undefined;
					}
					res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"ok":false}');
					return;
				}
				this.pair = undefined; // one use
				const device = this.mintDevice(req, ip);
				res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': this.cookie(req, device?.token ?? this.hooks.token()) }).end('{"ok":true}');
			});
			return;
		}
		// Everything but the static page and the pairing page needs a token:
		// the inline app's document and the published artifact carry workspace
		// content, so they are served to an authorized client only (the page's
		// own cookie or token). The unguessable id in the path is a second
		// barrier, not the only one.
		const who = this.identify(req, url);
		if (url.pathname === '/pair' || who.stale || !(who.device || who.link)) {
			if (!who.stale && url.pathname !== '/pair' && url.searchParams.has('t')) this.recordFailure(ip);
			const nonce = randomBytes(16).toString('base64');
			res.writeHead(url.pathname === '/pair' ? 200 : 401, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
			}).end(pairPage(nonce));
			return;
		}
		this.failures.delete(ip);
		if (url.pathname.startsWith('/api/mcp-apps/')) {
			if (req.method !== 'GET' || !this.hooks.mcpApp) {
				res.writeHead(404).end();
				return;
			}
			const html = this.hooks.mcpApp(url.pathname.slice('/api/mcp-apps/'.length));
			res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'" }).end(html || 'App expired. Open it again from its message.');
			return;
		}
		if (url.pathname.startsWith('/api/artifacts/')) {
			if (req.method !== 'GET' || !this.hooks.preview) {
				res.writeHead(404).end();
				return;
			}
			const html = this.hooks.preview(url.pathname.slice('/api/artifacts/'.length));
			res.writeHead(html === undefined ? 404 : 200, {
				'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
				'Content-Security-Policy': "sandbox allow-scripts; frame-ancestors 'self'; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; img-src data: blob: https:; media-src data: https:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
				'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
			}).end(html ?? 'Preview unavailable. Republish the artifact.');
			return;
		}
		if (url.pathname === '/api/protocol') {
			res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control':'no-store' }).end(JSON.stringify({ protocol:BROWSER_PROTOCOL, epoch:this.replay.epoch }));
		} else if (url.pathname === '/') {
			const nonce = randomBytes(16).toString('base64');
			// A link visit pairs this phone; its own token then rides in the page and
			// the cookie, so revoking the phone cuts every path it has.
			const device = who.device ?? (who.link && !this.opts.desktop ? this.mintDevice(req, ip) : undefined);
			const pageToken = device?.token ?? this.hooks.token();
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				'Set-Cookie': this.cookie(req, pageToken),
				'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data: blob:; media-src blob: data:; font-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${this.opts.desktop ? 'file:' : "'none'"}`
			}).end(this.page(pageToken, nonce));
		} else if (url.pathname === '/api/events') {
			const modern = url.searchParams.get('v') === String(BROWSER_PROTOCOL);
			const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
			res.writeHead(200, {
				'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
				...(gzip ? { 'Content-Encoding': 'gzip' } : {})
			});
			// Z_SYNC_FLUSH so each event leaves immediately; without it gzip holds the stream.
			const out = gzip ? createGzip({ flush: zlibConstants.Z_SYNC_FLUSH }) : res;
			if (gzip) (out as ReturnType<typeof createGzip>).pipe(res);
			out.write(': connected\n\n');
			const cursor = String(url.searchParams.get('cursor') ?? req.headers['last-event-id'] ?? '');
			const missed = cursor ? this.replay.since(cursor) : undefined;
			out.write(`data: ${JSON.stringify({ type: 'transportHello', protocol: BROWSER_PROTOCOL, epoch: this.replay.epoch, replaying: !!missed, capabilities: { receipts: !!this.ledger, replay: true, historyPaging: true } })}\n\n`);
			if (missed) { for (const line of missed) out.write(line); out.write(`data: ${JSON.stringify({ type: 'transportSynced', cursor: this.replay.cursor })}\n\n`); }
			else if (this.latestState) out.write(`${modern ? 'id: ' + this.replay.cursor + '\n' : ''}data: ${JSON.stringify(this.latestState)}\n\n`);
			if (who.device) { clearTimeout(this.disconnects.get(who.device.id)); this.disconnects.delete(who.device.id); }
			this.streams.set(res, { out, device: who.device?.id, modern });
			this.hooks.changed?.();
			const ping = setInterval(() => out.write(': ping\n\n'), 20_000);
			req.on('close', () => {
				clearInterval(ping);
				const device = this.streams.get(res)?.device;
				this.streams.delete(res);
				if (gzip) try { (out as ReturnType<typeof createGzip>).end(); } catch { /* closed */ }
				this.hooks.changed?.();
				if (device && ![...this.streams.values()].some(s => s.device === device)) {
					clearTimeout(this.disconnects.get(device));
					const timer = setTimeout(() => {
						this.disconnects.delete(device);
						void this.surface?.handle({ type: 'zcClientLeft', zcDevice: device }).catch(() => undefined);
					}, 60_000);
					timer.unref(); this.disconnects.set(device, timer);
				}
			});
			if (!missed) void this.surface?.handle({ type: 'ready' });
		} else if (url.pathname === '/api/receipt' && req.method === 'GET') {
			if (!this.allowMessage(ip)) { res.writeHead(429).end(); return; }
			const scope = this.commandScope(who.device);
			const receipt = this.ledger?.get(scope, url.searchParams.get('id') ?? '');
			res.writeHead(receipt ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(receipt ? { id: receipt.id, type: receipt.type, status: receipt.status, at: receipt.at, updated: receipt.updated, epoch: receipt.epoch } : { error: 'Receipt not found. Inspect current work before submitting again.' }));
		} else if (url.pathname === '/api/msg' && req.method === 'POST') {
			if (String(req.headers['x-zer0ne-protocol']) !== String(BROWSER_PROTOCOL)) {
				res.writeHead(426, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Reload this page to use the current engine protocol.', protocol: BROWSER_PROTOCOL })); req.resume(); return;
			}
			const interactive = req.headers['x-zer0ne-channel'] === 'terminal';
			if (!this.allowMessage(ip, interactive)) {
				res.writeHead(429, { 'Retry-After': '1' }).end();
				req.resume();
				return;
			}
			let body = '';
			this.pendingMessages.set(req, { response: res, device: who.device?.id });
			const cleanup = () => this.pendingMessages.delete(req);
			req.once('error', cleanup);
			res.once('close', cleanup);
			req.setEncoding('utf8');
			req.on('data', (c) => {
				if (res.writableEnded) return;
				body += c;
				if (body.length > (interactive ? 65536 : 8_000_000)) {
					req.destroy();
				}
			});
			req.on('end', async () => {
				cleanup();
				if (res.writableEnded) return;
				try {
					const current = this.identify(req, url);
					if (current.stale || !(current.device || current.link) || current.device?.id !== who.device?.id) {
						res.writeHead(401).end();
						return;
					}
					const msg = JSON.parse(body);
					if (interactive && !['ptyInput','ptyResize'].includes(msg?.type)) { res.writeHead(400).end(); return; }
					if (this.opts.desktop && msg?.type === 'zcViewState') {
						await this.surface?.handle({ ...msg, zcDevice:undefined });
						res.writeHead(204).end(); return;
					}
					if (msg && typeof msg.type === 'string' && (this.opts.desktop || !DESKTOP_ONLY.has(msg.type))) {
						if (this.ledger && RECEIPTED_COMMANDS.has(msg.type)) {
							const scope = this.commandScope(who.device);
							const id = String(req.headers['x-zer0ne-command'] ?? '');
							const { receipt, fresh } = this.ledger.begin(scope, id, msg);
							res.writeHead(202, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ id: receipt.id, type: receipt.type, status: receipt.status, at: receipt.at, updated: receipt.updated, epoch: receipt.epoch }));
							if (fresh) {
								const running = this.ledger.update(scope, receipt, 'running');
								const key = scope + '\0' + id;
								this.inFlight.set(key, { scope, receipt:running });
								const settle = (status: 'completed' | 'failed') => {
									if (!this.inFlight.has(key)) return;
									this.ledger!.update(scope, running, status);
									this.inFlight.delete(key);
								};
								void this.surface?.handle({ ...msg, zcDevice: who.device?.id, zcCommand: true }).then(() => {
									settle('completed');
								}, () => { settle('failed'); }).catch(() => console.error('Could not settle command receipt; inspect current work.'));
							}
							return;
						}
						// The phone is named with its message: the host keeps per-client
						// state (Side Chat threads) and must know who is talking.
						void this.surface?.handle({ ...msg, zcDevice: who.device?.id }).catch(() => console.error('UI action failed'));
					}
					res.writeHead(204).end();
				} catch {
					if (!res.headersSent) res.writeHead(400); res.end();
				}
			});
		} else {
			res.writeHead(404).end();
		}
	}

	private page(token: string, nonce: string): string {
		const desktopHost = this.opts.desktop || this.opts.desktopHost;
		const body = CHAT_BODY;
		const css = ['base.css', 'themes.css', 'chat.css', 'history-library.css', 'agent-ledger.css', 'side-chat.css', 'computer-use.css', 'settings.css', 'workbench.css', 'terminal/xterm.css', 'polish.css', 'repository-panels.css', 'setup.css'].map((f) => `<link rel="stylesheet" href="/media/${f}">`).join('');
		// filament.js is not part of the public source, so a checkout without it runs without the animation.
		const filament = fs.existsSync(path.join(this.mediaDir, 'filament.js')) ? ['filament.js'] : [];
		const js = ['bridge.js', 'i18n.js', ...filament, 'effects.js', 'appearance.js', 'icons.js', 'computer-history.js', 'computer-use.js', 'orbs.js', 'markdown.js', 'project-panel.js', 'side-chat.js', 'beam.js', 'recovery.js', 'chat-stats.js', 'chat-review.js', 'chat-project-actions.js', 'chat-repository.js', 'chat-branch.js', 'setup.js', 'chat.js', 'workbench.js', 'workflow-history.js', 'mcp-apps.js', 'skill-recorder.js', 'settings-remote.js', 'settings-index.js', 'settings-search.js', 'settings-general.js', 'settings-usage.js', 'settings-benchmark-profiles.js', 'settings-features.js', 'settings-hooks-memory.js', 'settings.js'].map((f) => `<script src="/media/${f}"></script>`).join('');
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#161616"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="zer0ne">
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon.png"><link rel="apple-touch-icon" href="/icon.png">
<title>${this.opts.desktop ? 'zer0ne coding' : 'zer0ne remote'}</title>${css}</head>
<body class="vscode-dark ${this.opts.desktop ? 'desktop' : 'remote'}">${body}
<script nonce="${nonce}">window.__REMOTE__ = { token: ${JSON.stringify(token)}, desktopHost: ${!!desktopHost}${this.opts.desktop ? ', desktop: true' : ''}${this.hooks.devices ? ', paired: true' : ''} }; history.replaceState(null, '', '/');</script>${js}</body></html>`;
	}
}

/** The page a notification action lands on: one line, one tap, nothing to press. */
function actionPage({ state, approve }: { state: 'approved' | 'rejected' | 'gone' | 'expired'; approve: boolean }): string {
	const title = state === 'approved' ? 'Approved' : state === 'rejected' ? 'Rejected' : state === 'gone' ? 'Already answered' : 'Link expired';
	const body = state === 'approved' ? 'zer0ne will carry on with this change.' : state === 'rejected' ? 'zer0ne will not make this change.' : state === 'gone' ? 'This request was already answered, here or on the desktop.' : 'Open zer0ne on your computer to answer it.';
	const tone = state === 'approved' ? '#4ade80' : state === 'rejected' ? '#f87171' : '#9aa6b4';
	const mark = state === 'approved' ? '✓' : state === 'rejected' ? '✕' : '•';
	return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08080a"><title>${title} · zer0ne</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(120% 80% at 50% 0%,#1b222c,#0a0c10 60%);color:#e8eef5;font:15px/1.55 -apple-system,system-ui,"Segoe UI",Roboto,sans-serif;text-align:center;padding:24px}
main{width:min(340px,100%)}
.mark{display:grid;place-items:center;width:62px;height:62px;margin:0 auto 18px;border-radius:50%;color:${tone};font-size:30px;border:1px solid ${tone}44;background:${tone}14;box-shadow:0 0 40px -12px ${tone}88}
h1{margin:0 0 8px;font-size:21px;font-weight:600;letter-spacing:-.02em}p{margin:0;color:#96a2b1;font-size:13.5px}
.tag{margin-top:26px;color:#4d5662;font-size:11px;letter-spacing:.16em;text-transform:uppercase}</style></head>
<body><main><div class="mark" aria-hidden="true">${mark}</div><h1>${title}</h1><p>${body}</p><div class="tag">zer0ne · ${approve ? 'approval' : 'rejection'}</div></main></body></html>`;
}
