'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) { return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: { env: {}, workspace: {} } };
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { ProviderStore } = require(path.join(OUT, 'providerStore'));
const { streamAcp, closeAcpAgents } = require(path.join(OUT, 'acp/stream'));
const { setAcpRuntime } = require(path.join(OUT, 'acp/runtime'));
const { sharedGlobalMemento } = require('../../host/storage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-model-switching-'));
const context = state => ({ globalState: state, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } });
const message = text => ({ id: 'u-' + text, role: 'user', content: text });

async function selections() {
 const file = path.join(tmp, 'state.json');
 const store = new ProviderStore(context(sharedGlobalMemento(file)));
 const a = await store.add({ name: 'A', enabled: true, baseUrl: 'https://a.example/v1', models: [{ id: 'same-id', enabled: true }] });
 const b = await store.add({ name: 'B', enabled: true, baseUrl: 'https://b.example/v1', models: [{ id: 'same-id', enabled: true }] });
 const first = await store.currentSessionId();
 await store.setSelection(a.id, 'same-id', first);
 await store.saveMessages(first, [message('first')]);
 const second = await store.createSession();
 assert.equal((await store.resolveSelection(second.id)).provider.id, a.id, 'new chats inherit the current choice');
 await store.setSelection(b.id, 'same-id', second.id);
 await store.saveMessages(second.id, [message('second')]);
 assert.equal((await store.resolveSelection(first)).provider.id, a.id, 'identical model ids on other providers cannot change the first chat');
 const restarted = new ProviderStore(context(sharedGlobalMemento(file)));
 await restarted.setCurrentSession(first);
 assert.equal((await restarted.resolveSelection()).provider.id, a.id, 'per-chat choice survives reopening');
 await store.setCurrentSession(second.id);
 assert.equal((await store.resolveSelection()).provider.id, b.id, 'another window keeps its own current chat');
 const fork = await restarted.forkSession(first);
 assert.equal((await restarted.resolveSelection(fork.id)).provider.id, a.id, 'forks inherit the source chat choice');
 await store.update(a.id, { enabled: false });
 assert.equal((await restarted.resolveSelection(first)).provider.id, b.id, 'disabled provider falls back to a usable model');
 await store.update(a.id, { enabled: true });
 await restarted.setModelFavorite(a.id, 'same-id', true);
 await store.setModelFavorite(b.id, 'same-id', true);
 assert.equal(restarted.getModelPreferences().favorites.length, 2, 'favorites from both project windows survive');
 await restarted.setModelFavorite(a.id, 'same-id', false);
 assert.deepEqual(store.getModelPreferences().favorites, [{ providerId: b.id, model: 'same-id' }]);
 await assert.rejects(store.setModelFavorite(b.id, 'missing', true), /no longer exists/);
 await store.upsertModel(b.id, { id: 'renamed', enabled: true }, 'same-id');
 assert.equal((await store.resolveSelection(second.id)).model.id, 'renamed', 'renaming updates every chat that selected that provider/model');
 assert.equal((await restarted.resolveSelection(first)).model.id, 'same-id', 'same ids on other providers are untouched');
 assert.equal(store.getModelPreferences().favorites[0].model, 'renamed');
 await store.removeModel(b.id, 'renamed');
 assert.equal(store.getModelPreferences().favorites.length, 0, 'deleted models leave favorites');
 const many = await store.add({ name: 'Many', models: Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, enabled: true })) });
 for (let i = 0; i < 12; i++) await store.setSelection(many.id, 'm' + i, second.id);
 await store.setSelection(many.id, 'm7', second.id);
 const recent = store.getModelPreferences().recent;
 assert.equal(recent.length, 8); assert.equal(recent[0].model, 'm7');
 assert.equal(new Set(recent.map(s => JSON.stringify([s.providerId, s.model]))).size, 8, 'recent choices stay bounded and unique');
 const legacyState = sharedGlobalMemento(path.join(tmp, 'legacy.json'));
 await legacyState.update('aiChat.providers', await store.list());
 await legacyState.update('aiChat.selectedProviderId', b.id);
 await legacyState.update('aiChat.selectedModel', 'same-id');
 await legacyState.update('aiChat.sessions', [{ id: 'legacy', title: 'Old', updatedAt: 1, messages: [{ ...message('old'), turn: { startedAt: 1, providerId: a.id, model: 'same-id' } }] }]);
 const legacy = new ProviderStore(context(legacyState));
 assert.equal((await legacy.resolveSelection('legacy')).provider.id, a.id, 'legacy chats migrate from their own last turn');
 console.log('PASS: chat selections persist across windows/restarts/forks; legacy migration, disabled providers, favorites and bounded recent choices.');
}

