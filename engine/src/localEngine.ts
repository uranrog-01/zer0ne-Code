import * as crypto from 'crypto';
import { draftArchitecture, draftHeadName, helperBySize, paramsFromName } from './repoFiles';
export { paramsFromName };
import { parseModelShape, readModelShape, type ModelShape } from './modelFit';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFile, spawn, spawnSync } from 'child_process';
import { scrubEnv } from './tools/proc';
import { hfFetch, hfRateLimitMessage } from './hfTransport';
import { acquireRuntimeLease } from './runtimeLease';

/**
 * zer0ne Engine — local models without a daemon.
 *
 *  - Discover: Hugging Face's GGUF catalogue (search, files, size, context,
 *    parameters, whether the chat template supports tools).
 *  - Download: resumable GGUF downloads straight from Hugging Face.
 *  - Run: llama.cpp's `llama-server` (MIT) — the engine Ollama and LM Studio
 *    build on — installed on demand from its GitHub releases (the 32 MB
 *    Vulkan build runs on NVIDIA, AMD and Intel GPUs; Metal on Apple; CUDA
 *    or CPU on request), started with the model the chat asks for.
 *
 * HF_ENDPOINT / ZER0NE_LLAMA_RELEASES override the hosts (mirrors, tests).
 */

const HF = () => (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const RELEASES = () => process.env.ZER0NE_LLAMA_RELEASES || 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=8';
/** One release by tag (the tested build). */
const RELEASE_TAG = (tag: string) => (process.env.ZER0NE_LLAMA_TAG_URL || 'https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{tag}').replace('{tag}', encodeURIComponent(tag));

/**
 * The llama.cpp build zer0ne is tested against: installs by default so every
 * user runs a known-good engine. Update it here after the test suite and a
 * live load pass on a newer build. The "latest" channel follows llama.cpp's
 * newest release instead.
 */
export const ENGINE_PIN = 'b11169';
export type EngineChannel = 'tested' | 'latest';

export interface HfModel {
	id: string;
	author: string;
	downloads: number;
	likes: number;
	updated?: string;
	/** When the repository was created (a re-upload of an old model looks new by `updated` only). */
	created?: string;
	params?: number;
	context?: number;
	arch?: string;
	tools?: boolean;
	vision?: boolean;
	/** gguf | safetensors | mlx | onnx | other */
	format?: string;
	pipeline?: string;
	gated?: boolean;
	license?: string;
	baseModel?: string;
	revision?: string;
	tags: string[];
}

export interface HfFile {
	/** One entry per quantisation; split files are grouped. */
	name: string;
	quant: string;
	sizeBytes: number;
	parts: string[];
	mmproj?: boolean;
	/** A draft head ("mtp-…"): loaded beside the model to write faster; never a build of it. */
	draft?: boolean;
	/** Raw .gguf.partN chunks must be joined externally; not native GGUF shards or an app download. */
	assembly?: boolean;
	revision?: string;
	metadata?: Array<{ path: string; size: number; sha256?: string }>;
}

// ---------------------------------------------------------------- Hugging Face

/**
 * The user's Hugging Face token (Settings → Local models, or the Hugging Face
 * provider's key). Sent only to the Hugging Face host: gated models (Llama,
 * Gemma, many fine-tunes) answer 401 without it, and signed-in requests get
 * higher rate limits. Redirects to the CDN drop it (cross-origin fetch rule).
 */
let hfToken: string | undefined;
export function setHfToken(token: string | undefined): void {
	hfToken = token?.trim() || undefined;
}
function hfHeaders(url: string, extra: Record<string, string> = {}): Record<string, string> {
	return hfToken && url.startsWith(HF() + '/') ? { ...extra, Authorization: `Bearer ${hfToken}` } : extra;
}

/** What an HTTP error from Hugging Face means for the user (pure; tested). */
export function hfError(status: number, id?: string, signedIn = !!hfToken): string {
	const page = id ? ` (huggingface.co/${id})` : '';
	if (status === 401) {
		return signedIn
			? `Hugging Face refused your token for this model. Check the token has "Read" access, or open the model page${page} and accept its terms.`
			: `This model is gated: Hugging Face wants you signed in. Open the model page${page}, accept its terms, then connect your Hugging Face token in Local models.`;
	}
	if (status === 403) return `Your Hugging Face account has no access yet. Open the model page${page} and accept its terms (some are approved by the author, which can take a while).`;
	if (status === 404) return 'That file is no longer on Hugging Face. Refresh the model to see its current files.';
	if (status === 429) return hfRateLimitMessage(signedIn);
	return `Hugging Face answered HTTP ${status}.`;
}

async function getJson(url: string, ms = 20_000): Promise<any> {
	const res = await hfFetch(url, { headers: hfHeaders(url, { Accept: 'application/json' }), signal: AbortSignal.timeout(ms) });
	if (!res.ok) {
		throw new Error(hfError(res.status));
	}
	return res.json();
}

/** Who the token belongs to (null when it is not valid). */
export async function hfWhoAmI(token: string): Promise<{ name: string } | null> {
	const res = await hfFetch(`${HF()}/api/whoami-v2`, { headers: { Authorization: `Bearer ${token.trim()}` }, signal: AbortSignal.timeout(15_000) });
	if (res.status === 401 || res.status === 403) return null;
	if (!res.ok) throw new Error(hfError(res.status, undefined, true));
	const j: any = await res.json();
	return { name: String(j.name || j.fullname || 'Hugging Face user') };
}

/** Can this machine download the repo's files right now? ('ok' | an HTTP status). */
export async function hfAccess(id: string, file: string): Promise<'ok' | number> {
	const url = hfFileUrl(id, file);
	const res = await hfFetch(url, { method: 'HEAD', headers: hfHeaders(url), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
	return res.status < 400 ? 'ok' : res.status;
}

/** Model-card facts for the detail pane: license, base model, gating. */
export async function hfCard(id: string): Promise<{ license?: string; baseModel?: string; gated: boolean; description?: string }> {
	const m = await getJson(`${HF()}/api/models/${id}?expand[]=cardData&expand[]=gated`);
	const card = m.cardData ?? {};
	const base = Array.isArray(card.base_model) ? card.base_model[0] : card.base_model;
	return { license: card.license_name || card.license, baseModel: typeof base === 'string' && base !== id ? base : undefined, gated: !!m.gated };
}

/**
 * Hugging Face reads one GGUF file of a repository for its numbers. When that file is the
 * vision projector (architecture "clip") or a draft head, the count describes the helper:
 * a 27B model showed as 460M and "fits" on every computer. Such numbers are not the model's
 * (pure; tested).
 */
export function ggufOfModel(id: string, gguf: any): { total?: number; architecture?: string; context?: number } {
	if (!gguf || typeof gguf !== 'object') return {};
	const named = paramsFromName(id);
	const other = /^clip$/i.test(String(gguf.architecture ?? '')) || draftArchitecture(gguf.architecture) || (!!named && Number(gguf.total) > 0 && (Number(gguf.total) < named * 0.5 || Number(gguf.total) > named * 2));
	return other ? {} : { total: Number(gguf.total) || undefined, architecture: typeof gguf.architecture === 'string' ? gguf.architecture : undefined, context: Number(gguf.context_length) || undefined };
}

function toModel(m: any): HfModel {
	const tpl: string = m.gguf?.chat_template ?? '';
	const meta = ggufOfModel(String(m.id), m.gguf);
	const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
	return {
		id: m.id,
		author: String(m.id).split('/')[0],
		downloads: m.downloads ?? 0,
		likes: m.likes ?? 0,
		updated: m.lastModified ?? m.createdAt,
		created: m.createdAt,
		params: meta.total || m.safetensors?.total || paramsFromName(String(m.id)) || undefined,
		format: m.gguf || tags.includes('gguf') ? 'gguf' : tags.includes('mlx') ? 'mlx' : tags.includes('onnx') ? 'onnx' : m.library_name === 'transformers' || m.safetensors ? 'safetensors' : m.library_name || 'other',
		pipeline: m.pipeline_tag,
		gated: !!m.gated,
		license: typeof m.cardData?.license === 'string' ? m.cardData.license : undefined,
		baseModel: typeof m.cardData?.base_model === 'string' ? m.cardData.base_model : Array.isArray(m.cardData?.base_model) ? m.cardData.base_model[0] : undefined,
		revision: typeof m.sha === 'string' && /^[a-f0-9]{40}$/i.test(m.sha) ? m.sha : undefined,
		context: meta.context,
		arch: meta.architecture,
		tools: tpl ? /\btools\b/.test(tpl) : tags.includes('tool-use') || tags.includes('function-calling') ? true : undefined,
		vision: m.pipeline_tag === 'image-text-to-text' || tags.includes('image-text-to-text') || /vl\b|vision/i.test(m.id),
		tags: tags.filter((t) => !/^(arxiv|base_model|region|license|endpoints|dataset):/.test(t)).slice(0, 8)
	};
}

export async function hfInfo(id: string): Promise<HfModel> {
	if (!validRepoId(id)) throw new Error('Invalid Hugging Face model id.');
	const q = new URLSearchParams();
	for (const e of ['gguf', 'safetensors', 'config', 'cardData', 'sha', 'tags', 'gated', 'pipeline_tag', 'downloads', 'likes', 'createdAt', 'lastModified', 'library_name']) q.append('expand[]', e);
	return toModel(await getJson(`${HF()}/api/models/${id}?${q}`));
}

/** A Hugging Face repo id ("owner/name"): the only shape that may become a URL path or a folder name (pure; tested). */
export function validRepoId(id: unknown): id is string {
	return typeof id === 'string' && /^[\w.-]{1,96}\/[\w.-]{1,96}$/.test(id) && !id.split('/').some((p) => /^\.+$/.test(p));
}

/** Only model-page links become repository ids; file/revision links must not silently scan different weights. */
export function hfRepoFromInput(input: string): string | undefined {
	const value = input.trim();
	if (validRepoId(value)) return value;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || url.port || url.username || url.password) return undefined;
		const match = /^\/([\w.-]+\/[\w.-]+)\/?$/.exec(url.pathname);
		return match && validRepoId(match[1]) ? match[1] : undefined;
	} catch { return undefined; }
}

/** File paths inside a repo that a download may fetch: relative, no "..", .gguf only (pure; tested). */
export function safeGgufParts(parts: unknown): string[] | undefined {
	if (!Array.isArray(parts) || !parts.length || parts.length > 64) return undefined;
	const ok = parts.every((p) => typeof p === 'string' && p.length < 300 && /\.gguf$/i.test(p) && !p.startsWith('/') && !/[\\\u0000-\u001f]/.test(p) && !p.split('/').some((seg) => seg === '..' || seg === ''));
	return ok ? (parts as string[]) : undefined;
}

/** The files of one GGUF model: itself, or every shard of a split model — exactly, never by name prefix (pure; tested). */
export function ggufFiles(ggufPath: string, siblings: string[]): string[] {
	const dir = path.dirname(ggufPath);
	const shard = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(path.basename(ggufPath));
	if (!shard) return [ggufPath];
	return siblings.filter((f) => f.startsWith(shard[1] + '-') && f.toLowerCase().endsWith('-of-' + shard[2] + '.gguf') && /-\d{5}-of-\d{5}\.gguf$/i.test(f)).map((f) => path.join(dir, f));
}

/** Engine settings from the UI: known keys only, values in range (pure; tested). */
export function sanitizeEngineSettings(patch: unknown): Record<string, unknown> {
	const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
	const out: Record<string, unknown> = {};
	if (typeof p.backend === 'string' && ['auto', 'vulkan', 'cuda', 'cpu', 'metal', 'sycl', 'openvino', 'rocm'].includes(p.backend)) out.backend = p.backend;
	if (p.gpu === 'auto' || p.gpu === 'cpu') out.gpu = p.gpu;
	if (typeof p.lightKv === 'boolean') out.lightKv = p.lightKv;
	if (typeof p.speedBoost === 'boolean') out.speedBoost = p.speedBoost;
	if (p.channel === 'tested' || p.channel === 'latest') out.channel = p.channel;
	if (typeof p.helperSlot === 'boolean') out.helperSlot = p.helperSlot;
	if (typeof p.firstLoadTest === 'boolean') out.firstLoadTest = p.firstLoadTest;
	// 0 = automatic; a real window is at least 512 tokens.
	if (Number.isFinite(Number(p.context)) && p.context !== '' && p.context !== null) {
		const c = Math.floor(Number(p.context));
		out.context = c <= 0 ? 0 : Math.min(1_048_576, Math.max(512, c));
	}
	// Unprivileged ports only: the engine listens on loopback but a low port is never right.
	if (Number.isInteger(Number(p.port)) && Number(p.port) >= 1024 && Number(p.port) <= 65535) out.port = Number(p.port);
	return out;
}

/**
 * Discover: 'gguf' = runs in zer0ne Engine now; 'llm' = every text model
 * (safetensors, MLX, GGUF…); 'vision' = image-text models; 'any' = no filter.
 */
export type HfFormat = 'gguf' | 'llm' | 'vision' | 'any';

export async function searchHf(query: string, sort: 'downloads' | 'likes' | 'trendingScore' | 'lastModified' = 'downloads', limit = 40, format: HfFormat = 'gguf', size?: { min?: number; max?: number }): Promise<HfModel[]> {
	return (await searchHfPage(query, sort, limit, format, size)).items;
}

export async function searchHfPage(query: string, sort: 'downloads' | 'likes' | 'trendingScore' | 'lastModified' = 'downloads', limit = 40, format: HfFormat = 'gguf', size?: { min?: number; max?: number }, cursor?: string): Promise<{ items: HfModel[]; cursor?: string }> {
	const q = new URLSearchParams({ sort, direction: '-1', limit: String(limit) });
	// Size classes are filtered by Hugging Face itself, so a page is never mostly too-large models.
	if (size && (size.min || size.max)) q.set('num_parameters', `min:${bParam(size.min ?? 0)},max:${size.max ? bParam(size.max) : '2000B'}`);
	if (format === 'gguf') q.set('filter', 'gguf');
	else if (format === 'llm') q.set('pipeline_tag', 'text-generation');
	else if (format === 'vision') q.set('pipeline_tag', 'image-text-to-text');
	if (query.trim()) {
		q.set('search', query.trim());
	}
	for (const e of ['gguf', 'downloads', 'likes', 'lastModified', 'createdAt', 'pipeline_tag', 'tags', 'safetensors', 'library_name', 'gated', 'cardData', 'sha']) {
		q.append('expand[]', e);
	}
	const url = cursor ?? `${HF()}/api/models?${q}`;
	if (new URL(url).origin !== new URL(HF()).origin || new URL(url).pathname !== new URL(HF() + '/api/models').pathname || url.length > 16000) throw new Error('Invalid Hugging Face search cursor.');
	const res = await hfFetch(url, { headers: hfHeaders(url), signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(hfError(res.status));
	const list = await res.json();
	const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
	return { items: (Array.isArray(list) ? list : []).map(toModel), cursor: next };
}

const bParam = (n: number) => (n >= 1e9 ? Math.round(n / 1e9) + 'B' : Math.round(n / 1e6) + 'M');

/** GGUF conversions of a (safetensors) model, most downloaded first. */
export async function ggufBuilds(id: string, limit = 8): Promise<Array<{ id: string; downloads: number; likes: number }>> {
	const q = new URLSearchParams({ sort: 'downloads', direction: '-1', limit: String(limit) });
	q.append('filter', 'base_model:quantized:' + id);
	q.append('filter', 'gguf');
	const list = await getJson(`${HF()}/api/models?${q}`);
	return (Array.isArray(list) ? list : []).map((m: any) => ({ id: String(m.id), downloads: m.downloads ?? 0, likes: m.likes ?? 0 }));
}

const QUANT = /(UD-[A-Z0-9_]+|IQ[1-4]_[A-Z]+|Q[2-8]_K_XL|Q[2-8]_K(?:_[A-Z]+)?|Q[1-8]_[01](?:_[A-Z]+)?|TQ[12]_0|F16|BF16|F32|MXFP4|NVFP4)/i;

/** Top-level files of a repository (path + real size), for the converter. */
export async function hfTree(id: string): Promise<Array<{ path: string; size: number }>> {
	const items = await getJson(`${HF()}/api/models/${id}/tree/main`);
	return (Array.isArray(items) ? items : []).filter((it: any) => it.type === 'file').map((it: any) => ({ path: String(it.path), size: Number(it.lfs?.size ?? it.size) || 0 }));
}

/**
 * The Hub's own numbers for one file: its real size and, for a file held in LFS, the
 * SHA-256 of its content (the LFS oid). A file small enough to live in git has no
 * SHA-256 here — only its size — so a download of it can be checked for completeness
 * but not for tampering.
 */
export async function hfFileMeta(id: string, file: string, revision = 'main'): Promise<{ size: number; sha256?: string } | undefined> {
	if (!validRepoId(id)) throw new Error('Invalid model id.');
	const parts = file.split('/').filter(Boolean);
	if (!parts.length || parts.some((p) => p === '..' || p.includes('\\'))) throw new Error('Invalid model file.');
	const url = `${HF()}/api/models/${id}/paths-info/${revision}`;
	const res = await hfFetch(url, { method: 'POST', headers: hfHeaders(url, { 'Content-Type': 'application/json', Accept: 'application/json' }), body: JSON.stringify({ paths: [parts.join('/')] }), signal: AbortSignal.timeout(20_000) });
	if (!res.ok) throw new Error(hfError(res.status, id));
	const rows = (await res.json()) as any[];
	const row = Array.isArray(rows) ? rows.find((r) => r && r.type === 'file' && String(r.path) === parts.join('/')) : undefined;
	if (!row) return undefined;
	const size = Number(row.lfs?.size ?? row.size) || 0;
	if (size <= 0) return undefined;
	const oid = typeof row.lfs?.oid === 'string' ? row.lfs.oid.toLowerCase() : '';
	return { size, sha256: /^[a-f0-9]{64}$/.test(oid) ? oid : undefined };
}

/**
 * GGUF builds of a model found by name (quantizers such as mradermacher and
 * bartowski often skip the base_model tag). exact = same model name.
 */
export async function ggufByName(id: string, limit = 8): Promise<Array<{ id: string; downloads: number; likes: number; exact: boolean }>> {
	const name = (id.split('/').pop() || id).toLowerCase();
	const list = await searchHf(name, 'downloads', 20, 'gguf').catch(() => [] as HfModel[]);
	const norm = (s: string) => s.toLowerCase().replace(/[-_.](i1-)?gguf$/, '').replace(/[-_.](i1-)?gguf$/, '');
	return list
		.filter((m) => m.id !== id)
		.map((m) => ({ id: m.id, downloads: m.downloads, likes: m.likes, exact: norm(m.id.split('/').pop() || '') === name }))
		.sort((a, b) => Number(b.exact) - Number(a.exact) || b.downloads - a.downloads)
		.slice(0, limit);
}

/** GGUF files of a repo, one entry per quantisation (multi-part files summed). */
export async function hfFiles(id: string, revision?: string, withDrafts = false): Promise<HfFile[]> {
	if (!validRepoId(id) || (revision !== undefined && !/^[a-f0-9]{40}$/i.test(revision))) throw new Error('Invalid model revision.');
	const tree: Array<{ type: string; path: string; size: number; lfs?: { size: number; oid?: string } }> = [];
	const walk = async (dir: string, depth: number) => {
		const root = `${HF()}/api/models/${id}/tree/${revision ?? 'main'}${dir ? '/' + dir.split('/').map(encodeURIComponent).join('/') : ''}`;
		let next: string | undefined = root;
		const items: any[] = [];
		const seen = new Set<string>();
		while (next) {
			if (seen.has(next) || seen.size >= 32) throw new Error('The repository file list is too large or incomplete.');
			seen.add(next);
			const res = await hfFetch(next, { headers: hfHeaders(next), signal: AbortSignal.timeout(20_000) });
			if (!res.ok) throw new Error(hfError(res.status, id));
			const page = await res.json();
			if (!Array.isArray(page)) throw new Error('Invalid repository file list.');
			items.push(...page);
			const link: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
			next = link ? new URL(link, root).href : undefined;
			if (next && (new URL(next).origin !== new URL(HF()).origin || new URL(next).pathname !== new URL(root).pathname)) throw new Error('Invalid repository pagination.');
		}
		for (const it of items) {
			if (it.type === 'directory' && depth < 2) {
				await walk(it.path, depth + 1);
			} else if (it.type === 'file') {
				tree.push(it);
			}
		}
	};
	await walk('', 0);
	const groups = new Map<string, HfFile>();
	for (const f of tree.filter((x) => /\.gguf(?:\.part[1-9]\d*)?$/i.test(x.path))) {
		const assembly = /\.gguf\.part[1-9]\d*$/i.test(f.path);
		const mainPath = f.path.replace(/\.part\d+$/i, '');
		if (assembly && tree.some(x => x.path === mainPath)) continue;
		const base = path.posix.basename(f.path);
		const key = mainPath.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf');
		const size = f.lfs?.size ?? f.size;
		if (!safeGgufParts([mainPath]) || !Number.isSafeInteger(size) || size <= 0) continue;
		const g: HfFile = groups.get(key) ?? { name: path.posix.basename(key), quant: (QUANT.exec(base)?.[1] ?? 'GGUF').toUpperCase(), sizeBytes: 0, parts: [], mmproj: /mmproj/i.test(base), ...(assembly ? { assembly: true } : {}), revision, metadata: [] };
		g.sizeBytes += size;
		g.parts.push(f.path);
		g.metadata!.push({ path: f.path, size, sha256: /^[a-f0-9]{64}$/i.test(f.lfs?.oid ?? '') ? f.lfs!.oid : undefined });
		groups.set(key, g);
	}
	return [...groups.values()].filter((g) => {
		if (g.assembly) return g.parts.length <= 64;
		const shard = /-\d{5}-of-(\d{5})\.gguf$/i.exec(g.parts[0]);
		if (!shard) return g.parts.length === 1;
		const n = Number(shard[1]);
		return n === g.parts.length && n <= 64 && new Set(g.parts.map((p) => Number(/-(\d{5})-of-\d{5}\.gguf$/i.exec(p)?.[1]))).size === n && g.parts.every((p) => { const i = Number(/-(\d{5})-of-\d{5}\.gguf$/i.exec(p)?.[1]); return i >= 1 && i <= n; });
	// Draft heads and other side files are not builds of the model (repoFiles.ts); the projector stays, it loads with the model.
	// A caller that can use a draft head asks for them: they come marked, after the builds.
	}).filter((g) => g.mmproj || !helperBySize(g.parts[0], g.sizeBytes) || (withDrafts && g.parts.length === 1 && draftHeadName(g.parts[0])))
		.map((g) => ({ ...g, parts: g.parts.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), ...(!g.mmproj && helperBySize(g.parts[0], g.sizeBytes) ? { draft: true } : {}) }))
		.sort((a, b) => Number(!!a.draft) - Number(!!b.draft) || Number(!!a.mmproj) - Number(!!b.mmproj) || a.sizeBytes - b.sizeBytes);
}

/**
 * What a model file on Hugging Face says about itself, from its first megabyte: layers, attention
 * heads, context, experts, and whether it is a draft head. Nothing else is downloaded.
 */
export async function hfModelShape(id: string, file: string, revision?: string, signal?: AbortSignal): Promise<ModelShape> {
	const url = hfFileUrl(id, file, revision);
	const res = await hfFetch(url, { headers: hfHeaders(url, { Range: 'bytes=0-1048575' }), redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
	if (res.status !== 206 && res.status !== 200) { await res.body?.cancel().catch(() => undefined); throw new Error(hfError(res.status, id)); }
	// A server that ignores the range would send the whole model: stop after the first megabyte.
	const chunks: Buffer[] = [];
	let size = 0;
	const reader = res.body?.getReader();
	while (reader && size < 1048576) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(Buffer.from(value)); size += value.byteLength;
	}
	await reader?.cancel().catch(() => undefined);
	return parseModelShape(Buffer.concat(chunks).subarray(0, 1048576));
}

// ---------------------------------------------------------------- downloads

export interface DownloadProgress {
	received: number;
	total: number;
	bytesPerSec: number;
}

export interface DownloadOptions {
	/**
	 * Refuse the download when no size is known — neither from the caller nor from
	 * the server. Without a size a truncated transfer cannot be told apart from a
	 * complete one, and a truncated file must never be promoted to its final name.
	 */
	requireSize?: boolean;
	/**
	 * The size is unknown and the caller checks the bytes by a digest right after
	 * the download instead (the size check is waived for it).
	 */
	sizeUnknown?: boolean;
}

/** Resumable download to `dest` (a .part file is renamed when complete). */
export async function download(url: string, dest: string, onProgress: (p: DownloadProgress) => void, signal: AbortSignal, expected?: number, opts: DownloadOptions = {}): Promise<void> {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const part = dest + '.part';
	let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
	const request = url.startsWith(HF() + '/') ? hfFetch : fetch;
	const res = await request(url, { headers: hfHeaders(url, have ? { Range: `bytes=${have}-` } : {}), redirect: 'follow', signal });
	// 416 on a resume: the .part file already holds the whole file (an earlier run stopped before the rename).
	if (res.status === 416 && have) {
		const size = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1]);
		await res.body?.cancel().catch(() => undefined);
		if (size === have && (!expected || expected === have)) {
			fs.renameSync(part, dest);
			onProgress({ received: have, total: have, bytesPerSec: 0 });
			return;
		}
		// Not the same file any more (the repo changed): drop the stale part.
		fs.rmSync(part, { force: true });
		throw new Error('The partial download no longer matches the file on the server — press Download again to start it fresh.');
	}
	if (!res.ok && res.status !== 206) {
		const hf = url.startsWith(HF() + '/') ? /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/resolve\//.exec(url)?.[1] : undefined;
		throw new Error(hf ? hfError(res.status, hf) : `Download failed (HTTP ${res.status}).`);
	}
	if (res.status === 200) {
		have = 0; // server ignored the range: start over
	}
	const len = Number(res.headers.get('content-length')) || 0;
	// The size is the only proof that a transfer is complete. Without one the file
	// cannot be checked, so such a download is refused unless the caller checks
	// the bytes by a digest itself.
	if (!expected && !len && opts.requireSize && !opts.sizeUnknown) {
		await res.body?.cancel().catch(() => undefined);
		throw new Error('The server did not report the size of the download, so a complete file cannot be proven. Nothing was downloaded.');
	}
	// What the server says it will send: the bytes still missing from this part file.
	// A short transfer must never be promoted to the final file.
	const want = expected || (len ? have + len : 0);
	const total = want;
	const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
	let received = have;
	let windowStart = Date.now();
	let windowBytes = 0;
	let rate = 0;
	let last = 0;
	const reader = res.body!.getReader();
	// Pausing = aborting: cancel the body at once so the HTTP client never holds a paused
	// socket the server then ends (that trips an internal undici assert in Node 22+).
	const cancel = () => void reader.cancel().catch(() => undefined);
	signal.addEventListener('abort', cancel, { once: true });
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!out.write(value)) {
				await new Promise<void>((r) => out.once('drain', () => r()));
			}
			received += value.length;
			windowBytes += value.length;
			const now = Date.now();
			if (now - windowStart > 1000) {
				rate = (windowBytes * 1000) / (now - windowStart);
				windowStart = now;
				windowBytes = 0;
			}
			if (now - last > 300) {
				last = now;
				onProgress({ received, total, bytesPerSec: rate });
			}
		}
	} finally {
		signal.removeEventListener('abort', cancel);
		await new Promise<void>((r) => out.end(() => r()));
	}
	if (signal.aborted) {
		throw new Error('Download paused — press Download again to resume.');
	}
	if (want && received !== want) {
		// More bytes than the file should hold: this is not the file that was asked for.
		if (received > want) fs.rmSync(part, { force: true });
		throw new Error(received < want ? 'Download ended early — press Download again to resume.' : 'The download is larger than the file that was expected, so it was discarded. Press Download again to start it fresh.');
	}
	fs.renameSync(part, dest);
	onProgress({ received, total: received, bytesPerSec: rate });
}

