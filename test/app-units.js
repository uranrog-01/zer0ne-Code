// The app's own modules without a window: the engine key, window state, Liquid Glass
// settings, routing rules and folder keys. (In plain Node, require('electron') is just a
// path string, so these modules load without Electron.)
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-units-'));

test('launch arguments skip the development app entry even when switches precede it', () => {
	const { folderArgs } = require('../app/launch-args');
	const entry = path.resolve('fixture-app'), project = path.resolve('fixture-project');
	assert.deepStrictEqual(folderArgs(['electron', '--remote-debugging-port=9000', '--disable-feature', entry, project], { packaged: false, entry }), [project]);
	assert.deepStrictEqual(folderArgs(['electron', entry, entry], { packaged: false, entry }), [entry]);
	assert.deepStrictEqual(folderArgs(['zer0ne', '--flag', project], { packaged: true, entry }), [project]);
	assert.deepStrictEqual(folderArgs(['electron', entry, 'relative-project'], { packaged: false, entry, cwd: project }), [path.join(project, 'relative-project')]);
});

test('bridge validation keeps project selection requirements scoped to project creation', () => {
	const { validated, allowed } = require('../app/permissions');
	assert.deepStrictEqual(validated('zc_page_ready', { activationId: 'fixture-activation' }), { activationId: 'fixture-activation' });
	assert.deepStrictEqual(validated('notify_read', { id: 7 }), { id: 7 });
	assert.deepStrictEqual(validated('glass_prefs', { prefs: { transparency: 50 } }), { prefs: { transparency: 50 } });
	assert.deepStrictEqual(validated('quick_send', { text: 'fixture prompt' }), { text: 'fixture prompt' });
	assert.strictEqual(validated('create_project', { name: 'fixture', trusted: true }), undefined);
	assert.strictEqual(validated('create_project', { selection: 123, name: 'fixture' }), undefined);
	assert.deepStrictEqual(validated('create_project', { selection: 'owned-dialog-selection', trusted: true, name: 'fixture' }), { selection: 'owned-dialog-selection', trusted: true, name: 'fixture' });
	assert.strictEqual(allowed('start', 'zc_page_ready'), false);
	assert.strictEqual(allowed('engine', 'zc_page_ready'), true);
});

test('the notch page may only read, hover, open, dismiss and mark its own items read', () => {
	const { validated, allowed } = require('../app/permissions');
	for (const command of ['notch_state', 'notch_hover', 'notch_open', 'notch_dismiss', 'notch_read']) {
		assert.strictEqual(allowed('notch', command), true);
		assert.strictEqual(allowed('engine', command), false, 'engine pages cannot drive the notch: ' + command);
	}
	for (const command of ['quick_send', 'restart_engine', 'glass_prefs', 'create_project', 'notify_feed']) assert.strictEqual(allowed('notch', command), false);
	assert.deepStrictEqual(validated('notch_hover', { on: 'yes' }), { on: false });
	assert.deepStrictEqual(validated('notch_open', { key: 'feed:3' }), { key: 'feed:3', to: 'chat' });
	assert.deepStrictEqual(validated('notch_open', { key: 'a', to: 'changes' }), { key: 'a', to: 'changes' });
	assert.strictEqual(validated('notch_open', { key: 'a', to: 'https://example.com' }), undefined);
	assert.strictEqual(validated('notch_open', {}), undefined);
	assert.strictEqual(validated('notch_dismiss', { key: 7 }), undefined);
	assert.deepStrictEqual(validated('notch_read', { id: 'all' }), { id: null });
	// Acting from the notch: fixed actions only; dropped files as content, never paths.
	for (const command of ['notch_act', 'notch_ask', 'notch_pin']) {
		assert.strictEqual(allowed('notch', command), true);
		assert.strictEqual(allowed('engine', command), false, 'engine pages cannot act through the notch: ' + command);
	}
	assert.deepStrictEqual(validated('notch_act', { key: 'k', action: 'approve' }), { key: 'k', action: 'approve', answer: '', text: '' });
	assert.strictEqual(validated('notch_act', { key: 'k', action: 'delete-project' }), undefined, 'only the row actions');
	assert.strictEqual(validated('notch_ask', { text: 'x', files: [{ name: 'a.txt', path: 'C:/secret' }] }), undefined, 'a file without content (a path) is refused');
	assert.deepStrictEqual(validated('notch_ask', { text: 'x', files: [{ name: 'a.txt', text: 'hi' }] }).files[0].text, 'hi');
	assert.strictEqual(validated('notch_ask', { files: new Array(9).fill({ name: 'a', text: 'b' }) }), undefined);
	assert.deepStrictEqual(validated('notch_pin', { on: 'yes', height: 1e9 }), { on: false, height: 0 });
});

