const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { readPage } = require('./page-scripts');

const dom = new JSDOM('<body><div id="settings-root"></div><div id="dialog-root"></div><div id="toast"></div></body>', { runScripts: 'outside-only' });
const w = dom.window, doc = w.document, posts = [], local = {};
w.matchMedia = () => ({ matches: false, addEventListener() {} });
w.Bridge = { desktop: true, getState: () => local, patchState: patch => Object.assign(local, patch), post: message => posts.push(message) };
w.Icons = { svg: () => '<svg></svg>' };
w.eval(fs.readFileSync(path.join(__dirname, '../media/settings-remote.js'), 'utf8'));
w.eval(readPage('settings.js'));
const send = (type, data) => w.dispatchEvent(new w.MessageEvent('message', { data: JSON.parse(JSON.stringify({ type, data })) }));
const button = action => doc.querySelector('[data-act="' + action + '"]');
const supportedModel = { provider: 'API', model: 'model', local: false };
const configured = { signedIn: true, repo: 'owner/project', workspacePath: 'C:\\project', remoteWorkflow: true, secret: true, model: supportedModel, tasks: [] };

try {
	w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'state', settings: {}, providers: [], presets: [], capabilities: { id: 'desktop' } } }));
	w.Settings.open('cloud');
	assert(posts.some(message => message.type === 'cloudStatus'));
	send('cloudStatus', { signedIn: true, workspacePath: 'C:\\project', localFiles: false, model: { ...supportedModel, unsupported: 'Responses API providers are not supported.' } });
	assert(button('cloud-auto').disabled);
	assert(button('cloud-start').disabled);
	assert.match(doc.querySelector('.cloud-hero').textContent, /origin remote/);
	assert.match(doc.querySelector('.cloud-setup').textContent, /C:\\project/);
	assert(!button('cloud-setup').disabled, 'Local files can be added before configuring a remote');
	button('cloud-folder').click();
	assert(posts.some(message => message.type === 'workspaceAction' && message.action === 'open'));

	send('cloudStatus', { ...configured, model: { ...supportedModel, unsupported: 'Responses API providers are not supported.' } });
	assert(button('cloud-auto').disabled, 'Automatic setup requires a supported model before changing the repository');
	assert.match(button('cloud-auto').title, /supported hosted API/);
	doc.querySelector('[data-nav-to="models"]').click();
	assert(!doc.querySelector('.cloud-page'), 'Choose provider opens provider settings');
	w.Settings.open('cloud');

	for (const secret of [null, false]) {
		send('cloudStatus', { ...configured, secret });
		assert(button('cloud-start').disabled, 'An unconfirmed or missing secret blocks dispatch');
		assert.match(button('cloud-start').title, /ZER0NE_API_KEY/);
	}
	send('cloudStatus', configured);
	assert(!button('cloud-start').disabled);
	send('cloudStatus', { repo: configured.repo, tasks: [], model: supportedModel });
	assert(!button('cloud-start').disabled, 'Task updates preserve confirmed setup checks');
	send('cloudStatus', { repo: 'owner/another', tasks: [], model: supportedModel });
	assert(button('cloud-start').disabled, 'A different repository cannot inherit setup checks');
	send('cloudStatus', { ...configured, remoteWorkflow: null });
	assert(button('cloud-start').disabled, 'A failed deep check clears previous confirmation');
	send('cloudStatus', { ...configured, repo: null, localFiles: true, remoteWorkflow: null });
	assert(button('cloud-push').disabled, 'Local workflow files do not imply a GitHub remote');
	button('cloud-refresh').click();
	assert.equal(posts.at(-1).type, 'cloudStatus');
	console.log('Cloud setup blockers, actions and readiness passed.');
} finally {
	w.close();
}