async function handoff() {
 const received = [], connections = [];
 setAcpRuntime({
  entry: async id => ({ id, name: id }),
  connect: async (entry, handlers) => {
   const id = entry.id + '-' + connections.length;
   const conn = {
    alive: true, capabilities: {}, agentName: entry.id,
    newSession: async () => ({ sessionId: id }),
    close() { conn.alive = false; }, cancel() {},
    async prompt(sessionId, blocks) {
     const text = blocks.map(b => b.text || '').join('\n');
     received.push({ agent: entry.id, sessionId, text });
     if (text.endsWith('FAIL_PROMPT')) throw new Error('fixture failure');
     if (text.endsWith('CANCEL_PROMPT')) return { stopReason: 'cancelled' };
     handlers.sessionUpdate(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: entry.id + ' answer ' + received.length } });
     return { stopReason: 'end_turn' };
    }
   };
   connections.push(conn); return conn;
  }
 });
 const histories = new Map();
 const options = (agent, chat, messages) => ({ baseUrl: 'acp:' + agent, providerId: agent, apiKey: '', model: '', apiFormat: 'acp', system: '', messages, signal: new AbortController().signal,
  acp: { cwd: tmp, chatId: chat, permission: async () => false, readFile: async () => '', writeFile: async () => {}, tool() {} } });
 async function turn(agent, text, chat = 'main') {
  const history = histories.get(chat) || []; histories.set(chat, history);
  history.push({ role: 'user', content: text });
  const result = await streamAcp(options(agent, chat, [...history]));
  history.push({ role: 'assistant', content: result.text });
  return received.at(-1);
 }
 try {
  await turn('A', 'Remember APPLE');
  await turn('B', 'Only B knows BANANA');
  let back = await turn('A', 'What changed?');
  assert.match(back.text, /BANANA/); assert(!back.text.includes('Remember APPLE'), 'A does not replay its own turns');
  assert.equal(connections.length, 2); assert.equal(back.sessionId, 'A-0', 'A resumes only its own native session');
  back = await turn('A', 'Continue'); assert.equal(back.text, 'Continue', 'catch-up is delivered exactly once');
  back = await turn('B', 'Your turn'); assert.match(back.text, /What changed\?/); assert.match(back.text, /Continue/); assert(!back.text.includes('BANANA'));
  const isolated = await turn('A', 'Separate chat', 'other');
  assert.equal(isolated.text, 'Separate chat'); assert.notEqual(isolated.sessionId, 'A-0');
  histories.get('main')[0].content = 'Corrected history: PEAR';
  back = await turn('A', 'Use the correction'); assert.match(back.text, /PEAR/); assert.notEqual(back.sessionId, 'A-0', 'edited history cannot reuse a native session with obsolete context');
  const main = histories.get('main'); main.push({ role: 'tool', name: 'write_file', toolCallId: 'foreign', content: 'Foreign edit saved to result.txt' });
  back = await turn('B', 'Review the edit'); assert.match(back.text, /result\.txt/);
  const failureMessages = [{ role: 'user', content: 'FAIL_PROMPT' }];
  await assert.rejects(streamAcp(options('A', 'retry', failureMessages)), /fixture failure/);
  const failedSession = received.at(-1).sessionId;
  await streamAcp(options('A', 'retry', [{ role: 'user', content: 'Retry safely' }]));
  assert.notEqual(received.at(-1).sessionId, failedSession, 'failed prompts retire uncertain native history');
  await assert.rejects(streamAcp(options('A', 'cancel', [{ role: 'user', content: 'CANCEL_PROMPT' }])), error => error.name === 'AbortError');
  assert.equal(connections.at(-1).alive, false, 'cancellation retires the partial native session');
  closeAcpAgents();
  const seed = [{ role: 'user', content: 'old context' }, { role: 'assistant', content: 'old answer' }, { role: 'user', content: 'After restart' }];
  await streamAcp(options('A', 'main', seed)); assert.match(received.at(-1).text, /old context/);
  console.log('PASS: A → B → A catch-up, native-session ownership, no repeated history, chat isolation, edits, tool results, failures, cancellation and restart reconstruction.');
 } finally { closeAcpAgents(); setAcpRuntime(undefined); }
}

(async () => {
 try { await selections(); await handoff(); }
 finally { for (const file of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, file)); fs.rmdirSync(tmp); }
})().catch(error => { console.error(error); process.exitCode = 1; });
