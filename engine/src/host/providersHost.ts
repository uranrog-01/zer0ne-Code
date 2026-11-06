import * as vscode from 'vscode';
import { fetchModels, streamChat, testModel } from '../chatClient';
import { listLmModels, streamLm } from '../lmClient';
import type { ModelCatalog } from '../modelCatalog';
import { signInWithOpenRouter } from '../oauth';
import { PRESETS, presetById } from '../presets';
import { ACCOUNTS, type AccountKind, accountModels, checkAccount, signIn, revokeAccount } from '../accounts';
import { type ModelEntry, type ProviderConfig, accountProblem, normalizeModel } from '../providerStore';
import { applyModelRecommendation, modelSettingsError } from '../modelSettings';
import { HostContext, HostFeature, HostSurface } from './context';
import { insecureRemote } from '../netSafety';
import { isDesktopHost } from './capabilities';

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

/** Local servers, VS Code models and cloud logins (gcloud / AWS) need no pasted key. */
export function keyOptional(p: { baseUrl?: string; apiFormat?: string; auth?: string }): boolean {
	return p.apiFormat === 'vscode-lm' || p.apiFormat === 'acp' || p.apiFormat === 'vertex' || p.apiFormat === 'bedrock' || p.auth === 'vscode' || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(p.baseUrl ?? '');
}

/** A custom endpoint speaks one of the two common APIs (Gemini, Bedrock and Vertex have their own cards). */
const CUSTOM_FORMATS = ['openai', 'responses', 'anthropic', 'gemini'] as const;

/** Huge gateway model lists: which fetched models start out enabled, so the chat menu stays usable. */
const FLAGSHIP = /gpt-4|gpt-5|claude-|gemini-\d|grok-\d|deepseek|kimi-k\d|glm-\d|qwen|minimax-m\d|llama-\d|mistral-\d/i;

/** The Custom provider form, checked: an error message, or what to create (pure; tested). */
export function customProviderInput(raw: { [k: string]: unknown }): string | { name: string; baseUrl: string; apiFormat: (typeof CUSTOM_FORMATS)[number]; apiKey: string; models: ModelEntry[]; smart: boolean } {
	const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
	const baseUrl = str(raw.baseUrl).replace(/\/+$/, '');
	const apiFormat = CUSTOM_FORMATS.find((f) => f === raw.apiFormat) ?? 'openai';
	const apiKey = str(raw.apiKey);
	if (!baseUrl) return 'Enter the base URL.';
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return 'The base URL is not a valid address (it starts with https://).';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The base URL must start with https:// (or http:// for a local server).';
	if (apiKey && insecureRemote(baseUrl)) return 'Plain http:// to a public host would send your API key unencrypted — use https://.';
	if (!apiKey && !keyOptional({ baseUrl, apiFormat })) return 'Paste the API key (a local server on localhost needs none).';
	const incoming = Array.isArray(raw.models) ? raw.models : str(raw.models).split(/[\s,]+/).filter(Boolean).map((id) => ({ id, smart: raw.smart !== false }));
	const models: ModelEntry[] = [];
	const known = new Set<string>();
	for (const item of incoming) {
		const model = normalizeModel(item);
		if (!model || known.has(model.id)) continue;
		const error = modelSettingsError(item);
		if (error) return error;
		known.add(model.id);
		models.push(model);
		if (models.length >= 100) break;
	}
	const name = str(raw.name).slice(0, 60) || url.hostname.replace(/^(api|www)\./, '');
	return { name, baseUrl, apiFormat, apiKey, models, smart: raw.smart !== false };
}

/**
 * Settings → Providers & models: add providers (presets, catalog, OpenRouter
 * sign-in, VS Code models), keys, model lists, fetch and test. Split out of
 * ChatController; everything here talks to the store and the catalog only.
 */
const GITHUB_MODELS_URL = 'https://models.github.ai/inference';
const GITHUB_MODELS_RETIRED = 'GitHub Models retired on July 30, 2026. Connect GitHub Copilot through its official agent, or use another API provider. Copilot is a separate service.';

/** GitHub Models catalog → chat models (text out, not embeddings). */
async function githubModelsCatalog(token: string): Promise<Array<{ id: string; contextWindow?: number; maxOutput?: number; tools?: boolean }>> {
	throw new Error(GITHUB_MODELS_RETIRED);
}

export class ProvidersHost implements HostFeature {
	/** The sign-in in progress (one at a time). */
	private signing?: AbortController;

	constructor(
		private readonly ctx: HostContext,
		private readonly catalog: ModelCatalog
	) {}

