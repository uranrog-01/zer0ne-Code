import type { AgentSettings } from '../providerStore';

type SwitchKey = NonNullable<{ [K in keyof AgentSettings]: AgentSettings[K] extends boolean ? K : never }[keyof AgentSettings]>;
export interface FeatureDefinition {
	key: SwitchKey; icon: string; name: string; description: string; group: string;
	check: string; configure?: string; advanced?: boolean; editorOnly?: boolean;
	scope: 'project' | 'installation' | 'chat'; requires?: string[];
	action?: 'verify' | 'audit' | 'browser' | 'language';
}

export const FEATURE_REGISTRY: readonly FeatureDefinition[] = [
	{ key:'tokenSaver', icon:'zap', name:'Token Saver', description:'Compress noisy tool output while keeping failures and useful details.', group:'Context & efficiency', check:'saver', scope:'installation' },
	{ key:'autoCompact', icon:'memory', name:'Automatic compaction', description:'Summarize older context near the model limit. Review or compact manually with /compact.', group:'Context & efficiency', check:'autoCompact', scope:'installation' },
	{ key:'exactHistory', icon:'list', name:'Exact history', description:'Retain tool calls and results between turns for continuity and stable prompt prefixes.', group:'Context & efficiency', check:'cache', scope:'installation' },
	{ key:'repoMap', icon:'folder', name:'Repository map', description:'Start each task knowing the project layout: folders, key files and main symbols, in about 1,500 tokens that stay cached.', group:'Context & efficiency', check:'repoMap', scope:'installation' },
	{ key:'deferTools', icon:'layers', name:'On-demand tools', description:'Discover less frequently used tools when needed instead of sending every definition.', group:'Context & efficiency', check:'deferTools', scope:'installation' },
	{ key:'cacheWarm', icon:'clock', name:'Cache warming', description:'Optionally make paid Anthropic refresh requests when estimated savings justify them; at most three refreshes.', group:'Context & efficiency', check:'cacheWarm', advanced:true, scope:'installation' },
	{ key:'codeIndex', icon:'search', name:'Code index', description:'Search project code and documentation (Markdown, text, PDF text layers) locally by keywords, with optional model embeddings.', group:'Coding', check:'index', configure:'features', scope:'project' },
	{ key:'projectVerification', icon:'check', name:'Project verification', description:'Preview and run type, lint, test and build stages with dated, snapshot-bound reports.', group:'Coding', check:'projectVerification', requires:['commandTool'], action:'verify', scope:'project' },
	{ key:'codeIntelligence', icon:'code', name:'Code intelligence', description:'Definitions, references, symbols and diagnostics from your configured local language server.', group:'Coding', check:'codeIntelligence', action:'language', scope:'project', advanced:true },
	{ key:'workspaceWatch', icon:'refresh', name:'Workspace watch', description:'Invalidate stale check results and search context when project files change. Never runs commands automatically.', group:'Coding', check:'workspaceWatch', scope:'project' },
	{ key:'dependencyAudit', icon:'shield', name:'Dependency audit', description:'Preview an npm audit and read structured findings. Uses the registry; never applies dependency fixes.', group:'Coding', check:'dependencyAudit', requires:['commandTool'], action:'audit', scope:'project', advanced:true },
	{ key:'gitTools', icon:'branch', name:'Git tools', description:'Inspect status, diffs, history and change impact without modifying Git history.', group:'Coding', check:'git', scope:'installation' },
	{ key:'runScript', icon:'code', name:'Read-only scripts', description:'Batch supported read-only tool calls inside a restricted Node process.', group:'Coding', check:'script', scope:'installation', advanced:true },
	{ key:'subagents', icon:'cpu', name:'Subagents', description:'Delegate focused work with independent context, bounded concurrency and review.', group:'Research & interaction', check:'subagents', configure:'agent', scope:'installation' },
	{ key:'browserAgent', icon:'globe', name:'Browser agent', description:'Inspect and operate a separate browser profile using the existing approval policy.', group:'Research & interaction', check:'browser', configure:'browser', scope:'installation' },
	{ key:'browserChecks', icon:'check', name:'Browser regression checks', description:'Run project-declared page assertions with screenshots and a result per scenario.', group:'Research & interaction', check:'browserChecks', requires:['browserAgent'], action:'browser', scope:'project' },
	{ key:'browserTools', icon:'search', name:'Web research', description:'Search and fetch documentation and pages through the selected search service.', group:'Research & interaction', check:'web', configure:'browser', scope:'installation' },
	{ key:'imageGenerate', icon:'image', name:'Image generation', description:'Let the agent create an image from a prompt with an installed Studio image model or an image-capable provider. Each call is approved and the file is saved in the project.', group:'Research & interaction', check:'imageGenerate', scope:'installation' },
	{ key:'computerUse', icon:'eye', name:'Computer Use', description:'Control allowed Windows apps with a vision model. Manage app permissions, pause control and stop input across projects.', group:'Research & interaction', check:'computerUse', configure:'browser', scope:'installation', advanced:true },
	{ key:'commandNotices', icon:'bell', name:'Command reports', description:'When a background command such as a long build or test run ends, the agent is told how it ended, with the end of its output, instead of having to check on it.', group:'Background work', check:'commandNotices', requires:['commandTool'], scope:'installation' },
	{ key:'agentWatchdog', icon:'eye', name:'Agent watchdog', description:'Nudge a subagent that repeats the same call with the same result, and tell the main agent about one that keeps repeating or has no finished step for too long.', group:'Background work', check:'agentWatchdog', requires:['subagents'], scope:'installation' },
	{ key:'agentDriftCheck', icon:'shield', name:'Drift check', description:'Every ten minutes, ask the chat model whether each background agent still works toward its task. A doubt goes to the main agent as a suggestion. Uses model calls.', group:'Background work', check:'agentDriftCheck', requires:['agentWatchdog'], advanced:true, scope:'installation' },
	{ key:'recallTool', icon:'memory', name:'Linked recall', description:'Let the main agent look up agents, background commands, conversations and events by the ids in their notices, one hop at a time, instead of rereading transcripts.', group:'Background work', check:'recallTool', scope:'installation' },
	{ key:'threadRouting', icon:'phone', name:'Conversation routing', description:'A reply in a Telegram or Discord conversation goes straight to the background agent working on it, and its answer comes back to that conversation.', group:'Background work', check:'threadRouting', requires:['subagents'], scope:'installation' },
	{ key:'eventSources', icon:'branch', name:'CI and review events', description:'Check this branch\'s CI runs and pull request reviews with the GitHub CLI. Events on a conversation an agent owns go to that agent. Other failures and comments are checked against your policy; at first it only records what it would hand over, until you let events reach the agent.', group:'Background work', check:'eventSources', requires:['gitTools'], scope:'project' },
	{ key:'mcp', icon:'server', name:'MCP tools', description:'Connect local or remote tool servers. Discovery and successful execution are separate checks.', group:'Integrations', check:'mcp', configure:'mcp', scope:'installation' },
	{ key:'skills', icon:'book', name:'Skills', description:'Load reusable playbooks on demand and control their prompt budget.', group:'Integrations', check:'skills', configure:'skills', scope:'installation' },
	{ key:'remoteEnabled', icon:'phone', name:'Mobile remote', description:'Pair a phone with this project over Wi-Fi or your selected secure connection.', group:'Integrations', check:'remote', configure:'remote', scope:'project' },
	{ key:'debugTools', icon:'command', name:'Debugger', description:'Inspect an editor debugging session using its language extension.', group:'Editor', check:'debugTools', scope:'installation', editorOnly:true },
	{ key:'autocomplete', icon:'sparkle', name:'Inline autocomplete', description:'Use an editor completion model while typing.', group:'Editor', check:'autocomplete', scope:'installation', editorOnly:true },
];

export function featureCatalog(desktop: boolean, remote = false): FeatureDefinition[] {
	return FEATURE_REGISTRY.filter(f => !(desktop && f.editorOnly) && !(remote && f.key === 'remoteEnabled')).map(f => ({ ...f, requires: f.requires ? [...f.requires] : undefined }));
}
