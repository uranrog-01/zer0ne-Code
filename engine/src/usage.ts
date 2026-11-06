export interface ModelUsage {
	input: number;
	output: number;
	cached?: number;
	uncached?: number;
	cacheWrite?: number;
	cacheWrite5m?: number;
	cacheWrite1h?: number;
	reasoning?: number;
	inputReported?: boolean;
	outputReported?: boolean;
	cacheTtlRequested?: '5m' | '1h' | '30m' | '12h';
	raw?: Record<string, number>;
	issues?: string[];
}

export interface UsagePrices {
	priceIn?: number;
	priceOut?: number;
	priceCacheRead?: number;
	priceCacheWrite?: number;
	priceCacheWrite1h?: number;
	priceCacheWrite12h?: number;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function fields(values: Record<string, unknown>, previous?: ModelUsage): { raw: Record<string, number>; issues: string[] } {
	const raw = { ...previous?.raw };
	// Consistency is recomputed against the latest cumulative sample. A late
	// authoritative count can reconcile an initially incomplete breakdown.
	let issues = (previous?.issues ?? []).filter((issue) => issue.startsWith('Invalid usage field: '));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null) continue;
		if (count(value)) { raw[key] = value; issues = issues.filter((issue) => issue !== `Invalid usage field: ${key}`); }
		else issues.push(`Invalid usage field: ${key}`);
	}
	return { raw, issues: [...new Set(issues)] };
}

export function openaiUsage(u: any, previous?: ModelUsage): ModelUsage {
	const { raw, issues } = fields({ prompt_tokens: u.prompt_tokens ?? u.input_tokens, completion_tokens: u.completion_tokens ?? u.output_tokens,
		cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens,
		cache_write_tokens: u.prompt_tokens_details?.cache_write_tokens ?? u.input_tokens_details?.cache_write_tokens,
		prompt_cache_hit_tokens: u.prompt_cache_hit_tokens, prompt_cache_miss_tokens: u.prompt_cache_miss_tokens,
		reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens }, previous);
	const input = raw.prompt_tokens ?? previous?.input ?? 0;
	let cached: number | undefined = raw.cached_tokens ?? raw.prompt_cache_hit_tokens;
	// Some compatible gateways emit a placeholder zero in the OpenAI field.
	// Trust the alternate breakdown only when it reconciles to the reported total.
	if (raw.prompt_cache_hit_tokens !== undefined && raw.prompt_cache_miss_tokens !== undefined
		&& raw.prompt_cache_hit_tokens + raw.prompt_cache_miss_tokens === input) {
		if (cached !== raw.prompt_cache_hit_tokens) issues.push('Cache fields disagree; used the breakdown matching total input');
		cached = raw.prompt_cache_hit_tokens;
	}
	else if (raw.prompt_cache_hit_tokens !== undefined && raw.prompt_cache_miss_tokens !== undefined && raw.prompt_tokens !== undefined) issues.push('Alternate cache breakdown does not match total input');
	if (cached !== undefined && cached > input && raw.prompt_tokens !== undefined) {
		issues.push('Cached input exceeds total input'); cached = undefined;
	}
	if (raw.reasoning_tokens !== undefined && raw.completion_tokens !== undefined && raw.reasoning_tokens > raw.completion_tokens) issues.push('Reasoning exceeds output total');
	const write = raw.cache_write_tokens;
	if (write !== undefined && raw.prompt_tokens !== undefined && write + (cached ?? 0) > input) issues.push('Cache reads and writes exceed total input');
	return { input, output: raw.completion_tokens ?? previous?.output ?? 0, cached,
		cacheWrite: write,
		uncached: (cached !== undefined || write !== undefined) && raw.prompt_tokens !== undefined ? Math.max(0, input - (cached ?? 0) - (write ?? 0)) : undefined,
		reasoning: raw.reasoning_tokens, inputReported: raw.prompt_tokens !== undefined,
		outputReported: raw.completion_tokens !== undefined, raw, issues: [...new Set(issues)] };
}

