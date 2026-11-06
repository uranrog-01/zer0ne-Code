import * as fs from 'fs';
import type * as vscode from 'vscode';
import type { AgentDef, PluginHost, SubagentState } from '../tools/plugins';
import type { HostContext, HostFeature, HostSurface } from './context';
import { noLinks, publishText, within } from '../tools/extensionFiles';
import { parseSkill } from '../tools/skills';
import { agentTools } from './subagentRuntime';

const STATE_KEY = 'zer0ne.subagents';
const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];

export interface SubagentDraft {
	name: string;
	description: string;
	prompt: string;
	/** 'read' = read-only research tools, 'all' = the full toolset (edits through approvals), else a custom list. */
	tools: 'read' | 'all' | string[];
	model?: string;
	color?: string;
	maxTurns?: number;
	scope: 'project' | 'user';
}

/** A draft → the agent file (Claude Code / ZCode format: frontmatter + instructions) (pure; tested). */
export function agentMarkdown(d: SubagentDraft): string {
	const yaml = (v: string) => JSON.stringify(v);
	const tools = d.tools === 'all' ? '*' : d.tools === 'read' ? 'Read, Grep, Glob, WebFetch, WebSearch' : d.tools.join(', ');
	const lines = ['---', `name: ${yaml(d.name)}`, `description: ${yaml(d.description.replace(/\s*\n\s*/g, ' ').trim())}`, `tools: ${yaml(tools)}`];
	if (d.model) lines.push(`model: ${yaml(d.model)}`);
	if (d.color && COLORS.includes(d.color)) lines.push(`color: ${d.color}`);
	if (d.maxTurns && d.maxTurns > 0) lines.push(`maxTurns: ${Math.floor(d.maxTurns)}`);
	lines.push('---', '', d.prompt.trim(), '');
	return lines.join('\n');
}

/** Names the model can call: letters, digits, dash, dot, underscore (pure; tested). */
export function validAgentName(name: string): boolean {
	return /^[A-Za-z0-9][\w.-]{0,47}$/.test(name);
}

/**
 * Settings → Subagents (ZCode-style): the built-in agents and every agent
 * file (this project's `.zer0ne/agents`, your own folder, `.claude/agents`,
 * opencode, plugins) — create, edit, delete, switch off, and choose the model
 * each one runs on. Files keep the Claude Code format, so the same agents
 * work in Claude Code and ZCode.
 */
export class SubagentsHost implements HostFeature {
	constructor(
		private readonly ctx: HostContext,
		private readonly plugins: PluginHost,
		private readonly memento: vscode.Memento
	) {
		plugins.agentState = () => this.state();
	}

	private state(): SubagentState {
		const s = this.memento.get<Partial<SubagentState>>(STATE_KEY, {});
		return { disabled: Array.isArray(s.disabled) ? s.disabled : [], models: s.models && typeof s.models === 'object' ? s.models : {} };
	}

	private async save(patch: Partial<SubagentState>): Promise<void> {
		await this.memento.update(STATE_KEY, { ...this.state(), ...patch });
	}

