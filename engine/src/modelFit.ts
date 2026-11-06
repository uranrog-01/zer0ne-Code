import * as fs from 'fs';
import type { Machine } from './localModels';
import { integratedGpu } from './localModels';
import { moeInfo } from './turboFit';
import { draftArchitecture } from './repoFiles';

const GiB = 1024 ** 3;
export type CacheType = 'f16' | 'q8_0' | 'q4_0';
export interface ModelShape {
	context?: number;
	layers?: number;
	kvBytesPerToken?: number;
	experts?: number;
	expertsUsed?: number;
	/** `general.architecture`, as the file states it. */
	arch?: string;
	/** A draft head: it speeds another model up and cannot answer by itself. */
	draft?: boolean;
	/** A full model that carries next-token layers inside (the "…-MTP" builds): it can draft for itself. */
	mtp?: boolean;
}
const shapes = new Map<string, { size: number; mtime: number; shape: ModelShape }>();

/**
 * The shape in the first bytes of a GGUF file, wherever they came from (the file on disk, or a
 * ranged request to Hugging Face before anything is downloaded). Tokenizer arrays and tensor
 * data never become JS objects; a header cut short still yields the fields read so far.
 */
export function parseModelShape(b: Buffer, read = b.length): ModelShape {
	const values = new Map<string, number | string>();
	try {
		let pos = 0;
		const take = (n: number) => {
			if (!Number.isSafeInteger(n) || n < 0 || pos + n > read) throw new Error('Incomplete GGUF header');
			const start = pos; pos += n; return start;
		};
		const u32 = () => b.readUInt32LE(take(4));
		const u64 = () => { const n = Number(b.readBigUInt64LE(take(8))); if (!Number.isSafeInteger(n)) throw new Error('GGUF length'); return n; };
		const str = (keep = true) => { const n = u64(); const p = take(n); return keep ? b.toString('utf8', p, p + n) : ''; };
		const sizes = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8];
		const skip = (type: number): void => {
			if (type === 8) { str(false); return; }
			if (type === 9) {
				const element = u32(), count = u64();
				if (element === 9 || count > 2_000_000) throw new Error('GGUF array');
				if (element === 8) { for (let i = 0; i < count; i++) str(false); }
				else if (sizes[element]) take(count * sizes[element]);
				else throw new Error('GGUF type');
				return;
			}
			if (!sizes[type]) throw new Error('GGUF type');
			take(sizes[type]);
		};
		if (u32() !== 0x46554747 || ![2, 3].includes(u32())) return {};
		u64(); const count = u64();
		if (count > 100_000) return {};
		try {
			for (let i = 0; i < count; i++) {
				const key = str(), type = u32();
				if (key === 'general.architecture' && type === 8) values.set(key, str());
				else if (type === 4) values.set(key, u32());
				else if (type === 10) values.set(key, u64());
				else skip(type);
			}
		} catch { /* Architecture fields already read remain useful when a tokenizer exceeds the header cap. */ }
		const arch = values.get('general.architecture');
		const get = (key: string) => { const n = values.get(`${arch}.${key}`); return typeof n === 'number' && n > 0 && n < 1e9 ? n : undefined; };
		const layers = get('block_count'), heads = get('attention.head_count'), kvHeads = get('attention.head_count_kv') ?? heads;
		const dim = heads ? (get('embedding_length') ?? 0) / heads : 0;
		const key = get('attention.key_length') ?? dim, value = get('attention.value_length') ?? dim;
		// Hybrid / sliding-window architectures use an upper bound; the native fitter measures their real buffers.
		const kvBytesPerToken = layers && kvHeads && key && value ? 2 * layers * kvHeads * (key + value) : undefined;
		// A draft head states it itself: Gemma's is "gemma4-assistant", and nothing but next-token layers.
		// A full model that carries such layers inside is still a model.
		const next = get('nextn_predict_layers');
		const draft = typeof arch === 'string' && (draftArchitecture(arch) || (!!next && !!layers && layers <= next));
		return { context: get('context_length'), layers, kvBytesPerToken, experts: get('expert_count'), expertsUsed: get('expert_used_count'), arch: typeof arch === 'string' ? arch : undefined, ...(draft ? { draft } : next ? { mtp: true } : {}) };
	} catch { return {}; }
}

/** Read only a bounded GGUF header from a file on disk. */
export function readModelShape(file: string): ModelShape {
	let fd: number | undefined;
	try {
		const stat = fs.statSync(file);
		const hit = shapes.get(file);
		if (hit?.size === stat.size && hit.mtime === stat.mtimeMs) return hit.shape;
		fd = fs.openSync(file, 'r');
		const b = Buffer.alloc(Math.min(stat.size, 16 * 1024 * 1024));
		const shape = parseModelShape(b, fs.readSync(fd, b, 0, b.length, 0));
		if (shapes.size >= 128) shapes.clear();
		shapes.set(file, { size: stat.size, mtime: stat.mtimeMs, shape });
		return shape;
	} catch { return {}; }
	finally { if (fd !== undefined) fs.closeSync(fd); }
}

export interface ModelPlan {
	context: number;
	kv: CacheType;
	threads: number;
	batchThreads: number;
	batch: number;
	ubatch: number;
	memoryBytes: number;
	budgetBytes: number;
	fits: boolean;
	cpuExpertLayers: number;
	contextReduced: boolean;
	/** false = plain attention (`-fa off`), which needs the 16-bit cache. Unset = the engine decides. */
	flash?: boolean;
	/** Every layer on the processor although a graphics chip is there (a measured choice). */
	cpu?: boolean;
}

