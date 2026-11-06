/**
 * Agent Client Protocol (ACP) registry: the catalogue of coding agents that
 * vendors ship for third-party clients (Zed, JetBrains, t3code…). Each agent
 * signs its own user in — "Agent Auth" (it runs the OAuth flow and opens the
 * browser) or "Terminal Auth" (an interactive login command) — so a plan
 * (Claude Pro/Max, Antigravity, Cursor, Gemini, OpenCode Go…) works here
 * without zer0ne ever seeing a token.
 *
 * Source: github.com/agentclientprotocol/registry (Apache-2.0), served from
 * cdn.agentclientprotocol.com. Registry data comes from the network, so
 * everything that reaches a process (package names, arguments, environment,
 * download URLs) is validated here first. Pure (no vscode); tested.
 */

export interface AcpBinary {
	archive: string;
	cmd: string;
	args?: string[];
	env?: Record<string, string>;
	sha256?: string;
}

export interface AcpAgentEntry {
	id: string;
	name: string;
	version: string;
	description: string;
	website?: string;
	repository?: string;
	authors: string[];
	license?: string;
	icon?: string;
	distribution: {
		npx?: { package: string; args?: string[]; env?: Record<string, string> };
		uvx?: { package: string; args?: string[]; env?: Record<string, string> };
		binary?: Record<string, AcpBinary>;
	};
}

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

const PACKAGE = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*(@[\w.+-]+)?$/i;
const UV_PACKAGE = /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?((==|@)[a-z0-9][\w.+-]*)?$/i;
const ARG = /^[\w@.:=+/,-]{0,200}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const ENV_VALUE = /^[\w@.:=+/,-]{0,200}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const safePackage = (p: unknown): p is string => typeof p === 'string' && p.length <= 120 && PACKAGE.test(p);
export const safeUvPackage = (p: unknown): p is string => typeof p === 'string' && p.length <= 120 && UV_PACKAGE.test(p);
export const safeArgs = (a: unknown): a is string[] => Array.isArray(a) && a.length <= 12 && a.every((x) => typeof x === 'string' && ARG.test(x));
export const safeEnv = (e: unknown): e is Record<string, string> => !!e && typeof e === 'object' && Object.entries(e as object).every(([k, v]) => ENV_KEY.test(k) && typeof v === 'string' && ENV_VALUE.test(v));
export function safeHttps(u: unknown): u is string {
	if (typeof u !== 'string') return false;
	try {
		const url = new URL(u);
		return url.protocol === 'https:' && !url.username && !url.password;
	} catch {
		return false;
	}
}

const asArgs = (a: unknown): string[] | undefined => (a === undefined ? [] : safeArgs(a) ? a : undefined);
const asEnv = (e: unknown): Record<string, string> | undefined => (e === undefined ? {} : safeEnv(e) ? e : undefined);

