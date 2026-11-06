import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { engineEnv, hfFileMeta, verifiedHfDownload, type DownloadProgress } from './localEngine';

/**
 * Private code search: an embedding model and a reranker, both small GGUFs run
 * by the installed zer0ne Engine (llama-server --embedding / --reranking) on
 * their own loopback ports. Started when the code index needs them, stopped
 * after 10 idle minutes. Nothing leaves the machine. No vscode dependency.
 */

export type EmbedKind = 'embed' | 'rerank';

export const PRIVATE_MODELS: Record<EmbedKind, { repo: string; file: string; bytes: number; alias: string; label: string; args: string[]; portOffset: number }> = {
	embed: {
		repo: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
		file: 'nomic-embed-text-v1.5.Q8_0.gguf',
		bytes: 146_000_000,
		alias: 'zer0ne-embed',
		label: 'nomic-embed-text v1.5',
		args: ['--embedding', '--pooling', 'mean', '-c', '8192', '-b', '8192', '-ub', '8192'],
		portOffset: 11
	},
	rerank: {
		repo: 'gpustack/bge-reranker-v2-m3-GGUF',
		file: 'bge-reranker-v2-m3-Q4_K_M.gguf',
		bytes: 438_000_000,
		alias: 'zer0ne-rerank',
		label: 'bge-reranker v2 m3',
		args: ['--reranking', '-c', '8192', '-b', '8192', '-ub', '8192'],
		portOffset: 12
	}
};

/** nomic-embed wants task prefixes; queries and code chunks get their own (tested). */
export const EMBED_PREFIX = { query: 'search_query: ', document: 'search_document: ' };

const IDLE_MS = 10 * 60_000;

export class LocalEmbedService {
	private readonly procs = new Map<EmbedKind, ChildProcess>();
	/** The servers that answered /health: a process that exists is not yet a usable server. */
	private readonly ready = new Set<EmbedKind>();
	private readonly starting = new Map<EmbedKind, Promise<number>>();
	private readonly lastUse = new Map<EmbedKind, number>();
	private idle?: ReturnType<typeof setInterval>;

	constructor(
		private readonly dir: string,
		private readonly serverPath: () => string | undefined,
		private readonly basePort: () => number,
		private readonly onChange: () => void
	) {}

	file(kind: EmbedKind): string {
		return path.join(this.dir, PRIVATE_MODELS[kind].file);
	}

	installed(kind: EmbedKind): boolean {
		return fs.existsSync(this.file(kind));
	}

	port(kind: EmbedKind): number {
		return this.basePort() + PRIVATE_MODELS[kind].portOffset;
	}

	running(kind: EmbedKind): boolean {
		const p = this.procs.get(kind);
		return !!p && p.exitCode === null && this.ready.has(kind);
	}

	status() {
		return (['embed', 'rerank'] as EmbedKind[]).map((k) => ({ kind: k, label: PRIVATE_MODELS[k].label, bytes: PRIVATE_MODELS[k].bytes, installed: this.installed(k), running: this.running(k), port: this.port(k) }));
	}

	async download(kind: EmbedKind, onProgress: (p: DownloadProgress) => void, signal: AbortSignal): Promise<void> {
		const m = PRIVATE_MODELS[kind];
		fs.mkdirSync(this.dir, { recursive: true });
		// The Hub publishes the file's size and SHA-256: download it and check both.
		const meta = await hfFileMeta(m.repo, m.file);
		if (!meta) throw new Error(`Hugging Face does not list ${m.file} in ${m.repo} any more.`);
		await verifiedHfDownload(m.repo, { path: m.file, size: meta.size, sha256: meta.sha256 }, undefined, this.file(kind), onProgress, signal);
		this.onChange();
	}

	/** Start (or reuse) the model's server; resolves with its port once it serves. */
	ensure(kind: EmbedKind): Promise<number> {
		this.lastUse.set(kind, Date.now());
		if (this.running(kind)) return Promise.resolve(this.port(kind));
		const pending = this.starting.get(kind);
		if (pending) return pending;
		const run = this.launch(kind).finally(() => this.starting.delete(kind));
		this.starting.set(kind, run);
		return run;
	}

	private async launch(kind: EmbedKind): Promise<number> {
		const server = this.serverPath();
		if (!server) throw new Error('Private code search runs on zer0ne Engine — install it under Local models → Runtimes.');
		if (!this.installed(kind)) throw new Error(`The ${PRIVATE_MODELS[kind].label} model is not downloaded — Local models → Overview → Private code search.`);
		const m = PRIVATE_MODELS[kind];
		const port = this.port(kind);
		let log = '';
		const proc = spawn(server, ['-m', this.file(kind), '--host', '127.0.0.1', '--port', String(port), '--alias', m.alias, '--no-webui', '-np', '1', ...m.args], { windowsHide: true, cwd: path.dirname(server), env: engineEnv(server) });
		proc.stdout?.on('data', (c: Buffer) => (log = (log + c).slice(-4000)));
		proc.stderr?.on('data', (c: Buffer) => (log = (log + c).slice(-4000)));
		proc.on('exit', () => {
			if (this.procs.get(kind) === proc) this.procs.delete(kind);
			this.ready.delete(kind);
			this.onChange();
		});
		this.procs.set(kind, proc);
		this.idle ??= setInterval(() => void this.sweep(), 60_000);
		this.idle.unref?.();
		const until = Date.now() + 120_000;
		while (Date.now() < until) {
			if (proc.exitCode !== null) throw new Error(`The ${m.label} server stopped: ${log.trim().split('\n').filter((l) => /error|failed/i.test(l)).slice(-1)[0]?.slice(0, 200) ?? 'no details'}`);
			try {
				if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok) {
					// Only now is the server usable: before this it is still loading the model.
					this.ready.add(kind);
					this.onChange();
					return port;
				}
			} catch {
				/* still loading */
			}
			await new Promise((r) => setTimeout(r, 400));
		}
		this.stop(kind);
		throw new Error(`The ${m.label} server did not start in 2 minutes.`);
	}

	/**
	 * Stop the servers that have been idle for long enough. A request that is still being
	 * answered keeps the server alive: the code index sends work to it in the background.
	 */
	private async sweep(): Promise<void> {
		for (const kind of [...this.procs.keys()]) {
			if (this.starting.has(kind)) continue; // still loading the model
			if (Date.now() - (this.lastUse.get(kind) ?? 0) <= IDLE_MS) continue;
			if (await this.busy(kind)) {
				// A request is in flight: look again in a minute.
				this.lastUse.set(kind, Date.now());
				continue;
			}
			this.stop(kind);
		}
	}

	/** Is the server answering a request right now? */
	private async busy(kind: EmbedKind): Promise<boolean> {
		const port = this.port(kind);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(1500) });
			if (!res.ok) return false;
			const slots = (await res.json()) as Array<{ is_processing?: boolean }>;
			return Array.isArray(slots) && slots.some((s) => s.is_processing);
		} catch {
			return false;
		}
	}

	stop(kind?: EmbedKind): void {
		for (const k of kind ? [kind] : ([...this.procs.keys()] as EmbedKind[])) {
			const p = this.procs.get(k);
			this.procs.delete(k);
			this.ready.delete(k);
			if (p && p.exitCode === null) {
				if (process.platform === 'win32' && p.pid) spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
				else p.kill();
			}
		}
		this.onChange();
	}
}
