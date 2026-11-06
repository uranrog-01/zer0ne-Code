import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { ChatMessage, StreamOptions, StreamResult } from '../chatClient';
import { runCore, type CoreProvider } from '../core/loop';
import { CoreTools } from '../core/tools';
import type { RequestAttempt } from '../requestDiagnostics';
import { attemptMetrics, percentile, type EvalMetrics } from './metrics';
import type { ProductionResult } from './production';
import type { RequestProfile } from '../requestProfile';

/**
 * The behavioral eval harness: run scripted agent tasks against the real tool
 * core (`runCore` + `CoreTools`) in a throwaway project folder and grade the
 * outcome. The model side is any `callModel` — a live provider through the
 * runner script, or a scripted fake for offline tests — so prompt, tool and
 * loop changes can be measured, not just type-checked.
 *
 * Cases live as JSON (see engine/eval/cases). Every expectation is checked
 * after the run; a case passes only when all of them hold.
 */

export interface EvalCase {
	id: string;
	/** bugfix, feature, refactor, explore, discipline, shell … — the scorecard groups by it. */
	category?: string;
	/** The user prompt the agent must act on. */
	prompt: string;
	followUps?: string[];
	/** Files seeded into the sandbox project before the run. */
	files?: Record<string, string>;
	/** Files written only after the run (graders such as hidden tests): the agent never sees them. */
	hidden?: Record<string, string>;
	/** Model ↔ tool round-trips (default 12). */
	maxSteps?: number;
	expect: Expectation[];
}

export type Expectation =
	| { kind: 'file'; path: string; contains?: string; notContains?: string; matches?: string; absent?: boolean }
	| { kind: 'reply'; contains?: string; matches?: string }
	/** Tool usage counts: min (default 1) and/or max calls of `name`. */
	| { kind: 'tool'; name: string; min?: number; max?: number }
	| { kind: 'steps'; max: number }
	/** A Node script in the project (usually a hidden one) must exit 0. */
	| { kind: 'check'; script: string };

export interface EvalReport {
	trial?: number;
	profile?: string;
	metrics?: EvalMetrics;
	id: string;
	category: string;
	pass: boolean;
	failures: string[];
	steps: number;
	toolCalls: number;
	text: string;
	usage: { input: number; output: number; cached: number };
	/** Dollars as the driver's metered caller reported them; unknown when any request had no price. */
	cost: number;
	costKnown: boolean;
	ms: number;
}

export interface EvalDriver {
	profile?: RequestProfile;
	profileId?: string;
	trials?: number;
	production?: (task: EvalCase, root: string, signal?: AbortSignal) => Promise<ProductionResult>;
	provider: CoreProvider;
	/** Omit for a live provider call. */
	callModel?: (options: StreamOptions) => Promise<StreamResult>;
	/** Per-request usage and price from a metered caller. */
	onAttempt?: StreamOptions['onAttempt'];
	/** The model's context window, for output budgeting (default 128k). */
	contextWindow?: number;
	maxTokens?: number;
	/** Extra system prompt (after the standard core prompt). */
	system?: string;
	signal?: AbortSignal;
	/** Command isolation for the agent's run_command calls. */
	sandbox?: { storageDir: string; sourceFile: string; network: boolean };
}

/** Graders run with the runtime running the harness (Node, or Electron as Node). */
const CHECK_TIMEOUT_MS = 30_000;

