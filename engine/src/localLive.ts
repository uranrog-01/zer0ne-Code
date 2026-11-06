import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';

/**
 * Live monitor for the running engine (Settings → Local models → Overview):
 * generation speed and context fill from llama.cpp's Prometheus `/metrics`,
 * the engine process's memory, and system RAM. Polled only while the page
 * asks for it. No vscode dependency.
 */

export interface LiveSample {
	at: number;
	/** Tokens/s generated since the last sample (0 when idle). */
	tokS: number;
	/** Share of the context (KV cache) in use, 0–1. */
	ctxFill?: number;
	ctxTokens?: number;
	busy: boolean;
	engineOn?: boolean;
	metricsAvailable?: boolean;
	cpuPercent?: number;
	/** Engine process resident memory. */
	engineBytes?: number;
	ramUsedBytes: number;
	ramTotalBytes: number;
	/** Output tokens reported by the engine. */
	tokensGenerated?: number;
}

/** Prometheus text → { metric: value } (the llamacpp: prefix dropped) (pure; tested). */
export function parseMetrics(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line || line.startsWith('#')) continue;
		const m = /^([a-zA-Z_:][\w:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+|NaN)/.exec(line);
		if (m && Number.isFinite(Number(m[2]))) {
			const key = m[1].replace(/^llamacpp:/, '');
			out[key] = (out[key] ?? 0) + Number(m[2]);
		}
	}
	return out;
}

/**
 * Memory from `tasklist /FO CSV /NH`, whatever the Windows language: the last
 * CSV field is the working set in KB, written "123,456 K", "123.456 K",
 * "123 456 Ko" or "123456 KB" — keep the digits (pure; tested).
 */
export function tasklistBytes(csv: string): number | undefined {
	const line = csv.split(/\r?\n/).find((l) => l.startsWith('"'));
	const fields = line ? [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [];
	const digits = (fields[fields.length - 1] ?? '').replace(/\D/g, '');
	return fields.length >= 5 && digits ? Number(digits) * 1024 : undefined;
}

/** Resident memory of a process (Windows: tasklist; Linux: /proc; macOS: ps). */
export function processBytes(pid: number): Promise<number | undefined> {
	if (process.platform === 'linux') {
		try {
			const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
			return Promise.resolve(m ? Number(m[1]) * 1024 : undefined);
		} catch {
			return Promise.resolve(undefined);
		}
	}
	return new Promise((resolve) => {
		const [cmd, args] = process.platform === 'win32' ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] : ['ps', ['-o', 'rss=', '-p', String(pid)]];
		execFile(cmd, args, { timeout: 4000, windowsHide: true }, (_e, out) => {
			const s = String(out || '');
			if (process.platform === 'win32') {
				resolve(tasklistBytes(s));
			} else {
				const kb = parseInt(s.trim(), 10);
				resolve(Number.isFinite(kb) ? kb * 1024 : undefined);
			}
		});
	});
}

export class LiveMonitor {
	private timer?: ReturnType<typeof setInterval>;
	private last?: { at: number; predicted: number; source: string };
	private cpu?: { idle: number; total: number };
	private busy = false;
	private generation = 0;

	constructor(private readonly source: () => { port: number; pid?: number } | undefined, private readonly post: (s: LiveSample) => void) {}

	get on(): boolean {
		return !!this.timer;
	}

	start(): void {
		if (this.timer) return;
		this.last = undefined;
		this.cpu = undefined;
		this.generation++;
		this.timer = setInterval(() => void this.tick(), 1500);
		this.timer.unref?.();
		void this.tick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.last = undefined;
		this.generation++;
	}

	private async tick(): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const generation = this.generation;
		try {
			const src = this.source();
			const now = Date.now();
			const sample: LiveSample = { at: now, tokS: 0, busy: false, engineOn: !!src, metricsAvailable: false, ramUsedBytes: os.totalmem() - os.freemem(), ramTotalBytes: os.totalmem() };
			const cpu = os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((n, v) => n + v, 0) }), { idle: 0, total: 0 });
			if (this.cpu && cpu.total > this.cpu.total) sample.cpuPercent = Math.max(0, Math.min(100, 100 * (1 - (cpu.idle - this.cpu.idle) / (cpu.total - this.cpu.total))));
			this.cpu = cpu;
			if (!src) this.last = undefined;
			if (src) {
				try {
					const res = await fetch(`http://127.0.0.1:${src.port}/metrics`, { signal: AbortSignal.timeout(1200) });
					if (res.ok) {
						sample.metricsAvailable = true;
						const m = parseMetrics(await res.text());
						const predicted = m.tokens_predicted_total ?? 0;
						const source = `${src.port}:${src.pid ?? ''}`;
						if (this.last?.source === source && predicted >= this.last.predicted && now > this.last.at) sample.tokS = Math.round(((predicted - this.last.predicted) / ((now - this.last.at) / 1000)) * 10) / 10;
						this.last = { at: now, predicted, source };
						if (m.kv_cache_usage_ratio !== undefined) sample.ctxFill = m.kv_cache_usage_ratio;
						if (m.kv_cache_tokens !== undefined) sample.ctxTokens = m.kv_cache_tokens;
						sample.busy = (m.requests_processing ?? 0) > 0;
						sample.tokensGenerated = m.tokens_predicted_total;
					}
				} catch {
					/* loading, or an older build without --metrics */
				}
				// Current builds have no KV-usage metric: the slot tells the context size and the tokens in it.
				if (sample.ctxFill === undefined) {
					try {
						const slots = (await (await fetch(`http://127.0.0.1:${src.port}/slots`, { signal: AbortSignal.timeout(1200) })).json()) as Array<{ n_ctx?: number; n_prompt_tokens?: number; is_processing?: boolean; next_token?: Array<{ n_decoded?: number }> | { n_decoded?: number } }>;
						const s = Array.isArray(slots) ? slots[0] : undefined;
						if (s?.n_ctx) {
							const next = Array.isArray(s.next_token) ? s.next_token[0] : s.next_token;
							const used = (s.n_prompt_tokens ?? 0) + (next?.n_decoded ?? 0);
							sample.ctxFill = Math.min(1, used / s.n_ctx);
							sample.ctxTokens = used;
							sample.busy ||= s.is_processing === true;
						}
					} catch {
						/* slots disabled (--no-slots) */
					}
				}
				if (src.pid) sample.engineBytes = await processBytes(src.pid);
			}
			if (!sample.metricsAvailable) this.last = undefined;
			if (this.on && this.generation === generation) this.post(sample);
		} finally {
			this.busy = false;
		}
	}
}
