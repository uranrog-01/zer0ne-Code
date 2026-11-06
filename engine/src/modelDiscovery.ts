import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import type { Machine } from './localModels';
import { LLM_SEEDS, quantSpec, rateLlm, rateLlmAt, pickLlmFile, type LlmSeed, type Profile } from './localCatalog';
import { hfCached } from './hfCache';
import { ENGINE_PIN, hfInfo, hfFiles, hfModelShape, searchHf, ggufBuilds, ggufByName, validRepoId, type HfModel, type HfFile } from './localEngine';
import type { ModelShape } from './modelFit';
import { ADVISOR_VERSION, LocalAdvisor, advisorCatalog, TRUSTED_MODEL_REPO, type AdvisorModel, type AdvisorFit } from './localAdvisor';
import { moeInfo } from './turboFit';
import { draftArchitecture, modelFiles } from './repoFiles';
import { nativeSupport, architectureReason, quantizationReason, type NativeSupport } from './nativeSupport';

const BAD_MODEL = /(?:mtp-only|embedding|rerank|eagle|dflash|dspark)/i;
export const modelKey = (id: string) => id.split('/').pop()!.toLowerCase().replace(/[-_.](?:i1-)?gguf$/i, '').replace(/[-_.](?:ud-)?(?:q[2-8]_[a-z0-9_]+|iq[1-4]_[a-z0-9_]+|bf16|f16)$/i, '');

export function liveProfile(p: Profile, freeBytes = os.freemem()): Profile {
	const ram = Math.max(0, Math.min(p.ramBytes * 0.8, freeBytes - Math.max(1024 ** 3, p.ramBytes * 0.08)));
	const dedicated = p.gpu === 'dedicated';
	return { ...p, availableRamBytes: ram, fastBytes: dedicated ? p.fastBytes : Math.min(p.fastBytes, ram), ceilingBytes: dedicated ? Math.max(p.fastBytes, ram) : ram };
}

/**
 * The limits a model is rated against: what this computer has, not what happens to be free this minute, so
 * a rating does not change when another app opens. What is free now is kept beside them for the "close
 * other apps" warning; loading a model still fits it to the memory that is really free (modelFit.ts).
 */
export function ratedProfile(p: Profile, freeBytes = os.freemem(), freeGpuBytes?: number): Profile {
	const live = liveProfile(p, freeBytes);
	const availableFastBytes = p.gpu === 'dedicated' && freeGpuBytes !== undefined ? Math.max(0, Math.min(p.fastBytes, freeGpuBytes * 0.92)) : live.fastBytes;
	return { ...p, availableRamBytes: live.availableRamBytes, availableFastBytes };
}

export function seedFromAdvisor(row: AdvisorModel, advice?: AdvisorFit): LlmSeed | undefined {
	if (BAD_MODEL.test(row.name)) return undefined;
	const candidates = [...(TRUSTED_MODEL_REPO.test(row.name) && /gguf/i.test(row.name) ? [row.name] : []), ...(row.gguf_sources ?? []).map((s) => s.repo)];
	const repo = candidates.find((r) => validRepoId(r) && TRUSTED_MODEL_REPO.test(r) && !BAD_MODEL.test(r));
	if (!repo) return undefined;
	const params = row.parameters_raw / 1e9;
	const active = row.active_parameters ? row.active_parameters / 1e9 : moeInfo(row.name, row.parameters_raw).active ? moeInfo(row.name, row.parameters_raw).active! / 1e9 : undefined;
	const quality = Math.max(33, Math.min(90, advice?.quality ?? (20 + 17 * Math.log2(Math.max(1, active ? Math.sqrt(params * active) : params)) + (/cod|devstral|swe/i.test(row.name) ? 8 : 0))));
	const kvBytes = row.num_hidden_layers && row.num_key_value_heads && row.head_dim ? 4 * row.num_hidden_layers * row.num_key_value_heads * row.head_dim : undefined;
	return { id: 'hf:' + repo, modelId: row.name, repo, name: row.name.split('/').pop()!.replace(/[-_]GGUF$/i, '').replace(/[-_]/g, ' '), family: row.architecture ?? '', params, active,
		q4Gb: params * 4.85 / 8, ctx: row.context_length || 8192, released: row.release_date ?? '', tools: row.capabilities?.includes('tool_use') === true, quality: { coding: quality },
		mmprojGb: row.capabilities?.includes('vision') ? 0.9 : undefined, license: row.license ?? 'see model page', downloads: row.hf_downloads,
		blurb: 'From llmfit’s model catalog; Hugging Face checks the available builds.', source: 'llmfit', arch: row.architecture, kvBytes,
		advisor: advice ? { quant: advice.quant, tokS: advice.tokS, confidence: advice.confidence, score: advice.score } : undefined };
}