	/** Files the page may edit or delete: agent files in our or Claude Code's folders — not plugins, not built-ins. */
	private editable(a: AgentDef): boolean {
		return !!a.path && !a.builtIn && !a.source.startsWith('plugin:') && a.source !== 'opencode';
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'subagentsList':
				await this.send(surface);
				return true;
			case 'subagentToggle': {
				const name = String(msg.name);
				const disabled = this.state().disabled.filter((n) => n !== name);
				if (msg.enabled === false) disabled.push(name);
				await this.save({ disabled });
				await this.send(surface);
				return true;
			}
			case 'subagentModel': {
				const models = { ...this.state().models };
				const model = String(msg.model ?? '');
				if (model) models[String(msg.name)] = model;
				else delete models[String(msg.name)];
				await this.save({ models });
				await this.send(surface);
				return true;
			}
			case 'subagentSave': {
				const d = msg.draft as SubagentDraft;
				const original = typeof msg.original === 'string' ? msg.original : undefined;
				try {
					if (!d || typeof d.name !== 'string' || !validAgentName(d.name)) throw new Error('Name: letters, digits, dash, dot or underscore (the model calls the agent by it).');
					if (typeof d.description !== 'string' || !d.description.trim()) throw new Error('Describe when to use it — the main agent picks subagents by this.');
					if (typeof d.prompt !== 'string' || !d.prompt.trim()) throw new Error('Write the instructions the subagent follows.');
					if (d.scope !== 'project' && d.scope !== 'user') throw new Error('Invalid agent scope.');
					if (d.tools !== 'read' && d.tools !== 'all' && (!Array.isArray(d.tools) || d.tools.some(t => typeof t !== 'string'))) throw new Error('Invalid agent tools.');
					if (d.model !== undefined && typeof d.model !== 'string') throw new Error('Invalid agent model.');
					if (d.maxTurns !== undefined && (!Number.isInteger(d.maxTurns) || d.maxTurns < 1 || d.maxTurns > 1000)) throw new Error('maxTurns must be between 1 and 1000.');
					if (Array.isArray(d.tools)) agentTools([], { tools: d.tools });
					const text = agentMarkdown(d); parseSkill(text);
					const all = this.plugins.allAgents();
					const before = original ? all.find((a) => a.name === original) : undefined;
					if (before && !this.editable(before)) throw new Error('This agent cannot be edited.');
					if (all.some((a) => a.name.toLowerCase() === d.name.toLowerCase() && a !== before)) throw new Error(`There is already an agent named "${d.name}".`);
					const dirs = this.plugins.agentDirs();
					const dir = d.scope === 'project' ? dirs.project : dirs.user;
					if (!dir) throw new Error('Open a folder to save a project agent, or save it for every project.');
					const file = within(dir, d.name + '.md');
					publishText(file, text, before?.path ?? file);
					if (before && before.name !== d.name) {
						const s = this.state();
						const models = { ...s.models };
						if (models[before.name]) (models[d.name] = models[before.name]), delete models[before.name];
						await this.save({ models, disabled: s.disabled.map((n) => (n === before.name ? d.name : n)) });
					}
					this.ctx.status(`Subagent "${d.name}" saved to ${file}.`, 'ok');
					surface.post({ type: 'subagentSaved', name: d.name });
				} catch (e) {
					surface.post({ type: 'subagentError', error: e instanceof Error ? e.message : String(e) });
				}
				await this.send(surface);
				return true;
			}
			case 'subagentDelete': {
				const a = this.plugins.allAgents().find((x) => x.name === msg.name);
				if (a && this.editable(a) && a.path) {
					noLinks(a.path);
					fs.rmSync(a.path, { force: true });
					const s = this.state();
					const models = { ...s.models };
					delete models[a.name];
					await this.save({ models, disabled: s.disabled.filter((n) => n !== a.name) });
					this.ctx.status(`Subagent "${a.name}" deleted.`, 'ok');
				}
				await this.send(surface);
				return true;
			}
		}
		return false;
	}

	private async send(surface: HostSurface): Promise<void> {
		const dirs = this.plugins.agentDirs();
		const providers = await this.ctx.store.list().catch(() => []);
		const models = providers.filter((p) => p.enabled && p.apiFormat !== 'acp').flatMap((p) => p.models.filter((m) => m.enabled).map((m) => ({ id: p.id + '::' + m.id, label: p.name + ' · ' + (m.name || m.id) })));
		const scopeOf = (a: AgentDef) => (a.builtIn ? 'built-in' : a.path && dirs.project && a.path.startsWith(dirs.project) ? 'project' : a.path && a.path.startsWith(dirs.user) ? 'user' : a.source.startsWith('plugin:') ? 'plugin' : 'other');
		surface.post({
			type: 'subagents',
			data: {
				enabled: this.ctx.store.getSettings().subagents !== false,
				dirs,
				models,
				agents: this.plugins.allAgents().map((a) => ({
					name: a.name,
					description: a.description,
					prompt: a.prompt,
					model: a.model,
					modelOverride: a.modelOverride,
					tools: a.tools,
					disallowedTools: a.disallowedTools,
					maxTurns: a.maxTurns,
					color: a.color,
					canWrite: a.canWrite,
					enabled: a.enabled,
					source: a.source,
					scope: scopeOf(a),
					path: a.path,
					editable: this.editable(a)
				}))
			}
		});
	}
}
