/*
 * Behavioral evals against a real model: `npm run evals`.
 *
 *   npm run evals -- --list                        show every case
 *   npm run evals -- --only write-greeting,edit   run selected cases
 *   npm run evals -- --category bugfix,refactor   run whole categories
 *   npm run evals -- --save                        also write the result to engine/eval/results
 *   npm run evals -- --keep                        keep the sandbox folders (debugging)
 *
 * The provider comes from one of (first hit wins):
 *   - ZER0NE_EVAL_CONFIG=/abs/path.json  { baseUrl, apiKey, model, apiFormat?, contextWindow? }
 *   - ZER0NE_EVAL_BASE_URL / ZER0NE_EVAL_API_KEY / ZER0NE_EVAL_MODEL
 *   - a local OpenAI-compatible server on http://127.0.0.1:11434/v1 (Ollama) with
 *     ZER0NE_EVAL_MODEL naming the model.
 * Every case runs in a throwaway temp project; nothing in a repository is touched,
 * and the report (pass/fail per case) is printed as JSON on stdout at the end.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const engine = path.join(__dirname, '..', 'engine');
const out = path.join(engine, 'out');
if (!fs.existsSync(path.join(out, 'eval', 'harness.js'))) {
	console.error('run-evals: the engine is not built — run "npm run engine" first.');
	process.exit(1);
}
const { runEvals, loadCaseDir, summarize } = require(path.join(out, 'eval', 'harness.js'));
const { evalProfile, evalOptions } = require(path.join(out, 'eval', 'profiles.js'));
const { runProduction } = require(path.join(out, 'eval', 'production.js'));

const loadCases = () => loadCaseDir(path.join(engine, 'eval', 'cases'));

function providerFromEnv() {
	if (process.env.ZER0NE_EVAL_CONFIG) {
		const cfg = JSON.parse(fs.readFileSync(process.env.ZER0NE_EVAL_CONFIG, 'utf8'));
		if (!cfg.baseUrl || !cfg.model) throw new Error('ZER0NE_EVAL_CONFIG needs at least baseUrl and model.');
		return { ...cfg, apiKey: cfg.apiKey ?? '', apiFormat: cfg.apiFormat ?? 'openai' };
	}
	if (process.env.ZER0NE_EVAL_BASE_URL && process.env.ZER0NE_EVAL_MODEL) {
		return { baseUrl: process.env.ZER0NE_EVAL_BASE_URL, apiKey: process.env.ZER0NE_EVAL_API_KEY ?? '', model: process.env.ZER0NE_EVAL_MODEL, apiFormat: process.env.ZER0NE_EVAL_FORMAT || 'openai' };
	}
	// Default: a local OpenAI-compatible server on the usual Ollama endpoint.
	return { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: process.env.ZER0NE_EVAL_MODEL || 'qwen3:8b', apiFormat: 'openai' };
}

async function main() {
	const argv = process.argv.slice(2);
	const cases = loadCases();
	if (argv.includes('--list')) {
		for (const c of cases) console.log(`${c.id}: ${c.expect.length} expectations${c.files ? `, ${Object.keys(c.files).length} seeded files` : ''}`);
		return;
	}
	const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
	const only = option('only'), category = option('category');
	const selected = cases.filter((c) => (!only || only.split(',').map((s) => s.trim()).includes(c.id)) && (!category || category.split(',').includes(c.category ?? 'general')));
	if (!selected.length) {
		console.error('run-evals: no cases matched' + (only ? ` --only ${only}` : '') + '. Use --list to see them.');
		process.exit(2);
	}
	const p = providerFromEnv();
	console.error(`run-evals: ${selected.length} case(s) on ${p.model} @ ${p.baseUrl}`);
	const options = evalOptions({ execution: argv.includes('--production') ? 'production' : 'core', profiles: (option('profiles') || 'current').split(','), trials: Number(option('trials') || 1) });
	const model = { id: p.model, enabled: true, smart: false, contextWindow: p.contextWindow, maxOutput: p.maxOutput, reasoningControl: p.reasoningControl, priceIn: p.priceIn, priceOut: p.priceOut };
	const provider = { id: 'eval', name: 'Benchmark provider', enabled: true, baseUrl: p.baseUrl, apiFormat: p.apiFormat, models: [model] };
	const reports = [], profiles = [];
	for (const name of options.profiles) {
		const profile = evalProfile(name, options.kind, p.settings || {}, provider, model, p.effort); profiles.push({ name, id: profile.id, kind: profile.kind });
		reports.push(...await runEvals(selected, { provider: { baseUrl: p.baseUrl, apiKey: p.apiKey, apiFormat: p.apiFormat, model: p.model }, contextWindow: p.contextWindow, maxTokens: p.maxOutput, profile: profile.request, profileId: profile.id, trials: options.trials,
			production: options.kind === 'production' ? (task, root, signal) => runProduction(root, task.prompt, { providers: [{ provider, apiKey: p.apiKey }], primary: provider.id, model: p.model, effort: profile.request.effort, settings: profile.settings }, { engineDir: engine, signal, timeoutSeconds: Number(option('timeout') || 180), followUps: task.followUps }) : undefined
		}, { keep: argv.includes('--keep') }));
	}
	const failed = reports.filter((r) => !r.pass);
	const summary = summarize(reports);
	const result = { at: new Date().toISOString(), model: p.model, profiles: profiles.map(profile => ({ ...profile, summary: summarize(reports.filter(r => r.profile === profile.id)) })), total: reports.length, failed: failed.length, summary, reports };
	console.log(JSON.stringify(result, null, 2));
	const pct = (n) => `${Math.round(n * 100)}%`;
	console.error(`\nScore ${summary.passed}/${summary.total} (${pct(summary.rate)}) · ${summary.steps} steps · ${summary.toolCalls} tool calls · ${Math.round(summary.ms / 1000)}s` +
		` · ${summary.tokens.input + summary.tokens.output} tokens${summary.cacheRate === null ? '' : ` · cache ${pct(summary.cacheRate)}`}`);
	for (const [name, g] of Object.entries(summary.byCategory)) console.error(`  ${name.padEnd(11)} ${g.passed}/${g.total}`);
	if (argv.includes('--save')) {
		// Results stay out of the package: compare a change by running before and after it.
		const dir = path.join(engine, 'eval', 'results');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${result.at.replace(/[:.]/g, '-')}-${p.model.replace(/[^\w.-]+/g, '_').slice(0, 60)}.json`);
		fs.writeFileSync(file, JSON.stringify(result, null, 2));
		console.error(`Saved ${path.relative(process.cwd(), file)}`);
	}
	if (failed.length) process.exit(1);
}

main().catch((e) => {
	console.error('run-evals failed:', e && e.stack ? e.stack : e);
	process.exit(1);
});
