'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createDesktopShim } = require('../../host/desktop-shim');
const engineDir = path.resolve(__dirname, '..');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-command-safety-')));
const workspace = path.join(base, 'project');
const other = path.join(base, 'other');
fs.mkdirSync(workspace); fs.mkdirSync(other);
const outside = path.join(other, 'marker.txt');

async function main() {
	const { shim, install } = createDesktopShim({ engineDir, workspace, dataDir: path.join(base, 'data'), rpc: async () => null });
	install(shim.vscode);
	const { DEFAULT_SETTINGS } = require('../out/providerStore');
	const { Verifier } = require('../out/host/verify');
	const { approveCommand, executeCommand } = require('../out/tools/command');
	const { autoRule } = require('../out/host/turnRunner');
	const sb = require('../out/tools/sandbox');
	const settings = { ...DEFAULT_SETTINGS, verifyDiagnostics: false, verifyAutoDetect: true, sandbox: 'off', autoApproveCommands: false };
	const sourceFile = path.join(engineDir, 'media', 'sandbox', 'lowil.cs');
	fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
	fs.writeFileSync(path.join(workspace, 'check.cjs'), `require('fs').writeFileSync(${JSON.stringify(outside)},'marker');`);
	let approvalRequests = [];
	const context = (patch = {}) => ({ settings, signal: new AbortController().signal, sandbox: { mode: 'off', network: true, storageDir: path.join(base, 'launcher'), sourceFile }, requestApproval: async request => { approvalRequests.push(request); return { approved: false, finish() {} }; }, ...patch });
	const verify = async (s = settings, ctx = context(), signal = ctx?.signal || new AbortController().signal) => {
		const messages = [];
		const feedback = await new Verifier({ scheduleState() {} }).verifyTurn(messages, ['changed.js'], s, { edits: 1, checked: 0, rounds: 0 }, signal, ctx);
		return { messages, feedback };
	};
	let result = await verify({ ...settings, commandTool: false });
	assert(!fs.existsSync(outside)); assert.equal(approvalRequests.length, 0);
	assert.match(result.messages[0].tool.summary, /disabled/); assert.equal(result.messages[0].tool.status, 'error');
	result = await verify(settings, null);
	assert(!fs.existsSync(outside)); assert.match(result.messages[0].tool.summary, /permissions are unavailable/);
	result = await verify();
	assert(!fs.existsSync(outside)); assert.equal(approvalRequests.at(-1).kind, 'command'); assert.equal(approvalRequests.at(-1).command, 'npm test');
	assert.match(result.messages[0].tool.summary, /declined/); assert.equal(result.messages[0].tool.status, 'error');
	console.log('ok verification cannot bypass disabled, missing or declined command permissions');

	let release;
	const pending = new Promise(resolve => { release = resolve; });
	let asked;
	const requesting = new Promise(resolve => { asked = resolve; });
	const waiting = verify(settings, context({ requestApproval: async request => { asked(request); return pending; } }));
	assert.equal((await requesting).sandboxed, undefined); assert(!fs.existsSync(outside));
	release({ approved: true, auto: false, finish() {} });
	result = await waiting;
	assert(fs.existsSync(outside)); assert.equal(result.messages[0].tool.status, 'done'); fs.unlinkSync(outside);
	console.log('ok verification waits for approval before executing a detected project script');

	const abort = new AbortController();
	const canceledMessages = [];
	await assert.rejects(new Verifier({ scheduleState() {} }).verifyTurn(canceledMessages, ['changed.js'], settings, { edits: 1, checked: 0, rounds: 0 }, abort.signal, context({ signal: abort.signal, requestApproval: async () => { abort.abort(); return { approved: true, finish() {} }; } })), { name: 'AbortError' });
	assert(!fs.existsSync(outside)); assert.equal(canceledMessages[0].tool.status, 'error'); assert.match(canceledMessages[0].tool.summary, /stopped/);
	await assert.rejects(approveCommand('echo test', workspace, other, context()), /inside the workspace/);
	await assert.rejects(approveCommand('echo test', workspace, workspace, context({ readOnly: true })), /read-only/);
	console.log('ok cancellation after approval and read-only/outside cwd requests never start commands');

	fs.writeFileSync(path.join(workspace, 'check.cjs'), `const fs=require('fs'); fs.writeFileSync('started.txt','started'); setTimeout(()=>fs.writeFileSync(${JSON.stringify(outside)},'too late'),10000);`);
	const runningAbort = new AbortController();
	const runningMessages = [];
	const stoppedRun = new Verifier({ scheduleState() {} }).verifyTurn(runningMessages, ['changed.js'], { ...settings, verifyCommand: 'node check.cjs' }, { edits: 1, checked: 0, rounds: 0 }, runningAbort.signal, context({ signal: runningAbort.signal, requestApproval: async () => ({ approved: true, auto: false, finish() {} }) }));
	const stoppedResult = assert.rejects(stoppedRun, { name: 'AbortError' });
	try {
		const until = Date.now() + 8000;
		while (!fs.existsSync(path.join(workspace, 'started.txt')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
		assert(fs.existsSync(path.join(workspace, 'started.txt')), 'the checker must actually start before testing Stop');
	} finally { runningAbort.abort(); await stoppedResult; }
	assert(!fs.existsSync(outside)); assert.equal(runningMessages[0].tool.status, 'error'); assert.match(runningMessages[0].tool.summary, /stopped/);
	fs.writeFileSync(path.join(workspace, 'check.cjs'), `require('fs').writeFileSync(${JSON.stringify(outside)},'marker');`);
	console.log('ok stopping running verification terminates its command and records an interrupted check');

	if (process.platform === 'win32') {
		// Reproduce the old cross-project setup without touching any real project.
		for (const folder of [workspace, other]) assert.equal(spawnSync('icacls', [folder, '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true }).status, 0);
		const status = sb.sandboxStatus(workspace, path.join(base, 'launcher'), sourceFile);
		assert(!status.available, 'an old Low-integrity label is not a prepared project'); assert(status.needsPrepare);
		assert.equal(sb.sandboxSpawn('echo test', { root: workspace, storageDir: path.join(base, 'launcher'), sourceFile, network: false, env: process.env }), undefined);
		for (const mode of ['auto', 'always']) {
			const boxedSettings = { ...settings, sandbox: mode, autoApproveCommands: true, commandAllowlist: 'npm test' };
			const restricted = context({ settings: boxedSettings, sandbox: { mode, network: false, storageDir: path.join(base, 'launcher'), sourceFile }, requestApproval: async request => {
				approvalRequests.push(request); assert(request.escalate); assert(!request.sandboxed); assert.equal(autoRule(request, boxedSettings), undefined);
				return { approved: false, finish() {} };
			} });
			result = await verify(boxedSettings, restricted);
			assert(!fs.existsSync(outside), 'a prepared folder must not let verification auto-run outside the workspace');
			assert.match(result.messages[0].tool.summary, /declined/);
			const background = await approveCommand('node check.cjs', workspace, workspace, restricted, true);
			assert(!background.handle.approved); assert(!background.spec);
			await assert.rejects(async () => executeCommand('node check.cjs', background, 10000, restricted.signal), /not approved/);
		}
		const approvedSettings = { ...settings, sandbox: 'always' };
		const approved = context({ settings: approvedSettings, sandbox: { mode: 'always', network: false, storageDir: path.join(base, 'launcher'), sourceFile }, requestApproval: async request => {
			assert(request.escalate); assert(!request.sandboxed); return { approved: true, auto: false, finish() {} };
		} });
		result = await verify(approvedSettings, approved);
		assert(fs.existsSync(outside)); assert.equal(result.messages[0].tool.status, 'done'); fs.unlinkSync(outside);
		console.log('ok Windows fails closed for unprepared and legacy folders, auto-approval, allowlists, background commands and verification; explicitly approved npm tests work');

		// A prepared project: commands run with the write-restricted token.
		const storage = path.join(base, 'launcher');
		const project = await sb.prepareWorkspace(workspace, storage, sourceFile);
		assert.match(project.sid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
		const ready = sb.sandboxStatus(workspace, storage, sourceFile);
		assert(ready.available && ready.kind === 'restricted' && !ready.network, JSON.stringify(ready));
		assert(!sb.sandboxStatus(other, storage, sourceFile).available, 'preparing one project prepares no other');
		const boxed = context({ settings: { ...settings, sandbox: 'always' }, sandbox: { mode: 'always', network: true, storageDir: storage, sourceFile }, requestApproval: async request => {
			assert(request.sandboxed); assert(!request.escalate); return { approved: true, auto: false, finish() {} };
		} });
		const runBoxed = async (command) => executeCommand(command, await approveCommand(command, workspace, workspace, boxed), 60000, boxed.signal);
		const inside = await runBoxed(`node -e "require('fs').writeFileSync('inside.txt', process.env.ZER0NE_SANDBOX)"`);
		assert.equal(inside.code, 0, inside.out); assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'windows');
		const breakout = await runBoxed('node check.cjs');
		assert.notEqual(breakout.code, 0); assert.match(breakout.out, /EPERM|denied/i); assert(!fs.existsSync(outside), 'another folder stays out of reach');
		const temp = await runBoxed(`node -e "const p=require('path').join(require('os').tmpdir(),'t.txt');require('fs').writeFileSync(p,'1');console.log(p)"`);
		assert.equal(temp.code, 0, temp.out); assert(temp.out.trim().startsWith(project.tmp), 'temp is the project\'s own sandbox temp');
		const home = await runBoxed(`node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(),'zer0ne-sandbox-probe.txt'),'x')"`);
		assert.notEqual(home.code, 0); assert(!fs.existsSync(path.join(os.homedir(), 'zer0ne-sandbox-probe.txt')), 'the user folder is not writable');
		await sb.unprepareWorkspace(workspace, storage, sourceFile);
		assert(sb.sandboxStatus(workspace, storage, sourceFile).needsPrepare, 'removing access unprepares the project');
		console.log('ok a prepared Windows project writes only inside itself and its sandbox temp, never another folder or the user profile');
	}
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
	assert(base.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) && path.basename(base).startsWith('zer0ne-command-safety-'));
	fs.rmSync(base, { recursive: true, force: true });
});
