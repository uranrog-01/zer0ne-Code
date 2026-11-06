// Offline checks of production navigation functions/listeners, not browser layout.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-classic');

const source = require('./page-scripts').readPage('chat.js');
const markup = fs.readFileSync(path.join(__dirname, '../src/webviewMarkup.ts'), 'utf8');
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(), cases = new Map();
function visit(node) {
	if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
	if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) cases.set(node.expression.text, node.getText(ast));
	ts.forEachChild(node, visit);
}
visit(ast);
const panelStatements = functions.get('togglePanel').parent.statements;
const panelStart = panelStatements.findIndex(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(ast) === 'panelData'));
const panelEnd = panelStatements.findIndex(node => ts.isExpressionStatement(node) && node.getText(ast).startsWith("$('btn-folder-new').addEventListener"));
assert.ok(panelStart >= 0 && panelEnd > panelStart, 'production panel data, renderers and listeners found');
const panelsCode = panelStatements.slice(panelStart, panelEnd).map(node => node.getText(ast)).join('\n');
const messageTypes = ['projects', 'worktrees', 'worktreeTaskEntry', 'worktreeRemoved', 'gitTextDiff', 'agentRuns', 'gitStatus', 'terminalInfo', 'state'];
for (const type of messageTypes) assert.ok(cases.has(type), `production ${type} message handler found`);
const messagesCode = `window.addEventListener('message', event => { const msg = event.data || {}; switch (msg.type) { ${messageTypes.map(type => cases.get(type)).join('\n')} } });`;
const decode = text => text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity]);
const dataKey = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function fixture(width = 1200) {
	let document;
	class Element {
		constructor(tag = 'div', id = '', cls = '') {
			this.tag = tag; this.id = id; this.className = cls; this.dataset = {}; this.attrs = {}; this.events = {};
			this.children = []; this.style = {}; this.value = ''; this.checked = false; this.disabled = false;
			this.offsetWidth = 240; this.offsetHeight = 180;
			this.classList = {
				contains: name => this.className.split(/\s+/).includes(name),
				add: name => this.classList.toggle(name, true),
				remove: name => this.classList.toggle(name, false),
				toggle: (name, force) => {
					const on = force === undefined ? !this.classList.contains(name) : !!force;
					this.className = [...this.className.split(/\s+/).filter(c => c && c !== name), ...(on ? [name] : [])].join(' ');
					return on;
				}
			};
		}
		setAttribute(name, value) {
			this.attrs[name] = String(value);
			if (name.startsWith('data-')) this.dataset[dataKey(name.slice(5))] = String(value);
		}
		hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
		// Only materialize actionable controls. Assertions inspect real renderer HTML;
		// this deliberately does not implement an HTML parser or browser rendering.
		set innerHTML(html) {
			this.html = html; this.children = [];
			for (const match of html.matchAll(/<(input)\b([^>]*)>|<(button)\b([^>]*)>([\s\S]*?)<\/button>/g)) {
				const child = new Element(match[1] || match[3]);
				for (const attr of (match[2] || match[4] || '').matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
					const value = decode(attr[2] || ''); child.setAttribute(attr[1], value);
						if (attr[1] === 'class') child.className = value;
						if (attr[1] === 'value') child.value = value;
					if (attr[1] === 'checked' || attr[1] === 'disabled') child[attr[1]] = true;
				}
				child.textContent = decode((match[5] || '').replace(/<[^>]*>/g, ''));
				this.appendChild(child);
			}
		}
		get innerHTML() { return this.html || ''; }
		get childElementCount() { return this.children.length; }
		replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
		set textContent(value) { this.text = value; }
		get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
		appendChild(child) { if (child.parent) child.remove(); child.parent = this; this.children.push(child); return child; }
		insertBefore(child, before) {
			if (child === before) return child;
			if (child.parent) child.remove();
			const index = before ? this.children.indexOf(before) : this.children.length;
			if (index < 0) throw new Error('Reference child is absent');
			this.children.splice(index, 0, child); child.parent = this; return child;
		}
		remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
		matches(selector) {
			return selector.split(',').some(part => {
				const s = part.trim();
				if (s.startsWith('#')) return this.id === s.slice(1);
				if (s.startsWith('.')) return s.slice(1).split('.').every(name => this.classList.contains(name));
				const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(s);
				if (attr) return this.hasAttribute(attr[1]) && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]);
				return this.tag === s;
			});
		}
		closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
		contains(node) { return node === this || this.children.some(child => child.contains(node)); }
		querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
		querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
		addEventListener(name, fn, options) { (this.events[name] ||= []).push({ fn, capture: options === true || !!options?.capture, once: !!options?.once }); }
		fire(name, properties = {}) {
			const event = { target: this, currentTarget: this, defaultPrevented: false, immediateStopped: false,
				preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
				stopImmediatePropagation() { this.immediateStopped = true; }, ...properties };
			for (const listener of [...(this.events[name] || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
				listener.fn(event);
				if (listener.once) this.events[name] = this.events[name].filter(item => item !== listener);
				if (event.immediateStopped) break;
			}
			return event;
		}
		click() { if (!this.disabled) { const event = this.fire('click'); this.onclick?.(event); } }
		focus() { document.activeElement = this; }
		getBoundingClientRect() { return { left: 900, top: 600, bottom: 624 }; }
	}
	const body = new Element('body');
	document = new Element('document'); document.body = body; document.createElement = tag => new Element(tag);
	document.hasFocus = () => true;
	const nodes = new Map();
	function add(id, tag = 'div', cls = '', parent = body) {
		const node = parent.appendChild(new Element(tag, id, cls)); nodes.set(id, node); return node;
	}
	const el = {
		sidebar: add('sidebar', 'aside', 'hidden'), auxiliary: add('auxiliary', 'aside', 'hidden')
	};
	for (const id of ['btn-sidebar', 'btn-sidebar-close', 'btn-auxiliary', 'btn-auxiliary-close', 'btn-project-add', 'btn-project-refresh', 'btn-aux-refresh']) add(id, 'button');
	for (const id of ['btn-sidebar', 'btn-auxiliary']) nodes.get(id).setAttribute('aria-expanded', 'false');
	add('project-search', 'input', '', el.sidebar); add('sidebar-content', 'div', '', el.sidebar);
	// The search box chrome chat.js binds at load (Ctrl+K focus, clear button).
	add('project-search-box', 'div', '', el.sidebar); add('project-search-clear', 'button', 'hidden', el.sidebar); add('ps-kbd-key', 'span', '', el.sidebar);
	const tabs = [];
	add('auxiliary-content', 'div', '', el.auxiliary); // the wrapper the preview layout toggles
	// Use the shipped tab order and initial selection, rather than assuming Files is first.
	for (const match of markup.matchAll(/<button id="(aux-tab-[^"]+)" class="([^"]+)" data-tab="([^"]+)" role="tab" aria-selected="([^"]+)"/g)) {
		const tab = add(match[1], 'button', match[2], el.auxiliary);
		tab.setAttribute('data-tab', match[3]); tab.setAttribute('aria-selected', match[4]); tabs.push(tab);
		add('aux-content-' + match[3], 'div', 'aux-panel' + (match[4] === 'true' ? ' active' : ' hidden'), el.auxiliary);
	}
	assert.deepEqual(tabs.map((t) => t.attrs['data-tab']), ['explorer', 'files', 'subagents', 'worktrees', 'uploads', 'browser', 'terminal'], 'all shipped auxiliary tabs are represented');
	// The terminal panel's inner controls (chat.js binds them at load).
	for (const id of ['term-cwd', 'term-out', 'term-shell', 'term-status']) add(id, 'div', '', nodes.get('aux-content-terminal'));
	for (const id of ['term-clear', 'term-stop', 'term-copy', 'term-latest']) add(id, 'button', '', nodes.get('aux-content-terminal'));
	add('term-input', 'input', '', nodes.get('aux-content-terminal'));
	// Explorer tab chrome bound at load.
	add('aux-explorer-filter', 'input', '', nodes.get('aux-content-explorer'));
	const window = new Element('window'); window.innerWidth = width; window.innerHeight = 800;
	const state = { settings: {}, agentRuns: [], attachments: [], queue: [], currentSessionId: 'chat-current', runningSessionId: 'chat-working' };
	const posts = [], settingsOpened = [], intervals = new Map(); let nextInterval = 0;
	const pushPost = (msg) => posts.push(JSON.parse(JSON.stringify(msg)));
	// Sidebar DOM behavior is exercised by the desktop project's project-panel suite.
	// Here the component boundary keeps routing and the other panel listeners isolated.
	let renderedProjects = [], paletteOpens = 0;
	window.ProjectPanel = { create: options => ({
		render: projects => {
			renderedProjects = JSON.parse(JSON.stringify(projects));
			options.chatMap.clear();
			for (const project of projects) for (const chat of project.chats || []) options.chatMap.set(chat.id, chat);
		},
		openPalette: () => paletteOpens++
	}) };
	const context = vm.createContext({ window, document, state, el, innerWidth: width, $: id => nodes.get(id),
		persisted: {}, Element,
		navigator: { platform: 'Win32', userAgent: 'Windows' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
		ui: { files: [], filesAt: Date.now() }, panelData: { projects: [], worktrees: [], git: null },
		fsUi: { preview: null, files: false, filter: '', open: new Set(), frame: 0 }, fsLayers: () => {}, fsScheduleTree: () => {},
		// VS Code (no desktop class): a file hand-off is a plain openFile post.
		openWorkspaceFile: (p) => pushPost({ type: 'openFile', path: p }),
		t: (k, v) => window.t(k, v), setTimeout: () => 0,
		// Number formatting the panel cards use (top-level in chat.js, outside the extracted section).
		fmtTokens: (n) => (!n ? '0' : n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 === 0 || n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n)),
		fmtCost: (c) => (c === 0 ? '$0' : c < 0.001 ? '<$0.001' : c < 1 ? '$' + c.toFixed(c < 0.01 ? 4 : 3) : '$' + c.toFixed(2)),
		post: pushPost, openSettings: tab => settingsOpened.push(tab),
		setInterval: (fn, delay) => { const id = ++nextInterval; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id),
		gitUi: {}, renderGitTools() {}, renderHistory() {}, B: {}, render() {}, renderMessages() {}, tickStatus() {}, gitTurnStart() {}, gitTurnEnd() {},
		questionUi: { dismissed: new Set(), submitted: new Set(), drafts: new Set() }, closeQuestionPopup() {}, msgImages: new Map(), askedMsgImages: new Set(), auxMaxClose() {} });
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8'), context);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/i18n.js'), 'utf8'), context);
	vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/chat-repository.js'), 'utf8'), context);
	// Stable nodes and focus are exercised with a real DOM in subagent-monitor-ui.test.js.
	vm.runInContext('const esc = window.Markdown.escape, I = () => "<svg/>", basename = (p) => String(p || "").split(/[\\\\/]/).pop(), FILE_KINDS = [];\n' + functions.get('h').getText(ast) + '\n' + functions.get('fileBadge').getText(ast) + '\n' + panelsCode + '\nsagPatch = (target, html) => { target.innerHTML = html; };\n' + messagesCode, context);
	return { context, state, el, nodes, document, tabs, posts, intervals, settingsOpened,
		get renderedProjects() { return renderedProjects; }, get paletteOpens() { return paletteOpens; },
		message: data => window.fire('message', { data }),
		clickIn: (root, control) => { assert.ok(control, 'rendered action exists'); assert.ok(!control.disabled, 'action is enabled'); root.fire('click', { target: control }); }
	};
}
function panelState(f, kind, open) {
	assert.equal(f.el[kind].classList.contains('hidden'), !open, `${kind} visibility`);
	assert.equal(f.nodes.get('btn-' + kind).attrs['aria-expanded'], String(open), `${kind} aria state`);
}
let f;

