/*
 * The desktop wallpaper read, shared by the main process fallback and the
 * utility worker (app/workers/misc.js): fill / fit / stretch / tile / center /
 * span, from the current user's desktop settings. No Electron imports here —
 * a utility process is a plain Node environment.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** Fill / fit / stretch / tile / center / span, from the current user's desktop settings. */
function wallpaperStyle() {
	const read = (name) => {
		const r = spawnSync('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
		const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.includes('REG_SZ'));
		return line ? line.trim().split(/\s+/).pop() : null;
	};
	if (read('TileWallpaper') === '1') return 'tile';
	return { 0: 'center', 2: 'stretch', 6: 'fit', 22: 'span' }[read('WallpaperStyle')] || 'fill';
}

/** The desktop wallpaper as a data URL, read only for its colours; `since` skips an unchanged file. */
function wallpaper(since) {
	if (process.platform !== 'win32' || !process.env.APPDATA) return null;
	const file = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Themes', 'TranscodedWallpaper');
	let modified;
	try {
		modified = Math.floor(fs.statSync(file).mtimeMs);
	} catch {
		return null;
	}
	const style = wallpaperStyle();
	if (since === modified) return { unchanged: true, modified, style };
	let bytes;
	try {
		bytes = fs.readFileSync(file);
	} catch {
		return null;
	}
	if (!bytes.length || bytes.length > 60_000_000) return null;
	const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png' : bytes[0] === 0x42 && bytes[1] === 0x4d ? 'image/bmp' : 'image/jpeg';
	return { url: `data:${mime};base64,${bytes.toString('base64')}`, modified, style };
}

module.exports = { wallpaperStyle, wallpaper };
