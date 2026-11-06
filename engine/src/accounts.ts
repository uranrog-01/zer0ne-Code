import * as http from 'http';
import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from 'crypto';
import { advertisedReasoning, type ReasoningControl } from './reasoning';

/**
 * ChatGPT OSS application OAuth uses a user-issued client registration and
 * validated OIDC identity. Other providers' existing credentials retain their
 * refresh adapters, but new connections use their official agent or plan key
 * until zer0ne has a documented application authorization route.
 * Credential records, including retained ID tokens, belong in the OS keychain.
 */

export type AccountKind = 'chatgpt' | 'xai' | 'kimi' | 'minimax';

export interface AccountSpec {
	id: AccountKind;
	name: string;
	/** What the subscription is called on the vendor's side. */
	plans: string;
	baseUrl: string;
	apiFormat: 'codex' | 'responses' | 'openai' | 'anthropic';
	/** Browser (PKCE + localhost callback) or device code (a code to type on the vendor's page). */
	flow: 'browser' | 'device';
	/** Where plans are managed / bought. */
	manageUrl: string;
	/** Models offered when the account's own list cannot be read. */
	models: Array<{ id: string; name?: string; contextWindow?: number; maxOutput?: number; vision?: boolean; reasoning?: boolean; reasoningControl?: ReasoningControl }>;
}

export const ACCOUNTS: Record<AccountKind, AccountSpec> = {
	chatgpt: {
		id: 'chatgpt',
		name: 'ChatGPT',
		plans: 'Plus, Pro, Business, Edu or Enterprise',
		baseUrl: 'https://api.openai.com/v1',
		apiFormat: 'responses',
		flow: 'browser',
		manageUrl: 'https://chatgpt.com/#pricing',
		models: [
			{ id: 'gpt-6-sol', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-6-luna', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-6-astra', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-5.6-sol', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-5.6-terra', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-5.6-luna', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-5.5', contextWindow: 272_000, maxOutput: 128_000, vision: true, reasoning: true },
			{ id: 'gpt-5.3-codex-spark', contextWindow: 128_000, maxOutput: 128_000, reasoning: true }
		]
	},
	xai: {
		id: 'xai',
		name: 'SuperGrok / X Premium',
		plans: 'SuperGrok or X Premium',
		baseUrl: 'https://api.x.ai/v1',
		apiFormat: 'openai',
		flow: 'device',
		manageUrl: 'https://grok.com/plans',
		models: [
			{ id: 'grok-4.7', contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true },
			{ id: 'grok-4.6', contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true },
			{ id: 'grok-4.5', contextWindow: 500_000, maxOutput: 500_000, vision: true, reasoning: true },
			{ id: 'grok-4.3', contextWindow: 1_000_000, maxOutput: 30_000, vision: true, reasoning: true }
		]
	},
	kimi: {
		id: 'kimi',
		name: 'Kimi Code',
		plans: 'Kimi Code (Moderato, Allegretto, Allegro, Vivace)',
		baseUrl: 'https://api.kimi.com/coding',
		apiFormat: 'anthropic',
		flow: 'device',
		manageUrl: 'https://www.kimi.com/code',
		models: [
			{ id: 'k3', contextWindow: 1_048_576, maxOutput: 131_072, vision: true, reasoning: true },
			{ id: 'k3-256k', contextWindow: 262_144, maxOutput: 131_072, vision: true, reasoning: true },
			{ id: 'kimi-for-coding', contextWindow: 1_048_576, maxOutput: 32_768, vision: true, reasoning: true },
			{ id: 'kimi-for-coding-highspeed', contextWindow: 262_144, maxOutput: 32_768, vision: true, reasoning: true }
		]
	},
	minimax: {
		id: 'minimax',
		name: 'MiniMax Coding Plan',
		plans: 'MiniMax Coding Plan (Starter, Plus, Max)',
		baseUrl: 'https://api.minimax.io/anthropic',
		apiFormat: 'anthropic',
		flow: 'device',
		manageUrl: 'https://platform.minimax.io/subscribe/coding-plan',
		models: [
			{ id: 'MiniMax-M3', contextWindow: 1_000_000, maxOutput: 131_072, reasoning: true },
			{ id: 'MiniMax-M2.7', contextWindow: 204_800, maxOutput: 131_072, reasoning: true },
			{ id: 'MiniMax-M2.7-highspeed', contextWindow: 204_800, maxOutput: 131_072, reasoning: true }
		]
	}
};

export interface AccountCredential {
	kind: 'account';
	account: AccountKind;
	access: string;
	refresh: string;
	/** ms epoch; refreshed a minute before. */
	expires: number;
	email?: string;
	plan?: string;
	/** ChatGPT workspace id (chatgpt-account-id header). */
	accountId?: string;
	/** Issued OSS ChatGPT registration; absent on older Codex-backend credentials. */
	clientId?: string;
	hostId?: string;
	subject?: string;
	/**
	 * False when the subject was carried over from an earlier sign-in because the renewal
	 * response carried no ID token to verify it against.
	 */
	subjectVerified?: boolean;
	idToken?: string;
	scopes?: string[];
}

