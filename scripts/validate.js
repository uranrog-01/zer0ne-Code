'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--built')) throw new Error('Usage: node scripts/validate.js [--built]');
const built = args.includes('--built');
require('../test/gui-lock').acquire();
const sourceEnv = require('../test/test-env').testEnv();
const { snapshot, assertUnchanged } = require('./release-inputs');
const baseline = snapshot(root);
const report = { schema:1, sourceHash:baseline.sourceHash, revision:baseline.revision, dirty:baseline.dirty, startedAt:new Date().toISOString(), steps:[], status:'running' };
const reportFile = path.join(root, 'test/output/validation-report.json');
fs.mkdirSync(path.dirname(reportFile), { recursive:true });
function saveReport() { fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n'); }
function verifyInputs() {
	try { return assertUnchanged(baseline, root); }
	catch (error) { report.status = 'failed'; report.error = error.message; saveReport(); throw error; }
}
process.on('exit', code => { if (report.status === 'running') { report.status = code === 0 ? 'incomplete' : 'failed'; saveReport(); } });
saveReport();
delete sourceEnv.ZER0NE_APP_EXE;
delete sourceEnv.ZER0NE_SMOKE_ONLY;
delete sourceEnv.ZER0NE_TEST_ENGINE_OUT;
delete sourceEnv.ZER0NE_PACKAGED_DIR;
for (const key of ['CSC_LINK','WIN_CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_KEY_PASSWORD']) delete sourceEnv[key];

function run(label, argv, env = sourceEnv) {
	console.log(`\n${label}`);
	const start = performance.now();
	const result = spawnSync(process.execPath, argv, { cwd: root, env, stdio: 'inherit', windowsHide: true });
	report.steps.push({ label, status:result.status === 0 ? 'passed' : 'failed', elapsedMs:Math.round(performance.now() - start), exitCode:result.status });
	if (result.status !== 0) report.status = 'failed';
	saveReport();
	if (result.error) { console.error(result.error.message); process.exit(1); }
	if (result.status !== 0) process.exit(result.status || 1);
}

if (!built) run('Build fresh engine output', ['scripts/build-engine.js']);
run('Type-check the engine', ['node_modules/typescript/bin/tsc', '-p', 'engine', '--noEmit']);
run('Check UI assets and scripts', ['engine/scripts/check-media.js']);
run('Check app scripts', ['scripts/check-app.js']);
run('Check the architecture rules', ['scripts/check-architecture.js']);
run('Lint the app and engine', ['node_modules/@biomejs/biome/bin/biome', 'lint', 'app', 'host', 'ui', 'scripts', 'test', 'engine/src', 'engine/scripts', 'engine/test', 'engine/media', 'engine/vscode-shim.js']);
run('Check that the package holds what it loads', ['scripts/check-shipped.js']);
run('Run the engine suite', ['engine/test/run.js']);
run('Run the app suite from source', ['test/run.js']);
verifyInputs();
const packageEnv = { ...sourceEnv };
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'ZER0NE_SIGN_CERT_SHA1', 'ZER0NE_REQUIRE_SIGNED']) if (process.env[key] !== undefined) packageEnv[key] = process.env[key];
if (!built) run('Package the app', ['scripts/package.js', ...(process.env.ZER0NE_REQUIRE_SIGNED === '1' ? ['--signed'] : [])], packageEnv);
const exe = path.join(root, 'dist', 'win-unpacked', 'zer0ne Code.exe');
if (!fs.existsSync(exe)) throw new Error('The packaged app is missing. Run npm run validate to build it.');
const release = JSON.parse(fs.readFileSync(path.join(root, 'dist/win-unpacked/resources/release.json'), 'utf8'));
if (release.sourceHash !== baseline.sourceHash) throw new Error('The packaged app was built from different source inputs. Run validation without --built.');
require('./prepare-runtime').prepareRuntime(path.dirname(exe));
const packagedEnv = { ...sourceEnv, ZER0NE_APP_EXE: exe };
run('Check the packaged engine and resources', ['test/packaged-smoke.js'], packagedEnv);
run('Check recovery on the packaged runtime', ['test/recovery-protocol.js'], packagedEnv);
run('Run the real packaged app', ['test/app-smoke.js'], packagedEnv);
run('Check packaged performance budgets', ['scripts/benchmark.js'], packagedEnv);
verifyInputs();
report.status = 'passed'; report.finishedAt = new Date().toISOString(); saveReport();
console.log('\nValidation passed: fresh engine, static checks, both suites, and the packaged app.');
