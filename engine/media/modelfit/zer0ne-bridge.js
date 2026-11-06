/*
 * Models Fit Studio's page, inside zer0ne code (Settings → Local models).
 *
 * The page was written for a Windows host that answers over WebView2
 * (window.chrome.webview). Here the Settings page that frames it answers instead, with
 * zer0ne Engine behind it (engine/src/host/modelFitHost.ts): calls go up to it, replies
 * and pushed updates come back the same way. The page also takes zer0ne code's theme,
 * opens web links outside the app, and gets one more tab, "Engine & more".
 *
 * The page started as Models Fit Studio's own screen; zer0ne code now keeps it, and this
 * file is loaded in place of that app's inline theme script.
 */
(() => {
	'use strict';
	const root = document.documentElement;
	root.dataset.host = 'zer0ne';
	const origin = location.origin;
	const up = (data) => { try { parent.postMessage(data, origin); } catch { /* the frame was closed */ } };

	// ---- the host bridge
	const listeners = [];
	window.chrome = window.chrome || {};
	window.chrome.webview = {
		postMessage(msg) { up({ __modelfit: 'call', msg }); },
		addEventListener(type, fn) { if (type === 'message' && typeof fn === 'function') listeners.push(fn); },
		removeEventListener(type, fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }
	};
	window.addEventListener('message', (e) => {
		if (e.source !== parent || e.origin !== origin || !e.data || e.data.__modelfit !== 'reply') return;
		for (const fn of listeners.slice()) {
			try { fn({ data: e.data.msg }); } catch (err) { console.error(err); }
		}
	});

	// ---- zer0ne code's theme: its tokens become the page's own variables (zer0ne.css maps them)
	const TOKENS = {
		'--zc-bg': '--color-background', '--zc-panel': '--color-panel', '--zc-card': '--color-card', '--zc-card-hover': '--color-card-hover',
		'--zc-popover': '--color-popover', '--zc-input': '--color-input', '--zc-secondary': '--color-secondary',
		'--zc-border': '--color-border', '--zc-border-strong': '--color-border-strong',
		'--zc-fg': '--color-foreground', '--zc-muted': '--color-foreground-muted', '--zc-subtle': '--color-foreground-subtle',
		'--zc-accent': '--accent', '--zc-accent-strong': '--accent-strong', '--zc-accent-soft': '--accent-soft',
		'--zc-ok': '--color-success', '--zc-warn': '--color-warning', '--zc-bad': '--color-destructive',
		'--zc-font': '--font-sans', '--zc-mono': '--font-mono'
	};
	const rgb = (color) => {
		const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(color) || [];
		if (m.length) return [Number(m[1]), Number(m[2]), Number(m[3])];
		const hex = /^#([0-9a-f]{6})$/i.exec(String(color).trim());
		return hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) : null;
	};
	function paintTheme() {
		let host;
		try { host = parent.document.body; } catch { return; }
		if (!host) return;
		const cs = parent.getComputedStyle(host);
		for (const [mine, theirs] of Object.entries(TOKENS)) {
			const v = cs.getPropertyValue(theirs).trim();
			if (v) root.style.setProperty(mine, v);
		}
		const accent = rgb(cs.getPropertyValue('--accent').trim());
		if (accent) root.style.setProperty('--zc-accent-rgb', accent.join(', '));
		const bg = rgb(cs.getPropertyValue('--color-background').trim() || cs.backgroundColor);
		// Text on the accent colour: dark on a light accent, light on a dark one.
		if (accent) root.style.setProperty('--zc-on-accent', (accent[0] * 0.299 + accent[1] * 0.587 + accent[2] * 0.114) > 150 ? '#0b0d12' : '#ffffff');
		const light = bg ? (bg[0] * 0.299 + bg[1] * 0.587 + bg[2] * 0.114) > 150 : false;
		root.dataset.zcLight = light ? 'true' : 'false';
		root.style.colorScheme = light ? 'light' : 'dark';
	}
	paintTheme();
	try {
		new MutationObserver(paintTheme).observe(parent.document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-accent'] });
		new MutationObserver(paintTheme).observe(parent.document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
	} catch { /* not framed by Settings */ }

	// ---- web links open in the browser, never inside the app
	document.addEventListener('click', (e) => {
		const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
		if (!a || !/^https?:/i.test(a.getAttribute('href') || '')) return;
		e.preventDefault();
		up({ __modelfit: 'call', msg: { id: 0, cmd: 'openUrl', args: { url: a.href } } });
	}, true);

	// ---- "Engine & more": zer0ne Engine's settings, image / video / voice models and activity
	document.addEventListener('DOMContentLoaded', () => {
		const bar = document.getElementById('tabsBar');
		if (!bar || bar.querySelector('.zc-more')) return;
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'tab zc-more';
		b.title = 'zer0ne Engine settings, image, video and voice models, and activity';
		b.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg><span></span>';
		b.querySelector('span').textContent = 'Engine & more';
		// The page's own tab handler would hide every pane for a tab it does not know.
		b.addEventListener('click', (e) => { e.stopPropagation(); up({ __modelfit: 'more' }); });
		bar.appendChild(b);
		up({ __modelfit: 'ready' });
	});
})();
