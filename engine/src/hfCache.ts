import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Offline mode for Settings → Local models → Discover: every Hugging Face
 * answer (search, file list, model card) is kept on disk; when the network is
 * gone the last copy is served and marked offline, so browsing what you looked
 * at before — and everything already downloaded — keeps working. No vscode.
 */

const OFFLINE = /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|getaddrinfo|network ?error|socket hang up|UND_ERR_CONNECT|Connect Timeout|timed? ?out|aborted due to timeout/i;

/** The request never reached the server (pure; tested). */
export function isOfflineError(e: unknown): boolean {
	const err = e as { message?: string; cause?: { code?: string; message?: string } };
	return OFFLINE.test(`${err?.message ?? e} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`);
}

const MAX_FILES = 400;
const pending = new Map<string, Promise<any>>();

export async function hfCached<T>(dir: string, key: string, fetcher: () => Promise<T>, maxAgeMs = 0, allowStaleServiceResponse = false): Promise<{ value: T; offline?: true; cachedAt?: number }> {
	const requestKey = JSON.stringify([path.resolve(dir), key, maxAgeMs, allowStaleServiceResponse]);
	const previous = pending.get(requestKey);
	if (previous) return previous;
	const request = readOrFetch(dir, key, fetcher, maxAgeMs, allowStaleServiceResponse);
	pending.set(requestKey, request);
	try { return await request; } finally { if (pending.get(requestKey) === request) pending.delete(requestKey); }
}

async function readOrFetch<T>(dir: string, key: string, fetcher: () => Promise<T>, maxAgeMs: number, allowStaleServiceResponse: boolean): Promise<{ value: T; offline?: true; cachedAt?: number }> {
	const file = path.join(dir, crypto.createHash('sha1').update(key).digest('hex').slice(0, 20) + '.json');
	if (maxAgeMs > 0) {
		try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.key === key && Date.now() - saved.at < maxAgeMs) return { value: saved.value, cachedAt: saved.at }; } catch { /* Cache miss. */ }
	}
	try {
		const value = await fetcher();
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, JSON.stringify({ at: Date.now(), key, value }));
			prune(dir);
		} catch {
			/* a full disk must not break browsing */
		}
		return { value };
	} catch (e) {
		const offline = isOfflineError(e);
		if (!offline && !(allowStaleServiceResponse && ((e as { status?: number })?.status === 429 || /rate.limit|HTTP (429|50[0-4])/i.test(String(e))))) throw e;
		try {
			const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; value: T };
			return { value: saved.value, offline: true, cachedAt: saved.at };
		} catch {
			if (!offline) throw e;
			throw new Error('You are offline, and this was not looked at while online yet. Models you already downloaded still run — see My models.');
		}
	}
}

/** Keep the cache bounded: the oldest answers go first. */
function prune(dir: string): void {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
	if (files.length <= MAX_FILES) return;
	files
		.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
		.sort((a, b) => a.t - b.t)
		.slice(0, files.length - MAX_FILES)
		.forEach(({ f }) => fs.rmSync(path.join(dir, f), { force: true }));
}
