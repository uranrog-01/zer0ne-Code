'use strict';
const fs = require('fs');
const path = require('path');

const NAME = 'zer0ne Code.lnk';

/**
 * Windows shows notifications only for an app with a Start Menu shortcut carrying its
 * AppUserModelID. The installer puts one in a "zer0ne" folder, per user or for all users;
 * a second copy made here would list the app twice, so one that already starts this
 * executable is kept. Without an installer the built app keeps its own (per user) current.
 * Returns the shortcut written, or null when nothing changed.
 */
function ensureStartMenuShortcut({ execPath, aumid, appData, programData, description, read, write, exists = fs.existsSync, mkdir = (dir) => fs.mkdirSync(dir, { recursive: true }) }) {
	const programs = (base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
	const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
	const shortcut = (link) => (exists(link) ? read(link) : null);
	const ours = (info) => !!info && info.appUserModelId === aumid;
	const user = programs(appData);
	const roots = programData ? [user, programs(programData)] : [user];
	for (const root of roots) {
		for (const folder of [path.join(root, 'zer0ne'), root]) {
			const info = shortcut(path.join(folder, NAME));
			if (ours(info) && same(info.target, execPath)) return null;
		}
	}
	// Update a per-user shortcut of ours that starts another copy; never take over another app's.
	let link = [path.join(user, 'zer0ne', NAME), path.join(user, NAME)].find((candidate) => ours(shortcut(candidate)));
	if (!link) {
		link = path.join(user, 'zer0ne', NAME);
		if (exists(link)) link = path.join(user, 'zer0ne', 'zer0ne Code (Electron).lnk');
	}
	const current = shortcut(link);
	if (ours(current) && same(current.target, execPath)) return null;
	mkdir(path.dirname(link));
	write(link, current ? 'replace' : 'create', { target: execPath, appUserModelId: aumid, icon: execPath, iconIndex: 0, description });
	return link;
}

module.exports = { ensureStartMenuShortcut };
