import * as vscode from 'vscode';
import { validMessages } from './messageValidation';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { withCredentialLock } from './tools/mcpRefresh';
import { verificationFailureText } from './acp/verification';
import { hostSettings, hostProviderAllowed, isDesktopHost } from './host/capabilities';
import { normalizeWorkflow, type SubagentWorkflow } from './host/subagentWorkflow';
import { cosineSimilarity, decodeVector, encodeVector, fuseRanks, groupDuplicates } from './tools/memoryIndex';

/**
 * Persistent state for the extension.
 *
 *  - Providers (non-secret config) live in globalState; API keys live in
 *    SecretStorage (encrypted by the OS) and never reach a webview.
 *  - Each provider owns a list of ModelEntry objects, mirroring ZCode's
 *    "Providers & models" screen: per-model enable toggle, context window,
 *    max output tokens, vision/tool flags, and "smart configuration".
 *  - Sessions, agent memory, usage samples and agent settings round it out.
 */
/** `vscode-lm` = models from VS Code's Language Model API (e.g. a GitHub Copilot subscription). */
export type { ApiFormat } from './chatClient';
import type { ApiFormat } from './chatClient';
import type { ModelUsage, UsagePrices } from './usage';
import type { RequestAttempt } from './requestDiagnostics';
import { MODEL_SETTINGS, type ModelSetting } from './modelSettings';
import { type AccountCredential, describeCredential, ensureFresh, parseCredential, serializeCredential, splitKeys } from './accounts';
import { insecureRemote } from './netSafety';
import { normalizeReasoningControl, type ReasoningControl, type ReasoningEffort } from './reasoning';
export type Effort = ReasoningEffort;
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'maximum'];
export type ChatMode = 'chat' | 'agent' | 'full';

export interface ModelEntry {
	agentProfile?: { tools: 'lean' | 'full'; contextWindow?: number; suite: string; passed: number; total: number; trials: number; at: number };
	id: string;
	enabled: boolean;
	/** When true, limits/capabilities follow the models.dev catalog. */
	smart: boolean;
	/** Fields edited by hand keep their value when smart configuration refreshes. */
	manualFields?: ModelSetting[];
	contextWindow?: number;
	maxOutput?: number;
	vision?: boolean;
	/** Function calling support; agent mode is disabled when false. */
	tools?: boolean;
	/** Thinking / reasoning model (catalog). */
	reasoning?: boolean;
	/** Exact controls advertised by the plan agent or provider; thinking support alone is insufficient. */
	reasoningControl?: ReasoningControl;
	/** $ per million input / output tokens (catalog). */
	priceIn?: number;
	priceOut?: number;
	/** Display name the provider gave it (a plan agent's "Opus 5.5" for `claude-opus-5-5`); the id is what is sent. */
	name?: string;
	/** The provider's one-line note on the model. */
	note?: string;
}

function diffTotals(messages: StoredMessage[]): { added?: number; removed?: number } {
	let added = 0;
	let removed = 0;
	for (const m of messages) {
		for (const e of m.turn?.edits ?? []) {
			added += e.added;
			removed += e.removed;
		}
	}
	return added || removed ? { added, removed } : {};
}

export interface ProviderConfig {
	id: string;
	name: string;
	baseUrl: string;
	apiFormat: ApiFormat;
	models: ModelEntry[];
	enabled: boolean;
	/** models.dev provider id this provider was created from, if any. */
	catalogId?: string;
	/** Preset card this provider came from (drives its icon tile). */
	preset?: string;
	/** How the credential was obtained ('account' = a subscription sign-in, refreshed automatically). */
	auth?: 'apiKey' | 'oauth' | 'vscode' | 'account';
	/** `acp` providers: the agent (its registry id) and who is signed in — never a token, the agent keeps its own login. */
	agent?: { id: string; plan?: string; email?: string };
	/** The last real answer from this provider (sign-in check, Test, a chat turn): green only when it worked; `signIn` = the fix is signing in again. */
	health?: ProviderHealth;
	/** Soft token limits for the usage rings (0 = defaults). */
	weeklyTokenLimit: number;
	fiveHourTokenLimit: number;
}

type ProviderPatch = Partial<Omit<ProviderConfig, 'id'>>;

export interface AgentSettings {
	projectVerification: boolean;
	codeIntelligence: boolean;
	languageServerCommand: string;
	languageServerArgs: string;
	dependencyAudit: boolean;
	browserChecks: boolean;
	workspaceWatch: boolean;
	// ---- agent
	browserTools: boolean;
	searchEngine: 'exa' | 'duckduckgo';
	openPages: boolean;
	commandTool: boolean;
	/** Model ↔ tool round-trips per request before the agent pauses; 0 = no limit. */
	maxSteps: number;
	toolConcurrency: number;
	mcpConcurrency: number;
	childConcurrency: number;
	modelConcurrency: number;
	stablePrefix: boolean;
	toolProfile: 'auto' | 'lean' | 'full';
	strictTools: 'auto' | 'on' | 'off';
	openaiCache: 'provider' | 'implicit' | 'explicit';
	openaiCacheTtl: '30m' | '12h';
	taskBudgetCost: number;
	taskBudgetTokens: number;
	taskBudgetRequests: number;
	taskBudgetSeconds: number;
	includeAgentsMd: boolean;
	customInstructions: string;
	/** Agent mode: approve these without a card (Full access approves everything). */
	autoApproveEdits: boolean;
	autoApproveCommands: boolean;
	autoApproveMcp: boolean;
	/** OS sandbox for commands: off | auto (commands that run without asking) | always (sandboxed commands run without asking). */
	sandbox: 'off' | 'auto' | 'always';
	/** Allow network inside the sandbox (macOS / Linux; Windows cannot block it). */
	sandboxNetwork: boolean;
	/** Paths sandboxed commands must not read, one per line (`~` is the home folder). Empty means reads are unrestricted. */
	sandboxDenyRead: string;
	/** Drop API keys, tokens and passwords from the environment agent commands run with. */
	hideCommandSecrets: boolean;
	/** Command prefixes that never need approval, one per line (e.g. `npm test`). */
	commandAllowlist: string;
	/** Mask API keys, tokens, passwords and private keys before tool output reaches the model. */
	redactSecrets: boolean;
	/** Skip background model catalogs, deal feeds and announcements; model requests and your bridges are unaffected. */
	disableNonessentialNetwork: boolean;
	/** Route OpenRouter requests only to zero-retention providers (provider.data_collection: 'deny'); a request no such provider serves fails instead of silently using one that keeps or trains on the data. */
	zeroRetentionOnly: boolean;
	/** Show pending edits as a diff in the editor (revert single blocks before accepting). */
	reviewInEditor: boolean;
	/** After edits, check VS Code errors in the changed files and let the agent fix them. */
	verifyDiagnostics: boolean;
	/** Optional command run after edits (e.g. `npm test`); a failure goes back to the agent. */
	verifyCommand: string;
	/** OTLP/HTTP traces endpoint: each turn's timings and token counts (never its text) go there. Empty: off. */
	otelEndpoint: string;
	/** Auto-detect build/test commands (cargo check, npm test, tsc, pytest, go test) when verifyCommand is empty. */
	verifyAutoDetect: boolean;
	/** Microphone: 'system' = Windows offline engine, 'whisper' = record + transcribe via a provider. */
	dictationEngine: string;
	/** Provider (OpenAI format) used for Whisper transcription. */
	whisperProvider: string;
	whisperModel: string;
	/** Project code index (semantic_search): local keywords, optional embeddings. */
	codeIndex: boolean;
	/** Keep the exact tool history between turns (best prompt caching, no re-reading). */
	exactHistory: boolean;
	/** Send rarely used tools (browser, MCP, …) on demand via tool_search / use_tool. */
	deferTools: boolean;
	/** Add the repository map (folders, key files, main symbols) to the agent prompt. */
	repoMap: boolean;
	/** run_script: programmatic tool calling in a sandboxed Node process. */
	runScript: boolean;
	/** Retry rate-limit / overload / network errors with backoff before giving up. */
	retryErrors: boolean;
	/** Fallback models, in order: "providerId::modelId" per line (9router-style). */
	fallbackModels: string;
	/** Model substitution is disabled: never continue on another model (kill switch, like CLAUDE_CODE_NO_MODEL_FALLBACK). */
	noModelFallback: boolean;
	/** web_fetch may only open URLs the user shared (prompt-injection guard). */
	webfetchProvenance: boolean;
	/** Hybrid routing: a local model ("providerId::modelId") for helper work and as the offline fallback; '' = off. */
	localHelper: string;
	/** Which helper work goes to the local model: comma list of compaction, text, subagents. */
	localHelperTasks: string;
	/** When the chosen model cannot be reached (offline, DNS, refused), continue on the local helper model. */
	offlineFallback: boolean;
	/** Local models get a lean agent: shorter system prompt, fewer tools at once, a context budget sized to the model. */
	localTuned: boolean;
	/** Paths the agent may never read, write, search or list (one glob per line). */
	denyPaths: string;
	embeddingProvider: string;
	embeddingModel: string;
	// ---- browser agent (real Chrome/Edge driven over CDP)
	browserAgent: boolean;
	browserHeadless: boolean;
	browserPath: string;
	/** Hosts the agent's browser may open, one per line ('' = any). Subdomains of a listed host are allowed. */
	browserAllowHosts: string;
	// ---- general
	followUp: 'queue' | 'steer' | 'interrupt';
	showReasoning: boolean;
	showTodos: boolean;
	groupExploration: boolean;
	groupTerminal: boolean;
	groupChanges: boolean;
	notifications: boolean;
	/** Optional warnings at 75%, 90%, and 100% of rolling token budgets. */
	usageBudgetAlerts: boolean;
	notificationSound: boolean;
	/** The desktop notch at the top of the screen and which run phases it shows. */
	notch: boolean;
	notchThinking: boolean;
	notchWriting: boolean;
	notchTools: boolean;
	notchWaiting: boolean;
	notchFinished: boolean;
	/** When the notch is on screen: 'background' (resting while zer0ne is not in front), 'activity' (only while something happens) or 'always'. */
	notchPresence: 'background' | 'activity' | 'always';
	/** Over another app's window: a thin 'line' to hover, or the small 'pill'. */
	notchCovered: 'line' | 'pill';
	/** Step aside for full-screen apps, keeping only an approval as a line. */
	notchFullscreen: boolean;
	/** Keep the computer from sleeping while any agent runs (works with the notch off too). */
	notchKeepAwake: boolean;
	/** Windows activity on the notch: low battery or lost network while agents run, the microphone while dictating. */
	notchBattery: boolean;
	notchNetwork: boolean;
	notchMic: boolean;
	/** When you come back to the computer, a short briefing of what happened while you were away. */
	notchWelcome: boolean;
	/** Where results and approvals are announced: 'both' (notch and Windows notifications) or 'notch' (the notch only). */
	notchAlerts: 'both' | 'notch';
	/** A run that looks stuck (the same step failing or repeating, or no progress for minutes) shows as such. */
	notchStuck: boolean;
	/** A finished run shows the files and lines it changed and whether its checks passed. */
	notchResults: boolean;
	/** A Workflow's workers and the project's cloud tasks show on the notch. */
	notchAgents: boolean;
	/** A run's spend against its task budget, with a warning at 80%. */
	notchCost: boolean;
	/** Ctrl+Alt+Z opens the notch from anywhere, and again opens what needs you. */
	notchShortcut: boolean;
	/** Keep the notch out of screenshots, recordings and screen sharing. */
	notchPrivate: boolean;
	/** Approve or reject a command, and answer an agent's question, on the notch itself. */
	notchActions: boolean;
	/** Stop a run, or tell it something, from its row on the notch. */
	notchSteer: boolean;
	/** Drop a file, image or text on the open notch (or use what is copied) to ask the agent about it. */
	notchDrop: boolean;
	/** While Windows reports a presentation, the notch shows status only and leaves screen captures. */
	notchDiscreet: boolean;
	/** A run's live health: checks passing or failing, files changed, how full the context is. */
	notchHealth: boolean;
	/** A finished run offers its next steps: review, check, undo, continue. */
	notchNext: boolean;
	/** Pin the open notch and use the keyboard there. */
	notchKeys: boolean;
	/** Which display the notch sits on: the primary one, or the one you are using. */
	notchDisplay: 'primary' | 'active';
	/** A soft sound when an approval is needed or a run fails. */
	notchSound: boolean;
	autoContinueQuestions: boolean;
	// ---- features / plugins
	tokenSaver: boolean;
	/** Anthropic prompt-cache lifetime: '5m' (default) or '1h' (Anthropic API only; writes cost 2×). */
	cacheTtl: '5m' | '1h';
	/** After a turn, keep an Anthropic prompt cache alive for a few minutes while it saves ≥ $0.05 per refresh. */
	cacheWarm: boolean;
	autoCompact: boolean;
	compactThreshold: number;
	/** Auto compaction also starts at this many tokens (0 = only the percentage): a model with a huge window degrades long before it is 80% full. */
	compactMaxTokens: number;
	/** How compaction keeps the older turns: a written summary, pictures (vision models), or auto (pictures where they are clearly cheaper — Gemini). */
	subagents: boolean;
	skills: boolean;
	/** Characters of the system prompt the skill list may use; past it, skills are listed by name only. */
	skillCatalogChars: number;
	mcp: boolean;
		gitTools: boolean;
	/** Debugger tools (start / breakpoints / step / inspect). */
	debugTools: boolean;
	/** Screen + mouse/keyboard control (every action approved). Off by default. */
	computerUse: boolean;
	computerScreenshotHistory: boolean;
	/** How Computer Use shows control: 'classic' (window outline and pointer ring) or 'design' (one design-tool cursor that redraws the window). */
	computerEffects: string;
	/** image_generate: let the agent create images (opt-in). */
	imageGenerate: boolean;
	/** Default image model: `provider/model` or `local:<bundle>`. Empty picks the local Studio when it is installed. */
	imageGenModel: string;
	/** A background command that ends on its own is reported to the chat's agent with the end of its output. */
	commandNotices: boolean;
	/** Watch running subagents for stalls and repeated identical calls; nudge or flag them. */
	agentWatchdog: boolean;
	/** Minutes without a finished step before a running subagent is flagged as stalled. */
	watchdogStallMinutes: number;
	/** Periodically ask a model whether each background agent still works toward its task (costs calls). */
	agentDriftCheck: boolean;
	