// Wide screens allow both panels. Close buttons restore focus and stop polling.
f = fixture(1000);
f.nodes.get('btn-sidebar').click(); panelState(f, 'sidebar', true);
assert.ok(f.nodes.get('btn-sidebar').classList.contains('active'));
assert.deepEqual(f.posts, [{ type: 'getProjects' }]);
f.nodes.get('btn-auxiliary').click(); panelState(f, 'sidebar', true); panelState(f, 'auxiliary', true);
assert.ok(f.nodes.get('btn-auxiliary').classList.contains('active'));
assert.deepEqual(f.posts.slice(1), [{ type: 'getGitStatus' }, { type: 'getWorktrees' }, { type: 'getAgentRuns' }]);
assert.equal(f.intervals.size, 1);
const poll = [...f.intervals.values()][0]; assert.equal(poll.delay, 5000);
f.posts.length = 0; poll.fn(); assert.equal(f.posts.length, 3);
f.nodes.get('btn-sidebar-close').click(); panelState(f, 'sidebar', false); panelState(f, 'auxiliary', true);
assert.equal(f.document.activeElement, f.nodes.get('btn-sidebar')); assert.equal(f.intervals.size, 1);
f.nodes.get('btn-auxiliary-close').click(); panelState(f, 'auxiliary', false); assert.equal(f.intervals.size, 0);
assert.equal(f.document.activeElement, f.nodes.get('btn-auxiliary'));
assert.ok(!f.nodes.get('btn-sidebar').classList.contains('active'));
assert.ok(!f.nodes.get('btn-auxiliary').classList.contains('active'));
f.nodes.get('btn-sidebar').click(); f.nodes.get('btn-sidebar').click(); panelState(f, 'sidebar', false);
f.nodes.get('btn-auxiliary').click(); f.nodes.get('btn-auxiliary').click(); panelState(f, 'auxiliary', false);