test('the notch answers approvals and questions, steers runs and asks about drops through the run\'s own engine', () => {
	const { Notch, rulePattern } = require('../app/notch');
	assert.strictEqual(rulePattern('git push --force'), 'git push*');
	assert.strictEqual(rulePattern('rm -rf build'), 'rm *');
	assert.strictEqual(rulePattern('ls'), 'ls');
	const sent = [];
	const r = { key: 'p1', folder: 'C:/work/app' };
	const w = { win: { isDestroyed: () => false }, engines: new Map([['p1', r]]), notchAct: (eng, act) => sent.push([eng.key, act]) };
	const shell = { state: { notch: {} }, windows: new Set([w]), quickTarget: () => ({ active: r, notchAct: w.notchAct }), feed: [] };
	const n = new Notch(shell);
	n.refresh = () => {};
	const waiting = { key: 'p1', project: 'app', phase: 'waiting', session: 's1', current: true, approval: { id: 'ap1', kind: 'command', text: 'git push --force', sandboxed: false, escalate: false, rule: null }, since: 1 };
	n.view = { items: [waiting], resting: false, surface: 'normal', unread: 0, recent: [] };
	const shown = n.state().items[0];
	assert.deepStrictEqual([shown.approval.id, shown.can.answer, shown.can.steer], ['ap1', true, false], 'an approval is answerable; a waiting run is not steered');
	assert.strictEqual(JSON.stringify(n.state()).includes('C:/work'), false, 'no folders reach the page');
	assert.strictEqual(n.act('p1', 'approve'), true);
	assert.strictEqual(n.act('p1', 'deny'), true);
	assert.deepStrictEqual(sent, [['p1', { action: 'approve', id: 'ap1', pattern: undefined }], ['p1', { action: 'deny', id: 'ap1', pattern: 'git push*' }]]);
	assert.strictEqual(n.act('p1', 'stop'), false, 'stop needs a running run');
	assert.strictEqual(n.act('nope', 'approve'), false);
	const running = { key: 'p1', project: 'app', phase: 'tool', session: 's1', current: true, since: 1 };
	n.view.items = [running];
	assert.strictEqual(n.state().items[0].can.steer, true);
	sent.length = 0;
	assert.strictEqual(n.act('p1', 'steer', { text: 'use pnpm' }), true);
	assert.deepStrictEqual(sent[0], ['p1', { action: 'steer', session: 's1', text: 'use pnpm' }]);
	n.view.items = [{ ...running, current: false }];
	assert.strictEqual(n.act('p1', 'stop'), false, 'a run in another chat is not stopped from here');
	// Presenting: no names, details, commands or inline answers.
	n.cover.presenting = true;
	n.view.items = [waiting];
	const quiet = n.state();
	assert.deepStrictEqual([quiet.items[0].project, quiet.items[0].detail, quiet.items[0].approval, quiet.ui.discreet], ['A project', null, null, true]);
	assert.strictEqual(n.act('p1', 'approve'), false);
	n.cover.presenting = false;
	// Asking about a drop goes to the project you were last in.
	sent.length = 0;
	assert.deepStrictEqual(n.ask('fix it', [{ name: 'a.txt', text: 'boom' }], false), { ok: true, project: 'app' });
	assert.deepStrictEqual(sent[0], ['p1', { action: 'prompt', text: 'fix it', files: [{ name: 'a.txt', text: 'boom' }] }]);
	shell.state.notch = { drop: false };
	assert.strictEqual(n.ask('x', [], false).ok, false, 'off when Drop & ask is off');
});

