// Unit tests for pure modules (no VS Code needed): redaction, patch format,
// fuzzy matching, Token Saver filters, line stats, command expansion, markdown.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, '..', 'out');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('redaction masks secrets but keeps code readable', () => {
	const { redactSecrets, assertNoRedaction, REDACTED } = require(OUT + '/tools/redact.js');
	const input = [
		'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
		'export DB_PASSWORD="hunter2hunter2"',
		'const password = input.value; // code stays',
		'postgres://admin:s3cr3tpass@db.example.com:5432/app',
		'Authorization: Bearer abcdefghijklmnop.qrstuv',
		'aws AKIAABCDEFGHIJKLMNOP and ghp_' + 'a'.repeat(36),
		'-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
		'PORT=3000'
	].join('\n');
	const { text, count } = redactSecrets(input);
	assert.ok(!/sk-proj|hunter2|s3cr3tpass|abcdefghijklmnop\.|AKIAABCD|ghp_a|MIIEow/.test(text), text);
	assert.ok(text.includes('const password = input.value'), 'source code untouched');
	assert.ok(text.includes('PORT=3000'), 'non-secret env untouched');
	assert.ok(text.includes('postgres://admin:' + REDACTED + '@db.example.com'));
	assert.ok(count >= 7, 'count ' + count);
	assert.throws(() => assertNoRedaction('X=' + REDACTED, '.env'), /hidden from you/);
	assert.strictEqual(redactSecrets(text).count, 0, 'idempotent');
});

test('redaction covers many token families, in tiers', () => {
	const { redactSecrets, REDACTED, DETECTOR_IDS } = require(OUT + '/tools/redact.js');
	const samples = {
		'gitlab-deploy-token': 'gldt-9f8a7b6c5d4e3f2a1b0c9d8e',
		'gitlab-runner-token': 'glrt-9f8a7b6c5d4e3f2a1b0c9d8e',
		'stripe-webhook-secret': 'whsec_' + 'q'.repeat(28),
		'sendgrid-api-token': 'SG.abcdefghij1234567890.abcdefghij12345678901234567890',
		'digitalocean-token': 'dop_v1_' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
		'sentry-org-token': 'sntrys_' + 'x'.repeat(48),
		'pypi-upload-token': 'pypi-AgEIcHlwaS5vcmcCLokGEpZxyz1234567890',
		'postman-api-token': 'PMAK-' + 'v'.repeat(24),
		'pulumi-api-token': 'pul-' + 'p'.repeat(36),
		'vault-token': 'hvs.' + 'Zq7'.repeat(9),
		'terraform-cloud-token': 'abcdefgh12345678.atlasv1.' + 'w'.repeat(30),
		'azure-storage-key': 'AccountKey=' + 'b3BlbnNlY3JldHRleXRleXRleXRleXRleXU=' + 'A'.repeat(8),
		'aws-temporary-key': 'ASIAJ4EIXAMPLE123456',
		'google-oauth-token': 'ya29.' + 'c'.repeat(30),
		'slack-webhook-url': 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX'
	};
	for (const id of Object.keys(samples)) {
		const r = redactSecrets(samples[id]);
		assert.strictEqual(r.count, 1, `${id} counts exactly one`);
		assert.ok(!r.text.includes(samples[id]), `${id} masked`);
		assert.strictEqual(redactSecrets(r.text).count, 0, `${id} idempotent`);
	}
	assert.ok(new Set(DETECTOR_IDS).size === DETECTOR_IDS.length && DETECTOR_IDS.length >= 30, 'detector inventory ' + DETECTOR_IDS.length);
	// Tiers: the high tier (token shapes) leaves quoted JSON names alone; the full run masks them.
	const json = '{"api_key": "0123456789abcdef"}';
	assert.strictEqual(redactSecrets(json, { tier: 'high' }).text, json, 'high tier does not touch quoted names');
	assert.ok(redactSecrets(json).text.includes(REDACTED), 'both tiers mask quoted JSON secrets');
	// Source code stays readable in either tier.
	const code = 'const password = input.value; // code stays';
	assert.strictEqual(redactSecrets(code).text, code);
});

test('egress table families, the nonessential toggle, always-on traffic', () => {
	const { egressDecision, egressGate, egressBlockError, EGRESS_TABLE } = require(OUT + '/core/egress.js');
	// No setting → everything in the table is allowed (documented, not blocked).
	assert.ok(egressDecision('https://models.dev/api.json').allowed, 'catalogs allowed by default');
	// The one toggle skips the nonessential families — catalogs and feeds.
	const off = { disableNonessentialNetwork: true };
	assert.strictEqual(egressDecision('https://models.dev/api.json', off).purpose, 'Model catalog');
	assert.ok(!egressDecision('https://models.dev/api.json', off).allowed, 'catalog skipped');
	assert.ok(!egressDecision('https://status.openai.com/api/v2/summary.json', off).allowed, 'status probes skipped');
	assert.ok(!egressDecision('https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=free', off).allowed, 'announcement sources skipped');
	assert.ok(!egressDecision('https://hn.algolia.com/api/v1/search_by_date?query=free%20model', off).allowed, 'Hacker News skipped');
	assert.strictEqual(egressDecision('https://artificialanalysis.ai/api/v2/language/models/free?page=1', off).family, 'catalog', 'Intelligence data is a catalog read');
	// Provider paths on catalog hosts stay unskippable: path-specific entries win over keine.
	assert.ok(egressDecision('https://openrouter.ai/api/v1/chat/completions', off).allowed, 'inference on a catalog host is not skipped');
	// Essential traffic has no switch: loopback, LAN, unknown hosts (any provider baseUrl), bridges.
	assert.strictEqual(egressDecision('http://127.0.0.1:11434/v1/chat', off).family, 'local');
	assert.ok(egressDecision('http://127.0.0.1:11434/v1/chat', off).allowed, 'loopback always passes');
	assert.ok(egressDecision('https://api.example.com/v1/chat/completions', off).allowed, 'unknown hosts are treated as provider requests');
	assert.ok(egressDecision('https://api.github.com/repos/x/repo/.claude-plugin/marketplace.json', off).allowed, 'your own repos always pass');
	assert.strictEqual(egressDecision('https://raw.githubusercontent.com/mnfst/awesome-free-llm-apis/main/data.json', off).family, 'catalog', 'specific catalog entries beat the generic github entry');
	// Table sanity and the user-facing refusal.
	assert.ok(EGRESS_TABLE.every((e) => e.match === e.match.toLowerCase() && e.purpose && e.match.length >= 6), 'every entry declares a purpose');
	assert.match(egressBlockError('https://models.dev/api.json', egressDecision('https://models.dev/api.json', off)), /Settings → Safety/);
	assert.throws(() => egressGate(off)('https://models.dev/api.json'), /essential network/i, 'gated sites throw');
	assert.doesNotThrow(() => egressGate(off)('https://api.example.com/v1/chat/completions'), 'gate never blocks model traffic');
});

test('apply_patch parse + apply (context, EOF, CRLF-agnostic)', () => {
	const { parsePatch, applyChunks, findUnique, reindent } = require(OUT + '/tools/patch.js');
	const hunks = parsePatch('*** Begin Patch\n*** Update File: a.ts\n@@ function b() {\n-  return 2;\n+  return 3;\n*** Add File: n.ts\n+x\n*** Delete File: old.ts\n*** End Patch');
	assert.deepStrictEqual(hunks.map((h) => h.type), ['update', 'add', 'delete']);
	const out = applyChunks('function a() {\n  return 2;\n}\nfunction b() {\n  return 2;\n}\n', hunks[0].chunks, 'a.ts');
	assert.strictEqual(out, 'function a() {\n  return 2;\n}\nfunction b() {\n  return 3;\n}\n', 'anchored to the right function');
	assert.throws(() => applyChunks('nothing here\n', hunks[0].chunks, 'a.ts'), /context line/);
	const m = findUnique('if (x) {\n\t\tdoIt();\n}\n', '    doIt();', 'f');
	assert.strictEqual(m.how, 'fuzzy');
	assert.strictEqual(reindent(m.text, '    doIt();', '    doIt(2);'), '\t\tdoIt(2);');
	assert.throws(() => findUnique('a\na\n', 'a', 'f'), /matches 2 places/);
});

test('Token Saver keeps failures, compacts diff/grep/build', () => {
	const { compressOutput } = require(OUT + '/tools/tokenSaver.js');
	const build = ['npm warn deprecated x@1: old', ...Array.from({ length: 40 }, (_, i) => `   Compiling c${i} v0.${i}.0`), 'FAIL src/a.test.ts', '  ● adds', '    Expected: 3', '    Received: 4', 'npm error Test failed.'].join('\n');
	const b = compressOutput(build);
	assert.strictEqual(b.stats.filter, 'build');
	assert.match(b.text, /\[compiled 40 packages\][\s\S]*FAIL src\/a\.test\.ts[\s\S]*Received: 4/);
	const grep = Array.from({ length: 30 }, (_, i) => `src/file${i % 2}.ts:${i + 1}: const v${i} = ${i};`).join('\n');
	assert.strictEqual(compressOutput(grep).stats.filter, 'grep');
	const diff = 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n'.repeat(12);
	const d = compressOutput(diff, 40000, 'diff');
	assert.ok(!d.text.includes('index 1..2') && d.text.includes('(+1 −1)'));
});

test('lineStats counts lines correctly', () => {
	const { lineStats } = require(OUT + '/tools/diffStats.js');
	assert.deepStrictEqual(lineStats(null, 'new\n'), { added: 1, removed: 0 });
	assert.deepStrictEqual(lineStats('a\nb\nc\n', 'a\nB\nc\nd\n'), { added: 2, removed: 1 });
	assert.deepStrictEqual(lineStats('a\n', null), { added: 0, removed: 1 });
});

test('diffHunks finds separate change blocks', () => {
	const { diffHunks, applyHunks } = require(OUT + '/tools/diffStats.js');
	const a = 'one\ntwo\nthree\nfour\nfive\nsix\n';
	const b = 'one\nTWO\nthree\nfour\nfive\nSIX\nseven\n';
	const hunks = diffHunks(a, b);
	assert.strictEqual(hunks.length, 2, JSON.stringify(hunks));
	assert.strictEqual(applyHunks(a, b, hunks, new Set()), b, 'all hunks kept = new text');
	assert.strictEqual(applyHunks(a, b, hunks, new Set([0])), 'one\ntwo\nthree\nfour\nfive\nSIX\nseven\n', 'first hunk rejected');
	assert.strictEqual(applyHunks(a, b, hunks, new Set([0, 1])), a, 'all rejected = original');
});

test('custom command expansion', () => {
	const { expandCommand } = require(OUT + '/tools/plugins.js');
	assert.strictEqual(expandCommand('Deploy to $1 now ($ARGUMENTS)', 'staging "fast mode"'), 'Deploy to staging now (staging "fast mode")');
	assert.strictEqual(expandCommand('Review the diff.', 'focus on auth'), 'Review the diff.\n\nfocus on auth');
});

test('markdown: file links, mentions, mermaid block', () => {
	global.window = { Icons: { svg: () => '<svg/>' } };
	// biome-ignore lint/security/noGlobalEval: loads the page script under test into this context
	eval(fs.readFileSync(path.join(__dirname, '..', 'media', 'markdown.js'), 'utf8'));
	const M = global.window.Markdown;
	assert.match(M.render('see [chat.ts](src/chat.ts#L4)'), /class="file-link" href="#" data-open="src\/chat\.ts" data-line="4"/);
	assert.match(M.render('fix @src/a.ts', { mentions: true }), /class="mention" data-open="src\/a\.ts"/);
	assert.ok(!/mention/.test(M.render('npm i @types/node')), 'no chips in assistant text');
	assert.match(M.render('```mermaid\ngraph TD; A-->B\n```'), /class="mermaid-block"/);
	// A fence with no closing marker is still arriving: the header says so, a closed one does not.
	const closed = M.render('```ts\nconst a = 1;\n```');
	assert.ok(!/data-open/.test(closed) && !/code-writing/.test(closed), 'a closed fence carries no writing label');
	const open = M.render('```ts\nconst a = 1;');
	assert.match(open, /data-open="1"/, 'an unclosed fence is marked as still being written');
	assert.match(open, /class="code-writing">· writing</, 'the header shows the writing label');
	assert.match(open, /tok-kw/, 'the unfinished block is still highlighted as code');
});

