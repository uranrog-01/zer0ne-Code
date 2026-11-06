// The app's tests (npm test): the shell modules, the engine host, the desktop layer, and the
// running app. The engine's own suite is separate: npm run test:engine.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('./gui-lock').acquire();
require('../scripts/prepare-runtime').prepareRuntime();
const { testEnv } = require('./test-env');

if (!fs.existsSync(path.join(__dirname, '..', 'engine', 'out', 'chatController.js'))) {
	console.error('Build the engine first: npm run engine');
	process.exit(1);
}
const suites = [
	'app-units.js',
	'computer-visuals.js',
	'stall-sampler.js',
	'retired-features.js',
	'start-appearance.js',
	'tray-menu.js',
	'tray-menu-window.js',
	'profile-backup.js',
	'profile-actions.js',
	'release-integrity.js',
	'runtime-setup.js',
	'start-menu.js',
	'external-links.js',
	'site-permissions.js',
	'mcp-app-sandbox.js',
	'storage-cache.js',
	'validation-infrastructure.js',
	'package-retry.js',
	'architecture-check.js',
	'shipped-check.js',
	'host-protocol.js',
	'audit-regressions.js',
	'desktop-features.js',
	'desktop-preferences.js',
	'desktop-profile.js',
	'fullscreen.js',
	'window-restore.js',
	'liquid-glass.js',
	'panel-glass.js',
	'panel-glass-native.js',
	'panel-status.js',
	'panel-resize.js',
	'project-panel.js',
	'project-folder-actions.js',
	'project-creation.js',
	'project-sidebar.js',
	'project-chat-controls.js',
	'remote-tunnels.js',
	'shared-project.js',
	'terminal-retention.js',
	'recovery-protocol.js',
	'work-details-protocol.js'
];
// Packaged tests run only when the caller explicitly selects a built app.
if (process.env.ZER0NE_APP_EXE) suites.push('packaged-smoke.js');
suites.push('glow-beam.js', 'projects-panel.js', 'app-smoke.js');

let failed = 0;
for (const file of suites) {
	const started = Date.now();
	const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit', timeout: 10 * 60_000, env: testEnv() });
	const ok = r.status === 0;
	failed += ok ? 0 : 1;
	console.log(`\n${ok ? 'PASS' : 'FAIL'} ${file} (${((Date.now() - started) / 1000).toFixed(1)}s)\n`);
}
console.log(failed ? `${failed} suite(s) failed.` : 'All suites passed.');
process.exit(failed ? 1 : 0);