export function anthropicUsage(u: any, previous?: ModelUsage): ModelUsage {
	const { raw, issues } = fields({ input_tokens: u.input_tokens, output_tokens: u.output_tokens,
		thinking_tokens: u.output_tokens_details?.thinking_tokens,
		cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens,
		ephemeral_5m_input_tokens: u.cache_creation?.ephemeral_5m_input_tokens,
		ephemeral_1h_input_tokens: u.cache_creation?.ephemeral_1h_input_tokens }, previous);
	const tiers = (raw.ephemeral_5m_input_tokens ?? 0) + (raw.ephemeral_1h_input_tokens ?? 0);
	const write = raw.cache_creation_input_tokens ?? (raw.ephemeral_5m_input_tokens !== undefined || raw.ephemeral_1h_input_tokens !== undefined ? tiers : undefined);
	if (write !== undefined && tiers > write) issues.push('Cache-write tiers exceed cache-write total');
	return { input: (raw.input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0) + (write ?? 0),
		output: raw.output_tokens ?? 0, cached: raw.cache_read_input_tokens, uncached: raw.input_tokens,
		cacheWrite: write, cacheWrite5m: raw.ephemeral_5m_input_tokens, cacheWrite1h: raw.ephemeral_1h_input_tokens,
		reasoning: raw.thinking_tokens,
		inputReported: raw.input_tokens !== undefined, outputReported: raw.output_tokens !== undefined, raw, issues: [...new Set(issues)] };
}

export function geminiUsage(u: any, previous?: ModelUsage): ModelUsage {
	const { raw, issues } = fields({ promptTokenCount: u.promptTokenCount, candidatesTokenCount: u.candidatesTokenCount,
		thoughtsTokenCount: u.thoughtsTokenCount, cachedContentTokenCount: u.cachedContentTokenCount, totalTokenCount: u.totalTokenCount }, previous);
	const input = raw.promptTokenCount ?? 0;
	if (raw.cachedContentTokenCount !== undefined && raw.promptTokenCount !== undefined && raw.cachedContentTokenCount > input) issues.push('Cached input exceeds total input');
	return { input, output: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0), cached: raw.cachedContentTokenCount,
		uncached: raw.cachedContentTokenCount !== undefined && raw.cachedContentTokenCount <= input ? input - raw.cachedContentTokenCount : undefined,
		reasoning: raw.thoughtsTokenCount, inputReported: raw.promptTokenCount !== undefined,
		outputReported: raw.candidatesTokenCount !== undefined || raw.thoughtsTokenCount !== undefined, raw, issues };
}

export function usageSource(u: ModelUsage | undefined): 'provider' | 'partial' | 'unknown' {
	if (!u) return 'unknown';
	return u.inputReported === false || u.outputReported === false || u.issues?.some((s) => !s.startsWith('Cache fields disagree')) ? 'partial' : 'provider';
}

/** Unknown rates/buckets remain unknown; reasoning is already within output. */
export function priceUsage(p: UsagePrices, u: ModelUsage): number | undefined {
	if (usageSource(u) !== 'provider') return undefined;
	const read = u.cached ?? 0;
	const write = u.cacheWrite ?? 0;
	const five = u.cacheWrite5m ?? 0;
	const hour = u.cacheWrite1h ?? 0;
	const otherWrite = write - five - hour;
	const uncached = u.uncached ?? u.input - read - write;
	if (![u.input, u.output, read, write, five, hour, otherWrite, uncached].every(count)
		|| uncached + read + write !== u.input) return undefined;
	const terms: Array<[number, number | undefined]> = [[uncached, p.priceIn], [read, p.priceCacheRead ?? p.priceIn],
		[five, p.priceCacheWrite], [hour, p.priceCacheWrite1h],
		[otherWrite, u.cacheTtlRequested === '12h' ? p.priceCacheWrite12h : u.cacheTtlRequested === '1h' ? p.priceCacheWrite1h : p.priceCacheWrite], [u.output, p.priceOut]];
	if (terms.some(([tokens, rate]) => tokens > 0 && (rate === undefined || !Number.isFinite(rate) || rate < 0))) return undefined;
	return terms.reduce((sum, [tokens, rate]) => sum + tokens * (rate ?? 0), 0) / 1e6;
}
