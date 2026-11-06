'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const modules = ['cliHost', 'telegramHost', 'channelsHost', 'modsHost', 'modRuntime', 'modsCommand', 'modValidate', 'modStorage', 'modModules', 'modBus', 'dealsHost', 'finderTrust', 'analysisHost', 'announcements', 'scheduler', 'scheduledTurn'];
const removed = modules.flatMap(name => ['engine/src/host/' + name + '.ts', 'engine/out/host/' + name + '.js']).concat(['engine/src/core/analysis.ts', 'engine/out/core/analysis.js', 'engine/media/analysis.js', 'engine/media/analysis.css', 'engine/media/mods', 'engine/media/skills/mod-authoring']);
for (const file of removed) assert(!fs.existsSync(path.join(root, file)), 'Retired implementation remains: ' + file);
const files = ['engine/media/chat.js', 'engine/media/settings.js', 'engine/media/settings-remote.js', 'engine/src/chatController.ts', 'engine/src/tools/plugins.ts'];
const implementations = /\b(?:toggleModsPopup|updateModsPopup|renderModBand|modsPage|modsHooksPage|openModsHelpDialog|finderPage|finderFamilies|analysisCard|cliPage|telegramPage|discordPanel|pushPanel|schedulePage|openJobDialog|modManifests|runModsCommand|runScheduled)\b/;
for (const file of files) assert(!implementations.test(fs.readFileSync(path.join(root, file), 'utf8')), 'Retired implementation remains in ' + file);
if (process.env.ZER0NE_APP_EXE) {
	const asar = require('@electron/asar');
	const archive = path.join(path.dirname(process.env.ZER0NE_APP_EXE), 'resources/app.asar');
	const entries = new Set(asar.listPackage(archive).map(file => file.split(path.sep).join('/').replace(/^\//, '')));
	for (const file of removed) assert(!entries.has(file), 'Retired implementation packaged: ' + file);
	for (const file of files.filter(file => file.endsWith('.js'))) {
		const source = asar.extractFile(archive, path.normalize(file)).toString();
		assert(!implementations.test(source), 'Retired UI packaged in ' + file);
		assert.equal(source, fs.readFileSync(path.join(root, file), 'utf8'), 'Package is stale: ' + file);
	}
}
console.log('Retired features passed: source, generated modules, shared scripts' + (process.env.ZER0NE_APP_EXE ? ', and packaged archive.' : '.'));