// At the narrow breakpoint, opening either panel hides the other and updates ARIA.
f = fixture(999);
f.nodes.get('btn-auxiliary').click(); assert.equal(f.intervals.size, 1);
f.nodes.get('btn-sidebar').click(); panelState(f, 'sidebar', true); panelState(f, 'auxiliary', false);
assert.equal(f.intervals.size, 0);
f.nodes.get('btn-auxiliary').click(); panelState(f, 'sidebar', false); panelState(f, 'auxiliary', true);
assert.equal(f.intervals.size, 1);
assert.equal(f.document.fire('keydown', { key: 'Escape' }).defaultPrevented, true);
panelState(f, 'auxiliary', false); assert.equal(f.intervals.size, 0);
assert.equal(f.document.activeElement, f.nodes.get('btn-auxiliary'));
f.nodes.get('btn-sidebar').click(); f.document.fire('keydown', { key: 'Escape' }); panelState(f, 'sidebar', false);
assert.equal(f.document.activeElement, f.nodes.get('btn-sidebar'));
assert.equal(f.document.fire('keydown', { key: 'Escape' }).defaultPrevented, false);
// Closing the panel hides the whole panel: the shipped markup has no floating rail,
// and nothing replaces it when the panel is hidden.
assert.ok(!markup.includes('sidebar-rail'), 'the closed panel leaves no mini menu');
f = fixture(1200);
f.nodes.get('btn-sidebar').click(); panelState(f, 'sidebar', true);
f.nodes.get('btn-sidebar-close').click(); panelState(f, 'sidebar', false);
assert.equal(f.document.body.querySelectorAll('.sidebar-rail').length, 0, 'the closed panel leaves no chrome beside the chat');

