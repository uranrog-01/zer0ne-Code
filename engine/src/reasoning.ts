export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'maximum';
export type ReasoningProtocol = 'none' | 'openai' | 'responses' | 'openrouter' | 'anthropic-effort' | 'anthropic-budget' | 'gemini-level' | 'gemini-budget' | 'llama-budget' | 'llama-effort' | 'agent';
export interface ReasoningControl {
	levels: ReasoningEffort[];
	note: string;
	protocol: ReasoningProtocol;
	configId?: string;
	defaultValue?: string;
	choices?: Array<{ effort: ReasoningEffort; value: string; name?: string; model?: boolean }>;
}
const basic: ReasoningEffort[] = ['low', 'medium', 'high'];
const all: ReasoningEffort[] = ['none', 'minimal', ...basic, 'xhigh', 'maximum'];
const control = (protocol: ReasoningProtocol, levels: ReasoningEffort[], note: string): ReasoningControl => ({ protocol, levels, note });
const unavailable = (note = 'This model or server does not advertise an adjustable reasoning level. Auto uses its default behavior.') => control('none', [], note);
/** Catalog/agent metadata crosses persisted settings; retain valid controls without accepting arbitrary request fields. */
export function normalizeReasoningControl(raw: unknown): ReasoningControl | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const c = raw as Partial<ReasoningControl>;
	if (!['none', 'openai', 'responses', 'openrouter', 'anthropic-effort', 'anthropic-budget', 'gemini-level', 'gemini-budget', 'llama-budget', 'llama-effort', 'agent'].includes(c.protocol ?? '') || !Array.isArray(c.levels)) return undefined;
	const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit ? value : undefined;
	const levels = [...new Set(c.levels.filter(l => all.includes(l)))];
	const choices = Array.isArray(c.choices) ? c.choices.slice(0, 512).flatMap(choice => {
		if (!choice || !levels.includes(choice.effort) || !text(choice.value, 1024)) return [];
		return [{ effort: choice.effort, value: choice.value, ...(text(choice.name, 120) ? { name: choice.name } : {}), ...(choice.model === true ? { model: true } : {}) }];
	}) : undefined;
	return { protocol: c.protocol!, levels, note: text(c.note, 800) ?? 'Uses the supported reasoning controls reported by this provider.', ...(text(c.configId, 128) ? { configId: c.configId } : {}), ...(text(c.defaultValue, 1024) ? { defaultValue: c.defaultValue } : {}), ...(choices ? { choices } : {}) };
}
function host(base: string): string { try { return new URL(base).hostname; } catch { return ''; } }

/** Model capability is distinct from reasoning support: a model can think without exposing an effort knob. */
export function reasoningControl(o: { apiFormat: string; baseUrl: string; model: string; advertised?: ReasoningControl; localEngine?: boolean; reasoning?: boolean }): ReasoningControl {
	if (o.advertised) return o.advertised;
	if (o.apiFormat === 'acp') return o.advertised ?? unavailable('This agent has not advertised a reasoning selector. Auto follows the agent; fetch models after signing in to discover its controls.');
	const id = o.model.toLowerCase().replace(/_/g, '-');
	if (o.localEngine) {
		if (/gpt-oss/.test(id)) return control('llama-effort', basic, 'The local GPT-OSS chat template receives the selected reasoning effort.');
		if (/qwen3|qwq|deepseek.*r1|gemma-?4/.test(id)) return control('llama-budget', ['none', ...basic, 'xhigh'], 'The local engine applies a thinking token budget. The model template must support thinking; a budget is a ceiling, not a speed guarantee.');
		return unavailable('Auto uses this local model’s chat template. This model has no confirmed thinking-budget control.');
	}
	if (o.apiFormat === 'gemini' || (o.apiFormat === 'vertex' && /gemini/.test(id))) {
		if (/gemini-3(?:\.|-)/.test(id)) {
			const levels: ReasoningEffort[] = /flash-lite-image/.test(id) ? ['minimal', 'high'] : /3\.[78]-flash|pro/.test(id) ? basic : ['minimal', ...basic];
			return control('gemini-level', levels, 'Uses Gemini thinkingLevel. Auto keeps the model default; thinking cannot be fully disabled on Gemini 3.');
		}
		if (/gemini-2\.5-(pro|flash)/.test(id)) return control('gemini-budget', /-pro/.test(id) ? ['minimal', ...basic, 'xhigh'] : ['none', 'minimal', ...basic, 'xhigh'], 'Uses a Gemini 2.5 thinking token budget within this model’s supported range.');
		return unavailable();
	}
	if (o.apiFormat === 'anthropic' || o.apiFormat === 'bedrock' || (o.apiFormat === 'vertex' && /claude/.test(id))) {
		if (/claude-(?:opus-(?:4-[5-8]|5(?:-|$))|sonnet-(?:4-6|5(?:-|$))|haiku-5-5|(?:fable|mythos)-(?:5|preview))/.test(id)) {
			const xhigh = /(?:opus-4-[78]|opus-5|sonnet-5|haiku-5-5|(?:fable|mythos)-5)/.test(id);
			const maximum = !/opus-4-5/.test(id);
			return control('anthropic-effort', [...basic, ...(xhigh ? ['xhigh' as const] : []), ...(maximum ? ['maximum' as const] : [])], 'Uses Claude output_config.effort and adaptive thinking where supported. Higher levels can increase latency and output-token cost.');
		}
		if (/claude-(?:3-7-sonnet|(?:sonnet|opus|haiku)-4(?:-|$))/.test(id)) return control('anthropic-budget', ['none', ...basic], 'Uses Claude extended-thinking budget_tokens, bounded by the response token limit.');
		return unavailable();
	}
	if (!['openai', 'responses', 'codex'].includes(o.apiFormat)) return unavailable();
	if (host(o.baseUrl) === 'openrouter.ai') return unavailable('Fetch models to read OpenRouter’s exact supported efforts. Auto uses the selected model’s default.');
	if (host(o.baseUrl) === 'api.deepseek.com' && /deepseek/.test(id)) return control(o.apiFormat === 'responses' ? 'responses' : 'openai', ['none', 'low', 'high', 'maximum'], 'Uses DeepSeek’s documented thinking toggle and low, high or max effort.');
	const protocol = o.apiFormat === 'openai' ? 'openai' : 'responses';
	if (/gpt-oss|(?:^|\/)o[134](?:-|$)/.test(id)) return control(protocol, basic, 'Uses the model’s supported reasoning effort; Auto sends no override.');
	if (/gpt-5(?:-(?:mini|nano)|$|-(?:20\d{2}))/.test(id)) return control(protocol, ['minimal', ...basic], 'Uses GPT-5 reasoning effort; this model does not support fully disabling reasoning.');
	if (/gpt-5\.1/.test(id)) return control(protocol, ['none', ...basic], 'Uses GPT-5.1 reasoning effort.');
	if (/gpt-(?:5\.[2-6]|6(?:\.|-))/.test(id)) return control(protocol, [...(!/astra|6\.1-sol|-pro/.test(id) ? ['none' as const] : []), ...basic, 'xhigh', ...(/gpt-(?:5\.6|6(?:\.|-))/.test(id) ? ['maximum' as const] : [])], 'Uses the model’s documented reasoning effort. Auto keeps its default; provider and account limits still apply.');
	return unavailable();
}

