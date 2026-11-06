import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { StreamOptions, StreamResult } from '../chatClient';
import type { ProviderConfig } from '../providerStore';
import { loadCaseDir, runEvals, summarize, type EvalCase, type EvalReport, type EvalSummary } from '../eval/harness';
import { auditJudge, loadJudgeCases, type JudgeAudit, type JudgeCase } from '../eval/judgeAudit';
import { GOAL_JUDGE_SYSTEM, judgeMessage, parseGoalVerdict } from './goal';
import { acquireRuntimeLease } from '../runtimeLease';
import { redactSecrets } from '../tools/redact';
import { workflowModel } from './subagentWorkflow';
import type { HostContext, HostFeature, HostSurface } from './context';
import { evalOptions, evalProfile, type EvalProfile } from '../eval/profiles';
import { runProduction, type ProductionConfiguration } from '../eval/production';
import { workflowModels, type SubagentWorkflow } from './subagentWorkflow';

/**
 * Settings → Features → Benchmark: the bundled agent tasks (engine/eval/cases) run
 * against the user's own models, so "which model works best in zer0ne" is measured
 * instead of guessed. Every case runs in a throwaway temp folder; the agent's
 * commands there run without approval cards, which is why a run needs Full Access
 * and the page asks first. Results are shared by every project engine.
 */

interface CaseResult { id: string; trial?: number; category: string; pass: boolean; failures: string[]; steps: number; toolCalls: number; ms: number; cost: number; metrics?: EvalReport['metrics'] }
export interface BenchmarkRun {
	id: string;
	at: number;
	spec: string;
	model: string;
	provider: string;
	categories: string[];
	stopped?: boolean;
	error?: string;
	summary: EvalSummary;
	cases: CaseResult[];
	/** The goal judge on this model, against records with seeded defects. */
	judge?: JudgeAudit;
	profile?: Pick<EvalProfile, 'name' | 'id' | 'kind' | 'tools'>;
	trials?: number;
	suite?: string;
	contextWindow?: number;
}
interface Deps {
	storage: string;
	extension: string;
	callModel(provider: ProviderConfig, key: string, options: StreamOptions): Promise<StreamResult>;
	/** Nothing else may run turns or writers while the benchmark spends the same quota. */
	busy(): boolean;
	workflow?(): Promise<SubagentWorkflow>;
	productionProvider?(provider: ProviderConfig, model: string, signal: AbortSignal): Promise<ProviderConfig>;
}

const MAX_RUNS = 40;
/** The category of the judge audit (engine/eval/judge): no agent run, one judge call per record. */
const JUDGE = 'judge';

export class BenchmarkHost implements HostFeature {
	private running?: { id: string; spec: string; model: string; done: number; total: number; current: string; stop: AbortController };
	private readonly dir: string;
	constructor(private readonly ctx: HostContext, private readonly d: Deps) {
		this.dir = path.join(d.storage, 'benchmark');
	}
	get busy(): boolean { return !!this.running; }
	dispose(): void { this.running?.stop.abort(); }

	private cases(): EvalCase[] {
		try { return loadCaseDir(path.join(this.d.extension, 'eval', 'cases')); } catch { return []; }
	}
	private judgeCases(): JudgeCase[] {
		try { return loadJudgeCases(path.join(this.d.extension, 'eval', 'judge')); } catch { return []; }
	}
	private history(): BenchmarkRun[] {
		try {
			const list = JSON.parse(fs.readFileSync(path.join(this.dir, 'history.json'), 'utf8'));
			return Array.isArray(list) ? list.filter((r) => r && typeof r.id === 'string' && r.summary).slice(0, MAX_RUNS) : [];
		} catch { return []; }
	}
	private record(run: BenchmarkRun): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const file = path.join(this.dir, 'history.json'), temporary = `${file}.${randomUUID()}.tmp`;
		const list = [run, ...this.history().filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
		try { fs.writeFileSync(temporary, JSON.stringify(list)); fs.renameSync(temporary, file); }
		finally { fs.rmSync(temporary, { force: true }); }
	}
	private publish(surface?: HostSurface): void {
		const cases = this.cases(), categories: Record<string, number> = {};
		for (const c of cases) categories[c.category ?? 'general'] = (categories[c.category ?? 'general'] ?? 0) + 1;
		const judged = this.judgeCases().length;
		if (judged) categories[JUDGE] = judged;
		const r = this.running;
		const message = { type: 'benchmarkState', total: cases.length + judged, categories, history: this.history(), running: r ? { id: r.id, spec: r.spec, model: r.model, done: r.done, total: r.total, current: r.current } : null };
		if (surface) surface.post(message); else this.ctx.postAll(message);
	}

