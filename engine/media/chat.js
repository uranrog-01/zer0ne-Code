/*
 * Chat column UI (sidebar webview and Mobile Remote). Talks to the host
 * only through window.Bridge; has no network or file access of its own.
 *
 * Layout per turn (Codex style):
 *   user bubble
 *   "Worked for 3m 20s ›"   ← collapsible: thinking, tool rows, approvals
 *   final answer            ← modern typography, copy + time footer
 *   "Edited 3 files +102 −79  [Undo] [Review]"
 * The running turn shows its steps live plus a shimmering status line
 * ("Editing chatClient.ts…"). Rendering is keyed and incremental so
 * selection, expanded rows and scroll position survive updates.
 */
(function () {
	'use strict';

	// This script's nonce and URL: used to lazy-load mermaid.min.js next to it.
	const SELF = document.currentScript;
	const NONCE = SELF ? SELF.nonce || SELF.getAttribute('nonce') || '' : '';
	const MERMAID_SRC = SELF && SELF.src ? SELF.src.replace(/chat\.js(\?.*)?$/, 'mermaid.min.js') : 'mermaid.min.js';

	const B = window.Bridge;
	const I = window.Icons.svg;
	const MD = window.Markdown;
	const esc = MD.escape;
	const t = (k, v) => window.t(k, v);
	const post = (m) => B.post(m);
	const chatBranch = window.ChatBranch.create({ post, icon: I, state: () => state });
	window.ComputerUse?.create({B,I});
	window.__zcProjectActions = window.ChatProjectActions.create({ post, menu: popMenu, item, navigate: bindMenuNavigation, session: id => projectChatById.get(id) || state.sessions.find(s => s.id === id), files: () => {
		auxFiles.preview = null; auxFiles.filter = ''; auxFiles.editedOnly = false; $('aux-explorer-filter').value = '';
		togglePanel('auxiliary', true); $('aux-tab-explorer').click(); $('aux-explorer-filter').focus();
	} });

	const persisted = B.getState();
	const composerDrafts = new Map(Object.entries(persisted.composerDrafts || {}).filter(([, value]) => typeof value === 'string'));
	const state = {
		providers: [],
		selection: {},
		modelPreferences: { favorites: [], recent: [] },
		settings: {},
		subagentWorkflow: { enabled: false, workerModel: '', reviewerModel: '', maxConcurrency: 2 },
		mode: 'agent',
		messages: [],
		chapters: [],
		isStreaming: false,
		streaming: null,
		queue: [],
		sessions: [],
		folders: [],
		currentSessionId: undefined,
		attachments: [],
		context: null,
		hasWorkspace: true,
		skills: [],
		mcp: [],
		mic: {},
		undoable: [],
		isRemote: B.remote
	};
	/** Rejected commands already turned into a project rule (their suggestion is not shown again). */
	const ruleAdded = new Set();
	const ui = {
		open: null,
		stick: true,
		modelQuery: '',
		expanded: new Set(),
		popup: null,
		composing: false,
		files: [],
		filesAt: 0,
		historyOpen: false,
		historyQuery: '',
		historyFilter: 'all',
		/** Project folder selected in the Library row; null follows the window's own project. */
		historyProject: null,
		historySort: ['newest', 'oldest', 'title', 'prompts'].includes(persisted.historySort) ? persisted.historySort : 'newest',
		historySelecting: false,
		historySelected: new Set(),
		collapsedFolders: new Set(persisted.collapsedFolders || []),
		plan: !!persisted.planMode,
		/** A local image / video model picked in the model menu ({ id, name, kind }): prompts open the generation popup. */
		media: persisted.mediaModel && persisted.mediaModel.id ? persisted.mediaModel : null,
		/** Local Models → Studio models (stable-diffusion.cpp): installed bundles, the loaded one. */
		studio: null,
		// 0.23: the progress panel starts collapsed (a pill); expand it on demand.
		progressMode: persisted.progressV23 ? persisted.progressMode || 'pill' : 'pill',
		progressLast: persisted.progressLast || 'floating',
		streamStartedAt: 0,
		// Reasoning blocks: which are open, the texts whose live block was open, the live step's clock.
		thinkOpen: new Map(),
		carryThink: new Map(),
		thinkSources: new Set(),
		thinkSearchStarts: new Map(),
		liveReasoning: '',
		thinkStartedAt: 0,
		thinkMs: 0,
		// Streamed answer chunks still fading in: { start, end, at }.
		// Agent tree cards whose sub-agents are folded to one line.
		agentFold: new Set()
	};
	ui.statsOpen = !!persisted.statsOpen;
	ui.statsPopup = null;

	const $ = (id) => document.getElementById(id);
	const el = {
		app: $('app'),
		title: $('session-title'),
		messages: $('messages'),
		progress: $('progress'),
		scrollBottom: $('btn-scroll-bottom'),
		input: $('input'),
		inputCard: $('input-card'),
		attachments: $('attachments'),
		queue: $('queue'),

		send: $('btn-send'),
		mic: $('btn-mic'),
		plan: $('btn-plan'),
		plus: $('btn-plus'),
		plusMenu: $('plus-menu'),
		mode: $('btn-mode'),
		modeIcon: $('mode-icon'),
		modeLabel: $('mode-label'),
		modeMenu: $('mode-menu'),
		model: $('btn-model'),
		modelLabel: $('model-label'),
		modelMenu: $('model-menu'),
		effort: $('btn-effort'),
		effortLabel: $('effort-label'),
		effortMenu: $('effort-menu'),
		ctx: $('btn-context'),
		ctxMenu: $('context-menu'),
		popup: $('mention-popup'),
		history: $('history'),
		historyList: $('history-list'),
		historySearch: $('history-search'),
		sidebar: $('sidebar'),
		auxiliary: $('auxiliary'),
		lightbox: $('lightbox'),
		lightboxImg: $('lightbox-img'),
		lightboxCap: $('lightbox-cap')
	};

	// ------------------------------------------------------------ helpers

	function h(tag, cls, html) {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (html !== undefined) node.innerHTML = html;
		return node;
	}

	function fmtTokens(n) {
		if (!n) return '0';
		if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 || n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
		return String(n);
	}

	function createImageViewer(root) {
		const image = root.querySelector('img'), viewport = root.querySelector('.lightbox-viewport');
		const caption = root.querySelector('.lightbox-cap'), output = root.querySelector('output');
		const error = root.querySelector('.lightbox-error'), closeButton = root.querySelector('[data-image-action="close"]');
		let scale = 1, x = 0, y = 0, drag = null, opener = null, shielded = [];
		const visible = () => !root.classList.contains('hidden');
		const maximum = () => Math.max(4, Math.min(16, image.naturalWidth / (image.offsetWidth || 1)));
		function paint() {
			const maxX = Math.max(0, (image.offsetWidth * scale - viewport.clientWidth) / 2);
			const maxY = Math.max(0, (image.offsetHeight * scale - viewport.clientHeight) / 2);
			x = Math.max(-maxX, Math.min(maxX, x)); y = Math.max(-maxY, Math.min(maxY, y));
			image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
			root.classList.toggle('zoomed', scale > 1);
			output.textContent = Math.round(scale * 100) + '%';
			root.querySelector('[data-image-action="out"]').disabled = scale <= 1;
			root.querySelector('[data-image-action="in"]').disabled = scale >= maximum();
		}
		function fit() { scale = 1; x = y = 0; paint(); }
		function zoom(next, clientX, clientY) {
			if (!image.naturalWidth || !image.offsetWidth) return;
			const bounds = viewport.getBoundingClientRect();
			const anchorX = clientX === undefined ? 0 : clientX - bounds.left - bounds.width / 2;
			const anchorY = clientY === undefined ? 0 : clientY - bounds.top - bounds.height / 2;
			const target = Math.max(1, Math.min(maximum(), next)), ratio = target / scale;
			x = anchorX - (anchorX - x) * ratio; y = anchorY - (anchorY - y) * ratio;
			scale = target; paint();
		}
		function endDrag() {
			const pointer = drag?.id; drag = null; root.classList.remove('panning');
			if (pointer !== undefined && viewport.hasPointerCapture?.(pointer)) viewport.releasePointerCapture(pointer);
		}
		function close() {
			if (!visible()) return;
			endDrag(); root.classList.add('hidden');
			for (const [node, inert] of shielded) node.inert = inert;
			shielded = [];
			(opener?.isConnected ? opener : document.getElementById('input'))?.focus({ preventScroll: true });
			opener = null;
		}
		function open(src, label, trigger) {
			if (!visible()) {
				opener = trigger || document.activeElement;
				shielded = [...root.parentElement.children].filter(node => node !== root).map(node => [node, node.inert]);
				for (const [node] of shielded) node.inert = true;
			}
			endDrag(); root.classList.remove('hidden'); error.classList.add('hidden'); image.classList.remove('hidden');
			caption.textContent = label || ''; image.alt = label || 'Image preview';
			image.src = src; fit(); closeButton.focus({ preventScroll: true });
		}
		image.addEventListener('load', () => { if (visible()) { error.classList.add('hidden'); image.classList.remove('hidden'); fit(); } });
		image.addEventListener('error', () => { if (visible()) { image.classList.add('hidden'); error.classList.remove('hidden'); } });
		viewport.addEventListener('wheel', event => {
			event.preventDefault();
			const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
			zoom(scale * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.01), event.clientX, event.clientY);
		}, { passive: false });
		viewport.addEventListener('dblclick', event => {
			if (event.target !== image) return;
			event.preventDefault(); scale > 1 ? fit() : zoom(2, event.clientX, event.clientY);
		});
		viewport.addEventListener('pointerdown', event => {
			if (event.button !== 0 || scale <= 1 || drag) return;
			event.preventDefault(); drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
			viewport.setPointerCapture(event.pointerId);
		});
		viewport.addEventListener('pointermove', event => {
			if (!drag || drag.id !== event.pointerId) return;
			const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
			if (Math.hypot(dx, dy) < 4 && !root.classList.contains('panning')) return;
			root.classList.add('panning'); x = drag.x + dx; y = drag.y + dy; paint();
		});
		for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) viewport.addEventListener(name, endDrag);
		root.addEventListener('click', event => {
			const action = event.target.closest('[data-image-action]')?.dataset.imageAction;
			if (action === 'close' || event.target === root) close();
			else if (action === 'fit') fit();
			else if (action) zoom(scale * (action === 'in' ? 1.25 : 0.8));
		});
		root.addEventListener('keydown', event => {
			if (event.isComposing || event.keyCode === 229) return;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
			if (event.key === 'Tab') {
				const buttons = [...root.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
				event.preventDefault(); buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus(); return;
			}
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
				event.preventDefault();
				if (event.key === '0') fit();
				else if (event.key === '+' || event.key === '=') zoom(scale * 1.25);
				else if (event.key === '-') zoom(scale * 0.8);
				else { const step = event.shiftKey ? 100 : 40; x += event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0; y += event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0; paint(); }
			}
		});
		new ResizeObserver(() => { if (visible()) paint(); }).observe(viewport);
		window.addEventListener('blur', endDrag);
		return { open, close };
	}

	function fmtDuration(ms) {
		const s = Math.max(1, Math.round(ms / 1000));
		if (s < 60) return s + 's';
		const m = Math.floor(s / 60);
		if (m < 60) return m + 'm ' + (s % 60) + 's';
		return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
	}

	const fmtTime = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	/** "Tue, Sep 29, 2026 · 1:30 PM" — shown under your own prompt on hover, Codex-style. */
	const fmtStamp = (ts) => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + fmtTime(ts);
	const providerById = (id) => state.providers.find((p) => p.id === id);
	const basename = (p) => String(p || '').split(/[\\/]/).pop();

	function selected() {
		const provider = providerById(state.selection.providerId);
		const model = provider && provider.models.find((m) => m.id === state.selection.model);
		return { provider, model };
	}

	async function copyText(text, button) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			const ta = document.createElement('textarea');
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		// Message Actions buttons morph their own icon to a check and flash "Copied" in their tooltip.
		if (button && button.classList.contains('mac-btn')) {
			const item = button.parentElement;
			const tip = item.querySelector('.mac-tip');
			clearTimeout(button._copyTimer);
			button.dataset.done = '';
			item.dataset.flash = '';
			tip.textContent = 'Copied';
			button.setAttribute('aria-label', 'Copied');
			button._copyTimer = setTimeout(() => {
				delete button.dataset.done;
				delete item.dataset.flash;
				tip.textContent = button.dataset.label;
				button.setAttribute('aria-label', button.dataset.label);
			}, 1600);
			return;
		}
		if (button) {
			if (button._copyHtml === undefined) button._copyLabel = button.getAttribute('aria-label');
			const old = button._copyHtml || button.innerHTML;
			button._copyHtml = old;
			clearTimeout(button._copyTimer);
			button.innerHTML = button.classList.contains('code-btn') ? I('check') + '<span>Copied</span>' : I('check');
			button.classList.add('copied');
			button.setAttribute('aria-label', 'Copied');
			button._copyTimer = setTimeout(() => {
				button.classList.remove('copied'); button.innerHTML = old;
				if (button._copyLabel === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', button._copyLabel);
				delete button._copyHtml; delete button._copyLabel;
			}, 2500);
		}
	}

	/*
	 * Toasts (Toaster style): a card whose status mark draws itself (check, cross, info or
	 * warning), a hairline that runs down the time left, a close button on hover, and a
	 * timer that pauses while the pointer rests on it.
	 */
	const TOAST_MARK = '<svg viewBox="0 0 24 24" class="toast-status" aria-hidden="true"><circle class="toast-ring" cx="12" cy="12" r="9.25" pathLength="1"/><path class="toast-mark toast-check" d="M8.3 12.4l2.5 2.5 4.9-5.3" pathLength="1"/><path class="toast-mark toast-x1" d="M9.5 9.5l5 5" pathLength="1"/><path class="toast-mark toast-x2" d="M14.5 9.5l-5 5" pathLength="1"/><path class="toast-info" d="M12 11.2v4.6M12 8.2h.01"/><path class="toast-warn" d="M12 7.6v5M12 15.9h.01"/></svg>';
	const toastClock = { timer: 0, left: 0, at: 0 };
	function hideToast() {
		const node = $('toast');
		clearTimeout(toastClock.timer);
		if (node.classList.contains('hidden')) return;
		node.classList.add('leaving');
		toastClock.timer = setTimeout(() => node.classList.add('hidden'), 240);
	}
	function runToastClock(ms) {
		clearTimeout(toastClock.timer);
		toastClock.left = ms;
		toastClock.at = Date.now();
		toastClock.timer = setTimeout(hideToast, ms);
	}
	function toast(message, kind) {
		if (!message) return;
		const node = $('toast');
		const type = kind === 'ok' ? 'success' : kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'info';
		const ms = kind === 'error' ? 7000 : kind === 'warn' ? 5000 : 3500;
		node.className = 'toast ' + (kind || '');
		node.style.setProperty('--toast-ms', ms + 'ms');
		node.innerHTML = '<span class="toast-icon" data-type="' + type + '">' + TOAST_MARK + '</span><span class="toast-text">' + esc(message) + '</span><button type="button" class="toast-close" aria-label="' + esc(t('close')) + '">' + I('close') + '</button><span class="toast-timer" aria-hidden="true"></span>';
		node.querySelector('.toast-close').addEventListener('click', hideToast);
		runToastClock(ms);
	}
	{
		const node = $('toast');
		node.addEventListener('mouseenter', () => {
			if (node.classList.contains('hidden') || node.classList.contains('leaving')) return;
			clearTimeout(toastClock.timer);
			toastClock.left = Math.max(800, toastClock.left - (Date.now() - toastClock.at));
			node.classList.add('paused');
		});
		node.addEventListener('mouseleave', () => {
			if (!node.classList.contains('paused')) return;
			node.classList.remove('paused');
			runToastClock(toastClock.left);
		});
	}
	window.UI = { toast };

	function saveUi() {
		if (state.currentSessionId) {
			if (el.input.value) composerDrafts.set(state.currentSessionId, el.input.value);
			else composerDrafts.delete(state.currentSessionId);
		}
		B.patchState({ draft: el.input.value, draftSessionId: state.currentSessionId, composerDrafts: Object.fromEntries(composerDrafts), planMode: ui.plan, progressMode: ui.progressMode, progressLast: ui.progressLast, progressV23: true, collapsedFolders: [...ui.collapsedFolders], historySort: ui.historySort, mediaModel: ui.media });
	}

	function switchComposerSession(id) {
		if (ui.composing) {
			const draft = el.input.value;
			el.input.blur?.();
			el.input.value = draft;
			ui.composing = false;
		}
		if (state.currentSessionId) saveUi();
		// Adopt old unscoped drafts once; a persisted scoped draft cannot move to another chat.
		const legacy = !state.currentSessionId && (!persisted.draftSessionId || persisted.draftSessionId === id) ? el.input.value : '';
		el.input.value = composerDrafts.get(id) ?? legacy;
		autosize();
	}

	function discardComposerDraft(id) {
		composerDrafts.delete(id);
		if (id === state.currentSessionId) { el.input.value = ''; autosize(); }
		saveUi();
	}

	function openSettings(section) {
		closeMenus();
		// Desktop: full-size settings in the editor area. Phone: in-page popup.
		if ((B.remote || B.desktop) && window.Settings) window.Settings.open(section);
		else post({ type: 'openSettings', section });
	}

	// First-run setup: the zero-key local path and its key fallback. It owns its own
	// host-message listener; chat.js only opens it and provides the composer actions.
	const setup = window.ChatSetup?.create({
		post,
		t,
		state: () => state,
		startTask: (text) => startTask(text),
		sendTask: (text) => sendTask(text),
		openSettings,
		remote: !!B.remote
	});
	// Test code extracts single functions from this file; a window handle keeps the
	// optional lookup valid there without a lexical binding.
	window.__zcSetup = setup;

	// ------------------------------------------------------------ static labels (i18n)

	function applyLabels() {
		// Work Details tabs show only their icon until opened: their names become tooltips.
		for (const tab of document.querySelectorAll('.auxiliary-tab')) if (!tab.title) tab.title = tab.textContent.trim();
		$('btn-history').title = t('history');
		$('btn-history').setAttribute('aria-label', t('history'));
		$('btn-new').title = t('newChat');
		$('btn-settings').title = t('settings');
		$('btn-more').title = t('more');
		$('history-title').textContent = t('history');
		$('btn-folder-new').title = t('newFolder');
		el.historySearch.placeholder = t('searchChats');
		el.historySearch.setAttribute('aria-label', t('searchChats'));
		$('history-sort').setAttribute('aria-label', t('sortChats'));
		$('history-select-all').setAttribute('aria-label', t('selectMatching'));
		$('history-search-clear').setAttribute('aria-label', t('clearSearch'));
		$('history-search-clear').title = t('clearSearch');
		$('history-reset').textContent = t('resetFilters');
		$('history-move-label').textContent = t('move');
		$('plan-label').textContent = t('planMode');
		el.ctx.title = t('contextWindow');
		el.effort.title = t('reasoningEffort');
	}

	// ------------------------------------------------------------ audio

	let audio;
	function chime(kind) {
		try {
			audio = audio || new AudioContext();
			const now = audio.currentTime;
			(kind === 'done' ? [660, 880] : [880, 660, 880]).forEach((f, i) => {
				const o = audio.createOscillator();
				const g = audio.createGain();
				o.frequency.value = f;
				g.gain.setValueAtTime(0.0001, now + i * 0.12);
				g.gain.exponentialRampToValueAtTime(0.08, now + i * 0.12 + 0.02);
				g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.2);
				o.connect(g).connect(audio.destination);
				o.start(now + i * 0.12);
				o.stop(now + i * 0.12 + 0.22);
			});
		} catch {
			/* audio unavailable */
		}
	}

	// ------------------------------------------------------------ scrolling

	const atBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 32;
	let bottomFrame = 0;
	function scrollToBottom() {
		el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'auto' });
		scrollEdges();
		if (!bottomFrame) bottomFrame = requestAnimationFrame(() => {
			bottomFrame = 0;
			if (!ui.stick) return;
			// Composer and transcript layout can settle after the synchronous paint.
			el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'auto' });
			scrollEdges();
		});
	}
	let userScrollUntil = 0;
	function followLatest() {
		userScrollUntil = 0;
		readingAnchor = null;
		restoringScroll = false;
		ui.stick = true;
		el.scrollBottom.classList.add('hidden');
		scrollToBottom();
	}
	function scrollEdges() {
		el.messages.style.setProperty('--scroll-fade-top', el.messages.scrollTop > 8 ? '12px' : '0px');
		el.messages.style.setProperty('--scroll-fade-bottom', atBottom() ? '0px' : '12px');
	}
	function releaseScroll() {
		userScrollUntil = performance.now() + 150; ui.stick = false;
		rememberReadingPosition(); el.scrollBottom.classList.remove('hidden');
	}
	el.messages.addEventListener('wheel', event => { if (event.deltaY < 0) releaseScroll(); else userScrollUntil = 0; }, { passive: true });
	el.messages.addEventListener('touchstart', releaseScroll, { passive: true });
	el.messages.addEventListener('pointerdown', event => {
		const bounds = el.messages.getBoundingClientRect();
		if (event.target === el.messages && event.clientX >= bounds.right - Math.max(16, el.messages.offsetWidth - el.messages.clientWidth)) releaseScroll();
	}, { passive: true });
	el.messages.addEventListener('keydown', event => {
		if (!event.target.closest('button, input, textarea, [contenteditable="true"]') && ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) releaseScroll();
	});
	let readingAnchor = null, restoringScroll = false, restoredScrollTop = 0;
	let readingWidth = el.messages.clientWidth, readingHeight = el.messages.clientHeight;
	function rememberReadingPosition() {
		if (ui.stick || restoringScroll && el.messages.scrollTop === restoredScrollTop) return;
		restoringScroll = false;
		const top = el.messages.getBoundingClientRect().top;
		const blocks = [...el.messages.querySelectorAll('.md p, .md li, .md pre, .md tr, .md h1, .md h2, .md h3')];
		const node = blocks.find(n => n.getBoundingClientRect().bottom > top + 8);
		if (!node) return;
		const message = node.closest('.msg');
		if (!message?.id) return;
		const siblings = [...message.querySelectorAll('.md p, .md li, .md pre, .md tr, .md h1, .md h2, .md h3')];
		readingAnchor = { id: message.id, index: siblings.indexOf(node), offset: node.getBoundingClientRect().top - top };
	}
	function restoreReadingPosition() {
		scrollEdges();
		readingWidth = el.messages.clientWidth; readingHeight = el.messages.clientHeight;
		if (ui.stick) { scrollToBottom(); return; }
		if (!readingAnchor) return;
		const message = document.getElementById(readingAnchor.id);
		const node = message?.querySelectorAll('.md p, .md li, .md pre, .md tr, .md h1, .md h2, .md h3')[readingAnchor.index];
		if (!node) return;
		const delta = node.getBoundingClientRect().top - el.messages.getBoundingClientRect().top - readingAnchor.offset;
		if (Math.abs(delta) < 0.5) return;
		restoringScroll = true;
		el.messages.scrollTop += delta;
		restoredScrollTop = el.messages.scrollTop;
		requestAnimationFrame(() => { restoringScroll = false; });
	}
	el.messages.addEventListener('scroll', () => {
		scrollEdges();
		if (restoringScroll && el.messages.scrollTop === restoredScrollTop) return;
		restoringScroll = false;
		if (readingWidth !== el.messages.clientWidth || readingHeight !== el.messages.clientHeight) return;
		// Layout and programmatic scrolls must not cancel following; upward input does.
		if (!ui.stick && performance.now() >= userScrollUntil && atBottom()) {
			ui.stick = true;
			readingAnchor = null;
		}
		rememberReadingPosition();
		el.scrollBottom.classList.toggle('hidden', ui.stick);
	});
	el.scrollBottom.addEventListener('click', followLatest);
	new ResizeObserver(restoreReadingPosition).observe(el.messages);
	el.messages.addEventListener('load', restoreReadingPosition, true);

	// ------------------------------------------------------------ prompt navigation

	const promptNav = {
		rail: $('prompt-nav'), list: $('prompt-nav-list'), preview: $('prompt-preview'),
		title: $('prompt-preview-title'), answer: $('prompt-preview-answer'),
		items: [], session: undefined, hovered: null, frame: 0, highlightTimer: null
	};

	function promptSummary(message) {
		return String(message.content || '').trim() || (message.attachments || []).map((a) => a.name).filter(Boolean).join(', ') || t('attachmentPrompt');
	}

	function hidePromptPreview() {
		promptNav.hovered = null;
		promptNav.preview.classList.add('hidden');
	}

	function showPromptPreview(button) {
		const item = promptNav.items.find((x) => x.button === button);
		if (!item) return;
		promptNav.hovered = button;
		promptNav.title.textContent = promptSummary(item.message).slice(0, 400);
		const answer = item === promptNav.items[promptNav.items.length - 1] && state.isStreaming && state.streaming?.text ? state.streaming.text : item.answer;
		promptNav.answer.textContent = answer.slice(0, 600);
		promptNav.answer.hidden = !answer;
		promptNav.preview.classList.remove('hidden');
		const bounds = el.messages.parentElement.getBoundingClientRect();
		const tick = button.getBoundingClientRect();
		const height = promptNav.preview.getBoundingClientRect().height;
		promptNav.preview.style.top = Math.max(8, Math.min(tick.top - bounds.top - height / 2, bounds.height - height - 8)) + 'px';
	}

	function updatePromptPosition() {
		promptNav.frame = 0;
		if (!promptNav.items.length) return;
		promptNav.list.classList.toggle('overflowing', promptNav.list.scrollHeight > promptNav.list.clientHeight);
		const top = el.messages.getBoundingClientRect().top + 48;
		let active = promptNav.items[0];
		for (const item of promptNav.items) {
			const node = document.getElementById('msg-' + item.message.id);
			if (node && node.getBoundingClientRect().top <= top) active = item;
		}
		if (atBottom()) active = promptNav.items[promptNav.items.length - 1];
		const focused = promptNav.list.contains(document.activeElement) ? document.activeElement : null;
		for (const item of promptNav.items) {
			const current = item === active;
			item.button.classList.toggle('active', current);
			if (current) item.button.setAttribute('aria-current', 'true');
			else item.button.removeAttribute('aria-current');
			item.button.tabIndex = item.button === (focused || active.button) ? 0 : -1;
		}
		// Keep active prompt visible within the rail without jumping unless it scrolls past the edge
		const button = active.button, list = promptNav.list;
		const offsetInView = button.offsetTop - list.scrollTop;
		const viewHeight = list.clientHeight;
		if (offsetInView < -10 || offsetInView > viewHeight + 10) {
			const target = button.offsetTop - (viewHeight / 2) + (button.offsetHeight / 2);
			list.scrollTop = Math.max(0, target);
		}
		if (promptNav.hovered) showPromptPreview(promptNav.hovered);
	}

	function schedulePromptPosition() {
		if (!promptNav.frame) promptNav.frame = requestAnimationFrame(updatePromptPosition);
	}

	function renderPromptNav() {
		if (promptNav.session !== state.currentSessionId) {
			hidePromptPreview();
			promptNav.list.replaceChildren();
			promptNav.items = [];
			promptNav.session = state.currentSessionId;
		}
		const previous = new Map(promptNav.items.map((item) => [item.message.id, item.button]));
		const items = [];
		let turn = null;
		for (const message of state.messages) {
			const chapter = state.chapters.includes(message.id);
			if ((message.role === 'user' || chapter) && !message.kind) {
				const button = previous.get(message.id) || h('button', 'prompt-tick', '<span aria-hidden="true"></span>');
				button.type = 'button';
				button.dataset.promptId = message.id;
				button.classList.toggle('chapter', chapter);
				button.setAttribute('aria-label', t('jumpToPromptNumber', { n: items.length + 1, text: promptSummary(message).slice(0, 160) }));
				button.setAttribute('aria-describedby', 'prompt-preview');
				if (chapter) button.setAttribute('aria-label', 'Chapter: ' + promptSummary(message).slice(0, 160));
				turn = { message, button, answer: '' };
				items.push(turn);
			} else if (turn && message.role === 'assistant' && !message.kind && !message.compacted && message.content?.trim()) {
				turn.answer = message.content.trim();
			}
		}
		if (turn && state.isStreaming && state.streaming?.text) turn.answer = state.streaming.text;
		promptNav.items = items;
		for (let i = 0; i < items.length; i++) {
			if (promptNav.list.children[i] !== items[i].button) promptNav.list.insertBefore(items[i].button, promptNav.list.children[i] || null);
		}
		while (promptNav.list.children.length > items.length) promptNav.list.lastElementChild.remove();
		if (promptNav.hovered && !promptNav.list.contains(promptNav.hovered)) hidePromptPreview();
		promptNav.rail.classList.toggle('hidden', !items.length);
		el.messages.classList.toggle('has-prompt-nav', !!items.length);
		promptNav.rail.setAttribute('aria-label', t('jumpToPrompt'));
		promptNav.list.classList.toggle('overflowing', promptNav.list.scrollHeight > promptNav.list.clientHeight);
		schedulePromptPosition();
	}

	promptNav.list.addEventListener('pointerover', (event) => {
		const button = event.target.closest('.prompt-tick');
		if (button) showPromptPreview(button);
	});
	promptNav.rail.addEventListener('pointerleave', hidePromptPreview);
	promptNav.list.addEventListener('focusin', (event) => showPromptPreview(event.target));
	promptNav.list.addEventListener('focusout', (event) => {
		if (!promptNav.list.contains(event.relatedTarget)) hidePromptPreview();
	});
	promptNav.list.addEventListener('scroll', () => {
		if (promptNav.hovered) showPromptPreview(promptNav.hovered);
	});
	promptNav.rail.addEventListener('wheel', (event) => {
		const list = promptNav.list;
		if (list.scrollHeight <= list.clientHeight) return;
		event.preventDefault();
		event.stopPropagation();
		list.scrollBy({ top: event.deltaY, behavior: 'auto' });
	}, { passive: false });
	promptNav.list.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && !promptNav.preview.classList.contains('hidden')) {
			event.preventDefault();
			hidePromptPreview();
			return;
		}
		const index = promptNav.items.findIndex((item) => item.button === event.target);
		if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
		event.preventDefault();
		let next = index;
		if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = promptNav.items.length - 1;
		else if (event.key === 'PageUp') next = Math.max(0, index - 15);
		else if (event.key === 'PageDown') next = Math.min(promptNav.items.length - 1, index + 15);
		else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
		else if (event.key === 'ArrowDown') next = Math.min(promptNav.items.length - 1, index + 1);
		promptNav.items.forEach((item, i) => { item.button.tabIndex = i === next ? 0 : -1; });
		promptNav.items[next].button.focus({ preventScroll: true });
		const button = promptNav.items[next].button;
		promptNav.list.scrollTop = Math.max(0, button.offsetTop - promptNav.list.clientHeight / 2);
		showPromptPreview(button);
	});
	promptNav.list.addEventListener('click', (event) => {
		const button = event.target.closest('.prompt-tick');
		const node = button && document.getElementById('msg-' + button.dataset.promptId);
		if (!node) return;
		ui.stick = false;
		el.scrollBottom.classList.remove('hidden');
		hidePromptPreview();
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.messages.scrollTo({ top: Math.max(0, el.messages.scrollTop + node.getBoundingClientRect().top - el.messages.getBoundingClientRect().top - 20), behavior: reduced ? 'auto' : 'smooth' });
		el.messages.querySelectorAll('.prompt-jump').forEach((old) => old.classList.remove('prompt-jump'));
		clearTimeout(promptNav.highlightTimer);
		node.classList.add('prompt-jump');
		promptNav.highlightTimer = setTimeout(() => node.classList.remove('prompt-jump'), 1400);

		// Auto-scroll the rail: if selecting the top or bottom visible tick, page by 15 prompts
		const list = promptNav.list;
		const offsetInView = button.offsetTop - list.scrollTop;
		const pageSize = list.clientHeight;
		if (offsetInView <= button.offsetHeight * 2) {
			list.scrollTo({ top: Math.max(0, list.scrollTop - pageSize), behavior: reduced ? 'auto' : 'smooth' });
		} else if (offsetInView >= pageSize - button.offsetHeight * 3) {
			list.scrollTo({ top: Math.min(list.scrollHeight - pageSize, list.scrollTop + pageSize), behavior: reduced ? 'auto' : 'smooth' });
		} else {
			list.scrollTo({ top: Math.max(0, button.offsetTop - pageSize / 2 + button.offsetHeight / 2), behavior: reduced ? 'auto' : 'smooth' });
		}

		schedulePromptPosition();
	});
	el.messages.addEventListener('scroll', schedulePromptPosition);
	new ResizeObserver(schedulePromptPosition).observe(el.messages);
	new MutationObserver(schedulePromptPosition).observe(el.messages, { childList: true, subtree: true, characterData: true });

	// ------------------------------------------------------------ tool metadata

	const TOOL_META = {
		list_files: ['folder', 'List files'],
		read_file: ['file', 'Read'],
		edit_lines: ['pencil', 'Edit lines'],
		grep: ['search', 'Search'],
		get_diagnostics: ['alert', 'Diagnostics'],
		get_editor_context: ['file', 'Editor'],
		todo_write: ['todo', 'Plan'],
		memory_retain: ['memory', 'Remember'],
		memory_recall: ['memory', 'Recall'],
		session_search: ['history', 'Past chats'],
		web_search: ['globe', 'Web search'],
		web_fetch: ['link', 'Fetch'],
		open_url: ['globe', 'Open page'],
		git_status: ['branch', 'Git status'],
		git_diff: ['branch', 'Git diff'],
		git_log: ['branch', 'Git log'],
		task: ['cpu', 'Subagent'],
		delegate_to_helper: ['agent', 'Helper'],
		consult_peer: ['chat', 'Ask the peer'],
		verify: ['check', 'Verify'],
		semantic_search: ['search', 'Code search'],
		tool_search: ['puzzle', 'Load tools'],
		run_script: ['command', 'Script'],
		skill: ['book', 'Skill'],
		image_generate: ['image', 'Generate image'],
		browser_navigate: ['globe', 'Browser'],
		browser_snapshot: ['image', 'Screenshot'],
		browser_click: ['zap', 'Click'],
		browser_type: ['command', 'Type'],
		browser_press: ['command', 'Key'],
		browser_scroll: ['arrowDown', 'Scroll'],
		browser_back: ['back', 'Back'],
		browser_console: ['terminal', 'Console'],
		browser_evaluate: ['terminal', 'Evaluate'],
		browser_close: ['close', 'Close browser'],
		browser_forward: ['arrowUp', 'Forward'],
		browser_reload: ['refresh', 'Reload'],
		browser_hover: ['eye', 'Hover'],
		browser_select: ['list', 'Select'],
		browser_wait_for: ['history', 'Wait for'],
		browser_resize: ['phone', 'Viewport'],
		browser_tabs: ['cube', 'Tabs'],
		browser_network: ['activity', 'Network']
	};
	const PATH_TOOLS = new Set(['read_file']);
	const EXPLORE = new Set(['session_search', 'list_files', 'read_file', 'grep', 'semantic_search', 'code_intel', 'view_image', 'get_diagnostics', 'get_editor_context', 'git_status', 'git_diff', 'git_log', 'memory_recall', 'skill', 'web_search', 'web_fetch']);

	function toolMeta(name) {
		if (name.startsWith('mcp__')) {
			const parts = name.split('__');
			return ['plug', 'MCP ' + (parts[1] || '') + ' › ' + parts.slice(2).join('__')];
		}
		return TOOL_META[name] || ['sparkle', name];
	}

	// ------------------------------------------------------------ turn structure

	/** Split the transcript into turns: { user, items[] } (plus leading orphans). */
	function buildTurns(msgs) {
		const turns = [];
		let cur = { user: null, items: [] };
		for (const m of msgs) {
			// Compaction is a conversation boundary, never a hidden step of the preceding turn.
			if (m.compacted) {
				if (cur.user || cur.items.length) turns.push(cur);
				turns.push({ user: null, items: [m] });
				cur = { user: null, items: [] };
			} else if (m.role === 'user' && !m.kind) {
				if (cur.user || cur.items.length) turns.push(cur);
				cur = { user: m, items: [] };
			} else cur.items.push(m);
		}
		if (cur.user || cur.items.length) turns.push(cur);
		return turns;
	}

	const isText = (m) => m.role === 'assistant' && !m.kind && !m.compacted;
	const isNote = (m) => isText(m) && /^_[^_][\s\S]*_$/.test(m.content.trim()) && m.content.length < 240;

	/** Collapse consecutive finished tool rows into "Explored…" style groups. */
	function categoryOf(m) {
		const s = state.settings;
		if (m.tool && !m.todos && m.tool.status !== 'running' && !m.tool.image && EXPLORE.has(m.tool.name) && s.groupExploration !== false) return 'explore';
		if (m.approval && ['success', 'error', 'rejected'].includes(approvalPhase(m.approval))) {
			if (m.approval.kind === 'command' && s.groupTerminal !== false) return 'terminal';
			if ((m.approval.kind === 'edit' || m.approval.kind === 'write' || m.approval.kind === 'patch') && s.groupChanges) return 'changes';
		}
		return null;
	}

	function stepUnits(items) {
		const units = [];
		for (let i = 0; i < items.length; i++) {
			const cat = categoryOf(items[i]);
			if (cat) {
				let j = i;
				while (j + 1 < items.length && categoryOf(items[j + 1]) === cat) j++;
				if (j > i) {
					units.push({ kind: 'group', cat, items: items.slice(i, j + 1), id: 'g:' + items[i].id });
					i = j;
					continue;
				}
			}
			units.push({ kind: 'msg', m: items[i], id: items[i].id });
		}
		return units;
	}

	/** Units to render for the whole transcript. */
	function buildUnits() {
		const units = [];
		const turns = buildTurns(state.messages.filter((m) => !(m.todos && m.todos.length) && !(m.kind === 'tool' && !m.tool && !m.approval && !m.question && !m.content?.trim())));
		let prevModel;
		turns.forEach((turn, index) => {
			const live = state.isStreaming && index === turns.length - 1;
			const u = turn.user;
			if (u) {
				const model = u.turn && u.turn.model;
				if (model && prevModel && model !== prevModel) units.push({ kind: 'switch', id: 's:' + u.id, from: prevModel, to: model });
				if (model) prevModel = model;
				units.push({ kind: 'msg', m: u, id: u.id });
			}
			const pending = turn.items.some((m) => (m.approval && m.approval.status === 'pending') || (m.question && m.question.status === 'pending'));
			const agents = u ? turnAgentRuns(turns, index) : [];
			// The workflow card above the composer is the live view of the latest workflow turn; no second tree in the chat.
			const carded = state.subagentWorkflow?.enabled === true && index === turns.length - 1 && agents.some((a) => a.workflowRole);
			const agentUnit = agents.length && !carded ? { kind: 'agents', id: 'a:' + u.id, user: u, live, runs: agents } : null;
			if (live || pending || !u || !u.turn) {
				stepUnits(turn.items).forEach((x) => units.push(x));
				if (agentUnit) units.push(agentUnit);
				if (!live && u?.turn) {
					if (u.turn.edits?.length) units.push({ kind: 'edits', id: 'e:' + u.id, user: u, items: turn.items });
					if (ledgerEffects(turn.items).length) units.push({ kind: 'effects', id: 'x:' + u.id, user: u, items: turn.items });
				}
				return;
			}
			// Finished turn: steps collapse behind "Worked for …", the final answer stays visible.
			let finalIdx = -1;
			for (let i = turn.items.length - 1; i >= 0; i--) {
				const m = turn.items[i];
				if (m.isError || (isText(m) && m.content.trim())) {
					finalIdx = i;
					break;
				}
				if (m.kind === 'tool' && !m.tool) break;
			}
			const steps = turn.items.filter((m, i) => i !== finalIdx && !(isNote(m) && i === turn.items.length - 1));
			const tail = turn.items.filter((m, i) => i !== finalIdx && isNote(m) && i === turn.items.length - 1);
			if (steps.length) units.push({ kind: 'worked', id: 'w:' + u.id, user: u, steps });
			if (agentUnit) units.push(agentUnit);
			if (finalIdx >= 0) units.push({ kind: 'msg', m: turn.items[finalIdx], id: turn.items[finalIdx].id, final: true, turn: u.turn, toolSteps: steps.filter((m) => m.tool || (m.approval && m.approval.status === 'applied')).length });
			tail.forEach((m) => units.push({ kind: 'msg', m, id: m.id }));
			if (u.turn.edits?.length) units.push({ kind: 'edits', id: 'e:' + u.id, user: u, items: turn.items });
			if (ledgerEffects(turn.items).length) units.push({ kind: 'effects', id: 'x:' + u.id, user: u, items: turn.items });
		});
		// "Continued from chat": where a branched chat's copied history ends.
		const br = state.branch;
		if (br && state.messages.some((m) => m.id === br.afterId)) {
			const after = state.messages.findIndex((m) => m.id === br.afterId);
			const next = state.messages.slice(after + 1).find((m) => m.role === 'user' && !m.kind);
			const at = next ? units.findIndex((x) => x.id === next.id) : -1;
			units.splice(at < 0 ? units.length : at, 0, { kind: 'branch', id: 'b:' + br.id, from: br });
		}
		return units;
	}

	// ------------------------------------------------------------ message renderers

	// Image bytes for the composer and for sent prompts: the host keeps them in memory
	// (never in the state message), so the webview asks once and caches the data URL.
	const IMAGE_NAME = /\.(png|jpe?g|gif|webp|webm|wav)$/i;
	const VIDEO_NAME = /\.webm$/i;
	const AUDIO_NAME = /\.wav$/i;
	const thumbs = new Map();
	const askedThumbs = new Set();
	const msgImages = new Map();
	const askedMsgImages = new Set();

	function renderUser(m) {
		const wrap = h('div', 'msg user');
		wrap.id = 'msg-' + m.id;
		wrap.dataset.turnId = m.id;
		if (m.attachments && m.attachments.length) {
			const row = h('div', 'msg-attachments' + (m.local ? ' media-result' : ''));
			const urls = msgImages.get(m.id) || [];
			let images = 0;
			for (const name of m.attachments) {
				const isImage = IMAGE_NAME.test(name);
				const url = isImage ? urls[images++] : undefined;
				// An image always gets the thumbnail-sized chip — with a placeholder of the same
				// footprint until its bytes arrive, so the row never jumps.
				const video = isImage && VIDEO_NAME.test(name);
				const audio = isImage && AUDIO_NAME.test(name);
				const chip = h('span', 'chip' + (isImage ? ' thumb-chip' + (url ? '' : ' no-thumb') : '') + (video ? ' video-chip' : '') + (audio ? ' audio-chip' : ''), url ? (video ? '<video class="attach-video" controls loop muted playsinline></video>' : audio ? '<audio class="attach-audio" controls></audio>' : '<img class="attach-thumb" alt="">') : I(video ? 'film' : audio ? 'volume' : isImage ? 'image' : 'file'));
				if (url && (video || audio)) chip.querySelector(video ? 'video' : 'audio').src = url;
				else if (url) {
					const img = chip.querySelector('img');
					img.src = url;
					img.dataset.zoom = url;
					img.dataset.caption = name;
					img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', 'Open ' + name + ' in image viewer');
					img.title = name;
				}
				chip.appendChild(h('span', 'name', esc(name)));
				row.appendChild(chip);
			}
			wrap.appendChild(row);
			if (!msgImages.has(m.id) && !askedMsgImages.has(m.id) && m.attachments.some((n) => IMAGE_NAME.test(n))) {
				askedMsgImages.add(m.id);
				post({ type: 'readMessageImages', id: m.id });
			}
		}
		wrap.appendChild(h('div', 'bubble md session-text', MD.render(m.content, { mentions: true })));
		if (m.memoryRecall?.length) wrap.appendChild(h('details', 'memory-recall-receipt', '<summary>' + m.memoryRecall.length + ' saved facts used</summary>' + m.memoryRecall.map(r => '<p><small>' + esc(r.reason) + '</small><br>' + esc(r.text) + '</p>').join('')));
		let actions = '<button class="icon-btn" data-copy-msg="' + esc(m.id) + '" title="' + esc(t('copy')) + '">' + I('copy') + '</button>';
		if (restorable(m.id) && !state.isStreaming) {
			actions += '<button class="chip-btn restore-btn" data-restore="' + esc(m.id) + '" title="' + esc(t('restoreHereDesc')) + '">' + I('history') + '<span>' + esc(t('restoreHere')) + '</span></button>';
		}
		if (m.at) {
			actions += '<span class="user-stamp" title="' + esc(new Date(m.at).toLocaleString()) + '">' + esc(fmtStamp(m.at)) + '</span>';
		}
		wrap.appendChild(h('div', 'user-actions', actions));
		const budget = m.turn && m.turn.taskBudget;
		const budgetHtml = budget ? taskBudgetHtml(budget) : '';
		if (budgetHtml) wrap.appendChild(h('div', 'user-stamp task-budget', budgetHtml));
		return wrap;
	}

	/** Some turn at or after this user message still has an undo checkpoint. */
	function restorable(userId) {
		const undoable = state.undoable || [];
		if (!undoable.length) return false;
		const idx = state.messages.findIndex((x) => x.id === userId);
		return state.messages.slice(idx).some((x) => x.role === 'user' && undoable.includes(x.id));
	}
	function taskBudgetHtml(b) {
		const l = b.limits || {};
		if (!(l.cost || l.tokens || l.requests || l.seconds)) return '';
		const tokenUsed = (b.spentTokens || 0) + (b.uncertainTokens || 0) + (b.reservedTokens || 0);
		const costUsed = (b.spentCost || 0) + (b.uncertainCost || 0) + (b.reservedCost || 0);
		const parts = [];
		if (l.requests) parts.push(b.requests + '/' + l.requests + ' requests');
		if (l.tokens) parts.push(Math.max(0, l.tokens - tokenUsed).toLocaleString() + ' tokens available');
		if (l.cost) parts.push('$' + Math.max(0, l.cost - costUsed).toFixed(4) + ' available (estimate)');
		if (l.seconds) parts.push(l.seconds + 's limit');
		if (b.reservedTokens || b.reservedCost) parts.push('requests in flight');
		if (b.unknownUsage || l.cost && b.unknownCost) parts.push('incomplete usage retained');
		if (b.stopped) parts.push(b.stopped);
		return '<span title="' + esc('Spent: ' + (b.spentTokens || 0) + ' tokens, $' + (b.spentCost || 0).toFixed(4) + ' estimated. Reserved: ' + (b.reservedTokens || 0) + ' tokens, $' + (b.reservedCost || 0).toFixed(4) + '. Uncertain: ' + (b.uncertainTokens || 0) + ' tokens, $' + (b.uncertainCost || 0).toFixed(4) + '. Unknown usage: ' + (b.unknownUsage || 0) + '; unknown cost: ' + (b.unknownCost || 0) + '.') + '">' + esc(parts.join(' · ')) + '</span>';
	}

	/*
	 * Reasoning. Folded it is one quiet line — "Thinking 4s" while it streams, "Thought for 4s"
	 * once it ends. A click opens a titled outline and the reasoning text on a rail; the text is
	 * capped and follows the newest words while live, then expands to the full trace. A live
	 * trace folds itself when the run ends. The status line keeps the thinking loader for work
	 * that is not reasoning.
	 */
	const RAYS = Array.from({ length: 8 }, (_, i) => '<line x1="8" y1="1.75" x2="8" y2="4.75" transform="rotate(' + i * 45 + ' 8 8)"/>').join('');
	const LOADER_ICON = '<span class="tl-icon" aria-hidden="true"><svg class="tl-spinner" viewBox="0 0 16 16">' + RAYS + '</svg><svg class="tl-check" viewBox="0 0 16 16"><path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength="1"/></svg></span>';
	const motionOk = () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	/** Reasoning as timeline steps: a bold line ("**Planning the fix**") opens a step, otherwise each paragraph is one. */
	function thinkingSteps(text) {
		text = text.replace(/\r\n?/g, '\n');
		const steps = [];
		const titled = /^\*\*[^*\n]+\*\*[ \t]*$/m.test(text);
		for (const raw of text.split(/\n\s*\n/)) {
			const para = raw.trim();
			if (!para) continue;
			const head = para.match(/^\*\*([^*\n]+)\*\*[ \t]*(?:\n|$)/);
			const last = steps[steps.length - 1];
			if (head) steps.push({ title: head[1].trim(), body: para.slice(head[0].length).trim() });
			else if (titled && last) last.body += (last.body ? '\n\n' : '') + para;
			else steps.push({ title: '', body: para });
		}
		for (const s of steps) s.body = s.body.replace(/\*\*([^*\n]+)\*\*/g, '$1');
		return steps;
	}

	const THINK_SLOW_MS = 4000;
	const fmtStepMs = (ms) => (ms / 1000).toFixed(1) + 's';
	const thinkCount = (n) => n + (n === 1 ? ' step' : ' steps');
	const THINK_STATUS_WORD = { pending: 'pending', active: 'running', done: 'done', error: 'failed', skipped: 'skipped' };
	/** Step glyphs: a dot, a turning busy ring, a check, a cross and a skip dash. */
	function thinkGlyph(status) {
		if (status === 'active') return '<svg class="tk-spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" opacity=".22"></circle><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"></path></svg>';
		if (status === 'done') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.8 8.3 6.6 11 12.2 5"></path></svg>';
		if (status === 'error') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"></path></svg>';
		if (status === 'skipped') return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7"></path></svg>';
		return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle class="tk-fill" cx="8" cy="8" r="1.7"></circle></svg>';
	}
	let thinkTicker = 0;
	let thinkSeq = 0;

	/** Live seconds count from zero, so the first second reads "0s" rather than jumping to 1. */
	function fmtThinkLive(ms) {
		const s = Math.max(0, Math.floor(ms / 1000));
		if (s < 60) return s + 's';
		const m = Math.floor(s / 60);
		if (m < 60) return m + 'm ' + (s % 60) + 's';
		return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
	}

	/** Folded to a quiet line until clicked; open, it is an outline and the reasoning text. */
	function thinkingBlock(key, open = false) {
		const d = h('div', 'thinking' + (open ? ' open' : ''));
		d.dataset.think = key;
		const listId = 'think-list-' + (++thinkSeq);
		d.innerHTML =
			'<div class="tk"><button type="button" class="tk-head" data-think-toggle aria-expanded="false" aria-controls="' + listId + '">' +
			'<span class="tk-heading"><span class="tk-title"></span><span class="tk-count" hidden></span><span class="tk-clock"></span></span>' +
			'<span class="tk-chev" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4.5 6.25 8 9.75l3.5-3.5"/></svg></span></button>' +
			'<div class="tk-body" id="' + listId + '" role="region" aria-label="Reasoning"><div class="tk-clip"><div class="tk-panel">' +
			'<ol class="tk-list" aria-label="Outline"></ol><div class="tk-text"></div><div class="tk-sources-wrap"></div>' +
			'</div></div></div><span class="tk-live" role="status" aria-live="polite"></span></div>';
		const text = d.querySelector('.tk-text');
		text.addEventListener('scroll', () => {
			d.thinkStick = text.scrollHeight - text.scrollTop - text.clientHeight < 8;
			text.dataset.fade = d.classList.contains('busy') && text.scrollTop > 2 ? 'true' : 'false';
		}, { passive: true });
		setThinkingOpen(d, open);
		return d;
	}

	/** Source chips come only from recorded search output, never from the template's demo data. */
	function thinkingSearches(message) {
		const rows = [], from = state.messages.indexOf(message);
		if (from < 0) return rows;
		for (const m of state.messages.slice(from + 1)) {
			if (m.role === 'user' || !m.kind) break;
			if (m.tool?.name !== 'web_search') continue;
			const tool = m.tool, sources = [], seen = new Set();
			const lines = (tool.detail || '').replace(/\r\n?/g, '\n').split('\n');
			for (let i = 0; i < lines.length; i++) {
				const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
				const links = [...lines[i].matchAll(markdown)].map(match => ({ label: match[1], href: match[2] }));
				if (!links.length) for (const match of lines[i].matchAll(/https?:\/\/[^\s<>"')]+/g)) links.push({ label: '', href: match[0].replace(/[.,;]+$/, '') });
				for (const link of links) {
					let url;
					try { url = new URL(link.href); } catch { continue; }
					if (!/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
					seen.add(url.href);
					const previous = (lines[i - 1] || '').trim();
					const heading = previous.match(/^(?:\d+\.\s+|Title:\s*)(.+)$/i)?.[1];
					sources.push({ href: url.href, label: (link.label || heading || url.hostname).slice(0, 180) });
				}
			}
			const active = tool.status === 'running';
			if (active && !ui.thinkSearchStarts.has(m.id)) ui.thinkSearchStarts.set(m.id, Date.now());
			rows.push({ id: m.id, kind: 'search', title: active ? 'Searching' : tool.status === 'error' ? 'Search failed' : 'Searched', body: '', active, startedAt: ui.thinkSearchStarts.get(m.id), durationMs: tool.durationMs, sources });
		}
		return rows;
	}

	/** Source chips for recorded searches, below the reasoning text. */
	function paintThinkingSources(d, searches) {
		const wrap = d.querySelector('.tk-sources-wrap');
		if (!wrap) return;
		const key = d.dataset.think;
		const signature = JSON.stringify(searches.map((s) => [s.id, s.title, s.sources, ui.thinkSources.has(key + ':' + s.id)]));
		if (wrap.dataset.sig === signature) return;
		wrap.dataset.sig = signature;
		wrap.replaceChildren();
		const globe = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/></svg>';
		for (const step of searches) {
			const sources = step.sources || [];
			if (!sources.length) continue;
			const sourceKey = key + ':' + step.id;
			const expanded = ui.thinkSources.has(sourceKey);
			const group = h('div', 'tk-source-group');
			group.setAttribute('role', 'group');
			group.setAttribute('aria-label', step.title || 'Search sources');
			const chips = h('div', 'tk-sources');
			for (const [i, source] of (expanded ? sources : sources.slice(0, 4)).entries()) {
				const chip = h('a', 'tk-source', '<span class="tk-source-icon" aria-hidden="true">' + globe + '</span><span class="tk-source-label"></span>');
				chip.href = source.href;
				chip.dataset.href = source.href;
				chip.target = '_blank';
				chip.rel = 'noreferrer noopener';
				chip.title = source.href.replace(/^https?:\/\//, '');
				chip.style.animationDelay = (i < 4 ? 120 + i * 160 : (i - 4) * 70) + 'ms';
				chip.querySelector('.tk-source-label').textContent = source.label;
				chips.appendChild(chip);
			}
			if (sources.length > 4) {
				const more = h('button', 'tk-source tk-source-more');
				more.type = 'button';
				more.dataset.thinkSources = sourceKey;
				more.setAttribute('aria-expanded', String(expanded));
				more.textContent = expanded ? 'Show less' : '+' + (sources.length - 4) + ' more';
				more.style.animationDelay = '760ms';
				more.addEventListener('click', () => {
					if (ui.thinkSources.has(sourceKey)) ui.thinkSources.delete(sourceKey);
					else ui.thinkSources.add(sourceKey);
					wrap.dataset.sig = '';
					paintThinkingSources(d, searches);
					wrap.querySelector('.tk-source-more')?.focus({ preventScroll: true });
				});
				chips.appendChild(more);
			}
			group.appendChild(chips);
			wrap.appendChild(group);
		}
	}

	/** Swap the pill's label: the old one rolls up out of a blur, the new one rolls in and the pill glides to its width. */
	function rollLabel(box, text, shine) {
		const cur = box.querySelector('.tl-label:not(.out)');
		if (cur && cur.dataset.text === text) {
			cur.classList.toggle('tl-shine', shine);
			return;
		}
		const from = box.offsetWidth;
		const next = h('span', 'tl-label' + (cur ? ' in' : '') + (shine ? ' tl-shine' : ''));
		next.dataset.text = text;
		next.textContent = text;
		if (cur) {
			cur.classList.add('out');
			cur.setAttribute('aria-hidden', 'true');
			cur.addEventListener('animationend', () => cur.remove(), { once: true });
			if (!motionOk()) cur.remove();
		}
		box.appendChild(next);
		const to = next.offsetWidth;
		if (from && to && from !== to && motionOk()) {
			box.style.width = from + 'px';
			void box.offsetWidth;
			box.style.width = to + 'px';
			box.addEventListener('transitionend', () => (box.style.width = ''), { once: true });
		}
	}

	/**
	 * Paint a reasoning block. `busy`: still reasoning (the last step is the current one);
	 * `ms`: how long it reasoned, once known. The trace stays folded until clicked.
	 */
	function paintThinking(d, text, busy, ms, searches = []) {
		const reasoningBusy = busy;
		busy = busy || searches.some((s) => s.active);
		d.classList.toggle('busy', busy);
		d.classList.toggle('done', !busy);
		const reasoning = thinkingSteps(text);
		const steps = [...reasoning, ...searches];
		const statuses = steps.map((s, i) => {
			if (s.kind === 'search') return s.active ? 'active' : /failed/i.test(s.title || '') ? 'error' : 'done';
			return reasoningBusy && i === reasoning.length - 1 ? 'active' : 'done';
		});
		const anyError = statuses.includes('error');
		if (anyError) d.dataset.thinkError = '1';
		else delete d.dataset.thinkError;
		// A live turn with no reasoning yet keeps the receipt's shape as a waiting header.
		// The old loader is gone: one thinking style, even before the first step arrives.
		const placeholder = d.classList.contains('live') && busy && !text && !steps.length;
		if (placeholder) d.dataset.placeholder = '1';
		else delete d.dataset.placeholder;
		const toggle = d.querySelector('.tk-head');
		if (toggle) toggle.disabled = placeholder;
		if (busy && !d.thinkStart) d.thinkStart = ui.thinkStartedAt || Date.now();

		const searchMs = searches.reduce((total, s) => total + (s.durationMs || 0), 0);
		const elapsed = ms === undefined ? undefined : ms + searchMs;
		d.dataset.elapsed = elapsed === undefined ? '' : String(elapsed);
		d.dataset.searchMs = String(searchMs);

		// Header: "Thinking 4s" while it streams, "Thought for 4s" once it ends.
		const title = d.querySelector('.tk-title');
		const head = busy ? 'busy' : 'done:' + elapsed;
		if (title.dataset.state !== head) {
			title.dataset.state = head;
			title.innerHTML = busy
				? '<span class="tk-shine" data-text="' + esc(t('thinking')) + '">' + esc(t('thinking')) + '</span>'
				: esc(t('thoughtFor'));
		}
		paintThinkTime(d);

		// Announce the phase once, not on every token.
		const live = d.querySelector('.tk-live');
		const phase = busy ? t('thinking') : elapsed !== undefined ? t('thoughtFor') + ' ' + fmtDuration(elapsed) : t('finishedThinking');
		if (live && live.dataset.phase !== phase) {
			live.dataset.phase = phase;
			live.textContent = phase;
		}

		// Outline: one timeline row per titled reasoning step and per web search.
		const list = d.querySelector('.tk-list');
		const outline = [];
		steps.forEach((s, i) => {
			if (s.kind === 'search' || s.title) outline.push({ step: s, status: statuses[i], kind: s.kind === 'search' ? 'search' : 'think' });
		});
		const countEl = d.querySelector('.tk-count');
		if (countEl) {
			countEl.textContent = outline.length ? thinkCount(outline.length) : '';
			countEl.hidden = !outline.length;
		}
		const sig = JSON.stringify(outline.map((o) => [o.step.id || o.step.title, o.step.title, o.status, o.kind, o.step.durationMs]));
		if (list.dataset.sig !== sig) {
			list.dataset.sig = sig;
			list.replaceChildren();
			const rail = (owner, edge) => {
				if (!owner) return '';
				const fill = owner.status === 'done' || owner.status === 'skipped';
				const shimmer = owner.status === 'active';
				return '<span class="tk-rail tk-rail-' + edge + (fill ? ' fill' : '') + (shimmer ? ' shimmer' : '') + '" aria-hidden="true"><i></i></span>';
			};
			outline.forEach(({ step, status, kind }, i) => {
				const li = h('li', 'tk-item',
					rail(i > 0 ? outline[i - 1] : null, 'up') +
					rail(i < outline.length - 1 ? outline[i] : null, 'down') +
					'<span class="tk-glyph" aria-hidden="true">' + thinkGlyph(status) + '</span>' +
					'<div class="tk-main"><div class="tk-line"><span class="tk-kind"></span><span class="tk-label"></span><span class="tk-duration"></span></div><button type="button" class="tk-detail" data-think-detail aria-expanded="false" hidden></button><span class="tk-status"></span></div>');
				li.dataset.status = status;
				if (step.id) li.dataset.step = step.id;
				li.querySelector('.tk-kind').textContent = kind;
				li.querySelector('.tk-label').textContent = step.title || t('thinking');
				li.querySelector('.tk-status').textContent = THINK_STATUS_WORD[status] || status;
				const body = (step.body || '').trim();
				const detail = li.querySelector('.tk-detail');
				if (body) {
					detail.hidden = false;
					detail.textContent = body;
					detail.title = body;
				}
				const expandable = body.length > 90;
				detail.dataset.expandable = String(expandable);
				detail.tabIndex = expandable ? 0 : -1;
				if (expandable) detail.setAttribute('aria-expanded', 'false');
				else detail.removeAttribute('aria-expanded');
				if (status === 'active') li.dataset.since = String(Date.now());
				else if (step.durationMs !== undefined) li.dataset.duration = String(step.durationMs);
				list.appendChild(li);
			});
		}
		list.hidden = !outline.length;

		// Per-step clocks keep running while a step is current; bodies can grow after the row was built.
		[...list.children].forEach((li, i) => {
			const { step, status } = outline[i];
			const dur = li.querySelector('.tk-duration');
			let stepMs = li.dataset.duration ? Number(li.dataset.duration) : undefined;
			if (status === 'active') {
				if (!li.dataset.since) li.dataset.since = String(Date.now());
				stepMs = Date.now() - Number(li.dataset.since);
			} else if (li.dataset.since) {
				if (stepMs === undefined) {
					stepMs = Date.now() - Number(li.dataset.since);
					li.dataset.duration = String(stepMs);
				}
				delete li.dataset.since;
			}
			if (stepMs === undefined) {
				if (dur) { dur.hidden = true; dur.textContent = ''; }
			} else if (dur) {
				dur.hidden = false;
				dur.textContent = fmtStepMs(stepMs);
			}
			li.classList.toggle('slow', (stepMs || 0) > THINK_SLOW_MS);

			const detail = li.querySelector('.tk-detail');
			const body = (step.body || '').trim();
			if (detail) {
				if (!body) detail.hidden = true;
				else {
					detail.hidden = false;
					if (detail.textContent !== body) {
						detail.textContent = body;
						detail.title = body;
					}
					const expandable = body.length > 90;
					detail.dataset.expandable = String(expandable);
					detail.tabIndex = expandable ? 0 : -1;
					if (expandable && !detail.hasAttribute('aria-expanded')) detail.setAttribute('aria-expanded', 'false');
					if (!expandable) detail.removeAttribute('aria-expanded');
				}
			}
		});
		const rows = [...list.children];
		rows.forEach((li, i) => {
			const prev = rows[i - 1];
			li.querySelector('.tk-rail-up')?.classList.toggle('slow', !!prev?.classList.contains('slow'));
			li.querySelector('.tk-rail-down')?.classList.toggle('slow', li.classList.contains('slow'));
		});

		// The reasoning text: plain paragraphs under the outline, capped while it streams.
		const paragraphs = reasoning.flatMap((s) => (s.body || '').split(/\n\s*\n/)).map((s) => s.trim()).filter(Boolean);
		const textEl = d.querySelector('.tk-text');
		textEl.hidden = reasoning.some((s) => s.title && s.body);
		const textSig = JSON.stringify([paragraphs, busy]);
		if (textEl.dataset.sig !== textSig) {
			const wasTop = textEl.scrollTop;
			textEl.dataset.sig = textSig;
			textEl.replaceChildren();
			if (paragraphs.length) {
				for (const p of paragraphs) textEl.appendChild(h('p', '', esc(p)));
			} else if (busy) {
				textEl.appendChild(h('p', 'tk-placeholder', '…'));
			}
			if (busy) textEl.scrollTop = d.thinkStick === false ? wasTop : textEl.scrollHeight;
			else textEl.scrollTop = 0;
		}
		if (busy) {
			textEl.tabIndex = 0;
			textEl.setAttribute('aria-label', 'Reasoning so far');
		} else {
			textEl.removeAttribute('tabindex');
			textEl.removeAttribute('aria-label');
		}
		textEl.dataset.fade = busy && textEl.scrollTop > 2 ? 'true' : 'false';

		paintThinkingSources(d, searches);

		// A live trace folds itself once the run ends (but not when a step failed).
		if (!busy && !anyError && d.classList.contains('live') && !d.dataset.autoFold) {
			d.dataset.autoFold = '1';
			if (d.classList.contains('open')) {
				setTimeout(() => {
					if (!d.isConnected || d.dataset.thinkError) return;
					ui.thinkOpen.set(d.dataset.think, false);
					setThinkingOpen(d, false);
				}, 900);
			}
		}
		if (busy) startThinkTicker();
	}

	/** Header clock and the current step's live duration. */
	function paintThinkTime(d) {
		const clock = d.querySelector('.tk-clock');
		if (clock) {
			const recorded = d.dataset.elapsed === '' || d.dataset.elapsed === undefined ? null : Number(d.dataset.elapsed);
			if (d.classList.contains('busy')) clock.textContent = d.thinkStart ? fmtThinkLive(Date.now() - d.thinkStart) : '0s';
			else if (recorded !== null && Number.isFinite(recorded)) clock.textContent = fmtDuration(recorded);
			else clock.textContent = 'a moment';
		}
		const active = d.querySelector('.tk-item[data-status="active"]');
		if (!active) return;
		const since = Number(active.dataset.since || 0);
		if (!since) return;
		const ms = Date.now() - since;
		const dur = active.querySelector('.tk-duration');
		if (dur) {
			dur.hidden = false;
			dur.textContent = fmtStepMs(ms);
		}
		active.classList.toggle('slow', ms > THINK_SLOW_MS);
		const slow = ms > THINK_SLOW_MS;
		active.querySelector('.tk-rail-down')?.classList.toggle('slow', slow);
		active.nextElementSibling?.querySelector('.tk-rail-up')?.classList.toggle('slow', slow);
	}

	/** A 100ms clock for busy receipts; it shuts itself down once none remain. */
	function startThinkTicker() {
		if (thinkTicker) return;
		thinkTicker = setInterval(() => {
			const busy = el.messages.querySelectorAll('.thinking.busy');
			if (!busy.length) {
				clearInterval(thinkTicker);
				thinkTicker = 0;
				return;
			}
			for (const d of busy) paintThinkTime(d);
		}, 100);
	}

	function setThinkingOpen(d, open) {
		d.classList.toggle('open', open);
		d.querySelector('.tk-head').setAttribute('aria-expanded', String(open));
		const body = d.querySelector('.tk-body');
		body.dataset.open = String(open);
		body.inert = !open;
		body.setAttribute('aria-hidden', String(!open));
		if (open) {
			const text = d.querySelector('.tk-text');
			if (text) {
				if (d.classList.contains('busy') && d.thinkStick !== false) text.scrollTop = text.scrollHeight;
				text.dataset.fade = d.classList.contains('busy') && text.scrollTop > 2 ? 'true' : 'false';
			}
		}
	}

	/** A footer action in the Message Actions style: a ghost icon button with a tooltip that appears after a beat. */
	function macButton(key, icon, label, attrs, done) {
		return '<span class="mac-item"><button type="button" class="icon-btn mac-btn mac-' + key + '" aria-label="' + esc(label) + '" data-label="' + esc(label) + '" ' + attrs + '><span class="mac-icon">' +
			(done ? '<span class="mac-layer">' + I(icon) + '</span><span class="mac-layer mac-done">' + I(done) + '</span>' : I(icon)) +
			'</span></button><span class="mac-tip" aria-hidden="true">' + esc(label) + '</span></span>';
	}

	function renderAssistant(m, opts) {
		if (m.compacted) {
			const div = h('div', 'msg divider', I('zap') + '<span>' + esc(m.content) + '</span>');
			if (m.reasoning) {
				const open = ui.expanded.has(m.id);
				const btn = h('button', '', open ? 'Hide summary' : 'View summary');
				btn.dataset.toggle = m.id;
				btn.setAttribute('aria-expanded', String(open));
				div.appendChild(btn);
				if (open) {
					const wrap = h('div', 'msg');
					wrap.appendChild(div);
					wrap.appendChild(h('div', 'tool-detail md', MD.render(m.reasoning)));
					return wrap;
				}
			}
			return div;
		}
		if (m.isError) {
			const wrap = h('div', 'msg error');
			const card = h('div', 'error-card', I('alert'));
			const body = h('div', 'md', MD.render(m.content));
			if (window.RecoveryUI) body.insertAdjacentHTML('beforeend', window.RecoveryUI.html('response', m.content));
			if (Number.isFinite(m.retryAt) && m.retryAt > 0) body.appendChild(h('p', 'muted', 'Provider retry time: ' + esc(new Date(m.retryAt).toLocaleString())));
			const actions = h('div', 'error-actions');
			if (opts.last && !state.isStreaming) actions.innerHTML = '<button class="btn btn-secondary btn-sm" data-retry>' + I('retry') + esc(t('retry')) + '</button>';
			actions.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" data-copy-msg="' + esc(m.id) + '">' + I('copy') + esc(t('copy')) + '</button>');
			if (/settings/i.test(m.content)) actions.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" data-open-settings="models">' + I('gear') + esc(t('modelSettings')) + '</button>');
			if (/\b429\b|rate.?limit|quota|credits?|budget.*(?:reached|cover)|limit.*exceed/i.test(m.content)) actions.insertAdjacentHTML('beforeend', (window.RecoveryUI ? '' : '<button class="btn btn-secondary btn-sm" data-open-settings="usage">Usage & reset windows</button>') + '<button class="btn btn-ghost btn-sm" data-open-settings="models">Change model or provider</button>');
			if (opts.last) actions.insertAdjacentHTML('beforeend', '<button class="btn btn-ghost btn-sm" data-report title="Open a diagnostics report to review and share — nothing is sent by itself">' + I('alert') + 'Report</button>');
			body.appendChild(actions);
			card.appendChild(body);
			wrap.appendChild(card);
			return wrap;
		}
		const note = isNote(m);
		const wrap = h('div', 'msg assistant' + (note ? ' note' : '') + (opts.final ? ' final' : '') + (opts.last ? ' last' : ''));
		if (m.reasoning && state.settings.showReasoning !== false) {
			// Carry the user's collapsed or expanded choice from the stream to its saved message.
			if (ui.carryThink.has(m.reasoning)) {
				ui.thinkOpen.set(m.id, ui.carryThink.get(m.reasoning));
				ui.carryThink.delete(m.reasoning);
			}
			const think = thinkingBlock(m.id, ui.thinkOpen.get(m.id) ?? false);
			paintThinking(think, m.reasoning, false, m.reasoningMs, thinkingSearches(m));
			wrap.appendChild(think);
		}
		if (m.content.trim()) wrap.appendChild(h('div', 'md session-text', MD.render(m.content)));
		if (!note && m.content.trim() && (opts.final || opts.last)) {
			wrap.appendChild(
				h(
					'div',
					// The actions fade in one after another only as the answer lands, not on every re-render.
					'msg-actions' + (opts.last && performance.now() - (ui.answeredAt || -1e9) < 1500 ? ' fresh' : ''),
					macButton('copy', 'copy', t('copy'), 'data-copy-msg="' + esc(m.id) + '"', 'check') +
						(opts.last && !state.isStreaming && !m.local ? macButton('retry', 'retry', t('retry'), 'data-retry') : '') +
						(opts.final && !state.isStreaming && !state.isRemote ? macButton('branch branch-btn', 'branchOut', t('branchChat'), 'data-branch="' + esc(m.id) + '"') : '') +
						(m.at ? '<span class="msg-time">' + esc(fmtTime(m.at)) + '</span>' : '') +
						usageHtml(opts.turn && opts.turn.usage)
				)
			);
		}
		return wrap;
	}

	const fmtCost = (c) => (c === 0 ? '$0' : c < 0.001 ? '<$0.001' : c < 1 ? '$' + c.toFixed(c < 0.01 ? 4 : 3) : '$' + c.toFixed(2));
	const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));
	const fmtCacheRate = (pct) => {
		if (pct >= 100) return '100';
		for (let places = 1; places <= 6; places++) {
			const label = pct.toFixed(places);
			if (Number(label) < 100) return label;
		}
		return '<100';
	};

	/** "12.4k in · 310 out · 98.7% cached" — straight from the provider's usage numbers. */
	function usageHtml(u) {
		if (!u || (!u.input && !u.attempts)) return '';
		const partial = u.attempts && u.knownAttempts < u.attempts;
		const cacheComplete = u.cacheKnownAttempts == null || u.cacheKnownAttempts === u.attempts;
		if (!u.input && !u.output && partial) return '<span class="msg-usage">Usage not reported · ' + u.attempts + ' request(s)</span>';
		const pct = u.cached && u.input ? fmtCacheRate((u.cached / u.input) * 100) : '0';
		return (
			'<span class="msg-usage" title="' + esc(u.input.toLocaleString() + ' input tokens, ' + u.output.toLocaleString() + ' output tokens, ' + (u.cached || 0).toLocaleString() + ' reported prompt-cache read tokens' + (!cacheComplete ? '; cache-read reporting is incomplete' : '')) + '">' +
			fmtK(u.input) + ' in · ' + fmtK(u.output) + ' out' + (u.cached && !partial && cacheComplete ? ' · <b>' + esc(pct) + '%</b> ' + esc(t('cached')) : '') + (u.cached && !cacheComplete ? ' · ' + fmtK(u.cached) + ' cache reads (partial reporting)' : '') + (u.cacheWrite ? ' · ' + fmtK(u.cacheWrite) + ' cache writes' : '') + (partial ? ' · partial usage (' + u.knownAttempts + '/' + u.attempts + ' requests)' : '') + (typeof u.cost === 'number' ? ' · <span class="msg-cost" title="Estimated using each request\'s recorded rates; background work after the turn is listed in Usage">' + fmtCost(u.cost) + '</span>' : '') +
			'</span>'
		);
	}

	/** A step's verb while it runs and once it is done; the orb it shows while running. */
	const TOOL_VERBS = {
		read_file: ['Reading', 'Read', 'sphere'],
		view_image: ['Viewing', 'Viewed', 'sphere'],
		get_editor_context: ['Reading', 'Read', 'sphere'],
		list_files: ['Listing', 'Listed', 'bands'],
		grep: ['Searching', 'Searched', 'bands'],
		semantic_search: ['Searching', 'Searched', 'bands'],
		code_intel: ['Searching', 'Searched', 'bands'],
		session_search: ['Searching', 'Searched', 'bands'],
		web_search: ['Searching the web', 'Searched the web', 'bands'],
		web_fetch: ['Fetching', 'Fetched', 'bands'],
		get_diagnostics: ['Checking', 'Checked', 'ring'],
		verify: ['Solving', 'Solved', 'ring'],
		todo_write: ['Planning', 'Planned', 'ring'],
		memory_recall: ['Recalling', 'Recalled', 'sphere'],
		memory_retain: ['Remembering', 'Remembered', 'sphere'],
		edit_lines: ['Editing', 'Edited', 'scatter'],
		image_generate: ['Generating image', 'Generated image', 'spark'],
		task: ['Delegating', 'Delegated', 'spark'],
		delegate_to_helper: ['Delegating', 'Delegated', 'spark'],
		run_script: ['Running', 'Ran', 'spark']
	};
	/** The leading glyph of a step: the live orb while it runs, a red mark on failure, else its icon. */
	function stepGlyph(status, icon, orb) {
		if (status === 'running') return '<span class="tool-ico live">' + window.ZcOrb.html(orb || 'scatter') + '</span>';
		if (status === 'error') return '<span class="tool-ico status-err"><svg class="tcc-err" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M8 4.9v3.5M8 10.9v.1"/></svg></span>';
		return '<span class="tool-ico">' + I(icon) + '</span>';
	}

	/** A tool's wall time the way the Tool Call Card prints it: 240ms, 1.4s, 2m 05s. */
	function fmtToolMs(ms) {
		if (ms < 1000) return Math.max(1, Math.round(ms)) + 'ms';
		if (ms < 60000) return (Math.floor(ms / 100) / 10).toFixed(1) + 's';
		const s = Math.floor(ms / 1000);
		return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
	}

	const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
	function highlightJson(text) {
		let out = '';
		let at = 0;
		let m;
		JSON_TOKEN.lastIndex = 0;
		while ((m = JSON_TOKEN.exec(text))) {
			out += esc(text.slice(at, m.index));
			if (m[1] && m[2]) out += '<span class="tcc-key">' + esc(m[1]) + '</span>' + esc(m[2]);
			else out += '<span class="tcc-' + (m[1] ? 'str' : /^[tfn]/.test(m[0]) ? 'lit' : 'num') + '">' + esc(m[0]) + '</span>';
			at = m.index + m[0].length;
		}
		return out + esc(text.slice(at));
	}

	/**
	 * A tool's output as the Tool Call Card's panel: a labelled block with a copy button,
	 * JSON pretty-printed and coloured, long output capped behind "Show all", and a failure
	 * stated on a red panel above it.
	 */
	function toolPanel(m) {
		const tl = m.tool;
		const raw = String(tl.detail || '');
		let text = raw;
		let json = false;
		if (/^\s*[{[]/.test(raw)) {
			try {
				text = JSON.stringify(JSON.parse(raw), null, 2);
				json = true;
			} catch { /* not JSON: shown as it came */ }
		}
		const capped = text.split('\n').length > 12 || text.length > 1600;
		const all = ui.expanded.has('all:' + m.id);
		const failed = tl.status === 'error';
		return h('div', 'tcc-panel',
			(failed ? '<div class="tcc-error"><svg class="tcc-err" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="M8 4.9v3.5M8 10.9v.1"/></svg><p>' + esc(tl.summary || 'The tool call failed.') + '</p></div>' : '') +
			'<div class="tcc-section"><div class="tcc-section-head"><span class="tcc-label">' + (failed ? 'Output' : 'Result') + '</span><button type="button" class="tcc-copy" data-copy-detail="' + esc(m.id) + '" title="' + esc(t('copy')) + '" aria-label="' + esc(t('copy')) + '">' + I('copy') + '</button></div>' +
			'<pre class="tcc-code' + (capped && !all ? ' capped' : '') + '"><code>' + (json ? highlightJson(text) : esc(text)) + '</code></pre>' +
			(capped ? '<button type="button" class="tcc-more" data-show-all="' + esc(m.id) + '" aria-expanded="' + all + '">' + (all ? 'Show less' : 'Show all') + '</button>' : '') + '</div>');
	}

	function toolRow(m) {
		const tl = m.tool;
		const meta = toolMeta(tl.name);
		const verbs = TOOL_VERBS[tl.name];
		const running = tl.status === 'running';
		const open = ui.expanded.has(m.id);
		const row = h('div', 'msg tool tool-row' + (open ? ' open' : '') + (tl.status === 'error' ? ' error' : '') + (running ? ' running' : ''));
		const expandable = !!tl.detail;
		const status = stepGlyph(tl.status, meta[0], verbs ? verbs[2] : tl.name.startsWith('browser_') ? 'bands' : 'scatter');
		const isLink = PATH_TOOLS.has(tl.name) && tl.arg;
		const name = verbs && tl.status !== 'error' ? verbs[running ? 0 : 1] : meta[1];
		const head = h(
			'button',
			'tool-head' + (expandable ? ' expandable' : ''),
			status +
				'<span class="tool-name' + (running ? ' shimmer' : '') + '">' + esc(name) + '</span>' +
				'<span class="tool-arg' + (isLink ? ' link' : '') + '"' + (isLink ? ' data-open-path="' + esc(tl.arg) + '"' : '') + ' title="' + esc(tl.arg) + '">' + (isLink ? fileBadge(tl.arg) + '<span class="tool-file">' + esc(basename(tl.arg) || tl.arg) + '</span>' : esc(tl.arg)) + '</span>' +
				'<span class="tool-sum" title="' + esc(tl.summary) + '">' + esc(tl.summary) + '</span>' + toolStatus(tl.status === 'done' ? 'success' : tl.status) +
				(tl.name === 'task' && tl.status === 'running' ? '<span class="tool-stop" role="button" tabindex="0" data-stop-agent="' + esc(m.id) + '" title="Stop this agent" aria-label="Stop this agent">' + I('stop') + '</span>' : '') +
				(!running && Number.isFinite(tl.durationMs) ? '<span class="tool-time">' + fmtToolMs(tl.durationMs) + '</span>' : '') +
				(expandable ? '<span class="chev">' + I('chevronRight') + '</span>' : '')
		);
		if (expandable) head.dataset.toggle = m.id;
		if (expandable) head.setAttribute('aria-expanded', String(open));
		row.setAttribute('aria-busy', String(tl.status === 'running'));
		if (Number.isFinite(tl.durationMs)) head.title = 'Tool wall time: ' + (tl.durationMs / 1000).toFixed(3) + ' s, including hooks and approval waits';
		row.appendChild(head);
		if (tl.status === 'error' && window.RecoveryUI) row.insertAdjacentHTML('beforeend', window.RecoveryUI.html(tl.name === 'run_command' ? 'command' : 'tool', tl.detail || tl.summary, tl.name));
		if (tl.image) {
			const generated = tl.name === 'image_generate';
			const card = generated
				? h('div', 'gen-image-card', '<img alt="Generated image" src="' + esc(tl.image) + '">')
				: h('div', 'browser-card', '<div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="u">' + esc(tl.url || '') + '</span></div><img alt="Browser screenshot" src="' + esc(tl.image) + '">');
			card.dataset.zoom = tl.image;
			card.dataset.caption = generated ? tl.summary || '' : tl.url || '';
			card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-label', generated ? 'Open generated image in image viewer' : 'Open screenshot in image viewer');
			row.appendChild(card);
		}
		if (open && tl.detail) row.appendChild(toolPanel(m));
		return row;
	}

	/*
	 * Inline Diff: a removed line and the line that replaced it are shown as a pair, and only
	 * the words that changed get the strong highlight, so a one-word edit reads at a glance.
	 */
	function lcsPairs(a, b) {
		const n = a.length, m = b.length;
		const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
		for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		const out = [];
		let i = 0, j = 0;
		while (i < n || j < m) {
			if (i < n && j < m && a[i] === b[j]) { out.push(['=', a[i]]); i++; j++; }
			else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) out.push(['+', b[j++]]);
			else out.push(['-', a[i++]]);
		}
		return out;
	}
	/** The two sides of a changed line with their changed words marked. */
	function wordMarks(before, after) {
		if (before.length > 400 || after.length > 400) return [esc(before), esc(after)];
		const tok = (x) => x.match(/\s+|\w+|[^\w\s]/g) || [];
		// Each side as runs of [changed, text]; neighbouring changed tokens share one mark.
		const sides = { '-': [], '+': [] };
		const push = (side, changed, w) => {
			const runs = sides[side];
			const last = runs[runs.length - 1];
			if (last && last[0] === changed) last[1] += w;
			else runs.push([changed, w]);
		};
		for (const [op, w] of lcsPairs(tok(before), tok(after))) {
			if (op === '=') { push('-', false, w); push('+', false, w); }
			else push(op, true, w);
		}
		const html = (runs) => runs.map(([changed, w]) => (changed && w.trim() ? '<mark class="dw">' + esc(w) + '</mark>' : esc(w))).join('');
		return [html(sides['-']), html(sides['+'])];
	}
	/** Removed lines then added lines of one hunk, word-marked where they pair up. */
	function pairedLines(dels, adds) {
		let html = '';
		const marks = dels.map((d, i) => (i < adds.length ? wordMarks(d, adds[i]) : [esc(d), '']));
		dels.forEach((d, i) => { html += '<span class="ln del">- ' + marks[i][0] + '</span>'; });
		adds.forEach((a, i) => { html += '<span class="ln add">+ ' + (i < dels.length ? marks[i][1] : esc(a)) + '</span>'; });
		return html;
	}
	/** An edit's find/replace as an inline diff: unchanged lines as context, changed ones paired. */
	function editDiff(find, replace, max) {
		const a = String(find).replace(/\r\n/g, '\n').split('\n');
		const b = String(replace).replace(/\r\n/g, '\n').split('\n');
		if (a.length * b.length > 40000) return diffLines(find, 'del', '-', max) + diffLines(replace, 'add', '+', max);
		let html = '', shown = 0, dels = [], adds = [];
		const flush = () => { if (dels.length || adds.length) html += pairedLines(dels, adds); shown += dels.length + adds.length; dels = []; adds = []; };
		for (const [op, line] of lcsPairs(a, b)) {
			if (shown >= max) break;
			if (op === '=') { flush(); html += '<span class="ln ctx">  ' + esc(line) + '</span>'; shown++; }
			else (op === '-' ? dels : adds).push(line);
		}
		flush();
		const total = a.length + b.length;
		return html + (shown < total && shown >= max ? '<div class="more">… more lines</div>' : '');
	}

	function diffLines(text, cls, sign, max) {
		const lines = String(text).replace(/\r\n/g, '\n').split('\n');
		return lines.slice(0, max).map((l) => '<span class="ln ' + cls + '">' + sign + ' ' + esc(l) + '</span>').join('') + (lines.length > max ? '<div class="more">… ' + (lines.length - max) + ' more lines</div>' : '');
	}

	/** Colored preview of a patch: file headers, @@ anchors, +/- lines. */
	function patchLines(text, max) {
		const lines = String(text).replace(/\r\n/g, '\n').split('\n');
		let html = '', dels = [], adds = [];
		const flush = () => { if (dels.length || adds.length) html += pairedLines(dels, adds); dels = []; adds = []; };
		for (const l of lines.slice(0, max)) {
			if (l[0] === '-' && !/^--- /.test(l)) { if (adds.length) flush(); dels.push(l.slice(1)); continue; }
			if (l[0] === '+' && !/^\+\+\+ /.test(l)) { adds.push(l.slice(1)); continue; }
			flush();
			if (/^\*\*\* /.test(l)) html += '<span class="ln hd">' + esc(l.replace(/^\*\*\* /, '')) + '</span>';
			else if (/^@@/.test(l)) html += '<span class="ln hunk">' + esc(l) + '</span>';
			else html += '<span class="ln ctx">  ' + esc(l.replace(/^ /, '')) + '</span>';
		}
		flush();
		return html + (lines.length > max ? '<div class="more">… ' + (lines.length - max) + ' more lines</div>' : '');
	}

	function approvalPhase(a) {
		if (a.status === 'pending') return 'pending';
		if (a.status === 'rejected') return 'rejected';
		if (a.failed || a.execution === 'error') return 'error';
		if (a.execution === 'running') return 'running';
		if (a.execution === 'done' || typeof a.result === 'string') return 'success';
		return 'unknown';
	}

	function toolStatus(phase) {
		const label = { pending: 'Needs approval', running: 'Running', success: 'Completed', error: 'Failed', rejected: 'Rejected', unknown: 'Result unavailable' }[phase] || 'Result unavailable';
		return '<span class="tool-status ' + phase + '">' + label + '</span>';
	}

	/** What an approval would do, as coloured lines: the command, the call's arguments or the diff. */
	function approvalBody(a) {
		if (a.kind === 'command') return '<div class="cmd">$ ' + esc(a.command || '') + '</div>';
		if (a.kind === 'mcp') return '<div class="json">' + esc(a.args || '{}') + '</div>';
		if (a.kind === 'image') return '<div class="json">' + esc(a.content || '') + '</div>';
		if (a.kind === 'write') return diffLines(a.content || '', 'add', '+', 60);
		if (a.kind === 'patch') return patchLines(a.content || '', 120);
		return editDiff(a.find || '', a.replace || '', 160);
	}

	const APC_RISK = { low: 'Low', medium: 'Medium', high: 'High' };
	const APC_KEY = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? '⌘↵' : 'Ctrl ↵';

	/**
	 * A pending approval as the Approval Card: what wants to run and where, its risk, a
	 * preview, and Reject / Approve with their shortcuts (Esc, Ctrl+Enter or ⌘↵ while the
	 * card has focus).
	 */
	function renderPendingApproval(m, kind) {
		const a = m.approval;
		const risk = (a.kind === 'command' && a.escalate) || a.destructive ? 'high' : a.kind === 'command' || a.kind === 'mcp' || (a.kind === 'image' && a.cost) ? 'medium' : 'low';
		const desc = a.path
			? '<p class="apc-desc path" data-open-path="' + esc(a.path) + '" title="' + esc(a.path) + '">' + esc(a.path) + '</p>'
			: a.tool ? '<p class="apc-desc">' + esc(a.tool) + '</p>'
			: a.kind === 'command' ? '<p class="apc-desc">' + esc(a.escalate ? 'Outside the sandbox' : 'In your workspace') + '</p>' : '';
		const card = h('div', 'msg tool approval pending apc');
		card.setAttribute('role', 'group');
		card.setAttribute('aria-label', kind[1] + (a.path ? ': ' + a.path : ''));
		card.innerHTML =
			'<div class="apc-card"><div class="apc-head"><span class="apc-icon" aria-hidden="true">' + I(kind[0]) + '</span><div class="apc-titles"><h3 class="apc-title">' + esc(kind[1]) + '</h3>' + desc + '</div>' +
			'<span class="apc-risk" data-risk="' + risk + '">' + APC_RISK[risk] + '<span class="apc-risk-word"> risk</span></span></div>' +
			'<div class="apc-preview approval-body">' + approvalBody(a) + '</div>' +
			(a.kind === 'command' && a.escalate ? '<div class="approval-note">' + I('shield') + '<span>Wants to run <b>outside the sandbox</b> — it can write anywhere your account can.</span></div>' : '') +
			(a.kind === 'command' && a.sandboxed && a.sandboxReads === 'all' ? '<div class="approval-note">' + I('shield') + '<span>The sandbox keeps writes inside the project, but this command can <b>read any file</b> on this computer. Add paths under Settings → Agent → “Paths commands cannot read”.</span></div>' : '') +
			(a.kind === 'command' && a.projectRule === 'ask' ? '<div class="approval-note">' + I('list') + '<span>This project’s <b>command rules</b> ask before this command, even in Full access.' + (a.projectRuleReason ? ' Reason: ' + esc(a.projectRuleReason) : '') + '</span></div>' : '') +
			(a.kind === 'command' && a.projectRule === 'pending' ? '<div class="approval-note">' + I('list') + '<span>This project’s <b>command rules</b> would allow this command, but you have not trusted them yet (Settings → Agent).</span></div>' : '') +
			'<div class="apc-foot">' + toolStatus('pending') + '<div class="apc-actions">' +
			'<button type="button" class="apc-btn quiet" data-reject="' + esc(a.id) + '" aria-keyshortcuts="Escape">' + esc(t('reject')) + '<kbd class="apc-kbd" aria-hidden="true">Esc</kbd></button>' +
			(a.kind === 'command' && !a.escalate && a.projectRule !== 'ask' ? '<button type="button" class="apc-btn quiet" data-always="' + esc(a.id) + '" title="' + esc(t('alwaysRun')) + '">' + esc(t('alwaysRun')) + '</button>' : '') +
			'<button type="button" class="apc-btn primary" data-approve="' + esc(a.id) + '" aria-keyshortcuts="Control+Enter Meta+Enter">' + esc(a.kind === 'command' || a.kind === 'mcp' ? t('run') : t('accept')) + '<kbd class="apc-kbd" aria-hidden="true">' + APC_KEY + '</kbd></button>' +
			'</div></div></div>';
		return card;
	}

	function renderApproval(m) {
		const a = m.approval;
		const phase = approvalPhase(a);
		const kind = a.kind === 'command' ? ['terminal', 'Run command'] : a.kind === 'mcp' ? ['plug', 'MCP tool'] : a.kind === 'image' ? ['image', 'Generate image'] : a.kind === 'write' ? ['file', a.existed ? 'Overwrite file' : 'Create file'] : a.kind === 'patch' ? ['pencil', 'Apply changes'] : ['pencil', 'Edit file'];
		if (a.status === 'pending') return renderPendingApproval(m, kind);
		const card = h('div', 'msg tool approval ' + a.status + ' ' + phase);
		card.setAttribute('aria-busy', String(phase === 'running'));
		let html = '<div class="approval-head">' + I(kind[0]) + '<span class="title">' + kind[1] + '</span>';
		if (a.path) html += '<span class="path" data-open-path="' + esc(a.path) + '" title="' + esc(a.path) + '">' + esc(a.path) + '</span>';
		if (a.tool) html += '<span class="path">' + esc(a.tool) + '</span>';
		html += toolStatus(phase) + '</div><div class="approval-body">' + approvalBody(a) + '</div>';
		if (a.result) html += '<div class="approval-result' + (a.failed ? ' failed' : '') + '">' + esc(a.result) + '</div>';
		html += '<div class="approval-foot">';
		{
			const label = phase === 'rejected' ? t('rejected') : phase === 'error' ? 'Failed' : phase === 'running' ? 'Approved · running' : phase === 'unknown' ? 'Approved · result unavailable' : 'Completed';
			html += '<span class="state ' + phase + '">' + (phase === 'success' ? I('check') + ' ' : '') + esc(label) + '</span>';
			if (a.auto) html += '<span class="auto-chip">' + esc(a.autoRule ? t('autoApprovedBy', { x: a.autoRule }) : t('autoApproved')) + '</span>';
		}
		card.innerHTML = html + '</div>';
		if (phase === 'error' && window.RecoveryUI) card.insertAdjacentHTML('beforeend', window.RecoveryUI.html(a.kind === 'command' ? 'command' : a.kind === 'mcp' ? 'mcp' : 'tool', a.result, a.tool));
		return card;
	}

	function approvalRow(m) {
		const a = m.approval;
		const phase = approvalPhase(a), running = phase === 'running', success = phase === 'success';
		const open = ui.expanded.has(m.id);
		const failed = phase === 'rejected' || phase === 'error';
		const lines = (s) => (s ? String(s).replace(/\r\n/g, '\n').split('\n').length : 0);
		let icon = 'pencil';
		let verb = t('rowEdited');
		let arg = a.path || '';
		let sum = '';
		if (a.kind === 'command') {
			icon = 'terminal';
			verb = t('rowRan');
			const bg = /# background$/.test(a.command || '');
			arg = (a.command || '').replace(/\s+# background$/, '');
			const code = String(a.result || '').match(/exit code (-?\d+)/);
			sum = a.status === 'rejected' ? t('rejected') : /timed out/.test(a.result || '') ? 'timed out' : bg ? 'background' : code ? (code[1] === '0' ? '✓ exit 0' : '✗ exit ' + code[1]) : failed ? '✗ failed' : '✓';
		} else if (a.kind === 'mcp') {
			icon = 'plug';
			verb = t('rowCalled');
			arg = a.tool || '';
			sum = a.status === 'rejected' ? t('rejected') : failed ? '✗ error' : '✓';
		} else if (a.kind === 'image') {
			icon = 'image';
			verb = 'Generated image';
			arg = a.path || '';
			sum = a.status === 'rejected' ? t('rejected') : failed ? '✗ failed' : '✓';
		} else if (a.kind === 'write') {
			icon = 'file';
			verb = a.existed ? t('rowRewrote') : t('rowCreated');
			sum = a.status === 'rejected' ? t('rejected') : '+' + lines(a.content);
		} else if (a.kind === 'patch') {
			verb = t('rowChanged');
			const body = String(a.content || '').split('\n');
			sum = a.status === 'rejected' ? t('rejected') : '+' + body.filter((l) => l[0] === '+').length + ' −' + body.filter((l) => l[0] === '-').length;
		} else {
			sum = a.status === 'rejected' ? t('rejected') : '+' + lines(a.replace) + ' −' + lines(a.find);
		}
		if (running || phase === 'unknown' || phase === 'error') sum = running ? '' : phase === 'error' ? 'Failed' : 'Result unavailable';
		if (running) verb = a.kind === 'command' ? 'Running' : a.kind === 'mcp' ? 'Calling' : a.kind === 'image' ? 'Generating' : a.kind === 'write' ? 'Writing' : 'Editing';
		else if (!success) verb = a.kind === 'command' ? 'Command' : a.kind === 'mcp' ? 'Tool' : a.kind === 'image' ? 'Image' : 'Change';
		else if (a.kind === 'write') verb = a.existed ? 'Rewrote' : 'Wrote';
		const row = h('div', 'msg tool tool-row approval-row' + (open ? ' open' : '') + (failed ? ' error' : '') + (running ? ' running' : ''));
		row.setAttribute('aria-busy', String(running));
		const isPath = a.kind !== 'command' && a.kind !== 'mcp' && a.path && !/ → |^\d+ files$|^rename /.test(a.path);
		const orb = a.kind === 'command' ? 'spark' : a.kind === 'mcp' ? 'bands' : 'scatter';
		const head = h(
			'button',
			'tool-head expandable',
			stepGlyph(running ? 'running' : failed ? 'error' : 'done', icon, orb) +
				'<span class="tool-name' + (running ? ' shimmer' : '') + '">' + esc(verb) + '</span>' +
				'<span class="tool-arg' + (a.kind === 'command' ? ' mono-arg' : '') + (isPath ? ' link' : '') + '"' + (isPath ? ' data-open-path="' + esc(a.path) + '"' : '') + ' title="' + esc(arg) + '">' + (isPath ? fileBadge(a.path) + '<span class="tool-file">' + esc(basename(a.path) || a.path) + '</span>' : esc(arg)) + '</span>' +
				(/^\+\d+( −\d+)?$/.test(sum)
					? '<span class="tool-sum diff"><span class="plus">' + esc(sum.split(' ')[0]) + '</span>' + (sum.includes(' ') ? '<span class="minus">' + esc(sum.split(' ')[1]) + '</span>' : '') + '</span>'
					: '<span class="tool-sum ' + (failed ? 'bad' : success && /^[+✓]/.test(sum) ? 'good' : '') + '">' + esc(sum) + '</span>') + toolStatus(phase) +
				(a.sandboxed ? '<span class="auto-chip sandbox-chip" title="Ran in the OS sandbox: writes only inside the workspace">sandbox</span>' : a.escalate ? '<span class="auto-chip escalate-chip" title="Ran outside the sandbox">unsandboxed</span>' : '') +
				(a.auto ? '<span class="auto-chip" title="' + esc(a.autoRule ? t('autoApprovedBy', { x: a.autoRule }) : t('autoApproved')) + '">auto</span>' : '') +
				'<span class="chev">' + I('chevronRight') + '</span>'
		);
		head.dataset.toggle = m.id;
		head.setAttribute('aria-expanded', String(open));
		row.appendChild(head);
		if (open) {
			const full = renderApproval(m);
			full.classList.add('embedded');
			row.appendChild(full);
		}
		if (!open && phase === 'error' && window.RecoveryUI) row.insertAdjacentHTML('beforeend', window.RecoveryUI.html(a.kind === 'command' ? 'command' : a.kind === 'mcp' ? 'mcp' : 'tool', a.result, a.tool));
		// A rejected command can become a project rule, so the next one asks (or never runs) by itself.
		if (phase === 'rejected' && a.kind === 'command' && a.command && !ruleAdded.has(a.id)) {
			const pattern = rulePattern(a.command);
			row.insertAdjacentHTML('beforeend', '<div class="rule-suggest"><span>' + I('list') + 'Make it a project rule:</span><button type="button" class="apc-btn quiet" data-rule="ask" data-rule-for="' + esc(a.id) + '" data-pattern="' + esc(pattern) + '">Always ask for <code>' + esc(pattern) + '</code></button><button type="button" class="apc-btn quiet" data-rule="deny" data-rule-for="' + esc(a.id) + '" data-pattern="' + esc(pattern) + '">Never run it</button></div>');
		}
		return row;
	}

	/** The rule a rejected command suggests: its program and subcommand (`git push*`), or the program alone (`rm *`). */
	function rulePattern(command) {
		const words = String(command).replace(/\s+# background$/, '').trim().split(/\s+/);
		return words.length > 1 && /^[\w.:-]+$/.test(words[1]) && !words[1].startsWith('-') ? words[0] + ' ' + words[1] + '*' : words[0] + (words.length > 1 ? ' *' : '');
	}

	function renderQuestion(m) {
		const q = m.question;
		if (q.status === 'pending') {
			const sending = questionUi.submitted.has(q.id);
			return h('div', 'msg tool question-pending', '<span class="q-pending-icon">' + I('chat') + '</span><div class="q-pending-copy"><span class="q-pending-label">' + esc(t('agentAsking')) + '</span><div class="q-pending-text">' + esc(q.text) + '</div></div><button class="q-reopen" data-question-open="' + esc(q.id) + '"' + (sending ? ' disabled' : '') + '>' + esc(t(sending ? 'questionSending' : 'answer')) + '</button>');
		}
		const card = h('div', 'msg tool question-card');
		let html = '<div class="q-head">' + I('info') + '<span>' + esc(t('agentAsking')) + '</span></div><div class="q-text md">' + MD.render(q.text) + '</div>';
		html += '<div class="q-answer">' + (q.status === 'answered' ? I('check') + '<span>' + esc(q.answer || '') + '</span>' : '<span>—</span>') + '</div>';
		card.innerHTML = html;
		return card;
	}

	// Float in front of the prompt box, outside the chat column's layout, so
	// transcript updates preserve drafts and keyboard focus.
	const questionUi = { popup: null, dismissed: new Set(), submitted: new Set(), drafts: new Map() };
	const pendingQuestion = (id) => state.messages.find((m) => m.question?.status === 'pending' && m.question.id === id)?.question;

	function closeQuestionPopup(dismiss, restoreFocus = true) {
		const active = questionUi.popup;
		if (!active) return;
		if (dismiss) questionUi.dismissed.add(active.id);
		const hadFocus = active.dialog.contains(document.activeElement);
		questionUi.popup = null;
		active.observer.disconnect();
		window.removeEventListener('resize', positionQuestionPopup);
		active.viewport?.removeEventListener('resize', positionQuestionPopup);
		active.viewport?.removeEventListener('scroll', positionQuestionPopup);
		active.dialog.remove();
		if (restoreFocus && hadFocus) (active.returnFocus?.isConnected ? active.returnFocus : el.input).focus({ preventScroll: true });
	}

	function positionQuestionPopup() {
		const active = questionUi.popup;
		if (!active) return;
		// A phone lays the question out as a bottom sheet in CSS (chat.css, body.remote),
		// so the desktop's absolute anchoring would only fight it.
		if (document.body?.classList?.contains('remote')) return;
		const anchor = el.inputCard.getBoundingClientRect();
		const viewport = active.viewport;
		const viewLeft = viewport?.offsetLeft || 0;
		const viewTop = viewport?.offsetTop || 0;
		const viewWidth = viewport?.width || window.innerWidth;
		const viewHeight = viewport?.height || window.innerHeight;
		const width = Math.max(0, Math.min(420, viewWidth - 16));
		const center = Math.max(viewLeft + 8 + width / 2, Math.min(anchor.left + anchor.width / 2, viewLeft + viewWidth - 8 - width / 2));
		const edge = Math.max(viewTop + 8, Math.min(anchor.bottom, viewTop + viewHeight - 8));
		active.dialog.style.setProperty('left', center + 'px');
		active.dialog.style.setProperty('bottom', (window.innerHeight - edge) + 'px');
		active.dialog.style.setProperty('width', width + 'px');
		active.dialog.style.setProperty('--question-popup-max-height', Math.max(0, Math.min(320, edge - viewTop - 8)) + 'px');
	}

	function answerQuestion(id, answer) {
		if (!pendingQuestion(id) || questionUi.submitted.has(id)) return;
		questionUi.submitted.add(id);
		closeQuestionPopup(false);
		post({ type: 'answer', id, answer: answer.trim() });
		renderMessages();
		// A dropped Mobile Remote request must not leave the reopen button locked.
		setTimeout(() => {
			if (!questionUi.submitted.delete(id) || !pendingQuestion(id)) return;
			questionUi.dismissed.add(id);
			renderMessages();
		}, 5000);
	}

	function openQuestionPopup(id) {
		const q = pendingQuestion(id);
		if (!q || questionUi.submitted.has(id)) return;
		const sig = JSON.stringify([q, window.I18N.current]);
		if (questionUi.popup?.id === id && questionUi.popup.sig === sig) return;
		const returnFocus = questionUi.popup?.returnFocus || document.activeElement;
		closeQuestionPopup(false, false);
		closeMenus();
		closePopup();
		const dialog = h('section', 'question-popup');
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'false');
		dialog.setAttribute('aria-labelledby', 'question-popup-title');
		dialog.setAttribute('aria-describedby', 'question-popup-text');
		const options = q.options || [];
		dialog.innerHTML =
			'<header class="q-popup-head">' + I('chat') + '<h2 id="question-popup-title">' + esc(t('agentAsking')) + '</h2><button class="icon-btn q-popup-close" title="' + esc(t('close')) + '" aria-label="' + esc(t('close')) + '" data-question-close>' + I('close') + '</button></header>' +
			'<div class="q-popup-body"><div id="question-popup-text" class="q-text md">' + MD.render(q.text) + '</div><div class="q-options">' +
			options.map((o, i) => '<button class="q-opt" data-question-option="' + i + '"><span class="q-key">' + (i + 1) + '</span><span class="q-label">' + esc(o) + '</span><span class="q-option-arrow" aria-hidden="true">' + I('chevronRight') + '</span></button>').join('') +
			'</div><form class="q-custom"><div class="q-row"><textarea id="question-popup-answer" rows="1" aria-label="' + esc(t('questionYourReply')) + '" placeholder="' + esc(t('typeAnswer')) + '"></textarea><button class="q-send" type="submit" title="' + esc(t('answer')) + '" aria-label="' + esc(t('answer')) + '" disabled>' + I('arrowUp') + '</button></div></form></div>' +
			'<footer class="q-popup-foot"><span class="q-hint"><kbd>Esc</kbd><span>' + esc(t('close')) + '</span>' + (options.length ? '<span class="q-hint-sep">·</span><kbd>1–' + Math.min(options.length, 9) + '</kbd>' : '') + '</span><button class="q-skip" data-question-skip>' + esc(t('skip')) + '</button></footer>';
		const field = dialog.querySelector('textarea');
		const sendButton = dialog.querySelector('.q-send');
		field.value = questionUi.drafts.get(id) || '';
		sendButton.disabled = !field.value.trim();
		field.addEventListener('input', () => {
			questionUi.drafts.set(id, field.value);
			sendButton.disabled = !field.value.trim();
		});
		const submit = () => { if (field.value.trim()) answerQuestion(id, field.value); };
		dialog.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
		dialog.addEventListener('click', (e) => {
			const target = e.target instanceof Element ? e.target : null;
			if (!target) return;
			const option = target.closest('[data-question-option]');
			if (option) answerQuestion(id, options[Number(option.dataset.questionOption)]);
			else if (target.closest('[data-question-close]')) closeQuestionPopup(true);
			else if (target.closest('[data-question-skip]')) answerQuestion(id, '');
			else if (target.closest('a[data-href]')) {
				e.preventDefault();
				post({ type: 'openExternal', url: target.closest('a[data-href]').dataset.href });
			} else if (target.closest('code.file-ref, .file-link, .mention')) {
				const link = target.closest('code.file-ref, .file-link, .mention');
				const path = link.dataset.open;
				const line = link.dataset.line ? Number(link.dataset.line) : undefined;
				if (document.body.classList.contains('desktop') && path) {
					auxOpenPreview(path, line);
				} else {
					post({ type: 'openFile', path, line });
				}
			}
		});
		dialog.addEventListener('keydown', (e) => {
			// Escape dismisses the popup without stopping the run or leaving full screen.
			e.stopPropagation();
			if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
			if (e.key === 'Escape') { e.preventDefault(); closeQuestionPopup(true); return; }
			if (e.target === field) {
				if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
				return;
			}
			const opts = [...dialog.querySelectorAll('.q-opt')];
			const at = opts.indexOf(e.target.closest('.q-opt'));
			if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && opts.length) {
				e.preventDefault();
				if (at < 0) opts[0].focus();
				else (opts[at + (e.key === 'ArrowDown' ? 1 : -1)] || field).focus();
			} else if (/^[1-9]$/.test(e.key) && options[Number(e.key) - 1] !== undefined) {
				e.preventDefault();
				answerQuestion(id, options[Number(e.key) - 1]);
			}
		});
		document.body.appendChild(dialog);
		const observer = new ResizeObserver(positionQuestionPopup);
		const viewport = window.visualViewport;
		questionUi.popup = { id, sig, dialog, returnFocus, observer, viewport };
		positionQuestionPopup();
		observer.observe(el.inputCard);
		observer.observe(el.inputCard.parentElement);
		observer.observe(el.app);
		window.addEventListener('resize', positionQuestionPopup);
		viewport?.addEventListener('resize', positionQuestionPopup);
		viewport?.addEventListener('scroll', positionQuestionPopup);
		(dialog.querySelector('.q-opt') || field).focus({ preventScroll: true });
	}

	function syncQuestionPopup() {
		const pending = state.messages.filter((m) => m.question?.status === 'pending').map((m) => m.question);
		const ids = new Set(pending.map((q) => q.id));
		for (const set of [questionUi.dismissed, questionUi.submitted, questionUi.drafts]) {
			for (const id of set.keys()) if (!ids.has(id)) set.delete(id);
		}
		if (questionUi.popup) {
			if (ids.has(questionUi.popup.id)) { openQuestionPopup(questionUi.popup.id); return; }
			closeQuestionPopup(false);
		}
		const next = pending.find((q) => !questionUi.dismissed.has(q.id) && !questionUi.submitted.has(q.id));
		if (next) openQuestionPopup(next.id);
	}

	function renderMessage(m, opts) {
		opts = opts || {};
		if (m.role === 'user' && !m.kind) return renderUser(m);
		if (m.approval) return m.approval.status === 'pending' ? renderApproval(m) : approvalRow(m);
		if (m.question) return renderQuestion(m);
		if (m.kind === 'tool' && m.tool) return toolRow(m);
		return renderAssistant(m, opts);
	}

	function renderGroup(u) {
		const open = ui.expanded.has(u.id);
		let label;
		let summary;
		if (u.cat === 'explore') {
			const files = u.items.filter((m) => m.tool.name === 'read_file').length;
			const searches = u.items.filter((m) => /grep|search/.test(m.tool.name)).length;
			label = t('explored');
			summary = [files && files + ' file' + (files > 1 ? 's' : ''), searches && searches + ' search' + (searches > 1 ? 'es' : ''), u.items.length - files - searches > 0 && u.items.length - files - searches + ' more'].filter(Boolean).join(', ');
		} else if (u.cat === 'terminal') {
			label = 'Ran ' + u.items.length + ' commands';
			const failed = u.items.filter((m) => approvalPhase(m.approval) === 'error').length;
			const rejected = u.items.filter((m) => approvalPhase(m.approval) === 'rejected').length;
			summary = [failed && failed + ' failed', rejected && rejected + ' rejected'].filter(Boolean).join(' · ') || 'all succeeded';
		} else {
			label = t('editedFiles', { n: new Set(u.items.map((m) => m.approval.path)).size });
			summary = u.items.length + ' edits';
		}
		const icon = u.cat === 'explore' ? 'search' : u.cat === 'terminal' ? 'terminal' : 'pencil';
		// The files a group touched, as chips: "Edited  ‹js› app.js, ‹#› styles.css +2".
		const paths = [...new Set(u.items.map((m) => (u.cat === 'changes' ? m.approval.path : m.tool && m.tool.name === 'read_file' ? m.tool.arg : '')).filter((p) => p && !/ → |^\d+ files$|^rename /.test(p)))];
		const chips = paths.slice(0, 3).map((p) => '<span class="file-chip" title="' + esc(p) + '">' + fileBadge(p) + esc(basename(p) || p) + '</span>').join('') + (paths.length > 3 ? '<span class="file-chip more">+' + (paths.length - 3) + '</span>' : '');
		// The group's tools as a stack of small tiles, and their total time once every step reported one.
		const icons = [...new Set(u.items.map((m) => (m.tool ? toolMeta(m.tool.name)[0] : m.approval.kind === 'command' ? 'terminal' : m.approval.kind === 'mcp' ? 'plug' : 'pencil')))].slice(-3);
		const times = u.items.map((m) => (m.tool ? m.tool.durationMs : m.approval.durationMs));
		const total = times.every(Number.isFinite) ? times.reduce((a, b) => a + b, 0) : null;
		const wrap = h('div', 'msg tool tool-row tool-group' + (open ? ' open' : ''));
		const head = h('button', 'tool-head expandable', '<span class="tcc-stack" aria-hidden="true">' + (icons.length ? icons : [icon]).map((x) => '<span class="tcc-tile">' + I(x) + '</span>').join('') + '</span><span class="tool-name">' + esc(label) + '</span><span class="tool-arg chips">' + chips + '</span><span class="tool-sum">' + esc(summary) + '</span>' + (total !== null ? '<span class="tool-time">' + fmtToolMs(total) + '</span>' : '') + '<span class="chev">' + I('chevronRight') + '</span>');
		head.dataset.toggle = u.id;
		wrap.appendChild(head);
		if (open) {
			const body = h('div', 'group-body');
			u.items.forEach((m) => body.appendChild(renderMessage(m)));
			wrap.appendChild(body);
		}
		return wrap;
	}

	/** "Worked for 3m 20s ›" — the steps of a finished turn, collapsed. */
	function renderWorked(u) {
		const open = ui.expanded.has(u.id);
		const turn = u.user.turn;
		const dur = turn.endedAt ? fmtDuration(turn.endedAt - turn.startedAt) : '';
		const wrap = h('div', 'msg worked' + (open ? ' open' : ''));
		const head = h('button', 'worked-head', '<span>' + esc(t('workedFor', { x: dur })) + '</span>' + I('chevronRight'));
		head.dataset.toggle = u.id;
		wrap.appendChild(head);
		if (open) {
			const body = h('div', 'worked-body');
			for (const s of stepUnits(u.steps)) body.appendChild(s.kind === 'group' ? renderGroup(s) : renderMessage(s.m, { step: true }));
			wrap.appendChild(body);
		}
		return wrap;
	}

	// ------------------------------------------------------------ agent tree

	/*
	 * Who started whom: the lead agent and the subagents it started in a turn, as a live
	 * tree. Every card shows status, cost and time; a card's cost rolls up its branch and a
	 * branch folds to one line. Painted in place, so only new cards and links animate in.
	 */
	const AGT_LABEL = { queued: 'Queued', running: 'Running', waiting: 'Needs you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
	const AGT_ICON = {
		running: '<svg class="agt-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-opacity="0.25" stroke-width="2.5"/><path d="M12 3.5A8.5 8.5 0 0 1 20.5 12" stroke="currentColor" stroke-linecap="round" stroke-width="2.5"/></svg>',
		done: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 14L8.5 17.5L19 6.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"/></svg>',
		failed: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13.92 21h-3.85c-4.63 0-6.94 0-7.8-1.5-.85-1.51.33-3.51 2.7-7.5l1.93-3.25C9.18 4.92 10.31 3 12 3s2.82 1.92 5.1 5.75l1.92 3.25c2.37 3.99 3.55 5.99 2.7 7.5-.85 1.5-3.17 1.5-7.8 1.5Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/><path d="M12 9v4" stroke="currentColor" stroke-linecap="round" stroke-width="2.2"/><path d="M12 16.8v.2" stroke="currentColor" stroke-linecap="round" stroke-width="2.6"/></svg>',
		waiting: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l2.5 2.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>',
		stopped: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="2.2"/></svg>',
		queued: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>'
	};
	const AGT_CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 9s-4.42 6-6 6-6-6-6-6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg>';
	const AGT_SPARK = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.2c.4 2.9 1.9 4.4 4.8 4.8-2.9.4-4.4 1.9-4.8 4.8C6.6 7.9 5.1 6.4 2.2 6 5.1 5.6 6.6 4.1 7 1.2Z" fill="currentColor"/><circle cx="11.6" cy="11.4" r="1.1" fill="currentColor" opacity="0.55"/></svg>';
	const AGT_CARD_W = 222;
	const AGT_INDENT = 24;
	const SVG_NS = 'http://www.w3.org/2000/svg';
	const agtFlat = (n) => [n, ...n.children.flatMap(agtFlat)];
	const agtInitials = (name) => name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();

	/** The agents started during the turn at `index`: from its prompt until the next one. */
	function turnAgentRuns(turns, index) {
		const startOf = (u) => (u && ((u.turn && u.turn.startedAt) || u.at)) || 0;
		const start = startOf(turns[index].user);
		const next = turns.slice(index + 1).find((x) => x.user && startOf(x.user));
		const end = next ? startOf(next.user) : Infinity;
		return start ? (state.agentRuns || []).filter((a) => a.stats && a.stats.startedAt >= start && a.stats.startedAt < end) : [];
	}

	function agentTree(user, live, runs) {
		const turn = user.turn || {};
		const status = live ? (state.runState === 'waiting' ? 'waiting' : 'running') : turn.outcome === 'stopped' ? 'stopped' : turn.outcome === 'failed' ? 'failed' : 'done';
		const root = { id: 'lead', name: 'Orchestrator', model: turn.model || '', task: (user.content || '').split('\n')[0].trim(), status, cost: turn.usage && turn.usage.cost, started: turn.startedAt, ended: live ? undefined : turn.endedAt, tools: [], children: [] };
		const nodes = new Map();
		for (const a of runs) {
			const s = a.stats || {};
			const st = a.status === 'running' ? (a.executionState === 'queued' ? 'queued' : 'running') : a.status === 'completed' ? 'done' : a.status;
			nodes.set(a.id, { id: a.id, name: a.agentName || (a.kind === 'writer' ? 'Writer' : 'Researcher'), model: s.model || a.providerName || '', task: a.description || '', status: st, cost: s.cost, started: s.startedAt, ended: st === 'running' || st === 'queued' ? undefined : s.startedAt + (s.ms || 0), error: a.error, tools: [...new Set((a.tools || []).map((x) => x.name))].slice(-4), children: [] });
		}
		for (const a of runs) (nodes.get(a.parentId) || root).children.push(nodes.get(a.id));
		return root;
	}

	/** A branch's cost: its own plus every sub-agent's. Undefined while nobody reported one. */
	function agentCost(n) {
		let known = typeof n.cost === 'number';
		let sum = known ? n.cost : 0;
		for (const c of n.children) {
			const v = agentCost(c);
			if (v !== undefined) { known = true; sum += v; }
		}
		return known ? sum : undefined;
	}

	function agentTime(n, now) {
		if (!n.started) return '';
		const end = n.ended || (n.status === 'running' || n.status === 'waiting' ? now : n.started);
		const s = Math.max(0, Math.round((end - n.started) / 1000));
		return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
	}

	function agentCardHtml(n) {
		const tools = n.tools.length ? '<span class="agt-tools" aria-hidden="true">' + n.tools.map((name) => '<span class="agt-tool">' + I(toolMeta(name)[0]) + '</span>').join('') + '</span>' : '';
		return '<div class="agt-top"><span class="agt-avatar" aria-hidden="true">' + esc(agtInitials(n.name)) + '</span><span class="agt-who"><span class="agt-name">' + esc(n.name) + '</span>' + (n.model ? '<span class="agt-model">' + esc(n.model) + '</span>' : '') + '</span>' +
			'<span class="agt-status" data-status="' + n.status + '">' + AGT_ICON[n.status] + esc(AGT_LABEL[n.status]) + '</span></div>' +
			'<p class="agt-task">' + tools + esc(n.task) + '</p>';
	}

	/** One card and the group its sub-agents hang in; reused across paints. */
	function agentHang(box, n) {
		let hang = box.agtHangs.get(n.id);
		if (!hang) {
			hang = h('div', 'agt-hang', '<div class="agt-node"><div class="agt-card"></div><div class="agt-meta"><span class="agt-cost"><span class="agt-amount"></span><span class="agt-time"></span></span><button type="button" class="agt-fold" data-agt-fold hidden></button></div></div><div class="agt-below" role="group"></div>');
			hang.setAttribute('role', 'treeitem');
			hang.dataset.agent = n.id;
			box.agtHangs.set(n.id, hang);
		}
		return hang;
	}

	function paintAgentNode(hang, n, now) {
		const node = hang.firstElementChild;
		node.dataset.status = n.status;
		const card = node.firstElementChild;
		const html = agentCardHtml(n);
		if (card.agtHtml !== html) {
			card.innerHTML = html;
			card.agtHtml = html;
		}
		if (n.id !== 'lead') {
			node.dataset.agtOpen = n.id;
			node.tabIndex = 0;
		}
		const cost = agentCost(n);
		const amount = node.querySelector('.agt-amount');
		const costText = cost === undefined ? '—' : fmtCost(cost);
		if (amount.textContent !== costText) amount.textContent = costText;
		amount.classList.toggle('live', agtFlat(n).some((x) => x.status === 'running'));
		amount.title = n.children.length ? 'This branch, with its sub-agents' : '';
		const time = agentTime(n, now);
		const timeEl = node.querySelector('.agt-time');
		const timeText = time ? ' · ' + time : '';
		if (timeEl.textContent !== timeText) timeEl.textContent = timeText;
		const folded = ui.agentFold.has(n.id);
		const fold = node.querySelector('.agt-fold');
		fold.hidden = !n.children.length;
		const foldHtml = (folded ? '+' + (agtFlat(n).length - 1) : n.children.length) + AGT_CHEVRON;
		if (fold.agtHtml !== foldHtml) {
			fold.innerHTML = foldHtml;
			fold.agtHtml = foldHtml;
		}
		fold.setAttribute('aria-expanded', String(!folded));
		fold.setAttribute('aria-label', folded ? 'Show ' + (agtFlat(n).length - 1) + ' sub-agents of ' + n.name : 'Fold the sub-agents of ' + n.name);
		hang.classList.toggle('folded', folded);
		hang.setAttribute('aria-label', n.name + ': ' + AGT_LABEL[n.status]);
		if (n.children.length) hang.setAttribute('aria-expanded', String(!folded));
		else hang.removeAttribute('aria-expanded');
	}

	/** Put `kids` into `container` in order, moving only what is out of place (a move restarts animations). */
	function placeAgentKids(box, container, kids, now) {
		kids.forEach((k, i) => {
			const hang = agentHang(box, k);
			paintAgentNode(hang, k, now);
			if (container.children[i] !== hang) container.insertBefore(hang, container.children[i] || null);
			placeAgentKids(box, hang.lastElementChild, k.children, now);
		});
		while (container.children.length > kids.length) container.lastElementChild.remove();
	}

	function paintAgents(box, u) {
		const root = agentTree(u.user, u.live, u.runs);
		const all = agtFlat(root);
		const now = Date.now();
		if (!box.agtHangs) {
			box.agtHangs = new Map();
			box.agtLinks = new Map();
			box.innerHTML = '<header class="agt-bar"><span class="agt-spark">' + AGT_SPARK + '</span><span class="agt-title">Agents</span><span class="agt-sum" aria-live="polite"></span></header>' +
				'<div class="agt-tree" role="tree" aria-label="Agents"><svg class="agt-links" aria-hidden="true"></svg><div class="agt-root"></div><div class="agt-level" role="group"></div><svg class="agt-links agt-dots" aria-hidden="true"></svg></div>';
			new ResizeObserver(() => layoutAgents(box)).observe(box);
		}
		box.agtRoot = root;
		const running = all.filter((n) => n.status === 'running').length;
		const waiting = all.filter((n) => n.status === 'waiting').length;
		const failed = all.filter((n) => n.status === 'failed');
		const total = agentCost(root);
		const sum = '<span>' + (all.length === 1 ? '1 agent' : all.length + ' agents') + '</span>' +
			(running ? '<span class="agt-sum-run">' + running + ' running</span>' : '') +
			(waiting ? '<span class="agt-sum-chip" data-kind="waiting">' + waiting + ' needs you</span>' : '') +
			(failed.length ? '<button type="button" class="agt-sum-chip" data-kind="failed" data-agt-pop aria-haspopup="dialog" aria-expanded="' + !!box.agtPop + '">' + failed.length + ' failed' + AGT_CHEVRON + '</button>' : '') +
			'<span class="agt-sum-cost"><span class="agt-amount' + (running ? ' live' : '') + '">' + esc(total === undefined ? '—' : fmtCost(total)) + '</span></span>';
		const sumEl = box.querySelector('.agt-sum');
		if (sumEl.agtHtml !== sum) {
			sumEl.innerHTML = sum;
			sumEl.agtHtml = sum;
		}
		if (!failed.length) box.agtPop = false;
		let pop = box.querySelector('.agt-pop');
		if (box.agtPop && !pop) {
			pop = h('div', 'agt-pop');
			pop.setAttribute('role', 'dialog');
			pop.setAttribute('aria-label', 'Agents that failed');
			box.querySelector('.agt-bar').appendChild(pop);
		}
		if (pop && !box.agtPop) pop.remove();
		else if (pop) {
			const html = failed.map((n) => '<div class="agt-pop-item"><span class="agt-pop-head"><span class="agt-status" data-status="failed">' + AGT_ICON.failed + '</span><span class="agt-pop-name">' + esc(n.name) + '</span><span class="agt-pop-task">' + esc(n.task) + '</span></span>' +
				(n.error ? '<span class="agt-pop-text">' + esc(n.error) + '</span>' : '') +
				'<span class="agt-pop-actions"><button type="button" class="agt-btn" data-agt-dismiss>Dismiss</button><button type="button" class="agt-btn agt-btn-primary" data-agt-open="' + esc(n.id) + '">Details</button></span></div>').join('');
			if (pop.agtHtml !== html) {
				pop.innerHTML = html;
				pop.agtHtml = html;
			}
		}
		// The lead's own group stays empty: its sub-agents hang in the level below it.
		const rootHang = agentHang(box, root);
		paintAgentNode(rootHang, root, now);
		const rootSlot = box.querySelector('.agt-root');
		if (rootHang.parentElement !== rootSlot) rootSlot.appendChild(rootHang);
		const level = box.querySelector('.agt-level');
		placeAgentKids(box, level, root.children, now);
		level.hidden = ui.agentFold.has('lead') || !root.children.length;
		const liveIds = new Set(all.map((n) => n.id));
		for (const id of [...box.agtHangs.keys()]) if (!liveIds.has(id)) box.agtHangs.delete(id);
		layoutAgents(box);
		if (running || waiting) ensureAgentClock();
	}

	/** Wide: the lead on top and its sub-agents side by side, when they fit. Narrow: an indented list. */
	function layoutAgents(box) {
		const root = box.agtRoot;
		if (!root || !box.isConnected) return;
		const kids = ui.agentFold.has('lead') ? 0 : root.children.length;
		const width = box.clientWidth;
		box.classList.toggle('wide', width >= 480 && kids * (AGT_CARD_W + AGT_INDENT) + Math.max(0, kids - 1) * 8 <= width);
		drawAgentLinks(box);
	}

	/** An element's layout position inside the tree (offsets, so entry animations don't skew the links). */
	function agtPos(node, tree) {
		let x = 0;
		let y = 0;
		let n = node;
		while (n && n !== tree) {
			x += n.offsetLeft;
			y += n.offsetTop;
			n = n.offsetParent;
		}
		return { x, y, w: node.offsetWidth, h: node.offsetHeight };
	}

	function drawAgentLinks(box) {
		const tree = box.querySelector('.agt-tree');
		const [links, dotsSvg] = tree.querySelectorAll('.agt-links');
		const wide = box.classList.contains('wide');
		const level = tree.querySelector('.agt-level');
		const levelY = !level.hidden && level.firstElementChild ? agtPos(level, tree).y : null;
		const paths = [];
		const dots = new Map();
		const walk = (parentNode, hangs, depth) => {
			const s = agtPos(parentNode, tree);
			for (const hang of hangs) {
				const kid = hang.firstElementChild;
				const l = agtPos(kid, tree);
				const muted = kid.dataset.status === 'queued' || kid.dataset.status === 'stopped';
				let d;
				let dot;
				if (wide && depth === 0) {
					const t = s.x + s.w / 2, n = s.y + s.h, r = l.x + l.w / 2, c = l.y;
					const f = Math.round(n + ((levelY ?? c) - n) / 2), p = r - t, m = Math.max(0, Math.min(8, Math.abs(p) / 2, (c - f) / 2)), sg = Math.sign(p);
					const g = 'M' + t + ' ' + f;
					d = Math.abs(p) < 12 ? g + 'V' + c : g + 'H' + (r - sg * m) + 'Q' + r + ' ' + f + ' ' + r + ' ' + (f + m) + 'V' + c;
					dot = [t, n];
					const stem = paths.find((x) => x.id === 'stem');
					if (stem) stem.muted = stem.muted && muted;
					else paths.push({ id: 'stem', d: 'M' + t + ' ' + n + 'V' + f, muted });
				} else {
					const e = s.x + 21, t = s.y + s.h, n = l.x, r = l.y + 20, a = Math.max(0, Math.min(8, (n - e) / 2, (r - t) / 2));
					d = n - e < 2 ? 'M' + e + ' ' + t + 'V' + l.y : 'M' + e + ' ' + t + 'V' + (r - a) + 'Q' + e + ' ' + r + ' ' + (e + a) + ' ' + r + 'H' + n;
					dot = [e, t];
				}
				paths.push({ id: hang.dataset.agent, d, muted });
				const key = dot.join(',');
				const prev = dots.get(key);
				dots.set(key, { at: dot, muted: prev ? prev.muted && muted : muted });
				if (!hang.classList.contains('folded')) walk(kid, hang.lastElementChild.children, depth + 1);
			}
		};
		if (levelY !== null) walk(tree.querySelector('.agt-root .agt-node'), level.children, 0);
		const now = performance.now();
		const size = [tree.scrollWidth, tree.scrollHeight];
		for (const svg of [links, dotsSvg]) {
			svg.setAttribute('width', size[0]);
			svg.setAttribute('height', size[1]);
		}
		links.replaceChildren(...paths.map((p) => {
			if (!box.agtLinks.has(p.id)) box.agtLinks.set(p.id, now);
			const age = now - box.agtLinks.get(p.id);
			const path = document.createElementNS(SVG_NS, 'path');
			path.setAttribute('d', p.d);
			path.setAttribute('pathLength', '1');
			path.setAttribute('class', 'agt-link' + (p.muted ? ' muted' : '') + (age < 420 && motionOk() ? ' fresh' : ''));
			if (age) path.style.animationDelay = -age + 'ms';
			return path;
		}));
		dotsSvg.replaceChildren(...[...dots.values()].map((dt) => {
			const c = document.createElementNS(SVG_NS, 'circle');
			c.setAttribute('cx', dt.at[0]);
			c.setAttribute('cy', dt.at[1]);
			c.setAttribute('r', '3.25');
			c.setAttribute('class', 'agt-dot' + (dt.muted ? ' muted' : ''));
			return c;
		}));
	}

	/** Running cards count their time every second, even between state updates. */
	let agentClock;
	function ensureAgentClock() {
		if (agentClock) return;
		agentClock = setInterval(() => {
			const boxes = [...el.messages.querySelectorAll('.msg.agt')].filter((b) => b.agtRoot && agtFlat(b.agtRoot).some((n) => n.status === 'running' || n.status === 'waiting'));
			if (!boxes.length) {
				clearInterval(agentClock);
				agentClock = undefined;
				return;
			}
			const now = Date.now();
			for (const b of boxes) for (const n of agtFlat(b.agtRoot)) {
				const hang = b.agtHangs.get(n.id);
				const timeEl = hang && hang.querySelector(':scope > .agt-node .agt-time');
				const time = agentTime(n, now);
				if (timeEl && time) timeEl.textContent = ' · ' + time;
			}
		}, 1000);
	}

	/** A small language badge for a file row (Antigravity style): M↓, py, >_, </>, {}… */
	const FILE_KINDS = [
		[/\.(md|mdx|markdown)$/i, 'md', 'M↓'],
		[/\.(py|pyw|ipynb)$/i, 'py', 'py'],
		[/\.(ts|tsx|mts|cts)$/i, 'ts', 'ts'],
		[/\.(js|jsx|mjs|cjs)$/i, 'js', 'js'],
		[/\.(html?|vue|svelte|astro)$/i, 'html', '</>'],
		[/\.(css|scss|sass|less)$/i, 'css', '#'],
		[/\.(json|jsonc|ya?ml|toml|ini|env|xml)$/i, 'data', '{}'],
		[/\.(bat|cmd|ps1|sh|bash|zsh|fish)$/i, 'shell', '>_'],
		[/\.(rs|go|java|kt|swift|c|cc|cpp|h|hpp|cs|rb|php|lua|dart|zig)$/i, 'code', '‹›'],
		[/\.(png|jpe?g|gif|webp|svg|ico)$/i, 'image', '▣']
	];
	function fileBadge(path) {
		const k = FILE_KINDS.find((x) => x[0].test(path));
		return '<span class="ft ft-' + (k ? k[1] : 'file') + '" aria-hidden="true">' + esc(k ? k[2] : '·') + '</span>';
	}

	function ledgerEffects(items) {
		return (items || []).filter(m => {
			const a = m.approval, tool = m.tool;
			if (a?.kind === 'mcp') return (a.externalAction || a.destructive) && ['success', 'error'].includes(approvalPhase(a));
			return tool?.externalAction && ['done', 'error'].includes(tool.status) && !/^(rejected|blocked by)/.test(tool.summary || '');
		});
	}

	function ledgerDisclosure(card, key, label) {
		const button = h('button', 'ledger-disclosure'); button.type = 'button';
		const body = h('div', 'ledger-body'); body.id = 'ledger-' + encodeURIComponent(key);
		button.setAttribute('aria-controls', body.id);
		button.innerHTML = '<span class="ledger-chevron" aria-hidden="true">›</span><span>' + esc(label) + '</span>';
		const paint = () => { const open = ui.expanded.has(key); button.setAttribute('aria-expanded', String(open)); body.hidden = !open; };
		button.addEventListener('click', () => { ui.expanded.has(key) ? ui.expanded.delete(key) : ui.expanded.add(key); paint(); });
		paint();
		const bar = h('div', 'ledger-summary'); bar.appendChild(button); card.append(bar, body);
		return { bar, body };
	}

	function ledgerTime(at) {
		const mins = Math.max(0, Math.floor((Date.now() - (at || Date.now())) / 60000));
		return mins < 1 ? 'just now' : mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.floor(mins / 60) + 'h ago' : Math.floor(mins / 1440) + 'd ago';
	}

	function renderEdits(u) {
		const turn = u.user.turn, edits = turn.edits || [];
		const card = h('section', 'msg agent-ledger ui-alc');
		const undoIcon = redo => '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="' + (redo ? 'M20 7H9C5.68629 7 3 9.68629 3 13C3 16.3137 5.68629 19 9 19H16M16 3L20 7L16 11' : 'M4 7H15C18.3137 7 21 9.68629 21 13C21 16.3137 18.3137 19 15 19H8M8 3L4 7L8 11') + '" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8"/></svg>';
		card.setAttribute('aria-label', 'File changes');
		const undone = edits.filter(e => e.undone || turn.undone).length;
		const { bar, body } = ledgerDisclosure(card, 'files:' + u.user.id, edits.length + (edits.length === 1 ? ' file changed' : ' files changed') + (undone ? ' · ' + undone + ' undone' : ''));
		const controls = h('div', 'ledger-summary-actions');
		controls.innerHTML = '<button type="button" data-review="' + esc(u.user.id) + '">Review</button>';
		const canUndoTurn = state.undoable.includes(u.user.id) && edits.some(e => !e.undone && !turn.undone && !(turn.undoSkipped || []).includes(e.path));
		const canRedoTurn = undone === edits.length && (state.redoable || []).includes(u.user.id) && edits.some(e => !(turn.undoSkipped || []).includes(e.path));
		if (canUndoTurn || canRedoTurn) controls.innerHTML += '<button type="button" data-undo="' + esc(u.user.id) + '"' + (canRedoTurn ? ' data-redo="true"' : ' data-ledger-preview') + (state.isStreaming ? ' disabled' : '') + '>' + (canRedoTurn ? 'Redo' : 'Undo') + '</button>';
		bar.appendChild(controls);
		const rows = h('ol', 'ui-alc__panel'); rows.setAttribute('aria-label', 'Changed files'); body.appendChild(rows);
		for (const edit of edits) {
			const isUndone = !!(edit.undone || turn.undone), skipped = (turn.undoSkipped || []).includes(edit.path);
			const canUndo = state.undoable.includes(u.user.id) && !isUndone && !skipped;
			const canRedo = (state.redoable || []).includes(u.user.id) && isUndone && !skipped;
			const action = edit.created ? 'Created file' : edit.deleted ? 'Deleted file' : 'Updated file';
			const before = edit.previewBefore ?? (edit.created ? 'Not present' : '−' + edit.removed + ' lines');
			const after = edit.previewAfter ?? (edit.deleted ? 'Not present' : '+' + edit.added + ' lines');
			const row = h('li', 'ui-alc__row');
			row.dataset.ledgerUser = u.user.id; row.dataset.ledgerPath = edit.path;
			row.dataset.ledgerReversible = String(canUndo); row.dataset.ledgerAt = String(turn.endedAt || turn.startedAt);
			if (isUndone) row.setAttribute('data-undone', '');
			row.innerHTML = '<span class="ui-alc__icon">' + fileBadge(edit.path) + '</span><button class="ui-alc__main ledger-review" data-review="' + esc(u.user.id) + '" data-path="' + esc(edit.path) + '" title="Review ' + esc(edit.path) + '"><span class="ui-alc__what"><span class="ui-alc__action">' + action + '</span><span class="ui-alc__target">' + esc(edit.path) + '</span><span class="ui-alc__strike" aria-hidden="true"></span></span><span class="ui-alc__change"><span class="ui-alc__before" title="' + esc(before) + '">' + esc(before) + '</span><span class="ui-alc__arrow" aria-label="to">→</span><span class="ui-alc__after" title="' + esc(after) + '">' + esc(after) + '</span></span></button><div class="ui-alc__end"><span class="ui-alc__time"' + (canUndo || canRedo ? ' data-hide' : '') + '>' + (isUndone ? 'Undone' : skipped ? "Can't undo" : ledgerTime(turn.endedAt) + '<span class="ui-alc__sys"> · Files</span>') + '</span>' + ((canUndo || canRedo) ? '<button type="button" class="ui-alc__act" data-undo="' + esc(u.user.id) + '" data-path="' + esc(edit.path) + '"' + (canRedo ? ' data-redo="true"' : ' data-ledger-preview') + (state.isStreaming ? ' disabled' : '') + ' aria-label="' + (canRedo ? 'Redo: ' : 'Undo: ') + esc(action + ' ' + edit.path) + '">' + undoIcon(canRedo) + '<span class="ui-alc__act-label">' + (canRedo ? 'Redo' : 'Undo') + '</span></button>' : '') + '<span class="ui-alc__flag" hidden></span></div>';
			if (!skipped) {
				const review = h('button', 'ui-alc__hunks'); review.type = 'button'; review.textContent = 'Review hunks';
				review.dataset.hunkReview = u.user.id; review.dataset.path = edit.path;
				row.querySelector('.ui-alc__end').appendChild(review);
			}
			rows.appendChild(row);
		}
		body.appendChild(h('p', 'ledger-note', 'Undo includes later edits to the same file. Commands and external actions remain.'));
		return card;
	}

	function renderEffects(u) {
		const effects = ledgerEffects(u.items), card = h('section', 'msg agent-ledger external-activity ui-alc');
		card.setAttribute('aria-label', 'External actions');
		const failed = effects.filter(m => m.approval ? approvalPhase(m.approval) === 'error' : m.tool.status === 'error').length;
		const { body } = ledgerDisclosure(card, 'external:' + u.user.id, effects.length + (effects.length === 1 ? ' external action' : ' external actions') + (failed ? ' · ' + failed + ' failed' : ''));
		const rows = h('ol', 'ui-alc__panel'); body.appendChild(rows);
		for (const m of effects) {
			const a = m.approval, tool = m.tool;
			const action = (a ? approvalPhase(a) === 'error' : tool.status === 'error') ? 'Failed' : 'Completed';
			const target = a?.tool || tool?.name || 'Connected tool';
			const row = h('li', 'ui-alc__row'); row.dataset.ledgerUser = u.user.id; row.dataset.ledgerEffect = ''; row.dataset.ledgerReversible = 'false';
			row.innerHTML = '<span class="ui-alc__icon">' + I('plug') + '</span><div class="ui-alc__main"><span class="ui-alc__what"><span class="ui-alc__action">' + action + '</span><span class="ui-alc__target" title="' + esc(target) + '">' + esc(target) + '</span></span><span class="ui-alc__change"><span class="ui-alc__detail">' + esc(a?.result?.slice(0, 300) || tool?.detail?.slice(0, 300) || tool?.summary || action) + '</span></span></div><div class="ui-alc__end"><span class="ui-alc__time">External</span><span class="ui-alc__flag" hidden></span></div>';
			rows.appendChild(row);
		}
		body.appendChild(h('p', 'ledger-note', 'File Undo does not reverse external actions. Full tool results are in the work history.'));
		return card;
	}
	function verificationLabel(receipts) {
		const reports = [...new Map((receipts || []).filter(r => r.kind === 'verify').map(r => [r.root + '\0' + r.scope, r])).values()];
		if (!reports.length) return 'Checks not run';
		if (reports.some(r => r.stale)) return 'Checks stale';
		return reports.every(r => r.finishedAt && r.status === 'passed' && r.stages.length && r.stages.every(s => s.status === 'passed' && s.code === 0)) ? 'Checks passed when checked' : 'Checks incomplete or failed';
	}
	const { showHunkReview, openComparisons, comparisonMessage, resetReviews } = window.ChatReview.create({ I, el, esc, h, post, state, toast });
	function clearLedgerPreview() {
		for (const row of document.querySelectorAll('.ui-alc__row[data-preview], .ui-alc__row[data-chain]')) {
			row.removeAttribute('data-preview'); row.removeAttribute('data-chain');
			const flag = row.querySelector('.ui-alc__flag'); if (flag) flag.hidden = true;
		}
	}
	function previewLedger(button) {
		clearLedgerPreview();
		if (!button || button.disabled) return;
		const userId = button.dataset.undo, path = button.dataset.path;
		const from = state.messages.findIndex(m => m.id === userId);
		if (from < 0) return;
		const paths = new Set(path ? [path] : (state.messages[from].turn?.edits || []).filter(e => !e.undone && !state.messages[from].turn.undone && !(state.messages[from].turn.undoSkipped || []).includes(e.path)).map(e => e.path));
		for (const row of document.querySelectorAll('.ui-alc__row[data-ledger-user]')) {
			const index = state.messages.findIndex(m => m.id === row.dataset.ledgerUser);
			if (index < from || row.hasAttribute('data-undone')) continue;
			if (row.dataset.ledgerUser === userId && paths.has(row.dataset.ledgerPath)) { row.setAttribute('data-preview', ''); continue; }
			const sameFile = paths.has(row.dataset.ledgerPath);
			if (!sameFile && !row.hasAttribute('data-ledger-effect')) continue;
			const kind = sameFile && row.dataset.ledgerReversible === 'true' ? 'also' : 'kept';
			row.dataset.chain = kind;
			const flag = row.querySelector('.ui-alc__flag'); flag.dataset.kind = kind; flag.textContent = kind === 'also' ? 'Also undone' : "Can't undo"; flag.hidden = false;
		}
	}
	document.addEventListener('pointerover', e => { const button = e.target.closest('[data-ledger-preview]'); if (button && !button.contains(e.relatedTarget)) previewLedger(button); });
	document.addEventListener('pointerout', e => { const button = e.target.closest('[data-ledger-preview]'); if (button && !button.contains(e.relatedTarget)) clearLedgerPreview(); });
	document.addEventListener('focusin', e => { if (e.target.matches('[data-ledger-preview]')) previewLedger(e.target); });
	document.addEventListener('focusout', e => { if (e.target.matches('[data-ledger-preview]')) clearLedgerPreview(); });

	// Typewriter reveal for the welcome chip labels (port of the TypewriterButton
	// effect): characters appear one by one behind a blinking block caret. Runs once
	// per welcome render — renderMessages rebuilds the welcome DOM only on state change.
	function twClick(volume) {
		try {
			const Ctx = window.AudioContext || window.webkitAudioContext;
			if (!Ctx) return;
			const ctx = new Ctx();
			const size = Math.floor(ctx.sampleRate * 0.03);
			const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
			const data = buffer.getChannelData(0);
			for (let i = 0; i < size; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (size * 0.2));
			const noise = ctx.createBufferSource();
			noise.buffer = buffer;
			const filter = ctx.createBiquadFilter();
			filter.type = 'bandpass';
			filter.frequency.value = 1800;
			filter.Q.value = 3.0;
			const gain = ctx.createGain();
			gain.gain.setValueAtTime(volume * 0.4, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.03);
			noise.connect(filter);
			filter.connect(gain);
			gain.connect(ctx.destination);
			noise.start();
			setTimeout(() => ctx.close(), 60);
		} catch { /* audio can be blocked by the webview; the reveal stays visual */ }
	}

	function typewrite(span, text, opts) {
		const charDuration = (opts && opts.charDuration) || 75;
		const node = document.createTextNode('');
		const caret = h('span', 'tw-caret');
		caret.setAttribute('aria-hidden', 'true');
		span.textContent = '';
		span.append(node, caret);
		let index = 1;
		const tick = () => {
			node.data = text.slice(0, index);
			if (opts && opts.sound) twClick(0.25);
			if (index < text.length) {
				index++;
				setTimeout(tick, charDuration);
			} else caret.remove();
		};
		setTimeout(tick, 60 + ((opts && opts.delay) || 0));
	}

	function typewriteChips(root) {
		if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		// The welcome box reaches the DOM only after emptyState() returns, so measure
		// and start one frame later — offsetWidth is 0 while detached.
		requestAnimationFrame(() => {
			let delay = 0;
			for (const span of root.querySelectorAll('[data-tw]')) {
				const chip = span.closest('button');
				const text = span.getAttribute('data-tw') || '';
				if (!chip || !text) continue;
				// Reserve the full-label width up front so neighboring chips don't shift while typing.
				if (chip.offsetWidth) chip.style.minWidth = chip.offsetWidth + 'px';
				chip.setAttribute('aria-label', text);
				typewrite(span, text, { delay });
				delay += 140;
			}
		});
	}

	function revealWelcomeText(root) {
		if (!window.IntersectionObserver || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
		const pending = new Set(root.querySelectorAll('.welcome-hero > h1, .welcome-hero > p'));
		const observer = new IntersectionObserver(entries => {
			for (const entry of entries) {
				if (!entry.isIntersecting || entry.intersectionRatio < 0.3 || !pending.has(entry.target)) continue;
				entry.target.removeAttribute('data-reveal-pending');
				entry.target.setAttribute('data-reveal-shown', '');
				observer.unobserve(entry.target);
				pending.delete(entry.target);
			}
			if (!pending.size) observer.disconnect();
		}, { root: el.messages, threshold: 0.3 });
		for (const node of pending) {
			const text = node.textContent;
			const accessible = document.createElement('span');
			accessible.className = 'welcome-reveal-sr'; accessible.textContent = text;
			const visual = document.createElement('span'); visual.setAttribute('aria-hidden', 'true');
			let index = 0;
			for (const piece of text.split(/(\s+)/)) {
				if (!piece) continue;
				if (/^\s+$/.test(piece)) { visual.append(document.createTextNode(piece)); continue; }
				const word = document.createElement('span');
				word.className = 'welcome-reveal-word'; word.textContent = piece;
				word.style.setProperty('--welcome-word', index++);
				visual.append(word);
			}
			node.replaceChildren(accessible, visual);
			node.classList.add('welcome-reveal'); node.setAttribute('data-reveal-pending', '');
			observer.observe(node);
		}
		return () => { observer.disconnect(); pending.clear(); };
	}

	// The welcome card's soft light follows the cursor (CSS --mx / --my).
	let heroLight = 0;
	el.messages.addEventListener('pointermove', (e) => {
		const hero = e.target instanceof Element && e.target.closest('.welcome-hero');
		if (!hero || heroLight) return;
		heroLight = requestAnimationFrame(() => {
			heroLight = 0;
			const box = hero.getBoundingClientRect();
			hero.style.setProperty('--mx', Math.round(e.clientX - box.left) + 'px');
			hero.style.setProperty('--my', Math.round(e.clientY - box.top) + 'px');
		});
	});

	/*
	 * Welcome screen: brand, workspace, the live model connection, setup-free starts,
	 * recent work and the activity summary. It never carries a second setup checklist.
	 */
	function emptyState() {
		const configured = state.providers.some((p) => p.enabled && p.models.some((m) => m.enabled));
		const chats = state.sessions.filter((s) => s.count > 0);
		const recent = chats.filter((s) => !s.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
		const box = h('div', 'welcome');
		const model = selected().model;
		const workspace = state.workspace && state.workspace.name;
		const stats = [
			['chat', chats.length, t('savedChats')],
			['terminal', chats.reduce((n, s) => n + (s.count || 0), 0), t('prompts')],
			['code', chats.reduce((n, s) => n + (s.added || 0) + (s.removed || 0), 0), t('linesChanged')]
		];
		// Not configured: one primary zero-key action; Settings keeps the full provider catalog.
		const setupActions = configured
			? '<button class="link-btn" data-open-settings="models">' + esc(t('manageModels')) + I('chevronRight') + '</button>'
			: '<button class="welcome-setup-btn" type="button" data-open-setup>' + esc(t('startWithoutKey')) + '</button>' +
				'<button class="link-btn" type="button" data-open-setup="key">' + esc(t('useApiKey')) + I('chevronRight') + '</button>' +
				'<button class="link-btn" type="button" data-open-settings="models">' + esc(t('setupProvider')) + I('chevronRight') + '</button>';
		box.innerHTML =
			'<div class="welcome-hero"><div class="welcome-top"><span class="welcome-brand"><span class="brand-logo" aria-hidden="true"></span>zer0ne coding</span>' +
			(configured ? '<span class="welcome-status ready"><span></span>' + esc(t('readyToBuild')) + '</span>' : '') +
			'</div>' +
			'<div class="welcome-kicker">' + I('folder') + '<span>' + esc(workspace || t('yourWorkspace')) + '</span></div><h1>' + esc(t('emptyTitle')) + '</h1><p>' + esc(configured ? (state.mode === 'chat' ? t('modeChatDesc') : t('welcomeDesc')) : t('welcomeSetupDesc')) + '</p>' +
			'<div class="welcome-context"><span>' + I(model ? 'cpu' : 'sparkle') + esc(model ? model.name || model.id.split('/').pop() : t('connectFirstModel')) + '</span>' + setupActions + '</div></div>' +
			(chats.length ? '<div class="welcome-stats" aria-label="' + esc(t('savedActivity')) + '">' + stats.map(([icon, value, label]) => '<div class="welcome-stat"><span class="welcome-stat-icon">' + I(icon) + '</span><strong title="' + value.toLocaleString() + '">' + fmtTokens(value) + '</strong><span>' + esc(label) + '</span></div>').join('') + '</div>' : '') +
			// Starting points: one click fills the composer with a ready prompt (data-draft).
			'<div class="welcome-start" aria-label="Starting prompts">' + [
				['search', 'exploreProject', 'Explore this project: map the structure, list the main components, and summarize how everything fits together.'],
				['code', 'fixAnIssue', 'Find and fix an issue in this project: pick a bug, failing test or TODO, fix it, and verify the change.'],
				['branch', 'reviewChangesPrompt', 'Review the current changes: explain what changed, identify risks, and suggest the checks needed before release.']
			].map(([icon, key, draft]) => '<button class="welcome-chip" data-draft="' + esc(draft) + '">' + I(icon) + '<span class="tw-text" data-tw="' + esc(t(key)) + '">' + esc(t(key)) + '</span></button>').join('') + '</div>' +
			(recent.length ? '<section class="welcome-recent"><div class="welcome-section-head"><h2>' + esc(t('continueWorking')) + '</h2><button class="link-btn" data-open-history>' + esc(t('viewAll')) + I('chevronRight') + '</button></div>' + recent.map((s) => '<button class="welcome-recent-row" data-open-session="' + esc(s.id) + '"><span class="welcome-recent-icon">' + I(s.pinned ? 'pin' : 'chat') + '</span><span class="welcome-recent-text"><b>' + esc(s.title || t('newChat')) + '</b><small>' + esc(t(s.count === 1 ? 'onePrompt' : 'promptCount', { n: s.count })) + (s.model ? ' · ' + esc(s.model.split('/').pop()) : '') + '</small></span><time title="' + esc(fmtStamp(s.updatedAt)) + '">' + esc(relTime(s.updatedAt)) + '</time>' + I('chevronRight') + '</button>').join('') + '</section>' : '') +
			'<div class="welcome-footnote"><span>' + I('sparkle') + esc(t('welcomeTip')) + '</span><button class="link-btn" data-open-settings="usage">' + I('chart') + esc(t('usageStats')) + '</button></div>';
		typewriteChips(box);
		return box;
	}

	// ------------------------------------------------------------ live status line

	function activity() {
		const msgs = state.messages;
		const last = msgs[msgs.length - 1];
		const s = state.streaming || {};
		if (last && last.approval && last.approval.status === 'pending') return ['shield', t('waitingApproval')];
		if (last && last.question && last.question.status === 'pending') return ['info', t('waitingAnswer')];
		const running = [...msgs].reverse().find((m) => m.tool && m.tool.status === 'running');
		if (running && running === msgs[msgs.length - 1]) {
			const tl = running.tool;
			const x = basename(tl.arg) || tl.arg;
			if (tl.name === 'read_file') return ['file', t('reading', { x })];
			if (tl.name === 'grep') return ['search', t('searching', { x: tl.arg })];
			if (tl.name === 'list_files' || tl.name === 'get_diagnostics') return ['folder', t('exploring')];
			if (tl.name === 'web_search') return ['globe', t('searchingWeb')];
			if (tl.name === 'web_fetch' || tl.name.startsWith('browser_') || tl.name === 'open_url') return ['globe', t('browsing', { x: tl.arg || 'page' })];
			if (tl.name === 'task') return ['cpu', t('delegating', { x: tl.arg })];
			if (tl.name === 'code_intel' || tl.name === 'semantic_search') return ['search', t('searching', { x: tl.arg || 'symbols' })];
			if (tl.name === 'view_image') return ['image', t('reading', { x })];
			if (tl.name === 'command_output') return ['terminal', t('running', { x: tl.arg })];
			if (tl.name.startsWith('mcp__')) return ['plug', t('calling', { x: toolMeta(tl.name)[1] })];
			return ['zap', t('working')];
		}
		if (last && last.approval && approvalPhase(last.approval) === 'running') {
			return last.approval.kind === 'command' ? ['terminal', t('running', { x: (last.approval.command || '').slice(0, 40) })] : ['pencil', t('editing', { x: basename(last.approval.path || '') || last.approval.path })];
		}
		if (s.text) return ['pencil', t('writing')];
		if (s.reasoning) return ['brain', t('thinking')];
		return ['sparkle', last && last.kind === 'tool' ? t('working') : t('thinking')];
	}

	/**
	 * The transcript's live reasoning receipt is the only thinking indicator. This legacy
	 * loader remains in the DOM for old call sites but never paints again; it used to add a
	 * second Thinking pill beside the receipt.
	 */
	function paintStatusLine(node) {
		const [icon, label] = activity();
		if (!node.querySelector('.status-label')) {
			node.innerHTML = '<span class="tl" role="status" aria-live="polite"><span class="spin-glyph" aria-hidden="true"></span>' + LOADER_ICON + '<span class="tl-text status-label"></span><span class="status-time"></span></span>';
		}
		node.dataset.activity = icon;
		node.hidden = true;
		rollLabel(node.querySelector('.status-label'), label, true);
		for (const d of el.messages.querySelectorAll('.thinking.busy')) paintThinkTime(d);
		const secs = ui.streamStartedAt ? Math.floor((Date.now() - ui.streamStartedAt) / 1000) : 0;
		const time = secs >= 2 ? fmtDuration(secs * 1000) : '';
		const timeEl = node.querySelector('.status-time');
		if (timeEl.textContent !== time) timeEl.textContent = time;
	}

	let statusTimer;
	function tickStatus() {
		clearInterval(statusTimer);
		renderStatusTask();
		if (!state.isStreaming) return;
		statusTimer = setInterval(() => {
			const s = el.messages.querySelector('.status-line');
			if (s) paintStatusLine(s);
			paintPlanClock();
			renderStatusTask();
		}, 1000);
	}

	// ------------------------------------------------------------ transcript render

	const nodes = new Map();
	let streamEl = null;
	let statusEl = null;
	let welcomeSig = '';
	function unitExpansion(u) {
		if (u.kind === 'edits') return String(ui.expanded.has('files:' + u.user.id));
		if (u.kind === 'effects') return String(ui.expanded.has('external:' + u.user.id));
		const ids = [u.id, ...(u.steps || u.items || []).flatMap(m => [m.id, 'g:' + m.id, 'all:' + m.id]), ...(u.m ? ['all:' + u.m.id] : [])];
		return ids.filter(id => ui.expanded.has(id)).join(',');
	}
	let welcomeRevealSession;
	let stopWelcomeReveal = () => {};

	function renderMessages() {
		rememberReadingPosition();
		syncQuestionPopup();
		const container = el.messages;
		if (!state.messages.length && !state.isStreaming) {
			nodes.clear();
			streamEl = statusEl = null;
			// The welcome is a dashboard, not the end of a transcript: stop following the
			// bottom and drop any reading anchor from the conversation that was here before.
			ui.stick = false;
			readingAnchor = null;
			const sig = JSON.stringify([state.currentSessionId, state.sessions, state.providers, state.selection, state.workspace, state.mode, ui.engine, window.I18N.current]);
			if (sig !== welcomeSig || !container.querySelector('.welcome')) {
				const first = !container.querySelector('.welcome');
				stopWelcomeReveal();
				const box = emptyState();
				if (first) box.classList.add('welcome-enter');
				container.replaceChildren(box);
				if (first || welcomeRevealSession !== state.currentSessionId) stopWelcomeReveal = revealWelcomeText(box);
				welcomeRevealSession = state.currentSessionId;
				// A fresh chat starts at the top of the welcome, even after a scrolled conversation.
				container.scrollTop = 0;
				welcomeSig = sig;
			}
			// The welcome is a dashboard: it always opens at its top, whatever the previous
			// conversation's scroll position or a late focus call did.
			container.scrollTop = 0;
			renderPromptNav();
			return;
		}
		stopWelcomeReveal();
		// Preserve collapse as well as expansion when the live block becomes a saved message.
		const liveText = ui.liveReasoning.trim();
		if (liveText && streamEl?.querySelector('.thinking') && state.messages.some((m) => m.reasoning === liveText)) ui.carryThink.set(liveText, streamEl.querySelector('.thinking').classList.contains('open'));
		const units = buildUnits();
		let lastText;
		for (let i = units.length - 1; i >= 0; i--) {
			const u = units[i];
			if (u.kind === 'msg' && u.m.role === 'user') break;
			if (u.kind === 'msg' && (isText(u.m) || u.m.isError)) {
				lastText = u.id;
				break;
			}
		}
		const wanted = [];
		const agentUnits = [];
		const live = new Set();
		for (const u of units) {
			live.add(u.id);
			// The agent tree repaints in place on every update, so its cards keep their animations.
			if (u.kind === 'agents') {
				let entry = nodes.get(u.id);
				if (!entry) {
					entry = { el: h('div', 'msg agt'), sig: '' };
					nodes.set(u.id, entry);
				}
				wanted.push(entry.el);
				agentUnits.push([entry.el, u]);
				continue;
			}
			const isLast = u.id === lastText;
			const payload =
				u.kind === 'group' ? u.items : u.kind === 'worked' ? [u.user.turn, u.steps] : ['edits', 'effects'].includes(u.kind) ? [u.user.turn, u.items, state.undoable.includes(u.user.id), (state.redoable || []).includes(u.user.id)] : u.kind === 'switch' ? [u.from, u.to] : u.kind === 'branch' ? u.from : u.m.question ? [u.m, questionUi.submitted.has(u.m.question.id)] : u.m;
			const sig = u.kind + (u.kind === 'msg' && u.m.role === 'user' ? (restorable(u.m.id) ? '|R' : '') : '') + JSON.stringify(payload) + (isLast ? '|L' : '') + (u.final ? '|F' + JSON.stringify((u.turn && u.turn.usage) || 0) : '') + (state.isStreaming ? '|S' : '') + unitExpansion(u) + '|' + state.settings.showReasoning + '|' + window.I18N.current + (u.kind === 'msg' ? '|T' + ((msgImages.get(u.m.id) || []).length) + (u.m.reasoning ? '|search:' + JSON.stringify(thinkingSearches(u.m)) : '') : '');
			let entry = nodes.get(u.id);
			if (!entry || entry.sig !== sig) {
				const node =
					u.kind === 'group' ? renderGroup(u)
					: u.kind === 'worked' ? renderWorked(u)
					: u.kind === 'edits' ? renderEdits(u)
					: u.kind === 'effects' ? renderEffects(u)
					: u.kind === 'branch' ? h('div', 'msg divider branch-divider', '<button class="branch-link" data-open-session="' + esc(u.from.id) + '" title="' + esc(t('openSourceChat', { x: u.from.title })) + '">' + I('branch') + '<span>' + esc(t('continuedFrom')) + '</span></button>')
					: u.kind === 'switch' ? h('div', 'msg divider model-switch', I('refresh') + '<span>' + esc(t('modelSwitched')) + ' <b>' + esc(u.from) + '</b> → <b>' + esc(u.to) + '</b></span>')
					: renderMessage(u.m, { last: isLast, final: u.final, turn: u.turn, toolSteps: u.toolSteps });
				if (u.kind === 'msg') { node.dataset.messageId = u.m.id; node.id = 'msg-' + u.m.id; }
				entry = { el: node, sig };
				nodes.set(u.id, entry);
			}
			wanted.push(entry.el);
		}
		for (const id of nodes.keys()) if (!live.has(id)) nodes.delete(id);
		if (state.isStreaming) {
			streamEl = streamEl || h('div', 'msg assistant streaming');
			paintStream();
			wanted.push(streamEl);
			statusEl = statusEl || h('div', 'status-line');
			paintStatusLine(statusEl);
			wanted.push(statusEl);
		} else {
			streamEl = statusEl = null;
		}
		for (let i = 0; i < wanted.length; i++) {
			if (container.children[i] !== wanted[i]) container.insertBefore(wanted[i], container.children[i] || null);
		}
		while (container.children.length > wanted.length) container.lastElementChild.remove();
		// Painted once in the document, where the tree can measure itself for its links.
		for (const [box, u] of agentUnits) paintAgents(box, u);
		restoreReadingPosition();
		renderPromptNav();
		void renderMermaid(container);
	}

	// ------------------------------------------------------------ mermaid diagrams

	let mermaidLoad = null;
	let mermaidSeq = 0;
	const mermaidCache = new Map();

	function loadMermaid() {
		if (window.mermaid) return Promise.resolve(window.mermaid);
		if (!mermaidLoad) {
			mermaidLoad = new Promise((resolve, reject) => {
				const s = document.createElement('script');
				s.src = MERMAID_SRC;
				if (NONCE) s.nonce = NONCE;
				s.onload = () => {
					const light = document.body.classList.contains('is-light');
					// Same font as .mermaid-measure (our stylesheet), so text is measured and drawn alike.
					window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: light ? 'default' : 'dark', htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: 'Segoe UI, system-ui, -apple-system, sans-serif', themeVariables: { fontFamily: 'Segoe UI, system-ui, -apple-system, sans-serif', fontSize: '14px' } });
					resolve(window.mermaid);
				};
				s.onerror = () => reject(new Error('Could not load the diagram renderer.'));
				document.head.appendChild(s);
			});
		}
		return mermaidLoad;
	}

	/** Replace ```mermaid blocks in finished messages with a rendered diagram (as an image: the webview CSP forbids inline styles). */
	async function renderMermaid(root) {
		for (const block of root.querySelectorAll('.mermaid-block:not([data-done])')) {
			if (block.closest('.streaming')) continue;
			block.dataset.done = '1';
			const src = block.dataset.src || '';
			try {
				let url = mermaidCache.get(src);
				if (!url) {
					const mermaid = await loadMermaid();
					let measure = document.querySelector('.mermaid-measure');
					if (!measure) {
						measure = h('div', 'mermaid-measure');
						document.body.appendChild(measure);
					}
					const out = await mermaid.render('zm-' + ++mermaidSeq, src, measure);
					url = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(out.svg)));
					mermaidCache.set(src, url);
				}
				const code = block.querySelector('.code-block');
				const fig = h('div', 'mermaid-figure');
				const img = document.createElement('img');
				img.alt = 'Diagram';
				img.src = url;
				img.dataset.zoom = url;
				img.dataset.caption = 'Diagram';
				img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', 'Open diagram in image viewer');
				const bar = h('div', 'mermaid-bar', '<span>' + I('chart') + ' Diagram</span><button class="code-btn" data-toggle-source>Source</button>');
				fig.append(bar, img);
				if (code) code.classList.add('hidden');
				block.insertBefore(fig, block.firstChild);
			} catch (e) {
				block.insertAdjacentHTML('afterbegin', '<div class="mermaid-error">' + I('alert') + ' Diagram could not be rendered: ' + esc(String((e && e.message) || e).split('\n')[0].slice(0, 160)) + '</div>');
			}
		}
	}

	function paintStream() {
		if (!streamEl) return;
		const s = state.streaming || { text: '', reasoning: '' };
		const showTrace = state.settings.showReasoning !== false;
		const turnStart = state.messages.findLastIndex((m) => m.role === 'user');
		const turnMessages = state.messages.slice(turnStart + 1);
		const turnHasReasoning = turnMessages.some((m) => m.reasoning);
		const toolsActive = turnMessages.some((m) => m.kind === 'tool' && (m.tool?.status === 'running' || m.approval?.status === 'pending' || m.approval?.status === 'running' || m.approval?.execution === 'running'));
		// Waiting for the model: a receipt-shaped header, unless a saved reasoning trace or a
		// running tool already gives the turn its live indicator.
		const placeholder = !s.text && !turnHasReasoning && !toolsActive && (!s.reasoning || !showTrace);
		let think = streamEl.querySelector('.thinking');
		if (s.reasoning && showTrace) {
			if (!think) {
				think = thinkingBlock('live', ui.thinkOpen.get('live') ?? false);
				think.classList.add('live');
				streamEl.prepend(think);
			}
			if (!ui.thinkStartedAt) ui.thinkStartedAt = Date.now();
			if (s.text && !ui.thinkMs) ui.thinkMs = Date.now() - ui.thinkStartedAt;
			paintThinking(think, s.reasoning, !s.text, ui.thinkMs || undefined);
		} else if (placeholder) {
			if (!think) {
				think = thinkingBlock('live', false);
				think.classList.add('live');
				streamEl.prepend(think);
			}
			if (!ui.thinkStartedAt) ui.thinkStartedAt = Date.now();
			paintThinking(think, '', true, undefined);
		} else if (think) {
			ui.carryThink.set(ui.liveReasoning.trim(), think.classList.contains('open'));
			think.remove();
		}
		ui.liveReasoning = s.reasoning;
		let md = streamEl.querySelector('.md');
		if (s.text) {
			if (!md) {
				md = h('div', 'md');
				streamEl.appendChild(md);
			}
			md.classList.add('session-text');
			MD.paint(md, s.text, { streaming: true, animate: motionOk() });
			placeCaret(md, performance.now());
		} else if (md) md.remove();
		streamEl.classList.toggle('hidden', !s.text && !placeholder && !(s.reasoning && showTrace));
		if (statusEl) paintStatusLine(statusEl);
		if (ui.stick) scrollToBottom();
	}

	/** The pulsing accent caret at the end of a streaming answer, kept in phase across repaints. */
	function placeCaret(md, now) {
		// The Terminal theme draws its own block cursor after the last line.
		if (document.body.dataset.theme === 'terminal') return;
		const caret = h('span', 'ans-caret');
		caret.setAttribute('aria-hidden', 'true');
		caret.style.animationDelay = -(now % 1050) + 'ms';
		const code = md.querySelector('.code-block[data-open="1"] pre code');
		if (code) { code.appendChild(caret); return; }
		const table = md.lastElementChild;
		const cell = table?.classList.contains('table-wrap') ? [...table.querySelectorAll('th, td')].at(-1) : null;
		if (cell) { cell.appendChild(caret); return; }
		let host = md;
		while (host.lastElementChild && /^(UL|OL|LI|P|BLOCKQUOTE|H[1-6])$/.test(host.lastElementChild.tagName)) host = host.lastElementChild;
		if (host !== md && /^(P|LI|H[1-6])$/.test(host.tagName)) host.appendChild(caret);
		else md.appendChild(h('p', 'ans-caret-line')).appendChild(caret);
	}

	let streamTimer;
	function scheduleStreamPaint() {
		if (streamTimer) return;
		streamTimer = setTimeout(() => {
			streamTimer = undefined;
			paintStream();
		}, 40);
	}

	// ------------------------------------------------------------ progress card (todos)

	const PROGRESS_HOME = el.progress.parentElement;

	/*
	 * The checklist in the Agent Plan style: numbered markers that turn into a ray spinner
	 * on the step being worked on and a drawn check once done, an accent rail filling down
	 * the finished steps, each step's time, and a footer with the plan's state and clock.
	 * Step times are what this window saw: a step starts when it becomes the current one.
	 */
	const plan = { turn: '', start: 0, doneAt: 0, steps: new Map() };
	const planSecs = (ms) => {
		const s = Math.max(0, ms) / 1000;
		if (s < 10) return s.toFixed(1) + 's';
		if (s < 60) return Math.round(s) + 's';
		const r = Math.round(s);
		return Math.floor(r / 60) + 'm ' + String(r % 60).padStart(2, '0') + 's';
	};
	const planTotal = (ms) => {
		const s = Math.max(1, Math.round(ms / 1000));
		return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
	};

	/** The live clocks: the current step's time and the plan's elapsed time. */
	function paintPlanClock() {
		const now = Date.now();
		const step = el.progress.querySelector('.plc-step[data-step="active"] .plc-time');
		const rec = step && plan.steps.get(step.dataset.key);
		if (rec && rec.start) step.textContent = planSecs(now - rec.start);
		const elapsed = el.progress.querySelector('.plc-elapsed');
		if (elapsed && plan.start) elapsed.textContent = planTotal(now - plan.start);
	}

	function renderProgress() {
		if (state.settings.showTodos === false) {
			ui.progressInfo = null;
			el.progress.classList.add('hidden');
			paintStatusPanel();
			return;
		}
		// Latest checklist in the current turn (or the last turn when idle).
		const msgs = state.messages;
		let lastUser = -1;
		for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i].kind) { lastUser = i; break; }
		const todo = [...msgs.slice(lastUser + 1)].reverse().find((m) => m.todos && m.todos.length);
		if (!todo) {
			ui.progressInfo = null;
			el.progress.classList.add('hidden');
			paintStatusPanel();
			return;
		}
		const done = todo.todos.filter((x) => x.done).length;
		const total = todo.todos.length;
		ui.progressInfo = { done, total };
		const turnId = lastUser >= 0 ? msgs[lastUser].id : '';
		if (plan.turn !== turnId) {
			plan.turn = turnId;
			plan.start = Date.now();
			plan.doneAt = 0;
			plan.steps = new Map();
		}
		// Display modes (ZCode "Status panel display mode"): a section of the status
		// panel (expanded, or folded to one line), docked in the chat above the
		// composer, or hidden (then a small chip under the chat box brings it back).
		const mode = ui.progressMode;
		const inline = mode === 'inline';
		const docked = mode === 'floating' || mode === 'pill';
		gitEnsure();
		const want = inline ? $('composer') : docked ? $('sp-progress') : PROGRESS_HOME;
		if (el.progress.parentElement !== want) want.insertBefore(el.progress, inline ? want.firstChild : null);
		el.progress.classList.toggle('hidden', mode === 'hidden');
		// In the status panel the checklist is a section: open by default, folded from its header.
		const pill = docked ? gitUi.fold.has('progress') : mode === 'pill';
		el.progress.classList.toggle('min', pill);
		el.progress.classList.toggle('inline', inline);
		el.progress.classList.toggle('docked', docked);
		paintStatusPanel();
		const complete = done === total;
		el.progress.classList.toggle('complete', complete);
		el.progress.classList.toggle('working', !complete && !!state.isStreaming);
		// The step being worked on: the first open item (or the last one when all are done).
		const curIdx = complete ? total - 1 : todo.todos.findIndex((x) => !x.done);
		const curText = todo.todos[curIdx] ? todo.todos[curIdx].text : '';
		ui.progressInfo.current = complete ? '' : curText;
		// Progress ring: circumference of r=7 is ~44; the dash shows the done share.
		const ring = '<svg class="pg-ring" viewBox="0 0 18 18" aria-hidden="true"><circle class="pg-ring-bg" cx="9" cy="9" r="7"/><circle class="pg-ring-fg" cx="9" cy="9" r="7" stroke-dasharray="' + ((done / total) * 44).toFixed(1) + ' 44"/></svg>';
		const status = complete ? t('pgDone') : state.isStreaming ? '' : t('pgPaused');
		// Each step's state, and when it started and finished, as this window saw it.
		const now = Date.now();
		const live = !!state.isStreaming;
		const states = todo.todos.map((x, i) => (x.done ? 'done' : i === curIdx && live ? 'active' : 'pending'));
		states.forEach((st, i) => {
			const rec = plan.steps.get(todo.todos[i].text) || {};
			if (st === 'active' && !rec.start) rec.start = now;
			if (st === 'done' && rec.start && rec.dur === undefined) rec.dur = now - rec.start;
			rec.changed = rec.state !== undefined && rec.state !== st;
			rec.state = st;
			plan.steps.set(todo.todos[i].text, rec);
		});
		if (complete && !plan.doneAt) plan.doneAt = now;
		if (!complete) plan.doneAt = 0;
		const phase = complete ? 'done' : live ? 'running' : 'paused';
		// Rebuild only when something visible changed, so markers and checks animate once.
		const sig = JSON.stringify([todo.todos, states, pill, docked, inline, phase, mode, window.I18N.current]);
		if (el.progress.dataset.sig === sig) {
			paintPlanClock();
			return;
		}
		el.progress.dataset.sig = sig;
		el.progress.setAttribute('role', pill ? 'button' : 'region');
		el.progress.setAttribute('tabindex', pill ? '0' : '-1');
		el.progress.setAttribute('aria-expanded', String(!pill));
		el.progress.title = pill ? t('pgExpand') : '';
		el.progress.innerHTML =
			'<div class="pg-head">' + (complete ? '<span class="pg-ok">' + I('check') + '</span>' : ring) +
			'<span class="pg-title">' + esc(t('progress')) + '</span><span class="pg-count">' + done + '/' + total + '</span>' +
			(pill ? '<span class="pg-now" title="' + esc(curText) + '">' + esc(status || curText) + '</span>' : '<span class="grow"></span>') +
			(pill ? '' : '<button class="pg-btn pg-mode" title="' + esc(t('pgDisplay')) + '" aria-label="' + esc(t('pgDisplay')) + '">' + I('more') + '</button>') +
			'<button class="pg-btn pg-toggle" title="' + esc(pill ? t('pgExpand') : t('pgCollapse')) + '" aria-label="' + esc(pill ? t('pgExpand') : t('pgCollapse')) + '">' + I('chevronDown') + '</button></div>' +
			(pill ? '' : planList(todo.todos, states) + planFoot(phase, curIdx, done, total));
		paintPlanClock();
		const toggle = (e) => {
			e.stopPropagation();
			if (docked) {
				if (gitUi.fold.has('progress')) gitUi.fold.delete('progress');
				else gitUi.fold.add('progress');
				renderProgress();
				return;
			}
			setProgressMode(pill ? ui.progressLast || 'floating' : 'pill');
		};
		el.progress.querySelector('.pg-toggle').addEventListener('click', toggle);
		if (pill) {
			el.progress.onclick = toggle;
			el.progress.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(e));
			return;
		}
		el.progress.onclick = null;
		el.progress.onkeydown = null;
		el.progress.querySelector('.pg-mode').addEventListener('click', (e) => {
			e.stopPropagation();
			const menu = popMenu(e.currentTarget, []);
			menu.appendChild(h('div', 'menu-label', esc(t('pgDisplay'))));
			for (const [id, icon, key] of [['floating', 'layers', 'pgFloating'], ['pill', 'minimize', 'pgPill'], ['inline', 'list', 'pgInline'], ['hidden', 'eyeOff', 'pgHidden']]) {
				menu.appendChild(item(icon, t(key), { checked: mode === id, onClick: () => (menu.remove(), setProgressMode(id)) }));
			}
		});
	}
	function planList(todos, states) {
		return '<ol class="plc-list" aria-label="' + esc(t('progress')) + '">' + todos.map((x, i) => {
			const st = states[i];
			const rec = plan.steps.get(x.text) || {};
			const marker = st === 'active'
				? '<svg class="plc-spinner" viewBox="0 0 16 16">' + RAYS + '</svg>'
				: st === 'done' ? '<svg class="plc-mark" viewBox="0 0 16 16"><path d="M4.2 8.4 6.8 11l5-5.6" pathLength="1"/></svg>'
				: '<span class="plc-num">' + (i + 1) + '</span>';
			const time = st === 'active' ? '<span class="plc-time" data-key="' + esc(x.text) + '"></span>' : st === 'done' && rec.dur !== undefined ? '<span class="plc-time">' + planSecs(rec.dur) + '</span>' : '';
			return '<li class="plc-step' + (rec.changed ? ' changed' : '') + '" data-step="' + st + '"' + (st === 'active' ? ' aria-current="step"' : '') + '>' +
				'<span class="plc-marker" aria-hidden="true">' + marker + '</span><span class="plc-name">' + esc(x.text) + '</span><span class="plc-aside">' + time + '</span>' +
				(i < todos.length - 1 ? '<span class="plc-rail" aria-hidden="true"></span>' : '') + '</li>';
		}).join('') + '</ol>';
	}

	function planFoot(phase, curIdx, done, total) {
		const label = phase === 'done' ? 'Done in ' + planTotal((plan.doneAt || Date.now()) - plan.start) : phase === 'running' ? 'Running · ' + (curIdx + 1) + ' of ' + total : t('pgPaused') + ' · ' + done + ' of ' + total;
		const icon = phase === 'running'
			? '<svg class="plc-spinner" viewBox="0 0 16 16">' + RAYS + '</svg>'
			: '<svg class="plc-badge" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/>' + (phase === 'done' ? '<path d="M5.2 8.2 7.1 10l3.7-4" pathLength="1"/>' : '<path d="M6.3 5.3v5.4M9.7 5.3v5.4"/>') + '</svg>';
		return '<div class="plc-foot" data-phase="' + phase + '"><span class="plc-status"><span class="plc-status-icon" aria-hidden="true">' + icon + '</span>' +
			'<span class="plc-status-label' + (phase === 'running' ? ' tk-shine' : '') + '" data-text="' + esc(label) + '">' + esc(label) + '</span></span>' +
			(phase === 'running' ? '<span class="plc-elapsed" aria-hidden="true"></span>' : '') + '</div>';
	}

	function setProgressMode(mode) {
		if (mode !== 'pill' && mode !== 'hidden') ui.progressLast = mode;
		ui.progressMode = mode;
		saveUi();
		renderProgress();
		renderWsRow();
	}

	// ------------------------------------------------------------ composer

	function autosize() {
		el.input.style.height = 'auto';
		el.input.style.height = Math.min(el.input.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
	}

	function ctxRingSvg(pct, size) {
		const r = size / 2 - 2;
		const c = 2 * Math.PI * r;
		return '<svg viewBox="0 0 ' + size + ' ' + size + '" class="ctx-ring"><circle class="track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="2"/><circle class="val" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke-width="2" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - Math.max(pct, 0))).toFixed(2) + '"/></svg>';
	}

	const { renderStats } = window.ChatStats.create({ $, B, I, closeMenus, ctxRingSvg, esc, fmtCacheRate, fmtDuration, fmtK, fmtTokens, h, state, ui });

	/**
	 * Under the chat box (Antigravity / Codex): where the agent works — Local (or
	 * SSH / WSL / container), the open folder, the git branch — and, when the
	 * progress panel is hidden, a chip that brings it back.
	 */
	const WHERE = { local: ['laptop', 'workLocal'], 'ssh-remote': ['server', 'SSH'], wsl: ['terminal', 'WSL'], 'dev-container': ['cube', 'Dev container'], 'attached-container': ['cube', 'Container'], codespaces: ['cloud', 'Codespaces'], tunnel: ['globe', 'Tunnel'] };
	function renderWsRow() {
		const box = $('ws-row');
		if (!box) return;
		const ws = state.workspace;
		const where = (ws && ws.where) || 'local';
		const w = WHERE[where] || ['server', where];
		const label = w[1] === 'workLocal' ? t('workLocal') : w[1];
		const pg = ui.progressInfo && ui.progressMode === 'hidden' ? ui.progressInfo : null;
		const html =
			'<button class="ws-chip" data-ws="where" title="' + esc(t('workLocalDesc')) + '">' + I(ws && ws.worktree ? 'branch' : w[0]) + '<span>' + esc(ws && ws.worktree ? 'Worktree' : label) + '</span>' + I('chevronDown') + '</button>' +
			(ws
				? '<button class="ws-chip" data-ws="folder" title="' + esc(ws.path || ws.name) + '">' + I('folder') + '<span>' + esc(ws.name) + '</span>' + I('chevronDown') + '</button>' +
					(ws.branch ? '<button class="ws-chip ws-branch" data-ws="branch" title="Switch branch">' + I('branch') + '<span>' + esc(ws.branch) + '</span></button>' : '')
				: '<button class="ws-chip muted" data-ws="open">' + I('folderPlus') + '<span>' + esc(t('openFolder')) + '</span></button>') +
			'<span class="grow"></span>' +
			(pg ? '<button class="ws-chip ws-progress" data-ws="progress" title="' + esc(t('progress')) + '">' + I('todo') + '<span>' + pg.done + '/' + pg.total + '</span></button>' : '');
		if (box.dataset.sig !== html) {
			box.dataset.sig = html;
			box.innerHTML = html;
		}
	}
	function wsMenu(kind, anchor) {
		const ws = state.workspace || {};
		const menu = popMenu(anchor, []);
		menu.classList.add('ws-menu');
		const add = (x) => menu.appendChild(x);
		if (kind === 'where') {
			add(item('laptop', t('workLocal'), { desc: t('workLocalDesc'), checked: !ws.worktree, onClick: () => menu.remove() }));
			add(item('branch', t('workWorktree'), { desc: t('workWorktreeDesc'), checked: !!ws.worktree, disabled: state.isRemote, onClick: () => (menu.remove(), post({ type: 'worktree', action: 'create' })) }));
			add(item('cloud', t('workCloud'), { desc: t('workCloudDesc'), disabled: state.isRemote, onClick: () => (menu.remove(), openSettings('cloud')) }));
		} else {
			add(h('div', 'menu-label ws-path', esc(ws.path || ws.name || '')));
			add(item('copy', 'Copy path', { onClick: () => (menu.remove(), copyText(ws.path || ws.name || '')) }));
			add(item('folder', 'Reveal in file manager', { disabled: state.isRemote, onClick: () => (menu.remove(), post({ type: 'workspaceAction', action: 'reveal' })) }));
			add(item('folderPlus', t('openFolder'), { disabled: state.isRemote, onClick: () => (menu.remove(), post({ type: 'workspaceAction', action: 'open' })) }));
		}
		// Open upward: the row sits at the bottom of the view.
		const r = anchor.getBoundingClientRect();
		menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.left)) + 'px';
		menu.style.top = Math.max(6, r.top - menu.offsetHeight - 6) + 'px';
	}
	$('ws-row').addEventListener('click', (e) => {
		const b = e.target instanceof Element ? e.target.closest('[data-ws]') : null;
		if (!b) return;
		e.stopPropagation();
		const k = b.dataset.ws;
		if (k === 'where' || k === 'folder') wsMenu(k, b);
		else if (k === 'open') post({ type: 'workspaceAction', action: 'open' });
		else if (k === 'progress') setProgressMode(ui.progressLast || 'floating');
		else if (k === 'branch') {
			ui.branchAnchor = b;
			post({ type: 'gitBranches' });
		}
	});
	/** Branch picker under the chat box: filter, switch, or create-and-switch. */
	function branchMenu(anchor, branches, current) {
		const menu = popMenu(anchor, []);
		menu.classList.add('ws-menu', 'branch-menu');
		const search = h('div', 'menu-search', I('search'));
		const input = document.createElement('input');
		input.placeholder = 'Search or create a branch';
		search.appendChild(input);
		const list = h('div', 'branch-list');
		const paint = () => {
			const q = input.value.trim();
			const hits = branches.filter((b) => !q || b.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
			list.replaceChildren(
				...hits.map((b) => item('branch', b, { checked: b === current, onClick: () => (menu.remove(), b !== current && post({ type: 'gitCheckout', name: b })) })),
				...(q && !branches.includes(q) ? [item('plus', 'Create “' + q + '”', { onClick: () => (menu.remove(), post({ type: 'gitCheckout', name: q, create: true })) })] : [])
			);
			const r = anchor.getBoundingClientRect();
			menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.left)) + 'px';
			menu.style.top = Math.max(6, r.top - menu.offsetHeight - 6) + 'px';
		};
		input.addEventListener('input', paint);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') menu.remove();
			else if (e.key === 'Enter') {
				const first = list.querySelector('.menu-item');
				if (first) first.click();
			}
		});
		menu.append(search, list);
		paint();
		input.focus();
	}

	let dragQueueId = null, queueEditor = null;

	/** Inline edit of a queued card: swap the text for an input until Enter or blur. */
	function startQueueEdit(row, q) {
		if (row.querySelector('.q-edit')) return;
		const span = row.querySelector('.grow');
		if (!span) return;
		const input = h('input', 'q-edit');
		input.value = q.text;
		queueEditor = { id: q.id, sessionId: state.currentSessionId, row, input };
		const editorSession = state.currentSessionId;
		post({ type: 'beginQueueEdit', id: q.id, sessionId: state.currentSessionId });
		span.replaceWith(input);
		input.focus();
		input.select();
		let done = false;
		const commit = () => {
			if (done) return;
			done = true;
			const v = input.value.trim();
			const sessionId = editorSession;
			queueEditor = null;
			post({ type: 'editQueued', id: q.id, text: v || q.text, sessionId });
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commit();
			} else if (e.key === 'Escape') {
				done = true;
				queueEditor = null;
				post({ type: 'editQueued', id: q.id, text: q.text, sessionId: editorSession });
				renderComposer();
			}
		});
		input.addEventListener('blur', commit);
	}

	function renderComposer() {
		renderStats();
		renderWsRow();
		el.attachments.classList.toggle('hidden', !state.attachments.length);
		// Forget thumbnails of attachments that are gone; ask for the images we do not have yet.
		const live = new Set(state.attachments.map((a) => a.id));
		for (const id of [...thumbs.keys()]) {
			if (!live.has(id)) {
				thumbs.delete(id);
				askedThumbs.delete(id);
			}
		}
		el.attachments.replaceChildren(
			...state.attachments.map((a) => {
				const url = a.kind === 'image' ? thumbs.get(a.id) : undefined;
				const chip = h('span', 'chip' + (a.kind === 'image' ? ' thumb-chip' + (url ? '' : ' no-thumb') : ''), (url ? '<img class="attach-thumb" alt="" src="' + esc(url) + '">' : I(a.kind === 'image' ? 'image' : 'file')) + '<span class="name" title="' + esc(a.name) + '">' + esc(a.name) + '</span>');
				const x = h('button', 'x', I('close'));
				x.addEventListener('click', () => post({ type: 'removeAttachment', id: a.id }));
				chip.appendChild(x);
				return chip;
			})
		);
		const missing = state.attachments.filter((a) => a.kind === 'image' && !thumbs.has(a.id) && !askedThumbs.has(a.id));
		if (missing.length) {
			for (const a of missing) askedThumbs.add(a.id);
			post({ type: 'readAttachmentImages' });
		}
		el.queue.classList.toggle('hidden', !state.queue.length);
		const queueRows = state.queue.map((q, i) => {
				if (queueEditor?.id === q.id && queueEditor.sessionId === state.currentSessionId) return queueEditor.row;
				// A steer-style card: drag handle, one-line text, ↑ Steer, edit, remove.
				const row = h('div', 'queue-item');
				row.draggable = true;
				row.dataset.qid = q.id;
				const handle = h('span', 'q-handle', '⠿');
				const text = h('span', 'grow', (state.queue.length > 1 ? '<span class="tag">' + esc(i === 0 ? t('next') : t('queued')) + '</span>' : '') + esc(q.text));
				text.title = q.text;
				const steer = h('button', 'q-steer', I('arrowUp') + '<span>' + t('steer') + '</span>');
				steer.title = t('steerHint');
				steer.addEventListener('click', (e) => {
					e.stopPropagation();
					post({ type: 'steerQueued', id: q.id });
				});
				const edit = h('button', 'icon-btn q-act', I('pencil'));
				edit.title = t('edit');
				edit.addEventListener('click', () => startQueueEdit(row, q));
				const x = h('button', 'icon-btn q-act q-del', I('close'));
				x.title = t('delete');
				x.addEventListener('click', () => post({ type: 'removeQueued', id: q.id }));
				row.append(handle, text, steer, edit, x);
				// Drag to reorder the waiting list.
				row.addEventListener('dragstart', (e) => {
					dragQueueId = q.id;
					row.classList.add('dragging');
					e.dataTransfer.effectAllowed = 'move';
					try { e.dataTransfer.setData('text/plain', q.id); } catch { /* older engines */ }
				});
				row.addEventListener('dragend', () => {
					row.classList.remove('dragging');
					const ids = [...el.queue.children].map((r) => r.dataset && r.dataset.qid).filter(Boolean);
					if (ids.length === state.queue.length && ids.some((id, k) => state.queue[k] && state.queue[k].id !== id)) {
						post({ type: 'reorderQueued', ids });
					}
				});
				row.addEventListener('dragover', (e) => {
					e.preventDefault();
					if (q.id === dragQueueId) return;
					const dragged = [...el.queue.children].find((r) => r.dataset && r.dataset.qid === dragQueueId);
					if (!dragged) return;
					const rect = row.getBoundingClientRect();
					e.clientY < rect.y + rect.height / 2 ? el.queue.insertBefore(dragged, row) : el.queue.insertBefore(dragged, row.nextSibling);
				});
				return row;
			});
		for (let i = 0; i < queueRows.length; i++) if (el.queue.children[i] !== queueRows[i]) el.queue.insertBefore(queueRows[i], el.queue.children[i] || null);
		while (el.queue.children.length > queueRows.length) el.queue.lastElementChild.remove();
		if (queueEditor && (queueEditor.sessionId !== state.currentSessionId || !state.queue.some(q => q.id === queueEditor.id))) {
			const text = queueEditor.input.value;
			const previous = queueEditor;
			queueEditor = null;
			if (previous.sessionId !== state.currentSessionId) post({ type: 'editQueued', id: previous.id, sessionId: previous.sessionId, text });
			else if (text.trim()) { el.input.value = [el.input.value, text].filter(Boolean).join('\n\n'); saveUi(); }
		}
		const modeInfo = { chat: ['chat', t('modeChat')], agent: ['agent', t('modeAgent')], full: ['shield', t('modeFull')] }[state.mode] || ['agent', t('modeAgent')];
		el.modeIcon.innerHTML = I(modeInfo[0]);
		el.modeLabel.textContent = modeInfo[1];
		el.mode.classList.toggle('mode-full', state.mode === 'full');
		el.plan.classList.toggle('hidden', !ui.plan);
		const { provider, model } = selected();
		el.modelLabel.textContent = ui.media ? ui.media.name : model ? provider.name + ' · ' + (model.name || model.id) : provider ? provider.name + ' · no model' : 'Select model';
		el.model.title = ui.media ? 'Local ' + ui.media.kind + ' model — a prompt opens the ' + (ui.media.kind === 'voice' ? 'speech' : 'generation') + ' window' : model ? provider.name + ' / ' + model.id : '';
		el.model.classList.toggle('media-model', !!ui.media);
		const control = provider?.reasoningControls?.[model?.id];
		const showEffort = !!(provider && model && control?.levels.length && !ui.media);
		el.effort.parentElement.classList.toggle('hidden', !showEffort);
		const savedEffort = (provider && model && provider.efforts[model.id]) || 'max';
		const effort = savedEffort === 'max' || (control && control.levels.includes(savedEffort)) ? savedEffort : 'max';
		el.effortLabel.textContent = effortLabel(effort);
		el.effort.title = 'Reasoning: ' + effortLabel(effort) + (effort === 'max' ? ' — model default' : '');
		el.effort.setAttribute('aria-label', el.effort.title);
		const effortVariant = control && control.choices && control.choices.find(choice => choice.model && choice.effort === effort);
		if (effortVariant) { el.modelLabel.textContent = provider.name + ' · ' + (effortVariant.name || effortVariant.value); el.model.title = provider.name + ' / ' + effortVariant.value + ' · reasoning selection'; }
		// context icon
		const ctx = state.context;
		const pct = ctx && ctx.window ? Math.min(1, ctx.used / ctx.window) : 0;
		el.ctx.innerHTML = ctxRingSvg(pct, 18);
		el.ctx.classList.toggle('warn', pct > 0.8);
		el.ctx.title = ctx && ctx.window ? t('contextWindow') + ': ' + fmtTokens(ctx.used) + ' / ' + fmtTokens(ctx.window) + ' (' + Math.round(pct * 100) + '%)' : t('contextWindow');
		// mic
		const speechApi = window.SpeechRecognition || window.webkitSpeechRecognition;
		const micAvailable = state.isRemote ? !!speechApi && window.isSecureContext : state.mic.supported !== false;
		const micListening = state.mic.state === 'listening' || !!browserRec;
		el.mic.classList.toggle('hidden', !micAvailable);
		el.mic.classList.toggle('listening', micListening);
		el.mic.classList.toggle('transcribing', state.mic.state === 'transcribing');
		// While listening the glyph becomes a tiny live equalizer — the audio-on cue.
		const micFace = micListening ? 'eq' : 'mic';
		if (el.mic.dataset.face !== micFace) {
			el.mic.dataset.face = micFace;
			el.mic.innerHTML = micFace === 'eq' ? '<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' : I('mic');
		}
		el.mic.title = micSilence.warned
			? 'Not hearing anything — the microphone captures no sound. Check the default input in Settings > System > Sound, and a mic mute key (e.g. Fn+F10).'
			: state.mic.state === 'transcribing'
				? 'Transcribing…'
				: micListening
					? (state.mic.engine === 'whisper' ? 'Recording — click to stop and transcribe' : 'Listening — click to stop')
					: 'Dictate (microphone)';
		renderSendControl();
	}

	function renderSendControl() {
		// send / stop
		const busy = state.isStreaming;
		const hasText = !!el.input.value.trim() || state.attachments.length;
		el.send.classList.toggle('stop', busy && !hasText);
		el.send.innerHTML = I(busy && !hasText ? 'stop' : 'arrowUp');
		el.send.title = busy ? (hasText ? t('queued') : t('stop') + ' (Esc)') : t('send') + ' (Enter)';
		el.send.disabled = !busy && !hasText;
		el.app.classList.toggle('working', busy);
		el.input.placeholder = busy
			? t('placeholderBusy', { mode: (state.settings.followUp === 'queue' ? t('queued') : t('next')).toLowerCase() })
			: ui.plan ? t('placeholderPlan') : t('placeholder');
	}

	/** One-shot light bar along the input card's bottom edge (on Enter). */
	function sweep() {
		if (state.settings.glow === 'off') return;
		window.ComposerBeam?.flash(el.inputCard, 'sweep');
		el.inputCard.classList.remove('sweep');
		void el.inputCard.offsetWidth;
		el.inputCard.classList.add('sweep');
		el.inputCard.classList.remove('touch');
		clearTimeout(sweepTimer);
		sweepTimer = setTimeout(() => el.inputCard.classList.remove('sweep'), 2600);
	}
	let sweepTimer;
	/** A short Prism turn when you click into the chat box (not while it's already running). */
	let touchTimer = 0;
	function touch() {
		if (state.settings.glow === 'off' || touchTimer || el.inputCard.classList.contains('sweep')) return;
		window.ComposerBeam?.flash(el.inputCard, 'touch');
		el.inputCard.classList.add('touch');
		touchTimer = setTimeout(() => {
			el.inputCard.classList.remove('touch');
			touchTimer = 0;
		}, 2600);
	}
	el.inputCard.addEventListener('pointerdown', touch);
	el.input.addEventListener('focus', touch);
	// The beam owns the glow when its canvas is available; the CSS ring stays as the fallback.
	if (window.ComposerBeam) window.ComposerBeam.attach(el.inputCard, { reach: 20 });

	function send(textOverride) {
		if (ui.composing) return;
		const text = (textOverride !== undefined ? textOverride : el.input.value).trim();
		if (!text && !state.attachments.length) return;
		if (/^\/\S*/.test(text) && runSlash(text)) {
			if (textOverride === undefined) {
				el.input.value = '';
				autosize();
			}
			return;
		}
		if (ui.media && text) {
			openMediaPopup(text);
			if (textOverride === undefined) {
				el.input.value = '';
				autosize();
				saveUi();
			}
			renderComposer();
			return;
		}
		sweep();
		post({ type: 'send', text, plan: ui.plan });
		if (textOverride === undefined) {
			el.input.value = '';
			autosize();
			saveUi();
		}
		closePopup();
		followLatest();
		renderComposer();
	}

	/** Put text in the composer without sending (welcome chips and the first-run setup). */
	function startTask(text) {
		el.input.value = text;
		autosize(); renderComposer(); saveUi(); el.input.focus();
	}

	/** Put a prepared first task in the composer and run it as the next turn. */
	function sendTask(text) {
		startTask(text);
		send();
	}

	// ------------------------------------------------------------ slash commands

	const COMMANDS = [
		{ cmd: '/plan', desc: 'Toggle Plan mode (read-only planning) — /plan <text> plans just that message', run: () => togglePlan() },
		{ cmd: '/workflow', desc: 'Main agent, parallel workers and a reviewer, each on its own model', run: () => openWorkflow() },
		{ cmd: '/compare', desc: 'Compare 2–4 models on the same task in isolated worktrees', run: () => openComparisons() },
		{ cmd: '/compact', desc: 'Summarize older messages to free context', run: () => post({ type: 'compact' }) },
		{ cmd: '/new', desc: 'Start a new chat', run: () => post({ type: 'newSession' }) },
		{ cmd: '/cloud', desc: 'Run a task in the cloud (GitHub Actions) — /cloud <task>', cloud: true },
		{ cmd: '/review', desc: 'Review current git changes', prompt: 'Review my current uncommitted changes (use git_status and git_diff). List issues by severity with file:line and concrete fixes. Do not edit files.' },
		{ cmd: '/fix', desc: 'Fix the errors VS Code reports', prompt: 'Run get_diagnostics, then fix the errors in the workspace one by one and verify they are gone.' },
		{ cmd: '/test', desc: 'Write & run tests for recent work', prompt: 'Write or update tests for the code I am working on (check git_diff and the project files), then run them and fix failures.' },
		{ cmd: '/explain', desc: 'Explain the project structure', prompt: 'Explain how this project is structured: entry points, main modules, data flow, and where to start reading.' },
		{ cmd: '/commit', desc: 'Draft a commit message', prompt: 'Look at git_status and git_diff and write a concise Conventional Commit message (subject + body). Do not commit.' },
		{ cmd: '/docs', desc: 'Update README / docs', prompt: 'Update the README and inline docs to match the current code. Keep the existing tone.' },
		{ cmd: '/browser', desc: 'Test a web app in the browser', template: 'Open http://localhost:3000 in the browser and test ' },
		{ cmd: '/remember', desc: 'Save a fact for future chats', template: 'Remember that ' },
		{ cmd: '/skills', desc: 'List available skills and the ones pinned in this chat', run: () => { sweep(); post({ type: 'send', text: '/skills' }); } },
		{ cmd: '/pin-skill', desc: 'Keep a skill active in this chat — /pin-skill <name>', template: '/pin-skill ', engine: true },
		{ cmd: '/unpin-skill', desc: 'Stop keeping a skill active — /unpin-skill <name>', template: '/unpin-skill ', engine: true },
		// The engine handles /goal itself (every surface): typed with an objective it is sent as is.
		{ cmd: '/goal', desc: 'Work until it is done — /goal <done looks like> [--check "npm test"] [--rounds 10], /goal status, /goal off', template: '/goal ', engine: true }
	].filter(command => !(B.desktop || B.desktopHost) || !['/cloud','/fix'].includes(command.cmd));

	function togglePlan(force) {
		ui.plan = force === undefined ? !ui.plan : force;
		saveUi();
		renderComposer();
		toast(ui.plan ? t('planMode') + ' — ' + t('planModeDesc') : t('planMode') + ' off', 'ok');
	}

	function runSlash(text) {
		const [word, ...rest] = text.split(/\s+/);
		const c = COMMANDS.find((x) => x.cmd === word.toLowerCase());
		if (!c) return false;
		const extra = rest.join(' ').trim();
		if (c.engine && extra) return false;
		if (c.cloud) {
			if (!extra) {
				openSettings('cloud');
				return true;
			}
			sweep();
			post({ type: 'cloudStart', task: extra, openPr: true });
			toast('Sent to the cloud — follow it in Settings → Cloud tasks.', '');
			return true;
		}
		if (c.run) {
			if (c.cmd === '/plan' && extra) {
				// "/plan <text>" plans that one message: the composer mode is left as it is and
				// nothing is persisted, so the next message (and the next session) is not stuck
				// in plan mode. The persistent toggle stays on "/plan" without text and on the
				// mode control.
				sweep();
				post({ type: 'send', text: extra, plan: true });
				toast(t('planMode') + ' — ' + t('planModeDesc') + ' · this message only', 'ok');
			} else c.run();
		} else if (c.prompt) {
			sweep();
			post({ type: 'send', text: c.prompt + (extra ? '\n\n' + extra : ''), plan: ui.plan });
		} else if (c.template) {
			el.input.value = c.template + extra;
			autosize();
			el.input.focus();
			renderComposer();
		}
		return true;
	}

	// ------------------------------------------------------------ menus

	const MENUS = { plus: ['plus', 'plusMenu'], mode: ['mode', 'modeMenu'], model: ['model', 'modelMenu'], effort: ['effort', 'effortMenu'], ctx: ['ctx', 'ctxMenu'] };

	function toggleMenu(name) {
		ui.open = ui.open === name ? null : name;
		if (ui.open === 'model') {
			ui.modelQuery = '';
			ui.modelProvider = null;
		}
		renderMenus();
		if (ui.open === 'model') {
			const search = el.modelMenu.querySelector('input');
			if (search) search.focus();
		}
	}

	function bindMenuNavigation(menu, trigger) {
		menu.addEventListener('keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
			if (event.key === 'Escape') {
				event.preventDefault(); event.stopPropagation(); closeMenus(); trigger.focus(); return;
			}
			if (event.target.matches('input[type="range"]')) return;
			const typing = event.target.matches('input, textarea');
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || typing && ['Home', 'End'].includes(event.key)) return;
			const items = [...menu.querySelectorAll('button:not(:disabled)')].filter(node => !node.closest('.hidden, [hidden]'));
			if (!items.length) return;
			const index = items.indexOf(document.activeElement);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? items.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
			event.preventDefault(); items[next].focus(); items[next].scrollIntoView({ block: 'nearest' });
		});
	}

	function closeMenus() {
		if (ui.open) {
			ui.open = null;
			renderMenus();
		}
		document.querySelectorAll('.row-menu, .input-menu').forEach((m) => m.remove());
	}

	function renderMenus() {
		for (const [name, [btn, menu]] of Object.entries(MENUS)) {
			const open = ui.open === name;
			el[menu].classList.toggle('hidden', !open);
			el[btn].classList.toggle('open', open);
			el[btn].setAttribute('aria-expanded', String(open));
		}
		if (ui.open === 'plus') renderPlusMenu();
		if (ui.open === 'mode') renderModeMenu();
		if (ui.open === 'model') renderModelMenu();
		if (ui.open === 'effort') renderEffortMenu();
		if (ui.open === 'ctx') renderContextMenu();
	}

	function item(iconName, label, opts) {
		opts = opts || {};
		const b = h('button', 'menu-item' + (opts.cls ? ' ' + opts.cls : ''));
		b.innerHTML =
			(iconName ? I(iconName) : '') +
			'<span class="grow">' + esc(label) + (opts.desc ? '<span class="desc">' + esc(opts.desc) + '</span>' : '') + '</span>' +
			(opts.badges || '') +
			(opts.pill !== undefined ? '<span class="state-pill' + (opts.pillOn ? ' on' : '') + '">' + esc(opts.pill) + '</span>' : '') +
			(opts.checked ? '<span class="check">' + I('check') + '</span>' : '') +
			(opts.arrow ? '<span class="menu-arrow" style="opacity:0.4;display:inline-flex;align-items:center;margin-left:4px">' + I('chevronRight') + '</span>' : '');
		if (opts.title) b.title = opts.title;
		if (opts.disabled) b.disabled = true;
		b.addEventListener('mousedown', (e) => opts.keepFocus && e.preventDefault());
		b.addEventListener('click', (e) => {
			e.stopPropagation();
			if (opts.onClick) opts.onClick();
		});
		return b;
	}

	const setSetting = (patch) => post({ type: 'updateSettings', patch });

	/** Phone attachments: a photo or a small text file straight from the phone. */
	function pickPhoneFiles() {
		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.accept = 'image/png,image/jpeg,image/gif,image/webp,text/*,.md,.markdown,.json,.log,.csv,.txt,.ts,.tsx,.js,.jsx,.py,.go,.rs,.css,.html,.yml,.yaml,.toml';
		input.addEventListener('change', () => {
			for (const file of [...(input.files || [])]) readPhoneFile(file);
		});
		input.click();
	}
	function readPhoneFile(file) {
		const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
		if (image && file.size > 4_600_000) return toast('"' + file.name + '" is larger than 5 MB.', 'error');
		if (!image && file.type && !/^text\//.test(file.type) && !/\.(md|markdown|json|log|csv|txt|ts|tsx|js|jsx|py|go|rs|css|html|yml|yaml|toml)$/i.test(file.name)) return toast('Images and text files only.', 'error');
		if (!image && file.size > 400_000) return toast('Text attachments are limited to 400 KB.', 'error');
		const reader = new FileReader();
		reader.onerror = () => toast('Could not read ' + file.name + '.', 'error');
		reader.onload = () => {
			const result = String(reader.result ?? '');
			if (image) post({ type: 'addImage', name: file.name, mime: file.type, base64: result.split(',')[1] || '' });
			else post({ type: 'addText', name: file.name, content: result });
		};
		if (image) reader.readAsDataURL(file);
		else reader.readAsText(file);
	}

	// Phone extras (Mobile Remote): keep the screen awake during a run, buzz when the
	// agent needs you, and offer a real notification while the page is in the background.
	const PHONE_ALERTS_KEY = 'zc.phoneAlerts';
	function alertsState() {
		try { return typeof Notification !== 'undefined' && Notification.permission === 'granted' && localStorage.getItem(PHONE_ALERTS_KEY) === '1'; }
		catch { return false; }
	}
	async function togglePhoneAlerts() {
		if (typeof Notification === 'undefined') return toast('This browser cannot show notifications.', 'error');
		try {
			if (alertsState()) {
				localStorage.setItem(PHONE_ALERTS_KEY, '0');
				return toast('Phone alerts off.');
			}
			if (Notification.permission === 'denied') return toast('Notifications are blocked for this site in the browser settings.', 'error');
			const permission = await Notification.requestPermission();
			if (permission !== 'granted') return toast('Alerts were not allowed.', 'error');
			localStorage.setItem(PHONE_ALERTS_KEY, '1');
			toast('Phone alerts on — approvals, questions and finished turns.');
		} catch { toast('Alerts are not available here.', 'error'); }
	}
	function phoneNotify(title, body, tag) {
		if (!state.isRemote || !alertsState() || !document.hidden) return;
		try { new Notification(title, { body, tag, icon: '/icon.png', badge: '/icon.png' }); } catch { /* iOS tabs have no notifications */ }
	}
	function buzz(pattern) {
		if (!state.isRemote || typeof navigator.vibrate !== 'function') return;
		try { navigator.vibrate(pattern); } catch { /* unsupported */ }
	}
	let wakeLock = null;
	async function keepAwake(on) {
		if (!state.isRemote || !('wakeLock' in navigator)) return;
		try {
			if (on && !wakeLock && !document.hidden) {
				wakeLock = await navigator.wakeLock.request('screen');
				wakeLock.addEventListener?.('release', () => { wakeLock = null; });
			} else if ((!on || document.hidden) && wakeLock) {
				await wakeLock.release();
				wakeLock = null;
			}
		} catch { wakeLock = null; }
	}
	document.addEventListener('visibilitychange', () => { if (!document.hidden && state.isStreaming) void keepAwake(true); });

	// Published previews (publish_artifact) on a phone: an eye in the top bar opens the
	// same sandboxed document the desktop shows in its panel, in a full-screen frame.
	function renderArtifactButton() {
		if (!state.isRemote && !document.body?.classList?.contains('remote')) return;
		const list = Array.isArray(state.artifacts) ? state.artifacts : [];
		let button = document.getElementById('btn-artifact');
		if (!list.length) {
			button?.remove();
			return;
		}
		const latest = list[0];
		const title = String(latest.title || 'Preview').slice(0, 60);
		if (!button) {
			button = h('button', 'icon-btn topbar-artifact');
			button.id = 'btn-artifact';
			button.type = 'button';
			button.dataset.icon = 'eye';
			button.innerHTML = I('eye');
			button.addEventListener('click', openArtifactPreview);
			const more = document.getElementById('btn-more');
			more?.parentElement?.insertBefore(button, more);
		}
		button.dataset.id = latest.id;
		button.dataset.title = latest.title || 'Preview';
		button.setAttribute('aria-label', 'Preview ' + title);
		button.title = 'Preview · ' + title;
	}
	function openArtifactPreview() {
		const button = document.getElementById('btn-artifact');
		if (!button) return;
		let layer = document.getElementById('artifact-preview');
		if (!layer) {
			layer = h('section', 'artifact-preview hidden');
			layer.id = 'artifact-preview';
			layer.setAttribute('aria-label', 'Artifact preview');
			layer.innerHTML = '<header><b></b><button class="icon-btn" type="button" data-artifact-close aria-label="Close preview">' + I('close') + '</button></header><iframe title="Artifact preview" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>';
			layer.querySelector('[data-artifact-close]').addEventListener('click', closeArtifactPreview);
			document.body.appendChild(layer);
		}
		layer.querySelector('b').textContent = button.dataset.title || 'Preview';
		layer.querySelector('iframe').src = '/api/artifacts/' + encodeURIComponent(button.dataset.id);
		layer.classList.remove('hidden');
		document.body.classList.add('preview-open');
	}
	function closeArtifactPreview() {
		const layer = document.getElementById('artifact-preview');
		const frame = layer?.querySelector('iframe');
		if (frame) frame.removeAttribute('src');
		layer?.classList.add('hidden');
		document.body.classList.remove('preview-open');
	}
	document.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && document.body.classList.contains('preview-open')) {
			event.preventDefault();
			event.stopPropagation();
			closeArtifactPreview();
		}
	}, true);

	function renderPlusMenu() {
		const s = state.settings;
		const mcpReady = state.mcp.filter((x) => x.status && x.status.state === 'ready').length;
		const skillsOn = state.skills.filter((x) => x.enabled).length;
		el.plusMenu.replaceChildren(
			h('div', 'menu-label', esc(t('add'))),
			item('paperclip', state.isRemote ? 'Photo or file' : t('filesImages'), { onClick: () => (closeMenus(), state.isRemote ? pickPhoneFiles() : post({ type: 'pickAttachment' })) }),
			item('folder', 'Folder…', { disabled: state.isRemote, onClick: () => (closeMenus(), post({ type: 'pickFolder' })) }),
			item('at', t('mentionFile'), { disabled: !state.hasWorkspace, onClick: () => (closeMenus(), insertTrigger('@')) }),
			item('list', t('planMode'), { desc: t('planModeDesc'), pill: ui.plan ? 'On' : 'Off', pillOn: ui.plan, onClick: () => (closeMenus(), togglePlan()) }),
			item('command', t('commands'), { desc: '/review /fix /test /commit /compact…', onClick: () => (closeMenus(), insertTrigger('/')) }),
			item('agent', 'Workflow', { desc: 'Main agent, workers and reviewers', pill: state.subagentWorkflow?.enabled ? 'On' : 'Off', pillOn: state.subagentWorkflow?.enabled === true, onClick: () => (closeMenus(), openWorkflow()) }),
			item('agent', 'Compare models', { desc: 'Same task, separate worktrees', onClick: () => (closeMenus(), openComparisons()) }),
			item('book', t('useSkill'), { desc: skillsOn ? skillsOn + ' · $' : '', disabled: !s.skills, onClick: () => (closeMenus(), skillsOn ? insertTrigger('$') : openSettings('skills')) }),
			h('div', 'menu-sep'),
			h('div', 'menu-label', esc(t('plugins'))),
			item('globe', t('browserAgent'), { pill: s.browserAgent ? 'On' : 'Off', pillOn: s.browserAgent, onClick: () => setSetting({ browserAgent: !s.browserAgent }) }),
			item('search', t('webSearch'), { pill: s.browserTools ? 'On' : 'Off', pillOn: s.browserTools, onClick: () => setSetting({ browserTools: !s.browserTools }) }),
			item('server', t('mcpServers'), { pill: s.mcp ? String(mcpReady) : 'Off', pillOn: s.mcp && mcpReady > 0, onClick: () => openSettings('mcp') }),
			item('zap', t('tokenSaver'), { pill: s.tokenSaver ? 'On' : 'Off', pillOn: s.tokenSaver, onClick: () => setSetting({ tokenSaver: !s.tokenSaver }) }),
			item('phone', t('mobileRemote'), { pill: s.remoteEnabled ? 'On' : 'Off', pillOn: s.remoteEnabled, disabled: state.isRemote, onClick: () => openSettings('remote') }),
			item('puzzle', t('allFeatures'), { onClick: () => openSettings('features') }),
			h('div', 'menu-foot', '<span><b>@</b> files</span><span><b>/</b> commands</span><span><b>$</b> skills</span><span><b>Ctrl+V</b> image</span>')
		);
	}

	function renderModeMenu() {
		const modes = [['chat', 'chat', t('modeChat'), t('modeChatDesc')], ['agent', 'agent', t('modeAgent'), t('modeAgentDesc')], ['full', 'shield', t('modeFull'), t('modeFullDesc')]];
		const list = [h('div', 'menu-label', esc(t('approveQ')))];
		for (const [id, icon, label, desc] of modes) list.push(item(icon, label, { desc, cls: 'mode-menu-item' + (state.mode === id ? ' selected' : ''), checked: state.mode === id, onClick: () => (closeMenus(), post({ type: 'setMode', mode: id })) }));
		list.push(h('div', 'menu-sep'), item('list', t('planMode'), { desc: t('planModeDesc'), pill: ui.plan ? 'On' : 'Off', pillOn: ui.plan, onClick: () => (closeMenus(), togglePlan()) }));
		if (state.mode === 'agent') {
			const s = state.settings;
			list.push(h('div', 'menu-sep'), h('div', 'menu-label', esc(t('autoApprove'))));
			for (const [key, icon, label] of [['autoApproveEdits', 'pencil', t('autoEdits')], ['autoApproveCommands', 'terminal', t('autoCommands')], ['autoApproveMcp', 'plug', t('autoMcp')]]) {
				list.push(item(icon, label, { pill: s[key] ? 'On' : 'Off', pillOn: !!s[key], keepFocus: true, onClick: () => setSetting({ [key]: !s[key] }) }));
			}
		}
		el.modeMenu.replaceChildren(...list);
	}

	function renderModelMenu() {
		const q = ui.modelQuery.toLowerCase();
		const groups = state.providers
			.filter((p) => p.enabled)
			.map((p) => ({ p, models: p.models.filter((m) => m.enabled && (!q || (m.id + ' ' + (m.name || '')).toLowerCase().includes(q) || p.name.toLowerCase().includes(q))) }))
			.filter((g) => g.models.length);
		const total = state.providers.reduce((n, p) => n + (p.enabled ? p.models.filter((m) => m.enabled).length : 0), 0);
		const children = [];
		if (total > 7) {
			const box = h('div', 'menu-search', I('search'));
			const input = document.createElement('input');
			input.placeholder = t('searchModels');
			input.value = ui.modelQuery;
			input.addEventListener('input', () => {
				ui.modelQuery = input.value;
				renderModelMenu();
				const again = el.modelMenu.querySelector('input');
				again.focus();
				again.setSelectionRange(again.value.length, again.value.length);
			});
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					const first = el.modelMenu.querySelector('.model-item');
					if (first) first.click();
				} else if (e.key === 'Escape') closeMenus();
			});
			input.addEventListener('click', (e) => e.stopPropagation());
			box.appendChild(input);
			children.push(box);
		}
		/** zer0ne Engine: which models are in memory — the chat slot, or the helper slot beside it. */
		const engineBadge = (p, m) => {
			const e = ui.engine;
			if (!e || p.preset !== 'zer0ne-engine') return '';
			if (e.running && e.model === m.id) return '<span class="badge ok" title="Loaded in zer0ne Engine">loaded</span>';
			if (e.helper && e.helper.running && e.helper.model === m.id) return '<span class="badge ok" title="Loaded as the helper model, beside the chat model (port ' + e.helper.port + ')">helper · loaded</span>';
			return '';
		};
		const modelRow = (p, m) => {
			const isSel = p.id === state.selection.providerId && m.id === state.selection.model;
			const favorite = (state.modelPreferences?.favorites || []).some(s => s.providerId === p.id && s.model === m.id);
			const row = h('div', 'mm-model-row');
			const choice = item(null, m.name || m.id, {
				cls: 'model-item' + (isSel ? ' selected' : ''),
				desc: p.name,
				title: m.name ? m.id + (m.note ? ' — ' + m.note : '') : undefined,
				badges: engineBadge(p, m) + (m.contextWindow ? '<span class="badge mono">' + fmtTokens(m.contextWindow) + '</span>' : '') + (m.vision ? '<span class="badge">' + I('eye') + '</span>' : ''),
				checked: isSel,
				disabled: state.isStreaming,
				onClick: () => {
					if (ui.media) post({ type: 'mediaPick', id: null });
					ui.media = null;
					saveUi();
					closeMenus();
					post({ type: 'selectModel', providerId: p.id, model: m.id, sessionId: state.currentSessionId });
				}
			});
			choice.dataset.provider = p.id;
			choice.dataset.model = m.id;
			// Model Picker style: a small tile with the provider's initial leads each model.
			choice.insertAdjacentHTML('afterbegin', '<span class="mdp-glyph" aria-hidden="true">' + esc((p.name.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase()) + '</span>');
			const star = h('button', 'mm-favorite' + (favorite ? ' selected' : ''), favorite ? '★' : '☆');
			star.type = 'button';
			star.title = (favorite ? 'Remove from favorites: ' : 'Add to favorites: ') + p.name + ' / ' + (m.name || m.id);
			star.setAttribute('aria-label', star.title);
			star.setAttribute('aria-pressed', String(favorite));
			star.addEventListener('click', e => {
				e.stopPropagation();
				post({ type: 'setModelFavorite', providerId: p.id, model: m.id, favorite: !favorite });
			});
			row.append(choice, star);
			return row;
		};
		const pane = h('div', 'mm-pane');
		if (!groups.length) pane.appendChild(h('div', 'menu-label', total ? '—' : esc(t('setupProvider'))));
		const inside = !q && groups.find((g) => g.p.id === ui.modelProvider);
		const single = !q && groups.length === 1;
		if (!q && (!inside || single)) {
			const seen = new Set();
			const rows = [];
			for (const s of state.modelPreferences?.favorites || []) {
				const group = groups.find(g => g.p.id === s.providerId);
				const model = group?.models.find(m => m.id === s.model);
				const identity = JSON.stringify([s.providerId, s.model]);
				if (!model || seen.has(identity)) continue;
				seen.add(identity);
				rows.push(modelRow(group.p, model));
			}
			if (rows.length) pane.append(h('div', 'menu-label', 'Favorites'), ...rows, h('div', 'menu-sep'));
		}
		if (q || single) {
			// Searching (or a single provider): every match, grouped by provider.
			for (const { p, models } of groups) {
				if (groups.length > 1 || q) pane.appendChild(h('div', 'menu-label', esc(p.name)));
				models.forEach((m) => pane.appendChild(modelRow(p, m)));
			}
		} else if (inside) {
			// Slide 2: one provider's models.
			if (ui.modelAnim === 'in') pane.classList.add('mm-anim-in');
			const back = h('button', 'mm-back', I('back') + '<span class="grow">' + esc(inside.p.name) + '</span><span class="mm-count">' + inside.models.length + '</span>');
			back.addEventListener('click', (e) => {
				e.stopPropagation();
				ui.modelProvider = null;
				ui.modelAnim = 'back';
				renderModelMenu();
			});
			pane.appendChild(back);
			const list = h('div', 'mm-list');
			inside.models.forEach((m) => list.appendChild(modelRow(inside.p, m)));
			pane.appendChild(list);
		} else {
			// Slide 1: providers, each with its model count and the current pick.
			if (ui.modelAnim === 'back') pane.classList.add('mm-anim-back');
			pane.appendChild(h('div', 'menu-label', esc(t('allModels'))));
			for (const { p, models } of groups) {
				const current = p.id === state.selection.providerId ? models.find((m) => m.id === state.selection.model) : null;
				const row = h(
					'button',
					'menu-item mm-provider' + (current ? ' selected' : ''),
					'<span class="mm-avatar" aria-hidden="true">' + esc((p.name.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase()) + '</span>' +
						'<span class="grow"><span class="mm-name">' + esc(p.name) + '</span>' + (current ? '<span class="desc">' + esc(current.name || current.id) + '</span>' : '') + '</span>' +
						'<span class="mm-count">' + models.length + '</span>' + I('chevronRight')
				);
				row.title = p.name + ' — ' + models.length + ' ' + t('models');
				row.addEventListener('click', (e) => {
					e.stopPropagation();
					ui.modelProvider = p.id;
					ui.modelAnim = 'in';
					renderModelMenu();
				});
				pane.appendChild(row);
			}
		}
		ui.modelAnim = null;
		children.push(pane);
		children.push(h('div', 'menu-sep'));
		children.push(item('gear', t('modelSettings') + '…', { onClick: () => openSettings('models') }), item('chart', t('usageStats') + '…', { onClick: () => openSettings('usage') }));
		el.modelMenu.replaceChildren(...children);
		el.modelMenu.classList.add('mdp');
	}

	// ------------------------------------------------------------ local image / video / voice generation (window)

	const fmtSecs = (n) => (n < 90 ? Math.max(1, Math.round(n)) + ' s' : n < 3600 ? Math.round(n / 60) + ' min' : (n / 3600).toFixed(1) + ' h');
	/** The open generation window: prompt, options, progress, and every result made since it opened. */
	let media = null;
	const KIND = { image: ['image', 'Image', 'Describe the picture…'], video: ['film', 'Video', 'Describe the clip…'], voice: ['volume', 'Voice', 'Type what to say…'] };

	function studioModels(kind) {
		const all = ((ui.studio && ui.studio.bundles) || []).concat((ui.studio && ui.studio.voices) || []);
		return all.filter((b) => b.installed && (!kind || b.kind === kind));
	}
	function mediaBundle() {
		return ui.media && studioModels().find((b) => b.id === ui.media.id);
	}
	const round = (n, step) => Math.max(step * 4, Math.round(n / step) * step);
	/** Pixel size for a quality (the bundle's base size) and a shape — same pixel count, the model's grid. */
	function shapeSize(b, base, shape) {
		const step = b.step || 16;
		const [w, h] = base;
		const area = w * h;
		const land = w >= h ? [w, h] : [h, w];
		if (shape === 'square') return [round(Math.sqrt(area), step), round(Math.sqrt(area), step)];
		if (shape === 'portrait') return b.kind === 'video' ? [land[1], land[0]] : [round(Math.sqrt(area * 0.75), step), round(Math.sqrt(area / 0.75), step)];
		return b.kind === 'video' ? land : [round(Math.sqrt(area / 0.75), step), round(Math.sqrt(area * 0.75), step)];
	}
	/** Seconds this run should take here (the model's estimate, scaled to the chosen size / length / text). */
	function mediaEta() {
		const b = mediaBundle();
		if (!b || !b.rec) return 0;
		if (b.kind === 'voice') return Math.max(1, ((media.prompt.split(/\s+/).length / 2.6) / (media.speed || 1)) * (b.rec.rtf || 0.3) + 1);
		const base = b.rec.size || b.sizes[b.sizes.length - 1];
		const size = shapeSize(b, media.base || base, media.shape);
		const pix = (size[0] * size[1]) / (base[0] * base[1]);
		const frames = b.kind === 'video' ? Math.pow((Number(media.frames) || 33) / (b.frames || 33), 1.6) : 1;
		return b.rec.seconds * Math.pow(pix, 1.25) * frames;
	}

	function openMediaPopup(prompt) {
		closeMediaPopup();
		const b = mediaBundle();
		const base = b && b.sizes ? (b.rec && b.rec.size) || b.sizes[b.sizes.length - 1] : null;
		media = {
			prompt,
			busy: null,
			error: null,
			results: [],
			view: -1,
			base,
			shape: b && b.kind === 'video' ? 'landscape' : 'square',
			// Video: start with 1 second where a 2-second clip would take more than 5 minutes here.
			frames: b && b.rec && b.rec.seconds > 300 ? 17 : 33,
			speaker: b && b.speakers ? b.speakers[0].id : 0,
			speed: 1
		};
		const overlay = h('div', 'media-overlay');
		overlay.innerHTML = '<div class="media-pop" role="dialog" aria-modal="true" aria-label="Generate"></div>';
		overlay.addEventListener('mousedown', (e) => e.target === overlay && !media.busy && closeMediaPopup());
		document.body.appendChild(overlay);
		media.el = overlay;
		renderMediaPopup();
		generateMedia();
	}

	function closeMediaPopup() {
		if (!media) return;
		if (media.busy) post({ type: 'studioCancel' });
		for (const r of media.results) if (r.url && !r.kept) URL.revokeObjectURL(r.url);
		clearInterval(media.timer);
		media.el.remove();
		media = null;
		el.input.focus();
	}

	function generateMedia() {
		const b = mediaBundle();
		if (!media || !b || !media.prompt.trim()) return;
		media.error = null;
		media.rid = (media.rid || 0) + 1;
		media.busy = { status: 'queued', elapsed: 0, started: Date.now(), eta: mediaEta() };
		const size = b.kind === 'voice' ? undefined : shapeSize(b, media.base, media.shape);
		post({ type: 'studioGenerate', source: 'chat', rid: media.rid, id: b.id, prompt: media.prompt.trim(), size, frames: b.kind === 'video' ? Number(media.frames) || 33 : undefined, speaker: b.kind === 'voice' ? Number(media.speaker) : undefined, speed: b.kind === 'voice' ? media.speed : undefined });
		clearInterval(media.timer);
		// The bar moves on its own between host updates (they can be seconds apart).
		media.timer = setInterval(() => media && media.busy && paintProgress(), 500);
		renderMediaPopup();
	}

	function mediaStatus() {
		const busy = media.busy;
		if (!busy) return '';
		if (ui.studio && ui.media && ui.studio.loading === ui.media.id) return 'Loading the model — the first time takes a minute';
		if (busy.status === 'queued') return 'Starting';
		return ui.media && ui.media.kind === 'voice' ? 'Speaking' : 'Generating';
	}

	function paintProgress() {
		const box = media && media.el.querySelector('.media-progress');
		if (!box) return;
		const elapsed = (Date.now() - media.busy.started) / 1000;
		const eta = media.busy.eta || 0;
		const pct = eta ? Math.min(96, (elapsed / eta) * 100) : 0;
		box.querySelector('i').style.width = (eta ? pct : 30) + '%';
		box.classList.toggle('indeterminate', !eta);
		media.el.querySelector('.media-status').textContent = mediaStatus() + ' · ' + fmtSecs(elapsed) + (eta ? (elapsed < eta ? ' · about ' + fmtSecs(eta - elapsed) + ' left' : ' · almost done') : '');
	}

	function viewing() {
		return media && media.view >= 0 ? media.results[media.view] : null;
	}

	function renderMediaPopup() {
		if (!media) return;
		const b = mediaBundle();
		const kind = (ui.media && ui.media.kind) || 'image';
		const k = KIND[kind] || KIND.image;
		const box = media.el.querySelector('.media-pop');
		const busy = !!media.busy;
		// While a new version is made, the progress shows; the finished ones wait in the strip.
		const cur = busy ? null : viewing();
		const models = studioModels(kind);
		const chip = (group, value, label, on) => '<button class="media-chip' + (on ? ' on' : '') + '" data-media-set="' + group + '" data-value="' + esc(String(value)) + '">' + label + '</button>';
		let opts = '';
		if (b && kind !== 'voice') {
			const shapes = [['square', 'Square'], ['portrait', 'Portrait'], ['landscape', 'Landscape']];
			opts += '<div class="media-field"><span>Shape</span><div class="media-chips">' + shapes.map(([v, l]) => chip('shape', v, '<i class="shape-' + v + '"></i>' + l, media.shape === v)).join('') + '</div></div>';
			if (b.sizes.length > 1) {
				const names = ['Best', 'Balanced', 'Fast'].slice(3 - b.sizes.length);
				opts += '<div class="media-field"><span>Quality</span><div class="media-chips">' + b.sizes.map((z, i) => chip('base', z.join('x'), names[i] + (b.rec && b.rec.size && b.rec.size.join('x') === z.join('x') ? ' ✓' : ''), media.base && media.base.join('x') === z.join('x'))).join('') + '</div></div>';
			}
			if (kind === 'video') opts += '<div class="media-field"><span>Length</span><div class="media-chips">' + [[17, '1 s'], [33, '2 s'], [49, '3 s']].map(([f, l]) => chip('frames', f, l, Number(media.frames) === f)).join('') + '</div></div>';
		}
		if (b && kind === 'voice') {
			const groups = {};
			for (const sp of b.speakers || []) (groups[sp.name.split(' · ')[1] ? sp.name.split(' · ')[1].replace(/ (female|male)$/, '') : 'Voices'] = groups[sp.name.split(' · ')[1] ? sp.name.split(' · ')[1].replace(/ (female|male)$/, '') : 'Voices'] || []).push(sp);
			opts += '<div class="media-field"><span>Voice</span><select data-media-opt="speaker">' + Object.entries(groups).map(([g, list]) => '<optgroup label="' + esc(g) + '">' + list.map((sp) => '<option value="' + sp.id + '"' + (Number(media.speaker) === sp.id ? ' selected' : '') + '>' + esc(sp.name) + '</option>').join('') + '</optgroup>').join('') + '</select></div>';
			opts += '<div class="media-field"><span>Speed</span><div class="media-chips">' + [[0.85, 'Slow'], [1, 'Normal'], [1.2, 'Fast']].map(([v, l]) => chip('speed', v, l, Number(media.speed) === v)).join('') + '</div></div>';
		}
		const stage = cur
			? kind === 'voice'
				? '<div class="media-audio"><span class="media-wave">' + Array.from({ length: 28 }, (_, i) => '<i data-h="' + (20 + Math.round(Math.abs(Math.sin(i * 1.7 + cur.prompt.length)) * 80)) + '"></i>').join('') + '</span><audio class="media-out" controls autoplay></audio></div>'
				: kind === 'video' ? '<video class="media-out" controls loop autoplay muted playsinline></video>' : '<img class="media-out" alt="">'
			: '<div class="media-wait">' + (busy ? '<span class="media-ring">' + I(k[0]) + '</span><span class="media-status"></span><span class="media-progress"><i></i></span>' : media.error ? I('alert') + '<span class="media-err">' + esc(media.error) + '</span>' : '<span>' + esc(k[2]) + '</span>') + '</div>';
		const strip = media.results.length > 1 || (media.results.length && busy)
			? '<div class="media-strip">' + media.results.map((r, i) => '<button class="media-thumb' + (i === media.view && !busy ? ' on' : '') + '" data-media-view="' + i + '" title="' + esc(r.prompt) + '">' + (r.kind === 'image' ? '<img alt="">' : I(r.kind === 'video' ? 'film' : 'volume') + '<span>' + (i + 1) + '</span>') + '</button>').join('') + (busy ? '<span class="media-thumb wait"><span class="spinner"></span></span>' : '') + '</div>'
			: '';
		box.innerHTML =
			'<div class="media-head"><span class="media-ico">' + I(k[0]) + '</span>' +
			(models.length > 1 ? '<select class="media-model" data-media-opt="model" title="Switch model">' + models.map((m) => '<option value="' + esc(m.id) + '"' + (ui.media && m.id === ui.media.id ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('') + '</select>' : '<b class="media-title">' + esc(ui.media ? ui.media.name : '') + '</b>') +
			'<span class="media-sub">' + k[1] + ' · on this computer</span><span class="grow"></span><button class="icon-btn" data-media="close" title="Close (Esc)">' + I('close') + '</button></div>' +
			'<div class="media-stage' + (cur ? ' has-result' : '') + ' kind-' + kind + '">' + stage + '</div>' +
			strip +
			'<div class="media-compose"><textarea class="media-prompt" rows="2" spellcheck="true" aria-label="Prompt" placeholder="' + esc(k[2]) + '">' + esc(media.prompt) + '</textarea>' +
			(busy ? '<button class="btn btn-secondary media-go" data-media="cancel">' + I('stop') + 'Stop</button>' : '<button class="btn btn-primary media-go" data-media="again" title="Enter">' + I(cur ? 'refresh' : 'sparkle') + (cur ? 'New version' : kind === 'voice' ? 'Speak' : 'Generate') + '</button>') + '</div>' +
			(opts ? '<div class="media-opts">' + opts + '</div>' : '') +
			(cur
				? '<div class="media-actions"><button class="btn btn-ghost media-del" data-media="discard" title="Delete this one">' + I('trash') + 'Delete</button><button class="btn btn-secondary" data-media="save">' + I('arrowDown') + 'Save as…</button><span class="grow"></span><span class="media-meta">' + esc(cur.meta || '') + '</span><button class="btn btn-primary" data-media="approve" title="Ctrl+Enter">' + I('check') + 'Add to chat</button></div>'
				: '');
		if (cur) {
			box.querySelector('.media-out').src = cur.url;
			box.querySelectorAll('.media-wave i').forEach((w) => w.style.setProperty('--h', w.dataset.h + '%'));
		}
		media.results.forEach((r, i) => {
			const img = box.querySelector('[data-media-view="' + i + '"] img');
			if (img) img.src = r.url;
		});
		if (busy) paintProgress();
		const ta = box.querySelector('.media-prompt');
		ta.addEventListener('input', () => (media.prompt = ta.value));
		ta.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && viewing()) {
				e.preventDefault();
				approveMedia();
			} else if (e.key === 'Enter' && !e.shiftKey && !media.busy) {
				e.preventDefault();
				generateMedia();
			}
		});
		box.querySelectorAll('[data-media-opt]').forEach((sel) =>
			sel.addEventListener('change', () => {
				if (sel.dataset.mediaOpt === 'model') {
					const m = studioModels(kind).find((x) => x.id === sel.value);
					if (!m) return;
					ui.media = { id: m.id, name: m.name, kind: m.kind };
					saveUi();
					renderComposer();
					media.base = m.sizes ? (m.rec && m.rec.size) || m.sizes[m.sizes.length - 1] : null;
					media.speaker = m.speakers ? m.speakers[0].id : 0;
					renderMediaPopup();
				} else media[sel.dataset.mediaOpt] = sel.value;
			})
		);
		box.querySelectorAll('[data-media-set]').forEach((c) =>
			c.addEventListener('click', () => {
				const g = c.dataset.mediaSet;
				media[g] = g === 'base' ? c.dataset.value.split('x').map(Number) : g === 'speed' || g === 'frames' ? Number(c.dataset.value) : c.dataset.value;
				renderMediaPopup();
			})
		);
		box.querySelectorAll('[data-media-view]').forEach((t) =>
			t.addEventListener('click', () => {
				if (media.busy) return;
				media.view = Number(t.dataset.mediaView);
				renderMediaPopup();
			})
		);
		box.querySelectorAll('[data-media]').forEach((btn) =>
			btn.addEventListener('click', () => {
				const a = btn.dataset.media;
				const cur2 = viewing();
				if (a === 'close') closeMediaPopup();
				else if (a === 'cancel') {
					post({ type: 'studioCancel' });
					media.rid = (media.rid || 0) + 1; // a late answer from the stopped job is ignored
					clearInterval(media.timer);
					media.busy = null;
					renderMediaPopup();
				} else if (a === 'again') generateMedia();
				else if (a === 'approve') approveMedia();
				else if (a === 'discard' && cur2) {
					post({ type: 'studioDiscard', id: cur2.id });
					URL.revokeObjectURL(cur2.url);
					media.results.splice(media.view, 1);
					if (!media.results.length) return closeMediaPopup();
					media.view = Math.min(media.view, media.results.length - 1);
					renderMediaPopup();
				} else if (a === 'save' && cur2) {
					// Phone: the browser downloads it; VS Code / desktop: a Save dialog on the host.
					if (B.remote) {
						const link = document.createElement('a');
						link.href = cur2.url;
						link.download = cur2.name || 'result';
						link.click();
					} else post({ type: 'studioSaveAs', id: cur2.id });
				}
			})
		);
		if (!media.busy && !cur) ta.focus();
	}

	function approveMedia() {
		const cur = viewing();
		if (!cur || media.busy) return;
		post({ type: 'studioToChat', id: cur.id });
		cur.kept = true;
		closeMediaPopup();
	}

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && media && !media.busy) {
			e.stopPropagation();
			closeMediaPopup();
		}
	}, true);

	const ALL_LEVELS = ['max', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'maximum'];
	function effortLabel(level) { return level === 'max' ? 'Auto' : level === 'maximum' ? 'Maximum' : t(level); }
	function effortLevels(current, control) {
		return ALL_LEVELS.filter(level => level === 'max' || control?.levels.includes(level));
	}
	function renderEffortMenu() {
		const { provider, model } = selected();
		const control = provider?.reasoningControls?.[model?.id];
		const saved = provider?.efforts?.[model?.id] || 'max';
		const current = control?.levels.includes(saved) ? saved : 'max';
		const levels = effortLevels(current, control);
		el.effortMenu.innerHTML = '<div class="ef-heading"><div class="ef-menu-title">Reasoning</div><output class="ef-value" aria-live="polite">' + esc(effortLabel(current)) + '</output></div>' +
			(levels.length > 1 ? '<div class="ef-galaxy"><div class="ef-orbit"><div class="ef-track" aria-hidden="true"><span class="ef-stars"></span></div><span class="ef-brain" aria-hidden="true">' + I('brain') + '</span><input class="ef-slider" type="range" min="0" max="' + (levels.length - 1) + '" step="1" value="' + levels.indexOf(current) + '" aria-label="Reasoning effort" aria-valuetext="' + esc(effortLabel(current)) + '"></div></div>' : '');
		const slider = el.effortMenu.querySelector('.ef-slider');
		if (slider) {
			const preview = () => {
				const index = Number(slider.value), level = levels[index];
				el.effortMenu.querySelector('.ef-value').textContent = effortLabel(level);
				slider.setAttribute('aria-valuetext', effortLabel(level));
				el.effortMenu.querySelector('.ef-orbit').style.setProperty('--effort-position', (index / (levels.length - 1) * 100) + '%');
				el.effortMenu.querySelector('.ef-orbit').style.setProperty('--effort-fraction', String(index / (levels.length - 1)));
				el.effortMenu.querySelector('.ef-galaxy').classList.toggle('ef-deep', index >= (levels.length - 1) * .65);
			};
			preview();
			slider.addEventListener('input', preview);
			slider.addEventListener('change', () => {
				const level = levels[Number(slider.value)];
				if (provider && model && level && level !== saved) post({ type: 'setEffort', providerId: provider.id, model: model.id, effort: level });
				closeMenus(); el.effort.focus();
			});
		}
	}

	/*
	 * Context window popover (Context Window style): the used tokens counting up to their
	 * new value, a level pill, a field of cells coloured by what fills the window (hover a
	 * category to light its cells), each category's tokens, and a footer with what is left
	 * and a Compact action.
	 */
	const CW_CELLS = 144;
	function renderContextMenu() {
		const ctx = state.context;
		const menu = el.ctxMenu;
		if (!ctx || !ctx.window) {
			menu.innerHTML = '<div class="cw-card"><div class="cw-head"><span class="cw-title">' + esc(t('contextWindow')) + '</span></div><div class="cw-empty">' + esc(t('noRequests')) + '</div></div>';
			return;
		}
		const pct = Math.min(1, ctx.used / ctx.window);
		const level = pct >= 0.95 ? 'full' : pct >= 0.8 ? 'warn' : 'ok';
		const parts = ctx.parts || {};
		const rows = [['messages', t('messages')], ['systemTools', t('systemTools')], ['systemPrompt', t('systemPrompt')], ['skills', t('skills')], ['mcpTools', t('mcpTools')], ['meta', t('metaContext')]]
			.map(([k, label], i) => ({ k, label, tone: 'c' + (i + 1), tokens: Math.round(ctx.used * (parts[k] || 0) / 100) }));
		// Cells in category order, each category's share of the window; a category with any tokens gets at least one cell.
		const per = ctx.window / CW_CELLS;
		const cells = [];
		let sum = 0;
		for (const r of rows) {
			sum += r.tokens;
			const end = Math.min(CW_CELLS, Math.max(r.tokens > 0 ? cells.length + 1 : cells.length, Math.round(sum / per)));
			while (cells.length < end) cells.push(r);
		}
		const { model } = selected();
		const left = Math.max(0, ctx.window - ctx.used);
		const caption = level === 'full' ? 'Almost full · compact to keep going' : level === 'warn' ? fmtTokens(left) + ' left · compaction soon' : fmtTokens(left) + ' tokens left';
		const meta = [
			ctx.cacheRate != null ? ['Provider-reported cache usage, for requests that supplied it', t('cacheHit'), fmtCacheRate(ctx.cacheRate) + '%'] : null,
			ctx.prefixStable != null ? ['Compared serialized model-input components; cache hits are reported separately.' + (ctx.cacheBreak ? ' Last change: ' + ctx.cacheBreak : ''), 'Request prefix stable', fmtCacheRate(ctx.prefixStable) + '%'] : null,
			ctx.warm ? ['', 'Cache warmer', ctx.warm] : null,
			ctx.saver && ctx.saver.before > ctx.saver.after ? ['', t('tokenSaver'), '−' + Math.round((1 - ctx.saver.after / ctx.saver.before) * 100) + '% · ' + fmtK(ctx.saver.before - ctx.saver.after) + ' tokens'] : null
		].filter(Boolean);
		menu.innerHTML =
			'<div class="cw-card" data-level="' + level + '"><div class="cw-head"><span class="cw-title">' + esc(t('contextWindow')) + '</span>' + (model ? '<span class="cw-model">' + esc(model.name || model.id) + '</span>' : '') + '</div>' +
			'<div class="cw-figure"><span class="cw-big" aria-hidden="true">' + fmtTokens(menu._cwShown ?? ctx.used) + '</span><span class="cw-of">of ' + fmtTokens(ctx.window) + ' tokens</span><span class="cw-pill">' + Math.round(pct * 100) + '%</span></div>' +
			'<span class="cw-sr">' + esc(fmtTokens(ctx.used) + ' of ' + fmtTokens(ctx.window) + ' tokens used, ' + Math.round(pct * 100) + '%') + '</span>' +
			'<div class="cw-field" aria-hidden="true">' + Array.from({ length: CW_CELLS }, (_, i) => '<span class="cw-cell ' + (cells[i] ? cells[i].tone : 'free') + '"' + (cells[i] ? ' data-part="' + cells[i].k + '"' : '') + '></span>').join('') + '</div>' +
			'<ul class="cw-parts">' + rows.map((r) => '<li class="cw-part" data-part="' + r.k + '"><span class="cw-swatch ' + r.tone + '"></span><span class="cw-label">' + esc(r.label) + '</span><span class="cw-value">' + (r.tokens ? fmtTokens(r.tokens) : '0') + '</span></li>').join('') + '</ul>' +
			(meta.length ? '<div class="cw-meta">' + meta.map(([title, label, value]) => '<div class="cw-meta-row"' + (title ? ' title="' + esc(title) + '"' : '') + '><span>' + esc(label) + '</span><span class="mono">' + esc(value) + '</span></div>').join('') + '</div>' : '') +
			'</div><div class="cw-foot"><span class="cw-caption" data-tone="' + level + '">' + esc(caption) + (state.settings.autoCompact ? '<span class="cw-auto"> · auto at ' + (state.settings.compactMaxTokens && state.settings.compactMaxTokens < ctx.window * state.settings.compactThreshold / 100 ? fmtTokens(state.settings.compactMaxTokens) : state.settings.compactThreshold + '%') + '</span>' : '') + '</span>' +
			'<button type="button" class="cw-action" data-compact>Compact<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>';
		menu.querySelectorAll('.cw-cell').forEach((c, i) => c.style.setProperty('--i', i));
		const field = menu.querySelector('.cw-field');
		menu.querySelectorAll('.cw-part').forEach((row) => {
			row.addEventListener('mouseenter', () => {
				field.dataset.hot = row.dataset.part;
				menu.querySelectorAll('.cw-part').forEach((x) => x.toggleAttribute('data-dim', x !== row));
				field.querySelectorAll('.cw-cell').forEach((c) => c.toggleAttribute('data-on', c.dataset.part === row.dataset.part));
			});
			row.addEventListener('mouseleave', () => {
				delete field.dataset.hot;
				menu.querySelectorAll('.cw-part').forEach((x) => x.removeAttribute('data-dim'));
				field.querySelectorAll('[data-on]').forEach((c) => c.removeAttribute('data-on'));
			});
		});
		// The figure counts from what it last showed to the new total (ease-out, 640ms).
		const from = menu._cwShown ?? ctx.used;
		const big = menu.querySelector('.cw-big');
		cancelAnimationFrame(menu._cwFrame);
		if (from !== ctx.used && motionOk()) {
			const t0 = performance.now();
			const step = (now) => {
				const k = Math.min(1, (now - t0) / 640);
				const v = from + (ctx.used - from) * (1 - (1 - k) ** 4);
				big.textContent = fmtTokens(Math.round(v));
				menu._cwShown = Math.round(v);
				if (k < 1) menu._cwFrame = requestAnimationFrame(step);
			};
			menu._cwFrame = requestAnimationFrame(step);
		} else big.textContent = fmtTokens(ctx.used);
		menu._cwShown = from === ctx.used ? ctx.used : menu._cwShown;
		menu.querySelector('[data-compact]').addEventListener('click', () => (closeMenus(), post({ type: 'compact' })));
	}

	// ------------------------------------------------------------ right-click writing assistant

	let assistSeq = 0;
	const assistWaiters = new Map();
	function textAssist(action, text, context) {
		const requestId = ++assistSeq;
		post({ type: 'textAssist', action, text, context, requestId });
		return new Promise((resolve) => assistWaiters.set(requestId, resolve));
	}

	function inputMenu(e) {
		e.preventDefault();
		closeMenus();
		const ta = el.input;
		const start = ta.selectionStart;
		const end = ta.selectionEnd;
		const selectedText = ta.value.slice(start, end);
		const target = selectedText || ta.value;
		const oneWord = selectedText && /^\S{1,40}$/.test(selectedText.trim());
		const menu = h('div', 'popover menu input-menu');
		const replace = (text) => {
			if (!text) return;
			if (selectedText) ta.setRangeText(text, start, end, 'select');
			else ta.value = text;
			autosize();
			saveUi();
			renderComposer();
			ta.focus();
		};
		const run = (action, label) =>
			item(action === 'fix' ? 'check' : action === 'improve' ? 'sparkle' : action === 'shorter' ? 'list' : 'globe', label, {
				keepFocus: true,
				disabled: !target.trim(),
				onClick: async () => {
					menu.replaceChildren(h('div', 'menu-label', '<span class="spinner"></span> ' + esc(label) + '…'));
					const res = await textAssist(action, target, selectedText ? ta.value : '');
					menu.remove();
					if (res.error) toast(res.error, 'error');
					else replace(res.text);
				}
			});
		const items = [
			item('command', t('cut'), { keepFocus: true, disabled: !selectedText, onClick: () => (copyText(selectedText), ta.setRangeText('', start, end), menu.remove(), renderComposer()) }),
			item('copy', t('copy'), { keepFocus: true, disabled: !selectedText, onClick: () => (copyText(selectedText), menu.remove()) }),
			item('paperclip', t('paste'), {
				keepFocus: true,
				onClick: async () => {
					menu.remove();
					try {
						ta.setRangeText(await navigator.clipboard.readText(), start, end, 'end');
						autosize();
						renderComposer();
					} catch {
						toast('Use Ctrl+V to paste.', '');
					}
				}
			}),
			item('list', t('selectAll'), { keepFocus: true, onClick: () => (ta.select(), menu.remove()) }),
			h('div', 'menu-sep')
		];
		if (oneWord) {
			const sug = h('div', 'menu-sub', '<div class="menu-label">' + I('sparkle') + ' ' + esc(t('suggestions')) + ' <span class="spinner"></span></div>');
			items.push(sug);
			textAssist('suggest', selectedText.trim(), ta.value).then((res) => {
				const list = (res && res.suggestions) || [];
				sug.replaceChildren(h('div', 'menu-label', I('sparkle') + ' ' + esc(t('suggestions'))), ...(list.length ? list.map((w) => item(null, w, { cls: 'suggest-item', keepFocus: true, onClick: () => (replace(w), menu.remove()) })) : [h('div', 'menu-label', esc(t('noSuggestions')))]));
				if (menu.isConnected) menu._place();
			});
			items.push(h('div', 'menu-sep'));
		}
		items.push(run('fix', t('fixSpelling')), run('improve', t('improveWording')), run('shorter', t('makeShorter')), run('english', t('translateEn')));
		items.forEach((x) => menu.appendChild(x));
		document.body.appendChild(menu);
		// Place at the cursor; flip above it when there is no room below (the
		// composer sits at the bottom), and re-place once suggestions arrive.
		const place = () => {
			const w = menu.offsetWidth || 240;
			const hgt = menu.offsetHeight;
			menu.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, e.clientX)) + 'px';
			const below = e.clientY + hgt + 6 <= window.innerHeight;
			menu.style.top = Math.max(6, below ? e.clientY : Math.min(e.clientY, window.innerHeight - 6) - hgt) + 'px';
		};
		place();
		menu._place = place;
		menu.addEventListener('click', (ev) => ev.stopPropagation());
		menu.addEventListener('contextmenu', (ev) => ev.preventDefault());
	}

	function selectedChatText(message) {
		const selection = window.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) return '';
		const range = selection.getRangeAt(0), element = node => node.nodeType === 1 ? node : node.parentElement;
		const start = element(range.startContainer)?.closest('#messages .md'), end = element(range.endContainer)?.closest('#messages .md');
		if (!start || start !== end || (message && !message.contains(start))) return '';
		return selection.toString().trim();
	}
	function attachChatSelection(text) {
		if (!text) return;
		el.input.value += (el.input.value ? '\n\n' : '') + 'Selected context:\n' + text.split('\n').map(line => '> ' + line).join('\n') + '\n\n';
		autosize(); saveUi(); renderComposer(); el.input.focus();
		el.input.setSelectionRange(el.input.value.length, el.input.value.length);
	}
	function messageMenu(event) {
		const node = event.target.closest('.msg'), markdown = node?.querySelector('.md');
		if (!markdown || event.target.closest('input, textarea')) return;
		event.preventDefault(); closeMenus(); window.SideChat?.hideSelection();
		const selected = selectedChatText(node), message = state.messages.find(m => m.id === node.dataset.messageId);
		const excerpt = selected || message?.content || markdown.innerText || markdown.textContent;
		const sessionId = state.currentSessionId, menu = h('div', 'popover menu input-menu chat-message-menu');
		menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Message actions');
		const add = (icon, label, action, options = {}) => {
			const button = item(icon, label, { keepFocus: true, ...options, onClick: () => { menu.remove(); if (state.currentSessionId === sessionId) action(); } });
			button.setAttribute('role', 'menuitem');
			if (options.shortcut) button.appendChild(h('span', 'message-shortcut', esc(options.shortcut)));
			menu.appendChild(button); return button;
		};
		add('copy', 'Copy', () => copyText(selected), { disabled: !selected, shortcut: 'Ctrl+C' });
		add('copy', 'Copy message', () => copyText(markdown.innerText || markdown.textContent));
		add('code', 'Copy message as Markdown', () => copyText(message?.content || markdown.textContent));
		menu.appendChild(h('div', 'menu-sep'));
		add('chat', 'Send to Side Chat', () => window.SideChat?.show(excerpt), { disabled: !excerpt?.trim() || excerpt.length > 24000, title: selected ? 'Ask about the selected text' : 'Ask about this message' });
		add('paperclip', 'Attach selection as context', () => attachChatSelection(selected), { disabled: !selected, shortcut: 'Ctrl+Shift+L' });
		add('book', state.chapters.includes(message?.id) ? 'Unpin chapter' : 'Pin as chapter', () => post({ type: 'toggleChapter', id: message.id, sessionId }), { disabled: !message || state.isStreaming });
		menu.appendChild(h('div', 'menu-sep'));
		add('branch', 'Fork from here', () => chatBranch.show(message.id), { desc: 'Choose this workspace or a new worktree', disabled: !message || state.isStreaming || state.isRemote });
		document.body.appendChild(menu);
		menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)) + 'px';
		menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)) + 'px';
		menu.addEventListener('contextmenu', e => e.preventDefault());
		menu.addEventListener('click', e => e.stopPropagation());
		menu.addEventListener('keydown', e => {
			const buttons = [...menu.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
			if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
				e.preventDefault(); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
			}
		});
		menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
	}
	el.messages.addEventListener('contextmenu', messageMenu);
	el.messages.addEventListener('scroll', () => document.querySelector('.chat-message-menu')?.remove(), { passive: true });
	window.addEventListener('resize', () => document.querySelector('.chat-message-menu')?.remove());
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape' && document.querySelector('.chat-message-menu')) { closeMenus(); event.preventDefault(); event.stopImmediatePropagation(); }
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
			const text = selectedChatText(); if (text) { event.preventDefault(); event.stopImmediatePropagation(); closeMenus(); attachChatSelection(text); }
		}
	}, true);

	// ------------------------------------------------------------ @files, /commands, $skills popup

	function insertTrigger(ch) {
		const v = el.input.value;
		el.input.value = v + (v && !/\s$/.test(v) ? ' ' + ch : ch);
		el.input.focus();
		el.input.setSelectionRange(el.input.value.length, el.input.value.length);
		detectPopup();
	}

	function detectPopup() {
		if (ui.composing) return;
		const caret = el.input.selectionStart ?? el.input.value.length;
		const before = el.input.value.slice(0, caret);
		let m;
		if ((m = before.match(/^\/([\w:.-]*)$/))) {
			const q = m[1].toLowerCase();
			const custom = (state.commands || []).map((c) => ({ cmd: '/' + c.name, desc: (c.description || '') + (c.argumentHint ? ' ' + c.argumentHint : ''), source: c.source, custom: true }));
			ui.popup = { kind: 'cmd', items: [...COMMANDS, ...custom].filter((c) => c.cmd.slice(1).toLowerCase().includes(q)).sort((a, b) => Number(!a.cmd.slice(1).startsWith(q)) - Number(!b.cmd.slice(1).startsWith(q))), index: 0, start: 0, query: q };
		} else if ((m = before.match(/(?:^|\s)\$([\w-]*)$/)) && state.settings.skills) {
			const q = m[1].toLowerCase();
			ui.popup = { kind: 'skill', items: state.skills.filter((s) => s.enabled && s.name.includes(q)), index: 0, start: caret - m[1].length - 1, query: q };
		} else if ((m = before.match(/(?:^|\s)@([\w\-./\\:]*)$/)) && state.hasWorkspace) {
			if (Date.now() - ui.filesAt > 30000) {
				ui.filesAt = Date.now();
				post({ type: 'getFiles' });
			}
			const q = m[1].toLowerCase().replace(/\\/g, '/');
			ui.popup = { kind: 'file', items: mentionItems(q), index: 0, start: caret - m[1].length - 1, query: q };
			// Symbols come from the language servers, asynchronously.
			if (q.length >= 2 && !q.includes('/') && ui.symbolQuery !== q) {
				ui.symbolQuery = q;
				clearTimeout(ui.symbolTimer);
				ui.symbolTimer = setTimeout(() => post({ type: 'getSymbols', query: q }), 160);
			}
		} else {
			closePopup();
			return;
		}
		renderPopup();
	}

	const SPECIAL = [
		['selection', 'Selected code in the editor', 'pencil'],
		['problems', 'Errors and warnings in the workspace', 'alert'],
		['changes', 'Uncommitted git changes', 'branch'],
		['open', 'Files open in editor tabs', 'file']
	].filter(([name]) => !(B.desktop || B.desktopHost) || name === 'changes');

	/** Fuzzy match: every query char in order; bonuses for the file name, word starts and runs. */
	function fuzzy(q, text) {
		if (!q) return 1;
		const t = text.toLowerCase();
		const base = t.slice(t.lastIndexOf('/', t.length - 2) + 1);
		if (base.startsWith(q)) return 1000 - base.length;
		if (base.includes(q)) return 800 - base.length;
		if (t.includes(q)) return 600 - t.length;
		let score = 0;
		let at = 0;
		let run = 0;
		for (const ch of q) {
			const i = t.indexOf(ch, at);
			if (i < 0) return 0;
			run = i === at ? run + 1 : 0;
			score += 10 + run * 5 + (i === 0 || '/._-'.includes(t[i - 1]) ? 15 : 0);
			at = i + 1;
		}
		return score - t.length / 10;
	}

	/** Grouped @ suggestions: context sources, folders, files and (async) symbols. */
	function mentionItems(q) {
		const items = [];
		for (const [name, desc, icon] of SPECIAL) {
			if (!q || name.startsWith(q)) items.push({ group: 'Context', label: '@' + name, sub: desc, icon, insert: name });
		}
		const folders = new Set();
		for (const f of ui.files) {
			const parts = f.split('/');
			for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/') + '/');
		}
		const rank = (list, max) =>
			list
				.map((x) => [fuzzy(q, x), x])
				.filter((x) => x[0] > 0)
				.sort((a, b) => b[0] - a[0] || a[1].length - b[1].length)
				.slice(0, max)
				.map((x) => x[1]);
		for (const d of rank([...folders], q ? 6 : 4)) {
			const parts = d.slice(0, -1).split('/');
			const name = parts.pop();
			items.push({ group: 'Folders', label: name + '/', sub: parts.join('/'), icon: 'folder', insert: d, count: ui.files.filter((f) => f.startsWith(d)).length });
		}
		for (const f of rank(ui.files, q ? 30 : 20)) {
			const parts = f.split('/');
			const name = parts.pop();
			items.push({ group: 'Files', label: name, sub: parts.join('/'), icon: 'file', insert: f });
		}
		if (q && ui.symbols && ui.symbols.query === q) {
			for (const s of ui.symbols.items.slice(0, 12)) items.push({ group: 'Symbols', label: s.name, sub: s.kind + ' · ' + s.path + ':' + s.line, icon: 'command', insert: s.path + ':' + s.line });
		}
		return items;
	}

	function closePopup() {
		if (ui.popup) {
			ui.popup = null;
			renderPopup();
		}
	}

	function renderPopup() {
		const p = ui.popup;
		if (!p || !p.items.length) {
			el.popup.classList.add('hidden');
			el.input.setAttribute('aria-expanded', 'false');
			el.input.removeAttribute('aria-activedescendant');
			return;
		}
		el.popup.classList.remove('hidden');
		el.input.setAttribute('aria-expanded', 'true');
		el.input.setAttribute('aria-activedescendant', 'composer-option-' + p.index);
		// Command Menu style: an icon, the name with the typed text marked, a hint, and ↵ on the active row.
		const marked = (text) => {
			const q = p.query || '';
			const at = q ? text.toLowerCase().indexOf(q) : -1;
			return at < 0 ? esc(text) : esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + q.length)) + '</mark>' + esc(text.slice(at + q.length));
		};
		const ENTER = '<span class="cmc-enter" aria-hidden="true"><svg viewBox="0 0 12 12" width="12" height="12"><path d="M9.5 2.5v3.75a1 1 0 0 1-1 1H2.5M4.5 5.25 2.25 7.25l2.25 2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg></span>';
		el.popup.classList.add('cmc');
		const rows = p.items.map((it, i) => {
				let b;
				const on = i === p.index;
				if (p.kind === 'cmd') b = h('button', 'menu-item cmd cmc-item' + (on ? ' active' : ''), '<span class="cmc-icon">' + I(it.custom ? 'sparkle' : 'command') + '</span><span class="cmc-text"><span class="cmc-name">/' + marked(it.cmd.slice(1)) + '</span><span class="cmc-hint">' + esc(it.desc) + '</span></span>' + (it.source ? '<span class="src-badge">' + esc(it.source.replace(/^plugin:/, '')) + '</span>' : '') + (on ? ENTER : ''));
				else if (p.kind === 'skill') b = h('button', 'menu-item cmd cmc-item' + (on ? ' active' : ''), '<span class="cmc-icon">' + I('sparkle') + '</span><span class="cmc-text"><span class="cmc-name">$' + marked(it.name) + '</span><span class="cmc-hint">' + esc(it.description) + (it.pinned ? ' · pinned in this chat' : '') + '</span></span>' + (on ? ENTER : ''));
				else b = h('button', 'menu-item mention-item cmc-item' + (on ? ' active' : ''), '<span class="cmc-icon">' + I(it.icon) + '</span><span class="cmc-text"><span class="cmc-name mi-label">' + marked(it.label) + '</span><span class="cmc-hint dir">' + esc(it.sub || '') + '</span></span>' + (it.count ? '<span class="mi-count">' + it.count + '</span>' : '') + (on ? ENTER : ''));
				b.id = 'composer-option-' + i; b.tabIndex = -1;
				b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(i === p.index));
				b.addEventListener('mousedown', (e) => e.preventDefault());
				b.addEventListener('click', () => { if (!ui.composing) applyPopup(it); });
				return b;
			});
		// Section labels between groups (files popup), one label otherwise.
		const nodes = [];
		if (p.kind !== 'file') nodes.push(h('div', 'menu-label', esc(p.kind === 'cmd' ? t('commands') : t('skills'))));
		rows.forEach((b, i) => {
			const g = p.kind === 'file' && p.items[i].group;
			if (g && (i === 0 || p.items[i - 1].group !== g)) nodes.push(h('div', 'menu-label', esc(g)));
			nodes.push(b);
		});
		nodes.push(h('div', 'cmc-foot', '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> ' + (p.kind === 'cmd' ? 'run' : 'insert') + '</span>' + (p.kind === 'file' ? '<span class="cmc-tip"><b>folder/</b> attaches every file · <b>file:line</b> the code there</span>' : '<span><kbd>esc</kbd> close</span>')));
		// One highlight glides between rows instead of each row lighting up on its own.
		const pill = el.popup._pill || (el.popup._pill = h('div', 'cmc-pill'));
		el.popup.replaceChildren(pill, ...nodes);
		const active = el.popup.querySelector('.menu-item.active');
		if (active) {
			pill.style.transform = 'translateY(' + active.offsetTop + 'px)';
			pill.style.height = active.offsetHeight + 'px';
			pill.dataset.lit = '';
			active.scrollIntoView({ block: 'nearest' });
		} else delete pill.dataset.lit;
	}

	function applyPopup(it) {
		const p = ui.popup;
		if (!p) return;
		if (p.kind === 'cmd' && it.custom) {
			// Custom commands take arguments: leave "/name " in the box.
			el.input.value = it.cmd + ' ';
			el.input.setSelectionRange(el.input.value.length, el.input.value.length);
			closePopup();
			el.input.focus();
			autosize();
			renderComposer();
			return;
		}
		if (p.kind === 'cmd') {
			closePopup();
			el.input.value = '';
			autosize();
			runSlash(it.cmd);
			renderComposer();
			return;
		}
		const v = el.input.value;
		const caret = el.input.selectionStart ?? v.length;
		const insert = (p.kind === 'skill' ? '$' + it.name : '@' + it.insert) + ' ';
		el.input.value = v.slice(0, p.start) + insert + v.slice(caret);
		const pos = p.start + insert.length;
		el.input.setSelectionRange(pos, pos);
		closePopup();
		el.input.focus();
		autosize();
		renderComposer();
	}

	// ------------------------------------------------------------ microphone

	let browserRec = null;
	function toggleMic() {
		if (state.isRemote) {
			const Api = window.SpeechRecognition || window.webkitSpeechRecognition;
			if (!Api) return;
			if (browserRec) return browserRec.stop();
			browserRec = new Api();
			browserRec.continuous = true;
			browserRec.onresult = (e) => {
				for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) appendDictation(e.results[i][0].transcript);
			};
			browserRec.onend = () => {
				browserRec = null;
				renderComposer();
			};
			browserRec.start();
			renderComposer();
			return;
		}
		if (state.mic.state !== 'listening') {
			// A fresh listening session starts the silence watch over.
			micSilence.since = 0;
			micSilence.warned = false;
			el.mic.classList.remove('silent');
		}
		post({ type: state.mic.state === 'listening' ? 'micStop' : 'micStart' });
	}

	// Live dictation: the not-yet-final words sit at the end of the input and are
	// replaced as the recognizer refines them, then committed on the final phrase.
	let dictDraft = 0;
	// The microphone's input level (streamed twice a second): zero for too long means
	// the app listens to a device that captures nothing — say so instead of waiting.
	const micSilence = { since: 0, warned: false };
	function micLevel(level) {
		if (state.mic.state !== 'listening') return;
		if (level > 0) {
			micSilence.since = 0;
			if (micSilence.warned) {
				micSilence.warned = false;
				el.mic.classList.remove('silent');
			}
			return;
		}
		if (!micSilence.since) micSilence.since = Date.now();
		if (!micSilence.warned && Date.now() - micSilence.since > 6000) {
			micSilence.warned = true;
			el.mic.classList.add('silent');
			el.mic.title = 'Not hearing anything — the microphone captures no sound. Check the default input in Settings > System > Sound, and a mic mute key (e.g. Fn+F10).';
			toast('The microphone is silent — Windows is sending no sound to the app. Check your default input device.', 'error');
		}
	}

	/**
	 * A dictation failure the user can act on — a dialog with the fix beats a toast
	 * that vanishes. Blocked by Windows → straight to the microphone settings page.
	 */
	function micProblem(error, blocked) {
		const root = $('dialog-root');
		if (!root) return;
		const overlay = h('div', 'overlay');
		overlay.id = 'mic-dialog';
		const dlg = h('div', 'dialog sm');
		dlg.setAttribute('role', 'dialog');
		dlg.setAttribute('aria-modal', 'true');
		dlg.setAttribute('aria-label', blocked ? 'Allow microphone access' : 'Microphone problem');
		dlg.innerHTML =
			'<div class="dialog-head"><span class="dialog-title">' + esc(blocked ? 'Allow microphone access' : 'Microphone problem') + '</span><button class="icon-btn" data-x title="Close">' + I('close') + '</button></div>' +
			'<div class="dialog-body"><p class="page-desc">' + (blocked ? 'Windows is blocking the microphone for desktop apps like this one, so dictation cannot hear you. Allow it in Windows Settings, then try again — no restart needed.' : esc(error)) + '</p></div>' +
			'<div class="dialog-foot"><span class="spacer"></span>' +
			(blocked ? '<button class="btn btn-secondary" data-settings>' + I('lock') + 'Open Windows settings</button>' : '') +
			'<button class="btn btn-ghost" data-retry>' + I('retry') + 'Try again</button><button class="btn btn-primary" data-x>Close</button></div>';
		overlay.appendChild(dlg);
		root.replaceChildren(overlay);
		const close = () => {
			document.removeEventListener('keydown', onKey, true);
			root.replaceChildren();
		};
		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
			}
		};
		document.addEventListener('keydown', onKey, true);
		overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
		for (const b of dlg.querySelectorAll('[data-x]')) b.addEventListener('click', close);
		dlg.querySelector('[data-retry]').addEventListener('click', () => {
			close();
			post({ type: 'micStart' });
		});
		const settings = dlg.querySelector('[data-settings]');
		if (settings) settings.addEventListener('click', () => {
			close();
			post({ type: 'openExternal', url: 'ms-settings:privacy-microphone' });
		});
		dlg.querySelector('[data-retry]').focus();
	}

	function appendDictation(text, provisional) {
		const v = el.input.value;
		if (dictDraft > v.length) dictDraft = 0; // the box was cleared under us
		const base = dictDraft ? v.slice(0, v.length - dictDraft) : v;
		const glue = base && !/\s$/.test(base) ? ' ' : '';
		if (provisional) {
			const t = text.trim();
			if (!t) return;
			dictDraft = glue.length + t.length;
			el.input.value = base + glue + t;
		} else {
			dictDraft = 0;
			const t = text.trim();
			if (!t) return;
			el.input.value = base + glue + t + ' ';
		}
		autosize();
		saveUi();
		renderComposer();
	}

	// ------------------------------------------------------------ history drawer

	const FOLDER_COLORS = ['blue', 'violet', 'green', 'orange', 'pink', 'gray'];
	function openHistory() {
		ui.historyOpen = true;
		renderHistory();
		// The folder row is the projects; ask for them so a freshly launched window fills it.
		post({ type: 'getProjects' });
		el.historySearch.focus({ preventScroll: true });
	}

	function resetHistory() {
		ui.historyQuery = '';
		ui.historyFilter = 'all';
		ui.chatHits = null;
		el.historySearch.value = '';
		renderHistory();
		el.historySearch.focus();
	}

	function updateSelectedChats(patch) {
		if (!ui.historySelected.size) return;
		post({ type: 'updateSessions', ids: [...ui.historySelected], patch });
		ui.historySelected.clear();
		ui.historySelecting = false;
		renderHistory();
		$('history-select').focus({ preventScroll: true });
	}

	/** One History toast: what happened, plus the single step that takes it back. */
	let historyToastTimer;
	function notifyHistory(message, onUndo) {
		const toast = $('hl-toast');
		if (!toast) return;
		const hide = () => toast.classList.add('hidden');
		const undo = h('button', 'hl-toast-undo', 'Undo');
		undo.addEventListener('click', () => { onUndo(); hide(); });
		toast.replaceChildren(h('span', 'hl-toast-icon', I('check')), h('span', 'hl-toast-text', esc(message)));
		if (onUndo) toast.appendChild(undo);
		toast.classList.remove('hidden');
		clearTimeout(historyToastTimer);
		historyToastTimer = setTimeout(hide, onUndo ? 6000 : 4000);
	}

	function renderHistory() {
		if (!ui.historyOpen && el.history.contains(document.activeElement)) (document.querySelector('.zc-archive-btn') || $('btn-history')).focus({ preventScroll: true });
		el.history.classList.toggle('open', ui.historyOpen);
		el.history.inert = !ui.historyOpen;
		el.history.setAttribute('aria-hidden', String(!ui.historyOpen));
		$('btn-history').setAttribute('aria-expanded', String(ui.historyOpen));
		// Never leave the column scrolled sideways by the drawer.
		if (el.app.scrollLeft) el.app.scrollLeft = 0;
		if (!ui.historyOpen) return;

		// Folder art, model tones and the view switcher only mean something next to the
		// rows below, so they live in the renderer instead of the module scope.
		const FOLDER_PATH = 'M38 0H176Q196 0 204 14L218 30Q224 38 246 38H562Q600 38 600 76V462Q600 500 562 500H38Q0 500 0 462V38Q0 0 38 0Z';
		const TINTS = {
			blue: ['#79bdf0', '#e6eef8', '#a8d3f5'],
			violet: ['#b3a1f2', '#e9e3fb', '#c9bcf7'],
			green: ['#7fd3a4', '#e6f5ec', '#a2e0bd'],
			orange: ['#efa765', '#f8e8d5', '#f4c28e'],
			pink: ['#ef9dc0', '#fae4ee', '#f5bcd3'],
			gray: ['#b2b8c3', '#eceef1', '#cbd0d8']
		};
		const tone = (key) => { let n = 7; for (const ch of String(key || '')) n = (n * 31 + ch.charCodeAt(0)) % 6; return n; };
		const initials = (name) => { const words = String(name || '').split(/[^a-zA-Z0-9]+/).filter(Boolean); const letters = words.filter((w) => /^[a-z]/i.test(w)); const pick = letters.length ? letters : words; return ((pick[0] || '?')[0] + (pick[1] ? pick[1][0] : '')).toUpperCase(); };
		const q = ui.historyQuery.trim().toLowerCase();
		const activeFolderId = ui.historyFilter.startsWith('folder:') ? ui.historyFilter.slice(7) : null;

		const setView = (filter) => {
			ui.historySelected.clear();
			ui.historySelecting = false;
			ui.historyFilter = filter;
			ui.historyProject = null;
			el.historyList.scrollTop = 0;
			renderHistory();
		};

		// The Library row is the app's project folders: one is selected at a time and the
		// table below lists only that folder's sessions. Declared up here because the list,
		// the footer counts and the tree counts all read the scoped set.
		const PROJECT_COLORS = ['blue', 'violet', 'green', 'orange', 'pink', 'gray'];
		// A project with a folder, or the "Unassigned chats" group when it holds any: those chats
		// would otherwise have no folder to live in.
		const projects = (Array.isArray(state.projects) ? state.projects : [])
			.filter((p) => p && (p.path || (p.chats || []).length));
		const normPath = (v) => String(v || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		// A chat belongs to the folder whose path it records; chats recorded without a path stay
		// with the folder that lists them. The live list is shared, so it is never shown whole.
		const scopedFor = (p) => {
			const key = normPath(p.path);
			const listed = new Set((p.chats || []).map((c) => c.id));
			const out = state.sessions.filter((s) => {
				const own = normPath(s.projectPath);
				return own ? own === key : listed.has(s.id);
			});
			const seen = new Set(out.map((s) => s.id));
			for (const chat of (p.chats || [])) if (!seen.has(chat.id)) out.push(chat);
			return out;
		};
		const projectChats = (p) => scopedFor(p).filter((c) => !c.archived);
		const projectColor = (p) => PROJECT_COLORS[tone(p.path || p.name) % PROJECT_COLORS.length];
		// Selecting a folder decides whose sessions the table shows: the window's own project
		// reads the live list, another project reads its session metas and opens that project
		// (at the picked session) in its own window.
		const selectedProject = ui.historyProject ? projects.find((p) => p.id === ui.historyProject) || null : null;
		if (ui.historyProject && !selectedProject) ui.historyProject = null;
		const inCurrentProject = !selectedProject || !!selectedProject.current;
		// "All chats" is every folder's chats, once each, with the folder kept for grouping.
		const projectOf = new Map();
		const allSessions = [];
		for (const p of projects) for (const s of scopedFor(p)) if (!projectOf.has(s.id)) { projectOf.set(s.id, p); allSessions.push(s); }
		// Before the folder list has loaded there is no grouping to give; show the store as it is.
		const everything = projects.length ? allSessions : state.sessions;
		const scoped = selectedProject ? scopedFor(selectedProject) : everything;
		const selectProject = (p) => {
			ui.historyProject = selectedProject && selectedProject.id === p.id ? null : p.id;
			ui.historyFilter = 'all';
			ui.historySelected.clear();
			ui.historySelecting = false;
			el.historyList.scrollTop = 0;
			renderHistory();
		};
		const openProject = (p) => {
			if (p.available === false) return;
			post({ type: 'projectOpen', path: p.path });
		};
		const jumpToSession = (s) => {
			// A chat in this window's store is one switch away; another project opens with it.
			if (inCurrentProject || !selectedProject || !selectedProject.path) {
				if (!state.sessions.some((x) => x.id === s.id) && !inCurrentProject) return;
				post({ type: 'switchSession', id: s.id });
				ui.historyOpen = false;
				renderHistory();
				el.input.focus();
				return;
			}
			if (selectedProject.available === false) return;
			post({ type: 'projectOpen', path: selectedProject.path, sessionId: s.id });
		};
		// ---- sidebar: rail state ------------------------------------------------
		const rail = ui.historyFilter === 'pinned' ? 'pinned' : activeFolderId ? 'folders' : 'chats';
		for (const button of el.history.querySelectorAll('.hl-rail-btn')) {
			if (!button.dataset.rail) continue;
			const active = button.dataset.rail === rail;
			button.classList.toggle('active', active);
			button.setAttribute('aria-pressed', String(active));
		}

		// ---- sort ---------------------------------------------------------------
		const sorts = [['newest', t('newestFirst')], ['oldest', t('oldestFirst')], ['title', t('titleAZ')], ['prompts', t('mostPrompts')]];
		const sortSelect = $('history-sort');
		const sortHtml = sorts.map(([value, label]) => '<option value="' + esc(value) + '">' + esc(label) + '</option>').join('');
		if (sortSelect.innerHTML !== sortHtml) sortSelect.innerHTML = sortHtml;
		sortSelect.value = ui.historySort;
		$('hl-sort-label').textContent = (sorts.find((x) => x[0] === ui.historySort) || sorts[0])[1];

		// ---- the list -----------------------------------------------------------
		// Title matches plus full-text hits from the host (message contents).
		const hits = q && ui.chatHits && ui.chatHits.query.toLowerCase() === q ? new Map(ui.chatHits.hits.map((x) => [x.id, x.snippet])) : new Map();
		const list = scoped.filter((s) => {
			// Archived chats stay in the list, dimmed and marked, so "All chats" is really every chat.
			if (ui.historyFilter === 'pinned' && !s.pinned) return false;
			if (ui.historyFilter === 'edited' && !s.added && !s.removed) return false;
			if (ui.historyFilter === 'unfiled' && state.folders.some((f) => f.id === s.folderId)) return false;
			if (activeFolderId && s.folderId !== activeFolderId) return false;
			const folder = state.folders.find((f) => f.id === s.folderId);
			return !q || [s.title, s.model, folder && folder.name].some((v) => (v || '').toLowerCase().includes(q)) || hits.has(s.id);
		}).sort((a, b) => ui.historySort === 'oldest' ? a.updatedAt - b.updatedAt : ui.historySort === 'title' ? (a.title || '').localeCompare(b.title || '') : ui.historySort === 'prompts' ? (b.count || 0) - (a.count || 0) || b.updatedAt - a.updatedAt : b.updatedAt - a.updatedAt);
		ui.historyVisible = list.map((s) => s.id);
		for (const id of ui.historySelected) if (!ui.historyVisible.includes(id)) ui.historySelected.delete(id);

		$('history-results').textContent = String(list.length);
		$('history-search-clear').classList.toggle('hidden', !ui.historyQuery);
		$('history-reset').classList.toggle('hidden', !q && ui.historyFilter === 'all');
		if (!inCurrentProject && ui.historySelecting) ui.historySelecting = false;
		$('history-select').textContent = t(ui.historySelecting ? 'doneSelecting' : 'selectChats');
		$('history-select').setAttribute('aria-pressed', String(ui.historySelecting));
		$('history-select').classList.toggle('hidden', !inCurrentProject);
		$('history-select-all-wrap').classList.toggle('hidden', !ui.historySelecting && !ui.historySelected.size);
		$('history-select-all').checked = !!list.length && ui.historySelected.size === list.length;
		$('history-select-all').indeterminate = !!ui.historySelected.size && ui.historySelected.size < list.length;
		$('history-select-all').disabled = !list.length;
		$('history-bulk').classList.toggle('hidden', !ui.historySelected.size);
		$('history-selection-count').textContent = t('selectedCount', { n: ui.historySelected.size });
		const picked = [...ui.historySelected].map((id) => state.sessions.find((s) => s.id === id)).filter(Boolean);
		const allArchived = picked.length > 0 && picked.every((s) => s.archived);
		$('history-archive-label').textContent = t(allArchived ? 'unarchive' : 'archive');
		el.historyList.classList.toggle('selecting', !!ui.historySelected.size);

		// ---- header: breadcrumb, project stack ----------------------------------
		const currentFolder = state.folders.find((f) => f.id === activeFolderId);
		$('hl-crumb-label').textContent = currentFolder ? currentFolder.name
			: selectedProject ? selectedProject.name
			: ui.historyFilter === 'pinned' ? t('pinned')
			: t('allChats');
		$('history-stats').innerHTML = [[scoped.length, t('totalChats')], [scoped.reduce((n, s) => n + (s.count || 0), 0), t('prompts')], [scoped.filter((s) => s.pinned && !s.archived).length, t('pinned')]]
			.map(([n, label]) => '<div><strong title="' + n.toLocaleString() + '">' + fmtTokens(n) + '</strong><span>' + esc(label) + '</span></div>').join('');
		$('hl-stack').innerHTML = projects.slice(0, 4).map((p) => '<span class="hl-dot fc-' + esc(projectColor(p)) + '"></span>').join('')
			+ (projects.length > 4 ? '<span class="hl-stack-more">+' + (projects.length - 4) + '</span>' : '');

		// ---- sidebar tree -------------------------------------------------------
		const tree = [];
		const viewRow = (label, icon, n, filter, active) => {
			const row = h('button', 'hl-tree-row' + (active ? ' is-active' : ''));
			row.setAttribute('aria-pressed', String(active));
			row.innerHTML = I(icon) + '<span class="hl-tree-name">' + esc(label) + '</span><span class="hl-tree-count">' + n + '</span>';
			row.addEventListener('click', () => setView(filter));
			return row;
		};
		// Two views only — everything, and what is pinned. Folders narrow them further.
		tree.push(viewRow(t('allChats'), 'history', everything.filter((s) => !s.archived).length, 'all', ui.historyFilter === 'all' && !selectedProject));
		tree.push(viewRow(t('pinned'), 'pin', everything.filter((s) => s.pinned && !s.archived).length, 'pinned', ui.historyFilter === 'pinned'));
		if (projects.length) {
			tree.push(h('div', 'hl-tree-label', 'Projects'));
			for (const p of projects) {
				const n = projectChats(p).length;
				const browsing = !!selectedProject && selectedProject.id === p.id;
				const row = h('button', 'hl-tree-row' + (browsing ? ' is-active' : ''));
				row.setAttribute('aria-pressed', String(browsing));
				row.title = p.path;
				if (p.available === false) row.classList.add('is-missing');
				row.innerHTML = '<span class="hl-dot fc-' + esc(projectColor(p)) + '"></span><span class="hl-tree-name">' + esc(p.name) + '</span><span class="hl-tree-count">' + n + '</span>';
				row.addEventListener('click', () => openProject(p));
				tree.push(row);
			}
		}
		// Chat folders belong to the window's project; another folder's sessions have none here.
		if (inCurrentProject && state.folders.length) tree.push(h('div', 'hl-tree-label', 'Folders'));
		for (const f of (inCurrentProject ? state.folders : [])) {
			const n = state.sessions.filter((s) => !s.archived && s.folderId === f.id).length;
			const row = h('div', 'hl-tree-row hl-tree-folder' + (activeFolderId === f.id ? ' is-active' : ''));
			const collapsed = ui.collapsedFolders.has(f.id);
			const chevron = h('button', 'hl-tree-chev');
			chevron.setAttribute('aria-expanded', String(!collapsed));
			chevron.setAttribute('aria-label', f.name);
			chevron.title = collapsed ? 'Expand' : 'Collapse';
			chevron.innerHTML = I('chevronDown');
			chevron.addEventListener('click', (event) => {
				event.stopPropagation();
				collapsed ? ui.collapsedFolders.delete(f.id) : ui.collapsedFolders.add(f.id);
				saveUi();
				renderHistory();
			});
			const open = h('button', 'hl-tree-open');
			open.setAttribute('aria-pressed', String(activeFolderId === f.id));
			open.innerHTML = '<span class="hl-dot fc-' + esc(f.color) + '"></span><span class="hl-tree-name">' + esc(f.name) + '</span><span class="hl-tree-count">' + n + '</span>';
			open.addEventListener('click', () => setView('folder:' + f.id));
			const more = h('button', 'hl-tree-more');
			more.innerHTML = I('more');
			more.setAttribute('aria-label', t('manageFolder', { x: f.name }));
			more.title = t('manageFolder', { x: f.name });
			more.addEventListener('click', (event) => { event.stopPropagation(); folderMenu(f, more); });
			// A chat dragged out of the table files itself here, the way a file manager would.
			row.addEventListener('dragover', (event) => { event.preventDefault(); row.classList.add('is-drop'); });
			row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
			row.addEventListener('drop', (event) => {
				event.preventDefault();
				row.classList.remove('is-drop');
				const ids = String((event.dataTransfer && event.dataTransfer.getData('text/plain')) || '').split(',').filter(Boolean);
				if (ids.length) moveChats(ids, f);
			});
			row.appendChild(chevron);
			row.appendChild(open);
			row.appendChild(more);
			tree.push(row);
		}
		$('hl-tree').replaceChildren(...tree);
		$('hl-folders-count').textContent = String(projects.length);

		// ---- project cards ------------------------------------------------------
		const projectArt = (p, n, color) => {
			const tint = TINTS[color] || TINTS.gray;
			const models = [...new Set(projectChats(p).map((s) => s.model).filter(Boolean))].slice(0, 3);
			const sheets = [[170, 214], [158, 204], [166, 210]];
			const papers = n ? '<g class="hl-fd-papers">' + [0, 1, 2].map((i) => {
				const [w, h] = sheets[i];
				return '<rect class="hl-fd-doc hl-fd-doc--' + ['left', 'mid', 'right'][i] + '" x="' + (300 - w / 2) + '" y="' + (26 - i * 8) + '" width="' + w + '" height="' + h + '" rx="14" fill="' + tint[i] + '"/>';
			}).join('') + '</g>' : '';
			const dots = models.length ? '<span class="hl-fd-dots">' + models.map((m) => '<span class="hl-avatar" data-tone="' + tone(m) + '"></span>').join('') + '</span>' : '';
			const badge = p.available === false ? '<span class="hl-fd-badge">Missing</span>' : p.current ? '<span class="hl-fd-badge">Current</span>' : n ? '' : '<span class="hl-fd-badge">Empty</span>';
			return '<span class="hl-fd-art" style="--hl-tint:' + tint[0] + '"><span class="hl-fd"><svg class="hl-fd-svg" viewBox="0 0 600 640" aria-hidden="true">' + papers
				+ '<path class="hl-fd-back" d="' + FOLDER_PATH + '" transform="translate(0 140)"/>'
				+ '<path class="hl-fd-edge" d="' + FOLDER_PATH + '" transform="translate(0 140)"/></svg><span class="hl-fd-front"></span>' + dots
				+ badge + '</span></span>';
		};
		// Move a drop (or a bulk action) and offer the same one-step undo a file manager would.
		const moveChats = (ids, folder) => {
			const before = ids.map((id) => [id, (state.sessions.find((s) => s.id === id) || {}).folderId || null]);
			post({ type: 'updateSessions', ids, patch: { folderId: folder ? folder.id : null } });
			if (ui.historySelected.size) { ui.historySelected.clear(); renderHistory(); }
			notifyHistory(ids.length === 1 ? 'Moved to ' + (folder ? folder.name : t('unfiled')) : 'Moved ' + ids.length + ' chats to ' + (folder ? folder.name : t('unfiled')), () => {
				for (const [id, folderId] of before) post({ type: 'updateSession', id, patch: { folderId } });
				renderHistory();
			});
		};
		const cardMenu = (p, anchor) => {
			const menu = popMenu(anchor, []);
			menu.appendChild(h('div', 'menu-label', esc(p.name)));
			if (p.path) menu.appendChild(item('folder', 'Open in a project window', { disabled: !!p.current, onClick: () => { menu.remove(); openProject(p); } }));
			menu.appendChild(item('plus', 'New chat in this project', { disabled: p.available === false, onClick: () => { menu.remove(); post({ type: 'projectNewChat', path: p.path }); } }));
		};
		const cards = projects.map((p) => {
			const n = projectChats(p).length;
			const color = projectColor(p);
			const active = !!selectedProject && selectedProject.id === p.id;
			const card = h('div', 'hl-folder' + (active ? ' is-active' : '') + (p.available === false ? ' is-missing' : ''));
			card.dataset.project = p.id || p.path;
			const open = h('button', 'hl-folder-open');
			open.setAttribute('aria-pressed', String(active));
			open.title = p.path;
			open.innerHTML = projectArt(p, n, color) + '<span class="hl-folder-name">' + esc(p.name) + '</span><span class="hl-folder-meta">'
				+ (p.available === false ? 'Folder not found' : n ? esc(t(n === 1 ? 'oneChat' : 'chatCount', { n })) : 'No chats') + '</span>';
			open.addEventListener('click', () => selectProject(p));
			card.appendChild(open);
			const more = h('button', 'hl-folder-more');
			more.innerHTML = I('more');
			more.setAttribute('aria-label', 'Project actions for ' + p.name);
			more.title = 'Project actions';
			more.addEventListener('click', (event) => { event.stopPropagation(); cardMenu(p, more); });
			card.appendChild(more);
			return card;
		});
		$('hl-folders').replaceChildren(...cards);

		// ---- table rows ---------------------------------------------------------
		const out = [];
		const mark = (text) => {
			const safe = esc(text);
			if (!q) return safe;
			const at = text.toLowerCase().indexOf(q);
			return at < 0 ? safe : esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + q.length)) + '</mark>' + esc(text.slice(at + q.length));
		};
		const row = (s) => {
			const running = state.runningSessionId === s.id;
			const r = h('div', 'session-row' + (s.id === state.currentSessionId ? ' current' : '') + (running ? ' running' : '') + (s.archived ? ' archived' : '') + (ui.historySelected.has(s.id) ? ' selected' : ''));
			r.dataset.session = s.id;
			r.setAttribute('draggable', String(inCurrentProject));
			if (inCurrentProject) {
				const label = h('label', 'hl-check');
				const check = h('input', 'sr-select');
				check.type = 'checkbox';
				check.checked = ui.historySelected.has(s.id);
				check.setAttribute('aria-label', t('selectChat', { x: s.title || t('newChat') }));
				check.addEventListener('change', () => {
					check.checked ? ui.historySelected.add(s.id) : ui.historySelected.delete(s.id);
					renderHistory();
				});
				label.appendChild(check);
				r.appendChild(label);
			} else {
				r.appendChild(h('span', 'hl-check'));
			}
			const kind = h('span', 'hl-file');
			kind.dataset.tone = String(tone(s.model || s.id));
			kind.innerHTML = I('chat');
			r.appendChild(kind);
			const snippet = hits.get(s.id);
			const open = h('button', 'sr-open');
			if (s.id === state.currentSessionId) open.setAttribute('aria-current', 'true');
			open.innerHTML = '<span class="sr-title-row"><span class="sr-title-main">'
				+ (running ? '<span class="sr-spin"></span>' : '')
				+ '<span class="title">' + mark(s.title || t('newChat')) + '</span>'
				+ '</span>'
				+ (s.id === state.currentSessionId ? '<span class="sr-current">' + esc(t('currentChat')) + '</span>' : '')
				+ (s.archived ? '<span class="sr-tag">' + esc(t('archived')) + '</span>' : '')
				+ '</span>'
				+ (snippet && !(s.title || '').toLowerCase().includes(q) ? '<span class="sr-snippet">' + mark(snippet) + '</span>' : '');
			r.appendChild(open);
			const model = h('span', 'hl-model');
			model.innerHTML = s.model
				? '<span class="hl-avatar" data-tone="' + tone(s.model) + '">' + esc(initials(s.model.split('/').pop())) + '</span><span class="hl-model-name">' + esc(s.model.split('/').pop()) + '</span>'
				: '<span class="hl-model-name">—</span>';
			r.appendChild(model);
			const prompts = h('span', 'hl-row-count');
			prompts.textContent = String(s.count || 0);
			prompts.title = t(s.count === 1 ? 'onePrompt' : 'promptCount', { n: s.count || 0 });
			r.appendChild(prompts);
			const when = h('time', 'sr-when');
			when.textContent = relTime(s.updatedAt);
			if (s.updatedAt) when.title = fmtStamp(s.updatedAt);
			r.appendChild(when);
			if (inCurrentProject) {
				const more = h('button', 'icon-btn sr-more', I('more'));
				more.title = t('manageChat');
				more.setAttribute('aria-label', t('manageChatNamed', { x: s.title || t('newChat') }));
				more.addEventListener('click', (event) => {
					event.stopPropagation();
					rowMenu(s, more);
				});
				r.appendChild(more);
			} else {
				r.appendChild(h('span'));
			}
			const openChat = () => {
				if (inCurrentProject && ui.historySelecting) {
					ui.historySelected.has(s.id) ? ui.historySelected.delete(s.id) : ui.historySelected.add(s.id);
					renderHistory();
					return;
				}
				jumpToSession(s);
			};
			open.addEventListener('click', openChat);
			r.addEventListener('dragstart', (event) => {
				if (!inCurrentProject) return;
				const ids = ui.historySelected.has(s.id) ? [...ui.historySelected] : [s.id];
				r.classList.add('dragging');
				if (event.dataTransfer) {
					event.dataTransfer.effectAllowed = 'move';
					event.dataTransfer.setData('text/plain', ids.join(','));
				}
			});
			r.addEventListener('dragend', () => {
				r.classList.remove('dragging');
				for (const card of el.history.querySelectorAll('.hl-folder.is-drop')) card.classList.remove('is-drop');
			});
			return r;
		};
		const group = (label, items, folder) => {
			const head = h('div', 'hl-group');
			head.innerHTML = (folder ? '<span class="hl-dot fc-' + esc(folder.color) + '"></span>' : '')
				+ '<span class="hl-group-label"><span class="hl-group-name">' + esc(label) + '</span><span class="hl-group-count">' + items.length + '</span></span>';
			out.push(head);
			items.forEach((s) => out.push(row(s)));
		};

		if (!list.length) {
			const filtered = !!q || ui.historyFilter !== 'all';
			const empty = h('div', 'history-empty', '<span>' + I(filtered ? 'search' : 'archive') + '</span><h3>' + esc(t(filtered ? 'noMatchingChats' : 'noChatsYet')) + '</h3><p>' + esc(t(filtered ? 'tryOtherSearch' : 'newChatHint')) + '</p>');
			const action = h('button', 'hl-btn-secondary', esc(filtered ? t('resetFilters') : inCurrentProject ? t('newChat') : 'Open project'));
			action.addEventListener('click', () => {
				if (filtered) return resetHistory();
				if (inCurrentProject) return $('btn-history-new').click();
				if (selectedProject && selectedProject.path) openProject(selectedProject);
			});
			empty.appendChild(action);
			out.push(empty);
		} else if (!selectedProject && projects.length) {
			// These views span folders, so each folder is a section: never an unlabelled mix.
			const order = projects.length ? projects : [null];
			for (const p of order) {
				const mine = p ? list.filter((s) => projectOf.get(s.id) === p) : list;
				if (mine.length) group(p ? p.name : t('chats'), mine, p || undefined);
			}
		} else {
			// Pinned chats float above folders, as they do in the sidebar. A collapsed
			// folder keeps its chats out of the table; the cards still count them.
			const pinned = list.filter((s) => s.pinned);
			if (pinned.length) group(t('pinned'), pinned);
			for (const f of state.folders) {
				const inside = list.filter((s) => s.folderId === f.id && !s.pinned);
				if (!inside.length) continue;
				if (!q && ui.collapsedFolders.has(f.id)) continue;
				group(f.name, inside, f);
			}
			const loose = list.filter((s) => !s.pinned && !state.folders.some((f) => f.id === s.folderId));
			if (loose.length) group(t('unfiled'), loose);
		}
		const scroll = el.historyList.scrollTop;
		const focused = document.activeElement;
		const focusedRow = focused && focused.closest('.session-row');
		el.historyList.replaceChildren(...out);
		el.historyList.scrollTop = scroll;
		if (focusedRow) {
			const replacement = [...el.historyList.querySelectorAll('.session-row')].find((r) => r.dataset.session === focusedRow.dataset.session);
			const control = replacement && replacement.querySelector(focused.classList.contains('sr-select') ? '.sr-select' : focused.classList.contains('sr-more') ? '.sr-more' : '.sr-open');
			if (control) control.focus({ preventScroll: true });
			else $('history-select').focus({ preventScroll: true });
		}
	}

	function popMenu(anchor, items) {
		closeMenus();
		const menu = h('div', 'popover menu row-menu');
		items.forEach((x) => menu.appendChild(x));
		document.body.appendChild(menu);
		const r = anchor.getBoundingClientRect();
		const w = menu.offsetWidth || 200;
		menu.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + 'px';
		const top = r.bottom + 4;
		menu.style.top = (top + menu.offsetHeight > window.innerHeight ? Math.max(6, r.top - menu.offsetHeight - 4) : top) + 'px';
		menu.addEventListener('click', (e) => e.stopPropagation());
		return menu;
	}

	function inlineInput(menu, placeholder, initial, onSubmit) {
		menu.replaceChildren();
		const wrap = h('div', 'inline-input');
		const input = document.createElement('input');
		input.placeholder = placeholder;
		input.value = initial || '';
		const ok = h('button', 'btn btn-primary btn-sm', 'OK');
		const submit = () => {
			if (input.value.trim()) onSubmit(input.value.trim());
			menu.remove();
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') submit();
			if (e.key === 'Escape') menu.remove();
		});
		ok.addEventListener('click', submit);
		wrap.append(input, ok);
		menu.appendChild(wrap);
		input.focus();
		input.select();
	}

	function rowMenu(s, anchor) {
		const update = (patch) => post({ type: 'updateSession', id: s.id, patch });
		const menu = popMenu(anchor, []);
		const items = [
			item('pencil', t('rename'), { onClick: () => inlineInput(menu, t('rename'), s.title, (v) => update({ title: v })) }),
			item('pin', s.pinned ? t('unpin') : t('pin'), { disabled: s.archived, onClick: () => (update({ pinned: !s.pinned }), menu.remove()) }),
			h('div', 'menu-label', esc(t('moveToFolder'))),
			...state.folders.map((f) => item(null, f.name, { checked: s.folderId === f.id, badges: '<span class="folder-dot fc-' + esc(f.color) + '"></span>', onClick: () => (update({ folderId: f.id }), menu.remove()) })),
			...(s.folderId ? [item('close', '—', { onClick: () => (update({ folderId: null }), menu.remove()) })] : []),
			item('folderPlus', t('newFolder') + '…', { onClick: () => inlineInput(menu, t('newFolder'), '', (v) => post({ type: 'saveFolder', name: v, color: FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length], moveSession: s.id })) }),
			h('div', 'menu-sep'),
			item('archive', s.archived ? t('unarchive') : t('archive'), { onClick: () => (update({ archived: !s.archived }), menu.remove()) }),
			item('trash', t('delete'), {
				cls: 'danger',
				onClick: () => { menu.remove(); window.__zcProjectActions.deleteChat(s.id); }
			})
		];
		items.forEach((x) => menu.appendChild(x));
	}

	/**
	 * The Projects sidebar chat menu: pin, rename, fork, archive. The sidebar is the
	 * primary chat list on the desktop app, so the session
	 * management the History rows get lives here too. getProjects re-renders
	 * the rows — updateSession alone only refreshes the History state.
	 */
	function projectChatMenu(s, anchor) {
		const update = (patch) => post({ type: 'updateSession', id: s.id, patch });
		const menu = popMenu(anchor, []);
		[
			item('pin', s.pinned ? t('unpinSession') : t('pinSession'), { disabled: s.archived, onClick: () => (update({ pinned: !s.pinned }), menu.remove(), post({ type: 'getProjects' })) }),
			item('pencil', t('rename'), { onClick: () => inlineInput(menu, t('rename'), s.title, (v) => (update({ title: v }), post({ type: 'getProjects' }))) }),
			item('branchOut', t('forkSession'), { disabled: !s.count, onClick: () => (post({ type: 'forkSession', id: s.id }), menu.remove(), post({ type: 'getProjects' })) }),
			h('div', 'menu-sep'),
			item('archive', s.archived ? t('unarchiveSession') : t('archiveSession'), { onClick: () => (update({ archived: !s.archived }), menu.remove(), post({ type: 'getProjects' })) })
		].forEach((x) => menu.appendChild(x));
	}
	function chatMenu(anchor) {
		const s = state.sessions.find((x) => x.id === state.currentSessionId);
		const empty = !state.messages.length;
		const update = (patch) => s && post({ type: 'updateSession', id: s.id, patch });
		const action = (name, extra) => post({ type: 'chatAction', action: name, ...(extra || {}) });
		const menu = popMenu(anchor, []);
		menu.classList.add('chat-menu');
		anchor?.setAttribute('aria-expanded', 'true');
		const origRemove = menu.remove.bind(menu);
		menu.remove = () => { anchor?.setAttribute('aria-expanded', 'false'); origRemove(); };

		function renderMainItems() {
			return [
				// On a phone the top bar stays quiet; these live here, at the top of the menu.
				...(window.__REMOTE__ ? [
					h('div', 'menu-label', 'Phone'),
					item('clock', t('history'), { onClick: () => (menu.remove(), $('btn-history').click()) }),
					item('layers', 'Work details', { onClick: () => (menu.remove(), togglePanel('auxiliary', true)) }),
					item('chat', 'Side chat', { onClick: () => (menu.remove(), $('btn-side-chat')?.click()) }),
					item('bell', 'Phone alerts', { desc: alertsState() ? 'Approvals and finished turns' : 'Get told when the agent needs you', pill: alertsState() ? 'On' : 'Off', pillOn: alertsState(), onClick: () => (menu.remove(), void togglePhoneAlerts()) }),
					item('gear', t('settings'), { onClick: () => (menu.remove(), openSettings()) }),
					h('div', 'menu-sep')
				] : []),
				item('pencil', t('rename'), { disabled: !s || empty, onClick: () => inlineInput(menu, t('rename'), s.title, (v) => update({ title: v })) }),
				item('archive', s && s.archived ? t('unarchive') : t('archive'), {
					disabled: !s || empty,
					onClick: () => {
						update({ archived: !s.archived });
					if (!s.archived) post({ type: 'newSession' });
						menu.remove();
					}
				}),
				h('div', 'menu-sep'),
				h('div', 'menu-label', esc(t('share'))),
				item('copy', t('copyMarkdown'), { disabled: empty, onClick: () => (action('copyMarkdown'), menu.remove()) }),
				item('link', t('shareGist'), { disabled: empty || !!window.__REMOTE__, onClick: () => (action('shareGist'), menu.remove()) }),
				item('folder', t('copyWorkdir'), { onClick: () => (action('copyWorkdir'), menu.remove()) }),
				h('div', 'menu-sep'),
				h('div', 'menu-label', esc(t('worktrees'))),
				item('branch', t('newWorktree'), { disabled: !!window.__REMOTE__, onClick: () => (post({ type: 'worktree', action: 'create' }), menu.remove()) }),
				item('list', t('manageWorktrees'), { disabled: !!window.__REMOTE__, onClick: () => (post({ type: 'worktree', action: 'manage' }), menu.remove()) }),
				h('div', 'menu-sep'),
				h('div', 'menu-label', esc(t('exportChat'))),
				item('file', t('exportMd'), { disabled: empty, onClick: () => (action('export', { format: 'md' }), menu.remove()) }),
				item('file', t('exportJson'), { disabled: empty, onClick: () => (action('export', { format: 'json' }), menu.remove()) }),
				...(window.__zcShell ? [
					h('div', 'menu-sep'),
					item('help', 'Help (?)', {
						arrow: true,
						desc: 'Device ID & logs',
						onClick: () => showHelpView()
					})
				] : [])
			];
		}

		function showHelpView() {
			menu.replaceChildren(
				h('div', 'menu-label', 'Help & Diagnostics'),
				item('copy', 'Copy device ID', {
					desc: 'Unique installation ID',
					onClick: () => {
						menu.remove();
						void window.__zcShell?.invoke('show_help', { action: 'copy_device_id' }).catch(() => undefined);
						window.UI?.toast?.('Device ID copied to clipboard', 'ok');
					}
				}),
				item('folder', 'Open logs', {
					desc: 'Open application logs folder',
					onClick: () => {
						menu.remove();
						void window.__zcShell?.invoke('show_help', { action: 'open_logs' }).catch(() => undefined);
					}
				}),
				h('div', 'menu-sep'),
				item('back', 'Back', {
					onClick: () => {
						menu.replaceChildren(...renderMainItems());
						const r2 = anchor.getBoundingClientRect();
						menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r2.right - menu.offsetWidth)) + 'px';
					}
				})
			);
			const r2 = anchor.getBoundingClientRect();
			menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r2.right - menu.offsetWidth)) + 'px';
		}

		renderMainItems().forEach((x) => menu.appendChild(x));
		// Re-place now that the items (and the wider min-width) are in.
		const r = anchor.getBoundingClientRect();
		menu.style.left = Math.max(6, Math.min(window.innerWidth - menu.offsetWidth - 6, r.right - menu.offsetWidth)) + 'px';
		menu.style.top = r.bottom + 6 + 'px';
	}

	function folderMenu(f, anchor) {
		const menu = popMenu(anchor, []);
		[
			item('pencil', t('rename'), { onClick: () => inlineInput(menu, t('rename'), f.name, (v) => post({ type: 'saveFolder', id: f.id, name: v, color: f.color })) }),
			h('div', 'menu-sep'),
			...FOLDER_COLORS.map((c) => item(null, c[0].toUpperCase() + c.slice(1), { checked: f.color === c, badges: '<span class="folder-dot fc-' + c + '"></span>', onClick: () => (post({ type: 'saveFolder', id: f.id, name: f.name, color: c }), menu.remove()) })),
			h('div', 'menu-sep'),
			item('trash', t('delete'), { cls: 'danger', onClick: () => (post({ type: 'deleteFolder', id: f.id }), menu.remove()) })
		].forEach((x) => menu.appendChild(x));
	}

	// ------------------------------------------------------------ render

	function render() {
		el.app.classList.toggle('is-empty', !state.messages.length && !state.isStreaming);
		window.applyAppearance(state.settings);
		applyLabels();
		const current = state.sessions.find((s) => s.id === state.currentSessionId);
		el.title.textContent = current && current.title ? current.title : t('newChat');
		renderMessages();
		renderProgress();
		renderWorkflowCard();
		renderWorkflowChip();
		renderComposer();
		if (ui.open) renderMenus();
		renderHistory();
		if (FS) {
			const bt = $('fsb-title');
			if (bt) bt.textContent = el.title.textContent || '';
			const sig = !!state.isStreaming + '|' + ((state.selection && state.selection.model) || '');
			if (fsUi.sig !== sig) {
				fsUi.sig = sig;
				fsRenderBanner();
			}
			fsScheduleTree();
		}
	}

	window.ZOpenFile = (path, line) => {
		if (document.body.classList.contains('desktop') && path) auxOpenPreview(path, line);
		else post({ type: 'openFile', path, line });
	};

	// ------------------------------------------------------------ events

	$('btn-history').addEventListener('click', () => {
		if (!ui.historyOpen) openHistory();
		else { ui.historyOpen = false; renderHistory(); }
	});
	$('btn-history-close').addEventListener('click', () => {
		ui.historyOpen = false;
		renderHistory();
	});
	$('btn-history-new').addEventListener('click', () => {
		ui.historyOpen = false;
		renderHistory();
		post({ type: 'newSession' });
	});
	// Continue a Claude Code / Codex chat (their local session logs; this project's first).
	$('btn-history-import').addEventListener('click', (e) => {
		e.stopPropagation();
		const menu = popMenu(e.currentTarget, [h('div', 'fx-loading', '<span class="spinner"></span> Looking for Claude Code and Codex chats…')]);
		menu.classList.add('foreign-menu');
		ui.foreignMenu = menu;
		post({ type: 'foreignList' });
	});
	const panelData = { projects: [], worktrees: [], git: null };
	const sagWriterReviews = new Map();
	/** Chat metas now shown in the Projects sidebar, by id — the row menu needs more than the row's dataset. */
	const projectChatById = new Map();
	let auxPoll;
	function togglePanel(kind, show) {
		const panel = kind === 'sidebar' ? el.sidebar : el.auxiliary;
		const button = $(kind === 'sidebar' ? 'btn-sidebar' : 'btn-auxiliary');
		if (show === undefined) show = panel.classList.contains('hidden');
		if (show && innerWidth < 1000) {
			const other = kind === 'sidebar' ? 'auxiliary' : 'sidebar';
			$(other).classList.add('hidden');
			const otherButton = $(other === 'sidebar' ? 'btn-sidebar' : 'btn-auxiliary');
			otherButton.setAttribute('aria-expanded', 'false');
			otherButton.classList.remove('active');
		}
		panel.classList.toggle('hidden', !show);
		button.setAttribute('aria-expanded', String(show));
		button.classList.toggle('active', show);
		if (kind === 'sidebar' && show) { post({ type: 'getProjects' }); renderProjects(); }
		if (kind === 'auxiliary' && show && activeAuxTab() === 'explorer') { ensureFiles(false); renderExplorer(); }
		clearInterval(auxPoll);
		if (!el.auxiliary.classList.contains('hidden')) {
			refreshAuxiliary();
			auxPoll = setInterval(refreshAuxiliary, 5000);
		}
		if (!show) button.focus();
	}
	/** Compact age for sidebar chat rows: now · 5m · 11h · 3d. */
	function relTime(ts) {
		if (!ts) return '';
		const s = (Date.now() - ts) / 1000;
		if (!(s >= 0)) return '';
		if (s < 60) return 'now';
		if (s < 3600) return Math.floor(s / 60) + 'm';
		if (s < 86400) return Math.floor(s / 3600) + 'h';
		return Math.floor(s / 86400) + 'd';
	}
	let projectPanel;
	function getProjectPanel() {
		return projectPanel ||= window.ProjectPanel.create({
			state: () => state, desktop: () => document.body.classList.contains('desktop'),
			view: persisted.projectPanelView, order: persisted.projectChatOrder, persist: patch => B.patchState(patch),
			post, refresh: renderProjects, icon: I, time: relTime, chatMap: projectChatById,
			settings: () => openSettings(), sidebar: () => togglePanel('sidebar', true),
			terminal: () => { togglePanel('auxiliary', true); $('aux-tab-terminal').click(); }
		});
	}
	function renderProjects() {
		getProjectPanel().render(panelData.projects);
	}
	window.__zcRefreshProjects = renderProjects;
	// The Quick window (Ctrl+Alt+Space) hands its prompt here, sent as if typed in the composer.
	// UI freezes: a main-thread task over a second goes to the engine log (at most every 30 s), so
	// jank can be traced from Help → Open logs.
	if (typeof PerformanceObserver === 'function' && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
		let lastStall = 0;
		new PerformanceObserver((list) => {
			const worst = Math.max(...list.getEntries().map((e) => e.duration));
			if (worst < 1000 || Date.now() - lastStall < 30000) return;
			lastStall = Date.now();
			post({ type: 'uiStall', ms: Math.round(worst), messages: state.messages.length, streaming: !!state.isStreaming });
		}).observe({ type: 'longtask', buffered: false });
	}
	/** "What's new" after an update: the release notes once, until dismissed. */
	function showWhatsNew(msg) {
		if (!msg || !Array.isArray(msg.notes) || !msg.notes.length || document.querySelector('.whats-new')) return;
		const card = h('section', 'whats-new', '<header><span class="wn-ico">' + I('sparkle') + '</span><div><b>What’s new</b><small>zer0ne Code ' + esc(String(msg.version || '')) + '</small></div><button type="button" class="icon-btn" data-wn-close aria-label="Dismiss">' + I('close') + '</button></header>' +
			'<ul>' + msg.notes.map((n) => '<li>' + esc(String(n)) + '</li>').join('') + '</ul>' +
			'<footer>' + (msg.more > 0 ? '<small>+' + Number(msg.more) + ' more in the changelog</small>' : '<small></small>') + '<button type="button" class="btn btn-primary btn-sm" data-wn-close>Got it</button></footer>');
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', 'What’s new in zer0ne Code ' + String(msg.version || ''));
		const close = () => {
			post({ type: 'whatsNewSeen', version: String(msg.version || '') });
			card.classList.add('leaving');
			setTimeout(() => card.remove(), 200);
		};
		card.addEventListener('click', (e) => { if (e.target.closest('[data-wn-close]')) close(); });
		card.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
		document.body.appendChild(card);
	}
	window.__zcQuickPrompt = (text) => {
		el.input.value = String(text || '');
		autosize();
		el.input.focus();
		send();
	};
	// ---- Find in chat (Ctrl+F). Matches are highlighted with the CSS Custom Highlight API, so the
	// transcript's own DOM is never rewritten; the search re-runs as messages stream in.
	const finder = { bar: null, ranges: [], at: -1, query: '', observer: null, timer: 0 };
	function findPaint() {
		const count = finder.bar.querySelector('.find-count');
		count.textContent = finder.query ? (finder.ranges.length ? (finder.at + 1) + ' of ' + finder.ranges.length : 'No results') : '';
		finder.bar.classList.toggle('empty', !!finder.query && !finder.ranges.length);
		if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
		CSS.highlights.set('zc-find', new Highlight(...finder.ranges));
		if (finder.ranges[finder.at]) CSS.highlights.set('zc-find-current', new Highlight(finder.ranges[finder.at]));
		else CSS.highlights.delete('zc-find-current');
	}
	function findRun(keepPlace) {
		const q = finder.query.toLocaleLowerCase();
		const ranges = [];
		if (q) {
			const walker = document.createTreeWalker(el.messages, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && n.parentElement.closest('script, style, .find-bar') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
			for (let node = walker.nextNode(); node && ranges.length < 2000; node = walker.nextNode()) {
				const text = node.nodeValue.toLocaleLowerCase();
				for (let i = text.indexOf(q); i >= 0 && ranges.length < 2000; i = text.indexOf(q, i + q.length)) {
					const r = document.createRange();
					r.setStart(node, i);
					r.setEnd(node, i + q.length);
					ranges.push(r);
				}
			}
		}
		finder.ranges = ranges;
		finder.at = ranges.length ? (keepPlace ? Math.min(Math.max(finder.at, 0), ranges.length - 1) : 0) : -1;
		findPaint();
		if (!keepPlace) findReveal();
	}
	function findReveal() {
		const r = finder.ranges[finder.at];
		const target = r && r.startContainer.parentElement;
		if (target) target.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	}
	function findStep(dir) {
		if (!finder.ranges.length) return;
		finder.at = (finder.at + dir + finder.ranges.length) % finder.ranges.length;
		findPaint();
		findReveal();
	}
	function findClose() {
		if (!finder.bar) return;
		finder.observer?.disconnect();
		clearTimeout(finder.timer);
		finder.bar.remove();
		finder.bar = null;
		finder.ranges = [];
		if (typeof CSS !== 'undefined' && CSS.highlights) { CSS.highlights.delete('zc-find'); CSS.highlights.delete('zc-find-current'); }
		el.input.focus();
	}
	function findOpen() {
		if (finder.bar) {
			const input = finder.bar.querySelector('input');
			input.focus();
			input.select();
			return;
		}
		const bar = h('div', 'find-bar', I('search') + '<input type="search" placeholder="Find in chat" aria-label="Find in chat" spellcheck="false"><span class="find-count" aria-live="polite"></span>' +
			'<button type="button" class="icon-btn find-prev" data-find="-1" aria-label="Previous match" title="Previous (Shift+Enter)">' + I('chevronDown') + '</button>' +
			'<button type="button" class="icon-btn" data-find="1" aria-label="Next match" title="Next (Enter)">' + I('chevronDown') + '</button>' +
			'<button type="button" class="icon-btn" data-find="close" aria-label="Close find" title="Close (Esc)">' + I('close') + '</button>');
		bar.setAttribute('role', 'search');
		finder.bar = bar;
		document.body.appendChild(bar);
		const input = bar.querySelector('input');
		input.value = finder.query;
		input.addEventListener('input', () => { finder.query = input.value; findRun(false); });
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
			else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); findClose(); }
		});
		bar.addEventListener('click', (e) => {
			const b = e.target.closest('[data-find]');
			if (!b) return;
			if (b.dataset.find === 'close') findClose();
			else findStep(Number(b.dataset.find));
		});
		// New and streaming messages: search again, keeping the current match.
		finder.observer = new MutationObserver(() => { clearTimeout(finder.timer); finder.timer = setTimeout(() => finder.bar && findRun(true), 250); });
		finder.observer.observe(el.messages, { childList: true, subtree: true, characterData: true });
		if (finder.query) findRun(false);
		input.focus();
		input.select();
	}
	document.addEventListener('keydown', (e) => {
		if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && el.messages) {
			e.preventDefault();
			findOpen();
		}
	});
	function refreshAuxiliary() {
		post({ type: 'getGitStatus' }); post({ type: 'getWorktrees' }); post({ type: 'getAgentRuns' });
		ensureFiles(false);
		renderAuxiliary();
	}

	// ---- Work Details helpers: cards, status pills, friendly empty states
	function auxEmpty(icon, title, hint) {
		return '<div class="aux-empty"><span class="aux-empty-ico">' + I(icon) + '</span><b>' + esc(title) + '</b>' + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</div>';
	}
	/** running / done / failed → one coloured status pill. */
	function auxBadge(status) {
		const s = String(status || '').toLowerCase();
		const kind = /run|stream|work|progress|start|active/.test(s) ? 'run' : /done|complete|success|ok|finish|pass|applied|enabled/.test(s) ? 'ok' : /err|fail|error|reject|cancel|stop/.test(s) ? 'err' : 'idle';
		return '<span class="aux-badge ' + kind + '">' + esc(status || 'idle') + '</span>';
	}
	function auxCard(icon, title, meta, actions, status) {
		return '<div class="aux-item"><span class="aux-ico">' + I(icon) + '</span><div class="aux-main"><b>' + esc(title) + '</b>' + (meta ? '<small>' + meta + '</small>' : '') + (actions ? '<div class="aux-actions">' + actions + '</div>' : '') + '</div>' + (status ? auxBadge(status) : '') + '</div>';
	}
	// Lead-chat anchors are relationships, not synthetic agent runs or metrics.
	let sagSelected = null, sagSession = null;
	const sagTeam = { dialog: null, session: null, timer: null, clock: null };
	function sagDur(ms) {
		if (!Number.isFinite(ms) || ms < 0) return 'Not reported';
		if (ms < 1000) return Math.round(ms) + 'ms';
		const sec = Math.floor(ms / 1000), min = Math.floor(sec / 60);
		return sec < 60 ? sec + 's' : min < 60 ? min + 'm ' + String(sec % 60).padStart(2, '0') + 's' : Math.floor(min / 60) + 'h ' + String(min % 60).padStart(2, '0') + 'm';
	}
	function sagNumber(n, format = fmtTokens) { return Number.isFinite(n) && n >= 0 ? format(n) : 'Not reported'; }
	function sagName(a) { return a.agentName || a.description || a.id; }
	function sagElapsed(a) { const s = a.stats || {}; return a.status === 'running' && Number.isFinite(s.startedAt) ? Math.max(0, Date.now() - s.startedAt) : s.ms; }
	function sagStatus(status) {
		const meta = { reviewing: ['Being checked', 'search'], reviewed: ['Reviewed', 'check'], changes: ['Needs attention', 'alert'], queued: ['Queued', 'clock'], running: ['Active', 'agent'], completed: ['Completed', 'check'], failed: ['Failed', 'alert'], stopped: ['Stopped', 'stop'] };
		const m = meta[status] || ['Not reported', 'info'];
		return '<span class="sag-state ' + (meta[status] ? status : 'idle') + '">' + I(m[1]) + esc(m[0]) + '</span>';
	}
	/** A steering instruction's delivery state, as the engine reported it last. */
	function sagSteerBadge(state) {
		const meta = { read: ['check', 'Read by the agent'], queued: ['clock', 'Queued for its next step'], missed: ['alert', 'Not read — continue the agent to deliver it'] };
		const m = meta[state];
		return m ? '<span class="sag-steer-state ' + state + '">' + I(m[0]) + esc(m[1]) + '</span>' : '';
	}
	// ---- Workflow surface. A run is a phase list, so a row carries identity (avatar),
	// state (glyph) and the work done (tasks) — metrics stay in the detail view.
	function wfInitials(name) {
		const words = String(name || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
		if (!words.length) return '·';
		return (words[0][0] + (words[1] ? words[1][0] : (words[0][1] || ''))).toUpperCase();
	}
	/** A fixed, well-separated palette: hue is identity, not a status. */
	function wfHue(id) {
		const hues = [8, 32, 46, 92, 148, 172, 194, 214, 244, 268, 292, 326];
		let hash = 2166136261;
		for (const ch of String(id || '')) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); }
		return hues[Math.abs(hash) % hues.length];
	}
	function wfAvatar(a, cls) {
		// The hue travels in a data attribute: the page's CSP allows no inline style attributes.
		return '<span class="wf-av' + (cls ? ' ' + cls : '') + '" data-h="' + wfHue(a.id) + '" aria-hidden="true">' + esc(wfInitials(sagName(a))) + '</span>';
	}
	/** A finished worker waiting on the reviewer that is checking it right now. */
	function wfReviewing(a) {
		return a.status === 'completed' && !!a.taskReview && !a.taskReview.verdict && (state.agentRuns || []).some(r => r.id === a.taskReview.reviewerId && r.status === 'running');
	}
	function wfTone(verdict) {
		return verdict === 'pass' ? 'ok' : verdict === 'changes' ? 'warn' : verdict === 'blocked' ? 'err' : '';
	}
	function wfGlyph(a) {
		const title = a.executionState === 'queued' ? 'Waiting for a worker slot' : a.reviewVerdict === 'blocked' ? 'Review blocked' : a.reviewVerdict === 'changes' ? 'Review requested changes' : a.reviewVerdict === 'pass' ? 'Review passed' : a.status === 'running' ? 'Active' : a.status === 'completed' ? 'Completed' : a.status === 'failed' ? 'Failed' : a.status === 'stopped' ? 'Stopped' : 'Not reported';
		if (a.reviewVerdict === 'blocked') return '<span class="wf-gl err" title="' + esc(title) + '">' + I('alert') + '</span>';
		if (a.reviewVerdict === 'changes') return '<span class="wf-gl warn" title="' + esc(title) + '">' + I('alert') + '</span>';
		if (a.executionState === 'queued') return '<span class="wf-gl queued" title="' + esc(title) + '">' + I('clock') + '</span>';
		if (a.status === 'running' || wfReviewing(a)) return '<span class="wf-gl running" title="' + esc(title) + '"><span class="spinner"></span></span>';
		if (a.status === 'completed') return '<span class="wf-gl ok" title="' + esc(title) + '">' + I('check') + '</span>';
		if (a.status === 'failed') return '<span class="wf-gl err" title="' + esc(title) + '">' + I('alert') + '</span>';
		if (a.status === 'stopped') return '<span class="wf-gl idle" title="' + esc(title) + '">' + I('stop') + '</span>';
		return '<span class="wf-gl idle" title="' + esc(title) + '">' + I('info') + '</span>';
	}
	/** Live meters for one run: steps, streamed tokens and elapsed time — 'Not reported' only when the provider sent nothing. */
	function sagLiveStats(a) {
		const s = a.stats || {};
		const calls = a.kind === 'writer' ? s.writerSteps : s.toolUses;
		const parts = [];
		if (Number.isFinite(calls)) parts.push(String(calls) + (calls === 1 ? (a.kind === 'writer' ? ' step' : ' call') : (a.kind === 'writer' ? ' steps' : ' calls')));
		if (s.usageCoverage === 'complete' || s.usageCoverage === 'partial') parts.push('↑' + fmtTokens(s.input ?? 0) + ' ↓' + fmtTokens(s.output ?? 0));
		if (a.status === 'running') parts.push(sagDur(sagElapsed(a)));
		return parts.join(' · ') || (a.executionState === 'queued' ? 'queued' : a.status === 'running' ? 'working' : '—');
	}
	/** Roots before their children; a parent cycle never drops or repeats a row. */
	function wfOrder(runs) {
		const byId = new Map(runs.map(a => [a.id, a])), out = [], seen = new Set();
		const visit = (a, depth) => {
			if (depth > 8 || seen.has(a.id)) return;
			seen.add(a.id);
			out.push(a);
			for (const child of runs) if (child.parentId === a.id) visit(child, depth + 1);
		};
		for (const a of runs) if (!a.parentId || !byId.has(a.parentId)) visit(a, 0);
		for (const a of runs) visit(a, 0);
		return out;
	}
	function wfRow(a) {
		const name = sagName(a), active = a.status === 'running' && a.executionState !== 'queued', review = a.taskReview;
		const note = review ? (review.verdict ? 'Task review: ' + review.verdict : wfReviewing(a) ? 'Being checked by ' + review.reviewerId : 'Task review not reported')
			: a.reviewVerdict ? 'Review: ' + a.reviewVerdict
				: a.executionState === 'queued' ? 'Waiting for a worker slot'
					: active ? a.activity || 'Waiting for activity…'
						: a.error || (a.question ? 'Needs your answer' : { dropped: 'Nothing to do', blocked: 'Blocked — needs a person', failed: 'Reported a failure' }[a.outcome] || (a.artifacts?.length ? a.artifacts.length + ' file change(s)' : a.status === 'completed' ? 'Report ready' : 'Run ended'));
		const pendingSteer = (a.steerReceipts || []).filter(r => r.state === 'queued').length;
		const missedSteer = (a.steerReceipts || []).filter(r => r.state === 'missed').length;
		const steerNote = [missedSteer ? missedSteer + (missedSteer === 1 ? ' instruction was' : ' instructions were') + ' not read'
			: pendingSteer ? pendingSteer + (pendingSteer === 1 ? ' instruction' : ' instructions') + ' queued' : '',
			a.status === 'running' && a.watchdog ? ({ stalled: 'Stalled', looping: 'Repeating itself', drifting: 'May be off task' }[a.watchdog.state] || '') : ''].filter(Boolean).join(' · ');
		return '<div class="wf-item" data-sag-key="' + esc(a.id) + '">' +
			'<button type="button" class="wf-row" data-sag-open="' + esc(a.id) + '" aria-controls="sag-inline-details" aria-label="' + esc('Details for ' + name + ' (' + a.id + ')') + '">' +
			wfAvatar(a) +
			'<span class="wf-row-main"><b>' + esc(name) + '</b><small>' + (a.workflowRole === 'reviewer' ? '<em class="wf-role">reviewer</em>' : '') + esc(note) + (steerNote ? ' · ' + esc(steerNote) : '') + '</small></span>' +
			'<span class="wf-row-meta">' + esc(sagLiveStats(a)) + '</span>' + wfGlyph(a) + '</button>' +
			(a.status === 'running' ? '<button type="button" class="wf-stop" data-aux-stop="' + esc(a.id) + '" aria-label="' + esc('Stop ' + name) + '" title="Stop this agent">' + I('stop') + '</button>' : '') +
			'</div>';
	}
	function wfGroup(label, rows) {
		if (!rows.length) return '';
		return '<div class="wf-group"><span>' + esc(label) + '</span><i aria-hidden="true"></i></div>' + rows.map(wfRow).join('');
	}
	function wfPhase(title, meta, body, tone) {
		return '<section class="wf-phase"><header><i class="wf-pdot" aria-hidden="true"></i><b>' + esc(title) + '</b>' + (meta ? '<span class="wf-count' + (tone ? ' ' + tone : '') + '">' + esc(meta) + '</span>' : '') + '</header>' + body + '</section>';
	}
	function wfModelLabel(spec) {
		const [providerId, modelId] = String(spec || '').split('::');
		const provider = (state.providers || []).find(p => p.id === providerId);
		const model = (provider?.models || []).find(m => m.id === modelId);
		return model?.name || model?.id || modelId || '';
	}
	function sagGraph(runs) {
		const panel = $('aux-content-subagents');
		const width = Math.max(260, panel?.querySelector('.ag-canvas')?.clientWidth || (panel?.clientWidth ? panel.clientWidth - 28 : 320));
		const narrow = width < 520;
		const ordered = wfOrder(runs);
		const limit = wfExpanded ? 12 : 6, selected = ordered.find(a => a.id === sagSelected);
		const important = [...(selected ? [selected] : []), ...ordered.filter(a => a.id !== sagSelected && ['running', 'waiting'].includes(a.status))];
		const visible = new Set(important.slice(0, limit).map(a => a.id));
		for (const agent of ordered) if (visible.size < limit) visible.add(agent.id);
		const agents = ordered.filter(a => visible.has(a.id));
		// Tools and connections come only from recorded calls; the graph never simulates traffic.
		const toolMap = new Map();
		for (const agent of agents) for (const tool of (agent.tools || [])) {
			if (!tool.name) continue;
			const previous = toolMap.get(tool.name);
			if (!previous || (tool.startedAt || 0) >= (previous.call.startedAt || 0)) toolMap.set(tool.name, { name: tool.name, agent, call: tool });
		}
		const tools = [...toolMap.values()].sort((a, b) => (b.call.startedAt || 0) - (a.call.startedAt || 0)).slice(0, 8).sort((a, b) => a.name.localeCompare(b.name));
		const height = runs.length ? Math.max(narrow ? 520 : 480, (narrow ? 430 : 340) + Math.max(0, agents.length - 4) * 32 + tools.length * 14) : 300;
		const cx = width / 2, cy = height / 2;
		const rx = Math.max(70, cx - 48), ry = cy - 66;
		const innerHeight = ry * (narrow ? .53 : .46);
		const leadStatus = state.runState === 'waiting' ? 'waiting' : state.isStreaming || runs.some(a => a.status === 'running') ? 'running' : 'idle';
		const label = a => a.executionState === 'queued' ? 'Queued' : wfReviewing(a) ? 'Being checked' : ({ running: 'Working', completed: 'Done', failed: 'Failed', stopped: 'Stopped', waiting: 'Needs you' }[a.status] || 'Not reported');
		const status = a => a.executionState === 'queued' ? 'queued' : wfReviewing(a) ? 'reviewing' : a.status;
		const callStatus = (agent, call) => agent.status !== 'running' && ['running', 'pending'].includes(call.status) ? 'idle' : call.status;
		const spots = new Map([['lead', { x: cx, y: cy }]]);
		const place = (items, horizontal, vertical, key) => {
			const arc = [{ x: cx, y: cy - vertical, length: 0 }];
			for (let step = 1; step <= 240; step++) {
				const angle = -Math.PI / 2 + 2 * Math.PI * step / 240;
				const x = cx + horizontal * Math.cos(angle), y = cy + vertical * Math.sin(angle), previous = arc[step - 1];
				arc.push({ x, y, length: previous.length + Math.hypot(x - previous.x, y - previous.y) });
			}
			items.forEach((item, index) => {
				const distance = arc.at(-1).length * (index + .5) / items.length;
				const end = arc.findIndex(p => p.length >= distance), p = arc[end - 1], q = arc[end];
				const fraction = (distance - p.length) / (q.length - p.length);
				spots.set(key(item), { x: p.x + (q.x - p.x) * fraction, y: p.y + (q.y - p.y) * fraction });
			});
		};
		place(agents, rx * .67, innerHeight, a => 'agent:' + a.id);
		place(tools, rx, ry, t => 'tool:' + t.name);
		const edge = (from, to, kind, key) => {
			const p = spots.get(from), q = spots.get(to);
			if (!p || !q || from === to) return '';
			const middle = (p.y + q.y) / 2;
			const radius = Math.min(8, Math.abs(p.x - q.x) / 2, Math.abs(p.y - q.y) / 2);
			const sx = Math.sign(q.x - p.x), sy = Math.sign(q.y - p.y);
			const d = radius < 1 ? 'M' + p.x + ' ' + p.y + 'L' + q.x + ' ' + q.y
				: 'M' + p.x + ' ' + p.y + 'V' + (middle - sy * radius) + 'Q' + p.x + ' ' + middle + ' ' + (p.x + sx * radius) + ' ' + middle + 'H' + (q.x - sx * radius) + 'Q' + q.x + ' ' + middle + ' ' + q.x + ' ' + (middle + sy * radius) + 'V' + q.y;
			return '<path class="ag-edge" data-flow="' + esc(kind || 'idle') + '" data-sag-key="edge:' + esc(key) + '" d="' + d + '" pathLength="100"/>';
		};
		let edges = agents.map(a => edge(a.parentId ? 'agent:' + a.parentId : 'lead', 'agent:' + a.id, status(a), 'agent:' + a.id)).join('');
		for (const tool of tools) for (const agent of agents) {
			const calls = (agent.tools || []).filter(t => t.name === tool.name);
			const call = calls.at(-1);
			if (call) edges += edge('agent:' + agent.id, 'tool:' + tool.name, callStatus(agent, call), agent.id + ':' + tool.name);
		}
		const point = (key, content, attributes, cls) => {
			const p = spots.get(key);
			return '<div class="ag-node ' + (cls || '') + '" data-sag-key="graph:' + esc(key) + '" data-ag-x="' + p.x + '" data-ag-y="' + p.y + '" ' + attributes + '><div class="ag-body">' + content + '</div></div>';
		};
		const lead = point('lead', '<span class="ag-disc" aria-hidden="true">' + I('agent') + '</span><span class="ag-label"><b>Orchestrator</b><small>' + (leadStatus === 'waiting' ? 'Needs you' : leadStatus === 'running' ? 'Working' : 'Current chat') + '</small></span>', 'data-status="' + leadStatus + '"', 'ag-lead');
		const nodes = agents.map(a => {
			const active = a.status === 'running';
			const content = '<button type="button" class="ag-disc" data-sag-open="' + esc(a.id) + '" aria-controls="sag-inline-details" aria-expanded="' + (sagSelected === a.id) + '" aria-label="' + esc(sagName(a) + ', ' + label(a) + '. Open task details') + '">' + wfAvatar(a) + '</button>' +
				'<span class="ag-badge" aria-hidden="true">' + I(a.status === 'completed' ? 'check' : a.status === 'failed' ? 'alert' : a.executionState === 'queued' ? 'clock' : 'agent') + '</span>' +
				'<span class="ag-label" aria-hidden="true"><b title="' + esc(sagName(a)) + '">' + esc(sagName(a)) + '</b><small>' + (a.workflowRole === 'reviewer' ? '<em class="wf-role">reviewer</em>' : '') + esc(label(a)) + '</small></span>' +
				(active ? '<button type="button" class="ag-stop" data-aux-stop="' + esc(a.id) + '" aria-label="' + esc('Stop ' + sagName(a)) + '" title="Stop agent">' + I('stop') + '</button>' : '');
			return point('agent:' + a.id, content, 'data-agent="' + esc(a.id) + '" data-status="' + esc(status(a) || 'idle') + '"', sagSelected === a.id ? 'selected' : '');
		}).join('');
		const toolNodes = tools.map(t => {
			const icon = /mcp/i.test(t.name) ? 'plug' : /browse|web|fetch/i.test(t.name) ? 'globe' : /search|grep|glob/i.test(t.name) ? 'search' : /read|file|edit|write/i.test(t.name) ? 'file' : 'terminal';
			return point('tool:' + t.name, '<button type="button" class="ag-disc" data-sag-open="' + esc(t.agent.id) + '" aria-controls="sag-inline-details" aria-label="' + esc(t.name + '. View recorded calls from ' + sagName(t.agent)) + '">' + I(icon) + '</button><span class="ag-label" aria-hidden="true"><b title="' + esc(t.name) + '">' + esc(t.name) + '</b><small>tool</small></span>', 'data-status="' + esc(callStatus(t.agent, t.call) || 'idle') + '"' + (spots.get('tool:' + t.name).y < cy ? ' data-label-above' : ''), 'ag-tool');
		}).join('');
		const knownCosts = runs.filter(a => Number.isFinite(a.stats?.cost) && a.stats.cost >= 0);
		const cost = knownCosts.length ? fmtCost(knownCosts.reduce((n, a) => n + a.stats.cost, 0)) + (knownCosts.length < runs.length ? ' reported' : '') : 'Cost not reported';
		const hidden = ordered.length - agents.length;
		return '<section class="ag' + (width < 340 ? ' ag-compact' : '') + '" aria-label="Agent graph"><header class="ag-head"><span>' + I('agent') + '<b>Agent graph</b></span><small>' + agents.length + '/' + runs.length + ' subagents · ' + tools.length + (toolMap.size > tools.length ? ' recent tools' : ' tools') + '</small></header>' +
			'<div class="ag-canvas" data-ag-height="' + height + '"><svg class="ag-links" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true"><ellipse class="ag-orbit" cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '"/><ellipse class="ag-orbit inner" cx="' + cx + '" cy="' + cy + '" rx="' + rx * .67 + '" ry="' + innerHeight + '"/>' + edges + '</svg>' + lead + nodes + toolNodes + '</div>' +
			'<footer class="ag-foot"><span><i class="ag-dot call"></i>Working</span><span><i class="ag-dot answer"></i>Done</span><span><i class="ag-dot wait"></i>Needs you</span><span><i class="ag-dot error"></i>Failed</span><small>' + esc(cost) + '</small></footer>' +
			(hidden > 0 && wfExpanded ? '<p class="ag-note">Showing 12 agents. All ' + runs.length + ' tasks are listed below.</p>' : '') +
			(hidden > 0 && !wfExpanded ? '<button type="button" class="wf-more" data-wf-more>Show more agents (' + hidden + ')</button>' : wfExpanded && runs.length > 6 ? '<button type="button" class="wf-more" data-wf-more>Show fewer agents</button>' : '') + '</section>';
	}
	function sagGraphPaint(panel) {
		const canvas = panel.querySelector('.ag-canvas');
		if (canvas) canvas.style.height = canvas.dataset.agHeight + 'px';
		for (const node of panel.querySelectorAll('[data-ag-x]')) {
			node.style.left = node.dataset.agX + 'px'; node.style.top = node.dataset.agY + 'px';
		}
		if (panel.sagGraphResize || typeof ResizeObserver === 'undefined') return;
		let width = panel.clientWidth;
		panel.sagGraphResize = new ResizeObserver(() => {
			const next = panel.clientWidth;
			if (next > 0 && Math.abs(next - width) > 4) { width = next; sagTeamRender(); }
		});
		panel.sagGraphResize.observe(panel);
	}
	function sagBoard(runs) {
		const profile = state.subagentWorkflow || {};
		const enabled = profile.enabled === true;
		const workflow = enabled || runs.some(a => a.workflowRole);
		if (!runs.length) {
			return sagGraph([]) + '<div class="wf-empty"><span class="wf-empty-ico">' + I('agent') + '</span><b>' + (enabled ? 'Workflow ready' : 'No workflow running') + '</b><p>' + (enabled ? 'Send a task: the workers start together and the reviewer checks the answer before it is accepted.' : 'Give this chat a team: parallel workers on their own model, then an independent review pass. Start it with <code>/workflow</code>.') + '</p><button type="button" class="btn btn-secondary btn-sm" data-wf-configure>' + I('sliders') + (enabled ? 'Configure' : 'Set up workflow') + '</button></div>';
		}
		const ordered = wfOrder(runs);
		const workers = ordered.filter(a => a.workflowRole !== 'reviewer');
		const reviewers = ordered.filter(a => a.workflowRole === 'reviewer');
		const running = runs.filter(a => a.status === 'running' && a.executionState !== 'queued');
		const queued = runs.filter(a => a.status === 'running' && a.executionState === 'queued');
		const done = workers.filter(a => a.status === 'completed').length;
		const tokens = runs.reduce((n, a) => n + (Number.isFinite(a.stats?.input) && Number.isFinite(a.stats?.output) ? a.stats.input + a.stats.output : 0), 0);
		const shown = wfExpanded ? workers : workers.slice(0, 6);
		const hidden = workers.length - shown.length;
		const groups = [
			[shown.filter(a => a.status === 'running' && a.executionState !== 'queued'), 'running'],
			[shown.filter(a => a.status === 'running' && a.executionState === 'queued'), 'queued'],
			[shown.filter(a => a.status === 'completed'), 'completed'],
			[shown.filter(a => !['running', 'completed'].includes(a.status)), 'ended']
		];
		const more = hidden > 0
			? '<button type="button" class="wf-more" data-wf-more><span class="wf-stack">' + workers.slice(6, 11).map(a => wfAvatar(a, 'sm')).join('') + '</span>' + hidden + ' more</button>'
			: wfExpanded && workers.length > 6 ? '<button type="button" class="wf-more" data-wf-more>Show less</button>' : '';
		const emptyWorkers = '<div class="wf-row ghost"><span class="wf-av ghost" aria-hidden="true">' + I('agent') + '</span><span class="wf-row-main"><b>No workers</b><small>The lead answered alone — enable workers with /workflow</small></span><span class="wf-row-meta">—</span></div>';
		const review = profile.review !== false;
		const phaseOne = wfPhase(workflow ? 'Workers' : 'Agents', workers.length ? done + '/' + workers.length : '', workers.length ? groups.map(([list, label]) => wfGroup(list.length + ' ' + label, list)).join('') + more : emptyWorkers);
		const reviewPhase = reviewers.length
			? wfPhase('Review gate', reviewers[0].reviewVerdict || (reviewers.some(a => a.status === 'running') ? 'checking' : 'pending'), reviewers.map(wfRow).join(''), wfTone(reviewers[0].reviewVerdict))
			: workflow && review ? wfPhase('Review gate', 'pending', '<div class="wf-row ghost"><span class="wf-av ghost" aria-hidden="true">' + I('check') + '</span><span class="wf-row-main"><b>Independent review</b><small>Runs after the workers report</small></span><span class="wf-row-meta">—</span></div>') : '';
		const head = '<div class="wf-head"><div class="wf-head-title"><b>' + (workflow ? 'Workflow' : 'Subagents') + '</b><small>' + (workflow ? 'Orchestrator · ' + workers.length + (workers.length === 1 ? ' worker' : ' workers') : workers.length + (workers.length === 1 ? ' agent' : ' agents')) + '</small></div>' +
			'<div class="wf-head-actions">' +
			'<button type="button" class="wf-act" data-wf-configure title="Configure this workflow">' + I('sliders') + 'Configure</button>' +
			'<button type="button" class="wf-act stop" data-wf-stop title="Stop this run"' + (running.length || state.isStreaming ? '' : ' disabled') + '>' + I('stop') + 'Stop run</button>' +
			'<button type="button" class="wf-act icon" data-sag-expand aria-label="Expand subagent monitor" title="Expand">' + I('expand') + '</button>' +
			'</div></div>';
		const live = running.length ? 'running' : queued.length ? 'queued' : 'idle';
		const status = '<div class="wf-status"><span class="wf-live ' + live + '"><i aria-hidden="true"></i>' + (live === 'running' ? 'Running' : live === 'queued' ? 'Queued' : 'Idle') + '</span>' +
			(enabled ? '<label class="wf-conc" title="Parallel workers">Max concurrency<select data-wf-concurrency aria-label="Maximum parallel workers">' +
				Array.from({ length: 10 }, (_, i) => '<option value="' + (i + 1) + '"' + ((Number(profile.maxConcurrency) || 2) === i + 1 ? ' selected' : '') + '>' + (i + 1) + '</option>').join('') +
				'</select></label>' : '') + '</div>';
		const models = enabled ? '<div class="wf-models">' + I('layers') + '<span>Orchestrator <b>' + esc(wfModelLabel((state.selection?.providerId || '') + '::' + (state.selection?.model || '')) || 'chat model') + '</b></span><span>Workers <b>' + esc(wfModelLabel(profile.workerModel) || 'chat model') + '</b></span>' + (review ? '<span>Check <b>on</b></span>' : '') + '</div>' : '';
		const meta = '<div class="wf-meta"><span>' + (running.length ? running.length + (running.length === 1 ? ' agent working' : ' agents working') : workers.length + (workers.length === 1 ? ' agent' : ' agents')) + '</span><span>' + (workers.length ? done + '/' + workers.length + ' tasks' : 'no worker tasks') + '</span><span>' + fmtTokens(tokens) + ' tokens</span></div>';
		return head + status + models + meta + sagGraph(runs) + '<details class="ag-tasks"><summary>Tasks and controls</summary>' + phaseOne + reviewPhase + '</details>';
	}
    // Preserve task and control nodes as elapsed times and tool activity change.
    function sagPatch(target, html) {
        const template = document.createElement('template'); template.innerHTML = html;
        const patch = (parent, desired) => {
            let cursor = parent.firstChild;
            for (const next of [...desired.childNodes]) {
                const key = next.nodeType === 1 && next.getAttribute('data-sag-key');
                let current = key ? [...parent.children].find(n => n.getAttribute('data-sag-key') === key) : cursor;
                if (current && current.nodeType === 1 && current.hasAttribute('data-sag-key') && !key) current = null;
                if (!current || current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current = next.cloneNode(true); parent.insertBefore(current, cursor); }
                else {
                    if (current !== cursor) parent.insertBefore(current, cursor);
                    if (current.nodeType === 3) { if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue; }
                    else if (current.nodeType === 1) {
                        const preserve = current.matches('textarea[data-sag-steer]') || (current === document.activeElement && current.matches('input,textarea,select'));
                        for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name) && !(current.tagName === 'DETAILS' && attr.name === 'open')) current.removeAttribute(attr.name);
                        for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value && !(preserve && attr.name === 'value')) current.setAttribute(attr.name, attr.value);
                        if (!preserve) patch(current, next);
                    }
                }
                cursor = current.nextSibling;
            }
            while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
        };
        patch(target, template.content);
    }
    let sagDetailTab = 'activity', wfExpanded = false;
    function sagTeamRender() { sagRender(state.agentRuns || []); }
    function sagTeamOpen() {
        togglePanel('auxiliary', true); $('aux-tab-subagents').click();
        sagTeam.session = state.currentSessionId; sagTeamRender();
        post({ type: 'getAgentRuns' }); clearInterval(sagTeam.timer);
        sagTeam.timer = setInterval(() => { if (!document.hidden && $('aux-tab-subagents').classList.contains('active') && !el.auxiliary.classList.contains('hidden')) post({ type: 'getAgentRuns' }); }, 3000);
        clearInterval(sagTeam.clock);
        sagTeam.clock = setInterval(() => { if (!document.hidden && $('aux-tab-subagents')?.classList.contains('active') && !el.auxiliary.classList.contains('hidden')) sagTeamRender(); }, 1000);
    }
    function sagClose() {
		const id = sagSelected;
		sagSelected = null;
		try { localStorage.removeItem('zc.team.selected.' + sagSession); } catch { /* Storage can be unavailable. */ }
		sagTeamRender();
		const target = [...$('aux-content-subagents').querySelectorAll('.ag-node [data-sag-open]')].find(node => node.dataset.sagOpen === id);
		target?.focus({ preventScroll: true }); target?.scrollIntoView?.({ block: 'nearest' });
	}
    function sagOpen(id) {
        sagSelected = id; sagSession = state.currentSessionId; sagDetailTab = 'activity';
        try { localStorage.setItem('zc.team.selected.' + sagSession, id); } catch {}
        sagTeamOpen(); $('sag-inline-details')?.focus();
    }
    function sagInline(a) {
        const tabs = ['activity', 'conversation', 'changes', 'report'];
        const section = text => '<pre class="sag-inline-copy">' + esc(text || 'Not reported') + '</pre>';
        let content;
        if (sagDetailTab === 'conversation') content = '<h4>Task instruction</h4>' + section(a.prompt) + '<h4>Your steering instructions</h4>' + ((a.steering || []).length ? (a.steering || []).map((text, i) => '<div class="sag-steer-item"><p>' + esc(text) + '</p>' + sagSteerBadge((a.steerReceipts || [])[i]?.state) + '</div>').join('') : section('No instructions sent.')) + '<h4>Latest report</h4>' + section(a.report) + '<p class="sag-team-caption">Tool activity is shown separately. Internal model reasoning is not exposed.</p>';
        else if (sagDetailTab === 'report') content = section(a.report || a.error || 'The agent has not returned a report yet.');
        else if (sagDetailTab === 'changes') content = a.kind === 'writer' ? sagWriterChanges(a) : (a.artifacts || []).map(f => '<h4>' + esc(f.path) + '</h4>' + section(f.preview)).join('') + section((a.tools || []).filter(t => /edit|write|patch|merge/.test(t.name)).map(t => t.name + ' · ' + t.status + '\n' + t.args + '\n' + (t.summary || '')).join('\n\n') || 'No editing activity reported. Use Files and Undo for the recorded project diff.');
        else content = sagDetails(a);
        return '<section id="sag-inline-details" data-sag-key="details-' + esc(a.id) + '" tabindex="-1"><header class="sag-inline-bar"><b>' + esc(sagName(a)) + '</b><button class="aux-btn" data-sag-detail-close aria-label="Close task details">' + I('close') + '</button></header><nav class="sag-detail-tabs" aria-label="Task details">' + tabs.map(t => '<button class="aux-btn" data-sag-tab="' + t + '" aria-pressed="' + (sagDetailTab === t) + '">' + t[0].toUpperCase() + t.slice(1) + '</button>').join('') + '</nav><div class="sag-inline-body">' + content + '</div><form data-sag-send="' + esc(a.id) + '"><textarea data-sag-steer maxlength="8000" aria-label="Instruction for this agent" placeholder="Guide the agent’s next step…"' + (a.status !== 'running' ? ' disabled' : '') + '></textarea><button type="submit" class="aux-btn"' + (a.status !== 'running' ? ' disabled' : '') + '>Send instruction</button>' + (a.status === 'running' ? '<button type="button" class="aux-btn danger" data-aux-stop="' + esc(a.id) + '">Stop agent</button>' : a.kind === 'writer' && a.worktree?.path && !['merged','discarded'].includes(a.worktree.status) ? '<button type="button" class="aux-btn" data-writer-review="resume" data-writer-id="' + esc(a.id) + '">Resume task</button>' : '<button type="button" class="aux-btn" data-agent-resume="' + esc(a.id) + '">Continue task</button>') + '</form></section>';
    }
	function sagWriterChanges(a) {
		const w = a.worktree || {}, review = typeof sagWriterReviews !== 'undefined' ? sagWriterReviews.get(a.id) : undefined;
		const available = a.status !== 'running' && w.path && !['merged', 'discarded'].includes(w.status);
		return '<div class="sag-worktree"><b>' + esc(w.branch || 'Worktree pending') + '</b><code>' + esc(w.path || 'No checkout was created. A Git repository with an initial commit is required.') + '</code><small>' + esc(w.status || a.status) + (Number.isFinite(w.files) ? ' · ' + w.files + ' files · +' + (w.added || 0) + ' −' + (w.removed || 0) : '') + '</small>' + (available ? '<button type="button" class="aux-btn" data-writer-review="diff" data-writer-id="' + esc(a.id) + '">View diff</button>' : '') + '</div>' +
			(review ? '<div class="sag-writer-diff"><p>' + review.files.length + ' changed files' + (review.truncated ? ' · Diff too large for in-app approval; review it in the worktree.' : '') + '</p><pre class="sag-inline-copy">' + esc(review.patch || 'No file changes.') + '</pre>' + (!review.truncated && available ? '<div class="aux-actions"><button type="button" class="aux-btn" data-writer-review="apply" data-writer-id="' + esc(a.id) + '">Apply changes</button><button type="button" class="aux-btn danger" data-writer-review="discard" data-writer-id="' + esc(a.id) + '">Discard worktree and changes</button></div>' : '') + '</div>' : '');
	}
	/**
	 * The run card above the composer: state at a glance; every detail stays in
	 * Work Details. Hidden unless this chat has a workflow and something to show.
	 */
	function wfCurrentRuns(runs) {
		const root = state.workflowTaskId || [...runs].reverse().find(run => run.rootTaskId)?.rootTaskId;
		return root ? runs.filter(run => run.rootTaskId === root) : runs;
	}
	/** A workflow run's state in words, and the look its card takes. */
	function wfFlowState(a) {
		if (a.workflowRole === 'reviewer') {
			if (a.status === 'running') return ['running', 'Checking'];
			if (a.reviewVerdict === 'pass') return ['done', 'Passed'];
			if (a.reviewVerdict === 'changes') return ['waiting', 'Changes'];
			if (a.reviewVerdict === 'blocked') return ['failed', 'Blocked'];
		}
		if (a.status === 'running') return a.executionState === 'queued' ? ['queued', 'Queued'] : ['running', 'Working'];
		if (a.status === 'completed') return ['done', 'Done'];
		if (a.status === 'failed') return ['failed', 'Failed'];
		if (a.status === 'stopped') return ['stopped', 'Stopped'];
		return ['idle', 'Waiting'];
	}
	/**
	 * The run card above the composer, as a flow: what you asked and the main agent on the left,
	 * the workers in parallel in the middle, the review on the right, joined where the work is
	 * handed over. Every detail stays in Work Details.
	 */
	function wfCard(runs) {
		const profile = state.subagentWorkflow || {};
		if (profile.enabled !== true) return '';
		runs = wfCurrentRuns(runs);
		if (!runs.length && !state.isStreaming) return '';
		const review = profile.review !== false;
		const workers = runs.filter(a => a.workflowRole !== 'reviewer');
		const reviewers = runs.filter(a => a.workflowRole === 'reviewer');
		const reviewer = reviewers[reviewers.length - 1];
		const verdict = reviewer?.status === 'completed' ? reviewer.reviewVerdict || '' : '';
		const blocked = verdict === 'blocked';
		const failed = workers.some(worker => worker.status === 'failed');
		const stopped = workers.some(worker => worker.status === 'stopped');
		const live = state.isStreaming || runs.some(a => a.status === 'running');
		const asked = String([...(state.messages || [])].reverse().find(m => m.role === 'user')?.content || '').split('\n').find(Boolean) || 'Your task';
		const doing = workers.some(a => a.status === 'running') ? 'Delegating' : workers.length && state.isStreaming ? 'Combining' : state.isStreaming ? 'Planning' : 'Done';
		const chatModel = wfModelLabel((state.selection?.providerId || '') + '::' + (state.selection?.model || '')) || state.selection?.model || 'chat model';
		const glyph = { running: '<i class="wff-pulse" aria-hidden="true"></i>', queued: I('clock'), done: I('check'), waiting: I('alert'), failed: I('alert'), stopped: I('stop'), idle: '<i aria-hidden="true"></i>' };
		const shown = workers.slice(0, 4);
		const items = shown.length ? shown.map((a, i) => {
			const [look, word] = wfFlowState(a);
			const elapsed = sagElapsed(a);
			return '<div class="wff-item" data-sag-key="flow:' + esc(a.id) + '" data-status="' + look + '">' +
				'<span class="wff-cap"><b>' + esc(sagName(a)) + '</b>' + esc(word.toLowerCase()) + '</span>' +
				'<button type="button" class="wff-card" data-status="' + look + '" data-wf-agent="' + esc(a.id) + '" aria-label="' + esc(sagName(a) + ': ' + word + '. Open in Work Details') + '">' +
				'<span class="wff-dot in" aria-hidden="true"></span><span class="wff-dot out" aria-hidden="true"></span>' +
				'<span class="wff-pill"><i aria-hidden="true"></i>Agent ' + (i + 1) + '</span>' +
				'<b class="wff-title" title="' + esc(a.description || sagName(a)) + '">' + esc(a.description || sagName(a)) + '</b>' +
				'<span class="wff-state">' + glyph[look] + esc(word) + (Number.isFinite(elapsed) && elapsed >= 1000 ? ' · ' + esc(sagDur(elapsed)) : '') + '</span></button></div>';
		}).join('') : '<div class="wff-item" data-status="idle"><span class="wff-cap"><b>Workers</b>waiting</span><div class="wff-card ghost"><span class="wff-dot in" aria-hidden="true"></span><span class="wff-dot out" aria-hidden="true"></span><b class="wff-title">' + (state.isStreaming ? 'Waiting for the main agent to delegate' : 'No delegated tasks') + '</b><span class="wff-state">' + esc(wfModelLabel(profile.workerModel) || 'chat model') + '</span></div></div>';
		const more = workers.length > shown.length ? '<button type="button" class="wff-more" data-wf-open-panel>+' + (workers.length - shown.length) + ' more workers</button>' : '';
		const [checkLook, checkWord] = reviewer ? wfFlowState(reviewer) : ['idle', review ? 'Waiting' : 'Off'];
		const outcomes = [['pass', 'Pass'], ['changes', 'Changes'], ['blocked', 'Blocked']];
		const check = review || reviewers.length
			? '<span class="wff-cap"><b>Review</b>' + esc(checkWord.toLowerCase()) + '</span>' +
				'<div class="wff-card wff-check" data-status="' + checkLook + '"' + (reviewer ? ' data-wf-agent="' + esc(reviewer.id) + '" role="button" tabindex="0"' : '') + '><span class="wff-dot in" aria-hidden="true"></span>' +
				'<span class="wff-pill"><i aria-hidden="true"></i>Reviewer</span><b class="wff-title">' + (reviewer ? 'Check the result' : 'Checks after the workers') + '</b>' +
				'<span class="wff-state">' + glyph[checkLook] + esc(checkWord) + ' · ' + esc(wfModelLabel(profile.reviewerModel || profile.workerModel) || 'chat model') + '</span>' +
				'<span class="wff-outcomes" aria-label="Review outcomes">' + outcomes.map(([key, label]) => '<span class="wff-outcome" data-outcome="' + key + '"' + (verdict === key ? ' data-picked aria-current="step"' : '') + '>' + label + '</span>').join('') + '</span></div>'
			: '<span class="wff-cap"><b>Result</b>' + (live ? 'pending' : 'ready') + '</span><div class="wff-card wff-check" data-status="' + (live ? 'idle' : 'done') + '"><span class="wff-dot in" aria-hidden="true"></span><b class="wff-title">' + (live ? 'The main agent combines the reports' : 'Combined by the main agent') + '</b><span class="wff-state">' + glyph[live ? 'idle' : 'done'] + 'No review</span></div>';
		const title = 'Workflow ' + (live ? 'running' : blocked ? 'blocked' : verdict === 'pass' ? 'passed' : verdict === 'changes' ? 'needs changes' : failed ? 'failed' : stopped ? 'stopped' : review ? 'awaiting check' : 'done');
		const running = runs.filter(a => a.status === 'running' && a.executionState !== 'queued').length + (state.isStreaming ? 1 : 0);
		return '<div class="wff' + (live ? ' live' : '') + '">' +
			'<header class="wff-bar"><span class="wff-spark">' + I('workflow') + '</span><span class="wf-card-title wff-title-bar"><b>' + title + '</b></span>' +
			'<span class="wff-summary">' + running + ' running · ' + workers.filter(a => a.status === 'completed').length + '/' + workers.length + ' done</span>' +
			'<span class="wf-card-actions">' +
			'<button type="button" class="wf-act icon" data-wf-configure aria-label="Workflow models" title="Workflow models">' + I('sliders') + '</button>' +
			'<button type="button" class="wf-act icon stop" data-wf-stop aria-label="Stop run" title="Stop run"' + (live ? '' : ' disabled') + '>' + I('stop') + '</button>' +
			'<button type="button" class="wf-act icon" data-wf-open-panel aria-label="Open work details" title="Open work details">' + I('expand') + '</button>' +
			'</span></header>' +
			'<div class="wff-flow">' +
			'<div class="wff-col wff-start"><span class="wff-cap"><b>You asked</b></span><div class="wff-card wff-ask" data-status="done"><span class="wff-dot out" aria-hidden="true"></span><b class="wff-title" title="' + esc(asked) + '">“' + esc(asked.length > 90 ? asked.slice(0, 89) + '…' : asked) + '”</b>' +
			'<span class="wff-lead" data-status="' + (state.isStreaming ? 'running' : 'done') + '">' + I('agent') + '<span><b>Main agent</b> · ' + esc(chatModel) + '</span><em>' + esc(doing) + '</em></span></div></div>' +
			'<div class="wff-col wff-mid' + (shown.length > 1 ? ' many' : '') + '">' + items + more + '</div>' +
			'<div class="wff-col wff-end">' + check + '</div>' +
			'</div><span class="wff-sr" aria-live="polite">' + esc(title) + '</span></div>';
	}
	function renderWorkflowCard() {
		const host = $('wf-card');
		if (!host) return;
		const runs = wfCurrentRuns(state.agentRuns || []);
		const html = wfCard(runs);
		const live = html !== '' && (state.isStreaming || runs.some(a => a.status === 'running'));
		host.classList.toggle('hidden', !html);
		host.classList.toggle('running', live);
		const reviewer = runs.filter(a => a.workflowRole === 'reviewer').at(-1);
		host.classList.toggle('blocked', html !== '' && reviewer?.status === 'completed' && reviewer.reviewVerdict === 'blocked');
		// Elapsed times tick while the run is live.
		clearTimeout(host.wfTick);
		if (live) host.wfTick = setTimeout(renderWorkflowCard, 1000);
		if (host.dataset.html === (html || '')) return;
		host.dataset.html = html || '';
		if (html) sagPatch(host, html); else host.replaceChildren();
	}
	/** `/workflow` and the plus menu: the Workflow menu, by the Workflow chip when it is shown. */
	function openWorkflow() {
		openWorkflowMenu($('btn-workflow') || $('input'));
		return true;
	}
	/** Models a workflow role can use: enabled models that support subagent tools, by provider. */
	function wfModelChoices() {
		const out = [];
		for (const provider of state.providers || []) {
			if (provider.enabled === false || provider.apiFormat === 'acp' || provider.apiFormat === 'vscode-lm') continue;
			for (const m of provider.models || []) {
				if (m.enabled === false || m.tools === false) continue;
				out.push({ value: provider.id + '::' + m.id, name: m.name || m.id, providerId: provider.id, provider: provider.name || provider.id, window: m.contextWindow });
			}
		}
		return out;
	}

	function closeWorkflowMenu(restoreFocus) {
		const menu = document.querySelector('.wfm');
		if (menu) menu.wfClose(restoreFocus);
	}
	/**
	 * The Workflow menu above the composer: the main agent (this chat's model), the workers and
	 * the reviewers, each opening its own list of providers and models; how many workers run at
	 * once; and the switch that turns the workflow on for this chat. Every pick applies at once.
	 */
	function openWorkflowMenu(anchor) {
		closeWorkflowMenu(false);
		const profile = state.subagentWorkflow || {};
		const choices = wfModelChoices();
		const chat = state.selection?.providerId && state.selection?.model ? state.selection.providerId + '::' + state.selection.model : '';
		const fallback = choices.some(c => c.value === chat) ? chat : choices[0]?.value || '';
		const draft = {
			enabled: profile.enabled === true,
			orchestrator: chat || fallback,
			worker: profile.workerModel || fallback,
			// An empty reviewer means no review.
			reviewer: profile.review === false ? '' : profile.reviewerModel || profile.workerModel || chat || fallback,
			limit: Number(profile.maxConcurrency) || 2,
			dispatchOnly: profile.dispatchOnly === true
		};
		/** The roles, in the order they work: id, label, what it does. */
		const ROLES = [
			['orchestrator', 'Main agent', 'Plans the work, delegates it and combines the results. This is the chat’s own model.'],
			['worker', 'Workers', 'Each delegated task runs on this model in its own conversation, several at once.'],
			['reviewer', 'Reviewers', 'A read-only reviewer checks the result before the turn finishes: Pass, Changes or Blocked.']
		];
		const pick = (value) => choices.find(c => c.value === value);
		const menu = document.createElement('section');
		menu.className = 'popover wfm';
		menu.setAttribute('role', 'dialog');
		menu.setAttribute('aria-label', 'Workflow');
		menu.tabIndex = -1;
		let page = null;
		/** The provider sections open on a role's model list. */
		const openProviders = new Set();
		const busy = () => {
			if (!state.isStreaming) return false;
			toast('Wait for the current run to finish before changing the workflow.', 'error');
			return true;
		};
		const save = () => post({ type: 'setSubagentWorkflow', sessionId: state.currentSessionId, profile: { enabled: draft.enabled, workerModel: draft.worker, reviewerModel: draft.reviewer || draft.worker, maxConcurrency: draft.limit, review: !!draft.reviewer, dispatchOnly: draft.dispatchOnly } });
		const full = () => state.mode === 'full', subs = () => state.settings?.subagents !== false;
		const position = () => {
			if (!menu.isConnected || !anchor?.isConnected) return;
			const r = anchor.getBoundingClientRect(), vw = document.documentElement.clientWidth || 1000, vh = document.documentElement.clientHeight || 800;
			const w = menu.offsetWidth, hh = menu.offsetHeight;
			menu.style.left = Math.max(10, Math.min(vw - w - 10, r.right - w)) + 'px';
			const above = r.top - hh - 8;
			menu.style.top = (above >= 10 ? above : Math.max(10, Math.min(vh - hh - 10, r.bottom + 8))) + 'px';
		};
		const mainPage = () => {
			const req = (full() ? '' : '<div class="wfm-req"><span>' + I('alert') + 'Full Access is off</span><button type="button" data-wf-fix="full">Switch</button></div>') +
				(subs() ? '' : '<div class="wfm-req"><span>' + I('alert') + 'Subagents are off</span><button type="button" data-wf-fix="subagents">Turn on</button></div>');
			return '<header class="wfm-head"><span class="wfm-ico">' + I('workflow') + '</span><b>Workflow</b>' +
				'<button type="button" class="wfm-switch" role="switch" data-wf-enabled aria-checked="' + draft.enabled + '" aria-label="Workflow"' + (full() && subs() ? '' : ' disabled') + '><span></span></button></header>' + req +
				'<div class="wfm-rows">' + ROLES.map(([role, label, tip]) => {
					const c = pick(draft[role]);
					const value = role === 'reviewer' && !draft.reviewer ? 'Off' : c ? c.name : draft[role] ? draft[role].split('::').pop() : 'Pick a model';
					return '<button type="button" class="wfm-row" data-wf-pick="' + role + '" data-wf-value="' + esc(draft[role]) + '" aria-haspopup="listbox"><span class="wfm-label">' + label + '<span class="wfm-info" title="' + esc(tip) + '">' + I('info') + '</span></span>' +
						'<span class="wfm-value"><b>' + esc(value) + '</b>' + (c ? '<small>' + esc(c.provider) + '</small>' : '') + '</span>' + I('chevronRight') + '</button>';
				}).join('') +
				'<div class="wfm-row static"><span class="wfm-label">Parallel workers</span><span class="wfm-stepper"><button type="button" data-wf-step="-1" aria-label="Fewer workers">−</button><b data-wf-limit>' + draft.limit + '</b><button type="button" data-wf-step="1" aria-label="More workers">+</button></span></div>' +
				'<div class="wfm-row static"><span class="wfm-label">Main agent only delegates<span class="wfm-info" title="The main agent cannot run commands or edit files, so every task goes to a worker and the chat stays free to answer while they work.">' + I('info') + '</span></span><button type="button" class="wfm-switch" role="switch" data-wf-dispatch aria-checked="' + draft.dispatchOnly + '" aria-label="Main agent only delegates"><span></span></button></div></div>' +
				'<p class="wfm-note">' + (draft.enabled ? 'On for this chat: the main agent ' + (draft.dispatchOnly ? 'hands every task to the workers and does none itself' : 'delegates to the workers') + (draft.reviewer ? ', then a reviewer checks the result.' : '.') + ' Writing agents run in their own Git worktrees.' : 'Off: the chat works alone. Turn it on to delegate.') + '</p>' +
				'<div class="wfm-foot"><button type="button" data-wf-history>' + I('history') + 'Saved runs</button></div>';
		};
		const pickPage = (role) => {
			const [, label] = ROLES.find(([r]) => r === role);
			const groups = new Map();
			for (const c of choices) { if (!groups.has(c.providerId)) groups.set(c.providerId, []); groups.get(c.providerId).push(c); }
			const option = (value, name, meta) => '<button type="button" class="wfm-opt" role="option" data-value="' + esc(value) + '" data-name="' + esc(name.toLowerCase()) + '" aria-selected="' + (draft[role] === value) + '"><span class="wfm-opt-name">' + esc(name) + '</span>' + (meta ? '<span class="wfm-opt-meta">' + esc(meta) + '</span>' : '') + '<span class="wfm-opt-check">' + (draft[role] === value ? I('check') : '') + '</span></button>';
			// Each provider is a category: its badge, name and model count, opening onto its models.
			const section = (providerId, list) => {
				const name = list[0].provider, open = openProviders.has(providerId), holds = list.some(c => c.value === draft[role]);
				return '<div class="wfm-provider" data-provider="' + esc(providerId) + '" data-name="' + esc(name.toLowerCase()) + '"' + (open ? ' data-open' : '') + '>' +
					'<button type="button" class="wfm-prov-head" data-wf-provider="' + esc(providerId) + '" aria-expanded="' + open + '">' +
					'<span class="wf-av wfm-prov-badge" data-h="' + wfHue(providerId) + '" aria-hidden="true">' + esc(wfInitials(name)) + '</span>' +
					'<span class="wfm-prov-name"><b>' + esc(name) + '</b><small>' + list.length + (list.length === 1 ? ' model' : ' models') + (holds ? ' · in use' : '') + '</small></span>' +
					(holds ? '<span class="wfm-prov-dot" aria-hidden="true"></span>' : '') + I('chevronDown') + '</button>' +
					'<div class="wfm-prov-models" role="group" aria-label="' + esc(name) + '">' + list.map(c => option(c.value, c.name, c.window ? fmtTokens(c.window) : '')).join('') + '</div></div>';
			};
			return '<header class="wfm-head"><button type="button" class="wfm-back" data-wf-back aria-label="Back">' + I('back') + '</button><b>' + label + '</b><small class="wfm-head-meta">' + groups.size + (groups.size === 1 ? ' provider' : ' providers') + ' · ' + choices.length + ' models</small></header>' +
				(choices.length > 5 ? '<input type="search" class="wfm-filter" data-wf-filter placeholder="Search providers and models" aria-label="Search providers and models">' : '') +
				'<div class="wfm-list" role="listbox" aria-label="' + label + ' model">' +
				(role === 'reviewer' ? '<div class="wfm-off">' + option('', 'Off', 'No review — the main agent checks its own work') + '</div>' : '') +
				[...groups].map(([providerId, list]) => section(providerId, list)).join('') +
				(choices.length ? '' : '<p class="wfm-empty">No model supports subagent tools. Add one in Providers & models.</p>') + '</div>';
		};
		const paint = () => {
			menu.innerHTML = page ? pickPage(page) : mainPage();
			menu.classList.toggle('picking', !!page);
			position();
		};
		// The Workflow chip toggles the menu itself.
		const outside = (e) => { if (!menu.contains(e.target) && !anchor?.contains(e.target) && !e.target.closest?.('#btn-workflow')) close(false); };
		const close = (restoreFocus) => {
			document.removeEventListener('pointerdown', outside, true);
			if (typeof window !== 'undefined') window.removeEventListener('resize', position);
			menu.remove();
			anchor?.setAttribute('aria-expanded', 'false');
			if (restoreFocus) anchor?.focus();
		};
		menu.wfClose = close;
		menu.addEventListener('click', (e) => {
			const t = e.target && typeof e.target.closest === 'function' ? e.target : null;
			if (!t) return;
			let n;
			if (t.closest('[data-wf-history]')) { close(false); window.WorkflowHistory?.open(); return; }
			if ((n = t.closest('[data-wf-pick]'))) {
				page = n.dataset.wfPick;
				// The list opens on the provider of the current pick, or the first one.
				openProviders.clear();
				openProviders.add((choices.find(c => c.value === draft[page]) || choices[0])?.providerId);
				paint(); (menu.querySelector('[data-wf-filter]') || menu.querySelector('.wfm-opt[aria-selected="true"]') || menu.querySelector('.wfm-opt'))?.focus(); return; }
			if (t.closest('[data-wf-back]')) { const role = page; page = null; paint(); menu.querySelector('[data-wf-pick="' + role + '"]')?.focus(); return; }
			if ((n = t.closest('[data-wf-provider]'))) {
				const id = n.dataset.wfProvider, open = !openProviders.has(id);
				if (open) openProviders.add(id); else openProviders.delete(id);
				n.closest('.wfm-provider').toggleAttribute('data-open', open);
				n.setAttribute('aria-expanded', String(open));
				position();
				return;
			}
			if ((n = t.closest('.wfm-opt'))) {
				if (busy()) return;
				const role = page, value = n.dataset.value;
				draft[role] = value;
				if (role === 'orchestrator') {
					// The main agent is the chat's own model.
					const split = value.indexOf('::');
					post({ type: 'selectModel', providerId: value.slice(0, split), model: value.slice(split + 2), sessionId: state.currentSessionId });
				} else save();
				page = null; paint();
				menu.querySelector('[data-wf-pick="' + role + '"]')?.focus();
				return;
			}
			if (t.closest('[data-wf-dispatch]')) {
				if (busy()) return;
				draft.dispatchOnly = !draft.dispatchOnly;
				save(); paint();
				return;
			}
			if (t.closest('[data-wf-enabled]')) {
				if (busy()) return;
				draft.enabled = !draft.enabled;
				save(); paint();
				toast(draft.enabled ? 'Workflow on — send your task.' : 'Workflow off for this chat.', draft.enabled ? 'ok' : '');
				return;
			}
			if ((n = t.closest('[data-wf-step]'))) {
				const next = Math.min(10, Math.max(1, draft.limit + Number(n.dataset.wfStep)));
				if (next === draft.limit) return;
				draft.limit = next;
				if (state.isStreaming && draft.enabled) post({ type: 'setWorkflowConcurrency', sessionId: state.currentSessionId, limit: next });
				else save();
				menu.querySelector('[data-wf-limit]').textContent = String(next);
				return;
			}
			if ((n = t.closest('[data-wf-fix]'))) {
				if (n.dataset.wfFix === 'full') { post({ type: 'setMode', mode: 'full' }); state.mode = 'full'; }
				else { post({ type: 'updateSettings', patch: { subagents: true } }); state.settings = { ...state.settings, subagents: true }; }
				paint();
			}
		});
		menu.addEventListener('input', (e) => {
			if (!e.target.matches?.('[data-wf-filter]')) return;
			const q = e.target.value.trim().toLowerCase();
			// A search opens every provider with a match; clearing it restores the sections you opened.
			for (const group of menu.querySelectorAll('.wfm-provider')) {
				const groupHit = !!q && group.dataset.name.includes(q);
				let any = false;
				for (const opt of group.querySelectorAll('.wfm-opt')) {
					const hit = !q || groupHit || opt.dataset.name.includes(q);
					opt.hidden = !hit; any = any || hit;
				}
				group.hidden = !any;
				const open = q ? any : openProviders.has(group.dataset.provider);
				group.toggleAttribute('data-open', open);
				group.querySelector('[data-wf-provider]').setAttribute('aria-expanded', String(open));
			}
			const off = menu.querySelector('.wfm-off');
			if (off) off.hidden = !!q && !'off no review'.includes(q);
			position();
		});
		menu.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.preventDefault(); e.stopPropagation();
				if (page) { const role = page; page = null; paint(); menu.querySelector('[data-wf-pick="' + role + '"]')?.focus(); }
				else close(true);
				return;
			}
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			const items = [...menu.querySelectorAll(page ? '.wfm-off:not([hidden]) .wfm-opt, .wfm-provider:not([hidden]) .wfm-prov-head, .wfm-provider[data-open]:not([hidden]) .wfm-opt:not([hidden])' : '.wfm-row:not(.static), [data-wf-enabled]')];
			if (!items.length) return;
			e.preventDefault();
			const at = items.indexOf(document.activeElement);
			(items[at + (e.key === 'ArrowDown' ? 1 : -1)] || items[e.key === 'ArrowDown' ? 0 : items.length - 1]).focus();
		});
		document.body.appendChild(menu);
		anchor?.setAttribute('aria-expanded', 'true');
		paint();
		document.addEventListener('pointerdown', outside, true);
		if (typeof window !== 'undefined') window.addEventListener('resize', position);
		menu.querySelector('[data-wf-pick]')?.focus();
		return menu;
	}
    /**
     * Work Details → Browser: a small browser window. The address bar and reload, the latest
     * snapshot in a framed viewport (or how to get one), the page title and time, then the
     * agent's browser activity, newest first.
     */
    function browserPaneHtml(b) {
        const p = b.preview;
        const url = p ? p.url || '' : '';
        const host = (() => { try { return new URL(url).host; } catch { return url; } })();
        const secure = /^https:/.test(url), local = /^http:\/\/(localhost|127\.|\[::1\])/.test(url);
        const shot = p && p.thumbnail && p.thumbnail.startsWith('data:image/jpeg;base64,') ? p.thumbnail : '';
        const state = b.active ? ['live', 'Connected'] : b.found ? ['idle', 'Ready'] : ['off', 'Not set up'];
        const verb = (line) => /navigat|open|goto/i.test(line) ? 'globe' : /click|press|type|select|hover/i.test(line) ? 'zap' : /snapshot|screenshot/i.test(line) ? 'image' : /console|evaluate|script/i.test(line) ? 'terminal' : /network|request/i.test(line) ? 'activity' : 'chevronRight';
        const activity = (b.activity || []).slice(-30).reverse();
        return '<div class="bw">' +
            '<div class="bw-head"><div><b>Browser</b><small class="bw-state ' + state[0] + '"><i></i>' + state[1] + '</small></div><button class="aux-btn" data-browser-preview title="Take a fresh snapshot or reconnect">' + I('refresh') + '<span>Reload</span></button></div>' +
            '<div class="bw-window">' +
            '<div class="bw-bar"><span class="bw-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="bw-url" title="' + esc(url) + '">' + I(secure ? 'lock' : local ? 'laptop' : 'globe') + '<span>' + (url ? '<b>' + esc(host) + '</b>' + esc(url.slice(url.indexOf(host) + host.length)) : 'No page open') + '</span></span></div>' +
            '<div class="bw-view">' + (shot
                ? '<img alt="Latest browser snapshot" src="' + esc(shot) + '" data-zoom="' + esc(shot) + '" data-caption="' + esc(url) + '">'
                : '<div class="bw-empty"><span class="bw-empty-ico">' + I('globe') + '</span><b>' + (p ? 'No snapshot for this page' : 'Nothing opened yet') + '</b><p>' + (b.found ? 'Ask the agent to open or test a page and the latest view appears here.' : 'Turn on the Browser agent in Settings, then ask the agent to browse.') + '</p>' + (b.found ? '' : '<button class="aux-btn" data-open-settings="browser">' + I('gear') + '<span>Browser settings</span></button>') + '</div>') +
            '</div>' +
            (p ? '<div class="bw-meta"><span class="bw-title">' + esc(p.title || host || 'Untitled page') + '</span>' + (p.at ? '<time>' + esc(new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) + '</time>' : '') + '</div>' : '') +
            '</div>' +
            (activity.length ? '<div class="bw-log-head">Activity<span>' + (b.activity || []).length + '</span></div><ol class="bw-log">' + activity.map((line) => '<li>' + I(verb(line)) + '<span title="' + esc(line) + '">' + esc(line) + '</span></li>').join('') + '</ol>' : '') +
            '</div>';
    }
    function sagRender(runs) {
        const browserPanel = $('aux-content-browser');
        if (browserPanel) sagPatch(browserPanel, browserPaneHtml(state.browser || {}));
        if (sagSession !== state.currentSessionId) {
			if (typeof sagWriterReviews !== 'undefined') sagWriterReviews.clear();
            sagSession = state.currentSessionId; wfExpanded = false;
            try { sagSelected = localStorage.getItem('zc.team.selected.' + sagSession); } catch { sagSelected = null; }
        }
        const panel = $('aux-content-subagents'), selected = runs.find(a => a.id === sagSelected);
        sagPatch(panel, sagBoard(runs) + (selected ? sagInline(selected) : ''));
		sagGraphPaint(panel);
        renderWorkflowCard();
    }
    el.auxiliary.addEventListener('click', e => {
		const writer = e.target.closest('[data-writer-review]');
		if (writer) { const id = writer.dataset.writerId; post({ type: 'writerReview', sessionId: state.currentSessionId, id, action: writer.dataset.writerReview, reviewId: sagWriterReviews.get(id)?.reviewId }); return; }
		const resume = e.target.closest('[data-agent-resume]');
		if (resume) { post({ type: 'resumeAgent', sessionId: state.currentSessionId, id: resume.dataset.agentResume }); return; }
        if (e.target.closest('[data-browser-preview]')) post({ type: 'browserPreview' });
        const zoom = e.target.closest('.bw-view [data-zoom]'); if (zoom) imageViewer.open(zoom.dataset.zoom, zoom.dataset.caption || '', zoom);
        const settingsLink = e.target.closest('.bw [data-open-settings]'); if (settingsLink) openSettings(settingsLink.dataset.openSettings);
		if (e.target.closest('[data-sag-detail-close]')) sagClose();
        const tab = e.target.closest('[data-sag-tab]'); if (tab) { sagDetailTab = tab.dataset.sagTab; sagTeamRender(); }
        if (e.target.closest('[data-sag-expand]')) { el.auxiliary.classList.toggle('sag-expanded'); }
        if (e.target.closest('[data-sag-team-close]')) el.input?.focus();
    });
    el.auxiliary.addEventListener('submit', e => {
        const form = e.target.closest('[data-sag-send]'); if (!form) return; e.preventDefault();
        const input = form.querySelector('textarea'), message = input.value.trim(); if (!message) return;
        post({ type: 'sendAgentMessage', sessionId: state.currentSessionId, id: form.dataset.sagSend, message }); input.value = '';
    });
	el.auxiliary.addEventListener('click', e => {
		const node = e.target.closest('[data-sag-open]');
		if (node) { sagOpen(node.dataset.sagOpen, node); return; }
		const stop = e.target.closest('[data-aux-stop]');
		if (stop) post({ type: 'stopAgent', id: stop.dataset.auxStop });
	});
	el.auxiliary.addEventListener('click', e => {
		const configure = e.target.closest('[data-wf-configure]');
		if (configure) return openWorkflowMenu($('btn-workflow') || configure);
		if (e.target.closest('[data-wf-stop]')) return post({ type: 'stop' });
		if (e.target.closest('[data-wf-more]')) { wfExpanded = !wfExpanded; sagTeamRender(); return; }
	});
	el.auxiliary.addEventListener('change', e => {
		const select = e.target.closest('[data-wf-concurrency]');
		if (select) post({ type: 'setWorkflowConcurrency', sessionId: state.currentSessionId, limit: Number(select.value) });
	});
	const wfCardHost = $('wf-card');
	if (wfCardHost) wfCardHost.addEventListener('click', e => {
		const configure = e.target.closest('[data-wf-configure]');
		if (configure) return openWorkflowMenu(configure);
		if (e.target.closest('[data-wf-stop]')) return post({ type: 'stop' });
		if (e.target.closest('[data-wf-open-panel]')) return sagTeamOpen();
		const block = e.target.closest('[data-wf-agent]');
		if (block) return sagOpen(block.dataset.wfAgent);
	});
	wfCardHost?.addEventListener('keydown', e => {
		const card = e.target.closest('[data-wf-agent][role="button"]');
		if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sagOpen(card.dataset.wfAgent); }
	});
	/**
	 * The Workflow chip beside Stats: a quiet label while off; on, an accent pill with a status
	 * dot that pulses while the workflow runs. The team it would use is in the tooltip.
	 */
	function renderWorkflowChip() {
		const chip = $('btn-workflow');
		if (!chip) return;
		const profile = state.subagentWorkflow || {};
		const on = profile.enabled === true;
		chip.setAttribute('aria-checked', String(on));
		chip.classList.toggle('on', on);
		chip.classList.toggle('live', on && !!state.isStreaming);
		const team = 'up to ' + (Number(profile.maxConcurrency) || 2) + ' workers at once' + (profile.review === false ? ', no review' : ', then a review');
		chip.title = on ? 'Workflow on for this chat: ' + team + '. Click to turn it off.' : 'Workflow off: this chat works alone. Click to give it a team.';
	}
	$('btn-workflow')?.addEventListener('click', () => {
		const profile = state.subagentWorkflow || {};
		if (state.isStreaming) { toast('Wait for the current run to finish before changing the workflow.', 'error'); return; }
		if (profile.enabled === true) {
			closeWorkflowMenu(false);
			post({ type: 'setSubagentWorkflow', sessionId: state.currentSessionId, profile: { ...profile, enabled: false } });
			toast('Workflow off for this chat.');
			return;
		}
		// Turning it on shows who does what; it starts at once when the chat has the access a run needs.
		const menu = openWorkflowMenu($('btn-workflow'));
		menu.querySelector('[data-wf-enabled]:not(:disabled)')?.click();
	});
	const sagMotionRest = () => document.body.classList.toggle('sag-motion-rest', document.hidden || !document.hasFocus());
	window.addEventListener('focus', sagMotionRest); window.addEventListener('blur', sagMotionRest); document.addEventListener('visibilitychange', sagMotionRest); sagMotionRest();
	function sagDetails(a) {
		const s = a.stats || {};
		const text = value => value === undefined || value === null || value === '' ? 'Not reported' : String(value);
		const row = (label, value) => '<div><dt>' + esc(label) + '</dt><dd>' + esc(text(value)) + '</dd></div>';
		const date = value => Number.isFinite(value) ? new Date(value).toLocaleString() : 'Not reported';
		const block = (label, value) => '<section class="sag-detail-section"><h3>' + esc(label) + '</h3><pre>' + esc(text(value)) + '</pre></section>';
		const tools = a.tools || [];
		return '<div class="sag-detail-heading"><h2 id="sag-dialog-title">' + esc(sagName(a)) + '</h2>' + sagStatus(a.status) + '</div>' +
			'<p id="sag-dialog-description" class="sag-detail-hint">Live run details. Missing information is marked Not reported.</p><dl class="sag-detail-grid">' +
			row('Agent name', a.agentName) + row('ID', a.id) + row('Kind', a.kind) + row('Parent agent', a.parentId) + row('Parent chat', a.parentSessionId) + row('Provider', a.providerName) + row('Provider ID', a.providerId) + row('Model', s.model) + row('Mode', a.background ? 'Background' : 'Foreground') +
			row('Workflow role', a.workflowRole) + row('Execution', a.executionState) + row('Review verdict', a.reviewVerdict) + (a.watchdog ? row('Watchdog', a.watchdog.state + ': ' + a.watchdog.reason) : '') + (a.outcome ? row('Outcome', a.outcome) : '') + (a.question ? row('Question for you', a.question) : '') +
			row('Verification', verificationLabel(a.verification)) + row('Allowed tools', a.allowedTools?.join(', ')) +
			(a.kind === 'writer' ? row('Branch', a.worktree?.branch) + row('Worktree folder', a.worktree?.path) + row('Changes', a.worktree?.files === undefined ? undefined : `${a.worktree.files} files, +${a.worktree.added || 0} −${a.worktree.removed || 0}`) + row('Recovery', a.worktree?.recovered ? 'Restored after restart; resume explicitly.' : undefined) : '') +
			row('Started', date(s.startedAt)) + row('Ended', a.status === 'running' ? 'Still running' : date(a.endedAt)) + row('Elapsed', sagDur(sagElapsed(a))) + row('Last activity', date(a.lastActivityAt)) +
			row('Input tokens', sagNumber(s.input, String)) + row('Output tokens', sagNumber(s.output, String)) + row('Cached tokens', sagNumber(s.cached, String)) + row('Usage coverage', s.usageCoverage === 'not-reported' ? 'Not reported' : s.usageCoverage) + row('Est. cost', sagNumber(s.cost, fmtCost)) + row('Turns', sagNumber(s.turns, String)) + row('Tool calls', sagNumber(s.toolUses, String)) + (a.kind === 'writer' ? row('Writer steps', sagNumber(s.writerSteps, String)) : '') + '</dl>' +
			block('Task', a.description) + block('Prompt', a.prompt) + block('Current / last activity', a.activity) + block('Report', a.report) + block('Error', a.error) +
			'<section class="sag-detail-section"><h3>Recent tools</h3><p class="sag-detail-hint">Up to 100 recent calls; the agent keeps its conversation for continuation.</p>' + (tools.length ? '<ol class="sag-tool-list">' + tools.map(tool => '<li><div><b>' + esc(tool.name) + '</b>' + sagStatus(tool.status) + '</div><small>' + esc(tool.id) + ' · ' + esc(date(tool.startedAt)) + ' · ' + esc(tool.endedAt ? sagDur(tool.endedAt - tool.startedAt) : 'In progress') + '</small><pre>' + esc(tool.args || 'Arguments not reported') + '</pre><pre>' + esc(tool.summary || 'Result not reported') + '</pre></li>').join('') + '</ol>' : '<p>Not reported</p>') + '</section>';
	}
	function auxNote(text) {
		return '<p class="aux-note">' + I('info') + '<span>' + esc(text) + '</span></p>';
	}
	/** Worktree paths: home-folders collapsed to ~ so long repo paths stay readable. */
	function shortPath(p) {
		const s = String(p || '');
		const home = (navigator.userAgent.match(/Windows/i) ? s.replace(/^([A-Za-z]):\\Users\\([^\\]+)/i, '$1:\\Users\\…') : s.replace(/^\/(?:home|Users)\/[^/]+/, '~'));
		return home.length > 46 ? '…' + home.slice(-45) : home;
	}
	function activeAuxTab() {
		const tab = el.auxiliary.querySelector('.auxiliary-tab.active');
		return tab ? tab.dataset.tab : '';
	}
	/** Tab badges: only counts that mean something, hidden at zero. */
	function updateAuxCounts() {
		const set = (name, n) => {
			for (const b of el.auxiliary.querySelectorAll('[data-aux-count="' + name + '"]')) {
				b.textContent = n > 99 ? '99+' : String(n || '');
				b.classList.toggle('hidden', !n);
			}
		};
		const runs = state.agentRuns || [];
		set('files', (panelData.git?.changes || []).length);
		set('subagents', runs.length);
		set('worktrees', (panelData.worktrees || []).length);
		set('tasks', panelData.jobUnread + (state.queue || []).length);
		set('uploads', (state.attachments || []).length);
	}

	function auxRequestDiff(path) {
		if (!document.body.classList.contains('desktop')) { post({ type: 'gitOpenDiff', path }); return; }
		panelData.diff = { path, loading: true };
		post({ type: 'gitOpenDiff', path, inPage: true });
		renderAuxiliary();
	}
	const repositoryPanels = window.ChatRepository.create({ I, esc, basename, fileBadge, shortPath });
	function auxWorktreeEntry() {
		panelData.worktreeEntry = true;
		togglePanel('auxiliary', true);
		$('aux-tab-worktrees').click();
		renderAuxiliary();
		$('aux-content-worktrees').querySelector('[data-aux-worktree-task]')?.focus();
	}
	function renderAuxiliary() {
		const taskInput = $('aux-content-worktrees').querySelector('[data-aux-worktree-task]');
		const taskFocus = taskInput && document.activeElement === taskInput;
		const taskSelection = taskFocus ? [taskInput.selectionStart, taskInput.selectionEnd] : null;
		$('aux-content-files').innerHTML = repositoryPanels.changes(panelData.git, panelData.diff);
		panelData.worktreeBusy = !!state.isStreaming || (state.agentRuns || []).some(a => a.status === 'running');
		$('aux-content-worktrees').innerHTML = repositoryPanels.worktrees(panelData, document.body.classList.contains('desktop'));

		if (taskFocus && panelData.worktreeEntry) {
			const nextInput = $('aux-content-worktrees').querySelector('[data-aux-worktree-task]');
			nextInput?.focus();
			if (nextInput?.setSelectionRange && taskSelection.every(Number.isInteger)) nextInput.setSelectionRange(...taskSelection);
		}

		// ---- Subagents: an agent-monitor board — live cards with tokens, tools, cost, time.
		const runs = state.agentRuns || [];
		sagRender(runs);

		// ---- Uploads
		const uploads = state.attachments || [];
		$('aux-content-uploads').innerHTML = auxNote('Files waiting to be sent with your next message.') +
			(uploads.length ? uploads.map((a) => auxCard(String(a.kind).includes('image') ? 'image' : 'file', a.name,
				'<span class="aux-chip">' + esc(a.kind || 'file') + '</span>',
				'<button class="aux-btn danger" data-aux-remove="' + esc(a.id) + '">' + I('trash') + 'Remove</button>')).join('')
				: auxEmpty('paperclip', 'No pending uploads', 'Attach files with the + button next to the message box.'));

		updateAuxCounts();
	}

	// ---- File explorer tab: the workspace tree, with the agent's edit marks
	const auxFiles = { filter: '', editedOnly: false, loading: false, open: new Set(), preview: null, max: false };
	const documentViews = new Map(Object.entries(persisted.documentViews || {}));
	function saveDocumentView() {
		if (!state.currentSessionId) return;
		const scroll = $('aux-explorer-preview')?.querySelector('.fsp-scroll');
		documentViews.set(state.currentSessionId, { filter: auxFiles.filter, editedOnly: auxFiles.editedOnly, open: [...auxFiles.open], preview: auxFiles.preview ? { path: auxFiles.preview.path, line: auxFiles.preview.line, scrollTop: auxFiles.preview.scrollTop ?? scroll?.scrollTop ?? 0 } : null });
		B.patchState({ documentViews: Object.fromEntries(documentViews) });
	}
	function switchDocumentSession(id) {
		saveDocumentView();
		auxMaxClose();
		const saved = documentViews.get(id);
		auxFiles.filter = typeof saved?.filter === 'string' ? saved.filter : '';
		auxFiles.editedOnly = saved?.editedOnly === true;
		auxFiles.open = new Set(Array.isArray(saved?.open) ? saved.open : []);
		auxFiles.preview = saved?.preview?.path ? { ...saved.preview, loading: true } : null;
		$('aux-explorer-filter').value = auxFiles.filter;
		fsUi.preview = null;
		fsRenderPreview();
		fsLayers();
		if (auxFiles.preview) post({ type: 'previewFile', path: auxFiles.preview.path, sessionId: id });
	}
	window.addEventListener('pagehide', saveDocumentView);
	/** Ask the engine for the workspace files once open (throttled; force on refresh). */
	function ensureFiles(force) {
		if (force || (!ui.files.length && Date.now() - ui.filesAt > 30000)) {
			ui.filesAt = Date.now();
			auxFiles.loading = true;
			renderExplorer();
			post({ type: 'getFiles', refresh: !!force });
		}
	}
	/** The preview layout follows both the open file and the visible tab. */
	function syncAuxPreview() {
		const on = !!auxFiles.preview && activeAuxTab() === 'explorer';
		$('auxiliary-content').classList.toggle('aux-previewing', on);
		$('aux-content-explorer').classList.toggle('aux-previewing', on);
	}
	/** Open a workspace file in the panel's own viewer (desktop) or the editor (VS Code). */
	function auxOpenPreview(rawPath, line) {
		if (!rawPath) return;
		let path = String(rawPath).trim();
		let targetLine = line ? Number(line) : undefined;
		const m = path.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/);
		if (m) {
			path = m[1];
			if (!targetLine) targetLine = Number(m[2] || m[3]);
		}
		if (!path.includes('/') && !path.includes('\\') && Array.isArray(ui.files) && ui.files.length) {
			if (!ui.files.includes(path)) {
				const candidates = ui.files.filter((f) => f.endsWith('/' + path) || f === path);
				if (candidates.length === 1) path = candidates[0];
			}
		}
		if (!document.body.classList.contains('desktop')) {
			post({ type: 'openFile', path, line: targetLine });
			return;
		}
		togglePanel('auxiliary', true);
		const tab = $('aux-tab-explorer');
		if (tab && !tab.classList.contains('active')) tab.click();
		auxFiles.preview = { path, line: targetLine, loading: true };
		post({ type: 'previewFile', path, sessionId: state.currentSessionId });
		renderExplorer();
		saveDocumentView();
	}
	function explorerFileIcon(path) {
		const name = basename(path).toLowerCase(), ext = name.split('.').pop();
		const types = { ts: ['ts', 'TS'], tsx: ['ts', 'TSX'], js: ['js', 'JS'], jsx: ['js', 'JSX'], mjs: ['js', 'JS'], cjs: ['js', 'JS'], json: ['data', '{}'], yaml: ['data', 'YML'], yml: ['data', 'YML'], toml: ['data', 'TML'], md: ['doc', 'MD'], mdx: ['doc', 'MDX'], txt: ['doc', 'TXT'], css: ['style', '#'], scss: ['style', '#'], html: ['markup', '<>'], vue: ['markup', 'V'], svelte: ['markup', 'S'], py: ['code', 'PY'], rs: ['code', 'RS'], go: ['code', 'GO'], cs: ['code', 'C#'], sh: ['shell', '>_'], ps1: ['shell', 'PS'], svg: ['image', 'SVG'], png: ['image', 'IMG'], jpg: ['image', 'IMG'], webp: ['image', 'IMG'] };
		const type = name === '.env' || name.startsWith('.env.') ? ['data', 'ENV'] : types[ext];
		return type ? '<span class="explorer-file-icon" data-kind="' + type[0] + '" aria-hidden="true">' + esc(type[1]) + '</span>' : '<span class="explorer-file-icon" data-kind="file" aria-hidden="true">' + I('file') + '</span>';
	}
	function explorerActivity(marks = fsMarks()) {
		return JSON.stringify([[...marks.edited].sort(), [...marks.read].sort()]);
	}
	function renderExplorer() {
		const tree = $('aux-explorer-tree');
		if (!tree) return;
		const focused = tree.contains(document.activeElement) ? document.activeElement : null;
		const focusPath = focused?.dataset.auxTreeDir ?? focused?.dataset.auxOpenFile;
		const scrollTop = tree.scrollTop;
		syncAuxPreview();
		const p = auxFiles.preview;
		if (p) renderAuxPreview(p);
		else $('aux-explorer-preview').replaceChildren();
		const files = ui.files || [], marks = fsMarks();
		auxFiles.activity = explorerActivity(marks);
		const q = auxFiles.filter.trim().toLowerCase();
		const hits = files.filter(path => (!auxFiles.editedOnly || marks.edited.has(path)) && (!q || path.toLowerCase().includes(q)));
		const filtered = !!q || auxFiles.editedOnly, visible = filtered ? hits.slice(0, 300) : files;
		const root = $('aux-explorer-root');
		if (root) { root.textContent = state.workspace?.name || 'Project files'; root.title = state.workspace?.path || root.textContent; }
		$('aux-explorer-clear').hidden = !auxFiles.filter;
		const refresh = $('aux-explorer-refresh');
		refresh.classList.toggle('loading', auxFiles.loading);
		refresh.setAttribute('aria-busy', String(auxFiles.loading));
		for (const button of $('aux-content-explorer').querySelectorAll('[data-explorer-scope]')) button.setAttribute('aria-pressed', String(auxFiles.editedOnly === (button.dataset.explorerScope === 'edited')));
		$('aux-explorer-count').textContent = auxFiles.loading ? 'Refreshing…' : (filtered && hits.length > visible.length ? visible.length + ' of ' + hits.length : hits.length) + (hits.length === 1 ? ' file' : ' files');
		tree.setAttribute('aria-busy', String(auxFiles.loading));
		const mark = path => marks.edited.has(path) ? '<span class="explorer-activity edited" title="Edited in this chat" aria-label="Edited in this chat">M</span>' : marks.read.has(path) ? '<span class="explorer-activity read" title="Read in this chat" aria-label="Read in this chat">R</span>' : '';
		const fileRow = (path, level, result = false) => '<button type="button" class="fs-row file' + (p?.path === path ? ' selected' : '') + '" role="treeitem" tabindex="-1" aria-level="' + level + '" aria-selected="' + (p?.path === path) + '" data-aux-open-file="' + esc(path) + '" title="' + esc(path) + '">' +
			'<span class="explorer-chevron-spacer"></span>' + explorerFileIcon(path) + '<span class="explorer-file-label"><span class="fs-name">' + esc(basename(path)) + '</span>' + (result ? '<span class="explorer-file-path">' + esc(path.split('/').slice(0, -1).join('/') || 'Workspace root') + '</span>' : '') + '</span>' + mark(path) + '</button>';
		let rows = '', serial = 0;
		if (filtered) rows = visible.map(path => fileRow(path, 1, true)).join('');
		else {
			const model = fsTree();
			const count = node => (node.count = node.files.length + [...node.dirs.values()].reduce((n, child) => n + count(child), 0));
			count(model);
			const sort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
			const walk = (node, prefix, level) => {
				let html = '';
				for (const [name, child] of [...node.dirs.entries()].sort((a, b) => sort(a[0], b[0]))) {
					const path = prefix ? prefix + '/' + name : name, open = auxFiles.open.has(path), id = 'explorer-group-' + ++serial;
					const edited = [...marks.edited].some(file => file.startsWith(path + '/'));
					html += '<button type="button" class="fs-row dir' + (open ? ' open' : '') + '" role="treeitem" tabindex="-1" aria-level="' + level + '" aria-expanded="' + open + '"' + (open ? ' aria-owns="' + id + '"' : '') + ' data-aux-tree-dir="' + esc(path) + '" title="' + esc(path) + '">' + I(open ? 'chevronDown' : 'chevronRight') + '<span class="explorer-folder-icon">' + I('folder') + '</span><span class="fs-name">' + esc(name) + '</span>' + (edited ? '<span class="explorer-folder-edited" title="Contains files edited in this chat"></span>' : '') + '<span class="explorer-folder-count">' + child.count + '</span></button>';
					if (open) html += '<div class="explorer-children" role="group" id="' + id + '">' + walk(child, path, level + 1) + '</div>';
				}
				for (const name of node.files.slice().sort(sort)) html += fileRow(prefix ? prefix + '/' + name : name, level);
				return html;
			};
			rows = walk(model, '', 1);
		}
		tree.classList.toggle('search-results', filtered);
		tree.innerHTML = rows || (auxFiles.loading ? '<div class="aux-empty"><span class="spinner"></span><b>Reading the workspace…</b></div>' : filtered ? auxEmpty('search', auxFiles.editedOnly ? 'No edited files match' : 'No files found', 'Try another search or switch to All files.') + '<button type="button" class="explorer-reset" data-explorer-reset>Show all files</button>' : auxEmpty('folder', 'No files to show', 'Refresh to check for files added to this workspace.'));
		const items = [...tree.querySelectorAll('[role="treeitem"]')];
		const target = items.find(row => (row.dataset.auxTreeDir ?? row.dataset.auxOpenFile) === focusPath) || items.find(row => row.getAttribute('aria-selected') === 'true') || items[0];
		if (target) { target.tabIndex = 0; if (focused) target.focus({ preventScroll: true }); }
		tree.scrollTop = scrollTop;
	}

	function explorerKeydown(e) {
		const tree = $('aux-explorer-tree'), row = e.target.closest('[role="treeitem"]');
		if (!row || !tree.contains(row)) return;
		const items = [...tree.querySelectorAll('[role="treeitem"]')], index = items.indexOf(row);
		let next;
		if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, index + 1)];
		else if (e.key === 'ArrowUp') next = items[Math.max(0, index - 1)];
		else if (e.key === 'Home') next = items[0];
		else if (e.key === 'End') next = items[items.length - 1];
		else if (e.key === 'ArrowRight') {
			if (row.dataset.auxTreeDir && row.getAttribute('aria-expanded') === 'false') row.click();
			else if (row.dataset.auxTreeDir) next = items[index + 1];
		} else if (e.key === 'ArrowLeft') {
			if (row.getAttribute('aria-expanded') === 'true') row.click();
			else { const path = row.dataset.auxTreeDir ?? row.dataset.auxOpenFile; next = items.find(item => item.dataset.auxTreeDir === path.split('/').slice(0, -1).join('/')); }
		} else return;
		e.preventDefault();
		if (next) { for (const item of items) item.tabIndex = item === next ? 0 : -1; next.focus(); }
	}

	// ---- Terminal tab: one noninteractive command at a time, output streaming live.
	const termUi = { id: 0, cwd: '', shell: '', running: false, stopping: false, exit: null, history: [], hist: -1, draft: '', block: null };
	function termOut() {
		return $('term-out');
	}
	function termFollowing() {
		const out = termOut();
		return !out || out.scrollHeight - out.scrollTop - out.clientHeight < 48;
	}
	function termScrollChrome() {
		$('term-latest').hidden = termFollowing();
	}
	function termStick() {
		const out = termOut();
		if (out) out.scrollTop = out.scrollHeight;
		termScrollChrome();
	}
	function termAppend(html) {
		const out = termOut();
		if (!out) return null;
		const stick = termFollowing();
		const el = document.createElement('div');
		el.className = 'term-line';
		el.innerHTML = html;
		out.appendChild(el);
		while (out.childElementCount > 120) out.firstElementChild.remove();
		if (stick) termStick();
		else termScrollChrome();
		$('term-copy').disabled = !out.childElementCount;
		return el;
	}
	/** Keep the input focusable so Ctrl+C remains available while a command runs. */
	function termChrome() {
		const cwd = $('term-cwd');
		if (cwd && cwd.textContent !== termUi.cwd) {
			cwd.textContent = termUi.cwd;
			cwd.title = termUi.cwd;
		}
		$('term-shell').textContent = termUi.shell || 'Shell';
		const status = $('term-status');
		status.textContent = termUi.stopping ? 'Stopping…' : termUi.running ? 'Running' : termUi.exit === null ? 'Ready' : termUi.exit;
		status.dataset.state = termUi.stopping ? 'stopping' : termUi.running ? 'running' : 'idle';
		$('term-stop').disabled = !termUi.running || termUi.stopping;
		$('term-input').readOnly = termUi.running;
		$('term-input').placeholder = termUi.running ? 'Ctrl+C to stop the command…' : 'Run a command…';
		$('term-copy').disabled = !termOut().childElementCount;
		termScrollChrome();
	}
	function termInfo(msg) {
		if (typeof msg.cwd === 'string' && msg.cwd) termUi.cwd = msg.cwd;
		if (typeof msg.shell === 'string') termUi.shell = msg.shell;
		if (msg.running && Number(msg.id) && Number(msg.id) !== termUi.id) {
			termUi.block = null;
			termUi.exit = null;
		}
		termUi.running = !!msg.running;
		termUi.stopping = !!msg.stopping && termUi.running;
		if (termUi.running && Number(msg.id)) termUi.id = Number(msg.id);
		termChrome();
	}
	function termRun() {
		const input = $('term-input');
		const command = input.value.trim();
		if (!command || termUi.running) return;
		input.value = '';
		termUi.history.push(command);
		if (termUi.history.length > 100) termUi.history.shift();
		termUi.hist = -1;
		termUi.draft = '';
		if (/^(clear|cls)$/i.test(command)) {
			termClear();
			return;
		}
		termAppend('<span class="term-cmd"><b>&gt;</b> ' + esc(command) + '</span>');
		termUi.id += 1;
		termUi.running = true;
		termUi.stopping = false;
		termUi.exit = null;
		termUi.block = null;
		termChrome();
		post({ type: 'terminalRun', id: termUi.id, command });
	}
	function termStop() {
		if (!termUi.running || termUi.stopping) return;
		termUi.stopping = true;
		termChrome();
		post({ type: 'terminalStop', id: termUi.id });
	}
	function termClear() {
		termOut().replaceChildren();
		termUi.block = null; // A running command's next chunk needs a new, attached block.
		termStick();
		termChrome();
	}
	function termMount() {
		post({ type: 'terminalInfo' });
		termChrome();
	}
	/** Output stays text, never HTML; measure scroll-follow before changing its height. */
	function termChunk(msg) {
		if (!termUi.running || msg.id !== termUi.id || !msg.text) return;
		const stick = termFollowing();
		if (!termUi.block || !termOut().contains(termUi.block)) termUi.block = termAppend('<pre class="term-block"></pre>');
		const pre = termUi.block && termUi.block.querySelector('.term-block');
		if (!pre) return;
		pre.appendChild(document.createTextNode(String(msg.text)));
		if (stick) termStick();
		else termScrollChrome();
	}
	function termDone(msg) {
		if (msg.id !== termUi.id || !termUi.running) return;
		termUi.running = false;
		termUi.stopping = false;
		termUi.exit = msg.stopped ? 'Stopped' : 'Exit ' + String(msg.code);
		termUi.block = null;
		if (typeof msg.cwd === 'string' && msg.cwd) termUi.cwd = msg.cwd;
		if (msg.stopped) termAppend('<span class="term-exit stop">stopped</span>');
		else termAppend('<span class="term-exit' + (Number(msg.code) === 0 ? ' success' : '') + '">exit ' + esc(String(msg.code)) + '</span>');
		termChrome();
		const input = $('term-input');
		if (input && !el.auxiliary.classList.contains('hidden') && activeAuxTab() === 'terminal') input.focus();
	}
	$('term-clear').addEventListener('click', termClear);
	$('term-stop').addEventListener('click', termStop);
	$('term-copy').addEventListener('click', () => copyText([...termOut().children].map((line) => line.textContent).join('\n'), $('term-copy')));
	$('term-latest').addEventListener('click', termStick);
	function termInterrupt(e) {
		if (termUi.running && e.key.toLowerCase() === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && !String(window.getSelection() || '')) {
			e.preventDefault();
			termStop();
			return true;
		}
		return false;
	}
	$('term-input').addEventListener('keydown', (e) => {
		if (termInterrupt(e)) return;
		if (e.key === 'Escape') {
			e.stopPropagation();
			if (!termUi.running) { $('term-input').value = ''; termUi.hist = -1; termUi.draft = ''; }
			return;
		}
		if (termUi.running || e.isComposing) return;
		if (e.key === 'Enter') { e.preventDefault(); termRun(); }
		else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
			if (!termUi.history.length || (e.key === 'ArrowDown' && termUi.hist < 0)) return;
			e.preventDefault();
			if (e.key === 'ArrowUp') {
				if (termUi.hist < 0) termUi.draft = $('term-input').value;
				termUi.hist = termUi.hist < 0 ? termUi.history.length - 1 : Math.max(0, termUi.hist - 1);
			} else termUi.hist = termUi.hist < 0 ? -1 : (termUi.hist >= termUi.history.length - 1 ? -1 : termUi.hist + 1);
			$('term-input').value = termUi.hist < 0 ? termUi.draft : termUi.history[termUi.hist];
		}
	});
	$('term-input').addEventListener('input', () => { termUi.hist = -1; termUi.draft = $('term-input').value; });
	termOut().addEventListener('keydown', termInterrupt);
	termOut().addEventListener('scroll', termScrollChrome);
	termOut().addEventListener('click', () => { if (!String(window.getSelection() || '')) $('term-input').focus(); });
	termChrome();
	$('btn-sidebar').addEventListener('click', () => togglePanel('sidebar'));
	$('btn-sidebar-close').addEventListener('click', () => togglePanel('sidebar', false));
	$('btn-auxiliary').addEventListener('click', () => togglePanel('auxiliary'));
	$('btn-auxiliary-close').addEventListener('click', () => togglePanel('auxiliary', false));
	$('btn-project-add').addEventListener('click', () => window.__zcCreateProject ? window.__zcCreateProject() : post({ type: 'projectPick' }));
	$('btn-project-refresh').addEventListener('click', () => post({ type: 'getProjects' }));
	$('project-search').addEventListener('input', () => { renderProjects(); psSync(); });
	// Expandable search: the compact "Quick search…" pill springs open on focus (or
	// Ctrl K from anywhere), the badge swaps for a clear button while typing, and
	// Esc clears first — only an empty Esc closes the panel.
	const psBox = $('project-search-box');
	const psInput = $('project-search');
	const psClear = $('project-search-clear');
	const psKbdKey = $('ps-kbd-key');
	if (psKbdKey && /Mac/i.test(navigator.platform)) psKbdKey.textContent = '⌘';
	function psSync() {
		const on = document.activeElement === psInput || !!psInput.value;
		psBox.classList.toggle('ps-expanded', on);
		psBox.classList.toggle('ps-has-text', !!psInput.value);
		psInput.placeholder = on ? 'Search projects and chats' : 'Quick search…';
		psClear.classList.toggle('hidden', !psInput.value);
	}
	psInput.addEventListener('focus', psSync);
	psInput.addEventListener('blur', psSync);
	psClear.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus in the input
	psClear.addEventListener('click', () => {
		psInput.value = '';
		renderProjects();
		psSync();
		psInput.focus();
	});
	document.addEventListener('keydown', (e) => {
		if (!(e.ctrlKey || e.metaKey) || e.key !== 'k') return;
		const t = e.target;
		if (t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		getProjectPanel().openPalette();
	});
	$('btn-aux-refresh').addEventListener('click', () => { ensureFiles(true); refreshAuxiliary(); });
	// Explorer filter: re-render the tree only, so the cursor stays in the box.
	$('aux-explorer-filter').addEventListener('input', (e) => { auxFiles.filter = e.target.value; renderExplorer(); saveDocumentView(); });
	$('aux-explorer-filter').addEventListener('keydown', e => {
		if (e.key === 'Escape' && auxFiles.filter) { e.preventDefault(); e.stopPropagation(); auxFiles.filter = ''; e.target.value = ''; renderExplorer(); saveDocumentView(); }
	});
	$('aux-explorer-tree')?.addEventListener('keydown', explorerKeydown);
	$('aux-explorer-tree')?.addEventListener('focusin', e => {
		const row = e.target.closest('[role="treeitem"]');
		if (row) for (const item of $('aux-explorer-tree').querySelectorAll('[role="treeitem"]')) item.tabIndex = item === row ? 0 : -1;
	});
	$('sidebar-content').addEventListener('click', e => {
		// The "…" opens the chat menu instead of opening the chat. stopPropagation keeps
		// the document's click (which closes menus) from closing it as it opens.
		const more = e.target.closest('.project-more');
		if (more) {
			e.stopPropagation();
			const s = projectChatById.get(more.closest('.project-chat')?.dataset.projectChat || '');
			if (s) projectChatMenu(s, more);
			return;
		}
		const b = e.target.closest('button'); if (!b) return;
		// Tool buttons live inside <summary>: keep the click from folding the group.
		if (b.closest('summary') && (b.dataset.projectNew || b.dataset.projectOpen)) e.preventDefault();
		if (b.dataset.projectChat) {
			post(b.dataset.projectPath ? { type: 'projectOpen', path: b.dataset.projectPath, sessionId: b.dataset.projectChat } : { type: 'switchSession', id: b.dataset.projectChat });
		} else if (b.dataset.projectOpen) post({ type: 'projectOpen', path: b.dataset.projectOpen });
		else if (b.dataset.projectNew) post({ type: 'projectNewChat', path: b.dataset.projectNew });
	});
	// Right-click on a chat row: the same menu, anchored at the row.
	$('sidebar-content').addEventListener('contextmenu', e => {
		const row = e.target.closest('.project-chat');
		if (!row || row.disabled) return;
		e.preventDefault();
		const s = projectChatById.get(row.dataset.projectChat || '');
		if (s) projectChatMenu(s, row);
	});
	el.auxiliary.addEventListener('click', e => {
		const b = e.target.closest('button'); if (!b) return;
		if (b.hasAttribute('data-explorer-refresh')) { ensureFiles(true); return; }
		if (b.hasAttribute('data-explorer-collapse')) { auxFiles.open.clear(); renderExplorer(); saveDocumentView(); return; }
		if (b.hasAttribute('data-explorer-clear') || b.hasAttribute('data-explorer-reset')) {
			auxFiles.filter = ''; $('aux-explorer-filter').value = '';
			if (b.hasAttribute('data-explorer-reset')) auxFiles.editedOnly = false;
			renderExplorer(); saveDocumentView(); $('aux-explorer-filter').focus(); return;
		}
		if (b.hasAttribute('data-explorer-scope')) { auxFiles.editedOnly = b.dataset.explorerScope === 'edited'; renderExplorer(); saveDocumentView(); return; }
		if (b.dataset.auxFile) openWorkspaceFile(b.dataset.auxFile);
		if (b.dataset.repoRefresh === 'changes') post({ type: 'getGitStatus' });
		if (b.dataset.repoRefresh === 'worktrees') post({ type: 'getWorktrees' });
		if (b.dataset.auxDiff) auxRequestDiff(b.dataset.auxDiff);
		if (b.hasAttribute('data-aux-close-diff')) { panelData.diff = null; renderAuxiliary(); }
		if (b.dataset.auxWorktree) post({ type: 'openWorktree', path: b.dataset.auxWorktree });
		if (b.dataset.auxCopyPath) {
			const text = b.dataset.auxCopyPath;
			const done = () => { b.classList.add('copied'); setTimeout(() => b.classList.remove('copied'), 1200); };
			const failed = () => toast('Could not copy the worktree path. Allow clipboard access and try again.', 'error');
			try { navigator.clipboard.writeText(text).then(done, failed); } catch { failed(); }
		}
		if (b.dataset.auxRemove) post({ type: 'removeAttachment', id: b.dataset.auxRemove });
		if (b.dataset.auxRemoveWorktree) post({ type: 'removeWorktree', path: b.dataset.auxRemoveWorktree });

		if (b.hasAttribute('data-aux-create-worktree')) auxWorktreeEntry();
		if (b.hasAttribute('data-aux-cancel-worktree')) { panelData.worktreeEntry = false; renderAuxiliary(); }
		if (b.hasAttribute('data-aux-submit-worktree')) {
			const input = $('aux-content-worktrees').querySelector('[data-aux-worktree-task]');
			const task = input.value.trim();
			if (!task) { input.focus(); return; }
			panelData.worktreeEntry = false;
			post({ type: 'worktree', action: 'create', task });
			renderAuxiliary();
		}
		if (b.dataset.auxOpenFile) auxOpenPreview(b.dataset.auxOpenFile);
		if (b.hasAttribute('data-aux-open-editor') || b.closest('[data-aux-open-editor]')) {
			if (auxFiles.preview && auxFiles.preview.path) post({ type: 'openFile', path: auxFiles.preview.path, line: auxFiles.preview.line });
		}
		if (b.hasAttribute('data-aux-max-preview')) auxMaxOpen();
		if (b.hasAttribute('data-aux-close-preview')) { auxFiles.preview = null; auxMaxClose(); renderExplorer(); saveDocumentView(); }
		if (b.dataset.auxTreeDir) {
			const p = b.dataset.auxTreeDir;
			auxFiles.open.has(p) ? auxFiles.open.delete(p) : auxFiles.open.add(p);
			renderExplorer();
			saveDocumentView();
		}
	});
	el.auxiliary.addEventListener('input', e => {
		if (e.target.hasAttribute('data-aux-worktree-task')) panelData.worktreeTask = e.target.value;
	});
	const auxTabs = [...el.auxiliary.querySelectorAll('.auxiliary-tab')];
	for (const tab of auxTabs) {
		tab.setAttribute('aria-controls', 'aux-content-' + tab.dataset.tab);
		tab.tabIndex = tab.classList.contains('active') ? 0 : -1;
		$('aux-content-' + tab.dataset.tab).setAttribute('aria-labelledby', tab.id);
		tab.addEventListener('click', () => {
			for (const t of auxTabs) { const active = t === tab; t.classList.toggle('active', active); t.setAttribute('aria-selected', String(active)); t.tabIndex = active ? 0 : -1; }
			const rail = tab.parentElement;
			if (rail) { if (tab.offsetLeft < rail.scrollLeft) rail.scrollLeft = tab.offsetLeft; else if (tab.offsetLeft + tab.offsetWidth > rail.scrollLeft + rail.clientWidth) rail.scrollLeft = tab.offsetLeft + tab.offsetWidth - rail.clientWidth; }
			for (const p of el.auxiliary.querySelectorAll('.aux-panel')) { const active = p.id === 'aux-content-' + tab.dataset.tab; p.classList.toggle('active', active); p.classList.toggle('hidden', !active); }
			syncAuxPreview();
			if (tab.dataset.tab === 'explorer') { ensureFiles(true); renderExplorer(); }
			if (tab.dataset.tab === 'terminal') { termMount(); setTimeout(() => { const i = $('term-input'); if (i && !i.disabled) i.focus(); }, 30); }
		});
		tab.addEventListener('keydown', e => {
			if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
			e.preventDefault();
			const i = e.key === 'Home' ? 0 : e.key === 'End' ? auxTabs.length - 1 : (auxTabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1) + auxTabs.length) % auxTabs.length;
			auxTabs[i].click(); auxTabs[i].focus();
		});
	}
	document.addEventListener('keydown', e => {
		if (e.key !== 'Escape') return;
		if (auxFiles.max) { e.preventDefault(); auxMaxClose(); }
		else if (auxFiles.preview && !el.auxiliary.classList.contains('hidden') && activeAuxTab() === 'explorer') { e.preventDefault(); auxFiles.preview = null; renderExplorer(); }
		else if (fsUi.preview) { e.preventDefault(); fsUi.preview = null; fsLayers(); fsScheduleTree(); }
		else if (document.activeElement === psInput) { e.preventDefault(); if (psInput.value) { psInput.value = ''; renderProjects(); psSync(); } else psInput.blur(); }
		else if (ui.historyOpen) { e.preventDefault(); ui.historyOpen = false; renderHistory(); $('btn-history').focus({ preventScroll: true }); }
		else if (!el.sidebar.classList.contains('hidden')) { e.preventDefault(); togglePanel('sidebar', false); }
		else if (!el.auxiliary.classList.contains('hidden')) { e.preventDefault(); togglePanel('auxiliary', false); }
	});
	$('btn-folder-new').addEventListener('click', (e) => {
		e.stopPropagation();
		const menu = popMenu(e.currentTarget, []);
		inlineInput(menu, t('newFolder'), '', (v) => post({ type: 'saveFolder', name: v, color: FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length] }));
	});
	const pickHistoryView = (filter) => {
		ui.historyFilter = filter;
		ui.historyProject = null;
		ui.historySelected.clear();
		ui.historySelecting = false;
		el.historyList.scrollTop = 0;
		renderHistory();
	};
	$('hl-crumb-current').addEventListener('click', (e) => {
		e.stopPropagation();
		const menu = popMenu(e.currentTarget, []);
		const choose = (filter) => { menu.remove(); pickHistoryView(filter); };
		menu.appendChild(h('div', 'menu-label', 'Show'));
		menu.appendChild(item('history', t('allChats'), { checked: ui.historyFilter === 'all' && !ui.historyProject, onClick: () => choose('all') }));
		menu.appendChild(item('pin', t('pinned'), { checked: ui.historyFilter === 'pinned', onClick: () => choose('pinned') }));
		menu.appendChild(h('div', 'menu-sep'));
		menu.appendChild(h('div', 'menu-label', 'Folders'));
		for (const p of panelData.projects || []) {
			if (!p.path) continue;
			menu.appendChild(item('folder', p.name, { checked: ui.historyProject === p.id, onClick: () => { menu.remove(); ui.historyProject = p.id; ui.historyFilter = 'all'; ui.historySelected.clear(); renderHistory(); } }));
		}
		if (state.folders.length) {
			menu.appendChild(h('div', 'menu-sep'));
			menu.appendChild(h('div', 'menu-label', 'Chat folders'));
			for (const f of state.folders) menu.appendChild(item('folder', f.name, { checked: ui.historyFilter === 'folder:' + f.id, badges: '<span class="folder-dot fc-' + esc(f.color) + '"></span>', onClick: () => choose('folder:' + f.id) }));
		}
	});
	$('hl-sort-btn').addEventListener('click', (e) => {
		e.stopPropagation();
		const menu = popMenu(e.currentTarget, []);
		const options = [['newest', t('newestFirst')], ['oldest', t('oldestFirst')], ['title', t('titleAZ')], ['prompts', t('mostPrompts')]];
		for (const [value, label] of options) {
			menu.appendChild(item('arrowDown', label, {
				checked: ui.historySort === value,
				onClick: () => { menu.remove(); const select = $('history-sort'); select.value = value; select.dispatchEvent(new Event('change')); }
			}));
		}
	});
	$('history-sort').addEventListener('change', (e) => {
		ui.historySort = e.target.value;
		el.historyList.scrollTop = 0;
		saveUi();
		renderHistory();
	});
	$('history-select').addEventListener('click', () => {
		ui.historySelecting = !ui.historySelecting;
		ui.historySelected.clear();
		renderHistory();
	});
	$('history-select-all').addEventListener('change', (e) => {
		ui.historySelected = new Set(e.target.checked ? ui.historyVisible : []);
		renderHistory();
	});
	$('history-reset').addEventListener('click', resetHistory);
	$('history-search-clear').addEventListener('click', () => {
		el.historySearch.value = ui.historyQuery = '';
		ui.chatHits = null;
		renderHistory();
		el.historySearch.focus();
	});
	$('btn-history-new-top').addEventListener('click', () => $('btn-history-new').click());
	$('hl-side-toggle').addEventListener('click', (e) => {
		const collapsed = $('hl-shell').classList.toggle('side-off');
		e.currentTarget.setAttribute('aria-pressed', String(collapsed));
		e.currentTarget.title = collapsed ? 'Show the folder panel' : 'Hide the folder panel';
	});
	$('hl-workspace').addEventListener('click', (e) => {
		e.stopPropagation();
		const menu = popMenu(e.currentTarget, []);
		menu.appendChild(h('div', 'menu-label', esc((state.workspace && state.workspace.name) || 'Workspace')));
		menu.appendChild(item('plus', t('newChat'), { onClick: () => { menu.remove(); $('btn-history-new').click(); } }));
		menu.appendChild(item('folderPlus', t('newFolder'), { onClick: () => { menu.remove(); $('btn-folder-new').click(); } }));
		menu.appendChild(item('swap', 'Import a chat', { onClick: () => { menu.remove(); $('btn-history-import').click(); } }));
	});
	$('history-bulk-clear').addEventListener('click', () => {
		ui.historySelected.clear();
		ui.historySelecting = false;
		renderHistory();
	});
	$('history-bulk-archive').addEventListener('click', () => {
		const ids = [...ui.historySelected];
		if (!ids.length) return;
		const picked = ids.map((id) => state.sessions.find((s) => s.id === id)).filter(Boolean);
		const unarchive = picked.length > 0 && picked.every((s) => s.archived);
		updateSelectedChats({ archived: !unarchive });
		notifyHistory((unarchive ? 'Restored ' : 'Archived ') + ids.length + (ids.length === 1 ? ' chat' : ' chats'), () => {
			post({ type: 'updateSessions', ids, patch: { archived: unarchive } });
			renderHistory();
		});
	});
	$('history-bulk-move').addEventListener('click', (e) => {
		e.stopPropagation();
		const ids = [...ui.historySelected];
		if (!ids.length) return;
		const menu = popMenu(e.currentTarget, []);
		const move = (folder) => {
			menu.remove();
			const before = ids.map((id) => [id, (state.sessions.find((s) => s.id === id) || {}).folderId || null]);
			post({ type: 'updateSessions', ids, patch: { folderId: folder ? folder.id : null } });
			ui.historySelected.clear();
			ui.historySelecting = false;
			renderHistory();
			const where = folder ? folder.name : t('unfiled');
			notifyHistory(ids.length === 1 ? 'Moved to ' + where : 'Moved ' + ids.length + ' chats to ' + where, () => {
				for (const [id, folderId] of before) post({ type: 'updateSession', id, patch: { folderId } });
				renderHistory();
			});
		};
		menu.appendChild(h('div', 'menu-label', esc(t('moveToFolder'))));
		menu.appendChild(item('folder', t('unfiled'), { onClick: () => move(null) }));
		for (const f of state.folders) menu.appendChild(item('folder', f.name, { onClick: () => move(f) }));
	});
	let chatSearchTimer;
	el.historySearch.addEventListener('input', () => {
		ui.historyQuery = el.historySearch.value;
		el.historyList.scrollTop = 0;
		renderHistory();
		clearTimeout(chatSearchTimer);
		const q = ui.historyQuery.trim();
		if (q.length >= 2) chatSearchTimer = setTimeout(() => post({ type: 'searchChats', query: q }), 180);
	});
	el.historySearch.addEventListener('keydown', (e) => {
		if (e.key !== 'ArrowDown' && e.key !== 'Enter') return;
		const first = el.historyList.querySelector('.sr-open');
		if (!first) return;
		e.preventDefault();
		e.key === 'Enter' ? first.click() : first.focus();
	});
	el.historyList.addEventListener('keydown', (e) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const rows = [...el.historyList.querySelectorAll('.sr-open')];
		const i = rows.indexOf(document.activeElement);
		if (i < 0) return;
		e.preventDefault();
		if (e.key === 'ArrowUp' && i === 0) return el.historySearch.focus();
		(rows[i + (e.key === 'ArrowDown' ? 1 : -1)] || rows[i]).focus();
	});
	$('btn-new').addEventListener('click', () => post({ type: 'newSession' }));
	$('btn-settings').addEventListener('click', () => openSettings());
	$('btn-more').addEventListener('click', (e) => {
		e.stopPropagation();
		chatMenu(e.currentTarget);
	});
	el.plan.addEventListener('click', () => togglePlan(false));
	el.mic.addEventListener('click', toggleMic);

	el.plus.addEventListener('click', (e) => (e.stopPropagation(), toggleMenu('plus')));
	el.mode.addEventListener('click', (e) => (e.stopPropagation(), toggleMenu('mode')));
	el.model.addEventListener('click', (e) => (e.stopPropagation(), toggleMenu('model')));
	el.effort.addEventListener('click', (e) => (e.stopPropagation(), toggleMenu('effort')));
	el.ctx.addEventListener('click', (e) => (e.stopPropagation(), toggleMenu('ctx')));
	for (const [button, menu] of Object.values(MENUS)) {
		el[menu].addEventListener('click', (e) => e.stopPropagation());
		bindMenuNavigation(el[menu], el[button]);
		el[button].addEventListener('keydown', event => {
			if (event.isComposing || event.keyCode === 229 || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
			event.preventDefault();
			if (el[menu].classList.contains('hidden')) el[button].click();
			const items = [...el[menu].querySelectorAll('button:not(:disabled)')];
			(event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
		});
	}
	document.addEventListener('click', () => closeMenus());

	el.send.addEventListener('click', () => {
		const hasText = !!el.input.value.trim() || state.attachments.length;
		if (state.isStreaming && !hasText) post({ type: 'stop' });
		else send();
	});

	const queueComposerInput = () => {
		clearTimeout(ui.composerSaveTimer);
		ui.composerSaveTimer = setTimeout(saveUi, 200);
		if (ui.composerFrame) return;
		ui.composerFrame = requestAnimationFrame(() => {
			ui.composerFrame = 0;
			if (!ui.composing) { autosize(); detectPopup(); }
			renderSendControl();
		});
	};
	el.input.addEventListener('input', queueComposerInput);
	window.addEventListener('pagehide', saveUi);
	el.input.addEventListener('click', detectPopup);
	el.input.addEventListener('blur', () => setTimeout(closePopup, 150));
	el.input.addEventListener('contextmenu', inputMenu);
	el.input.addEventListener('compositionstart', () => { ui.composing = true; closePopup(); });
	el.input.addEventListener('compositionend', () => { ui.composing = false; queueComposerInput(); });
	el.input.addEventListener('blur', () => { ui.composing = false; saveUi(); });
	el.input.addEventListener('keydown', (e) => {
		if (ui.composing || e.isComposing || e.keyCode === 229) return;
		const p = ui.popup;
		if (p && p.items.length) {
			if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
				e.preventDefault();
				p.index = e.key === 'Home' ? 0 : e.key === 'End' ? p.items.length - 1 : (p.index + (e.key === 'ArrowDown' ? 1 : -1) + p.items.length) % p.items.length;
				renderPopup();
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				applyPopup(p.items[p.index]);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				closePopup();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		} else if (e.key === 'ArrowUp' && !el.input.value) {
			const lastUser = [...state.messages].reverse().find((m) => m.role === 'user' && !m.kind);
			if (lastUser) {
				e.preventDefault();
				el.input.value = lastUser.content;
				autosize();
				renderComposer();
			}
		}
	});

	el.input.addEventListener('paste', (e) => {
		const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
		if (!files.length) return;
		e.preventDefault();
		for (const file of files) {
			const reader = new FileReader();
			reader.onload = () => {
				const ext = file.type.split('/')[1].replace('jpeg', 'jpg');
				post({ type: 'addImage', name: file.name && file.name !== 'image.png' ? file.name : 'pasted-' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + '.' + ext, mime: file.type, base64: String(reader.result).split(',')[1] || '' });
			};
			reader.readAsDataURL(file);
		}
	});

	document.addEventListener('keydown', (e) => {
		if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.key !== 'Escape' || document.querySelector('#settings-root .settings-overlay') || document.querySelector('#dialog-root .overlay')) return;
		if (questionUi.popup) { e.preventDefault(); closeQuestionPopup(true); return; }
		if (!el.lightbox.classList.contains('hidden')) { e.preventDefault(); imageViewer.close(); }
		else if (ui.open || document.querySelector('.row-menu, .input-menu')) closeMenus();
		else if (ui.historyOpen) {
			ui.historyOpen = false;
			renderHistory();
		} else if (document.body.classList.contains('fullscreen') || (B.desktop && document.body.classList.contains('zc-native-fullscreen'))) {
			// Full screen: Esc leaves it. The agent keeps working (stop with the ■ button).
			e.preventDefault();
			if (window.__fsExit) window.__fsExit();
		} else if (state.isStreaming) post({ type: 'stop' });
	});

	const imageViewer = createImageViewer(el.lightbox);
	// An Approval Card with focus answers to Ctrl+Enter / ⌘↵ (approve) and Escape (reject),
	// before Escape reaches the window, where it would stop the run.
	el.messages.addEventListener('keydown', (event) => {
		const card = event.target.closest && event.target.closest('.apc');
		if (!card || event.isComposing) return;
		if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			card.querySelector('[data-approve]').click();
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			card.querySelector('[data-reject]').click();
		}
	});
	el.messages.addEventListener('keydown', event => {
		if (event.isComposing || !['Enter', ' '].includes(event.key)) return;
		if (event.target.matches('.agt-node[data-agt-open]')) {
			event.preventDefault();
			sagOpen(event.target.dataset.agtOpen);
			return;
		}
		const trigger = event.target.closest('[data-zoom]');
		if (trigger) { event.preventDefault(); trigger.click(); }
	});

	el.messages.addEventListener('click', (e) => {
		const target = e.target;
		if (!(target instanceof Element)) return;
		const hit = (sel) => target.closest(sel);
		let n;
		if ((n = hit('[data-agt-fold]'))) {
			const id = n.closest('.agt-hang').dataset.agent;
			if (ui.agentFold.has(id)) ui.agentFold.delete(id);
			else ui.agentFold.add(id);
			renderMessages();
		} else if ((n = hit('[data-agt-pop]'))) {
			const box = n.closest('.msg.agt');
			box.agtPop = !box.agtPop;
			renderMessages();
		} else if ((n = hit('[data-agt-dismiss]'))) {
			n.closest('.msg.agt').agtPop = false;
			renderMessages();
		} else if ((n = hit('[data-agt-open]'))) {
			sagOpen(n.dataset.agtOpen);
		} else if ((n = hit('[data-copy-detail]'))) {
			const m = state.messages.find((x) => x.id === n.dataset.copyDetail);
			if (m && m.tool) copyText(m.tool.detail || '', n);
		} else if ((n = hit('[data-show-all]'))) {
			// In place: the row keeps its scroll position and the code its selection.
			const key = 'all:' + n.dataset.showAll;
			const all = !ui.expanded.has(key);
			if (all) ui.expanded.add(key);
			else ui.expanded.delete(key);
			n.previousElementSibling.classList.toggle('capped', !all);
			n.setAttribute('aria-expanded', String(all));
			n.textContent = all ? 'Show less' : 'Show all';
		} else if ((n = hit('[data-copy-code]'))) {
			const code = n.closest('.code-block').querySelector('code');
			copyText(code ? code.textContent : '', n);
		} else if ((n = hit('[data-wrap-code]'))) {
			n.classList.toggle('active', n.closest('.code-block').classList.toggle('wrap'));
			n.setAttribute('aria-pressed', String(n.classList.contains('active')));
		} else if ((n = hit('[data-expand-code]'))) {
			const block = n.closest('.code-block');
			block.classList.toggle('open');
			n.textContent = block.classList.contains('open') ? 'Show less' : 'Show all ' + block.querySelector('code').textContent.split('\n').length + ' lines';
			n.setAttribute('aria-expanded', String(block.classList.contains('open')));
		} else if ((n = hit('[data-copy-msg]'))) {
			const m = state.messages.find((x) => x.id === n.dataset.copyMsg);
			if (m) copyText(m.content, n);
		} else if ((n = hit('[data-branch]'))) {
			chatBranch.show(n.dataset.branch);
		} else if ((n = hit('[data-open-session]'))) {
			post({ type: 'switchSession', id: n.dataset.openSession });
		} else if (hit('[data-report]')) {
			post({ type: 'reportProblem' });
		} else if ((n = hit('[data-retry]'))) {
			n.classList.add('spin');
			followLatest();
			sweep();
			post({ type: 'retry', plan: ui.plan });
		} else if ((n = hit('[data-toggle-source]'))) {
			const code = n.closest('.mermaid-block').querySelector('.code-block');
			if (code) code.classList.toggle('hidden');
			n.textContent = code && code.classList.contains('hidden') ? 'Source' : 'Hide source';
		} else if ((n = hit('[data-restore]'))) {
			post({ type: 'restoreTo', id: n.dataset.restore });
		} else if ((n = hit('[data-undo]'))) {
			post({ type: 'undoTurn', id: n.dataset.undo, path: n.dataset.path, redo: n.dataset.redo === 'true' });
		} else if ((n = hit('[data-recovery-panel]'))) {
			togglePanel('auxiliary', true);
			$('aux-tab-' + n.dataset.recoveryPanel)?.click();
		} else if ((n = hit('[data-review]'))) {
			post({ type: 'reviewTurn', id: n.dataset.review, path: n.dataset.path });
		} else if ((n = hit('[data-approve]'))) {
			post({ type: 'approve', id: n.dataset.approve });
		} else if ((n = hit('[data-always]'))) {
			post({ type: 'approveAlways', id: n.dataset.always });
		} else if ((n = hit('[data-rule]'))) {
			ruleAdded.add(n.dataset.ruleFor);
			post({ type: 'addCommandRule', verdict: n.dataset.rule, pattern: n.dataset.pattern });
			n.closest('.rule-suggest')?.remove();
		} else if ((n = hit('[data-reject]'))) {
			post({ type: 'reject', id: n.dataset.reject });
		} else if ((n = hit('[data-question-open]'))) {
			openQuestionPopup(n.dataset.questionOpen);
		} else if ((n = hit('[data-zoom]'))) {
			imageViewer.open(n.dataset.zoom, n.dataset.caption || '', n);
		} else if ((n = hit('[data-stop-agent]'))) {
			e.stopPropagation();
			post({ type: 'stopAgent', id: n.dataset.stopAgent });
		} else if ((n = hit('[data-open-path]'))) {
			e.stopPropagation();
			const path = n.dataset.openPath;
			if (document.body.classList.contains('desktop') && path) {
				auxOpenPreview(path);
			} else {
				post({ type: 'openFile', path });
			}
		} else if ((n = hit('[data-think-detail]'))) {
			if (n.dataset.expandable !== 'true') return;
			const open = n.dataset.open !== 'true';
			n.dataset.open = String(open);
			n.setAttribute('aria-expanded', String(open));
		} else if ((n = hit('[data-think-toggle]'))) {
			const box = n.closest('.thinking');
			const open = !box.classList.contains('open');
			ui.thinkOpen.set(box.dataset.think, open);
			setThinkingOpen(box, open);
		} else if ((n = hit('[data-toggle]'))) {
			const id = n.dataset.toggle;
			ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id);
			renderMessages();
		} else if ((n = hit('a[data-href]'))) {
			e.preventDefault();
			post({ type: 'openExternal', url: n.dataset.href });
		} else if ((n = hit('code.file-ref, .file-link, .mention'))) {
			e.preventDefault();
			const path = n.dataset.open;
			const line = n.dataset.line ? Number(n.dataset.line) : undefined;
			if (document.body.classList.contains('desktop') && path) {
				auxOpenPreview(path, line);
			} else {
				post({ type: 'openFile', path, line });
			}
		} else if ((n = hit('[data-open-settings]'))) {
			openSettings(n.dataset.openSettings);
		} else if ((n = hit('[data-open-setup]'))) {
			window.__zcSetup?.open(n.dataset.openSetup === 'key' ? 'key' : 'start');
		} else if (hit('[data-open-history]')) {
			openHistory();
		} else if ((n = hit('[data-draft]'))) {
			startTask(n.dataset.draft);
		} else if ((n = hit('[data-suggest]'))) {
			send(n.dataset.suggest);
		}
	});

	// ------------------------------------------------------------ watchlist banner

	// ------------------------------------------------------------ host messages

	window.addEventListener('message', (event) => {
		if (event.source && event.source !== window) return;
		const msg = event.data || {};
		switch (msg.type) {
			case 'hunkReviewResult': showHunkReview(msg); break;
			case 'comparisonState':
			case 'comparisonDiff':
			case 'comparisonError':
			case 'comparisonApplied': comparisonMessage(msg); break;
			case 'queueEditRecovered':
				if (msg.sessionId === state.currentSessionId) { el.input.value = [el.input.value, msg.text].filter(Boolean).join('\n\n'); saveUi(); toast('That message already started. Your edit was kept in the draft.'); }
				break;
			case 'foreignSessions': {
				const menu = ui.foreignMenu;
				if (!menu || !menu.isConnected) break;
				menu.replaceChildren();
				menu.appendChild(h('div', 'fx-head', 'Continue a chat from another agent'));
				if (!msg.items || !msg.items.length) {
					menu.appendChild(h('div', 'fx-empty', msg.error ? esc(msg.error) : 'No Claude Code or Codex chats found on this computer.'));
					break;
				}
				const list = h('div', 'fx-list');
				for (const s of msg.items) {
					const b = h('button', 'fx-row');
					const folder = (s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
					b.innerHTML = '<span class="fx-src fx-' + s.source + '">' + (s.source === 'claude' ? 'Claude Code' : 'Codex') + '</span><span class="fx-title">' + esc(s.title) + '</span><span class="fx-meta">' + esc(folder) + ' · ' + relTime(s.modified) + '</span>';
					b.addEventListener('click', () => {
						menu.remove();
						ui.historyOpen = false;
						renderHistory();
						post({ type: 'foreignImport', source: s.source, path: s.path });
					});
					list.appendChild(b);
				}
				menu.appendChild(list);
				break;
			}
			
			case 'whatsNew':
				showWhatsNew(msg);
				break;
			case 'zcDesktopReview':
				// The notch's "Open changes": the Git card with its review drawer open.
				gitUi.review = true;
				gitShow(true);
				break;
			case 'chatSearch':
				ui.chatHits = { query: msg.query, hits: msg.hits || [] };
				renderHistory();
				break;
			case 'symbols':
				ui.symbols = { query: msg.query, items: msg.items || [] };
				if (ui.popup && ui.popup.kind === 'file' && ui.popup.query === msg.query) {
					const index = ui.popup.index;
					ui.popup.items = mentionItems(msg.query);
					ui.popup.index = Math.min(index, ui.popup.items.length - 1);
					renderPopup();
				}
				break;
			case 'backgroundImage':
				window.setBackgroundImage(msg.data, state.settings);
				break;
			case 'projects':
				// The History Library shows these as its folder row, so keep them on state too.
				panelData.projects = msg.projects || [];
				state.projects = panelData.projects;
				state.currentProjectId = msg.currentProjectId || null;
				renderProjects();
				renderHistory();
				break;
			case 'writerDiff':
				if (msg.sessionId === state.currentSessionId) { sagWriterReviews.set(msg.id, msg); sagSelected = msg.id; sagDetailTab = 'changes'; sagTeamRender(); }
				break;
			case 'writerReviewDone':
				if (msg.sessionId === state.currentSessionId) { sagWriterReviews.delete(msg.id); toast(msg.result, ''); sagTeamRender(); }
				break;
			case 'worktreeTaskEntry':
				auxWorktreeEntry(); break;
			case 'gitTextDiff':
				if (panelData.diff?.path === msg.path) { panelData.diff = { ...msg, loading: false }; renderAuxiliary(); }
				break;
			case 'worktrees':
				panelData.worktrees = msg.items || []; panelData.worktreeError = msg.error; renderAuxiliary(); break;
			case 'worktreeRemoved':
				toast('Worktree removed. Its branch is kept.', '');
				post({ type: 'getWorktrees' });
				break;
			
			case 'agentRuns':
				if (msg.sessionId && msg.sessionId !== state.currentSessionId) break;
				state.agentRuns = msg.items || []; renderAuxiliary(); renderMessages(); break;
			case 'state': {
				const sessionChanged = msg.currentSessionId !== state.currentSessionId;
				if (sessionChanged) resetReviews();
				if (sessionChanged) switchComposerSession(msg.currentSessionId);
				if (sessionChanged) switchDocumentSession(msg.currentSessionId);
				if (sessionChanged) readingAnchor = null;
				const wasStreaming = state.isStreaming;
				const previousRunSessionId = state.runningSessionId || state.currentSessionId;
				const wasWaiting = state.runState === 'waiting';
				Object.assign(state, {
					providers: msg.providers || [],
					selection: msg.selection || {},
					modelPreferences: msg.modelPreferences || { favorites: [], recent: [] },
					settings: msg.settings || {},
					subagentWorkflow: msg.subagentWorkflow || { enabled: false, workerModel: '', reviewerModel: '', maxConcurrency: 2 },
					mode: msg.mode || 'agent',
					messages: msg.messages || [],
					isStreaming: !!msg.isStreaming,
					runningSessionId: msg.runningSessionId,
					runState: msg.runState,
					// Null ends the live model step even when its tools keep the turn running.
					streaming: msg.streaming !== undefined ? msg.streaming : (msg.isStreaming ? state.streaming : null),
					queue: msg.queue || [],
					sessions: msg.sessions || [],
					folders: msg.folders || [],
					artifacts: Array.isArray(msg.artifacts) ? msg.artifacts : [],
					currentSessionId: msg.currentSessionId,
					branch: msg.branch || null,
					goal: msg.goal || null,
					chapters: msg.chapters || [],
					attachments: msg.attachments || [],
					context: msg.context || null,
					hasWorkspace: msg.hasWorkspace !== false,
					workspace: msg.workspace || null,
					skills: msg.skills || [],
					mcp: msg.mcp || [],
					browser: msg.browser || {},

					agentRuns: msg.agentRuns || [],
					workflowTaskId: msg.workflowTaskId || null,
					commands: msg.commands || [],
					agents: msg.agents || [],
					mic: msg.mic || {},
					undoable: msg.undoable || [],
					redoable: msg.redoable || [],
					isRemote: !!msg.isRemote || B.remote
				});
				window.__zcSetup?.maybeOpen();
				if (state.isStreaming && !wasStreaming) ui.streamStartedAt = Date.now();
				if (!state.isStreaming && wasStreaming) ui.answeredAt = performance.now();
				if (state.isStreaming && !wasStreaming) gitTurnStart();
				else if (!state.isStreaming && wasStreaming) gitTurnEnd();
				if (sessionChanged) {
					saveUi();
					imageViewer.close();
					closeMenus();
					closeQuestionPopup(false, false);
					questionUi.dismissed.clear();
					questionUi.submitted.clear();
					questionUi.drafts.clear();
					ui.expanded.clear();
					msgImages.clear();
					askedMsgImages.clear();
					panelData.diff = null;
				}
				if (sessionChanged || wasStreaming && !state.isStreaming) {
					followLatest();
				}
				render();
				renderAuxiliary();
				if (sessionChanged || (!el.auxiliary.classList.contains('hidden') && activeAuxTab() === 'explorer' && auxFiles.activity !== explorerActivity())) renderExplorer();
				if (!el.auxiliary.classList.contains('hidden') && activeAuxTab() === 'terminal') post({ type: 'terminalInfo' });
				if (!el.sidebar.classList.contains('hidden')) post({ type: 'getProjects' });
				tickStatus();
				if (state.isRemote || document.body?.classList?.contains('remote')) renderArtifactButton();
				if (state.isRemote) {
					void keepAwake(state.isStreaming);
					if (!wasWaiting && state.runState === 'waiting') {
						buzz([16, 40, 16]);
						phoneNotify('zer0ne needs you', 'An approval or a question is waiting.', 'asking');
					} else if (wasStreaming && !state.isStreaming && ['completed', 'failed'].includes(previousRunSessionId === state.currentSessionId ? [...state.messages].reverse().find(m => m.role === 'user' && m.turn)?.turn.outcome : state.sessions.find(session => session.id === previousRunSessionId)?.outcome)) {
						buzz(16);
						const last = [...state.messages].reverse().find((m) => m.role === 'assistant' && m.content);
						phoneNotify('zer0ne finished', last ? String(last.content).replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) : 'The turn is done.', 'done');
					}
				}
				break;
			}
			case 'attachmentImages':
				for (const im of msg.images || []) thumbs.set(im.id, im.url);
				renderComposer();
				break;
			case 'messageImages':
				msgImages.set(msg.id, msg.urls || []);
				renderMessages();
				break;
			case 'streamStart':
				if (!state.isStreaming) ui.streamStartedAt = Date.now();
				state.isStreaming = true;
				state.streaming = { text: '', reasoning: '' };
				if (!streamEl) renderMessages();
				else paintStream();
				gitTurnStart();
				ui.thinkStartedAt = ui.thinkMs = 0;
				// A new turn's trace starts folded even if the last live trace was opened by hand.
				ui.thinkOpen.delete('live');
				ui.carryThink.clear();
				renderComposer();
				tickStatus();
				break;
			case 'delta':
				if (!state.streaming) state.streaming = { text: '', reasoning: '' };
				if (msg.text) state.streaming.text += msg.text;
				if (msg.reasoning) state.streaming.reasoning += msg.reasoning;
				scheduleStreamPaint();
				break;
			case 'files':
				ui.files = msg.files || [];
				auxFiles.loading = false;
				ui.filesAt = Date.now();
				if (ui.popup && ui.popup.kind === 'file') detectPopup();
				fsScheduleTree();
				if (activeAuxTab() === 'explorer') renderExplorer();
				break;
			case 'filePreview':
				if (msg.sessionId && msg.sessionId !== state.currentSessionId) break;
				if (fsUi.preview && fsUi.preview.path === msg.path) {
					fsUi.preview = { ...msg, loading: false };
					fsRenderPreview();
				}
				if (auxFiles.preview && (auxFiles.preview.path === msg.path || auxFiles.preview.path.replace(/\\/g, '/') === msg.path.replace(/\\/g, '/'))) {
					auxFiles.preview = { ...msg, line: auxFiles.preview.line, scrollTop: auxFiles.preview.scrollTop, loading: false };
					renderExplorer();
				}
				if (auxFiles.max && auxFiles.preview && (auxFiles.preview.path === msg.path || auxFiles.preview.path.replace(/\\/g, '/') === msg.path.replace(/\\/g, '/'))) auxMaxRender();
				break;
			case 'terminalInfo':
				termInfo(msg);
				break;
			case 'terminalChunk':
				termChunk(msg);
				break;
			case 'terminalDone':
				termDone(msg);
				break;
			case 'gitStatus':
				panelData.git = msg; renderAuxiliary();
				// A repository with a clean tree still shows its branch and +0 −0.
				gitUi.data = msg.error || !Array.isArray(msg.changes) ? null : msg;
				gitUi.noRepo = !!msg.error;
				gitUi.fetched = true;
				if (msg.branch) gitUi.branch = msg.branch;
				renderGitTools();
				break;
			case 'gitBranches':
				gitUi.branches = msg.branches || [];
				if (msg.current) gitUi.branch = msg.current;
				if (ui.branchAnchor) {
					if (ui.branchAnchor.isConnected) branchMenu(ui.branchAnchor, gitUi.branches, msg.current || (state.workspace && state.workspace.branch));
					ui.branchAnchor = null;
				}
				renderGitTools();
				break;
			case 'textAssistResult': {
				const resolve = assistWaiters.get(msg.requestId);
				if (resolve) {
					assistWaiters.delete(msg.requestId);
					resolve(msg);
				}
				break;
			}
			case 'micText':
				// Side Chat takes the words while it holds the microphone.
				if (window.SideChat?.dictation?.(msg.text || '', !!msg.provisional)) break;
				appendDictation(msg.text || '', !!msg.provisional);
				break;
			case 'micLevel':
				micLevel(Number(msg.level) || 0);
				break;
			case 'micError':
				micProblem(String(msg.error || 'Dictation failed.'), !!msg.blocked);
				break;
			case 'sound':
				chime(msg.kind);
				break;
			case 'studioState':
				ui.studio = msg.studio || null;
				// The host keeps the pick (page storage is per launch in the desktop app).
				if (ui.studio && 'picked' in ui.studio) {
					const pk = ui.studio.picked;
					const same = (pk && pk.id) === (ui.media && ui.media.id);
					if (!same) {
						ui.media = pk && pk.id ? { id: pk.id, name: pk.name, kind: pk.kind } : null;
						saveUi();
						renderComposer();
					}
				}
				// A picked image / video model that was deleted: back to the chat model.
				if (ui.media && ui.studio && !ui.studio.bundles.concat(ui.studio.voices || []).some((b) => b.id === ui.media.id && b.installed)) {
					ui.media = null;
					saveUi();
					renderComposer();
				}
				if (media && media.busy) paintProgress();
				if (el.modelMenu && !el.modelMenu.classList.contains('hidden') && el.modelMenu.childElementCount) renderModelMenu();
				break;
			case 'localJob': {
				const job = msg.job;
				if (!job || !/^(studio|voice):/.test(job.key)) break;
				ui.mediaJobs = ui.mediaJobs || {};
				if (job.done) delete ui.mediaJobs[job.key];
				else ui.mediaJobs[job.key] = job;
				if (el.modelMenu && !el.modelMenu.classList.contains('hidden') && el.modelMenu.childElementCount) renderModelMenu();
				break;
			}
			case 'mediaModel':
				ui.media = { id: msg.id, name: msg.name, kind: msg.kind };
				saveUi();
				renderComposer();
				break;
			case 'studioBusy':
				// Only the newest request counts (a stopped one may still answer).
				if (!media || msg.source !== 'chat' || msg.rid !== media.rid) break;
				if (!media.busy) break;
				media.busy.status = msg.status;
				paintProgress();
				break;
			case 'studioResult': {
				if (!media || msg.source !== 'chat' || msg.rid !== media.rid) break;
				clearInterval(media.timer);
				media.busy = null;
				const bin = atob(msg.b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const sizeTxt = Array.isArray(msg.size) ? msg.size.join('×') + ' · ' : '';
				media.results.push({ id: msg.id, kind: msg.kind, prompt: msg.prompt, name: msg.name, url: URL.createObjectURL(new Blob([bytes], { type: msg.mime })), meta: sizeTxt + (msg.audioSeconds ? Math.round(msg.audioSeconds) + ' s of speech · ' : '') + 'made in ' + fmtSecs(msg.seconds || 1) });
				media.view = media.results.length - 1;
				renderMediaPopup();
				break;
			}
			case 'studioError':
				if (!media || msg.source !== 'chat' || msg.rid !== media.rid) break;
				clearInterval(media.timer);
				media.busy = null;
				media.view = -1;
				media.error = msg.error || 'The generation failed.';
				renderMediaPopup();
				break;
			case 'engineState':
				ui.engine = msg.engine || null;
				if (el.modelMenu && !el.modelMenu.hidden && el.modelMenu.childElementCount) renderModelMenu();
				break;
			case 'status':
				toast(msg.message, msg.kind);
				break;
			
			case 'openSettings':
				if (window.Settings) window.Settings.open(msg.section);
				break;
			case 'fsArrive':
				if (!FS && !reducedMotion()) {
					document.body.classList.remove('fs-arrive');
					void document.body.offsetWidth;
					document.body.classList.add('fs-arrive');
					setTimeout(() => document.body.classList.remove('fs-arrive'), 700);
				}
				break;
			case 'focusInput':
				el.input.focus();
				break;
			case 'discardComposerDraft':
				discardComposerDraft(msg.sessionId);
				break;
			case 'prefill':
				el.input.value = String(msg.text || '');
				autosize();
				renderComposer();
				el.input.focus();
				break;
			
		}
	});

	// ------------------------------------------------------------ boot

	// ---------------------------------------------------------- Full screen (Terminal theme)
	// The ⛶ button opens this chat as a full-screen page (fullscreenChat.ts).
	// There, a banner slides down from the top edge (exit, layers, chat
	// actions) and layers open beside the chat: the workspace Files tree and
	// a read-only preview of a file.
	const FS = document.body.classList.contains('fullscreen');
	const fsUi = { files: false, filter: '', open: new Set(), preview: null, hideTimer: 0, frame: 0, rootName: 'workspace' };

	function fsToggle(on) {
		if (B.desktop) {
			post({ type: 'fullscreen', on: on === undefined ? !document.body.classList.contains('zc-native-fullscreen') : on });
			return;
		}
		const want = on === undefined ? !FS : on;
		// Leaving: fold the screen shut first (like closing a foldable), then tell the host.
		if (FS && !want && !reducedMotion()) {
			if (document.body.classList.contains('fs-folding')) return;
			document.body.classList.remove('fs-unfolding');
			document.body.classList.add('fs-folding');
			setTimeout(() => post({ type: 'fullscreen', on: false }), 700);
			return;
		}
		post({ type: 'fullscreen', on: want });
	}
	function reducedMotion() {
		return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}
	window.__fsExit = () => fsToggle(false);
	/** The fold / unfold overlay: two screen halves on a hinge. */
	if (FS) {
		const flip = h('div', 'fs-flip');
		flip.setAttribute('aria-hidden', 'true');
		flip.innerHTML = '<i class="ff-l"><span></span></i><i class="ff-r"><span></span></i><b class="ff-hinge"></b>';
		document.body.appendChild(flip);
		if (!reducedMotion()) {
			document.body.classList.add('fs-unfolding');
			setTimeout(() => document.body.classList.remove('fs-unfolding'), 1100);
		}
	}

	/** Paths the agent edited (M) or read (•) in this chat — marked in the tree. */
	function fsMarks() {
		const edited = new Set();
		const read = new Set();
		for (const m of state.messages) {
			const a = m.approval;
			if (a && a.path && a.status === 'applied' && !a.failed && (a.kind === 'edit' || a.kind === 'write' || a.kind === 'patch')) edited.add(String(a.path).replace(/\\/g, '/'));
			if (m.tool && m.tool.name === 'read_file' && m.tool.arg) read.add(String(m.tool.arg).replace(/\\/g, '/').replace(/:\d+(-\d+)?$/, ''));
		}
		return { edited, read };
	}

	function fsTree() {
		const root = { dirs: new Map(), files: [] };
		for (const p of ui.files || []) {
			const parts = p.split('/');
			let node = root;
			for (let i = 0; i < parts.length - 1; i++) {
				if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
				node = node.dirs.get(parts[i]);
			}
			node.files.push(parts[parts.length - 1]);
		}
		return root;
	}

	function fsRenderTree() {
		const list = $('fs-tree');
		if (!list || !fsUi.files) return;
		const marks = fsMarks();
		const mark = (path) => (marks.edited.has(path) ? '<i class="fs-mark m" title="Edited by the agent">M</i>' : marks.read.has(path) ? '<i class="fs-mark r" title="Read by the agent">•</i>' : '');
		const active = fsUi.preview && fsUi.preview.path;
		let rows = '';
		let count = 0;
		const q = fsUi.filter.trim().toLowerCase();
		if (!(ui.files || []).length) {
			list.innerHTML = '<div class="fs-empty">' + (ui.files ? 'No files in this workspace.' : '<span class="spinner"></span> Reading the workspace…') + '</div>';
			return;
		}
		if (q) {
			const hits = ui.files.filter((p) => p.toLowerCase().includes(q)).slice(0, 400);
			rows = hits.map((p) => '<button class="fs-row file' + (p === active ? ' active' : '') + '" data-fs-file="' + esc(p) + '" title="' + esc(p) + '">' + I('file') + '<span class="fs-name">' + esc(basename(p)) + '</span><span class="fs-dir">' + esc(p.split('/').slice(0, -1).join('/')) + '</span>' + mark(p) + '</button>').join('');
			list.innerHTML = rows || '<div class="fs-empty">No file matches “' + esc(fsUi.filter) + '”.</div>';
			return;
		}
		const walk = (node, prefix, pre) => {
			const dirs = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
			const files = node.files.slice().sort((a, b) => a.localeCompare(b));
			const total = dirs.length + files.length;
			let i = 0;
			for (const d of dirs) {
				if (count > 1500) return;
				const last = ++i === total;
				const path = prefix + d;
				const open = fsUi.open.has(path);
				const edited = [...marks.edited].some((p) => p.startsWith(path + '/'));
				rows += '<button class="fs-row dir' + (open ? ' open' : '') + '" data-fs-dir="' + esc(path) + '"><span class="fs-pre">' + pre + (last ? '└─' : '├─') + '</span>' + I(open ? 'chevronDown' : 'chevronRight') + '<span class="fs-name">' + esc(d) + '/</span>' + (edited ? '<i class="fs-mark m dot" title="Contains edits"></i>' : '') + '</button>';
				count++;
				if (open) walk(node.dirs.get(d), path + '/', pre + (last ? '&nbsp;&nbsp;' : '│&nbsp;'));
			}
			for (const f of files) {
				if (count > 1500) return;
				const last = ++i === total;
				const path = prefix + f;
				rows += '<button class="fs-row file' + (path === active ? ' active' : '') + '" data-fs-file="' + esc(path) + '" title="' + esc(path) + '"><span class="fs-pre">' + pre + (last ? '└─' : '├─') + '</span>' + I('file') + '<span class="fs-name">' + esc(f) + '</span>' + mark(path) + '</button>';
				count++;
			}
		};
		walk(fsTree(), '', '');
		list.innerHTML = rows + (count > 1500 ? '<div class="fs-empty">…more — type to filter.</div>' : '');
		if (fsUi.cascade && count) {
			fsUi.cascade = false;
			list.classList.remove('fs-anim');
			void list.offsetWidth;
			list.classList.add('fs-anim');
		}
	}
	function fsScheduleTree() {
		if (!fsUi.files || fsUi.frame) return;
		fsUi.frame = requestAnimationFrame(() => {
			fsUi.frame = 0;
			fsRenderTree();
		});
	}

	function fsLayers() {
		document.body.classList.toggle('fs-files-open', fsUi.files);
		document.body.classList.toggle('fs-preview-open', !!fsUi.preview);
		for (const b of document.querySelectorAll('[data-fs="files"]')) b.classList.toggle('active', fsUi.files);
	}

	function fsOpenFiles(on) {
		fsUi.files = on === undefined ? !fsUi.files : on;
		if (fsUi.files) fsUi.cascade = true;
		if (fsUi.files) {
			if (!ui.files || !ui.files.length) post({ type: 'getFiles' });
			fsRenderTree();
			setTimeout(() => $('fs-filter') && $('fs-filter').focus(), 60);
		}
		fsLayers();
	}

	function fsPreview(path) {
		fsUi.preview = { path, loading: true };
		post({ type: 'previewFile', path, sessionId: state.currentSessionId });
		fsRenderPreview();
		fsLayers();
		fsScheduleTree();
	}

	/** In the desktop app there is no editor behind the page: files open in the in-app
	 * viewer (its "Open" button is the hand-off). In VS Code they open in the editor. */
	function openWorkspaceFile(path) {
		if (document.body.classList.contains('desktop')) auxOpenPreview(path);
		else post({ type: 'openFile', path });
	}

	/** Extension → the name the viewer's status bar shows, editor-style. */
	const FILE_LANG = { js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', json: 'JSON', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', xml: 'XML', md: 'Markdown', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', php: 'PHP', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', yml: 'YAML', yaml: 'YAML', toml: 'TOML', sql: 'SQL', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin', vue: 'Vue', svelte: 'Svelte', lua: 'Lua', dart: 'Dart' };

	/** The read-only body of a file preview: code with a line gutter, or an empty state. */
	function fsPreviewBody(p) {
		const ext = (p.path.match(/\.([\w]+)$/) || [])[1] || 'text';
		if (p.loading) return '<div class="fs-empty"><span class="spinner"></span> Opening…</div>';
		if (p.error) return '<div class="fs-empty">' + I('alert') + ' ' + esc(p.error) + '</div>';
		if (p.binary) return '<div class="fs-empty">' + I('file') + ' Binary file (' + Math.round(p.size / 1024) + ' KB) — no preview.</div>';
		const longest = Math.max(2, ...((p.content.match(/`+/g) || []).map((s) => s.length)));
		const fence = '`'.repeat(longest + 1);
		const count = p.content.split('\n').length;
		let gutter = '';
		for (let i = 1; i <= count; i++) gutter += i + '\n';
		return '<div class="fsp-code"><pre class="fsp-gutter" aria-hidden="true">' + gutter + '</pre><div class="fsp-body">' + MD.render(fence + ext + '\n' + p.content + '\n' + fence) + '</div></div>' + (p.truncated ? '<div class="fs-empty">Showing the first 2,000 of ' + p.lines + ' lines.</div>' : '');
	}

	/** Editor-tab header shared by the full-screen viewer and the Explorer panel. */
	function fsPreviewHead(p, opts) {
		const dir = p.path.split('/').slice(0, -1).join('/');
		const lineBadge = p.line ? '<small class="fsp-line">:' + p.line + '</small>' : '';
		return '<span class="fsp-tab" title="' + esc(p.path + (p.line ? ':' + p.line : '')) + '">' + I('file') + '<b>' + esc(basename(p.path)) + lineBadge + '</b>' + (dir ? '<i class="fsp-crumb">' + esc(dir) + '</i>' : '') + '</span>' +
			'<span class="fsp-spring"></span>' + (opts || '');
	}

	function fsPreviewStatus(p) {
		const ext = ((p.path.match(/\.([\w]+)$/) || [])[1] || 'text').toLowerCase();
		const lang = FILE_LANG[ext] || ext.toUpperCase();
		return '<div class="fsp-status">' +
			'<span class="fsp-lang">' + esc(lang) + '</span>' +
			(p.line ? '<span>Line ' + p.line + '</span>' : '') +
			(p.lines ? '<span>' + p.lines + ' lines</span>' : '') +
			(p.size ? '<span>' + (p.size >= 1024 ? (p.size / 1024).toFixed(1) + ' KB' : p.size + ' B') + '</span>' : '') +
			'<span>UTF-8</span>' +
		'</div>';
	}

	function fsRenderPreview() {
		const box = $('fs-preview');
		const p = fsUi.preview;
		if (!box) return;
		if (!p) { box.replaceChildren(); return; }
		box.innerHTML =
			'<div class="fsp-head">' +
				fsPreviewHead(p,
					'<button class="fsp-btn" data-fs-mention title="Mention this file in your message">@ Mention</button>' +
					'<button class="fsp-btn" data-fs-open title="Open in the VS Code editor">' + I('link') + 'Open</button>' +
					'<button class="icon-btn" data-fs-close-preview title="Close preview" aria-label="Close preview">' + I('close') + '</button>') +
			'</div>' +
			'<div class="fsp-scroll">' + fsPreviewBody(p) + '</div>' +
			fsPreviewStatus(p);
		const block = box.querySelector('.code-block');
		if (block) {
			block.classList.remove('long');
			block.classList.add('open');
			const exp = block.querySelector('.code-expand');
			if (exp) exp.remove();
		}
	}

	function explorerBreadcrumbs(path) {
		const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
		return '<nav class="explorer-breadcrumbs" aria-label="File path"><button type="button" data-aux-breadcrumb="" title="Workspace root">' + esc(state.workspace?.name || 'Workspace') + '</button>' + parts.map((part, i) => '<span aria-hidden="true">›</span>' + (i === parts.length - 1 ? '<span aria-current="page">' + esc(part) + '</span>' : '<button type="button" data-aux-breadcrumb="' + esc(parts.slice(0, i + 1).join('/')) + '">' + esc(part) + '</button>')).join('') + '</nav>';
	}
	function focusExplorerDirectory(path) {
		const parts = path.split('/').filter(Boolean);
		for (let i = 1; i <= parts.length; i++) auxFiles.open.add(parts.slice(0, i).join('/'));
		auxFiles.preview = null; auxFiles.filter = ''; auxFiles.editedOnly = false;
		renderExplorer(); saveDocumentView();
		const row = [...$('aux-explorer-tree').querySelectorAll('[data-aux-tree-dir]')].find(node => node.dataset.auxTreeDir === path);
		(row || $('aux-explorer-filter'))?.focus(); row?.scrollIntoView?.({ block: 'nearest' });
	}
	/** The Explorer tab's in-panel viewer: the file opens right inside Work Details. */
	function renderAuxPreview(p) {
		const box = $('aux-explorer-preview');
		if (!box) return;
		box.innerHTML =
			'<div class="fsp-head aux-fsp-head">' +
				fsPreviewHead(p,
					'<button class="icon-btn" data-aux-open-editor title="Open in external editor" aria-label="Open in external editor">' + I('link') + '</button>' +
					'<button class="icon-btn" data-aux-max-preview title="Open in a window" aria-label="Open the file in a window">' + I('expand') + '</button>' +
					'<button class="icon-btn" data-aux-close-preview title="Back to the file tree" aria-label="Back to the file tree">' + I('back') + '</button>') +
			'</div>' + explorerBreadcrumbs(p.path) +
			'<div class="fsp-scroll">' + fsPreviewBody(p) + '</div>' +
			fsPreviewStatus(p);
		for (const button of box.querySelectorAll('[data-aux-breadcrumb]')) button.addEventListener('click', () => focusExplorerDirectory(button.dataset.auxBreadcrumb));
		const block = box.querySelector('.code-block');
		if (block) {
			block.classList.remove('long');
			block.classList.add('open');
			const exp = block.querySelector('.code-expand');
			if (exp) exp.remove();
		}
		if (p.line) {
			const scroll = box.querySelector('.fsp-scroll');
			if (scroll) {
				const gutter = scroll.querySelector('.fsp-gutter');
				const totalLines = p.lines || (p.content ? p.content.split('\n').length : 1);
				const lineHeight = gutter && totalLines > 0 ? gutter.scrollHeight / totalLines : 18.75;
				scroll.scrollTop = Math.max(0, (p.line - 1) * lineHeight - (scroll.clientHeight / 3));
			}
		}
		const scroll = box.querySelector('.fsp-scroll');
		if (scroll) {
			if (typeof p.scrollTop === 'number') scroll.scrollTop = p.scrollTop;
			scroll.addEventListener('scroll', () => { p.scrollTop = scroll.scrollTop; }, { passive: true });
		}
	}

	/** The maximized file: a window over the app; X (or Esc, or the backdrop) closes it
	 *  and the file stays open in the Explorer panel underneath. */
	function auxMaxRender() {
		const win = document.getElementById('aux-max-win');
		const p = auxFiles.preview;
		if (!win || !p) return;
		win.innerHTML =
			'<div class="fsp-head">' +
				fsPreviewHead(p,
					'<button class="icon-btn" data-aux-open-editor title="Open in external editor" aria-label="Open in external editor">' + I('link') + '</button>' +
					'<button class="icon-btn" data-aux-max-close title="Close the window" aria-label="Close the window">' + I('close') + '</button>') +
			'</div>' +
			'<div class="fsp-scroll">' + fsPreviewBody(p) + '</div>' +
			fsPreviewStatus(p);
		const block = win.querySelector('.code-block');
		if (block) {
			block.classList.remove('long');
			block.classList.add('open');
			const exp = block.querySelector('.code-expand');
			if (exp) exp.remove();
		}
		if (p.line) {
			const scroll = win.querySelector('.fsp-scroll');
			if (scroll) {
				const gutter = scroll.querySelector('.fsp-gutter');
				const totalLines = p.lines || (p.content ? p.content.split('\n').length : 1);
				const lineHeight = gutter && totalLines > 0 ? gutter.scrollHeight / totalLines : 18.75;
				scroll.scrollTop = Math.max(0, (p.line - 1) * lineHeight - (scroll.clientHeight / 3));
			}
		}
	}
	function auxMaxOpen() {
		if (!auxFiles.preview || document.getElementById('aux-max')) return;
		auxFiles.max = true;
		const back = document.createElement('div');
		back.className = 'aux-max';
		back.id = 'aux-max';
		back.innerHTML = '<div class="aux-max-win" id="aux-max-win" role="dialog" aria-modal="true" aria-label="File preview window"></div>';
		document.body.appendChild(back);
		back.addEventListener('click', (e) => {
			const t = e.target;
			if (t === back || (t instanceof Element && t.closest('[data-aux-max-close]'))) {
				e.preventDefault();
				auxMaxClose();
			} else if (t instanceof Element && t.closest('[data-aux-open-editor]')) {
				e.preventDefault();
				if (auxFiles.preview && auxFiles.preview.path) {
					post({ type: 'openFile', path: auxFiles.preview.path, line: auxFiles.preview.line });
				}
			}
		});
		auxMaxRender();
	}
	function auxMaxClose() {
		auxFiles.max = false;
		const box = document.getElementById('aux-max');
		if (box) box.remove();
		// Back to the integrated panel viewer underneath.
		renderExplorer();
	}

	function fsRenderBanner() {
		const b = $('fs-banner');
		if (!b) return;
		const working = state.isStreaming;
		const model = (state.selection && state.selection.model) || '';
		b.innerHTML =
			'<div class="fsb-left"><button class="fsb-icon" data-fs="projects" title="Projects and chats">' + I('sidebar') + '</button><span class="fsb-logo brand-logo"></span><span class="fsb-title" id="fsb-title">' + esc(el.title.textContent || 'New chat') + '</span>' +
			'<span class="fsb-status' + (working ? ' on' : '') + '"><i></i>' + (working ? 'Working' : 'Ready') + (model ? '<em>' + esc(model) + '</em>' : '') + '</span></div>' +
			'<div class="fsb-mid"><div class="fsb-seg-ctl">' +
			'<button class="fsb-tab' + (!fsUi.files ? ' active' : '') + '" data-fs="chat">' + I('chat') + '<span>Chat</span></button>' +
			'<button class="fsb-tab' + (fsUi.files ? ' active' : '') + '" data-fs="files" title="Ctrl+Alt+E">' + I('folder') + '<span>Files</span></button>' +
			'</div></div>' +
			'<div class="fsb-right">' +
			'<button class="fsb-icon" data-fs="auxiliary" title="Work details">' + I('panelRight') + '</button>' +
			'<button class="fsb-icon" data-fs="history" title="Chats">' + I('history') + '</button>' +
			'<button class="fsb-icon" data-fs="new" title="New chat">' + I('newChat') + '</button>' +
			'<button class="fsb-icon" data-fs="settings" title="Settings">' + I('gear') + '</button>' +
			'<button class="fsb-exit" data-fs="exit" title="Exit full screen — the agent keeps working">' + I('minimize') + '<span>Exit</span><kbd>Esc</kbd></button>' +
			'</div>';
	}

	function fsShowBanner(ms) {
		const b = $('fs-banner');
		if (!b) return;
		b.classList.add('show');
		clearTimeout(fsUi.hideTimer);
		if (ms) fsUi.hideTimer = setTimeout(() => !b.matches(':hover, :focus-within') && b.classList.remove('show'), ms);
	}

	if ($('btn-fullscreen')) $('btn-fullscreen').addEventListener('click', () => fsToggle(B.desktop ? undefined : true));
	document.addEventListener('keydown', (e) => {
		if (!e.ctrlKey || !e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 'f') {
			e.preventDefault();
			fsToggle();
		} else if (k === 'e' && FS) {
			e.preventDefault();
			fsOpenFiles();
		}
	});
	if (FS) {
		fsRenderBanner();
		setTimeout(() => fsShowBanner(3200), 400);
		document.addEventListener('mousemove', (e) => {
			if (e.clientY <= 8) fsShowBanner();
		});
		const banner = $('fs-banner');
		banner.addEventListener('mouseleave', () => {
			clearTimeout(fsUi.hideTimer);
			fsUi.hideTimer = setTimeout(() => !banner.matches(':focus-within') && banner.classList.remove('show'), 700);
		});
		banner.addEventListener('focusout', () => setTimeout(() => !banner.matches(':hover, :focus-within') && banner.classList.remove('show'), 300));
		$('fs-hot').addEventListener('click', () => fsShowBanner(4000));
		banner.addEventListener('click', (e) => {
			const t = e.target instanceof Element ? e.target.closest('[data-fs]') : null;
			if (!t) return;
			const act = t.dataset.fs;
			if (act === 'exit') fsToggle(false);
			else if (act === 'files') fsOpenFiles();
			else if (act === 'projects') togglePanel('sidebar');
			else if (act === 'auxiliary') togglePanel('auxiliary');
			else if (act === 'history') $('btn-history').click();
			else if (act === 'new') $('btn-new').click();
			else if (act === 'settings') $('btn-settings').click();
			else if (act === 'chat') fsOpenFiles(false);
			fsRenderBanner();
		});
		const files = $('fs-files');
		files.innerHTML =
			'<div class="fsf-head"><span class="fsf-title">' + I('folder') + 'EXPLORER</span><span class="grow"></span><button class="icon-btn" data-fsf="refresh" title="Refresh">' + I('refresh') + '</button><button class="icon-btn" data-fsf="collapse" title="Collapse all">' + I('minimize') + '</button><button class="icon-btn" data-fsf="close" title="Close (Ctrl+Alt+E)">' + I('close') + '</button></div>' +
			'<div class="fsf-search">' + I('search') + '<input id="fs-filter" placeholder="Filter files…" spellcheck="false" autocomplete="off"></div>' +
			'<div class="fsf-legend"><span><i class="fs-mark m">M</i>edited by the agent</span><span><i class="fs-mark r">•</i>read</span></div>' +
			'<div class="fs-tree" id="fs-tree"></div>';
		files.addEventListener('input', (e) => {
			if (e.target.id !== 'fs-filter') return;
			fsUi.filter = e.target.value;
			fsRenderTree();
		});
		files.addEventListener('click', (e) => {
			const t = e.target instanceof Element ? e.target : null;
			if (!t) return;
			let n;
			if ((n = t.closest('[data-fs-dir]'))) {
				const p = n.dataset.fsDir;
				fsUi.open.has(p) ? fsUi.open.delete(p) : fsUi.open.add(p);
				fsRenderTree();
			} else if ((n = t.closest('[data-fs-file]'))) fsPreview(n.dataset.fsFile);
			else if ((n = t.closest('[data-fsf]'))) {
				if (n.dataset.fsf === 'close') fsOpenFiles(false);
				else if (n.dataset.fsf === 'collapse') {
					fsUi.open.clear();
					fsRenderTree();
				} else {
					ui.files = null;
					fsRenderTree();
					post({ type: 'getFiles' });
				}
			}
		});
		$('fs-preview').addEventListener('click', (e) => {
			const t = e.target instanceof Element ? e.target : null;
			if (!t || !fsUi.preview) return;
			if (t.closest('[data-fs-close-preview]')) {
				fsUi.preview = null;
				fsLayers();
				fsScheduleTree();
			} else if (t.closest('[data-fs-open]')) post({ type: 'openFile', path: fsUi.preview.path });
			else if (t.closest('[data-fs-mention]')) {
				const tag = '@' + fsUi.preview.path + ' ';
				el.input.value = (el.input.value && !/\s$/.test(el.input.value) ? el.input.value + ' ' : el.input.value) + tag;
				autosize();
				renderComposer();
				el.input.focus();
			}
		});
	}

	// ---------------------------------------------------------- Status panel
	// One card over the top-right of the chat (ZCode's status panel): Git tools
	// (working-tree changes with +/− line stats, the branch to switch or create,
	// a commit hint), the task this turn works on (state, time, tokens) and the
	// progress checklist. "Changes" opens a review drawer listing every file; a
	// row opens the HEAD ↔ working tree diff. All numbers are real git
	// (status --porcelain + diff HEAD --numstat) and the turn's own usage.
	const gitUi = { data: null, branch: null, branches: null, open: false, pinned: false, review: false, menu: false, filter: '', timer: 0, hideTimer: 0, fold: new Set(), closed: false, docked: false, noRepo: false, fetched: false, asked: false };

	function gitFetch() {
		post({ type: 'getGitStatus' });
	}
	function gitShow(on) {
		gitUi.open = !!on;
		clearTimeout(gitUi.hideTimer);
		if (on && !gitUi.timer) {
			gitUi.timer = setInterval(() => {
				if (state.isStreaming || gitUi.review) gitFetch();
			}, 5000);
			gitFetch();
		}
		if (!on) {
			clearInterval(gitUi.timer);
			gitUi.timer = 0;
			gitUi.review = false;
			gitUi.menu = false;
		}
		renderGitTools();
	}
	function gitTurnStart() {
		gitShow(true);
	}
	function gitTurnEnd() {
		gitFetch();
		if (!gitUi.pinned && !gitUi.review) gitUi.hideTimer = setTimeout(() => gitShow(false), 10000);
	}
	function gitAction(a) {
		// ZCode's two states: the expanded card and the one-line capsule; either choice overrides "auto".
		if (a === 'mini' || a === 'panel') gitUi.variant = a;
		else if (a === 'changes') {
			gitUi.review = !gitUi.review;
			if (gitUi.review) gitFetch();
		} else if (a === 'branch') {
			gitUi.menu = !gitUi.menu;
			if (gitUi.menu) post({ type: 'gitBranches' });
		} else if (a === 'commit') {
			el.input.value = 'Commit the current changes' + (gitUi.branch ? ' on ' + gitUi.branch : '') + ' and push.';
			autosize();
			renderComposer();
			el.input.focus();
		} else if (a.startsWith('fold:')) {
			const key = a.slice(5);
			if (gitUi.fold.has(key)) gitUi.fold.delete(key);
			else gitUi.fold.add(key);
		}
		if (a !== 'branch') gitUi.menu = false;
		renderGitTools();
	}
	const fmtStat = (n) => (n >= 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
	const spHead = (key, title, meta) =>
		'<div class="sp-head"><button class="sp-title" data-gt="fold:' + key + '" aria-expanded="' + !gitUi.fold.has(key) + '"><span>' + esc(title) + '</span>' + I('chevronDown') + '</button>' + (meta ? '<span class="sp-meta">' + meta + '</span>' : '') + '</div>';

	function gitEnsure() {
		let card = $('git-tools');
		if (card) return card;
		const column = el.messages.closest('.primary-chat');
		card = h('div', 'git-tools status-panel');
		card.id = 'git-tools';
		card.setAttribute('role', 'region');
		card.setAttribute('aria-label', 'Status');
		card.innerHTML =
			'<div class="sp-tools"><button class="gt-ib" data-gt="mini" title="Collapse to summary" aria-label="Collapse the status panel">' + I('minimize') + '</button></div>' +
			'<button class="sp-mini" id="sp-mini" data-gt="panel" title="Show panel" aria-label="Show the status panel"></button>' +
			'<div class="sp-scroll"><section class="sp-sec sp-flow" id="sp-flow" hidden></section><section class="sp-sec sp-git" id="sp-git"></section><section class="sp-sec sp-task" id="sp-task"></section><div class="sp-sec sp-progress" id="sp-progress"></div><section class="sp-sec sp-steps" id="sp-steps" hidden></section></div>';
		card.addEventListener('click', (e) => {
			const t = e.target instanceof Element ? e.target : null;
			if (!t) return;
			const b = t.closest('[data-gt-branch]');
			if (b && !b.classList.contains('current')) {
				post({ type: 'gitCheckout', name: b.dataset.gtBranch });
				gitUi.menu = false;
				renderGitTools();
				return;
			}
			const r = t.closest('[data-gt]');
			if (r) gitAction(r.dataset.gt);
		});
		card.addEventListener('input', (e) => {
			if (e.target.id === 'gt-branch-filter') {
				gitUi.filter = e.target.value;
				gitRenderBranchList();
			}
		});
		card.addEventListener('keydown', (e) => {
			if (e.target.id === 'gt-new-branch' && e.key === 'Enter') {
				const name = e.target.value.trim();
				if (name) {
					post({ type: 'gitCheckout', name, create: true });
					gitUi.menu = false;
					gitUi.filter = '';
					renderGitTools();
				}
			}
		});
		const review = h('aside', 'git-review');
		review.id = 'git-review';
		review.setAttribute('aria-label', 'Working tree changes');
		review.addEventListener('click', (e) => {
			const t = e.target instanceof Element ? e.target : null;
			if (!t) return;
			let n;
			if (t.closest('[data-gr="close"]')) {
				gitUi.review = false;
				if (!gitUi.pinned && !state.isStreaming) gitUi.hideTimer = setTimeout(() => gitShow(false), 10000);
				renderGitTools();
			} else if (t.closest('[data-gr="refresh"]')) gitFetch();
			else if ((n = t.closest('[data-gr-open]'))) post({ type: 'gitOpenDiff', path: n.dataset.grOpen });
		});
		column.appendChild(card);
		column.appendChild(review);

		// Dock beside the transcript once the chat column is wide enough to share.
		gitUi.docked = column.clientWidth >= SP_DOCK_MIN;
		new ResizeObserver(() => {
			const docked = column.clientWidth >= SP_DOCK_MIN;
			if (docked !== gitUi.docked) {
				gitUi.docked = docked;
				renderGitTools();
			}
		}).observe(column);
		return card;
	}

	function gitRenderBranchList() {
		const list = $('gtm-list');
		if (!list) return;
		const q = gitUi.filter.trim().toLowerCase();
		const hits = (gitUi.branches || []).filter((b) => !q || b.toLowerCase().includes(q));
		list.innerHTML =
			hits.map((b) => '<button class="gtm-row' + (b === gitUi.branch ? ' current' : '') + '" data-gt-branch="' + esc(b) + '">' + I('branch') + '<span>' + esc(b) + '</span>' + (b === gitUi.branch ? '<i class="gtm-cur">' + I('check') + '</i>' : '') + '</button>').join('') ||
			'<div class="gtm-empty">No branch matches “' + esc(gitUi.filter) + '”.</div>';
	}

	/** The latest prompt as the panel's task: its state, its time so far and the tokens it used. */
	function statusTask() {
		const msgs = state.messages;
		let u = null;
		for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i].kind) { u = msgs[i]; break; }
		if (!u) return null;
		const turn = u.turn || {};
		const live = !!state.isStreaming;
		const started = turn.startedAt || (live ? ui.streamStartedAt : 0);
		const ended = live ? Date.now() : turn.endedAt || 0;
		const usage = turn.usage || {};
		const title = String(u.content || '').replace(/\s+/g, ' ').trim();
		return { title: title.length > 140 ? title.slice(0, 140) + '…' : title, ms: started && ended > started ? ended - started : 0, tokens: (usage.input || 0) + (usage.output || 0), live };
	}

	function renderStatusTask() {
		const box = $('sp-task');
		const card = $('git-tools');
		if (!box || !card || !card.classList.contains('on')) return;
		const task = statusTask();
		box.hidden = !task || !task.title;
		if (box.hidden) return;
		const pg = ui.progressInfo;
		// A /goal outranks the last prompt: it says what "done" means and how many rounds are left.
		const goal = state.goal;
		if (goal) task.title = goal.objective;
		const complete = goal ? goal.status === 'met' : !task.live && (!pg || pg.done === pg.total);
		const label = task.live ? (state.runState === 'waiting' ? 'Waiting' : 'Working') : goal ? { active: 'Paused', met: 'Met', stopped: 'Stopped', unverified: 'Unverified' }[goal.status] || 'Paused' : complete ? 'Complete' : 'Paused';
		const stats = [goal && goal.status === 'active' ? goal.rounds + '/' + goal.maxRounds + ' rounds used' : '', goal && goal.check ? 'check: ' + goal.check : '', pg ? pg.done + '/' + pg.total : '', task.ms >= 1000 ? fmtDuration(task.ms) : '', task.tokens ? fmtTokens(task.tokens) + ' tokens' : ''].filter(Boolean).join(' · ');
		const sig = [label, task.title, gitUi.fold.has('task')].join('|');
		if (box.dataset.sig !== sig) {
			box.dataset.sig = sig;
			box.classList.toggle('folded', gitUi.fold.has('task'));
			box.classList.toggle('live', task.live);
			box.innerHTML =
				spHead('task', 'Goal','<span class="sp-state ' + label.toLowerCase() + '">' + esc(label) + '</span>') +
				'<div class="sp-body"><div class="sp-task-row"><span class="sp-task-ico">' + (complete ? I('check') : I('target')) + '</span>' +
				'<span class="sp-task-text"><span class="sp-task-title" title="' + esc(task.title) + '">' + esc(task.title) + '</span><span class="sp-task-stats"></span></span></div></div>';
		}
		const s = box.querySelector('.sp-task-stats');
		if (s && s.textContent !== stats) s.textContent = stats;
	}

	/**
	 * ZCode's status panel: an expanded card or a one-line capsule ("mini"). On "auto"
	 * it is expanded while the chat is wide enough to dock it beside the transcript
	 * (which makes room), and a capsule otherwise; either button overrides that.
	 */
	const SP_DOCK_MIN = 980;
	const spMode = () => gitUi.variant || (gitUi.docked ? 'panel' : 'mini');
	function statusPanelShown() {
		return state.messages.length > 0;
	}
	/** The steps of the latest turn, for the Progress section when the model kept no checklist. */
	function turnSteps() {
		const msgs = state.messages;
		const steps = [];
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role === 'user' && !m.kind) break;
			if (m.tool && !m.todos) {
				const v = TOOL_VERBS[m.tool.name];
				const running = m.tool.status === 'running';
				const arg = PATH_TOOLS.has(m.tool.name) ? basename(m.tool.arg) : m.tool.arg;
				steps.unshift({ text: (v ? v[running ? 0 : 1] : toolMeta(m.tool.name)[1]) + (arg ? ' ' + arg : ''), state: running ? 'current' : m.tool.status === 'error' ? 'failed' : 'done' });
			} else if (m.approval && m.approval.status !== 'pending') {
				const a = m.approval, phase = approvalPhase(a);
				const verb = a.kind === 'command' ? ['Running', 'Ran'] : a.kind === 'mcp' ? ['Calling', 'Called'] : a.kind === 'write' ? ['Writing', a.existed ? 'Rewrote' : 'Wrote'] : ['Editing', 'Edited'];
				const arg = a.kind === 'command' ? (a.command || '').replace(/\s+# background$/, '') : a.kind === 'mcp' ? a.tool || '' : basename(a.path || '');
				steps.unshift({ text: verb[phase === 'running' ? 0 : 1] + (arg ? ' ' + arg : ''), state: phase === 'running' ? 'current' : phase === 'success' ? 'done' : 'failed' });
			}
		}
		return steps;
	}
	function renderSteps(show) {
		const box = $('sp-steps');
		const steps = show ? turnSteps() : [];
		box.hidden = !steps.length;
		if (box.hidden) return;
		const LIMIT = 6, hidden = Math.max(0, steps.length - LIMIT);
		const done = steps.filter((s) => s.state === 'done').length;
		const sig = JSON.stringify([steps.slice(-LIMIT), hidden, gitUi.fold.has('steps')]);
		if (box.dataset.sig === sig) return;
		box.dataset.sig = sig;
		box.classList.toggle('folded', gitUi.fold.has('steps'));
		box.innerHTML =
			spHead('steps', 'Progress', '<span>' + done + '/' + steps.length + '</span>') +
			'<div class="sp-body"><ul class="sp-list">' + (hidden ? '<li class="sp-item more">' + hidden + ' earlier step' + (hidden === 1 ? '' : 's') + '</li>' : '') +
			steps.slice(-LIMIT).map((s) => '<li class="sp-item ' + s.state + '"><span class="sp-check">' + (s.state === 'done' ? I('check') : s.state === 'current' ? I('chevronRight') : s.state === 'failed' ? I('close') : '') + '</span><span class="sp-item-text" title="' + esc(s.text) + '">' + esc(s.text) + '</span></li>').join('') +
			'</ul></div>';
	}
	/** The capsule's one line, in ZCode's order: the step being worked on, the goal, the changes, done. */
	function renderMini() {
		const mini = $('sp-mini');
		const pg = ui.progressInfo, task = statusTask(), d = gitUi.data;
		const steps = pg ? null : turnSteps();
		const current = pg && pg.current ? pg.current : steps && (steps.find((s) => s.state === 'current') || {}).text;
		let icon, text, extra = '';
		if (current) [icon, text] = ['chevronRight', current];
		else if (task && task.live) [icon, text] = ['target', task.title];
		else if (d && d.added + d.removed > 0) [icon, text, extra] = ['fileDiff', 'Changes', '<span class="gt-plus">+' + fmtStat(d.added) + '</span><span class="gt-minus">−' + fmtStat(d.removed) + '</span>'];
		else if (task) [icon, text] = ['check', task.title || 'Complete'];
		else [icon, text] = ['list', 'Status'];
		const html = '<span class="sp-mini-ico"><span class="a">' + I(icon) + '</span><span class="b">' + I('expand') + '</span></span><span class="sp-mini-text">' + esc(text) + '</span>' + extra;
		if (mini.innerHTML !== html) mini.innerHTML = html;
		mini.classList.toggle('done', icon === 'check');
	}
	function paintStatusPanel() {
		const card = gitEnsure();
		const shown = statusPanelShown();
		const mode = spMode();
		const expanded = shown && mode === 'panel';
		const gitOn = shown && !!(gitUi.data || gitUi.noRepo);
		const pgOn = el.progress.parentElement === $('sp-progress') && !el.progress.classList.contains('hidden');
		// The Git section needs one look at the repository before the first turn.
		if (shown && !gitUi.fetched && !gitUi.asked) { gitUi.asked = true; gitFetch(); }
		const was = card.classList.contains('on') && !card.classList.contains('mini');
		card.classList.toggle('on', shown);
		card.classList.toggle('mini', shown && mode === 'mini');
		card.classList.toggle('docked', expanded && gitUi.docked);
		card.classList.toggle('live', !!state.isStreaming);
		$('app').classList.toggle('sp-docked', expanded && gitUi.docked);
		$('sp-git').hidden = !gitOn;
		$('sp-progress').hidden = !pgOn;
		if (expanded !== was) $('sp-task').dataset.sig = '';
		if (!shown) return;
		renderMini();
		renderFlow();
		renderStatusTask();
		renderSteps(!pgOn);
	}
	/**
	 * The run timeline: Plan → Work → Check → Review → Done for the latest turn, each stage from
	 * the turn's own records (a checklist, tool steps, verification receipts and Verify cards, the
	 * Workflow review, the outcome). A stage the turn did not use shows as skipped, not as done.
	 */
	function runFlow() {
		const msgs = state.messages;
		let at = -1;
		for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user' && !msgs[i].kind) { at = i; break; }
		if (at < 0) return null;
		const turn = msgs[at].turn || {}, after = msgs.slice(at + 1), live = !!state.isStreaming;
		const tools = after.filter((m) => m.tool && m.tool.name !== 'verify' && !m.todos);
		const verifies = after.filter((m) => m.tool && m.tool.name === 'verify');
		const receipts = (turn.verification || []).filter((r) => r && r.kind === 'verify');
		const planned = after.some((m) => m.todos) || !!ui.progressInfo;
		const ended = !live && !!turn.endedAt;
		const working = live && tools.some((m) => m.tool.status === 'running');
		const checkRunning = live && verifies.some((m) => m.tool.status === 'running');
		const checkFailed = verifies.some((m) => m.tool.status === 'error') || receipts.some((r) => r.status === 'failed');
		const checked = verifies.some((m) => m.tool.status === 'done') || receipts.some((r) => r.status === 'passed');
		const reviewRuns = (state.agentRuns || []).filter((r) => r.workflowRole === 'reviewer' && state.workflowTaskId && r.rootTaskId === state.workflowTaskId);
		const review = turn.review || (reviewRuns.length ? reviewRuns[reviewRuns.length - 1].reviewVerdict : '');
		const reviewing = live && reviewRuns.some((r) => r.status === 'running');
		const s = (cond, current, failed) => failed ? 'failed' : current ? 'current' : cond ? 'done' : ended ? 'skipped' : 'pending';
		return [
			['Plan', planned ? 'done' : live && !tools.length ? 'current' : ended ? 'skipped' : 'pending'],
			['Work', s(tools.length > 0, working || (live && !checkRunning && !reviewing && tools.length > 0 && !ended && !checked), false)],
			['Check', s(checked && !checkFailed, checkRunning, checkFailed && !checkRunning)],
			['Review', s(review === 'pass', reviewing, review === 'changes' || review === 'blocked')],
			['Done', ended ? (turn.outcome === 'failed' || turn.outcome === 'error' ? 'failed' : turn.outcome === 'stopped' ? 'skipped' : 'done') : 'pending']
		];
	}
	function renderFlow() {
		const box = $('sp-flow');
		if (!box) return;
		const flow = runFlow();
		box.hidden = !flow;
		if (!flow) return;
		const sig = JSON.stringify(flow);
		if (box.dataset.sig === sig) return;
		box.dataset.sig = sig;
		const glyph = { done: I('check'), failed: I('close'), current: '<i class="sp-flow-dot"></i>', pending: '', skipped: '–' };
		box.innerHTML = '<ol class="sp-flow-list" aria-label="Run timeline">' + flow.map(([name, st]) => '<li class="sp-flow-stage ' + st + '" title="' + esc(name + ': ' + st) + '"><span class="sp-flow-mark">' + glyph[st] + '</span><span class="sp-flow-name">' + esc(name) + '</span></li>').join('') + '</ol>';
	}
	function renderGitTools() {
		const card = gitEnsure();
		const review = $('git-review');
		const d = gitUi.data;
		const shown = statusPanelShown() && !!d;
		review.classList.toggle('on', shown && gitUi.review);
		paintStatusPanel();
		const box = $('sp-git');
		if (statusPanelShown() && !d && gitUi.noRepo) {
			box.classList.remove('folded');
			box.innerHTML = spHead('git', 'Git tools', '') + '<div class="sp-body"><div class="gt-row gt-none">' + I('branch') + '<span class="gt-label">Not a Git repository</span></div></div>';
			return;
		}
		if (!shown) return;
		// Don't rebuild under the user's fingers while they use the branch menu.
		if (card.contains(document.activeElement) && gitUi.menu && box.querySelector('.gt-menu')) {
			gitRenderBranchList();
			return;
		}
		const nums = '<span class="gt-nums"><span class="gt-plus">+' + fmtStat(d.added || 0) + '</span><span class="gt-minus">−' + fmtStat(d.removed || 0) + '</span></span>';
		const folded = gitUi.fold.has('git');
		box.classList.toggle('folded', folded);
		box.innerHTML =
			spHead('git', 'Git tools', folded ? nums : '') +
			'<div class="sp-body">' +
			'<button class="gt-row' + (gitUi.review ? ' on' : '') + '" data-gt="changes" title="Review the working tree">' + I('fileDiff') + '<span class="gt-label">Changes</span>' + (d.changes.length ? '<span class="gt-count">' + d.changes.length + '</span>' : '') + nums + '</button>' +
			'<button class="gt-row" data-gt="branch" title="Switch or create a branch" aria-expanded="' + gitUi.menu + '">' + I('branch') + '<span class="gt-label mono">' + esc(gitUi.branch || 'no branch') + '</span><span class="gt-chev">' + I('chevronDown') + '</span></button>' +
			(gitUi.menu
				? '<div class="gt-menu"><div class="gtm-search">' + I('search') + '<input id="gt-branch-filter" placeholder="Search branches" spellcheck="false" value="' + esc(gitUi.filter) + '"></div><div class="gtm-list" id="gtm-list"></div><div class="gtm-new">' + I('plus') + '<input id="gt-new-branch" placeholder="Create and switch to new branch…" spellcheck="false"></div></div>'
				: '') +
			'<button class="gt-row" data-gt="commit" title="Ask the agent to commit and push"' + (d.changes.length ? '' : ' disabled') + '>' + I('commit') + '<span class="gt-label">Commit</span><span class="gt-more">' + I('more') + '</span></button>' +
			'</div>';
		gitRenderBranchList();
		// Review drawer: every changed file, stats per file, click → diff.
		const dir = (p) => (p.includes('/') ? p.split('/').slice(0, -1).join('/') + '/' : '');
		review.innerHTML =
			'<div class="gtr-head"><span class="gtr-title">' + I('fileDiff') + 'Changes <em>' + d.changes.length + '</em></span><span class="grow"></span>' +
			'<button class="icon-btn" data-gr="refresh" title="Refresh">' + I('refresh') + '</button><button class="icon-btn" data-gr="close" title="Close">' + I('close') + '</button></div>' +
			'<div class="gtr-list">' +
			(d.changes.length ? '' : '<div class="gtm-empty">No changes in the working tree.</div>') +
			d.changes
				.slice(0, 300)
				.map((c) => {
					const st = c.status === '?' ? 'q' : c.status;
					const nums = c.added === undefined ? '<span class="gtr-new">new</span>' : '<span class="gtr-plus">+' + c.added + '</span><span class="gtr-minus">−' + c.removed + '</span>';
					return (
						'<button class="gtr-row" data-gr-open="' + esc(c.path) + '" title="Open the diff">' +
						'<i class="gtr-st s-' + esc(st) + '">' + esc(c.status === '?' ? 'U' : c.status) + '</i>' + fileBadge(c.path) +
						'<span class="gtr-text"><span class="gtr-name">' + esc(basename(c.path)) + '</span>' + (dir(c.path) ? '<span class="gtr-dir">' + esc(dir(c.path)) + '</span>' : '') + '</span>' +
						nums +
						'<span class="gt-chev">' + I('chevronRight') + '</span></button>'
					);
				})
				.join('') +
				(d.changes.length > 300 ? '<div class="gtm-empty">…' + (d.changes.length - 300) + ' more files.</div>' : '') +
			'</div>';
	}

	// The background picture (Settings → Appearance → Your picture).
	if (window.Effects) window.Effects.mount($('fx-canvas'));

	if (persisted.draft) el.input.value = persisted.draft;
	if (B.remote) document.body.classList.add('remote');
	applyLabels();
	autosize();
	renderComposer();
	const ready = () => {
		post({ type: 'ready' });
		post({ type: 'engineStateGet' });
		// Local image / video / voice models and the one picked in the chat.
		ui.studioAsked = true;
		post({ type: 'studioState' });
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
	else ready();
	if (!B.remote) el.input.focus();
})();
