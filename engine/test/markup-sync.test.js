// The guard for the bug that shipped a broken build: chat.js looks elements up
// by id with $() — every lookup must resolve to an element the webview markup
// renders (src/webviewMarkup.ts CHAT_BODY) or one chat.js itself creates
// (id="..." in an HTML string, or el.id = '...'). A stale out/ or a half-landed
// markup change fails here instead of shipping a chat view that crashes at init.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const chat = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
const { CHAT_BODY } = require(path.join(__dirname, '..', 'out', 'webviewMarkup.js'));

const defined = new Set();
for (const m of CHAT_BODY.matchAll(/id="([\w-]+)"/g)) defined.add(m[1]);
for (const m of chat.matchAll(/id="([\w-]+)"/g)) defined.add(m[1]);
for (const m of chat.matchAll(/\.id = '([\w-]+)'/g)) defined.add(m[1]);
const lookedUp = new Set();
for (const m of chat.matchAll(/\$\('([\w-]+)'\)/g)) lookedUp.add(m[1]);
for (const m of chat.matchAll(/getElementById\('([\w-]+)'\)/g)) lookedUp.add(m[1]);
const missing = [...lookedUp].filter((id) => !defined.has(id)).sort();
assert.deepStrictEqual(
	missing,
	[],
	'chat.js $() lookups that neither the webview markup nor chat.js itself ever create — add the element to src/webviewMarkup.ts, or remove the lookup: ' + missing.join(', ')
);
console.log('Markup sync: ' + lookedUp.size + ' element lookups all exist in the webview markup or are created by chat.js.');
