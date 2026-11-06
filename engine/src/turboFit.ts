import type { Machine } from './localModels';
import { integratedGpu } from './localModels';

/**
 * Turbo Fit — run models that don't fit comfortably, as fast as the machine
 * allows, using what llama.cpp can really do (no magic):
 *
 *  1. KV cache in 8-bit or 4-bit (-ctk/-ctv): long contexts in half / a quarter of the memory.
 *  2. MoE expert offload (--cpu-moe / --n-cpu-moe): attention and shared weights stay on
 *     the GPU, the big expert tables live in system RAM. A 30B-A3B model reads only ~3B
 *     parameters per token; CPU offload speed still depends on memory bandwidth and the backend.
 *  3. Partial GPU offload for dense models (--fit on already chooses the layer split). Only a card
 *     with memory of its own gains from it; on shared graphics memory no split is advised.
 *  4. Context sized to what is left (--fit-ctx / -c).
 *  5. N-gram speculative decoding is the engine-wide "Speed boost" (localModelsHost):
 *     long drafts only (--spec-ngram-mod-n-min 8 / n-max 48). Repetitive edits may benefit;
 *     fresh generation usually has fewer draft matches.
 *  6. The right quant: the largest file that fits beats a bigger one that spills.
 *
 * Everything here is an estimate from sizes and memory bandwidth; the engine
 * still measures and falls back (smaller context, then CPU) if a plan fails.
 * What is measured instead of estimated lives elsewhere: Tune for speed (localTune.ts)
 * times the attention mode, threads, batch and the processor on a long prompt, and a
 * draft head next to the model is used when Speed boost is on (localModelsHost.ts).
 */

export type TurboTier = 'gpu' | 'hybrid' | 'ram' | 'disk' | 'no';

export interface TurboInput {
	name: string;
	sizeBytes: number;
	/** Total parameters (from Hugging Face metadata or the name), if known. */
	params?: number;
	machine: Machine;
	/** Context wanted (tokens). */
	context?: number;
	projectorBytes?: number;
	shape?: import('./modelFit').ModelShape;
}

export interface TurboPlan {
	tier: TurboTier;
	label: string;
	/** Extra llama-server arguments. */
	flags: string[];
	context: number;
	kv: 'f16' | 'q8_0' | 'q4_0';
	moe: boolean;
	activeParams?: number;
	/** Estimated generation speed without / with the plan (tokens/s). */
	baseTokS: number;
	estTokS: number;
	/** Extra speed on code edits from n-gram speculation (multiplier, e.g. 1.6). */
	specBoost: number;
	/** A quant that would run fully fast here (e.g. "IQ3_M"), when the file is too big. */
	suggestQuant?: string;
	notes: string[];
}

const GB = 1e9;
/** Measured share of the chip's speed a model keeps past shared graphics memory (the same number as FIT.sharedSpill). */
const SHARED_SPILL = 0.75;

/** Mixture-of-experts: total and active parameters from the name. */
export function moeInfo(name: string, params?: number): { moe: boolean; active?: number } {
	const n = name.toLowerCase();
	const a = /[-_.]a(\d+(?:\.\d+)?)b\b/i.exec(name);
	if (a) return { moe: true, active: Number(a[1]) * GB };
	if (/gpt-oss-?120b/.test(n)) return { moe: true, active: 5.1 * GB };
	if (/gpt-oss-?20b/.test(n)) return { moe: true, active: 3.6 * GB };
	const mx = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(name);
	if (mx) return { moe: true, active: 2 * Number(mx[2]) * GB };
	// Llama 4 style: "17B-16E" = 17B active, 16 experts.
	const le = /(\d+(?:\.\d+)?)b[-_](\d+)e\b/i.exec(name);
	if (le) return { moe: true, active: Number(le[1]) * GB };
	// A distill has its student's architecture: "MiMo-V2.6-Distill-Qwen-9B" is a dense 9B Qwen, not a mixture of experts.
	if (/distill/.test(n) && !/\bmoe\b/.test(n)) return { moe: false };
	if (/\bmoe\b|mixtral|deepseek-v[2-9]|deepseek-r1(?!-distill)|kimi-k[2-9]|glm-4\.[5-9](?!v)|glm-[5-9](?![.\d]*-?flash)|minimax-m\d|qwen3-?coder-?480|qwen3[.\d]*-?next|llama-?4|hunyuan-a|ling-|ring-|ernie-4\.5-.*a|mimo-v2/.test(n)) return { moe: true, active: params ? params * 0.1 : undefined };
	return { moe: false };
}

