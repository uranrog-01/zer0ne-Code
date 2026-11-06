'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../engine/media/project-panel.js'), 'utf8');

function setup() {
	const dom = new JSDOM('<body class="desktop"><aside id="sidebar"><div class="sidebar-title">Projects</div><div id="project-search-box"><input id="project-search"></div><div id="sidebar-content"></div></aside><textarea id="composer"></textarea></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
	const win = dom.window, doc = win.document;
	doc.hasFocus = () => true;
	win.eval(source);
	const state = { currentSessionId: 'saved', isStreaming: false };
	const posted = [], prefs = [], chats = new Map();
	let desktop = true, projects = [];
	const panel = win.ProjectPanel.create({
		state: () => state, desktop: () => desktop, persist: p => prefs.push(JSON.parse(JSON.stringify(p))),
		icon: () => '<svg></svg>', time: () => 'now', post: m => posted.push(JSON.parse(JSON.stringify(m))), chatMap: chats,
		refresh: () => panel.render(projects), settings: () => posted.push({ action: 'settings' }),
		terminal: () => posted.push({ action: 'terminal' }), sidebar: () => posted.push({ action: 'sidebar' })
	});
	return { win, doc, panel, state, posted, prefs, chats, setDesktop: value => desktop = value,
		render: value => { projects = value; panel.render(value); }, close: () => dom.window.close() };
}
const project = (chats, extra = {}) => ({ id: 'alpha', name: 'Alpha', path: 'C:/alpha', current: true, available: true, chats, ...extra });
const chat = (id, extra = {}) => ({ id, title: id, count: 1, updatedAt: 100, ...extra });
const tests = [];
const test = (name, run) => tests.push([name, run]);

test('project rows keep three controls and route overflow actions without changing folds', () => {
	const h = setup();
	const requests = [];
	h.win.__zcProjectActions = { projectMenu: (project, anchor) => requests.push({ project, anchor }) };
	h.render([project([]), project([], { id: 'missing', path: 'C:/missing', name: 'Missing', available: false })]);
	const group = h.doc.querySelector('[data-panel-key="alpha"]'); group.open = false;
	const more = group.querySelector('.project-folder-more'); more.click();
	assert.equal(requests[0].project.path, 'C:/alpha'); assert.equal(requests[0].anchor, more); assert.equal(group.open, false);
	assert.equal(group.querySelectorAll('.project-tools button').length, 3);
	assert.equal(group.querySelector('.project-show-files, .project-rename, .project-pin'), null);
	assert.equal(more.getAttribute('aria-haspopup'), 'menu');
	assert(!h.doc.querySelector('[data-panel-key="missing"] .project-folder-more').disabled);
	group.querySelector('.zc-delete-project').click();
	assert.deepEqual(h.posted.at(-1), { type: 'projectDelete', path: 'C:/alpha' });
	h.render([project([])]); assert.equal(group.querySelectorAll('.project-tools button').length, 3);
	h.close();
});

test('empty default drafts stay hidden while named and saved chats remain accessible', () => {
	const h = setup();
	const p = project([chat('empty', { count: 0, title: 'New chat' }), chat('saved', { title: 'New chat' }), chat('named', { count: 0, title: 'Named draft' })]);
	h.render([p]);
	assert(!h.doc.querySelector('[data-project-chat="empty"]'));
	assert(h.doc.querySelector('[data-project-chat="saved"]'));
	assert(h.doc.querySelector('[data-project-chat="named"]'));
	assert(h.doc.querySelector('[data-project-new="C:/alpha"]'));
	assert(!h.doc.querySelector('[data-project-open]'));
	h.state.isStreaming = true; h.state.runningSessionId = 'empty'; h.render([p]);
	assert(h.doc.querySelector('[data-project-chat="empty"]'));
	h.state.isStreaming = false; h.win.__zcProjectActivity = new Map([['empty', 'waiting']]); h.render([p]);
	assert.equal(h.doc.querySelector('.project-chat[data-project-chat="empty"]').dataset.activity, 'waiting');
	h.win.__zcProjectActivity.clear(); h.setDesktop(false); h.render([p]);
	assert(h.doc.querySelector('[data-project-chat="empty"]'));
	assert(h.doc.querySelector('[data-project-open]'));
	h.close();
});

test('refresh preserves row identity, focus, project folds, scroll and composer text', () => {
	const h = setup(), first = project([chat('saved'), chat('other')]);
	h.render([first]);
	const row = h.doc.querySelector('.project-chat[data-project-chat="saved"]'), button = row.querySelector('button');
	button.focus(); h.doc.querySelector('details').open = false; h.doc.getElementById('sidebar-content').scrollTop = 220;
	h.doc.getElementById('composer').value = 'Do not lose this draft';
	h.render([project([chat('saved', { title: 'Updated title' }), chat('other', { updatedAt: 500 })])]);
	assert.equal(h.doc.querySelector('.project-chat[data-project-chat="saved"]'), row);
	assert.equal(h.doc.activeElement, button);
	assert.equal(row.querySelector('.project-chat-title').textContent, 'Updated title');
	assert.equal(h.doc.querySelector('details').open, false);
	assert.equal(h.doc.getElementById('sidebar-content').scrollTop, 220);
	assert.equal(h.doc.getElementById('composer').value, 'Do not lose this draft');
	h.close();
});

test('Chats view groups attention and running work, labels projects and retains the same chat nodes', () => {
	const h = setup(); h.state.currentSessionId = 'saved';
	h.win.__zcProjectActivity = new Map([['wait', 'waiting'], ['run', 'running']]);
	h.render([project([chat('saved'), chat('wait'), chat('run'), chat('unread', { unread: true, completedAt: 150 }), chat('pin', { pinned: true }), chat('old', { archived: true })])]);
	const row = h.doc.querySelector('.project-chat[data-project-chat="saved"]');
	h.doc.querySelectorAll('.project-view')[1].click();
	assert.equal(h.panel.view, 'chats');
	assert.deepEqual(h.prefs, [{ projectPanelView: 'chats' }]);
	assert.equal(h.doc.querySelector('.project-chat[data-project-chat="saved"]'), row);
	assert.equal(h.doc.querySelector('[data-panel-key="section:attention"]').querySelectorAll('.project-chat').length, 2);
	assert.equal(h.doc.querySelector('[data-panel-key="section:running"]').querySelectorAll('.project-chat').length, 1);
	assert.equal(row.querySelector('.project-chat-project').hidden, false);
	assert.equal(row.querySelector('.project-chat-project').textContent, 'Alpha');
	assert.equal(h.doc.querySelector('[data-panel-key="section:archived"]').open, false);
	h.close();
});

test('pending choices override running; failure and cancellation are distinct from successful unread completion', () => {
	const { activity, sections } = require('../engine/media/project-panel');
	assert.equal(activity({ outcome: 'failed', unread: true }, 'waiting'), 'waiting');
	assert.equal(activity({ outcome: 'failed' }, undefined), 'failed');
	assert.equal(activity({ outcome: 'stopped', unread: false }, undefined), 'stopped');
	assert.equal(activity({ unread: true }, undefined), 'unread');
	const items = [{ chat: chat('old-failure', { outcome: 'failed' }), status: 'failed' }];
	assert.equal(sections(items)[0].key, 'section:recent', 'an already-read failure does not stay in attention forever');
});

test('only a visible foreground current conversation marks a completion read', () => {
	const h = setup();
	Object.defineProperty(h.doc, 'hidden', { value: true, configurable: true });
	const p = project([chat('saved', { unread: true, completedAt: 200 }), chat('background', { unread: true, completedAt: 300 })]);
	h.render([p]); assert.equal(h.posted.length, 0);
	Object.defineProperty(h.doc, 'hidden', { value: false }); h.doc.hasFocus = () => false; h.panel.acknowledge(); assert.equal(h.posted.length, 0);
	h.doc.hasFocus = () => true; h.panel.acknowledge(); h.panel.acknowledge();
	assert.deepEqual(h.posted, [{ type: 'sessionSeen', id: 'saved', completedAt: 200 }]);
	h.close();
});

test('palette keyboard search routes a chat by identity and restores the composer draft and focus', () => {
	const h = setup(); h.render([project([chat('saved'), chat('target', { title: 'Fix authentication' })])]);
	const composer = h.doc.getElementById('composer'); composer.value = 'Unsent message'; composer.focus();
	h.doc.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true }));
	const input = h.doc.querySelector('.project-palette-input'); assert.equal(h.doc.activeElement, input);
	input.value = 'authentication'; input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
	assert.equal(h.doc.querySelectorAll('.project-palette-option').length, 1);
	input.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(h.posted.at(-1), { type: 'switchSession', id: 'target' });
	assert(!h.doc.querySelector('.project-palette'));
	assert.equal(h.doc.activeElement, composer); assert.equal(composer.value, 'Unsent message');
	h.close();
});