test('git worktrees: create, list, dirty check, remove (branch kept)', async () => {
	const { execFileSync } = require('child_process');
	const os = require('os');
	const wt = require(OUT + '/worktrees.js');
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zwt-'));
	const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' }).toString();
	g('init', '-q', '-b', 'main');
	g('config', 'user.email', 't@t');
	g('config', 'user.name', 't');
	fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
	await assert.rejects(wt.createWorktree(repo, 'task'), /no commits yet/);
	g('add', '.');
	g('commit', '-q', '-m', 'init');
	const w1 = await wt.createWorktree(repo, 'Add dark mode!');
	const w2 = await wt.createWorktree(repo, 'Add dark mode!');
	assert.strictEqual(w1.branch, 'zer0ne/add-dark-mode');
	assert.strictEqual(w2.branch, 'zer0ne/add-dark-mode-2', 'unique names');
	assert.ok(fs.existsSync(path.join(w1.path, 'a.txt')) && w1.path.includes(path.basename(repo) + '.worktrees'));
	const list = await wt.listWorktrees(repo);
	assert.deepStrictEqual(list.filter((x) => !x.main).map((x) => x.branch).sort(), ['zer0ne/add-dark-mode', 'zer0ne/add-dark-mode-2']);
	assert.strictEqual(await wt.isDirty(w1.path), false);
	fs.writeFileSync(path.join(w1.path, 'b.txt'), 'y');
	assert.strictEqual(await wt.isDirty(w1.path), true);
	await assert.rejects(wt.removeWorktree(repo, w1.path, false));
	await wt.removeWorktree(repo, w1.path, true);
	await wt.removeWorktree(repo, w2.path, false);
	assert.ok(!fs.existsSync(w1.path));
	assert.match(g('branch', '--list', 'zer0ne/*'), /add-dark-mode/, 'branches kept');
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(repo + '.worktrees', { recursive: true, force: true });
});

test('code index: tokenizer, chunks, BM25 ranking, incremental refresh, embeddings + fusion', async () => {
	const os = require('os');
	const http = require('http');
	const { CodeIndex, tokenize, chunkFile } = require(OUT + '/tools/codeIndex.js');
	assert.deepStrictEqual(tokenize('getUserName user_id'), ['getusername', 'get', 'user', 'name', 'user_id', 'user', 'id']);
	const chunks = chunkFile('a.ts', Array.from({ length: 150 }, (_, i) => (i % 50 === 49 ? '' : 'line ' + i)).join('\n'));
	assert.ok(chunks.length >= 3 && chunks[0].start === 1 && chunks[1].start === chunks[0].end + 1, JSON.stringify(chunks.map((c) => [c.start, c.end])));

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zidx-'));
	const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
	w('src/auth/login.ts', 'export async function verifyPassword(user: User, password: string) {\n  return bcrypt.compare(password, user.passwordHash);\n}\n');
	w('src/http/retry.ts', 'export async function fetchWithRetry(url: string, attempts = 3) {\n  for (let i = 0; i < attempts; i++) { try { return await fetch(url); } catch {} }\n}\n');
	w('src/ui/button.css', '.button { color: red; }\n');
	w('image.png', 'binary');
	const listed = () => Promise.resolve(['src/auth/login.ts', 'src/http/retry.ts', 'src/ui/button.css', 'image.png']);
	const store = path.join(root, '.idx', 'i.json');
	const idx = new CodeIndex(store, root, listed);
	let hits = await idx.search('password verification', 5);
	assert.strictEqual(hits[0].file, 'src/auth/login.ts', JSON.stringify(hits));
	hits = await idx.search('retry fetch attempts', 5);
	assert.strictEqual(hits[0].file, 'src/http/retry.ts');
	assert.deepStrictEqual(idx.stats(), { files: 3, chunks: 3, embedded: 0 }, 'png skipped');
	// incremental: change one file, the index follows
	await new Promise((r) => setTimeout(r, 20));
	w('src/http/retry.ts', 'export function backoffDelay(attempt: number) { return 2 ** attempt * 100; }\n');
	hits = await idx.search('backoff delay', 5);
	assert.strictEqual(hits[0].file, 'src/http/retry.ts');
	assert.ok(fs.existsSync(store), 'persisted');

	// embeddings: fake endpoint that maps texts about "auth" to one direction
	const server = http.createServer((req, res) => {
		let b = '';
		req.on('data', (c) => (b += c));
		req.on('end', () => {
			const { input, model } = JSON.parse(b);
			res.writeHead(200, { Connection: 'close' });
			res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: /password|login|sign.?in|auth/i.test(t) ? [1, 0, 0] : [0, 1, 0] })), model }));
		});
	});
	await new Promise((r) => server.listen(0, r));
	const embed = { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'k', model: 'fake-embed' };
	hits = await idx.search('how do users sign in', 3, embed);
	assert.strictEqual(hits[0].file, 'src/auth/login.ts', 'found by meaning: ' + JSON.stringify(hits));
	assert.match(hits[0].via, /meaning/);
	assert.strictEqual(idx.stats().embedded, 3);
	await new Promise((r) => server.close(r));
	fs.rmSync(root, { recursive: true, force: true });
});

test('knowledge index: project documentation joins code with a doc label', async () => {
	const os = require('os');
	const { CodeIndex, isKnowledgeFile } = require(OUT + '/tools/codeIndex.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zknow-'));
	const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
	w('README.md', '# Billing\nHow invoices and refunds work for every customer.');
	w('docs/runbook.rst', 'Deployment runbook\n==================\nRollback: restore the previous image and drain the queue.');
	w('notes/onboarding.txt', 'Onboarding checklist for new engineers: access, laptop, first task.');
	w('src/billing.ts', 'export function invoice(customer: Customer) { return customer.amount; }\n');
	w('image.png', 'binary');
	const listed = ['README.md', 'docs/runbook.rst', 'notes/onboarding.txt', 'src/billing.ts', 'image.png'];
	const idx = new CodeIndex(path.join(root, '.idx', 'i.json'), root, () => Promise.resolve(listed));
	let hits = await idx.search('deployment rollback runbook', 5);
	assert.strictEqual(hits[0].file, 'docs/runbook.rst');
	assert.strictEqual(hits[0].kind, 'doc');
	hits = await idx.search('invoice function', 5);
	assert.ok(hits.some((h) => h.file === 'src/billing.ts' && h.kind === 'code'));
	hits = await idx.search('invoices refunds', 5);
	assert.ok(hits.some((h) => h.file === 'README.md' && h.kind === 'doc'), 'Markdown is documentation');
	assert.strictEqual(idx.stats().files, 4, 'image skipped');
	assert.strictEqual(isKnowledgeFile('manual.pdf'), true);
	assert.strictEqual(isKnowledgeFile('src/app.ts'), false);
	fs.rmSync(root, { recursive: true, force: true });
});

test('memory: vectors, rank fusion, duplicate groups and capture filters', () => {
	const { encodeVector, decodeVector, cosineSimilarity, fuseRanks, groupDuplicates, worthRemembering, parseMemoryExtraction, looksSensitive } = require(OUT + '/tools/memoryIndex.js');
	const same = decodeVector(encodeVector([1, 0, 0.5]));
	assert.ok(Math.abs(cosineSimilarity(same, decodeVector(encodeVector([1, 0, 0.5]))) - 1) < 1e-6);
	assert.strictEqual(cosineSimilarity(decodeVector(encodeVector([1, 0])), decodeVector(encodeVector([0, 1]))), 0);
	assert.strictEqual(cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2])), 0, 'mismatched dimensions');
	const fused = fuseRanks([{ via: 'keywords', items: ['a', 'b', 'c'] }, { via: 'meaning', items: ['c', 'a'] }], (x) => x);
	assert.strictEqual(fused[0].item, 'a', JSON.stringify(fused));
	assert.deepStrictEqual(fused.find((x) => x.item === 'c').via.sort(), ['keywords', 'meaning']);
	const vector = (x) => decodeVector(encodeVector(x.v));
	const groups = groupDuplicates([{ id: 'a', v: [1, 0] }, { id: 'b', v: [0.99, 0.01] }, { id: 'c', v: [0, 1] }], vector, 0.9);
	assert.strictEqual(groups.length, 1);
	assert.strictEqual(groups[0].keep.id, 'a');
	assert.strictEqual(groups[0].others[0].id, 'b');
	assert.ok(worthRemembering('The project uses pnpm workspaces for every package.'));
	assert.ok(worthRemembering('When npm test fails with EADDRINUSE, stop the leftover node process and rerun.'));
	assert.ok(!worthRemembering('Ran npm test in C:\\Users\\me\\project and saw exit code 1.'));
	assert.ok(!worthRemembering('I created the file src/a.ts.'));
	assert.ok(!worthRemembering('ok'));
	assert.deepStrictEqual(parseMemoryExtraction('```json\n{"facts":[{"text":"Prefers pnpm.","area":"fact"},{"text":"Fix the port clash by stopping the old process.","area":"solution"}]}\n```'), [
		{ text: 'Prefers pnpm.', area: 'fact' },
		{ text: 'Fix the port clash by stopping the old process.', area: 'solution' }
	]);
	assert.deepStrictEqual(parseMemoryExtraction('not json'), []);
	assert.ok(looksSensitive('The API key is rotated monthly.'));
	assert.ok(!looksSensitive('The token budget is 200k.'));
});

test('deny rules: gitignore-style globs', () => {
	const { compileDeny, denyGlobs } = require(OUT + '/tools/deny.js');
	const d = compileDeny('**/*.pem\nsecrets/\nid_rsa*\n# comment\nconfig/prod.env');
	assert.ok(d('certs/server.pem') && d('server.pem'));
	assert.ok(d('secrets/a/b.txt') && d('secrets/x'));
	assert.ok(d('home/.ssh/id_rsa') && d('id_rsa.pub'));
	assert.ok(d('config/prod.env') && !d('other/config/prod.env'));
	assert.ok(!d('src/pem.ts') && !d('secretsauce/x'));
	assert.deepStrictEqual(denyGlobs('*.pem\nsecrets/'), ['!**/*.pem', '!secrets/']);
});

test('PDF text: plain, Flate-compressed, and CID font with a ToUnicode map', () => {
	const zlib = require('zlib');
	const { pdfText, readable } = require(OUT + '/tools/documents.js');
	const obj = (n, body) => n + ' 0 obj\n' + body + '\nendobj\n';
	const stream = (dict, data) => '<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n' + data.toString('latin1') + '\nendstream';
	const page1 = Buffer.from('BT /F1 12 Tf 72 700 Td (Invoice total: 1,250.00 EUR) Tj 0 -14 Td (Due \\(net 30\\)) Tj ET');
	const page2 = zlib.deflateSync(Buffer.from('BT /F1 12 Tf 72 700 Td [(Compressed) -300 (page)] TJ ET'));
	// CID font: glyph ids 0001-0003 map to "Zer" via ToUnicode
	const page3 = Buffer.from('BT /F2 12 Tf 72 700 Td <000100020003> Tj ET');
	const cmap = Buffer.from('/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <005A> <0002> <0065> endbfchar 1 beginbfrange <0003> <0003> <0072> endbfrange endcmap end end');
	const pdf = Buffer.from('%PDF-1.4\n' +
		obj(1, '<< /Type /Page >>') + obj(2, '<< /Type /Page >>') + obj(3, '<< /Type /Page >>') +
		obj(4, stream('', page1)) + obj(5, stream('/Filter /FlateDecode', page2)) + obj(6, stream('', page3)) + obj(7, stream('', cmap)) + '%%EOF', 'latin1');
	const r = pdfText(pdf);
	assert.strictEqual(r.pages, 3);
	assert.match(r.text, /Invoice total: 1,250\.00 EUR\nDue \(net 30\)/, r.text);
	assert.match(r.text, /Compressed page/);
	assert.match(r.text, /Zer/, 'CID glyphs decoded through ToUnicode');
	assert.ok(readable(r.text) > 0.9);
	assert.throws(() => pdfText(Buffer.from('not a pdf')), /Not a PDF/);
});

