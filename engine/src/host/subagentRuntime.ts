import type { ToolDef } from '../chatClient';
import type { ModelEntry, ProviderConfig, ProviderStore } from '../providerStore';
import type { AgentDef } from '../tools/plugins';

/** Claude Code / ZCode tool names in agent files → zer0ne's tools. */
const TOOL_ALIASES: Record<string, string[]> = {
	read: ['read_file'],
	grep: ['grep'],
	glob: ['list_files'],
	ls: ['list_files'],
	bash: ['run_command'],
	edit: ['edit_file', 'edit_lines'],
	multiedit: ['edit_file', 'multi_edit'],
	write: ['write_file'],
	notebookedit: ['notebook_edit'],
	webfetch: ['web_fetch'],
	websearch: ['web_search'],
	todowrite: ['todo_write']
};

function expand(names: string[]): Set<string> {
	const out = new Set<string>();
	for (const n of names) {
		if (/[()]/.test(n)) throw new Error(`Unsupported argument restriction "${n}". Use tool names; restricted shell patterns cannot be enforced.`);
		for (const t of TOOL_ALIASES[n.toLowerCase()] ?? [n]) out.add(t);
	}
	return out;
}

/**
 * The tools a subagent gets: its file's allow-list (no list or "*" = every
 * tool it would get anyway) minus its deny-list. MCP tools pass an allow-list
 * of "mcp__*" or their own names (pure; tested).
 */
export function agentTools(defs: ToolDef[], agent?: Pick<AgentDef, 'tools' | 'disallowedTools'>, parent?: ReadonlySet<string>, previous?: readonly string[]): ToolDef[] {
	const expanded = agent?.tools ? expand(agent.tools) : undefined;
	const allow = expanded?.has('*') ? undefined : expanded;
	const deny = agent?.disallowedTools ? expand(agent.disallowedTools) : new Set<string>();
	const matches = (patterns: Set<string>, name: string) => [...patterns].some(p => new RegExp('^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(name));
	return defs.filter((d) => !matches(deny, d.name) && (!allow || matches(allow, d.name)) && (!parent || parent.has(d.name)) && (!previous || previous.includes(d.name)));
}

export interface Routed {
	provider: ProviderConfig;
	model: ModelEntry;
	apiKey: string;
}

/**
 * The model a subagent runs on: the Settings → Subagents choice, else its
 * file's `model` — "provider::model", an exact model id, or an alias such as
 * "haiku" / "sonnet" / "opus" matched against the enabled models (the chat's
 * provider first). "inherit", nothing or no match: the chat's own model.
 */
export async function agentModel(store: ProviderStore, agent: Pick<AgentDef, 'model' | 'modelOverride'> | undefined, current: { provider: ProviderConfig }): Promise<Routed | undefined> {
	const spec = (agent?.modelOverride || agent?.model || '').trim();
	if (!spec || /^inherit$/i.test(spec)) return undefined;
	const providers = (await store.list()).filter((p) => p.enabled && p.apiFormat !== 'acp');
	const withKey = async (provider: ProviderConfig, model: ModelEntry): Promise<Routed | undefined> => {
		const apiKey = (await store.getApiKey(provider.id).catch(() => undefined)) ?? '';
		return { provider, model, apiKey };
	};
	const [pid, mid] = spec.includes('::') ? spec.split('::') : [undefined, spec];
	if (pid) {
		const p = providers.find((x) => x.id === pid);
		const m = p?.models.find((x) => x.id === mid && x.enabled);
		if (!p || !m) throw new Error(`Agent model "${spec}" is unavailable or disabled.`);
		return p && m ? withKey(p, m) : undefined;
	}
	const ordered = [...providers.filter((p) => p.id === current.provider.id), ...providers.filter((p) => p.id !== current.provider.id)];
	const want = mid.toLowerCase();
	for (const exact of [true, false]) {
		for (const p of ordered) {
			const m = p.models.filter((x) => x.enabled).find((x) => (exact ? x.id.toLowerCase() === want : x.id.toLowerCase().includes(want)));
			if (m) return withKey(p, m);
		}
	}
	return undefined;
}
