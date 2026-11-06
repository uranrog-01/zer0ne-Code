'use strict';
// First-run setup page: the local-model picks, download progress, the key
// fallback, the folder handoff, and the guards that keep it from reopening.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { readPage } = require('./page-scripts');

const dom = new JSDOM('<body></body>', { runScripts: 'outside-only' });
const w = dom.window, d = w.document, posts = [];
const tasks = [];
const STRINGS = {
	setupTitle: 'Get started with a local model', setupIntro: 'Pick a model.', setupThisModel: 'this model',
	setupThisPC: 'This PC: {ram} GB RAM · {gpu}', setupCpuOnly: 'CPU only', setupFastMemory: 'About {gb} GB fast.',
	setupChecking: 'Checking…', setupNoPicks: 'No model fits.', setupFitPerfect: 'Fits well', setupFitGood: 'Fits',
	setupFitTight: 'Tight', setupFitSlow: 'Slower', setupFitNo: 'Too big',
	setupReasonFast: 'Speed', setupReasonBalanced: 'Balance', setupReasonQuality: 'Quality',
	setupDownload: 'Download and use', setupUse: 'Use this model', setupAlreadyHere: 'Already downloaded',
	setupUseKey: 'Use an API key instead', setupDownloading: 'Downloading {model}', setupStarting: 'Starting…',
	setupPreparing: 'Preparing the engine.', setupCancel: 'Cancel download', setupCancelled: 'Download cancelled.',
	setupDownloadFailed: 'Download failed.',
	setupKeyTitle: 'Connect with a key', setupKeyNote: 'The key is checked.', setupKeyPlaceholder: 'API key',
	setupKeyChecking: 'Checking…', setupKeyCheck: 'Check key', setupKeyEmpty: 'Paste a key.', setupKeyFailed: 'Bad key.',
	setupKeyReadyTitle: 'Provider connected', setupKeyReadyDesc: '{model} is ready. Here is a task:',
	setupBack: 'Back', setupFolderTitle: 'Choose a folder', setupFolderDesc: 'The agent works here.',
	setupChooseFolder: 'Choose a project folder…', setupFolderManual: 'Open a folder.', setupReadyTitle: 'Ready',
	setupReadyDesc: '{model} is ready. Here is a task:', setupFirstTask: 'Your first task', setupRunTask: 'Run it',
	setupNotNow: 'Not now', setupSkip: 'Skip', setupAllProviders: 'All providers'
};
const t = (key, vars) => {
	const text = STRINGS[key] || key;
	return vars ? text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? '')) : text;
};
const send = (data) => w.dispatchEvent(new w.MessageEvent('message', { data }));
w.eval(readPage('setup.js'));

const state = { providers: [], selection: {}, hasWorkspace: false };
const create = (extra = {}) => w.ChatSetup.create({
	post: (msg) => posts.push(JSON.parse(JSON.stringify(msg))),
	t,
	state: () => state,
	startTask: (text) => tasks.push(['start', text]),
	sendTask: (text) => tasks.push(['send', text]),
	openSettings: (section) => tasks.push(['settings', section]),
	remote: false,
	...extra
});