test('GLM-OCR request (layout_parsing) and endpoint mapping', async () => {
	const http = require('http');
	const { glmOcr, ocrEndpoint } = require(OUT + '/tools/documents.js');
	assert.strictEqual(ocrEndpoint('https://api.z.ai/api/coding/paas/v4'), 'https://api.z.ai/api/paas/v4/layout_parsing');
	assert.strictEqual(ocrEndpoint('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/api/paas/v4/layout_parsing');
	assert.strictEqual(ocrEndpoint('https://api.openai.com/v1'), undefined);
	let got;
	const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = { auth: req.headers.authorization, body: JSON.parse(b) }; res.writeHead(200, { Connection: 'close' }); res.end(JSON.stringify({ md_results: '# Scanned\n\n| a | b |' })); }); });
	await new Promise((r) => server.listen(0, r));
	const md = await glmOcr({ url: 'http://127.0.0.1:' + server.address().port + '/api/paas/v4/layout_parsing', apiKey: 'zk' }, Buffer.from('%PDF-1.4 fake'), 'application/pdf');
	await new Promise((r) => server.close(r));
	assert.strictEqual(md, '# Scanned\n\n| a | b |');
	assert.strictEqual(got.auth, 'Bearer zk');
	assert.strictEqual(got.body.model, 'glm-ocr');
	assert.match(got.body.file, /^data:application\/pdf;base64,/);
});

let failed = 0;
test('pruning hands an elided output to its pointer', () => {
	const { pruneToolOutputs, PRUNED_MARK } = require(OUT + '/transcript.js');
	const big = 'z'.repeat(5000);
	const entries = [
		{ role: 'tool', name: 'read_file', toolCallId: 'a', content: big },
		{ role: 'tool', name: 'read_file', toolCallId: 'b', content: '[Identical to the earlier read_file result above (5,000 chars) — nothing changed, so it is not repeated. Token Saver]' },
		{ role: 'tool', name: 'grep', toolCallId: 'c', content: 'q'.repeat(3000) }
	];
	pruneToolOutputs(entries, 2000, 100);
	assert.strictEqual(entries[0].content, PRUNED_MARK);
	assert.strictEqual(entries[1].content, big, 'the pointer now carries the text');
});