/** Rough memory bandwidth (GB/s) of where the weights live. */
export function bandwidth(m: Machine): { gpu: number; cpu: number } {
	// Drivers spell it "Intel(R) Arc(TM) A770 Graphics": drop the marks so the patterns below see "arc a770".
	const g = (m.gpuName || '').toLowerCase().replace(/\((r|tm)\)/g, '');
	let gpu = 0;
	if (/rtx\s*50/.test(g)) gpu = 900;
	else if (/rtx\s*40[89]0/.test(g)) gpu = 800;
	else if (/rtx\s*40/.test(g)) gpu = 400;
	else if (/rtx\s*30[89]0/.test(g)) gpu = 850;
	else if (/rtx\s*30/.test(g)) gpu = 400;
	else if (/rtx|gtx|quadro|tesla|a100|h100|l40/.test(g)) gpu = 450;
	else if (/radeon rx\s*[79]\d{3}|rx\s*7\d{3}/.test(g)) gpu = 550;
	else if (/arc\s*(a7|a5|b5|b7)/.test(g)) gpu = 450;
	else if (/arc\s*[ab]3\d0/.test(g)) gpu = 180;
	else if (/m\d\s*ultra/.test(g) || /ultra/.test(g) && m.unifiedMemory) gpu = 750;
	else if (/m\d\s*max/.test(g)) gpu = 400;
	else if (/m\d\s*pro/.test(g)) gpu = 200;
	else if (/apple|m[1-5]\b/.test(g) || (m.unifiedMemory && m.platform === 'darwin')) gpu = 100;
	else if (/arc.*1[34]0[vt]|lunar|arrow/.test(g)) gpu = 120;
	else if (/890m|880m|8060s|strix/.test(g)) gpu = 120;
	else if (/780m|760m|680m/.test(g)) gpu = 85;
	else if (g) gpu = 70;
	const cpu = m.unifiedMemory ? Math.max(gpu, 90) : /arc.*1[34]0[vt]|lunar|arrow|890m|8060s/.test(g) ? 110 : 60;
	return { gpu, cpu };
}

/** Bits per weight of common quants → the best quant for a byte budget. */
const QUANTS: Array<[string, number]> = [
	['Q8_0', 8.5],
	['Q6_K', 6.6],
	['Q5_K_M', 5.7],
	['Q4_K_M', 4.85],
	['IQ4_XS', 4.3],
	['Q3_K_M', 3.9],
	['IQ3_M', 3.7],
	['IQ3_XXS', 3.1],
	['IQ2_M', 2.7],
	['IQ2_XS', 2.4],
	['IQ1_M', 1.8]
];
export function quantForBudget(params: number, bytes: number): string | undefined {
	const bits = (bytes * 8) / params;
	return QUANTS.find(([, b]) => b <= bits)?.[0];
}

/** KV cache bytes per token (f16), estimated from model size (GQA models). */
function kvPerToken(params: number): number {
	return 16384 * Math.pow(Math.max(0.5, params / GB), 0.8);
}

