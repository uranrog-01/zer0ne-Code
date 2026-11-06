import type { ChatMessage, StreamOptions, StreamResult, ToolCall } from './chatClient';
import { parseJson, post, readSse, opencodeSessionHeaders, ResponseTextGuard } from './chatClient';
import { chatgptAccountId } from './accounts';
import { openaiUsage } from './usage';
import { reasoningHints } from './reasoning';
import { continuation, nativeItems } from './continuation';
import { functionTool } from './toolSchema';

/**
 * The Codex backend behind "Sign in with ChatGPT" speaks the OpenAI
 * Responses API: POST {base}/responses with `instructions` + `input` items,
 * streamed as typed events (response.output_text.delta, function-call
 * argument deltas, reasoning summaries, response.completed with usage).
 *
 * Requests are stateless (store: false). The model's encrypted reasoning
 * and ordered output items must survive final replies as well as tool steps.
 */

const REASONING_TAG = '{"type":"reasoning"';
const PLAN_NAMESPACE = 'zer0ne';

function responsesUrl(baseUrl: string, codex = true): string {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (/\/responses$/.test(base)) return base;
	if (!codex) return `${base}/responses`;
	return /\/codex$/.test(base) ? `${base}/responses` : `${base}/codex/responses`;
}

/** Chat history → Responses `input` items (pure; tested). */
export function toResponsesInput(messages: ChatMessage[], chatgptPlan = false, options?: StreamOptions): unknown[] {
	const out: unknown[] = [];
	let pendingImages: Array<{ mime: string; base64: string }> = [];
	const flushImages = () => {
		if (!pendingImages.length) return;
		out.push({
			role: 'user',
			content: [{ type: 'input_text', text: '[Screenshots returned by the tool calls above]' }, ...pendingImages.map((img) => ({ type: 'input_image', detail: 'auto', image_url: `data:${img.mime};base64,${img.base64}` }))]
		});
		pendingImages = [];
	};
	for (const m of messages) {
		if (m.role !== 'tool') flushImages();
		if (m.role === 'user') {
			const content: unknown[] = [{ type: 'input_text', text: m.content || ' ' }];
			for (const img of m.images ?? []) content.push({ type: 'input_image', detail: 'auto', image_url: `data:${img.mime};base64,${img.base64}` });
			out.push({ role: 'user', content });
		} else if (m.role === 'assistant') {
			const retained = nativeItems(m, options, 'responses');
			if (retained) { out.push(...retained); continue; }
			if (m.content.trim()) out.push({ role: 'assistant', content: m.content });
			for (const c of m.toolCalls ?? []) {
				if (!m.native && c.signature?.startsWith(REASONING_TAG)) {
					try {
						out.push(JSON.parse(c.signature));
					} catch {
						/* a damaged reasoning item is just dropped */
					}
				}
				out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments || '{}', ...(chatgptPlan ? { namespace: c.namespace ?? PLAN_NAMESPACE } : {}) });
			}
		} else {
			out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content || '(empty)' });
			pendingImages.push(...(m.images ?? []));
		}
	}
	flushImages();
	return out;
}

