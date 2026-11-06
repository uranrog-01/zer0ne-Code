import { applyLineEdits, contentTag, skeleton, type LineEdit } from '../core/skeleton';
import { editNotebook, renderNotebook } from '../core/notebook';
import { TOOL_OUTPUT_MAX_CHARS } from '../core/loop';
import { parseToolArgs } from './argRepair';
import * as vscode from 'vscode';
import { hostSettings, hostToolAllowed, isDesktopHost } from '../host/capabilities';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import * as os from 'os';
import { randomUUID } from 'crypto';
import type { MessageImage, ToolCall, ToolDef } from '../chatClient';
import type { AgentSettings, Approval, MemoryArea, MemoryCategory, ProviderStore } from '../providerStore';
import { BrowserAgent, BrowserSnapshot, describeSnapshot } from './browser';
import { browserSteps } from './browserBatch';
import { destructiveTool, externalTool, type McpManager } from './mcp';
import type { SkillStore } from './skills';
import { compressOutput, spillOutput } from './tokenSaver';
import { webFetch, webSearch, provenanceAllows } from './web';
import { adoptBackground, MORE_APPROVAL, MORE_READ_ONLY, moreToolDefs, runMoreTool, startBackground, takeOutput, waitForOutput } from './moreTools';
import { adaptReplacement, findUnique, matchNote } from './patch';
import { fileGuard } from './fileGuard';
import { assertNoRedaction } from './redact';
import { rgFiles, rgSearch } from './ripgrep';
import { compileDeny, denyGlobs } from './deny';
import { SANDBOX_DENIED } from './sandbox';
import { approveCommand, executeCommand } from './command';
import { DEBUG_READ_ONLY, debugToolDefs, runDebugTool } from './debugTools';
import { computerToolDef, runComputer } from './computer';
import type { LocalImageRequest, LocalImageResult } from './imageSpec';


/**
 * Agent tools: definitions (JSON schema sent to the model) and their
 * execution in the extension host.
 *
 * Safety model:
 *  - every path is resolved inside the workspace folder (no `..` escapes)
 *  - edit_file / write_file / run_command go through an approval card;
 *    only "Full access" mode approves them automatically
 *  - browser tools run headless on demand; nothing is embedded in the UI
 */

export interface ApprovalHandle {
	approved: boolean;
	finish(result: string, failed?: boolean): void;
	/** Final text after an in-editor review (blocks the user reverted or edited). */
	content?: string;
	/** Approved by a rule (allowlist, Full access…) rather than by the user. */
	auto?: boolean;
}

/** What a tool asks approval for; `review` lets the host show the change in the editor. */
export type ApprovalRequest = Omit<Approval, 'id' | 'status'> & { review?: { before: string; after: string }; signal?: AbortSignal };

/** One agent of a parallel batch or a chain (task tasks / chain). */
export interface SubagentItem {
	agent?: string;
	description?: string;
	prompt: string;
}

export interface ToolContext {
	taskId?: string;
	/** Capabilities fixed by the host when a child starts; nested dispatch retains them. */
	allowedTools?: ReadonlySet<string>;
	/** A dispatch-only lead: it delegates, reads and talks to the user, but never runs commands or edits. Workers do not inherit it. */
	dispatchOnly?: boolean;
	/**
	 * Background commands of this context are reported when they end, so a foreground command still running
	 * after a while moves to the background instead of holding the step. Only the chat's own lead sets it.
	 */
	backgroundReports?: boolean;
	/** recall: an object's summary and the ids of its neighbours (agents, commands, threads, events). */
	recall?(id: string, before?: string): string;
	checkTaskBudget?(): void;
	onToolTiming?(callId: string, timing: import('../core/toolScheduler').ScheduleTiming): void;
	store: ProviderStore;
	settings: AgentSettings;
	signal: AbortSignal;
	requestApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
	browser?: BrowserAgent;
	mcp?: McpManager;
	skills?: SkillStore;
	/** Show a question card and wait for the user's answer. */
	askUser?(question: string, options: string[]): Promise<string>;
	/** Run a subagent with a fresh context in the foreground; returns its report (with its id and usage). */
	runSubagent?(description: string, prompt: string, agent?: string): Promise<string>;
	/** Start a read-only subagent in the background; returns its id (multi-agent work). */
	spawnSubagent?(description: string, prompt: string, agent?: string): string;
	/** Up to 8 read-only subagents in parallel (4 at a time); returns every report. */
	runBatch?(items: SubagentItem[]): Promise<string>;
	/** Subagents one after another, {previous} = the report of the step before. */
	runChain?(items: SubagentItem[]): Promise<string>;
	/** agent_send: message a running agent, or continue a finished one with its context. */
	sendToAgent?(id: string, message: string, background?: boolean): Promise<string>;
	/** Start a writing subagent in its own git worktree; returns its id (w1, w2…). */
	spawnWriter?(description: string, prompt: string, agent?: string): Promise<string>;
	/** Review / merge / discard isolated writers. */
	writers?: { diff(id: string): Promise<string>; merge(id: string): Promise<string>; discard(id: string): Promise<string> };
	/** Wait (up to waitSeconds) for background subagents; returns their reports / status. */
	subagentResults?(ids: string[], waitSeconds: number): Promise<string>;
	/** Whether screenshots should be sent to the model. */
	vision: boolean;
	/** Called after a file changes (before = null for newly created files) — powers Undo/Review. */
	recordChange?(relPath: string, before: string | null, after: string): void;
	/** Plan mode / subagents: no writes, commands or side effects. */
	readOnly?: boolean;
	/** OCR for scans / images (GLM-OCR via a Z.ai or BigModel provider), when available. */
	ocr?(bytes: Buffer, mime: string): Promise<string>;
	/** Local image generation for image_generate: the Studio when it is installed. */
	imageGen?: {
		local(req: LocalImageRequest, onTick: (tick: { elapsed: number; status: string; queue?: number }) => void): Promise<LocalImageResult>;
		/** Image bundles installed right now; empty when the Studio is unavailable. */
		installed(): Array<{ id: string; name: string }>;
	};
	/** Tokens left in the model's context window, from the last request. */
	contextRemaining?(): import('./contextBudget').ContextBudget | undefined;
	/** A file was read (for "changed since you read it" reminders). */
	onRead?(relPath: string): void;
	/** OS sandbox for commands (see tools/sandbox.ts). */
	sandbox?: { mode: 'off' | 'auto' | 'always'; network: boolean; storageDir: string; sourceFile: string };
	/** Extension storage + media folders (helpers compiled on first use). */
	storageDir?: string;
	onFeatureReport?(report: import('./projectChecks').ProjectReport): void;
	featureStorageDir?: string;
	mediaDir?: string;
	
	
	/** The chat this tool call belongs to (session_search skips it). */
	sessionId?: string;
	/** Whose reads count for read-before-edit (fileGuard); default sessionId. Writer subagents get their own. */
	guardScope?: string;
	/** Project code index (semantic_search). */
	searchCode?(query: string, limit: number): Promise<Array<{ file: string; start: number; end: number; score: number; preview: string; via: string; kind: 'code' | 'doc' }>>;
	/** URLs the user shared this session (webfetchProvenance guard). */
	urlProvenance?: ReadonlySet<string>;
	/** Open a published artifact in the preview panel (publish_artifact). */
	openArtifact?(file: string, title: string): void | Promise<void>;
	/** The chat's shared task board (task_board): the lead agent and its subagents coordinate through it. */
	board?: {
		list(): Array<{ id: string; text: string; status: 'open' | 'claimed' | 'done'; claimedBy?: string; note?: string }>;
		add(text: string): { id: string };
		claim(id: string, by: string): string;
		complete(id: string, note: string): string;
		reopen(id: string): string;
	};
}

export interface ToolOutcome {
	mcpApp?: import('../providerStore').StoredMessage['mcpApp'];
	/** Text returned to the model. */
	api: string;
	/** Short text for the tool card. */
	summary: string;
	detail?: string;
	error?: boolean;
	todos?: Array<{ text: string; done: boolean }>;
	/** Images for the model (browser screenshots, MCP images). */
	images?: MessageImage[];
	/** Thumbnail for the chat card. */
	image?: string;
	url?: string;
}

/** Tools whose card is an approval card (or question card) instead of a plain tool row. */
export const APPROVAL_TOOLS = new Set(['edit_file', 'edit_lines', 'write_file', 'notebook_edit', 'run_command', 'create_skill', 'ask_user', ...MORE_APPROVAL]);
/** Tools allowed in Plan mode and in subagents. */
export const READ_ONLY_TOOLS = new Set([
	'list_files', 'read_file', 'grep', 'get_diagnostics', 'get_editor_context', 'todo_write', 'memory_recall',
	'web_search', 'web_fetch', 'git_status', 'git_diff', 'git_log', 'skill', 'ask_user', 'agent_result', 'session_search', 'recall',
	'browser_snapshot', 'browser_console', 'browser_network', 'agent_diff', 'mcp_resources', 'mcp_prompts',
	...MORE_READ_ONLY,
	...DEBUG_READ_ONLY
]);

/** How long the chat's lead waits on a foreground command before it moves to the background. */
export const MOVE_TO_BACKGROUND_SECONDS = 20;

/** The longest a dispatch-only lead may wait on a report or a command's output. */
export const DISPATCH_WAIT_SECONDS = 5;

/** What a dispatch-only lead may call: delegation, coordination, questions and read-only look-ups. */
export const DISPATCH_TOOLS = new Set([
	'task', 'agent_send', 'agent_result', 'agent_diff', 'agent_merge', 'agent_discard', 'task_board', 'ask_user', 'todo_write',
	'recall', 'memory_recall', 'session_search', 'read_file', 'grep', 'list_files', 'git_status', 'git_diff', 'git_log',
	'skill', 'context_remaining', 'tool_search', 'use_tool', 'command_output', 'command_kill'
]);

export function toolPolicyError(name: string, ctx: ToolContext): string | undefined {
	if (ctx.allowedTools && !ctx.allowedTools.has(name)) return `${name} is not permitted for this agent.`;
	if (ctx.dispatchOnly && !DISPATCH_TOOLS.has(name)) return `${name} is not available to the main agent in this workflow: it only delegates. Hand this to a worker with task.`;
	if (ctx.readOnly && !READ_ONLY_TOOLS.has(name)) return `${name} is not available in Plan mode (read-only). Describe the change in your plan instead.`;
	return undefined;
}

const EXCLUDE = '**/{node_modules,.git,out,dist,build,.next,coverage,__pycache__,.venv}/**';
const MAX_READ_CHARS = 60_000;
/**
 * A file bigger than this is never loaded into memory as one string: the whole
 * file would blow the engine up (and the model asked for a file, not a core
 * dump). The limit can be moved with ZER0NE_MAX_READ_BYTES.
 */
