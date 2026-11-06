'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function outputChannel(name, dataDir, prompt) {
	const file = path.join(dataDir, 'logs', crypto.createHash('sha256').update(name).digest('hex').slice(0, 20) + '.log');
	let buffer = '', disposed = false;
	try { buffer = fs.readFileSync(file, 'utf8').slice(-256 * 1024); } catch (err) { if (err.code !== 'ENOENT') console.error('Output log read failed:', err.message); }
	const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, buffer); };
	const append = text => {
		if (disposed) return;
		buffer = (buffer + String(text)).slice(-256 * 1024);
		try { save(); } catch (err) { console.error('Output log save failed:', err.message); }
	};
	return { name, append, appendLine: text => append(String(text) + '\n'),
		replace(text) { buffer = ''; append(text); },
		clear() { if (disposed) return; buffer = ''; try { save(); } catch (err) { console.error('Output log clear failed:', err.message); } },
		show() { if (!disposed) void prompt({ kind: 'log', title: name, content: buffer || 'No diagnostics yet.' }).catch(err => console.error('Output viewer failed:', err.message)); },
		hide() {}, dispose() { disposed = true; } };
}

module.exports = { outputChannel };