test('pruning saves outputs it drops and keeps the gist of failures', () => {
	const { pruneToolOutputs } = require(OUT + '/transcript.js');
	const saved = [];
	const spill = (content, tool) => { saved.push([tool, content.length]); return `.zer0ne/spill/${tool}-${saved.length}.log`; };
	const failure = 'Error: build failed\n' + 'x'.repeat(9000) + '\nTypeError at src/app.ts:42';
	const entries = [
		{ role: 'tool', name: 'run_command', toolCallId: 'a', content: 'y'.repeat(6000) },
		{ role: 'tool', name: 'run_command', toolCallId: 'b', content: failure, failed: true },
		{ role: 'tool', name: 'grep', toolCallId: 'c', content: 'q'.repeat(3000) }
	];
	pruneToolOutputs(entries, 3500, 100, spill);
	assert.match(entries[0].content, /^\[old tool output moved out of context.*\.zer0ne\/spill\/run_command-2\.log.*read_file/s, 'a dropped output points at its saved copy');
	assert.doesNotMatch(entries[0].content, /run the tool again if/);
	assert.match(entries[1].content, /this call failed/);
	assert.match(entries[1].content, /^\[old tool output[^\n]*\]\nError: build failed/, 'the failure keeps its start');
	assert.match(entries[1].content, /TypeError at src\/app\.ts:42$/, 'and its decisive end');
	assert(entries[1].content.length < 4400);
	assert.deepEqual(saved, [['run_command', 9000 + 'Error: build failed\n\nTypeError at src/app.ts:42'.length], ['run_command', 6000]]);
	assert.equal(entries[2].content.length, 3000, 'recent output stays');
	assert.equal(pruneToolOutputs(entries, 3500, 100, spill), 0, 'a second pass stops at what was pruned');
});

test('Token Saver v0.11: repeat elision, JSON minify, Cache Guard', () => {
	const { elideRepeat, minifyJson, CacheGuard, compressOutput } = require(OUT + '/tools/tokenSaver.js');
	const big = 'x'.repeat(900);
	const msgs = [{ role: 'user', content: 'q' }, { role: 'tool', name: 'read_file', content: big }];
	assert.ok(elideRepeat(msgs, 'read_file', big).startsWith('[Identical to the earlier read_file'), 'repeat becomes a pointer');
	assert.strictEqual(elideRepeat(msgs, 'read_file', big + 'y'), big + 'y', 'changed content is sent in full');
	assert.strictEqual(elideRepeat(msgs, 'run_command', big), big, 'commands are never elided (side effects)');
	assert.strictEqual(elideRepeat([{ role: 'user', content: 'q' }], 'read_file', big), big, 'compacted away → full text again');
	const pretty = JSON.stringify({ items: Array.from({ length: 12 }, (_, i) => ({ id: i, name: 'item ' + i })) }, null, 2);
	assert.ok(minifyJson(pretty).length < pretty.length * 0.8 && JSON.parse(minifyJson(pretty)).items.length === 12);
	assert.strictEqual(minifyJson('{ not json'), '{ not json');
	assert.ok(compressOutput(pretty).text.length < pretty.length);
	const g = new CacheGuard();
	const m1 = [{ role: 'user', content: 'a' }];
	assert.ok(g.check('s', 'sys', m1));
	assert.ok(g.check('s', 'sys', [...m1, { role: 'assistant', content: 'b' }]), 'append-only is stable');
	assert.ok(!g.check('s', 'sys', [{ role: 'user', content: 'CHANGED' }, { role: 'assistant', content: 'b' }]), 'rewriting history breaks the prefix');
	assert.match(g.lastBreak, /message 1/);
	assert.ok(!g.check('s', 'sys2', [{ role: 'user', content: 'CHANGED' }]));
	assert.match(g.lastBreak, /system prompt/);
	assert.ok(g.check('other', 'x', []), 'new session starts clean');
});

test('notebooks: cells with outputs/errors/images; replace, insert, delete one cell', () => {
	const { renderNotebook, editNotebook } = require(OUT + '/core/notebook.js');
	const nb = { cells: [
		{ cell_type: 'markdown', id: 'm1', metadata: {}, source: ['# Title\n'] },
		{ cell_type: 'code', id: 'c1', execution_count: 3, metadata: {}, outputs: [{ output_type: 'stream', text: ['hi\n'] }, { output_type: 'display_data', data: { 'image/png': 'xx' } }], source: ['print("hi")\n'] },
		{ cell_type: 'code', id: 'c2', execution_count: 4, metadata: {}, outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\u001b[31mTraceback\u001b[0m'] }], source: '1/0' }
	], metadata: { kernelspec: { display_name: 'Python 3', language: 'python' } }, nbformat: 4, nbformat_minor: 5 };
	const raw = JSON.stringify(nb, null, 1) + '\n';
	const text = renderNotebook(raw);
	assert.match(text, /3 cells · Python 3/);
	assert.match(text, /## Cell 2 · code · \[3\] · id c1/);
	assert.match(text, /\[image\/png output\]/);
	assert.match(text, /ZeroDivisionError: division by zero/);
	assert.ok(!text.includes('\u001b['), 'ANSI stripped');
	const r = editNotebook(raw, { cell: 3, mode: 'replace', source: 'print(1/1)\n' });
	const after = JSON.parse(r.text);
	assert.deepStrictEqual(after.cells[2].source, ['print(1/1)\n']);
	assert.deepStrictEqual(after.cells[2].outputs, [], 'stale outputs cleared');
	assert.strictEqual(after.cells[2].execution_count, null);
	assert.strictEqual(r.before, '1/0');
	assert.ok(r.text.startsWith('{\n "cells"'), 'indentation kept');
	const ins = JSON.parse(editNotebook(r.text, { cell: 1, mode: 'insert', cell_type: 'markdown', source: 'Intro' }).text);
	assert.strictEqual(ins.cells.length, 4);
	assert.strictEqual(ins.cells[0].cell_type, 'markdown');
	assert.ok(/^[0-9a-f]{8}$/.test(ins.cells[0].id), 'nbformat 4.5 cell id');
	const del = JSON.parse(editNotebook(raw, { cell: 1, mode: 'delete' }).text);
	assert.strictEqual(del.cells[0].id, 'c1');
	assert.throws(() => editNotebook(raw, { cell: 9, mode: 'replace', source: 'x' }), /No cell 9/);
});


// ------------------------------------------------------------------ v0.13

test('turn engine: steering, verify-before-finish, step limit, parallel reads, images', async () => {
	const { runAgentTurn } = require(OUT + '/core/turn.js');
	const messages = [{ role: 'user', content: 'go' }];
	const script = [
		{ text: '', reasoning: '', toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }, { id: 'b', name: 'read', arguments: '{}' }, { id: 'c', name: 'write', arguments: '{}' }] },
		{ text: 'done?', reasoning: '', toolCalls: [] },
		{ text: 'fixed', reasoning: '', toolCalls: [] }
	];
	let step = 0;
	let running = 0;
	let maxParallel = 0;
	const order = [];
	let verified = 0;
	const out = await runAgentTurn({
		messages,
		maxSteps: 10,
		signal: new AbortController().signal,
		call: async () => script[step++],
		parallelSafe: (c) => c.name === 'read',
		execute: async (c) => {
			running++;
			maxParallel = Math.max(maxParallel, running);
			await new Promise((r) => setTimeout(r, 30));
			running--;
			order.push(c.id);
			return { api: 'out-' + c.id };
		},
		transform: (c, api) => api.toUpperCase(),
		beforeFinish: async () => (verified++ === 0 ? 'tests fail' : undefined),
		drainSteer: () => (step === 1 ? ['also do X'] : [])
	});
	assert.strictEqual(out.stopReason, 'end_turn');
	assert.strictEqual(maxParallel, 2, 'two reads ran together, the write alone');
	const tools = messages.filter((m) => m.role === 'tool');
	assert.deepStrictEqual(tools.map((m) => m.toolCallId), ['a', 'b', 'c'], 'results keep call order');
	// The fence is added first, then the transform sees the whole result (token saver, redaction).
	assert.strictEqual(tools[0].content, '<TOOL_OUTPUT TOOL="READ" TRUST="UNTRUSTED">\nOUT-A\n</TOOL_OUTPUT>', 'transform applied');
	assert.ok(messages.some((m) => m.role === 'user' && m.content.includes('also do X')), 'steer delivered between steps');
	assert.ok(messages.some((m) => m.role === 'user' && m.content === 'tests fail'), 'verify feedback sent back');
	assert.strictEqual(messages[messages.length - 1].content, 'fixed');
	const loop = await runAgentTurn({ messages: [], maxSteps: 3, signal: new AbortController().signal, call: async () => ({ text: '', reasoning: '', toolCalls: [{ id: 'x' + Math.random(), name: 'w', arguments: '{}' }] }), execute: async () => ({ api: 'ok' }) });
	assert.strictEqual(loop.stopReason, 'max_turn_requests');
	assert.strictEqual(loop.steps, 3);
	// maxSteps 0 = no limit: the turn ends only when the model stops calling tools.
	let n = 0;
	const unlimited = await runAgentTurn({
		messages: [],
		maxSteps: 0,
		signal: new AbortController().signal,
		call: async () => (n++ < 30 ? { text: '', reasoning: '', toolCalls: [{ id: 'u' + n, name: 'w', arguments: '{}' }] } : { text: 'done', reasoning: '', toolCalls: [] }),
		execute: async () => ({ api: 'ok' })
	});
	assert.strictEqual(unlimited.stopReason, 'end_turn', '0 = no step limit');
	assert.strictEqual(unlimited.steps, 31, 'ran far past the default 25');
	const imgs = [1, 2, 3].map((i) => ({ role: 'tool', toolCallId: 't' + i, name: 's', content: 'shot', images: [{ mime: 'image/png', data: 'x' }] }));
	require(OUT + '/core/turn.js').dropOldImages(imgs, 2);
	assert.deepStrictEqual(imgs.map((m) => !!m.images), [false, true, true], 'only the latest two screenshots stay');
});

test('eager tools: a read starts while the model is still streaming', async () => {
	const http = require('http');
	const os = require('os');
	const { runCore } = require(OUT + '/core/loop.js');
	const { CoreTools } = require(OUT + '/core/tools.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eager-'));
	fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
	let streamEnd = 0;
	let calls = 0;
	const srv = http.createServer((req, res) => {
		req.resume();
		req.on('end', async () => {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
			if (calls++ === 0) {
				send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] });
				send({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_files', arguments: '' } }] } }] });
				await new Promise((r) => setTimeout(r, 400)); // the model is still "writing" call 2
				send({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
				streamEnd = Date.now();
			} else send({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });
			res.end('data: [DONE]\n\n');
		});
	});
	await new Promise((r) => srv.listen(0, '127.0.0.1', r));
	try {
		const started = {};
		const tools = new CoreTools({ root, approve: async () => true });
		const r = await runCore({
			provider: { baseUrl: 'http://127.0.0.1:' + srv.address().port + '/v1', apiKey: 'k', apiFormat: 'openai', model: 'm' },
			tools,
			messages: [{ role: 'user', content: 'read a.txt' }],
			onToolStart: (call) => (started[call.name] = Date.now())
		});
		assert.strictEqual(r.text, 'done');
		assert.ok(started.read_file && started.read_file < streamEnd - 250, 'read_file started ' + (streamEnd - started.read_file) + ' ms before the stream ended');
	} finally {
		srv.close();
	}
});

test('retries: Retry-After headers, retryable errors, streamed output never retried', async () => {
	const { retryAfterMs } = require(OUT + '/chatClient.js');
	const { withRetry, RETRYABLE } = require(OUT + '/core/turn.js');
	assert.strictEqual(retryAfterMs(new Headers({ 'retry-after': '3' })), 3000);
	assert.strictEqual(retryAfterMs(new Headers({ 'retry-after-ms': '250' })), 250);
	assert.strictEqual(retryAfterMs(new Headers({ 'x-ratelimit-reset-requests': '1m2s' })), 62000);
	assert.strictEqual(retryAfterMs(new Headers({})), undefined);
	assert.ok(RETRYABLE.test('Rate limited by the provider (HTTP 429)') && !RETRYABLE.test('Authentication failed (HTTP 401)'));
	let n = 0;
	const waits = [];
	const v = await withRetry(async () => {
		if (n++ < 2) throw Object.assign(new Error('Provider error 503: overloaded'), { retryAfterMs: 20 });
		return 'ok';
	}, { signal: new AbortController().signal, onRetry: (_m, w) => waits.push(w) });
	assert.strictEqual(v, 'ok');
	assert.deepStrictEqual(waits, [20, 20], 'waited what the provider asked');
	await assert.rejects(withRetry(async () => { throw new Error('HTTP 401'); }, { signal: new AbortController().signal }), /401/);
	let m = 0;
	await assert.rejects(withRetry(async () => { m++; throw new Error('HTTP 503'); }, { signal: new AbortController().signal, streamed: () => true }), /503/);
	assert.strictEqual(m, 1, 'no retry once text streamed');
});

test('HF name parsing, vision projector, project instructions', () => {
	const os = require('os');
	const { paramsFromName, findMmproj } = require(OUT + '/localEngine.js');
	assert.strictEqual(paramsFromName('Qwen/Qwen3-8B'), 8e9);
	assert.strictEqual(paramsFromName('mistralai/Mixtral-8x7B-Instruct'), 56e9);
	assert.strictEqual(paramsFromName('Qwen/Qwen3-0.6B-Base'), 0.6e9);
	assert.strictEqual(paramsFromName('openbmb/MiniCPM5'), undefined);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmproj-'));
	for (const f of ['model-Q4_K_M.gguf', 'mmproj-BF16.gguf', 'mmproj-F16.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
	assert.strictEqual(path.basename(findMmproj(dir)), 'mmproj-F16.gguf', 'prefers the F16 projector');
	fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Use tabs.');
	const { coreSystemPrompt } = require(OUT + '/core/loop.js');
	assert.ok(coreSystemPrompt(dir).includes('# AGENTS.md\nUse tabs.'), 'AGENTS.md reaches the CLI / ACP / writers');
	const { PRESETS } = require(OUT + '/presets.js');
	const groups = (g) => PRESETS.filter((p) => p.group === g).length;
	assert.ok(groups('plans') >= 16 && groups('api') >= 30 && groups('local') >= 7, 'plan keys, API providers and local runtimes stay available');
	for (const id of ['chatgpt-account', 'openrouter-oauth']) assert.strictEqual(PRESETS.find((p) => p.id === id)?.group, 'signin');
	for (const id of ['xai-account', 'kimi-account', 'minimax-account', 'github-models']) assert.strictEqual(PRESETS.find((p) => p.id === id)?.group, 'legacy', 'unsupported and retired routes do not inflate sign-in choices');
	assert.strictEqual(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length, 'preset ids are unique');
});

// ------------------------------------------------------------------ v0.14

test('Turbo Fit: GPU, MoE hybrid, dense split, disk, too large — with quant advice', () => {
	const { planTurbo, moeInfo, quantForBudget, bandwidth } = require(OUT + '/turboFit.js');
	const { machineCapacity } = require(OUT + '/localModels.js');
	// Laptop: 32 GB RAM, Intel Arc 140V sharing 16 GB.
	const m = machineCapacity({ platform: 'win32', cpu: 'Intel Core Ultra 7', cores: 8, totalMemoryBytes: 32e9, gpuName: 'Intel(R) Arc(TM) 140V GPU (16GB)', gpuMemoryBytes: 16e9, unifiedMemory: false, freeDiskBytes: 200e9 });
	assert.ok(bandwidth(m).gpu >= 100, 'Arc 140V bandwidth class');
	const small = planTurbo({ name: 'Qwen3-8B-Q4_K_M', sizeBytes: 5e9, params: 8e9, machine: m });
	assert.strictEqual(small.tier, 'gpu');
	assert.ok(small.estTokS > 5, 'est ' + small.estTokS);
	const moe = planTurbo({ name: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M', sizeBytes: 18.6e9, params: 30.5e9, machine: m });
	assert.deepStrictEqual(moeInfo('Qwen3-Coder-30B-A3B-Instruct').active, 3e9);
	assert.strictEqual(moe.tier, 'ram', moe.label);
	assert.ok(!moe.flags.includes('--cpu-moe') && !moe.flags.includes('--n-cpu-moe'), 'shared GPU avoids CPU expert contention');
	assert.ok(moe.estTokS > 5, 'MoE stays usable: ' + moe.estTokS);
	const dense = planTurbo({ name: 'Qwen3-32B-Q4_K_M', sizeBytes: 19.8e9, params: 32.8e9, machine: m });
	assert.strictEqual(dense.tier, 'ram');
	assert.ok(dense.estTokS < moe.estTokS, 'dense 32B is slower than a 30B-A3B MoE here');
	assert.ok(dense.suggestQuant, 'suggests a smaller quant');
	assert.ok(dense.flags.includes('-ctk'), 'quantized KV cache');
	const huge = planTurbo({ name: 'Llama-3.1-405B-Q4_K_M', sizeBytes: 240e9, params: 405e9, machine: m });
	assert.strictEqual(huge.tier, 'no');
	assert.strictEqual(quantForBudget(8e9, 4e9), 'Q3_K_M');
	assert.ok(!small.flags.includes('--spec-type'), 'speculation is the separate Speed boost');
});






// ------------------------------------------------------------------ v0.15

test('Token Saver: skeleton reads fold long bodies; hashline edits check the tag', () => {
	const { skeleton, contentTag, applyLineEdits } = require(OUT + '/core/skeleton.js');
	// A class whose methods have long bodies, plus a top-level function.
	const body = (n, ind) => Array.from({ length: n }, (_, i) => ind + 'const v' + i + ' = ' + i + ';').join('\n');
	const src = ['import x from "y";', 'export class Big {', '\tfirst(): void {', body(40, '\t\t'), '\t}', '\tsecond(a: string): number {', body(40, '\t\t'), '\t\treturn 1;', '\t}', '}', 'export function helper() {', body(300, '\t'), '}'].join('\n');
	const sk = skeleton('src/big.ts', src);
	assert.ok(sk, 'skeleton made');
	assert.ok(sk.text.includes('export class Big {'), 'container kept open');
	assert.ok(sk.text.includes('first(): void {') && sk.text.includes('second(a: string): number {'), 'signatures kept');
	assert.ok(/⋯ \d+ lines folded \(\d+–\d+\) — read_file offset=\d+ limit=\d+/.test(sk.text), 'fold marker with range');
	assert.ok(sk.shownLines < sk.totalLines / 3, 'saves most of the file: ' + sk.shownLines + '/' + sk.totalLines);
	assert.strictEqual(skeleton('a.ts', 'const a = 1;\n'), null, 'short files read in full');
	assert.strictEqual(skeleton('notes.md', src), null, 'prose is never folded');
	// Braces inside strings/comments do not confuse the counter.
	const fn = ['function f() {', "\tconst s = '}}}';", '\t// { not a block', body(20, '\t'), '}'].join('\n');
	const sk2 = skeleton('t.ts', Array.from({ length: 20 }, () => fn).join('\n'));
	assert.ok(sk2 && sk2.folds.length === 20, 'one fold per function: ' + (sk2 && sk2.folds.length));
	// A whole-file wrapper (IIFE) stays open so its functions fold.
	const iife = ['(function () {', Array.from({ length: 20 }, () => fn).join('\n'), '})();'].join('\n');
	const sk4 = skeleton('w.js', iife);
	assert.ok(sk4 && sk4.folds.length === 20 && sk4.text.includes('(function () {'), 'IIFE members folded');
	// Python bodies
	const py = Array.from({ length: 12 }, (_, k) => 'def f' + k + '(a):\n' + body(30, '    ')).join('\n\n');
	const sk3 = skeleton('m.py', py);
	assert.ok(sk3 && sk3.folds.length === 12 && sk3.text.includes('def f3(a):'), 'python defs folded');
	// Hashline
	const text = 'a\nb\nc\nd\n';
	assert.match(contentTag(text), /^[0-9a-f]{4}$/);
	assert.strictEqual(contentTag('a\r\nb'), contentTag('a\nb'), 'tag ignores line endings');
	assert.notStrictEqual(contentTag(text), contentTag('a\nB\nc\nd\n'));
	assert.strictEqual(applyLineEdits(text, [{ start: 2, end: 3, text: 'X\nY\nZ' }]), 'a\nX\nY\nZ\nd\n');
	assert.strictEqual(applyLineEdits(text, [{ start: 1, end: 1, text: 'A' }, { start: 4, end: 4, text: '' }]), 'A\nb\nc\n', 'several ranges, as read');
	assert.strictEqual(applyLineEdits(text, [{ start: 2, end: 1, text: 'new' }]), 'a\nnew\nb\nc\nd\n', 'insert before');
	assert.strictEqual(applyLineEdits('a\r\nb', [{ start: 2, end: 2, text: 'c' }]), 'a\r\nc', 'keeps CRLF');
	assert.throws(() => applyLineEdits(text, [{ start: 1, end: 2, text: '' }, { start: 2, end: 3, text: '' }]), /overlap/);
	assert.throws(() => applyLineEdits(text, [{ start: 9, end: 9, text: '' }]), /outside/);
});



// ---------------------------------------------------------------- v0.18




test('v0.18 engine: CUDA build by driver, arm64 CUDA, missing runtime messages', () => {
	const E = require(OUT + '/localEngine.js');
	const names = ['llama-b1-bin-win-cuda-12.4-x64.zip', 'llama-b1-bin-win-cuda-13.4-x64.zip', 'llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz', 'llama-b1-bin-ubuntu-cuda-13.4-x64.tar.gz', 'llama-b1-bin-ubuntu-cuda-13.4-arm64.tar.gz'];
	assert.strictEqual(E.pickAsset(names, 'cuda', 'win32', 'x64', 560), 'llama-b1-bin-win-cuda-12.4-x64.zip', 'old driver → 12.x');
	assert.strictEqual(E.pickAsset(names, 'cuda', 'win32', 'x64', 581), 'llama-b1-bin-win-cuda-13.4-x64.zip', 'new driver → 13.x (RTX 50)');
	assert.strictEqual(E.pickAsset(names, 'cuda', 'linux', 'x64'), 'llama-b1-bin-ubuntu-cuda-12.8-x64.tar.gz');
	assert.strictEqual(E.pickAsset(names, 'cuda', 'linux', 'arm64'), 'llama-b1-bin-ubuntu-cuda-13.4-arm64.tar.gz');
	assert.match(E.missingRuntime('error while loading shared libraries: libvulkan.so.1'), /Vulkan runtime/);
	assert.strictEqual(E.missingRuntime('failed to allocate buffer'), undefined, 'memory errors keep the retry path');
});

test('v0.18 Turbo Fit: no flags when the model already fits; 8-bit cache when split', () => {
	const { planTurbo, moeInfo } = require(OUT + '/turboFit.js');
	const m = { platform: 'win32', cpu: 'x', cores: 8, totalMemoryBytes: 32e9, gpuName: 'NVIDIA GeForce RTX 4070', gpuMemoryBytes: 12e9, unifiedMemory: false, fastBudgetBytes: 12e9, ceilingBytes: 25.6e9, freeDiskBytes: 500e9 };
	assert.deepStrictEqual(planTurbo({ name: 'Qwen3-8B-Q4_K_M', sizeBytes: 5e9, machine: m }).flags, [], 'auto-fit is better than a pinned context');
	const moe = planTurbo({ name: 'Qwen3-30B-A3B-Q4_K_M', sizeBytes: 18e9, machine: m });
	assert.strictEqual(moe.tier, 'hybrid');
	assert.ok(moe.flags.includes('q8_0'), moe.flags.join(' '));
	assert.ok(moeInfo('Llama-4-Scout-17B-16E-Instruct').moe);
	assert.strictEqual(moeInfo('Llama-4-Scout-17B-16E-Instruct').active, 17e9);
	assert.ok(moeInfo('MiniMax-M3-GGUF').moe && moeInfo('Qwen3.5-Next-80B').moe);
});

test('v0.18 markdown: GitHub alerts render as callouts', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'markdown.js'), 'utf8');
	const win = {};
	new Function('window', src)(win);
	const html = win.Markdown.render('> [!TIP]\n> Run it from **PowerShell**.\n\n> plain quote');
	assert.ok(/md-alert md-alert-tip/.test(html) && /<b>|<strong>/.test(html), html);
	assert.ok(/<blockquote>/.test(html), 'normal quotes unchanged');
});

test('v0.18 skills catalog: folders with their files, categories', () => {
	const { skillFolders, categorize } = require(OUT + '/tools/skillCatalog.js');
	const tree = [
		{ path: 'skills/debugging/SKILL.md', type: 'blob', size: 10 },
		{ path: 'skills/debugging/find.sh', type: 'blob', size: 10 },
		{ path: 'skills/debugging/ref/deep.md', type: 'blob', size: 10 },
		{ path: 'skills/pdf/SKILL.md', type: 'blob', size: 10 },
		{ path: 'composio-skills/x-automation/SKILL.md', type: 'blob', size: 10 },
		{ path: 'README.md', type: 'blob', size: 10 }
	];
	const f = skillFolders(tree, { prefix: 'skills/' });
	assert.deepStrictEqual(f.map((x) => x.dir), ['skills/debugging', 'skills/pdf']);
	assert.deepStrictEqual(f[0].files.sort(), ['SKILL.md', 'find.sh', 'ref/deep.md']);
	assert.strictEqual(skillFolders(tree, { exclude: /^composio-skills\// }).length, 2);
	assert.strictEqual(categorize('systematic-debugging', ''), 'Testing & debugging');
	assert.strictEqual(categorize('pptx', 'slides'), 'Documents');
	assert.strictEqual(categorize('using-git-worktrees', ''), 'Git & workflow');
	assert.strictEqual(categorize('youtube-downloader', 'downloads videos'), 'Utilities');
});

test('v0.18 tunnel: cloudflared build per platform, URL from the log', () => {
	const { cloudflaredAsset, tunnelUrl } = require(OUT + '/tunnel.js');
	const names = ['cloudflared-windows-amd64.exe', 'cloudflared-darwin-arm64.tgz', 'cloudflared-darwin-amd64.tgz', 'cloudflared-linux-amd64', 'cloudflared-linux-arm64', 'cloudflared-linux-arm'];
	assert.strictEqual(cloudflaredAsset(names, 'win32', 'x64'), 'cloudflared-windows-amd64.exe');
	assert.strictEqual(cloudflaredAsset(names, 'win32', 'arm64'), 'cloudflared-windows-amd64.exe');
	assert.strictEqual(cloudflaredAsset(names, 'darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
	assert.strictEqual(cloudflaredAsset(names, 'linux', 'arm64'), 'cloudflared-linux-arm64');
	assert.strictEqual(cloudflaredAsset(names, 'linux', 'x64'), 'cloudflared-linux-amd64');
	const log = '2026-09-26T10:00:00Z INF |  https://quiet-river-mesh-demo.trycloudflare.com  |\n';
	assert.strictEqual(tunnelUrl(log), 'https://quiet-river-mesh-demo.trycloudflare.com');
	assert.strictEqual(tunnelUrl('INF Starting tunnel'), undefined);
});



test('v0.20 hugging face: gated / refused / missing errors say what to do', () => {
	const { hfError } = require(OUT + '/localEngine.js');
	assert.match(hfError(401, 'org/model', false), /gated.*accept its terms.*connect your Hugging Face token/i);
	assert.match(hfError(401, 'org/model', true), /refused your token/);
	assert.match(hfError(403, 'org/model'), /accept its terms/);
	assert.match(hfError(404), /no longer on Hugging Face/);
	assert.match(hfError(429), /rate-limiting/);
});

test('v0.20 hugging face: the token goes to huggingface.co only; downloads explain a 401', async () => {
	const http = require('http');
	const eng = require(OUT + '/localEngine.js');
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization });
		if (req.url.includes('/resolve/')) {
			res.writeHead(req.headers.authorization === 'Bearer hf_good' ? 200 : 401, { 'content-length': 2 });
			return res.end('ok');
		}
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end('[]');
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const prev = process.env.HF_ENDPOINT;
	process.env.HF_ENDPOINT = 'http://127.0.0.1:' + server.address().port;
	const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hf-'));
	try {
		eng.setHfToken(undefined);
		await assert.rejects(eng.download(eng.hfFileUrl('org/gated', 'm.gguf'), path.join(dir, 'm.gguf'), () => {}, new AbortController().signal), /gated.*huggingface\.co\/org\/gated/i);
		eng.setHfToken('hf_good');
		await eng.download(eng.hfFileUrl('org/gated', 'm.gguf'), path.join(dir, 'm.gguf'), () => {}, new AbortController().signal);
		assert.strictEqual(fs.readFileSync(path.join(dir, 'm.gguf'), 'utf8'), 'ok');
		await eng.searchHf('coder', 'downloads', 5, 'gguf', { min: 8e9, max: 21e9 });
		const search = seen.find((s) => s.url.startsWith('/api/models?'));
		assert.match(decodeURIComponent(search.url), /num_parameters=min:8B,max:21B/, 'size classes are filtered by Hugging Face');
		assert.strictEqual(search.auth, 'Bearer hf_good');
	} finally {
		eng.setHfToken(undefined);
		if (prev === undefined) delete process.env.HF_ENDPOINT;
		else process.env.HF_ENDPOINT = prev;
		server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('v0.21 engine convert: which files, which quant, what cannot convert', () => {
	const { convertFiles, convertQuant } = require(OUT + '/ggufConvert.js');
	const plan = convertFiles([
		{ path: 'config.json', size: 1 }, { path: 'model-00001-of-00002.safetensors', size: 5e9 }, { path: 'model-00002-of-00002.safetensors', size: 3e9 },
		{ path: 'model.safetensors.index.json', size: 1 }, { path: 'tokenizer.json', size: 2 }, { path: 'tokenizer_config.json', size: 1 },
		{ path: 'pytorch_model.bin', size: 9e9 }, { path: 'README.md', size: 1 }, { path: 'onnx/model.onnx', size: 1e9 }
	]);
	assert.deepStrictEqual(plan.files.sort(), ['config.json', 'model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json', 'tokenizer.json', 'tokenizer_config.json']);
	assert.strictEqual(plan.bytes, 8e9 + 5, 'safetensors preferred; .bin and onnx/ skipped');
	assert.match(convertFiles([{ path: 'adapter_config.json', size: 1 }, { path: 'adapter_model.safetensors', size: 1 }, { path: 'config.json', size: 1 }]).problem, /LoRA adapter/);
	assert.match(convertFiles([{ path: 'model.gguf', size: 1 }]).problem, /config\.json/);
	assert.strictEqual(convertQuant(1.5e9), 'Q8_0');
	assert.strictEqual(convertQuant(12e9), 'Q4_K_M');
});

test('v0.21.1 anthropic gateways: cache reads reported in the final usage event count', () => {
	const { anthropicAccumulator } = require(OUT + '/chatClient.js');
	const a = anthropicAccumulator({});
	a.handle({ type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 1 } } });
	a.handle({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1200, cache_read_input_tokens: 50000, output_tokens: 300 } });
	const lateUsage = a.result().usage;
	assert.deepStrictEqual({ input: lateUsage.input, output: lateUsage.output, cached: lateUsage.cached }, { input: 51200, output: 300, cached: 50000 });
});

test('v0.21.3 context repair: orphaned tool results are dropped (live 400 from the watchdog)', () => {
	const { repairToolPairs } = require(OUT + '/transcript.js');
	const trimmed = [
		{ role: 'tool', toolCallId: 'a', name: 'read_file', content: 'x' },
		{ role: 'user', content: '[Update] step 7' },
		{ role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'advise', arguments: '{}' }, { id: 'c', name: 'read_file', arguments: '{}' }] },
		{ role: 'tool', toolCallId: 'b', name: 'advise', content: 'Delivered' }
	];
	const out = repairToolPairs(trimmed);
	assert.strictEqual(out[0].role, 'user', 'no tool message without its call');
	assert.deepStrictEqual(out.filter((m) => m.role === 'tool').map((m) => m.toolCallId), ['b', 'c'], 'missing answer filled, pairs intact');
});

test('v0.23 accounts: credentials round-trip, ChatGPT workspace from the token, no refresh while fresh, safe callback page', async () => {
	const { serializeCredential, parseCredential, isAccountSecret, chatgptAccountId, ensureFresh, callbackPage, describeCredential } = require(OUT + '/accounts.js');
	const jwt = (claims) => 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
	const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123', chatgpt_plan_type: 'pro' } });
	assert.strictEqual(chatgptAccountId(access), 'acc_123');
	assert.strictEqual(chatgptAccountId('not-a-jwt'), undefined);
	const cred = { kind: 'account', account: 'chatgpt', access, refresh: 'r1', expires: Date.now() + 3600_000, email: 'me@x.io', plan: 'pro', accountId: 'acc_123' };
	const secret = serializeCredential(cred);
	assert.ok(isAccountSecret(secret) && !isAccountSecret('sk-plain-key'), 'plain keys are not accounts');
	assert.deepStrictEqual(parseCredential(secret), cred);
	assert.strictEqual(parseCredential('sk-abc'), undefined);
	assert.strictEqual(parseCredential('zer0ne-account:{broken'), undefined);
	assert.ok(!('access' in describeCredential(cred)) && !('refresh' in describeCredential(cred)), 'the UI never gets tokens');
	assert.strictEqual(await ensureFresh(cred), cred, 'a fresh token is not refreshed');
	const page = callbackPage(false, 'Failed <script>', 'x"y');
	assert.ok(!page.includes('<script>alert') && page.includes('Failed &lt;script&gt;') && page.includes('x&quot;y'), 'escaped');
});

test('v0.23 codex: Responses input keeps tool pairs, images and the encrypted reasoning of the step', () => {
	const { toResponsesInput, codexBody } = require(OUT + '/codexClient.js');
	const reasoning = JSON.stringify({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' });
	const input = toResponsesInput([
		{ role: 'user', content: 'fix it', images: [{ mime: 'image/png', base64: 'AAA', name: 'a.png' }] },
		{ role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}', signature: reasoning }, { id: 'call_2', name: 'grep', arguments: '{}' }] },
		{ role: 'tool', toolCallId: 'call_1', name: 'read_file', content: 'x', images: [{ mime: 'image/png', base64: 'BBB', name: 's.png' }] },
		{ role: 'tool', toolCallId: 'call_2', name: 'grep', content: '' }
	]);
	assert.deepStrictEqual(input.map((i) => i.type || i.role), ['user', 'assistant', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'user']);
	assert.strictEqual(input[0].content[1].type, 'input_image');
	assert.strictEqual(input[3].call_id, 'call_1');
	assert.strictEqual(input[6].output, '(empty)');
	assert.match(JSON.stringify(input[7]), /BBB/, 'tool screenshots follow the results');
	const body = codexBody({ model: 'gpt-6-sol', system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }], effort: 'minimal', cacheKey: 'k'.repeat(90), apiKey: '', baseUrl: '', apiFormat: 'codex', signal: new AbortController().signal });
	assert.strictEqual(body.store, false);
	assert.strictEqual(body.instructions, 'S');
	assert.strictEqual(body.reasoning.effort, 'low', 'minimal maps to low');
	assert.strictEqual(body.prompt_cache_key.length, 64);
	assert.deepStrictEqual(body.tools[0], { type: 'function', name: 't', description: 'd', parameters: { type: 'object' }, strict: false });
});

test('v0.23 codex: streamed text, reasoning summary, tool call with arguments, usage and the reasoning item', async () => {
	const http = require('http');
	const { streamChat } = require(OUT + '/chatClient.js');
	let seen;
	const events = [
		{ type: 'response.created' },
		{ type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
		{ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'ENC' } },
		{ type: 'response.output_text.delta', delta: 'Hello ' },
		{ type: 'response.output_text.delta', delta: 'there' },
		{ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'fc_1', call_id: 'call_A', name: 'read_file', arguments: '' } },
		{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
		{ type: 'response.function_call_arguments.delta', output_index: 2, delta: '"a.ts"}' },
		{ type: 'response.function_call_arguments.done', output_index: 2, arguments: '{"path":"a.ts"}' },
		{ type: 'response.completed', response: { usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 1000 } } } }
	];
	const server = http.createServer((req, res) => {
		let b = '';
		req.on('data', (c) => (b += c));
		req.on('end', () => {
			seen = { url: req.url, headers: req.headers, body: JSON.parse(b) };
			res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
			for (const e of events) res.write('event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n');
			res.end();
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const token = 'h.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'ws_1' } })).toString('base64url') + '.s';
	const early = [];
	try {
		const r = await streamChat({ baseUrl: 'http://127.0.0.1:' + server.address().port + '/backend-api/codex', apiKey: token, apiFormat: 'codex', model: 'gpt-6-sol', system: 'sys', messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal, cacheKey: 'zer0ne-s1', onToolCall: (c) => early.push(c.name) });
		assert.strictEqual(seen.url, '/backend-api/codex/responses');
		assert.strictEqual(seen.headers['chatgpt-account-id'], 'ws_1');
		assert.strictEqual(seen.headers.originator, 'zer0ne');
		assert.strictEqual(seen.headers.session_id, 'zer0ne-s1');
		assert.strictEqual(r.text, 'Hello there');
		assert.strictEqual(r.reasoning, 'Thinking');
		assert.deepStrictEqual(r.toolCalls.map((c) => [c.id, c.name, c.arguments]), [['call_A', 'read_file', '{"path":"a.ts"}']]);
		assert.match(r.toolCalls[0].signature, /"encrypted_content":"ENC"/, 'reasoning rides on the call');
		assert.deepStrictEqual(early, ['read_file'], 'tool call handed out before the stream ends');
		assert.deepStrictEqual({ input: r.usage.input, output: r.usage.output, cached: r.usage.cached }, { input: 1200, output: 40, cached: 1000 });
		assert.strictEqual(r.stopReason, 'tool_calls');
	} finally {
		server.close();
	}
});







test('v0.23 skills from a link: GitHub repo, folder, blob, owner/repo, SkillsLLM page', async () => {
	const { resolveSkillLink, categorize, SKILL_SOURCES } = require(OUT + '/tools/skillCatalog.js');
	assert.deepStrictEqual(await resolveSkillLink('https://github.com/anthropics/skills'), { repo: 'anthropics/skills', dir: '' });
	assert.deepStrictEqual(await resolveSkillLink('github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices/'), { repo: 'vercel-labs/agent-skills', dir: 'skills/react-best-practices', ref: 'main' });
	assert.deepStrictEqual(await resolveSkillLink('https://github.com/o/r/blob/main/x/y/SKILL.md'), { repo: 'o/r', dir: 'x/y', ref: 'main' });
	assert.deepStrictEqual(await resolveSkillLink('obra/superpowers'), { repo: 'obra/superpowers', dir: '' });
	const page = '<a href="https://github.com/someone">someone</a><a href="https://github.com/affaan-m/ECC#readme">View</a><a href="https://github.com/other/repo">x</a>';
	assert.deepStrictEqual(await resolveSkillLink('https://skillsllm.com/skill/ecc', async () => page), { repo: 'affaan-m/ECC', dir: '' });
	await assert.rejects(() => resolveSkillLink('https://example.com/x'), /Paste a GitHub repo/);
	assert.strictEqual(categorize('semgrep-rule-creator', ''), 'Security');
	assert.strictEqual(categorize('vercel-react-best-practices', 'review React code'), 'Design & frontend');
	assert.ok(SKILL_SOURCES.length >= 8, 'more collections');
});

test('v0.23 scorecard: context overflow shrinks the conversation tier by tier, then the call goes through', async () => {
	const { shrinkToFit, withOverflowRecovery, CONTEXT_OVERFLOW } = require(OUT + '/core/turn.js');
	const convo = () => {
		const m = [{ role: 'user', content: 'fix the build' }];
		for (let i = 0; i < 8; i++) {
			m.push({ role: 'assistant', content: '', toolCalls: [{ id: 'c' + i, name: 'read_file', arguments: '{"path":"f' + i + '.ts"}' }] });
			m.push({ role: 'tool', toolCallId: 'c' + i, name: 'read_file', content: String(i).repeat(5000) });
		}
		m.push({ role: 'assistant', content: 'Found it.' });
		return m;
	};
	const fits = convo();
	assert.strictEqual(shrinkToFit(fits, 1e9), 0, 'nothing removed when it fits');
	const m = convo();
	const removed = shrinkToFit(m, 25_000);
	assert.ok(removed > 15_000, 'old outputs dropped');
	const tools = m.filter((x) => x.role === 'tool');
	assert.match(tools[0].content, /output dropped to fit the context window/);
	assert.strictEqual(tools.at(-1).content.length, 5000, 'the newest outputs stay while it fits');
	assert.strictEqual(m[0].content, 'fix the build', 'the task stays');
	for (const e of ['prompt is too long: 212000 tokens > 200000 maximum', "This model's maximum context length is 128000 tokens", 'context_length_exceeded', 'Request too large (413)']) assert.ok(CONTEXT_OVERFLOW.test(e), e);
	assert.ok(!CONTEXT_OVERFLOW.test('Rate limit reached for requests'));
	// llama.cpp server (local models): the real window is read from the error and the call goes through.
	const llama = 'Provider error 400: request (38099 tokens) exceeds the available context size (32768 tokens), try increasing it';
	assert.ok(CONTEXT_OVERFLOW.test(llama), llama);
	assert.deepStrictEqual(require(OUT + '/core/turn.js').overflowNumbers(llama), { limit: 32768, need: 38099 });
	const big = convo();
	const learned = [];
	let tries = 0;
	assert.strictEqual(await withOverflowRecovery(async () => {
		const chars = big.reduce((n, x) => n + (x.content?.length ?? 0), 0);
		if (++tries === 1) throw new Error('request (' + Math.round(chars / 3) + ' tokens) exceeds the available context size (8192 tokens), try increasing it');
		assert.ok(chars / 3 < 8192 * 0.75, 'trimmed under the real window, not the assumed 128K');
		return 'ok';
	}, { messages: big, systemChars: 0, onWindow: (t) => learned.push(t) }), 'ok');
	assert.deepStrictEqual(learned, [8192], 'the real window is reported once');
	// Overflow → shrink → retried; a tier with nothing left to cut falls through to the next one.
	const msgs = convo();
	let calls = 0;
	const tiers = [];
	const out = await withOverflowRecovery(async () => {
		if (++calls < 3) throw new Error('prompt is too long: 9000 tokens > 8000 maximum');
		return 'answered';
	}, { messages: msgs, windowTokens: 8000, systemChars: 0, onShrink: (n, tier) => tiers.push(tier) });
	assert.strictEqual(out, 'answered');
	assert.strictEqual(calls, 3);
	assert.deepStrictEqual(tiers.length, 2);
	assert.ok(tiers[1] > tiers[0], 'smaller share each time');
	// Other errors, or an answer already streaming, are not touched.
	const same = convo();
	await assert.rejects(() => withOverflowRecovery(async () => { throw new Error('Rate limit reached'); }, { messages: same, systemChars: 0 }), /Rate limit/);
	await assert.rejects(() => withOverflowRecovery(async () => { throw new Error('context length exceeded'); }, { messages: same, systemChars: 0, streamed: () => true }), /context length/);
	assert.strictEqual(same.filter((x) => x.role === 'tool')[0].content.length, 5000, 'untouched');
});

test('v0.23 scorecard: output budget fits the window; token counts close to o200k', () => {
	const { outputBudget } = require(OUT + '/core/turn.js');
	const { countTokens, countMessageTokens } = require(OUT + '/tools/tokenSaver.js');
	assert.strictEqual(outputBudget(32_000, undefined, 1e6), 32_000, 'unknown window: the setting');
	assert.strictEqual(outputBudget(32_000, 200_000, 100_000), 32_000);
	assert.strictEqual(outputBudget(32_000, 200_000, 190_000), 200_000 - 190_000 - 1024, 'what is left of the window');
	assert.throws(() => outputBudget(32_000, 200_000, 199_500), /Prompt is too long/, 'overflow must recover before requesting output');
	assert.strictEqual(outputBudget(512, 8192, 1000), 512, 'honor small advertised response limits');
	// Real o200k counts (gpt-tokenizer) of these samples: the estimate stays within 10 %.
	const S = {
		code: ["export function outputBudget(maxTokens: number, windowTokens: number | undefined, promptTokens: number): number {\n\tif (!windowTokens) return maxTokens;\n\tconst room = windowTokens - promptTokens - 1024;\n\treturn Math.max(1024, Math.min(maxTokens, room));\n}\n".repeat(6), 360],
		prose: ['The output cap fits what is left of the window after the prompt, so a long conversation never fails when the maximum output plus the input exceeds the context. Old tool outputs go first, then long old messages are cut to their head.\n'.repeat(6), 282],
		json: [JSON.stringify({ name: 'zer0ne-coding', version: '0.23.0', scripts: { compile: 'tsc -p ./', test: 'npm run compile && node test/run.js' }, contributes: { commands: [{ command: 'aiChat.open', title: 'Open chat' }, { command: 'aiChat.settings', title: 'Settings' }] } }).repeat(4), 272],
		log: [Array.from({ length: 40 }, (_, i) => `  PASS test/unit-${i}.test.js (${(i * 0.37).toFixed(2)}s)`).join('\n'), 560],
		cjk: ['免费额度 · 白嫖 Claude Code / Codex / Cursor 的中转与公益站合集。注册即送额度，签到每日续命。'.repeat(6), 186]
	};
	let ours = 0;
	let naive = 0;
	for (const [kind, [text, truth]] of Object.entries(S)) {
		const e = countTokens(text);
		assert.ok(Math.abs(e / truth - 1) <= 0.1, `${kind}: ${e} vs ${truth}`);
		ours += Math.abs(e / truth - 1);
		naive += Math.abs(Math.ceil(text.length / 3.5) / truth - 1);
	}
	assert.ok(ours < naive / 3, 'far closer than chars / 3.5');
	assert.strictEqual(countTokens(''), 0);
	const n = countMessageTokens([{ content: 'hello there' }, { content: '', toolCalls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }] }]);
	assert.ok(n > countTokens('hello there') + countTokens('{"path":"a.ts"}') + 8, 'per-message and per-call overhead counted');
});

test('v0.23 scorecard: key pools, cache warm value, Anthropic cache plan', () => {
	const { serializeCredential, splitKeys } = require(OUT + '/accounts.js');
	const { cacheWarmValue } = require(OUT + '/tools/tokenSaver.js');
	const { anthropicRequestBody } = require(OUT + '/chatClient.js');
	assert.deepStrictEqual(splitKeys('sk-a, sk-b\nsk-c  sk-d'), ['sk-a', 'sk-b', 'sk-c', 'sk-d']);
	assert.deepStrictEqual(splitKeys('sk-one'), ['sk-one']);
	assert.deepStrictEqual(splitKeys(undefined), []);
	const account = serializeCredential({ kind: 'account', account: 'chatgpt', access: 'a b', refresh: 'r', expires: Date.now() + 3600_000 });
	assert.deepStrictEqual(splitKeys(account), [account], 'a signed-in account is never split');
	// Warming pays off only for a big prompt on a pricey model: rewriting it would cost > $0.05 more than a read.
	assert.strictEqual(cacheWarmValue(3000, 15).worth, false, 'too small to cache');
	assert.strictEqual(cacheWarmValue(10_000, 0.25).worth, false, 'cheap model');
	assert.strictEqual(cacheWarmValue(50_000, undefined).worth, false, 'unknown price');
	const w = cacheWarmValue(100_000, 3);
	assert.deepStrictEqual(w, { worth: true, saves: 0.345, costs: 0.03 });
	const opts = {
		model: 'claude-x',
		system: 'You are zer0ne.',
		maxTokens: 4096,
		tools: [{ name: 'read_file', description: 'r', parameters: { type: 'object', properties: {} } }, { name: 'grep', description: 'g', parameters: { type: 'object', properties: {} } }],
		messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }]
	};
	const marks = (b) => JSON.stringify(b).split('"cache_control"').length - 1;
	const plain = anthropicRequestBody(opts);
	assert.strictEqual(plain.tools.at(-1).cache_control, undefined, 'gateways keep the shared plan');
	assert.deepStrictEqual(plain.system[0].cache_control, { type: 'ephemeral' });
	assert.strictEqual(marks(plain), 3);
	const full = anthropicRequestBody(opts, { toolBreakpoint: true, ttl: '1h' });
	assert.deepStrictEqual(full.tools.at(-1).cache_control, { type: 'ephemeral', ttl: '1h' }, 'tools cached first (tools → system → messages)');
	assert.strictEqual(full.tools[0].cache_control, undefined);
	assert.deepStrictEqual(full.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
	assert.deepStrictEqual(full.messages.slice(-2).map((m) => m.content.at(-1).cache_control.ttl), ['1h', '1h']);
	assert.strictEqual(full.messages[0].content.at(-1).cache_control, undefined);
	assert.strictEqual(marks(full), 4, "within Anthropic's four breakpoints");
});

test('v0.23 scorecard: cut command output is spilled to .zer0ne/spill (git-ignored, pruned after a week)', () => {
	const os = require('os');
	const { spillOutput, compressOutput } = require(OUT + '/tools/tokenSaver.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zspill-'));
	try {
		const full = Array.from({ length: 4000 }, (_, i) => `line ${i}: ${i % 7 === 0 ? 'error TS2345 in src/file' + i + '.ts' : 'compiling module ' + i}`).join('\n');
		const cut = compressOutput(full, 6000).text;
		assert.match(cut, /chars trimmed by Token Saver/);
		assert.strictEqual(spillOutput(root, 'short', 'short', 'npm test'), '', 'nothing cut, nothing saved');
		assert.strictEqual(spillOutput(undefined, full, cut, 'npm test'), '', 'no project');
		const dir = path.join(root, '.zer0ne', 'spill');
		fs.mkdirSync(dir, { recursive: true });
		const old = path.join(dir, 'old.log');
		fs.writeFileSync(old, 'x');
		const week = (Date.now() - 8 * 24 * 3600_000) / 1000;
		fs.utimesSync(old, week, week);
		const note = spillOutput(root, full, cut, 'npm run build');
		const m = /saved to (\.zer0ne\/spill\/[^ ]+\.log)/.exec(note);
		assert.ok(m, note);
		assert.match(note, /4000 lines/);
		assert.strictEqual(fs.readFileSync(path.join(root, m[1]), 'utf8'), full, 'the whole output is kept');
		assert.match(m[1], /npm-run-build\.log$/);
		assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n');
		assert.ok(!fs.existsSync(old), 'week-old spills pruned');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('v0.23 scorecard: stream watchdog — no first byte, or a stalled stream, fails fast instead of hanging', async () => {
	const http = require('http');
	const { post, readSse, WATCHDOG } = require(OUT + '/chatClient.js');
	const server = http.createServer((req, res) => {
		if (req.url === '/stall') {
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: {"n":1}\n\n'); // then nothing
		} // /silent: never answers
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const saved = { ...WATCHDOG };
	Object.assign(WATCHDOG, { localFirstByteMs: 300, localIdleMs: 300 });
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const t0 = Date.now();
		await assert.rejects(() => post(base + '/silent', {}, {}, new AbortController().signal, 'm'), /No response from 127\.0\.0\.1:\d+ within 0 s \(timed out\)/);
		const res = await post(base + '/stall', {}, {}, new AbortController().signal, 'm');
		const got = [];
		await assert.rejects(() => readSse(res, (d) => got.push(d)), /stream stalled — no data for 0 s \(timed out\)/);
		assert.deepStrictEqual(got, ['{"n":1}'], 'data before the stall still delivered');
		assert.ok(Date.now() - t0 < 3000, 'fast');
		// A user stop is still an abort, not a timeout.
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		await assert.rejects(() => post(base + '/silent', {}, {}, ac.signal, 'm'), (e) => !/timed out/.test(e.message));
	} finally {
		Object.assign(WATCHDOG, saved);
		server.closeAllConnections();
		server.close();
	}
});

test('v0.24 foreign sessions: Claude Code and Codex chats become zer0ne chats', () => {
	const os = require('os');
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zforeign-'));
	const saved = process.env.ZER0NE_FOREIGN_HOME;
	process.env.ZER0NE_FOREIGN_HOME = home;
	try {
		const cwd = path.join(home, 'proj');
		const cc = path.join(home, '.claude', 'projects', 'proj');
		fs.mkdirSync(cc, { recursive: true });
		const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
		fs.writeFileSync(path.join(cc, 'c1.jsonl'), jl([
			{ type: 'user', cwd, isMeta: true, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
			{ type: 'user', cwd, message: { role: 'user', content: 'Fix the flaky test in auth.spec.ts' } },
			{ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Looking at it.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'auth.spec.ts' } }] } },
			{ type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'it("logs in", async () => {' }] } },
			{ type: 'assistant', cwd, isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } },
			{ type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: 'The await was missing.' }] } },
			{ type: 'summary', summary: 'Flaky auth test' }
		]));
		const cx = path.join(home, '.codex', 'sessions', '2026', '09', '27');
		fs.mkdirSync(cx, { recursive: true });
		fs.writeFileSync(path.join(cx, 'rollout-2026-09-27T10-00-00-abc.jsonl'), jl([
			{ type: 'session_meta', payload: { id: 'abc', cwd: path.join(home, 'other') } },
			{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' }] } },
			{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a README' }] } },
			{ type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['ls', '-la'] }) } },
			{ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'total 4\nREADME.md' } },
			{ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added README.md.' }] } }
		]));
		const { listForeignSessions, loadForeignSession } = require(OUT + '/foreignSessions.js');
		const list = listForeignSessions(cwd);
		assert.deepStrictEqual(list.map((s) => [s.source, s.title]), [['claude', 'Flaky auth test'], ['codex', 'Add a README']], "this project's chats first");
		const claude = loadForeignSession(list[0]);
		assert.deepStrictEqual(claude.map((m) => (m.tool ? `tool:${m.tool.name}(${m.tool.arg})→${m.tool.summary}` : `${m.role}:${m.content}`)), [
			'user:Fix the flaky test in auth.spec.ts',
			'assistant:Looking at it.',
			'tool:Read(auth.spec.ts)→it("logs in", async () => {',
			'assistant:The await was missing.'
		]);
		const codex = loadForeignSession(list[1]);
		assert.deepStrictEqual(codex.map((m) => (m.tool ? `tool:${m.tool.name}(${m.tool.arg})→${m.tool.summary}` : `${m.role}:${m.content}`)), ['user:Add a README', 'tool:shell(ls -la)→total 4', 'assistant:Added README.md.']);
	} finally {
		if (saved === undefined) delete process.env.ZER0NE_FOREIGN_HOME;
		else process.env.ZER0NE_FOREIGN_HOME = saved;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test('v0.24 sign-in: a cancelled browser sign-in frees port 1455 and leaves no timer behind', async () => {
	const http = require('http');
	const { signIn } = require(OUT + '/accounts.js');
	const ac = new AbortController();
	const events = [];
	const run = signIn('chatgpt', { hostId: 'urn:uuid:12345678-1234-4123-8123-123456789012', method: 'browser', signal: ac.signal, open: () => ac.abort(), onEvent: (e) => events.push(e.stage) });
	await assert.rejects(run, /Sign-in cancelled/);
	assert.deepStrictEqual(events, ['browser']);
	await new Promise((resolve, reject) => {
		const s = http.createServer();
		s.once('error', reject);
		s.listen(1455, '127.0.0.1', () => s.close(resolve));
	});
});

test('v0.25 account check: model list, one streamed reply, forced refresh — the rotated token comes back to be saved', async () => {
	const { checkAccount } = require(OUT + '/accounts.js');
	const realFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
		if (/oauth2\/token/.test(url)) return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
		return json({ data: [{ id: 'grok-4.7' }, { id: 'grok-4.6' }] });
	};
	try {
		const cred = { kind: 'account', account: 'xai', access: 'access-1', refresh: 'refresh-1', expires: Date.now() + 3600_000 };
		let asked;
		const r = await checkAccount(cred, async (o) => {
			asked = o;
			o.onText('zer0ne');
			return { text: 'zer0ne connection ok', reasoning: '', usage: { input: 30, output: 5 } };
		}, new AbortController().signal);
		assert.strictEqual(r.ok, true, JSON.stringify(r.steps));
		assert.strictEqual(r.steps.length, 3);
		assert.match(r.steps[1].text, /answered "zer0ne connection ok" · first token \d+ ms/);
		assert.strictEqual(asked.apiKey, 'access-1');
		assert.strictEqual(asked.baseUrl, 'https://api.x.ai/v1');
		assert.strictEqual(r.refreshed.access, 'access-2', 'refreshed even though the token was still fresh');
		assert.strictEqual(r.refreshed.refresh, 'refresh-2', 'the rotated refresh token is returned so it can be saved');
		assert.ok(calls.some((u) => /auth\.x\.ai\/oauth2\/token/.test(u)));
		// A failing model call stops the check and says why.
		const bad = await checkAccount(cred, async () => { throw new Error('402: no active SuperGrok plan'); }, new AbortController().signal);
		assert.strictEqual(bad.ok, false);
		assert.match(bad.steps.at(-1).text, /402: no active SuperGrok plan/);
		assert.strictEqual(bad.refreshed, undefined);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('v0.26 MiniMax stored session: legacy token refresh remains usable; new logins use the supported plan route', async () => {
 const { signIn, ensureFresh, ACCOUNTS } = require(OUT + '/accounts.js');
 assert.strictEqual(ACCOUNTS.minimax.apiFormat, 'anthropic');
 assert.strictEqual(ACCOUNTS.minimax.baseUrl, 'https://api.minimax.io/anthropic');
 await assert.rejects(signIn('minimax', { signal: new AbortController().signal, open: () => { throw new Error('must not open a copied OAuth client'); }, onEvent: () => {} }), /official agent or dedicated plan key/);
 const realFetch = globalThis.fetch, expires = Date.now() + 3600_000;
 let request;
 globalThis.fetch = async (url, init) => {
  request = { url: String(url), fields: Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))) };
  return new Response(JSON.stringify({ status: 'success', access_token: 'mm-access-2', refresh_token: 'mm-refresh-2', expired_in: expires }), { status: 200, headers: { 'content-type': 'application/json' } });
 };
 try {
  const fresh = await ensureFresh({ kind: 'account', account: 'minimax', access: 'mm-access', refresh: 'mm-refresh', expires: 0 });
  assert.strictEqual(request.url, 'https://account.minimax.io/oauth2/token');
  assert.strictEqual(request.fields.grant_type, 'refresh_token');
  assert.strictEqual(request.fields.refresh_token, 'mm-refresh');
  assert.deepStrictEqual([fresh.access, fresh.refresh, fresh.expires], ['mm-access-2', 'mm-refresh-2', expires]);
 } finally { globalThis.fetch = realFetch; }
});