const MAX_READ_BYTES = 20 * 1024 * 1024;
/** One line longer than this (a minified bundle) is cut instead of buffered whole. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

function maxReadBytes(): number {
	const raw = Number(process.env.ZER0NE_MAX_READ_BYTES);
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MAX_READ_BYTES;
}

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

export function buildToolDefs(settings: AgentSettings, opts: { mcp?: ToolDef[]; skills?: boolean; readOnly?: boolean; subagent?: boolean; agents?: Array<{ name: string; description: string; canWrite?: boolean }> } = {}): ToolDef[] {
	settings = hostSettings(settings);
	const all = [...baseToolDefs(settings), ...moreToolDefs(settings)];
	if (settings.debugTools) {
		all.push(...debugToolDefs());
	}
	if (settings.computerUse) {
		all.push(computerToolDef());
	}
	
	if (settings.gitTools) {
		all.push(
			{ name: 'git_status', description: 'Show `git status` (branch, staged/unstaged/untracked files) for the workspace.', parameters: obj({}) },
			{
				name: 'git_diff',
				description: 'Show the git diff of working-tree changes (or staged changes).',
				parameters: obj({ path: { type: 'string', description: 'Optional file to limit the diff' }, staged: { type: 'boolean', description: 'Diff the index instead of the working tree' } })
			},
			{ name: 'git_log', description: 'Show recent commits (one line each).', parameters: obj({ count: { type: 'number', description: 'How many commits (default 15)' } }) },
			{
				name: 'git_stage',
				description: 'Stage workspace files for commit (git add --). The user approves.',
				parameters: obj(
					{ paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative paths to stage (up to 50)' }, all: { type: 'boolean', description: 'Stage every modification and deletion of tracked files (git add -u)' } },
					[]
				)
			},
			{
				name: 'git_commit',
				description: 'Commit what is staged (or, with all: true, every tracked change) with a one-line subject and an optional body. Never pushes. The user approves.',
				parameters: obj(
					{
						message: { type: 'string', description: 'Commit message: subject line, then a blank line and the body' },
						all: { type: 'boolean', description: 'Also stage modifications and deletions of tracked files first (never untracked files)' }
					},
					['message']
				)
			},
			{
				name: 'git_branch',
				description: 'Create and check out a branch, check out an existing one, or list branches. The user approves create and switch.',
				parameters: obj({ action: { type: 'string', enum: ['create', 'switch', 'list'] }, name: { type: 'string', description: 'create/switch: the branch name' } }, ['action'])
			}
		);
	}
	all.push({
		name: 'ask_user',
		description: 'Ask the user a clarifying question when a decision is genuinely theirs (ambiguous requirements, risky choices). Offer 2-4 short options when possible. Do not ask things you can find out with tools.',
		parameters: obj(
			{ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers (the user may also type their own)' } },
			['question']
		)
	});
	if (settings.subagents && !opts.subagent) {
		const agents = opts.agents ?? [];
		const agentProp = agents.length
			? { agent: { type: 'string', enum: agents.map((a) => a.name), description: 'Agent type to run as (default: a read-only researcher):\n' + agents.map((a) => `- ${a.name}${a.canWrite ? ' (can edit)' : ' (read-only)'}: ${a.description}`).join('\n') } }
			: {};
		const item = (promptHint: string) =>
			obj({ ...agentProp, description: { type: 'string', description: '3-6 word summary shown to the user' }, prompt: { type: 'string', description: promptHint } }, ['prompt']);
		all.push({
			name: 'task',
			description: [
				'Launch subagents. Each starts with a fresh context, does the work with its own tools and returns one report to you — the user does not see it, so relay what matters. The prompt must be complete and self-contained.',
				'Use exactly one mode:',
				'- prompt: one agent. Without `agent` it is a read-only researcher. An agent marked "can edit" automatically runs in its own Git worktree; review and apply its changes before treating them as part of the main project. A read-only agent still running after 3 minutes moves to the background.',
				'- tasks: up to 8 independent researchers or named isolated coding workers (up to 10 when the multi-agent workflow is enabled); the host enforces concurrency limits and returns every report.',
				'- chain: agents one after another; {previous} in a step\'s prompt is replaced by the report of the step before (e.g. Explore → Plan → general-purpose). Stops at the first failure.',
				'- background: true (with prompt): returns an id at once and runs read-only. Keep working on things that do not overlap; its report arrives by itself as a notification when it finishes (or wait with agent_result).',
				'- isolated: true (with prompt): a WRITER in its own git worktree and branch — it edits, builds and tests without touching the workspace. Review with agent_diff, then agent_merge or agent_discard. Use for independent pieces of a larger change. A named `agent` must be marked "can edit".',
				'Every result names the agent id: agent_send continues that agent with its context intact.',
				'When to use: broad searches and investigations across many files (you keep the conclusion, not the file dumps), independent work to run in parallel, a plan or a review from a specialist. For one fact in a file you already know, just read it.'
			].join('\n'),
			parameters: obj({
				description: { type: 'string', description: '3-6 word summary shown to the user' },
				prompt: { type: 'string', description: 'Complete, standalone instructions for one agent' },
				...agentProp,
				tasks: { type: 'array', maxItems: 10, items: item('Complete, standalone instructions for this agent'), description: 'Parallel mode: independent researchers are read-only; named editing agents get isolated worktrees. 8 maximum unless workflow is enabled' },
				chain: { type: 'array', maxItems: 8, items: item('Instructions for this step; {previous} is replaced by the previous step\'s report'), description: 'Chain mode: agents run in order, each handed the report of the one before' },
				background: { type: 'boolean', description: 'Run the one agent in the background (read-only); its report arrives as a notification' },
				isolated: { type: 'boolean', description: 'A writing agent in its own git worktree (own branch); returns an id at once' }
			})
		});
		all.push({
			name: 'agent_send',
			description: 'Send a message to an agent by id. A running agent reads it before its next step (steer it, add context). A finished agent continues with its whole context and your message (follow-up questions, "now fix what you found") — in the foreground by default, or background: true.',
			parameters: obj({ id: { type: 'string', description: 'Agent id from a task result, e.g. a3' }, message: { type: 'string' }, background: { type: 'boolean' } }, ['id', 'message'])
		});
		all.push(
			{ name: 'agent_diff', description: 'Show all unstaged and untracked changes of a finished isolated writer (task isolated: true) as a unified diff.', parameters: obj({ id: { type: 'string' } }, ['id']) },
			{ name: 'agent_merge', description: 'Bring a finished isolated writer\'s changes into the workspace (the user approves the diff). Its worktree is then removed.', parameters: obj({ id: { type: 'string' } }, ['id']) },
			{ name: 'agent_discard', description: 'Throw away an isolated writer\'s work and remove its worktree.', parameters: obj({ id: { type: 'string' } }, ['id']) }
		);
		all.push({
			name: 'agent_result',
			description: 'Wait for agents by id and read their reports (background agents, writers, or earlier chain steps). Background reports also arrive by themselves; use this when you need one before you can go on. Waits up to wait_seconds for the ones still running.',
			parameters: obj({ ids: { type: 'array', items: { type: 'string' } }, wait_seconds: { type: 'number', description: 'Default 120, max 600' } }, ['ids'])
		});
	}
	if (opts.skills) {
		all.push(
			{ name: 'skill', description: 'Load the full instructions of an available skill by name before doing a task it covers.', parameters: obj({ name: { type: 'string' } }, ['name']) },
			{
				name: 'create_skill',
				description: 'Write a reusable skill (SKILL.md) capturing a procedure the user wants repeated. The user approves it.',
				parameters: obj(
					{
						name: { type: 'string', description: 'kebab-case name' },
						description: { type: 'string', description: 'One line: what it does and when to use it' },
						instructions: { type: 'string', description: 'Markdown instructions' },
						scope: { type: 'string', enum: ['workspace', 'user'], description: 'workspace (default) or user-wide' }
					},
					['name', 'description', 'instructions']
				)
			}
		);
	}
	if (settings.browserAgent) {
		all.push(
			{
				name: 'browser_navigate',
				description:
					'Open a URL in the agent\'s own Chrome/Edge window (e.g. http://localhost:5173 to test a dev server). Returns a screenshot plus numbered interactive elements [ref] and visible text. Use this — not web_fetch — to test, click through or visually check web apps.',
				parameters: obj({ url: { type: 'string' } }, ['url'])
			},
			{ name: 'browser_snapshot', description: 'Re-capture the current page, including reachable frames and open shadow roots. Stable [ref] numbers identify exact elements; removed elements are rejected. Set screenshot=false for a smaller text-only result.', parameters: obj({ screenshot: { type: 'boolean' } }) },
			{
				name: 'browser_batch',
				description: 'Run 1–12 known browser steps in order with one final snapshot. Use refs from the current snapshot; they remain stable until their elements or document disappear. Stops on the first failure and reports completed steps; never blindly retry a partially completed batch. Suitable for filling several fields and submitting once. Actions require the same permission as individual browser actions.',
				parameters: obj({ steps: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'hover', 'type', 'select', 'press', 'wait_for'] }, ref: { type: 'number' }, text: { type: 'string' }, value: { type: 'string' }, key: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' }, gone: { type: 'string' }, seconds: { type: 'number', minimum: 0.1, maximum: 15 } }, required: ['action'], additionalProperties: false } }, screenshot: { type: 'boolean' } }, ['steps'])
			},
			{
				name: 'browser_click',
				description: 'Click an element by its [ref] from the latest snapshot (or x/y viewport coordinates). Returns the new snapshot.',
				parameters: obj({ ref: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } })
			},
			{
				name: 'browser_type',
				description: 'Type into an input/textarea by [ref]. Replaces the current value unless clear=false; submit=true presses Enter.',
				parameters: obj({ ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } }, ['ref', 'text'])
			},
			{ name: 'browser_press', description: 'Press a key (Enter, Tab, Escape, ArrowDown, PageDown, Backspace, or a single character), optionally with modifiers: "Control+a", "Shift+Tab", "Meta+Enter".', parameters: obj({ key: { type: 'string' } }, ['key']) },
			{ name: 'browser_hover', description: 'Move the pointer over an element by [ref] — opens hover menus and tooltips.', parameters: obj({ ref: { type: 'number' } }, ['ref']) },
			{ name: 'browser_select', description: 'Choose an option in a <select> by [ref], matching the option value or its visible label.', parameters: obj({ ref: { type: 'number' }, value: { type: 'string' } }, ['ref', 'value']) },
			{
				name: 'browser_wait_for',
				description: 'Wait until text appears on the page (text), disappears (gone), or simply wait some seconds. Use after actions that load data asynchronously.',
				parameters: obj({ text: { type: 'string' }, gone: { type: 'string' }, seconds: { type: 'number', description: 'Time limit (default 15 s when waiting for text, else 2 s; max 60)' } })
			},
			{ name: 'browser_forward', description: 'Go forward in history.', parameters: obj({}) },
			{ name: 'browser_reload', description: 'Reload the page (bypassing the cache) — e.g. after changing code of a dev server without hot reload.', parameters: obj({}) },
			{
				name: 'browser_resize',
				description: 'Test responsive layouts: emulate a phone (390×844, touch), a tablet (820×1180), a custom width/height, or back to desktop.',
				parameters: obj({ preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop'] }, width: { type: 'number' }, height: { type: 'number' } })
			},
			{
				name: 'browser_tabs',
				description: 'Manage this agent’s browser tabs: list, select by index, open (optionally at url), or close. Other agents’ and pre-existing tabs are not listed or controlled.',
				parameters: obj({ action: { type: 'string', enum: ['list', 'select', 'new', 'close'] }, index: { type: 'number' }, url: { type: 'string' } }, ['action'])
			},
			{ name: 'browser_network', description: 'Recent network requests with status codes; failed=true shows only failures (4xx/5xx, blocked, DNS, CORS). Great for debugging broken API calls.', parameters: obj({ failed: { type: 'boolean' }, clear: { type: 'boolean' } }) },
			{ name: 'browser_scroll', description: 'Scroll the page up or down by about a screen.', parameters: obj({ direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number', description: 'Screens to scroll (default 0.8)' } }, ['direction']) },
			{ name: 'browser_back', description: 'Go back in history.', parameters: obj({}) },
			{ name: 'browser_console', description: 'Read console messages, uncaught errors and navigations captured from the page.', parameters: obj({ clear: { type: 'boolean' } }) },
			{ name: 'browser_evaluate', description: 'Evaluate a JavaScript expression in the page and return the JSON result (checks, reading state).', parameters: obj({ expression: { type: 'string' } }, ['expression']) },
			{ name: 'browser_close', description: 'Close this agent’s browser tabs when finished; other agents’ tabs remain open.', parameters: obj({}) }
		);
	}
	all.push(...(opts.mcp ?? []));
	if (opts.readOnly || opts.subagent) {
		return all.filter((t) => hostToolAllowed(t.name) && READ_ONLY_TOOLS.has(t.name) && !(opts.subagent && t.name === 'ask_user'));
	}
	return all.filter(t => hostToolAllowed(t.name));
}

function baseToolDefs(settings: AgentSettings): ToolDef[] {
	const tools: ToolDef[] = [
		{
			name: 'list_files',
			description: 'List workspace files matching a glob (node_modules, .git and build output are excluded). Returns relative paths.',
			parameters: obj({
				glob: { type: 'string', description: 'Glob relative to the workspace root, e.g. "src/**/*.ts". Default "**/*".' }
			})
		},
		{
			name: 'read_file',
			description:
				'Read text files (Jupyter notebooks are shown as cells; a folder path lists its entries). Give `paths` to read several files in one call. Output lines are prefixed with their line number and a tab; the prefix is NOT part of the file. A large source file read without offset/limit comes back as its skeleton: signatures stay, long bodies fold into "⋯ N lines folded (a–b)" markers — read that range with offset/limit, or pass full: true. A file over 20 MB is never loaded whole: read it with offset/limit (a line range of it is read from disk) or use grep. Every read ends with the file\'s [tag xxxx] for edit_lines.',
			parameters: obj({
				path: { type: 'string', description: 'Workspace-relative path' },
				paths: { type: 'array', items: { type: 'string' }, description: 'Several files at once (up to 20); use instead of path' },
				offset: { type: 'number', description: '1-based line to start from' },
				limit: { type: 'number', description: 'Maximum number of lines (default 2000)' },
				full: { type: 'boolean', description: 'Read the whole file even when it is large (no skeleton)' }
			})
		},
		{
			name: 'grep',
			description: 'Search file contents (ripgrep syntax, respects .gitignore; look-arounds allowed). Default: case-insensitive regex, matched lines as path:line: text. Options: output "files" (matching paths) or "count" (per-file match counts); context (before/after, 0-20 lines each) shows surrounding lines; fixed searches the pattern literally.',
			parameters: obj(
				{
					pattern: { type: 'string', description: 'Regular expression' },
					glob: { type: 'string', description: 'Optional file glob, e.g. "src/**/*.ts"' },
					case_sensitive: { type: 'boolean', description: 'Match case exactly (default insensitive)' },
					fixed: { type: 'boolean', description: 'Treat the pattern as literal text, not a regex' },
					output: { type: 'string', enum: ['content', 'files', 'count'], description: 'content (default): path:line: text — files: matching paths — count: one path:count line per file' },
					before: { type: 'number', description: 'Lines of context before each match (0–20, content mode)' },
					after: { type: 'number', description: 'Lines of context after each match (0–20, content mode)' }
				},
				['pattern']
			)
		},
		{
			name: 'get_diagnostics',
			description: 'Get current errors and warnings reported by VS Code language services (TypeScript, ESLint, etc.).',
			parameters: obj({ path: { type: 'string', description: 'Optional workspace-relative file to limit results' } })
		},
		{
			name: 'get_editor_context',
			description: "Get the user's active editor: file path, cursor line, selected text, and open tabs.",
			parameters: obj({})
		},
		{
			name: 'edit_lines',
			description:
				'Edit a file by line numbers from your latest read_file — no need to retype the old text. Give the [tag xxxx] that read ended with; if the file changed since, the edit is refused and you re-read. Each edit replaces lines start..end (inclusive) with text; text "" deletes them; end = start - 1 inserts before start. All ranges refer to the file as you read it and must not overlap. Prefer this over edit_file for changes to code you just read. The user approves each edit.',
			parameters: obj(
				{
					path: { type: 'string', description: 'Workspace-relative path' },
					tag: { type: 'string', description: 'The 4-hex [tag] from your latest read of this file' },
					edits: {
						type: 'array',
						items: obj({ start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string', description: 'New lines (no line-number prefixes)' } }, ['start', 'end', 'text']),
						description: 'Line-range replacements'
					}
				},
				['path', 'tag', 'edits']
			)
		},
		{
			name: 'edit_file',
			description:
				'Replace an exact snippet in a file. old_string must match the current file exactly (without read_file line-number prefixes) and be unique unless replace_all is true. The user approves each edit.',
			parameters: obj(
				{
					path: { type: 'string', description: 'Workspace-relative path' },
					old_string: { type: 'string', description: 'Exact existing text to replace' },
					new_string: { type: 'string', description: 'Replacement text' },
					replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' }
				},
				['path', 'old_string', 'new_string']
			)
		},
		{
			name: 'notebook_edit',
			description: 'Edit one Jupyter notebook cell (.ipynb): replace its source, insert a new cell at a position, or delete it. Cells are numbered from 1 as read_file shows them. Outputs of a changed code cell are cleared. The user approves each edit.',
			parameters: obj(
				{
					path: { type: 'string', description: 'Workspace-relative .ipynb path' },
					cell: { type: 'number', description: '1-based cell number (for insert: the new cell\'s position; count + 1 appends)' },
					mode: { type: 'string', enum: ['replace', 'insert', 'delete'] },
					source: { type: 'string', description: 'New cell source (replace / insert)' },
					cell_type: { type: 'string', enum: ['code', 'markdown'] }
				},
				['path', 'cell', 'mode']
			)
		},
		{
			name: 'write_file',
			description: 'Create a new file or fully overwrite an existing one. Prefer edit_file for small changes. The user approves each write.',
			parameters: obj(
				{
					path: { type: 'string', description: 'Workspace-relative path' },
					content: { type: 'string', description: 'Complete file content' }
				},
				['path', 'content']
			)
		},
		{
			name: 'todo_write',
			description: 'Replace the task checklist shown to the user. Use it for multi-step work and update it as items complete.',
			parameters: obj(
				{
					items: {
						type: 'array',
						items: obj({ text: { type: 'string' }, done: { type: 'boolean' } }, ['text', 'done'])
					}
				},
				['items']
			)
		},
		{
			name: 'task_board',
			description: 'The shared task board for this chat: you, other subagents and the lead agent coordinate through it. action "add" posts a task (one clear deliverable), "claim" takes an open one under your agent id, "complete" marks yours done (with a one-line note: what the next agent needs), "reopen" puts a task back when it must be redone, "list" (default) shows everything. Prefer claiming over duplicating work another agent posted.',
			parameters: obj(
				{
					action: { type: 'string', enum: ['list', 'add', 'claim', 'complete', 'reopen'] },
					text: { type: 'string', description: 'add: the task, self-contained (files, what done means)' },
					id: { type: 'string', description: 'claim/complete/reopen: the task id from list' },
					note: { type: 'string', description: 'complete: one line of what was done or found' },
					by: { type: 'string', description: 'claim: an agent id (from a task report) or a short name' }
				},
				[]
			)
		}
	];
	if (settings.recallTool !== false) {
		tools.push({
			name: 'recall',
			description: 'Look up an object by the id a notice or report gave you — an agent (a12-…), a background command (bg3), a thread (th-…), a thread event (ev7) — or "list" for what this chat has. Returns a short summary with the ids of related objects, so you can follow them one hop at a time instead of rereading whole transcripts.',
			parameters: obj(
				{
					id: { type: 'string', description: 'The id to look up, or "list"' },
					before: { type: 'string', description: 'thread only: show events before this event id (older history)' }
				},
				['id']
			)
		});
	}
	if (settings.agentMemory !== false) {
		tools.push(
			{
				name: 'memory_retain',
				description: `Save one durable fact or solution for future sessions in this workspace — who the user is, how they want you to respond, a subject of their work, or a fix that will apply again. Relevant entries join new conversations automatically.${settings.memorySensitive ? '' : ' Never save sensitive details (health, religion, politics, credentials, finances).'}`,
				parameters: obj(
					{
						fact: { type: 'string', description: 'The fact or solution, stated standalone' },
						category: { type: 'string', description: "'profile' (who the user is), 'preferences' (how they want answers) or 'topics' (chosen automatically when omitted)" },
						area: { type: 'string', description: "'fact' (default) for durable knowledge, or 'solution' for a recurring problem and the fix that worked" }
					},
					['fact']
				)
			},
			{
				name: 'memory_recall',
				description: 'Search facts and solutions saved in earlier sessions by keywords and, when an embedding model is configured, by meaning.',
				parameters: obj({ query: { type: 'string', description: 'What to remember, in your own words' } }, ['query'])
			}
		);
	}
	if (settings.chatSearch !== false) {
		tools.push({
			name: 'session_search',
			description: 'Search the user\'s past chats (not this one) by keywords — how something was solved before, decisions made, earlier errors. Returns matching chats with short excerpts.',
			parameters: obj({ query: { type: 'string', description: 'Keywords, e.g. "vite proxy cors"' } }, ['query'])
		});
	}
	if (settings.commandTool) {
		tools.push({
			name: 'run_command',
			description: `Run a shell command in the workspace root (${shellName()}${process.platform === 'win32' ? '; chain commands with ; rather than &&; use PowerShell syntax' : ''}) and return exit code and output. The user approves each command. Never run interactive commands; use background: true for servers and watchers${settings.commandNotices ? ', and for long builds or test runs: when a background command ends on its own you are told how it ended, with the end of its output, so keep working meanwhile instead of polling it' : ''}.`,
			parameters: obj(
				{
					command: { type: 'string', description: 'The command line to run' },
					timeout_seconds: { type: 'number', description: 'Timeout in seconds (default 120, max 600)' },
					background: { type: 'boolean', description: `Start a long-running process (dev server, watcher${settings.commandNotices ? ', long build or test run' : ''}) and return right away with an id; read it with command_output, stop it with command_kill` },
					...(settings.sandbox !== 'off' ? { sandbox: { type: 'boolean', description: 'Commands run in an OS sandbox (writes only inside the workspace and temp). Pass false only after a command failed because the sandbox blocked a write elsewhere or network access; the user must approve running it unsandboxed.' } } : {})
				},
				['command']
			)
		});
	}
	if (settings.browserTools) {
		tools.push(
			{
				name: 'web_search',
				description: 'Search the web. Returns titles, URLs and page excerpts. Use for docs, error messages and recent information.',
				parameters: obj(
					{
						query: { type: 'string', description: 'Search query' },
						count: { type: 'number', description: 'Number of results (1-10, default 6)' }
					},
					['query']
				)
			},
			{
				name: 'web_fetch',
				description: 'Fetch a web page (http/https) and return its readable content as markdown.',
				parameters: obj(
					{
						url: { type: 'string', description: 'The URL to fetch' },
						max_chars: { type: 'number', description: 'Maximum characters to return (default 20000)' }
					},
					['url']
				)
			}
		);
		if (settings.openPages) {
			tools.push({
				name: 'open_url',
				description: isDesktopHost() ? 'Open a project localhost applet or a link in the system browser. Does not return page content.' : "Open a URL for the user in VS Code's built-in Simple Browser (e.g. to preview a local dev server). Does not return page content.",
				parameters: obj({ url: { type: 'string', description: 'http(s) URL' } }, ['url'])
			});
		}
	}
	return tools;
}

