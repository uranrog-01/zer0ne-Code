const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const engineOut = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');
const { BrowserAgent, findBrowser } = require(path.join(engineOut, 'tools/browser'));
const { browserSteps } = require(path.join(engineOut, 'tools/browserBatch'));
const { SkillStore } = require(path.join(engineOut, 'tools/skills'));

test('batch validates every step before use, with bounded input and no script escape', () => {
	assert.equal(browserSteps([{ action: 'type', ref: 1, text: 'hello' }, { action: 'click', ref: 2 }]).length, 2);
	for (const steps of [[], Array(13).fill({ action: 'click', ref: 1 }), [{ action: 'evaluate', expression: 'fetch("/")' }], [{ action: 'click', ref: 0 }], [{ action: 'type', ref: 1 }], [{ action: 'wait_for', seconds: Infinity }], [{ action: 'press', key: 'Enter', hiddenCode: 'x' }]]) {
		assert.throws(() => browserSteps(steps));
	}
});

test('standard user and workspace skills are discovered and remain read-only', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-skills-browser-'));
	try {
		for (const [base, name] of [['home/.agents', 'ego-browser'], ['home/.codex', 'review'], ['project/.agents', 'qa'], ['project/.codex', 'inspect']]) {
			const folder = path.join(dir, base, 'skills', name);
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture\n---\nUse fixture.`);
		}
		const store = new SkillStore(path.join(dir, 'local'), () => path.join(dir, 'project'), () => [], () => [], path.join(dir, 'home'));
		const skills = store.list();
		assert.equal(skills.length, 4);
		assert.ok(skills.every(s => !s.editable));
		assert.equal(store.read('ego-browser').body, 'Use fixture.');
		assert.throws(() => store.remove('ego-browser'), /read-only/);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('batch permission gate rejects Plan mode, restricted agents, invalid input and denied approval before execution', async () => {
	const { createDesktopShim } = require('../../host/desktop-shim');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-browser-policy-'));
	try {
		const { shim, install } = createDesktopShim({ engineDir: path.dirname(engineOut), workspace: dir, dataDir: path.join(dir, 'data'), rpc: async () => null });
		install(shim.vscode);
		const { runTool, buildToolDefs } = require(path.join(engineOut, 'tools/agentTools'));
		const { DEFAULT_SETTINGS } = require(path.join(engineOut, 'providerStore'));
		let approvals = 0, executions = 0;
		const ctx = { settings: { ...DEFAULT_SETTINGS, browserAgent: true }, signal: new AbortController().signal,
			requestApproval: async () => { approvals++; return { approved: false, finish() {} }; },
			browser: { batch: async () => { executions++; throw new Error('Must not execute'); } } };
		const call = { id: 'batch-test', name: 'browser_batch', arguments: JSON.stringify({ steps: [{ action: 'click', ref: 1 }] }) };
		assert.equal((await runTool(call, { ...ctx, readOnly: true })).error, true);
		assert.equal((await runTool(call, { ...ctx, allowedTools: new Set(['browser_snapshot']) })).error, true);
		assert.equal((await runTool({ ...call, arguments: '{"steps":[{"action":"evaluate"}]}' }, ctx)).error, true);
		assert.equal(approvals, 0);
		assert.equal((await runTool(call, ctx)).error, true);
		assert.equal(approvals, 1);
		assert.equal(executions, 0);
		assert.ok(buildToolDefs(ctx.settings, {}).some(t => t.name === 'browser_batch'));
		assert.ok(!buildToolDefs(ctx.settings, { readOnly: true }).some(t => ['browser_batch', 'browser_evaluate'].includes(t.name)));
	} finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
});

test('real browser: cross-origin frames, stable refs, batching, stale/covered targets and tab lifecycle', { timeout: 120_000 }, async t => {
	if (!findBrowser()) { t.skip('Chrome/Edge is not installed'); return; }
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-browser-upgrade-'));
	let port;
	const server = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html');
		if (req.url === '/frame') return res.end(`<label>Frame name<input id="name"></label><button onclick="parent.postMessage('saved:'+document.querySelector('input').value,'*')">Save frame</button><iframe style="width:350px;height:100px" src="http://localhost:${port}/nested"></iframe>`);
		if (req.url === '/nested') return res.end(`<button onclick="top.postMessage('nested clicked','*')">Nested action</button>`);
		res.end(`<!doctype html><title>Browser upgrade fixture</title><style>body{margin:20px}iframe{display:block;width:600px;height:220px;margin:20px;border:3px solid}</style>
			<label>Username<input id="name"></label><label>Password<input type="password" value="never-in-snapshot"></label>
			<button id="stable" onclick="document.querySelector('output').textContent='stable clicked'">Stable action</button>
			<button id="disabled" disabled>Disabled action</button><output>Ready</output>
			<div id="shadow"></div><script>
			shadow.attachShadow({mode:'open'}).innerHTML='<button onclick="document.querySelector(\\'output\\').textContent=\\'shadow clicked\\'">Shadow action</button>';
			window.addEventListener('message',e=>document.querySelector('output').textContent=e.data);
			</script><iframe src="http://127.0.0.1:${port}/frame"></iframe>`);
	});
	await new Promise(resolve => server.listen(0, resolve));
	port = server.address().port;
	const browser = new BrowserAgent(dir, () => ({ path: '', headless: true }));
	const ref = (s, label) => {
		const line = s.elements.split('\n').find(l => l.includes(`"${label}"`));
		assert.ok(line, `missing ${label} in:\n${s.elements}`);
		return Number(line.match(/^\[(\d+)\]/)[1]);
	};
	try {
		let s = await browser.navigate(`http://localhost:${port}/`);
		assert.ok(!s.elements.includes('never-in-snapshot'));
		assert.ok([...browser.contexts.values()].some(c => c.session), 'cross-origin iframe is out of process');
		const stable = ref(s, 'Stable action'), field = ref(s, 'Frame name'), save = ref(s, 'Save frame');
		const nested = ref(s, 'Nested action'), shadow = ref(s, 'Shadow action');
		await browser.evaluate(`(()=>{const b=document.createElement('button');b.textContent='Inserted';document.body.prepend(b);return true})()`);
		s = await browser.snapshot(false);
		assert.equal(ref(s, 'Stable action'), stable, 'inserting DOM before a target does not retarget its reference');
		assert.equal(s.screenshot, undefined);
		let shots = 0;
		const send = browser.send.bind(browser);
		browser.send = (...args) => { if (args[0] === 'Page.captureScreenshot') shots++; return send(...args); };
		const result = await browser.batch([{ action: 'type', ref: field, text: 'Ada' }, { action: 'click', ref: save }, { action: 'wait_for', text: 'saved:Ada', seconds: 2 }]);
		assert.equal(result.error, undefined);
		assert.equal(result.completed, 3);
		assert.ok(result.snapshot.text.includes('saved:Ada'));
		assert.equal(shots, 2, 'only final screenshot and thumbnail, none between steps');
		s = await browser.click({ ref: nested });
		assert.ok(s.text.includes('nested clicked'), 'nested cross-process frame coordinates');
		await browser.evaluate(`(()=>{document.body.style.transform='scale(0.8)';return true})()`);
		await assert.rejects(browser.click({ ref: save }), /transformed iframe/i);
		await browser.evaluate(`(()=>{document.body.style.transform='';return true})()`);
		s = await browser.click({ ref: shadow });
		assert.ok(s.text.includes('shadow clicked'));
		await assert.rejects(browser.click({ ref: ref(s, 'Disabled action') }), /disabled/);
		await browser.evaluate(`(()=>{document.getElementById('stable').outerHTML='<button id="stable">Replacement</button>';return true})()`);
		const stopped = await browser.batch([{ action: 'click', ref: stable }, { action: 'click', ref: save }], undefined, false);
		assert.equal(stopped.completed, 0);
		assert.match(stopped.error, /stale/i);
		s = stopped.snapshot;
		const partial = await browser.batch([{ action: 'type', ref: field, text: 'Grace' }, { action: 'click', ref: stable }, { action: 'click', ref: save }], undefined, false);
		assert.equal(partial.completed, 1, 'completed steps are reported when a later step fails');
		assert.match(partial.error, /stale/i);
		assert.ok(partial.snapshot.elements.includes('value="Grace"'), 'completed input is retained');
		assert.ok(!partial.snapshot.text.includes('saved:Grace'), 'steps after a failure do not run');
		const replacement = ref(s, 'Replacement');
		assert.notEqual(replacement, stable);
		await browser.evaluate(`(()=>{const d=document.createElement('div');d.id='cover';d.style='position:fixed;inset:0;z-index:9999;background:white';document.body.append(d);return true})()`);
		await assert.rejects(browser.click({ ref: replacement }), /covered/);
		await browser.evaluate(`(()=>{document.getElementById('cover').remove();return true})()`);
		const abort = new AbortController(); abort.abort();
		await assert.rejects(browser.batch([{ action: 'click', ref: replacement }], abort.signal), /abort/i);
		await browser.tabs('new', undefined, `http://localhost:${port}/`);
		await assert.rejects(browser.click({ ref: replacement }), /stale/i);
		assert.ok((await browser.snapshot(false)).title.includes('fixture'), 'old socket close does not reject new tab commands');
		const other = new BrowserAgent(dir, () => ({ path: '', headless: true }));
		try {
			await other.navigate(`http://localhost:${port}/?other-task`);
			assert.equal((await other.tabs('list')).split('\n').length, 1, 'another agent only sees its own tab');
			assert.ok(!(await browser.tabs('list')).includes('other-task'));
			await browser.close();
			assert.ok((await other.snapshot(false)).url.includes('other-task'), 'closing an agent does not close another task');
		} finally { await other.close(); }
	} catch (error) {
		console.error('Browser fixture failed:', error);
		console.error('Browser targets:', await browser.targets(await browser.readPort()).catch(() => []));
		throw error;
	} finally {
		await browser.close();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
		await new Promise(resolve => setTimeout(resolve, 500));
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
});
