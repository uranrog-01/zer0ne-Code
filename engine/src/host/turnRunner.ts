import * as path from 'path';
import { ChatMessage, MessageImage, StreamResult, ToolDef } from '../chatClient';
import type { ExtensionContext } from 'vscode';
import { AgentSettings, Approval, ModelEntry, ProviderConfig, ProviderStore, StoredMessage, accountProblem, agentFailureText, newId, trimForStorage } from '../providerStore';
import { ApprovalHandle, ApprovalRequest, DISPATCH_TOOLS, ToolContext, workspaceRoot } from '../tools/agentTools';
import type { LocalImageRequest, LocalImageResult } from '../tools/imageSpec';
import { runHooks } from '../tools/hooks';
import { COMPOUND } from '../tools/commandRules';
import { Transcript, TranscriptStore, forStorage, pruneToolOutputs, repairToolPairs } from '../transcript';
import { TurnAgents, type TurnAgentServices } from './turnAgents';
import { CacheGuard, countMessageTokens, countTokens, elideRepeat, spillText } from '../tools/tokenSaver';
import { LEAN_TOOLS, buildHistory, buildSystemPrompt, changedFilesReminder, mtimeOf, summaryMessage, type Identity } from './turnRequest';
import { wantsLean } from './localRouting';
import { outputBudget, runAgentTurn, withOverflowRecovery } from '../core/turn';
import { abortError, formatTokens, isAbort } from './turnHelpers';
import { buildToolContext, type ToolContextHosts } from './toolContext';
import type { HookConfig } from '../providerStore';
import type { BrowserAgent } from '../tools/browser';
import type { McpManager } from '../tools/mcp';
import type { SkillStore } from '../tools/skills';
import type { CacheWarmer } from './cacheWarmer';
import { ContextEstimator, responseLimit } from '../responseBudget';
import { requestProfileFor, type RequestProfile } from '../requestProfile';
import type { Compactor } from './compaction';
import type { ModelCaller } from './modelCaller';
import { KEY_PROBLEM } from './modelCaller';

import type { ToolExecutor } from './toolExecutor';
import type { UsageStats } from './usageStats';
import type { Verifier } from './verify';

import type { AcpTurnHooks } from '../acp/types';
import { trackTurn } from './turnTracker';
import { createTurnTrace } from './turnTrace';
import type { RequestAttempt } from '../requestDiagnostics';
import { usageSource } from '../usage';
import { TurnCheckpoint } from './turnRecovery';
import { workflowPrompt } from './subagentWorkflow';
import { TaskBudgetError, type TaskBudget, type TaskBudgets } from '../core/taskBudget';
import type { GoalKeeper } from './goal';
import { recordEvidence, refreshEvidence } from './taskEvidence';
import { endComputerSession } from '../tools/computerControl';

/**
 * One agent turn, start to finish: pick the model, compact if needed, build
 * the request (src/host/turnRequest.ts), run the loop (src/core/turn.ts) with
 * streaming, tools, approvals, verify-before-finish and overflow recovery,
 * then record usage, the exact transcript, the Undo checkpoint and run the
 * next queued message. Split out of ChatController, which keeps only the
 * state below and hands it over through TurnHost.
 */

/** Notification hooks observe done/error/attention signals; they can never block or slow the turn. */
function fireNotificationHook(h: { allHooks(): import('../providerStore').HookConfig[] }, sessionId: string, message: string, kind: 'done' | 'error' | 'attention'): void {
	const hooks = h.allHooks();
	if (!hooks.some((x) => x.enabled && x.event === 'Notification')) return;
	void runHooks(hooks, 'Notification', { session_id: sessionId, workspace: workspaceRoot()?.fsPath ?? '', message: String(message ?? '').slice(0, 2000), kind }, workspaceRoot()?.fsPath).catch(() => undefined);
}

export interface ActiveRun {
	turnId?: string;
	workflow?: boolean;
	abort: AbortController;
	sessionId: string;
	convo: StoredMessage[];
	/** Follow-ups to inject after the next tool results ("steer"). */
	steer: string[];
}

/** The last model request of a finished turn — what the cache warmer replays. */
export interface LastRequest extends RequestProfile {
	rootTaskId?: string;
	sessionId: string;
	turnId?: string;
	provider: ProviderConfig;
	model: ModelEntry;
	system: string;
	tools?: ToolDef[];
	promptTokens: number;
}

/** The composer's context popover: what filled the window, and how well it cached. */
export interface LastContext {
	used: number;
	source?: 'provider' | 'estimated';
	window?: number;
	parts?: Record<string, number>;
	cacheRate?: number;
	prefixStable?: number;
	cacheBreak?: string;
	cacheWaste?: number;
	warm?: string;
}

