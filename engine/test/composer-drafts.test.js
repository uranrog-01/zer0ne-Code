const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript-classic');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const attachmentCode = compile(fs.readFileSync(path.join(__dirname, '../src/host/attachments.ts'), 'utf8'));
function attachments(file) {
 const module = { exports: {} };
 vm.runInNewContext(attachmentCode, { module, exports: module.exports, require: name => ({ fs, path, vscode: {}, '../providerStore': {}, '../tools/agentTools': {}, './mentions': {} })[name] });
 return new module.exports.Attachments({ status: message => { throw new Error(message); } }, file);
}
const item = id => ({ id, name: id, kind: 'text', content: 'contents-' + id });
test('attachment drafts stay with their chat across switches, sends and restart; legacy drafts migrate', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-composer-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const file = path.join(dir, 'drafts.json');
 fs.writeFileSync(file, JSON.stringify([item('legacy')]));
 let a = attachments(file); a.selectSession('a');
 assert.equal(a.items[0].id, 'legacy');
 a.selectSession('b'); assert.equal(a.items.length, 0);
 a.items.push(item('b')); a.view();
 a.selectSession('a'); assert.equal(a.items[0].id, 'legacy');
 a.clear(); a.selectSession('b'); assert.equal(a.items[0].id, 'b');
 a = attachments(file); a.selectSession('a'); assert.equal(a.items.length, 0);
 a.selectSession('b'); assert.equal(a.items[0].content, 'contents-b');
 a.selectSession('a'); a.items.push(item('a')); a.view();
 a.removeSession('b'); a = attachments(file); a.selectSession('b'); assert.equal(a.items.length, 0);
 a.selectSession('a'); assert.equal(a.items[0].id, 'a');
 a.removeSession('a'); a = attachments(file); a.selectSession('a'); assert.equal(a.items.length, 0);
});
const uiSource = require('./page-scripts').readPage('chat.js');
const ast = ts.createSourceFile('chat.js', uiSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = [];
function visit(node) {
 if (ts.isFunctionDeclaration(node) && ['saveUi', 'switchComposerSession', 'discardComposerDraft'].includes(node.name?.text)) functions.push(node.getText(ast));
 ts.forEachChild(node, visit);
}
visit(ast);
function composer(persisted = {}) {
 const state = {}, el = { input: { value: persisted.draft || '' } }, ui = { collapsedFolders: new Set() };
 const ctx = vm.createContext({ state, el, ui, persisted, composerDrafts: new Map(Object.entries(persisted.composerDrafts || {})), B: { patchState: patch => Object.assign(persisted, patch) }, autosize() {} });
 vm.runInContext(functions.join('\n'), ctx);
 return { state, el, persisted, save: () => ctx.saveUi(), discard: id => ctx.discardComposerDraft(id), switch(id) { ctx.switchComposerSession(id); state.currentSessionId = id; ctx.saveUi(); } };
}
test('composer drafts restore per chat without overwriting a newer draft on reload', () => {
 let c = composer({ draft: 'legacy' }); c.switch('a'); assert.equal(c.el.input.value, 'legacy');
 c.switch('b'); assert.equal(c.el.input.value, '');
 c.el.input.value = 'draft b'; c.save(); c.switch('a'); assert.equal(c.el.input.value, 'legacy');
 c.el.input.value = ''; c.save(); c.switch('b'); assert.equal(c.el.input.value, 'draft b');
 c = composer(c.persisted); c.switch('a'); assert.equal(c.el.input.value, '');
 c.switch('b'); assert.equal(c.el.input.value, 'draft b');
 c.el.input.value = 'editing'; c.save(); assert.equal(c.el.input.value, 'editing');
 c.switch('a'); c.el.input.value = 'keep a'; c.save(); c.discard('b');
 assert.equal(c.el.input.value, 'keep a'); assert.equal(c.persisted.composerDrafts.b, undefined);
 c.discard('a'); assert.equal(c.el.input.value, ''); assert.equal(c.persisted.composerDrafts.a, undefined);
});

test('switching chats retains an IME draft even if blur cancels the composition', () => {
	const persisted = {}, state = { currentSessionId: 'a' }, ui = { composing: true, collapsedFolders: new Set() };
	const el = { input: { value: 'draft 日本', blur() { this.value = 'draft '; } } };
	const ctx = vm.createContext({ state, el, ui, persisted, composerDrafts: new Map(), B: { patchState: patch => Object.assign(persisted, patch) }, autosize() {} });
	vm.runInContext(functions.join('\n'), ctx);
	ctx.switchComposerSession('b'); state.currentSessionId = 'b';
	assert.equal(el.input.value, '');
	ctx.switchComposerSession('a');
	assert.equal(el.input.value, 'draft 日本');
	assert.equal(ui.composing, false);
});

test('file views restore per chat and per window, including subdirectories and reading position', () => {
	const names = new Set(['saveDocumentView', 'switchDocumentSession']);
	const fns = [];
	function collect(node) {
		if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) fns.push(node.getText(ast));
		ts.forEachChild(node, collect);
	}
	collect(ast);
	function view(saved = {}) {
		const state = {}, auxFiles = { filter: '', open: new Set(), preview: null }, sent = [];
		const ctx = vm.createContext({ state, auxFiles, documentViews: new Map(Object.entries(saved)), fsUi: {}, $: () => ({ querySelector: () => null }), B: { patchState(p) { Object.assign(saved, p.documentViews); } }, post: m => sent.push(m), auxMaxClose() {}, fsRenderPreview() {}, fsLayers() {} });
		vm.runInContext(fns.join('\n'), ctx);
		return { auxFiles, sent, saved, switch(id) { ctx.switchDocumentSession(id); state.currentSessionId = id; } };
	}
	const a = view(); a.switch('a');
	a.auxFiles.filter = 'src'; a.auxFiles.open.add('src/deep'); a.auxFiles.preview = { path: 'src/deep/a.ts', scrollTop: 230 };
	a.switch('b'); assert.equal(a.auxFiles.preview, null);
	a.auxFiles.preview = { path: 'b.ts', scrollTop: 50 };
	a.switch('a'); assert.equal(a.auxFiles.preview.path, 'src/deep/a.ts'); assert.equal(a.auxFiles.preview.scrollTop, 230);
	assert.equal(a.auxFiles.filter, 'src'); assert.ok(a.auxFiles.open.has('src/deep'));
	assert.equal(a.sent.at(-1).sessionId, 'a');
	const b = view(); b.switch('a'); assert.equal(b.auxFiles.preview, null);
	const restored = view(a.saved); restored.switch('a'); assert.equal(restored.auxFiles.preview.path, 'src/deep/a.ts');
});

