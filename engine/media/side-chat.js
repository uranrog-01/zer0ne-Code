(function () {
	'use strict';
	const B = window.Bridge, MD = window.Markdown, I = window.Icons.svg;
	const $ = id => document.getElementById(id);
	const make = (tag, cls, html) => { const n = document.createElement(tag); n.className = cls; if (html) n.innerHTML = html; return n; };
	const uid = () => window.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2);
	// Per-viewer conveniences only; storage can be blocked, so every access is guarded.
	const prefs = (() => { try { const p = JSON.parse(localStorage.getItem('zc.sideChat') || '{}'); return p && typeof p === 'object' ? p : {}; } catch { return {}; } })();
	const savePrefs = () => { try { localStorage.setItem('zc.sideChat', JSON.stringify(prefs)); } catch { /* storage unavailable */ } };
	// One id per tab that survives a reload, so the host hands this tab its own saved turns back.
	const sideChatId = (() => {
		try { const id = sessionStorage.getItem('zc.sideChat.client'); if (id && /^side-[\w-]{6,90}$/.test(id)) return id; } catch { /* storage unavailable */ }
		const id = 'side-' + uid();
		try { sessionStorage.setItem('zc.sideChat.client', id); } catch { /* storage unavailable */ }
		return id;
	})();
	const SOURCES = [
		{ id: 'project', icon: 'folder', label: 'Project', hint: 'Search and read project files' },
		{ id: 'changes', icon: 'branch', label: 'Changes', hint: 'Git status, diff and log' },
		{ id: 'problems', icon: 'alert', label: 'Problems', hint: 'Errors and warnings' },
		{ id: 'history', icon: 'history', label: 'History', hint: 'Other chats and memory' }
	];
	const SUGGEST = [
		{ label: 'Summarize this session', question: 'Summarize this session so far: the goal, what has been done, and what is still open.' },
		{ label: 'What changed so far?', question: 'Which files has this session changed so far, and why?', source: 'changes' },
		{ label: 'Explain the last error', question: 'Explain the most recent error or failure in this session and how to fix it.', source: 'problems' },
		{ label: 'What should I do next?', question: 'Based on this session, what should I do next? Give concrete steps.' }
	];
	const LIVE = { idle: 'Idle', running: 'Working', waiting: 'Needs you' };
	const ORBS = { pearl: 'Pearl', ember: 'Ember' };
	let session, sessionTitle = '', live = 'idle', providers = [], selection = {}, modelKey = '', request = null, excerpt = '', popup = null, open = false, expanded = false, opener = null, available = [], pending = [], mic = {}, remote = false, dictating = false, dictDraft = 0;
	let depth = prefs.depth === 'full' ? 'full' : 'recent';
	const keep = () => prefs.keep !== false;
	const watching = () => prefs.watch !== false;
	const chosen = new Set(Array.isArray(prefs.sources) ? prefs.sources.filter(s => SOURCES.some(x => x.id === s)) : []);
	const turns = [];
	const panel = make('section', 'side-chat');
	panel.id = 'side-chat'; panel.hidden = true;
	panel.dataset.orb = ORBS[prefs.orb] ? prefs.orb : 'pearl';
	panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', 'side-chat-title');
	panel.innerHTML = `
		<header class="side-chat-head">
			<span class="side-chat-orb is-head" aria-hidden="true"></span>
			<div class="side-chat-titles">
				<h2 id="side-chat-title" class="side-chat-title">Side Chat</h2>
				<p class="side-chat-session"><i class="side-chat-live" aria-hidden="true"></i><span class="side-chat-session-name"></span><span class="side-chat-session-state"></span></p>
			</div>
			<div class="side-chat-actions">
				<div class="side-chat-reveal">
					<div class="side-chat-model"><button type="button" class="side-chat-model-btn" aria-haspopup="listbox" aria-expanded="false" aria-label="Side Chat model"><span class="side-chat-model-ico" aria-hidden="true"></span><span class="side-chat-model-name">Choose a model</span>${I('chevronDown')}</button><select aria-label="Side Chat model" hidden tabindex="-1"></select></div>
					<button type="button" class="side-chat-icon side-chat-src-btn" aria-haspopup="dialog" aria-expanded="false" title="What Side Chat can use">${I('layers')}<span class="side-chat-sr">Sources</span><b class="side-chat-src-count" hidden></b></button>
					<button type="button" class="side-chat-icon" data-side-more aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More Side Chat options">${I('more')}</button>
					<button type="button" class="side-chat-icon" data-side-close title="Close Side Chat (Esc)" aria-label="Close Side Chat">${I('close')}</button>
				</div>
				<button type="button" class="side-chat-icon" data-side-new-head title="New conversation" aria-label="New Side Chat conversation">${I('refresh')}</button>
			</div>
		</header>
		<div class="side-chat-main">
			<div class="side-chat-transcript"><div class="side-chat-body" tabindex="0" role="region" aria-label="Side Chat conversation">
				<div class="side-chat-empty">
					<div class="side-chat-reply"><span class="side-chat-orb" aria-hidden="true"></span><div class="side-chat-reply-body">
						<p class="side-chat-hello"></p>
						<div class="side-chat-suggest" role="group" aria-label="Suggested questions">${SUGGEST.map((s, i) => `<button type="button" class="side-chat-chip" data-side-suggest="${i}">${s.label}</button>`).join('')}</div>
					</div></div>
				</div>
				<div class="side-chat-turns" aria-label="Side Chat messages"></div>
			</div><button type="button" class="side-chat-latest" hidden>${I('arrowDown')}<span>Latest answer</span></button></div>
			<form class="side-chat-compose">
				<div class="side-chat-strip"><span class="side-chat-status" role="status" aria-live="polite"></span><button type="button" class="side-chat-see" hidden><span>See steps</span>${I('chevronRight')}</button></div>
				<div class="side-chat-excerpt" hidden><div><span>${I('file')} Selected passage</span><button type="button" class="side-chat-icon" data-side-remove aria-label="Remove excerpt" title="Remove selected passage">${I('close')}</button></div><blockquote></blockquote></div>
				<div class="side-chat-box">
					<textarea rows="1" aria-label="Side Chat question" aria-describedby="side-chat-input-hint" placeholder="Ask about this session…" maxlength="8000" title="Enter to send · Shift+Enter for a new line"></textarea>
					<button type="button" class="side-chat-mic" aria-pressed="false" title="Dictate a question" aria-label="Dictate a question">${I('mic')}</button>
					<button type="button" class="side-chat-stop" hidden title="Stop">${I('stop')}<span class="side-chat-sr">Stop</span></button>
					<button type="submit" class="side-chat-send" aria-label="Send Side Chat question" title="Send (Enter)">${I('arrowUp')}</button>
				</div>
			</form>
		</div>
		<div class="side-chat-menu" role="dialog" aria-label="Choose a Side Chat model" hidden>
			<div class="side-chat-menu-search">${I('search')}<input type="text" role="combobox" aria-expanded="true" aria-controls="side-chat-menu-list" aria-autocomplete="list" placeholder="Search models…" spellcheck="false"></div>
			<div class="side-chat-menu-body">
				<div class="side-chat-menu-providers" role="group" aria-label="Providers"></div>
				<div class="side-chat-menu-models">
					<div class="side-chat-menu-head"><span class="side-chat-menu-title" id="side-chat-menu-title"></span><span class="side-chat-menu-count"></span></div>
					<div class="side-chat-menu-list" id="side-chat-menu-list" role="listbox" aria-labelledby="side-chat-menu-title"></div>
				</div>
			</div>
			<div class="side-chat-menu-foot"><span><kbd>↑</kbd><kbd>↓</kbd> models · <kbd>←</kbd> providers · <kbd>Enter</kbd> choose</span><span>Add models in Settings → Providers</span></div>
		</div>
		<div class="side-chat-pop side-chat-srcmenu" role="dialog" aria-label="What Side Chat can use" hidden>
			<div class="side-chat-pop-head">What Side Chat can use</div>
			<button type="button" class="side-chat-src-row" data-side-depth aria-pressed="false">${I('chat')}<span><b></b><small></small></span><i class="side-chat-switch" aria-hidden="true"></i></button>
			<div class="side-chat-pop-sep" data-side-src-label>Look things up (read-only)</div>
			${SOURCES.map(s => `<button type="button" class="side-chat-src-row" data-side-source="${s.id}" aria-pressed="false" hidden>${I(s.icon)}<span><b>${s.label}</b><small>${s.hint}</small></span><i class="side-chat-switch" aria-hidden="true"></i></button>`).join('')}
			<p class="side-chat-pop-note" data-side-src-none>Look-ups are not available here.</p>
		</div>
		<div class="side-chat-pop side-chat-more" role="menu" aria-label="More Side Chat options" hidden>
			<button type="button" role="menuitem" class="side-chat-more-item" data-side-new>${I('newChat')}<span>New conversation</span></button>
			<label class="side-chat-more-item side-chat-save" role="menuitemcheckbox" title="Save the last six Side Chat exchanges with each session, so they come back when you return to it">${I('history')}<span>Save with session</span><input type="checkbox"><i class="side-chat-switch" aria-hidden="true"></i></label>
			<label class="side-chat-more-item side-chat-watch" role="menuitemcheckbox" title="Tell me here when this session needs me, fails or finishes">${I('bell')}<span>Session alerts</span><input type="checkbox"><i class="side-chat-switch" aria-hidden="true"></i></label>
			<button type="button" role="menuitem" class="side-chat-more-item" data-side-orb>${I('palette')}<span>Orb</span><small></small></button>
			<button type="button" role="menuitem" class="side-chat-more-item" data-side-expand aria-pressed="false">${I('expand')}<span>Expand</span></button>
			<div class="side-chat-more-keys" id="side-chat-input-hint"><kbd>Enter</kbd> send · <kbd>Shift+Enter</kbd> new line · <kbd>Ctrl+J</kbd> open or close</div>
		</div>`;
	document.body.appendChild(panel);
	const field = panel.querySelector('textarea'), model = panel.querySelector('select'), body = panel.querySelector('.side-chat-body'), list = panel.querySelector('.side-chat-turns'), status = panel.querySelector('.side-chat-status'), chip = panel.querySelector('.side-chat-excerpt'), strip = panel.querySelector('.side-chat-strip');
	const depthChip = panel.querySelector('[data-side-depth]'), see = panel.querySelector('.side-chat-see'), hello = panel.querySelector('.side-chat-hello'), micBtn = panel.querySelector('.side-chat-mic');
	const sessionName = panel.querySelector('.side-chat-session-name'), sessionState = panel.querySelector('.side-chat-session-state');
	const srcBtn = panel.querySelector('.side-chat-src-btn'), srcMenu = panel.querySelector('.side-chat-srcmenu'), moreBtn = panel.querySelector('[data-side-more]'), moreMenu = panel.querySelector('.side-chat-more');
	const trigger = $('btn-side-chat');
	const saveLabel = panel.querySelector('.side-chat-save'), watchLabel = panel.querySelector('.side-chat-watch');
	const remember = saveLabel.querySelector('input'), watch = watchLabel.querySelector('input');
	remember.checked = keep(); saveLabel.setAttribute('aria-checked', String(remember.checked));
	watch.checked = watching(); watchLabel.setAttribute('aria-checked', String(watch.checked));
	remember.onchange = () => {
		prefs.keep = remember.checked; savePrefs();
		saveLabel.setAttribute('aria-checked', String(remember.checked));
		if (session) void post({ type: 'sideChatRemember', sessionId: session, remember: remember.checked }).catch(e => notice(e.message));
	};
	watch.onchange = () => { prefs.watch = watch.checked; savePrefs(); watchLabel.setAttribute('aria-checked', String(watch.checked)); if (!watch.checked) flag(false); };
	/** The strip is for work in progress; idle, it shows only what needs attention. */
	function notice(text) { status.textContent = text || ''; strip.classList.toggle('is-notice', !!text); }
	function post(msg) { return Promise.resolve(B.post({ ...msg, sideChatId })).then(response => { if (response && response.ok === false) throw new Error('Side Chat could not connect. Try again.'); }); }
	function hideSelection() { popup?.remove(); popup = null; }
	function setExcerpt(text) {
		excerpt = text; chip.hidden = !text; chip.querySelector('blockquote').textContent = text; chip.querySelector('blockquote').title = text;
		field.placeholder = text ? 'Ask about this passage…' : turns.length ? 'Ask a follow-up…' : 'Ask about this session…';
		layout();
	}
	/** The header names the session Side Chat follows and what that session is doing. */
	function header() {
		sessionName.textContent = session ? sessionTitle || 'Untitled chat' : 'No session open';
		sessionState.textContent = session && live !== 'idle' ? ' · ' + (LIVE[live] || LIVE.running) : '';
		panel.querySelector('.side-chat-session').title = session ? 'Following ' + (sessionTitle || 'this chat') + (live === 'running' ? ' — answers include the reply being written' : '') : '';
		panel.dataset.live = session ? live : 'idle';
		hello.textContent = 'Hi — I’m reading “' + (sessionTitle || 'this chat') + '” as it happens. Ask me anything about it. I only read, so I won’t touch your files or interrupt the session.';
	}
	function orbLabel() { panel.querySelector('[data-side-orb] small').textContent = ORBS[panel.dataset.orb]; }
	/** One Sources button: its popover holds the chat depth and the look-ups this host can serve. */
	function sources() {
		depthChip.setAttribute('aria-pressed', String(depth === 'full'));
		depthChip.querySelector('b').textContent = depth === 'full' ? 'Whole chat' : 'Recent chat';
		depthChip.querySelector('small').textContent = depth === 'full' ? 'Reads everything: slower, more complete' : 'Summary and recent turns: fast';
		for (const button of panel.querySelectorAll('[data-side-source]')) {
			const id = button.dataset.sideSource;
			button.hidden = !available.includes(id);
			button.setAttribute('aria-pressed', String(chosen.has(id) && available.includes(id)));
		}
		srcMenu.querySelector('[data-side-src-label]').hidden = !available.length;
		srcMenu.querySelector('[data-side-src-none]').hidden = !!available.length;
		const n = using().length, count = srcBtn.querySelector('.side-chat-src-count');
		count.hidden = !n; count.textContent = String(n);
		srcBtn.classList.toggle('is-on', n > 0 || depth === 'full');
		srcBtn.title = 'What Side Chat can use: ' + [depth === 'full' ? 'whole chat' : 'recent chat', ...using().map(s => SOURCES.find(x => x.id === s).label.toLowerCase())].join(', ');
	}
	function using() { return [...chosen].filter(s => available.includes(s)); }
	/** "See steps" follows the newest answer that looked something up. */
	function seeState() { see.hidden = !list.querySelector('.side-chat-turn:last-child .side-chat-steps'); }
	/** A button that changes its label for a moment to confirm what happened. */
	function flash(button, text) {
		const label = button.querySelector('span'), old = button.dataset.label || label.textContent;
		button.dataset.label = old; label.textContent = text; button.classList.add('is-flash');
		clearTimeout(button.flash); button.flash = setTimeout(() => { label.textContent = old; button.classList.remove('is-confirm', 'is-flash'); }, 1600);
	}
	function copyText(text, button) {
		try { Promise.resolve(navigator.clipboard.writeText(text)).then(() => flash(button, 'Copied'), () => flash(button, 'Copy failed')); } catch { flash(button, 'Copy failed'); }
	}
	/** Puts an answer into the main composer as a draft; the user decides whether to send it. */
	function useInChat(text) {
		const input = $('input');
		if (!input) return;
		input.value = (input.value.trim() ? input.value.replace(/\s+$/, '') + '\n\n' : '') + text;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.focus();
		notice('Added to your message box — edit it, then send or steer.');
	}
	/** Hands an answer to the agent as a message. It acts on files, so the button asks twice. */
	function sendToAgent(text, button) {
		if (!button.classList.contains('is-confirm')) { button.classList.add('is-confirm'); flash(button, 'Click again to send'); clearTimeout(button.flash); button.flash = setTimeout(() => { button.classList.remove('is-confirm', 'is-flash'); button.querySelector('span').textContent = button.dataset.label; }, 4000); return; }
		clearTimeout(button.flash); button.classList.remove('is-confirm');
		void post({ type: 'send', text: 'From Side Chat:\n\n' + text }).then(() => {
			flash(button, 'Sent');
			notice(live === 'idle' ? 'Sent to the session.' : 'Sent — the session takes it after its current step.');
		}, error => notice(error.message));
	}
	function saveMemory(question, text, button) {
		const fact = (question ? 'Q: ' + question + '\nA: ' : '') + text;
		void post({ type: 'saveMemory', text: fact.slice(0, 4000) }).then(() => flash(button, 'Saved to memory'), error => notice(error.message));
	}
	/** Stored questions carry the excerpt they were asked about; the host writes them in this shape. */
	function parseQuestion(content) {
		const m = /^(?:Selected excerpt \(reference\):\n([\s\S]*?)\n\n)?Question:\n([\s\S]*)$/.exec(content);
		return m ? { question: m[2], excerpt: m[1] || '' } : { question: content, excerpt: '' };
	}
	function addTurn(question, quoted) {
		const turn = make('article', 'side-chat-turn'); turn.setAttribute('aria-label', 'Question and answer');
		if (quoted) { const quote = make('blockquote', 'side-chat-quote'); quote.textContent = quoted; turn.appendChild(quote); }
		const user = make('div', 'side-chat-user'); user.textContent = question; turn.appendChild(user);
		list.appendChild(turn); turns.push(turn);
		if (turns.length > 6) turns.shift().remove();
		return turn;
	}
	/** An answer sits beside the Side Chat orb; while it runs, one quiet status line stands in for the text. */
	function addAnswer(turn, content = '', answering = false) {
		const reply = make('div', 'side-chat-reply' + (answering ? ' is-live' : ''));
		const orb = make('div', 'side-chat-answer-label side-chat-orb', '<span class="side-chat-sr">Side Chat</span>'); orb.title = 'Side Chat';
		const column = make('div', 'side-chat-reply-body');
		const answer = make('div', 'side-chat-answer md' + (answering ? ' is-answering' : ''), MD.render(content));
		if (answering) { const stream = makeStream(); answer.stream = stream; column.appendChild(stream); }
		column.appendChild(answer); reply.append(orb, column); turn.appendChild(reply);
		return answer;
	}
	/**
	 * The quiet line for the wait: what is happening now, an elapsed clock and a hairline of
	 * progress. It settles into a receipt — done, failed or stopped — when the answer ends.
	 */
	function makeStream() {
		const s = make('div', 'side-chat-stream');
		s.dataset.state = 'working';
		s.setAttribute('role', 'group'); s.setAttribute('aria-label', 'Answer status');
		s.innerHTML = '<div class="side-chat-stream-row"><span class="side-chat-stream-glyph" aria-hidden="true"><i class="side-chat-stream-dot"></i><span class="side-chat-stream-mark"></span></span><span class="side-chat-stream-clip"><span class="side-chat-stream-text"></span></span><span class="side-chat-stream-clock" aria-hidden="true">0:00</span></div><div class="side-chat-stream-bar" aria-hidden="true"><i class="side-chat-stream-fill"></i><i class="side-chat-stream-scan"></i></div>';
		s.clock = s.querySelector('.side-chat-stream-clock');
		s.clip = s.querySelector('.side-chat-stream-clip');
		s.mark = s.querySelector('.side-chat-stream-mark');
		streamPhase(s, 'Thinking…');
		return s;
	}
	/** The phase slides in as it changes; the outgoing line lifts away over it. */
	function streamPhase(s, text) {
		if (s.clip.dataset.text === text) return;
		s.clip.dataset.text = text;
		for (const stale of s.clip.querySelectorAll('.side-chat-stream-text.is-out')) stale.remove();
		const from = s.clip.querySelector('.side-chat-stream-text');
		const next = make('span', 'side-chat-stream-text'); next.textContent = text;
		if (from) { from.classList.add('is-out'); setTimeout(() => from.remove(), 340); }
		s.clip.appendChild(next);
	}
	/** 4200 -> "0:04", 72000 -> "1:12". */
	function fmtClock(ms) {
		const total = Math.max(0, Math.floor(ms / 1000));
		return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
	}
	// The clock paints into the line directly; it ends itself once no answer is running.
	let clockTimer = 0;
	function tickClock() {
		const s = request?.stream;
		if (!s) { clearInterval(clockTimer); clockTimer = 0; return; }
		s.clock.textContent = fmtClock(Date.now() - request.startedAt);
	}
	function settle(r, state) {
		const s = r.stream;
		if (!s) return;
		s.dataset.state = state;
		streamPhase(s, { done: 'Done', error: 'Failed', stopped: 'Stopped' }[state]);
		s.clock.textContent = fmtClock(Date.now() - r.startedAt);
		s.mark.innerHTML = I(state === 'done' ? 'check' : state === 'error' ? 'close' : 'minus');
	}
	function thinking(text) { if (request?.stream) streamPhase(request.stream, text); }
	function act(icon, text, title) { const button = make('button', 'side-chat-act', I(icon) + '<span></span>'); button.type = 'button'; button.title = text + ' — ' + title; button.setAttribute('aria-label', text); button.querySelector('span').textContent = text; return button; }
	/** Sources and actions under a finished answer. */
	function answerFoot(answer, text, refs = [], stopped = false, question = '') {
		if (!text.trim()) return;
		const foot = make('div', 'side-chat-answer-foot');
		if (refs.length) {
			const row = make('div', 'side-chat-refs');
			for (const ref of refs.slice(0, 12)) {
				const node = make(ref.path ? 'button' : 'span', 'side-chat-ref', I(ref.path ? 'file' : 'search') + '<span></span>');
				node.querySelector('span').textContent = ref.label;
				if (ref.path) { node.type = 'button'; node.title = 'Open ' + ref.path; node.addEventListener('click', () => void post({ type: 'openFile', path: ref.path, line: ref.line }).catch(() => {})); }
				row.appendChild(node);
			}
			foot.appendChild(row);
		}
		const acts = make('div', 'side-chat-answer-actions');
		if (stopped) acts.appendChild(make('span', 'side-chat-stopped', 'Stopped'));
		const copy = act('copy', 'Copy', 'Copy this answer');
		copy.addEventListener('click', () => copyText(text, copy));
		const use = act('pencil', 'Use in chat', 'Add this answer to your main message box as a draft');
		use.addEventListener('click', () => useInChat(text));
		const send = act('send', 'Send to agent', 'Send this answer to the session as your next message');
		send.addEventListener('click', () => sendToAgent(text, send));
		const pin = act('memory', 'Save to memory', 'Keep this answer in memory, so later chats can use it');
		pin.addEventListener('click', () => saveMemory(question, text, pin));
		acts.append(copy, use, send, pin); foot.appendChild(acts);
		answer.after(foot);
	}
	/** The look-ups of one answer: a timeline while they run, folded into one line afterwards. */
	function step(label, source) {
		if (!request) return;
		const stick = nearBottom();
		if (!request.steps) {
			request.steps = make('details', 'side-chat-steps'); request.steps.open = true;
			request.steps.innerHTML = '<summary>' + I('search') + '<span>Looking things up…</span>' + I('chevronRight') + '</summary><ol></ol><div class="side-chat-wait" hidden><span class="side-chat-dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span>Writing the answer</span></div>';
			request.node.before(request.steps);
		}
		request.steps.open = true;
		request.steps.querySelector('summary span').textContent = 'Looking things up…';
		request.steps.querySelector('.side-chat-wait').hidden = true;
		request.steps.querySelector('li.is-active')?.classList.remove('is-active');
		const row = make('li', 'is-active', '<span class="side-chat-step-mark side-chat-orb" aria-hidden="true"></span><div><b></b><small></small><span class="side-chat-step-tags"></span></div>');
		row.querySelector('b').textContent = label;
		const kind = SOURCES.find(s => s.id === source);
		if (kind) { const tag = make('i', 'side-chat-step-tag'); tag.textContent = kind.label; row.querySelector('.side-chat-step-tags').appendChild(tag); }
		request.steps.querySelector('ol').appendChild(row);
		status.textContent = 'Looking up · ' + label;
		thinking('Looking up · ' + label);
		seeState();
		if (stick) scrollToLatest(); else scrollState();
	}
	/** A look-up finished: its result goes under its line, and the answer is being written next. */
	function stepDone(detail, failed) {
		const row = request?.steps?.querySelector('li.is-active');
		if (!row) return;
		const stick = nearBottom();
		row.classList.remove('is-active'); row.classList.add(failed ? 'is-failed' : 'is-done');
		row.querySelector('small').textContent = detail;
		if (!request.text) request.steps.querySelector('.side-chat-wait').hidden = false;
		thinking('Thinking…');
		if (stick) scrollToLatest(); else scrollState();
	}
	function closeSteps() {
		const steps = request?.steps;
		if (!steps) return;
		steps.querySelector('li.is-active')?.classList.remove('is-active');
		steps.querySelector('.side-chat-wait').hidden = true;
		const n = steps.querySelectorAll('li').length;
		steps.querySelector('summary span').textContent = 'Looked up ' + n + (n === 1 ? ' thing' : ' things');
		steps.open = false;
	}
	const latest = panel.querySelector('.side-chat-latest');
	function nearBottom() { return body.scrollHeight - body.scrollTop - body.clientHeight < 80; }
	function scrollState() { latest.hidden = nearBottom() || !turns.length; glow(); }
	function scrollToLatest() { body.scrollTop = body.scrollHeight; scrollState(); }
	/** The light leaking in at the left edge follows the orb that is thinking. */
	function glow() {
		const orb = request?.node.closest('.side-chat-reply')?.querySelector('.side-chat-orb');
		if (!orb || panel.hidden) return;
		const box = panel.getBoundingClientRect(), at = orb.getBoundingClientRect();
		if (box.height) panel.style.setProperty('--sc-leak-y', Math.round(Math.max(0, Math.min(box.height, at.top + at.height / 2 - box.top))) + 'px');
	}
	// Markdown is re-rendered at most every few frames while streaming: long answers stay smooth.
	let lastPaint = 0, frame = 0;
	function paint(stick) {
		const r = request;
		if (!r) return;
		const draw = () => { lastPaint = Date.now(); r.node.innerHTML = MD.render(r.text); if (stick) scrollToLatest(); else scrollState(); };
		if (Date.now() - lastPaint > 60) { draw(); return; }
		if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (request === r) draw(); });
	}
	function growField() { field.style.height = 'auto'; field.style.height = Math.min(120, Math.max(40, field.scrollHeight)) + 'px'; }
	/** Docked beside the composer, as tall as the chat allows; small windows get the whole width. */
	function layout() {
		if (!open) return;
		const vw = window.innerWidth, vh = window.innerHeight;
		const anchor = $('input-card')?.getBoundingClientRect(), docked = !!anchor?.width && vw >= 640 && vh >= 600;
		const top = Math.max(12, (document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0) + 8);
		const width = Math.max(0, Math.min(expanded ? 720 : 440, vw - 24));
		const right = docked ? Math.max(12, Math.min(vw - width - 12, vw - anchor.right)) : 12;
		const bottom = docked ? Math.max(12, Math.min(vh - anchor.top + 10, vh - top - 320)) : 12;
		const room = Math.max(0, vh - bottom - top);
		const full = turns.length || !menu.hidden || !srcMenu.hidden || !moreMenu.hidden;
		panel.style.width = width + 'px';
		// Empty, the panel fits its greeting, which wraps more in wide fonts and narrow windows.
		const fits = full ? 0 : panel.querySelector('.side-chat-head').offsetHeight + panel.querySelector('.side-chat-empty').offsetHeight + panel.querySelector('.side-chat-compose').offsetHeight + 2;
		const height = expanded ? room : full ? 640 : Math.max(excerpt ? 440 : 380, fits);
		panel.style.right = right + 'px';
		panel.style.bottom = bottom + 'px';
		panel.style.height = Math.min(height, room) + 'px';
		glow();
	}
	function show(text, source) { if (!session) return; opener = source || document.activeElement; if (text !== undefined) setExcerpt(text); hideSelection(); open = true; panel.hidden = false; trigger?.setAttribute('aria-expanded', 'true'); flag(false); layout(); growField(); scrollState(); field.focus(); }
	function close() { hidePop(false); closeMenu(false); if (dictating) toggleMic(); open = false; panel.hidden = true; trigger?.setAttribute('aria-expanded', 'false'); if (opener?.isConnected) opener.focus(); }
	function controls() {
		panel.querySelector('.side-chat-send').disabled = !!request || !field.value.trim() || !model.value;
		panel.querySelector('.side-chat-stop').hidden = !request;
		model.disabled = !!request; modelBtn.disabled = !!request;
		if (request) closeMenu(false);
		srcBtn.disabled = !!request;
		if (request && pop === srcMenu) hidePop(false);
		for (const button of panel.querySelectorAll('[data-side-suggest]')) button.disabled = !!request;
		panel.classList.toggle('is-running', !!request);
		panel.classList.toggle('has-text', !!field.value.trim());
		panel.toggleAttribute('data-chat', !!turns.length);
		list.setAttribute('aria-busy', String(!!request));
		trigger?.classList.toggle('side-chat-running', !!request);
		micState();
		layout();
	}
	function models() {
		const old = model.value || modelKey;
		model.replaceChildren();
		const prompt = new Option('Choose a Side Chat model', ''); model.appendChild(prompt);
		for (const p of providers.filter(p => p.enabled && p.apiFormat !== 'acp')) {
			const group = document.createElement('optgroup'); group.label = p.name;
			for (const m of p.models.filter(m => m.enabled)) group.appendChild(new Option(m.name || m.id, JSON.stringify([p.id, m.id])));
			if (group.children.length) model.appendChild(group);
		}
		const has = value => !!value && [...model.options].some(o => o.value === value);
		const pick = [old, prefs.model, JSON.stringify([selection.providerId, selection.model])].find(has);
		model.value = pick || '';
		modelKey = model.value;
		model.title = 'Side Chat uses its own API or local model — pick a fast one. Subscription agents are unavailable here.';
		if (!request && !turns.length) notice(model.value ? '' : model.options.length > 1 ? 'Choose a model at the top to start.' : 'Add an API or local model in Settings → Providers & models to use Side Chat.');
		panel.classList.toggle('needs-model', !model.value);
		controls(); renderTrigger();
		if (!menu.hidden) renderMenu();
	}
	// ---- Model menu. The hidden select stays the source of truth; the menu only chooses for it.
	const menu = panel.querySelector('.side-chat-menu'), menuList = menu.querySelector('.side-chat-menu-list'), search = menu.querySelector('input'), modelBtn = panel.querySelector('.side-chat-model-btn');
	const menuBody = menu.querySelector('.side-chat-menu-body'), menuProviders = menu.querySelector('.side-chat-menu-providers'), menuTitle = menu.querySelector('.side-chat-menu-title'), menuCount = menu.querySelector('.side-chat-menu-count');
	const isLocal = p => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(p.baseUrl || '');
	const isFast = m => /flash|mini|haiku|lite|nano|small|turbo|instant|fast|\b\d{1,2}b\b/i.test((m.name || '') + ' ' + m.id);
	const isFree = m => /free/i.test(m.id) || (m.priceIn === 0 && m.priceOut === 0);
	const size = n => !n ? '' : n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
	const price = m => typeof m.priceIn === 'number' && typeof m.priceOut === 'number' && (m.priceIn || m.priceOut) ? '$' + +m.priceIn.toFixed(2) + ' / $' + +m.priceOut.toFixed(2) : '';
	function entries() {
		const out = [];
		for (const p of providers.filter(p => p.enabled && p.apiFormat !== 'acp')) for (const m of p.models.filter(m => m.enabled)) out.push({ value: JSON.stringify([p.id, m.id]), p, m, label: m.name || m.id });
		return out;
	}
	function tags(e) {
		const t = [];
		if (isFast(e.m)) t.push(['fast', 'Fast']);
		if (isLocal(e.p)) t.push(['local', 'Local']); else if (isFree(e.m)) t.push(['free', 'Free']);
		if (e.m.reasoning) t.push(['think', 'Thinks']);
		if (e.m.tools === false) t.push(['warn', 'No look-ups']);
		return t;
	}
	/** Fast, cheap models that can use tools suit a helper best; thinking models are slower. */
	function recommended(all) {
		const score = e => (isFast(e.m) ? 3 : 0) + (isFree(e.m) || isLocal(e.p) ? 2 : 0) + (e.m.priceIn < 0.5 ? 1 : 0) - (e.m.reasoning ? 2 : 0);
		return all.filter(e => e.m.tools !== false && score(e) >= 3).sort((a, b) => score(b) - score(a)).slice(0, 4);
	}
	const initial = name => (String(name || '?').match(/[A-Za-z0-9]/)?.[0] || '?').toUpperCase();
	function renderTrigger() {
		const e = entries().find(x => x.value === model.value);
		modelBtn.querySelector('.side-chat-model-name').textContent = e ? e.label : 'Choose a model';
		modelBtn.querySelector('.side-chat-model-ico').textContent = e ? initial(e.p.name) : '';
		modelBtn.querySelector('.side-chat-model-ico').classList.toggle('is-fast', !!e && isFast(e.m));
		modelBtn.title = e ? e.label + ' · ' + e.p.name + (e.m.contextWindow ? ' · ' + size(e.m.contextWindow) + ' context' : '') : 'Choose the model Side Chat answers with';
		modelBtn.classList.toggle('is-empty', !e);
	}
	let active = -1, menuProvider = '';
	/** Providers become the left rail; Suggested collects the fast/recent picks across providers. */
	function providerGroups(all, q) {
		const match = e => !q || (e.label + ' ' + e.p.name + ' ' + e.m.id).toLowerCase().includes(q);
		const groups = [];
		if (!q) {
			const recent = (Array.isArray(prefs.recent) ? prefs.recent : []).map(v => all.find(e => e.value === v)).filter(Boolean);
			const picks = recommended(all).filter(e => !recent.includes(e));
			const suggested = [...new Set([...recent, ...picks])];
			if (suggested.length) groups.push({ id: 'suggested', name: 'Suggested', initial: '★', models: suggested });
		}
		for (const p of providers) {
			if (!p.enabled || p.apiFormat === 'acp') continue;
			const models = all.filter(e => e.p === p && match(e));
			if (models.length) groups.push({ id: p.id, name: p.name, initial: initial(p.name), models });
		}
		return groups;
	}
	function renderMenu() {
		const all = entries(), q = search.value.trim().toLowerCase();
		const groups = providerGroups(all, q);
		const current = all.find(e => e.value === model.value);
		if (!groups.some(g => g.id === menuProvider)) {
			menuProvider = (!q && current && groups.find(g => g.id === current.p.id)?.id) || groups[0]?.id || '';
		}
		const group = groups.find(g => g.id === menuProvider);
		menuBody.classList.toggle('is-single', !groups.length);
		menuProviders.hidden = !groups.length;
		menuProviders.replaceChildren();
		for (const g of groups) {
			const btn = make('button', 'side-chat-provider');
			btn.type = 'button'; btn.dataset.provider = g.id;
			btn.setAttribute('aria-pressed', String(g.id === menuProvider));
			btn.title = g.name + ' — ' + g.models.length + ' ' + (g.models.length === 1 ? 'model' : 'models');
			btn.innerHTML = '<span class="side-chat-provider-ico" aria-hidden="true"></span><b></b><small></small>';
			btn.querySelector('.side-chat-provider-ico').textContent = g.initial;
			btn.querySelector('b').textContent = g.name;
			btn.querySelector('small').textContent = String(g.models.length);
			btn.addEventListener('click', () => {
				if (menuProvider === g.id) { search.focus(); return; }
				menuProvider = g.id; renderMenu(); search.focus(); setActive(0);
			});
			menuProviders.appendChild(btn);
		}
		menuTitle.textContent = group ? group.name : (q ? 'No matches' : 'Models');
		menuCount.textContent = group ? group.models.length + ' ' + (group.models.length === 1 ? 'model' : 'models') : '';
		menuList.setAttribute('aria-label', group ? group.name : 'Models');
		menuList.replaceChildren();
		active = -1; search.removeAttribute('aria-activedescendant');
		if (!group) {
			menuList.appendChild(make('div', 'side-chat-menu-empty', q ? 'No model matches “' + q.replace(/[<>&"]/g, '') + '”.' : 'No API or local models yet. Add one in Settings → Providers.'));
			return;
		}
		let n = 0;
		for (const e of group.models) {
			const opt = make('div', 'side-chat-opt'); opt.id = 'side-chat-opt-' + n++; opt.setAttribute('role', 'option'); opt.dataset.value = e.value;
			opt.setAttribute('aria-selected', String(e.value === model.value));
			const meta = [e.p.name, size(e.m.contextWindow) && size(e.m.contextWindow) + ' context', price(e.m) && price(e.m) + ' per M'].filter(Boolean).join(' · ');
			opt.innerHTML = '<span class="side-chat-opt-ico" aria-hidden="true"></span><span class="side-chat-opt-main"><b></b><small></small></span><span class="side-chat-opt-tags"></span><span class="side-chat-opt-check" aria-hidden="true">' + I('check') + '</span>';
			opt.querySelector('.side-chat-opt-ico').textContent = initial(e.p.name);
			opt.querySelector('b').textContent = e.label;
			opt.querySelector('small').textContent = meta;
			if (e.m.note) opt.title = e.m.note;
			for (const [kind, text] of tags(e)) { const tag = make('i', 'side-chat-tag is-' + kind); tag.textContent = text; opt.querySelector('.side-chat-opt-tags').appendChild(tag); }
			opt.addEventListener('pointerenter', () => setActive([...menuList.querySelectorAll('.side-chat-opt')].indexOf(opt)));
			opt.addEventListener('click', () => choose(e.value));
			menuList.appendChild(opt);
		}
		const opts = [...menuList.querySelectorAll('.side-chat-opt')];
		setActive(Math.max(0, opts.findIndex(o => o.dataset.value === model.value)));
	}
	function setActive(i) {
		const opts = [...menuList.querySelectorAll('.side-chat-opt')];
		active = opts.length ? (i + opts.length) % opts.length : -1;
		opts.forEach((o, k) => o.classList.toggle('is-active', k === active));
		if (active >= 0) { search.setAttribute('aria-activedescendant', opts[active].id); opts[active].scrollIntoView?.({ block: 'nearest' }); } else search.removeAttribute('aria-activedescendant');
	}
	/** Popovers drop down from the header, inside the panel. */
	function placeBelow(el, maxWidth) {
		const box = panel.getBoundingClientRect(), head = panel.querySelector('.side-chat-head').getBoundingClientRect();
		el.style.top = Math.max(8, head.bottom - box.top + 2) + 'px';
		el.style.right = '12px';
		el.style.width = Math.max(0, Math.min(box.width - 24, maxWidth)) + 'px';
		el.style.maxHeight = Math.max(0, box.bottom - head.bottom - 16) + 'px';
	}
	function openMenu() {
		if (request || !menu.hidden) return;
		hidePop(false);
		menu.hidden = false; layout();
		placeBelow(menu, Infinity);
		panel.classList.add('has-pop');
		menuProvider = ''; search.value = ''; modelBtn.setAttribute('aria-expanded', 'true');
		renderMenu(); search.focus();
	}
	function closeMenu(refocus = true) {
		if (menu.hidden) return;
		menu.hidden = true; modelBtn.setAttribute('aria-expanded', 'false');
		panel.classList.toggle('has-pop', !!pop);
		layout();
		if (refocus) modelBtn.focus();
	}
	function choose(value) {
		model.value = value; closeMenu(false);
		model.dispatchEvent(new Event('change'));
		field.focus();
	}
	modelBtn.addEventListener('click', () => menu.hidden ? openMenu() : closeMenu());
	modelBtn.addEventListener('keydown', event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); openMenu(); } });
	search.addEventListener('input', renderMenu);
	menuProviders.addEventListener('keydown', event => {
		const buttons = [...menuProviders.querySelectorAll('.side-chat-provider')];
		const index = buttons.indexOf(document.activeElement);
		if (index < 0) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
		} else if (event.key === 'ArrowRight') {
			event.preventDefault(); search.focus(); setActive(0);
		}
	});
	search.addEventListener('keydown', event => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(active + (event.key === 'ArrowDown' ? 1 : -1)); }
		else if (event.key === 'ArrowLeft') { event.preventDefault(); menuProviders.querySelector('[aria-pressed="true"]')?.focus(); }
		else if (event.key === 'Enter') { event.preventDefault(); const opt = menuList.querySelectorAll('.side-chat-opt')[active]; if (opt) choose(opt.dataset.value); }
		else if (event.key === 'Tab') closeMenu(false);
	});
	function reset(clear = false) {
		if (session) void post({ type: 'sideChatReset', sessionId: session, clear }).catch(() => {});
		request = null; turns.length = 0; pending = []; list.replaceChildren(); notice(''); field.value = ''; growField(); setExcerpt(''); latest.hidden = true; seeState(); controls();
	}
	/** A failed answer says why in place, with a retry that replaces the failed turn. */
	function failed(r, error) {
		const note = make('div', 'side-chat-error', I('alert') + '<span></span>');
		note.setAttribute('role', 'alert');
		note.querySelector('span').textContent = error;
		const retry = make('button', 'side-chat-retry', I('retry') + '<span>Retry</span>'); retry.type = 'button';
		note.appendChild(retry); r.node.after(note);
		retry.addEventListener('click', () => {
			if (request) return;
			field.value = r.question; setExcerpt(r.excerpt); growField();
			if (!model.value) { controls(); modelBtn.focus(); return; }
			const at = turns.indexOf(r.turn);
			if (at >= 0) turns.splice(at, 1);
			r.turn.remove();
			ask({ preventDefault() {} }, r.extra);
		});
	}
	function finish(error, stopped = false) {
		if (!request) return;
		const r = request;
		closeSteps();
		notice('');
		if (error) failed(r, error);
		settle(r, error ? 'error' : stopped ? 'stopped' : 'done');
		r.node.classList.remove('is-answering');
		r.node.closest('.side-chat-reply').classList.remove('is-live');
		request = null; controls(); scrollState(); seeState();
	}
	function ask(event, extra = []) {
		event.preventDefault();
		if (request || !field.value.trim() || !model.value || !session) return;
		if (dictating) toggleMic();
		const question = field.value.trim(), selectedExcerpt = excerpt, [providerId, modelId] = JSON.parse(model.value);
		extra = [...new Set([...extra, ...pending])]; pending = [];
		const turn = addTurn(question, selectedExcerpt);
		const answer = addAnswer(turn, '', true);
		const requestId = 'side-' + uid();
		request = { id: requestId, node: answer, turn, text: '', question, excerpt: selectedExcerpt, extra, startedAt: Date.now(), stream: answer.stream };
		notice(''); status.textContent = 'Thinking…'; field.value = ''; growField(); setExcerpt(''); seeState(); controls(); scrollToLatest();
		if (!clockTimer) clockTimer = setInterval(tickClock, 250);
		const asked = [...new Set([...using(), ...extra.filter(s => available.includes(s))])];
		void post({ type: 'sideChatAsk', sessionId: session, requestId, question, excerpt: selectedExcerpt, providerId, model: modelId, depth, sources: asked, remember: keep() }).catch(error => { if (request?.id === requestId) finish(error.message); });
	}
	panel.querySelector('form').addEventListener('submit', ask);
	field.addEventListener('input', () => { if (dictating) dictDraft = 0; growField(); controls(); });
	field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) ask(event); });
	body.addEventListener('scroll', scrollState, { passive: true });
	latest.addEventListener('click', scrollToLatest);
	for (const button of panel.querySelectorAll('[data-side-suggest]')) button.addEventListener('click', () => {
		const s = SUGGEST[Number(button.dataset.sideSuggest)];
		field.value = s.question; growField(); controls();
		if (!model.value) { notice('Choose a model to ask this.'); modelBtn.focus(); return; }
		ask({ preventDefault() {} }, s.source ? [s.source] : []);
	});
	see.addEventListener('click', () => {
		const all = list.querySelectorAll('.side-chat-steps'), steps = all[all.length - 1];
		if (!steps) return;
		steps.open = true; steps.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); steps.querySelector('summary').focus();
	});
	depthChip.addEventListener('click', () => { depth = depth === 'full' ? 'recent' : 'full'; prefs.depth = depth; savePrefs(); sources(); });
	for (const button of panel.querySelectorAll('[data-side-source]')) button.addEventListener('click', () => {
		const id = button.dataset.sideSource;
		if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
		prefs.sources = [...chosen]; savePrefs(); sources();
	});
	model.addEventListener('change', () => {
		modelKey = model.value;
		if (model.value) { prefs.model = model.value; prefs.recent = [model.value, ...(Array.isArray(prefs.recent) ? prefs.recent : []).filter(v => v !== model.value)].slice(0, 3); savePrefs(); }
		if (model.value && !request && !turns.length) notice('');
		panel.classList.toggle('needs-model', !model.value);
		controls(); renderTrigger();
	});
	panel.querySelector('[data-side-close]').addEventListener('click', close);
	panel.querySelector('[data-side-remove]').addEventListener('click', () => { setExcerpt(''); field.focus(); });
	for (const button of panel.querySelectorAll('[data-side-new], [data-side-new-head]')) button.addEventListener('click', () => { hidePop(false); reset(true); field.focus(); });
	panel.querySelector('[data-side-expand]').addEventListener('click', event => { const item = event.currentTarget; expanded = !expanded; item.setAttribute('aria-pressed', String(expanded)); item.querySelector('span').textContent = expanded ? 'Restore size' : 'Expand'; panel.classList.toggle('is-expanded', expanded); hidePop(false); layout(); field.focus(); });
	panel.querySelector('[data-side-orb]').addEventListener('click', () => { const next = panel.dataset.orb === 'pearl' ? 'ember' : 'pearl'; panel.dataset.orb = prefs.orb = next; savePrefs(); orbLabel(); });
	// ---- Small popovers (Sources, More). One popover is open at a time, the model menu included.
	let pop = null, popBtn = null;
	function showPop(el, btn) {
		if (pop === el) { hidePop(); return; }
		hidePop(false); closeMenu(false);
		el.hidden = false; layout();
		placeBelow(el, el === moreMenu ? 260 : 340);
		btn.setAttribute('aria-expanded', 'true'); pop = el; popBtn = btn;
		panel.classList.add('has-pop');
		el.querySelector('button:not([hidden]),label')?.focus();
	}
	function hidePop(refocus = true) {
		if (!pop) return;
		pop.hidden = true; popBtn.setAttribute('aria-expanded', 'false');
		if (refocus) popBtn.focus();
		pop = popBtn = null;
		panel.classList.toggle('has-pop', !menu.hidden);
		layout();
	}
	srcBtn.addEventListener('click', () => showPop(srcMenu, srcBtn));
	moreBtn.addEventListener('click', () => showPop(moreMenu, moreBtn));
	for (const label of [saveLabel, watchLabel]) {
		label.tabIndex = 0;
		label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); label.querySelector('input').click(); } });
	}
	for (const el of [srcMenu, moreMenu]) el.addEventListener('keydown', event => {
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
		event.preventDefault();
		const items = [...el.querySelectorAll('button:not([hidden]),label')], at = items.indexOf(document.activeElement);
		items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
	});
	panel.querySelector('.side-chat-stop').addEventListener('click', () => { if (request) { status.textContent = 'Stopping…'; thinking('Stopping…'); void post({ type: 'sideChatStop', sessionId: session, requestId: request.id }).catch(error => finish(error.message)); } });
	// ---- Voice input. The app's own dictation fills Side Chat's box while Side Chat holds it.
	function micState() {
		const listening = mic.state === 'listening' || mic.state === 'transcribing';
		micBtn.hidden = remote || mic.supported === false;
		micBtn.disabled = !!request || (listening && !dictating);
		micBtn.classList.toggle('is-listening', dictating);
		micBtn.setAttribute('aria-pressed', String(dictating));
		micBtn.title = dictating ? (mic.state === 'transcribing' ? 'Transcribing…' : 'Listening — click to stop') : listening ? 'The message box is using the microphone' : 'Dictate a question';
	}
	function toggleMic() {
		if (dictating) { void post({ type: 'micStop' }).catch(() => {}); if (mic.state !== 'listening') dictating = false; micState(); return; }
		dictating = true; dictDraft = 0; micState();
		void post({ type: 'micStart' }).catch(error => { dictating = false; micState(); notice(error.message); });
	}
	micBtn.addEventListener('click', () => { toggleMic(); field.focus(); });
	/** Live words replace themselves until the recognizer settles on them, as in the message box. */
	function dictation(text, provisional) {
		if (!dictating) return false;
		const v = field.value;
		if (dictDraft > v.length) dictDraft = 0;
		const base = dictDraft ? v.slice(0, v.length - dictDraft) : v, glue = base && !/\s$/.test(base) ? ' ' : '', t = String(text).trim();
		if (t) { field.value = base + glue + t + (provisional ? '' : ' '); dictDraft = provisional ? glue.length + t.length : 0; }
		growField(); controls();
		return true;
	}
	// ---- Session alerts: what the session is doing, said here when it needs you.
	let lastLive = 'idle';
	function flag(on) { trigger?.classList.toggle('side-chat-alert', !!on); }
	function sessionEvent(kind) {
		if (!watching() || !session) return;
		list.querySelector('.side-chat-event')?.remove();
		const text = { waiting: 'The session is waiting for you — an approval or a question.', failed: 'The last run in this session failed.', done: 'The session finished its run.' }[kind];
		const row = make('div', 'side-chat-event is-' + kind, '<span class="side-chat-event-dot" aria-hidden="true"></span><span></span>');
		row.setAttribute('role', 'status');
		row.querySelector('span:last-child').textContent = text;
		const followUp = { failed: SUGGEST[2], done: SUGGEST[0] }[kind];
		if (followUp) {
			const button = make('button', 'side-chat-event-act'); button.type = 'button'; button.textContent = kind === 'failed' ? 'Explain the failure' : 'Summarize what it did';
			button.addEventListener('click', () => { row.remove(); field.value = followUp.question; growField(); controls(); if (model.value && !request) ask({ preventDefault() {} }, followUp.source ? [followUp.source] : []); else modelBtn.focus(); });
			row.appendChild(button);
		} else {
			const button = make('button', 'side-chat-event-act'); button.type = 'button'; button.textContent = 'Show it';
			button.addEventListener('click', () => { row.remove(); const items = $('messages'); if (items) items.scrollTop = items.scrollHeight; $('input')?.focus(); });
			row.appendChild(button);
		}
		list.appendChild(row);
		// Only what needs you marks the closed Side Chat button; a finished run just leaves its note.
		if (!open && kind !== 'done') flag(true);
		scrollToLatest();
	}
	function watchState(msg) {
		if (typeof msg.runState !== 'string') return;
		const now = msg.runState, was = lastLive;
		lastLive = now;
		if (now === was || !Array.isArray(msg.sessions)) return;
		if (now === 'waiting') sessionEvent('waiting');
		else if (now === 'idle' && was !== 'idle') {
			const outcome = msg.sessions.find(s => s?.id === session)?.outcome;
			if (outcome === 'failed') sessionEvent('failed'); else if (outcome !== 'stopped') sessionEvent('done');
		}
	}
	trigger?.addEventListener('click', () => open ? close() : show(undefined, trigger));
	/** Opens Side Chat about one changed file, with the diff look-up on for that question. */
	function askAbout(path) {
		if (!session) return;
		show(undefined, document.activeElement);
		pending = ['changes', 'project'];
		field.value = 'What changed in ' + path + ', and why? Check its diff.';
		growField(); controls(); field.select();
	}
	window.SideChat = { show: text => { hideSelection(); show(text, trigger); }, hideSelection, askAbout, dictation };
	document.addEventListener('click', event => { const button = event.target instanceof Element ? event.target.closest('[data-side-ask]') : null; if (button) { event.preventDefault(); askAbout(button.dataset.sideAsk); } });
	function selectionPopup() {
		if (document.querySelector('.chat-message-menu')) { hideSelection(); return; }
		if (popup?.contains(document.activeElement)) return;
		const selected = window.getSelection();
		if (!selected || selected.isCollapsed || !selected.rangeCount) { hideSelection(); return; }
		const range = selected.getRangeAt(0);
		const element = node => node.nodeType === 1 ? node : node.parentElement;
		const start = element(range.startContainer)?.closest('#messages .md'), end = element(range.endContainer)?.closest('#messages .md');
		if (!start || start !== end || !session) { hideSelection(); return; }
		const text = selected.toString().trim();
		if (!text) { hideSelection(); return; }
		hideSelection();
		popup = make('div', 'side-chat-selection'); popup.setAttribute('role', 'toolbar'); popup.setAttribute('aria-label', 'Selected text actions');
		popup.dataset.orb = panel.dataset.orb;
		const send = make('button', '', I('chat') + '<span>Ask Side Chat</span>'); send.disabled = text.length > 24000;
		if (send.disabled) send.title = 'Select fewer than 24,000 characters.';
		popup.appendChild(send); document.body.appendChild(popup);
		popup.addEventListener('mousedown', e => e.preventDefault());
		send.addEventListener('click', () => { show(text, trigger); selected.removeAllRanges(); });
		const rect = range.getBoundingClientRect(), box = popup.getBoundingClientRect();
		if (rect.bottom < 48 || rect.top > window.innerHeight) { hideSelection(); return; }
		popup.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8)) + 'px';
		popup.style.top = Math.max(8, Math.min(rect.top > box.height + 12 ? rect.top - box.height - 8 : rect.bottom + 8, window.innerHeight - box.height - 8)) + 'px';
	}
	document.addEventListener('selectionchange', () => { if (!panel.contains(document.activeElement)) selectionPopup(); });
	$('messages')?.addEventListener('mouseup', selectionPopup);
	document.addEventListener('keydown', event => {
		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'j' && session) {
			event.preventDefault();
			if (open) close(); else show(undefined, trigger);
			return;
		}
		if (event.key !== 'Escape') return;
		if (!menu.hidden) { closeMenu(); event.preventDefault(); event.stopImmediatePropagation(); }
		else if (pop) { hidePop(); event.preventDefault(); event.stopImmediatePropagation(); }
		else if (popup) { hideSelection(); event.preventDefault(); event.stopImmediatePropagation(); }
		else if (open && panel.contains(document.activeElement)) { close(); event.preventDefault(); event.stopImmediatePropagation(); }
	}, true);
	document.addEventListener('pointerdown', event => {
		if (popup && !popup.contains(event.target)) hideSelection();
		if (!menu.hidden && !menu.contains(event.target) && !modelBtn.contains(event.target)) closeMenu(false);
		if (pop && !pop.contains(event.target) && !popBtn.contains(event.target)) hidePop(false);
	}, true);
	window.addEventListener('resize', () => { hideSelection(); hidePop(false); closeMenu(false); layout(); });
	$('messages')?.addEventListener('scroll', () => { if (popup) selectionPopup(); });
	if (window.ResizeObserver && $('input-card')) new ResizeObserver(layout).observe($('input-card'));
	/**
	 * Side Chat follows the open session: switching sessions stops the old answer, swaps in the
	 * new session's saved turns and keeps the panel where it was.
	 */
	function follow(next) {
		reset();
		session = next; modelKey = ''; model.value = ''; hideSelection(); flag(false); lastLive = 'idle';
		if (session) void post({ type: 'sideChatRestore', sessionId: session }).catch(() => {});
		else if (open) close();
	}
	window.addEventListener('message', event => {
		if (event.source && event.source !== window) return;
		const msg = event.data;
		if (msg?.type === 'state') {
			const switched = session !== msg.currentSessionId;
			if (switched) follow(msg.currentSessionId);
			if (Array.isArray(msg.sessions)) sessionTitle = msg.sessions.find(s => s?.id === session)?.title || '';
			if (typeof msg.runState === 'string') live = msg.runState;
			if (switched) lastLive = live; else watchState(msg);
			if (msg.mic && typeof msg.mic === 'object') { mic = msg.mic; if (dictating && mic.state !== 'listening' && mic.state !== 'transcribing') dictating = false; }
			remote = document.body.classList.contains('remote');
			header();
			providers = msg.providers || providers; selection = msg.selection || selection; models();
		} else if (msg?.type === 'sideChatRestored' && msg.sideChatId === sideChatId && msg.sessionId === session && !request) {
			if (Array.isArray(msg.sources)) { available = msg.sources; sources(); }
			list.replaceChildren(); turns.length = 0;
			let turn, asked;
			for (const m of msg.history || []) {
				if (m.role === 'user') { asked = parseQuestion(m.content); turn = addTurn(asked.question, asked.excerpt); }
				else if (turn) { answerFoot(addAnswer(turn, m.content), m.content, [], false, asked?.question); turn = undefined; }
			}
			setExcerpt(excerpt); controls(); seeState(); scrollToLatest();
		} else if (msg?.type === 'sideChatUpdate' && msg.sideChatId === sideChatId && msg.sessionId === session && msg.requestId === request?.id) {
			if (msg.started) {
				const orb = request.node.closest('.side-chat-reply').querySelector('.side-chat-answer-label');
				orb.querySelector('span').textContent = orb.title = 'Side Chat · ' + msg.model;
				const looks = msg.lookups ? ' · can look things up' : '';
				status.textContent = msg.model + (msg.depth === 'full' ? ' · Whole chat' : ' · Recent chat') + (msg.trimmed ? ' (older messages omitted)' : '') + looks;
				if (msg.lookupsUnavailable) status.textContent = msg.model + ' cannot use look-ups — answering from the chat only.';
			}
			if (msg.activity) step(String(msg.activity), msg.source);
			if (msg.activityDone) stepDone(String(msg.detail || ''), !!msg.failed);
			if (msg.text) {
				if (!request.text) { closeSteps(); status.textContent = 'Writing the answer…'; thinking('Writing the answer…'); }
				request.node.closest('.side-chat-reply').classList.add('has-text');
				request.text += msg.text; paint(nearBottom());
			}
			if (msg.done) {
				const stick = nearBottom();
				const r = request;
				if (msg.answer !== undefined) { r.text = msg.answer; r.node.innerHTML = MD.render(msg.answer); }
				finish(msg.error, !!msg.stopped);
				if (msg.clipped) notice('Answer reached this model’s output limit. Ask a follow-up to continue.');
				if (!msg.error) answerFoot(r.node, r.text, Array.isArray(msg.sources) ? msg.sources : [], !!msg.stopped, r.question);
				if (stick) scrollToLatest();
			}
		}
	});
	window.addEventListener('pagehide', () => { if (session) void post({ type: 'sideChatReset', sessionId: session }).catch(() => {}); });
	sources(); header(); orbLabel(); micState();
})();
