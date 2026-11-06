import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { download } from './localEngine';
import { scrubEnv } from './tools/proc';

/**
 * Mobile Remote from anywhere.
 *
 *  - Secure link: a Cloudflare quick tunnel (`cloudflared tunnel --url`) —
 *    free, no account, an https://<random>.trycloudflare.com address that
 *    reaches this machine from any network. Outbound only: no router or
 *    firewall changes. cloudflared (Apache-2.0) is downloaded from
 *    Cloudflare's GitHub releases on first use, or taken from PATH.
 *  - Tailscale: when this machine is on a tailnet, its 100.x address works
 *    from the user's other devices, end-to-end encrypted, nothing public.
 *  - Own tunnel: a reverse tunnel over the system ssh client to a server the
 *    user runs (tunnl.gg onto a VPS, serveo, …) — no third party, and the URL
 *    can stay the same across sessions when the server ties it to the SSH key.
 *    No download: ssh ships with every OS.
 *
 * The remote server's token, pairing code and lockouts still guard every
 * request; the tunnel only carries them.
 */

const RELEASES = () => process.env.ZER0NE_CLOUDFLARED_RELEASES || 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';

/** The cloudflared release asset for this machine (pure; tested). */
export function cloudflaredAsset(names: string[], platform = process.platform, arch = process.arch): string | undefined {
	const want =
		platform === 'win32'
			? ['cloudflared-windows-amd64.exe'] // runs on x64 and, emulated, on Windows on ARM
			: platform === 'darwin'
				? [arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz']
				: arch === 'arm64'
					? ['cloudflared-linux-arm64']
					: arch === 'arm'
						? ['cloudflared-linux-arm']
						: ['cloudflared-linux-amd64'];
	return want.find((w) => names.includes(w));
}

/** First trycloudflare.com URL in cloudflared's log (pure; tested). */
export function tunnelUrl(log: string): string | undefined {
	return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(log)?.[0];
}

function onPath(name: string): string | undefined {
	const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true });
	return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

export function findCloudflared(binDir: string): string | undefined {
	const own = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
	if (fs.existsSync(own)) return own;
	const common = process.platform === 'darwin' ? ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'] : process.platform === 'linux' ? ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared'] : [];
	return common.find((p) => fs.existsSync(p)) ?? onPath('cloudflared');
}

export async function installCloudflared(binDir: string, onProgress: (text: string, pct?: number) => void, signal: AbortSignal = AbortSignal.timeout(600_000)): Promise<string> {
	fs.mkdirSync(binDir, { recursive: true });
	const lock = path.join(binDir, '.cloudflared-install.json');
	const nonce = randomUUID();
	// Project hosts share this binary; only one may replace its download files.
	for (;;) {
		signal.throwIfAborted();
		try {
			fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx' });
			break;
		} catch (error: any) {
			if (error.code !== 'EEXIST') throw error;
			try {
				const text = fs.readFileSync(lock, 'utf8');
				const owner = JSON.parse(text);
				try { process.kill(owner.pid, 0); } catch (error: any) {
					if (error.code === 'ESRCH' && fs.readFileSync(lock, 'utf8') === text) fs.unlinkSync(lock);
				}
			} catch { /* The other installer may be writing or releasing its lease. */ }
			onProgress('Waiting for the secure link helper installation…');
			await new Promise(resolve => setTimeout(resolve, 150));
		}
	}
	try {
		const have = findCloudflared(binDir);
		if (have) return have;
		return await downloadCloudflared(binDir, onProgress, signal);
	} finally {
		try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).nonce === nonce) fs.unlinkSync(lock); } catch { /* Preserve a replacement owner's lease. */ }
	}
}