test('the notch shows what its settings allow, most urgent first, and announces only what it covers', () => {
	const { cleanPrefs, covers, visibleItems, feedText } = require('../app/notch');
	assert.deepStrictEqual(cleanPrefs(null), { on: true, thinking: true, writing: true, tools: true, waiting: true, finished: true, presence: 'background', covered: 'line', fullscreen: true, alerts: 'both', keepAwake: true, battery: false, network: false, mic: false, welcome: false, stuck: true, results: true, agents: true, cost: true, shortcut: true, private: false, actions: true, steer: true, drop: true, discreet: true, health: true, next: true, keys: true, display: 'active', sound: false, calm: false });
	assert.strictEqual(cleanPrefs({ presence: 'sometimes', alerts: 'loud' }).presence, 'background');
	const live = [
		{ key: 'a', phase: 'thinking', since: 1 },
		{ key: 'b', phase: 'waiting', since: 3 },
		{ key: 'c', phase: 'tool', detail: 'Running npm test', since: 2 }
	];
	const flashes = [{ key: 'd', phase: 'done', since: 4 }, { key: 'a', phase: 'failed', since: 5 }];
	const all = cleanPrefs({});
	assert.deepStrictEqual(visibleItems(live, flashes, all, new Map()).map((x) => x.key), ['b', 'a', 'c', 'd'], 'a wait first, live work by age, a live run hides its own old finish');
	assert.deepStrictEqual(visibleItems(live, flashes, cleanPrefs({ thinking: false, finished: false }), new Map()).map((x) => x.key), ['b', 'c']);
	assert.deepStrictEqual(visibleItems(live, flashes, cleanPrefs({ on: false }), new Map()), []);
	const dismissed = new Map([['b', ['waiting', '', 3].join('\n')]]);
	assert.deepStrictEqual(visibleItems(live, [], all, dismissed).map((x) => x.key), ['a', 'c'], 'a dismissed wait stays hidden');
	assert.deepStrictEqual(visibleItems([{ ...live[1], detail: 'Question: "Which port?"' }], [], all, dismissed).map((x) => x.key), ['b'], 'a new wait comes back');
	assert.strictEqual(covers({}, 'waiting'), false, 'Windows notifications stay by default');
	assert.strictEqual(covers({ alerts: 'notch' }, 'waiting'), true);
	assert.strictEqual(covers({ alerts: 'notch', waiting: false }, 'waiting'), false, 'a phase the notch hides still notifies');
	assert.strictEqual(covers({ alerts: 'notch', on: false }, 'done'), false);
	assert.strictEqual(covers({ alerts: 'notch' }, 'crash'), false, 'crashes always notify');
	assert.strictEqual(feedText({ project: 'api', message: 'api: Fixed it (2m)' }), 'Fixed it (2m)');
	assert.strictEqual(feedText({ project: 'api', message: 'api — Approval needed' }), 'Approval needed');
});

