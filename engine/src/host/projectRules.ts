import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { workspaceRoot } from '../tools/agentTools';
import { agentDocChain } from './agentDocs';

const LEARNED = '## Learned from corrections';

/**
 * Adds one line to the project's AGENTS.md, under its own heading, so a lesson reaches
 * every agent that reads the file (zer0ne, Claude Code, Codex…) and the whole team.
 * Returns false when the line is already there.
 */
export function addProjectInstruction(root: string, text: string): boolean {
	const line = text.replace(/\s+/g, ' ').trim();
	if (!line || line.length > 2000) throw new Error('An instruction is one line under 2,000 characters.');
	const file = path.join(root, 'AGENTS.md');
	let current = '';
	try { current = fs.readFileSync(file, 'utf8'); } catch { /* a new file */ }
	if (current.split(/\r?\n/).some((l) => l.replace(/^[-*]\s+/, '').trim() === line)) return false;
	const eol = current.includes('\r\n') ? '\r\n' : '\n';
	const body = current && !current.endsWith('\n') ? current + eol : current;
	fs.writeFileSync(file, body.includes(LEARNED) ? insertUnder(body, line, eol) : `${body}${body ? eol : ''}${LEARNED}${eol}${eol}- ${line}${eol}`);
	return true;
}

/** The new line goes at the end of the Learned section (before the next heading). */
function insertUnder(text: string, line: string, eol: string): string {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === LEARNED);
	let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
	if (end < 0) end = lines.length;
	while (end > start + 1 && !lines[end - 1].trim()) end--;
	lines.splice(end, 0, `- ${line}`);
	return lines.join(eol);
}

/** Workspace AGENTS.md / CLAUDE.md, the de-facto agent instruction files. */
export async function projectInstructions(): Promise<string> {
	const root = workspaceRoot();
	if (!root) {
		return '';
	}
	// Every rules format other agents use, so a project set up for Claude Code,
	// Codex, Cline, Cursor, Kilo, Copilot or OpenClaw (SOUL.md persona) works here unchanged.
	const files = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SOUL.md', '.github/copilot-instructions.md', '.clinerules', '.cursorrules', '.windsurfrules'];
	const dirs = ['.zer0ne/rules', '.clinerules', '.cursor/rules', '.kilocode/rules', '.roo/rules'];
	const read = async (uri: vscode.Uri) => {
		try {
			return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).trim();
		} catch {
			return '';
		}
	};
	const parts: string[] = [];
	const seen = new Set<string>();
	let budget = 16_000;
	const add = (name: string, text: string) => {
		const key = text.slice(0, 400);
		if (!text || seen.has(key) || budget <= 0) {
			return;
		}
		seen.add(key);
		const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').slice(0, budget);
		budget -= body.length;
		parts.push(`Project instructions from ${name}:\n${body}`);
	};
	// Instructions above the workspace: a package opened inside a monorepo still
	// sees the repository's AGENTS.md chain (repository root first, like Codex).
	if (root.scheme === 'file') {
		const start = path.resolve(root.fsPath);
		for (const file of agentDocChain(root.fsPath)) {
			if (path.dirname(file) === start) continue;
			try {
				add(file, (await fs.promises.readFile(file, 'utf8')).trim());
			} catch {
				// An unreadable ancestor file is not instructions.
			}
		}
	}
	// A local override replaces AGENTS.md in the workspace, without editing the shared file.
	const override = await read(vscode.Uri.joinPath(root, 'AGENTS.override.md'));
	if (override) {
		add('AGENTS.override.md', override);
	}
	for (const name of files) {
		if (name === 'AGENTS.md' && override) continue;
		add(name, await read(vscode.Uri.joinPath(root, name)));
	}
	for (const dir of dirs) {
		try {
			const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, dir));
			for (const [file, type] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
				if (type === vscode.FileType.File && /\.(md|mdc|txt)$/i.test(file)) {
					add(`${dir}/${file}`, await read(vscode.Uri.joinPath(root, dir, file)));
				}
			}
		} catch {
			// not present (or a file, handled above)
		}
	}
	return parts.length ? '\n\n' + parts.join('\n\n') : '';
}