const PREFIX = 'zer0ne-account:';

export function isAccountSecret(secret: string | undefined): boolean {
	return typeof secret === 'string' && secret.startsWith(PREFIX);
}
export function serializeCredential(c: AccountCredential): string {
	return PREFIX + JSON.stringify(c);
}
export function parseCredential(secret: string | undefined): AccountCredential | undefined {
	if (!isAccountSecret(secret)) return undefined;
	try {
		const c = JSON.parse(secret!.slice(PREFIX.length)) as AccountCredential;
		return c && c.kind === 'account' && typeof c.access === 'string' && !!c.access.trim() && typeof c.refresh === 'string' && Number.isFinite(c.expires) && Object.hasOwn(ACCOUNTS, c.account) ? c : undefined;
	} catch {
		return undefined;
	}
}

/** "key1, key2" / one per line → the keys of a pool (account sign-ins are never split). */
export function splitKeys(raw: string | undefined): string[] {
	if (!raw || parseCredential(raw)) return raw ? [raw] : [];
	return raw.split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
}

/** What the UI may show about a signed-in account (never the tokens). */
export function describeCredential(c: AccountCredential): { account: AccountKind; email?: string; plan?: string; expires: number; subjectVerified?: boolean } {
	return { account: c.account, email: c.email, plan: c.plan, expires: c.expires, subjectVerified: c.subjectVerified };
}

export function decodeJwt(token: string): Record<string, any> | undefined {
	const part = token.split('.')[1];
	if (!part) return undefined;
	try {
		return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	} catch {
		return undefined;
	}
}

/** ChatGPT workspace id from the access token (also what the Codex backend expects in chatgpt-account-id). */
export function chatgptAccountId(accessToken: string): string | undefined {
	const id = decodeJwt(accessToken)?.['https://api.openai.com/auth']?.chatgpt_account_id;
	return typeof id === 'string' && id ? id : undefined;
}

// ---------------------------------------------------------------- sign-in events

export type SignInEvent =
	| { stage: 'browser'; url: string }
	| { stage: 'device'; code: string; url: string; expiresIn: number }
	| { stage: 'waiting'; text: string }
	| { stage: 'exchanging' };

export interface SignInUi {
	open(url: string): unknown;
	onEvent(e: SignInEvent): void;
	signal: AbortSignal;
	/** 'device' forces the device-code flow (headless, remote, port 1455 busy). */
	method?: 'browser' | 'device';
	/** Opaque host identifier persisted once per installation, before opening the browser. */
	hostId?: string;
	previous?: AccountCredential;
}

// ---------------------------------------------------------------- helpers

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error('Sign-in cancelled.'));
		const onAbort = () => { clearTimeout(t); reject(new Error('Sign-in cancelled.')); };
		const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

async function postForm(url: string, fields: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: any }> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(fields),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
	});
	let body: any = {};
	try {
		body = await res.json();
	} catch {
		/* not JSON */
	}
	return { ok: res.ok, status: res.status, body };
}




// ---------------------------------------------------------------- the callback page

/**
 * The page the browser shows after the vendor redirects back — a small,
 * self-contained, professional confirmation (no external assets).
 */