test('missing project targets are disabled and cannot be activated from the palette', () => {
	const h = setup(); h.render([project([chat('missing')], { available: false })]); h.panel.openPalette();
	const input = h.doc.querySelector('.project-palette-input'); input.value = 'missing'; input.dispatchEvent(new h.win.Event('input', { bubbles: true }));
	assert(h.doc.querySelector('.project-palette-option').disabled);
	input.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert(!h.posted.some(m => m.type === 'switchSession'));
	input.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	assert(!h.doc.querySelector('.project-palette')); h.close();
});

test('titles are text, menu buttons are separate controls and filtering preserves an unrelated live row', () => {
	const h = setup(); h.render([project([chat('saved', { title: '<img src=x onerror=alert(1)>' }), chat('other')])]);
	const row = h.doc.querySelector('.project-chat[data-project-chat="saved"]');
	assert(!row.querySelector('img')); assert.equal(row.querySelectorAll('button').length, 2);
	assert(!row.querySelector('button button'));
	h.doc.getElementById('project-search').value = 'img'; h.render([project([chat('saved', { title: '<img src=x onerror=alert(1)>' }), chat('other')])]);
	assert.equal(h.doc.querySelector('.project-chat[data-project-chat="saved"]'), row);
	h.close();
});

test('desktop decoration keeps keyed row moves and section folds without session counts', () => {
	const h = setup();
	const desktop = fs.readFileSync(path.join(__dirname, '../app/desktop-ui.js'), 'utf8');
	const begin = desktop.indexOf('const projectFolds = new Map();');
	const end = desktop.indexOf('\n\tfunction sidebar()', begin);
	h.win.ICON = { chevDown: '' };
	h.win.restyle = () => {};
	h.win.post = () => {};
	h.win.action = cls => { const node = h.doc.createElement('i'); node.className = cls; return node; };
	h.win.eval(desktop.slice(begin, end) + '\nwindow.__zcDecorateProjects = decorate;');
	h.render([project([chat('saved'), chat('other')])]);
	const row = h.doc.querySelector('.project-chat[data-project-chat="saved"]');
	const group = row.closest('details');
	assert.equal(group.querySelector('.zc-project-subtitle'), null);
	assert.equal(group.querySelectorAll('.project-chat').length, 2);
	assert.equal(group.querySelectorAll('.project-chats').length, 1);
	assert.equal(row.querySelectorAll('.zc-del').length, 1);
	group.open = false;
	row.querySelector('button').focus();
	h.render([project([chat('saved', { title: 'Updated' })])]);
	assert.equal(group.open, false);
	assert.equal(group.querySelector('.zc-project-subtitle'), null);
	assert.equal(group.querySelectorAll('.project-chat').length, 1);
	assert.equal(h.doc.activeElement, row.querySelector('button'));
	h.doc.querySelectorAll('.project-view')[1].click();
	assert.equal(h.doc.querySelector('.project-chat[data-project-chat="saved"]'), row);
	assert.equal(row.querySelectorAll('.zc-del').length, 1);
	assert.equal(h.doc.querySelector('[data-panel-key="section:recent"]').open, true);
	h.close();
});

