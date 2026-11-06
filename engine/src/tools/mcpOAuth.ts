import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { readJsonBody } from './mcpProtocol';

/**
 * OAuth for remote MCP servers (MCP spec 2025-06-18 "Authorization"):
 *
 *  1. The server answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`
 *  2. Protected Resource Metadata (RFC 9728) names the authorization server
 *  3. Authorization Server Metadata (RFC 8414, OpenID fallback) gives endpoints
 *  4. Dynamic Client Registration (RFC 7591) when the client has no id yet
 *  5. Authorization Code + PKCE (S256) with `state` and `resource` (RFC 8707),
 *     redirected to a one-shot loopback listener
 *  6. Tokens live in the OS keychain; refresh_token renews them silently
 */

export interface McpTokens {
	accessToken: string;
	refreshToken?: string;
	/** ms epoch */
	expiresAt?: number;
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	resource: string;
	scope?: string;
}

export interface AuthServerMeta {
	issuer?: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
	code_challenge_methods_supported?: string[];
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `Bearer resource_metadata="…", scope="…"` → fields. */
export function parseWwwAuthenticate(header: string | null): { resourceMetadata?: string; scope?: string; error?: string } {
	const out: { resourceMetadata?: string; scope?: string; error?: string } = {};
	if (!header) {
		return out;
	}
	for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) {
		if (m[1] === 'resource_metadata') {
			out.resourceMetadata = m[2];
		} else if (m[1] === 'scope') {
			out.scope = m[2];
		} else if (m[1] === 'error') {
			out.error = m[2];
		}
	}
	return out;
}

/** Canonical resource URI for the MCP server (RFC 8707): no fragment, no trailing slash. */
export function canonicalResource(url: string): string {
	const u = new URL(url);
	u.hash = '';
	return u.toString().replace(/\/$/, '');
}

export function secureOAuthUrl(value: string): URL {
	const url = new URL(value);
	if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
		throw new Error('OAuth endpoints must use HTTPS (HTTP is allowed only on loopback).');
	}
	return url;
}

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
	return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
}

