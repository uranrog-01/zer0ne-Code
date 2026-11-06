import { priceUsage, usageSource, type UsagePrices } from '../usage';
import type { RequestAttempt, RequestContext } from '../requestDiagnostics';

export interface TaskLimits { cost: number; tokens: number; requests: number; seconds: number; }
export interface TaskBudgetSnapshot {
	rootTaskId: string; limits: TaskLimits; requests: number; spentTokens: number; reservedTokens: number; uncertainTokens: number;
	spentCost: number; reservedCost: number; uncertainCost: number; unknownUsage: number; unknownCost: number; stopped?: string;
}
export interface AttemptLease { finish(attempt: RequestAttempt): void; }
export class TaskBudgetError extends Error { constructor(message: string) { super(message); this.name = 'TaskBudgetError'; } }

export class TaskBudget {
	/** Replaced when the task restarts: an aborted budget must not abort its next attempt. */
	controller = new AbortController();
	private state: TaskBudgetSnapshot;
	private started = Date.now();
	private timer?: NodeJS.Timeout;
	private changed?: (snapshot: TaskBudgetSnapshot) => void;
	/** A turn is using this budget: eviction must not abort it. */
	pinned = false;
	constructor(readonly id: string, limits: TaskLimits, changed?: (snapshot: TaskBudgetSnapshot) => void) {
		this.changed = changed;
		this.state = { rootTaskId: id, limits: { ...limits }, requests: 0, spentTokens: 0, reservedTokens: 0, uncertainTokens: 0, spentCost: 0, reservedCost: 0, uncertainCost: 0, unknownUsage: 0, unknownCost: 0 };
		this.armTimer(limits);
	}
	/**
	 * The same task id came back (a retry, a resumed run). The new limits are the
	 * user's current settings and must apply; the previous attempt's spend does
	 * not belong to this one, so the counters start over with the new limits.
	 */
	reset(limits: TaskLimits, changed?: (snapshot: TaskBudgetSnapshot) => void): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.controller = new AbortController();
		this.started = Date.now();
		this.changed = changed;
		this.state = { rootTaskId: this.id, limits: { ...limits }, requests: 0, spentTokens: 0, reservedTokens: 0, uncertainTokens: 0, spentCost: 0, reservedCost: 0, uncertainCost: 0, unknownUsage: 0, unknownCost: 0 };
		this.armTimer(limits);
		this.publish();
	}
	private armTimer(limits: TaskLimits): void {
		if (limits.seconds <= 0) return;
		this.timer = setTimeout(() => { this.state.stopped = 'Task time budget reached.'; this.controller.abort(new TaskBudgetError(this.state.stopped)); this.publish(); }, limits.seconds * 1000);
		this.timer.unref?.();
	}
	snapshot(): TaskBudgetSnapshot { return { ...this.state, limits: { ...this.state.limits } }; }
	assertActive(): void { if (this.state.stopped || this.controller.signal.aborted) throw new TaskBudgetError(this.state.stopped ?? 'Task budget reached.'); }
	private publish(): void { try { this.changed?.(this.snapshot()); } catch { /* Budget enforcement is independent of UI persistence. */ } }
	reserve(input: number, output: number, prices: UsagePrices, kind: RequestAttempt['costKind']): AttemptLease {
		if (![input, output, input + output].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new TaskBudgetError('Cannot reserve an invalid token allowance.');
		const s = this.state, l = s.limits;
		const fail = (message: string): never => { s.stopped = message; this.publish(); throw new TaskBudgetError(message); };
		this.assertActive();
		if (this.controller.signal.aborted || l.seconds > 0 && Date.now() - this.started >= l.seconds * 1000) return fail('Task time budget reached.');
		const tokens = input + output;
		// Reserve the most expensive known input bucket, including cache writes. No presumed cache hit.
		const inputRate = Math.max(prices.priceIn ?? 0, prices.priceCacheRead ?? 0, prices.priceCacheWrite ?? 0, prices.priceCacheWrite1h ?? 0, prices.priceCacheWrite12h ?? 0);
		const billable = kind === 'estimated' || kind === 'free';
		const valid = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0;
		const knownPrice = kind === 'local' || kind === 'subscription' || billable && valid(prices.priceIn) && valid(prices.priceOut) && [prices.priceCacheRead, prices.priceCacheWrite, prices.priceCacheWrite1h, prices.priceCacheWrite12h].every((n) => n === undefined || valid(n));
		const cost = billable && knownPrice ? (input * inputRate + output * prices.priceOut!) / 1e6 : 0;
		if (l.requests > 0 && s.requests >= l.requests) return fail('Task model-request budget reached.');
		if (l.tokens > 0 && s.spentTokens + s.uncertainTokens + s.reservedTokens + tokens > l.tokens) return fail('Task token budget cannot cover the next request.');
		if (l.cost > 0 && (!knownPrice || s.unknownCost > 0)) return fail('Task cost budget requires known prices and usage for every request.');
		if (l.cost > 0 && s.spentCost + s.uncertainCost + s.reservedCost + cost > l.cost) return fail('Task cost budget cannot cover the next request.');
		s.requests++; s.reservedTokens += tokens; s.reservedCost += cost; this.publish();
		let finished = false;
		return { finish: (attempt) => {
			if (finished) return; finished = true;
			s.reservedTokens = Math.max(0, s.reservedTokens - tokens); s.reservedCost = Math.max(0, s.reservedCost - cost);
			const complete = usageSource(attempt.usage) === 'provider';
			if (complete) s.spentTokens += attempt.usage!.input + attempt.usage!.output;
			else { s.uncertainTokens += Math.max(tokens, (attempt.usage?.input ?? 0) + (attempt.usage?.output ?? 0)); s.unknownUsage++; }
			const actual = kind === 'local' || kind === 'subscription' ? 0 : attempt.usage ? priceUsage(prices, attempt.usage) : undefined;
			if (actual !== undefined) s.spentCost += actual;
			else { s.uncertainCost += cost; s.unknownCost++; }
			if (kind !== 'unknown') Object.assign(attempt, { prices, costKind: actual === undefined ? 'unknown' : kind, cost: kind === 'local' || kind === 'subscription' ? undefined : actual });
			this.publish();
		} };
	}
	dispose(): void { if (this.timer) clearTimeout(this.timer); this.controller.abort(new TaskBudgetError('Task runtime closed.')); }
}

