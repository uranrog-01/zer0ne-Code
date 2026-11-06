import { applyLineEdits, contentTag, skeleton, type LineEdit } from './skeleton';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDef } from '../chatClient';
import { adaptReplacement, applyChunks, findUnique, matchNote, parsePatch } from '../tools/patch';
import { FileGuard } from '../tools/fileGuard';
import { approveCommand, executeCommand, type CommandContext } from '../tools/command';
import { rgFiles, rgSearch } from '../tools/ripgrep';
import { compressOutput, spillOutput } from '../tools/tokenSaver';
import { editNotebook, renderNotebook } from './notebook';
import { compileDeny, denyGlobs } from '../tools/deny';
import { noLinks, relativePath } from '../tools/extensionFiles';
import { assertNoRedaction } from '../tools/redact';

/**
 * The agent's file and shell tools, rooted at any folder and free of VS
 * Code — the core the CLI, the ACP server (Zed / JetBrains) and the
 * worktree writer subagents share. Every change goes through `approve`
 * (which may say yes automatically, e.g. inside an isolated worktree).
 */

export interface ApproveRequest {
	kind: 'edit' | 'write' | 'delete' | 'command' | 'notebook';
	title: string;
	path?: string;
	command?: string;
	oldText?: string | null;
	newText?: string;
	/** Commands: runs inside the OS sandbox (writes confined to the root). */
	sandboxed?: boolean;
	projectRule?: 'allow' | 'ask' | 'deny' | 'pending';
}

export interface ToolResult {
	exitCode?: number;
	timedOut?: boolean;
	output: string;
	summary: string;
	error?: boolean;
	/** For clients that show diffs (ACP). Absolute path. */
	diff?: { path: string; oldText: string | null; newText: string };
	/** Files touched (absolute), for "follow along" in clients. */
	locations?: string[];
}

export interface CoreOptions {
	denyPaths?: string;
	signal?: AbortSignal;
	commandEnabled?: boolean;
	hideCommandSecrets?: boolean;
	commandContext?: CommandContext;
	root: string;
	approve: (req: ApproveRequest) => Promise<boolean>;
	readOnly?: boolean;
	/** Run commands in the OS sandbox when one is available (writes only inside root). */
	sandbox?: { storageDir: string; sourceFile: string; network: boolean };
	env?: NodeJS.ProcessEnv;
	/** Called after a file changes (undo / review). `before` null = new file. */
	onChange?(relPath: string, before: string | null, after: string): void;
	tokenSaver?: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|\.next|coverage|__pycache__|\.venv)(\/|$)/;

