/*
 * Liquid Glass helpers for the engine pages (desktop-glass.js). One set of settings
 * for the whole app in glass.json (each project's page runs on its own port, so page
 * storage would differ per project); blur belongs to the window; the wallpaper is
 * read only for its colours.
 *
 * Per system: the see-through window works on Windows, macOS and Linux desktops with
 * a compositor; the blur is Acrylic on Windows and vibrancy on macOS (Linux has none);
 * wallpaper colours are Windows only. support() tells the page, which shows only
 * the options that work here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { configDir } = require('./paths');
const { wallpaper, wallpaperStyle } = require('./wallpaper');

const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;

function prefsPath() {
	return path.join(configDir(), 'glass.json');
}

/** The saved settings, or null before the first save. */
function savedPrefs() {
	try {
		const value = JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
		return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/** Linux: Wayland always composites; on X11 the known desktops do, or a running compositor. */
function linuxComposited(env = process.env, running = linuxRunning) {
	const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
	if (has('WAYLAND_DISPLAY') || String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') return true;
	const desktops = ['gnome', 'kde', 'plasma', 'unity', 'cinnamon', 'budgie', 'pantheon', 'deepin', 'ukui', 'xfce'];
	const current = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
	if (current.split(':').some((d) => desktops.some((c) => d.includes(c)))) return true;
	return running(['picom', 'compton', 'xcompmgr', 'kwin_x11', 'mutter', 'gnome-shell', 'marco', 'compiz']);
}

function linuxRunning(names) {
	try {
		return fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).some((d) => {
			try {
				return names.includes(fs.readFileSync(path.join('/proc', d, 'comm'), 'utf8').trim());
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
}

let composited;
/** Whether a see-through window can work here (without a compositor a transparent window paints black). */
function transparentSupported() {
	if (process.platform !== 'linux') return true;
	if (composited === undefined) composited = linuxComposited();
	return composited;
}

function support() {
	return {
		os: OS,
		transparent: transparentSupported(),
		blur: process.platform === 'win32' || process.platform === 'darwin',
		panelBlur: process.platform === 'win32',
		hideIcons: process.platform === 'win32',
		colors: process.platform === 'win32'
	};
}

/**
 * Save the page's settings unless the file holds a newer copy (then that copy wins and
 * is sent back). Returns { saved, text, newer }.
 */
function savePrefs(prefs) {
	const text = JSON.stringify(prefs);
	if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs) || text.length > 4096) return { saved: false };
	const previous = savedPrefs();
	if (previous && Number(previous.at || 0) > Number(prefs.at || 0)) return { saved: true, newer: previous };
	try {
		fs.mkdirSync(path.dirname(prefsPath()), { recursive: true });
		const tmp = prefsPath() + '.tmp';
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, prefsPath());
		return { saved: true, text };
	} catch {
		return { saved: false, text };
	}
}

/** "Blurry": frosted glass behind the transparent window — Acrylic on Windows, vibrancy on macOS. */
function setBlur(win, on) {
	if (!win || win.isDestroyed()) return false;
	try {
		if (process.platform === 'win32') {
			win.setBackgroundMaterial(on ? 'acrylic' : 'none');
			return true;
		}
		if (process.platform === 'darwin') {
			win.setVibrancy(on ? 'under-window' : null);
			return true;
		}
	} catch {
		return false;
	}
	return false;
}

module.exports = { savedPrefs, savePrefs, support, transparentSupported, setBlur, wallpaper, wallpaperStyle, linuxComposited };