/** registry.json (or a bare agents array) → validated entries; anything malformed is dropped (pure; tested). */
export function parseRegistry(json: unknown): AcpAgentEntry[] {
	const list: unknown[] = Array.isArray(json) ? json : Array.isArray((json as { agents?: unknown[] })?.agents) ? (json as { agents: unknown[] }).agents : [];
	const out: AcpAgentEntry[] = [];
	for (const raw of list) {
		const a = raw as Record<string, any>;
		if (!a || typeof a.id !== 'string' || !SAFE_ID.test(a.id) || typeof a.name !== 'string' || typeof a.version !== 'string') continue;
		const dist: AcpAgentEntry['distribution'] = {};
		for (const kind of ['npx', 'uvx'] as const) {
			const d = a.distribution?.[kind];
			if (!d) continue;
			const args = asArgs(d.args);
			const env = asEnv(d.env);
			if ((kind === 'uvx' ? safeUvPackage(d.package) : safePackage(d.package)) && args && env) dist[kind] = { package: d.package, args, env };
		}
		const bins: Record<string, AcpBinary> = {};
		for (const [plat, b] of Object.entries<any>(a.distribution?.binary ?? {})) {
			const args = asArgs(b?.args);
			const env = asEnv(b?.env);
			// Windows entries write "./dist\\agent.cmd": one separator style, no way out of the install folder.
			const cmd = typeof b?.cmd === 'string' ? b.cmd.replace(/\\/g, '/') : '';
			if (!/^(darwin|linux|windows)-(aarch64|x86_64)$/.test(plat) || !safeHttps(b?.archive) || !/^(\.\/)?[\w.+\-/]{1,160}$/.test(cmd) || cmd.split('/').includes('..') || !args || !env) continue;
			bins[plat] = { archive: b.archive, cmd, args, env, sha256: /^[0-9a-f]{64}$/i.test(b.sha256 ?? '') ? String(b.sha256).toLowerCase() : undefined };
		}
		if (Object.keys(bins).length) dist.binary = bins;
		if (!dist.npx && !dist.uvx && !dist.binary) continue;
		out.push({
			id: a.id,
			name: a.name.slice(0, 60),
			version: a.version.slice(0, 40),
			description: typeof a.description === 'string' ? a.description.slice(0, 240) : '',
			website: safeHttps(a.website) ? a.website : undefined,
			repository: safeHttps(a.repository) ? a.repository : undefined,
			authors: Array.isArray(a.authors) ? a.authors.filter((x: unknown) => typeof x === 'string').slice(0, 6) : [],
			license: typeof a.license === 'string' ? a.license.slice(0, 40) : undefined,
			icon: safeHttps(a.icon) ? a.icon : undefined,
			distribution: dist
		});
	}
	return out;
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
	const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined;
	const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
	return os && cpu ? `${os}-${cpu}` : undefined;
}

export interface AcpLaunch {
	kind: 'npx' | 'uvx' | 'binary';
	args: string[];
	env: Record<string, string>;
	/** npx / uvx: the package spec (name@version). */
	package?: string;
	/** binary: archive URL, checksum and the command inside it. */
	archive?: string;
	sha256?: string;
	cmd?: string;
}

/** How to start an agent on this machine: a downloadable binary first (nothing else to install), else npx, else uvx (pure; tested). */
export function launchFor(entry: AcpAgentEntry, platform: NodeJS.Platform = process.platform, arch: string = process.arch, prefer: 'binary' | 'npx' = 'binary'): AcpLaunch | undefined {
	const d = entry.distribution;
	const bin = d.binary?.[platformKey(platform, arch) ?? ''];
	const asBinary = (): AcpLaunch | undefined => (bin ? { kind: 'binary', args: bin.args ?? [], env: bin.env ?? {}, archive: bin.archive, sha256: bin.sha256, cmd: bin.cmd } : undefined);
	const asNpx = (): AcpLaunch | undefined => (d.npx ? { kind: 'npx', args: d.npx.args ?? [], env: d.npx.env ?? {}, package: d.npx.package } : undefined);
	const first = prefer === 'npx' ? asNpx() ?? asBinary() : asBinary() ?? asNpx();
	return first ?? (d.uvx ? { kind: 'uvx', args: d.uvx.args ?? [], env: d.uvx.env ?? {}, package: d.uvx.package } : undefined);
}

/** Registry version bump helper: 'pkg@1.2.3' → 1.2.3 (pure). */
export const packageVersion = (spec: string): string | undefined => /@([\w.+-]+)$/.exec(spec.replace(/^@/, ''))?.[1];

// ---------------------------------------------------------------- curated plan metadata

/**
 * The agents that carry a subscription plan, shown as "Sign in" cards in
 * Providers & models. `keyPreset` = the same vendor's plain API key card
 * (offered next to the sign-in); `direct` = zer0ne already has its own
	 * account sign-in for this vendor, so the alternate agent is omitted from the plan picker.
 */
export interface AcpPlanMeta {
	name: string;
	plans: string;
	desc: string;
	tile: { text: string; bg: string; fg?: string };
	keyPreset?: string;
	manageUrl?: string;
	/** A terminal command that signs in when the agent itself offers no method (run in the editor's terminal). */
	loginCommand?: { command: string; args: string[] };
	/** A command that prints the account's state as JSON (claude auth status) — also gives the plan name. */
	statusCommand?: { command: string; args: string[] };
	direct?: string;
	note?: string;
	/**
	 * Keep the agent on the vendor's plan: environment variables to remove
	 * (proxy / gateway routing) and `_meta` for each new session.
	 */
	planOnly?: { dropEnv: RegExp; sessionMeta?: Record<string, unknown> };
	/**
	 * The plan inside an agent that serves more: a session option to set first
	 * (Cline's billing = ClinePass), the model id prefixes that belong to the
	 * plan (the first prefix with models wins), and the sign-in method to use.
	 */
	planScope?: { option?: { id: string; value: string }; models?: string[]; authMethod?: string };
}

