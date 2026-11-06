const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { readPage } = require('./page-scripts');

async function main() {
	const dom = new JSDOM('<body class="vscode-dark"><div id="settings-root"></div><div id="dialog-root"></div><div id="toast"></div></body>', { runScripts:'outside-only' });
	const w = dom.window, doc = w.document, posts = [], local = {};
	const media = { matches:true, addEventListener(_, listener) { this.change = listener; } };
	w.matchMedia = () => media;
	w.Bridge = { desktop:true, getState:() => local, patchState:patch => Object.assign(local, patch), post:message => posts.push(message) };
	w.Icons = { svg:() => '<svg></svg>' };
	w.eval(fs.readFileSync(path.join(__dirname, '../media/appearance.js'), 'utf8'));
	w.applyAppearance({ theme:'auto' });
	assert(doc.body.classList.contains('is-light'), 'System uses the desktop light preference');
	assert(doc.body.classList.contains('vscode-light'), 'System applies the base light palette');
	media.matches = false; media.change();
	assert(!doc.body.classList.contains('is-light'), 'System follows a live switch to dark');
	w.applyAppearance({ theme:'dark' }); media.matches = true; media.change();
	assert(!doc.body.classList.contains('is-light'), 'An explicit theme survives system changes');
	w.Bridge.desktop = false; doc.body.className = 'vscode-light'; media.matches = false;
	w.applyAppearance({ theme:'auto' });
	assert(doc.body.classList.contains('is-light'), 'Editor pages keep the editor-provided appearance');
	w.Bridge.desktop = true;
	w.eval(fs.readFileSync(path.join(__dirname, '../media/settings-remote.js'), 'utf8'));
	w.eval(readPage('settings.js'));
	const settings = { theme:'dark', accent:'blue', accentColor:'#3b82f6', accentColor2:'', themeBackground:'', themeForeground:'', fontUi:'system', fontContent:'system', fontCode:'editor', fontWeight:400, uiFontSize:13 };
	function render(patch = {}) {
		w.dispatchEvent(new w.MessageEvent('message', { data:{ type:'state', settings:{ ...settings, ...patch }, providers:[], presets:[], capabilities:{ id:'desktop' } } }));
		w.Settings.open('appearance'); posts.length = 0;
	}
	function input(id, value) {
		const field = doc.getElementById(id); assert(field, id);
		field.value = value; field.dispatchEvent(new w.Event('input', { bubbles:true }));
	}
	const saved = () => posts.filter(message => message.type === 'updateSettings').map(message => message.patch);
	const wait = () => new Promise(resolve => setTimeout(resolve, 180));
	try {
		render(); assert(doc.querySelector('[data-act="theme-reset"]').hidden);
		input('s-codeFontSize', '18');
		assert(!doc.querySelector('[data-act="theme-reset"]').hidden, 'Changing only the code font size reveals Reset immediately');
		w.Settings.close(); render();
		assert(!doc.querySelector('[data-act="theme-reset"]').hidden, 'The local font preference reveals Reset after reopening');
		input('theme-bg-hex', '#112233'); input('theme-fg-hex', '#eeddcc');
		await wait();
		assert.deepEqual(JSON.parse(JSON.stringify(saved())), [{ themeBackground:'#112233', themeForeground:'#eeddcc' }], 'Separate colour fields are saved together');
		posts.length = 0;
		input('accent-hex', '#aabbcc'); input('accent-hex2', '#223344');
		await wait();
		assert.equal(saved().at(-1).accentColor, '#aabbcc', 'Secondary accent retains the pending primary accent');
		assert.equal(saved().at(-1).accentColor2, '#223344');
		posts.length = 0;
		input('theme-bg-hex', '#445566'); doc.querySelector('[data-act="theme-reset"]').click();
		await wait();
		assert.equal(saved().length, 1, 'Reset cancels queued colour writes');
		assert.equal(saved()[0].themeBackground, ''); assert.equal(local.codeFontSize, 12);
		posts.length = 0;
		input('theme-bg-hex', '#123456'); doc.querySelector('[data-theme-pick="auto"]').click();
		await wait();
		assert.equal(saved().length, 2); assert.equal(saved()[0].themeBackground, '#123456'); assert.equal(saved()[1].theme, 'auto');
		render({ theme:'terminal' }); doc.querySelector('[data-theme-tab="terminal"]').click();
		assert(!doc.querySelector('.term-about').textContent.includes('Powerline bar'));
		w.applyAppearance({ theme:'liquidmac' });
		assert.equal(doc.body.dataset.theme, undefined);
		assert.equal(posts.at(-1).patch.theme, 'auto');
	} finally { dom.window.close(); }
	console.log('Appearance UI: live System theme, explicit/editor themes, merged colour edits, Reset races, local code font Reset and Terminal help passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
