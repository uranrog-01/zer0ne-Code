import type { ToolCall, ToolDef } from '../chatClient';

/**
 * Deferred tools (Codex / Claude Code "tool search", omp's xd:// devices).
 *
 * Every tool schema is sent with every request. Rarely used tools — the
 * browser set, MCP servers' tools, rename/move/delete, images, memory … —
 * cost thousands of tokens per call while idle. Deferred tools are listed by
 * name + one line inside `tool_search`; the model loads full schemas on
 * demand and calls them through `use_tool`. The tools array itself never
 * changes during a session, so the prompt cache is not disturbed.
 */

/** Always sent in full: the everyday toolset. */
const CORE = new Set([
	'list_files', 'read_file', 'grep', 'semantic_search', 'code_intel', 'get_diagnostics', 'get_editor_context',
	'edit_file', 'edit_lines', 'multi_edit', 'apply_patch', 'write_file', 'run_command', 'run_script',
	'todo_write', 'ask_user', 'task', 'agent_result', 'agent_send', 'skill', 'web_search', 'web_fetch', 'git_status', 'git_diff',
	// Opt-in, and the one tool a user enabled on purpose: hiding it behind tool_search would look broken.
	'image_generate',
	// A few tokens of schema buys the model a budget check before a costly read.
	'context_remaining'
]);

export interface DeferredSplit {
	tools: ToolDef[];
	deferred: Map<string, ToolDef>;
}

function oneLine(s: string, max = 80): string {
	const first = s.split(/(?<=\.)\s|\n/)[0];
	return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}

/** A tool's family: an MCP server (`mcp__server__…`) or the name before its first underscore. */
function family(name: string): string {
	const mcp = name.match(/^(mcp__[^_]+(?:_[^_]+)*?)__/);
	return mcp ? mcp[1]! : name.split('_')[0]!;
}

/**
 * The catalog inside tool_search's description, sent with every request: families of three or
 * more (a browser's dozen actions, one MCP server's tools) take one line, the rest a short hint.
 * The full definitions still come from tool_search on demand (pure; tested).
 */
export function deferredCatalog(rest: ToolDef[]): string {
	const groups = new Map<string, ToolDef[]>();
	for (const t of rest) groups.set(family(t.name), [...(groups.get(family(t.name)) ?? []), t]);
	const lines: string[] = [];
	for (const [prefix, tools] of groups) {
		if (tools.length >= 3) {
			const sep = prefix.startsWith('mcp__') ? '__' : '_';
			const short = tools.map((t) => (t.name.startsWith(prefix + sep) ? t.name.slice(prefix.length + sep.length) : t.name));
			// Names only: one member's description would mislabel the rest of the family.
			lines.push(`- ${prefix}${sep}* (${tools.length}): ${short.join(', ')}`);
		} else for (const t of tools) lines.push(`- ${t.name}: ${oneLine(t.description)}`);
	}
	return lines.join('\n');
}

/** Keep core tools, replace the rest by tool_search + use_tool (only when it pays off). */
export function splitDeferred(all: ToolDef[], minDeferred = 4): DeferredSplit {
	const keep = all.filter((t) => CORE.has(t.name));
	const rest = all.filter((t) => !CORE.has(t.name));
	if (rest.length < minDeferred) {
		return { tools: all, deferred: new Map() };
	}
	const deferred = new Map(rest.map((t) => [t.name, t]));
	const catalog = deferredCatalog(rest);
	return {
		deferred,
		tools: [
			...keep,
			{
				name: 'tool_search',
				description: `Load the full definition of extra tools before using them. Extra tools available (a family line lists names without its prefix: browser_* (3): click, … means browser_click …):\n${catalog}\nPass tool names or keywords; then call a tool with use_tool.`,
				parameters: { type: 'object', properties: { query: { type: 'string', description: 'Tool names (comma separated) or keywords' } }, required: ['query'], additionalProperties: false }
			},
			{
				name: 'use_tool',
				description: 'Call one of the extra tools listed in tool_search (load its definition first). arguments must match that tool\'s parameters.',
				parameters: {
					type: 'object',
					properties: { name: { type: 'string' }, arguments: { type: 'object', description: 'The tool arguments as a JSON object' } },
					required: ['name', 'arguments'],
					additionalProperties: false
				}
			}
		]
	};
}

/** tool_search: exact names first, then keyword matches; full schemas as text. */
export function searchDeferred(deferred: Map<string, ToolDef>, query: string): { text: string; names: string[] } {
	const q = query.toLowerCase();
	const names = q.split(/[\s,]+/).filter(Boolean);
	let hits = [...deferred.values()].filter((t) => names.includes(t.name.toLowerCase()));
	if (!hits.length) {
		const score = (t: ToolDef) => names.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 3 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0);
		hits = [...deferred.values()]
			.map((t) => [score(t), t] as const)
			.filter(([s]) => s > 0)
			.sort((a, b) => b[0] - a[0])
			.slice(0, 6)
			.map(([, t]) => t);
	}
	if (!hits.length) {
		return { text: `No extra tool matches "${query}". Available: ${[...deferred.keys()].join(', ')}`, names: [] };
	}
	return {
		names: hits.map((t) => t.name),
		text: hits.map((t) => `### ${t.name}\n${t.description}\nparameters: ${JSON.stringify(t.parameters)}`).join('\n\n') + '\n\nCall them with use_tool { "name": …, "arguments": { … } }.'
	};
}

/** use_tool → the inner call (same id, so the result pairs with the model's call). */
export function unwrapUseTool(call: ToolCall, deferred: Map<string, ToolDef>): { call: ToolCall } | { error: string } {
	let args: { name?: unknown; arguments?: unknown };
	try {
		args = JSON.parse(call.arguments || '{}');
	} catch {
		return { error: 'use_tool arguments were not valid JSON.' };
	}
	const name = String(args.name ?? '');
	if (!deferred.has(name)) {
		return { error: `"${name}" is not an extra tool. Call core tools directly; extra tools: ${[...deferred.keys()].join(', ')}` };
	}
	const inner = typeof args.arguments === 'string' ? args.arguments : JSON.stringify(args.arguments ?? {});
	return { call: { id: call.id, name, arguments: inner } };
}
