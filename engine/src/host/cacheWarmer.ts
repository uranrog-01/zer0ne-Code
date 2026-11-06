/*
 * Idle cache warmer (pi): Anthropic keeps a prompt cache for 5 minutes (or an
 * hour). While the user reads the answer, one tiny request just before it
 * expires keeps the whole conversation cached — only when the avoided write
 * premium is at least $0.05, at most three times, never during a run.
 *
 * The warmer owns its timer, so the controller only schedules the turn's last
 * request and cancels it when the chat or the run it belongs to goes away.
 */
import type { StreamOptions, StreamResult, ToolDef } from '../chatClient';
import type { ModelEntry, ProviderConfig, ProviderStore } from '../providerStore';
import { repairToolPairs, type Transcript } from '../transcript';
import { cacheWarmValue } from '../tools/tokenSaver';
import { replayOutputLimit, type RequestProfile } from '../requestProfile';

/** The last model request of a finished turn — what the warmer replays. */
export interface WarmRequest extends RequestProfile {
	rootTaskId?: string;
	sessionId: string;
	turnId?: string;
	provider: ProviderConfig;
	model: ModelEntry;
	system: string;
	tools?: ToolDef[];
	promptTokens: number;
}

export interface WarmerHost {
	store: ProviderStore;
	currentSessionId(): string;
	/** True while a run is in flight — the warmer stays off then. */
	busy(): boolean;
	loadTranscript(sessionId: string): Transcript | undefined;
	callModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>): Promise<StreamResult>;
	/** A ping landed: report it on the context card. */
	warmed(info: { count: number; cachedTokens: number }): void;
	stateChanged(): void;
}

export class CacheWarmer {
	private warm?: { timer: NodeJS.Timeout; sessionId: string; count: number; stop: AbortController };
	private request?: WarmRequest;

	constructor(private readonly h: WarmerHost) {}

	/** Replaces any pending ping. Pass the turn's last request (undefined: nothing ran). */
	schedule(r: WarmRequest | undefined): void {
		this.cancel();
		const s = this.h.store.getSettings();
		if (!r || !s.cacheWarm || r.provider.apiFormat !== 'anthropic' || !cacheWarmValue(r.promptTokens, r.model.priceIn).worth) {
			return;
		}
		// A legacy thinking budget cannot be replayed with a one-token cheap ping.
		if (replayOutputLimit({ ...r, model: r.model.id, baseUrl: r.provider.baseUrl, apiFormat: r.provider.apiFormat }, 1) > 1024) return;
		this.request = r;
		const long = s.cacheTtl === '1h' && /anthropic\.com/i.test(r.provider.baseUrl);
		const every = long ? 55 * 60_000 : 270_000;
		const max = long ? 1 : 3;
		const stop = new AbortController();
		const current = () => this.warm?.stop === stop && !stop.signal.aborted;
		const cancel = () => { if (current()) this.cancel(); };
		const fire = async () => {
			if (!current()) return;
			const w = this.warm;
			if (!w || this.h.busy() || w.sessionId !== this.h.currentSessionId() || this.request !== r) {
				return cancel();
			}
			const transcript = this.h.loadTranscript(r.sessionId);
			if (!transcript?.entries.length) {
				return cancel();
			}
			try {
				const key = (await this.h.store.getApiKey(r.provider.id)) ?? '';
				if (!current()) return;
				if (this.h.busy() || w.sessionId !== this.h.currentSessionId()) return cancel();
				const res = await this.h.callModel(r.provider, key, {
					effort: r.effort, reasoningControl: r.reasoningControl, cacheKey: r.cacheKey, promptCache: r.promptCache, strictTools: r.strictTools,
					requestContext: { sessionId: r.sessionId, parentTurnId: r.turnId, rootTaskId: r.rootTaskId, purpose: 'warm' },
					model: r.model.id,
					system: r.system,
					tools: r.tools,
					messages: [...repairToolPairs(transcript.entries), { role: 'user', content: '[keep-alive — reply with just: ok]' }],
					maxTokens: 1,
					cacheTtl: s.cacheTtl,
					signal: AbortSignal.any([stop.signal, AbortSignal.timeout(60_000)])
				});
				const ki = await this.h.store.keyInfoOf(r.provider.id).catch(() => undefined);
				if (!res.attempts?.length) await this.h.store.recordUsage({ t: Date.now(), sessionId: r.sessionId, providerId: r.provider.id, model: r.model.id, purpose: 'warm', tokensIn: res.usage?.input ?? 0, tokensOut: res.usage?.output ?? 0, tokensCached: res.usage?.cached, usage: res.usage, keyIndex: ki?.index, keyHint: ki?.hint });
				// A paid response is still accounted for after cancellation, but belongs only to its original schedule.
				if (!current()) return;
				if (this.h.busy() || w.sessionId !== this.h.currentSessionId()) return cancel();
				w.count++;
				this.h.warmed({ count: w.count, cachedTokens: res.usage?.cached ?? 0 });
				this.h.stateChanged();
			} catch {
				return cancel();
			}
			if (w.count < max && this.warm === w) {
				w.timer = setTimeout(() => void fire(), every);
				w.timer.unref?.();
			} else {
				cancel();
			}
		};
		const timer = setTimeout(() => void fire(), every);
		timer.unref?.();
		this.warm = { timer, sessionId: r.sessionId, count: 0, stop };
	}

	cancel(): void {
		const w = this.warm;
		this.warm = undefined;
		this.request = undefined;
		if (w) {
			clearTimeout(w.timer);
			w.stop.abort();
		}
	}
}
