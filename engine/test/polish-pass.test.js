'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom'), ts = require('typescript-classic');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function functions(file, names) {
	const source = read(file), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), output = [];
	function visit(node) { if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) output.push(node.getText(ast)); ts.forEachChild(node, visit); }
	visit(ast); assert.equal(output.length, names.length); return output.join('\n');
}
test('Settings search follows real General and Agent controls and stays current after generation', () => {
	const { settingsIndex, sources } = require('../../scripts/settings-index');
	const entries = settingsIndex(sources());
	assert(entries.length >= 60);
	assert.equal(entries.find(entry => entry.key === 'showReasoning').generalPage, 'stream');
	assert.equal(entries.find(entry => entry.key === 'replyLanguage').generalPage, 'language');
	assert.equal(entries.find(entry => entry.key === 'subagents').agentTab, 'subagents');
	assert(entries.some(entry => entry.key === 'toolConcurrency'));
	const dom = new JSDOM('', { runScripts: 'outside-only' }); dom.window.eval(read('engine/media/settings-index.js'));
	assert.deepEqual(JSON.parse(JSON.stringify(dom.window.SettingsIndex)), entries, 'rebuild the settings index when controls change'); dom.window.close();
});
test('Settings search supports keyboard selection, escaping, IME and empty results without executing a setting', () => {
	const dom = new JSDOM('', { runScripts: 'outside-only' }), w = dom.window, chosen = [];
	w.HTMLElement.prototype.scrollIntoView = () => {};
	w.eval(read('engine/media/settings-search.js'));
	const search = w.SettingsFinder.create(() => [{ label: 'Show reasoning', key: 'showReasoning', description: 'Thinking in chat', breadcrumb: 'General › Message stream' }, { label: '<img onerror="bad()">', key: 'unsafe', breadcrumb: 'Appearance' }], entry => chosen.push(entry));
	w.document.body.appendChild(search); const input = search.querySelector('input'), list = search.querySelector('[role="listbox"]');
	input.value = 'thinking'; input.dispatchEvent(new w.Event('input')); assert.equal(list.children.length, 1); assert.equal(chosen.length, 0);
	input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); assert.equal(chosen[0].key, 'showReasoning'); assert(list.hidden);
	input.value = 'unsafe'; input.dispatchEvent(new w.Event('input')); assert.equal(search.querySelector('img'), null);
	input.dispatchEvent(new w.CompositionEvent('compositionstart')); input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true })); assert.equal(chosen.length, 1);
	input.value = 'nothing matches'; input.dispatchEvent(new w.CompositionEvent('compositionend')); assert.match(list.textContent, /No matching settings/);
	input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' })); assert(list.hidden); dom.window.close();
});
test('Search destinations select the correct subpage, focus the actual control row and expose feature results', () => {
	const dom = new JSDOM('<main id="s-page"></main>', { runScripts: 'outside-only' }), w = dom.window;
	w.S = {}; w.$ = id => w.document.getElementById(id); w.matchMedia = () => ({ matches: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
	w.renderPage = () => { w.$('s-page').innerHTML = '<div class="setting-row"><input data-setting="showReasoning"></div>'; };
	w.navigate = section => { w.S.section = section; w.renderPage(); };
	w.eval(functions('engine/media/settings.js', ['openSearchSetting']));
	w.openSearchSetting({ section: 'general', generalPage: 'stream', key: 'showReasoning' });
	assert.equal(w.S.generalPage, 'stream'); assert.equal(w.document.activeElement.dataset.setting, 'showReasoning'); assert(w.document.querySelector('.setting-row.settings-search-hit'));
	w.openSearchSetting({ section: 'features', key: 'projectVerification', label: 'Project verification' }); assert.equal(w.S.featureTab, 'capabilities'); assert.equal(w.S.featureFilter, 'all');
	dom.window.close();
});
test('Expanding one turn does not invalidate unrelated history; nested full output remains independently expandable', () => {
	const dom = new JSDOM('', { runScripts: 'outside-only' }), w = dom.window;
	w.ui = { expanded: new Set() }; w.eval(functions('engine/media/chat.js', ['unitExpansion']));
	const units = Array.from({ length: 300 }, (_, n) => ({ kind: 'worked', id: 'w:' + n, user: { id: String(n) }, steps: [{ id: 'tool:' + n }] }));
	const before = units.map(unit => w.unitExpansion(unit)); w.ui.expanded.add('w:150');
	assert.deepEqual(units.map((unit, n) => w.unitExpansion(unit) !== before[n] ? n : -1).filter(n => n >= 0), [150]);
	w.ui.expanded.add('all:tool:150'); assert.match(w.unitExpansion(units[150]), /all:tool:150/);
	assert.equal(w.unitExpansion({ kind: 'edits', user: { id: 'other' } }), 'false'); dom.window.close();
});
test('Recovery guidance uses relevant destinations and cannot turn error text into an executable action', () => {
	const dom = new JSDOM('', { runScripts: 'outside-only' }), w = dom.window; w.eval(read('engine/media/recovery.js'));
	assert.equal(w.RecoveryUI.guidance('response', '429 rate limit').section, 'usage');
	assert.equal(w.RecoveryUI.guidance('mcp', 'failed').section, 'mcp'); assert.equal(w.RecoveryUI.guidance('command', 'failed').panel, 'terminal');
	w.document.body.innerHTML = w.RecoveryUI.html('tool', '<img onerror=bad()>', 'mcp__service__write');
	assert.equal(w.document.querySelector('img'), null); assert(w.document.querySelector('[data-open-settings="mcp"]')); assert.equal(w.document.querySelector('[data-retry]'), null);
	dom.window.close();
});