test('chat ordering survives updates, supports keyboard moves and preserves section membership', () => {
	const h = setup(), p = project([chat('saved', { updatedAt: 300 }), chat('other', { updatedAt: 200 }), chat('third', { updatedAt: 100 })]);
	h.render([p]);
	const order = () => [...h.doc.querySelectorAll('.project-chat')].map(row => row.dataset.projectChat);
	const button = h.doc.querySelector('button[data-project-chat="other"]'); button.focus();
	button.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
	assert.deepEqual(order(), ['other', 'saved', 'third']); assert.deepEqual(h.prefs.at(-1).projectChatOrder, ['other', 'saved', 'third']);
	assert.equal(h.doc.activeElement, button); assert.match(h.doc.querySelector('[role="status"]').textContent, /position 1 of 3/);
	p.chats[2].updatedAt = 999; h.render([p]); assert.deepEqual(order(), ['other', 'saved', 'third']);
	button.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); assert.equal(h.doc.activeElement.dataset.projectChat, 'third');
	h.doc.getElementById('project-search').value = 'other'; h.render([p]); const count = h.prefs.length;
	button.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); assert.equal(h.prefs.length, count, 'filtered lists cannot reorder hidden siblings');
	h.close();
});

test('dragging commits only a valid drop in the same group and cancellation leaves order intact', () => {
	const h = setup(); h.render([project([chat('saved'), chat('other')]), project([chat('elsewhere')], { id: 'beta', name: 'Beta', path: 'C:/beta', current: false })]);
	const first = h.doc.querySelector('.project-chat[data-project-chat="saved"]'), other = h.doc.querySelector('.project-chat[data-project-chat="other"]'), outside = h.doc.querySelector('.project-chat[data-project-chat="elsewhere"]');
	const transfer = { effectAllowed: '', dropEffect: '', setData() {} };
	const drag = (node, type) => { const event = new h.win.MouseEvent(type, { clientY: 100, bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: transfer }); node.dispatchEvent(event); };
	drag(first, 'dragstart'); drag(outside, 'drop'); assert.equal(h.prefs.length, 0);
	drag(first, 'dragstart'); drag(other, 'dragover'); assert(other.classList.contains('drop-after')); drag(other, 'drop');
	assert.deepEqual(h.prefs.at(-1).projectChatOrder.slice(0, 2), ['other', 'saved']); assert(!first.classList.contains('reordering'));
	const count = h.prefs.length; drag(first, 'dragstart'); drag(first, 'dragend'); assert.equal(h.prefs.length, count);
	h.close();
});

for (const [name, run] of tests) { run(); console.log('ok - ' + name); }
console.log(`project-panel: ${tests.length} tests passed`);
