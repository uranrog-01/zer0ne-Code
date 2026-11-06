'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function readJson(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
		return value;
	} catch (error) {
		if (error.code === 'ENOENT') return {};
		// A damaged file is never overwritten and never silently replaced: the user has to
		// know their chats are unreadable. The last good copy sits next to it, so the
		// error says where to restore it from.
		const backup = `${file}.bak`;
		const recoverable = fs.existsSync(backup);
		throw new Error(
			`Cannot read saved data at ${file}: ${error.message}. The file was preserved.` +
			(recoverable ? ` Restore the last good copy from ${backup}.` : ''),
			{ cause: error }
		);
	}
}

function writeJson(file, value) {
	const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
	try {
		// Write and flush before publishing: a rename alone can publish bytes the filesystem
		// never durably received, and this file holds every chat.
		const descriptor = fs.openSync(temporary, 'wx', 0o600);
		try {
			fs.writeSync(descriptor, JSON.stringify(value));
			fs.fsyncSync(descriptor);
		} finally {
			fs.closeSync(descriptor);
		}
		// Keep the last good copy, so a torn write on a later save is recoverable.
		try { fs.copyFileSync(file, `${file}.bak`); } catch { /* there was no previous file */ }
		const until = Date.now() + 1000;
		while (true) {
			try { fs.renameSync(temporary, file); break; }
			catch (error) {
				// Windows readers can briefly prevent atomic replacement despite the writer lock.
				if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= until) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		// Make the rename itself durable (POSIX only; harmless elsewhere).
		try {
			const dir = fs.openSync(path.dirname(file), 'r');
			try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
		} catch { /* not supported on this platform */ }
	} finally {
		try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') console.error(error.message); }
	}
}

// Every desktop writer must hold the same lock across reading, merging, and renaming.
function transaction(file, change) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = file + '.lock';
	const until = Date.now() + 5000;
	let descriptor;
	while (descriptor === undefined) {
		try {
			descriptor = fs.openSync(lock, 'wx', 0o600);
			fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid }));
		} catch (error) {
			if (descriptor !== undefined) { fs.closeSync(descriptor); fs.unlinkSync(lock); throw error; }
			// A Windows lock can be delete-pending until another reader closes its handle.
			if (error.code !== 'EEXIST' && !(process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code))) throw error;
			try {
				const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
				if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('Invalid lock owner');
				try { process.kill(owner.pid, 0); }
				catch (dead) { if (dead.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
			} catch (invalid) {
				if (invalid.code === 'ENOENT') continue;
				// A live writer also leaves an empty file between exclusive creation and
				// publishing its pid. Never reclaim that fresh lock from underneath it.
				try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; } } catch {}
			}
			if (Date.now() >= until) throw new Error(`Timed out saving ${file}; another process holds its lock.`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	try {
		const data = readJson(file);
		change(data);
		writeJson(file, data);
		return data;
	} finally {
		fs.closeSync(descriptor);
		fs.unlinkSync(lock);
	}
}

function fields(current, before, next) {
	const result = { ...object(current) };
	for (const field of new Set([...Object.keys(object(before)), ...Object.keys(object(next))])) {
		if (equal(before?.[field], next?.[field])) continue;
		if (next?.[field] === undefined) delete result[field];
		else result[field] = clone(next[field]);
	}
	return result;
}

/**
 * Merge arrays of records by their `id`. The desktop runs one engine process per project and
 * they all share this file, so a whole-value write would delete what another project just
 * stored. A record the caller saw and no longer has is treated as removed.
 */
