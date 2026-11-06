import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AcpClientHandlers, AcpConnection, AcpSpawn } from './client';
import { AcpAgentEntry, AcpLaunch, PLAN_AGENTS, REGISTRY_URL, launchFor, parseRegistry } from './registry';
import { REGISTRY_SNAPSHOT } from './registrySnapshot';
import { digestMatches, download } from '../localEngine';

/**
 * Finds, installs and starts ACP agents: the registry (live, cached a day,
 * with an offline snapshot), Node's npx for package agents, and a
 * checksum-verified download for binary agents. Nothing here needs VS Code.
 */

/** Folders a GUI-launched editor often lacks on its PATH. */
function extraDirs(): string[] {
	const home = os.homedir();
	return process.platform === 'win32'
		? [path.join(process.env.APPDATA ?? '', 'npm'), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.cargo', 'bin'), path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'nodejs'), 'C:\\Program Files\\nodejs']
		: [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.cargo', 'bin')];
}

/** A command on PATH (plus the usual install folders), as an absolute path (pure enough; tested). */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (path.isAbsolute(name)) {
		try { if (!fs.statSync(name).isFile()) return undefined; fs.accessSync(name, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return name; } catch { return undefined; }
	}
	const dirs = [...(env.PATH ?? env.Path ?? '').split(path.delimiter), ...extraDirs()].filter(Boolean);
	const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
	for (const dir of dirs) {
		for (const ext of exts) {
			const full = path.join(dir, name + ext);
			try {
				if (fs.statSync(full).isFile()) { fs.accessSync(full, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return full; }
			} catch {
				/* not here */
			}
		}
	}
	return undefined;
}

export interface InstallProgress {
	stage: string;
	received: number;
	total: number;
}

export class AcpRuntime {
	private cache?: { at: number; entries: AcpAgentEntry[] };

	constructor(readonly storageDir: string) {}

	private get dir(): string {
		return path.join(this.storageDir, 'acp');
	}

	/** The registry: live (cached 24 h on disk, 30 min in memory), else the last good copy, else the snapshot. */
	async registry(force = false): Promise<AcpAgentEntry[]> {
		if (this.cache && !force && Date.now() - this.cache.at < 30 * 60_000) return this.cache.entries;
		const file = path.join(this.dir, 'registry.json');
		let entries: AcpAgentEntry[] | undefined;
		try {
			if (!force && Date.now() - fs.statSync(file).mtimeMs < 24 * 60 * 60_000) entries = parseRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
		} catch {
			/* not cached yet */
		}
		if (!entries?.length) {
			try {
				const res = await fetch(REGISTRY_URL, { headers: { 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.timeout(15_000) });
				if (res.ok) {
					const json = await res.json();
					entries = parseRegistry(json);
					if (entries.length) {
						fs.mkdirSync(this.dir, { recursive: true });
						fs.writeFileSync(file, JSON.stringify(json));
					}
				}
			} catch {
				/* offline */
			}
		}
		if (!entries?.length) {
			try {
				entries = parseRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
			} catch {
				/* no copy */
			}
		}
		// Use the bundled list only offline; an upstream removal must not resurrect an obsolete installer.
		const merged = entries?.length ? entries : REGISTRY_SNAPSHOT;
		this.cache = { at: Date.now(), entries: merged };
		return merged;
	}

	async entry(id: string): Promise<AcpAgentEntry | undefined> {
		return (await this.registry()).find((e) => e.id === id);
	}

	private installDir(entry: AcpAgentEntry): string {
		return path.join(this.dir, 'agents', entry.id, entry.version.replace(/[^\w.+-]/g, '_'));
	}

	launch(entry: AcpAgentEntry): AcpLaunch | undefined {
		return launchFor(entry);
	}

	setup(entry: AcpAgentEntry): { available: boolean; setupIssue?: string; setupUrl?: string } {
		const launch = this.launch(entry);
		if (!launch) return { available: false, setupIssue: `No agent build for ${process.platform}-${process.arch}.`, setupUrl: entry.website };
		if (launch.kind === 'npx' && !which('node')) return { available: false, setupIssue: 'Install Node.js LTS to run this provider’s sign-in tool.', setupUrl: 'https://nodejs.org/en/download' };
		if (launch.kind === 'npx' && !this.npxScript() && !which('npx')) return { available: false, setupIssue: 'Install npm with Node.js LTS to fetch this provider’s sign-in tool.', setupUrl: 'https://nodejs.org/en/download' };
		if (launch.kind === 'uvx' && !which('uvx')) return { available: false, setupIssue: 'Install uv to run this provider’s sign-in tool.', setupUrl: 'https://docs.astral.sh/uv/getting-started/installation/' };
		const login = PLAN_AGENTS[entry.id]?.statusCommand;
		if (login && !which(login.command)) return { available: false, setupIssue: `Install ${login.command} before signing in.`, setupUrl: entry.id === 'claude-acp' ? 'https://code.claude.com/docs/en/setup' : entry.website };
		return { available: true };
	}

	private npxScript(node = which('node')): string | undefined {
		if (!node) return undefined;
		const file = path.join(path.dirname(node), 'node_modules', 'npm', 'bin', 'npx-cli.js');
		return fs.existsSync(file) ? file : undefined;
	}

	/** Binary agents: is the download on disk? npx / uvx agents: is the runtime available? */
	isInstalled(entry: AcpAgentEntry): boolean {
		const l = this.launch(entry);
		if (!l) return false;
		if (l.kind === 'binary') return fs.existsSync(path.join(this.installDir(entry), '.installed')) && fs.existsSync(path.join(this.installDir(entry), l.cmd ?? ''));
		return l.kind === 'npx' ? !!which('node') && !!(this.npxScript() || which('npx')) : !!which('uvx');
	}

	/** Size of a binary agent's download in bytes (HEAD), so the user can confirm a large one. */
	async downloadSize(entry: AcpAgentEntry): Promise<number | undefined> {
		const l = this.launch(entry);
		if (l?.kind !== 'binary' || !l.archive) return undefined;
		try {
			const res = await fetch(l.archive, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
			const n = Number(res.headers.get('content-length'));
			return n > 0 ? n : undefined;
		} catch {
			return undefined;
		}
	}

	/** Make the agent startable: download + verify + unpack a binary; check for Node / uv for the others. */
	async install(entry: AcpAgentEntry, onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<void> {
		const l = this.launch(entry);
		if (!l) throw new Error(`${entry.name} has no build for ${process.platform}-${process.arch}.`);
		if (l.kind !== 'binary') {
			this.spawnSpec(entry); // throws with the install hint when Node / uv is missing
			return;
		}
		if (this.isInstalled(entry)) {
			// Already there: an older version of the same agent may still sit beside it.
			this.removeOtherVersions(entry);
			return;
		}
		const dir = this.installDir(entry);
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		const name = decodeURIComponent(new URL(l.archive!).pathname.split('/').pop() || 'agent.bin').replace(/[^\w.+-]/g, '_');
		const archive = path.join(dir, name);
		// The registry names the file's size, so a truncated transfer is never
		// promoted to the final name. Without a size the download is only allowed
		// when a checksum follows it.
		const size = await this.downloadSize(entry);
		if (!size && !l.sha256) {
			fs.rmSync(dir, { recursive: true, force: true });
			throw new Error(`The agent registry does not say how large ${entry.name}'s download is, and publishes no checksum for it, so a complete download cannot be proven. Nothing was installed.`);
		}
		await download(l.archive!, archive, (p) => onProgress({ stage: `Downloading ${entry.name}`, received: p.received, total: p.total }), signal, size, { requireSize: true, sizeUnknown: !size });
		onProgress({ stage: 'Verifying…', received: 1, total: 1 });
		// A checksum the registry publishes must match: a mismatch is a failed
		// verification, never a pass.
		if (l.sha256 && digestMatches(archive, 'sha256:' + l.sha256) !== true) {
			fs.rmSync(dir, { recursive: true, force: true });
			throw new Error(`The downloaded ${name} does not match the checksum in the agent registry, so it was deleted. Try again; if it repeats, your network is altering the download.`);
		}
		onProgress({ stage: 'Unpacking…', received: 1, total: 1 });
		if (/\.(zip|tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name)) {
			const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
			const r = spawnSync(tar, ['-xf', archive, '-C', dir], { windowsHide: true, timeout: 600_000 });
			fs.rmSync(archive, { force: true });
			if (r.status !== 0) throw new Error(`Could not unpack ${entry.name}: ${String(r.stderr || '').trim().slice(0, 200)}`);
		} else {
			fs.renameSync(archive, path.join(dir, path.basename(l.cmd ?? name)));
		}
		const cmdPath = path.join(dir, l.cmd ?? '');
		if (!fs.existsSync(cmdPath)) throw new Error(`${entry.name}'s download does not contain ${l.cmd}.`);
		if (process.platform !== 'win32') fs.chmodSync(cmdPath, 0o755);
		fs.writeFileSync(path.join(dir, '.installed'), new Date().toISOString());
		// Older versions of the same agent are dead weight (hundreds of MB
		// after a few updates): only the version just installed is kept.
		this.removeOtherVersions(entry);
	}

	/** Delete every installed version of an agent except the one just installed. */
	private removeOtherVersions(entry: AcpAgentEntry): void {
		const keep = path.basename(this.installDir(entry));
		const root = path.join(this.dir, 'agents', entry.id);
		let versions: string[] = [];
		try {
			versions = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== keep).map((e) => e.name);
		} catch {
			return; // nothing installed
		}
		for (const v of versions) {
			try {
				fs.rmSync(path.join(root, v), { recursive: true, force: true });
			} catch {
				/* a file in use stays; it is removed with the agent */
			}
		}
	}

	removeInstall(entry: AcpAgentEntry): void {
		fs.rmSync(path.join(this.dir, 'agents', entry.id), { recursive: true, force: true });
	}

	/** The process to start for an agent (throws with a plain-language fix when its runtime is missing). */
	spawnSpec(entry: AcpAgentEntry, cwd?: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}): AcpSpawn {
		const l = this.launch(entry);
		if (!l) throw new Error(`${entry.name} has no build for ${process.platform}-${process.arch}.`);
		const env: NodeJS.ProcessEnv = { ...process.env, ...l.env, ...extraEnv };
		// A plan agent talks to its vendor with the plan's login: routing left in the environment (a proxy, a gateway token) would bypass the plan.
		const drop = PLAN_AGENTS[entry.id]?.planOnly?.dropEnv;
		if (drop) for (const k of Object.keys(env)) if (drop.test(k)) delete env[k];
		const args = [...l.args, ...extraArgs];
		if (l.kind === 'binary') {
			const cmd = path.join(this.installDir(entry), l.cmd ?? '');
			if (!fs.existsSync(cmd)) throw new Error(`${entry.name} is not downloaded yet.`);
			return { command: cmd, args, env, cwd, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) };
		}
		if (l.kind === 'uvx') {
			const uvx = which('uvx');
			if (!uvx) throw new Error(`${entry.name} runs with uv. Install it from docs.astral.sh/uv, then try again.`);
			return { command: uvx, args: [l.package!, ...args], env, cwd, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(uvx) };
		}
		const node = which('node');
		if (!node) throw new Error(`${entry.name} is fetched and run with Node.js, which was not found. Install Node.js LTS from nodejs.org, then try again.`);
		env.PATH = path.dirname(node) + path.delimiter + (env.PATH ?? env.Path ?? '');
		const npxCli = this.npxScript(node);
		if (npxCli) {
			// Node's own npx script: no .cmd shim, so no shell (and no shell-injection surface).
			return { command: node, args: [npxCli, '-y', l.package!, ...args], env, cwd };
		}
		const npx = which('npx');
		if (!npx) throw new Error(`${entry.name} needs npm's npx launcher. Install Node.js LTS with npm from nodejs.org, then try again.`);
		return { command: npx, args: ['-y', l.package!, ...args], env, cwd, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(npx) };
	}

	/** Start an agent and complete `initialize` (the first npx run downloads the package: allow time). */
	async connect(entry: AcpAgentEntry, handlers: AcpClientHandlers, o: { cwd: string; fs: boolean; authTerminal?: boolean; signal?: AbortSignal; extraArgs?: string[]; extraEnv?: Record<string, string> }): Promise<AcpConnection> {
		if (o.signal?.aborted) throw Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' });
		const conn = new AcpConnection(this.spawnSpec(entry, o.cwd, o.extraArgs, o.extraEnv), handlers);
		conn.sessionMeta = PLAN_AGENTS[entry.id]?.planOnly?.sessionMeta;
		conn.start();
		const stop = () => conn.close();
		o.signal?.addEventListener('abort', stop, { once: true });
		let timer: NodeJS.Timeout | undefined;
		try {
			if (o.signal?.aborted) { stop(); throw Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' }); }
			await Promise.race([conn.initialize({ fs: o.fs, authTerminal: o.authTerminal }), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${entry.name} did not start in 3 minutes.${conn.stderrTail.trim() ? ' ' + conn.stderrTail.trim().split(/\r?\n/).pop()!.slice(0, 200) : ''}`)), 180_000); timer.unref?.(); })]);
			if (o.signal?.aborted) throw Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' });
		} catch (e) {
			conn.close();
			if (o.signal?.aborted) throw Object.assign(new Error('Sign-in cancelled.'), { name: 'AbortError' });
			throw e;
		} finally {
			clearTimeout(timer);
			o.signal?.removeEventListener('abort', stop);
		}
		return conn;
	}
}

let runtime: AcpRuntime | undefined;
export function setAcpRuntime(rt: AcpRuntime | undefined): void {
	runtime = rt;
}
export function getAcpRuntime(): AcpRuntime | undefined {
	return runtime;
}
