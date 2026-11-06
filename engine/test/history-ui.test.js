// Exercise the production renderers with an in-memory DOM, without a browser or network.
const assert = require('node:assert/strict');


const vm = require('node:vm');
const ts = require('typescript-classic');

const source = require('./page-scripts').readPage('chat.js');
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['emptyState', 'renderHistory', 'updateSelectedChats']);
const functions = [];
const visit = (node) => {
	if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(ast));
	ts.forEachChild(node, visit);
};
visit(ast);
assert.equal(functions.length, names.size);

let document;
class Node {
	constructor(tag, cls = '', html = '') {
		this.tag = tag; this.className = cls; this.innerHTML = html;
		this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.scrollTop = 0;
		this.classList = {
			contains: (c) => this.className.split(' ').includes(c),
			toggle: (c, on) => { const values = new Set(this.className.split(' ').filter(Boolean)); on ? values.add(c) : values.delete(c); this.className = [...values].join(' '); }
		};
	}
	setAttribute(k, v) { this.attrs[k] = v; }
	appendChild(n) { n.parent = this; this.children.push(n); return n; }
	replaceChildren(...nodes) { this.children = []; nodes.forEach((n) => this.appendChild(n)); }
	addEventListener(name, fn) { this.events[name] = fn; }
	click() { this.events.click?.({ stopPropagation() {}, currentTarget: this }); }
	focus() { document.activeElement = this; }
	closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector) || null; }
	contains(n) { return n === this || this.children.some((child) => child.contains(n)); }
	querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.classList.contains(selector.slice(1)) ? [child] : []), ...child.querySelectorAll(selector)]); }
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const elements = new Map();
const $ = (id) => { if (!elements.has(id)) elements.set(id, new Node('div')); return elements.get(id); };
document = { activeElement: new Node('body') };
const el = { history: $('history'), historyList: $('history-list'), historySearch: $('history-search'), app: $('app'), input: $('input') };
el.history.appendChild(el.historyList);
const state = {
	providers: [{ enabled: true, models: [{ enabled: true }] }], selection: {}, mode: 'agent', currentSessionId: 'a',
	workspace: { name: 'Project <one>' }, folders: [{ id: 'f1', name: 'Folder & work', color: 'blue' }],
	sessions: [
		{ id: 'a', title: 'Build <new> & ship', updatedAt: Date.now(), count: 3, added: 20, removed: 2, folderId: 'f1', model: 'vendor/alpha' },
		{ id: 'b', title: 'Another task', updatedAt: Date.now() - 86400e3, count: 1, pinned: true, model: 'vendor/beta' },
		{ id: 'c', title: 'Archived task', updatedAt: Date.now() - 2 * 86400e3, count: 2, archived: true },
		{ id: 'd', title: 'New chat', updatedAt: Date.now(), count: 0 }
	]
};
const ui = { historyOpen: true, historyFilter: 'all', historySort: 'newest', historyQuery: '', historySelected: new Set(), collapsedFolders: new Set(['f1']) };
const posts = [];
const context = vm.createContext({
	state, ui, el, document, $, window: {},
	h: (tag, cls, html) => new Node(tag, cls, html),
	esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
	t: (key, vars) => key + (vars ? ':' + Object.values(vars).join(',') : ''),
	I: (key) => '<svg aria-hidden="true">' + key + '</svg>',
	fmtTokens: String, fmtStamp: String, relTime: String,
	selected: () => ({ model: { id: 'vendor/alpha' } }), typewriteChips: () => {},
	post: (m) => posts.push(m), saveUi() {}, rowMenu() {}, folderMenu() {}, B: { getState: () => ({}) }
});
vm.runInContext(functions.join('\n'), context);
const render = () => context.renderHistory();
const ids = () => el.historyList.querySelectorAll('.session-row').map((row) => row.dataset.session);