/** Existing files and completed resumes must match the immutable Hub file, not just its name. */
export async function verifiedHfDownload(id: string, metadata: { path: string; size: number; sha256?: string }, revision: string | undefined, dest: string, progress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<void> {
	const valid = async (file: string) => {
		if (!fs.existsSync(file) || fs.statSync(file).size !== metadata.size) return false;
		if (!metadata.sha256) return true;
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(file, { signal });
		for await (const chunk of stream) hash.update(chunk);
		return hash.digest('hex') === metadata.sha256.toLowerCase();
	};
	signal.throwIfAborted();
	if (await valid(dest)) { progress({ received: metadata.size, total: metadata.size, bytesPerSec: 0 }); return; }
	if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
	// scanGguf must not expose completed bytes while their checksum is still being verified.
	const staged = dest + '.verify';
	if (fs.existsSync(dest + '.part') && !fs.existsSync(staged + '.part')) fs.renameSync(dest + '.part', staged + '.part');
	if (!(await valid(staged))) {
		fs.rmSync(staged, { force: true });
		await download(hfFileUrl(id, metadata.path, revision), staged, progress, signal, metadata.size);
	}
	if (!(await valid(staged))) {
		fs.rmSync(staged, { force: true });
		throw new Error('The model file failed Hugging Face size/checksum verification. Download it again.');
	}
	signal.throwIfAborted();
	fs.renameSync(staged, dest);
}

export function hfFileUrl(id: string, file: string, revision?: string): string {
	if (!validRepoId(id) || typeof file !== 'string' || !file || file.startsWith('/') || /[\\\u0000-\u001f]/.test(file) || file.split('/').some((p) => p === '..' || !p) || (revision !== undefined && !/^[a-f0-9]{40}$/i.test(revision))) throw new Error('Invalid model file.');
	return `${HF()}/${id}/resolve/${revision ?? 'main'}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

// ---------------------------------------------------------------- local GGUF files

export interface LocalGguf {
	helper?: boolean;
	/** Model id used in chat: the file name without .gguf. */
	id: string;
	path: string;
	sizeBytes: number;
	repo?: string;
	source: 'zer0ne' | 'lmstudio' | 'modelfit';
	quant: string;
	/** Vision projector next to the model (mmproj-*.gguf): passed as --mmproj. */
	mmproj?: string;
	/** Draft head next to the model (mtp-*.gguf): passed as --spec-draft-model. */
	draft?: string;
	/** The model carries its draft layers inside (an "…-MTP" build). */
	mtp?: boolean;
}

/** The vision projector in a model's folder, preferring F16 (the usual release). */
export function findMmproj(dir: string): string | undefined {
	try {
		const all = fs.readdirSync(dir).filter((f) => /mmproj.*\.gguf$/i.test(f));
		const pick = all.find((f) => /f16/i.test(f) && !/bf16/i.test(f)) ?? all.find((f) => /bf16/i.test(f)) ?? all[0];
		return pick ? path.join(dir, pick) : undefined;
	} catch {
		return undefined;
	}
}

/** A helper file on disk: by name, and for a draft-named file by its size too. */
function localHelper(full: string, name: string): boolean {
	try { return helperBySize(name, fs.statSync(full).size) || !!readModelShape(full).draft; } catch { return true; }
}

/** The draft head in a model's folder: named like one, and saying so in its own header. The smallest wins. */
export function findDraftHead(dir: string): string | undefined {
	try {
		return fs.readdirSync(dir).filter((f) => /\.gguf$/i.test(f) && draftHeadName(f)).map((f) => path.join(dir, f))
			.filter((f) => readModelShape(f).draft).map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => a.size - b.size)[0]?.f;
	} catch {
		return undefined;
	}
}

/** The model is asked to draft ahead: with a head beside it, or with the layers it carries inside. */
export function draftsAhead(extra: string[] | undefined): boolean {
	const at = extra?.indexOf('--spec-type') ?? -1;
	return at >= 0 && String(extra![at + 1] ?? '').split(',').includes('draft-mtp');
}

/** The speculative-decoding arguments without the draft head: for the processor, and for a load that failed with it. */
export function withoutDraftHead(extra: string[] | undefined): string[] {
	const out: string[] = [];
	for (let i = 0; i < (extra?.length ?? 0); i++) {
		const a = extra![i];
		if (a === '--spec-draft-model') { i++; continue; }
		if (a === '--spec-type') {
			const kept = String(extra![++i] ?? '').split(',').filter((t) => t && t !== 'draft-mtp');
			if (kept.length) out.push(a, kept.join(','));
			continue;
		}
		out.push(a);
	}
	return out;
}

/**
 * Models Fit Studio's download folder on this computer (Windows): the folder chosen in that
 * app, else its default. ZER0NE_MODELFIT_DIR points somewhere else, or nowhere when empty.
 * That app lists this one's models folder the same way.
 */
export function modelFitDir(): string | undefined {
	const set = process.env.ZER0NE_MODELFIT_DIR;
	if (set !== undefined) return set || undefined;
	if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return undefined;
	const home = path.join(process.env.LOCALAPPDATA, 'ModelFitStudio');
	try {
		const chosen = JSON.parse(fs.readFileSync(path.join(home, 'store-settings.json'), 'utf8')).rootDir;
		if (typeof chosen === 'string' && chosen && fs.existsSync(chosen)) return chosen;
	} catch { /* No choice was saved: the default folder applies. */ }
	return path.join(home, 'Models');
}

/** GGUFs in our models folder plus LM Studio's and Models Fit Studio's (reused, never copied). */
export function scanGguf(modelsDir: string, includeHelpers = false): LocalGguf[] {
	const shared = modelFitDir();
	const roots: Array<[string, LocalGguf['source']]> = [
		[modelsDir, 'zer0ne'],
		...(shared && path.resolve(shared) !== path.resolve(modelsDir) ? [[shared, 'modelfit'] as [string, LocalGguf['source']]] : []),
		[path.join(os.homedir(), '.lmstudio', 'models'), 'lmstudio'],
		[path.join(os.homedir(), '.cache', 'lm-studio', 'models'), 'lmstudio']
	];
	const out: LocalGguf[] = [];
	const seen = new Set<string>();
	const walk = (dir: string, base: string, source: LocalGguf['source'], depth: number) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory() && depth < 4) {
				walk(full, base, source, depth + 1);
			} else if (e.isFile() && /\.gguf$/i.test(e.name) && (!/-\d{5}-of-\d{5}\.gguf$/i.test(e.name) || /-00001-of-\d{5}\.gguf$/i.test(e.name))) {
				const helper = localHelper(full, e.name);
				if (helper && !includeHelpers) continue;
				if (source === 'zer0ne' && fs.existsSync(path.join(dir, '.pending-' + e.name + '.json'))) continue;
				const id = e.name.replace(/(-00001-of-\d{5})?\.gguf$/i, '');
				if (seen.has(id)) {
					continue;
				}
				const rel = path.relative(base, dir).split(path.sep);
				let size = 0;
				try {
					size = fs.statSync(full).size;
					// Multi-part: add the sibling parts.
					const shard = /^(.*)-00001-of-(\d{5})\.gguf$/i.exec(e.name);
					if (shard) {
						const count = Number(shard[2]);
						if (!count || count > 99999) continue;
						const siblings = Array.from({ length: count }, (_, i) => path.join(dir, `${shard[1]}-${String(i + 1).padStart(5, '0')}-of-${shard[2]}.gguf`));
						if (!siblings.every((f) => fs.existsSync(f) && fs.statSync(f).isFile() && fs.statSync(f).size > 0)) continue;
						size = siblings.reduce((n, f) => n + fs.statSync(f).size, 0);
					}
				} catch {
					continue;
				}
				seen.add(id);
				// Models Fit Studio keeps a repository as one folder, "owner_name"; only the first separator stands for the slash.
				const flat = source === 'modelfit' && rel[0] && rel[0].indexOf('_') > 0 ? rel[0].replace('_', '/') : undefined;
				out.push({ id, path: full, sizeBytes: size, repo: flat ?? (rel.length >= 2 ? rel.slice(0, 2).join('/') : undefined), source, quant: (QUANT.exec(e.name)?.[1] ?? 'GGUF').toUpperCase(), ...(helper ? { helper: true } : { mmproj: findMmproj(dir), draft: findDraftHead(dir) }),
					// The name nominates, the header decides; other files are not opened just to list them.
					mtp: /mtp/i.test(path.relative(base, full)) && readModelShape(full).mtp ? true : undefined });
			}
		}
	};
	for (const [dir, source] of roots) {
		walk(dir, dir, source, 0);
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- llama.cpp runtime

/** sycl / openvino: Intel's own GPU runtimes (Arc, Core Ultra iGPUs); rocm: AMD's (Radeon RX / Pro, Instinct) — often faster there than Vulkan. */
export type Backend = 'vulkan' | 'cuda' | 'cpu' | 'metal' | 'sycl' | 'openvino' | 'rocm';

export function defaultBackend(): Backend {
	if (process.platform === 'darwin') {
		return 'metal';
	}
	if (process.arch === 'arm64' && process.platform === 'win32') {
		return 'cpu';
	}
	return 'vulkan';
}

/**
 * The llama.cpp release asset for this machine + backend.
 *
 * CUDA: releases ship 12.x and 13.x builds. 13.x is needed for RTX 50
 * (Blackwell) and is the only arm64 CUDA build; it wants an NVIDIA driver
 * ≥ 580. `cudaDriver` (the driver's major version from nvidia-smi) picks the
 * newest build it can run; unknown drivers get 12.x on x64 (runs everywhere).
 */
export function pickAsset(names: string[], backend: Backend, platform = process.platform, arch = process.arch, cudaDriver?: number): string | undefined {
	const a = arch === 'arm64' ? 'arm64' : 'x64';
	if (backend === 'cuda' && platform !== 'darwin') {
		const os = platform === 'win32' ? 'win' : 'ubuntu';
		const ext = platform === 'win32' ? 'zip' : 'tar\\.gz';
		const re = new RegExp(`^llama-b\\d+-bin-${os}-cuda-(\\d+)\\.(\\d+)-${a}\\.${ext}$`);
		const builds = names.map((n) => [n, re.exec(n)] as const).filter((x): x is readonly [string, RegExpExecArray] => !!x[1]).map(([n, m]) => ({ n, major: Number(m[1]), minor: Number(m[2]) }));
		const ok = builds.filter((b) => (cudaDriver ? cudaDriver >= 580 || b.major < 13 : a === 'arm64' || b.major < 13));
		const pick = (ok.length ? ok : builds).sort((x, y) => y.major - x.major || y.minor - x.minor)[0];
		return pick?.n;
	}
	// Intel's and AMD's runtimes: x64 Windows / Linux only (SYCL on Linux: the fp16 build, faster on Arc).
	if (backend === 'sycl' || backend === 'openvino' || backend === 'rocm') {
		if (a !== 'x64' || platform === 'darwin') return undefined; // no such build: never a different one under this name
		const os = platform === 'win32' ? 'win' : 'ubuntu';
		const ext = platform === 'win32' ? 'zip' : 'tar\\.gz';
		const re = backend === 'sycl' ? new RegExp(`^llama-b\\d+-bin-${os}-sycl(-fp16)?-x64\\.${ext}$`) : new RegExp(`^llama-b\\d+-bin-${os}-${backend}-[\\d.]+-x64\\.${ext}$`);
		return names.filter((n) => re.test(n)).sort((x, y) => Number(/fp16/.test(y)) - Number(/fp16/.test(x)))[0];
	}
	const want =
		platform === 'win32'
			? backend === 'cpu'
				? new RegExp(`^llama-b\\d+-bin-win-cpu-${a}\\.zip$`)
				: new RegExp(`^llama-b\\d+-bin-win-vulkan-${a}\\.zip$`)
			: platform === 'darwin'
				? new RegExp(`^llama-b\\d+-bin-macos-${a}\\.(tar\\.gz|zip)$`)
				: backend === 'cpu'
					? new RegExp(`^llama-b\\d+-bin-ubuntu-${a}\\.tar\\.gz$`)
					: new RegExp(`^llama-b\\d+-bin-ubuntu-vulkan-${a}\\.tar\\.gz$`);
	return names.find((n) => want.test(n));
}

/** NVIDIA driver major version (e.g. 581), or undefined without nvidia-smi. */
export function nvidiaDriverMajor(): number | undefined {
	try {
		const r = spawnSync('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
		const v = parseInt(String(r.stdout || '').trim(), 10);
		return r.status === 0 && Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/** Linux / macOS: the engine's shared libraries sit next to llama-server. */
export function engineEnv(server: string): NodeJS.ProcessEnv {
	const dir = path.dirname(server);
	const base = scrubEnv();
	if (process.platform === 'linux') return { ...base, LD_LIBRARY_PATH: dir + (base.LD_LIBRARY_PATH ? ':' + base.LD_LIBRARY_PATH : '') };
	if (process.platform === 'darwin') return { ...base, DYLD_FALLBACK_LIBRARY_PATH: dir + (base.DYLD_FALLBACK_LIBRARY_PATH ? ':' + base.DYLD_FALLBACK_LIBRARY_PATH : '') };
	return base;
}

/** A launch that failed because a GPU runtime is missing, not for lack of memory. */
export function missingRuntime(log: string, backend?: string): string | undefined {
	if (/libvulkan|vulkan-1\.dll|ErrorIncompatibleDriver|no vulkan devices/i.test(log)) return 'The Vulkan runtime is missing or too old. Install your GPU driver (Linux: the libvulkan1 and mesa-vulkan-drivers packages), or switch the engine to CPU under Engine.';
	if (/libcuda|cudart|cublas|CUDA driver version is insufficient|nvcuda\.dll/i.test(log)) return 'The CUDA build cannot start: the NVIDIA driver is missing or too old for it. Update the driver, or switch the engine to Vulkan under Engine.';
	if (/sycl|level.?zero|ze_loader|OpenCL\.dll|No device of requested type|oneapi|intel.*driver/i.test(log) && backend === 'sycl') return 'The SYCL build cannot reach the Intel GPU: update the Intel Arc / Graphics driver (it brings Level Zero; Linux: the intel-level-zero-gpu and intel-opencl-icd packages), or switch the engine back to Vulkan under Engine.';
	if (/openvino|GPU plugin|Failed to create plugin/i.test(log) && backend === 'openvino') return 'The OpenVINO build cannot start on this GPU: update the Intel Graphics driver (Linux: the intel-opencl-icd / level-zero packages), or switch the engine back to Vulkan under Engine.';
	if (/hip|rocm|amdhip|hipErr|no ROCm-capable device|amdgpu/i.test(log) && backend === 'rocm') return 'The ROCm build cannot use this AMD GPU: it needs a supported Radeon / Instinct card and a current AMD driver (Linux: the ROCm packages). Switch the engine back to Vulkan under Engine — it runs on every AMD GPU.';
	if (/error while loading shared libraries|cannot open shared object|Library not loaded|was not found/i.test(log)) return `The ${backend || 'engine'} build is missing a system library. Reinstall the engine under Engine, or switch it to CPU.`;
	return undefined;
}

export interface EngineBuild {
	version: string;
	backend: Backend;
	server: string;
}

export interface EngineInstall extends EngineBuild {
	/** The build before this one, kept on disk so a bad update can roll back. */
	previous?: EngineBuild;
	/** This build has loaded a model here; until then a failing load rolls back to `previous`. */
	proven?: boolean;
}

function findServer(dir: string): string | undefined {
	const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
	const stack = [dir];
	while (stack.length) {
		const d = stack.pop()!;
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.isFile() && e.name === exe) {
				return path.join(d, e.name);
			}
			if (e.isDirectory()) {
				stack.push(path.join(d, e.name));
			}
		}
	}
	return undefined;
}

export function installedEngine(engineDir: string): EngineInstall | undefined {
	try {
		const meta = JSON.parse(fs.readFileSync(path.join(engineDir, 'engine.json'), 'utf8')) as EngineInstall;
		if (!fs.existsSync(meta.server)) return undefined;
		// A kept build whose folder is gone cannot be rolled back to.
		if (meta.previous && !fs.existsSync(meta.previous.server)) delete meta.previous;
		return meta;
	} catch {
		return undefined;
	}
}

function writeEngine(engineDir: string, meta: EngineInstall): void {
	fs.writeFileSync(path.join(engineDir, 'engine.json'), JSON.stringify(meta, null, 2));
}

/** The installed build has loaded a model: keep it even if a later load fails. */
export function markEngineProven(engineDir: string, server: string): void {
	const meta = installedEngine(engineDir);
	if (meta && !meta.proven && meta.server === server) writeEngine(engineDir, { ...meta, proven: true });
}

/** Switch to the kept build (the current one is kept in its place, so the switch can be undone). */
export function rollbackEngine(engineDir: string): EngineInstall | undefined {
	const meta = installedEngine(engineDir);
	if (!meta?.previous) return undefined;
	const back: EngineInstall = { ...meta.previous, previous: { version: meta.version, backend: meta.backend, server: meta.server }, proven: true };
	writeEngine(engineDir, back);
	return back;
}

/**
 * Does this llama-server start on this machine? `--version` loads every
 * shared library the build needs (GPU runtimes included) and exits in well
 * under a second, so a broken download or a missing runtime shows up here —
 * before it replaces a working engine.
 */
export function smokeTest(server: string): { ok: boolean; detail: string } {
	const r = spawnSync(server, ['--version'], { timeout: 60_000, windowsHide: true, cwd: path.dirname(server), env: engineEnv(server), encoding: 'utf8' });
	const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
	if (r.error) return { ok: false, detail: r.error.message };
	if (r.status === 0 && out) return { ok: true, detail: /version:\s*(.+)/i.exec(out)?.[1]?.trim() ?? out.split('\n').pop()!.trim() };
	return { ok: false, detail: out.split('\n').filter((l) => l.trim()).slice(-2).join(' ').slice(0, 240) || `exit code ${r.status ?? r.signal}` };
}

/**
 * GitHub publishes a SHA-256 for every release asset (`digest: "sha256:…"`).
 * The engine is an executable, so the archive must match it before it is
 * unpacked. false = the release carries no digest, or the file does not match:
 * the caller must not install it. Never "unknown" — a missing digest is a
 * failed verification, not a pass.
 */
export function digestMatches(file: string, digest: unknown): boolean {
	const m = /^sha256:([0-9a-f]{64})$/i.exec(typeof digest === 'string' ? digest : '');
	if (!m) return false;
	const h = crypto.createHash('sha256');
	const fd = fs.openSync(file, 'r');
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n));
	} finally {
		fs.closeSync(fd);
	}
	return h.digest('hex') === m[1].toLowerCase();
}

/** The newest `bNNNN` release whose assets include the wanted build (pure; tested). */
export function pickRelease<R extends { tag_name?: string; assets?: Array<{ name: string }> }>(releases: R[], pick: (names: string[]) => string | undefined): { rel: R; name: string } | undefined {
	for (const rel of releases) {
		if (!/^b\d+$/.test(String(rel.tag_name)) || !rel.assets?.length) continue;
		const name = pick(rel.assets.map((x) => x.name));
		if (name) return { rel, name };
	}
	return undefined;
}

export interface InstallOptions {
	/** 'tested' (default for users) = ENGINE_PIN; 'latest' = the newest release. */
	channel?: EngineChannel;
	/** Tests replace the start check. */
	smoke?: (server: string) => { ok: boolean; detail: string };
}

/**
 * Download + unpack a llama.cpp build (Windows' tar.exe reads zip too).
 * Dependable by design: the tested build by default, the archive checked
 * against GitHub's SHA-256, the new build started once before it replaces
 * anything, and the previous build kept for rollback.
 */
export async function installEngine(engineDir: string, backend: Backend, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal, opts: InstallOptions = {}): Promise<EngineInstall & { note?: string }> {
	const release = acquireRuntimeLease(engineDir);
	if (!release) throw new Error('This runtime is being installed or maintained in another project. Retry shortly.');
	try { return await installEngineUnlocked(engineDir, backend, onProgress, signal, opts); }
	finally { release(); }
}

async function installEngineUnlocked(engineDir: string, backend: Backend, onProgress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal, opts: InstallOptions): Promise<EngineInstall & { note?: string }> {
	const channel = opts.channel ?? 'latest';
	const driver = backend === 'cuda' ? nvidiaDriverMajor() : undefined;
	const want = (names: string[]) => pickAsset(names, backend, process.platform, process.arch, driver);
	let found: { rel: any; name: string } | undefined;
	let note: string | undefined;
	if (channel === 'tested') {
		onProgress({ received: 0, total: 0, bytesPerSec: 0, stage: `Finding the tested llama.cpp build (${ENGINE_PIN})…` });
		found = pickRelease([await getJson(RELEASE_TAG(ENGINE_PIN)).catch(() => undefined)].filter(Boolean), want);
		if (!found) note = `The tested build ${ENGINE_PIN} has no ${backend} build for this system, so the newest one was installed.`;
	}
	if (!found) {
		onProgress({ received: 0, total: 0, bytesPerSec: 0, stage: 'Finding the latest llama.cpp build…' });
		const releases = await getJson(RELEASES());
		// The newest release that already carries this build: a release still uploading lists only some files (seen: b11264 with CUDA runtimes only).
		found = pickRelease(Array.isArray(releases) ? releases : [releases], want);
	}
	if (!found) {
		throw new Error(`llama.cpp has no ${backend} build for ${process.platform}-${process.arch} in its recent releases.`);
	}
	const before = installedEngine(engineDir);
	const { rel, name } = found;
	const asset = rel.assets.find((x: any) => x.name === name);
	const dir = path.join(engineDir, rel.tag_name + '-' + backend);
	const archive = path.join(engineDir, name);
	await download(asset.browser_download_url, archive, (p) => onProgress({ ...p, stage: `Downloading ${name}` }), signal, asset.size);
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Verifying…' });
	if (digestMatches(archive, asset.digest) !== true) {
		fs.rmSync(archive, { force: true });
		throw new Error(`The downloaded ${name} does not match the checksum GitHub publishes for it, so it was deleted and not installed. Try again; if it repeats, your network is altering the download.`);
	}
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Unpacking…' });
	fs.mkdirSync(dir, { recursive: true });
	// Windows: the built-in bsdtar (reads zip); a Git-for-Windows GNU tar earlier on PATH cannot.
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	const r = spawnSync(tar, ['-xf', archive, '-C', dir], { windowsHide: true, timeout: 300_000 });
	fs.rmSync(archive, { force: true });
	if (r.status !== 0) {
		throw new Error(`Could not unpack the engine: ${String(r.stderr || '').trim().slice(0, 200)}`);
	}
	// CUDA builds need NVIDIA's runtime DLLs, shipped as a separate archive.
	if (backend === 'cuda') {
		const rt = rel.assets.find((x: any) => /^cudart-llama-/.test(x.name) && x.name.includes(name.match(/-(win|ubuntu)-cuda-[\d.]+-(x64|arm64)/)?.[0] ?? '#'));
		if (rt) {
			const rtArchive = path.join(engineDir, rt.name);
			await download(rt.browser_download_url, rtArchive, (p) => onProgress({ ...p, stage: `Downloading ${rt.name}` }), signal, rt.size);
			if (digestMatches(rtArchive, rt.digest) !== true) {
				fs.rmSync(rtArchive, { force: true });
				throw new Error(`The downloaded ${rt.name} does not match its published checksum, so it was not installed.`);
			}
			spawnSync(tar, ['-xf', rtArchive, '-C', dir], { windowsHide: true, timeout: 300_000 });
			fs.rmSync(rtArchive, { force: true });
		}
	}
	// Reinstalling the same build unpacks over the folder in use: never delete that one.
	const inUse = (b?: EngineBuild) => !!b && path.resolve(b.server).startsWith(path.resolve(dir) + path.sep);
	const discard = () => {
		if (!inUse(before) && !inUse(before?.previous)) fs.rmSync(dir, { recursive: true, force: true });
	};
	const server = findServer(dir);
	if (!server) {
		discard();
		throw new Error('llama-server was not found in the downloaded build.');
	}
	if (process.platform !== 'win32') {
		fs.chmodSync(server, 0o755);
	}
	onProgress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Checking that it starts…' });
	const smoke = (opts.smoke ?? smokeTest)(server);
	if (!smoke.ok) {
		discard();
		const hint = missingRuntime(smoke.detail, backend);
		throw new Error(`The ${rel.tag_name} ${backend} build does not start on this machine${hint ? `: ${hint}` : ` (${smoke.detail})`}${before ? ` Your engine ${before.version} (${before.backend}) stays installed.` : ''}`);
	}
	const previous = before && !inUse(before) ? { version: before.version, backend: before.backend, server: before.server } : before?.previous;
	const meta: EngineInstall = { version: rel.tag_name, backend, server, ...(previous ? { previous } : {}) };
	writeEngine(engineDir, meta);
	// Keep two builds on disk: this one and the one to roll back to.
	const topDir = (b: EngineBuild) => path.resolve(engineDir, path.relative(engineDir, b.server).split(/[\\/]/)[0]);
	const keep = new Set([path.resolve(dir), ...(previous ? [topDir(previous)] : [])]);
	for (const e of fs.readdirSync(engineDir, { withFileTypes: true })) {
		const full = path.resolve(engineDir, e.name);
		if (e.isDirectory() && /^b\d+-\w+$/.test(e.name) && !keep.has(full)) {
			try {
				fs.rmSync(full, { recursive: true, force: true });
			} catch {
				/* still in use (another window's engine): removed on a later install */
			}
		}
	}
	return { ...meta, note };
}

export interface EngineOptions {
	/** Context tokens; 0 = auto (llama.cpp's --fit picks the largest that fits). */
	context: number;
	/** 'auto' = llama.cpp offloads as many layers as fit; 'cpu' = none. */
	gpu: 'auto' | 'cpu';
	/** q8_0 KV cache: about half the memory for long contexts. */
	lightKv: boolean;
	port: number;
	/** Free memory to leave per device (MiB) — more on GPUs that share system RAM. */
	fitMarginMiB: number;
	/** Prompt-cache RAM (MiB). */
	cacheRamMiB: number;
	fit?: import('./modelFit').ModelPlan;
	/** Internal retry for architectures/backends that cannot use a quantized cache. */
	cacheFallback?: boolean;
	/** Extra llama-server arguments (Turbo Fit plan, speed boost); later flags win. */
	extra?: string[];
	/** The plan before a saved tuning was applied, and the key that tuning is stored under. */
	untuned?: import('./modelFit').ModelPlan;
	tuneKey?: string;
}

/** What the running model ended up with. */
export interface EngineRun {
	model: string;
	ctx?: number;
	gpu: 'auto' | 'cpu';
	attempt: number;
	loadMs: number;
	cacheFallback?: boolean;
	fit?: import('./modelFit').ModelPlan;
	/** The model's draft head is loaded beside it. */
	draft?: boolean;
}

/** Load failures worth retrying with smaller settings. */
const MEMORY_ERROR = /out of (device )?memory|ErrorOutOfDeviceMemory|failed to allocate|unable to allocate|cudaMalloc|not enough memory|insufficient memory/i;

/** The final server line often only repeats "failed to load model"; retain the actual format or allocation error. */
export function modelLoadFailure(log: string): string {
	const lines = log.trim().split('\n').filter(l => / E |error/i.test(l));
	return (lines.find(l => /unknown.*architecture|unsupported|not supported|invalid.*(magic|gguf|version)|missing.*tensor|tensor.*(missing|wrong|mismatch)/i.test(l)) ??
		lines.find(l => MEMORY_ERROR.test(l)) ?? lines.slice(-2).join(' ')).slice(0, 800) || 'no details';
}
const CACHE_ERROR = /quantized V cache.*requires|V cache quantization.*flash|unsupported (K|V|KV).*cache|cache type.*not supported|does not support.*flash.?attn|quantized.*cache.*not.*support/i;

/**
 * One llama-server at a time, serving the model the chat asked for.
 *
 * Everything unset is fitted by llama.cpp itself (`--fit on`): it measures
 * each device's free memory and picks GPU layers and context so the model
 * loads on this machine — any machine. If a load still fails for lack of
 * memory we retry smaller: a 4K-context floor with a q8 KV cache, then CPU.
 */
export class EngineServer {
	private proc?: ChildProcess;
	model?: string;
	run?: EngineRun;
	private starting?: Promise<void>;
	/** Bumped by every ensure(): a load that lost the server to a newer one must not clear its state. */
	private generation = 0;
	log = '';
	/** Times the engine exited on its own after it had loaded (a crash), newest last. */
	crashes: number[] = [];
	lastCrash?: { at: number; model?: string; detail: string };

	constructor(private readonly onChange: () => void) {}

	get running(): boolean {
		return !!this.proc && this.proc.exitCode === null;
	}

	/** Crashes in the last 30 minutes: after 3 the chat stops restarting it by itself. */
	get recentCrashes(): number {
		return this.crashes.filter((t) => Date.now() - t < 30 * 60_000).length;
	}

	/** The engine process id (live monitor). */
	get pid(): number | undefined {
		return this.running ? this.proc?.pid : undefined;
	}

	args(model: LocalGguf, o: EngineOptions, attempt = 0): string[] {
		const context = o.fit?.context ?? o.context;
		const reduced = context > 0 && attempt ? Math.max(Math.min(2048, context), context >> attempt) : context;
		const fitContext = reduced > 0 ? Math.min(attempt ? 4096 : 8192, reduced) : attempt ? 4096 : 8192;
		const a = ['-m', model.path, '--host', '127.0.0.1', '--port', String(o.port), '--jinja', '--alias', model.id, '--no-webui', '-np', '1', '--fit', 'on', '--fit-target', String(o.fitMarginMiB), '--fit-ctx', String(fitContext), '--cache-ram', String(o.cacheRamMiB)];
		if (context > 0) {
			a.push('-c', String(reduced));
		}
		const cpu = o.gpu === 'cpu' || attempt >= 2 || (!attempt && !!o.fit?.cpu);
		if (cpu) {
			a.push('-ngl', '0');
		}
		if (o.lightKv || attempt >= 1 || o.fit) {
			const kv = o.cacheFallback ? 'f16' : attempt ? 'q8_0' : o.fit?.kv ?? 'q8_0';
			a.push('-ctk', kv, '-ctv', kv);
			// Plain attention is a first-attempt choice: a retry for memory goes back to the compact cache, which needs flash attention.
			if (!attempt && o.fit?.flash === false && kv === 'f16') a.push('-fa', 'off');
		}
		if (o.fit) {
			a.push('-t', String(o.fit.threads), '-tb', String(o.fit.batchThreads), '-b', String(o.fit.batch), '-ub', String(attempt ? Math.min(128, o.fit.ubatch) : o.fit.ubatch));
			if (o.fit.cpuExpertLayers && attempt === 0 && o.gpu !== 'cpu') a.push('--n-cpu-moe', String(o.fit.cpuExpertLayers));
		}
		// Agent turns resend a growing prompt: reuse the matching KV cache by shifting chunks.
		a.push('--cache-reuse', '256');
		// Prometheus /metrics on the loopback port: the live monitor's speed and context fill.
		a.push('--metrics');
		if (model.mmproj) {
			a.push('--mmproj', model.mmproj);
			if (cpu) a.push('--no-mmproj-offload');
		}
		// Turbo Fit / speed boost go last so they override the defaults; a retry after a
		// failed load drops them (the fallbacks above are the safe path).
		if (o.extra?.length && attempt === 0) {
			// A draft head beside a model on the processor wrote 3 tokens a second where the model alone wrote 21.
			a.push(...(cpu ? withoutDraftHead(o.extra) : o.extra));
		}
		return a;
	}

	/** Start (or switch to) `model`; resolves when /health answers. Retries smaller on memory errors. */
	async ensure(server: string, model: LocalGguf, o: EngineOptions, signal?: AbortSignal): Promise<void> {
		if (helperBySize(model.path, model.sizeBytes) || readModelShape(model.path).draft) throw new Error(`${model.id} is a helper file, not a standalone chat model. Select its matching main model instead.`);
		if (this.running && this.model === model.id) {
			return this.starting;
		}
		this.stop();
		this.model = model.id;
		const started = Date.now();
		const mine = ++this.generation;
		this.starting = (async () => {
			let lastError = '';
			let loadOptions = o;
			for (let attempt = 0; attempt < 3; attempt++) {
				if (o.gpu === 'cpu' && attempt === 2) {
					break;
				}
				try {
					await this.launch(server, model, loadOptions, attempt, signal);
					const drafted = !attempt && draftsAhead(loadOptions.extra) && !(o.gpu === 'cpu' || o.fit?.cpu);
					this.run = { draft: drafted || undefined, model: model.id, gpu: o.gpu === 'cpu' || attempt >= 2 || (!attempt && o.fit?.cpu) ? 'cpu' : 'auto', attempt, loadMs: Date.now() - started, ctx: await this.readCtx(o.port), cacheFallback: loadOptions.cacheFallback, fit: attempt ? undefined : o.fit };
					this.onChange();
					return;
				} catch (e) {
					lastError = e instanceof Error ? e.message : String(e);
					// The install folder is "bNNNN-<backend>": tell backend-specific runtime problems apart.
					const runtime = missingRuntime(this.log, /b\d+-(\w+)[\\/]/.exec(server)?.[1]);
					if (runtime) {
						throw new Error(runtime);
					}
					if (!signal?.aborted && CACHE_ERROR.test(this.log) && !loadOptions.cacheFallback) {
						loadOptions = { ...o, cacheFallback: true };
						continue;
					}
					// A draft head the build cannot use must not cost the model: once more without it.
					if (!signal?.aborted && !attempt && draftsAhead(loadOptions.extra) && !MEMORY_ERROR.test(this.log)) {
						loadOptions = { ...loadOptions, extra: withoutDraftHead(loadOptions.extra) };
						attempt--;
						continue;
					}
					if (signal?.aborted || !MEMORY_ERROR.test(this.log)) {
						throw e;
					}
				}
			}
			throw new Error(`${model.id} does not fit in this machine's memory, even with a 4K context on the CPU. Pick a smaller quantisation (Q4 or lower) or a smaller model. (${lastError.slice(0, 160)})`);
		})().catch((e) => {
			if (this.generation === mine) {
				this.model = undefined;
				this.onChange();
			}
			throw e;
		});
		return this.starting;
	}

	/** Who answers on this port: false when it is our model, else the other model's name. */
	private async servedElsewhere(port: number, alias: string): Promise<string | false> {
		try {
			const j = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(2000) })).json()) as { data?: Array<{ id?: string }> };
			const ids = (j.data ?? []).map((m) => String(m.id));
			return !ids.length || ids.includes(alias) ? false : ids[0];
		} catch {
			return false;
		}
	}

	private async readCtx(port: number): Promise<number | undefined> {
		try {
			const props = (await (await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(3000) })).json()) as { default_generation_settings?: { n_ctx?: number } };
			return props.default_generation_settings?.n_ctx;
		} catch {
			return undefined;
		}
	}

	private async launch(server: string, model: LocalGguf, o: EngineOptions, attempt: number, signal?: AbortSignal): Promise<void> {
		this.log = '';
		const proc = spawn(server, this.args(model, o, attempt), { windowsHide: true, cwd: path.dirname(server), env: engineEnv(server) });
		this.proc = proc;
		const keep = (c: Buffer) => (this.log = (this.log + c.toString()).slice(-8000));
		proc.stdout?.on('data', keep);
		proc.stderr?.on('data', keep);
		proc.on('exit', (code, sig) => this.exited(proc, code, sig));
		this.onChange();
		const until = Date.now() + 10 * 60_000;
		while (Date.now() < until) {
			if (signal?.aborted) {
				this.stop();
				throw new Error('Cancelled.');
			}
			if (this.proc !== proc) {
				throw new Error(`The engine stopped while loading ${model.id}: ${modelLoadFailure(this.log)}`);
			}
			let healthy = false;
			try {
				healthy = (await fetch(`http://127.0.0.1:${o.port}/health`, { signal: AbortSignal.timeout(1500) })).ok;
			} catch {
				/* still loading */
			}
			if (healthy) {
				// Our process may have died on a busy port while a leftover engine (crashed session) answers /health.
				const other = await this.servedElsewhere(o.port, model.id);
				if (other) {
					this.stop();
					throw new Error(`Port ${o.port} is already used by another server (it serves "${other}") — probably a leftover engine from an earlier session. Close it, or change the engine port under Local models → Engine.`);
				}
				return;
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		this.stop();
		throw new Error('The model took too long to load.');
	}

	/** The process ended. On its own after loading (stop() clears proc first) it is a crash. */
	exited(proc: ChildProcess, code: number | null, sig: NodeJS.Signals | null): void {
		if (this.proc !== proc) return;
		if (this.run) {
			const at = Date.now();
			this.crashes = [...this.crashes.filter((t) => at - t < 30 * 60_000), at];
			this.lastCrash = { at, model: this.model, detail: this.log.trim().split('\n').filter((l) => / E |error|fault|abort|assert/i.test(l)).slice(-2).join(' ').slice(0, 300) || `exit ${code ?? sig}` };
		}
		this.proc = undefined;
		this.run = undefined;
		this.onChange();
	}

	/** Does the engine answer on its port? */
	async healthy(port: number): Promise<boolean> {
		try {
			return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok;
		} catch {
			return false;
		}
	}

	/** The engine stopped answering though its process looks alive (hung, or its exit is not reported yet): count a crash and clear it. */
	abandon(): void {
		const proc = this.proc;
		if (!proc) return;
		this.kill(proc);
		this.exited(proc, null, null);
	}

	private kill(proc: ChildProcess): void {
		if (proc.exitCode !== null) return;
		if (process.platform === 'win32' && proc.pid) {
			spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
		} else {
			proc.kill();
		}
	}

	stop(): void {
		if (this.proc) this.kill(this.proc);
		this.proc = undefined;
		this.model = undefined;
		this.run = undefined;
		this.onChange();
	}
}

/** GPUs llama.cpp can use through the installed build (async; parsed from --list-devices). */
export function listDevices(server: string): Promise<Array<{ name: string; totalMiB: number; freeMiB: number }>> {
	return new Promise((resolve) => {
		execFile(server, ['--list-devices'], { timeout: 20_000, windowsHide: true, cwd: path.dirname(server), env: engineEnv(server) }, (_err, out, err) => {
			const text = `${out}\n${err}`;
			const devices = [...text.matchAll(/^\s*\w+\d+:\s*(.+?)\s*\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)/gm)].map((m) => ({ name: m[1], totalMiB: Number(m[2]), freeMiB: Number(m[3]) }));
			resolve(devices);
		});
	});
}

