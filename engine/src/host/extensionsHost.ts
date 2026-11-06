import { runHooks } from '../tools/hooks';
import { workspaceRoot } from '../tools/agentTools';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpManager } from '../tools/mcp';
import type { McpServerConfig } from '../providerStore';
import { parseMcpJson, searchMcpRegistry } from '../tools/mcp';
import type { PluginHost } from '../tools/plugins';
import { slugify, type SkillStore } from '../tools/skills';
import { type CatalogSkill, fetchSkillCatalog, installCatalogSkill, repoSkills, resolveSkillLink } from '../tools/skillCatalog';
import { HostContext, HostFeature, HostSurface } from './context';

export const DISABLED_SKILLS_KEY = 'aiChat.disabledSkills';
export const DISABLED_PLUGINS_KEY = 'aiChat.disabledPlugins';
export const ACTIVATED_PLUGINS_KEY = 'aiChat.enabledPlugins';

export async function setPluginEnabled(plugins: PluginHost, state: vscode.Memento, key: string, on: boolean): Promise<void> {
	const plugin = plugins.resolve(key);
	if (!plugin) throw new Error('That plugin installation is no longer available.');
	if (on && plugin.error) throw new Error(plugin.error);
	const off = new Set(state.get<string[]>(DISABLED_PLUGINS_KEY, []));
	if (off.delete(plugin.name)) for (const p of plugins.plugins().filter(p => p.name === plugin.name)) off.add(p.id);
	on ? off.delete(plugin.id) : off.add(plugin.id);
	const activated = new Set(state.get<string[]>(ACTIVATED_PLUGINS_KEY, []));
	for (const token of activated) if (token === plugin.id || token.startsWith(plugin.id + ':')) activated.delete(token);
	if (on) activated.add(plugin.activationKey);
	await state.update(DISABLED_PLUGINS_KEY, [...off]);
	await state.update(ACTIVATED_PLUGINS_KEY, [...activated]);
}

/**
 * What extends the agent: MCP servers, skills, plugins and hooks — the
 * Settings pages of the same names. Split out of ChatController.
 */
export class ExtensionsHost implements HostFeature {
	private readonly directSkills = new Map<string, CatalogSkill>();
	constructor(
		private readonly ctx: HostContext,
		private readonly deps: {
			mcp: McpManager;
			skills: SkillStore;
			plugins: PluginHost;
			globalState: vscode.Memento;
			storageDir: string;
			applyServices(): Promise<void>;
			mcpConfigs(): McpServerConfig[];
		}
	) {}

