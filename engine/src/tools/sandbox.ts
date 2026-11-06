import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { jobExePath, jobGuardExe } from './jobGuard';
import { psCommand } from './proc';
import { isDesktopHost } from '../host/capabilities';

/**
 * OS-level sandbox for agent commands: reads anywhere, writes only inside the
 * workspace and temp folders.
 *
 *  - macOS: Seatbelt (`sandbox-exec`) with a deny-by-default profile adapted
 *    from Codex's seatbelt_base_policy.sbpl (Apache-2.0).
 *  - Linux: bubblewrap (`bwrap`): read-only bind of /, the workspace and /tmp
 *    writable, optional network namespace.
 *  - Windows: a write-restricted token (media/sandbox/job.cs). Each project gets
 *    its own sandbox SID; preparing the project grants that SID Modify on the
 *    project folder and on its own sandbox temp, nowhere else, so one project's
 *    commands cannot write another's (the flaw of the old Low-integrity
 *    launcher, which labelled every prepared folder alike). The network cannot
 *    be blocked this way. Schannel cannot authenticate under the token, so Git
 *    is pointed at its OpenSSL backend; Node, npm and Git work.
 */

export type SandboxKind = 'seatbelt' | 'bwrap' | 'restricted';

export interface SandboxStatus {
	kind?: SandboxKind;
	available: boolean;
	/** Legacy UI field; unsupported backends must never request folder preparation. */
	needsPrepare?: boolean;
	/** Can this sandbox block the network? */
	network: boolean;
	/** Do sandboxed commands read only the project, or the whole disk? */
	reads?: 'all' | 'restricted';
	/** Windows: the prepared ACLs don't match the current deny list; prepare again. */
	denyStale?: boolean;
	detail: string;
}

export interface SandboxSpawn {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	windowsVerbatimArguments?: boolean;
}

/** Output patterns that usually mean "the sandbox said no". */
export const SANDBOX_DENIED = /Operation not permitted|Permission denied|Read-only file system|UnauthorizedAccessException|Access (to the path .{0,200} )?is denied|EACCES|EPERM|EROFS/i;

// ---------------------------------------------------------------- macOS

const SEATBELT_BASE = `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow file-read*)
(allow file-write-data (require-all (path "/dev/null") (vnode-type CHARACTER-DEVICE)))
(allow file-write* (subpath (param "WRITABLE_ROOT")) (subpath (param "TMPDIR")) (subpath "/private/tmp") (subpath "/private/var/folders"))
(allow sysctl-read)
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.PowerManagement.control"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data ipc-posix-shm-write-create ipc-posix-shm-write-unlink (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write* (require-all (regex #"^/dev/ttys[0-9]+") (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`;

const SEATBELT_NETWORK = `(allow network-outbound)
(allow network-inbound)
(allow system-socket)
(allow mach-lookup
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.networkd")
  (global-name "com.apple.ocspd")
  (global-name "com.apple.trustd.agent")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration")
  (global-name "com.apple.SystemConfiguration.configd"))
(allow sysctl-read (sysctl-name-regex #"^net.routetable"))
`;

export function seatbeltProfile(network: boolean, denyRead: string[] = []): string {
	const deny = denyRead
		.map((p) => {
			let dir = true;
			try {
				dir = fs.statSync(p).isDirectory();
			} catch {
				// Missing now: a subpath rule also covers it if it appears later.
			}
			const filter = dir ? 'subpath' : 'literal';
			return `(deny file-read* (${filter} "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"))`;
		})
		.join('\n');
	return SEATBELT_BASE + (network ? SEATBELT_NETWORK : '') + (deny ? `${deny}\n` : '');
}

const real = (p: string) => {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
};

// ---------------------------------------------------------------- Linux

let bwrapOk: boolean | undefined;
function bwrapWorks(): boolean {
	if (bwrapOk === undefined) {
		// User namespaces can be disabled (some distros, containers): try it once.
		const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', 'true'], { timeout: 5000 });
		bwrapOk = r.status === 0;
	}
	return bwrapOk;
}