	async handle(surface: HostSurface, msg: { type: string; [key: string]: unknown }): Promise<boolean> {
		if (!['benchmarkList', 'benchmarkStart', 'benchmarkStop', 'benchmarkClear', 'benchmarkApplyProfile'].includes(msg.type)) return false;
		try {
			if (msg.type === 'benchmarkList') { this.publish(surface); return true; }
			// Phones can watch results; only the desktop starts runs that execute commands.
			if (surface.kind === 'remote') throw new Error('Start benchmark runs from the desktop app.');
			if (msg.type === 'benchmarkStop') { this.running?.stop.abort(); return true; }
			if (msg.type === 'benchmarkApplyProfile') {
				if (this.running || this.d.busy()) throw new Error('Wait for the current work to finish.');
				const run = this.history().find(r => r.id === msg.id);
				if (!run || run.stopped || run.error || run.profile?.kind !== 'production' || run.profile.tools === 'auto' || (run.trials ?? 0) < 3 || (run.summary.measurement?.cases ?? 0) < 2 || run.summary.rate < 0.9 || !run.suite || Date.now() - run.at > 30 * 86400_000) throw new Error('This result needs at least 3 trials on 2 tasks, 90% success, and a completed production run from the last 30 days.');
				const route = (await workflowModel(this.ctx.store, run.spec))!;
				if (route.model.contextWindow !== run.contextWindow) throw new Error('The model context changed. Run the benchmark again.');
				await this.ctx.store.upsertModel(route.provider.id, { ...route.model, agentProfile: { tools: run.profile.tools, contextWindow: run.contextWindow, suite: run.suite, passed: run.summary.passed, total: run.summary.total, trials: run.trials!, at: run.at } });
				this.ctx.status('Measured tool profile saved for this model. It applies when tool selection is Automatic.', 'ok');
				await this.ctx.sendState(); this.publish(); return true;
			}
			if (msg.type === 'benchmarkClear') {
				if (this.running) throw new Error('Stop the running benchmark first.');
				fs.rmSync(path.join(this.dir, 'history.json'), { force: true });
				this.publish(); return true;
			}
			await this.start(msg);
		} catch (error) {
			surface.post({ type: 'benchmarkError', error: error instanceof Error ? error.message : String(error) });
		}
		return true;
	}

