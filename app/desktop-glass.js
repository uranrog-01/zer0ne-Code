/*
 * Liquid Glass, injected into every engine page. The window and its page views are
 * transparent (app/engines.js); this page decides how much of the desktop shows
 * through. The droplet button in the top bar holds the options:
 *
 *  - Transparency 0–100%: 0 is the solid app, 100 is clear glass over the desktop.
 *  - Real transparency: the live desktop shows through the window, nothing is copied or
 *    drawn in its place. Background brightness darkens what shows through.
 *  - Bottom haze: darker toward the bottom, stronger the more transparent the window is.
 *  - Blurry: Windows' Acrylic on this app's own window (frosted glass); nothing in the
 *    system changes.
 *  - Solid while reading, and accent colours that follow the desktop picture (only its
 *    colours are read, app/glass.js; the picture itself is never shown).
 *  - The droplet button glows softly while the window is see-through, so it stays easy to find.
 *  - Liquid Glass menus and popovers, the pixel-tile ripple on menu rows (gold for Max,
 *    purple for Ultra), slim icons in the window chrome.
 *
 * The haze and tile ripple follow monocode (MIT, github.com/hardbeat920/monocode).
 */
(function () {
	'use strict';
	if (window.__zcGlass) return;
	window.__zcGlass = true;

	/*
	 * One set of settings for the whole app. Every project runs its own engine page on its
	 * own port, so the page's localStorage is per project and per launch — the settings live
	 * in glass.json instead (app/glass.js): the shell hands them to each new page
	 * (window.__zgPrefs), a change is pushed to every other open page (window.__zgSync),
	 * and localStorage only covers a reload of this same page. `at` says which copy is newer.
	 */
	const KEY = 'zg.prefs';
	// dim: how much darker what shows through is (0 = as is, 80 = very dark).
	const DEFAULTS = { transparency: 0, haze: true, blur: false, dim: 0, autoSolid: true, matchColors: true };
	function clean(saved) {
		const out = { ...DEFAULTS, at: 0 };
		if (!saved || typeof saved !== 'object') return out;
		if (Number.isFinite(saved.transparency)) out.transparency = Math.round(Math.min(100, Math.max(0, saved.transparency)));
		if (Number.isFinite(saved.dim)) out.dim = Math.round(Math.min(80, Math.max(0, saved.dim)));
		for (const k of ['haze', 'blur', 'autoSolid', 'matchColors']) if (typeof saved[k] === 'boolean') out[k] = saved[k];
		if (Number.isFinite(saved.at)) out.at = saved.at;
		return out;
	}
	let local = null;
	try {
		local = JSON.parse(localStorage.getItem(KEY) || 'null');
	} catch {
		/* storage unavailable */
	}
	const shared = window.__zgPrefs && typeof window.__zgPrefs === 'object' ? window.__zgPrefs : null;
	// The app's copy wins unless this page saved something newer (a reload after a change).
	let prefs = clean(shared && (!local || !(local.at > (shared.at || 0))) ? shared : local);
	const native = () => window.__zcShell;
	// What works on this system (app/glass.js): a see-through window (Windows, macOS, Linux with a
	// compositor), the blur (Windows, macOS) and wallpaper colours (Windows).
	const support = Object.assign({ os: 'windows', transparent: true, blur: true, hideIcons: false, colors: true }, window.__zgSupport || {});
	/** The transparency in effect: 0 where this desktop cannot show a window see-through. */
	const level = () => (support.transparent ? prefs.transparency : 0);
	// This page holds a newer copy than the app's (settings from before glass.json existed, or a
	// reload right after a change): hand it to the app once the page is up.
	const push = !!local && (!shared || local.at > (shared.at || 0));

	// --zg-o: how solid the window is (1 = the normal app, 0 = clear glass).
	const CSS = `
	html.zg-html, html.zg-html body.zg-on { background:transparent !important; }
	body.zg-on .chat-app { position:relative; isolation:isolate; background:transparent !important; }
	body.zg-on .chat-app > .topbar { position:relative; z-index:40; background:transparent !important; border-bottom:1px solid color-mix(in srgb, var(--color-foreground) 9%, transparent); }
	body.zg-on .coding-workspace { position:relative; z-index:1; background:transparent !important; }
	body.zg-on .primary-chat, body.zg-on .conversation, body.zg-on .messages, body.zg-on .composer { background:transparent !important; }

	/* The window over the real desktop: a dimmer, the tint, the reading layer and the bottom haze. */
	.zg-dimmer, .zg-surface, .zg-solid, .zg-haze { position:absolute; inset:0; z-index:0; pointer-events:none; border-radius:inherit; }
	/* Solid while reading: eases in while you scroll or type, glides back a moment after. */
	.zg-solid { opacity:0; background:var(--color-background); transition:opacity .5s ease; }
	body.zg-see.zg-reading .zg-solid { opacity:.82; transition-duration:.25s; }
	/* Background brightness: darkens what shows through (the desktop itself is untouched). */
	.zg-dimmer { opacity:0; background:#000; transition:opacity .3s ease; }
	body.zg-see .zg-dimmer { opacity:var(--zg-dim, 0); }
	.zg-surface { background:color-mix(in srgb, var(--color-background) calc(var(--zg-o, .55) * 100%), transparent); }
	.zg-haze { opacity:calc((1 - var(--zg-o, .55)) * var(--zg-haze, 1));
		background:linear-gradient(to bottom, transparent 16%, color-mix(in srgb, var(--color-background) 26%, transparent) 38%, color-mix(in srgb, var(--color-background) 55%, transparent) 56%, color-mix(in srgb, var(--color-background) 82%, transparent) 80%); }

	/* Panels: tinted glass, much more solid than the window — the real desktop (icons and all)
	   shows through, so lists must stay readable over anything. */
	body.zg-on #sidebar, body.zg-on #auxiliary { background:linear-gradient(135deg, #ffffff0a, #ffffff02), color-mix(in srgb, var(--color-panel, var(--color-background)) calc(90% + 10% * var(--zg-o, .55)), transparent) !important; }
	body.zg-on #sidebar { border-right:1px solid color-mix(in srgb, var(--color-foreground) 9%, transparent); }
	body.zg-on #auxiliary { border-left:1px solid color-mix(in srgb, var(--color-foreground) 9%, transparent); }
	body.zg-see #sidebar, body.zg-see #auxiliary { background:linear-gradient(135deg, #ffffff10, #ffffff03), color-mix(in srgb, var(--color-panel, var(--color-background)) calc(32% + 58% * var(--zg-o, .55)), transparent) !important;
		-webkit-backdrop-filter:blur(32px) saturate(1.35); backdrop-filter:blur(32px) saturate(1.35); box-shadow:inset 0 1px 0 #ffffff18; }
	body.zg-see #sidebar :is(.sidebar-head, .sidebar-foot, .zc-project-controls), body.zg-see #auxiliary :is(.auxiliary-head, .aux-tabs, .aux-panel) { background-color:transparent !important; }

	/* The composer and the cards in the chat: liquid glass with a hairline edge. */
	body.zg-on .input-card { background:linear-gradient(180deg, #ffffff0d, #ffffff03), color-mix(in srgb, var(--color-input, var(--color-card)) calc(30% + 64% * var(--zg-o, .55)), transparent) !important;
		border-color:#ffffff26 !important; box-shadow:inset 0 1px 0 #ffffff1f, 0 10px 30px -18px #000a; }
	body.zg-on .code-block, body.zg-on .approval, body.zg-on .edits-card, body.zg-on .progress-card, body.zg-on .md .table-wrap, body.zg-on .welcome-hero, body.zg-on .stat-card {
		background-color:color-mix(in srgb, var(--color-card, var(--color-background)) calc(40% + 56% * var(--zg-o, .55)), transparent) !important; }

	/* Settings and History: lighter glass — more solid than the chat, so long reading stays easy. */
	body.zg-see .settings-overlay { background:rgba(0, 0, 0, .22) !important; }
	body.zg-see .settings-panel { background:linear-gradient(180deg, #ffffff0d, #ffffff03), color-mix(in srgb, var(--color-background) calc(76% + 22% * var(--zg-o, .55)), transparent) !important;
		-webkit-backdrop-filter:blur(30px) saturate(1.4); backdrop-filter:blur(30px) saturate(1.4); border-color:#ffffff24 !important; }
	body.zg-see .settings-nav { background:color-mix(in srgb, var(--color-panel, var(--color-background)) 40%, transparent) !important; }
	body.zg-see #history.drawer { background:linear-gradient(180deg, #ffffff0a, #ffffff02), color-mix(in srgb, var(--color-background) calc(72% + 26% * var(--zg-o, .55)), transparent) !important;
		-webkit-backdrop-filter:blur(26px) saturate(1.3); backdrop-filter:blur(26px) saturate(1.3); }

	/* Liquid Glass menus and popovers. */
	body.zg-on .popover, body.zg-on .row-menu, body.zg-on .input-menu {
		background:linear-gradient(180deg, #ffffff14, #ffffff04 46%, #ffffff09), color-mix(in srgb, var(--color-popover) calc(62% + 32% * var(--zg-o, .55)), transparent) !important;
		-webkit-backdrop-filter:blur(26px) saturate(1.7); backdrop-filter:blur(26px) saturate(1.7);
		border:1px solid #ffffff21 !important; border-radius:14px; box-shadow:inset 0 1px 0 #ffffff30, inset 0 -1px 0 #ffffff0a, 0 22px 54px -14px #000c, 0 4px 14px -6px #0008 !important; }
	body.zg-on #model-menu { background:var(--color-popover) !important; -webkit-backdrop-filter:none; backdrop-filter:none; }
	body.zg-on .popover .menu-item { border-radius:9px; }
	body.zg-on .popover .menu-item:hover, body.zg-on .popover .menu-item.active { background:#ffffff14; box-shadow:inset 0 1px 0 #ffffff12; }
	body.zg-on.is-light .popover .menu-item:hover, body.zg-on.is-light .popover .menu-item.active { background:#0000000f; box-shadow:none; }

	/* Pixel-tile ripple (monocode): tiles light up in waves from the pointer. */
	.zg-rip { position:relative; isolation:isolate; overflow:hidden; }
	.zg-rip > :not(.zg-tiles) { position:relative; z-index:1; }
	.zg-tiles { position:absolute; inset:0; z-index:0; display:grid; grid-template-columns:repeat(32, minmax(0, 1fr)); grid-template-rows:repeat(5, minmax(0, 1fr)); pointer-events:none;
		animation:zg-clear 5000ms linear 1 both;
		-webkit-mask-image:linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent), linear-gradient(to bottom, transparent, #000 35%, #000 65%, transparent); -webkit-mask-composite:source-in;
		mask-image:linear-gradient(to right, transparent, #000 28px, #000 calc(100% - 28px), transparent), linear-gradient(to bottom, transparent, #000 35%, #000 65%, transparent); mask-composite:intersect; }
	.zg-tiles > i { box-shadow:inset -1px -1px 0 color-mix(in srgb, var(--zg-tone) 30%, transparent); }
	.zg-tiles > i.zg-lit { animation:zg-fill 1400ms ease-out 2 both; animation-delay:calc(var(--d) * 420ms); }
	.zg-rip::after { content:''; position:absolute; inset:0; z-index:2; border-radius:inherit; pointer-events:none; opacity:0; }
	.zg-rip.zg-live::after { animation:zg-edge 5000ms ease-in-out 1 both; }
	.zg-tiles.zg-out { animation:zg-fade .22s ease-out both; }
	/* The whole wave shows at 25% strength (user, 2026-10-06): a hint of colour, never full colour. */
	@keyframes zg-clear { 0%, 92% { opacity:.25; visibility:visible; } 100% { opacity:0; visibility:hidden; } }
	/* Softer than the reference: the row's text must stay easy to read while the wave passes. */
	@keyframes zg-fill { 0%, 100% { background-color:transparent; } 26% { background-color:color-mix(in srgb, var(--zg-tone) 40%, transparent); } 52% { background-color:color-mix(in srgb, var(--zg-tone) 10%, transparent); } }
	@keyframes zg-edge { 0%, 12%, 26%, 40%, 54%, 68%, 82% { opacity:.075; box-shadow:inset 0 0 4px 0 transparent; } 19%, 47%, 75% { opacity:.14; box-shadow:inset 0 0 10px 1px color-mix(in srgb, var(--zg-tone) 35%, transparent); } 100% { opacity:0; box-shadow:inset 0 0 4px 0 transparent; } }
	@keyframes zg-fade { from { opacity:.25; } to { opacity:0; } }

	/* Slim icons and a soft glass hover in the window chrome. */
	body.zg-on .topbar svg.i, body.zg-on .composer-bar svg.i, body.zg-on .ws-row svg.i, body.zg-on .mods-btn svg.i, body.zg-on #sidebar svg.i { stroke-width:1.3; }
	body.zg-on .topbar .icon-btn, body.zg-on .composer-bar .icon-btn { color:color-mix(in srgb, var(--color-foreground) 70%, transparent); border-radius:9px; transition:background .14s, color .14s, box-shadow .14s; }
	body.zg-on .topbar .icon-btn:hover, body.zg-on .composer-bar .icon-btn:hover { color:var(--color-foreground); background:#ffffff14; box-shadow:inset 0 1px 0 #ffffff1c; }
	.zg-trigger { position:relative; transition:background .15s, border-color .15s, box-shadow .15s; }
	.zg-trigger.zg-active { color:var(--color-foreground); background:#ffffff18; box-shadow:inset 0 1px 0 #ffffff24; }
	.zg-trigger .zg-hint { display:none; align-items:center; gap:5px; margin-left:6px; font-size:11px; font-weight:600; letter-spacing:-0.01em; line-height:1; white-space:nowrap; user-select:none; }
	.zg-trigger .zg-hint-dot { width:6px; height:6px; border-radius:999px; background:var(--accent, #7fa4ff); box-shadow:0 0 6px var(--accent, #7fa4ff); flex-shrink:0; }
	.zg-trigger .zg-hint-text { display:inline-flex; align-items:center; gap:3px; opacity:.95; }
	/* While the window is see-through, the trigger transforms into a high-contrast glowing pill with an active hint so it is always effortless to find. */
	body.zg-see .zg-trigger {
		display:inline-flex; align-items:center; width:auto; height:30px; padding:0 10px 0 8px; border-radius:999px;
		color:var(--color-foreground);
		background:color-mix(in srgb, var(--color-background, #121214) 86%, var(--accent, #7fa4ff) 14%);
		border:1px solid color-mix(in srgb, var(--accent, #7fa4ff) 50%, rgba(255,255,255,.2));
		box-shadow:0 0 12px color-mix(in srgb, var(--accent, #7fa4ff) 35%, transparent), inset 0 1px 0 rgba(255,255,255,.25);
		backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
		animation:zg-pill-glow 3.2s ease-in-out infinite;
	}
	body.zg-see .zg-trigger:hover {
		background:color-mix(in srgb, var(--color-background, #121214) 78%, var(--accent, #7fa4ff) 22%);
		border-color:var(--accent, #7fa4ff);
		box-shadow:0 0 18px color-mix(in srgb, var(--accent, #7fa4ff) 55%, transparent), inset 0 1px 0 rgba(255,255,255,.35);
	}
	body.zg-see .zg-trigger svg.i {
		color:var(--accent, #7fa4ff);
		filter:drop-shadow(0 0 4px color-mix(in srgb, var(--accent, #7fa4ff) 70%, transparent));
	}
	body.zg-see .zg-trigger .zg-hint { display:inline-flex; }
	body.zg-see .zg-trigger .zg-hint-dot { animation:zg-pulse-dot 2.4s ease-in-out infinite; }
	@keyframes zg-pill-glow {
		0%, 100% {
			box-shadow:0 0 10px color-mix(in srgb, var(--accent, #7fa4ff) 30%, transparent), inset 0 1px 0 rgba(255,255,255,.25);
			border-color:color-mix(in srgb, var(--accent, #7fa4ff) 45%, rgba(255,255,255,.2));
		}
		50% {
			box-shadow:0 0 18px color-mix(in srgb, var(--accent, #7fa4ff) 60%, transparent), inset 0 1px 0 rgba(255,255,255,.4);
			border-color:var(--accent, #7fa4ff);
		}
	}
	@keyframes zg-pulse-dot {
		0%, 100% { transform:scale(1); opacity:.85; box-shadow:0 0 5px var(--accent, #7fa4ff); }
		50% { transform:scale(1.3); opacity:1; box-shadow:0 0 10px var(--accent, #7fa4ff); }
	}
	body.is-light.zg-see .zg-trigger {
		background:color-mix(in srgb, #ffffff 90%, var(--accent, #3b82f6) 10%);
		border-color:color-mix(in srgb, var(--accent, #3b82f6) 50%, rgba(0,0,0,.15));
		box-shadow:0 0 12px color-mix(in srgb, var(--accent, #3b82f6) 25%, transparent), inset 0 1px 0 rgba(255,255,255,.9);
		color:#1a1a1a;
	}
	@media (max-width: 600px) {
		body.zg-see .zg-trigger .zg-hint-label { display:none; }
	}

	/* The glass options popup — fully opaque and non-transparent so it is crystal clear even in transparency mode. */
	.zg-pop {
		position:fixed; inset:auto; margin:0; width:324px; max-width:calc(100vw - 20px); max-height:calc(100vh - 64px);
		overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; padding:16px;
		color:var(--color-foreground, #f4f4f5); font-size:12.5px; border-radius:18px;
		background:#141416 !important;
		border:1px solid rgba(255, 255, 255, 0.12) !important;
		box-shadow:0 24px 64px -12px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.15) !important;
		animation:zg-pop-appear 170ms cubic-bezier(0.16, 1, 0.3, 1) both;
		z-index:10000;
	}
	@keyframes zg-pop-appear { from { opacity:0; transform:scale(0.96) translateY(-4px); } to { opacity:1; transform:none; } }
	body.is-light .zg-pop {
		background:#ffffff !important; border-color:rgba(0, 0, 0, 0.1) !important;
		box-shadow:0 24px 50px -12px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(0, 0, 0, 0.05), inset 0 1px 0 rgba(255, 255, 255, 0.9) !important;
		color:#18181b;
	}
	.zg-pop-head { display:flex; align-items:center; gap:12px; padding-bottom:12px; margin-bottom:12px; border-bottom:1px solid rgba(255, 255, 255, 0.08); }
	body.is-light .zg-pop-head { border-bottom-color:rgba(0, 0, 0, 0.07); }
	.zg-pop-icon {
		width:36px; height:36px; border-radius:12px; display:grid; place-items:center;
		border:1px solid color-mix(in srgb, var(--accent, #7fa4ff) 35%, rgba(255, 255, 255, 0.1));
		background:linear-gradient(135deg, color-mix(in srgb, var(--accent, #7fa4ff) 20%, transparent), color-mix(in srgb, var(--accent, #7fa4ff) 5%, transparent));
		color:var(--accent, #7fa4ff); box-shadow:0 0 14px color-mix(in srgb, var(--accent, #7fa4ff) 25%, transparent); flex-shrink:0;
	}
	.zg-pop-head b { display:block; font-size:13.5px; font-weight:650; letter-spacing:-0.015em; }
	.zg-pop-head small { color:var(--color-foreground-muted, #a1a1aa); font-size:11px; line-height:1.35; display:block; }
	.zg-row {
		display:flex; align-items:center; gap:12px; padding:11px 13px; margin-bottom:8px;
		border:1px solid rgba(255, 255, 255, 0.07); border-radius:12px; background:rgba(255, 255, 255, 0.035);
		transition:background 0.15s ease, border-color 0.15s ease;
	}
	.zg-row:hover { background:rgba(255, 255, 255, 0.06); border-color:rgba(255, 255, 255, 0.12); }
	body.is-light .zg-row { background:rgba(0, 0, 0, 0.02); border-color:rgba(0, 0, 0, 0.06); }
	body.is-light .zg-row:hover { background:rgba(0, 0, 0, 0.04); border-color:rgba(0, 0, 0, 0.1); }
	.zg-row.zg-stack { flex-direction:column; align-items:stretch; gap:9px; }
	.zg-row-text { flex:1; min-width:0; display:flex; flex-direction:column; gap:2px; }
	.zg-row-text b { font-weight:600; font-size:12px; color:var(--color-foreground); }
	.zg-row-text small { color:var(--color-foreground-muted, #9ca3af); font-size:11px; line-height:1.4; }
	.zg-slide { display:flex; align-items:center; gap:12px; }
	.zg-slide input {
		flex:1; min-width:0; appearance:none; height:6px; border:none; border-radius:999px;
		background:linear-gradient(90deg, var(--accent, #7fa4ff) var(--zg-p, 50%), rgba(255, 255, 255, 0.12) var(--zg-p, 50%));
		cursor:pointer; outline:none;
	}
	body.is-light .zg-slide input { background:linear-gradient(90deg, var(--accent, #3b82f6) var(--zg-p, 50%), rgba(0, 0, 0, 0.1) var(--zg-p, 50%)); }
	.zg-slide input::-webkit-slider-thumb {
		appearance:none; width:18px; height:18px; border-radius:50%; background:#ffffff;
		box-shadow:0 2px 8px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(0, 0, 0, 0.15);
		cursor:grab; transition:transform 0.1s ease, box-shadow 0.1s ease;
	}
	.zg-slide input::-webkit-slider-thumb:hover { transform:scale(1.12); box-shadow:0 0 0 4px color-mix(in srgb, var(--accent, #7fa4ff) 25%, transparent), 0 2px 10px rgba(0, 0, 0, 0.45); }
	.zg-slide input::-webkit-slider-thumb:active { cursor:grabbing; transform:scale(1.05); }
	.zg-slide output {
		min-width:44px; padding:3px 6px; border-radius:6px; background:rgba(255, 255, 255, 0.07);
		border:1px solid rgba(255, 255, 255, 0.08); text-align:center; font-variant-numeric:tabular-nums;
		font-size:11px; font-weight:600; color:var(--color-foreground);
	}
	body.is-light .zg-slide output { background:rgba(0, 0, 0, 0.05); border-color:rgba(0, 0, 0, 0.08); }
	.zg-presets { display:flex; gap:6px; }
	.zg-presets button {
		flex:1; padding:6px 0; border:1px solid rgba(255, 255, 255, 0.08); border-radius:8px;
		background:rgba(255, 255, 255, 0.04); color:var(--color-foreground-muted, #9ca3af); font:inherit; font-size:11px; font-weight:550;
		cursor:pointer; transition:all 0.15s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.zg-presets button:hover { color:var(--color-foreground); background:rgba(255, 255, 255, 0.09); border-color:rgba(255, 255, 255, 0.15); }
	.zg-presets button.active {
		color:var(--color-foreground); background:color-mix(in srgb, var(--accent, #7fa4ff) 22%, transparent);
		border-color:var(--accent, #7fa4ff); font-weight:650; box-shadow:0 0 10px color-mix(in srgb, var(--accent, #7fa4ff) 35%, transparent);
	}
	body.is-light .zg-presets button { background:rgba(0, 0, 0, 0.03); border-color:rgba(0, 0, 0, 0.07); }
	body.is-light .zg-presets button:hover { background:rgba(0, 0, 0, 0.06); }
	body.is-light .zg-presets button.active { background:color-mix(in srgb, var(--accent, #3b82f6) 18%, transparent); border-color:var(--accent, #3b82f6); }
	.zg-row.zg-dim { opacity:.45; pointer-events:none; }
	.zg-pop [hidden] { display:none !important; }
	.zg-foot { margin:8px 2px 2px; font-size:10.5px; line-height:1.45; color:var(--color-foreground-muted, #71717a); }

	@media (prefers-reduced-motion:reduce) { .zg-tiles { display:none; } .zg-rip.zg-live::after { animation:none; } body.zg-see .zg-trigger { animation:none; } body.zg-see .zg-trigger .zg-hint-dot { animation:none; } }
	`;

	const ICON = {
		drop: '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8C8 1.8 3.4 7 3.4 10a4.6 4.6 0 0 0 9.2 0C12.6 7 8 1.8 8 1.8z"/><path d="M5.8 10.4a2.3 2.3 0 0 0 2.2 2"/></svg>'
	};
	const ROWS = '.popover .menu-item, .mp-item';
	const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	let ui = null;

	function keep() {
		try {
			localStorage.setItem(KEY, JSON.stringify(prefs));
		} catch {
			/* storage unavailable */
		}
	}

	// Saved for the whole app (glass.json) and pushed to the other project pages; a slider
	// drag writes once it settles, not on every step.
	let saveTimer = 0;
	let saveFailed = false;
	function persist() {
		if (!native()) return;
		const failed = () => {
			if (!saveFailed) window.UI?.toast('Glass settings could not be saved. Try changing an option again.', 'error');
			saveFailed = true;
		};
		native().invoke('glass_prefs', { prefs }).then(saved => {
			if (saved === false) failed(); else saveFailed = false;
		}).catch(failed);
	}
	function save() {
		prefs.at = Date.now();
		keep();
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			persist();
		}, 200);
	}

	// Another project page changed the settings: show the same here.
	window.__zgSync = (next) => {
		const p = clean(next);
		if (p.at && p.at < prefs.at) return;
		prefs = p;
		keep();
		apply();
	};

	let panelsFrame = 0;
	let panelsLast = '';
	function schedulePanels() {
		if (!native() || !support.panelBlur || panelsFrame) return;
		panelsFrame = requestAnimationFrame(() => {
			panelsFrame = 0;
			const panels = [];
			if (level() > 0) for (const id of ['sidebar', 'auxiliary']) {
				const node = document.getElementById(id), rect = node?.getBoundingClientRect();
				if (rect && rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden') panels.push({ id, x: rect.x, y: rect.y, width: rect.width, height: rect.height });
			}
			const args = { viewport: { width: innerWidth, height: innerHeight }, panels }, signature = JSON.stringify(args);
			if (signature === panelsLast) return;
			void native().invoke('glass_panels', args).then(ok => { if (ok) panelsLast = signature; }).catch(() => undefined);
		});
	}
	window.__zgRefreshPanels = () => { panelsLast = ''; schedulePanels(); };
	function apply() {
		const s = document.body.style;
		const see = level() > 0;
		s.setProperty('--zg-o', (1 - level() / 100).toFixed(3));
		s.setProperty('--zg-haze', prefs.haze ? '1' : '0');
		document.body.classList.toggle('zg-see', see);
		document.body.classList.toggle('zg-full', level() === 100);
		s.setProperty('--zg-dim', (prefs.dim / 100).toFixed(2));
		// Blurry: Windows' Acrylic on this app's own window — the desktop behind stays as it is.
		setOsBlur(see && prefs.blur && support.blur);
		schedulePanels();
		if (see && prefs.matchColors && support.colors && !colors.url && !colors.failed) loadColors();
		if (!see || !prefs.autoSolid) document.body.classList.remove('zg-reading');
		applyAccent();
		if (ui && ui.pop) {
			for (const b of ui.pop.querySelectorAll('.zg-presets button')) b.classList.toggle('active', Number(b.dataset.t) === prefs.transparency);
		}
		if (ui && ui.trigger) {
			const val = ui.trigger.querySelector('.zg-hint-val');
			if (val) val.textContent = prefs.transparency + '%';
			if (see) {
				ui.trigger.title = `Liquid Glass: ${prefs.transparency}% transparent (Click to adjust or turn off)`;
				ui.trigger.setAttribute('aria-label', `Glass options, ${prefs.transparency}% transparent`);
			} else {
				ui.trigger.title = 'Liquid Glass: transparency, haze and blur';
				ui.trigger.setAttribute('aria-label', 'Glass options');
			}
		}
		if (ui) render();
	}

	/* ---------------------------------------------------------------- colours from the wallpaper */

	/**
	 * The most vivid colour family in the picture, as the app's accent: a 48 × 27 sample,
	 * hues in 24 buckets weighted by how saturated and mid-bright each pixel is.
	 */
	async function accentOf(url) {
		const img = new Image();
		img.src = url;
		await img.decode();
		const w = 48;
		const h = 27;
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const g = canvas.getContext('2d', { willReadFrequently: true });
		g.drawImage(img, 0, 0, w, h);
		const data = g.getImageData(0, 0, w, h).data;
		const buckets = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
		for (let i = 0; i < data.length; i += 4) {
			const r = data[i] / 255;
			const gr = data[i + 1] / 255;
			const b = data[i + 2] / 255;
			const max = Math.max(r, gr, b);
			const min = Math.min(r, gr, b);
			const l = (max + min) / 2;
			const d = max - min;
			if (d < 0.08) continue; // greys carry no colour
			const s = d / (1 - Math.abs(2 * l - 1));
			let hue = max === r ? ((gr - b) / d) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
			hue = (hue * 60 + 360) % 360;
			const weight = s * s * Math.max(0, 1 - Math.abs(l - 0.5) * 1.6);
			const bucket = buckets[Math.floor(hue / 15) % 24];
			bucket.weight += weight;
			bucket.r += data[i] * weight;
			bucket.g += data[i + 1] * weight;
			bucket.b += data[i + 2] * weight;
		}
		const best = buckets.reduce((a, b) => (b.weight > a.weight ? b : a));
		if (best.weight < 0.5) return null; // a near-grey picture: keep the theme's accent
		const r = best.r / best.weight / 255;
		const gr = best.g / best.weight / 255;
		const b = best.b / best.weight / 255;
		const max = Math.max(r, gr, b);
		const min = Math.min(r, gr, b);
		const d = max - min || 1e-6;
		let hue = max === r ? ((gr - b) / d) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4;
		hue = Math.round((hue * 60 + 360) % 360);
		const sat = Math.round(Math.min(85, Math.max(48, (d / (1 - Math.abs(max + min - 1))) * 100)));
		return { hue, sat };
	}

	const tint = { key: '', value: null, busy: false };
	function applyAccent() {
		const s = document.body.style;
		const on = prefs.matchColors && support.colors && level() > 0 && !!colors.url && !colors.failed;
		if (!on) {
			for (const k of ['--accent', '--accent-strong', '--accent-soft']) s.removeProperty(k);
			return;
		}
		if (tint.key !== colors.url) {
			if (tint.busy) return;
			tint.busy = true;
			accentOf(colors.url)
				.then((v) => {
					tint.key = colors.url;
					tint.value = v;
				})
				.catch(() => {
					tint.key = colors.url;
					tint.value = null;
				})
				.finally(() => {
					tint.busy = false;
					applyAccent();
				});
			return;
		}
		if (!tint.value) {
			for (const k of ['--accent', '--accent-strong', '--accent-soft']) s.removeProperty(k);
			return;
		}
		// Readable on the theme: lighter on dark themes, deeper on light ones.
		const light = document.body.classList.contains('is-light');
		const l = light ? 44 : 62;
		const { hue, sat } = tint.value;
		s.setProperty('--accent', 'hsl(' + hue + ' ' + sat + '% ' + l + '%)');
		s.setProperty('--accent-strong', 'hsl(' + hue + ' ' + sat + '% ' + (light ? l - 8 : l + 10) + '%)');
		s.setProperty('--accent-soft', 'hsl(' + hue + ' ' + sat + '% ' + l + '% / .16)');
	}

	/* ---------------------------------------------------------------- solid while reading */

	let readTimer = 0;
	function reading(ms) {
		if (!prefs.autoSolid || level() === 0) return;
		document.body.classList.add('zg-reading');
		clearTimeout(readTimer);
		readTimer = setTimeout(() => document.body.classList.remove('zg-reading'), ms);
	}

	/* ---------------------------------------------------------------- blur and desktop colours */

	let osBlur = null;
	function setOsBlur(on) {
		if (osBlur === on || !native()) return;
		osBlur = on;
		native().invoke('glass_blur', { on }).catch(() => undefined);
	}

	// The desktop picture, read only for its colours (Match colors); it is never drawn.
	const colors = { url: '', modified: 0, loading: false, failed: false };
	function loadColors() {
		if (colors.loading || !native()) return;
		colors.loading = true;
		native()
			.invoke('desktop_wallpaper', { since: colors.url ? colors.modified : null })
			.then((r) => {
				colors.loading = false;
				colors.failed = !r;
				if (r && !r.unchanged && r.url) {
					colors.url = r.url;
					colors.modified = r.modified || 0;
				}
				applyAccent();
			})
			.catch(() => {
				colors.loading = false;
				colors.failed = true;
				applyAccent();
			});
	}

	/* ---------------------------------------------------------------- the options popup */

	function build() {
		const pop = document.createElement('div');
		pop.className = 'zg-pop';
		pop.id = 'zg-options';
		pop.setAttribute('popover', 'auto');
		pop.setAttribute('role', 'dialog');
		pop.setAttribute('aria-label', 'Glass options');
		pop.innerHTML =
			'<div class="zg-pop-head"><span class="zg-pop-icon">' + ICON.drop + '</span><div><b>Liquid Glass</b><small>See-through window over your desktop picture</small></div></div>' +
			'<div class="zg-row zg-stack zg-opt-t"><span class="zg-row-text"><b id="zg-t-label">Transparency</b><small>0% is the normal solid window, 100% is clear glass over your desktop.</small></span>' +
			'<span class="zg-slide"><input type="range" class="zg-t" min="0" max="100" step="1" aria-labelledby="zg-t-label"><output class="zg-t-out"></output></span>' +
			'<span class="zg-presets"><button data-t="0">0%</button><button data-t="25">25%</button><button data-t="50">50%</button><button data-t="75">75%</button><button data-t="100">100%</button></span></div>' +
			'<label class="zg-row zg-opt-t"><span class="zg-row-text"><b>Bottom haze</b><small>Darkens toward the bottom so the chat stays readable</small></span><span class="switch"><input type="checkbox" class="zg-haze-cb" role="switch"><span class="track"></span></span></label>' +
			'<label class="zg-row zg-need-t zg-opt-blur"><span class="zg-row-text"><b>Blurry</b><small>Frosted glass: blurs what is behind the window</small></span><span class="switch"><input type="checkbox" class="zg-blur-cb" role="switch"><span class="track"></span></span></label>' +
			'<div class="zg-row zg-stack zg-need-t"><span class="zg-row-text"><b id="zg-b-label">Background brightness</b><small>Darkens what shows through so text stays easy to read</small></span>' +
			'<span class="zg-slide"><input type="range" class="zg-b" min="20" max="100" step="1" aria-labelledby="zg-b-label"><output class="zg-b-out"></output></span></div>' +
			'<label class="zg-row zg-need-t"><span class="zg-row-text"><b>Solid while reading</b><small>Turns nearly solid while you scroll or type, then back to glass</small></span><span class="switch"><input type="checkbox" class="zg-solid-cb" role="switch"><span class="track"></span></span></label>' +
			'<label class="zg-row zg-need-t zg-opt-colors"><span class="zg-row-text"><b>Match colors to the wallpaper</b><small>The accent follows your desktop picture colours (only read, never shown)</small></span><span class="switch"><input type="checkbox" class="zg-match-cb" role="switch"><span class="track"></span></span></label>' +
			'<p class="zg-foot zg-wall-desc"></p>';
		const t = pop.querySelector('.zg-t');
		t.addEventListener('input', () => {
			prefs.transparency = Number(t.value);
			apply();
			save();
		});
		for (const b of pop.querySelectorAll('[data-t]')) {
			b.addEventListener('click', () => {
				prefs.transparency = Number(b.dataset.t);
				apply();
				save();
			});
		}
		const bright = pop.querySelector('.zg-b');
		bright.addEventListener('input', () => {
			prefs.dim = 100 - Number(bright.value);
			apply();
			save();
		});
		pop.querySelector('.zg-solid-cb').addEventListener('change', (e) => {
			prefs.autoSolid = e.target.checked;
			apply();
			save();
		});
		pop.querySelector('.zg-match-cb').addEventListener('change', (e) => {
			prefs.matchColors = e.target.checked;
			apply();
			save();
		});
		pop.querySelector('.zg-haze-cb').addEventListener('change', (e) => {
			prefs.haze = e.target.checked;
			apply();
			save();
		});
		pop.querySelector('.zg-blur-cb').addEventListener('change', (e) => {
			prefs.blur = e.target.checked;
			apply();
			save();
		});
		pop.addEventListener('toggle', (e) => {
			const open = e.newState === 'open';
			ui.trigger.classList.toggle('zg-active', open);
			ui.trigger.setAttribute('aria-expanded', String(open));
			if (open) {
				render();
				place();
			}
		});
		return pop;
	}

	function place() {
		const r = ui.trigger.getBoundingClientRect();
		const w = Math.min(300, innerWidth - 16);
		ui.pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
		ui.pop.style.top = Math.round(r.bottom + 8) + 'px';
	}

	function render() {
		const t = ui.pop.querySelector('.zg-t');
		if (document.activeElement !== t) t.value = String(prefs.transparency);
		t.style.setProperty('--zg-p', prefs.transparency + '%');
		t.setAttribute('aria-valuetext', prefs.transparency + '% transparent');
		ui.pop.querySelector('.zg-t-out').textContent = prefs.transparency + '%';
		ui.pop.querySelector('.zg-haze-cb').checked = prefs.haze;
		ui.pop.querySelector('.zg-blur-cb').checked = prefs.blur;
		ui.pop.querySelector('.zg-blur-cb').disabled = false;
		ui.pop.querySelector('.zg-solid-cb').checked = prefs.autoSolid;
		ui.pop.querySelector('.zg-match-cb').checked = prefs.matchColors;
		const b = ui.pop.querySelector('.zg-b');
		if (document.activeElement !== b) b.value = String(100 - prefs.dim);
		b.style.setProperty('--zg-p', ((100 - prefs.dim - 20) / 80) * 100 + '%');
		b.setAttribute('aria-valuetext', 100 - prefs.dim + '% brightness');
		ui.pop.querySelector('.zg-b-out').textContent = 100 - prefs.dim + '%';
		for (const row of ui.pop.querySelectorAll('.zg-need-t')) row.classList.toggle('zg-dim', prefs.transparency === 0);
		for (const b of ui.pop.querySelectorAll('.zg-presets button')) b.classList.toggle('active', Number(b.dataset.t) === prefs.transparency);
		if (ui.trigger) {
			const val = ui.trigger.querySelector('.zg-hint-val');
			if (val) val.textContent = prefs.transparency + '%';
			if (level() > 0) {
				ui.trigger.title = `Liquid Glass: ${prefs.transparency}% transparent (Click to adjust or turn off)`;
				ui.trigger.setAttribute('aria-label', `Glass options, ${prefs.transparency}% transparent`);
			}
		}
		const show = (sel, on) => ui.pop.querySelectorAll(sel).forEach((el) => (el.hidden = !on));
		show('.zg-opt-t, .zg-need-t', support.transparent);
		show('.zg-opt-blur', support.transparent && support.blur);
		show('.zg-opt-colors', support.transparent && support.colors);
		ui.pop.querySelector('.zg-wall-desc').textContent = !support.transparent
			? 'This desktop cannot show windows see-through (no compositor is running), so the window stays solid. The glass menus still apply.'
			: support.hideIcons ? 'Windows desktop icons hide while Glass is transparent (and taskbar in full screen). They return at 0%, when minimized, hidden to the tray or quit.' : 'Your real desktop shows through the window.';
	}

	/* ---------------------------------------------------------------- pixel-tile ripple */

	/** Gold for Max, purple for Ultra (as in the reference), the accent colour otherwise. */
	function tone(row) {
		const text = (row.textContent || '').trim().slice(0, 28);
		if (/\bmax\b/i.test(text)) return '#f4b942';
		if (/\bultra\b/i.test(text)) return '#a855f7';
		return 'var(--accent, #7fa4ff)';
	}

	/** A 32 × 5 grid; each lit tile's delay grows with its distance from the pointer. */
	function ripple(row, x, y) {
		if (reducedMotion()) return;
		row.querySelectorAll(':scope > .zg-tiles').forEach((t) => t.remove());
		const r = row.getBoundingClientRect();
		if (r.width < 40 || r.height < 16) return;
		const cx = Math.max(0, Math.min(1, (x - r.left) / r.width)) * 31;
		const cy = Math.max(0, Math.min(1, (y - r.top) / r.height)) * 4;
		const tiles = document.createElement('span');
		tiles.className = 'zg-tiles';
		tiles.setAttribute('aria-hidden', 'true');
		for (let j = 0; j < 5; j++) {
			for (let i = 0; i < 32; i++) {
				const tile = document.createElement('i');
				const d = Math.hypot((i - cx) / 6, (j - cy) / 2.2);
				// A ragged wave: most tiles near the pointer light, fewer further away.
				if (Math.random() < Math.max(0.06, 0.45 - d * 0.14)) {
					tile.className = 'zg-lit';
					tile.style.setProperty('--d', d.toFixed(2));
				}
				tiles.appendChild(tile);
			}
		}
		row.style.setProperty('--zg-tone', tone(row));
		row.classList.add('zg-rip');
		row.classList.remove('zg-live');
		void row.offsetWidth;
		row.classList.add('zg-live');
		row.insertBefore(tiles, row.firstChild);
	}

	function settle(row) {
		row.classList.remove('zg-live');
		const tiles = row.querySelector(':scope > .zg-tiles');
		if (!tiles) return;
		tiles.classList.add('zg-out');
		setTimeout(() => tiles.remove(), 240);
	}

	/* ---------------------------------------------------------------- start */

	function init() {
		const app = document.getElementById('app');
		const tools = document.querySelector('.topbar-right');
		if (!document.body.classList.contains('desktop') || !app || !tools || ui) return;
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(CSS);
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
		document.documentElement.classList.add('zg-html');
		document.body.classList.add('zg-on');

		// Bottom to top: the dimmer, the tint, the reading layer, the haze — all below the content.
		const first = app.firstChild;
		for (const cls of ['zg-dimmer', 'zg-surface', 'zg-solid', 'zg-haze']) {
			const layer = document.createElement('div');
			layer.className = cls;
			layer.setAttribute('aria-hidden', 'true');
			app.insertBefore(layer, first);
		}
		// A new desktop picture (or a Spotlight change) re-tunes the accent when the window gets focus.
		addEventListener('focus', () => level() > 0 && prefs.matchColors && support.colors && loadColors());

		// Solid while reading: scrolling the chat, or typing in the composer.
		document.addEventListener('wheel', (e) => e.target instanceof Element && e.target.closest('#messages, .conversation') && reading(1600), { passive: true });
		document.addEventListener('keydown', (e) => {
			const t = e.target instanceof Element ? e.target : null;
			if (t && t.closest('#input')) reading(2400);
			else if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key) && t && t.closest('#messages, .conversation, body')) reading(1600);
		});
		document.addEventListener('pointerdown', (e) => e.target instanceof Element && e.target.closest('#input') && reading(2400));

		// A theme switch (light ↔ dark) re-tunes the accent for contrast.
		let light = document.body.classList.contains('is-light');
		new MutationObserver(() => {
			const now = document.body.classList.contains('is-light');
			if (now !== light) {
				light = now;
				applyAccent();
			}
		}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

		const trigger = document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'icon-btn zg-trigger';
		trigger.title = 'Liquid Glass: transparency, haze and blur';
		trigger.setAttribute('aria-label', 'Glass options');
		trigger.setAttribute('aria-haspopup', 'dialog');
		trigger.setAttribute('aria-expanded', 'false');
		trigger.setAttribute('aria-controls', 'zg-options');
		trigger.innerHTML = ICON.drop + '<span class="zg-hint" aria-hidden="true"><span class="zg-hint-dot"></span><span class="zg-hint-text"><span class="zg-hint-label">Glass</span> <span class="zg-hint-val">' + (level() > 0 ? level() + '%' : '') + '</span></span></span>';
		tools.insertBefore(trigger, tools.firstChild);

		ui = { trigger, pop: null };
		ui.pop = build();
		document.body.appendChild(ui.pop);
		trigger.addEventListener('click', () => (ui.pop.matches(':popover-open') ? ui.pop.hidePopover() : ui.pop.showPopover()));
		addEventListener('resize', () => ui.pop.matches(':popover-open') && place());
		apply();
		if (push) persist();
		const panelsObserver = new MutationObserver(schedulePanels);
		panelsObserver.observe(app, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
		if (window.ResizeObserver) {
			const sizes = new ResizeObserver(schedulePanels);
			for (const id of ['sidebar', 'auxiliary']) { const node = document.getElementById(id); if (node) sizes.observe(node); }
		}
		addEventListener('resize', schedulePanels);

		document.addEventListener('pointerover', (e) => {
			const row = e.target instanceof Element ? e.target.closest(ROWS) : null;
			if (!row || (e.relatedTarget instanceof Node && row.contains(e.relatedTarget))) return;
			ripple(row, e.clientX, e.clientY);
		});
		document.addEventListener('pointerout', (e) => {
			const row = e.target instanceof Element ? e.target.closest(ROWS) : null;
			if (!row || (e.relatedTarget instanceof Node && row.contains(e.relatedTarget))) return;
			settle(row);
		});
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
	else init();
})();
