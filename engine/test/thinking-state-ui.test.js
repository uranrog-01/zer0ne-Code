'use strict';
const assert = require('node:assert/strict');
const ts = require('typescript-classic');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const source = require('./page-scripts').readPage('chat.js');
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const wanted = new Set(['thinkingSteps', 'thinkingBlock', 'rollLabel', 'paintThinking', 'paintThinkingSources', 'paintThinkTime', 'setThinkingOpen', 'fmtDuration', 'fmtThinkLive', 'thinkGlyph', 'startThinkTicker']);
const constants = new Set(['RAYS', 'LOADER_ICON', 'motionOk', 'THINK_SLOW_MS', 'fmtStepMs', 'thinkCount', 'THINK_STATUS_WORD', 'thinkSeq', 'thinkTicker']);
const declarations = [];
function visit(node) {
	if (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text)) declarations.push(node.getText(ast));
	if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => constants.has(d.name.getText(ast)))) declarations.push(node.getText(ast));
	ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, wanted.size + constants.size);
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
	const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
	t.after(() => dom.window.close());
	const w = dom.window;
	let now = 5000, reduced = false;
	w.Date.now = () => now;
	Object.defineProperty(w.performance, 'now', { value: () => now });
	w.matchMedia = () => ({ matches: reduced });
	w.ui = { thinkStartedAt: 1000, thinkSources: new Set() };
	w.t = key => ({ thinking:'Thinking', thoughtFor:'Thought for', finishedThinking:'Finished thinking' })[key] || key;
	w.I = () => '<svg aria-hidden="true"></svg>';
	w.esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	w.h = (tag, cls, html) => { const node = w.document.createElement(tag); node.className = cls || ''; if (html) node.innerHTML = html; return node; };
	w.eval(declarations.join('\n'));
	const card = w.thinkingBlock('state-test', false);
	w.document.body.appendChild(card);
	return { w, card, time: value => now = value, reduced: value => reduced = value };
}

test('Thinking State preserves titled steps with LF, CRLF and CR line endings', t => {
	const { w } = fixture(t);
	const text = '**Reading the files**\n\nFirst paragraph.\n\nSecond paragraph.\n\n**Checking the changes**\nCompare the diff.';
	const expected = [{ title: 'Reading the files', body: 'First paragraph.\n\nSecond paragraph.' }, { title: 'Checking the changes', body: 'Compare the diff.' }];
	for (const ending of ['\n', '\r\n', '\r']) assert.deepEqual(plain(w.thinkingSteps(text.replace(/\n/g, ending))), expected, JSON.stringify(ending));
});

test('live reasoning retains its header, clocks advance, and completion settles the outline', t => {
	const f = fixture(t), { w, card } = f;
	w.paintThinking(card, '**Read files**\n\nRead the source.', true);
	const first = card.querySelector('.tk-item');
	const head = card.querySelector('.tk-head');
	assert.equal(card.querySelector('.tk-clock').textContent, '4s');
	assert.equal(card.querySelectorAll('.tk-item[data-status="active"]').length, 1);
	w.paintThinking(card, '**Read files**\n\nRead the source and tests.', true);
	assert.equal(card.querySelector('.tk-item'), first, 'body updates retain the outline row');
	w.setThinkingOpen(card, true, false);
	assert.equal(card.querySelector('.tk-head').getAttribute('aria-expanded'), 'true');
	f.time(62000); w.paintThinkTime(card);
	assert.equal(card.querySelector('.tk-clock').textContent, '1m 1s');
	const text = '**Read files**\n\nRead the source and tests.\n\n**Check changes**\n\nCompare the diff.';
	w.paintThinking(card, text, true);
	assert.equal(card.querySelector('.tk-head'), head, 'new outline steps retain the disclosure control');
	assert.match(card.querySelector('.tk-text').textContent, /Read the source and tests\./);
	assert.equal(card.querySelectorAll('.tk-item[data-status="active"]').length, 1);
	assert.equal(card.querySelector('.tk-item[data-status="active"] .tk-label').textContent, 'Check changes');
	for (let i = 0; i < 3; i++) w.paintThinking(card, text, false, 61000);
	assert(card.classList.contains('open')); assert(card.classList.contains('done'));
	assert.equal(card.querySelectorAll('.tk-item[data-status="done"]').length, 2);
	assert.equal(card.querySelectorAll('.tk-item[data-status="active"]').length, 0);
	assert.equal(card.querySelectorAll('.tk-item').length, 2);
	assert.equal(card.querySelector('.tk-title').textContent, 'Thought for');
	assert.equal(card.querySelector('.tk-clock').textContent, '1m 1s');
	f.time(100000); w.paintThinkTime(card);
	assert.equal(card.querySelector('.tk-clock').textContent, '1m 1s');
	w.setThinkingOpen(card, false, false);
	assert.equal(card.querySelector('.tk-body').getAttribute('aria-hidden'), 'true');
	assert.equal(card.querySelector('.tk-body').inert, true);
	assert.equal(card.querySelector('.tk-head').getAttribute('aria-expanded'), 'false');
});

test('saved, empty and reduced-motion states remain readable and escape reasoning text', t => {
	const f = fixture(t), { w, card } = f;
	f.reduced(true);
	w.paintThinking(card, '**Inspect**\n\nFirst text.', true);
	w.paintThinking(card, '**Inspect**\n\nFirst text. More text.', true);
	assert.equal(card.querySelectorAll('.aw').length, 0);
	assert.equal(card.querySelector('.tk-text').textContent, 'First text. More text.');
	w.paintThinking(card, '**<img src=x onerror=bad>**\n\n<script>bad()</script>', false, 1500);
	assert.equal(card.querySelector('img, script'), null);
	assert.equal(card.querySelector('.tk-label').textContent, '<img src=x onerror=bad>');
	const saved = w.thinkingBlock('saved-without-duration', false);
	w.paintThinking(saved, 'Saved reasoning without timing metadata.', false);
	assert.equal(saved.querySelector('.tk-clock').textContent, 'a moment');
	const empty = w.thinkingBlock('empty', false);
	w.paintThinking(empty, '', false);
	assert.equal(empty.querySelectorAll('.tk-item').length, 0);
	assert(empty.querySelector('.tk-list').hidden);
	w.paintThinking(card, '**Resumed step**', true);
	assert.equal(card.querySelectorAll('.tk-item[data-status="done"]').length, 0);
	assert.equal(card.querySelectorAll('.tk-item[data-status="active"]').length, 1);
	assert(card.querySelector('.tk-placeholder'));
});
