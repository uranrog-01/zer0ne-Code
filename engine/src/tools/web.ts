/**
 * Browser tools the agent calls on demand (no browser UI in the panel):
 *
 *  - webSearch: Exa's public MCP endpoint (keyless, as opencode uses it),
 *    falling back to DuckDuckGo's HTML results page.
 *  - webFetch:  GET a URL and return readable markdown (5 MB cap, 30 s
 *    timeout, browser-like headers — limits mirror opencode's webfetch).
 *
 * Pure Node — no vscode import — so it can be unit-tested directly.
 */

import * as dns from 'dns/promises';
import * as net from 'net';

const USER_AGENT =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 5 * 1024 * 1024;
const EXA_URL = 'https://mcp.exa.ai/mcp';

// ---------------------------------------------------------------- HTML → markdown

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === '#') {
			const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

function resolveHref(href: string, base: string): string {
	try {
		return new URL(decodeEntities(href), base).toString();
	} catch {
		return href;
	}
}

/**
 * Small, dependency-free HTML → markdown converter. It favors readability
 * for a model over fidelity: chrome (nav/header/footer/aside/forms) is
 * dropped, <main>/<article> is preferred when present.
 */
export function htmlToMarkdown(html: string, baseUrl: string): { title: string; markdown: string } {
	const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
	let s = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript|svg|canvas|iframe|template|form|select|button)\b[\s\S]*?<\/\1>/gi, '')
		.replace(/<(head)\b[\s\S]*?<\/head>/gi, '');
	const main = s.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? s.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
	if (main && main.replace(/<[^>]+>/g, '').trim().length > 200) {
		s = main;
	} else {
		s = s.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '');
	}

	// Preformatted blocks first, protected from whitespace collapsing.
	const blocks: string[] = [];
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
		const code = decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
		blocks.push('\n```\n' + code.replace(/\n+$/, '') + '\n```\n');
		return `\u0000${blocks.length - 1}\u0000`;
	});

	s = s
		.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${'#'.repeat(Number(level))} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`)
		.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
			const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
			if (!label || /^(javascript:|#)/i.test(href)) {
				return label;
			}
			return `[${label}](${resolveHref(href, baseUrl)})`;
		})
		.replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_m, alt: string) => `[image: ${alt}]`)
		.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
		.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '_$2_')
		.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<\/(li|ul|ol)>/gi, '\n')
		.replace(/<blockquote\b[^>]*>/gi, '\n> ')
		.replace(/<tr\b[^>]*>/gi, '\n| ')
		.replace(/<\/t[dh]>/gi, ' | ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/?(p|div|section|article|table|thead|tbody|dl|dt|dd|figure|figcaption|hr)\b[^>]*>/gi, '\n\n')
		.replace(/<[^>]+>/g, '');

	s = decodeEntities(s)
		.replace(/[ \t\f\v ]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/^([-|>]) *\n+/gm, '$1 ')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)])
		.trim();
	return { title, markdown: s };
}

// ---------------------------------------------------------------- provenance

/**
 * Prompt-injection blast radius: a page the agent fetched can contain
 * instructions that send it anywhere. With the provenance guard on,
 * web_fetch only opens URLs the user themselves shared (chat text,
 * attachments); search results and links found in fetched pages must be
 * quoted back to the user instead of fetched blind. Same rule Claude's web
 * agent applies ("URL not in provenance set").
 */
export function normalizeUrl(rawUrl: string): string | undefined {
	try {
		const u = new URL(rawUrl.trim().match(/^https?:\/\//i) ? rawUrl.trim() : 'https://' + rawUrl.trim());
		if (u.protocol !== 'http:' && u.protocol !== 'https:') {
			return undefined;
		}
		u.hash = '';
		return u.toString();
	} catch {
		return undefined;
	}
}

/** URLs written in a user message (the provenance set's source). */
export function extractUrls(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]},;]+/g)) {
		const url = normalizeUrl(m[0].replace(/[.:!]+$/, ''));
		if (url) {
			out.push(url);
		}
	}
	return out;
}

export function provenanceAllows(set: ReadonlySet<string>, rawUrl: string): boolean {
	const url = normalizeUrl(rawUrl);
	return !!url && set.has(url);
}

// ---------------------------------------------------------------- fetch

export interface FetchResult {
	url: string;
	title: string;
	contentType: string;
	text: string;
	truncated: boolean;
}

/** Loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
	const address = ip.replace(/^\[|\]$/g, '').toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
	if (mapped) return isPrivateAddress(mapped[1]);
	if (net.isIPv4(address)) {
		const [a, b] = address.split('.').map(Number);
		return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || (a === 198 && (b === 18 || b === 19));
	}
	if (net.isIPv6(address)) {
		const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
		if (hex) {
			const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
			return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
		}
		return address === '::' || address === '::1' || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || /^ff/.test(address);
	}
	return false;
}

/**
 * A fetched page can name any URL, so web_fetch reaches a local or private
 * address (dev servers, the router, cloud metadata) only on an origin the
 * user shared in the chat. Every redirect hop is checked the same way.
 */
async function checkTarget(url: URL, localOrigins: ReadonlySet<string>): Promise<void> {
	if (localOrigins.has(url.origin)) return;
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
	if (addresses.some(isPrivateAddress)) {
		throw new Error(`${url.origin} is a local or private address. web_fetch opens those only when the user shares the link in the chat.`);
	}
}

export async function webFetch(rawUrl: string, maxChars = 20_000, signal?: AbortSignal, shared: ReadonlySet<string> = new Set()): Promise<FetchResult> {
	let url: URL;
	try {
		url = new URL(rawUrl.trim().match(/^https?:\/\//i) ? rawUrl.trim() : 'https://' + rawUrl.trim());
	} catch {
		throw new Error(`Invalid URL: ${rawUrl}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Only http(s) URLs can be fetched.');
	}
	const localOrigins = new Set([...shared].flatMap((u) => { try { return [new URL(u).origin]; } catch { return []; } }));
	const timeout = AbortSignal.timeout(30_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const headers = {
		'User-Agent': USER_AGENT,
		Accept: 'text/markdown;q=1.0, text/html;q=0.9, text/plain;q=0.8, application/json;q=0.7, */*;q=0.1',
		'Accept-Language': 'en-US,en;q=0.9'
	};
	const get = async (agent: string): Promise<Response> => {
		let target = url;
		for (let hop = 0; ; hop++) {
			await checkTarget(target, localOrigins);
			const res = await fetch(target, { headers: { ...headers, 'User-Agent': agent }, signal: combined, redirect: 'manual' });
			const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
			if (!location) return res;
			if (hop >= 5) throw new Error(`Too many redirects from ${url}`);
			target = new URL(location, target);
			if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error(`Redirected to a non-http(s) URL: ${target.protocol}`);
		}
	};
	let response = await get(USER_AGENT);
	// Cloudflare-style bot walls sometimes accept an honest agent string.
	if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') {
		response = await get('zer0ne-coding');
	}
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
	}
	const length = Number(response.headers.get('content-length') ?? 0);
	if (length > MAX_BYTES) {
		throw new Error(`Response too large (${Math.round(length / 1024 / 1024)} MB, limit 5 MB).`);
	}
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_BYTES) {
		throw new Error('Response too large (limit 5 MB).');
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/i.test(contentType)) {
		throw new Error(`Cannot read binary content (${contentType}).`);
	}
	const raw = new TextDecoder().decode(buffer);
	const finalUrl = response.url || url.toString();
	let title = '';
	let text = raw;
	if (/html/i.test(contentType) || /^\s*<(!doctype html|html)/i.test(raw)) {
		({ title, markdown: text } = htmlToMarkdown(raw, finalUrl));
	}
	const truncated = text.length > maxChars;
	return { url: finalUrl, title, contentType, text: truncated ? text.slice(0, maxChars) : text, truncated };
}

