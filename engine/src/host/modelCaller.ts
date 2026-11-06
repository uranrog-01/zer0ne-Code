import type { StreamOptions, StreamResult } from '../chatClient';
import { Breaker, RETRYABLE, withRetry } from '../core/turn';
import type { AgentSettings, ModelEntry, ProviderConfig, ProviderStore } from '../providerStore';
import { presetById } from '../presets';
import { OFFLINE_ERROR, isLocalProvider, localHelper } from './localRouting';

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';
/** A problem with this key rather than the request: the next key of a pool may work. */
export const KEY_PROBLEM = /\b(401|402|403|429)\b|rate.?limit|quota|insufficient|billing|credit|too many requests|invalid.{0,12}key|authentication failed/i;

export interface ModelCallerDeps {
	store: ProviderStore;
	status(message: string, kind?: 'ok' | 'error' | ''): void;
	callModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>): Promise<StreamResult>;
}

/**
 * The same vendor reached the other way: a subscription's API-key twin
 * (ChatGPT → OpenAI key, Kimi Code → Kimi Code key, MiniMax → its plan key…)
 * or the subscription behind a key. Pure; tested.
 */
export function twinProvider(active: ProviderConfig, modelId: string, providers: ProviderConfig[]): { provider: ProviderConfig; model: ModelEntry } | undefined {
	const mine = active.preset ? presetById(active.preset) : undefined;
	for (const p of providers) {
		if (p.id === active.id || !p.enabled || !p.preset) continue;
		const theirs = presetById(p.preset);
		const linked = (mine?.keyPreset && mine.keyPreset === p.preset) || (theirs?.keyPreset && theirs.keyPreset === active.preset);
		const model = linked ? p.models.find((m) => m.id === modelId && m.enabled !== false) : undefined;
		if (model) return { provider: p, model };
	}
	return undefined;
}

/**
 * Calls the chat model with retries (rate limits, overload, network — the
 * provider's Retry-After first), then the configured fallback models in order,
 * with a circuit breaker so a model that keeps failing is skipped for a while.
 * Never retries once text has streamed (no duplicated output).
 */
export class ModelCaller {
	/** provider::model skipped for a while after failing its retries. */
	private readonly breaker: Breaker;

	constructor(private readonly d: ModelCallerDeps, breakerMs: number) {
		this.breaker = new Breaker(breakerMs);
	}