function runCheck(root: string, script: string): string | null {
	const abs = path.resolve(root, script);
	if (path.relative(root, abs).startsWith('..')) return `check ${script} is outside the project`;
	if (!fs.existsSync(abs)) return `check ${script} is missing`;
	const r = spawnSync(process.execPath, [abs], { cwd: root, timeout: CHECK_TIMEOUT_MS, encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
	if (r.error) return `check ${script} could not run: ${r.error.message}`;
	if (r.status === 0) return null;
	// The assertion line says what is wrong; Node's trailer ("Node.js v…") does not.
	const lines = `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const at = lines.findIndex((l) => /Error|assert/i.test(l));
	const why = (at >= 0 ? lines.slice(at, at + 2) : lines.slice(-2)).join(' · ');
	return `check ${script} failed${r.signal ? ` (${r.signal})` : ` (exit ${r.status})`}${why ? `: ${why.slice(0, 240)}` : ''}`;
}

const mkdtempEval = (name = 'zer0ne-eval-') => fs.mkdtempSync(path.join(os.tmpdir(), name));

/** Seed the case's files into a fresh sandbox project (pure; returns the root). */
export function seedProject(files: Record<string, string> | undefined): string {
	const root = mkdtempEval();
	for (const [rel, text] of Object.entries(files ?? {})) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, text);
	}
	return root;
}

/** Check one expectation against a finished run. Returns a failure description or null. */
export function grade(exp: Expectation, ctx: { root: string; text: string; toolCounts: Map<string, number>; steps: number }): string | null {
	if (exp.kind === 'file') {
		const abs = path.join(ctx.root, exp.path);
		if (exp.absent) return fs.existsSync(abs) ? `${exp.path} should not exist (the agent created it)` : null;
		if (!fs.existsSync(abs)) return `${exp.path} was not created`;
		const text = fs.readFileSync(abs, 'utf8');
		if (exp.contains && !text.includes(exp.contains)) return `${exp.path} is missing the expected text ${JSON.stringify(exp.contains.slice(0, 60))}`;
		if (exp.notContains && text.includes(exp.notContains)) return `${exp.path} still contains ${JSON.stringify(exp.notContains.slice(0, 60))}`;
		if (exp.matches && !new RegExp(exp.matches).test(text)) return `${exp.path} does not match /${exp.matches}/`;
		return null;
	}
	if (exp.kind === 'reply') {
		if (exp.contains && !ctx.text.includes(exp.contains)) return `the reply is missing ${JSON.stringify(exp.contains.slice(0, 60))}`;
		if (exp.matches && !new RegExp(exp.matches).test(ctx.text)) return `the reply does not match /${exp.matches}/`;
		return null;
	}
	if (exp.kind === 'tool') {
		const n = ctx.toolCounts.get(exp.name) ?? 0;
		if (exp.max !== undefined && n > exp.max) return `${exp.name} ran ${n}× (max ${exp.max})`;
		if (n < (exp.min ?? 1)) return `${exp.name} ran ${n}× (min ${exp.min ?? 1})`;
		return null;
	}
	if (exp.kind === 'steps') {
		return ctx.steps > exp.max ? `the task took ${ctx.steps} steps (max ${exp.max})` : null;
	}
	if (exp.kind === 'check') return runCheck(ctx.root, exp.script);
	return null;
}

/** Grade a whole case's expectations. */
export function gradeAll(c: EvalCase, ctx: { root: string; text: string; toolCounts: Map<string, number>; steps: number }): string[] {
	const failures: string[] = [];
	for (const exp of c.expect ?? []) {
		const why = grade(exp, ctx);
		if (why) failures.push(why);
	}
	return failures;
}

/** Run one case in a fresh sandbox folder; the caller removes the folder. */
export async function runEval(c: EvalCase, driver: EvalDriver): Promise<{ report: EvalReport; root: string }> {
	const started = Date.now();
	const root = seedProject(c.files);
	const tools = new CoreTools({
		root,
		// Evals need no human: every change the agent makes lands in the sandbox folder.
		approve: async () => true,
		commandEnabled: true,
		tokenSaver: true,
		sandbox: driver.sandbox
	});
	const toolCounts = new Map<string, number>();
	const usage = { input: 0, output: 0, cached: 0 };
	const spend = { cost: 0, known: true };
	const attempts: RequestAttempt[] = [];
	let toolFailures = 0;
	const metered: NonNullable<StreamOptions['onAttempt']> = (a) => {
		attempts.push(a);
		if (a.cost === undefined && !['subscription', 'local'].includes(a.costKind ?? '')) spend.known = false;
		else spend.cost += a.cost ?? 0;
		driver.onAttempt?.(a);
	};
	const report = (failures: string[], steps: number, text: string): EvalReport => ({
		id: c.id, category: c.category ?? 'general', pass: failures.length === 0, failures, steps,
		toolCalls: [...toolCounts.values()].reduce((a, b) => a + b, 0), text, usage, cost: spend.cost, costKnown: spend.known, ms: Date.now() - started, profile: driver.profileId, metrics: attemptMetrics(attempts, toolFailures, started)
	});
	try {
		const production = driver.production ? await driver.production(c, root, driver.signal) : undefined;
		if (production) {
			for (const a of production.attempts) { metered(a); usage.input += a.usage?.input ?? 0; usage.output += a.usage?.output ?? 0; usage.cached += a.usage?.cached ?? 0; }
			for (const tool of production.tools) { toolCounts.set(tool.name, (toolCounts.get(tool.name) ?? 0) + 1); if (tool.failed) toolFailures++; }
		}
		const messages: ChatMessage[] = [{ role: 'user', content: c.prompt }];
		const core = () => runCore({
			provider: driver.provider,
			tools,
			messages,
			maxSteps: c.maxSteps ?? 12,
			contextWindow: driver.contextWindow ?? 128_000,
			maxTokens: driver.maxTokens,
			effort: driver.profile?.effort,
			profile: driver.profile,
			system: driver.system,
			callModel: driver.callModel,
			signal: driver.signal,
			onAttempt: metered,
			executeTool: async (call, args, signal) => {
				toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
				const result = await tools.run(call.name, args, signal);
				if (result.error) toolFailures++;
				return result;
			}
		});
		let out = production ? { steps: production.steps, text: production.text, usage, stopReason: production.outcome === 'stopped' ? 'cancelled' : 'end_turn' } : await core();
		if (!production) for (const next of c.followUps ?? []) {
			if (out.stopReason !== 'end_turn') break;
			messages.push({ role: 'user', content: next });
			const prior = out;
			out = await core();
			out.steps += prior.steps;
			out.usage = { input: out.usage.input + prior.usage.input, output: out.usage.output + prior.usage.output, cached: out.usage.cached + prior.usage.cached };
		}
		usage.input = out.usage.input;
		usage.output = out.usage.output;
		usage.cached = out.usage.cached;
		if (out.stopReason === 'cancelled') return { report: report(['the run was cancelled'], out.steps, out.text), root };
		// Hidden graders arrive only now, so the agent could neither read nor edit them.
		for (const [rel, text] of Object.entries(c.hidden ?? {})) {
			const abs = path.join(root, rel);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, text);
		}
		const failures = gradeAll(c, { root, text: out.text, toolCounts, steps: out.steps });
		if (production && production.outcome !== 'completed') failures.push(`production turn ended ${production.outcome}`);
		if ('truncated' in out && out.truncated) failures.push('the response remained incomplete after automatic continuation');
		if (out.stopReason === 'max_turn_requests') failures.push(`the run hit the step limit (${c.maxSteps ?? 12})`);
		return { report: report(failures, out.steps, out.text), root };
	} catch (error) {
		return { report: report([`the run threw: ${error instanceof Error ? error.message : String(error)}`], 0, ''), root };
	}
}

/** Run cases one by one, sandbox per case, with summaries on stderr. */
export async function runEvals(cases: EvalCase[], driver: EvalDriver, opts: { keep?: boolean; quiet?: boolean; onReport?: (r: EvalReport) => void } = {}): Promise<EvalReport[]> {
	const reports: EvalReport[] = [];
	for (const c of cases) for (let trial = 1; trial <= Math.max(1, Math.min(10, driver.trials ?? 1)); trial++) {
		if (driver.signal?.aborted) break;
		const { report, root } = await runEval(c, driver);
		report.trial = trial;
		if (!opts.keep) fs.rmSync(root, { recursive: true, force: true });
		reports.push(report);
		opts.onReport?.(report);
		if (opts.quiet) continue;
		const mark = report.pass ? 'pass' : 'FAIL';
		process.stderr.write(`[eval] ${mark} ${report.id} (${report.steps} steps, ${Math.round(report.ms / 1000)}s${report.failures.length ? ` — ${report.failures[0]}` : ''})\n`);
	}
	return reports;
}

export interface EvalSummary {
	measurement?: { samples: number; cases: number; medianMs: number | null; p95Ms: number | null; firstUsefulMedianMs: number | null; costPerSuccess: number | null; requests: number; retries: number; truncations: number; toolFailures: number; cacheWrites: number; cacheKnown: number; warmMedianMs: number | null; coldMedianMs: number | null; confidence: [number, number] | null };
	total: number;
	passed: number;
	/** Share of cases passed, 0–1. */
	rate: number;
	byCategory: Record<string, { total: number; passed: number }>;
	steps: number;
	toolCalls: number;
	tokens: { input: number; output: number; cached: number };
	/** Cached share of input tokens, 0–1; null when the provider reported none. */
	cacheRate: number | null;
	cost: number;
	costKnown: boolean;
	ms: number;
}

/** The scorecard line for a set of reports. */
export function summarize(reports: EvalReport[]): EvalSummary {
	const byCategory: EvalSummary['byCategory'] = {};
	const tokens = { input: 0, output: 0, cached: 0 };
	let passed = 0, steps = 0, toolCalls = 0, cost = 0, ms = 0, costKnown = true;
	for (const r of reports) {
		const group = (byCategory[r.category] ??= { total: 0, passed: 0 });
		group.total++;
		if (r.pass) { group.passed++; passed++; }
		steps += r.steps; toolCalls += r.toolCalls; ms += r.ms; cost += r.cost; costKnown &&= r.costKnown;
		tokens.input += r.usage.input; tokens.output += r.usage.output; tokens.cached += r.usage.cached;
	}
	return {
		total: reports.length, passed, rate: reports.length ? passed / reports.length : 0, byCategory, steps, toolCalls, tokens,
		cacheRate: tokens.input > 0 && (tokens.cached > 0 || reports.some(r => (r.metrics?.cacheKnown ?? 0) > 0)) ? Math.min(1, tokens.cached / tokens.input) : null,
		cost, costKnown, ms,
		measurement: {
			samples: reports.length, cases: new Set(reports.map(r => r.id)).size, medianMs: percentile(reports.map(r => r.ms), 0.5), p95Ms: percentile(reports.map(r => r.ms), 0.95),
			firstUsefulMedianMs: percentile(reports.flatMap(r => r.metrics?.firstUsefulMs === undefined ? [] : [r.metrics.firstUsefulMs]), 0.5), costPerSuccess: costKnown && passed ? cost / passed : null,
			requests: reports.reduce((n, r) => n + (r.metrics?.requests ?? 0), 0), retries: reports.reduce((n, r) => n + (r.metrics?.retries ?? 0), 0),
			truncations: reports.reduce((n, r) => n + (r.metrics?.truncations ?? 0), 0), toolFailures: reports.reduce((n, r) => n + (r.metrics?.toolFailures ?? 0), 0),
			cacheWrites: reports.reduce((n, r) => n + (r.metrics?.cacheWrites ?? 0), 0), cacheKnown: reports.reduce((n, r) => n + (r.metrics?.cacheKnown ?? 0), 0),
			warmMedianMs: percentile(reports.flatMap(r => r.metrics?.cacheRequests.filter(a => a.state === 'warm').map(a => a.ms) ?? []), 0.5),
			coldMedianMs: percentile(reports.flatMap(r => r.metrics?.cacheRequests.filter(a => a.state === 'cold').map(a => a.ms) ?? []), 0.5), confidence: reports.length ? wilson(passed, reports.length) : null
		}
	};
}

/** Descriptive binomial interval; repeated cases are correlated, so this is not a superiority claim. */
function wilson(passed: number, n: number): [number, number] {
	const z = 1.96, p = passed / n, d = 1 + z * z / n, center = (p + z * z / (2 * n)) / d, spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
	return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

/** Every bundled case file in a folder, sorted by name. */
export function loadCaseDir(dir: string): EvalCase[] {
	const cases: EvalCase[] = [];
	for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) cases.push(...parseCases(fs.readFileSync(path.join(dir, name), 'utf8'), name));
	return cases;
}

/** Parse eval-case JSON files: one object, or an array, or { cases: [...] }. */
export function parseCases(text: string, source = 'case'): EvalCase[] {
	const raw = JSON.parse(text);
	const list = Array.isArray(raw) ? raw : raw?.cases;
	if (!Array.isArray(list)) throw new Error(`${source}: expected an array of cases or {"cases": [...]}`);
	return list.map((c, i) => {
		if (!c || typeof c.id !== 'string' || !c.id.trim()) throw new Error(`${source}[${i}]: every case needs an "id"`);
		if (typeof c.prompt !== 'string' || !c.prompt.trim()) throw new Error(`${source}[${i}] (${c.id}): needs a "prompt"`);
		if (c.followUps !== undefined && (!Array.isArray(c.followUps) || c.followUps.length > 20 || c.followUps.some((t: unknown) => typeof t !== 'string' || !t.trim()))) throw new Error(`${source}[${i}] (${c.id}): invalid follow-ups`);
		if (!Array.isArray(c.expect)) throw new Error(`${source}[${i}] (${c.id}): needs an "expect" array`);
		for (const exp of c.expect) {
			if (exp?.kind === 'file' && typeof exp.path !== 'string') throw new Error(`${source}[${i}] (${c.id}): a file expectation needs a "path"`);
			if (exp?.kind === 'tool' && typeof exp.name !== 'string') throw new Error(`${source}[${i}] (${c.id}): a tool expectation needs a "name"`);
			if (exp?.kind === 'check' && typeof exp.script !== 'string') throw new Error(`${source}[${i}] (${c.id}): a check expectation needs a "script"`);
		}
		const files = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, string> : undefined);
		return { id: c.id, category: typeof c.category === 'string' ? c.category : undefined, prompt: c.prompt, followUps: c.followUps, files: files(c.files), hidden: files(c.hidden), maxSteps: Number(c.maxSteps) || undefined, expect: c.expect };
	});
}
