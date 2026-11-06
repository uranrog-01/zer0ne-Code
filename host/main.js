#!/usr/bin/env node
/*
 * The engine host of zer0ne Code. The app (app/engines.js) starts it on Electron's
 * own Node (ELECTRON_RUN_AS_NODE) and talks to it over stdio, one JSON object per line:
 *
 *   shell → host  {"t":"init", engineDir, dataDir, workspace?, key?}   start the engine
 *                 {"t":"activate", handoff: object | null, activationId?: string} select chat and refresh UI
 *                 {"t":"res", id, value?, error?}                        answer to a request
 *                 {"t":"shutdown"}                                       stop and exit
 *   host → shell  {"t":"ready", url, workspace?, engine, protocol}       the UI is up (protocol: host/protocol.js)
 *                 {"t":"req", id, op, ...args}                           a dialog, clipboard, link, folder…
 *                 {"t":"fatal", message}                                 the engine could not start
 *
 * stdout carries only this protocol; everything the engine logs goes to stderr.
 * When stdin closes (the shell is gone) the host exits, so it never lingers.
 *
 * `node host/main.js --standalone [folder]` runs without the shell and prints a
 * URL to open in any browser (development, WSL, servers).
 */
'use strict';
// Electron runs this file as plain Node. Nothing the engine starts (terminal commands, editors,
// the user's own Electron apps) may inherit that mode.
delete process.env.ELECTRON_RUN_AS_NODE;
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const readline = require('readline');

// The packaged app ignores NODE_OPTIONS and NODE_EXTRA_CA_CERTS (Electron fuses), so the engine
// trusts the operating system's certificates itself — where company proxies install theirs —
// plus an extra bundle still named by NODE_EXTRA_CA_CERTS.
function trustSystemCertificates() {
	const tls = require('tls');
	if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
	try {
		const certs = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
		const extra = process.env.NODE_EXTRA_CA_CERTS;
		if (extra && fs.existsSync(extra)) for (const pem of fs.readFileSync(extra, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || []) certs.add(pem);
		tls.setDefaultCACertificates([...certs]);
	} catch (e) {
		process.stderr.write(`[warn] System certificates unavailable: ${e && e.message ? e.message : e}\n`);
	}
}
trustSystemCertificates();

const protocolOut = process.stdout.write.bind(process.stdout);
const send = (obj) => protocolOut(JSON.stringify(obj) + '\n');
// The engine logs freely; keep stdout clean for the protocol.
for (const level of ['log', 'info', 'debug', 'warn', 'error']) {
	console[level] = (...args) => process.stderr.write(`[${level}] ${util.format(...args)}\n`);
}
process.stdout.write = (chunk, ...rest) => process.stderr.write(chunk, ...rest);
process.on('uncaughtException', (e) => process.stderr.write(`[uncaught] ${e && e.stack ? e.stack : e}\n`));
process.on('unhandledRejection', (e) => process.stderr.write(`[unhandled] ${e && e.stack ? e.stack : e}\n`));

const { PROTOCOL, RPC_TIMEOUT_MS, RPC_INTERACTIVE_TIMEOUT_MS, INTERACTIVE_OPS } = require('./protocol');

const standalone = process.argv.includes('--standalone') || process.argv.includes('--headless');
// Tests only: a short request timeout, so a test can watch one expire.
const rpcTimeoutOverride = /^\d{2,6}$/.test(process.env.ZER0NE_RPC_TIMEOUT_MS || '') ? Number(process.env.ZER0NE_RPC_TIMEOUT_MS) : 0;
let nextId = 1;
const pending = new Map();
let host;
let startup;
let activations = Promise.resolve();

/** Ask the shell for something only it can do (native dialogs, clipboard, links, folders). */
function rpc(op, args = {}) {
	if (standalone) return standaloneRpc(op, args);
	const id = nextId++;
	const limit = rpcTimeoutOverride || (INTERACTIVE_OPS.has(op) ? RPC_INTERACTIVE_TIMEOUT_MS : RPC_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			process.stderr.write(`[rpc] ${op}: no answer from the app after ${Math.round(limit / 1000)} s\n`);
			reject(new Error(`The app did not answer "${op}" in time.`));
		}, limit);
		timer.unref?.();
		pending.set(id, {
			resolve: (v) => { clearTimeout(timer); resolve(v); },
			reject: (e) => { clearTimeout(timer); reject(e); }
		});
		send({ t: 'req', id, op, ...args });
	});
}