export function callbackPage(ok: boolean, title: string, detail: string): string {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
	const icon = ok
		? '<path d="M8 12.5l2.6 2.6L16.5 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
		: '<path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>';
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · zer0ne</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#0f1115;--muted:#5d6470;--line:#e6e8ec;--ok:#16a34a;--bad:#dc2626;--accent:#f7931e}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e11;--card:#15171b;--fg:#eceef2;--muted:#9aa1ad;--line:#262a31}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;padding:24px;background:radial-gradient(1200px 600px at 50% -10%,color-mix(in srgb,var(--accent) 12%,transparent),transparent),var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{width:min(440px,100%);padding:36px 32px 28px;border:1px solid var(--line);border-radius:18px;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.04),0 24px 60px -30px rgba(0,0,0,.35);text-align:center;animation:in .45s cubic-bezier(.16,1,.3,1)}
.brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:26px;font-weight:650;letter-spacing:.01em;color:var(--muted);font-size:13px}
.logo{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:#0b0b0d;color:var(--accent);font:800 12px/1 ui-monospace,monospace}
.badge{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 18px;border-radius:50%;background:${ok ? 'var(--ok)' : 'var(--bad)'};box-shadow:0 0 0 8px color-mix(in srgb,${ok ? 'var(--ok)' : 'var(--bad)'} 14%,transparent);animation:pop .5s .1s both cubic-bezier(.34,1.56,.64,1)}
.badge svg{width:30px;height:30px}
h1{margin:0 0 6px;font-size:20px;font-weight:650;letter-spacing:-.01em}
p{margin:0;color:var(--muted)}
.hint{margin-top:22px;padding-top:16px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
@keyframes in{from{opacity:0;transform:translateY(8px)}}@keyframes pop{from{transform:scale(.4);opacity:0}}
@media (prefers-reduced-motion:reduce){.card,.badge{animation:none}}
</style></head><body><main class="card" role="status">
<div class="brand"><span class="logo">0</span>zer0ne coding</div>
<div class="badge"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></div>
<h1>${esc(title)}</h1><p>${esc(detail)}</p>
<div class="hint">${ok ? 'You can close this tab — the editor has everything it needs.' : 'Close this tab and try again from the editor.'}</div>
</main>${ok ? '<script>setTimeout(()=>{try{window.close()}catch(e){}},2500)</script>' : ''}</body></html>`;
}

/** One-shot localhost callback on a fixed port (the vendor only redirects there). */
function listenForCode(port: number, pathName: string, state: string, signal: AbortSignal, label: string): Promise<{ wait: Promise<{ code: string; clientId?: string }>; close: () => void; port: number }> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error('Sign-in cancelled.'));
		let settle!: (result: { code: string; clientId?: string }) => void;
		let fail!: (e: Error) => void;
		const wait = new Promise<{ code: string; clientId?: string }>((res, rej) => ((settle = res), (fail = rej)));
		wait.catch(() => undefined);
		const server = http.createServer((req, res) => {
			// The listener is bound to 127.0.0.1; parse against the same name so a host that
			// resolves "localhost" only to ::1 cannot change how the callback is read.
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			if (req.method !== 'GET' || url.pathname !== pathName) {
				res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
				return;
			}
			const err = url.searchParams.get('error_description') || url.searchParams.get('error');
			const code = url.searchParams.get('code');
			const matches = url.searchParams.get('state') === state;
			const good = !!code && matches && !err;
			res.writeHead(good ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			res.end(good ? callbackPage(true, `Signed in to ${label}`, 'zer0ne is finishing the connection in your editor.') : callbackPage(false, 'Sign-in did not finish', err || 'The request was not recognised (state mismatch).'));
			// A different browser tab must not cancel the active authorization request.
			if (matches) good ? settle({ code: code!, clientId: url.searchParams.get('client_id') ?? undefined }) : fail(new Error(err ? `${label} sign-in failed: ${err}` : 'Sign-in failed: no authorization code.'));
		});
		const close = () => {
			signal.removeEventListener('abort', onAbort);
			fail(new Error('Sign-in timed out or closed.'));
			try {
				server.close();
				// Browsers keep the callback connection alive; drop it so port 1455 is free for the next sign-in.
				server.closeAllConnections();
			} catch {
				/* already closed */
			}
		};
		const onAbort = () => { fail(new Error('Sign-in cancelled.')); reject(new Error('Sign-in cancelled.')); close(); };
		signal.addEventListener('abort', onAbort, { once: true });
		server.once('error', (e: NodeJS.ErrnoException) => { close(); reject(e.code === 'EADDRINUSE' ? Object.assign(new Error(`Port ${port} is in use (another sign-in or the Codex CLI is waiting there).`), { code: 'EADDRINUSE' }) : e); });
		server.listen(port, '127.0.0.1', () => { if (signal.aborted) onAbort(); else resolve({ wait, close, port: (server.address() as { port: number }).port }); });
	});
}

// ---------------------------------------------------------------- ChatGPT (Codex)

const OPENAI_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH = 'https://auth.openai.com';
const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const OPENAI_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
let openaiKeys: { keys: JsonWebKey[]; until: number } | undefined;

async function validateOpenAiIdentity(token: string, clientId: string, signal?: AbortSignal, nonce?: string): Promise<Record<string, any>> {
	const pieces = token.split('.');
	if (pieces.length !== 3) throw new Error('OpenAI returned an invalid ID token.');
	let header: any, claims: any;
	try { header = JSON.parse(Buffer.from(pieces[0], 'base64url').toString()); claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString()); }
	catch { throw new Error('OpenAI returned an invalid ID token.'); }
	if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || !header.kid || header.crit) throw new Error('OpenAI returned an unsupported ID-token signature.');
	const loadKeys = async () => {
		const response = await fetch(`${OPENAI_AUTH}/.well-known/jwks.json`, { headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`OpenAI identity verification keys could not be read (HTTP ${response.status}).`);
		const document: any = await response.json();
		if (!Array.isArray(document.keys)) throw new Error('OpenAI returned invalid identity verification keys.');
		openaiKeys = { keys: document.keys, until: Date.now() + 3600_000 };
	};
	if (!openaiKeys || openaiKeys.until <= Date.now()) await loadKeys();
	const matchingKey = () => openaiKeys!.keys.find((key: any) => key.kid === header.kid && (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig') && key.kty === (header.alg === 'RS256' ? 'RSA' : 'EC') && (header.alg !== 'ES256' || key.crv === 'P-256'));
	let jwk = matchingKey();
	if (!jwk) { await loadKeys(); jwk = matchingKey(); }
	if (!jwk) throw new Error('OpenAI ID-token signing key was not recognised.');
	let valid = false;
	try {
		const key = createPublicKey({ key: jwk, format: 'jwk' });
		valid = verify('sha256', Buffer.from(`${pieces[0]}.${pieces[1]}`), header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key, Buffer.from(pieces[2], 'base64url'));
	} catch { /* reject malformed keys or signatures */ }
	if (!valid) throw new Error('OpenAI ID-token signature could not be verified.');
	const now = Date.now() / 1000;
	const audience = typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
	if (claims.iss !== OPENAI_AUTH || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || !Number.isFinite(claims.exp) || claims.exp <= now - 5 || !Number.isFinite(claims.iat) || claims.iat > now + 5 || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5)) || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) throw new Error('OpenAI ID-token identity, audience, expiry or nonce did not match this sign-in.');
	return claims;
}

async function chatgptPlanCredential(body: any, registration: { clientId: string; hostId: string; nonce?: string; previous?: AccountCredential }, signal?: AbortSignal): Promise<AccountCredential> {
	// A renewal (no nonce) and a first sign-in fail differently, and say so.
	const renewing = registration.nonce === undefined;
	// A renewal response may omit the token type; a first sign-in must name it.
	const tokenType = typeof body.token_type === 'string' ? body.token_type.toLowerCase() : renewing ? 'bearer' : '';
	if (typeof body.access_token !== 'string' || !body.access_token || tokenType !== 'bearer' || !Number.isFinite(Number(body.expires_in)) || Number(body.expires_in) <= 0) {
		throw new Error(renewing ? 'OpenAI returned incomplete ChatGPT plan credentials for the renewal. Sign in again.' : 'OpenAI returned incomplete ChatGPT plan credentials.');
	}
	const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : registration.previous?.scopes ?? [];
	if (!scopes.includes(OPENAI_PLAN_SCOPE) || !scopes.includes('resource.invoke')) throw new Error('ChatGPT plan usage was not authorized. Continue with ChatGPT in the desktop browser and allow access to your plan.');
	const previous = registration.previous;
	let identity: Record<string, any>;
	// Whether the subject was checked against a signed ID token in this response.
	let subjectVerified = true;
	if (typeof body.id_token === 'string' && body.id_token) {
		identity = await validateOpenAiIdentity(body.id_token, registration.clientId, signal, registration.nonce);
	} else if (renewing && previous?.subject) {
		// A renewal may answer without an ID token. The subject then cannot be checked, so the
		// known one is carried over — but it is never presented as freshly verified.
		identity = { sub: previous.subject, email: previous.email };
		subjectVerified = false;
	} else throw new Error('OpenAI did not return an ID token to validate.');
	// Only a freshly verified identity can contradict the stored one.
	if (subjectVerified && previous?.subject && identity.sub !== previous.subject) throw new Error('This sign-in belongs to another ChatGPT account. Add it as a separate account.');
	const refresh = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : previous?.refresh ?? '';
	if (!refresh) throw new Error('OpenAI did not authorize a renewable session. Sign in again with offline access.');
	return { kind: 'account', account: 'chatgpt', access: body.access_token, refresh, expires: Date.now() + Number(body.expires_in) * 1000, email: typeof identity.email === 'string' ? identity.email : previous?.email, clientId: registration.clientId, hostId: registration.hostId, subject: identity.sub, subjectVerified, idToken: body.id_token ?? previous?.idToken, scopes };
}

async function chatgptPlanBrowser(ui: SignInUi): Promise<AccountCredential> {
	if (!ui.hostId || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ui.hostId)) throw new Error('ChatGPT sign-in needs the saved installation identifier. Restart zer0ne and try again.');
	const previous = ui.previous?.account === 'chatgpt' && ui.previous.clientId ? ui.previous : undefined;
	const verifier = b64url(randomBytes(32)), state = b64url(randomBytes(16)), nonce = b64url(randomBytes(16));
	const listener = await listenForCode(0, '/auth/callback', state, ui.signal, 'ChatGPT');
	const redirect = `http://127.0.0.1:${listener.port}/auth/callback`;
	const timeout = setTimeout(() => listener.close(), 10 * 60_000);
	try {
		const url = new URL(`${OPENAI_AUTH}/api/accounts/authorize`);
		for (const [key, value] of Object.entries({ client_id: previous?.clientId ?? 'dynamic_agent_client', ext_agent_host_id: ui.hostId, response_type: 'code', redirect_uri: redirect, scope: `openid profile email offline_access resource.invoke ${OPENAI_PLAN_SCOPE}`, resource: OPENAI_RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: b64url(createHash('sha256').update(verifier).digest()) })) url.searchParams.set(key, value);
		if (!previous) url.searchParams.set('agent_name_hint', 'zer0ne Code');
		// Do not expose the retained ID token in UI events or diagnostics.
		ui.onEvent({ stage: 'browser', url: url.href });
		if (previous?.idToken) url.searchParams.set('id_token_hint', previous.idToken);
		if (previous?.email) url.searchParams.set('login_hint', previous.email);
		if (await ui.open(url.href) === false) throw new Error('The browser could not be opened. Try sign-in again.');
		const callback = await listener.wait;
		const clientId = callback.clientId ?? previous?.clientId;
		if (!clientId || clientId === 'dynamic_agent_client' || (previous?.clientId && clientId !== previous.clientId)) throw new Error('OpenAI returned an incomplete or different client registration. Start sign-in again.');
		ui.onEvent({ stage: 'exchanging' });
		const result = await postForm(`${OPENAI_AUTH}/api/accounts/oauth/token`, { grant_type: 'authorization_code', client_id: clientId, code: callback.code, code_verifier: verifier, redirect_uri: redirect, resource: OPENAI_RESOURCE }, ui.signal);
		if (!result.ok) throw new Error(`OpenAI refused ChatGPT plan sign-in (HTTP ${result.status}). Start sign-in again.`);
		return await chatgptPlanCredential(result.body, { clientId, hostId: ui.hostId, nonce, previous }, ui.signal);
	} finally { clearTimeout(timeout); listener.close(); }
}

function chatgptCredential(json: any, previous?: AccountCredential): AccountCredential {
	if (typeof json?.access_token !== 'string') throw new Error('OpenAI did not return an access token.');
	const idClaims = typeof json.id_token === 'string' ? decodeJwt(json.id_token) : undefined;
	const auth = decodeJwt(json.access_token)?.['https://api.openai.com/auth'] ?? idClaims?.['https://api.openai.com/auth'] ?? {};
	return {
		kind: 'account',
		account: 'chatgpt',
		access: json.access_token,
		refresh: typeof json.refresh_token === 'string' ? json.refresh_token : previous?.refresh ?? '',
		expires: Date.now() + (Number(json.expires_in) || 3600) * 1000,
		email: idClaims?.email ?? previous?.email,
		plan: typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : previous?.plan,
		accountId: chatgptAccountId(json.access_token) ?? previous?.accountId
	};
}




async function chatgptRefresh(c: AccountCredential): Promise<AccountCredential> {
	if (c.clientId) {
		if (!c.hostId || !c.subject) throw Object.assign(new Error('ChatGPT registration is incomplete — sign in again.'), { signedOut: true });
		const result = await postForm(`${OPENAI_AUTH}/api/accounts/oauth/token`, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId, resource: OPENAI_RESOURCE });
		if (!result.ok) throw Object.assign(new Error(`ChatGPT session could not be renewed (HTTP ${result.status})${result.body?.error === 'invalid_grant' ? ' — sign in again' : '.'}`), { signedOut: result.body?.error === 'invalid_grant' || result.status === 401 });
		return chatgptPlanCredential(result.body, { clientId: c.clientId, hostId: c.hostId, previous: c });
	}
	const r = await postForm(`${OPENAI_AUTH}/oauth/token`, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: OPENAI_CLIENT, scope: 'openid profile email' });
	if (!r.ok) throw Object.assign(new Error(`ChatGPT session expired — sign in again (HTTP ${r.status}).`), { signedOut: r.status === 400 || r.status === 401 });
	return chatgptCredential(r.body, c);
}

