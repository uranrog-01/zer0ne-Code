'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript-classic');
const { JSDOM } = require('jsdom');
const source = require('./page-scripts').readPage('chat.js');
const markup = fs.readFileSync(path.join(__dirname, '../src/webviewMarkup.ts'), 'utf8').match(/CHAT_BODY = `([\s\S]*?)`;/)[1];
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = new Map();
const statements = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast));
  if (ts.isExpressionStatement(node)) {
    const text = node.getText(ast);
    if (text.startsWith("el.auxiliary.addEventListener('click'") || /^\$\('aux-explorer-(filter|tree)'\).*addEventListener/.test(text)) statements.push(text);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function fixture() {
  const dom = new JSDOM(markup, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, d = w.document;
  w.$ = id => d.getElementById(id);
  w.esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w.I = name => '<svg class="i" aria-hidden="true" data-icon="' + name + '"></svg>';
  w.basename = value => value.split('/').pop();
  w.auxEmpty = (_icon, title, detail) => '<div class="aux-empty"><b>' + w.esc(title) + '</b><p>' + w.esc(detail) + '</p></div>';
  w.auxFiles = { filter: '', editedOnly: false, loading: false, open: new Set(), preview: null };
  w.ui = { files: ['src/main.ts', 'src/nested/helper.js', 'assets/icon.svg', 'README.md', 'odd"<img>.json'], filesAt: 1 };
  w.state = { currentSessionId: 'chat', workspace: { name: 'Fixture workspace' }, messages: [
    { approval: { path: 'src/main.ts', kind: 'edit', status: 'applied' } },
    { tool: { name: 'read_file', arg: 'README.md' } }
  ] };
  w.el = { auxiliary: w.$('auxiliary'), messages: w.$('messages') };
  const posts = [], saves = [], observers = [];
  w.post = message => posts.push(message);
  w.B = { patchState: value => saves.push(value) };
  w.documentViews = new Map();
  w.activeAuxTab = () => 'explorer';
  w.renderAuxPreview = preview => { w.$('aux-explorer-preview').textContent = preview.path; };
  w.auxOpenPreview = file => { w.auxFiles.preview = { path: file }; w.renderExplorer(); };
  w.ensureFiles = () => posts.push({ type: 'getFiles', refresh: true });
  w.ResizeObserver = class { constructor(callback) { observers.push(callback); } observe() {} };
  w.gitUi = {}; w.SP_DOCK_MIN = 980;
  w.h = (tag, cls) => { const node = d.createElement(tag); node.className = cls; return node; };
  w.renderGitTools = () => {};
  w.eval(['explorerFileIcon', 'explorerActivity', 'renderExplorer', 'explorerKeydown', 'fsTree', 'fsMarks', 'syncAuxPreview', 'saveDocumentView', 'gitEnsure'].map(name => functions.get(name)).join('\n'));
  w.eval(statements.join('\n'));
  const tree = w.$('aux-explorer-tree');
  const rows = () => [...tree.querySelectorAll('[role="treeitem"]')];
  const folder = name => rows().find(row => row.dataset.auxTreeDir === name);
  const file = name => rows().find(row => row.dataset.auxOpenFile === name);
  const key = (row, key) => { row.focus(); row.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); };
  return { dom, w, d, tree, posts, saves, rows, folder, file, key };
}

test('Explorer renders safe file names, natural folder hierarchy, counts and chat activity', () => {
  const f = fixture();
  try {
    f.w.renderExplorer();
    assert.equal(f.w.$('aux-explorer-root').textContent, 'Fixture workspace');
    assert.equal(f.w.$('aux-explorer-count').textContent, '5 files');
    assert.equal(f.folder('src').querySelector('.explorer-folder-count').textContent, '2');
    assert.equal(f.folder('src').getAttribute('aria-expanded'), 'false');
    assert.equal(f.tree.querySelector('img'), null);
    assert.equal(f.file('odd"<img>.json').title, 'odd"<img>.json');
    f.folder('src').click();
    assert.equal(f.file('src/main.ts').getAttribute('aria-level'), '2');
    assert.equal(f.file('src/main.ts').querySelector('.explorer-file-icon').textContent, 'TS');
    assert.equal(f.file('src/main.ts').querySelector('.explorer-activity').textContent, 'M');
    assert.equal(f.file('README.md').querySelector('.explorer-activity').textContent, 'R');
    assert.equal(f.tree.querySelector('.fs-pre'), null);
  } finally { f.dom.window.close(); }
});

test('search, Edited scope, clear, reset, collapse and refresh operate on the real listeners', () => {
  const f = fixture();
  try {
    f.w.renderExplorer();
    const search = f.w.$('aux-explorer-filter'); search.value = 'NESTED/HELP'; search.dispatchEvent(new f.w.Event('input'));
    assert.equal(f.rows().length, 1); assert.ok(f.file('src/nested/helper.js'));
    assert.equal(f.file('src/nested/helper.js').querySelector('.explorer-file-path').textContent, 'src/nested');
    f.w.$('aux-explorer-clear').click(); assert.equal(search.value, ''); assert.equal(f.d.activeElement, search);
    f.d.querySelector('[data-explorer-scope="edited"]').click();
    assert.equal(f.rows().length, 1); assert.ok(f.file('src/main.ts'));
    assert.equal(f.d.querySelector('[data-explorer-scope="edited"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.saves.at(-1).documentViews.chat.editedOnly, true);
    search.value = 'absent'; search.dispatchEvent(new f.w.Event('input'));
    assert.match(f.tree.textContent, /No edited files match/);
    f.d.querySelector('[data-explorer-reset]').click(); assert.equal(f.w.auxFiles.editedOnly, false);
    f.folder('src').click(); f.d.querySelector('[data-explorer-collapse]').click();
    assert.equal(f.w.auxFiles.open.size, 0); assert.equal(f.folder('src').getAttribute('aria-expanded'), 'false');
    f.d.querySelector('[data-explorer-refresh]').click(); assert.equal(f.posts.at(-1).refresh, true);
  } finally { f.dom.window.close(); }
});

test('keyboard navigation expands and collapses folders, moves focus and opens the selected file', () => {
  const f = fixture();
  try {
    f.w.renderExplorer(); f.key(f.folder('src'), 'ArrowRight');
    assert.equal(f.folder('src').getAttribute('aria-expanded'), 'true');
    assert.equal(f.d.activeElement, f.folder('src'));
    f.key(f.folder('src'), 'ArrowRight'); assert.equal(f.d.activeElement, f.folder('src/nested'));
    f.key(f.file('src/main.ts'), 'ArrowLeft'); assert.equal(f.d.activeElement, f.folder('src'));
    f.key(f.folder('src'), 'ArrowLeft'); assert.equal(f.folder('src').getAttribute('aria-expanded'), 'false');
    f.key(f.folder('src'), 'End'); assert.equal(f.d.activeElement, f.rows().at(-1));
    f.file('README.md').click();
    assert.equal(f.w.auxFiles.preview.path, 'README.md');
    assert.equal(f.file('README.md').getAttribute('aria-selected'), 'true');
    assert.equal(f.rows().filter(row => row.tabIndex === 0).length, 1);
    f.w.auxFiles.loading = true; f.w.renderExplorer();
    assert.equal(f.tree.getAttribute('aria-busy'), 'true'); assert.equal(f.w.$('aux-explorer-count').textContent, 'Refreshing…');
  } finally { f.dom.window.close(); }
});

test('Git status and review belong to the primary chat instead of the app or Work Details', () => {
  const f = fixture();
  try {
    const card = f.w.gitEnsure(), chat = f.d.querySelector('.primary-chat');
    assert.equal(card.parentElement, chat); assert.equal(f.w.$('git-review').parentElement, chat);
    assert.ok(!f.w.$('auxiliary').contains(card));
    assert.equal(f.w.gitEnsure(), card); assert.equal(f.d.querySelectorAll('#git-tools').length, 1);
    f.w.$('auxiliary').classList.remove('hidden'); assert.equal(card.parentElement, chat);
  } finally { f.dom.window.close(); }
});
