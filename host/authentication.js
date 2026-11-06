'use strict';
const crypto = require('crypto');

function githubAuthentication({ secrets, prompt, fetch: request = globalThis.fetch, changed = () => {} }) {
	const key = scopes => 'desktop.github.' + [...new Set(scopes)].sort().join(',');
	const session = async (token, scopes) => {
		const response = await request('https://api.github.com/user', {
			headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zer0ne-Code' },
			signal: AbortSignal.timeout(15000)
		});
		if (!response.ok) throw new Error(response.status === 401 ? 'GitHub rejected this token. Check it and try again.' : `GitHub sign-in failed (${response.status}).`);
		const user = await response.json();
		if (!user.id || !user.login) throw new Error('GitHub returned an invalid account.');
		const granted = response.headers.get('x-oauth-scopes');
		if (granted !== null) {
			const available = new Set(granted.split(',').map(s => s.trim()));
			const missing = scopes.filter(s => !available.has(s) && !(s === 'read:user' && available.has('user')));
			if (missing.length) throw new Error(`The GitHub token needs these permissions: ${missing.join(', ')}.`);
		}
		return { id: crypto.createHash('sha256').update(token).digest('hex'), accessToken: token, account: { id: String(user.id), label: user.login }, scopes: [...scopes] };
	};
	return {
		async getSession(provider, scopes, options = {}) {
			if (provider !== 'github') throw new Error(`Desktop sign-in is unavailable for ${provider}.`);
			const store = secrets();
			if (!store) throw new Error('Secure credential storage is not ready.');
			const saved = await store.get(key(scopes));
			if (saved && !options.forceNewSession) {
				try { return await session(saved, scopes); }
				catch (error) { if (!options.createIfNone && !options.forceNewSession) { if (options.silent) return undefined; throw error; } }
			}
			if (!options.createIfNone && !options.forceNewSession) return undefined;
			let failure = '';
			while (true) {
				const token = await prompt({ kind: 'input', title: 'Sign in to GitHub', prompt: `${failure}Paste a GitHub personal access token with ${scopes.join(', ')} permissions.`, password: true, link: 'https://github.com/settings/tokens/new?scopes=' + encodeURIComponent(scopes.join(',')), linkLabel: 'Create a GitHub token' });
				if (token === undefined) throw new Error('GitHub sign-in was cancelled.');
				let signed;
				try { signed = await session(token.trim(), scopes); }
				catch (error) { failure = error.message + '\n'; continue; }
				await store.store(key(scopes), token.trim());
				changed({ provider: { id: 'github', label: 'GitHub' }, added: [signed], removed: [], changed: [] });
				return signed;
			}
		}
	};
}
module.exports = { githubAuthentication };