// ---------------------------------------------------------------- helpers

export function workspaceRoot(): vscode.Uri | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

export function shellName(): string {
	return process.platform === 'win32' ? 'PowerShell' : process.env.SHELL?.split('/').pop() || 'sh';
}

/** Resolve a model-supplied path, refusing anything outside the workspace. */
export function resolveInWorkspace(p: string): vscode.Uri {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('No workspace folder is open.');
	}
	const input = (p ?? '').trim().replace(/^["']|["']$/g, '');
	if (!input) {
		throw new Error('A path is required.');
	}
	if (root.scheme === 'file') {
		const base = root.fsPath;
		const abs = path.resolve(base, input);
		const rel = path.relative(base, abs);
		if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
			throw new Error(`"${p}" is outside the workspace.`);
		}
		if (process.platform === 'win32' && /[:\x00-\x1f]/.test(rel)) throw new Error('Alternate streams and device paths are not workspace files.');
		// Resolve the nearest existing parent too: new files can be written through a junction.
		if (fs.existsSync(base)) {
			const realBase = fs.realpathSync(base);
			let probe = abs;
			for (;;) {
				try {
					const real = fs.realpathSync(probe);
					const relative = path.relative(realBase, real);
					if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`"${p}" is outside the workspace.`);
					return vscode.Uri.file(abs);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || probe === path.dirname(probe)) throw error;
					// A dangling link must not become a newly-created path through an unchecked target.
					try { if (fs.lstatSync(probe).isSymbolicLink()) throw new Error('The workspace link has no accessible target.'); }
					catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
					probe = path.dirname(probe);
				}
			}
		}
		return vscode.Uri.file(abs);
	}
	const rel = path.posix.normalize(input.replace(/\\/g, '/')).replace(/^\/+/, '');
	if (rel.startsWith('..')) {
		throw new Error(`"${p}" is outside the workspace.`);
	}
	return vscode.Uri.joinPath(root, rel);
}

export function rel(uri: vscode.Uri): string {
	return vscode.workspace.asRelativePath(uri, false);
}

/** Current text of a file — the editor buffer if it is open (unsaved edits included). */
export async function readText(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) {
		return open.getText();
	}
	const bytes = await vscode.workspace.fs.readFile(uri);
	if (bytes.subarray(0, 8000).includes(0)) {
		throw new Error('This looks like a binary file.');
	}
	return new TextDecoder().decode(bytes);
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/** Write through the editor when the file is open so dirty buffers stay consistent. */
export async function writeText(uri: vscode.Uri, text: string): Promise<void> {
	const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
	if (open) {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, open.validateRange(new vscode.Range(0, 0, open.lineCount, 0)), text);
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error('VS Code refused the edit.');
		}
		await open.save();
		return;
	}
	// readText's TextDecoder drops a UTF-8 BOM; put it back so editing a file never changes its encoding (OpenCode).
	let bom = false;
	try {
		const old = await vscode.workspace.fs.readFile(uri);
		bom = old[0] === 0xef && old[1] === 0xbb && old[2] === 0xbf;
	} catch {
		// New file.
	}
	const bytes = new TextEncoder().encode(text);
	await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
	await vscode.workspace.fs.writeFile(uri, bom && text.charCodeAt(0) !== 0xfeff ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
}

