// The packaging check (scripts/check-shipped.js) passes on this tree and fails on each kind of violation.
'use strict';
const assert = require('assert/strict');
const check = require('../scripts/check-shipped');

assert.deepEqual(check.run(), [], 'what the package loads is in the package');
const { checkDesktopResources, startup } = require('../scripts/desktop-resources');
const uiAssets = require('../scripts/desktop-resources').uiResources("const css=['base.css', ...(desktopHost ? [] : ['analysis.css'])].map(file=>file).join('');const js=['settings-general.js','chat.js'].map(file=>file).join('');");
assert.deepEqual(uiAssets, ['engine/media/base.css', 'engine/media/settings-general.js', 'engine/media/chat.js']);
const { uiResources } = require('../scripts/desktop-resources');
assert.deepEqual(uiResources("const optional=fs.existsSync(path.join(this.mediaDir, 'missing-private-animation-fixture.js')) ? ['missing-private-animation-fixture.js'] : []; const js=['bridge.js', ...optional].map(x=>x).join('');"), ['engine/media/bridge.js']);
assert.deepEqual(uiResources("const optional=fs.existsSync(path.join(this.mediaDir, 'bridge.js')) ? ['bridge.js'] : []; const js=[...optional].map(x=>x).join('');"), ['engine/media/bridge.js']);
assert.throws(() => uiResources("const optional=loadAssets(); const js=[...optional].map(x=>x);"), /Declare the desktop resources/);
assert.match(checkDesktopResources({}, { exists: () => true, shipped: file => file !== 'engine/media/settings-general.js' }, uiAssets).join('\n'), /startup.*settings-general/);
const resourceTree = new Set([...startup, 'engine/out/host/cloudHost.js', 'engine/media/cloud/workflow.yml', 'engine/media/cloud/runner.mjs']);
assert.deepEqual(checkDesktopResources({ cloud: false }, { exists: file => resourceTree.has(file), shipped: () => true }), []);
assert.match(checkDesktopResources({ cloud: true }, { exists: file => resourceTree.has(file), shipped: file => !file.includes('cloudHost') }).join('\n'), /cloud.*excludes.*cloudHost/);
assert.match(checkDesktopResources({ cloud: true }, { exists: file => resourceTree.has(file) && !file.endsWith('runner.mjs'), shipped: () => true }).join('\n'), /cloud.*missing.*runner/);
assert.match(checkDesktopResources({ newFeature: true }, { exists: () => true, shipped: () => true }).join('\n'), /declare its release resources/);

// Exact versions only; registry ranges and tags fail, local and git sources are exempt.
assert.deepEqual(check.checkPinned([['package.json', { devDependencies: { a: '1.2.3', b: '1.0.0-rc.1+build.5', c: 'file:../c', d: 'git+https://x/y.git' } }]]), []);
assert.deepEqual(check.checkPinned([['package.json', { devDependencies: { classic: 'npm:typescript@5.9.3', scoped: 'npm:@example/parser@1.0.0-rc.1+build.5' } }]]), []);
for (const spec of ['^1.2.3', '~1.2.3', '1.x', '*', 'latest', '>=1 <2', '1.2','npm:typescript@^5.9.3','npm:@example/parser@latest','npm:typescript@5.x','npm:typescript@','npm:typescript']) {
	assert.equal(check.checkPinned([['engine/package.json', { devDependencies: { a: spec } }]]).length, 1, spec);
}
assert.match(check.checkPinned([['package.json', { dependencies: { left: '1.0.0' } }]])[0], /runtime dependencies/);

// build.files globs: **, *, {a,b}, ${platform}-${arch}, and negation.
const shipped = check.packager(['app/**', 'engine/out/**', '!engine/out/host/{cloudHost,cliHost}.js', '!**/*.map', 'engine/bin/${platform}-${arch}/**']);
assert.ok(shipped('app/main.js') && shipped('app/x/y.js') && shipped('engine/out/host/acpHost.js'));
assert.ok(!shipped('engine/out/host/cloudHost.js') && !shipped('engine/out/chatController.js.map') && !shipped('host/main.js'));
assert.ok(shipped(`engine/bin/${process.platform}-${process.arch}/tool.exe`) && !shipped('engine/bin/other-arch/tool.exe'));

// A shipped file may load built-ins, electron, vscode and shipped files; nothing else.
const tree = new Set(['engine/out/a.js', 'engine/out/host/cloudHost.js', 'engine/out/host/cliHost.js', 'engine/out/host/unlisted.js', 'engine/out/data.json']);
const env = { exists: (rel) => tree.has(rel), shipped: (rel) => shipped(rel) && rel !== 'engine/out/host/cliHost.js' || rel === 'engine/out/data.json' };
assert.deepEqual(check.checkFile('engine/out/b.js', "require('fs'); require('node:path'); require('fs/promises'); require('vscode'); require('./a'); require('./data.json');", env), []);
assert.match(check.checkFile('engine/out/b.js', "const y = require('js-yaml');", env)[0], /package js-yaml, which the app does not ship/);
assert.match(check.checkFile('engine/out/b.js', "require('./missing')", env)[0], /does not exist/);
assert.match(check.checkFile('engine/out/b.js', "require('./host/unlisted')", { ...env, shipped: (rel) => rel === 'engine/out/a.js' })[0], /leaves out of the package/);
assert.deepEqual(check.checkFile('engine/out/b.js', "// require('js-yaml')\nconst s = \"require('./missing')\";", env), [], 'comments and strings do not count');
assert.deepEqual(check.OPTIONAL, {}, 'removed feature modules have no package exceptions');
for (const [file, why] of Object.entries(check.OPTIONAL)) assert.ok(file.startsWith('engine/out/') && why.length > 20, file);

// The packaged binary ignores NODE_OPTIONS and --inspect and encrypts cookies; each fuse is enforced.
assert.deepEqual(check.checkFuses({ electronFuses: { enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableCookieEncryption: true } }), []);
assert.equal(check.checkFuses({}).length, 3);
assert.match(check.checkFuses({ electronFuses: { enableNodeOptionsEnvironmentVariable: true, enableNodeCliInspectArguments: false, enableCookieEncryption: true } })[0], /enableNodeOptionsEnvironmentVariable must be false/);
// Every shipped helper binary is in its SHA256SUMS, with a matching digest (the tree passes above).
assert.deepEqual(check.checkBundledBinaries(check.packager(require('../package.json').build.files)), []);
const binFixture = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'zer0ne-bin-'));
require('fs').mkdirSync(require('path').join(binFixture, 'win32-x64'));
require('fs').writeFileSync(require('path').join(binFixture, 'win32-x64', 'zer0ne-tools.exe'), 'fixture');
assert.match(check.checkBundledBinaries(() => true, binFixture).join('\n'), /zer0ne-tools\.exe: shipped without a SHA256SUMS entry/, 'an unlisted binary that would ship fails');
require('fs').rmSync(binFixture, { recursive: true, force: true });

console.log('ok  shipped check: the tree passes; ranges, undeclared packages, missing and unpackaged files all fail');
