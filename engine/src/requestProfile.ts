import type { StreamOptions } from './chatClient';
import { reasoningControl, reasoningHints, type ReasoningEffort } from './reasoning';
import { modelApiFormat } from './chatClient';
import type { AgentSettings, ModelEntry, ProviderConfig } from './providerStore';

export type RequestProfile = Pick<StreamOptions, 'effort' | 'reasoningControl' | 'cacheTtl' | 'cacheKey' | 'promptCache' | 'strictTools' | 'maxTokens'>;

export function requestProfileFor(settings: Partial<AgentSettings>, provider: ProviderConfig, model: ModelEntry, effort?: ReasoningEffort): RequestProfile {
	const apiFormat = modelApiFormat({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: model.id });
	const control = reasoningControl({ apiFormat, baseUrl: provider.baseUrl, model: model.id, advertised: model.reasoningControl });
	let official = false;
	try { official = new URL(provider.baseUrl).hostname === 'api.openai.com'; } catch { /* Region-based providers have no URL. */ }
	return { effort, reasoningControl: control, cacheTtl: settings.cacheTtl ?? '5m',
		strictTools: settings.strictTools === 'on' ? true : settings.strictTools === 'off' ? false : undefined,
		promptCache: official && apiFormat === 'responses' && /^gpt-(?:5\.6(?:-|$)|6(?:\.|-))/.test(model.id) && settings.openaiCache !== undefined && settings.openaiCache !== 'provider'
			? { mode: settings.openaiCache === 'explicit' ? 'explicit' : 'implicit', ttl: settings.openaiCacheTtl ?? '30m' } : undefined };
}

/** Legacy thinking budgets must remain below max_tokens even on a summary/cache replay. */
export function replayOutputLimit(options: Pick<StreamOptions, 'model' | 'baseUrl' | 'apiFormat'> & RequestProfile, minimum: number): number {
	const thinking = reasoningHints(options).thinking as { budget_tokens?: number } | undefined;
	return Math.max(minimum, (thinking?.budget_tokens ?? 0) + 1024);
}
