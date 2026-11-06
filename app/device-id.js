'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// A random installation ID supports reports without exposing hardware identifiers.
function deviceId(dir) {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'device-id');
	try { fs.writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 }); }
	catch (error) { if (error.code !== 'EEXIST') throw error; }
	const id = fs.readFileSync(file, 'utf8').trim();
	if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error('The saved device ID is invalid.');
	return id;
}

module.exports = { deviceId };
