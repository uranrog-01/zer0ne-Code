export interface ScheduleTiming { queueMs: number; runMs: number; pool: string; }
type Waiter = { exclusive: boolean; signal: AbortSignal; start(): void; cancel(): void };
type Pool = { active: number; exclusive: boolean; limit: number; override?: number; queue: Waiter[] };

export class ToolScheduler {
	private readonly pools = new Map<string, Pool>();
	setLimit(name: string, limit: number): void {
		const pool = this.pools.get(name);
		if (!pool) return;
		pool.limit = Math.max(1, Math.min(64, Math.floor(limit) || 1));
		pool.override = pool.limit;
		this.drain(pool);
	}
	acquire(name: string, limit: number, signal: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			void this.run(name, limit, false, signal, () => new Promise<void>((release) => resolve(release))).catch(reject);
		});
	}
	async run<T>(name: string, limit: number, exclusive: boolean, signal: AbortSignal, work: () => Promise<T>, timing?: (t: ScheduleTiming) => void): Promise<T> {
		signal.throwIfAborted();
		let pool = this.pools.get(name);
		if (!pool) this.pools.set(name, pool = { active: 0, exclusive: false, limit: 1, queue: [] });
		pool.limit = pool.override ?? Math.max(1, Math.min(64, Math.floor(limit) || 1));
		const queued = performance.now();
		let began = queued;
		await new Promise<void>((resolve, reject) => {
			const p = pool!;
			const waiter: Waiter = { exclusive, signal, start: () => {
				signal.removeEventListener('abort', waiter.cancel);
				p.active++; p.exclusive = exclusive; began = performance.now(); resolve();
			}, cancel: () => {
				const at = p.queue.indexOf(waiter);
				if (at < 0) return;
				p.queue.splice(at, 1);
				signal.removeEventListener('abort', waiter.cancel);
				try { timing?.({ queueMs: performance.now() - queued, runMs: 0, pool: name }); } catch { /* Observer only. */ }
				reject(signal.reason ?? Object.assign(new Error('Stopped'), { name: 'AbortError' }));
				this.drain(p);
			} };
			p.queue.push(waiter);
			signal.addEventListener('abort', waiter.cancel, { once: true });
			this.drain(p);
		});
		try { signal.throwIfAborted(); return await work(); }
		finally {
			pool.active--; pool.exclusive = false;
			try { timing?.({ queueMs: began - queued, runMs: performance.now() - began, pool: name }); } catch { /* Observers cannot retain a permit. */ }
			this.drain(pool);
			if (!pool.active && !pool.queue.length) this.pools.delete(name);
		}
	}
	private drain(pool: Pool): void {
		while (pool.queue.length && !pool.exclusive && pool.active < pool.limit) {
			const next = pool.queue[0];
			// FIFO prevents an exclusive writer from starving behind newly arriving reads.
			if (next.exclusive && pool.active) return;
			pool.queue.shift(); next.start();
			if (next.exclusive) return;
		}
	}
}