// ---------------------------------------------------------------- xAI (SuperGrok / X Premium)

const XAI_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_TOKEN = 'https://auth.x.ai/oauth2/token';

function xaiCredential(body: any, previous?: AccountCredential): AccountCredential {
	if (typeof body?.access_token !== 'string') throw new Error('xAI did not return an access token.');
	const claims = decodeJwt(body.id_token ?? '') ?? decodeJwt(body.access_token) ?? {};
	return {
		kind: 'account',
		account: 'xai',
		access: body.access_token,
		refresh: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refresh ?? '',
		expires: Date.now() + (Number(body.expires_in) || 3600) * 1000,
		email: claims.email ?? previous?.email,
		plan: previous?.plan
	};
}


async function xaiRefresh(c: AccountCredential): Promise<AccountCredential> {
	const r = await postForm(XAI_TOKEN, { grant_type: 'refresh_token', client_id: XAI_CLIENT, refresh_token: c.refresh });
	if (!r.ok) throw Object.assign(new Error(`xAI session expired — sign in again (HTTP ${r.status}).`), { signedOut: r.status === 400 || r.status === 401 });
	return xaiCredential(r.body, c);
}

// ---------------------------------------------------------------- Kimi Code

const KIMI_CLIENT = '17e5f671-d194-4dfb-9706-5516cb48c098';
const KIMI_AUTH = 'https://auth.kimi.com';

