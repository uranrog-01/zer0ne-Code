import * as fs from 'fs';
import * as path from 'path';
import type { ApiFormat, ChatMessage, StreamOptions, StreamResult, ToolCall } from '../chatClient';
import { streamChat } from '../chatClient';
import { elideRepeat } from '../tools/tokenSaver';
import { redactSecrets } from '../tools/redact';
import type { CoreTools, ToolResult } from './tools';
import { prepareAgentContext, runAgentTurn, withOverflowRecovery, withRetry } from './turn';
import { ToolScheduler } from './toolScheduler';
import { runtimeDate } from '../prefixStability';
import { UNTRUSTED_RULE } from './untrusted';

/** Core tools with no side effects: consecutive calls run in parallel. */
const PARALLEL = new Set(['list_files', 'read_file', 'grep']);

/**
 * The agent loop without VS Code: model ↔ tools until the model answers.
 * Shared by the CLI, the ACP server and the worktree writer subagents.
 */

/**
 * How much of one tool result the model may see. Every path uses this ceiling:
 * a result that fills the window on its own forces the next request over the
 * limit, and the overflow recovery then shrinks the conversation and retries.
 */
export const TOOL_OUTPUT_MAX_CHARS = 60_000;

export interface CoreProvider {
	baseUrl: string;
	apiKey: string;
	apiFormat: ApiFormat;
	model: string;
}

