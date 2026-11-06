'use strict';
const assert = require('assert'), fixture = require('./model-browser-fixture');

function chatModelPicker() {
 const vm = require('node:vm'), ts = require('typescript-classic'), { JSDOM } = require('jsdom');
 const source = require('./page-scripts').readPage('chat.js');
 const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
 const names = new Set(['h', 'item', 'renderModelMenu']), declarations = [];
 const visit = node => { if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) declarations.push(node.getText(ast)); ts.forEachChild(node, visit); };
 visit(ast); assert.equal(declarations.length, names.size);
 const dom = new JSDOM('<body><div id="model-menu"></div></body>'), document = dom.window.document;
 const state = { providers: [
  { id: 'local', name: 'zer0ne Engine', preset: 'zer0ne-engine', enabled: true, models: [{ id: 'qwen-chat', name: 'Qwen Chat', enabled: true }] },
  { id: 'api', name: 'Connected API', enabled: true, models: Array.from({ length: 7 }, (_, i) => ({ id: 'api-' + i, name: 'API ' + i, enabled: true })) }
 ], selection: { providerId: 'local', model: 'qwen-chat' }, currentSessionId: 'chat-picker', isStreaming: false };
 const ui = { modelQuery: '', modelProvider: 'media:image', engine: { running: true, model: 'qwen-chat' }, studio: {
  supported: true, bundles: [{ id: 'image-ready', name: 'Test Image', kind: 'image', installed: true }, { id: 'video-download', name: 'Test Video', kind: 'video', installed: false }],
  voices: [{ id: 'voice-ready', name: 'Test Voice', kind: 'voice', installed: true }]
 } };
 const posts = [], settings = [], el = { modelMenu: document.getElementById('model-menu') };
 const context = vm.createContext({ document, state, ui, el, post: m => posts.push(m), saveUi() {}, closeMenus() {}, openSettings: tab => settings.push(tab),
  esc: text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]), I: () => '<svg></svg>', t: key => key, fmtTokens: String });
 vm.runInContext(declarations.join('\n'), context);
 const render = () => context.renderModelMenu();
 const noMedia = () => { assert(!el.modelMenu.querySelector('.mm-media, .mm-get')); assert(!/Local · Image|Image · Local|Video · Local|Voice · Local|Test Image|Test Video|Test Voice/.test(el.modelMenu.textContent)); };
 render(); noMedia();
 assert.deepEqual([...el.modelMenu.querySelectorAll('.mm-name')].map(n => n.textContent), ['zer0ne Engine', 'Connected API'], 'chat providers survive a stale media group selection');
 el.modelMenu.querySelector('.mm-provider').click(); noMedia();
 assert.match(el.modelMenu.textContent, /Qwen Chat.*loaded/);
 el.modelMenu.querySelector('.model-item').click();
 assert.deepEqual(JSON.parse(JSON.stringify(posts.pop())), { type: 'selectModel', providerId: 'local', model: 'qwen-chat', sessionId: 'chat-picker' });
 assert(!posts.some(m => m.type === 'catalogGet' || m.type === 'studioState'), 'opening chat models does not fetch a media catalog');
 ui.modelQuery = 'Test Image'; render(); noMedia(); assert.equal(el.modelMenu.querySelectorAll('.model-item').length, 0, 'search stays scoped to chat models');
 ui.modelQuery = 'Qwen'; render(); assert.equal(el.modelMenu.querySelectorAll('.model-item').length, 1);
 ui.modelQuery = ''; ui.modelProvider = null;
 state.modelPreferences = { favorites: [{ providerId: 'api', model: 'api-2' }], recent: [{ providerId: 'api', model: 'api-2' }, { providerId: 'local', model: 'qwen-chat' }] };
 render(); assert.match(el.modelMenu.textContent, /Favorites/);
 assert(!el.modelMenu.textContent.includes('Recently used'));
 assert.equal(el.modelMenu.querySelectorAll('.model-item').length, 1, 'only starred models appear above the provider list');
 assert(!el.modelMenu.querySelector('.mdp-foot'), 'the fixed current-model summary is absent');
 el.modelMenu.querySelector('.model-item[data-provider="api"][data-model="api-2"]').click();
 assert.deepEqual(JSON.parse(JSON.stringify(posts.pop())), { type: 'selectModel', providerId: 'api', model: 'api-2', sessionId: 'chat-picker' }, 'a favorite switches provider and model together for this chat');
 state.modelPreferences = { favorites: [], recent: [] };
 ui.modelQuery = ''; state.providers = state.providers.slice(0, 1); render(); noMedia();
 assert.equal(el.modelMenu.querySelectorAll('.model-item').length, 1, 'one chat provider opens directly despite installed media models');
 el.modelMenu.querySelector('.mm-favorite').click();
 assert.deepEqual(JSON.parse(JSON.stringify(posts.pop())), { type: 'setModelFavorite', providerId: 'local', model: 'qwen-chat', favorite: true });
 assert.equal(posts.length, 0, 'starring never selects or sends a model');
 state.modelPreferences = { favorites: [{ providerId: 'local', model: 'qwen-chat' }], recent: [{ providerId: 'local', model: 'qwen-chat' }, { providerId: 'gone', model: 'missing' }] };
 render(); assert.match(el.modelMenu.textContent, /Favorites/); assert(!/Recently used/.test(el.modelMenu.textContent), 'recent choices never appear in the picker');
 assert.equal(el.modelMenu.querySelector('.mm-favorite').getAttribute('aria-pressed'), 'true');
 el.modelMenu.querySelector('.mm-favorite').click(); assert.equal(posts.pop().favorite, false);
 state.providers[0].models[0].enabled = false; render(); assert(!/Favorites/.test(el.modelMenu.textContent), 'disabled favorites cannot be picked');
 state.providers = []; render(); noMedia(); assert.match(el.modelMenu.textContent, /setupProvider/);
 const actions = [...el.modelMenu.querySelectorAll('.menu-item')]; actions[0].click(); actions[1].click(); assert.deepEqual(settings, ['models', 'usage']);
 dom.window.close();
}

