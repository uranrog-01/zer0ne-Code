import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import type { CoreRun } from '../core/loop';
import type { TaskBudgets } from '../core/taskBudget';
import type { ProviderConfig, HookConfig } from '../providerStore';
import type { StreamOptions, StreamResult } from '../chatClient';
import { usageSource } from '../usage';
import { acquireRuntimeLease } from '../runtimeLease';
import { refreshEvidence } from './taskEvidence';
import { redactSecrets } from '../tools/redact';
import { workflowModel } from './subagentWorkflow';
import { sameWriterPath, type WriterPool } from './writers';
import type { HostContext, HostFeature, HostSurface } from './context';
import type { ApprovalHandle, ApprovalRequest } from '../tools/agentTools';
import { requestProfileFor } from '../requestProfile';
import { responseLimit } from '../responseBudget';

interface Candidate { id: string; spec: string; attempts: number; input: number; output: number; cost: number; unknownCost: boolean; unknownUsage: boolean }
interface Comparison { id: string; session: string; prompt: string; base: string; createdAt: number; candidates: Candidate[]; applied?: string; error?: string }
interface Deps {
	pool: WriterPool;
	budgets: TaskBudgets;
	storage: string;
	extension: string;
	root(): string | undefined;
	session(): string;
	busy(): boolean;
	callModel(provider: ProviderConfig, key: string, options: StreamOptions): Promise<StreamResult>;
	scheduler: CoreRun['toolScheduler'];
	hooks(): HookConfig[];
	approve(command: string, session: string, signal: AbortSignal, worktree?: string, request?: ApprovalRequest): Promise<boolean | ApprovalHandle>;
	record(id: string, before: Map<string, string | null>, session: string): Promise<void>;
}

export interface CandidateEvidence {
	id: string;
	spec: string;
	status: string;
	cost: number;
	unknownCost: boolean;
	elapsedMs: number;
	stat?: { files: number; added: number; removed: number };
	checks: { status: string; stale?: boolean }[];
}

/**
 * The candidate to look at first, from recorded evidence only: finished, changed files, and
 * every recorded check passed and current. Ties go to the cheaper, smaller, faster run. No
 * candidate with passing checks means no recommendation — a model's own report is not
 * evidence. The user still reviews the diff before anything is applied (pure; tested).
 */
export function recommendCandidate(candidates: CandidateEvidence[]): { id: string; reason: string } | undefined {
	const finished = candidates.filter((c) => c.status === 'done' && (c.stat?.files ?? 0) > 0);
	const proven = finished.filter((c) => c.checks.length > 0 && c.checks.every((v) => v.status === 'passed' && !v.stale));
	if (!proven.length) return undefined;
	const size = (c: CandidateEvidence) => (c.stat?.added ?? 0) + (c.stat?.removed ?? 0);
	const price = (c: CandidateEvidence) => (c.unknownCost ? Number.POSITIVE_INFINITY : c.cost);
	const best = [...proven].sort((a, b) => price(a) - price(b) || size(a) - size(b) || a.elapsedMs - b.elapsedMs)[0]!;
	const why = [`${best.checks.length === 1 ? 'its check' : `all ${best.checks.length} checks`} passed`];
	if (proven.length > 1) {
		const others = proven.filter((c) => c !== best);
		if (others.every((c) => price(c) > price(best))) why.push('lowest cost');
		else if (others.every((c) => size(c) > size(best))) why.push('smallest change');
		else if (others.every((c) => c.elapsedMs > best.elapsedMs)) why.push('fastest');
	} else if (finished.length > 1) why.push('the only candidate with passing checks');
	return { id: best.id, reason: why.join(' · ') };
}

const git = (root: string, args: string[]) => new Promise<string>((resolve, reject) => execFile('git', args, { cwd: root, windowsHide: true, timeout: 10000, maxBuffer: 100000 }, (error, stdout) => error ? reject(new Error('Model comparison needs a Git repository with an existing commit.')) : resolve(stdout.trim())));