export function bwrapArgs(root: string, shell: string, command: string, network: boolean, denyRead: string[] = []): string[] {
	const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', root, root, '--bind', '/tmp', '/tmp'];
	const tmp = real(os.tmpdir());
	if (tmp !== '/tmp' && fs.existsSync(tmp)) {
		args.push('--bind', tmp, tmp);
	}
	// A denied directory becomes an empty tmpfs; a denied file becomes /dev/null.
	for (const target of denyRead) {
		try {
			args.push(...(fs.statSync(target).isDirectory() ? ['--tmpfs', target] : ['--ro-bind', '/dev/null', target]));
		} catch {
			// Not on disk: nothing to mask.
		}
	}
	args.push('--die-with-parent', '--new-session');
	if (!network) {
		args.push('--unshare-net');
	}
	args.push('--chdir', root, '--', shell, '-c', command);
	return args;
}

// ---------------------------------------------------------------- Windows

interface WindowsProject { sid: string; root: string; tmp: string; deny?: string[]; preparedAt: number }
const ACL_RECHECK_MS = 60_000;
const aclChecked = new Map<string, number>();
const projectKey = (root: string) => path.resolve(root).toLowerCase();
const recordsFile = (storageDir: string) => path.join(storageDir, 'sandbox', 'projects.json');

