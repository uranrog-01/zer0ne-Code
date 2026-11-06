import { createHash } from 'crypto';
import type { ChatMessage, StreamOptions, StreamResult } from './chatClient';

export interface NativeState {
	format: 'responses' | 'anthropic' | 'gemini';
	route: string;
	model: string;
	textHash: string;
	items: Record<string, any>[];
	/** Reported output includes opaque reasoning that cannot be tokenized locally. */
	outputTokens?: number;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function scope(options: Pick<StreamOptions, 'baseUrl' | 'providerId'> & Partial<Pick<StreamOptions, 'apiKey'>>): string {
	let endpoint = options.baseUrl.trim().replace(/\/+$/, '');
	try { const url = new URL(endpoint); endpoint = url.origin + url.pathname.replace(/\/+$/, ''); } catch { /* Region identifiers are valid Bedrock configuration. */ }
	return hash(JSON.stringify([endpoint, options.providerId ?? '', hash(options.apiKey ?? '')]));
}

export function continuation(options: StreamOptions, format: NativeState['format'], items: Record<string, any>[], text: string, outputTokens?: number): NativeState | undefined {
	return items.length ? { format, route: scope(options), model: options.model, textHash: hash(text), items, outputTokens } : undefined;
}

/** A fallback, edited message or different account must never replay foreign opaque state. */
export function nativeItems(message: Extract<ChatMessage, { role: 'assistant' }>, options: Pick<StreamOptions, 'baseUrl' | 'providerId' | 'model'> & Partial<Pick<StreamOptions, 'apiKey'>> | undefined, format: NativeState['format']): Record<string, any>[] | undefined {
	const state = message.native;
	if (!state || !options || state.format !== format || state.route !== scope(options) || state.model !== options.model || state.textHash !== hash(message.content) || !Array.isArray(state.items) || state.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return undefined;
	let index = 0;
	const items = state.items.map(item => {
		const call = format === 'responses' ? item.type === 'function_call' : format === 'anthropic' ? item.type === 'tool_use' : !!item.functionCall;
		if (!call) return { ...item };
		const current = message.toolCalls?.[index++];
		if (!current) return undefined;
		const originalName = format === 'gemini' ? item.functionCall.name : item.name;
		if (current.name !== originalName) return undefined;
		try {
			const originalArgs = format === 'responses' ? JSON.parse(item.arguments || '{}') : format === 'anthropic' ? item.input : item.functionCall.args;
			if (JSON.stringify(originalArgs ?? {}) !== JSON.stringify(JSON.parse(current.arguments || '{}'))) return undefined;
		} catch { return undefined; }
		// The execution ledger may rename a replayed call id; its result must still pair.
		if (format === 'responses') return { ...item, call_id: current.id, name: current.name, arguments: current.arguments || '{}', ...(current.namespace ? { namespace: current.namespace } : {}) };
		let args: unknown;
		try { args = JSON.parse(current.arguments || '{}'); } catch { return undefined; }
		if (format === 'anthropic') return { ...item, id: current.id, name: current.name, input: args };
		return { ...item, functionCall: { ...item.functionCall, name: current.name, args, ...(current.id.startsWith('gem_') ? {} : { id: current.id }) } };
	});
	return items.some(item => !item) || index !== (message.toolCalls?.length ?? 0) ? undefined : items as Record<string, any>[];
}

export function assistantMessage(result: StreamResult): Extract<ChatMessage, { role: 'assistant' }> {
	return { role: 'assistant', content: result.text, ...(result.reasoning ? { reasoning: result.reasoning } : {}), ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}), ...(result.native ? { native: result.native } : {}) };
}
