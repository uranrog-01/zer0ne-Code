import type { ToolCall } from '../chatClient';

/**
 * Tool calls a model wrote into its text instead of the API's tool_calls field.
 * Small local models do this when the server's chat template does not convert
 * them, and the agent would otherwise print the call and stop. Recognized:
 *   <tool_call>{"name": …, "arguments": {…}}</tool_call>          (Hermes, Qwen)
 *   <tool_call><function=NAME><parameter=KEY>…</parameter></function></tool_call>   (Qwen3-Coder)
 *   <function=NAME>{…}</function>                                  (Llama 3.x)
 *   a ```json fence, or the whole reply, holding {"name": …, "arguments": {…}}
 * Only names of tools offered on this request count, so code that merely looks
 * like a call stays text (pure; tested).
 */
export function textToolCalls(text: string, toolNames: ReadonlySet<string>, idPrefix: string): { text: string; calls: ToolCall[] } {
	const calls: ToolCall[] = [];
	if (!text || !toolNames.size || !/<tool_call>|<function=|"name"\s*:/.test(text)) return { text, calls };
	const add = (name: unknown, args: unknown): boolean => {
		if (typeof name !== 'string' || !toolNames.has(name)) return false;
		let a: unknown = args ?? {};
		if (typeof a === 'string') {
			try { a = JSON.parse(a || '{}'); } catch { return false; }
		}
		if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
		calls.push({ id: `${idPrefix}_${calls.length}`, name, arguments: JSON.stringify(a) });
		return true;
	};
	const fromObject = (raw: string): boolean => {
		try {
			const v = JSON.parse(raw.trim());
			return !!v && typeof v === 'object' && add(v.name ?? v.function?.name, v.arguments ?? v.parameters ?? v.args ?? v.function?.arguments);
		} catch {
			return false;
		}
	};
	/** <function=NAME>…</function>: a JSON body, or <parameter=KEY>value</parameter> pairs. */
	const fromFunction = (name: string, body: string): boolean => {
		const trimmed = body.trim();
		if (trimmed.startsWith('{')) return add(name, trimmed);
		const args: Record<string, unknown> = {};
		for (const m of trimmed.matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) {
			const value = m[2].replace(/^\n/, '').replace(/\n$/, '');
			try {
				const parsed = JSON.parse(value);
				args[m[1]] = typeof parsed === 'string' || typeof parsed === 'number' || typeof parsed === 'boolean' || (parsed && typeof parsed === 'object') ? parsed : value;
			} catch {
				args[m[1]] = value;
			}
		}
		return add(name, args);
	};
	let rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, inner: string) => {
		const fn = /^<function=([\w.-]+)>([\s\S]*?)<\/function>$/.exec(inner.trim());
		return (fn ? fromFunction(fn[1], fn[2]) : fromObject(inner)) ? '' : whole;
	});
	rest = rest.replace(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g, (whole, name: string, body: string) => (fromFunction(name, body) ? '' : whole));
	if (!calls.length) rest = rest.replace(/```(?:json|tool_call|tool)?\s*\n?(\{[\s\S]*?\})\s*```/g, (whole, inner: string) => (fromObject(inner) ? '' : whole));
	if (!calls.length && /^\s*\{[\s\S]*\}\s*$/.test(rest) && fromObject(rest)) rest = '';
	return { text: calls.length ? rest.replace(/\n{3,}/g, '\n\n').trim() : text, calls };
}
