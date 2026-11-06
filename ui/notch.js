/*
 * The notch page. The shell pushes what to show (window.__zcNotch): live runs, whether to
 * rest, the surface (normal; compact over another app's window; quiet during a full-screen
 * app) and the bell's unread count and recent notifications. The pill shows the most urgent
 * run (or rests with the unread count); compact and quiet surfaces draw a thin line instead,
 * which only approvals and results break out of. Hovering opens every run and the recent
 * notifications. The window passes the pointer through except while it is over the notch.
 * A run shows what it is worth your attention for: stuck, its spend, its workers, and when
 * it ends what it changed and whether its checks passed.
 */
(function () {
	'use strict';
	const shell = window.__zcShell;
	const notch = document.getElementById('notch');
	const compact = notch.querySelector('.compact');
	const expanded = notch.querySelector('.expanded');
	const runsBox = expanded.querySelector('.runs');
	const recentBox = expanded.querySelector('.recent');
	const notesBox = expanded.querySelector('.notes');
	const empty = expanded.querySelector('.empty');
	const pinButton = expanded.querySelector('[data-act="pin"]');
	const copiedButton = expanded.querySelector('[data-act="ask-copied"]');
	const asker = expanded.querySelector('.asker');
	const dropHint = expanded.querySelector('.drop-hint');
	/** How long the pointer may be away before the panel closes. */
	const CLOSE_MS = 400;
	/** A new approval opens the panel by itself this long. */
	const PEEK_MS = 6000;
	/** The line is Nusa's closed tab: small enough to read as part of the display. */
	const SIZE = { line: [72, 6], rest: [116, 26], live: [300, 34] };
	const OPEN_WIDTH = 420;
	/** How long the shortcut keeps the panel open (SUMMON_MS in app/notch.js). */
	const SUMMON_MS = 8000;

	const ICONS = {
		thinking: '<path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z"/>',
		tool: '<path d="M3.5 5l3 3-3 3M8.5 11.5h4"/>',
		waiting: '<path d="M8 4.2v4.6M8 11.6v.1"/>',
		done: '<path d="M4 8.4l2.6 2.6L12 5.5"/>',
		failed: '<path d="M5 5l6 6M11 5l-6 6"/>',
		bell: '<path d="M4.5 6.5a3.5 3.5 0 0 1 7 0c0 4 1.5 5 1.5 5H3s1.5-1 1.5-5M7 13.5h2"/>',
		online: '<path d="M2.5 6.5a8 8 0 0 1 11 0M4.5 8.8a5 5 0 0 1 7 0M6.6 11a2 2 0 0 1 2.8 0M8 13.2v.1"/>',
		offline: '<path d="M2.5 6.5a8 8 0 0 1 11 0M4.5 8.8a5 5 0 0 1 7 0M8 13.2v.1M3 3l10 10"/>',
		battery: '<path d="M2.5 5.5h9.5v5H2.5zM13.6 7.2v1.6M4.6 7.4v1.2"/>',
		mic: '<path d="M8 2.5a1.8 1.8 0 0 1 1.8 1.8v3.4a1.8 1.8 0 0 1-3.6 0V4.3A1.8 1.8 0 0 1 8 2.5zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5"/>',
		welcome: '<circle cx="8" cy="8" r="2.6"/><path d="M8 2v1.3M8 12.7V14M2 8h1.3M12.7 8H14M3.8 3.8l.9.9M11.3 11.3l.9.9M3.8 12.2l.9-.9M11.3 4.7l.9-.9"/>',
		stuck: '<path d="M12.5 6.5A4.6 4.6 0 1 0 12 10M12.8 3.6v3h-3"/>',
		budget: '<circle cx="8" cy="8" r="5"/><path d="M9.6 6.2c-.3-.5-.9-.8-1.6-.8-.9 0-1.6.5-1.6 1.2 0 1.6 3.3.8 3.3 2.5 0 .7-.7 1.3-1.7 1.3-.7 0-1.3-.3-1.6-.8M8 4.4v1M8 10.4v1.2"/>',
		cloud: '<path d="M5 12.2h6.3a2.7 2.7 0 0 0 .3-5.4 3.8 3.8 0 0 0-7.3.9A2.3 2.3 0 0 0 5 12.2z"/>'
	};
	/** Agent work in progress (here or in the cloud); everything else is something to glance at or act on. */
	const WORK = new Set(['thinking', 'writing', 'tool', 'working', 'cloud']);
	/** Glances that open the panel by themselves: you are needed, or you are back. */
	const ATTENTION = new Set(['waiting', 'welcome']);
	const KIND = { done: 'done', waiting: 'waiting', crash: 'failed', failed: 'failed' };
	const R = 9.5;
	const C = 2 * Math.PI * R;

	let view = { items: [], resting: false, surface: 'normal', summoned: false, awake: false, unread: 0, recent: [], ui: {} };
	/** Pinned: the panel stays open, takes the keyboard and accepts drops (app/notch.js pin()). */
	let pinned = false;
	/** The row the keyboard is on, the row whose reply box is open, the finished run whose Undo waits for a second click. */
	let selected = 0;
	let replying = null;
	let undoArmed = null;
	/** What was dropped and waits for its question: [{ name, mime, base64 } | { name, text }]. */
	let dropped = null;
	/** Approvals and failures already announced with a sound. */
	let sounded = new Set();
	let pinnedHeight = 0;
	let drawn = '';
	let hovering = false;
	let opened = false;
	let peekUntil = 0;
	let closeTimer = null;
	let peekTimer = null;
	let hideTimer = null;
	let topKey = null;
	let topPhase = null;
	let attentionKeys = new Set();

	/** A run still going (its time ticks), as opposed to a result or a Windows notice. */
	const live = (x) => WORK.has(x.phase) || x.phase === 'waiting' || x.phase === 'stuck';
	const CLOUD = { dispatching: 'Starting a cloud task', queued: 'Cloud task queued', in_progress: 'Cloud task running' };

	/** A budget amount: $0.42, $120, 48k, 1.2M (the shell's budgetText in app/notch.js). */
	function money(kind, n) {
		if (kind === 'tokens') return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : Math.round(n / 1000) + 'k';
		return '$' + (n >= 100 ? Math.round(n) : n.toFixed(2));
	}

	function budgetText(b) {
		const unit = b.kind === 'tokens' ? ' tokens' : '';
		const spend = b.limit > 0 ? money(b.kind, b.spent) + ' of ' + money(b.kind, b.limit) + unit : money(b.kind, b.spent) + unit + ' spent';
		return typeof b.cache === 'number' && b.cache > 0 ? spend + ' · ' + b.cache + '% cached' : spend;
	}

	/** A finished run in a few words: "3 files · tests passed". */
	function resultText(r) {
		const parts = [];
		if (r.files) parts.push(r.files + (r.files === 1 ? ' file' : ' files'));
		if (r.tests) parts.push('tests ' + r.tests);
		else if (r.review === 'pass') parts.push('review passed');
		else if (r.review) parts.push('changes requested');
		return parts.join(' · ');
	}
	const question = (x) => /^Question:/.test(x.detail || '');

	function elapsed(since) {
		const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
		const m = Math.floor(s / 60);
		return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + ':' + String(s % 60).padStart(2, '0');
	}

	function ago(ts) {
		const s = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
		if (s < 60) return 'now';
		if (s < 3600) return Math.floor(s / 60) + 'm';
		if (s < 86400) return Math.floor(s / 3600) + 'h';
		return Math.floor(s / 86400) + 'd';
	}

	/** One line for the pill and the run's headline. */
	function label(x) {
		if (x.phase === 'thinking') return 'Thinking';
		if (x.phase === 'writing') return 'Writing';
		if (x.phase === 'tool') return x.detail || 'Working';
		if (x.phase === 'working') return 'Working in another chat';
		if (x.phase === 'waiting') return question(x) ? 'Has a question' : 'Needs your approval';
		if (x.phase === 'done') return x.duration ? 'Finished in ' + x.duration : 'Finished';
		if (x.phase === 'failed') return 'Failed';
		if (x.phase === 'offline') return 'Offline';
		if (x.phase === 'online') return 'Back online';
		if (x.phase === 'battery') return 'Battery';
		if (x.phase === 'mic') return 'Listening';
		if (x.phase === 'welcome') return 'Welcome back';
		if (x.phase === 'stuck') return 'Looks stuck';
		if (x.phase === 'budget') return 'Budget almost spent';
		if (x.phase === 'cloud') return CLOUD[x.cloud && x.cloud.status] || 'Cloud task';
		return x.detail || '';
	}

	/** The run's second line in the open panel. */
	function detail(x) {
		if (x.phase === 'waiting') return (x.detail || 'Waiting for your approval or input').replace(/^Approval needed:\s*/, '');
		if (x.phase === 'done' || x.phase === 'failed') return x.detail || (x.phase === 'done' ? 'The run finished' : 'The run failed');
		if (x.phase === 'welcome') return x.briefing ? 'You were away ' + x.briefing.away : '';
		if (x.phase === 'mic') return 'The microphone is on for dictation';
		if (x.phase === 'cloud') return x.detail || '';
		if (x.phase === 'budget') return 'Most of this run’s task budget is spent';
		if (!WORK.has(x.phase)) return x.detail || '';
		const head = label(x);
		const plan = x.plan && x.plan.current && x.phase !== 'tool' ? ' · ' + x.plan.current : '';
		return x.steps ? head + plan + ' · step ' + x.steps : head + plan;
	}

	/** The glyph: a progress ring around the phase's icon (bars while writing). */
	function glyph(x, small, quiet) {
		const el = document.createElement('span');
		el.className = 'glyph' + (small ? ' sm' : '');
		el.dataset.phase = x.phase;
		const solid = !WORK.has(x.phase);
		if (solid) el.classList.add('solid');
		if ((x.phase === 'waiting' || x.phase === 'mic') && !quiet) el.classList.add('pulse');
		const plan = x.plan && x.plan.total ? x.plan.done / x.plan.total : null;
		const ring = solid ? '' : '<svg class="ring" viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="' + R + '"/><circle class="arc" cx="11" cy="11" r="' + R + '" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + (C * (1 - (plan === null ? 0.28 : Math.max(0.04, plan)))).toFixed(2) + '"/></svg>';
		if (!solid && plan === null) el.classList.add('spin');
		if (x.phase === 'thinking') el.classList.add('breathe');
		const icon = x.phase === 'writing' ? '<span class="bars"><i></i><i></i><i></i></span>' : '<svg class="icon" viewBox="0 0 16 16">' + (ICONS[x.phase] || ICONS.tool) + '</svg>';
		el.innerHTML = ring + icon;
		return el;
	}

	function text(tag, cls, value) {
		const el = document.createElement(tag);
		if (cls) el.className = cls;
		el.textContent = value;
		return el;
	}

	function drawCompact() {
		const top = view.items[0];
		const box = compact;
		box.replaceChildren();
		if (!top) {
			const logo = document.createElement('img');
			logo.className = 'logo';
			logo.src = 'logo.svg';
			logo.alt = '';
			logo.width = 14;
			logo.height = 14;
			box.append(logo);
			if (view.unread) {
				box.append(text('span', 'label', 'New'));
				const badge = text('span', 'badge', view.unread > 9 ? '9+' : String(view.unread));
				box.append(badge);
			} else {
				box.append(text('span', 'label', 'Ready'));
			}
			return;
		}
		box.append(glyph(top));
		const l = text('span', 'label', label(top) + (top.phase === 'thinking' || top.phase === 'writing' ? '…' : ''));
		if (top.phase === 'thinking' || top.phase === 'writing') l.classList.add('shimmer');
		l.dataset.phase = top.phase;
		box.append(l);
		const notice = !live(top) && top.phase !== 'done' && top.phase !== 'failed';
		const outcome = top.result ? resultText(top.result) : '';
		const meta = text('span', 'meta', live(top) ? top.project + ' · ' + elapsed(top.since) : outcome || (notice && top.phase !== 'mic' ? top.detail || '' : top.project));
		if (live(top)) meta.dataset.since = String(top.since);
		meta.dataset.project = top.project;
		box.append(meta);
		if (view.items.length > 1) box.append(text('span', 'badge', '+' + (view.items.length - 1)));
	}

	/** The welcome-back card: how long you were away and what happened, in coloured counts. */
	function briefRow(x) {
		const b = x.briefing || {};
		const row = document.createElement('div');
		row.className = 'run brief';
		row.dataset.phase = 'welcome';
		row.append(glyph(x, true));
		const body = document.createElement('span');
		body.className = 'run-text';
		body.append(text('span', 'run-name', 'Welcome back'), text('span', 'run-what', detail(x)));
		row.append(body, text('span', 'run-time', 'now'));
		const stats = document.createElement('span');
		stats.className = 'stats';
		for (const [n, words, phase] of [[b.done, 'finished', 'done'], [b.failed, 'failed', 'failed'], [b.waiting, b.waiting === 1 ? 'needs you' : 'need you', 'waiting'], [b.working, 'working', 'tool']]) {
			if (!n) continue;
			const chip = text('span', 'stat', n + ' ' + words);
			chip.dataset.phase = phase;
			stats.append(chip);
		}
		const ask = document.createElement('span');
		ask.className = 'ask';
		const open = text('button', 'btn primary', 'Open zer0ne');
		open.type = 'button';
		open.dataset.open = x.key;
		const later = text('button', 'btn', 'Dismiss');
		later.type = 'button';
		later.dataset.dismiss = x.key;
		ask.append(open, later);
		row.append(stats, ask);
		return row;
	}

	function button(label, attrs, primary) {
		const b = text('button', primary ? 'btn primary' : 'btn', label);
		b.type = 'button';
		for (const [k, v] of Object.entries(attrs)) b.dataset[k] = v;
		return b;
	}

	/** A row action the shell runs (app/notch.js act()). */
	const doButton = (label, x, what, primary, extra) => {
		const { title, ...data } = extra || {};
		const b = button(label, { do: what, key: x.key, ...data }, primary);
		if (title) b.title = title;
		return b;
	};

	/** The buttons a row holds; a row without any opens its chat when clicked. */
	function actions(x) {
		const can = x.can || {};
		if (x.phase === 'waiting' && x.approval) {
			const out = [doButton('Approve', x, 'approve', true), doButton('Reject', x, 'reject')];
			if (x.approval.kind === 'command') out.push(doButton('Never run it', x, 'deny', false, { title: 'Reject it and add a deny line to the project’s command rules' }));
			out.push(button('Open chat', { open: x.key }));
			return out;
		}
		if (x.phase === 'waiting' && x.question) return [...x.question.options.map((o) => doButton(o, x, 'answer', false, { answer: o })), doButton('Reply…', x, 'reply'), button('Open chat', { open: x.key })];
		if (can.steer) return [doButton('Reply…', x, 'reply'), doButton('Stop', x, 'stop', false, { danger: '' })];
		if (can.next) {
			const out = [];
			if (x.result && x.result.files) out.push(button('Review changes', { open: x.key, to: 'changes' }, true));
			out.push(doButton('Check it', x, 'check', !out.length), doButton(undoArmed === x.key ? 'Confirm undo' : 'Undo', x, 'undo', false, undoArmed === x.key ? { danger: '' } : null), doButton('Continue', x, 'continue'));
			return out;
		}
		if (x.phase === 'waiting') return [button('Open chat', { open: x.key }, true), button('Later', { dismiss: x.key })];
		if (x.phase === 'stuck' || x.phase === 'budget') return [button('Open chat', { open: x.key }, true), button('Dismiss', { dismiss: x.key })];
		if (x.cloud && x.cloud.link && (x.phase === 'done' || x.phase === 'failed')) return [button(x.cloud.pr ? 'Open pull request' : 'Open on GitHub', { open: x.key }, true), button('Dismiss', { dismiss: x.key })];
		if (x.result && x.result.files) return [button('Open changes', { open: x.key, to: 'changes' }, true), button('Open chat', { open: x.key })];
		return [];
	}

	/** What a finished run did, as chips: files, lines, checks and the review. */
	function resultChips(r) {
		const chips = document.createElement('span');
		chips.className = 'stats';
		const chip = (value, phase, cls) => {
			const c = text('span', 'stat' + (cls ? ' ' + cls : ''), value);
			if (phase) c.dataset.phase = phase;
			chips.append(c);
			return c;
		};
		if (r.files) {
			chip(r.files + (r.files === 1 ? ' file' : ' files'), null, 'plain');
			const lines = chip('', null, 'plain lines');
			lines.append(text('b', 'add', '+' + r.added), text('b', 'del', '−' + r.removed));
		}
		if (r.tests) chip(r.tests === 'passed' ? 'Tests passed' : 'Tests failed', r.tests === 'passed' ? 'done' : 'failed');
		if (r.review) chip(r.review === 'pass' ? 'Review passed' : r.review === 'changes' ? 'Changes requested' : 'Review blocked', r.review === 'pass' ? 'done' : 'waiting');
		return chips;
	}

	/** A Workflow's workers as dots (done, running, waiting, failed) and the review's state. */
	function lanes(a) {
		const box = document.createElement('span');
		box.className = 'lanes';
		const dots = document.createElement('span');
		dots.className = 'dots';
		const kinds = [['done', a.done], ['failed', a.failed], ['running', a.running], ['queued', a.queued]];
		for (const [kind, n] of kinds) for (let i = 0; i < Math.min(n, 12); i++) {
			const d = document.createElement('i');
			d.className = kind;
			dots.append(d);
		}
		const who = a.workflow ? (a.total === 1 ? 'worker' : 'workers') : a.total === 1 ? 'helper' : 'helpers';
		const parts = [a.done + ' of ' + a.total + ' ' + who + ' done'];
		if (a.failed) parts.push(a.failed + ' failed');
		if (a.review === 'running') parts.push('reviewing');
		else if (a.review === 'pass') parts.push('review passed');
		else if (a.review === 'changes') parts.push('changes requested');
		else if (a.workflow && !a.review && a.done + a.failed === a.total) parts.push('review next');
		box.append(dots, text('span', '', parts.join(' · ')));
		return box;
	}

	/** A /goal the run works toward: which round of how many, and the check that decides it. */
	function goalLine(g) {
		const line = text('span', 'goal', 'Goal · ' + g.rounds + ' of ' + g.max + ' rounds used' + (g.check ? ' · check ' + g.check : ''));
		line.title = g.objective;
		return line;
	}

	/** Spend against the task budget: a bar that warms as it fills (no bar without a limit). */
	function meter(b) {
		const box = document.createElement('span');
		box.className = 'meter';
		if (b.limit > 0) {
			const share = Math.min(1, b.spent / b.limit);
			const bar = document.createElement('span');
			bar.className = 'bar';
			bar.dataset.level = share >= 1 ? 'over' : share >= 0.8 ? 'high' : 'ok';
			const fill = document.createElement('i');
			fill.style.width = Math.max(2, Math.round(share * 100)) + '%';
			bar.append(fill);
			box.append(bar);
		}
		box.append(text('span', '', budgetText(b)));
		return box;
	}

	/** What an approval would do, exactly, and how it runs: in the sandbox or not, and what the project's rules say. */
	function approvalBox(a) {
		const box = document.createElement('span');
		box.className = 'approval';
		const verb = a.kind === 'command' ? 'Run' : a.kind === 'mcp' ? 'Call' : 'Change';
		box.append(text('span', 'approval-verb', verb), text('code', 'approval-what', a.text || '(nothing shown)'));
		const chips = document.createElement('span');
		chips.className = 'stats';
		if (a.kind === 'command') {
			const where = text('span', 'stat', a.escalate ? 'Outside the sandbox' : a.sandboxed ? 'In the sandbox' : 'Not sandboxed');
			where.dataset.phase = a.escalate ? 'failed' : a.sandboxed ? 'done' : 'waiting';
			chips.append(where);
		}
		if (a.rule === 'ask') chips.append(text('span', 'stat plain', 'The project’s rules ask for this'));
		if (a.rule === 'pending') chips.append(text('span', 'stat plain', 'An untrusted project rule would allow it'));
		if (chips.childElementCount) box.append(chips);
		return box;
	}

	/** A run's live health: its checks, files changed so far and how full the context is. */
	function healthStrip(hl) {
		const box = document.createElement('span');
		box.className = 'stats health';
		if (hl.checks) {
			const c = text('span', 'stat', hl.checks === 'passed' ? 'Checks passing' : hl.checks === 'failed' ? 'Checks failing' : 'Checks running');
			c.dataset.phase = hl.checks === 'passed' ? 'done' : hl.checks === 'failed' ? 'failed' : 'tool';
			box.append(c);
		}
		if (hl.files) box.append(text('span', 'stat plain', hl.files + (hl.files === 1 ? ' file changed' : ' files changed')));
		if (hl.context !== null && hl.context !== undefined) {
			const c = text('span', 'stat' + (hl.context >= 75 ? '' : ' plain'), 'Context ' + hl.context + '%');
			if (hl.context >= 75) {
				c.dataset.phase = 'waiting';
				c.title = 'The context is filling up: older turns will be summarized soon';
			}
			box.append(c);
		}
		return box;
	}

	/** The one-line reply to a running agent (or a question): it pins the notch while you type. */
	function replyBox(x) {
		const form = document.createElement('form');
		form.className = 'reply';
		form.dataset.key = x.key;
		const input = document.createElement('input');
		input.type = 'text';
		input.maxLength = 4000;
		input.placeholder = x.question ? 'Your answer…' : 'Tell it…';
		input.setAttribute('aria-label', x.question ? 'Answer the agent' : 'Tell the agent');
		input.autocomplete = 'off';
		input.spellcheck = false;
		form.append(input, button('Send', { send: x.key }, true));
		return form;
	}

	function runRow(x) {
		if (x.phase === 'welcome') return briefRow(x);
		const buttons = actions(x);
		// Rows with buttons hold them; Windows notices are only to read; the rest open their chat.
		const still = buttons.length > 0 || !(live(x) || x.phase === 'done' || x.phase === 'failed');
		const row = document.createElement(still ? 'div' : 'button');
		row.className = 'run';
		row.dataset.phase = x.phase;
		row.dataset.key = x.key;
		if (!still) {
			row.type = 'button';
			row.dataset.open = x.key;
			row.title = x.phase === 'cloud' ? 'Open the run on GitHub' : 'Open ' + x.project;
		}
		row.append(glyph(x, true));
		const body = document.createElement('span');
		body.className = 'run-text';
		body.append(text('span', 'run-name', x.project));
		const what = text('span', 'run-what', x.question ? x.question.text : detail(x));
		if (x.phase === 'waiting' && !question(x) && !x.approval) what.classList.add('mono');
		if (!x.approval) body.append(what);
		row.append(body);
		const time = text('span', 'run-time', live(x) || x.phase === 'mic' || x.phase === 'offline' ? elapsed(x.since) : ago(x.since));
		if (live(x) || x.phase === 'mic' || x.phase === 'offline') time.dataset.since = String(x.since);
		row.append(time);
		const cloud = x.phase === 'cloud' && x.cloud && x.cloud.total ? { done: x.cloud.done, total: x.cloud.total, current: 'steps on GitHub' } : null;
		const plan = cloud || (x.plan && x.plan.total && x.phase !== 'waiting' ? x.plan : null);
		if (plan) {
			const line = document.createElement('span');
			line.className = 'plan';
			const bar = document.createElement('span');
			bar.className = 'bar';
			const fill = document.createElement('i');
			fill.style.width = Math.round((plan.done / plan.total) * 100) + '%';
			bar.append(fill);
			line.append(bar, text('span', '', plan.done + ' of ' + plan.total + (plan.current ? ' · ' + plan.current : '')));
			row.append(line);
		}
		if (x.approval) row.append(approvalBox(x.approval));
		if (x.goal) row.append(goalLine(x.goal));
		if (x.agents) row.append(lanes(x.agents));
		if (x.health && live(x)) row.append(healthStrip(x.health));
		if (x.budget) row.append(meter(x.budget));
		if (x.result) row.append(resultChips(x.result));
		if (buttons.length) {
			const ask = document.createElement('span');
			ask.className = 'ask';
			ask.append(...buttons);
			row.append(ask);
		}
		if (replying === x.key) row.append(replyBox(x));
		return row;
	}

	function noteRow(n) {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'note' + (n.read ? ' read' : '');
		row.dataset.kind = n.kind;
		if (n.open) row.dataset.open = 'feed:' + n.id;
		else row.disabled = true;
		const dot = document.createElement('span');
		dot.className = 'dot';
		const t = document.createElement('span');
		t.className = 'note-text';
		t.append(text('b', '', n.project + ' '), document.createTextNode(n.text));
		row.append(dot, glyph({ phase: KIND[n.kind] || 'done' }, true, true), t, text('span', 'note-time', ago(n.ts)));
		return row;
	}

	function drawExpanded() {
		const waiting = view.items.filter((x) => x.phase === 'waiting').length;
		const working = view.items.filter((x) => WORK.has(x.phase) && x.phase !== 'cloud').length;
		const stuck = view.items.filter((x) => x.phase === 'stuck').length;
		const cloud = view.items.filter((x) => x.phase === 'cloud').length;
		const parts = [];
		if (waiting) parts.push(waiting + ' need' + (waiting === 1 ? 's' : '') + ' you');
		if (stuck) parts.push(stuck + ' stuck');
		if (working) parts.push(working + ' working');
		if (cloud) parts.push(cloud + ' in the cloud');
		if (view.unread) parts.push(view.unread + ' new');
		if (view.awake) parts.push('keeping awake');
		expanded.querySelector('.summary').textContent = parts.join(' · ') || 'Nothing running';
		const rows = view.items.slice(0, 4).map(runRow);
		selected = Math.min(selected, Math.max(0, rows.length - 1));
		if (pinned && rows[selected]) rows[selected].classList.add('selected');
		runsBox.replaceChildren(...rows);
		const ui = view.ui || {};
		pinButton.hidden = !ui.keys;
		pinButton.setAttribute('aria-pressed', String(pinned));
		pinButton.classList.toggle('on', pinned);
		copiedButton.hidden = !ui.drop;
		asker.hidden = !dropped;
		if (dropped) {
			asker.querySelector('.asker-files').replaceChildren(...dropped.map((f) => text('span', 'stat plain', (f.base64 ? 'Image · ' : f.clipboard ? '' : 'File · ') + f.name)));
		}
		dropHint.hidden = !(pinned && ui.drop && !dropped);
		recentBox.hidden = !view.recent.length;
		notesBox.replaceChildren(...view.recent.map(noteRow));
		recentBox.querySelector('[data-act="read-all"]').hidden = !view.unread;
		empty.hidden = !!(view.items.length || view.recent.length);
	}

	/** Open on hover; a line on compact and quiet surfaces unless an approval or result breaks out; else a pill. */
	function mode() {
		if (opened) return 'open';
		const top = view.items[0];
		if (view.surface === 'quiet') return 'line';
		if (view.surface === 'compact') return top && !WORK.has(top.phase) ? 'live' : 'line';
		return top ? 'live' : 'rest';
	}

	/** The shape's size follows its content: fixed for the pills, measured for the panel. */
	function size() {
		const m = mode();
		notch.dataset.mode = m;
		const top = view.items[0];
		notch.dataset.phase = top ? top.phase : 'done';
		if (top && WORK.has(top.phase)) notch.dataset.live = '';
		else delete notch.dataset.live;
		const [w, h] = m === 'open' ? [OPEN_WIDTH, Math.ceil(expanded.offsetHeight)] : SIZE[m];
		notch.style.setProperty('--w', w + 'px');
		notch.style.setProperty('--h', h + 'px');
		// The pinned window follows the panel's height (app/notch.js pin()).
		if (pinned && m === 'open' && h !== pinnedHeight) {
			pinnedHeight = h;
			void shell.invoke('notch_pin', { on: true, height: h });
		}
	}

	function draw() {
		const key = JSON.stringify(view);
		if (key !== drawn) {
			drawn = key;
			drawCompact();
			drawExpanded();
		}
		size();
	}

	/** Elapsed times tick without rebuilding the rows under the pointer. */
	function tick() {
		for (const el of notch.querySelectorAll('[data-since]')) {
			const t = elapsed(Number(el.dataset.since));
			el.textContent = el.dataset.project ? el.dataset.project + ' · ' + t : t;
		}
	}

	function setOpen(on) {
		if (on === opened) return;
		opened = on;
		size();
	}

	function enter() {
		clearTimeout(closeTimer);
		if (hovering) return;
		hovering = true;
		void shell.invoke('notch_hover', { on: true });
		setOpen(true);
	}

	/** Redraw now: a reply box, an armed Undo or the keyboard's row changed what the rows hold. */
	function redraw() {
		drawn = '';
		draw();
	}

	/** Pinned, the panel stays open and the shell gives it the keyboard and drops; unpinned it is a glance again. */
	function setPinned(on) {
		on = !!on && !!(view.ui && view.ui.keys);
		if (on === pinned) return;
		pinned = on;
		if (on) {
			clearTimeout(closeTimer);
			opened = true;
			hovering = true;
		} else {
			replying = null;
			dropped = null;
			undoArmed = null;
			hovering = false;
		}
		redraw();
		pinnedHeight = on ? Math.ceil(expanded.offsetHeight) : 0;
		void shell.invoke('notch_pin', { on, height: pinnedHeight });
		if (!on) closeTimer = setTimeout(() => setOpen(Date.now() < peekUntil), CLOSE_MS);
	}

	/** A soft two-note chime (no sound file): an approval waits, or a run failed. */
	function chime(urgent) {
		try {
			const ctx = new AudioContext();
			const now = ctx.currentTime;
			for (const [i, freq] of (urgent ? [880, 660] : [660, 880]).entries()) {
				const osc = ctx.createOscillator();
				const gain = ctx.createGain();
				osc.type = 'sine';
				osc.frequency.value = freq;
				gain.gain.setValueAtTime(0, now + i * 0.14);
				gain.gain.linearRampToValueAtTime(0.06, now + i * 0.14 + 0.02);
				gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.3);
				osc.connect(gain).connect(ctx.destination);
				osc.start(now + i * 0.14);
				osc.stop(now + i * 0.14 + 0.32);
			}
			setTimeout(() => void ctx.close(), 800);
		} catch {
			/* no audio device */
		}
	}

	function leave() {
		if (!hovering || pinned) return;
		hovering = false;
		void shell.invoke('notch_hover', { on: false });
		clearTimeout(closeTimer);
		closeTimer = setTimeout(() => setOpen(Date.now() < peekUntil), CLOSE_MS);
	}

	function update(state) {
		const next = {
			items: state && Array.isArray(state.items) ? state.items : [],
			resting: !!(state && state.resting),
			surface: state && ['compact', 'quiet'].includes(state.surface) ? state.surface : 'normal',
			summoned: !!(state && state.summoned),
			awake: !!(state && state.awake),
			unread: state && Number.isFinite(state.unread) ? state.unread : 0,
			recent: state && Array.isArray(state.recent) ? state.recent : [],
			ui: state && state.ui && typeof state.ui === 'object' ? state.ui : {}
		};
		// Settings → Appearance → Motion: calm keeps the motion that shows work, nothing decorative.
		document.body.dataset.motion = next.ui.calm ? 'calm' : 'full';
		// A sound only for what needs you: a new approval or question, or a failure.
		const alarms = next.items.filter((x) => x.phase === 'waiting' || x.phase === 'failed').map((x) => x.key + x.phase + x.since);
		if (next.ui.sound && alarms.some((k) => !sounded.has(k))) chime(next.items.some((x) => x.phase === 'waiting' && !sounded.has(x.key + x.phase + x.since)));
		sounded = new Set(alarms);
		if (pinned && !next.ui.keys) setPinned(false);
		if (replying && !next.items.some((x) => x.key === replying)) replying = null;
		const fresh = next.items.filter((x) => ATTENTION.has(x.phase) && !attentionKeys.has(x.key + x.phase));
		const called = next.summoned && !view.summoned;
		attentionKeys = new Set(next.items.filter((x) => ATTENTION.has(x.phase)).map((x) => x.key + x.phase));
		view = next;
		if (!view.items.length && !view.resting) {
			if (!notch.hidden && !notch.classList.contains('leaving')) {
				notch.classList.add('leaving');
				clearTimeout(hideTimer);
				hideTimer = setTimeout(() => { notch.hidden = true; notch.classList.remove('leaving'); opened = false; }, 300);
			}
			if (pinned) setPinned(false);
			if (hovering) leave();
			return;
		}
		clearTimeout(hideTimer);
		notch.classList.remove('leaving');
		notch.hidden = false;
		// A new phase on the pill gets a small spring, so a glance catches the change.
		const top = view.items[0];
		if (top && (top.key !== topKey || top.phase !== topPhase) && !opened) {
			notch.classList.remove('pop');
			void notch.offsetWidth;
			notch.classList.add('pop');
		}
		topKey = top ? top.key : null;
		topPhase = top ? top.phase : null;
		if (called) {
			// The shortcut: open now, for as long as the shell keeps it called up.
			peekUntil = Date.now() + SUMMON_MS;
			clearTimeout(peekTimer);
			peekTimer = setTimeout(() => { if (!hovering) setOpen(false); }, SUMMON_MS);
			opened = true;
		} else if (fresh.length && !hovering && view.surface !== 'quiet') {
			// You are needed: open on it for a moment.
			peekUntil = Date.now() + PEEK_MS;
			clearTimeout(peekTimer);
			peekTimer = setTimeout(() => { if (!hovering) setOpen(false); }, PEEK_MS);
			opened = true;
		} else if (!attentionKeys.size && !view.summoned && Date.now() < peekUntil && !hovering) {
			// Answered: the panel that opened by itself closes with it.
			peekUntil = 0;
			clearTimeout(peekTimer);
			opened = false;
		}
		draw();
	}

	// While the window ignores the pointer it still forwards moves: the notch catches them here.
	// Only the shape itself counts, so passing near the line (a tab, a title bar) does not open it.
	document.addEventListener('mousemove', (e) => {
		if (notch.hidden || pinned) return;
		const r = notch.getBoundingClientRect();
		const over = e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
		if (over) enter();
		else leave();
	});
	document.addEventListener('mouseleave', leave);
	notch.addEventListener('animationend', (e) => { if (e.animationName === 'pop') notch.classList.remove('pop'); });
	expanded.addEventListener('click', (e) => {
		const t = e.target instanceof Element ? e.target : null;
		const open = t && t.closest('[data-open]');
		const dismiss = t && t.closest('[data-dismiss]');
		const act = t && t.closest('[data-act]');
		const doing = t && t.closest('[data-do]');
		const chip = t && t.closest('[data-ask]');
		if (doing) rowAction(doing.dataset.key, doing.dataset.do, doing.dataset.answer);
		else if (chip) askNow(chip.dataset.ask);
		else if (dismiss) void shell.invoke('notch_dismiss', { key: dismiss.dataset.dismiss });
		else if (open) void shell.invoke('notch_open', open.dataset.to ? { key: open.dataset.open, to: open.dataset.to } : { key: open.dataset.open });
		else if (act && act.dataset.act === 'app') void shell.invoke('notch_open', { key: 'app' });
		else if (act && act.dataset.act === 'read-all') void shell.invoke('notch_read', { id: null });
		else if (act && act.dataset.act === 'pin') setPinned(!pinned);
		else if (act && act.dataset.act === 'ask-copied') {
			dropped = [{ name: 'What you copied', clipboard: true }];
			setPinned(true);
			redraw();
			asker.querySelector('.asker-input').focus();
		} else if (act && act.dataset.act === 'ask-cancel') {
			dropped = null;
			redraw();
		}
	});

	/** A row's action: answering and stopping go straight to the shell; Reply opens the box; Undo asks twice. */
	function rowAction(key, what, answer) {
		if (what === 'reply') {
			replying = replying === key ? null : key;
			if (replying) setPinned(true);
			redraw();
			runsBox.querySelector('.reply input')?.focus();
			return;
		}
		if (what === 'undo' && undoArmed !== key) {
			undoArmed = key;
			redraw();
			setTimeout(() => { if (undoArmed === key) { undoArmed = null; redraw(); } }, 4000);
			return;
		}
		undoArmed = null;
		void shell.invoke('notch_act', { key, action: what, answer: answer || '' });
	}

	/** Sends what was dropped (or copied) with the question to the project you were last in. */
	async function askNow(question) {
		const files = (dropped || []).filter((f) => !f.clipboard);
		const clipboard = (dropped || []).some((f) => f.clipboard);
		const input = asker.querySelector('.asker-input');
		const text = String(question || input.value || '').trim();
		const result = await shell.invoke('notch_ask', { text, files, clipboard }).catch((error) => ({ ok: false, error: String(error && error.message || error) }));
		if (result && result.ok) {
			dropped = null;
			input.value = '';
			setPinned(false);
		} else {
			input.placeholder = (result && result.error) || 'Could not ask.';
			input.value = '';
		}
		redraw();
	}

	expanded.addEventListener('submit', (e) => {
		e.preventDefault();
		const form = e.target instanceof HTMLFormElement ? e.target : null;
		if (!form) return;
		if (form.classList.contains('asker')) { void askNow(''); return; }
		const key = form.dataset.key;
		const value = form.querySelector('input').value.trim();
		const item = view.items.find((x) => x.key === key);
		if (!value || !item) return;
		void shell.invoke('notch_act', item.question ? { key, action: 'answer', answer: value } : { key, action: 'steer', text: value });
		replying = null;
		redraw();
	});

	// Pinned, the keyboard drives the notch: ↑ ↓ choose a run, Enter opens it, A approves, R rejects, S stops, Esc unpins.
	document.addEventListener('keydown', (e) => {
		if (!pinned) return;
		const typing = e.target instanceof HTMLInputElement;
		if (e.key === 'Escape') {
			e.preventDefault();
			if (typing && (replying || dropped)) { replying = null; dropped = null; redraw(); }
			else setPinned(false);
			return;
		}
		if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
		const rows = view.items.slice(0, 4);
		const x = rows[selected];
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			selected = Math.max(0, Math.min(rows.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
			redraw();
		} else if (e.key === 'Enter' && x) {
			e.preventDefault();
			void shell.invoke('notch_open', { key: x.key });
		} else if (x && x.approval && (e.key === 'a' || e.key === 'A')) rowAction(x.key, 'approve');
		else if (x && x.approval && (e.key === 'r' || e.key === 'R')) rowAction(x.key, 'reject');
		else if (x && x.can && x.can.steer && (e.key === 's' || e.key === 'S')) rowAction(x.key, 'stop');
	});

	// Pinned (the window then takes the pointer itself), files, images and text dropped on the panel are asked about.
	const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
	const read = (file, how) => new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = () => reject(reader.error);
		if (how === 'url') reader.readAsDataURL(file); else reader.readAsText(file);
	});
	document.addEventListener('dragover', (e) => {
		if (!pinned || !(view.ui && view.ui.drop)) return;
		e.preventDefault();
		notch.classList.add('dropping');
	});
	document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) notch.classList.remove('dropping'); });
	document.addEventListener('drop', async (e) => {
		notch.classList.remove('dropping');
		if (!pinned || !(view.ui && view.ui.drop)) return;
		e.preventDefault();
		const out = [];
		for (const file of [...(e.dataTransfer?.files || [])].slice(0, 8)) {
			try {
				if (IMAGE.test(file.type) && file.size <= 10 * 1024 * 1024) out.push({ name: file.name, mime: file.type, base64: String(await read(file, 'url')).replace(/^data:[^,]*,/, '') });
				else if (file.size <= 400 * 1024) {
					const body = String(await read(file, 'text'));
					// A binary file read as text is mostly replacement characters: not worth sending.
					if ((body.match(/�/g) || []).length < body.length / 50) out.push({ name: file.name, mime: '', text: body });
				}
			} catch {
				/* unreadable: skipped */
			}
		}
		const plain = !out.length ? e.dataTransfer?.getData('text/plain') : '';
		if (plain && plain.trim()) out.push({ name: 'dropped text', mime: '', text: plain.slice(0, 400_000) });
		if (!out.length) return;
		dropped = out;
		redraw();
		asker.querySelector('.asker-input').focus();
	});

	setInterval(() => { if (!notch.hidden) tick(); }, 1000);

	window.__zcNotch = update;
	shell.invoke('notch_state').then(update, () => undefined);
})();
