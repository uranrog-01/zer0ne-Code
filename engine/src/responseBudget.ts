import type { ModelEntry } from './providerStore';
import type { ChatMessage } from './chatClient';
import { countMessageTokens } from './tools/tokenSaver';

/** A metadata limit is an allowance, not a request to generate that much text. */
export function responseLimit(model: Pick<ModelEntry, 'maxOutput' | 'contextWindow'>, override?: number): number {
	const valid = (n: number | undefined) => n !== undefined && Number.isSafeInteger(n) && n > 0;
	const advertised = valid(model.maxOutput) ? model.maxOutput! : 16_384;
	const requested = valid(override) ? Math.min(override!, advertised) : advertised;
	return Math.max(1, Math.min(requested, valid(model.contextWindow) ? Math.max(1, model.contextWindow! - 1024) : requested));
}

/** Conservative observed/model ratios keep future estimates honest without another network call. */
export class ContextEstimator {
	private readonly ratios = new Map<string, number>();
	estimate(key: string, messages: ChatMessage[], fixed: number): number { return Math.ceil((fixed + countMessageTokens(messages)) * (this.ratios.get(key) ?? 1.15)); }
	observe(key: string, estimated: number, reported: number): void {
		if (!(estimated > 0 && reported > 0 && Number.isFinite(reported))) return;
		const ratio = this.ratios.get(key) ?? 1.15;
		this.ratios.set(key, Math.max(ratio, Math.min(8, ratio * reported / estimated * 1.1)));
		if (this.ratios.size > 256) this.ratios.delete(this.ratios.keys().next().value!);
	}
}
