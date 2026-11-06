import type { Machine } from './localModels';
import { integratedGpu } from './localModels';
import { modelFiles } from './repoFiles';
export { integratedGpu } from './localModels';
import { bandwidth as tableBandwidth, moeInfo } from './turboFit';

/**
 * Local models by what they are for — Coding, Images, Videos, Voice — rated
 * strictly for ONE machine, so the list shows what runs here fast, not what
 * merely starts.
 *
 * The method follows llmfit (MIT, github.com/AlexsJones/llmfit):
 *  - fit is how full the fast memory pool gets: ≤60% perfect, ≤85% good,
 *    ≤98% marginal, more = it will not load cleanly;
 *  - generation speed is memory-bandwidth bound: bandwidth / bytes read per
 *    token × 0.55 (active parameters only for mixture-of-experts);
 *  - the quantisation is chosen per machine — the best one that still fits;
 *  - measurements replace estimates: the machine check measures memory speed,
 *    and benchmarks / real chats / real generations calibrate everything.
 *
 * Images and videos run in stable-diffusion.cpp (MIT, ggml like llama.cpp):
 * a bundle is the diffusion model + VAE + text encoder it needs, with exact
 * Hugging Face files and sizes. Diffusion is compute bound, so its time is
 * FLOPs per step × steps over the GPU's effective throughput.
 *
 * Everything here is pure (machine numbers in, ratings out) and tested.
 */

export type Category = 'coding' | 'images' | 'videos' | 'voice';
export const CATEGORIES: ReadonlyArray<{ id: Category; label: string; blurb: string }> = [
	{ id: 'coding', label: 'Chat & coding', blurb: 'Chat, reasoning, writing, coding and vision models, fitted to this computer.' },
	{ id: 'images', label: 'Images', blurb: 'Text-to-image models: describe a picture, get it in seconds.' },
	{ id: 'videos', label: 'Videos', blurb: 'Text-to-video models: short clips from a sentence.' },
	{ id: 'voice', label: 'Voice', blurb: 'Text to speech: natural voices that read your text aloud, on this computer.' }
];

const GB = 1e9;

// ---------------------------------------------------------------- catalog

/** A language model (llama.cpp / zer0ne Engine). Files are picked per machine from the repo at download time. */
export interface LlmSeed {
	id: string;
	name: string;
	repo: string;
	family: string;
	/** Total parameters, billions. */
	params: number;
	/** Active parameters per token (mixture-of-experts), billions. */
	active?: number;
	/** Size of the repo's Q4_K_M file (bytes / 1e9) — other quants scale by bits per weight. */
	q4Gb: number;
	/** The vision projector (mmproj) — the model can read images. */
	mmprojGb?: number;
	ctx: number;
	released: string;
	tools: boolean;
	/** How capable it is at each job, 0–100 (relative, for ranking). */
	quality: Partial<Record<'coding', number>>;
	blurb: string;
	license: string;
	/** Only these quants make sense (gpt-oss ships its experts in MXFP4: every file is the same size). */
	quants?: string[];
	/** Found on Hugging Face just now (not in the curated list). */
	fresh?: boolean;
	downloads?: number;
	modelId?: string;
	source?: 'llmfit' | 'huggingface';
	verified?: boolean;
	arch?: string;
	kvBytes?: number;
	advisor?: { quant: string; tokS?: number; confidence: string; score: number };
	runtimeReason?: string;
	files?: import('./localEngine').HfFile[];
}

export type DiffusionRole = 'model' | 'diffusion' | 'vae' | 'llm' | 't5xxl' | 'audio-vae' | 'connectors';
export interface DiffusionFile {
	role: DiffusionRole;
	repo: string;
	file: string;
	bytes: number;
}

/** An image or video model for stable-diffusion.cpp: every file it needs, and how to run it well. */
export interface DiffusionBundle {
	id: string;
	name: string;
	kind: 'image' | 'video';
	/** Diffusion parameters, billions. */
	params: number;
	/** Pixels per latent token side (VAE stride × patch): 16 for Flux/Z-Image/Wan 2.1, 32 for Wan 2.2 5B / LTX. 0 = UNet (SD 1.x). */
	patch: number;
	/**
	 * Image-decoder (VAE) cost: TFLOP·s per megapixel of output. Measured on an Arc 140T, the
	 * decode can take as long as the sampling (FLUX.2's 32-channel VAE: 20 s at 512²).
	 */
	vaeCost: number;
	/** Frames per latent frame (video VAEs compress time): 4 for Wan, 8 for LTX. */
	temporal?: number;
	steps: number;
	cfg: number;
	sampler?: string;
	flowShift?: number;
	/** Sizes to choose from, largest first: the machine gets the largest that is still quick. */
	sizes: Array<[number, number]>;
	frames?: number;
	fps?: number;
	negative?: string;
	files: DiffusionFile[];
	quality: Partial<Record<Category, number>>;
	blurb: string;
	license: string;
	released: string;
	/** Commercial use not allowed by the license. */
	nonCommercial?: boolean;
}

/**
 * Curated language models (Hugging Face, Q4_K_M sizes read from the repos on
 * 2026-10-05). All run in the pinned engine build (b11169, 2026-09-24). The
 * quality numbers rank models against each other for one job; they are not a
 * benchmark score.
 */
