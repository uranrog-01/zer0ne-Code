import * as vscode from 'vscode';
import { isDesktopHost } from './capabilities';
import * as path from 'path';
import { execFile } from 'child_process';

/**
 * Everything `@` can attach to a message:
 *
 *   @src/app.ts          a file
 *   @src/components/     a folder: its tree + the text of its files (budgeted)
 *   @src/app.ts:120      a symbol / line: the code around that line
 *   @selection           the editor selection
 *   @problems            errors and warnings from VS Code
 *   @changes             uncommitted git changes (diff + untracked files)
 *   @open                the files open in editor tabs
 */

export const SPECIAL_MENTIONS: Array<{ name: string; desc: string; icon: string }> = [
	{ name: 'selection', desc: 'Selected code in the editor', icon: 'pencil' },
	{ name: 'problems', desc: 'Errors and warnings in the workspace', icon: 'alert' },
	{ name: 'changes', desc: 'Uncommitted git changes', icon: 'branch' },
	{ name: 'open', desc: 'Files open in editor tabs', icon: 'file' }
];

const FILE_CAP = 40_000;
const FOLDER_BUDGET = 120_000;
const FOLDER_FILES = 60;
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|css|scss|less|html|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|yml|yaml|toml|ini|sql|graphql|proto|xml|env\.example|gradle|dart|lua|r|scala|ex|exs|clj)$/i;

function root(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function readText(uri: vscode.Uri, cap = FILE_CAP): Promise<string | undefined> {
	try {
		const bytes = await vscode.workspace.fs.readFile(uri);
		if (bytes.subarray(0, 8000).includes(0)) {
			return undefined;
		}
		const text = new TextDecoder().decode(bytes);
		return text.length > cap ? text.slice(0, cap) + `\n[… truncated, ${text.length} characters]` : text;
	} catch {
		return undefined;
	}
}

/** A folder as context: a tree of all its files, then the text of the first ones within a budget. */
export async function folderContext(dirUri: vscode.Uri, label: string): Promise<{ name: string; content: string } | undefined> {
	const found = await vscode.workspace.findFiles(new vscode.RelativePattern(dirUri, '**/*'), '**/{node_modules,.git,out,dist,build,.next,coverage,__pycache__,.venv}/**', 2000);
	const inside = found.map((u) => path.relative(dirUri.fsPath, u.fsPath).replace(/\\/g, '/')).sort();
	if (!inside.length) {
		return undefined;
	}
	const tree = inside.slice(0, 400).map((f) => '  ' + f).join('\n');
	const parts = [`Folder ${label} — ${inside.length} files${inside.length > 400 ? ' (first 400 listed)' : ''}:\n${tree}`];
	let used = parts[0].length;
	let included = 0;
	// Shallow files first: they are usually the entry points.
	const ordered = inside.filter((f) => TEXT_EXT.test(f)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
	for (const f of ordered) {
		if (included >= FOLDER_FILES || used > FOLDER_BUDGET) {
			break;
		}
		const text = await readText(vscode.Uri.joinPath(dirUri, f), Math.min(FILE_CAP, FOLDER_BUDGET - used));
		if (text === undefined) {
			continue;
		}
		parts.push(`=== ${f} ===\n${text}`);
		used += text.length + f.length + 9;
		included++;
	}
	if (included < ordered.length) {
		parts.push(`[${ordered.length - included} more files not included — read them with read_file if needed]`);
	}
	return { name: label, content: parts.join('\n\n') };
}

/** `@path:line` — the code around a line (the enclosing symbol when the language server knows it). */
export async function lineContext(rel: string, line: number): Promise<{ name: string; content: string } | undefined> {
	const r = root();
	if (!r) {
		return undefined;
	}
	const uri = vscode.Uri.joinPath(r, rel);
	const text = await readText(uri, 2_000_000);
	if (text === undefined) {
		return undefined;
	}
	const lines = text.split('\n');
	let start = Math.max(0, line - 6);
	let end = Math.min(lines.length, line + 60);
	try {
		const syms = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
		let best: vscode.DocumentSymbol | undefined;
		const walk = (list: vscode.DocumentSymbol[]) => {
			for (const s of list) {
				if (s.range && s.range.start.line <= line - 1 && s.range.end.line >= line - 1) {
					best = s;
					walk(s.children ?? []);
				}
			}
		};
		walk(syms.filter((s) => 'range' in s));
		if (best && best.range.end.line - best.range.start.line < 400) {
			start = best.range.start.line;
			end = best.range.end.line + 1;
		}
	} catch {
		/* plain window */
	}
	const body = lines.slice(start, end).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
	return { name: `${rel}:${start + 1}-${end}`, content: body };
}

function git(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve) => execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, timeout: 15_000 }, (err, out) => resolve(err ? '' : String(out))));
}