	dispose(): void {
		this.signing?.abort();
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		switch (msg.type) {
			case 'addPreset':
				await this.addPreset(surface, String(msg.presetId), msg.catalogId, typeof msg.apiKey === 'string' ? msg.apiKey.trim() : '', typeof msg.baseUrl === 'string' ? msg.baseUrl.trim() : undefined);
				return true;
			case 'setupKey':
				await this.setupKey(surface, msg);
				return true;
			case 'addCustom':
				await this.addCustom(surface, msg);
				return true;
			case 'updateProvider':
				// The host is the authority (the phone and other surfaces skip the settings page's own check).
				if (typeof msg.patch?.baseUrl === 'string' && insecureRemote(msg.patch.baseUrl.trim()) && (await this.ctx.store.getApiKey(String(msg.id)))) {
					throw new Error('Plain http:// to a public host would send your API key unencrypted — use https://.');
				}
				await this.ctx.store.update(String(msg.id), msg.patch ?? {});
				await this.ctx.sendState();
				return true;
			case 'setApiKey': {
				const saved = String(msg.apiKey ?? '').trim();
				await this.ctx.store.setApiKey(String(msg.id), saved);
				// A new key: the old failure no longer describes it (the next answer decides the dot).
				await this.ctx.store.update(String(msg.id), { health: undefined }).catch(() => undefined);
				this.ctx.status(saved ? 'API key saved to the OS keychain.' : 'API key removed.');
				await this.ctx.sendState();
				// A key that arrives after the provider was created still fills the chat menu.
				const withKey = await this.ctx.store.get(String(msg.id));
				if (saved && withKey && withKey.apiFormat !== 'vscode-lm' && withKey.auth !== 'account') {
					await this.fetchModelsFor(surface, withKey.id, true);
				}
				return true;
			}
			case 'signInOpenRouter':
				await this.openRouterSignIn(surface, typeof msg.id === 'string' ? msg.id : undefined);
				return true;
			case 'accountSignIn':
				await this.accountSignIn(surface, String(msg.account) as AccountKind, msg.method === 'device' ? 'device' : 'browser', typeof msg.id === 'string' ? msg.id : undefined, typeof msg.requestId === 'string' ? msg.requestId : undefined, msg.newAccount === true);
				return true;
			case 'cancelSignIn':
				this.signing?.abort();
				return true;
			case 'accountSignOut': {
				const provider = await this.requireProvider(String(msg.id));
				await this.ctx.store.update(provider.id, { enabled: false, health: undefined });
				const revoked = await this.ctx.store.signOutAccount(provider.id, (cred) => revokeAccount(cred, AbortSignal.timeout(15_000)));
				this.ctx.status(`Signed out of ${provider.name}. Its models stay listed — sign in again to use them.${revoked && !revoked.confirmed ? ' ' + revoked.message : ''}`);
				await this.ctx.sendState();
				return true;
			}
			case 'deleteProvider': {
				const provider = await this.ctx.store.get(String(msg.id));
				await this.ctx.store.delete(String(msg.id));
				this.ctx.status(`Deleted ${provider?.name ?? 'provider'}.`);
				await this.ctx.sendState();
				return true;
			}
			case 'fetchModels':
				await this.requireKey(await this.requireProvider(String(msg.id)));
				await this.fetchModelsFor(surface, String(msg.id));
				return true;
			case 'addModels': {
				let count = 0;
				const provider = await this.ctx.store.update(String(msg.id), async provider => {
					await this.requireKey(provider);
					const incoming: Array<{ id: string; contextWindow?: number; name?: string; note?: string; reasoningControl?: import('../reasoning').ReasoningControl }> = Array.isArray(msg.models) ? msg.models : [];
					const known = new Set(provider.models.map((m) => m.id));
					const enable = new Set(incoming.filter(m => typeof m?.id === 'string').map(m => m.id.trim()));
					const added: ModelEntry[] = [];
					for (const m of incoming) {
						if (typeof m?.id === 'string' && m.id.trim() && !known.has(m.id)) {
							const label = { name: typeof m.name === 'string' && m.name !== m.id ? m.name : undefined, note: typeof m.note === 'string' ? m.note : undefined, reasoningControl: m.reasoningControl };
							// A plan agent's models are its own names for its own backends: no catalog limits to look up.
							added.push(provider.apiFormat === 'acp' ? { id: m.id.trim(), enabled: true, smart: false, tools: true, ...label } : { ...(await this.smartEntry({ id: m.id.trim(), enabled: true, smart: true, contextWindow: m.contextWindow }, provider)), ...label });
							known.add(m.id.trim());
						}
					}
					const models = provider.apiFormat === 'acp' ? provider.models.map(m => enable.has(m.id) ? { ...m, enabled: true } : m) : provider.models;
					count = provider.apiFormat === 'acp' ? added.length + provider.models.filter(m => enable.has(m.id) && !m.enabled).length : added.length;
					return { models: [...models, ...added] };
				});
				this.ctx.status(`${provider.apiFormat === 'acp' ? 'Enabled' : 'Added'} ${count} model${count === 1 ? '' : 's'}.`);
				await this.ctx.sendState();
				return true;
			}
			case 'saveModel': {
				const provider = await this.requireProvider(String(msg.id));
				if (typeof msg.originalId !== 'string') await this.requireKey(provider); // editing an existing model stays possible
				const error = modelSettingsError(msg.model);
				if (error) throw new Error(error);
				let entry = normalizeModel(msg.model);
				if (!entry) throw new Error('Enter a model ID.');
				if (entry?.smart) {
					entry = await this.smartEntry(entry, provider);
				}
				await this.ctx.store.upsertModel(provider.id, entry, typeof msg.originalId === 'string' ? msg.originalId : undefined);
				this.ctx.status(`Saved ${entry.id}.`);
				await this.ctx.sendState();
				return true;
			}
			case 'deleteModel':
				await this.ctx.store.removeModel(String(msg.id), String(msg.modelId));
				await this.ctx.sendState();
				return true;
			case 'setModelsEnabled': {
				// Bulk on/off for the filtered model list.
				await this.ctx.store.update(String(msg.id), provider => {
					const ids = new Set<string>(Array.isArray(msg.ids) ? msg.ids.map(String) : provider.models.map((m) => m.id));
					return { models: provider.models.map((m) => (ids.has(m.id) ? { ...m, enabled: msg.enabled === true } : m)) };
				});
				await this.ctx.sendState();
				return true;
			}
			case 'duplicateProvider': {
				const copy = await this.ctx.store.duplicate(String(msg.id));
				this.ctx.status(`Created ${copy.name}.${copy.auth === 'account' ? ' Sign in to connect the copy.' : ''}`);
				await this.ctx.sendState();
				surface.post({ type: 'focusProvider', id: copy.id });
				return true;
			}
			case 'checkProvider': {
				// Account checks send a small test; API checks only read the model list.
				const provider = await this.requireProvider(String(msg.id));
				const started = Date.now();
				// Modern plan sessions renew only when needed; legacy checks can rotate their token.
				if (provider.auth === 'account') {
					try {
						const cred = await this.ctx.store.getAccountCredential(provider.id);
						if (!cred) throw new Error('Not signed in — sign in first.');
						const r = await checkAccount(cred, (o) => streamChat(o), AbortSignal.timeout(120_000));
						if (r.refreshed) {
							const current = await this.ctx.store.getAccountCredential(provider.id);
							if (current?.refresh === cred.refresh) await this.ctx.store.setAccount(provider.id, r.refreshed);
						}
						const error = r.steps.find((s) => !s.ok)?.text;
						await this.ctx.store.update(provider.id, { health: { ok: r.ok, at: Date.now(), ...(r.ok ? {} : { error, signIn: accountProblem(error ?? '') }) } });
						await this.ctx.sendState();
						surface.post({ type: 'providerCheck', id: provider.id, ok: r.ok, ms: Date.now() - started, steps: r.steps, error: r.ok ? undefined : r.steps.find((s) => !s.ok)?.text });
					} catch (e) {
						const error = e instanceof Error ? e.message : String(e);
						await this.ctx.store.update(provider.id, { health: { ok: false, at: Date.now(), error, signIn: accountProblem(error) } });
						await this.ctx.sendState();
						surface.post({ type: 'providerCheck', id: provider.id, ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
					}
					return true;
				}
				try {
					const models = provider.baseUrl.startsWith(GITHUB_MODELS_URL) ? await githubModelsCatalog('') : provider.apiFormat === 'vscode-lm' ? await listLmModels() : await fetchModels(provider.baseUrl, (await this.ctx.store.getApiKey(provider.id)) ?? '', provider.apiFormat);
					surface.post({ type: 'providerCheck', id: provider.id, ok: true, ms: Date.now() - started, count: models.length });
				} catch (e) {
					surface.post({ type: 'providerCheck', id: provider.id, ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'refreshModelInfo': {
				// Re-read limits, capabilities and prices from the models.dev catalog.
				await this.catalog.all(true);
				const provider = await this.ctx.store.update(String(msg.id), async current => ({ models: await Promise.all(current.models.map((m) => (m.smart ? this.smartEntry(m, current) : m))) }));
				this.ctx.status(`Updated model info for ${provider.name}.`);
				await this.ctx.sendState();
				return true;
			}
			case 'toggleModel': {
				await this.ctx.store.update(String(msg.id), provider => ({
					models: provider.models.map((m) => (m.id === msg.modelId ? { ...m, enabled: msg.enabled === true } : m))
				}));
				await this.ctx.sendState();
				return true;
			}
			case 'testModelTools': {
                const provider = await this.requireProvider(String(msg.id)), model = provider.models.find(m => m.id === msg.modelId);
                if (!model || provider.apiFormat === 'acp' || provider.apiFormat === 'vscode-lm') throw new Error('Select an API or local model for this test.');
                const at = Date.now(); let check: { ok: boolean; at: number; scope: string; ms?: number; error?: string };
                try {
                    const result = await streamChat({ baseUrl: provider.baseUrl, apiKey: (await this.ctx.store.getApiKey(provider.id)) ?? '', apiFormat: provider.apiFormat, model: model.id, chatgptPlan: provider.auth === 'account' && provider.preset === 'chatgpt-account', system: 'Call capability_probe with value equal to ok. Do not answer in text.', messages: [{ role: 'user', content: 'Test the tool interface now.' }], tools: [{ name: 'capability_probe', description: 'A harmless test. This tool is never executed.', parameters: { type: 'object', properties: { value: { type: 'string', enum: ['ok'] } }, required: ['value'], additionalProperties: false } }], maxTokens: 256, signal: AbortSignal.timeout(45000) });
                    const call = result.toolCalls.find(c => c.name === 'capability_probe');
                    if (!call || JSON.parse(call.arguments).value !== 'ok') throw new Error('The model did not return the requested valid tool call.');
                    check = { ok: true, at, scope: 'tool call', ms: Date.now() - at };
                } catch (e) { check = { ok: false, at, scope: 'tool call', error: e instanceof Error ? e.message : String(e) }; }
                await this.ctx.store.saveModelCheck(provider.id + '::' + model.id + '::tools', check);
                this.ctx.status(check.ok ? 'Tool-call test passed; no tool was executed.' : check.error!, check.ok ? 'ok' : 'error'); await this.ctx.sendState(); return true;
            }
            case 'testModel':
				await this.testModelFor(surface, String(msg.id), String(msg.modelId));
				return true;
			case 'lookupModel': {
				const provider = await this.ctx.store.get(String(msg.id));
				const endpoint = provider ?? { baseUrl: typeof msg.baseUrl === 'string' ? msg.baseUrl.trim() : '', apiFormat: typeof msg.apiFormat === 'string' ? msg.apiFormat : '' };
				const hit = await this.catalog.lookup(String(msg.modelId ?? ''), provider?.catalogId, endpoint);
				surface.post({ type: 'lookupResult', requestId: msg.requestId, model: hit ?? null });
				return true;
			}
			case 'searchCatalog':
				surface.post({ type: 'catalogResults', items: await this.catalog.search(String(msg.query ?? '')) });
				return true;
			case 'refreshCatalog':
				await this.catalog.all(true);
				surface.post({ type: 'catalogResults', items: await this.catalog.search('') });
				this.ctx.status('Provider catalog refreshed from models.dev.');
				return true;
		}
		return false;
	}

	private async smartEntry(entry: ModelEntry, provider?: { catalogId?: string; baseUrl?: string; apiFormat?: string }): Promise<ModelEntry> {
		if (!entry.smart) {
			return entry;
		}
		const hit = await this.catalog.lookup(entry.id, provider?.catalogId, provider);
		return applyModelRecommendation(entry, hit);
	}

	/** No models without a saved key (remote providers only). */
	private async requireKey(provider: ProviderConfig): Promise<ProviderConfig> {
		if (keyOptional(provider) || (await this.ctx.store.getApiKey(provider.id))) return provider;
		throw new Error(`Save the API key for ${provider.name} first — models can be added once it is saved.`);
	}

	private async requireProvider(id: string): Promise<ProviderConfig> {
		const provider = await this.ctx.store.get(id);
		if (!provider) {
			throw new Error('That provider no longer exists.');
		}
		return provider;
	}

	/**
	 * First-run setup's key path: check the key against the provider first, and
	 * only then write the provider. A wrong key leaves no half-configured
	 * provider behind (Settings' own flow adds first and reports by status).
	 */
	private async setupKey(surface: HostSurface, msg: { [k: string]: any }): Promise<void> {
		const preset = presetById(String(msg.presetId ?? ''));
		const apiKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim().slice(0, 500) : '';
		if (!preset || preset.kind !== 'apiKey' || !preset.baseUrl) {
			surface.post({ type: 'setupKeyResult', ok: false, error: 'Choose a provider from the list.' });
			return;
		}
		if (!apiKey) {
			surface.post({ type: 'setupKeyResult', ok: false, error: `Paste the API key for ${preset.name}.` });
			return;
		}
		if (insecureRemote(preset.baseUrl)) {
			surface.post({ type: 'setupKeyResult', ok: false, error: 'Plain http:// to a public host would send your API key unencrypted — use https://.' });
			return;
		}
		try {
			const models = await fetchModels(preset.baseUrl, apiKey, preset.apiFormat ?? 'openai');
			if (!models.length) throw new Error('The provider answered with no models.');
			await this.addPreset(surface, preset.id, undefined, apiKey);
			const provider = (await this.ctx.store.list()).find((p) => p.preset === preset.id);
			surface.post({ type: 'setupKeyResult', ok: true, providerId: provider?.id, models: models.length });
		} catch (e) {
			surface.post({ type: 'setupKeyResult', ok: false, error: e instanceof Error ? e.message : String(e) });
		}
	}

	private async addPreset(surface: HostSurface, presetId: string, catalogId?: string, apiKey = '', baseUrl?: string): Promise<void> {
		// Catalog search results ("browse all") come in without a preset.
		if (presetId === 'catalog' && typeof catalogId === 'string') {
			const entry = await this.catalog.get(catalogId);
			if (!entry) {
				throw new Error('Catalog entry not found — refresh the catalog and try again.');
			}
			const url = entry.baseUrl || baseUrl || '';
			if (!apiKey && !keyOptional({ baseUrl: url, apiFormat: entry.apiFormat })) throw new Error(`Paste the API key for ${entry.name} to add it.`);
			const created = await this.createFromCatalog(surface, entry.name, entry.id, url, entry.apiFormat, undefined, apiKey);
			// Connect-and-go: the endpoint's list lands in the provider (the catalog's models stay for what it omits).
			if (apiKey) await this.fetchModelsFor(surface, created.id, true);
			return;
		}
		const preset = presetById(presetId);
		if (!preset) {
			throw new Error('Unknown provider preset.');
		}
		if (preset.kind === 'vscode-lm') {
			if (isDesktopHost()) throw new Error('In the desktop app, connect GitHub Copilot with its official agent under Plans & subscriptions. VS Code language models require the VS Code extension.');
			let models: Awaited<ReturnType<typeof listLmModels>> = [];
			try {
				models = await listLmModels();
			} catch (error) {
				throw new Error(error instanceof Error ? error.message : String(error));
			}
			const created = await this.ctx.store.add({
				name: preset.name,
				baseUrl: 'vscode-lm',
				apiFormat: 'vscode-lm',
				auth: 'vscode',
				preset: preset.id,
				models: models.map((m) => ({ id: m.id, enabled: true, smart: false, contextWindow: m.contextWindow, tools: true }))
			});
			this.ctx.status(
				models.length
					? `Connected ${models.length} models from VS Code (${[...new Set(models.map((m) => m.vendor))].join(', ')}). VS Code asks for consent on first use.`
					: 'No VS Code language models found — sign in to GitHub Copilot in VS Code, then press Fetch models.',
				models.length ? 'ok' : ''
			);
			await this.selectIfNone(created);
			await this.ctx.sendState();
			surface.post({ type: 'focusProvider', id: created.id });
			return;
		}
		if (preset.kind === 'oauth-openrouter') {
			await this.openRouterSignIn(surface);
			return;
		}
		if (preset.kind === 'oauth-github') {
			await this.githubModelsSignIn(surface);
			return;
		}
		if (preset.kind === 'account' && preset.account) {
			await this.accountSignIn(surface, preset.account, 'browser');
			return;
		}
		if (preset.kind === 'info') {
			return;
		}
		const url = preset.baseUrl || baseUrl || '';
		if (!apiKey && !keyOptional({ baseUrl: url, apiFormat: preset.apiFormat })) throw new Error(`Paste the API key for ${preset.name} to add it.`);
		if (apiKey && insecureRemote(url)) throw new Error('Plain http:// to a public host would send your API key unencrypted — use https://.');
		const existing = (await this.ctx.store.list()).find((p) => p.preset === preset.id && p.auth !== 'account' && p.apiFormat !== 'acp');
		if (existing && apiKey) {
			await this.ctx.store.setApiKey(existing.id, apiKey);
			await this.ctx.store.update(existing.id, { health: undefined });
			await this.ctx.sendState();
			surface.post({ type: 'focusProvider', id: existing.id });
			await this.fetchModelsFor(surface, existing.id, true);
			return;
		}
		const created = await this.createFromCatalog(surface, preset.name, preset.catalogId, url, preset.apiFormat, preset.id, apiKey);
		// With a key the endpoint's live list fills the provider: a stale or missing
		// models.dev entry (plan endpoints drift from it) can never leave it empty.
		if (apiKey && created.baseUrl) await this.fetchModelsFor(surface, created.id, true);
	}

	private async createFromCatalog(surface: HostSurface, name: string, catalogId?: string, baseUrl?: string, apiFormat?: ProviderConfig['apiFormat'], presetId?: string, apiKey = ''): Promise<ProviderConfig> {
		const entry = catalogId ? await this.catalog.get(catalogId) : undefined;
		const models =
			entry && entry.models.length <= 40
				? entry.models
						.filter((m) => m.tools !== false || entry.models.length < 10)
						.map((m) => ({ id: m.id, enabled: true, smart: true, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision, tools: m.tools === false ? false : undefined }))
				: [];
		const created = await this.ctx.store.add({
			name,
			baseUrl: baseUrl || entry?.baseUrl || '',
			apiFormat: apiFormat ?? entry?.apiFormat ?? 'openai',
			catalogId: entry?.id ?? catalogId,
			preset: presetId,
			models
		});
		if (apiKey) await this.ctx.store.setApiKey(created.id, apiKey);
		const local = keyOptional({ baseUrl: created.baseUrl });
		this.ctx.status(
			created.baseUrl
				? `Added ${name}${models.length ? ` with ${models.length} models` : ''}. ${local ? 'Press Fetch models to list your local models.' : apiKey ? 'Key saved to the OS keychain.' : 'Paste your API key to finish.'}`
				: `Added ${name}. Enter its Base URL and API key.`
		);
		await this.selectIfNone(created);
		await this.ctx.sendState();
		surface.post({ type: 'focusProvider', id: created.id });
		return created;
	}

	/** Settings → Add provider → Custom: the whole form at once (name, format, URL, key, optional model IDs), then the endpoint's model list. */
	private async addCustom(surface: HostSurface, msg: { [k: string]: any }): Promise<void> {
		const custom = customProviderInput(msg);
		if (typeof custom === 'string') throw new Error(custom);
		const created = await this.ctx.store.add({
			name: custom.name,
			baseUrl: custom.baseUrl,
			apiFormat: custom.apiFormat,
			preset: 'custom',
			// Smart configuration: context window, output limit and capabilities come from the catalog (and follow its updates) until edited by hand.
			models: await Promise.all(custom.models.map((model) => this.smartEntry(model, custom)))
		});
		if (custom.apiKey) await this.ctx.store.setApiKey(created.id, custom.apiKey);
		this.ctx.status(`Added ${custom.name}.${custom.apiKey ? ' Key saved to the OS keychain.' : ''}`, 'ok');
		await this.selectIfNone(created);
		await this.ctx.sendState();
		surface.post({ type: 'focusProvider', id: created.id });
		if (custom.apiKey || keyOptional(created)) await this.fetchModelsFor(surface, created.id, true);
	}

	private async selectIfNone(created: ProviderConfig): Promise<void> {
		const selection = await this.ctx.store.resolveSelection();
		const model = created.models.find((m) => m.enabled);
		if (!selection.model && model) {
			await this.ctx.store.setSelection(created.id, model.id);
		}
	}

	private async openRouterSignIn(surface: HostSurface, existingId?: string): Promise<void> {
		this.signing?.abort();
		const ctl = this.signing = new AbortController();
		try {
		this.ctx.status('Opening OpenRouter in your browser — approve access to finish signing in…', '');
		const key = await signInWithOpenRouter((url) => vscode.env.openExternal(vscode.Uri.parse(url)), ctl.signal);
		const all = await this.ctx.store.list();
		if (ctl.signal.aborted) return;
		let provider = existingId ? all.find((p) => p.id === existingId) : all.find((p) => p.preset === 'openrouter-oauth');
		if (existingId && (!provider || !(provider.catalogId === 'openrouter' || provider.preset === 'openrouter-oauth' || provider.preset === 'openrouter'))) throw new Error('Choose an OpenRouter provider to reconnect.');
		if (!provider) {
			provider = await this.createFromCatalog(surface, 'OpenRouter', 'openrouter', 'https://openrouter.ai/api/v1', 'openai', 'openrouter-oauth');
		}
		if (ctl.signal.aborted) return;
		await this.ctx.store.update(provider.id, { auth: 'oauth', preset: 'openrouter-oauth', baseUrl: 'https://openrouter.ai/api/v1', apiFormat: 'openai', health: undefined });
		if (ctl.signal.aborted) return;
		await this.ctx.store.setApiKey(provider.id, key);
		this.ctx.status('Signed in to OpenRouter ✓ — the models are loading.', 'ok');
		await this.ctx.sendState();
		await this.fetchModelsFor(surface, provider.id, true);
		} finally {
			if (this.signing === ctl) this.signing = undefined;
		}
	}

	/**
	 * GitHub Models with the GitHub account already signed in to VS Code (the
	 * same OAuth token the `gh models` CLI uses). No key to copy.
	 */
	private async githubModelsSignIn(surface: HostSurface): Promise<void> {
		throw new Error(GITHUB_MODELS_RETIRED);
	}

	/**
	 * "Sign in with an account": runs the vendor's OAuth (browser or device
	 * code), then creates — or re-connects — the provider with the account's
	 * models. The webview follows along through `accountSignIn` events.
	 */
	private async accountSignIn(surface: HostSurface, account: AccountKind, method: 'browser' | 'device', existingId?: string, requestId?: string, newAccount = false): Promise<void> {
		const spec = ACCOUNTS[account];
		if (!spec) throw new Error('Unknown account type.');
		const preset = PRESETS.find((p) => p.kind === 'account' && p.account === account);
		this.signing?.abort();
		const ctl = (this.signing = new AbortController());
		const say = (m: Record<string, unknown>) => surface.post({ type: 'accountSignIn', account, requestId, ...m });
		say({ stage: 'starting', method });
		try {
			const allBefore = await this.ctx.store.list();
			const previousProvider = existingId ? allBefore.find((p) => p.id === existingId) : newAccount ? undefined : allBefore.find((p) => p.auth === 'account' && p.preset === preset?.id);
			if (existingId && (!previousProvider || previousProvider.preset !== preset?.id)) throw new Error('Choose the matching account provider to reconnect.');
			const previous = previousProvider ? await this.ctx.store.getAccountForSignIn(previousProvider.id) : undefined;
			const cred = await signIn(account, {
				method,
				hostId: await this.ctx.store.accountHostId(),
				previous,
				signal: ctl.signal,
				open: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
				onEvent: (e) => say({ ...e })
			});
			say({ stage: 'models' });
			const models = await accountModels(cred, ctl.signal);
			const all = await this.ctx.store.list();
			if (ctl.signal.aborted) throw new Error('Sign-in cancelled.');
			let provider = existingId ? all.find((p) => p.id === existingId) : newAccount ? undefined : all.find((p) => p.auth === 'account' && p.preset === preset?.id);
			const entries = models.map((m) => ({ id: m.id, name: m.name, enabled: true, smart: false, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision, reasoning: m.reasoning, reasoningControl: m.reasoningControl, tools: true }));
			if (provider) {
				// Re-connect: keep the user's on/off choices, add what is new.
				const known = new Map(provider.models.map((m) => [m.id, m]));
				await this.ctx.store.update(provider.id, { auth: 'account', enabled: true, baseUrl: spec.baseUrl, apiFormat: spec.apiFormat, health: undefined, models: entries.map((e) => (known.has(e.id) ? { ...e, enabled: known.get(e.id)!.enabled } : e)) });
			} else {
				const label = `${preset?.name ?? spec.name}${cred.email ? ' · ' + cred.email : ''}${cred.clientId ? ' · ' + cred.clientId.slice(-6) : ''}`;
				provider = await this.ctx.store.add({ name: label, baseUrl: spec.baseUrl, apiFormat: spec.apiFormat, auth: 'account', preset: preset?.id, models: entries });
			}
			if (ctl.signal.aborted) throw new Error('Sign-in cancelled.');
			await this.ctx.store.setAccount(provider.id, cred);
			await this.selectIfNone({ ...provider, models: entries });
			say({ stage: 'done', providerId: provider.id, email: cred.email, plan: cred.plan, count: entries.length });
			this.ctx.status(`Signed in to ${preset?.name ?? spec.name}${cred.email ? ' as ' + cred.email : ''} ✓ — ${entries.length} models ready.`, 'ok');
			await this.ctx.sendState();
			surface.post({ type: 'focusProvider', id: provider.id });
		} catch (e) {
			const cancelled = ctl.signal.aborted;
			say({ stage: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : e instanceof Error ? e.message : String(e) });
		} finally {
			if (this.signing === ctl) this.signing = undefined;
		}
	}

	/** An account provider's model list, read with its current token. */
	private async accountModelList(provider: ProviderConfig): Promise<Array<{ id: string; contextWindow?: number }>> {
		const cred = await this.ctx.store.getAccountCredential(provider.id);
		if (!cred) throw new Error(`Sign in to ${provider.name} first.`);
		return accountModels(cred);
	}

	/**
	 * Read the endpoint's model list with its current credential. `auto`
	 * fills the provider directly — connecting a subscription or saving a
	 * key puts models straight into the chat menu (a failed or empty list
	 * becomes a status message, never a dead end). A manual Fetch models
	 * press keeps the pick dialog for curating by hand.
	 */
	private async fetchModelsFor(surface: HostSurface, providerId: string, auto = false): Promise<void> {
		const provider = await this.requireProvider(providerId);
		let models: Array<{ id: string; contextWindow?: number }>;
		try {
			if (provider.baseUrl.startsWith(GITHUB_MODELS_URL)) {
				models = await githubModelsCatalog((await this.ctx.store.getApiKey(providerId)) ?? '');
			} else if (provider.auth === 'account') {
				models = await this.accountModelList(provider);
			} else if (provider.apiFormat === 'vscode-lm') {
				models = (await listLmModels()).map((m) => ({ id: m.id, contextWindow: m.contextWindow }));
			} else {
				if (!provider.baseUrl) {
					throw new Error('Enter a Base URL first.');
				}
				models = await fetchModels(provider.baseUrl, (await this.ctx.store.getApiKey(providerId)) ?? '', provider.apiFormat);
			}
		} catch (error) {
			if (!auto) throw error;
			this.ctx.status(`${provider.name} gave no model list (${error instanceof Error ? error.message : String(error)}) — press Fetch models on its card to retry.`, 'error');
			return;
		}
		if (!models.length) {
			if (auto) {
				this.ctx.status(`${provider.name} offered no model list — add model IDs with Add model.`);
				return;
			}
			// Stop the spinner too — the endpoint answered, just with nothing.
			surface.post({ type: 'fetchedModels', providerId, models: [], empty: true });
			return;
		}
		if (auto) {
			await this.mergeFetched(provider, models);
			return;
		}
		surface.post({ type: 'fetchedModels', providerId, models });
	}

	/** Connect-and-go: a fetched list becomes the provider's models without the pick dialog. */
	private async mergeFetched(provider: ProviderConfig, models: Array<{ id: string; contextWindow?: number; reasoningControl?: import('../reasoning').ReasoningControl }>): Promise<void> {
		const previousIds = new Set(provider.models.map(m => m.id));
		let addedCount = 0;
		let enabledCount = 0;
		let enableAll = false;
		await this.ctx.store.update(provider.id, async current => {
			if (current.baseUrl !== provider.baseUrl || current.apiFormat !== provider.apiFormat) return {};
			provider = current;
			const known = new Set(provider.models.map((m) => m.id));
			const fresh = models.filter((m) => m.id && !known.has(m.id) && !previousIds.has(m.id));
			const advertised = new Map(models.map(m => [m.id, m.reasoningControl]));
			const existing = provider.models.map(m => advertised.has(m.id) ? { ...m, reasoningControl: advertised.get(m.id) } : m);
			if (!fresh.length) return { models: existing };
			// A curated plan lists every model it offers (small list, all on). Gateways with
			// hundreds of models keep the chat menu usable: the well-known ones start on and
			// the full list stays here for Fetch models to swap the selection.
			enableAll = provider.models.length + fresh.length <= 50;
			const enableIds = new Set((enableAll ? fresh : fresh.filter((m) => FLAGSHIP.test(m.id)).slice(0, 16)).map((m) => m.id));
			const added: ModelEntry[] = await Promise.all(fresh.map((m) => {
				const entry: ModelEntry = { id: m.id, enabled: enableIds.has(m.id), smart: true, contextWindow: m.contextWindow, reasoningControl: m.reasoningControl };
				return enableIds.has(m.id) ? this.smartEntry({ ...entry }, provider) : Promise.resolve(entry);
			}));
			addedCount = added.length;
			enabledCount = enableIds.size;
			return { models: [...existing, ...added] };
		});
		if (addedCount) this.ctx.status(
			enableAll
				? `Added ${addedCount} models to ${provider.name} — they are in the chat menu.`
				: `Added ${addedCount} models to ${provider.name} (${enabledCount} well-known ones enabled — pick more with Fetch models).`,
			'ok'
		);
		await this.ctx.sendState();
	}

	private async testModelFor(surface: HostSurface, providerId: string, modelId: string): Promise<void> {
		const provider = await this.requireProvider(providerId);
		let result: { ok: true; ms: number } | { ok: false; error: string };
		if (provider.apiFormat === 'vscode-lm') {
			const started = Date.now();
			try {
				const abort = new AbortController();
				await streamLm({ baseUrl: '', apiKey: '', apiFormat: 'vscode-lm', model: modelId, system: 'Reply with OK.', messages: [{ role: 'user', content: 'ping' }], signal: abort.signal, onText: () => abort.abort() });
				result = { ok: true, ms: Date.now() - started };
			} catch (error) {
				result = isAbort(error) ? { ok: true, ms: Date.now() - started } : { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		} else {
			result = provider.baseUrl
				? await testModel({ baseUrl: provider.baseUrl, apiKey: (await this.ctx.store.getApiKey(providerId)) ?? '', apiFormat: provider.apiFormat, model: modelId, chatgptPlan: provider.auth === 'account' && provider.preset === 'chatgpt-account' && provider.apiFormat === 'responses' })
				: { ok: false, error: 'No Base URL set.' };
		}
		await this.ctx.store.saveModelCheck(providerId + '::' + modelId, { ...result, at: Date.now(), scope: 'generation' });
		surface.post({ type: 'testResult', providerId, modelId, ...result });
		await this.ctx.sendState();
		// The status dot follows real answers: an account problem is red ("Sign in again" / "Replace the key"), a working answer clears it.
		const health = result.ok ? { ok: true, at: Date.now() } : accountProblem(result.error) ? { ok: false, at: Date.now(), error: result.error.slice(0, 1200), signIn: true } : undefined;
		if (health && !(health.ok && provider.health?.ok)) {
			await this.ctx.store.update(providerId, { health });
			await this.ctx.sendState();
		}
	}
}