/** fileGuard key for a workspace file. */
function guardKey(uri: vscode.Uri): string {
	return uri.toString();
}

export function scopeOf(ctx: ToolContext): string | undefined {
	return ctx.guardScope ?? ctx.sessionId;
}

/**
 * After the agent's own write, the file's text as reads will return it (an
 * open editor may have normalized line endings) — so the next edit needs no
 * re-read (ZCode / Claude Code).
 */
export async function observeWritten(ctx: ToolContext, uri: vscode.Uri): Promise<void> {
	try {
		fileGuard.observe(scopeOf(ctx), guardKey(uri), await readText(uri));
	} catch {
		// Unreadable now: the next edit asks for a read.
	}
}

/** Text the user approved must still be the file's text when the change is written. */
function assertUnchanged(current: string, approved: string): void {
	if (current !== approved) {
		throw new Error('The file changed while waiting for approval (the user or another tool edited it). Re-read it and retry — nothing was written.');
	}
}

/**
 * After a write, report the file's current errors (opencode does the same):
 * the agent fixes them while the change is fresh. Waits briefly for the
 * language server to re-check the file.
 */
export async function errorsAfterEdit(uri: vscode.Uri, settings: AgentSettings): Promise<string> {
	if (isDesktopHost()) return '';
	if (!settings.verifyDiagnostics || !vscode.languages.onDidChangeDiagnostics) {
		return '';
	}
	try {
		const doc = await vscode.workspace.openTextDocument(uri);
		if (doc.languageId === 'plaintext' || doc.languageId === 'markdown') {
			return '';
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, 1500);
			const sub = vscode.languages.onDidChangeDiagnostics((e) => e.uris.some((u) => u.toString() === uri.toString()) && setTimeout(done, 150));
			function done() {
				clearTimeout(timer);
				sub.dispose();
				resolve();
			}
		});
	} catch {
		return '';
	}
	const errors = vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
	if (!errors.length) {
		return '';
	}
	const lines = errors.slice(0, 10).map((d) => `  ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source ? `[${d.source}] ` : ''}${d.message.split('\n')[0]}`);
	return `\n\nVS Code now reports ${errors.length} error${errors.length > 1 ? 's' : ''} in this file:\n${lines.join('\n')}${errors.length > 10 ? '\n  …' : ''}`;
}

/** Compressed output plus, when Token Saver had to cut it, where the whole output was saved. */
function withSpill(full: string, compressed: string, label: string): string {
	const root = workspaceRoot();
	return compressed + spillOutput(root?.scheme === 'file' ? root.fsPath : undefined, full, compressed, label.split(/\s+/)[0] ?? 'output');
}

export function clip(text: string, max: number): string {
	if (text.length <= max) {
		return text;
	}
	const head = Math.floor(max * 0.6);
	return `${text.slice(0, head)}\n[… ${text.length - max} characters omitted …]\n${text.slice(text.length - (max - head))}`;
}

export function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------- execution

/** The first argument path a deny rule blocks, if any. */
function deniedPath(tool: string, args: Record<string, unknown>, rules: string): string | undefined {
	if (!rules.trim()) {
		return undefined;
	}
	const isDenied = compileDeny(rules);
	const candidates = [args.path, args.from, args.to, ...(Array.isArray(args.paths) ? args.paths : [])].filter((x): x is string => typeof x === 'string' && !!x);
	if (tool === 'apply_patch' && typeof args.patch === 'string') {
		for (const m of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
			candidates.push((m[1] ?? m[2]).trim());
		}
	}
	for (const p of candidates) {
		try {
			const r = rel(resolveInWorkspace(p));
			if (isDenied(r)) {
				return r;
			}
		} catch {
			// path errors are reported by the tool itself
		}
	}
	return undefined;
}

/**
 * What the model may see of one tool result: the same ceiling the writer and
 * CLI paths use. A result that fills the window on its own pushes the next
 * request over the limit, and the overflow recovery has to shrink and retry.
 */
function capToolOutput(out: ToolOutcome): ToolOutcome {
	if (out.api.length <= TOOL_OUTPUT_MAX_CHARS) return out;
	return { ...out, api: out.api.slice(0, TOOL_OUTPUT_MAX_CHARS) + '\n[… output truncated …]' };
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
	return capToolOutput(await runToolInner(call, ctx));
}

