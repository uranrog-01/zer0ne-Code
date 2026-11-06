'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { worker, until } = require('./host-fixture');

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-recovery-'));
	const project = path.join(tmp, 'project'), data = path.join(tmp, 'data'); fs.mkdirSync(project);
	const hosts = [], responses = [];
	let response, mode = 'hold', requests = 0, lastRequest;
	const model = http.createServer((req, res) => {
		let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
			if (!req.url.endsWith('/chat/completions')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fixture' }] })); return; }
			lastRequest = JSON.parse(body);
			requests++; response = res; responses.push(res);
			res.writeHead(200, { 'Content-Type': 'text/event-stream' });
			res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: mode === 'complete' ? 'Recovered successfully.' : 'Partial work retained.' } }] }) + '\n\n');
			if (mode === 'complete') res.end('data: [DONE]\n\n');
		});
	});
	model.keepAliveTimeout = 0;
	await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
	const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'global-state.json'), 'utf8'))['aiChat.sessions'];
	const latest = () => saved().flatMap(s => s.messages).filter(m => m.role === 'user').at(-1);
	try {
		let host = await worker(project, data); hosts.push(host);
		await host.post({ type: 'updateSettings', patch: { localTuned: false, cacheWarm: false, remoteEnabled: false, sandbox: 'off' } });
		await host.post({ type: 'setMode', mode: 'chat' });
		await host.post({ type: 'addCustom', name: 'Recovery fixture', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiFormat: 'openai', models: [{ id: 'fixture', tools: false }], smart: false });
		const provider = (await host.next(m => m.type === 'state' && m.providers?.some(p => p.name === 'Recovery fixture'))).providers.find(p => p.name === 'Recovery fixture');
		await host.post({ type: 'setApiKey', id: provider.id, apiKey: 'local-fixture-key' });
		await host.post({ type: 'selectModel', providerId: provider.id, model: 'fixture' });
		mode = 'complete'; await host.post({ type: 'send', text: 'Completed history fixture' });
		await host.next(m => m.type === 'state' && !m.isStreaming && m.messages.some(x => x.content === 'Completed history fixture' && x.turn?.outcome === 'completed'));
		mode = 'hold';
		await host.post({ type: 'send', text: 'Crash recovery fixture' });
		await host.next(m => m.type === 'delta' && m.text === 'Partial work retained.');
		await until(() => saved().some(s => s.messages.some(m => m.content === 'Partial work retained.')), 'partial reply checkpoint');
		assert.equal(latest().content, 'Crash recovery fixture'); assert.equal(latest().turn.endedAt, undefined);
		host.child.kill(); await until(() => host.child.exitCode !== null || host.child.signalCode !== null, 'interrupted host exit');
		host = await worker(project, data); hosts.push(host);
		await host.post({ type: 'ready' });
		const reopened = await host.next(m => m.type === 'state' && m.messages.some(x => x.content === 'Crash recovery fixture'));
		assert.equal(reopened.isStreaming, false); assert.equal(latest().turn.outcome, 'stopped'); assert(latest().turn.endedAt);
		assert(reopened.messages.some(m => m.content === 'Partial work retained.'));
		assert.equal(requests, 2, 'reopening never silently resends the interrupted request');
		console.log('ok  killing and reopening the real host preserves the prompt and partial reply, persists stopped state and makes no repeat request');
		await host.post({ type: 'send', text: 'Stop recovery fixture' });
		await host.next(m => m.type === 'delta' && m.text === 'Partial work retained.');
		assert(lastRequest.messages.some(m => m.content?.includes('Crash recovery fixture')), 'the resumed model sees the interrupted prompt');
		assert(lastRequest.messages.some(m => m.content?.includes('Partial work retained.')), 'the resumed model sees the saved partial answer');
		assert(lastRequest.messages.some(m => m.content?.includes('Completed history fixture')), 'earlier exact history stays available');
		await host.post({ type: 'stop' });
		await host.next(m => m.type === 'state' && !m.isStreaming && m.messages.some(x => x.content === 'Stop recovery fixture' && x.turn?.outcome === 'stopped'));
		assert.equal(latest().turn.outcome, 'stopped');
		await host.post({ type: 'send', text: 'Network recovery fixture' });
		await host.next(m => m.type === 'delta' && m.text === 'Partial work retained.');
		response.destroy();
		await host.next(m => m.type === 'state' && !m.isStreaming && m.messages.some(x => x.content === 'Network recovery fixture' && x.turn?.outcome === 'failed'));
		assert.equal(latest().turn.outcome, 'failed');
		mode = 'complete'; await host.post({ type: 'send', text: 'Continue after failures' });
		await host.next(m => m.type === 'state' && !m.isStreaming && m.messages.some(x => x.content === 'Continue after failures' && x.turn?.outcome === 'completed'));
		assert.equal(latest().turn.outcome, 'completed');
		assert.equal(requests, 5, 'Stop and partial network failure do not duplicate requests');
		console.log('ok  Stop and disconnected streams retain partial work; a subsequent request completes');
		// Seed a different chat to prove recovery also runs when selecting it after startup.
		await host.stop();
		const file = path.join(data, 'global-state.json'), disk = JSON.parse(fs.readFileSync(file, 'utf8'));
		const session = { id: 'orphan-fixture', projectPath: project, title: 'Interrupted decisions', updatedAt: Date.now(), messages: [{ id: 'orphan-tool', role: 'assistant', content: '', kind: 'tool', tool: { name: 'write_file', status: 'running', summary: '' }, approval: { id: 'orphan-approval', kind: 'write', status: 'pending' }, question: { id: 'orphan-question', text: 'Proceed?', options: [], status: 'pending' } }] };
		disk['aiChat.sessions'].push(session); fs.writeFileSync(file, JSON.stringify(disk));
		host = await worker(project, data); hosts.push(host);
		await host.post({ type: 'switchSession', id: session.id });
		await host.next(m => m.type === 'state' && m.currentSessionId === session.id);
		const card = saved().find(s => s.id === session.id).messages[0];
		assert.equal(card.tool.status, 'error'); assert.equal(card.approval.status, 'rejected'); assert.equal(card.question.status, 'skipped');
		console.log('ok  selecting another interrupted chat repairs and saves its orphaned decisions');
		await interruptedSave(tmp);
	} catch (error) { console.error(hosts.at(-1)?.diagnostics().slice(-5000)); throw error; } finally {
		for (const res of responses) res.destroy();
		for (const host of hosts.reverse()) await host.stop();
		model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

async function interruptedSave(tmp) {
	const file = path.join(tmp, 'atomic.json'), marker = path.join(tmp, 'save-marker');
	fs.writeFileSync(file, '{"value":"previous"}');
	const fixture = path.join(tmp, 'interrupted-writer.js');
	fs.writeFileSync(fixture, `const fs=require('fs'); const rename=fs.renameSync; fs.renameSync=(from,to)=>{fs.writeFileSync(process.argv[3],'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000); return rename(from,to);}; require(process.argv[4]).transaction(process.argv[2],data=>{data.value='unfinished';});`);
	const child = spawn(process.execPath, [fixture, file, marker, path.resolve(__dirname, '../host/storage.js')], { windowsHide: true, stdio: 'ignore' });
	try { await until(() => fs.existsSync(marker), 'writer reached atomic rename'); child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 'writer exit'); }
	finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
	const { readJson, transaction } = require('../host/storage');
	assert.equal(readJson(file).value, 'previous');
	transaction(file, data => { data.value = 'recovered'; });
	assert.equal(readJson(file).value, 'recovered'); assert.equal(fs.existsSync(file + '.lock'), false);
	console.log('ok  killing a writer before atomic replacement preserves valid data; the next writer recovers its abandoned lock');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