async function getJson(url: string, signal?: AbortSignal): Promise<any> {
	secureOAuthUrl(url);
	const res = await fetch(url, { redirect: 'error', headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: deadline(15_000, signal) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${url}`);
	}
	return readJsonBody(res);
}

/** Find the authorization server for an MCP server URL. */
export async function discover(serverUrl: string, wwwAuthenticate: string | null, signal?: AbortSignal): Promise<{ meta: AuthServerMeta; scope?: string }> {
	secureOAuthUrl(serverUrl);
	const hint = parseWwwAuthenticate(wwwAuthenticate);
	const origin = new URL(serverUrl).origin;
	const path = new URL(serverUrl).pathname.replace(/\/$/, '');
	let issuer: string | undefined;
	let scope = hint.scope;
	// RFC 9728: the hinted document, then the path-aware and root well-known URLs.
	for (const url of [hint.resourceMetadata, `${origin}/.well-known/oauth-protected-resource${path}`, `${origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[]) {
		try {
			const prm = await getJson(url, signal);
			if (typeof prm.resource !== 'string') throw new MetadataError('OAuth resource metadata has no resource identifier.');
			const resource = new URL(prm.resource), target = new URL(serverUrl);
			if (resource.origin !== target.origin || !(target.pathname + '/').startsWith(resource.pathname.replace(/\/$/, '') + '/')) throw new MetadataError('OAuth protected resource does not match this MCP server.');
			secureOAuthUrl(prm.resource);
			issuer = prm.authorization_servers?.[0];
			scope ??= Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : undefined;
			if (issuer) {
				break;
			}
		} catch (e) {
			signal?.throwIfAborted();
			if (e instanceof MetadataError) throw e;
			/* try the next one */
		}
	}
	// Older servers: the MCP origin is its own authorization server.
	issuer ??= origin;
	const iss = secureOAuthUrl(issuer);
	const ipath = iss.pathname.replace(/\/$/, '');
	const candidates = ipath
		? [`${iss.origin}/.well-known/oauth-authorization-server${ipath}`, `${iss.origin}/.well-known/openid-configuration${ipath}`, `${iss.origin}${ipath}/.well-known/openid-configuration`]
		: [`${iss.origin}/.well-known/oauth-authorization-server`, `${iss.origin}/.well-known/openid-configuration`];
	for (const url of candidates) {
		try {
			const meta = (await getJson(url, signal)) as AuthServerMeta;
			if (meta.authorization_endpoint && meta.token_endpoint) {
				if (!meta.issuer || canonicalResource(meta.issuer) !== canonicalResource(issuer)) throw new MetadataError('OAuth authorization-server issuer does not match its metadata.');
				try {
					secureOAuthUrl(meta.authorization_endpoint); secureOAuthUrl(meta.token_endpoint);
					if (meta.registration_endpoint) secureOAuthUrl(meta.registration_endpoint);
				} catch { throw new MetadataError('OAuth metadata contains an insecure endpoint.'); }
				return { meta, scope };
			}
		} catch (e) {
			signal?.throwIfAborted();
			if (e instanceof MetadataError) throw e;
			/* next */
		}
	}
	// Last resort (2025-03-26 servers): default endpoint paths on the origin.
	return { meta: { authorization_endpoint: `${iss.origin}/authorize`, token_endpoint: `${iss.origin}/token`, registration_endpoint: `${iss.origin}/register` }, scope };
}

class MetadataError extends Error {}

export class OAuthTokenError extends Error {
	constructor(readonly code: string, readonly status: number) { super(`OAuth token request failed (HTTP ${status}, ${code}).`); }
}

async function register(meta: AuthServerMeta, redirectUri: string, signal?: AbortSignal): Promise<{ clientId: string; clientSecret?: string }> {
	if (!meta.registration_endpoint) {
		throw new Error('This MCP server needs a pre-registered OAuth client (it does not support dynamic registration). Add an Authorization header instead.');
	}
	secureOAuthUrl(meta.registration_endpoint);
	const res = await fetch(meta.registration_endpoint, {
		redirect: 'error',
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ client_name: 'zer0ne Code', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
		signal: deadline(20_000, signal)
	});
	if (!res.ok) {
		await res.body?.cancel();
		throw new Error(`Client registration failed (HTTP ${res.status}).`);
	}
	const j = (await readJsonBody(res)) as { client_id?: string; client_secret?: string };
	if (typeof j.client_id !== 'string' || !j.client_id) {
		throw new Error('Client registration returned no client_id.');
	}
	return { clientId: j.client_id, clientSecret: j.client_secret };
}

async function tokenRequest(endpoint: string, form: Record<string, string | undefined>, clientSecret?: string, signal?: AbortSignal): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
	secureOAuthUrl(endpoint);
	const body = new URLSearchParams();
	for (const [k, v] of Object.entries(form)) {
		if (v !== undefined) {
			body.set(k, v);
		}
	}
	if (clientSecret) {
		body.set('client_secret', clientSecret);
	}
	const res = await fetch(endpoint, { redirect: 'error', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: deadline(20_000, signal) });
	const j = await readJsonBody(res);
	if (!res.ok) {
		throw new OAuthTokenError(['invalid_grant', 'invalid_client', 'invalid_token'].includes(j.error) ? j.error : 'token_error', res.status);
	}
	if (typeof j.access_token !== 'string' || !j.access_token) {
		throw new Error('The authorization server returned no access_token.');
	}
	return j;
}

/** One-shot loopback listener on a random port, bound to an unguessable path. */
function loopback(): Promise<{ redirectUri: string; wait: (state: string, signal?: AbortSignal) => Promise<string>; close: () => void }> {
	return new Promise((resolve, reject) => {
		const nonce = b64url(randomBytes(12));
		let deliver: (q: URLSearchParams) => void = () => undefined;
		let cancelWait: () => void = () => undefined;
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (url.pathname !== `/callback/${nonce}`) {
				res.writeHead(404).end();
				return;
			}
			const ok = url.searchParams.has('code');
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(`<html><body style="font-family:system-ui;background:#161616;color:#e5e5e5;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? 'Finishing sign-in…' : 'Sign-in was not completed'}</h2><p style="opacity:.7">You can close this tab and return to zer0ne Code.</p></div></body></html>`);
			deliver(url.searchParams);
		});
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				redirectUri: `http://127.0.0.1:${port}/callback/${nonce}`,
				close: () => { cancelWait(); server.close(); },
				wait: (state, signal) =>
					new Promise<string>((ok, fail) => {
						let settled = false;
						const finish = (error?: Error, code?: string) => {
							if (settled) return; settled = true;
							clearTimeout(timer); signal?.removeEventListener('abort', abort);
							error ? fail(error) : ok(code!);
						};
						const abort = () => finish(new Error('Sign-in cancelled.'));
						const timer = setTimeout(() => finish(new Error('Sign-in timed out after 5 minutes.')), 5 * 60_000);
						cancelWait = abort;
						signal?.addEventListener('abort', abort, { once: true });
						if (signal?.aborted) abort();
						deliver = (q) => {
							if (q.get('state') !== state) {
								return;
							}
							const code = q.get('code');
							code ? finish(undefined, code) : finish(new Error('Sign-in was cancelled or rejected.'));
						};
					})
			});
		});
	});
}