(async () => {
 chatModelPicker();
 const { context, S, L, dom } = fixture();
 const runtime = context.runtimesTab(L), section = id => runtime.querySelector('[data-runtime-section="' + id + '"]');
 const options = section('engine'), connections = section('connections'), host = section('host'), assistant = section('assistant');
 assert(options && !options.open); assert(connections && !connections.open);
 assert(host && !host.open, 'Local Host is folded away under Engine'); assert(assistant && !assistant.open, 'so is the local assistant');
 assert(host.contains(runtime.querySelector('#lh-enabled'))); assert(!connections.contains(runtime.querySelector('#lh-enabled')));
 assert(!runtime.querySelector('#lh-enabled').checked, 'off by default'); assert(assistant.contains(runtime.querySelector('#lv-helper')));
 assert(options.contains(runtime.querySelector('#eng-context'))); assert(options.contains(runtime.querySelector('[data-act="engine-channel"]')));
 assert(!options.contains(runtime.querySelector('[data-act="engine-install"]')));
 assert(connections.contains(runtime.querySelector('#local-tag')));
 L.installed = [{ tag: 'qwen3:4b' }]; assert(context.runtimesTab(L).querySelector('.ollama-models [data-act="local-use"][data-tag="qwen3:4b"]'), 'installed Ollama models can be used in the chat from Engine'); L.installed = [];
 assert(runtime.querySelector('#eng-lightkv').checked);
 assert(runtime.querySelector('#eng-firsttest').checked);
 L.engine.testing = { stage: 'Measuring' }; const checking = context.runtimesTab(L);
 assert(checking.querySelector('[data-act="engine-test-cancel"]')); assert(!checking.querySelector('[data-act="engine-tune"]')); delete L.engine.testing;
 options.open = true; await new Promise(r => dom.window.setTimeout(r, 10));
 assert.equal(S.runtimeSections.engine, true); assert(context.runtimesTab(L).querySelector('[data-runtime-section="engine"]').open);

 // Activity: the engine's state, what is loaded, live numbers, downloads, what is on this computer.
 let act = context.activityTab(L, []);
 assert(act.querySelector('.act-status.ready')); assert(act.querySelector('[data-local-tab="runtimes"]'));
 assert(act.querySelector('.act-now.idle') && act.querySelector('.act-now [data-act="mfs-back"]'), 'nothing loaded: find a model');
 assert(act.querySelector('#lv-live'), 'the live monitor');
 assert(act.querySelector('.act-dl .act-note'), 'no downloads');
 assert.equal(act.querySelectorAll('.act-lib .act-stat').length, 4);
 L.gguf = [{ id: 'Qwen3-1.7B-Q4_K_M', sizeBytes: 1.1e9 }, { id: '<b>odd</b>', sizeBytes: 2e9 }];
 act = context.activityTab(L, []);
 assert.equal(act.querySelectorAll('.act-now [data-act="engine-load"]').length, 2, 'recent models can be loaded here'); assert(!act.querySelector('.act-now b b'), 'names are text');
 L.gguf[0].loaded = true; L.engine.running = true; L.engine.model = 'Qwen3-1.7B-Q4_K_M'; L.engine.run = { ctx: 16384 };
 act = context.activityTab(L, [{ key: 'studio:sd15', label: 'SD 1.5', stage: 'Downloading', received: 5e8, total: 1e9 }]);
 assert(act.querySelector('.act-status.on')); assert.equal(act.querySelector('.act-model').textContent, 'Qwen3-1.7B-Q4_K_M');
 assert(act.querySelector('[data-act="local-chat"]') && act.querySelector('[data-act="engine-stop"]'));
 assert(act.querySelector('.act-dl .pull-row[data-job="studio:sd15"]')); assert.equal(act.querySelector('.act-dl .pull-bar > span').style.width, '50%');
 dom.window.close(); console.log('Engine & more UI passed: folded engine options, Local Host and assistant under Engine, and the Activity view.');
})().catch(e => { console.error(e); process.exitCode = 1; });