/** Without the shell: links open with the OS, dialogs answer "no", the clipboard is in memory. */
let memoryClipboard = '';
async function standaloneRpc(op, args) {
	const { spawn } = require('child_process');
	const open = (target) => {
		const [cmd, argv] = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
		spawn(cmd, argv, { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
		return true;
	};
	switch (op) {
		case 'message':
			process.stderr.write(`[${args.level}] ${args.message}\n`);
			return null;
		case 'openExternal':
			return /^(https?|mailto):/i.test(args.url) ? open(args.url) : false;
		case 'openPath':
		case 'openTextDocument':
		case 'reveal':
			return open(args.path);
		case 'clipboardRead':
			return memoryClipboard;
		case 'clipboardWrite':
			memoryClipboard = args.text;
			return null;
		case 'openFolder':
			process.stderr.write(`[info] open folder requested: ${args.path || '(pick)'} — restart with that folder in standalone mode\n`);
			return null;
		case 'notify':
			process.stderr.write(`[notify] (${args.kind || 'done'}) ${args.title || 'zer0ne Code'}: ${args.body || ''}\n`);
			return true;
		case 'busy':
			process.stderr.write(`[busy] ${args.on ? 'working' : 'idle'}${args.sessionId ? ' (' + args.sessionId + ')' : ''}\n`);
			return null;
		case 'setNotify':
		case 'setNotch':
		case 'notchPreview':
		case 'notchMic':
		case 'notchCloud':
		case 'retainRemote':
		case 'retainTerminal':
		case 'retainRouter':
			return null;
		default:
			return null;
	}
}

async function start(init) {
	const engineDir = path.resolve(init.engineDir);
	if (!fs.existsSync(path.join(engineDir, 'out', 'chatController.js'))) {
		throw new Error(`The engine is missing at ${engineDir} — run "npm run engine".`);
	}
	const { startHost } = require('./host');
	const workspace = init.workspace && fs.existsSync(init.workspace) ? path.resolve(init.workspace) : undefined;
	host = await startHost({
		engineDir,
		dataDir: init.dataDir,
		workspace,
		rpc,
		key: init.key ? Buffer.from(init.key, 'base64') : undefined,
		port: Number(init.port) || 0
	});
	let engine = {};
	try {
		engine = JSON.parse(fs.readFileSync(path.join(engineDir, 'engine.json'), 'utf8'));
	} catch {
		/* dev engine without metadata */
	}
	return { url: host.url, workspace, engine, protocol: PROTOCOL };
}

async function stop(code = 0) {
	try {
		if (host) await host.stop();
	} finally {
		process.exit(code);
	}
}

/**
 * One headless turn: `node host/main.js --headless [folder] --prompt "..." [--json]
 * [--mode full|agent] [--timeout-sec N] [--plan]`. The prompt comes from --prompt
 * or stdin. Exit code: 0 completed, 1 failed/errored, 2 stopped or timed out.
 * Prints the answer (or a JSON report with --json) on stdout.
 */
const headless = process.argv.includes('--headless');

function headlessArgs() {
	const argv = process.argv.slice(2);
	const get = (name) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	return {
		prompt: get('--prompt'),
		json: argv.includes('--json'),
		plan: argv.includes('--plan'),
		stdin: argv.includes('--stdin'),
		evaluation: argv.includes('--eval-stdin'),
		mode: get('--mode') === 'agent' ? 'agent' : 'full',
		timeoutMs: Number(get('--timeout-sec')) > 0 ? Number(get('--timeout-sec')) * 1000 : 0,
		folder: get('--project')
	};
}

async function runHeadless() {
	const a = headlessArgs();
	let prompt = a.prompt;
	let configuration;
	let followUps = [];
	if (a.evaluation || ((!prompt || !prompt.trim()) && a.stdin)) {
		const input = await new Promise((resolve, reject) => {
			let data = '';
			process.stdin.setEncoding('utf8');
			process.stdin.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) reject(new Error('Headless input is too large.')); });
			process.stdin.on('end', () => resolve(data));
		});
		if (a.evaluation) { const request = JSON.parse(input); prompt = request.prompt; configuration = request.configuration; followUps = request.followUps || []; if (!Array.isArray(followUps) || followUps.length > 20 || followUps.some(t => typeof t !== 'string' || !t.trim())) throw new Error('Invalid evaluation follow-ups.'); }
		else prompt = input;
	}
	prompt = String(prompt ?? '').trim();
	if (!prompt) {
		process.stderr.write('headless: a prompt is required (--prompt "…" or --stdin). Ensure the engine is built: npm run engine.\n');
		process.exit(2);
	}
	let report;
	try {
		const started = await start({
			...(configuration ? { key: require('crypto').randomBytes(32).toString('base64') } : {}),
			engineDir: process.env.ZER0NE_ENGINE_DIR || path.join(__dirname, '..', 'engine'),
			dataDir: process.env.ZER0NE_DATA_DIR || path.join(os.homedir(), '.zer0ne-code', 'headless'),
			workspace: a.folder ? path.resolve(a.folder) : process.cwd(),
			port: 0
		});
		const providerIds = new Map();
		report = await host.headlessRun(prompt, { mode: a.mode, timeoutMs: a.timeoutMs, plan: a.plan, configuration, providerIds });
		for (const next of followUps) {
			if (report.outcome !== 'completed') break;
			const previous = report;
			report = await host.headlessRun(next, { mode: a.mode, timeoutMs: a.timeoutMs, plan: a.plan, providerIds });
			report.attempts = [...previous.attempts, ...report.attempts];
			report.steps += previous.steps;
		}
		void started;
	} catch (e) {
		process.stderr.write(`headless failed: ${e && e.stack ? e.stack : e}\n`);
		process.exit(1);
	} finally {
		try { if (host) await host.stop(); } catch { /* stopping anyway */ }
	}
	// The report goes out on the real stdout: `protocolOut` was bound before the
	// global redirect that sends every later process.stdout.write to stderr.
	if (a.json) {
		protocolOut(JSON.stringify(report, null, 2) + '\n');
	} else {
		if (report.text) protocolOut(report.text + '\n');
		else process.stderr.write('(the agent finished without an answer)\n');
		for (const f of report.files) process.stderr.write(`[changed] ${f}\n`);
	}
	process.exit(report.outcome === 'completed' ? 0 : report.outcome === 'failed' ? 1 : 2);
}

