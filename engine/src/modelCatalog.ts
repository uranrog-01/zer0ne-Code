import * as vscode from 'vscode';
import type { ApiFormat } from './providerStore';

/**
 * Provider/model catalog from models.dev (the source opencode uses):
 * one fetch gives every provider's base URL, wire format, model list,
 * limits, capabilities and per-token prices. It powers:
 *
 *  - the "Add provider" picker (presets instead of manual entry)
 *  - "Smart configuration" (context window / max output / vision)
 *  - cost estimates on the usage page
 *
 * The parsed catalog is cached as a file in globalStorage for 24 hours
 * (it is ~1 MB — too large for globalState); a small bundled fallback
 * keeps the picker usable offline.
 */

export interface CatalogModel {
	id: string;
	name?: string;
	priceIn?: number; // $ per million input tokens
	priceOut?: number; // $ per million output tokens
	priceCacheRead?: number; // $ per million cached input tokens
	priceCacheWrite?: number;
	priceCacheWrite1h?: number;
	contextWindow?: number;
	maxOutput?: number;
	vision?: boolean;
	tools?: boolean;
	reasoning?: boolean;
}

export interface CatalogProvider {
	id: string;
	name: string;
	baseUrl?: string;
	apiFormat: ApiFormat;
	models: CatalogModel[];
}

export interface CatalogSummary {
	id: string;
	name: string;
	baseUrl?: string;
	apiFormat: ApiFormat;
	modelCount: number;
}

const CATALOG_URL = 'https://models.dev/api.json';
const CATALOG_TTL = 24 * 60 * 60 * 1000;
const CACHE_FILE = 'models-catalog.json';
const LEGACY_KEYS = ['aiChat.catalog', 'aiChat.catalogAt'];

/**
 * models.dev only lists `api` for providers served through the generic
 * OpenAI-compatible SDK; first-party SDK providers need their base URL here.
 */
const KNOWN_BASE_URLS: Record<string, string> = {
	openai: 'https://api.openai.com/v1',
	anthropic: 'https://api.anthropic.com',
	google: 'https://generativelanguage.googleapis.com/v1beta/openai',
	groq: 'https://api.groq.com/openai/v1',
	mistral: 'https://api.mistral.ai/v1',
	xai: 'https://api.x.ai/v1',
	deepseek: 'https://api.deepseek.com/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	togetherai: 'https://api.together.xyz/v1',
	cerebras: 'https://api.cerebras.ai/v1',
	'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
	perplexity: 'https://api.perplexity.ai',
	deepinfra: 'https://api.deepinfra.com/v1/openai',
	moonshotai: 'https://api.moonshot.ai/v1',
	zai: 'https://api.z.ai/api/paas/v4',
	'zai-coding-plan': 'https://api.z.ai/api/coding/paas/v4',
	vercel: 'https://ai-gateway.vercel.sh/v1',
	nvidia: 'https://integrate.api.nvidia.com/v1'
};

const FALLBACK: CatalogProvider[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		baseUrl: KNOWN_BASE_URLS.openai,
		apiFormat: 'openai',
		models: [
			{ id: 'gpt-4.1-mini', priceIn: 0.4, priceOut: 1.6, contextWindow: 1_047_576, maxOutput: 32_768, vision: true, tools: true },
			{ id: 'gpt-4.1', priceIn: 2, priceOut: 8, contextWindow: 1_047_576, maxOutput: 32_768, vision: true, tools: true },
			{ id: 'o4-mini', priceIn: 1.1, priceOut: 4.4, contextWindow: 200_000, maxOutput: 100_000, vision: true, tools: true, reasoning: true }
		]
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		baseUrl: KNOWN_BASE_URLS.anthropic,
		apiFormat: 'anthropic',
		models: [
			{ id: 'claude-sonnet-4-5', priceIn: 3, priceOut: 15, contextWindow: 200_000, maxOutput: 64_000, vision: true, tools: true, reasoning: true },
			{ id: 'claude-haiku-4-5', priceIn: 1, priceOut: 5, contextWindow: 200_000, maxOutput: 64_000, vision: true, tools: true, reasoning: true }
		]
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		baseUrl: KNOWN_BASE_URLS.openrouter,
		apiFormat: 'openai',
		models: []
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		baseUrl: KNOWN_BASE_URLS.deepseek,
		apiFormat: 'openai',
		models: [
			{ id: 'deepseek-chat', priceIn: 0.27, priceOut: 1.1, contextWindow: 128_000, maxOutput: 8_192, tools: true },
			{ id: 'deepseek-reasoner', priceIn: 0.55, priceOut: 2.19, contextWindow: 128_000, maxOutput: 64_000, tools: true, reasoning: true }
		]
	},
	{
		id: 'groq',
		name: 'Groq',
		baseUrl: KNOWN_BASE_URLS.groq,
		apiFormat: 'openai',
		models: [{ id: 'llama-3.3-70b-versatile', priceIn: 0.59, priceOut: 0.79, contextWindow: 131_072, maxOutput: 32_768, tools: true }]
	},
	{
		id: 'ollama',
		name: 'Ollama (local)',
		baseUrl: 'http://localhost:11434/v1',
		apiFormat: 'openai',
		models: []
	}
];

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Normalize a model id for fuzzy matching ("vendor/Model-Free:beta" → "model"). */
function normalizeId(id: string): string {
	return id
		.toLowerCase()
		.split('/')
		.pop()!
		.replace(/:[\w-]+$/, '')
		.replace(/[-_](free|promo|preview|exp|latest)$/g, '');
}

export class ModelCatalog {
	private memory?: CatalogProvider[];
	private loading?: Promise<CatalogProvider[]>;

