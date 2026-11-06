'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

// Native window focus, display bounds and compositor captures are shared by every checkout.
function acquire(file = path.join(os.tmpdir(), 'zer0ne-gui-' + crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12) + '.lock')) {
	const owner = { pid: process.pid, token: crypto.randomUUID() };
	const inherited = process.env.ZER0NE_TEST_LOCK;
	let owns = false;
	for (let attempt = 0; attempt < 2; attempt++) {
		try { fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' }); owns = true; break; }
		catch (error) {
			if (error.code !== 'EEXIST') throw error;
			let current;
			try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
			if (Number.isInteger(current?.pid) && current.pid > 0) {
				try { process.kill(current.pid, 0); if (inherited === current.token + ':' + file) return () => {}; }
				catch (dead) { if (dead.code === 'ESRCH' && attempt === 0) { fs.unlinkSync(file); continue; } }
			}
			else if (attempt === 0 && Date.now() - fs.statSync(file).mtimeMs > 30_000) { fs.unlinkSync(file); continue; }
			throw new Error(`Another desktop test holds ${file}${current?.pid ? ' (PID ' + current.pid + ')' : ''}. Run desktop validation sequentially.`);
		}
	}
	if (!owns) throw new Error('Could not acquire desktop test lock.');
	process.env.ZER0NE_TEST_LOCK = owner.token + ':' + file;
	const release = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } finally { if (inherited === undefined) delete process.env.ZER0NE_TEST_LOCK; else process.env.ZER0NE_TEST_LOCK = inherited; } };
	process.once('exit', () => { try { release(); } catch (error) { console.error(error.message); } });
	return release;
}
module.exports = { acquire };