// Host-backed project/chat data includes selection, working state and missing folders.
f = fixture();
f.message({ type: 'projects', projects: [
	{ name: '<Alpha & project>', path: '/repo/alpha', current: true, available: true, chats: [{ id: 'chat-current', title: 'Fix <navigation>' }, { id: 'chat-working', title: 'Build tests' }] },
	{ name: 'Unavailable', path: '/repo/missing', available: false, chats: [{ id: 'missing-chat', title: 'Old work' }] },
	{ name: 'Legacy', chats: [{ id: 'legacy-chat', title: 'Imported conversation' }] },
	{ name: 'Empty project', path: '/repo/empty', available: true, chats: [] }
] });
const sidebar = f.nodes.get('sidebar-content');
assert.equal(f.renderedProjects.length, 4, 'project payload reaches the sidebar component');
assert.equal(f.renderedProjects[1].available, false);
sidebar.innerHTML = '<button data-project-chat="chat-current" data-project-path="/repo/alpha"></button><button data-project-chat="legacy-chat"></button><button data-project-open="/repo/alpha"></button><button data-project-new="/repo/alpha"></button>';
f.clickIn(sidebar, sidebar.querySelector('[data-project-chat="chat-current"]'));
f.clickIn(sidebar, sidebar.querySelector('[data-project-chat="legacy-chat"]'));
f.clickIn(sidebar, sidebar.querySelector('[data-project-open="/repo/alpha"]'));
f.clickIn(sidebar, sidebar.querySelector('[data-project-new="/repo/alpha"]'));
f.nodes.get('btn-project-add').click(); f.nodes.get('btn-project-refresh').click();
assert.deepEqual(f.posts, [
	{ type: 'projectOpen', path: '/repo/alpha', sessionId: 'chat-current' }, { type: 'switchSession', id: 'legacy-chat' },
	{ type: 'projectOpen', path: '/repo/alpha' }, { type: 'projectNewChat', path: '/repo/alpha' },
	{ type: 'projectPick' }, { type: 'getProjects' }
]);
const search = f.nodes.get('project-search');
search.value = '  NAVIGATION  '; search.fire('input');
assert.equal(f.renderedProjects[0].chats[0].title, 'Fix <navigation>');
assert.ok(!f.nodes.get('project-search-clear').classList.contains('hidden'));
f.document.fire('keydown', { key: 'k', ctrlKey: true }); assert.equal(f.paletteOpens, 1);
f.message({ type: 'projects' }); assert.deepEqual(f.renderedProjects, []);