test('the notch rests while zer0ne is away, shrinks to a line over other windows and steps aside in front and for full-screen apps', () => {
	const { cleanPrefs, layout } = require('../app/notch');
	const work = { key: 'a', phase: 'tool', onScreen: false };
	const mine = { key: 'b', phase: 'waiting', onScreen: true };
	const other = { key: 'c', phase: 'waiting', onScreen: false };
	const away = cleanPrefs({});
	const at = (items, resting, surface) => ({ items, resting, surface });
	assert.deepStrictEqual(layout([], away, false, 0, 'clear'), at([], true, 'normal'), 'a small resting pill over the desktop');
	assert.deepStrictEqual(layout([], away, false, 0, 'covered'), at([], true, 'compact'), 'a thin line over another window');
	assert.deepStrictEqual(layout([work], away, false, 0, 'covered'), at([work], false, 'compact'));
	assert.deepStrictEqual(layout([work], cleanPrefs({ covered: 'pill' }), false, 0, 'covered'), at([work], false, 'normal'), 'the pill can stay over other windows');
	assert.deepStrictEqual(layout([work, mine, other], away, true, 3, 'covered'), at([other], false, 'normal'), 'in front: only another project that needs you');
	assert.deepStrictEqual(layout([], away, true, 3, 'clear'), at([], false, 'normal'));
	assert.deepStrictEqual(layout([work, other], away, false, 2, 'fullscreen'), at([other], false, 'quiet'), 'full-screen apps: only an approval, quietly');
	assert.deepStrictEqual(layout([work], cleanPrefs({ fullscreen: false }), false, 0, 'fullscreen'), at([work], false, 'compact'));
	const activity = cleanPrefs({ presence: 'activity' });
	assert.deepStrictEqual(layout([], activity, false, 0, 'clear'), at([], false, 'normal'), 'activity: nothing to say, nothing shown');
	assert.deepStrictEqual(layout([], activity, false, 2, 'clear'), at([], true, 'normal'), 'activity: unread results keep the pill');
	const always = cleanPrefs({ presence: 'always' });
	assert.deepStrictEqual(layout([work, mine], always, true, 0, 'covered'), at([work, mine], false, 'compact'));
	assert.deepStrictEqual(layout([work], cleanPrefs({ on: false }), false, 1, 'clear'), at([], false, 'normal'));
});

test('Windows activity and the welcome-back briefing show only when chosen, and the briefing says what happened', () => {
	const { cleanPrefs, shows, layout, briefing, span } = require('../app/notch');
	const off = cleanPrefs({});
	for (const phase of ['offline', 'online', 'battery', 'mic', 'welcome']) assert.strictEqual(shows(off, phase), false, phase + ' is opt-in');
	const on = cleanPrefs({ battery: true, network: true, mic: true, welcome: true });
	for (const phase of ['offline', 'online', 'battery', 'mic', 'welcome']) assert.strictEqual(shows(on, phase), true);
	const mic = { key: 'sys:mic:a', phase: 'mic', onScreen: false };
	const welcome = { key: 'sys:welcome', phase: 'welcome' };
	const work = { key: 'a', phase: 'tool' };
	assert.deepStrictEqual(layout([welcome, mic, work], on, true, 0, 'clear').items, [welcome, mic], 'zer0ne in front: the briefing and the microphone still show');
	assert.deepStrictEqual(layout([{ ...mic, onScreen: true }], on, true, 0, 'clear').items, [], 'not for the chat you are dictating into');
	const now = Date.UTC(2026, 9, 26, 12);
	const since = now - 42 * 60_000;
	const feed = [
		{ kind: 'done', ts: now - 60_000 },
		{ kind: 'done', ts: now - 120_000 },
		{ kind: 'done', failed: true, ts: now - 180_000 },
		{ kind: 'crash', ts: now - 240_000 },
		{ kind: 'done', ts: since - 60_000 }
	];
	const live = [{ phase: 'waiting' }, { phase: 'tool' }, { phase: 'thinking' }];
	assert.deepStrictEqual(briefing(feed, since, live, now), { away: '42m', done: 2, failed: 2, waiting: 1, working: 2, detail: '2 runs finished · 2 failed · 1 needs you · 2 still working' });
	assert.strictEqual(briefing([{ kind: 'done', ts: since - 1 }], since, [], now), null, 'nothing happened: no briefing');
	assert.deepStrictEqual([span(45_000), span(12 * 60_000), span(125 * 60_000), span(120 * 60_000)], ['45s', '12m', '2h 5m', '2h']);
});