/** @selection / @problems / @changes / @open. */
export async function specialContext(name: string): Promise<{ name: string; content: string } | undefined> {
	const r = root();
	if (isDesktopHost() && ['selection', 'problems', 'open'].includes(name)) return {name:'@' + name,content:'Editor context and language-service diagnostics are unavailable in this desktop app. Run the project checks instead.'};
	if (name === 'selection') {
		const ed = vscode.window.activeTextEditor;
		if (!ed || ed.selection.isEmpty) {
			return { name: '@selection', content: '(nothing is selected in the editor)' };
		}
		const s = ed.selection;
		return { name: `${vscode.workspace.asRelativePath(ed.document.uri)}:${s.start.line + 1}-${s.end.line + 1} (selection)`, content: ed.document.getText(s) };
	}
	if (name === 'problems') {
		const rows: string[] = [];
		for (const [uri, diags] of vscode.languages.getDiagnostics()) {
			if (r && !uri.fsPath.startsWith(r.fsPath)) {
				continue;
			}
			for (const d of diags) {
				if (d.severity > vscode.DiagnosticSeverity.Warning) {
					continue;
				}
				rows.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'} ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`);
			}
		}
		return { name: '@problems', content: rows.length ? rows.slice(0, 300).join('\n') + (rows.length > 300 ? `\n[… ${rows.length - 300} more]` : '') : 'No errors or warnings.' };
	}
	if (name === 'changes') {
		if (!r) {
			return undefined;
		}
		const [status, diff] = await Promise.all([git(['status', '--porcelain'], r.fsPath), git(['diff', 'HEAD', '--stat', '-p', '--no-color'], r.fsPath)]);
		const content = (status.trim() ? `git status:\n${status.trim()}\n\n` : '') + (diff.trim() ? diff.slice(0, 80_000) : 'No uncommitted changes (or not a git repository).');
		return { name: '@changes', content };
	}
	if (name === 'open') {
		const files: string[] = [];
		for (const g of vscode.window.tabGroups.all) {
			for (const tab of g.tabs) {
				if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
					files.push(vscode.workspace.asRelativePath(tab.input.uri));
				}
			}
		}
		const unique = [...new Set(files)].slice(0, 12);
		const parts: string[] = [];
		for (const f of unique) {
			const uri = r ? vscode.Uri.joinPath(r, f) : vscode.Uri.file(f);
			const text = await readText(uri, 20_000);
			if (text !== undefined) {
				parts.push(`=== ${f} ===\n${text}`);
			}
		}
		return { name: '@open', content: parts.join('\n\n') || 'No files are open.' };
	}
	return undefined;
}

/** Workspace symbols for the popup (`@` + a name). */
export async function searchSymbols(query: string): Promise<Array<{ name: string; kind: string; path: string; line: number; container?: string }>> {
	const r = root();
	if (isDesktopHost() || !r || query.length < 2) {
		return [];
	}
	const KINDS: Record<number, string> = { 4: 'class', 5: 'method', 10: 'enum', 11: 'interface', 12: 'function', 13: 'variable', 14: 'constant', 22: 'struct', 25: 'type' };
	try {
		const syms = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query)) ?? [];
		return syms
			.filter((s) => s.location.uri.fsPath.startsWith(r.fsPath) && KINDS[s.kind] && !/node_modules|[\\/]out[\\/]|[\\/]dist[\\/]/.test(s.location.uri.fsPath))
			.slice(0, 20)
			.map((s) => ({ name: s.name, kind: KINDS[s.kind], path: path.relative(r.fsPath, s.location.uri.fsPath).replace(/\\/g, '/'), line: s.location.range.start.line + 1, container: s.containerName || undefined }));
	} catch {
		return [];
	}
}

/** Resolve only files supplied by the owner, using the owner’s path and deny-rule checks. */
export async function resolveMentions(text: string, listFiles: () => Promise<string[]>, root: vscode.Uri | undefined, resolve: (name: string) => vscode.Uri): Promise<Array<{ name: string; content: string }>> {
		const tokens = [...new Set([...text.matchAll(/(?:^|\s)@([\w\-./\\:]+)/g)].map((m) => m[1].replace(/\\/g, '/').replace(/[.,;:]+$/, '')))];
		if (!tokens.length) {
			return [];
		}
		const files = await listFiles();
		const out: Array<{ name: string; content: string }> = [];
		
		for (const token of tokens) {
			const exact = files.includes(token);
			if (!exact && SPECIAL_MENTIONS.some((s) => s.name === token)) {
				const ctx = await specialContext(token);
				if (ctx) {
					out.push(ctx);
				}
				continue;
			}
			const at = /^(.+?):(\d+)$/.exec(token);
			if (at && files.includes(at[1])) {
				const ctx = await lineContext(at[1], Number(at[2]));
				if (ctx) {
					out.push(ctx);
				}
				continue;
			}
			const dir = token.replace(/\/+$/, '');
			if (root && !exact && (token.endsWith('/') || files.some((f) => f.startsWith(dir + '/')))) {
				const ctx = await folderContext(vscode.Uri.joinPath(root, dir), dir + '/');
				if (ctx) {
					out.push(ctx);
				}
				continue;
			}
			const match = exact ? token : files.find((f) => f.endsWith('/' + token));
			if (!match) {
				continue;
			}
			try {
				const bytes = await vscode.workspace.fs.readFile(resolve(match));
				if (bytes.subarray(0, 8000).includes(0)) {
					continue;
				}
				let content = new TextDecoder().decode(bytes);
				if (content.length > 40_000) {
					content = content.slice(0, 40_000) + '\n[… truncated]';
				}
				out.push({ name: match, content });
			} catch {
				// unreadable mention — skip
			}
		}
		return out;
	}
