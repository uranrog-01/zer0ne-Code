import type { ToolDef } from './chatClient';

function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered((value as Record<string, unknown>)[key])]));
	return value;
}

export function stableTools(tools: ToolDef[] | undefined): ToolDef[] | undefined {
	// Only definition-object keys are canonicalized. History, signatures, tool IDs,
	// schema arrays and attachment bytes retain their provider-required ordering.
	return tools?.map((tool) => ({ name: tool.name, description: tool.description, parameters: ordered(tool.parameters) as Record<string, unknown> }))
		.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function runtimeDate(content: string): string {
	const suffix = `\n\n<runtime-context>Current UTC date: ${new Date().toISOString().slice(0, 10)}</runtime-context>`;
	return content.endsWith(suffix) ? content : content + suffix;
}
