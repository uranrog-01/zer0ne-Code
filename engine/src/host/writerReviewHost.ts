import { randomUUID } from 'crypto';
import { sameWriterPath, type WriterPool } from './writers';
import type { AgentRun } from './turnAgents';
import type { HostSurface } from './context';

interface Deps {
	pool: WriterPool;
	session(): string;
	root(): string | undefined;
	readOnly(): boolean;
	denyPaths?(): string;
	busy(): boolean;
	find(id: string): AgentRun | undefined;
	refresh(): Promise<void>;
	resume(id: string): Promise<void>;
	record(id: string, before: Map<string, string | null>, session: string): Promise<void>;
}

/** An Apply/Discard click is valid only for the exact diff this chat's user just reviewed. */
export class WriterReviewHost {
	private readonly reviews = new Map<string, { session: string; id: string; patch: string; at: number }>();
	private mutating = false;
	constructor(private readonly d: Deps) {}

	async handle(surface: HostSurface, msg: { type?: unknown; sessionId?: unknown; id?: unknown; action?: unknown; reviewId?: unknown }): Promise<void> {
		const session = this.d.session(), id = String(msg.id ?? ''), root = this.d.root();
		if (msg.sessionId !== session) throw new Error('That chat is no longer active.');
		const run = this.d.find(id), job = this.d.pool.jobs.get(id);
		if (!root || !run || run.sessionId !== session || run.kind !== 'writer' || !job || job.sessionId !== session || !job.root || !sameWriterPath(job.root, root)) throw new Error('No isolated writer in this project and chat.');
		if (run.status === 'running') throw new Error('Wait for the writer to stop before reviewing its changes.');
		if (msg.action === 'resume') {
			if (this.d.readOnly() || this.d.busy()) throw new Error('Resume needs an idle chat in Full Access mode.');
			await this.d.resume(id); return;
		}
		if (msg.action === 'diff') {
			const diff = await this.d.pool.diff(id);
			if (this.d.session() !== session) return;
			const reviewId = randomUUID(), truncated = diff.patch.length > 1_000_000;
			this.reviews.clear();
			if (!truncated) this.reviews.set(reviewId, { session, id, patch: diff.patch, at: Date.now() });
			surface.post({ type: 'writerDiff', sessionId: session, id, reviewId, files: diff.files, patch: diff.patch.slice(0, 1_000_000), truncated });
			return;
		}
		if (!['apply', 'discard'].includes(String(msg.action))) throw new Error('Unknown writer review action.');
		if (this.d.readOnly() || this.d.busy() || this.mutating) throw new Error('Wait for an idle chat in Full Access mode before applying or discarding changes.');
		const review = this.reviews.get(String(msg.reviewId));
		if (!review || review.id !== id || review.session !== session || Date.now() - review.at > 15 * 60_000) throw new Error('Open View diff again before applying or discarding this writer.');
		this.mutating = true;
		try {
			const before = new Map<string, string | null>();
			const result = msg.action === 'apply'
				? await this.d.pool.merge(id, root, (file, original) => before.set(file, original), review.patch, undefined, this.d.denyPaths?.())
				: await this.d.pool.discard(id, root, review.patch);
			if (before.size) await this.d.record(id, before, session);
			run.worktree = { path: job.dir, branch: job.branch, status: job.status, ...job.stat };
			this.reviews.delete(String(msg.reviewId));
			surface.post({ type: 'writerReviewDone', sessionId: session, id, result });
			await this.d.refresh();
		} catch (error) {
			throw new Error(`${error instanceof Error ? error.message : String(error)} The writer worktree is retained when application fails; inspect and refresh the diff before trying again.`);
		} finally { this.mutating = false; }
	}
}