export const LLM_SEEDS: ReadonlyArray<LlmSeed> = [
	// File sizes and available quants checked against the publisher repositories on 2026-10-10.
	{ id: 'qwen3-1.7b', arch: 'qwen3', modelId: 'Qwen/Qwen3-1.7B', name: 'Qwen3 1.7B', repo: 'unsloth/Qwen3-1.7B-GGUF', family: 'qwen', params: 1.72, q4Gb: 1.107409472, ctx: 40960, released: '2025-04', tools: true, quality: { coding: 36 }, blurb: 'Lightweight text coder with tools — small fixes and explanations on modest machines.', license: 'apache-2.0' },
	{ id: 'granite-3.3-2b', arch: 'granite', modelId: 'ibm-granite/granite-3.3-2b-instruct', name: 'Granite 3.3 2B', repo: 'ibm-granite/granite-3.3-2b-instruct-GGUF', family: 'granite', params: 2.53, q4Gb: 1.545303328, quants: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M'], ctx: 131072, released: '2025-04', tools: true, quality: { coding: 38 }, blurb: 'IBM’s compact assistant — code questions, small edits and function calling.', license: 'apache-2.0' },
	{ id: 'qwen3-4b-instruct', arch: 'qwen3', modelId: 'Qwen/Qwen3-4B-Instruct-2507', name: 'Qwen3 4B Instruct', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', family: 'qwen', params: 4.02, q4Gb: 2.49728112, ctx: 262144, released: '2025-07', tools: true, quality: { coding: 51 }, blurb: 'Text-only coding and tool use without a separate thinking phase.', license: 'apache-2.0' },
	{ id: 'qwen3-8b', arch: 'qwen3', modelId: 'Qwen/Qwen3-8B', name: 'Qwen3 8B', repo: 'Qwen/Qwen3-8B-GGUF', family: 'qwen', params: 8.19, q4Gb: 5.027783488, quants: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M'], ctx: 40960, released: '2025-04', tools: true, quality: { coding: 57 }, blurb: 'Text reasoning and coding with tools — more capacity for multi-step tasks.', license: 'apache-2.0' },
	{ id: 'granite-3.3-8b', arch: 'granite', modelId: 'ibm-granite/granite-3.3-8b-instruct', name: 'Granite 3.3 8B', repo: 'ibm-granite/granite-3.3-8b-instruct-GGUF', family: 'granite', params: 8.17, q4Gb: 4.942873344, quants: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M'], ctx: 131072, released: '2025-04', tools: true, quality: { coding: 54 }, blurb: 'IBM’s larger text assistant — code, structured instructions and function calling.', license: 'apache-2.0' },
	{ id: 'qwen3-14b', arch: 'qwen3', modelId: 'Qwen/Qwen3-14B', name: 'Qwen3 14B', repo: 'Qwen/Qwen3-14B-GGUF', family: 'qwen', params: 14.77, q4Gb: 9.00175296, quants: ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M'], ctx: 40960, released: '2025-04', tools: true, quality: { coding: 66 }, blurb: 'Larger text coder — context is shortened when needed to leave room for the model.', license: 'apache-2.0' },
	{ id: 'qwen3-vl-2b', arch: 'qwen3vl', modelId: 'Qwen/Qwen3-VL-2B-Instruct', name: 'Qwen3-VL 2B Instruct', repo: 'Qwen/Qwen3-VL-2B-Instruct-GGUF', family: 'qwen', params: 1.72, q4Gb: 1.107409952, mmprojGb: 0.445053216, quants: ['Q8_0', 'Q4_K_M'], ctx: 262144, released: '2025-10', tools: true, quality: { coding: 38 }, blurb: 'Small screenshot reader — explain a mockup or turn a simple layout into UI code.', license: 'apache-2.0' },
	{ id: 'qwen3-vl-4b', arch: 'qwen3vl', modelId: 'Qwen/Qwen3-VL-4B-Instruct', name: 'Qwen3-VL 4B Instruct', repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF', family: 'qwen', params: 4.02, q4Gb: 2.497281664, mmprojGb: 0.453974304, quants: ['Q8_0', 'Q4_K_M'], ctx: 262144, released: '2025-10', tools: true, quality: { coding: 50 }, blurb: 'Screenshot and mockup specialist — inspect spacing, charts and visual UI details.', license: 'apache-2.0' },
	{ id: 'qwen3.5-2b', arch: 'qwen35', modelId: 'Qwen/Qwen3.5-2B', name: 'Qwen 3.5 2B', repo: 'unsloth/Qwen3.5-2B-GGUF', family: 'qwen', params: 2.0, q4Gb: 1.28, mmprojGb: 0.67, ctx: 262144, released: '2026-03', tools: true, quality: { coding: 34 }, blurb: 'Tiny and quick — small edits, questions, autocomplete.', license: 'apache-2.0' },
	{ id: 'gemma-4-e2b', arch: 'gemma4', modelId: 'google/gemma-4-E2B-it', name: 'Gemma 4 E2B', repo: 'unsloth/gemma-4-E2B-it-GGUF', family: 'gemma', params: 4.6, active: 2.3, q4Gb: 3.11, mmprojGb: 0.99, ctx: 131072, released: '2026-04', tools: true, quality: { coding: 33 }, blurb: 'Google’s phone-class model — sees images, light chat.', license: 'apache-2.0' },
	{ id: 'qwen3.5-4b', arch: 'qwen35', modelId: 'Qwen/Qwen3.5-4B', name: 'Qwen 3.5 4B', repo: 'unsloth/Qwen3.5-4B-GGUF', family: 'qwen', params: 4.2, q4Gb: 2.74, mmprojGb: 0.67, ctx: 262144, released: '2026-03', tools: true, quality: { coding: 52 }, blurb: 'Smallest model that really drives the agent: tools, edits, reads screenshots.', license: 'apache-2.0' },
	{ id: 'gemma-4-e4b', arch: 'gemma4', modelId: 'google/gemma-4-E4B-it', name: 'Gemma 4 E4B', repo: 'unsloth/gemma-4-E4B-it-GGUF', family: 'gemma', params: 7.5, active: 4.5, q4Gb: 4.98, mmprojGb: 0.99, ctx: 131072, released: '2026-04', tools: true, quality: { coding: 48 }, blurb: 'Laptop-class Gemma — balanced chat and vision.', license: 'apache-2.0' },
	{ id: 'qwen3-vl-8b', arch: 'qwen3vl', modelId: 'Qwen/Qwen3-VL-8B-Instruct', name: 'Qwen3-VL 8B', repo: 'unsloth/Qwen3-VL-8B-Instruct-GGUF', family: 'qwen', params: 8.2, q4Gb: 5.03, mmprojGb: 1.16, ctx: 262144, released: '2025-10', tools: true, quality: { coding: 46 }, blurb: 'Vision specialist — UI screenshots to HTML/CSS, reads charts and documents.', license: 'apache-2.0' },
	{ id: 'qwen3.5-9b', arch: 'qwen35', modelId: 'Qwen/Qwen3.5-9B', name: 'Qwen 3.5 9B', repo: 'unsloth/Qwen3.5-9B-GGUF', family: 'qwen', params: 9.0, q4Gb: 5.68, mmprojGb: 0.92, ctx: 262144, released: '2026-02', tools: true, quality: { coding: 64 }, blurb: 'The sweet spot for 8–16 GB: solid agent coding and vision.', license: 'apache-2.0' },
	{ id: 'gemma-4-12b', arch: 'gemma4', modelId: 'google/gemma-4-12B-it', name: 'Gemma 4 12B', repo: 'unsloth/gemma-4-12b-it-GGUF', family: 'gemma', params: 11.9, q4Gb: 7.12, mmprojGb: 0.18, ctx: 262144, released: '2026-05', tools: true, quality: { coding: 61 }, blurb: 'Strong all-rounder with a careful eye for layouts.', license: 'apache-2.0' },
	{ id: 'gpt-oss-20b', arch: 'gpt-oss', modelId: 'openai/gpt-oss-20b', name: 'gpt-oss 20B', repo: 'unsloth/gpt-oss-20b-GGUF', family: 'gpt-oss', params: 20.9, active: 3.6, q4Gb: 11.62, quants: ['Q4_K_M'], ctx: 131072, released: '2025-08', tools: true, quality: { coding: 64 }, blurb: 'OpenAI’s open reasoning model — fast for its size (mixture of experts).', license: 'apache-2.0' },
	{ id: 'devstral-small-2', arch: 'mistral3', modelId: 'mistralai/Devstral-Small-2-24B-Instruct-2512', name: 'Devstral Small 2 24B', repo: 'unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF', family: 'mistral', params: 23.6, q4Gb: 14.33, mmprojGb: 0.88, ctx: 393216, released: '2025-12', tools: true, quality: { coding: 74 }, blurb: 'Mistral’s model built for coding agents — multi-file edits.', license: 'other' },
	{ id: 'gemma-4-26b-a4b', arch: 'gemma4', modelId: 'google/gemma-4-26B-A4B-it', name: 'Gemma 4 26B A4B', repo: 'unsloth/gemma-4-26B-A4B-it-GGUF', family: 'gemma', params: 25.2, active: 4, q4Gb: 16.95, mmprojGb: 1.19, ctx: 262144, released: '2026-04', tools: true, quality: { coding: 70 }, blurb: 'Big-model quality at small-model speed (mixture of experts), with vision.', license: 'apache-2.0' },
	{ id: 'qwen3.6-27b', arch: 'qwen35', modelId: 'Qwen/Qwen3.6-27B', name: 'Qwen 3.6 27B', repo: 'unsloth/Qwen3.6-27B-GGUF', family: 'qwen', params: 26.9, q4Gb: 16.82, mmprojGb: 0.93, ctx: 262144, released: '2026-04', tools: true, quality: { coding: 80 }, blurb: 'Dense 27B — excellent agent coding on a 24 GB GPU.', license: 'apache-2.0' },
	{ id: 'qwen3.8-27b', arch: 'qwen35', modelId: 'Qwen/Qwen3.8-27B', name: 'Qwen 3.8 27B', repo: 'unsloth/Qwen3.8-27B-GGUF', family: 'qwen', params: 27.3, q4Gb: 16.46, mmprojGb: 0.93, ctx: 262144, released: '2026-08', tools: true, quality: { coding: 85 }, blurb: 'Newest Qwen dense model — top local coding quality.', license: 'apache-2.0' },
	{ id: 'glm-4.7-flash', arch: 'deepseek2', modelId: 'zai-org/GLM-4.7-Flash', name: 'GLM 4.7 Flash', repo: 'unsloth/GLM-4.7-Flash-GGUF', family: 'glm', params: 29.9, active: 3, q4Gb: 18.31, ctx: 202752, released: '2026-01', tools: true, quality: { coding: 75 }, blurb: 'Zhipu’s fast coder (mixture of experts) — great tool use.', license: 'mit' },
	{ id: 'qwen3-coder-30b-a3b', arch: 'qwen3moe', modelId: 'Qwen/Qwen3-Coder-30B-A3B-Instruct', name: 'Qwen3 Coder 30B A3B', repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', family: 'qwen', params: 30.5, active: 3.3, q4Gb: 18.56, ctx: 262144, released: '2025-07', tools: true, quality: { coding: 72 }, blurb: 'The popular local coding agent — fast mixture of experts.', license: 'apache-2.0' },
	{ id: 'qwen3.6-35b-a3b', arch: 'qwen35moe', modelId: 'Qwen/Qwen3.6-35B-A3B', name: 'Qwen 3.6 35B A3B', repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', family: 'qwen', params: 34.7, active: 3, q4Gb: 22.13, mmprojGb: 0.9, ctx: 262144, released: '2026-04', tools: true, quality: { coding: 78 }, blurb: 'Fast and smart: 35B of knowledge, 3B read per token, with vision.', license: 'apache-2.0' },
	{ id: 'qwen3-coder-next', arch: 'qwen3next', modelId: 'Qwen/Qwen3-Coder-Next', name: 'Qwen3 Coder Next 80B', repo: 'unsloth/Qwen3-Coder-Next-GGUF', family: 'qwen', params: 79.7, active: 3, q4Gb: 48.53, ctx: 262144, released: '2026-02', tools: true, quality: { coding: 86 }, blurb: 'Workstation coder — 80B mixture of experts, 3B active.', license: 'apache-2.0' }
];

const ZIMAGE_VAE: DiffusionFile = { role: 'vae', repo: 'Comfy-Org/z_image_turbo', file: 'split_files/vae/ae.safetensors', bytes: 335_304_388 };
const FLUX2_VAE: DiffusionFile = { role: 'vae', repo: 'Comfy-Org/flux2-klein-4B', file: 'split_files/vae/flux2-vae.safetensors', bytes: 336_213_556 };
const UMT5_Q4: DiffusionFile = { role: 't5xxl', repo: 'city96/umt5-xxl-encoder-gguf', file: 'umt5-xxl-encoder-Q4_K_M.gguf', bytes: 3_660_000_000 };
const VIDEO_NEGATIVE = 'blurry, low quality, static, still frame, distorted, deformed, extra limbs, watermark, subtitles, text';

/** Curated image and video models (exact Hugging Face files, sizes read 2026-10-05; none gated). */
export const DIFFUSION_BUNDLES: ReadonlyArray<DiffusionBundle> = [
	{
		id: 'sd15', vaeCost: 75, name: 'Stable Diffusion 1.5', kind: 'image', params: 0.86, patch: 0, steps: 20, cfg: 7, sampler: 'euler_a', sizes: [[512, 512]],
		files: [{ role: 'model', repo: 'second-state/stable-diffusion-v1-5-GGUF', file: 'stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf', bytes: 1_760_000_000 }],
		quality: { images: 30 }, blurb: 'The classic — small and quick on almost any GPU. Simple pictures, no readable text.', license: 'creativeml-openrail-m', released: '2022-10'
	},
	{
		id: 'z-image-turbo', vaeCost: 70, name: 'Z-Image Turbo', kind: 'image', params: 6.2, patch: 16, steps: 8, cfg: 1, sizes: [[1024, 1024], [768, 768], [512, 512]],
		files: [{ role: 'diffusion', repo: 'leejet/Z-Image-Turbo-GGUF', file: 'z_image_turbo-Q4_K.gguf', bytes: 3_860_000_000 }, ZIMAGE_VAE, { role: 'llm', repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', bytes: 2_500_000_000 }],
		quality: { images: 80 }, blurb: 'Photoreal in 8 steps, writes readable text — runs on 4 GB GPUs.', license: 'apache-2.0', released: '2025-11'
	},
	{
		id: 'flux2-klein-4b', vaeCost: 90, name: 'FLUX.2 klein 4B', kind: 'image', params: 4, patch: 16, steps: 4, cfg: 1, sampler: 'euler', sizes: [[1024, 1024], [768, 768], [512, 512]],
		files: [{ role: 'diffusion', repo: 'leejet/FLUX.2-klein-4B-GGUF', file: 'flux-2-klein-4b-Q4_0.gguf', bytes: 2_460_000_000 }, FLUX2_VAE, { role: 'llm', repo: 'unsloth/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', bytes: 2_500_000_000 }],
		quality: { images: 72 }, blurb: 'Black Forest Labs’ fastest — 4 steps, clean illustrations and products.', license: 'apache-2.0', released: '2026-01'
	},
	{
		id: 'flux2-klein-9b', vaeCost: 90, name: 'FLUX.2 klein 9B', kind: 'image', params: 9, patch: 16, steps: 4, cfg: 1, sampler: 'euler', sizes: [[1024, 1024], [768, 768], [512, 512]],
		files: [{ role: 'diffusion', repo: 'leejet/FLUX.2-klein-9B-GGUF', file: 'flux-2-klein-9b-Q4_0.gguf', bytes: 5_620_000_000 }, FLUX2_VAE, { role: 'llm', repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', bytes: 5_030_000_000 }],
		quality: { images: 84 }, blurb: 'Sharper FLUX.2 — detailed scenes in 4 steps. Non-commercial license.', license: 'flux-non-commercial', released: '2026-01', nonCommercial: true
	},
	{
		id: 'qwen-image-2.1', vaeCost: 60, name: 'Qwen-Image 2.1', kind: 'image', params: 7.1, patch: 16, steps: 20, cfg: 4, sampler: 'euler', sizes: [[1024, 1024], [768, 768]],
		files: [{ role: 'diffusion', repo: 'leejet/Qwen-Image-2.1-GGUF', file: 'qwen_image_2.1-Q4_K.gguf', bytes: 4_200_000_000 }, { role: 'vae', repo: 'Comfy-Org/Qwen-Image-2.1', file: 'vae/qwen_image_2.1_vae_bf16.safetensors', bytes: 680_000_000 }, { role: 'llm', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', file: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf', bytes: 5_030_000_000 }],
		quality: { images: 86 }, blurb: 'The best at text in images — posters, logos, UI mockups, menus, infographics.', license: 'see model page', released: '2026-09'
	},
	{
		id: 'wan2.1-1.3b', vaeCost: 30, name: 'Wan 2.1 1.3B', kind: 'video', params: 1.3, patch: 16, temporal: 4, steps: 20, cfg: 6, sampler: 'euler', flowShift: 3, sizes: [[832, 480], [480, 272]], frames: 33, fps: 16, negative: VIDEO_NEGATIVE,
		files: [{ role: 'diffusion', repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', file: 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', bytes: 2_840_000_000 }, { role: 'vae', repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', file: 'split_files/vae/wan_2.1_vae.safetensors', bytes: 254_000_000 }, UMT5_Q4],
		quality: { videos: 50 }, blurb: 'The light video model — 2-second clips on an 8 GB GPU.', license: 'apache-2.0', released: '2025-02'
	},
	{
		id: 'wan2.2-ti2v-5b', vaeCost: 45, name: 'Wan 2.2 5B', kind: 'video', params: 5, patch: 32, temporal: 4, steps: 20, cfg: 6, sampler: 'euler', flowShift: 3, sizes: [[832, 480], [640, 352]], frames: 33, fps: 16, negative: VIDEO_NEGATIVE,
		files: [{ role: 'diffusion', repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF', file: 'Wan2.2-TI2V-5B-Q4_K_M.gguf', bytes: 3_430_000_000 }, { role: 'vae', repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF', file: 'VAE/Wan2.2_VAE.safetensors', bytes: 1_410_000_000 }, UMT5_Q4],
		quality: { videos: 70 }, blurb: 'Better motion and detail — text or a start image to video.', license: 'apache-2.0', released: '2025-07'
	},
	{
		id: 'ltx-2.3', vaeCost: 35, name: 'LTX-2.3 Distilled', kind: 'video', params: 22, patch: 32, temporal: 8, steps: 8, cfg: 1, sampler: 'euler', sizes: [[768, 512], [640, 384]], frames: 49, fps: 24, negative: VIDEO_NEGATIVE,
		files: [
			{ role: 'diffusion', repo: 'unsloth/LTX-2.3-GGUF', file: 'distilled-1.1/ltx-2.3-22b-distilled-1.1-Q3_K_M.gguf', bytes: 10_630_000_000 },
			{ role: 'vae', repo: 'unsloth/LTX-2.3-GGUF', file: 'vae/ltx-2.3-22b-distilled_video_vae.safetensors', bytes: 1_450_000_000 },
			{ role: 'audio-vae', repo: 'unsloth/LTX-2.3-GGUF', file: 'vae/ltx-2.3-22b-distilled_audio_vae.safetensors', bytes: 360_000_000 },
			{ role: 'connectors', repo: 'unsloth/LTX-2.3-GGUF', file: 'text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors', bytes: 2_310_000_000 },
			{ role: 'llm', repo: 'unsloth/gemma-3-12b-it-qat-GGUF', file: 'gemma-3-12b-it-qat-Q4_K_M.gguf', bytes: 7_300_000_000 }
		],
		quality: { videos: 88 }, blurb: 'Cinematic clips with sound — workstation GPUs.', license: 'ltx-2-community', released: '2026-05'
	}
];

/** Which diffusion bundles appear under an image or video category. */
export function bundlesFor(cat: Category): DiffusionBundle[] {
	return DIFFUSION_BUNDLES.filter((b) => (cat === 'images' ? b.kind === 'image' : cat === 'videos' ? b.kind === 'video' : false));
}

export const bundleBytes = (b: DiffusionBundle) => b.files.reduce((n, f) => n + f.bytes, 0);

// ---------------------------------------------------------------- voices (text to speech)

/** A voice package for sherpa-onnx (one archive from its tts-models release). */
export interface VoiceBundle {
	id: string;
	name: string;
	engine: 'kokoro' | 'kitten' | 'vits';
	/** The release archive and the folder it unpacks to. */
	archive: string;
	folder: string;
	bytes: number;
	/** The archive's real size and SHA-256 in the tts-models release: a download is
	 *  only unpacked when it matches both (see downloadVoice). */
	archiveBytes: number;
	sha256: string;
	files: { model: string; tokens: string; data: string; voices?: string };
	speakers: Array<{ id: number; name: string; lang: string }>;
	/** Real-time factor measured with 8 threads on a 16-core laptop CPU (Core Ultra 9 285H): seconds of work per second of speech. */
	rtf: number;
	/** Memory while speaking, bytes. */
	memBytes: number;
	quality: number;
	langs: string;
	blurb: string;
	license: string;
	released: string;
}

/** Kokoro 1.0's speakers (the model's own id2speaker), by language prefix: a/b English US/UK, e Spanish, f French, h Hindi, i Italian, p Portuguese, z Chinese. */
const KOKORO_SPEAKERS = 'af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola,jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa,zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa'
	.split(',')
	.map((code, id) => {
		const lang = ({ a: 'en-us', b: 'en-gb', e: 'es', f: 'fr', h: 'hi', i: 'it', j: 'ja', p: 'pt-br', z: 'zh' } as Record<string, string>)[code[0]];
		const where = ({ a: 'US', b: 'UK', e: 'Spanish', f: 'French', h: 'Hindi', i: 'Italian', j: 'Japanese', p: 'Portuguese', z: 'Chinese' } as Record<string, string>)[code[0]];
		const name = code.slice(3).replace(/^./, (c) => c.toUpperCase());
		return { id, name: name + ' · ' + where + ' ' + (code[1] === 'f' ? 'female' : 'male'), lang };
	})
	// Kokoro 1.0 in sherpa-onnx reads Japanese only with a lexicon it does not ship: those voices stay out.
	.filter((v) => v.lang !== 'ja');

/** Curated voices (sherpa-onnx tts-models release, sizes read 2026-10-06; real-time factors measured on a Core Ultra 9 285H). */
export const VOICE_BUNDLES: ReadonlyArray<VoiceBundle> = [
	{
		id: 'kokoro', name: 'Kokoro', engine: 'kokoro', archive: 'kokoro-multi-lang-v1_0.tar.bz2', folder: 'kokoro-multi-lang-v1_0', bytes: 350_000_000,
		archiveBytes: 349_906_910, sha256: 'c5f7e2d2caf082bc1d20fb70334a61d99d20b484500aad32e7cf84c128ea3298',
		files: { model: 'model.onnx', voices: 'voices.bin', tokens: 'tokens.txt', data: 'espeak-ng-data' }, speakers: KOKORO_SPEAKERS, rtf: 0.22, memBytes: 1.3e9,
		quality: 90, langs: 'English, Spanish, French, Hindi, Italian, Portuguese, Chinese', blurb: 'The most natural local voice — 48 voices in 7 languages.', license: 'apache-2.0', released: '2025-01'
	},
	{
		id: 'kitten-mini', name: 'Kitten mini', engine: 'kitten', archive: 'kitten-mini-en-v0_8.tar.bz2', folder: 'kitten-mini-en-v0_8', bytes: 68_000_000,
		archiveBytes: 67_547_594, sha256: '518f9b130320f690d5b5476df77bde4215fca67773cda16710318e5081234b9d',
		files: { model: 'model.onnx', voices: 'voices.bin', tokens: 'tokens.txt', data: 'espeak-ng-data' },
		speakers: [2, 3, 4, 5].flatMap((n, i) => [{ id: i * 2, name: 'Voice ' + n + ' · male', lang: 'en-us' }, { id: i * 2 + 1, name: 'Voice ' + n + ' · female', lang: 'en-us' }]), rtf: 0.68, memBytes: 0.5e9,
		quality: 72, langs: 'English', blurb: 'Small and expressive — 8 English voices.', license: 'apache-2.0', released: '2026-05'
	},
	{
		id: 'piper-lessac', name: 'Piper Lessac', engine: 'vits', archive: 'vits-piper-en_US-lessac-medium-int8.tar.bz2', folder: 'vits-piper-en_US-lessac-medium-int8', bytes: 21_000_000,
		archiveBytes: 20_969_179, sha256: 'f1c6d0295cf16087b05f80fdca5b44daca5cd78e2c425d419a42ba34929805f9',
		files: { model: 'en_US-lessac-medium.onnx', tokens: 'tokens.txt', data: 'espeak-ng-data' }, speakers: [{ id: 0, name: 'Lessac · US female', lang: 'en-us' }], rtf: 0.16, memBytes: 0.25e9,
		quality: 62, langs: 'English (US)', blurb: 'Tiny and very fast — clear US English on any computer.', license: 'see model page', released: '2025-12'
	},
	{
		id: 'piper-alba', name: 'Piper Alba', engine: 'vits', archive: 'vits-piper-en_GB-alba-medium-int8.tar.bz2', folder: 'vits-piper-en_GB-alba-medium-int8', bytes: 21_000_000,
		archiveBytes: 21_104_326, sha256: 'f7581d123ae977f64f3032bb247d4deeac8440e881d918d36fdd36d8f1030fb7',
		files: { model: 'en_GB-alba-medium.onnx', tokens: 'tokens.txt', data: 'espeak-ng-data' }, speakers: [{ id: 0, name: 'Alba · UK female', lang: 'en-gb' }], rtf: 0.16, memBytes: 0.25e9,
		quality: 58, langs: 'English (UK)', blurb: 'Tiny and very fast — British English on any computer.', license: 'see model page', released: '2025-06'
	}
];

/** Threads the voice engine uses here: half the cores, 2 to 8 (more hurt on the measured laptop). */
export const voiceThreads = (cores: number) => Math.max(2, Math.min(8, Math.floor((cores || 4) / 2)));

// ---------------------------------------------------------------- machine

/** What the machine check measured (stored; refreshed on request). */
export interface MachineCheck {
	at: number;
	hardware?: string;
	/** Measured system-memory bandwidth, GB/s (multi-threaded copy). */
	ramGBs?: number;
	threads?: number;
	/** Measured / estimated generation speed over local models (1 = estimates were right). */
	llmFactor?: number;
	llmSamples?: number;
	/** Per diffusion bundle: measured / estimated seconds. */
	diffFactor?: Record<string, number>;
	/** The estimate formula the factors were learned against (CALIBRATION). */
	calibV?: number;
}

/** Bump when an estimate formula changes: factors learned against the old one no longer apply. */
export const CALIBRATION = 3;

export interface Profile {
	gpu: 'dedicated' | 'shared' | 'unified' | 'none';
	gpuName?: string;
	/** Bandwidth where the weights live when on the GPU, and of system RAM (GB/s). */
	gpuGBs: number;
	cpuGBs: number;
	/** Effective throughput for diffusion (TFLOPS actually achieved, not the peak). */
	tflops: number;
	fastBytes: number;
	ceilingBytes: number;
	ramBytes: number;
	/** Free right now, beside the limits above: for the "close other apps" warning, never for the rating. */
	availableRamBytes?: number;
	availableFastBytes?: number;
	diskBytes?: number;
	measured: boolean;
	llmFactor: number;
	diffFactor: Record<string, number>;
	tier: { id: 'entry' | 'standard' | 'strong' | 'workstation' | 'powerhouse'; label: string };
}

/**
 * Effective throughput (TFLOPS) a stable-diffusion.cpp run reaches on this GPU with its
 * default build (Vulkan on Windows / Linux, Metal on Apple) — far below the peak. Measured on
 * an Intel Arc 140T: 1.6 (SD 1.5), 1.8 (Wan 2.1), 4.3 (FLUX.2 klein) TFLOPS while sampling.
 * CUDA builds run faster, and real generations calibrate it per model (pure; tested).
 */
export function computeTflops(m: Pick<Machine, 'gpuName' | 'unifiedMemory' | 'platform' | 'cores'>): number {
	const g = (m.gpuName || '').toLowerCase().replace(/\((r|tm)\)/g, '');
	if (/rtx\s*pro\s*6000|h100|h200|b200/.test(g)) return 80;
	if (/rtx\s*5090/.test(g)) return 60;
	if (/rtx\s*5080/.test(g)) return 38;
	if (/rtx\s*50[67]0/.test(g)) return 22;
	if (/rtx\s*4090/.test(g)) return 45;
	if (/rtx\s*4080/.test(g)) return 30;
	if (/rtx\s*407/.test(g)) return 18;
	if (/rtx\s*40[56]/.test(g)) return 11;
	if (/rtx\s*309|rtx\s*308|a100|l40|a6000/.test(g)) return 22;
	if (/rtx\s*30[67]/.test(g)) return 11;
	if (/rtx\s*30[45]|rtx\s*20/.test(g)) return 6;
	if (/gtx|quadro|tesla|nvidia/.test(g)) return 3;
	if (/rx\s*9070|rx\s*7900/.test(g)) return 16;
	if (/rx\s*[79]\d{3}/.test(g)) return 8;
	if (/rx\s*6\d{3}|radeon pro/.test(g)) return 5;
	if (/8060s|strix halo|ai max/.test(g)) return 5;
	if (/arc\s*b5[78]0|arc\s*a7[57]0/.test(g)) return 9;
	if (/arc\s*(a5|a3|b3)/.test(g)) return 3.5;
	if (/m\d\s*ultra/.test(g)) return 20;
	if (/m\d\s*max/.test(g)) return 11;
	if (/m\d\s*pro/.test(g)) return 5.5;
	if (/apple|m[1-5]\b/.test(g) || (m.unifiedMemory && m.platform === 'darwin')) return 2.5;
	if (/arc.*1[34]0[vt]|lunar|arrow/.test(g)) return 2;
	if (/890m|880m/.test(g)) return 2.2;
	if (/780m|760m|680m/.test(g)) return 1.5;
	if (g) return 1;
	// CPU only: ~30 effective GFLOPS per core.
	return Math.max(0.15, (m.cores || 4) * 0.03);
}

/** Pure: the machine as the ratings see it — where weights live, how fast, which tier. */
export function machineProfile(m: Machine, check?: MachineCheck): Profile {
	const table = tableBandwidth(m);
	const dedicated = !m.unifiedMemory && !!m.gpuMemoryBytes && !integratedGpu(m.gpuName) && (/nvidia|geforce|rtx|quadro/i.test(m.gpuName ?? '') || m.gpuMemoryBytes >= 8 * 1024 ** 3);
	const gpu: Profile['gpu'] = m.unifiedMemory ? 'unified' : dedicated ? 'dedicated' : m.gpuName ? 'shared' : 'none';
	const ram = check?.ramGBs && check.ramGBs > 1 ? check.ramGBs : undefined;
	// A GPU that reads system RAM (integrated / unified) is limited by that RAM: the measurement wins over the name table.
	const gpuGBs = gpu === 'dedicated' ? table.gpu : gpu === 'none' ? 0 : ram ? Math.max(ram * 1.15, gpu === 'unified' ? table.gpu : 0) : table.gpu;
	const cpuGBs = ram ?? table.cpu;
	const fast = m.fastBudgetBytes;
	const tier: Profile['tier'] =
		fast < 6 * GB ? { id: 'entry', label: 'Entry' } : fast < 12 * GB ? { id: 'standard', label: 'Standard' } : fast < 20 * GB ? { id: 'strong', label: 'Strong' } : fast < 40 * GB ? { id: 'workstation', label: 'Workstation' } : { id: 'powerhouse', label: 'Powerhouse' };
	const clamp = (x: number | undefined) => (x && Number.isFinite(x) ? Math.min(2.5, Math.max(0.35, x)) : 1);
	return {
		gpu,
		gpuName: m.gpuName,
		gpuGBs: Math.round(gpuGBs),
		cpuGBs: Math.round(cpuGBs),
		tflops: computeTflops(m),
		fastBytes: fast,
		ceilingBytes: m.ceilingBytes,
		ramBytes: m.totalMemoryBytes,
		diskBytes: m.freeDiskBytes,
		measured: !!ram,
		llmFactor: clamp(check?.llmFactor),
		// Diffusion estimates can be further off (backend, driver): a wider correction range.
		diffFactor: Object.fromEntries(Object.entries(check?.calibV === CALIBRATION ? check?.diffFactor ?? {} : {}).filter(([, v]) => Number.isFinite(v) && v > 0).map(([k, v]) => [k, Math.min(8, Math.max(0.15, v))])),
		tier
	};
}

// ---------------------------------------------------------------- language models

/** Quants a model is offered in, best first, with bits per weight and the quality they keep. */
export const LLM_QUANTS: ReadonlyArray<{ q: string; bits: number; keep: number }> = [
	{ q: 'Q8_0', bits: 8.5, keep: 0 },
	{ q: 'Q6_K', bits: 6.6, keep: -1 },
	{ q: 'Q5_K_M', bits: 5.7, keep: -2 },
	{ q: 'Q4_K_M', bits: 4.85, keep: -4 },
	{ q: 'IQ4_XS', bits: 4.3, keep: -6 },
	{ q: 'Q3_K_M', bits: 3.9, keep: -12 }
];

/** Minimum speed (tokens/s) and quality for "Fits my machine": fast enough to work with, smart enough to help. */
export const STRICT = { coding: { tokS: 15, quality: 33 }, imageSeconds: 60, videoSeconds: 600 };

export type Verdict = 'perfect' | 'good' | 'marginal' | 'slow' | 'no';

export interface Rating {
	verdict: Verdict;
	/** Passes the strict "Fits my machine" filter. */
	strict: boolean;
	/** Fast memory used (0–1+). */
	util: number;
	needBytes: number;
	/** Download size. */
	downloadBytes: number;
	/** 0–100: what the list is ranked by. */
	score: number;
	/** Why it is not in the strict list. */
	reason?: string;
	/** The estimate is calibrated by measurements on this machine. */
	measured: boolean;
}

export interface LlmRating extends Rating {
	quant: string;
	tokS: number;
	ctx: number;
	contextReduced?: boolean;
}

const verdictOf = (util: number, need: number, p: { ceilingBytes: number }): Verdict => (util <= FIT.perfect ? 'perfect' : util <= FIT.good ? 'good' : util <= FIT.tight ? 'marginal' : need <= p.ceilingBytes * FIT.ceiling ? 'slow' : 'no');
const fitScore = (v: Verdict) => (v === 'perfect' ? 100 : v === 'good' ? 82 : v === 'marginal' ? 45 : v === 'slow' ? 15 : 0);
const gbs = (b: number) => (b / GB).toFixed(b < 10 * GB ? 1 : 0) + ' GB';

/** KV cache bytes per token at 16-bit, from the dense-equivalent size (GQA models; MoE: √(total × active)). */
export function kvBytesPerToken(params: number, active?: number): number {
	const eff = active ? Math.sqrt(params * active) : params;
	return 16384 * Math.pow(Math.max(0.5, eff), 0.8);
}

/**
 * The memory rule, shared with Models Fit Studio (Core/FitRule.cs; test/fixtures/fit-cases.json
 * holds both to it). What a build needs is its file, the projector, the cache for the context
 * and the runtime's own buffers. The context is the longest of the usual sizes that keeps the
 * need within 85% of fast memory, else the shortest. The verdict is how full fast memory gets;
 * past it, a build still runs from the rest of memory ("slow") while it stays under 92% of the
 * ceiling. Pure.
 */
export const FIT = { perfect: 0.6, good: 0.85, tight: 0.98, ceiling: 0.92, runtimeBytes: 0.35 * GB, lightKv: 34 / 64, longest: 32768, contexts: [16384, 8192, 4096],
	/** Tokens a second a reader keeps up with: below it a build is not recommended while a faster one fits. */
	readingPace: 7,
	/**
	 * Speed kept by a model too big for a graphics chip that shares system memory. Measured on an Intel Arc 140T
	 * laptop (llama.cpp b11574, Vulkan): a 1.7B Q4_K_M wrote 41 tok/s on the chip, 31 on the processor alone and
	 * 19 to 36 split between the two; a 7B Q2_K wrote 8, 13 and 6. A split was never the fastest, so the
	 * estimate is the processor running it all.
	 */
	sharedSpill: 0.75 } as const;
/**
 * Whether the engine runs with the 8-bit KV cache (Local models → Runtimes).
 *
 * The catalogue must rate a model against the cache the loader will really use:
 * with the 16-bit cache the KV part of a model is 64/64 of the f16 size instead
 * of 34/64, so an estimate that assumes the light one under-reports the memory
 * by about 47% of the cache. The engine host keeps this in step with its
 * settings (the default is the 8-bit cache, like the engine's own default).
 */
let engineLightKv = true;
export function setEngineLightKv(on: boolean): void {
	engineLightKv = on !== false;
}

export function fitMemory(o: { fileBytes: number; projectorBytes?: number; kvBytesPerToken: number; maxContext: number; fastBytes: number; ceilingBytes: number; lightKv?: boolean }): { verdict: Verdict; util: number; needBytes: number; ctx: number } {
	const perToken = o.kvBytesPerToken * ((o.lightKv ?? engineLightKv) ? FIT.lightKv : 1);
	const fixed = o.fileBytes + (o.projectorBytes ?? 0) + FIT.runtimeBytes;
	const max = Math.max(1, Math.min(o.maxContext, FIT.longest));
	const contexts = [max, ...FIT.contexts].filter((n, i, all) => n <= max && all.indexOf(n) === i);
	const ctx = contexts.find((n) => fixed + perToken * n <= o.fastBytes * FIT.good) ?? contexts[contexts.length - 1];
	const needBytes = fixed + perToken * ctx;
	const util = needBytes / o.fastBytes;
	const verdict = verdictOf(util, needBytes, o);
	return { verdict, util, needBytes, ctx };
}

/** Pure: one language model on this machine at one quant. */
export function rateLlmAt(seed: LlmSeed, cat: 'coding', p: Profile, quant: (typeof LLM_QUANTS)[number], opts: { fileBytes?: number; projectorBytes?: number; maxContext?: number; lightKv?: boolean } = {}): LlmRating {
	const fileBytes = opts.fileBytes ?? seed.q4Gb * GB * (quant.bits / 4.85);
	// The projector is loaded with the language model and consumes the same memory budget.
	const vision = opts.projectorBytes ?? (seed.mmprojGb ?? 0) * GB;
	const max = Math.min(seed.ctx, opts.maxContext ?? 32768);
	const { verdict, util, needBytes: need, ctx } = fitMemory({ fileBytes, projectorBytes: vision, kvBytesPerToken: seed.kvBytes ?? kvBytesPerToken(seed.params, seed.active), maxContext: max, fastBytes: p.fastBytes, ceilingBytes: p.ceilingBytes, lightKv: opts.lightKv });
	const activeBytes = (seed.active ?? seed.params) * GB * (fileBytes / (seed.params * GB));
	let tokS: number;
	if (verdict === 'no') tokS = 0;
	else if (p.gpu === 'none') tokS = ((p.cpuGBs * GB) / activeBytes) * 0.55;
	else if (verdict === 'slow') {
		if (p.gpu === 'shared') tokS = ((p.gpuGBs * GB) / activeBytes) * 0.55 * FIT.sharedSpill;
		else {
			// Spills: the part outside fast memory is read from RAM every token.
			const onGpu = Math.min(1, p.fastBytes / need);
			tokS = 0.55 / ((onGpu * activeBytes) / (p.gpuGBs * GB) + ((1 - onGpu) * activeBytes) / (p.cpuGBs * GB));
		}
	} else tokS = ((p.gpuGBs * GB) / activeBytes) * 0.55;
	tokS = Math.round(tokS * p.llmFactor * 10) / 10;
	const min = STRICT[cat];
	const quality = (seed.quality[cat] ?? 0) + quant.keep;
	const speed = Math.min(100, (tokS / 45) * 100);
	const score = Math.round((quality * 0.55 + speed * 0.3 + fitScore(verdict) * 0.15) * 10) / 10;
	const strict = (verdict === 'perfect' || verdict === 'good') && tokS >= min.tokS && quality >= min.quality && seed.tools && !seed.runtimeReason;
	let reason: string | undefined;
	if (!strict) {
		if (seed.runtimeReason) reason = seed.runtimeReason;
		else if (verdict === 'no') reason = `Needs ~${gbs(need)} — more than this machine has.`;
		else if (verdict === 'slow' || verdict === 'marginal') reason = `Needs ~${gbs(need)}; runs fast up to ~${gbs(p.fastBytes * 0.85)} here — it would spill and slow down.`;
		else if (tokS < min.tokS) reason = `Only ~${tokS} tok/s here — too slow to work with.`;
		else if (!seed.tools) reason = 'Chat and writing model; tool calling is not confirmed for agent tasks.';
		else reason = 'Below the recommendation threshold; available for chat.';
	}
	return { verdict, strict, util, needBytes: need, downloadBytes: fileBytes + vision, score, reason, measured: p.measured || p.llmFactor !== 1, quant: quant.q, tokS, ctx, contextReduced: ctx < max };
}

/** The usual builds, the best trade first: what is offered when nothing reaches reading pace. */
const USUAL = ['Q4_K_M', 'Q4_K_S', 'UD-Q4_K_XL', 'IQ4_XS', 'IQ4_NL', 'Q4_0', 'UD-TQ1_0', 'Q5_K_M', 'Q3_K_M', 'UD-Q3_K_XL', 'IQ3_XXS', 'Q8_0', 'Q6_K', 'Q2_K', 'MXFP4_MOE', 'BF16', 'F16'];
const usualRank = (quant: string) => {
	const q = quant.toUpperCase();
	const at = USUAL.indexOf(q);
	return at >= 0 ? at : q.startsWith('UD-') && USUAL.includes(q.slice(3)) ? USUAL.indexOf(q.slice(3)) : 98;
};

/**
 * The recommended build, by the rule Models Fit Studio uses: the largest that fits with room to spare and
 * still writes at the pace asked for (an unquantised build buys nothing a Q8 does not give). When none
 * reaches that pace, the usual best trade. When none fits with room to spare, the one that needs the
 * least memory. A build that does not run at all is never picked. Pure.
 *
 * The pace is where the two apps differ on purpose: a reader keeps up with 7 tokens a second, an agent
 * that reads files and calls tools needs the 15 the Recommended filter asks for. Both name the same file
 * whenever the largest build that fits is quicker than both.
 */
export function pickBuild<C extends { rating: LlmRating; sizeBytes: number; quant: string }>(choices: C[], pace: number = FIT.readingPace): C | undefined {
	const runs = choices.filter((c) => c.rating.verdict === 'perfect' || c.rating.verdict === 'good');
	const readable = runs.filter((c) => c.rating.tokS >= pace && !/^(BF16|F16|F32)$/i.test(c.quant)).sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
	if (readable) return readable;
	if (runs.length) return runs.sort((a, b) => usualRank(a.quant) - usualRank(b.quant) || a.sizeBytes - b.sizeBytes)[0];
	return choices.filter((c) => c.rating.verdict !== 'no').sort((a, b) => a.rating.needBytes - b.rating.needBytes)[0];
}

/** Pure: the build of a language model this machine should run, from estimated sizes; Q4 is the reference when none runs. */
export function rateLlm(seed: LlmSeed, cat: 'coding', p: Profile, opts: { lightKv?: boolean } = {}): LlmRating {
	const all = LLM_QUANTS.filter((q) => !seed.quants || seed.quants.includes(q.q)).map((q) => rateLlmAt(seed, cat, p, q, opts));
	return pickBuild(all.map((rating) => ({ rating, sizeBytes: rating.downloadBytes, quant: rating.quant })), STRICT[cat].tokS)?.rating ?? all.find((r) => r.quant === 'Q4_K_M') ?? all[0];
}

/** Repository sizes replace estimates before a download; never fall back to an oversized file. */
export function quantSpec(name: string): { q: string; bits: number; keep: number } | undefined {
	const q = name.toUpperCase().replace(/^UD-/, '');
	const known = LLM_QUANTS.find(x => x.q === q);
	if (known) return known;
	if (/^(F32|F16|BF16)$/.test(q)) return { q: name, bits: q === 'F32' ? 32 : 16, keep: 0 };
	if (/^(MXFP4|NVFP4)$/.test(q)) return { q: name, bits: q === 'MXFP4' ? 4.25 : 4.5, keep: -4 };
	// What a build keeps of the model falls off fast below 4 bits: a 1- or 2-bit build of a large model is
	// not the large model any more, and must not outrank a sound build of a smaller one.
	if (/^(Q[1-8]_[01]|Q[2-8]_K(?:_[SML]|_XL)?|IQ[1-4]_(?:S|M|XS|XXS|NL)|TQ[12]_0)$/.test(q)) { const bit = Number(/\d/.exec(q)![0]); return { q: name, bits: bit + 0.25, keep: bit <= 1 ? -30 : bit === 2 ? -18 : bit === 3 ? -12 : bit === 4 ? -6 : bit === 5 ? -2 : -1 }; }
	return undefined;
}

export function pickLlmFile<F extends { name: string; quant: string; sizeBytes: number; mmproj?: boolean; assembly?: boolean }>(seed: LlmSeed, cat: 'coding', p: Profile, files: F[], opts: { lightKv?: boolean } = {}): { file: F; rating: LlmRating } | undefined {
	if (seed.runtimeReason) return undefined;
	const projector = files.filter((f) => f.mmproj).sort((a, b) => Number(/bf16|f32/i.test(a.name)) - Number(/bf16|f32/i.test(b.name)) || a.sizeBytes - b.sizeBytes)[0];
	if (seed.mmprojGb && !projector) return undefined;
	const choices = modelFiles(files.filter(f => !f.mmproj && !f.assembly), seed.params).flatMap((file) => {
		const q = quantSpec(file.quant);
		if (!q || (seed.quants && !seed.quants.includes(q.q) && !/FP4$/.test(q.q))) return [];
		if (!file || !(file.sizeBytes > 0)) return [];
		const rating = rateLlmAt(seed, cat, p, q, { fileBytes: file.sizeBytes, projectorBytes: projector?.sizeBytes ?? 0, lightKv: opts.lightKv });
		return rating.verdict === 'no' || (p.diskBytes !== undefined && rating.downloadBytes + 0.25 * GB > p.diskBytes) ? [] : [{ file, rating }];
	});
	return pickBuild(choices.map((c) => ({ ...c, sizeBytes: c.file.sizeBytes, quant: c.file.quant })), STRICT[cat].tokS);
}

// ---------------------------------------------------------------- images and videos

export interface DiffusionRating extends Rating {
	size: [number, number];
	frames?: number;
	seconds: number;
}

/** FLOPs for one sampling step at a size (pure). */
export function stepFlops(b: DiffusionBundle, w: number, h: number, frames = 1): number {
	const guided = b.cfg > 1 ? 2 : 1;
	if (!b.patch) return 0.8e12 * ((w * h) / (512 * 512)) * guided; // SD 1.x UNet: ~0.8 TFLOP per pass at 512²
	const latentFrames = b.kind === 'video' ? Math.floor((Math.max(1, frames) - 1) / (b.temporal || 4)) + 1 : 1;
	const tokens = (w / b.patch) * (h / b.patch) * latentFrames;
	// Linear layers 2·P per token, plus attention that grows with the sequence.
	return 2 * b.params * GB * tokens * guided * (1 + tokens / 20000);
}

/** Pure: seconds for one image / clip at a size on this machine. */
export function diffusionSeconds(b: DiffusionBundle, p: Profile, size: [number, number], frames = b.frames ?? 1): number {
	const compute = (b.steps * stepFlops(b, size[0], size[1], frames)) / (p.tflops * 1e12);
	const textEncode = b.files.some((f) => f.role === 'llm' || f.role === 't5xxl') ? 3 : 1;
	// Decoding grows faster than the pixels on GPUs that share system RAM (the decoder runs short of
	// memory and retries in smaller tiles): FLUX.2 at 768² took 5.5× the 512² time on an Arc 140T.
	const mp = (size[0] * size[1]) / 1e6;
	const squeeze = p.gpu === 'shared' || p.gpu === 'unified' ? 1 + 2.5 * mp : 1;
	const decode = (b.vaeCost * mp * (b.kind === 'video' ? frames : 1) * squeeze) / p.tflops;
	return Math.round((compute + textEncode + decode) * (p.diffFactor[b.id] ?? 1));
}

/** Pure: an image or video model on this machine — the largest size that is still quick. */
export function rateDiffusion(b: DiffusionBundle, cat: Category, p: Profile): DiffusionRating {
	const files = bundleBytes(b);
	const diffusion = b.files.find((f) => f.role === 'diffusion' || f.role === 'model')?.bytes ?? 0;
	const encoder = Math.max(0, ...b.files.filter((f) => f.role === 'llm' || f.role === 't5xxl').map((f) => f.bytes));
	const vae = b.files.filter((f) => f.role === 'vae' || f.role === 'audio-vae').reduce((n, f) => n + f.bytes, 0);
	const limit = b.kind === 'video' ? STRICT.videoSeconds : STRICT.imageSeconds;
	const quick = b.kind === 'video' ? limit * 0.6 : 40;
	let size = b.sizes[b.sizes.length - 1];
	for (const s of b.sizes) {
		if (diffusionSeconds(b, p, s) <= quick) {
			size = s;
			break;
		}
	}
	const seconds = diffusionSeconds(b, p, size);
	// Weights are placed per stage (the text encoder first, then the diffusion model): fast memory holds the larger one plus the work buffers.
	const work = b.kind === 'video' ? 2.5 * GB : (0.4 + 1.1 * ((size[0] * size[1]) / (1024 * 1024))) * GB;
	const need = Math.max(diffusion, encoder) + vae + work;
	const util = need / p.fastBytes;
	let verdict = verdictOf(util, need, p);
	// Everything must also sit in RAM between stages.
	if (files + 1.5 * GB > p.ramBytes * 0.8) verdict = 'no';
	const strict = p.gpu !== 'none' && (verdict === 'perfect' || verdict === 'good') && seconds <= limit;
	// A non-commercial license ranks lower: the best pick should be one you may use for anything.
	const quality = (b.quality[cat] ?? b.quality[b.kind === 'video' ? 'videos' : 'images'] ?? 0) - (b.nonCommercial ? 12 : 0);
	const speed = Math.min(100, ((b.kind === 'video' ? 120 : 15) / Math.max(1, seconds)) * 100);
	const score = Math.round((quality * 0.6 + speed * 0.25 + fitScore(verdict) * 0.15) * 10) / 10;
	let reason: string | undefined;
	if (!strict) {
		if (verdict === 'no') reason = `Needs ~${gbs(Math.max(need, files + 1.5 * GB))} of memory — more than this machine has.`;
		else if (p.gpu === 'none') reason = 'Needs a GPU — on the CPU this takes many minutes.';
		else if (verdict === 'slow' || verdict === 'marginal') reason = `Needs ~${gbs(need)} of fast memory; this machine has ~${gbs(p.fastBytes * 0.85)} to spare.`;
		else reason = `About ${fmtSeconds(seconds)} per ${b.kind === 'video' ? 'clip' : 'image'} here — too slow to enjoy.`;
	}
	return { verdict, strict, util, needBytes: need, downloadBytes: files, score, reason, measured: p.diffFactor[b.id] !== undefined, size, frames: b.kind === 'video' ? b.frames : undefined, seconds };
}

export interface VoiceRating extends Rating {
	/** Seconds of work per second of speech here (below 1 = faster than it plays). */
	rtf: number;
}

/** Pure: a voice on this machine — CPU work, so cores decide; strict = comfortably faster than real time. */
export function rateVoice(v: VoiceBundle, m: { cores: number; ramBytes: number }, factor = 1): VoiceRating {
	const threads = voiceThreads(m.cores);
	// Measured with 8 threads on a 16-core laptop; fewer threads or an older CPU are slower.
	const older = m.cores >= 12 ? 1 : m.cores >= 8 ? 1.4 : 2.2;
	// Fewer threads help less than linearly for these small models (memory-bound): the square root.
	const rtf = Math.round(v.rtf * Math.sqrt(8 / threads) * older * factor * 100) / 100;
	const util = v.memBytes / (m.ramBytes * 0.5);
	const verdict: Verdict = util <= 0.6 ? 'perfect' : util <= 0.85 ? 'good' : util <= 1 ? 'marginal' : 'no';
	const strict = (verdict === 'perfect' || verdict === 'good') && rtf <= 0.8;
	const speed = Math.min(100, (1 / Math.max(0.05, rtf)) * 15);
	const score = Math.round((v.quality * 0.6 + speed * 0.3 + fitScore(verdict) * 0.1) * 10) / 10;
	return { verdict, strict, util, needBytes: v.memBytes, downloadBytes: v.bytes, score, reason: strict ? undefined : verdict === 'no' ? 'Not enough memory here.' : 'Slower than it plays here — you would wait for every sentence.', measured: factor !== 1, rtf };
}

export function fmtSeconds(s: number): string {
	return s < 90 ? Math.max(1, Math.round(s)) + ' s' : s < 3600 ? Math.round(s / 60) + ' min' : (s / 3600).toFixed(1) + ' h';
}

// ---------------------------------------------------------------- the list

export interface CatalogItem {
	id: string;
	kind: 'llm' | 'image' | 'video' | 'voice';
	name: string;
	blurb: string;
	repo: string;
	license: string;
	released: string;
	family?: string;
	vision?: boolean;
	tools?: boolean;
	fresh?: boolean;
	nonCommercial?: boolean;
	/** Chat for language models, Studio for image / video models. */
	use: 'chat' | 'studio';
	speed: string;
	rating: LlmRating | DiffusionRating | VoiceRating;
	best?: boolean;
	source?: string;
	verified?: boolean;
	runtimeReason?: string;
}

/** Pure: a category's list for this machine — strict matches first, best first; `strict` hides the rest. */
export function catalogFor(cat: Category, p: Profile, opts: { strict: boolean; fresh?: LlmSeed[]; cores?: number; lightKv?: boolean } = { strict: true }): CatalogItem[] {
	const out: CatalogItem[] = [];
	if (cat === 'voice') {
		for (const v of VOICE_BUNDLES) {
			const r = rateVoice(v, { cores: opts.cores ?? 8, ramBytes: p.ramBytes }, p.diffFactor['voice:' + v.id] ?? 1);
			out.push({ id: v.id, kind: 'voice', name: v.name, blurb: v.blurb + ' ' + v.langs + '.', repo: 'k2-fsa/sherpa-onnx · ' + v.folder, license: v.license, released: v.released, use: 'studio', speed: r.rtf < 1 ? '≈' + (1 / r.rtf < 2 ? (1 / r.rtf).toFixed(1) : String(Math.round(1 / r.rtf))) + '× real time' : r.rtf.toFixed(1) + '× slower', rating: r });
		}
	}
	if (cat === 'coding') {
		const supplied = new Map((opts.fresh ?? []).map((s) => [s.repo.toLowerCase(), s]));
		const seeds = [...LLM_SEEDS.map((s) => supplied.get(s.repo.toLowerCase()) ?? s), ...(opts.fresh ?? []).filter((s) => !LLM_SEEDS.some((c) => c.repo.toLowerCase() === s.repo.toLowerCase()))].filter((s) => s.quality[cat] !== undefined);
		for (const s of seeds) {
			const exact = s.files ? pickLlmFile(s, cat, p, s.files, { lightKv: opts.lightKv }) : undefined;
			const r = exact?.rating ?? rateLlm(s, cat, p, { lightKv: opts.lightKv });
			if (s.files && !exact) { r.strict = false; if (!s.runtimeReason) r.verdict = 'no'; r.reason = s.runtimeReason ?? 'No complete GGUF build fits the available memory, projector and disk budget.'; }
			out.push({ id: s.id, kind: 'llm', name: s.name, blurb: s.blurb, repo: s.repo, license: s.license, released: s.released, family: s.family, vision: !!s.mmprojGb, tools: s.tools, fresh: s.fresh, source: s.source, verified: s.verified, runtimeReason: s.runtimeReason, use: 'chat', speed: r.tokS ? '≈' + Math.round(r.tokS) + ' tok/s' : '—', rating: r });
		}
	}
	if (cat !== 'coding' && cat !== 'voice') {
		for (const b of bundlesFor(cat)) {
			const r = rateDiffusion(b, cat, p);
			out.push({ id: b.id, kind: b.kind, name: b.name, blurb: b.blurb, repo: b.files[0].repo, license: b.license, released: b.released, nonCommercial: b.nonCommercial, use: 'studio', speed: '≈' + fmtSeconds(r.seconds), rating: r });
		}
	}
	out.sort((a, b) => Number(b.rating.strict) - Number(a.rating.strict) || b.rating.score - a.rating.score);
	const list = opts.strict ? out.filter((x) => x.rating.strict) : out;
	// Mark the first strict recommendation in this category.
	const firstLlm = list.find((x) => x.rating.strict && x.kind === 'llm');
	const firstDraw = list.find((x) => x.rating.strict && x.kind !== 'llm');
	for (const x of list) x.best = x === firstLlm || x === firstDraw;
	return list;
}

/** Pure: a Hugging Face GGUF repo found just now → a seed (quality from size, recency and specialty). */
export function seedFromHf(m: { id: string; params?: number; context?: number; tools?: boolean; vision?: boolean; updated?: string; created?: string; downloads?: number }, cat: 'coding', now = Date.now()): LlmSeed | undefined {
	if (!m.params || m.params < 1.5e9 || m.params > 400e9) return undefined;
	// New means new: a repo made more than ~15 months ago is not news, however much it trends.
	const born = Date.parse(m.created ?? m.updated ?? '');
	if (Number.isFinite(born) && now - born > 456 * 86400_000) return undefined;
	const name = m.id.split('/')[1] ?? m.id;
	const { moe, active } = moeInfo(name, m.params);
	const b = m.params / GB;
	const act = moe ? (active ? active / GB : b * 0.1) : undefined;
	const eff = act ? Math.sqrt(b * act) : b;
	const year = Number((m.created ?? m.updated ?? '').slice(0, 4)) || 2025;
	const recency = year >= 2026 ? 6 : year === 2025 ? 0 : -8;
	const coder = /cod(er|e)|dev|swe|program/i.test(name) ? 5 : 0;
	const base = Math.min(84, 18 + 17 * Math.log2(Math.max(1, eff)));
	const q = Math.round(base + recency + (cat === 'coding' ? coder : 0));
	return {
		id: 'hf:' + m.id,
		name: name.replace(/[-_]GGUF$/i, '').replace(/[-_]/g, ' '),
		repo: m.id,
		family: name.split(/[-_.]/)[0].toLowerCase(),
		params: b,
		active: act,
		q4Gb: (m.params * 4.85) / 8 / GB,
		mmprojGb: m.vision ? 0.9 : undefined,
		ctx: m.context || 32768,
		released: (m.created ?? m.updated ?? '').slice(0, 7),
		tools: m.tools === true,
		quality: { [cat]: q },
		blurb: 'New on Hugging Face — ' + (m.downloads ? Math.round(m.downloads / 1000) + 'k downloads.' : 'trending now.'),
		license: 'see model page',
		fresh: true,
		downloads: m.downloads
	};
}

/**
 * Pure: the repo file for a chosen quant (exact label, else "UD-" label, else contained in the
 * name; non-"UD" first). Side files are never the model (repoFiles.ts).
 */
export function fileForQuant<F extends { name: string; quant: string; mmproj?: boolean; sizeBytes?: number; assembly?: boolean }>(files: F[], quant: string): F | undefined {
	const real = modelFiles(files.filter((f) => !f.mmproj && !f.assembly));
	const up = quant.toUpperCase();
	const biggest = (list: F[]) => list.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0))[0];
	return biggest(real.filter((f) => f.quant.toUpperCase() === up)) ?? biggest(real.filter((f) => f.quant.toUpperCase() === 'UD-' + up)) ?? real.filter((f) => f.name.toUpperCase().includes(up)).sort((a, b) => Number(/UD-/i.test(a.name)) - Number(/UD-/i.test(b.name)))[0];
}