	constructor(private readonly context: vscode.ExtensionContext) {
		// Older versions cached the whole catalog in globalState — drop it.
		for (const key of LEGACY_KEYS) {
			if (context.globalState.get(key) !== undefined) {
				void context.globalState.update(key, undefined);
			}
		}
	}

	private get cacheUri(): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, CACHE_FILE);
	}

	static parse(raw: unknown): CatalogProvider[] {
		if (!raw || typeof raw !== 'object') {
			return [];
		}
		const out: CatalogProvider[] = [];
		for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
			const entry = (value ?? {}) as { name?: unknown; api?: unknown; npm?: unknown; models?: Record<string, unknown> };
			const models: CatalogModel[] = [];
			for (const [modelId, modelValue] of Object.entries(entry.models ?? {})) {
				const m = (modelValue ?? {}) as {
					name?: unknown;
	cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown; cache_write_1h?: unknown };
					limit?: { context?: unknown; output?: unknown };
					modalities?: { input?: unknown };
					attachment?: unknown;
					tool_call?: unknown;
					reasoning?: unknown;
				};
				const inputs = Array.isArray(m.modalities?.input) ? (m.modalities?.input as unknown[]) : [];
				models.push({
					id: modelId,
					name: typeof m.name === 'string' ? m.name : undefined,
					priceIn: typeof m.cost?.input === 'number' ? m.cost.input : undefined,
					priceOut: typeof m.cost?.output === 'number' ? m.cost.output : undefined,
					priceCacheRead: typeof m.cost?.cache_read === 'number' ? m.cost.cache_read : undefined,
					...(typeof m.cost?.cache_write === 'number' ? { priceCacheWrite: m.cost.cache_write } : {}),
					...(typeof m.cost?.cache_write_1h === 'number' ? { priceCacheWrite1h: m.cost.cache_write_1h } : {}),
					contextWindow: num(m.limit?.context),
					maxOutput: num(m.limit?.output),
					vision: inputs.includes('image') || undefined,
					tools: m.tool_call === true ? true : m.tool_call === false ? false : undefined,
					reasoning: m.reasoning === true || undefined
				});
			}
			const npm = typeof entry.npm === 'string' ? entry.npm : '';
			out.push({
				id,
				name: typeof entry.name === 'string' ? entry.name : id,
				baseUrl: typeof entry.api === 'string' ? entry.api : KNOWN_BASE_URLS[id],
				apiFormat: npm.includes('anthropic') ? 'anthropic' : 'openai',
				models
			});
		}
		return out;
	}

	private async readCache(): Promise<{ at: number; providers: CatalogProvider[] } | undefined> {
		try {
			const bytes = await vscode.workspace.fs.readFile(this.cacheUri);
			const parsed = JSON.parse(new TextDecoder().decode(bytes));
			return Array.isArray(parsed?.providers) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	private async load(force: boolean): Promise<CatalogProvider[]> {
		const cached = await this.readCache();
		if (!force && cached && Date.now() - cached.at < CATALOG_TTL) {
			return cached.providers;
		}
		try {
			const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const providers = ModelCatalog.parse(await response.json());
			if (!providers.length) {
				throw new Error('empty catalog');
			}
			await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
			await vscode.workspace.fs.writeFile(
				this.cacheUri,
				new TextEncoder().encode(JSON.stringify({ at: Date.now(), providers }))
			);
			return providers;
		} catch {
			// Offline or blocked: stale cache beats the tiny bundled list.
			return cached?.providers.length ? cached.providers : FALLBACK;
		}
	}

	async all(force = false): Promise<CatalogProvider[]> {
		if (this.memory && !force) {
			return this.memory;
		}
		this.loading ??= this.load(force).finally(() => (this.loading = undefined));
		this.memory = await this.loading;
		return this.memory;
	}

	async get(id: string): Promise<CatalogProvider | undefined> {
		return (await this.all()).find((p) => p.id === id);
	}

	/** Providers whose name/id matches the query; usable presets first. */
	async search(query: string): Promise<CatalogSummary[]> {
		const q = query.trim().toLowerCase();
		const all = await this.all();
		return all
			.filter((p) => !q || p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
			.sort((a, b) => Number(!!b.baseUrl) - Number(!!a.baseUrl) || b.models.length - a.models.length)
			.slice(0, 60)
			.map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, apiFormat: p.apiFormat, modelCount: p.models.length }));
	}

	/**
	 * Prefer a matching provider or endpoint/API format, then search the rest
	 * for exact and normalized IDs ("-free", "vendor/"…).
	 */
	async lookup(modelId: string, catalogHint?: string, endpoint?: { baseUrl?: string; apiFormat?: string }): Promise<CatalogModel | undefined> {
		const all = await this.all();
		const endpointUrl = endpoint?.baseUrl?.replace(/\/+$/, '').toLowerCase();
		const preferred = all.filter((p) => p.id === catalogHint || (!!endpointUrl && p.baseUrl?.replace(/\/+$/, '').toLowerCase() === endpointUrl && (!endpoint?.apiFormat || p.apiFormat === endpoint.apiFormat)));
		const wanted = normalizeId(modelId);
		for (const p of preferred) {
			const hit = p.models.find((m) => m.id === modelId) ?? (wanted ? p.models.find((m) => normalizeId(m.id) === wanted) : undefined);
			if (hit) return hit;
		}
		const ordered = endpoint?.apiFormat ? [...all.filter((p) => p.apiFormat === endpoint.apiFormat), ...all.filter((p) => p.apiFormat !== endpoint.apiFormat)] : all;
		for (const p of ordered) {
			const hit = p.models.find((m) => m.id === modelId);
			if (hit) {
				return hit;
			}
		}
		if (!wanted) {
			return undefined;
		}
		for (const p of ordered) {
			const hit = p.models.find((m) => normalizeId(m.id) === wanted);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}
}
