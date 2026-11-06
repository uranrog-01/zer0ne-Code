/*
 * The notch: a black pill at the top centre of the primary display for zer0ne's agent
 * runs — thinking, writing, running a step, waiting for you, finished or failed — for
 * every project in every window. While zer0ne is not in front it rests as a small pill
 * with the bell's unread count; while a zer0ne window is in front it steps aside, except
 * when another project needs your approval. Over another app's window it shrinks to a thin
 * line (hover it to open), and it steps aside for full-screen apps, keeping only an approval
 * as an amber line. Hovering opens the projects and the recent
 * notifications (the bell's feed: read in one place, read in both). It never takes
 * focus, and the pointer passes through everywhere outside the drawn pill.
 *
 * Options around the runs: keep the computer awake while agents run; Windows activity that
 * matters to them (low battery or a lost network while they run, the microphone while you
 * dictate); and a welcome-back briefing of what happened while you were away.
 *
 * And what the runs are worth your attention for: a run that looks stuck (the same step
 * failing or repeating, or no progress for minutes), what a finished run changed and whether
 * its checks passed, its spend against the task budget, its Workflow workers and the
 * project's cloud tasks. Ctrl+Alt+Z opens the notch, and again jumps to what needs you.
 */
'use strict';
const path = require('path');
const { BrowserWindow, clipboard: electronClipboard, globalShortcut, net, powerMonitor, powerSaveBlocker, screen, shell: electronShell } = require('electron');
const paths = require('./paths');
const { folderKey } = require('./engines');
const { CoverWatch } = require('./notch-cover');

/** The transparent canvas the page draws in (logical px): room for the open panel. */
const WIDTH = 480;
const HEIGHT = 560;
/** The pinned window: the open panel (420) and room for its shadow. */
const PINNED_WIDTH = 460;
/** How long a run that just ended stays on the pill; afterwards it is an unread notification. */
const FLASH_MS = 6000;
/** The page plays its closing animation before the window hides. */
const HIDE_DELAY_MS = 380;
/** The area the notch occupies at the top centre (logical px), checked for windows under it. */
const ZONE = { width: 360, height: 40 };
/** How many of the bell's notifications the open notch lists. */
const RECENT = 4;
/** Most urgent first: the briefing when you come back, you are needed, something broke or is about to, work in progress, done, the cloud's slow work. */
const RANK = { welcome: -1, waiting: 0, stuck: 1, failed: 1, budget: 1, offline: 1, battery: 1, mic: 1, tool: 2, writing: 2, thinking: 2, working: 2, done: 3, online: 3, cloud: 4 };
/** Phases that show even while a zer0ne window is in front: you are needed (or a run is), you are heard, you are back. */
const ALWAYS = new Set(['waiting', 'stuck', 'mic', 'welcome']);
/** The key that opens the notch from anywhere, and again jumps to what needs you. */
const SHORTCUT = 'CommandOrControl+Alt+Z';
/** How long the notch stays open after the shortcut. */
const SUMMON_MS = 8000;
/** Idle this long (or locked, or asleep) counts as away for the briefing. */
const AWAY_MS = 5 * 60_000;
/** Battery levels that warn once each while agents run. */
const BATTERY_WARN = [20, 10];
const PRESENCE = ['background', 'activity', 'always'];

/**
 * The saved settings (window.json): every phase on, resting while zer0ne is away, a thin line
 * over other windows, stepping aside for full-screen apps, Windows notifications kept.
 */
function cleanPrefs(p) {
	const src = p && typeof p === 'object' ? p : {};
	const on = (k) => src[k] !== false;
	return {
		on: on('on'),
		thinking: on('thinking'),
		writing: on('writing'),
		tools: on('tools'),
		waiting: on('waiting'),
		finished: on('finished'),
		presence: PRESENCE.includes(src.presence) ? src.presence : 'background',
		covered: src.covered === 'pill' ? 'pill' : 'line',
		fullscreen: on('fullscreen'),
		alerts: src.alerts === 'notch' ? 'notch' : 'both',
		keepAwake: on('keepAwake'),
		battery: src.battery === true,
		network: src.network === true,
		mic: src.mic === true,
		welcome: src.welcome === true,
		stuck: on('stuck'),
		results: on('results'),
		agents: on('agents'),
		cost: on('cost'),
		shortcut: on('shortcut'),
		private: src.private === true,
		actions: on('actions'),
		steer: on('steer'),
		drop: on('drop'),
		discreet: on('discreet'),
		health: on('health'),
		next: on('next'),
		keys: on('keys'),
		display: src.display === 'primary' ? 'primary' : 'active',
		sound: src.sound === true,
		calm: src.calm === true
	};
}

