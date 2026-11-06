import * as vscode from 'vscode';
import { DESKTOP_CAPABILITIES, isDesktopHost, hostMessageAllowed, hostProviderAllowed, desktopServicesOwned } from './host/capabilities';
import { InteractiveTerminalHost } from './host/interactiveTerminal';
import { ProjectActionsHost } from './host/projectActions';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { checkConfiguration } from './tools/projectChecks';
import { normalizeWorkflow, workflowModel, workflowModels } from './host/subagentWorkflow';
import * as os from 'os';
import { MessageImage, StreamOptions, StreamResult, ToolDef, streamChat, modelApiFormat } from './chatClient';
import { TaskBudgets } from './core/taskBudget';
import { stableTools } from './prefixStability';
import { reasoningControl } from './reasoning';
import { variantControls } from './acp/reasoning';
import { streamLm } from './lmClient';
import { ModelCatalog } from './modelCatalog';
import { PRESETS } from './presets';
import {
	Approval,
	ChatMode,
	Memory,
	ModelEntry,
	ProviderConfig,
	ProviderStore,
	ProviderView,
	SessionMeta,
	StoredMessage,
	newId,
	normalizeProjectPath,
	projectPathKey
} from './providerStore';
import { RemoteServer, newRemoteToken, type RemoteDevice } from './remote';
import type { QuickTunnel, SshTunnel } from './tunnel';
import {
	ApprovalHandle,
	ApprovalRequest,
	buildToolDefs,
	resolveInWorkspace,
	runTool,
	workspaceRoot
} from './tools/agentTools';
import { BrowserAgent, findBrowser } from './tools/browser';
import { McpManager } from './tools/mcp';
import { SkillStore } from './tools/skills';
import { ExtensionCatalog } from './tools/extensionCatalog';
import { recoverInterrupted, recoverTranscript } from './host/turnRecovery';
import { runHooks, hookHistory } from './tools/hooks';
import { CheckpointStore } from './checkpoints';
import { ReviewManager } from './review';
import { glmOcr, ocrEndpoint } from './tools/documents';
import { denyGlobs } from './tools/deny';
import { TranscriptStore } from './transcript';
import { Compactor } from './host/compaction';
import { GoalKeeper, describeGoal, newGoal, parseGoalCommand } from './host/goal';
import { CodeIndex, EmbedTarget, embedTexts } from './tools/codeIndex';
import { looksSensitive, parseMemoryExtraction, worthRemembering } from './tools/memoryIndex';
import { localHelper } from './host/localRouting';
import { rgFiles } from './tools/ripgrep';
import { PluginHost, expandCommand } from './tools/plugins';
import { redactSecrets } from './tools/redact';
import { extractUrls } from './tools/web';
import { ArtifactHost } from './host/artifactsHost';
import { sweepStorage } from './host/storageSweep';
import { WriterPool } from './host/writers';
import { WriterReviewHost } from './host/writerReviewHost';
import { HunkReviewHost } from './host/hunkReview';
import { ModelComparisonsHost } from './host/modelComparisons';
import { BenchmarkHost } from './host/benchmarkHost';
import { AgentRegistry, agentMonitorPayload, noticeLabel, recordSteer, type TurnAgentServices } from './host/turnAgents';
import { backgroundNotice, backgroundOwnerOf, backgroundProc, onBackgroundExit } from './tools/moreTools';
import { AgentWatchdog } from './host/watchdog';
import { resumeHint } from './host/threads';
import { EventSources } from './host/eventSources';
import { ACTIVATED_PLUGINS_KEY, DISABLED_PLUGINS_KEY, DISABLED_SKILLS_KEY, ExtensionsHost, setPluginEnabled } from './host/extensionsHost';
import { SkillRecorderHost } from './host/skillRecorderHost';
import { ChatActionsHost } from './host/chatActions';
import { SIDE_SOURCES, SideChatHost } from './host/sideChat';
import { McpAppsHost } from './host/mcpAppsHost';
import { WorktreesHost } from './host/worktreesHost';
import { removeWorktree } from './worktrees';



import { ReportHost, issueLink } from './host/reportHost';
import { SubagentsHost } from './host/subagentsHost';



import { CacheGuard, saverTotals } from './tools/tokenSaver';
import { HostContext, HostFeature } from './host/context';
import { ENGINE_PRESET, LocalModelsHost } from './host/localModelsHost';
import { AppearanceHost } from './host/appearanceHost';
import { SandboxHost } from './host/sandboxHost';
import { setCommandRulesTrustDir } from './tools/commandRules';
import { addProjectInstruction } from './host/projectRules';
import { featureCatalog } from './host/featureRegistry';
import { FeatureToolsHost } from './host/featureToolsHost';
import { ComputerUseHost } from './host/computerUseHost';
import { refreshEvidence } from './host/taskEvidence';
import { readExecutions } from './core/executionJournal';
import { TerminalHost } from './host/terminalHost';


import { ProvidersHost } from './host/providersHost';
import { resolveMentions } from './host/mentions';
import { WorkspaceHost } from './host/workspaceHost';
import { MicHost } from './host/micHost';
import { FeaturesHealthHost } from './host/featuresHealth';
import { SessionsHost } from './host/sessionsHost';
import { ProjectsHost } from './host/projectsHost';
import { TurnHistory } from './host/turnHistory';
import { Attachments, PendingAttachment } from './host/attachments';
import { ModelCaller } from './host/modelCaller';
import { Verifier } from './host/verify';
import { ToolExecutor } from './host/toolExecutor';
import { UsageStats, usageCsv } from './host/usageStats';
import { RequestTrace } from './requestDiagnostics';
import { TurnRunner, type ActiveRun, type LastContext, type LastRequest, type TurnHost } from './host/turnRunner';
import { type ToolContextHosts } from './host/toolContext';
import { CacheWarmer } from './host/cacheWarmer';
import { SEEN_VERSION_KEY, whatsNewFor } from './host/whatsNew';

/**
 * The single owner of chat state. Surfaces — the sidebar webview (chat +
 * settings popup) and phones connected through Mobile Remote — post UI
 * messages in and receive `state` snapshots plus streaming deltas out.
 */

export interface Surface {
	kind: 'chat' | 'remote' | 'settings';
	post(message: Record<string, unknown>): void;
	/** Whether the user can currently see this surface (for notifications). */
	visible?(): boolean;
}

interface Queued {
	id: string;
	text: string;
	plan: boolean;
	attachments: PendingAttachment[];
}

type Incoming = Record<string, any> & { type?: string };

/** How long a model that failed all retries is bypassed in favour of the fallback. */
const BREAKER_MS = 3 * 60_000;
const REMOTE_TOKEN_KEY = 'aiChat.remoteToken';
const REMOTE_DEVICES_KEY = 'aiChat.remoteDevices';

/** State posts carry memory text, never its stored embedding vectors (large and internal). */
function publicMemory(memory: Memory): Omit<Memory, 'vec' | 'vecModel'> {
	const copy: Memory = { ...memory };
	delete copy.vec;
	delete copy.vecModel;
	return copy;
}

export class ChatController implements vscode.Disposable {
	private ptyHost!: InteractiveTerminalHost;
	private projectActions!: ProjectActionsHost;
	private readonly historyWindows = new Map<string, number>();
	private readonly surfaces = new Set<Surface>();
	private sessionId = '';
	private workflowEpoch = 0;
	private replayPreparing = false;
	private messages: StoredMessage[] = [];
	private run?: ActiveRun;
	private readonly promptStops = new Set<AbortController>();
	private turnHost!: TurnHost;
	
	
	
	private disposed = false;
	private localModelCalls: Promise<void> = Promise.resolve();
	private streaming?: { text: string; reasoning: string };
	private readonly approvals = new Map<string, (approved: boolean) => void>();
	/** "Always run" grants from approval cards: command → when granted. Session-scoped, in memory, exact command only. */
	private readonly sessionGrants = new Map<string, number>();
	private readonly questions = new Map<string, (answer: string | undefined) => void>();
	/** Files, folders and images waiting in the composer (src/host/attachments.ts). */
	private attachments!: Attachments;
	private queue: Queued[] = [];
	private queueEditing?: string;
	private readonly sessionQueues = new Map<string, typeof this.queue>();
	private mcpApps?: McpAppsHost;
	mcpAppDocument(key: string): string | undefined { return this.mcpApps?.document(key); }
	/** Vision payloads per user message id (kept in memory, never persisted). */
	private readonly imageCache = new Map<string, MessageImage[]>();
	/** On-disk copies of those images (<storage>/images/<messageId>-<n>.<ext>), so chat thumbnails survive a reload. */
	private imagesDir = '';
	private lastContext?: LastContext;
	/** Dollars lost to cache misses after a prefix break, per chat (Cache Guard's price tag). */
	private readonly cacheWaste = new Map<string, number>();
	/** The last model request of a finished turn — what the cache warmer replays. */
	private lastRequest?: LastRequest;
	private warmer!: CacheWarmer;
	/** What the tool list of a turn is built from, read when the turn starts. */
	private readonly toolHosts: ToolContextHosts = {
		mcpDefs: () => this.mcp.toolDefs(),
		agentDefs: () => this.plugins.agents(),
		skillCatalogChars: () => this.skills.promptCatalog(this.store.getSettings().skillCatalogChars).length
	};
	/** Per-turn original file contents (null = file did not exist) for Undo / Review. */
	private readonly turnSnapshots = new Map<string, Map<string, string | null>>();
	private readonly cacheStats = { input: 0, cached: 0 };
	/** URLs the user wrote per chat — the provenance set webfetch is held to (Settings → Agent). */
	private readonly provenance = new Map<string, Set<string>>();
	private artifacts?: ArtifactHost;
	
	
	
	/** The zer0ne command (CLI / ACP) installer. */
	
	/** "New task in a worktree" + the worktree picker. */
	readonly worktreesHost: WorktreesHost;
	/** Parallel writing subagents, each in its own git worktree. */
	readonly writers = new WriterPool(() => { this.scheduleState(); this.comparisons?.refresh(); });
	private readonly writerReview: WriterReviewHost;
	private readonly comparisons: ModelComparisonsHost;
	private readonly hunks: HunkReviewHost;
	/** Every subagent of every chat in this window (background agents outlive their turn). */
	readonly agentRuns = new AgentRegistry();
	
	
	/** Turns in progress (a turn is still finishing after `run` is cleared). */
	private turning = 0;
	/**
	 * Sends in flight. A send becomes a turn only after the provider, the hooks
	 * and the mentions are resolved; in that window there is no `run` yet, so
	 * this is what stops a second send from starting a parallel turn.
	 */
	private sending = 0;
	/** Prefix-stability check for prompt caching (Token Saver → Cache Guard). */
	private readonly cacheGuard = new CacheGuard();
	/** Original contents served to the diff editor (zer0ne-orig: scheme). */
	readonly originals = new Map<string, string>();
	/** Opens the full-size settings panel (set by extension.ts). */
	settingsOpener?: (section?: string) => void;
	settingsCloser?: () => void;
	/** Opens / closes the full-screen chat (set by extension.ts). */
	fullscreenToggler?: (on?: boolean) => void;
	/** @-mention file list, Git tools card, previews, opening files (src/host/workspaceHost.ts). */
	private workspace!: WorkspaceHost;
	private readonly ready: Promise<void>;
	private stateTimer?: NodeJS.Timeout;
	/** Microphone / dictation (src/host/micHost.ts). */
	private mic!: MicHost;
	/** Feature modules split out of this file (src/host/*); each handles its own messages. */
	private readonly features: HostFeature[];
	private readonly terminalHost: TerminalHost;
	private readonly featureTools: FeatureToolsHost;
	private readonly projects: ProjectsHost;
	private readonly appearance: AppearanceHost;
	private readonly localModels: LocalModelsHost;
	/** Errors shown this session (Report a problem lists the last ones). */
	private readonly recentErrors: Array<{ at: number; message: string }> = [];
	private report?: ReportHost;
	/** Extension version for Settings → About (read from package.json in the constructor). */
	private version = '?';
	
	private codeIdx?: { root: string; index: CodeIndex };
	private indexStatus = '';
	/** The user turn already processed by the automatic memory extractor, per chat. */
	private readonly memoryCapture = new Map<string, string>();

	readonly browser: BrowserAgent;
	readonly mcp: McpManager;
	readonly plugins: PluginHost;
	private readonly extensionCatalog = new ExtensionCatalog();
	private readonly checkpoints: CheckpointStore;
	private readonly transcripts: TranscriptStore;
	/** One agent turn, start to finish (src/host/turnRunner.ts). */
	private runner!: TurnRunner;
	/** Undo / Restore / Review of agent turns (src/host/turnHistory.ts). */
	private history!: TurnHistory;
	/** Auto compact: summary or pictures (src/host/compaction.ts). */
	private readonly compactor: Compactor;
	private readonly goals: GoalKeeper;
	private readonly reviews: ReviewManager;
	readonly skills: SkillStore;
	readonly remote!: RemoteServer;
	/** Mobile Remote from anywhere: the secure link (Cloudflare quick tunnel). */
	private readonly tunnel!: QuickTunnel;
	private readonly ssh!: SshTunnel;
	private tailscale?: { ip: string; dns?: string };
	private tailscaleAt = 0;

