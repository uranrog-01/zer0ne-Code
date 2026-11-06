import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { HostContext, HostFeature, HostSurface } from './context';
import type { PluginHost } from '../tools/plugins';
import { DEFAULT_MARKETPLACES, MarketplaceRef, fetchMarketplace, fetchPluginFolder, githubRepo, inspectPlugin } from '../tools/marketplace';

const SOURCES_KEY = 'zer0ne.marketplaces';
const ORIGIN = '.zer0ne-origin.json';

/**
 * Settings → Plugins → Marketplace: browse Claude Code–format marketplaces,
 * install one plugin (not the whole repo), see what it contains, update it.
 * Plugins that bring hooks or MCP servers (they run programs) are installed
 * switched off until you review them.
 */
export class MarketplaceHost implements HostFeature {
	constructor(
		private readonly ctx: HostContext,
		private readonly plugins: PluginHost,
		private readonly memento: vscode.Memento,
		private readonly setEnabled: (name: string, on: boolean) => Promise<void>,
		private readonly afterChange: () => Promise<void>
	) {}

	private sources(): MarketplaceRef[] {
		const extra = this.memento.get<MarketplaceRef[]>(SOURCES_KEY, []);
		return [...DEFAULT_MARKETPLACES, ...extra.filter((e) => !DEFAULT_MARKETPLACES.some((d) => d.id === e.id))];
	}

	/** name → { marketplace, version } for installed plugins that came from a marketplace. */
	private origins(): Record<string, { marketplace: string; version?: string }> {
		const out: Record<string, { marketplace: string; version?: string }> = {};
		for (const p of this.plugins.plugins()) {
			try {
				const o = JSON.parse(fs.readFileSync(path.join(p.dir, ORIGIN), 'utf8'));
				out[p.id] = { marketplace: o.marketplace, version: o.version };
			} catch {
				/* installed by hand */
			}
		}
		return out;
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		switch (msg.type) {
			case 'mktSources':
				surface.post({ type: 'mktSources', sources: this.sources(), origins: this.origins(), installed: this.plugins.plugins().map((p) => ({ id: p.id, scope: p.scope, name: p.name, version: p.version })) });
				return true;
			case 'mktFetch': {
				const id = String(msg.id ?? '');
				try {
					const m = await fetchMarketplace(id, msg.force === true);
					surface.post({ type: 'mktPlugins', id, name: m.name, plugins: m.plugins });
				} catch (e) {
					surface.post({ type: 'mktPlugins', id, plugins: [], error: e instanceof Error ? e.message : String(e) });
				}
				return true;
			}
			case 'mktAddSource': {
				const repo = githubRepo(String(msg.id ?? ''));
				if (!repo) {
					this.ctx.status('Use owner/repo or a https://github.com/owner/repo URL.', 'error');
					return true;
				}
				const m = await fetchMarketplace(repo, true); // validates it has a marketplace.json
				const extra = this.memento.get<MarketplaceRef[]>(SOURCES_KEY, []).filter((x) => x.id !== repo);
				await this.memento.update(SOURCES_KEY, [...extra, { id: repo, name: m.name }]);
				this.ctx.status(`Added ${m.name} (${m.plugins.length} plugins).`);
				surface.post({ type: 'mktSources', sources: this.sources(), origins: this.origins(), installed: this.plugins.plugins().map((p) => ({ id: p.id, scope: p.scope, name: p.name, version: p.version })), select: repo });
				return true;
			}
			case 'mktRemoveSource': {
				await this.memento.update(SOURCES_KEY, this.memento.get<MarketplaceRef[]>(SOURCES_KEY, []).filter((x) => x.id !== msg.id));
				surface.post({ type: 'mktSources', sources: this.sources(), origins: this.origins(), installed: this.plugins.plugins().map((p) => ({ id: p.id, scope: p.scope, name: p.name, version: p.version })) });
				return true;
			}
			case 'mktInstall': {
				const marketplace = String(msg.marketplace ?? '');
				const name = String(msg.name ?? '');
				const scope = msg.scope === 'workspace' ? 'workspace' : 'user';
				const m = await fetchMarketplace(marketplace);
				const entry = m.plugins.find((p) => p.name === name);
				if (!entry) {
					throw new Error(`${name} is no longer in ${marketplace}.`);
				}
				this.ctx.status(`Downloading ${name}…`, '');
				const { dir, cleanup } = await fetchPluginFolder(entry);
				try {
					const risky = inspectPlugin(dir);
					const names = this.plugins.installFromFolder(dir, scope);
					for (const n of names) {
						const target = this.plugins.plugins().find((p) => p.name === n && p.scope === scope);
						if (target) {
							fs.writeFileSync(path.join(target.dir, ORIGIN), JSON.stringify({ marketplace, name, version: entry.version, installedAt: Date.now() }, null, 2));
						}
						// Code-running parts stay off until the user turns the plugin on.
						if (target) await this.setEnabled(target.id, !(risky.hooks || risky.mcp));
					}
					const parts = [risky.commands && `${risky.commands} commands`, risky.agents && `${risky.agents} agents`, risky.skills && `${risky.skills} skills`, risky.hooks && 'hooks', risky.mcp && 'MCP servers'].filter(Boolean).join(', ');
					this.ctx.status(
						risky.hooks || risky.mcp
							? `Installed ${names.join(', ')} (${parts}). It runs programs (hooks / MCP), so it is OFF — review it, then switch it on.`
							: `Installed ${names.join(', ')}${parts ? ` — ${parts}` : ''}.`
					);
				} finally {
					cleanup();
				}
				await this.afterChange();
				surface.post({ type: 'mktSources', sources: this.sources(), origins: this.origins(), installed: this.plugins.plugins().map((p) => ({ id: p.id, scope: p.scope, name: p.name, version: p.version })) });
				return true;
			}
		}
		return false;
	}
}
