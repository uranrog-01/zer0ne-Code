import type { ToolCall, ToolDef } from './chatClient';

/** Dynamic-key objects and unresolved references retain their original, non-strict contract. */
export function strictSchema(schema: Record<string, any>): Record<string, any> | undefined {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
	if (schema.$ref || schema.oneOf || schema.not || schema.patternProperties || schema.additionalProperties && schema.additionalProperties !== false) return undefined;
	const out = { ...schema }; delete out.$schema; delete out.default;
	if (Array.isArray(schema.anyOf)) {
		const variants = schema.anyOf.map((v: Record<string, any>) => strictSchema(v));
		if (variants.some((v: unknown) => !v)) return undefined;
		out.anyOf = variants;
	}
	if (schema.type === 'object' || schema.properties) {
		const properties: Record<string, any> = {}, required = new Set(schema.required ?? []);
		for (const [key, value] of Object.entries(schema.properties ?? {})) {
			const child = strictSchema(value as Record<string, any>);
			if (!child) return undefined;
			properties[key] = required.has(key) || nullable(child) ? child : { anyOf: [child, { type: 'null' }] };
		}
		Object.assign(out, { type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
	}
	if (schema.items) { const items = strictSchema(schema.items); if (!items) return undefined; out.items = items; }
	return out;
}
function nullable(schema: Record<string, any>): boolean {
	return schema.type === 'null' || Array.isArray(schema.type) && schema.type.includes('null') || schema.anyOf?.some((v: Record<string, any>) => nullable(v));
}
function restoreOptional(value: any, schema: Record<string, any>): any {
	if (Array.isArray(value)) return value.map(v => restoreOptional(v, schema.items ?? {}));
	if (!value || typeof value !== 'object') return value;
	const required = new Set(schema.required ?? []);
	return Object.fromEntries(Object.entries(value).flatMap(([key, v]) => {
		const child = schema.properties?.[key];
		if (!child) return [[key, v]];
		if (v === null && !required.has(key) && !nullable(child)) return [];
		return [[key, restoreOptional(v, child)]];
	}));
}
export function executableCall(call: ToolCall, tools: ToolDef[] | undefined, strict?: boolean): ToolCall {
	const tool = strict && tools?.find(t => t.name === call.name);
	if (!tool || !strictSchema(tool.parameters)) return call;
	try { return { ...call, executionArguments: JSON.stringify(restoreOptional(JSON.parse(call.arguments || '{}'), tool.parameters)) }; } catch { return call; }
}
export function functionTool(tool: ToolDef, strict?: boolean): Record<string, unknown> {
	const schema = strict && strictSchema(tool.parameters);
	return { name: tool.name, description: tool.description, parameters: schema || tool.parameters, strict: !!schema };
}
