/*
 * First-run setup: the local models worth offering on this machine and the
 * sentence that frames each pick. Pure — the host supplies the catalog, the
 * installed models and the free disk space.
 */
import type { CatalogItem, LlmRating } from './localCatalog';
import { recommendModels } from './localExperience';

export type SetupPreset = 'fast' | 'balanced' | 'quality';

export interface SetupPick {
	/** Which pick rule produced this row; the page shows it as the reason. */
	preset: SetupPreset;
	id: string;
	name: string;
	repo: string;
	verdict: LlmRating['verdict'];
	quant?: string;
	context?: number;
	sizeGb: number;
	tokS?: number;
	/** Set when this repository already has a downloaded GGUF. */
	installedModelId?: string;
}

type LlmItem = CatalogItem & { kind: 'llm'; rating: LlmRating };

/** Only builds the engine can run with tools on: setup is an agent, not a chat toy. */
const usable = (items: CatalogItem[]): LlmItem[] =>
	items.filter((x): x is LlmItem => x.kind === 'llm' && 'quant' in x.rating && x.tools === true && !x.runtimeReason);

function pick(item: LlmItem, preset: SetupPreset, installed: Map<string, string>): SetupPick {
	const r = item.rating;
	return {
		preset, id: item.id, name: item.name, repo: item.repo, verdict: r.verdict,
		quant: r.quant, context: r.ctx, sizeGb: Math.round((r.downloadBytes / 1e9) * 10) / 10, tokS: r.tokS,
		installedModelId: installed.get(item.repo.toLowerCase())
	};
}

/**
 * Fast / Balanced / Quality picks, deduplicated by model. `recommendModels`
 * returns adopters that fit memory and support tools; when it returns nothing
 * (a small machine or an empty catalog) the tightest builds that still run are
 * offered instead, so setup never shows an empty list. Disk-based exclusion is
 * left to the caller's rating, as in the catalog.
 */
export function setupPicks(items: CatalogItem[], installed = new Map<string, string>(), disk?: number): SetupPick[] {
	const llm = usable(items);
	const chosen = recommendModels(llm, disk);
	const out: SetupPick[] = [];
	const seen = new Set<string>();
	for (const [preset, item] of [['fast', chosen.fast], ['balanced', chosen.balanced], ['quality', chosen.quality]] as const) {
		if (!item || seen.has(item.id)) continue;
		seen.add(item.id);
		out.push(pick(item, preset, installed));
	}
	if (out.length) return out;
	const fallback = llm
		.filter((x) => x.rating.verdict === 'perfect' || x.rating.verdict === 'good' || x.rating.verdict === 'marginal')
		.sort((a, b) => b.rating.score - a.rating.score)
		.slice(0, 3);
	const presets: SetupPreset[] = ['fast', 'balanced', 'quality'];
	return fallback.map((item, index) => pick(item, presets[index], installed));
}
