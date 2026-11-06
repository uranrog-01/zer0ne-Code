const yaml = require('../vendor/js-yaml.js') as { load(text: string, options: { schema: unknown }): unknown; JSON_SCHEMA: unknown };

export function markdown(text: string): { meta: Record<string, unknown>; body: string } {
	if (Buffer.byteLength(text) > 2_000_000) throw new Error('Instructions exceed 2 MB.');
	const clean = text.replace(/^\uFEFF/, '');
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(clean);
	if (!match) return { meta: {}, body: clean.trim() };
	if (Buffer.byteLength(match[1]) > 64_000) throw new Error('Instruction metadata exceeds 64 KB.');
	// Earlier versions wrote an unquoted wildcard in agent tool lists.
	const metadata = match[1].replace(/^(tools:\s*)\*(\s*(?:#.*)?)$/gm, '$1"*"$2');
	const value = yaml.load(metadata, { schema: yaml.JSON_SCHEMA });
	if (value != null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Instruction metadata must be a YAML mapping.');
	return { meta: (value ?? {}) as Record<string, unknown>, body: match[2].trim() };
}

export function textField(meta: Record<string, unknown>, name: string): string | undefined {
	const value = meta[name];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new Error(`Instruction ${name} must be text.`);
	return value;
}