export class TaskBudgets {
	private readonly roots = new Map<string, TaskBudget>();
	create(id: string, limits: TaskLimits, changed?: (s: TaskBudgetSnapshot) => void): TaskBudget {
		const existing = this.roots.get(id);
		if (existing) {
			existing.reset(limits, changed);
			return existing;
		}
		const budget = new TaskBudget(id, limits, changed); this.roots.set(id, budget);
		// Old roots cannot silently restart a budget: resolve fails closed for an evicted explicit identity.
		this.evict();
		return budget;
	}
	/**
	 * Drop the oldest budgets once there are too many. A budget a running turn
	 * still uses is never evicted: disposing it would abort that turn.
	 */
	private evict(): void {
		while (this.roots.size > 512) {
			const first = [...this.roots].find(([, budget]) => !budget.pinned);
			if (!first) return;
			first[1].dispose();
			this.roots.delete(first[0]);
		}
	}
	/** A turn holds its budget while it runs. */
	pin(budget: TaskBudget | undefined): void { if (budget) budget.pinned = true; }
	/** The turn is over: the budget may be evicted and a later turn starts fresh. */
	unpin(budget: TaskBudget | undefined): void {
		if (!budget) return;
		budget.pinned = false;
		if (budget.controller.signal.aborted) this.roots.delete(budget.id);
	}
	resolve(context: RequestContext | undefined): TaskBudget | undefined {
		const id = context?.rootTaskId ?? context?.parentTurnId ?? context?.turnId;
		const budget = id ? this.roots.get(id) : undefined;
		if (context?.rootTaskId && !budget) throw new TaskBudgetError('This task budget is no longer available. Start a new turn.');
		return budget;
	}
	dispose(): void { for (const budget of this.roots.values()) budget.dispose(); this.roots.clear(); }
}
