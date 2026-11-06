import { createHash } from 'crypto';
import type { CacheType, ModelPlan } from './modelFit';

export interface TuneSpeed {
	tokS: number;
	/** Reading speed on the first, long prompt. */
	promptTokS: number;
	/** Seconds before the first token of a follow-up turn, the long prompt already in the cache. */
	turnS?: number;
}
/** What one measurement runs with; unset fields keep the plan's own. */
export interface TuneConfig { threads: number; ubatch: number; kv?: CacheType; flash?: boolean; cpu?: boolean }
export interface TuneResult extends TuneConfig {
	at: number;
	baseline: TuneSpeed;
	speed: TuneSpeed;
	gain: number;
	/** What was kept, in words: "plain attention", "processor only", "1 thread"… */
	kept?: string;
}

/** A profile belongs to this model, machine, runtime and cache/context configuration. */
export function tuneKey(parts: unknown[]): string {
	return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** The KV cache size relative to the 16-bit cache (llama.cpp stores 8-bit and 4-bit caches). */
const KV_RATIO: Record<CacheType, number> = { f16: 1, q8_0: 34 / 64, q4_0: 18 / 64 };

/**
 * The memory model of a plan: what it needs besides its KV cache, and the
 * cache's bytes per token with a 16-bit cache. A plan that changes its cache
 * type must be priced again — the 16-bit cache needs twice the 8-bit one.
 */
export interface KvMemory {
	baseBytes: number;
	kvBytesPerToken: number;
}

/**
 * The cache's bytes per token, estimated the way modelFit.ts does it when the
 * file does not state its own (the same formula, kept here so a plan can be
 * priced without the file).
 */
export function kvBytesPerToken(sizeBytes: number, shape?: { kvBytesPerToken?: number }): number {
	return shape?.kvBytesPerToken ?? 16384 * Math.pow(Math.max(0.5, sizeBytes * 8 / 4.85 / 1e9), 0.8);
}

/** What a plan needs besides its KV cache, and how big that cache is per token. */
export function kvMemoryOf(plan: ModelPlan, sizeBytes: number, shape?: { kvBytesPerToken?: number }): KvMemory {
	const perToken = kvBytesPerToken(sizeBytes, shape);
	return { baseBytes: plan.memoryBytes - perToken * KV_RATIO[plan.kv] * plan.context, kvBytesPerToken: perToken };
}

/**
 * Apply a stored tuning. When the tuning changed the KV cache type, the plan
 * is priced again: the 16-bit cache needs twice the memory of the 8-bit one,
 * and a plan that no longer fits must say so.
 */
export function applyTuning(plan: ModelPlan, tuned: TuneResult | undefined, cores: number, kv?: KvMemory): ModelPlan {
	if (!tuned || !Number.isInteger(tuned.threads) || tuned.threads < 1 || tuned.threads > cores || ![64, 128, 256, 512].includes(tuned.ubatch)) return plan;
	// Available RAM can shrink since the benchmark: preserve its thread choice within today's batch budget.
	const next: ModelPlan = { ...plan, threads: tuned.threads, ubatch: Math.min(plan.ubatch, tuned.ubatch) };
	if (tuned.cpu === true) return { ...next, cpu: true, cpuExpertLayers: 0 };
	// The attention mode was measured with one cache: both are applied together or not at all.
	if (tuned.flash === false && tuned.kv === 'f16') return reprice({ ...next, kv: 'f16', flash: false }, kv, plan.kv);
	if (tuned.flash === true && (tuned.kv === 'q8_0' || tuned.kv === 'q4_0')) return reprice({ ...next, kv: tuned.kv, flash: undefined }, kv, plan.kv);
	return next;
}

/** A different KV cache type changes what the plan needs: its memory and its verdict follow. */
function reprice(plan: ModelPlan, kv: KvMemory | undefined, previous: CacheType): ModelPlan {
	if (!kv || !(kv.kvBytesPerToken > 0) || plan.kv === previous) return plan;
	const memoryBytes = kv.baseBytes + kv.kvBytesPerToken * KV_RATIO[plan.kv] * plan.context;
	return { ...plan, memoryBytes, fits: memoryBytes <= plan.budgetBytes };
}

/**
 * A slice of an agent session, in seconds: one first read of a long prompt, then eight turns that
 * each wait for a file's worth of new text and write a short answer. Everything is measured with
 * the long prompt in the context, because attention cost grows with it: settings that tie on a
 * short prompt can differ by half on a long one.
 *
 * The wait of a follow-up turn is measured by itself. It is not the reading speed scaled down:
 * on an Arc 140T, plain attention read Gemma 4's first prompt twice as fast as flash attention and
 * then made every follow-up turn wait twice as long, while on Qwen models it was faster at both.
 */
const FIRST_READ = 6000, TURNS = 8, TURN_TOKENS = 512, TURN_WRITES = 128;
const turnWait = (s: TuneSpeed) => s.turnS ?? TURN_TOKENS / s.promptTokS;
const cost = (s: TuneSpeed) => FIRST_READ / s.promptTokS + TURNS * (turnWait(s) + TURN_WRITES / s.tokS);
const same = (a: TuneConfig, b: TuneConfig) => a.threads === b.threads && a.ubatch === b.ubatch && a.kv === b.kv && a.flash === b.flash && !!a.cpu === !!b.cpu;

/**
 * The settings worth measuring, the current ones first. `other` is what the machine could also run:
 * the opposite attention mode when its cache fits, and the processor alone when a graphics chip is used.
 */
export function tuneCandidates(plan: ModelPlan, other: { attention?: { kv: CacheType; flash: boolean }; cpuThreads?: number } = {}): TuneConfig[] {
	const base: TuneConfig = { threads: plan.threads, ubatch: plan.ubatch, kv: plan.kv, flash: plan.flash !== false };
	const candidates: TuneConfig[] = [
		base,
		{ ...base, threads: 1 },
		{ ...base, ubatch: Math.max(64, plan.ubatch >> 1) },
		...(other.attention ? [{ ...base, ...other.attention }] : []),
		...(other.cpuThreads ? [{ ...base, threads: other.cpuThreads, cpu: true }] : [])
	];
	return candidates.filter((c, i) => candidates.findIndex((x) => same(x, c)) === i);
}

export function tuneLabel(c: TuneConfig, base: TuneConfig): string {
	const parts = [c.cpu ? 'processor only' : '', !c.cpu && c.flash !== base.flash ? (c.flash === false ? 'plain attention' : 'flash attention') : '', c.threads !== base.threads && !c.cpu ? c.threads + (c.threads === 1 ? ' thread' : ' threads') : '', c.ubatch !== base.ubatch ? 'batch ' + c.ubatch : ''].filter(Boolean);
	return parts.join(', ') || 'automatic settings';
}

/** Up to two samples per candidate; small fluctuations keep the baseline rather than claiming a gain. */
export async function tuneModel(plan: ModelPlan, d: { start(config: TuneConfig): Promise<void>; probe(): Promise<TuneSpeed>; stage(text: string): void; signal?: AbortSignal; other?: Parameters<typeof tuneCandidates>[1] }): Promise<TuneResult> {
	const candidates = tuneCandidates(plan, d.other);
	const samples: Array<{ config: TuneConfig; speed: TuneSpeed }> = [];
	for (let i = 0; i < candidates.length; i++) {
		d.signal?.throwIfAborted();
		d.stage(`Measuring ${i ? tuneLabel(candidates[i], candidates[0]) : 'the current settings'} · ${i + 1} of ${candidates.length}…`);
		try {
			await d.start(candidates[i]);
			const began = Date.now();
			const a = await d.probe();
			// A slow model has already shown its speed: a second long read would only double the wait.
			const b = Date.now() - began < 20_000 ? await d.probe() : a;
			if (![a.tokS, a.promptTokS, b.tokS, b.promptTokS].every((v) => Number.isFinite(v) && v > 0)) throw new Error('The engine did not return reliable timings.');
			const turns = [a.turnS, b.turnS].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
			samples.push({ config: candidates[i], speed: { tokS: (a.tokS + b.tokS) / 2, promptTokS: (a.promptTokS + b.promptTokS) / 2, ...(turns.length ? { turnS: turns.reduce((n, v) => n + v, 0) / turns.length } : {}) } });
		} catch (e) {
			if (!i || d.signal?.aborted) throw e;
			// Unsupported settings are skipped; the caller restores the baseline on cancellation or failure.
		}
	}
	const baseline = samples[0];
	const best = samples.reduce((a, b) => cost(b.speed) < cost(a.speed) ? b : a);
	const measuredGain = cost(baseline.speed) / cost(best.speed);
	// Faster overall is not enough: nothing a person waits for may get clearly worse.
	const selected = measuredGain >= 1.08 && best.speed.tokS >= baseline.speed.tokS * 0.95 && best.speed.promptTokS >= baseline.speed.promptTokS * 0.9 && turnWait(best.speed) <= turnWait(baseline.speed) * 1.15 + 0.2 ? best : baseline;
	d.signal?.throwIfAborted();
	await d.start(selected.config);
	return { at: Date.now(), baseline: baseline.speed, speed: selected.speed, gain: cost(baseline.speed) / cost(selected.speed), ...selected.config, kept: tuneLabel(selected.config, baseline.config) };
}

/**
 * A local synthetic code prompt, with a distinct prefix so prompt-cache reuse cannot inflate the
 * result. `tokens` is how long the prompt should be (about 35 tokens a function): the tuner asks
 * for a long one, since that is where settings differ.
 *
 * It is sent as a chat message. Without the model's own template a chat model often ends at once:
 * Gemma 4 answered the bare prompt with two tokens three times out of four, and the probe failed.
 */
export async function probeModelSpeed(base: string, model: string, signal: AbortSignal, tokens = 840): Promise<TuneSpeed> {
	const fn = (i: number) => `export function select${i}(rows: Array<{id: number; name: string}>, id: number) { return rows.find(row => row.id === id); }`;
	const ask = async (messages: Array<{ role: string; content: string }>, cached: boolean) => {
		const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ model, messages, max_tokens: 96, temperature: 0, seed: 42, cache_prompt: cached, chat_template_kwargs: { enable_thinking: false } }) });
		if (!res.ok) throw new Error(`Speed probe failed: HTTP ${res.status}`);
		const j = await res.json() as { choices?: Array<{ message?: { content?: string } }>; timings?: { predicted_n?: number; predicted_per_second?: number; prompt_per_second?: number; prompt_ms?: number } };
		return { t: j.timings, text: j.choices?.[0]?.message?.content || '' };
	};
	const first = [{ role: 'user', content: `Benchmark ${createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex')}.\n` +
		Array.from({ length: Math.max(24, Math.min(400, Math.round(tokens / 35))) }, (_, i) => fn(i)).join('\n') +
		'\nReview the code above. Write a detailed explanation of its time complexity and describe a Map-based alternative.' }];
	const cold = await ask(first, false);
	const t = cold.t;
	if (!t || (t.predicted_n ?? 0) < 32 || !(t.predicted_per_second! > 0) || !(t.prompt_per_second! > 0)) throw new Error('The model returned too few tokens to measure speed reliably.');
	// The follow-up turn an agent makes most: the long prompt is in the cache, a file's worth of text is new.
	const turn = await ask([...first, { role: 'assistant', content: cold.text || 'Noted.' }, { role: 'user', content: 'Here is one more file:\n' + Array.from({ length: 12 }, (_, i) => fn(1000 + i)).join('\n') + '\nDoes it change your review? Explain in detail.' }], true);
	const wrote = turn.t && (turn.t.predicted_n ?? 0) >= 32 && turn.t.predicted_per_second! > 0 ? (t.predicted_per_second! + turn.t.predicted_per_second!) / 2 : t.predicted_per_second!;
	const waited = turn.t?.prompt_ms;
	return { tokS: wrote, promptTokS: t.prompt_per_second!, ...(typeof waited === 'number' && Number.isFinite(waited) ? { turnS: waited / 1000 } : {}) };
}