test('run insights: stuck runs, the cost meter, workers and cloud tasks follow their settings; the shortcut shows everything', () => {
	const { cleanPrefs, shows, layout, budgetText } = require('../app/notch');
	const all = cleanPrefs({});
	for (const phase of ['stuck', 'budget', 'cloud']) {
		assert.strictEqual(shows(all, phase), true, phase + ' is on by default');
		assert.strictEqual(shows(cleanPrefs({ stuck: false, cost: false, agents: false }), phase), false, phase + ' can be turned off');
	}
	const stuck = { key: 'a', phase: 'stuck', onScreen: false };
	const work = { key: 'b', phase: 'tool', onScreen: false };
	const cloud = { key: 'cloud:c:1', phase: 'cloud', onScreen: false };
	assert.deepStrictEqual(layout([stuck, work, cloud], all, true, 0, 'clear').items, [stuck], 'zer0ne in front: a stuck run in another project still shows');
	assert.deepStrictEqual(layout([{ ...stuck, onScreen: true }], all, true, 0, 'clear').items, [], 'not the run you are looking at');
	assert.deepStrictEqual(layout([work, cloud], all, true, 0, 'fullscreen', true), { items: [work, cloud], resting: false, surface: 'normal' }, 'the shortcut calls up everything, even over a full-screen app');
	assert.deepStrictEqual(layout([], all, true, 0, 'covered', true), { items: [], resting: true, surface: 'normal' });
	assert.strictEqual(budgetText({ kind: 'cost', spent: 1.6, limit: 2 }), '$1.60 of $2.00');
	assert.strictEqual(budgetText({ kind: 'cost', spent: 0.42, limit: 0 }), '$0.42 spent');
	assert.strictEqual(budgetText({ kind: 'tokens', spent: 48_000, limit: 1_500_000 }), '48k of 1.5M tokens');
	const { cleanBudget, cleanAgents, cleanGoal, cleanResult, cleanCloud, idleRetirable } = require('../app/engines');
	assert.deepStrictEqual(cleanBudget({ kind: 'cost', spent: -1, limit: 2 }), { kind: 'cost', spent: 0, limit: 2, cache: null });
	assert.strictEqual(cleanBudget({ kind: 'cost', spent: 1, cache: 62 }).cache, 62);
	assert.strictEqual(cleanBudget({ kind: 'cost', spent: 1, cache: 140 }).cache, null);
	assert.deepStrictEqual(cleanGoal({ objective: 'x'.repeat(300), rounds: 9, max: 5, check: 'npm test' }), { objective: 'x'.repeat(160), rounds: 5, max: 5, check: 'npm test' });
	assert.strictEqual(cleanGoal({ objective: 'x', max: 0 }), null);
	assert.strictEqual(cleanBudget({ kind: 'euros', spent: 1 }), null);
	assert.strictEqual(cleanAgents({ total: 0 }), null);
	assert.deepStrictEqual(cleanAgents({ workflow: true, total: 3, running: 1, queued: 1, done: 1, review: 'nope' }), { workflow: true, total: 3, running: 1, queued: 1, done: 1, failed: 0, review: null });
	assert.deepStrictEqual(cleanResult({ files: 2, added: 10, removed: '3', tests: 'passed', review: 'pass' }), { files: 2, added: 10, removed: 0, tests: 'passed', review: 'pass' });
	const [task] = cleanCloud([{ id: 'abc-1', task: 'Fix it', status: 'completed', prUrl: 'https://github.com/o/r/pull/1', runUrl: 'file:///C:/evil' }, { id: '../x', task: 'bad id' }]);
	assert.deepStrictEqual([task.id, task.prUrl, task.runUrl, cleanCloud([{ id: '../x' }]).length], ['abc-1', 'https://github.com/o/r/pull/1', null, 0], 'only GitHub links are kept, ids are plain');
	assert.ok(!idleRetirable(false, false, false, false, false, false, true), 'a running cloud task keeps its project');
});

