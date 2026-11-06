import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import type { HookConfig, McpServerConfig } from '../providerStore';
import { parseSkill, slugify } from './skills';
import { isDesktopHost } from '../host/capabilities';
import { parseMcpJson } from './mcp';
import { markdown } from './frontmatter';
import { identity, noLinks, pathLock, publish, readText, removeStage, stageFor, validateTree, within } from './extensionFiles';

/**
 * Plugins, custom commands and custom agents — compatible with the formats
 * ZCode, Claude Code and opencode already use, so existing setups just work.
 *
 * A plugin is a folder with a manifest (.zcode-plugin/plugin.json or
 * .claude-plugin/plugin.json) and any of:
 *   commands/*.md       slash commands   (body with $ARGUMENTS, $1 … $9)
 *   skills/<n>/SKILL.md skills
 *   agents/*.md         subagents        (frontmatter name/description/model, body = system prompt)
 *   hooks/hooks.json    hooks            ({ hooks: { PreToolUse: [{ matcher, hooks: [{ command }] }] } })
 *   .mcp.json           MCP servers      ({ mcpServers: { name: { command, args, env } | { url } } })
 * `${CLAUDE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_ROOT}` expand to the plugin folder.
 *
 * Loose commands/agents are also read from the workspace and the user folder:
 *   .zer0ne/{commands,agents}, .claude/{commands,agents}, .opencode/{command,commands,agent,agents}
 */

export interface PluginInfo {
	warnings?: string[];
	id: string;
	activationKey: string;
	name: string;
	version?: string;
	description?: string;
	dir: string;
	scope: 'user' | 'workspace';
	enabled: boolean;
	error?: string;
	counts: { commands: number; skills: number; agents: number; hooks: number; mcp: number };
}

export interface CommandDef {
	name: string;
	description: string;
	argumentHint?: string;
	body: string;
	source: string;
}

export interface AgentDef {
	name: string;
	description: string;
	prompt: string;
	model?: string;
	source: string;
	/** Declares write tools (Edit/Write/Bash…): runs with the full toolset, every change through your approvals. */
	canWrite: boolean;
	/** Tool allow-list (Claude Code or zer0ne names; "*" = all) and deny-list. */
	tools?: string[];
	disallowedTools?: string[];
	/** Model ↔ tools rounds before the subagent must answer. */
	maxTurns?: number;
	/** false: the project's AGENTS.md / CLAUDE.md is left out of its prompt (ZCode's injectAgentsMd). */
	injectAgentsMd?: boolean;
	color?: string;
	/** The Markdown file (none for built-ins). */
	path?: string;
	builtIn?: boolean;
	/** Switched off in Settings → Subagents (listed there, never offered to the model). */
	enabled?: boolean;
	/** The model chosen in Settings → Subagents ("provider::model"); wins over the file's model. */
	modelOverride?: string;
}

/** Settings → Subagents state: switched-off agents and per-agent model choices. */
export interface SubagentState {
	disabled: string[];
	models: Record<string, string>;
}

/**
 * The built-in subagents (the ZCode / Claude Code names, with Pi's report
 * formats): Explore is the fast read-only scout, general-purpose the worker
 * that may edit in the foreground (every change through the user's
 * approvals), Plan and reviewer are read-only specialists. An agent file
 * named Plan or reviewer replaces the built-in one; Explore and
 * general-purpose are reserved.
 */
