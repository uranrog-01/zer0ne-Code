'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');

async function main() {
	const events = [], calls = [];
	const shell = {
		showWindows: () => events.push('show'), openWindow: folder => { assert.equal(folder, null); events.push('new-window'); },
		openProjectDialog: () => events.push('open-project'), quick: { show: () => events.push('quick') }, notch: { summon: () => events.push('notch') }
	};
	const fixture = { exports:{} };
	vm.runInNewContext(fs.readFileSync(path.join(root, 'app/tray-menu.js'), 'utf8'), { module:fixture, require: name => {
		if (name === 'electron') return { app:{ quit:() => events.push('quit') }, shell:{ openPath:() => events.push('logs') } };
		if (name === './paths') return { logDir:() => 'fixture-logs' };
		if (name === 'fs') return { mkdirSync:() => {} };
		return require(name);
	} });
	const tray = new fixture.exports.TrayMenu(shell); let visible = true;
	tray.win = { isDestroyed:() => false, isVisible:() => visible, hide:() => { visible = false; events.push('hide'); } };
	const dom = new JSDOM(fs.readFileSync(path.join(root, 'ui/tray.html'), 'utf8'), { runScripts:'outside-only' });
	const w = dom.window, doc = w.document;
	w.__zcShell = { invoke: async (command, args) => {
		calls.push({ command, args });
		if (command === 'tray_data') return { version:'test', theme:'dark', side:'above', running:0, quickKeys:'Ctrl+Alt+Space', notchKeys:'Ctrl+Alt+Z' };
		assert.equal(command, 'tray_action'); tray.run(args.key);
	} };
	w.eval(fs.readFileSync(path.join(root, 'ui/tray.js'), 'utf8')); await Promise.resolve(); await Promise.resolve();
	for (const action of ['show','new-window','open-project','quick','notch','logs','quit']) {
		const button = doc.querySelector('[data-key="zc:' + action + '"]');
		for (const target of [button, button.querySelector('.row-label'), button.querySelector('svg path')]) {
			events.length = 0; calls.length = 0; visible = true;
			target.dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
			assert.deepEqual(events, ['hide', action], action + ': clicking the button or its contents must run exactly once');
			assert.deepEqual(calls.map(call => call.args.key), ['zc:' + action]);
		}
		button.disabled = true; events.length = 0;
		button.querySelector('.row-label').dispatchEvent(new w.MouseEvent('click', { bubbles:true }));
		assert.deepEqual(events, [], 'disabled rows cannot run'); button.disabled = false;
	}
	const rows = [...doc.querySelectorAll('button')]; rows[0].focus();
	doc.dispatchEvent(new w.KeyboardEvent('keydown', { key:'ArrowDown', bubbles:true })); assert.equal(doc.activeElement, rows[1]);
	doc.dispatchEvent(new w.KeyboardEvent('keydown', { key:'End', bubbles:true })); assert.equal(doc.activeElement, rows.at(-1));
	doc.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Home', bubbles:true })); assert.equal(doc.activeElement, rows[0]);
	events.length = 0; visible = true; doc.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Escape', bubbles:true })); assert.deepEqual(events, ['hide']);
	events.length = 0; visible = true; doc.body.dispatchEvent(new w.MouseEvent('mousedown', { bubbles:true })); assert.deepEqual(events, ['hide']);
	events.length = 0; tray.run('zc:unknown'); assert.deepEqual(events, [], 'unrecognised action keys stay blocked');
	dom.window.close();
	console.log('Tray menu: every button and nested label/icon reaches its fixed shell action once; disabled rows, navigation, dismissal and unknown keys passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