/** The best backend for this device: CUDA on NVIDIA, Metal on Apple, Vulkan for other GPUs, CPU without one. */
export function autoBackend(hasNvidia: boolean): Backend {
	if (process.platform === 'darwin') {
		return 'metal';
	}
	if (process.platform === 'win32' && process.arch === 'arm64') {
		return 'cpu';
	}
	return hasNvidia ? 'cuda' : 'vulkan';
}

// ---------------------------------------------------------------- LM Studio (lms CLI)

export function lmsPath(): string | undefined {
	const p = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
	return fs.existsSync(p) ? p : undefined;
}

function runLms(args: string[], timeout = 120_000): Promise<string> {
	const lms = lmsPath();
	if (!lms) {
		return Promise.reject(new Error('LM Studio (lms) is not installed.'));
	}
	return new Promise((resolve, reject) =>
		execFile(lms, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(out))))
	);
}

export interface LmsModel {
	key: string;
	name: string;
	sizeBytes: number;
	params?: string;
	quant?: string;
	tools?: boolean;
	vision?: boolean;
	maxContext?: number;
	loaded?: boolean;
}

export async function lmsModels(): Promise<LmsModel[]> {
	const [all, loaded] = await Promise.all([runLms(['ls', '--json'], 30_000), runLms(['ps', '--json'], 30_000).catch(() => '[]')]);
	const live = new Set((JSON.parse(loaded || '[]') as Array<{ modelKey?: string; identifier?: string }>).map((m) => m.modelKey ?? m.identifier));
	return (JSON.parse(all) as any[])
		.filter((m) => m.type === 'llm')
		.map((m) => ({ key: m.modelKey, name: m.displayName ?? m.modelKey, sizeBytes: m.sizeBytes ?? 0, params: m.paramsString, quant: m.quantization?.name, tools: m.trainedForToolUse, vision: m.vision, maxContext: m.maxContextLength, loaded: live.has(m.modelKey) }));
}

/** Load a model in LM Studio and make sure its OpenAI-compatible server is up. */
export async function lmsLoad(key: string): Promise<void> {
	await runLms(['load', key, '--yes'], 600_000);
	await runLms(['server', 'start'], 60_000).catch(() => undefined);
}

export async function lmsUnload(key?: string): Promise<void> {
	await runLms(key ? ['unload', key] : ['unload', '--all'], 60_000);
}