function kimiCredential(body: any, previous?: AccountCredential): AccountCredential {
	if (typeof body?.access_token !== 'string') throw new Error('Kimi did not return an access token.');
	return { kind: 'account', account: 'kimi', access: body.access_token, refresh: body.refresh_token ?? previous?.refresh ?? '', expires: Date.now() + (Number(body.expires_in) || 3600) * 1000, email: previous?.email, plan: previous?.plan };
}


async function kimiRefresh(c: AccountCredential): Promise<AccountCredential> {
	const r = await postForm(`${KIMI_AUTH}/api/oauth/token`, { client_id: KIMI_CLIENT, grant_type: 'refresh_token', refresh_token: c.refresh });
	if (!r.ok) throw Object.assign(new Error(`Kimi session expired — sign in again (HTTP ${r.status}).`), { signedOut: r.status === 401 || r.status === 403 || r.body?.error === 'invalid_grant' });
	return kimiCredential(r.body, c);
}

// ---------------------------------------------------------------- MiniMax Coding Plan

/*
 * MiniMax's own CLI sign-in (MiniMax-AI/cli): the device-authorization grant
 * with PKCE against account.minimax.io, polled with the user code. The token
 * is used as a Bearer key on MiniMax's Anthropic-compatible endpoint, which is
 * how MiniMax documents Coding Plan OAuth for other harnesses (OpenClaw).
 */