try {
	// First run with no folder: ask the host, then open.
	const setup = create();
	setup.maybeOpen();
	assert.deepEqual(posts.pop(), { type: 'setupStatus' }, 'the first run asks whether setup already ran');
	send({ type: 'setupStatus', done: false });
	assert.ok(d.querySelector('.setup-overlay'), 'a fresh install opens the setup overlay');
	assert.deepEqual(posts.pop(), { type: 'setupPlan' }, 'opening asks for the picks');

	send({
		type: 'setupPlan',
		machine: { ramGb: 32, gpuName: 'NVIDIA RTX 4060', gpuGb: 8, fastGb: 12 },
		picks: [
			{ preset: 'fast', id: 'a', name: 'Qwen Coder 4B', repo: 'o/a', verdict: 'perfect', quant: 'Q4_K_M', context: 16384, sizeGb: 2.6 },
			{ preset: 'balanced', id: 'b', name: 'Qwen Coder 14B', repo: 'o/b', verdict: 'good', quant: 'Q4_K_M', context: 16384, sizeGb: 8.4 },
			{ preset: 'quality', id: 'c', name: 'Qwen Coder 32B', repo: 'o/c', verdict: 'marginal', quant: 'Q4_K_M', context: 8192, sizeGb: 18.2, installedModelId: 'c-q4' }
		]
	});
	assert.equal(d.querySelectorAll('.setup-pick').length, 3, 'all three picks render');
	assert.match(d.querySelector('.setup-machine').textContent, /32 GB RAM · NVIDIA RTX 4060 · 8 GB/);
	assert.equal(d.querySelector('.setup-pick.is-selected .setup-pick-name').textContent, 'Qwen Coder 4B', 'the first pick starts selected');
	assert.match(d.querySelector('.setup-pick.is-selected').textContent, /Fits well.*Speed/, 'the verdict and reason are visible');
	assert.equal(d.querySelector('.setup-primary').textContent, 'Download and use');

	// Select the installed model: the action becomes Use, and its download is skipped.
	d.querySelectorAll('.setup-pick')[2].click();
	assert.equal(d.querySelector('.setup-primary').textContent, 'Use this model');
	assert.ok(d.querySelectorAll('.setup-pick')[2].classList.contains('is-selected'));

	// Download: the page names the pick; progress comes from the host's job.
	d.querySelectorAll('.setup-pick')[0].click();
	d.querySelector('.setup-primary').click();
	assert.deepEqual(posts.pop(), { type: 'setupInstall', id: 'a' });
	assert.ok(d.querySelector('.setup-progress'), 'a download shows a progress bar');
	send({ type: 'localJob', job: { key: 'hf:o/a/model.gguf', stage: 'Downloading and verifying model', received: 1e9, total: 2e9, rate: 10e6 } });
	assert.equal(Number.parseFloat(d.querySelector('.setup-progress-fill').style.width), 50, 'half the download is half the bar');
	assert.match(d.querySelector('.setup-progress-text').textContent, /1\.0 GB \/ 2\.0 GB · 10\.0 MB\/s/);

	// Installed with no folder: the folder step hands the first task to the new window.
	let created = 0;
	w.__zcCreateProject = () => { created++; };
	send({ type: 'setupInstalled', id: 'a', modelId: 'a-q4' });
	assert.match(d.querySelector('.setup-title').textContent, /Choose a folder/);
	d.querySelector('.setup-primary').click();
	assert.equal(created, 1, 'the project folder dialog opens');
	const handoff = posts.pop();
	assert.equal(handoff.type, 'setupDone');
	assert.match(handoff.firstTask, /README\.md/, 'the first task survives the window change');
	assert.ok(!d.querySelector('.setup-overlay'), 'the overlay closes for the folder dialog');

	// Key path: the key is checked before anything is saved; an error stays on the form.
	state.hasWorkspace = true;
	setup.open('key');
	assert.match(d.querySelector('.setup-title').textContent, /Connect with a key/);
	d.querySelectorAll('.setup-provider')[1].click();
	const input = d.querySelector('.setup-input');
	input.value = 'sk-test';
	d.querySelector('.setup-primary').click();
	assert.deepEqual(posts.pop(), { type: 'setupKey', presetId: 'anthropic', apiKey: 'sk-test' });
	send({ type: 'setupKeyResult', ok: false, error: 'Invalid API key' });
	assert.match(d.querySelector('.setup-error').textContent, /Invalid API key/);
	assert.ok(d.querySelector('.setup-input'), 'a rejected key keeps the form open');
	send({ type: 'setupKeyResult', ok: true });
	assert.match(d.querySelector('.setup-title').textContent, /Provider connected/, 'a checked key reaches the first task');
	d.querySelector('.setup-primary').click();
	assert.deepEqual(tasks.pop(), ['send', 'Read README.md. If it does not exist, create it. Add one short sentence describing what this project does, and change nothing else.']);
	assert.ok(!d.querySelector('.setup-overlay'), 'running the first task closes setup');

	// A stored first task prefills the composer in the next window and is consumed.
	send({ type: 'setupStatus', done: true, firstTask: 'stored task' });
	assert.deepEqual(tasks.pop(), ['start', 'stored task']);
	assert.deepEqual(posts.pop(), { type: 'setupConsumed' });

	// Guards: a configured model or an open folder still asks for a stored task,
	// but never opens setup by itself; Remote does not ask at all.
	const quiet = [];
	const quietCreate = (extra) => w.ChatSetup.create({ post: (msg) => quiet.push(msg), t, state: () => state, startTask: () => {}, sendTask: () => {}, openSettings: () => {}, ...extra });
	state.providers = [{ id: 'p', enabled: true, models: [{ id: 'm', enabled: true }] }];
	quietCreate({ remote: false }).maybeOpen();
	state.providers = [];
	quietCreate({ remote: false }).maybeOpen(); // hasWorkspace is true
	quietCreate({ remote: true }).maybeOpen();
	assert.deepEqual(quiet.map((m) => m.type), ['setupStatus', 'setupStatus'], 'configured and workspace only read the stored task; Remote never asks');
	assert.ok(!d.querySelector('.setup-overlay'), 'reading the stored task does not open setup');

	// Skip is remembered and closes without a first task.
	state.hasWorkspace = false;
	setup.open('start');
	d.querySelector('.setup-link').click();
	assert.deepEqual(posts.pop(), { type: 'setupDone' });
	assert.ok(!d.querySelector('.setup-overlay'));

	console.log('PASS setup picks, download progress, key validation, folder handoff, first task and open guards');
} finally {
	dom.window.close();
}