test('rapid input batches layout and persistence, and defers layout during IME composition', () => {
	let declaration;
	function collect(node) {
		if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'queueComposerInput') declaration = node.initializer.getText(ast);
		ts.forEachChild(node, collect);
	}
	collect(ast);
	const frames = [], timers = new Map(), counts = { layout: 0, popup: 0, render: 0, save: 0 };
	let seq = 0;
	const ui = { composing: false };
	const ctx = vm.createContext({ ui, setTimeout(fn) { timers.set(++seq, fn); return seq; }, clearTimeout(id) { timers.delete(id); }, requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, autosize() { counts.layout++; }, detectPopup() { counts.popup++; }, renderSendControl() { counts.render++; }, renderComposer() { assert.fail('typing must not rebuild stats, attachments or queue controls'); }, saveUi() { counts.save++; } });
	const input = vm.runInContext(declaration, ctx);
	for (let i = 0; i < 100; i++) input();
	assert.equal(frames.length, 1); assert.equal(timers.size, 1); assert.equal(counts.save, 0);
	frames.shift()(); assert.equal(counts.layout, 1); assert.equal(counts.render, 1);
	ui.composing = true; input(); frames.shift()(); assert.equal(counts.layout, 1); assert.equal(counts.popup, 1);
	ui.composing = false; input(); frames.shift()(); assert.equal(counts.layout, 2);
	[...timers.values()][0](); assert.equal(counts.save, 1);
});

