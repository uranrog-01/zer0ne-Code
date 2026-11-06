/*
 * Applies Appearance settings (theme, accent, glow, density, text size,
 * background picture) and the interface language to <body>. Shared by
 * chat.js and settings.js.
 */
(function () {
	'use strict';
	// The removed 3D studio stored its options here; leave no dead preferences behind.
	try {
		localStorage.removeItem('zc.modern');
	} catch {
		/* storage can be unavailable */
	}
	const LIGHT_THEMES = new Set(['light', 'github-light', 'solarized-light', 'paper', 'latte', 'codex-light', 'claude-light', 'zcode-light']);
	const systemTheme = window.matchMedia?.('(prefers-color-scheme: light)');
	let lastSettings;
	systemTheme?.addEventListener('change', () => {
		if (lastSettings) window.applyAppearance(lastSettings);
	});

	/** #rrggbb mixed toward white by `k` (0–1). */
	function lighten(hex, k) {
		const n = parseInt(hex.slice(1), 16);
		const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * k));
		return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
	}
	function rgba(hex, a) {
		const n = parseInt(hex.slice(1), 16);
		return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
	}
	let bgImage = null;
	/** One write per page: an old "modern" theme id is reset to System, not just ignored. */
	let staleThemeFixed = false;
	/** Font choices (Settings → Appearance → Fonts); used only if installed. */
	const FONTS = {
		ui: {
			system: '',
			inter: '"Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
			segoe: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
			sf: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
			geist: '"Geist", "Inter", system-ui, sans-serif',
			plex: '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif',
			roboto: 'Roboto, "Segoe UI", system-ui, sans-serif',
			serif: '"Iowan Old Style", Charter, "Source Serif Pro", Georgia, serif',
			mono: 'var(--font-mono)'
		},
		code: {
			editor: '',
			cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
			jetbrains: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
			fira: '"Fira Code", "Cascadia Mono", Consolas, monospace',
			geist: '"Geist Mono", "JetBrains Mono", Consolas, monospace',
			plex: '"IBM Plex Mono", Consolas, monospace',
			sf: '"SF Mono", Menlo, Consolas, monospace',
			consolas: 'Consolas, "Courier New", monospace'
		}
	};
	window.APPEARANCE_FONTS = FONTS;
	const HEX = /^#[0-9a-f]{6}$/i;
	function mixHex(a, b, k) {
		const x = parseInt(a.slice(1), 16);
		const y = parseInt(b.slice(1), 16);
		const c = [16, 8, 0].map((s) => Math.round(((x >> s) & 255) + (((y >> s) & 255) - ((x >> s) & 255)) * k));
		return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
	}
	function luminance(hex) {
		const n = parseInt(hex.slice(1), 16);
		const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
		return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
	}
	/** Theme editor: background / foreground overrides derive the whole surface ramp. */
	function themeOverrides(s, body) {
		const bg = HEX.test(s.themeBackground || '') ? s.themeBackground : '';
		const lightBg = bg ? luminance(bg) > 0.179 : false;
		const fg = HEX.test(s.themeForeground || '') ? s.themeForeground : bg ? (lightBg ? '#000000' : '#ffffff') : '';
		const toward = fg || (lightBg ? '#000000' : '#ffffff');
		const vars = bg
			? [
					['--color-background', bg],
					['--color-panel', mixHex(bg, toward, 0.03)],
					['--color-card', mixHex(bg, toward, 0.06)],
					['--color-card-hover', mixHex(bg, toward, 0.09)],
					['--color-popover', mixHex(bg, toward, 0.07)],
					['--color-input', mixHex(bg, toward, 0.02)],
					['--color-secondary', mixHex(bg, toward, 0.11)],
					['--color-code-bg', mixHex(bg, lightBg ? '#000000' : '#000000', lightBg ? 0.03 : 0.2)]
				]
			: [];
		if (fg) {
			const n = parseInt(fg.slice(1), 16);
			const rgb = (n >> 16) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
			vars.push(['--color-foreground', fg], ['--color-foreground-muted', 'rgba(' + rgb + ', 0.76)'], ['--color-foreground-subtle', 'rgba(' + rgb + ', 0.68)'], ['--color-border', 'rgba(' + rgb + ', 0.15)'], ['--color-border-strong', 'rgba(' + rgb + ', 0.3)']);
		}
		const keys = ['--color-background', '--color-panel', '--color-card', '--color-card-hover', '--color-popover', '--color-input', '--color-secondary', '--color-code-bg', '--color-foreground', '--color-foreground-muted', '--color-foreground-subtle', '--color-border', '--color-border-strong'];
		const set = new Map(vars);
		for (const k of keys) {
			if (set.has(k)) body.style.setProperty(k, set.get(k));
			else body.style.removeProperty(k);
		}
		body.classList.toggle('theme-edited', !!(bg || fg));
		return bg ? lightBg : null;
	}
	function fonts(s, body) {
		const ui = FONTS.ui[s.fontUi] || '';
		const content = FONTS.ui[s.fontContent] || '';
		const code = FONTS.code[s.fontCode] || '';
		for (const [k, v] of [['--font-sans', ui], ['--font-content', content], ['--font-mono', code]]) {
			if (v) body.style.setProperty(k, v);
			else body.style.removeProperty(k);
		}
		const w = Number(s.fontWeight) || 400;
		if (w !== 400) body.style.setProperty('--font-weight', String(w));
		else body.style.removeProperty('--font-weight');
		// The code font size is a local display preference: the engine's settings do not carry
		// it, so the page's own state is where it comes from.
		const local = (window.Bridge && typeof window.Bridge.getState === 'function' ? window.Bridge.getState() : null) || {};
		const cs = Number(local.codeFontSize || s.codeFontSize) || 0;
		if (cs) body.style.setProperty('--code-font-size', cs + 'px');
		else body.style.removeProperty('--code-font-size');
		body.classList.toggle('font-content', !!content);
		// Serif answers get their own reading tune-up (chat.css: body.content-serif).
		body.classList.toggle('content-serif', s.fontContent === 'serif');
	}

	/** The picture behind the chat, if the user chose one (Terminal stays plain). */
	function backgroundFor(s, theme) {
		if (theme === 'terminal' || s.background !== 'image' || !bgImage) return {};
		return { image: bgImage, filter: s.backgroundFilter || 'none' };
	}

	window.applyAppearance = function (s) {
		s = s || {};
		lastSettings = s;
		const body = document.body;
		// A stored id from a removed shelf (the old modern themes, or LiquidMac) falls back to the base theme.
		const retired = s.theme && (String(s.theme).startsWith('modern-') || s.theme === 'liquidmac');
		if (!staleThemeFixed && retired) {
			staleThemeFixed = true;
			if (window.Bridge && typeof window.Bridge.post === 'function') window.Bridge.post({ type: 'updateSettings', patch: { theme: 'auto' } });
		}
		const theme = s.theme && s.theme !== 'auto' && !retired ? s.theme : '';
		// Desktop pages have no editor to update their base light/dark classes.
		if (window.__zcShell || window.Bridge?.desktop || window.Bridge?.desktopHost) {
			const light = theme ? LIGHT_THEMES.has(theme) : !!systemTheme?.matches;
			body.classList.toggle('vscode-light', light);
			body.classList.toggle('vscode-dark', !light);
		}
		if (theme) body.dataset.theme = theme;
		else delete body.dataset.theme;
		body.dataset.accent = s.accent || 'blue';
		body.dataset.glow = s.glow || 'subtle';
		const calm = s.motion === 'calm' ? 'calm' : 'full';
		if (body.dataset.motion !== calm) {
			body.dataset.motion = calm;
			// Decorative canvas loops follow the setting without waiting for a reload.
			window.dispatchEvent(new Event('zc-motion-change'));
		}
		body.dataset.density = s.density || 'comfortable';
		body.dataset.fxScope = s.backgroundScope || 'all';
		body.dataset.terminalEffects = s.terminalEffects === 'retro' ? 'retro' : 'off';
		body.dataset.terminalProse = s.terminalProse === 'reading' ? 'reading' : 'mono';
		body.dataset.terminalCursor = ['bar', 'underline'].includes(s.terminalCursorStyle) ? s.terminalCursorStyle : 'block';
		body.dataset.terminalBlink = s.terminalCursorBlink === false ? 'off' : 'on';
		body.dataset.terminalScreenReader = String(s.terminalScreenReader === true);
		body.style.setProperty('--terminal-font-size', Number(s.terminalFontSize) > 0 ? Math.min(24, Math.max(10, Number(s.terminalFontSize))) + 'px' : 'var(--code-font-size, 13px)');
		body.style.setProperty('--terminal-line-height', String(Math.min(2, Math.max(1, Number(s.terminalLineHeight) || 1.3))));
		// Custom accent / palettes win over every theme (inline custom properties).
		const custom = s.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(s.accentColor || '') ? s.accentColor : '';
		for (const [k, v] of [
			['--accent', custom],
			['--accent-strong', custom && lighten(custom, 0.25)],
			['--accent-soft', custom && rgba(custom, 0.15)],
			['--fx-1', custom],
			['--fx-2', custom && (s.accentColor2 || lighten(custom, 0.45))]
		]) {
			if (v) body.style.setProperty(k, v);
			else body.style.removeProperty(k);
		}
		if (custom && s.accentColor2) body.style.setProperty('--accent-2', s.accentColor2);
		else body.style.removeProperty('--accent-2');
		// Glow intensity (0–100); "off" falls back to the stylesheet's 0.
		if (s.glow !== 'off' && typeof s.glowStrength === 'number') body.style.setProperty('--glow-strength', String(s.glowStrength / 100));
		else body.style.removeProperty('--glow-strength');
		body.dataset.glowColor = s.glowColor === 'accent' || s.glowColor === 'custom' ? s.glowColor : 'metallic';
		// Prism: two tones (custom) — the third stop is their blend.
		if (s.glowColor === 'custom' && HEX.test(s.glowTone1 || '') && HEX.test(s.glowTone2 || '')) {
			body.style.setProperty('--glow-1', s.glowTone1);
			body.style.setProperty('--glow-2', s.glowTone2);
			body.style.setProperty('--glow-3', mixHex(s.glowTone1, s.glowTone2, 0.5));
		} else for (const k of ['--glow-1', '--glow-2', '--glow-3']) body.style.removeProperty(k);
		body.classList.toggle('reveal', s.textReveal === 'on');
		body.style.setProperty('--ui-font-size', (s.uiFontSize || 13) + 'px');
		const edited = themeOverrides(s, body);
		fonts(s, body);
		body.classList.toggle('is-light', edited !== null ? edited : theme ? LIGHT_THEMES.has(theme) : body.classList.contains('vscode-light'));
		body.classList.toggle('glass', s.glass !== false);
		if (window.I18N) window.I18N.setLanguage(s.language || 'en');
		if (window.Effects) {
			const app = document.getElementById('app');
			const bg = backgroundFor(s, theme);
			// "New chat only": hide the picture while a conversation is open.
			const isEmpty = !app || app.classList.contains('is-empty');
			const active = s.backgroundScope !== 'empty' || isEmpty;
			const filament = theme !== 'terminal' && isEmpty && !bg.image;
			window.Effects.set({ image: bg.image, filter: bg.filter, opacity: s.backgroundOpacity ?? 60, active, filament });
		}
	};

	/** The host sends the picture once (data: URL); re-apply with the last settings. */
	window.getBackgroundImage = () => bgImage;
	window.setBackgroundImage = function (data, settings) {
		bgImage = data || null;
		window.applyAppearance(settings);
	};
})();
