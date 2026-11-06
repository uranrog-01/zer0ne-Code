/**
 * Deny rules: workspace paths the agent may never read, write, search or
 * list (key material, credentials…). One glob per line, gitignore-style:
 *   `**` any folders, `*` within a name, `?` one character; a pattern without
 * a slash matches the file name anywhere.
 */

export function globToRegExp(glob: string): RegExp {
	let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
	const anywhere = !g.includes('/');
	if (g.endsWith('/')) {
		g += '**';
	}
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*' && g[i + 1] === '*') {
			const slash = g[i + 2] === '/';
			re += slash ? '(?:.*/)?' : '.*';
			i += slash ? 2 : 1;
		} else if (c === '*') {
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`, 'i');
}

export function compileDeny(lines: string): (relPath: string) => boolean {
	const rules = lines
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'))
		.map(globToRegExp);
	return (relPath) => {
		const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
		return rules.some((r) => r.test(p));
	};
}

/** ripgrep exclusions for the same rules. */
export function denyGlobs(lines: string): string[] {
	return lines
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith('#'))
		.map((l) => `!${l.includes('/') ? l : '**/' + l}`);
}