if (headless) {
	runHeadless().catch(error => { process.stderr.write(`Headless host failed: ${error.message}\n`); void stop(1); });
	process.on('SIGINT', () => void stop(2));
	process.on('SIGTERM', () => void stop(2));
} else if (standalone) {
	const folder = process.argv.slice(2).find((a) => !a.startsWith('--'));
	start({
		engineDir: process.env.ZER0NE_ENGINE_DIR || path.join(__dirname, '..', 'engine'),
		dataDir: process.env.ZER0NE_DATA_DIR || path.join(os.homedir(), '.zer0ne-code', 'standalone'),
		workspace: folder ? path.resolve(folder) : process.cwd(),
		port: process.env.ZER0NE_PORT
	}).then(
		(r) => {
			process.stderr.write(`zer0ne Code host — ${r.workspace || 'no folder'}\n`);
			protocolOut(r.url + '\n');
		},
		(e) => {
			process.stderr.write(`zer0ne Code host failed: ${e && e.stack ? e.stack : e}\n`);
			process.exit(1);
		}
	);
	process.on('SIGINT', () => void stop());
	process.on('SIGTERM', () => void stop());
} else {
	const lines = readline.createInterface({ input: process.stdin });
	lines.on('line', (line) => {
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}
		if (msg.t === 'init') {
			if (startup) return;
			startup = start(msg);
			startup.then(
				(r) => send({ t: 'ready', ...r }),
				(e) => {
					send({ t: 'fatal', message: e && e.message ? e.message : String(e) });
					process.stderr.write(`[fatal] ${e && e.stack ? e.stack : e}\n`);
				}
			);
		} else if (msg.t === 'activate') {
			if (!startup) return;
			activations = activations.then(async () => {
				await startup;
				await host.activate(msg.handoff || null, typeof msg.activationId === 'string' ? msg.activationId : undefined);
			}).catch((e) => {
				send({ t: 'activationError', activationId: msg.activationId, message: e && e.message ? e.message : String(e) });
				process.stderr.write(`[activate] ${e && e.stack ? e.stack : e}\n`);
			});
		} else if (msg.t === 'notch') {
			if (!startup) return;
			activations = activations.then(async () => {
				await startup;
				await host.notchAct(msg.act);
			}).catch((e) => process.stderr.write(`[notch] ${e && e.stack ? e.stack : e}\n`));
		} else if (msg.t === 'res') {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			if (msg.error) p.reject(new Error(msg.error));
			else p.resolve(msg.value ?? null);
		} else if (msg.t === 'shutdown') {
			void stop();
		} else {
			process.stderr.write(`[protocol] ignored an unknown message: ${String(msg && msg.t)}\n`);
		}
	});
	// The shell is gone: never linger as an orphan.
	lines.on('close', () => void stop());
}
