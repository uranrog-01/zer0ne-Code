/** Formats the context_remaining tool's figures; pure so the wording is testable. */
export interface ContextBudget {
	remaining: number;
	window: number;
	used: number;
	source?: 'provider' | 'estimated';
}

export function contextBudgetText(budget: ContextBudget | undefined): { api: string; summary: string; detail?: string } {
	if (!budget) return { api: 'The remaining context is unknown for this model.', summary: 'unknown' };
	const pct = budget.window > 0 ? Math.round((budget.remaining / budget.window) * 100) : 0;
	return {
		api: `Context window: ${budget.window} tokens; ${budget.used} used by the last request${budget.source === 'estimated' ? ' (estimated)' : ''}; about ${budget.remaining} left (${pct}%).`,
		summary: `${pct}% left`,
		detail: `window ${budget.window} · used ${budget.used} · remaining ${budget.remaining}${budget.source ? ` · ${budget.source}` : ''}`
	};
}
