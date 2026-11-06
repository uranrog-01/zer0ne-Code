'use strict';
// The saved-runs dialog had shipped without an entry point; this pins the entry
// point, the run list, the {{variable}} inputs and the replay request.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { readPage } = require('./page-scripts');
const dom = new JSDOM('<body><div id="dialog-root"></div><button id="saved" data-workflow-history>Saved runs</button></body>', { runScripts: 'outside-only' });
const w = dom.window, d = w.document, posts = [];
w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
w.Bridge = { post: msg => posts.push(JSON.parse(JSON.stringify(msg))) };
try {
	w.eval(readPage('workflow-history.js'));
	assert.equal(typeof w.WorkflowHistory?.open, 'function', 'the dialog exposes an entry point');
	d.getElementById('saved').click();
	assert.deepEqual(posts.shift(), { type: 'workflowRuns' }, 'opening asks for the saved runs');
	const dialog = d.querySelector('dialog.workflow-history');
	assert.ok(dialog, 'the saved-runs dialog opens');
	w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'workflowRuns', items: [
		{ id: 'run-1', sessionId: 's1', title: 'Nightly review', status: 'completed', startedAt: 1, prompt: 'Analyze {{path}}', profile: { maxConcurrency: 2 } }
	] } }));
	assert.match(dialog.textContent, /Nightly review/, 'the saved run is listed');
	dialog.querySelector('[data-run]').click();
	const form = dialog.querySelector('form');
	assert.equal(form.classList.contains('hidden'), false, 'choosing a run reveals the replay form');
	const variable = form.querySelector('[data-variable="path"]');
	assert.ok(variable, 'template variables become inputs');
	assert.equal(form.elements.limit.value, '2');
	variable.value = 'src/a.ts';
	form.elements.limit.value = '3';
	form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true }));
	assert.deepEqual(posts.shift(), { type: 'replayWorkflow', id: 'run-1', sessionId: 's1', prompt: 'Analyze src/a.ts', profile: { maxConcurrency: 3 }, resume: false }, 'the new inputs replace the variables');
	assert.equal(dialog.querySelector('[type="submit"]').disabled, true, 'a submitted replay cannot be sent twice');
	w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'workflowReplayFailed', message: 'The original main model is unavailable.' } }));
	assert.match(dialog.querySelector('[data-replay-error]').textContent, /main model is unavailable/, 'a refused replay is reported in the dialog');
	assert.equal(dialog.querySelector('[type="submit"]').disabled, false, 'a refused replay can be retried');
	w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'workflowReplayStarted' } }));
	assert.equal(d.querySelector('dialog.workflow-history'), null, 'a started replay closes the dialog');
	console.log('PASS saved workflow runs: entry point, list, variable inputs, replay request, refusal and close');
} finally {
	w.close();
}
