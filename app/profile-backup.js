'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const MAX_FILES = 20000, MAX_FILE = 64 * 1024 * 1024, MAX_TOTAL = 512 * 1024 * 1024;
const secret = file => /(?:^|\/)(?:secrets(?:\.v2)?\.json(?:\..*)?|\.engine-key(?:\..*)?)$/i.test(file);
const jsonFile = file => /\.json(?:\.bak)?$/i.test(file);
const skipped = file => /(?:^|\/)(?:webview|logs|cache|caches|hf-cache|models|engine|ollama|converter|downloads|node_modules|backups)(?:\/|$)/i.test(file) || /\.(?:tmp|lock|gguf|part|exe|dll|zip|7z)$/i.test(file);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validPath(file, credentials = false) {
	if (typeof file !== 'string' || file.length > 500 || file.includes('\\') || file.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) return false;
	if (!['window.json','glass.json','device-id'].includes(file) && !file.startsWith('data/')) return false;
	return !skipped(file) && (!secret(file) || (credentials && ['data/.engine-key.safe', 'data/secrets.v2.json', 'data/secrets.v2.json.bak'].includes(file)));
}

function inside(root, file) {
	const rel = path.relative(root, file);
	return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function destination(root, relative) {
	const target = path.resolve(root, relative);
	if (!inside(root, target)) throw new Error('Backup path escaped its profile.');
	let current = root;
	for (const part of relative.split('/')) {
		current = path.join(current, part);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Profile backups do not follow links.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	return target;
}

function content(file, credentials) {
	const bytes = fs.readFileSync(file);
	if (bytes.length > MAX_FILE) throw new Error('A profile file exceeds the 64 MB backup limit.');
	if (jsonFile(file)) {
		const value = JSON.parse(bytes.toString('utf8'));
		if (value && typeof value === 'object' && ('aiChat.remoteToken' in value || 'aiChat.remoteDevices' in value)) {
			delete value['aiChat.remoteToken']; delete value['aiChat.remoteDevices'];
			return Buffer.from(JSON.stringify(value));
		}
	}
	return bytes;
}

function collect(root, credentials, raw = false) {
	const files = []; let total = 0;
	function walk(relative) {
		if (skipped(relative)) return;
		const absolute = destination(root, relative);
		if (!fs.existsSync(absolute)) return;
		const stat = fs.lstatSync(absolute);
		if (stat.isDirectory()) for (const name of fs.readdirSync(absolute).sort()) walk(relative + '/' + name);
		else if (stat.isFile() && validPath(relative, credentials)) {
			if (stat.size > MAX_FILE) throw new Error('A profile file exceeds the 64 MB backup limit.');
			const bytes = raw ? fs.readFileSync(absolute) : content(absolute, credentials);
			total += bytes.length;
			if (files.length >= MAX_FILES || total > MAX_TOTAL) throw new Error('Profile exceeds the backup limit (20,000 files / 512 MB, excluding models and caches).');
			files.push({ path:relative, size:bytes.length, sha256:hash(bytes) });
		}
	}
	for (const entry of ['window.json','glass.json','device-id','data']) walk(entry);
	return { files, total };
}

function verifyKey(bytes, safe) {
	if (!safe?.isEncryptionAvailable()) throw new Error('Saved sign-ins require this computer’s unlocked operating-system key store.');
	let key;
	try { key = safe.decryptString(bytes); } catch { throw new Error('This backup’s sign-ins cannot be opened by this operating-system account. Restore a backup without sign-ins instead.'); }
	if (!/^[A-Za-z0-9+/]+=*$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error('The backup encryption key is invalid.');
}

async function createBackup(profile, file, options = {}) {
	const root = fs.realpathSync(profile), target = path.resolve(file);
	if (inside(root, target)) throw new Error('Save the backup outside the app profile.');
	const credentials = options.credentials === true;
	if (credentials) verifyKey(fs.readFileSync(path.join(root, 'data/.engine-key.safe')), options.safe);
	const { files, total } = collect(root, credentials);
	const manifest = { format:'zer0ne-profile', version:1, createdAt:new Date().toISOString(), appVersion:options.appVersion || '', credentials:credentials ? 'os-account' : 'excluded', files, totalBytes:total };
	if (Buffer.byteLength(JSON.stringify(manifest)) > 4 * 1024 * 1024) throw new Error('Backup file index exceeds its limit.');
	const temporary = target + '.' + crypto.randomUUID() + '.tmp';
	async function* records() {
		yield JSON.stringify(manifest) + '\n';
		for (const entry of files) {
			const bytes = content(destination(root, entry.path), credentials);
			if (hash(bytes) !== entry.sha256) throw new Error('Profile changed while backing up. Close active tasks and retry.');
			for (let offset = 0; offset < bytes.length; offset += 65536) yield JSON.stringify({ file:entry.path, chunk:bytes.subarray(offset, offset + 65536).toString('base64') }) + '\n';
			yield JSON.stringify({ end:entry.path }) + '\n';
		}
		const after = collect(root, credentials);
		if (JSON.stringify(after.files) !== JSON.stringify(files)) throw new Error('Profile changed while backing up. Retry after the app is idle.');
	}
	try {
		await pipeline(Readable.from(records()), zlib.createGzip(), fs.createWriteStream(temporary, { flags:'wx', mode:0o600 }));
		const handle = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
		fs.renameSync(temporary, target);
		return manifest;
	} finally { await fs.promises.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

async function readBackup(file, options = {}, onFile) {
	if (fs.statSync(file).size > MAX_TOTAL) throw new Error('Backup archive exceeds the size limit.');
	const input = fs.createReadStream(file), unzip = zlib.createGunzip();
	input.on('error', error => unzip.destroy(error));
	input.pipe(unzip);
	let decompressed = 0, buffered = 0;
	unzip.on('data', chunk => {
		decompressed += chunk.length;
		// Bound both decompression and a malicious record with no line break before readline allocates it.
		buffered = chunk.lastIndexOf(10) < 0 ? buffered + chunk.length : chunk.length - chunk.lastIndexOf(10) - 1;
		if (decompressed > MAX_TOTAL * 1.5 + 8 * 1024 * 1024 || buffered > 4 * 1024 * 1024) unzip.destroy(new Error('Backup decompression limit exceeded.'));
	});
	const lines = readline.createInterface({ input:unzip, crlfDelay:Infinity });
	let manifest, index = 0, size = 0, chunks = [], key, total = 0;
	try {
		for await (const line of lines) {
			if (line.length > (manifest ? 100000 : 4 * 1024 * 1024)) throw new Error('Backup record exceeds its limit.');
			const record = JSON.parse(line);
			if (!manifest) {
				if (record?.format !== 'zer0ne-profile' || record.version !== 1 || !['excluded','os-account'].includes(record.credentials) || !Array.isArray(record.files) || record.files.length > MAX_FILES) throw new Error('Unsupported or invalid profile backup.');
				const seen = new Set(); let expectedTotal = 0;
				for (const entry of record.files) {
					if (!validPath(entry.path, record.credentials === 'os-account') || seen.has(entry.path.toLowerCase()) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid or duplicate file in profile backup.');
					seen.add(entry.path.toLowerCase()); expectedTotal += entry.size;
				}
				if (expectedTotal > MAX_TOTAL || record.totalBytes !== expectedTotal) throw new Error('Invalid backup size.');
				manifest = record; continue;
			}
			const expected = manifest.files[index];
			if (!expected) throw new Error('Unexpected data after the backup.');
			if (record.end === expected.path && Object.keys(record).length === 1) {
				const bytes = Buffer.concat(chunks);
				if (size !== expected.size || hash(bytes) !== expected.sha256) throw new Error('Backup checksum failed: ' + expected.path);
				if (jsonFile(expected.path)) JSON.parse(bytes.toString('utf8'));
				if (expected.path === 'data/.engine-key.safe') key = bytes;
				if (onFile) await onFile(expected.path, bytes);
				index++; size = 0; chunks = [];
			} else {
				if (record.file !== expected.path || typeof record.chunk !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.chunk)) throw new Error('Invalid backup data record.');
				const bytes = Buffer.from(record.chunk, 'base64'); size += bytes.length; total += bytes.length;
				if (bytes.length > 65536 || size > expected.size || total > MAX_TOTAL) throw new Error('Backup data exceeds its declared size.');
				chunks.push(bytes);
			}
		}
		if (!manifest || index !== manifest.files.length) throw new Error('The profile backup is incomplete.');
		if (manifest.credentials === 'os-account') { if (!key) throw new Error('The backup is missing its protected key.'); verifyKey(key, options.safe); }
		return manifest;
	} finally { lines.close(); unzip.destroy(); input.destroy(); }
}

async function restoreBackup(profile, file, options = {}) {
	const root = fs.realpathSync(profile);
	const manifest = await readBackup(file, options);
	const staging = await fs.promises.mkdtemp(path.join(path.dirname(root), '.zer0ne-profile-restore-'));
	const recovery = destination(root, 'backups/recovery-' + crypto.randomUUID());
	let preserveStage = false;
	try {
		await readBackup(file, options, async (relative, bytes) => {
			const target = destination(staging, relative);
			if (jsonFile(relative)) {
				const value = JSON.parse(bytes.toString('utf8'));
				if (value && typeof value === 'object' && ('aiChat.remoteToken' in value || 'aiChat.remoteDevices' in value)) { delete value['aiChat.remoteToken']; delete value['aiChat.remoteDevices']; bytes = Buffer.from(JSON.stringify(value)); }
			}
			await fs.promises.mkdir(path.dirname(target), { recursive:true }); await fs.promises.writeFile(target, bytes, { flag:'wx', mode:0o600 });
		});
		const current = collect(root, manifest.credentials === 'os-account', true).files;
		// An older plaintext key must not override the restored OS-protected key.
		if (manifest.credentials === 'os-account' && fs.existsSync(destination(root, 'data/.engine-key'))) current.push({ path:'data/.engine-key' });
		const before = new Set(current.map(entry => entry.path));
		const next = new Set(manifest.files.map(entry => entry.path));
		const changed = new Set([...before, ...next]);
		for (const relative of before) { const copy = destination(recovery, relative); await fs.promises.mkdir(path.dirname(copy), { recursive:true }); await fs.promises.copyFile(destination(root, relative), copy); }
		const applied = [];
		try {
			for (const relative of changed) {
				const target = destination(root, relative); applied.push(relative);
				if (next.has(relative)) { await fs.promises.mkdir(path.dirname(target), { recursive:true }); await fs.promises.rename(destination(staging, relative), target); }
				else await fs.promises.unlink(target);
			}
		} catch (error) {
			try {
				for (const relative of applied.reverse()) {
					const target = destination(root, relative);
					if (before.has(relative)) await fs.promises.copyFile(destination(recovery, relative), target);
					else await fs.promises.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
				}
			} catch (rollback) { preserveStage = true; throw new Error('Restore and rollback failed. Recovery files were preserved at ' + recovery + '. ' + rollback.message, { cause:error }); }
			throw new Error('Restore failed; the previous profile was recovered. ' + error.message, { cause:error });
		}
		return { manifest, recovery };
	} finally {
		// Delete only the fresh staging directory we created beside this exact profile.
		if (!preserveStage && path.dirname(staging) === path.dirname(root) && path.basename(staging).startsWith('.zer0ne-profile-restore-')) await fs.promises.rm(staging, { recursive:true, force:true });
	}
}

module.exports = { createBackup, readBackup, restoreBackup, validPath };
