import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import type { McpAuthStore } from './mcp';
import { isExpired, OAuthTokenError, refresh, type McpTokens } from './mcpOAuth';

const same = (a?: McpTokens, b?: McpTokens) => !!a && !!b && a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;

/** Credentials are shared by project engines: serialize the exchange, not just the store's writes. */
export async function withCredentialLock<T>(resource: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
	const hash = createHash('sha256').update(os.homedir() + '\0' + resource).digest('hex');
	const lock = path.join(os.tmpdir(), `zer0ne-mcp-refresh-${hash}.lock`), nonce = randomBytes(16).toString('hex');
	let fd: number | undefined;
	const until = Date.now() + 45_000;
	while (fd === undefined) {
		signal.throwIfAborted();
		try {
			fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }));
		} catch (e) {
			if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); throw e; }
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
			try {
				const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
				if (Number.isInteger(owner.pid) && owner.pid > 0) {
					try { process.kill(owner.pid, 0); } catch (dead) { if ((dead as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
				}
			} catch { /* A newly created lock may not yet contain its owner. */ }
			if (Date.now() >= until) throw new Error('Timed out waiting for another MCP token refresh.');
			await delay(40, undefined, { signal });
		}
	}
	try {
		signal.throwIfAborted();
		return await work();
	} finally {
		fs.closeSync(fd);
		try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).nonce === nonce) fs.unlinkSync(lock); } catch { /* Already removed. */ }
	}
}

export async function storedBearer(auth: McpAuthStore, resource: string, force: boolean, signal: AbortSignal): Promise<string | undefined> {
	signal.throwIfAborted();
	const observed = await auth.get(resource);
	if (!observed) return undefined;
	if (!force && !isExpired(observed)) return observed.accessToken;
	if (!observed.refreshToken) return undefined;
	return withCredentialLock(resource, signal, async () => {
		const current = await auth.get(resource);
		if (!current) return undefined;
		if (!same(current, observed)) return !isExpired(current) ? current.accessToken : undefined;
		try {
			const next = await refresh(current, signal);
			signal.throwIfAborted();
			// Sign-out and a newer sign-in must never be overwritten by a late exchange.
			if (!same(await auth.get(resource), current)) return undefined;
			await auth.set(resource, next);
			return next.accessToken;
		} catch (e) {
			if (e instanceof OAuthTokenError && ['invalid_grant', 'invalid_client', 'invalid_token'].includes(e.code)) {
				if (same(await auth.get(resource), current)) await auth.set(resource, undefined);
				return undefined;
			}
			throw e;
		}
	});
}
