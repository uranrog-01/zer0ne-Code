'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { desktopPreferences } = require('../host/host');
const source = fs.readFileSync(path.join(__dirname, '../app/desktop-ui.js'), 'utf8');
const bootstrap = source.slice(source.indexOf('\tlet desktopInitialized'), source.indexOf('\tconst svg ='));

function setup() {
	const listeners = {}, documentListeners = {}, classes = new Set();
	const calls = [], posted = [], frames = [], timers = [];
	const window = {
		addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
		__zcShell: { invoke: (op, args) => { calls.push({ op, ...args }); return Promise.resolve(true); } }
	};
	const document = {
		body: { classList: { contains: name => classes.has(name), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } },
		hidden: false,
		addEventListener: (type, fn) => (documentListeners[type] ||= []).push(fn)
	};
	const context = vm.createContext({ window, document,
		post: m => posted.push(JSON.parse(JSON.stringify(m))),
		requestAnimationFrame: fn => frames.push(fn),
		setTimeout: fn => { const timer = { fn, cancelled: false }; timers.push(timer); return timer; },
		clearTimeout: timer => { if (timer) timer.cancelled = true; }
	});
	vm.runInContext(bootstrap + '\nthis.initialize = preferencesReady;', context);
	return { window, document, calls, posted, frames, timers, classes, initialize: context.initialize,
		emit: (data, source) => listeners.message.forEach(fn => fn({ data, source })),
		toggle: () => listeners['zc-notify-toggle'].forEach(fn => fn()),
		show: () => documentListeners.visibilitychange.forEach(fn => fn()) };
}

