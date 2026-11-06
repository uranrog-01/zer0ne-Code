/*
 * Utility worker pool (Electron utilityProcess): one forked child per pool,
 * request/response with ids, and a restart cooldown so a crashing worker backs
 * off exponentially instead of spinning. Jobs time out and the child is killed
 * on timeout — a worker that stops answering is not trusted with the next job.
 * Offloads work that would block the main process (wallpaper reads).
 */
'use strict';
const path = require('path');
const { utilityProcess } = require('electron');

const COOLDOWN_MS = 500, COOLDOWN_CAP_MS = 10_000;

class WorkerPool {
	constructor(name) {
		this.name = name;
		this.child = null;
		this.forking = null;
		this.seq = 0;
		this.pending = new Map();
		this.failures = 0;
		this.cooldownUntil = 0;
	}

	/** The running child, forking when cold (after the crash cooldown elapsed). */
	ready() {
		if (this.child) return Promise.resolve(this.child);
		if (this.forking) return this.forking;
		const wait = Math.max(0, this.cooldownUntil - Date.now());
		this.forking = new Promise((resolve, reject) => {
			setTimeout(() => {
				try {
					const workerRoot = __dirname.replace(/app\.asar(?=[\\/])/, 'app.asar.unpacked');
					const child = utilityProcess.fork(path.join(workerRoot, 'workers', 'misc.js'), [], { serviceName: this.name });
					child.on('message', (msg) => this.onMessage(msg));
					child.on('exit', () => this.onExit());
					child.on('spawn', () => {
						this.child = child;
						this.forking = null;
						resolve(child);
					});
				} catch (error) {
					this.forking = null;
					reject(error);
				}
			}, wait);
		});
		return this.forking;
	}

	/** Run one op; rejects with a typed error (`worker_timeout`, `worker_exit`) instead of hanging. */
	request(op, args, timeoutMs = 15_000) {
		return this.ready().then((child) => new Promise((resolve, reject) => {
			const id = ++this.seq;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				this.kill();
				reject(Object.assign(new Error(`${this.name} worker timed out on ${op}`), { code: 'worker_timeout' }));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.postMessage({ type: 'job', id, op, args });
		}));
	}

	onMessage(msg) {
		if (!msg || typeof msg !== 'object' || !this.pending.has(msg.id)) return;
		const job = this.pending.get(msg.id);
		this.pending.delete(msg.id);
		clearTimeout(job.timer);
		if (msg.type === 'result') {
			this.failures = 0;
			job.resolve(msg.value);
		} else {
			job.reject(new Error(String(msg.message || 'worker error')));
		}
	}

	/** A dead child fails everything in flight; the next request forks after the cooldown. */
	onExit() {
		this.child = null;
		this.forking = null;
		for (const job of this.pending.values()) {
			clearTimeout(job.timer);
			job.reject(Object.assign(new Error(`${this.name} worker exited`), { code: 'worker_exit' }));
		}
		this.pending.clear();
		this.failures++;
		this.cooldownUntil = Date.now() + Math.min(COOLDOWN_MS * 2 ** this.failures, COOLDOWN_CAP_MS);
	}

	kill() {
		if (!this.child) return;
		const child = this.child;
		this.child = null;
		for (const job of this.pending.values()) {
			clearTimeout(job.timer);
			job.reject(Object.assign(new Error(`${this.name} worker stopped`), { code: 'worker_exit' }));
		}
		this.pending.clear();
		try {
			child.kill();
		} catch {
			// already gone
		}
	}
}

module.exports = { WorkerPool };
