const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test'), ts = require('typescript-classic');
const { JSDOM } = require('jsdom');
const out = path.join(__dirname, '../out');
const { CheckpointStore } = require(out + '/checkpoints');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/host/turnHistory.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
 t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
 const cp = new CheckpointStore(path.join(dir, 'checkpoints')), messages = [], prompts = [];
 let confirm = true, busy = false, saves = 0, failPath = '';
 const resolve = name => { const file = path.resolve(dir, name); if (!file.startsWith(dir + path.sep)) throw Error('outside workspace'); return { fsPath: file }; };
 const module = { exports: {} };
 vm.runInNewContext(code, { module, exports: module.exports, TextDecoder, Buffer, process, require: name => ({
  crypto: require('crypto'), fs, vscode: { workspace: { fs: { readFile: u => fs.promises.readFile(u.fsPath), delete: u => fs.promises.unlink(u.fsPath) } }, window: { showWarningMessage: async (message, _options, choice) => { prompts.push(message); return confirm ? choice : undefined; } } },
  './capabilities': { isDesktopHost: () => true }, '../checkpoints': require(out + '/checkpoints'), '../acp/stream': { closeAcpAgents: () => {} }, '../tools/agentTools': { resolveInWorkspace: resolve, writeText: (u, text) => u.fsPath.endsWith(failPath) && failPath ? Promise.reject(Error('write refused')) : fs.promises.writeFile(u.fsPath, text) }, '../tools/diffStats': require(out + '/tools/diffStats'), '../tools/redact': require(out + '/tools/redact')
 }[name]) });
 const ctx = { store: { saveMessages: async () => { saves++; fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(messages)); } }, status() {}, sendState: async () => {} };
 const deps = { checkpoints: cp, originals: new Map(), sessionId: () => 's', messages: () => messages, busy: () => busy };
 const host = new module.exports.TurnHistory(ctx, deps);
 const seed = (id, files) => { cp.save('s', { userId: id, at: Date.now(), files }); messages.push({ id, role: 'user', content: id, turn: { startedAt: 1, edits: Object.keys(files).map(p => ({ path: p, added: 1, removed: 1 })) } }); };
 return { dir, cp, host, messages, prompts, seed, read: p => fs.readFileSync(resolve(p).fsPath, 'utf8'), write: (p, text) => fs.writeFileSync(resolve(p).fsPath, text), confirm: x => confirm = x, busy: x => busy = x, saves: () => saves, fail: p => failPath = p };
}

test('row Undo cascades through later snapshots of that file and preserves unrelated files; Redo survives reload', async t => {
 const f = fixture(t);
 f.seed('u1', { 'a.txt': { before: 'v1', after: 'v2' }, 'b.txt': { before: 'old b', after: 'new b' } });
 f.seed('u2', { 'a.txt': { before: 'v2', after: 'v3' }, 'c.txt': { before: null, after: 'new c' } });
 f.seed('u3', { 'a.txt': { before: 'v3', after: 'v4' } });
 f.write('a.txt', 'v4'); f.write('b.txt', 'new b'); f.write('c.txt', 'new c');
 f.confirm(false); await f.host.handle({}, { type: 'undoTurn', id: 'u1', path: 'a.txt' }); assert.equal(f.read('a.txt'), 'v4', 'declined dependency confirmation writes nothing');
 f.confirm(true); await f.host.handle({}, { type: 'undoTurn', id: 'u1', path: 'a.txt' });
 assert.equal(f.read('a.txt'), 'v1'); assert.equal(f.read('b.txt'), 'new b'); assert.equal(f.read('c.txt'), 'new c');
 assert(f.messages.filter(m => m.turn).every(m => m.turn.edits.find(e => e.path === 'a.txt').undone));
 assert.equal(f.messages[0].turn.undone, false); assert.equal(f.messages[2].turn.undone, true);
 assert(new CheckpointStore(path.join(f.dir, 'checkpoints')).load('s', 'u3').files['a.txt'].undone);
 await assert.rejects(f.host.handle({}, { type: 'undoTurn', id: 'u2', path: 'a.txt', redo: true }), /Redo earlier/);
 for (const [id, expected] of [['u1', 'v2'], ['u2', 'v3'], ['u3', 'v4']]) { await f.host.handle({}, { type: 'undoTurn', id, path: 'a.txt', redo: true }); assert.equal(f.read('a.txt'), expected); }
 assert(f.messages.filter(m => m.turn).every(m => !m.turn.undone)); assert(f.saves() >= 4);
 f.busy(true); await assert.rejects(f.host.handle({}, { type: 'undoTurn', id: 'u1', path: 'a.txt' }), /finish/); f.busy(false);
 await assert.rejects(f.host.handle({}, { type: 'undoTurn', id: 'u1', path: '../private' }), /nothing left/);
});