/** The request body (pure; tested). */
export function codexBody(options: StreamOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: options.model,
		instructions: options.system || 'You are a helpful coding assistant.',
		input: toResponsesInput(options.messages, !!options.chatgptPlan, options),
		store: false,
		stream: true,
		include: ['reasoning.encrypted_content'],
		tool_choice: 'auto',
		parallel_tool_calls: true,
		reasoning: { summary: 'auto' }
	};
	if (options.tools?.length) {
		const tools = options.tools.map((t) => ({ type: 'function', ...functionTool(t, options.strictTools) }));
		body.tools = options.chatgptPlan ? [{ type: 'namespace', name: PLAN_NAMESPACE, description: 'Local project tools provided by zer0ne Code.', tools }] : tools;
	}
	if (options.cacheKey) body.prompt_cache_key = options.cacheKey.slice(0, 64);
	if (options.apiFormat === 'responses') {
		delete body.reasoning;
		if (!options.chatgptPlan && new URL(options.baseUrl).hostname !== 'api.openai.com') delete body.include;
		delete body.parallel_tool_calls;
		if (!options.tools?.length) delete body.tool_choice;
		if (options.maxTokens && !options.chatgptPlan) body.max_output_tokens = options.maxTokens;
	}
	const hints = reasoningHints({ ...options, reasoningControl: options.reasoningControl?.protocol === 'openai' ? { ...options.reasoningControl, protocol: 'responses' } : options.reasoningControl, effort: options.apiFormat === 'codex' && options.effort === 'minimal' ? 'low' : options.effort });
	if (options.promptCache) {
		if (new URL(options.baseUrl).hostname !== 'api.openai.com' || !/^gpt-(?:5\.6(?:-|$)|6(?:\.|-))/i.test(options.model) || options.chatgptPlan) throw new Error('This endpoint/model does not support the requested OpenAI cache controls. Use its default cache profile.');
		body.prompt_cache_options = { mode: options.promptCache.mode ?? 'implicit', ttl: options.promptCache.ttl ?? '30m' };
		if (options.promptCache.mode === 'explicit') {
			delete body.instructions;
			(body.input as unknown[]).unshift({ role: 'developer', content: [{ type: 'input_text', text: options.system || 'You are a helpful coding assistant.', prompt_cache_breakpoint: { mode: 'explicit', ttl: options.promptCache.ttl ?? '30m' } }] });
		}
	}
	if (hints.reasoning) body.reasoning = { ...(body.reasoning as Record<string, unknown> ?? {}), ...(hints.reasoning as Record<string, unknown>) };
	return body;
}