/** Whether the settings show a phase at all. */
function shows(prefs, phase) {
	if (!prefs.on) return false;
	if (phase === 'thinking') return prefs.thinking;
	if (phase === 'writing') return prefs.writing;
	if (phase === 'tool' || phase === 'working') return prefs.tools;
	if (phase === 'waiting') return prefs.waiting;
	if (phase === 'done' || phase === 'failed') return prefs.finished;
	if (phase === 'offline' || phase === 'online') return prefs.network;
	if (phase === 'battery') return prefs.battery;
	if (phase === 'mic') return prefs.mic;
	if (phase === 'welcome') return prefs.welcome;
	if (phase === 'stuck') return prefs.stuck;
	if (phase === 'budget') return prefs.cost;
	if (phase === 'cloud') return prefs.agents;
	return false;
}

/** Whether the notch announces a notification kind (done, beat, waiting) so Windows need not. */
function covers(prefs, kind) {
	const p = cleanPrefs(prefs);
	if (!p.on || p.alerts !== 'notch') return false;
	if (kind === 'waiting') return p.waiting;
	if (kind === 'done') return p.finished;
	if (kind === 'beat') return p.thinking || p.writing || p.tools;
	return false;
}

/**
 * Live runs and recent finishes, filtered by the settings and by what the user dismissed,
 * most urgent first and then oldest first. A live run hides a finish of the same project.
 */
function visibleItems(live, flashes, prefs, dismissed) {
	const keys = new Set(live.map((x) => x.key));
	return [...live, ...flashes.filter((f) => !keys.has(f.key))]
		.filter((x) => shows(prefs, x.phase) && dismissed.get(x.key) !== signature(x))
		.sort((a, b) => RANK[a.phase] - RANK[b.phase] || a.since - b.since);
}

/**
 * What is on screen, and how big. With zer0ne in front the notch steps aside (unless set to
 * always), keeping only another project that needs you; away from zer0ne it rests when nothing
 * runs ('background'), or only appears for runs and unread results ('activity'). `cover` says
 * what lies under it: over another app's window the surface is 'compact' (a thin line that
 * pops out for approvals and results); during a full-screen app it is 'quiet' (only an
 * approval, as a line).
 */
function layout(items, prefs, front, unread, cover, summoned) {
	if (!prefs.on) return { items: [], resting: false, surface: 'normal' };
	// Called up with the shortcut: everything, as a pill, whatever lies under it.
	if (summoned) return { items, resting: !items.length, surface: 'normal' };
	if (cover === 'fullscreen' && prefs.fullscreen) return { items: items.filter((x) => x.phase === 'waiting' && !x.onScreen), resting: false, surface: 'quiet' };
	if (front && prefs.presence !== 'always') return { items: items.filter((x) => ALWAYS.has(x.phase) && !x.onScreen), resting: false, surface: 'normal' };
	const resting = !items.length && (prefs.presence === 'always' || prefs.presence === 'background' || unread > 0);
	return { items, resting, surface: cover !== 'clear' && prefs.covered === 'line' ? 'compact' : 'normal' };
}

function signature(item) {
	return `${item.phase}\n${item.detail || ''}\n${item.since}`;
}