test('row restore protects manual edits and refuses to overwrite a later unsnapshotted change', async t => {
 const f = fixture(t); f.seed('u1', { 'a.txt': { before: 'old', after: 'new' } }); f.write('a.txt', 'manual');
 f.confirm(false); await f.host.handle({}, { type: 'undoTurn', id: 'u1', path: 'a.txt' }); assert.equal(f.read('a.txt'), 'manual'); assert(!f.cp.load('s', 'u1').files['a.txt'].undone);
 f.messages.push({ id: 'later', role: 'user', content: '', turn: { startedAt: 2, edits: [{ path: 'a.txt', added: 2, removed: 0 }], undoSkipped: ['a.txt'] } });
 f.confirm(true); await assert.rejects(f.host.handle({}, { type: 'undoTurn', id: 'u1', path: 'a.txt' }), /no undo snapshot/); assert.equal(f.read('a.txt'), 'manual');
});

test('whole-turn Undo recognizes partial hunk decisions and resets them for full Redo', async t => {
 const f = fixture(t), before = 'old\ncommon\nold', after = 'new\ncommon\nnew';
 f.seed('partial', { 'partial.txt': { before, after, review: { kept: [1], undone: [0] } } }); f.write('partial.txt', 'old\ncommon\nnew');
 await f.host.handle({}, { type: 'undoTurn', id: 'partial', path: 'partial.txt' });
 assert.equal(f.read('partial.txt'), before); assert.equal(f.prompts.length, 0, 'an intentionally undone block is not a manual edit'); assert.equal(f.cp.load('s', 'partial').files['partial.txt'].review, undefined);
 await f.host.handle({}, { type: 'undoTurn', id: 'partial', path: 'partial.txt', redo: true }); assert.equal(f.read('partial.txt'), after);
});

test('a failed later file preserves the completed row and its redo checkpoint', async t => {
 const f = fixture(t); f.seed('u1', { 'a.txt': { before: 'old a', after: 'new a' }, 'b.txt': { before: 'old b', after: 'new b' } });
 f.write('a.txt', 'new a'); f.write('b.txt', 'new b'); f.fail('b.txt');
 await assert.rejects(f.host.handle({}, { type: 'undoTurn', id: 'u1' }), /write refused/);
 assert.equal(f.read('a.txt'), 'old a'); assert.equal(f.read('b.txt'), 'new b');
 assert(f.messages[0].turn.edits[0].undone); assert(!f.messages[0].turn.edits[1].undone); assert.equal(f.messages[0].turn.undone, false);
 assert(f.cp.load('s', 'u1').files['a.txt'].undone); assert(!f.cp.load('s', 'u1').files['b.txt'].undone);
 assert(JSON.parse(fs.readFileSync(path.join(f.dir, 'messages.json')))[0].turn.edits[0].undone);
});

test('finished change previews contain changed content with secrets masked', async t => {
 const f = fixture(t), user = { id: 'u', role: 'user', content: '', turn: { startedAt: 1 } };
 f.messages.push(user); f.write('a.txt', 'const same = 1;\nOPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\n');
 await f.host.finish(user, new Map([['a.txt', 'const same = 1;\nold value\n']]), 's');
 assert.equal(user.turn.edits[0].previewBefore, 'old value');
 assert(!user.turn.edits[0].previewAfter.includes('sk-proj-')); assert(user.turn.edits[0].previewAfter.length <= 160);
});