function windowsRecords(storageDir: string): Record<string, WindowsProject> {
	try {
		const raw = JSON.parse(fs.readFileSync(recordsFile(storageDir), 'utf8'));
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

function saveRecords(storageDir: string, records: Record<string, WindowsProject>): void {
	const file = recordsFile(storageDir), temporary = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(temporary, JSON.stringify(records, null, 2));
	fs.renameSync(temporary, file);
}

/** A sandbox SID no real account has: a random identifier in the domain-SID shape the kernel accepts as a restricting SID. */
export function newSandboxSid(): string {
	const b = randomBytes(16);
	return `S-1-5-21-${[0, 4, 8, 12].map((i) => b.readUInt32LE(i)).join('-')}`;
}

/**
 * The paths sandboxed commands must not read, one per line in settings.
 * `~` is the home folder; blanks and `#` comments are ignored; a relative
 * path is ignored (it would depend on the command's own cwd).
 */
export function denyReadPaths(list: string, home = os.homedir()): string[] {
	const out: string[] = [];
	for (const raw of String(list ?? '').split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const expanded = line === '~' ? home : /^~[\\/]/.test(line) ? path.join(home, line.slice(2)) : line;
		if (!path.isAbsolute(expanded)) continue;
		const resolved = path.resolve(expanded);
		out.push(resolved);
		// A symlinked credentials folder also needs its target masked (lexical plus canonical, like Codex's ACL plan).
		try {
			const real = fs.realpathSync(resolved);
			if (real !== resolved) out.push(real);
		} catch {
			// Missing now: the lexical path is enough.
		}
	}
	return [...new Set(out)];
}

/**
 * What the app itself keeps and a sandboxed command never needs: provider keys,
 * settings (chat history lives in global state), workspace state, transcripts,
 * attached images and file checkpoints. Desktop layout only; VS Code keeps its
 * secrets in the OS keychain and this returns nothing there.
 */
export function appDenyReadPaths(storageDir: string, desktop = isDesktopHost()): string[] {
	if (!desktop || !storageDir || path.basename(path.resolve(storageDir)) !== 'global') return [];
	const data = path.dirname(path.resolve(storageDir));
	return [
		path.join(data, 'secrets.v2.json'),
		path.join(data, 'global-state.json'),
		path.join(data, 'workspaces'),
		path.join(storageDir, 'transcripts'),
		path.join(storageDir, 'images'),
		path.join(storageDir, 'checkpoints')
	];
}

/** The user's list plus what the app protects on its own. */
export function sandboxDenyPaths(settings: { sandboxDenyRead?: string }, storageDir: string, desktop = isDesktopHost()): string[] {
	return [...new Set([...denyReadPaths(settings.sandboxDenyRead ?? ''), ...appDenyReadPaths(storageDir, desktop)])];
}

/** Do two deny lists name the same paths (Windows compares case-insensitively)? */
export function sameDenyRead(a: string[], b: string[]): boolean {
	const key = (list: string[]) =>
		[...new Set(list.map((p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))))].sort().join('\n');
	return key(a) === key(b);
}

function aclHelper(exe: string, mode: 'grant' | 'check' | 'revoke' | 'deny' | 'undeny', sid: string, dirs: string[]): { status: number | null; detail: string } {
	const r = spawnSync(exe, [], { env: { ...process.env, ZER0NE_SANDBOX_ACL: mode, ZER0NE_SANDBOX_SID: sid, ZER0NE_SANDBOX_DIRS: dirs.join('|') }, encoding: 'utf8', timeout: 10 * 60_000, windowsHide: true });
	return { status: r.status, detail: String(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 300) };
}

/** The project's record when its folder and temp still grant its SID (checked at most once a minute). */
function preparedProject(root: string, storageDir: string, sourceFile: string): WindowsProject | undefined {
	const p = windowsRecords(storageDir)[projectKey(root)];
	if (!p || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(p.sid)) return undefined;
	const key = projectKey(root) + '\0' + p.sid;
	if (Date.now() - (aclChecked.get(key) ?? 0) < ACL_RECHECK_MS) return p;
	let exe: string;
	try { exe = jobExePath(storageDir, sourceFile); } catch { return undefined; }
	if (!fs.existsSync(exe) || !fs.existsSync(p.tmp) || aclHelper(exe, 'check', p.sid, [root, p.tmp]).status !== 0) return undefined;
	aclChecked.set(key, Date.now());
	return p;
}

/**
 * Prepare a project for the Windows sandbox (the user's explicit action): a new SID, its own temp
 * folder, an inherited Modify entry for that SID on both, and a deny-read entry for the configured
 * paths. Re-preparing replaces the old SID and its entries.
 */
export async function prepareWorkspace(root: string, storageDir: string, sourceFile: string, denyRead: string[] = []): Promise<WindowsProject> {
	if (process.platform !== 'win32') throw new Error('Only Windows projects need preparing.');
	const exe = await jobGuardExe({ storageDir, sourceFile });
	if (!exe) throw new Error('The sandbox helper could not be built: the .NET Framework C# compiler (csc.exe) is missing.');
	const real = fs.realpathSync(root);
	const records = windowsRecords(storageDir), key = projectKey(real), old = records[key];
	if (old) {
		aclHelper(exe, 'revoke', old.sid, [real, old.tmp].filter((d) => fs.existsSync(d)));
		if (old.deny?.length) aclHelper(exe, 'undeny', old.sid, old.deny.filter((d) => fs.existsSync(d)));
	}
	const sid = newSandboxSid();
	const tmp = path.join(storageDir, 'sandbox', 'tmp', sid.slice(9).replace(/-/g, '').slice(0, 16));
	fs.mkdirSync(tmp, { recursive: true });
	const granted = aclHelper(exe, 'grant', sid, [real, tmp]);
	if (granted.status !== 0) throw new Error(`Could not grant the project's sandbox access: ${granted.detail || `exit ${granted.status}`}`);
	if (aclHelper(exe, 'check', sid, [real, tmp]).status !== 0) throw new Error('The sandbox access did not apply to the project folder.');
	const denied = denyRead.filter((d) => fs.existsSync(d));
	if (denied.length) {
		const result = aclHelper(exe, 'deny', sid, denied);
		if (result.status !== 0) throw new Error(`Could not deny the sandbox read access to ${denied.join(', ')}: ${result.detail || `exit ${result.status}`}`);
	}
	records[key] = { sid, root: real, tmp, deny: denied, preparedAt: Date.now() };
	saveRecords(storageDir, records);
	aclChecked.delete(key + '\0' + sid);
	return records[key];
}

/** Undo preparation: the project's ACL entry goes, and its commands are no longer sandboxed. */
export async function unprepareWorkspace(root: string, storageDir: string, sourceFile: string): Promise<void> {
	const records = windowsRecords(storageDir), key = projectKey(root), p = records[key];
	if (!p) return;
	const exe = await jobGuardExe({ storageDir, sourceFile });
	if (exe) {
		aclHelper(exe, 'revoke', p.sid, [p.root, p.tmp].filter((d) => fs.existsSync(d)));
		if (p.deny?.length) aclHelper(exe, 'undeny', p.sid, p.deny.filter((d) => fs.existsSync(d)));
	}
	delete records[key];
	saveRecords(storageDir, records);
	fs.rmSync(p.tmp, { recursive: true, force: true });
}

// ---------------------------------------------------------------- public

export function sandboxStatus(root: string | undefined, storageDir: string, sourceFile: string, denyRead: string[] = [], userDenyRead = denyRead.length): SandboxStatus {
	// "Reads restricted" means the user chose paths; the app's own data is always blocked either way.
	const reads: 'all' | 'restricted' = userDenyRead ? 'restricted' : 'all';
	const readsText = userDenyRead
		? `reads restricted (${userDenyRead} chosen path${userDenyRead === 1 ? '' : 's'}; app data always blocked)`
		: 'reads unrestricted apart from the app’s own data';
	if (process.platform === 'darwin') {
		const ok = fs.existsSync('/usr/bin/sandbox-exec');
		return { kind: 'seatbelt', available: ok, network: true, reads, detail: ok ? `macOS Seatbelt · ${readsText}` : 'sandbox-exec not found' };
	}
	if (process.platform === 'linux') {
		const ok = bwrapWorks();
		return { kind: 'bwrap', available: ok, network: true, reads, detail: ok ? `bubblewrap · ${readsText}` : 'Install bubblewrap (bwrap) and allow unprivileged user namespaces' };
	}
	if (process.platform === 'win32') {
		if (!root) return { kind: 'restricted', available: false, network: false, reads, detail: 'Open a project folder to use the sandbox.' };
		const record = windowsRecords(storageDir)[projectKey(root)];
		const stale = !!record && !sameDenyRead(record.deny ?? [], denyRead.filter((p) => fs.existsSync(p)));
		const windowsReads = `${readsText}${stale ? ' — prepare the project again to apply the current list' : ''}`;
		if (preparedProject(root, storageDir, sourceFile)) {
			return {
				kind: 'restricted',
				available: true,
				network: false,
				reads,
				denyStale: stale,
				detail: `Windows restricted token: commands write only inside this project and its sandbox temp folder · ${windowsReads}`
			};
		}
		const win = process.env.SystemRoot || 'C:\\Windows';
		const csc = ['Framework64', 'Framework'].some((f) => fs.existsSync(path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')));
		if (!csc) return { kind: 'restricted', available: false, network: false, reads, detail: 'The sandbox needs the .NET Framework C# compiler (csc.exe), which is missing. Commands require approval.' };
		return { kind: 'restricted', available: false, needsPrepare: true, network: false, reads, detail: 'Prepare this project once: zer0ne gives the folder a write permission for this project\'s own sandbox ID. Until then commands require approval.' };
	}
	return { available: false, network: false, reads, detail: `No sandbox for ${process.platform}` };
}

/**
 * How to spawn `command` inside the sandbox. Returns undefined when this
 * platform/workspace cannot sandbox (the caller then decides whether to ask).
 */
export function sandboxSpawn(command: string, opts: { root: string; storageDir: string; sourceFile: string; network: boolean; env: NodeJS.ProcessEnv; denyRead?: string[] }): SandboxSpawn | undefined {
	const status = sandboxStatus(opts.root, opts.storageDir, opts.sourceFile, opts.denyRead);
	if (!status.available) {
		return undefined;
	}
	if (status.kind === 'seatbelt') {
		const shell = process.env.SHELL || '/bin/sh';
		return {
			file: '/usr/bin/sandbox-exec',
			args: ['-p', seatbeltProfile(opts.network, opts.denyRead), `-DWRITABLE_ROOT=${real(opts.root)}`, `-DTMPDIR=${real(os.tmpdir())}`, '--', shell, '-c', command],
			env: { ...opts.env, ZER0NE_SANDBOX: 'seatbelt' }
		};
	}
	if (status.kind === 'bwrap') {
		return { file: 'bwrap', args: bwrapArgs(opts.root, process.env.SHELL || '/bin/sh', command, opts.network, opts.denyRead), env: { ...opts.env, ZER0NE_SANDBOX: 'bwrap' } };
	}
	if (status.kind === 'restricted') {
		const p = preparedProject(opts.root, opts.storageDir, opts.sourceFile);
		if (!p) return undefined;
		// The job supervisor reads the SID and starts the shell with the restricted token (commandLaunch).
		return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', psCommand(command)], env: { ...opts.env, ...windowsSandboxEnv(opts.env, p) } };
	}
	return undefined;
}

/** Temp, npm's cache and Git's TLS backend for a command that may write only in the project and its temp. */
export function windowsSandboxEnv(env: NodeJS.ProcessEnv, p: { sid: string; tmp: string }): NodeJS.ProcessEnv {
	const count = Number(env.GIT_CONFIG_COUNT) || 0;
	return {
		TEMP: p.tmp, TMP: p.tmp, npm_config_cache: path.join(p.tmp, 'npm-cache'),
		GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'http.sslBackend', [`GIT_CONFIG_VALUE_${count}`]: 'openssl',
		ZER0NE_SANDBOX: 'windows', ZER0NE_SANDBOX_SID: p.sid
	};
}
