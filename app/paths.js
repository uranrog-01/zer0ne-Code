/*
 * Where zer0ne Code keeps things. Defaults live under the per-user app data folder
 * (%APPDATA%\zer0ne Code on Windows); ZER0NE_DATA_DIR keeps everything in one folder
 * (tests, portable setups). ZER0NE_APP_ROOT points at another checkout of host/ and engine/.
 */
'use strict';
const path = require('path');
const { app } = require('electron');

const portable = process.env.ZER0NE_DATA_DIR ? path.resolve(process.env.ZER0NE_DATA_DIR) : null;

/** Settings the shell itself keeps: window.json, glass.json. */
function configDir() {
	return portable || app.getPath('userData');
}

/** The engine's data: chats, settings, keys, the webview profile. */
function dataDir() {
	return path.join(configDir(), 'data');
}

function logDir() {
	return portable ? path.join(portable, 'logs') : app.getPath('logs');
}

/** Folder holding host/, engine/, ui/ and app/: the packaged app, or this checkout in development. */
function appRoot() {
	if (app.isPackaged) return path.join(process.resourcesPath, 'app.asar.unpacked');
	return process.env.ZER0NE_APP_ROOT ? path.resolve(process.env.ZER0NE_APP_ROOT) : path.join(__dirname, '..');
}

/** Must run before the app is ready: the Chromium profile goes under data/, next to what the engine keeps. */
function configure() {
	if (portable) app.setPath('userData', portable);
	app.setPath('sessionData', path.join(dataDir(), 'webview'));
	app.setAppLogsPath(logDir());
}

module.exports = { configDir, dataDir, logDir, appRoot, configure };
