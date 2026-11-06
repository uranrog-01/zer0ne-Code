/**
 * The egress table: every non-traffic host zer0ne fetches, each with its
 * family and a plain-language purpose, and the decision these give.
 *
 * The setting `disableNonessentialNetwork` (Settings → Safety) is the only
 * switch; it covers the `catalog` and `feeds` families — background model
 * catalogs, deal feeds, provider status probes and announcement checks.
 * Everything essential to the session is *not* covered by it, and the table
 * is honest about that:
 *
 * - `model` — the provider request itself and everything unknown to this
 *   table (any baseUrl a user types) is allowed: unknown hosts are treated as
 *   model traffic so a missing table entry can never break a working provider.
 * - `bridge` — services the user turned on themselves (search engine,
 *   Telegram/cloud bridges, marketplace and skill installs from their own
 *   repos). Blockable by the user unchecking the feature, not by this table.
 * - `local` — loopback and private-network addresses, always allowed.
 *
 * First entry whose `match` is a substring of the URL wins, so more specific
 * patterns (host+path) go before plain host entries.
 */

export type EgressFamily = 'model' | 'bridge' | 'catalog' | 'feeds' | 'local';

export interface EgressEntry {
	/** Lowercase substring the whole URL must contain (host, optionally with a path prefix). */
	match: string;
	family: EgressFamily;
	purpose: string;
}

export const EGRESS_TABLE: readonly EgressEntry[] = [
	// --- catalog (nonessential; toggle-gated) ---------------------------------
	{ match: 'models.dev/api.json', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'openrouter.ai/api/v1/models', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'openrouter.ai/api/v3/models', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'ai-gateway.vercel.sh/v1/models', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'api.kilo.ai/api/openrouter/models', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'api.orcarouter.ai', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'router.requesty.ai', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'zenmux.ai', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'api.llmgateway.io', family: 'catalog', purpose: 'Model catalog' },
	{ match: 'artificialanalysis.ai/api', family: 'catalog', purpose: 'Intelligence dataset' },
	{ match: 'cdn.jsdelivr.net/gh/diegosouzapw/omniroute', family: 'catalog', purpose: 'Free-tier catalog' },
	{ match: 'raw.githubusercontent.com/mnfst/', family: 'catalog', purpose: 'Free-tier catalog' },
	{ match: 'raw.githubusercontent.com/nejib1/free-llm', family: 'catalog', purpose: 'Free-tier catalog' },
	{ match: 'raw.githubusercontent.com/12britz/awesome-free-models', family: 'catalog', purpose: 'Free-tier catalog' },
	{ match: 'raw.githubusercontent.com/codertesla/', family: 'catalog', purpose: 'Deals list' },
	// --- feeds (nonessential; toggle-gated) -----------------------------------
	{ match: 'openai.com/news/rss.xml', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'huggingface.co/blog/feed.xml', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'blog.google', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'together.ai/blog/rss.xml', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'ollama.com/blog/rss.xml', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'blog.cloudflare.com', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'blog.kilo.ai', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'simonwillison.net', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'news.smol.ai', family: 'feeds', purpose: 'Deal announcements' },
	{ match: 'hn.algolia.com', family: 'feeds', purpose: 'Deal announcements (Hacker News)' },
	{ match: 'api.bsky.app', family: 'feeds', purpose: 'Deal announcements (Bluesky)' },
	{ match: 'status.openai.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.claude.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'groqstatus.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.deepseek.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.mistral.ai', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.cerebras.ai', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.together.ai', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.fireworks.ai', family: 'feeds', purpose: 'Provider status' },
	{ match: 'status.deepinfra.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'githubstatus.com', family: 'feeds', purpose: 'Provider status' },
	{ match: 'cdn.jsdelivr.net/gh/reyamira/models', family: 'catalog', purpose: 'Benchmark scores' },
	// --- bridge (allowed; the user turned these on) ----------------------------
	{ match: 'api.github.com', family: 'bridge', purpose: 'Your repos: marketplace, skills, cloud tasks' },
	{ match: 'raw.githubusercontent.com', family: 'bridge', purpose: 'Your repos: marketplace and skills' },
	{ match: 'codeload.github.com', family: 'bridge', purpose: 'Installing a plugin you picked' },
	{ match: 'api.telegram.org', family: 'bridge', purpose: 'Your Telegram bridge' },
	{ match: 'duckduckgo.com', family: 'bridge', purpose: 'Your configured search engine' },
	{ match: 'exa.ai', family: 'bridge', purpose: 'Your configured search engine' },
	{ match: 'devin.ai', family: 'bridge', purpose: 'Your configured search engine' }
];

export interface EgressSettings {
	disableNonessentialNetwork?: boolean;
}

export interface EgressDecision {
	allowed: boolean;
	family: EgressFamily;
	purpose: string;
}

function isLocal(host: string): boolean {
	return (
		/^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)/.test(host) ||
		/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
		host.endsWith('.local')
	);
}

/** What running `url` does, given the settings (pure; tested). */
export function egressDecision(url: string, settings?: EgressSettings): EgressDecision {
	let host = '';
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		/* not a full URL — leave it to the fetch */
	}
	if (host && isLocal(host)) return { allowed: true, family: 'local', purpose: 'Local services' };
	const entry = url ? EGRESS_TABLE.find((e) => url.toLowerCase().includes(e.match)) : undefined;
	const family: EgressFamily = entry?.family ?? 'model';
	// Nonessential families honour the only toggle; everything else passes.
	const nonessential = family === 'catalog' || family === 'feeds';
	const allowed = !nonessential || settings?.disableNonessentialNetwork !== true;
	return { allowed, family, purpose: entry?.purpose ?? (family === 'bridge' ? 'Your own configured service' : 'Provider request') };
}

/** The error message a gated fetch site throws when the toggle said no. */
export function egressBlockError(url: string, decision: EgressDecision): string {
	let host = '';
	try {
		host = new URL(url).host;
	} catch {
		/* keep the plain URL */
	}
	return `Only essential network — ${decision.purpose} (${host || url}) was skipped. Enable it in Settings → Safety.`;
}

/** A `gate(url)` callback for fetch sites: throws when the toggle says no. */
export function egressGate(settings?: EgressSettings): (url: string) => void {
	return (url: string) => {
		const d = egressDecision(url, settings);
		if (!d.allowed) throw new Error(egressBlockError(url, d));
	};
}