export function seedFromHub(info: HfModel, fallback?: LlmSeed, shape?: ModelShape): LlmSeed | undefined {
	// The file's own header is the best source for the cache size and the longest context.
	if (shape?.kvBytesPerToken || shape?.context) {
		const seed = seedFromHub(info, fallback);
		return seed && { ...seed, kvBytes: shape.kvBytesPerToken ?? seed.kvBytes, ctx: shape.context ?? seed.ctx };
	}
	const params = info.params ? info.params / 1e9 : fallback?.params;
	if (shape?.draft || draftArchitecture(shape?.arch ?? info.arch)) return undefined;
	if (!params || params < 0.3 || params > 400 || !validRepoId(info.id) || BAD_MODEL.test(info.id)) return undefined;
	const active = fallback?.active ?? ((moeInfo(info.id, params * 1e9).active ?? 0) / 1e9 || undefined);
	return { ...fallback, id: fallback?.id ?? 'hf:' + info.id, name: fallback?.name ?? info.id.split('/')[1].replace(/[-_]GGUF$/i, '').replace(/[-_]/g, ' '), repo: info.id,
		modelId: info.baseModel ?? fallback?.modelId ?? info.id, family: info.arch ?? fallback?.family ?? '', params, active, q4Gb: fallback?.q4Gb ?? params * 4.85 / 8,
		ctx: info.context ?? fallback?.ctx ?? 8192, tools: info.tools ?? (LLM_SEEDS.some((s) => s.repo.toLowerCase() === info.id.toLowerCase() && s.tools)), mmprojGb: info.vision || fallback?.mmprojGb ? fallback?.mmprojGb ?? 0.9 : undefined,
		quality: fallback?.quality ?? { coding: Math.max(28, Math.min(84, 24 + 17 * Math.log2(Math.max(1, active ? Math.sqrt(params * active) : params)) + (/cod|devstral|swe/i.test(info.id) ? 8 : 0))) },
		license: info.license ?? fallback?.license ?? 'see model page', released: info.created?.slice(0, 10) ?? fallback?.released ?? '', downloads: info.downloads,
		blurb: fallback?.blurb ?? 'Discovered on Hugging Face. Build sizes and context are checked for this computer.', source: fallback?.source ?? 'huggingface', arch: info.arch ?? fallback?.arch };
}