/** Candidates retain their worktrees until an explicit reviewed Apply or Discard. */
export class ModelComparisonsHost implements HostFeature {
	private groups: Comparison[] = [];
	private active = new Map<string, AbortController>();
	private reviews = new Map<string, { owner: HostSurface; session: string; group: string; job: string; patch: string; at: number }>();
	private changing = false;
	private starting = false;
	private readonly dir: string;
	constructor(private readonly ctx: HostContext, private readonly d: Deps) {
		this.dir = path.join(d.storage, 'comparisons', createHash('sha256').update(path.resolve(d.root() ?? '').toLowerCase()).digest('hex'));
		this.reload();
	}
	private reload(): void {
		try {
			for (const name of fs.readdirSync(this.dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 100)) {
				try {
					const file = path.join(this.dir, name);
					if (fs.statSync(file).size > 500000) continue;
					const g = JSON.parse(fs.readFileSync(file, 'utf8')) as Comparison;
					if (g.id + '.json' !== name || typeof g.session !== 'string' || typeof g.prompt !== 'string' || typeof g.base !== 'string' || !Array.isArray(g.candidates) || g.candidates.length > 4 || !g.candidates.every(c => c && typeof c.id === 'string' && typeof c.spec === 'string')) continue;
					const index = this.groups.findIndex(group => group.id === g.id);
					if (index < 0) this.groups.push(g); else if (!this.active.has(g.id)) this.groups[index] = g;
				} catch { /* A damaged comparison must not hide other retained candidates. */ }
			}
		} catch { /* No prior comparisons in this project. */ }
	}
	get busy(): boolean { return this.starting || this.changing || this.active.size > 0; }
	get mutating(): boolean { return this.changing || this.starting; }
	refresh(): void { if (this.groups.length) this.publish(); }
	cancelAll(): void { for (const stop of this.active.values()) stop.abort(); }
	dispose(): void { this.cancelAll(); }
	private save(group: Comparison): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const file = path.join(this.dir, group.id + '.json'), temporary = file + '.' + randomUUID() + '.tmp';
		try { fs.writeFileSync(temporary, JSON.stringify(group)); fs.renameSync(temporary, file); }
		finally { fs.rmSync(temporary, { force: true }); }
	}
	private publish(surface?: HostSurface): void {
		const session = this.d.session();
		const groups = this.groups.filter(g => g.session === session).map(g => {
			const candidates = g.candidates.map(c => {
				const j = this.d.pool.jobs.get(c.id);
				return { ...c, status: j?.status ?? 'unavailable', dir: j?.dir, branch: j?.branch, report: redactSecrets(j?.report ?? '').text.slice(0, 16000), error: redactSecrets(j?.error ?? '').text, stat: j?.stat, elapsedMs: j ? (j.endedAt ?? Date.now()) - j.startedAt : 0, checks: (j?.verification ?? []).map(v => ({ status: v.status, stale: v.stale, scope: v.scope })) };
			});
			const active = this.active.has(g.id);
			// Only once every run has stopped: a recommendation must not race a candidate still working.
			return { ...g, prompt: redactSecrets(g.prompt).text, active, candidates, recommended: !active && !g.applied ? recommendCandidate(candidates) ?? null : null };
		});
		const message = { type: 'comparisonState', sessionId: session, groups };
		if (surface) surface.post(message); else this.ctx.postAll(message);
	}
	private assertWritable(): void {
		if (this.ctx.store.getMode() !== 'full' || !this.ctx.store.getSettings().subagents) throw new Error('Comparisons need Full Access with subagents enabled.');
	}
	async handle(surface: HostSurface, msg: { type: string; [key: string]: unknown }): Promise<boolean> {
		if (!['comparisonList', 'comparisonStart', 'comparisonStop', 'comparisonReview'].includes(msg.type)) return false;
		try {
			const session = this.d.session();
			if (msg.sessionId !== session) throw new Error('That comparison belongs to another chat.');
			if (msg.type === 'comparisonList') { this.reload(); this.publish(surface); return true; }
			if (msg.type === 'comparisonStart') { await this.start(surface, msg); return true; }
			const group = this.groups.find(g => g.id === msg.groupId && g.session === session);
			if (!group) throw new Error('Comparison not found in this chat.');
			if (msg.type === 'comparisonStop') { this.active.get(group.id)?.abort(); this.publish(); return true; }
			const job = this.d.pool.jobs.get(String(msg.id)), root = this.d.root();
			if (!root || !job || job.comparisonId !== group.id || job.sessionId !== session || !job.root || !sameWriterPath(job.root, root) || !group.candidates.some(c => c.id === job.id)) throw new Error('Candidate does not belong to this comparison.');
			if (msg.action === 'diff') {
				await refreshEvidence(job.verification ?? [], this.ctx.store.getSettings());
				const { patch, files } = await this.d.pool.diff(job.id), reviewId = randomUUID(), truncated = patch.length > 1_000_000;
				if (this.d.session() !== session) return true;
				this.reviews.clear();
				if (!truncated) this.reviews.set(reviewId, { owner: surface, session, group: group.id, job: job.id, patch, at: Date.now() });
				this.publish();
				surface.post({ type: 'comparisonDiff', sessionId: session, groupId: group.id, id: job.id, reviewId, files, patch: redactSecrets(patch).text.slice(0, 1_000_000), truncated, applied: !!group.applied });
				return true;
			}
			this.assertWritable();
			if (this.busy || this.d.busy()) throw new Error('Wait for all writers and the chat to stop before applying or discarding a candidate.');
			if (!['apply', 'discard'].includes(String(msg.action))) throw new Error('Unknown comparison action.');
			if (msg.action === 'apply' && group.applied) throw new Error('A candidate was already applied from this comparison.');
			const review = this.reviews.get(String(msg.reviewId));
			if (!review || review.owner !== surface || review.session !== session || review.group !== group.id || review.job !== job.id || Date.now() - review.at > 900000) throw new Error('View the candidate diff again before applying or discarding it.');
			const release = acquireRuntimeLease(this.dir);
			if (!release) throw new Error('Another window is using comparisons for this project.');
			this.changing = true;
			try {
				const saved = JSON.parse(fs.readFileSync(path.join(this.dir, group.id + '.json'), 'utf8')) as Comparison;
				if (msg.action === 'apply' && saved.applied) throw new Error('A candidate was already applied from this comparison in another window.');
				const before = new Map<string, string | null>();
				if (msg.action === 'apply') {
					await this.d.pool.merge(job.id, root, (rel, original) => before.set(rel, original), review.patch, undefined, this.ctx.store.getSettings().denyPaths, true);
					group.applied = job.id;
					try { if (before.size) await this.d.record(job.id, before, session); }
					finally { this.save(group); }
				} else await this.d.pool.discard(job.id, root, review.patch);
				this.reviews.clear(); this.publish(); await this.ctx.sendState();
				surface.post({ type: 'comparisonApplied', sessionId: session });
			} finally { release(); this.changing = false; }
		} catch (error) { surface.post({ type: 'comparisonError', sessionId: this.d.session(), error: error instanceof Error ? error.message : String(error) }); }
		return true;
	}
	private async start(surface: HostSurface, msg: Record<string, unknown>): Promise<void> {
		this.assertWritable();
		if (this.busy || this.d.busy()) throw new Error('Start a comparison when the chat and writers are idle.');
		const session = this.d.session(), root = this.d.root(), prompt = typeof msg.prompt === 'string' ? msg.prompt.trim() : '';
		const specs = Array.isArray(msg.models) ? msg.models.filter((s): s is string => typeof s === 'string') : [];
		if (!root || !prompt || prompt.length > 40000 || specs.length < 2 || specs.length > 4 || new Set(specs).size !== specs.length) throw new Error('Enter a prompt and choose 2–4 distinct models.');
		const release = acquireRuntimeLease(this.dir);
		if (!release) throw new Error('Another window is using comparisons for this project.');
		this.starting = true;
		let launched = false;
		try {
			this.reload();
			const routes = await Promise.all(specs.map(s => workflowModel(this.ctx.store, s)));
			if (routes.some(r => !r)) throw new Error('Choose available models.');
			if (!sameWriterPath(await git(root, ['rev-parse', '--show-toplevel']), root)) throw new Error('Open the Git repository root before comparing models.');
			const base = await git(root, ['rev-parse', '--verify', 'HEAD']);
			if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base)) throw new Error('Cannot identify the comparison base commit.');
			this.assertWritable();
			if (session !== this.d.session() || this.d.busy()) throw new Error('The chat changed while preparing the comparison.');
			const settings = this.ctx.store.getSettings(), group: Comparison = { id: randomUUID(), session, prompt, base, createdAt: Date.now(), candidates: [] };
			if (this.groups.length >= 100) throw new Error('This project has reached its saved comparison limit. Retained candidates remain available for review.');
			this.groups.push(group); this.save(group);
			const stop = new AbortController(), budget = this.d.budgets.create(group.id, { cost: settings.taskBudgetCost, tokens: settings.taskBudgetTokens, requests: settings.taskBudgetRequests, seconds: settings.taskBudgetSeconds });
			this.d.budgets.pin(budget); this.active.set(group.id, stop);
			const signal = AbortSignal.any([stop.signal, budget.controller.signal]), pending: Promise<unknown>[] = [];
			try {
				for (let i = 0; i < routes.length; i++) {
					const { provider, model, apiKey } = routes[i]!;
					const candidate: Candidate = { id: '', spec: specs[i], attempts: 0, input: 0, output: 0, cost: 0, unknownCost: false, unknownUsage: false };
					const { job, done } = this.d.pool.start({
						comparisonId: group.id, baseRevision: base, sessionId: session, root, description: `Compare ${model.id}`, prompt,
						providerId: provider.id, providerName: provider.name, provider: { baseUrl: provider.baseUrl, apiKey, apiFormat: provider.apiFormat, model: model.id },
						contextWindow: model.contextWindow,
						profile: requestProfileFor(settings, provider, model, await this.ctx.store.getEffort?.(provider.id, model.id)), maxTokens: responseLimit(model),
						denyPaths: settings.denyPaths, commandEnabled: settings.commandTool, verificationSettings: settings,
						hooks: this.d.hooks(), hookBase: { session_id: session, workspace: root }, journalStorage: this.d.storage,
						signal, toolScheduler: this.d.scheduler, toolConcurrency: settings.toolConcurrency, childConcurrency: settings.childConcurrency,
						approveCommand: async () => false,
						requestCommandApproval: async req => {
							const result = await this.d.approve(req.command ?? '', session, signal, job.dir, req);
							return typeof result === 'boolean' ? { approved: result, finish() {} } : result;
						},
						sandbox: settings.sandbox !== 'off' ? { storageDir: this.d.storage, sourceFile: path.join(this.d.extension, 'media', 'sandbox', 'lowil.cs'), network: settings.sandboxNetwork } : undefined,
						checkTaskBudget: () => { this.assertWritable(); budget.assertActive(); },
						requestContext: { sessionId: session, rootTaskId: group.id, purpose: 'child' },
						callModel: options => { this.assertWritable(); return this.d.callModel(provider, apiKey, options); },
						onAttempt: a => { candidate.attempts++; candidate.input += a.usage?.input ?? 0; candidate.output += a.usage?.output ?? 0; candidate.cost += a.cost ?? 0; candidate.unknownCost ||= a.cost === undefined; candidate.unknownUsage ||= usageSource(a.usage) !== 'provider'; this.save(group); this.publish(); },
						onStep: () => this.publish()
					});
					candidate.id = job.id; group.candidates.push(candidate); pending.push(done); this.save(group);
				}
			} catch (error) { stop.abort(); group.error = error instanceof Error ? error.message : String(error); }
			this.publish(surface);
			launched = true;
			void Promise.allSettled(pending).then(() => {
				this.active.delete(group.id); this.d.budgets.unpin(budget); budget.dispose();
				try { this.save(group); this.publish(); } catch (error) { this.ctx.status(`Could not save comparison results: ${String(error)}`, 'error'); }
				finally { release(); }
				this.ctx.status(signal.aborted ? 'Model comparison stopped. Its partial work is retained for review.' : 'Model comparison finished. Open Compare models to review the candidates.', '');
			});
		} finally { this.starting = false; if (!launched) release(); }
	}
}
