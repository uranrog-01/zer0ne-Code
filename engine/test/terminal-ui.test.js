// Run the production terminal-specific UI section against a small in-memory DOM.
const assert = require('node:assert/strict');


const vm = require('node:vm');
const test = require('node:test');
const source = require('./page-scripts').readPage('chat.js');
const start = source.indexOf('\t// ---- Terminal tab:');
const end = source.indexOf("\t$('btn-sidebar').addEventListener", start);
assert.ok(start > 0 && end > start);

function setup() {
	let document;
	class Node {
		constructor(tag = 'div') {
			this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.value = '';
			this.className = ''; this._text = ''; this._scrollTop = 0; this.clientHeight = 100;
			this.classList = { contains: (name) => this.className.split(' ').includes(name) };
		}
		get textContent() { return this._text + this.children.map((n) => n.textContent).join(''); }
		set textContent(text) { this._text = text; this.children = []; }
		set innerHTML(html) {
			this.children = [];
			if (html.includes('<pre')) { const pre = new Node('pre'); pre.className = 'term-block'; this.appendChild(pre); }
			else this._text = html.replace(/<[^>]*>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
		}
		get scrollHeight() { return 100 + this.textContent.length; }
		get scrollTop() { return this._scrollTop; }
		set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
		get childElementCount() { return this.children.length; }
		get firstElementChild() { return this.children[0]; }
		appendChild(child) { child.parent = this; this.children.push(child); return child; }
		replaceChildren() { this.children = []; this._text = ''; this._scrollTop = 0; }
		remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
		contains(child) { return child === this || this.children.some((n) => n.contains(child)); }
		querySelector(selector) { return this.children.find((n) => n.className === selector.slice(1)) || null; }
		addEventListener(name, fn) { this.events[name] = fn; }
		focus() { document.activeElement = this; }
	}
	const elements = new Map();
	const $ = (id) => { if (!elements.has(id)) elements.set(id, new Node()); return elements.get(id); };
	document = { createElement: (tag) => new Node(tag), createTextNode: (text) => { const n = new Node('#text'); n.textContent = text; return n; } };
	const posts = [], copies = [];
	let selection = '';
	const context = vm.createContext({
		$, document, el: { auxiliary: new Node() }, activeAuxTab: () => 'terminal',
		window: { getSelection: () => selection }, post: (msg) => posts.push(msg),
		copyText: (text) => copies.push(text), esc: (text) => String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
	});
	vm.runInContext(source.slice(start, end), context);
	const ui = vm.runInContext('termUi', context);
	const key = (name, extra = {}, target = 'term-input') => {
		const e = { key: name, ctrlKey: false, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
		$(target).events.keydown(e); return e;
	};
	const run = (command) => { $('term-input').value = command; key('Enter'); };
	return { $, ui, context, posts, copies, key, run, select: (text) => { selection = text; } };
}

test('Clear during streaming reattaches the next output block and copy uses visible text', () => {
	const { $, context, ui, run, copies } = setup();
	run('echo hi');
	context.termChunk({ id: ui.id, text: 'old' });
	const oldBlock = ui.block;
	$('term-clear').events.click();
	assert.equal(ui.block, null);
	assert.equal($('term-copy').disabled, true);
	context.termChunk({ id: ui.id, text: '<script>new</script>中文😀' });
	assert.notEqual(ui.block, oldBlock);
	assert.ok($('term-out').contains(ui.block));
	assert.equal($('term-out').textContent, '<script>new</script>中文😀');
	$('term-copy').events.click();
	assert.equal(copies[0], '<script>new</script>中文😀');
	assert.equal($('term-copy').disabled, false);
});

test('input remains focusable and Ctrl+C stops once; output selection remains copyable', () => {
	const { $, context, ui, run, posts, key, select } = setup();
	context.termInfo({ shell: 'cmd.exe', cwd: 'C:\\work', running: false });
	assert.equal($('term-shell').textContent, 'cmd.exe');
	run('long command');
	assert.equal($('term-input').readOnly, true);
	assert.notEqual($('term-input').disabled, true);
	assert.equal($('term-status').textContent, 'Running');
	select('selected output');
	assert.equal(key('c', { ctrlKey: true }, 'term-out').prevented, false);
	select('');
	assert.equal(key('c', { ctrlKey: true }).prevented, true);
	assert.equal($('term-status').textContent, 'Stopping…');
	key('c', { ctrlKey: true });
	assert.equal(posts.filter((m) => m.type === 'terminalStop').length, 1);
	key('Enter'); assert.equal(posts.filter((m) => m.type === 'terminalRun').length, 1);
	context.termDone({ id: ui.id - 1, code: 0 }); assert.equal(ui.running, true);
	context.termChunk({ id: ui.id, text: 'last output' });
	context.termDone({ id: ui.id, code: 130, stopped: true });
	assert.equal($('term-status').textContent, 'Stopped');
	assert.equal($('term-input').readOnly, false);
	const count = $('term-out').childElementCount;
	context.termDone({ id: ui.id, code: 130, stopped: true });
	assert.equal($('term-out').childElementCount, count);
});

test('history navigation restores draft, and Escape clears without closing the panel', () => {
	const { $, context, ui, run, key } = setup();
	run('first'); context.termDone({ id: ui.id, code: 0 });
	run('second'); context.termDone({ id: ui.id, code: 0 });
	$('term-input').value = 'unfinished draft';
	key('ArrowDown'); assert.equal($('term-input').value, 'unfinished draft');
	key('ArrowUp'); assert.equal($('term-input').value, 'second');
	key('ArrowUp'); assert.equal($('term-input').value, 'first');
	key('ArrowDown'); key('ArrowDown'); assert.equal($('term-input').value, 'unfinished draft');
	const escapeKey = key('Escape');
	assert.equal(escapeKey.stopped, true); assert.equal($('term-input').value, '');
	assert.equal(ui.hist, -1);
});

test('streaming follows before append, respects scrollback and Jump to latest restores follow', () => {
	const { $, context, ui, run } = setup();
	run('output');
	context.termChunk({ id: ui.id, text: 'a'.repeat(500) });
	const out = $('term-out');
	assert.equal(out.scrollTop, out.scrollHeight - out.clientHeight);
	out.scrollTop = 0;
	context.termChunk({ id: ui.id, text: 'b'.repeat(1000) });
	assert.equal(out.scrollTop, 0);
	assert.equal($('term-latest').hidden, false);
	$('term-latest').events.click();
	assert.equal(out.scrollTop, out.scrollHeight - out.clientHeight);
	assert.equal($('term-latest').hidden, true);
	context.termChunk({ id: ui.id, text: 'c'.repeat(1000) });
	assert.equal(out.scrollTop, out.scrollHeight - out.clientHeight);
	context.termDone({ id: ui.id, code: 0 });
	assert.equal($('term-status').textContent, 'Exit 0');
});

test('clear/cls stays local and shell info preserves stopping identity', () => {
	const { $, context, ui, run, posts } = setup();
	run('clear'); assert.equal(posts.length, 0);
	context.termInfo({ id: 99, cwd: '/work', shell: 'sh', running: true, stopping: true });
	assert.equal(ui.id, 99); assert.equal($('term-status').textContent, 'Stopping…');
	context.termChunk({ id: 98, text: 'stale' }); assert.equal($('term-out').childElementCount, 0);
	context.termChunk({ id: 99, text: 'active' }); assert.equal($('term-out').textContent, 'active');
	context.termDone({ id: 99, code: 0 });
	run('cls'); assert.equal($('term-out').childElementCount, 0);
});