export function fitHubFiles(info: HfModel, all: HfFile[], p: Profile, fallback?: LlmSeed, support?: NativeSupport, shape?: ModelShape, opts: { lightKv?: boolean } = {}) {
	if (shape?.draft || draftArchitecture(shape?.arch ?? info.arch)) return [];
	const seed = seedFromHub(info, fallback, shape);
	// A saved listing can still hold a draft head or another side file; only the weights are builds.
	const weights = new Set(modelFiles(all.filter((f) => !f.mmproj && !f.draft), seed?.params ?? (info.params ? info.params / 1e9 : undefined)));
	const files = all.filter((f) => f.mmproj || weights.has(f));
	const runtimeReason = support ? architectureReason(shape?.arch ?? info.arch, support) : undefined;
	if (seed) seed.runtimeReason = runtimeReason;
	const projector = files.filter((f) => f.mmproj).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
	const choice = seed ? pickLlmFile(seed, 'coding', p, files.filter(f => !f.assembly && (f.mmproj || !support || !quantizationReason(f.quant, support))), { lightKv: opts.lightKv }) : undefined;
	return files.map((f) => {
		if (f.mmproj) return { ...f };
		const quant = quantSpec(f.quant);
		const tensorReason = support ? quantizationReason(f.quant, support) : undefined;
		const rating = seed && quant ? rateLlmAt(seed, 'coding', p, quant, { fileBytes: f.sizeBytes, projectorBytes: projector?.sizeBytes ?? 0, lightKv: opts.lightKv }) : undefined;
		const missing = !!seed?.mmprojGb && !projector;
		const disk = p.diskBytes !== undefined && f.sizeBytes + (projector?.sizeBytes ?? 0) + 0.25e9 > p.diskBytes;
		const assemblyReason = f.assembly ? 'These are raw .gguf.partN chunks, not runnable GGUF shards. They must be joined using the publisher’s instructions and loaded with a compatible runtime. This app cannot download or run them as a chat model.' : undefined;
		const reason = assemblyReason ?? runtimeReason ?? tensorReason ?? (missing ? 'This vision model has no projector in this repository.' : disk ? 'Not enough free disk space for the complete model.' : !seed ? 'Parameter and context metadata are not available for a safe fit estimate.' : !quant ? 'This quantization has no supported fit estimate.' : rating?.reason);
		const fit = assemblyReason || runtimeReason || tensorReason || !quant ? 'unsupported' : missing || disk || !rating || rating.verdict === 'no' ? 'too-large' : rating.verdict === 'perfect' || rating.verdict === 'good' ? 'fits' : 'tight';
		return { ...f, fit, rating, reason, recommended: fit !== 'unsupported' && !missing && !disk && choice?.file.name === f.name, verified: true, projectorBytes: projector?.sizeBytes ?? 0 };
	});
}

export function hubSearchModels(checked: LlmSeed[], remote: HfModel[], query: string, format: string, size?: { min?: number; max?: number }, append = false, sort = 'downloads'): HfModel[] {
	const q = query.trim().toLowerCase();
	const local: HfModel[] = append ? [] : checked.filter((s) => s.files?.some((f) => !f.mmproj) && (!q || `${s.name} ${s.repo}`.toLowerCase().includes(q)) && (format !== 'vision' || !!s.mmprojGb) && (!size?.min || s.params * 1e9 >= size.min) && (!size?.max || s.params * 1e9 <= size.max)).map((s) => ({
		id: s.repo, author: s.repo.split('/')[0], params: s.params * 1e9, context: s.ctx, tools: s.tools, vision: !!s.mmprojGb, arch: s.arch,
		format: 'gguf', pipeline: s.mmprojGb ? 'image-text-to-text' : 'text-generation', tags: ['gguf'], downloads: s.downloads ?? 0, likes: 0, license: s.license,
		baseModel: s.modelId, revision: s.files?.[0]?.revision, created: s.released
	}));
	const current = new Map(remote.map((m) => [m.id.toLowerCase(), m]));
	const enriched = local.map((m) => {
		const r = current.get(m.id.toLowerCase());
		return r ? { ...r, ...m, gated: r.gated, likes: r.likes, downloads: r.downloads, updated: r.updated } : m;
	});
	const seen = new Set<string>();
	const items = [...enriched, ...remote].filter((m) => !seen.has(m.id.toLowerCase()) && !!seen.add(m.id.toLowerCase()));
	if (append) return items;
	if (sort === 'downloads' || sort === 'likes') return items.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
	if (sort === 'lastModified') return items.sort((a, b) => (Date.parse(b.updated ?? '') || 0) - (Date.parse(a.updated ?? '') || 0));
	// Trending scores are not returned by the Hub; preserve its ranked page before unranked builds.
	const rank = new Map(remote.map((m, i) => [m.id.toLowerCase(), i]));
	return items.sort((a, b) => (rank.get(a.id.toLowerCase()) ?? remote.length) - (rank.get(b.id.toLowerCase()) ?? remote.length));
}

