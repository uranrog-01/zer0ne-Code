'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const out = process.env.ZER0NE_TEST_ENGINE_OUT || path.join(__dirname, '../out');
const { ExtensionCatalog } = require(path.join(out, 'tools/extensionCatalog'));
const { PluginHost } = require(path.join(out, 'tools/plugins'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-catalog-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
	const catalog = new ExtensionCatalog();
	try {
		const input = { storage: path.join(tmp, 'storage'), home: path.join(tmp, 'home'), root: path.join(tmp, 'project'), bundledSkills: path.join(tmp, 'bundled'), disabledPlugins: [], activatedPlugins: [], disabledSkills: [], agentState: { disabled: [], models: {} }, desktop: true };
		for (let i = 0; i < 1000; i++) write(path.join(input.storage, 'skills', 'fixture-' + i, 'SKILL.md'), `---\nname: fixture-${i}\ndescription: Large catalog fixture\n---\n${'Skill instructions. '.repeat(150)}`);
		const plugin = path.join(input.root, '.zer0ne/plugins/demo');
		write(path.join(plugin, '.claude-plugin/plugin.json'), '{"name":"demo"}');
		write(path.join(plugin, 'commands/check.md'), '---\ndescription: Fixture command\n---\nCheck the project.');
		const plugins = new PluginHost(input.storage, () => input.root, () => input.disabledPlugins, () => input.activatedPlugins, input.home);
		const initial = plugins.plugins()[0]; input.activatedPlugins = [initial.activationKey];
		const read = fs.readFileSync;
		let ticks = 0;
		const heartbeat = setInterval(() => ticks++, 5);
		const started = performance.now();
		let snapshot;
		try {
			fs.readFileSync = function(file, ...args) { if (typeof file === 'string' && file.startsWith(tmp)) throw new Error('Discovery read on the engine thread'); return read.call(this, file, ...args); };
			const first = catalog.read(input), second = catalog.read(input);
			assert.equal(first, second, 'simultaneous state updates share a scan');
			snapshot = await first;
		} finally { fs.readFileSync = read; clearInterval(heartbeat); }
		assert.equal(snapshot.skills.length, 1000); assert(ticks > 0, 'engine timers keep running during discovery');
		assert(snapshot.commands.some(c => c.name === 'demo:check')); assert(!snapshot.commands.some(c => c.name === 'mod'));
		console.log(`ok  1000 skills discovered off the engine thread (${Math.round(performance.now() - started)}ms; ${ticks} heartbeat ticks)`);
		input.disabledPlugins = [initial.id];
		const disabled = await catalog.read(input);
		assert.equal(disabled.plugins[0].enabled, false); assert(!disabled.commands.some(c => c.name === 'demo:check'));
		input.disabledPlugins = []; input.disabledSkills = [snapshot.skills[0].id];
		const skillDisabled = await catalog.read(input);
		assert.equal(skillDisabled.skills.find(s => s.id === snapshot.skills[0].id).enabled, false);
		write(path.join(plugin, 'commands/check.md'), 'Changed instructions.');
		assert.equal(plugins.plugins()[0].enabled, false, 'execution rechecks content despite a cached presentation snapshot');
		assert(!plugins.commands().some(c => c.name === 'demo:check'));
		await pause(510);
		assert.equal((await catalog.read(input)).plugins[0].enabled, false, 'presentation expires too');
		console.log('ok  configuration changes bypass the cache; changed plugin content loses activation');
		await catalog.worker.terminate();
		await pause(0);
		assert.equal((await catalog.read(input)).plugins[0].enabled, false, 'worker exits can recover with a new worker');
		fs.rmSync(plugin, { recursive: true }); catalog.invalidate();
		assert.equal((await catalog.read(input)).plugins.length, 0, 'explicit removal cannot reuse the cached installation');
		input.disabledPlugins = ['changed'];
		const pending = catalog.read(input); catalog.dispose();
		await assert.rejects(pending, /closed/); await assert.rejects(catalog.read(input), /closed/);
		console.log('ok  worker restart, pending disposal and calls after disposal');
	} finally { catalog.dispose(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
