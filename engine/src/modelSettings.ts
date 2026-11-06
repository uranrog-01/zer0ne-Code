import type { CatalogModel } from './modelCatalog';
import type { ModelEntry } from './providerStore';

export const MODEL_SETTINGS = ['contextWindow', 'maxOutput', 'vision', 'tools', 'reasoning', 'priceIn', 'priceOut'] as const;
export type ModelSetting = (typeof MODEL_SETTINGS)[number];

/** Validate at the host boundary as well as in the form. */
export function modelSettingsError(raw: unknown): string | undefined {
	if (!raw || typeof raw !== 'object') return;
	const model = raw as Record<string, unknown>;
	for (const field of ['contextWindow', 'maxOutput'] as const) {
		const value = model[field];
		if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) return 'Token limits must be positive whole numbers.';
	}
	for (const field of ['priceIn', 'priceOut'] as const) {
		const value = model[field];
		if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return 'Prices must be non-negative numbers.';
	}
	return undefined;
}

/** Only catalog-managed fields change; an explicit override (including false or zero) survives refresh. */
export function applyModelRecommendation(entry: ModelEntry, recommendation?: CatalogModel): ModelEntry {
	if (!entry.smart || !recommendation) return entry;
	const updated = { ...entry, manualFields: [...(entry.manualFields ?? [])] };
	for (const field of MODEL_SETTINGS) {
		if (!entry.manualFields?.includes(field) && recommendation[field] !== undefined) {
			Object.assign(updated, { [field]: recommendation[field] });
		}
	}
	return updated;
}
