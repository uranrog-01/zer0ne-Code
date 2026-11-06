'use strict';
const originOf = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.origin : ''; } catch { return ''; } };

/** A grant belongs to this webContents and origin; a permission check never grants access. */
function installSitePermissions(win, dialog) {
	const grants = new Set(), pending = new Map(), session = win.webContents.session;
	let epoch = 0;
	const key = (origin, permission) => origin + '|' + permission;
	const known = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'pointerLock', 'fullscreen', 'clipboard-sanitized-write']);
	const own = contents => !win.isDestroyed() && contents?.id === win.webContents.id;
	const media = details => Array.isArray(details?.mediaTypes) && details.mediaTypes.length ? details.mediaTypes : details?.mediaType ? [details.mediaType] : [];
	const keys = (origin, permission, details) => permission === 'media' ? media(details).filter(t => ['audio', 'video'].includes(t)).map(t => key(origin, 'media:' + t)) : [key(origin, permission)];
	session.setPermissionCheckHandler((contents, permission, origin, details) => {
		const ids = keys(originOf(origin), permission, details);
		return own(contents) && !!originOf(origin) && originOf(contents.getURL()) === originOf(origin) && ids.length > 0 && ids.every(id => grants.has(id));
	});
	session.setPermissionRequestHandler((contents, permission, callback, details) => {
		const origin = originOf(details?.requestingUrl);
		if (!own(contents) || !origin || origin !== originOf(contents.getURL()) || !known.has(permission)) { callback(false); return; }
		const ids = keys(origin, permission, details); if (!ids.length) { callback(false); return; }
		const id = ids.join(','), requestedEpoch = epoch;
		if (ids.every(id => grants.has(id))) { callback(true); return; }
		let decision = pending.get(id);
		if (!decision) {
			decision = dialog.showMessageBox(win, { type: 'question', title: 'Site permission', message: origin + ' wants to use ' + (permission === 'media' ? media(details).map(t => t === 'video' ? 'camera' : 'microphone').join(' and ') : permission) + '.', detail: 'Allow for this preview window. You can revoke access from the right-click menu → Site permissions.', buttons: ['Block', 'Allow'], defaultId: 0, cancelId: 0, noLink: true }).then(r => {
				const allowed = requestedEpoch === epoch && own(contents) && originOf(contents.getURL()) === origin && r.response === 1;
				if (allowed) ids.forEach(id => grants.add(id)); return allowed;
			}, () => false).finally(() => pending.delete(id));
			pending.set(id, decision);
		}
		void decision.then(callback);
	});
	return {
		async manage() {
			if (win.isDestroyed()) return;
			const r = await dialog.showMessageBox(win, { title: 'Site permissions', message: 'Permissions allowed in this preview', detail: [...grants].join('\n') || 'None. Every site permission requires confirmation.', buttons: ['Close', 'Revoke all'], defaultId: 0, cancelId: 0, noLink: true });
			if (r.response === 1) { epoch++; grants.clear(); pending.clear(); if (!win.isDestroyed()) win.webContents.reload(); }
		}, revoke: () => { epoch++; grants.clear(); pending.clear(); }
	};
}
module.exports = { installSitePermissions, originOf };
