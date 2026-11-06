'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { createShim, install } = require('./vscode-shim');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-change-review-')), project = path.join(base, 'project');
fs.mkdirSync(project);
const shim = createShim({ workspace: project, dataDir: path.join(base, 'data') }); install(shim.vscode);
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { HunkReviewHost } = require(path.join(out, 'host/hunkReview'));
const { ModelComparisonsHost } = require(path.join(out, 'host/modelComparisons'));
const { CheckpointStore } = require(path.join(out, 'checkpoints'));
const { TaskBudgets } = require(path.join(out, 'core/taskBudget'));
const { ToolScheduler } = require(path.join(out, 'core/toolScheduler'));
const { DEFAULT_SETTINGS } = require(path.join(out, 'providerStore'));
const { WriterPool } = require(path.join(out, 'host/writers'));
const cp = require('node:child_process'), wt = require(path.join(out, 'worktrees'));
function removeFixture(directory) {
 const target = path.resolve(directory), relative = path.relative(base, target);
 assert(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'fixture cleanup must stay within its temporary root');
 fs.rmSync(target, { recursive: true, force: true });
}
test.after(() => removeFixture(base));

function hunkFixture() {
 const checkpoints = new CheckpointStore(path.join(base, 'checkpoints-' + Math.random())), messages = [], sent = [];
 let session = 's', mode = 'full', busy = false, denied = '';
 const ctx = { store: { getMode: () => mode, getSettings: () => ({ denyPaths: denied }), saveMessages: async () => {} }, sendState: async () => {}, status() {} };
 const host = new HunkReviewHost(ctx, { checkpoints, session: () => session, messages: () => messages, busy: () => busy });
 const surface = { kind: 'chat', post: m => sent.push(m) };
 const seed = (name, before, after, id = 'u1') => { checkpoints.save('s', { userId: id, at: Date.now(), files: { [name]: { before, after } } }); messages.push({ id, role: 'user', turn: { startedAt: 1, edits: [{ path: name }] } }); if (after === null) fs.rmSync(path.join(project, name), { force: true }); else fs.writeFileSync(path.join(project, name), after); };
 const preview = async (name, id = 'u1') => { await host.handle(surface, { type: 'hunkReview', sessionId: session, id, path: name }); return sent.at(-1); };
 const decide = async (view, index, action, owner = surface) => { await host.handle(owner, { type: 'hunkDecision', sessionId: session, reviewId: view.reviewId, index, action }); return sent.at(-1); };
 return { host, surface, checkpoints, messages, sent, seed, preview, decide, session: s => session = s, mode: m => mode = m, busy: b => busy = b, deny: d => denied = d };
}

test('individual hunk decisions preserve CRLF and immutable snapshots across restart', async () => {
 const f = hunkFixture(), before = 'old one\r\nunchanged\r\nold two\r\n', after = 'new one\r\nunchanged\r\nnew two\r\n';
 f.seed('hunks.txt', before, after);
 let view = await f.preview('hunks.txt'); assert.equal(view.hunks.length, 2);
 view = await f.decide(view, 0, 'keep'); assert.equal(view.hunks[0].kept, true); assert.equal(fs.readFileSync(path.join(project, 'hunks.txt'), 'utf8'), after);
 view = await f.decide(view, 1, 'undo'); assert.equal(fs.readFileSync(path.join(project, 'hunks.txt'), 'utf8'), 'new one\r\nunchanged\r\nold two\r\n');
 const saved = f.checkpoints.load('s', 'u1').files['hunks.txt']; assert.equal(saved.before, before); assert.equal(saved.after, after); assert.deepEqual(saved.review, { kept: [0], undone: [1] });
 const restarted = new HunkReviewHost({ store: { getMode: () => 'full', getSettings: () => ({}), saveMessages: async () => {} }, sendState: async () => {} }, { checkpoints: f.checkpoints, session: () => 's', messages: () => f.messages, busy: () => false });
 await restarted.handle(f.surface, { type: 'hunkReview', sessionId: 's', id: 'u1', path: 'hunks.txt' }); view = f.sent.at(-1);
 await restarted.handle(f.surface, { type: 'hunkDecision', sessionId: 's', reviewId: view.reviewId, index: 1, action: 'redo' });
 assert.equal(fs.readFileSync(path.join(project, 'hunks.txt'), 'utf8'), after);
});