export interface CoreRun {
	/** Host gates around core dispatch (writers share the parent's hooks). */
	executeTool?(call: ToolCall, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
	checkTaskBudget?(): void;
	toolScheduler?: ToolScheduler;
	toolConcurrency?: number;
	provider: CoreProvider;
	tools: CoreTools;
	/** The conversation so far; the loop appends to it (reuse it for follow-ups). */
	messages: ChatMessage[];
	system?: string;
	maxSteps?: number;
	maxTokens?: number;
	contextWindow?: number;
	effort?: StreamOptions['effort'];
	signal?: AbortSignal;
	cacheKey?: string;
	profile?: Pick<StreamOptions, 'reasoningControl' | 'cacheTtl' | 'promptCache' | 'strictTools'>;
	requestContext?: StreamOptions['requestContext'];
	/** Desktop writers use the host's metered caller; the CLI uses streamChat. */
	callModel?: (options: StreamOptions) => Promise<StreamResult>;
	onAttempt?: StreamOptions['onAttempt'];
	onText?(t: string): void;
	onReasoning?(t: string): void;
	onToolStart?(call: ToolCall, args: Record<string, unknown>): void;
	onToolEnd?(call: ToolCall, result: ToolResult): void;
	/** A transient provider error is being retried. */
	onRetry?(message: string, waitMs: number): void;
	drainSteer?(): string[];
	onCheckpoint?(): void;
}

export interface CoreResult {
	truncated?: boolean;
	text: string;
	stopReason: 'end_turn' | 'max_turn_requests' | 'cancelled';
	steps: number;
	usage: { input: number; output: number; cached: number };
	files: string[];
}

/** Project instructions every agent CLI reads: AGENTS.md (the open standard), CLAUDE.md, .zer0ne/instructions.md. */
export function projectInstructions(root: string, limit = 12_000): string {
	const out: string[] = [];
	for (const name of ['AGENTS.md', 'CLAUDE.md', path.join('.zer0ne', 'instructions.md')]) {
		try {
			const text = fs.readFileSync(path.join(root, name), 'utf8').trim();
			if (text) out.push(`# ${name.replace(/\\/g, '/')}\n${text.slice(0, limit)}`);
		} catch {
			// not there
		}
	}
	return out.length ? `\n\nProject instructions (follow them):\n${out.join('\n\n')}` : '';
}

export function coreSystemPrompt(root: string, extra = ''): string {
	return [
		'You are zer0ne, a coding agent working directly in the user\'s project.',
		`Project folder: ${root}. Platform: ${process.platform}.`,
		'Explore before changing things (list_files, grep, read_file), make focused edits (edit_file for small changes, apply_patch for several files, write_file for new files), then verify with run_command (build, tests, linters).',
		'Read several files at once when you can — independent reads run in parallel.',
		'Paths are relative to the project folder. Keep answers short: what you changed and how you verified it.',
		UNTRUSTED_RULE,
		extra
	]
		.filter(Boolean)
		.join('\n') + projectInstructions(root);
}

const parseArgs = (s: string): Record<string, unknown> => {
	try {
		const v = JSON.parse(s || '{}');
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
};

export async function runCore(o: CoreRun): Promise<CoreResult> {
	const scheduler = o.toolScheduler ?? new ToolScheduler();
	const usage = { input: 0, output: 0, cached: 0 };
	const files = new Set<string>();
	const system = o.system ?? coreSystemPrompt(o.tools.root);
	const latestUser = [...o.messages].reverse().find((m) => m.role === 'user');
	if (latestUser && !latestUser.content.includes('<runtime-context>Current UTC date:')) latestUser.content = runtimeDate(latestUser.content);
	const maxSteps = o.maxSteps ?? 0;
	const signal = o.signal ?? new AbortController().signal;
	let steps = 0;
	let text = '';
	try {
		const out = await runAgentTurn({
			messages: o.messages,
			maxSteps,
			signal,
			call: async (_step, onToolCall) => {
				const steer = o.drainSteer?.() ?? [];
				if (steer.length) o.messages.push({ role: 'user', content: `[Instructions received while working]\n${steer.join('\n\n')}` });
				o.onCheckpoint?.();
				steps++;
				let streamed = false;
				const tools = o.tools.defs(), toolChars = JSON.stringify(tools).length;
				const maxTokens = o.contextWindow ? prepareAgentContext(o.messages, { windowTokens: o.contextWindow, systemChars: system.length, toolChars, maxTokens: o.maxTokens }) : o.maxTokens;
				const result = await withOverflowRecovery(() => withRetry(
					() =>
						(o.callModel ?? streamChat)({
							baseUrl: o.provider.baseUrl,
							apiKey: o.provider.apiKey,
							apiFormat: o.provider.apiFormat,
							model: o.provider.model,
							...o.profile,
							system,
							messages: o.messages,
							tools,
							maxTokens,
							effort: o.effort,
							cacheKey: o.cacheKey,
							requestContext: { ...o.requestContext, step: _step },
							onAttempt: o.onAttempt,
							signal,
							onToolCall,
							onText: (t) => {
								streamed = true;
								o.onText?.(t);
							},
							onReasoning: (t) => {
								streamed = true;
								o.onReasoning?.(t);
							}
						}),
					{ signal, streamed: () => streamed, onRetry: o.onRetry }
				), { messages: o.messages, windowTokens: o.contextWindow, systemChars: system.length + toolChars, reservedTokens: maxTokens, streamed: () => streamed, onShrink: (n) => o.onRetry?.(`context full — trimmed ~${Math.round(n / 1000)}k tokens of old output`, 0) });
				usage.input += result.usage?.input ?? 0;
				usage.output += result.usage?.output ?? 0;
				usage.cached += result.usage?.cached ?? 0;
				text = result.text;
				return result;
			},
			parallelSafe: (call) => PARALLEL.has(call.name),
			onBatch: () => o.onCheckpoint?.(),
			beforeFinish: async () => { const steer = o.drainSteer?.() ?? []; return steer.length ? steer.join('\n\n') : undefined; },
			execute: async (call) => {
				const args = parseArgs(call.arguments);
				o.onToolStart?.(call, args);
				const r = await scheduler.run(`core:${o.tools.root}`, o.toolConcurrency ?? 8, !PARALLEL.has(call.name), signal, () => { o.checkTaskBudget?.(); return o.executeTool ? o.executeTool(call, args, signal) : o.tools.run(call.name, args, signal); });
				for (const l of r.locations ?? []) {
					if (call.name !== 'read_file' && call.name !== 'list_files') {
						files.add(l);
					}
				}
				o.onToolEnd?.(call, r);
				return { api: redactSecrets(r.output).text.slice(0, TOOL_OUTPUT_MAX_CHARS) };
			},
			transform: (call, api) => elideRepeat(o.messages, call.name, api)
		});
		return { text: out.text, stopReason: out.stopReason, steps: out.stopReason === 'max_turn_requests' ? maxSteps : out.steps, usage, files: [...files], truncated: out.truncated };
	} catch (e) {
		if (signal.aborted) {
			return { text, stopReason: 'cancelled', steps, usage, files: [...files] };
		}
		throw e;
	}
}