export const PLAN_AGENTS: Record<string, AcpPlanMeta> = {
	'claude-acp': {
		name: 'Claude',
		plans: 'Pro · Max · Team · Enterprise',
		desc: 'Claude Opus, Sonnet and Haiku on your Claude plan — through Anthropic\'s own Claude Agent',
		tile: { text: 'A', bg: '#d97757' },
		keyPreset: 'claude-account',
		manageUrl: 'https://claude.com/pricing',
		// Preflight and login must use the same setting sources as sessionMeta; user proxy credentials can otherwise look like a subscription login.
		loginCommand: { command: 'claude', args: ['--setting-sources', 'project,local', 'auth', 'login', '--claudeai'] },
		statusCommand: { command: 'claude', args: ['--setting-sources', 'project,local', 'auth', 'status', '--json'] },
		// Claude Code's user settings.json may route it through a proxy (ANTHROPIC_BASE_URL + a token) and rename every model;
		// the plan card must reach Anthropic with the Claude login, so user settings and routing variables are left out (project settings and CLAUDE.md stay).
		planOnly: {
			dropEnv: /^(ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|DEFAULT_[A-Z]+_MODEL)|CLAUDE_CODE_(SUBAGENT_MODEL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))$/,
			sessionMeta: { claudeCode: { options: { settingSources: ['project', 'local'] } } }
		},
		note:'Runs Anthropic\'s official Claude Agent (built with Zed and JetBrains) on your computer with your login — zer0ne never sees the token. Anthropic decides how plan usage may be used; the API key is always allowed.'
	},
	'antigravity-acp': {
		name: 'Google Antigravity',
		plans: 'Google AI Pro · Ultra',
		desc: 'Gemini and Claude models on your Google AI plan — through Google\'s own Antigravity agent',
		tile: { text: 'G', bg: '#1a73e8' },
		keyPreset: 'gemini',
		manageUrl: 'https://antigravity.google',
		planScope: { authMethod: 'oauth-personal' },
		note: 'Runs Google\'s official ACP agent (a large download, you confirm first). Google controls account verification, plan eligibility and supported integrations; consumer access is not guaranteed in every app. A Gemini API key is available separately.'
	},
	gemini: {
		name: 'Gemini CLI',
		direct: 'acp:antigravity-acp',
		plans: 'Google Cloud account access',
		desc: 'Google\'s Gemini CLI with eligible Cloud access; consumer Google sign-in retired in June 2026',
		tile: { text: 'G', bg: '#4285f4' },
		keyPreset: 'gemini',
		manageUrl: 'https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals',
		note: 'Google ended consumer Gemini CLI Google login on June 18, 2026. Check the current Cloud access requirements, or connect Google AI Studio through its API key provider. Antigravity uses its own account access and verification.',
		planOnly: { dropEnv: /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI)$/ }
	},
	cursor: {
		name: 'Cursor',
		plans: 'Pro · Pro+ · Ultra · Teams',
		desc: 'Cursor\'s agent and its models on your Cursor plan',
		tile: { text: 'C', bg: '#111' },
		manageUrl: 'https://cursor.com/pricing'
	},
	opencode: {
		name: 'OpenCode',
		plans: 'OpenCode Go · Zen',
		desc: 'The models of your OpenCode Go subscription (Zen\'s free models when there is no Go plan)',
		tile: { text: 'oc', bg: '#211e1e' },
		keyPreset: 'opencode-go',
		manageUrl: 'https://opencode.ai/auth',
		loginCommand: { command: 'opencode', args: ['auth', 'login'] },
		// OpenCode also lists every provider connected inside it (the user's own keys): the card is the Go plan, else Zen.
		planScope: { models: ['opencode-go/', 'opencode/'] }
	},
	'qwen-code': {
		name: 'Qwen Code',
		plans: 'Qwen account · Alibaba coding plan',
		desc: 'Qwen coder models — through Alibaba\'s own Qwen Code',
		tile: { text: 'Q', bg: '#615ced' },
		keyPreset: 'alibaba-coding-plan',
		manageUrl: 'https://qwenlm.github.io/qwen-code-docs/'
	},
	'mistral-vibe': {
		name: 'Mistral Vibe',
		plans: 'Le Chat Pro · Team',
		desc: 'Devstral and Mistral models on your Le Chat plan',
		tile: { text: 'M', bg: '#fa520f' },
		keyPreset: 'mistral',
		manageUrl: 'https://mistral.ai/pricing'
	},
	'factory-droid': {
		name: 'Factory Droid',
		plans: 'Factory plans',
		desc: 'Factory\'s Droid agent on your Factory plan',
		tile: { text: 'F', bg: '#ee6018' },
		manageUrl: 'https://factory.ai/pricing'
	},
	'amp-acp': {
		name: 'Amp',
		plans: 'Amp credits',
		desc: 'Sourcegraph\'s Amp agent on your Amp account',
		tile: { text: 'A', bg: '#f34e3f' },
		manageUrl: 'https://ampcode.com'
	},
	junie: {
		name: 'JetBrains Junie',
		plans: 'JetBrains AI Pro · Ultimate',
		desc: 'JetBrains\' coding agent on your JetBrains AI plan',
		tile: { text: 'J', bg: '#000' },
		manageUrl: 'https://www.jetbrains.com/ai-ides/buy/'
	},
	kilo: {
		name: 'Kilo Code',
		plans: 'Kilo credits · Kilo Pass',
		desc: 'Kilo\'s agent with its gateway models and free models',
		tile: { text: 'K', bg: '#f8f675', fg: '#111' },
		manageUrl: 'https://kilo.ai'
	},
	cline: {
		name: 'Cline',
		plans: 'ClinePass',
		desc: 'Cline\'s agent on your ClinePass subscription — its plan models only',
		tile: { text: 'Cl', bg: '#7c3aed' },
		keyPreset: 'cline-pass',
		manageUrl: 'https://cline.bot/cline-pass',
		// Cline defaults to usage billing (318 gateway models); the card is the ClinePass subscription.
		planScope: { option: { id: 'provider', value: 'cline-pass' }, models: ['cline-pass/'], authMethod: 'cline-pass' }
	},
	auggie: {
		name: 'Augment Auggie',
		plans: 'Augment plans',
		desc: 'Augment\'s agent on your Augment plan',
		tile: { text: 'Au', bg: '#22c55e' },
		manageUrl: 'https://www.augmentcode.com/pricing'
	},
	'codebuddy-code': {
		name: 'Tencent CodeBuddy',
		plans: 'CodeBuddy plans',
		desc: 'Tencent\'s CodeBuddy agent on your CodeBuddy plan',
		tile: { text: 'CB', bg: '#0052d9' },
		keyPreset: 'tencent-coding-plan',
		manageUrl: 'https://www.codebuddy.ai'
	},
	qoder: {
		name: 'Qoder',
		plans: 'Qoder plans',
		desc: 'Qoder\'s agent on your Qoder plan',
		tile: { text: 'Qo', bg: '#10b981' },
		manageUrl: 'https://qoder.com'
	},
	devin: {
		name: 'Devin',
		plans: 'Devin plans',
		desc: 'Cognition\'s Devin agent on your Devin plan',
		tile: { text: 'D', bg: '#1f6feb' },
		manageUrl: 'https://devin.ai'
	},
	'glm-acp-agent': {
		name: 'Z.ai GLM',
		plans: 'GLM Coding Plan',
		desc: 'GLM models on your Z.ai coding plan — through the GLM agent',
		tile: { text: 'Z', bg: '#2d5bff' },
		keyPreset: 'zai-coding-plan',
		manageUrl: 'https://z.ai/subscribe'
	},
	poolside: {
		name: 'Poolside',
		plans: 'Poolside account',
		desc: 'Poolside\'s Malibu and Laguna models',
		tile: { text: 'P', bg: '#6d28d9' },
		manageUrl: 'https://poolside.ai'
	},
	'github-copilot-cli': {
		name: 'GitHub Copilot',
		plans: 'Copilot Free · Pro · Pro+ · Business',
		desc: 'GitHub\'s own Copilot agent and the models available to your account',
		tile: { text: 'C', bg: '#24292f' },
		manageUrl: 'https://github.com/features/copilot/plans',
		planOnly: { dropEnv: /^COPILOT_(PROVIDER_[A-Z_]+|PROVIDERS_CONFIG)$/ }
	},
	'codex-acp': {
		name: 'Codex (agent)',
		direct: 'chatgpt-account',
		plans: 'ChatGPT Plus · Pro · Business',
		desc: 'Connect your ChatGPT account through the Codex agent\'s supported sign-in',
		tile: { text: 'O', bg: '#0d0d0d' },
		keyPreset: 'openai',
		manageUrl: 'https://developers.openai.com/codex/auth',
		planOnly: { dropEnv: /^(CODEX_API_KEY|OPENAI_API_KEY|MODEL_PROVIDER|CODEX_CONFIG)$/ }
	},
	'grok-build': {
		name: 'Grok Build',
		plans: 'SuperGrok · X Premium',
		desc: 'Connect your account through xAI\'s Grok Build agent',
		tile: { text: 'x', bg: '#000' },
		keyPreset: 'xai',
		manageUrl: 'https://grok.com'
	},
	kimi: {
		name: 'Kimi',
		plans: 'Kimi Code plan',
		desc: 'Connect your Kimi Code account through Moonshot\'s Kimi agent',
		tile: { text: 'K', bg: '#000' },
		keyPreset: 'kimi-code',
		manageUrl: 'https://www.kimi.com/code'
	},
	'minimax-code': {
		name: 'MiniMax Code',
		plans: 'MiniMax Coding Plan',
		desc: 'Connect your coding plan through MiniMax\'s own agent',
		tile: { text: 'M', bg: '#e8374a' },
		keyPreset: 'minimax-coding-plan',
		manageUrl: 'https://platform.minimax.io/subscribe/coding-plan'
	}
};

