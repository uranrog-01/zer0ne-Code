import * as vscode from 'vscode';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import type { ToolDef } from '../chatClient';
import type { AgentSettings } from '../providerStore';
import { clip, DISPATCH_WAIT_SECONDS, errorsAfterEdit, exists, observeWritten, readText, rel, resolveInWorkspace, runTool, scopeOf, str, workspaceRoot, writeText, type ToolContext, type ToolOutcome } from './agentTools';
import { adaptReplacement, applyChunks, findUnique, matchNote, parsePatch } from './patch';
import { fileGuard } from './fileGuard';
import { killTree } from './proc';
import { commandLaunch } from './command';
import { artifactSlug, validateArtifact } from './artifact';
import { assertNoRedaction } from './redact';
import { availableScriptTools, resetScriptSession, runScript, scriptSandboxAvailable } from './script';
import { pdfText, readable } from './documents';
import { compressOutput, spillOutput } from './tokenSaver';
import { featureToolDefs, runFeatureTool } from './featureTools';
import { imageGenerateDef, runImageGenerate } from './imageGenerate';
import { contextBudgetText } from './contextBudget';
import { configuredLanguageService, languageResult } from './languageService';

/**
 * Tools that bring zer0ne to parity with Codex / Claude Code / opencode / omp:
 * multi_edit, apply_patch, delete_file, move_file, background commands
 * (command_output / command_kill), code_intel (VS Code language services:
 * definition, references, hover, symbols, call hierarchy), rename_symbol and
 * view_image.
 */

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

export const MORE_READ_ONLY = new Set(['code_intel', 'project_code_intel', 'view_image', 'command_output', 'semantic_search', 'run_script', 'read_document', 'impact']);
/** Tools whose card is an approval card. */
export const MORE_APPROVAL = new Set(['multi_edit', 'apply_patch', 'delete_file', 'move_file', 'rename_symbol', 'edit_symbol', 'publish_artifact']);