	private resyncMcp(): void {
		this.deps.mcp.sync(this.deps.mcpConfigs(), this.ctx.store.getSettings().mcp);
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		const { store } = this.ctx;
		switch (msg.type) {
			// ---- MCP
			case 'saveMcp':
				await store.saveMcpServer(msg.server);
				await this.deps.applyServices();
				this.ctx.status(`Saved MCP server "${msg.server?.name}".`);
				await this.ctx.sendState();
				return true;
			case 'deleteMcp':
				await store.deleteMcpServer(String(msg.id));
				await this.deps.applyServices();
				await this.ctx.sendState();
				return true;
			case 'restartMcp':
				this.deps.mcp.restart(String(msg.id));
				return true;
			case 'mcpSignIn':
				this.ctx.status('Finish signing in in your browser…', '');
				await this.deps.mcp.signIn(String(msg.id), (url) => vscode.env.openExternal(vscode.Uri.parse(url)));
				this.ctx.status('Signed in — reconnecting the MCP server.');
				return true;
			case 'mcpSignOut':
				await this.deps.mcp.signOut(String(msg.id));
				this.ctx.status('Signed out of the MCP server.');
				return true;
			case 'importMcp': {
				const parsed = parseMcpJson(String(msg.json ?? ''));
				let imported = 0;
				const failures: string[] = [];
				for (const server of parsed) {
					try { await store.saveMcpServer(server); imported++; }
					catch (e) { failures.push(`${server.name}: ${e instanceof Error ? e.message : String(e)}`); }
				}
				await this.deps.applyServices();
				this.ctx.status(`Imported ${imported} MCP server${imported === 1 ? '' : 's'}.${failures.length ? ` ${failures.length} failed: ${failures.join('; ')}` : ''}`, failures.length ? 'error' : '');
				await this.ctx.sendState();
				return true;
			}
			case 'mcpRegistrySearch':
				surface.post({ type: 'mcpRegistryResults', query: msg.query, results: await searchMcpRegistry(String(msg.query ?? '')) });
				return true;

			// ---- skills
			case 'saveSkill':
				this.deps.skills.save({ name: String(msg.name), description: String(msg.description ?? ''), body: String(msg.body ?? ''), scope: msg.scope === 'user' ? 'user' : 'workspace', previous: msg.previous, triggers: Array.isArray(msg.triggers) ? msg.triggers.map(String) : [] });
				this.ctx.status(`Saved skill "${msg.name}".`);
				await this.ctx.sendState();
				return true;
			case 'deleteSkill':
				this.deps.skills.remove(String(msg.name));
				await this.ctx.sendState();
				return true;
			case 'toggleSkill': {
				const disabled = new Set(this.deps.globalState.get<string[]>(DISABLED_SKILLS_KEY, []));
				const selected = this.deps.skills.list().find(s => s.id === msg.name || s.name === msg.name);
				if (!selected) throw new Error('That skill is no longer available.');
				for (const legacy of [selected.name, selected.baseName]) if (disabled.delete(legacy)) for (const s of this.deps.skills.list().filter(s => s.name === legacy || s.baseName === legacy)) disabled.add(s.id);
				msg.enabled ? disabled.delete(selected.id) : disabled.add(selected.id);
				await this.deps.globalState.update(DISABLED_SKILLS_KEY, [...disabled]);
				await this.ctx.sendState();
				return true;
			}
			case 'skillCatalog': {
				try {
					const c = await fetchSkillCatalog(this.deps.storageDir, msg.refresh === true);
					surface.post({ type: 'skillCatalog', ...c });
				} catch (e) {
					surface.post({ type: 'skillCatalog', at: Date.now(), skills: [], errors: [e instanceof Error ? e.message : String(e)] });
				}
				return true;
			}
			case 'skillInstall': {
				const c = await fetchSkillCatalog(this.deps.storageDir);
				const skill = c.skills.find((s) => s.id === msg.id);
				if (!skill) {
					this.ctx.status('That skill is no longer in the catalog — refresh it.', 'error');
						surface.post({ type: 'skillInstallFailed', id: msg.id });
					return true;
				}
				try {
					await installCatalogSkill(skill, path.join(this.deps.storageDir, 'skills'));
					this.ctx.status(`Installed skill "${skill.name}" — the agent can use it now ($${slugify(skill.name)}).`);
					surface.post({ type: 'skillInstalled', id: skill.id });
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
					surface.post({ type: 'skillInstallFailed', id: skill.id });
				}
				await this.ctx.sendState();
				return true;
			}
			case 'skillFromLink': {
				// A GitHub repo / folder or a SkillsLLM page: list its skills to pick from.
				try {
					const { repo, dir, ref } = await resolveSkillLink(String(msg.url ?? ''));
					const skills = await repoSkills(repo, dir, ref);
					this.directSkills.clear();
					for (const skill of skills) this.directSkills.set(skill.id, skill);
					surface.post({ type: 'skillRepo', repo, skills, error: skills.length ? undefined : `${repo} has no SKILL.md${dir ? ' under ' + dir : ''}. If it is a plugin, install it under Plugins → From Git URL.` });
				} catch (e) {
					surface.post({ type: 'skillRepo', skills: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'skillInstallDirect': {
				const sk = this.directSkills.get(String(msg.skill?.id ?? ''));
				try {
					if (!sk || sk.commit !== msg.skill?.commit) throw new Error('Choose a skill from a freshly loaded repository.');
					await installCatalogSkill(sk, path.join(this.deps.storageDir, 'skills'));
					this.ctx.status(`Installed skill "${sk.name}" — the agent can use it now (${slugify(sk.name)}).`);
					surface.post({ type: 'skillInstalled', id: sk.id });
				} catch (e) {
					this.ctx.status(e instanceof Error ? e.message : String(e), 'error');
					surface.post({ type: 'skillInstallFailed', id: sk?.id ?? msg.skill?.id });
				}
				await this.ctx.sendState();
				return true;
			}
			case 'readSkill': {
				const skill = this.deps.skills.read(String(msg.name), 'settings');
				surface.post({ type: 'skillContent', name: msg.name, body: skill ? fs.readFileSync(skill.info.path, 'utf8') : '' });
				return true;
			}

			// ---- plugins
			case 'installPlugin': {
				let names: string[] = [];
				const scope = msg.scope === 'workspace' ? 'workspace' : 'user';
				if (msg.from === 'git') {
					const url = String(msg.url ?? '').trim();
					this.ctx.status(`Cloning ${url}…`, '');
					names = await this.deps.plugins.installFromGit(url, msg.scope === 'workspace' ? 'workspace' : 'user');
				} else {
					const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Install plugin', title: 'Choose a plugin folder (or a marketplace repo with plugins/)' });
					if (!picked?.[0]) {
						return true;
					}
					names = this.deps.plugins.installFromFolder(picked[0].fsPath, msg.scope === 'workspace' ? 'workspace' : 'user');
				}
				for (const name of names) {
					const installed = this.deps.plugins.plugins().find(p => p.scope === scope && p.name === name);
					if (installed) await setPluginEnabled(this.deps.plugins, this.deps.globalState, installed.id, !(installed.counts.hooks || installed.counts.mcp));
				}
				this.resyncMcp();
				this.ctx.status(names.length ? `Installed ${names.join(', ')}.` : 'No plugin found there.', names.length ? 'ok' : 'error');
				await this.ctx.sendState();
				return true;
			}
			case 'togglePlugin': {
				await setPluginEnabled(this.deps.plugins, this.deps.globalState, String(msg.name), !!msg.enabled);
				this.resyncMcp();
				await this.ctx.sendState();
				return true;
			}
			case 'removePlugin':
				this.deps.plugins.remove(String(msg.name));
				this.resyncMcp();
				this.ctx.status(`Removed ${msg.name}.`);
				await this.ctx.sendState();
				return true;
			case 'openPluginsFolder': {
				const dir = path.join(this.deps.storageDir, 'plugins');
				fs.mkdirSync(dir, { recursive: true });
				await vscode.env.openExternal(vscode.Uri.file(dir));
				return true;
			}

			// ---- hooks
			case 'testHook': {
                if (surface.kind === 'remote') throw new Error('Test hooks on the desktop.');
                const hook = store.getHooks().find(h => h.id === msg.id);
                if (!hook) throw new Error('Save this hook before testing it.');
                const raw = String(msg.sample ?? '{}');
                if (raw.length > 16000) throw new Error('Sample input is too large.');
                const payload = JSON.parse(raw);
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Sample input must be a JSON object.');
                await runHooks([{ ...hook, enabled: true }], hook.event, payload, workspaceRoot()?.fsPath, String(payload.tool_name ?? ''));
                await this.ctx.sendState();
                this.ctx.status('Hook test finished. See execution history.');
                return true;
            }
            case 'saveHook':
				await store.saveHook(msg.hook);
				this.ctx.status('Hook saved.');
				await this.ctx.sendState();
				return true;
			case 'deleteHook':
				await store.deleteHook(String(msg.id));
				await this.ctx.sendState();
				return true;
		}
		return false;
	}
}