export function rateHubSearch(info: HfModel, fallback: LlmSeed | undefined, p: Profile, support: NativeSupport, opts: { lightKv?: boolean } = {}) {
	const seed = seedFromHub(info, fallback);
	const runtimeReason = info.format === 'gguf' ? architectureReason(info.arch, support) : undefined;
	if (seed) seed.runtimeReason = runtimeReason;
	const rated = fallback?.files && info.format === 'gguf' ? fitHubFiles(info, fallback.files, p, fallback, support, undefined, opts).filter((f): f is Extract<typeof f, { fit: string }> => 'fit' in f && !f.mmproj) : [];
	const exact = rated.find((f) => f.recommended) ?? rated.find((f) => f.fit === 'fits') ?? rated.find((f) => f.fit === 'tight') ?? rated[0];
	const rating = exact?.rating ?? (seed ? rateLlm(seed, 'coding', p, opts) : undefined);
	return { rating, evidence: exact ? 'checked-build' : 'estimated', q4Bytes: seed ? Math.round(seed.q4Gb * 1e9) : undefined,
		fit: info.format !== 'gguf' ? 'build-needed' : runtimeReason ? 'unsupported' : exact ? exact.fit : rating ? rating.verdict === 'no' ? 'too-large' : ['perfect', 'good'].includes(rating.verdict) ? 'fits' : 'tight' : undefined };
}