const MINIMAX_CLIENT = '659cf4c1-615c-45f6-a5f6-4bf15eb476e5';
const MINIMAX_AUTH = 'https://account.minimax.io';

function minimaxCredential(body: any, previous?: AccountCredential): AccountCredential {
	if (typeof body?.access_token !== 'string') throw new Error('MiniMax did not return an access token.');
	// expired_in is an absolute time in ms (not a duration).
	const at = Number(body.expired_in);
	return { kind: 'account', account: 'minimax', access: body.access_token, refresh: body.refresh_token || previous?.refresh || '', expires: at > 1e12 ? at : Date.now() + 3600_000, email: previous?.email, plan: previous?.plan };
}


async function minimaxRefresh(c: AccountCredential): Promise<AccountCredential> {
	const r = await postForm(`${MINIMAX_AUTH}/oauth2/token`, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: MINIMAX_CLIENT });
	if (!r.ok || typeof r.body?.access_token !== 'string') throw Object.assign(new Error(`MiniMax session expired — sign in again (HTTP ${r.status}).`), { signedOut: r.status === 400 || r.status === 401 || r.status === 403 });
	return minimaxCredential(r.body, c);
}

// ---------------------------------------------------------------- public API

/** Only documented application authorization is offered for a new native connection. */
export async function signIn(account: AccountKind, ui: SignInUi): Promise<AccountCredential> {
	if (ui.signal.aborted) throw new Error('Sign-in cancelled.');
	if (!Object.hasOwn(ACCOUNTS, account)) throw new Error('Unknown account type.');
	if (account !== 'chatgpt') throw new Error(`${ACCOUNTS[account].name}: connect the provider's official agent or dedicated plan key in Plans & subscriptions. Native OAuth for zer0ne has not been registered for this provider.`);
	if (ui.method === 'device') throw new Error('ChatGPT plan authorization requires browser sign-in. Continue with ChatGPT from the desktop app.');
	return chatgptPlanBrowser(ui);
}

const inflight = new Map<string, Promise<AccountCredential>>();

/** A fresh credential (refreshed when it expires within a minute); concurrent callers share one refresh. */
export function ensureFresh(c: AccountCredential, now = Date.now()): Promise<AccountCredential> {
	if (c.expires - 60_000 > now || !c.refresh) return Promise.resolve(c);
	const key = c.account + ':' + (c.clientId ?? 'legacy') + ':' + createHash('sha256').update(c.refresh).digest('hex');
	let p = inflight.get(key);
	if (!p) {
		p = (c.account === 'chatgpt' ? chatgptRefresh(c) : c.account === 'xai' ? xaiRefresh(c) : c.account === 'minimax' ? minimaxRefresh(c) : kimiRefresh(c)).finally(() => inflight.delete(key));
		inflight.set(key, p);
	}
	return p;
}

export interface AccountRevocation { confirmed: boolean; message: string }

