import * as fs from 'fs';
import type { ChatMessage, MessageImage } from '../chatClient';
import type { AgentSettings, ModelEntry, ProviderStore, StoredMessage } from '../providerStore';
import * as vscode from 'vscode';
import { resolveInWorkspace, shellName, workspaceRoot } from '../tools/agentTools';
import type { Transcript } from '../transcript';
import { projectInstructions } from './projectRules';
import { runtimeDate } from '../prefixStability';
import { UNTRUSTED_RULE } from '../core/untrusted';
import { repoMapFor } from '../core/repoMap';

/*
 * How one model request is put together: the system prompt (agent or chat
 * prompt, project rules, skills, plan mode, reply language), the
 * history rebuilt from the display transcript when there is no exact one, and
 * the reminder about files that changed since the model read them. Split out
 * of ChatController.runTurn.
 */

export interface Identity {
	model: string;
	modelName?: string;
	provider: string;
}

/** Who is answering — so "which model are you?" gets the real provider/model, not a guess. */
function identityLine(id: Identity): string {
	const name = id.modelName && id.modelName !== id.model ? `${id.modelName} (\`${id.model}\`)` : `\`${id.model}\``;
	return `You are running on the model ${name}, served by the provider "${id.provider}" through zer0ne. If the user asks which model, provider or AI you are, answer with exactly this model and provider — never guess or name a different model or company.`;
}

/** Codex-style answer shape: outcome first, prose, linked files, no emojis. */
const STYLE_RULES = [
	'Writing the answer:',
	'- Lead with the outcome in one or two plain sentences (what you changed, found or recommend). No greetings, no filler, no emojis anywhere.',
	'- Write short paragraphs of prose. Use a bullet list only for 3+ parallel items and headings only for long reports; keep headings plain.',
	'- Link workspace files as markdown links with workspace-relative paths, e.g. [chatClient.ts](src/chatClient.ts) or [chatClient.ts:42](src/chatClient.ts#L42). Put identifiers, commands and settings in backticks.',
	'- After changing code, explain per file in a sentence what changed and why (the UI already lists the edited files with +/- counts), say how you verified it (build, tests, diagnostics, browser), and name anything left to do or any limitation.',
	'- Do not paste large code the user can open; show code only when it is the answer.',
	'- When a diagram explains architecture or a flow better than prose, add a ```mermaid block — it renders as a diagram in the chat.',
	'- For one genuinely useful aside (a shortcut, a gotcha, a risk), you may use a GitHub alert: a line `> [!TIP]` (or NOTE, IMPORTANT, WARNING, CAUTION) followed by `> ` lines. At most one per answer, and none when there is nothing worth flagging.'
].join('\n');

/** The app the agent runs in, as the host names itself (zer0ne Code on the desktop, VS Code as an extension). */
const hostApp = (): string => vscode.env?.appName || 'VS Code';

export function chatPrompt(id: Identity): string {
	return [
		`You are zer0ne, an expert coding assistant inside ${hostApp()}.`,
		identityLine(id),
		'Answer precisely in GitHub-flavored markdown. Use fenced code blocks with a language tag for code. File contents the user attached or @mentioned are included above their question.',
		'',
		STYLE_RULES
	].join('\n');
}


export const PLAN_PROMPT =
	'\n\nPLAN MODE is on: investigate with read-only tools only, then reply with a concise implementation plan — numbered steps, the files and functions to change, risks, and how to verify. Do not attempt edits or commands; the user will switch to Agent mode to execute.';

