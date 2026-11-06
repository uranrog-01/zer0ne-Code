import type { RequestAttempt } from '../requestDiagnostics';

export interface EvalMetrics {
	requests: number;
	retries: number;
	truncations: number;
	toolFailures: number;
	cacheWrites: number;
	cacheKnown: number;
	firstUsefulMs?: number;
	capabilityDowngrades: string[];
	cacheRequests: Array<{ state: 'warm' | 'cold' | 'unknown'; ms: number }>;
}
export function attemptMetrics(attempts: RequestAttempt[], toolFailures = 0, startedAt = attempts[0]?.startedAt ?? 0): EvalMetrics {
	const groups = new Map<string, number>();
	for (const a of attempts) if (a.step !== undefined) { const key = JSON.stringify([a.sessionId, a.taskId, a.purpose, a.step]); groups.set(key, (groups.get(key) ?? 0) + 1); }
	const useful = attempts.filter(a => a.purpose === 'main' || !a.purpose).flatMap(a => [a.firstTextMs, a.firstToolMs].filter((n): n is number => typeof n === 'number').map(n => Math.max(0, a.startedAt - startedAt) + n));
	return { requests: attempts.length, retries: [...groups.values()].reduce((n, size) => n + Math.max(0, size - 1), 0), toolFailures,
		truncations: attempts.filter(a => ['length', 'max_tokens'].includes(a.stopReason ?? '')).length,
		cacheWrites: attempts.reduce((n, a) => n + (a.usage?.cacheWrite ?? 0), 0), cacheKnown: attempts.filter(a => a.usage?.cached !== undefined).length,
		firstUsefulMs: useful.length ? Math.min(...useful) : undefined,
		capabilityDowngrades: [...new Set(attempts.flatMap(a => a.capabilityDowngrades ?? []))],
		cacheRequests: attempts.map(a => ({ state: a.usage?.cached === undefined ? 'unknown' : a.usage.cached > 0 ? 'warm' : 'cold', ms: a.durationMs })) };
}
export function percentile(values: number[], fraction: number): number | null {
	if (!values.length) return null;
	return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(fraction * values.length) - 1)];
}