export class ModelDiscovery {
	readonly advisor: LocalAdvisor;
	private seeds: LlmSeed[] = [];
	private at = 0;
	private nativeVersion?: string;
	private running?: Promise<void>;
	private disposed = false;
	error?: string;
	offline = false;
	constructor(private readonly storageDir: string, private readonly machine: () => Machine, private readonly profile: () => Profile, private readonly engineVersion?: () => string) {
		this.advisor = new LocalAdvisor(path.join(storageDir, 'model-advisor'));
		try { const raw = fs.readFileSync(path.join(storageDir, 'model-discovery.json'), 'utf8'); const saved = JSON.parse(raw); if (saved.version === ADVISOR_VERSION && saved.catalogVersion === 3 && Array.isArray(saved.seeds)) { this.seeds = saved.seeds.filter((s: any) => validRepoId(s.repo) && TRUSTED_MODEL_REPO.test(s.repo) && typeof s.name === 'string' && s.params > 0 && Number.isFinite(s.params) && s.ctx > 0 && s.quality).slice(0, 160); this.at = saved.at; this.nativeVersion = saved.nativeVersion; } } catch { /* First visit. */ }
	}
	dispose() { this.disposed = true; this.advisor.dispose(); }
	state() { return { ...this.advisor.state(), catalogSize: advisorCatalog().length, checked: this.seeds.filter((s) => s.verified).length, loading: !!this.running, offline: this.offline, at: this.at || undefined, error: this.error ?? this.advisor.error }; }
	current() { return this.seeds; }
	find(repo: string) { return [...this.seeds, ...LLM_SEEDS].find((s) => s.repo.toLowerCase() === repo.toLowerCase()); }
	support() { return nativeSupport(path.join(this.storageDir, 'hf-cache'), this.engineVersion?.()); }
	async info(repo: string, refresh = false) {
		const result = await hfCached(path.join(this.storageDir, 'hf-cache'), `info-v3|${repo}`, () => hfInfo(repo), refresh ? 0 : 3600_000, true);
		this.offline ||= !!result.offline;
		return result.value;
	}
	/** The listing as Hugging Face has it: builds, projectors, and draft heads marked as such. */
	private async listing(repo: string, info?: HfModel, maxAgeMs = 3600_000) {
		return hfCached(path.join(this.storageDir, 'hf-cache'), `files-v4|${repo}|${info?.revision ?? 'main'}`, () => hfFiles(repo, info?.revision, true), maxAgeMs, true);
	}
	async files(repo: string, info?: HfModel, refresh = false) {
		const result = await this.listing(repo, info, refresh ? 0 : 3600_000);
		this.offline ||= !!result.offline;
		return result.value.filter((f) => !f.draft);
	}
	/**
	 * The repository's draft head, when it has one that says so in its own header: the smallest.
	 * Never a reason to fail; without it the model is simply loaded alone.
	 */
	async draftHead(repo: string, info?: HfModel): Promise<HfFile | undefined> {
		try {
			const named = (await this.listing(repo, info)).value.filter((f) => f.draft && f.metadata?.length === 1).sort((a, b) => a.sizeBytes - b.sizeBytes || a.parts[0].length - b.parts[0].length);
			for (const f of named.slice(0, 2)) if ((await this.shape(repo, f)).draft) return f;
		} catch { /* Offline or rate-limited: the model does not need it. */ }
		return undefined;
	}
	/** What a file says about itself, read once per revision (a megabyte, not the model). */
	async shape(repo: string, file: HfFile): Promise<ModelShape> {
		try {
			return (await hfCached(path.join(this.storageDir, 'hf-cache'), `shape-v2|${repo}|${file.revision ?? 'main'}|${file.parts[0]}`, () => hfModelShape(repo, file.parts[0], file.revision), 30 * 86400_000, true)).value;
		} catch { return {}; }
	}
	async scan(repo: string) {
		const dir = path.join(this.storageDir, 'hf-cache');
		const info = await hfCached(dir, `info-v3|${repo}`, () => hfInfo(repo), 0, true);
		const files = await this.listing(repo, info.value, 0);
		return { info: info.value, files: files.value.filter((f) => !f.draft), offline: !!info.offline || !!files.offline };
	}
	async builds(id: string) {
		const snapshot = advisorCatalog().find((m) => m.name.toLowerCase() === id.toLowerCase());
		const [tagged, named] = await Promise.all([ggufBuilds(id).catch(() => []), ggufByName(id).catch(() => [])]);
		const seen = new Set<string>();
		return [...tagged.map((b) => ({ ...b, exact: true })), ...(snapshot?.gguf_sources ?? []).map((s) => ({ id: s.repo, downloads: 0, likes: 0, exact: true })), ...named].filter((b) => validRepoId(b.id) && !seen.has(b.id.toLowerCase()) && seen.add(b.id.toLowerCase())).slice(0, 16);
	}
	refresh(onChange: () => void, force = false): Promise<void> {
		if (this.disposed) return Promise.resolve();
		if (this.running) return this.running;
		if (!force && this.nativeVersion === (this.engineVersion?.() ?? ENGINE_PIN) && this.at && Date.now() - this.at < 6 * 3600_000) return Promise.resolve();
		this.running = this.discover(onChange, force).catch((e) => { this.error = e instanceof Error ? e.message : String(e); this.at = Date.now(); }).finally(() => { this.running = undefined; if (!this.disposed) onChange(); });
		return this.running;
	}
	private async discover(onChange: () => void, force: boolean) {
		this.offline = false; this.error = undefined;
		const p = this.profile();
		const support = await this.support();
		this.nativeVersion = support.version;
		const [advice, hub] = await Promise.all([this.advisor.recommendations(this.machine(), p), hfCached(path.join(this.storageDir, 'hf-cache'), 'discovery-v2', async () => {
			const responses = await Promise.allSettled([searchHf('', 'trendingScore', 80, 'gguf'), searchHf('coder', 'downloads', 60, 'gguf'), searchHf('', 'downloads', 40, 'vision')]);
			const found = responses.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
			if (!found.length && responses.every((r) => r.status === 'rejected')) throw (responses[0] as PromiseRejectedResult).reason;
			return found;
		}, force ? 0 : 6 * 3600_000, true).catch((e) => { this.error = String(e instanceof Error ? e.message : e); return { value: [] as HfModel[], offline: true as const }; })]);
		if (this.disposed) return;
		this.offline = !!hub.offline;
		const fits = new Map(advice.map((a) => [a.name.toLowerCase(), a]));
		const advised = advisorCatalog().map((r) => seedFromAdvisor(r, fits.get(r.name.toLowerCase()))).filter((s): s is LlmSeed => !!s);
		const byFamily = new Map(advised.map((s) => [modelKey(s.modelId ?? s.repo), s]));
		const candidates = [...LLM_SEEDS.map((s) => { const a = byFamily.get(modelKey(s.repo)); return a ? { ...s, kvBytes: a.kvBytes, advisor: a.advisor, source: 'llmfit' as const, quality: a.advisor ? a.quality : s.quality } : s; }), ...advised, ...hub.value.filter((m) => TRUSTED_MODEL_REPO.test(m.id) && m.format === 'gguf').map((m) => seedFromHub(m)).filter((s): s is LlmSeed => !!s)];
		const unique = new Map<string, LlmSeed>();
		for (const s of candidates) { const key = modelKey(s.modelId ?? s.repo); if (!unique.has(key)) unique.set(key, s); }
		const curated = new Set(LLM_SEEDS.map((s) => s.repo.toLowerCase()));
		const ranked = [...unique.values()].sort((a, b) => Number(curated.has(b.repo.toLowerCase())) - Number(curated.has(a.repo.toLowerCase())) || Number(rateLlm(a, 'coding', p).verdict === 'no') - Number(rateLlm(b, 'coding', p).verdict === 'no') || Number(rateLlm(b, 'coding', p).strict) - Number(rateLlm(a, 'coding', p).strict) || (b.advisor?.score ?? rateLlm(b, 'coding', p).score) - (a.advisor?.score ?? rateLlm(a, 'coding', p).score)).slice(0, 128);
		const checked: LlmSeed[] = [];
		let index = 0;
		const worker = async () => {
			while (index < ranked.length && !this.disposed) {
				const seed = ranked[index++];
				try {
					const info = await this.info(seed.repo, force);
					if (this.disposed) return;
					const files = await this.files(seed.repo, info, force);
					const enriched = seedFromHub(info, seed);
					if (!enriched || !files.some((f) => !f.mmproj && !f.assembly)) continue;
					const q4 = files.find((f) => !f.mmproj && /^(UD-)?Q4_K_M$/i.test(f.quant));
					if (q4) enriched.q4Gb = q4.sizeBytes / 1e9;
					const projector = files.filter((f) => f.mmproj).sort((a, b) => a.sizeBytes - b.sizeBytes)[0];
					if (projector) enriched.mmprojGb = projector.sizeBytes / 1e9;
					enriched.files = files; enriched.verified = !this.offline; enriched.runtimeReason = architectureReason(info.arch, support);
					checked.push(enriched);
					if (checked.length % 8 === 0 && !this.disposed) { this.merge(checked); onChange(); }
				} catch (e) { if (!this.error) this.error = e instanceof Error ? e.message : String(e); }
			}
		};
		await Promise.all([worker(), worker(), worker()]);
		if (this.disposed) return;
		this.merge(checked); this.at = Date.now();
		try { fs.mkdirSync(this.storageDir, { recursive: true }); fs.writeFileSync(path.join(this.storageDir, 'model-discovery.json'), JSON.stringify({ version: ADVISOR_VERSION, catalogVersion: 3, nativeVersion: this.nativeVersion, at: this.at, seeds: this.seeds })); } catch { /* Full disks retain the in-memory list. */ }
	}
	private merge(checked: LlmSeed[]) {
		const all = new Map(this.seeds.map((s) => [s.repo.toLowerCase(), s]));
		for (const s of checked) all.set(s.repo.toLowerCase(), s);
		this.seeds = [...all.values()].slice(-160);
	}
}