/** Order of the plan cards (the rest of the registry follows, by name). */
export const PLAN_ORDER = ['claude-acp', 'antigravity-acp', 'gemini', 'cursor', 'opencode', 'codex-acp', 'grok-build', 'kimi', 'minimax-code', 'qwen-code', 'mistral-vibe', 'factory-droid', 'amp-acp', 'junie', 'kilo', 'cline', 'auggie', 'codebuddy-code', 'qoder', 'devin', 'glm-acp-agent', 'poolside', 'github-copilot-cli'];

/** A registry agent as a Providers & models card (pure; tested). */
export interface AcpCard {
	id: string;
	name: string;
	plans: string;
	desc: string;
	tile: { text: string; bg: string; fg?: string };
	keyPreset?: string;
	manageUrl?: string;
	note?: string;
	/** Has a subscription plan (the main list) or is a plain agent (More agents). */
	plan: boolean;
	/** A zer0ne account sign-in for the same vendor already exists — the agent is a second way in. */
	direct?: string;
	version: string;
	download: boolean;
	license?: string;
	website?: string;
	available?: boolean;
	setupIssue?: string;
	setupUrl?: string;
}

export function cardsFrom(entries: AcpAgentEntry[]): AcpCard[] {
	const cards = entries.map((e): AcpCard => {
		const meta = PLAN_AGENTS[e.id];
		return {
			id: e.id,
			name: meta?.name ?? e.name,
			plans: meta?.plans ?? '',
			desc: meta?.desc ?? e.description,
			tile: meta?.tile ?? { text: e.name.slice(0, 2), bg: '#3f3f46' },
			keyPreset: meta?.keyPreset,
			manageUrl: meta?.manageUrl ?? e.website,
			note: meta?.note ?? 'The provider’s agent handles authentication and stores its own credentials. Account eligibility, available models and usage limits are decided by the provider; some plans require a dedicated key.',
			plan: !!meta && !meta.direct,
			direct: meta?.direct,
			version: e.version,
			download: !!e.distribution.binary && !e.distribution.npx,
			license: e.license,
			website: e.website
		};
	});
	const rank = (c: AcpCard) => {
		const i = PLAN_ORDER.indexOf(c.id);
		return c.plan ? (i < 0 ? 500 : i) : 1000;
	};
	return cards.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