async function runToolInner(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
	if (!hostToolAllowed(call.name)) return { api: 'This tool is unavailable in the desktop app.', summary: 'unavailable', error: true };
	ctx.signal.throwIfAborted();
	const policy = toolPolicyError(call.name, ctx);
	if (policy) return { api: `Error: ${policy}`, summary: 'blocked by agent policy', error: true };
	// Strict JSON first; the careful repair (fences, trailing commas, True/None, missing braces) is for small local models.
	const parsed = parseToolArgs(call.arguments);
	if (!parsed) {
		return {
			api: `Error: the arguments for ${call.name} were not valid JSON. Retry with one JSON object matching the tool's schema, e.g. {"path": "src/app.ts"}.`,
			summary: 'invalid arguments',
			error: true
		};
	}
	let args: Record<string, unknown> = parsed;
	// Deny rules: protected paths are never read, written, searched or listed.
	const denied = deniedPath(call.name, args, ctx.settings.denyPaths);
	if (denied) {
		return { api: `Error: ${denied} is protected by the user's deny rules (Settings → Agent → Safety). Do not try to access it another way.`, summary: 'blocked by deny rules', error: true };
	}
	if (ctx.readOnly && !READ_ONLY_TOOLS.has(call.name)) {
		return { api: `Error: ${call.name} is not available in Plan mode (read-only). Describe the change in your plan instead.`, summary: 'blocked in Plan mode', error: true };
	}
	try {
		if (call.name === 'browser_batch') browserSteps(args.steps);
		if (call.name.startsWith('browser_') && !READ_ONLY_TOOLS.has(call.name)) {
			if (!(await approveAction(ctx, `${call.name}: ${JSON.stringify(args)}`, true))) return { api: 'The user rejected this browser action.', summary: 'rejected', error: true };
			ctx.signal.throwIfAborted();
		}
		switch (call.name) {
			case 'list_files':
				return await listFiles(str(args.glob), ctx.settings.denyPaths);
			case 'read_file': {
				const list = Array.isArray(args.paths) ? args.paths.map(String).filter(Boolean).slice(0, 20) : [];
				if (list.length) {
					// Batch read (Cline's read_files): one call, one result, per-file headers.
					const parts: string[] = [];
					let budget = 120_000;
					let ok = 0;
					for (const p of list) {
						try {
							const out = await readFile(p, 1, Number(args.limit) || 2000, { full: args.full === true || !!args.limit, range: !!args.limit, observe: (uri, text) => fileGuard.observe(scopeOf(ctx), guardKey(uri), text) });
							const body = out.api.length > budget ? out.api.slice(0, Math.max(0, budget)) + '\n[… batch output limit reached — read the rest separately]' : out.api;
							budget -= body.length;
							parts.push(`==> ${p} <==\n${body}`);
							ctx.onRead?.(rel(resolveInWorkspace(p)));
							ok++;
						} catch (e) {
							parts.push(`==> ${p} <==\nError: ${e instanceof Error ? e.message : String(e)}`);
						}
					}
					return { api: parts.join('\n\n'), summary: `${ok}/${list.length} files`, detail: list.join('\n') };
				}
				if (!str(args.path)) {
					throw new Error('Give path (or paths).');
				}
				if (/\.pdf$/i.test(str(args.path))) {
					return (await runMoreTool('read_document', args, ctx))!;
				}
				const out = await readFile(str(args.path), Number(args.offset) || 1, Number(args.limit) || 2000, { full: args.full === true || !!args.offset || !!args.limit, range: !!args.offset || !!args.limit, observe: (uri, text) => fileGuard.observe(scopeOf(ctx), guardKey(uri), text) });
				if (!out.error) {
					ctx.onRead?.(rel(resolveInWorkspace(str(args.path))));
				}
				return out;
			}
			case 'grep':
				return await grep(str(args.pattern), str(args.glob), ctx.signal, ctx.settings.denyPaths, {
					caseSensitive: args.case_sensitive === true,
					fixed: args.fixed === true,
					after: Math.max(0, Math.min(20, Number(args.after) || 0)) || undefined,
					before: Math.max(0, Math.min(20, Number(args.before) || 0)) || undefined,
					output: ['content', 'files', 'count'].includes(String(args.output)) ? (String(args.output) as 'content' | 'files' | 'count') : undefined
				});
			case 'get_diagnostics':
				return diagnostics(str(args.path));
			case 'get_editor_context':
				return editorContext();
			case 'edit_lines':
				return await editLines(str(args.path), str(args.tag), Array.isArray(args.edits) ? args.edits : [], ctx);
			case 'edit_file':
				return await editFile(str(args.path), str(args.old_string), str(args.new_string), args.replace_all === true, ctx);
			case 'write_file':
				return await writeFile(str(args.path), str(args.content), ctx);
			case 'notebook_edit':
				return await notebookEdit(args, ctx);
			case 'run_command':
				return await runCommand(str(args.command), Number(args.timeout_seconds) || 120, ctx, args.background === true, args.sandbox === false);
			case 'todo_write': {
				const items = (Array.isArray(args.items) ? args.items : [])
					.map((i: { text?: unknown; done?: unknown }) => ({ text: String(i?.text ?? '').trim(), done: i?.done === true }))
					.filter((i) => i.text);
				const done = items.filter((i) => i.done).length;
				return { api: `Checklist updated (${done}/${items.length} done).`, summary: `${done}/${items.length} done`, todos: items };
			}
			case 'task_board': {
				if (!ctx.board) {
					throw new Error('The shared task board is only available to agents in this chat (lead agents and their subagents).');
				}
				const action = str(args.action) || 'list';
				const text = str(args.text).trim();
				if (action === 'add') {
					if (!text) throw new Error('A task needs text (a clear, self-contained deliverable).');
					const { id } = ctx.board.add(text.slice(0, 2000));
					return { api: `Added task ${id}: ${text.slice(0, 200)}`, summary: `added ${id}` };
				}
				const id = str(args.id).trim();
				if (action === 'claim') {
					return { api: id ? ctx.board.claim(id, str(args.by) || ctx.taskId || 'agent') : 'A task id is required to claim.', summary: `claim ${id}`, error: !id };
				}
				if (action === 'complete') {
					return { api: id ? ctx.board.complete(id, str(args.note).slice(0, 500)) : 'A task id is required to complete.', summary: `done ${id}`, error: !id };
				}
				if (action === 'reopen') {
					return { api: id ? ctx.board.reopen(id) : 'A task id is required to reopen.', summary: `reopen ${id}`, error: !id };
				}
				const items = ctx.board.list();
				return {
					api: items.length ? items.map((i) => `${i.id} [${i.status}${i.claimedBy ? ` · ${i.claimedBy}` : ''}] ${i.text}${i.note ? ` — note: ${i.note}` : ''}`).join('\n') : '(the board is empty — add tasks with action "add")',
					summary: `${items.length} task${items.length === 1 ? '' : 's'}`,
					todos: items.map((i) => ({ text: `${i.id} ${i.text}`, done: i.status === 'done' }))
				};
			}
			case 'recall': {
				if (!ctx.recall) throw new Error('recall is only available to the chat\'s main agent.');
				const id = str(args.id).trim();
				if (!id) throw new Error('Give an id from a notice or report, or "list".');
				const text = ctx.recall(id, str(args.before).trim() || undefined);
				return { api: text, summary: id, error: text.startsWith('Nothing has the id') };
			}
			case 'memory_retain': {
				const fact = str(args.fact).trim();
				if (!fact) {
					return { api: 'Error: fact is empty.', summary: 'empty fact', error: true };
				}
				const cat = ['profile', 'preferences', 'topics'].includes(String(args.category)) ? (String(args.category) as MemoryCategory) : undefined;
				const area: MemoryArea = args.area === 'solution' ? 'solution' : 'fact';
				await ctx.store.retainMemory(fact, { category: cat, area, source: 'agent', sourceSessionId: ctx.sessionId });
				return { api: area === 'solution' ? 'Saved as a solution.' : 'Saved.', summary: fact.slice(0, 80) };
			}
			case 'session_search': {
				const found = await ctx.store.recallSessions(str(args.query), ctx.sessionId, 5);
				if (!found.length) {
					return { api: '(no earlier chat matched)', summary: 'nothing found' };
				}
				const text = found.map((s) => `## ${s.title} (${new Date(s.updatedAt).toISOString().slice(0, 10)})\n${s.excerpts.map((e) => '- ' + e).join('\n')}`).join('\n\n');
				return { api: text, summary: `${found.length} chat${found.length === 1 ? '' : 's'}`, detail: text.slice(0, 3000) };
			}
			case 'memory_recall': {
				const found = await ctx.store.recallMemories(str(args.query), 8);
				return found.length
					? { api: found.map((m) => `- ${m.area === 'solution' ? '[solution] ' : ''}${m.text}`).join('\n'), summary: `${found.length} memories`, detail: found.map((m) => `• ${m.area === 'solution' ? '[solution] ' : ''}${m.text} — ${m.recallReason}`).join('\n') }
					: { api: '(no saved facts or solutions matched)', summary: 'nothing found' };
			}
			case 'web_search': {
				if (!ctx.settings.browserTools) {
					throw new Error('Browser tools are disabled in settings.');
				}
				const result = await webSearch(str(args.query), { count: Number(args.count) || 6, engine: ctx.settings.searchEngine, signal: ctx.signal });
				const text = clip(result.text, 24_000);
				const hits = (text.match(/https?:\/\/\S+/g) ?? []).length;
				return { api: text, summary: `${hits || 'some'} results via ${result.engine}`, detail: clip(text, 4000) };
			}
			case 'web_fetch': {
				if (!ctx.settings.browserTools) {
					throw new Error('Browser tools are disabled in settings.');
				}
				// Provenance guard (Settings → Agent): only URLs the user shared. A fetched
				// page can carry injected instructions; this keeps one page from steering
				// the next fetch anywhere it likes.
				if (ctx.settings.webfetchProvenance && !provenanceAllows(ctx.urlProvenance ?? new Set(), str(args.url))) {
					return {
						api: `Error: web_fetch is restricted to URLs the user shared (provenance guard), and "${str(args.url)}" is not one of them. Ask the user to paste the link, or use web_search and report what it returns without fetching.`,
						summary: 'blocked by provenance guard',
						error: true
					};
				}
				const max = Math.min(100_000, Math.max(1000, Number(args.max_chars) || 20_000));
				const page = await webFetch(str(args.url), max, ctx.signal, ctx.urlProvenance);
				const header = `URL: ${page.url}${page.title ? `\nTitle: ${page.title}` : ''}\n\n`;
				return {
					api: header + page.text + (page.truncated ? '\n\n[… truncated — call again with a larger max_chars if needed]' : ''),
					summary: `${page.title || page.url} · ${Math.round(page.text.length / 1000)}k chars`,
					detail: clip(page.text, 3000)
				};
			}
			case 'open_url': {
				const url = str(args.url).trim();
				if (!/^https?:\/\//i.test(url)) {
					throw new Error('Only http(s) URLs can be opened.');
				}
				if (isDesktopHost()) { const opened = await vscode.commands.executeCommand('simpleBrowser.show', url); if (opened !== true) throw new Error('The page could not be opened.'); return {api:`Opened ${url} for the user.`,summary:'opened'}; }
				try {
					await vscode.commands.executeCommand('simpleBrowser.show', url);
				} catch {
					await vscode.env.openExternal(vscode.Uri.parse(url));
				}
				return { api: `Opened ${url} for the user.`, summary: 'opened in Simple Browser' };
			}
			case 'git_status':
				return await git(['status', '--short', '--branch'], 'status', ctx);
			case 'git_diff': {
				const gitArgs = ['diff', '--no-color', ...(args.staged === true ? ['--staged'] : [])];
				if (str(args.path)) {
					gitArgs.push('--', rel(resolveInWorkspace(str(args.path))));
				}
				return await git(gitArgs, 'diff', ctx);
			}
			case 'git_log':
				return await git(['log', '--oneline', '--decorate', '-n', String(Math.min(100, Math.max(1, Number(args.count) || 15)))], 'log', ctx);
			case 'git_stage': {
				const paths = (Array.isArray(args.paths) ? args.paths : []).map(String).filter(Boolean).slice(0, 50);
				const what = args.all === true
					? 'git add -u (stage every modification and deletion of tracked files)'
					: paths.length
						? `git add -- ${paths.map((p) => rel(resolveInWorkspace(p))).join(' ')}`
						: 'git add (nothing named)';
				if (!paths.length && args.all !== true) {
					throw new Error('Name the files to stage (paths) or pass all: true.');
				}
				if (!(await approveAction(ctx, what, false))) return { api: 'The user rejected this staging.', summary: 'rejected', error: true };
				const stageArgs = args.all === true ? ['add', '-u'] : ['add', '--', ...paths.map((p) => rel(resolveInWorkspace(p)))];
				return await git(stageArgs, 'add', ctx);
			}
			case 'git_commit': {
				const message = str(args.message).trim();
				if (!message) {
					throw new Error('A commit message is required.');
				}
				const subject = message.split('\n')[0].slice(0, 200);
				if (args.all === true) {
					if (!(await approveAction(ctx, `git add -u && git commit "${subject}"`, false))) return { api: 'The user rejected this commit.', summary: 'rejected', error: true };
					const staged = await git(['add', '-u'], 'add', ctx);
					if (staged.error) return staged;
				} else if (!(await approveAction(ctx, `git commit "${subject}" (only what is staged)`, false))) {
					return { api: 'The user rejected this commit.', summary: 'rejected', error: true };
				}
				// The message travels through a temp file: no shell quoting, no -m length limits.
				const file = path.join(os.tmpdir(), `zer0ne-commit-${randomUUID().slice(0, 8)}.txt`);
				try {
					await fs.promises.writeFile(file, message.endsWith('\n') ? message : message + '\n', 'utf8');
					const out = await git(['commit', '--no-verify', '-F', file], 'commit', ctx);
					if (out.error) return out;
					const hash = await git(['rev-parse', '--short', 'HEAD'], 'log', ctx);
					// A no-op commit ("nothing to commit") leaves HEAD unchanged and exits 1.
					return { ...out, api: out.api + (hash.error ? '' : `\nCommit: ${hash.api.trim()}`) };
				} finally {
					await fs.promises.rm(file, { force: true });
				}
			}
			case 'git_branch': {
				const action = str(args.action) || 'list';
				const name = str(args.name).trim();
				let gitArgs: string[];
				let needsApproval: boolean;
				if (action === 'list') {
					gitArgs = ['branch', '--list', '--all'];
					needsApproval = false;
				} else {
					if (!/^[\w./-]{1,120}$/.test(name)) {
						throw new Error('A branch name is letters, digits, dot, slash, dash and underscore (1–120).');
					}
					gitArgs = action === 'create' ? ['checkout', '-b', name] : ['checkout', name];
					needsApproval = true;
				}
				if (needsApproval && !(await approveAction(ctx, `git ${gitArgs.join(' ')}`, false))) {
					return { api: 'The user rejected this branch change.', summary: 'rejected', error: true };
				}
				return await git(gitArgs, 'branch', ctx);
			}
			case 'ask_user': {
				if (!ctx.askUser) {
					return { api: 'No user is available to answer; proceed with your best judgment and state your assumption.', summary: 'no user' };
				}
				const options = (Array.isArray(args.options) ? args.options : []).map(String).filter(Boolean).slice(0, 6);
				const answer = await ctx.askUser(str(args.question) || 'How should I proceed?', options);
				return { api: `User answered: ${answer}`, summary: answer.slice(0, 80) };
			}
			case 'task': {
				if (!ctx.runSubagent) {
					throw new Error('Subagents are disabled.');
				}
				const items = (v: unknown): SubagentItem[] =>
					(Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : { prompt: String(x ?? '') })).map((x) => ({ agent: str(x.agent) || undefined, description: str(x.description) || undefined, prompt: str(x.prompt) }));
				const tasks = items(args.tasks);
				const chain = items(args.chain);
				const modes = [str(args.prompt).trim() ? 1 : 0, tasks.length ? 1 : 0, chain.length ? 1 : 0].reduce((a, b) => a + b, 0);
				if (modes !== 1) {
					throw new Error('Use exactly one mode: prompt (one agent), tasks (parallel) or chain (in order).');
				}
				if ([...tasks, ...chain].some((x) => !x.prompt.trim())) {
					throw new Error('Every task / chain step needs a prompt.');
				}
				if (tasks.length) {
					if (!ctx.runBatch) throw new Error('Parallel agents are not available here.');
					const out = await ctx.runBatch(tasks);
					return { api: out, summary: out.split('\n')[0].slice(0, 100), detail: out.slice(0, 4000) };
				}
				if (chain.length) {
					if (!ctx.runChain) throw new Error('Agent chains are not available here.');
					const out = await ctx.runChain(chain);
					return { api: out, summary: `chain of ${chain.length}`, detail: out.slice(0, 4000) };
				}
				if (args.isolated === true) {
					if (!ctx.spawnWriter || ctx.readOnly) {
						throw new Error('Isolated writers need a git repository, subagents on, and a non-Plan chat.');
					}
					const id = await ctx.spawnWriter(str(args.description) || 'Writer task', str(args.prompt), str(args.agent) || undefined);
					return { api: `Started writer ${id} in its own git worktree. Keep working; its report arrives by itself when it finishes (or wait with agent_result { "ids": ["${id}"] }), then agent_diff / agent_merge / agent_discard.`, summary: `writer ${id}` };
				}
				if (args.background === true && ctx.spawnSubagent) {
					const id = ctx.spawnSubagent(str(args.description) || 'Subagent task', str(args.prompt), str(args.agent) || undefined);
					return { api: `Started background agent ${id}. Keep working on things that do not overlap with it; its report arrives by itself as a notification when it finishes (or wait for it with agent_result { "ids": ["${id}"] }).`, summary: `background ${id}` };
				}
				const report = await ctx.runSubagent(str(args.description) || 'Subagent task', str(args.prompt), str(args.agent) || undefined);
				return { api: report, summary: `${report.length} chars report`, detail: report.slice(0, 4000) };
			}
			case 'agent_send': {
				if (!ctx.sendToAgent) {
					throw new Error('Subagents are disabled.');
				}
				const out = await ctx.sendToAgent(str(args.id), str(args.message), typeof args.background === 'boolean' ? args.background : undefined);
				return { api: out, summary: out.split('\n')[0].slice(0, 100), detail: out.slice(0, 4000) };
			}
			case 'agent_diff':
			case 'agent_merge':
			case 'agent_discard': {
				if (!ctx.writers) {
					throw new Error('No isolated writers in this chat.');
				}
				const id = str(args.id);
				const out = call.name === 'agent_diff' ? await ctx.writers.diff(id) : call.name === 'agent_merge' ? await ctx.writers.merge(id) : await ctx.writers.discard(id);
				return { api: clip(out, 60_000), summary: out.split('\n')[0].slice(0, 100), detail: clip(out, 4000) };
			}
			case 'agent_result': {
				if (!ctx.subagentResults) {
					throw new Error('Subagents are disabled.');
				}
				const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map(String).filter(Boolean);
				// A dispatch-only lead never waits: reports arrive by themselves, and a waiting step holds back the user.
				const text = await ctx.subagentResults(ids, Math.min(ctx.dispatchOnly ? DISPATCH_WAIT_SECONDS : 600, Math.max(0, Number(args.wait_seconds ?? 120))));
				return { api: text, summary: `${ids.length} agent${ids.length > 1 ? 's' : ''}`, detail: text.slice(0, 4000) };
			}
			case 'skill': {
				const found = ctx.skills?.read(str(args.name));
				if (!found) {
					const names = ctx.skills?.list().filter((s) => s.enabled).map((s) => s.name).join(', ');
					throw new Error(`No skill named "${str(args.name)}". Available: ${names || 'none'}`);
				}
				return { api: `# Skill: ${found.info.name}\n\n${found.body}`, summary: found.info.description.slice(0, 80) };
			}
			case 'create_skill': {
				if (!ctx.skills) {
					throw new Error('Skills are disabled in settings.');
				}
				const scope = args.scope === 'user' ? 'user' : 'workspace';
				const name = str(args.name);
				const content = `---\nname: ${name}\ndescription: ${str(args.description)}\n---\n\n${str(args.instructions)}`;
				const handle = await ctx.requestApproval({ kind: 'write', path: `${scope === 'user' ? '(user skills)' : '.zer0ne/skills'}/${name}/SKILL.md`, content, existed: false });
				if (!handle.approved) {
					return { api: 'The user rejected creating this skill.', summary: 'rejected', error: true };
				}
				const saved = ctx.skills.save({ name, description: str(args.description), body: str(args.instructions), scope });
				handle.finish(`Saved skill "${saved.name}".`);
				return { api: `Skill "${saved.name}" saved (${scope}). It is now available with the skill tool.`, summary: 'created' };
			}
			case 'browser_navigate':
			case 'browser_snapshot':
			case 'browser_click':
			case 'browser_type':
			case 'browser_press':
			case 'browser_scroll':
			case 'browser_back':
			case 'browser_forward':
			case 'browser_reload':
			case 'browser_hover':
			case 'browser_select':
			case 'browser_wait_for':
			case 'browser_resize':
				return await browserAction(call.name, args, ctx);
			case 'browser_batch': {
				const result = await requireBrowser(ctx).batch(args.steps, ctx.signal, args.screenshot !== false);
				const out = result.snapshot ? snapshotOutcome(result.snapshot, ctx) : { api: '', summary: '' };
				return { ...out, api: `Completed ${result.completed} browser step(s).${result.error ? ` Stopped: ${result.error}\nCompleted actions were not rolled back. Inspect the page before continuing.` : ''}\n\n${out.api}`, summary: `${result.completed} steps${result.error ? ' · stopped' : ''}`, error: !!result.error };
			}
			case 'browser_tabs': {
				const action = (['list', 'select', 'new', 'close'] as const).find((a) => a === args.action) ?? 'list';
				if (args.url && !browserUrlAllowed(str(args.url), ctx.settings.browserAllowHosts).allowed) {
					return { api: browserHostRefusal(str(args.url), ctx.settings.browserAllowHosts), summary: 'blocked by browser allow-list', error: true };
				}
				const out = await requireBrowser(ctx).tabs(action, typeof args.index === 'number' ? args.index : undefined, args.url ? str(args.url) : undefined);
				if (typeof out === 'string') {
					return { api: out, summary: action === 'list' ? `${out.split('\n').length} tabs` : out, detail: out };
				}
				return snapshotOutcome(out, ctx);
			}
			case 'browser_network': {
				const log = requireBrowser(ctx).networkLog(args.failed === true, args.clear === true);
				const text = ctx.settings.tokenSaver ? compressOutput(log, 8000).text : log;
				return { api: text, summary: args.failed ? `${log.startsWith('No ') ? 0 : log.split('\n').length} failed` : `${log.split('\n').length} requests`, detail: text.slice(0, 3000) };
			}
			case 'browser_console': {
				const b = requireBrowser(ctx);
				const logs = b.consoleLogs(args.clear === true);
				const text = ctx.settings.tokenSaver ? compressOutput(logs, 8000).text : logs;
				return { api: text || '(no console output captured)', summary: `${logs ? logs.split('\n').length : 0} entries`, detail: text.slice(0, 3000) || undefined };
			}
			case 'browser_evaluate': {
				const out = await requireBrowser(ctx).evaluate(str(args.expression));
				return { api: clip(out, 20_000), summary: out.replace(/\s+/g, ' ').slice(0, 80), detail: clip(out, 3000) };
			}
			case 'browser_close':
				await ctx.browser?.close();
				return { api: 'Browser closed.', summary: 'closed' };
			case 'computer': {
				if (!ctx.settings.computerUse) throw new Error('Computer use is turned off in Settings → Features.');
				if (!ctx.storageDir || !ctx.mediaDir) {
					throw new Error('Computer use is not available here.');
				}
				const theme = ctx.settings.theme;
				const result = await runComputer(args, { storageDir: ctx.storageDir, sourceFile: path.join(ctx.mediaDir, 'sandbox', 'input.cs'), sessionId: ctx.guardScope ?? ctx.sessionId ?? '', signal: ctx.signal, vision: ctx.vision, theme:theme === 'auto' ? 'auto' : /light|paper|latte|snow|cream/i.test(theme) ? 'light' : 'dark', approve: (what, signal) => approveAction({...ctx,signal}, what, true) });
				return { ...result, image:ctx.settings.computerScreenshotHistory && result.images?.[0] ? `data:${result.images[0].mime};base64,${result.images[0].base64}` : undefined };
			}
			
			case 'mcp_resources': {
				if (!ctx.mcp) throw new Error('MCP servers are not available here.');
				const action = str(args.action) === 'read' ? 'read' : 'list';
				const out = action === 'read'
					? await ctx.mcp.readResource(str(args.server), str(args.uri), ctx.signal)
					: await ctx.mcp.listAllResources(ctx.signal);
				return { api: clip(out, 40_000), summary: `${action}: ${out.split('\n')[0].slice(0, 60)}`, detail: clip(out, 2000) };
			}
			case 'mcp_prompts': {
				if (!ctx.mcp) throw new Error('MCP servers are not available here.');
				const action = str(args.action) === 'get' ? 'get' : 'list';
				const out = action === 'get'
					? await ctx.mcp.getPrompt(str(args.server), str(args.name), args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? Object.fromEntries(Object.entries(args.arguments as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : {}, ctx.signal)
					: await ctx.mcp.listAllPrompts(ctx.signal);
				return { api: clip(out, 40_000), summary: `${action}: ${str(args.name) || out.split('\n')[0].slice(0, 40)}`, detail: clip(out, 2000) };
			}
			default: {
				if (call.name.startsWith('debug_')) {
					const dbg = await runDebugTool(call.name, args, (what) => approveAction(ctx, what, false));
					if (dbg) {
						return dbg;
					}
				}
				const more = await runMoreTool(call.name, args, ctx);
				if (more) {
					return more;
				}
				if (call.name.startsWith('mcp__') && ctx.mcp) {
					return await mcpCall(call.name, args, ctx);
				}
				return { api: `Error: unknown tool "${call.name}".`, summary: 'unknown tool', error: true };
			}
		}
	} catch (error) {
		if (ctx.signal.aborted) {
			throw error;
		}
		const message = error instanceof Error ? error.message : String(error);
		return { api: `Error: ${message}`, summary: message.slice(0, 120), error: true };
	}
}

async function listFiles(glob: string, deny = ''): Promise<ToolOutcome> {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('No workspace folder is open.');
	}
	if (root.scheme === 'file') {
		// ripgrep: fast, and honors .gitignore / .zer0neignore.
		const rg = await rgFiles(root.fsPath, glob, 1000, denyGlobs(deny));
		if (rg) {
			const shown = rg.files.slice(0, 500);
			return {
				api: shown.join('\n') + (rg.files.length > shown.length || rg.truncated ? `\n[… more files — narrow the glob]` : '') || '(no files matched)',
				summary: `${rg.files.length}${rg.truncated ? '+' : ''} files`
			};
		}
	}
	const pattern = new vscode.RelativePattern(root, glob.trim().replace(/^\.?\//, '') || '**/*');
	const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, 1000);
	const isDenied = compileDeny(deny);
	const files = uris.map(rel).filter((f) => !isDenied(f)).sort();
	const shown = files.slice(0, 500);
	return {
		api: shown.join('\n') + (files.length > shown.length ? `\n[… ${files.length - shown.length} more — narrow the glob]` : '') || '(no files matched)',
		summary: `${files.length} files`
	};
}

async function readFile(p: string, offset: number, limit: number, opts: { full?: boolean; range?: boolean; observe?: (uri: vscode.Uri, text: string) => void } = {}): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const stat = await vscode.workspace.fs.stat(uri);
	if (stat.type & vscode.FileType.Directory) {
		// Reading a folder lists it (omp-style "read anything").
		const entries = (await vscode.workspace.fs.readDirectory(uri)).sort((a, b) => (b[1] & vscode.FileType.Directory) - (a[1] & vscode.FileType.Directory) || a[0].localeCompare(b[0]));
		const lines = entries.slice(0, 400).map(([name, type]) => (type & vscode.FileType.Directory ? name + '/' : name));
		return { api: lines.join('\n') + (entries.length > 400 ? `\n[… ${entries.length - 400} more]` : '') || '(empty folder)', summary: `${rel(uri) || '.'}/ · ${entries.length} entries` };
	}
	// A huge file is never read whole: the range the model asked for is read
	// from disk instead, or the read is refused with the way to ask for one.
	if (stat.size > maxReadBytes()) {
		return readBigFile(uri, stat.size, offset, limit, opts);
	}
	let text = await readText(uri);
	// Any read (range or skeleton too) observes the whole file: edits still have to match its exact text.
	opts.observe?.(uri, text);
	if (/\.ipynb$/i.test(uri.path)) {
		try {
			text = renderNotebook(text);
		} catch {
			text = notebookText(text);
		}
	}
	const tag = contentTag(text);
	// Token Saver: a big source file read without a range comes back as its skeleton.
	if (!opts.full && !/\.ipynb$/i.test(uri.path)) {
		const sk = skeleton(uri.path, text);
		if (sk && sk.text.length <= MAX_READ_CHARS) {
			return {
				api: `[skeleton of ${rel(uri)} — ${sk.totalLines} lines, ${sk.shownLines} shown; folded bodies: read_file with offset/limit, or full: true]\n${sk.text}[tag ${tag}]\n`,
				summary: `${rel(uri)} · skeleton ${sk.shownLines}/${sk.totalLines} lines`
			};
		}
	}
	const lines = text.split(/\r?\n/);
	const start = Math.max(1, Math.floor(offset));
	const end = Math.min(lines.length, start - 1 + Math.max(1, Math.floor(limit)));
	let out = '';
	for (let i = start; i <= end; i++) {
		const line = lines[i - 1].length > 2000 ? lines[i - 1].slice(0, 2000) + '…' : lines[i - 1];
		out += `${i}\t${line}\n`;
		if (out.length > MAX_READ_CHARS) {
			out += `[… stopped at line ${i} — continue with offset=${i + 1}]\n`;
			break;
		}
	}
	if (end < lines.length && out.length <= MAX_READ_CHARS) {
		out += `[… file has ${lines.length} lines — continue with offset=${end + 1}]\n`;
	}
	return { api: (out || '(empty file)\n') + `[tag ${tag}]\n`, summary: `${rel(uri)} · ${start}-${end} of ${lines.length} lines` };
}