test('v0.27 subscription and API key together: a plan out of quota continues on its linked key provider, same model', () => {
	const { twinProvider } = require(OUT + '/host/modelCaller.js');
	const model = (id) => ({ id, enabled: true });
	const sub = { id: 'p1', name: 'MiniMax', enabled: true, preset: 'minimax-account', models: [model('MiniMax-M3')] };
	const key = { id: 'p2', name: 'MiniMax Coding Plan', enabled: true, preset: 'minimax-coding-plan', models: [model('MiniMax-M3')] };
	const other = { id: 'p3', name: 'OpenRouter', enabled: true, preset: 'openrouter', models: [model('MiniMax-M3')] };
	assert.strictEqual(twinProvider(sub, 'MiniMax-M3', [sub, other, key]).provider.id, 'p2', 'the linked key, never an unrelated gateway');
	assert.strictEqual(twinProvider(key, 'MiniMax-M3', [key, sub]).provider.id, 'p1', 'and back: the key to its subscription');
	assert.strictEqual(twinProvider(sub, 'MiniMax-M2', [sub, key]), undefined, 'same model only');
	assert.strictEqual(twinProvider(sub, 'MiniMax-M3', [sub, { ...key, enabled: false }]), undefined, 'disabled providers are skipped');
});

test('v0.27 presets: Command Code, OpenCode Go, Claude / Antigravity subscriptions with honest key routes; every link resolves', () => {
	const { PRESETS, presetById } = require(OUT + '/presets.js');
	const ids = PRESETS.map((p) => p.id);
	assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate ids');
	for (const id of ['commandcode', 'opencode-go', 'claude-plan', 'antigravity', 'cline-pass', 'devpass', 'nano-gpt', 'zenmux', 'minimax-account']) assert.ok(presetById(id), id);
	assert.strictEqual(presetById('commandcode').baseUrl, 'https://api.commandcode.ai/provider/v1');
	for (const id of ['claude-plan', 'antigravity']) {
		const p = presetById(id);
		assert.strictEqual(p.kind, 'apiKey', id + ' connects with a key, never a subscription login');
		assert.ok(p.note && p.keyUrl, id + ' says why and where the key comes from');
	}
	for (const p of PRESETS) {
		if (p.keyPreset) assert.ok(presetById(p.keyPreset), p.id + ' → ' + p.keyPreset);
		if (p.baseUrl) assert.ok(/^https:\/\/|^http:\/\/(localhost|127\.)/.test(p.baseUrl), p.id + ' base URL');
	}
});











