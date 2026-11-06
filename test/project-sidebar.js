'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../app/desktop-ui.js'), 'utf8');
class Node {
	constructor(classes = '') {
		this.classes = new Set(classes.split(' ').filter(Boolean));
		this.classList = { contains: n => this.classes.has(n), toggle: (n, on) => { if (on) this.classes.add(n); else this.classes.delete(n); } };
		this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.textContent = '';
	}
	set className(value) { this.classes = new Set(value.split(' ')); }
	getAttribute(k) { return this.attrs[k] || ''; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	appendChild(n) { if (n.parent) n.remove(); this.children.push(n); n.parent = this; return n; }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
	insertAdjacentElement(_, n) { this.parent.appendChild(n); }
	addEventListener(t, f) { this.events[t] = f; }
	matches(s) {
		const [base, exclude] = s.split(':not(');
		const cls = base.slice(base.indexOf('.') + 1).split('.').filter(Boolean);
		return cls.every(c => this.classes.has(c)) && (!exclude || !this.dataset[exclude.includes('fold') ? 'zcFold' : 'zc']);
	}
	querySelectorAll(s) { return this.children.flatMap(n => [...(n.matches(s) ? [n] : []), ...n.querySelectorAll(s)]); }
	querySelector(s) { return this.querySelectorAll(s)[0] || null; }
	closest(s) { return this.matches(s) ? this : this.parent?.closest(s); }
}
const content = new Node();
const group = content.appendChild(new Node('project-group'));
const row = group.appendChild(new Node('project-row'));
const name = row.appendChild(new Node('project-name'));
name.attrs.title = 'C:\\project'; name.textContent = 'Project';
row.appendChild(new Node('project-badge'));
const chat = group.appendChild(new Node('project-chat'));
chat.dataset.projectChat = 'run-1';
const doc = { createElement: () => new Node(), getElementById: () => content };
const saved = [];
const ctx = vm.createContext({ document: doc, ICON: { chevDown: '' }, action: cls => new Node(cls), restyle() {}, setInterval() {}, clearTimeout() {}, requestAnimationFrame: fn => fn(), post: m => saved.push(JSON.parse(JSON.stringify(m))), window: {} });
const begin = source.indexOf('const projectFolds = new Map();');
const end = source.indexOf('\n\tfunction sidebar()', begin);
vm.runInContext(source.slice(begin, end) + '\nthis.decorate = decorate; this.busyByPath = busyByPath; this.paintBusy = paintBusy; this.restoreProjectPanel = restoreProjectPanel;', ctx);
ctx.decorate(content);
assert.strictEqual(group.open, true, 'current project starts open');
assert.strictEqual(group.querySelector('.zc-project-subtitle'), null, 'project rows have no session count');
assert.strictEqual(name.querySelector('.zc-project-title').textContent, 'Project', 'project title stays separate from metadata for truncation');
assert(group.classes.has('zc-current-project'), 'current project keeps its visual identity');
assert(row.querySelector('.project-badge'), 'the hidden current-project marker remains available to folder controls');
assert.match(source, /#sidebar \.project-badge \{ display:none !important; \}/, 'the current-project dot is hidden');
assert(chat.parent.classes.has('project-chats'), 'chats get an independently animated wrapper');
const before = group.children.length;
ctx.decorate(content);
assert.strictEqual(group.children.length, before, 'decoration is idempotent');
group.open = false;
group.events.toggle();
assert.strictEqual(saved.at(-1).prefs.panel.folds[name.attrs.title], false, 'manual folds are shared with other project pages');
// Engine refresh replaces the entire sidebar; keep the same folder identity.
const replacement = content.appendChild(new Node('project-group'));
const nextRow = replacement.appendChild(new Node('project-row'));
const nextName = nextRow.appendChild(new Node('project-name'));
nextName.attrs.title = name.attrs.title;
nextRow.appendChild(new Node('project-badge'));
ctx.decorate(content);
assert.strictEqual(replacement.open, false, 'manual fold survives an engine rerender');
ctx.busyByPath.set('c:/project', { sessionId: 'run-1' });
ctx.paintBusy(content);
assert(chat.classes.has('zc-working'), 'background running session gets neon');
assert(chat.querySelector('.zc-busy-chip'));
assert(!row.querySelector('.zc-busy-dot'), 'working projects have no dot');
const second = content.appendChild(new Node('project-group'));
const secondRow = second.appendChild(new Node('project-row'));
const secondName = secondRow.appendChild(new Node('project-name'));
secondName.attrs.title = 'C:\\other';
const secondChat = second.appendChild(new Node('project-chat'));
secondChat.dataset.projectChat = 'run-2';
ctx.busyByPath.set('c:/other', { sessionId: 'run-2' });
ctx.paintBusy(content);
assert(chat.classes.has('zc-working') && secondChat.classes.has('zc-working'), 'both projects show their running chats simultaneously');
chat.dataset.activity = 'waiting';
ctx.paintBusy(content);
assert(!chat.classes.has('zc-working'), 'waiting for an answer pauses the neon edge');
chat.dataset.activity = 'idle';
assert(!secondRow.querySelector('.zc-busy-dot'));
ctx.busyByPath.clear();
ctx.paintBusy(content);
assert(!chat.classes.has('zc-working'), 'neon stops when the run finishes');
assert(!chat.querySelector('.zc-busy-chip'));
chat.appendChild(new Node('chat-working'));
ctx.paintBusy(content);
assert(chat.classes.has('zc-working'), 'the engine working marker gets neon without shell polling');
assert.doesNotMatch(source, /animation:zc-neon-orbit/, 'working rows use the border comet instead of orbit');
assert.match(fs.readFileSync(path.join(__dirname, '../engine/media/chat.css'), 'utf8'), /#sidebar \.project-chat-glyph zc-orb \{/, 'a running chat shows the particle orb');
assert.doesNotMatch(source, /offset-path:rect/, 'working chats have no continuous border animation');
assert.match(fs.readFileSync(path.join(__dirname, '../engine/media/chat.css'), 'utf8'), /@media \(prefers-reduced-motion: reduce\) \{\s*#sidebar \.project-chat\[data-activity="running"\] \.project-chat-open::before,\s*#sidebar \.project-chat\.zc-working \.project-chat-open::before \{ animation: none; opacity: 0\.4; \}/, 'reduced motion holds the running edge still');
assert.match(fs.readFileSync(path.join(__dirname, '../engine/media/chat.css'), 'utf8'), /animation: easyui-neon-rotate 3s linear infinite;/, 'a running session button carries a light around its edge');
assert.match(source, /#sidebar \.project-panel-views \.project-view:nth-child\(2\)/, 'desktop hides Chats view button');
content.scrollTop = 320;
ctx.decorate(content, 320);
assert.strictEqual(content.scrollTop, 320, 'engine refresh preserves panel scroll after folding');
ctx.restoreProjectPanel({ scroll: 240, folds: { [name.attrs.title]: true } });
ctx.decorate(content, 0);
assert.strictEqual(content.scrollTop, 240, 'destination page restores shared scroll before a stale local position');
assert.strictEqual(group.open, true, 'destination page restores shared folds');
assert.doesNotMatch(source, /\.zc-busy-chip::before/, 'Working chip has no decorative dot');
console.log('project-sidebar tests passed');