/**
 * Read the lines of a huge file straight from disk: the file is streamed, so
 * memory stays flat no matter how big it is. Only the requested range is kept.
 */
async function readLineRange(file: string, start: number, end: number): Promise<{ lines: string[]; total: number }> {
	const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
	const kept: string[] = [];
	let total = 0;
	let pending = '';
	const take = (line: string) => {
		total++;
		if (total >= start && total <= end) kept.push(line);
	};
	try {
		for await (const chunk of stream as AsyncIterable<string>) {
			pending += chunk;
			let at = pending.indexOf('\n');
			while (at >= 0) {
				take(pending.slice(0, at).replace(/\r$/, ''));
				pending = pending.slice(at + 1);
				at = pending.indexOf('\n');
			}
			// A single line longer than the cap is cut: it would be one huge buffer.
			if (pending.length > MAX_LINE_BYTES) {
				take(pending.slice(0, 2000) + '…');
				pending = '';
			}
		}
	} finally {
			stream.destroy();
	}
	if (pending.length) take(pending.replace(/\r$/, ''));
	return { lines: kept, total };
}

/**
 * A file too large to hold in memory. The model gets the range it asked for
 * (read from disk), or — when it asked for the whole file — the reason and the
 * way to ask for a part of it. A range of a huge file is not observed, so the
 * file cannot be edited by line number afterwards: that needs the whole text.
 */
async function readBigFile(uri: vscode.Uri, size: number, offset: number, limit: number, opts: { full?: boolean; range?: boolean }): Promise<ToolOutcome> {
	const name = rel(uri) || uri.fsPath;
	const mb = (size / 1024 / 1024).toFixed(1);
	const start = Math.max(1, Math.floor(offset));
	const end = start - 1 + Math.max(1, Math.floor(limit));
	const how = `read_file with offset ${start} and limit ${Math.max(1, Math.floor(limit))}`;
	if (!opts.range) {
		throw new Error(`"${name}" is ${mb} MB — too large to read whole. Read a part of it (${how}), or use grep to search it.`);
	}
	if (uri.scheme !== 'file') {
		throw new Error(`"${name}" is ${mb} MB — too large to read whole, and this workspace cannot read a part of it. Use grep to search it.`);
	}
	const { lines, total } = await readLineRange(uri.fsPath, start, end);
	let out = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) + '…' : lines[i];
		out += `${start + i}\t${line}\n`;
		if (out.length > MAX_READ_CHARS) {
			out += `[… stopped at line ${start + i} — continue with offset=${start + i + 1}]\n`;
			break;
		}
	}
	if (end < total && out.length <= MAX_READ_CHARS) {
		out += `[… file has ${total} lines — continue with offset=${end + 1}]\n`;
	}
	return {
		api: (out || '(empty file)\n') + `[large file: ${mb} MB — a line range was read; this file cannot be edited by line number]\n`,
		summary: `${name} · ${start}-${Math.min(end, total)} of ${total} lines (range read)`
	};
}

