// The architecture check (scripts/check-architecture.js) passes on this tree and fails on each kind of violation.
'use strict';
const assert = require('assert/strict');
const arch = require('../scripts/check-architecture');

const part = (id) => arch.POLICY.find((p) => p.id === id);

assert.deepEqual(arch.run(), [], 'the repository follows its own architecture rules');

// Boundaries: a part imports only itself and its listed contracts; comments and strings do not count.
assert.deepEqual(arch.checkImports('app/engines.js', "const p = require('../host/protocol');\nconst k = require('./keychain');", part('app')), []);
assert.match(arch.checkImports('app/ops.js', "const h = require('../host/storage');", part('app'))[0], /outside app/);
assert.match(arch.checkImports('host/host.js', "require('../app/paths')", part('host'))[0], /outside host/);
assert.match(arch.checkImports('host/host.js', "require('electron')", part('host'))[0], /may not use/);
assert.match(arch.checkImports('engine/src/core/turn.ts', "import { x } from '../../../host/main';", part('engine'))[0], /outside engine/);
assert.deepEqual(arch.checkImports('engine/src/core/turn.ts', "import * as vscode from 'vscode';\nimport { a } from '../tools/agentTools';", part('engine')), []);
assert.deepEqual(arch.checkImports('host/main.js', "// require('../app/main')\nconst s = \"require('../app/x')\";", part('host')), []);

// Pages load no modules.
assert.equal(arch.checkPage('engine/media/chat.js', "const fs = require('fs');").length, 1);
assert.equal(arch.checkPage('ui/app.js', "import('../app/ops.js')").length, 1);
assert.deepEqual(arch.checkPage('engine/media/chat.js', 'window.__zcShell.invoke("host_status");'), []);

// Only the preload uses the IPC bridge, and it exposes only __zcShell.
assert.match(arch.checkBridge('app/desktop-ui.js', "const { ipcRenderer } = window;")[0], /only app\/preload.js/);
assert.match(arch.checkBridge('app/preload.js', "contextBridge.exposeInMainWorld('ipc', ipcRenderer);")[0], /exposes ipc/);
assert.deepEqual(arch.checkBridge('app/preload.js', "contextBridge.exposeInMainWorld('__zcShell', { invoke: () => ipcRenderer.invoke('zc:invoke') });"), []);

// Page views run isolated and sandboxed.
assert.deepEqual(arch.checkWebPreferences('app/x.js', 'new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });'), []);
assert.match(arch.checkWebPreferences('app/x.js', 'new WebContentsView({ webPreferences: { contextIsolation: true } });')[0], /sandbox: true/);
assert.match(arch.checkWebPreferences('app/x.js', 'new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: true } });')[0], /nodeIntegration/);
assert.match(arch.checkWebPreferences('app/x.js', 'const prefs = {}; new BrowserWindow({ webPreferences: prefs });')[0], /inline/);

// Allowed commands and dispatched commands are the same set.
const main = "class Shell { async invoke(e, cmd) { switch (cmd) { case 'a': return 1; case 'b': return 2; default: throw new Error(); } } }";
assert.deepEqual(arch.checkCommands(new Set(['a', 'b']), main), []);
assert.match(arch.checkCommands(new Set(['a', 'b', 'c']), main)[0], /c is allowed but/);
assert.match(arch.checkCommands(new Set(['a']), main)[0], /handles b/);

console.log('ok  architecture check: the tree passes; boundary, page, bridge, webPreferences and command drift all fail');