/** Full interactive sign-in. `openExternal` opens the browser. */
export async function signIn(serverUrl: string, wwwAuthenticate: string | null, openExternal: (url: string) => Thenable<boolean> | Promise<boolean>, previous?: McpTokens, signal?: AbortSignal): Promise<McpTokens> {
	signal?.throwIfAborted();
	const { meta, scope } = await discover(serverUrl, wwwAuthenticate, signal);
	if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes('S256')) {
		throw new Error('The authorization server does not support PKCE S256, which MCP requires.');
	}
	const lb = await loopback();
	try {
		// Loopback redirect URIs change port each time, so register per sign-in (RFC 8252 §7.3).
		const client = await register(meta, lb.redirectUri, signal).catch((e) => {
			signal?.throwIfAborted();
			if (previous?.clientId && previous.tokenEndpoint === meta.token_endpoint) {
				return { clientId: previous.clientId, clientSecret: previous.clientSecret };
			}
			throw e;
		});
		const verifier = b64url(randomBytes(32));
		const state = b64url(randomBytes(16));
		const resource = canonicalResource(serverUrl);
		const auth = new URL(meta.authorization_endpoint);
		auth.searchParams.set('response_type', 'code');
		auth.searchParams.set('client_id', client.clientId);
		auth.searchParams.set('redirect_uri', lb.redirectUri);
		auth.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
		auth.searchParams.set('code_challenge_method', 'S256');
		auth.searchParams.set('state', state);
		auth.searchParams.set('resource', resource);
		if (scope) {
			auth.searchParams.set('scope', scope);
		}
		const waiting = lb.wait(state, signal);
		// Browser failures and cancellation can settle before this promise is awaited.
		void waiting.catch(() => undefined);
		if (!(await openExternal(auth.toString()))) throw new Error('Could not open the browser for MCP sign-in.');
		const code = await waiting;
		const tok = await tokenRequest(meta.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: lb.redirectUri, client_id: client.clientId, code_verifier: verifier, resource }, client.clientSecret, signal);
		return {
			accessToken: tok.access_token,
			refreshToken: tok.refresh_token,
			expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined,
			tokenEndpoint: meta.token_endpoint,
			clientId: client.clientId,
			clientSecret: client.clientSecret,
			resource,
			scope: tok.scope ?? scope
		};
	} finally {
		lb.close();
	}
}

/** Silent renewal with the refresh token. */
export async function refresh(t: McpTokens, signal?: AbortSignal): Promise<McpTokens> {
	if (!t.refreshToken) {
		throw new Error('No refresh token.');
	}
	const tok = await tokenRequest(t.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: t.clientId, resource: t.resource }, t.clientSecret, signal);
	return { ...t, accessToken: tok.access_token, refreshToken: tok.refresh_token ?? t.refreshToken, expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined, scope: tok.scope ?? t.scope };
}

/** Expired, or expiring within a minute. */
export const isExpired = (t: McpTokens) => !!t.expiresAt && t.expiresAt - 60_000 < Date.now();
