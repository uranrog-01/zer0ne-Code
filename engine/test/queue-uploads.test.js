// Execute the production controller methods without starting a model or other hosts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript-classic');
const source = fs.readFileSync(path.join(__dirname, '../src/chatController.ts'), 'utf8');
const ast = ts.createSourceFile('chatController.ts', source, ts.ScriptTarget.Latest, true);
const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name.text === 'ChatController');
const names = ['onSend', 'handleSend', 'retry', 'switchSession', 'refreshDesktop', 'cancelRun'];
const methods = names.map(name => cls.members.find(n => n.name?.getText(ast) === name).getText(ast));
const code = ts.transpileModule('class Controller { ' + methods.join('\n') + ' }; globalThis.Controller = Controller;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function setup(mode = 'queue') {
 let id = 0;
 const context = vm.createContext({ Set, Date, AbortController, workspaceRoot: () => ({ scheme: 'file', fsPath: '/repo' }), normalizeProjectPath: x => x, projectPathKey: x => x, newId: () => 'id-' + ++id, extractUrls: () => [], expandCommand: () => '', runHooks: async () => ({ blocked: true, feedback: 'Blocked' }) });
 vm.runInContext(code, context);
 const c = new context.Controller();
 const drafts = { items: [], clear() { this.items = []; } };
 Object.assign(c, { comparisons: { mutating: false }, hunks: { busy: false }, sessionId: 'chat-a', queue: [], sessionQueues: new Map(), messages: [], attachments: drafts, promptStops: new Set(), approvals: new Map(), questions: new Map(), run: { steer: [], convo: [] }, imageCache: new Map(), ready: Promise.resolve(),
  store: { getSettings: () => ({ followUp: mode }), resolveSelection: async () => ({}), getSession: async () => ({ projectPath: '/repo' }), setCurrentSession: async id => { c.sessionId = id; } },
  mods: { hasListeners: () => false, modCommands: () => [] }, plugins: { commands: () => [] },
  runLocalCommand: async () => false, runGoalCommand: async () => false, runSkillCommand: async () => false, sendState: async () => {}, scheduleState() {}, cancelRun() {}, status() {},
  checkReady: async () => undefined, resolveMentions: async () => [], skillMentionNames: () => new Set(), resolveSkillMentions: () => '', resolvePinnedSkills: async () => ({ text: '', names: new Set() }), resolveSuggestedSkills: () => '', allHooks: () => [], persistImages: async () => {},
  pushError: async text => c.messages.push({ role: 'assistant', content: text, isError: true }), runTurn: async user => { c.lastUser = user; },
  warmer: { cancel() {} }, loadCurrent: async () => {}, agentRuns: { hasNotices: () => false }, urlProvenance: () => new Set()
 });
 return c;
}
const plain = value => JSON.parse(JSON.stringify(value));
const attachment = (id, name = id) => ({ id, name, kind: 'text', content: 'body-' + id });

test('review mutations cannot start a chat turn or consume its pending uploads', async () => {
 for (const feature of ['comparisons', 'hunks']) {
  const c = setup(); c.attachments.items.push(attachment('pending'));
  if (feature === 'comparisons') c.comparisons.mutating = true; else c.hunks.busy = true;
  await assert.rejects(c.onSend('Keep this request', false), /review action/);
  assert.equal(c.queue.length, 0); assert.equal(c.attachments.items[0].id, 'pending');
 }
});
test('Stop cancels every overlapping prompt preparation before it can start a model turn', async () => {
 const c = setup(), waiting = []; c.run = undefined;
 c.resolveMentions = async () => await new Promise(resolve => waiting.push(resolve));
 const first = c.handleSend('one', false), second = c.handleSend('two', false);
 while (waiting.length < 2) await Promise.resolve();
 const stops = [...c.promptStops]; assert.equal(stops.length, 2);
 Object.getPrototypeOf(c).cancelRun.call(c);
 assert.ok(stops.every(stop => stop.signal.aborted));
 for (const resolve of waiting) resolve([]);
 await Promise.all([first, second]); assert.equal(c.promptStops.size, 0); assert.equal(c.lastUser, undefined);
});
test('each queued message owns an immutable snapshot and new drafts remain separate', async () => {
 const c = setup(); const first = attachment('one'); c.attachments.items.push(first);
 await c.onSend('first', false); first.content = 'changed';
 assert.equal(c.attachments.items.length, 0); assert.equal(c.queue[0].attachments[0].content, 'body-one');
 c.attachments.items.push(attachment('two')); await c.onSend('second', true);
 c.attachments.items.push(attachment('draft')); c.run = undefined;
 for (const next of c.queue) await c.handleSend(next.text, next.plan, next.attachments);
 assert.deepEqual(c.messages.map(m => m.attachments), [['one'], ['two']]);
 assert.ok(c.messages[0].apiContent.includes('body-one')); assert.ok(!c.messages[0].apiContent.includes('body-two'));
 assert.deepEqual(plain(c.attachments.items), [attachment('draft')]);
});
test('attachment-only messages and steer/interrupt modes preserve uploads', async () => {
 for (const mode of ['queue', 'steer', 'interrupt']) {
  const c = setup(mode); c.attachments.items.push(attachment('one')); await c.onSend('', false);
  assert.equal(c.queue.length, 1); assert.equal(c.queue[0].attachments.length, 1); assert.equal(c.attachments.items.length, 0);
 }
 const c = setup('steer'); await c.onSend('text only', false); assert.equal(c.run.steer[0], 'text only'); assert.equal(c.queue.length, 0);
});

