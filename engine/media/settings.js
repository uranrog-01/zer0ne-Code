/*
 * Settings popup — opens over the chat column (no separate editor tab).
 * Pages: General, Appearance, Providers & models, Browser use, Agent,
 * Features & plugins, MCP servers, Skills, Memory, Mobile remote, Usage.
 *
 * Shares the host connection with chat.js through window.Bridge and reads
 * the same `state` snapshots. Re-rendering is skipped when the relevant
 * state is unchanged, and the focused field (value + caret) survives
 * re-renders, so typing is never interrupted.
 */
(function () {
	'use strict';

	const B = window.Bridge;
	const I = window.Icons.svg;
	const post = (m) => B.post(m);
	window.ComputerUse?.create({B,I});
	const tr = (k, v) => (window.t ? window.t(k, v) : k);
	const standalone = document.body.classList.contains('settings-standalone');
	let toastTimer;
	const toast = (m, k) => {
		if (window.UI) return window.UI.toast(m, k);
		const el2 = document.getElementById('toast');
		if (!el2 || !m) return;
		el2.className = 'toast ' + (k || '');
		el2.innerHTML = I(k === 'error' || k === 'warn' ? 'alert' : k === 'ok' ? 'check' : 'info') + '<span>' + String(m).replace(/</g, '&lt;') + '</span>';
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el2.classList.add('hidden'), k === 'error' ? 7000 : k === 'warn' ? 5000 : 3500);
	};
	const persisted = B.getState();
	const desktopHost = () => B.desktop || B.desktopHost || S.capabilities?.id === 'desktop';

	const S = {
		open: false,
		section: persisted.settingsSection || 'models',
		generalPage: persisted.generalPage || 'language',
		hooksMemoryTab: persisted.hooksMemoryTab === 'memory' ? 'memory' : 'hooks',
		version: '',
		editingId: persisted.editingId,
		addingProvider: false,
		presetInfo: null,
		catalogQuery: '',
		memFilter: '',
		catalogItems: null,
		providers: [],
		selection: {},
		settings: {},
		featureCatalog: [],
		featureRevision: 0,
		featureReports: [],
		memories: [],
		memoryDuplicates: [],
		pinnedSkills: [],
		currentSessionId: undefined,
		mcp: [],
		skills: [],

		modAudit: {},
		remote: {},
		presets: [],
		browser: {},
		isRemote: B.remote,
		usage: null,
		usageDays: persisted.usageDays || 30,
		usagePages: { models: 1, budgets: 1, related: 1 },
		usageTab: ['overview', 'models', 'budgets'].includes(persisted.usageTab) ? persisted.usageTab : 'overview',
		usageQuery: { models: '', budgets: '' },
		usageSort: { models: 'tokens', budgets: 'usage' },
		usageDetail: null,
		usageExporting: false,
		tests: {},
		fetching: null,
		keyVisible: false,
		sig: ''
	};

	// Retired rail entries live on inside merged pages; old ids and the chat's
	// deep links (openSettings('hooks'), …) resolve to the merged page with the
	// right tab preselected.
	const SECTION_ALIASES = { subagents: 'agent', hooks: 'hooks-memory', skills: 'plugins', schedule: 'cloud', cloud: 'cloud' };
	function normalizeSection(section) {
		if (desktopHost()) {
			if (section === 'notch') { S.generalPage = 'notch'; return 'general'; }
			if (section === 'hooks' || section === 'memory') { S.hooksMemoryTab = section; return 'hooks-memory'; }
			// Scheduled tasks stay off on desktop; their page opens on Cloud tasks.
			if (['tasks', 'schedule', 'cloud'].includes(section)) return 'cloud';
			if (['finder', 'cli', 'telegram', 'mods'].includes(section)) return 'models';
		}
		const to = SECTION_ALIASES[section];
		if (!to) return section;
		if (to === 'agent') S.agentTab = 'subagents';
		
		else if (to === 'plugins') S.psTab = 'skills';
		
		return to;
	}
	S.section = normalizeSection(S.section);

	const SIMPLE_SECTIONS = new Set(['general', 'appearance', 'models', 'agent', 'memory', 'hooks-memory', 'remote', 'usage', 'about']);
	const simpleView = () => !!(S.settings && S.settings.uiMode === 'simple');
	const NAV = (all = false) => [
		[tr('groupBasics'), [['general', 'sliders', tr('general')], ['appearance', 'palette', tr('appearance')], ['models', 'cube', tr('modelSettings')], ['local', 'cpu', tr('localModels')]]],
		[tr('groupAgent'), [['browser', 'globe', tr('browserUse')], ['agent', 'agent', 'Agent'], ['memory', 'memory', tr('memory')], ['features', 'zap', tr('features')], ['plugins', 'puzzle', 'Plugins & Skills'], ['mcp', 'server', tr('mcpServers')], ['cloud', 'cloud', 'Cloud tasks']]],
		[tr('groupConnect'), [['remote', 'phone', tr('mobileRemote')], ]],
		[tr('groupData'), [['usage', 'chart', tr('usageStats')]]],
		// No group header: About sits alone at the bottom of the rail.
		['', [['about', 'info', 'About']]]
	].map(([group, items]) => [group, desktopHost() ? items.filter(([id]) => !['finder','cli','mods'].includes(id)).map(([id, icon, label]) => id === 'memory' ? ['hooks-memory', 'memory', 'Hooks & Memory'] : id === 'tasks' ? ['cloud', 'cloud', 'Cloud tasks'] : [id, icon, label]) : items])
		// Simple view: the essentials; the page you are on stays reachable, and search finds the rest.
		.map(([group, items]) => [group, !all && simpleView() ? items.filter(([id]) => SIMPLE_SECTIONS.has(id) || id === S.section) : items])
		.filter(([, items]) => items.length);

	const $ = (id) => document.getElementById(id);
	const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	/** Only these vendor recovery links become actions in an account error. */
	const VERIFY_LINK = /\[([^\]]{1,40})\]\((https:\/\/(?:accounts\.google\.com\/[^)\s]+|myaccount\.google\.com\/security|antigravity\.google\/docs\/faq))\)/g;
	const errorText = (s) => esc(String(s || '').replace(VERIFY_LINK, '$1')).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
	const verifyButton = (s) => {
		return Array.from(String(s || '').matchAll(VERIFY_LINK), (m) => '<button class="btn btn-primary btn-sm" data-act="open-url" data-url="' + esc(m[2]) + '">' + I('shield') + esc(m[1]) + '</button>' + (m[2].startsWith('https://accounts.google.com/') ? ' <button class="btn btn-ghost btn-sm" data-act="copy-verification-url" data-url="' + esc(m[2]) + '">' + I('copy') + 'Copy verification link</button>' : '')).join(' ');
	};
	const h = (tag, cls, html) => {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (html !== undefined) n.innerHTML = html;
		return n;
	};
	const persist = () => B.patchState({ settingsSection: S.section, generalPage: S.generalPage, hooksMemoryTab: S.hooksMemoryTab, editingId: S.editingId, usageDays: S.usageDays, usageTab: S.usageTab });

	/**
	 * The code font size is a local display preference: the engine's settings do not carry it,
	 * so it lives in the page's own state (and is applied from there by appearance.js).
	 */
	function localCodeFontSize() {
		const v = Number((B.getState() || {}).codeFontSize);
		return Number.isFinite(v) && v >= 10 && v <= 20 ? v : 0;
	}
	/** Keeps the local code font size and shows it at once. */
	function setLocalCodeFontSize(value) {
		const v = Math.min(20, Math.max(10, Math.round(Number(value) || 12)));
		B.patchState({ codeFontSize: v });
		document.body.style.setProperty('--code-font-size', v + 'px');
		const reset = document.querySelector('[data-act="theme-reset"]');
		if (reset) reset.hidden = !appearanceEdited(S.settings) && S.settings.accent === 'blue';
		return v;
	}
	function appearanceEdited(st) {
		return !!(st.themeBackground || st.themeForeground || (st.fontUi || 'system') !== 'system' || (st.fontContent || 'system') !== 'system' || (st.fontCode || 'editor') !== 'editor' || (st.fontWeight || 400) !== 400 || (st.uiFontSize || 13) !== 13 || (localCodeFontSize() || st.codeFontSize || 12) !== 12);
	}

	function fmtTokens(n) {
		if (!n) return '0';
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 || n % 1e6 === 0 ? 0 : 1) + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 || n % 1e3 === 0 ? 0 : 1) + 'K';
		return String(n);
	}
	const providerById = (id) => S.providers.find((p) => p.id === id);
	const presetById = (id) => S.presets.find((p) => p.id === id) || acpPreset(id);
	/** A plan agent (Claude, Antigravity, Cursor…) looks like a preset to the rail and the detail page: its tile and name. */
	function acpPreset(id) {
		const c = /^acp:/.test(id || '') && (S.acpCards || []).find((x) => 'acp:' + x.id === id);
		return c ? { id, name: c.name, tile: c.tile, plans: c.plans, desc: c.desc, kind: 'acp', manageUrl: c.manageUrl } : undefined;
	}
	const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i;
	const isLocal = (p) => LOOPBACK.test(p.baseUrl || '');
	/** http:// to a public host: a key sent there travels unencrypted (LAN, .local and Tailscale names are fine). Same rule as the host. */
	function insecureRemote(url) {
		try {
			const u = new URL(url);
			const host = u.hostname.replace(/^\[|\]$/g, '');
			if (u.protocol !== 'http:' || LOOPBACK.test(url) || (!host.includes('.') && !host.includes(':'))) return false;
			return !(/^(10\.|192\.168\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host) || /^(fc|fd|fe80)/i.test(host) || /\.(local|lan|internal|home|ts\.net|localdomain)$/i.test(host));
		} catch {
			return false;
		}
	}
	/** Local servers, VS Code models and cloud logins need no pasted key (same rule as the host). */
	const keyOptional = (p) => p.apiFormat === 'vscode-lm' || p.apiFormat === 'acp' || p.apiFormat === 'vertex' || p.apiFormat === 'bedrock' || p.auth === 'vscode' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(p.baseUrl || '');

	function statusDot(p) {
		if (!p.enabled) return '';
		// The last real answer wins: a failed sign-in / verification / credits check is red until it works again.
		if (p.health && !p.health.ok) return 'red';
		const ready = (p.apiFormat === 'vscode-lm' || p.apiFormat === 'acp' || (p.baseUrl && (p.hasKey || isLocal(p)))) && p.models.some((m) => m.enabled);
		return ready ? 'green' : 'orange';
	}

	function tile(preset, fallbackText) {
		const t = preset ? preset.tile : { text: (fallbackText || '?').slice(0, 2), bg: 'var(--color-secondary)' };
		const span = '<span class="ptile" data-bg="' + esc(t.bg) + '" data-fg="' + esc(t.fg || '#fff') + '">' + esc(t.text) + '</span>';
		return span;
	}
	/** Tile colors are applied through CSSOM (the webview CSP forbids inline style attributes). */
	function paintTiles(root) {
		for (const t of root.querySelectorAll('.ptile[data-bg]')) {
			t.style.background = t.dataset.bg;
			t.style.color = t.dataset.fg;
		}
		for (const t of root.querySelectorAll('[data-swatch]')) t.style.background = t.dataset.swatch;
		paintBars(root);
	}
	function paintBars(root) {
		for (const b of (root || document).querySelectorAll('.pull-bar > span[data-width], .tb-fill[data-width], .usage-share-fill[data-width], .budget-fill[data-width]')) b.style.width = b.dataset.width + '%';
	}

	// ------------------------------------------------------------ open / close

	function mount() {
		const root = $('settings-root');
		if (root.querySelector('.settings-overlay')) return;
		root.innerHTML =
			'<div class="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings"><div class="settings-panel">' +
			'<nav class="settings-nav" id="s-nav"></nav><div class="settings-content"><div id="settings-search-slot"></div><main class="settings-main" id="s-page"></main></div>' +
			'<button class="icon-btn settings-close" data-act="close-settings" title="Close (Esc)" aria-label="Close settings">' + I('close') + '</button>' +
			'</div></div>';
		const overlay = root.querySelector('.settings-overlay');
		if (window.SettingsFinder) $('settings-search-slot').appendChild(window.SettingsFinder.create(settingsSearchEntries, openSearchSetting));
		overlay.addEventListener('keydown', event => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); overlay.querySelector('.settings-search input')?.focus(); }
		});
		overlay.addEventListener('mousedown', (e) => {
			if (e.target === overlay) close();
		});
		bindPage($('s-page'));
		$('s-nav').addEventListener('click', (e) => {
			const b = e.target.closest('[data-nav]');
			if (b) navigate(b.dataset.nav);
			else if (e.target.closest('[data-act="ui-pro"]')) post({ type: 'updateSettings', patch: { uiMode: 'pro' } });
		});
		root.querySelector('[data-act="close-settings"]').addEventListener('click', close);
		root.querySelector('[data-act="close-settings"]').title = tr('close') + ' (Esc)';
	}

	function open(section) {
		if (section) S.section = normalizeSection(section);
		if (S.section === 'cloud') { S.cloud = null; S.cloudAsked = false; }
		S.open = true;
		// The project's rules file can change between visits.
		S.commandRulesAsked = false;
		mount();
		$('settings-root').querySelector('.settings-overlay')?.classList.remove('closing');
		renderNav();
		renderPage(true);
		post({ type: 'ready' }); // refresh: statuses (MCP, remote, browser) may have changed
		if (S.section === 'usage') post({ type: 'getUsage', days: S.usageDays });
	}

	function close() {
		S.open = false;
		if (S.liveOn) { S.liveOn = false; post({type:'localLive',on:false}); }
		S.featureLoaded = false;
		clearInterval(S.featureTick); S.featureTick = null;
		clearTimeout(S.featureHealthTimer); if (S.healthBusy) post({type:'featuresCancel'});
		S.healthBusy = false; S.featureHealthId = null;
		const overlay = document.querySelector('#settings-root .settings-overlay');
		if (!overlay) return;
		if (standalone) {
			overlay.classList.add('closing');
			setTimeout(() => post({ type: 'closeSettings' }), 150);
			return;
		}
		overlay.classList.add('closing');
		setTimeout(() => {
			if (!S.open && overlay === $('settings-root').querySelector('.settings-overlay')) overlay.remove();
		}, 160);
	}

	// The preview uses the same focus and Enter bursts as the composer.
	function touchGlowDemo(e) {
		const demo = e.target instanceof Element && e.target.closest('#glow-demo');
		if (!demo || demo.classList.contains('sweep') || demo.classList.contains('touch')) return;
		demo.classList.add('touch');
		window.ComposerBeam?.flash(demo, 'touch');
		setTimeout(() => demo.classList.remove('touch'), 2600);
	}
	document.addEventListener('pointerdown', touchGlowDemo);
	document.addEventListener('focusin', touchGlowDemo);
	document.addEventListener('keydown', (e) => {
		const demo = e.target instanceof Element && e.target.id === 'glow-demo' ? e.target : null;
		if (!demo || e.key === 'Escape' || e.key === 'Tab') return;
		e.preventDefault();
		if (e.key !== 'Enter') return;
		window.ComposerBeam?.flash(demo, 'sweep');
		demo.classList.remove('sweep', 'touch');
		void demo.offsetWidth;
		demo.classList.add('sweep');
		clearTimeout(demo.__sweep);
		demo.__sweep = setTimeout(() => demo.classList.remove('sweep'), 2600);
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && S.open && !document.querySelector('#dialog-root .overlay')) {
			e.stopPropagation();
			close();
		}
	});

	function settingsSearchEntries() {
		const sections = NAV(true).flatMap(([, items]) => items).filter(([id]) => !(id === 'remote' && S.isRemote));
		const label = id => sections.find(([key]) => key === id)?.[2] || id;
		const entries = sections.map(([section, name]) => ({ section, label: name, breadcrumb: 'Settings', description: name }));
		for (const [generalPage, name, description] of generalPages()) entries.push({ section: 'general', generalPage, label: name, description, breadcrumb: label('general') });
		if (desktopHost()) entries.push(...hooksMemorySearchEntries());
		for (const entry of window.SettingsIndex || []) {
			const section = desktopHost() && ['hooks', 'memory'].includes(entry.section) ? 'hooks-memory' : desktopHost() && entry.section === 'skills' ? 'plugins' : entry.section;
			if (!sections.some(([id]) => id === section) && !['skills'].includes(entry.section)) continue;
			const name = entry.labelKey ? tr(entry.labelKey) : entry.label;
			entries.push({ ...entry, section, ...(section === 'hooks-memory' ? { hooksMemoryTab: entry.section } : {}), label: name, breadcrumb: label(section) + (entry.generalPage ? ' › ' + (generalPages().find(([id]) => id === entry.generalPage)?.[1] || entry.generalPage) : '') });
		}
		for (const feature of S.featureCatalog || []) entries.push({ section: 'features', key: feature.key, label: feature.name, description: feature.description, breadcrumb: label('features') });
		return entries;
	}
	function openSearchSetting(entry) {
		if (entry.hooksMemoryTab) S.hooksMemoryTab = entry.hooksMemoryTab;
		if (entry.generalPage) S.generalPage = entry.generalPage;
		if (entry.section === 'agent') S.agentTab = entry.agentTab || 'behavior';
		if (entry.section === 'features' && entry.key) { S.featureTab = 'capabilities'; S.featureFilter = 'all'; S.featureQuery = entry.label; }
		navigate(entry.section);
		if (entry.section === 'local' && entry.key) { S.localView = 'more'; S.localTab = entry.localTab || 'runtimes'; renderPage(true); }
		const page = $('s-page');
		const target = entry.key && [...page.querySelectorAll('[data-setting]')].find(control => control.dataset.setting === entry.key);
		const row = target?.closest('.setting-row, .feature-card, .card') || page.querySelector('.page-title');
		if (row) { for (let parent = row.parentElement; parent && parent !== page; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true; row.classList.add('settings-search-hit'); row.tabIndex = -1; (target || row).focus({ preventScroll: true }); row.scrollIntoView?.({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
	}
	function renderNav() {
		const nav = $('s-nav');
		if (!nav) return;
		let html = '<div class="nav-brand"><span class="brand-logo"></span><span>' + esc(tr('settings')) + '</span></div>';
		for (const [group, items] of NAV()) {
			if (group) html += '<div class="nav-group">' + esc(group) + '</div>';
			for (const [id, icon, label] of items) {
				if (id === 'remote' && S.isRemote) continue;
				html += '<button class="nav-item' + (S.section === id ? ' active' : '') + '" data-nav="' + id + '" title="' + esc(label) + '">' + I(icon) + '<span>' + esc(label) + '</span></button>';
			}
		}
		if (simpleView()) html += '<button class="nav-item nav-all" data-act="ui-pro" title="Show every settings page">' + I('plus') + '<span>All settings</span></button>';
		nav.innerHTML = html;
	}

	function navigate(section) {
		clearInterval(S.featureTick); S.featureTick = null;
		S.section = normalizeSection(section);
		if (S.section === 'cloud') { S.cloud = null; S.cloudAsked = false; }
		S.addingProvider = false;
		S.presetInfo = null;
		// Local models opens on Models Fit Studio's page, also after Engine & more.
		if (S.section === 'local') S.localView = 'models';
		persist();
		renderNav();
		renderPage(true);
		if (section === 'usage') post({ type: 'getUsage', days: S.usageDays });
		$('s-page').scrollTop = 0;
	}

	// ------------------------------------------------------------ page render

	function renderPage(force) {
		if (S.featureComposing && !force) { S.featureRenderPending = true; return; }
		const page = $('s-page');
		if (!page) return;
		// Models Fit Studio's page keeps its own state: re-rendering would reload it. Only a real navigation does.
		if (!force && S.open && S.section === 'local' && (S.localView || 'models') === 'models' && page.querySelector('.mfs-frame')) return;
		// Keep one sampling interval while Activity is visible; restarting it loses the CPU baseline.
		const viewingActivity = S.open && S.section === 'local' && (S.localView || 'models') !== 'models' && ['activity', 'overview', 'advanced', 'downloads'].includes(S.localTab);
		if (S.liveOn && !viewingActivity) {
			S.liveOn = false;
			post({ type: 'localLive', on: false });
		}
		const active = document.activeElement;
		const keep = active && active.id && page.contains(active) ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
		const scroll = page.scrollTop;
		const detail = page.querySelector('.provider-detail');
		const detailScroll = detail ? detail.scrollTop : 0;
		const openDetails = [...page.querySelectorAll('details[data-key][open]')].map((d) => d.dataset.key);
		const inner = [...page.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
		const pages = { general: generalPage, appearance: appearancePage, local: localModelsPage, cloud: cloudPage, browser: browserPage, agent: agentPage, subagents: agentPage, features: featuresPage, plugins: pluginsSkillsPage, skills: pluginsSkillsPage, hooks: hooksMemoryPage, mcp: mcpPage, memory: memoryPage, 'hooks-memory': hooksMemoryPage, remote: remotePage, usage: usagePage, about: aboutPage };
		page.replaceChildren((pages[S.section] || modelsPage)());
		paintTiles(page);
		if (!force) page.scrollTop = scroll;
		const d2 = page.querySelector('.provider-detail');
		if (d2 && !force) d2.scrollTop = detailScroll;
		for (const [key, top] of inner) {
			const el = page.querySelector('[data-scroll="' + key + '"]');
			if (el) el.scrollTop = top;
		}
		for (const key of openDetails) {
			const d = page.querySelector('details[data-key="' + key + '"]');
			if (d) d.open = true;
		}
		if (keep) {
			const again = document.getElementById(keep.id);
			if (again) {
				if (typeof keep.value === 'string' && again.value !== keep.value && again.type !== 'checkbox' && again.type !== 'range') again.value = keep.value;
				again.focus();
				try {
					if (keep.start != null) again.setSelectionRange(keep.start, keep.end);
				} catch {
					/* not a text input */
				}
			}
		}
		if (S.section === 'usage') drawChart();
		if (S.section === 'appearance') startPreviews(page);
		if (S.section === 'local' && !S.localModels && !S.localLoading) {
			S.localLoading = true;
			post({ type: 'localModels' });
		}
	}

	function header(title, desc, actions) {
		const wrap = h('div');
		wrap.appendChild(h('h1', 'page-title', esc(title)));
		const bar = h('div', 'page-toolbar', '<p class="page-desc">' + desc + '</p>');
		if (actions) bar.insertAdjacentHTML('beforeend', actions);
		wrap.appendChild(bar);
		return wrap;
	}

	function sw(key, disabled) {
		return '<label class="switch"><input type="checkbox" id="s-' + key + '" data-setting="' + key + '"' + (S.settings[key] ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="track"></span></label>';
	}
	/**
	 * Settings → Notch (desktop): a live look at the pill, when it shows, which phases it
	 * shows and where alerts go. Its notifications share the bell's read state and mute.
	 */
	
	function switchRow(name, desc, key, disabled) {
		return '<div class="setting-row"><div class="text"><div class="name">' + name + '</div><div class="desc">' + desc + '</div></div><div class="control">' + sw(key, disabled) + '</div></div>';
	}
	function selectRow(name, desc, key, options) {
		return (
			'<div class="setting-row"><div class="text"><div class="name">' + name + '</div><div class="desc">' + desc + '</div></div><div class="control"><select id="s-' + key + '" class="select" data-setting="' + key + '">' +
			options.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(S.settings[key]) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('') +
			'</select></div></div>'
		);
	}

	/** Credentials tools commonly keep in the home folder: the first paths worth blocking in the sandbox. */
	const DENY_RECOMMENDED = ['~/.ssh', '~/.aws', '~/.config/gcloud', '~/.azure', '~/.kube', '~/.netrc', '~/.git-credentials'];

	const { generalPages, generalPage } = window.SettingsGeneral.create({ I, S, desktopHost, esc, h, header, healthPanel, segmented, selectRow, sw, switchRow, tr });
	// ------------------------------------------------------------ General

	// ------------------------------------------------------------ About

	/** The About page's end credits: what zer0ne coding does, the way a film's credits roll. */
	const CREDITS = [
		['Starring', [
			['The Agent', 'reads, edits, runs and verifies — you approve every change'],
			['Checkpoints & Undo', 'every turn restorable, file by file'],
			['Plan mode', 'a read-only look before anything changes']
		]],
		['Featuring the subagents', [
			['Explore', 'the fast scout'],
			['Plan', 'the architect'],
			['reviewer', 'the second pair of eyes'],
			['general-purpose', 'the worker'],
			['Isolated writers', 'parallel edits in their own git worktrees']
		]],
		['Any model', [
			['Cloud APIs', 'Anthropic, OpenAI, Google, DeepSeek, Z.ai and more'],
			['Coding plans', 'signed in through the vendors’ own agents'],
			['zer0ne Engine', 'local GGUF models on llama.cpp']
		]],
		['Tools & reach', [
			['MCP servers', 'outside tools, one click away'],
			['Skills & plugins', 'playbooks the agent loads on demand'],
			['Browser agent', 'tests the web app it just changed'],
			['Command sandbox', 'writes stay inside the workspace'],
			['Scheduled & cloud tasks', 'work that runs by itself'],
			['Mobile Remote', 'the chat on your phone']
		]],
		['Keeping it lean', [
			['RTK Token Saver', 'noisy output, compressed'],
			['Prompt cache', 'kept warm, never broken'],
			['Auto Compact', 'long sessions that keep going'],
			['Usage stats', 'every token and dollar accounted for']
		]],
		['The workflow', [
			['I.', 'Pick a model'],
			['II.', 'Ask — or plan first'],
			['III.', 'Delegate to subagents'],
			['IV.', 'Approve the edits'],
			['V.', 'Verify with diagnostics and tests'],
			['VI.', 'Undo anything, any time']
		]],
		['With thanks to', [
			['llama.cpp', 'the engine under the engine'],
			['Model Context Protocol', 'the open tool standard']
		]]
	];
	const GITHUB = 'https://github.com/uranrog-01';

	function aboutPage() {
		if (desktopHost()) {
			const page = h('div', 'page about-page about-desktop');
			page.appendChild(header('About', 'Your coding workspace, connected.'));
			page.appendChild(h('section', 'card about-hero',
				'<span class="brand-logo about-logo" aria-hidden="true"></span><div class="about-kicker">DESKTOP WORKSPACE</div><h2 class="about-name">zer0ne Code</h2>' +
				'<p class="about-tagline">From the first idea to verified code. An AI coding agent built around your project folders.</p>' +
				'<div class="about-meta"><span class="badge">Version ' + esc(window.__zcShell?.boot?.appVersion || S.version || '—') + '</span><span class="badge">Engine ' + esc(S.version || '—') + '</span><span class="about-author">Made by <b>zer0ne</b></span></div>' +
				'<div class="about-links"><button class="btn btn-secondary btn-sm" data-nav-to="features">' + I('zap') + 'Explore features</button><button class="btn btn-ghost btn-sm" data-nav-to="remote">' + I('phone') + 'Set up Remote</button></div>'));
			page.appendChild(h('div', 'about-capabilities', [
				['folder', 'One workspace for every project', 'Keep files, chats and terminal commands together. Switch projects while active sessions continue working.'],
				['agent', 'Your models. Your workflow.', 'Connect a cloud API, a coding plan or a local model. Add subagents, skills and MCP tools to fit the work.'],
				['shield', 'Review with confidence', 'Inspect changes, run checks and use checkpoints to undo edits. Keep control through permissions and approvals.'],
				['phone', 'Stay connected', 'Pair your phone with Remote. Open project folders in your editor and preview local apps in dedicated windows.']
			].map(([icon, title, copy]) => '<section class="card about-capability"><span class="about-feature-icon">' + I(icon) + '</span><h3>' + title + '</h3><p>' + copy + '</p></section>').join('')));
			page.appendChild(h('footer', 'about-footer', '<span>Built for focused, everyday development.</span><span>© ' + new Date().getFullYear() + ' zer0ne</span>'));
			return page;
		}
		const root = h('div', 'page about-page');
		root.appendChild(header('About', 'What you are running and who made it.'));
		const v = esc(S.version || '?');
		root.appendChild(
			h(
				'div',
				'card about-hero',
				'<span class="brand-logo about-logo" aria-hidden="true"></span>' +
					'<div class="about-kicker">A zer0ne production</div>' +
					'<div class="about-name">zer0ne coding</div>' +
					'<p class="about-tagline">An AI coding agent for your project folders — any model: cloud APIs, coding plans or local GGUF models on the zer0ne Engine.</p>' +
					'<div class="about-meta"><span class="badge">Version ' + v + '</span><span class="about-dot" aria-hidden="true"></span><span class="about-author">Made by <b>zer0ne</b></span></div>' +
					'<div class="about-links"><button class="btn btn-secondary btn-sm about-gh" data-act="open-url" data-url="' + GITHUB + '" title="' + GITHUB + '">' + GITHUB_ICON + 'github.com/uranrog-01</button>' +
					'<button class="btn btn-ghost btn-sm" data-act="credits-replay" title="Roll the credits again">' + I('refresh') + 'Roll credits</button></div>'
			)
		);
		const rows = CREDITS.map(([title, list]) =>
			'<section class="cr-block"><h3>' + esc(title) + '</h3>' + list.map(([role, what]) => '<div class="cr-row"><span class="cr-role">' + esc(role) + '</span><span class="cr-what">' + esc(what) + '</span></div>').join('') + '</section>'
		).join('');
		const screen = h(
			'div',
			'about-credits',
			'<div class="cr-grain" aria-hidden="true"></div>' +
				'<div class="cr-roll" role="list" aria-label="Credits">' +
				'<div class="cr-open"><span class="cr-small">zer0ne presents</span><span class="cr-title">zer0ne coding</span><span class="cr-small">an AI coding agent for every model</span></div>' +
				rows +
				'<div class="cr-end"><span class="cr-small">Written, designed &amp; directed by</span><span class="cr-title sm">zer0ne</span><span class="cr-gh">github.com/uranrog-01</span><span class="cr-small">Version ' + v + ' · © ' + new Date().getFullYear() + '</span><span class="cr-fin">The End</span></div>' +
				'</div>' +
				'<div class="cr-bars" aria-hidden="true"></div>'
		);
		root.appendChild(screen);
		// Keep the roll going across re-renders (settings state pushes redraw the page).
		const start = () => {
			const roll = screen.querySelector('.cr-roll');
			if (!roll || !roll.isConnected || screen.classList.contains('rolling')) return;
			const dur = Math.max(30, Math.round((roll.offsetHeight + screen.offsetHeight) / 44));
			if (!S.creditsAt) S.creditsAt = Date.now();
			roll.style.animationDuration = dur + 's';
			roll.style.animationDelay = '-' + (((Date.now() - S.creditsAt) / 1000) % dur).toFixed(2) + 's';
			screen.classList.add('rolling');
		};
		requestAnimationFrame(start);
		setTimeout(start, 60); // rAF waits while the panel is hidden
		return root;
	}
	const GITHUB_ICON = '<svg class="i" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

	// ------------------------------------------------------------ Appearance

	/** 16 classic themes: [id, name, description, [bg, card, fg]] */
	const THEMES = [
		['zai-dark', 'Zai Dark', 'ZCode default', ['#161616', '#2b2b2b', '#ffffff']],
		['midnight', 'Midnight', 'Deep navy', ['#0b1020', '#141c34', '#e2e8f8']],
		['tokyo-night', 'Tokyo Night', 'Neon dusk', ['#1a1b26', '#24283b', '#c0caf5']],
		['dracula', 'Dracula', 'Classic purple', ['#282a36', '#44475a', '#f8f8f2']],
		['catppuccin', 'Catppuccin', 'Mocha pastel', ['#1e1e2e', '#313244', '#cdd6f4']],
		['nord', 'Nord', 'Arctic calm', ['#2e3440', '#3b4252', '#eceff4']],
		['one-dark', 'One Dark', 'Atom classic', ['#21252b', '#282c34', '#d7dae0']],
		['github-dark', 'GitHub Dark', 'Crisp dark', ['#0d1117', '#161b22', '#e6edf3']],
		['rose-pine', 'Rosé Pine', 'Soho vibes', ['#191724', '#26233a', '#e0def4']],
		['gruvbox', 'Gruvbox', 'Retro groove', ['#282828', '#3c3836', '#ebdbb2']],
		['monokai', 'Monokai', 'The Sublime classic', ['#272822', '#34352d', '#f8f8f2']],
		['kanagawa', 'Kanagawa', 'Wave-painted ink', ['#1f1f28', '#2a2a37', '#dcd7ba']],
		['github-light', 'GitHub Light', 'Clean light', ['#ffffff', '#f6f8fa', '#1f2328']],
		['solarized-light', 'Solarized', 'Warm light', ['#fdf6e3', '#eee8d5', '#586e75']],
		['paper', 'Paper', 'Soft light', ['#fafaf7', '#f0f0ea', '#26261f']],
		['latte', 'Latte', 'Catppuccin light', ['#eff1f5', '#e6e9ef', '#4c4f69']]
	];
	/** Other themes: looks inspired by other coding harnesses. [id, name, description, [bg, card, fg, accent]] */
	const OTHER_THEMES = [
		['opencode', 'opencode', 'Near-black with peach', ['#0a0a0a', '#1a1a1a', '#eeeeee', '#fab283']],
		['codex', 'Codex', 'Neutral graphite', ['#181818', '#262626', '#ececec', '#339cff']],
		['codex-light', 'Codex Light', 'Bright and plain', ['#ffffff', '#f4f4f4', '#0d0d0d', '#0169cc']],
		['claude-code', 'Claude Code', 'Warm dark, terracotta', ['#1f1e1d', '#2b2a27', '#f5f4ed', '#d97757']],
		['claude-light', 'Claude Light', 'Ivory paper, clay', ['#faf9f5', '#f0eee6', '#1f1e1d', '#c96442']],
		['pi', 'Pi', 'Slate with mint', ['#111317', '#1c1f25', '#d8dee9', '#5fd7af']],
		['deepseek', 'DeepSeek', 'Ink blue', ['#141417', '#22232a', '#e8eaf0', '#4d6bfe']],
		['zcode-light', 'ZCode Light', 'Black on white', ['#ffffff', '#f3f3f3', '#111111', '#111111']],
		['kilo', 'Kilo Code', 'Charcoal with yellow', ['#141414', '#222222', '#f0f0f0', '#f8f675']],
		['cursor', 'Cursor', 'Soft black, blue', ['#141414', '#1f1f1f', '#e4e4e4', '#228df2']],
		['gemini', 'Gemini CLI', 'Blue to violet', ['#0e0f13', '#1a1c22', '#e3e3e3', '#4796e4']],
		['copilot', 'Copilot', 'GitHub night, purple', ['#0d1117', '#161b22', '#e6edf3', '#8957e5']],
		['crush', 'Crush', 'Charm purple and pink', ['#201f26', '#2d2c35', '#dfdbdd', '#6b50ff']],
		['windsurf', 'Windsurf', 'Deep teal', ['#0b0f10', '#161c1e', '#e6f0ef', '#34e8bb']],
		['qwen', 'Qwen Code', 'Indigo night', ['#121220', '#1c1c30', '#e6e6f5', '#615ced']],
		['warp', 'Warp', 'Black with cyan', ['#0c0c0d', '#19191b', '#e8e8e8', '#00c2ff']]
	];
	/** The two shelves on Appearance. Counts are filled from the lists above. */
	function themeShelves() {
		return [
			['classic', 'Classic themes', 'Editors, harness looks, light and dark.', THEMES.length + OTHER_THEMES.length, 'palette'],
			['terminal', 'Terminal', 'The whole chat as a CLI.', 1, 'terminal']
		];
	}
	function themeNameFor(id) {
		const found = THEMES.find((x) => x[0] === id) || OTHER_THEMES.find((x) => x[0] === id);
		return found ? found[1] : ({ vscode: 'VS Code', light: 'Light', dark: 'Dark', terminal: 'Terminal', auto: 'System' }[id] || 'System');
	}

	/** Paint the picture card's thumbnail (CSP: no inline styles, so it is set from JS). */
	function startPreviews(page) {
		for (const el of page.querySelectorAll('[data-bgimg]')) el.style.backgroundImage = 'url("' + el.dataset.bgimg + '")';
	}
	const ACCENTS = [
		['clay', '#d97757'],
		['blue', '#3b82f6'], ['sky', '#0ea5e9'], ['cyan', '#06b6d4'], ['teal', '#14b8a6'], ['green', '#10b981'], ['lime', '#84cc16'],
		['yellow', '#eab308'], ['amber', '#f59e0b'], ['zer0ne', '#f7931e'], ['orange', '#f97316'], ['red', '#ef4444'], ['rose', '#f43f5e'],
		['pink', '#ec4899'], ['fuchsia', '#d946ef'], ['violet', '#8b5cf6'], ['indigo', '#6366f1'], ['slate', '#94a3b8'], ['white', '#e5e5e5']
	];
	/** Accent palettes: [name, accent, second colour] */
	const PALETTES = [
		['zer0ne', '#f7931e', '#ffcf70'], ['Sunset', '#f97316', '#ec4899'], ['Ocean', '#0ea5e9', '#22d3ee'], ['Aurora', '#10b981', '#8b5cf6'],
		['Candy', '#f472b6', '#a78bfa'], ['Forest', '#22c55e', '#a3e635'], ['Royal', '#6366f1', '#c084fc'], ['Ember', '#ef4444', '#f59e0b'],
		['Ice', '#93c5fd', '#e0f2fe'], ['Mono', '#e5e5e5', '#737373'], ['Terminal', '#3fb950', '#f7931e'], ['Cyber', '#22d3ee', '#f472b6']
	];
	/** Prism two-tone pairs: [name, tone 1, tone 2] — the first is the default. */
	const GLOW_PAIRS = [
		['Metallic', '#0b0b0d', '#e3e7ec'], ['Gold', '#1a1206', '#f5d27a'], ['Rose gold', '#2a1418', '#f4c2b8'], ['Ice', '#0b1a2a', '#bfe6ff'],
		['Neon', '#1a0633', '#36f9f6'], ['Emerald', '#04150e', '#6ee7b7'], ['Ember', '#1a0804', '#fb923c'], ['Violet', '#12081f', '#c4b5fd']
	];
	const FONT_UI = [['system', 'System (default)'], ['inter', 'Inter'], ['segoe', 'Segoe UI Variable'], ['sf', 'SF Pro'], ['geist', 'Geist'], ['plex', 'IBM Plex Sans'], ['roboto', 'Roboto'], ['serif', 'Serif (Charter)'], ['mono', 'Monospace']];
	const FONT_CODE = [['editor', 'Editor font (default)'], ['cascadia', 'Cascadia Code'], ['jetbrains', 'JetBrains Mono'], ['fira', 'Fira Code'], ['geist', 'Geist Mono'], ['plex', 'IBM Plex Mono'], ['sf', 'SF Mono'], ['consolas', 'Consolas']];
	/** Keys a copied / imported theme carries. */
	const THEME_KEYS = ['theme', 'accent', 'accentColor', 'accentColor2', 'themeBackground', 'themeForeground', 'fontUi', 'fontContent', 'fontCode', 'fontWeight', 'uiFontSize', 'codeFontSize', 'glowColor', 'glowTone1', 'glowTone2', 'terminalFontSize', 'terminalLineHeight', 'terminalCursorStyle', 'terminalCursorBlink', 'terminalEffects', 'terminalProse'];

	/**
	 * Segmented Control: the picked option moves at once and an indicator glides from the
	 * old option to the new one while the setting is saved (the page redraws on the reply).
	 */
	function glideSegment(button) {
		const group = button.closest('.segmented');
		const from = group && group.querySelector('button.active');
		if (!group || !from || from === button || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		const thumb = group.querySelector('.seg-thumb') || group.insertBefore(document.createElement('span'), group.firstChild);
		thumb.className = 'seg-thumb';
		thumb.style.transition = 'none';
		thumb.style.width = from.offsetWidth + 'px';
		thumb.style.transform = 'translateX(' + from.offsetLeft + 'px)';
		void thumb.offsetWidth;
		thumb.style.transition = '';
		thumb.style.width = button.offsetWidth + 'px';
		thumb.style.transform = 'translateX(' + button.offsetLeft + 'px)';
		group.classList.add('gliding');
		from.classList.remove('active');
		button.classList.add('active');
	}

	function segmented(key, options) {
		return '<div class="segmented">' + options.map(([v, l]) => '<button data-seg="' + key + '" data-value="' + esc(v) + '" class="' + (String(S.settings[key]) === String(v) ? 'active' : '') + '">' + esc(l) + '</button>').join('') + '</div>';
	}

	function themeCard(id, name, desc, c, cur) {
		return (
			'<button class="theme-card' + (cur === id ? ' active' : '') + '" data-theme-pick="' + id + '">' +
			'<span class="theme-preview" data-swatch="' + c[0] + '">' +
			'<span class="tp-card" data-swatch="' + c[1] + '"></span><span class="tp-line" data-swatch="' + c[2] + '"></span><span class="tp-line short" data-swatch="' + c[2] + '"></span>' +
			(c[3] ? '<span class="tp-accent own" data-swatch="' + c[3] + '"></span>' : '<span class="tp-accent"></span>') +
			'</span><span class="theme-name">' + esc(name) + '</span><span class="theme-desc">' + esc(desc) + '</span></button>'
		);
	}

	/** The preview shares Terminal's palette with the chat surface. */
	function terminalCard(cur) {
		return (
			'<button class="special-card' + (cur === 'terminal' ? ' active' : '') + '" data-theme-pick="terminal">' +
			'<span class="special-preview term-preview terminal-preview' + (cur === 'terminal' ? ' current-palette' : '') + '"><span class="sp-term">' +
			'<span class="sp-bar"><b>zer0ne</b><span>~/app · main</span><span class="sp-model">12% context</span></span>' +
			'<span class="sp-line sp-prompt"><em>❯</em> refactor the auth flow</span>' +
			'<span class="sp-line"><span class="ok">✓</span> Read <u>src/auth.ts</u></span>' +
			'<span class="sp-line dim">  ⎿ 214 lines read · Completed</span>' +
			'<span class="sp-line"><span class="err">!</span> Tests <span class="err">Failed</span></span>' +
			'<span class="sp-line dim">Thought for 3s · Show details</span>' +
			'</span></span>' +
			'<span class="special-text"><span class="special-name">Terminal</span>' +
			'<span class="special-desc">Warm charcoal, a clay accent and readable tool results. Rounded prompts, compact status information and a plain background keep the focus on your work.</span>' +
			'<span class="special-tags"><span>mono type</span><span>clear status</span><span>adjustable cursor</span><span>static background</span></span>' +
			'<span class="special-cta">' + (cur === 'terminal' ? I('check') + 'In use' : 'Use Terminal') + '</span></span></button>'
		);
	}

	function terminalAbout() {
		const rows = [
			['❯', 'Your prompt', 'A rounded prompt surface with a clay marker and your chosen palette.'],
			['✓', 'Tool calls', 'A state icon and label distinguish completed, failed and rejected calls. Expand a row to inspect its output.'],
			['▮', 'Your cursor', 'Choose a block, bar or underline, with optional blinking. Reduced motion keeps it still.'],
			['▰', 'Compact controls', 'Choose your model and access mode directly in the composer.'],
			['✻', 'Thinking', 'A compact receipt keeps the thinking time visible; expand it when you need the details.']
		];
		return h(
			'div',
			'term-about',
			'<div class="ta-head"><span class="ta-eyebrow">' + I('terminal') + 'How it looks</span><b>A focused coding workspace</b>' +
				'<p>Terminal brings one palette to prompts, replies, tool results and Work Details. Choose monospace throughout or a reading font for longer answers.</p></div>' +
				'<div class="ta-grid">' + rows.map(([g, name, desc]) => '<div class="ta-row"><span class="ta-glyph">' + g + '</span><span class="ta-text"><b>' + esc(name) + '</b><span>' + esc(desc) + '</span></span></div>').join('') + '</div>' +
				'<div class="ta-notes"><span>' + I('check') + 'A static background; optional retro texture.</span><span>' + I('check') + 'Shell font, cursor and screen-reader settings below.</span></div>'
		);
	}

	/** "Your picture": the user's own image or GIF as the live background. */
	function pictureCard() {
		const img = window.getBackgroundImage && window.getBackgroundImage();
		if (!img && S.settings.backgroundImage && !S.bgAsked) {
			S.bgAsked = true;
			post({ type: 'getBackground' });
		}
		const has = !!S.settings.backgroundImage;
		const on = S.settings.background === 'image' && has;
		return (
			'<div class="theme-card picture-card' + (on ? ' active' : '') + '" role="button" tabindex="0" data-act="' + (has ? 'use-picture' : 'pick-background') + '">' +
			'<span class="theme-preview picture-preview"' + (img && has ? ' data-bgimg="' + esc(img) + '"' : '') + '>' +
			(has
				? '<span class="pp-actions"><span class="pp-btn" data-act="pick-background" role="button" tabindex="0" title="Pick another image or GIF">' + I('image') + '<span>Change</span></span><span class="pp-btn danger" data-act="clear-background" role="button" tabindex="0" title="Remove the picture">' + I('trash') + '<span>Remove</span></span></span>'
				: '<span class="pp-plus" data-act="pick-background" role="button" tabindex="0" title="Choose an image or GIF">' + I('image') + '<span>Browse…</span></span>') +
			'</span><span class="theme-name">Your picture</span><span class="theme-desc">' + (has ? esc(S.settings.backgroundImage.split(/[\\/]/).pop()) : 'Photo, artwork or animated GIF') + '</span></div>'
		);
	}

	/** A theme colour as #rrggbb (what a colour input accepts), or '' if it cannot be read. */
	function themeHex(cssVar) {
		const probe = document.createElement('span');
		probe.style.color = 'var(' + cssVar + ')';
		document.body.appendChild(probe);
		const m = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g);
		probe.remove();
		return m && m.length >= 3 ? '#' + m.slice(0, 3).map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('') : '';
	}

	/** `shown` is the colour in use when the field is empty (the theme's own). */
	function colourField(id, label, value, placeholder, shown) {
		const v = value || '';
		const c = v || shown || (placeholder.startsWith('#') ? placeholder : '#808080');
		return (
			'<label class="cc-field' + (v ? ' active' : '') + '"><span class="accent-custom"><input type="color" id="' + id + '" value="' + esc(c) + '"><span data-swatch="' + esc(c) + '"></span></span>' +
			'<span class="cc-text"><span class="cc-name">' + esc(label) + '</span><input class="input mono hex-input" id="' + id + '-hex" value="' + esc(v) + '" placeholder="' + esc(placeholder) + '" maxlength="7" spellcheck="false" aria-label="' + esc(label) + ' hex"></span></label>'
		);
	}

	function appearancePage() {
		const root = h('div', 'page appearance-page');
		root.appendChild(header('Appearance', 'Themes, colours, fonts and effects for the chat. Changes apply instantly.'));
		const st = S.settings;
		// A theme id from a build that had extra shelves is not a theme any more: show System.
		const stored = st.theme || 'auto';
		const cur = String(stored).startsWith('modern-') || stored === 'liquidmac' ? 'auto' : stored;

		// ---- Mode: System / Light / Dark (and VS Code's own colours), then the classic themes
		root.appendChild(h('div', 'section-label', 'Mode'));
		const modes = [
			['auto', 'System', desktopHost() ? 'Follows your system' : 'Follows VS Code', 'split'],
			['light', 'Light', 'Always light', 'light'],
			['dark', 'Dark', 'Always dark', 'dark'],
			['vscode', 'VS Code', 'Your editor colours', 'editor']
		].filter(([id]) => !desktopHost() || id !== 'vscode');
		root.appendChild(
			h(
				'div',
				'mode-row modes-' + modes.length,
				modes
					.map(([id, name, desc, kind]) => '<button class="mode-card' + (cur === id ? ' active' : '') + '" data-theme-pick="' + id + '"><span class="mode-preview ' + kind + '"><i></i><i></i><i></i></span><span class="mode-text"><span class="theme-name">' + name + '</span><span class="theme-desc">' + desc + '</span></span>' + (cur === id ? '<span class="mode-check">' + I('check') + '</span>' : '') + '</button>')
					.join('')
			)
		);
		// ---- Two shelves: Classic and Terminal
		const tab = S.themeTab || (cur === 'terminal' ? 'terminal' : 'classic');
		S.themeTab = tab;
		const shelves = themeShelves();
		root.appendChild(h('div', 'section-label', 'Themes'));
		root.appendChild(
			h(
				'div',
				'theme-cats',
				shelves
					.map(([id, name, desc, count, icon]) => {
						const inUse = id === 'terminal' ? cur === 'terminal' : THEMES.some((x) => x[0] === cur) || OTHER_THEMES.some((x) => x[0] === cur);
						return '<button class="theme-cat' + (tab === id ? ' active' : '') + '" data-theme-tab="' + id + '" role="tab" aria-selected="' + (tab === id) + '"><span class="tc-icon">' + I(icon) + '</span><span class="tc-text"><b>' + esc(name) + '</b><small>' + esc(desc) + '</small></span><span class="tc-count">' + count + (inUse ? '<span class="tc-dot" title="In use"></span>' : '') + '</span></button>';
					})
					.join('')
			)
		);
		const shelf = h('div', 'theme-tab-body');
		shelf.setAttribute('role', 'tabpanel');
		shelf.setAttribute('aria-label', (shelves.find((x) => x[0] === tab) || ['', 'Themes'])[1]);
		if (tab === 'classic') {
			// Classic keeps everything that was here before: the 16 classics and the inspired fold.
			shelf.appendChild(h('div', 'section-label', 'Classic themes <span class="theme-badge">' + THEMES.length + '</span>'));
			shelf.appendChild(h('div', 'theme-grid', THEMES.map(([id, name, desc, c]) => themeCard(id, name, desc, c, cur)).join('')));
			const otherOpen = S.otherThemesOpen || OTHER_THEMES.some((x) => x[0] === cur);
			const other = h('details', 'theme-fold');
			other.open = otherOpen;
			other.innerHTML =
				'<summary class="section-label">' + I('chevronRight') + 'Other themes <span class="theme-badge">' + OTHER_THEMES.length + '</span>' + (OTHER_THEMES.some((x) => x[0] === cur) ? '<span class="muted fold-cur">· ' + esc(OTHER_THEMES.find((x) => x[0] === cur)[1]) + '</span>' : '<span class="muted fold-cur">Codex, Claude Code, opencode, Pi, DeepSeek, Cursor…</span>') + '</summary>' +
				'<div class="section-sub muted">Looks inspired by other coding tools. Each brings its own accent; the editor below can change it.</div>' +
				'<div class="theme-grid">' + OTHER_THEMES.map(([id, name, desc, c]) => themeCard(id, name, desc, c, cur)).join('') + '</div>';
			other.addEventListener('toggle', () => (S.otherThemesOpen = other.open));
			shelf.appendChild(other);
		} else {
			// Terminal is the same card as before, now with room to explain what it changes.
			shelf.appendChild(h('div', 'special-row', terminalCard(cur)));
			shelf.appendChild(terminalAbout());
		}
		root.appendChild(shelf);
		root.appendChild(h('div', 'section-label', 'Terminal & shell'));
		root.appendChild(h('div', 'card terminal-options',
			selectRow('Shell font size', 'Follow the code font size, or choose a separate size for interactive shells.', 'terminalFontSize', [[0, 'Follow code font'], ...[10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map(v => [v, v + ' px'])]) +
			selectRow('Shell line height', 'Space between terminal output lines.', 'terminalLineHeight', [[1, 'Compact · 1.0'], [1.15, '1.15'], [1.3, 'Comfortable · 1.3'], [1.5, '1.5'], [1.75, '1.75'], [2, 'Spacious · 2.0']]) +
			selectRow('Cursor shape', 'Used by interactive shells and the Terminal chat cursor.', 'terminalCursorStyle', [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']]) +
			switchRow('Blink cursor', 'Reduced motion overrides blinking, including in shells already open.', 'terminalCursorBlink') +
			switchRow('Screen-reader terminal output', 'Expose interactive shell output to assistive technology. Cursor animation stays off.', 'terminalScreenReader') +
			selectRow('Terminal answers', 'Monospace throughout, or a reading font for long replies. Code and tool output stay monospace.', 'terminalProse', [['mono', 'Monospace'], ['reading', 'Reading font']]) +
			selectRow('Terminal texture', 'Optional static scanlines and a soft text glow. No animated background.', 'terminalEffects', [['off', 'Crisp'], ['retro', 'Retro']]) +
			selectRow('Workspace spacing', 'Applies to the chat and its controls.', 'density', [['comfortable', 'Comfortable'], ['compact', 'Compact']]) +
			'<div class="setting-row"><div class="text"><div class="name">Restore terminal defaults</div><div class="desc">Reset font, cursor and texture choices. Your screen-reader preference is preserved.</div></div><div class="control"><button class="btn btn-secondary" data-act="terminal-reset">Reset terminal</button></div></div>'
		));
		for (const control of root.querySelectorAll('.terminal-options select, .terminal-options input')) control.setAttribute('aria-label', control.closest('.setting-row').querySelector('.name').textContent);

		// ---- Theme editor (Claude / Codex style): palette, colours, fonts, import / copy
		const solid = ACCENTS.find(([id]) => id === st.accent);
		// The fields show the accent in use, so a named accent reads as its own colour.
		const custom = st.accent === 'custom' && st.accentColor ? st.accentColor : solid ? solid[1] : st.accentColor || '#3b82f6';
		const custom2 = st.accentColor2 || '';
		const pal = st.accent === 'custom' && PALETTES.find(([, c1, c2]) => custom.toLowerCase() === c1 && custom2.toLowerCase() === c2);
		const edited = appearanceEdited(st);
		root.appendChild(h('div', 'section-label', 'Customize'));
		root.appendChild(
			h(
				'div',
				'card theme-editor',
				'<div class="te-top"><div class="te-preview" aria-hidden="true">' +
					'<div class="te-bar"><i></i><i></i><i></i><span>theme.ts</span></div>' +
					'<div class="te-code"><span class="ln">1</span><span><b class="kw">const</b> theme = <b class="fn">pick</b>(palette);</span>' +
					'<span class="ln del">2</span><span class="del">- <b class="kw">export</b> background = <b class="str">"#181818"</b>;</span>' +
					'<span class="ln add">2</span><span class="add">+ <b class="kw">export</b> background = theme.<b class="fn">surface</b>;</span>' +
					'<span class="ln">3</span><span class="cm">// accent, text and fonts follow</span></div>' +
					'<div class="te-chip">' + I('sparkle') + '<span>Accent</span></div></div>' +
					'<div class="te-actions"><div class="name">' + esc(themeNameFor(cur)) + (edited ? ' <span class="theme-badge">edited</span>' : '') + '</div>' +
					'<div class="desc">Tune any theme: accent, surface and text colours, and fonts. Copy it to share, or import a theme — zer0ne JSON or any VS Code colour theme.</div>' +
					'<div class="te-btns"><button class="btn btn-secondary btn-sm" data-act="theme-import">' + I('arrowDown') + 'Import</button><button class="btn btn-secondary btn-sm" data-act="theme-copy">' + I('copy') + 'Copy theme</button>' +
					'<button class="btn btn-ghost btn-sm" data-act="theme-reset"' + (edited || st.accent !== 'blue' ? '' : ' hidden') + '>Reset</button></div></div></div>' +
					(S.themeImport
						? '<div class="te-import"><textarea class="input mono" id="theme-import-text" rows="5" spellcheck="false" placeholder=\'{ "themeBackground": "#181818", "themeForeground": "#ffffff", "accentColor": "#f7931e" }  — or paste a VS Code theme .json\'></textarea><div class="te-import-row"><span class="muted">Only colours and fonts are read.</span><button class="btn btn-ghost btn-sm" data-act="theme-import">Cancel</button><button class="btn btn-primary btn-sm" data-act="theme-import-apply">Apply</button></div></div>'
						: '') +
					'<div class="setting-row stacked"><div class="text"><div class="name">Accent</div><div class="desc">Buttons, links, focus rings, gradients and the live backgrounds. ' + (solid ? 'Now: <b>' + esc(solid[0]) + '</b>.' : pal ? 'Now: <b>' + esc(pal[0]) + '</b>.' : 'Now: <b>custom</b>.') + '</div></div>' +
					'<div class="palette-row">' +
					PALETTES.map(([name, a, b]) => '<button class="palette-chip' + (pal && pal[0] === name ? ' active' : '') + '" data-palette="' + a + ',' + b + '"><span class="pc-sw"><span data-swatch="' + a + '"></span><span data-swatch="' + b + '"></span></span>' + esc(name) + '</button>').join('') +
					'</div></div>' +
					'<div class="te-colours">' +
					'<label class="cc-field' + (st.accent === 'custom' && !pal ? ' active' : '') + '"><span class="accent-custom"><input type="color" id="accent-color" value="' + esc(custom) + '"><span data-swatch="' + esc(custom) + '"></span></span><span class="cc-text"><span class="cc-name">Accent</span><input class="input mono hex-input" id="accent-hex" value="' + esc(custom) + '" maxlength="7" spellcheck="false" aria-label="Accent hex"></span></label>' +
					'<label class="cc-field"><span class="accent-custom"><input type="color" id="accent-color2" value="' + esc(custom2 || custom) + '"><span data-swatch="' + esc(custom2 || custom) + '"></span></span><span class="cc-text"><span class="cc-name">Second</span><input class="input mono hex-input" id="accent-hex2" value="' + esc(custom2) + '" placeholder="auto" maxlength="7" spellcheck="false" aria-label="Second colour hex"></span></label>' +
					colourField('theme-bg', 'Background', st.themeBackground, 'theme', themeHex('--color-background')) +
					colourField('theme-fg', 'Foreground', st.themeForeground, 'theme', themeHex('--color-foreground')) +
					'</div>' +
					'<div class="te-fonts">' +
					'<div class="setting-row"><div class="text"><div class="name">UI font</div><div class="desc">Menus, buttons and labels — the interface chrome.</div></div><div class="control font-duo"><select class="select" data-setting="fontUi" aria-label="UI font">' + FONT_UI.map(([v, l]) => '<option value="' + v + '"' + (st.fontUi === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>' +
					'<select class="select weight-select" data-setting="fontWeight" data-num="1" aria-label="UI font weight">' + [[300, 'Light'], [400, 'Regular'], [450, 'Book'], [500, 'Medium'], [600, 'Semibold']].map(([v, l]) => '<option value="' + v + '"' + ((st.fontWeight || 400) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Serif answers</div><div class="desc">Chat replies in a book-like serif, the way Claude sets its answers. Menus and code keep their own fonts.</div></div><div class="control"><label class="switch"><input type="checkbox" data-act="serif-answers" aria-label="Serif answers"' + (st.fontContent === 'serif' ? ' checked' : '') + '><span class="track"></span></label></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Content font</div><div class="desc">The type chat replies are set in.</div></div><div class="control"><select class="select" data-setting="fontContent" aria-label="Content font">' + FONT_UI.map(([v, l]) => '<option value="' + v + '"' + (st.fontContent === v ? ' selected' : '') + '>' + esc(v === 'system' ? 'Same as UI font' : l) + '</option>').join('') + '</select></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Code font</div><div class="desc">Inline code and code blocks.</div></div><div class="control"><select class="select" data-setting="fontCode" aria-label="Code font">' + FONT_CODE.map(([v, l]) => '<option value="' + v + '"' + (st.fontCode === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">UI font size</div><div class="desc">Adjust the base size used across the app.</div></div><div class="control size-input"><input type="number" class="input num-input" id="s-uiFontSize" data-setting="uiFontSize" min="11" max="18" step="1" value="' + (st.uiFontSize || 13) + '" aria-label="UI font size"><span class="unit">px</span></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Code font size</div><div class="desc">Adjust the base size used for code across chats and diffs.</div></div><div class="control size-input"><input type="number" class="input num-input" id="s-codeFontSize" data-setting="codeFontSize" min="10" max="20" step="1" value="' + (st.codeFontSize || localCodeFontSize() || 12) + '" aria-label="Code font size"><span class="unit">px</span></div></div>' +
					'</div><div class="te-note muted">Fonts are used when installed on this computer; otherwise the next one in line is used.</div>'
			)
		);
		const bgHex = themeHex('--color-background'), fgHex = themeHex('--color-foreground');
		const lightness = hex => {
			const parts = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
			return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
		};
		if (/^#[0-9a-f]{6}$/i.test(bgHex) && /^#[0-9a-f]{6}$/i.test(fgHex)) {
			const bgLum = lightness(bgHex), fgLum = lightness(fgHex), ratio = (Math.max(bgLum, fgLum) + 0.05) / (Math.min(bgLum, fgLum) + 0.05);
			if (ratio < 4.5) root.appendChild(h('div', 'callout terminal-contrast', '<div>Your text contrast is <b>' + ratio.toFixed(2) + ':1</b>. A ratio of 4.5:1 improves readability. Your chosen colors are preserved.</div><button class="btn btn-secondary" data-readable-fg="' + (bgLum > 0.179 ? '#000000' : '#ffffff') + '">Use readable text</button>'));
		}

		// ---- Background picture (image or animated GIF behind the chat)
		const op = st.backgroundOpacity ?? 60;
		const bgOn = st.background === 'image' && !!st.backgroundImage;
		root.appendChild(h('div', 'section-label', 'Background picture'));
		if (cur === 'terminal') root.appendChild(h('div', 'callout', I('terminal') + '<div>The <b>Terminal</b> theme keeps a plain background, so the picture is hidden while it is on.</div>'));
		root.appendChild(
			h(
				'div',
				'card picture-block',
				'<div class="picture-row">' + pictureCard() +
					// These options only change the picture, so they rest until one is in use.
					'<div class="picture-opts' + (bgOn ? '' : ' resting') + '"' + (bgOn ? '' : ' inert') + '>' +
					(bgOn ? '' : '<div class="picture-hint muted">' + I('image') + (st.backgroundImage ? 'Click the picture to show it behind the chat.' : 'Choose a picture to use these options.') + '</div>') +
					'<div class="setting-row"><div class="text"><div class="name">Show on chat <span class="muted" id="bg-op-val">' + op + '%</span></div><div class="desc">How strongly the picture shows behind the conversation.</div></div><div class="control"><input type="range" class="range" id="s-backgroundOpacity" data-setting="backgroundOpacity" min="1" max="100" step="1" value="' + op + '" aria-label="Picture strength"></div></div>' +
					selectRow('Style', 'Original, or a frosted blur behind the chat. GIFs keep playing either way.', 'backgroundFilter', [['none', 'Original'], ['blur', 'Frosted blur']]) +
					'<div class="setting-row"><div class="text"><div class="name">Show on</div><div class="desc">Everywhere, or only on the new-chat screen.</div></div><div class="control">' + segmented('backgroundScope', [['all', 'Always'], ['empty', 'New chat only']]) + '</div></div>' +
					switchRow('Glass panels', 'Frosted, translucent cards over the picture.', 'glass') +
					'</div></div>'
			)
		);

		// ---- Glow: the composer's handoff beam
		const glowOn = (st.glow || 'subtle') !== 'off';
		const strength = st.glowStrength ?? 35;
		const gc = st.glowColor || 'metallic';
		// Your own tones fill the fields; otherwise they rest on the Metallic pair.
		const t1 = gc === 'custom' ? st.glowTone1 : '';
		const t2 = gc === 'custom' ? st.glowTone2 : '';
		root.appendChild(h('div', 'section-label', 'Glow'));
		root.appendChild(
			h(
				'div',
				'card',
				'<div class="setting-row"><div class="text"><div class="name">Motion</div><div class="desc"><b>Calm</b> keeps animation for what is happening — a run working, a reply streaming, an agent waiting — and stops decorative loops such as background stars, the welcome logo, shine sweeps and the working glow.</div></div><div class="control">' + segmented('motion', [['full', 'Full'], ['calm', 'Calm']]) + '</div></div>' +
				'<div class="setting-row"><div class="text"><div class="name">Prism glow</div><div class="desc">A light runs along the bottom edge once for about 2.5 seconds when you focus the message box or press <b>Enter</b>, then fades out.</div></div><div class="control">' + segmented('glow', [['subtle', 'On'], ['off', 'Off']]) + '</div></div>' +
					(glowOn
						? '<div class="setting-row stacked"><div class="text"><div class="name">Two-tone colours</div><div class="desc"><b>Metallic</b> is the default. Pick a pair, follow your accent, or set both tones yourself.</div></div>' +
							'<div class="palette-row">' +
							GLOW_PAIRS.map(([name, a, b], i) => {
								const active = i === 0 ? gc === 'metallic' : gc === 'custom' && st.glowTone1 === a && st.glowTone2 === b;
								return '<button class="palette-chip glow-chip' + (active ? ' active' : '') + '" data-glow-pair="' + a + ',' + b + (i === 0 ? ',metallic' : '') + '"><span class="pc-sw ring"><span data-swatch="' + a + '"></span><span data-swatch="' + b + '"></span></span>' + esc(name) + '</button>';
							}).join('') +
							'<button class="palette-chip glow-chip' + (gc === 'accent' ? ' active' : '') + '" data-seg="glowColor" data-value="accent"><span class="pc-sw ring accent-sw"><span></span><span></span></span>Accent</button>' +
							'</div><div class="te-colours two">' + colourField('glow-tone1', 'Tone 1', t1, GLOW_PAIRS[0][1]) + colourField('glow-tone2', 'Tone 2', t2, GLOW_PAIRS[0][2]) + '</div></div>' +
							'<div class="setting-row"><div class="text"><div class="name">Intensity <span class="muted" id="glow-val">' + strength + '%</span></div><div class="desc">From a faint hint to a bright light.</div></div><div class="control"><input type="range" class="range" id="s-glowStrength" data-setting="glowStrength" min="0" max="100" step="5" value="' + strength + '"></div></div>' +
							'<div class="glow-demo-wrap"><div class="glow-demo input-card" tabindex="0" id="glow-demo"><div class="streak" aria-hidden="true"></div><span class="gd-text">Focus here for the light, press <kbd>Enter</kbd> for a brighter run</span><span class="gd-send">' + I('arrowUp') + '</span></div></div>'
						: '')
			)
		);
		const glowDemo = root.querySelector('#glow-demo');
		if (glowDemo && window.ComposerBeam) window.ComposerBeam.attach(glowDemo, { reach: 20 });

		// ---- Layout
		root.appendChild(h('div', 'section-label', 'Layout'));
		root.appendChild(
			h(
				'div',
				'card',
				'<div class="setting-row"><div class="text"><div class="name">Density</div><div class="desc">Spacing between messages.</div></div><div class="control">' + segmented('density', [['compact', 'Compact'], ['comfortable', 'Comfortable']]) + '</div></div>'
			)
		);
		return root;
	}

	/** Theme import: zer0ne JSON, or a VS Code colour theme (colors / tokenColors). */
	function importTheme(text) {
		let j;
		try {
			j = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
		} catch {
			return toast('That is not valid JSON.', 'error');
		}
		const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}/i.test(v) ? v.slice(0, 7).toLowerCase() : '');
		const patch = {};
		if (j && j.colors && typeof j.colors === 'object') {
			const c = j.colors;
			const bg = hex(c['sideBar.background']) || hex(c['editor.background']);
			const fg = hex(c['sideBar.foreground']) || hex(c['editor.foreground']) || hex(c.foreground);
			const acc = hex(c['button.background']) || hex(c.focusBorder) || hex(c['activityBarBadge.background']);
			if (bg) patch.themeBackground = bg;
			if (fg) patch.themeForeground = fg;
			if (acc) Object.assign(patch, { accent: 'custom', accentColor: acc, accentColor2: hex(c['textLink.foreground']) || '' });
		} else if (j && typeof j === 'object') {
			for (const k of THEME_KEYS) if (k in j) patch[k] = j[k];
			if (patch.fontWeight !== undefined) patch.fontWeight = Number(patch.fontWeight) || 400;
		}
		if (!Object.keys(patch).length) return toast('No colours found in that theme.', 'error');
		// The code font size is a local preference: the engine's settings do not carry it.
		if (patch.codeFontSize !== undefined) {
			setLocalCodeFontSize(patch.codeFontSize);
			delete patch.codeFontSize;
		}
		S.themeImport = false;
		flushColourPatch();
		post({ type: 'updateSettings', patch });
		toast('Theme imported' + (j.name ? ': ' + j.name : '') + '.', 'ok');
	}

	// ------------------------------------------------------------ Models

	function modelsPage() {
		const root = h('div', 'page wide models-page');
		root.appendChild(
			header(
				'Providers & models',
				'Sign in to a subscription, use a coding plan, or add any API provider. Enabled models appear in the chat picker.',
				'<button class="icon-btn" data-act="refresh-catalog" title="Refresh the provider catalog from models.dev">' + I('refresh') + '</button><button class="btn btn-primary" data-act="add-provider">' + I('plus') + 'Add provider</button>'
			)
		);
		if (!S.providers.length) S.addingProvider = true;
		const enabled = S.providers.filter(p => p.enabled);
		const activeModels = enabled.reduce((n, p) => n + p.models.filter(m => m.enabled).length, 0);
		root.appendChild(h('div', 'connections-overview', '<div>' + I('plug') + '<span><b>' + S.providers.length + '</b> providers</span></div><div>' + I('cube') + '<span><b>' + activeModels + '</b> enabled models</span></div><div>' + I('key') + '<span>Subscriptions, plan keys &amp; API connections</span></div>'));
		if (!S.addingProvider && !providerById(S.editingId)) {
			S.editingId = (providerById(S.selection.providerId) || S.providers[0]).id;
			persist();
		}
		const grid = h('div', 'card providers');
		grid.appendChild(providerList());
		grid.appendChild(S.addingProvider ? addProviderPane() : providerDetail(providerById(S.editingId)));
		root.appendChild(grid);
		root.appendChild(modelFeatures());
		return root;
	}

	/** Reasoning defaults belong to the selected model or signed-in agent. */
	function modelFeatures() {
		const wrap = h('div', 'model-features');
		wrap.innerHTML = '<div class="card"><div class="setting-row"><div class="text"><div class="name">Reasoning</div><div class="desc">Auto uses the selected model or signed-in agent’s default. Supported levels are detected from the connection and model; you can choose an override in chat.</div></div><span class="badge">Auto by default</span></div></div>';
		return wrap;
	}

	/** Model analysis: Intelligence Index vs Cost per Task (media/analysis.js opens the canvas). */

	function providerList() {
		const list = h('div', 'provider-list');
		let html = '<div class="list-label">Providers</div>';
		for (const p of S.providers) {
			const dot = statusDot(p);
			html +=
				'<button class="provider-item' + (!S.addingProvider && p.id === S.editingId ? ' active' : '') + (p.enabled ? '' : ' disabled') + '" data-provider="' + esc(p.id) + '" title="' + esc(p.name) + '">' +
				tile(presetById(p.preset), p.name) + '<span class="grow">' + esc(p.name) + '</span>' + (p.models.length ? '<span class="pi-count" title="Models on">' + p.models.filter((m) => m.enabled).length + '</span>' : '') +
				'<span class="dot ' + dot + '" title="' + esc(dot === 'green' ? (p.health && p.health.ok ? 'Working — checked ' + new Date(p.health.at).toLocaleString() : 'Ready') : dot === 'red' ? 'Needs attention: ' + ((p.health && p.health.error) || '').slice(0, 160) : dot ? 'Needs setup' : 'Disabled') + '"></span></button>';
		}
		html += '<button class="provider-item list-add' + (S.addingProvider ? ' active' : '') + '" data-act="add-provider">' + I('plus') + '<span class="grow">Add provider</span></button>';
		list.innerHTML = html;
		return list;
	}

	const GROUPS = [
		['api', 'API providers', 'Pay-as-you-go keys.'],
		['local', 'Local', 'Models running on this computer.']
	];

	/** The provider created from a preset, if there is one. */
	const connectedFor = (presetId) => S.providers.find((p) => p.preset === presetId);
	const ACCOUNT_VENDOR = { chatgpt: 'OpenAI', xai: 'xAI', kimi: 'Moonshot AI', minimax: 'MiniMax' };
	function planState(provider, fallback) {
		if (!provider) return '<span class="ac-state">' + esc(fallback) + '</span>';
		const label = !provider.enabled ? 'Disabled' : provider.health && !provider.health.ok ? 'Needs attention' : !keyOptional(provider) && !provider.hasKey ? 'Sign in needed' : !provider.models.some((m) => m.enabled) ? 'Choose models' : provider.health && provider.health.ok ? 'Connected' : 'Ready';
		return '<button class="ac-state' + (label === 'Connected' ? ' ok' : '') + '" data-provider="' + esc(provider.id) + '" title="Open ' + esc(provider.name) + '">' + (label === 'Connected' ? I('check') : '') + esc(label) + '</button>';
	}

	/** Sign in with an account: the account and its API key, side by side. */
	function accountCard(p) {
		const conn = connectedFor(p.id);
		const key = p.keyPreset ? presetById(p.keyPreset) : null;
		let primary;
		if (p.kind === 'account') primary = '<button class="btn btn-primary btn-sm" data-acct-signin="' + esc(p.account) + '">' + I('key') + (conn ? 'Sign in again' : 'Sign in') + '</button>';
		else if (p.kind === 'vscode-lm') primary = '<button class="btn btn-primary btn-sm" data-preset="' + esc(p.id) + '">' + I('shield') + 'Connect</button>';
		else if (p.kind === 'oauth-openrouter' || p.kind === 'oauth-github') primary = '<button class="btn btn-primary btn-sm" data-preset="' + esc(p.id) + '">' + I('key') + 'Sign in</button>';
		else primary = '<button class="btn btn-primary btn-sm" data-preset="' + esc(p.id) + '">' + I('key') + 'Add API key</button>';
		if (p.account === 'chatgpt') primary = '<button class="btn btn-primary btn-sm" data-acct-signin="chatgpt">Continue with ChatGPT</button>';
		if (p.account === 'chatgpt' && conn) primary += '<button class="btn btn-ghost btn-sm" data-acct-signin="chatgpt" data-acct-new="true">Add another account</button>';
		const second = key
			? '<button class="btn btn-ghost btn-sm" data-preset="' + esc(key.id) + '" title="' + esc(key.desc) + '">' + (key.apiFormat === 'vertex' ? 'Vertex (gcloud)' : key.group === 'plans' ? 'Plan key' : 'API key') + '</button>'
			: p.keyUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(p.keyUrl) + '">' + I('link') + 'Get a key</button>' : '';
		const method = p.kind === 'vscode-lm' ? 'VS Code' : p.kind === 'apiKey' ? 'API key' : 'Sign in';
		return (
			'<div class="acct-card' + (conn ? ' connected' : '') + (p.kind === 'account' ? ' oauth' : '') + '">' +
			'<div class="ac-top">' + tile(p) + '<div class="ac-id"><b>' + esc(p.name) + '</b><span>' + esc(p.plans || '') + '</span></div>' +
			planState(conn, method) + '</div>' +
			'<p class="ac-desc">' + esc(p.desc) + '</p>' +
			(p.note ? '<p class="ac-note" title="' + esc(p.note) + '">' + I('info') + '<span>' + esc(p.noteShort || p.note) + '</span></p>' : '') +
			'<div class="ac-actions">' + primary + second + '</div></div>'
		);
	}

	/** A plan agent from the ACP registry: Sign in (the vendor's own login) and the same vendor's API key, side by side. */
	function acpCard(c) {
		const conn = (S.acpConnected || []).find((x) => x.agent === c.id);
		const key = c.keyPreset ? presetById(c.keyPreset) : null;
		const primary = c.available === false ? '<button class="btn btn-secondary btn-sm" data-act="open-url" data-url="' + esc(c.setupUrl || c.manageUrl || '') + '"' + (!(c.setupUrl || c.manageUrl) ? ' disabled' : '') + '>' + I('link') + 'Setup instructions</button>' : '<button class="btn btn-primary btn-sm" data-acp-signin="' + esc(c.id) + '"' + (conn ? ' data-acp-for="' + esc(conn.providerId) + '"' : '') + '>' + I('key') + (conn ? 'Sign in again' : 'Sign in') + '</button>';
		const second = key
			? '<button class="btn btn-ghost btn-sm" data-preset="' + esc(key.id) + '" title="' + esc(key.desc) + '">' + (key.group === 'plans' ? 'Plan key' : 'API key') + '</button>'
			: c.manageUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(c.manageUrl) + '">' + I('link') + (c.plan ? 'Get a plan' : 'Website') + '</button>' : '';
		const dl = c.download && !(S.acpInstalled || {})[c.id];
		return (
			'<div class="acct-card' + (conn ? ' connected' : '') + '">' +
			'<div class="ac-top">' + tile({ tile: c.tile }) + '<div class="ac-id"><b>' + esc(c.name) + '</b><span>' + esc(c.plans || (c.direct ? 'also signs in with its own card' : 'agent')) + '</span></div>' +
			planState(conn && S.providers.find((p) => p.id === conn.providerId), c.available === false ? 'Setup needed' : dl ? 'Download agent' : 'Sign in') + '</div>' +
			'<p class="ac-desc">' + esc(c.desc) + '</p>' +
			(c.setupIssue ? '<p class="ac-setup">' + I('info') + '<span>' + esc(c.setupIssue) + '</span></p>' : '') +
			(c.note ? '<p class="ac-note" title="' + esc(c.note) + '">' + I('info') + '<span>' + esc(c.note.length > 120 ? c.note.slice(0, 117) + '…' : c.note) + '</span></p>' : '') +
			'<div class="ac-actions">' + primary + second + '</div></div>'
		);
	}

	/** A plan that connects with its key: the same card as the sign-in plans, with "Add key" as the action. */
	function planKeyCard(p) {
		const conn = connectedFor(p.id);
		return (
			'<div class="acct-card' + (conn ? ' connected' : '') + '">' +
			'<div class="ac-top">' + tile(p) + '<div class="ac-id"><b>' + esc(p.name) + '</b>' + (p.plans ? '<span>' + esc(p.plans) + '</span>' : '') + '</div>' +
			planState(conn, p.group === 'plans' ? 'Plan key' : 'Account key') + '</div>' +
			'<p class="ac-desc">' + esc(p.desc) + '</p>' +
			'<div class="ac-actions"><button class="btn btn-secondary btn-sm" data-preset="' + esc(p.id) + '">' + I('key') + (conn ? 'Replace key' : 'Add key') + '</button>' +
			(p.keyUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(p.keyUrl) + '">' + I('link') + 'Get the key</button>' : '') + '</div></div>'
		);
	}

	/** Every plan in one list: sign in (account or the vendor's agent) or the plan's key. */
	function planEntries() {
		const acpPlan = (S.acpCards || []).filter((c) => c.plan);
		const signin = S.presets.filter((p) => p.group === 'signin');
		const oauth = signin.filter((p) => p.kind === 'account' || (p.kind === 'vscode-lm' && !desktopHost()) || /^oauth-/.test(p.kind));
		const vendorKeys = signin.filter((p) => p.kind === 'apiKey' && /^(claude-account|gemini)$/.test(p.id));
		// Subscriptions whose vendors allow no sign-in elsewhere (Claude Pro/Max, Antigravity) have their agent card instead.
		const ownApps = signin.filter((p) => p.kind === 'apiKey' && /^(claude-plan|antigravity)$/.test(p.id));
		const subKeys = signin.filter((p) => p.kind === 'apiKey' && !vendorKeys.includes(p) && !ownApps.includes(p));
		// A plan that has its own sign-in card is offered there (Sign in · API key), not twice.
		const covered = new Set([...oauth.map((p) => p.keyPreset), ...acpPlan.map((c) => c.keyPreset)].filter(Boolean));
		const keyPlans = [...S.presets.filter((p) => p.group === 'plans' && !covered.has(p.id)), ...subKeys];
		const connected = (x) => (x.acp ? (S.acpConnected || []).some((c) => c.agent === x.item.id) : !!connectedFor(x.item.id));
		const list = [
			...oauth.map((p) => ({ item: p, method: 'oauth', html: () => accountCard(p) })),
			...acpPlan.map((c) => ({ item: c, acp: true, method: 'agent', html: () => acpCard(c) })),
			...keyPlans.map((p) => ({ item: p, method: 'key', html: () => planKeyCard(p) }))
		];
		// Connected plans first; otherwise the curated order.
		return list.map((x, i) => ({ ...x, i, on: connected(x) })).sort((a, b) => b.on - a.on || a.i - b.i);
	}

	function planGridHtml() {
		const q = (S.planQuery || '').trim().toLowerCase();
		const shown = planEntries().filter((x) => (!q || (x.item.name + ' ' + (x.item.plans || '') + ' ' + (x.item.desc || '')).toLowerCase().includes(q)));
		if (!shown.length) return '<div class="plan-empty">' + I('search') + '<span>No plan matches' + (q ? ' “' + esc(S.planQuery) + '”' : '') + '. Try the API keys tab, or Custom for any endpoint.</span></div>';
		return '<div class="acct-grid plan-grid">' + shown.map((x) => x.html()).join('') + '</div>';
	}

	/** Add provider → Custom: configure models in the draft before saving the provider. */
	function customPane() {
		const c = S.customDraft || (S.customDraft = { name: '', apiFormat: 'openai', baseUrl: '', apiKey: '', models: [] });
		if (!Array.isArray(c.models)) c.models = String(c.models || '').split(/[\s,]+/).filter(Boolean).map((id) => ({ id, enabled: true, smart: c.smart !== false }));
		if (!['openai', 'responses', 'anthropic', 'gemini'].includes(c.apiFormat)) c.apiFormat = 'openai';
		const fmt = [
			['openai', 'OpenAI-compatible', '/v1/chat/completions — OpenAI, DeepSeek, GLM, Kimi, Qwen, OpenRouter, Ollama, LM Studio, vLLM…'],
			['responses', 'OpenAI Responses', '/v1/responses — GPT and compatible gateways'],
			['anthropic', 'Anthropic-compatible', '/v1/messages — Claude, GLM, Kimi, MiniMax…'],
			['gemini', 'Gemini native', ':streamGenerateContent — Google AI Studio']
		];
		const example = c.apiFormat === 'anthropic' ? 'https://api.anthropic.com' : c.apiFormat === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.example.com/v1';
		const pane = h('div', 'provider-detail add-pane custom-pane');
		pane.innerHTML =
			'<div class="pane-head"><button class="icon-btn" data-act="custom-back" title="Back">' + I('back') + '</button>' + tile(presetById('custom') || { tile: { text: '+', bg: '#2a2a2a' } }) + '<span class="pane-title">Custom provider</span></div>' +
			'<p class="muted cp-lead">Any endpoint that speaks one of these APIs. The key is stored in your OS keychain; the model list is read from the endpoint right after.</p>' +
			'<div class="field"><div class="field-label">API format</div><div class="cp-formats" role="radiogroup">' +
			fmt.map(([id, label, desc]) => '<button role="radio" aria-checked="' + (c.apiFormat === id) + '" class="cp-format' + (c.apiFormat === id ? ' active' : '') + '" data-cp-format="' + id + '"><b>' + esc(label) + '</b><span>' + esc(desc) + '</span></button>').join('') + '</div></div>' +
			'<div class="cp-row"><div class="field"><div class="field-label">Name</div><input id="cp-name" class="input" value="' + esc(c.name) + '" placeholder="My provider" autocomplete="off" spellcheck="false"></div>' +
			'<div class="field grow"><div class="field-label">Base URL</div><input id="cp-url" class="input mono" value="' + esc(c.baseUrl) + '" placeholder="' + esc(example) + '" autocomplete="off" spellcheck="false"></div></div>' +
			'<div class="field"><div class="field-label">API key <span class="key-state">· optional for localhost' + (c.apiFormat === 'vertex' ? ' and Vertex (gcloud)' : '') + '</span></div><div class="input-wrap"><input id="cp-key" class="input mono" type="' + (S.keyVisible ? 'text' : 'password') + '" value="' + esc(c.apiKey) + '" placeholder="Paste your API key" autocomplete="off" spellcheck="false">' +
			'<button class="icon-btn" data-act="toggle-key" title="' + (S.keyVisible ? 'Hide' : 'Show') + '">' + I(S.keyVisible ? 'eyeOff' : 'eye') + '</button></div></div>' +
			'<div class="field cp-models' + (c.models.length ? '' : ' is-empty') + '"><div class="cp-models-head"><div class="field-label">Models <span class="key-state">· optional</span></div><div class="cp-add-wrap"><span class="cp-add-hint">Context, prices &amp; capabilities auto-fill</span><button class="btn btn-ghost cp-add-btn" data-act="custom-model-add" title="Type a model ID — smart configuration fills context, max output, prices and capabilities from the catalog when it recognizes it.">' + I('plus') + 'Add model</button></div></div>' +
			'<p class="muted cp-models-hint">Configure models now, or choose from the endpoint\'s list after adding the provider.</p>' +
			(c.models.length ? '<div class="cp-model-list">' + c.models.map((m, i) => '<div class="cp-model-row"><div class="grow"><b class="mono">' + esc(m.id) + '</b><div class="sub">' + (m.smart ? 'Smart configuration' : 'Manual configuration') + (m.manualFields && m.manualFields.length && m.smart ? ' · custom overrides' : '') + (m.contextWindow ? ' · ' + fmtTokens(m.contextWindow) + ' context' : '') + (m.maxOutput ? ' · ' + fmtTokens(m.maxOutput) + ' output' : '') + '</div></div><button class="icon-btn" data-act="custom-model-edit" data-index="' + i + '" title="Edit ' + esc(m.id) + '" aria-label="Edit ' + esc(m.id) + '">' + I('pencil') + '</button><button class="icon-btn" data-act="custom-model-remove" data-index="' + i + '" title="Remove ' + esc(m.id) + '" aria-label="Remove ' + esc(m.id) + '">' + I('trash') + '</button></div>').join('') + '</div>' : '<div class="cp-model-empty">No models added yet</div>') + '</div>' +
			'<div class="cp-actions"><button class="btn btn-ghost" data-act="custom-back">Cancel</button><button class="btn btn-primary" data-act="custom-add"' + (S.customBusy ? ' disabled' : '') + '>' + (S.customBusy ? '<span class="spinner"></span>' : I('plus')) + 'Add provider</button></div>';
		return pane;
	}

	function addProviderPane() {
		const pane = h('div', 'provider-detail add-pane');
		if (S.presetInfo) {
			const p = presetById(S.presetInfo);
			pane.innerHTML =
				'<div class="pane-head"><button class="icon-btn" data-act="preset-back" title="Back">' + I('back') + '</button>' + tile(p) + '<span class="pane-title">' + esc(p.name) + '</span></div>' +
				'<div class="callout info-callout">' + I('info') + '<div>' + esc(p.info) + '</div></div>' +
				'<div class="section-label">Use one of these instead</div><div class="preset-grid">' +
				(p.suggest || []).map((id) => presetCard(presetById(id))).join('') + '</div>';
			return pane;
		}
		if (S.customForm) return customPane();
		// Two categories: plans you pay for (sign in when the vendor allows it, else the plan's key) and pay-as-you-go API keys.
		const tab = S.addTab === 'keys' ? 'keys' : 'plans';
		if (!S.acpAsked) {
			S.acpAsked = true;
			post({ type: 'acpAgents' });
		}
		const signin = S.presets.filter((p) => p.group === 'signin');
		const vendorKeys = signin.filter((p) => p.kind === 'apiKey' && /^(claude-account|gemini)$/.test(p.id));
		const entries = planEntries();
		const apiCount = vendorKeys.length + S.presets.filter((p) => p.group === 'api' || p.group === 'local').length;
		const custom = presetById('custom');
		let html = '<div class="pane-head">' + (S.providers.length ? '<button class="icon-btn" data-act="add-cancel" title="Back">' + I('back') + '</button>' : '') + '<span class="pane-title">Add provider</span></div>';
		html +=
			'<button class="custom-first" data-act="custom-open">' + (custom ? tile(custom) : '') +
			'<span class="grow"><b>Custom</b><span>Any OpenAI-, Anthropic- or Gemini-compatible endpoint — name, API format, base URL, key and models.</span></span>' + I('chevronRight') + '</button>' +
			'<div class="add-tabs" role="tablist">' +
			'<button role="tab" data-add-tab="plans" class="' + (tab === 'plans' ? 'active' : '') + '">' + I('key') + '<span>Plans &amp; subscriptions</span><em>' + entries.length + '</em></button>' +
			'<button role="tab" data-add-tab="keys" class="' + (tab === 'keys' ? 'active' : '') + '">' + I('plug') + '<span>API keys</span><em>' + apiCount + '</em></button></div>';
		if (tab === 'plans') {
			html +=
				'<section class="acct-sec plans-sec">' +
				'<div class="plan-intro">' + I('shield') + '<span><b>Connect your existing plan.</b> Sign in through the provider\'s browser or agent. Some plans use a dedicated key instead. Available models and usage depend on your account; regular API keys can have separate billing.</span></div>' +
				'<div class="plan-tools"><div class="search-box sm">' + I('search') + '<input id="plan-q" placeholder="Search ' + entries.length + ' plans" autocomplete="off" spellcheck="false" value="' + esc(S.planQuery || '') + '"></div>' +
				'</div>' +
				'<div id="plan-grid">' + planGridHtml() + '</div>' +
				(S.acpError ? '<div class="callout warn-callout">' + I('alert') + '<span>' + esc(S.acpError) + '</span><button class="btn btn-secondary btn-sm" data-act="acp-refresh">Retry agent list</button></div>' : S.acpCards ? '' : '<div class="empty-inline"><span class="spinner"></span><span>Loading the plan agents…</span></div>') + '</section>';
		} else {
			html +=
				'<div class="preset-group"><div class="section-label">Model vendors</div><div class="group-desc">Their own API with a pay-as-you-go key (a Claude Console or Gemini AI Studio key; Gemini\'s is free). Subscriptions sign in under Plans &amp; subscriptions.</div>' +
				'<div class="acct-grid">' + vendorKeys.map(accountCard).join('') + '</div></div>';
			for (const [group, title, desc] of GROUPS) {
				const items = S.presets.filter((p) => p.group === group);
				if (!items.length) continue;
				html += '<div class="preset-group"><div class="section-label">' + esc(desktopHost() && title === 'Editor & automation' ? 'Tools & skills' : title) + '</div><div class="group-desc">' + esc(desktopHost() && title === 'Editor & automation' ? 'Project tools and reusable instructions.' : desc) + '</div><div class="preset-grid">' + items.map(presetCard).join('') + '</div></div>';
			}
			html +=
				'<div class="preset-group"><div class="section-label">All providers</div><div class="group-desc">Search 100+ providers from the models.dev catalog.</div>' +
				'<div class="search-box">' + I('search') + '<input id="catalog-q" placeholder="Search providers…" autocomplete="off" value="' + esc(S.catalogQuery) + '"></div>' +
				'<div class="pick-list" id="catalog-list">' + catalogListHtml() + '</div></div>';
		}
		pane.innerHTML = html;
		return pane;
	}

	function presetCard(p) {
		if (!p) return '';
		const badge = p.kind === 'vscode-lm' ? '<span class="badge ok">VS Code</span>' : p.kind === 'account' || p.kind === 'oauth-openrouter' || p.kind === 'oauth-github' ? '<span class="badge ok">Sign in</span>' : p.group === 'signin' && p.kind === 'apiKey' ? '<span class="badge">Account key</span>' : p.kind === 'info' ? '<span class="badge">Info</span>' : p.apiFormat === 'anthropic' ? '<span class="badge">Anthropic API</span>' : p.apiFormat === 'gemini' || p.apiFormat === 'bedrock' || p.apiFormat === 'vertex' ? '<span class="badge">Native API</span>' : '';
		return '<button class="preset-card" ' + (p.kind === 'account' ? 'data-acct-signin="' + esc(p.account) + '"' : 'data-preset="' + esc(p.id) + '"') + '>' + tile(p) + '<span class="grow"><span class="pc-name">' + esc(p.name) + '</span><span class="pc-desc">' + esc(p.desc) + '</span></span>' + badge + I('chevronRight') + '</button>';
	}

	// ------------------------------------------------------------ account sign-in dialog

	let signDlg = null;
	const SIGN_STEPS = [['authorize', 'Authorize'], ['connect', 'Connect'], ['ready', 'Ready']];

	function signInDialog(account, method, providerId, newAccount = false) {
		const p = S.presets.find((x) => x.kind === 'account' && x.account === account);
		if (!p) return;
		if (signDlg) signDlg.d.close();
		const d = openDialog({
			title: 'Sign in',
			small: true,
			onClose: () => {
				if (signDlg && signDlg.d === d) {
					clearInterval(signDlg.timer);
					if (!/done|error|cancelled/.test(signDlg.stage)) post({ type: 'cancelSignIn' });
					signDlg = null;
				}
			}
		});
		d.dlg.classList.add('signin-dlg');
		signDlg = { d, account, p, method: method || 'browser', providerId, newAccount, stage: 'starting', requestId: crypto.randomUUID() };
		renderSignIn();
		post({ type: 'accountSignIn', account, method: signDlg.method, id: providerId, requestId: signDlg.requestId, newAccount });
	}

	function renderSignIn() {
		const g = signDlg;
		if (!g) return;
		const p = g.p;
		const step = /done/.test(g.stage) ? 2 : /exchanging|models/.test(g.stage) ? 1 : 0;
		const spinRow = (text) => '<div class="si-wait"><span class="spinner"></span><span>' + esc(text) + '</span></div>';
		let body = '';
		switch (g.stage) {
			case 'starting':
				body = spinRow('Preparing a secure sign-in…');
				break;
			case 'browser':
				body =
					'<div class="si-lead"><b>Continue in your browser</b><span>Approve zer0ne on the ' + esc(ACCOUNT_VENDOR[g.account] || p.name) + ' page that just opened. This window updates by itself.</span></div>' +
					'<div class="si-btns"><button class="btn btn-secondary btn-sm" data-si="reopen">' + I('link') + 'Open the page again</button>' +
					'</div>' +
					spinRow('Waiting for your approval…') +
					'<p class="si-fine">Finish sign-in in a browser on this computer, then return to this window.</p>';
				break;
			case 'device': {
				const code = String(g.code || '');
				body =
					'<div class="si-lead"><b>Enter this code on the sign-in page</b><span>' + esc(ACCOUNT_VENDOR[g.account] || p.name) + ' asks for it after you log in.</span></div>' +
					'<div class="si-code" aria-label="Sign-in code">' + code.split('').map((ch) => (ch === '-' ? '<i class="sep">–</i>' : '<i>' + esc(ch) + '</i>')).join('') + '</div>' +
					'<div class="si-btns"><button class="btn btn-primary btn-sm" data-si="copy">' + I('copy') + 'Copy code</button><button class="btn btn-secondary btn-sm" data-si="reopen">' + I('link') + 'Open sign-in page</button></div>' +
					spinRow('Waiting for approval…') + '<p class="si-fine" id="si-expiry"></p>';
				break;
			}
			case 'waiting':
				body = spinRow(g.text || 'Working…');
				break;
			case 'exchanging':
				body = spinRow('Connecting your account…');
				break;
			case 'models':
				body = spinRow('Loading the models on your plan…');
				break;
			case 'done':
				body =
					'<div class="si-done"><span class="si-check">' + I('check') + '</span><b>Signed in' + (g.email ? ' as ' + esc(g.email) : '') + '</b>' +
					'<span>' + (g.plan ? '<em class="si-plan">' + esc(String(g.plan).replace(/^./, (c) => c.toUpperCase())) + '</em> · ' : '') + esc(String(g.count || 0)) + ' models ready in the chat picker</span></div>';
				break;
			case 'error':
				body =
					'<div class="si-error">' + I('alert') + '<div><b>Sign-in did not finish</b><span>' + esc(g.error || 'Unknown error') + '</span></div></div>' +
					'<div class="si-btns"><button class="btn btn-primary btn-sm" data-si="retry">' + I('retry') + 'Try again</button></div>';
				break;
		}
		g.d.body.innerHTML =
			'<div class="si-head">' + tile(p) + '<div class="si-id"><b>Sign in to ' + esc(p.name) + '</b><span>' + esc(p.plans || '') + '</span></div></div>' +
			'<ol class="si-steps">' + SIGN_STEPS.map(([id, label], i) => '<li class="' + (i < step || g.stage === 'done' ? 'done' : i === step ? 'now' : '') + '"><i>' + (i < step || g.stage === 'done' ? I('check') : i + 1) + '</i><span>' + label + '</span></li>').join('') + '</ol>' +
			'<div class="si-body">' + body + '</div>' +
			'<div class="si-secure">' + I('lock') + '<span>Provider browser OAuth · enter your password only on the provider\'s page · tokens stay in your OS keychain</span></div>';
		g.d.foot.innerHTML = '<span class="spacer"></span>' + (g.stage === 'done' ? '<button class="btn btn-primary" data-si="close">Done</button>' : '<button class="btn btn-ghost" data-si="close">' + (g.stage === 'error' ? 'Close' : 'Cancel') + '</button>');
		paintTiles(g.d.dlg);
		for (const b of g.d.dlg.querySelectorAll('[data-si]')) b.addEventListener('click', () => signInAction(b.dataset.si));
		clearInterval(g.timer);
		if (g.stage === 'device' && g.expiresAt) {
			const tick = () => {
				const el2 = document.getElementById('si-expiry');
				const left = Math.max(0, Math.round((g.expiresAt - Date.now()) / 1000));
				if (el2) el2.textContent = 'The code expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + '.';
			};
			tick();
			g.timer = setInterval(tick, 1000);
		}
	}

	function signInAction(a) {
		const g = signDlg;
		if (!g) return;
		if (a === 'close') return g.d.close();
		if (a === 'reopen' && g.url) return post({ type: 'openExternal', url: g.url });
		if (a === 'copy') {
			const code = String(g.code || '');
			if (navigator.clipboard) navigator.clipboard.writeText(code).then(() => toast('Code copied.', 'ok'), () => post({ type: 'copyText', text: code }));
			else post({ type: 'copyText', text: code });
			return;
		}
		if (a === 'device' || a === 'retry') {
			const method = a === 'device' ? 'device' : g.method;
			post({ type: 'cancelSignIn' });
			Object.assign(g, { method, stage: 'starting', error: '', code: '', url: '', requestId: crypto.randomUUID() });
			renderSignIn();
			setTimeout(() => { if (signDlg === g) post({ type: 'accountSignIn', account: g.account, method, id: g.providerId, requestId: g.requestId, newAccount: g.newAccount }); }, 50);
		}
	}

		// ------------------------------------------------------------ plan-agent sign-in dialog (ACP)

	let acpDlg = null;

	function signInFailureTitle(error) {
		if (/needs your account verified|VALIDATION_REQUIRED|account verification|verify your account/i.test(error || '')) return 'Account verification required';
		if (/does not permit this integration|subscription.{0,30}not supported/i.test(error || '')) return 'Plan unavailable for this connection';
		return /^Signed in, but/.test(error || '') ? 'Signed in — connection needs attention' : 'Sign-in did not finish';
	}

	function acpSignInDialog(agentId, providerId) {
		const c = (S.acpCards || []).find((x) => x.id === agentId);
		if (!c) return toast('The agent list is still loading — try again in a moment.', 'error');
		if (acpDlg) acpDlg.d.close();
		const d = openDialog({
			title: 'Sign in',
			small: true,
			onClose: () => {
				if (acpDlg && acpDlg.d === d) {
					if (!/done|error|cancelled/.test(acpDlg.stage)) post({ type: 'acpCancel' });
					acpDlg = null;
				}
			}
		});
		d.dlg.classList.add('signin-dlg');
		acpDlg = { d, c, agentId, providerId, stage: 'starting' };
		renderAcpSignIn();
		post({ type: 'acpSignIn', agent: agentId, id: providerId, ...(agentId === 'antigravity-acp' && providerId ? { reauthenticate: true } : {}) });
	}

	function renderAcpSignIn() {
		const g = acpDlg;
		if (!g) return;
		if (g.copyNextLink && g.url && /^(browser|browser-wait)$/.test(g.stage)) {
			g.copyNextLink = false;
			post({ type: 'copyText', text: g.url });
		}
		const previousCode = g.d.dlg.querySelector('#acp-code');
		const codeDraft = previousCode?.value || '';
		const codeFocused = previousCode && document.activeElement === previousCode;
		const c = g.c;
		// A failed plan check comes after a good sign-in: Authorize is done, Connect failed.
		const step = g.stage === 'done' ? 2 : g.stage === 'models' || g.stage === 'verify' || (g.stage === 'error' && /^Signed in, but/.test(g.error || '')) ? 1 : 0;
		const spin = (text) => '<div class="si-wait"><span class="spinner"></span><span>' + esc(text) + '</span></div>';
		const linkBtns = g.url ? '<div class="si-btns"><button class="btn btn-secondary btn-sm" data-si="reopen">' + I('link') + 'Open the page again</button><button class="btn btn-ghost btn-sm" data-si="copylink">' + I('copy') + 'Copy link</button></div>' : '';
		let body = '';
		switch (g.stage) {
			case 'install': {
				const pct = g.total ? Math.floor((g.received / g.total) * 100) : 0;
				body =
					'<div class="si-lead"><b>' + esc(g.text || 'Getting the agent…') + '</b><span>Downloaded once, then it runs from the extension\'s data folder.</span></div>' +
					(g.total ? '<div class="pull-bar"><span data-width="' + pct + '"></span></div><div class="muted mono si-pct">' + gb(g.received) + ' / ' + gb(g.total) + ' · ' + pct + '%</div>' : spin('Working…'));
				break;
			}
			case 'waiting':
				body = spin(g.text || 'Working…');
				break;
			case 'browser':
			case 'browser-wait':
				body =
					'<div class="si-lead"><b>Continue in your browser</b><span>Approve the sign-in on the ' + esc(c.name) + ' page that opened. This window updates by itself.</span></div>' +
					linkBtns + spin('Waiting for your approval…') +
					(g.manualLink && g.url ? '<label class="si-fine">Fresh Google sign-in link<input class="input mono" data-acp-login-link readonly value="' + esc(g.url) + '"></label><p class="si-fine">Paste this link into a private browser window on this computer. Keep this dialog open while you sign in.</p>' : '') +
					'<p class="si-fine">Working over SSH, WSL or a remote machine? The page cannot reach this computer there: open the link on any device and paste the code it shows when asked.</p>';
				break;
			case 'code':
				body =
					'<div class="si-lead"><b>Paste the code</b><span>The sign-in page shows a code after you approve — paste it here.</span></div>' +
					'<div class="si-codebox"><input id="acp-code" class="input mono" placeholder="Code from the page" autocomplete="off" spellcheck="false"><button class="btn btn-primary btn-sm" data-si="sendcode">Send</button></div>' + linkBtns;
				break;
			case 'terminal':
				body = '<div class="si-lead"><b>Finish in the terminal</b><span>' + esc(g.text || 'A terminal window opened with the sign-in.') + '</span></div>' + spin('Waiting for the sign-in to finish…');
				break;
			case 'models':
				body = spin('Loading the models on your plan…');
				break;
			case 'verify':
				body = spin(g.text || 'Checking that your plan answers…') + '<p class="si-fine">One short greeting to the plan — a signed-in account that is unverified or has no plan fails here, not in your chat.</p>';
				break;
			case 'done':
				body =
					'<div class="si-done"><span class="si-check">' + I('check') + '</span><b>Connected' + (g.email ? ' as ' + esc(g.email) : '') + '</b>' +
					'<span>' + (g.plan ? '<em class="si-plan">' + esc(String(g.plan).replace(/^./, (ch) => ch.toUpperCase())) + '</em> · ' : '') + esc(String(g.count || 0)) + ' model' + (g.count === 1 ? '' : 's') + ' ready in the chat picker' + (g.total > g.count ? ' (' + (g.total - g.count) + ' more listed, off)' : '') + '</span>' +
					(g.verifiedMs ? '<span class="si-verified">' + I('check') + 'Checked: the plan answered in ' + (g.verifiedMs / 1000).toFixed(1) + ' s</span>' : '') + '</div>';
				break;
			case 'error':
				body = '<div class="si-error">' + I('alert') + '<div><b>' + signInFailureTitle(g.error) + '</b><span>' + errorText(g.error || 'Unknown error') + '</span></div></div><div class="si-btns">' + verifyButton(g.error) + '<button class="btn ' + (verifyButton(g.error) ? 'btn-secondary' : 'btn-primary') + ' btn-sm" data-si="retry">' + I('retry') + 'Try again</button>' + (c.manageUrl ? '<button class="btn btn-ghost btn-sm" data-si="site">' + I('link') + 'Vendor site</button>' : '') + '</div>';
				if (g.agentId === 'antigravity-acp') body += '<div class="si-btns"><button class="btn btn-secondary btn-sm" data-si="reauthorize">' + I('key') + 'Sign in with Google again</button><button class="btn btn-secondary btn-sm" data-si="copyfresh">' + I('copy') + 'Copy fresh sign-in link</button></div><p class="si-fine">This agent keeps a separate saved login. If the official Antigravity app works, start a new sign-in here and choose the same Google account. If Google immediately shows an error, copy a fresh sign-in link and try it in a private browser window.</p>';
				break;
			default:
				body = spin('Preparing…');
		}
		g.d.body.innerHTML =
			'<div class="si-head">' + tile({ tile: c.tile }) + '<div class="si-id"><b>Sign in to ' + esc(c.name) + '</b><span>' + esc(c.plans || '') + '</span></div></div>' +
			'<ol class="si-steps">' + SIGN_STEPS.map(([id, label], i) => '<li class="' + (i < step || g.stage === 'done' ? 'done' : i === step ? 'now' : '') + '"><i>' + (i < step || g.stage === 'done' ? I('check') : i + 1) + '</i><span>' + label + '</span></li>').join('') + '</ol>' +
			'<div class="si-body">' + (g.browserError ? '<p class="si-fine" role="status">' + esc(g.browserError) + '</p>' : '') + body + '</div>' +
			'<div class="si-secure">' + I('lock') + '<span>' + esc(c.name) + '\'s own sign-in · zer0ne never sees your password or token — the vendor\'s agent keeps the login' + (c.download ? ' · downloaded from the vendor over HTTPS' : '') + '</span></div>';
		g.d.foot.innerHTML = '<span class="spacer"></span>' + (g.stage === 'done' ? '<button class="btn btn-primary" data-si="close">Done</button>' : '<button class="btn btn-ghost" data-si="close">' + (g.stage === 'error' ? 'Close' : 'Cancel') + '</button>');
		paintTiles(g.d.dlg);
		for (const b of g.d.dlg.querySelectorAll('[data-si]')) b.addEventListener('click', () => acpAction(b.dataset.si));
		const codeIn = g.d.dlg.querySelector('#acp-code');
		if (codeIn) {
			codeIn.value = codeDraft;
			if (codeFocused) codeIn.focus();
			codeIn.addEventListener('keydown', (e) => e.key === 'Enter' && acpAction('sendcode'));
		}
	}

	function acpAction(a) {
		const g = acpDlg;
		if (!g) return;
		if (a === 'close') return g.d.close();
		if (a === 'reopen' && g.url) return post({ type: 'openExternal', url: g.url });
		if (a === 'site' && g.c.manageUrl) return post({ type: 'openExternal', url: g.c.manageUrl });
		if (a === 'copylink' && g.url) {
			post({ type: 'copyText', text: g.url });
			return;
		}
		if (a === 'sendcode') {
			const el2 = g.d.dlg.querySelector('#acp-code');
			const code = el2 ? el2.value.trim() : '';
			if (!code) return toast('Paste the code first.', 'error');
			post({ type: 'acpSignInCode', code });
			Object.assign(g, { stage: 'waiting', text: 'Checking the code…' });
			return renderAcpSignIn();
		}
		if (a === 'retry' || ((a === 'reauthorize' || a === 'copyfresh') && g.agentId === 'antigravity-acp')) {
			post({ type: 'acpCancel' });
			Object.assign(g, { stage: 'starting', error: '', url: '', browserError: '', copyNextLink: a === 'copyfresh', manualLink: a === 'copyfresh' });
			renderAcpSignIn();
			setTimeout(() => { if (acpDlg === g && g.d.dlg.isConnected) post({ type: 'acpSignIn', agent: g.agentId, id: g.providerId, ...(a !== 'retry' ? { reauthenticate: true } : {}) }); }, 50);
		}
	}

	/**
	 * The providers of a catalog list that match the search text. Pure: it never touches the
	 * page or the state, so it can be applied to whatever list arrives from the engine — the
	 * engine does not echo the query a reply answers, and a "refresh" reply is the whole
	 * catalog. Same rule as the catalog itself: name or id contains the query.
	 */
	function filterCatalogItems(items, query) {
		const q = (query || '').trim().toLowerCase();
		if (!q) return items || [];
		return (items || []).filter((c) => String(c.name || '').toLowerCase().includes(q) || String(c.id || '').toLowerCase().includes(q));
	}

	function catalogListHtml() {
		if (!S.catalogQuery) return '<div class="pick-empty">Type to search the catalog.</div>';
		if (!S.catalogItems) return '<div class="pick-empty"><span class="spinner"></span></div>';
		const items = filterCatalogItems(S.catalogItems, S.catalogQuery);
		if (!items.length) return '<div class="pick-empty">No providers match.</div>';
		return items
			.map((c) => '<button class="pick-item" data-catalog="' + esc(c.id) + '">' + I('cube') + '<span class="grow">' + esc(c.name) + '<span class="sub">' + esc(c.baseUrl || 'Base URL required') + '</span></span>' + (c.apiFormat === 'anthropic' ? '<span class="badge">Anthropic</span>' : '') + '<span class="badge mono">' + c.modelCount + ' models</span></button>')
			.join('');
	}

	const fmtPrice = (n) => (n == null ? '?' : n === 0 ? '0' : n < 1 ? String(Math.round(n * 100) / 100) : String(Math.round(n * 10) / 10));

	function modelBadges(m) {
		let b = '';
		if (m.contextWindow) b += '<span class="badge mono" title="Context window">' + fmtTokens(m.contextWindow) + '</span>';
		if (m.reasoning) b += '<span class="badge" title="Reasoning / thinking model">Reasoning</span>';
		if (m.vision) b += '<span class="badge" title="Accepts images">Vision</span>';
		if (m.priceIn != null || m.priceOut != null) b += '<span class="badge mono price" title="$ per million tokens — input / output">$' + fmtPrice(m.priceIn) + ' / $' + fmtPrice(m.priceOut) + '</span>';
		if (m.tools === false) b += '<span class="badge warn" title="No tool calling — agent mode falls back to chat">No tools</span>';
		return b;
	}

	function testBadge(p, m) {
		const t = S.tests[p.id + '::' + m.id];
		if (!t) return '';
		if (t.state === 'running') return '<span class="test-state"><span class="spinner"></span></span>';
		if (t.state === 'ok') return '<span class="test-state ok" title="Model answered">' + I('check') + '<span>' + t.ms + ' ms</span></span>';
		return '<span class="test-state fail" title="' + esc(t.error) + '">' + I('alert') + '<span>Failed</span></span>';
	}

	function endpointHint(p) {
		if (/^https:\/\/opencode\.ai\/zen\/go\/v1\/?$/.test(p.baseUrl || '')) return 'OpenCode Go automatically uses the model’s required Chat Completions, Messages or Responses endpoint.';
		if (p.apiFormat === 'responses') return 'Requests go to <code>' + esc((p.baseUrl || '').replace(/\/+$/, '') + '/responses') + '</code>.';
		if (p.apiFormat === 'gemini') return 'Native Gemini API. Default <code>https://generativelanguage.googleapis.com/v1beta</code> — key from Google AI Studio.';
		if (p.apiFormat === 'bedrock') return 'Your region\'s runtime endpoint, e.g. <code>https://bedrock-runtime.us-west-2.amazonaws.com</code>. The key is a <b>Bedrock API key</b>; models are Claude IDs or inference profiles like <code>us.anthropic.claude-sonnet-4-5-20250929-v1:0</code>.';
		if (p.apiFormat === 'vertex') return '<code>https://REGION-aiplatform.googleapis.com/v1/projects/PROJECT/locations/REGION</code>. Leave the key empty to use <code>gcloud auth print-access-token</code>. Models: <code>claude-…@date</code> or <code>gemini-…</code>.';
		if (!p.baseUrl) return p.apiFormat === 'anthropic' ? 'e.g. <code>https://api.anthropic.com</code>' : 'e.g. <code>https://api.openai.com/v1</code> — OpenAI-compatible URLs usually end in <code>/v1</code>';
		const base = p.baseUrl.replace(/\/+$/, '');
		if (p.apiFormat === 'anthropic') {
			const b = base.replace(/\/v1\/(messages|models)$/i, '').replace(/\/(messages|models)$/i, '');
			return 'Requests go to <code>' + esc(/\/v1$/i.test(b) ? b + '/messages' : b + '/v1/messages') + '</code>';
		}
		return 'Requests go to <code>' + esc(base.replace(/\/(chat\/completions|models)$/i, '') + '/chat/completions') + '</code>';
	}

	/** The provider failed its last real check (sign-in, verification, credits): what it said and the fix, on top of the page. */
	function healthBanner(p) {
		const hl = p.health;
		if (!hl || hl.ok) return '';
		const acct = p.auth === 'account' ? presetById(p.preset) : null;
		const replacementAgent = acct && { xai: 'grok-build', kimi: 'kimi', minimax: 'minimax-code' }[acct.account];
		const fix =
			p.apiFormat === 'acp' && p.agent
				? '<button class="btn btn-primary btn-sm" data-acp-signin="' + esc(p.agent.id) + '" data-acp-for="' + esc(p.id) + '">' + I('key') + 'Sign in again</button>'
				: acct && acct.account
					? replacementAgent ? '<button class="btn btn-primary btn-sm" data-acp-signin="' + esc(replacementAgent) + '">' + I('key') + 'Connect vendor agent</button>' : '<button class="btn btn-primary btn-sm" data-acct-signin="' + esc(acct.account) + '" data-acct-for="' + esc(p.id) + '">' + I('key') + 'Sign in again</button>'
					: '<button class="btn btn-primary btn-sm" data-act="focus-key">' + I('key') + 'Replace the key</button>';
		return (
			'<div class="health-banner">' + I('alert') + '<div class="hb-text"><b>' + (hl.signIn ? 'This account needs attention' : 'The last check failed') + '</b>' +
			'<span>' + errorText(hl.error) + '</span><em>' + esc(new Date(hl.at).toLocaleString()) + '</em></div>' +
			'<div class="hb-actions">' + verifyButton(hl.error) + fix + '<button class="btn btn-ghost btn-sm" data-act="health-check" title="Send one short test message with the first model that is on">' + I('retry') + 'Check again</button></div></div>'
		);
	}

	function agentConnectionState(p) {
		if (p.health && p.health.ok === false) return { ready: false, title: p.health.signIn ? 'Sign-in required' : 'Connection needs attention' };
		if (!p.health || p.health.ok !== true) return { ready: false, title: 'Vendor agent configured' };
		return { ready: true, title: p.agent && p.agent.email ? 'Signed in as ' + p.agent.email : 'Connected through ' + p.name + "'s own agent" };
	}

	function providerDetail(p) {
		const d = h('div', 'provider-detail');
		const preset = presetById(p.preset);
		const lm = p.apiFormat === 'vscode-lm';
		const oauth = p.auth === 'oauth';
		const fetching = S.fetching === p.id;
		const q = ((S.modelQuery || {})[p.id] || '').toLowerCase();
		const shown = q ? p.models.filter((m) => (m.id + ' ' + (m.name || '')).toLowerCase().includes(q)) : p.models;
		const inUse = (m) => S.selection && S.selection.providerId === p.id && S.selection.model === m.id;
		const check = (S.checks || {})[p.id];
		const tools =
			p.models.length > 1
				? '<div class="model-tools">' +
					(p.models.length > 6 ? '<div class="search-box sm">' + I('search') + '<input id="model-q" data-provider-q="' + esc(p.id) + '" placeholder="Filter ' + p.models.length + ' models" autocomplete="off" spellcheck="false" value="' + esc(q) + '"></div>' : '') +
					'<span class="muted mt-count">' + p.models.filter((m) => m.enabled).length + ' of ' + p.models.length + ' on' + (q ? ' · ' + shown.length + ' shown' : '') + '</span><span class="spacer"></span>' +
					'<button class="btn btn-ghost btn-sm" data-act="models-on" title="Turn on ' + (q ? 'the shown' : 'all') + ' models">All on</button><button class="btn btn-ghost btn-sm" data-act="models-off" title="Turn off ' + (q ? 'the shown' : 'all') + ' models">All off</button>' +
					'<button class="btn btn-ghost btn-sm" data-act="test-all" title="Send a tiny test prompt to each model that is on (up to 12)">' + I('plug') + 'Test all</button></div>'
				: '';
		const models = p.models.length
			? tools + '<div class="model-list">' +
				(shown.length ? '' : '<div class="model-empty">' + I('search') + '<span>No model matches “' + esc(q) + '”.</span></div>') +
				shown
					.map(
						(m) =>
							'<div class="model-row' + (m.enabled ? '' : ' off') + (inUse(m) ? ' in-use' : '') + '" data-model="' + esc(m.id) + '">' +
							(m.name
								? '<span class="model-id named" title="' + esc(m.id + (m.note ? ' — ' + m.note : '')) + '"><b>' + esc(m.name) + '</b><small>' + esc(m.note ? m.note : m.id) + '</small></span>'
								: '<span class="model-id" title="' + esc(m.id) + '">' + esc(m.id) + '</span>') + (inUse(m) ? '<span class="badge ok" title="Selected in the chat">In use</span>' : '') + '<span class="badges">' + modelBadges(m) + '</span><span class="spacer"></span>' + testBadge(p, m) +
							'<span class="actions"><button class="icon-btn" data-act="test-model" title="Test connection">' + I('plug') + '</button>' +
							'<button class="icon-btn" data-act="edit-model" title="Edit">' + I('pencil') + '</button>' +
							'<button class="icon-btn danger" data-act="delete-model" title="Remove">' + I('trash') + '</button>' +
							'<label class="switch" title="' + (m.enabled ? 'Enabled' : 'Disabled') + '"><input type="checkbox" data-act="toggle-model"' + (m.enabled ? ' checked' : '') + '><span class="track"></span></label></span></div>'
					)
					.join('') +
				'</div>'
			: '<div class="model-list"><div class="model-empty">' + I('cube') + '<span>No models yet. ' + (lm ? 'Sign in to GitHub Copilot in VS Code, then Fetch models.' : 'Fetch them from the endpoint or add one by ID.') + '</span></div></div>';

		const locked = !lm && !p.hasKey && !keyOptional(p);
		let credentials;
		const acctPreset = p.auth === 'account' ? presetById(p.preset) : null;
		if (p.apiFormat === 'acp') {
			// A plan agent: the vendor's own software holds the login. Nothing to paste here.
			const ag = p.agent || {};
			const connection = agentConnectionState(p);
			const c = (S.acpCards || []).find((x) => x.id === ag.id);
			const verification = p.models.map((m) => S.tests[p.id + '::' + m.id]).find((t) => t && t.state === 'fail' && /verification|verify your account/i.test(t.error || ''));
			credentials =
				(verification ? '<div class="callout" role="alert">' + I('alert') + '<div><b>Account verification required</b><p>' + esc(verification.error) + '</p></div></div>' : '') +
				'<div class="acct-box' + (connection.ready ? '' : ' out') + '"><div class="ab-main">' + tile(preset || { tile: { text: p.name.slice(0, 2), bg: '#3f3f46' } }) + '<div class="ab-id"><b>' + esc(connection.title) + '</b>' +
				'<span>' + (ag.plan ? '<em class="si-plan">' + esc(String(ag.plan).replace(/^./, (ch) => ch.toUpperCase())) + '</em> plan · ' : '') + 'the vendor\'s agent keeps the login — zer0ne never sees a token, and removing this provider does not sign you out of the vendor\'s app.</span></div></div>' +
				'<div class="ab-actions"><button class="btn btn-secondary btn-sm" data-acp-signin="' + esc(ag.id || '') + '" data-acp-for="' + esc(p.id) + '">' + I('key') + 'Sign in again</button>' +
				(c && c.manageUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(c.manageUrl) + '">' + I('link') + 'Manage plan</button>' : '') + '</div></div>' +
				'<div class="callout info-callout">' + I('info') + '<div><b>This is an agent, not just a model.</b> It reads, edits files and runs commands on its own, under its own permission rules. zer0ne shows every step, asks you when the agent asks, and Undo / Review cover the files it changes. Plan mode and Chat mode ask it to stay read-only; not every agent can enforce that.</div></div>';
		} else if (acctPreset && acctPreset.account) {
			const a = p.account;
			const replacementAgent = { xai: 'grok-build', kimi: 'kimi', minimax: 'minimax-code' }[acctPreset.account];
			credentials =
				'<div class="acct-box' + (a ? '' : ' out') + '"><div class="ab-main">' + tile(acctPreset) + '<div class="ab-id"><b>' + (a ? 'Signed in' + (a.email ? ' as ' + esc(a.email) : '') : 'Signed out') + '</b>' +
				'<span>' + (a ? (a.plan ? '<em class="si-plan">' + esc(String(a.plan).replace(/^./, (c) => c.toUpperCase())) + '</em> plan' : esc(acctPreset.plans || '')) + ' · the sign-in refreshes by itself' : 'Sign in again to use these models.') + '</span></div></div>' +
				'<div class="ab-actions">' + (replacementAgent ? '<button class="btn btn-primary btn-sm" data-acp-signin="' + esc(replacementAgent) + '">' + I('key') + 'Connect vendor agent</button>' : '<button class="btn ' + (a ? 'btn-secondary' : 'btn-primary') + ' btn-sm" data-acct-signin="' + esc(acctPreset.account) + '" data-acct-for="' + esc(p.id) + '">' + I('key') + (a ? 'Sign in again' : 'Sign in') + '</button>') +
				(a ? '<button class="btn btn-ghost btn-sm" data-act="account-signout">Sign out</button>' : '') + '</div></div>' +
				'<div class="conn-row"><button class="btn btn-secondary btn-sm" data-act="check-provider"' + (check && check.running ? ' disabled' : '') + '>' + (check && check.running ? '<span class="spinner"></span>' : I('plug')) + 'Check connection</button>' +
				(check && !check.running ? (check.ok ? '<span class="conn ok">' + I('check') + 'Checked · ' + (check.ms / 1000).toFixed(1) + ' s</span>' : '<span class="conn fail" title="' + esc(check.error) + '">' + I('alert') + esc(String(check.error).slice(0, 140)) + '</span>') : '<span class="muted conn-hint">Model list and one short reply (uses quota). The session renews automatically.</span>') + '</div>' +
				(check && !check.running && check.steps ? '<ul class="acct-steps">' + check.steps.map((st) => '<li class="' + (st.ok ? 'ok' : 'fail') + '">' + I(st.ok ? 'check' : 'alert') + '<span>' + esc(st.text) + '</span></li>').join('') + '</ul>' : '');
		} else if (lm) {
			credentials =
				'<div class="callout ok-callout">' + I('shield') + '<div><b>Signed in through VS Code.</b> Models come from your VS Code language-model providers (e.g. GitHub Copilot: Claude, GPT, Gemini). VS Code asks for your consent the first time zer0ne uses them — no keys are stored here.</div></div>';
		} else {
			const keyState = p.hasKey
				? '<span class="key-state ok">· ' + (oauth ? 'signed in with OpenRouter' : p.keys > 1 ? 'pool of ' + p.keys + ' keys — rotates on rate limits' : 'saved in OS keychain') + '</span>'
				: isLocal(p)
					? '<span class="key-state">· optional for local servers</span>'
					: '<span class="key-state missing">· not set</span>';
			credentials =
				'<div class="field"><div class="field-label">Base URL</div><input id="f-baseurl" class="input mono" value="' + esc(p.baseUrl) + '" placeholder="https://api.example.com/v1" spellcheck="false" autocomplete="off"><div class="field-hint">' + endpointHint(p) + '</div></div>' +
				'<div class="field"><div class="field-label">API format</div><select id="f-format" class="select"><option value="openai"' + (p.apiFormat === 'openai' ? ' selected' : '') + '>OpenAI format — /v1/chat/completions (OpenAI, DeepSeek, GLM, Kimi, Qwen, Ollama, LM Studio, vLLM, OpenRouter…)</option><option value="responses"' + (p.apiFormat === 'responses' ? ' selected' : '') + '>OpenAI Responses — /v1/responses</option><option value="anthropic"' + (p.apiFormat === 'anthropic' ? ' selected' : '') + '>Anthropic format — /v1/messages (Claude, and Anthropic-compatible endpoints from GLM, Kimi, MiniMax…)</option><option value="gemini"' + (p.apiFormat === 'gemini' ? ' selected' : '') + '>Gemini native — :streamGenerateContent (Google AI Studio)</option><option value="bedrock"' + (p.apiFormat === 'bedrock' ? ' selected' : '') + '>AWS Bedrock — Claude with a Bedrock API key</option><option value="vertex"' + (p.apiFormat === 'vertex' ? ' selected' : '') + '>Google Vertex AI — Claude & Gemini (gcloud)</option></select></div>' +
				'<div class="field"><div class="field-label">API key ' + keyState + '<span class="spacer"></span>' +
				(p.catalogId === 'openrouter' ? '<button class="btn btn-ghost btn-sm" data-act="oauth-openrouter">' + I('key') + (oauth ? 'Sign in again' : 'Sign in with OpenRouter') + '</button>' : '') +
				(preset && preset.keyUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(preset.keyUrl) + '">' + I('link') + 'Get a key</button>' : '') +
				'</div><div class="input-wrap"><input id="f-key" class="input mono" type="' + (S.keyVisible ? 'text' : 'password') + '" placeholder="' + (p.hasKey ? '•••••••••••••••• — paste to replace' : 'Paste your API key') + '" autocomplete="off" spellcheck="false">' +
				'<button class="icon-btn" data-act="toggle-key" title="' + (S.keyVisible ? 'Hide' : 'Show') + '">' + I(S.keyVisible ? 'eyeOff' : 'eye') + '</button></div>' +
				'<div class="field-hint">Stored encrypted with a key your operating system protects; never sent to the chat UI. Press Enter or leave the field to save. Several keys separated by commas form a <b>key pool</b>: a rate-limited or exhausted key hands over to the next.</div></div>' +
			'<div class="conn-row"><button class="btn btn-secondary btn-sm" data-act="check-provider"' + (check && check.running ? ' disabled' : '') + '>' + (check && check.running ? '<span class="spinner"></span>' : I('plug')) + 'Check connection</button>' +
			(check && !check.running ? (check.ok ? '<span class="conn ok">' + I('check') + 'Connected · ' + check.count + ' models available · ' + check.ms + ' ms</span>' : '<span class="conn fail" title="' + esc(check.error) + '">' + I('alert') + esc(String(check.error).slice(0, 140)) + '</span>') : '<span class="muted conn-hint">Checks the URL and key without spending tokens.</span>') + '</div>';
		}

		d.innerHTML =
			'<div class="detail-head">' + tile(preset, p.name) +
			'<input id="f-name" class="name-input" value="' + esc(p.name) + '" maxlength="80" spellcheck="false" aria-label="Provider name" title="Click to rename">' +
			'<label class="switch" title="' + (p.enabled ? 'Provider enabled' : 'Provider disabled') + '"><input type="checkbox" id="f-enabled"' + (p.enabled ? ' checked' : '') + '><span class="track"></span></label>' +
			'<div class="menu-anchor"><button class="icon-btn" data-act="provider-menu" title="More actions">' + I('more') + '</button>' +
			'<div id="provider-menu" class="popover menu down right hidden">' +
			(p.hasKey && !lm && p.apiFormat !== 'acp' ? '<button class="menu-item" data-act="clear-key">' + I('eyeOff') + '<span class="grow">Remove API key</span></button>' : '') +
			'<button class="menu-item" data-act="duplicate-provider">' + I('copy') + '<span class="grow">Duplicate provider</span></button>' +
			'<button class="menu-item" data-act="refresh-model-info">' + I('refresh') + '<span class="grow">Refresh model info (limits, prices)</span></button>' +
			'<button class="menu-item danger" data-act="delete-provider">' + I('trash') + '<span class="grow">Delete provider</span></button></div></div></div>' +
			healthBanner(p) +
			credentials +
			'<div class="field"><div class="field-label">Model list<span class="spacer"></span>' +
			'<button class="btn btn-ghost btn-sm" data-act="fetch-models"' + (fetching || (!p.baseUrl && !lm) || locked ? ' disabled' : '') + ' title="' + (locked ? 'Save the API key first' : 'List models from the endpoint') + '">' + (fetching ? '<span class="spinner"></span>' : I('refresh')) + 'Fetch models</button>' +
			'<button class="btn btn-secondary btn-sm" data-act="add-model"' + (locked ? ' disabled title="Save the API key first"' : '') + '>' + I('plus') + 'Add model</button></div>' +
			(locked ? '<div class="callout warn-callout key-lock">' + I('key') + '<div><b>Add your API key first.</b> Models can be fetched or added once the key for ' + esc(p.name) + ' is saved above.' + (preset && preset.keyUrl ? ' <button class="link-btn" data-act="open-url" data-url="' + esc(preset.keyUrl) + '">Get a key ↗</button>' : '') + '</div></div>' : '') +
			models + '</div>' +
			'<details class="advanced" data-key="adv-' + esc(p.id) + '"><summary>' + I('chevronRight') + 'Advanced</summary><div class="adv-body"><div class="grid-2">' +
			'<div class="field"><div class="field-label">Weekly token budget</div><input id="f-weekly" class="input mono" type="number" min="0" step="10000" placeholder="1000000" value="' + (p.weeklyTokenLimit || '') + '"></div>' +
			'<div class="field"><div class="field-label">5-hour token budget</div><input id="f-fivehour" class="input mono" type="number" min="0" step="10000" placeholder="200000" value="' + (p.fiveHourTokenLimit || '') + '"></div>' +
			'</div><div class="field-hint">Soft budgets for the rings on the Usage page.' + (p.catalogId ? ' Catalog preset: <code>' + esc(p.catalogId) + '</code>.' : '') + '</div></div></details>';
		return d;
	}

	// ------------------------------------------------------------ Browser / Agent

	function browserPage() {
		const root = h('div', 'page');
		root.appendChild(header('Browser use', 'Web access for the agent, called only when a task needs it — use the preview below to inspect its latest screenshot and activity.'));
		root.appendChild(h('div', 'section-label', 'Browser agent'));
		const found = S.browser.found;
		root.appendChild(
			h(
				'div',
				'card',
				switchRow('Enable browser agent', 'Test web apps in Chrome/Edge with dedicated agent tabs, frame-aware snapshots and batched actions. Sign in once in this app profile to reuse that login; your everyday browser profile stays separate.', 'browserAgent') +
					switchRow('Run headless', 'Work in the background with screenshots. Turn off to watch the browser or sign into a site.', 'browserHeadless', !S.settings.browserAgent) +
					'<div class="setting-row"><div class="text"><div class="name">Browser executable</div><div class="desc">' + (found ? 'Detected: <code>' + esc(found) + '</code>' : 'No Chrome/Edge/Brave found — set the path.') + '</div></div><div class="control"><input id="s-browserPath" class="input mono" data-setting="browserPath" placeholder="auto-detect" value="' + esc(S.settings.browserPath || '') + '"></div></div>' +
						'<div class="setting-row"><div class="text"><div class="name">Allowed browser hosts</div><div class="desc">One host per line (subdomains included); empty allows any host. The agent\'s browser refuses to open anything else.</div></div><div class="control"><textarea id="s-browserAllowHosts" class="input mono" rows="2" data-setting="browserAllowHosts" placeholder="example.com">' + esc(S.settings.browserAllowHosts || '') + '</textarea></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Status</div><div class="desc">' + (S.browser.active ? '<span class="dot green"></span> The agent browser is open.' : 'Idle — starts on the first browser action.') + '</div></div><div class="control"><button class="btn btn-primary btn-sm" data-act="browser-test">Test launch / refresh</button><button class="btn btn-secondary btn-sm" data-act="browser-close"' + (S.browser.active ? '' : ' disabled') + '>Close browser</button></div></div>'
			)
		);
		const preview = S.browser.preview;
        if (preview) root.appendChild(h('section', 'card browser-preview', '<div class="setting-row"><div><b>' + esc(preview.title || 'Browser preview') + '</b><p>' + esc(preview.url) + ' · ' + esc(new Date(preview.at).toLocaleString()) + '</p></div></div>' + (preview.thumbnail?.startsWith('data:image/jpeg;base64,') ? '<img class="browser-shot" alt="Latest agent browser screenshot" src="' + esc(preview.thumbnail) + '">' : '') + '<p class="muted">Snapshot from the agent’s separate browser profile.</p>'));
        root.appendChild(h('details', 'card', '<summary>Browser activity</summary><pre class="pre-wrap">' + esc((S.browser.activity || []).join('\n') || 'No browser activity yet.') + '</pre>'));
        root.appendChild(h('div', 'section-label', 'Web research'));
		root.appendChild(
			h(
				'div',
				'card',
				switchRow('Web search & fetch', 'Gives the agent <code>web_search</code> and <code>web_fetch</code> (pages become readable markdown; 5 MB / 30 s limits).', 'browserTools') +
					selectRow('Search engine', 'Exa needs no key; the other engine is used automatically as a fallback.', 'searchEngine', [['exa', 'Exa (recommended)'], ['duckduckgo', 'DuckDuckGo']]) +
					switchRow('Open pages for me', 'Allows <code>open_url</code> to open a page for you.', 'openPages')
			)
		);
		root.appendChild(h('div', 'callout', I('info') + '<div>Browser tools: <code>browser_navigate</code>, <code>browser_click</code>, <code>browser_type</code>, <code>browser_press</code>, <code>browser_scroll</code>, <code>browser_snapshot</code>, <code>browser_console</code>, <code>browser_evaluate</code>. Each step returns a screenshot (sent to vision models) and numbered clickable elements; thumbnails appear in the chat — click to enlarge.</div>'));
		return root;
	}

	function agentPage() {
		const root = h('div', 'page');
		root.appendChild(header('Agent', 'The main agent follows your chat. Subagents help with delegated tasks.'));
		const tab = S.agentTab === 'subagents' ? 'subagents' : 'behavior';
		root.appendChild(capabilityTabs([['behavior', 'Behavior'], ['subagents', 'Subagents']], tab, 'data-agent-tab', 'Agent settings'));
		if (tab === 'subagents') {
			root.appendChild(h('div', 'card', switchRow('Enable subagents', 'Let the main agent delegate focused tasks. Each subagent has a separate conversation and reports back.', 'subagents')));
			const sub = subagentsPage(true);
			for (const child of [...sub.childNodes]) root.appendChild(child);
			return root;
		}
		const runtimeNumber = (key, label, description, max, step) => '<div class="setting-row"><div class="text"><div class="name">' + esc(label) + '</div><div class="desc">' + esc(description) + '</div></div><div class="control"><input class="input" type="number" min="' + (key.includes('Concurrency') ? 1 : 0) + '" max="' + max + '" step="' + (step || 1) + '" data-setting="' + key + '" value="' + Number(S.settings[key] || 0) + '"></div></div>';

		root.appendChild(
			h(
				'div',
				'card',
				switchRow('Terminal commands', 'Gives the agent <code>run_command</code>. Every command needs your approval unless the chat is in Full access mode or it is auto-approved below.', 'commandTool') +
					switchRow('Project instructions', 'Include <code>AGENTS.md</code> / <code>CLAUDE.md</code> from the workspace root in the agent prompt.', 'includeAgentsMd') +
					'<div class="setting-row stacked"><div class="text"><div class="name">Custom instructions</div><div class="desc">Added to every conversation (chat and agent): language, code style, frameworks…</div></div><textarea id="s-customInstructions" class="textarea" data-setting="customInstructions" placeholder="Always answer in English. Prefer TypeScript and small functions.">' + esc(S.settings.customInstructions || '') + '</textarea></div>'
			)
		);
		root.appendChild(h('div', 'section-label', 'Safety'));
		root.appendChild(
			h(
				'div',
				'card',
				(desktopHost() ? '' : switchRow('Review edits in the editor', 'A pending edit opens as a diff in the editor: revert single blocks with the gutter arrows (or tweak the code), then Accept in the chat or the editor title. What stays in the file is what gets saved.', 'reviewInEditor')) +
					switchRow('Hide secrets from the model', 'API keys, tokens, passwords, private keys and credentials in URLs are masked before file contents or command output are sent to the provider. Writes that would put a masked value back are refused.', 'redactSecrets') +
					switchRow('Only essential network', 'Skips background model catalogs, deal feeds, Intelligence data and provider-status probes; the last copy is kept. Model requests, Cloud tasks, search and local services are unaffected.', 'disableNonessentialNetwork') +
					switchRow('Fetch only links you shared', 'web_fetch opens just the URLs you wrote in the chat — a page it read cannot steer the next fetch anywhere (a prompt-injection guard). Search results and links found in pages are reported, not fetched.', 'webfetchProvenance') +
					switchRow('Only zero-retention models', 'OpenRouter requests are routed only to zero-retention providers (data_collection: deny). If none serves the model, the request fails instead of silently using one that keeps or trains on your data. Direct providers keep their own terms.', 'zeroRetentionOnly') +
					'<div class="setting-row stacked"><div class="text"><div class="name">Deny rules</div><div class="desc">Paths the agent can never read, write, search or list — one pattern per line (<code>**/*.pem</code>, <code>secrets/</code>, <code>.env.production</code>).</div></div><textarea id="s-denyPaths" class="textarea mono" data-setting="denyPaths" rows="5" spellcheck="false">' + esc(S.settings.denyPaths || '') + '</textarea></div>'
			)
		);
		root.appendChild(h('div', 'section-label', 'Check the work'));
		root.appendChild(
			h(
				'div',
				'card',
				(desktopHost() ? '' : switchRow('Check errors after edits', 'When the agent finishes, VS Code errors in the files it changed are sent back to it to fix (up to 2 rounds).', 'verifyDiagnostics')) +
				switchRow('Auto-detect verify command', 'When Verify command is empty, automatically detect and run project checks (cargo check, npm test, tsc, pytest, go test) based on changed files.', 'verifyAutoDetect') +
					'<div class="setting-row"><div class="text"><div class="name">Verify command</div><div class="desc">Runs after edits, e.g. <code>npm test</code> or <code>cargo check</code>. Leave empty to auto-detect.</div></div><div class="control"><input id="s-verifyCommand" class="input mono" data-setting="verifyCommand" placeholder="auto (cargo check, npm test…)" spellcheck="false" value="' + esc(S.settings.verifyCommand || '') + '"></div></div>'
			)
		);
		const fb = String(S.settings.fallbackModels || '').split('\n').map((x) => x.trim()).filter(Boolean);
		const modelLabel = (v) => {
			const [pid, mid] = v.split('::');
			const p = (S.providers || []).find((x) => x.id === pid);
			return (p ? p.name : 'Deleted provider') + ' / ' + (mid || '?');
		};
		const choices = (S.providers || []).filter((p) => p.enabled !== false).flatMap((p) => (p.models || []).filter((m) => m.enabled !== false).map((m) => [p.id + '::' + m.id, p.name + ' / ' + m.id])).filter(([v]) => !fb.includes(v));
		root.appendChild(h('div', 'section-label', 'Reliability'));
		root.appendChild(
			h(
				'div',
				'card',
				switchRow('Retry on temporary errors', 'Rate limits, overloaded providers, quota and network errors are retried twice with a short backoff (never after text has started streaming).', 'retryErrors') +
					switchRow('Never substitute a model', 'When the chosen model fails, stop and show the error instead of continuing on a fallback or the local helper. The kill switch for model substitution (also honored as environment variable ZER0NE_NO_MODEL_FALLBACK=1).', 'noModelFallback') +
					'<div class="setting-row stacked"><div class="text"><div class="name">Fallback models</div><div class="desc">If the chosen model keeps failing, the agent continues with these, in order, and tells you it switched.</div></div>' +
					'<div class="fb-list">' +
					(fb.length ? fb.map((v, i) => '<div class="fb-row"><span class="badge mono">' + (i + 1) + '</span><span class="grow">' + esc(modelLabel(v)) + '</span><button class="icon-btn" data-act="fb-remove" data-i="' + i + '" title="Remove">' + I('close') + '</button></div>').join('') : '<div class="ca-empty">No fallback models.</div>') +
					'<select id="fb-add" class="select"><option value="">Add a fallback model…</option>' + choices.map(([v, l]) => '<option value="' + esc(v) + '">' + esc(l) + '</option>').join('') + '</select></div></div>'
			)
		);
		root.appendChild(h('div', 'section-label', 'Auto-approve in Agent mode'));
		root.appendChild(
			h(
				'div',
				'card',
				switchRow('File edits', 'Apply edits, new files, patches, moves and deletes without asking (Undo stays available on every turn).', 'autoApproveEdits') +
					switchRow('All terminal commands', 'Run every command without asking. Leave off and use the allowlist below for safer control.', 'autoApproveCommands') +
					switchRow('MCP tools', 'Call tools from every MCP server without asking (you can also trust single servers).', 'autoApproveMcp') +
					'<div class="setting-row stacked"><div class="text"><div class="name">Command allowlist</div><div class="desc">One command prefix per line; a command starting with one of them runs without asking. Commands that chain, pipe, redirect or substitute (<code>;</code> <code>&amp;</code> <code>|</code> <code>&gt;</code> <code>$(…)</code> <code>(…)</code>) always ask.</div></div><textarea id="s-commandAllowlist" class="textarea mono" data-setting="commandAllowlist" rows="6" spellcheck="false">' + esc(S.settings.commandAllowlist || '') + '</textarea></div>'
			)
		);
		const sbs = S.sandbox && S.sandbox.status;
		if (!S.sandbox && !S.sandboxAsked) {
			S.sandboxAsked = true;
			post({ type: 'sandboxStatus' });
		}
		const sbLine = !sbs
			? '<span class="muted">Checking…</span>'
			: sbs.available
				? '<span class="dot ' + (sbs.reads === 'all' ? 'orange' : 'green') + '"></span><span>Active: ' + esc(sbs.detail) + '</span>' +
					(sbs.kind === 'restricted' && !S.isRemote
						? (sbs.denyStale ? '<button class="btn btn-secondary btn-sm" data-act="sandbox-prepare">' + I('shield') + 'Prepare again</button>' : '') + '<button class="btn btn-ghost btn-sm" data-act="sandbox-unprepare">Remove sandbox access</button>'
						: '')
				: sbs.needsPrepare
					? '<span class="dot orange"></span><span>' + esc(sbs.detail) + '</span>' + (S.isRemote ? '' : '<button class="btn btn-secondary btn-sm" data-act="sandbox-prepare">' + I('shield') + 'Prepare project</button>')
					: '<span class="dot red"></span><span>Unavailable: ' + esc(sbs.detail) + '</span>';
		root.appendChild(h('div', 'section-label', 'Command sandbox'));
		root.appendChild(
			h(
				'div',
				'card',
					selectRow(
						'Sandbox',
						'Runs commands inside an OS sandbox: they write only inside the workspace and temp, and can be stopped from reading chosen paths below. <b>Auto</b> boxes the commands that run without asking (allowlist, auto-approve, Full access). <b>Always</b> boxes every command — and boxed commands then run without a card. Leaving the sandbox always asks. On Windows, prepare each project once; the network stays reachable there. When a secure sandbox is unavailable, Agent mode commands require approval. Full access permits unrestricted execution.',
						'sandbox',
						[['auto', 'Auto'], ['always', 'Always'], ['off', 'Off']]
					) +
						(S.sandbox && S.sandbox.platform === 'win32' ? '' : switchRow('Network in the sandbox', 'Let sandboxed commands reach the network (npm install, git fetch…). Off blocks it (macOS / Linux).', 'sandboxNetwork')) +
						switchRow('Hide secrets from agent commands', 'Commands the agent runs start without environment variables that look like API keys, tokens or passwords, so a command cannot print them into the chat. Turn off when a command needs one (for example <code>GH_TOKEN</code>).', 'hideCommandSecrets') +
						'<div class="setting-row"><div class="text"><div class="name">Paths commands cannot read</div><div class="desc">One per line; <code>~</code> is your home folder. Keeps credentials out of reach of sandboxed commands. The app’s own keys, settings, chats and checkpoints are always blocked. On Windows, prepare the project again after changing this.</div></div><div class="control" style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><textarea class="input mono" rows="3" data-setting="sandboxDenyRead" placeholder="~/.ssh&#10;~/.aws">' + esc(S.settings.sandboxDenyRead || '') + '</textarea><button class="btn btn-secondary btn-sm" data-act="sandbox-deny-recommended">Use recommended list</button></div></div>' +
					'<div class="setting-row"><div class="text"><div class="name">Status</div><div class="desc sandbox-status">' + sbLine + '</div></div></div>'
			)
		);
		if (!S.commandRulesAsked) {
			S.commandRulesAsked = true;
			post({ type: 'commandRulesStatus' });
		}
		const cr = S.commandRules;
		const crCount = cr && cr.exists ? [['allow', cr.rules.allow.length], ['ask', cr.rules.ask.length], ['deny', cr.rules.deny.length]].filter(([, n]) => n).map(([k, n]) => n + ' ' + k).join(', ') : '';
		const crLine = cr === undefined
			? '<span class="muted">Checking…</span>'
			: !cr || !cr.exists
				? '<span class="muted">This project has no <code>.zer0ne/command-rules</code> file.</span>'
				: cr.pendingAllow.length
					? '<span class="dot orange"></span><span>' + esc(crCount || 'No rules') + '. Not trusted yet, so these still ask: ' + cr.pendingAllow.slice(0, 4).map((l) => '<code>' + esc(l) + '</code>').join(' ') + (cr.pendingAllow.length > 4 ? ' …' : '') + '</span>' + (S.isRemote ? '' : '<button class="btn btn-secondary btn-sm" data-act="rules-trust">' + I('shield') + 'Trust rules</button>')
					: '<span class="dot green"></span><span>' + esc(crCount || 'No rules') + (cr.trusted ? ' · trusted' : '') + (cr.kept.length ? ' · still applying rules the file dropped: ' + cr.kept.map((l) => '<code>' + esc(l) + '</code>').join(' ') : '') + '</span>' + (cr.trusted && !S.isRemote ? '<button class="btn btn-ghost btn-sm" data-act="rules-untrust">Stop trusting</button>' : '');
		root.appendChild(h('div', 'section-label', 'Project command rules'));
		root.appendChild(h('div', 'card', '<div class="setting-row"><div class="text"><div class="name">.zer0ne/command-rules</div><div class="desc">A project can say which commands always ask (<code>ask:</code>) or never run (<code>deny:</code>); those apply at once. Lines that let a command run without a card (<code>allow:</code>) come with the repository, so they apply only after you trust them, and again after any change to them.</div><div class="desc sandbox-status">' + crLine + '</div></div></div>'));
		root.appendChild(h('div', 'callout', I('shield') + '<div><b>Permissions</b> (picked in the composer): <b>Chat</b> answers without tools. <b>Agent</b> reads, searches and browses freely but asks before editing files, running commands or calling untrusted MCP tools. <b>Full access</b> approves everything automatically. <b>Plan mode</b> (＋ menu or <code>/plan</code>) is read-only and returns a plan.</div>'));
		const advanced = h('details', 'agent-advanced', '<summary>Advanced execution &amp; task limits</summary>');
		advanced.appendChild(h('div', 'card',
			switchRow('Stable request prefixes', 'Keep tool definitions in a consistent order and append the current date to new context. Changed instructions and permissions still take effect. Provider cache reuse is measured separately.', 'stablePrefix') +
			runtimeNumber('toolConcurrency', 'Parallel reads', 'Shared capacity for independent workspace reads. Writes wait for active reads.', 64) +
			runtimeNumber('mcpConcurrency', 'Parallel MCP reads', 'Shared capacity for tools declared read-only by their server. Other MCP calls run exclusively.', 64) +
			runtimeNumber('childConcurrency', 'Active child agents', 'Shared capacity for subagent and isolated writer loops.', 64) +
			runtimeNumber('modelConcurrency', 'Active model requests', 'Shared capacity for chat, child and task helper model requests.', 64) +
			runtimeNumber('taskBudgetCost', 'Task cost limit (USD)', '0 disables this limit. An estimate shared by the lead, children, retries, summaries and cache warming. Unknown prices or billing stop further requests when enabled.', 1000000, 0.01) +
			runtimeNumber('taskBudgetTokens', 'Task token limit', '0 disables this limit. Counts input and output across requests; reserves a conservative allowance before each call.', 1000000000) +
			runtimeNumber('taskBudgetRequests', 'Task request limit', '0 disables this limit. Every dispatched attempt, including retries, counts.', 1000000000) +
			runtimeNumber('taskBudgetSeconds', 'Task time limit (seconds)', '0 disables this limit. Stops model requests and tools that support cancellation. Completed changes are retained.', 604800)));
		root.appendChild(advanced);
		return root;
	}

	// ------------------------------------------------------------ Features

	function featureItems() {
		return (S.featureCatalog || []).filter(f => !(S.isRemote && f.key === 'remoteEnabled'));
	}
	function featureHealth(definition) { return S.health?.items?.find(item => item.id === definition.check); }
	function featureStatus(definition) {
		if (!S.settings[definition.key]) return { label:'Off', kind:'off' };
		if (definition.scope === 'project' && !S.workspace?.path) return { label:'Open a local project', kind:'setup' };
		if (definition.action && definition.action !== 'language' && S.mode === 'chat') return { label:'Requires Agent mode', kind:'setup' };
		if ((definition.requires || []).some(key => !S.settings[key])) return { label:'Needs setup', kind:'setup' };
		const run = definition.action && (S.featureReports || []).filter(r => r.kind === definition.action && !r.stale && r.configuration === S.featureConfiguration).sort((a,b) => b.startedAt-a.startedAt)[0];
		if (run) return {label:run.status === 'passed' ? 'Last run passed' : run.status === 'failed' ? 'Last run failed' : run.status === 'running' ? 'Running' : 'Run cancelled',kind:run.status === 'passed' ? 'available' : run.status === 'failed' ? 'problem' : 'unknown'};
		const item = featureHealth(definition);
		if (!item || S.health?.stale) return { label:'Not checked', kind:'unknown' };
		if (item.state === 'fail' || item.readiness === 'problem') return { label:'Needs attention', kind:'problem' };
		if (item.readiness === 'setup') return { label:'Needs setup', kind:'setup' };
		return { label:item.evidence === 'configuration' ? 'Configured' : item.evidence === 'measurement' ? 'Measured' : 'Available', kind:'available' };
	}
	function requestFeaturesHealth(manual) {
		if (S.healthBusy) return;
		const requestId = 'health-' + Date.now() + '-' + (S.featureSequence = (S.featureSequence || 0) + 1);
		S.healthBusy = true; S.featureHealthId = requestId;
		clearTimeout(S.featureHealthTimer);
		S.featureHealthTimer = setTimeout(() => {
			if (S.featureHealthId !== requestId || !S.healthBusy) return;
			S.healthBusy = false; S.featureHealthError = 'The check timed out. Retry when the connection is available.';
			post({type:'featuresCancel'}); if (S.open && S.section === 'features') renderPage();
		},20000);
		post({type:'featuresCheck',requestId,revision:S.featureRevision || 0,manual:manual === true});
	}
	function healthPanel() {
		const health = S.health, items = health?.items || [];
		const problems = items.filter(item => item.readiness === 'problem' || item.readiness === 'setup').length;
		const wrap = h('section','card feature-health-panel');
		wrap.innerHTML = '<div class="feature-health-heading"><span class="fc-icon">' + I('shield') + '</span><div class="grow"><h3>Capability checks</h3><p>' +
			(S.healthBusy ? 'Checking configuration and local dependencies…' : S.featureHealthError ? esc(S.featureHealthError) : health ? esc(health.stale ? 'Configuration changed. Results need refreshing.' : 'Checked ' + since(health.at)) + ' · ' + items.length + ' results · ' + problems + ' need setup or attention' : 'Inspect setup, discovery and measured usage. Execution tests are separate actions.') +
			'</p></div><button class="btn btn-secondary btn-sm" data-act="features-check"' + (S.healthBusy ? ' disabled' : '') + '>' + I('refresh') + 'Check now</button>' +
			(S.healthBusy ? '<button class="btn btn-ghost btn-sm" data-act="features-cancel">Cancel</button>' : '') + (S.featureRunning ? '<button class="btn btn-secondary btn-sm" data-act="feature-stop">Stop current run</button>' : '') + '</div><p class="feature-check-note">Automatic checks spend no model tokens, run no project scripts and send no desktop input. Manual checks may test network reachability.</p>';
		return wrap;
	}
	const { featuresPage, reviewFeaturePlan, confirmBenchmark } = window.SettingsFeatures.create({ I, S, capabilityHeader, capabilityStats, capabilityTabs, esc, featureHealth, featureItems, featureStatus, h, healthPanel, indexSection, openDialog, post, renderPage, requestFeaturesHealth, since: (...a) => since(...a), sw });
		function fitBadge(fit) {
		const f = FIT[fit];
		return f ? '<span class="fit-badge ' + f[0] + '">' + esc(f[1]) + '</span>' : '';
	}
	const eta = (job) => {
		if (!job.rate || !job.total) return '';
		const sec = Math.max(0, (job.total - job.received) / job.rate);
		return sec < 60 ? Math.ceil(sec) + ' s left' : sec < 3600 ? Math.ceil(sec / 60) + ' min left' : (sec / 3600).toFixed(1) + ' h left';
	};
	/** Bytes as GB or MB: model, engine and download sizes. */
	const gb = (b) => (b >= 1e9 ? (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB' : Math.max(1, Math.round(b / 1e6)) + ' MB');

	function jobBar(job) {
		if (!job) return '';
		const pct = job.total ? Math.floor((job.received / job.total) * 100) : 0;
		return (
						'<div class="pull-row" data-job="' + esc(job.key) + '"><div class="pull-top"><span class="pull-pct">' + (job.total ? pct + '%' : '<span class="spinner"></span>') + '</span><span class="muted mono">' +
				(job.total ? gb(job.received) + ' / ' + gb(job.total) + (job.rate ? ' · ' + gb(job.rate) + '/s' : '') + (eta(job) ? ' · ' + eta(job) : '') : esc(job.stage || 'starting…')) +
				'</span><span class="grow"></span><button class="link-btn" data-act="job-cancel" data-key="' + esc(job.key) + '" title="' + (/^hf:/.test(job.key) ? 'Pause — press Download again to resume where it stopped' : 'Cancel') + '">' + (/^hf:/.test(job.key) ? 'Pause' : 'Cancel') + '</button></div>' +
				'<div class="pull-bar' + (job.total ? '' : ' indeterminate') + '"><span data-width="' + pct + '"></span></div></div>'
		);
	}
	// Kept for the Ollama rows (keyed by tag).
	function pullBar(tag) {
		return jobBar((S.localJobs || {})['ollama:' + tag]);
	}

	let localFrame = 0;
	let localTimer = 0;
	/** Local-models messages arrive in bursts (progress, engine state): paint at most once per frame. */
	function renderLocal() {
		if (!(S.open && S.section === 'local') || localFrame || localTimer) return;
		const paint = () => {
			if (localFrame) cancelAnimationFrame(localFrame);
			localFrame = 0;
			clearTimeout(localTimer);
			localTimer = 0;
			if (S.open && S.section === 'local') renderPage();
		};
		localFrame = requestAnimationFrame(paint);
		// Electron can pause animation frames in an occluded window while messages still arrive.
		localTimer = setTimeout(paint, 100);
	}

	const LOCAL_SERVERS = {
		lmstudio: ['https://lmstudio.ai/download', 'Desktop app with its own model library. zer0ne loads its models through the lms CLI.'],
		llamacpp: ['https://github.com/ggml-org/llama.cpp/releases', 'A llama-server you run yourself on port 8080.'],
		vllm: ['https://docs.vllm.ai/en/latest/getting_started/installation/', 'High-throughput server for NVIDIA GPUs (Linux / WSL).'],
		jan: ['https://jan.ai/download', 'Open-source desktop app — turn on its local API server (port 1337).'],
		kobold: ['https://github.com/LostRuins/koboldcpp/releases', 'Single-file llama.cpp runner with an OpenAI API on port 5001.'],
		gpt4all: ['https://www.nomic.ai/gpt4all', 'Desktop app — turn on Settings → Application → Enable Local API Server (port 4891).'],
		lemonade: ['https://lemonade-server.ai', 'AMD\'s local server for Ryzen AI and Radeon (llama.cpp Vulkan / NPU) on port 8000.'],
		textgen: ['https://github.com/oobabooga/text-generation-webui', 'Start it with --api to expose the OpenAI API on port 5000.']
	};
	const ctxLabel = (n) => (n >= 1024 ? Math.round(n / 1024) + 'K' : String(n));

	function runtimeDisclosure(key, title, description, html) {
		const details = h('details', 'runtime-disclosure');
		details.dataset.runtimeSection = key;
		details.open = !!(S.runtimeSections || {})[key];
		details.innerHTML = '<summary><span><b>' + esc(title) + '</b><small>' + esc(description) + '</small></span>' + I('chevronDown') + '</summary><div class="runtime-disclosure-body">' + (html || '') + '</div>';
		details.addEventListener('toggle', () => { (S.runtimeSections = S.runtimeSections || {})[key] = details.open; });
		return details;
	}
	const L_PLATFORM = () => ((S.localModels && S.localModels.machine && S.localModels.machine.platform) || '');

	/** Runtimes & servers → the voice engine (sherpa-onnx): status only — it runs per request, nothing stays loaded. */
	function voiceEngineCard() {
		const v = S.studio && S.studio.voiceEngine;
		if (!v) return '';
		const job = (S.localJobs || {})['voice-engine'];
		return (
			'<div class="rt-card"><div class="rt-head"><div class="rt-logo">' + I('volume') + '</div><div class="grow"><div class="rt-name">Voice engine</div>' +
			'<div class="rt-desc">sherpa-onnx (Apache-2.0) — turns text into speech with the voices you pick in the chat. Runs on the CPU, only while it speaks; it installs itself with your first voice.</div></div></div>' +
			'<div class="rt-status">' + (!v.supported ? '<span class="dot"></span>No build for this system' : v.installed ? '<span class="dot green"></span>Installed · ' + esc(v.version || '') : '<span class="dot"></span>Not installed — it installs with your first voice') + '</div>' +
			(job ? '<div class="rt-controls">' + jobBar(job) + '</div>' : '') +
			'</div>'
		);
	}

	/** Runtimes & servers → the image & video engine (stable-diffusion.cpp): status, build, what is loaded. */
	function studioEngineCard() {
		const s = S.studio;
		if (!s) return '';
		const job = (S.localJobs || {})['studio-engine'];
		const loaded = s.bundle && s.bundles.find((b) => b.id === s.bundle);
		const backends = L_PLATFORM() === 'darwin' ? [['auto', 'Auto (Metal)']] : [['auto', 'Auto (Vulkan)'], ['vulkan', 'Vulkan · any GPU'], ['cuda', 'CUDA · NVIDIA'], ['rocm', 'ROCm · AMD'], ['cpu', 'CPU only']];
		return (
			'<div class="rt-card"><div class="rt-head"><div class="rt-logo">' + I('image') + '</div><div class="grow"><div class="rt-name">Image &amp; video engine</div>' +
			'<div class="rt-desc">stable-diffusion.cpp (MIT) — runs the image and video models you pick in the chat\'s model menu. It installs itself with your first image or video model and only runs while you generate.</div></div></div>' +
			'<div class="rt-status">' + (!s.supported ? '<span class="dot"></span>No build for this system (Linux on ARM, Intel Macs and Windows on ARM have none)' : s.installed ? '<span class="dot green"></span>Installed · ' + esc(s.backend) + ' · ' + esc((s.version || '').replace(/^master-\d+-/, '')) : '<span class="dot"></span>Not installed — it installs with your first image or video model') + '</div>' +
			(loaded ? '<div class="rt-run"><span class="dot' + (s.ready ? ' green' : '') + '"></span><b>' + esc(loaded.name) + '</b><span>' + (s.ready ? 'loaded' : 'loading…') + '</span><span class="grow"></span>' + (s.ready ? '<button class="btn btn-ghost btn-sm" data-act="st-web" title="stable-diffusion.cpp\'s own web UI: every option (samplers, LoRA, image to image)">Advanced web UI ↗</button>' : '') + '<button class="btn btn-ghost btn-sm" data-act="st-stop">Unload</button></div>' : '') +
			(s.supported ? '<div class="rt-controls"><label class="rt-inline">Build <select class="select" id="st-backend" title="Which build of stable-diffusion.cpp to use — changing it reinstalls">' + backends.map(([v, l]) => '<option value="' + v + '"' + (s.setting === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
				(job ? jobBar(job) : '<button class="btn btn-secondary btn-sm" data-act="st-install">' + I('arrowDown') + (s.installed ? 'Reinstall' : 'Install now') + '</button>') +
				'<button class="btn btn-ghost btn-sm" data-act="st-folder">' + I('folder') + 'Generated files</button></div>' : '') +
			'</div>'
		);
	}

	/**
	 * Settings → Local models is Models Fit Studio's own page (media/modelfit, copied from that
	 * project and now kept here), answered by zer0ne Engine (src/host/modelFitHost.ts):
	 * a model downloaded or run there is in Providers & models as zer0ne Engine at once. Its
	 * "Engine & more" tab opens what that page does not have, below.
	 */
	function localModelsPage() {
		return (S.localView || 'models') === 'models' ? modelFitPage() : localMorePage();
	}
	function modelFitPage() {
		const root = h('div', 'page wide local-page mfs-page');
		// Calls of a frame that is gone can never be answered; drop them.
		for (const [id, call] of mfsCalls) if (!call.frame.isConnected) mfsCalls.delete(id);
		const frame = document.createElement('iframe');
		frame.className = 'mfs-frame';
		frame.title = 'Local models';
		frame.src = '/modelfit/index.html?ver=' + encodeURIComponent(window.__zcShell?.boot?.appVersion || S.version || '');
		S.mfsFrame = frame;
		root.appendChild(frame);
		return root;
	}
	/** The calls of the framed page, so a reply goes back to the frame that asked for it. */
	const mfsCalls = new Map();
	/** The page's calls go to the engine; its replies and pushed updates come back to it. */
	function modelFitRelay(msg) {
		const frame = S.mfsFrame;
		if (!frame || !frame.isConnected || !frame.contentWindow) return;
		frame.contentWindow.postMessage({ __modelfit: 'reply', msg }, location.origin);
	}
	/**
	 * A reply belongs to the frame that asked for it: the framed page is created again when the
	 * section is left and opened again, and a late reply of the old frame must not land on the
	 * new one. The session of the page comes back with the reply, so the page can tell a reply
	 * of another load apart.
	 */
	function modelFitReply(msg) {
		const call = mfsCalls.get(msg.id);
		if (!call) return;
		mfsCalls.delete(msg.id);
		const frame = call.frame;
		if (!frame.isConnected || !frame.contentWindow) return;
		frame.contentWindow.postMessage({ __modelfit: 'reply', msg: { id: msg.id, ok: msg.ok, data: msg.data, error: msg.error, session: call.session } }, location.origin);
	}
	window.addEventListener('message', (event) => {
		const frame = S.mfsFrame;
		if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
		const d = event.data || {};
		if (d.__modelfit === 'call' && d.msg && typeof d.msg.cmd === 'string') {
			const id = Number(d.msg.id) || 0;
			if (id) mfsCalls.set(id, { frame, session: typeof d.msg.session === 'string' ? d.msg.session : '' });
			post({ type: 'modelfit', id, cmd: d.msg.cmd, args: d.msg.args && typeof d.msg.args === 'object' ? d.msg.args : {} });
		} else if (d.__modelfit === 'more') { S.localView = 'more'; renderPage(true); }
	});

	/** Engine & more: zer0ne Engine's settings and what is running, beside Models Fit Studio's page. */
	function localMorePage() {
		const root = h('div', 'page wide local-page');
		const L = S.localModels;
		const jobs = Object.values(S.localJobs || {});
		root.appendChild(
			header(
				'Engine & more',
				'zer0ne Engine, its options, and what is running on this computer. Models are in Local models.',
				(L && L.offline ? '<span class="lv-pill amber lv-head-pill" title="Hugging Face could not be reached: saved results are available">Offline · cached</span>' : '') + (L && L.engine ? '<span class="lv-pill ' + (L.engine.running ? 'lime lv-dot' : '') + ' lv-head-pill">' + (L.engine.running ? esc(L.engine.model || 'Model') + ' running' : L.engine.installed ? 'zer0ne Engine idle' : 'zer0ne Engine not installed') + '</span>' : '') +
					'<button class="icon-btn" data-act="local-refresh" title="Check again">' + I('refresh') + '</button>'
			)
		);
		root.classList.add('lv');
		if (!L) {
			root.appendChild(h('div', 'local-tabs', '<button class="local-tab mfs-back" data-act="mfs-back">' + I('back') + 'Local models</button>'));
			root.appendChild(h('div', 'card empty-inline', I('cpu') + '<span>Checking this machine and local servers…</span>'));
			return root;
		}
		if (L.discoveryError) root.appendChild(h('div', 'callout', I('alert') + '<span>' + esc(L.discoveryError) + '</span>'));
		const m = L.machine;
		// Older names of the activity views (Overview, Downloads) open Activity.
		const tab = (S.localTab = ['activity', 'advanced', 'overview', 'downloads'].includes(S.localTab) ? 'activity' : 'runtimes');
		if (tab === 'runtimes') root.appendChild(
			h(
				'div',
				'machine-strip',
				'<span>' + I('cpu') + Math.max(1, Math.round(m.totalMemoryBytes / 2 ** 31) * 2) + ' GB' + (m.unifiedMemory ? ' unified' : ' RAM') + '</span>' +
					'<span>' + I('zap') + esc((L.engine.devices && L.engine.devices.gpuName) || m.gpuName || 'No GPU') + (m.gpuMemoryBytes ? ' · ' + gb(m.gpuMemoryBytes) + (m.unifiedMemory || !L.engine.devices ? '' : ' free') : '') + '</span>' +
					'<span>' + I('check') + 'Runs fast up to ~' + gb(m.fastBudgetBytes / 1.2) + '</span>' +
					(m.freeDiskBytes ? '<span>' + I('folder') + gb(m.freeDiskBytes) + ' free</span>' : '') +
					'<span class="' + (L.engine.running ? 'on' : '') + '"><span class="dot ' + (L.engine.running ? 'green' : '') + '"></span>' + (L.engine.running ? esc(L.engine.model) + (L.engine.run && L.engine.run.ctx ? ' · ' + ctxLabel(L.engine.run.ctx) + ' ctx' : ' loading…') : L.engine.installed ? 'Engine idle' : 'Engine not installed') + '</span>'
			)
		);
		if (!S.plusAsked) {
			S.plusAsked = true;
			post({ type: 'localPlus' });
		}
		if (!S.studio && !S.studioAsked) {
			S.studioAsked = true;
			post({ type: 'studioState' });
		}
		const wantLive = tab === 'activity';
		if (wantLive !== !!S.liveOn) {
			S.liveOn = wantLive;
			if (!wantLive) S.liveSamples = [];
			post({ type: 'localLive', on: wantLive });
		}
		root.appendChild(
			h(
				'div',
				'local-tabs',
				'<button class="local-tab mfs-back" data-act="mfs-back">' + I('back') + 'Local models</button>' +
				[
					['runtimes', I('zap') + 'Engine' + (L.engine.running || (S.studio && S.studio.ready) ? ' <span class="count live">on</span>' : '')],
					['activity', I('gauge') + 'Activity' + (jobs.length ? ' <span class="count live">' + jobs.length + '</span>' : '')]
				]
					.map(([id, label]) => '<button class="local-tab' + (tab === id ? ' active' : '') + '" data-local-tab="' + id + '">' + label + '</button>')
					.join('')
			)
		);
		if (L.engine.testing && tab !== 'runtimes') root.appendChild(h('div', 'callout info-callout', '<span class="spinner"></span><div><b>Checking local speed</b> · ' + esc(L.engine.testing.model) + '<br>Up to 45 seconds before chatting. Results stay on this computer.</div><button class="btn btn-ghost btn-sm" data-act="engine-test-cancel">Cancel speed check</button>'));
		if (tab === 'runtimes') {
			const rt = runtimesTab(L);
			const engine = rt.querySelector('.engine-card');
			if (engine && S.studio) {
				const media = runtimeDisclosure('media', 'Image, video & voice engines', 'Installed automatically when you download a model from the chat\'s model menu.', studioEngineCard() + voiceEngineCard());
				engine.after(media);
			}
			root.appendChild(rt);
			// Downloads are listed in Activity; here a short dock says they are running.
			if (jobs.length) root.appendChild(h('div', 'dl-dock', '<div class="dl-dock-head">' + I('arrowDown') + '<b>Downloading ' + jobs.length + '</b><span class="grow"></span><button class="link-btn" data-local-tab="activity">Activity</button></div>' + jobs.map((j) => '<div class="dl-dock-row"><span class="mono dl-name" title="' + esc(j.label) + '">' + esc(j.label) + '</span>' + jobBar(j) + '</div>').join('')));
		} else root.appendChild(activityTab(L, jobs));
		return root;
	}

	/**
	 * Engine & more → Activity: what zer0ne Engine is doing now, live, and what is downloading.
	 * Model lists and checks are on Models Fit Studio's page; settings are under Engine.
	 */
	function activityTab(L, jobs) {
		const wrap = h('div', 'act');
		const m = L.machine;
		const e = L.engine;
		const eng = L.gguf || [];
		const loaded = eng.find((x) => x.loaded);
		const run = e.run;
		const names = { vulkan: 'Vulkan', cuda: 'CUDA', metal: 'Metal', cpu: 'CPU', sycl: 'SYCL', openvino: 'OpenVINO', rocm: 'ROCm' };
		const gpuName = ((e.devices && e.devices.gpuName) || m.gpuName || 'CPU').replace(/\(.*?\)|Intel\(R\)|\(TM\)|NVIDIA|GeForce|AMD/g, '').replace(/\s+/g, ' ').trim();
		const size = (x) => x.sizeBytes || (x.sizeGb || 0) * 1e9;
		const stat = (label, value) => '<div class="act-stat"><span>' + label + '</span><b>' + value + '</b></div>';

		const state = e.running ? ['Running', 'on'] : e.installed ? ['Ready', 'ready'] : ['Not installed', 'off'];
		const status =
			'<div class="act-status ' + state[1] + '"><span class="act-dot" aria-hidden="true"></span><div class="act-status-t"><b>zer0ne Engine · ' + state[0] + '</b><span>' + (e.installed ? esc(e.version || '') + ' · ' : '') + esc(names[e.backend] || names[e.autoBackend] || 'Auto') + ' on ' + esc(gpuName || 'this computer') + '</span></div>' +
			(e.installed ? '<button class="lv-btn ghost" data-local-tab="runtimes">' + I('gear') + 'Engine settings</button>' : '<button class="lv-btn dark" data-act="engine-install">' + I('arrowDown') + 'Install engine</button>') + '</div>';

		let now;
		if (loaded) {
			const bench = S.localPlus && S.localPlus.bench && S.localPlus.bench[loaded.id] && S.localPlus.bench[loaded.id].latest;
			const tok = loaded.measurement?.status === 'measured' ? Number(loaded.measurement.tokS).toFixed(1) : bench && !bench.error && bench.tokS ? String(bench.tokS) : '—';
			const memPct = m.fastBudgetBytes ? Math.round((size(loaded) * 1.2 * 100) / m.fastBudgetBytes) : 0;
			now =
				'<section class="act-card act-now"><header><span>Loaded now</span><span class="lv-pill lime lv-dot">' + (run && run.ctx ? 'ready' : 'loading') + '</span></header>' +
				'<div class="act-model" title="' + esc(loaded.id) + '">' + esc(loaded.id) + '</div>' +
				'<div class="act-stats">' + stat('Speed', tok === '—' ? '—' : tok + ' tok/s') + stat('Context', run && run.ctx ? ctxLabel(run.ctx) : 'auto') + stat('Memory', memPct ? memPct + '% of budget' : '—') + '</div>' +
				'<div class="act-actions"><button class="lv-btn dark" data-act="local-chat" data-id="' + esc(loaded.id) + '">' + I('send') + 'Chat</button><button class="lv-btn ghost" data-act="engine-stop">Unload</button>' + benchBtn(loaded.id) + '</div></section>';
		} else {
			const recent = eng.slice(0, 3);
			now =
				'<section class="act-card act-now idle"><header><span>Loaded now</span><span class="lv-pill">nothing</span></header>' +
				'<div class="act-model muted">No model is loaded</div>' +
				'<p class="act-note">' + (!e.installed ? 'Install zer0ne Engine to run models on this computer.' : recent.length ? 'A model loads when you chat with it, or load one here.' : 'A model loads when you chat with it. Find one that fits this computer in Local models.') + '</p>' +
				(recent.length && e.installed
					? '<div class="act-list">' + recent.map((x) => '<div class="act-row"><span class="mono" title="' + esc(x.id) + '">' + esc(x.id) + '</span><button class="lv-btn ghost" data-act="engine-load" data-id="' + esc(x.id) + '"' + (S.engineLoading === x.id ? ' disabled' : '') + '>' + (S.engineLoading === x.id ? '<span class="spinner"></span>Loading' : I('zap') + 'Load') + '</button></div>').join('') + '</div>'
					: '<div class="act-actions"><button class="lv-btn dark" data-act="mfs-back">' + I('search') + 'Find a model</button></div>') +
				'</section>';
		}

		const downloads =
			'<section class="act-card act-dl"><header><span>Downloads</span>' + (jobs.length ? '<span class="lv-pill lime">' + jobs.length + ' running</span>' : '') + '</header>' +
			(jobs.length
				? jobs.map((j) => '<div class="act-dl-row"><div class="act-dl-name"><b title="' + esc(j.label) + '">' + esc(j.label) + '</b><span>' + esc(j.stage || '') + '</span></div>' + jobBar(j) + '</div>').join('')
				: '<p class="act-note">Nothing is downloading. A paused download goes on from where it stopped.</p>') +
			'</section>';

		const studio = (S.studio && S.studio.bundles) || [];
		const voices = (S.studio && S.studio.voices) || [];
		const chat = eng.length + (L.installed || []).length;
		const disk = eng.reduce((n, x) => n + size(x), 0) + (L.installed || []).reduce((n, x) => n + size(x), 0);
		const library =
			'<section class="act-card act-lib"><header><span>On this computer</span><button class="link-btn" data-act="mfs-back">Library' + I('chevronRight') + '</button></header>' +
			'<div class="act-stats four">' + stat(I('chat') + 'Chat', chat) + stat(I('image') + 'Images', studio.filter((x) => x.installed && x.kind === 'image').length) + stat(I('film') + 'Videos', studio.filter((x) => x.installed && x.kind === 'video').length) + stat(I('volume') + 'Voices', voices.filter((x) => x.installed).length) + '</div>' +
			'<p class="act-note">' + (disk ? gb(disk) + ' of chat models on disk' + (m.freeDiskBytes ? ' · ' + gb(m.freeDiskBytes) + ' free' : '') + '.' : 'No chat models yet.') + ' Image, video and voice models download from the chat\'s model menu.</p></section>';

		wrap.innerHTML = status + '<div class="act-grid">' + now + liveCard(L) + '</div><div class="act-grid">' + downloads + library + '</div>';
		setTimeout(paintLive, 0);
		paintBars(wrap);
		return wrap;
	}
	const benchBtn = (id, cls, server) => {
		const running = S.localPlus && (S.localPlus.benchRunning || []).includes(id);
		return running ? '<span class="lv-bench-run"><span class="spinner"></span><em data-bench-stage="' + esc(id) + '">' + esc((S.benchStage || {})[id] || 'Benchmarking…') + '</em></span>' : '<button class="' + (cls || 'lv-btn ghost') + '" data-act="local-bench" data-id="' + esc(id) + '"' + (server ? ' data-server="' + esc(server) + '"' : '') + ' title="30-second test on this machine: speed, first-token time and 4 agent checks">' + I('gauge') + 'Benchmark</button>';
	};

	/** Live monitor: speed, context fill, engine memory, RAM — painted in place from `localLive` samples. */
	function liveCard(L) {
		return (
			'<div class="lv-card lv-live" id="lv-live"><div class="lv-card-h"><div><b>Machine activity</b><span class="muted">' + (L.engine.running ? esc(L.engine.model || '') : 'no model loaded') + '</span></div><span class="lv-pill" id="lv-live-state">' + (L.engine.running ? 'idle' : 'off') + '</span></div>' +
			'<div class="lv-live-top"><div class="lv-live-num"><b id="lv-live-tok">—</b><span>tok/s now</span></div><svg class="lv-spark" id="lv-spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"></svg></div>' +
			'<div class="lv-live-rows"><div class="lv-live-row"><span>System CPU</span><div class="lv-bar"><i id="lv-live-cpu"></i></div><em id="lv-live-cpu-t">—</em></div><div class="lv-live-row"><span>Context</span><div class="lv-bar"><i id="lv-live-ctx"></i></div><em id="lv-live-ctx-t">—</em></div>' +
			'<div class="lv-live-row"><span>Engine</span><div class="lv-bar"><i id="lv-live-eng"></i></div><em id="lv-live-eng-t">—</em></div>' +
			'<div class="lv-live-row"><span>RAM</span><div class="lv-bar"><i id="lv-live-ram"></i></div><em id="lv-live-ram-t">—</em></div></div></div>'
		);
	}

	function paintLive() {
		const box = $('lv-live');
		const list = S.liveSamples || [];
		const s = list[list.length - 1];
		if (!box || !s) return;
		const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
		const bar = (id, pct) => { const el = $(id); if (el) el.style.width = Math.max(0, Math.min(100, pct)).toFixed(1) + '%'; };
		set('lv-live-tok', s.engineOn && s.metricsAvailable ? String(s.tokS || 0) : '—');
		bar('lv-live-cpu', s.cpuPercent || 0);
		set('lv-live-cpu-t', s.cpuPercent != null ? s.cpuPercent.toFixed(1) + '%' : 'Sampling…');
		const st = $('lv-live-state');
		if (st) {
			st.textContent = !s.engineOn ? 'engine off' : !s.metricsAvailable ? 'metrics unavailable' : s.busy ? 'generating' : 'idle';
			st.className = 'lv-pill' + (s.busy ? ' lime lv-dot' : '');
		}
		bar('lv-live-ctx', (s.ctxFill || 0) * 100);
		set('lv-live-ctx-t', s.ctxFill != null ? Math.round(s.ctxFill * 100) + '%' + (s.ctxTokens ? ' · ' + ctxLabel(s.ctxTokens) : '') : 'n/a');
		bar('lv-live-eng', s.engineBytes ? (s.engineBytes * 100) / s.ramTotalBytes : 0);
		set('lv-live-eng-t', s.engineBytes ? gb(s.engineBytes) : '—');
		bar('lv-live-ram', (s.ramUsedBytes * 100) / s.ramTotalBytes);
		set('lv-live-ram-t', gb(s.ramUsedBytes) + ' / ' + gb(s.ramTotalBytes));
		const spark = $('lv-spark');
		if (spark) {
			const vals = list.map((x) => x.tokS || 0);
			const max = Math.max(5, ...vals);
			const pts = vals.map((v, i) => ((i / Math.max(1, vals.length - 1)) * 200).toFixed(1) + ',' + (42 - (v / max) * 38).toFixed(1));
			spark.innerHTML = pts.length > 1 ? '<polyline class="area" points="0,44 ' + pts.join(' ') + ' ' + pts[pts.length - 1].split(',')[0] + ',44"/><polyline class="line" points="' + pts.join(' ') + '"/>' : '';
		}
	}

	/** Hybrid routing: which local model does helper work and takes over offline. */
	function routingCard() {
		const st = S.settings || {};
		const local = S.providers.filter((p) => p.enabled && p.apiFormat !== 'acp' && p.apiFormat !== 'vscode-lm' && (p.preset === 'zer0ne-engine' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(p.baseUrl || '')));
		const opts = local.flatMap((p) => p.models.filter((m) => m.enabled).map((m) => [p.id + '::' + m.id, p.name + ' · ' + (m.name || m.id)]));
		const tasks = String(st.localHelperTasks || '').split(',');
		const task = (id, label, hint) => '<button class="lv-chip' + (tasks.includes(id) ? ' on' : '') + '" data-act="lv-task" data-task="' + id + '" title="' + esc(hint) + '">' + (tasks.includes(id) ? I('check') : '') + label + '</button>';
		return (
			'<div class="lv-card lv-route"><div class="lv-card-h"><div><b>Local assistant</b><span class="muted">Optional: use a local model for summaries, text edits and read-only research</span></div>' + (st.localHelper ? '<span class="lv-pill lime lv-dot">On</span>' : '<span class="lv-pill">Off</span>') + '</div>' +
			'<p class="muted lv-note">Your main chat model stays selected. These tasks use the assistant model instead, saving cloud calls. Keep this off if running two models makes your computer slow.</p><label class="lv-field"><span>Assistant model</span><select class="select" id="lv-helper"><option value="">Off</option>' + opts.map(([v, l]) => '<option value="' + esc(v) + '"' + (st.localHelper === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select></label>' +
			(opts.length ? '' : '<p class="muted lv-note">Download a model in Local models first.</p>') +
			'<div class="lv-chips">' + task('compaction', 'Summaries', 'Context compaction summaries') + task('text', 'Text tools', 'Fix / improve / shorten / translate in the composer') + task('subagents', 'Research subagents', 'Read-only `task` subagents') + '</div>' +
			'<label class="lv-switch-row"><span><b>Offline fallback</b><em>Keep going locally when the cloud is down</em></span><label class="switch"><input type="checkbox" id="lv-offline"' + (st.offlineFallback !== false ? ' checked' : '') + '><span class="track"></span></label></label>' +
			'<label class="lv-switch-row"><span><b>Small-model mode</b><em>Shorter prompts and fewer tools for local models</em></span><label class="switch"><input type="checkbox" id="lv-tuned"' + (st.localTuned !== false ? ' checked' : '') + '><span class="track"></span></label></label></div>'
		);
	}

	function runtimesTab(L) {
		const wrap = h('div', 'runtimes');
		const e = L.engine;
		const s = e.settings;
		const job = (S.localJobs || {}).engine;
		const mac = (L.machine.platform || '') === 'darwin';
		const names = { vulkan: 'Vulkan', cuda: 'CUDA', metal: 'Metal', cpu: 'CPU', sycl: 'SYCL', openvino: 'OpenVINO', rocm: 'ROCm' };
		// Each GPU vendor also gets its own runtime next to Vulkan (x64 Windows / Linux) — the benchmark shows which one is fastest here.
		const gpu = (e.devices && e.devices.gpuName) || L.machine.gpuName || '';
		const x64 = !mac && (L.machine.arch || 'x64') === 'x64';
		const vendor = [];
		if (/nvidia|geforce|rtx|quadro|tesla/i.test(gpu) || !gpu) vendor.push(['cuda', 'CUDA · NVIDIA']);
		if (x64 && /intel|\barc\b|iris/i.test(gpu)) vendor.push(['sycl', 'SYCL · Intel'], ['openvino', 'OpenVINO · Intel']);
		if (x64 && /amd|radeon|instinct/i.test(gpu)) vendor.push(['rocm', 'ROCm · AMD']);
		const backends = [['auto', 'Auto · ' + (names[e.autoBackend] || 'best')]].concat(mac ? [['metal', 'Metal']] : [['vulkan', 'Vulkan · any GPU']].concat(vendor, [['cpu', 'CPU only']]));
		const run = e.run;
		const dev = e.devices;
		const ollama = L.servers.find((x) => x.id === 'ollama') || {};
		const insp = S.localInspect;
		wrap.innerHTML =
			'<div class="rt-card engine-card"><div class="rt-head"><div class="rt-logo">' + I('zap') + '</div><div class="grow"><div class="rt-name">zer0ne Engine <span class="theme-badge">recommended</span></div>' +
			'<div class="rt-desc">Runs coding models on this computer. Auto chooses compatible settings and fits each model to available memory.</div></div></div>' +
			'<div class="rt-status">' + (e.installed ? '<span class="dot green"></span>Installed ' + esc(e.version) + ' · ' + esc(names[e.backend] || e.backend) + (dev && dev.gpuName ? ' · ' + esc(dev.gpuName) + ' (' + gb(dev.bytes) + ' free)' : '') : '<span class="dot"></span>Not installed — Auto picks <b>' + esc(names[e.autoBackend] || e.autoBackend) + '</b> for this machine') + '</div>' +
			(e.running ? '<div class="rt-run"><span class="dot green"></span><b class="mono">' + esc(e.model) + '</b>' + (run ? '<span>' + (run.ctx ? ctxLabel(run.ctx) + ' context' : 'loading…') + '</span><span>' + (run.gpu === 'cpu' ? 'CPU' : 'GPU offload: auto') + '</span><span>loaded in ' + (run.loadMs / 1000).toFixed(1) + ' s</span>' + (run.attempt ? '<span class="badge warn">reduced to fit</span>' : '') : '<span class="spinner"></span><span>fitting to memory…</span>') + '<span class="grow"></span><span class="muted mono">:' + s.port + '</span></div>' : '') +
			(e.helper ? '<div class="rt-run"><span class="dot' + (e.helper.running ? ' green' : '') + '"></span><b class="mono">' + esc(e.helper.model) + '</b><span>helper slot' + (e.helper.ctx ? ' · ' + ctxLabel(e.helper.ctx) + ' context' : '') + '</span><span class="grow"></span><span class="muted mono">:' + e.helper.port + '</span></div>' : '') +
			(run && run.fit ? '<div class="rt-status">Auto fit · ' + esc(run.fit.kv) + ' cache' + (run.fit.flash === false ? ' · plain attention' : '') + (run.fit.cpu ? ' · processor only' : '') + ' · ' + run.fit.threads + ' generation threads · ' + run.fit.ubatch + ' prompt batch · estimated ' + gb(run.fit.memoryBytes) + (run.fit.cpuExpertLayers ? ' · experts in RAM for ' + run.fit.cpuExpertLayers + ' layers' : '') + (run.draft ? ' · drafting ahead' : '') + '</div>' : '') +
			(e.tuning ? '<div class="rt-status"><span class="spinner"></span>' + esc(e.tuning.stage) + '<button class="btn btn-ghost btn-sm" data-act="engine-tune-cancel">Cancel tuning</button></div>' : '') +
			(e.testing ? '<div class="rt-status"><span class="spinner"></span>' + esc(e.testing.stage) + '<button class="btn btn-ghost btn-sm" data-act="engine-test-cancel">Cancel speed check</button></div>' : '') +
			(e.crashes ? '<div class="callout warn-callout">' + I('alert') + '<div>The engine crashed ' + e.crashes + (e.crashes > 1 ? ' times' : ' time') + ' in the last 30 minutes' + (e.lastCrash && e.lastCrash.detail ? ': <span class="mono">' + esc(e.lastCrash.detail) + '</span>' : '') + '. The chat restarts it and retries by itself' + (e.crashes >= 3 ? ' — not any more: try CPU only, a smaller quantisation' + (e.previous ? ' or the previous build' : '') : '') + '.</div></div>' : '') +
			(e.log ? '<pre class="rt-log">' + esc(e.log) + '</pre>' : '') +
			(e.installed ? '<div class="rt-build"><span>Build</span><div class="segmented"><button data-act="engine-channel" data-value="tested" class="' + (s.channel !== 'latest' ? 'active' : '') + '" title="The llama.cpp build zer0ne is tested with">Tested · ' + esc(e.pin || '') + '</button><button data-act="engine-channel" data-value="latest" class="' + (s.channel === 'latest' ? 'active' : '') + '" title="llama.cpp\'s newest release — newest models first, less tested">Latest</button></div>' +
				(e.version && e.pin && s.channel !== 'latest' && e.version !== e.pin ? '<span class="muted">Installed ' + esc(e.version) + ' — press Update to get the tested build.</span>' : '') +
				(e.previous ? '<button class="link-btn" data-act="engine-rollback">Switch back to ' + esc(e.previous.version) + ' (' + esc(names[e.previous.backend] || e.previous.backend) + ')</button>' : '') + '</div>' : '') +
			'<div class="rt-controls"><p class="muted lv-note">zer0ne Engine includes llama.cpp and installs automatically with your first model. GGUF builds include Q1–Q8, IQ, TQ, F16, BF16, F32, MXFP4 and NVFP4; architecture and GPU support still depend on the installed build. Original Safetensors weights need conversion, and MLX weights need an Apple MLX runtime.</p><div class="segmented">' + backends.map(([v, l]) => '<button data-act="engine-backend" data-value="' + v + '" class="' + (s.backend === v ? 'active' : '') + '">' + l + '</button>').join('') + '</div>' +
			(job ? jobBar(job) : '<button class="btn btn-primary btn-sm" data-act="engine-install">' + I('arrowDown') + (e.installed ? 'Update engine' : 'Install engine') + '</button>') +
			(e.running ? '<button class="btn btn-ghost btn-sm" data-act="engine-stop">Eject model</button>' : '') +
			(run && !e.tuning && !e.testing ? '<button class="btn btn-ghost btn-sm" data-act="engine-test" title="A synthetic speed check, bounded to 45 seconds. Measures first response, generation speed and samples process RAM.">Test speed again</button><button class="btn btn-ghost btn-sm" data-act="engine-tune" title="When idle, time this model on a long code prompt with each setting it can run: attention mode, threads, prompt batch and the processor alone. Keeps a change only after a measured improvement; may take several minutes. Chats wait while tuning.">Tune for speed</button>' : '') + '</div>' +
			'<div class="rt-grid">' +
			'<label>Context <select class="select" id="eng-context"><option value="0"' + (!s.context ? ' selected' : '') + '>Auto — fit this model to available memory</option>' + [8192, 16384, 32768, 65536, 131072].map((c) => '<option value="' + c + '"' + (s.context === c ? ' selected' : '') + '>' + c / 1024 + 'K tokens</option>').join('') + '</select></label>' +
			'<label>GPU <select class="select" id="eng-gpu"><option value="auto"' + (s.gpu !== 'cpu' ? ' selected' : '') + '>Auto — offload what fits</option><option value="cpu"' + (s.gpu === 'cpu' ? ' selected' : '') + '>CPU only</option></select></label>' +
			'<label>Port <input class="input mono" id="eng-port" type="number" min="1024" max="65535" value="' + s.port + '"></label>' +
			'<label class="check"><input type="checkbox" id="eng-lightkv"' + (s.lightKv ? ' checked' : '') + '> Light KV cache (q8 — half the memory for long chats)</label>' +
			'<label class="check"><input type="checkbox" id="eng-boost"' + (s.speedBoost !== false ? ' checked' : '') + '> Speed boost — speculative decoding: identical output, faster when the model rewrites code. Uses a model’s draft head when it came with one</label>' +
			'<label class="check"><input type="checkbox" id="eng-helperslot"' + (s.helperSlot !== false ? ' checked' : '') + '> Helper slot — the local helper model stays loaded beside the chat model when both fit in memory (port ' + (s.port + 1) + ')</label>' +
			'<label class="check"><input type="checkbox" id="eng-firsttest"' + (s.firstLoadTest !== false ? ' checked' : '') + '> Test speed on first load — a cancellable check, up to 45 seconds before chatting. Results stay on this computer.</label>' +
			'<label>Unload when idle <select class="select" id="lv-idle">' + [[0, 'Never'], [5, 'After 5 min'], [10, 'After 10 min'], [15, 'After 15 min'], [30, 'After 30 min'], [60, 'After 1 hour']].map(([v, l]) => '<option value="' + v + '"' + (((S.localPlus && S.localPlus.idleMinutes) || 0) === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>' +
			'</div>' + backendCompare() + '</div>' +
			'<div class="rt-card"><div class="rt-head"><div class="rt-logo">' + I('cube') + '</div><div class="grow"><div class="rt-name">Ollama</div><div class="rt-desc">A background service with its own library. zer0ne can pull any Hugging Face GGUF into it too.</div></div>' +
			(ollama.running ? '<span class="state-pill live"><span class="dot green"></span>' + esc(ollama.version || 'running') + '</span>' : L.ollamaInstalled ? '<button class="btn btn-secondary btn-sm" data-act="local-start">' + I('send') + 'Start</button>' : '<button class="btn btn-primary btn-sm" data-act="local-start">' + I('arrowDown') + 'Install & start Ollama</button>') + '</div>' +
			'<div class="setting-row"><div class="text"><div class="name">Any Ollama model</div><div class="desc">A tag like <code>qwen3-coder:30b</code>. <b>Check</b> reads its size and tool support first.</div></div>' +
			'<div class="control local-pull"><input id="local-tag" class="input mono" placeholder="model:tag" spellcheck="false" value="' + esc(S.localTag || '') + '"><button class="btn btn-ghost btn-sm" data-act="local-inspect">Check</button><button class="btn btn-primary btn-sm" data-act="local-pull-tag"' + (ollama.running ? '' : ' disabled title="Start Ollama first"') + '>' + I('arrowDown') + 'Pull</button></div></div>' +
			(insp ? '<div class="inspect-line">' + (insp.info ? '<b class="mono">' + esc(insp.tag) + '</b> ' + insp.info.sizeGb + ' GB ' + fitBadge(insp.info.fit) + (insp.info.tools ? '<span class="badge ok">tools</span>' : '<span class="badge warn">no tools</span>') : '') + (insp.advice ? '<span class="muted">' + esc(insp.advice) + '</span>' : '') + '</div>' : '') +
			pullBar(S.localTag || '') +
			// Its installed models, each ready to be used in the chat (they were listed in My models before).
			((L.installed || []).length ? '<div class="srv-actions ollama-models">' + L.installed.map((m) => '<button class="btn btn-secondary btn-sm" data-act="local-use" data-tag="' + esc(m.tag) + '" title="Use ' + esc(m.tag) + ' in the chat">' + I('send') + esc(m.tag) + '</button>').join('') + '</div>' : '') +
			'</div>' +
			lmsCard(L) +
			'<div class="rt-card"><div class="rt-head"><div class="rt-logo">' + I('server') + '</div><div class="grow"><div class="rt-name">Other local servers</div><div class="rt-desc">Detected automatically on their usual ports. Start one and its loaded models appear here, each ready to use in the chat.</div></div></div>' +
			'<div class="srv-grid">' +
			L.servers
				.filter((x) => x.id !== 'ollama' && x.id !== 'lmstudio')
				.map((x) => {
					const info = LOCAL_SERVERS[x.id] || [];
					return (
						'<div class="srv-tile' + (x.running ? ' live' : '') + '"><div class="srv-top"><span class="dot ' + (x.running ? 'green' : '') + '"></span><b>' + esc(x.name) + '</b><span class="grow"></span><span class="muted mono">' + esc(x.baseUrl.replace(/^https?:\/\//, '').replace(/(\/api)?\/v1$/, '')) + '</span></div>' +
						'<div class="srv-desc">' + esc(info[1] || '') + '</div>' +
						'<div class="srv-actions">' + (x.running ? '<span class="state-pill live">' + (x.models || []).length + ' model' + ((x.models || []).length === 1 ? '' : 's') + '</span>' + (x.models || []).slice(0, 4).map((mid) => '<button class="btn btn-secondary btn-sm" data-act="local-use" data-tag="' + esc(mid) + '" data-server="' + esc(x.baseUrl) + '" title="' + esc(mid) + '">Use ' + esc(mid.split('/').pop()) + '</button>').join('') + ((x.models || []).length > 4 ? '<span class="muted">+' + ((x.models || []).length - 4) + ' more</span>' : '') : '<span class="muted">not running</span>' + (info[0] ? '<button class="btn btn-ghost btn-sm" data-act="local-get" data-url="' + info[0] + '">' + I('arrowDown') + 'Get</button>' : '')) + '</div></div>'
					);
				})
				.join('') +
			'</div></div>';
		const engine = wrap.querySelector('.engine-card');
		const options = runtimeDisclosure('engine', 'Engine options', 'Automatic settings are recommended. Adjust builds, memory and performance here.');
		const optionsBody = options.querySelector('.runtime-disclosure-body');
		const backendButtons = engine.querySelector('.rt-controls > .segmented');
		if (backendButtons) optionsBody.appendChild(backendButtons);
		for (const el of engine.querySelectorAll('.rt-build, .rt-grid, .lv-cmp, .lv-cmp-empty, .rt-log')) optionsBody.appendChild(el);
		for (const el of engine.querySelectorAll('.rt-status')) if (el.textContent.startsWith('Auto fit')) optionsBody.appendChild(el);
		engine.appendChild(options);
		const external = runtimeDisclosure('connections', 'Other runtimes', 'Optional: Ollama, LM Studio and other local servers.');
		for (const el of Array.from(wrap.children)) if (el !== engine) external.querySelector('.runtime-disclosure-body').appendChild(el);
		wrap.appendChild(runtimeDisclosure('assistant', 'Local assistant', 'Optional: a local model for summaries and small edits, beside your main model.', routingCard()));
		wrap.appendChild(runtimeDisclosure('host', 'Local Host router', 'Off by default: one address for other apps (Cline, Continue, Cursor) to use your local models.', localHostCard()));
		wrap.appendChild(external);
		// CSP-safe: the comparison table's column count through CSSOM.
		for (const el of wrap.querySelectorAll('[data-cols]')) el.style.setProperty('--cols', el.dataset.cols);
		return wrap;
	}

	/** Benchmarks by backend (Vulkan / SYCL / OpenVINO / CUDA…): which build is fastest on this machine, per model. */
	function backendCompare() {
		const bench = (S.localPlus && S.localPlus.bench) || {};
		const rows = Object.entries(bench).filter(([, v]) => v && v.byBackend && Object.keys(v.byBackend).length);
		if (!rows.length) return '<div class="lv-cmp-empty muted">' + I('gauge') + '<span>Benchmark a model (Activity) to compare backends here — switch the build above and benchmark again; the fastest wins.</span></div>';
		const backends = [...new Set(rows.flatMap(([, v]) => Object.keys(v.byBackend)))];
		return (
			'<div class="lv-cmp"><div class="lv-cmp-h"><b>Backend comparison</b><span class="muted">tokens/s · first token · agent readiness, measured on this machine</span></div>' +
			'<div class="lv-cmp-t" data-cols="' + backends.length + '"><span>Model</span>' + backends.map((b) => '<span>' + esc(b) + '</span>').join('') +
			rows.map(([id, v]) => {
				const best = Math.max(...Object.values(v.byBackend).map((r) => r.tokS || 0));
				return '<span class="mono lv-cmp-m" title="' + esc(id) + '">' + esc(id) + '</span>' + backends.map((b) => {
					const r = v.byBackend[b];
					return r && !r.error ? '<span class="lv-cmp-c' + (r.tokS && r.tokS === best && Object.keys(v.byBackend).length > 1 ? ' best' : '') + '"><span><b>' + (r.tokS ?? '—') + '</b> t/s</span><em>' + (r.ttftMs != null ? (r.ttftMs / 1000).toFixed(1) + ' s · ' : '') + r.score + '%</em></span>' : '<span class="muted">—</span>';
				}).join('');
			}).join('') +
			'</div></div>'
		);
	}

	/** Local Host: one address for every local model, for other tools and devices. */
	function localHostCard() {
		const h = (S.localPlus && S.localPlus.host) || { enabled: false, port: 11435, lan: false, key: '', running: false, activity: [] };
		const host = '127.0.0.1';
		const url = 'http://' + host + ':' + h.port + '/v1';
		const anthropicUrl = 'http://' + host + ':' + h.port;
		const copy = (text, label) => '<button class="btn btn-ghost btn-sm" data-act="lh-copy" data-copy="' + esc(text) + '">' + I('copy') + label + '</button>';
		return (
			'<div class="rt-card lh-card"><div class="rt-head"><div class="rt-logo">' + I('server') + '</div><div class="grow"><div class="rt-name">Local Host router <span class="theme-badge">OpenAI · Anthropic</span></div>' +
			'<div class="rt-desc">One API for zer0ne Engine and Ollama models — use it from Cline, Continue, OpenCode, Cursor, scripts or your phone. The model name picks the model: engine models load on demand (requests queue so a swap never cuts a stream), Ollama models are passed to Ollama.</div></div>' +
			'<label class="switch" title="Serve Local Host"><input type="checkbox" id="lh-enabled"' + (h.enabled ? ' checked' : '') + '><span class="track"></span></label></div>' +
			(h.lastError ? '<div class="callout warn-callout">' + I('alert') + '<div>' + esc(h.lastError) + '</div></div>' : '') +
			(h.enabled
				? '<div class="lh-grid">' +
					'<div class="lh-row"><span>OpenAI URL</span><code class="mono">' + esc(url) + '</code>' + copy(url, 'Copy') + (h.running ? '<span class="lv-pill lime lv-dot">Serving</span>' : '<span class="lv-pill">Stopped</span>') + '</div>' +
					'<div class="lh-row"><span>Anthropic URL</span><code class="mono">' + esc(anthropicUrl) + '</code>' + copy(anthropicUrl, 'Copy') + '</div>' +
					'<div class="lh-row"><span>API key</span><code class="mono">' + esc(h.key ? h.key.slice(0, 7) + '…' + h.key.slice(-4) : '') + '</code>' + copy(h.key, 'Copy') + '<button class="btn btn-ghost btn-sm" data-act="lh-newkey">' + I('refresh') + 'New key</button></div>' +
					'<p class="muted lv-note">' + (h.active || 0) + ' active · ' + (h.queued || 0) + ' queued. Model IDs: <code>engine/model-id</code> or <code>ollama/model-id</code>. Chat Completions and Completions work with both backends. Responses, Anthropic Messages and token counting use zer0ne Engine and require a compatible engine release.</p>' +
					(h.loaded?.model ? '<p class="muted lv-note">Loaded: <b>' + esc(h.loaded.model) + '</b> · ' + (Number.isFinite(h.loaded.context) && h.loaded.context > 0 ? esc(ctxLabel(h.loaded.context)) + ' actual context. Match the other tool’s context setting to this size; its messages and tool definitions must fit.' : 'Context not reported by the engine.') + '</p>' : '<p class="muted lv-note">No engine model loaded. A request loads its selected model; the actual context appears here once ready.</p>') +
					(h.models?.length ? '<div class="lh-models"><span>Installed engine routes</span>' + h.models.map(id => copy('engine/' + id, id)).join('') + '</div>' : '<p class="muted">Download a language model in Models to add an engine route.</p>') + '<div class="lh-row"><span>Port</span><input class="input mono lh-port" id="lh-port" type="number" min="1024" max="65535" value="' + h.port + '"><label class="lh-lan"><input type="checkbox" id="lh-lan"' + (h.lan ? ' checked' : '') + '> Other devices on my network (LAN)</label></div>' +
					(h.lan ? '<div class="callout warn-callout">' + I('alert') + '<div>Reachable from your network' + (h.addresses && h.addresses.length ? ' at <b>' + h.addresses.map(esc).join(', ') + '</b>' : '') + ' — anyone with the key can use your models. Your system may ask to let zer0ne Code through the firewall the first time; turn LAN off on public Wi-Fi.</div></div>' : '') +
					'<div class="lh-snips"><span class="muted">Use it in other tools · choose an OpenAI-compatible provider</span><button class="btn btn-secondary btn-sm" data-act="lh-check">' + I('check') + 'Test router & API key</button>' + copy('OPENAI_BASE_URL=' + url + '\nOPENAI_API_KEY=' + h.key, 'Environment variables') + (h.lan ? (h.addresses || []).map(address => copy('http://' + address + ':' + h.port + '/v1', 'LAN URL · ' + address)).join('') : '') +
					copy('ANTHROPIC_BASE_URL=' + anthropicUrl + '\nANTHROPIC_AUTH_TOKEN=' + h.key, 'Anthropic environment') + (h.lan ? (h.addresses || []).map(address => copy('http://' + address + ':' + h.port, 'Anthropic LAN URL · ' + address)).join('') : '') +
					copy('{\n  "apiProvider": "openai",\n  "openAiBaseUrl": "' + url + '",\n  "openAiApiKey": "' + h.key + '"\n}', 'Cline / Roo') +
					copy('models:\n  - name: zer0ne local\n    provider: openai\n    apiBase: ' + url + '\n    apiKey: ' + h.key + '\n    model: <model id from /v1/models>', 'Continue') +
					copy('curl ' + url + '/chat/completions -H "Authorization: Bearer ' + h.key + '" -H "Content-Type: application/json" -d \'{"model":"<model id>","messages":[{"role":"user","content":"hi"}]}\'', 'curl') + '</div>' +
					(h.activity && h.activity.length
						? '<div class="lh-act"><span class="muted">Recent requests · ' + h.requests + ' attempted</span>' + h.activity.slice(0, 6).map((a) => '<div class="lh-act-row"><span class="lv-pill ' + (a.ok ? 'lime' : 'red') + '">' + esc(a.path) + '</span><span class="mono">' + esc(a.model || '—') + '</span><em>' + esc(a.from) + ' · ' + (a.ms / 1000).toFixed(1) + ' s · ' + esc(new Date(a.at).toLocaleTimeString()) + '</em></div>').join('') + '</div>'
						: '<p class="muted lh-none">No requests yet — point a tool at the Base URL with the key.</p>') +
					'</div>'
				: '') +
			'</div>'
		);
	}

	function lmsCard(L) {
		const srv = L.servers.find((x) => x.id === 'lmstudio') || {};
		const lm = S.lms;
		if (L.lms && !lm) {
			S.lms = { loading: true };
			post({ type: 'lmsList' });
		}
		const items = (lm && lm.items) || [];
		return (
			'<div class="rt-card"><div class="rt-head"><div class="rt-logo">' + I('cube') + '</div><div class="grow"><div class="rt-name">LM Studio</div><div class="rt-desc">' + esc(LOCAL_SERVERS.lmstudio[1]) + ((L.machine.platform || '') === 'darwin' ? ' On Apple Silicon its <b>MLX</b> engine is often faster than llama.cpp — worth trying for big models.' : '') + '</div></div>' +
			(srv.running ? '<span class="state-pill live"><span class="dot green"></span>server on :1234</span>' : L.lms ? '<span class="state-pill">installed</span>' : '<button class="btn btn-secondary btn-sm" data-act="local-get" data-url="' + LOCAL_SERVERS.lmstudio[0] + '">' + I('arrowDown') + 'Get LM Studio</button>') + '</div>' +
			(L.lms
				? lm && lm.loading
					? '<div class="empty-inline"><span class="spinner"></span><span>Reading LM Studio\'s models…</span></div>'
					: items.length
						? '<div class="lms-list" data-scroll="lms">' +
							items
								.map(
									(x) =>
										'<div class="lms-row' + (x.loaded ? ' live' : '') + '"><div class="grow"><b class="mono">' + esc(x.name) + '</b><div class="mm-meta">' + (x.params ? '<span class="badge mono">' + esc(x.params) + '</span>' : '') + (x.quant ? '<span class="badge mono">' + esc(x.quant) + '</span>' : '') + '<span>' + gb(x.sizeBytes) + '</span>' + fitBadge(x.sizeBytes ? (x.sizeBytes * 1.2 <= L.machine.fastBudgetBytes ? 'fits' : x.sizeBytes * 1.2 <= L.machine.ceilingBytes ? 'tight' : 'too-large') : '') + (x.tools ? '<span class="badge ok">tools</span>' : '') + (x.vision ? '<span class="badge">vision</span>' : '') + (x.maxContext ? '<span class="muted">' + ctxLabel(x.maxContext) + ' ctx</span>' : '') + '</div></div>' +
										(S.lmsBusy === x.key ? '<span class="spinner"></span>' : x.loaded ? '<button class="btn btn-secondary btn-sm" data-act="local-use" data-tag="' + esc(x.key) + '" data-server="http://127.0.0.1:1234/v1">Use in chat</button><button class="btn btn-ghost btn-sm" data-act="lms-unload" data-key="' + esc(x.key) + '">Eject</button>' : '<button class="btn btn-primary btn-sm" data-act="lms-load" data-key="' + esc(x.key) + '">Load</button>') +
										'</div>'
								)
								.join('') +
							'</div>'
						: '<div class="empty-inline">' + I('cube') + '<span>' + esc((lm && lm.error) || 'No models in LM Studio yet.') + '</span></div>'
				: '') +
			'</div>'
		);
	}

	// ------------------------------------------------------------ Cloud tasks

	const CLOUD_STATE = {
		dispatching: ['busy', 'Starting'],
		queued: ['busy', 'Queued'],
		in_progress: ['live', 'Running'],
		completed: ['ok', 'Done'],
		failed: ['err', 'Failed']
	};
	const since = (ms) => {
		const s = Math.max(0, (Date.now() - ms) / 1000);
		return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
	};
	function cloudPage() {
		const root = h('div', 'page cloud-page');
		root.appendChild(
			header(
				'Cloud tasks',
				'Send a task to the cloud: the agent runs in a GitHub Actions VM on its own branch — free on public repos, 2,000 minutes a month on private ones — pushes it and opens a pull request, while you keep working. Follow it here or from your phone.',
				'<button class="icon-btn" data-act="cloud-refresh" title="Check again">' + I('refresh') + '</button>'
			)
		);
		const c = S.cloud;
		if (!c) {
			if (!S.cloudAsked) {
				S.cloudAsked = true;
				post({ type: 'cloudStatus' });
			}
			root.appendChild(h('div', 'card empty-inline', '<span class="spinner"></span><span>Checking GitHub and this repository…</span>'));
			return root;
		}
		const ok = (v) => (v === true ? '<span class="cl-check ok">' + I('check') + '</span>' : v === false ? '<span class="cl-check no"></span>' : '<span class="cl-check unk">?</span>');
		const modelReady = !!(c.model && !c.model.local && !c.model.unsupported);
		const setupBlocker = !c.repo ? 'Open a GitHub project or configure this project\'s origin remote, then press Check again.' : !modelReady ? 'Choose a supported hosted API provider and select its model in the chat first.' : '';
		const runBlocker = setupBlocker || (!c.signedIn ? 'Sign in to GitHub first.' : !c.remoteWorkflow ? 'Add and commit the cloud workflow to GitHub first.' : c.secret !== true ? 'Confirm the ZER0NE_API_KEY repository secret with Check again first.' : '');
		const ready = !runBlocker;
		const doneSteps = [c.signedIn, !!c.repo, !!c.remoteWorkflow, c.secret === true, modelReady].filter(Boolean).length;
		root.appendChild(
			h(
				'div',
				'cloud-hero' + (ready ? ' ready' : ''),
				'<div class="ch-steps">' + [1, 2, 3, 4, 5].map((i) => '<i class="' + (i <= doneSteps ? 'on' : '') + '"></i>').join('') + '</div>' +
					(S.cloudSteps ? '<div class="ch-progress">' + [['signin', 'Sign in'], ['files', 'Files'], ['push', 'Commit'], ['secret', 'API key']].map(([id, label]) => { const st = S.cloudSteps[id] || {}; return '<span class="chp s-' + (st.state || 'wait') + '" title="' + esc(st.note || '') + '">' + (st.state === 'run' ? '<span class="spinner"></span>' : st.state === 'ok' ? I('check') : st.state === 'err' ? I('alert') : '<i></i>') + label + '</span>'; }).join('') + '</div>' : '') +
					'<div class="ch-text"><b>' + (ready ? 'Ready — describe a task below' : doneSteps + ' of 5 ready') + '</b><span>' + (ready ? 'Each task runs in its own VM on a <code>zer0ne/…</code> branch and comes back as a pull request.' : setupBlocker ? esc(setupBlocker) : 'Signs in and commits the workflow to GitHub. Saves your API key with gh, or opens GitHub for you to add it.') + '</span></div>' +
					(ready ? '' : '<button class="btn btn-primary" data-act="cloud-auto"' + (setupBlocker ? ' disabled title="' + esc(setupBlocker) + '"' : '') + '>' + I('zap') + 'Set up everything</button>')
			)
		);
		root.appendChild(
			h(
				'div',
				'card cloud-setup' + (ready ? ' ready' : ''),
				'<div class="cl-row">' + ok(c.signedIn) + '<div class="grow"><b>GitHub</b><span>' + (c.signedIn ? 'Signed in as <code>' + esc(c.login) + '</code>' + (c.via ? ' · via ' + esc(c.via) : '') : desktopHost() ? 'Sign in with the <code>gh</code> CLI (used automatically when it is signed in), or paste a GitHub token: it is kept in your system\'s key store.' : 'Sign in with VS Code\'s GitHub account, the <code>gh</code> CLI (used automatically when it is signed in), or paste a token.') + '</span>' +
					(S.cloudTokenOpen ? '<div class="cl-token"><input id="cloud-token" class="input mono" type="password" placeholder="github_pat_… or ghp_… (needs repo + workflow)" autocomplete="off"><button class="btn btn-primary btn-sm" data-act="cloud-token-save">Save</button><button class="btn btn-ghost btn-sm" data-act="cloud-token-open">Cancel</button><button class="link-btn" data-act="open-url" data-url="https://github.com/settings/tokens/new?scopes=repo,workflow&description=zer0ne%20cloud%20tasks">Create a token ↗</button></div>' : '') + '</div>' +
					(c.signedIn ? (c.via === 'token' ? '<button class="btn btn-ghost btn-sm" data-act="cloud-signout">Forget token</button>' : '') : '<button class="btn btn-primary btn-sm" data-act="cloud-signin">Sign in</button><button class="btn btn-ghost btn-sm" data-act="cloud-token-open">Paste a token</button>') + '</div>' +
					'<div class="cl-row">' + ok(!!c.repo) + '<div class="grow"><b>Repository</b><span>' + (c.repo ? '<code>' + esc(c.repo) + '</code> · branch <code>' + esc(c.branch || '?') + '</code>' + (c.branchPushed === false ? ' <span class="cl-warn">not on GitHub — tasks start from <code>' + esc(c.defaultBranch || 'the default branch') + '</code></span>' : '') + (c.visibility ? ' · ' + c.visibility + (c.visibility === 'public' ? ' (Actions minutes are free)' : ' (2,000 free minutes / month)') : '') : (c.workspacePath ? 'No GitHub <code>origin</code> detected in <code>' + esc(c.workspacePath) + '</code>. Publish this project to GitHub and set its origin remote, or open an existing clone. Then press Check again.' : 'Open a folder cloned from GitHub.')) + '</span></div>' + (!c.repo ? '<button class="btn btn-secondary btn-sm" data-act="cloud-folder">Open project</button>' : '') + '</div>' +
					'<div class="cl-row">' + ok(c.remoteWorkflow === undefined ? (c.localFiles ? undefined : false) : c.remoteWorkflow) + '<div class="grow"><b>Workflow in the repo</b><span>' + (c.remoteWorkflow ? '<code>zer0ne-cloud.yml</code> is on <code>' + esc(c.defaultBranch || 'the default branch') + '</code> — GitHub only starts workflows from the default branch.' : c.localFiles ? 'Added here — commit it to <code>' + esc(c.defaultBranch || 'the default branch') + '</code> on GitHub (only workflows there can be started).' : 'Adds <code>.github/workflows/zer0ne-cloud.yml</code>, <code>.zer0ne/cloud/runner.mjs</code> (the headless zer0ne agent) and a <code>setup.sh</code> for your install steps.') + '</span></div>' +
					(c.remoteWorkflow ? '<button class="btn btn-ghost btn-sm" data-act="cloud-push" title="Upload the latest runner to GitHub">Update</button>' : c.localFiles ? '<button class="btn btn-primary btn-sm" data-act="cloud-push"' + (c.repo ? '' : ' disabled title="Configure a GitHub origin remote first"') + '>Commit to GitHub</button>' : '<button class="btn btn-primary btn-sm" data-act="cloud-setup"' + (c.workspacePath || c.repo ? '' : ' disabled title="Open a project folder first"') + '>Add files</button>') + '</div>' +
					'<div class="cl-row">' + ok(c.secret) + '<div class="grow"><b>API key secret</b><span>' + (c.secret ? '<code>ZER0NE_API_KEY</code> is set.' : 'The cloud VM needs your provider key as the repository secret <code>ZER0NE_API_KEY</code>.' + (c.ghCli ? ' zer0ne can set it with the <code>gh</code> CLI (encrypted).' : '')) + '</span></div>' + (c.secret ? '' : '<button class="btn btn-secondary btn-sm" data-act="cloud-secret"' + (c.repo ? '' : ' disabled') + '>' + (c.ghCli ? 'Set with gh' : 'Open GitHub secrets') + '</button>') + '</div>' +
					'<div class="cl-row">' + ok(modelReady) + '<div class="grow"><b>Model</b><span>' + (c.model ? (c.model.local ? '<code>' + esc(c.model.provider) + '</code> runs on this computer — the cloud cannot reach it. Pick a hosted provider in the chat.' : c.model.unsupported ? esc(c.model.unsupported) : 'The chat\'s model: <code>' + esc(c.model.provider) + ' / ' + esc(c.model.model) + '</code>') : 'Pick a model in the chat.') + '</span></div>' + (!modelReady ? '<button class="btn btn-secondary btn-sm" data-nav-to="models">Choose provider</button>' : '') + '</div>'
			)
		);
		root.appendChild(h('div', 'section-label', 'New cloud task'));
		root.appendChild(
			h(
				'div',
				'card cloud-new',
				'<textarea id="cloud-task" class="textarea" rows="3" placeholder="e.g. Add input validation to the signup form and cover it with tests">' + esc(S.cloudDraft || '') + '</textarea>' +
					'<div class="cloud-new-bar"><label class="check"><input type="checkbox" id="cloud-pr" checked> Open a pull request</label><span class="grow"></span><span class="muted">Tip: type <code>/cloud &lt;task&gt;</code> in the chat.</span>' +
					'<button class="btn btn-primary" data-act="cloud-start"' + (ready ? '' : ' disabled title="' + esc(runBlocker) + '"') + '>' + I('send') + 'Run in the cloud</button></div>' + (runBlocker ? '<p class="field-hint">' + esc(runBlocker) + '</p>' : '')
			)
		);
		root.appendChild(h('div', 'section-label', 'Tasks'));
		const tasks = c.tasks || [];
		root.appendChild(
			h(
				'div',
				'cloud-list',
				tasks.length
					? tasks
							.map((t) => {
								const [tone, label] = CLOUD_STATE[t.status] || CLOUD_STATE.queued;
								const done = t.status === 'completed' || t.status === 'failed';
								const steps = (t.jobSteps || []).filter((s) => !/^(Set up job|Post |Complete job)/.test(s.name));
								const open = S.cloudOpen === t.id;
								return (
									'<div class="cloud-card t-' + tone + (open ? ' open' : '') + '" data-cloud="' + esc(t.id) + '">' +
									'<div class="cc-top"><span class="cc-state"><i></i>' + label + (t.conclusion && t.status === 'failed' ? ' · ' + esc(String(t.conclusion).slice(0, 60)) : '') + '</span><span class="grow"></span><span class="muted mono">' + esc(since(t.createdAt)) + '</span></div>' +
									'<button class="cc-task" data-act="cloud-toggle">' + esc(t.task.length > 180 ? t.task.slice(0, 180) + '…' : t.task) + '</button>' +
									'<div class="cc-meta"><span class="mono">' + I('branch') + esc(t.branch) + '</span><span>' + esc(t.provider + ' / ' + t.model) + '</span>' + (t.steps ? '<span>' + t.steps.length + ' steps</span>' : '') + (t.result === 'no-changes' ? '<span>no file changes</span>' : '') + (t.followUps ? '<span>' + t.followUps + ' follow-up' + (t.followUps > 1 ? 's' : '') + '</span>' : '') + '</div>' +
									(!done && steps.length ? '<div class="cc-steps">' + steps.map((s) => '<span class="cc-step ' + (s.status === 'completed' ? (s.conclusion === 'success' ? 'ok' : s.conclusion === 'skipped' ? 'skip' : 'err') : s.status === 'in_progress' ? 'run' : '') + '">' + esc(s.name.replace(/^Run /, '')) + '</span>').join('') + '</div>' : '') +
									(open && t.summary ? '<div class="cc-summary md">' + (window.MD ? window.MD.render(t.summary) : esc(t.summary)) + '</div>' : '') +
									(open && t.steps && t.steps.length ? '<div class="cc-trace">' + t.steps.map((s) => '<div class="' + (s.ok ? '' : 'err') + '"><code>' + esc(s.tool) + '</code> ' + esc(s.arg) + '</div>').join('') + '</div>' : '') +
									'<div class="cc-actions">' +
									(t.runUrl ? '<button class="btn btn-ghost btn-sm" data-act="open-url" data-url="' + esc(t.runUrl) + '">' + I('link') + 'Run log</button>' : '') +
									(t.prUrl ? '<button class="btn btn-secondary btn-sm" data-act="open-url" data-url="' + esc(t.prUrl) + '">' + I('branch') + 'Pull request</button>' : '') +
									(done ? '<button class="btn btn-ghost btn-sm" data-act="cloud-follow">' + I('chat') + 'Follow up</button><button class="btn btn-primary btn-sm" data-act="cloud-teleport" title="Check out the branch here and open the result as a chat">' + I('arrowDown') + 'Teleport</button><button class="icon-btn" data-act="cloud-remove" title="Remove from the list">' + I('trash') + '</button>' : '<button class="btn btn-ghost btn-sm" data-act="cloud-cancel">' + I('stop') + 'Cancel</button>') +
									'</div></div>'
								);
							})
							.join('')
					: '<div class="card empty-inline">' + I('globe') + '<span>No cloud tasks yet.</span></div>'
			)
		);
		return root;
	}

	let jobDialog = null;

	function capabilityHeader(title, icon, description, actions) {
		return h('div', 'cap-header', '<div class="cap-heading"><span class="cap-symbol">' + I(icon) + '</span><div><div class="cap-eyebrow">Extend your agent</div><h1 class="page-title">' + esc(title) + '</h1><p class="page-desc">' + description + '</p></div></div><div class="cap-header-actions">' + (actions || '') + '</div>');
	}
	function capabilityStats(items) {
		return h('div', 'cap-stats', items.map(([value, label, icon]) => '<div class="cap-stat"><span class="cap-stat-icon">' + I(icon) + '</span><div><b>' + value + '</b><span>' + esc(label) + '</span></div></div>').join(''));
	}
	function capabilitySearch(id, value, placeholder, extra) {
		return h('div', 'cap-toolbar', '<div class="search-box cap-search">' + I('search') + '<input id="' + id + '" aria-label="' + esc(placeholder) + '" placeholder="' + esc(placeholder) + '" value="' + esc(value || '') + '" autocomplete="off"></div>' + (extra || ''));
	}
	function capabilityTabs(items, selected, attribute, label) {
		const tabs = h('div', 'local-tabs cap-tabs', items.map(([id, text]) => '<button role="tab" aria-selected="' + (selected === id) + '" tabindex="' + (selected === id ? 0 : -1) + '" class="local-tab' + (selected === id ? ' active' : '') + '" ' + attribute + '="' + id + '">' + text + '</button>').join(''));
		tabs.setAttribute('role', 'tablist');
		tabs.setAttribute('aria-label', label);
		tabs.addEventListener('keydown', (e) => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
			e.preventDefault();
			const buttons = [...tabs.querySelectorAll('button')];
			const index = buttons.indexOf(e.target);
			const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
			const id = buttons[next].getAttribute(attribute);
			buttons[next].click();
			const button = document.querySelector('.cap-tabs [' + attribute + '="' + id + '"]');
			if (button) button.focus();
		});
		return tabs;
	}
	function recordingBanner() {
		const r = S.recording;
		if (!r) return null;
		return h('div', 'record-banner', '<span class="record-dot' + (r.state === 'paused' || r.state === 'review' ? ' quiet' : '') + '"></span><div class="grow"><b>' + esc(r.state === 'review' ? 'Recording ready to review' : r.state === 'generating' ? 'Creating your draft…' : r.state === 'paused' ? 'Recording paused' : 'Recording your workflow') + '</b><span>' + r.frames + ' frames · ' + r.events + ' actions</span></div><button class="btn btn-secondary btn-sm" data-act="record-open">Open recording</button>');
	}
	function openWorkflowRecorder(target) {
		if (!window.SkillRecorder) return toast('The recording module is unavailable. Reload the extension.', 'error');
		window.SkillRecorder.open(target, { openDialog, toast, providers: S.providers, selection: S.selection,
			onState: (recording) => { S.recording = recording; if (S.open && S.section === 'plugins') renderPage(); },
			onSaved: (message) => { S.section = normalizeSection(message.target === 'plugin' ? 'plugins' : 'skills'); if (message.target === 'plugin') S.pluginTab = 'installed'; else S.skillTab = 'installed'; renderNav(); renderPage(); toast('Saved ' + message.name + '.', 'ok'); }
		});
	}
	// ------------------------------------------------------------- merged pages

	/** Settings → Plugins & Skills: the plugin marketplace and the skill library, one entry. */
	function pluginsSkillsPage() {
		const root = h('div', 'page merged-page');
		const tab = S.psTab || 'plugins';
		root.appendChild(capabilityTabs([['plugins', I('puzzle') + 'Plugins <span class="count">' + (S.plugins || []).length + '</span>'], ['skills', I('book') + 'Skills <span class="count">' + (S.skills || []).length + '</span>']], tab, 'data-ps-tab', 'Plugins & Skills'));
		root.appendChild(tab === 'skills' ? skillsPage() : pluginsPage());
		return root;
	}

	function pluginsPage() {
		const root = h('div', 'page cap-page plugins-page');
		root.appendChild(capabilityHeader(tr('plugins'), 'puzzle', 'Find plugins that fit your workflow, install your own, or turn a recorded demonstration into a plugin.', S.isRemote ? '' : '<button class="btn btn-secondary" data-act="plugin-install-git">' + I('branch') + 'From Git URL</button><button class="btn btn-primary" data-act="record-plugin">' + I('record') + 'Record workflow</button>'));
		const tab = S.pluginTab || 'installed';
		const count = (S.plugins || []).length;
		root.appendChild(capabilityStats([[count, 'Installed plugins', 'puzzle'], [(S.plugins || []).filter((p) => p.enabled).length, 'Enabled', 'check'], [(S.plugins || []).reduce((n, p) => n + (p.counts.skills || 0), 0), 'Included skills', 'book']]));
		const recording = recordingBanner(); if (recording) root.appendChild(recording);
		root.appendChild(capabilityTabs([['installed', I('puzzle') + 'Installed <span class="count">' + count + '</span>'], ['market', I('search') + 'Marketplace']], tab, 'data-plugin-tab', 'Plugins'));
		root.appendChild(tab === 'market' ? marketplaceTab() : pluginsSection());
		return root;
	}

	function marketplaceTab() {
		const wrap = h('div', 'marketplace');
		const M = (S.mkt = S.mkt || { source: null, query: '', category: '', lists: {} });
		if (!M.sources && !M.asked) {
			M.asked = true;
			post({ type: 'mktSources' });
		}
		const sources = M.sources || [];
		const src = M.source || (sources[0] && sources[0].id);
		const list = src && M.lists[src];
		if (src && !list) {
			M.lists[src] = { loading: true };
			post({ type: 'mktFetch', id: src });
		}
		const q = (M.query || '').toLowerCase();
		const plugins = ((list && list.plugins) || []).filter((p) => (!q || (p.name + ' ' + p.description + ' ' + (p.tags || []).join(' ')).toLowerCase().includes(q)) && (!M.category || p.category === M.category));
		const cats = [...new Set(((list && list.plugins) || []).map((p) => p.category).filter(Boolean))].sort();
		const installed = new Map((M.installed || []).filter(p => p.scope === (M.scope || 'user')).map((p) => [p.name, p]));
		plugins.sort((a, b) => Number(installed.has(b.name)) - Number(installed.has(a.name)) || a.name.localeCompare(b.name));
		const origins = M.origins || {};
		wrap.innerHTML =
			'<button class="btn btn-ghost btn-sm" data-plugin-tab="installed">' + I('back') + 'Back to installed plugins</button>' +
			'<div class="mkt-sources">' +
			sources.map((s) => '<button class="mkt-source' + (s.id === src ? ' active' : '') + '" data-mkt-source="' + esc(s.id) + '" title="' + esc(s.id) + '">' + (s.builtIn ? I('check') : I('branch')) + esc(s.name) + (s.builtIn ? '' : '<span class="mkt-x" data-mkt-remove="' + esc(s.id) + '" title="Remove">×</span>') + '</button>').join('') +
			'<span class="mkt-add"><input id="mkt-new" class="input mono" placeholder="owner/repo" spellcheck="false"><button class="btn btn-ghost btn-sm" data-act="mkt-add">' + I('plus') + 'Add marketplace</button></span></div>' +
			'<div class="hf-bar"><div class="hf-search">' + I('search') + '<input id="mkt-q" placeholder="Search ' + esc((sources.find((s) => s.id === src) || {}).name || 'plugins') + '…" value="' + esc(M.query || '') + '"></div>' +
			'<select id="mkt-cat" class="select"><option value="">All categories</option>' + cats.map((c) => '<option' + (c === M.category ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select>' +
			'<select id="mkt-scope" class="select"><option value="user">Install for all workspaces</option><option value="workspace"' + (M.scope === 'workspace' ? ' selected' : '') + '>This workspace only</option></select>' +
			'<button class="icon-btn" data-act="mkt-refresh" title="Reload the catalogue">' + I('refresh') + '</button></div>' +
			(list && list.loading ? '<div class="card empty-inline"><span class="spinner"></span><span>Loading the marketplace…</span></div>' : '') +
			(list && list.error ? '<div class="card empty-inline">' + I('alert') + '<span>' + esc(list.error) + '</span></div>' : '') +
			(list && !list.loading && !list.error ? '<div class="group-desc">' + plugins.length + ' of ' + list.plugins.length + ' plugins · plugins with hooks or MCP servers install switched off until you review them.</div>' : '') +
			'<div class="mkt-grid">' +
			plugins
				.slice(0, 200)
				.map((p) => {
					const have = installed.get(p.name);
					const o = have && origins[have.id];
					const update = have && o && o.marketplace === p.marketplace && p.version && o.version && p.version !== o.version;
					const busy = (S.mktBusy || {})[p.name];
					return (
						'<div class="mkt-card"><div class="mkt-head"><span class="mkt-icon">' + esc((p.name[0] || '?').toUpperCase()) + '</span><div class="grow"><div class="mkt-name">' + esc(p.name) + '</div><div class="mkt-by">' + esc(p.author || p.marketplace) + (p.version ? ' · v' + esc(p.version) : '') + '</div></div>' +
						(busy ? '<span class="spinner"></span>' : have ? (update ? '<button class="btn btn-primary btn-sm" data-act="mkt-install" data-name="' + esc(p.name) + '">Update</button>' : '<span class="badge ok">' + I('check') + 'Installed</span>') : '<button class="btn btn-secondary btn-sm" data-act="mkt-install" data-name="' + esc(p.name) + '">' + I('arrowDown') + 'Install</button>') +
						'</div><div class="mkt-desc">' + esc(p.description) + '</div>' +
						'<div class="mkt-tags">' + (p.category ? '<span class="badge">' + esc(p.category) + '</span>' : '') + (p.tags || []).slice(0, 3).map((t) => '<span class="badge mono">' + esc(t) + '</span>').join('') + (p.homepage ? '<button class="link-btn" data-act="local-get" data-url="' + esc(p.homepage) + '">Homepage ↗</button>' : '') + '</div></div>'
					);
				})
				.join('') +
			'</div>';
		return wrap;
	}

	function indexSection() {
		const ci = S.codeIndex || {};
		const providers = (S.providers || []).filter((p) => p.apiFormat === 'openai');
		const wrap = h('div', 'plugins-section');
		wrap.innerHTML =
			'<div class="section-head"><div><div class="section-label">Code index</div><div class="group-desc">' +
			(ci.building ? '<span class="spinner"></span> Building…' : ci.chunks ? esc(ci.files + ' files · ' + ci.chunks + ' chunks' + (ci.embedded ? ' · ' + ci.embedded + ' embedded' : '')) : 'Built automatically the first time the agent searches.') +
			'</div></div>' + (S.isRemote ? '' : '<div class="section-actions"><button class="btn btn-secondary btn-sm" data-act="rebuild-index"' + (ci.building || !S.settings.codeIndex ? ' disabled' : '') + '>' + I('refresh') + 'Rebuild now</button></div>') + '</div>' +
			'<div class="card">' +
			selectRow('Embeddings (optional)', 'Also index by meaning with an OpenAI-format embeddings endpoint (OpenAI, Mistral, a local server…). Code and document chunks are sent to that provider; costs apply. Keyword search works without it.', 'embeddingProvider', [['', 'Off — keywords only (local)'], ...providers.map((p) => [p.id, p.name])]) +
			(S.settings.embeddingProvider ? '<div class="setting-row"><div class="text"><div class="name">Embedding model</div><div class="desc">e.g. <code>text-embedding-3-small</code>. Changing it re-embeds the project.</div></div><div class="control"><input id="s-embeddingModel" class="input mono" data-setting="embeddingModel" spellcheck="false" value="' + esc(S.settings.embeddingModel || '') + '"></div></div>' : '') +
			'</div>';
		return wrap;
	}

	/** Installed plugins (ZCode / Claude Code format) and discovered commands & agents. */
	function pluginsSection() {
		const wrap = h('div', 'plugins-section');
		const count = (n, label) => (n ? '<span class="badge">' + n + ' ' + label + (n > 1 ? 's' : '') + '</span>' : '');
		const q = (S.pluginInstalledQ || '').toLowerCase();
		const plugins = (S.plugins || []).filter((p) => !q || (p.name + ' ' + p.description).toLowerCase().includes(q));
		wrap.appendChild(capabilitySearch('plugin-installed-q', S.pluginInstalledQ, 'Search installed plugins'));
		wrap.insertAdjacentHTML('beforeend',
			'<div class="section-head"><div><div class="section-label">Your plugins</div><div class="group-desc">Manage the skills, commands, agents and connections each plugin adds.</div></div>' +
			(S.isRemote ? '' : '<div class="section-actions"><button class="btn btn-ghost btn-sm" data-act="plugin-folder">' + I('folder') + 'Open folder</button><button class="btn btn-secondary btn-sm" data-act="plugin-install-git">' + I('branch') + 'From Git URL</button><button class="btn btn-primary btn-sm" data-act="plugin-install-folder">' + I('plus') + 'Install from folder</button></div>') +
			'</div>' +
			(plugins.length
				? '<div class="card">' +
					plugins
						.map(
							(p) =>
								'<div class="mcp-row" data-plugin="' + esc(p.id) + '"><div class="mcp-main"><div class="mcp-title">' + I('puzzle') + '<b>' + esc(p.name) + '</b>' + (p.version ? '<span class="badge mono">v' + esc(p.version) + '</span>' : '') + '<span class="badge">' + esc(p.scope) + '</span>' +
								count(p.counts.commands, 'command') + count(p.counts.skills, 'skill') + count(p.counts.agents, 'agent') + count(p.counts.hooks, 'hook') + count(p.counts.mcp, 'MCP server') + '</div>' +
								(p.warnings?.length ? '<div class="callout warn-callout"><div><b>Compatibility</b><p>' + p.warnings.map(esc).join('<br>') + '</p></div></div>' : '') + (p.description ? '<div class="mcp-sub">' + esc(p.description) + '</div>' : '') + (p.error ? '<div class="mcp-sub">' + esc(p.error) + '</div>' : '') +
								'</div><div class="mcp-actions"><button class="icon-btn danger" data-act="plugin-remove" title="Remove">' + I('trash') + '</button><label class="switch" title="' + (p.enabled ? 'Enabled' : 'Disabled') + '"><input type="checkbox" data-act="plugin-toggle"' + (p.enabled ? ' checked' : '') + '><span class="track"></span></label></div></div>'
						)
						.join('') +
					'</div>'
				: '<div class="card empty-inline">' + I('puzzle') + '<span>' + (q ? 'No installed plugins match your search.' : 'Your plugin library is empty. Explore Marketplace or record a workflow to create your first plugin.') + '</span></div>') +
			'<div class="section-label">Custom commands</div><div class="group-desc">Markdown files in <code>.zer0ne/commands</code> (also <code>.claude/</code> and <code>.opencode/</code>) become <code>/commands</code>. Agent files live on <button class="link-btn" data-nav-to="agent">Agent → Subagents</button></div>' +
			'<div class="card ca-list"><div class="ca-head">' + I('command') + ' Commands <span class="badge">' + (S.commands || []).length + '</span></div>' +
			((S.commands || []).slice(0, 60).map((c) => '<div class="ca-row"><code>/' + esc(c.name) + '</code><span class="grow">' + esc(c.description || '') + '</span><span class="badge">' + esc(c.source) + '</span></div>').join('') || '<div class="ca-empty">None yet.</div>') +
			'</div>');
		return wrap;
	}

	function openPluginGitDialog() {
		const d = openDialog({ title: 'Install plugin from Git', small: true });
		d.body.innerHTML =
			'<div class="field"><div class="field-label">Repository URL</div><input id="pg-url" class="input mono" placeholder="https://github.com/owner/plugin-or-marketplace.git" spellcheck="false"><div class="field-hint">A single plugin, or a marketplace repo with a <code>plugins/</code> folder (every plugin in it is installed). Requires <code>git</code>. Plugins can run commands (hooks, MCP servers) — install only ones you trust.</div></div>' +
			'<div class="field"><div class="field-label">Install for</div><select id="pg-scope" class="select"><option value="user">All my workspaces</option><option value="workspace">This workspace only (.zer0ne/plugins)</option></select></div>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>' + I('arrowDown') + 'Install</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-ok]').addEventListener('click', () => {
			const url = d.body.querySelector('#pg-url').value.trim();
			if (!/^(https:\/\/|git@)/.test(url)) return toast('Use an https:// or git@ URL.', 'error');
			post({ type: 'installPlugin', from: 'git', url, scope: d.body.querySelector('#pg-scope').value });
			d.close();
		});
		d.body.querySelector('#pg-url').focus();
	}

	// ------------------------------------------------------------ MCP

	/**
	 * The MCP catalog: popular servers with what they do, why they help and a
	 * prompt to try. cmd is a command (stdio) or an https URL (remote).
	 * access: free (no key) · oauth (sign in once) · key (needs a key or config)
	 */
	const MCP_CATALOG = [
		{ n: 'context7', c: 'npx', a: '-y @upstash/context7-mcp', d: 'Up-to-date library docs & code examples', cat: 'Docs', acc: 'free', what: 'Pulls the current documentation and code examples for thousands of libraries and frameworks, by version.', why: 'Stops the model from writing code against APIs that changed after its training — the #1 cause of broken suggestions.', tools: ['resolve-library-id', 'get-library-docs'], try: 'Use context7 to look up the Next.js 15 app router caching docs, then fix my fetch calls.', url: 'https://github.com/upstash/context7' },
		{ n: 'deepwiki', c: 'https://mcp.deepwiki.com/mcp', a: '', d: 'Ask questions about any public GitHub repo', cat: 'Docs', acc: 'free', what: 'Answers questions about any public GitHub repository from an indexed wiki of its code.', why: 'Understand a dependency\'s internals without cloning it — great when docs are thin.', tools: ['read_wiki_structure', 'read_wiki_contents', 'ask_question'], try: 'Ask deepwiki how vercel/ai streams tool calls, then mirror that in our client.', url: 'https://deepwiki.com' },
		{ n: 'microsoft-learn', c: 'https://learn.microsoft.com/api/mcp', a: '', d: 'Official Microsoft / Azure / .NET docs', cat: 'Docs', acc: 'free', what: 'Search and fetch official Microsoft Learn documentation and code samples.', why: 'Accurate, current answers for Azure, .NET, TypeScript, VS Code APIs and Windows.', tools: ['microsoft_docs_search', 'microsoft_docs_fetch', 'microsoft_code_sample_search'], try: 'Find the Microsoft Learn page for Azure Functions Flex Consumption limits.', url: 'https://learn.microsoft.com/training/support/mcp' },
		{ n: 'cloudflare-docs', c: 'https://docs.mcp.cloudflare.com/mcp', a: '', d: 'Cloudflare developer docs', cat: 'Docs', acc: 'free', what: 'Searches Cloudflare\'s developer documentation (Workers, R2, D1, Pages…).', why: 'Correct bindings and wrangler config on the first try.', tools: ['search_cloudflare_documentation'], try: 'How do I bind a D1 database in wrangler.toml for a Worker?', url: 'https://github.com/cloudflare/mcp-server-cloudflare' },
		{ n: 'aws-docs', c: 'uvx', a: 'awslabs.aws-documentation-mcp-server@latest', d: 'AWS documentation search & read', cat: 'Docs', acc: 'free', what: 'Searches and reads AWS documentation pages as markdown, with recommendations.', why: 'Service limits, IAM policies and SDK usage straight from AWS.', tools: ['search_documentation', 'read_documentation', 'recommend'], try: 'What are the Lambda response streaming limits? Cite the AWS docs.', url: 'https://github.com/awslabs/mcp' },
		{ n: 'exa', c: 'https://mcp.exa.ai/mcp', a: '', d: 'Web + code search', cat: 'Search', acc: 'free', what: 'Neural web search plus a code-context search across GitHub, docs and Stack Overflow.', why: 'Finds real, working examples when the answer is not in any single doc.', tools: ['web_search_exa', 'get_code_context_exa'], try: 'Search for examples of rate-limiting a Hono API with Upstash.', url: 'https://exa.ai' },
		{ n: 'fetch', c: 'uvx', a: 'mcp-server-fetch', d: 'Fetch web pages as markdown', cat: 'Search', acc: 'free', what: 'Downloads a URL and converts it to clean markdown, page by page.', why: 'Lets the agent read a changelog, RFC or issue you link to.', tools: ['fetch'], try: 'Fetch the release notes at <url> and list the breaking changes.', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
		{ n: 'firecrawl', c: 'npx', a: '-y firecrawl-mcp', d: 'Crawl & scrape whole sites', cat: 'Search', acc: 'key', env: ['FIRECRAWL_API_KEY'], what: 'Scrapes, crawls and maps websites into LLM-ready markdown or structured data.', why: 'Turn an entire docs site or competitor page into context in one call.', tools: ['firecrawl_scrape', 'firecrawl_crawl', 'firecrawl_map', 'firecrawl_search'], try: 'Crawl docs.example.com and summarise its authentication guide.', url: 'https://github.com/firecrawl/firecrawl-mcp-server' },
		{ n: 'tavily', c: 'npx', a: '-y tavily-mcp@latest', d: 'Search built for agents', cat: 'Search', acc: 'key', env: ['TAVILY_API_KEY'], what: 'Real-time web search and page extraction tuned for LLM agents.', why: 'Fresh facts (versions, CVEs, outages) with sources.', tools: ['tavily-search', 'tavily-extract'], try: 'Search for any CVEs published this month for lodash.', url: 'https://github.com/tavily-ai/tavily-mcp' },
		{ n: 'brave-search', c: 'npx', a: '-y @brave/brave-search-mcp-server', d: 'Private web search', cat: 'Search', acc: 'key', env: ['BRAVE_API_KEY'], what: 'Web, news and local search through the Brave Search API.', why: 'Independent index, generous free tier.', tools: ['brave_web_search', 'brave_news_search'], try: 'Search the web for the latest Node.js LTS release date.', url: 'https://github.com/brave/brave-search-mcp-server' },
		{ n: 'playwright', c: 'npx', a: '-y @playwright/mcp@latest', d: 'Browser automation (Microsoft)', cat: 'Browser', acc: 'free', what: 'Drives a real browser via the accessibility tree: click, type, navigate, screenshot.', why: 'End-to-end check of the web app you just changed.', tools: ['browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot'], try: 'Open localhost:3000, sign up with a test user and report any console errors.', url: 'https://github.com/microsoft/playwright-mcp' },
		{ n: 'chrome-devtools', c: 'npx', a: '-y chrome-devtools-mcp@latest', d: 'Chrome DevTools: performance, network, console', cat: 'Browser', acc: 'free', what: 'Chrome DevTools for the agent: performance traces, network requests, console, screenshots.', why: 'Diagnose slow pages and failing requests with real data, not guesses.', tools: ['performance_start_trace', 'list_network_requests', 'list_console_messages'], try: 'Record a performance trace of localhost:5173 and tell me the LCP bottleneck.', url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp' },
		{ n: 'github', c: 'https://api.githubcopilot.com/mcp/', a: '', d: 'Issues, PRs, code search and Actions', cat: 'Code', acc: 'oauth', what: 'GitHub\'s official server: repos, issues, pull requests, code search, Actions runs and security alerts.', why: 'Triage issues, review PRs and read CI logs without leaving the chat.', tools: ['search_code', 'list_issues', 'create_pull_request', 'get_workflow_run_logs'], try: 'List the open issues labelled bug in this repo and group them by area.', url: 'https://github.com/github/github-mcp-server' },
		{ n: 'git', c: 'uvx', a: 'mcp-server-git', d: 'Git history, diffs and branches', cat: 'Code', acc: 'free', what: 'Read and work with a local git repository: log, diff, blame, branches, commits.', why: 'History-aware answers: who changed this and why.', tools: ['git_log', 'git_diff', 'git_show', 'git_branch'], try: 'Show what changed in src/auth in the last 10 commits.', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git' },
		{ n: 'semgrep', c: 'https://mcp.semgrep.ai/mcp', a: '', d: 'Static analysis and security scanning', cat: 'Code', acc: 'oauth', what: 'Runs Semgrep rules on code to find bugs and security issues.', why: 'A second pair of eyes on every change the agent makes.', tools: ['semgrep_scan', 'security_check'], try: 'Scan the files I changed today for security issues.', url: 'https://github.com/semgrep/mcp' },
		{ n: 'filesystem', c: 'npx', a: '-y @modelcontextprotocol/server-filesystem .', d: 'Read/write files in a folder', cat: 'Core', acc: 'free', what: 'File operations limited to the folders you allow.', why: 'Give the agent access to a folder outside the workspace — safely scoped.', tools: ['read_text_file', 'write_file', 'search_files', 'directory_tree'], try: 'List the largest files in ~/Downloads.', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
		{ n: 'memory', c: 'npx', a: '-y @modelcontextprotocol/server-memory', d: 'Knowledge-graph memory', cat: 'Core', acc: 'free', what: 'A persistent knowledge graph of entities and relations.', why: 'Remembers structured facts about your project across chats.', tools: ['create_entities', 'create_relations', 'search_nodes'], try: 'Remember that the payments service owns the invoices table.', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
		{ n: 'sequential-thinking', c: 'npx', a: '-y @modelcontextprotocol/server-sequential-thinking', d: 'Structured step-by-step reasoning', cat: 'Core', acc: 'free', what: 'A scratchpad tool for breaking a problem into revisable steps.', why: 'Helps non-reasoning models plan multi-step changes.', tools: ['sequentialthinking'], try: 'Think through the migration from REST to tRPC step by step.', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
		{ n: 'time', c: 'uvx', a: 'mcp-server-time', d: 'Time and timezone conversion', cat: 'Core', acc: 'free', what: 'Current time and conversions between IANA time zones.', why: 'Schedules, cron expressions and log timestamps without mistakes.', tools: ['get_current_time', 'convert_time'], try: 'What time is 09:00 in Tokyo for our Berlin team?', url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time' },
		{ n: 'postgres', c: 'npx', a: '-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb', d: 'Query a PostgreSQL database (read-only)', cat: 'Data', acc: 'key', what: 'Inspects schemas and runs read-only SQL against a Postgres database.', why: 'Write queries and migrations against the real schema.', tools: ['query'], try: 'Show me the schema of the orders table and write an index for the slow query.', note: 'Edit the connection string in the arguments.', url: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/postgres' },
		{ n: 'sqlite', c: 'uvx', a: 'mcp-server-sqlite --db-path ./data.db', d: 'Query and analyse a SQLite file', cat: 'Data', acc: 'free', what: 'Reads and writes a local SQLite database, with a business-insights memo.', why: 'Quick data exploration without a DB client.', tools: ['read_query', 'write_query', 'list_tables', 'describe_table'], try: 'List the tables in data.db and count the rows in each.', note: 'Point --db-path at your file.', url: 'https://github.com/modelcontextprotocol/servers-archived/tree/main/src/sqlite' },
		{ n: 'supabase', c: 'https://mcp.supabase.com/mcp', a: '', d: 'Supabase projects, SQL and edge functions', cat: 'Data', acc: 'oauth', what: 'Manage Supabase: tables, SQL, migrations, logs, edge functions and branches.', why: 'Design the schema and ship migrations from the chat.', tools: ['list_tables', 'execute_sql', 'apply_migration', 'get_logs'], try: 'Create a profiles table with RLS so users can only read their own row.', url: 'https://supabase.com/docs/guides/getting-started/mcp' },
		{ n: 'neon', c: 'https://mcp.neon.tech/mcp', a: '', d: 'Serverless Postgres with branches', cat: 'Data', acc: 'oauth', what: 'Neon projects, branches and SQL — including safe migration branches.', why: 'Test a migration on a throwaway branch before touching production.', tools: ['run_sql', 'create_branch', 'prepare_database_migration'], try: 'Create a branch, add a nullable column to users and show me the diff.', url: 'https://github.com/neondatabase/mcp-server-neon' },
		{ n: 'mongodb', c: 'npx', a: '-y mongodb-mcp-server', d: 'MongoDB & Atlas', cat: 'Data', acc: 'key', env: ['MDB_MCP_CONNECTION_STRING'], what: 'Query collections, inspect indexes and manage Atlas clusters.', why: 'Aggregation pipelines written against your real documents.', tools: ['find', 'aggregate', 'collection-indexes', 'list-collections'], try: 'Find the 10 slowest orders and suggest an index.', url: 'https://github.com/mongodb-js/mongodb-mcp-server' },
		{ n: 'sentry', c: 'https://mcp.sentry.dev/mcp', a: '', d: 'Errors, issues and releases from Sentry', cat: 'Dev', acc: 'oauth', what: 'Sentry issues, events, stack traces and releases — plus Seer root-cause analysis.', why: 'Go from a production error to the fix with the real stack trace.', tools: ['search_issues', 'get_issue_details', 'analyze_issue_with_seer'], try: 'Show the top unresolved Sentry error this week and fix it.', url: 'https://github.com/getsentry/sentry-mcp' },
		{ n: 'linear', c: 'https://mcp.linear.app/mcp', a: '', d: 'Issues, projects and cycles in Linear', cat: 'Dev', acc: 'oauth', what: 'Read and update Linear issues, projects, cycles and comments.', why: 'Pick up a ticket, implement it and update its status in one flow.', tools: ['list_issues', 'get_issue', 'update_issue', 'create_comment'], try: 'Take my top Linear issue, implement it and move it to In Review.', url: 'https://linear.app/docs/mcp' },
		{ n: 'vercel', c: 'https://mcp.vercel.com', a: '', d: 'Deployments, logs and projects', cat: 'Dev', acc: 'oauth', what: 'Vercel projects, deployments, build logs and docs search.', why: 'Read a failed build log and fix it without opening the dashboard.', tools: ['list_deployments', 'get_deployment_build_logs', 'search_vercel_documentation'], try: 'Why did my last Vercel deployment fail?', url: 'https://vercel.com/docs/mcp/vercel-mcp' },
		{ n: 'stripe', c: 'https://mcp.stripe.com', a: '', d: 'Payments, customers and docs', cat: 'Dev', acc: 'oauth', what: 'Stripe API objects (customers, products, invoices) and Stripe docs search.', why: 'Build billing flows against real test-mode data.', tools: ['create_customer', 'list_products', 'search_stripe_documentation'], try: 'Create a test-mode product with monthly and yearly prices.', url: 'https://docs.stripe.com/mcp' },
		{ n: 'kubernetes', c: 'npx', a: '-y kubernetes-mcp-server@latest', d: 'Kubernetes & OpenShift clusters', cat: 'Dev', acc: 'free', what: 'Pods, deployments, logs, events and Helm on the cluster in your kubeconfig.', why: 'Debug a crash-looping pod with its logs and events side by side.', tools: ['pods_list', 'pods_log', 'resources_get', 'events_list'], try: 'Why is the api pod in staging restarting?', note: 'Uses your current kubeconfig context.', url: 'https://github.com/containers/kubernetes-mcp-server' },
		{ n: 'notion', c: 'https://mcp.notion.com/mcp', a: '', d: 'Search and edit your Notion workspace', cat: 'Work', acc: 'oauth', what: 'Search, read and write Notion pages and databases.', why: 'Specs and meeting notes become context; results go back as docs.', tools: ['search', 'fetch', 'create-pages', 'update-page'], try: 'Read the "Checkout v2" spec in Notion and list what is not implemented yet.', url: 'https://developers.notion.com/docs/mcp' },
		{ n: 'atlassian', c: 'https://mcp.atlassian.com/v1/mcp', a: '', d: 'Jira and Confluence', cat: 'Work', acc: 'oauth', what: 'Jira issues and Confluence pages from Atlassian Cloud.', why: 'Link code changes to tickets and keep docs in sync.', tools: ['searchJiraIssuesUsingJql', 'getConfluencePage', 'createJiraIssue'], try: 'Find my Jira tickets in the current sprint and summarise them.', url: 'https://www.atlassian.com/platform/remote-mcp-server' },
		{ n: 'figma', c: 'http://127.0.0.1:3845/mcp', a: '', d: 'Design context from Figma desktop', cat: 'Work', acc: 'free', what: 'The Figma desktop app\'s Dev Mode server: selected frames, variables and components.', why: 'Build UI that matches the design tokens instead of eyeballing a screenshot.', tools: ['get_code', 'get_variable_defs', 'get_image'], try: 'Implement the selected Figma frame as a React component with our tokens.', note: 'Turn on the Dev Mode MCP server in Figma desktop first.', url: 'https://help.figma.com/hc/en-us/articles/32132100833559' },
		{ n: 'huggingface', c: 'https://huggingface.co/mcp', a: '', d: 'Models, datasets, Spaces and papers', cat: 'AI', acc: 'free', what: 'Search Hugging Face models, datasets, Spaces and papers; run some Spaces as tools.', why: 'Pick the right model or dataset with real stats.', tools: ['model_search', 'dataset_search', 'paper_search', 'space_search'], try: 'Find a small embedding model that runs on CPU and is good for code.', url: 'https://huggingface.co/settings/mcp' }
	];
	const MCP_CATS = ['All', 'Docs', 'Search', 'Browser', 'Code', 'Data', 'Dev', 'Work', 'AI', 'Core'];
	// [name, command | URL, args, description, category, access, env] — the shape the add dialog takes.
	const MCP_EXAMPLES = MCP_CATALOG.map((x) => [x.n, x.c, x.a, x.d, x.cat, x.acc, x.env || []]);
	/** One click: docs + repo Q&A + reasoning — free, no keys. */
	const MCP_STARTER = ['context7', 'deepwiki', 'microsoft-learn', 'sequential-thinking'];
	const ACCESS = { free: ['ok', 'No key'], oauth: ['', 'Sign in (OAuth)'], key: ['warn', 'Needs a key / config'] };
	const mcpCards = () => {
		const q = (S.mcpCatQ || '').toLowerCase();
		const cat = S.mcpCat || 'All';
		const list = MCP_CATALOG.filter((x) => (cat === 'All' || x.cat === cat) && (!q || (x.n + ' ' + x.d + ' ' + x.what).toLowerCase().includes(q)));
		return (
			'<div class="mcp-featured">' +
			list
				.map((x) => {
					const added = (S.mcp || []).some((s) => s.name === x.n);
					const remote = /^https?:/.test(x.c);
					return (
						'<div class="mcp-feature' + (added ? ' added' : '') + '" role="button" tabindex="0" data-mcp-info="' + esc(x.n) + '"><span class="mf-top"><span class="mf-icon c-' + esc(x.cat.toLowerCase()) + '">' + esc(x.n[0].toUpperCase()) + '</span><span class="mf-name">' + esc(x.n) + '</span>' +
						(added ? '<span class="badge ok">' + I('check') + 'Added</span>' : '<button class="icon-btn mf-add" data-mcp-example="' + esc(x.n) + '" title="Add ' + esc(x.n) + '">' + I('plus') + '</button>') + '</span>' +
						'<span class="mf-desc">' + esc(x.d) + '</span><span class="mf-why">' + esc(x.why) + '</span>' +
						'<span class="mf-tags"><span class="badge">' + esc(x.cat) + '</span><span class="badge">' + (remote ? 'remote' : esc(x.c)) + '</span><span class="badge ' + ACCESS[x.acc][0] + '">' + ACCESS[x.acc][1] + '</span></span></div>'
					);
				})
				.join('') +
			(list.length ? '' : '<div class="empty-inline">' + I('search') + '<span>Nothing in the catalog matches — try the MCP Registry search above.</span></div>') +
			'</div>'
		);
	};
	function mcpCatalogSection() {
		return (
			'<div class="section-header-row"><div class="section-label">MCP catalog <span class="muted">— ' + MCP_CATALOG.length + ' hand-picked servers: what each does and why it helps</span></div><button class="btn btn-secondary btn-sm" data-act="mcp-starter">' + I('zap') + 'Add starter pack</button></div>' +
			'<div class="mcp-cat-bar"><div class="search-box">' + I('search') + '<input id="mcp-cat-q" placeholder="Filter the catalog…" autocomplete="off" value="' + esc(S.mcpCatQ || '') + '"></div><div class="cat-chips">' +
			MCP_CATS.map((c) => '<button class="cat-chip' + ((S.mcpCat || 'All') === c ? ' active' : '') + '" data-mcp-cat="' + c + '">' + c + '</button>').join('') + '</div></div>' +
			'<div id="mcp-cat-list">' + mcpCards() + '</div>'
		);
	}
	function openMcpInfo(name) {
		const x = MCP_CATALOG.find((m) => m.n === name);
		if (!x) return;
		const added = (S.mcp || []).some((s) => s.name === x.n);
		const remote = /^https?:/.test(x.c);
		const d = openDialog({ title: x.n });
		d.body.innerHTML =
			'<div class="mcp-info"><div class="mi-head"><span class="mf-icon lg c-' + esc(x.cat.toLowerCase()) + '">' + esc(x.n[0].toUpperCase()) + '</span><div><div class="mi-desc">' + esc(x.d) + '</div><div class="mf-tags"><span class="badge">' + esc(x.cat) + '</span><span class="badge">' + (remote ? 'remote' : 'local') + '</span><span class="badge ' + ACCESS[x.acc][0] + '">' + ACCESS[x.acc][1] + '</span></div></div></div>' +
			'<div class="mi-block"><div class="mi-label">What it is</div><p>' + esc(x.what) + '</p></div>' +
			'<div class="mi-block"><div class="mi-label">Why it helps</div><p>' + esc(x.why) + '</p></div>' +
			'<div class="mi-block"><div class="mi-label">Try asking</div><div class="mi-try"><span>“' + esc(x.try) + '”</span><button class="icon-btn" data-copy-text="' + esc(x.try) + '" title="Copy">' + I('copy') + '</button></div></div>' +
			'<div class="mi-block"><div class="mi-label">Tools it adds</div><div class="mi-tools">' + x.tools.map((t) => '<code>' + esc(t) + '</code>').join('') + '</div></div>' +
			'<div class="mi-block"><div class="mi-label">' + (remote ? 'Endpoint' : 'Runs') + '</div><code class="mi-cmd">' + esc(remote ? x.c : x.c + ' ' + x.a) + '</code>' +
			(x.acc === 'oauth' ? '<p class="muted">Sign in once in your browser after adding it; the token is kept in your OS keychain and refreshes by itself.</p>' : '') +
			(x.env ? '<p class="muted">Needs <code>' + x.env.map(esc).join('</code>, <code>') + '</code> — fill it in the next step.</p>' : '') +
			(x.note ? '<p class="muted">' + esc(x.note) + '</p>' : '') +
			(!remote && x.c === 'uvx' ? '<p class="muted"><code>uvx</code> comes with <b>uv</b> (Python). <code>npx</code> comes with Node.js.</p>' : '') + '</div></div>';
		d.foot.innerHTML = (x.url ? '<button class="btn btn-ghost" data-mi-open>' + I('link') + 'Homepage</button>' : '') + '<span class="spacer"></span><button class="btn btn-ghost" data-close2>Close</button>' + (added ? '<span class="badge ok">' + I('check') + 'Added</span>' : '<button class="btn btn-primary" data-mi-add>' + I('plus') + 'Add ' + esc(x.n) + '</button>');
		d.foot.querySelector('[data-close2]').addEventListener('click', d.close);
		const open = d.foot.querySelector('[data-mi-open]');
		if (open) open.addEventListener('click', () => post({ type: 'openExternal', url: x.url }));
		const add = d.foot.querySelector('[data-mi-add]');
		if (add)
			add.addEventListener('click', () => {
				d.close();
				openMcpDialog(null, MCP_EXAMPLES.find((e) => e[0] === x.n));
			});
		d.body.addEventListener('click', (e) => {
			const b = e.target instanceof Element && e.target.closest('[data-copy-text]');
			if (b && navigator.clipboard) navigator.clipboard.writeText(b.dataset.copyText).then(() => toast('Copied.', ''));
		});
	}
	const isUrlExample = (x) => /^https?:\/\//.test(x[1]);

	function mcpPage() {
		const root = h('div', 'page mcp-page');
		root.appendChild(
			capabilityHeader(
				'MCP servers',
				'server',
				desktopHost() ? 'Servers belong to this project. One live host owns its services; another window for the same folder leaves them with that owner.' : 'Connect your agent to outside tools and services through the Model Context Protocol.',
				'<button class="btn btn-ghost" data-act="mcp-import">' + I('arrowDown') + 'Import JSON</button><button class="btn btn-primary" data-act="mcp-add">' + I('plus') + 'Add server</button>'
			)
		);
		if (desktopHost() && S.capabilities?.optionalServiceOwner === false) root.appendChild(h('div', 'callout', 'Another live host owns this project’s optional services. Close it and reopen this project to take ownership.'));
		const mcpTab = S.mcpTab || 'connected';
		root.appendChild(capabilityTabs([['connected', 'Your servers'], ['discover', 'Discover']], mcpTab, 'data-mcp-tab', 'MCP servers'));
		if (!S.settings.mcp) root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>MCP is turned off. <button class="link-btn" data-act="enable-mcp">Turn it on</button> to start these servers.</div>'));
		if (mcpTab === 'discover') { root.appendChild(mcpDiscoverView()); return root; }
		if (!S.mcp.length) {
			root.appendChild(
				h(
					'div',
					'mcp-empty',
					'<span class="mcp-empty-ico">' + I('plug') + '</span><b>No MCP servers yet</b><p>Add a server, import a Claude Desktop / Cursor / VS Code <code>mcp.json</code>, or start with the free starter pack (Context7 docs, DeepWiki, Microsoft Learn, sequential thinking).</p>' +
						'<div class="mcp-empty-actions"><button class="btn btn-secondary btn-sm" data-act="mcp-add">' + I('plus') + 'Add server</button><button class="btn btn-primary btn-sm" data-act="mcp-starter">' + I('zap') + 'Add starter pack</button></div>'
				)
			);
			return root;
		}
		// Runtime state → the status dot's colour and the reason shown when hovering it.
		const STATE = {
			ready: ['ok', 'Running', 'Connected — its tools are available to the agent.'],
			connecting: ['busy', 'Connecting…', 'Starting the server and discovering its tools.'],
			auth: ['warn', 'Needs sign-in', 'Sign in once to authorize this server.'],
			error: ['err', 'Error', 'The server failed to start or stopped answering.'],
			stopped: ['off', 'Stopped', 'Not running. It starts with the next chat that needs it.']
		};
		const live = (s) => s.enabled && (s.status || {}).state === 'ready';
		const tools = S.mcp.filter(live).reduce((n, s) => n + (s.status.tools || []).filter((t) => !(s.disabledTools || []).includes(t.name)).length, 0);
		const problems = S.mcp.filter((s) => s.enabled && ['error', 'auth'].includes((s.status || {}).state)).length;
		root.appendChild(
			h(
				'div',
				'mcp-summary',
				'<span><b>' + S.mcp.length + '</b> ' + (S.mcp.length === 1 ? 'server' : 'servers') + '</span><span class="ok"><i></i><b>' + S.mcp.filter(live).length + '</b> running</span><span><b>' + tools + '</b> ' + (tools === 1 ? 'tool' : 'tools') + ' available</span>' +
					(problems ? '<span class="warn"><i></i><b>' + problems + '</b> ' + (problems === 1 ? 'needs' : 'need') + ' attention</span>' : '')
			)
		);
		if (S.mcp.length > 4 || S.mcpInstalledQ || S.mcpStateFilter) root.appendChild(capabilitySearch('mcp-installed-q', S.mcpInstalledQ, 'Search your servers', '<select id="mcp-state-filter" class="select" aria-label="Filter connection status">' + [['', 'All connections'], ['ready', 'Running'], ['attention', 'Needs attention'], ['off', 'Turned off']].map(([id, label]) => '<option value="' + id + '"' + ((S.mcpStateFilter || '') === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>'));
		const visibleServers = S.mcp.filter((s) => (!S.mcpInstalledQ || (s.name + ' ' + (s.url || s.command || '') + ' ' + (s.plugin || '')).toLowerCase().includes(S.mcpInstalledQ.toLowerCase())) && (!S.mcpStateFilter || (S.mcpStateFilter === 'off' ? !s.enabled : S.mcpStateFilter === 'attention' ? s.enabled && ['error', 'auth'].includes((s.status || {}).state) : s.enabled && (s.status || {}).state === S.mcpStateFilter)));
		const row = (s) => {
			const st = s.status || { state: 'stopped', tools: [] };
			const [tone, label, reason] = s.enabled ? STATE[st.state] || STATE.stopped : ['off', 'Off', 'Turned off. Switch it on to start the server.'];
			const remote = s.transport === 'http';
			const target = remote ? s.url : [s.command, ...(s.args || [])].join(' ');
			const off = (s.disabledTools || []).filter((n) => st.tools.some((t) => t.name === n)).length;
			const why = st.error ? label + ': ' + st.error : label + ' — ' + reason;
			return (
				'<div class="mcp-item' + (s.enabled ? '' : ' off') + ' t-' + tone + '" data-mcp="' + esc(s.id) + '"' + (s.plugin ? '' : ' data-mcp-row title="Edit ' + esc(s.name) + '"') + '>' +
				'<span class="mcp-ico">' + I(remote ? 'globe' : 'plug') + '<span class="mcp-dot s-' + tone + '" role="img" aria-label="' + esc(label) + '" title="' + esc(why) + '"></span></span>' +
				'<div class="mcp-mid"><div class="mcp-line"><b class="mcp-name">' + esc(s.name) + '</b>' +
				'<span class="mcp-chip">' + I(remote ? 'globe' : 'terminal') + (remote ? 'Remote' : 'Local') + '</span>' +
				(st.oauth ? '<span class="mcp-chip">' + I('key') + 'OAuth</span>' : '') +
				(s.trusted ? '<span class="mcp-chip warn" title="Runs without asking in Agent mode">Trusted</span>' : '') +
				(st.tools.length
					? '<details class="mcp-tools" data-key="mcp-' + esc(s.id) + '"><summary class="mcp-chip tools">' + (st.tools.length - off) + (off ? ' / ' + st.tools.length : '') + ' tools' + I('chevronDown') + '</summary><div class="mcp-tool-list">' + st.tools.map((t) => '<label class="mcp-tool"><input type="checkbox" data-act="mcp-tool-toggle" data-tool="' + esc(t.name) + '"' + ((s.disabledTools || []).includes(t.name) ? '' : ' checked') + (s.plugin ? ' disabled' : '') + '><span><code>' + esc(t.name) + '</code><span class="mcp-tool-desc">' + esc(t.description) + '</span></span></label>').join('') + '</div></details>'
					: '') +
				'</div><div class="mcp-desc mono" title="' + esc(target) + '">' + (remote ? 'http' : 'stdio') + ' · ' + esc(target) + '</div>' +
				(st.state === 'auth'
					? '<div class="mcp-note warn">' + I('key') + '<span>Sign in once — the token stays in your OS keychain and refreshes by itself.</span><button class="btn btn-primary btn-sm" data-act="mcp-signin">Sign in</button></div>'
					: st.error && s.enabled ? '<div class="mcp-note err">' + I('alert') + '<span>' + esc(st.error) + '</span></div>' : '') +
				'</div><div class="mcp-end"><span class="mcp-acts">' + (st.oauth ? '<button class="icon-btn" data-act="mcp-signout" title="Sign out">' + I('close') + '</button>' : '') + '<button class="icon-btn" data-act="mcp-restart" title="Restart">' + I('refresh') + '</button>' +
				(s.plugin ? '' : '<button class="icon-btn" data-act="mcp-edit" title="Edit">' + I('pencil') + '</button><button class="icon-btn danger" data-act="mcp-delete" title="Remove">' + I('trash') + '</button>') + '</span>' +
				(s.plugin ? '' : '<label class="switch" title="' + (s.enabled ? 'Enabled' : 'Disabled') + '"><input type="checkbox" data-act="mcp-toggle"' + (s.enabled ? ' checked' : '') + ' aria-label="' + esc((s.enabled ? 'Turn off ' : 'Turn on ') + s.name) + '"><span class="track"></span></label>') + '</div></div>'
			);
		};
		// Groups (ZCode's settings list): your own servers, then one group per plugin that brings servers.
		const groups = [['Configured', visibleServers.filter((s) => !s.plugin)]];
		for (const name of [...new Set(visibleServers.filter((s) => s.plugin).map((s) => s.plugin))].sort()) groups.push(['Plugin · ' + name, visibleServers.filter((s) => s.plugin === name)]);
		root.appendChild(
			h(
				'div',
				'mcp-groups mcp-list',
				groups
					.filter(([, list]) => list.length)
					.map(([title, list]) => '<section class="mcp-group"><h3 class="mcp-group-head">' + esc(title) + '<span>' + list.length + '</span></h3><div class="mcp-rows">' + list.map(row).join('<div class="mcp-sep" aria-hidden="true"></div>') + '</div></section>')
					.join('')
			)
		);
		if (!visibleServers.length) root.appendChild(h('div', 'card empty-inline', I('search') + '<span>No servers match these filters.</span>'));
		root.appendChild(h('p', 'mcp-footnote', 'stdio and Streamable HTTP · tool discovery and calls · OAuth · interactive tool apps. Legacy HTTP/SSE, resource and prompt browsing, sampling and elicitation are not supported.'));
		return root;
	}
	function mcpDiscoverView() {
		const root = h('div', 'mcp-discover');
		root.appendChild(h('div', 'cap-section-title', '<div><h2>Find your next connection</h2><p class="muted">Search the MCP Registry or choose a ready-to-configure server below.</p></div>'));
		root.appendChild(
			h(
				'div',
				'card registry-card',
				'<div class="search-box">' + I('search') + '<input id="mcp-registry-q" placeholder="Search the official MCP Registry (github, postgres, slack, figma…)" autocomplete="off" value="' + esc(S.registryQuery || '') + '"></div>' +
					'<div class="pick-list" id="mcp-registry-list">' + registryListHtml() + '</div>'
			)
		);
		root.appendChild(h('div', 'mcp-catalog', mcpCatalogSection()));
		return root;
	}

	function registryListHtml() {
		if (!S.registryQuery) return '<div class="pick-empty">Thousands of servers — type to search.</div>';
		if (!S.registryResults) return '<div class="pick-empty"><span class="spinner"></span></div>';
		if (!S.registryResults.length) return '<div class="pick-empty">No installable servers found.</div>';
		return S.registryResults
			.map((r, i) =>
				'<button class="pick-item" data-registry="' + i + '">' + I('server') + '<span class="grow">' + esc(r.title) + (r.version ? ' <span class="muted small">v' + esc(r.version) + '</span>' : '') +
				'<span class="sub">' + esc(r.description.slice(0, 140)) + '</span></span>' +
				'<span class="badge">' + esc(r.config.transport === 'http' ? 'remote' : r.config.command) + '</span>' + (r.needs.length ? '<span class="badge warn" title="' + esc(r.needs.join(', ')) + '">needs ' + r.needs.length + ' key' + (r.needs.length > 1 ? 's' : '') + '</span>' : '') + I('plus') + '</button>'
			)
			.join('');
	}

	function openMcpDialog(existing, example) {
		if (example && !Array.isArray(example)) {
			// From the MCP Registry: a ready config (fill in the secrets it needs).
			existing = null;
			example = null;
		}
		const preset = openMcpDialog.preset;
		openMcpDialog.preset = null;
		const f = preset
			? { enabled: true, trusted: false, ...preset }
			: existing
			? { ...existing }
			: example && isUrlExample(example)
				? { name: example[0], transport: 'http', command: '', args: [], env: {}, url: example[1], headers: {}, enabled: true, trusted: false }
				: { name: example ? example[0] : '', transport: 'stdio', command: example ? example[1] : '', args: example ? example[2].split(' ').filter(Boolean) : [], env: example && example[6] ? Object.fromEntries(example[6].map((k) => [k, ''])) : {}, url: '', headers: {}, enabled: true, trusted: false };
		const d = openDialog({ title: existing ? 'Edit MCP server' : 'Add MCP server' });
		const kv = (obj, sep) => Object.entries(obj || {}).map(([k, v]) => k + sep + v).join('\n');
		d.body.innerHTML =
			'<div class="field"><div class="field-label">Name</div><input id="mcp-name" class="input mono" value="' + esc(f.name) + '" placeholder="e.g. github"></div>' +
			'<div class="field"><div class="field-label">Transport</div><select id="mcp-transport" class="select"><option value="stdio"' + (f.transport === 'stdio' ? ' selected' : '') + '>stdio (local command)</option><option value="http"' + (f.transport === 'http' ? ' selected' : '') + '>Streamable HTTP (URL)</option></select></div>' +
			'<div id="mcp-stdio"><div class="field"><div class="field-label">Command</div><input id="mcp-command" class="input mono" value="' + esc(f.command) + '" placeholder="npx"></div>' +
			'<div class="field"><div class="field-label">Arguments (JSON array)</div><input id="mcp-args" class="input mono" value="' + esc(JSON.stringify(f.args)) + '" placeholder=\'["-y", "@modelcontextprotocol/server-filesystem", "."]\'></div>' +
			'<div class="field"><div class="field-label">Environment (KEY=value per line)</div><textarea id="mcp-env" class="textarea mono" placeholder="GITHUB_TOKEN=...">' + esc(kv(f.env, '=')) + '</textarea></div></div>' +
			'<div id="mcp-http"><div class="field"><div class="field-label">URL</div><input id="mcp-url" class="input mono" value="' + esc(f.url) + '" placeholder="https://example.com/mcp"></div>' +
			'<div class="field"><div class="field-label">Headers (Name: value per line)</div><textarea id="mcp-headers" class="textarea mono" placeholder="Authorization: Bearer …">' + esc(kv(f.headers, ': ')) + '</textarea></div></div>' +
			'<div class="check-row"><span>Trusted<div class="desc">Run this server\'s tools without asking in Agent mode</div></span><label class="switch"><input type="checkbox" id="mcp-trusted"' + (f.trusted ? ' checked' : '') + '><span class="track"></span></label></div>';
		const transport = d.body.querySelector('#mcp-transport');
		const sync = () => {
			d.body.querySelector('#mcp-stdio').classList.toggle('hidden', transport.value !== 'stdio');
			d.body.querySelector('#mcp-http').classList.toggle('hidden', transport.value !== 'http');
		};
		transport.addEventListener('change', sync);
		sync();
		const parseKv = (text, sep) => {
			const out = {};
			for (const line of text.split('\n')) {
				const i = line.indexOf(sep);
				if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
			}
			return out;
		};
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save & start</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', () => {
			const q = (id) => d.body.querySelector(id).value;
			let args;
			try { args = JSON.parse(q('#mcp-args') || '[]'); if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) throw new Error(); }
			catch { return toast('Arguments must be a JSON array of strings.', 'error'); }
			const server = {
				id: existing && existing.id,
				name: q('#mcp-name').trim(),
				transport: transport.value,
				command: q('#mcp-command').trim(),
				args,
				env: parseKv(q('#mcp-env'), '='),
				url: q('#mcp-url').trim(),
				headers: parseKv(q('#mcp-headers'), ':'),
				trusted: d.body.querySelector('#mcp-trusted').checked,
				enabled: existing ? existing.enabled : true
			};
			if (!server.name) return toast('Give the server a name.', 'error');
			post({ type: 'saveMcp', server });
			d.close();
		});
		d.body.querySelector('#mcp-name').focus();
	}

	function openMcpImport() {
		const d = openDialog({ title: 'Import MCP servers' });
		d.body.innerHTML =
			'<p class="page-desc">Paste a Claude Desktop, Cursor, Windsurf or VS Code config (<code>{"mcpServers": {…}}</code> or <code>{"servers": {…}}</code>).</p>' +
			'<textarea id="mcp-json" class="textarea mono tall" placeholder=\'{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }\'></textarea>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Import</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', () => {
			const json = d.body.querySelector('#mcp-json').value.trim();
			try {
				JSON.parse(json);
			} catch {
				return toast('That is not valid JSON.', 'error');
			}
			post({ type: 'importMcp', json });
			d.close();
		});
		d.body.querySelector('#mcp-json').focus();
	}

	// ------------------------------------------------------------ Skills

	const SKILL_TEMPLATE = '## When to use\nDescribe the situations this skill covers.\n\n## Steps\n1. …\n2. …\n\n## Rules\n- …';

	function skillsPage() {
		const root = h('div', 'page cap-page skills-page');
		root.appendChild(
			capabilityHeader(
				'Skills',
				'book',
				'Turn proven workflows into reusable playbooks. Record a demonstration, write instructions, or discover skills.',
				'<button class="btn btn-ghost" data-act="skill-link">' + I('link') + 'From link</button><button class="btn btn-secondary" data-act="skill-new">' + I('plus') + 'New skill</button>' + (S.isRemote ? '' : '<button class="btn btn-primary" data-act="record-skill">' + I('record') + 'Record a skill</button>')
			)
		);
		root.appendChild(capabilityStats([[S.skills.length, 'In your library', 'book'], [S.skills.filter((s) => s.enabled).length, 'Enabled', 'check'], [S.skills.filter((s) => s.editable).length, 'Created by you', 'pencil']]));
		const recording = recordingBanner(); if (recording) root.appendChild(recording);
		if (!S.settings.skills) root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>Skills are turned off. <button class="link-btn" data-act="enable-skills">Turn them on</button>.</div>'));
		const tab = S.skillTab || 'installed';
		root.appendChild(capabilityTabs([['installed', 'Your skills <span class="count">' + S.skills.length + '</span>'], ['catalog', 'Discover']], tab, 'data-skill-tab', 'Skills'));
		if (tab === 'catalog') {
			root.appendChild(skillCatalogView());
			return root;
		}
		root.appendChild(h('div', 'cap-feature', '<span class="cap-feature-icon">' + I('record') + '</span><div><b>Show it once. Reuse it whenever you need.</b><p>Demonstrate a task, review the captured steps, and save an editable playbook for your agent.</p></div>' + (S.isRemote ? '' : '<button class="btn btn-secondary" data-act="record-skill">Record a workflow ' + I('chevronRight') + '</button>')));
		if (!S.skills.length) {
			root.appendChild(h('div', 'card empty-page', '<span class="logo">' + I('book') + '</span><h3>No skills yet</h3><p>Create one here, or ask the agent: “turn what we just did into a skill”.</p><button class="btn btn-primary" data-act="skill-new">' + I('plus') + 'New skill</button>'));
			return root;
		}
		root.appendChild(capabilitySearch('skill-installed-q', S.skillInstalledQ, 'Search your skills', '<select id="skill-source-filter" class="select" aria-label="Filter skill source">' + [['', 'All sources'], ['editable', 'Created by you'], ['plugin', 'From plugins'], ['claude', 'Imported']].map(([id, label]) => '<option value="' + id + '"' + ((S.skillSourceFilter || '') === id ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>'));
		const skills = S.skills.filter((s) => (!S.skillInstalledQ || (s.name + ' ' + s.description).toLowerCase().includes(S.skillInstalledQ.toLowerCase())) && (!S.skillSourceFilter || (S.skillSourceFilter === 'editable' ? s.editable : S.skillSourceFilter === 'claude' ? ['claude', 'agents', 'codex'].includes(s.source) : s.source === S.skillSourceFilter)));
		root.appendChild(
			h(
				'div',
				'card cap-library',
				skills
					.map(
						(s) =>
							'<div class="skill-row' + (s.enabled ? '' : ' disabled') + '" data-skill="' + esc(s.id) + '"><span class="fc-icon cap-item-icon">' + I('book') + '</span><div class="skill-main"><div class="skill-title"><b>' + esc(s.name) + '</b><span class="badge">' + esc(s.editable ? 'By you' : s.source === 'plugin' ? 'Plugin' : 'Imported') + '</span>' + (s.pinned ? '<span class="badge ok">Pinned</span>' : '') + '</div><div class="skill-desc">' + esc(s.description) + '</div><div class="cap-item-meta"><code>$' + esc(s.name) + '</code><span>' + esc(s.source === 'user' ? 'All workspaces' : s.source === 'workspace' ? 'This workspace' : 'Read-only') + '</span></div></div>' +
							'<div class="mcp-actions">' + (S.currentSessionId ? '<button class="icon-btn' + (s.pinned ? ' on' : '') + '" data-act="skill-pin" data-name="' + esc(s.name) + '" data-pinned="' + (s.pinned ? 'true' : 'false') + '" title="' + (s.pinned ? 'Pinned in this chat — click to unpin' : 'Pin in this chat') + '">' + I('pin') + '</button>' : '') + '<button class="icon-btn" data-act="skill-open" data-path="' + esc(s.path) + '" title="Open SKILL.md">' + I('file') + '</button>' +
							(s.editable ? '<button class="icon-btn" data-act="skill-edit" title="Edit">' + I('pencil') + '</button><button class="icon-btn danger" data-act="skill-delete" title="Delete">' + I('trash') + '</button>' : '') +
							'<label class="switch"><input type="checkbox" aria-label="Enable ' + esc(s.name) + '" data-act="skill-toggle"' + (s.enabled ? ' checked' : '') + '><span class="track"></span></label></div></div>'
					)
					.join('')
			)
		);
		if (!skills.length) root.appendChild(h('div', 'card empty-inline', I('search') + '<span>No skills match these filters.</span>'));
		return root;
	}

	/** Skills catalog: public SKILL.md collections, by category, one-click install. */
	function skillCatalogView() {
		const box = h('div', 'sk-catalog');
		const c = S.skillCatalog;
		if (!c) {
			if (!S.skillCatalogAsked) {
				S.skillCatalogAsked = true;
				post({ type: 'skillCatalog' });
			}
			box.innerHTML = '<div class="card empty-inline"><span class="spinner"></span><span>Reading the skill collections on GitHub…</span></div>';
			return box;
		}
		const q = (S.skillQ || '').toLowerCase();
		const cat = S.skillCat || 'All';
		const have = new Set(S.skills.map((s) => s.name.toLowerCase()));
		const cats = ['All', ...new Set(c.skills.map((s) => s.category))].sort((a, b) => (a === 'All' ? -1 : b === 'All' ? 1 : a.localeCompare(b)));
		const list = c.skills.filter((s) => (cat === 'All' || s.category === cat) && (!q || (s.name + ' ' + s.description + ' ' + s.source).toLowerCase().includes(q)));
		box.innerHTML =
			'<div class="fd-filters"><div class="search-box fd-search">' + I('search') + '<input id="sk-q" placeholder="Search skills" value="' + esc(S.skillQ || '') + '" autocomplete="off"></div>' +
			cats.map((x) => '<button class="fd-chip' + (cat === x ? ' active' : '') + '" data-skill-cat="' + esc(x) + '">' + esc(x) + '</button>').join('') +
			'<button class="icon-btn" data-act="skill-catalog-refresh" title="Check the collections again">' + I('refresh') + '</button></div>' +
			(c.errors && c.errors.length ? '<div class="callout warn-callout">' + I('alert') + '<div>' + c.errors.map(esc).join('<br>') + '</div></div>' : '') +
			'<div class="sk-sources"><span>' + [...new Set(c.skills.map((x) => x.source))].length + ' collections: ' + esc([...new Set(c.skills.map((x) => x.source))].join(' · ')) + '</span><span class="grow"></span>' +
			'<button class="link-btn" data-act="open-url" data-url="https://skillsllm.com">Browse SkillsLLM ↗</button><button class="link-btn" data-act="skill-link">Paste a link</button></div>' +
			'<div class="sk-grid">' +
			(list.length
				? list
						.map((s) => {
							const installed = have.has(s.name.toLowerCase());
							const busy = S.skillBusy === s.id;
							return (
								'<div class="sk-card"><div class="sk-top"><b>' + esc(s.name) + '</b><span class="sk-src">' + esc(s.source) + '</span></div>' +
								'<p>' + esc(s.description) + '</p>' +
								'<div class="sk-foot"><span class="muted">' + esc(s.category) + '</span><span class="grow"></span>' +
								'<button class="link-btn" data-act="open-url" data-url="' + esc(s.url) + '">View</button>' +
								(installed ? '<span class="badge ok">' + I('check') + 'Installed</span>' : busy ? '<span class="spinner"></span>' : '<button class="btn btn-secondary btn-sm" data-skill-install="' + esc(s.id) + '">' + I('plus') + 'Install</button>') +
								'</div></div>'
							);
						})
						.join('')
				: '<div class="empty-inline">Nothing matches.</div>') +
			'</div><div class="fd-foot muted">From anthropics/skills, obra/superpowers and ComposioHQ/awesome-claude-skills. Skills are instructions and scripts the agent may run — read one before you rely on it. Installed skills go to your user skills folder and work in every workspace.</div>';
		return box;
	}

	let skillDialog = null;
	function openSkillDialog(existing) {
		const d = openDialog({ title: existing ? 'Edit skill' : 'New skill', onClose: () => (skillDialog = null) });
		// The reply carries the skill it belongs to (`skillContent.name`). A late reply from a
		// previously closed editor must never fill this dialog — that would save one skill's
		// instructions over another — so the slot remembers the requested name and only that
		// name is accepted.
		const expectedName = existing ? existing.id : null;
		skillDialog = {
			name: expectedName,
			fill: (body) => (d.body.querySelector('#sk-body').value = body.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ''))
		};
		d.body.innerHTML =
			'<div class="grid-2"><div class="field"><div class="field-label">Name</div><input id="sk-name" class="input mono" value="' + esc(existing ? existing.baseName : '') + '" placeholder="code-review"></div>' +
			'<div class="field"><div class="field-label">Save to</div><select id="sk-scope" class="select"><option value="workspace">This workspace (.zer0ne/skills)</option><option value="user"' + (existing && existing.source === 'user' ? ' selected' : '') + '>All workspaces (user)</option></select></div></div>' +
			'<div class="field"><div class="field-label">Description — when should the agent use it?</div><input id="sk-desc" class="input" value="' + esc(existing ? existing.description : '') + '" placeholder="Review code against our team checklist before commits"></div>' +
			'<div class="field"><div class="field-label">Triggers — phrases that suggest it (optional)</div><input id="sk-triggers" class="input" value="' + esc(existing && existing.triggers ? existing.triggers.join(', ') : '') + '" placeholder="review my code, before commit, code review"><div class="field-hint">When the message contains one, the chat offers the skill automatically. Comma-separated.</div></div>' +
			'<div class="field"><div class="field-label">Instructions (markdown)</div><textarea id="sk-body" class="textarea mono tall">' + esc(existing ? 'Loading…' : SKILL_TEMPLATE) + '</textarea></div>';
		if (existing) post({ type: 'readSkill', name: existing.id });
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save skill</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', () => {
			const name = d.body.querySelector('#sk-name').value.trim();
			const description = d.body.querySelector('#sk-desc').value.trim();
			if (!name || !description) return toast('Name and description are required.', 'error');
			const triggers = d.body.querySelector('#sk-triggers').value.split(',').map((trigger) => trigger.trim()).filter(Boolean);
			post({ type: 'saveSkill', name, description, body: d.body.querySelector('#sk-body').value, scope: d.body.querySelector('#sk-scope').value, previous: existing && existing.id, triggers });
			d.close();
		});
		d.body.querySelector('#sk-name').focus();
	}

	// ------------------------------------------------------------ Hooks

	const HOOK_EVENTS = [
		['UserPromptSubmit', 'Before a prompt is sent. stdout is added as context; exit code 2 blocks the prompt.'],
		['PreToolUse', 'Before a tool runs (filter by tool name). Exit code 2 blocks the call and tells the agent why.'],
		['PostToolUse', 'After a tool ran — e.g. run a linter after edits. Exit code 2 sends stderr to the agent as feedback.'],
		['Stop', 'After a successful answer, before completion. Required validation failures mark the turn failed.']
	];
	/** [event, matcher, command (PowerShell on Windows), title, category] — a gallery, like the Claude Code hook collections. */
	const HOOK_EXAMPLES = [
		['PostToolUse', 'edit_file|write_file|multi_edit', "$j = [Console]::In.ReadToEnd() | ConvertFrom-Json; $p = $j.tool_input.path; if ($p -match '\\.(ts|tsx|js|jsx|json|css|md)$') { npx prettier --write $p 2>&1 | Select-Object -Last 3 }", 'Format each edited file with Prettier', 'Quality'],
		['PostToolUse', 'edit_file|write_file', 'npx eslint --fix . 2>&1 | Select-Object -Last 20', 'Lint after every edit', 'Quality'],
		['PreToolUse', 'run_command', "$in = [Console]::In.ReadToEnd(); if ($in -match 'rm -rf|Remove-Item -Recurse|format [a-z]:|del /s') { [Console]::Error.WriteLine('Destructive command blocked by policy'); exit 2 }", 'Block destructive commands', 'Safety'],
		['PreToolUse', 'run_command', "$in = [Console]::In.ReadToEnd(); if ($in -match 'git push (-f|--force)|git reset --hard') { [Console]::Error.WriteLine('Force-push / hard reset blocked — ask the user first'); exit 2 }", 'Block force-push and hard reset', 'Safety'],
		['PreToolUse', 'edit_file|write_file|multi_edit|apply_patch', "$in = [Console]::In.ReadToEnd(); if ($in -match '\\.env|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock') { [Console]::Error.WriteLine('Protected file: edit .env and lockfiles by hand'); exit 2 }", 'Protect .env and lockfiles', 'Safety'],
		['UserPromptSubmit', '', 'git status --short', 'Add git status to every prompt', 'Context'],
		['UserPromptSubmit', '', 'git log --oneline -5', 'Add the last 5 commits to every prompt', 'Context'],
		['Stop', '', 'npm test --silent 2>&1 | Select-Object -Last 15', 'Run the tests when the agent finishes', 'Quality'],
		['Stop', '', "[console]::beep(880,150)", 'Beep when the agent finishes', 'Notify']
	];

	function hooksPage(embed) {
		const root = h('div', 'page');
		const hookDesc = 'Run your own shell commands at agent lifecycle events — supports UserPromptSubmit, PreToolUse, PostToolUse and Stop command hooks. The event is passed as JSON on stdin (and <code>ZER0NE_EVENT</code>, <code>ZER0NE_TOOL</code> env vars).';
		const hookAction = '<button class="btn btn-primary" data-act="hook-add">' + I('plus') + 'Add hook</button>';
		root.appendChild(embed ? h('div', 'section-header-row', '<div><div class="section-label">' + esc(tr('hooks')) + '</div><div class="group-desc">' + hookDesc + '</div></div>' + hookAction) : header(tr('hooks'), hookDesc, hookAction));
		const hooks = S.hooks || [];
		if (!hooks.length) {
			root.appendChild(
				h(
					'div',
					'card empty-page',
					'<span class="logo">' + I('zap') + '</span><h3>No hooks yet</h3><p>Start from a template below, or add your own.</p>'
				)
			);
		} else {
			for (const [event, desc] of HOOK_EVENTS) {
				const list = hooks.filter((x) => x.event === event);
				if (!list.length) continue;
				root.appendChild(h('div', 'section-label', esc(event) + ' <span class="muted">· ' + esc(desc) + '</span>'));
				root.appendChild(
					h(
						'div',
						'card',
						list
							.map(
								(x) =>
									'<div class="mcp-row" data-hook="' + esc(x.id) + '"><div class="mcp-main"><div class="mcp-title">' + (x.matcher ? '<span class="badge mono">' + esc(x.matcher) + '</span>' : '<span class="badge">all</span>') + '<span class="badge">' + x.timeoutSec + 's</span>' + (/^plugin:/.test(x.id) ? '<span class="badge">' + I('puzzle') + esc(x.id.split(':')[1]) + '</span>' : '') + '</div><div class="mcp-sub mono">' + esc(x.command) + '</div></div>' +
									(/^plugin:/.test(x.id) ? '<div class="mcp-actions"><span class="muted small">from plugin</span></div></div>' : '<div class="mcp-actions"><button class="btn btn-ghost" data-act="hook-test">Test</button><button class="icon-btn" data-act="hook-edit" title="Edit">' + I('pencil') + '</button><button class="icon-btn danger" data-act="hook-delete" title="Delete">' + I('trash') + '</button><label class="switch"><input type="checkbox" data-act="hook-toggle"' + (x.enabled ? ' checked' : '') + '><span class="track"></span></label></div></div>')
							)
							.join('')
					)
				);
			}
		}
        root.appendChild(h('div', 'section-label', 'Execution history · current app session'));
        root.appendChild(h('div', 'card', (S.hookHistory || []).map(r => '<details class="setting-row"><summary>' + esc(r.event + ' · ' + r.hookId + ' · exit ' + r.code + ' · ' + r.durationMs + 'ms · ' + new Date(r.at).toLocaleString() + (r.required ? ' · required' : '') + (r.timedOut ? ' · timed out' : '')) + '</summary><pre class="pre-wrap">' + esc('stdout:\n' + r.stdout + '\nstderr:\n' + r.stderr) + '</pre></details>').join('') || '<p class="muted">No hook executions yet.</p>'));
        // Template gallery (grouped), always visible.
		const cats = [...new Set(HOOK_EXAMPLES.map((x) => x[4]))];
		root.appendChild(h('div', 'section-head', '<div><div class="section-label">Templates</div><div class="group-desc">One click adds the hook; edit it after. More ideas: <button class="link-btn" data-act="open-url" data-url="https://github.com/disler/claude-code-hooks-mastery">claude-code-hooks-mastery</button> · <button class="link-btn" data-act="open-url" data-url="https://docs.anthropic.com/en/docs/claude-code/hooks">hooks reference</button> (only the four command events above are supported).</div></div>'));
		root.appendChild(h('div', 'hook-gallery', cats.map((c) => '<div class="hg-col"><div class="hg-cat">' + esc(c) + '</div>' + HOOK_EXAMPLES.map((x, i) => (x[4] === c ? '<button class="pick-item" data-hook-example="' + i + '">' + I('plus') + '<span class="grow">' + esc(x[3]) + '<span class="sub">' + esc(x[0] + (x[1] ? ' · ' + x[1] : '')) + '</span></span></button>' : '')).join('') + '</div>').join('')));
		root.appendChild(h('div', 'callout', I('shield') + '<div>Hooks run with your user permissions in the workspace folder (PowerShell on Windows, your shell elsewhere). Only add commands you trust.</div>'));
		return root;
	}

	function openHookDialog(existing, example) {
		const f = existing ? { ...existing } : example ? { event: example[0], matcher: example[1], command: example[2], timeoutSec: 60, enabled: true } : { event: 'PostToolUse', matcher: '', command: '', timeoutSec: 60, enabled: true };
		const d = openDialog({ title: existing ? 'Edit hook' : 'Add hook' });
		d.body.innerHTML =
			'<div class="field"><div class="field-label">Event</div><select id="hk-event" class="select">' + HOOK_EVENTS.map(([e]) => '<option value="' + e + '"' + (f.event === e ? ' selected' : '') + '>' + e + '</option>').join('') + '</select><div class="field-hint" id="hk-desc"></div></div>' +
			'<div class="field" id="hk-matcher-field"><div class="field-label">Tool matcher (regex, empty = all tools)</div><input id="hk-matcher" class="input mono" value="' + esc(f.matcher) + '" placeholder="edit_file|write_file"></div>' +
			'<div class="field"><div class="field-label">Command</div><textarea id="hk-command" class="textarea mono" placeholder="npm run lint">' + esc(f.command) + '</textarea></div>' +
			'<div class="field"><div class="field-label">Timeout (seconds)</div><input id="hk-timeout" class="input mono" type="number" min="1" max="600" value="' + (f.timeoutSec || 60) + '"></div>';
		d.body.insertAdjacentHTML('beforeend', '<label class="field"><span><input id="hk-required" type="checkbox"' + (f.required ? ' checked' : '') + '> Required completion validation (Stop only)</span><small>A nonzero exit marks the turn failed. Notification hooks still show their output.</small></label>');
        const ev = d.body.querySelector('#hk-event');
		const sync = () => {
			d.body.querySelector('#hk-desc').textContent = (HOOK_EVENTS.find((x) => x[0] === ev.value) || [])[1] || '';
			d.body.querySelector('#hk-matcher-field').classList.toggle('hidden', !/ToolUse$/.test(ev.value));
		};
		ev.addEventListener('change', sync);
		sync();
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save hook</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', () => {
			const command = d.body.querySelector('#hk-command').value.trim();
			if (!command) return toast('Enter a command.', 'error');
			post({ type: 'saveHook', hook: { id: existing && existing.id, event: ev.value, required: ev.value === 'Stop' && d.body.querySelector('#hk-required').checked, matcher: /ToolUse$/.test(ev.value) ? d.body.querySelector('#hk-matcher').value.trim() : '', command, timeoutSec: Number(d.body.querySelector('#hk-timeout').value) || 60, enabled: existing ? existing.enabled : true } });
			d.close();
		});
		d.body.querySelector('#hk-command').focus();
	}

	// ------------------------------------------------------------ Memory

	// ------------------------------------------------------------ Subagents (ZCode-style)

	const SUB_COLORS = { red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', purple: '#a855f7', orange: '#f97316', pink: '#ec4899', cyan: '#06b6d4' };
	const SUB_READ = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
	const SUB_TOOLS = [['Read', 'Read files'], ['Grep', 'Search code'], ['Glob', 'List files'], ['WebFetch', 'Fetch web pages'], ['WebSearch', 'Web search'], ['Edit', 'Edit files'], ['Write', 'Write files'], ['Bash', 'Run commands'], ['TodoWrite', 'Todo list'], ['mcp__*', 'MCP tools']];

	/**
	 * Subagents: the specialists the agent hands work to with the task tool —
	 * built-in Explore and general-purpose, plus agent files (Claude Code /
	 * ZCode format). Create, edit, switch off, pick a model. Rendered inside
	 * the Agent page (`embed`), or standalone for old links.
	 */
	function subagentsPage(embed) {
		const root = h('div', 'page');
		if (!S.subagents && !S.subagentsAsked) {
			S.subagentsAsked = true;
			post({ type: 'subagentsList' });
		}
		const desc = 'Choose which specialists the main agent can use. Each has its own instructions and tools. Keep the default model or choose a specific model for each specialist.';
		const action = '<button class="btn btn-primary" data-sub="new">' + I('plus') + 'New subagent</button>';
		root.appendChild(embed ? h('div', 'section-header-row', '<div><div class="section-label">Subagents</div><div class="group-desc">' + desc + '</div></div>' + action) : header('Subagents', desc, action));
		const d = S.subagents;
		if (!d) {
			root.appendChild(h('div', 'card empty-inline', '<span class="spinner"></span><span>Loading…</span>'));
			return root;
		}
		if (S.settings.subagents === false) root.appendChild(h('div', 'callout warn-callout', I('alert') + '<div>Subagents are off, so the agent cannot use them. Enable them above to allow delegated tasks.</div>'));
		const groups = [['built-in', 'Built-in', 'Always there. Explore, Plan and reviewer are read-only; general-purpose can edit in the foreground (you approve every change). An agent file named Plan or reviewer replaces the built-in one.'], ['project', 'This project', d.dirs.project ? d.dirs.project : 'Open a folder to add project agents.'], ['user', 'Yours — every project', d.dirs.user], ['plugin', 'From plugins', 'Installed with a plugin; switch them off here.'], ['other', 'From other tools', 'Found in .claude/agents or opencode folders.']];
		for (const [scope, title, desc] of groups) {
			const list = d.agents.filter((a) => a.scope === scope);
			if (!list.length && scope !== 'project' && scope !== 'user') continue;
			root.appendChild(h('div', 'feature-group-head', '<div class="section-label">' + esc(title) + '</div><div class="group-desc mono-sm">' + esc(desc) + '</div>'));
			const card = h('div', 'card sub-list');
			card.innerHTML = list.length
				? list.map((a) => subRow(a, d.models)).join('')
				: '<div class="empty-inline">' + I('cpu') + '<span>None yet — <button class="link-btn" data-sub="new" data-scope="' + scope + '">create one</button>.</span></div>';
			root.appendChild(card);
		}
		for (const el of root.querySelectorAll('[data-dot]')) el.style.background = el.dataset.dot;
		root.addEventListener('click', (e) => {
			const n = e.target instanceof Element ? e.target.closest('[data-sub]') : null;
			if (!n) return;
			const a = n.dataset.name ? d.agents.find((x) => x.name === n.dataset.name) : null;
			if (n.dataset.sub === 'new') subEditor(null, n.dataset.scope);
			else if (n.dataset.sub === 'edit' && a) subEditor(a);
			else if (n.dataset.sub === 'copy' && a) subEditor({ ...a, name: a.name + '-copy', editable: true, scope: 'project', builtIn: false, prompt: a.prompt || '' }, 'project', true);
			else if (n.dataset.sub === 'delete' && a) confirmDialog('Delete ' + a.name + '?', 'Its file is removed: ' + a.path, 'Delete', () => post({ type: 'subagentDelete', name: a.name }));
		});
		root.addEventListener('change', (e) => {
			const t = e.target;
			if (t.dataset.subToggle) post({ type: 'subagentToggle', name: t.dataset.subToggle, enabled: t.checked });
			else if (t.dataset.subModel !== undefined) post({ type: 'subagentModel', name: t.dataset.subModel, model: t.value });
		});
		return root;
	}

	function subRow(a, models) {
		const color = SUB_COLORS[a.color] || '#94a3b8';
		const file = a.model && !a.modelOverride ? '<option value="" selected>' + esc(a.model === 'inherit' ? 'Same as chat' : 'From its file: ' + a.model) + '</option>' : '<option value="">Same as chat</option>';
		const opts = file + models.map((m) => '<option value="' + esc(m.id) + '"' + (a.modelOverride === m.id ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('');
		const tools = !a.tools || a.tools.includes('*') ? (a.canWrite ? 'all tools' : 'read-only tools') : a.tools.join(', ');
		return (
			'<div class="sub-row' + (a.enabled ? '' : ' off') + '"><i class="sub-dot" data-dot="' + color + '"></i>' +
			'<div class="sub-main"><div class="sub-name"><b class="mono">' + esc(a.name) + '</b>' + (a.canWrite ? '<span class="badge warn" title="Can edit files and run commands in the foreground; you approve each change">can edit</span>' : '<span class="badge">read-only</span>') + (a.maxTurns ? '<span class="badge">' + a.maxTurns + ' turns</span>' : '') + '</div>' +
			'<div class="sub-desc">' + esc(a.description) + '</div><div class="sub-meta">' + esc(tools) + (a.path ? ' · <span class="mono" title="' + esc(a.path) + '">' + esc(a.path.split(/[\\/]/).slice(-3).join('/')) + '</span>' : '') + '</div></div>' +
			'<div class="sub-ctl"><select class="select sub-model" data-sub-model="' + esc(a.name) + '" title="Model this subagent runs on">' + opts + '</select>' +
			'<div class="sub-acts">' + (a.editable ? '<button class="icon-btn" data-sub="edit" data-name="' + esc(a.name) + '" title="Edit">' + I('pencil') + '</button><button class="icon-btn danger" data-sub="delete" data-name="' + esc(a.name) + '" title="Delete">' + I('trash') + '</button>' : '<button class="icon-btn" data-sub="copy" data-name="' + esc(a.name) + '" title="Copy into a new agent you can edit">' + I('copy') + '</button>') +
			'<label class="switch" title="' + (a.enabled ? 'On — the agent may use it' : 'Off') + '"><input type="checkbox" data-sub-toggle="' + esc(a.name) + '"' + (a.enabled ? ' checked' : '') + '><span class="track"></span></label></div></div></div>'
		);
	}

	/** New / edit: name, when to use, instructions, tools, model, colour, turns, where to save. */
	function subEditor(a, scope, copy) {
		const d = S.subagents;
		const editing = a && !copy;
		const mode = !a || !a.tools ? 'read' : a.tools.includes('*') ? (a.canWrite === false ? 'read' : 'all') : SUB_READ.every((t) => a.tools.includes(t)) && a.tools.length === SUB_READ.length ? 'read' : 'custom';
		const dlg = openDialog({ title: editing ? 'Edit ' + a.name : 'New subagent', onClose: () => (S.subDialog = null) });
		S.subDialog = dlg;
		const custom = mode === 'custom' ? a.tools : SUB_READ;
		dlg.body.innerHTML =
			'<div class="sub-form">' +
			'<label class="field"><span class="field-label">Name</span><input id="sa-name" class="input mono" value="' + esc(a ? a.name : '') + '" placeholder="code-reviewer" spellcheck="false" autocomplete="off"><span class="field-help">The agent calls it by this name: letters, digits, dash, dot.</span></label>' +
			'<label class="field"><span class="field-label">When to use it</span><textarea id="sa-desc" class="input" rows="2" placeholder="Reviews a diff for bugs and risky changes; use after editing several files.">' + esc(a ? a.description : '') + '</textarea><span class="field-help">The main agent decides from this when to hand work to it.</span></label>' +
			'<label class="field"><span class="field-label">Instructions</span><textarea id="sa-prompt" class="input mono" rows="8" placeholder="You are a careful code reviewer. Read the changed files, look for…">' + esc(a ? a.prompt || '' : '') + '</textarea></label>' +
			'<div class="field"><span class="field-label">Tools</span><div class="access-row">' +
			[['read', 'Read-only', 'Search, read files and the web'], ['all', 'Full toolset', 'Edits and commands, each with your approval'], ['custom', 'Choose', 'Pick the tools']].map(([v, l, x]) => '<button class="access-card' + (mode === v ? ' active' : '') + '" data-sa-tools="' + v + '"><b>' + l + '</b><span>' + x + '</span></button>').join('') +
			'</div><div class="sa-custom' + (mode === 'custom' ? '' : ' hidden') + '">' + SUB_TOOLS.map(([id, l]) => '<label class="check"><input type="checkbox" data-sa-tool="' + id + '"' + (custom.includes(id) ? ' checked' : '') + '> ' + esc(l) + ' <span class="mono muted">' + id + '</span></label>').join('') + '</div></div>' +
			'<div class="sub-form-row"><label class="field"><span class="field-label">Model</span><select id="sa-model" class="select"><option value="">Same as chat</option>' + d.models.map((m) => '<option value="' + esc(m.id) + '"' + (a && (a.modelOverride || a.model) === m.id ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('') + '</select></label>' +
			'<label class="field"><span class="field-label">Colour</span><select id="sa-color" class="select">' + Object.keys(SUB_COLORS).map((c) => '<option value="' + c + '"' + ((a && a.color) === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></label>' +
			'<label class="field"><span class="field-label">Max turns</span><input id="sa-turns" class="input" type="number" min="1" max="200" placeholder="no limit" value="' + (a && a.maxTurns ? a.maxTurns : '') + '"></label></div>' +
			'<div class="field"><span class="field-label">Save for</span><div class="access-row">' +
			[['project', 'This project', d.dirs.project || 'open a folder first'], ['user', 'Every project', d.dirs.user]].map(([v, l, x]) => '<button class="access-card' + (((a && a.scope === 'user') || scope === 'user' ? 'user' : 'project') === v ? ' active' : '') + '" data-sa-scope="' + v + '"' + (v === 'project' && !d.dirs.project ? ' disabled' : '') + '><b>' + l + '</b><span class="mono-sm">' + esc(x) + '</span></button>').join('') +
			'</div></div><div class="sa-error err hidden" role="alert"></div></div>';
		dlg.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-close-dlg>Cancel</button><button class="btn btn-primary" data-sa-save>' + (editing ? 'Save' : 'Create') + '</button>';
		let toolsMode = mode;
		let saveScope = (a && a.scope === 'user') || scope === 'user' || !d.dirs.project ? 'user' : 'project';
		dlg.body.addEventListener('click', (e) => {
			const n = e.target instanceof Element ? e.target.closest('[data-sa-tools], [data-sa-scope]') : null;
			if (!n || n.disabled) return;
			const group = n.dataset.saTools !== undefined ? '[data-sa-tools]' : '[data-sa-scope]';
			for (const b of dlg.body.querySelectorAll(group)) b.classList.toggle('active', b === n);
			if (n.dataset.saTools) {
				toolsMode = n.dataset.saTools;
				dlg.body.querySelector('.sa-custom').classList.toggle('hidden', toolsMode !== 'custom');
			} else saveScope = n.dataset.saScope;
		});
		dlg.foot.querySelector('[data-close-dlg]').addEventListener('click', dlg.close);
		dlg.foot.querySelector('[data-sa-save]').addEventListener('click', () => {
			const tools = toolsMode === 'custom' ? [...dlg.body.querySelectorAll('[data-sa-tool]:checked')].map((x) => x.dataset.saTool) : toolsMode;
			const draft = { name: $('sa-name').value.trim(), description: $('sa-desc').value.trim(), prompt: $('sa-prompt').value, tools: Array.isArray(tools) && !tools.length ? 'read' : tools, model: $('sa-model').value || undefined, color: $('sa-color').value, maxTurns: Number($('sa-turns').value) || undefined, scope: saveScope };
			post({ type: 'subagentSave', draft, original: editing ? a.name : undefined });
		});
		$('sa-name').focus();
	}

	// ------------------------------------------------------------ Memory

	const MEM_CATS = { profile: 'Profile', preferences: 'Preferences', topics: 'Topics' };
	let memTimer;

	/** Claude-style date: "Updated Aug 17" (the year joins in when it is not this one). */
	function memWhen(m) {
		const d = new Date(m.updatedAt || m.ts);
		const opts = d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
		return (m.updatedAt ? 'Updated ' : 'Saved ') + d.toLocaleDateString(undefined, opts);
	}

	function memRow(m) {
		const cat = MEM_CATS[m.category] || (m.source === 'user' ? 'Added by you' : 'From chats');
		const origin = m.archived ? 'Archived · excluded from recall' : m.auto ? 'Learned automatically' : m.sourceSessionId ? 'Source chat: ' + m.sourceSessionId : m.source || 'Saved fact';
		return (
			'<div class="mem-row' + (m.pinned ? ' pinned' : '') + '" data-id="' + esc(m.id) + '"><div class="mem-main"><div class="mem-text">' + esc(m.text) + '</div>' +
			'<div class="mem-meta"><span class="mem-chip">' + esc(cat) + '</span>' + (m.area === 'solution' ? '<span class="mem-chip">Solution</span>' : '') + (m.pinned ? '<span class="mem-chip pin-chip">' + I('pin') + 'Pinned</span>' : '') + '<span class="mem-when">' + esc(memWhen(m)) + '</span><span>' + esc(origin) + '</span></div></div>' +
			'<div class="mem-acts">' +
            '<button class="btn btn-ghost" data-act="memory-archive" data-id="' + esc(m.id) + '">' + (m.archived ? 'Restore' : 'Archive') + '</button>' +
			'<button class="icon-btn' + (m.pinned ? ' on' : '') + '" data-act="memory-pin" data-id="' + esc(m.id) + '" title="' + (m.pinned ? 'Unpin — back to keyword and meaning recall' : 'Pin — prioritized within the 12 KB recall budget') + '">' + I('pin') + '</button>' +
			'<button class="icon-btn" data-act="memory-edit" data-id="' + esc(m.id) + '" title="Edit">' + I('pencil') + '</button>' +
			'<button class="icon-btn danger" data-act="delete-memory" data-id="' + esc(m.id) + '" title="Delete">' + I('trash') + '</button>' +
			(!m.archived && !S.isRemote ? '<button class="icon-btn" data-act="memory-promote" data-id="' + esc(m.id) + '" title="Make it a project rule: add it to AGENTS.md, which every agent and teammate reads">' + I('book') + '</button>' : '') +
			(m.sourceSessionId && m.source !== 'user' ? '<button class="icon-btn danger" data-act="memory-forget-chat" data-session="' + esc(m.sourceSessionId) + '" title="Forget everything the chat that saved this taught (for example after it read a misleading page)">' + I('history') + '</button>' : '') +
			'</div></div>'
		);
	}

	/** Near-duplicate groups the user reviews: keep one, archive the rest (never automatic). */
	function memoryDuplicatesPanel() {
		const groups = S.memoryDuplicates || [];
		if (!groups.length) return '';
		const rows = groups.map((group, index) => {
			const items = [group.keep, ...(group.others || [])];
			return '<div class="card mem-list"><div class="mem-section"><span class="name">Group ' + (index + 1) + '</span><span class="desc">' + Math.round((group.similarity || 0) * 100) + '% similar · keep one, archive the others</span></div>' +
				items.map((m) => {
					const others = items.filter((x) => x.id !== m.id).map((x) => x.id).join(',');
					return '<div class="mem-row"><div class="mem-main"><div class="mem-text">' + esc(m.text) + '</div><div class="mem-meta"><span class="mem-when">' + esc(memWhen(m)) + '</span>' + (m.pinned ? '<span class="mem-chip pin-chip">' + I('pin') + 'Pinned</span>' : '') + '</div></div><div class="mem-acts"><button class="btn btn-secondary btn-sm" data-act="memory-merge" data-keep="' + esc(m.id) + '" data-ids="' + esc(others) + '">Merge into this</button><button class="btn btn-ghost btn-sm" data-act="memory-keep" data-ids="' + esc(others) + '">Keep this</button></div></div>';
				}).join('') + '</div>';
		}).join('');
		return h('div', 'mem-duplicates', '<div class="mem-section"><span class="name">Similar memories</span><span class="desc">Archive the copies that are no longer accurate. Archived facts can be restored below.</span></div>' + rows + '<div class="callout"><div>Nothing is archived until you choose <b>Keep this</b>.</div><button class="btn btn-ghost btn-sm" data-act="mem-duplicates-dismiss">Dismiss</button></div>');
	}

	/**
	 * Memory: what the agent keeps about you across chats. Claude-style — three
	 * switches for what may be remembered and searched, a one-line composer to
	 * add a fact yourself, and the saved facts grouped into You (profile +
	 * preferences) and Topics, each with its date and pin / edit / delete.
	 */
	function memoryPage() {
		const root = h('div', 'page memory-page');
		const mem = S.memories || [];
		const actions =
			(mem.filter(m => !m.archived).length > 1 ? '<button class="btn btn-ghost" data-act="mem-duplicates">' + I('search') + 'Find similar</button>' : '') +
			(mem.length ? '<button class="icon-btn" data-act="mem-export" title="Copy every memory to the clipboard">' + I('copy') + '</button>' : '') +
			(mem.length ? '<button class="btn btn-ghost" data-act="clear-memories">' + I('trash') + 'Clear all</button>' : '');
		root.appendChild(header(tr('memory'), 'What the agent remembers in this workspace' + (mem.length ? ' — <b>' + mem.length + '</b> saved' : '') + '. It keeps facts when you say “remember…”, and the relevant ones join new conversations by themselves.', actions));
		root.appendChild(h('div', 'callout', '<div><b>' + mem.filter(m => !m.archived).length + ' / 200 active memories</b> · ' + mem.filter(m => m.archived).length + ' archived. Full memory never deletes facts automatically. Pins have priority within a 12 KB recall budget; other entries use keyword matches and, when an embedding model is configured, similar meaning. Edit or archive conflicting facts to keep recall consistent.</div>'));
		// What the agent may remember and search — the same three switches other assistants offer.
		root.appendChild(
			h(
				'div',
				'card mem-toggles',
				[
					['agentMemory', 'Save memories from chats', 'The agent keeps durable facts — who you are, how you want answers, decisions — with its memory tool. Off means nothing new is saved and old facts stay out of prompts.'],
					['memoryAutoSave', 'Learn from chats automatically', 'After a turn, the local helper model proposes durable facts and solutions. It uses the helper configured in Settings → Local models and never sends the chat to a cloud provider.'],
					['chatSearch', 'Search and reference chats', 'The agent can search your past chats for relevant details — how something was solved before, earlier decisions and errors.'],
					['memorySensitive', 'Include sensitive topics in memory', 'Allow saving details about sensitive topics like health conditions or religious beliefs. Off by default.']
				]
					.map(([key, name, desc]) => '<div class="setting-row"><div class="text"><div class="name">' + name + '</div><div class="desc">' + desc + '</div></div><div class="control">' + sw(key) + '</div></div>')
					.join('')
			)
		);
		const duplicates = memoryDuplicatesPanel();
		if (duplicates) root.appendChild(duplicates);
		// One line, one memory — for the facts you want on record right now.
		const composer = h('div', 'card mem-composer');
		composer.innerHTML = '<input id="mem-add" class="input" placeholder="Add a memory — e.g. “My dog’s name is Beans”" autocomplete="off" spellcheck="false"><button class="btn btn-primary mem-send" data-act="memory-add" title="Save memory">' + I('arrowUp') + '</button>';
		root.appendChild(composer);
		if (!mem.length) {
			root.appendChild(h('div', 'card empty-page', '<span class="logo">' + I('memory') + '</span><h3>Nothing remembered yet</h3><p>Tell the agent “remember that…” in any chat, or add a fact above — it joins new conversations by itself.</p>'));
			return root;
		}
		const filterable = mem.length > 6;
		const q = filterable ? String(S.memFilter || '').trim().toLowerCase() : '';
		const shown = q ? mem.filter((m) => m.text.toLowerCase().includes(q)) : mem;
		if (filterable) {
			root.appendChild(h('div', 'search-box mem-filter', I('search') + '<input id="mem-filter" placeholder="Filter memories…" autocomplete="off" spellcheck="false" value="' + esc(S.memFilter || '') + '">'));
		}
		if (!shown.length) {
			root.appendChild(h('div', 'card empty-page', '<span class="logo">' + I('search') + '</span><h3>No matches</h3><p>Nothing saved matches “' + esc(S.memFilter) + '”.</p>'));
			return root;
		}
		const facts = shown.filter((m) => m.area !== 'solution');
		const you = facts.filter((m) => m.category === 'profile' || m.category === 'preferences');
		const sections = [
			['You', 'Who you are and how the agent should respond.', you],
			['Topics', 'Subjects and facts from your work.', facts.filter((m) => m.category !== 'profile' && m.category !== 'preferences')],
			['Solutions', 'Problems you hit and the fix that worked — recalled when the same problem returns.', shown.filter((m) => m.area === 'solution')]
		];
		for (const [name, desc, rows] of sections) {
			if (!rows.length) continue;
			const sorted = [...rows].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.ts - a.ts);
			root.appendChild(h('div', 'mem-section', '<span class="name">' + name + '</span><span class="desc">' + desc + '</span>'));
			root.appendChild(h('div', 'card mem-list', sorted.map(memRow).join('')));
		}
		return root;
	}

	/** Add / edit a memory: the text, its category, and fact vs solution. */
	function memoryEditor(m) {
		const d = openDialog({ title: m ? 'Edit memory' : 'Add memory' });
		const cats = [['', 'Choose automatically'], ['profile', 'Profile — who the user is'], ['preferences', 'Preferences — how they want answers'], ['topics', 'Topics — subjects of their work']];
		const sel = (m && m.category) || '';
		const area = (m && m.area) || 'fact';
		d.body.innerHTML =
			'<div class="field"><div class="field-label">Memory</div><textarea id="mem-text" class="input" rows="3" placeholder="Stated standalone, e.g. “Prefers pnpm over npm.”">' + esc(m ? m.text : '') + '</textarea><div class="field-hint">The relevant memories join new conversations automatically.</div></div>' +
			'<div class="field"><div class="field-label">Kind</div><select id="mem-area" class="select"><option value="fact"' + (area !== 'solution' ? ' selected' : '') + '>Fact — durable knowledge</option><option value="solution"' + (area === 'solution' ? ' selected' : '') + '>Solution — a problem and the fix that worked</option></select></div>' +
			'<div class="field"><div class="field-label">Category</div><select id="mem-cat" class="select">' + cats.map(([v, l]) => '<option value="' + v + '"' + (sel === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></div>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>' + (m ? 'Save' : 'Add') + '</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', () => {
			const text = d.body.querySelector('#mem-text').value.trim();
			if (!text) return toast('Write the memory first.', 'error');
			const cat = d.body.querySelector('#mem-cat').value;
			post({ type: 'saveMemory', id: m && m.id, text, category: cat || undefined, area: d.body.querySelector('#mem-area').value });
			d.close();
		});
		d.body.querySelector('#mem-text').focus();
	}

	function addMemoryFromComposer() {
		const input = $('mem-add');
		const text = ((input && input.value) || '').trim();
		if (!text) return toast('Write a memory first.', 'error');
		post({ type: 'saveMemory', text });
		if (input) input.value = '';
	}

	// ------------------------------------------------------------ Mobile remote

	/** Mobile remote hub: one place for every way to reach the agent from a phone. */
	const { hooksMemoryPage, hooksMemorySearchEntries } = window.SettingsHooksMemory.create({ S, h, header, capabilityTabs, hooksPage, memoryPage, persist, renderPage });
	const { remotePage } = window.SettingsRemote.create({ S, h, header, esc, I, post, switchRow, desktopHost });

	// ------------------------------------------------------------ Usage

	const { usageItems, requestUsageDetail, activateUsageTab, usagePage, drawChart } = window.SettingsUsage.create({ $, I, S, esc, fmtTokens, h, persist, post, renderPage });

	// ------------------------------------------------------------ dialogs

	function openDialog(opts) {
		const root = $('dialog-root');
		const overlay = h('div', 'overlay');
		const dlg = h('div', 'dialog' + (opts.small ? ' sm' : ''));
		dlg.setAttribute('role', 'dialog');
		dlg.setAttribute('aria-modal', 'true');
		dlg.setAttribute('aria-label', opts.title);
		dlg.innerHTML = '<div class="dialog-head"><span class="dialog-title">' + esc(opts.title) + '</span><button class="icon-btn" data-close title="Close">' + I('close') + '</button></div><div class="dialog-body"></div><div class="dialog-foot"></div>';
		overlay.appendChild(dlg);
		root.replaceChildren(overlay);
		const close = () => {
			root.replaceChildren();
			document.removeEventListener('keydown', onKey, true);
			if (opts.onClose) opts.onClose();
		};
		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener('keydown', onKey, true);
		overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
		dlg.querySelector('[data-close]').addEventListener('click', close);
		// Dialogs are siblings of the settings page, so its delegated link handler cannot reach them.
		dlg.addEventListener('click', event => {
			const action = event.target.closest('[data-act="open-url"], [data-act="copy-verification-url"]');
			if (!action || !dlg.contains(action) || action.disabled) return;
			event.preventDefault(); event.stopPropagation();
			if (action.dataset.act === 'copy-verification-url') { post({ type: 'copyText', text: action.dataset.url }); toast('Verification link copied.', 'ok'); }
			else post({ type: 'openExternal', url: action.dataset.url });
		});
		return { dlg, body: dlg.querySelector('.dialog-body'), foot: dlg.querySelector('.dialog-foot'), close };
	}

	function confirmDialog(title, text, label, onConfirm) {
		const d = openDialog({ title, small: true });
		d.body.innerHTML = '<p class="page-desc">' + esc(text) + '</p>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-danger" data-ok>' + esc(label) + '</button>';
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		const ok = d.foot.querySelector('[data-ok]');
		ok.addEventListener('click', () => (d.close(), onConfirm()));
		ok.focus();
	}

	/**
	 * Adding a provider starts with its key: no provider (and no models) without one.
	 * askUrl: the preset has no fixed endpoint (Custom) — a local URL needs no key.
	 */
	function keyDialog(name, keyUrl, askUrl, onSubmit) {
		const d = openDialog({ title: 'Add ' + name, small: true });
		d.body.innerHTML =
			'<p class="page-desc">Paste your ' + esc(name) + ' API key. It is stored encrypted with a key your operating system protects and checked by listing the models.</p>' +
			(askUrl ? '<div class="field"><div class="field-label">Base URL</div><input id="kd-url" class="input mono" placeholder="https://api.example.com/v1 or http://localhost:8080/v1" spellcheck="false" autocomplete="off"></div>' : '') +
			'<div class="field"><div class="field-label">API key' + (keyUrl ? '<span class="spacer"></span><button class="btn btn-ghost btn-sm" data-kd-get>' + I('link') + 'Get a key</button>' : '') + '</div><input id="kd-key" class="input mono" type="password" placeholder="Paste your API key" autocomplete="off" spellcheck="false"></div>' +
			'<div class="field-hint" id="kd-hint"></div>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-ok disabled>Add provider</button>';
		const key = d.body.querySelector('#kd-key');
		const url = d.body.querySelector('#kd-url');
		const ok = d.foot.querySelector('[data-ok]');
		const local = () => !!url && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url.value.trim());
		const check = () => {
			const hasUrl = !url || /^https?:\/\/\S+/.test(url.value.trim());
			ok.disabled = !hasUrl || (!key.value.trim() && !local());
			d.body.querySelector('#kd-hint').textContent = local() ? 'Local server: the key is optional.' : key.value.trim() ? '' : 'The key is required for cloud providers.';
		};
		key.addEventListener('input', check);
		if (url) url.addEventListener('input', check);
		const get = d.body.querySelector('[data-kd-get]');
		if (get) get.addEventListener('click', () => post({ type: 'openExternal', url: keyUrl }));
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		const submit = () => {
			if (ok.disabled) return;
			d.close();
			toast('Adding ' + name + '…', '');
			onSubmit(key.value.trim(), url ? url.value.trim() : undefined);
		};
		ok.addEventListener('click', submit);
		d.body.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
		check();
		setTimeout(() => (url || key).focus(), 30);
	}

	function promptDialog(title, text, value, onSubmit) {
		const d = openDialog({ title, small: true });
		d.body.innerHTML = '<p class="page-desc">' + esc(text) + '</p><textarea class="textarea" id="prompt-dialog-text" rows="4">' + esc(value || '') + '</textarea>';
		d.foot.innerHTML = '<span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-ok>Send</button>';
		const area = d.body.querySelector('textarea');
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-ok]').addEventListener('click', () => {
			const v = area.value.trim();
			d.close();
			onSubmit(v);
		});
		setTimeout(() => area.focus(), 30);
	}

	let modelDialog = null;
	let modelLookupSequence = 0;
	function openModelDialog(p, existing, onSubmit) {
		const initial = existing ? { ...existing } : { id: '', enabled: true, smart: p.apiFormat !== 'vscode-lm', contextWindow: undefined, maxOutput: undefined, vision: undefined, tools: undefined };
		const clone = (m) => ({ ...m, manualFields: [...(m.manualFields || (m.tools === false ? ['tools'] : []))] });
		let form = clone(initial);
		let requestId = ++modelLookupSequence;
		let lookupTimer;
		const managedFields = ['contextWindow', 'maxOutput', 'vision', 'tools', 'reasoning', 'priceIn', 'priceOut'];
		const smartHelp = 'Matches recommended configuration using the model ID, base URL, and API format. When you manually change a setting, that setting becomes manually managed and stops following recommendation updates; other settings remain managed by smart configuration. Clear a numeric field to use its recommendation again.';
		const d = openDialog({ title: existing ? 'Edit model settings' : 'Add model', onClose: () => { clearTimeout(lookupTimer); modelDialog = null; } });
		d.dlg.classList.add('model-dialog');
		modelDialog = { requestId: () => requestId, onLookup };
		d.body.addEventListener('click', useRecommendation);
		const help = (text) => '<span class="cp-help" tabindex="0" aria-label="' + esc(text) + '">?<span class="cp-tip" role="tooltip">' + esc(text) + '</span></span>';
		const mode = (field) => '<span class="m-field-mode" data-mode-field="' + field + '"></span>';
		const numberField = (id, field, label, tip, price) => '<div class="field"><label class="field-label" for="' + id + '">' + label + ' ' + help(tip) + mode(field) + '</label><input id="' + id + '" data-model-number="' + field + '" class="input mono" type="number" min="' + (price ? '0' : '1') + '" step="' + (price ? 'any' : '1') + '" placeholder="' + (form.smart ? 'Auto' : 'Optional') + '" value="' + (form[field] ?? '') + '"></div>';
		const toggleField = (id, field, label, desc) => '<div class="check-row"><span>' + label + mode(field) + '<div class="desc">' + desc + '</div></span><label class="switch"><input type="checkbox" id="' + id + '" data-model-toggle="' + field + '" aria-label="' + label + '"' + ((field === 'tools' ? form[field] !== false : form[field]) ? ' checked' : '') + '><span class="track"></span></label></div>';
		function paint() {
			d.body.innerHTML =
				'<div class="smart-row">Smart configuration' + help(smartHelp) + '<label class="switch"><input type="checkbox" id="m-smart" aria-label="Smart configuration"' + (form.smart ? ' checked' : '') + '><span class="track"></span></label></div>' +
				'<div class="field"><label class="field-label" for="m-id">Model ID</label><input id="m-id" class="input mono" value="' + esc(form.id) + '" placeholder="Model ID" spellcheck="false" autocomplete="off"></div><div id="m-note" class="smart-note" role="status" aria-live="polite"></div>' +
				numberField('m-ctx', 'contextWindow', 'Context window', 'Maximum tokens available for the conversation and response.') +
				numberField('m-out', 'maxOutput', 'Max output tokens', 'Maximum tokens the model can generate in one response.') +
				'<details class="advanced"' + (form.smart ? '' : ' open') + '><summary>' + I('chevronRight') + 'Advanced settings</summary><div class="adv-body">' +
				toggleField('m-vision', 'vision', 'Vision input', 'Send pasted images and browser screenshots to this model') +
				toggleField('m-tools', 'tools', 'Tool calling', 'Needed for Agent mode; turn off for models that reject tools') +
				toggleField('m-reasoning', 'reasoning', 'Reasoning', 'This model supports thinking or reasoning') +
				'<div class="grid-2">' + numberField('m-price-in', 'priceIn', 'Input price', 'Price per million input tokens in USD; used for cost estimates.', true) + numberField('m-price-out', 'priceOut', 'Output price', 'Price per million output tokens in USD; used for cost estimates.', true) + '</div></div></details>';
			const id = d.body.querySelector('#m-id');
			id.addEventListener('input', () => {
				form.id = id.value;
				if (form.smart) managedFields.forEach((field) => { if (!form.manualFields.includes(field)) delete form[field]; });
				updateFields();
				scheduleLookup();
			});
			id.addEventListener('keydown', (e) => e.key === 'Enter' && save());
			d.body.querySelector('#m-smart').addEventListener('change', (e) => {
				form.smart = e.target.checked;
				paint();
				scheduleLookup(0);
			});
			d.body.querySelectorAll('[data-model-number]').forEach((input) => input.addEventListener('input', () => {
				const field = input.dataset.modelNumber;
				const blank = input.value === '' && !input.validity.badInput;
				form[field] = blank ? undefined : input.validity.badInput ? NaN : Number(input.value);
				form.manualFields = form.manualFields.filter((f) => f !== field);
				if (!blank) form.manualFields.push(field);
				else if (form.smart) scheduleLookup(0);
				updateModes();
			}));
			d.body.querySelectorAll('[data-model-toggle]').forEach((input) => input.addEventListener('change', () => {
				const field = input.dataset.modelToggle;
				form[field] = input.checked;
				if (!form.manualFields.includes(field)) form.manualFields.push(field);
				updateModes();
			}));
			updateModes();
			id.focus();
			id.setSelectionRange(id.value.length, id.value.length);
		}
		function updateModes() {
			d.body.querySelectorAll('[data-mode-field]').forEach((el) => { el.innerHTML = form.smart && form.manualFields.includes(el.dataset.modeField) ? '<button class="link-btn" type="button" data-use-recommendation="' + el.dataset.modeField + '" title="Use the recommended value again" aria-label="Use recommendation for ' + el.dataset.modeField + '">Manual ' + I('retry') + '</button>' : ''; });
		}
		function useRecommendation(e) {
			const button = e.target.closest('[data-use-recommendation]');
			if (button) {
				e.preventDefault();
				const field = button.dataset.useRecommendation;
				form.manualFields = form.manualFields.filter((f) => f !== field);
				delete form[field];
				updateFields();
				scheduleLookup(0);
			}
		}
		function updateFields() {
			d.body.querySelectorAll('[data-model-number]').forEach((input) => { input.value = form[input.dataset.modelNumber] ?? ''; });
			d.body.querySelectorAll('[data-model-toggle]').forEach((input) => { const f = input.dataset.modelToggle; input.checked = f === 'tools' ? form[f] !== false : !!form[f]; });
			updateModes();
		}
		function scheduleLookup(delay) {
			clearTimeout(lookupTimer);
			requestId = ++modelLookupSequence; // Invalidate the previous request before the debounce begins.
			const note = d.body.querySelector('#m-note');
			if (!form.smart || !form.id.trim()) return (note.textContent = '');
			note.className = 'smart-note';
			note.textContent = 'Looking up ' + form.id.trim() + '…';
			const pendingId = requestId;
			lookupTimer = setTimeout(() => post({ type: 'lookupModel', id: p.id, baseUrl: p.baseUrl, apiFormat: p.apiFormat, modelId: form.id.trim(), requestId: pendingId }), delay ?? 300);
		}
		function onLookup(model) {
			if (!form.smart) return;
			const note = d.body.querySelector('#m-note');
			if (model) {
				managedFields.forEach((field) => { if (!form.manualFields.includes(field) && model[field] !== undefined) form[field] = model[field]; });
				updateFields();
				note.className = 'smart-note found';
				note.textContent = 'Matched ' + (model.name || model.id) + ' in the catalog.';
			} else {
				note.className = 'smart-note';
				note.textContent = 'No catalog match. Enter limits and capabilities manually, or leave them blank to use defaults.';
			}
		}
		function save() {
			const id = form.id.trim();
			if (!id) return toast('Enter a model ID.', 'error');
			if (p.models.some((m) => m.id === id && (!existing || existing.id !== id))) return toast('"' + id + '" is already in the list.', 'error');
			if (!d.body.querySelector('#m-id').reportValidity()) return;
			for (const input of d.body.querySelectorAll('[data-model-number]')) {
				if (!input.checkValidity() || (input.value !== '' && (!Number.isFinite(form[input.dataset.modelNumber]) || (!input.dataset.modelNumber.startsWith('price') && !Number.isSafeInteger(form[input.dataset.modelNumber]))))) {
					const advanced = input.closest('details');
					if (advanced) advanced.open = true;
					input.reportValidity();
					return toast('Enter a valid, non-negative price or positive whole token limit.', 'error');
				}
			}
			d.close();
			if (onSubmit) onSubmit({ ...form, id });
			else post({ type: 'saveModel', id: p.id, originalId: existing ? existing.id : undefined, model: { ...form, id } });
		}
		d.foot.innerHTML = '<button class="link-btn" data-reset>Reset form</button><span class="spacer"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>';
		d.foot.querySelector('[data-reset]').addEventListener('click', () => {
			form = clone(initial);
			paint();
			scheduleLookup(0);
		});
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-save]').addEventListener('click', save);
		paint();
		if (form.smart && form.id) scheduleLookup(0);
	}

	function openFetchedDialog(providerId, models) {
		const p = providerById(providerId);
		if (!p) return;
		const agent = p.apiFormat === 'acp';
		const existing = new Set(p.models.filter((m) => !agent || m.enabled).map((m) => m.id));
		const chosen = new Set();
		let query = '';
		const d = openDialog({ title: (agent ? 'Enable models from ' : 'Add models from ') + p.name });
		d.body.innerHTML = '<div class="search-box">' + I('search') + '<input id="fm-q" placeholder="Filter ' + models.length + ' models" autocomplete="off"></div><div class="pick-list" id="fm-list"></div>';
		d.foot.innerHTML = '<button class="link-btn" data-all>Select all shown</button><span class="spacer"></span><span class="note" id="fm-count"></span><button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn btn-primary" data-add>' + (agent ? 'Enable' : 'Add') + '</button>';
		const list = d.body.querySelector('#fm-list');
		const visible = () => models.filter((m) => !query || (m.id + ' ' + (m.name || '')).toLowerCase().includes(query));
		function paint() {
			const shown = visible().slice(0, 500);
			list.innerHTML = shown.length
				? shown
						.map((m) => {
							const added = existing.has(m.id);
							return '<label class="pick-item' + (added ? ' added' : '') + '"><input type="checkbox" data-id="' + esc(m.id) + '"' + (added || chosen.has(m.id) ? ' checked' : '') + (added ? ' disabled' : '') + '><span class="grow">' + (m.name && m.name !== m.id ? esc(m.name) + '<span class="sub">' + esc(m.id) + '</span>' : '<span class="sub">' + esc(m.id) + '</span>') + '</span>' + (m.contextWindow ? '<span class="badge mono">' + fmtTokens(m.contextWindow) + '</span>' : '') + (added ? '<span class="badge">' + (agent ? 'enabled' : 'added') + '</span>' : '') + '</label>';
						})
						.join('')
				: '<div class="pick-empty">No models match.</div>';
			d.foot.querySelector('#fm-count').textContent = chosen.size + ' selected';
			d.foot.querySelector('[data-add]').disabled = !chosen.size;
		}
		list.addEventListener('change', (e) => {
			const id = e.target.dataset.id;
			if (!id) return;
			e.target.checked ? chosen.add(id) : chosen.delete(id);
			paint();
		});
		d.body.querySelector('#fm-q').addEventListener('input', (e) => {
			query = e.target.value.toLowerCase();
			paint();
		});
		d.foot.querySelector('[data-all]').addEventListener('click', () => {
			for (const m of visible()) if (!existing.has(m.id)) chosen.add(m.id);
			paint();
		});
		d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
		d.foot.querySelector('[data-add]').addEventListener('click', () => {
			post({ type: 'addModels', id: p.id, models: models.filter((m) => chosen.has(m.id)) });
			d.close();
		});
		paint();
		d.body.querySelector('#fm-q').focus();
	}

	// ------------------------------------------------------------ events (delegated on the page)

	function saveKey(input) {
		const p = providerById(S.editingId);
		const v = input.value.trim();
		if (!p || !v) return;
		post({ type: 'setApiKey', id: p.id, apiKey: v });
		input.value = '';
	}

	let catalogTimer;
	let modelQTimer = 0;
	let accentTimer;
	let pendingColours = {};
	function flushColourPatch() {
		clearTimeout(accentTimer);
		const patch = pendingColours;
		pendingColours = {};
		if (Object.keys(patch).length) post({ type: 'updateSettings', patch });
	}
	function queueColourPatch(patch) {
		Object.assign(pendingColours, patch);
		clearTimeout(accentTimer);
		accentTimer = setTimeout(flushColourPatch, 120);
	}
	let hfTimer;
	let registryTimer;
	let capabilityTimer;
	function bindPage(page) {
		page.addEventListener('compositionstart', () => { if (S.section === 'features') S.featureComposing = true; });
		page.addEventListener('compositionend', () => { S.featureComposing = false; if (S.featureRenderPending) { S.featureRenderPending = false; renderPage(); } });
		page.addEventListener('input', e => { if (e.target.dataset.featureField) S[e.target.dataset.featureField] = e.target.value; });
		page.addEventListener('change', (e) => {
			const t = e.target;
			if (t.dataset.featureField) { S[t.dataset.featureField] = t.value; return; }
			const p = providerById(S.editingId);
			if (t.dataset.usageSort) {
				S.usageSort[t.dataset.usageSort] = t.value;
				S.usagePages[t.dataset.usageSort] = 1;
				renderPage();
			} else if (t.id === 'skill-source-filter' || t.id === 'mcp-state-filter') {
				S[t.id === 'skill-source-filter' ? 'skillSourceFilter' : 'mcpStateFilter'] = t.value;
				renderPage();
			} else if (t.id === 'f-name' && p) {
				const name = t.value.trim();
				if (!name) {
					t.value = p.name;
					toast('Provider name cannot be empty.', 'error');
				} else if (name !== p.name) post({ type: 'updateProvider', id: p.id, patch: { name } });
			} else if (t.id === 'f-baseurl' && p) {
				const v = t.value.trim();
				if (v && !/^https?:\/\//i.test(v)) return toast('Base URL must start with http:// or https://', 'error');
				if (v && insecureRemote(v) && p.hasKey) {
					t.value = p.baseUrl || '';
					return toast('Plain http:// to a public host would send your API key unencrypted — use https://.', 'error');
				}
				if (v !== p.baseUrl) post({ type: 'updateProvider', id: p.id, patch: { baseUrl: v } });
			} else if (t.id === 'f-format' && p) post({ type: 'updateProvider', id: p.id, patch: { apiFormat: t.value } });
			else if (t.id === 'f-enabled' && p) post({ type: 'updateProvider', id: p.id, patch: { enabled: t.checked } });
			else if (t.id === 'f-key' && p) saveKey(t);
			else if ((t.id === 'f-weekly' || t.id === 'f-fivehour') && p) post({ type: 'updateProvider', id: p.id, patch: { [t.id === 'f-weekly' ? 'weeklyTokenLimit' : 'fiveHourTokenLimit']: Number(t.value) || 0 } });
			else if (t.dataset.act === 'toggle-model' && p) post({ type: 'toggleModel', id: p.id, modelId: t.closest('[data-model]').dataset.model, enabled: t.checked });
			else if (t.dataset.act === 'mcp-toggle') {
				const s = S.mcp.find((x) => x.id === t.closest('[data-mcp]').dataset.mcp);
				if (s) post({ type: 'saveMcp', server: { ...s, enabled: t.checked } });
			} else if (t.dataset.act === 'skill-toggle') post({ type: 'toggleSkill', name: t.closest('[data-skill]').dataset.skill, enabled: t.checked });
			else if (t.id === 'fb-add' && t.value) {
				const list = String(S.settings.fallbackModels || '').split('\n').map((x) => x.trim()).filter(Boolean);
				post({ type: 'updateSettings', patch: { fallbackModels: [...list, t.value].join('\n') } });
			} else if (t.dataset.act === 'mcp-tool-toggle') {
				const srv = S.mcp.find((x) => x.id === t.closest('[data-mcp]').dataset.mcp);
				if (srv) {
					const off = new Set(srv.disabledTools || []);
					t.checked ? off.delete(t.dataset.tool) : off.add(t.dataset.tool);
					post({ type: 'saveMcp', server: { ...srv, status: undefined, disabledTools: [...off] } });
				}
			}
			else if (t.dataset.act === 'plugin-toggle') post({ type: 'togglePlugin', name: t.closest('[data-plugin]').dataset.plugin, enabled: t.checked });
			else if (t.id === 'mkt-cat' || t.id === 'mkt-scope') {
				S.mkt.category = $('mkt-cat').value;
				S.mkt.scope = $('mkt-scope').value;
				renderPage();
			}
			else if (t.id === 'st-backend') post({ type: 'studioInstall', backend: t.value });
			else if (t.id === 'eng-helperslot') post({ type: 'engineOptions', patch: { helperSlot: t.checked } });
			else if (t.id === 'eng-firsttest') post({ type: 'engineOptions', patch: { firstLoadTest: t.checked } });
			else if (t.id === 'eng-context' || t.id === 'eng-gpu' || t.id === 'eng-port' || t.id === 'eng-lightkv' || t.id === 'eng-boost') {
				post({ type: 'engineOptions', patch: { context: Number($('eng-context').value), gpu: $('eng-gpu').value, port: Math.min(65535, Math.max(1024, Number($('eng-port').value) || 8181)), lightKv: $('eng-lightkv').checked, speedBoost: $('eng-boost').checked } });
			}
			// Local models · hybrid routing, Local Host, idle unload
			else if (t.id === 'lv-helper') post({ type: 'updateSettings', patch: { localHelper: t.value } });
			else if (t.id === 'lv-offline') post({ type: 'updateSettings', patch: { offlineFallback: t.checked } });
			else if (t.id === 'lv-tuned') post({ type: 'updateSettings', patch: { localTuned: t.checked } });
			else if (t.id === 'lh-enabled') post({ type: 'localHostSet', patch: { enabled: t.checked } });
			else if (t.id === 'lh-lan') post({ type: 'localHostSet', patch: { lan: t.checked } });
			else if (t.id === 'lh-port') post({ type: 'localHostSet', patch: { port: Math.min(65535, Math.max(1024, Number(t.value) || 11435)) } });
			else if (t.id === 'lv-idle') post({ type: 'localIdle', minutes: Number(t.value) });
			else if (t.dataset.act === 'model-toggle') post({ type: 'modelToggle', id: t.dataset.id, source: t.dataset.source, enabled: t.checked });
			else if (t.dataset.act === 'turbo-toggle') post({ type: 'turboToggle', id: t.dataset.id, on: t.checked });
			else if (t.dataset.act === 'hook-toggle') {
				const hk = (S.hooks || []).find((x) => x.id === t.closest('[data-hook]').dataset.hook);
				if (hk) post({ type: 'saveHook', hook: { ...hk, enabled: t.checked } });
			}
			else if (t.dataset.act === 'serif-answers') post({ type: 'updateSettings', patch: { fontContent: t.checked ? 'serif' : 'system' } });
			else if (t.dataset.setting === 'codeFontSize') {
				// The engine's settings do not carry the code font size, so it is kept in the
				// page's own state instead of being posted and dropped.
				setLocalCodeFontSize(t.value);
			}
			else if (t.dataset.setting) {
				const key = t.dataset.setting;
				const value = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' || t.dataset.num || ['terminalFontSize', 'terminalLineHeight'].includes(key) ? Number(t.value) : t.value;
				post({ type: 'updateSettings', patch: { [key]: value } });
				// The notch's own options follow its master switch at once.
				if (key === 'notch') page.querySelector('.notch-card')?.classList.toggle('is-off', !value);
			}
		});
		page.addEventListener('input', (e) => {
			const t = e.target;
			if (t.dataset.usageQuery) {
				S.usageQuery[t.dataset.usageQuery] = t.value;
				S.usagePages[t.dataset.usageQuery] = 1;
				renderPage();
				return;
			}
			const capabilityQueries = { 'skill-installed-q': 'skillInstalledQ', 'plugin-installed-q': 'pluginInstalledQ', 'mcp-installed-q': 'mcpInstalledQ' };
			if (capabilityQueries[t.id]) {
				clearTimeout(capabilityTimer);
				capabilityTimer = setTimeout(() => { S[capabilityQueries[t.id]] = t.value; renderPage(); }, 150);
			} else if (t.id === 's-uiFontSize' || t.id === 's-codeFontSize') {
				const fallback = t.id === 's-uiFontSize' ? 13 : 12;
				const v = String(Math.min(Number(t.max), Math.max(Number(t.min), Math.round(Number(t.value) || fallback))));
				if (t.value !== v) t.value = v;
				document.body.style.setProperty(t.id === 's-uiFontSize' ? '--ui-font-size' : '--code-font-size', v + 'px');
				// The code font size is kept in the page's own state: the engine's settings do not
				// carry it, so a posted value would be dropped.
				if (t.id === 's-codeFontSize') setLocalCodeFontSize(v);
			} else if (t.id === 's-compactThreshold') $('compact-val').textContent = t.value + '%';
			else if (t.id === 's-skillCatalogChars') $('skill-budget-val').textContent = Math.round(t.value / 1000) + 'k';
			else if (t.id === 's-glowStrength') {
				$('glow-val').textContent = t.value + '%';
				document.body.style.setProperty('--glow-strength', String(t.value / 100));
			}
			else if (t.id === 'accent-color' || t.id === 'accent-hex') {
				const v = t.value.trim();
				if (/^#[0-9a-f]{6}$/i.test(v)) {
					queueColourPatch({ accent: 'custom', accentColor: v.toLowerCase() });
				}
			}
			else if (t.id === 'accent-color2' || t.id === 'accent-hex2') {
				const v = t.value.trim();
				if (!v || /^#[0-9a-f]{6}$/i.test(v)) {
					const main = pendingColours.accentColor || (S.settings.accent === 'custom' ? S.settings.accentColor : (ACCENTS.find(([id]) => id === S.settings.accent) || [0, '#3b82f6'])[1]);
					queueColourPatch({ accent: 'custom', accentColor: main.toLowerCase(), accentColor2: v.toLowerCase() });
				}
			}
			else if (t.id === 'glow-tone1' || t.id === 'glow-tone1-hex' || t.id === 'glow-tone2' || t.id === 'glow-tone2-hex') {
				const one = t.id.startsWith('glow-tone1');
				const v = t.value.trim().toLowerCase();
				if (/^#[0-9a-f]{6}$/.test(v)) {
					const other = one ? $('glow-tone2-hex').value.trim() || '#e3e7ec' : $('glow-tone1-hex').value.trim() || '#0b0b0d';
					queueColourPatch({ glowColor: 'custom', glowTone1: one ? v : pendingColours.glowTone1 || other, glowTone2: one ? pendingColours.glowTone2 || other : v });
				}
			}
			else if (t.id === 'theme-bg' || t.id === 'theme-bg-hex' || t.id === 'theme-fg' || t.id === 'theme-fg-hex') {
				const key = t.id.startsWith('theme-bg') ? 'themeBackground' : 'themeForeground';
				const v = t.value.trim().toLowerCase();
				if (!v || /^#[0-9a-f]{6}$/.test(v)) {
					queueColourPatch({ [key]: v });
				}
			}
			else if (t.id === 's-backgroundOpacity') {
				$('bg-op-val').textContent = t.value + '%';
				const c = document.querySelector('.fx-canvas');
				if (c) c.style.opacity = String(t.value / 100);
			}
			else if (t.id === 'local-tag') S.localTag = t.value.trim();
			else if (t.id === 'sk-q') {
				clearTimeout(hfTimer);
				hfTimer = setTimeout(() => {
					S.skillQ = t.value;
					renderPage();
					const q = $('sk-q');
					if (q) {
						q.focus();
						q.setSelectionRange(q.value.length, q.value.length);
					}
				}, 200);
			}
			else if (t.id === 'mcp-cat-q') {
				S.mcpCatQ = t.value;
				if ($('mcp-cat-list')) $('mcp-cat-list').innerHTML = mcpCards();
			}
			else if (t.id === 'mkt-q') {
				clearTimeout(hfTimer);
				hfTimer = setTimeout(() => {
					S.mkt.query = t.value;
					renderPage();
				}, 200);
			}
			else if (t.id === 'plan-q') {
				S.planQuery = t.value;
				const box = $('plan-grid');
				if (box) {
					box.innerHTML = planGridHtml();
					paintTiles(box);
				}
			}
			else if (/^cp-(name|url|key)$/.test(t.id) && S.customDraft) {
				S.customDraft[{ 'cp-name': 'name', 'cp-url': 'baseUrl', 'cp-key': 'apiKey' }[t.id]] = t.value;
			}
			else if (t.id === 'model-q') {
				(S.modelQuery = S.modelQuery || {})[t.dataset.providerQ] = t.value;
				clearTimeout(modelQTimer);
				modelQTimer = setTimeout(renderPage, 120);
			}
			else if (t.id === 'mem-filter') {
				S.memFilter = t.value;
				clearTimeout(memTimer);
				memTimer = setTimeout(renderPage, 140);
			}
			else if (t.id === 'catalog-q') {
				S.catalogQuery = t.value;
				S.catalogItems = null;
				clearTimeout(catalogTimer);
				catalogTimer = setTimeout(() => (S.catalogQuery ? post({ type: 'searchCatalog', query: S.catalogQuery }) : renderCatalogList()), 200);
			} else if (t.id === 'mcp-registry-q') {
				S.registryQuery = t.value.trim();
				S.registryResults = null;
				const list = $('mcp-registry-list');
				if (list) list.innerHTML = registryListHtml();
				clearTimeout(registryTimer);
				registryTimer = setTimeout(() => S.registryQuery && post({ type: 'mcpRegistrySearch', query: S.registryQuery }), 400);
			}
		});
		page.addEventListener('keydown', (e) => {
			const t = e.target;
			if (t.getAttribute('role') === 'tab' && t.id.startsWith('usage-tab-') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
				e.preventDefault();
				const tabs = ['overview', 'models', 'budgets'];
				const index = tabs.indexOf(S.usageTab);
				activateUsageTab(tabs[e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3]);
			} else if (e.key === 'Enter' && t.id === 'mem-add') {
				e.preventDefault();
				addMemoryFromComposer();
			}
			else if (e.key === 'Enter' && (t.id === 'f-name' || t.id === 'f-baseurl' || t.id === 'f-key' || t.id === 's-browserPath')) {
				e.preventDefault();
				t.blur();
			} else if (e.key === 'Escape' && t.id === 'f-name') {
				const p = providerById(S.editingId);
				if (p) t.value = p.name;
				t.blur();
			}
		});
		page.addEventListener('focusout', (e) => {
			if (e.target && e.target.id === 'f-key') saveKey(e.target);
		});
		page.addEventListener('click', (e) => {
			// A link that acts instead of navigating (the page's CSP allows no inline
			// handlers, so this is what keeps it from following its href).
			const a = e.target.closest && e.target.closest('a[data-act]');
			if (a) e.preventDefault();
			onPageClick(e);
		});
	}

	function renderCatalogList() {
		const list = $('catalog-list');
		if (list) list.innerHTML = catalogListHtml();
	}

	function onPageClick(e) {
		const t = e.target;
		const profile = t.closest('[data-act="profile-backup"], [data-act="profile-restore"]');
		if (profile) {
			if (!window.__zcShell || S.isRemote) return toast('Profile backups are available in the desktop app.', 'error');
			profile.disabled = true;
			void window.__zcShell.invoke(profile.dataset.act === 'profile-backup' ? 'profile_backup' : 'profile_restore', {}).catch(error => toast(error.message, 'error')).finally(() => { profile.disabled = false; });
			return;
		}
		const generalPage = t.closest('[data-general-page]');
		if (generalPage && S.section === 'general' && generalPages().some(([id]) => id === generalPage.dataset.generalPage)) {
			S.generalPage = generalPage.dataset.generalPage;
			persist();
			renderPage(true);
			$('s-page').scrollTop = 0;
			$('general-page-title')?.focus({ preventScroll: true });
			return;
		}
		const featureTab = t.closest('[data-feature-tab]');
		if (featureTab) { S.featureTab = featureTab.dataset.featureTab; return renderPage(); }
		const menu = $('provider-menu');
		if (menu && !t.closest('[data-act="provider-menu"]')) menu.classList.add('hidden');
		let n;
		if ((n = t.closest('[data-provider]'))) {
			S.editingId = n.dataset.provider;
			S.addingProvider = false;
			S.presetInfo = null;
			S.keyVisible = false;
			persist();
			return renderPage(true);
		}
		if ((n = t.closest('[data-acct-signin]'))) {
			signInDialog(n.dataset.acctSignin, 'browser', n.dataset.acctFor, n.dataset.acctNew === 'true');
			return;
		}
		if ((n = t.closest('[data-acp-signin]'))) {
			acpSignInDialog(n.dataset.acpSignin, n.dataset.acpFor);
			return;
		}
		if ((n = t.closest('[data-preset]'))) {
			const preset = presetById(n.dataset.preset);
			if (preset && /^custom/.test(preset.id)) {
				// Custom is a whole form (name, format, URL, key, models), not a key prompt.
				S.addingProvider = true;
				S.presetInfo = null;
				S.customForm = true;
				S.customDraft = { name: '', apiFormat: preset.apiFormat === 'anthropic' ? 'anthropic' : 'openai', baseUrl: '', apiKey: '', models: [] };
				return renderPage(true);
			}
			if (preset && preset.kind === 'info') {
				S.presetInfo = preset.id;
				return renderPage(true);
			}
			if (preset && preset.kind === 'oauth-openrouter') toast('Opening OpenRouter in your browser…', '');
			if (preset && preset.kind === 'oauth-github') toast('Signing in with your GitHub account…', '');
			if (preset && preset.kind === 'apiKey' && !keyOptional(preset)) {
				keyDialog(preset.name, preset.keyUrl, !preset.baseUrl && /^custom/.test(preset.id), (apiKey, baseUrl) => post({ type: 'addPreset', presetId: n.dataset.preset, apiKey, baseUrl }));
				return;
			}
			post({ type: 'addPreset', presetId: n.dataset.preset });
			return;
		}
		if ((n = t.closest('[data-catalog]'))) {
			const id = n.dataset.catalog;
			const c = filterCatalogItems(S.catalogItems, S.catalogQuery).find((x) => x.id === id) || {};
			if (keyOptional(c)) return post({ type: 'addPreset', presetId: 'catalog', catalogId: id });
			keyDialog(c.name || id, c.doc || c.keyUrl, !c.baseUrl, (apiKey, baseUrl) => post({ type: 'addPreset', presetId: 'catalog', catalogId: id, apiKey, baseUrl }));
			return;
		}
		if ((n = t.closest('[data-copy-text]'))) {
			const text = n.dataset.copyText;
			const done = () => toast('Copied.', '');
			if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => post({ type: 'copyText', text }));
			else post({ type: 'copyText', text });
			return;
		}
		if ((n = t.closest('[data-theme-tab]'))) {
			S.themeTab = n.dataset.themeTab;
			renderPage(true);
			return;
		}
		if ((n = t.closest('[data-readable-fg]'))) {
			flushColourPatch();
			return post({ type: 'updateSettings', patch: { themeForeground: n.dataset.readableFg } });
		}
		if ((n = t.closest('[data-theme-pick]'))) {
			flushColourPatch();
			return post({ type: 'updateSettings', patch: { theme: n.dataset.themePick } });
		}
		if ((n = t.closest('[data-mkt-remove]'))) {
			e.stopPropagation();
			return post({ type: 'mktRemoveSource', id: n.dataset.mktRemove });
		}
		if ((n = t.closest('[data-mkt-source]'))) {
			S.mkt.source = n.dataset.mktSource;
			S.mkt.category = '';
			return renderPage();
		}
		if ((n = t.closest('[data-plugin-tab]'))) {
			S.pluginTab = n.dataset.pluginTab;
			return renderPage(true);
		}
		
		if ((n = t.closest('[data-ps-tab]'))) {
			S.psTab = n.dataset.psTab;
			return renderPage(true);
		}
		
		if ((n = t.closest('[data-mcp-tab]'))) {
			S.mcpTab = n.dataset.mcpTab;
			return renderPage();
		}
		if ((n = t.closest('[data-local-tab]'))) {
			S.localTab = n.dataset.localTab;
			return renderPage(true);
		}
		if (t.closest('[data-act="acp-refresh"]')) { post({ type: 'acpAgents', refresh: true }); return; }
		if ((n = t.closest('[data-mm-cat]'))) {
			S.mmCat = n.dataset.mmCat;
			return renderPage();
		}

		if ((n = t.closest('[data-skill-tab]'))) {
			S.skillTab = n.dataset.skillTab;
			return renderPage();
		}
		if ((n = t.closest('[data-skill-cat]'))) {
			S.skillCat = n.dataset.skillCat;
			return renderPage();
		}
		if ((n = t.closest('[data-skill-install]'))) {
			S.skillBusy = n.dataset.skillInstall;
			post({ type: 'skillInstall', id: n.dataset.skillInstall });
			return renderPage();
		}

		if ((n = t.closest('[data-agent-tab]'))) {
			S.agentTab = n.dataset.agentTab;
			return renderPage();
		}
		if ((n = t.closest('[data-add-tab]'))) {
			S.addTab = n.dataset.addTab;
			return renderPage();
		}
		if ((n = t.closest('[data-cp-format]'))) {
			S.customDraft.apiFormat = n.dataset.cpFormat;
			return renderPage();
		}
		
		if ((n = t.closest('[data-remote-tab]'))) {
			S.remoteTab = n.dataset.remoteTab;
			return renderPage(true);
		}
		if ((n = t.closest('[data-accent-pick]'))) {
			flushColourPatch();
			return post({ type: 'updateSettings', patch: { accent: n.dataset.accentPick } });
		}
		if ((n = t.closest('[data-glow-pair]'))) {
			flushColourPatch();
			const [t1, t2, metallic] = n.dataset.glowPair.split(',');
			return post({ type: 'updateSettings', patch: metallic ? { glowColor: 'metallic' } : { glowColor: 'custom', glowTone1: t1, glowTone2: t2 } });
		}
		if ((n = t.closest('[data-palette]'))) {
			flushColourPatch();
			const [c1, c2] = n.dataset.palette.split(',');
			return post({ type: 'updateSettings', patch: { accent: 'custom', accentColor: c1, accentColor2: c2 } });
		}
		if ((n = t.closest('[data-seg]'))) {
			glideSegment(n);
			return post({ type: 'updateSettings', patch: { [n.dataset.seg]: n.dataset.value } });
		}
		if ((n = t.closest('[data-nav-to]'))) return navigate(n.dataset.navTo);
		if ((n = t.closest('[data-mcp-example]'))) return openMcpDialog(null, MCP_EXAMPLES.find((x) => x[0] === n.dataset.mcpExample));
		if ((n = t.closest('[data-mcp-info]'))) return openMcpInfo(n.dataset.mcpInfo);
		if ((n = t.closest('[data-mcp-cat]'))) {
			S.mcpCat = n.dataset.mcpCat;
			return renderPage();
		}
		if ((n = t.closest('[data-registry]'))) {
			const r = (S.registryResults || [])[Number(n.dataset.registry)];
			if (r) {
				openMcpDialog.preset = r.config;
				openMcpDialog(null);
				if (r.needs.length) toast('Fill in: ' + r.needs.join(', '), '');
			}
			return;
		}
		if ((n = t.closest('[data-hook-example]'))) return openHookDialog(null, HOOK_EXAMPLES[Number(n.dataset.hookExample)]);
		// A configured MCP row opens its editor; its own buttons, switch and tool list keep their clicks.
		if ((n = t.closest('[data-mcp-row]')) && !t.closest('button, input, label, details, a, select')) {
			const server = S.mcp.find((x) => x.id === n.dataset.mcp);
			if (server) return openMcpDialog(server);
		}
		const act = t.closest('[data-act]');
		if (!act) return;
		const p = providerById(S.editingId);
		const row = act.closest('[data-model]');
		const modelId = row && row.dataset.model;
		const mcp = act.closest('[data-mcp]') && S.mcp.find((x) => x.id === act.closest('[data-mcp]').dataset.mcp);
		const skill = act.closest('[data-skill]') && S.skills.find((x) => x.id === act.closest('[data-skill]').dataset.skill);
		switch (act.dataset.act) {

			case 'skill-catalog-refresh':
				S.skillCatalog = null;
				S.skillCatalogAsked = true;
				post({ type: 'skillCatalog', refresh: true });
				renderPage();
				break;
			
			case 'clear-background':
				e.stopPropagation();
				confirmDialog('Remove your picture?', 'The chat goes back to a plain background. The image file on your disk is not touched.', 'Remove', () => post({ type: 'clearBackground' }));
				break;
			case 'remote-install-helper':
				post({ type: 'remoteInstallHelper' });
				S.remote = { ...(S.remote || {}), helper: { installing: true }, tunnel: { state: 'starting', text: 'Finding cloudflared…', pct: 0 } };
				renderPage();
				break;
			case 'remote-retry':
				post({ type: 'updateSettings', patch: { remoteAccess: 'lan' } });
				setTimeout(() => post({ type: 'updateSettings', patch: { remoteAccess: 'anywhere' } }), 400);
				break;
			case 'remote-retry-ssh':
				post({ type: 'updateSettings', patch: { remoteAccess: 'lan' } });
				setTimeout(() => post({ type: 'updateSettings', patch: { remoteAccess: 'ssh' } }), 400);
				break;
			case 'remote-code':
				post({ type: 'remotePairCode' });
				break;
			case 'remote-revoke': {
				const device = (S.remote?.devices || []).find(d => d.id === act.dataset.id);
				if (!device) break;
				confirmDialog('Sign out this phone?', '“' + device.name + '” stops working until it pairs again with a new code. Other phones keep their access.', 'Sign out', () => post({ type: 'remoteRevoke', id: device.id }));
				break;
			}
			case 'use-picture':
				post({ type: 'updateSettings', patch: { background: 'image' } });
				break;
			case 'pick-background':
				e.stopPropagation();
				act.classList.add('picking');
				setTimeout(() => act.classList.remove('picking'), 900);
				post({ type: 'pickBackground' });
				break;
			case 'theme-import':
				S.themeImport = !S.themeImport;
				renderPage();
				if (S.themeImport && $('theme-import-text')) $('theme-import-text').focus();
				break;
			case 'theme-import-apply':
				importTheme(($('theme-import-text') || {}).value || '');
				break;
			case 'theme-copy': {
				const out = { name: 'zer0ne theme', app: 'zer0ne-coding' };
				for (const k of THEME_KEYS) out[k] = k === 'codeFontSize' ? localCodeFontSize() || 12 : S.settings[k];
				const text = JSON.stringify(out, null, 2);
				if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Theme copied as JSON.', ''), () => post({ type: 'copyText', text }));
				else post({ type: 'copyText', text });
				break;
			}
			case 'terminal-reset':
				post({ type: 'updateSettings', patch: { terminalFontSize: 0, terminalLineHeight: 1.3, terminalCursorStyle: 'block', terminalCursorBlink: true, terminalEffects: 'off', terminalProse: 'mono' } });
				break;
			case 'theme-reset':
				clearTimeout(accentTimer);
				pendingColours = {};
				setLocalCodeFontSize(12);
				post({ type: 'updateSettings', patch: { accent: 'blue', accentColor2: '', themeBackground: '', themeForeground: '', fontUi: 'system', fontContent: 'system', fontCode: 'editor', fontWeight: 400, uiFontSize: 13 } });
				break;
			case 'features-check':
				S.featureHealthError = ''; requestFeaturesHealth(true);
				renderPage();
				break;
			case 'features-cancel':
				clearTimeout(S.featureHealthTimer); S.healthBusy = false; S.featureHealthId = null;
				S.featureHealthError = 'Check cancelled.'; post({type:'featuresCancel'}); renderPage(); break;
			case 'feature-plan':
				S.featureRequestId = 'plan-' + Date.now() + '-' + (S.featureSequence = (S.featureSequence || 0) + 1);
				post({type:'featurePlan',kind:act.dataset.kind,requestId:S.featureRequestId}); break;
			case 'feature-stop':
				post({type:'featureCancel',id:S.featureRunning}); break;
			case 'bench-run': confirmBenchmark(); break;
			case 'bench-stop': post({type:'benchmarkStop'}); break;
			case 'bench-clear': post({type:'benchmarkClear'}); break;
			case 'feature-language-connect':
			case 'feature-language-query':
				S.featureRequestId = 'language-' + Date.now() + '-' + (S.featureSequence = (S.featureSequence || 0) + 1);
				post({type:'featureLanguage',requestId:S.featureRequestId,operation:act.dataset.act === 'feature-language-connect' ? 'connect' : S.featureLanguageOperation || 'diagnostics',path:S.featureLanguagePath || '',line:Number(S.featureLanguageLine || 1),character:Number(S.featureLanguageCharacter || 1),query:S.featureLanguageQuery || ''}); break;
			case 'feature-image':
				post({type:'featureImage',file:act.dataset.file}); break;
			case 'feature-file':
				post({type:'previewFile',path:act.dataset.file}); break;
			case 'skill-link': {
				const d = openDialog({ title: 'Install skills from a link', small: true });
				d.body.innerHTML = '<p class="page-desc">A GitHub repo or folder (<code>owner/repo</code>, <code>https://github.com/…/tree/main/skills/x</code>) or a <b>skillsllm.com/skill/…</b> page. You pick which of its skills to install.</p><input id="sk-link" class="input mono" placeholder="https://skillsllm.com/skill/… or owner/repo" spellcheck="false" autocomplete="off"><div class="field-hint" id="sk-link-hint"></div><div id="sk-link-list" class="pick-list sk-link-list"></div>';
				d.foot.innerHTML = '<button class="link-btn" data-act="open-url" data-url="https://skillsllm.com">Browse SkillsLLM ↗</button><span class="spacer"></span><button class="btn btn-ghost" data-cancel>Close</button><button class="btn btn-primary" data-ok>Find skills</button>';
				const input = d.body.querySelector('#sk-link');
				const find = () => {
					if (!input.value.trim()) return;
					d.body.querySelector('#sk-link-hint').innerHTML = '<span class="spinner"></span> Reading the repo…';
					d.body.querySelector('#sk-link-list').innerHTML = '';
					post({ type: 'skillFromLink', url: input.value.trim() });
				};
				d.foot.querySelector('[data-ok]').addEventListener('click', find);
				d.foot.querySelector('[data-cancel]').addEventListener('click', d.close);
				input.addEventListener('keydown', (ev) => ev.key === 'Enter' && find());
				d.body.addEventListener('click', (ev) => {
					const b = ev.target instanceof Element ? ev.target.closest('[data-sk-direct]') : null;
					if (!b || !S.skillRepo) return;
					const sk = S.skillRepo.skills[Number(b.dataset.skDirect)];
					if (!sk) return;
					b.disabled = true;
					b.innerHTML = '<span class="spinner"></span>';
					post({ type: 'skillInstallDirect', skill: sk });
				});
				S.skillLinkDlg = d;
				setTimeout(() => input.focus(), 30);
				break;
			}
			
			case 'add-provider':
				S.addingProvider = true;
				S.presetInfo = null;
				S.customForm = false;
				renderPage(true);
				break;
			case 'add-cancel':
				S.addingProvider = false;
				S.customForm = false;
				renderPage(true);
				break;
			case 'custom-open':
				S.customForm = true;
				renderPage(true);
				setTimeout(() => $('cp-url') && $('cp-url').focus(), 0);
				break;
			case 'custom-back':
				S.customForm = false;
				renderPage(true);
				break;
			case 'custom-model-add':
			case 'custom-model-edit': {
				const c = S.customDraft;
				if (!c) break;
				if (act.dataset.act === 'custom-model-add' && c.models.length >= 100) {
					toast('A provider can have up to 100 models.', 'error');
					break;
				}
				const index = act.dataset.act === 'custom-model-edit' ? Number(act.dataset.index) : -1;
				const existing = c.models[index];
				openModelDialog(c, existing, (model) => {
					if (existing) c.models[index] = model;
					else c.models.push(model);
					renderPage();
				});
				break;
			}
			case 'custom-model-remove':
				if (S.customDraft) S.customDraft.models.splice(Number(act.dataset.index), 1);
				renderPage();
				break;
			case 'custom-add': {
				const c = S.customDraft || {};
				const url = String(c.baseUrl || '').trim();
				if (!url) {
					toast('Enter the base URL.', 'error');
					if ($('cp-url')) $('cp-url').focus();
					break;
				}
				if (!/^https?:\/\//i.test(url)) {
					toast('The base URL starts with https:// (or http:// for a local server).', 'error');
					break;
				}
				post({ type: 'addCustom', name: c.name, apiFormat: c.apiFormat, baseUrl: url, apiKey: c.apiKey, models: c.models });
				break;
			}
			case 'preset-back':
				S.presetInfo = null;
				renderPage(true);
				break;
			case 'refresh-catalog':
				post({ type: 'refreshCatalog' });
				break;
			case 'provider-menu':
				e.stopPropagation();
				menu.classList.toggle('hidden');
				break;
			case 'clear-key':
				post({ type: 'setApiKey', id: p.id, apiKey: '' });
				break;
			case 'account-signout':
				confirmDialog('Sign out of ' + p.name + '?', 'The saved sign-in is removed from the OS keychain. Its models stay listed; sign in again to use them.', 'Sign out', () => post({ type: 'accountSignOut', id: p.id }));
				break;
			case 'check-provider':
				(S.checks = S.checks || {})[p.id] = { running: true };
				post({ type: 'checkProvider', id: p.id });
				renderPage();
				break;
			case 'duplicate-provider':
				post({ type: 'duplicateProvider', id: p.id });
				break;
			case 'refresh-model-info':
				post({ type: 'refreshModelInfo', id: p.id });
				break;
			case 'models-on':
			case 'models-off': {
				const q = ((S.modelQuery || {})[p.id] || '').toLowerCase();
				post({ type: 'setModelsEnabled', id: p.id, ids: p.models.filter((m) => !q || m.id.toLowerCase().includes(q)).map((m) => m.id), enabled: act.dataset.act === 'models-on' });
				break;
			}
			case 'test-all': {
				const q = ((S.modelQuery || {})[p.id] || '').toLowerCase();
				const list = p.models.filter((m) => m.enabled && (!q || m.id.toLowerCase().includes(q))).slice(0, 12);
				if (!list.length) return toast('Turn on at least one model to test.', 'error');
				// One at a time: providers rate-limit bursts.
				let i = 0;
				const next = () => {
					const m = list[i++];
					if (!m) return;
					S.tests[p.id + '::' + m.id] = { state: 'running', onDone: next };
					post({ type: 'testModel', id: p.id, modelId: m.id });
				};
				next();
				renderPage();
				break;
			}
			case 'delete-provider':
				confirmDialog('Delete ' + p.name + '?', 'Its models and stored API key are removed. This cannot be undone.', 'Delete', () => post({ type: 'deleteProvider', id: p.id }));
				break;
			case 'toggle-key': {
				S.keyVisible = !S.keyVisible;
				const keyIn = $('f-key') || $('cp-key');
				if (keyIn) keyIn.type = S.keyVisible ? 'text' : 'password';
				act.innerHTML = I(S.keyVisible ? 'eyeOff' : 'eye');
				break;
			}
			case 'oauth-openrouter':
				toast('Opening OpenRouter in your browser…', '');
				post({ type: 'signInOpenRouter', id: p.id });
				break;

			case 'cloud-refresh':
				S.cloud = null;
				S.cloudAsked = false;
				renderPage();
				break;
			case 'cloud-signin':
				post({ type: 'cloudSignIn' });
				break;
			case 'cloud-folder':
				post({ type: 'workspaceAction', action: 'open' });
				break;
			case 'cloud-setup':
				post({ type: 'cloudSetup' });
				break;
			case 'cloud-push':
				confirmDialog('Commit the setup to GitHub?', 'Commits .github/workflows/zer0ne-cloud.yml and .zer0ne/cloud/* to ' + ((S.cloud && S.cloud.defaultBranch) || 'the default branch') + ' of ' + ((S.cloud && S.cloud.repo) || 'the repository') + ' through the GitHub API. Your local branch is not touched.', 'Commit', () => post({ type: 'cloudPushSetup' }));
				break;
			case 'cloud-token-open':
				S.cloudTokenOpen = !S.cloudTokenOpen;
				renderPage();
				if (S.cloudTokenOpen && $('cloud-token')) $('cloud-token').focus();
				break;
			case 'cloud-token-save': {
				const token = ($('cloud-token') || {}).value || '';
				if (!token.trim()) return toast('Paste a token first.', 'error');
				S.cloudTokenOpen = false;
				post({ type: 'cloudToken', token });
				break;
			}
			case 'cloud-signout':
				post({ type: 'cloudSignOut' });
				break;
			case 'cloud-auto':
				S.cloudSteps = {};
				confirmDialog('Set up cloud tasks?', 'Signs in to GitHub (' + (desktopHost() ? 'the gh CLI or a token' : 'VS Code account') + '), commits the workflow and runner to ' + ((S.cloud && S.cloud.defaultBranch) || 'the default branch') + ' of ' + ((S.cloud && S.cloud.repo) || 'the repository') + ', and saves the chat provider\'s API key as the encrypted secret ZER0NE_API_KEY (with the gh CLI, or on GitHub\'s secrets page).', 'Set up', () => {
					toast('Setting up cloud tasks…', '');
					post({ type: 'cloudAutoSetup' });
				});
				break;
			case 'cloud-secret':
				post({ type: 'cloudSecret' });
				break;
			case 'cloud-start': {
				const task = ($('cloud-task').value || '').trim();
				if (!task) return toast('Describe the task first.', 'error');
				post({ type: 'cloudStart', task, openPr: $('cloud-pr').checked });
				S.cloudDraft = '';
				$('cloud-task').value = '';
				break;
			}
			case 'cloud-toggle': {
				const id = act.closest('[data-cloud]').dataset.cloud;
				S.cloudOpen = S.cloudOpen === id ? null : id;
				renderPage();
				break;
			}
			case 'cloud-cancel':
				post({ type: 'cloudCancel', id: act.closest('[data-cloud]').dataset.cloud });
				break;
			case 'cloud-remove':
				post({ type: 'cloudRemove', id: act.closest('[data-cloud]').dataset.cloud });
				break;
			case 'cloud-teleport':
				post({ type: 'cloudTeleport', id: act.closest('[data-cloud]').dataset.cloud });
				break;
			case 'cloud-follow': {
				const id = act.closest('[data-cloud]').dataset.cloud;
				promptDialog('Follow up on this cloud task', 'What should the agent do next? It continues on the same branch.', '', (text) => text && post({ type: 'cloudFollowUp', id, text }));
				break;
			}
			case 'open-url':
				post({ type: 'openExternal', url: act.dataset.url });
				break;
			case 'copy-verification-url':
				post({ type: 'copyText', text: act.dataset.url });
				toast('Verification link copied.', 'ok');
				break;
			case 'credits-replay':
				S.creditsAt = Date.now();
				renderPage();
				break;
			case 'fetch-models':
				S.fetching = p.id;
				renderPage();
				post({ type: 'fetchModels', id: p.id });
				break;
			case 'add-model':
				openModelDialog(p);
				break;
			case 'edit-model':
				openModelDialog(p, p.models.find((m) => m.id === modelId));
				break;
			case 'delete-model':
				if (act.classList.contains('confirm')) post({ type: 'deleteModel', id: p.id, modelId });
				else {
					act.classList.add('confirm');
					act.title = 'Click again to remove';
					setTimeout(() => act.classList.remove('confirm'), 2500);
				}
				break;
			case 'test-model':
				S.tests[p.id + '::' + modelId] = { state: 'running' };
				renderPage();
				post({ type: 'testModel', id: p.id, modelId });
				break;
			case 'health-check': {
				const m = p.models.find((x) => x.enabled) || p.models[0];
				if (!m) return toast('Add a model first.', 'error');
				S.tests[p.id + '::' + m.id] = { state: 'running' };
				toast('Checking ' + p.name + ' with ' + (m.name || m.id) + '…', '');
				renderPage();
				post({ type: 'testModel', id: p.id, modelId: m.id });
				break;
			}
			case 'focus-key': {
				const k = $('f-key');
				if (k) {
					k.scrollIntoView({ block: 'center' });
					k.focus();
				}
				break;
			}
			case 'browser-test':
				post({ type: 'browserTest' }); break;
			case 'browser-close':
				post({ type: 'browserClose' });
				break;
			case 'enable-mcp':
				post({ type: 'updateSettings', patch: { mcp: true } });
				break;
			case 'enable-skills':
				post({ type: 'updateSettings', patch: { skills: true } });
				break;
			case 'fb-remove': {
				const list = String(S.settings.fallbackModels || '').split('\n').map((x) => x.trim()).filter(Boolean);
				list.splice(Number(act.dataset.i), 1);
				post({ type: 'updateSettings', patch: { fallbackModels: list.join('\n') } });
				break;
			}
			case 'rebuild-index':
				post({ type: 'rebuildIndex' });
				break;
			case 'plugin-install-folder':
				post({ type: 'installPlugin', from: 'folder' });
				break;
			case 'plugin-install-git':
				openPluginGitDialog();
				break;

			case 'sandbox-prepare': {
				const dialog = openDialog({ title: 'Prepare this project for the sandbox?' });
				dialog.body.innerHTML = '<p>zer0ne creates a sandbox ID for this project and gives it permission to change files in the project folder (and in its own temp folder). Sandboxed commands run with that ID only, so they can write here and nowhere else — not in other projects or your user folder. They can still read files that are not excluded and reach the network.</p><p class="page-desc">This adds permission entries to the folder, applied to the files inside it; large folders can take a moment. You can remove it at any time with Remove sandbox access.</p>';
				dialog.foot.innerHTML = '<button class="btn btn-ghost" data-cancel>Cancel</button><span class="spacer"></span><button class="btn btn-primary" data-ok>Prepare project</button>';
				dialog.foot.querySelector('[data-cancel]').addEventListener('click', dialog.close);
				dialog.foot.querySelector('[data-ok]').addEventListener('click', () => { dialog.close(); toast('Preparing the sandbox…', ''); post({ type: 'sandboxPrepare' }); });
				break;
			}
			case 'sandbox-unprepare':
				post({ type: 'sandboxUnprepare' });
				break;
			case 'sandbox-deny-recommended': {
				const field = document.querySelector('[data-setting="sandboxDenyRead"]');
				if (!field) break;
				const current = String(field.value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
				const next = [...new Set([...current, ...DENY_RECOMMENDED])].join('\n');
				field.value = next;
				S.settings.sandboxDenyRead = next;
				post({ type: 'updateSettings', patch: { sandboxDenyRead: next } });
				break;
			}
			case 'rules-trust': {
				const pending = (S.commandRules && S.commandRules.pendingAllow) || [];
				const dialog = openDialog({ title: 'Trust this project\'s command rules?' });
				dialog.body.innerHTML = '<p>These commands will run without an approval card in Agent mode:</p><pre class="mono">' + esc(pending.join('\n')) + '</pre><p class="page-desc">The rules come from the project folder, so anyone who can change the repository wrote them. If the allow lines change later, the changed ones wait for you again.</p>';
				dialog.foot.innerHTML = '<button class="btn btn-ghost" data-cancel>Cancel</button><span class="spacer"></span><button class="btn btn-primary" data-ok>Trust rules</button>';
				dialog.foot.querySelector('[data-cancel]').addEventListener('click', dialog.close);
				dialog.foot.querySelector('[data-ok]').addEventListener('click', () => { dialog.close(); post({ type: 'commandRulesTrust' }); });
				break;
			}
			case 'rules-untrust':
				post({ type: 'commandRulesUntrust' });
				break;
			case 'mkt-add': {
				const v = ($('mkt-new') || {}).value || '';
				if (v.trim()) post({ type: 'mktAddSource', id: v.trim() });
				break;
			}
			case 'mkt-refresh':
				if (S.mkt && S.mkt.source) {
					S.mkt.lists[S.mkt.source] = { loading: true };
					post({ type: 'mktFetch', id: S.mkt.source, force: true });
					renderPage();
				}
				break;
			case 'mkt-install': {
				const name = act.dataset.name;
				S.mktBusy = Object.assign({}, S.mktBusy, { [name]: true });
				post({ type: 'mktInstall', marketplace: S.mkt.source || (S.mkt.sources[0] || {}).id, name, scope: ($('mkt-scope') || {}).value });
				renderPage();
				break;
			}
			case 'mcp-starter':
				for (const name of MCP_STARTER) {
					if ((S.mcp || []).some((s) => s.name === name)) continue;
					const [n, c, a] = MCP_EXAMPLES.find((x) => x[0] === name);
					const remote = /^https?:/.test(c);
					post({ type: 'saveMcp', server: remote ? { name: n, transport: 'http', url: c, command: '', args: [], env: {}, headers: {}, enabled: true, trusted: false } : { name: n, transport: 'stdio', command: c, args: a.split(' ').filter(Boolean), env: {}, url: '', headers: {}, enabled: true, trusted: false } });
				}
				toast('Adding the starter pack — the servers start in a moment.', 'ok');
				break;
			case 'local-chat':
				post({ type: 'localChat', id: act.dataset.id });
				toast('Opening the chat with ' + act.dataset.id + '…', 'ok');
				break;
			case 'job-cancel':
				post({ type: 'jobCancel', key: act.dataset.key });
				break;
			case 'mfs-back':
				S.localView = 'models';
				renderPage(true);
				break;
			case 'st-install':
				post({ type: 'studioInstall' });
				break;
			case 'st-stop':
				post({ type: 'studioStop' });
				break;
			case 'st-web':
				post({ type: 'studioOpenWeb' });
				break;
			case 'st-folder':
				post({ type: 'studioOpenFolder' });
				break;
			case 'engine-install':
				post({ type: 'engineInstall', backend: (S.localModels && S.localModels.engine.settings.backend) || 'auto' });
				break;
			case 'engine-backend':
				post({ type: 'engineOptions', patch: { backend: act.dataset.value } });
				break;
			case 'engine-load':
				S.engineLoading = act.dataset.id;
				post({ type: 'engineLoad', id: act.dataset.id });
				renderPage();
				break;
			case 'lms-load':
			case 'lms-unload':
				S.lmsBusy = act.dataset.key;
				post({ type: act.dataset.act === 'lms-load' ? 'lmsLoad' : 'lmsUnload', key: act.dataset.key });
				renderPage();
				break;
			case 'notch-preview':
				post({ type: 'zcNotchPreview' });
				toast('Watch the top of your screen', 'ok');
				break;
			case 'notch-phase': {
				const on = !act.classList.contains('active');
				act.classList.toggle('active', on);
				act.setAttribute('aria-pressed', String(on));
				post({ type: 'updateSettings', patch: { [act.dataset.key]: on } });
				break;
			}
			case 'report-problem':
				post({ type: 'reportProblem' });
				toast('Opening the report in the editor…', 'ok');
				break;
			case 'engine-channel':
				post({ type: 'engineOptions', patch: { channel: act.dataset.value } });
				break;
			case 'engine-rollback':
				post({ type: 'engineRollback' });
				break;
			case 'engine-stop':
				post({ type: 'engineStop' });
				break;
			case 'engine-tune':
				post({ type: 'engineTune' });
				break;
			case 'engine-test':
				post({ type: 'engineTest' });
				break;
			case 'engine-test-cancel':
				post({ type: 'engineTestCancel' });
				break;
			case 'engine-tune-cancel':
				post({ type: 'engineTuneCancel' });
				break;
			case 'local-bench':
				(S.localPlus = S.localPlus || {}).benchRunning = (S.localPlus.benchRunning || []).concat(act.dataset.id);
				post({ type: 'localBench', id: act.dataset.id, server: act.dataset.server });
				renderPage();
				break;
			case 'lv-task': {
				const cur = new Set(String((S.settings || {}).localHelperTasks || '').split(',').filter(Boolean));
				if (cur.has(act.dataset.task)) cur.delete(act.dataset.task);
				else cur.add(act.dataset.task);
				post({ type: 'updateSettings', patch: { localHelperTasks: [...cur].join(',') } });
				break;
			}
			case 'private-setup':
			case 'private-off':
			case 'private-cancel':
				post({ type: 'privateSearch', action: act.dataset.act.slice(8) });
				if (act.dataset.act === 'private-setup') toast('Setting up private code search…', '');
				break;
			case 'lh-check':
				post({ type: 'localHostCheck' });
				break;
			case 'lh-newkey':
				confirmDialog('Make a new Local Host key?', 'Tools that use the current key stop working until you paste the new one.', 'New key', () => post({ type: 'localHostSet', patch: { newKey: true } }));
				break;
			case 'lh-copy': {
				const text = act.dataset.copy || '';
				if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied.', 'ok'), () => post({ type: 'copyText', text }));
				else post({ type: 'copyText', text });
				break;
			}
			case 'local-refresh':
				S.lms = null;
				S.localModels = null;
				S.localLoading = true;
				post({ type: 'localModels', refresh: true });
				renderPage();
				break;
			case 'local-start':
				act.disabled = true;
				post({ type: 'localStart' });
				break;
			case 'local-get':
				post({ type: 'openExternal', url: act.dataset.url });
				break;
			case 'local-use':
				post({ type: 'localUse', tag: act.dataset.tag, server: act.dataset.server });
				break;
			case 'local-inspect': {
				const tag = ($('local-tag') || {}).value || '';
				S.localTag = tag.trim();
				if (S.localTag) post({ type: 'localInspect', tag: S.localTag });
				break;
			}
			case 'local-pull-tag': {
				const tag = (($('local-tag') || {}).value || '').trim();
				if (!tag) break;
				S.localTag = tag;
				const start = () => {
					post({ type: 'localPull', tag });
					renderPage();
				};
				const fit = S.localInspect && S.localInspect.tag === tag && S.localInspect.info && S.localInspect.info.fit;
				if (fit === 'too-large') confirmDialog('Download ' + tag + ' anyway?', "It needs more memory than this machine has, so it probably won't load.", 'Download', start);
				else start();
				break;
			}
			case 'plugin-folder':
				post({ type: 'openPluginsFolder' });
				break;
			case 'plugin-remove': {
				const pn = act.closest('[data-plugin]').dataset.plugin;
				const plugin = S.plugins.find(p => p.id === pn);
				confirmDialog('Remove ' + (plugin ? plugin.name + ' (' + plugin.scope + ')' : pn) + '?', 'Its folder is deleted; its commands, skills, agents, hooks and MCP servers go away.', 'Remove', () => post({ type: 'removePlugin', name: pn }));
				break;
			}

			case 'newMod':
				post({ type: 'newMod' });
				break;
			
			case 'mcp-add':
				openMcpDialog(null);
				break;
			case 'mcp-import':
				openMcpImport();
				break;
			case 'mcp-edit':
				openMcpDialog(mcp);
				break;
			case 'mcp-restart':
				post({ type: 'restartMcp', id: mcp.id });
				break;
			case 'mcp-signin':
				post({ type: 'mcpSignIn', id: mcp.id });
				break;
			case 'mcp-signout':
				post({ type: 'mcpSignOut', id: mcp.id });
				break;
			case 'mcp-delete':
				confirmDialog('Remove ' + mcp.name + '?', 'The server is stopped and its configuration deleted.', 'Remove', () => post({ type: 'deleteMcp', id: mcp.id }));
				break;
			case 'hook-add':
				openHookDialog(null);
				break;
			case 'hook-test': {
                const id = act.closest('[data-hook]')?.dataset.hook;
                const d = openDialog({ title: 'Test saved hook' });
                d.body.innerHTML = '<p>This executes the saved command in your project using this sample JSON.</p><textarea class="textarea mono" aria-label="Sample hook input">{ "tool_name": "read_file", "tool_input": {}, "last_message": "Sample completion" }</textarea>';
                d.foot.innerHTML = '<button class="btn btn-primary">Run test</button>';
                d.foot.querySelector('button').onclick = () => { const sample = d.body.querySelector('textarea').value; try { JSON.parse(sample); } catch { toast('Enter valid JSON.', 'error'); return; } post({ type: 'testHook', id, sample }); d.close(); };
                break;
            }
            case 'hook-edit':
				openHookDialog((S.hooks || []).find((x) => x.id === act.closest('[data-hook]').dataset.hook));
				break;
			case 'hook-delete': {
				const hid = act.closest('[data-hook]').dataset.hook;
				confirmDialog('Delete this hook?', 'The command will no longer run.', 'Delete', () => post({ type: 'deleteHook', id: hid }));
				break;
			}
			case 'skill-new':
				openSkillDialog(null);
				break;
			case 'record-skill':
				openWorkflowRecorder('skill');
				break;
			case 'record-plugin':
				openWorkflowRecorder('plugin');
				break;
			case 'record-open':
				openWorkflowRecorder(S.recording && S.recording.target);
				break;
			case 'skill-edit':
				openSkillDialog(skill);
				break;
			case 'skill-open':
				post({ type: 'openPath', path: act.dataset.path });
				break;
			case 'skill-delete':
				confirmDialog('Delete skill ' + skill.name + '?', 'The skill folder is deleted from disk.', 'Delete', () => post({ type: 'deleteSkill', name: skill.name }));
				break;
			case 'skill-pin':
				post({ type: 'pinSkill', name: act.dataset.name, pinned: act.dataset.pinned !== 'true' });
				break;
			case 'mem-duplicates':
				post({ type: 'memoryDuplicates' });
				break;
			case 'mem-duplicates-dismiss':
				S.memoryDuplicates = [];
				renderPage();
				break;
			case 'memory-keep': {
				const ids = String(act.dataset.ids || '').split(',').filter(Boolean);
				if (!ids.length) break;
				post({ type: 'archiveMemories', ids });
				S.memoryDuplicates = [];
				toast('Kept one; the similar copies are archived and can be restored below.', 'ok');
				renderPage();
				break;
			}
			case 'memory-merge': {
				const ids = String(act.dataset.ids || '').split(',').filter(Boolean);
				if (!ids.length || !act.dataset.keep) break;
				post({ type: 'mergeMemories', keepId: act.dataset.keep, ids });
				S.memoryDuplicates = [];
				toast('Merged; the copies are archived and can be restored below.', 'ok');
				renderPage();
				break;
			}
			case 'clear-memories':
				confirmDialog('Clear all memories?', 'Every saved fact for this workspace will be deleted.', 'Clear all', () => post({ type: 'clearMemories' }));
				break;
			case 'delete-memory':
				post({ type: 'deleteMemory', id: act.dataset.id });
				break;
			case 'memory-promote': {
				const m = (S.memories || []).find((x) => x.id === act.dataset.id);
				if (m) confirmDialog('Add this to AGENTS.md?', '“' + m.text + '” becomes a line under “Learned from corrections” in the project\'s AGENTS.md, so every agent (and anyone sharing the repository) follows it. The memory is archived.', 'Add to AGENTS.md', () => post({ type: 'promoteMemory', id: m.id }));
				break;
			}
			case 'memory-forget-chat': {
				const session = act.dataset.session;
				const from = (S.memories || []).filter((x) => x.sourceSessionId === session && x.source !== 'user');
				confirmDialog('Forget what this chat taught?', 'Deletes the ' + from.length + ' ' + (from.length === 1 ? 'memory' : 'memories') + ' saved by that chat, including ones learned automatically. Memories you added yourself stay.', 'Forget ' + from.length, () => post({ type: 'forgetChatMemories', sessionId: session }));
				break;
			}
			case 'memory-add':
				addMemoryFromComposer();
				break;
			case 'memory-edit':
				memoryEditor((S.memories || []).find((m) => m.id === act.dataset.id));
				break;
			case 'memory-archive': {
                const m = (S.memories || []).find(m => m.id === act.dataset.id);
                if (m) post({ type: 'updateMemory', id: m.id, patch: { archived: !m.archived } });
                break;
            }
            case 'memory-pin': {
				const m = (S.memories || []).find((x) => x.id === act.dataset.id);
				if (m) post({ type: 'updateMemory', id: m.id, patch: { pinned: !m.pinned } });
				break;
			}
			case 'mem-export': {
				const lines = (S.memories || []).map((m) => '- ' + m.text);
				if (!lines.length) break;
				const text = 'Memories (' + lines.length + '):\n' + lines.join('\n');
				if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Copied ' + lines.length + ' memories.', 'ok'), () => post({ type: 'copyText', text }));
				else post({ type: 'copyText', text });
				break;
			}
			case 'copy-url':
				navigator.clipboard.writeText(act.dataset.url).then(() => toast('Pairing link copied.', 'ok'), () => toast('Copy failed.', 'error'));
				break;
			case 'remote-regenerate':
				confirmDialog('Create a new pairing link?', 'Phones paired with the current link will be signed out.', 'New link', () => post({ type: 'remoteRegenerate' }));
				break;
			case 'usage-range':
				if (S.usageDays === Number(act.dataset.days)) break;
				S.usageDays = Number(act.dataset.days);
				S.usagePages = { models: 1, budgets: 1, related: 1 };
				S.usageDetail = null;
				persist();
				renderPage();
				post({ type: 'getUsage', days: S.usageDays });
				break;
			case 'usage-tab':
				activateUsageTab(act.dataset.tab);
				break;
			case 'usage-clear': {
				const kind = act.dataset.list;
				if (kind !== 'models' && kind !== 'budgets') break;
				S.usageQuery[kind] = '';
				S.usagePages[kind] = 1;
				renderPage();
				$('usage-' + kind + '-query')?.focus();
				break;
			}
			case 'usage-model-open': {
				const m = S.usage?.models[Number(act.dataset.index)];
				if (!m) break;
				requestUsageDetail(m, act.id);
				renderPage();
				$('s-page').scrollTop = 0;
				$('usage-detail-back')?.focus({ preventScroll: true });
				break;
			}
			case 'usage-detail-back': {
				const focusId = S.usageDetail?.focusId;
				S.usageDetail = null;
				renderPage();
				$(focusId)?.focus({ preventScroll: true });
				break;
			}
			case 'usage-detail-retry':
				if (S.usageDetail) requestUsageDetail(S.usageDetail.row, S.usageDetail.focusId);
				renderPage();
				break;
			case 'usage-open-chat':
				post({ type: 'switchSession', id: act.dataset.id });
				close();
				break;
			case 'usage-export':
			case 'usage-export-requests':
				if (S.usageExporting) break;
				S.usageExporting = true;
				post({ type: 'exportUsage', days: S.usageDays, attempts: act.dataset.act === 'usage-export-requests' });
				renderPage();
				break;
			case 'usage-page': {
				const kind = act.dataset.list;
				if (!['models', 'budgets', 'related'].includes(kind)) break;
				const items = usageItems(kind);
				const page = Number(act.dataset.page);
				if (!items || !Number.isInteger(page) || page < 1 || page > Math.max(1, Math.ceil(items.length / USAGE_PAGE_SIZE))) break;
				S.usagePages[kind] = page;
				const focusId = act.id;
				renderPage();
				const focus = $(focusId);
				(focus && !focus.disabled ? focus : $('usage-' + kind + '-page-' + page))?.focus({ preventScroll: true });
				break;
			}
		}
	}

	// ------------------------------------------------------------ host messages

	window.addEventListener('message', (event) => {
		if (event.source && event.source !== window) return;
		const msg = event.data || {};
		switch (msg.type) {
			case 'state': {
				S.capabilities = msg.capabilities || {};
				S.section = normalizeSection(S.section);
				const featureSig = JSON.stringify([msg.settings,msg.selection,msg.workspace,msg.hasWorkspace,msg.currentSessionId,msg.mode,msg.mcp,msg.skills]);
				if (featureSig !== S.featureSig) {
					S.featureSig = featureSig; S.featureRevision++; S.featureHealthError = '';
					if (S.health) S.health.stale = true;
					if (S.healthBusy) post({type:'featuresCancel'});
					clearTimeout(S.featureHealthTimer); S.healthBusy = false; S.featureHealthId = null;
					if (JSON.stringify(msg.workspace) !== JSON.stringify(S.workspace)) { S.featureLoaded = false; S.featureRoot = ''; S.featureReports = []; S.featureLanguageResult = ''; }
				}
				const sig = JSON.stringify([msg.providers, msg.selection, msg.settings, msg.memories, msg.pinnedSkills, msg.currentSessionId, msg.mcp, msg.skills, msg.remote, msg.browser, msg.hooks, msg.hookHistory, msg.modelChecks, msg.plugins, msg.commands, msg.agents, msg.codeIndex,msg.featureCatalog,msg.workspace]);
				if (standalone && window.applyAppearance) window.applyAppearance(msg.settings);
				Object.assign(S, {
					version: msg.version || S.version || '',
					providers: msg.providers || [],
					selection: msg.selection || {},
					settings: msg.settings || {},
					featureCatalog: msg.featureCatalog || [],
					featureConfiguration: msg.featureConfiguration,
					workspace: msg.workspace,
					mode: msg.mode,
					memories: msg.memories || [],
					pinnedSkills: msg.pinnedSkills || [],
					currentSessionId: msg.currentSessionId,
					mcp: msg.mcp || [],
					skills: msg.skills || [],
					remote: msg.remote || {},
					presets: msg.presets || [],
					browser: msg.browser || {},
					hooks: msg.hooks || [],
					hookHistory: msg.hookHistory || [],
					modelChecks: msg.modelChecks || {},
					plugins: msg.plugins || [],

					commands: msg.commands || [],
					agents: msg.agents || [],
					codeIndex: msg.codeIndex || {},
					isRemote: !!msg.isRemote || B.remote
				});
				S.featureReports.forEach(r => { if (S.featureConfiguration && r.configuration && r.configuration !== S.featureConfiguration) r.stale = true; });
				if (sig !== S.sig) {
					S.sig = sig;
					if (S.fetching && !providerById(S.fetching)) S.fetching = null;
					if (S.open) {
						renderNav();
						renderPage();
					}
				}
				break;
			}
			case 'navigate':
				// Settings already open in its own tab: jump to the requested page.
				if (typeof msg.section === 'string' && msg.section) {
					S.section = normalizeSection(msg.section);
					if (S.open) {
						renderNav();
						renderPage();
					}
				}
				break;
			
			case 'mcpRegistryResults':
				if (msg.query === S.registryQuery) {
					S.registryResults = msg.results || [];
					const list = $('mcp-registry-list');
					if (list) list.innerHTML = registryListHtml();
				}
				break;
			case 'accountSignIn':
				if (signDlg && signDlg.account === msg.account && signDlg.requestId === msg.requestId) {
					if (msg.stage === 'cancelled') break;
					Object.assign(signDlg, msg, msg.stage === 'device' ? { expiresAt: Date.now() + (msg.expiresIn || 900) * 1000 } : {});
					renderSignIn();
				}
				break;
			case 'acpAgents':
				S.acpError = msg.error || '';
				S.acpCards = msg.cards || [];
				S.acpConnected = msg.connected || [];
				S.acpInstalled = msg.installed || {};
				if (S.open && S.section === 'models') renderPage(true);
				break;
			case 'acpSignIn':
				if (acpDlg && acpDlg.agentId === msg.agent) {
					if (msg.stage === 'cancelled') break;
					if (msg.stage === 'browser-launch-error') {
						if (/done|error|cancelled/.test(acpDlg.stage)) break;
						Object.assign(acpDlg, { browserError: msg.browserError, url: msg.url || acpDlg.url });
					} else Object.assign(acpDlg, msg);
					renderAcpSignIn();
					if (msg.stage === 'done') post({ type: 'acpAgents' });
				}
				break;
			case 'focusProvider':
				S.section = 'models';
				S.editingId = msg.id;
				S.addingProvider = false;
				S.presetInfo = null;
				S.customForm = false;
				S.customDraft = null;
				persist();
				if (S.open) {
					renderNav();
					renderPage(true);
					setTimeout(() => {
						const p = providerById(msg.id);
						const target = p && p.apiFormat !== 'vscode-lm' && p.auth !== 'account' ? (!p.baseUrl ? $('f-baseurl') : !p.hasKey && !isLocal(p) ? $('f-key') : null) : null;
						if (target) target.focus();
					}, 30);
				}
				break;
			case 'status':
				if (standalone) toast(msg.message, msg.kind);
				if (msg.kind === 'error' && S.fetching) {
					S.fetching = null;
					renderPage();
				}
				// A failed marketplace install: stop the spinner.
				if (msg.kind === 'error' && S.mktBusy && Object.keys(S.mktBusy).length) {
					S.mktBusy = {};
					if (S.open && S.section === 'plugins') renderPage();
				}
				break;
			case 'catalogResults': {
				const items = msg.items || [];
				S.catalogItems = items;
				// The reply does not say which query it answers: a "refresh the catalog" reply is
				// the whole catalog and would silently replace a filtered view. The current search
				// text is re-applied when the list is rendered, and a reply that is clearly not
				// filtered (some entries do not match the query) asks the engine again for the
				// matching subset.
				const q = (S.catalogQuery || '').trim();
				if (q && items.length && filterCatalogItems(items, q).length < items.length) post({ type: 'searchCatalog', query: q });
				renderCatalogList();
				break;
			}
			case 'lookupResult':
				if (modelDialog && msg.requestId === modelDialog.requestId()) modelDialog.onLookup(msg.model);
				break;
			case 'skillContent':
				// Only the reply for the skill this editor asked for may fill it.
				if (skillDialog && skillDialog.name && msg.name === skillDialog.name) skillDialog.fill(msg.body || '');
				break;
			case 'fetchedModels':
				S.fetching = null;
				if (S.open) renderPage();
				if (msg.empty || !(msg.models || []).length) toast('The endpoint returned no models. Add model IDs with Add model.', '');
				else openFetchedDialog(msg.providerId, msg.models || []);
				break;
			case 'providerCheck':
				(S.checks = S.checks || {})[msg.id] = msg;
				if (S.open && S.section === 'models') renderPage();
				break;
			case 'testResult': {
				const prev = S.tests[msg.providerId + '::' + msg.modelId];
				S.tests[msg.providerId + '::' + msg.modelId] = msg.ok ? { state: 'ok', ms: msg.ms } : { state: 'fail', error: msg.error };
				if (prev && prev.onDone) setTimeout(prev.onDone, 150);
				if (!msg.ok && !(prev && prev.onDone)) toast(msg.modelId + ': ' + msg.error, 'error');
				if (S.open) renderPage();
				break;
			}

			case 'jobSaveError':
				if (jobDialog && jobDialog.requestId === msg.requestId) jobDialog.button.disabled = false;
				toast(msg.error || 'Could not save the task.', 'error');
				break;
			case 'sandboxStatus':
				S.sandbox = { status: msg.status, platform: msg.platform };
				if (S.open && S.section === 'agent') renderPage();
				break;
			case 'commandRulesStatus':
				S.commandRules = msg.status;
				if (S.open && S.section === 'agent') renderPage();
				break;
			case 'mktSources':
				S.mkt = S.mkt || { query: '', category: '', lists: {} };
				S.mkt.sources = msg.sources;
				S.mkt.origins = msg.origins;
				S.mkt.installed = msg.installed;
				S.mktBusy = {};
				if (msg.select) S.mkt.source = msg.select;
				if (S.open && S.section === 'plugins') renderPage();
				break;
			case 'mktPlugins':
				S.mkt = S.mkt || { query: '', category: '', lists: {} };
				S.mkt.lists[msg.id] = { plugins: msg.plugins || [], error: msg.error, name: msg.name };
				if (S.open && S.section === 'plugins') renderPage();
				break;
			case 'modelfitReply':
				modelFitReply({ id: msg.id, ok: msg.ok, data: msg.data, error: msg.error });
				break;
			case 'modelfitPush':
				modelFitRelay({ type: msg.push, data: msg.data });
				break;
			case 'localPlus':
				S.localPlus = msg.data;
				if (S.open && S.section === 'local') renderLocal();
				break;
			case 'studioState':
				S.studio = msg.studio;
				renderLocal();
				break;
			case 'localBenchStage':
				(S.benchStage = S.benchStage || {})[msg.id] = msg.text || '';
				for (const el of document.querySelectorAll('[data-bench-stage]')) if (el.dataset.benchStage === msg.id) el.textContent = msg.text || '';
				break;
			case 'localHostCheck':
				toast(msg.error || 'Router and API key verified · ' + (msg.models || []).length + ' available model routes.', msg.error ? 'error' : 'ok');
				break;
			case 'localLive':
				// Updated in place (every 1.5 s): no page re-render while the user reads.
				S.liveSamples = (S.liveSamples || []).concat(msg.sample).slice(-48);
				paintLive();
				break;
			case 'localJob': {
				S.localJobs = S.localJobs || {};
				const had = !!S.localJobs[msg.job.key];
				if (msg.job.done) delete S.localJobs[msg.job.key];
				else S.localJobs[msg.job.key] = msg.job;
				if (!(S.open && S.section === 'local')) break;
				// Update the bar in place when it exists; re-render when a bar appears or goes.
				const rows = msg.job.done ? [] : [...document.querySelectorAll('.pull-row[data-job="' + CSS.escape(msg.job.key) + '"]')];
				if (rows.length && had) {
					for (const r of rows) r.outerHTML = jobBar(msg.job);
					paintBars();
				} else renderPage();
				break;
			}
			case 'engineState':
				if (S.localModels) S.localModels.engine = msg.engine;
				for (const g of S.localModels?.gguf || []) g.loaded = !!(msg.engine.running && msg.engine.run && g.id === msg.engine.model);
				if (msg.engine.run) S.engineLoading = null;
				renderLocal();
				break;
			case 'modelMeasurement': {
				const m = msg.measurement;
				const local = S.localModels?.gguf?.find(x => x.id === m.model);
				if (local) local.measurement = m;
				renderLocal();
				break;
			}
			case 'backgroundImage':
				if (window.getBackgroundImage && window.getBackgroundImage() !== (msg.data || null)) {
					window.setBackgroundImage(msg.data, S.settings);
					if (S.open && S.section === 'appearance') renderPage();
				}
				break;

			case 'subagents':
				S.subagents = msg.data;
				if (S.open && (S.section === 'subagents' || S.section === 'agent')) renderPage();
				break;
			case 'subagentSaved':
				if (S.subDialog) S.subDialog.close();
				break;
			case 'subagentError': {
				const box = S.subDialog && S.subDialog.body.querySelector('.sa-error');
				if (box) {
					box.textContent = msg.error;
					box.classList.remove('hidden');
				} else toast(msg.error, 'error');
				break;
			}
			case 'cloudStatus':
				S.cloud = { ...(S.cloud && S.cloud.repo === msg.data.repo ? S.cloud : {}), ...msg.data };
				if (S.open && (S.section === 'tasks' || S.section === 'cloud')) renderPage();
				break;
			case 'cloudTasks':
				if (S.cloud) {
					S.cloud.tasks = msg.tasks || [];
					if (S.open && (S.section === 'tasks' || S.section === 'cloud')) renderPage();
				}
				break;
			case 'lmsModels':
				S.lms = { items: msg.items || [], error: msg.error };
				S.lmsBusy = null;
				renderLocal();
				break;
			case 'engineError':
				S.engineLoading = null;
				toast(msg.error, 'error');
				renderLocal();
				break;
			case 'localModels':
				S.engineLoading = null;
				S.localModels = msg.data;
				S.localLoading = false;
				S.localJobs = Object.fromEntries((msg.data.jobs || []).map((j) => [j.key, j]));
				if (S.open && S.section === 'local') renderPage();
				break;
			case 'localInspect':
				S.localInspect = msg;
				if (S.open && S.section === 'local') renderPage();
				break;
			case 'localPull':
				// Progress comes through 'localJob'; only surface failures here.
				if (msg.error && msg.error !== 'Cancelled') toast(msg.tag + ': ' + msg.error, 'error');
				break;
			
			case 'cloudProgress':
				S.cloudSteps = S.cloudSteps || {};
				S.cloudSteps[msg.step] = { state: msg.state, note: msg.note };
				if (msg.state === 'err') toast(msg.note || 'Setup step failed', 'error');
				if (S.open && (S.section === 'tasks' || S.section === 'cloud')) renderPage();
				break;
			case 'skillCatalog':
				S.skillCatalog = msg;
				if (S.open && S.section === 'plugins') renderPage();
				break;
			case 'memoryDuplicates':
				S.memoryDuplicates = msg.groups || [];
				if (S.open && (S.section === 'memory' || S.section === 'hooks-memory')) renderPage();
				if (!S.memoryDuplicates.length) toast('No similar memories found.', 'ok');
				break;
			case 'skillInstallFailed': {
				S.skillBusy = null;
				const i = S.skillRepo ? S.skillRepo.skills.findIndex(x => x.id === msg.id) : -1;
				const b = i >= 0 && S.skillLinkDlg ? S.skillLinkDlg.body.querySelector('[data-sk-direct="' + i + '"]') : null;
				if (b) { b.disabled = false; b.innerHTML = I('plus') + 'Install'; }
				if (S.open && S.section === 'plugins') renderPage();
				break;
			}
			case 'skillInstalled': {
				S.skillBusy = null;
				// The link dialog: that skill's button becomes "Installed".
				const i = S.skillRepo ? S.skillRepo.skills.findIndex((x) => x.id === msg.id) : -1;
				const b = i >= 0 && S.skillLinkDlg ? S.skillLinkDlg.body.querySelector('[data-sk-direct="' + i + '"]') : null;
				if (b) b.outerHTML = '<span class="badge ok">Installed</span>';
				if (S.open && S.section === 'plugins') renderPage();
				break;
			}
			case 'skillRepo': {
				S.skillRepo = msg;
				const d = S.skillLinkDlg;
				if (!d || !document.body.contains(d.dlg)) break;
				const hint = d.body.querySelector('#sk-link-hint');
				const list = d.body.querySelector('#sk-link-list');
				const have = new Set((S.skills || []).map((x) => x.name.toLowerCase()));
				hint.textContent = msg.error || msg.repo + ' — ' + msg.skills.length + ' skill' + (msg.skills.length === 1 ? '' : 's');
				list.innerHTML = (msg.skills || []).map((x, i) => '<div class="pick-item sk-pick"><span class="grow"><b>' + esc(x.name) + '</b><span class="sub">' + esc(x.description) + '</span></span>' + (have.has(x.name.toLowerCase()) ? '<span class="badge ok">Installed</span>' : '<button class="btn btn-secondary btn-sm" data-sk-direct="' + i + '">' + I('plus') + 'Install</button>') + '</div>').join('');
				break;
			}
			case 'featuresHealth':
				if (msg.requestId !== S.featureHealthId || msg.revision !== S.featureRevision) break;
				clearTimeout(S.featureHealthTimer);
				if (!msg.error && !msg.cancelled) S.health = { at: msg.at, items: msg.items || [] };
				S.featureHealthError = msg.error || (msg.cancelled ? 'Check cancelled.' : '');
				S.healthBusy = false;
				if (S.open && S.section === 'features') renderPage();
				break;
			case 'benchmarkState':
				S.bench = msg; if (msg.running) S.benchError = '';
				if (S.open && S.section === 'features' && S.featureTab === 'benchmark') renderPage(); break;
			case 'benchmarkError':
				S.benchError = msg.error || '';
				if (S.open && S.section === 'features' && S.featureTab === 'benchmark') renderPage(); break;
			case 'featureToolsState':
				S.featureRoot = msg.root || ''; S.featureReports = msg.reports || []; S.featureRunning = msg.running;
				S.featureReports.forEach(r => { if (S.featureConfiguration && r.configuration && r.configuration !== S.featureConfiguration) r.stale = true; });
				if (S.open && S.section === 'features') renderPage(); break;
			case 'featurePlan':
				if (msg.requestId === S.featureRequestId && S.open && S.section === 'features') reviewFeaturePlan(msg.plan); break;
			case 'featureReport':
				if (S.featureConfiguration && msg.report.configuration && msg.report.configuration !== S.featureConfiguration) msg.report.stale = true;
				if (msg.report.root === S.featureRoot) { S.featureReports = [...S.featureReports.filter(r => r.id !== msg.report.id),msg.report].slice(-20); if (S.open && S.section === 'features') renderPage(); } break;
			case 'featureWorkspace':
				if (msg.root !== S.featureRoot) break;
				S.featureRevision++; S.featureHealthError = '';
				if (S.healthBusy) post({type:'featuresCancel'});
				clearTimeout(S.featureHealthTimer); S.healthBusy = false; S.featureHealthId = null;
				if (S.health) S.health.stale = true;
				S.featureReports = (msg.reports || []).filter(r => r.root === S.featureRoot);
				if (S.open && S.section === 'features') renderPage(); break;
			case 'featureLanguage':
				if (msg.requestId !== S.featureRequestId) break;
				S.featureLanguageResult = msg.result; if (S.open && S.section === 'features') renderPage(); break;
			case 'featureImage': {
				const dialog = openDialog({title:'Browser check screenshot'});
				const image = document.createElement('img'); image.src = 'data:image/jpeg;base64,' + msg.data; image.alt = 'Browser check evidence'; image.style.width = '100%'; dialog.body.appendChild(image); break;
			}
			case 'featureToolsError':
				S.featureRunning = msg.running || null; toast(msg.error,'error'); if (S.open && S.section === 'features') renderPage(); break;

			case 'usageData':
				S.usage = msg;
				if (S.usageDetail && msg.days === S.usageDays) {
					const selected = S.usageDetail.row;
					const row = msg.models.find((m) => m.providerId === selected.providerId && m.model === selected.model);
					if (row) requestUsageDetail(row, S.usageDetail.focusId);
					else S.usageDetail = null;
				}
				if (S.open && S.section === 'usage') renderPage();
				break;
			case 'usageModelData':
				if (S.usageDetail?.requestId !== msg.requestId || (!msg.error && msg.days !== S.usageDays)) break;
				S.usageDetail.data = msg;
				if (S.open && S.section === 'usage') renderPage();
				break;
			case 'usageCsv': {
				S.usageExporting = false;
				const url = URL.createObjectURL(new Blob([msg.csv], { type: 'text/csv;charset=utf-8' }));
				const link = document.createElement('a');
				link.href = url;
				link.download = msg.filename;
				document.body.appendChild(link);
				link.click();
				link.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				if (S.open && S.section === 'usage') renderPage();
				break;
			}
			case 'usageExportDone':
				S.usageExporting = false;
				if (msg.error) toast('Export failed: ' + msg.error, 'error');
				if (S.open && S.section === 'usage') renderPage();
				break;
		}
	});

	window.Settings = { open, close };

	// Full-size settings panel (editor area): open immediately and ask for state.
	if (standalone) {
		open(initialSectionFromBody() || S.section);
	}
	function initialSectionFromBody() {
		return (document.body.className.match(/section-(\w+)/) || [])[1];
	}
})();
