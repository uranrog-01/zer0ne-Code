// The repository map: symbols, layout, deny rules, size and a prefix that stays stable.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_ENGINE_OUT || path.join(__dirname, '..', 'out');
const { symbolsOf, buildRepoMap, repoMapFor, listProjectFiles } = require(OUT + '/core/repoMap.js');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const project = (files) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-map-'));
	for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
	return root;
};

test('symbolsOf: top-level declarations across languages, names only, nested code ignored', () => {
	assert.deepEqual(symbolsOf('export async function load() {}\nexport class Store {}\nexport const LIMIT = 3;\nfunction local() {\n  function inner() {}\n}\n'), ['load', 'Store', 'LIMIT', 'local']);
	assert.deepEqual(symbolsOf('def run():\n    pass\nclass Job:\n    def inner(self): pass\n'), ['run', 'Job']);
	assert.deepEqual(symbolsOf('func (s *Server) Start() {}\nfunc main() {}\n'), ['Start', 'main']);
	assert.deepEqual(symbolsOf('pub fn parse() {}\npub(crate) struct Token;\nenum Kind {}\n'), ['parse', 'Token', 'Kind']);
	assert.deepEqual(symbolsOf('public sealed class Engine {}\n'), ['Engine']);
	assert.deepEqual(symbolsOf("module.exports = { start, stop: halt, version };\n"), ['start', 'stop', 'version']);
	assert.equal(symbolsOf(Array.from({ length: 30 }, (_, i) => `export function f${i}() {}`).join('\n')).length, 8, 'capped per file');
});

test('buildRepoMap: folders with counts, key files and symbols, within the size cap', () => {
	const root = project({
		'package.json': '{}', 'README.md': '# x',
		'src/index.ts': 'export function main() {}\n', 'src/db/store.ts': 'export class Store {}\n',
		...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/util/u${i}.ts`, `export const u${i} = ${i};\n`])),
		'test/a.test.ts': 'export function testOnly() {}\n'
	});
	try {
		const files = listProjectFiles(root);
		const map = buildRepoMap(root, files);
		assert.match(map, /^Repository map \(25 files/);
		assert.match(map, /src\/ \(22 files: ts 22\)/);
		assert.match(map, / {2}src\/util\/ \(20 files/);
		assert.match(map, /Key files: .*package\.json/);
		assert.match(map, /src\/index\.ts: main/);
		assert.ok(map.indexOf('src/index.ts') < map.indexOf('test/a.test.ts') || !map.includes('test/a.test.ts'), 'tests rank after sources');
		assert.ok(buildRepoMap(root, files, 300).length <= 320, 'the cap holds');
		assert.equal(buildRepoMap(root, ['a.js']), '', 'tiny projects get no map');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repoMapFor: deny rules hide paths, and the text stays the same until files are added or removed', () => {
	const root = project({ 'a.js': 'export function alpha() {}\n', 'b.js': 'export function beta() {}\n', 'secrets/keys.js': 'export const KEY = 1;\n', 'c.js': 'export function gamma() {}\n' });
	try {
		const t0 = 1_000_000;
		const first = repoMapFor(root, 'secrets/**', t0);
		assert.doesNotMatch(first, /secrets|KEY/);
		fs.writeFileSync(path.join(root, 'a.js'), 'export function renamed() {}\n');
		assert.equal(repoMapFor(root, 'secrets/**', t0 + 10 * 60_000), first, 'a content change keeps the cached prefix');
		fs.writeFileSync(path.join(root, 'd.js'), 'export function delta() {}\n');
		assert.equal(repoMapFor(root, 'secrets/**', t0 + 11 * 60_000), first, 'within the recheck window nothing is rebuilt');
		const later = repoMapFor(root, 'secrets/**', t0 + 30 * 60_000);
		assert.notEqual(later, first, 'a new file rebuilds the map after the window');
		assert.match(later, /d\.js: delta/);
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the on-demand tool catalog: families take one line, the rest a short hint', () => {
	const { deferredCatalog, splitDeferred, searchDeferred } = require(OUT + '/tools/deferred.js');
	const t = (name, description = `${name} does a thing. More detail that is not needed here.`) => ({ name, description, parameters: { type: 'object', properties: {} } });
	const rest = [t('browser_click'), t('browser_type'), t('browser_navigate'), t('mcp__srv__a'), t('mcp__srv__b'), t('mcp__srv__c'), t('move_file', 'Move or rename a file inside the workspace.'), t('git_log'), t('git_stage')];
	const lines = deferredCatalog(rest).split('\n');
	assert.deepEqual(lines, [
		'- browser_* (3): click, type, navigate',
		'- mcp__srv__* (3): a, b, c',
		'- move_file: Move or rename a file inside the workspace.',
		'- git_log: git_log does a thing.',
		'- git_stage: git_stage does a thing.'
	]);
	assert.ok(deferredCatalog([t('x', 'y'.repeat(300))]).length < 100, 'hints are short');
	const split = splitDeferred([t('read_file'), ...rest]);
	assert.ok(split.tools.some((d) => d.name === 'read_file') && split.deferred.has('browser_type'));
	assert.deepEqual(searchDeferred(split.deferred, 'browser_type').names, ['browser_type'], 'full names still load from a family line');
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.log('FAIL ' + name + '\n ' + (e && e.stack ? e.stack : e));
		}
	}
	console.log(`\n${tests.length - failed}/${tests.length} passed`);
	process.exit(failed ? 1 : 0);
})();