test('v0.28 local models: repo ids, download parts, exact shard files, engine settings, checksum, key over http', () => {
	const E = require(OUT + '/localEngine.js');
	const os = require('os');
	assert.ok(E.validRepoId('unsloth/Qwen3-8B-GGUF') && E.validRepoId('a/b.c-d_e'));
	for (const bad of ['../../etc', 'a/../b', 'a/b/c', 'noslash', '', 'a/..', '/abs/x', 'a b/c', null, 7]) assert.ok(!E.validRepoId(bad), 'rejects ' + bad);
	assert.deepStrictEqual(E.safeGgufParts(['Q4/m-00001-of-00002.gguf', 'Q4/m-00002-of-00002.gguf']), ['Q4/m-00001-of-00002.gguf', 'Q4/m-00002-of-00002.gguf']);
	for (const bad of [[], ['../m.gguf'], ['/etc/passwd.gguf'], ['a\\b.gguf'], ['a\nb.gguf'], ['a\u0008b.gguf'], ['m.bin'], ['a//b.gguf'], 'm.gguf', new Array(65).fill('m.gguf')]) assert.strictEqual(E.safeGgufParts(bad), undefined);
	// Deleting Q4_K must not take Q4_K_M with it; split models take exactly their shards.
	const dir = path.join('C:', 'models');
	const all = ['m-Q4_K.gguf', 'm-Q4_K_M.gguf', 'm-Q4_K_M-00001-of-00002.gguf', 'm-Q4_K_M-00002-of-00002.gguf', 'm-Q4_K_M-00001-of-00003.gguf', 'mmproj-F16.gguf'];
	assert.deepStrictEqual(E.ggufFiles(path.join(dir, 'm-Q4_K.gguf'), all), [path.join(dir, 'm-Q4_K.gguf')]);
	assert.deepStrictEqual(E.ggufFiles(path.join(dir, 'm-Q4_K_M-00001-of-00002.gguf'), all), [path.join(dir, 'm-Q4_K_M-00001-of-00002.gguf'), path.join(dir, 'm-Q4_K_M-00002-of-00002.gguf')]);
	assert.deepStrictEqual(E.sanitizeEngineSettings({ backend: 'cuda', port: 8181, context: '32768', gpu: 'cpu', lightKv: false, speedBoost: true, evil: 1 }), { backend: 'cuda', port: 8181, context: 32768, gpu: 'cpu', lightKv: false, speedBoost: true });
	assert.deepStrictEqual(E.sanitizeEngineSettings({ backend: 'rm -rf', port: 22, context: -5, gpu: 'x', lightKv: 'yes' }), { context: 0 }, 'unknown backend, privileged port, non-boolean dropped; negative context = auto');
	assert.deepStrictEqual(E.sanitizeEngineSettings({ port: 70000, context: 100 }), { context: 512 });
	assert.deepStrictEqual(E.sanitizeEngineSettings(null), {});
	// Checksum GitHub publishes for release assets
	const f = path.join(os.tmpdir(), 'zla-digest-' + process.pid + '.bin');
	fs.writeFileSync(f, 'engine bytes');
	const sha = require('crypto').createHash('sha256').update('engine bytes').digest('hex');
	assert.strictEqual(E.digestMatches(f, 'sha256:' + sha), true);
	assert.strictEqual(E.digestMatches(f, 'sha256:' + '0'.repeat(64)), false);
	assert.strictEqual(E.digestMatches(f, undefined), false, 'a release without a digest is a failed verification, not a pass');
	fs.rmSync(f, { force: true });
	// An API key must not travel over plain http:// to the internet
	const { insecureRemote } = require(OUT + '/netSafety.js');
	for (const url of ['http://api.example.com/v1', 'http://8.8.8.8:8080/v1', 'http://kenari.id']) assert.ok(insecureRemote(url), url);
	for (const url of ['https://api.example.com/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.20.1.1/v1', 'http://nas.local:8080/v1', 'http://box/v1', 'http://100.101.102.103:8080/v1', 'http://laptop.tail1234.ts.net/v1', 'not a url']) assert.ok(!insecureRemote(url), url);
	assert.ok(insecureRemote('http://172.32.0.1/v1'), '172.32 is public');
});

