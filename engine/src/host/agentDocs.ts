import * as fs from 'fs';
import * as path from 'path';

/**
 * The AGENTS.md chain for a workspace, the way Codex reads it: the repository
 * root's instructions first, then each directory down to the workspace (a
 * package inside a monorepo opened on its own still sees the repo's rules).
 * `AGENTS.override.md` replaces `AGENTS.md` in its own directory.
 *
 * Only the reachable chain is returned; directories above the repository root
 * are never included. No vscode import, so the walk is unit-testable.
 */
export function agentDocChain(root: string): string[] {
	const start = path.resolve(root);
	let repo = start;
	for (let dir = start; ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, '.git'))) {
			repo = dir;
			break;
		}
		if (path.dirname(dir) === dir) break;
	}
	const dirs: string[] = [];
	for (let dir = start; ; dir = path.dirname(dir)) {
		dirs.unshift(dir);
		if (dir === repo || path.dirname(dir) === dir) break;
	}
	const files: string[] = [];
	for (const dir of dirs) {
		for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
			const file = path.join(dir, name);
			if (fs.existsSync(file)) {
				files.push(file);
				break;
			}
		}
	}
	return files;
}