// ---------------------------------------------------------------- search

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

async function exaSearch(query: string, count: number, signal: AbortSignal): Promise<string> {
	const response = await fetch(EXA_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'web_search_exa', arguments: { query, numResults: count, type: 'auto', livecrawl: 'fallback', contextMaxCharacters: 6000 } }
		}),
		signal
	});
	if (!response.ok) {
		throw new Error(`Exa search failed (HTTP ${response.status}).`);
	}
	const body = await response.text();
	const payloads = body.trim().startsWith('{')
		? [body]
		: body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
	for (const payload of payloads) {
		try {
			const json = JSON.parse(payload);
			if (json.error) {
				throw new Error(json.error.message ?? 'Exa search error');
			}
			const text = json.result?.content?.find((c: { type?: string; text?: string }) => c.type === 'text' && c.text)?.text;
			if (text) {
				return text;
			}
		} catch (error) {
			if (error instanceof SyntaxError) {
				continue;
			}
			throw error;
		}
	}
	throw new Error('Exa search returned no results.');
}

export function parseDuckDuckGo(html: string): SearchHit[] {
	const hits: SearchHit[] = [];
	const blocks = html.split(/<div[^>]+class="[^"]*result(?:\s|")/i).slice(1);
	for (const block of blocks) {
		const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
			?? block.match(/<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
		if (!link) {
			continue;
		}
		let href = decodeEntities(link[1]);
		const redirect = href.match(/[?&]uddg=([^&]+)/);
		if (redirect) {
			href = decodeURIComponent(redirect[1]);
		} else if (href.startsWith('//')) {
			href = 'https:' + href;
		}
		if (!/^https?:\/\//.test(href) || /duckduckgo\.com\/y\.js/.test(href)) {
			continue; // ads
		}
		const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i)?.[1] ?? '';
		hits.push({
			title: decodeEntities(link[2].replace(/<[^>]+>/g, '')).trim(),
			url: href,
			snippet: decodeEntities(snippet.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
		});
	}
	return hits;
}

async function duckSearch(query: string, count: number, signal: AbortSignal): Promise<string> {
	const response = await fetch('https://html.duckduckgo.com/html/', {
		method: 'POST',
		headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ q: query }).toString(),
		signal
	});
	if (!response.ok) {
		throw new Error(`DuckDuckGo search failed (HTTP ${response.status}).`);
	}
	const hits = parseDuckDuckGo(await response.text()).slice(0, count);
	if (!hits.length) {
		throw new Error('DuckDuckGo returned no results (possibly rate limited).');
	}
	return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n\n');
}

/** Search the web; the preferred engine falls back to the other one. */
export async function webSearch(
	query: string,
	options: { count?: number; engine?: 'exa' | 'duckduckgo'; signal?: AbortSignal } = {}
): Promise<{ engine: string; text: string }> {
	const count = Math.min(10, Math.max(1, options.count ?? 6));
	const timeout = AbortSignal.timeout(25_000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const engines = options.engine === 'duckduckgo' ? (['duckduckgo', 'exa'] as const) : (['exa', 'duckduckgo'] as const);
	const errors: string[] = [];
	for (const engine of engines) {
		try {
			const text = engine === 'exa' ? await exaSearch(query, count, signal) : await duckSearch(query, count, signal);
			return { engine, text };
		} catch (error) {
			if (options.signal?.aborted) {
				throw error;
			}
			errors.push(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Web search failed — ${errors.join('; ')}`);
}