export const BUILT_IN_AGENTS: AgentDef[] = [
	{
		name: 'Explore',
		description: 'Fast read-only scout for broad searches: finds files, code and facts, and returns compressed context (paths with line ranges, key code, how it connects) another agent can use without re-reading.',
		prompt: [
			'You are Explore, a fast read-only search agent. Search broadly (list files, grep, read the key sections — not whole files), follow references, run independent searches side by side, and stop as soon as the question is answered.',
			'Thoroughness (infer it from the task; default medium): quick = targeted lookups; medium = follow imports and read the critical sections; thorough = trace every dependency, check tests and types.',
			'Report format:',
			'## Files\n1. `path/to/file.ts` (lines 10-50) — what is there',
			'## Key code\nOnly the types, signatures or lines that matter, quoted exactly.',
			'## How it connects\nA few sentences.',
			'## Start here\nWhich file to open first, and why.'
		].join('\n'),
		source: 'built-in',
		canWrite: false,
		tools: ['*'],
		color: 'cyan',
		injectAgentsMd: false,
		builtIn: true
	},
	{
		name: 'general-purpose',
		description: 'General-purpose agent for complex, multi-step tasks; can edit files and run commands (with your approval) when started in the foreground.',
		prompt: [
			'You are a general-purpose subagent. Complete the task fully — do not gold-plate, but do not leave it half-done. Prefer editing existing files to creating new ones; never create documentation files unless asked.',
			'Report format:',
			'## Completed\nWhat was done.',
			'## Files changed\n- `path/to/file.ts` — what changed',
			'## Verified\nHow you checked it (diagnostics, tests, a run) — or why you could not.',
			'## Notes\nAnything the lead agent should know (open questions, follow-ups).'
		].join('\n'),
		source: 'built-in',
		canWrite: true,
		tools: ['*'],
		color: 'blue',
		builtIn: true
	},
	{
		name: 'Plan',
		description: 'Read-only planner: turns findings and requirements into a concrete, step-by-step implementation plan (files, changes, risks). Makes no changes.',
		prompt: [
			'You are Plan, a read-only planning specialist. You receive requirements and often context from a scout. Read what you need to be sure, then write a plan another agent will carry out verbatim. Make no changes.',
			'Report format:',
			'## Goal\nOne sentence.',
			'## Plan\nNumbered, small, actionable steps — each names the file and function to change and what to change.',
			'## Files to modify\n- `path/to/file.ts` — what changes',
			'## New files\n- `path/to/new.ts` — purpose (or "none")',
			'## Risks\nWhat could break, what to test.'
		].join('\n'),
		source: 'built-in',
		canWrite: false,
		tools: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
		color: 'purple',
		builtIn: true
	},
	{
		name: 'reviewer',
		description: 'Read-only code reviewer: checks recent changes (git diff) or given files for bugs, security issues and maintainability, with file:line findings by severity.',
		prompt: [
			'You are a senior code reviewer. Read-only: never edit files. Start from git_diff (recent changes) unless you were given files, read the changed code in context, and look for bugs, security issues, missing error handling and code smells. Be specific; do not pad the report.',
			'Report format:',
			'## Reviewed\n- `path/to/file.ts` (lines X-Y)',
			'## Critical (must fix)\n- `file.ts:42` — the problem and the fix',
			'## Warnings (should fix)\n- `file.ts:100` — …',
			'## Suggestions\n- `file.ts:150` — …',
			'## Summary\nOverall assessment in 2-3 sentences.'
		].join('\n'),
		source: 'built-in',
		canWrite: false,
		tools: ['*'],
		color: 'orange',
		builtIn: true
	}
];

/** Built-in agents an agent file may not replace. */
const RESERVED_AGENTS = new Set(['explore', 'general-purpose']);

/**
 * Built-in workflow commands (Pi's workflow prompts): agent chains the lead
 * agent runs with the task tool. A command file of the same name wins.
 */
export const BUILT_IN_COMMANDS: CommandDef[] = [
	{
		name: 'implement',
		description: 'Explore → Plan → general-purpose: scout the code, plan, then implement and verify',
		argumentHint: '<what to build or change>',
		source: 'built-in',
		body: [
			'Request: $ARGUMENTS',
			'',
			'Run this as ONE task call with a chain of three steps:',
			'1. agent Explore — find all the code relevant to the request: files with line ranges, key types and functions, how they connect.',
			'2. agent Plan — from {previous} and the request, write a concrete step-by-step implementation plan.',
			'3. agent general-purpose — implement the plan in {previous} exactly, verify it (diagnostics, tests), and report what changed.',
			"Put the full request into every step's prompt. Then tell me what was done and how it was verified. If the task tool is not available, do these steps yourself."
		].join('\n')
	},
	{
		name: 'scout-and-plan',
		description: 'Explore → Plan: scout the code and return a plan, without changing anything',
		argumentHint: '<what to plan>',
		source: 'built-in',
		body: [
			'Request: $ARGUMENTS',
			'',
			'Run this as ONE task call with a chain of two steps:',
			'1. agent Explore — find all the code relevant to the request: files with line ranges, key types and functions, how they connect.',
			'2. agent Plan — from {previous} and the request, write a concrete step-by-step implementation plan.',
			"Put the full request into every step's prompt. Do not implement anything: show me the plan and wait. If the task tool is not available, do these steps yourself."
		].join('\n')
	},
	{
		name: 'implement-and-review',
		description: 'general-purpose → reviewer → general-purpose: implement, review the diff, apply the fixes',
		argumentHint: '<what to build or change>',
		source: 'built-in',
		body: [
			'Request: $ARGUMENTS',
			'',
			'Run this as ONE task call with a chain of three steps:',
			'1. agent general-purpose — implement the request and verify it; report the exact files and functions changed.',
			'2. agent reviewer — review the changes from {previous} (start from git_diff): Critical, Warnings, Suggestions with file:line.',
			'3. agent general-purpose — apply every Critical and Warning finding from {previous}, verify again, and report.',
			"Put the full request into every step's prompt. Then tell me what changed, what the review found and what was fixed. If the task tool is not available, do these steps yourself."
		].join('\n')
	},
	
];

