import type { ToolCall, ToolDef } from '../chatClient';
import type { McpManager } from '../tools/mcp';
import { externalTool } from '../tools/mcp';
import type { PluginHost } from '../tools/plugins';
import { newId } from '../providerStore';
import type { AgentSettings, HookConfig, StoredMessage } from '../providerStore';
import { APPROVAL_TOOLS, describeArgs, runTool, toolPolicyError, type ToolContext } from '../tools/agentTools';
import { searchDeferred, unwrapUseTool } from '../tools/deferred';
import { runHooks } from '../tools/hooks';
import { PARALLEL_TOOLS } from './turnHelpers';
import { redactSecrets } from '../tools/redact';
import { parseToolArgs } from '../tools/argRepair';

import { ToolScheduler } from '../core/toolScheduler';
import { beginExecution } from '../core/executionJournal';

const isJsonObject = (s: string): boolean => {
	try {
		const v = JSON.parse(s);
		return !!v && typeof v === 'object';
	} catch {
		return false;
	}
};

type ToolOutcome = Awaited<ReturnType<typeof runTool>>;

export interface ToolExecutorDeps {
	scheduler?: ToolScheduler;
	scheduleState(): void;
	mcp: McpManager;
	plugins: PluginHost;
	
	
}

/** Runs the agent's tool calls: cards in the transcript, hooks, secret redaction, parallel-safety. */
export class ToolExecutor {
	readonly scheduler: ToolScheduler;
	constructor(private readonly d: ToolExecutorDeps) { this.scheduler = d.scheduler ?? new ToolScheduler(); }

	/** Tools with no side effects and no shared state can run side by side. */
	parallelSafe(call: ToolCall, deferred?: Map<string, ToolDef>): boolean {
		if (call.name.startsWith('mcp__')) {
			const hit = this.d.mcp.resolve(call.name);
			return hit?.client.config.trusted === true && hit.tool.annotations?.readOnlyHint === true && hit.tool.annotations.destructiveHint !== true;
		}
		if (call.name === 'tool_search') {
			return true;
		}
		if (call.name === 'use_tool' && deferred) {
			const u = unwrapUseTool(call, deferred);
			return 'call' in u && this.parallelSafe(u.call);
		}
		if (PARALLEL_TOOLS.has(call.name)) {
			return true;
		}
		if (call.name === 'task') {
			try {
				// Read-only agents run side by side; one that edits (foreground, or a chain step) waits its turn.
				const args = JSON.parse(call.arguments || '{}');
				if (args.isolated === true) return false;
				if (Array.isArray(args.tasks) && args.tasks.length) return true;
				if (args.background === true) return true;
				const writes = (name: unknown) => !!name && !!this.d.plugins.agents().find((a) => a.name === String(name))?.canWrite;
				if (Array.isArray(args.chain) && args.chain.length) return !args.chain.some((x: { agent?: unknown }) => writes(x?.agent));
				return !writes(args.agent);
			} catch {
				return false;
			}
		}
		return false;
	}

