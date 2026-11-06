import type { ProviderStore } from '../providerStore';
import type { Routed } from './subagentRuntime';

/**
 * An orchestrator + worker workflow: the chat's own model orchestrates (plans, delegates,
 * synthesizes); every delegated task runs on the worker model in its own conversation.
 * An optional read-only check runs before the turn finishes.
 */
export interface SubagentWorkflow {
	enabled: boolean;
	workerModel: string;
	/** The check's model. New setups use the worker model; older workflows kept their own. */
	reviewerModel: string;
	maxConcurrency: number;
	/** Whether a read-only check runs before the turn can finish. */
	review: boolean;
	/**
	 * The main agent only delegates: its tool list has no commands and no edits, so every piece of work goes
	 * to a worker and the chat stays free to answer. Enforced by the tool list, not asked of the model.
	 */
	dispatchOnly: boolean;
}

export function normalizeWorkflow(value: unknown): SubagentWorkflow {
	const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
	const model = (x: unknown) => (typeof x === 'string' ? x.slice(0, 1000) : '');
	// Workflows saved before the check could be turned off always ran it; layered ones stored it in roles.
	const roles = v.roles && typeof v.roles === 'object' ? v.roles as Record<string, unknown> : undefined;
	return {
		enabled: v.enabled === true,
		workerModel: model(v.workerModel),
		reviewerModel: model(v.reviewerModel),
		maxConcurrency: Number.isInteger(v.maxConcurrency) ? Math.min(10, Math.max(1, Number(v.maxConcurrency))) : 2,
		review: typeof v.review === 'boolean' ? v.review : roles ? roles.reviewer !== false : true,
		dispatchOnly: v.dispatchOnly === true
	};
}

/** The models the workflow will call: every one must be a usable pick before the workflow starts. */
export function workflowModels(profile: SubagentWorkflow): string[] {
	return [profile.workerModel, profile.review !== false ? profile.reviewerModel : ''];
}

/** Workflow picks are exact provider/model identities; unavailable picks never fall back silently. */
export async function workflowModel(store: ProviderStore, spec: string): Promise<Routed | undefined> {
	if (!spec) return undefined;
	const split = spec.indexOf('::');
	if (split < 1) throw new Error('Choose a configured provider and model for the workflow.');
	const provider = (await store.list()).find(p => p.id === spec.slice(0, split) && p.enabled);
	const model = provider?.models.find(m => m.id === spec.slice(split + 2) && m.enabled);
	if (!provider || !model || provider.apiFormat === 'acp' || provider.apiFormat === 'vscode-lm' || model.tools === false) throw new Error(`Workflow model "${spec}" is unavailable, disabled or does not support subagent tools.`);
	return { provider, model, apiKey: await store.getApiKey(provider.id) ?? '' };
}

export function workflowPrompt(profile: SubagentWorkflow): string {
	const review = profile.review !== false;
	return [
		'MULTI-AGENT WORKFLOW is enabled for this chat under Full Access.',
		profile.dispatchOnly
			? [
				'You are the dispatcher: you talk with the user and route work, and you cannot run commands or change files yourself. Give every piece of work, however small, to a worker with task, one task per independent request. Start workers with background: true so you stay free to answer the user while they work.',
				'Never wait: worker reports, finished commands and the user\'s replies arrive by themselves as messages, so end your turn when nothing is left to route instead of waiting on agent_result or command_output.',
				'A brief is the user\'s own words, quoted in full, plus only routing facts (which earlier agent, thread or files the user pointed at, an explicit constraint or hold from the user) in at most 30 words of your own. Do not add implementation plans, acceptance criteria, technical choices or checklists: the worker reads the code and decides how. Do not investigate code or logs yourself.',
				'A message that continues a worker\'s task goes to that worker with agent_send (a finished one resumes with its context), only when the user points at that work; a similar subject is a new task. When a worker asks a question that needs the user\'s decision, ask the user that one question as it is; keep routine progress to yourself.'
			].join(' ')
			: 'You are the orchestrator: plan the work, divide multi-part requests into independently owned tasks, delegate them to workers with task, compare the reports, and synthesize the result. Start only the workers that help the requested scope; several task calls in one turn run in parallel.',
		`Fan-out ceiling: ${profile.maxConcurrency} workers; the global child concurrency and shared task budget also apply. A task batch may contain up to 10 items.`,
		profile.dispatchOnly
			? 'Each worker has a fresh conversation and returns only its final report to you, so the user\'s exact words must be in its brief.'
			: 'Each worker has a fresh conversation and returns only its final report to you. Give complete briefs with relevant context, owned files, acceptance criteria and a concise report format.',
		'The host uses each named agent’s configured model when present, otherwise the workflow’s worker model. Do not invent model names or override these configured choices.',
		'Use two independently owned coding tasks when helpful. Named agents that can edit automatically run in isolated Git worktrees, including in parallel batches; unnamed researchers and the read-only check are read-only. Worktrees require a Git repository with a valid HEAD. Do not initialize Git, stage or commit unless the user explicitly requested that action.',
		'For isolated workers, inspect agent_diff and merge the intended changes through agent_merge before claiming they are applied to the project. Report unmerged work as pending.',
		review ? 'An independent read-only check reviews your final result before the turn can finish. Its feedback returns to you for a bounded repair round. A model review is not proof that tests passed; report actual check evidence and unavailable checks.' : 'No independent check is configured: verify your own result and report the actual check evidence and any checks you could not run.',
		'Full Access follows the existing approval policy. Preserve project instructions, protected paths, tool restrictions and the user’s scope.'
	].join('\n');
}

type ReviewVerdict = 'pass' | 'changes' | 'blocked';

const verdictOf = (word: string): ReviewVerdict => (word.toUpperCase() === 'PASS' ? 'pass' : word.toUpperCase() === 'CHANGES' ? 'changes' : 'blocked');

/**
 * Reads the reviewer's verdict. Models wrap it in markdown, open with prose, or
 * write only the word, so a labelled verdict counts anywhere in the report and a
 * bare verdict line counts near the top. A report with no verdict is still an error.
 */
export function reviewVerdict(report: string): ReviewVerdict {
	const text = String(report ?? '');
	const json = text.match(/"verdict"\s*:\s*"(pass|changes|blocked)"/i);
	if (json) return verdictOf(json[1]);
	for (const line of text.split(/\r?\n/)) {
		const labelled = line.match(/\bVERDICT\b[^A-Za-z0-9]{0,12}(PASS|CHANGES|BLOCKED)\b/i);
		if (labelled) return verdictOf(labelled[1]);
	}
	for (const line of text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5)) {
		const bare = line.match(/^[\s>*_#`~•·-]*(?:\*\*)?(PASS|CHANGES|BLOCKED)(?:\*\*)?[\s*_`~.!:•·-]*$/i);
		if (bare) return verdictOf(bare[1]);
	}
	throw new Error('The reviewer model did not state a verdict (PASS, CHANGES or BLOCKED). Retry the turn, or pick a stronger worker model in /workflow.');
}