/** What a turn needs from the controller: its state (through setters) and its services. */
export interface TurnHost {
	taskBudgets?: TaskBudgets;
	store: ProviderStore;
	/** This host reports background commands that end to the chat (a long foreground command may move there). */
	backgroundReports?: boolean;
	/** A background run's permission is independent of the foreground mode. */
	mode?(): import('../providerStore').ChatMode;
	selection?(): ReturnType<ProviderStore['resolveSelection']>;
	context: ExtensionContext;
	sessionId(): string;
	messages(): StoredMessage[];
	activeRun(): ActiveRun | undefined;
	setRun(run: ActiveRun | undefined): void;
	setStreaming(state: { text: string; reasoning: string } | undefined): void;
	lastRequest(): LastRequest | undefined;
	setLastRequest(request: LastRequest): void;
	setLastContext(context: LastContext): void;
	/** The context figures of the last request (for the context_remaining tool). */
	lastContext?(): LastContext | undefined;
	nextQueued(): { text: string; plan: boolean; attachments?: import('./attachments').PendingAttachment[] } | undefined;
	status(message: string, kind?: 'ok' | 'error' | ''): void;
	/** A turn failed: remembered for Report a problem. */
	noteError?(message: string): void;
	postAll(message: Record<string, unknown>): void;
	sendState(): Promise<void>;
	scheduleState(): void;
	notify(kind: 'done' | 'attention', text: string): void;
	allHooks(): HookConfig[];
	requestApproval(convo: StoredMessage[], request: ApprovalRequest, rule: string | undefined): Promise<ApprovalHandle>;
	askUser(convo: StoredMessage[], text: string, options: string[], signal: AbortSignal): Promise<string>;
	searchCode(query: string, limit: number, signal?: AbortSignal): ReturnType<NonNullable<ToolContext['searchCode']>>;
	ocrFor(signal: AbortSignal): Promise<ToolContext['ocr'] | undefined>;
	/** image_generate on the local Studio (desktop / editor host). */
	generateImageLocal?(req: LocalImageRequest, onTick: (tick: { elapsed: number; status: string; queue?: number }) => void, signal: AbortSignal): Promise<LocalImageResult>;
	/** Image bundles the Studio can generate with now; empty when it cannot. */
	localImageBundles?(): Array<{ id: string; name: string }>;
	/** Every URL the user wrote in this chat (for the webfetch provenance guard). */
	urlProvenance(sessionId: string): ReadonlySet<string>;
	/** Open a published artifact file in the preview panel. */
	openArtifact(file: string, title: string): void;
	onFeatureReport?(report: import('../tools/projectChecks').ProjectReport): void;
	featureStorageDir?(): string;
	agentServices(): TurnAgentServices;
	handleSend(text: string, plan: boolean, attachments?: import('./attachments').PendingAttachment[]): Promise<void>;
	/** Start a turn that reads the reports of background agents that finished. */
	continueWithAgents(): Promise<void>;
	finishTurn(user: StoredMessage, snapshots: Map<string, string | null>, sessionId: string): Promise<void>;
	transcripts: TranscriptStore;
	compactor: Compactor;
	cacheGuard: CacheGuard;
	cacheStats: { input: number; cached: number };
	cacheWaste: Map<string, number>;
	imageCache: Map<string, MessageImage[]>;
	turnSnapshots: Map<string, Map<string, string | null>>;
	toolHosts: ToolContextHosts;
	skills: SkillStore;
	mcp: McpManager;
	browser: BrowserAgent;
	
	readonly models: ModelCaller;
	readonly verifier: Verifier;
	/** Goal mode: the judge that keeps the agent working until the chat's /goal is met. */
	readonly goals?: GoalKeeper;
	readonly tools: ToolExecutor;
	readonly usage: UsageStats;
	readonly warmer: CacheWarmer;
	
	
}

/**
 * Granular auto-approval in Agent mode (Cline-style). Returns the rule that
 * approved the request, or undefined when the user must decide.
 * Allowlisted commands must be a single simple command: anything chained,
 * piped, substituted or redirected always asks. An MCP tool the server itself
 * declared destructive always asks, whatever the MCP setting says.
 */
