// Edit safety: the Harness Observatory matching fixtures (docs/harness-benchmark-analysis-for-zer0ne.md),
// read-before-edit / write-if-unchanged in both tool layers, multi_edit against the original, BOM kept.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const { findUnique, adaptReplacement, matchNote } = require(OUT + '/tools/patch.js');

/** zer0ne's edit_file decision on one fixture: unique / ambiguous / missing / empty. */
function decide(content, search) {
	if (!search) return 'empty';
	const n = content.split(search).length - 1;
	if (n === 1) return 'unique';
	if (n > 1) return 'ambiguous';
	try {
		findUnique(content, search, 'f');
		return 'unique';
	} catch (e) {
		return /matches \d+ places/.test(e.message) ? 'ambiguous' : 'missing';
	}
}

test('benchmark fixtures: 7/7 safety, 6/6 recovery, the changed-value near match is refused', () => {
	const cases = [
		['safety', 'const A = 1;\nconst B = 2;', 'const A = 1;', 'unique'],
		['safety', 'same\nsame', 'same', 'ambiguous'],
		['safety', 'const A = 1;', 'const Z = 1;', 'missing'],
		['safety', 'abc', '', 'empty'],
		['safety', 'const 名字 = "你好";', '名字', 'unique'],
		['safety', '你好\n你好', '你好', 'ambiguous'],
		['safety', 'one\ntwo\nend', 'end', 'unique'],
		['recovery', 'const A = 1;   \nnext', 'const A = 1;\n', 'unique'],
		['recovery', 'const A = “hello”;', 'const A = "hello";', 'unique'],
		['recovery', 'const A = 1;\nconst B = 2;', '1\tconst A = 1;\n2\tconst B = 2;', 'unique'],
		['recovery', '    a();\n    b();', 'a();\nb();', 'unique'],
		['recovery', 'a();\nb();', 'a();\\nb();', 'unique'],
		['recovery', 'const 名字 = 1;', 'const \\u540d\\u5b57 = 1;', 'unique'],
		['risk', 'a();\ncall(100);\nb();', 'a();\ncall(900);\nb();', 'missing']
	];
	for (const [group, content, search, expected] of cases) {
		assert.strictEqual(decide(content, search), expected, `${group}: ${JSON.stringify(search)}`);
	}
});

test('corrections carry over to new_string only when it shows the same slip', () => {
	const content = 'const A = 1;\nconst B = 2;\n';
	let m = findUnique(content, '1\tconst A = 1;\n2\tconst B = 2;', 'f');
	assert.strictEqual(m.strategy, 'line numbers');
	assert.strictEqual(adaptReplacement(m, '', '1\tconst A = 10;\n2\tconst B = 20;'), 'const A = 10;\nconst B = 20;');
	assert.strictEqual(adaptReplacement(m, '', 'const A = 10;'), 'const A = 10;', 'unnumbered replacement untouched');
	assert.match(matchNote(m), /line 1 .*line numbers/);

	m = findUnique('a();\nb();', 'a();\\nb();', 'f');
	assert.strictEqual(adaptReplacement(m, '', 'a();\\nc();'), 'a();\nc();', 'double-escaped payload unescaped');
	assert.strictEqual(adaptReplacement(m, '', 'log("x\\n");\nc();'), 'log("x\\n");\nc();', 'a real newline means the escapes are code');

	m = findUnique('say “hi” now', 'say "hi" now', 'f');
	assert.strictEqual(adaptReplacement(m, 'say "hi" now', 'say "hello" now'), 'say “hello” now', 'typographic quotes kept');
	m = findUnique('x = "a" + “b”', 'x = "a" + "b"', 'f');
	assert.strictEqual(adaptReplacement(m, 'x = "a" + "b"', 'x = "a" + "c"'), 'x = "a" + "c"', 'mixed region: straight quotes stay code');

	const exact = findUnique(content, 'const B = 2;', 'f');
	assert.strictEqual(exact.how, 'exact');
	assert.strictEqual(exact.line, 2);
	assert.strictEqual(matchNote(exact), '');
});

