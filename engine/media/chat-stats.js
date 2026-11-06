(function () {
	'use strict';
	window.ChatStats = { create({ $, B, I, closeMenus, ctxRingSvg, esc, fmtCacheRate, fmtDuration, fmtK, fmtTokens, h, state, ui }) {
	function sessionStats(messages) {
		const s = { turns: 0, steps: 0, stepTurns: 0, requests: 0, requestCountsKnown: true, input: 0, output: 0, cached: 0, cacheWrite: 0, known: 0, cacheKnown: 0, llmMs: 0, llmSamples: 0, toolMs: 0, toolSamples: 0, ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0 };
		const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
		const reported = u => u && u.inputReported !== false && u.outputReported !== false && !u.issues?.some(issue => !issue.startsWith('Cache fields disagree'));
		for (const m of messages) {
			if (m.role !== 'user' || !m.turn) continue;
			const turn = m.turn;
			s.turns++;
			const attempts = turn.attempts || [];
			// Retries are requests in the same step; helper requests are not agent steps.
			const steps = new Set(attempts.filter(a => a.purpose === 'main' || a.purpose == null).map(a => a.step).filter(valid));
			s.steps += steps.size;
			if (steps.size) s.stepTurns++;
			for (const a of attempts) {
				if (valid(a.durationMs)) { s.llmMs += a.durationMs; s.llmSamples++; }
				const first = [a.firstTextMs, a.firstReasoningMs].filter(valid);
				if (!first.length) continue;
				const ttft = Math.min(...first);
				if (valid(a.durationMs) && ttft > a.durationMs) continue;
				s.ttftMs += ttft; s.ttftSamples++;
				if (a.outcome === 'completed' && valid(a.durationMs) && a.durationMs > ttft && a.usage && a.usage.outputReported !== false && valid(a.usage.output)) {
					s.decodeMs += a.durationMs - ttft; s.decodeTokens += a.usage.output;
				}
			}
			for (const timing of turn.toolTimings || []) {
				if (valid(timing.durationMs)) { s.toolMs += timing.durationMs; s.toolSamples++; }
			}
			const u = turn.usage || (attempts.length ? {
				input: attempts.reduce((n, a) => n + (a.usage?.input || 0), 0), output: attempts.reduce((n, a) => n + (a.usage?.output || 0), 0),
				cached: attempts.reduce((n, a) => n + (a.usage?.cached || 0), 0), cacheWrite: attempts.reduce((n, a) => n + (a.usage?.cacheWrite || 0), 0),
				attempts: attempts.length, knownAttempts: attempts.filter(a => reported(a.usage)).length, cacheKnownAttempts: attempts.filter(a => reported(a.usage) && valid(a.usage.cached)).length
			} : null);
			if (u && u.attempts == null && !attempts.length) s.requestCountsKnown = false;
			const requests = u?.attempts ?? attempts.length;
			s.requests += requests;
			if (!u) continue;
			s.input += valid(u.input) ? u.input : 0;
			s.output += valid(u.output) ? u.output : 0;
			s.cached += valid(u.cached) ? u.cached : 0;
			s.cacheWrite += valid(u.cacheWrite) ? u.cacheWrite : 0;
			const known = u.knownAttempts ?? (reported(u) ? requests || 1 : 0);
			s.known += known;
			s.cacheKnown += u.cacheKnownAttempts ?? (valid(u.cached) ? known : 0);
			if (!requests) s.requests++;
		}
		s.partial = s.known < s.requests;
		s.cacheComplete = s.known > 0 && !s.partial && s.cacheKnown === s.requests;
		s.cacheRate = s.cacheComplete && s.input > 0 ? s.cached / s.input * 100 : null;
		s.tps = s.decodeMs > 0 ? s.decodeTokens / (s.decodeMs / 1000) : null;
		return s;
	}

	function statsDuration(ms) {
		if (ms < 1000) return (ms / 1000).toFixed(2) + 's';
		return fmtDuration(ms);
	}

	/*
	 * Number Ticker: digits in a stats label roll in their own column from the value they
	 * showed last to the new one. The columns draw their digits with CSS, so the text a
	 * reader or a search sees is just the number.
	 */
	function tickerHtml(text) {
		let run = 0;
		return esc(text).replace(/\d+/g, (digits) => '<span class="nt" data-run="' + run++ + '"><span class="nt-sr">' + digits + '</span><span class="nt-track" aria-hidden="true">' + [...digits].map((d) => '<span class="nt-col"><span class="nt-stack" data-d="' + d + '"></span></span>').join('') + '</span></span>');
	}
	function rollTickers(root, key) {
		const memory = (rollTickers.memory ||= new Map());
		const reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		for (const nt of root.querySelectorAll('.nt')) {
			const stacks = [...nt.querySelectorAll('.nt-stack')];
			stacks.forEach((stack, i) => {
				const slot = key + ':' + nt.dataset.run + ':' + (stacks.length - i);
				const to = Number(stack.dataset.d);
				const from = memory.has(slot) ? memory.get(slot) : reduce ? to : 0;
				stack.style.transition = 'none';
				stack.style.transform = 'translateY(' + (-from / 11 * 100) + '%)';
				void stack.offsetWidth;
				stack.style.transition = '';
				stack.style.transform = 'translateY(' + (-to / 11 * 100) + '%)';
				memory.set(slot, to);
			});
		}
	}

	function renderStats() {
		const banner = $('stats-banner'), button = $('btn-stats');
		if (!banner || !button) return;
		if (ui.statsSession !== state.currentSessionId || !ui.statsOpen) closeStatsPopup(false);
		ui.statsSession = state.currentSessionId;
		banner.classList.toggle('open', ui.statsOpen);
		banner.setAttribute('aria-hidden', String(!ui.statsOpen));
		banner.inert = !ui.statsOpen;
		button.setAttribute('aria-expanded', String(ui.statsOpen));
		if (!ui.statsOpen) return;
		const s = sessionStats(state.messages);
		const hasTokens = s.known > 0 || s.input + s.output > 0;
		const row = (label, value) => '<div class="stats-row"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>';
		const tokens = n => n.toLocaleString() + ' tok';
		const unknown = 'Not reported';
		const cache = s.cacheRate == null ? '—' : fmtCacheRate(s.cacheRate).replace(/\.0+$/, '') + '%';
		const speed = s.tps == null ? 'Speed unavailable' : Math.round(s.tps) + ' tok/s';
		const turnLabel = s.turns + (s.turns === 1 ? ' turn' : ' turns');
		const stepLabel = s.steps ? s.steps + (s.stepTurns < s.turns ? ' recorded' : '') + (s.steps === 1 ? ' step' : ' steps') : s.turns ? 'steps unavailable' : '0 steps';
		const total = hasTokens ? fmtK(s.input + s.output) + ' tok' : s.requests ? unknown : '0 tok';
		const ctx = state.context;
		const hasContext = ctx && Number.isFinite(ctx.used) && ctx.used >= 0;
		const hasWindow = hasContext && Number.isFinite(ctx.window) && ctx.window > 0;
		const percent = hasWindow ? ctx.used / ctx.window * 100 : null;
		const pct = percent == null ? '—' : Math.round(percent) + '%';
		const contextRows = [['systemPrompt', 'System prompt'], ['systemTools', 'Tool definitions'], ['mcpTools', 'MCP tools'], ['skills', 'Skills'], ['messages', 'Messages'], ['meta', 'Other context']];
		const parts = hasContext && ctx.parts ? contextRows.filter(([key]) => Number.isFinite(ctx.parts[key]) && ctx.parts[key] > 0).map(([key, label]) => row(label, '~' + tokens(Math.round(ctx.used * ctx.parts[key] / 100)))).join('') : '';
		const note = text => '<p class="stats-note">' + esc(text) + '</p>';
		const contextValue = hasContext ? (ctx.source === 'estimated' ? '~' : '') + fmtTokens(ctx.used) + ' / ' + (hasWindow ? fmtTokens(ctx.window) : 'unknown limit') : '';
		ui.statsPanels = {
			session: { title: 'Session statistics', icon: 'gauge', value: '', body: '<dl>' + row('LLM time', s.llmSamples ? statsDuration(s.llmMs) : unknown) + row('Tool time', s.toolSamples ? statsDuration(s.toolMs) : unknown) + row('Avg. time to first token (TTFT)', s.ttftSamples ? statsDuration(s.ttftMs / s.ttftSamples) : unknown) + row('Tokens per second (TPS)', s.tps == null ? unknown : s.tps.toFixed(1).replace(/\.0$/, '') + ' tok/s') + row('Requests', s.requestCountsKnown ? String(s.requests) : 'Not recorded') + '</dl>' + note('Recorded model requests and tool wall time. Parallel calls can overlap.') },
			tokens: { title: 'Token usage', icon: 'database', value: hasTokens ? tokens(s.input + s.output) : total, body: '<dl>' + row('Cache hit', s.cacheRate == null ? unknown : cache) + row('Uncached input', s.cacheComplete ? tokens(Math.max(0, s.input - s.cached - s.cacheWrite)) : unknown) + row('Cached input', s.cacheKnown ? tokens(s.cached) + (s.cacheComplete ? '' : ' · partial') : unknown) + (s.cacheWrite ? row('Cache writes', tokens(s.cacheWrite)) : '') + row('Output', hasTokens ? tokens(s.output) : unknown) + '</dl>' + note(s.partial ? 'Partial usage · ' + s.known + '/' + s.requests + ' requests reported.' : 'Recorded token counts for this chat. Background work is listed in Settings → Usage.') },
			context: { title: pct + ' of context used', icon: null, value: contextValue, body: (hasWindow ? '<div class="stats-context-meter" role="progressbar" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.min(100, Math.max(0, percent)).toFixed(1) + '"><i></i></div>' : '') + '<dl>' + (hasContext ? row('Used tokens', (ctx.source === 'estimated' ? '~' : '') + tokens(ctx.used)) + row('Context window', hasWindow ? tokens(ctx.window) : unknown) : '') + parts + '</dl>' + note(parts ? 'Last request. Breakdown estimates follow the request text proportions.' : hasContext ? 'Last request.' : 'Send a message to measure the model’s context.'), percent }
		};
		const metrics = [
			['session', I('gauge'), turnLabel + ' ' + stepLabel + ' · ' + speed],
			['tokens', I('database'), total + ' · ' + (s.partial ? 'Partial usage' : 'Cache hit ' + cache)],
			['context', ctxRingSvg(hasWindow ? Math.min(1, percent / 100) : 0, 16), pct]
		];
		const content = $('stats-content');
		if (!content.firstElementChild) content.innerHTML = '<div class="stats-strip">' + metrics.map(([key]) => '<button id="stats-' + key + '" type="button" class="stats-metric" data-stats-kind="' + key + '" aria-haspopup="dialog" aria-controls="stats-popup" aria-expanded="false"></button>').join('') + '</div>';
		for (const [key, icon, label] of metrics) {
			const trigger = content.querySelector('[data-stats-kind="' + key + '"]');
			const html = icon + '<span>' + tickerHtml(label) + '</span>';
			if (trigger.dataset.html !== html) {
				trigger.dataset.html = html;
				trigger.innerHTML = html;
				rollTickers(trigger, key);
			}
			trigger.setAttribute('aria-label', (key === 'context' ? 'Context used' : ui.statsPanels[key].title) + ': ' + label);
			trigger.setAttribute('aria-expanded', String(ui.statsPopup?.key === key));
		}
		if (ui.statsPopup) renderStatsPopup();
	}

	function positionStatsPopup() {
		if (!ui.statsPopup) return;
		const popup = ui.statsPopup.element;
		const anchor = $('stats-' + ui.statsPopup.key);
		if (!anchor) return closeStatsPopup(false);
		popup.style.width = Math.min(360, Math.max(0, window.innerWidth - 20)) + 'px';
		popup.style.maxHeight = Math.max(0, window.innerHeight - 20) + 'px';
		// The opening animation scales the visual bounds; placement needs the final layout size.
		const r = anchor.getBoundingClientRect(), p = { width: popup.offsetWidth, height: popup.offsetHeight };
		popup.style.left = Math.max(10, Math.min(window.innerWidth - p.width - 10, r.left + r.width / 2 - p.width / 2)) + 'px';
		popup.style.top = Math.max(10, Math.min(window.innerHeight - p.height - 10, r.top - p.height - 8)) + 'px';
	}

	function renderStatsPopup() {
		if (!ui.statsPopup) return;
		const { key, element } = ui.statsPopup;
		const panel = ui.statsPanels[key];
		const html = '<div class="stats-popup-head"><b id="stats-popup-title">' + (panel.icon ? I(panel.icon) : '') + esc(panel.title) + '</b><span class="stats-popup-value">' + esc(panel.value) + '</span></div><div class="stats-popup-body">' + panel.body + '</div>';
		const content = element.querySelector('.stats-popup-content');
		if (content.innerHTML !== html) content.innerHTML = html;
		const fill = element.querySelector('.stats-context-meter i');
		if (fill) fill.style.width = Math.min(100, Math.max(0, panel.percent)).toFixed(1) + '%';
		positionStatsPopup();
	}

	function closeStatsPopup(restoreFocus) {
		if (!ui.statsPopup) return;
		const { key, element } = ui.statsPopup;
		ui.statsPopup = null;
		element.remove();
		const trigger = $('stats-' + key);
		trigger?.setAttribute('aria-expanded', 'false');
		if (restoreFocus && ui.statsOpen) trigger?.focus({ preventScroll: true });
	}

	function toggleStatsPopup(key) {
		if (!ui.statsOpen || !ui.statsPanels?.[key]) return;
		if (ui.statsPopup?.key === key) return closeStatsPopup(true);
		closeStatsPopup(false);
		closeMenus();
		const element = h('section', 'popover stats-popover', '<button type="button" class="stats-popup-close icon-btn" aria-label="Close statistics">' + I('close') + '</button><div class="stats-popup-content"></div>');
		element.id = 'stats-popup';
		element.setAttribute('role', 'dialog');
		element.setAttribute('aria-labelledby', 'stats-popup-title');
		element.tabIndex = -1;
		element.querySelector('.stats-popup-close').addEventListener('click', () => closeStatsPopup(true));
		element.addEventListener('keydown', e => {
			if (e.key === 'Escape') { e.stopPropagation(); closeStatsPopup(true); }
		});
		ui.statsPopup = { key, element };
		document.body.appendChild(element);
		$('stats-' + key).setAttribute('aria-expanded', 'true');
		renderStatsPopup();
		element.focus({ preventScroll: true });
	}

	$('btn-stats')?.addEventListener('click', () => {
		ui.statsOpen = !ui.statsOpen;
		B.patchState({ statsOpen: ui.statsOpen });
		renderStats();
	});
	$('stats-content')?.addEventListener('click', e => {
		const trigger = e.target.closest('[data-stats-kind]');
		if (trigger) toggleStatsPopup(trigger.dataset.statsKind);
	});
	$('stats-banner')?.addEventListener('keydown', e => {
		if (e.key !== 'Escape') return;
		e.stopPropagation();
		if (ui.statsPopup) return closeStatsPopup(true);
		ui.statsOpen = false;
		B.patchState({ statsOpen: false });
		renderStats();
		$('btn-stats').focus();
	});
	document.addEventListener('pointerdown', e => {
		if (ui.statsPopup && !ui.statsPopup.element.contains(e.target) && !e.target.closest('[data-stats-kind]')) closeStatsPopup(false);
	});
	window.addEventListener('resize', positionStatsPopup);
	document.addEventListener('scroll', positionStatsPopup, true);
	if (window.ResizeObserver) new ResizeObserver(positionStatsPopup).observe(document.documentElement);


return { sessionStats, statsDuration, tickerHtml, rollTickers, renderStats, positionStatsPopup, renderStatsPopup, closeStatsPopup, toggleStatsPopup };
	} };
})();
