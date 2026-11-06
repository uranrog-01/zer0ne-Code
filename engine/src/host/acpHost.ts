import * as os from 'os';
import * as vscode from 'vscode';
import { HostContext, HostFeature, HostSurface } from './context';
import { closeAcpAgents, sessionModels, streamAcp } from '../acp/stream';
import { PLAN_AGENTS, cardsFrom } from '../acp/registry';
import { AcpRuntime, which } from '../acp/runtime';
import { signInAgent } from '../acp/signIn';
import { agentErrorMessage, applyPlanScope, planModels } from '../acp/client';
import { type ModelEntry, type ProviderConfig, accountProblem, agentFailureText } from '../providerStore';
import { workspaceRoot } from '../tools/agentTools';
import { isDesktopHost } from './capabilities';
import { openLoginTerminal } from './loginTerminal';

/**
 * Settings → Providers & models → Plans & subscriptions: every agent in the
 * ACP registry that carries a plan (Claude, Antigravity, Gemini, Cursor,
 * OpenCode…) as a card with Sign in + API key. Sign-in runs the vendor's own
 * login (src/acp/signIn.ts) and adds the agent as a provider; the chat then
 * talks to the agent (src/acp/stream.ts). The message names are `acp*`.
 */

const MAX_ENABLED = 8;
const mb = (n?: number) => (n ? (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB') : 'a large file');
/** Well-known model families: listed (and switched on) ahead of the long tail a gateway agent like Cline offers. */
const FLAGSHIP = /claude|opus|sonnet|fable|haiku|gpt|codex|gemini|grok|deepseek|qwen|glm|kimi|minimax|default/i;
/** "Gemini 3.8 Flash (Low)" / "gpt-x-medium": a lower effort of a model the list also has at a higher one. */
const LOWER_EFFORT = /(\(|[-_ ])(low|medium|minimal)\)?$/i;

/**
 * The agent's models as provider models, with the agent's names. On: the
 * current one, then a few flagships (one effort each); the rest stay listed
 * but off (an agent can offer hundreds) (pure; tested).
 */
export function pickModels(models: Array<{ id: string; name?: string; description?: string; reasoningControl?: import('../reasoning').ReasoningControl }>, current: string | undefined, max = MAX_ENABLED, preferClaudeAliases = false): ModelEntry[] {
	const rolling = new Set(preferClaudeAliases ? models.map(m => m.id).filter(id => /^(opus|sonnet|haiku|fable)$/.test(id)) : []);
	const rank = (m: { id: string; name?: string }) => (m.id === current ? 0 : FLAGSHIP.test(`${m.id} ${m.name ?? ''}`) ? 1 : 2);
	const ordered = models.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map((x) => x.m);
	let on = 0;
	return ordered.map((raw) => {
		// "OpenCode Go/GLM-5.3" → "GLM-5.3": the provider is already the card.
		const m = { ...raw, name: raw.name?.replace(/^[^/]{1,32}\/(?=\S)/, '') };
		const lower = m.id !== current && (LOWER_EFFORT.test(m.name ?? '') || LOWER_EFFORT.test(m.id));
		const versionedFamily = /^claude-(opus|sonnet|haiku|fable)-/.exec(m.id)?.[1];
		// The vendor's rolling aliases follow the account's current model; explicit older versions remain selectable.
		const previousVersion = m.id !== current && versionedFamily && rolling.has(versionedFamily);
		const enabled = !lower && !previousVersion && on < max;
		if (enabled) on++;
		return { id: m.id, enabled, smart: false, tools: true, ...(m.name && m.name !== m.id ? { name: m.name } : {}), ...(m.description ? { note: m.description } : {}), ...(m.reasoningControl ? { reasoningControl: m.reasoningControl } : {}) };
	});
}

/** A fresh agent catalog is authoritative; keep choices and limits only for IDs it still offers. */
export function refreshAgentModels(stored: ModelEntry[], offered: Parameters<typeof pickModels>[0]): ModelEntry[] {
	const known = new Map(stored.map(m => [m.id, m]));
	return pickModels(offered, undefined, 0).map(m => {
		const prior = known.get(m.id);
		return prior ? { ...prior, name: m.name, note: m.note, reasoningControl: m.reasoningControl } : m;
	});
}

export class AcpHost implements HostFeature {
	private signing?: AbortController;
	private codeWaiter?: { controller: AbortController; resolve: (code: string) => void };

	constructor(private readonly ctx: HostContext, private readonly rt: AcpRuntime) {}

	dispose(): void {
		this.signing?.abort();
		closeAcpAgents();
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'acpAgents': {
				try {
					const entries = await this.rt.registry(msg.refresh === true);
					const providers = await this.ctx.store.list();
					surface.post({
						type: 'acpAgents',
						cards: cardsFrom(entries).map(card => ({ ...card, ...this.rt.setup(entries.find(entry => entry.id === card.id)!) })),
						connected: providers.filter((p) => p.apiFormat === 'acp' && p.agent).map((p) => ({ agent: p.agent!.id, providerId: p.id })),
						installed: Object.fromEntries(entries.map((e) => [e.id, this.rt.isInstalled(e)]))
					});
				} catch (e) {
					surface.post({ type: 'acpAgents', cards: [], connected: [], installed: {}, error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'acpSignIn':
				void this.signIn(surface, String(msg.agent), typeof msg.id === 'string' ? msg.id : undefined, msg.agent === 'antigravity-acp' && msg.reauthenticate === true);
				return true;
			case 'acpSignInCode':
				if (this.codeWaiter && !this.codeWaiter.controller.signal.aborted) this.codeWaiter.resolve(String(msg.code ?? ''));
				this.codeWaiter = undefined;
				return true;
			case 'acpCancel':
				this.signing?.abort();
				return true;
			case 'testModel':
			case 'fetchModels': {
				const p = await this.ctx.store.get(String(msg.id));
				if (p?.apiFormat !== 'acp') return false;
				void (msg.type === 'testModel' ? this.test(surface, p, String(msg.modelId)) : this.refreshModels(surface, p));
				return true;
			}
			case 'checkProvider': {
				const p = await this.ctx.store.get(String(msg.id));
				if (p?.apiFormat !== 'acp') return false;
				const started = Date.now();
				try {
					const found = await this.listModels(p);
					await this.syncModels(p, found.models);
					const fresh = await this.ctx.store.get(p.id);
					if (!fresh) throw new Error('This provider was removed during the check.');
					const modelId = found.current ?? fresh.models.find(m => m.enabled)?.id ?? found.models[0].id;
					const checked = await this.check(fresh, modelId);
					surface.post({ type: 'providerCheck', id: p.id, ok: checked.ok, ms: Date.now() - started, count: found.models.length, ...(!checked.ok ? { error: checked.error } : {}) });
					await this.recordHealth(p.id, checked, true);
					await this.ctx.sendState();
				} catch (e) {
					const error = agentErrorMessage(e, p.name);
					surface.post({ type: 'providerCheck', id: p.id, ok: false, ms: Date.now() - started, error });
					if (await this.recordHealth(p.id, { ok: false, error }, true)) await this.ctx.sendState();
				}
				return true;
			}
			case 'deleteProvider': {
				// Let the providers feature delete it; just stop its agent first.
				const p = await this.ctx.store.get(String(msg.id));
				if (p?.agent) closeAcpAgents(p.agent.id);
				return false;
			}
		}
		return false;
	}

	/** Test button: the check below, shown on the model row, and remembered as the provider's health. */
	private async test(surface: HostSurface, p: ProviderConfig, modelId: string): Promise<void> {
		const r = await this.check(p, modelId);
		surface.post(r.ok ? { type: 'testResult', providerId: p.id, modelId, ok: true, ms: r.ms } : { type: 'testResult', providerId: p.id, modelId, ok: false, error: r.error });
		if (await this.recordHealth(p.id, r)) await this.ctx.sendState();
	}

	/** Store what a check found (account problems turn the dot red with "Sign in again"); true when it changed. */
	private async recordHealth(providerId: string, r: { ok: boolean; error?: string }, connectionCheck = false): Promise<boolean> {
		const p = await this.ctx.store.get(providerId);
		if (!p) return false;
		if (!r.ok && !connectionCheck && !accountProblem(r.error ?? '')) return false; // a model hiccup says nothing about the sign-in
		if (r.ok && p.health?.ok) return false;
		await this.ctx.store.update(providerId, { health: r.ok ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), error: (r.error ?? '').slice(0, 10_000), signIn: accountProblem(r.error ?? '') } });
		return true;
	}

	/** A real, tiny request (read-only): the agent opens a session and answers a greeting; its own failure text counts as a failure. */
	private async check(p: ProviderConfig, modelId: string, signal?: AbortSignal): Promise<{ ok: boolean; ms: number; error?: string }> {
		const started = Date.now();
		const ctl = new AbortController();
		const cancel = () => ctl.abort();
		signal?.addEventListener('abort', cancel, { once: true });
		if (signal?.aborted) ctl.abort();
		const timer = setTimeout(() => ctl.abort(), 120_000);
		let text = '';
		const judge = () =>
			!text.trim()
				? { ok: false, ms: Date.now() - started, error: 'The agent returned no text. Check the selected model and account access, then test again.' }
				: agentFailureText(text)
					? { ok: false, ms: Date.now() - started, error: text.trim().slice(0, 10_000) }
					: { ok: true, ms: Date.now() - started };
		try {
			await streamAcp({
				baseUrl: p.baseUrl,
				apiKey: '',
				apiFormat: 'acp',
				model: modelId,
				system: '',
				// A plain greeting: "reply OK, use no tools" style prompts tripped Claude's safety filter in live tests.
				messages: [{ role: 'user', content: 'Hi! Please say hello in one short sentence.' }],
				signal: ctl.signal,
				providerId: p.id,
				onText: (t) => {
					text += t;
					// Enough to judge: a sentence that is not an error report.
					if (text.length > 60 && !agentFailureText(text)) ctl.abort();
				},
				acp: {
					cwd: workspaceRoot()?.fsPath ?? os.homedir(),
					chatId: 'test-' + p.id,
					planMode: true,
					permission: async () => false,
					readFile: async () => { throw new Error('Not available in a test.'); },
					writeFile: async () => { throw new Error('Not available in a test.'); },
					tool: () => undefined
				}
			});
			return judge();
		} catch (e) {
			if ((e as Error)?.name === 'AbortError' && text.trim()) return judge();
			return { ok: false, ms: Date.now() - started, error: agentErrorMessage(e, p.name) };
		} finally {
			signal?.removeEventListener('abort', cancel);
			clearTimeout(timer);
			closeAcpAgents(p.agent?.id, 'test-' + p.id);
		}
	}

	/** The model list from a fresh agent session, offered like any provider's fetched list (the page shows the picker). */
	private async listModels(p: ProviderConfig) {
		const entry = p.agent && (await this.rt.entry(p.agent.id));
		if (!entry) throw new Error('This agent is not in the registry any more.');
		const cwd = workspaceRoot()?.fsPath ?? os.homedir();
		const conn = await this.rt.connect(entry, { requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }), sessionUpdate: () => undefined }, { cwd, fs: false });
		try {
			const scope = PLAN_AGENTS[entry.id]?.planScope;
			const found = planModels(sessionModels(await applyPlanScope(conn, await conn.newSession(cwd), scope)), scope);
			if (!found.models.length) throw new Error(`${p.name} offered no models for this account. Check your plan's access with the provider, then fetch models again.`);
			return found;
		} finally { conn.close(); }
	}

	private async refreshModels(surface: HostSurface, p: ProviderConfig): Promise<void> {
		try {
			const found = await this.listModels(p);
			if (await this.syncModels(p, found.models)) await this.ctx.sendState();
			surface.post({ type: 'fetchedModels', providerId: p.id, models: found.models.map((m) => ({ id: m.id, name: m.name, note: m.description, reasoningControl: m.reasoningControl })), empty: !found.models.length });
		} catch (e) {
			surface.post({ type: 'fetchedModels', providerId: p.id, models: [], empty: true });
			this.ctx.status(`Could not list models: ${e instanceof Error ? e.message : String(e)}`, 'error');
		}
	}

	private async syncModels(p: ProviderConfig, offered: Parameters<typeof pickModels>[0]): Promise<boolean> {
		// Listing takes a new process; reread so a toggle made while it started is not overwritten.
		if (!await this.ctx.store.get(p.id)) return false;
		let changed = false;
		await this.ctx.store.update(p.id, fresh => {
			if (fresh.apiFormat !== 'acp' || JSON.stringify(fresh.agent) !== JSON.stringify(p.agent)) return {};
			const models = refreshAgentModels(fresh.models, offered);
			changed = JSON.stringify(models) !== JSON.stringify(fresh.models);
			return changed ? { models } : {};
		});
		return changed;
	}

	private async terminal(title: string, command: string, args: string[], env?: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
		if (isDesktopHost()) return openLoginTerminal(which(command) ?? command, args, workspaceRoot()?.fsPath ?? os.homedir(), env, signal);
		// The command itself is the terminal's process: no shell quoting involved. npm shims (.cmd) go through cmd.exe.
		const shim = /\.(cmd|bat)$/i.test(command);
		const t = vscode.window.createTerminal({ name: title, shellPath: shim ? process.env.ComSpec ?? 'cmd.exe' : command, shellArgs: shim ? ['/d', '/k', command, ...args] : args, env, cwd: workspaceRoot()?.fsPath ?? os.homedir() });
		t.show();
	}

	private async signIn(surface: HostSurface, agentId: string, existingId?: string, reauthenticate = false): Promise<void> {
		this.signing?.abort();
		const ctl = (this.signing = new AbortController());
		const ensureActive = () => ctl.signal.throwIfAborted();
		const say = (m: Record<string, unknown>) => { if (this.signing === ctl) surface.post({ type: 'acpSignIn', agent: agentId, ...m }); };
		say({ stage: 'starting' });
		try {
			if (agentId === 'antigravity-acp') {
				say({ stage: 'waiting', text: 'Checking for Google Antigravity agent updates…' });
				await this.rt.registry(true);
				ensureActive();
			}
			const entry = await this.rt.entry(agentId);
			ensureActive();
			if (!entry) throw new Error('That agent is not in the registry (any more).');
			const setup = this.rt.setup(entry);
			if (!setup.available) throw new Error(setup.setupIssue);
			const meta = PLAN_AGENTS[agentId];
			if (!this.rt.isInstalled(entry)) {
				const launch = this.rt.launch(entry);
				if (launch?.kind === 'binary') {
					const size = await this.rt.downloadSize(entry);
					ensureActive();
					const host = new URL(launch.archive!).host;
					const pick = await vscode.window.showWarningMessage(`${entry.name}'s agent is ${mb(size)} to download from ${host}. Download it now?`, { modal: true, detail: launch.sha256 ? 'It is verified against the checksum in the agent registry and stored in the extension\'s data folder.' : 'The registry lists no checksum for it; it comes over HTTPS from the vendor and is stored in the extension\'s data folder.' }, 'Download');
					ensureActive();
					if (pick !== 'Download') return say({ stage: 'cancelled' });
				}
				say({ stage: 'install', text: `Getting ${entry.name}…` });
				await this.rt.install(entry, (p) => say({ stage: 'install', text: p.stage, received: p.received, total: p.total }), ctl.signal);
			}
			ensureActive();
			if (reauthenticate) closeAcpAgents(agentId);
			const result = await signInAgent(this.rt, entry, meta, workspaceRoot()?.fsPath ?? os.homedir(), {
				reauthenticate,
				signal: ctl.signal,
				open: (url) => {
					return /^https:\/\//i.test(url) ? vscode.env.openExternal(vscode.Uri.parse(url)) : false;
				},
				terminal: (title, command, args, env) => this.terminal(title, command, args, env, ctl.signal),
				event: (e) => say({ ...e }),
				code: () => new Promise<string>((resolve, reject) => {
					const cancel = () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
					this.codeWaiter = { controller: ctl, resolve: code => { ctl.signal.removeEventListener('abort', cancel); resolve(code); } };
					ctl.signal.addEventListener('abort', cancel, { once: true });
					if (ctl.signal.aborted) cancel();
				})
			});
			ensureActive();
			say({ stage: 'models' });
			closeAcpAgents(agentId); // Fresh credentials must also reach existing chats.
			const models = pickModels(result.models, result.current, MAX_ENABLED, agentId === 'claude-acp');
			if (!models.length) throw new Error(`${entry.name} signed in but offered no models. Try again in a moment.`);
			const all = await this.ctx.store.list();
			ensureActive();
			let provider = all.find((p) => p.apiFormat === 'acp' && p.agent?.id === agentId && (!existingId || p.id === existingId));
			const agent = { id: agentId, plan: result.plan, email: result.email };
			if (provider) {
				const known = new Map(provider.models.map((m) => [m.id, m]));
				await this.ctx.store.update(provider.id, { agent, models: models.map((m) => (known.has(m.id) ? { ...m, enabled: known.get(m.id)!.enabled } : m)) });
			} else {
				provider = await this.ctx.store.add({ name: meta?.name ?? entry.name, baseUrl: 'acp:' + agentId, apiFormat: 'acp', preset: 'acp:' + agentId, agent, models });
			}
			ensureActive();
			const sel = await this.ctx.store.resolveSelection();
			ensureActive();
			if (!sel.model) await this.ctx.store.setSelection(provider.id, models[0].id);
			// Signed in is not the same as working: one short real answer from the plan (an unverified or unpaid account fails here, not in the chat).
			say({ stage: 'verify', text: 'Checking that your plan answers…' });
			const fresh = (await this.ctx.store.get(provider.id)) ?? provider;
			ensureActive();
			const checked = await this.check(fresh, models[0].id, ctl.signal);
			ensureActive();
			await this.ctx.store.update(provider.id, { health: checked.ok ? { ok: true, at: Date.now() } : { ok: false, at: Date.now(), error: (checked.error ?? '').slice(0, 10_000), signIn: accountProblem(checked.error ?? '') } });
			await this.ctx.sendState();
			// The verification message already says what happened and what to do; other failures get the "signed in, but" lead.
			if (!checked.ok) throw new Error(/needs your account verified/.test(checked.error ?? '') ? `Signed in, but ${checked.error}` : `Signed in, but ${meta?.name ?? entry.name} did not answer: ${checked.error}`);
			say({ stage: 'done', verifiedMs: checked.ms, providerId: provider.id, plan: result.plan, email: result.email, count: models.filter((m) => m.enabled).length, total: models.length });
			this.ctx.status(`Connected ${meta?.name ?? entry.name}${result.email ? ' as ' + result.email : ''} ✓ — ${models.filter((m) => m.enabled).length} models ready.`, 'ok');
			await this.ctx.sendState();
			surface.post({ type: 'focusProvider', id: provider.id });
		} catch (e) {
			if (ctl.signal.aborted) say({ stage: 'cancelled' });
			else say({ stage: 'error', error: agentErrorMessage(e, PLAN_AGENTS[agentId]?.name ?? agentId) });
		} finally {
			ctl.abort();
			if (this.signing === ctl) this.signing = undefined;
			if (this.codeWaiter?.controller === ctl) this.codeWaiter = undefined;
		}
	}
}