export const CORE_TOOLS: ToolDef[] = [
	{ name: 'list_files', description: 'List files matching a glob (respects .gitignore). Returns relative paths.', parameters: obj({ glob: { type: 'string', description: 'e.g. "src/**/*.ts" (default all files)' } }) },
	{ name: 'read_file', description: 'Read a text file with line numbers (the "N\\t" prefix is not part of the file). Notebooks are shown as numbered cells. A large source file read without offset/limit comes back as its skeleton (long bodies folded into "⋯ N lines folded (a–b)" markers — read that range, or pass full: true). Every read ends with the file\'s [tag xxxx] for edit_lines.', parameters: obj({ path: { type: 'string' }, offset: { type: 'number', description: '1-based first line' }, limit: { type: 'number' }, full: { type: 'boolean', description: 'Whole file, no skeleton' } }, ['path']) },
	{ name: 'edit_lines', description: 'Edit a file by line numbers from your latest read_file (no retyping old text). Give its [tag]; a changed file is refused. Each edit replaces lines start..end (inclusive) with text; "" deletes; end = start - 1 inserts before start. Ranges refer to the file as read and must not overlap.', parameters: obj({ path: { type: 'string' }, tag: { type: 'string' }, edits: { type: 'array', items: obj({ start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' } }, ['start', 'end', 'text']) } }, ['path', 'tag', 'edits']) },
	{ name: 'grep', description: 'Search file contents with a regular expression (case-insensitive, ripgrep syntax). Returns path:line: text. Options: output "files" or "count"; before/after context lines (0-20); case_sensitive; fixed (literal).', parameters: obj({ pattern: { type: 'string' }, glob: { type: 'string' }, case_sensitive: { type: 'boolean' }, fixed: { type: 'boolean' }, output: { type: 'string', enum: ['content', 'files', 'count'] }, before: { type: 'number' }, after: { type: 'number' } }, ['pattern']) },
	{ name: 'edit_file', description: 'Replace an exact snippet in a file (old_string must be unique unless replace_all).', parameters: obj({ path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
	{ name: 'write_file', description: 'Create a file or overwrite it with the complete content.', parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },
	{ name: 'apply_patch', description: 'Apply a multi-file patch in the *** Begin Patch / *** Update File / *** Add File / *** Delete File / *** End Patch format.', parameters: obj({ patch: { type: 'string' } }, ['patch']) },
	{ name: 'notebook_edit', description: 'Edit one Jupyter notebook cell: replace its source, insert a new cell at a position, or delete it. Cells are numbered from 1 as read_file shows them.', parameters: obj({ path: { type: 'string' }, cell: { type: 'number' }, mode: { type: 'string', enum: ['replace', 'insert', 'delete'] }, source: { type: 'string' }, cell_type: { type: 'string', enum: ['code', 'markdown'] } }, ['path', 'cell', 'mode']) },
	{ name: 'run_command', description: 'Run a shell command in the project folder and return its exit code and output. Never run interactive commands.', parameters: obj({ command: { type: 'string' }, timeout_seconds: { type: 'number', description: 'default 120, max 600' } }, ['command']) }
];
const WRITES = new Set(['edit_file', 'edit_lines', 'write_file', 'apply_patch', 'notebook_edit', 'run_command']);

/** One CoreTools instance serves one agent, so its reads form a single read-before-edit scope. */
const SCOPE = 'agent';

/**
 * The largest file this tool core will read into memory. Without it a single large file in the
 * workspace takes the whole engine down. The limit can be moved with ZER0NE_MAX_READ_BYTES.
 */
const MAX_READ_BYTES = 20 * 1024 * 1024;

export class CoreTools {
	/** Read-before-edit / write-if-unchanged (see tools/fileGuard.ts). */
	private readonly guard = new FileGuard();

	constructor(private readonly o: CoreOptions) {
		if (fs.existsSync(o.root)) o.root = fs.realpathSync(o.root);
	}

	get root(): string {
		return this.o.root;
	}

	defs(): ToolDef[] {
		return this.o.readOnly ? CORE_TOOLS.filter((t) => !WRITES.has(t.name)) : CORE_TOOLS;
	}

	/** Absolute path inside the root (throws on ../ escapes). */
	abs(p: unknown): string {
		const a = path.resolve(this.o.root, String(p ?? '.'));
		const r = path.resolve(this.o.root);
		const rel = path.relative(r, a);
		if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
			throw new Error(`${p} is outside the project folder.`);
		}
		relativePath(rel.split(path.sep).join('/'), true);
		noLinks(a);
		if (rel && (rel.split(path.sep).some(part => part.toLowerCase() === '.git') || compileDeny(this.o.denyPaths ?? '')(rel))) throw new Error(`${p} is protected by deny rules.`);
		if (fs.existsSync(a) && fs.statSync(a).isFile() && fs.statSync(a).nlink > 1) throw new Error(`${p} is a hard-linked file; access is refused.`);
		return a;
	}
	private rel(a: string): string {
		return path.relative(this.o.root, a).split(path.sep).join('/');
	}

	async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		signal = signal && this.o.signal ? AbortSignal.any([signal, this.o.signal]) : signal ?? this.o.signal;
		try {
			this.o.signal?.throwIfAborted(); signal?.throwIfAborted();
			if (name === 'run_command' && this.o.commandEnabled === false) throw new Error('Commands are disabled.');
			if (this.o.readOnly && WRITES.has(name)) {
				throw new Error(`${name} is not available to a read-only agent.`);
			}
			switch (name) {
				case 'list_files':
					return await this.listFiles(String(args.glob || '**/*'));
				case 'read_file':
					return this.readFile(args);
				case 'grep':
					return await this.grep(String(args.pattern ?? ''), String(args.glob || ''), signal, {
						caseSensitive: args.case_sensitive === true,
						fixed: args.fixed === true,
						after: Math.max(0, Math.min(20, Number(args.after) || 0)) || undefined,
						before: Math.max(0, Math.min(20, Number(args.before) || 0)) || undefined,
						output: ['content', 'files', 'count'].includes(String(args.output)) ? (String(args.output) as 'content' | 'files' | 'count') : undefined
					});
				case 'edit_file':
					return await this.editFile(args);
				case 'edit_lines':
					return await this.editLines(args);
				case 'write_file':
					return await this.writeFile(String(args.path), String(args.content ?? ''));
				case 'apply_patch':
					return await this.applyPatch(String(args.patch ?? ''));
				case 'notebook_edit':
					return await this.notebookEdit(args);
				case 'run_command':
					return await this.runCommand(String(args.command ?? ''), Math.min(600, Number(args.timeout_seconds) || 120), signal);
				default:
					return { output: `Error: unknown tool "${name}".`, summary: 'unknown tool', error: true };
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { output: `Error: ${msg}`, summary: msg.slice(0, 120), error: true };
		}
	}

	private async listFiles(glob: string): Promise<ToolResult> {
		const rg = await rgFiles(this.o.root, glob, 1000, denyGlobs(this.o.denyPaths ?? ''));
		let files = rg?.files;
		if (!files) {
			const re = globRe(glob);
			files = walk(this.o.root, this.o.root).filter((f) => re.test(f));
		}
		files = files.filter(f => { try { this.abs(f); return true; } catch { return false; } });
		return { output: files.slice(0, 600).join('\n') || '(no files matched)', summary: `${files.length} files` };
	}

	private readFile(args: Record<string, unknown>): ToolResult {
		const a = this.abs(args.path);
		const stat = fs.statSync(a);
		if (stat.isDirectory()) {
			const entries = fs.readdirSync(a, { withFileTypes: true }).filter(e => { try { this.abs(path.join(a, e.name)); return true; } catch { return false; } }).map((e) => e.name + (e.isDirectory() ? '/' : ''));
			return { output: entries.join('\n'), summary: `${entries.length} entries`, locations: [a] };
		}
		// Reading a whole file into memory is how one large file takes the engine down.
		if (stat.size > MAX_READ_BYTES) {
			throw new Error(`${this.rel(a)} is ${(stat.size / 1048576).toFixed(1)} MB — too large to read whole. Use grep to search it, or read a part of it (read_file with offset and limit).`);
		}
		let text = fs.readFileSync(a, 'utf8');
		this.guard.observe(SCOPE, a, text);
		if (/\.ipynb$/i.test(a)) {
			text = renderNotebook(text);
		}
		const tag = contentTag(text);
		if (args.full !== true && !args.offset && !args.limit && !/\.ipynb$/i.test(a)) {
			const sk = skeleton(a, text);
			if (sk) {
				return { output: `[skeleton — ${sk.totalLines} lines, ${sk.shownLines} shown]\n${sk.text}[tag ${tag}]`, summary: `${this.rel(a)} · skeleton ${sk.shownLines}/${sk.totalLines}`, locations: [a] };
			}
		}
		const lines = text.split('\n');
		const start = Math.max(1, Number(args.offset) || 1);
		const end = Math.min(lines.length, start - 1 + (Number(args.limit) || 2000));
		const out = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n');
		return { output: (out || '(empty file)') + (end < lines.length ? `\n[… ${lines.length - end} more lines — use offset]` : '') + `\n[tag ${tag}]`, summary: `${this.rel(a)} · ${start}-${end} of ${lines.length}`, locations: [a] };
	}

	private async grep(pattern: string, glob: string, signal?: AbortSignal, options: import('./../tools/ripgrep').RgSearchOptions = {}): Promise<ToolResult> {
		const rg = await rgSearch(this.o.root, pattern, glob, signal, 150, denyGlobs(this.o.denyPaths ?? ''), options);
		if (rg) {
			const label = options.output === 'files' ? 'files' : options.output === 'count' ? 'counts' : 'matches';
			return { output: rg.matches.join('\n') || '(no matches)', summary: `${rg.matches.length}${rg.truncated ? '+' : ''} ${label} in ${rg.files} files` };
		}
		const re = new RegExp(pattern, options.caseSensitive ? '' : 'i');
		const gre = glob ? globRe(glob) : null;
		const hits: string[] = [];
		const hitFiles = new Set<string>();
		for (const f of walk(this.o.root, this.o.root)) {
			if ((gre && !gre.test(f)) || hits.length >= 150) {
				continue;
			}
			let text: string;
			try {
			text = fs.readFileSync(this.abs(f), 'utf8');
			} catch {
				continue;
			}
			if (text.includes('\u0000')) {
				continue;
			}
			const lines = text.split('\n');
			let perFile = 0;
			for (let i = 0; i < lines.length && hits.length < 150; i++) {
				if (!re.test(lines[i])) continue;
				perFile++;
				if (options.output === 'files') { hitFiles.add(f); break; }
				if (options.output === 'count') continue;
				hits.push(`${f}:${i + 1}: ${lines[i].slice(0, 300)}`);
			}
			if (perFile) {
				hitFiles.add(f);
				if (options.output === 'count') hits.push(`${f}:${perFile}`);
			}
		}
		return { output: hits.join('\n') || '(no matches)', summary: `${hits.length} ${options.output === 'content' || !options.output ? 'matches' : options.output} in ${hitFiles.size} files` };
	}

	/** Approve, then write only if the file is still what was approved (null: still absent). */
	private async change(a: string, before: string | null, after: string, req: ApproveRequest): Promise<boolean> {
		if (!(await this.o.approve(req))) {
			return false;
		}
		await this.guard.withLock(a, async () => {
			this.o.signal?.throwIfAborted(); this.abs(a);
			const now = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null;
			if (now !== before) {
				throw new Error(`${this.rel(a)} ${before === null ? 'was created' : 'changed'} while waiting for approval (the user or another tool edited it). Re-read it and retry — nothing was written.`);
			}
			fs.mkdirSync(path.dirname(a), { recursive: true });
			this.o.signal?.throwIfAborted(); this.abs(a);
			// A value the model only ever saw masked must never be written back over the real one.
			assertNoRedaction(after, this.rel(a));
			fs.writeFileSync(a, after);
			this.guard.observe(SCOPE, a, after);
		});
		this.o.onChange?.(this.rel(a), before, after);
		return true;
	}

	private async editFile(args: Record<string, unknown>): Promise<ToolResult> {
		const a = this.abs(args.path);
		const before = fs.readFileSync(a, 'utf8');
		this.guard.assertSeen(SCOPE, a, before, this.rel(a));
		const find = String(args.old_string ?? '');
		const replace = String(args.new_string ?? '');
		let after: string;
		let n = 1;
		let note = '';
		if (args.replace_all === true) {
			n = before.split(find).length - 1;
			if (!find || n === 0) {
				throw new Error(`old_string not found in ${this.rel(a)}.`);
			}
			after = before.split(find).join(replace);
		} else {
			const m = findUnique(before, find, this.rel(a));
			after = before.slice(0, m.index) + adaptReplacement(m, find, replace) + before.slice(m.index + m.text.length);
			note = matchNote(m);
		}
		if (!(await this.change(a, before, after, { kind: 'edit', title: `Edit ${this.rel(a)}`, path: a, oldText: find, newText: replace }))) {
			return { output: 'The user rejected this edit.', summary: 'rejected', error: true };
		}
		return { output: `Edited ${this.rel(a)}${n > 1 ? ` (${n} places)` : ''}.${note}`, summary: `+${replace.split('\n').length} −${find.split('\n').length}`, diff: { path: a, oldText: before, newText: after }, locations: [a] };
	}

	/** Hashline edit (see core/skeleton.ts): numbered ranges against the tagged read. */
	private async editLines(args: Record<string, unknown>): Promise<ToolResult> {
		const a = this.abs(args.path);
		const before = fs.readFileSync(a, 'utf8');
		const now = contentTag(before);
		const tag = String(args.tag ?? '').replace(/^#/, '').toLowerCase();
		if (tag !== now) {
			throw new Error(`${this.rel(a)} changed since that read (tag ${tag || 'missing'}, now ${now}). Re-read it and use the new tag.`);
		}
		const edits = (Array.isArray(args.edits) ? args.edits : []) as LineEdit[];
		const after = applyLineEdits(before, edits);
		if (!(await this.change(a, before, after, { kind: 'edit', title: `Edit ${this.rel(a)}`, path: a, oldText: before, newText: after }))) {
			return { output: 'The user rejected this edit.', summary: 'rejected', error: true };
		}
		return { output: `Edited ${this.rel(a)} (${edits.length} range${edits.length === 1 ? '' : 's'}). New [tag ${contentTag(after)}]; line numbers below the edit shifted.`, summary: `${edits.length} range${edits.length === 1 ? '' : 's'}`, diff: { path: a, oldText: before, newText: after }, locations: [a] };
	}

	private async writeFile(p: string, content: string): Promise<ToolResult> {
		const a = this.abs(p);
		const before = fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null;
		this.guard.assertOverwrite(SCOPE, a, before, this.rel(a));
		if (!(await this.change(a, before, content, { kind: 'write', title: `${before === null ? 'Create' : 'Overwrite'} ${this.rel(a)}`, path: a, oldText: before, newText: content }))) {
			return { output: 'The user rejected this write.', summary: 'rejected', error: true };
		}
		return { output: `${before === null ? 'Created' : 'Wrote'} ${this.rel(a)}.`, summary: `${content.split('\n').length} lines`, diff: { path: a, oldText: before, newText: content }, locations: [a] };
	}

	private async applyPatch(patch: string): Promise<ToolResult> {
		const hunks = parsePatch(patch);
		const plan: Array<{ a: string; before: string | null; after: string | null; to?: string }> = [];
		for (const h of hunks) {
			const a = this.abs(h.path);
			if (h.type === 'add') {
				plan.push({ a, before: null, after: h.contents });
			} else if (h.type === 'delete') {
				plan.push({ a, before: fs.readFileSync(a, 'utf8'), after: null });
			} else {
				const before = fs.readFileSync(a, 'utf8');
				this.guard.assertUnchangedIfSeen(SCOPE, a, before, h.path);
				plan.push({ a, before, after: applyChunks(before, h.chunks, h.path), to: h.movePath ? this.abs(h.movePath) : undefined });
			}
		}
		if (!(await this.o.approve({ kind: 'edit', title: `Apply patch (${plan.length} file${plan.length === 1 ? '' : 's'})`, newText: patch }))) {
			return { output: 'The user rejected this patch.', summary: 'rejected', error: true };
		}
		// Nothing is written unless every file is still what the patch was computed against.
		for (const s of plan) {
			this.o.signal?.throwIfAborted(); this.abs(s.a); if (s.to) this.abs(s.to);
			const now = fs.existsSync(s.a) ? fs.readFileSync(s.a, 'utf8') : null;
			if (now !== s.before || (s.to && fs.existsSync(s.to))) {
				throw new Error(`${this.rel(s.a)} changed while waiting for approval (the user or another tool edited it). Re-read it and retry — nothing was written.`);
			}
		}
		for (const s of plan) {
			this.o.signal?.throwIfAborted(); this.abs(s.a); if (s.to) this.abs(s.to);
			if (s.after === null) {
				fs.rmSync(s.a, { force: true });
			} else {
				const target = s.to ?? s.a;
				fs.mkdirSync(path.dirname(target), { recursive: true });
				this.abs(target);
				fs.writeFileSync(target, s.after);
				this.guard.observe(SCOPE, target, s.after);
				if (s.to) {
					fs.rmSync(s.a, { force: true });
				}
			}
			this.o.onChange?.(this.rel(s.to ?? s.a), s.before, s.after ?? '');
		}
		return { output: `Patch applied: ${plan.map((s) => this.rel(s.to ?? s.a)).join(', ')}.`, summary: `${plan.length} files`, locations: plan.map((s) => s.to ?? s.a) };
	}

	private async notebookEdit(args: Record<string, unknown>): Promise<ToolResult> {
		const a = this.abs(args.path);
		const raw = fs.readFileSync(a, 'utf8');
		this.guard.assertSeen(SCOPE, a, raw, this.rel(a));
		const mode = args.mode === 'insert' || args.mode === 'delete' ? args.mode : 'replace';
		const r = editNotebook(raw, { cell: Number(args.cell), mode, source: args.source === undefined ? undefined : String(args.source), cell_type: args.cell_type === 'markdown' ? 'markdown' : args.cell_type === 'code' ? 'code' : undefined });
		if (!(await this.change(a, raw, r.text, { kind: 'notebook', title: `${r.summary} in ${this.rel(a)}`, path: a, oldText: r.before, newText: r.after }))) {
			return { output: 'The user rejected this notebook edit.', summary: 'rejected', error: true };
		}
		return { output: `${r.summary[0].toUpperCase() + r.summary.slice(1)} in ${this.rel(a)}.`, summary: r.summary, locations: [a] };
	}

	private async runCommand(command: string, timeoutS: number, signal?: AbortSignal): Promise<ToolResult> {
		const ctx: CommandContext = { settings: { commandTool: this.o.commandEnabled !== false, hideCommandSecrets: this.o.hideCommandSecrets !== false, sandboxDenyRead: '' },
			requestApproval: async req => ({ approved: await this.o.approve({ kind: 'command', title: `Run ${command.slice(0, 80)}`, command, sandboxed: req.sandboxed, projectRule: req.projectRule }), finish() {} }),
			sandbox: this.o.sandbox ? { ...this.o.sandbox, mode: 'always' } : undefined,
			...this.o.commandContext, env: this.o.env ?? this.o.commandContext?.env, readOnly: this.o.readOnly || this.o.commandContext?.readOnly, signal: signal ?? new AbortController().signal };
		const plan = await approveCommand(command, this.o.root, this.o.root, ctx);
		if (!plan.handle.approved) {
			return { output: 'The user rejected this command.', summary: 'rejected', error: true };
		}
		noLinks(this.o.root);
		const r = await executeCommand(command, plan, timeoutS * 1000, ctx.signal);
		const compressed = this.o.tokenSaver === false ? r.out.slice(-30_000) : compressOutput(r.out, 20_000).text;
		const text = compressed + spillOutput(this.root, r.out, compressed, 'command');
		return { output: `exit code ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${text}`, summary: r.timedOut ? 'timed out' : r.code === 0 ? 'exit 0' : `exit ${r.code}`, error: r.code !== 0 || r.timedOut, exitCode: r.code ?? 1, timedOut: r.timedOut };
	}
}

function walk(dir: string, root: string, out: string[] = []): string[] {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, e.name);
		const rel = path.relative(root, abs).split(path.sep).join('/');
		if (SKIP.test(rel) || e.isSymbolicLink()) {
			continue;
		}
		if (e.isDirectory()) {
			walk(abs, root, out);
		} else {
			out.push(rel);
		}
		if (out.length > 20_000) {
			break;
		}
	}
	return out;
}

function globRe(glob: string): RegExp {
	const g = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
	return new RegExp('^' + g + '$');
}