test('an interrupt takes priority while preserving earlier queued messages and uploads', async () => {
	const c = setup('interrupt'); c.queue.push({ id: 'older', text: 'Earlier queued task', attachments: [attachment('older-file')] });
	c.attachments.items.push(attachment('urgent-file')); await c.onSend('Urgent correction', false);
	assert.equal(c.queue.length, 2); assert.equal(c.queue[0].text, 'Urgent correction'); assert.equal(c.queue[1].text, 'Earlier queued task'); assert.deepEqual(plain(c.queue[1].attachments), [attachment('older-file')]);
});
test('queued images survive validation errors and retry without consuming a later draft', async () => {
 const c = setup(); c.run = undefined; c.checkReady = async () => 'No provider';
 const image = { id: 'image', name: 'shot.png', kind: 'image', mime: 'image/png', base64: 'aGVsbG8=' };
 c.attachments.items.push(attachment('later'));
 await c.handleSend('image message', false, [image]);
 const user = c.messages[0]; assert.deepEqual(Array.from(user.attachments), ['shot.png']);
 assert.equal(c.imageCache.get(user.id)[0].base64, image.base64); assert.equal(c.messages[1].isError, true);
 c.checkReady = async () => undefined; await c.retry(false); assert.equal(c.lastUser, user);
 assert.equal(c.attachments.items[0].id, 'later');
});
test('blocked hooks and pre-send failures restore queued uploads rather than silently dropping them', async () => {
 for (const reason of ['hook', 'throw']) {
  const c = setup(); c.run = undefined;
  if (reason === 'hook') c.allHooks = () => [{ enabled: true, event: 'UserPromptSubmit' }];
  else c.resolveMentions = async () => { throw new Error('read failed'); };
  c.attachments.items.push(attachment('draft'));
  if (reason === 'hook') await c.handleSend('blocked', false, [attachment('queued')]);
  else await assert.rejects(c.handleSend('blocked', false, [attachment('queued')]), /read failed/);
  assert.deepEqual(c.attachments.items.map(a => a.id), ['draft', 'queued']);
 }
});
test('switching sessions keeps queued uploads and leaves composer draft switching to loadCurrent', async () => {
 const c = setup(); c.attachments.items.push(attachment('draft')); c.queue.push({ attachments: [attachment('queued')] });
 await c.switchSession('chat-b'); assert.equal(c.attachments.items.length, 1); assert.equal(c.queue.length, 0);
	await c.switchSession('chat-a'); assert.deepEqual(plain(c.queue[0].attachments), [attachment('queued')]);
});
test('a session switch during preparation cannot deliver old queued uploads into the new chat', async () => {
 const c = setup(); c.run = undefined;
 c.resolveMentions = async () => { c.sessionId = 'chat-b'; return []; };
 await c.handleSend('old queued turn', false, [attachment('queued')]);
 assert.equal(c.messages.length, 0); assert.equal(c.attachments.items.length, 0);
});
test('retained desktop activation delivers one-time worktree prefill before state', async () => {
 const c = setup(), calls = []; c.worktreesHost = { handoff: async () => calls.push('handoff') }; c.sendState = async surface => calls.push(surface);
 const surface = {}; await c.refreshDesktop(surface); assert.deepEqual(calls, ['handoff', surface]);
});
test('state payload strips upload bodies and turn runner forwards snapshots only for its session', () => {
 assert.match(source, /queue: this\.queue\.map\(\(\{ attachments, \.\.\.item \}\)/);
 const runner = fs.readFileSync(path.join(__dirname, '../src/host/turnRunner.ts'), 'utf8');
 assert.match(runner, /run\.sessionId === this\.h\.sessionId\(\) \? this\.h\.nextQueued\(\) : undefined/);
 assert.match(runner, /handleSend\(next\.text, next\.plan, next\.attachments \?\? \[\]\)/);
});