export async function streamCodex(options: StreamOptions): Promise<StreamResult> {
	const codex = options.apiFormat === 'codex';
	const accountId = codex ? chatgptAccountId(options.apiKey) : undefined;
	if (codex && !accountId) throw new Error('Sign in with ChatGPT again (Providers & models) — the saved session has no ChatGPT workspace.');
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.apiKey}`,
		...(accountId ? { 'chatgpt-account-id': accountId, 'OpenAI-Beta': 'responses=experimental', originator: 'zer0ne' } : {}),
		Accept: 'text/event-stream',
		'User-Agent': `zer0ne-coding (${process.platform}; ${process.arch})`,
		...opencodeSessionHeaders(options.baseUrl, options.cacheKey)
	};
	if (codex && options.cacheKey) headers.session_id = options.cacheKey.slice(0, 64);
	const response = await post(responsesUrl(options.baseUrl, codex), headers, codexBody(options), options.signal, options.model, options.requestTrace);

	let text = '';
	let reasoning = '';
	const guard = new ResponseTextGuard();
	let usage: StreamResult['usage'];
	let stopReason: string | undefined;
	let terminal = false;
	// Items by output index: function calls collect their arguments here.
	const calls = new Map<number, ToolCall & { done?: boolean }>();
	const outputItems = new Map<number, Record<string, any>>();
	let pendingReasoning: string | undefined;
	const emitCall = (i: number) => {
		const c = calls.get(i);
		if (!c || c.done || !c.name) return;
		if (options.chatgptPlan && c.namespace !== PLAN_NAMESPACE) throw new Error('ChatGPT returned a tool outside the zer0ne namespace.');
		try {
			JSON.parse(c.arguments || '{}');
		} catch {
			return;
		}
		c.done = true;
		options.onToolCall?.({ id: c.id, name: c.name, arguments: c.arguments || '{}', ...(options.chatgptPlan && c.namespace ? { namespace: c.namespace } : {}) });
	};
	const handle = (ev: any) => {
		options.requestTrace?.event();
		switch (ev.type) {
			case 'response.output_text.delta':
				if (typeof ev.delta === 'string') {
					text += ev.delta;
					guard.add(ev.delta);
					options.onText?.(ev.delta);
				}
				break;
			case 'response.reasoning_summary_text.delta':
			case 'response.reasoning_text.delta':
				if (typeof ev.delta === 'string') {
					reasoning += ev.delta;
					guard.add(ev.delta);
					options.onReasoning?.(ev.delta);
				}
				break;
			case 'response.reasoning_summary_part.done':
				reasoning += '\n\n';
				break;
			case 'response.output_item.added': {
				const item = ev.item ?? {};
				if (item.type === 'function_call') {
					calls.set(ev.output_index ?? calls.size, { id: String(item.call_id || item.id || `call_${Date.now().toString(36)}`), name: String(item.name || ''), arguments: String(item.arguments || ''), ...(options.chatgptPlan ? { namespace: typeof item.namespace === 'string' ? item.namespace : PLAN_NAMESPACE } : {}) });
				}
				break;
			}
			case 'response.function_call_arguments.delta': {
				const c = calls.get(ev.output_index);
				if (c && typeof ev.delta === 'string') c.arguments += ev.delta;
				break;
			}
			case 'response.function_call_arguments.done': {
				const c = calls.get(ev.output_index);
				if (c && typeof ev.arguments === 'string') c.arguments = ev.arguments;
				emitCall(ev.output_index);
				break;
			}
			case 'response.output_item.done': {
				const item = ev.item ?? {};
				if (typeof item.type === 'string') outputItems.set(ev.output_index ?? outputItems.size, item);
				if (item.type === 'reasoning' && item.encrypted_content) {
					pendingReasoning = JSON.stringify({ type: 'reasoning', id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content });
				} else if (item.type === 'function_call') {
					const idx = ev.output_index ?? calls.size;
					const c = calls.get(idx) ?? { id: '', name: '', arguments: '' };
					calls.set(idx, { ...c, id: String(item.call_id || c.id), name: String(item.name || c.name), arguments: typeof item.arguments === 'string' ? item.arguments : c.arguments, ...(options.chatgptPlan ? { namespace: typeof item.namespace === 'string' ? item.namespace : c.namespace ?? PLAN_NAMESPACE } : {}) });
					emitCall(idx);
				} else if (item.type === 'message' && !text && Array.isArray(item.content)) {
					// Some responses skip the deltas and deliver the text whole.
						for (const part of item.content) if (part?.type === 'output_text' && part.text) {
							text += part.text;
							guard.add(part.text);
							options.onText?.(part.text);
						}

				}
				break;
			}
			case 'response.completed':
			case 'response.incomplete': {
				const r = ev.response ?? {};
				if (Array.isArray(r.output)) r.output.forEach((item: Record<string, any>, index: number) => outputItems.set(index, item));
				terminal = true;
				const u = r.usage;
				if (u) { usage = openaiUsage(u, usage); options.requestTrace?.usage(usage); }
				stopReason = ev.type === 'response.incomplete' ? (r.incomplete_details?.reason === 'max_output_tokens' ? 'length' : r.incomplete_details?.reason ?? 'incomplete') : 'stop';
				if (options.chatgptPlan && (ev.type === 'response.incomplete' || (r.status && r.status !== 'completed'))) throw new Error(`ChatGPT did not complete the response (${r.incomplete_details?.reason ?? r.status ?? 'incomplete'}).`);
				break;
			}
			case 'response.failed':
				throw new Error(`${codex || options.chatgptPlan ? 'ChatGPT' : 'Provider'}: ${ev.response?.error?.message ?? 'the request failed'}`);
			case 'error':
				throw new Error(`${codex || options.chatgptPlan ? 'ChatGPT' : 'Provider'}: ${ev.message ?? ev.error?.message ?? 'error'}${/usage|limit/i.test(String(ev.message ?? ev.code ?? '')) ? ' — your plan\'s usage limit may be reached.' : ''}`);
		}
	};
	await readSse(response, (payload) => {
		const json = parseJson(payload);
		if (json) handle(json);
	});
	if (options.chatgptPlan && !terminal) throw new Error('ChatGPT response stream ended before response.completed. The answer is incomplete; try again.');
	const toolCalls: ToolCall[] = [...calls.entries()]
		.sort((a, b) => a[0] - b[0])
		.filter(([, c]) => c.name)
		.map(([, c]) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}', ...(options.chatgptPlan && c.namespace ? { namespace: c.namespace } : {}) }));
	if (toolCalls.length && pendingReasoning) toolCalls[0].signature = pendingReasoning;
	if (toolCalls.length && stopReason === 'stop') stopReason = 'tool_calls';
	return { text, reasoning: reasoning.trim(), toolCalls, usage, stopReason, native: continuation(options, 'responses', [...outputItems].sort(([a], [b]) => a - b).map(([, item]) => item), text, usage?.output) };
}