let welcome = context.emptyState();
assert.match(welcome.innerHTML, /Project &lt;one&gt;/);
assert.match(welcome.innerHTML, /Build &lt;new&gt; &amp; ship/);
assert.match(welcome.innerHTML, /<strong title="3">3<\/strong><span>savedChats/);
assert.match(welcome.innerHTML, /<strong title="6">6<\/strong><span>prompts/);
assert.match(welcome.innerHTML, /<strong title="22">22<\/strong><span>linesChanged/);
assert.ok(!welcome.innerHTML.includes('data-open-session="c"'), 'archived chats stay out of recent work');
assert.ok(!welcome.innerHTML.includes('data-open-session="d"'), 'blank drafts stay out of recent work');
assert.match(welcome.innerHTML, /data-draft=/, 'starting points prepare a prompt');
state.providers = [];
const bare = context.emptyState().innerHTML;
assert.match(bare, /welcome-hero/);
assert.ok(!bare.includes('welcome-steps') && !bare.includes('machine-check'), 'the connect/machine sections are gone from the welcome page');
assert.ok(!bare.includes('sgc') && !bare.includes('letsGetStarted') && !bare.includes('welcome-status'), 'the welcome page has no setup guide or get-started badge');

render();
// There is no archived tab any more: an archived chat stays listed (dimmed, marked) while a
// collapsed folder still hides its own chats.
assert.deepEqual(ids(), ['b', 'd', 'c'], 'collapsed folder hides its chats; archived chats stay listed');
ui.historyQuery = 'Folder & work';
render();
assert.deepEqual(ids(), ['a'], 'folder-name search expands matching folders');
ui.historyQuery = 'alpha';
render();
assert.deepEqual(ids(), ['a'], 'models are searchable');
ui.historyQuery = 'message-only';
ui.chatHits = { query: 'message-only', hits: [{ id: 'a', snippet: '<script>message-only</script>' }] };
render();
assert.deepEqual(ids(), ['a'], 'full-text hits remain searchable');
assert.match(el.historyList.querySelector('.sr-open').innerHTML, /&lt;script&gt;<mark>message-only<\/mark>&lt;\/script&gt;/);
ui.chatHits.query = 'old-query';
render();
assert.deepEqual(ids(), [], 'stale full-text responses do not enter the results');
assert.ok(el.historyList.querySelector('.history-empty'));

ui.historyQuery = ''; ui.collapsedFolders.clear(); ui.historyFilter = 'edited';
render(); assert.deepEqual(ids(), ['a']);
ui.historyFilter = 'pinned'; render(); assert.deepEqual(ids(), ['b']);
ui.historyFilter = 'folder:f1'; render(); assert.deepEqual(ids(), ['a']);
ui.historyFilter = 'unfiled'; ui.historySort = 'title';
render(); assert.deepEqual(ids(), ['b', 'c', 'd']);
ui.historyFilter = 'all'; ui.historySelecting = true;
render();
const first = el.historyList.querySelector('.sr-select'); first.focus(); first.checked = true; first.events.change();
assert.equal(ui.historySelected.size, 1);
assert.ok(document.activeElement.classList.contains('sr-select'), 'checkbox focus survives rendering');
context.updateSelectedChats({ archived: true });
assert.equal(posts.at(-1).type, 'updateSessions');
assert.deepEqual(Array.from(posts.at(-1).ids), ['b']);
assert.equal(ui.historySelected.size, 0);
assert.equal(ui.historySelecting, false);
ui.historyFilter = 'all';
render();
assert.ok(ids().includes('c'), 'archived chats stay in the list');
assert.ok(el.historyList.querySelectorAll('.session-row').find((row) => row.dataset.session === 'c').classList.contains('archived'), 'archived chats are marked');
ui.historyOpen = false; render();
assert.ok(el.history.inert, 'closed drawer is excluded from keyboard navigation');
assert.equal(el.history.attrs['aria-hidden'], 'true');
console.log('Welcome and History UI checks passed (stats, search, filters, selection, escaping, focus).');