	threadRouting: boolean;
		/** The recall tool: follow ids from notices (agents, commands, threads, events) one hop at a time. */
	recallTool: boolean;
	/** Watch this branch's CI runs and pull request reviews and hand candidates to the agent. */
	eventSources: boolean;
	/** Events the policy asks for reach the agent; off, they are only recorded as "would hand over" (observe). */
	eventAutoAct: boolean;
	/** The word a comment uses to address the agent (an explicit request); empty turns explicit requests off. */
	eventMention: string;
	/** GitHub logins besides yours whose mention of the agent is an explicit request. */
	eventAllowed: string;
	/** Plain-language policy the event check applies to candidate events. */
	eventPolicy: string;
	/** Minutes between event checks. */
	eventPollMinutes: number;
		/** The agent keeps durable facts (memory_retain / memory_recall) and recalls them in new chats. */
	agentMemory: boolean;
	/** The agent can search past chats for relevant details (session_search). */
	chatSearch: boolean;
	/** Allow saving details about sensitive topics (health, beliefs) to memory. Off by default. */
	memorySensitive: boolean;
	/** After a turn, a local helper model extracts durable facts and solutions. Off by default. */
	memoryAutoSave: boolean;
	/** Inline ghost-text completions in the editor. */
	autocomplete: boolean;
	/** providerId::modelId for completions ('' = the chat model). */
	autocompleteModel: string;
	/** Effort levels offered in the model controls (comma list of none,minimal,low,medium,high,xhigh,max). */
	reasoningEfforts: string;
	/** Accent: 'custom' uses accentColor. */
	accentColor: string;
	/** Second palette colour (gradients, glow tail); '' = derived from the accent. */
	accentColor2: string;
	/** Glow strength 0–100. */
	glowStrength: number;
	/** Old always-on Aura switch (≤ 0.9) — ignored; see `aura`. */
	agentAura?: boolean;
	/** Prism glow colours: two-tone metallic (default), the accent, or the two custom tones. */
	glowColor: 'metallic' | 'accent' | 'custom';
	/** The two Prism tones when glowColor = 'custom'. */
	glowTone1: string;
	glowTone2: string;
	/** Theme editor: overrides for the chosen theme ('' = the theme's own). */
	themeBackground: string;
	themeForeground: string;
	/** Fonts: 'system' / a family key (see media/appearance.js FONTS). */
	fontUi: string;
	fontContent: string;
	fontCode: string;
	terminalFontSize: number;
	terminalLineHeight: number;
	terminalCursorStyle: 'block' | 'bar' | 'underline';
	terminalCursorBlink: boolean;
	terminalScreenReader: boolean;
	terminalEffects: 'off' | 'retro';
	terminalProse: 'mono' | 'reading';
	/** Text weight for UI + content (300–600). */
	fontWeight: number;
	/** Blur-slide reveal of streaming text: auto = Terminal theme only. */
	textReveal: 'auto' | 'on' | 'off';
	// ---- appearance
	theme: string;
	accent: string;
	uiFontSize: number;
	density: 'compact' | 'comfortable';
	glow: 'off' | 'subtle';
	/** calm: animation only where something is running or changing; decorative loops stop. */
	motion: 'full' | 'calm';
	/** simple: chat, changes and approvals up front; advanced Settings pages stay one switch away. */
	uiMode: 'simple' | 'pro';
	/** Background: 'none' or 'image' (the user's picture). Live scenes were removed in 0.18. */
	background: string;
	/** Absolute path of the user's background picture (background = 'image'). */
	backgroundImage: string;
	/** none | blur | duotone | dither | halftone | ascii */
	backgroundFilter: string;
	/** 1–100 (%). */
	backgroundOpacity: number;
	/** 'all' = always, 'empty' = only on the new-chat screen. */
	backgroundScope: 'all' | 'empty';
	/** Frosted translucent panels over the background. */
	glass: boolean;
	/** UI language code (en, sq, zh-CN…). */
	language: string;
	/** Language the agent answers in: 'auto' = match the user. */
	replyLanguage: string;
	// ---- mobile remote
	remoteEnabled: boolean;
	remotePort: number;
	/** How the phone reaches this machine: same Wi-Fi, a secure link from anywhere (Cloudflare quick tunnel), Tailscale, or the user's own SSH tunnel proxy. */
	remoteAccess: 'lan' | 'anywhere' | 'tailscale' | 'ssh';
	/** The ssh target for the own-tunnel mode: "stable@proxy.your-domain" (tunnl.gg, serveo…). */
	remoteSshTarget: string;
	/** The remote side of the reverse tunnel (tunnl.gg and friends map 80 to https). */
	remoteSshRemotePort: number;
}

export const DEFAULT_SETTINGS: AgentSettings = {
	projectVerification: true,
	codeIntelligence: false,
	languageServerCommand: '',
	languageServerArgs: '[]',
	dependencyAudit: false,
	browserChecks: false,
	workspaceWatch: false,
	toolConcurrency: 8,
	mcpConcurrency: 4,
	childConcurrency: 2,
	modelConcurrency: 4,
	stablePrefix: true,
	toolProfile: 'auto',
	strictTools: 'auto',
	openaiCache: 'provider',
	openaiCacheTtl: '30m',
	taskBudgetCost: 0,
	taskBudgetTokens: 0,
	taskBudgetRequests: 0,
	taskBudgetSeconds: 0,
	browserTools: true,
	searchEngine: 'exa',
	openPages: true,
	commandTool: true,
	maxSteps: 0,
	includeAgentsMd: true,
	customInstructions: '',
	autoApproveEdits: false,
	autoApproveCommands: false,
	autoApproveMcp: false,
	redactSecrets: true,
	disableNonessentialNetwork: false,
	zeroRetentionOnly: false,
	reviewInEditor: true,
	verifyDiagnostics: true,
	verifyCommand: '',
	otelEndpoint: '',
	verifyAutoDetect: true,
	dictationEngine: 'system',
	whisperProvider: '',
	whisperModel: 'whisper-1',
	codeIndex: true,
	exactHistory: true,
	deferTools: true,
	repoMap: true,
	runScript: true,
	retryErrors: true,
	fallbackModels: '',
	noModelFallback: false,
	webfetchProvenance: false,
	localHelper: '',
	localHelperTasks: 'compaction,text',
	offlineFallback: true,
	localTuned: true,
	denyPaths: '**/*.pem\n**/*.key\n**/*.p12\n**/*.pfx\n**/id_rsa*\n**/id_ed25519*\n**/.ssh/**',
	embeddingProvider: '',
	embeddingModel: 'text-embedding-3-small',
	commandAllowlist: 'git status\ngit diff\ngit log\nnpm test\nnpm run lint\nnpm run build\nnpx tsc --noEmit',
	browserAgent: true,
	browserHeadless: false,
	browserPath: '',
	browserAllowHosts: '',
	followUp: 'queue',
	showReasoning: true,
	showTodos: true,
	groupExploration: true,
	groupTerminal: true,
	groupChanges: false,
	notifications: true,
	usageBudgetAlerts: false,
	notificationSound: false,
	notch: true,
	notchThinking: true,
	notchWriting: true,
	notchTools: true,
	notchWaiting: true,
	notchFinished: true,
	notchPresence: 'background',
	notchCovered: 'line',
	notchFullscreen: true,
	notchKeepAwake: true,
	notchBattery: false,
	notchNetwork: false,
	notchMic: false,
	notchWelcome: false,
	notchAlerts: 'both',
	notchStuck: true,
	notchResults: true,
	notchAgents: true,
	notchCost: true,
	notchShortcut: true,
	notchPrivate: false,
	notchActions: true,
	notchSteer: true,
	notchDrop: true,
	notchDiscreet: true,
	notchHealth: true,
	notchNext: true,
	notchKeys: true,
	notchDisplay: 'active',
	notchSound: false,
	autoContinueQuestions: true,
	tokenSaver: true,
	cacheTtl: '5m',
	cacheWarm: false,
	autoCompact: true,
	sandbox: 'auto',
	sandboxNetwork: true,
	sandboxDenyRead: '',
	hideCommandSecrets: true,
	compactThreshold: 80,
	compactMaxTokens: 200_000,
	subagents: true,
	skills: true,
	skillCatalogChars: 12_000,
	mcp: true,	gitTools: true,
	debugTools: true,
	computerUse: false,
	computerScreenshotHistory: false,
	computerEffects: 'classic',
	imageGenerate: false,
	imageGenModel: '',
	commandNotices: true,
	agentWatchdog: true,
	watchdogStallMinutes: 10,
	agentDriftCheck: false,
	threadRouting: true,	recallTool: true,
	eventSources: false,
	eventAutoAct: false,
	eventMention: '@zer0ne',
	eventAllowed: '',
	eventPolicy: 'CI failed on my branch: reproduce it in the background and tell me only if you can show the cause.\nA reviewer asked for a change on my pull request: tell me and offer to make it.\nIgnore bots, approvals without comments, and anything already handled.',
	eventPollMinutes: 5,	agentMemory: true,
	chatSearch: true,
	memorySensitive: false,
	memoryAutoSave: false,
	autocomplete: false,
	autocompleteModel: '',
	reasoningEfforts: 'low,medium,high,max',
	accentColor: '#f7931e',
	accentColor2: '',
	glowStrength: 35,
	glowColor: 'metallic',
	glowTone1: '#0b0b0d',
	glowTone2: '#e3e7ec',
	themeBackground: '',
	themeForeground: '',
	fontUi: 'system',
	fontContent: 'system',
	fontCode: 'editor',
	terminalFontSize: 0,
	terminalLineHeight: 1.3,
	terminalCursorStyle: 'block',
	terminalCursorBlink: true,
	terminalScreenReader: false,
	terminalEffects: 'off',
	terminalProse: 'mono',
	fontWeight: 400,
	textReveal: 'auto',
	theme: 'auto',
	accent: 'blue',
	uiFontSize: 13,
	density: 'comfortable',
	glow: 'subtle',
	motion: 'full',
	uiMode: 'pro',
	background: 'none',
	backgroundImage: '',
	backgroundFilter: 'none',
	backgroundOpacity: 60,
	backgroundScope: 'all',
	glass: true,
	language: 'en',
	replyLanguage: 'auto',
	remoteEnabled: false,
	remotePort: 7654,
	remoteAccess: 'lan',
	remoteSshTarget: '',
	remoteSshRemotePort: 80
};

/**
 * The desktop app starts with these effects off. Its shared settings file only stores values
 * that differ from the defaults it is given, so it must be given these too: otherwise turning
 * one of them on matches DEFAULT_SETTINGS and is never written.
 */
export const DESKTOP_SETTING_DEFAULTS = { glow: 'off', glass: false, textReveal: 'off' } as const satisfies Partial<AgentSettings>;

export interface Folder {
	id: string;
	name: string;
	color: string;
}

export interface McpServerConfig {
	id: string;
	name: string;
	transport: 'stdio' | 'http';
	command: string;
	args: string[];
	env: Record<string, string>;
	url: string;
	headers: Record<string, string>;
	enabled: boolean;
	/** Trusted servers' tools run without an approval card in Agent mode. */
	trusted: boolean;
	/** Set for servers declared by a plugin's .mcp.json (read-only here). */
	plugin?: string;
	/** Tools switched off: not offered to the model (fewer tokens, less noise). */
	disabledTools?: string[];
}

export type SessionMeta = Pick<Session, 'id' | 'title' | 'updatedAt' | 'folderId' | 'archived' | 'pinned' | 'projectPath'> & {
	completedAt?: number;
	outcome?: 'completed' | 'failed' | 'stopped';
	unread?: boolean;
	count: number;
	/** Lines added / removed by the agent across the chat (Codex-style list). */
	added?: number;
	removed?: number;
	/** Model of the last answer. */
	model?: string;
};

export const DEFAULT_WEEKLY_LIMIT = 1_000_000;
export const DEFAULT_FIVE_HOUR_LIMIT = 200_000;

export interface UsageEvent {
	t: number;
	sessionId?: string;
	providerId: string;
	model: string;
	tokensIn: number;
	tokensOut: number;
	/** Input tokens served from the prompt cache (billed cheaper). */
	tokensCached?: number;
	tokensCacheWrite?: number;
	usage?: ModelUsage;
	usageSource?: 'provider' | 'partial' | 'unknown';
	attemptId?: string;
	turnId?: string;
	parentTurnId?: string;
	purpose?: RequestAttempt['purpose'];
	request?: RequestAttempt;
	cost?: number;
	costKind?: RequestAttempt['costKind'];
	prices?: UsagePrices;
	priceVersion?: string;
	/** Which key of the provider's pool served the request: its position and a masked hint. Absent on single-key providers and on records from before per-key attribution ("not recorded"). */
	keyIndex?: number;
	keyHint?: string;
}

/** A pool key without its secret: only the last four characters survive ("…a8f3"). */
export function poolKeyHint(key: string): string {
	const k = String(key).trim();
	return k.length > 8 ? '…' + k.slice(-4) : '…';
}

export interface WindowSummary {
	used: number;
	limit: number;
	/** 0-100: how much of the limit remains (what the ring shows). */
	remainingPct: number;
	/** ms until the oldest sample leaves the window. */
	resetsInMs: number;
}

/** What a saved memory is about: who the user is, how they want answers, or a subject. */
export type MemoryCategory = 'profile' | 'preferences' | 'topics';
/** A durable fact, or how a recurring problem was solved (procedural memory). */
export type MemoryArea = 'fact' | 'solution';

export interface Memory {
	id: string;
	text: string;
	ts: number;
	/** Set when the fact was edited or re-saved; the page shows "Updated". */
	updatedAt?: number;
	category?: MemoryCategory;
	/** Solutions are listed separately in recall: they say what fixed a problem. */
	area?: MemoryArea;
	/** Pinned memories ride along with every recall, even on a cold keyword. */
	pinned?: boolean;
	/** Who saved it: the agent during a chat, or you on the Memory page. */
	source?: 'agent' | 'user';
	/** Learned by the background extractor rather than saved by the agent or you. */
	auto?: boolean;
	sourceSessionId?: string;
	archived?: boolean;
	recallReason?: string;
	/** Embedding of `text`, base64 Float32Array; absent until semantics are used. */
	vec?: string;
	/** The embedding model that produced `vec`; a different model discards it. */
	vecModel?: string;
}

/**
 * Embeddings for memory recall. Supplied by the host so this store stays free
 * of network and local-engine details; absent means keyword recall only.
 */