export function autoRule(request: Omit<Approval, 'id' | 'status'>, s: AgentSettings): string | undefined {
	if (request.kind === 'edit' || request.kind === 'write' || request.kind === 'patch') {
		return s.autoApproveEdits ? 'edits' : undefined;
	}
	if (request.kind === 'mcp') {
		// An explicit destructive hint from the server outranks the setting.
		return s.autoApproveMcp && !request.destructive ? 'MCP' : undefined;
	}
	if (request.kind === 'command') {
		// Leaving the sandbox is always the user's call (outside Full access).
		if (request.escalate || request.projectRule === 'ask') {
			return undefined;
		}
		if (request.projectRule === 'allow') {
			return 'project rules';
		}
		if (s.autoApproveCommands) {
			return 'commands';
		}
		// "Always sandbox": the sandbox is the safety net, so boxed commands run without a card.
		if (request.sandboxed && s.sandbox === 'always') {
			return 'sandbox';
		}
		const cmd = (request.command ?? '').replace(/\s+# background$/, '').trim();
		if (!cmd || COMPOUND.test(cmd)) {
			return undefined;
		}
		const allowed = s.commandAllowlist
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		return allowed.some((p) => cmd === p || cmd.startsWith(p + ' ')) ? 'allowlist' : undefined;
	}
	return undefined;
}

/** Full access approves everything, except a command the project's rules say must always ask. */
export function approvalRule(request: Omit<Approval, 'id' | 'status'>, mode: string, s: AgentSettings): string | undefined {
	if (request.kind === 'command' && request.projectRule === 'ask') return undefined;
	return mode === 'full' ? 'full' : autoRule(request, s);
}

export class TurnRunner {
	private readonly estimator = new ContextEstimator();
	constructor(private readonly h: TurnHost) {}

	/** Keep the provider's status dot honest: an account problem turns it red ("Sign in again"), a real answer green again. */
	private async recordHealth(provider: ProviderConfig, failure: string | null | undefined): Promise<void> {
		if (failure === null) return;
		const health = failure === undefined ? { ok: true, at: Date.now() } : accountProblem(failure) ? { ok: false, at: Date.now(), error: failure.slice(0, 10_000), signIn: true } : undefined;
		if (!health) return; // a network or model hiccup says nothing about the account
		if (health.ok && provider.health?.ok) return; // unchanged: no write per turn
		await this.h.store.update(provider.id, { health });
	}

	async run(user: StoredMessage, plan = false): Promise<void> {
		this.h.warmer.cancel();
		// Claim the chat before the first await. A second send must find the chat
		// busy instead of starting a turn in parallel with this one.
		const run: ActiveRun = { abort: new AbortController(), sessionId: this.h.sessionId(), convo: this.h.messages(), steer: [], turnId: user.id };
		this.h.setRun(run);
		try {
			await this.runTurn(run, user, plan);
		} catch (error) {
			if (user.turn?.outcome === 'completed') {
				user.turn.outcome = 'failed';
				this.h.status('The result could not be finalized. Inspect saved work before retrying.', 'error');
				this.h.notify('attention', 'the result could not be saved or finalized.');
			}
			throw error;
		} finally {
			if (this.h.activeRun() === run) {
				this.h.setRun(undefined);
			}
		}
	}

	private async runTurn(run: ActiveRun, user: StoredMessage, plan: boolean): Promise<void> {
		const { provider, model } = await (this.h.selection?.() ?? this.h.store.resolveSelection(run.sessionId));
		if (!provider || !model) {
			return;
		}
		const apiKey = (await this.h.store.getApiKey(provider.id)) ?? '';
		const profile = await this.h.store.getSubagentWorkflow(this.h.sessionId());
		const settings = this.h.store.getSettings();
		const mode = this.h.mode?.() ?? this.h.store.getMode();
		const workflow = profile.enabled && mode === 'full' && settings.subagents && !plan && model.tools !== false && provider.apiFormat !== 'acp' ? profile : undefined;
		const useTools = (mode !== 'chat' || plan) && model.tools !== false && !!workspaceRoot();
		const convo = run.convo;
		// Codex-style turn record: duration, model, files changed (+ Undo snapshots).
		user.turn = { startedAt: Date.now(), model: model.id, provider: provider.name, providerId: provider.id, ...(workflow ? { workflow: { ...workflow } } : {}) };
		if (useTools) user.turn.verification = [];
		let budget: TaskBudget | undefined;
		try { budget = user.rootTaskId ? this.h.taskBudgets?.resolve({ rootTaskId: user.rootTaskId }) : this.h.taskBudgets?.create(user.id, { cost: settings.taskBudgetCost, tokens: settings.taskBudgetTokens, requests: settings.taskBudgetRequests, seconds: settings.taskBudgetSeconds }, (snapshot) => {
			if (user.turn) user.turn.taskBudget = snapshot;
			this.h.scheduleState();
		}); } catch (error) {
			user.turn.outcome = 'stopped'; user.turn.endedAt = Date.now();
			convo.push({ id: newId('m'), role: 'assistant', content: error instanceof Error ? error.message : String(error) });
			await this.h.store.saveMessages(this.h.sessionId(), convo); await this.h.sendState(); return;
		}
		run.workflow = !!workflow;
		// A running turn holds its budget: the pool must not evict it mid-turn.
		this.h.taskBudgets?.pin(budget);
		const budgetAbort = () => run.abort.abort(budget?.controller.signal.reason);
		if (budget) {
			user.turn.taskBudget = budget.snapshot();
			budget.controller.signal.addEventListener('abort', budgetAbort, { once: true });
			if (budget.controller.signal.aborted) run.abort.abort(budget.controller.signal.reason);
		}
		const snapshots = new Map<string, string | null>();
		this.h.turnSnapshots.set(user.id, snapshots);
		let partial: { id: string; text: string; reasoning: string } | undefined;
		// How long the current step reasoned before its first answer text ("Thought for 12s").
		let reasoningMs: number | undefined;
		const checkpoint = new TurnCheckpoint(() => partial && (partial.text || partial.reasoning) ? [...convo, { id: partial.id, role: 'assistant', content: partial.text, reasoning: partial.reasoning || undefined, model: model.id }] : convo,
			messages => this.h.store.saveMessages(run.sessionId, messages),
			() => this.h.status('Recent progress could not be saved. The previous saved copy remains available.', 'error'));

		
		// (start a timer, reset per-turn state) before the model request runs.
		

		let tokensIn = 0;
		let tokensOut = 0;
		let tokensCached = 0;
		let modelStep = 0;
		const attempts: RequestAttempt[] = [];
		user.turn.attempts = attempts;
		// JSONL trace (ZER0NE_TRACE_DIR) and/or the OpenTelemetry export: every request, tool and outcome of this turn.
		const trace = createTurnTrace(undefined, run.sessionId, user.id, settings.otelEndpoint ? { endpoint: settings.otelEndpoint } : undefined);
		trace?.write({ kind: 'turn_start', promptChars: user.apiContent?.length ?? user.content.length, plan, model: model.id });
		const scheduleTimings = new Map<string, import('../core/toolScheduler').ScheduleTiming>();
		let savedTranscript: Transcript | undefined;
		// Subagents, background agents and isolated writers of this turn (src/host/turnAgents.ts).
		const agents = new TurnAgents(this.h.agentServices(), {
			workflow,
			thread: user.thread,
			sessionId: run.sessionId,
			convo,
			provider,
			model,
			apiKey,
			settings,
			budget,
			signal: run.abort.signal
		});
		let sentMessages: ChatMessage[] | undefined;
		let tracker: Awaited<ReturnType<typeof trackTurn>>;
		// The provider's health from this turn: undefined = it answered, a string = its error, null = stopped by the user (says nothing).
		let turnFailure: string | null | undefined;
		let completionReady = false;
		const planCardId = newId('t');
		try {
			await checkpoint.write();
			await this.h.sendState();
			const identity: Identity = { model: model.id, provider: provider.name };
			// The model actually answering (changes if a fallback model takes over).
			const active = { provider, model, apiKey };
			const effort = await this.h.store.getEffort(provider.id, model.id);
			// Local-tuned agent: a model on this computer gets the lean prompt, the core tools and a budget sized to its window.
			const lean = !workflow && useTools && wantsLean(settings, provider, model);
			let system = await buildSystemPrompt({ settings, identity, useTools, plan, user, store: this.h.store, skillCatalog: () => this.h.skills.promptCatalog(), lean });
			if (workflow) system += '\n\n' + workflowPrompt(workflow);
			// Context breakdown for the composer's context popover.
			const built = buildToolContext(settings, plan, useTools, this.h.toolHosts);
			const { chars } = built;
			const dispatchOnly = workflow?.dispatchOnly === true;
			const tools = lean && built.tools ? built.tools.filter((t) => LEAN_TOOLS.has(t.name)) : dispatchOnly && built.tools ? built.tools.filter((t) => DISPATCH_TOOLS.has(t.name)) : built.tools;
			const deferred = lean ? undefined : dispatchOnly && built.deferred ? new Map([...built.deferred].filter(([name]) => DISPATCH_TOOLS.has(name))) : built.deferred;
			if (lean && built.tools && tools && tools.length < built.tools.length) { chars.tools = JSON.stringify(tools).length; chars.mcp = 0; }
			const skillChars = lean ? 0 : chars.skills;
			const mcpChars = chars.mcp;
			const toolChars = chars.tools;
			// An ACP agent keeps its own context: nothing for us to compact.
			// The summary request replays this request's system prompt and tools, so
			// the provider serves the replayed conversation from its cache instead of
			// reading it again at full price.
			if (provider.apiFormat !== 'acp') await this.h.compactor.maybeCompact(convo, user, provider, model, apiKey, false, run.abort.signal, { system, tools, ...requestProfileFor(settings, provider, model, effort), cacheKey: `zer0ne-${run.sessionId}`, maxTokens: responseLimit(model) }).catch((e) => {
				if (isAbort(e)) {
					throw e;
				}
			});
			const summary = await this.h.store.getSummary(run.sessionId);
			const summaryEntry = summary?.text ? summaryMessage(summary.text) : undefined;
			const metaChars = summaryEntry?.content.length ?? 0;
			// Exact transcript (append-only → prompt-cache friendly, nothing forgotten);
			// the lossy rebuild is only the seed for sessions without one.
			const exact = settings.exactHistory;
			const prefixReasons: string[] = [];
			let transcript: Transcript | undefined = exact ? this.h.transcripts.load(run.sessionId) : undefined;
			// Older saved transcripts carried their summary in the system prompt.
			// Migrate once and shift retry marks along with the inserted entry.
			if (transcript && summaryEntry && transcript.summaryUpTo !== summary?.upTo) {
				transcript.entries.unshift(summaryEntry);
				for (const id of Object.keys(transcript.marks)) transcript.marks[id]++;
				transcript.summaryUpTo = summary?.upTo;
			}
			let apiMsgs: ChatMessage[];
			const userMsg: ChatMessage = { role: 'user', content: user.apiContent ?? user.content, images: this.h.imageCache.get(user.id) };
			if (transcript) {
				const mark = transcript.marks[user.id];
				if (mark !== undefined) {
					prefixReasons.push('retry: previous attempt removed');
					transcript.entries = transcript.entries.slice(0, mark); // retry: drop the old attempt
				}
				const spillRoot = workspaceRoot();
				const pruned = pruneToolOutputs(transcript.entries, undefined, undefined, (content, tool) => spillText(spillRoot?.scheme === 'file' ? spillRoot.fsPath : undefined, content, tool));
				if (pruned) {
					prefixReasons.push('old tool outputs pruned');
					this.h.status(`Pruned ${Math.round(pruned / 3500)}k tokens of old tool output from the context.`, '');
				}
				const reminder = changedFilesReminder(transcript);
				if (reminder) {
					prefixReasons.push('changed files appended to new context');
					userMsg.content = `${userMsg.content}\n\n${reminder}`;
				}
				transcript.marks[user.id] = transcript.entries.length;
				apiMsgs = [...repairToolPairs(transcript.entries), userMsg];
			} else {
				if (summary) prefixReasons.push('summary seeds rebuilt history');
				apiMsgs = buildHistory(convo, user, model, system.length + metaChars, summary?.upTo, this.h.imageCache, lean);
				if (summaryEntry) apiMsgs.unshift(summaryEntry);
				if (exact) {
					transcript = { v: 1, entries: [], marks: { [user.id]: apiMsgs.length - 1 }, reads: {}, summaryUpTo: summary?.upTo };
				}
			}
			const turnTranscript = transcript;
			savedTranscript = transcript;
			sentMessages = apiMsgs;
			// Screenshots go to the model only when it is known to accept images.
			const vision = model.vision === true && provider.apiFormat !== 'vscode-lm';
			// The webfetch provenance guard works from a session-level set: every URL the
			// user has written in this chat (kept across turns; the guard is opt-in).
			const provenance = this.h.urlProvenance(run.sessionId);
			const imageLocal = this.h.generateImageLocal?.bind(this.h);
			const ctx: ToolContext = {
				checkTaskBudget: () => budget?.assertActive(),
				onToolTiming: (id, t) => scheduleTimings.set(id, t),
				store: this.h.store,
				taskId: user.id,
				sessionId: run.sessionId,
				settings,
				signal: run.abort.signal,
				requestApproval: (request) => this.h.requestApproval(convo, request, approvalRule(request, mode, settings)),
				sandbox: { mode: settings.sandbox, network: settings.sandboxNetwork, storageDir: this.h.context.globalStorageUri.fsPath, sourceFile: path.join(this.h.context.extensionUri.fsPath, 'media', 'sandbox', 'lowil.cs') },
				storageDir: this.h.context.globalStorageUri.fsPath,
				mediaDir: path.join(this.h.context.extensionUri.fsPath, 'media'),
				browser: this.h.browser,
				mcp: settings.mcp ? this.h.mcp : undefined,
				skills: settings.skills ? this.h.skills : undefined,
				askUser: (q, options) => this.h.askUser(convo, q, options, run.abort.signal),
				vision,
				readOnly: plan,
				urlProvenance: provenance,
				openArtifact: (file, title) => this.h.openArtifact(file, title),
				onFeatureReport: report => this.h.onFeatureReport?.(report),
				featureStorageDir: this.h.featureStorageDir?.(),
				searchCode: settings.codeIndex ? (query, limit) => this.h.searchCode(query, limit, run.abort.signal) : undefined,
				ocr: await this.h.ocrFor(run.abort.signal),
				imageGen: imageLocal
					? { local: (req, onTick) => imageLocal(req, onTick, run.abort.signal), installed: () => this.h.localImageBundles?.() ?? [] }
					: undefined,
				contextRemaining: () => {
					const last = this.h.lastContext?.();
					const window = last?.window ?? model.contextWindow;
					if (!window) return undefined;
					// Before the first answer there is no provider count; the transcript is the best estimate.
					const used = last?.used ?? countMessageTokens(convo);
					return { remaining: Math.max(0, window - used), window, used, source: last?.source };
				},
				onRead: (relPath) => turnTranscript && (turnTranscript.reads[relPath] = mtimeOf(relPath)),
				recordChange: (relPath, before) => {
					if (!snapshots.has(relPath)) {
						snapshots.set(relPath, before);
					}
					if (turnTranscript && relPath in turnTranscript.reads) {
						turnTranscript.reads[relPath] = mtimeOf(relPath); // the agent knows its own edits
					}
					verify.edits++;
				},
				dispatchOnly: dispatchOnly || undefined,
				backgroundReports: this.h.backgroundReports === true && settings.commandNotices
			};
			agents.attach(ctx);
			// ACP agents (Claude, Antigravity, Cursor, OpenCode…) work on their own: zer0ne lends them approvals, file access, cards and Undo.
			let acpHooks: AcpTurnHooks | undefined;
			const root = workspaceRoot()?.fsPath;
			if (provider.apiFormat === 'acp' && root) {
				const { makeAcpHooks } = await import('./acpBridge');
				tracker = await trackTurn(root).catch(() => undefined);
				const rule = (r: ApprovalRequest) => approvalRule(r, mode, settings);
				acpHooks = makeAcpHooks({
					cwd: root,
					chatId: run.sessionId,
					convo,
					settings,
					planMode: plan || mode === 'chat',
					eventUndo: !tracker,
					requestApproval: (r) => this.h.requestApproval(convo, r, rule(r)),
					rule,
					recordChange: (rel, before, after) => ctx.recordChange?.(rel, before, after),
					scheduleState: () => this.h.scheduleState(),
					status: (m) => this.h.status(m, ''),
					onTodos: (todos) => {
						let card = convo.find((m) => m.id === planCardId);
						if (!card) {
							card = { id: planCardId, role: 'assistant', kind: 'tool', content: '', tool: { name: 'todo', arg: 'plan', status: 'done', summary: '' } };
							convo.push(card);
						}
						card.todos = todos;
						this.h.scheduleState();
					}
				});
			}
			// Auto-verify state: re-check only when there were new edits; at most 2 fix rounds.
			const verify = { edits: 0, checked: 0, rounds: 0 };
			ctx.onFeatureReport = report => {
				user.turn!.verification = recordEvidence(user.turn!.verification ?? [], report, run.sessionId, user.id);
				this.h.onFeatureReport?.(report);
				if (report.kind === 'verify' && report.finishedAt && report.status === 'passed' && !report.stale && report.root === workspaceRoot()?.fsPath) verify.checked = verify.edits;
			};
			const hooks = this.h.allHooks();
			const hookBase = { session_id: run.sessionId, workspace: workspaceRoot()?.fsPath ?? '' };

			// Prompt size in tokens (system + tool definitions are fixed for the turn; messages grow).
			const fixedTokens = countTokens(system) + Math.ceil((toolChars + mcpChars) / 3.2);
			const promptTokens = () => this.estimator.estimate(`${active.provider.id}::${active.model.id}`, apiMsgs, fixedTokens);
			// The loop itself lives in src/core/turn.ts (shared with the CLI, ACP and writers).
			const outcome = await runAgentTurn({
				messages: apiMsgs,
				maxSteps: settings.maxSteps,
				maxContinuations: provider.apiFormat === 'acp' ? 0 : 2,
				onContinue: (count) => this.h.status(`Response allowance reached — continuing unfinished work (${count}/2).`, ''),
				signal: run.abort.signal,
				// An ACP agent works on its own: an empty reply can follow real work there.
				nudgeEmpty: provider.apiFormat !== 'acp',
				call: async (_step, onToolCall) => {
					modelStep = _step;
					const streamState = partial = { id: newId('m'), text: '', reasoning: '' };
					let thinkStart = 0;
					reasoningMs = undefined;
					this.h.setStreaming(streamState);
					this.h.cacheGuard.check(run.sessionId, system + '\u0000' + JSON.stringify(tools ?? []), apiMsgs);
					this.h.postAll({ type: 'streamStart' });
					let result: StreamResult;
					try {
						// Context overflow: trim old output (70% → 50% → 35% of the window) and call again.
						result = await withOverflowRecovery(() => this.h.models.callResilient(active, settings, run.abort.signal, streamState, (opts) => ({
							...opts,
							...requestProfileFor(settings, active.provider, active.model, effort),
							requestContext: { sessionId: run.sessionId, turnId: user.id, rootTaskId: budget?.id, step: _step, purpose: 'main', prefixReason: prefixReasons.join('; ') || undefined },
							onAttempt: (attempt) => { attempts.push(attempt); },
							system,
							cacheKey: `zer0ne-${run.sessionId}`,
							messages: apiMsgs,
							signal: run.abort.signal,
							tools,
							effort,
							cacheTtl: settings.cacheTtl,
							// Output budget: never ask for more output than the window has room left for.
							maxTokens: outputBudget(responseLimit(active.model), active.model.contextWindow, promptTokens()),
							onToolCall,
							acp: active.provider.apiFormat === 'acp' ? acpHooks : undefined,
							onText: (t) => {
								if (thinkStart && reasoningMs === undefined) reasoningMs = Date.now() - thinkStart;
								streamState.text += t;
								this.h.postAll({ type: 'delta', text: t });
							},
							onReasoning: (t) => {
								thinkStart ||= Date.now();
								streamState.reasoning += t;
								this.h.postAll({ type: 'delta', reasoning: t });
							}
						})), {
							messages: apiMsgs,
							windowTokens: active.model.contextWindow,
							systemChars: system.length + toolChars + mcpChars,
							streamed: () => !!(streamState.text.trim() || streamState.reasoning.trim()),
							onShrink: (n, tier) => this.h.status(`Context window full — trimmed ~${formatTokens(n)} tokens of old tool output and retried (${['70', '50', '35'][tier]}% of the window).`, ''),
							// The server runs a smaller window than we knew (a local server's n_ctx): remember it,
							// so output budgets and auto compact use the real size from now on.
							onWindow: (tokens) => {
								const { provider: p, model: m } = active;
								active.model = { ...m, contextWindow: tokens };
								void this.h.store.get(p.id).then((fresh) => fresh && this.h.store.update(p.id, { models: fresh.models.map((x) => (x.id === m.id ? { ...x, contextWindow: tokens } : x)) })).catch(() => undefined);
							}
						});
					} catch (error) {
						if (streamState.text.trim() || streamState.reasoning.trim()) {
							convo.push({ id: newId('m'), role: 'assistant', content: streamState.text, reasoning: streamState.reasoning.trim() || undefined, reasoningMs: thinkStart ? reasoningMs ?? Date.now() - thinkStart : undefined, model: active.model.id });
						}
						throw error;
					} finally {
						if (thinkStart && reasoningMs === undefined) reasoningMs = Date.now() - thinkStart;
						partial = undefined;
						this.h.setStreaming(undefined);
					}
					const promptEstimate = promptTokens();
					const stepIn = result.usage?.input ?? promptEstimate;
					const stepOut = result.usage?.output ?? countTokens(result.text + result.reasoning);
					if (usageSource(result.usage) === 'provider') this.estimator.observe(`${active.provider.id}::${active.model.id}`, promptEstimate, stepIn);
					tokensIn += stepIn;
					tokensOut += stepOut;
					// Compaction's anchor (Pi): the provider's own count of this request, in its own tokenizer.
					if (user.turn) user.turn.contextTokens = usageSource(result.usage) === 'provider' && stepIn > 0 ? stepIn + stepOut : undefined;
					if (usageSource(result.usage) === 'provider' && result.usage?.cached !== undefined) {
						this.h.cacheStats.input += result.usage.input;
						this.h.cacheStats.cached += result.usage.cached;
					}
					tokensCached += result.usage?.cached ?? 0;
					trace?.write({ kind: 'request', step: _step, providerId: active.provider.id, model: active.model.id, input: stepIn, output: stepOut, cached: result.usage?.cached, error: undefined, stopReason: result.stopReason });
					const request = attempts.at(-1)?.request;
					if (active.provider.apiFormat !== 'acp') this.h.setLastRequest({ sessionId: run.sessionId, turnId: user.id, rootTaskId: budget?.id, provider: active.provider, model: active.model, system, tools, ...requestProfileFor(settings, active.provider, active.model, effort), cacheKey: `zer0ne-${run.sessionId}`, maxTokens: responseLimit(active.model), promptTokens: stepIn });
					const msgChars = JSON.stringify(apiMsgs).length;
					const totalChars = Math.max(1, msgChars + system.length + toolChars + mcpChars);
					const pct = (n: number) => Math.round((n / totalChars) * 1000) / 10;
					this.h.setLastContext({
						used: stepIn + stepOut,
						source: usageSource(result.usage) === 'provider' ? 'provider' : 'estimated',
						window: active.model.contextWindow,
						parts: {
							messages: pct(Math.max(0, msgChars - metaChars)),
							systemTools: pct(toolChars),
							systemPrompt: pct(Math.max(0, system.length - skillChars)),
							skills: pct(skillChars),
							mcpTools: pct(mcpChars),
							meta: pct(metaChars)
						},
						cacheRate: this.h.cacheStats.input ? (this.h.cacheStats.cached / this.h.cacheStats.input) * 100 : undefined,
						prefixStable: request?.stability,
						cacheBreak: request?.changed
					});
					return result;
				},
				onAnswer: (result, cutOff, continuing) => {
					if (result.text.trim() || result.reasoning.trim()) {
						convo.push({
							id: newId('m'),
							role: 'assistant',
							content: result.text + (cutOff && !result.toolCalls.length && !continuing ? '\n\n_[Response remains incomplete after its continuation allowance. Say “continue” to resume.]_' : ''),
							reasoning: result.reasoning.trim() || undefined,
							reasoningMs: result.reasoning.trim() ? reasoningMs : undefined,
							model: active.model.id
						});
					}
				},
				// Check the work before finishing; failures go back to the model.
				beforeFinish: async (result) => {
					const feedback = useTools && !plan && provider.apiFormat !== 'acp' && verify.edits > verify.checked ? await this.h.verifier.verifyTurn(convo, [...snapshots.keys()], settings, verify, run.abort.signal, ctx) : undefined;
					if (feedback) return feedback;
					const review = workflow ? await agents.reviewFinal(ctx, user.content, result.text, [...snapshots.keys()]) : undefined;
					if (review) return review;
					return useTools && !plan && provider.apiFormat !== 'acp' ? this.h.goals?.check({ sessionId: run.sessionId, convo, files: [...snapshots.keys()], active, turnId: user.id, signal: run.abort.signal,
						runCheck: (command) => this.h.verifier.runGoalCheck(command, convo, settings, run.abort.signal, ctx) }) : undefined;
				},
				// Consecutive read-only calls (reads, searches, diagnostics, web, read-only subagents) run in parallel.
				parallelSafe: (call) => this.h.tools.parallelSafe(call, deferred),
				execute: async (call) => {
					const started = performance.now();
					const timing = { callId: call.id, name: call.name, step: modelStep, startedAt: Date.now(), durationMs: 0, outcome: 'failed' as 'completed' | 'failed' | 'cancelled', queueMs: undefined as number | undefined, runMs: undefined as number | undefined, pool: undefined as string | undefined };
					try {
						const result = await this.h.tools.executeCall(call, ctx, convo, hooks, hookBase, settings, deferred);
						timing.outcome = result.error ? 'failed' : 'completed';
						return result;
					}
					finally {
						timing.durationMs = performance.now() - started;
						Object.assign(timing, scheduleTimings.get(call.id));
						if (run.abort.signal.aborted) timing.outcome = 'cancelled';
						if (user.turn) (user.turn.toolTimings ??= []).push(timing);
						const card = convo.find((m) => m.tool?.callId === call.id);
						if (card?.tool) card.tool.durationMs = timing.durationMs;
					}
				},
				transform: (call, api) => (settings.tokenSaver ? elideRepeat(apiMsgs, call.name, api) : api),
				onBatch: () => this.h.scheduleState(),
				// Steering: follow-ups typed while the agent was working.
				drainSteer: () => {
					const steer = run.steer.splice(0);
					for (const s of steer) trace?.write({ kind: 'steer', chars: s.length });
					return steer;
				},
				// Background agents that finished while the turn runs: their reports join the next step.
				drainNotices: () => agents.drainNotices()
			});
			if (outcome.truncated) {
				turnFailure = 'The response remained incomplete after its continuation allowance.';
			} else if (outcome.stopReason === 'max_turn_requests') {
				turnFailure = null;
				convo.push({ id: newId('m'), role: 'assistant', content: `_Reached the limit of ${settings.maxSteps} steps for one turn. Say “continue” to keep going._`, model: model.id });
			} else if (outcome.stopReason === 'cancelled') {
				throw abortError();
			} else if (outcome.empty) {
				turnFailure = 'The model ended its turn without an answer.';
				this.h.notify('attention', 'the model ended without an answer.');
				fireNotificationHook(this.h, run.sessionId, 'The model ended its turn without an answer.', 'attention');
				convo.push({ id: newId('m'), role: 'assistant', content: '_The model ended its turn without an answer, even after a reminder. Use **Retry**, or pick a larger model — small local models often stop like this._', model: active.model.id });
			}
			// An agent can report its own failure as plain text ("Agent execution error: … (code 403): Verify your account"): show it as the error it is.
			const last = convo[convo.length - 1];
			if (provider.apiFormat === 'acp' && last?.role === 'assistant' && !last.isError && agentFailureText(last.content)) {
				last.isError = true;
				turnFailure = last.content;
				this.h.noteError?.(turnFailure);
			}
            if (turnFailure === undefined && !run.abort.signal.aborted) {
                const result = await runHooks(this.h.allHooks(), 'Stop', { session_id: run.sessionId, workspace: workspaceRoot()?.fsPath ?? '', last_message: convo.filter(m => m.role === 'assistant' && !m.kind && !m.local).pop()?.content.slice(0, 4000) ?? '' }, workspaceRoot()?.fsPath, undefined, run.abort.signal);
                if (result.log.length) convo.push({ id: newId('m'), role: 'assistant', content: '', kind: 'tool', tool: { name: 'hooks', arg: 'Stop', status: result.executions?.some(e => e.code !== 0) ? 'error' : 'done', summary: result.validationFailed ? 'Completion validation failed' : 'Completion hooks finished', detail: (result.executions ?? []).map(e => e.event + ' · exit ' + e.code + ' · ' + e.durationMs + 'ms\n' + e.stdout + '\n' + e.stderr).join('\n\n') } });
                if (result.validationFailed) throw new Error('Required completion validation failed. See the hook output before accepting this result.');
                completionReady = true;
            }
		} catch (error) {
			if (error instanceof TaskBudgetError || budget?.controller.signal.aborted) {
				const message = error instanceof TaskBudgetError ? error.message : budget!.snapshot().stopped ?? 'Task budget reached.';
				convo.push({ id: newId('m'), role: 'assistant', content: `${message} Work already completed is retained. Review it before starting another turn.`, model: model.id });
				turnFailure = null;
				this.h.status(message, '');
			} else if (isAbort(error) || run.abort.signal.aborted) {
				convo.push({ id: newId('m'), role: 'assistant', content: '_Stopped._', model: model.id });
				turnFailure = null;
			} else {
				turnFailure = error instanceof Error ? error.message : String(error);
				// A plan limit is not a bug: say what is safe (the checkpoints), what to do
				// (retry when the limit resets) instead of a bare provider error.
				const limited = KEY_PROBLEM.test(turnFailure) ? '_Rate limited or out of quota — not a bug in your request. Everything the agent changed is checkpointed: use **Undo / Restore** to review or roll back any point. Hit **Retry** when the limit resets (or pick another model)._\n\n' : '';
				const after = (error as { retryAfterMs?: number })?.retryAfterMs;
				convo.push({ id: newId('m'), role: 'assistant', content: limited + turnFailure, isError: true, retryAt: typeof after === 'number' && Number.isFinite(after) && after > 0 ? Date.now() + after : undefined });
				this.h.noteError?.(turnFailure);
				this.h.notify('attention', 'the agent hit an error.');
				void fireNotificationHook(this.h, run.sessionId, turnFailure.slice(0, 500), 'error');
			}
		} finally {
			// The trace records what ran from the turn's own records; it can never slow the turn.
			endComputerSession(this.h.context.globalStorageUri.fsPath, run.sessionId);
			for (const t of user.turn?.toolTimings ?? []) {
				trace?.write({ kind: 'tool', step: t.step, name: t.name, ms: t.durationMs, outcome: t.outcome, summaryChars: 0, startedAt: t.startedAt });
			}
			trace?.write({ kind: 'turn_end', outcome: turnFailure === null ? 'stopped' : turnFailure !== undefined ? 'failed' : 'completed', steps: modelStep, tokensIn, tokensOut });
			trace?.close();
			await checkpoint.stop();
			budget?.controller.signal.removeEventListener('abort', budgetAbort);
			// The turn is over: the budget may be evicted, and a stopped one is dropped.
			this.h.taskBudgets?.unpin(budget);
			await this.recordHealth(provider, turnFailure).catch(() => undefined);
			for (const m of convo) {
				if (m.approval?.execution === 'running') {
					m.approval.execution = 'error'; m.approval.failed = true;
					m.approval.result = run.abort.signal.aborted ? 'Interrupted before an execution result was recorded.' : 'The tool ended without reporting an execution result.';
				}
				if (m.tool?.status === 'running') {
					m.tool.status = 'error';
					m.tool.summary = 'stopped';
				}
			}
			if (this.h.activeRun() === run) {
				this.h.setRun(undefined);
			}
			this.h.setStreaming(undefined);
			if (user.turn) {
				if (budget) user.turn.taskBudget = budget.snapshot();
				user.turn.outcome = turnFailure === null ? 'stopped' : turnFailure !== undefined ? 'failed' : 'completed';
				user.turn.review = this.h.agentServices().registry.list(run.sessionId).filter(a => a.workflowRole === 'reviewer' && a.stats.startedAt >= user.turn!.startedAt).at(-1)?.reviewVerdict;
				const related = this.h.store.getUsageEvents().filter((e) => e.t >= user.turn!.startedAt && (e.turnId === user.id || e.parentTurnId === user.id)).flatMap((e) => e.request ? [e.request] : []);
				for (const attempt of related) if (!attempts.some((a) => a.id === attempt.id)) attempts.push(attempt);
				if (attempts.length) {
					const known = attempts.filter((a) => usageSource(a.usage) === 'provider');
					user.turn.attempts = attempts;
					user.turn.usage = { input: attempts.reduce((n, a) => n + (a.usage?.input ?? 0), 0), output: attempts.reduce((n, a) => n + (a.usage?.output ?? 0), 0),
						cached: attempts.reduce((n, a) => n + (a.usage?.cached ?? 0), 0), cacheWrite: attempts.reduce((n, a) => n + (a.usage?.cacheWrite ?? 0), 0),
						attempts: attempts.length, knownAttempts: known.length, cacheKnownAttempts: known.filter((a) => a.usage?.cached !== undefined).length,
						cost: attempts.every((a) => a.cost !== undefined) ? attempts.reduce((n, a) => n + a.cost!, 0) : undefined };
				} else user.turn.usage = { input: tokensIn, output: tokensOut, cached: tokensCached, cost: await this.h.usage.turnCost(provider, model.id, tokensIn, tokensOut, tokensCached) };
			}
			agents.end(); // background agents keep working; their reports come back as notifications
			// Save exactly what the model saw (images dropped), repaired if the run stopped mid-tool.
			if (savedTranscript && sentMessages) {
				try {
					savedTranscript.entries = repairToolPairs(sentMessages.map(forStorage));
					this.h.transcripts.save(run.sessionId, savedTranscript);
				} catch {
					this.h.status('The conversation transcript could not be saved. The previous saved copy remains available; resumed context may be incomplete.', 'error');
				}
			}
			// What the agent changed (by any means) joins Undo and the turn's file list.
			for (const c of (await tracker?.finish().catch(() => [])) ?? []) if (!snapshots.has(c.rel)) snapshots.set(c.rel, c.before);
			await this.h.finishTurn(user, snapshots, run.sessionId);
			await refreshEvidence(convo.flatMap(m => m.turn?.verification ?? []), this.h.store.getSettings());
			const ki = await this.h.store.keyInfoOf(provider.id).catch(() => undefined);
			if (!attempts.length && (tokensIn || tokensOut)) await this.h.store.recordUsage({ t: Date.now(), sessionId: run.sessionId, providerId: provider.id, model: model.id, tokensIn, tokensOut, tokensCached, keyIndex: ki?.index, keyHint: ki?.hint });
			// RAM parity with a restart: the store saves trimmed, so the live copy the UI and the
			// next state post carry gets the same trims instead of growing without bound.
			const live = trimForStorage(convo);
			for (let i = 0; i < convo.length; i++) convo[i] = live[i];
			await this.h.store.saveMessages(run.sessionId, convo);
			await this.h.sendState();
			if (completionReady && !run.abort.signal.aborted) {
				this.h.notify('done', 'the agent finished.');
				void fireNotificationHook(this.h, run.sessionId, 'The agent finished its turn.', 'done');
			}
			// Mods written during this turn (the /mod flow, or files you added) load
			// when the turn ends — Claude Code's reload-at-turn-end contract.
			
			// Mods: classic.Stop mirrors the shell-hook event; turn.complete can add a
			// line under the answer ({ text }) — the context-weather band's trigger.
			
			
		}
		// Queued follow-ups run next, in order.
		const next = run.sessionId === this.h.sessionId() ? this.h.nextQueued() : undefined;
		if (next) {
			await this.h.handleSend(next.text, next.plan, next.attachments ?? []);
		} else if (!run.abort.signal.aborted && run.sessionId === this.h.sessionId() && agents.hasNotices()) {
			// Background agents finished and the model has not read them yet: a short follow-up turn does.
			await this.h.continueWithAgents();
		} else if (!run.abort.signal.aborted && provider.apiFormat !== 'acp') {
			this.h.warmer.schedule(this.h.lastRequest());
		}
	}
}