/** Jupyter notebook → readable cells (source + text outputs). */
function notebookText(json: string): string {
	try {
		const nb = JSON.parse(json) as { cells?: Array<{ cell_type?: string; source?: string | string[]; outputs?: Array<{ text?: string | string[]; data?: Record<string, unknown> }> }> };
		const join = (s: unknown) => (Array.isArray(s) ? s.join('') : typeof s === 'string' ? s : '');
		return (nb.cells ?? [])
			.map((c, i) => {
				const outputs = (c.outputs ?? [])
					.map((o) => join(o.text) || join(o.data?.['text/plain']))
					.filter(Boolean)
					.join('\n')
					.slice(0, 2000);
				return `# cell ${i + 1} [${c.cell_type ?? 'code'}]\n${join(c.source)}${outputs ? `\n# output\n${outputs}` : ''}`;
			})
			.join('\n\n');
	} catch {
		return json;
	}
}

async function grep(patternText: string, glob: string, signal: AbortSignal, deny = '', options: import('./ripgrep').RgSearchOptions = {}): Promise<ToolOutcome> {
	const root = workspaceRoot();
	if (!root) {
		throw new Error('No workspace folder is open.');
	}
	if (root.scheme === 'file') {
		const rg = await rgSearch(root.fsPath, patternText, glob, signal, 150, denyGlobs(deny), options);
		if (rg) {
			return {
				api: rg.matches.join('\n') || '(no matches)',
				summary: rgSummary(rg, options),
				detail: clip(rg.matches.join('\n'), 3000)
			};
		}
	}
	let pattern: RegExp;
	try {
		pattern = new RegExp(patternText, options.caseSensitive ? '' : 'i');
	} catch {
		throw new Error('Invalid regular expression.');
	}
	const isDenied = compileDeny(deny);
	const uris = (await vscode.workspace.findFiles(new vscode.RelativePattern(root, glob.trim() || '**/*'), EXCLUDE, 3000)).filter((u) => !isDenied(rel(u)));
	const matches: string[] = [];
	const hitFiles = new Set<string>();
	for (const uri of uris) {
		if (matches.length >= 150 || signal.aborted) {
			break;
		}
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > 1_000_000) {
				continue;
			}
			const text = await readText(uri);
			let hit = false;
			let perFile = 0;
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length && matches.length < 150; i++) {
				if (!pattern.test(lines[i])) continue;
				perFile++;
				if (options.output === 'files') { hit = true; if (!hitFiles.has(rel(uri))) { hitFiles.add(rel(uri)); matches.push(rel(uri)); } break; }
				if (options.output === 'count') { hit = true; continue; }
				hit = true;
				matches.push(`${rel(uri)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
			}
			if (hit && options.output === 'count') matches.push(`${rel(uri)}:${perFile}`);
		} catch {
			// binary or unreadable — skip
		}
	}
	return {
		api: matches.join('\n') || '(no matches)',
		summary: `${matches.length}${matches.length >= 150 ? '+' : ''}${options.output === 'content' || !options.output ? ' matches' : ''} in ${options.output === 'count' ? matches.length : hitFiles.size} files`,
		detail: clip(matches.join('\n'), 3000)
	};
}

function rgSummary(rg: import('./ripgrep').RgMatches, options: import('./ripgrep').RgSearchOptions): string {
	const mode = options.output === 'files' ? 'files' : options.output === 'count' ? 'counts' : 'matches';
	return `${rg.matches.length}${rg.truncated ? '+' : ''} ${mode} in ${rg.files} files`;
}

function diagnostics(p: string): ToolOutcome {
	const only = p ? resolveInWorkspace(p).toString() : undefined;
	const lines: string[] = [];
	let errors = 0;
	let warnings = 0;
	for (const [uri, list] of vscode.languages.getDiagnostics()) {
		if (only && uri.toString() !== only) {
			continue;
		}
		for (const d of list) {
			if (d.severity > vscode.DiagnosticSeverity.Warning) {
				continue;
			}
			const isError = d.severity === vscode.DiagnosticSeverity.Error;
			errors += isError ? 1 : 0;
			warnings += isError ? 0 : 1;
			if (lines.length < 200) {
				lines.push(`${rel(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${isError ? 'error' : 'warning'}${d.source ? ` [${d.source}]` : ''}: ${d.message}`);
			}
		}
	}
	return {
		api: lines.join('\n') || 'No errors or warnings reported.',
		summary: `${errors} errors, ${warnings} warnings`,
		detail: clip(lines.join('\n'), 3000) || undefined
	};
}

function editorContext(): ToolOutcome {
	const editor = vscode.window.activeTextEditor;
	const tabs = vscode.window.tabGroups.all
		.flatMap((g) => g.tabs)
		.map((t) => (t.input instanceof vscode.TabInputText ? rel(t.input.uri) : undefined))
		.filter((x): x is string => !!x);
	if (!editor) {
		return { api: `No active text editor.\nOpen tabs: ${tabs.join(', ') || 'none'}`, summary: 'no active editor' };
	}
	const selection = editor.document.getText(editor.selection);
	const api = [
		`Active file: ${rel(editor.document.uri)} (${editor.document.languageId})`,
		`Cursor: line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}`,
		selection ? `Selected text (lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}):\n${clip(selection, 20_000)}` : 'No selection.',
		`Open tabs: ${tabs.join(', ') || 'none'}`
	].join('\n');
	return { api, summary: rel(editor.document.uri) + (selection ? ` · ${selection.length} chars selected` : '') };
}

/** The lines that differ between two versions of a file (for approval cards). */
function changedRegion(before: string, after: string): { before: string; after: string } {
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	let top = 0;
	while (top < a.length && top < b.length && a[top] === b[top]) top++;
	let bottom = 0;
	while (bottom < a.length - top && bottom < b.length - top && a[a.length - 1 - bottom] === b[b.length - 1 - bottom]) bottom++;
	return { before: a.slice(top, a.length - bottom).join('\n'), after: b.slice(top, b.length - bottom).join('\n') };
}

/** Hashline edit: numbered ranges against the tagged snapshot the model read. */
async function editLines(p: string, tag: string, edits: LineEdit[], ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	const text = await readText(uri);
	const now = contentTag(text);
	if (!tag || tag.replace(/^#/, '').toLowerCase() !== now) {
		throw new Error(`${rel(uri)} changed since that read (tag ${tag || 'missing'}, now ${now}). Re-read the lines you want to change and use the new tag.`);
	}
	for (const e of edits) assertNoRedaction(String(e?.text ?? ''), rel(uri));
	const proposed = applyLineEdits(text, edits);
	if (proposed === text) {
		throw new Error('These edits change nothing.');
	}
	// The card shows only the changed region (common leading/trailing lines trimmed).
	const hunk = changedRegion(text, proposed);
	const handle = await ctx.requestApproval({ kind: 'edit', path: rel(uri), find: hunk.before, replace: hunk.after, review: { before: text, after: proposed } });
	if (!handle.approved) {
		return { api: 'The user rejected this edit. Do not retry it unchanged; ask or take another approach.', summary: 'rejected', error: true };
	}
	try {
		const updated = handle.content !== undefined ? handle.content : proposed;
		const current = await fileGuard.withLock(guardKey(uri), async () => {
			// Reviewed in the editor: the buffer held the proposal, so only a chat-card approval re-checks the file.
			const current = handle.content !== undefined ? text : await readText(uri);
			assertUnchanged(current, text);
			await writeText(uri, updated);
			await observeWritten(ctx, uri);
			return current;
		});
		ctx.recordChange?.(rel(uri), current, updated);
		const lines = edits.length;
		const note = `Edited ${rel(uri)} (${lines} range${lines === 1 ? '' : 's'}). New [tag ${contentTag(updated)}] — line numbers after your edit have shifted; re-read before another edit_lines on the same area.`;
		handle.finish(note);
		const errs = await errorsAfterEdit(uri, ctx.settings);
		return { api: note + errs, summary: 'applied' + (errs ? ' · errors' : '') };
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

async function editFile(p: string, find: string, replace: string, all: boolean, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	if (!find) {
		throw new Error('old_string is empty. Use write_file to create a file.');
	}
	if (find === replace) {
		throw new Error('old_string and new_string are identical.');
	}
	assertNoRedaction(replace, rel(uri));
	const text = await readText(uri);
	fileGuard.assertSeen(scopeOf(ctx), guardKey(uri), text, rel(uri));
	// Models write "\n"; Windows files often use "\r\n". Match either way.
	const eol = text.includes('\r\n') ? '\r\n' : '\n';
	const norm = (s: string) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
	let target = norm(find);
	let replacement = norm(replace);
	let count = text.split(target).length - 1;
	let matched = '';
	if (count === 0 && !all) {
		// Tolerate copy slips (line numbers, escapes, whitespace), but only when the corrected match is unique.
		const lf = (s: string) => s.replace(/\r\n/g, '\n');
		const m = findUnique(lf(text), lf(find), rel(uri));
		target = norm(m.text);
		replacement = norm(adaptReplacement(m, lf(find), lf(replace)));
		matched = matchNote(m);
		count = 1;
	}
	if (count === 0) {
		throw new Error(`old_string was not found in ${rel(uri)}. Re-read the file and copy the exact current text (without line-number prefixes).`);
	}
	if (count > 1 && !all) {
		throw new Error(`old_string matches ${count} places in ${rel(uri)}. Include more surrounding context to make it unique, or set replace_all.`);
	}
	const proposed = all ? text.split(target).join(replacement) : text.replace(target, () => replacement);
	const handle = await ctx.requestApproval({ kind: 'edit', path: rel(uri), find, replace, review: { before: text, after: proposed } });
	if (!handle.approved) {
		return { api: 'The user rejected this edit. Do not retry it unchanged; ask or take another approach.', summary: 'rejected', error: true };
	}
	try {
		const { before, updated } = await fileGuard.withLock(guardKey(uri), async () => {
			if (handle.content !== undefined) {
				// Reviewed in the editor: the buffer held the proposal and the user accepted exactly this text.
				await writeText(uri, handle.content);
				await observeWritten(ctx, uri);
				return { before: text, updated: handle.content };
			}
			// Same unique target still there: apply the approved change to the current text.
			const current = await readText(uri);
			if (current.split(target).length - 1 !== count) {
				throw new Error('The file changed while waiting for approval. Re-read it and retry.');
			}
			const updated = all ? current.split(target).join(replacement) : current.replace(target, () => replacement);
			await writeText(uri, updated);
			await observeWritten(ctx, uri);
			return { before: current, updated };
		});
		ctx.recordChange?.(rel(uri), before, updated);
		const partial = handle.content !== undefined && handle.content !== proposed;
		const note = partial
			? `Edited ${rel(uri)} — the user reviewed the change and kept only part of it (or adjusted it). Re-read the file before editing it again.`
			: `Edited ${rel(uri)} (${all ? count : 1} replacement${(all ? count : 1) > 1 ? 's' : ''}).${matched}`;
		handle.finish(note);
		const errs = await errorsAfterEdit(uri, ctx.settings);
		return { api: note + errs, summary: (partial ? 'applied (adjusted in review)' : 'applied') + (errs ? ' · errors' : '') };
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

async function writeFile(p: string, content: string, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(p);
	assertNoRedaction(content, rel(uri));
	const existed = await exists(uri);
	const previous = existed ? await readText(uri).catch(() => undefined) : undefined;
	if (existed && previous === undefined) {
		throw new Error(`${rel(uri)} exists but cannot be read as text — it was not overwritten.`);
	}
	fileGuard.assertOverwrite(scopeOf(ctx), guardKey(uri), previous ?? null, rel(uri));
	const eolled = previous?.includes('\r\n') ? content.replace(/\r?\n/g, '\r\n') : content;
	const handle = await ctx.requestApproval({ kind: 'write', path: rel(uri), content, existed, review: previous !== undefined ? { before: previous, after: eolled } : undefined });
	if (!handle.approved) {
		return { api: 'The user rejected this write. Do not retry it unchanged.', summary: 'rejected', error: true };
	}
	try {
		const { old, text } = await fileGuard.withLock(guardKey(uri), async () => {
			if (handle.content !== undefined) {
				// Reviewed in the editor: the user accepted exactly this text.
				await writeText(uri, handle.content);
				await observeWritten(ctx, uri);
				return { old: previous ?? null, text: handle.content };
			}
			// What was approved — overwrite this text, or create a file that did not exist — must still hold.
			const now = (await exists(uri)) ? await readText(uri) : null;
			if (previous === undefined && now !== null) {
				throw new Error(`${rel(uri)} was created by someone else while waiting for approval. Read it and retry — nothing was written.`);
			}
			if (previous !== undefined) assertUnchanged(now ?? '', previous);
			const text = eolled;
			await writeText(uri, text);
			await observeWritten(ctx, uri);
			return { old: now, text };
		});
		ctx.recordChange?.(rel(uri), old, text);
		const note = `${existed ? 'Overwrote' : 'Created'} ${rel(uri)} (${content.split('\n').length} lines).`;
		handle.finish(note);
		const errs = await errorsAfterEdit(uri, ctx.settings);
		return { api: note + errs, summary: (existed ? 'overwritten' : 'created') + (errs ? ' · errors' : '') };
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

/** One notebook cell: the approval shows the cell's old and new source; the whole .ipynb is written. */
async function notebookEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	const uri = resolveInWorkspace(str(args.path));
	if (!/\.ipynb$/i.test(uri.path)) {
		throw new Error('notebook_edit works on .ipynb files — use edit_file for other files.');
	}
	const raw = await readText(uri);
	fileGuard.assertSeen(scopeOf(ctx), guardKey(uri), raw, rel(uri));
	const mode = args.mode === 'insert' || args.mode === 'delete' ? args.mode : 'replace';
	const r = editNotebook(raw, { cell: Number(args.cell), mode, source: args.source === undefined ? undefined : str(args.source), cell_type: args.cell_type === 'markdown' ? 'markdown' : args.cell_type === 'code' ? 'code' : undefined });
	assertNoRedaction(r.after, rel(uri));
	const handle = await ctx.requestApproval({ kind: 'edit', path: `${rel(uri)} · ${r.summary}`, find: r.before, replace: r.after });
	if (!handle.approved) {
		return { api: 'The user rejected this notebook edit.', summary: 'rejected', error: true };
	}
	try {
		await fileGuard.withLock(guardKey(uri), async () => {
			assertUnchanged(await readText(uri), raw);
			await writeText(uri, r.text);
			await observeWritten(ctx, uri);
		});
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
	ctx.recordChange?.(rel(uri), raw, r.text);
	handle.finish(r.summary);
	return { api: `${r.summary[0].toUpperCase()}${r.summary.slice(1)} in ${rel(uri)}.`, summary: r.summary };
}

/** A one-line approval for side-effect tools (debugger, computer use); `strict` = never auto-approved outside Full access. */
async function approveAction(ctx: ToolContext, what: string, strict: boolean): Promise<boolean> {
	if (ctx.readOnly) {
		return false;
	}
	const handle = await ctx.requestApproval({ kind: 'command', command: what, escalate: strict || undefined, signal:ctx.signal });
	handle.finish(handle.approved ? 'done' : 'rejected', !handle.approved);
	return handle.approved;
}



async function runCommand(command: string, timeoutSeconds: number, ctx: ToolContext, background = false, escalate = false): Promise<ToolOutcome> {
	const root = workspaceRoot();
	if (!root || root.scheme !== 'file') throw new Error('Commands need a local workspace folder.');
	const plan = await approveCommand(command, root.fsPath, root.fsPath, ctx, background, escalate);
	const { handle, spec: boxed } = plan;
	if (!handle.approved) return { api: 'The user rejected this command. Do not run it again unchanged.', summary: 'rejected', error: true };
	if (background) {
		const proc = startBackground(command, root.fsPath, boxed, plan.env, ctx, plan.guard);
		await waitForOutput(proc, 8, ctx.signal);
		const first = takeOutput(proc, ctx.settings.tokenSaver);
		const failed = proc.code !== undefined && proc.code !== 0;
		handle.finish(first.slice(0, 2000), failed);
		return { api: `Started in the background as ${proc.id}.\n${first}\nUse command_output with id "${proc.id}" to read more and command_kill to stop it.`, summary: `background ${proc.id}`, error: failed };
	}
	const limit = Math.min(600, Math.max(5, timeoutSeconds));
	const startedAt = Date.now();
	// The chat's lead does not sit through a long build: after a while the command moves to the background and its end is reported.
	const detach = ctx.backgroundReports && !ctx.guardScope && ctx.sessionId ? { afterMs: MOVE_TO_BACKGROUND_SECONDS * 1000, adopt: (child: import('child_process').ChildProcess, out: string) => adoptBackground(child, command, out, startedAt, ctx) } : undefined;
	const result = await executeCommand(command, plan, limit * 1000, ctx.signal, detach);
	if (result.movedTo) {
		const shown = result.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
		return { api: `Still running after ${MOVE_TO_BACKGROUND_SECONDS}s, so it moved to the background as ${result.movedTo} (its ${limit}s limit still applies). Keep working on something else, or end your turn: how it ends arrives by itself, with the end of its output. Do not poll it.\n${clip(shown, 4000) || '(no output yet)'}`, summary: `moved to background ${result.movedTo}` };
	}
	const clean = result.out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
	const status = (result.timedOut ? `timed out after ${timeoutSeconds}s` : `exit code ${result.code}`) + (boxed ? ' (sandboxed)' : '');
	const note = boxed && result.code !== 0 && SANDBOX_DENIED.test(clean) ? '\n[sandbox] A sandbox restriction blocked this command. If it needs access outside the workspace, retry with sandbox: false — the user will be asked.' : '';
	return { api: `${status}\n${withSpill(clean, ctx.settings.tokenSaver ? compressOutput(clean, 16_000).text : clip(clean, 30_000), command) || '(no output)'}${note}`, summary: status, error: result.code !== 0 };
}

function requireBrowser(ctx: ToolContext): BrowserAgent {
	if (!ctx.browser || !ctx.settings.browserAgent) {
		throw new Error('The browser agent is disabled in Settings → Browser use.');
	}
	return ctx.browser;
}

/**
 * The per-project browser allow-list (Settings → Agent → browserAllowHosts):
 * one host per line, subdomains included; empty means every host. URL-only
 * checks keep localhost and IP addresses expressible.
 */
export function browserUrlAllowed(url: string, allowHosts: string): { allowed: boolean; host?: string } {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return { allowed: false };
	}
	const list = allowHosts.split(/\r?\n/).map((h) => h.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean);
	if (!list.length) return { allowed: true, host };
	return { allowed: list.some((h) => host === h || host.endsWith('.' + h)), host };
}

/** The refusal for a host outside the allow-list, naming what is allowed. */
function browserHostRefusal(url: string, allowHosts: string): string {
	const list = allowHosts.split(/\r?\n/).map((h) => h.trim()).filter(Boolean);
	return `Error: "${url}" is outside this project's browser allow-list (Settings → Agent → Browser hosts${list.length ? `: ${list.join(', ')}` : ''}). Open it with open_url for the user, or ask them to extend the list.`;
}

async function browserAction(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	const b = requireBrowser(ctx);
	let snap: BrowserSnapshot | undefined;
	switch (name) {
		case 'browser_navigate': {
			const check = browserUrlAllowed(str(args.url), ctx.settings.browserAllowHosts);
			if (!check.allowed) {
				return { api: browserHostRefusal(str(args.url), ctx.settings.browserAllowHosts), summary: 'blocked by browser allow-list', error: true };
			}
			snap = await b.navigate(str(args.url));
			break;
		}
		case 'browser_snapshot':
			snap = await b.snapshot(args.screenshot !== false);
			break;
		case 'browser_click':
			snap = await b.click({ ref: typeof args.ref === 'number' ? args.ref : undefined, x: Number(args.x), y: Number(args.y) });
			break;
		case 'browser_type':
			snap = await b.type(Number(args.ref), str(args.text), { submit: args.submit === true, clear: args.clear !== false });
			break;
		case 'browser_press':
			snap = await b.press(str(args.key));
			break;
		case 'browser_scroll':
			snap = await b.scroll(args.direction === 'up' ? 'up' : 'down', Number(args.amount) || 0.8);
			break;
		case 'browser_back':
			snap = await b.back();
			break;
		case 'browser_forward':
			snap = await b.forward();
			break;
		case 'browser_reload':
			snap = await b.reload();
			break;
		case 'browser_hover':
			snap = await b.hover(Number(args.ref));
			break;
		case 'browser_select':
			snap = await b.select(Number(args.ref), str(args.value));
			break;
		case 'browser_wait_for':
			snap = await b.waitFor({ text: args.text ? str(args.text) : undefined, gone: args.gone ? str(args.gone) : undefined, seconds: typeof args.seconds === 'number' ? args.seconds : undefined });
			break;
		case 'browser_resize': {
			const preset = (['mobile', 'tablet', 'desktop'] as const).find((p) => p === args.preset);
			snap = await b.resize({ preset, width: Number(args.width) || undefined, height: Number(args.height) || undefined });
			break;
		}
	}
	if (!snap) {
		throw new Error('No snapshot.');
	}
	return snapshotOutcome(snap, ctx);
}

function snapshotOutcome(snap: BrowserSnapshot, ctx: ToolContext): ToolOutcome {
	const images = ctx.vision && snap.screenshot ? [{ mime: 'image/jpeg', base64: snap.screenshot, name: 'screenshot.jpg' }] : undefined;
	return {
		api: describeSnapshot(snap) + (images ? '\n\n(A screenshot of the viewport is attached.)' : ''),
		summary: snap.title || snap.url,
		image: snap.thumbnail,
		url: snap.url,
		images,
		detail: snap.elements.split('\n').slice(0, 40).join('\n')
	};
}

async function mcpCall(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	const mcp = ctx.mcp!;
	const hit = mcp.resolve(name);
	if (!hit) {
		throw new Error(`MCP tool ${name} is not available (server stopped?).`);
	}
	let handle: ApprovalHandle | undefined;
	if (!hit.client.config.trusted) {
		handle = await ctx.requestApproval({ kind: 'mcp', tool: `${hit.client.config.name} › ${hit.tool.name}`, args: JSON.stringify(args, null, 2), destructive: destructiveTool(hit.tool), externalAction: externalTool(hit.tool) });
		if (!handle.approved) {
			return { api: 'The user rejected this MCP tool call.', summary: 'rejected', error: true };
		}
	}
	try {
		ctx.signal.throwIfAborted();
		const res = await mcp.call(name, args, ctx.signal, hit);
		const resourceUri = hit.tool._meta?.ui?.resourceUri ?? hit.tool._meta?.['ui/resourceUri'];
		const text = ctx.settings.tokenSaver ? compressOutput(res.text, 20_000).text : clip(res.text, 30_000);
		handle?.finish(clip(res.text, 2000), res.isError);
		return {
			api: res.isError ? `Error from MCP tool: ${text}` : text,
			mcpApp: typeof resourceUri === 'string' && resourceUri.startsWith('ui://') ? { toolName: name, resourceUri, input: args, result: res.result } : undefined,
			summary: res.isError ? 'tool error' : `${res.text.length} chars${res.images.length ? ` + ${res.images.length} image(s)` : ''}`,
			detail: clip(res.text, 3000),
			error: res.isError,
			images: ctx.vision && res.images.length ? res.images : undefined
		};
	} catch (error) {
		handle?.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

async function git(args: string[], label: string, ctx: ToolContext): Promise<ToolOutcome> {
	const root = workspaceRoot();
	if (!root || root.scheme !== 'file') {
		throw new Error('Git tools need a local workspace folder.');
	}
	const out = await new Promise<string>((resolve, reject) => {
		execFile('git', args, { cwd: root.fsPath, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: ctx.signal }, (error, stdout, stderr) => {
			if (error && !stdout) {
				reject(new Error((stderr || error.message).trim().slice(0, 400)));
			} else {
				resolve(String(stdout));
			}
		});
	});
	const text = label === 'diff' ? (ctx.settings.tokenSaver ? compressOutput(out, 40_000, 'diff').text : clip(out, 60_000)) : ctx.settings.tokenSaver ? compressOutput(out, 20_000).text : clip(out, 30_000);
	const lines = out.split('\n').filter(Boolean).length;
	return { api: text || '(no output — clean)', summary: label === 'diff' ? `${lines} diff lines` : `${lines} lines`, detail: clip(out, 3000) || undefined };
}

/** Short, human-readable argument for a tool card. */
export function describeArgs(call: ToolCall): string {
	try {
		const a = JSON.parse(call.arguments || '{}');
		const pick = a.path ?? a.prompt ?? a.url ?? a.query ?? a.pattern ?? a.glob ?? a.command ?? a.fact ?? a.from ?? a.id ?? (typeof a.patch === 'string' ? (a.patch.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/) ?? [])[1] : undefined);
		if (typeof pick === 'string') {
			return pick.length > 90 ? pick.slice(0, 90) + '…' : pick;
		}
		return '';
	} catch {
		return '';
	}
}