// Real worktree, subagent and other work-detail payloads render safe rows and actions.
f = fixture();
f.message({ type: 'worktrees', items: [{ branch: 'feature/<nav>', path: '/repo/nav & tests', current: true }, { path: '/repo/detached' }] });
const worktrees = f.nodes.get('aux-content-worktrees');
assert.match(worktrees.innerHTML, /feature\/&lt;nav&gt;/); assert.match(worktrees.innerHTML, /nav &amp; tests/);
assert.match(worktrees.innerHTML, /This window/);
assert.match(worktrees.innerHTML, /Detached checkout/);
const copyPath = worktrees.querySelector('[data-aux-copy-path]'), copyNotices = [];
f.context.toast = (message, kind) => copyNotices.push({ message, kind });
// biome-ignore lint/suspicious/noThenProperty: Keep clipboard callbacks synchronous in this navigation fixture.
f.context.navigator.clipboard = { writeText: () => ({ then: (_done, failed) => failed() }) };
f.clickIn(f.el.auxiliary, copyPath);
assert.equal(copyNotices[0].kind, 'error');
assert(!copyPath.classList.contains('copied'), 'a rejected clipboard write never reports success');
// biome-ignore lint/suspicious/noThenProperty: Keep clipboard callbacks synchronous in this navigation fixture.
f.context.navigator.clipboard = { writeText: () => ({ then: done => done() }) };
f.clickIn(f.el.auxiliary, copyPath);
assert(copyPath.classList.contains('copied'), 'a successful clipboard write reports success');
f.clickIn(f.el.auxiliary, worktrees.querySelector('[data-aux-worktree]'));
f.clickIn(f.el.auxiliary, worktrees.querySelector('[data-aux-create-worktree]'));
assert.equal(f.posts.filter(p => p.type === 'worktree').length, 0, 'opening task entry never creates a blank worktree');
f.posts.splice(1); // exclude panel refresh requests
const taskEntry = worktrees.querySelector('[data-aux-worktree-task]');
assert.equal(f.document.activeElement, taskEntry);
f.clickIn(f.el.auxiliary, worktrees.querySelector('[data-aux-submit-worktree]'));
assert.equal(f.posts.length, 1, 'blank task is not submitted');
taskEntry.value = 'Fix Work Details';
f.el.auxiliary.fire('input', { target: taskEntry });
f.message({ type: 'worktrees', items: [{ branch: 'feature/<nav>', path: '/repo/nav & tests', current: true }, { path: '/repo/detached' }] });
assert.equal(worktrees.querySelector('[data-aux-worktree-task]').value, 'Fix Work Details', 'polling preserves entered task');
assert.equal(f.document.activeElement, worktrees.querySelector('[data-aux-worktree-task]'), 'polling preserves task-entry focus');
f.clickIn(f.el.auxiliary, worktrees.querySelector('[data-aux-submit-worktree]'));
const removeCheckout = worktrees.querySelector('[data-aux-remove-worktree]');
assert.ok(removeCheckout, 'non-main checkouts offer removal');
f.clickIn(f.el.auxiliary, removeCheckout);
assert.deepEqual(f.posts.at(-1), { type: 'removeWorktree', path: '/repo/nav & tests' });
f.message({ type: 'worktreeRemoved', path: '/repo/nav & tests' });
assert.deepEqual(f.posts.at(-1), { type: 'getWorktrees' });
f.message({ type: 'agentRuns', items: [
	{ id: 'run-1', description: '<Review UI>', status: 'running', kind: 'task' },
	{ id: 'run-2', agentName: 'Completed reviewer', status: 'completed', kind: 'agent' },
	{ id: 'run-3', status: 'failed', kind: 'task' }
] });
const agents = f.nodes.get('aux-content-subagents');
assert.match(agents.innerHTML, /&lt;Review UI&gt;/); assert.match(agents.innerHTML, /Subagents/);
assert.match(agents.innerHTML, /1 running/);
assert.match(agents.innerHTML, /Completed reviewer/); assert.match(agents.innerHTML, /run-3/);
assert.deepEqual([...new Set(agents.querySelectorAll('[data-aux-stop]').map(node => node.dataset.auxStop))], ['run-1'], 'graph and task-list Stop controls target the same running agent');
f.clickIn(f.el.auxiliary, agents.querySelector('[data-aux-stop]'));
f.message({ type: 'gitStatus', branch: 'main', changes: [{ path: 'src/<nav>.js', status: 'M', added: 3, removed: 2 }] });
const files = f.nodes.get('aux-content-files');
assert.match(files.innerHTML, /src\/&lt;nav&gt;\.js/); assert.match(files.innerHTML, /class="gtr-st s-M"[^>]*>M</); assert.match(files.innerHTML, /<span>&lt;nav&gt;\.js<\/span><small>src<\/small>/);
assert.match(files.innerHTML, /class="add">\+3<\/b><b class="del">−2<\/b>/);
f.clickIn(f.el.auxiliary, files.querySelector('[data-aux-file]')); f.clickIn(f.el.auxiliary, files.querySelector('[data-aux-diff]'));
f.state.attachments = [{ id: 'upload-1', name: 'notes.txt', kind: 'file' }];
f.state.queue = [{ text: '<Next step>', plan: true }];
f.context.renderAuxiliary();
assert.match(f.nodes.get('aux-content-uploads').innerHTML, /notes.txt/);
f.clickIn(f.el.auxiliary, f.nodes.get('aux-content-uploads').querySelector('[data-aux-remove]'));
assert.deepEqual(f.posts, [
	{ type: 'openWorktree', path: '/repo/nav & tests' }, { type: 'worktree', action: 'create', task: 'Fix Work Details' },
	{ type: 'removeWorktree', path: '/repo/nav & tests' }, { type: 'getWorktrees' }, { type: 'stopAgent', id: 'run-1' },
	{ type: 'openFile', path: 'src/<nav>.js' }, { type: 'gitOpenDiff', path: 'src/<nav>.js' },
	{ type: 'removeAttachment', id: 'upload-1' }
]);
f.message({ type: 'worktrees', error: '<Git unavailable>' }); assert.match(worktrees.innerHTML, /&lt;Git unavailable&gt;/);
f.message({ type: 'worktrees', items: [{ branch: 'recovered', path: '/repo/recovered' }] });
assert.match(worktrees.innerHTML, /recovered/); assert.ok(!worktrees.innerHTML.includes('Git unavailable'));
f.message({ type: 'agentRuns' }); assert.match(agents.innerHTML, /No workflow running/);
f.message({ type: 'gitStatus', error: '<Not a repository>' }); assert.match(files.innerHTML, /&lt;Not a repository&gt;/);
f.posts.length = 0; f.nodes.get('btn-aux-refresh').click();
assert.deepEqual(f.posts, [{ type: 'getFiles', refresh: true }, { type: 'getGitStatus' }, { type: 'getWorktrees' }, { type: 'getAgentRuns' }]);