export interface MemoryEmbedder {
	/** Identifies the model; vectors from another model are recomputed. */
	model(): string;
	embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Group a fact without a model call — keyword shapes are enough to tell
 * "the user prefers dark theme" from "the user's dog is called Beans".
 */
export function classifyMemory(text: string): MemoryCategory {
	const t = text.toLowerCase();
	if (
		/\b(prefer\w*|favorite|favourite|always|never|instead of|rather than|concise|brief|verbose|tone|formal|casual|responds?|replies|answers?|explains?|comments?|emoji|style)\b/.test(t) ||
		/\b(how (the user|they|i) want\w*)\b/.test(t)
	) {
		return 'preferences';
	}
	if (
		/\b(the )?user('s)? (is|are|works?|runs?|owns?|lives?|studies?|name|job|work|role|business|company|team|project|dog|cat|pet|family|wife|husband|partner|son|daughter)\b/.test(t) ||
		/\b(my|his|her|their) (name|job|work|role|business|company|dog|cat|pet|family|wife|husband|partner|son|daughter|hometown)\b/.test(t) ||
		/\b(name is|i am \d|years old|based in|lives in)\b/.test(t)
	) {
		return 'profile';
	}
	return 'topics';
}

export interface ToolCardInfo {
	/** Activity display only; never an authorization decision. */
	externalAction?: boolean;
	callId?: string;
	durationMs?: number;
	name: string;
	/** Short human-readable argument (path, query, command…). */
	arg: string;
	status: 'running' | 'done' | 'error';
	summary: string;
	/** Expandable detail (tool output excerpt). */
	detail?: string;
	/** Browser screenshot thumbnail (data: URL). */
	image?: string;
	/** Page URL for browser tool cards. */
	url?: string;
}

/** A question the agent asked the user (ask_user tool). */
export interface Question {
	id: string;
	text: string;
	options: string[];
	status: 'pending' | 'answered' | 'skipped';
	answer?: string;
}

export interface Approval {
	id: string;
	kind: 'edit' | 'write' | 'command' | 'mcp' | 'patch' | 'image';
	/** MCP approvals: tool name + JSON arguments. */
	tool?: string;
	args?: string;
	/** MCP: the server declared this tool destructive, so it is never auto-approved. */
	destructive?: boolean;
	/** Server-declared write activity, for the chat summary only. */
	externalAction?: boolean;
	path?: string;
	find?: string;
	replace?: string;
	content?: string;
	existed?: boolean;
	command?: string;
	status: 'pending' | 'applied' | 'rejected';
	/** Approval grants permission; only finish() establishes the execution outcome. */
	execution?: 'running' | 'done' | 'error';
	/** True when Full-access mode approved it without asking. */
	auto?: boolean;
	/** Which rule auto-approved it when not Full access ("edits", "allowlist", …). */
	autoRule?: string;
	/** Commands: runs inside the OS sandbox (writes limited to the workspace). */
	sandboxed?: boolean;
	/** Commands: the sandbox blocks no reads — the card warns that any file on the computer is readable. */
	sandboxReads?: 'all';
	/** Commands: the agent asked to run outside the sandbox (always needs approval). */
	escalate?: boolean;
	/** Images: the call spends money on a provider (local Studio generation does not). */
	cost?: boolean;
	/** Commands: the project's command rules (.zer0ne/command-rules) say always ask, or allow without a card; pending = an allow line the user has not trusted yet. */
	projectRule?: 'ask' | 'allow' | 'pending';
	/** Commands: the ` # reason` the matching project rule carries, when it has one. */
	projectRuleReason?: string;
	/** Outcome after running (command output excerpt, error…). */
	result?: string;
	failed?: boolean;
}

export interface FileEdit {
	path: string;
	added: number;
	removed: number;
	created?: boolean;
	deleted?: boolean;
	previewBefore?: string;
	previewAfter?: string;
	undone?: boolean;
}

export interface TurnInfo {
	verification?: import('./host/taskEvidence').VerificationReceipt[];
	review?: 'pass' | 'changes' | 'blocked';
	workflow?: SubagentWorkflow;
	taskBudget?: import('./core/taskBudget').TaskBudgetSnapshot;
	startedAt: number;
	endedAt?: number;
	outcome?: 'completed' | 'failed' | 'stopped';
	edits?: FileEdit[];
	/** Snapshots for Undo and Redo are kept on disk. */
	undoable?: boolean;
	undone?: boolean;
	/** Files the turn changed that were too large to snapshot: not undoable. */
	undoSkipped?: string[];
	model?: string;
	/** Provider display name (for the answer footer). */
	provider?: string;
	/** Stable provider identity for usage drilldowns (older turns only have the name). */
	providerId?: string;
	/** Tokens reported by the provider for this turn (cached = served from the prompt cache). */
	usage?: ModelUsage & { cost?: number; attempts?: number; knownAttempts?: number; cacheKnownAttempts?: number };
	/** The turn's last request as the provider counted it (input incl. cache + output): what the context holds after this turn. Absent when not reported. */
	contextTokens?: number;
	attempts?: RequestAttempt[];
	/** Wall time includes hooks, approval waits and execution; arguments/results are excluded. */
	toolTimings?: Array<{ callId: string; name: string; step: number; startedAt: number; durationMs: number; queueMs?: number; runMs?: number; pool?: string; outcome: 'completed' | 'failed' | 'cancelled' }>;
}

export interface HookConfig {
	required?: boolean;
	id: string;
	event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'PreCompact' | 'SubagentStart' | 'SubagentStop' | 'Stop' | 'SessionEnd';
	/** Tool-name regex for tool events ('' = all tools). */
	matcher: string;
	command: string;
	enabled: boolean;
	timeoutSec: number;
}

export interface StoredMessage {
	memoryRecall?: Array<{ id: string; text: string; reason: string; area?: MemoryArea }>;
	/** Earliest retry time explicitly reported by the provider. */
	retryAt?: number;
	mcpApp?: { toolName: string; resourceUri: string; input: Record<string, unknown>; result: Record<string, unknown> };
	/** Automatic background follow-ups retain their originating task budget. */
	rootTaskId?: string;
	
	thread?: string;
	id: string;
	role: 'user' | 'assistant';
	/** Display markdown. */
	content: string;
	/** User messages: full text sent to the API (attached file context). */
	apiContent?: string;
	/** Names of images/files attached to a user message (display only). */
	attachments?: string[];
	reasoning?: string;
	/** Assistant messages: how long the model reasoned before answering (ms). */
	reasoningMs?: number;
	isError?: boolean;
	
	local?: boolean;
	kind?: 'tool';
	tool?: ToolCardInfo;
	todos?: Array<{ text: string; done: boolean }>;
	approval?: Approval;
	question?: Question;
	/** "Context compacted" divider. */
	compacted?: boolean;
	/** Creation time (ms). */
	at?: number;
	/** User messages: the agent turn this prompt started (Codex-style summary). */
	turn?: TurnInfo;
	/** Model that produced an assistant message. */
	model?: string;
}

export interface SessionGoal {
	objective: string;
	/** active: checked when the agent finishes · met: the judge confirmed it · stopped: rounds ran out or the user stopped it · unverified: the judge could not run. */
	status: 'active' | 'met' | 'stopped' | 'unverified';
	/** Times the agent was sent back to work. */
	rounds: number;
	maxRounds: number;
	startedAt: number;
	endedAt?: number;
	/** The judge's last word: what is missing, or why it could not decide. */
	note?: string;
	/** The acceptance command (/goal … --check "npm test"): the goal is never met while it fails. */
	check?: string;
	/** One entry per check of the goal, newest last (capped): the run's progress record. */
	log?: GoalLogEntry[];
}

export interface GoalLogEntry {
	at: number;
	/** The round this check closed; 0 for the first finish. */
	round: number;
	verdict: 'met' | 'missing' | 'unverified';
	/** The acceptance command's result, when the goal has one. */
	check?: 'passed' | 'failed' | 'skipped';
	note: string;
}

export interface ModelSelection {
	providerId: string;
	model: string;
}

export interface Session {
	selection?: ModelSelection;
	subagentWorkflow?: SubagentWorkflow;
	id: string;
	title: string;
	updatedAt: number;
	messages: StoredMessage[];
	/** Absolute local project root. Absent on legacy/unassigned chats. */
	projectPath?: string;
	folderId?: string;
	archived?: boolean;
	pinned?: boolean;
	lastReadAt?: number;
	/** Message IDs pinned to the conversation's chapter rail. */
	chapters?: string[];
	/** Skills kept active for every turn in this chat (names from the skill catalog). */
	pinnedSkills?: string[];
	/** Auto-compact: summary replacing messages up to (and including) `upTo`. */
	/** frames: set by the retired picture compaction (before 0.30); such a summary is replaced on the next compaction. */
	/** `at`: when it was written — provider token counts from turns that started earlier still include the summarized text. */
	summary?: { text: string; upTo: string; frames?: number; at?: number };
	/** Goal mode (/goal): the objective the agent works toward until a judge confirms it (host/goal.ts). */
	goal?: SessionGoal;
	/** User-renamed titles stop auto-titling. */
	customTitle?: boolean;
	/** "Branch in new chat": the chat this one was copied from, and its last copied message. */
	branchedFrom?: { id: string; title: string; afterId?: string };
}

export function sessionActivity(messages: StoredMessage[], lastReadAt?: number): { completedAt?: number; outcome?: TurnInfo['outcome']; unread?: boolean } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const turn = messages[i].turn;
		if (!turn) continue;
		if (!Number.isFinite(turn.endedAt) || !turn.endedAt) return {};
		const outcome = turn.outcome;
		return { completedAt: turn.endedAt, outcome, unread: (outcome === 'completed' || outcome === 'failed') && lastReadAt !== undefined && turn.endedAt > lastReadAt };
	}
	return {};
}

/** Provider view sent to webviews: never contains the API key itself. */
export interface ProviderView extends ProviderConfig {
	hasKey: boolean;
	efforts: Record<string, string>;
	reasoningControls?: Record<string, ReasoningControl>;
	/** Signed-in account (never the tokens). */
	account?: ReturnType<typeof describeCredential>;
	/** Keys in the pool, when more than one. */
	keys?: number;
}

const PROVIDERS_KEY = 'aiChat.providers';
const SELECTED_PROVIDER_KEY = 'aiChat.selectedProviderId';
const SELECTED_MODEL_KEY = 'aiChat.selectedModel';
const DEFAULT_SELECTION_KEY = 'aiChat.defaultModelSelection';
const MODEL_FAVORITES_KEY = 'aiChat.modelFavorites';
const MODEL_RECENT_KEY = 'aiChat.modelRecent';
const SESSIONS_KEY = 'aiChat.sessions';
const CURRENT_SESSION_KEY = 'aiChat.currentSession';
export const PROJECT_CURRENT_SESSION_PREFIX = 'aiChat.projectCurrentSession.';
const LEGACY_MESSAGES_KEY = 'aiChat.messages';
const USAGE_KEY = 'aiChat.usage';
const EFFORT_KEY = 'aiChat.efforts';
const SETTINGS_KEY = 'aiChat.settings';
const MODE_KEY = 'aiChat.mode';
const FOLDERS_KEY = 'aiChat.folders';
const MCP_KEY = 'aiChat.mcpServers';
const HOOKS_KEY = 'aiChat.hooks';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const KEEP_USAGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_USAGE_EVENTS = 5000;
/** Cap for per-message attached context kept in history. */
const MAX_API_CONTENT_CHARS = 60_000;
/** Browser screenshots are kept only on the newest cards (they are large data URLs). */
const KEEP_SCREENSHOTS = 8;

/**
 * The trims every long history gets: screenshots beyond the newest few and
 * oversized attached context. The store applies this when saving, so a restart
 * shows the trimmed history — the engine applies the same to its live copy,
 * which keeps process memory and every state post in step with that.
 */
export function trimForStorage(messages: StoredMessage[]): StoredMessage[] {
	let shots = 0;
	let generated = 0;
	return [...messages].reverse().map((m) => {
		let out = m;
		if (out.tool?.image) {
			// A generated image exists on disk and is linked from its card: keep only the newest previews.
			const drop = out.tool.name === 'image_generate' ? ++generated > 2 : ++shots > KEEP_SCREENSHOTS;
			if (drop) {
				out = { ...out, tool: { ...out.tool, image: undefined } };
			}
		}
		if (out.apiContent && out.apiContent.length > MAX_API_CONTENT_CHARS) {
			out = { ...out, apiContent: out.apiContent.slice(0, MAX_API_CONTENT_CHARS) + '\n[… truncated]' };
		}
		return out;
	}).reverse();
}

/** Only absolute filesystem paths, never URLs or paths resolved against the process cwd. */
export function normalizeProjectPath(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || !path.isAbsolute(value)) return undefined;
	if (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) return undefined;
	return path.resolve(value);
}