export function moreToolDefs(settings: AgentSettings): ToolDef[] {
	const defs: ToolDef[] = [
		{
			name: 'context_remaining',
			description: 'How much of the model context window is left, from the last request. Check it before reading many large files or running a long tool: when little remains, summarize or spill instead of overflowing.',
			parameters: obj({}, [])
		},
		{
			name: 'multi_edit',
			description:
				'Make several edits to ONE file in a single step (applied in order, all or nothing). Each old_string must match the file (after earlier edits) and be unique unless replace_all. Prefer this over repeated edit_file calls on the same file.',
			parameters: obj(
				{
					path: { type: 'string', description: 'Workspace-relative path' },
					edits: {
						type: 'array',
						items: obj({ old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['old_string', 'new_string'])
					}
				},
				['path', 'edits']
			)
		},
		{
			name: 'apply_patch',
			description: [
				'Apply a multi-file patch (create, update, rename, delete) in one step. Format:',
				'*** Begin Patch',
				'*** Add File: path/new.ts',
				'+every line of the new file, prefixed with +',
				'*** Update File: path/old.ts',
				'*** Move to: path/renamed.ts   (optional)',
				'@@ optional line to anchor the hunk (e.g. a function signature)',
				' context line',
				'-removed line',
				'+added line',
				'*** Delete File: path/obsolete.ts',
				'*** End Patch',
				'Include 1-3 unchanged context lines around each change.'
			].join('\n'),
			parameters: obj({ patch: { type: 'string', description: 'The full patch text' } }, ['patch'])
		},
		{
			name: 'delete_file',
			description: 'Delete a file from the workspace (moved to the trash). The user approves it.',
			parameters: obj({ path: { type: 'string' } }, ['path'])
		},
		{
			name: 'move_file',
			description: 'Move or rename a file inside the workspace. The user approves it.',
			parameters: obj({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to'])
		},
		{
			name: 'code_intel',
			description:
				"Ask VS Code's language services about code. operation: definition | references | implementation | hover | document_symbols | workspace_symbols | incoming_calls | outgoing_calls. Position = path + line (1-based) + either symbol (a name on that line) or character (1-based). workspace_symbols takes query instead.",
			parameters: obj(
				{
					operation: { type: 'string', enum: ['definition', 'references', 'implementation', 'hover', 'document_symbols', 'workspace_symbols', 'incoming_calls', 'outgoing_calls'] },
					path: { type: 'string' },
					line: { type: 'number' },
					symbol: { type: 'string', description: 'Identifier on that line (preferred over character)' },
					character: { type: 'number' },
					query: { type: 'string', description: 'For workspace_symbols' }
				},
				['operation']
			)
		},
		{
			name: 'rename_symbol',
			description: "Rename a symbol everywhere using the language server (safer than text replace). Position as in code_intel. The user approves the edit.",
			parameters: obj({ path: { type: 'string' }, line: { type: 'number' }, symbol: { type: 'string' }, new_name: { type: 'string' } }, ['path', 'line', 'symbol', 'new_name'])
		},
		{
			name: 'edit_symbol',
			description:
				'Replace a whole function, method or class by NAME (like Empryo\'s "edit by name"): send only the new code, not the old one — cheaper and safer than edit_file for rewrites of a symbol. symbol can be dotted (Class.method). The user approves it.',
			parameters: obj({ path: { type: 'string' }, symbol: { type: 'string', description: 'Name or Container.name' }, new_code: { type: 'string', description: 'The complete new definition (signature + body)' } }, ['path', 'symbol', 'new_code'])
		},
		{
			name: 'impact',
			description: 'Before changing a file, see what it touches: its exported symbols, the files that import it, and what it imports ("read the map first"). JS/TS/Python import graphs; other languages fall back to name matches.',
			parameters: obj({ path: { type: 'string' } }, ['path'])
		},
		{
			name: 'read_document',
			description: 'Read the text of a PDF (local extraction), or of a scanned PDF / image with OCR (GLM-OCR through a Z.ai or BigModel provider). Returns plain text or Markdown.',
			parameters: obj({ path: { type: 'string' }, max_chars: { type: 'number', description: 'Default 60000' } }, ['path'])
		},
		{
			name: 'view_image',
			description: 'Look at an image file from the workspace (png, jpg, gif, webp) — mockups, screenshots, diagrams.',
			parameters: obj({ path: { type: 'string' } }, ['path'])
		},
		{
			name: 'publish_artifact',
			description:
				'Publish a self-contained HTML document as an artifact the user can open in a preview panel (report, dashboard, one-file slide deck, interactive demo). ONE file: all CSS and JS inline; scripts only from https://cdnjs.cloudflare.com, styles also from Google Fonts; no iframes; no network calls (the preview has no egress). Republishing the same name replaces that artifact — iterate on the same file instead of creating copies.',
			parameters: obj(
				{
					name: { type: 'string', description: 'Short kebab-case name, becomes the file name (e.g. "sales-report")' },
					title: { type: 'string', description: 'Human title for the preview tab' },
					html: { type: 'string', description: 'The complete document, from <!doctype html> to </html>' }
				},
				['name', 'html']
			)
		}
	];
	if (settings.runScript) {
		defs.push({
			name: 'run_script',
			description: [
				'Run a short async JavaScript program that calls read-only workspace tools as functions and prints only what you need — one step instead of many tool calls (e.g. read 30 files and count something, grep then filter, compare outputs).',
				`Call tools as \`await tools.NAME({ ...args })\` with the tools' own arguments. Available: ${availableScriptTools(settings).join(', ')}.`,
				'Return values: list_files → array of paths; grep → array of { file, line, text }; read_file({ path }) → the file text (no line numbers); read_file({ paths }) → { [path]: text }; every other tool → its text output.',
				'Use print(...) for output (returned values are printed too). Standard JS only — no require/import, no file writes, no commands.',
				'keep: true makes it a REPL for this chat: the next run_script with keep sees the same `state` object (e.g. state.files = await tools.list_files({})), for 10 idle minutes. reset: true starts a fresh one.',
				'Example: const out = await tools.grep({ pattern: "TODO", glob: "src/**/*.ts" }); print(out.length + " TODOs");'
			].join('\n'),
			parameters: obj({ code: { type: 'string', description: 'Body of an async function; `state` persists across runs with keep' }, timeout_seconds: { type: 'number', description: 'Default 60, max 300' }, keep: { type: 'boolean', description: 'Keep this chat’s REPL process and its `state` for the next run' }, reset: { type: 'boolean', description: 'Discard the kept REPL and its `state` first' } }, ['code'])
		});
	}
	if (settings.codeIndex) {
		defs.push({
			name: 'semantic_search',
			description:
				'Search the project index — code and project documentation (Markdown, text, reStructuredText, AsciiDoc, LaTeX, CSV, PDF text layers) — by what it does or by names ("where is authentication handled", "how are releases cut"). Returns the best-matching chunks with file:line ranges and a code/doc label. Use it to find where to look; then read_file / grep for details.',
			parameters: obj({ query: { type: 'string' }, limit: { type: 'number', description: 'Results (default 8, max 20)' } }, ['query'])
		});
	}
	if (settings.commandTool) {
		defs.push(
			{
				name: 'command_output',
				description: 'Read new output from a background command started with run_command(background: true), and whether it is still running.',
				parameters: obj({ id: { type: 'string' }, wait_seconds: { type: 'number', description: 'Wait up to this long for more output (default 2, max 30)' } }, ['id'])
			},
			{
				name: 'command_kill',
				description: 'Stop a background command (and its child processes).',
				parameters: obj({ id: { type: 'string' } }, ['id'])
			},
			{
				name: 'command_input',
				description: 'Send input to a background command started with run_command(background: true): answer a prompt, confirm a step, or feed a REPL. Read what it asked with command_output first. The text goes to its stdin with a newline unless newline is false.',
				parameters: obj({ id: { type: 'string' }, text: { type: 'string' }, newline: { type: 'boolean', description: 'Default true' } }, ['id', 'text'])
			}
		);
	}
	if (settings.imageGenerate) {
		defs.push(imageGenerateDef());
	}
	return [...defs,...featureToolDefs(settings)];
}

export async function runMoreTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome | undefined> {
	const feature = await runFeatureTool(name,args,ctx); if (feature) return feature;
	switch (name) {
		case 'multi_edit':
			return multiEdit(str(args.path), Array.isArray(args.edits) ? args.edits : [], ctx);
		case 'apply_patch':
			return applyPatch(str(args.patch), ctx);
		case 'delete_file':
			return deleteFile(str(args.path), ctx);
		case 'move_file':
			return moveFile(str(args.from), str(args.to), ctx);
		case 'code_intel':
			return codeIntel(args);
		case 'rename_symbol':
			return renameSymbol(args, ctx);
		case 'edit_symbol':
			return editSymbol(str(args.path), str(args.symbol), String(args.new_code ?? ''), ctx);
		case 'impact':
			return impact(str(args.path), ctx);
		case 'view_image':
			return viewImage(str(args.path), ctx);
		case 'image_generate':
			return runImageGenerate(args, ctx);
		case 'context_remaining':
			return { ...contextBudgetText(ctx.contextRemaining?.()) };
		case 'publish_artifact':
			return publishArtifact(str(args.name), str(args.title), str(args.html), ctx);
		case 'command_output':
			return commandOutput(str(args.id), Math.min(ctx.dispatchOnly ? DISPATCH_WAIT_SECONDS : 30, Number(args.wait_seconds) || 2), ctx);
		case 'command_input':
			return commandInput(str(args.id), String(args.text ?? ''), args.newline !== false, ctx);
		case 'command_kill':
			return commandKill(str(args.id), ctx);
		case 'read_document':
			return readDocument(str(args.path), Math.min(200_000, Math.max(2000, Number(args.max_chars) || 60_000)), ctx);
		case 'run_script':
			return runScriptTool(str(args.code), Number(args.timeout_seconds) || 60, ctx, args.keep === true, args.reset === true);
		case 'semantic_search': {
			if (!ctx.searchCode) {
				throw new Error('The code index is turned off (Settings → Features).');
			}
			const hits = await ctx.searchCode(str(args.query), Math.min(20, Math.max(1, Number(args.limit) || 8)));
			if (!hits.length) {
				return { api: 'No matching code or documentation found in the index. Try grep with a regex.', summary: 'no matches' };
			}
			const api = hits.map((h) => `## ${h.file}:${h.start}-${h.end}  (${h.kind === 'doc' ? 'doc' : 'code'}, match: ${h.via})\n${h.preview}`).join('\n\n');
			return { api: clip(api, 30_000), summary: `${hits.length} places · ${[...new Set(hits.map((h) => h.file))].slice(0, 3).join(', ')}`, detail: hits.map((h) => `${h.file}:${h.start}-${h.end}`).join('\n') };
		}
	}
	return undefined;
}

// ---------------------------------------------------------------- edits

const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n');
const toLf = (s: string) => s.replace(/\r\n/g, '\n');
const toEol = (s: string, eol: string) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);

/** A compact unified-style preview for approval cards. */
function preview(fileHeader: string, oldText: string, newText: string, limit = 40): string {
	const a = toLf(oldText).split('\n');
	const b = toLf(newText).split('\n');
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) {
		s++;
	}
	let ea = a.length - 1;
	let eb = b.length - 1;
	while (ea >= s && eb >= s && a[ea] === b[eb]) {
		ea--;
		eb--;
	}
	const out = [`@@ ${fileHeader}`];
	a.slice(s, ea + 1).slice(0, limit).forEach((l) => out.push('-' + l));
	b.slice(s, eb + 1).slice(0, limit).forEach((l) => out.push('+' + l));
	return out.join('\n');
}

async function multiEdit(p: string, edits: Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	if (!edits.length) {
		throw new Error('edits is empty.');
	}
	const original = await readText(uri);
	fileGuard.assertSeen(scopeOf(ctx), uri.toString(), original, rel(uri));
	const eol = eolOf(original);
	const list = edits.map((e, i) => {
		const find = toLf(String(e.old_string ?? ''));
		const replace = toLf(String(e.new_string ?? ''));
		assertNoRedaction(replace, rel(uri));
		if (!find) {
			throw new Error(`Edit ${i + 1}: old_string is empty.`);
		}
		return { find, replace, all: e.replace_all === true, i };
	});
	let notes: string[] = [];
	const compute = (base: string) => {
		const text = toLf(base);
		const found: string[] = [];
		// Independent edits (Pi): all matched against the original text and applied together,
		// so one edit's new text can never become another edit's target.
		const spans: Array<{ start: number; end: number; text: string; i: number }> = [];
		const independent = list.every((e) => {
			if (e.all) {
				for (let at = text.indexOf(e.find); at !== -1; at = text.indexOf(e.find, at + e.find.length)) spans.push({ start: at, end: at + e.find.length, text: e.replace, i: e.i });
				return text.includes(e.find);
			}
			try {
				const m = findUnique(text, e.find, `${rel(uri)} (edit ${e.i + 1})`);
				spans.push({ start: m.index, end: m.index + m.text.length, text: adaptReplacement(m, e.find, e.replace), i: e.i });
				if (matchNote(m)) found.push(`edit ${e.i + 1}:${matchNote(m)}`);
				return true;
			} catch {
				return false;
			}
		});
		let out = text;
		if (independent) {
			spans.sort((a, b) => a.start - b.start);
			for (let k = 1; k < spans.length; k++) {
				if (spans[k].start < spans[k - 1].end) {
					throw new Error(`Edits ${spans[k - 1].i + 1} and ${spans[k].i + 1} overlap in ${rel(uri)}. Merge them into one edit or target separate regions.`);
				}
			}
			for (let k = spans.length - 1; k >= 0; k--) out = out.slice(0, spans[k].start) + spans[k].text + out.slice(spans[k].end);
		} else {
			// An edit targets text an earlier edit creates: apply in order (the documented contract).
			found.length = 0;
			for (const e of list) {
				if (e.all) {
					if (!out.includes(e.find)) {
						throw new Error(`Edit ${e.i + 1}: old_string not found in ${rel(uri)}.`);
					}
					out = out.split(e.find).join(e.replace);
				} else {
					const m = findUnique(out, e.find, `${rel(uri)} (edit ${e.i + 1})`);
					out = out.slice(0, m.index) + adaptReplacement(m, e.find, e.replace) + out.slice(m.index + m.text.length);
					if (matchNote(m)) found.push(`edit ${e.i + 1}:${matchNote(m)}`);
				}
			}
		}
		if (out === text) {
			throw new Error(`These edits change nothing in ${rel(uri)}.`);
		}
		notes = found;
		return toEol(out, eol);
	};
	const updated = compute(original); // validate before asking
	const handle = await ctx.requestApproval({ kind: 'patch', path: rel(uri), content: preview(rel(uri), original, updated, 80), review: { before: original, after: updated } });
	if (!handle.approved) {
		return { api: 'The user rejected these edits. Do not retry them unchanged.', summary: 'rejected', error: true };
	}
	try {
		const { current, next } = await fileGuard.withLock(uri.toString(), async () => {
			// Reviewed in the editor: the buffer held the proposal and the user accepted exactly this text.
			const current = handle.content !== undefined ? original : await readText(uri);
			const next = handle.content !== undefined ? handle.content : current === original ? updated : compute(current);
			await writeText(uri, next);
			await observeWritten(ctx, uri);
			return { current, next };
		});
		ctx.recordChange?.(rel(uri), current, next);
		const note = `Applied ${edits.length} edit${edits.length > 1 ? 's' : ''} to ${rel(uri)}.${notes.length ? ' ' + notes.join(' ') : ''}`;
		handle.finish(note);
		const errs = await errorsAfterEdit(uri, ctx.settings);
		return { api: note + errs, summary: `${edits.length} edits applied` + (errs ? ' · errors' : '') };
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

/** Find a symbol by name or dotted path in the file's outline (language server). */
async function findSymbol(uri: vscode.Uri, name: string): Promise<vscode.DocumentSymbol | undefined> {
	await vscode.workspace.openTextDocument(uri);
	const syms = (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
	const want = name.split('.').filter(Boolean);
	const hits: vscode.DocumentSymbol[] = [];
	const walk = (list: vscode.DocumentSymbol[], trail: string[]) => {
		for (const s of list) {
			const p = [...trail, s.name.replace(/\(.*$/, '')];
			if (p.slice(-want.length).join('.') === want.join('.')) {
				hits.push(s);
			}
			walk(s.children ?? [], p);
		}
	};
	walk(syms.filter((s): s is vscode.DocumentSymbol => 'children' in s), []);
	if (hits.length > 1) {
		throw new Error(`"${name}" matches ${hits.length} symbols in ${rel(uri)} (lines ${hits.map((h) => h.range.start.line + 1).join(', ')}) — use Container.name.`);
	}
	return hits[0];
}

async function editSymbol(p: string, name: string, newCode: string, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	if (!newCode.trim()) {
		throw new Error('new_code is empty.');
	}
	assertNoRedaction(newCode, rel(uri));
	const sym = await findSymbol(uri, name);
	if (!sym) {
		throw new Error(`No symbol "${name}" in ${rel(uri)} (no language support, or a different name — try code_intel document_symbols, or edit_file).`);
	}
	const original = await readText(uri);
	fileGuard.assertSeen(scopeOf(ctx), uri.toString(), original, rel(uri));
	const doc = await vscode.workspace.openTextDocument(uri);
	const start = doc.offsetAt(new vscode.Position(sym.range.start.line, 0));
	const end = doc.offsetAt(sym.range.end);
	const indent = /^[ \t]*/.exec(doc.lineAt(sym.range.start.line).text)?.[0] ?? '';
	// Keep the symbol's indentation when the new code comes unindented.
	const code = toLf(newCode).replace(/\n+$/, '');
	const body = code.startsWith(indent) || !indent ? code : code.split('\n').map((l) => (l ? indent + l : l)).join('\n');
	const updated = original.slice(0, start) + toEol(body, eolOf(original)) + original.slice(end);
	const handle = await ctx.requestApproval({ kind: 'patch', path: rel(uri), content: preview(rel(uri), original, updated, 80), review: { before: original, after: updated } });
	if (!handle.approved) {
		return { api: 'The user rejected this edit. Do not retry it unchanged.', summary: 'rejected', error: true };
	}
	const next = handle.content !== undefined ? handle.content : updated;
	try {
		await fileGuard.withLock(uri.toString(), async () => {
			// Reviewed in the editor: the buffer held the proposal, so only a chat-card approval re-checks the file.
			if (handle.content === undefined && (await readText(uri)) !== original) {
				throw new Error('The file changed while waiting for approval (the user or another tool edited it). Re-read it and retry — nothing was written.');
			}
			await writeText(uri, next);
			await observeWritten(ctx, uri);
		});
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
	ctx.recordChange?.(rel(uri), original, next);
	const note = `Replaced ${name} (${rel(uri)}:${sym.range.start.line + 1}-${sym.range.end.line + 1}).`;
	handle.finish(note);
	const errs = await errorsAfterEdit(uri, ctx.settings);
	return { api: note + errs, summary: `replaced ${name}` + (errs ? ' · errors' : '') };
}

const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte'];

/** Exports, importers and imports of one file. */
async function impact(p: string, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const root = workspaceRoot()!.fsPath;
	const file = rel(uri);
	const text = await readText(uri);
	const ext = path.extname(file);
	const stem = path.basename(file, ext);
	const out: string[] = [`# ${file}`];
	const semanticTests = new Set<string>();
	if (ctx.settings.codeIntelligence) {
		try {
			const service = configuredLanguageService(root,ctx.settings), symbols = await service.inspect('document_symbols',file,{},ctx.signal);
			out.push('', 'Language-server symbols (semantic evidence):', languageResult(symbols));
			if (service.describe().includes('referencesProvider') && Array.isArray(symbols)) for (const symbol of symbols.slice(0,8)) {
				ctx.signal.throwIfAborted();
				const start = symbol.selectionRange?.start || symbol.location?.range?.start;
				if (!Number.isInteger(start?.line) || !Number.isInteger(start?.character)) continue;
				const refs = await service.inspect('references',file,{line:start.line+1,character:start.character+1},ctx.signal);
				out.push('', 'Semantic references for '+String(symbol.name)+':',languageResult(refs));
				if (Array.isArray(refs)) for (const ref of refs) if (typeof ref?.path === 'string' && /(^|[\/._-])(test|tests|spec|specs)([\/._-]|$)/i.test(ref.path)) semanticTests.add(ref.path);
			}
		}
		catch (error) { out.push('', 'Semantic symbols unavailable: '+String((error as Error).message)); }
	}
	// Exports (outline, top level).
	try {
		await vscode.workspace.openTextDocument(uri);
		const syms = (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol>>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
		const top = syms.filter((s) => 'children' in s).map((s) => `${s.name}:${s.range.start.line + 1}`);
		if (top.length) {
			out.push('', `Defines: ${top.slice(0, 60).join(', ')}`);
		}
	} catch {
		/* no outline */
	}
	// What it imports.
	const imports = [...text.matchAll(/(?:import[\s\S]{0,200}?from\s*|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]|^\s*from\s+([\w.]+)\s+import/gm)].map((m) => m[1] ?? m[2]).filter(Boolean);
	if (imports.length) {
		out.push('', `Imports: ${[...new Set(imports)].slice(0, 60).join(', ')}`);
	}
	// Who imports it: search for the stem, then keep specifiers that resolve to this file.
	const { searchAnywhere } = await import('./ripgrep');
	const isPy = ext === '.py';
	const modPath = isPy ? file.replace(/\.py$/, '').replace(/[\\/]/g, '.').replace(/\.__init__$/, '') : '';
	const pattern = isPy ? `(from|import)\\s+[\\w.]*${stem}\\b` : `['"][^'"]*${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z]+)?['"]`;
	const found = await searchAnywhere(root, pattern, '', ctx.signal, 400).catch(() => undefined);
	const importers = new Set<string>();
	const maybe = new Set<string>();
	for (const line of found?.matches ?? []) {
		const m = /^(.*?):(\d+): (.*)$/.exec(line);
		if (!m || m[1] === file) {
			continue;
		}
		if (isPy) {
			(m[3].includes(modPath) || m[3].includes(stem) ? importers : maybe).add(m[1]);
			continue;
		}
		const spec = /['"]([^'"]+)['"]/.exec(m[3])?.[1];
		if (!spec || !spec.startsWith('.')) {
			maybe.add(m[1]);
			continue;
		}
		const target = path.resolve(root, path.dirname(m[1]), spec);
		const me = path.resolve(root, file);
		const hit = [target, ...CODE_EXT.map((e) => target + e), ...CODE_EXT.map((e) => path.join(target, 'index' + e))].some((t) => t === me || t === me.replace(/\.(ts|tsx|mts|cts)$/, '.js'));
		(hit ? importers : maybe).add(m[1]);
	}
	out.push('', importers.size ? `Imported by (${importers.size}): ${[...importers].sort().slice(0, 80).join(', ')}` : 'Imported by: nothing found (an entry point, or loaded dynamically).');
	if (maybe.size && maybe.size < 40) {
		out.push(`Mentions the name (check): ${[...maybe].sort().join(', ')}`);
	}
	const tests = [...importers,...maybe].filter(f => /(^|[\/._-])(test|tests|spec|specs)([\/._-]|$)/i.test(f));
	if (semanticTests.size) out.push('', 'Tests with server-reported references: '+[...semanticTests].sort().join(', '));
	out.push('', 'Import and name matches are textual evidence; dynamic loading and transitive callers may be missed.');
	if (tests.length) out.push('Suggested tests to inspect (heuristic): '+tests.sort().slice(0,40).join(', '));
	return { api: out.join('\n'), summary: `${importers.size} importers` };
}

async function applyPatch(patchText: string, ctx: ToolContext): Promise<ToolOutcome> {
	const hunks = parsePatch(patchText);
	assertNoRedaction(patchText.split('\n').filter((l) => l.startsWith('+')).join('\n'), 'the patch');
	// Dry run: compute every result before asking, so a bad patch fails early.
	type Plan = { kind: 'write' | 'delete'; uri: vscode.Uri; before: string | null; after: string };
	const plans: Plan[] = [];
	for (const h of hunks) {
		const uri = resolveInWorkspace(h.path);
		if (h.type === 'add') {
			if (await exists(uri)) {
				throw new Error(`${h.path} already exists — use "*** Update File:" instead.`);
			}
			plans.push({ kind: 'write', uri, before: null, after: h.contents });
		} else if (h.type === 'delete') {
			plans.push({ kind: 'delete', uri, before: await readText(uri), after: '' });
		} else {
			const before = await readText(uri);
			// A patch carries its own context lines, so no read is required — but a file read before must not have changed since.
			fileGuard.assertUnchangedIfSeen(scopeOf(ctx), uri.toString(), before, h.path);
			const eol = eolOf(before);
			const after = toEol(applyChunks(toLf(before), h.chunks, h.path), eol);
			if (h.movePath) {
				const target = resolveInWorkspace(h.movePath);
				if (await exists(target)) {
					throw new Error(`Cannot move to ${h.movePath}: it already exists.`);
				}
				plans.push({ kind: 'write', uri: target, before: null, after }, { kind: 'delete', uri, before, after: '' });
			} else {
				plans.push({ kind: 'write', uri, before, after });
			}
		}
	}
	const files = [...new Set(plans.map((p) => rel(p.uri)))];
	const handle = await ctx.requestApproval({ kind: 'patch', path: files.length === 1 ? files[0] : `${files.length} files`, content: patchText.replace(/\r\n/g, '\n').replace(/^\*\*\* (Begin|End) Patch\n?/gm, '').trim() });
	if (!handle.approved) {
		return { api: 'The user rejected this patch. Do not retry it unchanged.', summary: 'rejected', error: true };
	}
	const done: string[] = [];
	try {
		// Nothing is written unless every file is still what the patch was computed against.
		for (const p of plans) {
			const now = (await exists(p.uri)) ? await readText(p.uri) : null;
			if (now !== p.before) {
				throw new Error(`${rel(p.uri)} changed while waiting for approval (the user or another tool edited it). Re-read it and retry — nothing was written.`);
			}
		}
		for (const p of plans) {
			const r = rel(p.uri);
			if (p.kind === 'delete') {
				ctx.recordChange?.(r, p.before, '');
				await vscode.workspace.fs.delete(p.uri, { useTrash: true });
				done.push(`deleted ${r}`);
			} else {
				ctx.recordChange?.(r, p.before, p.after);
				await fileGuard.withLock(p.uri.toString(), () => writeText(p.uri, p.after));
				await observeWritten(ctx, p.uri);
				done.push(`${p.before === null ? 'created' : 'updated'} ${r}`);
			}
		}
		const note = `Patch applied: ${done.join(', ')}.`;
		handle.finish(note);
		return { api: note, summary: `${files.length} file${files.length > 1 ? 's' : ''} changed` };
	} catch (error) {
		const msg = `${error instanceof Error ? error.message : String(error)}${done.length ? ` (already done: ${done.join(', ')})` : ''}`;
		handle.finish(msg, true);
		throw new Error(msg);
	}
}

/** The agent's publishable page: contract-checked, approval-gated, previewed in a sandboxed panel. */
async function publishArtifact(name: string, title: string, html: string, ctx: ToolContext): Promise<ToolOutcome> {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('Open a folder to publish artifacts.');
	}
	if (!html.trim()) {
		throw new Error('html is empty.');
	}
	const problems = validateArtifact(html);
	if (problems.length) {
		return {
			api: `Error: the artifact breaks the publish contract. Fix these and republish:\n- ${problems.join('\n- ')}`,
			summary: 'contract violation',
			error: true
		};
	}
	const slug = artifactSlug(name);
	const relPath = `.zer0ne/artifacts/${slug}.html`;
	const file = path.join(root.fsPath, '.zer0ne', 'artifacts', `${slug}.html`);
	const before = await readText(vscode.Uri.file(file)).catch(() => null);
	const handle = await ctx.requestApproval({ kind: 'write', path: relPath, content: html.slice(0, 2000) + (html.length > 2000 ? '\n…' : ''), existed: before !== null });
	if (!handle.approved) {
		handle.finish('rejected');
		return { api: 'The user rejected publishing this artifact.', summary: 'rejected', error: true };
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(vscode.Uri.file(file), '..'));
	await writeText(vscode.Uri.file(file), html);
	ctx.recordChange?.(relPath, before, html);
	handle.finish(`Published ${relPath}`);
	let previewError = '';
	try { if (ctx.openArtifact) await ctx.openArtifact(file, title || slug); else previewError = 'Preview unavailable.'; } catch (error) { previewError = `Preview unavailable: ${error instanceof Error ? error.message : error}.`; }
	return { api: `Published ${relPath} — ${previewError || 'it is open in the preview'}. To change it, republish the same name with the full updated document.`, summary: `published ${relPath}`, url: relPath };
}

async function deleteFile(p: string, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const before = await readText(uri).catch(() => null);
	if (before === null && !(await exists(uri))) {
		throw new Error(`${p} does not exist.`);
	}
	const handle = await ctx.requestApproval({ kind: 'patch', path: rel(uri), content: `*** Delete File: ${rel(uri)}` });
	if (!handle.approved) {
		return { api: 'The user rejected deleting this file.', summary: 'rejected', error: true };
	}
	if (before !== null) {
		ctx.recordChange?.(rel(uri), before, '');
	}
	await vscode.workspace.fs.delete(uri, { useTrash: true, recursive: false });
	handle.finish(`Deleted ${rel(uri)}.`);
	return { api: `Deleted ${rel(uri)} (moved to trash).`, summary: 'deleted' };
}

async function moveFile(from: string, to: string, ctx: ToolContext): Promise<ToolOutcome> {
	const src = resolveInWorkspace(from);
	const dst = resolveInWorkspace(to);
	if (!(await exists(src))) {
		throw new Error(`${from} does not exist.`);
	}
	if (await exists(dst)) {
		throw new Error(`${to} already exists.`);
	}
	const handle = await ctx.requestApproval({ kind: 'patch', path: `${rel(src)} → ${rel(dst)}`, content: `*** Update File: ${rel(src)}\n*** Move to: ${rel(dst)}` });
	if (!handle.approved) {
		return { api: 'The user rejected this move.', summary: 'rejected', error: true };
	}
	const before = await readText(src).catch(() => null);
	if (before !== null) {
		ctx.recordChange?.(rel(src), before, '');
		ctx.recordChange?.(rel(dst), null, before);
	}
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dst, '..'));
	await vscode.workspace.fs.rename(src, dst, { overwrite: false });
	handle.finish(`Moved to ${rel(dst)}.`);
	return { api: `Moved ${rel(src)} → ${rel(dst)}.`, summary: 'moved' };
}

// ---------------------------------------------------------------- language services

async function positionOf(args: Record<string, unknown>): Promise<{ doc: vscode.TextDocument; pos: vscode.Position }> {
	const uri = resolveInWorkspace(str(args.path));
	const doc = await vscode.workspace.openTextDocument(uri);
	const line = Math.min(doc.lineCount, Math.max(1, Math.floor(Number(args.line) || 1))) - 1;
	const text = doc.lineAt(line).text;
	let ch = Math.max(0, Math.floor(Number(args.character) || 1) - 1);
	const symbol = str(args.symbol).trim();
	if (symbol) {
		const re = new RegExp(`(^|[^\\w$])(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w$])`);
		const m = re.exec(text);
		if (!m) {
			throw new Error(`"${symbol}" is not on line ${line + 1} of ${rel(uri)}: ${text.trim().slice(0, 160)}`);
		}
		ch = m.index + m[1].length;
	}
	return { doc, pos: new vscode.Position(line, Math.min(ch, text.length)) };
}

function fmtLoc(loc: vscode.Location | vscode.LocationLink): string {
	const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
	const range = 'targetUri' in loc ? loc.targetSelectionRange ?? loc.targetRange : loc.range;
	return `${rel(uri)}:${range.start.line + 1}:${range.start.character + 1}`;
}

async function withLines(locs: Array<vscode.Location | vscode.LocationLink>, max = 80): Promise<string> {
	const out: string[] = [];
	for (const loc of locs.slice(0, max)) {
		const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
		const range = 'targetUri' in loc ? loc.targetSelectionRange ?? loc.targetRange : loc.range;
		let line = '';
		try {
			line = (await vscode.workspace.openTextDocument(uri)).lineAt(range.start.line).text.trim().slice(0, 160);
		} catch {
			// unreadable
		}
		out.push(`${fmtLoc(loc)}  ${line}`);
	}
	return out.join('\n') + (locs.length > max ? `\n[… ${locs.length - max} more]` : '');
}

const KIND = (k: vscode.SymbolKind) => vscode.SymbolKind[k]?.toLowerCase() ?? 'symbol';

async function codeIntel(args: Record<string, unknown>): Promise<ToolOutcome> {
	const op = str(args.operation);
	const exec = <T>(cmd: string, ...a: unknown[]) => vscode.commands.executeCommand<T>(cmd, ...a);
	if (op === 'workspace_symbols') {
		const syms = (await exec<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', str(args.query))) ?? [];
		const root = workspaceRoot()?.toString() ?? '';
		const lines = syms.filter((s) => s.location.uri.toString().startsWith(root)).slice(0, 100).map((s) => `${KIND(s.kind)} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''} — ${fmtLoc(s.location)}`);
		return { api: lines.join('\n') || 'No symbols found (is a language extension installed for these files?).', summary: `${lines.length} symbols` };
	}
	if (op === 'document_symbols') {
		const uri = resolveInWorkspace(str(args.path));
		await vscode.workspace.openTextDocument(uri);
		const syms = (await exec<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
		const lines: string[] = [];
		const walk = (list: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, depth: number) => {
			for (const s of list) {
				if (lines.length > 300) {
					return;
				}
				const range = 'range' in s ? s.range : s.location.range;
				lines.push(`${'  '.repeat(depth)}${KIND(s.kind)} ${s.name} :${range.start.line + 1}-${range.end.line + 1}`);
				if ('children' in s && s.children?.length) {
					walk(s.children, depth + 1);
				}
			}
		};
		walk(syms, 0);
		return { api: lines.join('\n') || 'No symbols (no language support for this file?).', summary: `${lines.length} symbols in ${rel(uri)}` };
	}
	const { doc, pos } = await positionOf(args);
	const where = `${rel(doc.uri)}:${pos.line + 1}:${pos.character + 1}`;
	switch (op) {
		case 'definition':
		case 'implementation':
		case 'references': {
			const cmd = op === 'definition' ? 'vscode.executeDefinitionProvider' : op === 'implementation' ? 'vscode.executeImplementationProvider' : 'vscode.executeReferenceProvider';
			const locs = (await exec<Array<vscode.Location | vscode.LocationLink>>(cmd, doc.uri, pos)) ?? [];
			return { api: locs.length ? await withLines(locs) : `No ${op} found at ${where}.`, summary: `${locs.length} ${op === 'references' ? 'references' : 'locations'}` };
		}
		case 'hover': {
			const hovers = (await exec<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos)) ?? [];
			const text = hovers
				.flatMap((h) => h.contents)
				.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))
				.filter(Boolean)
				.join('\n\n');
			return { api: clip(text, 8000) || `No hover information at ${where}.`, summary: text ? 'type info' : 'nothing' };
		}
		case 'incoming_calls':
		case 'outgoing_calls': {
			const items = (await exec<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', doc.uri, pos)) ?? [];
			if (!items.length) {
				return { api: `No callable symbol at ${where}.`, summary: 'nothing' };
			}
			const lines: string[] = [];
			if (op === 'incoming_calls') {
				const calls = (await exec<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', items[0])) ?? [];
				calls.forEach((c) => lines.push(`${KIND(c.from.kind)} ${c.from.name} — ${rel(c.from.uri)}:${c.from.selectionRange.start.line + 1}`));
			} else {
				const calls = (await exec<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', items[0])) ?? [];
				calls.forEach((c) => lines.push(`${KIND(c.to.kind)} ${c.to.name} — ${rel(c.to.uri)}:${c.to.selectionRange.start.line + 1}`));
			}
			return { api: lines.join('\n') || 'None found.', summary: `${lines.length} calls` };
		}
	}
	throw new Error(`Unknown operation "${op}".`);
}

async function renameSymbol(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	const newName = str(args.new_name).trim();
	if (!newName) {
		throw new Error('new_name is empty.');
	}
	const { doc, pos } = await positionOf(args);
	const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, pos, newName);
	const entries = edit?.entries() ?? [];
	if (!entries.length) {
		throw new Error('The language server returned no rename edits (no language support, or not a renameable symbol).');
	}
	const root = workspaceRoot()?.toString() ?? '';
	if (entries.some(([uri]) => !uri.toString().startsWith(root))) {
		throw new Error('The rename would change files outside the workspace; refusing.');
	}
	const summary = entries.map(([uri, edits]) => `${rel(uri)}: ${edits.length} change${edits.length > 1 ? 's' : ''}`).join('\n');
	const handle = await ctx.requestApproval({ kind: 'patch', path: `rename ${str(args.symbol)} → ${newName}`, content: `@@ ${entries.length} file(s)\n${summary}` });
	if (!handle.approved) {
		return { api: 'The user rejected the rename.', summary: 'rejected', error: true };
	}
	const befores = new Map<string, string>();
	for (const [uri] of entries) {
		befores.set(rel(uri), await readText(uri));
	}
	if (!(await vscode.workspace.applyEdit(edit))) {
		handle.finish('VS Code refused the edit.', true);
		throw new Error('VS Code refused the rename edit.');
	}
	for (const [uri] of entries) {
		const doc2 = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
		await doc2?.save();
		ctx.recordChange?.(rel(uri), befores.get(rel(uri)) ?? null, doc2?.getText() ?? '');
	}
	handle.finish(summary);
	return { api: `Renamed to ${newName}:\n${summary}`, summary: `${entries.length} files` };
}

// ---------------------------------------------------------------- images

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

async function viewImage(p: string, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const mime = IMAGE_TYPES[path.extname(uri.fsPath).toLowerCase()];
	if (!mime) {
		throw new Error('Supported images: png, jpg, gif, webp.');
	}
	const bytes = await vscode.workspace.fs.readFile(uri);
	if (bytes.length > 5_000_000) {
		throw new Error('Image is larger than 5 MB.');
	}
	const base64 = Buffer.from(bytes).toString('base64');
	if (!ctx.vision) {
		return { api: `The current model cannot see images (${rel(uri)}, ${Math.round(bytes.length / 1024)} KB). Ask the user to describe it or switch to a vision model.`, summary: 'model has no vision', error: true };
	}
	return {
		api: `Image ${rel(uri)} (${Math.round(bytes.length / 1024)} KB) is attached.`,
		summary: `${rel(uri)} · ${Math.round(bytes.length / 1024)} KB`,
		images: [{ mime, base64, name: path.basename(uri.fsPath) }],
		image: bytes.length < 400_000 ? `data:${mime};base64,${base64}` : undefined
	};
}

// ---------------------------------------------------------------- documents

const OCR_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

async function readDocument(p: string, maxChars: number, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const ext = path.extname(uri.fsPath).toLowerCase();
	const mime = OCR_TYPES[ext];
	if (!mime) {
		throw new Error('read_document handles PDF and images (png, jpg, webp); use read_file for text files.');
	}
	const bytes = Buffer.from(await vscode.workspace.fs.readFile(uri));
	let text = '';
	let via = '';
	let pages = 0;
	if (ext === '.pdf') {
		const r = pdfText(bytes);
		pages = r.pages;
		text = r.text;
		via = 'text layer';
	}
	const weak = text.replace(/\s+/g, '').length < Math.max(80, pages * 40) || readable(text) < 0.8;
	if ((weak || ext !== '.pdf') && ctx.ocr) {
		if (bytes.length > 20_000_000) {
			throw new Error('File is larger than 20 MB — too big for OCR.');
		}
		text = await ctx.ocr(bytes, mime);
		via = 'GLM-OCR';
	} else if (ext !== '.pdf') {
		throw new Error('Reading text from images needs OCR: add a Z.ai or BigModel provider (GLM-OCR), or use view_image with a vision model.');
	} else if (weak) {
		via = 'text layer (little text found — probably a scan; add a Z.ai / BigModel provider for GLM-OCR)';
	}
	const out = `${rel(uri)} — ${pages ? pages + ' pages, ' : ''}via ${via}\n\n${text}`;
	return { api: clip(out, maxChars), summary: `${rel(uri)} · ${text.length} chars · ${via.split(' (')[0]}`, detail: clip(text, 2000) };
}

// ---------------------------------------------------------------- run_script

const NOTE = /^\[(… .*|tag [0-9a-f]{4})\]$/;
const plainFile = (numbered: string) =>
	numbered
		.split('\n')
		.filter((l) => !NOTE.test(l))
		.map((l) => l.replace(/^\d+\t/, ''))
		.join('\n')
		.replace(/\n$/, '');

function scriptValue(name: string, args: Record<string, unknown>, text: string): { text: string; data?: unknown; kind?: 'list' } {
	if (name === 'list_files') {
		const items = text.split('\n').filter((l) => l && !NOTE.test(l) && l !== '(no files matched)');
		return { text, data: items, kind: 'list' };
	}
	if (name === 'grep') {
		const items = text
			.split('\n')
			.map((l) => l.match(/^(.*?):(\d+): ?(.*)$/))
			.filter((m): m is RegExpMatchArray => !!m)
			.map((m) => ({ file: m[1], line: Number(m[2]), text: m[3] }));
		return { text, data: items, kind: 'list' };
	}
	if (name === 'read_file') {
		if (Array.isArray(args.paths)) {
			const files: Record<string, string> = {};
			for (const part of text.split(/\n\n(?===> )/)) {
				const m = part.match(/^==> (.+?) <==\n([\s\S]*)$/);
				if (m) {
					files[m[1]] = m[2].startsWith('Error: ') ? m[2] : plainFile(m[2]);
				}
			}
			return { text, data: files };
		}
		return { text, data: plainFile(text) };
	}
	return { text };
}

async function runScriptTool(code: string, timeoutSeconds: number, ctx: ToolContext, keep = false, reset = false): Promise<ToolOutcome> {
	if (!code.trim()) {
		throw new Error('code is empty.');
	}
	const sandboxed = scriptSandboxAvailable();
	let handle: Awaited<ReturnType<ToolContext['requestApproval']>> | undefined;
	if (!sandboxed) {
		// No permission model in this Node build: treat the script like a command.
		handle = await ctx.requestApproval({ kind: 'command', command: `# run_script — this VS Code's Node cannot sandbox scripts, so it needs your approval\n${code}` });
		if (!handle.approved) {
			return { api: 'The user rejected running this script.', summary: 'rejected', error: true };
		}
	}
	// A REPL belongs to its chat (or subagent): another chat never sees its state.
	const replKey = 'repl:' + (ctx.guardScope ?? ctx.sessionId ?? 'default');
	if (reset) resetScriptSession(replKey);
	let n = 0;
	const inner: ToolContext = { ...ctx, readOnly: true, requestApproval: async () => ({ approved: false, finish: () => undefined }) };
	const res = await runScript(
		code,
		async (name, args) => {
			// Plain data for scripts: file text without line numbers, arrays for lists/matches.
			const callArgs = name === 'read_file' ? { ...args, limit: 1_000_000, full: true } : args;
			const out = await runTool({ id: `script-${++n}`, name, arguments: JSON.stringify(callArgs) }, inner);
			if (out.error) {
				throw new Error(`tools.${name}: ${out.api.replace(/^Error: /, '')}`);
			}
			return scriptValue(name, args, out.api);
		},
		{ timeoutMs: Math.min(300, Math.max(5, timeoutSeconds)) * 1000, maxCalls: 300, signal: ctx.signal, keep: keep ? replKey : undefined, tools: availableScriptTools(ctx.settings, ctx.allowedTools) }
	);
	const parts = [res.error && `Error:\n${res.error}`, res.output && `Output:\n${res.output}`, res.value && `Return value:\n${res.value}`].filter(Boolean) as string[];
	const api = `${parts.join('\n\n') || '(no output — use print(...))'}\n\n(${res.calls} tool call${res.calls === 1 ? '' : 's'}${res.sandboxed ? '' : ', not sandboxed'})`;
	handle?.finish(clip(api, 2000), !!res.error);
	return { api: clip(api, 40_000), summary: `${res.calls} tool calls${res.error ? ' · error' : ''}`, detail: `${code.slice(0, 1500)}\n\n— output —\n${clip(parts.join('\n\n'), 3000)}`, error: !!res.error };
}

// ---------------------------------------------------------------- background commands

interface BgProc {
	id: string;
	owner: string;
	command: string;
	child: ChildProcess;
	out: string;
	read: number;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	startedAt: number;
	endedAt?: number;
	/** Stopped by command_kill or shutdown: nobody needs to hear that it ended. */
	killed?: boolean;
	/** command_output already showed the exit, so no notice repeats it. */
	reported?: boolean;
}
export type BackgroundProc = Readonly<BgProc>;

const procs = new Map<string, BgProc>();
let procSeq = 0;
const exitListeners = new Set<(p: BackgroundProc) => void>();

/** Called when a background command exits on its own (not command_kill, not shutdown). */
export function onBackgroundExit(listener: (p: BackgroundProc) => void): () => void {
	exitListeners.add(listener);
	return () => exitListeners.delete(listener);
}

/** The chat and agent scope that started it ([sessionId, guardScope]; guardScope is set for isolated writers). */
export function backgroundOwnerOf(p: BackgroundProc): { sessionId?: string; guardScope?: string } {
	const [sessionId, guardScope] = JSON.parse(p.owner) as [string | null, string | null];
	return { sessionId: sessionId ?? undefined, guardScope: guardScope ?? undefined };
}

export function backgroundProc(id: string): BackgroundProc | undefined {
	return procs.get(id);
}

/** The background commands a chat's lead started (not its isolated writers'). */
export function chatBackground(sessionId: string): BackgroundProc[] {
	const owner = JSON.stringify([sessionId, null]);
	return [...procs.values()].filter((p) => p.owner === owner);
}

/**
 * What the lead reads when a background command ends: its state, the tail of what it printed since
 * the agent last read it (inlined), and the call that returns the rest (spilled) (pure; tested).
 */
export function backgroundNotice(p: BackgroundProc, now = Date.now(), tailLines = 20): string {
	const state = p.signal ? `stopped by ${p.signal}` : `exited with code ${p.code}`;
	const secs = Math.round(((p.endedAt ?? now) - p.startedAt) / 1000);
	const unread = p.out.slice(p.read).replace(/\s+$/, '');
	const lines = unread ? unread.split(/\r?\n/) : [];
	const tail = lines.slice(-tailLines).join('\n').slice(-2000);
	const more = lines.length > tailLines ? `\n(${lines.length - tailLines} earlier unread lines: command_output {"id":"${p.id}"})` : '';
	return `<command-notification>\n## ${p.id} — \`${p.command.slice(0, 200)}\` ${state} after ${secs}s\n${tail ? tail + more : '(no unread output)'}\n</command-notification>`;
}

type BackgroundOwner = Pick<ToolContext, 'sessionId' | 'guardScope'>;

function backgroundOwner(ctx: BackgroundOwner): string {
	if (!ctx.sessionId && !ctx.guardScope) throw new Error('Background commands need an owning chat or agent.');
	return JSON.stringify([ctx.sessionId ?? null, ctx.guardScope ?? null]);
}

function ownedBackground(id: string, ctx: BackgroundOwner): BgProc {
	const owner = backgroundOwner(ctx), p = procs.get(id);
	if (!p || p.owner !== owner) throw new Error(`No background command "${id}" in this chat or agent.`);
	return p;
}

export function startBackground(command: string, cwd: string, boxed: import('./sandbox').SandboxSpawn | undefined, env: NodeJS.ProcessEnv | undefined, ctx: BackgroundOwner, guard?: string): BgProc {
	const owner = backgroundOwner(ctx);
	const id = `bg${++procSeq}`;
	const spec = commandLaunch(command, { spec: boxed, env: env ?? process.env, guard });
	const child = spawn(spec.file, spec.args, { cwd, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments, env: { ...spec.env, NO_COLOR: '1', FORCE_COLOR: '0' }, detached: process.platform !== 'win32' });
	return track({ id, owner, command, child, out: '', read: 0, startedAt: Date.now() });
}

/**
 * A foreground command that ran too long becomes a background one: the live process, what it printed so far
 * (already shown to the agent, so counted as read) and its end, reported like any background command.
 */
export function adoptBackground(child: ChildProcess, command: string, out: string, startedAt: number, ctx: BackgroundOwner): string {
	const clean = out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
	return track({ id: `bg${++procSeq}`, owner: backgroundOwner(ctx), command, child, out: clean, read: clean.length, startedAt }).id;
}

function track(p: BgProc): BgProc {
	const { child, id } = p;
	const add = (c: Buffer) => {
		p.out += c.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
		if (p.out.length > 400_000) {
			const drop = p.out.length - 300_000;
			p.out = p.out.slice(drop);
			p.read = Math.max(0, p.read - drop);
		}
	};
	child.stdout?.on('data', add);
	child.stderr?.on('data', add);
	child.on('close', (code, signal) => {
		p.code ??= code;
		p.signal = signal;
		p.endedAt = Date.now();
		if (p.killed || !procs.has(p.id)) return;
		for (const listener of exitListeners) {
			try { listener(p); } catch { /* A listener's failure must not hide the exit from the others. */ }
		}
	});
	child.on('error', (e) => {
		p.out += `\n[failed to start: ${e.message}]`;
		p.code = -1;
	});
	procs.set(id, p);
	return p;
}

export async function waitForOutput(p: BgProc, seconds: number, signal?: AbortSignal): Promise<void> {
	const until = Date.now() + Math.min(30, Math.max(0, seconds)) * 1000;
	let last = p.out.length;
	let quietSince = Date.now();
	while (Date.now() < until && p.code === undefined && !signal?.aborted) {
		await new Promise((r) => setTimeout(r, 200));
		if (p.out.length !== last) {
			last = p.out.length;
			quietSince = Date.now();
		} else if (p.out.length > p.read && Date.now() - quietSince > 1200) {
			break; // got output and it settled
		}
	}
}

export function takeOutput(p: BgProc, tokenSaver: boolean): string {
	const fresh = p.out.slice(p.read);
	p.read = p.out.length;
	if (p.code !== undefined) p.reported = true;
	const state = p.code === undefined ? `running (id ${p.id}, ${Math.round((Date.now() - p.startedAt) / 1000)}s)` : p.signal ? `stopped by ${p.signal}` : `exited with code ${p.code}`;
	const body = tokenSaver ? compressOutput(fresh, 12_000).text : clip(fresh, 20_000);
	const root = workspaceRoot();
	return `${state}\n${body.trim() || '(no new output)'}${spillOutput(root?.scheme === 'file' ? root.fsPath : undefined, fresh, body, p.id)}`;
}

async function commandOutput(id: string, wait: number, ctx: ToolContext): Promise<ToolOutcome> {
	const p = ownedBackground(id, ctx);
	await waitForOutput(p, wait, ctx.signal);
	ctx.signal.throwIfAborted();
	const text = takeOutput(p, ctx.settings.tokenSaver);
	return { api: text, summary: text.split('\n')[0], detail: clip(text, 3000), error: p.code !== undefined && p.code !== 0 };
}

function commandKill(id: string, ctx: ToolContext): ToolOutcome {
	const p = ownedBackground(id, ctx);
	p.killed = true;
	if (p.code === undefined) {
		killTree(p.child);
	}
	procs.delete(id);
	return { api: `Stopped ${id} (${p.command}).`, summary: 'stopped' };
}

/**
 * Write to a background command's stdin. The command was approved once; its
 * answers are part of that same run, so no second card is shown. Starts a
 * command that waits on a prompt (sign-in, scaffolding) were impossible before:
 * stdin was closed so non-interactive commands could not hang.
 */
export function writeStdin(id: string, owner: BackgroundOwner, text: string, newline = true): string {
	if (text.length > 32_000) throw new Error('That input is longer than 32,000 characters.');
	const p = ownedBackground(id, owner);
	if (p.code !== undefined) throw new Error(`Background command ${id} has already finished.`);
	if (!p.child.stdin || p.child.stdin.destroyed || !p.child.stdin.writable) throw new Error(`Background command ${id} has no open stdin.`);
	p.child.stdin.write(text + (newline ? '\n' : ''));
	return `Sent ${text.length} character${text.length === 1 ? '' : 's'} to ${id}${newline ? ' with a newline' : ''}.`;
}

function commandInput(id: string, text: string, newline: boolean, ctx: ToolContext): ToolOutcome {
	const note = writeStdin(id, ctx, text, newline);
	return { api: note, summary: `input → ${id}` };
}

/** Kill every background process (extension shutdown). */
export function killAllBackground(): void {
	for (const p of procs.values()) {
		p.killed = true;
		if (p.code === undefined) {
			killTree(p.child);
		}
	}
	procs.clear();
}
