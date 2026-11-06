import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';

/**
 * Windows command governance: agent commands run through the job supervisor
 * (`media/sandbox/job.cs`, compiled on first use like the input helper) so the
 * command's whole tree dies with the engine even when the engine crashes
 * mid-turn. Best effort: without the in-box C# compiler commands run as before
 * (plain spawn + taskkill), which is today's behavior.
 */

/** argv as ZER0NE_JOB_ARGS: `<count>;<len1>:<arg1>…` in UTF-16 code units (job.cs Unpack). */
export function encodeJobArgs(args: string[]): string {
	return `${args.length};` + args.map((a) => `${a.length}:${a}`).join('');
}

/** Where this version of the supervisor is (or will be) compiled; it is versioned by its source. */
export function jobExePath(storageDir: string, sourceFile: string): string {
	const source = path.join(path.dirname(sourceFile), 'job.cs');
	const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 20);
	return path.join(storageDir, 'sandbox', `zer0ne-job-${hash}.exe`);
}

/** The compiled supervisor, or undefined when it cannot be built here. */
export async function jobGuardExe(opts: { storageDir?: string; sourceFile?: string; signal?: AbortSignal }): Promise<string | undefined> {
	if (process.platform !== 'win32' || !opts.storageDir || !opts.sourceFile) {
		return undefined;
	}
	try {
		const source = path.join(path.dirname(opts.sourceFile), 'job.cs');
		const exe = jobExePath(opts.storageDir, opts.sourceFile);
		if (fs.existsSync(exe)) {
			return exe;
		}
		const win = process.env.SystemRoot || 'C:\\Windows';
		const csc = ['Framework64', 'Framework'].map((f) => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find((p) => fs.existsSync(p));
		if (!csc) {
			return undefined;
		}
		fs.mkdirSync(path.dirname(exe), { recursive: true });
		const temp = path.join(path.dirname(exe), `job-${randomUUID()}.exe`);
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawnSync(csc, ['-nologo', '-optimize', `-out:${temp}`, source], { timeout: 60_000, windowsHide: true });
				if (child.error) {
					reject(child.error);
				} else if (child.status !== 0) {
					reject(new Error(`csc exited ${child.status}: ${String(child.stderr || child.stdout || '').slice(0, 400)}`));
				} else {
					resolve();
				}
			});
			opts.signal?.throwIfAborted();
			// Another engine may have finished compiling the same version while this one waited.
			try {
				fs.renameSync(temp, exe);
			} catch (error) {
				if (!fs.existsSync(exe)) {
					throw error;
				}
			}
		} finally {
			fs.rmSync(temp, { force: true });
		}
		return exe;
	} catch (error) {
		// Governance is best effort; the command still runs (approved) without it.
		console.warn('[job-guard] supervisor unavailable, commands run without a job:', error instanceof Error ? error.message : error);
		return undefined;
	}
}