test('ledger uses escaped before/after rows, previews same-file dependencies and keeps external effects', () => {
 const source = require('./page-scripts').readPage('chat.js');
 const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
 const wanted = new Set(['ledgerEffects', 'ledgerTime', 'renderEdits', 'renderEffects', 'ledgerDisclosure', 'buildUnits', 'previewLedger', 'clearLedgerPreview', 'approvalPhase']), declarations = [];
 const visit = n => { if (ts.isFunctionDeclaration(n) && wanted.has(n.name?.text)) declarations.push(n.getText(ast)); ts.forEachChild(n, visit); }; visit(ast); assert.equal(declarations.length, wanted.size);
 const dom = new JSDOM('<body></body>'), document = dom.window.document;
 const edits = [{ path: 'a<script>.txt', added: 1, removed: 1, previewBefore: '<old>', previewAfter: '<new>' }];
 const user = { id: 'u1', role: 'user', turn: { edits, endedAt: Date.now() } }, later = { id: 'u2', role: 'user', turn: { edits: edits.map(e => ({ ...e })) } };
 const state = { messages: [user, later], undoable: ['u1', 'u2'], redoable: ['u1', 'u2'], isStreaming: false };
 const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
 const h = (tag, cls, html) => { const n = document.createElement(tag); n.className = cls; if (html) n.innerHTML = html; return n; };
 const context = vm.createContext({ document, state, ui: { expanded: new Set() }, h, esc, I: () => '', fileBadge: () => '', buildTurns: items => [{ user: items.find(m => m.role === 'user'), items: items.filter(m => m.role !== 'user') }], turnAgentRuns: () => [], isText: m => !m.kind, isNote: () => false }); vm.runInContext(declarations.join('\n'), context);
 document.body.append(context.renderEdits({ user, items: [] }), context.renderEdits({ user: later, items: [] }), context.renderEffects({ user: later, items: [{ id: 'external', approval: { kind: 'mcp', destructive: true, status: 'applied', execution: 'done', tool: 'Service › publish', result: 'sent' } }] }));
 assert.equal(document.querySelector('script'), null); assert.equal(document.querySelector('.ui-alc__before').textContent, '<old>');
 assert.equal(document.querySelector('.ledger-disclosure').textContent, '›1 file changed');
 assert.equal(document.querySelector('.ledger-body').hidden, true);
 assert.equal(document.querySelector('.ledger-summary-actions [data-review]').dataset.path, undefined);
 document.querySelector('.ledger-disclosure').click();
 assert.equal(document.querySelector('.ledger-body').hidden, false);
 assert.equal(document.querySelector('.ledger-disclosure').getAttribute('aria-expanded'), 'true');
 assert.equal(context.renderEdits({ user, items: [] }).querySelector('.ledger-body').hidden, false, 'expansion survives repaint');
 context.previewLedger(document.querySelector('[data-ledger-preview]'));
 assert.equal(document.querySelectorAll('[data-preview]').length, 1); assert.equal(document.querySelectorAll('[data-chain="also"]').length, 1); assert.equal(document.querySelectorAll('[data-chain="kept"]').length, 1);
 assert.equal(document.querySelector('[data-chain="also"] .ui-alc__flag').textContent, 'Also undone');
 assert.equal(document.querySelector('[data-chain="kept"] .ui-alc__flag').textContent, "Can't undo");
 context.clearLedgerPreview(); assert.equal(document.querySelectorAll('[data-preview], [data-chain]').length, 0);
 user.turn.edits[0].undone = true;
 const undone = context.renderEdits({ user, items: [] }); assert(undone.querySelector('[data-redo="true"]')); assert(undone.querySelector('[data-undone]'));
 // Routine history never produces a change summary or an external-action summary.
 const routine = [
  { id: 'cmd', kind: 'tool', approval: { kind: 'command', status: 'applied', execution: 'done', command: 'git status', result: 'clean' } },
  { id: 'read', kind: 'tool', tool: { name: 'mcp__docs__search', status: 'done', summary: 'found', externalAction: false } },
  { id: 'old', kind: 'tool', tool: { name: 'mcp__unknown__tool', status: 'done', summary: 'result' } },
  { id: 'answer', role: 'assistant', content: 'Done' }
 ];
 const external = { id: 'write', kind: 'tool', tool: { name: 'mcp__service__publish', status: 'error', summary: 'failed', detail: '<denied>', externalAction: true } };
 const completed = { id: 'plain', role: 'user', turn: { endedAt: Date.now() } };
 state.messages = [completed, ...routine];
 assert.equal(Array.from(context.buildUnits()).filter(u => ['edits', 'effects'].includes(u.kind)).length, 0);
 assert.equal(Array.from(context.buildUnits()).find(u => u.kind === 'worked').steps.length, 3);
 state.messages.push(external);
 assert.deepEqual(Array.from(context.buildUnits()).filter(u => ['edits', 'effects'].includes(u.kind)).map(u => u.kind), ['effects']);
 completed.turn.edits = edits;
 assert.deepEqual(Array.from(context.buildUnits()).filter(u => ['edits', 'effects'].includes(u.kind)).map(u => u.kind), ['edits', 'effects']);
 assert.equal(context.ledgerEffects([{ approval: { kind: 'mcp', externalAction: true, status: 'rejected' } }]).length, 0);
 const actionCard = context.renderEffects({ user: completed, items: [external] });
 assert.match(actionCard.textContent, /1 external action · 1 failed/);
 assert.equal(actionCard.querySelector('.ui-alc__detail').textContent, '<denied>');
 assert.equal(actionCard.querySelector('denied'), null);
 state.isStreaming = true;
 assert(context.renderEdits({ user, items: [] }).querySelector('.ledger-summary-actions [data-undo]').disabled);
 dom.window.close();
});