test('v0.28 turbo fit: memory bandwidth tells Apple chips and Arc cards apart', () => {
	const { bandwidth } = require(OUT + '/turboFit.js');
	const mac = (name) => bandwidth({ platform: 'darwin', gpuName: name + ' (unified memory)', unifiedMemory: true });
	assert.deepStrictEqual([mac('Apple M3').gpu, mac('Apple M3 Pro').gpu, mac('Apple M3 Max').gpu, mac('Apple M2 Ultra').gpu], [100, 200, 400, 750], 'a Max is not a base chip');
	const arc = (name) => bandwidth({ platform: 'win32', gpuName: name, unifiedMemory: false }).gpu;
	assert.strictEqual(arc('Intel(R) Arc(TM) A770 Graphics'), 450, 'the (TM) mark no longer hides the card');
	assert.strictEqual(arc('Intel(R) Arc(TM) B580 Graphics'), 450);
	assert.strictEqual(arc('Intel(R) Arc(TM) A380 Graphics'), 180);
	assert.strictEqual(arc('Intel(R) Arc(TM) 140V GPU (16GB)'), 120, 'the Lunar Lake iGPU keeps its own class');
});

test('helper-process env scrub drops credentials, keeps the rest', () => {
	const { scrubEnv } = require(OUT + '/tools/proc.js');
	const env = {
		PATH: '/usr/bin', HOME: '/home/u', CUDA_CACHE_PATH: '/tmp/cuda',
		OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'wJalr', MY_PASSWORD: 'h2',
		ANTHROPIC_AUTH_TOKEN: 't', DATABRICKS_HOST: 'dbc'
	};
	const out = scrubEnv(env);
	assert.strictEqual(out.PATH, '/usr/bin');
	assert.strictEqual(out.CUDA_CACHE_PATH, '/tmp/cuda', 'GPU/runtime vars pass through');
	assert.ok(!('OPENAI_API_KEY' in out) && !('GITHUB_TOKEN' in out) && !('AWS_SECRET_ACCESS_KEY' in out));
	assert.ok(!('MY_PASSWORD' in out) && !('ANTHROPIC_AUTH_TOKEN' in out), 'credential-shaped names are dropped');
	assert.strictEqual(out.DATABRICKS_HOST, 'dbc', 'non-credential names survive');
	const git = scrubEnv({ PATH: '/usr/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic eA==' });
	assert.deepStrictEqual(git, { PATH: '/usr/bin' }, 'git config pairs leave together: no orphaned count, no header value');
});