	private async start(msg: Record<string, unknown>): Promise<void> {
		if (this.ctx.store.getMode() !== 'full') throw new Error('Benchmark runs need Full Access: the agent runs commands in throwaway folders without asking.');
		if (msg.approved !== true) throw new Error('Confirm the benchmark run first.');
		if (this.running) throw new Error('A benchmark is already running.');
		if (this.d.busy()) throw new Error('Wait for the chat and its workers to stop before benchmarking.');
		const specs = Array.isArray(msg.models) ? [...new Set(msg.models.filter((s): s is string => typeof s === 'string'))] : [];
		if (!specs.length || specs.length > 4) throw new Error('Choose 1–4 models.');
		const wanted = Array.isArray(msg.categories) ? msg.categories.filter((c): c is string => typeof c === 'string') : [];
		const all = this.cases(), cases = wanted.length ? all.filter((c) => wanted.includes(c.category ?? 'general')) : all;
		const judged = !wanted.length || wanted.includes(JUDGE) ? this.judgeCases() : [];
		if (!cases.length && !judged.length) throw new Error('No benchmark tasks match the chosen categories.');
		const routes = await Promise.all(specs.map((s) => workflowModel(this.ctx.store, s)));
		const options = evalOptions(msg);
		const settings = this.ctx.store.getSettings?.() ?? {};
		const workflow = options.kind === 'production' ? await this.d.workflow?.() : undefined;
		const workers = workflow?.enabled ? await Promise.all(workflowModels(workflow).filter(Boolean).map(s => workflowModel(this.ctx.store, s))) : [];
		const localModels = [...routes, ...workers].filter(r => r?.provider.preset === 'zer0ne-engine').map(r => r!.model.id);
		if (options.kind === 'production' && new Set(localModels).size > 1 && workflow?.enabled) throw new Error('This workflow requires several zer0ne Engine models at once. Choose one local model for every role, or use independent API endpoints.');
		if (options.kind === 'production' && [...routes, ...workers].some(r => r?.provider.auth && r.provider.auth !== 'apiKey')) throw new Error('Production benchmarks currently require API-key or local providers. Use Core mode for a signed-in account.');
		const release = acquireRuntimeLease(this.dir);
		if (!release) throw new Error('Another project window is running the benchmark.');
		const stop = new AbortController();
		this.running = { id: '', spec: '', model: '', done: 0, total: (cases.length * options.trials + judged.length) * specs.length * options.profiles.length, current: '', stop };
		void (async () => {
			try {
				for (let i = 0; i < routes.length && !stop.signal.aborted; i++) for (const name of options.profiles) {
					if (stop.signal.aborted) break;
					const { provider, model, apiKey } = routes[i]!;
					const profile = evalProfile(name, options.kind, settings, provider, model, await this.ctx.store.getEffort?.(provider.id, model.id));
					const suite = createHash('sha256').update(JSON.stringify({ cases, workflow, profile: profile.id })).digest('hex');
					const run: BenchmarkRun = { id: randomUUID(), at: Date.now(), spec: specs[i]!, model: model.name || model.id, provider: provider.name, categories: wanted, summary: summarize([]), cases: [], profile: { name, id: profile.id, kind: profile.kind, tools: profile.tools }, trials: options.trials, suite, contextWindow: model.contextWindow };
					if (workflow?.enabled) run.profile!.tools = 'auto';
					Object.assign(this.running!, { id: run.id, spec: run.spec, model: run.model, current: cases[0]?.id ?? judged[0]?.id ?? '' });
					this.publish();
					const reports: EvalReport[] = [];
					try {
						const providers: ProductionConfiguration['providers'] = [];
						if (options.kind === 'production') for (const route of [routes[i]!, ...workers]) {
							if (!route || providers.some(p => p.provider.id === route.provider.id)) continue;
							providers.push({ provider: await this.d.productionProvider?.(route.provider, route.model.id, stop.signal) ?? route.provider, apiKey: route.apiKey });
						}
						if (cases.length) await runEvals(cases, {
							profile: profile.request, profileId: profile.id, trials: options.trials, maxTokens: profile.request.maxTokens,
							production: options.kind === 'production' ? async (task, root, signal) => {
								const result = await runProduction(root, task.prompt, { providers, primary: provider.id, model: model.id, effort: profile.request.effort, settings: profile.settings, workflow }, { engineDir: this.d.extension, signal, followUps: task.followUps });
								for (const a of result.attempts) await this.ctx.store.recordUsage({ t: a.startedAt, providerId: a.providerId ?? provider.id, model: a.model, tokensIn: a.usage?.input ?? 0, tokensOut: a.usage?.output ?? 0, tokensCached: a.usage?.cached, tokensCacheWrite: a.usage?.cacheWrite, usage: a.usage, attemptId: a.id, purpose: a.purpose, request: a, cost: a.cost, costKind: a.costKind, prices: a.prices, priceVersion: a.priceVersion });
								return result;
							} : undefined,
							provider: { baseUrl: provider.baseUrl, apiKey, apiFormat: provider.apiFormat, model: model.id },
							callModel: (options) => this.d.callModel(provider, apiKey, options),
							contextWindow: model.contextWindow,
							signal: stop.signal
						}, {
							quiet: true,
							onReport: (r) => {
								reports.push(r);
								const next = cases[Math.floor(reports.length / options.trials)];
								Object.assign(this.running!, { done: this.running!.done + 1, current: next?.id ?? '' });
								this.publish();
							}
						});
						// The same model as the goal judge, on records whose answer is known.
						if (judged.length && !stop.signal.aborted) {
							run.judge = await auditJudge(judged, async (c) => {
								const result = await this.d.callModel(provider, apiKey, { ...profile.request, model: model.id, system: GOAL_JUDGE_SYSTEM, messages: [{ role: 'user', content: judgeMessage(c.goal, c.record) }], maxTokens: 800, signal: stop.signal, requestContext: { purpose: 'helper' } } as StreamOptions);
								return result.toolCalls?.length ? undefined : parseGoalVerdict(result.text);
							}, stop.signal, (c) => {
								const next = judged[judged.indexOf(c) + 1];
								Object.assign(this.running!, { done: this.running!.done + 1, current: next?.id ?? '' });
								this.publish();
							});
						}
					} catch (error) { if (!stop.signal.aborted) run.error = redactSecrets(error instanceof Error ? error.message : String(error)).text.slice(0, 400); }
					run.stopped = stop.signal.aborted;
					run.summary = summarize(reports);
					run.cases = reports.map((r) => ({ id: r.id, trial: r.trial, metrics: r.metrics, category: r.category, pass: r.pass, failures: r.failures.slice(0, 3).map((f) => redactSecrets(f).text.slice(0, 300)), steps: r.steps, toolCalls: r.toolCalls, ms: r.ms, cost: r.cost }));
					if (reports.length || run.judge) this.record(run);
				}
				this.ctx.status(stop.signal.aborted ? 'Benchmark stopped. Finished tasks are saved.' : 'Benchmark finished. Open Settings → Features → Benchmark for the scorecard.', '');
			} catch (error) {
				this.ctx.status(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
			} finally {
				this.running = undefined;
				release();
				this.publish();
			}
		})();
	}
}
