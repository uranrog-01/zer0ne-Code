import { createHash } from 'crypto';

type Budget = { until: number; next: number; queue: Promise<void> };
const budgets = new Map<string, Budget>();

export function hfRateLimitMessage(signedIn: boolean, seconds = 60): string {
	return `Hugging Face is rate-limiting requests. Try again in ${Math.max(1, Math.ceil(seconds))} seconds. ` + (signedIn
		? 'A token was sent. Wait for the account quota to reset before retrying.'
		: 'Connect a free Read token in Local models → Hugging Face for higher limits.');
}

export class HfRateLimitError extends Error {
	readonly status = 429;
	constructor(readonly retryAt: number, signedIn: boolean) {
		super(hfRateLimitMessage(signedIn, (retryAt - Date.now()) / 1000));
		this.name = 'HfRateLimitError';
	}
}

/** HF uses separate API, resolver and page quotas. Authentication changes the quota owner. */
function budgetFor(url: string, headers: Headers): Budget {
	const u = new URL(url);
	const bucket = u.pathname.includes('/resolve/') ? 'resolvers' : u.pathname.includes('/api/') ? 'api' : 'pages';
	const auth = createHash('sha256').update(headers.get('authorization') ?? '').digest('hex');
	const key = `${u.origin}|${bucket}|${auth}`;
	let b = budgets.get(key);
	if (!b) {
		if (budgets.size >= 64) {
			for (const [k, v] of budgets) if (v.until <= Date.now() && v.next <= Date.now()) budgets.delete(k);
		}
		b = { until: 0, next: 0, queue: Promise.resolve() }; budgets.set(key, b);
	}
	return b;
}

export function hfRetryDelay(headers: Headers, now = Date.now()): number {
	const raw = headers.get('retry-after');
	const retry = raw == null ? NaN : /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) * 1000 : Date.parse(raw) - now;
	const reset = /(?:^|;)\s*t\s*=\s*(\d+(?:\.\d+)?)/i.exec(headers.get('ratelimit') ?? '');
	const candidates = [retry, reset ? Number(reset[1]) * 1000 : NaN].filter(v => Number.isFinite(v) && v >= 0);
	return Math.max(1000, candidates.length ? Math.max(...candidates) : 60_000);
}

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new Error('Aborted')); };
		const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
	});
}

/** Space request starts; never hold a settings action open throughout a multi-minute cooldown. */
export async function hfFetch(url: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers), signedIn = headers.has('authorization');
	const b = budgetFor(url, headers);
	const start = b.queue.then(async () => {
		init.signal?.throwIfAborted();
		if (b.until > Date.now()) throw new HfRateLimitError(b.until, signedIn);
		if (b.next > Date.now()) await pause(b.next - Date.now(), init.signal);
		if (b.until > Date.now()) throw new HfRateLimitError(b.until, signedIn);
		b.next = Date.now() + 250;
	});
	b.queue = start.catch(() => undefined);
	await start;
	const res = await fetch(url, { ...init, headers });
	const exhausted = /(?:^|;)\s*r\s*=\s*0(?:\s*;|\s*$)/i.test(res.headers.get('ratelimit') ?? '');
	if (res.status === 429 || exhausted) b.until = Math.max(b.until, Date.now() + hfRetryDelay(res.headers));
	if (res.status === 429) {
		await res.body?.cancel().catch(() => undefined);
		throw new HfRateLimitError(b.until, signedIn);
	}
	return res;
}
