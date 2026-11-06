import { Worker, isMainThread, parentPort } from 'worker_threads';
import type { AgentDef, CommandDef, PluginInfo, SubagentState } from './plugins';
import type { SkillInfo } from './skills';
import type { HookConfig, McpServerConfig } from '../providerStore';

export interface CatalogInput {
	storage: string;
	home: string;
	root?: string;
	bundledSkills: string;
	disabledPlugins: string[];
	activatedPlugins: string[];
	disabledSkills: string[];
	agentState: SubagentState;
	desktop: boolean;
}
export interface CatalogSnapshot {
	plugins: PluginInfo[];
	skills: SkillInfo[];
	commands: CommandDef[];
	agents: AgentDef[];
	hooks: HookConfig[];
	mcp: McpServerConfig[];
}

if (!isMainThread && parentPort) {
	parentPort.on('message', ({ id, input }: { id: number; input: CatalogInput }) => {
		try {
			const { PluginHost } = require('./plugins') as typeof import('./plugins');
			const { SkillStore } = require('./skills') as typeof import('./skills');
			const plugins = new PluginHost(input.storage, () => input.root, () => input.disabledPlugins, () => input.activatedPlugins, input.home);
			plugins.agentState = () => input.agentState;
			const snapshot = plugins.withCatalogSnapshot(() => {
				const skills = new SkillStore(require('path').join(input.storage, 'skills'), () => input.root, () => input.disabledSkills, () => [...plugins.skillDirs(), { dir: input.bundledSkills, plugin: 'zer0ne' }], input.home);
				return { plugins: plugins.plugins(), skills: skills.list(), commands: plugins.commands().filter(c => !input.desktop || c.name !== 'mod'), agents: plugins.agents(), hooks: plugins.hooks(), mcp: plugins.mcpServers() } satisfies CatalogSnapshot;
			});
			parentPort!.postMessage({ id, snapshot });
		} catch (error) { parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
	});
}

/** Presentation snapshots may be briefly cached. Execution/activation still validates current files in the stores. */
export class ExtensionCatalog {
	private worker?: Worker;
	private disposed = false;
	private seq = 0;
	private revision = 0;
	get version(): number { return this.revision; }
	invalidate(): void { this.revision++; this.cache = undefined; }
	private cache?: { key: string; at: number; snapshot: CatalogSnapshot };
	private pending = new Map<number, { key: string; timer: ReturnType<typeof setTimeout>; promise: Promise<CatalogSnapshot>; resolve(value: CatalogSnapshot): void; reject(error: Error): void }>();

	read(input: CatalogInput): Promise<CatalogSnapshot> {
		if (this.disposed) return Promise.reject(new Error('Extension catalog is closed.'));
		const key = this.revision + ':' + JSON.stringify(input);
		if (this.cache?.key === key && Date.now() - this.cache.at < 500) return Promise.resolve(this.cache.snapshot);
		const existing = [...this.pending.values()].find(p => p.key === key);
		if (existing) return existing.promise;
		if (!this.worker) {
			const worker = this.worker = new Worker(__filename);
			worker.on('message', ({ id, snapshot, error }) => {
				const request = this.pending.get(id);
				if (!request) return;
				this.pending.delete(id);
				clearTimeout(request.timer);
				if (error) request.reject(new Error(error));
				else { this.cache = { key: request.key, at: Date.now(), snapshot }; request.resolve(snapshot); }
				if (!this.pending.size) worker.unref();
			});
			worker.on('error', error => this.fail(worker, error));
			worker.on('exit', code => this.fail(worker, new Error(`Extension catalog worker stopped (${code}).`)));
		}
		const id = ++this.seq;
		let resolve!: (value: CatalogSnapshot) => void, reject!: (error: Error) => void;
		const promise = new Promise<CatalogSnapshot>((yes, no) => { resolve = yes; reject = no; });
		const worker = this.worker;
		const timer = setTimeout(() => { this.fail(worker, new Error('Extension discovery timed out.')); void worker.terminate(); }, 30_000);
		this.pending.set(id, { key, timer, promise, resolve, reject });
		worker.ref();
		try { worker.postMessage({ id, input }); } catch (error) { this.fail(worker, error instanceof Error ? error : new Error(String(error))); void worker.terminate(); }
		return promise;
	}

	private fail(worker: Worker, error: Error): void {
		if (this.worker !== worker) return;
		this.worker = undefined;
		this.cache = undefined;
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
		this.pending.clear();
	}

	dispose(): void {
		this.disposed = true;
		if (!this.worker) return;
		const worker = this.worker;
		this.fail(worker, new Error('Extension catalog is closed.'));
		void worker.terminate();
	}
}