export function projectPathKey(value: string): string {
	const normalized = path.resolve(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function currentProjectPath(): string | undefined {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	return root?.scheme === 'file' ? normalizeProjectPath(root.fsPath) : undefined;
}

export function newId(prefix: string): string {
	return prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

function secretKeyFor(providerId: string): string {
	return `aiChat.apiKey.${providerId}`;
}

function cleanNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function normalizeModel(raw: unknown): ModelEntry | undefined {
	if (typeof raw === 'string') {
		const id = raw.trim();
		return id ? { id, enabled: true, smart: true } : undefined;
	}
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const m = raw as Partial<ModelEntry>;
	const id = typeof m.id === 'string' ? m.id.trim() : '';
	if (!id) {
		return undefined;
	}
	const reasoningControl = normalizeReasoningControl(m.reasoningControl);
	return {
		id,
		enabled: m.enabled !== false,
		smart: m.smart !== false,
		manualFields: Array.isArray(m.manualFields) ? MODEL_SETTINGS.filter((field) => m.manualFields!.includes(field)) : m.tools === false ? ['tools'] : undefined,
		contextWindow: cleanNumber(m.contextWindow),
		maxOutput: cleanNumber(m.maxOutput),
		vision: typeof m.vision === 'boolean' ? m.vision : undefined,
		tools: typeof m.tools === 'boolean' ? m.tools : undefined,
		reasoning: typeof m.reasoning === 'boolean' ? m.reasoning : undefined,
		...(reasoningControl ? { reasoningControl } : {}),
		...(m.agentProfile && ['lean', 'full'].includes(m.agentProfile.tools) && typeof m.agentProfile.suite === 'string' && /^[a-f0-9]{64}$/.test(m.agentProfile.suite) && Number.isSafeInteger(m.agentProfile.total) && m.agentProfile.total >= 6 && Number.isSafeInteger(m.agentProfile.passed) && m.agentProfile.passed >= 0 && m.agentProfile.passed <= m.agentProfile.total && Number.isSafeInteger(m.agentProfile.trials) && m.agentProfile.trials >= 3 && m.agentProfile.trials <= 10 && Number.isFinite(m.agentProfile.at) && m.agentProfile.at <= Date.now() ? { agentProfile: m.agentProfile } : {}),
		priceIn: typeof m.priceIn === 'number' && m.priceIn >= 0 ? m.priceIn : undefined,
		priceOut: typeof m.priceOut === 'number' && m.priceOut >= 0 ? m.priceOut : undefined,
		name: typeof m.name === 'string' && m.name.trim() && m.name.trim() !== id ? m.name.trim().slice(0, 80) : undefined,
		note: typeof m.note === 'string' && m.note.trim() ? m.note.trim().slice(0, 160) : undefined
	};
}

function dedupeModels(models: unknown[]): ModelEntry[] {
	const seen = new Set<string>();
	const out: ModelEntry[] = [];
	for (const raw of models) {
		const m = normalizeModel(raw);
		if (m && !seen.has(m.id)) {
			seen.add(m.id);
			out.push(m);
		}
	}
	return out;
}

/** Upgrade any older stored shape in place (string models, single `model`). */
function migrate(raw: Partial<ProviderConfig> & { model?: string; models?: unknown[] }): ProviderConfig {
	const models = Array.isArray(raw.models)
		? dedupeModels(raw.models)
		: typeof raw.model === 'string' && raw.model
			? dedupeModels([raw.model])
			: [];
	return {
		id: typeof raw.id === 'string' && raw.id ? raw.id : newId('p'),
		name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'New provider',
		baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '',
		apiFormat: ['responses', 'anthropic', 'vscode-lm', 'gemini', 'bedrock', 'vertex', 'codex', 'acp'].includes(raw.apiFormat as string) ? (raw.apiFormat as ApiFormat) : 'openai',
		models,
		enabled: raw.enabled !== false,
		catalogId: typeof raw.catalogId === 'string' ? raw.catalogId : undefined,
		preset: typeof raw.preset === 'string' ? raw.preset : undefined,
		auth: raw.auth === 'oauth' || raw.auth === 'vscode' || raw.auth === 'account' ? raw.auth : undefined,
		agent: raw.agent && typeof raw.agent.id === 'string' ? { id: raw.agent.id, plan: typeof raw.agent.plan === 'string' ? raw.agent.plan : undefined, email: typeof raw.agent.email === 'string' ? raw.agent.email : undefined } : undefined,
		weeklyTokenLimit: cleanNumber(raw.weeklyTokenLimit) ?? 0,
		fiveHourTokenLimit: cleanNumber(raw.fiveHourTokenLimit) ?? 0,
		health: raw.health && typeof raw.health.ok === 'boolean' && typeof raw.health.at === 'number' ? { ok: raw.health.ok, at: raw.health.at, ...(typeof raw.health.error === 'string' ? { error: raw.health.error.slice(0, 10_000) } : {}), ...(raw.health.signIn === true ? { signIn: true } : {}) } : undefined
	};
}

export interface ProviderHealth {
	ok: boolean;
	at: number;
	error?: string;
	signIn?: boolean;
}

/** An agent's own failure report written as its answer (Antigravity: "Agent execution error: … (code 403): Verify your account…") (pure; tested). */
export function agentFailureText(text: string): boolean {
	return verificationFailureText(text) || /^\s*(agent execution error|error:|request failed)\b/i.test(text) && text.length < 1200;
}

/**
 * Whether an error means the account itself needs attention — signed out,
 * expired, unverified, out of credits or plan — rather than a passing network
 * or model hiccup (pure; tested).
 */
export function accountProblem(message: string): boolean {
	return /\b(401|402|403)\b|unauthori[sz]ed|forbidden|sign(ed)?[- ]?in (again|expired)|not (signed|logged) in|log ?in (again|required)|authentication (failed|required)|invalid (api )?key|verify your account|account verification|run out of credits|out of credits|insufficient (credits|balance|quota)|need a [\w ]*subscription|subscription (required|expired|inactive)|quota exceeded|billing/i.test(message);
}

/** Auto-title: first user message, trimmed. */
function titleFrom(messages: StoredMessage[]): string {
	const first = messages.find((m) => m.role === 'user' && !m.isError && !m.local);
	if (!first) {
		return '';
	}
	const line = first.content.replace(/[`*#>\n]+/g, ' ').replace(/\s+/g, ' ').trim();
	return line.length > 60 ? line.slice(0, 60) + '…' : line || 'New chat';
}

const normalizeMessages = validMessages;

export class ProviderStore {
	private static readonly memoryWrites = new WeakMap<vscode.Memento, Promise<void>>();
	private static readonly providerWrites = new WeakMap<vscode.Memento, Promise<void>>();
	private serializeProviders<T>(action: () => Promise<T>): Promise<T> {
		const next = (ProviderStore.providerWrites.get(this.state) ?? Promise.resolve()).then(action);
		ProviderStore.providerWrites.set(this.state, next.then(() => undefined, () => undefined));
		return next;
	}
	private sessionWrites: Promise<void> = Promise.resolve();
	/** Explicit selection is window-local; another window's global pointer cannot replace it. */
	private readonly windowCurrentSessions = new Map<string, string>();
	private serializeSessions<T>(action: () => Promise<T>): Promise<T> {
		const next = this.sessionWrites.then(action);
		this.sessionWrites = next.then(() => undefined, () => undefined);
		return next;
	}
	private usageWrites: Promise<void> = Promise.resolve();
	private readonly usageListeners = new Set<() => void>();
	onUsageRecorded(listener: () => void): { dispose(): void } {
		this.usageListeners.add(listener);
		return { dispose: () => { this.usageListeners.delete(listener); } };
	}
	constructor(private readonly context: vscode.ExtensionContext) {}

	private get state(): vscode.Memento {
		return this.context.globalState;
	}

	// ---------------- providers ----------------

	async list(): Promise<ProviderConfig[]> {
		const raw = this.state.get<unknown[]>(PROVIDERS_KEY, []);
		const migrated = (Array.isArray(raw) ? raw : []).map((p) => migrate(p as Partial<ProviderConfig>));
		if (JSON.stringify(raw) !== JSON.stringify(migrated)) {
			await this.state.update(PROVIDERS_KEY, migrated);
		}
		return migrated.filter(hostProviderAllowed);
	}

	async get(id: string): Promise<ProviderConfig | undefined> {
		return (await this.list()).find((p) => p.id === id);
	}

	private async save(list: ProviderConfig[]): Promise<void> {
		const preserved = (this.state.get<ProviderConfig[]>(PROVIDERS_KEY, [])).filter(p => !hostProviderAllowed(p));
		await this.state.update(PROVIDERS_KEY, [...preserved, ...list]);
	}

	async add(init: Partial<Omit<ProviderConfig, 'id'>>): Promise<ProviderConfig> {
		return this.serializeProviders(async () => {
			if (!hostProviderAllowed(init)) throw new Error('This provider is unavailable in the desktop app.');
			const list = await this.list();
			const baseName = (init.name ?? '').trim() || 'New provider';
			// Keep names unique so the rail and the model menu stay unambiguous.
			let name = baseName;
			for (let i = 2; list.some((p) => p.name.toLowerCase() === name.toLowerCase()); i++) {
				name = `${baseName} ${i}`;
			}
			const created = migrate({ ...init, id: newId('p'), name, models: init.models ?? [] });
			await this.save([...list, created]);
			return created;
		});
	}

	/** Merge-patch a provider's non-secret fields. */
	async update(id: string, patch: ProviderPatch | ((current: ProviderConfig) => ProviderPatch | Promise<ProviderPatch>)): Promise<ProviderConfig> {
		return this.serializeProviders(async () => {
			const list = await this.list();
			const current = list.find((p) => p.id === id);
			if (!current) {
				throw new Error('That provider no longer exists.');
			}
			const changes = typeof patch === 'function' ? await patch(current) : patch;
			if ('name' in changes && !(typeof changes.name === 'string' && changes.name.trim())) {
				throw new Error('Provider name cannot be empty.');
			}
			if (typeof changes.baseUrl === 'string' && changes.baseUrl.trim() && current.apiFormat !== 'vscode-lm' && current.apiFormat !== 'acp' && !/^https?:\/\//i.test(changes.baseUrl.trim())) {
				throw new Error('Base URL must start with http:// or https://');
			}
			const next = migrate({ ...current, ...changes, id });
			if (next.baseUrl !== current.baseUrl || next.apiFormat !== current.apiFormat) next.models = next.models.map(({ agentProfile: _profile, ...model }) => model);
			if (next.baseUrl !== current.baseUrl && insecureRemote(next.baseUrl) && await this.context.secrets.get(secretKeyFor(id))) throw new Error('Plain http:// to a public host would send your API key unencrypted — use https://.');
			if (next.baseUrl !== current.baseUrl || next.apiFormat !== current.apiFormat) await this.clearModelChecks(id);
			await this.save(list.map((p) => (p.id === id ? next : p)));
			return next;
		});
	}

	async delete(id: string): Promise<void> {
		await this.serializeProviders(async () => {
			await this.clearModelChecks(id);
			await this.context.secrets.delete(secretKeyFor(id));
			await this.context.secrets.delete(secretKeyFor(id) + '.registration');
			await this.save((await this.list()).filter((p) => p.id !== id));
			const effortMap = { ...this.state.get<Record<string, string>>(EFFORT_KEY, {}) };
			for (const key of Object.keys(effortMap)) {
				if (key.startsWith(id + '::')) {
					delete effortMap[key];
				}
			}
			await this.state.update(EFFORT_KEY, effortMap);
			await this.remapModelSelections(id);
		});
	}

	async duplicate(id: string): Promise<ProviderConfig> {
		const provider = await this.get(id);
		if (!provider) throw new Error('That provider no longer exists.');
		// Renewable sessions rotate their refresh tokens; copies need an independent sign-in.
		const account = provider.auth === 'account';
		const { id: _id, ...rest } = provider;
		const copy = await this.add({ ...rest, name: `${provider.name} (copy)`, ...(account ? { enabled: false, health: { ok: false, at: Date.now(), signIn: true, error: 'Sign in to connect this copy with its own account session.' } } : {}) });
		try {
			if (!account) {
				const keys = await this.context.secrets.get(secretKeyFor(id));
				if (keys) await this.setApiKey(copy.id, keys);
			}
			return copy;
		} catch (error) {
			await this.delete(copy.id);
			throw error;
		}
	}

	/** Add or replace one model; `originalId` renames an existing entry. */
	async upsertModel(providerId: string, model: ModelEntry, originalId?: string): Promise<ProviderConfig> {
		const entry = normalizeModel(model);
		if (!entry) {
			throw new Error('Model ID cannot be empty.');
		}
		const replacing = originalId ?? entry.id;
		if (entry.id !== replacing) delete entry.agentProfile;
		const updated = await this.update(providerId, provider => {
			if (entry.id !== replacing && provider.models.some((m) => m.id === entry.id)) {
				throw new Error(`"${entry.id}" is already in the list.`);
			}
			const exists = provider.models.some((m) => m.id === replacing);
			const models = exists
				? provider.models.map((m) => (m.id === replacing ? entry : m))
				: [...provider.models, entry];
			return { models };
		});
		if (originalId && originalId !== entry.id) await this.remapModelSelections(providerId, originalId, entry.id);
		return updated;
	}

	async removeModel(providerId: string, modelId: string): Promise<void> {
		const provider = await this.get(providerId);
		if (!provider) {
			return;
		}
		await this.update(providerId, current => ({ models: current.models.filter((m) => m.id !== modelId) }));
		await this.remapModelSelections(providerId, modelId);
	}

	async setApiKey(providerId: string, apiKey: string): Promise<void> {
		await this.serializeProviders(async () => {
			const provider = await this.get(providerId);
			if (apiKey && provider && insecureRemote(provider.baseUrl)) throw new Error('Plain http:// to a public host would send your API key unencrypted — use https://.');
			if (apiKey !== await this.context.secrets.get(secretKeyFor(providerId))) await this.clearModelChecks(providerId);
			if (apiKey) {
				await this.context.secrets.store(secretKeyFor(providerId), apiKey);
			} else {
				await this.context.secrets.delete(secretKeyFor(providerId));
			}
		});
	}

	async hasApiKey(providerId: string): Promise<boolean> {
		const key = await this.context.secrets.get(secretKeyFor(providerId));
		return typeof key === 'string' && key.length > 0;
	}

	/**
	 * The key for a request. Account sign-ins return a current access token:
	 * refreshed shortly before it expires and saved back (concurrent requests
	 * share one refresh).
	 */
	async getApiKey(providerId: string): Promise<string | undefined> {
		const raw = await this.context.secrets.get(secretKeyFor(providerId));
		const cred = parseCredential(raw);
		if (!cred) {
			// A key pool ("key1, key2, …"): the current one; rotateKey moves on after a rate limit.
			const pool = splitKeys(raw);
			return pool.length > 1 ? pool[(this.keyIndex.get(providerId) ?? 0) % pool.length] : raw?.trim();
		}
		try {
			if (cred.expires - 60_000 > Date.now() || !cred.refresh) return cred.access;
			return await withCredentialLock(this.accountLockKey(providerId), new AbortController().signal, async () => {
				const latest = await this.context.secrets.get(secretKeyFor(providerId));
				const current = parseCredential(latest);
				if (!current) throw new Error('This account was signed out — sign in again.');
				const fresh = await ensureFresh(current);
				if (await this.context.secrets.get(secretKeyFor(providerId)) !== latest) throw new Error('The account changed during renewal. Retry with the current sign-in.');
				if (fresh !== current) await this.context.secrets.store(secretKeyFor(providerId), serializeCredential(fresh));
				return fresh.access;
			});
		} catch (e) {
			// Offline or a failed refresh: the old token still works until it expires.
			if (cred.expires > Date.now() && await this.context.secrets.get(secretKeyFor(providerId)) === raw) return cred.access;
			throw e;
		}
	}

	/** Current position in each provider's key pool (in memory: a restart starts at the first key). */
	private readonly keyIndex = new Map<string, number>();

	/**
	 * True when the provider's secret is an account sign-in, not a plain API
	 * key. An account's access token is short-lived, renewable and grants the
	 * whole account: it must never be copied into a file or sent to a third
	 * party as if it were a static key.
	 */
	async isAccountCredential(providerId: string): Promise<boolean> {
		return !!parseCredential(await this.context.secrets.get(secretKeyFor(providerId)));
	}

	/** How many keys the provider has (a pool when > 1). */
	async keyCount(providerId: string): Promise<number> {
		return splitKeys(await this.context.secrets.get(secretKeyFor(providerId))).length;
	}

	/** Move to the next key of a pool; false when there is only one. */
	async rotateKey(providerId: string): Promise<boolean> {
		const n = await this.keyCount(providerId);
		if (n < 2) return false;
		this.keyIndex.set(providerId, ((this.keyIndex.get(providerId) ?? 0) + 1) % n);
		return true;
	}

	/**
	 * Which key of the provider's pool serves (or has just served) a request:
	 * its position and a masked hint. undefined outside a pool — a single key
	 * or an account sign-in needs no attribution, and usage rows stay clean.
	 */
	async keyInfoOf(providerId: string, servedKey?: string): Promise<{ index: number; hint: string } | undefined> {
		const raw = await this.context.secrets.get(secretKeyFor(providerId));
		if (parseCredential(raw)) return undefined;
		const pool = splitKeys(raw);
		if (pool.length < 2) return undefined;
		const index = servedKey === undefined ? (this.keyIndex.get(providerId) ?? 0) % pool.length : pool.indexOf(servedKey);
		if (index < 0) return undefined;
		return { index, hint: poolKeyHint(pool[index]) };
	}

	/** Save a subscription sign-in as the provider's credential. */
	private accountLockKey(providerId: string): string {
		return 'subscription:' + (this.context.globalStorageUri?.fsPath ?? 'zer0ne') + ':' + providerId;
	}

	/** Stop refreshes before revoking and clearing the current renewable session. */
	async signOutAccount<T>(providerId: string, revoke: (cred: AccountCredential) => Promise<T>): Promise<T | undefined> {
		return withCredentialLock(this.accountLockKey(providerId), new AbortController().signal, async () => {
			const current = parseCredential(await this.context.secrets.get(secretKeyFor(providerId)));
			try { return current ? await revoke(current) : undefined; }
			finally { await this.context.secrets.delete(secretKeyFor(providerId)); }
		});
	}

	private hostIdWrite?: Promise<string>;
	/** OAuth registration identifies this installation independently of projects and reconnects. */
	accountHostId(): Promise<string> {
		return this.hostIdWrite ??= withCredentialLock(this.accountLockKey('host-registration'), new AbortController().signal, async () => {
			const saved = this.state.get<string>('zer0ne.accountHostId', '');
			if (/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return saved;
			const id = 'urn:uuid:' + randomUUID();
			await this.state.update('zer0ne.accountHostId', id);
			return id;
		}).catch((error) => { this.hostIdWrite = undefined; throw error; });
	}

	async setAccount(providerId: string, cred: AccountCredential): Promise<void> {
		await withCredentialLock(this.accountLockKey(providerId), new AbortController().signal, async () => {
		await this.context.secrets.store(secretKeyFor(providerId), serializeCredential(cred));
		if (cred.clientId && cred.subject) {
			const { account, clientId, hostId, subject, email, scopes } = cred;
			await this.context.secrets.store(secretKeyFor(providerId) + '.registration', JSON.stringify({ account, clientId, hostId, subject, email, scopes }));
		}
		});
	}

	/** Reauthorization uses the existing client even after local tokens have been cleared. */
	async getAccountForSignIn(providerId: string): Promise<AccountCredential | undefined> {
		const current = parseCredential(await this.context.secrets.get(secretKeyFor(providerId)));
		if (current) return current;
		try {
			const saved = JSON.parse((await this.context.secrets.get(secretKeyFor(providerId) + '.registration')) ?? 'null');
			if (saved?.account === 'chatgpt' && typeof saved.clientId === 'string' && typeof saved.subject === 'string') return { ...saved, kind: 'account', access: '', refresh: '', expires: 0 };
		} catch { /* Missing registration starts a fresh authorization. */ }
		return undefined;
	}

	/** The account credential, refreshed when needed (for model lists). */
	async getAccountCredential(providerId: string): Promise<AccountCredential | undefined> {
		await this.getApiKey(providerId);
		return parseCredential(await this.context.secrets.get(secretKeyFor(providerId)));
	}

	/** Who is signed in (no tokens), when the provider uses an account. */
	async getAccount(providerId: string): Promise<ProviderView['account']> {
		const cred = parseCredential(await this.context.secrets.get(secretKeyFor(providerId)));
		return cred ? describeCredential(cred) : undefined;
	}

	// ---------------- selection ----------------

	async getSelectedProviderId(): Promise<string | undefined> {
		return (await this.selectionForSession()).providerId;
	}

	async getSelectedModel(): Promise<string | undefined> {
		return (await this.selectionForSession()).model;
	}

	async setSelectedModel(model: string | undefined): Promise<void> {
		await this.setSelection(await this.getSelectedProviderId(), model);
	}

	private defaultSelection(): Partial<ModelSelection> {
		return this.state.get<ModelSelection | undefined>(DEFAULT_SELECTION_KEY) ?? { providerId: this.state.get<string>(SELECTED_PROVIDER_KEY), model: this.state.get<string>(SELECTED_MODEL_KEY) };
	}

	private initialSelection(session?: Session): Partial<ModelSelection> {
		if (session?.selection && typeof session.selection.providerId === 'string' && typeof session.selection.model === 'string') return session.selection;
		const turn = [...(session?.messages ?? [])].reverse().find(m => m.turn?.providerId && m.turn.model)?.turn;
		return turn?.providerId && turn.model ? { providerId: turn.providerId, model: turn.model } : this.defaultSelection();
	}

	private async selectionForSession(sessionId?: string): Promise<Partial<ModelSelection>> {
		const id = sessionId ?? await this.currentSessionId();
		return this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			const session = sessions.find(s => s.id === id);
			if (!session) throw new Error('That chat no longer exists.');
			const selection = this.initialSelection(session);
			if ((!session.selection || typeof session.selection.providerId !== 'string' || typeof session.selection.model !== 'string') && selection.providerId && selection.model) {
				session.selection = { providerId: selection.providerId, model: selection.model };
				await this.state.update(SESSIONS_KEY, sessions);
			}
			return selection;
		});
	}

	async setSelection(providerId: string | undefined, model: string | undefined, sessionId?: string): Promise<void> {
		const id = sessionId ?? await this.currentSessionId();
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			const session = sessions.find(s => s.id === id);
			if (!session) throw new Error('That chat no longer exists.');
			session.selection = providerId && model ? { providerId, model } : undefined;
			await this.state.update(SESSIONS_KEY, sessions);
			await this.state.update(DEFAULT_SELECTION_KEY, providerId && model ? { providerId, model } : {});
			if (providerId && model) {
				const recent = this.getModelPreferences().recent.filter(s => s.providerId !== providerId || s.model !== model);
				await this.state.update(MODEL_RECENT_KEY, [{ providerId, model, usedAt: Date.now() }, ...recent].slice(0, 8).map(s => ({ ...s, id: JSON.stringify([s.providerId, s.model]) })));
			}
		});
	}

	getModelPreferences(): { favorites: ModelSelection[]; recent: ModelSelection[] } {
		const read = (key: string, max: number): ModelSelection[] => {
			const raw = this.state.get<unknown>(key, []);
			const seen = new Set<string>();
			return (Array.isArray(raw) ? raw : []).filter(s => {
				if (!s || typeof s.providerId !== 'string' || !s.providerId || typeof s.model !== 'string' || !s.model) return false;
				const key = JSON.stringify([s.providerId, s.model]);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			}).slice(0, max).map(s => ({ providerId: s.providerId, model: s.model, ...(typeof s.usedAt === 'number' && Number.isFinite(s.usedAt) ? { usedAt: s.usedAt } : {}) }));
		};
		return { favorites: read(MODEL_FAVORITES_KEY, 100), recent: read(MODEL_RECENT_KEY, 8) };
	}

	async setModelFavorite(providerId: string, model: string, favorite: boolean): Promise<void> {
		await this.serializeSessions(async () => {
			const provider = await this.get(providerId);
			if (!provider?.models.some(m => m.id === model)) throw new Error('That model no longer exists.');
			const favorites = this.getModelPreferences().favorites.filter(s => s.providerId !== providerId || s.model !== model);
			if (favorite) favorites.unshift({ providerId, model });
			await this.state.update(MODEL_FAVORITES_KEY, favorites.slice(0, 100).map(s => ({ ...s, id: JSON.stringify([s.providerId, s.model]) })));
		});
	}

	private async remapModelSelections(providerId: string, model?: string, renamed?: string): Promise<void> {
		await this.serializeSessions(async () => {
			const matches = (s: Partial<ModelSelection>) => s.providerId === providerId && (!model || s.model === model);
			if (renamed) {
				const sessions = await this.ensureSessions();
				for (const session of sessions) if (session.selection && matches(session.selection)) session.selection = { providerId, model: renamed };
				await this.state.update(SESSIONS_KEY, sessions);
			}
			const defaults = this.defaultSelection();
			if (matches(defaults)) await this.state.update(DEFAULT_SELECTION_KEY, renamed ? { providerId, model: renamed } : {});
			const prefs = this.getModelPreferences();
			for (const [key, values] of [[MODEL_FAVORITES_KEY, prefs.favorites], [MODEL_RECENT_KEY, prefs.recent]] as const) {
				const next = values.flatMap(s => !matches(s) ? [s] : renamed ? [{ ...s, model: renamed }] : []);
				await this.state.update(key, next.map(s => ({ ...s, id: JSON.stringify([s.providerId, s.model]) })));
			}
		});
	}

	/**
	 * The provider/model the next message will actually use: the stored
	 * selection when it is still valid, otherwise the first usable model.
	 */
	async resolveSelection(sessionId?: string): Promise<{ provider?: ProviderConfig; model?: ModelEntry }> {
		const list = (await this.list()).filter((p) => p.enabled);
		const { providerId: pid, model: mid } = await this.selectionForSession(sessionId);
		const chosen = list.find((p) => p.id === pid);
		const model = chosen?.models.find((m) => m.id === mid && m.enabled);
		if (chosen && model) {
			return { provider: chosen, model };
		}
		for (const p of chosen ? [chosen, ...list.filter((x) => x !== chosen)] : list) {
			const first = p.models.find((m) => m.enabled);
			if (first) {
				return { provider: p, model: first };
			}
		}
		return { provider: chosen ?? list[0] };
	}

	// ---------------- sessions ----------------

	private sessions(): Session[] {
		const raw = this.state.get<Session[]>(SESSIONS_KEY, []);
		return (Array.isArray(raw) ? raw : []).filter(s => s && typeof s.id === 'string').map(s => ({ ...s, title: typeof s.title === 'string' ? s.title : 'Recovered chat', updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0, messages: normalizeMessages(s.messages), chapters: Array.isArray(s.chapters) ? s.chapters.filter(id => typeof id === 'string') : undefined, summary: s.summary && typeof s.summary.text === 'string' && typeof s.summary.upTo === 'string' ? s.summary : undefined, branchedFrom: s.branchedFrom && typeof s.branchedFrom.id === 'string' && typeof s.branchedFrom.title === 'string' ? s.branchedFrom : undefined }));
	}

	private async ensureSessions(): Promise<Session[]> {
		const sessions = this.sessions();
		if (sessions.length > 0) {
			return sessions;
		}
		const legacy = normalizeMessages(this.state.get<unknown>(LEGACY_MESSAGES_KEY, []));
		const first: Session = { id: newId('s'), title: titleFrom(legacy) || 'New chat', updatedAt: Date.now(), messages: legacy, projectPath: legacy.length ? undefined : currentProjectPath() };
		await this.state.update(SESSIONS_KEY, [first]);
		await this.state.update(CURRENT_SESSION_KEY, first.id);
		await this.state.update(LEGACY_MESSAGES_KEY, undefined);
		return [first];
	}

	async listSessions(): Promise<SessionMeta[]> {
		return (await this.ensureSessions())
			.map(({ id, title, updatedAt, folderId, archived, pinned, projectPath, messages, lastReadAt }) => ({
				id,
				title,
				updatedAt,
				projectPath: normalizeProjectPath(projectPath),
				folderId,
				archived,
				pinned,
				...sessionActivity(messages, lastReadAt),
				count: messages.filter((m) => m.role === 'user').length,
				...diffTotals(messages),
				model: [...messages].reverse().find((m) => m.model)?.model
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Full-text search over every chat's messages; returns a snippet around the first hit. */
	async searchSessions(query: string, limit = 40): Promise<Array<{ id: string; snippet: string }>> {
		const q = query.trim().toLowerCase();
		if (q.length < 2) {
			return [];
		}
		const hits: Array<{ id: string; snippet: string }> = [];
		for (const s of await this.ensureSessions()) {
			for (const m of s.messages) {
				if (m.role !== 'user' && m.role !== 'assistant') {
					continue;
				}
				const text = (m.content || '').replace(/\s+/g, ' ');
				const at = text.toLowerCase().indexOf(q);
				if (at >= 0) {
					const start = Math.max(0, at - 40);
					hits.push({ id: s.id, snippet: (start ? '…' : '') + text.slice(start, at + q.length + 60) + (at + q.length + 60 < text.length ? '…' : '') });
					break;
				}
			}
			if (hits.length >= limit) {
				break;
			}
		}
		return hits;
	}

	/**
	 * Cross-chat recall for the agent (session_search): past conversations
	 * ranked by how many query terms they contain, with short excerpts around
	 * the hits. The current chat is left out — it is already in context.
	 */
	async recallSessions(query: string, exclude?: string, limit = 5): Promise<Array<{ title: string; updatedAt: number; excerpts: string[]; score: number }>> {
		const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((t) => t.length > 1))].slice(0, 8);
		if (!terms.length) {
			return [];
		}
		const out: Array<{ title: string; updatedAt: number; excerpts: string[]; score: number }> = [];
		for (const s of await this.ensureSessions()) {
			if (s.id === exclude) {
				continue;
			}
			let score = 0;
			const excerpts: string[] = [];
			for (const m of s.messages) {
				if ((m.role !== 'user' && m.role !== 'assistant') || m.kind || !m.content) {
					continue;
				}
				const text = m.content.replace(/\s+/g, ' ');
				const low = text.toLowerCase();
				const found = terms.filter((t) => low.includes(t));
				if (!found.length) {
					continue;
				}
				score += found.length * found.length;
				if (excerpts.length < 2) {
					const at = low.indexOf(found[0]);
					const start = Math.max(0, at - 120);
					excerpts.push((m.role === 'user' ? 'User: ' : 'Assistant: ') + (start ? '…' : '') + text.slice(start, at + 240) + (at + 240 < text.length ? '…' : ''));
				}
			}
			if (score) {
				out.push({ title: s.title || 'Untitled chat', updatedAt: s.updatedAt, excerpts, score: score + (s.title && terms.some((t) => s.title.toLowerCase().includes(t)) ? 5 : 0) });
			}
		}
		return out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, limit);
	}

	/** Rename / move to folder / archive / pin a chat, or pin skills in it. */
	async updateSession(id: string, patch: { title?: string; folderId?: string | null; archived?: boolean; pinned?: boolean; pinnedSkills?: string[] }): Promise<void> {
		await this.serializeSessions(() => this.updateSessionUnlocked(id, patch));
	}

	private async updateSessionUnlocked(id: string, patch: { title?: string; folderId?: string | null; archived?: boolean; pinned?: boolean; pinnedSkills?: string[] }): Promise<void> {
		const sessions = await this.ensureSessions();
		const s = sessions.find((x) => x.id === id);
		if (!s) {
			return;
		}
		if (Array.isArray(patch.pinnedSkills)) {
			const names = patch.pinnedSkills
				.map((name) => String(name).trim().toLowerCase())
				.filter((name) => /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/.test(name) && name.length <= 80);
			s.pinnedSkills = [...new Set(names)].slice(0, 10);
			if (!s.pinnedSkills.length) s.pinnedSkills = undefined;
		}
		if (typeof patch.title === 'string' && patch.title.trim()) {
			s.title = patch.title.trim().slice(0, 120);
			s.customTitle = true;
		}
		if (patch.folderId !== undefined) {
			s.folderId = patch.folderId || undefined;
		}
		if (typeof patch.archived === 'boolean') {
			s.archived = patch.archived || undefined;
			if (patch.archived) {
				s.pinned = undefined;
			}
		}
		if (typeof patch.pinned === 'boolean') {
			s.pinned = patch.pinned || undefined;
		}
		await this.state.update(SESSIONS_KEY, sessions);
	}

	async getSummary(sessionId: string): Promise<Session['summary']> {
		return (await this.ensureSessions()).find((s) => s.id === sessionId)?.summary;
	}

	async toggleChapter(sessionId: string, messageId: string): Promise<void> {
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions(), session = sessions.find(s => s.id === sessionId);
			if (!session?.messages.some(m => m.id === messageId && !m.kind && m.content.trim())) return;
			const chapters = new Set(session.chapters || []);
			if (chapters.has(messageId)) chapters.delete(messageId);
			else if (chapters.size < 100) chapters.add(messageId);
			session.chapters = [...chapters];
			await this.state.update(SESSIONS_KEY, sessions);
		});
	}

	async getSubagentWorkflow(sessionId: string): Promise<SubagentWorkflow> {
		return normalizeWorkflow((await this.ensureSessions()).find(s => s.id === sessionId)?.subagentWorkflow);
	}

	async setSubagentWorkflow(sessionId: string, profile: SubagentWorkflow, validate?: () => void): Promise<void> {
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions(), session = sessions.find(s => s.id === sessionId);
			if (!session) throw new Error('That chat no longer exists.');
			validate?.();
			session.subagentWorkflow = normalizeWorkflow(profile);
			await this.state.update(SESSIONS_KEY, sessions);
		});
	}

	async disableSubagentWorkflows(): Promise<void> {
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			let changed = false;
			for (const session of sessions) if (session.subagentWorkflow?.enabled) { session.subagentWorkflow.enabled = false; changed = true; }
			if (changed) await this.state.update(SESSIONS_KEY, sessions);
		});
	}

	async getGoal(sessionId: string): Promise<SessionGoal | undefined> {
		const g = (await this.ensureSessions()).find((s) => s.id === sessionId)?.goal;
		return g && typeof g.objective === 'string' && ['active', 'met', 'stopped', 'unverified'].includes(g.status) ? g : undefined;
	}

	async setGoal(sessionId: string, goal: SessionGoal | undefined): Promise<void> {
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			const s = sessions.find((x) => x.id === sessionId);
			if (!s) return;
			if (goal) s.goal = goal;
			else delete s.goal;
			await this.state.update(SESSIONS_KEY, sessions);
		});
	}

	async setSummary(sessionId: string, summary: Session['summary']): Promise<void> {
		await this.serializeSessions(() => this.setSummaryUnlocked(sessionId, summary));
	}

	private async setSummaryUnlocked(sessionId: string, summary: Session['summary']): Promise<void> {
		const sessions = await this.ensureSessions();
		const s = sessions.find((x) => x.id === sessionId);
		if (s) {
			s.summary = summary;
			await this.state.update(SESSIONS_KEY, sessions);
		}
	}

	// ---------------- history folders (categories) ----------------

	getFolders(): Folder[] {
		const raw = this.state.get<Folder[]>(FOLDERS_KEY, []);
		return Array.isArray(raw) ? raw : [];
	}

	async saveFolder(folder: { id?: string; name: string; color?: string }): Promise<Folder> {
		const folders = this.getFolders();
		const name = folder.name.trim().slice(0, 40) || 'Folder';
		const existing = folder.id ? folders.find((f) => f.id === folder.id) : undefined;
		if (existing) {
			existing.name = name;
			existing.color = folder.color || existing.color;
			await this.state.update(FOLDERS_KEY, folders);
			return existing;
		}
		const created = { id: newId('f'), name, color: folder.color || 'blue' };
		await this.state.update(FOLDERS_KEY, [...folders, created]);
		return created;
	}

	async deleteFolder(id: string): Promise<void> {
		await this.serializeSessions(() => this.deleteFolderUnlocked(id));
	}

	private async deleteFolderUnlocked(id: string): Promise<void> {
		await this.state.update(FOLDERS_KEY, this.getFolders().filter((f) => f.id !== id));
		const sessions = await this.ensureSessions();
		for (const s of sessions) {
			if (s.folderId === id) {
				s.folderId = undefined; // chats return to "Recent", never deleted
			}
		}
		await this.state.update(SESSIONS_KEY, sessions);
	}

	// ---------------- hooks ----------------

	getHooks(): HookConfig[] {
		const raw = this.state.get<HookConfig[]>(HOOKS_KEY, []);
		const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'PreCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'];
		return (Array.isArray(raw) ? raw : [])
			.filter((h) => h && events.includes(h.event) && typeof h.command === 'string')
			.map((h) => ({ id: h.id || newId('h'), event: h.event, matcher: String(h.matcher ?? ''), command: h.command, enabled: h.enabled !== false, required: h.event === 'Stop' && h.required === true, timeoutSec: Math.min(600, Math.max(1, Number(h.timeoutSec) || 60)) }));
	}

	async saveHook(hook: Partial<HookConfig> & { event: HookConfig['event']; command: string }): Promise<HookConfig> {
		if (!hook.command.trim()) {
			throw new Error('A hook needs a command.');
		}
		if (hook.matcher) {
			try {
				new RegExp(hook.matcher);
			} catch {
				throw new Error('The tool matcher is not a valid regular expression.');
			}
		}
		const list = this.getHooks();
		const next: HookConfig = {
			required: hook.event === 'Stop' && hook.required === true,
			id: hook.id || newId('h'),
			event: hook.event,
			matcher: hook.matcher ?? '',
			command: hook.command.trim(),
			enabled: hook.enabled !== false,
			timeoutSec: Math.min(600, Math.max(1, Number(hook.timeoutSec) || 60))
		};
		const exists = list.some((h) => h.id === next.id);
		await this.state.update(HOOKS_KEY, exists ? list.map((h) => (h.id === next.id ? next : h)) : [...list, next]);
		return next;
	}

	async deleteHook(id: string): Promise<void> {
		await this.state.update(HOOKS_KEY, this.getHooks().filter((h) => h.id !== id));
	}

	// ---------------- MCP servers ----------------

	private mcpState(): vscode.Memento { return isDesktopHost() ? this.context.workspaceState : this.state; }

	getMcpServers(): McpServerConfig[] {
		const raw = this.mcpState().get<McpServerConfig[]>(MCP_KEY, []);
		return (Array.isArray(raw) ? raw : []).map((s) => ({
			id: s.id || newId('mcp'),
			name: String(s.name || 'server'),
			transport: s.transport === 'http' ? 'http' : 'stdio',
			command: String(s.command || ''),
			args: Array.isArray(s.args) ? s.args.map(String) : [],
			env: s.env && typeof s.env === 'object' ? s.env : {},
			url: String(s.url || ''),
			headers: s.headers && typeof s.headers === 'object' ? s.headers : {},
			enabled: s.enabled !== false,
			trusted: s.trusted === true,
			disabledTools: Array.isArray(s.disabledTools) ? s.disabledTools.filter((n): n is string => typeof n === 'string') : []
		}));
	}

	async saveMcpServer(server: Partial<McpServerConfig> & { name: string }): Promise<McpServerConfig> {
		const list = this.getMcpServers();
		const name = server.name.trim().replace(/[^\w-]+/g, '_').slice(0, 40) || 'server';
		if (list.some((s) => s.name === name && s.id !== server.id)) {
			throw new Error(`An MCP server named "${name}" already exists.`);
		}
		const base = list.find((s) => s.id === server.id);
		const next: McpServerConfig = {
			id: base?.id ?? newId('mcp'),
			name,
			transport: server.transport ?? base?.transport ?? 'stdio',
			command: server.command ?? base?.command ?? '',
			args: server.args ?? base?.args ?? [],
			env: server.env ?? base?.env ?? {},
			url: server.url ?? base?.url ?? '',
			headers: server.headers ?? base?.headers ?? {},
			enabled: server.enabled ?? base?.enabled ?? true,
			trusted: server.trusted ?? base?.trusted ?? false,
			disabledTools: Array.isArray(server.disabledTools) ? server.disabledTools.map(String) : base?.disabledTools
		};
		if (!['stdio', 'http'].includes(next.transport) || !Array.isArray(next.args) || next.args.some(a => typeof a !== 'string') || [next.env, next.headers].some(record => !record || Array.isArray(record) || typeof record !== 'object' || Object.values(record).some(value => typeof value !== 'string'))) throw new Error('Invalid MCP transport, arguments, environment or headers.');
		if (next.transport === 'stdio' && !next.command.trim()) {
			throw new Error('A stdio MCP server needs a command.');
		}
		if (next.transport === 'http' && !/^https?:\/\//i.test(next.url)) {
			throw new Error('An HTTP MCP server needs an http(s) URL.');
		}
		await this.mcpState().update(MCP_KEY, base ? list.map((s) => (s.id === base.id ? next : s)) : [...list, next]);
		return next;
	}

	async deleteMcpServer(id: string): Promise<void> {
		await this.mcpState().update(MCP_KEY, this.getMcpServers().filter((s) => s.id !== id));
	}

	async currentSessionId(): Promise<string> {
		return this.serializeSessions(() => this.currentSessionIdUnlocked());
	}

	private async currentSessionIdUnlocked(): Promise<string> {
		const sessions = await this.ensureSessions();
		const root = currentProjectPath();
		const belongsHere = (s: Session): boolean => {
			const folder = normalizeProjectPath(s.projectPath);
			return root ? !!folder && projectPathKey(folder) === projectPathKey(root) : !folder;
		};
		const key = root ? PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(root) : CURRENT_SESSION_KEY;
		const windowId = this.windowCurrentSessions.get(key);
		if (windowId && sessions.some((s) => s.id === windowId)) return windowId;
		const saved = sessions.find((s) => s.id === this.state.get<string>(key));
		// Explicit legacy navigation is remembered locally without inventing an association.
		if (saved && (belongsHere(saved) || !normalizeProjectPath(saved.projectPath))) {
			this.windowCurrentSessions.set(key, saved.id);
			return saved.id;
		}
		const global = sessions.find((s) => s.id === this.state.get<string>(CURRENT_SESSION_KEY));
		const local = [...sessions].filter(belongsHere).sort((a, b) => b.updatedAt - a.updatedAt)[0];
		const fallback = global && belongsHere(global) ? global : local ?? (global && !normalizeProjectPath(global.projectPath) ? global : sessions.find((s) => !normalizeProjectPath(s.projectPath)));
		if (fallback) {
			await this.setCurrentSessionUnlocked(fallback.id);
			return fallback.id;
		}
		// A new project window must never start by loading another root's conversation.
		return (await this.createSessionUnlocked()).id;
	}

	async setCurrentSession(id: string): Promise<void> {
		await this.serializeSessions(async () => {
			const session = (await this.ensureSessions()).find((s) => s.id === id);
			if (!session) throw new Error('That chat no longer exists.');
			const folder = normalizeProjectPath(session.projectPath);
			const root = currentProjectPath();
			if (folder && (!root || projectPathKey(folder) !== projectPathKey(root))) {
				throw new Error('Open this chat in its project window.');
			}
			await this.setCurrentSessionUnlocked(id);
		});
	}

	private async setCurrentSessionUnlocked(id: string): Promise<void> {
		const session = (await this.ensureSessions()).find((s) => s.id === id);
		if (!session) throw new Error('That chat no longer exists.');
		const root = currentProjectPath();
		const folder = normalizeProjectPath(session.projectPath);
		this.windowCurrentSessions.set(root ? PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(root) : CURRENT_SESSION_KEY, id);
		// Imported/branched chats may retain another root; never poison this root's startup pointer.
		if (root && (!folder || projectPathKey(folder) === projectPathKey(root))) {
			await this.state.update(PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(root), id);
		}
		await this.state.update(CURRENT_SESSION_KEY, id);
	}

	async loadMessages(sessionId?: string): Promise<StoredMessage[]> {
		const sessions = await this.ensureSessions();
		const id = sessionId ?? (await this.currentSessionId());
		return normalizeMessages(sessions.find((s) => s.id === id)?.messages);
	}

	async workflowRuns() {
		const root = currentProjectPath();
		const runs = [];
		for (const session of await this.ensureSessions()) {
			if (projectPathKey(session.projectPath || '') !== projectPathKey(root || '')) continue;
			for (const [index, message] of session.messages.entries()) {
				if (!message.turn?.workflow?.enabled) continue;
				let end = index + 1;
				while (end < session.messages.length && !(session.messages[end].role === 'user' && session.messages[end].turn)) end++;
				const reports = session.messages.slice(index + 1, end).filter(m => m.role === 'assistant' && !m.kind).map(m => m.content).join('\n\n');
				runs.push({ id: message.id, sessionId: session.id, title: session.title, prompt: message.content, profile: normalizeWorkflow(message.turn.workflow), providerId: message.turn.providerId, model: message.turn.model, startedAt: message.turn.startedAt, endedAt: message.turn.endedAt, status: message.turn.outcome ?? (message.turn.endedAt ? 'interrupted' : 'running'), report: reports.slice(-30000) });
			}
		}
		return runs.sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
	}

	/** Save a conversation to a specific session (not "whatever is current"). */
	async saveMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
		await this.serializeSessions(() => this.saveMessagesUnlocked(sessionId, messages));
	}

	async markSessionRead(sessionId: string, completedAt: number): Promise<void> {
		if (!Number.isFinite(completedAt) || completedAt <= 0) return;
		await this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			const session = sessions.find(s => s.id === sessionId);
			if (!session) return;
			const latest = sessionActivity(session.messages).completedAt ?? 0;
			const seen = Math.min(latest, completedAt);
			if (seen <= (session.lastReadAt ?? 0)) return;
			session.lastReadAt = seen;
			await this.state.update(SESSIONS_KEY, sessions);
		});
	}

	private async saveMessagesUnlocked(sessionId: string, messages: StoredMessage[]): Promise<void> {
		const sessions = await this.ensureSessions();
		const index = sessions.findIndex((s) => s.id === sessionId);
		if (index < 0) {
			return; // session was deleted meanwhile
		}
		const trimmed = trimForStorage(messages);
		const s = sessions[index];
		sessions[index] = {
			...s,
			lastReadAt: s.lastReadAt ?? s.updatedAt,
			messages: trimmed,
			chapters: s.chapters?.filter(id => trimmed.some(m => m.id === id)),
			updatedAt: Date.now(),
			title: s.customTitle ? s.title : titleFrom(messages) || s.title
		};
		await this.state.update(SESSIONS_KEY, sessions);
	}

	async createSession(): Promise<Session> {
		return this.serializeSessions(() => this.createSessionUnlocked());
	}

	/** Background work must neither reuse an empty composer chat nor change its selection. */
	async createBackgroundSession(title: string): Promise<Session> {
		const projectPath = currentProjectPath();
		return this.serializeSessions(async () => {
			const sessions = await this.ensureSessions();
			const created: Session = { id: newId('s'), title: title.slice(0, 120), customTitle: true, updatedAt: Date.now(), messages: [], projectPath };
			await this.state.update(SESSIONS_KEY, [...sessions, created]);
			return created;
		});
	}

	private async createSessionUnlocked(): Promise<Session> {
		const sessions = await this.ensureSessions();
		const projectPath = currentProjectPath();
		// Never reuse a blank belonging to another project (or a legacy unassigned chat).
		const empty = sessions.find((s) => s.messages.length === 0 && !s.archived && !s.folderId &&
			(projectPath ? !!normalizeProjectPath(s.projectPath) && projectPathKey(s.projectPath!) === projectPathKey(projectPath) : s.projectPath === undefined));
		if (empty) {
			empty.updatedAt = Date.now();
			await this.state.update(SESSIONS_KEY, sessions);
			await this.setCurrentSessionUnlocked(empty.id);
			return empty;
		}
		const rootKey = projectPath ? PROJECT_CURRENT_SESSION_PREFIX + projectPathKey(projectPath) : CURRENT_SESSION_KEY;
		const previous = sessions.find(s => s.id === this.windowCurrentSessions.get(rootKey));
		const selection = this.initialSelection(previous);
		const created: Session = { id: newId('s'), title: 'New chat', updatedAt: Date.now(), messages: [], projectPath, selection: selection.providerId && selection.model ? { providerId: selection.providerId, model: selection.model } : undefined };
		await this.state.update(SESSIONS_KEY, [...sessions, created]);
		await this.setCurrentSessionUnlocked(created.id);
		return created;
	}

	/**
	 * "Branch in new chat" (Codex): a new chat holding a copy of `fromId` up to the
	 * end of the turn that contains `atMessageId`. Titled "<title> (2)", "(3)"…
	 */
	async branchSession(fromId: string, atMessageId: string, destination?: { projectPath: string; activate: false }): Promise<Session | undefined> {
		return this.serializeSessions(() => this.branchSessionUnlocked(fromId, atMessageId, destination));
	}

	/** "Fork session": copy the whole chat into a new one and open it. */
	async forkSession(fromId: string): Promise<Session | undefined> {
		return this.serializeSessions(() => this.branchSessionUnlocked(fromId, undefined));
	}

	async rewindSession(fromId: string, beforeMessage: string): Promise<Session | undefined> {
		return this.serializeSessions(async () => {
			const source = (await this.ensureSessions()).find(s => s.id === fromId);
			const index = source?.messages.findIndex(m => m.id === beforeMessage) ?? -1;
			if (!source || index < 0) return;
			// An old summary can describe discarded turns; rebuild context from the retained prefix.
			const messages: StoredMessage[] = JSON.parse(JSON.stringify(source.messages.slice(0, index)));
			messages.push({ id:newId('r'), role:'assistant', content:'Conversation restarted before the selected message. The workspace was restored where checkpoints were available. Commands and connected-system effects remain; inspect current files before continuing.' });
			return this.importSessionUnlocked(source.title + ' (rewound)', messages, source.projectPath);
		});
	}

	private async branchSessionUnlocked(fromId: string, atMessageId: string | undefined, destination?: { projectPath: string; activate: false }): Promise<Session | undefined> {
		const sessions = await this.ensureSessions();
		const src = sessions.find((s) => s.id === fromId);
		if (!src) {
			return undefined;
		}
		let end: number;
		if (atMessageId === undefined) {
			// A fork copies everything.
			end = src.messages.length;
		} else {
			const at = src.messages.findIndex((m) => m.id === atMessageId);
			if (at < 0) {
				return undefined;
			}
			// Copy through the end of that turn (edits, notes), stopping at the next prompt.
			end = at + 1;
			while (end < src.messages.length && !(src.messages[end].role === 'user' && !src.messages[end].kind)) {
				end++;
			}
		}
		const copied: StoredMessage[] = JSON.parse(JSON.stringify(src.messages.slice(0, end)));
		const base = src.title.replace(/\s+\(\d+\)$/, '');
		let n = 2;
		while (sessions.some((s) => s.title === `${base} (${n})`)) {
			n++;
		}
		const summary = src.summary && copied.some((m) => m.id === src.summary!.upTo) ? { ...src.summary } : undefined;
		const created: Session = {
			id: newId('s'),
			title: `${base} (${n})`,
			customTitle: true,
			updatedAt: Date.now(),
			messages: copied,
			selection: src.selection ? { ...src.selection } : undefined,
			folderId: src.folderId,
			projectPath: normalizeProjectPath(destination ? destination.projectPath : src.projectPath),
			// A branch from a message continues the same work: keep the chat's team
			// (a whole-chat fork stays an independent chat and opts in itself).
			subagentWorkflow: atMessageId !== undefined && src.subagentWorkflow ? { ...src.subagentWorkflow } : undefined,
			summary,
			// A fork of an empty chat copies nothing, so there is no message to point at.
			branchedFrom: copied.length ? { id: src.id, title: src.title, afterId: copied[copied.length - 1].id } : { id: src.id, title: src.title }
		};
		await this.state.update(SESSIONS_KEY, [...sessions, created]);
		if (!destination) await this.setCurrentSessionUnlocked(created.id);
		return created;
	}

	/** A chat imported from another agent (src/foreignSessions.ts) becomes the current chat. */
	async importSession(title: string, messages: StoredMessage[], projectPath?: string): Promise<Session> {
		return this.serializeSessions(() => this.importSessionUnlocked(title, messages, projectPath));
	}

	private async importSessionUnlocked(title: string, messages: StoredMessage[], projectPath?: string): Promise<Session> {
		const sessions = await this.ensureSessions();
		const created: Session = { id: newId('s'), title: title.slice(0, 120), customTitle: true, updatedAt: Date.now(), messages, projectPath: projectPath === undefined ? currentProjectPath() : normalizeProjectPath(projectPath) };
		await this.state.update(SESSIONS_KEY, [...sessions, created]);
		await this.setCurrentSessionUnlocked(created.id);
		return created;
	}

	async getSession(id: string): Promise<Session | undefined> {
		return (await this.ensureSessions()).find((s) => s.id === id);
	}

    // Holds every client's turns (Side Chat caps each client at 12), so the cap covers four clients.
    getSideChat(id: string): { role: 'user' | 'assistant'; content: string }[] | undefined {
        const raw = this.state.get<unknown>('aiChat.sideChat.' + id);
        return Array.isArray(raw) ? raw.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-48).map(m => ({ role: m.role, content: m.content.slice(0, 32000) })) : undefined;
    }
    async saveSideChat(id: string, history: { role: 'user' | 'assistant'; content: string }[] | undefined): Promise<void> {
        await this.serializeSessions(async () => {
            if (!(await this.ensureSessions()).some(s => s.id === id)) return;
            await this.state.update('aiChat.sideChat.' + id, history?.slice(-48).map(m => ({ role: m.role, content: m.content.slice(0, 32000) })));
        });
    }
    getModelChecks(): Record<string, { ok: boolean; at: number; scope: string; error?: string; ms?: number }> { return this.state.get('aiChat.modelChecks', {}); }
    private async clearModelChecks(providerId: string): Promise<void> {
        await this.state.update('aiChat.modelChecks', Object.fromEntries(Object.entries(this.getModelChecks()).filter(([key]) => !key.startsWith(providerId + '::'))));
    }
    async saveModelCheck(key: string, check: { ok: boolean; at: number; scope: string; error?: string; ms?: number }): Promise<void> {
        const checks = this.getModelChecks(); checks[key] = check;
        await this.state.update('aiChat.modelChecks', Object.fromEntries(Object.entries(checks).sort((a,b) => b[1].at - a[1].at).slice(0, 300)));
    }
    async deleteSession(id: string): Promise<void> {
		await this.serializeSessions(async () => {
			const next = (await this.ensureSessions()).filter((s) => s.id !== id);
			await this.state.update('aiChat.sideChat.' + id, undefined);
			await this.state.update(SESSIONS_KEY, next);
			for (const key of this.state.keys()) {
				if (key.startsWith(PROJECT_CURRENT_SESSION_PREFIX) && this.state.get<string>(key) === id) {
					await this.state.update(key, undefined);
				}
			}
			if (this.state.get<string>(CURRENT_SESSION_KEY) === id || !next.length) {
				await this.currentSessionIdUnlocked();
			}
		});
	}

	// ---------------- agent memory (workspace-scoped) ----------------

	private memoryEmbedder?: MemoryEmbedder;

	/** The host supplies embeddings; without one, recall stays keyword-only. */
	setMemoryEmbedder(embedder: MemoryEmbedder | undefined): void {
		this.memoryEmbedder = embedder;
	}

	private memoryScope(): { key: string; legacy: string } {
		const root = currentProjectPath();
		const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
		const scope = root ? projectPathKey(root) : uri ? uri.toString() : 'global';
		const ws = vscode.workspace.name?.replace(/[^\w-]+/g, '_') ?? 'global';
		return { key: `aiChat.memories.v2.${encodeURIComponent(scope)}`, legacy: `aiChat.memories.${ws}` };
	}

	private withMemories<T>(action: (key: string, memories: Memory[]) => Promise<T>): Promise<T> {
		// Capture the root before queuing; changing projects cannot redirect a pending write.
		const { key, legacy } = this.memoryScope();
		const previous = ProviderStore.memoryWrites.get(this.state) ?? Promise.resolve();
		const next = previous.then(async () => {
			let memories = this.state.get<Memory[]>(key);
			if (memories === undefined) {
				const ownersKey = 'aiChat.memoryMigrationOwners';
				const owners = this.state.get<Record<string, string>>(ownersKey, {});
				// Legacy names contain no path. One project claims them; keep the legacy copy for recovery.
				await this.state.update(ownersKey, { ...owners, [legacy]: owners[legacy] ?? key });
				const owner = this.state.get<Record<string, string>>(ownersKey, {})[legacy];
				memories = owner === key ? this.state.get<Memory[]>(legacy, []) : [];
				await this.state.update(key, memories);
			}
			return action(key, memories);
		});
		ProviderStore.memoryWrites.set(this.state, next.then(() => undefined, () => undefined));
		return next;
	}

	async getMemories(): Promise<Memory[]> {
		return this.withMemories(async (_key, memories) => memories);
	}

	async retainMemory(text: string, opts?: { category?: MemoryCategory; area?: MemoryArea; source?: 'agent' | 'user'; sourceSessionId?: string; auto?: boolean }): Promise<Memory> {
		const clean = text.replace(/\s+/g, ' ').trim();
		if (!clean) {
			throw new Error('memory text is empty');
		}
		if (clean.length > 2000) throw new Error('Keep each memory under 2,000 characters.');
		const entry = await this.withMemories(async (key, memories) => {
			const existing = memories.find((m) => !m.archived && m.text.toLowerCase() === clean.toLowerCase());
			const now = Date.now();
			if (existing) {
				// A repeated fact retains its order while refreshing its date.
				existing.updatedAt = now;
				if (opts?.area && existing.area !== opts.area) existing.area = opts.area;
				await this.state.update(key, memories);
				return existing;
			}
			if (memories.filter(m => !m.archived).length >= 200) throw new Error('Memory is full (200 active facts). Archive or delete a fact in Settings → Memory before saving another. Existing facts are kept.');
			if (memories.length >= 1000) throw new Error('Memory archive is full. Export and delete older facts in Settings → Memory.');
			const created: Memory = { id: newId('m'), text: clean, ts: now, category: opts?.category || classifyMemory(clean), area: opts?.area, source: opts?.source ?? 'agent', auto: opts?.auto || undefined, sourceSessionId: opts?.sourceSessionId };
			await this.state.update(key, [created, ...memories]);
			return created;
		});
		void this.embedMemory(entry.id).catch(() => undefined);
		return entry;
	}

	async updateMemory(id: string, patch: { text?: string; category?: MemoryCategory; area?: MemoryArea; pinned?: boolean; archived?: boolean }): Promise<void> {
		let changed = false;
		await this.withMemories(async (key, memories) => {
			const entry = memories.find((m) => m.id === id);
			if (!entry) return;
			if (patch.text && patch.text.length > 2000) throw new Error('Keep each memory under 2,000 characters.');
			if (patch.archived === false && entry.archived && memories.filter(m => !m.archived).length >= 200) throw new Error('Archive another fact first: the active memory limit is 200.');
			if (typeof patch.text === 'string' && patch.text.trim() && patch.text.replace(/\s+/g, ' ').trim() !== entry.text) {
				entry.text = patch.text.replace(/\s+/g, ' ').trim();
				entry.vec = undefined;
				entry.vecModel = undefined;
				changed = true;
			}
			if (patch.category) entry.category = patch.category;
			if (patch.area) entry.area = patch.area;
			if (typeof patch.pinned === 'boolean') entry.pinned = patch.pinned;
			if (typeof patch.archived === 'boolean') entry.archived = patch.archived;
			entry.updatedAt = Date.now();
			await this.state.update(key, memories);
		});
		if (changed) void this.embedMemory(id).catch(() => undefined);
	}

	/** Archive several reviewed duplicates in one write; Restore brings any of them back. */
	async archiveMemories(ids: readonly string[]): Promise<void> {
		const selected = new Set(ids.slice(0, 50));
		if (!selected.size) return;
		await this.withMemories(async (key, memories) => {
			for (const entry of memories) {
				if (selected.has(entry.id)) {
					entry.archived = true;
					entry.updatedAt = Date.now();
				}
			}
			await this.state.update(key, memories);
		});
	}

	/**
	 * Consolidate a reviewed duplicate group into the kept entry: sentences the
	 * kept text does not already contain are appended (deterministic, no model
	 * call), every other entry is archived and remains restorable.
	 */
	async mergeMemories(keepId: string, ids: readonly string[]): Promise<Memory | undefined> {
		const selected = new Set(ids.slice(0, 20));
		let merged: Memory | undefined;
		await this.withMemories(async (key, memories) => {
			const keep = memories.find((m) => m.id === keepId && !m.archived);
			if (!keep) return;
			const parts = [keep.text];
			for (const entry of memories) {
				if (entry.id === keepId || !selected.has(entry.id) || entry.archived) continue;
				for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
					const clean = sentence.trim();
					if (clean && !parts.join(' ').toLowerCase().includes(clean.toLowerCase())) parts.push(clean);
				}
				entry.archived = true;
				entry.updatedAt = Date.now();
			}
			if (parts.length > 1) {
				keep.text = parts.join(' ').slice(0, 2000);
				keep.vec = undefined;
				keep.vecModel = undefined;
				keep.updatedAt = Date.now();
			}
			merged = { ...keep };
			await this.state.update(key, memories);
		});
		if (merged) void this.embedMemory(merged.id).catch(() => undefined);
		return merged;
	}

	async deleteMemory(id: string): Promise<void> {
		await this.withMemories(async (key, memories) => this.state.update(key, memories.filter((m) => m.id !== id)));
	}

	/** Deletes every memory one chat saved (by the agent or learned automatically), e.g. after it read a page that misled it. Returns how many. */
	async forgetMemoriesFrom(sessionId: string): Promise<number> {
		let removed = 0;
		await this.withMemories(async (key, memories) => {
			const kept = memories.filter((m) => m.sourceSessionId !== sessionId || m.source === 'user');
			removed = memories.length - kept.length;
			await this.state.update(key, kept);
		});
		return removed;
	}

	async clearMemories(): Promise<void> {
		await this.withMemories(async (key) => this.state.update(key, []));
	}

	private memorySignal(signal?: AbortSignal): AbortSignal {
		const timeout = AbortSignal.timeout(12_000);
		if (!signal) return timeout;
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal.addEventListener('abort', abort, { once: true });
		timeout.addEventListener('abort', abort, { once: true });
		return controller.signal;
	}

	/** Embed one entry in the background; a failure leaves it keyword-recallable. */
	private async embedMemory(id: string): Promise<void> {
		const embedder = this.memoryEmbedder;
		if (!embedder) return;
		const model = embedder.model();
		if (!model) return;
		const memory = (await this.getMemories()).find((m) => m.id === id && !m.archived);
		if (!memory || (memory.vec && memory.vecModel === model)) return;
		const text = memory.text;
		const [vector] = await embedder.embed([text], 'document', AbortSignal.timeout(20_000));
		if (!vector?.length) return;
		await this.withMemories(async (key, memories) => {
			const entry = memories.find((m) => m.id === id);
			if (!entry || entry.text !== text) return; // edited while embedding
			entry.vec = encodeVector(vector);
			entry.vecModel = model;
			await this.state.update(key, memories);
		});
	}

	/** Embed a bounded batch of entries that have no current vector (no-op without an embedder). */
	private async ensureMemoryVectors(memories: Memory[], model: string, signal?: AbortSignal): Promise<void> {
		const embedder = this.memoryEmbedder;
		if (!embedder) return;
		const stale = memories.filter((m) => !m.vec || m.vecModel !== model).slice(0, 48);
		if (!stale.length) return;
		const texts = new Map(stale.map((m) => [m.id, m.text]));
		const vectors = await embedder.embed(stale.map((m) => m.text), 'document', signal);
		if (vectors.length !== stale.length) return;
		const byId = new Map(stale.map((m, i) => [m.id, vectors[i]]));
		await this.withMemories(async (key, list) => {
			for (const entry of list) {
				const vector = byId.get(entry.id);
				if (vector?.length && texts.get(entry.id) === entry.text) {
					entry.vec = encodeVector(vector);
					entry.vecModel = model;
				}
			}
			await this.state.update(key, list);
		});
	}

	/**
	 * Recall for a prompt: keyword overlap and, when an embedding model is
	 * configured, similar meaning (reciprocal rank fusion). Pinned facts always
	 * qualify; solutions get their own small share so they never crowd out facts.
	 */
	async recallMemories(query: string, limit = 5, signal?: AbortSignal): Promise<Memory[]> {
		const memories = (await this.getMemories()).filter(m => !m.archived);
		if (!memories.length) {
			return [];
		}
		const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
		const keywordRanked = memories
			.map((m) => {
				const text = m.text.toLowerCase();
				// Whole-word hits count double; a pinned fact starts above zero so it is recalled even on a miss.
				const hits = words.reduce((sum, w) => sum + (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text) ? 2 : text.includes(w) ? 1 : 0), 0);
				return { m, score: hits + (m.pinned || !words.length ? 1 : 0) };
			})
			.filter((s) => s.score > 0)
			.sort((a, b) => Number(!!b.m.pinned) - Number(!!a.m.pinned) || b.score - a.score || b.m.ts - a.m.ts)
			.map((s) => s.m);
		let fused = keywordRanked.map((m) => ({ m, via: ['keywords'] }));
		const embedder = this.memoryEmbedder;
		if (embedder && embedder.model() && query.trim().length > 1) {
			try {
				const model = embedder.model();
				const deadline = this.memorySignal(signal);
				await this.ensureMemoryVectors(memories, model, deadline);
				const [queryVector] = await embedder.embed([query], 'query', deadline);
				const q = new Float32Array(queryVector);
				const semantic = (await this.getMemories())
					.filter((m) => !m.archived && m.vec && m.vecModel === model)
					.map((m) => ({ m, score: cosineSimilarity(q, decodeVector(m.vec!)) }))
					.filter((x) => x.score > 0)
					.sort((a, b) => b.score - a.score)
					.slice(0, 50)
					.map((x) => x.m);
				fused = fuseRanks(
					[
						{ via: 'keywords', items: keywordRanked.slice(0, 50) },
						{ via: 'meaning', items: semantic }
					],
					(m) => m.id
				).map((entry) => ({ m: entry.item, via: entry.via }));
			} catch {
				/* embeddings are an upgrade: keyword recall still answers */
			}
		}
		const viaById = new Map(fused.map((entry) => [entry.m.id, entry.via]));
		const ordered = [...memories.filter((m) => m.pinned), ...fused.map((entry) => entry.m)].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
		let bytes = 0, facts = 0, solutions = 0;
		const recalled: Memory[] = [];
		for (const m of ordered) {
			const solution = m.area === 'solution';
			if (!m.pinned && (solution ? solutions >= Math.min(2, limit) : facts >= limit)) continue;
			const size = Buffer.byteLength(m.text, 'utf8') + 8;
			if (bytes + size > 12_000) continue;
			const via = viaById.get(m.id) ?? [];
			const reason = m.pinned
				? 'Pinned preference'
				: via.includes('meaning') && via.includes('keywords')
					? 'Matched words and meaning'
					: via.includes('meaning')
						? 'Similar meaning'
						: words.length
							? 'Matched words in your prompt'
							: 'Recent fact';
			bytes += size;
			if (!m.pinned) {
				solution ? solutions++ : facts++;
			}
			recalled.push({ ...m, recallReason: reason });
		}
		return recalled;
	}

	/**
	 * Near-duplicates for the Memory page to review: groups of active entries
	 * whose embeddings are at least `threshold` similar, facts and solutions
	 * separately. Nothing is archived or merged here.
	 */
	async findMemoryDuplicates(threshold = 0.88, signal?: AbortSignal): Promise<Array<{ keep: Memory; others: Memory[]; similarity: number }>> {
		const embedder = this.memoryEmbedder;
		if (!embedder) return [];
		const model = embedder.model();
		if (!model) return [];
		let active = (await this.getMemories()).filter((m) => !m.archived);
		if (active.length < 2) return [];
		for (let pass = 0; pass < 5 && active.some((m) => !m.vec || m.vecModel !== model); pass++) {
			await this.ensureMemoryVectors(active, model, this.memorySignal(signal));
			active = (await this.getMemories()).filter((m) => !m.archived);
		}
		const ordered = [...active].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || a.ts - b.ts);
		const groups = [
			...groupDuplicates(ordered.filter((m) => m.area !== 'solution'), (m) => (m.vec && m.vecModel === model ? decodeVector(m.vec) : undefined), threshold),
			...groupDuplicates(ordered.filter((m) => m.area === 'solution'), (m) => (m.vec && m.vecModel === model ? decodeVector(m.vec) : undefined), threshold)
		].sort((a, b) => b.similarity - a.similarity);
		return groups.map((group) => ({ keep: group.keep, others: group.others, similarity: group.similarity }));
	}

	// ---------------- reasoning effort per model ----------------

	async getEffort(providerId: string, model: string): Promise<Effort | undefined> {
		const value = this.state.get<Record<string, string>>(EFFORT_KEY, {})[`${providerId}::${model}`];
		return (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : undefined;
	}

	async setEffort(providerId: string, model: string, effort: Effort | 'max'): Promise<void> {
		const map = { ...this.state.get<Record<string, string>>(EFFORT_KEY, {}) };
		const key = `${providerId}::${model}`;
		if (effort === 'max') {
			delete map[key]; // Legacy "max" selection is Auto, distinct from the explicit "maximum" effort.
		} else {
			map[key] = effort;
		}
		await this.state.update(EFFORT_KEY, map);
	}

	async getAllEfforts(): Promise<Record<string, string>> {
		return this.state.get<Record<string, string>>(EFFORT_KEY, {});
	}

	// ---------------- agent settings + mode ----------------

	getSettings(runtime = true): AgentSettings {
		const stored = this.state.get<Record<string, unknown>>(SETTINGS_KEY, {});
		// Retired switches (Office / Mission Control, Dual Coding, SI Agent · Brain) are dropped.
		const renamed: Record<string, unknown> = { ...stored };
		for (const k of Object.keys(renamed)) if (/^(dual|office|zer0neLive|liveAutoOpen|siMode$|wasteBlocker$|costCap|brainStrip$)/.test(k)) delete renamed[k];
		const remoteKeys = ['remoteEnabled', 'remotePort', 'remoteAccess', 'remoteSshTarget', 'remoteSshRemotePort'] as const;
		const remote = isDesktopHost() ? { ...Object.fromEntries(remoteKeys.map(key => [key, DEFAULT_SETTINGS[key]])), ...this.context.workspaceState.get<Partial<AgentSettings>>('zer0neDesktop.remote', {}) } : {};
		const s = { ...DEFAULT_SETTINGS, ...(isDesktopHost() ? DESKTOP_SETTING_DEFAULTS : {}), ...(Object.fromEntries(Object.entries(renamed).filter(([, v]) => v !== undefined)) as Partial<AgentSettings>), ...remote };
		const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Math.round(Number(v) || d)));
		// Retired setting: migrate existing installations to uninterrupted turns.
		s.maxSteps = 0;
		for (const key of ['toolConcurrency', 'mcpConcurrency', 'childConcurrency', 'modelConcurrency'] as const) s[key] = clamp(s[key], 1, 64, DEFAULT_SETTINGS[key]);
		s.stablePrefix = s.stablePrefix !== false;
		s.toolProfile = ['lean', 'full'].includes(s.toolProfile) ? s.toolProfile : 'auto';
		s.strictTools = ['on', 'off'].includes(s.strictTools) ? s.strictTools : 'auto';
		s.openaiCache = ['implicit', 'explicit'].includes(s.openaiCache) ? s.openaiCache : 'provider';
		s.openaiCacheTtl = s.openaiCacheTtl === '12h' ? '12h' : '30m';
		for (const key of ['taskBudgetCost', 'taskBudgetTokens', 'taskBudgetRequests', 'taskBudgetSeconds'] as const) {
			const v = s[key];
			s[key] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, key === 'taskBudgetCost' ? 1e6 : key === 'taskBudgetSeconds' ? 604800 : 1e9) : 0;
			if (key !== 'taskBudgetCost') s[key] = Math.floor(s[key]);
		}
		s.compactThreshold = clamp(s.compactThreshold, 40, 95, DEFAULT_SETTINGS.compactThreshold);
		s.compactMaxTokens = Number(s.compactMaxTokens) === 0 ? 0 : clamp(s.compactMaxTokens, 50_000, 2_000_000, DEFAULT_SETTINGS.compactMaxTokens);
		s.skillCatalogChars = clamp(s.skillCatalogChars, 2_000, 40_000, DEFAULT_SETTINGS.skillCatalogChars);
		s.watchdogStallMinutes = clamp(s.watchdogStallMinutes, 2, 120, DEFAULT_SETTINGS.watchdogStallMinutes);
		s.eventPollMinutes = clamp(s.eventPollMinutes, 2, 120, DEFAULT_SETTINGS.eventPollMinutes);
		s.eventPolicy = typeof s.eventPolicy === 'string' ? s.eventPolicy.slice(0, 4000) : DEFAULT_SETTINGS.eventPolicy;
		s.eventMention = typeof s.eventMention === 'string' ? s.eventMention.trim().slice(0, 40) : DEFAULT_SETTINGS.eventMention;
		s.eventAllowed = typeof s.eventAllowed === 'string' ? s.eventAllowed.slice(0, 2000) : '';
		s.cacheTtl = s.cacheTtl === '1h' ? '1h' : '5m';
		s.cacheWarm = s.cacheWarm === true;
		s.zeroRetentionOnly = s.zeroRetentionOnly === true;
		s.uiFontSize = clamp(s.uiFontSize, 11, 18, DEFAULT_SETTINGS.uiFontSize);
		s.terminalFontSize = Number(s.terminalFontSize) === 0 ? 0 : clamp(s.terminalFontSize, 10, 24, DEFAULT_SETTINGS.terminalFontSize);
		s.terminalLineHeight = Math.min(2, Math.max(1, Math.round((Number(s.terminalLineHeight) || DEFAULT_SETTINGS.terminalLineHeight) * 100) / 100));
		s.terminalCursorStyle = s.terminalCursorStyle === 'bar' || s.terminalCursorStyle === 'underline' ? s.terminalCursorStyle : 'block';
		s.terminalCursorBlink = s.terminalCursorBlink !== false;
		s.terminalScreenReader = s.terminalScreenReader === true;
		s.terminalEffects = s.terminalEffects === 'retro' ? 'retro' : 'off';
		s.terminalProse = s.terminalProse === 'reading' ? 'reading' : 'mono';
		s.remotePort = clamp(s.remotePort, 1024, 65535, DEFAULT_SETTINGS.remotePort);
		s.remoteAccess = s.remoteAccess === 'anywhere' || s.remoteAccess === 'tailscale' || s.remoteAccess === 'ssh' ? s.remoteAccess : 'lan';
		s.remoteSshTarget = typeof s.remoteSshTarget === 'string' ? s.remoteSshTarget.slice(0, 200) : '';
		s.remoteSshRemotePort = clamp(s.remoteSshRemotePort, 1, 65535, 80);
		s.searchEngine = s.searchEngine === 'duckduckgo' ? 'duckduckgo' : 'exa';
		s.followUp = s.followUp === 'steer' || s.followUp === 'interrupt' ? s.followUp : 'queue';
		s.density = s.density === 'compact' ? 'compact' : 'comfortable';
		// Glow is ON (subtle) or OFF; the old "vivid" level maps to ON.
		s.glow = s.glow === 'off' ? 'off' : 'subtle';
		s.dictationEngine = s.dictationEngine === 'whisper' ? 'whisper' : 'system';
		s.backgroundOpacity = clamp(s.backgroundOpacity, 1, 100, DEFAULT_SETTINGS.backgroundOpacity);
		s.fontWeight = Math.round(clamp(s.fontWeight, 300, 600, DEFAULT_SETTINGS.fontWeight) / 50) * 50;
		s.backgroundScope = s.backgroundScope === 'empty' ? 'empty' : 'all';
		// 0.18 removed the animated live themes: those picks fall back to System, scenes to none.
		const LIVE_THEMES = ['sakura', 'ember', 'constellation', 'spotlight', 'fireflies', 'rainfall', 'snowfall', 'aurora', 'synthwave', 'nebula', 'matrix', 'abyss', 'hologram', 'blackhole', 'hyperspace', 'galaxy', 'chrome', 'lava', 'dunes', 'neural', 'cyberspace', 'blueprint', 'datacenter', 'codeflow', 'silk', 'circuit', 'hexscan', 'radar', 'depgraph', 'gitflow', 'scope'];
		if (typeof s.theme === 'string' && LIVE_THEMES.includes(s.theme)) {
			s.theme = 'auto';
		}
		if (s.background !== 'image') {
			s.background = 'none';
		}
		s.glowStrength = clamp(s.glowStrength, 0, 100, DEFAULT_SETTINGS.glowStrength);
		s.glowColor = s.glowColor === 'accent' || s.glowColor === 'custom' ? s.glowColor : 'metallic';
		s.textReveal = s.textReveal === 'on' || s.textReveal === 'off' ? s.textReveal : 'auto';
		// Retired in 0.18: Agent Aura and the startup splash.
		for (const old of ['agentAura', 'aura', 'auraParts', 'auraStyle', 'auraColors', 'splash']) {
			delete (s as Record<string, unknown>)[old];
		}
		for (const key of ['accentColor', 'accentColor2', 'glowTone1', 'glowTone2', 'themeBackground', 'themeForeground'] as const) {
			if (typeof s[key] !== 'string' || (s[key] && !/^#[0-9a-f]{6}$/i.test(s[key]))) {
				s[key] = DEFAULT_SETTINGS[key];
			}
		}
		s.sandbox = s.sandbox === 'off' || s.sandbox === 'always' ? s.sandbox : 'auto';
		// duotone / dither / halftone / ASCII were retired in 0.30.
		if (!['none', 'blur'].includes(s.backgroundFilter)) {
			s.backgroundFilter = 'none';
		}
		if (typeof s.verifyAutoDetect !== 'boolean') {
			s.verifyAutoDetect = true;
		}
		for (const key of ['customInstructions', 'browserPath', 'theme', 'accent', 'language', 'replyLanguage', 'commandAllowlist', 'verifyCommand', 'whisperProvider', 'whisperModel', 'embeddingProvider', 'embeddingModel', 'fallbackModels', 'localHelper', 'localHelperTasks', 'denyPaths', 'background', 'backgroundImage', 'autocompleteModel', 'reasoningEfforts', 'fontUi', 'fontContent', 'fontCode'] as const) {
			if (typeof s[key] !== 'string') {
				(s as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
			}
		}
		return hostSettings(s, runtime);
	}

	private readonly settingsListeners = new Set<(s: AgentSettings) => void>();

	/** Called after every settings change (status-bar toggles and the like). */
	onSettingsChanged(listener: (s: AgentSettings) => void): { dispose(): void } {
		this.settingsListeners.add(listener);
		return { dispose: () => this.settingsListeners.delete(listener) };
	}

	async updateSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
		const next = { ...this.getSettings(false) };
		for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AgentSettings>) {
			if (key in patch && typeof patch[key] === typeof DEFAULT_SETTINGS[key]) {
				(next as Record<string, unknown>)[key] = patch[key];
			}
		}
		if (isDesktopHost()) {
			const remoteKeys = ['remoteEnabled', 'remotePort', 'remoteAccess', 'remoteSshTarget', 'remoteSshRemotePort'] as const;
			if (remoteKeys.some(key => key in patch)) await this.context.workspaceState.update('zer0neDesktop.remote', Object.fromEntries(remoteKeys.map(key => [key, next[key]])));
			const shared = { ...hostSettings(next, false) } as Partial<AgentSettings>;
			for (const key of remoteKeys) delete shared[key];
			await this.state.update(SETTINGS_KEY, shared);
		} else await this.state.update(SETTINGS_KEY, next);
		const fresh = this.getSettings();
		this.settingsListeners.forEach((l) => l(fresh));
		return fresh;
	}

	getMode(): ChatMode {
		const mode = this.state.get<string>(MODE_KEY, 'agent');
		return mode === 'chat' || mode === 'full' ? mode : 'agent';
	}

	async setMode(mode: ChatMode): Promise<void> {
		await this.state.update(MODE_KEY, mode);
	}

	// ---------------- usage statistics ----------------

	getUsageEvents(): UsageEvent[] {
		const raw = this.state.get<Array<UsageEvent & { tokens?: number }>>(USAGE_KEY, []);
		return raw.map((e) =>
			typeof e.tokens === 'number' && e.tokensIn === undefined
				? { t: e.t, providerId: e.providerId, model: e.model, tokensIn: e.tokens, tokensOut: 0 }
				: e
		);
	}

	async recordUsage(event: UsageEvent): Promise<void> {
		// Concurrent primary and peer calls must not overwrite each other's usage.
		this.usageWrites = this.usageWrites.catch(() => undefined).then(async () => {
			const cutoff = Date.now() - KEEP_USAGE_MS;
			const existing = this.getUsageEvents();
			const index = event.attemptId ? existing.findIndex((e) => e.attemptId === event.attemptId) : -1;
			if (index >= 0) existing[index] = event;
			else existing.push(event);
			const next = existing.filter((e) => e.t >= cutoff).slice(-MAX_USAGE_EVENTS);
			await this.state.update(USAGE_KEY, next);
			for (const listener of this.usageListeners) {
				try { listener(); } catch { /* Usage persistence does not depend on notifications. */ }
			}
		});
		await this.usageWrites;
	}

	summarizeWindow(events: UsageEvent[], windowMs: number, limit: number, now = Date.now()): WindowSummary {
		const inWindow = events.filter((e) => e.t >= now - windowMs);
		const used = inWindow.reduce((sum, e) => sum + e.tokensIn + e.tokensOut, 0);
		const oldest = inWindow.length ? Math.min(...inWindow.map((e) => e.t)) : now;
		return {
			used,
			limit,
			remainingPct: Math.max(0, Math.min(100, 100 - (used / Math.max(1, limit)) * 100)),
			resetsInMs: inWindow.length ? Math.max(0, windowMs - (now - oldest)) : windowMs
		};
	}

	usageWindows(provider: ProviderConfig, events: UsageEvent[]): { weekly: WindowSummary; fiveHour: WindowSummary } {
		const own = events.filter((e) => e.providerId === provider.id);
		return {
			weekly: this.summarizeWindow(own, WEEK_MS, provider.weeklyTokenLimit || DEFAULT_WEEKLY_LIMIT),
			fiveHour: this.summarizeWindow(own, FIVE_HOURS_MS, provider.fiveHourTokenLimit || DEFAULT_FIVE_HOUR_LIMIT)
		};
	}
}
