import type { AgentSettings, ModelEntry, ProviderConfig, ProviderStore } from '../providerStore';

/**
 * Hybrid routing (Settings → Local models → Overview): cheap, frequent helper
 * work (compaction summaries, text tools, optionally subagents) runs on a
 * local model, and the same model takes over when the chosen cloud model
 * cannot be reached. Pure helpers plus one store lookup; no vscode.
 */

export type HelperTask = 'compaction' | 'text' | 'subagents';

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;

/** Runs on this computer: zer0ne Engine, Ollama, LM Studio or any server on localhost (pure; tested). */
export function isLocalProvider(p: Pick<ProviderConfig, 'baseUrl' | 'preset' | 'apiFormat'>): boolean {
	if (p.apiFormat === 'acp' || p.apiFormat === 'vscode-lm') return false;
	return p.preset === 'zer0ne-engine' || LOCAL_URL.test(p.baseUrl ?? '');
}

/** Above this window a local model is workstation-class (vLLM, a 70B on big GPUs): it gets the full agent. */
export const LEAN_MAX_WINDOW = 65_536;

/**
 * Lean agent or full agent (pure; tested). Automatic: a local model with a
 * small or unknown context window gets the lean prompt and core tools; a
 * local model with a large window, and every cloud model, get everything.
 */
export function wantsLean(s: Pick<AgentSettings, 'localTuned'> & Partial<Pick<AgentSettings, 'toolProfile'>>, provider: Pick<ProviderConfig, 'baseUrl' | 'preset' | 'apiFormat'>, model: Pick<ModelEntry, 'contextWindow' | 'agentProfile'>): boolean {
	if (s.toolProfile === 'lean') return true;
	if (s.toolProfile === 'full') return false;
	const measured = model.agentProfile;
	if (measured && measured.contextWindow === model.contextWindow && measured.trials >= 3 && measured.total >= 6 && measured.passed / measured.total >= 0.9 && Date.now() - measured.at < 30 * 86400_000) return measured.tools === 'lean';
	return s.localTuned !== false && isLocalProvider(provider) && !((model.contextWindow ?? 0) > LEAN_MAX_WINDOW);
}

/** The request never reached the provider: offline, DNS, refused, reset (pure; tested). */
export const OFFLINE_ERROR = /Could not reach|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network ?error|socket hang up|UND_ERR_CONNECT|Connect Timeout/i;

/** Which helper tasks the setting routes (pure; tested). */
export function helperTasks(s: Pick<AgentSettings, 'localHelperTasks'>): Set<HelperTask> {
	return new Set(String(s.localHelperTasks || '').split(',').map((t) => t.trim()).filter((t): t is HelperTask => t === 'compaction' || t === 'text' || t === 'subagents'));
}

export interface Routed {
	provider: ProviderConfig;
	model: ModelEntry;
	apiKey: string;
}

/** The configured local helper model, when it exists and is enabled (task = only when that task is routed). */
export async function localHelper(store: ProviderStore, task?: HelperTask): Promise<Routed | undefined> {
	const s = store.getSettings();
	if (!s.localHelper || (task && !helperTasks(s).has(task))) return undefined;
	const [pid, mid] = s.localHelper.split('::');
	const provider = (await store.list()).find((p) => p.id === pid && p.enabled);
	const model = provider?.models.find((m) => m.id === mid);
	if (!provider || !isLocalProvider(provider) || !model || model.enabled === false || (task === 'subagents' && model.tools === false)) return undefined;
	return { provider, model, apiKey: (await store.getApiKey(provider.id)) ?? '' };
}

/** Text that must fit a small local window: keep the newest part (pure; tested). */
export function fitToWindow(text: string, model: Pick<ModelEntry, 'contextWindow'>, reserveTokens = 2500): string {
	const window = model.contextWindow ?? 8192;
	const chars = Math.max(2000, Math.floor((window - reserveTokens) * 3.2));
	return text.length > chars ? text.slice(-chars) : text;
}
