import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { beginExecution } from '../core/executionJournal';
import { recordEvidence, refreshEvidence, type VerificationReceipt } from './taskEvidence';
import { checkConfiguration, projectFingerprint, verificationStages } from '../tools/projectChecks';
import type { ChatMessage } from '../chatClient';
import { agentTools } from './subagentRuntime';
import type { AgentDef } from '../tools/plugins';
import { pairPendingToolResults } from '../core/toolCalls';
import { runCore, projectInstructions, type CoreProvider, type CoreRun } from '../core/loop';
import { CoreTools } from '../core/tools';
import { createWorktree, removeWorktree, listWorktrees } from '../worktrees';
import { runHooks } from '../tools/hooks';
import type { HookConfig } from '../providerStore';
import type { CommandContext } from '../tools/command';
import { REPORT_STATUS_RULE } from './reportStatus';

/**
 * Parallel writing subagents, the Codex / omp way: every writer gets its own
 * git worktree on a zer0ne/<task> branch, so several can edit, build and
 * test at the same time without touching each other or your files. When a
 * writer finishes, its edits remain unstaged in its checkout; the main agent (or
 * you) reviews the diff and merges it into the workspace with one approval
 * — or discards it.
 */

export interface WriterJob {
	comparisonId?: string;
	rootTaskId?: string;
	workflow?: boolean;
	allowedTools?: string[];
	verification?: VerificationReceipt[];
	ownerPid?: number;
	sessionId?: string;
	prompt?: string;
	messages?: ChatMessage[];
	inbox?: string[];
	steering?: string[];
	/** How many `steering` entries the loop drained into its transcript (drives the pane's receipts). */
	steerRead?: number;
	providerId?: string;
	providerName?: string;
	model?: string;
	agentName?: string;
	cleanupError?: string;
	interrupted?: boolean;
	recovered?: boolean;
	root?: string;
	denyPaths?: string;
	id: string;
	description: string;
	status: 'starting' | 'running' | 'done' | 'failed' | 'merged' | 'discarded';
	branch?: string;
	dir?: string;
	base?: string;
	report?: string;
	error?: string;
	steps: number;
	stat?: { files: number; added: number; removed: number };
	startedAt: number;
	endedAt?: number;
}

function git(cwd: string, args: string[], input?: string, difference = false): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out, stderr) => (err && !(difference && err.code === 1) ? reject(new Error(String(stderr || err.message).trim().slice(0, 600))) : resolve(String(out))));
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

export const WRITER_PROMPT =
	'You are a writing subagent working in your own isolated git worktree (a separate checkout of the project on its own branch). ' +
	'Do the task completely, follow the project instructions and protected-file rules, verify it (build/tests), then answer with a short report: what you changed, which files, and how you verified it. Do not stage or commit. Your edits remain available for review. ' +
	REPORT_STATUS_RULE;

