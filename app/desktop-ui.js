/*
 * zer0ne Code desktop layer, injected into every page of the main window.
 * The extension's UI stays untouched; this only adds what a desktop app needs:
 *
 *  - a frameless window: minimize / maximize / close in the app's own top bar,
 *    which also drags the window (double-click maximizes);
 *  - the Projects sidebar open by default, with "New Project" (open a new project
 *    folder) on top, Settings at the bottom, and hover actions to delete a chat
 *    or remove a project;
 *  - the bell in the sidebar foot: the run notifications the shell recorded (a run
 *    finished, an engine died) — an unread badge, a shake when one arrives, and a
 *    panel above the bell that lists them and marks them read.
 */
(function () {
	'use strict';
	if (window.__zcDesktop) return;
	window.__zcDesktop = true;

	const bridge = () => window.__zcShell;
	const win = (cmd) => (bridge() ? bridge().invoke('plugin:window|' + cmd, {}).catch(() => undefined) : Promise.resolve());

	let desktopInitialized = false;
	let stateSeen = false;
	let prefsSeen = false;
	let activation = null;
	let acked = null;
	let ackPending = false;
	let ackRetries = 0;
	let notifyOn = true;
	let updatePanelWidths = () => {};
	let refreshPanelLayout = () => {};
	/**
	 * The bell's feed: run notifications the shell records (feedNotify in app/main.js).
	 * The shell keeps the list (every project, not just the one on screen) and pushes
	 * it here when it changes; the pages also poll it (notify_feed) to catch up after
	 * a project switch. Items: { id, kind: "done"|"crash", message, ts (ms), read }.
	 * Before the sidebar exists (start page) the list is only stored.
	 */
	const nfeed = { list: [], unread: -1, paint: () => {} };
	function pageReady() {
		if (!desktopInitialized || !stateSeen || !prefsSeen || !activation || ackPending || acked === activation) return;
		if (window.__zcActivationId && window.__zcActivationId !== activation) return;
		const id = activation;
		const native = window.__zcShell;
		if (!native || typeof native.invoke !== 'function') return;
		ackPending = true;
		let delivered = false;
		let timer;
		const deliver = () => {
			if (delivered) return;
			delivered = true;
			clearTimeout(timer);
			ackPending = false;
			if (id !== activation || (window.__zcActivationId && window.__zcActivationId !== id)) {
				pageReady();
				return;
			}
			acked = id;
			const retry = () => {
				if (id !== activation || window.__zcActivationId !== id) return;
				acked = null;
				if (ackRetries++ < 3) setTimeout(pageReady, 250);
			};
			void native.invoke('zc_page_ready', { activationId: id }).then(value => {
				if (value === false) { retry(); return; }
				refreshPanelLayout();
				window.__zgRefreshPanels?.();
				// Hidden views can receive their bounds without a paint or resize event.
				setTimeout(() => { refreshPanelLayout(); window.__zgRefreshPanels?.(); }, 100);
			}, retry);
		};
		// Offscreen views can suspend frames and timers. A microtask lets the remaining
		// message listeners apply state before acknowledging, without waiting for a paint.
		timer = setTimeout(deliver, 100);
		requestAnimationFrame(deliver);
		Promise.resolve().then(deliver);
	}
	let notchOn = true;
	function applyNotificationPreference() {
		if (document.body) document.body.classList.toggle('zc-notify-off', !notifyOn);
	}
	window.addEventListener('message', (e) => {
		if (e.source && e.source !== window) return;
		const m = e.data;
		if (!m || typeof m !== 'object') return;
		if (m.type === 'state' && m.settings) {
			stateSeen = true;
			// The bell's panel carries the notch's switch too (Settings → Notch).
			if (notchOn !== (m.settings.notch !== false)) {
				notchOn = m.settings.notch !== false;
				window.dispatchEvent(new CustomEvent('zc-notch-changed'));
			}
		}
		if (m.type === 'zcDesktopPrefs' && m.prefs) {
			notifyOn = m.prefs.notify !== false;
			applyNotificationPreference();
			prefsSeen = true;
			if (m.prefs.panel) restoreProjectPanel(m.prefs.panel);
			if (m.prefs.widths) updatePanelWidths(m.prefs.widths);
		}
		if (m.type === 'zcDesktopActivated' && typeof m.activationId === 'string') {
			if (activation !== m.activationId) ackRetries = 0;
			activation = m.activationId;
			window.__zcActivationId = activation;
		}
		pageReady();
	});
	window.addEventListener('zc-notify-toggle', () => {
		notifyOn = !notifyOn;
		applyNotificationPreference();
		nfeed.paint();
		post({ type: 'zcDesktopPrefs', prefs: { notify: notifyOn } });
	});
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			post({ type: 'zcDesktopPrefs' });
			pageReady();
		}
	});
	function preferencesReady() {
		desktopInitialized = true;
		applyNotificationPreference();
		post({ type: 'zcDesktopPrefs' });
		pageReady();
	}

	const svg = (body) => '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">' + body + '</svg>';
	const ICON = {
		min: svg('<path d="M0 5.5h10"/>'),
		max: svg('<rect x="0.5" y="0.5" width="9" height="9"/>'),
		restore: svg('<rect x="0.5" y="2.5" width="7" height="7"/><path d="M2.5 2.5V0.5h7v7h-2"/>'),
		close: svg('<path d="M0.5 0.5l9 9M9.5 0.5l-9 9"/>'),
		trash: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>',
		remove: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
		plus: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
		// Settings, About and Mobile remote: Lucide icons (ISC licence, lucide.dev).
		notch: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><rect x="8" y="4" width="8" height="4" rx="2" fill="currentColor" stroke="none"/></svg>',
		gear: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
		info: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
		phone: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="20" x="5" y="2" rx="2.5"/><path d="M12 18h.01"/></svg>',
		bell: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
		bellOff: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></svg>',
		folderPlus: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M8 7v4M6 9h4"/></svg>',
		computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/></svg>',
		folder: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>',
		chevDown: '<svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6.5L8 10l3.5-3.5"/></svg>',
		copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5H4A1.5 1.5 0 0 0 2.5 5v6.5"/></svg>',
		// check-check and x for the bell's panel: Lucide icons (ISC licence, lucide.dev).
		checkCheck: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>',
		x: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>'
	};

	const BRAND = {
		explorer: '<svg class="zc-brand" viewBox="0 0 24 24" aria-hidden="true"><path fill="#F0A731" d="M2 6.2A2.2 2.2 0 0 1 4.2 4h4.4l2.1 2.5h9.1A2.2 2.2 0 0 1 22 8.7V10H2z"/><path fill="#FFCF6B" d="M2 9.5h20v7.6a2.2 2.2 0 0 1-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.1z"/></svg>',
		vscode: '<svg class="zc-brand" viewBox="0 0 24 24" aria-hidden="true"><path fill="#23A9F2" d="m17 2 5 2v16l-5 2L7 14l-4 3-2-1V8l2-1 4 3zm0 5-7 5 7 5zM3 10v4l2-2z"/></svg>',
		cursor: '<svg class="zc-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m4 3 15 9-7 2-3 7z"/><path d="m12 14 6 6"/></svg>',
		terminal: '<svg class="zc-brand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3m7 0h4"/></svg>',
	};

	const CSS = `
	dialog.zc-project-dialog { box-sizing:border-box; width:min(512px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; margin:auto; padding:20px 16px 16px; border:1px solid var(--color-border,#414141); border-radius:17px; background:var(--color-popover,#292929); color:var(--color-foreground,#e9e9e9); box-shadow:0 24px 80px #0006; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
	dialog.zc-project-dialog::backdrop { background:rgba(0,0,0,.64); backdrop-filter:blur(5px); }
	dialog.zc-project-dialog h2 { margin:0 32px 22px 0; font-size:14px; font-weight:600; }
	dialog.zc-project-dialog .zc-project-close { position:absolute; top:16px; right:14px; padding:4px; border:0; background:transparent; color:var(--color-foreground-muted,#999); cursor:pointer; }
	dialog.zc-project-dialog label, dialog.zc-project-dialog .zc-project-label { display:block; margin:20px 0 6px; font-size:12px; font-weight:600; }
	dialog.zc-project-dialog input, dialog.zc-project-dialog .zc-project-device { box-sizing:border-box; width:100%; min-height:36px; padding:7px 9px; border:1px solid var(--color-border,#444); border-radius:8px; background:transparent; color:inherit; font:inherit; }
	dialog.zc-project-dialog .zc-project-device { display:flex; align-items:center; gap:9px; }
	dialog.zc-project-dialog .zc-project-device svg { width:16px; height:16px; color:var(--color-foreground-muted,#999); }
	dialog.zc-project-dialog .zc-project-choose { display:flex; width:100%; min-height:136px; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:18px; border:1px dashed var(--color-border,#414141); border-radius:9px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
	dialog.zc-project-dialog .zc-project-choose:hover { background:rgba(128,128,128,.08); }
	dialog.zc-project-dialog .zc-project-folder-icon { display:grid; place-items:center; width:36px; height:36px; border-radius:50%; background:rgba(128,128,128,.12); color:var(--color-foreground-muted,#aaa); }
	dialog.zc-project-dialog .zc-project-folder-icon svg { width:18px; height:18px; }
	dialog.zc-project-dialog small, dialog.zc-project-dialog p { color:var(--color-foreground-muted,#a1a1a1); }
	dialog.zc-project-dialog small { font-size:12px; font-weight:400; overflow-wrap:anywhere; }
	dialog.zc-project-dialog .zc-project-actions { display:flex; flex-wrap:wrap; gap:8px; justify-content:flex-end; margin-top:20px; }
	dialog.zc-project-dialog .zc-project-actions button { padding:4px 9px; border:1px solid transparent; border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
	dialog.zc-project-dialog .zc-project-actions button:hover { background:rgba(128,128,128,.16); }
	dialog.zc-project-dialog .zc-project-actions .zc-project-primary { background:#f8f8f8; border-color:#d8d8d8; color:#202020; }
	dialog.zc-project-dialog .zc-project-actions .zc-project-primary:hover { background:#e4e4e4; }
	dialog.zc-project-dialog button:disabled { opacity:.45; cursor:default; }
	dialog.zc-project-dialog :is(input,button):focus-visible { outline:2px solid var(--color-accent,#b8b8b8); outline-offset:3px; }
	dialog.zc-project-dialog .zc-project-error { color:var(--color-error,#ff9999); font-size:12px; margin:12px 0 0; }
	dialog.zc-project-trust { width:min(448px, calc(100vw - 32px)); }
	dialog.zc-project-trust h2 { margin-bottom:18px; }
	dialog.zc-project-trust p { margin:14px 0; }
	dialog.zc-project-trust code { display:block; overflow-wrap:anywhere; white-space:pre-wrap; font-size:12px; }
	.zc-win { display:flex; align-self:stretch; flex-shrink:0; margin:-1px 0 -1px 8px; }
	.zc-win button { width:46px; min-height:40px; border:0; padding:0; background:transparent; color:var(--color-foreground-muted,#a1a1aa); display:grid; place-items:center; cursor:default; }
	.zc-win button:hover { background:rgba(128,128,128,.18); color:var(--color-foreground,#fff); }
	.zc-win button.zc-close:hover { background:#e81123; color:#fff; }
	body.desktop .topbar { padding-right:0; user-select:none; }
	body.desktop .fullscreen-btn { display:inline-flex; }
	.zc-titlebar { position:fixed; top:0; left:0; right:0; height:40px; display:flex; justify-content:flex-end; z-index:1000; }
	body.desktop.zc-native-fullscreen :is(.topbar, .zc-titlebar) {
		position:fixed !important; top:12px; left:12px; right:12px; width:auto; height:48px;
		box-sizing:border-box; padding:0 5px 0 12px; margin:0; z-index:48 !important;
		border:1px solid color-mix(in srgb, var(--color-foreground, var(--fg, #fff)) 14%, transparent) !important;
		border-radius:14px;
		background:linear-gradient(135deg, #ffffff0b, #ffffff02), color-mix(in srgb, var(--color-background, var(--bg, #161616)) 92%, transparent) !important;
		backdrop-filter:blur(22px) saturate(135%); -webkit-backdrop-filter:blur(22px) saturate(135%);
		box-shadow:0 12px 36px -16px #0009, inset 0 1px 0 #ffffff0b;
		transform:translateY(calc(-100% - 24px)) scale(.985); transform-origin:top center;
		opacity:0; visibility:hidden; pointer-events:none; -webkit-app-region:no-drag;
		transition:transform .28s cubic-bezier(.2,.8,.2,1), opacity .2s ease, visibility 0s .28s;
	}
	body.desktop.zc-native-fullscreen.zc-fullscreen-bar-visible :is(.topbar, .zc-titlebar) {
		transform:none; opacity:1; visibility:visible; pointer-events:auto; transition-delay:0s;
	}
	body.desktop.zc-native-fullscreen :is(.topbar, .zc-titlebar)::after {
		content:""; position:absolute; left:20%; right:20%; bottom:-1px; height:1px; pointer-events:none;
		background:linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent, #f7931e) 45%, transparent), transparent);
	}
	body.desktop.zc-native-fullscreen .zc-win { align-self:center; margin:0 0 0 8px; padding-left:8px; gap:2px; border-left:1px solid color-mix(in srgb, var(--color-foreground, #fff) 10%, transparent); }
	body.desktop.zc-native-fullscreen .zc-win button { width:40px; min-height:34px; border-radius:8px; cursor:pointer; transition:background .15s ease, color .15s ease, transform .15s ease; }
	body.desktop.zc-native-fullscreen .zc-win button:active { transform:scale(.94); }
	.zc-fullscreen-peek { display:none; }
	body.desktop.zc-native-fullscreen .zc-fullscreen-peek {
		display:grid; place-items:start center; position:fixed; top:0; left:50%; transform:translateX(-50%);
		width:112px; height:12px; padding:3px 0 0; border:0; border-radius:0 0 8px 8px; background:transparent;
		z-index:49; cursor:pointer; -webkit-app-region:no-drag;
	}
	.zc-fullscreen-peek span { width:42px; height:3px; border-radius:99px; background:var(--color-foreground-muted, var(--muted, #8b8b93)); opacity:.35; transition:width .2s ease, opacity .2s ease; }
	.zc-fullscreen-peek:hover span, .zc-fullscreen-peek:focus-visible span { width:64px; opacity:.85; }
	.zc-fullscreen-peek:focus-visible { outline:2px solid var(--accent, #f7931e); outline-offset:2px; }
	.zc-fullscreen-peek[hidden] { display:none !important; }
	@media (prefers-reduced-motion:reduce) {
		body.desktop.zc-native-fullscreen :is(.topbar, .zc-titlebar), body.desktop.zc-native-fullscreen .zc-win button, .zc-fullscreen-peek span { transition:none; }
	}
	/* The bars are the window's native drag region (double-click maximizes, see app/engines.js). Controls and anything
	   that can open over the bar stay clickable: Electron subtracts every no-drag box from the drag region. */
	.zc-drag { -webkit-app-region:drag; }
	.zc-drag :is(button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], [tabindex]:not([tabindex="-1"]), .zc-win),
	:is(.popover, [role="dialog"], [role="menu"], [role="listbox"], dialog, .question-popup, .row-menu, .input-menu, .fs-hot, .fs-banner, .fs-preview, .mods-popup,
		.aux-max, .project-palette-backdrop, .media-overlay, .settings-overlay, .overlay, .toast, .zc-note, .zc-npanel, .zg-pop) { -webkit-app-region:no-drag; }
	body.desktop #sidebar, body.desktop #auxiliary { background:linear-gradient(160deg, color-mix(in srgb, var(--accent) 4%, transparent), transparent 45%), color-mix(in srgb, var(--color-panel) 80%, var(--color-background)); border-color:color-mix(in srgb, var(--color-foreground) 10%, transparent); box-shadow:inset 0 1px 0 color-mix(in srgb, var(--color-foreground) 5%, transparent); }
	#sidebar .sidebar-head { flex-shrink:0; min-height:48px; padding:12px 14px 10px; border-bottom:0; gap:8px; }
	#sidebar .sidebar-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--color-foreground); font-size:13px; font-weight:600; letter-spacing:-.015em; }
	#sidebar .sidebar-head-tools { flex-shrink:0; gap:3px; }
	#sidebar .sidebar-head-tools .icon-btn { width:26px; height:26px; border-radius:7px; }
	#sidebar #btn-project-add { display:none; }
	.zc-side-new { display:flex; align-items:center; justify-content:flex-start; flex-shrink:0; gap:9px; min-height:34px; margin:0 12px 10px; padding:7px 11px; border:1px solid color-mix(in srgb, var(--color-foreground) 10%, transparent); border-radius:9px; background:color-mix(in srgb, var(--color-foreground) 4%, transparent); color:var(--color-foreground); font:inherit; font-size:12.5px; font-weight:500; text-align:left; cursor:pointer; transition:background .16s, border-color .16s, transform .12s; }
	.zc-side-new:hover { background:color-mix(in srgb, var(--color-foreground) 8%, transparent); border-color:color-mix(in srgb, var(--color-foreground) 16%, transparent); }
	.zc-side-new:active { transform:scale(.985); }
	.zc-side-new svg { color:var(--accent-strong); }
	#sidebar .project-panel-views .project-view:nth-child(2),
	#sidebar .project-view[data-view="chats"] { display:none !important; }
	#sidebar .project-panel-controls { display:none; }
	#sidebar .project-panel-views .project-view:first-child { cursor:default; background:transparent; color:var(--color-foreground); font-weight:600; padding:4px 6px; font-size:12.5px; }
	#sidebar .ps-box { box-sizing:border-box; flex-shrink:0; width:calc(100% - 24px); height:32px; margin:0 12px 12px; padding:0 9px; gap:8px; border:1px solid transparent; border-radius:9px; background:color-mix(in srgb, var(--color-foreground) 5%, transparent); transition:border-color .16s, box-shadow .16s, background .16s; }
	#sidebar .ps-box.ps-expanded { border-color:color-mix(in srgb, var(--color-foreground) 12%, transparent); box-shadow:none; }
	#sidebar .ps-box:focus-within { border-color:color-mix(in srgb, var(--accent) 60%, transparent); box-shadow:0 0 0 3px var(--accent-soft); background:transparent; }
	#sidebar .ps-kbd { padding:2px 4px; font-weight:400; border-radius:4px; background:transparent; }
	#sidebar .ps-clear { width:20px; height:20px; }
	.zc-side-foot { display:flex; align-items:center; flex-shrink:0; gap:2px; padding:8px 10px; border-top:1px solid color-mix(in srgb, var(--color-foreground) 8%, transparent); background:transparent; }
	.zc-side-foot button { display:flex; align-items:center; gap:8px; flex:1; min-width:0; min-height:34px; padding:7px 9px; border:0; border-radius:7px; background:none; color:var(--color-foreground-muted); font:inherit; font-size:12px; text-align:left; cursor:pointer; }
	.zc-side-foot button:hover { background:color-mix(in srgb, var(--color-foreground) 7%, transparent); color:var(--color-foreground); }
	.zc-side-foot small { color:var(--color-foreground-subtle,#71717a); font-size:10.5px; padding-right:6px; }
	body.desktop .sidebar > .panel-note { display:none; }
	.zc-act { font-style:normal; display:none; align-items:center; justify-content:center; flex-shrink:0; width:22px; height:22px; border-radius:6px; color:var(--color-foreground-muted); cursor:pointer; }
	.zc-act:hover { background:rgba(128,128,128,.2); color:var(--color-foreground); }
	.zc-act.zc-armed { display:inline-flex; width:auto; padding:0 7px; background:#c42b1c; color:#fff; font-size:10.5px; font-weight:600; }
	#sidebar .project-chat:hover .zc-act, #sidebar .project-chat:focus-within .zc-act, #sidebar .zc-act.zc-armed { display:inline-flex; }
	#sidebar .project-chat:hover time, #sidebar .project-chat:focus-within time { display:none; }
	#sidebar .project-row:hover .zc-act, #sidebar .project-row:focus-within .zc-act { display:inline-flex; }
	.zc-busy-chip { flex-shrink:0; display:inline-flex; align-items:center; gap:5px; font-style:normal; font-size:9.5px; font-weight:600; padding:1px 7px; border-radius:8px; color:var(--accent-strong, #f7931e); background:var(--accent-soft, rgba(247,147,30,.14)); }
	.zc-busy-chip.zc-waiting-chip { color:#f59e0b; background:rgba(245,158,11,.16); border:1px solid rgba(245,158,11,.3); }
	@keyframes zc-pulse { 0%, 100% { opacity:1; } 50% { opacity:.55; } }
	@media (prefers-reduced-motion: reduce) { .zc-busy-chip { animation:none; } }
	/* The shell's small note ("Opening P2P Agent…" while a first engine boots behind the screen). */
	.zc-note { position:fixed; left:50%; bottom:18px; transform:translate(-50%, 12px); z-index:1200; max-width:70%; padding:7px 14px; border-radius:10px; border:1px solid var(--color-border, rgba(255,255,255,.12)); background:var(--color-background, #161616); color:var(--color-foreground, #fff); font:inherit; font-size:12px; opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; box-shadow:0 6px 24px rgba(0,0,0,.35); }
	.zc-note.zc-show { opacity:1; transform:translate(-50%, 0); }
	/* One Settings (the panel footer), New chat only in the Projects panel, no History in the top bar. */
	body.desktop .topbar #btn-settings, body.desktop .topbar #btn-new, body.desktop .topbar #btn-history, body.desktop .topbar #btn-side-chat { display:none !important; }
	/* "Open project folder": the button waits (hidden) until a workspace folder answers. */
	.zc-open-btn .zc-chev { display:inline-flex; opacity:.65; }
	.zc-open-menu { min-width: 230px; }
	.zc-open-menu .zc-brand { width:16px; height:16px; flex-shrink:0; border-radius:3px; }
	.zc-side-foot button.zc-icon-btn { flex:0 0 auto; width:34px; height:34px; padding:0; justify-content:center; color:var(--color-foreground-muted); }
	.zc-side-foot button.zc-icon-btn:hover { color:var(--color-foreground); }
	.zc-side-foot svg { flex-shrink:0; }
	/*
	 * Project folders fold like an accordion: a chevron on the row spins open/closed
	 * with a springy ease, and the chat list rolls (height 0↔auto) with a gentle fade.
	 * ::details-content (Chromium 131+) and interpolate-size (129+) drive it; on an
	 * older engine page the fold simply stays instant.
	 */
	#sidebar details.project-group { interpolate-size:allow-keywords; margin:0 0 6px; padding:4px; border:1px solid color-mix(in srgb, var(--color-foreground) 7%, transparent); border-radius:12px; background:color-mix(in srgb, var(--color-panel) 55%, transparent); }
	#sidebar details.project-group.zc-current-project { border-color:color-mix(in srgb, var(--accent) 25%, transparent); background:color-mix(in srgb, var(--accent) 4%, var(--color-panel)); }
	#sidebar details.project-group + details.project-group { margin-top:4px; }
	#sidebar details.project-group.zc-current-project > summary .zc-project-title { color:var(--color-foreground); }
	#sidebar details.project-group summary { min-height:34px; padding:5px 6px 5px 8px; gap:9px; border-radius:8px; color:var(--color-foreground-muted); transition:background-color .16s, color .16s; }
	#sidebar details.project-group summary:hover { background:color-mix(in srgb, var(--color-foreground) 6%, transparent); color:var(--color-foreground); }
	#sidebar .project-name { display:flex; flex:1; min-width:0; flex-direction:row; align-items:center; gap:8px; font-size:12.5px; font-weight:600; letter-spacing:-.01em; }
	#sidebar .zc-project-title { display:block; flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-height:1.3; }
	#sidebar .project-tools { opacity:1; gap:1px; flex-shrink:0; transition:opacity .14s; }
	#sidebar .project-tools .zc-delete-project { display:inline-flex; width:24px; height:24px; }
	#sidebar .zc-delete-project:hover { color:#ef6666; background:color-mix(in srgb, #ef6666 12%, transparent); }
	#sidebar details.project-group summary:hover .project-tools, #sidebar details.project-group summary:focus-within .project-tools { opacity:1; }
	#sidebar .project-tools .icon-btn { width:24px; height:24px; border-radius:6px; color:var(--color-foreground-muted); }
	#sidebar .project-tools .icon-btn:hover { color:var(--accent-strong); background:var(--accent-soft); }
	#sidebar .project-chats { position:relative; margin:4px 0 12px 12px; padding:2px 0 2px 9px; border-left:1px solid color-mix(in srgb, var(--color-foreground) 9%, transparent); transition:translate .24s ease, opacity .24s; }
	#sidebar details:not([open]) .project-chats { translate:0 -3px; opacity:0; }
	#sidebar details.project-group::details-content {
		block-size: 0;
		overflow-y: clip;
		opacity: 0;
		transition: block-size .38s cubic-bezier(.33, 1, .68, 1), opacity .28s ease, content-visibility .38s allow-discrete;
	}
	#sidebar details.project-group[open]::details-content { block-size: auto; opacity: 1; }
	#sidebar-content.zc-panel-restoring details.project-group::details-content { transition:none; }
	#sidebar { position:relative; }
	#sidebar .zc-project-haze {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 44px;
		top: 0;
		pointer-events: none;
		overflow: hidden;
		z-index: 0;
		opacity: 0.16;
		mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 24px, black 100%);
		-webkit-mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.5) 24px, black 100%);
		transition: top .2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity .2s ease;
	}
	#sidebar .zc-haze-canvas {
		display: block;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}
	#sidebar-content { position:relative; z-index:1; padding:0 8px 16px; overflow-anchor:none; scrollbar-gutter:stable; }
	#sidebar .sidebar-head, #sidebar .zc-side-new, #sidebar .project-panel-controls, #sidebar .ps-box, #sidebar .zc-side-foot { position:relative; z-index:2; }
	#sidebar .project-row > svg { box-sizing:content-box; flex-shrink:0; width:15px; height:15px; padding:0; border:0; border-radius:0; color:var(--color-foreground-muted); background:none; }
	#sidebar .zc-current-project .project-row > svg { color:var(--accent-strong); background:none; }
	#sidebar .project-badge { display:none !important; }
	#sidebar .project-chat { position:relative; min-height:36px; margin:3px 0; padding:0; border-radius:10px; font-size:12.5px; gap:4px; color:var(--color-foreground-muted); transition:background .16s, color .16s; }
	#sidebar .project-chat > span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	#sidebar .project-chat.selected { background:color-mix(in srgb, var(--color-foreground) 8%, transparent); color:var(--color-foreground); box-shadow:none; }
	#sidebar .project-chat.selected::before { content:''; position:absolute; left:-10px; top:8px; bottom:8px; width:2px; border-radius:2px; background:var(--accent); }
	#sidebar .project-chat.selected > span { font-weight:500; }
	#sidebar .project-chat:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); color:var(--color-foreground); }
	#sidebar .project-chat.selected:hover { background:color-mix(in srgb, var(--color-foreground) 10%, transparent); }
	#sidebar .project-chat > svg { display:none; width:12px; height:12px; flex-shrink:0; }
	#sidebar .project-chat.zc-pinned > svg { display:block; color:var(--accent-strong); }
	#sidebar .project-chat.selected > svg { color:var(--accent-strong); }
	#sidebar .project-chat time { flex-shrink:0; color:var(--color-foreground-subtle, #71717a); font-size:10.5px; font-variant-numeric:tabular-nums; }
	#sidebar .project-chat .project-more { width:22px; height:22px; border-radius:5px; }
	#sidebar .project-chat:disabled { opacity:.45; cursor:not-allowed; }
	#sidebar .panel-note { padding:6px 8px; margin:0; color:var(--color-foreground-subtle, #71717a); font-size:11.5px; line-height:1.5; white-space:normal; }
	#sidebar .aux-empty { padding:24px 14px; color:var(--color-foreground-muted); font-size:12px; line-height:1.6; }
	#sidebar button:focus-visible, #sidebar summary:focus-visible, #sidebar .project-chat:focus-visible { outline:none; box-shadow:0 0 0 2px var(--accent-soft); }
	body.desktop :is(#sidebar, #auxiliary) { position:relative; box-sizing:border-box; --zc-panel-line:color-mix(in srgb, var(--color-foreground) 11%, transparent); background:var(--color-panel, var(--color-background)); box-shadow:none; }
	body.desktop #sidebar { flex:0 0 var(--zc-side-w, 320px); width:var(--zc-side-w, 320px); }
	body.desktop #auxiliary { flex:0 0 var(--zc-aux-w, 360px); width:var(--zc-aux-w, 360px); container-type:inline-size; }
	body.desktop :is(#sidebar .sidebar-head, #auxiliary .auxiliary-head) { box-sizing:border-box; min-height:52px; padding:10px 14px; border-bottom:1px solid var(--zc-panel-line); gap:10px; align-items:center; }
	body.desktop :is(#sidebar .sidebar-title, #auxiliary .auxiliary-title) { display:block; color:var(--color-foreground); font-size:14px; font-weight:650; letter-spacing:-.02em; line-height:1.25; }
	body.desktop :is(#sidebar .sidebar-title, #auxiliary .auxiliary-title)::before { display:block; margin-bottom:5px; font-size:9px; font-weight:600; letter-spacing:.14em; color:var(--color-foreground-muted); }
	body.desktop #sidebar .sidebar-title::before, body.desktop #auxiliary .auxiliary-title::before { content:none; }
	body.desktop #auxiliary .auxiliary-title > [data-icon] { display:none; }
	body.desktop :is(.sidebar-head-tools, .auxiliary-head-tools) { gap:3px; }
	body.desktop :is(.sidebar-head-tools, .auxiliary-head-tools) .icon-btn { width:28px; height:30px; border:1px solid transparent; border-radius:7px; color:var(--color-foreground-muted); }
	body.desktop :is(.sidebar-head-tools, .auxiliary-head-tools) .icon-btn:hover { background:var(--color-secondary); border-color:var(--zc-panel-line); color:var(--color-foreground); }
	body.desktop .zc-size-btn[aria-expanded="true"] { background:var(--accent-soft); color:var(--accent-strong); border-color:color-mix(in srgb, var(--accent) 30%, transparent); }
	body.desktop #sidebar .sidebar-head { order:0; }
	body.desktop #sidebar .zc-side-new { order:1; justify-content:center; min-height:38px; margin:16px 16px 12px; border:1px solid color-mix(in srgb, var(--accent) 70%, transparent); border-radius:8px; background:var(--accent); color:var(--color-background); font-size:12px; font-weight:650; box-shadow:inset 0 1px 0 #ffffff20, 0 2px 5px #00000012; }
	body.desktop #sidebar .zc-side-new svg { color:inherit; width:16px; height:16px; }
	body.desktop #sidebar .zc-side-new:hover { filter:brightness(1.08); }
	body.desktop #sidebar .ps-box { order:2; height:36px; width:calc(100% - 32px); margin:0 16px 16px; border:1px solid var(--zc-panel-line); background:var(--color-background); border-radius:8px; padding:0 10px; }
	body.desktop #sidebar .project-panel-controls { order:3; margin:0 16px 10px; padding-top:4px; justify-content:space-between; }
	body.desktop #sidebar .project-panel-views { display:none; }
	body.desktop #sidebar .project-panel-controls::before { content:'PROJECT LIBRARY'; font-size:9px; font-weight:650; letter-spacing:.12em; color:var(--color-foreground-muted); }
	body.desktop #sidebar .project-command { width:24px; height:24px; border:0; }
	body.desktop #sidebar-content { order:4; padding:0 12px 20px; scrollbar-gutter:auto; }
	body.desktop #sidebar .zc-side-foot { order:5; padding:12px; gap:5px; background:color-mix(in srgb, var(--color-background) 40%, transparent); border-color:var(--zc-panel-line); }
	body.desktop #sidebar .zc-side-foot button { min-height:36px; font-weight:500; border-radius:8px; }
	body.desktop #sidebar .zc-project-haze { display:none; }
	body.desktop #sidebar details.project-group { border:0; border-radius:9px; padding:0; margin:0 0 12px; background:transparent; }
	body.desktop #sidebar details.project-group + details.project-group { margin-top:0; }
	body.desktop #sidebar details.project-group.zc-current-project { background:color-mix(in srgb, var(--accent) 4%, transparent); }
	body.desktop #sidebar details.project-group summary { min-height:52px; padding:9px 8px; gap:10px; color:var(--color-foreground); border:1px solid transparent; border-radius:9px; }
	body.desktop #sidebar .zc-current-project > summary { background:color-mix(in srgb, var(--accent) 7%, transparent); border-color:color-mix(in srgb, var(--accent) 22%, transparent); }
	body.desktop #sidebar .project-folder-icon { box-sizing:border-box; display:grid; place-items:center; width:30px; height:30px; border-radius:8px; background:var(--color-secondary); color:var(--color-foreground-muted); }
	body.desktop #sidebar .zc-current-project .project-folder-icon { background:var(--accent-soft); color:var(--accent-strong); }
	body.desktop #sidebar .project-name { font-size:13px; font-weight:600; }
	body.desktop #sidebar .project-tools { gap:0; }
	body.desktop #sidebar .project-tools :is(.icon-btn, .zc-delete-project) { width:23px; height:26px; }
	body.desktop #sidebar .project-chats { margin:6px 8px 10px 24px; padding:0 0 0 14px; border-left:1px solid var(--zc-panel-line); }
	body.desktop #sidebar .project-chat { min-height:36px; border-radius:7px; margin:3px 0; }
	body.desktop #sidebar .project-chat-open { padding:9px 10px; }
	body.desktop #sidebar .panel-note { padding:9px 6px; font-size:11px; line-height:1.6; }
	body.desktop #auxiliary .auxiliary-tabs { display:flex; flex-wrap:nowrap; overflow-x:auto; gap:4px; margin:8px 10px 0; padding:4px; border:1px solid var(--zc-panel-line); border-radius:10px; background:var(--color-background); }
	body.desktop #auxiliary .auxiliary-tab { flex:0 0 auto; justify-content:center; min-width:0; height:30px; padding:0 9px; border:1px solid transparent; border-radius:6px; font-size:11px; font-weight:500; gap:4px; }
	body.desktop #auxiliary .auxiliary-tab.active { color:var(--color-foreground); background:var(--color-secondary); border-color:var(--zc-panel-line); box-shadow:0 1px 3px #00000012; }
	body.desktop #auxiliary .auxiliary-tab.active .i { color:var(--accent-strong); }
	body.desktop #auxiliary .aux-count { min-width:14px; padding:0 3px; font-size:9px; background:var(--accent-soft); color:var(--accent-strong); }
	body.desktop #auxiliary .aux-panel { padding:16px 14px; }
	body.desktop #auxiliary .aux-search { height:36px; border-color:var(--zc-panel-line); border-radius:8px; background:var(--color-background); }
	body.desktop #auxiliary .aux-search:focus-within { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent-soft); }
	body.desktop #auxiliary .aux-legend { padding:2px 4px 12px; gap:14px; font-size:10px; }
	body.desktop #auxiliary .aux-tree .fs-row { height:32px; border-radius:6px; font-size:12px; }
	body.desktop #auxiliary .aux-tree .fs-row::after { display:none; }
	body.desktop #auxiliary .aux-item, body.desktop #auxiliary .sag-card { border-radius:9px; border-color:var(--zc-panel-line); padding:14px; box-shadow:0 2px 5px #00000009; }
	body.desktop #auxiliary .aux-main b { font-size:13px; font-weight:600; }
	body.desktop #auxiliary .aux-section { margin:18px 2px 10px; font-size:9px; letter-spacing:.12em; }
	body.desktop #auxiliary .aux-empty { margin:12px 0; padding:32px 18px; border:1px dashed var(--zc-panel-line); border-radius:10px; background:color-mix(in srgb, var(--color-background) 40%, transparent); gap:9px; }
	body.desktop #auxiliary .aux-empty-ico { width:44px; height:44px; border-radius:12px; background:var(--accent-soft); color:var(--accent-strong); }
	body.desktop #auxiliary .aux-empty b { font-size:13px; color:var(--color-foreground); }
	body.desktop #auxiliary .aux-fsp { margin:0; }
	body.desktop #auxiliary .term-in { border-radius:8px; border-color:var(--zc-panel-line); background:var(--color-background); }
	body.desktop .zc-resize { position:absolute; top:0; bottom:0; width:9px; cursor:col-resize; touch-action:none; z-index:45; -webkit-app-region:no-drag; }
	body.desktop #sidebar > .zc-resize { right:-5px; }
	body.desktop #auxiliary > .zc-resize { left:-5px; }
	body.desktop .zc-resize::before { content:''; position:absolute; top:0; bottom:0; left:3px; width:3px; background:transparent; transition:background .15s; }
	body.desktop .zc-resize::after { content:''; position:absolute; top:50%; left:2px; width:5px; height:36px; border:1px solid var(--zc-panel-line); border-radius:4px; background:var(--color-foreground-muted); opacity:.35; transform:translateY(-50%); }
	body.desktop .zc-resize:is(:hover,:focus-visible,.zc-resize-active)::before { background:var(--accent); }
	body.desktop .zc-resize:is(:hover,:focus-visible,.zc-resize-active)::after { opacity:1; background:var(--accent); }
	body.desktop.zc-resizing, body.desktop.zc-resizing * { cursor:col-resize !important; user-select:none !important; }
	body.zc-resizing iframe { pointer-events:none !important; }
	.zc-size-pop { position:fixed; z-index:10030; box-sizing:border-box; width:270px; max-width:calc(100vw - 24px); padding:16px; border:1px solid var(--color-border-strong, var(--color-border)); border-radius:12px; background:var(--color-popover, var(--color-panel)); color:var(--color-foreground); box-shadow:0 12px 40px #00000035; -webkit-app-region:no-drag; }
	.zc-size-pop header { display:flex; align-items:center; justify-content:space-between; margin-bottom:18px; font-size:13px; font-weight:600; }
	.zc-size-pop output { font:11px var(--font-mono); font-weight:400; color:var(--color-foreground-muted); }
	.zc-size-pop label { display:block; font-size:11px; color:var(--color-foreground-muted); }
	.zc-size-pop input[type="range"] { display:block; appearance:none; width:100%; height:20px; margin:12px 0 18px; background:transparent; cursor:ew-resize; }
	.zc-size-pop input[type="range"]::-webkit-slider-runnable-track { height:4px; border-radius:4px; background:color-mix(in srgb, var(--color-foreground) 18%, transparent); }
	.zc-size-pop input[type="range"]::-webkit-slider-thumb { appearance:none; width:16px; height:16px; margin-top:-6px; border:3px solid var(--color-popover, var(--color-panel)); border-radius:50%; background:var(--accent); box-shadow:0 0 0 1px var(--accent); }
	.zc-size-pop input[type="range"]:focus-visible { outline:none; }
	.zc-size-pop input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow:0 0 0 1px var(--accent), 0 0 0 5px var(--accent-soft); }
	.zc-size-presets { display:flex; gap:5px; }
	.zc-size-pop button { min-height:32px; padding:0 8px; border:1px solid var(--color-border); border-radius:6px; background:var(--color-secondary); color:inherit; font:inherit; font-size:11px; cursor:pointer; }
	.zc-size-presets button { flex:1; }
	.zc-size-pop button:hover, .zc-size-pop button[aria-pressed="true"] { background:var(--accent-soft); border-color:var(--accent); color:var(--accent-strong); }
	.zc-size-pop .zc-size-reset { width:100%; margin-top:12px; background:transparent; }
	.zc-size-pop p { margin:12px 0 0; font-size:10px; line-height:1.6; color:var(--color-foreground-muted); }
	.zc-size-pop button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
	@container (max-width:320px) { body.desktop #auxiliary .auxiliary-tabs { grid-template-columns:repeat(2,minmax(0,1fr)); } }
	@media (max-width:999px) { body.desktop :is(#sidebar, #auxiliary) { position:absolute; max-width:calc(100vw - 24px); } }
	@media (prefers-reduced-motion:reduce) { body.desktop .zc-resize::before { transition:none; } }

	body.sag-motion-rest #sidebar .project-chat-open::before { animation-play-state: paused !important; }
	body.zc-resizing, body.zc-resizing * { cursor:col-resize !important; user-select:none !important; }
	body.zc-resizing #sidebar, body.zc-resizing #auxiliary { animation:none; }
	/*
	 * The sidebar bell: an unread badge that pops in, a shake when new notifications
	 * arrive, and a panel above the bell (it sits at the window's foot, so it opens
	 * upward; the fixed position keeps the sidebar's own overflow from clipping it).
	 */
	.zc-bell { position:relative; }
	.zc-nbadge { position:absolute; top:-4px; right:-3px; display:flex; align-items:center; justify-content:center; min-width:17px; height:17px; padding:0 4px; border-radius:999px; border:2px solid var(--color-panel, var(--color-background, #0E0E0E)); background:#f43f5e; color:#fff; font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:9px; font-weight:700; line-height:1;  }
	.zc-nbadge[hidden] { display:none; }
	@keyframes zc-npop { from { transform:scale(0); opacity:0; } }
	.zc-shake {  }
	@keyframes zc-nshake { 0% { transform:rotate(0); } 15% { transform:rotate(-12deg); } 30% { transform:rotate(10deg); } 45% { transform:rotate(-8deg); } 60% { transform:rotate(6deg); } 80% { transform:rotate(-2deg); } 100% { transform:rotate(0); } }
	.zc-npanel { position:fixed; z-index:1250; width:min(332px, calc(100vw - 24px)); border:1px solid var(--color-border, #1F1F1F); border-radius:16px; background:color-mix(in srgb, var(--color-popover, #0E0E0E) 96%, transparent); -webkit-backdrop-filter:blur(20px); backdrop-filter:blur(20px); box-shadow:var(--shadow-popover, 0 16px 40px rgba(0,0,0,.6)); overflow:hidden; opacity:0; transform:translateY(6px) scale(.97); pointer-events:none; transition:opacity .16s ease, transform .16s ease; }
	.zc-npanel.zc-open { opacity:1; transform:none; pointer-events:auto; }
	.zc-nhead { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-bottom:1px solid var(--color-border, #1F1F1F); background:var(--color-panel, #141414); }
	.zc-nhead-title { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; color:var(--color-foreground, #FAFAFA); }
	.zc-nnew { padding:2px 6px; border-radius:999px; border:1px solid color-mix(in srgb, #f43f5e 24%, transparent); background:color-mix(in srgb, #f43f5e 12%, transparent); color:#fb7185; font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:10px; font-weight:400; }
	.zc-nhead-btns { display:flex; align-items:center; gap:2px; }
	.zc-nbtn { display:inline-flex; align-items:center; gap:4px; padding:4px 6px; border:0; border-radius:8px; background:none; color:var(--color-foreground-subtle, #525252); font:inherit; font-size:10px; cursor:pointer; }
	.zc-nbtn:hover { color:var(--color-foreground, #fff); background:var(--color-hover, rgba(255,255,255,.06)); }
	.zc-nprefs { padding:12px; border-bottom:1px solid var(--color-border); }
	.zc-nmute { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:0; border:0; background:transparent; color:var(--color-foreground); text-align:left; font:inherit; cursor:pointer; }
	.zc-nmute:focus-visible { outline:2px solid var(--accent); outline-offset:5px; border-radius:4px; }
	.zc-nmute + .zc-nmute { margin-top:12px; padding-top:12px; border-top:1px solid var(--color-border); }
	.zc-npref-text { min-width:0; }
	.zc-npref-text b { display:block; font-size:12px; font-weight:600; }
	.zc-npref-text small { display:block; margin-top:4px; font-size:10px; color:var(--color-foreground-muted); line-height:1.45; }
	.zc-nstatus { margin-left:5px; font-size:10px; font-style:normal; font-weight:400; color:var(--color-foreground-subtle); }
	.zc-nswitch { position:relative; flex-shrink:0; width:32px; height:18px; border-radius:999px; background:var(--color-border-strong); }
	.zc-nswitch::after { content:''; position:absolute; top:3px; left:3px; width:12px; height:12px; border-radius:50%; background:var(--color-foreground-muted); }
	.zc-nmute[aria-checked="true"] .zc-nswitch { background:var(--accent); }
	.zc-nmute[aria-checked="true"] .zc-nswitch::after { left:17px; background:var(--color-background); }
	.zc-nlist { max-height:320px; overflow-y:auto; overscroll-behavior:contain; }
	.zc-nprojects { display:flex; flex-wrap:wrap; gap:6px; padding:10px 12px; border-bottom:1px solid var(--color-border); background:color-mix(in srgb, var(--color-foreground) 2.5%, transparent); }
	.zc-nprojects[hidden] { display:none; }
	.zc-np-label { display:block; width:100%; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.08em; color:var(--color-foreground-subtle); margin-bottom:2px; }
	.zc-np-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border:1px solid var(--color-border); border-radius:6px; background:var(--color-panel, #141414); color:var(--color-foreground); font:inherit; font-size:11px; cursor:pointer; }
	.zc-np-pill:hover { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 8%, var(--color-panel)); }
	.zc-np-pill small { font-size:9.5px; opacity:.75; font-family:var(--font-mono, monospace); }
	.zc-np-pill.zc-np-waiting { border-color:rgba(245,158,11,.4); background:rgba(245,158,11,.1); color:#f59e0b; }
	.zc-np-pill.zc-np-working { border-color:rgba(16,185,129,.3); background:rgba(16,185,129,.08); color:#10b981; }
	.zc-nitem { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; }
	.zc-nitem + .zc-nitem { border-top:1px solid var(--color-border, #1F1F1F); }
	.zc-nitem:hover { background:color-mix(in srgb, var(--color-foreground) 3%, transparent); }
	.zc-nitem.zc-clickable { cursor:pointer; }
	.zc-nitem.zc-clickable:hover { background:color-mix(in srgb, var(--color-foreground) 6%, transparent); }
	.zc-nitem.zc-clickable:hover .zc-nmsg { color:var(--color-foreground, #fff); }
	.zc-nitem.zc-unread { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); }
	.zc-ndot { flex-shrink:0; width:8px; height:8px; margin-top:5px; border-radius:50%; }
	.zc-unread .zc-ndot { background:#f43f5e; }
	.zc-nitem.zc-kind-waiting .zc-ndot { background:#f59e0b; }
	.zc-nitem.zc-kind-done .zc-ndot { background:#10b981; }
	.zc-nitem.zc-kind-crash .zc-ndot { background:#f43f5e; }
	.zc-ntag { display:inline-block; vertical-align:middle; margin-right:4px; padding:1px 5px; border-radius:4px; font-size:10px; font-weight:600; font-family:var(--font-mono, monospace); background:color-mix(in srgb, var(--color-foreground) 8%, transparent); color:var(--color-foreground-muted); }
	.zc-nbody { flex:1; min-width:0; }
	.zc-nmsg { margin:0; font-size:12px; line-height:1.45; color:var(--color-foreground-muted, #A1A1A1); overflow-wrap:anywhere; }
	.zc-unread .zc-nmsg { color:var(--color-foreground, #FAFAFA); font-weight:500; }
	.zc-ntime { display:block; margin-top:2px; font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:10px; color:var(--color-foreground-subtle, #6B6B6B); }
	.zc-nempty { padding:32px 16px; text-align:center; font-size:12px; color:var(--color-foreground-subtle, #6B6B6B); }
	.zc-nempty svg { display:block; width:20px; height:20px; margin:0 auto 8px; }
	.zc-nempty p { margin:0; }
	/* Notification Stack: items as cards that rise in one after another, unread ones raised, status dots with a soft halo. */
	.zc-nlist { display:grid; gap:4px; padding:6px; }
	.zc-nitem { border-radius:10px; animation:zc-nin 360ms cubic-bezier(0.22, 1, 0.36, 1) both; transition:background-color 120ms ease, box-shadow 160ms ease; }
	.zc-nitem + .zc-nitem { border-top:0; }
	.zc-nitem:nth-child(2) { animation-delay:40ms; } .zc-nitem:nth-child(3) { animation-delay:80ms; } .zc-nitem:nth-child(4) { animation-delay:120ms; } .zc-nitem:nth-child(n+5) { animation-delay:160ms; }
	.zc-nitem.zc-unread { background:var(--color-card, #1c1c1e); box-shadow:0 0 0 0.5px color-mix(in srgb, var(--color-foreground) 12%, transparent), 0 1px 2px rgba(0,0,0,.25); }
	.zc-ndot { box-shadow:0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); }
	.zc-nitem.zc-kind-waiting .zc-ndot { box-shadow:0 0 0 3px rgba(245,158,11,.16); }
	.zc-nitem.zc-kind-done .zc-ndot { box-shadow:0 0 0 3px rgba(16,185,129,.16); }
	.zc-nitem.zc-kind-crash .zc-ndot, .zc-unread .zc-ndot { box-shadow:0 0 0 3px rgba(244,63,94,.16); }
	.zc-nmsg { font-size:12.5px; line-height:18px; }
	.zc-ntime { margin-top:3px; font-family:inherit; font-size:11px; font-variant-numeric:tabular-nums; }
	.zc-ntag { border-radius:5px; font-family:inherit; font-weight:500; }
	@keyframes zc-nin { from { opacity:0; transform:translateY(6px) scale(0.98); } }
	@media (prefers-reduced-motion: reduce) { .zc-nitem { animation:none; } }
	@media (prefers-reduced-motion: reduce) { .zc-nbadge, .zc-shake, .zc-unread .zc-ndot { animation:none; } .zc-npanel { transition:none; } }

	/*
	 * Projects, classic and quiet (Claude Code / Codex): a plain "New project" row, a soft
	 * search field, folders as simple rows with their chats indented beneath — no tiles,
	 * cards or guide lines. A running chat keeps its orb card (engine/media/chat.css).
	 */
	body.desktop #sidebar .zc-side-new { justify-content:flex-start; gap:10px; min-height:34px; margin:12px 10px 6px; padding:0 10px; border:0; border-radius:8px; background:transparent; color:var(--color-foreground); font-size:13px; font-weight:500; box-shadow:none; }
	body.desktop #sidebar .zc-side-new:hover { filter:none; background:color-mix(in srgb, var(--color-foreground) 6%, transparent); }
	body.desktop #sidebar .zc-side-new svg { width:15px; height:15px; color:var(--color-foreground-muted); }
	body.desktop #sidebar .ps-box { height:32px; width:calc(100% - 20px); margin:0 10px 14px; padding:0 10px; border:0; border-radius:8px; background:color-mix(in srgb, var(--color-foreground) 4.5%, transparent); }
	body.desktop #sidebar .ps-box:focus-within { background:transparent; box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 16%, transparent); }
	body.desktop #sidebar .ps-kbd { border:0; background:transparent; opacity:.6; }
	body.desktop #sidebar .project-panel-controls { margin:0 18px 4px; }
	body.desktop #sidebar .project-panel-controls::before { content:'Projects'; font-size:11.5px; font-weight:500; letter-spacing:0; color:var(--color-foreground-subtle, #71717a); }
	body.desktop #sidebar-content { padding:0 10px 20px; }
	body.desktop #sidebar details.project-group, body.desktop #sidebar details.project-group.zc-current-project { margin:0 0 2px; padding:0; border:0; border-radius:0; background:transparent; }
	body.desktop #sidebar details.project-group summary, body.desktop #sidebar .zc-current-project > summary { min-height:32px; padding:5px 8px; gap:9px; border:0; border-radius:8px; background:transparent; box-shadow:none; color:var(--color-foreground-muted); }
	body.desktop #sidebar details.project-group summary:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .zc-current-project > summary { color:var(--color-foreground); }
	body.desktop #sidebar .project-folder-icon, body.desktop #sidebar .zc-current-project .project-folder-icon { width:16px; height:16px; border-radius:0; background:none; box-shadow:none; color:var(--color-foreground-subtle, #71717a); }
	body.desktop #sidebar .project-folder-icon svg { width:15px; height:15px; }
	body.desktop #sidebar .zc-current-project .project-folder-icon { color:var(--color-foreground-muted); }
	body.desktop #sidebar .project-name { font-size:13px; font-weight:500; letter-spacing:-.005em; }
	#sidebar .zc-fold-chev { display:inline-flex; flex-shrink:0; width:16px; height:16px; align-items:center; justify-content:center; color:var(--color-foreground-subtle, #71717a); opacity:0; transform:rotate(-90deg); transition:transform .24s cubic-bezier(.33,1,.68,1), opacity .16s; }
	#sidebar .zc-fold-chev svg { width:12px; height:12px; }
	#sidebar details[open] > summary .zc-fold-chev { transform:none; }
	#sidebar summary:hover .zc-fold-chev, #sidebar summary:focus-visible .zc-fold-chev { opacity:1; }
	body.desktop #sidebar .project-tools { opacity:0; transition:opacity .16s; }
	body.desktop #sidebar summary:hover .project-tools, body.desktop #sidebar summary:focus-within .project-tools { opacity:1; }
	body.desktop #sidebar .project-tools :is(.icon-btn, .zc-delete-project) { width:22px; height:22px; border-radius:6px; }
	body.desktop #sidebar .project-chats { margin:1px 0 8px; padding:0 0 0 17px; border-left:0; }
	body.desktop #sidebar .project-chat { min-height:32px; margin:1px 0; border-radius:8px; color:var(--color-foreground-muted); background:transparent; box-shadow:none; }
	body.desktop #sidebar .project-chat-open { padding:6px 8px 6px 9px; gap:9px; }
	body.desktop #sidebar .project-chat-glyph { opacity:0; width:0; margin-right:-9px; overflow:hidden; transition:opacity .15s; }
	body.desktop #sidebar .project-chat:is([data-activity="running"], [data-activity="waiting"], [data-activity="failed"], .zc-working, .zc-pinned) .project-chat-glyph { opacity:1; width:auto; margin-right:0; }
	body.desktop #sidebar .project-chat-title { font-size:13px; font-weight:400; }
	body.desktop #sidebar .project-chat:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .project-chat.selected { background:color-mix(in srgb, var(--color-foreground) 8%, transparent); color:var(--color-foreground); box-shadow:none; }
	body.desktop #sidebar .project-chat.selected .project-chat-title { font-weight:500; }
	body.desktop #sidebar .project-chat.selected::before { content:none; }
	body.desktop #sidebar .project-chat time { font-size:11px; opacity:.7; }
	body.desktop #sidebar .panel-note { padding:6px 10px; }

	/*
	 * Projects, DeepSeek-quiet: a brand line, one full-width New project button, a soft
	 * search, a Workspaces-style section label, flat folder rows and chat rows with a
	 * selected wash. The footer keeps Settings, Remote, Notch and the bell.
	 */
	body.desktop #sidebar .sidebar-head { min-height:52px; padding:11px 12px; gap:9px; }
	body.desktop #sidebar .zc-side-brand { display:flex; align-items:center; gap:8px; flex:1; min-width:0; }
	body.desktop #sidebar .zc-side-brand .brand-logo { width:22px; height:22px; border-radius:6px; }
	body.desktop #sidebar .zc-side-word { overflow:hidden; color:var(--color-foreground); font-size:13.5px; font-weight:650; letter-spacing:-.015em; line-height:1; white-space:nowrap; }
	body.desktop #sidebar .zc-side-badge { flex-shrink:0; padding:2px 5px; border:1px solid var(--zc-panel-line); border-radius:5px; color:var(--color-foreground-muted); font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size:8px; font-weight:600; letter-spacing:.08em; line-height:1.2; text-transform:uppercase; }
	body.desktop #sidebar .sidebar-title { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
	body.desktop #sidebar .sidebar-head-tools { gap:2px; }
	body.desktop #sidebar .sidebar-head-tools .icon-btn { width:26px; height:26px; border-radius:7px; }

	body.desktop #sidebar .zc-side-new {
		justify-content:flex-start; gap:10px; flex-shrink:0;
		min-height:38px; margin:12px 12px 8px; padding:0 12px;
		border:1px solid var(--zc-panel-line); border-radius:9px;
		background:color-mix(in srgb, var(--color-foreground) 7%, transparent);
		color:var(--color-foreground); font-size:13px; font-weight:500;
		box-shadow:inset 0 1px 0 color-mix(in srgb, #ffffff 4%, transparent);
		transition:background .15s, border-color .15s, transform .12s;
	}
	body.desktop #sidebar .zc-side-new:hover { background:color-mix(in srgb, var(--color-foreground) 10%, transparent); border-color:color-mix(in srgb, var(--color-foreground) 18%, transparent); filter:none; }
	body.desktop #sidebar .zc-side-new:active { transform:scale(.99); }
	body.desktop #sidebar .zc-side-new svg { width:15px; height:15px; color:var(--color-foreground-muted); }

	body.desktop #sidebar .ps-box { height:32px; width:calc(100% - 24px); margin:0 12px 10px; padding:0 10px; border:1px solid transparent; border-radius:8px; background:color-mix(in srgb, var(--color-foreground) 4%, transparent); }
	body.desktop #sidebar .ps-box:focus-within { background:transparent; box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 16%, transparent); }
	body.desktop #sidebar .ps-icon { width:14px; height:14px; }
	body.desktop #sidebar .project-search { font-size:12.5px; }
	body.desktop #sidebar .ps-kbd { opacity:.5; font-size:9px; }

	body.desktop #sidebar .project-panel-controls { display:flex; align-items:center; justify-content:space-between; gap:6px; min-height:22px; margin:2px 14px; padding:0; }
	body.desktop #sidebar .project-panel-controls::before { content:'Projects'; flex:1; font-size:11px; font-weight:600; letter-spacing:.01em; color:var(--color-foreground-muted); }
	body.desktop #sidebar .project-panel-views { display:none; }
	body.desktop #sidebar .project-command { display:flex; align-items:center; justify-content:center; width:22px; height:22px; border:0; border-radius:6px; color:var(--color-foreground-muted); }
	body.desktop #sidebar .project-command:hover { background:color-mix(in srgb, var(--color-foreground) 7%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .project-command svg { width:14px; height:14px; }
	body.desktop #sidebar .project-order-status { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }

	body.desktop #sidebar-content { padding:0 8px 16px; }
	body.desktop #sidebar details.project-group, body.desktop #sidebar details.project-group.zc-current-project { margin:0 0 1px; padding:0; border:0; border-radius:0; background:transparent; }
	body.desktop #sidebar details.project-group summary, body.desktop #sidebar .zc-current-project > summary { min-height:32px; padding:5px 8px; gap:9px; border:0; border-radius:8px; background:transparent; box-shadow:none; color:var(--color-foreground-muted); }
	body.desktop #sidebar details.project-group summary:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .zc-current-project > summary { background:transparent; border-color:transparent; color:var(--color-foreground); }
	body.desktop #sidebar .project-folder-icon, body.desktop #sidebar .zc-current-project .project-folder-icon { width:16px; height:16px; border-radius:0; background:none; box-shadow:none; color:var(--color-foreground-subtle, #71717a); }
	body.desktop #sidebar .zc-current-project .project-folder-icon { color:var(--color-foreground-muted); }
	body.desktop #sidebar .project-folder-icon svg { width:15px; height:15px; }
	body.desktop #sidebar .project-name { font-size:13px; font-weight:500; letter-spacing:-.005em; }
	body.desktop #sidebar .zc-current-project .project-name { color:var(--color-foreground); }
	body.desktop #sidebar .project-tools { gap:0; opacity:0; transition:opacity .16s; }
	body.desktop #sidebar summary:hover .project-tools, body.desktop #sidebar summary:focus-within .project-tools { opacity:1; }
	body.desktop #sidebar .project-tools :is(.icon-btn, .zc-delete-project) { width:22px; height:22px; border-radius:6px; }

	body.desktop #sidebar .project-chats { margin:1px 0 6px; padding:0 0 0 22px; border-left:1px solid color-mix(in srgb, var(--color-foreground) 6%, transparent); }
	body.desktop #sidebar .project-chat { min-height:30px; margin:1px 0; border-radius:7px; color:var(--color-foreground-muted); background:transparent; box-shadow:none; }
	body.desktop #sidebar .project-chat-open { padding:6px 8px; gap:7px; }
	body.desktop #sidebar .project-chat-glyph { display:inline-flex; width:14px; height:14px; margin-right:0; overflow:visible; opacity:.55; }
	body.desktop #sidebar .project-chat:is([data-activity="running"], [data-activity="waiting"], [data-activity="failed"], .zc-working, .zc-pinned) .project-chat-glyph { opacity:1; }
	body.desktop #sidebar .project-chat-title { font-size:12.5px; font-weight:400; }
	body.desktop #sidebar .project-chat:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .project-chat.selected { background:color-mix(in srgb, var(--color-foreground) 7%, transparent); color:var(--color-foreground); box-shadow:none; }
	body.desktop #sidebar .project-chat.selected .project-chat-title { font-weight:500; }
	body.desktop #sidebar .project-chat.selected::before { content:none; }
	body.desktop #sidebar .project-chat[data-activity="running"].selected .project-chat-open,
	body.desktop #sidebar .project-chat.zc-working.selected .project-chat-open { box-shadow:0 0 24px -10px color-mix(in srgb, var(--accent) 55%, transparent); }
	body.desktop #sidebar .project-chat:focus-visible { outline:none; box-shadow:none; }
	body.desktop #sidebar .project-chat-open:focus-visible { outline:none; box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 14%, transparent); }
	body.desktop #sidebar .project-chat time { font-size:10.5px; opacity:.6; }
	body.desktop #sidebar .project-chat .project-more { width:22px; height:22px; border-radius:6px; opacity:0; }
	body.desktop #sidebar .project-chat:hover .project-more, body.desktop #sidebar .project-chat:focus-within .project-more { opacity:1; }
	body.desktop #sidebar .project-chat-state { color:var(--accent-strong); font-size:10.5px; }
	body.desktop #sidebar .project-chat .project-chat-project { display:none; }

	body.desktop #sidebar .zc-side-foot { padding:8px 10px 10px; gap:3px; border-top:1px solid var(--zc-panel-line); background:transparent; }
	body.desktop #sidebar .zc-side-foot button { min-height:32px; padding:6px 8px; border-radius:7px; font-size:12px; color:var(--color-foreground-muted); }
	body.desktop #sidebar .zc-side-foot button:hover { background:color-mix(in srgb, var(--color-foreground) 6%, transparent); color:var(--color-foreground); }
	body.desktop #sidebar .zc-side-foot button.zc-icon-btn { width:32px; height:32px; }

	/*
	 * Work Details: a quiet header, a segmented tab bar (icons; the open tab shows its name,
	 * the rest name themselves on hover), soft empty states and hairline cards.
	 */
	body.desktop #auxiliary .auxiliary-head { min-height:46px; padding:8px 10px 8px 16px; border-bottom:0; }
	body.desktop #auxiliary .auxiliary-title { font-size:13px; font-weight:600; letter-spacing:-.01em; }
	body.desktop #auxiliary .auxiliary-head-tools .icon-btn { width:28px; height:28px; border:0; border-radius:8px; color:var(--color-foreground-subtle); }
	body.desktop #auxiliary .auxiliary-head-tools .icon-btn:hover { background:color-mix(in srgb, var(--color-foreground) 7%, transparent); color:var(--color-foreground); }
	body.desktop #auxiliary .auxiliary-tabs { display:flex; flex-wrap:nowrap; gap:2px; margin:0 12px 4px; padding:3px; overflow-x:auto; scrollbar-width:none; border:0; border-radius:11px; background:color-mix(in srgb, var(--color-foreground) 5%, transparent); box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 6%, transparent); }
	body.desktop #auxiliary .auxiliary-tab { position:relative; flex:1 1 0; justify-content:center; gap:0; min-width:30px; height:30px; padding:0 6px; border:0; border-radius:8px; background:transparent; color:var(--color-foreground-subtle); font-size:0; font-weight:500; transition:flex-grow .3s cubic-bezier(.16,1,.3,1), background .15s, color .15s; }
	body.desktop #auxiliary .auxiliary-tab .i { width:15px; height:15px; opacity:1; color:inherit; }
	body.desktop #auxiliary .auxiliary-tab:hover { color:var(--color-foreground); background:color-mix(in srgb, var(--color-foreground) 6%, transparent); }
	body.desktop #auxiliary .auxiliary-tab.active { flex-grow:2.6; gap:6px; padding:0 10px; font-size:12px; color:var(--color-foreground); background:var(--color-panel, var(--color-background)); box-shadow:0 1px 2px rgba(0,0,0,.18), inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 9%, transparent); }
	body.desktop #auxiliary .auxiliary-tab.active .i { color:var(--color-foreground); }
	body.desktop #auxiliary .auxiliary-tab .aux-count { position:absolute; top:2px; right:2px; min-width:14px; height:14px; padding:0 3px; border-radius:7px; font-size:9px; line-height:14px; background:var(--accent); color:var(--color-background); }
	body.desktop #auxiliary .auxiliary-tab.active .aux-count { position:static; background:color-mix(in srgb, var(--color-foreground) 12%, transparent); color:var(--color-foreground-muted); }
	body.desktop #auxiliary .aux-panel { padding:14px 14px 18px; }
	body.desktop #auxiliary .aux-search { height:34px; border:0; border-radius:9px; background:color-mix(in srgb, var(--color-foreground) 5%, transparent); }
	body.desktop #auxiliary .aux-search:focus-within { background:transparent; box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 18%, transparent); }
	body.desktop #auxiliary .aux-legend { padding:8px 4px 10px; font-size:10.5px; color:var(--color-foreground-subtle); }
	body.desktop #auxiliary .aux-tree .fs-row { height:30px; border-radius:7px; font-size:12.5px; }
	body.desktop #auxiliary .aux-tree .fs-row:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); }
	body.desktop #auxiliary .aux-item, body.desktop #auxiliary .sag-card { padding:12px; border:1px solid color-mix(in srgb, var(--color-foreground) 8%, transparent); border-radius:12px; background:color-mix(in srgb, var(--color-foreground) 2.5%, transparent); box-shadow:none; transition:background .15s, border-color .15s; }
	body.desktop #auxiliary .aux-item:hover, body.desktop #auxiliary .sag-card:hover { background:color-mix(in srgb, var(--color-foreground) 5%, transparent); border-color:color-mix(in srgb, var(--color-foreground) 14%, transparent); }
	body.desktop #auxiliary .aux-ico { border-radius:9px; background:color-mix(in srgb, var(--color-foreground) 6%, transparent); color:var(--color-foreground-muted); }
	body.desktop #auxiliary .aux-section { margin:16px 2px 8px; font-size:11px; font-weight:500; letter-spacing:0; text-transform:none; color:var(--color-foreground-subtle); }
	body.desktop #auxiliary .aux-empty { margin:8px 0; padding:36px 20px; border:0; border-radius:14px; background:color-mix(in srgb, var(--color-foreground) 3%, transparent); }
	body.desktop #auxiliary .aux-empty-ico { width:40px; height:40px; border-radius:12px; background:color-mix(in srgb, var(--color-foreground) 7%, transparent); color:var(--color-foreground-muted); }
	body.desktop #auxiliary .aux-btn { border-radius:8px; }
	body.desktop #auxiliary .term-head { min-height:38px; padding:0 8px 0 12px; border-bottom:1px solid color-mix(in srgb, var(--color-foreground) 7%, transparent); }
	body.desktop #auxiliary .term-in { border:0; border-radius:10px; background:color-mix(in srgb, var(--color-foreground) 5%, transparent); }
	`;

	/** The engine page's CSP forbids inline <style>; a constructed stylesheet is allowed. */
	function addStyle() {
		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(CSS);
			document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		} catch {
			const s = document.createElement('style');
			s.textContent = CSS;
			document.head.appendChild(s);
		}
	}

	// Defined at injection time, so the shell can call it the moment a switch starts
	// (before the page's own scripts are up): "Opening P2P Agent…" while the project's
	// engine boots behind the current screen.
	window.__zcNote = (text) => {
		let n = document.getElementById('zc-note');
		if (!n) {
			n = document.createElement('div');
			n.id = 'zc-note';
			n.className = 'zc-note';
			n.setAttribute('role', 'status');
			(document.body || document.documentElement).appendChild(n);
		}
			n.textContent = String(text || '');
		n.classList.add('zc-show');
		clearTimeout(window.__zcNoteTimer);
		window.__zcNoteTimer = setTimeout(() => n.classList.remove('zc-show'), 4000);
	};

	// ------ the bell's feed: pushed by the shell; polled to catch up (notify_feed)
	window.__zcFeed = (list) => {
		if (!Array.isArray(list)) return;
		nfeed.list = list.filter((n) => n && typeof n.message === 'string');
		nfeed.paint();
	};

	function controls() {
		const box = document.createElement('div');
		box.className = 'zc-win';
		box.innerHTML =
			'<button class="zc-min" title="Minimize" aria-label="Minimize">' + ICON.min + '</button>' +
			'<button class="zc-max" title="Maximize" aria-label="Maximize">' + ICON.max + '</button>' +
			'<button class="zc-close" title="Close" aria-label="Close">' + ICON.close + '</button>';
		box.querySelector('.zc-min').onclick = () => win('minimize');
		box.querySelector('.zc-max').onclick = () => win('toggle_maximize');
		box.querySelector('.zc-close').onclick = () => win('close');
		const sync = () =>
			win('is_maximized').then((max) => {
				const b = box.querySelector('.zc-max');
				const full = document.body.classList.contains('zc-native-fullscreen');
				b.innerHTML = full || max ? ICON.restore : ICON.max;
				b.title = full ? 'Exit full screen' : max ? 'Restore' : 'Maximize';
				b.setAttribute('aria-label', b.title);
			});
		window.addEventListener('resize', sync);
		window.addEventListener('zc-fullscreen-change', sync);
		sync();
		return box;
	}

	/** Drag the window from empty parts of a bar; double-click maximizes (native drag region, CSS above). */
	function draggable(bar) {
		bar.classList.add('zc-drag');
		bar.addEventListener('dblclick', event => {
			if (event.defaultPrevented || event.button !== 0 || event.target.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable="true"], .zc-win')) return;
			event.preventDefault();
			void win('toggle_maximize');
		});
	}

	function frame() {
		const topbar = document.querySelector('.topbar');
		if (topbar) {
			topbar.appendChild(controls());
			draggable(topbar);
		} else {
			// The start page: a thin invisible bar with the controls.
			const bar = document.createElement('div');
			bar.className = 'zc-titlebar';
			bar.appendChild(controls());
			document.body.appendChild(bar);
			draggable(bar);
		}
	}

	// ------------------------------------------------------------ sidebar

	const post = (m) => window.Bridge && window.Bridge.post(m);

	function createProject() {
		const existing = document.querySelector('.zc-project-dialog');
		if (existing) { existing.focus(); return; }
		const previous = document.activeElement;
		const dialog = document.createElement('dialog');
		dialog.className = 'zc-project-dialog';
		dialog.setAttribute('aria-labelledby', 'zc-create-title');
		dialog.innerHTML = '<form><h2 id="zc-create-title">Create project</h2>' +
			'<button type="button" class="zc-project-close" aria-label="Close create project">' + ICON.x + '</button>' +
			'<label for="zc-project-name">Project name</label><input id="zc-project-name" placeholder="New project" maxlength="100" required autocomplete="off">' +
			'<div class="zc-project-label">Device</div><div class="zc-project-device">' + ICON.computer + 'This computer</div>' +
			'<div class="zc-project-label">Source folder</div><button type="button" class="zc-project-choose"><span class="zc-project-folder-icon">' + ICON.folderPlus + '</span><b>Choose folder</b><small>zer0ne Code can read and edit this folder</small></button>' +
			'<p class="zc-project-error" role="alert" hidden></p><div class="zc-project-actions"><button type="button" class="zc-project-cancel">Cancel</button><button type="submit" class="zc-project-primary" disabled>Create project</button></div></form>';
		const name = dialog.querySelector('input'), choose = dialog.querySelector('.zc-project-choose'), submit = dialog.querySelector('[type="submit"]'), error = dialog.querySelector('.zc-project-error');
		let selected = null, picking = false, trust = null, creating = false;
		const showError = e => { error.textContent = e.message || String(e); error.hidden = false; };
		const update = () => { submit.disabled = picking || !selected || !name.value.trim(); };
		const close = () => { if (creating) return; trust?.close(); dialog.close(); };
		dialog.addEventListener('close', () => { trust?.remove(); dialog.remove(); previous?.focus({ preventScroll: true }); });
		dialog.addEventListener('cancel', e => { if (creating) e.preventDefault(); });
		dialog.addEventListener('keydown', e => e.stopPropagation());
		dialog.querySelector('.zc-project-close').onclick = close;
		dialog.querySelector('.zc-project-cancel').onclick = close;
		name.addEventListener('input', update);
		choose.onclick = async () => {
			if (picking) return;
			picking = true; choose.disabled = true; error.hidden = true; update();
			try {
				const picked = await bridge().invoke('pick_project_folder', {});
				if (!dialog.isConnected || !picked) return;
				selected = picked;
				choose.querySelector('b').textContent = picked.name;
				choose.querySelector('small').textContent = picked.path;
				choose.setAttribute('aria-label', 'Change source folder: ' + picked.path);
				if (!name.value.trim()) name.value = picked.name.slice(0, 100);
			} catch (e) { showError(e); }
			finally { picking = false; choose.disabled = false; update(); }
		};
		dialog.querySelector('form').onsubmit = e => {
			e.preventDefault();
			if (submit.disabled || trust || !name.reportValidity()) return;
			error.hidden = true;
			trust = document.createElement('dialog'); trust.className = 'zc-project-dialog zc-project-trust';
			trust.setAttribute('aria-labelledby', 'zc-trust-title'); trust.setAttribute('aria-describedby', 'zc-trust-detail');
			trust.innerHTML = '<h2 id="zc-trust-title">Trust this folder?</h2><button type="button" class="zc-project-close" aria-label="Close trust confirmation">' + ICON.x + '</button><p>This computer</p><code></code><p id="zc-trust-detail">zer0ne Code can read and edit files in this folder and run commands within your current permission settings. Continue only if you trust this folder.</p><p class="zc-project-error" role="alert" hidden></p><div class="zc-project-actions"><button type="button" class="zc-project-cancel" autofocus>Cancel</button><button type="button" class="zc-project-primary">Trust folder and create</button></div>';
			trust.querySelector('code').textContent = selected.path;
			const confirmation = trust;
			trust.addEventListener('close', () => { confirmation.remove(); trust = null; submit.focus(); });
			trust.addEventListener('cancel', event => { if (creating) event.preventDefault(); });
			trust.addEventListener('keydown', event => event.stopPropagation());
			for (const button of trust.querySelectorAll('.zc-project-close, .zc-project-cancel')) button.onclick = () => { if (!creating) confirmation.close(); };
			trust.querySelector('.zc-project-primary').onclick = async () => {
				if (creating) return;
				creating = true;
				for (const button of confirmation.querySelectorAll('button')) button.disabled = true;
				try {
					await window.Bridge?.flushState?.();
					await bridge().invoke('create_project', { selection: selected.selection, name: name.value.trim(), trusted: true });
					creating = false; close();
				} catch (failure) {
					creating = false; confirmation.close(); selected = null; update(); showError(failure); choose.focus();
				}
			};
			document.body.appendChild(trust); trust.showModal();
		};
		document.body.appendChild(dialog); dialog.showModal(); name.focus();
	}
	window.__zcCreateProject = createProject;

	/**
	 * Two-step confirm: the first click arms the action, a second click within 4 s does it.
	 * The armed state is kept here, not in the DOM — the sidebar re-renders whenever its data changes.
	 */
	const armed = { key: '', until: 0, timer: 0 };
	function confirmClick(key, act) {
		if (armed.key === key && Date.now() < armed.until) {
			armed.key = '';
			act();
			return;
		}
		armed.key = key;
		armed.until = Date.now() + 4000;
		clearTimeout(armed.timer);
		armed.timer = setTimeout(() => {
			armed.key = '';
			restyle();
		}, 4000);
		restyle();
	}
	function restyle() {
		for (const el of document.querySelectorAll('.zc-act')) {
			const on = el.dataset.key === armed.key && Date.now() < armed.until;
			if (on === el.classList.contains('zc-armed')) continue;
			el.classList.toggle('zc-armed', on);
			el.innerHTML = on ? (el.classList.contains('zc-del') ? 'Delete' : 'Remove') : el.classList.contains('zc-del') ? ICON.trash : ICON.remove;
		}
	}

	function action(cls, key, title, icon) {
		// <i>, not <span>: the extension styles every span inside a chat row as its title.
		const el = document.createElement('i');
		el.className = 'zc-act ' + cls;
		el.setAttribute('role', 'button');
		el.tabIndex = 0;
		el.title = title;
		el.setAttribute('aria-label', title);
		el.dataset.key = key;
		el.innerHTML = icon;
		return el;
	}

	const projectFolds = new Map();
	let projectScroll = null;
	let panelSaveTimer;
	let panelSignature = '';
	function saveProjectPanel() {
		clearTimeout(panelSaveTimer);
		const content = document.getElementById('sidebar-content');
		if (!content || document.hidden) return;
		const panel = { scroll: content.scrollTop || 0, folds: Object.fromEntries(projectFolds) };
		const signature = JSON.stringify(panel);
		if (signature === panelSignature) return;
		panelSignature = signature;
		post({ type: 'zcDesktopPrefs', prefs: { panel } });
	}
	function restoreProjectPanel(panel) {
		const signature = JSON.stringify(panel);
		if (signature === panelSignature) return;
		panelSignature = signature;
		projectFolds.clear();
		for (const [key, open] of Object.entries(panel.folds || {})) projectFolds.set(key, open);
		projectScroll = panel.scroll || 0;
		const content = document.getElementById('sidebar-content');
		if (!content) return;
		content.classList.toggle('zc-panel-restoring', true);
		for (const group of content.querySelectorAll('.project-group')) {
			const name = group.querySelector('.project-name');
			const key = group.dataset.panelKey || name && (name.getAttribute('title') || name.textContent);
			if (projectFolds.has(key)) group.open = projectFolds.get(key);
		}
		content.scrollTop = projectScroll;
		requestAnimationFrame(() => content.classList.toggle('zc-panel-restoring', false));
	}

	// The pin icon as this page serializes it: pinned chats keep their icon, the rest drop theirs.
	let pinSvg = null;
	function pinMarkup() {
		if (pinSvg === null && window.Icons) {
			const t = document.createElement('template');
			t.innerHTML = window.Icons.svg('pin');
			pinSvg = t.content.firstElementChild ? t.content.firstElementChild.outerHTML : '';
		}
		return pinSvg;
	}

	function decorate(content, scroll) {
		if (scroll !== undefined || projectScroll !== null) content.classList.toggle('zc-panel-restoring', true);
		for (const group of content.querySelectorAll('.project-group:not([data-zc-fold])')) {
			group.dataset.zcFold = '1';
			const row = group.querySelector('.project-row');
			const name = row && row.querySelector('.project-name');
			const key = group.dataset.panelKey || name && (name.getAttribute('title') || name.textContent);
			const chats = document.createElement('div');
			chats.className = 'project-chats';
			for (const child of [...group.children]) if (child !== row) chats.appendChild(child);
			group.appendChild(chats);
			const current = row && row.querySelector('.project-badge');
			group.classList.toggle('zc-current-project', !!current);
			if (name) {
				const title = document.createElement('span');
				title.className = 'zc-project-title';
				title.textContent = name.textContent;
				name.textContent = '';
				name.appendChild(title);
			}
			group.open = projectFolds.has(key) ? projectFolds.get(key) : group.dataset.defaultOpen === 'true' || !!(row && row.querySelector('.project-badge'));
			projectFolds.set(key, group.open);
			group.addEventListener('toggle', () => {
				if (projectFolds.get(key) === group.open) return;
				projectFolds.set(key, group.open);
				saveProjectPanel();
			});
		}
		for (const chat of content.querySelectorAll('.project-chat:not([data-zc])')) {
			chat.dataset.zc = '1';
			const icon = chat.querySelector(':scope > svg');
			if (icon && icon.outerHTML === pinMarkup()) chat.classList.add('zc-pinned');
			if (chat.dataset.projectChat) chat.appendChild(action('zc-del', 'chat:' + chat.dataset.projectChat, 'Delete chat', ICON.trash));
		}
		for (const row of content.querySelectorAll('.project-row:not([data-zc])')) {
			row.dataset.zc = '1';
			row.appendChild(Object.assign(document.createElement('span'), { className: 'zc-fold-chev', innerHTML: ICON.chevDown }));
		}
		paintBusy(content);
		const position = projectScroll !== null ? projectScroll : scroll;
		if (position !== undefined && position !== null) {
			content.scrollTop = position;
			projectScroll = null;
			requestAnimationFrame(() => content.classList.toggle('zc-panel-restoring', false));
		}
		restyle();
		window.__zcUpdateProjectHaze?.();
	}

	// ------ which projects are still working (the shell knows; engines run per project)

	/** path (as in the row titles) → { busy, sessionId } — filled by the status poll. */
	const busyByPath = new Map();
	/** Path spellings differ slightly between the engine and the shell; compare loosely. */
	const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	const isBusyPath = (p) => busyByPath.has(normPath(p));

	/** One status round: ask the shell which projects have a run in flight, then paint. */
	let busySignature = '';
	let projectsRefreshedAt = 0;
	let busyPollPending = false;
	function pollBusy() {
		if (!bridge() || busyPollPending) return;
		busyPollPending = true;
		bridge()
			.invoke('host_status')
			.then((rows) => {
				busyByPath.clear();
				for (const r of Array.isArray(rows) ? rows : []) {
					if (r && r.busy && r.path) busyByPath.set(normPath(r.path), r);
				}
				window.__zcBusySessionIds = new Set([...busyByPath.values()].map(r => r.sessionId).filter(Boolean));
				window.__zcProjectActivity = new Map([...busyByPath.values()].filter(r => r.sessionId).map(r => [r.sessionId, r.activity === 'waiting' ? 'waiting' : 'running']));
				const signature = [...busyByPath].map(([path, r]) => path + ':' + (r.sessionId || '') + ':' + (r.activity || 'running')).sort().join('|');
				if (signature !== busySignature) window.__zcRefreshProjects?.();
				if (signature !== busySignature || (!document.hidden && Date.now() - projectsRefreshedAt >= 6000)) {
					busySignature = signature;
					projectsRefreshedAt = Date.now();
					post({ type: 'getProjects' });
				}
				paintBusy(document.getElementById('sidebar-content'));
			})
			.catch(() => undefined)
			.finally(() => { busyPollPending = false; });
		// The bell's feed: pushed by the shell when it changes; polled to catch up
		// (a page that was in the background missed the pushes meanwhile).
		bridge().invoke('notify_feed').then((rows) => window.__zcFeed(rows)).catch(() => undefined);
	}

	/** The engine's own "Working" chip on the chat on screen; ours is for the rest. */
	function paintBusy(content) {
		if (!content) return;
		for (const row of content.querySelectorAll('.project-row')) {
			const name = row.querySelector('.project-name');
			const path = name && name.getAttribute('title');
			const hit = isBusyPath(path);
			const group = row.closest('.project-group');
			if (!group) continue;
			// Keep legacy engine rows compatible with the shell's background-run state.
			const session = hit && busyByPath.get(normPath(path));
			for (const chat of group.querySelectorAll('.project-chat')) {
				const mine = session && chat.dataset.projectChat && chat.dataset.projectChat === session.sessionId;
				const waiting = chat.dataset.activity === 'waiting' || (mine && session.activity === 'waiting');
				const working = !waiting && (!!mine || !!chat.querySelector('em.chat-working') || chat.dataset.activity === 'running' || chat.getAttribute('data-activity') === 'running');
				chat.classList.toggle('zc-working', working);
				chat.classList.toggle('zc-waiting', waiting);
				const shown = mine && !chat.querySelector('em.chat-working') && !chat.querySelector('.project-chat-state');
				let chip = chat.querySelector('.zc-busy-chip');
				if (shown && !chip) {
					chip = document.createElement('em');
					chip.className = 'zc-busy-chip' + (waiting ? ' zc-waiting-chip' : '');
					chip.textContent = waiting ? 'Needs input' : 'Working';
					chat.appendChild(chip);
				} else if (shown && chip) {
					chip.className = 'zc-busy-chip' + (waiting ? ' zc-waiting-chip' : '');
					chip.textContent = waiting ? 'Needs input' : 'Working';
				} else if (!shown && chip) {
					chip.remove();
				}
			}
		}
	}

	/** Poll while the page is visible; pauses when hidden or minimized to save CPU and battery. */
	function busyFeed() {
		pollBusy();
		setInterval(() => {
			if (!document.hidden) pollBusy();
		}, 1500);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) pollBusy();
		});
	}

	function sidebar() {
		const side = document.getElementById('sidebar');
		const content = document.getElementById('sidebar-content');
		if (!side || !content) return;
		side.addEventListener('keydown', event => {
			const target = event.target.closest?.('.zc-act');
			if (!target || (event.key !== 'Enter' && event.key !== ' ')) return;
			event.preventDefault(); event.stopPropagation(); target.click();
		});

		const fresh = document.createElement('button');
		fresh.className = 'zc-side-new';
		fresh.title = 'Create a project from a folder';
		fresh.innerHTML = ICON.folderPlus + '<span>New Project</span>';
		fresh.onclick = createProject;
		const head = side.querySelector('.sidebar-head');
		const title = head && head.querySelector('.sidebar-title');
		if (title) title.textContent = 'Projects';
		if (head) {
			const brand = document.createElement('div');
			brand.className = 'zc-side-brand';
			brand.innerHTML = '<span class="zc-side-mark brand-logo" aria-hidden="true"></span><span class="zc-side-word">zer0ne</span><span class="zc-side-badge">code</span>';
			head.insertBefore(brand, title || head.firstChild);
		}
		const search = document.getElementById('project-search');
		if (search) search.placeholder = 'Search projects & chats';
		for (const btn of side.querySelectorAll('.project-panel-views .project-view')) {
			if (btn.dataset.view === 'chats' || (btn.textContent && btn.textContent.trim().toLowerCase().startsWith('chat'))) {
				btn.remove();
			}
		}
		side.insertBefore(fresh, head ? head.nextSibling : side.firstChild);

		const foot = document.createElement('div');
		foot.className = 'zc-side-foot';
		foot.innerHTML =
			'<button class="zc-settings" title="Settings">' + ICON.gear + '<span>Settings</span></button>' +
			'<button class="zc-icon-btn zc-remote" title="Remote" aria-label="Remote">' + ICON.phone + '</button>' +
			'<button class="zc-icon-btn zc-notch" title="AI Dock" aria-label="AI Dock">' + ICON.notch + '</button>' +
			'<button class="zc-icon-btn zc-bell" title="Notifications" aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false"><span class="zc-bicon">' + ICON.bell + '</span><span class="zc-nbadge" hidden></span></button>';
		const settings = (section) => {
			if (window.Settings && window.Settings.open) window.Settings.open(section);
			else {
				const s = document.getElementById('btn-settings');
				if (s) s.click();
				if (section) window.__zcOpenSettingsSection?.(section);
			}
		};
		foot.querySelector('.zc-settings').onclick = () => settings();
		foot.querySelector('.zc-remote').onclick = () => settings('remote');
		foot.querySelector('.zc-notch').onclick = () => settings('notch');
		// Run notifications: the shell keeps the feed (nfeed), the bell shows its
		// unread count and opens the panel above it. The mute button in the panel
		// header toggles the OS ring (the scene's pref, body class); the panel lists
		// everything either way. Quieter: the OS rings only while away.
		const bell = foot.querySelector('.zc-bell');
		const badge = bell.querySelector('.zc-nbadge');
		let panel = null;
		let rendered = '';
		const unreadCount = () => nfeed.list.filter((n) => !n.read).length;
		const ago = (ts) => {
			const s = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
			if (s < 60) return 'just now';
			if (s < 3600) return Math.floor(s / 60) + 'm ago';
			if (s < 86400) return Math.floor(s / 3600) + 'h ago';
			return new Date(ts).toLocaleDateString();
		};
		const shake = () => {
			bell.classList.remove('zc-shake');
			void bell.offsetWidth; // restart the animation when one is still running
			bell.classList.add('zc-shake');
			setTimeout(() => bell.classList.remove('zc-shake'), 600);
		};
		const paintBell = () => {
			const off = document.body.classList.contains('zc-notify-off');
			bell.querySelector('.zc-bicon').innerHTML = off ? ICON.bellOff : ICON.bell;
			const mute = panel && panel.querySelector('.zc-nmute');
			if (mute) {
				mute.setAttribute('aria-checked', String(!off));
				mute.querySelector('.zc-nstatus').textContent = off ? 'Off' : 'On';
				mute.title = off ? 'Turn notifications on' : 'Turn notifications off';
			}
			const notch = panel && panel.querySelector('.zc-nnotch');
			if (notch) {
				notch.setAttribute('aria-checked', String(notchOn));
				notch.querySelector('.zc-nstatus').textContent = notchOn ? 'On' : 'Off';
				notch.title = notchOn ? 'Turn AI Dock off' : 'Turn AI Dock on';
			}
		};
		const renderList = () => {
			if (!panel) return;
			const count = unreadCount();
			const chip = panel.querySelector('.zc-nnew');
			chip.hidden = count === 0;
			chip.textContent = count + ' new';
			panel.querySelector('.zc-nreadall').style.display = count > 0 ? '' : 'none';
			const projBar = panel.querySelector('.zc-nprojects');
			if (projBar) {
				const active = [...busyByPath.values()].filter((r) => r && r.path);
				if (active.length > 0) {
					projBar.hidden = false;
					projBar.innerHTML =
						'<span class="zc-np-label">Active Projects</span>' +
						active
							.map((r) => {
								const name = r.path.split(/[/\\]/).filter(Boolean).pop() || 'project';
								const isWaiting = r.activity === 'waiting';
								const cls = isWaiting ? 'zc-np-pill zc-np-waiting' : 'zc-np-pill zc-np-working';
								const status = isWaiting ? 'Needs input' : 'Working';
								return `<button type="button" class="${cls}" data-path="${r.path}" data-session="${r.sessionId || ''}"><b>${name}</b><small>${status}</small></button>`;
							})
							.join('');
					for (const btn of projBar.querySelectorAll('.zc-np-pill')) {
						btn.onclick = () => {
							post({ type: 'projectOpen', path: btn.dataset.path, sessionId: btn.dataset.session || undefined });
							closePanel();
						};
					}
				} else {
					projBar.hidden = true;
					projBar.innerHTML = '';
				}
			}
			const list = panel.querySelector('.zc-nlist');
			if (!nfeed.list.length) {
				list.innerHTML = '<div class="zc-nempty">' + ICON.bell + '<p>No notifications right now</p></div>';
				return;
			}
			list.innerHTML = '';
			for (const item of nfeed.list) {
				const row = document.createElement('div');
				row.className = 'zc-nitem' + (item.read ? '' : ' zc-unread') + (item.kind ? ' zc-kind-' + item.kind : '') + (item.folder ? ' zc-clickable' : '');
				const dot = document.createElement('span');
				dot.className = 'zc-ndot';
				const body = document.createElement('div');
				body.className = 'zc-nbody';
				const msg = document.createElement('p');
				msg.className = 'zc-nmsg';

				const pName = item.project || (item.folder ? item.folder.split(/[/\\]/).filter(Boolean).pop() : null);
				if (pName && item.message.startsWith(pName + ' — ')) {
					const rest = item.message.slice(pName.length + 3);
					msg.innerHTML = `<span class="zc-ntag">${pName}</span> ${rest}`;
				} else if (pName && item.message.startsWith(pName + ': ')) {
					const rest = item.message.slice(pName.length + 2);
					msg.innerHTML = `<span class="zc-ntag">${pName}</span> ${rest}`;
				} else {
					msg.textContent = item.message;
				}

				const time = document.createElement('span');
				time.className = 'zc-ntime';
				time.textContent = ago(item.ts);
				body.append(msg, time);
				row.append(dot, body);

				if (item.folder) {
					row.title = 'Open ' + (pName || 'chat');
					body.onclick = (e) => {
						e.stopPropagation();
						item.read = true;
						if (bridge()) bridge().invoke('notify_read', { id: item.id }).catch(() => undefined);
						post({ type: 'projectOpen', path: item.folder, sessionId: item.session || undefined });
						closePanel();
						paint();
					};
				}

				if (!item.read) {
					const mark = document.createElement('button');
					mark.type = 'button';
					mark.className = 'zc-nbtn zc-nmark';
					mark.title = 'Mark as read';
					mark.setAttribute('aria-label', 'Mark notification as read');
					mark.innerHTML = ICON.checkCheck;
					mark.onclick = (e) => {
						e.stopPropagation();
						item.read = true;
						if (bridge()) bridge().invoke('notify_read', { id: item.id }).catch(() => undefined);
						paint();
					};
					row.append(mark);
				}
				list.appendChild(row);
			}
		};
		/** Feed unchanged: only the relative timestamps grow, so just move those. */
		const refreshTimes = () => {
			const times = panel && panel.querySelectorAll('.zc-ntime');
			if (times) nfeed.list.forEach((item, i) => times[i] && (times[i].textContent = ago(item.ts)));
		};
		const paint = () => {
			const count = unreadCount();
			// Muted keeps recording into the panel, but nothing announces it: the badge
			// stays hidden and the bell never shakes (the OS ring follows the same pref).
			const muted = document.body.classList.contains('zc-notify-off');
			badge.textContent = count > 99 ? '99+' : String(count);
			badge.hidden = muted || count === 0;
			// unread starts at -1: the first paint fills an existing feed without shaking.
			if (count > nfeed.unread && nfeed.unread >= 0 && !muted) shake();
			nfeed.unread = count;
			bell.setAttribute('aria-label', count > 0 ? count + ' unread notifications' : 'Notifications');
			const json = JSON.stringify(nfeed.list);
			const changed = json !== rendered;
			rendered = json;
			if (panel && panel.classList.contains('zc-open')) (changed ? renderList : refreshTimes)();
		};
		nfeed.paint = paint;
		const place = () => {
			if (!panel || !panel.classList.contains('zc-open')) return;
			const r = bell.getBoundingClientRect();
			const w = panel.offsetWidth || 332;
			const h = panel.offsetHeight || 240;
			panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
			panel.style.top = Math.max(8, r.top - h - 10) + 'px';
		};
		const closePanel = () => {
			if (!panel) return;
			panel.classList.remove('zc-open');
			bell.setAttribute('aria-expanded', 'false');
		};
		const buildPanel = () => {
			panel = document.createElement('div');
			panel.className = 'zc-npanel';
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-label', 'Notifications');
			panel.innerHTML =
				'<div class="zc-nhead"><span class="zc-nhead-title"><span>Notifications</span><span class="zc-nnew" hidden></span></span>' +
				'<span class="zc-nhead-btns">' +
				'<button type="button" class="zc-nbtn zc-nreadall">' + ICON.checkCheck + '<span>Read all</span></button>' +
				'<button type="button" class="zc-nbtn zc-nclose" aria-label="Close notifications">' + ICON.x + '</button>' +
				'</span></div><div class="zc-nprefs"><button type="button" class="zc-nmute" role="switch" aria-checked="true" aria-label="Notifications"><span class="zc-npref-text"><b>Notifications <em class="zc-nstatus">On</em></b><small>Notify when runs finish while you’re away</small></span><i class="zc-nswitch" aria-hidden="true"></i></button><button type="button" class="zc-nmute zc-nnotch" role="switch" aria-checked="true" aria-label="AI Dock"><span class="zc-npref-text"><b>AI Dock <em class="zc-nstatus">On</em></b><small>Runs and approvals at the top of your screen</small></span><i class="zc-nswitch" aria-hidden="true"></i></button></div><div class="zc-nprojects" hidden></div><div class="zc-nlist"></div>';
			panel.querySelector('.zc-nclose').onclick = closePanel;
			panel.querySelector('.zc-nmute').onclick = () => window.dispatchEvent(new CustomEvent('zc-notify-toggle'));
			panel.querySelector('.zc-nnotch').onclick = () => {
				notchOn = !notchOn;
				paintBell();
				post({ type: 'updateSettings', patch: { notch: notchOn } });
			};
			panel.querySelector('.zc-nreadall').onclick = () => {
				for (const n of nfeed.list) n.read = true;
				if (bridge()) bridge().invoke('notify_read', { id: null }).catch(() => undefined);
				paint();
			};
			document.body.appendChild(panel);
			paintBell();
			// A press outside closes it (the bell button handles its own toggle); Escape too.
			document.addEventListener('mousedown', (e) => {
				if (e.target instanceof Element && panel.classList.contains('zc-open') && !panel.contains(e.target) && !bell.contains(e.target)) closePanel();
			});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && panel.classList.contains('zc-open')) closePanel();
			});
			window.addEventListener('resize', closePanel);
		};
		const openPanel = () => {
			if (!panel) buildPanel();
			renderList();
			panel.classList.add('zc-open');
			bell.setAttribute('aria-expanded', 'true');
			place();
		};
		bell.onclick = () => (panel && panel.classList.contains('zc-open') ? closePanel() : openPanel());
		new MutationObserver(paintBell).observe(document.body, { attributes: true, attributeFilter: ['class'] });
		window.addEventListener('zc-notch-changed', paintBell);
		paintBell();
		paint();
		side.appendChild(foot);

		// Our actions run before the row's own click (capture) and stop it.
		content.addEventListener(
			'click',
			(e) => {
				const act = e.target.closest('.zc-act');
				if (!act) return;
				e.preventDefault();
				e.stopImmediatePropagation();
				const key = act.dataset.key || '';
				if (key.startsWith('delete-project:')) post({ type: 'projectDelete', path: key.slice(15) });
				else if (key.startsWith('chat:')) window.__zcProjectActions?.deleteChat(key.slice(5));
				else if (key.startsWith('project:')) confirmClick(key, () => post({ type: 'projectRemove', path: key.slice(8) }));
			},
			true
		);
		window.__zcDecorateProjects = decorate;
		content.addEventListener('scroll', () => {
			clearTimeout(panelSaveTimer);
			panelSaveTimer = setTimeout(saveProjectPanel, 150);
		}, { passive: true });
		content.addEventListener('click', saveProjectPanel, true);
		decorate(content);
		new MutationObserver(() => decorate(content)).observe(content, { childList: true, subtree: true });

		// Open the Projects panel by default on launch; remember when the user explicitly closes it.
		let wanted = true;
		try {
			const saved = localStorage.getItem('zc.sidebar.v2');
			wanted = saved === null ? true : saved !== 'closed';
		} catch {
			/* storage unavailable */
		}
		let userInteracted = false;
		['btn-sidebar', 'btn-sidebar-close'].forEach((id) => {
			document.getElementById(id)?.addEventListener('click', () => { userInteracted = true; });
		});
		side.addEventListener('click', () => { userInteracted = true; });
		new MutationObserver(() => {
			if (!userInteracted) return;
			try {
				const val = side.classList.contains('hidden') ? 'closed' : 'open';
				localStorage.setItem('zc.sidebar.v2', val);
				localStorage.setItem('zc.sidebar', val);
			} catch {
				/* storage unavailable */
			}
		}).observe(side, { attributes: true, attributeFilter: ['class'] });

		if (wanted && !document.body.classList.contains('fullscreen')) {
			const openSidebar = () => {
				if (!side.classList.contains('hidden')) return;
				// Below 1000 px the side panels exclude each other, and a page can start there before it
				// gets its bounds: opening now would close the Work Details that Show Files just opened.
				if (innerWidth < 1000 && !document.getElementById('auxiliary')?.classList.contains('hidden')) return;
				const btn = document.getElementById('btn-sidebar');
				if (btn) btn.click();
				else {
					side.classList.remove('hidden');
					if (window.__zcRefreshProjects) window.__zcRefreshProjects();
				}
			};
			openSidebar();
			requestAnimationFrame(openSidebar);
			setTimeout(openSidebar, 150);
			const openWhenWide = () => {
				if (innerWidth < 1000) return;
				window.removeEventListener('resize', openWhenWide);
				openSidebar();
			};
			window.addEventListener('resize', openWhenWide);
			openWhenWide();
		}
	}

	/** Native fullscreen keeps the current page and catches up after a project switch. */
	function fullscreen() {
		const bar = document.querySelector('.topbar, .zc-titlebar');
		const peek = document.createElement('button');
		peek.className = 'zc-fullscreen-peek';
		peek.type = 'button';
		peek.hidden = true;
		peek.setAttribute('aria-label', 'Show window controls (F6)');
		peek.innerHTML = '<span aria-hidden="true"></span>';
		if (bar) {
			bar.id = bar.id || 'zc-window-bar';
			peek.setAttribute('aria-controls', bar.id);
		}
		document.body.appendChild(peek);
		let hideTimer = null, pointerNear = false, keyboard = false;
		const active = () => document.body.classList.contains('zc-native-fullscreen');
		const focused = () => keyboard && (bar?.contains(document.activeElement) || document.activeElement === peek);
		const menuOpen = () => bar?.querySelector('[aria-haspopup][aria-expanded="true"]') || document.querySelector('.row-menu');
		const visible = (show) => {
			document.body.classList.toggle('zc-fullscreen-bar-visible', active() && show);
			if (bar) {
				bar.inert = active() && !show;
				bar.setAttribute('aria-hidden', String(active() && !show));
			}
			peek.setAttribute('aria-expanded', String(active() && show));
		};
		const reveal = () => {
			if (!active()) return;
			clearTimeout(hideTimer); hideTimer = null;
			visible(true);
		};
		const hideAfter = (delay = 650) => {
			if (!active() || hideTimer !== null) return;
			hideTimer = setTimeout(() => {
				hideTimer = null;
				if (!active() || pointerNear || focused()) return;
				if (menuOpen()) { hideAfter(250); return; }
				if (bar?.contains(document.activeElement)) document.activeElement.blur();
				visible(false);
			}, delay);
		};
		const reset = () => {
			clearTimeout(hideTimer); hideTimer = null;
			pointerNear = false;
			visible(false);
		};
		window.__zcSetFullscreen = (on) => {
			const changed = document.body.classList.contains('zc-native-fullscreen') !== !!on;
			document.body.classList.toggle('zc-native-fullscreen', !!on);
			peek.hidden = !on;
			if (changed) {
				if (on && bar?.contains(document.activeElement)) {
					const input = document.getElementById('input');
					if (input) input.focus({ preventScroll:true });
					else document.activeElement.blur();
				}
				reset();
				window.dispatchEvent(new Event('zc-fullscreen-change'));
			}
			const button = document.getElementById('btn-fullscreen');
			if (!button) return;
			const label = on ? 'Exit full screen' : 'Full screen';
			button.title = label + ' (F11 / Ctrl+Alt+F)';
			button.setAttribute('aria-label', label);
			button.setAttribute('aria-pressed', String(!!on));
			if (window.Icons) button.innerHTML = window.Icons.svg(on ? 'minimize' : 'expand');
		};
		const sync = () => win('is_fullscreen').then(on => {
			if (typeof on === 'boolean') window.__zcSetFullscreen(on);
		});
		sync();
		window.addEventListener('focus', sync);
		window.addEventListener('message', event => {
			if (event.source && event.source !== window) return;
			if (event.data?.type === 'zcDesktopActivated') sync();
		});
		document.addEventListener('pointerdown', () => { keyboard = false; }, true);
		document.addEventListener('keydown', () => { keyboard = true; }, true);
		document.addEventListener('pointermove', event => {
			if (!active()) return;
			const rect = bar?.getBoundingClientRect();
			pointerNear = event.clientY <= 18 || (document.body.classList.contains('zc-fullscreen-bar-visible') && rect && event.clientY <= rect.bottom + 8 && event.clientX >= rect.left - 8 && event.clientX <= rect.right + 8);
			if (pointerNear) reveal();
			else hideAfter();
		}, { passive:true });
		bar?.addEventListener('pointerenter', () => { pointerNear = true; reveal(); });
		bar?.addEventListener('pointerleave', () => { pointerNear = false; hideAfter(); });
		bar?.addEventListener('focusin', reveal);
		bar?.addEventListener('focusout', () => hideAfter());
		peek.addEventListener('focus', reveal);
		peek.addEventListener('blur', () => hideAfter());
		peek.addEventListener('click', () => { reveal(); hideAfter(4000); });
		window.addEventListener('blur', reset);
		window.addEventListener('zv-change', reset);
		document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
		document.addEventListener('keydown', (e) => {
			if (active() && e.key === 'F6' && !e.ctrlKey && !e.altKey && !e.metaKey) {
				e.preventDefault();
				reveal();
				bar?.querySelector('button:not([disabled])')?.focus({ preventScroll:true });
				return;
			}
			if (e.key !== 'F11' || e.ctrlKey || e.altKey || e.metaKey) return;
			e.preventDefault();
			post({ type: 'fullscreen', on: !document.body.classList.contains('zc-native-fullscreen') });
		});
	}

	function resizable() {
		const layouts = [];
		let revision = 0, pending = null;
		let popup = null, owner = null, refreshPopup = () => {};
		const close = (focus = false) => {
			popup?.remove(); popup = null;
			owner?.setAttribute('aria-expanded', 'false');
			if (focus) owner?.focus();
			owner = null; refreshPopup = () => {};
		};
		const save = () => {
			if (pending) return;
			const widths = Object.fromEntries(layouts.map(item => [item.id, item.preferred]));
			pending = { revision, widths };
			post({ type:'zcDesktopPrefs', prefs:{ widths } });
		};
		const make = (id, edge, variable, defaultWidth, label) => {
			const panel = document.getElementById(id);
			if (!panel || panel.querySelector(':scope > .zc-resize')) return;
			const item = { id, panel, preferred:0 };
			layouts.push(item);
			const maximum = () => {
				if (innerWidth <= 999) return Math.max(1, Math.min(620, innerWidth - 24));
				const other = layouts.find(entry => entry !== item && !entry.panel.classList.contains('hidden'));
				return Math.max(280, Math.min(620, innerWidth - (other?.panel.getBoundingClientRect().width || 0) - 440));
			};
			const clamp = px => Math.round(Math.min(Math.max(px, Math.min(280, maximum())), maximum()));
			const grip = document.createElement('div');
			grip.className = 'zc-resize';
			grip.tabIndex = 0;
			grip.setAttribute('role', 'separator');
			grip.setAttribute('aria-orientation', 'vertical');
			grip.setAttribute('aria-label', 'Resize ' + label + ' panel');
			grip.setAttribute('aria-controls', id);
			grip.title = 'Drag to resize · Esc to cancel · double-click to reset';
			panel.appendChild(grip);
			const set = (px, remember = false) => {
				if (innerWidth <= 24) return;
				const size = clamp(px || defaultWidth);
				if (remember) { item.preferred = px ? Math.max(280, size) : 0; revision++; }
				document.body.style.setProperty(variable, size + 'px');
				grip.setAttribute('aria-valuemin', String(Math.min(280, maximum())));
				grip.setAttribute('aria-valuemax', String(maximum()));
				grip.setAttribute('aria-valuenow', String(size));
				grip.setAttribute('aria-valuetext', size + ' pixels');
				refreshPopup();
			};
			item.apply = () => set(item.preferred);
			const choose = px => { set(px, true); save(); };
			const button = document.createElement('button');
			button.className = 'icon-btn zc-size-btn'; button.type = 'button';
			button.title = label + ' panel size';
			button.setAttribute('aria-label', label + ' panel size');
			button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
			button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m4-10 2 2-2 2m5-4-2 2 2 2"/></svg>';
			if (id === 'sidebar') {
				const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'icon-btn zc-archive-btn';
				archive.title = 'Archive / History'; archive.setAttribute('aria-label', 'Archive / History'); archive.setAttribute('aria-controls', 'history');
				archive.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="4" rx="1"/><path d="M5 7v13h14V7M9 11h6"/></svg>';
				archive.onclick = () => document.getElementById('btn-history')?.click();
				panel.querySelector('.sidebar-head-tools')?.prepend(archive);
				const history = document.getElementById('history');
				if (history) {
					const sync = () => archive.setAttribute('aria-expanded', String(history.classList.contains('open')));
					new MutationObserver(sync).observe(history, { attributes: true, attributeFilter: ['class'] }); sync();
				}
			} else panel.querySelector('.auxiliary-head-tools')?.prepend(button);
			button.addEventListener('click', () => {
				if (owner === button) { close(); return; }
				close(); owner = button; button.setAttribute('aria-expanded', 'true');
				popup = document.createElement('div'); popup.className = 'zc-size-pop';
				popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', label + ' panel size');
				popup.innerHTML = '<header><span>' + label + ' panel</span><output></output></header><label>Width<input type="range" step="1" aria-label="' + label + ' panel width"></label><div class="zc-size-presets"><button data-width="280">Compact</button><button data-width="' + defaultWidth + '">Default</button><button data-width="460">Wide</button></div><button class="zc-size-reset">Reset panel size</button><p>Drag the panel edge to resize.<br>Use arrow keys when the edge is focused.</p>';
				document.body.appendChild(popup);
				const slider = popup.querySelector('input');
				refreshPopup = () => {
					const size = Number(grip.getAttribute('aria-valuenow'));
					slider.min = String(Math.min(280, maximum())); slider.max = String(maximum()); slider.value = String(size);
					popup.querySelector('output').textContent = size + ' px';
					for (const preset of popup.querySelectorAll('[data-width]')) preset.setAttribute('aria-pressed', String(Number(preset.dataset.width) === size));
				};
				refreshPopup();
				slider.addEventListener('input', () => set(Number(slider.value), true));
				slider.addEventListener('change', save);
				for (const preset of popup.querySelectorAll('[data-width]')) preset.onclick = () => choose(Number(preset.dataset.width));
				popup.querySelector('.zc-size-reset').onclick = () => choose(0);
				const r = button.getBoundingClientRect();
				popup.style.left = Math.max(12, Math.min(innerWidth - popup.offsetWidth - 12, edge === 'right' ? r.left : r.right - popup.offsetWidth)) + 'px';
				popup.style.top = Math.max(12, Math.min(r.bottom + 8, innerHeight - popup.offsetHeight - 12)) + 'px';
				slider.focus();
			});
			grip.addEventListener('pointerdown', (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				close();
				grip.focus({ preventScroll:true });
				grip.setPointerCapture(e.pointerId);
				const startX = e.clientX;
				const from = panel.getBoundingClientRect().width;
				const original = item.preferred;
				let moved = false;
				grip.classList.add('zc-resize-active');
				document.body.classList.add('zc-resizing');
				const move = (ev) => {
					const dx = ev.clientX - startX;
					if (!moved && Math.abs(dx) < 4) return;
					moved = true;
					set(from + (edge === 'right' ? dx : -dx), true);
				};
				const end = (event) => {
					grip.removeEventListener('pointermove', move);
					grip.removeEventListener('pointerup', end);
					grip.removeEventListener('pointercancel', end);
					grip.removeEventListener('lostpointercapture', end);
					document.removeEventListener('keydown', cancel, true);
					window.removeEventListener('blur', end);
					grip.classList.remove('zc-resize-active');
					document.body.classList.remove('zc-resizing');
					if (event?.type !== 'pointerup') set(original, true);
					if (grip.hasPointerCapture?.(e.pointerId)) grip.releasePointerCapture(e.pointerId);
					if (moved) save();
				};
				const cancel = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); end(event); } };
				grip.addEventListener('pointermove', move);
				grip.addEventListener('pointerup', end, { once: true });
				grip.addEventListener('pointercancel', end, { once: true });
				grip.addEventListener('lostpointercapture', end, { once:true });
				document.addEventListener('keydown', cancel, true);
				window.addEventListener('blur', end, { once:true });
			});
			grip.addEventListener('dblclick', () => choose(0));
			grip.addEventListener('keydown', e => {
				if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
				e.preventDefault(); e.stopPropagation();
				const delta = (e.key === 'ArrowRight' ? 1 : -1) * (edge === 'right' ? 1 : -1) * (e.shiftKey ? 40 : 10);
				choose(e.key === 'Home' ? 280 : e.key === 'End' ? maximum() : panel.getBoundingClientRect().width + delta);
			});
		};
		make('sidebar', 'right', '--zc-side-w', 320, 'Projects');
		make('auxiliary', 'left', '--zc-aux-w', 360, 'Work Details');
		const reflow = () => { for (const item of layouts) item.apply(); };
		refreshPanelLayout = reflow;
		updatePanelWidths = widths => {
			// Preference replies can arrive while the user is still dragging or choosing another size.
			if (pending) {
				if (!layouts.every(item => widths[item.id] === pending.widths[item.id])) return;
				const savedRevision = pending.revision;
				pending = null;
				if (revision !== savedRevision) { save(); return; }
			}
			for (const item of layouts) if (Number.isFinite(widths[item.id])) item.preferred = widths[item.id];
			reflow();
		};
		const observer = new MutationObserver(reflow);
		for (const item of layouts) observer.observe(item.panel, { attributes:true, attributeFilter:['class'] });
		window.addEventListener('resize', () => { close(); reflow(); });
		new ResizeObserver(reflow).observe(document.documentElement);
		window.addEventListener('message', e => { if ((!e.source || e.source === window) && e.data?.type === 'zcDesktopActivated') { reflow(); requestAnimationFrame(reflow); } });
		document.addEventListener('pointerdown', e => { if (popup && !popup.contains(e.target) && !owner.contains(e.target)) close(); }, true);
		document.addEventListener('keydown', e => { if (popup && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(true); } }, true);
		document.addEventListener('visibilitychange', () => { if (document.hidden) close(); else { reflow(); requestAnimationFrame(reflow); } });
		reflow();
	}

	/**
	 * "Open project folder" — a top-bar folder button next to ⋯ that opens the
	 * project folder in the user's tools. The shell owns the folder path and
	 * knows what is installed ({type:'zcOpenTargets'}); the menu reuses the
	 * engine's popover classes, so it looks like every other menu here.
	 */
	function openIn() {
		const right = document.querySelector('.topbar .topbar-right');
		if (!right || right.querySelector('.zc-open-btn')) return;
		const CATALOG = [
			['explorer', 'File manager', BRAND.explorer],
			['vscode', 'Visual Studio Code', BRAND.vscode],
			['cursor', 'Cursor', BRAND.cursor],
			['terminal', 'Terminal', BRAND.terminal],
		];
		let info = null;
		let menu = null;

		const btn = document.createElement('button');
		btn.className = 'icon-btn zc-open-btn';
		btn.title = 'Open project folder';
		btn.setAttribute('aria-haspopup', 'menu');
		btn.setAttribute('aria-expanded', 'false');
		btn.innerHTML = ICON.folder + '<span class="zc-chev">' + ICON.chevDown + '</span>';
		btn.style.display = 'none'; // shown once a workspace folder answers
		right.insertBefore(btn, document.getElementById('btn-fullscreen'));

		const close = () => {
			if (!menu) return;
			menu.remove();
			menu = null;
			btn.setAttribute('aria-expanded', 'false');
		};
		const open = () => {
			if (menu) {
				close();
				return;
			}
			if (!info || !info.folder) return;
			menu = document.createElement('div');
			menu.className = 'popover menu row-menu zc-open-menu';
			const label = document.createElement('div');
			label.className = 'menu-label';
			label.textContent = info.name || info.folder;
			label.title = info.folder;
			menu.appendChild(label);
			for (const [key, name, icon] of CATALOG) {
				if (!(key in info.targets)) continue; // a target the shell never offers
				const b = document.createElement('button');
				b.className = 'menu-item';
				b.innerHTML = icon + '<span class="grow">' + name + '</span>';
				if (info.targets[key] !== true) {
					b.disabled = true;
					b.title = key === 'githubdesktop' && !info.repo ? 'Not a Git repository' : 'Not installed';
				} else {
					b.addEventListener('click', (e) => {
						e.stopPropagation();
						close();
						post({ type: 'zcOpenIn', target: key });
					});
				}
				menu.appendChild(b);
			}
			menu.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' }));
			const copy = document.createElement('button');
			copy.className = 'menu-item';
			copy.innerHTML = ICON.copy + '<span class="grow">Copy path</span>';
			copy.addEventListener('click', (e) => {
				e.stopPropagation();
				close();
				post({ type: 'zcCopyFolder', path: info.folder });
			});
			menu.appendChild(copy);
			document.body.appendChild(menu);
			const r = btn.getBoundingClientRect();
			const w = menu.offsetWidth || 240;
			menu.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + 'px';
			menu.style.top = r.bottom + 6 + 'px';
			btn.setAttribute('aria-expanded', 'true');
		};
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			open();
		});
		document.addEventListener('mousedown', (e) => {
			if (menu && e.target instanceof Element && !menu.contains(e.target) && !btn.contains(e.target)) close();
		});
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') close();
		});

		window.addEventListener('message', (e) => {
			if (e.source && e.source !== window) return;
			const d = e.data;
			if (d && d.type === 'zcDesktopActivated') { post({ type: 'zcOpenTargets' }); return; }
			if (!d || d.type !== 'zcOpenTargets') return;
			info = d.info && d.info.targets ? d.info : null;
			btn.style.display = info && info.folder ? '' : 'none';
			close(); // a stale menu re-renders on the next click
		});
		post({ type: 'zcOpenTargets' });
	}

	function init() {
		addStyle();
		frame();
		sidebar();
		openIn();
		fullscreen();
		resizable();
		busyFeed();
		preferencesReady();
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
	else init();
})();