export function agentPrompt(settings: AgentSettings, id: Identity): string {
	const root = workspaceRoot();
	const lines = [
		`You are zer0ne, an expert autonomous coding agent running inside ${hostApp()} with direct access to the user's workspace through tools.`,
		identityLine(id),
		'',
		'How to work:',
		'- Investigate before answering: use list_files, grep and read_file rather than guessing about code. Check get_diagnostics after changing code.',
		'- Change code with edit_file (old_string copied exactly from the current file, without line-number prefixes), multi_edit for several changes to one file, apply_patch for changes across files, and write_file for new files. The user reviews edits and commands; if one is rejected, do not retry it unchanged.',
		'- Use code_intel (definition, references, hover, symbols, call hierarchy) to navigate code precisely, and rename_symbol for renames.',
		'- For multi-step tasks, keep a checklist with todo_write and update it as you finish items.',
		settings.browserTools ? '- Use web_search and web_fetch for documentation, error messages and anything outside the workspace; cite the URLs you relied on.' : '- Web search is disabled.',
		settings.browserAgent
			? '- To test or inspect a web app (e.g. a local dev server), drive the real browser: browser_navigate, then browser_click / browser_type / browser_select / browser_hover using the [ref] numbers; browser_wait_for after async loads; browser_resize mobile to check responsive layouts; browser_console and browser_network (failed=true) for errors. Links that open a new tab are followed automatically (browser_tabs to switch back). Alerts are accepted and logged. Screenshots come back with each step.'
			: '',
		settings.subagents ? '- Delegate broad, self-contained investigations to `task` subagents to keep your own context small.' : '',
		'- Use ask_user only for decisions that are genuinely the user\'s; otherwise make a reasonable choice and say so.',
		'- ' + UNTRUSTED_RULE,
		settings.agentMemory !== false
			? '- When the user states a durable preference, a fact about themselves or their work, or says "remember", save it with memory_retain and pick the matching category (profile, preferences, topics).' + (settings.memorySensitive ? '' : ' Never save sensitive details (health, religion, politics, credentials) to memory.') +
				' A fix worth repeating — a build, test or environment failure and what resolved it — is saved with memory_retain area "solution" so it is recalled when the same problem returns.'
			: '',
		settings.commandTool ? '- Start dev servers and watchers with run_command background: true, then read them with command_output; stop them with command_kill when done.' : '',
		'',
		STYLE_RULES
	];
	if (settings.customInstructions.trim()) {
		lines.push('', 'User instructions:', settings.customInstructions.trim());
	}
	// The environment facts come last. They differ per workspace and per day, and
	// the provider caches the leading tokens: a prompt that starts with them
	// shares no prefix with the same prompt in another workspace.
	lines.push(
		'',
		'Environment:',
		`- Workspace: ${vscode.workspace.name ?? '(none)'}${root ? ` (${root.scheme === 'file' ? root.fsPath : root.toString()})` : ''}`,
		`- OS: ${process.platform}${settings.commandTool ? `; run_command uses ${shellName()}` : ''}`,
		...(settings.stablePrefix === false ? [`- Date: ${new Date().toISOString().slice(0, 10)}`] : [])
	);
	return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n');
}

/** The tools a local model sees in lean mode: read, search, edit, write, run, check, plan (tested). */
export const LEAN_TOOLS = new Set(['list_files', 'read_file', 'grep', 'semantic_search', 'edit_file', 'multi_edit', 'apply_patch', 'write_file', 'run_command', 'command_output', 'get_diagnostics', 'todo_write', 'ask_user']);

/**
 * The agent prompt for a small local model: the same job in a fraction of the
 * words, with the tool discipline these models need spelled out (one call at a
 * time, exact JSON, read before editing).
 */
export function leanAgentPrompt(settings: AgentSettings, id: Identity): string {
	const root = workspaceRoot();
	const lines = [
		`You are zer0ne, a coding agent inside ${hostApp()}. You work in the user's workspace through tools.`,
		identityLine(id),
		'',
		'Rules:',
		'1. Look before you change: list_files, grep and read_file. Never guess file contents.',
		'2. Call ONE tool at a time. Its arguments are one JSON object that matches the tool\'s schema exactly — no comments, no extra text.',
		'3. edit_file: old_string is copied exactly from the file as you read it (without line numbers) and must be unique; include a few surrounding lines. Use write_file only for new files.',
		'4. After an edit, check get_diagnostics' + (settings.commandTool ? ' or run the tests with run_command' : '') + '.',
		'5. For a task with several steps, keep a short checklist with todo_write.',
		'6. When the work is done, answer in a few sentences: what changed, in which files, and how you checked it.',
		'7. ' + UNTRUSTED_RULE
	];
	if (settings.customInstructions.trim()) lines.push('', 'User instructions:', settings.customInstructions.trim().slice(0, 1500));
	// Last, like the full agent prompt: the workspace differs per project.
	lines.push(`Workspace: ${vscode.workspace.name ?? '(none)'}${root && root.scheme === 'file' ? ` (${root.fsPath})` : ''} · OS: ${process.platform}${settings.commandTool ? ` · shell: ${shellName()}` : ''}`);
	return lines.join('\n');
}