	/** Run one tool call with its card, hooks and secret redaction. */
	async executeCall(
		call: ToolCall,
		ctx: ToolContext,
		convo: StoredMessage[],
		hooks: HookConfig[],
		hookBase: Record<string, unknown>,
		settings: AgentSettings,
		deferred?: Map<string, ToolDef>
	): Promise<ToolOutcome> {
		// Small local models write near-JSON: repair it once here, so approvals, hooks, cards and the history all see valid JSON.
		if (call.arguments && !isJsonObject(call.arguments)) {
			const fixed = parseToolArgs(call.arguments);
			if (fixed) call.arguments = JSON.stringify(fixed);
		}
		if (deferred && call.name === 'tool_search') {
			let query = '';
			try {
				query = String(JSON.parse(call.arguments || '{}').query ?? '');
			} catch {
				// empty query lists everything
			}
			const found = searchDeferred(deferred, query);
			convo.push({ id: newId('t'), role: 'assistant', kind: 'tool', content: '', tool: { callId: call.id, name: 'tool_search', arg: query, status: 'done', summary: found.names.length ? `loaded ${found.names.join(', ')}` : 'no match' } });
			this.d.scheduleState();
			return { api: found.text, summary: found.names.join(', ') || 'no match' };
		}
		if (deferred && call.name === 'use_tool') {
			const u = unwrapUseTool(call, deferred);
			if ('error' in u) {
				return { api: `Error: ${u.error}`, summary: 'invalid use_tool', error: true };
			}
			call = u.call; // from here on it is the real tool: cards, approvals, hooks, undo
		}
		const isMcpApproval = call.name.startsWith('mcp__') && !this.d.mcp.isTrusted(call.name);
		const mcpTool = call.name.startsWith('mcp__') ? this.d.mcp.resolve(call.name)?.tool : undefined;
		let externalAction = mcpTool ? externalTool(mcpTool) : ['browser_click', 'browser_type', 'browser_press', 'browser_select'].includes(call.name);
		if (isJsonObject(call.arguments || '{}')) {
			const args = JSON.parse(call.arguments || '{}');
			if (call.name === 'computer') externalAction = ['click', 'double_click', 'right_click', 'type', 'key'].includes(args.action);
			if (call.name === 'browser_batch') externalAction = Array.isArray(args.steps) && args.steps.some((step: { action?: string } | null) => ['click', 'type', 'press', 'select'].includes(step?.action || ''));
		}
		let card: StoredMessage | undefined;
		if (!APPROVAL_TOOLS.has(call.name) && !isMcpApproval && call.name !== 'task') {
			card = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', tool: { callId: call.id, name: call.name, arg: describeArgs(call), status: 'running', summary: '' } };
			convo.push(card);
			this.d.scheduleState();
		}
		let appCard: StoredMessage | undefined;
		const outcome = await this.runWithGates(call, { ...ctx, requestApproval: request => {
			const before = convo.length;
			const answer = ctx.requestApproval(request);
			if (request.kind === 'mcp') appCard = convo.slice(before).find(m => m.approval?.kind === 'mcp' && m.approval.tool === request.tool && m.approval.args === request.args);
			return answer;
		} }, hooks, hookBase, settings);
		// A PreToolUse hook can block an approval tool before its card exists — show it anyway.
		if (!card && outcome.summary === 'blocked by hook') {
			card = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', tool: { callId: call.id, name: call.name, arg: describeArgs(call), status: 'error', summary: '' } };
			convo.push(card);
		}
		if (card?.tool) {
			// The card's detail is the raw tool payload. It is persisted with the session and is
			// spliced into other requests (the Side Chat builds its context from card detail), so it
			// needs the same masking as the model-facing text — otherwise a secret inside a diff
			// reaches the disk and then a second provider.
			const detail = settings.redactSecrets && outcome.detail ? redactSecrets(outcome.detail).text : outcome.detail;
			card.tool = { ...card.tool, status: outcome.error ? 'error' : 'done', summary: outcome.summary, detail, image: outcome.image, url: outcome.url, externalAction };
			if (outcome.todos) {
				card.todos = outcome.todos;
			}
		}
		if (outcome.mcpApp) {
			const target = card ?? appCard;
			if (target) target.mcpApp = outcome.mcpApp;
		}
		return outcome;
	}

