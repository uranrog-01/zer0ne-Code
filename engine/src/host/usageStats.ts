import type { ModelCatalog } from '../modelCatalog';
import type { ProviderConfig, ProviderStore } from '../providerStore';
import { presetById } from '../presets';
import { formatTokens } from './turnHelpers';
import type { Memento } from 'vscode';
import { createHash } from 'crypto';
import { priceUsage, usageSource, type ModelUsage, type UsagePrices } from '../usage';
import type { RequestAttempt } from '../requestDiagnostics';
import type { UsageEvent } from '../providerStore';

export type UsageCostKind = 'estimated' | 'free' | 'subscription' | 'local' | 'unknown';
type Price = UsagePrices;
function priceKind(price: Price): UsageCostKind {
	const valid = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0;
	return !valid(price.priceIn) || !valid(price.priceOut) ? 'unknown' : price.priceIn === 0 && price.priceOut === 0 && ![price.priceCacheRead, price.priceCacheWrite, price.priceCacheWrite1h, price.priceCacheWrite12h].some((n) => n && n > 0) ? 'free' : 'estimated';
}
interface UsageModelRow {
	providerId: string;
	model: string;
	provider: string;
	requests: number;
	tokensIn: number;
	tokensOut: number;
	tokensCached: number;
	tokensCacheWrite?: number;
	unknownUsage?: number;
	unknownCost?: number;
	cost: number;
	costKind: UsageCostKind;
	/** Which key of the provider's pool served what, biggest first. Absent without a pool. */
	keys?: Array<{ index: number; hint: string; requests: number; tokens: number }>;
	/** Requests with no key recorded: older records, from before per-key attribution. */
	keyless?: number;
}
const usageDays = (days: number) => [1, 7, 30, 90].includes(days) ? days : 30;
const dayKey = (t: number) => {
	const d = new Date(t);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dailyKeys = (since: number, until: number): string[] => {
	const date = new Date(since);
	date.setHours(0, 0, 0, 0);
	const result = [];
	while (date.getTime() <= until) {
		result.push(dayKey(date.getTime()));
		date.setDate(date.getDate() + 1);
	}
	return result;
};
/** One cell saying which pool key served what ("key #2 …a8f3 (12); not recorded (1)"). */
export function usageKeysCell(m: Pick<UsageModelRow, 'keys' | 'keyless'>): string {
	return [...(m.keys ?? []).map((k) => 'key #' + (k.index + 1) + ' ' + k.hint + ' (' + k.requests + ')'), m.keyless ? 'not recorded (' + m.keyless + ')' : ''].join('; ');
}

/** Quote CSV fields and neutralize spreadsheet formulas in user-controlled names. */
export function usageCsv(data: { days: number; since: number; at: number; models: UsageModelRow[] }): string {
	const cell = (value: string | number) => '"' + String(typeof value === 'string' && /^[\s]*[=+@-]/.test(value) ? "'" + value : value).replace(/"/g, '""') + '"';
	const rows: Array<Array<string | number>> = [['Period (days)', 'From', 'To', 'Provider ID', 'Provider', 'Model', 'Requests', 'Input tokens', 'Output tokens', 'Cached input tokens', 'Cost type', 'Estimated cost (USD)', 'Pool keys', 'Cache-write tokens', 'Incomplete usage requests', 'Unknown cost requests']];
	for (const m of data.models) rows.push([data.days, new Date(data.since).toISOString(), new Date(data.at).toISOString(), m.providerId, m.provider, m.model, m.requests, m.tokensIn, m.tokensOut, m.tokensCached, m.costKind, m.costKind === 'estimated' || m.costKind === 'free' ? m.cost.toFixed(6) : '', usageKeysCell(m), m.tokensCacheWrite ?? 0, m.unknownUsage ?? 0, m.unknownCost ?? 0]);
	return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

export interface UsageDeps {
	store: ProviderStore;
	catalog: ModelCatalog;
	alertState?: Pick<Memento, 'get' | 'update'>;
	notify?: (message: string) => void;
}

/** Settings → Usage stats: totals, change vs the period before, cache savings, heatmap, workflow. */
export class UsageStats {
	constructor(private readonly d: UsageDeps) {}
	async requestsCsv(days: number): Promise<string> {
		const since = Date.now() - usageDays(days) * 86_400_000;
		const cell = (value: unknown) => '"' + String(value ?? '').replace(/"/g, '""').replace(/^[\s]*([=+@-])/, "'$1") + '"';
		const rows: unknown[][] = [['Attempt ID', 'Started', 'Provider ID', 'Model', 'Session ID', 'Turn ID', 'Parent turn ID', 'Purpose', 'Outcome',
			'Usage source', 'Input total', 'Uncached input', 'Cache read', 'Cache write', 'Cache write 5m', 'Cache write 1h', 'Output', 'Reasoning within output',
			'Cost kind', 'Estimated cost USD', 'Price version', 'Prepare ms', 'Response ms', 'First event ms', 'First text ms', 'First reasoning ms', 'Duration ms',
			'Request bytes', 'Prefix changed', 'System hash', 'Tools hash', 'History hash', 'Rates per million JSON', 'Raw usage JSON',
			'Step', 'Task ID', 'HTTP status', 'Provider request ID', 'Route hash', 'Prefix stable', 'Usage issues JSON', 'Turn tool wall timings JSON (once per turn)', 'Root task ID', 'Prefix context reason']];
		const sessions = new Map<string, Awaited<ReturnType<ProviderStore['loadMessages']>>>();
		const emitted = new Set<string>();
		for (const e of this.d.store.getUsageEvents().filter((e) => e.t >= since && e.attemptId)) {
			const a = e.request, u = e.usage, r = a?.request;
			let timings = '';
			const turn = JSON.stringify([e.sessionId, e.turnId]);
			if (e.sessionId && e.turnId && e.purpose === 'main' && !emitted.has(turn)) {
				if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, await this.d.store.loadMessages(e.sessionId));
				const tools = sessions.get(e.sessionId)!.find((m) => m.id === e.turnId)?.turn?.toolTimings;
				if (tools) timings = JSON.stringify(tools);
				emitted.add(turn);
			}
			rows.push([e.attemptId, new Date(e.t).toISOString(), e.providerId, e.model, e.sessionId, e.turnId, e.parentTurnId, e.purpose,
				a?.outcome, e.usageSource, u?.input, u?.uncached, u?.cached, u?.cacheWrite, u?.cacheWrite5m, u?.cacheWrite1h, u?.output, u?.reasoning,
				e.costKind, e.cost, e.priceVersion, a?.prepareMs, a?.responseMs, a?.firstEventMs, a?.firstTextMs, a?.firstReasoningMs, a?.durationMs,
				r?.bytes, r?.changed, r?.system, r?.tools, r?.history, e.prices ? JSON.stringify(e.prices) : '', u?.raw ? JSON.stringify(u.raw) : '',
				a?.step, a?.taskId, a?.status, a?.providerRequestId, r?.route, r?.prefixStable, u?.issues ? JSON.stringify(u.issues) : '', timings, a?.rootTaskId, a?.prefixReason]);
		}
		return '\uFEFF' + rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
	}
	private alertChecks: Promise<void> = Promise.resolve();
	async pricing(provider: ProviderConfig | undefined, modelId: string): Promise<{ price: Price; kind: UsageCostKind }> {
		if (!provider) return { price: {}, kind: 'unknown' };
		if (provider.apiFormat === 'vscode-lm' || provider.apiFormat === 'acp' || provider.apiFormat === 'codex' || provider.auth === 'account' || presetById(provider.preset)?.group === 'plans') return { price: {}, kind: 'subscription' };
		if (provider.preset === 'zer0ne-engine' || presetById(provider.preset)?.group === 'local') return { price: {}, kind: 'local' };
		const hit = await this.d.catalog.lookup(modelId, provider.catalogId, provider).catch(() => undefined);
		const entry = provider.models.find((m) => m.id === modelId);
		const manual = (field: 'priceIn' | 'priceOut') => entry && (!entry.smart || entry.manualFields?.includes(field)) ? entry[field] : undefined;
		const price: Price = { priceIn: manual('priceIn') ?? hit?.priceIn ?? entry?.priceIn, priceOut: manual('priceOut') ?? hit?.priceOut ?? entry?.priceOut,
			priceCacheRead: hit?.priceCacheRead, priceCacheWrite: hit?.priceCacheWrite, priceCacheWrite1h: hit?.priceCacheWrite1h };
		// Official Claude API write multipliers do not apply to compatible gateways.
		let official = false;
		try { official = provider.apiFormat === 'anthropic' && new URL(provider.baseUrl).hostname === 'api.anthropic.com'; } catch { /* invalid endpoint */ }
		if (official && price.priceIn !== undefined) {
			price.priceCacheWrite ??= price.priceIn * 1.25;
			price.priceCacheWrite1h ??= price.priceIn * 2;
		}
		try {
			if (new URL(provider.baseUrl).hostname === 'api.openai.com' && /^gpt-(?:5\.6(?:-|$)|6(?:\.|-))/i.test(modelId) && price.priceIn !== undefined) {
				price.priceCacheWrite ??= price.priceIn * 1.25;
				price.priceCacheWrite12h ??= price.priceIn * 2.5;
			}
		} catch { /* Unknown hosts retain catalog prices without inferred multipliers. */ }
		return { price, kind: priceKind(price) };
	}

	async recordAttempt(provider: ProviderConfig, attempt: RequestAttempt, keyInfo?: { index: number; hint: string }): Promise<void> {
		const saved = this.d.store.getUsageEvents().find((e) => e.attemptId === attempt.id);
		const snapshot = attempt.prices ?? saved?.prices;
		const priorKind = attempt.costKind ?? saved?.costKind;
		const { price, kind } = snapshot ? { price: snapshot, kind: priorKind === 'subscription' || priorKind === 'local' ? priorKind : priceKind(snapshot) } : await this.pricing(provider, attempt.model);
		const source = usageSource(attempt.usage);
		const cost = attempt.usage && (kind === 'estimated' || kind === 'free') ? priceUsage(price, attempt.usage) : undefined;
		const costKind = (kind === 'estimated' || kind === 'free') && cost === undefined ? 'unknown' : kind;
		Object.assign(attempt, { cost, costKind, prices: price, priceVersion: attempt.priceVersion ?? saved?.priceVersion ?? createHash('sha256').update(JSON.stringify(price)).digest('hex') });
		await this.d.store.recordUsage({ t: attempt.startedAt, sessionId: attempt.sessionId, providerId: provider.id, model: attempt.model,
			tokensIn: attempt.usage?.input ?? 0, tokensOut: attempt.usage?.output ?? 0, tokensCached: attempt.usage?.cached,
			tokensCacheWrite: attempt.usage?.cacheWrite, usage: attempt.usage, usageSource: source,
			attemptId: attempt.id, turnId: attempt.turnId, parentTurnId: attempt.parentTurnId, purpose: attempt.purpose,
			request: attempt, cost, costKind, prices: price, priceVersion: attempt.priceVersion,
			keyIndex: keyInfo?.index, keyHint: keyInfo?.hint });
	}

	private eventCost(e: UsageEvent, fallback: { price: Price; kind: UsageCostKind }): { price: Price; kind: UsageCostKind; cost: number } {
		const price = e.prices ?? fallback.price;
		const kind = e.costKind ?? fallback.kind;
		const cost = e.cost ?? (kind === 'estimated' || kind === 'free' ? priceUsage(price, e.usage ?? { input: e.tokensIn, output: e.tokensOut, cached: e.tokensCached }) : undefined);
		return { price, kind: e.usageSource === 'unknown' || e.usageSource === 'partial' || ((kind === 'estimated' || kind === 'free') && cost === undefined) ? 'unknown' : kind, cost: cost ?? 0 };
	}

	/** Runs after persisted usage changes; each upward threshold crossing is notified once. */
	checkBudgetAlerts(): Promise<void> {
		this.alertChecks = this.alertChecks.catch(() => undefined).then(async () => {
			if (!this.d.store.getSettings().usageBudgetAlerts || !this.d.alertState || !this.d.notify) return;
			const previous = this.d.alertState.get<Record<string, { limit: number; level: number; at?: number }>>('aiChat.usageBudgetAlerts', {});
			const next: typeof previous = {};
			const messages: string[] = [];
			const events = this.d.store.getUsageEvents();
			for (const p of (await this.d.store.list()).filter((p) => p.enabled)) {
				const windows = this.d.store.usageWindows(p, events);
				for (const key of ['weekly', 'fiveHour'] as const) {
					const w = windows[key];
					const level = [100, 90, 75].find((n) => w.limit > 0 && w.used / w.limit >= n / 100) ?? 0;
					const id = JSON.stringify([p.id, key]);
					const duration = key === 'weekly' ? 7 * 86_400_000 : 5 * 3_600_000;
					const expired = !!previous[id]?.at && Date.now() - previous[id].at! >= duration;
					const before = previous[id]?.limit === w.limit && !expired ? previous[id].level : 0;
					if (level > before) messages.push(`${p.name}: ${key === 'weekly' ? 'weekly' : '5-hour'} token budget ${level === 100 ? 'exhausted' : `${level}% used`}`);
					next[id] = { limit: w.limit, level, at: level > before ? Date.now() : previous[id]?.at };
				}
			}
			await this.d.alertState.update('aiChat.usageBudgetAlerts', next);
			if (messages.length) this.d.notify('Budget alert — ' + messages.join('; ') + '.');
		});
		return this.alertChecks;
	}

	/** $ for one turn at the model's list price (models.dev); undefined for subscriptions / unknown prices. */
	async turnCost(provider: ProviderConfig, modelId: string, input: number, output: number, cached: number, extra: Partial<ModelUsage> = {}): Promise<number | undefined> {
		const { price, kind } = await this.pricing(provider, modelId);
		if (kind !== 'estimated' && kind !== 'free') return undefined;
		return priceUsage(price, { input, output, cached, ...extra });
	}

	async usageData(days: number) {
		days = usageDays(days);
		const now = Date.now();
		const since = now - days * 86_400_000;
		const events = this.d.store.getUsageEvents();
		const inRange = events.filter((e) => e.t >= since && e.t <= now);
		const providers = await this.d.store.list();
		const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? 'Deleted provider';
		const priceCache = new Map<string, Awaited<ReturnType<UsageStats['pricing']>>>();
		const priceOf = async (providerId: string, model: string) => {
			const key = JSON.stringify([providerId, model]);
			if (!priceCache.has(key)) priceCache.set(key, await this.pricing(providers.find((p) => p.id === providerId), model));
			return priceCache.get(key)!;
		};
		const byModel = new Map<string, UsageModelRow>();
		const costCoverage: Record<UsageCostKind, number> = { estimated: 0, free: 0, subscription: 0, local: 0, unknown: 0 };
		// Activity heatmap: weekday (0 = Monday) × hour, tokens.
		const heat: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
		let cachedTotal = 0;
		let inputTotal = 0;
		let saved = 0;
		const byDay = new Map<string, Record<string, number>>();
		let cost = 0;
		for (const e of inRange) {
			const key = JSON.stringify([e.providerId, e.model]);
			const { price, kind, cost: c } = this.eventCost(e, await priceOf(e.providerId, e.model));
			const row: UsageModelRow = byModel.get(key) ?? { providerId: e.providerId, model: e.model, provider: nameOf(e.providerId), requests: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, cost: 0, costKind: kind };
			if (kind === 'estimated' || kind === 'free' && row.costKind === 'unknown') row.costKind = kind;
			costCoverage[kind]++;
			row.unknownCost = (row.unknownCost ?? 0) + (kind === 'unknown' ? 1 : 0);
			row.unknownUsage = (row.unknownUsage ?? 0) + (e.usageSource === 'unknown' || e.usageSource === 'partial' ? 1 : 0);
			row.tokensCacheWrite = (row.tokensCacheWrite ?? 0) + (e.tokensCacheWrite ?? 0);
			row.tokensCached += e.tokensCached ?? 0;
			if (e.tokensCached !== undefined && e.usageSource !== 'unknown' && e.usageSource !== 'partial') { cachedTotal += e.tokensCached; inputTotal += e.tokensIn; }
			if (kind === 'estimated' && price.priceIn && e.tokensCached) saved += Math.max(0, (price.priceIn - (price.priceCacheRead ?? price.priceIn)) * Math.min(e.tokensCached, e.tokensIn)) / 1e6;
			const when = new Date(e.t);
			heat[(when.getDay() + 6) % 7][when.getHours()] += e.tokensIn + e.tokensOut;
			row.requests++;
			row.tokensIn += e.tokensIn;
			row.tokensOut += e.tokensOut;
			row.cost += c;
			if (e.keyIndex != null) {
				row.keys ??= [];
				let k = row.keys.find((x) => x.index === e.keyIndex);
				if (!k) row.keys.push((k = { index: e.keyIndex, hint: e.keyHint ?? '', requests: 0, tokens: 0 }));
				k.requests++;
				k.tokens += e.tokensIn + e.tokensOut;
			} else row.keyless = (row.keyless ?? 0) + 1;
			cost += c;
			byModel.set(key, row);
			const bucket = byDay.get(dayKey(e.t)) ?? {};
			bucket[e.model] = (bucket[e.model] ?? 0) + e.tokensIn + e.tokensOut;
			byDay.set(dayKey(e.t), bucket);
		}
		const daily = dailyKeys(since, now).map((day) => ({ day, byModel: byDay.get(day) ?? {} }));
		const total = inRange.reduce((s, e) => s + e.tokensIn + e.tokensOut, 0);
		// The period before, for the ▲/▼ change.
		const prevEvents = events.filter((e) => e.t >= since - days * 86_400_000 && e.t < since);
		let prevCost = 0;
		for (const e of prevEvents) {
			prevCost += this.eventCost(e, await priceOf(e.providerId, e.model)).cost;
		}
		const prevTokens = prevEvents.reduce((s, e) => s + e.tokensIn + e.tokensOut, 0);
		// Workflow: agent turns, time, lines changed, tools, approvals — from the chats in range.
		const flow = { chats: 0, turns: 0, turnMs: 0, durations: [] as number[], added: 0, removed: 0, files: new Set<string>(), tools: new Map<string, number>(), toolErrors: 0, toolCalls: 0, approved: 0, rejected: 0, auto: 0 };
		for (const s of (await this.d.store.listSessions()).filter((x) => x.updatedAt >= since).slice(0, 300)) {
			let counted = false;
			for (const m of await this.d.store.loadMessages(s.id)) {
				if (m.role === 'user' && m.turn && m.turn.startedAt >= since) {
					counted = true;
					flow.turns++;
					if (m.turn.endedAt) {
						const d = m.turn.endedAt - m.turn.startedAt;
						flow.turnMs += d;
						flow.durations.push(d);
					}
					for (const ed of m.turn.edits ?? []) {
						flow.added += ed.added;
						flow.removed += ed.removed;
						flow.files.add(ed.path);
					}
				} else if (m.tool?.name) {
					flow.toolCalls++;
					flow.tools.set(m.tool.name, (flow.tools.get(m.tool.name) ?? 0) + 1);
					if (m.tool.status === 'error') flow.toolErrors++;
				} else if (m.approval) {
					flow.tools.set(m.approval.kind === 'command' ? 'run_command' : m.approval.kind === 'mcp' ? m.approval.tool ?? 'mcp' : 'edit', (flow.tools.get(m.approval.kind === 'command' ? 'run_command' : m.approval.kind === 'mcp' ? m.approval.tool ?? 'mcp' : 'edit') ?? 0) + 1);
					flow.toolCalls++;
					if (m.approval.status === 'applied') (m.approval.auto ? flow.auto++ : flow.approved++);
					else if (m.approval.status === 'rejected') flow.rejected++;
				}
			}
			if (counted) flow.chats++;
		}
		const sorted = flow.durations.sort((a, b) => a - b);
		const busiest = heat.flatMap((row, d) => row.map((v, hr) => ({ d, hr, v }))).sort((a, b) => b.v - a.v)[0];
		return {
			days,
			at: now,
			since,
			totals: { tokens: total, tokensLabel: formatTokens(total), requests: inRange.length, activeDays: byDay.size, cost, costCoverage, prevTokens, prevCost, cached: cachedTotal, cacheRate: inputTotal ? cachedTotal / inputTotal : 0, saved,
				cacheUsageKnown: inRange.filter((e) => e.tokensCached !== undefined && e.usageSource !== 'unknown' && e.usageSource !== 'partial').length,
				unknownUsage: inRange.filter((e) => e.usageSource === 'unknown' || e.usageSource === 'partial').length },
			heat,
			busiest: busiest && busiest.v ? { day: busiest.d, hour: busiest.hr } : undefined,
			workflow: {
				chats: flow.chats,
				turns: flow.turns,
				avgTurnMs: flow.durations.length ? flow.turnMs / flow.durations.length : 0,
				medianTurnMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
				agentMs: flow.turnMs,
				added: flow.added,
				removed: flow.removed,
				files: flow.files.size,
				toolCalls: flow.toolCalls,
				toolErrors: flow.toolErrors,
				approved: flow.approved,
				rejected: flow.rejected,
				auto: flow.auto,
				topTools: [...flow.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
			},
			daily,
			models: [...byModel.values()]
				.map((m) => ({ ...m, keys: m.keys?.sort((a, b) => b.tokens - a.tokens) }))
				.sort((a, b) => b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut)),
			limits: providers.filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, ...this.d.store.usageWindows(p, events) }))
		};
	}

	async modelDetails(days: number, providerId: string, model: string) {
		days = usageDays(days);
		const now = Date.now();
		const since = now - days * 86_400_000;
		const providers = await this.d.store.list();
		const provider = providers.find((p) => p.id === providerId);
		const events = this.d.store.getUsageEvents().filter((e) => e.t >= since && e.t <= now && e.providerId === providerId && e.model === model);
		const byDay = new Map<string, { input: number; output: number; cached: number; requests: number }>();
		for (const e of events) {
			const key = dayKey(e.t);
			const row = byDay.get(key) ?? { input: 0, output: 0, cached: 0, requests: 0 };
			row.input += e.tokensIn;
			row.output += e.tokensOut;
			row.cached += e.tokensCached ?? 0;
			row.requests++;
			byDay.set(key, row);
		}
		const daily = dailyKeys(since, now).map((day) => ({ day, ...(byDay.get(day) ?? { input: 0, output: 0, cached: 0, requests: 0 }) }));
		const sessions = (await this.d.store.listSessions()).filter((s) => s.updatedAt >= since);
		const related = [];
		const linked = new Set(events.map((e) => e.sessionId).filter(Boolean));
		const unambiguous = !!provider && providers.filter((p) => p.name === provider.name).length === 1;
		for (const s of sessions.slice(0, 300)) {
			const turns = (await this.d.store.loadMessages(s.id)).filter((m) => m.role === 'user' && m.turn && m.turn.startedAt >= since && m.turn.startedAt <= now && m.turn.model === model && (m.turn.providerId ? m.turn.providerId === providerId : unambiguous && m.turn.provider === provider?.name));
			if (turns.length || linked.has(s.id)) related.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, turns: turns.length });
		}
		return { days, providerId, model, daily, related, relatedTruncated: sessions.length > 300 };
	}
}