	async callResilient(
		active: { provider: ProviderConfig; model: ModelEntry; apiKey: string },
		settings: AgentSettings,
		signal: AbortSignal,
		streamed: { text: string; reasoning: string },
		build: (base: { model: string }) => Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>
	): Promise<StreamResult> {
		const fallbacks = settings.fallbackModels
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		// Kill switch (Claude Code's CLAUDE_CODE_NO_MODEL_FALLBACK): model substitution is
		// disabled — no fallback list, no breaker switch, no offline local stand-in. Key
		// rotation and the twin provider keep running: they are the same model.
		const noFallback = settings.noModelFallback === true || process.env.ZER0NE_NO_MODEL_FALLBACK === '1';
		const key = () => `${active.provider.id}::${active.model.id}`;
		// Circuit breaker: a model that just failed its retries is skipped for a while,
		// so the next turns go straight to the fallback instead of waiting again.
		if (!noFallback && this.breaker.tripped(key())) {
			const next = await this.nextFallback([...fallbacks], active);
			if (next) {
				this.d.status(`${active.model.id} failed recently — using ${next.model.id} (${next.provider.name}) for now.`, '');
				Object.assign(active, next);
			}
		}
		let rotated = 0;
		let pool = await this.d.store.keyCount(active.provider.id);
		let twinned = false;
		let wentLocal = false;
		for (;;) {
			try {
				// Transient errors: retried with the provider's Retry-After (or a short backoff).
				const result = await withRetry(() => this.d.callModel(active.provider, active.apiKey, build({ model: active.model.id })), {
					signal,
					retries: settings.retryErrors ? 2 : 0,
					// With keys left in the pool, a rate limit moves to the next key at once.
					skip: rotated < pool - 1 ? KEY_PROBLEM : undefined,
					backoff: [1500, 4000],
					streamed: () => !!(streamed.text.trim() || streamed.reasoning.trim()),
					onRetry: (message, wait) => this.d.status(`${active.model.id}: ${message.slice(0, 80)} — retrying in ${Math.round(wait / 100) / 10}s…`, '')
				});
				this.breaker.reset(key());
				return result;
			} catch (error) {
				if ((error as Error)?.name === 'TaskBudgetError') throw error;
				const message = error instanceof Error ? error.message : String(error);
				const nothingStreamed = !streamed.text.trim() && !streamed.reasoning.trim();
				// Key pool: a rate-limited, exhausted or rejected key hands over to the next one (each key once per call).
				if (!signal.aborted && !isAbort(error) && nothingStreamed && KEY_PROBLEM.test(message) && rotated < (await this.d.store.keyCount(active.provider.id)) - 1 && (await this.d.store.rotateKey(active.provider.id))) {
					rotated++;
					active.apiKey = (await this.d.store.getApiKey(active.provider.id)) ?? active.apiKey;
					this.d.status(`${active.provider.name}: key ${rotated} hit a limit — trying the next key in the pool.`, '');
					continue;
				}
				// Subscription and API key work together: a plan out of quota (or a key out of credit)
				// continues on the same vendor's other connection, same model, before any fallback.
				if (!twinned && !signal.aborted && !isAbort(error) && nothingStreamed && KEY_PROBLEM.test(message)) {
					const twin = twinProvider(active.provider, active.model.id, await this.d.store.list());
					if (twin) {
						twinned = true;
						const from = active.provider.name;
						Object.assign(active, { ...twin, apiKey: (await this.d.store.getApiKey(twin.provider.id)) ?? '' });
						this.d.status(`${from} hit its limit (${message.slice(0, 60)}) — continuing with ${active.model.id} on ${active.provider.name}.`, '');
						rotated = 0;
						pool = await this.d.store.keyCount(active.provider.id);
						continue;
					}
				}
				// Hybrid routing: the cloud model is unreachable (offline, DNS, refused) — the local helper model carries on.
				if (!noFallback && !wentLocal && settings.offlineFallback && !signal.aborted && !isAbort(error) && nothingStreamed && OFFLINE_ERROR.test(message) && !isLocalProvider(active.provider)) {
					const local = await localHelper(this.d.store);
					if (local) {
						wentLocal = true;
						const from = active.model.id;
						Object.assign(active, local);
						this.d.status(`${from} is unreachable (${message.slice(0, 50)}) — continuing offline on ${local.model.id} (${local.provider.name}).`, '');
						rotated = 0;
						pool = await this.d.store.keyCount(active.provider.id);
						continue;
					}
				}
				if (signal.aborted || isAbort(error) || streamed.text.trim() || streamed.reasoning.trim() || !settings.retryErrors || !RETRYABLE.test(message)) {
					throw error;
				}
				this.breaker.trip(key());
				const next = noFallback ? undefined : await this.nextFallback(fallbacks, active);
				if (!next) {
					throw error;
				}
				this.d.status(`${active.model.id} keeps failing (${message.slice(0, 60)}) — continuing with ${next.model.id} (${next.provider.name}).`, 'error');
				Object.assign(active, next);
				rotated = 0;
				pool = await this.d.store.keyCount(active.provider.id);
			}
		}
	}

	private async nextFallback(fallbacks: string[], active: { provider: ProviderConfig; model: ModelEntry }): Promise<{ provider: ProviderConfig; model: ModelEntry; apiKey: string } | undefined> {
		const providers = await this.d.store.list();
		while (fallbacks.length) {
			const [pid, mid] = fallbacks.shift()!.split('::');
			const provider = providers.find((p) => p.id === pid && p.enabled);
			const model = provider?.models.find((m) => m.id === mid);
			if (provider && model && !(provider.id === active.provider.id && model.id === active.model.id)) {
				return { provider, model, apiKey: (await this.d.store.getApiKey(provider.id)) ?? '' };
			}
		}
		return undefined;
	}
}
