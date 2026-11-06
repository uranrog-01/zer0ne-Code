import * as http from 'http';
import { createHash, randomBytes } from 'crypto';
import { callbackPage } from './accounts';

/**
 * "Sign in with OpenRouter" — OpenRouter's official OAuth PKCE flow for
 * third-party apps. The user approves in their browser; OpenRouter
 * redirects to a one-shot localhost callback, and the code is exchanged
 * for a user-controlled API key (revocable at openrouter.ai/settings/keys).
 * One OpenRouter account reaches Claude, GPT, Gemini, Kimi, GLM and more.
 */

function b64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signInWithOpenRouter(openExternal: (url: string) => Thenable<boolean> | Promise<boolean>, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) throw new Error('Sign-in cancelled.');
	const verifier = b64url(randomBytes(32));
	// OpenRouter has no `state` parameter; an unguessable callback path does the same job (CSRF).
	const nonce = b64url(randomBytes(16));
	const challenge = b64url(createHash('sha256').update(verifier).digest());

	let server: http.Server | undefined;
	let port = 0;
	let resolveCode!: (code: string) => void;
	let rejectCode!: (e: Error) => void;
	const codePromise = new Promise<string>((res, rej) => {
		resolveCode = res;
		rejectCode = rej;
	});
	// Browser launch can fail before the callback promise is awaited.
	codePromise.catch(() => undefined);
	const onAbort = () => rejectCode(new Error('Sign-in cancelled.'));
	signal?.addEventListener('abort', onAbort, { once: true });
	let timer: NodeJS.Timeout | undefined;
	try {
		server = await new Promise<http.Server>((resolve, reject) => {
				const s = http.createServer((req, res) => {
					const url = new URL(req.url ?? '/', 'http://127.0.0.1');
					if (req.method !== 'GET' || url.pathname !== `/callback/${nonce}`) {
						res.writeHead(404).end();
						return;
					}
					const code = url.searchParams.get('code');
					res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
					res.end(code ? callbackPage(true, 'Signed in to OpenRouter', 'zer0ne is saving your key in the OS keychain.') : callbackPage(false, 'Sign-in was cancelled', 'OpenRouter did not send a code.'));
					code ? resolveCode(code) : rejectCode(new Error('OpenRouter sign-in was cancelled.'));
				});
				s.once('error', reject);
				// OpenRouter accepts localhost callbacks on any port; let the OS choose a free one.
				s.listen(0, '127.0.0.1', () => resolve(s));
		});
		port = (server.address() as { port: number }).port;
		if (signal?.aborted) throw new Error('Sign-in cancelled.');
		timer = setTimeout(() => rejectCode(new Error('Sign-in timed out after 5 minutes.')), 5 * 60_000);
		// The listener binds 127.0.0.1 only: the callback must use the same address, or a host
		// where "localhost" resolves to ::1 alone never reaches the server.
		const callback = `http://127.0.0.1:${port}/callback/${nonce}`;
		const authUrl = `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`;
		if (!await openExternal(authUrl)) throw new Error('The browser could not be opened. Try sign-in again.');
		const code = await codePromise;
		if (signal?.aborted) throw new Error('Sign-in cancelled.');
		const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
		});
		if (!res.ok) {
			throw new Error(`OpenRouter rejected the sign-in code (HTTP ${res.status}).`);
		}
		const json = (await res.json()) as { key?: string };
		if (typeof json.key !== 'string' || !json.key.trim()) {
			throw new Error('OpenRouter did not return an API key.');
		}
		return json.key;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', onAbort);
		server?.close();
		server?.closeAllConnections();
	}
}