async function downloadCloudflared(binDir: string, onProgress: (text: string, pct?: number) => void, signal: AbortSignal): Promise<string> {
	onProgress('Finding cloudflared…');
	const res = await fetch(RELEASES(), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
	if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} while looking for cloudflared.`);
	const rel: any = await res.json();
	const name = cloudflaredAsset((rel.assets ?? []).map((a: any) => a.name));
	const asset = (rel.assets ?? []).find((a: any) => a.name === name);
	if (!asset) throw new Error(`cloudflared has no build for ${process.platform}-${process.arch}.`);
	fs.mkdirSync(binDir, { recursive: true });
	const exe = path.join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
	const tmp = path.join(binDir, asset.name + '.part');
	onProgress(`Downloading cloudflared ${rel.tag_name} (${Math.round(asset.size / 1e6)} MB)…`, 0);
	// Resumable, with progress (the same downloader the local engine uses).
	await download(asset.browser_download_url, tmp + '.dl', (p) => onProgress(`Downloading cloudflared ${rel.tag_name}…`, p.total ? Math.floor((p.received / p.total) * 100) : undefined), signal, asset.size);
	fs.renameSync(tmp + '.dl', tmp);
	onProgress('Installing…', 100);
	if (asset.name.endsWith('.tgz')) {
		const r = spawnSync('tar', ['-xzf', tmp, '-C', binDir], { timeout: 120_000 });
		fs.rmSync(tmp, { force: true });
		if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('Could not unpack cloudflared.');
	} else {
		fs.renameSync(tmp, exe);
	}
	if (process.platform !== 'win32') fs.chmodSync(exe, 0o755);
	return exe;
}

/** This machine's Tailscale IPv4 (100.x) and MagicDNS name, when it is on a tailnet. */
export function tailscaleAddress(): { ip: string; dns?: string } | undefined {
	const bin = process.platform === 'darwin' && fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale') ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale';
	try {
		const r = spawnSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
		if (r.status !== 0 || !r.stdout) return undefined;
		const j = JSON.parse(r.stdout);
		const ip = (j?.Self?.TailscaleIPs ?? []).find((x: string) => /^100\./.test(x));
		if (!ip || j?.BackendState !== 'Running') return undefined;
		return { ip, dns: typeof j.Self.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : undefined };
	} catch {
		return undefined;
	}
}

export type TunnelState = { state: 'off' } | { state: 'starting'; text: string; pct?: number } | { state: 'on'; url: string } | { state: 'error'; error: string };

/** One quick tunnel to the Mobile Remote port. */
export class QuickTunnel {
	private proc?: ChildProcess;
	private port = 0;
	private generation = 0;
	private pending?: Promise<void>;
	status: TunnelState = { state: 'off' };

	constructor(
		private readonly binDir: string,
		private readonly onChange: () => void
	) {}

	get url(): string | undefined {
		return this.status.state === 'on' ? this.status.url : undefined;
	}

	/** The helper binary, when it is installed (ours, Homebrew, or on PATH). */
	helper(): { installed: boolean; path?: string; installing: boolean } {
		// Looking on PATH spawns a process: cache it (state is sent many times a second while streaming).
		if (!this.found || Date.now() - this.found.at > 60_000) this.found = { at: Date.now(), path: findCloudflared(this.binDir) };
		return { installed: !!this.found.path, path: this.found.path, installing: !!this.installing };
	}
	private found?: { at: number; path?: string };

	private installing?: Promise<string>;
	/** Download and install cloudflared now (one click in Settings); ready for "Anywhere". */
	async install(): Promise<string> {
		const have = findCloudflared(this.binDir);
		if (have) return have;
		const generation = this.generation;
		this.installing ??= installCloudflared(this.binDir, (text, pct) => { if (generation === this.generation) this.set({ state: 'starting', text, pct }); }).finally(() => (this.installing = undefined));
		try {
			const exe = await this.installing;
			this.found = { at: Date.now(), path: exe };
			if (generation === this.generation && !this.proc) this.set({ state: 'off' });
			return exe;
		} catch (e) {
			if (generation === this.generation) this.set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
			throw e;
		}
	}

	private set(s: TunnelState): void {
		this.status = s;
		this.onChange();
	}

	start(port: number): Promise<void> {
		if ((this.proc || this.pending) && this.port === port && this.status.state !== 'error') return this.pending ?? Promise.resolve();
		this.stop();
		this.port = port;
		const generation = this.generation;
		this.set({ state: 'starting', text: 'Finding the secure link helper…' });
		const task = this.open(port, generation);
		this.pending = task;
		return task.finally(() => { if (this.generation === generation) this.pending = undefined; });
	}

	private async open(port: number, generation: number): Promise<void> {
		try {
			const exe = await this.install();
			if (generation !== this.generation) return;
			this.set({ state: 'starting', text: 'Opening a secure link…' });
			const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { windowsHide: true, env: scrubEnv() });
			this.proc = proc;
			let log = '';
			const url = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('The secure link did not come up in 45 s. ' + (log.split('\n').filter(l => /ERR|error|failed/i.test(l)).pop()?.trim().slice(0, 300) || 'Check your internet connection and try again.'))), 45_000);
				const read = (c: Buffer) => {
					log = (log + c.toString()).slice(-6000);
					const u = tunnelUrl(log);
					if (u) {
						clearTimeout(timer);
						resolve(u);
					}
				};
				proc.stdout?.on('data', read);
				proc.stderr?.on('data', read);
				proc.on('exit', (code) => {
					clearTimeout(timer);
					reject(new Error(`cloudflared stopped (exit ${code}). ${log.split('\n').filter((l) => /ERR|error/i.test(l)).slice(-1)[0]?.slice(0, 200) ?? ''}`));
				});
				proc.once('error', error => { clearTimeout(timer); reject(error); });
			});
			if (generation !== this.generation) return;
			if (proc.exitCode !== null) throw new Error('The secure link closed before it was ready.');
			proc.on('exit', () => {
				if (this.proc === proc) {
					this.proc = undefined;
					this.set({ state: 'error', error: 'The secure link closed. Turn it off and on to open a new one.' });
				}
			});
			this.set({ state: 'on', url });
		} catch (e) {
			if (generation !== this.generation) return;
			this.stop();
			this.set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}

	stop(): void {
		this.generation++;
		this.pending = undefined;
		const p = this.proc;
		this.proc = undefined;
		if (p && p.exitCode === null) {
			if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
			else p.kill();
		}
		if (this.status.state !== 'off') this.set({ state: 'off' });
	}
}

/**
 * One reverse tunnel over the system's own ssh client, to a server the user
 * runs or rents — tunnl.gg style (ssh -R 80 → a memorable https:// subdomain,
 * printed on connect), or any host that behaves alike (serveo, localhost.run).
 * The URL can be stable across sessions when the server ties it to the SSH key
 * (tunnl.gg's stable@), so the phone keeps one bookmark. Zero download: ssh
 * ships with Windows, macOS and most Linux.
 */

/** First https URL the tunnel host printed in ssh's output (pure; tested). */
export function sshUrlFromLog(log: string): string | undefined {
	return /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/\S*)?/i.exec(log)?.[0]?.replace(/[.,;)\]]+$/, '');
}

/** The last line of ssh's own failure that a human can act on (pure; tested). */
export function sshErrorFromLog(log: string): string | undefined {
	return log
		.split(/\r?\n/)
		.filter((l) => /permission denied|publickey|connection refused|could not resolve|connection timed out|administratively prohibited|port forwarding|channel \d+: open failed/i.test(l))
		.slice(-1)[0]
		?.slice(0, 200);
}

/** An ssh -R target: "user@host", "host" or "user@host:22" — nothing ssh could read as an option (pure; tested). */
export function sshTargetError(raw: string): string | undefined {
	const t = String(raw).trim();
	if (!t) return 'Enter the SSH target, e.g. stable@proxy.your-domain.com or serveo.net.';
	if (t.length > 200 || /\s/.test(t)) return 'The target is user@host, nothing else — no spaces.';
	if (t.startsWith('-')) return 'The target cannot start with a dash (ssh would read it as an option).';
	const body = t.includes('@') ? t.slice(t.indexOf('@') + 1) : t;
	const host = body.includes(':') ? body.slice(0, body.indexOf(':')) : body;
	const port = body.includes(':') ? Number(body.slice(body.indexOf(':') + 1)) : undefined;
	if (!/^[A-Za-z0-9._-]+$/.test(host)) return 'That does not look like a host name (letters, digits, dots, dashes).';
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return 'The port after the colon must be a number between 1 and 65535.';
	return undefined;
}

/** The ssh command for a reverse tunnel to the local remote-server port (pure; tested). */
export function sshArgs(target: string, remotePort: number, localPort: number): string[] {
	const host = target.includes('@') ? target.slice(target.indexOf('@') + 1) : target;
	const split = host.lastIndexOf(':');
	const destination = split >= 0 ? target.slice(0, target.length - host.length + split) : target;
	return ['-tt', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', ...(split >= 0 ? ['-p', host.slice(split + 1)] : []), '-R', `${remotePort}:127.0.0.1:${localPort}`, destination];
}

export class SshTunnel {
	private proc?: ChildProcess;
	private port = 0;
	private lastTarget = '';
	private generation = 0;
	private pending?: Promise<void>;
	status: TunnelState = { state: 'off' };

	constructor(private readonly onChange: () => void) {}

	get url(): string | undefined {
		return this.status.state === 'on' ? this.status.url : undefined;
	}

	private set(s: TunnelState): void {
		this.status = s;
		this.onChange();
	}

	/** The system ssh client (cached: the state is sent many times a second while streaming). */
	helper(): { installed: boolean; path?: string } {
		if (!this.found || Date.now() - this.found.at > 60_000) {
			const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ssh'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
			this.found = { at: Date.now(), path: r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || undefined : undefined };
		}
		return { installed: !!this.found.path, path: this.found.path };
	}
	private found?: { at: number; path?: string };

	start(localPort: number, target: string, remotePort: number): Promise<void> {
		if ((this.proc || this.pending) && this.port === localPort && this.lastTarget === target + ':' + remotePort && this.status.state !== 'error') return this.pending ?? Promise.resolve();
		this.stop();
		const generation = this.generation;
		const task = this.open(localPort, target, remotePort, generation);
		this.pending = task;
		return task.finally(() => { if (this.generation === generation) this.pending = undefined; });
	}
	private async open(localPort: number, target: string, remotePort: number, generation: number): Promise<void> {
		const bad = sshTargetError(target);
		if (bad) {
			this.set({ state: 'error', error: bad });
			return;
		}
		if (!this.helper().path) {
			this.set({ state: 'error', error: 'No ssh client found on this computer — Windows: Settings → Apps → Optional features → OpenSSH client; macOS and most Linux have one built in.' });
			return;
		}
		this.port = localPort;
		this.lastTarget = target + ':' + remotePort;
		this.set({ state: 'starting', text: 'Opening your tunnel…' });
		try {
			// -tt: tunnel hosts (tunnl.gg) print the URL only to a TTY; readable through the pipes all the same.
			const proc = spawn(this.helper().path!, sshArgs(target, remotePort, localPort), { windowsHide: true, env: scrubEnv() });
			this.proc = proc;
			let log = '';
			const url = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('ssh did not give a tunnel URL in 45 s — ' + (sshErrorFromLog(log) ?? 'make sure key authentication to that host works without a password prompt, and that the host prints one (tunnl.gg, serveo…).'))), 45_000);
				const read = (c: Buffer) => {
					log = (log + c.toString()).slice(-6000);
					const u = sshUrlFromLog(log);
					if (u) {
						clearTimeout(timer);
						resolve(u);
					}
				};
				proc.stdout?.on('data', read);
				proc.stderr?.on('data', read);
				proc.on('exit', (code) => {
					clearTimeout(timer);
					reject(new Error(`ssh stopped (exit ${code}). ${sshErrorFromLog(log) ?? 'Check the target and your SSH keys.'}`));
				});
				proc.once('error', error => { clearTimeout(timer); reject(error); });
			});
			if (generation !== this.generation) return;
			if (proc.exitCode !== null) throw new Error('The SSH tunnel closed before it was ready.');
			proc.on('exit', () => {
				if (this.proc === proc) {
					this.proc = undefined;
					this.set({ state: 'error', error: 'The tunnel closed. Turn it off and on to open a new one.' });
				}
			});
			this.set({ state: 'on', url });
		} catch (e) {
			if (generation !== this.generation) return;
			this.stop();
			this.set({ state: 'error', error: e instanceof Error ? e.message : String(e) });
		}
	}

	stop(): void {
		this.generation++;
		this.pending = undefined;
		const p = this.proc;
		this.proc = undefined;
		if (p && p.exitCode === null) {
			if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
			else p.kill();
		}
		if (this.status.state !== 'off') this.set({ state: 'off' });
	}
}
