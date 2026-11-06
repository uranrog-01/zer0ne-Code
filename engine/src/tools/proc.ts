import { ChildProcess, execFile } from 'child_process';

/**
 * Environment for helper processes the extension spawns itself (the engine,
 * the tunnel, converters, recorders). They never call an API on the user's
 * behalf, so credential-shaped variables are dropped before they can leak
 * into logs or third-party code; everything else (GPU runtimes, PATH,
 * locale) passes through. Agent commands (run_command, the verify command)
 * get the same treatment unless the user turns off "Hide secrets from agent
 * commands"; ACP agents keep their full environment.
 */
const CREDENTIAL_ENV = /api[-_]?key|[-_]token|secret|password|passwd|credential|private[-_]key|auth[-_]?token|aws_access|aws_secret|signing[-_]key|(^|_)(token|pat|auth|authorization|key)(_|$)/i;

/**
 * Git reads GIT_CONFIG_COUNT with its KEY_n/VALUE_n pairs as one unit: dropping a KEY_n (its name
 * matches CREDENTIAL_ENV) makes every git command fail, and a kept VALUE_n can carry an auth
 * header. The family goes together.
 */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/i;

export function scrubEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(base)) {
		if (v === undefined || CREDENTIAL_ENV.test(k) || GIT_CONFIG_ENV.test(k)) {
			continue;
		}
		out[k] = v;
	}
	return out;
}

/**
 * Kill a process and everything it started. On Windows, killing a shell
 * (cmd.exe / powershell.exe) leaves its children running, so the whole
 * tree is ended with `taskkill /T /F`.
 */
export function killTree(proc: ChildProcess | undefined): void {
	if (!proc || proc.exitCode !== null || proc.pid === undefined) {
		return;
	}
	if (process.platform === 'win32') {
		execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => undefined);
	} else {
		try {
			// Helpers spawned detached own a process group; ordinary children may not.
			process.kill(-proc.pid, 'SIGTERM');
		} catch {
			try { proc.kill('SIGTERM'); } catch { /* already gone */ }
		}
	}
}

/**
 * `powershell -Command` exits 1 for any failing native command, hiding its real
 * exit code (so a hook's "exit 2 = block" never blocked, and `npm test` exit 2
 * read as 1). Re-raise the native code when the last command failed (1 for a failing cmdlet).
 */
export function psCommand(command: string): string {
	return process.platform === 'win32' ? `${command}\n$__ok = $?; if (-not $__ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }` : command;
}