test('stale files, cross-surface tokens, newer turns, protected paths and read-only mode refuse writes', async () => {
 const f = hunkFixture(); f.seed('guarded.txt', 'before', 'after');
 let view = await f.preview('guarded.txt');
 await f.decide(view, 0, 'undo', { kind: 'remote', post: m => f.sent.push(m) }); assert.match(f.sent.at(-1).error, /expired/);
 fs.writeFileSync(path.join(project, 'guarded.txt'), 'manual'); assert.match((await f.decide(view, 0, 'undo')).error, /changed outside/); assert.equal(fs.readFileSync(path.join(project, 'guarded.txt'), 'utf8'), 'manual');
 fs.writeFileSync(path.join(project, 'guarded.txt'), 'after'); f.mode('agent'); assert.match((await f.decide(view, 0, 'undo')).error, /Full Access/);
 f.mode('full'); f.busy(true); assert.match((await f.decide(view, 0, 'undo')).error, /idle/); f.busy(false);
 f.deny('guarded.txt'); assert.match((await f.preview('guarded.txt')).error, /protected/); f.deny('');
 view = await f.preview('guarded.txt'); f.messages.push({ id: 'newer', turn: { edits: [{ path: 'guarded.txt' }] } }); assert.match((await f.decide(view, 0, 'undo')).error, /newer change/);
});

test('empty file creation and deletion keep absence distinct from empty content; failed saves roll back', async () => {
 const f = hunkFixture(); f.seed('empty.txt', null, '');
 let view = await f.preview('empty.txt'); view = await f.decide(view, 0, 'undo'); assert.equal(fs.existsSync(path.join(project, 'empty.txt')), false);
 view = await f.decide(view, 0, 'redo'); assert.equal(fs.readFileSync(path.join(project, 'empty.txt'), 'utf8'), '');
 f.seed('deleted.txt', '', null, 'u2'); view = await f.preview('deleted.txt', 'u2'); view = await f.decide(view, 0, 'undo'); assert.equal(fs.readFileSync(path.join(project, 'deleted.txt'), 'utf8'), '');
 view = await f.decide(view, 0, 'redo'); assert.equal(fs.existsSync(path.join(project, 'deleted.txt')), false);
 f.seed('rollback.txt', 'old', 'new', 'u3'); view = await f.preview('rollback.txt', 'u3'); const save = f.checkpoints.save;
 f.checkpoints.save = () => { throw Error('disk full fixture'); }; const result = await f.decide(view, 0, 'undo'); f.checkpoints.save = save;
 assert.match(result.error, /disk full/); assert.equal(fs.readFileSync(path.join(project, 'rollback.txt'), 'utf8'), 'new'); assert.equal(f.checkpoints.load('s', 'u3').files['rollback.txt'].undone, undefined);
 f.seed('large.txt', 'old', 'x'.repeat(17000), 'u4'); view = await f.preview('large.txt', 'u4'); assert.equal(view.hunks[0].truncated, true); assert.match((await f.decide(view, 0, 'undo')).error, /too large/); assert.equal(fs.readFileSync(path.join(project, 'large.txt'), 'utf8').length, 17000);
});