/** A length of time for people: 45s, 12m, 2h 5m. */
function span(ms) {
	const m = Math.floor(ms / 60_000);
	if (m < 1) return Math.max(1, Math.round(ms / 1000)) + 's';
	return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/** A budget amount for people: $0.42, $120, 48k, 1.2M. */
function money(kind, n) {
	if (kind === 'tokens') return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : Math.round(n / 1000) + 'k';
	return '$' + (n >= 100 ? Math.round(n) : n.toFixed(2));
}

/** "$1.60 of $2.00" (or "$0.42 spent" without a limit), for the cost meter and its warning. */
function budgetText(b) {
	const unit = b.kind === 'tokens' ? ' tokens' : '';
	return b.limit > 0 ? `${money(b.kind, b.spent)} of ${money(b.kind, b.limit)}${unit}` : `${money(b.kind, b.spent)}${unit} spent`;
}

/**
 * What happened while you were away (since `since`): runs that finished or failed (the bell's
 * feed), and what still needs you or is still working. Nothing to say: null.
 */
function briefing(feed, since, live, now) {
	const recent = feed.filter((n) => n.ts >= since);
	const done = recent.filter((n) => n.kind === 'done' && !n.failed).length;
	const failed = recent.filter((n) => n.kind === 'crash' || (n.kind === 'done' && n.failed)).length;
	const waiting = live.filter((x) => x.phase === 'waiting').length;
	const working = live.length - waiting;
	if (!done && !failed && !waiting && !working) return null;
	const parts = [];
	if (done) parts.push(plural(done, 'run finished', 'runs finished'));
	if (failed) parts.push(failed + ' failed');
	if (waiting) parts.push(waiting + (waiting === 1 ? ' needs you' : ' need you'));
	if (working) parts.push(working + ' still working');
	return { away: span(now - since), done, failed, waiting, working, detail: parts.join(' · ') };
}

/** A feed message without its leading project name (the notch shows the name on its own). */
function feedText(item) {
	const name = item.project || '';
	const m = String(item.message || '');
	for (const sep of [': ', ' — ']) if (name && m.startsWith(name + sep)) return m.slice(name.length + sep.length);
	return m;
}

class Notch {
	/** @param {import('./main').Shell} shell */
	constructor(shell) {
		this.shell = shell;
		/** @type {BrowserWindow | null} */
		this.win = null;
		/** Runs that just ended, by project key, until they expire. */
		this.flashes = new Map();
		/** Items the user dismissed (key → signature); they come back when they change. */
		this.dismissed = new Map();
		/** The Settings preview: a short scripted run, shown whatever the presence. */
		this.demo = null;
		this.view = { items: [], resting: false, surface: 'normal', unread: 0, recent: [] };
		/** What lies under the notch and the battery (notch-cover.js), watched only while the notch is on. */
		this.cover = new CoverWatch(() => this.refresh());
		/** The power-save blocker held while agents run (Keep awake), or null. */
		this.awakeId = null;
		this.online = true;
		this.offlineSince = 0;
		this.batteryWarned = null;
		this.lastSource = null;
		/** When you went away (idle, locked or asleep), for the welcome-back briefing; null while here. */
		this.awaySince = null;
		this.listening = false;
		this.queued = false;
		this.hideTimer = null;
		this.listening = false;
		/** Until when the shortcut keeps the notch open (0: not called up). */
		this.summonedUntil = 0;
		/** Whether the shortcut is registered, and whether the window is kept out of screen captures. */
		this.hotkey = false;
		this.hidden = null;
	}

	get prefs() {
		return cleanPrefs(this.shell.state.notch);
	}

	/** The bell's mute (Notifications off) also quiets the notch's results and unread count. */
	get muted() {
		return this.shell.state.notify_on_done === false;
	}

	setPrefs(prefs) {
		const next = cleanPrefs(prefs);
		if (JSON.stringify(next) === JSON.stringify(this.prefs)) return;
		this.shell.state.notch = next;
		this.shell.saveState();
		this.refresh();
	}

	/** True when the IPC call comes from the notch's own page (its main frame). */
	owns(event) {
		return !!this.win && !this.win.isDestroyed() && event.sender === this.win.webContents && event.senderFrame === event.sender.mainFrame;
	}

	/** A run ended (or an engine crashed): it shows on the pill for a few seconds, with what it changed. */
	flash(r, failed, detail, duration, result) {
		if (!r || !r.key) return;
		const shown = result && this.prefs.results ? result : null;
		// A result worth reading stays a little longer.
		// The finished turn (its user message) is kept for Undo while the chat stays open there.
		this.peek({ key: r.key, project: projectName(r.folder), folder: r.folder || null, session: r.session || null, phase: failed ? 'failed' : 'done', detail: detail || null, duration: duration || null, result: shown, turn: r.lastTurn || null, since: Date.now() }, shown || r.lastTurn ? FLASH_MS * 2 : FLASH_MS);
	}

	/** A cloud task ended: done (with its pull request) or failed. */
	flashCloud(r, t) {
		if (!r || !t) return;
		const failed = t.status === 'failed';
		const detail = (failed ? 'Cloud task failed: ' : t.prUrl ? 'Pull request ready: ' : 'Cloud task done: ') + t.task;
		this.peek({ key: `cloud:${r.key}:${t.id}`, project: projectName(r.folder), folder: r.folder || null, session: null, phase: failed ? 'failed' : 'done', detail, cloud: { status: t.status, pr: !!t.prUrl }, link: t.prUrl || t.runUrl || null, since: Date.now() }, FLASH_MS * 2);
	}

	/** Most of a run's task budget is spent. */
	warnBudget(r) {
		if (!r || !r.budget) return;
		this.peek({ key: 'budget:' + r.key, project: projectName(r.folder), folder: r.folder || null, session: r.session || null, phase: 'budget', detail: budgetText(r.budget), budget: r.budget, since: Date.now() }, 12_000);
	}

	/** Something worth a glance for `ms`: a finished run, a battery warning, the briefing. */
	peek(item, ms) {
		this.flashes.set(item.key, item);
		setTimeout(() => {
			if (this.flashes.get(item.key) === item) {
				this.flashes.delete(item.key);
				this.refresh();
			}
		}, ms).unref?.();
		this.refresh();
	}

	/** The zer0ne window in front, if any. */
	front() {
		return [...this.shell.windows].find((w) => !w.win.isDestroyed() && w.win.isFocused() && w.win.isVisible() && !w.win.isMinimized()) || null;
	}

	/**
	 * The live runs of every window (the project on screen in the front window is marked), a
	 * run that looks stuck as such, and the projects' running cloud tasks.
	 */
	live(front, prefs = this.prefs) {
		const out = [];
		for (const w of this.shell.windows) {
			if (w.win.isDestroyed()) continue;
			for (const r of w.engines.values()) {
				const onScreen = w === front && w.active === r;
				if (r.busy) {
					const stuck = prefs.stuck && r.stuck && r.phase !== 'waiting';
					out.push({ key: r.key, project: projectName(r.folder), folder: r.folder || null, session: r.session || null, phase: stuck ? 'stuck' : r.phase || 'working', detail: stuck ? r.stuck : r.detail || null, plan: r.plan || null, steps: r.steps || 0, budget: prefs.cost ? r.budget || null : null, agents: prefs.agents ? r.agents || null : null, goal: r.goal || null, approval: r.approval || null, question: r.question || null, health: prefs.health ? r.health || null : null, current: !!r.current, since: r.busySince || Date.now(), onScreen });
				}
				for (const t of r.cloudTasks || []) {
					if (t.status === 'completed' || t.status === 'failed') continue;
					out.push({ key: `cloud:${r.key}:${t.id}`, project: projectName(r.folder), folder: r.folder || null, session: null, phase: 'cloud', detail: t.task, cloud: { status: t.status, done: t.done, total: t.total }, link: t.runUrl, since: t.since, onScreen: false });
				}
			}
		}
		return out;
	}

	/** Recompute and show, once per turn of the event loop however many changes arrive. */
	refresh() {
		if (this.queued) return;
		this.queued = true;
		setImmediate(() => {
			this.queued = false;
			this.render();
		});
	}

	render() {
		if (this.disposed) return;
		const prefs = this.prefs;
		const front = this.front();
		this.readOnScreen(front);
		const live = this.live(front, prefs);
		const runs = live.filter((x) => x.phase !== 'cloud');
		this.listen();
		this.bindShortcut(prefs.on && prefs.shortcut);
		this.keepAwake(prefs.keepAwake && runs.length > 0);
		this.lastLive = runs;
		this.watch(prefs, runs);
		const flashes = this.muted ? [] : [...this.flashes.values()];
		// A dismissal lasts until that project's phase or step changes.
		const current = new Set([...live, ...flashes].map((x) => `${x.key}\n${signature(x)}`));
		for (const [key, sig] of this.dismissed) if (!current.has(`${key}\n${sig}`)) this.dismissed.delete(key);
		const results = prefs.finished && !this.muted;
		const unread = results ? this.shell.feed.filter((n) => !n.read).length : 0;
		if (prefs.on) this.cover.watch(this.zone());
		else this.cover.stop();
		const summoned = this.summonedUntil > Date.now();
		const view = this.demo
			? { items: [this.demo], resting: false, surface: 'normal' }
			: layout(visibleItems([...live, ...this.system(prefs, runs, front)], flashes, prefs, this.dismissed), prefs, !!front, unread, this.cover.state, summoned);
		const recent = results ? this.shell.feed.slice(0, RECENT).map((n) => ({ id: n.id, kind: n.kind === 'done' && n.failed ? 'failed' : n.kind, project: n.project || projectName(n.folder), text: feedText(n), ts: n.ts, read: !!n.read, open: !!n.folder })) : [];
		this.view = { ...view, unread, recent, awake: this.awakeId !== null, summoned };
		// Off: nothing can be shown, so its renderer should not stay resident either.
		if (!prefs.on) {
			this.dropWindow();
			return;
		}
		if (view.items.length || view.resting) {
			clearTimeout(this.hideTimer);
			this.hideTimer = null;
			this.ensure();
			this.protect(prefs.private || this.discreet);
			this.follow(prefs.display === 'active');
			this.push();
			if (!this.win.isVisible()) this.win.showInactive();
		} else if (this.win && !this.win.isDestroyed() && this.win.isVisible() && !this.hideTimer) {
			this.push();
			this.hideTimer = setTimeout(() => {
				this.hideTimer = null;
				if (!this.view.items.length && !this.view.resting && this.win && !this.win.isDestroyed()) {
					this.win.setIgnoreMouseEvents(true, { forward: true });
					this.win.hide();
				}
			}, HIDE_DELAY_MS);
		}
	}

	/** Keep awake: the computer does not sleep while any agent runs (the display still may). */
	keepAwake(on) {
		if (on && this.awakeId === null) this.awakeId = powerSaveBlocker.start('prevent-app-suspension');
		else if (!on && this.awakeId !== null) {
			powerSaveBlocker.stop(this.awakeId);
			this.awakeId = null;
		}
	}

	/** The shortcut is registered only while the notch and the option are on; a key another app holds is left to it. */
	bindShortcut(on) {
		if (on === this.hotkey) return;
		this.hotkey = on;
		if (!on) {
			if (globalShortcut.isRegistered(SHORTCUT)) globalShortcut.unregister(SHORTCUT);
			return;
		}
		try {
			if (!globalShortcut.register(SHORTCUT, () => this.summon())) this.hotkey = false;
		} catch {
			this.hotkey = false;
		}
	}

	/** Kept out of screenshots, recordings and screen sharing; you still see it. */
	protect(on) {
		if (!this.win || this.win.isDestroyed() || on === this.hidden) return;
		this.hidden = on;
		this.win.setContentProtection(on);
	}

	/** The shortcut: the first press opens the notch; pressed again while it is open, it opens what needs you most. */
	summon() {
		if (this.summonedUntil > Date.now()) {
			this.summonedUntil = 0;
			this.jump();
			this.refresh();
			return;
		}
		this.summonedUntil = Date.now() + SUMMON_MS;
		clearTimeout(this.summonTimer);
		this.summonTimer = setTimeout(() => this.refresh(), SUMMON_MS + 50);
		this.summonTimer.unref?.();
		this.refresh();
	}

	/** Open the most urgent thing on the notch: an approval, a stuck run, a failure, a run; else the app. */
	jump() {
		const order = ['waiting', 'stuck', 'failed', 'budget', 'done', 'tool', 'writing', 'thinking', 'working', 'cloud'];
		const pick = order.map((phase) => this.view.items.find((x) => x.phase === phase && (x.folder || x.link))).find(Boolean);
		if (!pick || !this.open(pick.key)) this.open('app');
	}

	/** Lock, sleep and wake: away and back for the briefing. Registered once the app is ready. */
	listen() {
		if (this.listening) return;
		this.listening = true;
		const away = () => {
			if (this.prefs.welcome && this.awaySince === null) this.awaySince = Date.now();
		};
		powerMonitor.on('lock-screen', away);
		powerMonitor.on('suspend', away);
		powerMonitor.on('unlock-screen', () => this.back());
		powerMonitor.on('resume', () => this.back());
	}

	/** The timers behind Windows activity and the briefing run only while their option is on. */
	watch(prefs, live) {
		const network = prefs.on && prefs.network;
		if (network && !this.netTimer) {
			this.netTimer = setInterval(() => this.checkNetwork(), 5000);
			this.netTimer.unref?.();
		} else if (!network && this.netTimer) {
			clearInterval(this.netTimer);
			this.netTimer = null;
			this.online = true;
		}
		const welcome = prefs.on && prefs.welcome;
		if (welcome && !this.awayTimer) {
			this.awayTimer = setInterval(() => this.checkAway(), 5000);
			this.awayTimer.unref?.();
		} else if (!welcome && this.awayTimer) {
			clearInterval(this.awayTimer);
			this.awayTimer = null;
			this.awaySince = null;
		}
		if (prefs.on && prefs.battery) this.checkBattery(live);
	}

	checkNetwork() {
		const online = net.isOnline();
		if (online === this.online) return;
		this.online = online;
		if (!online) this.offlineSince = Date.now();
		else if (this.lastLive && this.lastLive.length) this.peek({ key: 'sys:network', project: 'Network', phase: 'online', detail: 'Back online after ' + span(Date.now() - this.offlineSince), since: Date.now() }, 4000);
		this.refresh();
	}

	/** Warn once at 20% and again at 10% while agents run on battery, and when the charger comes out. */
	checkBattery(live) {
		const { source, percent } = this.cover.power;
		const was = this.lastSource;
		this.lastSource = source;
		if (source !== 'battery') {
			this.batteryWarned = null;
			return;
		}
		if (!live.length) return;
		const runs = plural(live.length, 'run', 'runs') + ' active';
		const level = BATTERY_WARN.filter((l) => percent <= l).pop() ?? null;
		if (level !== null && level !== this.batteryWarned) {
			this.batteryWarned = level;
			this.peek({ key: 'sys:battery', project: 'Battery', phase: 'battery', detail: `${percent}% left · ${runs}`, since: Date.now() }, 10_000);
		} else if (was === 'ac') {
			this.peek({ key: 'sys:battery', project: 'Battery', phase: 'battery', detail: `On battery (${percent}%) · ${runs}`, since: Date.now() }, 6000);
		}
	}

	checkAway() {
		const idle = powerMonitor.getSystemIdleTime() * 1000;
		if (this.awaySince === null && idle >= AWAY_MS) this.awaySince = Date.now() - idle;
		else if (this.awaySince !== null && idle < 5000) this.back();
	}

	/** You are back: after long enough away, a briefing of what happened, if anything did. */
	back() {
		const since = this.awaySince;
		this.awaySince = null;
		if (since === null || Date.now() - since < AWAY_MS || !this.prefs.on || !this.prefs.welcome) return;
		const b = briefing(this.shell.feed, since, this.live(this.front()), Date.now());
		if (b) this.peek({ key: 'sys:welcome', project: 'Welcome back', phase: 'welcome', detail: b.detail, briefing: b, since: Date.now() }, 25_000);
	}

	/** Windows activity that stays while it lasts: offline while agents run, the microphone while dictating. */
	system(prefs, live, front) {
		const out = [];
		if (prefs.network && !this.online && live.length) out.push({ key: 'sys:network', project: 'Network', phase: 'offline', detail: plural(live.length, 'run', 'runs') + ' may fail', since: this.offlineSince });
		if (prefs.mic) {
			for (const w of this.shell.windows) {
				if (w.win.isDestroyed()) continue;
				for (const r of w.engines.values()) if (r.mic) out.push({ key: 'sys:mic:' + r.key, project: projectName(r.folder), phase: 'mic', detail: 'Listening', since: r.micSince || Date.now(), onScreen: w === front && w.active === r });
			}
		}
		return out;
	}

	/** Looking at a project in zer0ne reads its notifications, here and on the bell. */
	readOnScreen(front) {
		const key = front && front.active ? front.active.key : null;
		if (!key) return;
		let changed = false;
		for (const n of this.shell.feed) {
			if (!n.read && n.folder && folderKey(n.folder) === key) {
				n.read = true;
				changed = true;
			}
		}
		if (changed) this.shell.feedPush();
	}

	/** While Windows reports a presentation, the notch says only what kind of thing happens. */
	get discreet() {
		return this.prefs.discreet && this.cover.presenting;
	}

	/**
	 * What the page draws: names, phases and the feed's text, an approval's command and a question
	 * (with the opaque ids that answer them), and which actions each row offers. No folders or
	 * session ids. Discreet (presenting): no names, commands, details or inline answers.
	 */
	state() {
		const { items, resting, surface, unread, recent, awake, summoned } = this.view;
		const p = this.prefs, quiet = this.discreet;
		return {
			items: items.map(({ key, project, phase, detail, duration, plan, steps, since, briefing, result, budget, agents, goal, cloud, link, approval, question, health, current, turn }) => {
				const here = !!current && phase !== 'waiting';
				const can = {
					answer: p.actions && !quiet && !!(approval || question),
					steer: p.steer && !quiet && here && WORKING.has(phase),
					next: p.next && !quiet && phase === 'done' && !!turn
				};
				return {
					key, project: quiet ? 'A project' : project, phase, detail: quiet ? null : detail, duration, plan: quiet ? null : plan || null, steps: steps || 0, since,
					briefing: briefing || null, result: result || null, budget: budget || null, agents: agents || null, goal: quiet ? null : goal || null, cloud: cloud ? { ...cloud, link: !!link } : null,
					approval: can.answer ? approval || null : null, question: can.answer ? question || null : null, health: health || null, can
				};
			}),
			resting,
			surface,
			summoned: !!summoned,
			awake: !!awake,
			unread,
			recent: quiet ? [] : recent,
			ui: { drop: p.drop && !quiet, keys: p.keys, sound: p.sound, calm: p.calm, discreet: quiet }
		};
	}

	/**
	 * An action from a row: answer its approval (approve, reject; deny or ask also writes the
	 * project's command rule) or its question; stop or steer its run; after a finished run check
	 * it, undo it or continue. The app finds the run's engine itself; nothing the page sends is a
	 * path, and the engine checks every id against what it actually waits for.
	 */
	act(key, action, extra = {}) {
		const item = this.view.items.find((x) => x.key === key);
		if (!item || item.key.startsWith('sys:') || item.key.startsWith('cloud:') || this.discreet) return false;
		const owner = [...this.shell.windows].find((w) => !w.win.isDestroyed() && w.engines.has(item.key));
		const r = owner && owner.engines.get(item.key);
		if (!r) return false;
		const p = this.prefs;
		const answer = ['approve', 'reject', 'deny', 'ask'].includes(action) ? item.approval : null;
		if (answer && p.actions) owner.notchAct(r, { action, id: answer.id, pattern: action === 'deny' || action === 'ask' ? rulePattern(answer.text) : undefined });
		else if (action === 'answer' && p.actions && item.question) owner.notchAct(r, { action, id: item.question.id, answer: String(extra.answer || '').slice(0, 2000) });
		else if ((action === 'stop' || action === 'steer') && p.steer && item.current && WORKING.has(item.phase)) owner.notchAct(r, { action, session: item.session, text: action === 'steer' ? String(extra.text || '').slice(0, 4000) : undefined });
		else if (['check', 'undo', 'continue'].includes(action) && p.next && item.turn) {
			owner.notchAct(r, { action, session: item.session, turn: item.turn });
			this.flashes.delete(key);
		} else return false;
		this.refresh();
		return true;
	}

	/**
	 * Ask the agent of the project you were last in about something dropped on the notch (files the
	 * page read: images as base64, text as text) or, with `clipboard`, what is copied now.
	 */
	ask(text, files, clipboard) {
		if (!this.prefs.drop || this.discreet) return { ok: false, error: 'Asking from the notch is off.' };
		const target = this.shell.quickTarget();
		const r = target && target.active;
		if (!r) return { ok: false, error: 'Open a project in zer0ne first.' };
		const parts = Array.isArray(files) ? files.slice(0, 8) : [];
		if (clipboard) {
			const image = electronClipboard.readImage();
			if (!image.isEmpty()) parts.push({ name: 'copied-image.png', mime: 'image/png', base64: image.toPNG().toString('base64') });
			else {
				const copied = electronClipboard.readText();
				if (copied.trim()) parts.push({ name: 'copied.txt', text: copied.slice(0, 400_000) });
			}
			if (!parts.length) return { ok: false, error: 'Nothing is copied.' };
		}
		const prompt = String(text || '').trim() || (parts.length ? 'Look at the attached material and fix the problem it shows, or tell me what it means.' : '');
		if (!prompt) return { ok: false, error: 'Type what to ask.' };
		target.notchAct(r, { action: 'prompt', text: prompt, files: parts });
		return { ok: true, project: projectName(r.folder) };
	}

	/**
	 * Pinned, the open panel is a small window of its own: it stays open, takes the keyboard (for
	 * a reply, a question about a drop, the shortcut keys) and accepts dropped files. The window
	 * shrinks to the panel so nothing around it is blocked; unpinned it never takes focus again.
	 */
	pin(on, height) {
		if (!this.win || this.win.isDestroyed()) return;
		this.focused = !!on && this.prefs.keys;
		if (this.focused) {
			const { x, y, width } = (this.placed || this.display()).bounds;
			const h = Math.max(60, Math.min(HEIGHT, Math.round(Number(height) || 200) + 28));
			this.win.setBounds({ x: Math.round(x + (width - PINNED_WIDTH) / 2), y, width: PINNED_WIDTH, height: h });
			this.hover(true);
			this.win.setFocusable(true);
			this.win.focus();
		} else {
			this.win.setFocusable(false);
			this.win.blur();
			this.place();
			this.hover(false);
		}
	}

	push() {
		if (!this.win || this.win.isDestroyed()) return;
		this.win.webContents.executeJavaScript(`window.__zcNotch && window.__zcNotch(${JSON.stringify(this.state())})`, false).catch(() => undefined);
	}

	/** The pointer over the pill takes clicks; anywhere else they reach the window below. */
	hover(on) {
		this.held = !!on;
		if (this.win && !this.win.isDestroyed()) this.win.setIgnoreMouseEvents(!on, { forward: true });
	}

	/**
	 * Open a project's chat (a live item, a notification by `feed:<id>`), on its changes when
	 * `to` is 'changes'; a cloud task's pull request or run on GitHub; or the app (`app`).
	 */
	open(key, to) {
		if (key === 'app' || key === 'sys:welcome') {
			if (key === 'sys:welcome') this.flashes.delete(key);
			this.shell.showWindows();
			this.refresh();
			return true;
		}
		if (key.startsWith('sys:')) return false;
		if (key.startsWith('feed:')) {
			const n = this.shell.feed.find((x) => x.id === Number(key.slice(5)));
			if (!n || !n.folder) return false;
			this.read(n.id);
			this.openFolder(n.folder, n.session);
			return true;
		}
		const item = this.view.items.find((x) => x.key === key);
		if (!item) return false;
		if (key.startsWith('cloud:')) {
			if (!item.link) return false;
			void electronShell.openExternal(item.link);
		} else {
			if (!item.folder) return false;
			this.openFolder(item.folder, item.session, to === 'changes' && !!item.session);
		}
		this.summonedUntil = 0;
		if (item.phase === 'done' || item.phase === 'failed' || item.phase === 'budget') this.flashes.delete(key);
		this.refresh();
		return true;
	}

	/** The window that already has the project (on screen or in the background) switches to it. */
	openFolder(folder, session, review) {
		const key = folderKey(folder);
		const handoff = session ? { kind: 'session', sessionId: session, ...(review ? { review: true } : {}) } : null;
		const w = [...this.shell.windows].find((x) => x.engines.has(key)) || [...this.shell.windows].find((x) => folderKey(x.folder) === key);
		if (!w) {
			this.shell.openWindow(folder, handoff);
			return;
		}
		w.reveal();
		w.activate(folder, handoff);
	}

	dismiss(key) {
		if (key.startsWith('feed:')) return this.read(Number(key.slice(5)));
		const item = this.view.items.find((x) => x.key === key);
		if (!item) return false;
		if (this.flashes.has(key)) this.flashes.delete(key);
		else this.dismissed.set(key, signature(item));
		this.refresh();
		return true;
	}

	/** Mark one notification (or all, null) read: the bell on every page follows. */
	read(id) {
		this.shell.feedRead(id);
		this.shell.feedPush();
		this.refresh();
		return true;
	}

	/** Settings → Notch → Preview: a scripted run through each phase on the real notch. */
	preview() {
		clearTimeout(this.demoTimer);
		const since = Date.now();
		const cost = (spent) => ({ kind: 'cost', spent, limit: 2 });
		const steps = [
			[0, { phase: 'thinking', detail: null, plan: { done: 0, total: 4, current: 'Read the failing test' }, steps: 1, budget: cost(0.12) }],
			[2200, { phase: 'writing', detail: null, plan: { done: 1, total: 4, current: 'Explain the cause' }, steps: 3, budget: cost(0.31), agents: { workflow: true, total: 3, running: 2, queued: 1, done: 0, failed: 0, review: null } }],
			[4400, { phase: 'tool', detail: 'Running npm test', plan: { done: 2, total: 4, current: 'Run the tests' }, steps: 6, budget: cost(0.84), agents: { workflow: true, total: 3, running: 1, queued: 0, done: 2, failed: 0, review: null } }],
			[6800, { phase: 'stuck', detail: 'npm test failed 3×', plan: { done: 2, total: 4, current: 'Run the tests' }, steps: 9, budget: cost(1.64) }],
			[9400, { phase: 'waiting', detail: 'Approval needed: run "npm install"', plan: { done: 3, total: 4, current: 'Install the fix' }, steps: 10, budget: cost(1.7) }],
			[12400, { phase: 'done', detail: 'Fixed the failing build', duration: '14s', plan: null, steps: 0, result: { files: 2, added: 48, removed: 12, tests: 'passed', review: 'pass' } }],
			[17000, null]
		];
		const at = (i) => {
			const [, item] = steps[i];
			this.demo = item ? { key: 'preview', project: 'Preview', folder: null, session: null, since, ...item } : null;
			this.refresh();
			if (i + 1 < steps.length) this.demoTimer = setTimeout(() => at(i + 1), steps[i + 1][0] - steps[i][0]);
		};
		at(0);
		return true;
	}

	/** Free the notch's renderer while the notch is off; ensure() builds a new one when it is on. */
	dropWindow() {
		clearTimeout(this.hideTimer);
		this.hideTimer = null;
		const win = this.win;
		this.win = null;
		if (win && !win.isDestroyed()) win.destroy();
	}

	ensure() {
		if (this.win && !this.win.isDestroyed()) return;
		this.win = new BrowserWindow({
			width: WIDTH,
			height: HEIGHT,
			frame: false,
			transparent: true,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			focusable: false,
			alwaysOnTop: true,
			skipTaskbar: true,
			hasShadow: false,
			show: false,
			backgroundColor: '#00000000',
			title: 'zer0ne Code — Notch',
			webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
		});
		this.hidden = null;
		this.win.setAlwaysOnTop(true, 'screen-saver');
		this.win.setIgnoreMouseEvents(true, { forward: true });
		this.win.webContents.on('will-navigate', (e) => e.preventDefault());
		this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
		this.win.webContents.on('did-finish-load', () => this.push());
		this.win.on('closed', () => {
			this.win = null;
		});
		this.place();
		if (!this.listening) {
			this.listening = true;
			for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => { this.place(); this.refresh(); });
		}
		void this.win.loadFile(path.join(paths.appRoot(), 'ui', 'notch.html'));
	}

	/** The display the notch sits on: the primary one, or (by default) the one the pointer is on. */
	display() {
		if (this.prefs.display !== 'active') return screen.getPrimaryDisplay();
		try {
			return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
		} catch {
			return screen.getPrimaryDisplay();
		}
	}

	/** The notch's area at the top of its display in physical pixels, for the cover helper. */
	zone() {
		const { x, y, width } = (this.placed || this.display()).bounds;
		const rect = { x: Math.round(x + (width - ZONE.width) / 2), y, width: ZONE.width, height: ZONE.height };
		return process.platform === 'win32' ? screen.dipToScreenRect(null, rect) : rect;
	}

	/** Flush with the top edge of its display, centred. */
	place() {
		if (!this.win || this.win.isDestroyed()) return;
		this.placed = this.display();
		const { x, y, width } = this.placed.bounds;
		this.win.setBounds({ x: Math.round(x + (width - WIDTH) / 2), y, width: WIDTH, height: HEIGHT });
	}

	/** Following the display you use: checked every second and a half while the notch shows, never while you are in it. */
	follow(on) {
		if (on && !this.followTimer) {
			this.followTimer = setInterval(() => {
				if (this.held || this.focused || !this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
				const next = this.display();
				if (this.placed && next.id === this.placed.id) return;
				this.place();
				this.cover.watch(this.zone());
			}, 1500);
			this.followTimer.unref?.();
		} else if (!on && this.followTimer) {
			clearInterval(this.followTimer);
			this.followTimer = null;
			if (this.placed && this.placed.id !== screen.getPrimaryDisplay().id) this.place();
		}
	}

	dispose() {
		this.disposed = true;
		this.keepAwake(false);
		clearInterval(this.netTimer);
		clearInterval(this.awayTimer);
		clearTimeout(this.hideTimer);
		clearTimeout(this.demoTimer);
		clearTimeout(this.summonTimer);
		clearInterval(this.followTimer);
		this.bindShortcut(false);
		this.cover.stop();
		if (this.win && !this.win.isDestroyed()) this.win.destroy();
		this.win = null;
	}
}

function projectName(folder) {
	return folder ? path.basename(folder) : 'zer0ne';
}

/** Phases of a run that is working (it can be stopped or told something). */
const WORKING = new Set(['thinking', 'writing', 'tool', 'working', 'stuck']);

/** The rule a command suggests: its program and subcommand (`git push*`), or the program alone (`rm *`). Same as chat.js. */
function rulePattern(command) {
	const words = String(command).replace(/\s+# background$/, '').trim().split(/\s+/);
	return words.length > 1 && /^[\w.:-]+$/.test(words[1]) && !words[1].startsWith('-') ? words[0] + ' ' + words[1] + '*' : words[0] + (words.length > 1 ? ' *' : '');
}

module.exports = { Notch, cleanPrefs, covers, shows, visibleItems, layout, feedText, briefing, span, budgetText, rulePattern };
