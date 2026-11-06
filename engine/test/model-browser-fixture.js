'use strict';
const fs = require('fs'), path = require('path'), ts = require('typescript-classic'), vm = require('vm');
const { JSDOM } = require('jsdom');
const { machineCapacity } = require('../out/localModels');

module.exports = () => {
 const ast = ts.createSourceFile('settings.js', require('./page-scripts').readPage('settings.js'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
 const functions = new Set(['runtimeDisclosure', 'runtimesTab', 'backendCompare', 'localHostCard', 'lmsCard', 'routingCard', 'activityTab', 'liveCard', 'paintLive', 'paintBars', 'fitBadge', 'jobBar', 'pullBar']);
 const variables = new Set(['FIT', 'gb', 'ctxLabel', 'LOCAL_SERVERS', 'eta', 'benchBtn']);
 const snippets = [];
 const visit = node => {
  if (ts.isFunctionDeclaration(node) && functions.has(node.name?.text)) snippets.push(node.getText(ast));
  if (ts.isVariableDeclaration(node) && variables.has(node.name?.text)) snippets.push('const ' + node.getText(ast) + ';');
  ts.forEachChild(node, visit);
 }; visit(ast);
 const dom = new JSDOM(''), document = dom.window.document, machine = machineCapacity({ platform: 'win32', cpu: 'Intel Core Ultra 9 285H', cores: 16, totalMemoryBytes: 32 * 1024 ** 3, gpuName: 'Intel Arc 140T', gpuMemoryBytes: 16 * 1024 ** 3, freeDiskBytes: 240e9 });
 const L = { machine, gguf: [], installed: [], engine: { installed: true, version: 'b11169', pin: 'b11169', backend: 'vulkan', autoBackend: 'vulkan', running: false, settings: { backend: 'auto', channel: 'tested', port: 8181, context: 0, gpu: 'auto', lightKv: true, speedBoost: true, helperSlot: true } }, servers: [{ id: 'ollama', name: 'Ollama', running: false }, { id: 'lmstudio', name: 'LM Studio', running: false }] };
 const S = { localModels: L, localJobs: {}, settings: {}, providers: [], studio: { bundles: [{ id: 'sd15', kind: 'image', installed: true }], voices: [] } };
 const context = { document, window: dom.window, S, post() {}, setTimeout: dom.window.setTimeout, $: id => document.getElementById(id), h: (tag, cls, html) => { const el = document.createElement(tag); if (cls) el.className = cls; if (html) el.innerHTML = html; return el; }, esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') };
 vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(__dirname, '../media/icons.js'), 'utf8'), context);
 context.I = context.window.Icons.svg;
 vm.runInContext(snippets.join('\n') + '\nObject.assign(globalThis, { runtimesTab, activityTab });', context);
 return { context, S, L, document, dom };
};
