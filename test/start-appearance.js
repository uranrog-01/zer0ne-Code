'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { JSDOM } = require('jsdom');
const { readAppearance } = require('../app/appearance');
const { EngineWindow } = require('../app/engines');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-start-theme-'));

async function main() {
	const file = path.join(temp, 'global-state.json');
	assert.deepEqual(readAppearance(file), {});
	fs.writeFileSync(file, 'damaged'); assert.deepEqual(readAppearance(file), {});
	fs.writeFileSync(file, JSON.stringify({ 'aiChat.settings': { theme: 'terminal', themeBackground: '#102030', accent: 'custom', accentColor: '#aabbcc', apiKey: 'private', remoteToken: 'private', providers: [] }, other: 'private' }));
	assert.deepEqual(readAppearance(file), { theme: 'terminal', themeBackground: '#102030', accent: 'custom', accentColor: '#aabbcc' });
	const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
	assert(html.indexOf('src="start-theme.js"') < html.indexOf('<main>'), 'Appearance is applied before loading content is parsed');
	for (const [settings, systemLight, light] of [[{ theme:'dark' },true,false], [{ theme:'light' },false,true], [{ theme:'terminal' },true,false], [{ theme:'auto' },true,true], [{ theme:'auto' },false,false], [{ theme:'dark',themeBackground:'#ffffff' },false,true], [{ theme:'light',themeBackground:'#102030' },true,false]]) {
		const dom = new JSDOM('<body></body>', { runScripts:'outside-only' });
		const w = dom.window, media = { matches:systemLight, addEventListener(_, fn) { this.change = fn; } };
		w.matchMedia = () => media; w.__zcShell = { boot:{ appearance:settings } };
		w.eval(fs.readFileSync(path.join(root, 'engine/media/appearance.js'), 'utf8'));
		w.eval(fs.readFileSync(path.join(root, 'ui/start-theme.js'), 'utf8'));
		assert.equal(w.document.body.classList.contains('is-light'), light, JSON.stringify(settings));
		if (settings.themeBackground) assert.equal(w.document.body.style.getPropertyValue('--color-background'), settings.themeBackground);
		media.matches = !systemLight; media.change();
		assert.equal(w.document.body.classList.contains('is-light'), settings.theme === 'auto' ? !light : light, 'only System follows a system change');
		dom.window.close();
	}
	const host = Object.create(EngineWindow.prototype), loads = []; let shown = 0, maximized = 0;
	host.shell = { state:{ maximized:true }, startFile:() => 'fixture', syncIcons() {} };
	host.win = { isDestroyed:() => false, show:() => shown++, maximize:() => maximized++ };
	host.startView = { webContents:{ isDestroyed:() => false, loadFile:() => new Promise(resolve => loads.push(resolve)) } };
	host.revealStart = () => {};
	host.activate = () => host.showStartPage(null);
	host.start(null, null); assert.equal(shown, 0, 'the initial window waits for themed content');
	assert.equal(maximized, 0, 'maximizing must not reveal the window before its theme');
	host.showStartPage('startup error'); loads[0](); await new Promise(resolve => setImmediate(resolve));
	assert.equal(shown, 0, 'an older navigation cannot reveal the next unstyled page');
	loads[1](); await new Promise(resolve => setImmediate(resolve)); assert.equal(shown, 1); assert.equal(maximized, 1);
	host.showStartPage(null); loads[2](); await new Promise(resolve => setImmediate(resolve)); assert.equal(shown, 1, 'a retry does not reopen a window hidden by its user');
	console.log('Start Appearance: saved themes, system changes, custom colours, private-field filtering and first-window navigation passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
	const target = fs.realpathSync(temp), parent = fs.realpathSync(os.tmpdir());
	if (path.dirname(target) !== parent || !path.basename(target).startsWith('z0-start-theme-')) throw new Error('Unexpected test directory');
	fs.rmSync(target, { recursive:true, force:true });
});