/** "Read, Grep" / "[Read, Grep]" / "read_file grep" → names. */
export function toolList(v: string | undefined): string[] | undefined {
	if (!v) return undefined;
	const list = v.replace(/^\[|\]$/g, '').split(/[\s,]+/).map((x) => x.replace(/^["']|["']$/g, '')).filter(Boolean);
	return list.length ? list : undefined;
}

/** hooks/hooks.json shapes (Claude Code / ZCode plugin format). */
interface HookGroupJson {
	matcher?: unknown;
	hooks?: unknown;
}
interface HookEntryJson {
	type?: unknown;
	command?: unknown;
	timeout?: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Claude Code tool names → zer0ne tool names (for plugin hook matchers). */
const TOOL_ALIASES: Record<string, string> = {
	Bash: 'run_command',
	Edit: 'edit_file|multi_edit|apply_patch',
	MultiEdit: 'multi_edit',
	Write: 'write_file',
	Read: 'read_file',
	Grep: 'grep',
	Glob: 'list_files',
	LS: 'list_files',
	WebFetch: 'web_fetch',
	WebSearch: 'web_search',
	Task: 'task',
	NotebookEdit: 'edit_file'
};

function readJson(file: string): any {
	if (!fs.existsSync(file)) return undefined;
	return JSON.parse(readText(file));
}

function mdFiles(dir: string): string[] {
	const out: string[] = [];
	try { noLinks(dir); } catch { return out; }
	const walk = (d: string, depth: number) => {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(d, e.name);
			if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
			if (e.isDirectory() && depth < 2) {
				walk(p, depth + 1);
			} else if (e.isFile() && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') {
				out.push(p);
			}
		}
	};
	walk(dir, 0);
	return out;
}

/** Commands in sub-folders get a namespace: commands/git/commit.md → git:commit. */
function commandName(dir: string, file: string): string {
	const rel = path.relative(dir, file).replace(/\.md$/i, '').split(path.sep);
	return rel.map((p) => slugify(p)).filter(Boolean).join(':');
}

export function expandCommand(body: string, args: string): string {
	const positional = args.match(/"[^"]*"|\S+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
	let out = body.replace(/\$ARGUMENTS\b/g, args);
	out = out.replace(/\$([1-9])\b/g, (_m, n) => positional[Number(n) - 1] ?? '');
	if (!/\$ARGUMENTS\b/.test(body) && args.trim()) {
		out += `\n\n${args}`;
	}
	return out.trim();
}

export class PluginHost {
	private catalogSnapshot?: PluginInfo[];

	/** One discovery operation uses one content revision per installation; subsequent operations recheck it. */
	withCatalogSnapshot<T>(work: () => T): T {
		if (this.catalogSnapshot) return work();
		this.catalogSnapshot = this.plugins();
		try { return work(); } finally { this.catalogSnapshot = undefined; }
	}
	constructor(
		private readonly userDir: string,
		private readonly workspaceRoot: () => string | undefined,
		private readonly disabled: () => string[],
		private readonly activated: () => string[] = () => [],
		private readonly homeDir: string = os.homedir()
	) {}

	pluginDirs(): Array<{ dir: string; scope: PluginInfo['scope'] }> {
		const out: Array<{ dir: string; scope: PluginInfo['scope'] }> = [];
		const scan = (base: string, scope: PluginInfo['scope']) => {
			try {
				noLinks(base);
				for (const e of fs.readdirSync(base, { withFileTypes: true })) {
					if (e.isDirectory() && !e.name.startsWith('.')) {
						out.push({ dir: path.join(base, e.name), scope });
					}
				}
			} catch {
				// none
			}
		};
		const root = this.workspaceRoot();
		if (root) {
			scan(path.join(root, '.zer0ne', 'plugins'), 'workspace');
		}
		scan(path.join(this.userDir, 'plugins'), 'user');
		return out;
	}

	private manifest(dir: string): { name: string; version?: string; description?: string; commands?: unknown; agents?: unknown; skills?: unknown; hooks?: unknown; mcpServers?: unknown } {
		const m = readJson(path.join(dir, '.zcode-plugin', 'plugin.json')) ?? readJson(path.join(dir, '.claude-plugin', 'plugin.json')) ?? {};
		if (!isObject(m) || (m.name !== undefined && (typeof m.name !== 'string' || !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(m.name)))) throw new Error('Invalid plugin manifest or name.');
		return { ...m, name: String(m.name || path.basename(dir)) };
	}

	/** Declared paths supplement the defaults and stay inside the plugin root. */
	private parts(dir: string): { commands: string[]; agents: string[]; skills: string[]; hooks: string[]; mcp: string[] } {
		const m = this.manifest(dir);
		const list = (v: unknown, def: string) => [...new Set([def, ...(Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])])].map(p => { if (typeof p !== 'string') throw new Error('Plugin component paths must be strings.'); return within(dir, p, true); });
		return {
			commands: list(m.commands, 'commands'),
			agents: list(m.agents, 'agents'),
			skills: list(m.skills, 'skills'),
			hooks: list(m.hooks, 'hooks/hooks.json'),
			mcp: list(m.mcpServers, '.mcp.json')
		};
	}

	private componentData(dir: string, kind: 'hooks' | 'mcp'): Array<{ key: string; data: any }> {
		const manifest = this.manifest(dir), field = kind === 'hooks' ? manifest.hooks : manifest.mcpServers;
		return [...this.parts(dir)[kind].filter(file => fs.existsSync(file)).map(file => ({ key: identity(file), data: readJson(file) })), ...(isObject(field) ? [{ key: 'manifest', data: field }] : [])];
	}

	inspect(dir: string): { commands: number; agents: number; skills: number; hooks: boolean; mcp: boolean; warnings: string[] } {
		const parts = this.parts(dir);
		let skills = 0;
		for (const folder of parts.skills) {
			if (fs.existsSync(path.join(folder, 'SKILL.md'))) skills++;
			else { try { skills += fs.readdirSync(folder, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && fs.existsSync(within(folder, e.name + '/SKILL.md'))).length; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
		}
		// Inspection and runtime share every declared source, including inline manifests.
		const hooks = this.componentData(dir, 'hooks'), mcp = this.componentData(dir, 'mcp');
		this.pluginHooks(dir, 'inspection'); this.pluginMcp(dir, 'inspection');
        const warnings: string[] = [];
        for (const { data } of hooks) for (const [event, groups] of Object.entries(data?.hooks ?? data ?? {})) {
            if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].includes(event)) { warnings.push('Unsupported hook event: ' + event); continue; }
            if (!Array.isArray(groups)) { warnings.push('Invalid hook groups: ' + event); continue; }
            for (const group of groups) for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
                if (hook?.type && hook.type !== 'command') warnings.push(event + ': unsupported hook type ' + hook.type);
                if (hook?.async) warnings.push(event + ': async hook option is not supported; commands are awaited');
            }
        }
		return { warnings: [...new Set(warnings)], commands: parts.commands.reduce((n, folder) => n + mdFiles(folder).length, 0), agents: parts.agents.reduce((n, folder) => n + mdFiles(folder).length, 0), skills, hooks: hooks.length > 0, mcp: mcp.length > 0 };
	}

	resolve(key: string): PluginInfo | undefined {
		const plugins = this.plugins(), byId = plugins.find(p => p.id === key);
		if (byId) return byId;
		const matches = plugins.filter(p => p.name === key);
		if (matches.length > 1) throw new Error('More than one plugin has that name. Select its installation in Settings.');
		return matches[0];
	}

	plugins(): PluginInfo[] {
		if (this.catalogSnapshot) return this.catalogSnapshot;
		const off = new Set(this.disabled()), activated = new Set(this.activated());
		return this.pluginDirs().map(({ dir, scope }) => {
			const id = `plugin:${scope}:${identity(dir)}`;
			try {
			const m = this.manifest(dir);
			const inspected = this.inspect(dir);
			const activationKey = `${id}:${this.revision(dir)}`;
			return {
				id,
				activationKey,
				warnings: inspected.warnings,
				name: m.name,
				version: m.version,
				description: m.description,
				dir,
				scope,
				enabled: !off.has(id) && !off.has(m.name) && (activated.has(activationKey) || (scope === 'user' && !inspected.hooks && !inspected.mcp)),
				counts: {
					commands: inspected.commands,
					skills: inspected.skills,
					agents: inspected.agents,
					hooks: this.pluginHooks(dir, id).length,
					mcp: this.pluginMcp(dir, id).length
				}
			};
			} catch (e) { return { id, activationKey: id, name: path.basename(dir), dir, scope, enabled: false, error: e instanceof Error ? e.message : String(e), counts: { commands: 0, skills: 0, agents: 0, hooks: 0, mcp: 0 } }; }
		});
	}

	private namespace(plugin: PluginInfo): string {
		const same = this.plugins().filter(p => p.name === plugin.name);
		return slugify(plugin.name) + (same.length > 1 ? '-' + identity(plugin.dir).slice(0, 8) : '');
	}

	private revision(dir: string): string {
		validateTree(dir);
		const hash = createHash('sha256');
		const walk = (folder: string) => {
			for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.zer0ne-origin.json') continue;
				const file = path.join(folder, entry.name);
				if (entry.isDirectory()) walk(file);
				else { hash.update(path.relative(dir, file)).update('\0').update(fs.readFileSync(file)).update('\0'); }
			}
		};
		walk(dir);
		return hash.digest('hex');
	}

	private enabledPlugins(): PluginInfo[] {
		return this.plugins().filter((p) => p.enabled);
	}

	/** Loose sources for commands / agents (workspace first, then user, then other tools). */
	private looseDirs(kind: 'commands' | 'agents'): Array<{ dir: string; source: string }> {
		const root = this.workspaceRoot();
		const out: Array<{ dir: string; source: string }> = [];
		const alt = kind === 'commands' ? ['command', 'commands'] : ['agent', 'agents'];
		if (root) {
			out.push({ dir: path.join(root, '.zer0ne', kind), source: 'workspace' });
			out.push({ dir: path.join(root, '.claude', kind), source: 'claude' });
			alt.forEach((a) => out.push({ dir: path.join(root, '.opencode', a), source: 'opencode' }));
		}
		out.push({ dir: path.join(this.userDir, kind), source: 'user' });
		out.push({ dir: path.join(this.homeDir, '.claude', kind), source: 'claude' });
		alt.forEach((a) => out.push({ dir: path.join(this.homeDir, '.config', 'opencode', a), source: 'opencode' }));
		return out;
	}

	commands(): CommandDef[] {
		const seen = new Set<string>();
		const out: CommandDef[] = [];
		const add = (dir: string, source: string, prefix = '') => {
			for (const file of mdFiles(dir)) {
				const name = (prefix ? prefix + ':' : '') + commandName(dir, file);
				if (!name || seen.has(name)) {
					continue;
				}
				try {
					const text = readText(file);
					const parsed = parseSkill(text);
					const meta = frontmatter(text);
					seen.add(name);
					out.push({ name, description: parsed.description || firstLine(parsed.body), argumentHint: meta['argument-hint'], body: parsed.body, source });
				} catch {
					// unreadable
				}
			}
		};
		this.looseDirs('commands').forEach((d) => add(d.dir, d.source));
		for (const p of this.enabledPlugins()) {
			this.parts(p.dir).commands.forEach((d) => add(d, `plugin:${p.name}`, this.namespace(p)));
		}
		for (const c of BUILT_IN_COMMANDS) if (!seen.has(c.name) && (!isDesktopHost() || c.name !== 'mod')) out.push({ ...c });
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Settings → Subagents state (set by the controller). */
	agentState: () => SubagentState = () => ({ disabled: [], models: {} });

	/** The subagents the model may use: built-ins and agent files, minus the ones switched off. */
	agents(): AgentDef[] {
		return this.allAgents().filter((a) => a.enabled);
	}

	/** Every subagent (Settings → Subagents lists the switched-off ones too). */
	allAgents(): AgentDef[] {
		const state = this.agentState();
		const files = this.agentFiles().filter((a) => !RESERVED_AGENTS.has(a.name.toLowerCase()));
		const replaced = new Set(files.map((a) => a.name.toLowerCase()));
		return [...BUILT_IN_AGENTS.filter((a) => !replaced.has(a.name.toLowerCase())).map((a) => ({ ...a })), ...files].map((a) => ({ ...a, enabled: !state.disabled.includes(a.name), modelOverride: state.models[a.name] || undefined }));
	}

	/** Where new agent files go: this project, or the user's own folder (every project). */
	agentDirs(): { project?: string; user: string } {
		const root = this.workspaceRoot();
		return { project: root ? path.join(root, '.zer0ne', 'agents') : undefined, user: path.join(this.userDir, 'agents') };
	}

	private agentFiles(): AgentDef[] {
		const seen = new Set<string>();
		const out: AgentDef[] = [];
		const add = (dir: string, source: string, prefix = '') => {
			for (const file of mdFiles(dir)) {
				try {
					const text = readText(file);
					const parsed = parseSkill(text);
					const meta = frontmatter(text);
					if (meta.mode === 'primary') {
						continue; // opencode primary agents are modes, not subagents
					}
					const rawName = parsed.name && /^[\w.-]+$/.test(parsed.name) ? parsed.name : slugify(parsed.name || path.basename(file, '.md'));
					const name = (prefix ? prefix + '-' : '') + rawName;
					if (!name || seen.has(name) || !parsed.body.trim()) {
						continue;
					}
					seen.add(name);
					const tools = `${meta.tools ?? ''} ${meta.permission ?? ''} ${meta.mode ?? ''}`;
					const canWrite = /\b(Edit|MultiEdit|Write|Bash|edit_file|write_file|multi_edit|apply_patch|run_command|write|all)\b|\*/i.test(tools);
					const maxTurns = parseInt(meta.maxturns ?? '', 10);
					const inject = String(meta.injectagentsmd ?? '').trim().toLowerCase();
					out.push({ name, description: parsed.description || firstLine(parsed.body), prompt: parsed.body, model: meta.model, source, canWrite, tools: toolList(meta.tools), disallowedTools: toolList(meta.disallowedtools), maxTurns: maxTurns > 0 ? maxTurns : undefined, color: meta.color || undefined, injectAgentsMd: inject === 'false' ? false : undefined, path: file });
				} catch {
					// unreadable
				}
			}
		};
		this.looseDirs('agents').forEach((d) => add(d.dir, d.source));
		for (const p of this.enabledPlugins()) {
			this.parts(p.dir).agents.forEach((d) => add(d, `plugin:${p.name}`, this.namespace(p)));
		}
		return out;
	}

	skillDirs(): Array<{ dir: string; plugin: string }> {
		return this.enabledPlugins().flatMap((p) => this.parts(p.dir).skills.map((dir) => ({ dir, plugin: p.name })));
	}

	hooks(): HookConfig[] {
		return this.enabledPlugins().flatMap((p) => this.pluginHooks(p.dir, p.id));
	}

	

	mcpServers(): McpServerConfig[] {
		return this.enabledPlugins().flatMap((p) => this.pluginMcp(p.dir, p.id));
	}

	private expandRoot(s: string, dir: string): string {
		return s.replace(/\$\{(CLAUDE|ZCODE|ZER0NE)_PLUGIN_ROOT\}/g, dir);
	}

	private pluginHooks(dir: string, plugin: string): HookConfig[] {
		const events = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
		const out: HookConfig[] = [];
		for (const { key, data: json } of this.componentData(dir, 'hooks')) {
			const table = json?.hooks ?? json ?? {};
			for (const [event, groups] of Object.entries(table)) {
				if (!events.has(event) || !Array.isArray(groups)) {
					continue;
				}
				(groups as unknown[]).filter(isObject).forEach((g: HookGroupJson, gi) => {
					const rawMatcher = String(g?.matcher ?? '');
					const aliasesOnly = rawMatcher.split('|').every(t => TOOL_ALIASES[t.trim()]);
					const converted = rawMatcher
						.split('|')
						.map(t => TOOL_ALIASES[t.trim()] ? aliasesOnly ? TOOL_ALIASES[t.trim()] : `^(?:${TOOL_ALIASES[t.trim()]})$` : t.trim())
						.filter(Boolean)
						.join('|');
					const matcher = rawMatcher === '*' ? '' : aliasesOnly ? `^(?:${converted})$` : converted;
					(Array.isArray(g.hooks) ? g.hooks : []).filter(isObject).forEach((h: HookEntryJson, hi: number) => {
						if (h?.type && h.type !== 'command') {
							return;
						}
						const command = this.expandRoot(String(h?.command ?? ""), dir);
						if (command.trim()) {
							out.push({ id: `${plugin}:${key}:${event}:${gi}:${hi}`, event: event as HookConfig['event'], matcher, command, enabled: true, timeoutSec: Math.min(600, Math.max(5, Number(h?.timeout) || 60)) });
						}
					});
				});
			}
		}
		return out;
	}

	private pluginMcp(dir: string, plugin: string): McpServerConfig[] {
		const out: McpServerConfig[] = [];
		for (const { key, data: json } of this.componentData(dir, 'mcp')) {
			const table = json?.mcpServers ?? json ?? {};
			for (const config of parseMcpJson(JSON.stringify({ mcpServers: table }))) {
				out.push({ ...config, id: `${plugin}:${key}:${config.name}`, plugin, trusted: false, command: this.expandRoot(config.command, dir), args: config.args.map(arg => this.expandRoot(arg, dir)), env: Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, this.expandRoot(v, dir)])), url: this.expandRoot(config.url, dir), headers: Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, this.expandRoot(v, dir)])) });
			}
		}
		return out;
	}

	// ---------------------------------------------------------------- install / remove

	private target(name: string, scope: PluginInfo['scope']): string {
		const root = this.workspaceRoot();
		const base = scope === 'workspace' && root ? path.join(root, '.zer0ne', 'plugins') : path.join(this.userDir, 'plugins');
		if (scope === 'workspace' && !root) throw new Error('Open a project to install a workspace plugin.');
		return within(base, slugify(name) || 'plugin');
	}

	/** Copy a plugin folder (or a marketplace repo's plugins/<name>) into the plugins folder. */
	installFromFolder(src: string, scope: PluginInfo['scope'] = 'user'): string[] {
		const candidates = fs.existsSync(path.join(src, '.zcode-plugin')) || fs.existsSync(path.join(src, '.claude-plugin'))
			? [src]
			: fs.existsSync(path.join(src, 'plugins'))
				? fs.readdirSync(path.join(src, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(src, 'plugins', e.name))
				: [src];
		const installed: string[] = [];
		for (const dir of candidates) {
			const name = this.manifest(dir).name;
			const dest = this.target(name, scope);
			const from = path.resolve(dir), to = path.resolve(dest), rel = path.relative(from, to);
			if (!rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))) throw new Error('The plugin source overlaps its installation folder.');
			pathLock([dest], () => {
				validateTree(from); const stage = stageFor(dest);
				try {
					fs.cpSync(from, stage, { recursive: true, filter: p => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
					validateTree(stage); this.inspect(stage); publish(stage, dest);
				} finally { removeStage(stage); }
			});
			installed.push(name);
		}
		return installed;
	}

	/** git clone --depth 1, then install the plugin (or every plugin of a marketplace repo). */
	async installFromGit(url: string, scope: PluginInfo['scope'] = 'user', signal?: AbortSignal): Promise<string[]> {
		if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(url.trim())) {
			throw new Error('Use an https:// or git@ repository URL.');
		}
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-plugin-'));
		try {
			await new Promise<void>((resolve, reject) =>
				execFile('git', ['clone', '--depth', '1', url.trim(), tmp], { windowsHide: true, timeout: 120_000, signal }, (err, _o, stderr) =>
					err ? reject(new Error((stderr || err.message).trim().slice(0, 300))) : resolve()
				)
			);
			return this.installFromFolder(tmp, scope);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	remove(name: string): void {
		const hit = this.resolve(name);
		if (!hit) {
			throw new Error(`No plugin named "${name}".`);
		}
		pathLock([hit.dir], () => { noLinks(hit.dir); fs.rmSync(hit.dir, { recursive: true, force: true }); });
	}
}

function frontmatter(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(markdown(text).meta)) out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
	return out;
}

function firstLine(body: string): string {
	return (body.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '').trim().slice(0, 120);
}
