'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// A separate stop token cannot be overwritten by a simultaneous permission edit.
function writeToken(directory, kind) {
	fs.mkdirSync(directory, {recursive:true});
	const temp = path.join(directory, randomUUID() + '.tmp');
	try { fs.writeFileSync(temp, kind + ':' + randomUUID(), {mode:0o600}); fs.renameSync(temp, path.join(directory,'stop')); }
	finally { fs.rmSync(temp, {force:true}); }
}
const requestStop = directory => writeToken(directory, 'stop');
// Pause keeps the controls on screen (Resume, Stop); Stop dismisses them.
const requestPause = directory => writeToken(directory, 'pause');
/**
 * "Stay ready after restart": with that choice saved in the permissions and at least one app
 * allowed, the permissions adopt the new stop token, so control is ready again without Resume.
 * A new epoch still invalidates every observation from before the restart.
 */
function resumeAfterRestart(directory) {
	const file = path.join(directory, 'permissions.json');
	let p;
	try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
	if (!p || p.resumeOnStart !== true || !Array.isArray(p.allowed) || !p.allowed.length || p.allowed.length > 100) return false;
	p.stop = fs.readFileSync(path.join(directory, 'stop'), 'utf8');
	p.paused = false;
	p.epoch = randomUUID();
	const temp = path.join(directory, randomUUID() + '.tmp');
	try { fs.writeFileSync(temp, JSON.stringify(p), {mode:0o600}); fs.renameSync(temp, file); }
	finally { fs.rmSync(temp, {force:true}); }
	return true;
}
function start(directory, shortcuts) {
	const key = 'CommandOrControl+Alt+Escape';
	let registered = false;
	try { requestStop(directory); } catch (error) { console.error('Computer Use could not be paused at startup:',error.message); }
	try { resumeAfterRestart(directory); } catch (error) { console.error('Computer Use could not stay ready after restart:',error.message); }
	let advertised;
	const refresh = () => {
		let enabled = false;
		try {
			const p = JSON.parse(fs.readFileSync(path.join(directory,'permissions.json'),'utf8'));
			const stop = fs.existsSync(path.join(directory,'stop')) ? fs.readFileSync(path.join(directory,'stop'),'utf8') : '';
			enabled = p.paused === false && Array.isArray(p.allowed) && p.allowed.length > 0 && (p.stop || '') === stop;
		} catch { /* Missing or invalid permissions cannot enable control. */ }
		if (enabled && !registered) { try { registered = shortcuts.register(key, () => { try { requestStop(directory); } catch (error) { console.error('Computer Use Stop failed:',error.message); } refresh(); }); } catch { registered = false; } }
		else if (!enabled && registered) { shortcuts.unregister(key); registered = false; }
		if (advertised !== registered) {
			try { fs.writeFileSync(path.join(directory,'shortcut.json'),JSON.stringify({pid:process.pid,registered})); advertised = registered; } catch { /* The in-app Stop button remains available. */ }
		}
	};
	refresh(); const timer = setInterval(refresh, 200); timer.unref();
	return () => { clearInterval(timer); if (registered) shortcuts.unregister(key); try { requestStop(directory); fs.rmSync(path.join(directory,'shortcut.json'),{force:true}); } catch { /* Shutdown still cancels engine processes. */ } };
}
module.exports = { start, requestStop, requestPause, resumeAfterRestart };