/** End a modern ChatGPT renewable session before the host clears its selected account's tokens. */
export async function revokeAccount(c: AccountCredential, signal?: AbortSignal): Promise<AccountRevocation> {
	const unconfirmed = (message = 'Remote revocation was not confirmed. Disconnect zer0ne Code in ChatGPT Settings if needed.'): AccountRevocation => ({ confirmed: false, message });
	if (c.account !== 'chatgpt' || !c.clientId) return unconfirmed('This older account connection was removed locally. Disconnect the app through the provider to end its remote session.');
	if (!c.refresh || signal?.aborted) return unconfirmed();
	const retryFetch = async (url: string, init: RequestInit): Promise<Response> => {
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await fetch(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
				if (response.status < 500 || attempt === 2) return response;
				await response.body?.cancel();
			} catch {
				if (signal?.aborted || attempt === 2) throw new Error('Remote revocation could not be confirmed.');
			}
			await sleep(attempt === 0 ? 250 : 750, signal ?? new AbortController().signal);
		}
	};
	try {
		const discovery = await retryFetch(`${OPENAI_AUTH}/.well-known/openid-configuration`, { headers: { Accept: 'application/json' } });
		if (!discovery.ok) return unconfirmed();
		const configuration: any = await discovery.json();
		const endpoint = new URL(configuration.revocation_endpoint);
		// Never forward refresh credentials to redirects or an endpoint outside OpenAI's production issuer.
		if (configuration.issuer !== OPENAI_AUTH || endpoint.origin !== OPENAI_AUTH || endpoint.username || endpoint.password || endpoint.hash) return unconfirmed();
		const response = await retryFetch(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ token: c.refresh, token_type_hint: 'refresh_token', client_id: c.clientId }).toString() });
		if (response.status === 200 && !(await response.text()).trim()) return { confirmed: true, message: 'ChatGPT session revoked. You can sign in again with this account.' };
		return unconfirmed();
	} catch { return unconfirmed(); }
}

/** The account's own model list (falls back to the known models). */
export async function accountModels(c: AccountCredential, signal?: AbortSignal): Promise<AccountSpec['models']> {
	const spec = ACCOUNTS[c.account];
	if (signal?.aborted) throw new Error('Sign-in cancelled.');
	const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
	const assertAuthorized = (res: Response) => {
		if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`${spec.name} refused access to the model list (HTTP ${res.status}). Sign in again or check this account's plan access.`), { accountAccessDenied: true, signedOut: res.status === 401 });
	};
	if (c.account === 'chatgpt' && c.clientId) {
		const response = await fetch(`${OPENAI_RESOURCE}/models`, { headers: { Authorization: `Bearer ${c.access}`, Accept: 'application/json' }, signal: requestSignal });
		assertAuthorized(response);
		if (!response.ok) throw new Error(`ChatGPT model catalog could not be read (HTTP ${response.status}). Try Fetch models again later.`);
		const document: any = await response.json();
		const list = Array.isArray(document.models) ? document.models : Array.isArray(document.data) ? document.data : [];
		// The general API catalog also contains embedding, audio and image products.
		const models: AccountSpec['models'] = list.filter((model: any) => {
			const id = model?.slug ?? model?.id;
			return (model?.visibility ?? 'list') === 'list' && typeof id === 'string' && /^(?:gpt-(?:[4-9]|[1-9]\d)|chatgpt-4o|o[1-9]\d*(?:[-.]|$))/i.test(id) && !/audio|realtime|image|embed|transcrib|tts|search-preview/i.test(id) && (!Array.isArray(model.output_modalities) || model.output_modalities.includes('text'));
		}).map((model: any) => ({ id: model.slug ?? model.id, name: typeof model.display_name === 'string' ? model.display_name : undefined, contextWindow: Number(model.context_window) || undefined, maxOutput: Number(model.max_output_tokens) || undefined, vision: Array.isArray(model.input_modalities) ? model.input_modalities.includes('image') : undefined, reasoning: Array.isArray(model.supported_reasoning_efforts) ? model.supported_reasoning_efforts.length > 0 : undefined, reasoningControl: advertisedReasoning(model, 'responses', OPENAI_RESOURCE) }));
		if (!models.length) throw new Error('ChatGPT returned no text models for this connection. Check your account permissions and Fetch models again.');
		return models;
	}
	try {
		if (c.account === 'chatgpt') {
			const res = await fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.155.0', {
				headers: { Authorization: `Bearer ${c.access}`, 'chatgpt-account-id': c.accountId ?? chatgptAccountId(c.access) ?? '', originator: 'zer0ne', Accept: 'application/json' },
				signal: requestSignal
			});
			assertAuthorized(res);
			if (res.ok) {
				const j: any = await res.json();
				const list = (Array.isArray(j?.models) ? j.models : Array.isArray(j?.data) ? j.data : []) as any[];
				const out = list
					.filter((m) => (m.visibility ?? 'list') !== 'hide' && (m.slug || m.id))
					.map((m) => ({ id: String(m.slug ?? m.id), contextWindow: Number(m.context_window) || undefined, reasoning: true, vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : undefined }));
				if (out.length) return out;
			}
		} else if (c.account === 'xai') {
			const res = await fetch(`${spec.baseUrl}/models`, { headers: { Authorization: `Bearer ${c.access}` }, signal: requestSignal });
			assertAuthorized(res);
			if (res.ok) {
				const j: any = await res.json();
				const out = ((j?.data ?? []) as any[]).filter((m) => /grok/i.test(m.id) && !/image|imagine|vision-beta/i.test(m.id)).map((m) => ({ id: String(m.id), reasoning: true }));
				if (out.length) return out.map((m) => spec.models.find((k) => k.id === m.id) ?? m);
			}
		}
	} catch (e) {
		if (signal?.aborted) throw new Error('Sign-in cancelled.');
		if ((e as { accountAccessDenied?: boolean }).accountAccessDenied) throw e;
		/* the known list below */
	}
	return spec.models;
}

