/*
 * Compiles the coding engine (engine/src) into engine/out with the project's own
 * TypeScript. The build goes to a temporary folder first and replaces engine/out
 * only when it is complete, so a compile error keeps the last working engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
// A build must not replace modules while another validation run is loading them.
const testLock = path.join(root, 'test', 'gui-lock.js');
if (fs.existsSync(testLock)) require(testLock).acquire();
const engine = path.join(root, 'engine');
const out = path.join(engine, 'out');
const temp = path.join(engine, `.out-build-${process.pid}`);
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function remove(folder) {
	// Only the engine's own build folders are ever deleted here.
	if (path.dirname(folder) !== engine || !/^(out|\.out-build-\d+)$/.test(path.basename(folder))) throw new Error('Unsafe engine output path: ' + folder);
	fs.rmSync(folder, { recursive: true, force: true });
}

if (!fs.existsSync(tsc)) {
	console.error('build-engine: TypeScript is missing. Run "npm install" first.');
	process.exit(1);
}
remove(temp);
try {
	execFileSync(process.execPath, [tsc, '-p', path.join(engine, 'tsconfig.json'), '--outDir', temp, '--sourceMap', 'false'], { stdio: 'inherit' });
} catch {
	remove(temp);
	console.error('build-engine: the engine has TypeScript errors (above). engine/out was left as it was.');
	process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(engine, 'package.json'), 'utf8'));
const yaml = path.join(root, 'node_modules', 'js-yaml');
fs.mkdirSync(path.join(temp, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(yaml, 'dist', 'js-yaml.js'), path.join(temp, 'vendor', 'js-yaml.js'));
fs.copyFileSync(path.join(yaml, 'LICENSE'), path.join(temp, 'vendor', 'js-yaml.LICENSE'));
fs.copyFileSync(path.join(engine, 'data', 'llmfit-catalog.json'), path.join(temp, 'vendor', 'llmfit-catalog.json'));
fs.copyFileSync(path.join(engine, 'data', 'llmfit.LICENSE'), path.join(temp, 'vendor', 'llmfit.LICENSE'));
fs.copyFileSync(path.join(engine, 'data', 'llama-architectures.json'), path.join(temp, 'vendor', 'llama-architectures.json'));
fs.copyFileSync(path.join(engine, 'data', 'llama.LICENSE'), path.join(temp, 'vendor', 'llama.LICENSE'));
const app = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
require('./settings-index').build();
fs.writeFileSync(path.join(engine, 'engine.json'), JSON.stringify({ extensionVersion: manifest.version, appVersion: app.version, compiled: true, builtAt: new Date().toISOString() }, null, 2));
// In-page branding and the executable must use the same user-supplied artwork.
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(engine, 'media', 'icon.png'));
remove(out);
fs.renameSync(temp, out);
console.log(`Engine built: zer0ne coding ${manifest.version} → engine/out`);