test('CoreTools: read before edit, refuse stale and unseen files, write only if unchanged after approval', async () => {
	const { CoreTools } = require(OUT + '/core/tools.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-guard-'));
	fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
	let onApprove = () => {};
	const tools = new CoreTools({ root, approve: async () => (onApprove(), true) });
	const call = (name, args) => tools.run(name, args);

	let r = await call('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' });
	assert.ok(r.error && /has not been read/.test(r.output), 'unseen file refused: ' + r.output);

	await call('read_file', { path: 'a.txt' });
	r = await call('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'TWO' });
	assert.ok(!r.error, r.output);
	r = await call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' });
	assert.ok(!r.error, 'own write counts as seen: ' + r.output);

	fs.writeFileSync(path.join(root, 'a.txt'), 'ONE\nTWO\nuser line\n');
	r = await call('edit_file', { path: 'a.txt', old_string: 'TWO', new_string: '2' });
	assert.ok(r.error && /changed since you last read/.test(r.output), 'external change refused: ' + r.output);

	await call('read_file', { path: 'a.txt' });
	onApprove = () => fs.writeFileSync(path.join(root, 'a.txt'), 'typed while the prompt was open\n');
	r = await call('edit_file', { path: 'a.txt', old_string: 'TWO', new_string: '2' });
	assert.ok(r.error && /while waiting for approval/.test(r.output), 'change during approval refused: ' + r.output);
	assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'typed while the prompt was open\n', 'nothing written');
	onApprove = () => {};

	fs.writeFileSync(path.join(root, 'b.txt'), 'existing');
	r = await call('write_file', { path: 'b.txt', content: 'replaced' });
	assert.ok(r.error && /has not been read/.test(r.output), 'overwrite of unseen file refused: ' + r.output);
	r = await call('write_file', { path: 'new.txt', content: 'fresh' });
	assert.ok(!r.error && fs.readFileSync(path.join(root, 'new.txt'), 'utf8') === 'fresh', 'new file created');
	onApprove = () => fs.writeFileSync(path.join(root, 'late.txt'), 'someone else');
	r = await call('write_file', { path: 'late.txt', content: 'mine' });
	assert.ok(r.error && /created while waiting/.test(r.output), 'file created during approval not overwritten: ' + r.output);
	assert.strictEqual(fs.readFileSync(path.join(root, 'late.txt'), 'utf8'), 'someone else');
	fs.rmSync(root, { recursive: true, force: true });
});

test('agent tools: guard per chat, multi_edit matched against the original, overlaps refused, BOM kept', async () => {
	const { createShim, install } = require('./vscode-shim');
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'z0-agent-'));
	const shim = createShim({ dataDir: path.join(ws, '.data'), workspace: ws });
	install(shim.vscode);
	const { runTool } = require(OUT + '/tools/agentTools.js');
	const ctx = (sessionId) => ({ sessionId, store: undefined, settings: { denyPaths: '' }, signal: new AbortController().signal, vision: false, requestApproval: async () => ({ approved: true, finish() {} }) });
	const run = (c, name, args) => runTool({ id: 'x', name, arguments: JSON.stringify(args) }, c);
	const a = ctx('chat-a');
	const b = ctx('chat-b');

	fs.writeFileSync(path.join(ws, 'm.ts'), 'const one = 1;\nconst two = 2;\n');
	let r = await run(a, 'read_file', { path: 'm.ts', full: true });
	assert.ok(!r.error, r.api);
	r = await run(b, 'edit_file', { path: 'm.ts', old_string: 'const one = 1;', new_string: 'const one = 11;' });
	assert.ok(r.error && /has not been read/.test(r.api), 'another chat has not read it: ' + r.api);

	// Edit 1 creates a second "const two = 2;" — matched against the original, edit 2 still hits the intended line.
	r = await run(a, 'multi_edit', { path: 'm.ts', edits: [{ old_string: 'const one = 1;', new_string: 'const two = 2; // was one' }, { old_string: 'const two = 2;', new_string: 'const two = 22;' }] });
	assert.ok(!r.error, r.api);
	assert.strictEqual(fs.readFileSync(path.join(ws, 'm.ts'), 'utf8'), 'const two = 2; // was one\nconst two = 22;\n');

	r = await run(a, 'multi_edit', { path: 'm.ts', edits: [{ old_string: 'const two = 22;', new_string: 'x' }, { old_string: 'two = 22', new_string: 'y' }] });
	assert.ok(r.error && /overlap/.test(r.api), 'overlapping edits refused: ' + r.api);

	// Chained edits (edit 2 targets edit 1's new text) still apply in order.
	r = await run(a, 'multi_edit', { path: 'm.ts', edits: [{ old_string: 'const two = 22;', new_string: 'const three = 3;' }, { old_string: 'const three = 3;', new_string: 'const three = 33;' }] });
	assert.ok(!r.error, r.api);
	assert.ok(fs.readFileSync(path.join(ws, 'm.ts'), 'utf8').includes('const three = 33;'));

	const bomFile = path.join(ws, 'bom.cs');
	fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('class A {}\n')]));
	await run(a, 'read_file', { path: 'bom.cs', full: true });
	r = await run(a, 'edit_file', { path: 'bom.cs', old_string: 'class A {}', new_string: 'class B {}' });
	assert.ok(!r.error, r.api);
	const bytes = fs.readFileSync(bomFile);
	assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM kept');
	assert.strictEqual(bytes.subarray(3).toString(), 'class B {}\n');
	fs.rmSync(ws, { recursive: true, force: true });
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
	process.exit(failed ? 1 : 0);
})();
