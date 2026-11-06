/**
 * Suggest: two or three models worth trying on this computer out of everything that fits —
 * the highest quality that still feels quick, the smartest one that still writes at reading
 * pace, and the fastest one that still answers well.
 *
 * Models Fit Studio picks the same way (Core/Suggest.cs); the cases in
 * test/fixtures/suggest-cases.json hold both apps to it. Pure; no vscode dependency.
 */

import { rawTps, roundEven, speedRange, type GpuClass } from './speedEstimate';

export interface SuggestCandidate {
	/** The GGUF repository to check and download from. */
	repo: string;
	/** The model's own repository, e.g. "google/gemma-4-E4B-it". */
	origin: string;
	paramsB: number;
	/** 0–100. */
	quality: number;
	sizeGb: number;
	memGb: number;
	tpsLow: number;
	tpsHigh: number;
	/** llmfit's category: Chat, Reasoning, Multimodal, General, Coding, Embedding. */
	category: string;
	released?: string;
	vision?: boolean;
}

export interface Suggestion {
	kind: 'best' | 'smartest' | 'fastest';
	model: SuggestCandidate;
}

/** Clearly faster than reading: answers arrive without waiting on each line. */
export const COMFORT_PACE = 12;
/** Tokens a second a person reads at. */
export const READING_PACE = 7;

// Repositories that hold a different format, or a variant nobody should be sent to first.
const NOT_PLAIN = /NVFP4|MXFP4|AWQ|GPTQ|MLX|EXL[23]|W4A16|w8a8|bnb|ONNX|OpenVINO|abliterat|uncensor|heretic|distill|-RL-/i;
// Models made for one narrow job; a general suggestion is a model to talk to.
const NARROW = /ocr|medgemma|\bmed\b|guard|embed|rerank|translat|diariz|\basr\b|\btts\b|whisper|function|extract|[-_]rag\b|[-_]tool\b|[-_]base\b|[-_]jp\b|korean|doctor|coder|code/i;
const CHAT_NAME = /instruct|chat|[-_]it\b|thinking/i;
// Publishers whose GGUF copies are the widely used ones.
const MIRRORS = new Set(['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org']);


export const nameOf = (c: SuggestCandidate): string => c.origin.slice(c.origin.lastIndexOf('/') + 1);
export const typicalTps = (c: SuggestCandidate): number => roundEven((c.tpsLow + c.tpsHigh) / 2, 1);

/** llmfit's category for a model, from its use-case text and name (llmfit-core UseCase::from_model). */
export function categoryOf(name: string, useCase = ''): string {
	const n = name.toLowerCase(), u = useCase.toLowerCase();
	if (u.includes('embedding') || n.includes('embed') || n.includes('bge')) return 'Embedding';
	if (n.includes('code') || u.includes('code')) return 'Coding';
	if (u.includes('vision') || u.includes('multimodal')) return 'Multimodal';
	if (u.includes('reason') || u.includes('chain-of-thought') || n.includes('deepseek-r1')) return 'Reasoning';
	if (u.includes('chat') || u.includes('instruction')) return 'Chat';
	return 'General';
}

/** A general chat model with a GGUF copy from a publisher people use. MoE speed cannot be sized this way. */
export function usable(origin: string, ggufProvider: string, category: string, moe: boolean): boolean {
	if (moe || NOT_PLAIN.test(origin) || NARROW.test(origin)) return false;
	const org = origin.includes('/') ? origin.slice(0, origin.indexOf('/')) : '';
	if (!MIRRORS.has(ggufProvider.toLowerCase()) && org.toLowerCase() !== ggufProvider.toLowerCase()) return false;
	if (category === 'Chat' || category === 'Reasoning' || category === 'Multimodal') return true;
	// The rest of "General" is mostly untuned base models.
	return category === 'General' && CHAT_NAME.test(origin);
}

/** The same model under two names (an instruct and a thinking variant, a re-upload) counts once. */
export function family(c: SuggestCandidate): string {
	const name = nameOf(c).toLowerCase().replace(/[-_](it|instruct|chat|thinking|preview|\d{4})\b/g, '');
	return `${name}|${roundEven(c.paramsB)}`;
}

