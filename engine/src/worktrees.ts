import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { slugify } from './tools/skills';

/**
 * Git worktrees for parallel tasks. Each task gets its own checkout on a new
 * branch (`zer0ne/<task>`), next to the repository in `<repo>.worktrees/`,
 * opened in its own VS Code window — agents working there can never touch
 * the files of your main folder. Merge the branch back when you are happy.
 */

export interface WorktreeInfo {
	path: string;
	branch?: string;
	head?: string;
	main: boolean;
	locked?: boolean;
}

function git(args: string[], cwd: string, timeout = 60_000): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile('git', args, { cwd, windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
			err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400))) : resolve(String(stdout))
		)
	);
}

export async function repoRoot(cwd: string): Promise<string> {
	try {
		return path.resolve((await git(['rev-parse', '--show-toplevel'], cwd)).trim());
	} catch {
		throw new Error('This folder is not a Git repository. Initialize Git (and make a first commit) to use worktrees.');
	}
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	const root = await repoRoot(cwd);
	const out = await git(['worktree', 'list', '--porcelain'], root);
	const list: WorktreeInfo[] = [];
	let cur: WorktreeInfo | undefined;
	for (const line of out.split(/\r?\n/)) {
		if (line.startsWith('worktree ')) {
			cur = { path: path.resolve(line.slice(9)), main: list.length === 0 };
			list.push(cur);
		} else if (cur && line.startsWith('branch ')) {
			cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
		} else if (cur && line.startsWith('HEAD ')) {
			cur.head = line.slice(5, 12);
		} else if (cur && line.startsWith('locked')) {
			cur.locked = true;
		}
	}
	return list;
}

/** The main checkout, even when `cwd` is a linked worktree of it. */
async function mainCheckout(root: string): Promise<string> {
	try {
		const list = await listWorktrees(root);
		return list.find(w => w.main)?.path ?? root;
	} catch {
		return root;
	}
}

/** Create `<repo>.worktrees/<slug>` on a new branch `zer0ne/<slug>` from the current HEAD. */
export async function createWorktree(cwd: string, task: string, revision = 'HEAD'): Promise<WorktreeInfo> {
	if (revision !== 'HEAD' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error('Worktree base must be an exact Git commit.');
	// Always place new checkouts beside the main repository, never beside a linked worktree.
	const root = await mainCheckout(await repoRoot(cwd));
	try {
		await git(['rev-parse', '--verify', 'HEAD'], root);
	} catch {
		throw new Error('The repository has no commits yet — make a first commit, then try again.');
	}
	const base = slugify(task) || 'task';
	const parent = `${root}.worktrees`;
	let slug = base;
	for (let n = 2; fs.existsSync(path.join(parent, slug)) || (await branchExists(root, `zer0ne/${slug}`)); n++) {
		slug = `${base}-${n}`;
	}
	const dir = path.join(parent, slug);
	fs.mkdirSync(parent, { recursive: true });
	try {
		await git(['worktree', 'add', '-b', `zer0ne/${slug}`, dir, revision], root, 120_000);
	} catch (error) {
		try { fs.rmdirSync(dir); } catch { /* Git may have created part of the checkout. */ }
		throw error;
	}
	return { path: dir, branch: `zer0ne/${slug}`, main: false };
}

async function branchExists(root: string, branch: string): Promise<boolean> {
	try {
		await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
		return true;
	} catch {
		return false;
	}
}

/** Forget registrations of checkouts whose folders were deleted outside Git. */
export async function pruneWorktrees(cwd: string): Promise<void> {
	const root = await repoRoot(cwd);
	await git(['worktree', 'prune'], root);
}

/** Remove a worktree folder (its branch stays, so nothing committed is lost). */
export async function removeWorktree(cwd: string, dir: string, force: boolean): Promise<void> {
	const root = await repoRoot(cwd);
	await git(['worktree', 'remove', ...(force ? ['--force'] : []), dir], root);
	// Removing the checkout already deregisters it; prune only clears anything left behind.
	try { await pruneWorktrees(root); } catch { /* The requested checkout is gone either way. */ }
}

/** Uncommitted changes in a worktree (to warn before removing it). A failed check must be shown, not treated as clean. */
export async function isDirty(dir: string): Promise<boolean> {
	return (await git(['status', '--porcelain'], dir)).trim().length > 0;
}