	/** Model calls with retries, fallbacks and the breaker (src/host/modelCaller.ts). */
	private readonly models: ModelCaller;
	/** Auto-verify after edits (src/host/verify.ts). */
	private readonly verifier: Verifier;
	/** Tool calls: cards, hooks, redaction, parallel safety (src/host/toolExecutor.ts). */
	private readonly tools: ToolExecutor;
	private readonly taskBudgets = new TaskBudgets();
	/** Usage stats (src/host/usageStats.ts). */
	private readonly usage: UsageStats;
	
	
	
	

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: ProviderStore,
		catalog: ModelCatalog,
		private readonly reveal: () => void
	) {
		this.models = new ModelCaller({ store, status: (m, k) => this.status(m, k), callModel: (p, k, o) => this.callModel(p, k, o) }, BREAKER_MS);

		// Memory recall upgrades to similar meaning when an embedding model is configured;
		// without one it stays the deterministic keyword search.
		this.store.setMemoryEmbedder({
			model: () => {
				const s = this.store.getSettings();
				return s.embeddingProvider ? `${s.embeddingProvider}::${s.embeddingModel || ''}` : '';
			},
			embed: async (texts, kind, signal) => {
				const target = await this.embedTarget();
				if (!target) throw new Error('No embedding model is configured.');
				const prefix = kind === 'query' ? target.queryPrefix ?? '' : target.docPrefix ?? '';
				return embedTexts(target, texts.map((text) => prefix + text), signal);
			}
		});
		this.verifier = new Verifier({ scheduleState: () => this.scheduleState() });
		this.usage = new UsageStats({ store, catalog, alertState: context.globalState, notify: (message) => { void vscode.window.showWarningMessage(message); } });
		context.subscriptions.push(store.onUsageRecorded(() => { void this.usage.checkBudgetAlerts().catch(() => undefined); }));
		// A chat's background command ended on its own: the lead reads how, with the next notice block.
		const offExit = onBackgroundExit((p) => {
			const { sessionId, guardScope } = backgroundOwnerOf(p);
			if (!sessionId || !this.store.getSettings().commandNotices) return;
			if (guardScope) {
				// An isolated writer's own command: it reads the result at its next step, as long as it still works.
				const writer = this.agentRuns.get(guardScope.split('/').pop() ?? '');
				if (writer?.kind === 'writer' && writer.status === 'running') this.writers.steer(writer.id, backgroundNotice(p));
				return;
			}
			this.agentRuns.queueNotice(sessionId, backgroundNotice(p), () => !!backgroundProc(p.id)?.reported || !backgroundProc(p.id));
			this.agentRuns.scheduleWake(sessionId, (id) => this.wakeForAgents(id));
		});
		context.subscriptions.push({ dispose: offExit });
		const watchdog = new AgentWatchdog({
			registry: this.agentRuns,
			settings: () => this.store.getSettings(),
			steerWriter: (id, text) => this.writers.steer(id, text),
			notifyLead: (sessionId, text) => {
				this.agentRuns.queueNotice(sessionId, text);
				this.agentRuns.scheduleWake(sessionId, (id) => this.wakeForAgents(id));
			},
			chatModel: async (sessionId) => {
				const { provider, model } = await this.store.resolveSelection(sessionId);
				if (!provider || !model || provider.apiFormat === 'acp' || provider.apiFormat === 'vscode-lm') return undefined;
				return { provider, model, apiKey: (await this.store.getApiKey(provider.id)) ?? '' };
			},
			callModel: (p, k, o) => this.callModel(p, k, o),
			scheduleState: () => this.scheduleState()
		});
		watchdog.start();
		context.subscriptions.push(watchdog);
		const events = new EventSources({
			root: () => {
				const root = workspaceRoot();
				return root?.scheme === 'file' ? root.fsPath : undefined;
			},
			settings: () => this.store.getSettings(),
			memento: context.workspaceState,
			chatModel: async () => {
				const sessionId = this.sessionId;
				const { provider, model } = await this.store.resolveSelection(sessionId);
				if (!provider || !model || provider.apiFormat === 'acp' || provider.apiFormat === 'vscode-lm') return undefined;
				return { provider, model, apiKey: (await this.store.getApiKey(provider.id)) ?? '', sessionId };
			},
			callModel: (p, k, o) => this.callModel(p, k, o),
			owner: (thread) => this.store.getSettings().threadRouting ? this.agentRuns.threads.route(thread, (a) => this.agentRuns.get(a)?.status === 'running') : undefined,
			context: (thread) => (this.agentRuns.threads.get(thread)?.events ?? []).map((e) => `[${e.source}] ${e.text.replace(/\s+/g, ' ').slice(0, 400)}`),
			fanOut: (ev, message) => {
				this.agentRuns.threads.open(ev.thread, this.sessionId, ev.label);
				if (!this.passThrough(ev.thread, message, `a ${ev.kind} event`, ev.text)) return undefined;
				return this.agentRuns.threads.record(ev.thread, ev.kind, `${ev.author ? `${ev.author}: ` : ''}${ev.text}`)!.id;
			},
			deliver: (ev, notice) => {
				const thread = this.agentRuns.threads.open(ev.thread, this.sessionId, ev.label);
				const record = this.agentRuns.threads.record(ev.thread, ev.kind, `${ev.author ? `${ev.author}: ` : ''}${ev.text}`)!;
				const previous = this.finishedOwner(ev.thread);
				const text = notice(record.id).replace(/\n<\/event-notification>$/, previous ? `\n${resumeHint(previous)}\n</event-notification>` : '\n</event-notification>');
				this.agentRuns.queueNotice(thread.sessionId, text, undefined, false, ev.thread);
				this.agentRuns.scheduleWake(thread.sessionId, (id) => this.wakeForAgents(id));
				return record.id;
			},
			status: (message) => this.status(message, '')
		});
		this.agentRuns.eventLog = () => events.log;
		events.start();
		context.subscriptions.push(events);
		// mcp / plugins are created further down: the executor reads them when a tool runs.
		const self = this;
		this.tools = new ToolExecutor({
			scheduleState: () => this.scheduleState(),
			get mcp() {
				return self.mcp;
			},
			get plugins() {
				return self.plugins;
			},
			
		});
		const storage = context.globalStorageUri.fsPath;
		setCommandRulesTrustDir(path.join(storage, 'command-rules'));
		const writerRoot = workspaceRoot()?.fsPath;
		if (writerRoot) {
			this.agentRuns.configure(path.join(storage, 'agent-runs', createHash('sha256').update(path.resolve(writerRoot)).digest('hex') + '.json'));
			this.writers.configure(storage, writerRoot);
			for (const job of this.writers.jobs.values()) if (!job.comparisonId) this.agentRuns.restoreWriter(job);
		}
		this.writerReview = new WriterReviewHost({
			pool: this.writers, session: () => this.sessionId, root: () => workspaceRoot()?.fsPath,
			readOnly: () => this.store.getMode() !== 'full', busy: () => !!this.run,
			denyPaths: () => this.store.getSettings().denyPaths,
			find: id => this.agentRuns.list(this.sessionId).find(run => run.id === id), refresh: () => this.sendState(),
			resume: id => this.onSend(`Continue isolated writer ${id} in its existing worktree using agent_send. First inspect its existing changes; interrupted actions may already have taken effect.`, false),
			record: async (id, before, session) => {
				const user: StoredMessage = { id: newId('u'), role: 'user', content: `Apply changes from writer ${id}`, turn: { startedAt: Date.now() } };
				const messages = session === this.sessionId ? this.messages : await this.store.loadMessages(session);
				messages.push(user); await this.history.finish(user, before, session); await this.store.saveMessages(session, messages);
			}
		});
		
		const host: HostContext = {
			store,
			postAll: (m) => this.postAll(m),
			status: (m, k) => this.status(m, k ?? 'ok'),
			sendState: () => this.sendState()
		};
		const extensionHost: HostContext = { ...host, sendState: () => { this.extensionCatalog.invalidate(); return this.sendState(); } };
		this.appearance = new AppearanceHost(host);
		this.localModels = new LocalModelsHost(host, storage, context.globalState, context.secrets, () => this.reveal());
		this.localModels.mediaToChat = (media) => this.insertMedia(media);
		
		const providersHost = new ProvidersHost(host, catalog);
		this.featureTools = new FeatureToolsHost(host, path.join(context.storageUri?.fsPath ?? path.join(storage,'projects',createHash('sha256').update(workspaceRoot()?.toString() || 'none').digest('hex')), 'features'), () => this.sessionId, () => !!this.run || !!this.turning || this.agentRuns.list().some(r => r.status === 'running'), () => { this.codeIdx = undefined; this.scheduleState(); }, context.extensionUri.fsPath);
		// Plan agents (Claude, Antigravity, Cursor, OpenCode…): sign-in through the vendors' own software, see src/acp.

		
		let health!: FeaturesHealthHost;
		this.features = [ (this.workspace = new WorkspaceHost(host, this.originals, context.subscriptions)), (this.mic = new MicHost(host, () => this.scheduleState())), (this.attachments = new Attachments(host, isDesktopHost() ? path.join(context.storageUri?.fsPath ?? storage, 'pending-attachments-' + (process.env.ZER0NE_WINDOW_ID || 'standalone') + '.json') : undefined)), this.appearance, providersHost, this.localModels, new SandboxHost(host, storage, path.join(context.extensionUri.fsPath, 'media', 'sandbox', 'lowil.cs')), new ChatActionsHost(host, () => ({ sessionId: this.sessionId, messages: this.messages }), (p, k, o) => this.callModel(p, k, o)), (this.worktreesHost = new WorktreesHost(host, context.globalState))];
		this.features.push(this.featureTools);
		this.features.push(new ComputerUseHost(host, storage, path.join(context.extensionUri.fsPath, 'media', 'sandbox', 'input.cs')));
		{
			const { AcpRuntime, setAcpRuntime } = require('./acp/runtime') as typeof import('./acp/runtime');
			const { AcpHost } = require('./host/acpHost') as typeof import('./host/acpHost');
			const acpRuntime = new AcpRuntime(storage); setAcpRuntime(acpRuntime);
			this.features.splice(this.features.indexOf(providersHost), 0, new AcpHost(host, acpRuntime));
		}
		const { CloudHost } = require('./host/cloudHost') as typeof import('./host/cloudHost');
		const cloud = new CloudHost(host, context.globalState, context.extensionUri.fsPath, (id: string) => this.switchSession(id), context.secrets);
		this.features.push(cloud);
		this.browser = new BrowserAgent(storage, () => {
			const s = this.store.getSettings();
			return { path: s.browserPath, headless: s.browserHeadless };
		});
		// OAuth tokens for remote MCP servers stay in the OS keychain.
		this.mcp = new McpManager(() => workspaceRoot()?.fsPath, () => this.scheduleState(), {
			get: async (resource) => {
				const raw = await context.secrets.get(`mcp.oauth.${resource}`);
				return raw ? JSON.parse(raw) : undefined;
			},
			set: async (resource, tokens) => {
				await (tokens ? context.secrets.store(`mcp.oauth.${resource}`, JSON.stringify(tokens)) : context.secrets.delete(`mcp.oauth.${resource}`));
			}
		});
		this.checkpoints = new CheckpointStore(path.join(storage, 'checkpoints'));
		this.imagesDir = path.join(storage, 'images');
		this.transcripts = new TranscriptStore(path.join(storage, 'transcripts'), (notice) => this.status(notice.message, notice.kind === 'corrupt' ? 'error' : ''));
		// Picture compaction is retired (0.30): drop its old frame archives.
		fs.rm(path.join(storage, 'archives'), { recursive: true, force: true }, () => undefined);
		// Stale download/conversion leftovers and dead runtime versions, off the boot path (src/host/storageSweep.ts).
		setTimeout(() => { try { sweepStorage(storage); } catch { /* best effort */ } }, 15_000).unref?.();
		this.compactor = new Compactor({
			store: this.store,
			sessionId: () => this.sessionId,
			transcripts: this.transcripts,
			cacheGuard: this.cacheGuard,
			status: (m, k) => this.status(m, k),
			scheduleState: () => this.scheduleState(),
			callModel: (p, k, o) => this.callModel(p, k, o),
			notifyHook: async (event, payload) => {
				const hooks = this.allHooks();
				if (!hooks.some((h) => h.enabled && h.event === event)) return;
				const res = await runHooks(hooks, event, { session_id: this.sessionId, workspace: workspaceRoot()?.fsPath ?? '', ...payload }, workspaceRoot()?.fsPath).catch(() => undefined);
				if (res?.log.length) this.status(`PreCompact hooks: ${res.log.join('; ')}`, '');
			}
		});
		this.goals = new GoalKeeper({ store: this.store, scheduleState: () => this.scheduleState(), callModel: (p, k, o) => this.callModel(p, k, o) });
		this.reviews = new ReviewManager(this.originals);
		this.plugins = new PluginHost(storage, () => workspaceRoot()?.fsPath, () => context.globalState.get<string[]>(DISABLED_PLUGINS_KEY, []), () => context.globalState.get<string[]>(ACTIVATED_PLUGINS_KEY, []));
		// Mods: in-process behavior packs (plugins with hooks.json "modules", plus dev folders).
		
		const { MarketplaceHost } = require('./host/marketplaceHost') as typeof import('./host/marketplaceHost');
		this.features.push(
			new MarketplaceHost(extensionHost, this.plugins, context.globalState, async (name, on) => {
			await setPluginEnabled(this.plugins, context.globalState, name, on);
		}, async () => {
			this.mcp.sync(this.mcpConfigs(), this.store.getSettings().mcp);
			await extensionHost.sendState();
		})
		);
		this.skills = new SkillStore(path.join(storage, 'skills'), () => workspaceRoot()?.fsPath, () => context.globalState.get<string[]>(DISABLED_SKILLS_KEY, []), () => [...this.plugins.skillDirs(), { dir: path.join(context.extensionUri.fsPath, 'media', 'skills'), plugin: 'zer0ne' }]);
		this.runner = new TurnRunner(this.turnHost = {
			store: this.store,
			backgroundReports: true,
			taskBudgets: this.taskBudgets,
			noteError: (m) => this.noteError(m),
			context,
			sessionId: () => this.sessionId,
			messages: () => this.messages,
			activeRun: () => this.run,
			setRun: (r) => (this.run = r),
			setStreaming: (st) => (this.streaming = st),
			lastRequest: () => this.lastRequest,
			setLastRequest: (r) => (this.lastRequest = r),
			setLastContext: (c) => (this.lastContext = c),
			lastContext: () => this.lastContext,
			nextQueued: () => this.queue[0]?.id === this.queueEditing ? undefined : this.queue.shift(),
			status: (m, k) => this.status(m, k),
			postAll: (m) => this.postAll(m),
			sendState: () => this.sendState(),
			scheduleState: () => this.scheduleState(),
			notify: (k, t) => this.notify(k, t),
			allHooks: () => this.allHooks(),
			requestApproval: (c, r, rule) => this.requestApproval(c, r, rule),
			askUser: (c, q, o, sig) => this.askUser(c, q, o, sig),
			searchCode: (q, l, sig) => this.searchCode(q, l, sig),
			ocrFor: (sig) => this.ocrFor(sig),
			generateImageLocal: (req, onTick, signal) => this.localModels.catalog.generateForTool(req, onTick, signal),
			localImageBundles: () => this.localModels.catalog.installedImages(),
			urlProvenance: (id) => this.urlProvenance(id),
			openArtifact: (f, t) => (this.artifacts ??= new ArtifactHost()).show(f, t).finally(() => this.scheduleState()),
			onFeatureReport: report => this.featureTools.record(report),
			featureStorageDir: () => this.featureTools.storageDir,
			agentServices: () => this.agentServices(),
			handleSend: (t, p, attachments) => this.handleSend(t, p, attachments),
			continueWithAgents: () => this.continueWithAgents(),
			finishTurn: (u, sn, id) => this.finishTurn(u, sn, id),
			transcripts: this.transcripts,
			compactor: this.compactor,
			goals: this.goals,
			cacheGuard: this.cacheGuard,
			cacheStats: this.cacheStats,
			cacheWaste: this.cacheWaste,
			imageCache: this.imageCache,
			turnSnapshots: this.turnSnapshots,
			toolHosts: this.toolHosts,
			skills: this.skills,
			mcp: this.mcp,
			browser: this.browser,
			// Created later in the constructor: read them when a turn runs.
			get models() {
				return self.models;
			},
			get verifier() {
				return self.verifier;
			},
			get tools() {
				return self.tools;
			},
			get usage() {
				return self.usage;
			},
			get warmer() {
				return self.warmer;
			}
		});
		this.features.push(
			(this.history = new TurnHistory(host, {
				checkpoints: this.checkpoints,
				originals: this.originals,
				busy: () => !!this.run || !!this.turning || this.comparisons?.mutating || this.hunks?.busy || this.agentRuns.list().some(r => r.status === 'running'),
				sessionId: () => this.sessionId,
				messages: () => this.messages,
				rewind: async id => { if (!await this.store.rewindSession(this.sessionId, id)) throw new Error('Could not create the rewound chat.'); await this.loadCurrent(); }
			})),
			(this.projects = new ProjectsHost(host, context.globalState, { currentId: () => this.sessionId, switchSession: (id) => this.switchSession(id), newChat: () => this.newChat() })),
			new SessionsHost(host, {
				busy: () => !!this.run,
				currentId: () => this.sessionId,
				saveCurrent: () => this.store.saveMessages(this.sessionId, this.messages),
				createWorktree: async task => (await this.worktreesHost.create(task)).path,
				removeWorktree: async worktreePath => {
					const root = workspaceRoot()?.fsPath ?? worktreePath;
					await removeWorktree(root, worktreePath, true);
				},
				openSession: id => this.projects.routeSession(id),
				openCurrent: async () => {
					this.queue = [];
					await this.loadCurrent();
					this.postAll({ type: 'focusInput' });
				},
				loadCurrent: () => this.loadCurrent(),
				newChat: () => this.newChat(),
				switchSession: (id) => this.switchSession(id),
				cancelRun: () => this.cancelRun(),
				removeData: (id) => {
					this.attachments.removeSession(id);
					this.postAll({ type: 'discardComposerDraft', sessionId: id });
					
					this.agentRuns.removeSession(id);
					this.checkpoints.removeSession(id);
					this.transcripts.remove(id);
				}
			}),
			(health = new FeaturesHealthHost(host, {
				sessionId: () => this.sessionId,
				checkReady: (p, m) => this.checkReady(p, m),
				storageDir: context.globalStorageUri.fsPath,
				extensionDir: context.extensionUri.fsPath,
				codeIndexStats: () => this.codeIdx?.index.stats(),
				mcp: this.mcp,
				mcpConfigs: () => this.mcpConfigs(),
				skills: this.skills,
				cacheStats: this.cacheStats,
				
			}))
		);
		const pkg = (() => {
			try {
				return JSON.parse(fs.readFileSync(path.join(context.extensionUri.fsPath, 'package.json'), 'utf8')) as { version?: string; bugs?: { url?: string } };
			} catch {
				return {};
			}
		})();
		this.version = pkg.version ?? '?';
		this.report = new ReportHost(host, {
			version: pkg.version ?? '?',
			vscodeVersion: vscode.version,
			storageDir: storage,
			health: () => health.check(),
			engine: () => this.localModels.diagnostics(),
			errors: () => this.recentErrors,
			show: async (text, title) => {
				if (isDesktopHost()) { await vscode.commands.executeCommand('zer0ne.showReport', text, title); return; }
				const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
				await vscode.window.showTextDocument(doc, { preview: false });
				const actions = pkg.bugs?.url ? ['Open GitHub issue', 'Copy report'] : ['Copy report'];
				const pick = await vscode.window.showInformationMessage('Your problem report is open in the editor. Read it and add what happened — nothing has been sent.', ...actions);
				// The edited text, not the first draft.
				if (pick === 'Copy report') await vscode.env.clipboard.writeText(doc.getText());
				else if (pick === 'Open GitHub issue' && pkg.bugs?.url) await vscode.env.openExternal(vscode.Uri.parse(issueLink(pkg.bugs.url, title, doc.getText()), true));
			}
		});
		const sideTools = new Set<string>(Object.values(SIDE_SOURCES).flat());
		this.comparisons = new ModelComparisonsHost(host, {
			pool: this.writers, budgets: this.taskBudgets, storage, extension: context.extensionUri.fsPath,
			root: () => workspaceRoot()?.fsPath, session: () => this.sessionId,
			busy: () => !!this.run || !!this.turning || this.hunks?.busy || this.agentRuns.list().some(r => r.status === 'running'),
			callModel: (p, k, o) => this.callModel(p, k, o), scheduler: this.tools.scheduler, hooks: () => this.allHooks(),
			approve: async (command, session, signal, worktree, request) => {
				if (signal.aborted || session !== this.sessionId) return false;
				const pending = this.requestApproval(this.messages, { ...request, kind: 'command', command, path: worktree }, undefined);
				const card = this.messages[this.messages.length - 1], id = card?.approval?.id;
				const abort = () => { if (id) this.approvals.get(id)?.(false); };
				signal.addEventListener('abort', abort, { once: true });
				try {
					const handle = await pending;
					return { ...handle, approved: handle.approved && !signal.aborted && session === this.sessionId };
				}
				finally { signal.removeEventListener('abort', abort); if (id && signal.aborted) this.approvals.delete(id); }
			},
			record: async (id, before, session) => {
				const user: StoredMessage = { id: newId('u'), role: 'user', content: `Apply comparison candidate ${id}`, turn: { startedAt: Date.now() } };
				const messages = session === this.sessionId ? this.messages : await this.store.loadMessages(session);
				messages.push(user); await this.history.finish(user, before, session); await this.store.saveMessages(session, messages);
			}
		});
		this.features.push(new BenchmarkHost(host, {
			storage: context.globalStorageUri.fsPath, extension: context.extensionUri.fsPath,
			workflow: () => this.store.getSubagentWorkflow(this.sessionId),
			productionProvider: async (provider, model, signal) => provider.preset === ENGINE_PRESET ? { ...provider, preset: undefined, baseUrl: await this.localModels.ensureLoaded(model, signal) } : provider,
			callModel: (p, k, o) => this.callModel(p, k, o),
			busy: () => !!this.run || !!this.turning || this.comparisons.busy || this.agentRuns.list().some(r => r.status === 'running')
		}));
		this.features.push(this.comparisons, this.hunks = new HunkReviewHost(host, {
			checkpoints: this.checkpoints, session: () => this.sessionId, messages: () => this.messages,
			busy: () => !!this.run || !!this.turning || this.comparisons.busy || this.agentRuns.list().some(r => r.status === 'running')
		}));
		this.features.push(this.report, new SideChatHost(host, () => ({
			sessionId: this.sessionId,
			messages: this.run?.sessionId === this.sessionId && this.streaming?.text
				? [...this.messages, { id: 'side-chat-live-context', role: 'assistant', content: this.streaming.text }]
				: this.messages
		}), (p, k, o) => this.callModel(p, k, o), {
			defs: () => buildToolDefs(this.store.getSettings(), { readOnly: true }).filter(d => sideTools.has(d.name)),
			// Its own guard scope: a Side Chat read must not count as the main agent having read the file.
			run: (call, sessionId, signal) => runTool(call, { store: this.store, settings: this.store.getSettings(), signal, readOnly: true, allowedTools: sideTools, sessionId, guardScope: `side-chat:${sessionId}`, vision: false, requestApproval: async () => ({ approved: false, finish: () => undefined }) })
		}));
		// Settings → Subagents: built-in and file agents, their models and on/off state.
		this.features.push(new SubagentsHost(extensionHost, this.plugins, context.globalState));
		this.features.push(this.mcpApps = new McpAppsHost(this.mcp, () => ({ sessionId: this.sessionId, messages: this.messages })));
		// Work Details → Terminal: the small integrated shell.
		this.features.push((this.terminalHost = new TerminalHost(host)));
		this.features.push(this.ptyHost = new InteractiveTerminalHost(host, path.join(context.extensionUri.fsPath, 'media', 'terminal', 'conpty.cs'), storage));
		this.features.push(this.projectActions = new ProjectActionsHost(host, storage));
		this.writers.prepareWorktree = (directory, signal) => this.projectActions.prepare(directory, signal);
		this.worktreesHost.prepare = directory => this.projectActions.prepare(directory);
		this.worktreesHost.busy = () => !!this.run || this.agentRuns.list().some(r => r.status === 'running');
		this.features.push(new ExtensionsHost(extensionHost, { mcp: this.mcp, skills: this.skills, plugins: this.plugins, globalState: context.globalState, storageDir: storage, applyServices: () => this.applyServices(), mcpConfigs: () => this.mcpConfigs() }));
		
		this.features.push(new SkillRecorderHost(extensionHost, { storageDir: storage, sourceFile: path.join(context.extensionUri.fsPath, 'media', 'recorder', 'screen-recorder.cs'), skills: this.skills, plugins: this.plugins, callModel: (p, k, o) => this.callModel(p, k, o) }));
		const { QuickTunnel, SshTunnel } = require('./tunnel') as typeof import('./tunnel');
		this.tunnel = new QuickTunnel(path.join(context.globalStorageUri.fsPath, 'bin'), () => this.scheduleState());
		this.ssh = new SshTunnel(() => this.scheduleState());
		this.remote = new RemoteServer(vscode.Uri.joinPath(context.extensionUri, 'media').fsPath, {
			token: () => this.remoteToken(),
			changed: () => this.scheduleState(),
			publicBases: () => {
				const s = this.store.getSettings();
				if (s.remoteAccess === 'anywhere' && this.tunnel.url) return [this.tunnel.url];
				if (s.remoteAccess === 'ssh' && this.ssh.url) return [this.ssh.url];
				if (s.remoteAccess === 'tailscale' && this.tailscale) return [`http://${this.tailscale.dns || this.tailscale.ip}:${s.remotePort}`, ...(this.tailscale.dns ? [`http://${this.tailscale.ip}:${s.remotePort}`] : [])];
				return [];
			},
			attach: (post) => {
				const surface: Surface = { kind: 'remote', post: message => {
					if (!isDesktopHost()) { post(message); return; }
					const root = workspaceRoot()?.fsPath;
					const belongs = (session: { projectPath?: string }) => !!root && !!session.projectPath && projectPathKey(session.projectPath) === projectPathKey(root);
					if (message.type === 'state') post({ ...message, sessions: (message.sessions as SessionMeta[]).filter(belongs) });
					else if (message.type === 'projects') post({ ...message, projects: (message.projects as { current: boolean }[]).filter(project => project.current) });
					else if (message.type === 'chatSearch') {
						const known = new Set(this.context.globalState.get<SessionMeta[]>('aiChat.sessions', []).filter(belongs).map(session => session.id));
						post({ ...message, hits: (message.hits as { id: string }[]).filter(hit => known.has(hit.id)) });
					}
					else post(message);
				} };
				const disposable = this.attach(surface);
				return { dispose: () => disposable.dispose(), handle: (msg) => this.handle(surface, msg) };
			},
			// Push notifications carry their own Approve/Reject links while Remote is reachable.
			decide: (id, approve) => this.decideApproval(id, approve),
			// Inline MCP apps render inside the phone page too (same sandbox, same token).
			mcpApp: (key) => this.mcpAppDocument(key),
			// A published artifact opens on the phone by its preview id (capability URL).
			preview: (id) => this.artifacts?.get(id),
			// Each phone gets its own session so Settings can sign one out without the others.
			devices: {
				list: () => (isDesktopHost() ? this.context.workspaceState : this.context.globalState).get<RemoteDevice[]>(REMOTE_DEVICES_KEY, []),
				save: (list) => { void (isDesktopHost() ? this.context.workspaceState : this.context.globalState).update(REMOTE_DEVICES_KEY, list); }
			}
		}, { desktopHost: isDesktopHost(), commandDir: path.join(context.storageUri?.fsPath ?? storage, 'command-receipts') });
		this.ready = this.init();
		
		
		this.warmer = new CacheWarmer({
			store: this.store,
			currentSessionId: () => this.sessionId,
			busy: () => !!this.run,
			loadTranscript: (id) => this.transcripts.load(id),
			callModel: (p, k, o) => this.callModel(p, k, o),
			warmed: ({ count, cachedTokens }) => {
				if (this.lastContext) {
					this.lastContext.warm = `kept warm ${count}× (${Math.round(cachedTokens / 1000)}k cached)`;
				}
			},
			stateChanged: () => this.scheduleState()
		});
	}

	private async init(): Promise<void> {
		// A saved workflow stays enabled: the chat shows it (the run card above the
		// composer and /workflow), so an enabled profile is never hidden from the user.
		this.sessionId = await this.store.currentSessionId();
		this.attachments.selectSession(this.sessionId);
		this.messages = await this.store.loadMessages(this.sessionId);
		await this.recoverCurrent();
		
		await this.applyServices();
	}

	/** Start/stop MCP servers and Mobile Remote to match settings. */
	private serviceUpdates: Promise<void> = Promise.resolve();
	private applyServices(restartRemote = false): Promise<void> {
		const next = this.serviceUpdates.catch(() => undefined).then(async () => {
			if (restartRemote) await this.remote.stop();
			await this.syncServices();
		});
		this.serviceUpdates = next;
		return next;
	}
	private async syncServices(): Promise<void> {
		if (this.disposed) return;
		const s = this.store.getSettings();
		this.mcp.sync(this.mcpConfigs(), s.mcp);
		if (s.remoteEnabled) {
			await this.remote.start(s.remotePort).catch((e) => this.status(`Mobile Remote: ${e instanceof Error ? e.message : e}`, 'error'));
			if (this.disposed) { await this.remote.stop(); return; }
			// Detected whenever the remote is on: the Tailscale option only shows when it is installed and signed in.
			if (!this.tailscaleAt || Date.now() - this.tailscaleAt > 60_000) {
				this.tailscale = require('./tunnel').tailscaleAddress();
				this.tailscaleAt = Date.now();
			}
			if (s.remoteAccess === 'anywhere' && this.remote.running) {
				// Not awaited: the first run downloads cloudflared; the page shows progress.
				void this.tunnel.start(this.remote.info().port);
			} else {
				this.tunnel.stop();
			}
			// The own tunnel over ssh: starts with the fields already saved; the page shows its state.
			if (s.remoteAccess === 'ssh' && s.remoteSshTarget && this.remote.running) {
				void this.ssh.start(this.remote.info().port, s.remoteSshTarget, s.remoteSshRemotePort).catch(() => undefined);
			} else {
				this.ssh.stop();
			}
		} else {
			this.tunnel?.stop();
			this.ssh?.stop();
			await this.remote.stop();
		}
		if (!s.browserAgent && this.browser.active) {
			await this.browser.close();
		}
	}

	private remoteToken(): string {
		const state = isDesktopHost() ? this.context.workspaceState : this.context.globalState;
		let token = state.get<string>(REMOTE_TOKEN_KEY);
		if (!token) {
			token = newRemoteToken();
			void state.update(REMOTE_TOKEN_KEY, token);
		}
		return token;
	}

	

	/** Theme for the first paint of the chat page. */
	bootAppearance(): { theme: string } {
		const s = this.store.getSettings();
		return { theme: s.theme };
	}

	attach(surface: Surface): vscode.Disposable {
		this.surfaces.add(surface);
		return new vscode.Disposable(() => this.surfaces.delete(surface));
	}

	async stopTerminal(): Promise<void> { await Promise.all([this.terminalHost.stop(), this.ptyHost.stop(), this.projectActions.stop()]); }

	dispose(): void {
		this.taskBudgets.dispose();
		this.disposed = true;
		clearTimeout(this.stateTimer);
		this.extensionCatalog.dispose();
		// Session-end hooks are fire-and-forget: dispose must never wait on them.
		const hooks = this.allHooks();
		if (hooks.some((h) => h.enabled && h.event === 'SessionEnd')) {
			void runHooks(hooks, 'SessionEnd', { session_id: this.sessionId, workspace: workspaceRoot()?.fsPath ?? '', reason: 'workspace_closed' }, workspaceRoot()?.fsPath).catch(() => undefined);
		}
		
		this.warmer.cancel();
		this.cancelRun();
		this.agentRuns.stopAll();
		try { this.agentRuns.checkpoint(); } catch (error) { this.noteError(`Could not save agent recovery: ${String(error)}`); }
		
		
		this.mic.dispose();
		void this.reviews.dispose();
		this.mcp.dispose();
		void this.browser.close();
		this.tunnel?.stop();
		this.ssh?.stop();
		void this.remote?.stop();
		this.surfaces.clear();
		for (const f of this.features) {
			f.dispose?.();
		}
	}

	// ------------------------------------------------------------ posting

	private postAll(message: Record<string, unknown>): void {
		for (const s of this.surfaces) {
			s.post(message);
		}
	}

	private status(message: string, kind: 'ok' | 'warn' | 'error' | '' = 'ok'): void {
		if (kind === 'error') this.noteError(message);
		this.postAll({ type: 'status', message, kind });
	}

	/** Remembered for Report a problem (last 30 this session). */
	private noteError(message: string): void {
		if (this.recentErrors.push({ at: Date.now(), message: String(message) }) > 30) this.recentErrors.shift();
	}

	/** Command palette / settings: the diagnostics report, shown for review. */
	reportProblem(): Promise<void> {
		return this.report ? this.report.report() : Promise.resolve();
	}

	/** Coalesce bursts of state changes into one snapshot. */
	private scheduleState(): void {
		if (this.disposed) return;
		if (this.stateTimer) {
			return;
		}
		this.stateTimer = setTimeout(() => {
			this.stateTimer = undefined;
			try { this.agentRuns.checkpoint(); } catch (error) { this.noteError(`Could not save agent recovery: ${String(error)}`); }
			void this.sendState().catch(error => { if (!this.disposed) this.status(`Could not refresh the chat: ${error instanceof Error ? error.message : error}`, 'error'); });
		}, 16);
	}

	async refreshDesktop(surface: Surface): Promise<void> {
		await this.ready;
		await this.worktreesHost.handoff();
		await this.sendState(surface);
	}

	async sendState(target?: Surface): Promise<void> {
		await this.ready;
		if (this.disposed) return;
		const catalogVersion = this.extensionCatalog.version;
		const catalog = await this.extensionCatalog.read({
			storage: this.context.globalStorageUri.fsPath,
			home: os.homedir(),
			root: workspaceRoot()?.fsPath,
			bundledSkills: path.join(this.context.extensionUri.fsPath, 'media', 'skills'),
			disabledPlugins: this.context.globalState.get<string[]>(DISABLED_PLUGINS_KEY, []),
			activatedPlugins: this.context.globalState.get<string[]>(ACTIVATED_PLUGINS_KEY, []),
			disabledSkills: this.context.globalState.get<string[]>(DISABLED_SKILLS_KEY, []),
			agentState: this.plugins.agentState(),
			desktop: isDesktopHost()
		}).catch(error => { if (!this.disposed) throw error; return undefined; });
		if (this.disposed) return;
		if (!catalog) return;
		if (catalogVersion !== this.extensionCatalog.version) return this.sendState(target);
		const efforts = await this.store.getAllEfforts();
		const providers: ProviderView[] = [];
		for (const p of await this.store.list()) {
			const own: Record<string, string> = {};
			for (const [key, value] of Object.entries(efforts)) {
				if (key.startsWith(p.id + '::')) {
					own[key.slice(p.id.length + 2)] = value;
				}
			}
			const variants = p.apiFormat === 'acp' ? variantControls(p.models) : undefined;
			const reasoningControls = Object.fromEntries(p.models.map(m => [m.id, reasoningControl({ apiFormat: modelApiFormat({ apiFormat: p.apiFormat, baseUrl: p.baseUrl, model: m.id }), baseUrl: p.baseUrl, model: m.id, advertised: m.reasoningControl ?? variants?.get(m.id), localEngine: p.preset === ENGINE_PRESET, reasoning: m.reasoning })]));
			providers.push({ ...p, hasKey: p.apiFormat === 'vscode-lm' || p.apiFormat === 'acp' || (await this.store.hasApiKey(p.id)), efforts: own, reasoningControls, account: p.auth === 'account' ? await this.store.getAccount(p.id) : undefined, keys: p.auth === 'account' ? undefined : (await this.store.keyCount(p.id)) || undefined });
		}
		const selection = await this.store.resolveSelection(this.sessionId);
		const settings = this.store.getSettings();
		const mcpConfigs = desktopServicesOwned() ? [...this.store.getMcpServers(), ...catalog.mcp] : [];
		
		const visibleRun = this.run;
		const visibleMessages = this.messages;
		const workflowTurn = [...visibleMessages].reverse().find(message => message.role === 'user' && message.turn);
		const checkpointIds = this.checkpoints.list(this.sessionId);
		const undoneIds = new Set(visibleMessages.filter(m => m.turn?.undone).map(m => m.id));
		const currentSession = await this.store.getSession(this.sessionId);
		const pinnedSkills = currentSession?.pinnedSkills ?? [];
		for (const m of visibleMessages) {
			m.at ??= Date.now();
		}
		const state = {
			type: 'state',
			version: this.version,
			capabilities: isDesktopHost() ? { ...DESKTOP_CAPABILITIES, optionalServiceOwner: desktopServicesOwned() } : undefined,
			providers,
			selection: { providerId: selection.provider?.id, model: selection.model?.id },
			modelPreferences: this.store.getModelPreferences(),
			featureCatalog: featureCatalog(isDesktopHost()),
			featureConfiguration: checkConfiguration(settings),
			settings,
			mode: this.store.getMode(),
			subagentWorkflow: await this.store.getSubagentWorkflow(this.sessionId),
			workflowTaskId: workflowTurn?.rootTaskId ?? workflowTurn?.id ?? null,
			messages: visibleMessages.filter((m, index) => index >= visibleMessages.length - (this.historyWindows.get(this.sessionId) ?? 200) || m.approval?.status === 'pending' || m.question?.status === 'pending'),
			historyWindow: { total: visibleMessages.length, limit: this.historyWindows.get(this.sessionId) ?? 200, hasMore: visibleMessages.length > (this.historyWindows.get(this.sessionId) ?? 200) },
			providerLifecycle: { fileRestore: true, conversationRewind: 'new-chat', nativeRollback: false, session: selection.provider?.apiFormat === 'acp' ? 'native-with-portable-context-reset' : 'transcript', fork: 'portable-context' },
			isStreaming: !!visibleRun,
			desktopBackgroundRuns: isDesktopHost() ? [...this.agentRuns.list().filter(run => run.status === 'running').map(run => ({ sessionId: run.sessionId, status: 'running' }))] : undefined,
			runState: visibleRun ? ((this.approvals.size || this.questions.size || (this.run?.sessionId === this.sessionId && this.messages.some(m => m.approval?.status === 'pending' || m.question?.status === 'pending'))) ? 'waiting' : 'running') : 'idle',
			runningSessionId: visibleRun?.sessionId,
			streaming: this.streaming ?? null,
			queue: this.queue.map(({ attachments, ...item }) => ({ ...item, attachments: attachments.map(({ id, name, kind }) => ({ id, name, kind })) })),
			sessions: await this.store.listSessions(),
			folders: this.store.getFolders(),
			currentSessionId: this.sessionId,
			branch: currentSession?.branchedFrom ?? null,
			goal: currentSession?.goal ? (({ objective, status, rounds, maxRounds, check, note }) => ({ objective, status, rounds, maxRounds, check, note }))(currentSession.goal) : null,
			chapters: currentSession?.chapters ?? [],
			pinnedSkills,
			attachments: this.attachments.view(),
			context: this.lastContext ? { ...this.lastContext, saver: this.store.getSettings().tokenSaver ? saverTotals() : undefined } : null,
			hasWorkspace: !!workspaceRoot(),
			workspace: this.workspace.info(),
			memories: (await this.store.getMemories()).map(publicMemory),
			mcp: mcpConfigs.map((c) => ({ ...c, status: this.mcp.statuses([c])[0] })),
			skills: settings.skills ? catalog.skills.map((s) => ({ ...s, pinned: pinnedSkills.includes(s.name) })) : [],
			remote: { ...this.remote.info(), approvalWaiting: this.approvals.size, questionWaiting: this.questions.size, ...(isDesktopHost() ? { owner: desktopServicesOwned(), project: workspaceRoot()?.fsPath } : {}), access: settings.remoteAccess, tunnel: this.tunnel.status, helper: desktopServicesOwned() && settings.remoteAccess === 'anywhere' ? this.tunnel.helper() : null, tailscale: this.tailscale ?? null, ssh: this.ssh.status, sshHelper: desktopServicesOwned() && settings.remoteAccess === 'ssh' ? this.ssh.helper() : null },
			/** Published previews a phone can open (the desktop opens its own panel). */
			artifacts: this.artifacts?.list() ?? [],
			presets: PRESETS.filter(hostProviderAllowed),
			mic: this.mic.state(settings),
			browser: { active: this.browser.active, found: findBrowser(settings.browserPath) ?? '', preview: this.browser.preview, activity: this.browser.activity },
			hooks: [...this.store.getHooks(), ...catalog.hooks],
			hookHistory: hookHistory(workspaceRoot()?.fsPath),
			modelChecks: this.store.getModelChecks(),
			plugins: catalog.plugins,
			commands: catalog.commands.map(({ name, description, argumentHint, source }) => ({ name, description, argumentHint, source })),
				agents: catalog.agents.map(({ name, description, model, source, canWrite }) => ({ name, description, model, source, canWrite })),
				agentRuns: this.agentRuns.list(this.sessionId).map((run) => agentMonitorPayload(run)),
			undoable: checkpointIds.filter(id => !undoneIds.has(id)),
			redoable: checkpointIds,
			codeIndex: { building: this.indexStatus === 'building', ...(this.codeIdx?.index.stats() ?? {}) }
		};
		if (this.disposed) return;
		if (catalogVersion !== this.extensionCatalog.version) return this.sendState(target);
		for (const s of target ? [target] : this.surfaces) {
			s.post({ ...state, isRemote: s.kind === 'remote' });
		}
	}

	private notify(kind: 'done' | 'attention', text: string): void {
		const s = this.store.getSettings();
		if (s.notificationSound) {
			this.postAll({ type: 'sound', kind });
		}
		// Only "the agent needs you" raises a window notification; a finished prompt would just be noise.
		if (kind !== 'attention') {
			return;
		}
		const seen = [...this.surfaces].some((x) => x.kind === 'chat' && (x.visible?.() ?? true) && vscode.window.state.focused);
		if (s.notifications && !seen) {
			void vscode.window.showInformationMessage(`zer0ne: ${text}`, 'Open').then((pick) => pick && this.reveal());
		}
	}

	// ------------------------------------------------------------ inbound

	/** Approve or reject a pending tool call; also reached from a push notification's own link. */
	decideApproval(id: string, approve: boolean, always = false): boolean {
		
		const resolve = this.approvals.get(id);
		if (!resolve) return false;
		this.approvals.delete(id);
		if (always) {
			const pending = this.messages.find((m) => m.approval?.id === id);
			const command = pending?.approval?.kind === 'command' ? pending.approval.command : undefined;
			// Without the card's exact command there is nothing to grant; the plain approve still applies.
			if (command) this.sessionGrants.set(command, Date.now());
		}
		resolve(approve);
		return true;
	}

	async handle(surface: Surface, msg: Incoming): Promise<void> {
		await this.ready;
		try {
			await this.dispatch(surface, msg);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			// Attribute the error to its trigger: features share this one catch, and
			// without the type two different failures read identically in the chat.
			this.status(msg.type ? `[${msg.type}] ${detail}` : detail, 'error');
			await this.sendState();
			if (msg.zcCommand) throw error;
		}
	}

	/** After an update, that version's release notes once; a first install only records its version. */
	private async whatsNew(surface: Surface): Promise<void> {
		const seen = this.context.globalState.get<string>(SEEN_VERSION_KEY);
		const found = whatsNewFor(path.dirname(this.context.extensionUri.fsPath), seen);
		if (!found.version) return;
		if (found.show) surface.post({ type: 'whatsNew', ...found.show });
		else if (seen !== found.version) await this.context.globalState.update(SEEN_VERSION_KEY, found.version);
	}

	private async dispatch(surface: Surface, msg: Incoming): Promise<void> {
		if (msg.zcSession && msg.zcSession !== this.sessionId) throw new Error('The active chat changed. Inspect the current chat before submitting this action again.');
		if (!hostMessageAllowed(msg.type ?? '')) { this.status('This feature is unavailable in the desktop app.', 'error'); return; }
		if (isDesktopHost() && surface.kind === 'remote') {
			const root = workspaceRoot()?.fsPath;
			const sameProject = (folder: unknown) => typeof folder === 'string' && !!root && projectPathKey(folder) === projectPathKey(root);
			let allowed = !['projectPick', 'saveFolder', 'deleteFolder', 'foreignList', 'foreignImport'].includes(msg.type ?? '');
			if (msg.type === 'projectOpen' || msg.type === 'projectNewChat') allowed = sameProject(msg.path);
			const ids = ['switchSession', 'deleteSession', 'updateSession', 'forkSession', 'exportSession'].includes(msg.type ?? '') ? [msg.id] : msg.type === 'updateSessions' && Array.isArray(msg.ids) ? msg.ids : [];
			for (const id of ids) if (!sameProject((await this.store.getSession(String(id)))?.projectPath)) allowed = false;
			if (!allowed) { surface.post({ type: 'status', message: 'This Remote link controls only its paired project. Open the other project’s Remote link to use it.', kind: 'error' }); return; }
		}
		if (isDesktopHost() && !desktopServicesOwned() && ((msg.type ?? '').startsWith('remote') || (msg.type === 'updateSettings' && msg.patch && Object.keys(msg.patch).some(key => key.startsWith('remote'))))) {
			this.status('Another live host owns this project’s Remote. Open Remote in that window, or close it and reopen this project to take ownership.', 'error');
			return;
		}
		
		for (const feature of this.features) {
			if (await feature.handle(surface, msg as { type: string })) {
				return;
			}
		}
		switch (msg.type) {
			case 'ready':
				await this.sendState(surface);
				this.appearance.sendImage(surface);
				if (surface.kind === 'chat') {
					await this.worktreesHost.handoff();
					if (isDesktopHost()) await this.whatsNew(surface);
				}
				// A freshly attached surface never saw the last band draw — re-post it.
				
				break;
			case 'uiStall':
				console.warn(`[ui] the chat page froze for ${Math.round(Number(msg.ms) || 0)} ms (${Math.round(Number(msg.messages) || 0)} messages${msg.streaming ? ', streaming' : ''})`);
				break;
			case 'whatsNewSeen':
				if (typeof msg.version === 'string' && msg.version.length < 64) await this.context.globalState.update(SEEN_VERSION_KEY, msg.version);
				break;
			case 'historyMore':
				if (msg.sessionId !== this.sessionId) throw new Error('That chat is no longer active.');
				this.historyWindows.set(this.sessionId, Math.min(this.messages.length, (this.historyWindows.get(this.sessionId) ?? 200) + 200));
				await this.sendState(surface); break;

			// ---- conversation
			case 'send':
				// Phone channels say where a message came from; the composer never does.
				await this.onSend(String(msg.text ?? ''), msg.plan === true);
				break;
			case 'retry':
				await this.retry(msg.plan === true);
				break;
			case 'stop':
				
				this.queue = [];
				this.cancelRun();
				// Stop means stop: the chat's background agents too.
				this.agentRuns.stopSession(this.sessionId);
				break;
			case 'getAgentRuns':
				surface.post({ type: 'agentRuns', sessionId: this.sessionId, items: this.agentRuns.list(this.sessionId).map((run) => agentMonitorPayload(run)) });
				break;
			case 'taskEvidence': {
				const sessionId = this.sessionId;
				if (msg.sessionId !== sessionId) throw new Error('That chat is no longer active.');
				const user = this.messages.find(m => m.id === msg.id && m.role === 'user' && m.turn);
				const agent = this.agentRuns.list(sessionId).find(a => a.id === msg.id);
				if (!user && !agent) throw new Error('Choose a task in this chat.');
				if (this.run || agent?.status === 'running') throw new Error('Wait for the task to stop before refreshing its evidence.');
				const receipts = user?.turn?.verification ?? agent?.verification ?? [];
				await refreshEvidence(receipts, this.store.getSettings());
				if (this.sessionId !== sessionId || this.run) throw new Error('The chat changed while refreshing evidence.');
				const executions = readExecutions(this.context.globalStorageUri.fsPath, sessionId, String(msg.id));
				if (user) await this.store.saveMessages(sessionId, this.messages);
				else this.agentRuns.checkpoint();
				surface.post({ type: 'taskEvidenceResult', sessionId, id: msg.id, verification: receipts, executions, allowedTools: agent?.allowedTools, outcome: user?.turn?.outcome ?? agent?.status, review: user?.turn?.review ?? agent?.taskReview?.verdict ?? agent?.reviewVerdict });
				await this.sendState();
				break;
			}
			case 'writerReview':
				await this.writerReview.handle(surface, msg);
				break;
			case 'resumeAgent': {
				if (msg.sessionId !== this.sessionId || this.run || this.store.getMode() !== 'full') throw new Error('Continue requires an idle chat in Full Access mode.');
				const agent = this.agentRuns.list(this.sessionId).find(a => a.id === msg.id && a.kind === 'subagent' && a.status !== 'running');
				if (!agent) throw new Error('No stopped or completed agent in this chat.');
				await this.onSend(`Continue agent ${agent.id} using agent_send with its retained context. Recheck current project evidence before continuing the task.`, false);
				break;
			}
			case 'sendAgentMessage': {
                if (msg.sessionId !== this.sessionId) throw new Error('That chat is no longer active.');
                const agent = this.agentRuns.list(this.sessionId).find(a => a.id === msg.id);
                if (!agent || agent.status !== 'running') throw new Error('Only a running agent can receive instructions.');
                const message = String(msg.message ?? '').trim();
                if (!message || message.length > 8000) throw new Error('Enter an instruction of 1–8000 characters.');
                if (agent.inbox.length >= 20) throw new Error('Wait for the agent to read its pending instructions.');
                if (agent.kind === 'writer') {
                    this.writers.steer(agent.id, message);
                    recordSteer(agent, message);
                }
                else {
                    agent.inbox.push(message);
                    recordSteer(agent, message);
                }
                this.status(agent.kind === 'writer'
                    ? 'Queued — the writer reads it at its next model call.'
                    : 'Queued — the agent reads it before its next step.');
                await this.sendState(); break;
            }
            case 'stopAgent':
				if (this.agentRuns.list(this.sessionId).some((a) => a.id === msg.id)) {
					this.agentRuns.stopOne(String(msg.id));
				}
				await this.sendState();
				break;
			case 'removeQueued':
				this.queue = this.queue.filter((q) => q.id !== msg.id);
				await this.sendState();
				break;
			case 'steerQueued': {
				// "Steer" on a queued card: deliver it to the running turn now
				// instead of waiting for the turn to finish.
				const item = this.queue.find((q) => q.id === msg.id);
				if (this.run && item?.attachments.length) {
					this.status('Messages with uploads stay queued so their files reach the next turn.', '');
					await this.sendState();
					break;
				}
				this.queue = this.queue.filter((q) => q.id !== msg.id);
				if (item && (item.text.trim() || item.attachments.length)) {
					if (this.run) {
						this.run.steer.push(item.text.trim());
						this.run.convo.push({ id: newId('m'), role: 'user', content: item.text.trim(), at: Date.now() });
					} else {
						await this.handleSend(item.text.trim(), item.plan === true, item.attachments);
					}
				}
				await this.sendState();
				break;
			}
			case 'beginQueueEdit':
				if (msg.sessionId === this.sessionId && this.queue.some(q => q.id === msg.id)) this.queueEditing = msg.id;
				break;
			case 'editQueued': {
				if (msg.sessionId && msg.sessionId !== this.sessionId) {
					const item = this.sessionQueues.get(String(msg.sessionId))?.find(q => q.id === msg.id);
					if (item && typeof msg.text === 'string' && msg.text.trim()) item.text = msg.text.trim();
					break;
				}
				const item = this.queue.find((q) => q.id === msg.id);
				const text = String(msg.text ?? '').trim();
				if (this.queueEditing === msg.id) this.queueEditing = undefined;
				if (item && (text || item.attachments.length)) {
					item.text = text;
					if (!this.run && this.queue[0] === item) {
						this.queue.shift();
						await this.handleSend(item.text, item.plan, item.attachments);
					}
					await this.sendState();
				} else if (text) {
					this.postAll({ type: 'queueEditRecovered', text, sessionId: this.sessionId });
				}
				break;
			}
			case 'reorderQueued': {
				const ids: string[] = Array.isArray(msg.ids) ? msg.ids.map(String) : [];
				if (ids.length === this.queue.length && new Set(ids).size === ids.length) {
					const next: typeof this.queue = [];
					for (const id of ids) {
						const item = this.queue.find((q) => q.id === id);
						if (item) {
							next.push(item);
						}
					}
					if (next.length === this.queue.length) {
						this.queue = next;
						await this.sendState();
					}
				}
				break;
			}
			case 'compact':
				await this.compactNow();
				break;
			case 'approve':
			case 'reject': {
				this.decideApproval(String(msg.id), msg.type === 'approve');
				break;
			}
			case 'approveAlways': {
				this.decideApproval(String(msg.id), true, true);
				break;
			}
			case 'answer': {
				
				const resolve = this.questions.get(String(msg.id));
				if (resolve) {
					this.questions.delete(String(msg.id));
					resolve(typeof msg.answer === 'string' && msg.answer.trim() ? msg.answer.trim() : undefined);
				}
				break;
			}
			// Thumbnails for images you attached: from memory while fresh, else the on-disk copy.
			case 'readMessageImages': {
				const id = String(msg.id);
				const images = this.imageCache.get(id) ?? (await this.imagesFromDisk(id));
				surface.post({ type: 'messageImages', id, urls: images.map((i) => `data:${i.mime};base64,${i.base64}`) });
				break;
			}

			// ---- composer
			case 'selectModel': {
				const sessionId = this.sessionId;
				if (msg.sessionId && msg.sessionId !== sessionId) throw new Error('That model picker belongs to another chat.');
				if (this.run || this.turning) throw new Error('Wait for the current turn to finish before changing models.');
				const provider = await this.store.get(String(msg.providerId));
				if (!provider?.enabled || !provider.models.some(m => m.enabled && m.id === msg.model)) throw new Error('Choose an enabled model from an enabled provider.');
				if (this.sessionId !== sessionId || this.run || this.turning) throw new Error('The chat changed while choosing a model.');
				await this.store.setSelection(provider.id, msg.model, sessionId);
				await this.sendState();
				// Local engine: start loading the picked model now (llama-swap style), so the
				// first message does not wait for it. Queued with chat calls, never racing them.
				const picked = (await this.store.list()).find((p) => p.id === msg.providerId);
				if (picked?.preset === ENGINE_PRESET) {
					const load = this.localModelCalls.catch(() => undefined).then(() => this.localModels.ensureLoaded(String(msg.model)));
					this.localModelCalls = load.then(() => undefined, () => undefined);
					load.catch((e) => this.status('Could not preload: ' + (e instanceof Error ? e.message : String(e)), 'error'));
				}
				break;
			}
			case 'setModelFavorite':
				if (typeof msg.providerId !== 'string' || typeof msg.model !== 'string' || typeof msg.favorite !== 'boolean') throw new Error('Invalid model favorite.');
				await this.store.setModelFavorite(msg.providerId, msg.model, msg.favorite);
				await this.sendState();
				break;
			case 'setEffort':
				await this.store.setEffort(msg.providerId, msg.model, msg.effort);
				await this.sendState();
				break;
			case 'setMode':
				if (msg.mode === 'chat' || msg.mode === 'agent' || msg.mode === 'full') {
					if (msg.mode !== 'full') {
						this.comparisons.cancelAll();
						this.workflowEpoch++;
						if (this.run?.workflow) this.run.abort.abort();
						for (const run of this.agentRuns.list()) if (run.workflow) this.agentRuns.stopOne(run.id);
						// Keep each chat's saved workflow; the runtime refuses to start one without Full Access.
					}
					await this.store.setMode(msg.mode as ChatMode);
					await this.sendState();
				}
				break;
			case 'setSubagentWorkflow': {
				const workflowSession = this.sessionId, epoch = this.workflowEpoch;
				if (msg.sessionId !== workflowSession) throw new Error('The workflow settings belong to another chat.');
				const profile = normalizeWorkflow(msg.profile);
				if (profile.enabled) {
					if (this.store.getMode() !== 'full' || !this.store.getSettings().subagents) throw new Error('Enable Subagents in Settings and use Full Access to enable this workflow.');
					if (this.run || this.agentRuns.list(this.sessionId).some(r => r.status === 'running')) throw new Error('Wait for the current run to finish before changing its workflow.');
					const selected = await this.store.resolveSelection(this.sessionId);
					if (!selected.model || selected.model.tools === false || selected.provider?.apiFormat === 'acp') throw new Error('Choose a main model that supports agent tools.');
					for (const spec of workflowModels(profile)) await workflowModel(this.store, spec);
					if (this.store.getMode() !== 'full') throw new Error('Full Access changed while configuring the workflow.');
				} else {
					this.workflowEpoch++;
					if (this.run?.workflow && this.run.sessionId === this.sessionId) this.run.abort.abort();
					for (const run of this.agentRuns.list(this.sessionId)) if (run.workflow) this.agentRuns.stopOne(run.id);
				}
				await this.store.setSubagentWorkflow(workflowSession, profile, () => {
					if (workflowSession !== this.sessionId) throw new Error('The chat changed while configuring its workflow.');
					if (profile.enabled && (epoch !== this.workflowEpoch || this.store.getMode() !== 'full' || !this.store.getSettings().subagents || this.run || this.agentRuns.list(workflowSession).some(r => r.status === 'running'))) throw new Error('Access or active work changed while configuring the workflow.');
				});
				await this.sendState();
				break;
			}
			case 'setWorkflowConcurrency': {
				const sessionId = this.sessionId, epoch = this.workflowEpoch;
				if (msg.sessionId !== this.sessionId) throw new Error('This control belongs to another chat.');
				if (this.store.getMode() !== 'full') throw new Error('Workflow controls require Full Access.');
				if (!Number.isInteger(msg.limit) || msg.limit < 1 || msg.limit > 10) throw new Error('Choose 1–10 parallel workers.');
				const profile = await this.store.getSubagentWorkflow(this.sessionId);
				if (!profile.enabled) throw new Error('Enable the workflow first.');
				await this.store.setSubagentWorkflow(sessionId, { ...profile, maxConcurrency: msg.limit }, () => {
					if (this.sessionId !== sessionId || this.workflowEpoch !== epoch || this.store.getMode() !== 'full') throw new Error('The workflow changed while adjusting capacity.');
				});
				this.turnHost.tools.scheduler.setLimit(`workflow:${sessionId}`, msg.limit);
				await this.sendState();
				break;
			}
			case 'workflowRuns': {
				const items = await this.store.workflowRuns();
				for (const item of items) if (item.id === this.run?.turnId) item.status = 'running';
				surface.post({ type: 'workflowRuns', items });
				break;
			}
			case 'replayWorkflow': {
				if (this.run || this.promptStops.size || this.replayPreparing) throw new Error('Wait for the current turn to finish.');
				this.replayPreparing = true;
				const previousSession = this.sessionId, epoch = this.workflowEpoch;
				try {
				if (this.store.getMode() !== 'full' || !this.store.getSettings().subagents) throw new Error('Enable Subagents and Full Access before replaying a workflow.');
				const record = (await this.store.workflowRuns()).find(r => r.id === msg.id && r.sessionId === msg.sessionId);
				if (!record) throw new Error('This saved run is unavailable in the current project.');
				const prompt = String(msg.prompt || '').trim();
				if (!prompt || prompt.length > 100000) throw new Error('Enter the inputs for this run.');
				const profile = normalizeWorkflow({ ...record.profile, ...msg.profile, enabled: true });
				for (const spec of workflowModels(profile)) await workflowModel(this.store, spec);
				const main = await workflowModel(this.store, record.providerId + '::' + record.model);
				if (!main) throw new Error('The original main model is unavailable.');
				if (this.sessionId !== previousSession || epoch !== this.workflowEpoch || this.store.getMode() !== 'full' || this.run || this.promptStops.size) throw new Error('The chat or access changed while preparing the replay.');
				await this.newChat();
				const replaySession = this.sessionId;
				await this.store.setSelection(main.provider.id, main.model.id, this.sessionId);
				await this.store.setSubagentWorkflow(this.sessionId, profile);
				await this.sendState();
				if (this.sessionId !== replaySession || this.store.getMode() !== 'full' || this.run || this.promptStops.size) throw new Error('The chat changed before the replay started.');
				this.replayPreparing = false;
				surface.post({ type: 'workflowReplayStarted' });
				await this.onSend(msg.resume === true ? `${prompt}\n\nContinue this previous run after inspecting the current project. Do not repeat completed actions blindly. Previous partial report:\n${record.report}` : prompt, false);
				} catch (e) { surface.post({ type: 'workflowReplayFailed', message: e instanceof Error ? e.message : String(e) }); throw e; }
				finally { this.replayPreparing = false; }
				break;
			}
			case 'fullscreen':
				this.fullscreenToggler?.(typeof msg.on === 'boolean' ? msg.on : undefined);
				if (msg.on === false) {
					// The sidebar chat plays its "settle in" once VS Code has left Zen mode.
					setTimeout(() => this.postAll({ type: 'fsArrive' }), 220).unref?.();
				}
				break;

			// ---- providers
			// ---- settings, memory, usage
			case 'updateSettings':
				if (msg.patch?.subagents === false) {
					this.workflowEpoch++;
					if (this.run?.workflow) this.run.abort.abort();
					for (const run of this.agentRuns.list()) if (run.workflow) this.agentRuns.stopOne(run.id);
				}
				await this.store.updateSettings(msg.patch ?? {});
				if (msg.patch && 'usageBudgetAlerts' in msg.patch) await this.usage.checkBudgetAlerts();
				// The master switch loads or unloads every mod (timers and band included).
				await this.applyServices();
				await this.sendState();
				if (msg.patch && 'background' in msg.patch) {
					this.appearance.sendImage(undefined);
				}
				break;
			case 'saveMemory': {
				// Add from the Memory page composer, or edit an existing fact.
				const text = String(msg.text ?? '').trim();
				const area = msg.area === 'solution' ? 'solution' : 'fact';
				if (msg.id) {
					await this.store.updateMemory(String(msg.id), { text, category: msg.category, area });
				} else if (text) {
					await this.store.retainMemory(text, { category: msg.category, area, source: 'user' });
					this.status(area === 'solution' ? 'Solution saved.' : 'Memory saved.');
				}
				await this.sendState();
				break;
			}
			case 'updateMemory':
				await this.store.updateMemory(String(msg.id), msg.patch ?? {});
				await this.sendState();
				break;
			case 'deleteMemory':
				await this.store.deleteMemory(String(msg.id));
				await this.sendState();
				break;
			case 'promoteMemory': {
				// A lesson becomes a project rule: AGENTS.md reaches every agent and teammate; the memory is archived so it is not sent twice.
				const root = workspaceRoot();
				const memory = (await this.store.getMemories()).find((m) => m.id === String(msg.id));
				if (!root || root.scheme !== 'file' || !memory) { this.status(root ? 'That memory no longer exists.' : 'Open a project folder first.', 'error'); break; }
				try {
					const added = addProjectInstruction(root.fsPath, memory.text);
					await this.store.updateMemory(memory.id, { archived: true });
					this.status(added ? 'Added to AGENTS.md under “Learned from corrections”; the memory is archived.' : 'AGENTS.md already has that line; the memory is archived.', 'ok');
				} catch (error) {
					this.status(error instanceof Error ? error.message : String(error), 'error');
				}
				await this.sendState();
				break;
			}
			case 'forgetChatMemories': {
				const removed = await this.store.forgetMemoriesFrom(String(msg.sessionId ?? ''));
				this.status(removed ? `Forgot ${removed} ${removed === 1 ? 'memory' : 'memories'} saved by that chat.` : 'That chat saved no memories.', removed ? 'ok' : '');
				await this.sendState();
				break;
			}
			case 'clearMemories':
				await this.store.clearMemories();
				this.status('All memories for this workspace were cleared.');
				await this.sendState();
				break;
			case 'memoryDuplicates': {
				if (!this.store.getSettings().embeddingProvider) {
					surface.post({ type: 'memoryDuplicates', groups: [] });
					this.status('Choose an embedding model in Settings → Features to compare memories by meaning.', 'error');
					break;
				}
				this.status('Comparing memories…', '');
				try {
					const groups = await this.store.findMemoryDuplicates(Number(msg.threshold) || 0.88);
					surface.post({ type: 'memoryDuplicates', groups: groups.map((group) => ({ keep: publicMemory(group.keep), others: group.others.map(publicMemory), similarity: group.similarity })) });
					this.status(groups.length ? `${groups.length} group${groups.length === 1 ? '' : 's'} of similar memories — review them below.` : 'No similar memories found.', groups.length ? 'ok' : '');
				} catch (error) {
					surface.post({ type: 'memoryDuplicates', groups: [] });
					this.status(`Could not compare memories: ${error instanceof Error ? error.message : String(error)}`, 'error');
				}
				break;
			}
			case 'archiveMemories':
				await this.store.archiveMemories(Array.isArray(msg.ids) ? msg.ids.map(String) : []);
				await this.sendState();
				break;
			case 'mergeMemories':
				await this.store.mergeMemories(String(msg.keepId ?? ''), Array.isArray(msg.ids) ? msg.ids.map(String) : []);
				this.status('Merged the similar memories; the copies are archived and can be restored.', 'ok');
				await this.sendState();
				break;
			case 'pinSkill': {
				if (!this.store.getSettings().skills) {
					this.status('Skills are turned off (Settings → Plugins & Skills).', 'error');
					break;
				}
				const name = String(msg.name ?? '').trim().toLowerCase();
				const info = this.skills.list().find((skill) => skill.name === name && skill.enabled);
				if (!info) {
					this.status('That skill is no longer available.', 'error');
					break;
				}
				const session = await this.store.getSession(this.sessionId);
				const pinned = new Set(session?.pinnedSkills ?? []);
				msg.pinned === false ? pinned.delete(info.name) : pinned.add(info.name);
				if (pinned.size > 10) {
					this.status('At most 10 skills can be pinned in one chat. Unpin one first.', 'error');
					break;
				}
				await this.store.updateSession(this.sessionId, { pinnedSkills: [...pinned] });
				this.status(msg.pinned === false ? `Unpinned “${info.name}” for this chat.` : `Pinned “${info.name}” — it stays active in this chat.`, 'ok');
				await this.sendState();
				break;
			}
			case 'getUsage':
				surface.post({ type: 'usageData', ...(await this.usage.usageData([1, 7, 30, 90].includes(Number(msg.days)) ? Number(msg.days) : 30)) });
				break;
			case 'getUsageModel':
				if (typeof msg.providerId === 'string' && typeof msg.model === 'string' && msg.providerId.length <= 200 && msg.model.length <= 500) {
					try {
						surface.post({ type: 'usageModelData', requestId: msg.requestId, ...(await this.usage.modelDetails(Number(msg.days), msg.providerId, msg.model)) });
					} catch (e) {
						surface.post({ type: 'usageModelData', requestId: msg.requestId, error: e instanceof Error ? e.message : String(e) });
					}
				}
				break;
			case 'exportUsage': {
				try {
					const data = await this.usage.usageData(Number(msg.days));
					const filename = `usage${msg.attempts === true ? '-requests' : ''}-${data.days}d-${new Date(data.at).toISOString().slice(0, 10)}.csv`;
					const csv = msg.attempts === true ? await this.usage.requestsCsv(data.days) : usageCsv(data);
					if (surface.kind === 'remote') {
						surface.post({ type: 'usageCsv', filename, csv });
					} else {
						const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
						const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(base, filename), filters: { CSV: ['csv'] }, title: 'Export usage statistics' });
						if (target) await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(csv));
						surface.post({ type: 'usageExportDone', cancelled: !target });
						if (target) this.status('Usage statistics exported.');
					}
				} catch (e) {
					surface.post({ type: 'usageExportDone', error: e instanceof Error ? e.message : String(e) });
				}
				break;
			}

			case 'rebuildIndex':
				await this.rebuildIndex();
				break;

			// ---- settings window
			case 'openSettings':
				this.openSettings(typeof msg.section === 'string' ? msg.section : undefined);
				break;
			case 'closeSettings':
				this.settingsCloser?.();
				break;

			
			

			// ---- remote + browser
			case 'remoteInstallHelper':
				// One click: download + install cloudflared, then open the link if "Anywhere" is on.
				try {
					await this.tunnel.install();
					this.status('Secure link helper installed — ready.');
					await this.applyServices();
				} catch (e) {
					this.status('Could not install the helper: ' + (e instanceof Error ? e.message : String(e)), 'error');
				}
				await this.sendState();
				break;
			case 'remotePairCode':
				this.remote.newPairCode();
				await this.sendState();
				break;
			case 'remoteRegenerate':
				await (isDesktopHost() ? this.context.workspaceState : this.context.globalState).update(REMOTE_TOKEN_KEY, newRemoteToken());
				this.remote.revokeAll();
				await this.applyServices(true);
				this.status('New pairing link created — previously paired phones are signed out.');
				await this.sendState();
				break;
			case 'remoteRevoke':
				if (this.remote.revokeDevice(String(msg.id))) this.status('That phone was signed out.');
				await this.sendState();
				break;
			case 'browserTest':
            case 'browserPreview': {
                if (!desktopServicesOwned()) throw new Error('Open the window that owns this project’s browser.');
                if (!this.store.getSettings().browserAgent) throw new Error('Enable Browser agent first.');
                if (this.run || this.agentRuns.list().some(a => a.status === 'running')) throw new Error('Wait until agent work finishes before refreshing the browser preview.');
                this.status('Connecting to the browser…');
                try { await this.browser.snapshot(); this.status('Browser launch and screenshot passed.', 'ok'); }
                catch (error) { this.status('Browser check failed: ' + (error instanceof Error ? error.message : String(error)) + '. Check the executable path, close the agent browser and retry.', 'error'); }
                await this.sendState(); break;
            }
            case 'browserClose':
				await this.browser.close();
				await this.sendState();
				break;
		}
	}

	// ------------------------------------------------------------ mic

	// ------------------------------------------------------------ sessions

	private async loadCurrent(): Promise<void> {
		const previous = this.sessionId;
		this.sessionId = await this.store.currentSessionId();
		// Grants are session-scoped: switching chats drops them (the pending approvals too).
		if (previous !== this.sessionId) this.sessionGrants.clear();
		this.attachments.selectSession(this.sessionId);
		this.messages = await this.store.loadMessages(this.sessionId);
		if (this.run?.sessionId !== this.sessionId) await this.recoverCurrent();
		this.lastContext = undefined;
		await this.sendState();
	}

	private async recoverCurrent(): Promise<void> {
		const liveCards = new Set(this.agentRuns.list(this.sessionId).filter(run => run.status === 'running').map(run => run.card.id));
		const interrupted = new Set(this.messages.filter(message => message.turn && !message.turn.endedAt).map(message => message.id));
		if (recoverInterrupted(this.messages, liveCards, Date.now(), new Set(this.turnSnapshots.keys()))) {
			const transcript = interrupted.size ? this.transcripts.load(this.sessionId) : undefined;
			if (transcript) {
				recoverTranscript(transcript, this.messages, interrupted);
				this.transcripts.save(this.sessionId, transcript);
			}
			await this.store.saveMessages(this.sessionId, this.messages);
		}
	}

	async newChat(): Promise<void> {
		await this.ready;
		this.cancelRun();
		this.sessionQueues.set(this.sessionId, this.queue);
		this.queueEditing = undefined;
		this.queue = [];
		await this.store.createSession();
		await this.loadCurrent();
		this.postAll({ type: 'focusInput' });
	}

	/** Full-size settings in the editor area; phones use the in-page popup. */
	openSettings(section?: string): void {
		if (this.settingsOpener) {
			this.settingsOpener(section);
		} else {
			this.postAll({ type: 'openSettings', section });
		}
	}

	// ------------------------------------------------------------ turns (Undo / Review → src/host/turnHistory.ts)

	private async finishTurn(user: StoredMessage, snapshots: Map<string, string | null>, sessionId = this.sessionId): Promise<void> {
		this.turnSnapshots.delete(user.id);
		await this.history.finish(user, snapshots, sessionId);
		if (user.turn?.outcome === 'completed' && this.store.getSettings().memoryAutoSave && this.memoryCapture.get(sessionId) !== user.id) {
			this.memoryCapture.set(sessionId, user.id);
			// After the turn is saved, so the extractor reads the finished exchange.
			const timer = setTimeout(() => void this.autoCaptureMemory(sessionId).catch(() => undefined), 4_000);
			timer.unref?.();
		}
	}

	/**
	 * Optional background capture: a local helper model reads the finished
	 * exchange and proposes durable facts and solutions. Only the local helper
	 * runs (no cloud bill), the filter rejects transient and sensitive text, and
	 * exact duplicates are absorbed by retainMemory.
	 */
	private async autoCaptureMemory(sessionId: string): Promise<void> {
		const settings = this.store.getSettings();
		if (!settings.memoryAutoSave || settings.agentMemory === false) return;
		const helper = await localHelper(this.store, 'text');
		if (!helper) return;
		const messages = (await this.store.loadMessages(sessionId)).filter((message) => !message.kind && !message.local).slice(-6);
		if (messages.length < 2) return;
		let text = messages.map((message) => `${message.role}: ${(message.apiContent ?? message.content).slice(0, 4000)}`).join('\n\n');
		if (text.length > 24_000) text = text.slice(-24_000);
		const result = await this.callModel(helper.provider, helper.apiKey, {
			model: helper.model.id,
			system:
				'You extract durable memory from a finished coding chat. Return ONLY JSON: {"facts":[{"text":"...","area":"fact"}]}. ' +
				'At most 3 entries. Keep only stable user preferences, project conventions, verified commands, or a recurring problem and the fix that worked (area "solution"). ' +
				'Do not include transient paths, ports, command output, summaries of what the agent did, credentials, health, religion, politics or finances. ' +
				'Each entry stands alone, under 300 characters. Return {"facts":[]} when nothing qualifies.',
			messages: [{ role: 'user', content: text }],
			maxTokens: 700,
			signal: AbortSignal.timeout(60_000)
		}, () => {
			// A background capture must not change the status line under the finished answer.
		});
		const items = parseMemoryExtraction(result.text).filter((item) => worthRemembering(item.text) && (settings.memorySensitive || !looksSensitive(item.text)));
		let saved = 0;
		for (const item of items) {
			try {
				await this.store.retainMemory(item.text, { area: item.area, source: 'agent', sourceSessionId: sessionId, auto: true });
				saved++;
			} catch {
				// A full memory is reported on the Memory page; capture never blocks a turn.
			}
		}
		if (saved) this.scheduleState();
	}

	// ------------------------------------------------------------ writing assistance

	/** Command palette: "New task in a Git worktree". */
	worktreeAction(action: string, task?: string): Promise<void> {
		return this.worktreesHost.action(action, task);
	}

	/** GLM-OCR through the first Z.ai / BigModel provider with a key (undefined = no OCR). */
	private async ocrFor(signal: AbortSignal): Promise<((bytes: Buffer, mime: string) => Promise<string>) | undefined> {
		for (const p of await this.store.list()) {
			const url = ocrEndpoint(p.baseUrl);
			const key = url ? await this.store.getApiKey(p.id) : undefined;
			if (url && key) {
				return (bytes, mime) => glmOcr({ url, apiKey: key }, bytes, mime, signal);
			}
		}
		return undefined;
	}

	/** The code index for the open workspace (created on first use). */
	private codeIndex(): CodeIndex | undefined {
		const root = workspaceRoot();
		if (!root || root.scheme !== 'file') {
			return undefined;
		}
		if (this.codeIdx?.root !== root.fsPath) {
			const list = async () => {
				const rg = await rgFiles(root.fsPath, '', 50_000, denyGlobs(this.store.getSettings().denyPaths));
				if (rg) {
					return rg.files;
				}
				const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), '**/{node_modules,.git,out,dist,build}/**', 20_000);
				return uris.map((u) => vscode.workspace.asRelativePath(u, false));
			};
			this.codeIdx = { root: root.fsPath, index: new CodeIndex(CodeIndex.fileFor(this.context.globalStorageUri.fsPath, root.fsPath), root.fsPath, list) };
		}
		return this.codeIdx.index;
	}

	private async embedTarget(): Promise<EmbedTarget | undefined> {
		const s = this.store.getSettings();
		if (!s.embeddingProvider) {
			return undefined;
		}
		// Private code search: embeddings (and the reranker) on this computer.
		if (s.embeddingProvider === 'local') {
			return this.localModels.privateSearchTarget();
		}
		const p = (await this.store.list()).find((x) => x.id === s.embeddingProvider);
		if (!p || p.apiFormat !== 'openai') {
			return undefined;
		}
		return { baseUrl: p.baseUrl, apiKey: (await this.store.getApiKey(p.id)) ?? '', model: s.embeddingModel.trim() || 'text-embedding-3-small' };
	}

	private async searchCode(query: string, limit: number, signal?: AbortSignal) {
		const index = this.codeIndex();
		if (!index) {
			throw new Error('The code index needs a local workspace folder.');
		}
		let embed: EmbedTarget | undefined;
		try {
			embed = await this.embedTarget();
			return await index.search(query, limit, embed, signal);
		} catch (error) {
			if (!embed) {
				throw error;
			}
			// Embeddings failing (quota, network) must not break search: fall back to keywords.
			this.status(`Code index embeddings failed — using keywords only: ${error instanceof Error ? error.message : error}`, 'error');
			return index.search(query, limit, undefined, signal);
		}
	}

	private async rebuildIndex(): Promise<void> {
		const index = this.codeIndex();
		if (!index) {
			throw new Error('Open a local folder to build the code index.');
		}
		index.clear();
		this.indexStatus = 'building';
		await this.sendState();
		try {
			await index.refresh(await this.embedTarget());
			const st = index.stats();
			this.status(`Code index ready: ${st?.files ?? 0} files, ${st?.chunks ?? 0} chunks${st?.embedded ? ` (${st.embedded} embedded)` : ''}.`);
		} finally {
			this.indexStatus = '';
			await this.sendState();
		}
	}

	/** Your MCP servers plus the ones enabled plugins declare. */
	private mcpConfigs() {
		if (!desktopServicesOwned()) return [];
		return [...this.store.getMcpServers(), ...this.plugins.mcpServers()];
	}

	/** Your hooks plus the ones enabled plugins declare. */
	private allHooks() {
		return [...this.store.getHooks(), ...this.plugins.hooks()];
	}

	private async switchSession(id: string): Promise<void> {
		const session = await this.store.getSession(id);
		if (!session) {
			this.status('That chat no longer exists.', 'error');
			return;
		}
		const folder = normalizeProjectPath(session.projectPath);
		const uri = workspaceRoot();
		const root = uri?.scheme === 'file' ? normalizeProjectPath(uri.fsPath) : undefined;
		if (folder && (!root || projectPathKey(folder) !== projectPathKey(root))) {
			// Direct callbacks bypass feature dispatch. Route before cancelling this window's run.
			await this.projects.routeSession(id);
			return;
		}
		if (id === this.sessionId) {
			return;
		}
		this.warmer.cancel();
		this.cancelRun();
		this.sessionQueues.set(this.sessionId, this.queue);
		this.queue = this.sessionQueues.get(id) ?? [];
		this.sessionQueues.delete(id);
		this.queueEditing = undefined;
		await this.store.setCurrentSession(id);
		await this.loadCurrent();
		// Background agents of this chat finished while it was in the background.
		if (this.agentRuns.hasNotices(id)) this.wakeForAgents(id);
	}

	/** Accept / Reject from the review diff's editor title buttons. */
	resolveReview(accept: boolean): void {
		const id = this.reviews.activeId();
		const resolve = id ? this.approvals.get(id) : undefined;
		if (resolve && id) {
			this.approvals.delete(id);
			resolve(accept);
		}
	}

	/** Abort the active run and release anything waiting on the user. */
	cancelRun(): void {
		for (const stop of this.promptStops) stop.abort();
		for (const resolve of this.approvals.values()) {
			resolve(false);
		}
		this.approvals.clear();
		for (const resolve of this.questions.values()) {
			resolve(undefined);
		}
		this.questions.clear();
		this.run?.abort.abort();
	}

	// ------------------------------------------------------------ context

	/** Contents of every @mention: files, folders, path:line, and @selection / @problems / @changes / @open. */
	private async resolveMentions(text: string): Promise<Array<{ name: string; content: string }>> {
		return resolveMentions(text, () => this.workspace.workspaceFiles(), workspaceRoot(), resolveInWorkspace);
	}

	private skillMentionNames(text: string): Set<string> {
		return new Set([...text.matchAll(/(?:^|\s)\$([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?)/gi)].map((m) => m[1].toLowerCase()));
	}

	/** $skill-name tokens in the message load those skills into the turn. */
	private resolveSkillMentions(text: string): string {
		if (!this.store.getSettings().skills) {
			return '';
		}
		const blocks: string[] = [];
		for (const name of this.skillMentionNames(text)) {
			const skill = this.skills.read(name, 'user');
			if (skill) {
				blocks.push(`<skill name="${skill.info.name}">\n${skill.body}\n</skill>`);
			}
		}
		return blocks.join('\n\n');
	}

	/** Skills pinned for this chat stay active on every turn, within a bounded budget. */
	private async resolvePinnedSkills(mentioned: Set<string>): Promise<{ text: string; names: Set<string> }> {
		const active = new Set<string>();
		if (!this.store.getSettings().skills) {
			return { text: '', names: active };
		}
		const names = (await this.store.getSession(this.sessionId))?.pinnedSkills ?? [];
		const blocks: string[] = [];
		let budget = 60_000;
		for (const name of names) {
			if (mentioned.has(name) || budget <= 0) continue;
			const skill = this.skills.read(name, 'settings');
			if (!skill || !skill.info.enabled) continue;
			const body = skill.body.slice(0, Math.min(30_000, budget));
			budget -= body.length;
			active.add(skill.info.name);
			blocks.push(`<skill name="${skill.info.name}" pinned="true">\n${body}\n</skill>`);
		}
		return { text: blocks.join('\n\n'), names: active };
	}

	/** A skill whose declared triggers match the message is offered before the model answers. */
	private resolveSuggestedSkills(text: string, mentioned: Set<string>, pinned: Set<string>): string {
		if (!this.store.getSettings().skills) {
			return '';
		}
		const suggestions = this.skills.suggest(text, 3).filter((skill) => !mentioned.has(skill.name) && !pinned.has(skill.name));
		if (!suggestions.length) {
			return '';
		}
		return `<suggested-skills>\nA skill matches this message. Load it with the \`skill\` tool before following its procedure:\n${suggestions.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')}\n</suggested-skills>`;
	}

	/** /pin-skill, /unpin-skill and /skills answer in the chat; they never reach a model. */
	private async runSkillCommand(text: string): Promise<boolean> {
		const match = text.match(/^\/(pin-skill|unpin-skill|skills)(?:\s+([\s\S]*))?$/);
		if (!match) return false;
		const [, command, argument = ''] = match;
		if (!this.store.getSettings().skills) {
			await this.localReply(text, 'Skills are turned off (Settings → Plugins & Skills).');
			return true;
		}
		if (command === 'skills') {
			const session = await this.store.getSession(this.sessionId);
			const pinned = new Set(session?.pinnedSkills ?? []);
			const enabled = this.skills.list().filter((skill) => skill.enabled);
			if (!enabled.length) {
				await this.localReply(text, 'No skills are available. Add one in Settings → Plugins & Skills.');
				return true;
			}
			const lines = enabled.map((skill) => `- ${pinned.has(skill.name) ? '📌 ' : ''}${skill.name} — ${skill.description}`);
			await this.localReply(text, `${pinned.size ? `${pinned.size} pinned in this chat (📌). ` : ''}Available skills:\n${lines.join('\n').slice(0, 12_000)}`);
			return true;
		}
		const name = argument.trim().toLowerCase();
		if (!name) {
			await this.localReply(text, `Usage: /${command} <skill-name>. Type /skills to list them.`);
			return true;
		}
		const info = this.skills.list().find((skill) => skill.name === name || skill.id === argument.trim());
		if (!info || !info.enabled) {
			const close = this.skills.list().filter((skill) => skill.enabled && skill.name.includes(name)).slice(0, 5).map((skill) => skill.name);
			await this.localReply(text, `No enabled skill named “${name}”.${close.length ? ` Did you mean: ${close.join(', ')}?` : ' Type /skills to list them.'}`);
			return true;
		}
		const session = await this.store.getSession(this.sessionId);
		const pinned = new Set(session?.pinnedSkills ?? []);
		command === 'pin-skill' ? pinned.add(info.name) : pinned.delete(info.name);
		if (pinned.size > 10) {
			await this.localReply(text, 'At most 10 skills can be pinned in one chat. Unpin one first with /unpin-skill.');
			return true;
		}
		await this.store.updateSession(this.sessionId, { pinnedSkills: [...pinned] });
		await this.localReply(text, command === 'pin-skill'
			? `Pinned “${info.name}” for this chat. It stays active on every turn; /unpin-skill ${info.name} removes it.`
			: `Unpinned “${info.name}”. It is still available with $${info.name} or the skill tool.`);
		return true;
	}

	// ------------------------------------------------------------ sending

	private async onSend(text: string, plan: boolean): Promise<void> {
		if (this.comparisons.mutating || this.hunks.busy) throw new Error('Wait for the current review action to finish before sending a message.');
		if (this.replayPreparing) { this.status('The workflow replay is being prepared. Please wait.', ''); return; }
		
		const trimmed = text.trim();
		if (!trimmed && !this.attachments.items.length) {
			return;
		}
		if (await this.runSkillCommand(trimmed)) {
			return;
		}
		if (await this.runGoalCommand(trimmed, plan)) {
			return;
		}
		if (this.run) {
			const mode = this.store.getSettings().followUp;
			if (mode === 'steer' && trimmed && !this.attachments.items.length) {
				// Delivered to the model right after the current tool call(s).
			this.run.steer.push(trimmed);
			this.run.convo.push({ id: newId('m'), role: 'user', content: trimmed, at: Date.now() });
			this.scheduleState();
			return;
			}
			const attachments = this.attachments.items.map((a) => ({ ...a }));
			this.attachments.clear();
			if (mode === 'interrupt') {
				this.queue.unshift({ id: newId('q'), text: trimmed, plan, attachments });
				this.cancelRun();
				await this.sendState();
				return;
			}
			this.queue.push({ id: newId('q'), text: trimmed, plan, attachments });
			await this.sendState();
			return;
		}
		if (this.sending > 0) {
			// A send is still being prepared: it becomes the next turn, and this
			// one follows it. Starting both at once would interleave two turns.
			const attachments = this.attachments.items.map((a) => ({ ...a }));
			this.attachments.clear();
			this.queue.push({ id: newId('q'), text: trimmed, plan, attachments });
			await this.sendState();
			return;
		}
		await this.handleSend(trimmed, plan);
	}

	/** Keep a message's images on disk (bounded to 400 files) so chat thumbnails survive a reload. */
	private async persistImages(messageId: string, images: MessageImage[]): Promise<void> {
		const ext: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/webm': 'webm', 'audio/wav': 'wav' };
		try {
			await fs.promises.mkdir(this.imagesDir, { recursive: true });
			for (const [i, img] of images.entries()) {
				await fs.promises.writeFile(path.join(this.imagesDir, `${messageId}-${i}.${ext[img.mime] ?? 'png'}`), Buffer.from(img.base64, 'base64'));
			}
			const names = await fs.promises.readdir(this.imagesDir);
			if (names.length > 400) {
				const aged: Array<[string, number]> = [];
				for (const n of names) {
					aged.push([n, (await fs.promises.stat(path.join(this.imagesDir, n))).mtimeMs]);
				}
				aged.sort((a, b) => a[1] - b[1]);
				for (const [n] of aged.slice(0, aged.length - 400)) {
					await fs.promises.rm(path.join(this.imagesDir, n), { force: true });
				}
			}
		} catch {
			/* thumbnails are a nicety — a failed write never fails a send */
		}
	}

	/**
	 * An image / video made with a local Studio model and approved in the chat's popup: the
	 * prompt with the result attached, plus a short note — display-only (`local`), so it is
	 * never sent to a model; the file is kept like any attached image.
	 */
	private async insertMedia(media: { prompt: string; mime: string; base64: string; name: string; caption: string }): Promise<void> {
		const convo = this.run?.convo ?? this.messages;
		const user: StoredMessage = { id: newId('m'), role: 'user', content: media.prompt, attachments: [media.name], at: Date.now(), local: true };
		const images: MessageImage[] = [{ mime: media.mime, base64: media.base64, name: media.name }];
		this.imageCache.set(user.id, images);
		await this.persistImages(user.id, images);
		convo.push(user, { id: newId('m'), role: 'assistant', content: media.caption, at: Date.now(), local: true });
		await this.store.saveMessages(this.run?.sessionId ?? this.sessionId, convo);
		await this.sendState();
	}

	/** The on-disk images of a message (for the chat's thumbnails). */
	private async imagesFromDisk(messageId: string): Promise<MessageImage[]> {
		if (!/^[\w-]{1,64}$/.test(messageId)) {
			return [];
		}
		const mimes: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', webm: 'video/webm', wav: 'audio/wav' };
		try {
			const names = (await fs.promises.readdir(this.imagesDir)).filter((n) => n.startsWith(messageId + '-'));
			names.sort((a, b) => (parseInt(a.slice(messageId.length + 1), 10) || 0) - (parseInt(b.slice(messageId.length + 1), 10) || 0));
			return await Promise.all(
				names.map(async (n) => ({
					mime: mimes[n.split('.').pop() ?? ''] ?? 'image/png',
					base64: (await fs.promises.readFile(path.join(this.imagesDir, n))).toString('base64'),
					name: n
				}))
			);
		} catch {
			return [];
		}
	}

	/** /goal <objective> sets the chat's goal and sends the objective as the prompt; /goal status and /goal off answer here. */
	private async runGoalCommand(text: string, plan: boolean): Promise<boolean> {
		const goal = parseGoalCommand(text);
		if (!goal) return false;
		if (goal.kind === 'set') {
			await this.store.setGoal(this.sessionId, newGoal(goal.objective, Date.now(), { check: goal.check, rounds: goal.rounds }));
			await this.onSend(goal.objective, plan);
			return true;
		}
		const current = await this.store.getGoal(this.sessionId);
		const clearing = goal.kind === 'clear' && current?.status === 'active';
		if (clearing) await this.store.setGoal(this.sessionId, { ...current, status: 'stopped', endedAt: Date.now(), note: 'Stopped by the user.' });
		await this.localReply(text, goal.kind === 'show' ? describeGoal(current) : clearing ? 'Goal cleared. The agent finishes turns as usual.' : 'No goal is active.');
		return true;
	}

	/** A command answered in the chat only: neither line is sent to the model. */
	private async localReply(text: string, reply: string): Promise<void> {
		const convo = this.run?.convo ?? this.messages;
		convo.push({ id: newId('m'), role: 'user', content: text, at: Date.now(), local: true });
		convo.push({ id: newId('m'), role: 'assistant', content: reply, at: Date.now(), local: true });
		await this.store.saveMessages(this.run?.sessionId ?? this.sessionId, convo);
		this.scheduleState();
	}

	

	private async handleSend(trimmed: string, plan: boolean, queuedAttachments?: PendingAttachment[]): Promise<void> {
		// Read before the first await: the channel that sent this message, not a later one.
		
		
		const promptStop = new AbortController();
		this.promptStops.add(promptStop);
		const pending = queuedAttachments ?? this.attachments.items.map((a) => ({ ...a }));
		const sendingSession = this.sessionId;
		let consumed = false;
		this.sending++;
		try {
		const { provider, model } = await this.store.resolveSelection(this.sessionId);
		const problem = await this.checkReady(provider, model);
		const mentions = await this.resolveMentions(trimmed);
		const files = [...pending.filter((a) => a.kind === 'text').map((a) => ({ name: a.name, content: a.content ?? '' })), ...mentions];
		const images = pending
			.filter((a) => a.kind === 'image' && a.mime && a.base64)
			.map((a) => ({ name: a.name, mime: a.mime as string, base64: a.base64 as string }));
		const mentionedSkills = this.skillMentionNames(trimmed);
		const skillText = this.resolveSkillMentions(trimmed);
		const pinned = await this.resolvePinnedSkills(mentionedSkills);
		const suggestedSkills = this.resolveSuggestedSkills(trimmed, mentionedSkills, pinned.names);
		// UserPromptSubmit hooks can add context or block the prompt.
		const hooks = this.allHooks();
		let hookContext = '';
		// SessionStart fires once per chat, on its first turn; its stdout joins the prompt like UserPromptSubmit's.
		if (hooks.some((h) => h.enabled && h.event === 'SessionStart') && !this.messages.some((m) => m.role === 'user' && !m.kind)) {
			const res = await runHooks(hooks, 'SessionStart', { session_id: this.sessionId, workspace: workspaceRoot()?.fsPath ?? '' }, workspaceRoot()?.fsPath, undefined, promptStop.signal);
			if (res.context) hookContext += (hookContext ? '\n' : '') + `<session-start>\n${res.context}\n</session-start>`;
		}
		if (hooks.some((h) => h.enabled && h.event === 'UserPromptSubmit')) {
			const res = await runHooks(hooks, 'UserPromptSubmit', { session_id: this.sessionId, workspace: workspaceRoot()?.fsPath ?? '', prompt: trimmed }, workspaceRoot()?.fsPath, undefined, promptStop.signal);
			if (res.blocked) {
				this.messages.push({ id: newId('m'), role: 'user', content: trimmed, at: Date.now() });
				await this.pushError(`A UserPromptSubmit hook blocked this message:\n\n${res.feedback}`);
				return;
			}
			hookContext = res.context ? `<hook-context>\n${res.context}\n</hook-context>` : '';
		}
		// Mods see the prompt too: classic.UserPromptSubmit observes it, prompt.submit
		// can rewrite the text, add agent-only context, or drop the send.
		
		
		// Custom slash commands (.zer0ne/commands, .claude/commands, .opencode/command, plugins).
		const slash = trimmed.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
		// Immediate mod commands already ran in onSend (or here, from the queue).
		if (slash && (await this.runSkillCommand(trimmed))) {
			return;
		}
		// A regular mod command: its command.run hook runs first, then the message
		// reaches the agent — with what the hook returned in { text } as context.
		
		const command = slash ? this.plugins.commands().find((c) => c.name === slash[1]) : undefined;
		const prompt = command ? expandCommand(command.body, slash?.[2] ?? '') : trimmed;
		const redact = (s: string) => (this.store.getSettings().redactSecrets ? redactSecrets(s).text : s);
		const parts = [...files.map((f) => `<file path="${f.name}">\n${redact(f.content)}\n</file>`), pinned.text, skillText, suggestedSkills, hookContext].filter(Boolean);
		if (this.sessionId !== sendingSession) return;
		const user: StoredMessage = {
			id: newId('m'),
			role: 'user',
			content: trimmed || '(see attachments)',
			at: Date.now(),
			attachments: pending.length ? pending.map((a) => a.name) : undefined,
			apiContent: parts.length || command ? [...parts, prompt || 'See the attached files.'].join('\n\n') : undefined
		};
		if (images.length) {
			this.imageCache.set(user.id, images);
			// Only the newest turns need their images again (retries, the next request).
			while (this.imageCache.size > 16) {
				this.imageCache.delete(this.imageCache.keys().next().value!);
			}
			void this.persistImages(user.id, images);
		}
		if (!queuedAttachments) {
			const consumed = new Set(pending.map((a) => a.id));
			this.attachments.items = this.attachments.items.filter((a) => !consumed.has(a.id));
		}
		consumed = true;
		this.messages.push(user);
		// The user's own links join the provenance set (the webfetch guard's allowlist, and the
		// only way web_fetch reaches a local or private address).
		const shared = this.urlProvenance(this.sessionId) as Set<string>;
		for (const u of extractUrls(user.apiContent ?? user.content)) {
			shared.add(u);
		}
		if (problem) {
			await this.pushError(problem);
			return;
		}
		promptStop.signal.throwIfAborted();
		await this.runTurn(user, plan);
		} catch (error) {
			if (!promptStop.signal.aborted) throw error;
		} finally {
			this.promptStops.delete(promptStop);
			this.sending--;
			// A blocked hook or pre-send failure must not discard a queued upload.
			// Once stored on the user message, retry uses apiContent and imageCache.
			if (queuedAttachments && !consumed && this.sessionId === sendingSession) {
				const ids = new Set(this.attachments.items.map((a) => a.id));
				this.attachments.items.push(...pending.filter((a) => !ids.has(a.id)));
				await this.sendState();
			}
		}
	}

	private async retry(plan: boolean): Promise<void> {
		if (this.run) {
			return;
		}
		const index = this.messages.map((m) => m.role === 'user' && !m.kind && !m.local).lastIndexOf(true);
		if (index < 0) {
			return;
		}
		const { provider, model } = await this.store.resolveSelection(this.sessionId);
		const problem = await this.checkReady(provider, model);
		if (problem) {
			await this.pushError(problem);
			return;
		}
		this.messages.splice(index + 1);
		await this.runTurn(this.messages[index], plan);
	}

	private async checkReady(provider?: ProviderConfig, model?: ModelEntry): Promise<string | undefined> {
		if (!provider) {
			return 'No provider is configured yet. Open **Providers & models** (⚙) to add one.';
		}
		if (provider.apiFormat === 'vscode-lm') {
			return model ? undefined : `"${provider.name}" has no models yet. Open **Providers & models** → Fetch models.`;
		}
		// An agent signs in by itself (no key) and works inside a folder.
		if (provider.apiFormat === 'acp') {
			if (!model) return `"${provider.name}" has no models yet. Open **Providers & models** and sign in again.`;
			return workspaceRoot() ? undefined : `${provider.name} is an agent: it works inside a folder. Open one first (File → Open Folder).`;
		}
		if (!provider.baseUrl) {
			return `"${provider.name}" has no Base URL. Set it in **Providers & models**.`;
		}
		if (!model) {
			return `"${provider.name}" has no enabled models. Add or enable one in **Providers & models**.`;
		}
		let key: string | undefined;
		try {
			key = await this.store.getApiKey(provider.id);
		} catch (e) {
			// A subscription sign-in that could not be refreshed.
			return `${e instanceof Error ? e.message : String(e)} Open **Providers & models** → ${provider.name} → Sign in again.`;
		}
		if (!key && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(provider.baseUrl)) {
			return `No API key is stored for "${provider.name}". Add it in **Providers & models**.`;
		}
		return undefined;
	}

	private async pushError(message: string): Promise<void> {
		this.messages.push({ id: newId('m'), role: 'assistant', content: message, isError: true });
		this.noteError(message);
		await this.store.saveMessages(this.sessionId, this.messages);
		await this.sendState();
	}

	/** Fill limits/capabilities from the catalog for "smart" model entries. */
	/** One model call, whatever the provider's wire format. */
	private async callModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>, report: (message: string) => void = (message) => this.status(message, '')): Promise<StreamResult> {
		const pending: Promise<void>[] = [];
		const budget = this.taskBudgets.resolve(options.requestContext);
		const settings = this.store.getSettings();
		const signal = budget ? AbortSignal.any([options.signal, budget.controller.signal]) : options.signal;
		const limits = budget?.snapshot().limits;
		const enabledBudget = !!limits && Object.values(limits).some((n) => n > 0);
		const maxTokens = limits && (limits.cost > 0 || limits.tokens > 0) ? options.maxTokens ?? 16_384 : options.maxTokens;
		const pricing = limits?.cost ? await this.usage.pricing(provider, options.model) : undefined;
		const keyInfo = await this.store.keyInfoOf(provider.id, apiKey).catch(() => undefined);
		try {
			return await this.dispatchModel(provider, apiKey, { ...options,
				onCapabilityDowngrade: (fields) => {
					report(`${provider.name} / ${options.model} did not accept ${fields.join(', ')}. This request uses a compatibility profile.`);
					options.onCapabilityDowngrade?.(fields);
				},
				signal,
				maxTokens,
				stablePrefix: settings.stablePrefix,
				tools: settings.stablePrefix ? stableTools(options.tools) : options.tools,
				beforeAttempt: async (_url, body) => {
					const release = await this.tools.scheduler.acquire('model', settings.modelConcurrency, signal);
					try {
						signal.throwIfAborted();
						// UTF-8 payload bytes deliberately overestimate text tokens; images and hidden
						// provider framing can still make this an estimate rather than a billing guarantee.
						const input = Buffer.byteLength(JSON.stringify(body) ?? '') + 1024;
						const lease = enabledBudget ? budget!.reserve(input, maxTokens ?? 16_384, pricing?.price ?? {}, pricing?.kind ?? 'unknown') : undefined;
						return { finish: (attempt) => { try { lease?.finish(attempt); } finally { release(); } } };
					} catch (error) { release(); throw error; }
				},
				requestContext: { sessionId: this.sessionId, purpose: 'helper', ...options.requestContext, ...(budget ? { rootTaskId: budget.id } : {}) },
				onAttempt: (attempt) => {
					pending.push(this.usage.recordAttempt(provider, attempt, keyInfo).catch(() => {
						this.status('Request usage could not be saved. Usage totals may be incomplete.', 'error');
					}).then(() => { try { options.onAttempt?.(attempt); } catch { /* An observer cannot fail the request. */ } }));
				} }, report);
		} finally {
			await Promise.all(pending);
		}
	}

	private async dispatchModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>, report: (message: string) => void): Promise<StreamResult> {
		// An agent (Claude, Antigravity…) works inside a chat turn; helpers such as text tools or compaction cannot use it.
		if (provider.apiFormat === 'acp' && !options.acp) throw new Error(`${provider.name} is an agent: it works inside the chat only. Pick a regular model for this helper.`);
		const entry = provider.models.find(m => m.id === options.model);
		const advertised = entry?.reasoningControl ?? (provider.apiFormat === 'acp' ? variantControls(provider.models).get(options.model) : undefined);
		const full: StreamOptions = { ...options, reasoningControl: reasoningControl({ apiFormat: modelApiFormat({ apiFormat: provider.apiFormat, baseUrl: provider.baseUrl, model: options.model }), baseUrl: provider.baseUrl, model: options.model, advertised, localEngine: provider.preset === ENGINE_PRESET, reasoning: entry?.reasoning }), baseUrl: provider.baseUrl, apiKey, apiFormat: provider.apiFormat, providerId: provider.id, chatgptPlan: provider.auth === 'account' && provider.preset === 'chatgpt-account' && provider.apiFormat === 'responses', zeroRetention: this.store.getSettings().zeroRetentionOnly };
		// Hold the engine until streaming ends so another call cannot unload the active model.
		if (provider.preset === ENGINE_PRESET) {
			const call = this.localModelCalls.catch(() => undefined).then(async () => {
				options.signal?.throwIfAborted();
				// Measure real decode speed: output tokens over the time after the first token.
				let first = 0;
				const onText = full.onText;
				const once = async () => streamChat({ ...full, baseUrl: await this.localModels.ensureLoaded(options.model, options.signal), onText: (t) => ((first ||= Date.now()), onText?.(t)) });
				let r: StreamResult;
				try {
					r = await once();
				} catch (e) {
					// Crash recovery: the engine died under this request — restart it and retry once, unless an answer was already streaming.
					const crash = options.signal?.aborted ? undefined : await this.localModels.engineCrash(options.model, e);
					if (!crash) throw e;
					if (first || !crash.restart) {
						throw new Error(first ? `${crash.message.replace(/ — restarting.*$/, '')} while answering. It starts again with your next message.` : crash.message);
					}
					report(crash.message);
					r = await once();
				}
				const secs = first ? (Date.now() - first) / 1000 : 0;
				if (secs > 1 && r.usage?.output) this.localModels.recordSpeed(options.model, r.usage.output / secs);
				return r;
			});
			this.localModelCalls = call.then(() => undefined, () => undefined);
			return call;
		}
		return provider.apiFormat === 'vscode-lm' ? new RequestTrace(full).run(streamLm) : streamChat(full);
	}

	private async compactNow(): Promise<void> {
		if (this.run) {
			return;
		}
		const { provider, model } = await this.store.resolveSelection(this.sessionId);
		const lastUser = [...this.messages].reverse().find((m) => m.role === 'user' && !m.kind && !m.local);
		if (!provider || !model || !lastUser) {
			this.status('Nothing to compact yet.', '');
			return;
		}
		const abort = new AbortController();
		this.run = { abort, sessionId: this.sessionId, convo: this.messages, steer: [] };
		await this.sendState();
		try {
			const last = this.lastRequest;
			const prefix = last?.sessionId === this.sessionId && last.provider.id === provider.id && last.model.id === model.id ? last : undefined;
			await this.compactor.maybeCompact(this.messages, lastUser, provider, model, (await this.store.getApiKey(provider.id)) ?? '', true, abort.signal, prefix);
		} catch (error) {
			this.status(`Compaction failed: ${error instanceof Error ? error.message : error}`, 'error');
		} finally {
			this.run = undefined;
			await this.store.saveMessages(this.sessionId, this.messages);
			await this.sendState();
		}
	}

	private async runTurn(user: StoredMessage, plan = false): Promise<void> {
		this.turning++;
		try {
			await this.runner.run(user, plan);
		} finally {
			this.turning--;
		}
	}

	/** Background agents of a chat finished: an idle chat reads their reports in a short turn; a busy one gets them between steps. */
	private finishedOwner(thread?: string): string | undefined {
		const owner = thread ? this.agentRuns.threads.owner(thread) : undefined;
		return owner && this.agentRuns.get(owner)?.status === 'completed' ? owner : undefined;
	}

	private wakeForAgents(sessionId: string): void {
		if (this.run || this.turning || sessionId !== this.sessionId) {
			return; // the running turn drains them; another chat reads them with its next message
		}
		void this.continueWithAgents();
	}

	/**
	 * Messages from a phone conversation an agent owns go straight to that agent's inbox (pass-through);
	 * the lead only gets a one-line mention with its next notices. Unowned messages go to the chat as usual.
	 */
	

	/** The agent of this chat that owned the thread and has finished (a stopped one stays stopped). */
	

	/** A new message in a thread an agent owns goes to that agent's inbox; undefined when no running agent owns it. */
	private passThrough(threadId: string, message: string, what: string, excerpt: string): string | undefined {
		if (!this.store.getSettings().threadRouting) return undefined;
		const agentId = this.agentRuns.threads.route(threadId, (a) => this.agentRuns.get(a)?.status === 'running');
		const run = agentId ? this.agentRuns.get(agentId) : undefined;
		if (!run || run.inbox.length >= 20) return undefined;
		if (run.kind === 'writer') this.writers.steer(run.id, message);
		else run.inbox.push(message);
		recordSteer(run, message);
		this.agentRuns.queueNotice(run.sessionId, `<thread-message>\n${threadId}: ${what} went straight to ${run.id}, which owns this conversation and decides it: "${excerpt.replace(/\s+/g, ' ').slice(0, 160)}". Act on it only if the user asks to stop that work.\n</thread-message>`, undefined, true);
		this.scheduleState();
		return run.id;
	}

	/** A turn whose prompt is the finished agents' reports (shown as a short note). */
	private async continueWithAgents(): Promise<void> {
		const rootTaskId = this.agentRuns.noticeRoot(this.sessionId);
		// Agents that own a phone conversation: this turn's answer goes back to it.
		const threads = this.agentRuns.noticeThreads(this.sessionId);
		const notices = this.agentRuns.takeNotices(this.sessionId);
		if (!notices) {
			return;
		}
		const thread = threads[0];
		// Only a phone conversation gets the answer sent back; any thread is followed by the agents this turn starts.
		
		
		
		const { provider, model } = await this.store.resolveSelection(this.sessionId);
		const problem = await this.checkReady(provider, model);
		const user: StoredMessage = { id: newId('m'), role: 'user', rootTaskId, content: noticeLabel(notices), apiContent: notices, at: Date.now(), thread };
		this.messages.push(user);
		if (problem) {
			await this.pushError(problem);
			return;
		}
		await this.runTurn(user, false);
	}

	/** An agent card changed after its turn ended: update the chat it belongs to and save it. */
	private persistAgentCard(sessionId: string, card: StoredMessage): void {
		if (sessionId === this.sessionId) {
			const m = this.messages.find((x) => x.id === card.id);
			if (m && m !== card) m.tool = { ...card.tool! };
			if (!this.run) void this.store.saveMessages(sessionId, this.messages);
			this.scheduleState();
			return;
		}
		void this.store.getSession(sessionId).then(async (session) => {
			const m = session?.messages.find((x) => x.id === card.id);
			if (session && m) {
				m.tool = { ...card.tool! };
				await this.store.saveMessages(sessionId, session.messages);
			}
		}).catch(() => undefined);
	}

	/** Every URL the user wrote in this chat (the webfetch provenance guard's allowlist). */
	private urlProvenance(sessionId: string): ReadonlySet<string> {
		let set = this.provenance.get(sessionId);
		if (!set) {
			set = new Set();
			this.provenance.set(sessionId, set);
			for (const m of this.messages) {
				if (m.role === 'user' && !m.kind) {
					for (const u of extractUrls(m.apiContent ?? m.content)) {
						set.add(u);
					}
				}
			}
		}
		return set;
	}

	/** Long-lived services a turn's agents use. */
	private agentServices(): TurnAgentServices {
		return {
			store: this.store,
			plugins: this.plugins,
			mcp: this.mcp,
			browser: this.browser,
			skills: this.skills,
			writers: this.writers,
			registry: this.agentRuns,
			cost: (p, m, i, o, c) => this.usage.turnCost(p, m, i, o, c),
			persistCard: (id, card) => this.persistAgentCard(id, card),
			wake: (id) => this.wakeForAgents(id),
			skillCatalog: () => this.skills.promptCatalog(this.store.getSettings().skillCatalogChars),
			storageDir: this.context.globalStorageUri.fsPath,
			extensionDir: this.context.extensionUri.fsPath,
			tools: this.tools,
			hooks: () => this.allHooks(),
			hookBase: { session_id: this.sessionId, workspace: workspaceRoot()?.fsPath ?? '' },
			scheduleState: () => this.scheduleState(),
			callModel: (p, k, o) => this.callModel(p, k, o)
		};
	}

	private askUser(convo: StoredMessage[], text: string, options: string[], signal: AbortSignal): Promise<string> {
		const question = { id: newId('q'), text, options, status: 'pending' as const };
		const card: StoredMessage = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', question: { ...question } };
		convo.push(card);
		void this.sendState();
		this.notify('attention', 'the agent has a question for you.');
		return new Promise((resolve) => {
			const auto = this.store.getSettings().autoContinueQuestions
				? setTimeout(() => this.questions.get(question.id)?.(undefined), 5 * 60_000)
				: undefined;
			this.questions.set(question.id, (answer) => {
				clearTimeout(auto);
				this.questions.delete(question.id);
				card.question = { ...card.question!, status: answer ? 'answered' : 'skipped', answer };
				this.scheduleState();
				resolve(answer ?? (signal.aborted ? 'The user stopped the run.' : 'No answer — continue with your best judgment and state the assumption you made.'));
			});
		});
	}

	private async requestApproval(
		convo: StoredMessage[],
		request: ApprovalRequest,
		rule: string | undefined
	): Promise<ApprovalHandle> {
		// A session "Always run this command" grant from an earlier card approves the
		// exact command (not a prefix, not a family) for the rest of this session.
		if (!rule && request.kind === 'command' && request.command && this.sessionGrants.has(request.command)) {
			rule = 'session grant';
		}
		const auto = !!rule;
		const { review, signal, ...fields } = request;
		signal?.throwIfAborted();
		const approval: Approval = { ...fields, id: newId('e'), status: auto ? 'applied' : 'pending', execution: auto ? 'running' : undefined, auto: auto || undefined, autoRule: rule && rule !== 'full' ? rule : undefined };
		// In "auto" sandbox mode only commands that run without asking are boxed.
		if (!auto && this.store.getSettings().sandbox !== 'always') {
			delete approval.sandboxed;
		}
		const card: StoredMessage = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', approval };
		convo.push(card);
		const handle = (approved: boolean) => ({
			approved,
			auto,
			finish: (result: string, failed?: boolean) => {
				approval.result = this.store.getSettings().redactSecrets ? redactSecrets(result).text : result;
				approval.failed = failed || undefined;
				approval.execution = failed ? 'error' : 'done';
				this.scheduleState();
			}
		});
		if (auto) {
			this.scheduleState();
			return Promise.resolve(handle(true));
		}
		// Show the change in the editor too (revert single blocks, then Accept).
		if (review && fields.path && this.store.getSettings().reviewInEditor) {
			try {
				const uri = resolveInWorkspace(fields.path);
				await this.reviews.start(approval.id, uri, review.before, review.after, fields.path.split('/').pop() ?? fields.path);
			} catch {
				// the card alone still works
			}
		}
		void this.sendState();
		this.notify('attention', 'an action is waiting for your approval.');
		return new Promise((resolve, reject) => {
			let settled = false;
			const abort = () => finish(false);
			const finish = (approved: boolean) => {
				if (settled) return; settled = true;
				signal?.removeEventListener('abort',abort); this.approvals.delete(approval.id);
				approval.status = approved ? 'applied' : 'rejected';
				approval.execution = approved ? 'running' : undefined;
				this.scheduleState();
				if (this.reviews.has(approval.id)) {
					void this.reviews.finish(approval.id, approved).then((content) => resolve({ ...handle(approved), content: approved ? content : undefined }), error => {
						handle(approved).finish('Editor review could not be finalized: ' + String(error), true);
						reject(error);
					});
				} else {
					resolve(handle(approved));
				}
			};
			this.approvals.set(approval.id,finish);
			signal?.addEventListener('abort',abort,{once:true}); if (signal?.aborted) abort();
		});
	}

	// ------------------------------------------------------------ providers

	// ------------------------------------------------------------ usage

}

export type { ToolDef };
