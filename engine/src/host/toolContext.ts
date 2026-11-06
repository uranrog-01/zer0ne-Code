/*
 * The tool context of one model request: which tools are offered, which wait
 * behind tool_search, and how many characters each part of the context costs
 * (the numbers behind the composer's context popover). It lives here rather
 * than in the controller so the same list and the same accounting are
 * produced wherever a turn is assembled.
 */
import type { ToolDef } from '../chatClient';
import type { AgentSettings } from '../providerStore';
import { buildToolDefs } from '../tools/agentTools';
import { splitDeferred } from '../tools/deferred';
import type { AgentDef } from '../tools/plugins';
import { stableTools } from '../prefixStability';

/** The long-lived stores the tool list is built from. */
export interface ToolContextHosts {
	mcpDefs(): ToolDef[];
	agentDefs(): AgentDef[];
	skillCatalogChars(): number;
}

/** Characters per part, for the context popover. */
export interface ToolContextChars {
	skills: number;
	mcp: number;
	tools: number;
}

export interface TurnToolContext {
	mcpDefs: ToolDef[];
	tools?: ToolDef[];
	deferred?: Map<string, ToolDef>;
	chars: ToolContextChars;
}

export function buildToolContext(settings: AgentSettings, plan: boolean, useTools: boolean, hosts: ToolContextHosts): TurnToolContext {
	const mcpDefs = useTools && settings.mcp && !plan ? hosts.mcpDefs() : [];
	const agentDefs = settings.subagents ? [...hosts.agentDefs()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : [];
	const allTools = useTools ? buildToolDefs(settings, { mcp: mcpDefs, skills: settings.skills, readOnly: plan, agents: agentDefs }) : undefined;
	// Rarely used tools are loaded on demand (tool_search / use_tool): fewer tokens per call.
	const split = allTools && settings.deferTools ? splitDeferred(allTools) : undefined;
	const offered = split ? split.tools : allTools;
	const tools = settings.stablePrefix !== false ? stableTools(offered) : offered;
	const skills = useTools && settings.skills ? hosts.skillCatalogChars() : 0;
	const names = new Set(mcpDefs.map((t) => t.name));
	let mcp = 0;
	let toolChars = tools ? 2 : 0;
	for (const [i, tool] of (tools ?? []).entries()) {
		const size = JSON.stringify(tool).length + (i ? 1 : 0);
		if (names.has(tool.name)) mcp += size;
		else toolChars += size;
	}
	return { mcpDefs, tools, deferred: split?.deferred, chars: { skills, mcp, tools: toolChars } };
}