test('window state keeps the notch settings', () => {
	const { ShellState } = require('../app/state');
	const dir = tmp();
	try {
		const state = new ShellState({ notch: { on: false } });
		state.save(dir);
		assert.deepStrictEqual(ShellState.load(dir).notch, { on: false });
		assert.strictEqual(new ShellState({ notch: 'on' }).notch, null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('device ID is stable per installation and never replaces an unreadable ID', () => {
	const { deviceId } = require('../app/device-id');
	const a = tmp(), b = tmp();
	try {
		const id = deviceId(a);
		assert.match(id, /^[0-9a-f-]{36}$/);
		assert.strictEqual(deviceId(a), id);
		assert.notStrictEqual(deviceId(b), id);
		fs.writeFileSync(path.join(a, 'device-id'), 'damaged');
		assert.throws(() => deviceId(a), /invalid/);
		assert.strictEqual(fs.readFileSync(path.join(a, 'device-id'), 'utf8'), 'damaged');
	} finally {
		fs.rmSync(a, { recursive: true, force: true });
		fs.rmSync(b, { recursive: true, force: true });
	}
});

/** A stand-in for Electron safeStorage: reversible, and recognisably not plain text. */
const safe = (available = true) => ({
	isEncryptionAvailable: () => available,
	encryptString: (s) => Buffer.from('sealed:' + Buffer.from(s).toString('hex')),
	decryptString: (b) => {
		const t = b.toString();
		if (!t.startsWith('sealed:')) throw new Error('not sealed');
		return Buffer.from(t.slice(7), 'hex').toString();
	}
});

test('engine key: sealed by the OS store, stable across runs, never replaced while credentials need it', () => {
	const { engineKey } = require('../app/keychain');
	const dir = tmp();
	const k = engineKey(dir, safe());
	assert.strictEqual(Buffer.from(k, 'base64').length, 32);
	assert.ok(fs.existsSync(path.join(dir, '.engine-key.safe')) && !fs.existsSync(path.join(dir, '.engine-key')), 'OS-protected file only');
	assert.ok(!fs.readFileSync(path.join(dir, '.engine-key.safe'), 'utf8').includes(k), 'the key is not stored in plain text');
	assert.strictEqual(engineKey(dir, safe()), k, 'same key next run');
	assert.throws(() => engineKey(dir, safe(false)), /key store could not be opened/, 'a locked store never mints a new key');

	const plain = tmp();
	const p = engineKey(plain, null);
	assert.strictEqual(fs.readFileSync(path.join(plain, '.engine-key'), 'utf8'), p, 'without an OS store: an owner-only file');
	assert.strictEqual(engineKey(plain, safe()), p, 'a plain key stays authoritative once chosen');

	const lost = tmp();
	fs.writeFileSync(path.join(lost, 'secrets.v2.json'), JSON.stringify({ a: 'x' }));
	assert.throws(() => engineKey(lost, safe()), /missing/, 'credentials without their key are not silently orphaned');
	fs.writeFileSync(path.join(lost, 'secrets.v2.json'), '{}');
	assert.ok(engineKey(lost, safe()), 'an empty credential file is fine');

	const damaged = tmp();
	fs.writeFileSync(path.join(damaged, '.engine-key'), 'damaged');
	assert.throws(() => engineKey(damaged, safe()), /invalid/);
	assert.strictEqual(fs.readFileSync(path.join(damaged, '.engine-key'), 'utf8'), 'damaged', 'a damaged key is preserved');

	const flaky = tmp();
	const broken = { ...safe(), decryptString: () => 'something else' };
	const f = engineKey(flaky, broken);
	assert.ok(fs.existsSync(path.join(flaky, '.engine-key')) && !fs.existsSync(path.join(flaky, '.engine-key.safe')), 'a store that cannot read back falls back to the file');
	assert.strictEqual(engineKey(flaky, broken), f);
});

test('window state: recent folders newest first, atomic save, defaults when missing or damaged', () => {
	const { ShellState } = require('../app/state');
	const dir = tmp();
	const st = ShellState.load(dir);
	assert.strictEqual(st.notify_on_done, true);
	for (const f of ['a', 'b', 'a']) st.setFolder(f);
	assert.deepStrictEqual(st.recent, ['a', 'b']);
	st.width = 900;
	st.save(dir);
	assert.ok(!fs.existsSync(path.join(dir, 'window.json.tmp')));
	const back = ShellState.load(dir);
	assert.strictEqual(back.folder, 'a');
	assert.strictEqual(back.width, 900);
	fs.writeFileSync(path.join(dir, 'window.json'), '{broken');
	assert.strictEqual(ShellState.load(dir).folder, null);
	for (let i = 0; i < 20; i++) st.setFolder('f' + i);
	assert.strictEqual(st.recent.length, 12);
});

test('Liquid Glass: one app-wide file, newer copies win, oversized settings refused, compositor detection', () => {
	const dir = tmp();
	process.env.ZER0NE_DATA_DIR = dir;
	delete require.cache[require.resolve('../app/paths')];
	delete require.cache[require.resolve('../app/glass')];
	const glass = require('../app/glass');
	assert.strictEqual(glass.savedPrefs(), null);
	assert.deepStrictEqual(glass.savePrefs({ transparency: 40, at: 10 }), { saved: true, text: '{"transparency":40,"at":10}' });
	assert.deepStrictEqual(glass.savePrefs({ transparency: 5, at: 5 }).newer, { transparency: 40, at: 10 }, 'an older page gets the newer copy back');
	assert.strictEqual(glass.savedPrefs().transparency, 40);
	assert.strictEqual(glass.savePrefs({ pad: 'x'.repeat(5000) }).saved, false);
	assert.strictEqual(glass.savePrefs([1, 2]).saved, false);
	assert.ok(glass.linuxComposited({ WAYLAND_DISPLAY: 'wayland-0' }, () => false));
	assert.ok(glass.linuxComposited({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, () => false));
	assert.ok(!glass.linuxComposited({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'i3' }, () => false), 'no compositor: stay solid');
	assert.ok(glass.linuxComposited({ XDG_CURRENT_DESKTOP: 'i3' }, (names) => names.includes('picom')));
	delete process.env.ZER0NE_DATA_DIR;
});

test('routing: loopback pages are applets, file names stay one argument, partitions are per project', () => {
	const ops = require('../app/ops');
	for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'app.localhost']) assert.ok(ops.isLoopbackHost(h), h);
	for (const h of ['example.com', '127.0.0.1.example.com', 'localhost.evil.com']) assert.ok(!ops.isLoopbackHost(h), h);
	const file = String.raw`C:\project\%APPDATA% $(touch test) \`test\` & name.rs`;
	assert.deepStrictEqual(ops.editorArgs(file, 9), ['--goto', file + ':9']);
	assert.deepStrictEqual(ops.editorArgs(file, 0), [file]);
	assert.strictEqual(ops.stableKey('C:\\Work\\A'), ops.stableKey(process.platform === 'win32' ? 'c:\\work\\a' : 'C:\\Work\\A'));
	assert.notStrictEqual(ops.stableKey('/a'), ops.stableKey('/b'));
	assert.match(ops.stableKey('x'), /^[0-9a-f]{16}$/);
});

test('engines: folder keys survive other spellings; nothing needed is retired', () => {
	const { folderKey, idleRetirable } = require('../app/engines');
	const dir = tmp();
	assert.strictEqual(folderKey(dir), folderKey(path.join(dir, '.')));
	if (process.platform === 'win32') assert.strictEqual(folderKey(dir.toUpperCase()), folderKey(dir));
	assert.strictEqual(folderKey(null), '');
	for (const args of [[true, false, false, false, false], [false, true, false, false, false], [false, false, true, false, false], [false, false, false, true, false], [false, false, false, false, true]]) {
		assert.ok(!idleRetirable(...args), JSON.stringify(args));
	}
	assert.ok(idleRetirable(false, false, false, false, false));
	assert.ok(!idleRetirable(false, false, false, false, false, true));
});

test('engines: the idle sweep waits for quiet, and never takes a shown, busy or attached engine', () => {
	const { retirableNow } = require('../app/engines');
	const now = 10_000_000;
	const engine = (over = {}) => ({ busy: false, remote: false, terminal: false, router: false, lastTouch: now - 11 * 60_000, ...over });
	// Quiet and unneeded for longer than the wait: taken.
	assert.ok(retirableNow(engine(), false, false, now));
	// Used moments ago: kept, even though nothing needs it right now.
	assert.ok(!retirableNow(engine({ lastTouch: now - 60_000 }), false, false, now));
	// Anything an event-driven retirement also respects: kept however long it sat.
	for (const over of [{ busy: true }, { remote: true }, { terminal: true }, { router: true }]) {
		assert.ok(!retirableNow(engine(over), false, false, now), JSON.stringify(over));
	}
	assert.ok(!retirableNow(engine(), true, false, now));
	assert.ok(!retirableNow(engine(), false, true, now));
	// Short of memory: a quiet engine goes at once, but nothing idleRetirable protects.
	assert.ok(retirableNow(engine({ lastTouch: now - 60_000 }), false, false, now, true));
	for (const over of [{ busy: true }, { remote: true }, { terminal: true }, { router: true }, { cloud: true }]) {
		assert.ok(!retirableNow(engine(over), false, false, now, true), JSON.stringify(over));
	}
	assert.ok(!retirableNow(engine(), true, false, now, true));
});

test('engines: memory pressure follows free RAM and the share it leaves', () => {
	const { memoryPressure } = require('../app/engines');
	const original = process.getSystemMemoryInfo;
	try {
		process.getSystemMemoryInfo = () => ({ total: 16 * 1024 * 1024, free: 8 * 1024 * 1024 });
		assert.strictEqual(memoryPressure(), false);
		process.getSystemMemoryInfo = () => ({ total: 16 * 1024 * 1024, free: 900 * 1024 });
		assert.strictEqual(memoryPressure(), true, 'under 1.5 GB free');
		process.getSystemMemoryInfo = () => ({ total: 16 * 1024 * 1024, free: 1.2 * 1024 * 1024 });
		assert.strictEqual(memoryPressure(), true, 'under 10% free');
		process.getSystemMemoryInfo = () => ({ total: 4 * 1024 * 1024, free: 2 * 1024 * 1024 });
		assert.strictEqual(memoryPressure(), false, 'a small machine with half its RAM free is not pressed');
		process.getSystemMemoryInfo = () => undefined;
		assert.strictEqual(memoryPressure(), false, 'no API means no pressure');
		process.getSystemMemoryInfo = () => { throw new Error('unavailable'); };
		assert.strictEqual(memoryPressure(), false, 'an API failure means no pressure');
	} finally {
		process.getSystemMemoryInfo = original;
	}
});

test('desktop icons helper: compiles, answers, and exits when the app goes away (no icon is touched)', async () => {
	if (process.platform !== 'win32') return;
	const { SCRIPT } = require('../app/desktop-icons');
	const { spawn } = require('child_process');
	const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	let out = '';
	let err = '';
	child.stdout.on('data', (d) => (out += d));
	child.stderr.on('data', (d) => (err += d));
	const until = async (pred, ms) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error('helper: ' + out + err); await new Promise((r) => setTimeout(r, 50)); } };
	await until(() => out.includes('ready'), 30000);
	child.stdin.write('status\n'); // not a command: only reports, never hides or shows
	await until(() => /shown/.test(out), 10000);
	child.stdin.end();
	await new Promise((resolve) => child.once('exit', resolve));
	assert.strictEqual(child.exitCode, 0, err);
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n ' + (e && e.stack ? e.stack : e));
		}
	}
	process.exit(failed ? 1 : 0);
})();