function canonical(file: string): string {
	let resolved: string;
	try { resolved = fs.realpathSync.native(file); } catch { resolved = path.resolve(file); }
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function sameWriterPath(a: string, b: string): boolean { return canonical(a) === canonical(b); }

export class WriterPool {
	prepareWorktree?: (directory: string, signal: AbortSignal) => Promise<void>;
	readonly jobs = new Map<string, WriterJob>();
	private seq = 0;
	private storage?: string;
	private journalStorage?: string;

	constructor(private readonly onChange: () => void) {}

	configure(storage: string, root: string): void {
		this.journalStorage = storage;
		this.storage = path.join(storage, 'writers', createHash('sha256').update(canonical(root)).digest('hex'));
		fs.mkdirSync(this.storage, { recursive: true });
		for (const name of fs.readdirSync(this.storage).filter(n => /^w[\w-]+\.json$/.test(n))) {
			try {
				const job = JSON.parse(fs.readFileSync(path.join(this.storage, name), 'utf8')) as WriterJob;
				if (!job.root || !sameWriterPath(job.root, root) || job.id + '.json' !== name || !job.sessionId || !Array.isArray(job.messages)) continue;
				if (job.status === 'starting' || job.status === 'running') {
					if (Number.isInteger(job.ownerPid) && job.ownerPid! > 0) { try { process.kill(job.ownerPid!, 0); continue; } catch {} }
					job.status = 'failed'; job.interrupted = true; job.error = 'Interrupted when the app closed. Inspect the worktree and resume explicitly.';
				}
				job.recovered = true;
				pairPendingToolResults(job.messages, 'Interrupted: this action may already have changed files. Inspect the worktree before repeating it.');
				this.jobs.set(job.id, job);
			} catch { /* A damaged task must not hide other recoverable worktrees. */ }
		}
	}

	private save(job: WriterJob): void {
		if (!this.storage) return;
		const file = path.join(this.storage, job.id + '.json'), temp = file + '.' + randomUUID() + '.tmp';
		try { fs.writeFileSync(temp, JSON.stringify(job)); fs.renameSync(temp, file); }
		finally { try { fs.unlinkSync(temp); } catch {} }
	}

	private changed(job: WriterJob): void { this.save(job); this.onChange(); }

	private lease(job: WriterJob): () => void {
		if (!this.storage) return () => {};
		const file = path.join(this.storage, job.id + '.lock'), token = randomUUID();
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
				return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch {} };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				let owner: { pid?: number };
				try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Writer ownership record could not be read. Inspect the task before resuming.'); }
				if (!Number.isInteger(owner.pid) || owner.pid! <= 0) throw new Error('Writer ownership record is invalid.');
				try { process.kill(owner.pid!, 0); }
				catch (dead) { if ((dead as NodeJS.ErrnoException).code === 'ESRCH' && attempt === 0) { fs.unlinkSync(file); continue; } }
				throw new Error('This writer is already active in another window. Wait for it to finish.');
			}
		}
		throw new Error('Could not acquire writer ownership.');
	}

	private async validateRecovered(job: WriterJob): Promise<void> {
		if (!job.recovered) return;
		if (!job.root || !job.dir || !job.branch?.startsWith('zer0ne/')) throw new Error('Recovered writer has no valid worktree.');
		const rel = path.relative(canonical(job.root) + '.worktrees', canonical(job.dir));
		if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw new Error('Recovered writer folder is outside its worktree directory.');
		if (!(await listWorktrees(job.root)).some(w => sameWriterPath(w.path, job.dir!) && w.branch === job.branch)) throw new Error('Recovered worktree is missing or its branch changed.');
	}

	steer(id: string, message: string): void {
		const job = this.jobs.get(id);
		if (!job || !['starting', 'running'].includes(job.status)) throw new Error('Only a running writer can receive an instruction.');
		if (!message.trim() || message.length > 8000 || (job.inbox?.length ?? 0) >= 20) throw new Error('Enter an instruction up to 8000 characters; at most 20 can be queued.');
		(job.inbox ??= []).push(message.trim());
		job.steering = [...job.steering ?? [], message.trim()].slice(-20);
		this.changed(job);
	}

	/** Start a writer; resolves with the finished job (the id is available right away via `job`). */
	start(o: {
		comparisonId?: string;
		baseRevision?: string;
		workflow?: boolean;
		allowedTools?: ReadonlySet<string>;
		journalStorage?: string;
		verificationSettings?: import('../providerStore').AgentSettings;
		resumeId?: string;
		sessionId?: string;
		providerId?: string;
		providerName?: string;
		agent?: AgentDef;
		denyPaths?: string;
		commandEnabled?: boolean;
		hooks?: HookConfig[];
		hookBase?: Record<string, unknown>;
		root: string;
		description: string;
		prompt: string;
		provider: CoreProvider;
		contextWindow?: number;
		profile?: import('../requestProfile').RequestProfile;
		maxTokens?: number;
		signal: AbortSignal;
		approveCommand: (command: string) => Promise<boolean>;
		requestCommandApproval?: CommandContext['requestApproval'];
		sandbox?: { storageDir: string; sourceFile: string; network: boolean };
		onStep?: (job: WriterJob, what: string) => void;
		callModel?: CoreRun['callModel'];
		requestContext?: CoreRun['requestContext'];
		onAttempt?: CoreRun['onAttempt'];
		toolScheduler?: CoreRun['toolScheduler'];
		toolConcurrency?: number;
		childConcurrency?: number;
		workflowConcurrency?: { key: string; limit: number };
		checkTaskBudget?: CoreRun['checkTaskBudget'];
	}): { job: WriterJob; done: Promise<WriterJob> } {
		const previous = o.resumeId ? this.require(o.resumeId) : undefined;
		if (previous && (!previous.root || !sameWriterPath(previous.root, o.root) || previous.sessionId !== o.sessionId)) throw new Error('Writer belongs to another project or chat.');
		const job: WriterJob = previous ?? { id: `w${++this.seq}-${randomUUID().slice(0, 8)}`, root: path.resolve(o.root), denyPaths: o.denyPaths, description: o.description, status: 'starting', steps: 0, startedAt: Date.now() };
		const release = this.lease(job);
		Object.assign(job, { sessionId: o.sessionId, rootTaskId: o.requestContext?.rootTaskId, workflow: o.workflow, prompt: job.prompt ?? o.prompt, providerId: o.providerId, providerName: o.providerName, model: o.provider.model, status: 'starting', error: undefined, interrupted: false, endedAt: undefined });
		job.ownerPid = process.pid;
		job.comparisonId ??= o.comparisonId;
		job.agentName = o.agent?.name ?? job.agentName;
		job.denyPaths = [...new Set([job.denyPaths, o.denyPaths].filter(Boolean))].join('\n');
		job.messages ??= [{ role: 'user', content: o.prompt }];
		if (previous) job.messages.push({ role: 'user', content: `${o.prompt}\nContinue in the existing worktree. Inspect current files first; interrupted actions may already have taken effect.` });
		this.jobs.set(job.id, job);
		try { this.changed(job); } catch (error) { release(); throw error; }
		const done = (async () => {
			try {
				o.checkTaskBudget?.(); o.signal.throwIfAborted();
				let top: string;
				try {
					top = path.resolve((await git(o.root, ['rev-parse', '--show-toplevel'])).trim());
					await git(o.root, ['rev-parse', '--verify', 'HEAD']);
				} catch { throw new Error('Isolated writers need a Git repository with an existing commit. Open a repository before starting a writer, or use the main chat.'); }
				const same = sameWriterPath(top, o.root);
				if (!same) throw new Error(`Open the repository root (${top}) before starting an isolated writer; subfolder projects are not supported for writer patches.`);
				await this.validateRecovered(job);
				const wt = previous && job.dir ? { path: job.dir, branch: job.branch } : await createWorktree(o.root, `${job.id}-${o.description}`, o.baseRevision);
				if (previous && !sameWriterPath((await git(wt.path, ['rev-parse', '--show-toplevel'])).trim(), wt.path)) throw new Error('The saved worktree is missing or no longer matches its folder.');
				job.branch = wt.branch;
				job.dir = wt.path;
				if (!previous) await this.prepareWorktree?.(wt.path, o.signal);
				job.base ??= (await git(wt.path, ['rev-parse', 'HEAD'])).trim();
				o.signal.throwIfAborted();
				job.status = 'running';
				this.changed(job);

				const invocation = new AsyncLocalStorage<ReturnType<typeof beginExecution> | undefined>();
				const tools = new CoreTools({
					root: wt.path,
					denyPaths: job.denyPaths,
					commandEnabled: o.commandEnabled,
					hideCommandSecrets: o.verificationSettings?.hideCommandSecrets,
					commandContext: {
						commandRulesRoot: o.root,
						settings: { commandTool: o.commandEnabled !== false, hideCommandSecrets: o.verificationSettings?.hideCommandSecrets !== false, sandboxDenyRead: o.verificationSettings?.sandboxDenyRead ?? '' },
						signal: o.signal,
						sandbox: o.sandbox ? { ...o.sandbox, mode: 'always' } : undefined,
						requestApproval: async req => {
							const automatic = req.projectRule !== 'ask' && !!req.sandboxed && !job.denyPaths?.trim();
							const handle = automatic ? { approved: true, auto: true, finish() {} } : o.requestCommandApproval
								? await o.requestCommandApproval(req)
								: { approved: await o.approveCommand(req.command ?? ''), auto: false, finish() {} };
							invocation.getStore()?.approval(handle.approved, !!handle.auto);
							return handle;
						}
					},
					signal: o.signal,
					// File edits stay in the isolated checkout; commands use the gate above.
					approve: async () => {
						invocation.getStore()?.approval(true, true);
						return true;
					},
					sandbox: o.sandbox
				});
				const definitions = agentTools(tools.defs().filter(d => d.name !== 'run_command' || o.commandEnabled !== false), o.agent, o.allowedTools, job.allowedTools), allowed = new Set(definitions.map(d => d.name));
				job.allowedTools = [...allowed]; this.changed(job);
				tools.defs = () => definitions;
				const execute = () => runCore({
					provider: o.provider,
					contextWindow: o.contextWindow,
					profile: o.profile,
					effort: o.profile?.effort,
					maxTokens: o.maxTokens,
					tools,
					messages: job.messages!,
					system: `${WRITER_PROMPT}\n${o.agent?.prompt ?? ''}\nWorktree: ${wt.path} (branch ${wt.branch}).${projectInstructions(o.root)}`,
					drainSteer: () => { const inbox = job.inbox?.splice(0) ?? []; if (inbox.length) { job.steerRead = (job.steerRead ?? 0) + inbox.length; this.changed(job); } return inbox; },
					onCheckpoint: () => this.save(job),
					executeTool: async (call, args, signal) => {
						const storage = o.journalStorage ?? this.journalStorage;
						const journal = storage && job.sessionId ? beginExecution(storage, { sessionId: job.sessionId, taskId: job.id, callId: call.id, tool: call.name }, JSON.stringify(args)) : undefined;
						return invocation.run(journal, async () => {
						try {
						o.checkTaskBudget?.();
						signal.throwIfAborted();
						if (!allowed.has(call.name)) { journal?.finish('refused'); return { output: 'This tool is not permitted for this writer.', summary: 'blocked by writer policy', error: true }; }
						const payload = { ...o.hookBase, workspace: wt.path, tool_name: call.name, tool_input: args };
						const pre = await runHooks(o.hooks ?? [], 'PreToolUse', payload, wt.path, call.name, signal);
						if (pre.blocked) { journal?.finish('refused'); return { output: `Blocked by a PreToolUse hook: ${pre.feedback}`, summary: 'blocked by hook', error: true }; }
						const command = call.name === 'run_command' && typeof args.command === 'string' ? args.command.trim() : '';
						let isCheck = false;
						try { isCheck = !!command && verificationStages(wt.path, job.denyPaths).some(s => s.command === command || s.command === 'npm run test' && command === 'npm test'); } catch { /* Unavailable check discovery does not prevent an otherwise permitted command. */ }
						const startedAt = Date.now();
						let fingerprint = '';
						if (isCheck) { try { fingerprint = await projectFingerprint(wt.path, job.denyPaths, signal); } catch { signal.throwIfAborted(); } }
						const result = await tools.run(call.name, args, signal);
						if (isCheck && result.exitCode !== undefined && job.sessionId) {
							job.verification = recordEvidence(job.verification ?? [], { id: randomUUID(), kind: 'verify', root: wt.path, fingerprint, configuration: checkConfiguration({ ...o.verificationSettings, denyPaths: job.denyPaths }), startedAt, finishedAt: Date.now(), stale: !fingerprint,
								status: result.error ? 'failed' : 'passed', scope: 'Worktree check: ' + command, stages: [{ name: 'Worktree check', command, code: result.exitCode, status: result.error ? 'failed' : 'passed', durationMs: Date.now() - startedAt, output: '' }] }, job.sessionId, job.id);
							this.changed(job);
						}
						const post = await runHooks(o.hooks ?? [], 'PostToolUse', { ...payload, tool_output: result.output.slice(0, 20_000) }, wt.path, call.name, signal);
						journal?.finish(signal.aborted ? 'unknown' : result.error ? 'failed' : 'completed');
						return post.feedback ? { ...result, output: `${result.output}\n\n[PostToolUse hook feedback]\n${post.feedback}` } : result;
						} catch (error) { journal?.finish('unknown'); throw error; }
						});
					},
					maxSteps: o.agent?.maxTurns ?? 100,
					signal: o.signal,
					callModel: o.callModel,
					requestContext: { ...o.requestContext, taskId: job.id },
					onAttempt: o.onAttempt,
					toolScheduler: o.toolScheduler,
					toolConcurrency: o.toolConcurrency,
					checkTaskBudget: o.checkTaskBudget,
					onToolStart: (call) => {
						job.steps++;
						this.save(job);
						o.onStep?.(job, call.name);
					}
				});
				const scheduled = () => o.toolScheduler ? o.toolScheduler.run('agents', o.childConcurrency ?? 4, false, o.signal, execute) : execute();
				const r = o.toolScheduler && o.workflowConcurrency ? await o.toolScheduler.run(o.workflowConcurrency.key, o.workflowConcurrency.limit, false, o.signal, scheduled) : await scheduled();
				job.report = r.text.trim() || '(no report)';
				await refreshEvidence(job.verification ?? [], { ...o.verificationSettings, denyPaths: job.denyPaths });
				o.signal.throwIfAborted();
				if (r.stopReason === 'cancelled') throw new Error('Stopped.');
				if (r.stopReason === 'max_turn_requests') throw new Error('Writer reached its turn limit. Inspect the partial changes and resume explicitly.');
				if (r.truncated) throw new Error('Writer report remained incomplete after automatic continuation. Inspect the changes before resuming.');
				job.stat = await this.stat(job);
				o.signal.throwIfAborted();
				job.status = 'done';
			} catch (e) {
				job.status = 'failed';
				job.error = e instanceof Error ? e.message : String(e);
			}
			job.endedAt = Date.now();
			this.changed(job);
			return job;
		})().finally(release);
		return { job, done };
	}

	private async stat(job: WriterJob): Promise<WriterJob['stat']> {
		if (!job.dir || !job.base) {
			return undefined;
		}
		const { patch } = await this.changes(job);
		const out = patch ? await git(job.dir, ['apply', '--numstat', '-'], patch) : '';
		let added = 0;
		let removed = 0;
		const rows = out.trim().split('\n').filter(Boolean);
		for (const r of rows) {
			const [a, d] = r.split('\t');
			added += Number(a) || 0;
			removed += Number(d) || 0;
		}
		return { files: rows.length, added, removed };
	}

	private async changes(job: WriterJob): Promise<{ patch: string; files: string[] }> {
		const files = (await git(job.dir!, ['diff', '--name-only', '-z', job.base!, '--'])).split('\0').filter(Boolean);
		const guard = new CoreTools({ root: job.dir!, denyPaths: job.denyPaths, approve: async () => false });
		const untracked = (await git(job.dir!, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
		for (const file of [...files, ...untracked]) guard.abs(file);
		let patch = await git(job.dir!, ['diff', '--binary', job.base!, '--']);
		for (const file of untracked) {
			patch += await git(job.dir!, ['diff', '--no-index', '--binary', '--', '/dev/null', file], undefined, true);
			files.push(file);
			if (patch.length > 64 * 1024 * 1024) throw new Error('Writer diff exceeds 64 MB.');
		}
		return { patch, files };
	}

	/** Tracked edits and new files, without staging or committing. */
	async diff(id: string): Promise<{ patch: string; files: string[] }> {
		const job = this.require(id);
		await this.validateRecovered(job);
		return this.changes(job);
	}

	/** Apply only a clean patch, leaving the index untouched; reports each file for Undo/Review. */
	async merge(id: string, root: string, record: (rel: string, before: string | null, after: string) => void, approvedPatch?: string, signal?: AbortSignal, denyPaths?: string, comparisonApproved = false): Promise<string> {
		signal?.throwIfAborted();
		const job = this.require(id);
		if (job.comparisonId && !comparisonApproved) throw new Error('Apply comparison candidates from Compare models after reviewing their diff.');
		if (job.root && !sameWriterPath(root, job.root)) throw new Error('Writer belongs to another project.');
		const release = this.lease(job);
		try {
			const { patch, files } = await this.diff(id);
			signal?.throwIfAborted();
			if (approvedPatch !== undefined && approvedPatch !== patch) throw new Error('Writer changes changed during approval. Review the new diff before merging.');
			if (!patch.trim()) {
				job.status = 'merged';
				this.changed(job);
				await this.cleanup(job, root);
				return 'The writer made no changes.';
			}
			const guard = new CoreTools({ root, denyPaths: [job.denyPaths, denyPaths].filter(Boolean).join('\n'), approve: async () => false });
			const before = new Map(files.map((f) => { const a = guard.abs(f); return [f, fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : null] as const; }));
			await git(root, ['apply', '--check', '--whitespace=nowarn', '-'], patch);
			signal?.throwIfAborted();
			for (const f of files) guard.abs(f);
			await git(root, ['apply', '--whitespace=nowarn', '-'], patch);
			for (const f of files) {
				const p = guard.abs(f);
				record(f, before.get(f) ?? null, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
			}
			job.status = 'merged';
			this.changed(job);
			await this.cleanup(job, root);
			return `Merged ${files.length} file${files.length === 1 ? '' : 's'} from ${job.branch}: ${files.join(', ')}.${job.cleanupError ? ` Cleanup needs attention: ${job.cleanupError}` : ''}`;
		} finally { release(); }
	}

	async discard(id: string, root: string, approvedPatch?: string): Promise<string> {
		const job = this.require(id);
		if (job.root && !sameWriterPath(root, job.root)) throw new Error('Writer belongs to another project.');
		const release = this.lease(job);
		try {
			await this.validateRecovered(job);
			if (approvedPatch !== undefined && (await this.diff(id)).patch !== approvedPatch) throw new Error('Writer changes changed. Review the new diff before discarding.');
			await this.cleanup(job, root);
			if (job.cleanupError) throw new Error(`Worktree retained: ${job.cleanupError}`);
			job.status = 'discarded';
			this.changed(job);
			return `Discarded writer ${id} (${job.description}).`;
		} finally { release(); }
	}

	private async cleanup(job: WriterJob, root: string): Promise<void> {
		job.cleanupError = undefined;
		try {
			if (job.dir) await removeWorktree(root, job.dir, true);
			if (job.branch) await git(root, ['branch', '-D', job.branch]);
		} catch (error) { job.cleanupError = error instanceof Error ? error.message : String(error); }
		this.changed(job);
	}

	private require(id: string): WriterJob {
		const job = this.jobs.get(id);
		if (!job) {
			throw new Error(`No writer "${id}". Known: ${[...this.jobs.keys()].join(', ') || 'none'}.`);
		}
		if (job.status === 'starting' || job.status === 'running') {
			throw new Error(`Writer ${id} is still working — wait for it with agent_result.`);
		}
		if (job.status === 'merged' || job.status === 'discarded') {
			throw new Error(`Writer ${id} was already ${job.status}.`);
		}
		return job;
	}

	/** Report text for agent_result. */
	describe(job: WriterJob): string {
		if (job.status === 'starting' || job.status === 'running') {
			return `(still working in ${job.dir ?? 'a new worktree'} — ${job.steps} steps so far; call agent_result again later)`;
		}
		if (job.status === 'failed') {
			return `Failed: ${job.error}`;
		}
		const s = job.stat;
		return (
			`${job.report}\n\n— Writer ${job.id} worked on branch ${job.branch} (${job.steps} steps)` +
			(s && s.files ? `: ${s.files} file${s.files === 1 ? '' : 's'} changed, +${s.added} −${s.removed}. Review with agent_diff, then agent_merge { "id": "${job.id}" } to bring it into the workspace, or agent_discard.` : ': no file changes.')
		);
	}
}