const LANGUAGE_NAMES: Record<string, string> = {
	en: 'English', sq: 'Albanian', 'zh-CN': 'Simplified Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
	'pt-BR': 'Brazilian Portuguese', ru: 'Russian', ja: 'Japanese', ko: 'Korean', tr: 'Turkish', ar: 'Arabic', hi: 'Hindi'
};

export function replyLanguageRule(code: string): string {
	const name = LANGUAGE_NAMES[code];
	return name
		? `\n\nAlways write your replies in ${name}, whatever language the user writes in. Keep code, identifiers and file paths unchanged.`
		: '\n\nReply in the language the user writes in.';
}

export interface SystemPromptInput {
	settings: AgentSettings;
	identity: Identity;
	useTools: boolean;
	plan: boolean;
	/** The prompt of this turn: recalled memories are added to its apiContent. */
	user: StoredMessage;
	store: ProviderStore;
	skillCatalog(): string;
	/** A small local model: the lean agent prompt, trimmed project rules, no skill catalog. */
	lean?: boolean;
}

export async function buildSystemPrompt(o: SystemPromptInput): Promise<string> {
	const { settings, identity, useTools, plan, user } = o;
	let system = useTools ? (o.lean ? leanAgentPrompt(settings, identity) : agentPrompt(settings, identity)) : chatPrompt(identity);
	if (useTools) {
		if (settings.includeAgentsMd) {
			const rules = await projectInstructions();
			system += o.lean && rules.length > 3000 ? rules.slice(0, 3000) + '\n[…project rules trimmed for the local model]' : rules;
		}
		if (settings.skills && !o.lean) {
			system += o.skillCatalog();
		}
		const root = workspaceRoot();
		if (settings.repoMap !== false && !o.lean && root?.scheme === 'file') {
			const map = repoMapFor(root.fsPath, settings.denyPaths);
			if (map) system += `\n\n${map}`;
		}
		// Recalled facts ride on the user message (stored with it), not in the
		// system prompt: a system prompt that changes every turn would defeat
		// the provider's prompt cache for the whole conversation.
		const base = user.apiContent ?? user.content;
		if (settings.agentMemory !== false && !base.includes('<saved-facts>') && !base.includes('<saved-solutions>')) {
			const recalled = await o.store.recallMemories(user.content, 6).catch(() => []);
			user.memoryRecall = recalled.map(m => ({ id: m.id, text: m.text, area: m.area, reason: m.recallReason ?? 'Matched your prompt' }));
			const facts = recalled.filter((m) => m.area !== 'solution');
			const solutions = recalled.filter((m) => m.area === 'solution');
			const blocks: string[] = [];
			if (facts.length) blocks.push(`<saved-facts>\n${facts.map((m) => '- ' + m.text).join('\n')}\n</saved-facts>`);
			if (solutions.length) blocks.push(`<saved-solutions>\n${solutions.map((m) => '- ' + m.text).join('\n')}\n</saved-solutions>`);
			if (blocks.length) user.apiContent = `${base}\n\n${blocks.join('\n\n')}`;
		}
		if (plan) {
			system += PLAN_PROMPT;
		}
		if (settings.stablePrefix !== false) user.apiContent = runtimeDate(user.apiContent ?? user.content);
	} else if (settings.customInstructions.trim()) {
		system += '\n\nUser instructions:\n' + settings.customInstructions.trim();
	}
	return system + replyLanguageRule(settings.replyLanguage);
}