test('late preview responses cannot populate another chat with the same open file', () => {
	let handler;
	function collect(node) {
		if (ts.isCaseClause(node) && node.expression.getText(ast) === "'filePreview'") handler = node.getText(ast);
		ts.forEachChild(node, collect);
	}
	collect(ast);
	const auxFiles = { preview: { path: 'same.txt' } };
	const ctx = vm.createContext({ state: { currentSessionId: 'b' }, auxFiles, fsUi: {}, renderExplorer() {}, auxMaxRender() {} });
	const receive = vm.runInContext(`msg => { switch(msg.type) { ${handler} } }`, ctx);
	receive({ type: 'filePreview', sessionId: 'a', path: 'same.txt', content: 'wrong chat' });
	assert.equal(auxFiles.preview.content, undefined);
	receive({ type: 'filePreview', sessionId: 'b', path: 'same.txt', content: 'right chat' });
	assert.equal(auxFiles.preview.content, 'right chat');
});

test('blank orphan tool cards are omitted while real tools and pending approvals remain', () => {
	let fn;
	function collect(node) {
		if (ts.isFunctionDeclaration(node) && node.name?.text === 'buildUnits') fn = node.getText(ast);
		ts.forEachChild(node, collect);
	}
	collect(ast);
	let filtered;
	const messages = [{ id: 'blank', kind: 'tool', content: ' ' }, { id: 'tool', kind: 'tool', tool: { name: 'read_file' }, content: '' }, { id: 'approval', kind: 'tool', approval: { status: 'pending' }, content: '' }, { id: 'text', content: 'answer' }];
	const ctx = vm.createContext({ state: { messages }, buildTurns(items) { filtered = items; return []; } });
	vm.runInContext(fn, ctx); ctx.buildUnits();
	assert.deepEqual(filtered.map(m => m.id), ['tool', 'approval', 'text']);
});

test('agent paths reject escaping junctions for existing reads and new writes, including Windows alternate streams', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-paths-')), root = path.join(dir, 'project'), outside = path.join(dir, 'neighbor');
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 fs.mkdirSync(root); fs.mkdirSync(outside); fs.mkdirSync(path.join(root, 'inside'));
 fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
 fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
 fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'linked'), 'junction');
 const source = fs.readFileSync(path.join(__dirname, '../src/tools/agentTools.ts'), 'utf8');
 const tree = ts.createSourceFile('agentTools.ts', source, ts.ScriptTarget.Latest, true);
 const fn = tree.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'resolveInWorkspace').getText(tree).replace(/^export /, '');
 const ctx = vm.createContext({ fs, path, process, workspaceRoot: () => ({ scheme: 'file', fsPath: root }), vscode: { Uri: { file: fsPath => ({ fsPath }) } } });
 vm.runInContext(compile(fn), ctx);
 for (const name of ['escape/private.txt', 'escape/new/deep.txt', '../neighbor/private.txt', outside]) assert.throws(() => ctx.resolveInWorkspace(name), /outside the workspace/);
 assert.equal(ctx.resolveInWorkspace('linked/new.txt').fsPath, path.join(root, 'linked', 'new.txt'));
 assert.equal(ctx.resolveInWorkspace('new/deep.txt').fsPath, path.join(root, 'new', 'deep.txt'));
 assert.equal(ctx.resolveInWorkspace('..notes').fsPath, path.join(root, '..notes'));
 if (process.platform === 'win32') assert.throws(() => ctx.resolveInWorkspace('file.txt:secret'), /Alternate streams/);
 const alias = path.join(dir, 'project-alias'); fs.symlinkSync(root, alias, 'junction');
 ctx.workspaceRoot = () => ({ scheme: 'file', fsPath: alias });
 assert.equal(ctx.resolveInWorkspace('new.txt').fsPath, path.join(alias, 'new.txt'), 'keep editor paths relative to the opened project alias');
 assert.throws(() => ctx.resolveInWorkspace('escape/private.txt'), /outside the workspace/);
});