	/**
	 * The gate sequence every tool call goes through, wherever it runs: arg
	 * repair, PreToolUse hooks, the tool itself, PostToolUse feedback, secret
	 * redaction. executeCall wraps it in transcript cards; the subagent loop
	 * (runWithGates via turnAgents) uses it bare so its calls obey the same
	 * hooks and the same redaction without flooding the chat with cards.
	 *
	 * Mods wrap the same sequence: tool.call handlers form a chain around this
	 * core (deny, answer, or rewrite the arguments before it runs), tool.check
	 * can deny after the permission rules, and classic.PreToolUse /
	 * classic.PostToolUse mirror the shell-hook events for observers.
	 */
	async runWithGates(call: ToolCall, ctx: ToolContext, hooks: HookConfig[], hookBase: Record<string, unknown>, settings: AgentSettings): Promise<ToolOutcome> {
		const journal = ctx.storageDir && ctx.sessionId && ctx.taskId ? beginExecution(ctx.storageDir, { sessionId: ctx.sessionId, taskId: ctx.taskId, callId: call.id, tool: call.name }, call.arguments || '{}') : undefined;
		const original = ctx;
		let refused = false;
		ctx = { ...ctx, requestApproval: async request => {
			const handle = await original.requestApproval(request);
			journal?.approval(handle.approved, handle.auto);
			refused ||= !handle.approved;
			return handle;
		} };
		try {
			const outcome = await this.runScheduled(call, ctx, hooks, hookBase, settings);
			journal?.finish(refused || outcome.summary.startsWith('blocked by') ? 'refused' : outcome.error ? 'failed' : 'completed');
			return outcome;
		} catch (error) {
			// A thrown or cancelled call may already have affected the outside world.
			journal?.finish('unknown');
			throw error;
		}
	}
	private async runScheduled(call: ToolCall, ctx: ToolContext, hooks: HookConfig[], hookBase: Record<string, unknown>, settings: AgentSettings): Promise<ToolOutcome> {
		const policy = toolPolicyError(call.name, ctx);
		if (policy) return { api: `Error: ${policy}`, summary: 'blocked by agent policy', error: true };
		ctx.checkTaskBudget?.();
		// Delegation/waits never hold a leaf-tool permit: their children use this same pool.
		if (['task', 'agent_send', 'agent_result', 'ask_user'].includes(call.name)) {
			ctx.signal.throwIfAborted();
			return this.runGates(call, ctx, hooks, hookBase, settings);
		}
		const mcp = call.name.startsWith('mcp__');
		const browser = call.name.startsWith('browser_') || call.name === 'computer';
		return this.scheduler.run(mcp ? 'mcp' : browser ? 'browser' : 'workspace', mcp ? settings.mcpConcurrency ?? 4 : browser ? 1 : settings.toolConcurrency ?? 8,
			!this.parallelSafe(call), ctx.signal, () => this.runGates(call, ctx, hooks, hookBase, settings), (t) => ctx.onToolTiming?.(call.id, t));
	}
	private async runGates(
		call: ToolCall,
		ctx: ToolContext,
		hooks: HookConfig[],
		hookBase: Record<string, unknown>,
		settings: AgentSettings
	): Promise<ToolOutcome> {
		ctx.signal.throwIfAborted();
		ctx.checkTaskBudget?.();
		if (call.arguments && !isJsonObject(call.arguments)) {
			const fixed = parseToolArgs(call.arguments);
			if (fixed) call.arguments = JSON.stringify(fixed);
		}
		let parsedArgs: unknown = {};
		try {
			parsedArgs = JSON.parse(call.arguments || '{}');
		} catch {
			parsedArgs = call.arguments;
		}
		const cwd = typeof hookBase.workspace === 'string' && hookBase.workspace ? hookBase.workspace : undefined;
		const pre = hooks.length ? await runHooks(hooks, 'PreToolUse', { ...hookBase, tool_name: call.name, tool_input: parsedArgs }, cwd, call.name, ctx.signal) : undefined;
		if (pre?.blocked) {
			return { api: `Blocked by a PreToolUse hook: ${pre.feedback}`, summary: 'blocked by hook', detail: pre.log.join('\n'), error: true };
		}
		const plain = !!parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs) ? (parsedArgs as Record<string, unknown>) : undefined;
		const runCore = async (e: unknown): Promise<{ outcome: ToolOutcome; event: unknown }> => {
			// A tool.call handler may have rewritten argument fields — sync them onto the call.
			const finalArgs = plain && e && typeof e === 'object' ? ({ ...(e as Record<string, unknown>) } as Record<string, unknown>) : plain;
			if (finalArgs) {
				delete finalArgs.tool;
				const next = JSON.stringify(finalArgs);
				if (next !== JSON.stringify(plain)) {
					call.arguments = next;
				}
			}
			
			
			ctx.signal.throwIfAborted(); ctx.checkTaskBudget?.();
			let outcome = await runTool(call, ctx);
			if (hooks.length) {
				const post = await runHooks(hooks, 'PostToolUse', { ...hookBase, tool_name: call.name, tool_input: parsedArgs, tool_output: outcome.api.slice(0, 20_000) }, cwd, call.name, ctx.signal);
				if (post.feedback) {
					outcome = { ...outcome, api: `${outcome.api}\n\n[PostToolUse hook feedback]\n${post.feedback}` };
				}
			}
			
			if (settings.redactSecrets) {
				const r = redactSecrets(outcome.api);
				if (r.count) {
					outcome = { ...outcome, api: r.text, summary: `${outcome.summary} · ${r.count} secret${r.count > 1 ? 's' : ''} hidden` };
				}
			}
			return { outcome, event: e };
		};
		
		
		return (await runCore(undefined)).outcome;
	}
}
