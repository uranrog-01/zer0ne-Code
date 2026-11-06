/*
 * The desktop host extras: the run notifier (a run finishing reports to
 * the shell; a long run reports a heartbeat every few minutes of it).
 * Run: npm test.
 */
'use strict';
const assert = require('assert');
const { createNotifier } = require('../host/host');

// ------------------------------------------------------------------- notifier

const rpcs = [];
const rpc = (op, args) => (rpcs.push({ op, args }), Promise.resolve(null));
const now = { t: 0 };
const notifier = createNotifier(rpc, 50_000, () => now.t); // heartbeat every 50 "seconds"
const state = (isStreaming) => ({ type: 'state', isStreaming });

// Non-state messages are ignored; the first state message is only a baseline.
notifier.observe({ type: 'projects', projects: [] });
notifier.observe(state(false));
notifier.observe(state(true));
assert.strictEqual(rpcs.length, 0, 'a run starting is not a report');

// The run finishing reports "done" with whole minutes (160s rounds to 3 min here).
now.t = 2 * 60_000 + 40_000;
notifier.observe(state(false));
assert.strictEqual(rpcs.length, 1, 'a finished run reports');
assert.strictEqual(rpcs[0].op, 'notify');
assert.strictEqual(rpcs[0].args.kind, 'done');
assert.strictEqual(rpcs[0].args.body, 'The agent run finished (3 min).');

// A short run reports at least 1 min, and the next run needs a fresh start.
notifier.observe(state(true));
now.t += 20_000;
notifier.observe(state(false));
assert.strictEqual(rpcs.length, 2, 'the second run reports too');
assert.strictEqual(rpcs[1].args.body, 'The agent run finished (1 min).');

// A long run: no heartbeat before it is due (49s < 50), one when due (50s), none extra.
rpcs.length = 0;
notifier.observe(state(true));
now.t += 49_000;
notifier.observe(state(true));
assert.strictEqual(rpcs.length, 0, 'no heartbeat before it is due');
now.t += 3_000;
notifier.observe(state(true));
assert.strictEqual(rpcs.length, 1, 'the heartbeat reports when due');
assert.strictEqual(rpcs[0].args.kind, 'beat');
assert.ok(/still working/.test(rpcs[0].args.body), 'the heartbeat says what it is');
assert.ok(/1 min|52 min/.test(rpcs[0].args.body), 'the heartbeat carries the elapsed minutes');
now.t += 20_000;
notifier.observe(state(true));
assert.strictEqual(rpcs.length, 1, 'the next heartbeat waits its full interval');

// Native reveal must remain behind an authenticated, generation-scoped ack.
const fs = require('fs');
const path = require('path');
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const engines = source('app/engines.js');
const shellMain = source('app/main.js');
const transport = source('host/main.js');
const httpReady = engines.slice(engines.indexOf('	onReady(r, msg) {'), engines.indexOf('	/** Create this engine'));
assert.ok(httpReady.includes('this.prepareView(r, p.activationId)'), 'HTTP ready only prepares the background page');
assert.ok(!/pageReady\(|revealStart\(|setVisible\(true\)/.test(httpReady), 'HTTP readiness never reveals a page');
const spawnView = engines.slice(engines.indexOf('	spawnEngineView(r, activationId) {'), engines.indexOf('	/** Wake a retained page'));
assert.ok(spawnView.indexOf('r.bootActivation = activationId') < spawnView.indexOf('loadURL'), 'cold pages receive their activation token before the desktop layer runs');
assert.ok(spawnView.includes('setBounds(this.offscreen())'), 'a new page is prepared offscreen, never over the current one');
const ready = engines.slice(engines.indexOf('	pageReady(contents, activationId) {'), engines.indexOf('	/** Boot values'));
assert.ok(ready.includes('p.viewId !== contents.id || p.activationId !== activationId'), 'ack validates the pending page and generation');
assert.ok(ready.includes('r.view.webContents.id !== contents.id'), 'ack comes from the engine page that was prepared');
assert.ok(shellMain.includes("w.pageReady(sender, String(args.activationId || ''))"), 'ack identity comes from the invoking page, never from page data');
assert.ok(shellMain.includes('event.senderFrame !== sender.mainFrame'), 'frames inside a page never reach the shell');
assert.ok(transport.includes("host.activate(msg.handoff || null, typeof msg.activationId === 'string' ? msg.activationId : undefined)"), 'stdio forwards the activation token without synthesizing a reveal');
const { allowed } = require('../app/permissions');
for (const command of ['zc_page_ready', 'host_status', 'notify_feed', 'notify_read']) assert.ok(allowed('engine', command), 'engine pages keep ' + command);
for (const command of ['restart_engine', 'choose_folder', 'open_logs']) assert.ok(!allowed('engine', command), 'engine pages cannot ' + command);
for (const command of ['restart_engine', 'choose_folder', 'open_logs', 'host_status', 'notify_feed', 'notify_read']) assert.ok(allowed('start', command), 'the start page keeps ' + command);
assert.ok(!allowed('start', 'zc_page_ready') && !allowed('start', 'glass_prefs'), 'the start page has no engine-page commands');
for (const command of ['quick_target', 'quick_send', 'quick_close']) assert.ok(allowed('quick', command) && !allowed('engine', command) && !allowed('start', command), 'only the Quick window may ' + command);
for (const command of ['restart_engine', 'choose_folder', 'pick_project_folder', 'glass_prefs', 'show_help']) assert.ok(!allowed('quick', command), 'the Quick window cannot ' + command);

console.log('desktop-features tests passed');

for (const outcome of ['stopped', undefined, 'completed', 'failed']) {
	const calls = [], rpc = (op, args) => { calls.push({ op, args }); return Promise.resolve(); };
	const { createBusyReporter } = require('../host/host');
	const notify = createNotifier(rpc), busy = createBusyReporter(rpc);
	const messages = [{ role: 'user', content: 'Inspect files', turn: { outcome } }, { role: 'assistant', content: '_Stopped._' }];
	const observe = m => { notify.observe(m); busy.observe(m); };
	observe({ type: 'state', currentSessionId: 'a', isStreaming: false, messages: [] });
	observe({ type: 'state', currentSessionId: 'a', runningSessionId: 'a', isStreaming: true, messages });
	observe({ type: 'state', currentSessionId: 'a', isStreaming: false, messages });
	const finished = ['completed', 'failed'].includes(outcome);
	assert.equal(calls.some(call => call.op === 'notify' && call.args.kind === 'done'), finished);
	assert.equal(!!calls.filter(call => call.op === 'busy').at(-1).args.summary, finished);
	// Finishing in the background must use that run's outcome, not the visible chat's old reply.
	observe({ type: 'state', currentSessionId: 'b', runningSessionId: 'a', isStreaming: true, messages });
	observe({ type: 'state', currentSessionId: 'b', isStreaming: false, messages: [{ role: 'user', content: 'Other', turn: { outcome: 'completed' } }], sessions: [{ id: 'a', outcome }] });
	assert.equal(calls.filter(call => call.op === 'notify' && call.args.kind === 'done').length, finished ? 2 : 0);
	assert.equal(!!calls.filter(call => call.op === 'busy').at(-1).args.summary, finished);
}
console.log('Stopped and interrupted foreground/background runs never announce completion.');
