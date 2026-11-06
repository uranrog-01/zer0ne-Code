import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What an agent changed during one turn, whatever way it changed it (its own
 * edit tool, a shell command, a formatter): the working tree is written to a
 * git tree object before and after (a private temporary index; the repo's
 * index, branches and stash are never touched) and the two are compared.
 * Gives Undo and Review to agents that do not route their writes through us.
 * .gitignore is respected, so build output and node_modules are not scanned.
 */

export interface TurnChange {
	/** Forward-slash path relative to the workspace folder. */
	rel: string;
	/** Content before the turn (null = the file did not exist). */
	before: string | null;
	/** Content after (null = the file was deleted). */
	after: string | null;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, timeout = 12_000): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		execFile('git', args, { cwd, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'buffer' }, (err, stdout) => resolve({ ok: !err, out: stdout ? stdout.toString('utf8') : '' }));
	});
}

async function writeTree(cwd: string, index: string): Promise<string | undefined> {
	const env = { GIT_INDEX_FILE: index };
	fs.rmSync(index, { force: true });
	const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
	if (head.ok && !(await git(cwd, ['read-tree', 'HEAD'], env)).ok) return undefined;
	if (!(await git(cwd, ['add', '-A', '--', '.'], env, 25_000)).ok) return undefined;
	const tree = await git(cwd, ['write-tree'], env);
	return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.out.trim()) ? tree.out.trim() : undefined;
}

/** Start tracking a turn; undefined when the folder is not a git repository (or git is missing). */
export async function trackTurn(cwd: string): Promise<{ finish(): Promise<TurnChange[]> } | undefined> {
	const top = await git(cwd, ['rev-parse', '--show-toplevel']);
	if (!top.ok || !top.out.trim()) return undefined;
	// Where this folder sits inside the repository ("" at its top): git's own answer, not a path comparison — Windows spells one folder several ways.
	const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).out.trim();
	const index = path.join(os.tmpdir(), `zer0ne-turn-${process.pid}-${Date.now().toString(36)}.idx`);
	const start = await writeTree(cwd, index);
	if (!start) return undefined;
	return {
		async finish(): Promise<TurnChange[]> {
			try {
				const end = await writeTree(cwd, index);
				if (!end || end === start) return [];
				const diff = await git(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', start, end]);
				if (!diff.ok) return [];
				const parts = diff.out.split('\0').filter(Boolean);
				const changes: TurnChange[] = [];
				for (let i = 0; i + 1 < parts.length; i += 2) {
					const status = parts[i];
					const file = parts[i + 1];
					if (prefix && !file.startsWith(prefix)) continue; // outside the workspace folder (a parent repo)
					const rel = file.slice(prefix.length);
					const abs = path.join(cwd, ...rel.split('/'));
					let before: string | null = null;
					if (status !== 'A') {
						const blob = await git(cwd, ['cat-file', 'blob', `${start}:${file}`]);
						if (!blob.ok) continue;
						before = blob.out;
					}
					let after: string | null = null;
					if (status !== 'D') {
						try {
							after = fs.readFileSync(abs, 'utf8');
						} catch {
							continue;
						}
					}
					// Binary files have no text to restore or review.
					if ((before ?? '').includes('\0') || (after ?? '').includes('\0')) continue;
					changes.push({ rel, before, after });
				}
				return changes;
			} finally {
				fs.rmSync(index, { force: true });
			}
		}
	};
}