/**
 * Flash attention with an 8-bit cache halves the cache, but on integrated graphics it is not always
 * the faster one. Measured on an Arc 140T (Vulkan, llama.cpp b11541, 16K context), flash against
 * plain attention with a 16-bit cache:
 *
 *   Qwen3 1.7B        first read of 5,200 tokens 8.4 s → 4.4 s, a follow-up turn 1.7 s → 0.7 s
 *   Qwen2.5 Coder 7B  first read 22 s → 15 s, a follow-up turn 3.1 s → 2.2 s
 *   Qwen3.5 2B        first read 6.4 s → 4.8 s, a follow-up turn 1.9 s either way
 *                     (a 9B of that family, earlier: 17,500 tokens in 107 s → 56 s)
 *   Gemma 4 E4B       first read 32 s → 15 s, but a follow-up turn 4 s → 8 s and a short chat 0.4 s → 2.9 s
 *
 * Writing speed was the same in every case. So plain attention is the default only for the
 * architectures it was measured faster on at both; for any other model Tune for speed measures a
 * first read and a follow-up turn under each mode and keeps the better (localTune.ts).
 */
const PLAIN_FASTER = /^qwen(2|3|35)$/;
export function prefersPlainAttention(m: Machine, backend: string | undefined, arch: string | undefined): boolean {
	return backend === 'vulkan' && !m.unifiedMemory && integratedGpu(m.gpuName) && !!arch && PLAIN_FASTER.test(arch);
}

/** Machine defaults are estimates; --fit remains the final authority on device allocation. */
export function fitModel(input: { name: string; sizeBytes: number; projectorBytes?: number; machine: Machine; freeMemoryBytes: number; context: number; lightKv: boolean; cpu?: boolean; shape?: ModelShape; cacheRamMiB?: number; turbo?: boolean; expertOffload?: boolean; plainAttention?: boolean }): ModelPlan {
	const { machine: m } = input;
	const shape = input.shape ?? {};
	const discrete = !input.cpu && !!m.gpuMemoryBytes && !m.unifiedMemory && !integratedGpu(m.gpuName);
	const reserve = Math.max(GiB, m.totalMemoryBytes * 0.08);
	const ram = Math.max(0, Math.min(m.totalMemoryBytes * 0.8, input.freeMemoryBytes - reserve));
	const vram = discrete ? m.gpuMemoryBytes! * 0.85 : 0;
	const budgetBytes = ram + vram;
	const weights = input.sizeBytes * 1.03 + (input.projectorBytes ?? 0);
	const overhead = 384 * 1024 ** 2 + (input.cacheRamMiB ?? 0) * 1024 ** 2;
	const params = input.sizeBytes * 8 / 4.85 / 1e9;
	const perToken = shape.kvBytesPerToken ?? 16384 * Math.pow(Math.max(0.5, params), 0.8);
	const want = Math.max(512, Math.min(input.context || 16384, shape.context ?? Infinity));
	const contexts = [want, 32768, 16384, 8192, 4096, 2048].filter((n, i, a) => n <= want && a.indexOf(n) === i).sort((a, b) => b - a);
	// Prefer 8-bit output quality; 4-bit is an explicit Turbo Fit choice with a smaller cache.
	const caches: Array<[CacheType, number]> = input.lightKv ? [['q8_0', 34 / 64], ...(input.turbo ? [['q4_0', 18 / 64] as [CacheType, number]] : [])] : [['f16', 1]];
	const gpu = !input.cpu && !!m.gpuName;
	const fastBudget = Math.min(budgetBytes, discrete ? vram : m.fastBudgetBytes);
	let selected: { context: number; kv: CacheType; memoryBytes: number } | undefined;
	for (const target of [fastBudget, budgetBytes]) {
		for (const [kv, ratio] of caches) {
			for (const context of contexts) {
				const memoryBytes = weights + overhead + perToken * ratio * context;
				if (memoryBytes <= target) { selected = { context, kv, memoryBytes }; break; }
			}
			if (selected) break;
		}
		if (selected) break;
	}
	const [kv, ratio] = caches[0];
	const chosen = selected ?? { context: contexts[contexts.length - 1], kv, memoryBytes: weights + overhead + perToken * ratio * contexts[contexts.length - 1] };
	const moe = !!shape.experts || moeInfo(input.name).moe;
	// On an iGPU experts and attention share RAM bandwidth; CPU offload is only automatic for discrete GPUs.
	const expertBytes = input.sizeBytes * 0.85;
	const cpuExpertLayers = input.expertOffload !== false && discrete && moe && shape.layers && selected && chosen.memoryBytes > vram
		? Math.min(shape.layers, Math.ceil(Math.max(0, chosen.memoryBytes - vram) / expertBytes * shape.layers)) : 0;
	const threads = Math.max(1, Math.min(m.cores, gpu && !cpuExpertLayers ? 4 : Math.max(1, Math.ceil(m.cores / 2))));
	const tight = !selected || chosen.memoryBytes > budgetBytes * 0.85;
	const ubatch = tight || ram < 4 * GiB ? 128 : gpu && ram >= 12 * GiB ? 512 : 256;
	const plan: ModelPlan = { ...chosen, budgetBytes, fits: !!selected, threads, batchThreads: Math.max(1, Math.min(m.cores, 16)), batch: ubatch * 4, ubatch, cpuExpertLayers, contextReduced: chosen.context < want };
	// Plain attention never costs context: it is taken only when the 16-bit cache fits fast memory as it is.
	const full = weights + overhead + perToken * chosen.context;
	if (input.plainAttention && gpu && selected && !input.turbo && full <= fastBudget) return { ...plan, kv: 'f16', memoryBytes: full, flash: false };
	return plan;
}
