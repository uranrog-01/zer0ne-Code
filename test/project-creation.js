'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ProjectCreation } = require('../app/project-creation');
const { desktopProjects } = require('../host/host');

(async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-create-'));
	try {
		const folder = path.join(base, 'source'); fs.mkdirSync(folder);
		const service = new ProjectCreation(), sender = {}, other = {}, opened = [];
		const open = async (...args) => opened.push(args);
		assert.equal(await service.pick(sender, async () => null), null);
		await assert.rejects(service.create(sender, { trusted: true }, open), /Choose a folder/);
		let picked = await service.pick(sender, async () => folder);
		const args = { selection: picked.selection, name: 'My project', trusted: true };
		await assert.rejects(service.create(other, args, open), /Choose a folder/);
		await assert.rejects(service.create(sender, { ...args, trusted: false }, open), /trust/);
		await assert.rejects(service.create(sender, { ...args, name: '  ' }, open), /project name/);
		await assert.rejects(service.create(sender, { ...args, selection: 'arbitrary' }, open), /Choose a folder/);
		assert.equal(opened.length, 0, 'nothing opens before valid explicit trust');
		await service.create(sender, args, open);
		assert.deepEqual(opened, [[fs.realpathSync.native(folder), { kind: 'project', name: 'My project' }]]);
		await assert.rejects(service.create(sender, args, open), /Choose a folder/, 'approval is single use');
		picked = await service.pick(sender, async () => folder);
		fs.renameSync(folder, path.join(base, 'old')); fs.mkdirSync(folder);
		await assert.rejects(service.create(sender, { ...args, selection: picked.selection }, open), /folder changed/);
		assert.equal(opened.length, 1, 'a replaced folder needs a fresh approval');
		const values = {}, state = { get: (k, fallback) => values[k] ?? fallback, update: async (k, v) => { values[k] = v; } };
		const projects = desktopProjects({ globalState: state }, p => p.toLowerCase());
		await projects.register(folder, 'Saved name');
		await projects.register(folder, 'Updated name');
		assert.deepEqual(values['aiChat.projects'], [folder]);
		assert.equal(projects.filter({ type: 'projects', projects: [{ id: folder.toLowerCase(), path: folder, name: 'source' }] }).projects[0].name, 'Updated name');
		const dataDir = path.join(base, 'data');
		const host = await require('./host-fixture').worker(folder, dataDir);
		try {
			host.send({ t: 'activate', handoff: { kind: 'project', name: 'Live project name' }, activationId: 'new-project' });
			const message = await host.next(m => m.type === 'projects' && m.projects.some(p => p.name === 'Live project name'));
			assert.equal(message.projects.find(p => p.name === 'Live project name').path, folder);
			const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
			assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'global-state.json'), 'utf8'))['zer0neDesktop.projectName.' + key], 'Live project name');
		} finally { await host.stop(); }

		const dom = new JSDOM('<body><button id="launch">New Project</button></body>', { runScripts: 'outside-only' });
		const win = dom.window, doc = win.document;
		// jsdom has no top layer; Blink's real modal behavior is exercised in app-smoke.
		win.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
		win.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new win.Event('close')); };
		const calls = []; let pickResult = { selection: 'selection', path: folder, name: 'source' };
		win.__zcShell = { invoke: async (cmd, value) => { calls.push({ cmd, value }); return cmd === 'pick_project_folder' ? pickResult : true; } };
		win.Bridge = { flushState: async () => calls.push({ cmd: 'flush' }) };
		const source = fs.readFileSync(path.join(__dirname, '../app/desktop-ui.js'), 'utf8');
		const begin = source.indexOf('\tfunction createProject()'), end = source.indexOf('\n\twindow.__zcCreateProject = createProject;', begin);
		win.eval('const ICON={x:"",folderPlus:"",computer:""}, bridge=()=>window.__zcShell;' + source.slice(begin, end) + '\nwindow.createProject=createProject;');
		const tick = () => new Promise(resolve => setImmediate(resolve));
		doc.getElementById('launch').focus(); win.createProject();
		win.createProject(); assert.equal(doc.querySelectorAll('dialog').length, 1);
		assert(doc.querySelector('[type="submit"]').disabled);
		const choose = doc.querySelector('.zc-project-choose'); choose.click(); await tick();
		assert.equal(doc.querySelector('input').value, 'source');
		const name = doc.querySelector('input'); name.value = 'Custom name'; name.dispatchEvent(new win.Event('input'));
		pickResult = null; choose.click(); await tick();
		assert.equal(name.value, 'Custom name', 'picker cancel preserves the draft');
		doc.querySelector('[type="submit"]').click();
		assert.equal(doc.querySelector('.zc-project-trust code').textContent, folder);
		assert.equal(calls.filter(c => c.cmd === 'create_project').length, 0);
		doc.querySelector('.zc-project-trust .zc-project-cancel').click();
		assert(!doc.querySelector('.zc-project-trust')); assert.equal(name.value, 'Custom name');
		doc.querySelector('[type="submit"]').click();
		doc.querySelector('.zc-project-trust .zc-project-primary').click(); await tick();
		assert.deepEqual(calls.slice(-2).map(c => c.cmd), ['flush', 'create_project']);
		assert.equal(calls.at(-1).value.name, 'Custom name'); assert.equal(calls.at(-1).value.trusted, true);
		assert(!doc.querySelector('dialog')); assert.equal(doc.activeElement.id, 'launch');
		dom.window.close();
		console.log('project-creation tests passed');
	} finally {
		assert(path.dirname(base) === fs.realpathSync.native(os.tmpdir()) || path.dirname(base) === path.resolve(os.tmpdir()));
		assert(path.basename(base).startsWith('zc-create-'));
		fs.rmSync(base, { recursive: true, force: true });
	}
})().catch(error => { console.error(error); process.exitCode = 1; });
