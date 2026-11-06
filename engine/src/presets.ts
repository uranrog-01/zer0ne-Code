import type { ApiFormat } from './providerStore';

/**
 * Cards on the "Add provider" screen. Base URLs, models and limits come
 * from the models.dev catalog entry (`catalogId`) when there is one, so
 * they stay current; `baseUrl` is the fallback.
 *
 * OAuth registrations cannot be borrowed from another application. Agent
 * subscriptions authenticate through their own vendor's software; API keys
 * stay separate because subscription access does not imply API entitlement.
 */

export interface Preset {
	id: string;
	name: string;
	/** 'legacy' presets are hidden from the picker but still resolve for existing providers. */
	group: 'custom' | 'signin' | 'plans' | 'api' | 'local' | 'legacy';
	tile: { text: string; bg: string; fg?: string };
	desc: string;
	kind: 'apiKey' | 'oauth-openrouter' | 'oauth-github' | 'vscode-lm' | 'info' | 'account';
	/** kind 'account': which sign-in (src/accounts.ts). */
	account?: 'chatgpt' | 'xai' | 'kimi' | 'minimax';
	/** The same vendor with an API key instead of the account (the card's second button). */
	keyPreset?: string;
	/** Shown under the card: a limit the vendor sets (e.g. why there is no subscription login). */
	note?: string;
	/** The note in one short line (the full note is the tooltip). */
	noteShort?: string;
	/** Plans / what the account includes, one short line. */
	plans?: string;
	catalogId?: string;
	baseUrl?: string;
	apiFormat?: ApiFormat;
	keyUrl?: string;
	/** For `info` cards: why + what to use instead. */
	info?: string;
	suggest?: string[];
}