// Tabs expose ARIA relationships and roving focus; arrows wrap, Home/End jump.
f = fixture();
function selectedTab(index) {
	for (const [i, tab] of f.tabs.entries()) {
		const active = i === index, panel = f.nodes.get('aux-content-' + tab.dataset.tab);
		assert.equal(tab.attrs['aria-controls'], panel.id); assert.equal(panel.attrs['aria-labelledby'], tab.id);
		assert.equal(tab.attrs['aria-selected'], String(active)); assert.equal(tab.tabIndex, active ? 0 : -1);
		assert.equal(tab.classList.contains('active'), active); assert.equal(panel.classList.contains('active'), active);
		assert.equal(panel.classList.contains('hidden'), !active);
	}
}
selectedTab(f.tabs.findIndex(tab => tab.classList.contains('active')));
f.tabs[0].click(); selectedTab(0);
for (const [from, key, to] of [[0, 'ArrowLeft', 6], [6, 'ArrowRight', 0], [0, 'ArrowRight', 1], [1, 'ArrowLeft', 0], [2, 'End', 6], [6, 'Home', 0]]) {
	f.tabs[from].click();
	assert.equal(f.tabs[from].fire('keydown', { key }).defaultPrevented, true);
	selectedTab(to); assert.equal(f.document.activeElement, f.tabs[to]);
}
const focused = f.document.activeElement;
assert.equal(f.tabs[0].fire('keydown', { key: 'ArrowDown' }).defaultPrevented, false);
selectedTab(0); assert.equal(f.document.activeElement, focused); assert.ok(f.posts.some(p => p.type === 'getFiles' && p.refresh === true), 'Explorer entry refreshes even a populated cache'); assert.deepEqual(f.posts.filter(p => !['terminalInfo', 'getFiles'].includes(p.type)), []);
// Desktop diff stays in-page and treats file contents and errors as text.
f = fixture(); f.document.body.classList.add('desktop');
f.message({ type: 'gitStatus', changes: [{ path: 'unsafe<script>.txt', status: 'M' }] });
const desktopFiles = f.nodes.get('aux-content-files');
f.clickIn(f.el.auxiliary, desktopFiles.querySelector('[data-aux-diff]'));
assert.deepEqual(f.posts, [{ type: 'gitOpenDiff', path: 'unsafe<script>.txt', inPage: true }]);
f.message({ type: 'gitTextDiff', path: 'other', modified: 'stale' });
assert.ok(!desktopFiles.innerHTML.includes('stale'));
f.message({ type: 'gitTextDiff', path: 'unsafe<script>.txt', original: '<script>old</script>', modified: '<img src=x onerror=alert(1)>' });
assert.match(desktopFiles.innerHTML, /&lt;script&gt;old/); assert.match(desktopFiles.innerHTML, /&lt;img src=x/);
assert.ok(!desktopFiles.innerHTML.includes('<script>'));
f.clickIn(f.el.auxiliary, desktopFiles.querySelector('[data-aux-close-diff]'));
assert.ok(!desktopFiles.innerHTML.includes('HEAD ↔'));
f.message({ type: 'worktrees', items: [{ path: '/repo/wt' }] });
assert.match(f.nodes.get('aux-content-worktrees').innerHTML, /Switch project/);

f.nodes.get('btn-auxiliary').click(); f.tabs.find(t => t.dataset.tab === 'terminal').click(); f.posts.length = 0;
f.message({ type: 'state', currentSessionId: 'chat-current' });
assert.deepEqual(f.posts, [{ type: 'terminalInfo' }], 'state on reconnect resynchronizes active terminal');
f.message({ type: 'terminalInfo', id: 71, cwd: '/repo', shell: 'sh', running: true });
assert.equal(f.nodes.get('term-status').textContent, 'Running');
f.message({ type: 'state', currentSessionId: 'chat-current' });
f.message({ type: 'terminalInfo', running: false, cwd: '/repo', shell: 'sh' });
assert.equal(f.nodes.get('term-input').readOnly, false, 'missed terminalDone does not leave terminal locked');
console.log('Navigation UI checks passed (panel ARIA/exclusivity, real data/actions, tab keyboard navigation).');