test('webfetch provenance: normalize, extract, allow', () => {
	const { normalizeUrl, extractUrls, provenanceAllows } = require(OUT + '/tools/web.js');
	assert.strictEqual(normalizeUrl('https://example.com/a/?x=1#frag'), 'https://example.com/a/?x=1', 'hash dropped');
	assert.strictEqual(normalizeUrl('example.com/a'), 'https://example.com/a', 'schemeless gets https');
	assert.strictEqual(normalizeUrl('javascript:alert(1)'), undefined);
	assert.deepStrictEqual(extractUrls('see https://example.com/docs, then ftp://x and https://a.test/b.'), ['https://example.com/docs', 'https://a.test/b'], 'trailing punctuation stripped, non-http skipped');
	const set = new Set(extractUrls('start from https://example.com/start'));
	assert.ok(provenanceAllows(set, 'https://example.com/start'), 'a user link is allowed');
	assert.ok(provenanceAllows(set, 'https://example.com/start#section'), 'same page, other anchor');
	assert.ok(!provenanceAllows(set, 'https://evil.test/injected'), 'anything else is not');
});

test('artifact contract: slug, refusal list, allowlisted CDNs', () => {
	const { artifactSlug, validateArtifact, MAX_ARTIFACT_BYTES } = require(OUT + '/tools/artifact.js');
	assert.strictEqual(artifactSlug('  Sales Report — Q3!! '), 'sales-report-q3');
	assert.deepStrictEqual(validateArtifact('<!doctype html><html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/chart.js/4.5.1/chart.umd.js"></script></head><body>hi</body></html>'), [], 'cdnjs is allowed');
	assert.deepStrictEqual(validateArtifact('<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"></head><body>x</body></html>'), [], 'Google Fonts styles allowed');
	const bad = validateArtifact('<html><body><iframe src="https://x"></iframe><script src="http://insecure/cdn.js"></script><script src="https://evil.test/x.js"></script></body></html>');
	assert.ok(bad.some((p) => /iframe/i.test(p)), 'iframes refused');
	assert.ok(bad.some((p) => /https/.test(p) && /insecure/.test(p)), 'http-only script refused');
	assert.ok(bad.some((p) => /only load from/.test(p)), 'non-allowlisted host refused');
	assert.ok(validateArtifact('a'.repeat(MAX_ARTIFACT_BYTES + 1)).some((p) => /5 MB/.test(p)), 'size cap');
	assert.ok(validateArtifact('<body>no close</body>').some((p) => /complete document/.test(p)));
});

test('v0.33.4 mobile remote: the own-tunnel ssh mode validates targets, builds safe args and reads the printed URL', () => {
	const { sshTargetError, sshArgs, sshUrlFromLog, sshErrorFromLog } = require(OUT + '/tunnel.js');
	assert.strictEqual(sshTargetError('stable@proxy.your-domain.com'), undefined, 'tunnl.gg stable@ target');
	assert.strictEqual(sshTargetError('serveo.net'), undefined, 'a bare host works too');
	assert.strictEqual(sshTargetError('root@10.0.0.2:2222'), undefined, 'host with its own port');
	assert.ok(sshTargetError(''), 'empty target refused');
	assert.ok(sshTargetError('-oProxyCommand=evil'), 'a target starting with a dash is refused (ssh would read it as an option)');
	assert.ok(sshTargetError('has space@x') && sshTargetError('b@d host'), 'spaces refused');
	assert.ok(sshTargetError('user@host:70000'), 'an impossible port is refused');
	assert.deepStrictEqual(
		sshArgs('stable@proxy.x', 80, 7654),
		['-tt', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-R', '80:127.0.0.1:7654', 'stable@proxy.x'],
		'toFU host keys, fail on failed forwards, keepalive, the reverse forward, the target — no shell in between'
	);
	assert.strictEqual(sshUrlFromLog('Warning: something unrelated\r\nhttps://happy-tiger-a1b2c3d4.tunnl.example.com'), 'https://happy-tiger-a1b2c3d4.tunnl.example.com', 'the tunnel host prints its URL on connect');
	assert.strictEqual(sshUrlFromLog('see https://x.example.com.'), 'https://x.example.com', 'trailing punctuation is not part of the URL');
	assert.ok(!sshUrlFromLog('no url yet'));
	assert.strictEqual(sshErrorFromLog('debug1: Connecting...\nuser@host: Permission denied (publickey).'), 'user@host: Permission denied (publickey).', 'the actionable ssh failure surfaces');
	assert.ok(!sshErrorFromLog('Connection established.'), 'nothing wrong to report');
});

(async () => {
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log('ok  ' + name);
	} catch (e) {
		failed++;
		console.error('FAIL ' + name + '\n', e);
	}
}
console.log(failed ? `\n${failed} UNIT TEST(S) FAILED` : '\nALL UNIT TESTS PASSED');
process.exitCode = failed ? 1 : 0; // no process.exit: let sockets close cleanly (Windows libuv)
})();
