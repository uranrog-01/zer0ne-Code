import * as os from 'os';
import { Worker } from 'worker_threads';
import type { MachineCheck } from './localCatalog';

/**
 * The machine check behind Local models → Models: measures what decides local
 * model speed instead of guessing it from a name.
 *
 *  - Memory bandwidth: every generated token reads the model's weights once,
 *    so tokens/s ≈ bandwidth / model bytes. Integrated GPUs and Apple's
 *    unified memory read system RAM, so the RAM measurement is their GPU
 *    bandwidth too. Several threads copy 64 MB buffers for ~0.8 s (one thread
 *    cannot saturate a modern memory controller); read + write both count.
 *  - Calibration: real speeds measured on this machine (benchmarks, chats,
 *    generations) over the estimate for the same model → one factor that
 *    corrects every estimate (`calibration`).
 *
 * No admin rights, no installs, nothing leaves the machine.
 */

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const size = workerData.mb * 1024 * 1024;
const a = Buffer.alloc(size, 1);
const b = Buffer.alloc(size, 2);
a.copy(b); b.copy(a); // warm up: page in both buffers
const until = Date.now() + workerData.ms;
let bytes = 0;
const t0 = process.hrtime.bigint();
while (Date.now() < until) { a.copy(b); b.copy(a); bytes += 4 * size; }
const sec = Number(process.hrtime.bigint() - t0) / 1e9;
parentPort.postMessage({ bytes, sec });
`;

/** Measured memory bandwidth in GB/s (sum over threads), or undefined when workers are unavailable. */
export async function measureBandwidth(opts: { threads?: number; ms?: number; mb?: number } = {}): Promise<{ gbs: number; threads: number } | undefined> {
	const mb = Math.max(8, Math.min(64, opts.mb ?? 64));
	const threads = Math.max(1, Math.min(opts.threads ?? Math.ceil((os.cpus().length || 4) / 2), 8, Math.floor(os.freemem() * 0.08 / (2 * mb * 1024 ** 2))));
	const ms = opts.ms ?? 800;
	try {
		const runs = await Promise.all(
			Array.from({ length: threads }, () =>
				new Promise<{ bytes: number; sec: number }>((resolve, reject) => {
					const w = new Worker(WORKER, { eval: true, workerData: { mb, ms } });
					const timer = setTimeout(() => {
						void w.terminate();
						reject(new Error('timeout'));
					}, ms + 15_000);
					w.once('message', (m) => {
						clearTimeout(timer);
						void w.terminate();
						resolve(m);
					});
					w.once('error', (e) => {
						clearTimeout(timer);
						reject(e);
					});
				})
			)
		);
		// Threads run side by side: total bytes over the longest run.
		const bytes = runs.reduce((n, r) => n + r.bytes, 0);
		const sec = Math.max(...runs.map((r) => r.sec));
		return sec > 0 ? { gbs: Math.round((bytes / sec / 1e9) * 10) / 10, threads } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Pure: one correction factor from real measurements — the median of
 * measured / estimated over every model with both (outliers don't swing it).
 */
export function calibration(pairs: Array<{ measured: number; estimated: number }>): { factor?: number; samples: number } {
	const ratios = pairs.filter((p) => p.measured > 0 && p.estimated > 0).map((p) => p.measured / p.estimated).sort((a, b) => a - b);
	if (!ratios.length) return { samples: 0 };
	const mid = ratios.length >> 1;
	const median = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
	return { factor: Math.round(Math.min(2.5, Math.max(0.35, median)) * 100) / 100, samples: ratios.length };
}

/** A fresh check (bandwidth now, factors kept from the previous check until new measurements replace them). */
export async function runMachineCheck(previous?: MachineCheck): Promise<MachineCheck> {
	// Best of two short runs: the peak this memory reaches, not a moment when something else was busy.
	const a = await measureBandwidth({ ms: 500 });
	const b = await measureBandwidth({ ms: 500 });
	const bw = a && b ? (a.gbs >= b.gbs ? a : b) : a ?? b;
	return { ...previous, at: Date.now(), ramGBs: bw?.gbs ?? previous?.ramGBs, threads: bw?.threads ?? previous?.threads };
}
