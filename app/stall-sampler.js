/*
 * Main-process stall sampler (Claude Desktop's stall-sampler-worker design):
 * the main thread bumps a SharedArrayBuffer heartbeat on a timer;
 * a worker thread watches it with real wall-clock time. When the heartbeat
 * freezes for over a second the worker profiles the main thread through the
 * inspector and reports the hottest frames, rate-limited so a permanently
 * wedged main thread cannot flood anyone. Diagnostics only: it changes nothing.
 */
'use strict';
const { isMainThread, Worker, parentPort } = require('worker_threads');

const POLL_MS = 100, THRESHOLD_MS = 1_000, MAX_CAPTURE_MS = 10_000, SAMPLING_US = 1_000;
const MAX_BURSTS = 3, WINDOW_MS = 300_000;

function start(onCapture) {
	const sab = new SharedArrayBuffer(8);
	const beats = new BigInt64Array(sab);
	// A recursive immediate prevents the event loop from sleeping when idle.
	const heartbeat = setInterval(() => Atomics.add(beats, 0, 1n), POLL_MS);
	heartbeat.unref();
	const worker = new Worker(__filename, {
		workerData: { sab, pollMs: POLL_MS, thresholdMs: THRESHOLD_MS, maxCaptureMs: MAX_CAPTURE_MS, samplingUs: SAMPLING_US, maxBursts: MAX_BURSTS, windowMs: WINDOW_MS },
		resourceLimits: { maxOldGenerationSizeMb: 128 },
		execArgv: []
	});
	worker.on('message', (msg) => {
		if (msg && msg.type === 'stall_capture' && onCapture) onCapture(msg);
	});
	// A sampler failure is never the app's problem.
	worker.on('error', () => undefined);
	worker.on('exit', () => undefined);
	worker.unref();
	return { stop: () => { clearInterval(heartbeat); void worker.terminate(); } };
}

/** Hottest frames by self time (hits × sampling interval), hottest first. */
function hottest(profile, samplingUs, limit = 8) {
	return (profile && profile.nodes ? profile.nodes : [])
		.filter((n) => n && n.hitCount > 0 && n.callFrame)
		.map((n) => ({ fn: n.callFrame.functionName || '(anonymous)', url: n.callFrame.url || '', line: (n.callFrame.lineNumber || 0) + 1, selfMs: Math.round((n.hitCount * samplingUs) / 1000) }))
		.sort((a, b) => b.selfMs - a.selfMs)
		.slice(0, limit);
}

async function runWorker() {
	const { sab, pollMs, thresholdMs, maxCaptureMs, samplingUs, maxBursts, windowMs } = require('worker_threads').workerData;
	const beats = new BigInt64Array(sab);
	const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const send = (session, method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))));

	/** Profile the main thread until its heartbeat moves again (or the cap). */
	async function capture() {
		const session = new (require('inspector').Session)();
		try {
			session.connectToMainThread();
			await send(session, 'Profiler.enable');
			await send(session, 'Profiler.setSamplingInterval', { interval: samplingUs });
			await send(session, 'Profiler.start');
			const startedAt = Date.now();
			let last = Atomics.load(beats, 0);
			while (Date.now() - startedAt < maxCaptureMs) {
				await delay(50);
				const now = Atomics.load(beats, 0);
				if (now !== last) break;
			}
			const { profile } = await send(session, 'Profiler.stop');
			return profile;
		} finally {
			try { session.disconnect(); } catch { /* already gone */ }
		}
	}

	let lastValue = Atomics.load(beats, 0);
	let lastMove = Date.now();
	const bursts = [];
	let capturing = false;
	setInterval(() => {
		const now = Date.now();
		const value = Atomics.load(beats, 0);
		if (value !== lastValue) {
			lastValue = value;
			lastMove = now;
			return;
		}
		if (capturing || now - lastMove < thresholdMs) return;
		while (bursts.length && now - bursts[0] > windowMs) bursts.shift();
		if (bursts.length >= maxBursts) return;
		capturing = true;
		bursts.push(now);
		const startLagMs = now - lastMove;
		capture()
			.then((profile) => {
				parentPort.postMessage({ type: 'stall_capture', startLagMs, frames: hottest(profile, samplingUs) });
			})
			.catch(() => undefined)
			.finally(() => { capturing = false; });
	}, pollMs);
}

// The same file runs on both sides: main imports start(), the Worker runs the watcher.
if (!isMainThread) {
	runWorker().catch(() => undefined);
} else {
	module.exports = { start, hottest, POLL_MS, THRESHOLD_MS, MAX_BURSTS, WINDOW_MS };
}
