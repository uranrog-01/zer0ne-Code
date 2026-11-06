'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EngineWindow } = require('../app/engines');

function fixture() {
	const host = Object.create(EngineWindow.prototype), calls = [];
	let minimized = true, visible = false, destroyed = false;
	host.win = {
		isDestroyed: () => destroyed, isMinimized: () => minimized, isVisible: () => visible,
		restore() { calls.push('restore'); minimized = false; host.reveal(); },
		show() { calls.push('show'); visible = true; }, showInactive() { calls.push('showInactive'); visible = true; },
		focus() { calls.push('windowFocus'); }
	};
	host.layout = () => calls.push('layout');
	host.startView = { webContents: { isDestroyed: () => false, focus: () => calls.push('pageFocus') } };
	host.shell = { syncIcons: () => calls.push('icons') };
	return { host, calls, destroy: () => { destroyed = true; } };
}

(async () => {
	let { host, calls } = fixture();
	host.reveal();
	assert.deepEqual(calls, ['restore', 'show', 'layout', 'windowFocus', 'pageFocus', 'icons']);
	assert.equal(host.revealing, false, 'nested native restore events must not recurse');
	({ host, calls } = fixture()); host.reveal(false);
	assert.deepEqual(calls, ['restore', 'showInactive', 'layout', 'icons'], 'other windows do not take keyboard focus');
	({ host, calls } = fixture()); host.active = { view: null }; host.reveal();
	assert(!calls.includes('pageFocus'), 'a page that crashed or retired cannot prevent the native window from opening');
	({ host, calls } = fixture()); host.active = { view: { webContents: { isDestroyed: () => true } } }; host.reveal();
	assert(!calls.includes('pageFocus'));
	const closed = fixture(); closed.destroy(); closed.host.reveal(); assert.deepEqual(closed.calls, []);
	({ host, calls } = fixture()); host.requestReveal(); host.requestReveal();
	assert.deepEqual(calls, [], 'let Windows finish handling its taskbar message first');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(calls.filter(c => c === 'show').length, 1, 'one taskbar restore queues one recovery');
	({ host, calls } = fixture()); host.requestReveal(); host.cancelReveal();
	await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, [], 'minimize, hide or close cancels a queued recovery');
	const queued = fixture(); queued.host.requestReveal(); queued.destroy();
	await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(queued.calls, []);

	const text = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
	const body = text.slice(text.indexOf('\tclass Shell {'), text.indexOf('\n\tconst AUMID'));
	const context = vm.createContext({}); vm.runInContext(body + '\nthis.Shell = Shell;', context);
	const { Shell } = context;
	const order = [], a = { reveal: (focus = true) => order.push(['a', focus]) }, b = { reveal: (focus = true) => order.push(['b', focus]) };
	Shell.prototype.showWindows.call({ windows: new Set([a, b]), lastFocused: a, syncIcons() {} });
	assert.deepEqual(order, [['b', false], ['a', true]], 'restore the other windows first so the last focused window stays in front');
	console.log('Window restore passed: native recovery, focus, retained sizes, reentrancy, disposed pages and cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
