import { priceUsage, type ModelUsage, type UsagePrices } from '../usage';

/* Small helpers shared by the chat controller and its host modules. */

/** Read-only, stateless tools that may run concurrently. */
export const PARALLEL_TOOLS = new Set([
	'list_files', 'read_file', 'grep', 'get_diagnostics', 'get_editor_context', 'web_search', 'web_fetch', 'git_status', 'git_diff', 'git_log',
	'code_intel', 'view_image', 'memory_recall', 'skill', 'semantic_search', 'run_script', 'agent_result'
]);

/** Cost in $: uncached input + cached input (cache price, else input price) + output. Prices are $ per million tokens. */
export function usageCost(p: UsagePrices, input: number, output: number, cached: number, extra: Partial<ModelUsage> = {}): number | undefined {
	return priceUsage(p, { input, output, cached, ...extra });
}

export function formatTokens(n: number): string {
	return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

/** A user stop (or a cancelled request), as opposed to a failure. */
export function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

export const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
