// Hardening and desktop additions: project command rules, secrets hidden from agent commands,
// Full access still asking where the rules say so, release notes after an update, and the kept
// run_script REPL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const OUT = path.join(__dirname, '..', 'out');

// turnRunner imports vscode; nothing here reaches it at load time beyond property reads.
const stub = new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : stub), apply: () => stub, construct: () => stub });
const resolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: stub };

(async () => {
	// ---- command rules
	const { parseCommandRules, commandVerdict, readCommandRules, COMMAND_RULES_FILE } = require(OUT + '/tools/commandRules.js');
	const rules = parseCommandRules(['# project rules', 'allow: npm test', 'allow: npm run lint*', 'ask: git push*', 'deny: rm -rf *', 'deny: curl *  # no downloads', 'nonsense line'].join('\n'));
	assert.equal(commandVerdict(rules, 'npm test'), 'allow');
	assert.equal(commandVerdict(rules, 'npm run lint -- --fix'), 'allow', '* matches the rest of the command');
	assert.equal(commandVerdict(rules, 'npm test && rm -rf build'), 'deny', 'deny checks every part of a chain');
	assert.equal(commandVerdict(rules, 'npm test | tee out.txt'), undefined, 'allow never covers a pipe or chain');
	assert.equal(commandVerdict(rules, 'git push origin main'), 'ask');
	assert.equal(commandVerdict(rules, 'git status && git push'), 'ask', 'ask checks every part too');
	assert.equal(commandVerdict(rules, 'curl https://x.example'), 'deny', 'a trailing comment is not part of the pattern');
	assert.equal(commandVerdict(rules, 'git status'), undefined);
	// Every way a shell runs a second command still meets deny and ask (PowerShell and sh).
	for (const cmd of ['echo x & git push --force', 'echo $(git push --force)', 'echo `git push`', 'echo (git push)', 'echo @(git push)', '& { git push }', 'cmd /c git push', 'powershell -NoProfile -Command "git push"', 'sh -c \'git push\'', 'git.exe push', 'git   push', '"git" push', 'env A=1 git push'])
		assert.equal(commandVerdict(rules, cmd), 'ask', cmd);
	for (const cmd of ['echo x & rm -rf build', 'diff <(rm -rf a) b', 'Write-Output (rm -rf ~)'])
		assert.equal(commandVerdict(rules, cmd), 'deny', cmd);
	assert.equal(commandVerdict(rules, 'npm test (Remove-Item -Recurse ~)'), undefined, 'allow never covers a PowerShell (…) argument');
	assert.equal(commandVerdict(rules, 'npm test & calc'), undefined, 'nor a backgrounded second command');
	const { COMPOUND } = require(OUT + '/tools/commandRules.js');
	assert(COMPOUND.test('npm test (rm x)') && COMPOUND.test('npm test & calc'));

	// A repository's own rules loosen nothing until the user trusts them.
	const { setCommandRulesTrustDir, trustCommandRules, untrustCommandRules, commandRulesStatus, waitsForTrust } = require(OUT + '/tools/commandRules.js');
	const trustDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-rules-trust-'));
	setCommandRulesTrustDir(trustDir);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-rules-'));
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf *'), undefined, 'no file, no rules');
	fs.mkdirSync(path.join(root, '.zer0ne'));
	fs.writeFileSync(path.join(root, COMMAND_RULES_FILE), 'deny: rm -rf *\n');
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf dist'), 'deny', 'deny applies without trust');
	fs.writeFileSync(path.join(root, COMMAND_RULES_FILE), 'deny: del *\nallow: rm -rf dist\nallow: *\n');
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf dist'), undefined, 'an untrusted allow line runs nothing');
	assert(waitsForTrust(readCommandRules(root), 'rm -rf dist'), 'it is reported as waiting for trust');
	assert.deepEqual(commandRulesStatus(root).pendingAllow, ['rm -rf dist', '*']);
	trustCommandRules(root);
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf dist'), 'allow', 'a trusted allow line applies');
	fs.writeFileSync(path.join(root, COMMAND_RULES_FILE), 'allow: rm -rf dist\nallow: curl *\n');
	assert.equal(commandVerdict(readCommandRules(root), 'curl https://x.example'), undefined, 'a new allow line waits for trust again');
	assert.equal(commandVerdict(readCommandRules(root), 'del notes.txt'), 'deny', 'a trusted deny line outlives its removal from the file');
	assert.deepEqual(commandRulesStatus(root).kept, ['deny: del *']);
	untrustCommandRules(root);
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf dist'), undefined, 'untrusting stops the allow lines');
	setCommandRulesTrustDir(undefined);
	assert.equal(commandVerdict(readCommandRules(root), 'rm -rf dist'), undefined, 'without a trust store no allow line applies');
	setCommandRulesTrustDir(trustDir);

	// ---- secrets hidden from agent commands; deny rules refuse before any approval card
	const { commandEnv, approveCommand } = require(OUT + '/tools/command.js');
	process.env.ZC_TEST_API_KEY = 'sk-test-123';
	process.env.ZC_TEST_PLAIN = 'kept';
	assert.equal(commandEnv(true).ZC_TEST_API_KEY, undefined, 'credential-shaped variables are dropped');
	assert.equal(commandEnv(true).ZC_TEST_PLAIN, 'kept');
	assert.equal(commandEnv(false).ZC_TEST_API_KEY, 'sk-test-123', 'turning the setting off keeps them');
	let asked = 0;
	const ctx = (settings) => ({ settings: { commandTool: true, ...settings }, signal: new AbortController().signal, requestApproval: async (r) => { asked++; ctx.last = r; return { approved: true, auto: false, finish() {} }; } });
	fs.writeFileSync(path.join(root, COMMAND_RULES_FILE), 'deny: rm -rf *\nask: git push*\n');
	await assert.rejects(approveCommand('rm -rf build', root, root, ctx({})), /command rules/);
	assert.equal(asked, 0, 'a denied command never reaches the approval card');
	const c = ctx({});
	const plan = await approveCommand('git push', root, root, c);
	assert.equal(ctx.last.projectRule, 'ask', 'the approval request carries the rule');
	assert.equal(plan.env.ZC_TEST_API_KEY, undefined, 'secrets are hidden by default');
	assert.equal((await approveCommand('echo hi', root, root, ctx({ hideCommandSecrets: false }))).env.ZC_TEST_API_KEY, 'sk-test-123');

	// ---- Full access approves everything except what the rules say must ask
	const { approvalRule, autoRule } = require(OUT + '/host/turnRunner.js');
	const settings = { autoApproveCommands: true, sandbox: 'auto', commandAllowlist: '' };
	assert.equal(approvalRule({ kind: 'command', command: 'git push', projectRule: 'ask' }, 'full', settings), undefined, 'ask outranks Full access');
	assert.equal(approvalRule({ kind: 'command', command: 'ls' }, 'full', settings), 'full');
	assert.equal(autoRule({ kind: 'command', command: 'npm test', projectRule: 'allow' }, { ...settings, autoApproveCommands: false }), 'project rules');
	assert.equal(autoRule({ kind: 'command', command: 'git push', projectRule: 'ask' }, settings), undefined, 'ask outranks auto-approve');

	assert.equal(autoRule({ kind: 'command', command: 'npm test (Remove-Item ~)' }, { ...settings, autoApproveCommands: false, commandAllowlist: 'npm test' }), undefined, 'the allowlist never covers a (…) argument');
	assert.equal(autoRule({ kind: 'command', command: 'npm test', projectRule: 'pending' }, { ...settings, autoApproveCommands: false }), undefined, 'an untrusted allow line approves nothing');

	// ---- web_fetch reaches local and private addresses only on an origin the user shared
	const { webFetch, isPrivateAddress } = require(OUT + '/tools/web.js');
	for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]'])
		assert(isPrivateAddress(ip), ip);
	for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) assert(!isPrivateAddress(ip), ip);
	const http = require('node:http');
	const server = http.createServer((req, res) => {
		if (req.url === '/hop') { res.writeHead(302, { location: `http://localhost:${server.address().port}/page` }); res.end(); return; }
		res.writeHead(200, { 'content-type': 'text/plain' }); res.end('local page');
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		await assert.rejects(webFetch(base + '/page'), /local or private address/, 'a link the user did not share cannot reach localhost');
		assert.equal((await webFetch(base + '/page', 1000, undefined, new Set([base + '/']))).text, 'local page', 'a shared origin can');
		await assert.rejects(webFetch(base + '/hop', 1000, undefined, new Set([base + '/'])), /localhost.*local or private address/, 'a redirect to another private origin is checked again');
	} finally {
		server.close();
	}

	// ---- What's new
	const { releaseNotes, whatsNewFor } = require(OUT + '/host/whatsNew.js');
	const log = '# Changelog\n\n## Unreleased\n\n- Not yet\n\n## 1.2.0\n\n- Added **Quick window** (`Ctrl+Alt+Space`)\n  continued line\n- Fixed find\n\n## 1.1.0\n\n- Old\n';
	assert.deepEqual(releaseNotes(log, '1.2.0'), ['Added Quick window (Ctrl+Alt+Space)', 'Fixed find']);
	assert.deepEqual(releaseNotes(log, '9.9.9'), []);
	const app = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-app-'));
	fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ version: '1.2.0' }));
	fs.writeFileSync(path.join(app, 'CHANGELOG.md'), log);
	assert.deepEqual(whatsNewFor(app, undefined), { version: '1.2.0' }, 'a first install shows nothing');
	assert.deepEqual(whatsNewFor(app, '1.2.0'), { version: '1.2.0' }, 'an unchanged version shows nothing');
	assert.deepEqual(whatsNewFor(app, '1.1.0').show, { version: '1.2.0', notes: ['Added Quick window (Ctrl+Alt+Space)', 'Fixed find'], more: 0 });

	// ---- run_script keep: a REPL whose state survives between runs of one chat only
	const { runScript, resetScriptSession } = require(OUT + '/tools/script.js');
	const call = async () => ({ text: '' });
	const o = { timeoutMs: 20000, maxCalls: 5 };
	assert.equal((await runScript('state.n = 41; print(state.n)', call, { ...o, keep: 'chat-a' })).output, '41');
	assert.equal((await runScript('state.n += 1; print(state.n)', call, { ...o, keep: 'chat-a' })).output, '42', 'kept state survives');
	assert.equal((await runScript('print(state.n === undefined)', call, { ...o, keep: 'chat-b' })).output, 'true', 'another chat has its own state');
	assert.equal((await runScript('print(state.n === undefined)', call, o)).output, 'true', 'without keep every run starts fresh');
	assert.equal(resetScriptSession('chat-a'), true);
	assert.equal((await runScript('print(state.n === undefined)', call, { ...o, keep: 'chat-a' })).output, 'true', 'reset discards the state');
	assert.match((await runScript('while (true) {}', call, { ...o, timeoutMs: 1500, keep: 'chat-a' })).error, /Timed out/);
	assert.equal((await runScript('print(state.n === undefined)', call, { ...o, keep: 'chat-a' })).output, 'true', 'a timeout ends the kept process');
	resetScriptSession('chat-a');
	resetScriptSession('chat-b');

	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(app, { recursive: true, force: true });
	console.log('Hardening passed: command rules (allow/ask/deny, chains), hidden command secrets, Full access asks where the rules say, release notes, kept run_script REPL.');
})().catch((e) => { console.error(e); process.exit(1); });
