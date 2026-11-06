/*
 * The key that encrypts API keys and tokens on disk. It is protected by the OS
 * (Electron safeStorage: DPAPI on Windows, Keychain on macOS, Secret Service on
 * Linux) in data/.engine-key.safe; without OS protection it is an owner-only
 * plain file, data/.engine-key. Once a plain file exists it stays authoritative.
 * A key is never silently replaced while saved credentials depend on it.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const valid = (k) => {
	try {
		return Buffer.from(String(k).trim(), 'base64').length === 32 && /^[A-Za-z0-9+/]+=*$/.test(String(k).trim());
	} catch {
		return false;
	}
};

function readFile(file) {
	try {
		return fs.readFileSync(file);
	} catch (e) {
		if (e && e.code === 'ENOENT') return null;
		throw new Error(`Could not read the saved encryption key: ${e.message}`);
	}
}

/** Saved credentials exist: a missing key means they cannot be opened, so never make a new one. */
function hasSecrets(dataDir) {
	try {
		const values = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.v2.json'), 'utf8'));
		return !(values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length === 0);
	} catch (e) {
		if (e && e.code === 'ENOENT') return false;
		throw new Error(`Could not inspect saved credentials: ${e.message}`);
	}
}

function writeNew(file, bytes) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const fd = fs.openSync(file, 'wx', 0o600);
	try {
		fs.writeSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * @param {string} dataDir
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } | null} safe
 * @returns {string} the base64 key
 */
function engineKey(dataDir, safe) {
	const plain = path.join(dataDir, '.engine-key');
	const sealed = path.join(dataDir, '.engine-key.safe');
	const existing = readFile(plain);
	if (existing) {
		const k = existing.toString('utf8').trim();
		if (!valid(k)) throw new Error('The saved encryption key is invalid. Restore .engine-key from a backup; it was preserved.');
		return k;
	}
	const protectedKey = readFile(sealed);
	if (protectedKey) {
		if (!safe || !safe.isEncryptionAvailable()) throw new Error('The system key store could not be opened. Unlock it and try again; saved credentials were preserved.');
		let k;
		try {
			k = safe.decryptString(protectedKey).trim();
		} catch {
			throw new Error('The protected encryption key could not be opened by this user account. Saved credentials were preserved.');
		}
		if (!valid(k)) throw new Error('The protected encryption key is damaged. Restore .engine-key.safe from a backup; it was preserved.');
		return k;
	}
	if (hasSecrets(dataDir)) throw new Error('The encryption key for your saved credentials is missing. Restore .engine-key or .engine-key.safe before opening them.');
	const k = crypto.randomBytes(32).toString('base64');
	if (safe && safe.isEncryptionAvailable()) {
		try {
			writeNew(sealed, safe.encryptString(k));
			// Read back: some key stores accept a write they cannot open again.
			if (safe.decryptString(fs.readFileSync(sealed)).trim() === k) return k;
		} catch (e) {
			if (e && e.code === 'EEXIST') return engineKey(dataDir, safe);
		}
		fs.rmSync(sealed, { force: true });
	}
	try {
		writeNew(plain, k);
		return k;
	} catch (e) {
		if (e && e.code === 'EEXIST') return engineKey(dataDir, safe);
		throw new Error(`Could not save the encryption key: ${e.message}`);
	}
}

module.exports = { engineKey };