function mergeById(diskValue, beforeValue, nextValue) {
	const old = new Map((beforeValue || []).filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
	const next = new Map((nextValue || []).filter(e => e && typeof e.id === 'string').map(e => [e.id, e]));
	const removed = new Set([...old.keys()].filter(id => !next.has(id)));
	const merged = new Map((diskValue || []).filter(e => e && typeof e.id === 'string' && !removed.has(e.id)).map(e => [e.id, e]));
	for (const [id, entry] of next) {
		if (!old.has(id)) merged.set(id, merged.has(id) ? merged.get(id) : clone(entry));
		else if (merged.has(id)) merged.set(id, fields(merged.get(id), old.get(id), entry));
	}
	return [...merged.values()];
}

function mergeAsSet(diskValue, beforeValue, nextValue, key = p => p) {
	const old = new Set((beforeValue || []).map(key));
	const next = new Set((nextValue || []).map(key));
	const removed = new Set([...old].filter(p => !next.has(p)));
	const merged = new Set((diskValue || []).filter(p => !removed.has(key(p))).map(key));
	for (const p of nextValue || []) if (!old.has(key(p))) merged.add(key(p));
	return [...merged];
}

/** A usage event is identified by its attempt, or by when it happened. */
function usageKey(event) {
	return event && event.attemptId ? `a:${event.attemptId}` : `t:${event && event.t}:${event && event.providerId}:${event && event.model}`;
}

function sharedGlobalMemento(file, defaults = {}) {
	let cached, stamp;
	const read = () => {
		let next;
		try { const stat = fs.statSync(file); next = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
		catch (error) { if (error.code !== 'ENOENT') throw error; next = 'missing'; }
		if (cached && next === stamp) return cached;
		const disk = readJson(file);
		if (Array.isArray(disk['aiChat.sessions']) && Array.isArray(disk['zer0neDesktop.deletedSessions'])) {
			const removed = new Set(disk['zer0neDesktop.deletedSessions']);
			disk['aiChat.sessions'] = disk['aiChat.sessions'].filter(s => !removed.has(s.id));
		}
		stamp = next; cached = disk;
		return disk;
	};
	let data = read();
	const snapshots = new Map();
	const settings = 'aiChat.settings';
	const tombstones = 'zer0neDesktop.deletedSessions';
	const projectKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
	const baseline = (key, value) => key === settings ? { ...defaults, ...object(value) } : clone(value);
	return {
		get(key, fallback) {
			data = read();
			snapshots.set(key, baseline(key, data[key]));
			return key in data ? clone(data[key]) : fallback;
		},
		async update(key, value) {
			const before = snapshots.has(key) ? snapshots.get(key) : baseline(key, data[key]);
			data = transaction(file, disk => {
				if (key === 'aiChat.sessions' && Array.isArray(value)) {
					const old = new Map((before || []).filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
					const next = new Map(value.filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
					const deleted = new Set(disk[tombstones] || []);
					for (const id of old.keys()) if (!next.has(id)) deleted.add(id);
					const merged = new Map((disk[key] || []).filter(s => s && typeof s.id === 'string' && !deleted.has(s.id)).map(s => [s.id, s]));
					for (const [id, entry] of next) {
						if (deleted.has(id)) continue;
						if (!old.has(id)) merged.set(id, merged.has(id) ? merged.get(id) : clone(entry));
						else if (merged.has(id)) merged.set(id, fields(merged.get(id), old.get(id), entry));
					}
					disk[key] = [...merged.values()];
					disk[tombstones] = [...deleted];
				} else if (key === 'aiChat.projects' && Array.isArray(value)) {
					const old = new Set((before || []).filter(p => typeof p === 'string').map(projectKey));
					const next = new Set(value.filter(p => typeof p === 'string').map(projectKey));
					const removed = new Set([...old].filter(p => !next.has(p)));
					const merged = new Map((disk[key] || []).filter(p => typeof p === 'string' && !removed.has(projectKey(p))).map(p => [projectKey(p), p]));
					for (const p of value) if (typeof p === 'string' && !old.has(projectKey(p))) merged.set(projectKey(p), p);
					disk[key] = [...merged.values()];
				} else if ((key === 'aiChat.folders' || key === 'aiChat.disabledMods' || key === 'aiChat.hiddenMods') && Array.isArray(value)) {
					disk[key] = mergeAsSet(disk[key], before, value);
				} else if (key === 'aiChat.providers' || key === 'aiChat.hooks') {
					// Provider and hook lists are edited in one project and must not vanish
					// because another project saved its own copy of the list.
					if (Array.isArray(value)) disk[key] = mergeById(disk[key], before, value);
					else if (value === undefined) delete disk[key];
					else disk[key] = clone(value);
				} else if ((key === 'aiChat.modelFavorites' || key === 'aiChat.modelRecent') && Array.isArray(value)) {
					const merged = mergeById(disk[key], before, value);
					disk[key] = key === 'aiChat.modelRecent' ? merged.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0)).slice(0, 8) : merged.slice(0, 100);
				} else if (key === 'aiChat.usage' && Array.isArray(value)) {
					// Usage is a time window each process trims by age. Keep the peer's newer
					// events instead of dropping them, but still honour this caller's own trim.
					const oldest = value.reduce((min, e) => (e && typeof e.t === 'number' && e.t < min ? e.t : min), Number.POSITIVE_INFINITY);
					const seen = new Set(value.map(usageKey));
					const extra = (disk[key] || []).filter(e => e && typeof e.t === 'number' && e.t >= oldest && !seen.has(usageKey(e)));
					disk[key] = [...value, ...extra].sort((a, b) => ((a && a.t) || 0) - ((b && b.t) || 0));
				} else if (key === 'aiChat.memoryMigrationOwners') {
					// Legacy groups have one owner. Concurrent project startup cannot replace a prior claim.
					disk[key] = { ...object(value), ...object(disk[key]) };
				} else if (key === settings || key === 'zer0neDesktop.preferences') {
					disk[key] = fields(disk[key], before, value);
				} else if (value === undefined) delete disk[key];
				else disk[key] = clone(value);
			});
			// A merge may include peers the caller never saw; those cannot become its
			// deletion baseline. Keep the values the caller actually submitted.
			snapshots.set(key, baseline(key, value));
		},
		keys() { data = read(); return Object.keys(data); },
		setKeysForSync() {},
		flush() { data = read(); }
	};
}

function keyedSecrets(file, key) {
	const listeners = new Set();
	const encode = value => {
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
		const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
		return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
	};
	return {
		async get(name) {
			const data = readJson(file);
			if (!Object.hasOwn(data, name)) return undefined;
			try {
				const buffer = Buffer.from(data[name], 'base64');
				const cipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
				cipher.setAuthTag(buffer.subarray(12, 28));
				return Buffer.concat([cipher.update(buffer.subarray(28)), cipher.final()]).toString('utf8');
			} catch (error) {
				throw new Error('A saved credential could not be decrypted. Restore the original encryption key; the credential was preserved.', { cause: error });
			}
		},
		async store(name, value) {
			const encrypted = encode(value);
			transaction(file, data => { data[name] = encrypted; });
			for (const listener of listeners) listener({ key: name });
		},
		async delete(name) {
			transaction(file, data => { delete data[name]; });
			for (const listener of listeners) listener({ key: name });
		},
		async keys() { return Object.keys(readJson(file)); },
		onDidChange(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
	};
}

module.exports = { keyedSecrets, sharedGlobalMemento, transaction, readJson };