async function run() {
	const suspended = setup();
	suspended.initialize();
	suspended.emit({ type: 'state', settings: {} });
	suspended.emit({ type: 'zcDesktopPrefs', prefs: {} });
	suspended.emit({ type: 'zcDesktopActivated', activationId: 'offscreen' });
	await Promise.resolve();
	assert.deepStrictEqual(suspended.calls, [{ op: 'zc_page_ready', activationId: 'offscreen' }], 'a page acknowledges readiness even when frames and timers are suspended');
	const embedded = setup();
	embedded.initialize();
	for (const data of [{ type: 'state', settings: {} }, { type: 'zcDesktopPrefs', prefs: { notify: false } }, { type: 'zcDesktopActivated', activationId: 'forged' }]) embedded.emit(data, {});
	assert.equal(embedded.timers.length, 0, 'embedded apps cannot acknowledge desktop activation');
	assert(!embedded.classes.has('zc-notify-off'), 'embedded apps cannot change desktop preferences');
	const h = setup();
	h.emit({ type: 'state', settings: { theme: 'dark' } });
	h.emit({ type: 'zcDesktopPrefs', prefs: { notify: false } });
	h.emit({ type: 'zcDesktopActivated', activationId: 'cold' });
	assert.strictEqual(h.timers.length, 0, 'early engine messages cannot reveal an uninitialized page');
	h.initialize();
	assert(h.classes.has('zc-notify-off'));
	h.timers[0].fn();
	assert.deepStrictEqual(h.calls, [{ op: 'zc_page_ready', activationId: 'cold' }], 'offscreen timer acknowledges readiness');
	h.frames[0](); h.timers[0].fn();
	h.emit({ type: 'zcDesktopActivated', activationId: 'cold' });
	assert.strictEqual(h.calls.length, 1, 'late frames and duplicate activation do not repeat the ack');
	h.toggle();
	assert(!h.classes.has('zc-notify-off'));
	assert.deepStrictEqual(h.posted.at(-1), { type: 'zcDesktopPrefs', prefs: { notify: true } });
	h.show();
	assert.deepStrictEqual(h.posted.at(-1), { type: 'zcDesktopPrefs' }, 'retained pages refresh preferences on reveal');

	const race = setup();
	race.initialize();
	race.emit({ type: 'state', settings: {} });
	assert.strictEqual(race.frames.length, 0);
	race.emit({ type: 'zcDesktopPrefs', prefs: {} });
	assert.strictEqual(race.frames.length, 0, 'preferences alone cannot bypass activation');
	race.emit({ type: 'zcDesktopActivated', activationId: 'old' });
	race.emit({ type: 'zcDesktopActivated', activationId: 'latest' });
	race.timers[0].fn();
	assert.strictEqual(race.calls.length, 0, 'a stale generation never acknowledges');
	race.frames[1]();
	assert.deepStrictEqual(race.calls, [{ op: 'zc_page_ready', activationId: 'latest' }]);
	assert(race.timers[1].cancelled, 'a painted frame cancels the fallback timer');

	const retry = setup();
	let accepted = false, attempts = 0;
	retry.window.__zcShell.invoke = () => { attempts++; return Promise.resolve(accepted); };
	retry.initialize();
	retry.emit({ type: 'state', settings: {} });
	retry.emit({ type: 'zcDesktopPrefs', prefs: {} });
	retry.emit({ type: 'zcDesktopActivated', activationId: 'retry' });
	for (let i = 0; i < 4; i++) {
		retry.frames[i]();
		await Promise.resolve();
		const timer = retry.timers.find(t => !t.cancelled);
		if (i < 3) { timer.cancelled = true; timer.fn(); }
	}
	assert.strictEqual(attempts, 4, 'native rejection retries only three times');
	accepted = true;
	retry.emit({ type: 'state', settings: {} });
	retry.frames[4]();
	await Promise.resolve();
	assert.strictEqual(attempts, 5, 'later engine state recovers readiness');

	const data = { 'zer0neDesktop.layout': { spatial: true, size: 85, transparency: 60, notify: false },
		'zer0neDesktop.background': 'C:\\Pictures\\wallpaper.png' };
	const state = { get: (k, fallback) => k in data ? data[k] : fallback,
		update: async (k, v) => { if (v === undefined) delete data[k]; else data[k] = v; } };
	const prefs = desktopPreferences({ globalState: state });
	const replies = [];
	await prefs.handle({ type: 'zcDesktopPrefs' }, m => replies.push(m));
	assert.deepStrictEqual(replies[0].prefs, { notify: false }, 'migration preserves muted notifications');
	assert(!('zer0neDesktop.layout' in data), 'removed layout preferences are discarded');
	assert(!('zer0neDesktop.background' in data), 'removed wallpaper preferences are discarded');
	await prefs.handle({ type: 'zcDesktopPrefs', prefs: { spatial: true, transparency: 99, notify: true } }, () => {});
	assert.deepStrictEqual(data['zer0neDesktop.preferences'], { notify: true }, 'old pages cannot restore removed controls');
	const panel = { scroll: 280, folds: { 'C:\\project': false, 'C:\\other': true } };
	await prefs.handle({ type: 'zcDesktopPrefs', prefs: { panel } }, () => {});
	await prefs.handle({ type: 'zcDesktopPrefs', prefs: { notify: false } }, () => {});
	assert.deepStrictEqual(prefs.read(), { notify: false, panel }, 'notification changes preserve shared panel position');
	await prefs.handle({ type:'zcDesktopPrefs', prefs:{ widths:{ sidebar:410, auxiliary:460 } } }, () => {});
	await prefs.handle({ type:'zcDesktopPrefs', prefs:{ notify:true } }, () => {});
	assert.deepStrictEqual(prefs.read().widths, { sidebar:410, auxiliary:460 }, 'panel sizes survive unrelated preference writes');
	await prefs.handle({ type:'zcDesktopPrefs', prefs:{ widths:{ sidebar:Infinity, auxiliary:9999 } } }, () => {});
	assert.deepStrictEqual(prefs.read().widths, { sidebar:0, auxiliary:620 }, 'stored widths reject non-finite values and constrain oversized panels');
	let pendingWrites = 0, maximumWrites = 0;
	const concurrentData = {};
	const ordered = desktopPreferences({ globalState:{
		get:(key, fallback) => concurrentData[key] || fallback,
		update:async (key, value) => {
			maximumWrites = Math.max(maximumWrites, ++pendingWrites);
			await new Promise(resolve => setTimeout(resolve, value.widths?.sidebar === 310 ? 25 : 1));
			concurrentData[key] = value; pendingWrites--;
		}
	} });
	await Promise.all([
		ordered.handle({type:'zcDesktopPrefs',prefs:{widths:{sidebar:310,auxiliary:390}}}, () => {}),
		ordered.handle({type:'zcDesktopPrefs',prefs:{notify:false}}, () => {}),
		ordered.handle({type:'zcDesktopPrefs',prefs:{widths:{sidebar:420,auxiliary:450}}}, () => {})
	]);
	assert.equal(maximumWrites, 1, 'rapid preference writes are serialized');
	assert.deepStrictEqual(ordered.read(), {notify:false,widths:{sidebar:420,auxiliary:450}}, 'latest resize and unrelated settings both survive delayed writes');

	const { desktopProjects } = require('../host/host');
	data['aiChat.projects'] = ['C:/alpha', 'C:/beta'];
	const projects = desktopProjects({ globalState: state }, value => value.toLowerCase());
	const alpha = { id: 'c:/alpha', path: 'C:/alpha', current: false };
	const beta = { id: 'c:/beta', path: 'C:/beta', current: true };
	assert.deepStrictEqual(projects.filter({ type: 'projects', projects: [beta, alpha] }).projects.map(p => p.id), ['c:/alpha', 'c:/beta']);
	alpha.current = true; beta.current = false;
	assert.deepStrictEqual(projects.filter({ type: 'projects', projects: [alpha, beta] }).projects.map(p => p.id), ['c:/alpha', 'c:/beta'], 'switching current folder keeps project order');

	const status = { textContent: '' }, attrs = {};
	const button = { setAttribute: (key, value) => attrs[key] = value, querySelector: () => status };
	const bell = { querySelector: () => ({ innerHTML: '' }) };
	const paintStart = source.indexOf('\t\tconst paintBell = () =>');
	const paintEnd = source.indexOf('\t\tconst renderList =', paintStart);
	const paintContext = vm.createContext({ document: h.document, bell, panel: { querySelector: selector => selector === '.zc-nmute' ? button : null }, ICON: { bell: '', bellOff: '' } });
	vm.runInContext(source.slice(paintStart, paintEnd) + '\nthis.paint = paintBell;', paintContext);
	h.emit({ type: 'zcDesktopPrefs', prefs: { notify: false } });
	paintContext.paint();
	assert.strictEqual(attrs['aria-checked'], 'false');
	assert.strictEqual(status.textContent, 'Off');
	h.toggle();
	paintContext.paint();
	assert.strictEqual(attrs['aria-checked'], 'true');
	assert.strictEqual(status.textContent, 'On', 'popup switch follows the persisted notification state');
	console.log('Desktop readiness, notification preferences and migration passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