const byDesc = <T>(...keys: Array<(x: T) => number | string>) => (a: T, b: T): number => {
	for (const k of keys) {
		const x = k(a), y = k(b);
		if (x !== y) return x < y ? 1 : -1;
	}
	return 0;
};

export function pickSuggestions(all: SuggestCandidate[]): Suggestion[] {
	// One row per model: the best-rated, then the one named as a chat model, then the newest.
	const groups = new Map<string, SuggestCandidate[]>();
	for (const c of all) {
		const k = family(c);
		groups.set(k, [...(groups.get(k) ?? []), c]);
	}
	const pool = [...groups.values()].map((g) => [...g].sort(byDesc((c) => c.quality, (c) => Number(CHAT_NAME.test(nameOf(c))), (c) => c.released ?? ''))[0]);
	const picks: Suggestion[] = [];
	if (!pool.length) return picks;
	const quick = pool.filter((c) => typicalTps(c) >= COMFORT_PACE);
	const readable = pool.filter((c) => typicalTps(c) >= READING_PACE);
	const smartFirst = byDesc<SuggestCandidate>((c) => c.quality, typicalTps);
	// Best: the highest quality that still feels quick; on a slower computer, that reads at all;
	// where nothing does, quality counted down by how far it falls short.
	const best = quick.length ? [...quick].sort(smartFirst)[0]
		: readable.length ? [...readable].sort(smartFirst)[0]
		: [...pool].sort(byDesc((c) => c.quality * Math.min(1, typicalTps(c) / READING_PACE)))[0];
	picks.push({ kind: 'best', model: best });
	const smartest = readable.filter((c) => c !== best).sort(smartFirst)[0];
	if (smartest && smartest.quality > best.quality) picks.push({ kind: 'smartest', model: smartest });
	const floor = Math.max(50, best.quality - 16);
	const fastest = pool.filter((c) => c !== best && c !== smartest && c.quality >= floor).sort(byDesc(typicalTps, (c) => c.quality))[0];
	if (fastest && typicalTps(fastest) >= typicalTps(best) * 1.25) picks.push({ kind: 'fastest', model: fastest });
	return picks;
}

/** An llmfit `fit --json` row, as far as Suggest reads it. */
export interface LlmfitFitRow {
	name?: string;
	fit_level?: string;
	gguf_sources?: Array<{ repo?: string; provider?: string }>;
	category?: string;
	is_moe?: boolean;
	params_b?: number;
	memory_available_gb?: number;
	score_components?: { quality?: number };
	release_date?: string;
	capabilities?: string[];
}

/**
 * Every model llmfit says fits this computer, sized and timed the way the model list does
 * (Models Fit Studio's Core/Suggestions.cs): a Q4_K_M file of 4.85 bits a weight, the memory
 * the list sizes it with, and the speed range from the machine's decode rate.
 */
export function suggestRows(models: LlmfitFitRow[], budgetGb: number, gbPerSec: number, cls: GpuClass, calibration = 0): SuggestCandidate[] {
	const rows: SuggestCandidate[] = [];
	for (const m of models) {
		if (m.fit_level !== 'Perfect' && m.fit_level !== 'Good') continue;
		const source = m.gguf_sources?.[0];
		const origin = m.name ?? '', repo = source?.repo ?? '', category = m.category ?? '';
		if (!repo || !usable(origin, source?.provider ?? '', category, m.is_moe === true)) continue;
		const paramsB = Number(m.params_b) || 0;
		if (paramsB <= 0) continue;
		const sizeGb = roundEven(paramsB * 0.606 + 0.1, 1);
		const memGb = roundEven(sizeGb * 1.05 + 1.5, 1);
		const available = Number(m.memory_available_gb ?? budgetGb);
		if (available > 0 && memGb > available) continue;
		const [tpsLow, tpsHigh] = speedRange(rawTps(gbPerSec, sizeGb), cls, calibration);
		rows.push({ repo, origin, paramsB, quality: Number(m.score_components?.quality) || 0, sizeGb, memGb, tpsLow, tpsHigh, category, released: m.release_date, vision: category === 'Multimodal' });
	}
	return rows;
}
