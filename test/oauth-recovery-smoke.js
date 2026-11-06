'use strict';
const assert = require('node:assert/strict'), path = require('node:path');

module.exports = async function oauthRecoverySmoke(page, shots, until) {
	const challenge = 'https://accounts.google.com/signin/continue?plt=fixture_signed%2Bvalue&continue=https%3A%2F%2Fexample.test%2Fdone&authuser=0';
	const send = data => page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(data) + '}))');
	await page.eval(`window.__oauthSmokePost = window.Bridge.post; window.__oauthSmokeMessages = []; window.Bridge.post = message => { window.__oauthSmokeMessages.push(message); return Promise.resolve(); }; window.Settings.open('models');`);
	try {
		await send({ type: 'acpAgents', cards: [{ id: 'antigravity-acp', name: 'Google Antigravity', plans: 'Google AI Pro · Ultra', plan: true, available: true, download: true, tile: { text: 'G', bg: '#4285f4' }, manageUrl: 'https://antigravity.google', desc: 'Connect using the vendor’s sign-in.' }], connected: [], installed: {} });
		await page.eval(`document.querySelector('[data-act="add-provider"]').click(); document.querySelector('[data-add-tab="plans"]').click()`);
		await until('Antigravity fixture card', () => page.eval(`!!document.querySelector('[data-acp-signin="antigravity-acp"]')`));
		await page.eval(`document.querySelector('[data-acp-signin="antigravity-acp"]').click()`);
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'error', error: 'Signed in, but Google Antigravity needs your account verified. Complete Google’s check, then try again. [Verify your account](' + challenge + ') [Google account security](https://myaccount.google.com/security) [Antigravity sign-in help](https://antigravity.google/docs/faq)' });
		const buttons = await page.eval(`(() => { const dialog = document.querySelector('.signin-dlg'); const actions = [...dialog.querySelectorAll('[data-act="open-url"]')]; actions.forEach(button => (button.querySelector('svg') || button).dispatchEvent(new MouseEvent('click', {bubbles:true}))); dialog.querySelector('[data-act="copy-verification-url"]').click(); return window.__oauthSmokeMessages.filter(m => m.type === 'openExternal' || m.type === 'copyText'); })()`);
		assert.deepEqual(buttons, [{ type: 'openExternal', url: challenge }, { type: 'openExternal', url: 'https://myaccount.google.com/security' }, { type: 'openExternal', url: 'https://antigravity.google/docs/faq' }, { type: 'copyText', text: challenge }]);
		await page.eval(`for (const root of ['settings-root','dialog-root']) document.getElementById(root)?.getAnimations({subtree:true}).forEach(animation => { if (animation.effect.getTiming().iterations !== Infinity) animation.finish(); }); document.getElementById('toast').classList.add('hidden')`);
		await page.screenshot(path.join(shots, 'oauth-verification-recovery.png'));
		await page.eval(`document.querySelector('.signin-dlg [data-si="reauthorize"]').click()`);
		await until('Google reconnect bridge request', () => page.eval(`window.__oauthSmokeMessages.some(m => m.type==='acpSignIn' && m.agent==='antigravity-acp' && m.reauthenticate===true)`));
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'error', error: 'Fixture reconnect cancelled' });
		const beforeRetry = await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').length`);
		await page.eval(`document.querySelector('.signin-dlg [data-si="retry"]').click()`);
		await until('ordinary verification retry', () => page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').length > ${beforeRetry}`));
		assert.equal(await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').at(-1).reauthenticate`), undefined);
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'error', error: 'Fixture fresh browser login failed' });
		const beforeFresh = await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').length`);
		await page.eval(`document.querySelector('.signin-dlg [data-si="copyfresh"]').click()`);
		await until('fresh sign-in link request', () => page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').length > ${beforeFresh}`));
		assert.equal(await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='acpSignIn').at(-1).reauthenticate`), true);
		const freshUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture%2Bvalue&code_challenge=fixture&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2F';
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'browser', url: freshUrl });
		assert.equal(await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='copyText').at(-1).text`), freshUrl);
		assert.equal(await page.eval(`document.querySelector('[data-acp-login-link]').value`), freshUrl);
		await page.eval(`document.querySelector('.signin-dlg [data-si="copylink"]').click()`);
		assert.equal(await page.eval(`window.__oauthSmokeMessages.filter(m => m.type==='copyText').at(-1).text`), freshUrl);
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'code', url: 'https://example.test/oauth?state=fixture%2Bvalue' });
		await page.eval(`document.getElementById('acp-code').value = 'partially-entered-code'; document.getElementById('acp-code').focus()`);
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'browser-launch-error', url: 'https://example.test/oauth?state=fixture%2Bvalue', browserError: 'Your browser did not open. Open the page again or copy the link.' });
		assert(await page.eval(`document.getElementById('acp-code')?.value === 'partially-entered-code' && document.activeElement.id === 'acp-code' && !!document.querySelector('.signin-dlg [data-si="copylink"]') && document.querySelector('.signin-dlg [role="status"]').textContent.includes('browser did not open')`), 'an asynchronous browser failure keeps code entry and its draft');
		await page.screenshot(path.join(shots, 'oauth-browser-fallback.png'));
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'done', count: 1 });
		await send({ type: 'acpSignIn', agent: 'antigravity-acp', stage: 'browser-launch-error', browserError: 'late failure', url: 'https://example.test/stale' });
		assert(await page.eval(`!!document.querySelector('.signin-dlg .si-done') && !document.querySelector('.signin-dlg').textContent.includes('late failure')`), 'late browser results cannot overwrite a completed sign-in');
	} finally {
		await page.eval(`document.querySelector('.signin-dlg [data-si="close"]')?.click(); window.Settings.close(); window.Bridge.post = window.__oauthSmokePost; delete window.__oauthSmokePost; delete window.__oauthSmokeMessages;`);
	}
};