test('comparison runs share one frozen base and budget, persist results, and require explicit exact-diff apply', async () => {
 const saved = { create: wt.createWorktree, list: wt.listWorktrees, remove: wt.removeWorktree, exec: cp.execFile }, registered = [], revisions = [], commands = [];
 let head = 'a'.repeat(40), serial = 0;
 wt.createWorktree = async (_root, _description, revision) => { revisions.push(revision); head = 'b'.repeat(40); const dir = path.join(project + '.worktrees', 'compare-' + ++serial); fs.mkdirSync(dir, { recursive: true }); const entry = { path: dir, branch: 'fixture/' + serial, head: revision, main: false }; registered.push(entry); return entry; };
 wt.listWorktrees = async () => registered; wt.removeWorktree = async (_root, dir) => removeFixture(dir);
 cp.execFile = (_exe, args, options, callback) => {
  commands.push(args); let text = '', input = '';
  const target = path.join(options.cwd, 'candidate.txt');
  if (args[0] === 'rev-parse') text = args.includes('--show-toplevel') ? options.cwd : registered.find(r => r.path === options.cwd)?.head || head;
  else if (args[0] === 'ls-files' && fs.existsSync(target)) text = 'candidate.txt\0';
  else if (args.includes('--no-index')) text = JSON.stringify({ content: fs.readFileSync(target, 'utf8') });
  else if (args.includes('--numstat')) text = '1\t0\tcandidate.txt\n';
  queueMicrotask(() => { if (args[0] === 'apply' && !args.includes('--check') && !args.includes('--numstat')) fs.writeFileSync(target, JSON.parse(input).content); callback(null, text, ''); });
  return { stdin: { end: value => input = value } };
 };
 const storage = path.join(base, 'comparison-storage'), pool = new WriterPool(() => {}); pool.configure(storage, project);
 const budgets = new TaskBudgets(), sent = [], roots = new Set(), recordings = [];
 const settings = { ...DEFAULT_SETTINGS, sandbox: 'off', commandTool: false, denyPaths: '' };
 const provider = { id: 'p', name: 'Fixture', apiFormat: 'openai', baseUrl: 'http://fixture.invalid', enabled: true, models: ['one', 'two'].map(id => ({ id, enabled: true })) };
 const store = { getMode: () => 'full', getSettings: () => settings, list: async () => [provider], getApiKey: async () => 'fixture-api-key-must-not-persist' };
 const ctx = { store, postAll: m => sent.push(m), sendState: async () => {}, status() {} }, surface = { kind: 'chat', post: m => sent.push(m) };
 let current = 's';
 const deps = { pool, budgets, storage, extension: path.resolve(__dirname, '..'), root: () => project, session: () => current, busy: () => false, scheduler: new ToolScheduler(), hooks: () => [], approve: async () => false,
  record: async (_id, before) => recordings.push(before), callModel: async (_provider, _key, o) => {
   roots.add(budgets.resolve(o.requestContext).id);
   if (!o.messages.some(m => m.role === 'tool')) return { text: '', toolCalls: [{ id: 'write-' + o.model, name: 'write_file', arguments: JSON.stringify({ path: 'candidate.txt', content: o.model }) }] };
   o.onAttempt?.({ id: 'attempt-' + o.model, model: o.model, startedAt: Date.now(), durationMs: 1, outcome: 'completed', format: 'openai', cost: undefined, usage: { input: 10, output: 2, inputReported: true, outputReported: true } });
   return { text: 'Candidate ' + o.model, toolCalls: [] };
  } };
 const host = new ModelComparisonsHost(ctx, deps);
 try {
  await host.handle(surface, { type: 'comparisonStart', sessionId: 's', prompt: 'Create candidate.txt', models: ['p::one', 'p::one'] }); assert.match(sent.at(-1).error, /distinct/); assert.equal(pool.jobs.size, 0);
  await host.handle(surface, { type: 'comparisonStart', sessionId: 's', prompt: 'Create candidate.txt', models: ['p::one', 'p::two'] });
  for (let n = 0; n < 200 && host.busy; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(host.busy, false); assert.deepEqual(revisions, ['a'.repeat(40), 'a'.repeat(40)]); assert.equal(roots.size, 1); assert.equal(fs.existsSync(path.join(project, 'candidate.txt')), false);
  const jobs = [...pool.jobs.values()]; assert(jobs.every(j => j.status === 'done'), JSON.stringify(jobs.map(j => j.error)));
  assert.notEqual(jobs[0].dir, jobs[1].dir); assert.equal(fs.readFileSync(path.join(jobs[0].dir, 'candidate.txt'), 'utf8'), 'one'); assert.equal(fs.readFileSync(path.join(jobs[1].dir, 'candidate.txt'), 'utf8'), 'two');
  await assert.rejects(pool.merge(jobs[0].id, project, () => {}), /Compare models/);
  const restored = new ModelComparisonsHost(ctx, deps); await restored.handle(surface, { type: 'comparisonList', sessionId: 's' });
  let group = sent.at(-1).groups[0]; assert.equal(group.candidates.length, 2); assert.equal(group.candidates[0].unknownCost, true); assert.equal(group.candidates[0].dir, jobs[0].dir); assert.equal(group.active, false);
  await restored.handle(surface, { type: 'comparisonReview', sessionId: 's', groupId: group.id, id: jobs[0].id, action: 'apply' }); assert.match(sent.at(-1).error, /View the candidate diff/);
  const preview = async () => { await restored.handle(surface, { type: 'comparisonReview', sessionId: 's', groupId: group.id, id: jobs[0].id, action: 'diff' }); return sent.at(-1); };
  let view = await preview(); fs.writeFileSync(path.join(jobs[0].dir, 'candidate.txt'), 'changed');
  await restored.handle(surface, { type: 'comparisonReview', sessionId: 's', groupId: group.id, id: jobs[0].id, action: 'apply', reviewId: view.reviewId }); assert.match(sent.at(-1).error, /changed during approval/); assert.equal(fs.existsSync(path.join(project, 'candidate.txt')), false);
  view = await preview(); await restored.handle(surface, { type: 'comparisonReview', sessionId: 's', groupId: group.id, id: jobs[0].id, action: 'apply', reviewId: view.reviewId });
  assert.equal(fs.readFileSync(path.join(project, 'candidate.txt'), 'utf8'), 'changed'); assert.equal(recordings.length, 1); assert.equal(recordings[0].get('candidate.txt'), null); assert.equal(fs.existsSync(jobs[1].dir), true);
  const otherWindow = new ModelComparisonsHost(ctx, deps); await otherWindow.handle(surface, { type: 'comparisonList', sessionId: 's' }); group = sent.at(-1).groups[0]; assert.equal(group.applied, jobs[0].id);
  current = 'other'; await restored.handle(surface, { type: 'comparisonReview', sessionId: 's', groupId: group.id, id: jobs[1].id, action: 'diff' }); assert.match(sent.at(-1).error, /another chat/);
  assert(!commands.some(args => args.includes('commit') || args[0] === 'add' || args.includes('--index')));
  const files = fs.readdirSync(path.join(storage, 'comparisons'), { recursive: true }).filter(n => n.endsWith('.json'));
  assert(files.length); for (const file of files) assert(!fs.readFileSync(path.join(storage, 'comparisons', file), 'utf8').includes('fixture-api-key'));
  current = 's'; let waiting = 0;
  deps.callModel = async (_provider, _key, options) => { waiting++; return new Promise((_resolve, reject) => { const abort = () => reject(Error('Stopped fixture')); if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true }); }); };
  const stopping = new ModelComparisonsHost(ctx, deps);
  await stopping.handle(surface, { type: 'comparisonStart', sessionId: 's', prompt: 'Wait for cancellation', models: ['p::one', 'p::two'] });
  for (let n = 0; n < 100 && waiting < 2; n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(waiting, 2);
  const collision = new ModelComparisonsHost(ctx, deps);
  await collision.handle(surface, { type: 'comparisonStart', sessionId: 's', prompt: 'Another window', models: ['p::one', 'p::two'] }); assert.match(sent.at(-1).error, /Another window/);
  const activeGroup = sent.filter(m => m.type === 'comparisonState').at(-1).groups.find(g => g.prompt === 'Wait for cancellation');
  await stopping.handle(surface, { type: 'comparisonStop', sessionId: 's', groupId: activeGroup.id });
  for (let n = 0; n < 100 && stopping.busy; n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(stopping.busy, false);
  assert([...pool.jobs.values()].filter(j => j.comparisonId === activeGroup.id).every(j => j.status === 'failed' && fs.existsSync(j.dir)));
  const calls = waiting; new ModelComparisonsHost(ctx, deps); assert.equal(waiting, calls, 'reopening comparisons never runs a model');
 } finally { host.dispose(); budgets.dispose(); wt.createWorktree = saved.create; wt.listWorktrees = saved.list; wt.removeWorktree = saved.remove; cp.execFile = saved.exec; removeFixture(project + '.worktrees'); }
});

test('a comparison recommends only a finished candidate whose recorded checks all passed', () => {
	const { recommendCandidate } = require(path.join(out, 'host/modelComparisons'));
	const c = (id, o = {}) => ({ id, spec: 'p::' + id, status: 'done', cost: 0.1, unknownCost: false, elapsedMs: 1000, stat: { files: 1, added: 5, removed: 1 }, checks: [{ status: 'passed' }], ...o });
	assert.equal(recommendCandidate([c('a', { checks: [] }), c('b', { checks: [{ status: 'failed' }] })]), undefined, 'no passing check: no recommendation');
	assert.equal(recommendCandidate([c('a', { checks: [{ status: 'passed', stale: true }] })]), undefined, 'stale evidence does not count');
	assert.equal(recommendCandidate([c('a', { status: 'failed' }), c('b', { stat: { files: 0, added: 0, removed: 0 } })]), undefined, 'failed or empty runs do not count');
	assert.deepEqual(recommendCandidate([c('a', { checks: [] }), c('b')]), { id: 'b', reason: 'its check passed · the only candidate with passing checks' });
	assert.deepEqual(recommendCandidate([c('a', { cost: 0.3 }), c('b', { cost: 0.1 })]), { id: 'b', reason: 'its check passed · lowest cost' });
	assert.deepEqual(recommendCandidate([c('a', { unknownCost: true, stat: { files: 1, added: 1, removed: 0 } }), c('b', { unknownCost: true })]), { id: 'a', reason: 'its check passed · smallest change' });
	assert.equal(recommendCandidate([c('a', { checks: [{ status: 'passed' }, { status: 'failed' }] }), c('b', { checks: [{ status: 'passed' }, { status: 'passed' }] })]).id, 'b');
});

test('review dialogs preserve composer drafts and require distinct model choices and explicit hunk actions', () => {
 const dom = new JSDOM('<input id="composer" value="keep my draft">', { url: 'https://fixture.invalid' }), { window } = dom, document = window.document, posted = [];
 window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
 window.HTMLDialogElement.prototype.close = function() { this.open = false; this.dispatchEvent(new window.Event('close')); };
 window.HTMLElement.prototype.scrollIntoView = function() {};
 const state = { currentSessionId: 's', providers: [{ id: 'p', name: 'Provider', enabled: true, apiFormat: 'openai', models: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }] }] };
	const markdown = { window: {} };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8'), markdown);
 const context = vm.createContext({ document, window, FormData: window.FormData, state, el: { input: document.querySelector('input') }, post: m => posted.push(m), toast: m => posted.push(m), I: () => '', esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), h: (tag, className) => { const node = document.createElement(tag); node.className = className; return node; } });
	context.esc = markdown.window.Markdown.escape;
 // The review dialogs are their own page script (chat-review.js), created the way chat.js creates them.
 vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/chat-review.js'), 'utf8'), context);
 context.api = window.ChatReview.create({ I: context.I, el: context.el, esc: context.esc, h: context.h, post: context.post, state, toast: context.toast });
 assert.match(require('./page-scripts').readPage('chat.js'), /window\.ChatReview\.create\(\{ I, el, esc, h, post, state, toast \}\)/, 'chat.js creates them with the same dependencies');
 document.querySelector('input').focus(); context.api.openComparisons(); assert.equal(posted.at(-1).type, 'comparisonList');
 const form = document.querySelector('form'); form.elements.namedItem('prompt').value = 'Task'; form.elements.namedItem('model0').value = 'p::a'; form.elements.namedItem('model1').value = 'p::a'; form.dispatchEvent(new window.Event('submit', { cancelable: true })); assert.match(document.querySelector('[data-comparison-error]').textContent, /distinct/);
 form.elements.namedItem('model1').value = 'p::b'; form.dispatchEvent(new window.Event('submit', { cancelable: true })); assert.equal(posted.at(-1).type, 'comparisonStart'); assert.deepEqual(Array.from(posted.at(-1).models), ['p::a', 'p::b']);
	context.api.comparisonMessage({ type: 'comparisonDiff', sessionId: 's', groupId: 'group', id: 'candidate', files: ['file.txt'], patch: '+safe diff', reviewId: 'candidate-review', applied: false, truncated: false });
	assert(document.querySelector('[data-comparison-action="apply"]'), 'a real diff count renders with the production escape helper');
	document.querySelector('[data-comparison-action="apply"]').click();
	assert.equal(posted.at(-1).type, 'comparisonReview'); assert.equal(posted.at(-1).reviewId, 'candidate-review'); assert.equal(posted.at(-1).action, 'apply');
 document.querySelector('dialog').close(); assert.equal(document.querySelector('input').value, 'keep my draft'); assert.equal(document.activeElement.id, 'composer');
 const trigger = document.createElement('button'); trigger.dataset.hunkReview = 'u1'; trigger.dataset.path = 'file.txt'; document.body.append(trigger); trigger.click();
 context.api.showHunkReview({ sessionId: 's', path: '<script>bad</script>', reviewId: 'review', hunks: [{ index: 0, line: 1, before: 'old', after: '<img src=x onerror=bad()>', kept: false, undone: false }] });
 assert.equal(document.querySelectorAll('script,img').length, 0); document.querySelector('[data-hunk-action="undo"]').click(); assert.equal(posted.at(-1).action, 'undo'); assert.equal(posted.at(-1).reviewId, 'review');
 context.api.showHunkReview({ sessionId: 's', error: 'File changed' }); assert.equal(document.querySelector('[data-hunk-action]').disabled, false);
 document.querySelector('dialog').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); assert.equal(document.querySelector('dialog'), null); dom.window.close();
});