/** Summaries belong to history so compaction preserves the system/tool cache prefix. */
export function summaryMessage(text: string): ChatMessage {
	return { role: 'user', content: `Summary of the earlier part of this conversation (context, not a new request):\n${text}` };
}

/**
 * Build API history from the display transcript within the model's
 * context budget. Tool activity from earlier turns is folded into a
 * short note so the model remembers what it already did. Messages
 * covered by an auto-compact summary are skipped.
 */
export function buildHistory(convo: StoredMessage[], current: StoredMessage, model: ModelEntry, systemChars: number, summaryUpTo: string | undefined, images: Map<string, MessageImage[]>, lean = false): ChatMessage[] {
	const upto = convo.indexOf(current);
	const start = summaryUpTo ? convo.findIndex((m) => m.id === summaryUpTo) + 1 : 0;
	const items: ChatMessage[] = [];
	let toolNotes: string[] = [];
	const flushNotes = () => {
		if (toolNotes.length) {
			items.push({ role: 'assistant', content: `[Tool activity: ${toolNotes.join('; ')}]` });
			toolNotes = [];
		}
	};
	for (const m of convo.slice(Math.max(0, start), upto + 1)) {
		if (m.isError || m.compacted || m.local) {
			continue;
		}
		if (m.kind === 'tool') {
			const label = m.tool
				? `${m.tool.name}(${m.tool.arg}) → ${m.tool.summary}`
				: m.approval
					? `${m.approval.kind} ${m.approval.path ?? m.approval.command ?? m.approval.tool ?? ''} → ${m.approval.status}`
					: m.question
						? `asked "${m.question.text}" → ${m.question.answer ?? m.question.status}`
						: '';
			if (label) {
				toolNotes.push(label.slice(0, 200));
			}
			continue;
		}
		if (m.role === 'user') {
			flushNotes();
			items.push({ role: 'user', content: m.apiContent ?? m.content, images: m === current ? images.get(m.id) : undefined });
		} else if (m.content.trim()) {
			flushNotes();
			items.push({ role: 'assistant', content: m.content });
		}
	}
	const merged: ChatMessage[] = [];
	for (const item of items) {
		const last = merged[merged.length - 1];
		if (last && last.role === item.role && item.role !== 'tool') {
			last.content += '\n\n' + item.content;
		} else {
			merged.push({ ...item });
		}
	}
	// A local model's window is small and exact: leave room for tool output and the answer (floor 4K chars, not 20K).
	const budget = lean ? Math.max(4_000, (model.contextWindow ?? 8192) * 3 * 0.5 - systemChars) : Math.max(20_000, (model.contextWindow ?? 128_000) * 3 * 0.7 - systemChars);
	let used = 0;
	let first = merged.length;
	while (first > 0) {
		const size = merged[first - 1].content.length;
		if (used + size > budget && first < merged.length) {
			break;
		}
		used += size;
		first--;
	}
	const kept = merged.slice(first);
	while (kept.length > 1 && kept[0].role !== 'user') {
		kept.shift();
	}
	return kept;
}

/** Modification time of a workspace file (-1 when it is gone). */
export function mtimeOf(relPath: string): number {
	try {
		return Math.round(fs.statSync(resolveInWorkspace(relPath).fsPath).mtimeMs);
	} catch {
		return -1; // deleted
	}
}

/**
 * With an exact transcript the model remembers file contents it read in
 * earlier turns — tell it when those files changed since (user edits,
 * git checkout, formatters), like Claude Code's system reminders.
 */
export function changedFilesReminder(t: Transcript): string | undefined {
	const changed: string[] = [];
	for (const [rel, mtime] of Object.entries(t.reads)) {
		const now = mtimeOf(rel);
		if (now !== mtime) {
			changed.push(now === -1 ? `${rel} (deleted)` : rel);
			t.reads[rel] = now;
		}
	}
	if (!changed.length) {
		return undefined;
	}
	return `<system-reminder>These files changed since you last read them (edited by the user or another tool): ${changed.slice(0, 30).join(', ')}${changed.length > 30 ? ', …' : ''}. Re-read them before relying on earlier contents or editing them.</system-reminder>`;
}