/** Authoritative provider metadata overrides family defaults, including mandatory reasoning. */
export function advertisedReasoning(model: Record<string, any>, apiFormat: string, baseUrl: string): ReasoningControl | undefined {
	const gateway = host(baseUrl) === 'openrouter.ai';
	const values = gateway ? model.reasoning?.supported_efforts : model.supported_reasoning_efforts;
	if (!Array.isArray(values) && !(gateway && values === null)) return undefined;
	const levels: ReasoningEffort[] = values === null ? all : [...new Set<ReasoningEffort>((values as unknown[]).flatMap<ReasoningEffort>(v => typeof v === 'string' && (v === 'max' || all.includes(v as ReasoningEffort)) ? [v === 'max' ? 'maximum' : v as ReasoningEffort] : []))];
	return control(gateway ? 'openrouter' : apiFormat === 'responses' || apiFormat === 'codex' ? 'responses' : 'openai', model.reasoning?.mandatory ? levels.filter(l => l !== 'none') : levels, 'Uses the exact reasoning levels returned by this provider’s model catalog. Auto preserves the provider default.');
}

export function selectedEffort(o: { effort?: ReasoningEffort; reasoningControl?: ReasoningControl; apiFormat: string; baseUrl: string; model: string }): { effort: ReasoningEffort; control: ReasoningControl } | undefined {
	if (!o.effort) return undefined;
	const c = o.reasoningControl ?? reasoningControl(o);
	return c.levels.includes(o.effort) ? { effort: o.effort, control: c } : undefined;
}

/** Protocol-specific request hints; unknown capabilities receive no invented wire fields. */
export function reasoningHints(o: { effort?: ReasoningEffort; reasoningControl?: ReasoningControl; apiFormat: string; baseUrl: string; model: string; maxTokens?: number }): Record<string, unknown> {
	const selected = selectedEffort(o);
	if (!selected) return {};
	const { effort, control: c } = selected;
	const wire = effort === 'maximum' ? 'max' : effort;
	if (c.protocol === 'openrouter') return { reasoning: { effort: wire } };
	if (c.protocol === 'openai') {
		if (host(o.baseUrl) === 'api.deepseek.com') return effort === 'none' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: wire };
		return { reasoning_effort: wire };
	}
	if (c.protocol === 'responses') return { reasoning: { effort: wire } };
	if (c.protocol === 'anthropic-effort') {
		if (/opus-4-5/.test(o.model)) {
			const budget = Math.min(({ low: 1024, medium: 4096, high: 8192 } as Record<string, number>)[effort] ?? 1024, (o.maxTokens ?? 8192) - 1024);
			return { output_config: { effort: wire }, ...(budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}) };
		}
		return { output_config: { effort: wire }, thinking: { type: 'adaptive' } };
	}
	if (c.protocol === 'anthropic-budget') {
		if (effort === 'none') return { thinking: { type: 'disabled' } };
		const budget = Math.min(({ low: 1024, medium: 4096, high: 8192 } as Record<string, number>)[effort] ?? 1024, (o.maxTokens ?? 8192) - 1024);
		return budget >= 1024 ? { thinking: { type: 'enabled', budget_tokens: budget } } : {};
	}
	if (c.protocol === 'gemini-level') return { thinkingLevel: wire };
	if (c.protocol === 'gemini-budget') return { thinkingBudget: Math.min(({ none: 0, minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768 } as Record<string, number>)[effort], /-pro/.test(o.model) ? 32768 : 24576) };
	if (c.protocol === 'llama-effort') return { reasoning_effort: wire };
	if (c.protocol === 'llama-budget') return { reasoning_budget_tokens: ({ none: 0, low: 1024, medium: 4096, high: 8192, xhigh: 16384 } as Record<string, number>)[effort], ...(effort === 'none' ? { reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } } : {}) };
	return {};
}