export function planTurbo(input: TurboInput): TurboPlan {
	const m = input.machine;
	const size = input.sizeBytes;
	const params = input.params ?? (size * 8) / 4.85; // unknown: assume a Q4_K_M file
	const { moe, active } = moeInfo(input.name, params);
	const activeParams = active ?? (moe ? params * 0.1 : params);
	const bytesPerParam = size / params;
	const activeBytes = activeParams * bytesPerParam;
	const bw = bandwidth(m);
	const fast = m.fastBudgetBytes; // GPU (or comfortable share of RAM)
	const ramPlusGpu = m.unifiedMemory ? m.ceilingBytes : Math.floor(m.totalMemoryBytes * 0.8) + (integratedGpu(m.gpuName) ? 0 : m.gpuMemoryBytes ?? 0);
	const notes: string[] = [];
	const flags: string[] = [];
	const want = input.context ?? 16384;
	// Context + KV precision: full precision only when everything already fits on the GPU; split plans use 8-bit so the GPU holds more weights.
	const kvTok = input.shape?.kvBytesPerToken ?? kvPerToken(moe ? Math.sqrt(params * activeParams) : params);
	const weights = size * 1.03 + (input.projectorBytes ?? 0) + 0.35 * GB;
	const choose = (room: number, full = false): { ctx: number; kv: TurboPlan['kv'] } => {
		for (const [kv, k] of (full ? [['f16', 1], ['q8_0', 0.5], ['q4_0', 0.28]] : [['q8_0', 0.5], ['q4_0', 0.28]]) as ReadonlyArray<readonly [TurboPlan['kv'], number]>) {
			for (const ctx of [want, 16384, 8192, 4096]) {
				if (ctx <= want && weights + ctx * kvTok * k <= room) return { ctx, kv };
			}
		}
		return { ctx: 4096, kv: 'q4_0' };
	};

	const gpuTokS = bw.gpu ? (bw.gpu * GB) / activeBytes * 0.7 : 0;
	const cpuTokS = ((bw.cpu * GB) / activeBytes) * 0.6;
	let tier: TurboTier;
	let label: string;
	let est: number;
	let base: number;
	let kv: TurboPlan['kv'] = 'q8_0';
	let ctx = want;

	if (weights + want * kvTok <= fast) {
		// Fits with a full-precision cache: the engine's own auto-fit is already the best
		// plan (it also picks a bigger context than ours), so Turbo adds nothing here.
		tier = 'gpu';
		label = bw.gpu ? 'Fits on the GPU — no Turbo needed' : 'Fits in memory — no Turbo needed';
		kv = 'f16';
		est = bw.gpu ? gpuTokS : cpuTokS;
		base = est;
	} else if (weights + 4096 * kvTok * 0.28 <= fast) {
		// Weights fit, the cache for the wanted context does not: quantise the cache only.
		({ ctx, kv } = choose(fast, true));
		tier = 'gpu';
		label = bw.gpu ? 'Fits on the GPU with a compact cache' : 'Fits in memory with a compact cache';
		est = bw.gpu ? gpuTokS : cpuTokS;
		base = est * 0.97;
		notes.push(kv === 'q4_0' ? '4-bit KV cache keeps a long context on the GPU.' : kv === 'q8_0' ? '8-bit KV cache: half the memory, near-identical output.' : 'Full context fits.');
	} else if (moe && weights + 4096 * kvTok * 0.28 <= ramPlusGpu && bw.gpu && !integratedGpu(m.gpuName) && !m.unifiedMemory) {
		// Experts to RAM, attention + shared weights on the GPU.
		tier = 'hybrid';
		label = 'GPU + RAM (MoE experts offloaded)';
		const expertShare = 0.85;
		const onCpu = Math.min(1, Math.max(0, (size * 1.03 - fast * 0.9) / (size * expertShare)));
		flags.push(...(onCpu > 0.8 || !input.shape?.layers ? ['--cpu-moe'] : ['--n-cpu-moe', String(Math.max(1, Math.ceil(onCpu * input.shape.layers)))]));
		({ ctx, kv } = choose(ramPlusGpu));
		const cpuPart = activeBytes * expertShare * onCpu;
		const gpuPart = activeBytes - cpuPart;
		est = 1 / (gpuPart / (bw.gpu * GB * 0.7) + cpuPart / (bw.cpu * GB * 0.6));
		base = 1 / (Math.max(0, (size - fast) / size) * activeBytes / (bw.cpu * GB * 0.6) + Math.min(1, fast / size) * activeBytes / (bw.gpu * GB * 0.7)) * 0.7;
		notes.push(`About ${(activeParams / GB).toFixed(1)}B of ${(params / GB).toFixed(0)}B parameters are active per token. Expert offload trades GPU memory for CPU work; benchmark this machine.`);
	} else if (weights + 4096 * kvTok * 0.28 <= ramPlusGpu) {
		tier = 'ram';
		// A chip that shares system memory has no second, faster pool to split into: measured on an Arc 140T,
		// a model divided between chip and processor wrote slower than on either alone (localCatalog FIT.sharedSpill).
		const shared = !!bw.gpu && (m.unifiedMemory || integratedGpu(m.gpuName));
		label = shared ? 'Larger than graphics memory — runs slower' : bw.gpu ? 'Split GPU + RAM' : 'Runs from RAM';
		({ ctx, kv } = choose(ramPlusGpu));
		const gpuShare = bw.gpu ? Math.min(1, fast / size) : 0;
		est = shared ? gpuTokS * SHARED_SPILL : 1 / ((gpuShare * activeBytes) / (Math.max(1, bw.gpu) * GB * 0.7) + ((1 - gpuShare) * activeBytes) / (bw.cpu * GB * 0.6));
		base = shared ? est : est * 0.9;
		notes.push(shared ? 'The graphics chip and the processor read the same memory here, so dividing the model between them gains nothing. A smaller build is the faster choice.' : moe ? 'Active experts reduce weight traffic.' : 'Dense model: every layer is read for each token, so the RAM part sets the speed.');
	} else if (size <= (m.freeDiskBytes ?? 0) && size <= m.totalMemoryBytes * 2.5) {
		tier = 'disk';
		label = 'Streams from disk (very slow)';
		({ ctx, kv } = choose(ramPlusGpu));
		est = Math.min(cpuTokS, 1.5 * GB / activeBytes);
		base = est;
		notes.push('The model is larger than memory. Choose a smaller quantisation or model; automatic loading avoids disk paging.');
	} else {
		tier = 'no';
		label = 'Too large for this machine';
		est = 0;
		base = 0;
	}

	// "Fits as is" gets no flags: --fit on in the engine already does better.
	const plain = tier === 'gpu' && kv === 'f16';
	if (tier !== 'no' && tier !== 'disk' && !plain) {
		flags.push('-ctk', kv, '-ctv', kv, '-c', String(ctx));
	}
	const suggestQuant = tier === 'gpu' ? undefined : quantForBudget(params, fast * 0.85);
	if (suggestQuant && tier !== 'gpu') notes.push(`A ${suggestQuant} build (~${((params * (QUANTS.find((q) => q[0] === suggestQuant)![1])) / 8 / GB).toFixed(1)} GB) would run fully fast here.`);
	return { tier, label, flags, context: ctx, kv, moe, activeParams: moe ? activeParams : undefined, baseTokS: Math.round(base * 10) / 10, estTokS: Math.round(est * 10) / 10, specBoost: 1, suggestQuant, notes };
}