// ---------------------------------------------------------------- end-to-end check

/** One streamed request, as the caller's client makes it (injected: chatClient imports this file). */
export type AccountStream = (o: { baseUrl: string; apiKey: string; model: string; apiFormat: AccountSpec['apiFormat']; chatgptPlan?: boolean; system: string; messages: Array<{ role: 'user'; content: string }>; signal: AbortSignal; maxTokens: number; onText(t: string): void }) => Promise<{ text: string; reasoning: string; usage?: { input: number; output: number; cached?: number } }>;

export interface AccountCheck {
	ok: boolean;
	steps: Array<{ ok: boolean; text: string }>;
	/** The credential after the forced refresh — save it: refresh tokens rotate. */
	refreshed?: AccountCredential;
}

/**
 * Prove a signed-in account works end to end: read its model list, stream one
 * short reply (first-token time, usage), then force a token refresh. Used by
 * `zer0ne --verify-account` and Providers & models → Check connection.
 */
export async function checkAccount(cred: AccountCredential, stream: AccountStream, signal: AbortSignal): Promise<AccountCheck> {
	const spec = ACCOUNTS[cred.account];
	const connection = cred.account === 'chatgpt' && !cred.clientId ? { baseUrl: 'https://chatgpt.com/backend-api/codex', apiFormat: 'codex' as const } : spec;
	const steps: AccountCheck['steps'] = [];
	let models: AccountSpec['models'] | undefined;
	try { models = await accountModels(cred, signal); }
	catch (e) {
		if (cred.clientId || signal.aborted) return { ok: false, steps: [{ ok: false, text: e instanceof Error ? e.message : String(e) }] };
	}
	steps.push({ ok: !!models?.length, text: models?.length ? `${models.length} models in the catalog (${models.slice(0, 4).map((m) => m.id).join(', ')}${models.length > 4 ? ', …' : ''}); the response test checks account access` : 'the model list could not be read — the built-in list is used' });
	const model = (models?.length ? models : spec.models)[0].id;
	try {
		const t0 = Date.now();
		let first = 0;
		const r = await stream({ baseUrl: connection.baseUrl, apiKey: cred.access, model, apiFormat: connection.apiFormat, chatgptPlan: !!cred.clientId, system: 'You are a connection test. Answer in five words or fewer.', messages: [{ role: 'user', content: 'Reply with: zer0ne connection ok' }], signal, maxTokens: 256, onText: () => (first ||= Math.max(1, Date.now() - t0)) });
		const u = r.usage;
		steps.push({ ok: !!r.text.trim(), text: `${model} answered ${JSON.stringify(r.text.trim().slice(0, 60))} · first token ${first || '—'} ms · ${Date.now() - t0} ms${u ? ` · ${u.input} in / ${u.output} out${u.cached ? ` / ${u.cached} cached` : ''}` : ''}` });
	} catch (e) {
		steps.push({ ok: false, text: `${model}: ${e instanceof Error ? e.message : String(e)}` });
		return { ok: false, steps };
	}
	// Modern session renewal is serialized by the credential store near expiry, not forced by a diagnostic.
	if (cred.account === 'chatgpt' && cred.clientId) return { ok: steps.every(step => step.ok), steps: [...steps, { ok: true, text: 'Session renewal runs automatically near expiry.' }] };
	try {
		if (signal.aborted) throw new Error('Connection check cancelled.');
		const fresh = await ensureFresh({ ...cred, expires: 0 });
		const ok = !!fresh.access && fresh.expires > Date.now();
		steps.push({ ok, text: ok ? `token refresh works (the new one is valid for ${Math.round((fresh.expires - Date.now()) / 60_000)} min)` : 'the refresh returned no usable token' });
		return { ok: steps.every((s) => s.ok || s === steps[0]), steps, refreshed: fresh };
	} catch (e) {
		steps.push({ ok: false, text: `token refresh failed: ${e instanceof Error ? e.message : String(e)} — sign in again` });
		return { ok: false, steps };
	}
}