export const PRESETS: Preset[] = [
	// ---- sign in with an account
	{ id: 'chatgpt-account', name: 'ChatGPT', group: 'signin', tile: { text: 'O', bg: '#0d0d0d' }, kind: 'account', account: 'chatgpt', keyPreset: 'openai', plans: 'Eligible ChatGPT plans', desc: 'Connect through OpenAI’s browser OAuth for open-source agents. Your account determines available models and limits.' },
	{
		id: 'claude-account', name: 'Claude', group: 'signin', tile: { text: 'A', bg: '#d97757' }, kind: 'apiKey', catalogId: 'anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', plans: 'Anthropic Console', desc: 'Fable, Opus and Sonnet with a Console key', noteShort: 'Console API billing is separate from your plan',
		note: 'A Console API key uses separate API billing. For subscription access, connect the Claude agent under Plans & subscriptions; the agent and account determine eligibility.'
	},
	{
		id: 'gemini', name: 'Google Gemini', group: 'signin', tile: { text: 'G', bg: '#1a73e8' }, kind: 'apiKey', catalogId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', keyPreset: 'vertex', plans: 'Google AI Studio · free key', desc: 'Gemini 3.x with a free AI Studio key — native API', noteShort: 'API quotas are separate from your subscription',
		note: 'AI Studio API quotas and billing are separate from a Google AI subscription. For account login, connect Google Antigravity under Plans & subscriptions.'
	},
	{ id: 'xai-account', name: 'Grok', group: 'legacy', tile: { text: 'x', bg: '#000' }, kind: 'account', account: 'xai', keyPreset: 'xai', desc: 'Existing account connection; use Grok Build for new provider-agent sign-in.' },
	{ id: 'kimi-account', name: 'Kimi Code', group: 'legacy', tile: { text: 'K', bg: '#000' }, kind: 'account', account: 'kimi', keyPreset: 'kimi-code', desc: 'Existing account connection; use Kimi CLI or a Kimi Code plan key.' },
	{ id: 'minimax-account', name: 'MiniMax', group: 'legacy', tile: { text: 'M', bg: '#e8374a' }, kind: 'account', account: 'minimax', keyPreset: 'minimax-coding-plan', desc: 'Existing account connection; use MiniMax Code or a dedicated plan key.' },
	{ id: 'claude-plan', name: 'Claude Pro / Max', group: 'legacy', tile: { text: 'A', bg: '#d97757' }, kind: 'apiKey', catalogId: 'anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', keyPreset: 'anthropic', plans: 'Anthropic Console', desc: 'Existing Console API connection', note: 'Connect the Claude agent for provider-supported subscription login. Console API keys use separate billing.' },
	{ id: 'antigravity', name: 'Google Antigravity', group: 'legacy', tile: { text: 'G', bg: '#1a73e8' }, kind: 'apiKey', catalogId: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiFormat: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', keyPreset: 'vertex', desc: 'Existing Gemini API connection', note: 'Connect the Antigravity agent for its account sign-in. AI Studio and Vertex use their own API billing and quotas.' },
	{ id: 'copilot', name: 'GitHub Copilot', group: 'signin', tile: { text: 'C', bg: '#24292f' }, kind: 'vscode-lm', apiFormat: 'vscode-lm', plans: 'Copilot Free · Pro · Pro+', desc: 'Claude, GPT & Gemini on your Copilot plan — VS Code sign-in' },
	{ id: 'openrouter-oauth', name: 'OpenRouter', group: 'signin', tile: { text: 'OR', bg: '#6566f1' }, kind: 'oauth-openrouter', catalogId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', keyPreset: 'openrouter', plans: 'Credits · free models', desc: 'One account for Claude, GPT, Gemini, Kimi, GLM…' },
	{ id: 'github-models', name: 'GitHub Models (retired)', group: 'legacy', tile: { text: 'GH', bg: '#0d1117' }, kind: 'info', desc: 'Retired July 30, 2026', info: 'GitHub Models has retired its catalog and inference API. GitHub Copilot is a separate service; connect its official agent under Plans & subscriptions.', suggest: ['openrouter-oauth'] },
	{ id: 'ollama-cloud', name: 'Ollama Cloud', group: 'signin', tile: { text: 'O☁', bg: '#fff', fg: '#000' }, kind: 'apiKey', catalogId: 'ollama-cloud', baseUrl: 'https://ollama.com/v1', keyUrl: 'https://ollama.com/settings/keys', plans: 'ollama.com account', desc: 'GLM, Kimi, Qwen3 Coder, gpt-oss in the cloud' },
	{ id: 'huggingface', name: 'Hugging Face', group: 'signin', tile: { text: '🤗', bg: '#ffd21e', fg: '#000' }, kind: 'apiKey', catalogId: 'huggingface', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens', plans: 'Free monthly credits', desc: 'Inference Providers with your HF token' },
	{ id: 'poe', name: 'Poe', group: 'signin', tile: { text: 'P', bg: '#5d5cde' }, kind: 'apiKey', catalogId: 'poe', baseUrl: 'https://api.poe.com/v1', keyUrl: 'https://poe.com/api_key', plans: 'Poe points', desc: 'Claude, GPT, Gemini, Grok and more on your points' },
	// Retired info cards (0.9–0.22): kept so old references resolve.
	{ id: 'claude-sub', name: 'Claude Pro / Max', group: 'legacy', tile: { text: 'A', bg: '#d97757' }, kind: 'info', desc: '', info: 'Claude subscription logins work only in Anthropic\'s apps. Use a Console API key.', suggest: ['claude-account'] },
	{ id: 'chatgpt-sub', name: 'ChatGPT Plus / Pro', group: 'legacy', tile: { text: 'O', bg: '#0d0d0d' }, kind: 'info', desc: '', info: 'Sign in with ChatGPT is now built in.', suggest: ['chatgpt-account'] },
	// ---- coding plans (subscription keys)
	{ id: 'zai-coding-plan', name: 'Z.ai GLM Coding Plan', group: 'plans', tile: { text: 'Z', bg: '#111', fg: '#fff' }, kind: 'apiKey', catalogId: 'zai-coding-plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4', keyUrl: 'https://z.ai/manage-apikey/apikey-list', desc: 'GLM subscription key' },
	{ id: 'zhipuai-coding-plan', name: 'BigModel Coding Plan', group: 'plans', tile: { text: 'B', bg: '#3b5bdb' }, kind: 'apiKey', catalogId: 'zhipuai-coding-plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', desc: 'GLM plan (China)' },
	{ id: 'kimi-code', name: 'Kimi Code', group: 'plans', tile: { text: 'K', bg: '#000' }, kind: 'apiKey', catalogId: 'kimi-code-plan-global', baseUrl: 'https://api.kimi.ai/coding/v1', desc: 'Kimi for Coding subscription' },
	{ id: 'minimax-coding-plan', name: 'MiniMax Coding Plan', group: 'plans', tile: { text: 'M', bg: '#e8374a' }, kind: 'apiKey', catalogId: 'minimax-coding-plan', baseUrl: 'https://api.minimax.io/anthropic/v1', apiFormat: 'anthropic', desc: 'MiniMax M2 subscription' },
	{ id: 'opencode-zen', name: 'OpenCode Zen', group: 'plans', tile: { text: 'oc', bg: '#1f1f1f' }, kind: 'apiKey', catalogId: 'opencode', baseUrl: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/auth', desc: 'Curated coding models' },
	{ id: 'opencode-go', name: 'OpenCode Go', group: 'plans', tile: { text: 'go', bg: '#1f1f1f' }, kind: 'apiKey', catalogId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', keyUrl: 'https://opencode.ai/auth', desc: 'Low-cost subscription' },
	{ id: 'commandcode', name: 'Command Code', group: 'plans', tile: { text: 'CC', bg: '#111' }, kind: 'apiKey', baseUrl: 'https://api.commandcode.ai/provider/v1', apiFormat: 'openai', keyUrl: 'https://commandcode.ai/settings/keys', desc: 'GOAT, Pro or Max plan — Claude, GPT, DeepSeek, Kimi, GLM (the $1 Go plan works only in Command Code\'s own CLI)' },
	{ id: 'cline-pass', name: 'ClinePass', group: 'plans', tile: { text: 'Cl', bg: '#18181b' }, kind: 'apiKey', catalogId: 'cline-pass', baseUrl: 'https://api.cline.bot/api/v1', keyUrl: 'https://app.cline.bot/dashboard/account', desc: 'Cline\'s subscription — Qwen, MiMo, GLM' },
	{ id: 'devpass', name: 'DevPass', group: 'plans', tile: { text: 'LG', bg: '#0f172a' }, kind: 'apiKey', catalogId: 'llmgateway', baseUrl: 'https://api.llmgateway.io/v1', keyUrl: 'https://llmgateway.io/dashboard', desc: 'LLM Gateway\'s subscription — 200+ models' },
	{ id: 'nano-gpt', name: 'NanoGPT', group: 'plans', tile: { text: 'N', bg: '#6d28d9' }, kind: 'apiKey', catalogId: 'nano-gpt', baseUrl: 'https://nano-gpt.com/api/v1', keyUrl: 'https://nano-gpt.com/api', desc: 'Subscription for open models, or pay per prompt — 600 models' },
	{ id: 'alibaba-coding-plan', name: 'Alibaba Coding Plan', group: 'plans', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba-coding-plan', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1', desc: 'Qwen coding subscription' },
	{ id: 'cerebras-code', name: 'Cerebras Code', group: 'plans', tile: { text: 'C', bg: '#f15a29' }, kind: 'apiKey', catalogId: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', desc: 'Pro / Max plans — Qwen3 Coder and GLM at ~2,000 tokens/s' },
	{ id: 'synthetic', name: 'Synthetic', group: 'plans', tile: { text: 'S', bg: '#111827' }, kind: 'apiKey', catalogId: 'synthetic', baseUrl: 'https://api.synthetic.new/openai/v1', keyUrl: 'https://synthetic.new', desc: 'Flat-rate subscription for open models (GLM, Kimi, DeepSeek, Qwen)' },
	{ id: 'chutes', name: 'Chutes', group: 'plans', tile: { text: 'ch', bg: '#0b0b0b' }, kind: 'apiKey', catalogId: 'chutes', baseUrl: 'https://llm.chutes.ai/v1', keyUrl: 'https://chutes.ai/app/api', desc: 'Subscription tiers for open models on decentralised GPUs' },
	{ id: 'stepfun-plan', name: 'StepFun Step Plan', group: 'plans', tile: { text: 'St', bg: '#1d4ed8' }, kind: 'apiKey', catalogId: 'stepfun-ai-step-plan', baseUrl: 'https://api.stepfun.ai/step_plan/v1', desc: 'Step coding plan (global)' },
	{ id: 'volcengine-coding-plan', name: 'Volcengine Ark Coding Plan', group: 'plans', tile: { text: 'Ark', bg: '#1664ff' }, kind: 'apiKey', catalogId: 'volcengine-coding-plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', desc: 'Doubao-Seed-Code, Kimi, GLM, DeepSeek (China)' },
	{ id: 'tencent-coding-plan', name: 'Tencent Coding Plan', group: 'plans', tile: { text: 'T', bg: '#0052d9' }, kind: 'apiKey', catalogId: 'tencent-coding-plan', baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/v3', desc: 'Hunyuan, GLM, Kimi, DeepSeek (China)' },
	{ id: 'alibaba-token-plan', name: 'Alibaba Token Plan', group: 'plans', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba-token-plan', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', desc: 'Prepaid Qwen tokens at a discount' },
	{ id: 'alibaba-coding-plan-cn', name: 'Alibaba Coding Plan (China)', group: 'plans', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba-coding-plan-cn', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', desc: 'Qwen coding subscription, mainland endpoint' },
	{ id: 'alibaba-token-plan-cn', name: 'Alibaba Token Plan (China)', group: 'plans', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba-token-plan-cn', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', desc: 'Token plan, mainland endpoint' },
	{ id: 'minimax-cn-coding-plan', name: 'MiniMax Token Plan (China)', group: 'plans', tile: { text: 'M', bg: '#e8374a' }, kind: 'apiKey', catalogId: 'minimax-cn-coding-plan', baseUrl: 'https://api.minimax.cn/anthropic/v1', apiFormat: 'anthropic', desc: 'MiniMax plan on minimax.cn' },
	{ id: 'xiaomi-token-plan-cn', name: 'Xiaomi MiMo Plan (China)', group: 'plans', tile: { text: 'Mi', bg: '#ff6900' }, kind: 'apiKey', catalogId: 'xiaomi-token-plan-cn', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', desc: 'MiMo token plan, mainland endpoint' },
	{ id: 'xiaomi-token-plan-ams', name: 'Xiaomi MiMo Plan (Europe)', group: 'plans', tile: { text: 'Mi', bg: '#ff6900' }, kind: 'apiKey', catalogId: 'xiaomi-token-plan-ams', baseUrl: 'https://token-plan-ams.xiaomimimo.com/v1', desc: 'MiMo token plan, Amsterdam endpoint' },
	{ id: 'scnet-token-plan', name: 'SCNet Token Plan', group: 'plans', tile: { text: 'SC', bg: '#1e40af' }, kind: 'apiKey', catalogId: 'scnet-token-plan', baseUrl: 'https://api.scnet.cn/api/llm/v1', desc: 'DeepSeek, Kimi, MiniMax, GLM on one plan' },
	{ id: 'kuae-cloud-coding-plan', name: 'KUAE Cloud Coding Plan', group: 'plans', tile: { text: 'K', bg: '#7c2d12' }, kind: 'apiKey', catalogId: 'kuae-cloud-coding-plan', baseUrl: 'https://coding-plan-endpoint.kuaecloud.net/v1', desc: 'GLM coding plan (Moore Threads)' },
	{ id: 'umans-coding-plan', name: 'Umans AI Coding Plan', group: 'plans', tile: { text: 'U', bg: '#7c3aed' }, kind: 'apiKey', catalogId: 'umans-ai-coding-plan', baseUrl: 'https://api.code.umans.ai/v1', desc: 'Coding plan for open models' },
	{ id: 'xiaomi-token-plan', name: 'Xiaomi MiMo Plan', group: 'plans', tile: { text: 'Mi', bg: '#ff6900' }, kind: 'apiKey', catalogId: 'xiaomi-token-plan-sgp', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', desc: 'MiMo token plan' },
	// ---- API providers
	{ id: 'bedrock', name: 'AWS Bedrock', group: 'api', tile: { text: 'aws', bg: '#232f3e', fg: '#ff9900' }, kind: 'apiKey', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com', apiFormat: 'bedrock', keyUrl: 'https://console.aws.amazon.com/bedrock/home#/api-keys', desc: 'Claude on Bedrock with a Bedrock API key (set your region in the URL)' },
	{ id: 'vertex', name: 'Google Vertex AI', group: 'api', tile: { text: 'V', bg: '#4285f4' }, kind: 'apiKey', baseUrl: '', apiFormat: 'vertex', keyUrl: 'https://cloud.google.com/sdk/docs/install', desc: 'Claude & Gemini on Vertex — uses your gcloud login' },
	{ id: 'anthropic', name: 'Anthropic', group: 'api', tile: { text: 'A', bg: '#d97757' }, kind: 'apiKey', catalogId: 'anthropic', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', desc: 'Claude API' },
	{ id: 'openai', name: 'OpenAI', group: 'api', tile: { text: 'O', bg: '#0d0d0d' }, kind: 'apiKey', catalogId: 'openai', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', desc: 'GPT API' },
	{ id: 'xai', name: 'xAI', group: 'api', tile: { text: 'x', bg: '#000' }, kind: 'apiKey', catalogId: 'xai', baseUrl: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', desc: 'Grok' },
	{ id: 'deepseek', name: 'DeepSeek', group: 'api', tile: { text: 'D', bg: '#4d6bfe' }, kind: 'apiKey', catalogId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', desc: 'DeepSeek V4' },
	{ id: 'moonshot', name: 'Kimi (Moonshot)', group: 'api', tile: { text: 'K', bg: '#000' }, kind: 'apiKey', catalogId: 'moonshotai', baseUrl: 'https://api.moonshot.ai/v1', keyUrl: 'https://platform.moonshot.ai/console/api-keys', desc: 'Kimi K3 API' },
	{ id: 'zai', name: 'Z.ai API', group: 'api', tile: { text: 'Z', bg: '#111' }, kind: 'apiKey', catalogId: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4', desc: 'GLM pay-as-you-go' },
	{ id: 'zhipuai', name: 'BigModel API', group: 'api', tile: { text: 'B', bg: '#3b5bdb' }, kind: 'apiKey', catalogId: 'zhipuai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', desc: 'GLM (China)' },
	{ id: 'minimax', name: 'MiniMax', group: 'api', tile: { text: 'M', bg: '#e8374a' }, kind: 'apiKey', catalogId: 'minimax', baseUrl: 'https://api.minimax.io/anthropic/v1', apiFormat: 'anthropic', desc: 'MiniMax API' },
	{ id: 'alibaba', name: 'Alibaba Cloud', group: 'api', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', desc: 'Qwen (global)' },
	{ id: 'xiaomi', name: 'Xiaomi MiMo', group: 'api', tile: { text: 'Mi', bg: '#ff6900' }, kind: 'apiKey', catalogId: 'xiaomi', baseUrl: 'https://api.xiaomimimo.com/v1', desc: 'MiMo API' },
	{ id: 'openrouter', name: 'OpenRouter (key)', group: 'api', tile: { text: 'OR', bg: '#6566f1' }, kind: 'apiKey', catalogId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', desc: '300+ models' },
	{ id: 'mistral', name: 'Mistral', group: 'api', tile: { text: 'M', bg: '#fa520f' }, kind: 'apiKey', catalogId: 'mistral', baseUrl: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', desc: 'Mistral & Codestral' },
	{ id: 'groq', name: 'Groq', group: 'api', tile: { text: 'G', bg: '#f55036' }, kind: 'apiKey', catalogId: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', desc: 'Very fast inference' },
	{ id: 'nvidia', name: 'Nvidia NIM', group: 'api', tile: { text: 'N', bg: '#76b900', fg: '#000' }, kind: 'apiKey', catalogId: 'nvidia', baseUrl: 'https://integrate.api.nvidia.com/v1', desc: 'Free NIM endpoints' },
	{ id: 'vercel', name: 'Vercel AI Gateway', group: 'api', tile: { text: '▲', bg: '#000' }, kind: 'apiKey', catalogId: 'vercel', baseUrl: 'https://ai-gateway.vercel.sh/v1', desc: 'Gateway' },
	{ id: 'cerebras', name: 'Cerebras', group: 'api', tile: { text: 'C', bg: '#f15a29' }, kind: 'apiKey', catalogId: 'cerebras', baseUrl: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', desc: 'Fastest inference — thousands of tokens/s' },
	{ id: 'fireworks', name: 'Fireworks AI', group: 'api', tile: { text: 'F', bg: '#6720ff' }, kind: 'apiKey', catalogId: 'fireworks-ai', baseUrl: 'https://api.fireworks.ai/inference/v1', keyUrl: 'https://fireworks.ai/account/api-keys', desc: 'Fast open models' },
	{ id: 'deepinfra', name: 'DeepInfra', group: 'api', tile: { text: 'DI', bg: '#0f172a' }, kind: 'apiKey', catalogId: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai', keyUrl: 'https://deepinfra.com/dash/api_keys', desc: 'Low-cost open models' },
	{ id: 'azure', name: 'Azure OpenAI / Foundry', group: 'api', tile: { text: 'Az', bg: '#0078d4' }, kind: 'apiKey', catalogId: 'azure', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', keyUrl: 'https://ai.azure.com', desc: 'Your Azure deployment (v1 API) — set the resource name in Base URL' },
	{ id: 'perplexity', name: 'Perplexity', group: 'api', tile: { text: 'Px', bg: '#20808d' }, kind: 'apiKey', catalogId: 'perplexity', baseUrl: 'https://api.perplexity.ai', keyUrl: 'https://www.perplexity.ai/settings/api', desc: 'Sonar models with live web search' },
	{ id: 'cohere', name: 'Cohere', group: 'api', tile: { text: 'co', bg: '#39594d' }, kind: 'apiKey', catalogId: 'cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', keyUrl: 'https://dashboard.cohere.com/api-keys', desc: 'Command models (OpenAI-compatible)' },
	{ id: 'novita', name: 'Novita AI', group: 'api', tile: { text: 'N', bg: '#22c55e', fg: '#000' }, kind: 'apiKey', catalogId: 'novita-ai', baseUrl: 'https://api.novita.ai/openai', desc: 'Open models, cheap' },
	{ id: 'siliconflow', name: 'SiliconFlow', group: 'api', tile: { text: 'SF', bg: '#7c3aed' }, kind: 'apiKey', catalogId: 'siliconflow', baseUrl: 'https://api.siliconflow.com/v1', desc: 'Qwen, DeepSeek, GLM, Kimi' },
	{ id: 'nebius', name: 'Nebius Token Factory', group: 'api', tile: { text: 'Nb', bg: '#d9f99d', fg: '#000' }, kind: 'apiKey', catalogId: 'nebius', baseUrl: 'https://api.tokenfactory.nebius.com/v1', desc: 'Open models in the EU' },
	{ id: 'baseten', name: 'Baseten', group: 'api', tile: { text: 'B', bg: '#111' }, kind: 'apiKey', catalogId: 'baseten', baseUrl: 'https://inference.baseten.co/v1', desc: 'Model APIs' },
	{ id: 'inception', name: 'Inception (Mercury)', group: 'api', tile: { text: 'i', bg: '#0ea5e9' }, kind: 'apiKey', catalogId: 'inception', baseUrl: 'https://api.inceptionlabs.ai/v1', desc: 'Diffusion LLMs — very fast code edits' },
	{ id: 'requesty', name: 'Requesty', group: 'api', tile: { text: 'R', bg: '#16a34a' }, kind: 'apiKey', catalogId: 'requesty', baseUrl: 'https://router.requesty.ai/v1', desc: 'Router with fallbacks and caching' },
	{ id: 'orcarouter', name: 'OrcaRouter', group: 'api', tile: { text: 'Or', bg: '#0b1220' }, kind: 'apiKey', baseUrl: 'https://api.orcarouter.ai/v1', keyUrl: 'https://www.orcarouter.ai', desc: '200+ models, automatic routing, zero markup' },
	{ id: 'kilo-gateway', name: 'Kilo Gateway', group: 'api', tile: { text: 'K', bg: '#f8f675', fg: '#000' }, kind: 'apiKey', catalogId: 'kilo', baseUrl: 'https://api.kilo.ai/api/gateway', desc: '390+ models, one key' },
	{ id: 'together', name: 'Together AI', group: 'api', tile: { text: 'T', bg: '#0f6fff' }, kind: 'apiKey', catalogId: 'togetherai', baseUrl: 'https://api.together.xyz/v1', desc: 'Open models' },
	{ id: 'zenmux', name: 'ZenMux', group: 'api', tile: { text: 'Z', bg: '#111827' }, kind: 'apiKey', catalogId: 'zenmux', baseUrl: 'https://zenmux.ai/api/v1', keyUrl: 'https://zenmux.ai/settings/keys', desc: 'Gateway — Claude, GPT, Gemini and more' },
	{ id: '302ai', name: '302.AI', group: 'api', tile: { text: '302', bg: '#7c3aed' }, kind: 'apiKey', catalogId: '302ai', baseUrl: 'https://api.302.ai/v1', desc: 'Gateway — 120+ models' },
	{ id: 'cortecs', name: 'Cortecs', group: 'api', tile: { text: 'Co', bg: '#0f766e' }, kind: 'apiKey', catalogId: 'cortecs', baseUrl: 'https://api.cortecs.ai/v1', desc: 'EU-hosted gateway' },
	{ id: 'helicone', name: 'Helicone AI Gateway', group: 'api', tile: { text: 'H', bg: '#0ea5e9' }, kind: 'apiKey', catalogId: 'helicone', baseUrl: 'https://ai-gateway.helicone.ai/v1', desc: 'Gateway with observability' },
	{ id: 'digitalocean', name: 'DigitalOcean', group: 'api', tile: { text: 'DO', bg: '#0069ff' }, kind: 'apiKey', catalogId: 'digitalocean', baseUrl: 'https://inference.do-ai.run/v1', desc: 'Gradient serverless inference' },
	{ id: 'wandb', name: 'CoreWeave (W&B)', group: 'api', tile: { text: 'W', bg: '#1f2937' }, kind: 'apiKey', catalogId: 'wandb', baseUrl: 'https://api.inference.wandb.ai/v1', desc: 'Open models on CoreWeave' },
	{ id: 'nearai', name: 'NEAR AI Cloud', group: 'api', tile: { text: 'N', bg: '#00ec97', fg: '#000' }, kind: 'apiKey', catalogId: 'nearai', baseUrl: 'https://cloud-api.near.ai/v1', desc: 'Private inference in secure enclaves' },
	{ id: 'abacus', name: 'Abacus RouteLLM', group: 'api', tile: { text: 'Ab', bg: '#111' }, kind: 'apiKey', catalogId: 'abacus', baseUrl: 'https://routellm.abacus.ai/v1', desc: 'Gateway — 100+ models' },
	{ id: 'fastrouter', name: 'FastRouter', group: 'api', tile: { text: 'F', bg: '#b91c1c' }, kind: 'apiKey', catalogId: 'fastrouter', baseUrl: 'https://go.fastrouter.ai/api/v1', desc: 'Gateway' },
	{ id: 'siliconflow-cn', name: 'SiliconFlow (China)', group: 'api', tile: { text: 'S', bg: '#6d28d9' }, kind: 'apiKey', catalogId: 'siliconflow-cn', baseUrl: 'https://api.siliconflow.cn/v1', desc: 'Open models, mainland endpoint' },
	{ id: 'alibaba-cn', name: 'Alibaba Cloud (China)', group: 'api', tile: { text: 'Q', bg: '#ff6a00' }, kind: 'apiKey', catalogId: 'alibaba-cn', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', desc: 'Qwen pay-as-you-go, mainland endpoint' },
	{ id: 'tencent-tokenhub', name: 'Tencent TokenHub', group: 'api', tile: { text: 'T', bg: '#0052d9' }, kind: 'apiKey', catalogId: 'tencent-tokenhub', baseUrl: 'https://tokenhub.tencentmaas.com/v1', desc: 'Hunyuan and open models' },
	{ id: 'qiniu-ai', name: 'Qiniu AI', group: 'api', tile: { text: 'Qn', bg: '#1296db' }, kind: 'apiKey', catalogId: 'qiniu-ai', baseUrl: 'https://api.qnaigc.com/v1', desc: 'Gateway — 90 models' },
	// ---- local
	{
		id: 'zer0ne-engine', name: 'zer0ne Engine', group: 'local', tile: { text: '0', bg: '#f7931e', fg: '#0b0b0d' }, kind: 'info', desc: 'Built-in llama.cpp — Hugging Face models, no service',
		info: 'zer0ne Engine runs GGUF models with llama.cpp built into the extension. Open Settings → Local models: install the engine under Runtimes, then download a model from Discover — it appears in the model picker automatically.',
		suggest: ['ollama', 'lmstudio']
	},
	{ id: 'ollama', name: 'Ollama', group: 'local', tile: { text: 'O', bg: '#fff', fg: '#000' }, kind: 'apiKey', baseUrl: 'http://localhost:11434/v1', desc: 'Local models, no key' },
	{ id: 'llamacpp-server', name: 'llama.cpp server', group: 'local', tile: { text: 'll', bg: '#1f2937' }, kind: 'apiKey', baseUrl: 'http://127.0.0.1:8080/v1', desc: 'Your own llama-server, no key' },
	{ id: 'vllm', name: 'vLLM', group: 'local', tile: { text: 'v', bg: '#fdb515', fg: '#000' }, kind: 'apiKey', baseUrl: 'http://127.0.0.1:8000/v1', desc: 'High-throughput server (GPU)' },
	{ id: 'jan', name: 'Jan', group: 'local', tile: { text: 'J', bg: '#000' }, kind: 'apiKey', baseUrl: 'http://127.0.0.1:1337/v1', desc: 'Jan desktop app server' },
	{ id: 'litellm', name: 'LiteLLM proxy', group: 'local', tile: { text: 'L', bg: '#4338ca' }, kind: 'apiKey', baseUrl: 'http://127.0.0.1:4000/v1', desc: 'Your LiteLLM gateway' },
	{ id: 'lmstudio', name: 'LM Studio', group: 'local', tile: { text: 'LM', bg: '#4f46e5' }, kind: 'apiKey', catalogId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', desc: 'Local server, no key' },
	// ---- custom
	{ id: 'custom', name: 'Custom', group: 'custom', tile: { text: '+', bg: '#2a2a2a' }, kind: 'apiKey', apiFormat: 'openai', desc: 'Any endpoint — set the base URL, key and API format (OpenAI or Anthropic) inside' },
	{ id: 'custom-openai', name: 'Custom', group: 'legacy', tile: { text: '+', bg: '#2a2a2a' }, kind: 'apiKey', apiFormat: 'openai', desc: '' },
	{ id: 'custom-anthropic', name: 'Custom', group: 'legacy', tile: { text: '+', bg: '#2a2a2a' }, kind: 'apiKey', apiFormat: 'anthropic', desc: '' }
];

export function presetById(id: string | undefined): Preset | undefined {
	return PRESETS.find((p) => p.id === id);
}
