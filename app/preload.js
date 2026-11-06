/*
 * The bridge for zer0ne Code's own pages (the start page and the engine pages):
 * `window.__zcShell` with the page's boot values and `invoke(command, args)`. The
 * shell identifies the caller by its webContents, never by anything the page says.
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let boot = null;
try {
	boot = ipcRenderer.sendSync('zc:boot');
} catch {
	boot = null;
}

contextBridge.exposeInMainWorld('__zcShell', {
	boot: boot || {},
	invoke: (cmd, args) => ipcRenderer.invoke('zc:invoke', String(cmd), args && typeof args === 'object' ? args : {})
});
