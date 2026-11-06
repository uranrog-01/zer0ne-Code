// Inert child process + fixture bytes: these offline tests never access the desktop.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const vm = require('vm');
const resolve = Module._resolveFilename;
const vscode = { env: {}, workspace: { workspaceFolders: undefined } };
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : resolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscode };
const { SkillRecorderHost } = require('../out/host/skillRecorderHost');
const { SkillStore, parseSkill } = require('../out/tools/skills');
const { PluginHost } = require('../out/tools/plugins');
const { reviewFrames, workflowEvidence, parseWorkflowDraft } = require('../out/core/recordedWorkflow');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zrec-test-'));
const tests = [], hosts = [];
const test = (name, fn) => tests.push([name, fn]);
const tick = () => new Promise((r) => setImmediate(r));
function fixture(options = {}) {
	const storage = fs.mkdtempSync(path.join(tmp, 'host-'));
	const posted = [], calls = [];
	let proc, dir, changes = 0;
	const provider = { id: 'vision', enabled: true, apiFormat: 'openai', models: [{ id: 'model', enabled: true, vision: true, maxOutput: 4000 }, { id: 'text', enabled: true }] };
	const skills = new SkillStore(path.join(storage, 'skills'), () => undefined, () => []);
	const plugins = new PluginHost(path.join(storage, 'plugins'), () => undefined, () => []);
	const ctx = { store: { get: async (id) => id === provider.id ? provider : undefined, getApiKey: async () => 'test-key' }, sendState: async () => { changes++; }, status() {} };
	const host = new SkillRecorderHost(ctx, {
		storageDir: storage, sourceFile: 'never-read-in-tests', skills, plugins,
		launch: (folder) => {
			dir = folder; proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stdin = new PassThrough();
			proc.kill = () => { proc.emit('close', 0); return true; }; return proc;
		},
		callModel: async (...args) => { calls.push(args); return options.model ? options.model(...args) : { text: JSON.stringify({ name: 'ai-workflow', description: 'Use for fixture reports.', body: '# Report\n1. Export.\n2. Verify totals.' }) }; }
	});
	hosts.push(host);
	const surface = { kind: 'settings', post: (m) => posted.push(m) };
	const last = (type) => [...posted].reverse().find((m) => m.type === type);
	const message = (type, rest = {}) => host.handle(surface, { type, id: last('skillRecording')?.recording?.id, ...rest });
	const native = (msg) => proc.stdout.write(JSON.stringify(msg) + '\n');
	return { host, skills, plugins, ctx, surface, posted, calls, last, message, native, storage,
		get dir() { return dir; }, get proc() { return proc; }, get changes() { return changes; },
		async start(target = 'skill') { await message('skillRecordStart', { target, name: 'weekly-report', goal: 'Export the weekly report' }); native({ type: 'state', state: 'recording' }); },
		frame(index) { fs.writeFileSync(path.join(dir, String(index).padStart(6, '0') + '.jpg'), Buffer.from('fixture-frame-' + index)); native({ type: 'frame', index, at: index * 1000, width: 1280, height: 720 }); },
		async finish() { proc.emit('close', 0); await tick(); }
	};
}
test('review sampling is bounded and includes endpoints', () => {
	const frames = Array.from({ length: 300 }, (_, i) => ({ index: i + 1 }));
	const sample = reviewFrames(frames);
	assert.equal(sample.length, 18); assert.equal(new Set(sample.map((f) => f.index)).size, 18);
	assert.equal(sample[0].index, 1); assert.equal(sample.at(-1).index, 300);
	assert.deepEqual(reviewFrames(frames, 1), [frames[0]]); assert.deepEqual(reviewFrames(frames, 0), []);
});
test('evidence redacts secrets, omits coordinates, rejects malformed drafts', () => {
	const key = 'sk-' + 'x'.repeat(30);
	const text = workflowEvidence('Export', key, [{ at: 1000, action: 'click', x: 183, y: 245, app: 'Excel' }]);
	assert(!text.includes(key)); assert(!text.includes('183')); assert(text.includes('Excel'));
	assert.throws(() => parseWorkflowDraft('not JSON'), /valid skill draft/);
	assert.throws(() => parseWorkflowDraft('{"name":"../","description":"x","body":"y"}'), /name/);
	const draft = parseWorkflowDraft('```json\n' + JSON.stringify({ name: '../Weekly Report', description: key, body: 'Verify ' + key }) + '\n```');
	assert.equal(draft.name, 'weekly-report'); assert(!draft.body.includes(key));
});
test('remote clients cannot record or read local captures', async () => {
	const f = fixture(); await f.start(); f.frame(1);
	await f.host.handle({ kind: 'remote', post: (m) => f.posted.push(m) }, { type: 'skillRecorderInfo' });
	assert.match(f.last('skillRecordingNotice').text, /only in local/); assert.equal(f.calls.length, 0);
	await f.message('skillRecordDiscard'); assert(!fs.existsSync(f.dir));
});
test('notes drafting never uploads frames; saving uses edited content and deletes captures', async () => {
	const f = fixture(); await f.message('skillRecorderInfo'); assert.equal(f.last('skillRecording').recording, null);
	await f.start(); f.frame(1); f.frame(2);
	f.native({ type: 'event', action: 'typing', at: 4000, text: 'password should be ignored' });
	f.native({ type: 'event', action: 'shortcut', at: 5000, shortcut: 'Ctrl+S', app: 'Excel' }); await f.finish();
	assert.equal(f.last('skillRecordingReview').frames.length, 2);
	assert(!JSON.stringify(f.last('skillRecordingReview').events).includes('password'));
	await f.message('skillRecordGenerate', { notes: '1. Export.\n2. Check totals.' });
	assert.equal(f.calls.length, 0); assert.match(f.last('skillRecordingDraft').draft.body, /Ctrl\+S/);
	await f.message('skillRecordSave', { name: 'reviewed-report', description: 'Use for weekly reports.', body: '# Reviewed\n1. Check inputs.\n2. Export.' });
	assert.match(f.skills.read('reviewed-report').body, /# Reviewed/);
	assert(!fs.existsSync(f.dir)); assert.equal(f.changes, 1); assert.equal(f.last('skillRecordingSaved').target, 'skill');
});
test('AI requires reviewed frames and vision; sends exactly the selected images', async () => {
	const f = fixture(); await f.start(); for (let i = 1; i <= 30; i++) f.frame(i); await f.finish();
	await f.message('skillRecordGenerate', { modelKey: 'vision::text', frames: [1] });
	assert.match(f.last('skillRecordingNotice').text, /vision/); assert.equal(f.calls.length, 0);
	await f.message('skillRecordGenerate', { modelKey: 'vision::model', frames: [2] });
	assert.match(f.last('skillRecordingNotice').text, /reviewed frames/); assert.equal(f.calls.length, 0);
	const indices = f.last('skillRecordingReview').frames.map((x) => x.index);
	await f.message('skillRecordGenerate', { modelKey: 'vision::model', frames: indices.slice(0, 13) }); assert.equal(f.calls.length, 0);
	await f.message('skillRecordGenerate', { modelKey: 'vision::model', frames: [indices[0], indices[5]], notes: 'Verify totals.' });
	assert.equal(f.calls.length, 1); const request = f.calls[0][2]; assert.equal(request.maxTokens, 4000);
	assert.deepEqual(request.messages[0].images.map((i) => Buffer.from(i.base64, 'base64').toString()), ['fixture-frame-' + indices[0], 'fixture-frame-' + indices[5]]);
	assert.match(request.system, /untrusted evidence/);
	assert.equal(f.skills.list().filter((s) => s.name === 'ai-workflow').length, 0, 'draft is never installed automatically');
	await f.message('skillRecordDiscard');
});
test('plugin save creates a compatible skill-only package; existing names cannot be overwritten', async () => {
	const f = fixture(); await f.start('plugin'); await f.finish();
	await f.message('skillRecordSave', { name: 'recorded-plugin-test', description: 'Reuse report steps.', body: '# Steps\n1. Export.\n2. Verify.' });
	const plugin = f.plugins.plugins().find((p) => p.name === 'recorded-plugin-test');
	assert(plugin); assert.equal(plugin.counts.skills, 1); assert.equal(plugin.counts.hooks, 0); assert.equal(plugin.counts.mcp, 0);
	const skillPath = path.join(plugin.dir, 'skills', 'recorded-plugin-test', 'SKILL.md');
	assert.equal(parseSkill(fs.readFileSync(skillPath, 'utf8')).name, 'recorded-plugin-test');
	await f.start('plugin'); await f.finish();
	await f.message('skillRecordSave', { name: 'recorded-plugin-test', description: 'Overwrite', body: 'Bad' });
	assert.match(f.last('skillRecordingNotice').text, /already exists/); assert(!fs.readFileSync(skillPath, 'utf8').includes('Bad'));
	await f.message('skillRecordDiscard');
});
test('pause stops voice and resume restarts; invalid IDs cannot discard a recording', async () => {
	const f = fixture(); let starts = 0, stops = 0;
	f.host.voice = { start() { starts++; }, stop() { stops++; } };
	await f.message('skillRecordStart', { goal: 'Narrated workflow', voice: true });
	f.native({ type: 'state', state: 'recording' }); assert.equal(starts, 1);
	f.native({ type: 'state', state: 'paused' }); assert.equal(stops, 1);
	f.native({ type: 'state', state: 'recording' }); assert.equal(starts, 2);
	await f.message('skillRecordDiscard', { id: 'wrong-id' }); assert.match(f.last('skillRecordingNotice').text, /has ended/);
	assert(fs.existsSync(f.dir)); await f.message('skillRecordDiscard'); assert(!fs.existsSync(f.dir));
});
test('discard aborts a draft; concurrent requests and late results are suppressed', async () => {
	let complete, signal;
	const f = fixture({ model: (_p, _k, opts) => { signal = opts.signal; return new Promise((r) => { complete = r; }); } });
	await f.start(); f.frame(1); await f.finish();
	const generation = f.message('skillRecordGenerate', { modelKey: 'vision::model', frames: [1] }); await tick(); assert(signal);
	await f.message('skillRecordGenerate', { modelKey: 'vision::model', frames: [1] }); assert.equal(f.calls.length, 1);
	await f.message('skillRecordDiscard'); assert(signal.aborted); assert(!fs.existsSync(f.dir));
	complete({ text: JSON.stringify({ name: 'late', description: 'x', body: 'y' }) }); await generation;
	assert(!f.last('skillRecordingDraft'));
});
test('another window preserves live sessions; dead sessions are cleaned', async () => {
	const f = fixture(); await f.start(); f.frame(1);
	const dead = path.join(f.storage, 'skill-recordings', 'd'.repeat(24)); fs.mkdirSync(dead);
	fs.writeFileSync(path.join(dead, 'owner.json'), JSON.stringify({ pid: 2147483647 }));
	const unrelated = path.join(f.storage, 'skill-recordings', 'user-folder'); fs.mkdirSync(unrelated);
	const second = new SkillRecorderHost(f.ctx, { storageDir: f.storage }); hosts.push(second);
	assert(fs.existsSync(f.dir)); assert(!fs.existsSync(dead)); assert(fs.existsSync(unrelated));
	await f.message('skillRecordDiscard');
});
test('UI stays open after an empty initial status and escapes provider labels', () => {
	const listeners = {};
	const element = () => ({ innerHTML: '', value: '', classList: { add() {}, toggle() {} }, addEventListener() {}, querySelector() { return element(); }, querySelectorAll() { return []; } });
	let closed = 0, dialog;
	const context = { window: { Bridge: { post() {} }, Icons: { svg: () => '' }, addEventListener: (type, fn) => { listeners[type] = fn; } } };
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../media/skill-recorder.js'), 'utf8'), context);
	context.window.SkillRecorder.open('skill', { providers: [{ id: 'p', name: '<img src=x>', enabled: true, models: [{ id: 'v', enabled: true, vision: true }] }], toast() {}, onState() {}, onSaved() {}, openDialog() { dialog = { dlg: element(), body: element(), foot: element(), close() { closed++; } }; return dialog; } });
	listeners.message({ data: { type: 'skillRecorderInfo', supported: true, displays: [] } });
	listeners.message({ data: { type: 'skillRecording', recording: null } }); assert.equal(closed, 0); assert(dialog.body.innerHTML.includes('Demonstrate a workflow'));
	listeners.message({ data: { type: 'skillRecording', recording: { id: 'test', state: 'review', target: 'skill', frames: 0, events: 0, elapsedMs: 0 } } });
	listeners.message({ data: { type: 'skillRecordingReview', id: 'test', frames: [], events: [] } });
	assert(dialog.body.innerHTML.includes('&lt;img src=x&gt;')); assert(!dialog.body.innerHTML.includes('<img src=x>'));
});
(async () => {
	let failed = 0;
	try { for (const [name, fn] of tests) { try { await fn(); console.log('ok ' + name); } catch (e) { failed++; console.error('FAIL ' + name, e); } } }
	finally { hosts.forEach((h) => h.dispose()); await tick(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
	console.log(`${tests.length - failed}/${tests.length} recorder tests passed.`); process.exitCode = failed ? 1 : 0;
})();
