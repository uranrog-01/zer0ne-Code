import { redactSecrets } from './redact';
import { spawn } from 'child_process';
import { psCommand } from './proc';
import type { HookConfig } from '../providerStore';
import { killTree } from './proc';

/**
 * Hooks: user-configured shell commands that run at agent lifecycle
 * events (the supported command-hook subset):
 *
 *  - SessionStart       when a chat's first turn runs. stdout is added as
 *                       extra context for that turn.
 *  - UserPromptSubmit   before a prompt is sent. stdout is added as extra
 *                       context; exit code 2 blocks the prompt (stderr = reason).
 *  - PreToolUse         before a tool runs (matcher = tool-name regex).
 *                       Exit code 2 blocks the call; stderr goes to the agent.
 *  - PostToolUse        after a tool ran. Exit code 2 sends stderr to the agent
 *                       as feedback (e.g. "lint failed: …").
 *  - Notification       when an announcement or needs-attention signal is sent.
 *  - PreCompact         before auto compaction summarizes the conversation.
 *  - SubagentStart      after a subagent is launched (matcher = agent name).
 *  - SubagentStop       when a background subagent finishes (matcher = agent name).
 *  - Stop               when the agent finishes a turn (required hooks gate it).
 *  - SessionEnd         when the chat is deleted or its workspace closes.
 *
 * The event is passed as JSON on stdin and as ZER0NE_* environment variables.
 */

export interface HookRun {
	validationFailed?: boolean;
	executions?: HookExecution[];
	blocked: boolean;
	/** Reason / feedback for the agent (stderr of exit-2 hooks). */
	feedback: string;
	/** Extra context (stdout) from UserPromptSubmit hooks. */
	context: string;
	/** Short log for the chat card. */
	log: string[];
}

export interface HookExecution {
	hookId: string; event: string; at: number; durationMs: number;
	code: number; stdout: string; stderr: string; timedOut: boolean; required: boolean;
}
const history = new Map<string, HookExecution[]>();
export function hookHistory(cwd = ''): HookExecution[] { return history.get(cwd) ?? []; }

export async function runHooks(
	hooks: HookConfig[],
	event: HookConfig['event'],
	payload: Record<string, unknown>,
	cwd: string | undefined,
	toolName?: string,
	signal?: AbortSignal
): Promise<HookRun> {
	const result: HookRun = { blocked: false, feedback: '', context: '', log: [] };
	const matching = hooks.filter((h) => {
		if (!h.enabled || h.event !== event) {
			return false;
		}
		if (!toolName || !h.matcher) {
			return true;
		}
		try {
			return new RegExp(h.matcher).test(toolName);
		} catch {
			return false;
		}
	});
	for (const hook of matching) {
		signal?.throwIfAborted();
		const at = Date.now();
		const r = await runOne(hook, { ...payload, event }, cwd, signal);
		const execution = { hookId: hook.id, event, at, durationMs: Date.now() - at, ...r, stdout: redactSecrets(r.stdout).text, stderr: redactSecrets(r.stderr).text, required: event === 'Stop' && hook.required === true };
		(result.executions ??= []).push(execution);
		history.set(cwd ?? '', [execution, ...hookHistory(cwd)].slice(0, 50));
		if (execution.required && r.code !== 0) result.validationFailed = true;
		const label = hook.command.length > 60 ? hook.command.slice(0, 60) + '…' : hook.command;
		if (r.code === 2) {
			result.blocked = event !== 'PostToolUse' && event !== 'Stop';
			result.feedback += (r.stderr || r.stdout || 'Blocked by hook.').trim() + '\n';
			result.log.push(`${label} → exit 2 (${result.blocked ? 'blocked' : 'feedback'})`);
			if (result.blocked) {
				break;
			}
		} else if (r.code !== 0) {
			result.log.push(`${label} → exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`);
		} else {
			result.log.push(`${label} → ok`);
			if ((event === 'UserPromptSubmit' || event === 'SessionStart') && r.stdout.trim()) {
				result.context += r.stdout.trim() + '\n';
			}
		}
	}
	result.feedback = result.feedback.trim().slice(0, 8000);
	result.context = result.context.trim().slice(0, 20_000);
	return result;
}

function runOne(hook: HookConfig, payload: Record<string, unknown>, cwd: string | undefined, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const isWin = process.platform === 'win32';
		// PowerShell can return before a GUI executable (including Electron in Node mode).
		// Keep its parent alive while owned children run so taskkill can end the whole tree.
		// Console hosts depend on the parent exiting, so waiting on them would deadlock.
		const command = isWin ? `try {\n${psCommand(hook.command)}\n} finally { Get-CimInstance Win32_Process -Filter "ParentProcessId=$PID" | Where-Object { $_.Name -notin @('conhost.exe', 'OpenConsole.exe') } | ForEach-Object { Wait-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } }` : hook.command;
		const child = isWin
			? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true, env: envFor(payload) })
			: spawn(process.env.SHELL || '/bin/sh', ['-c', hook.command], { cwd, env: envFor(payload), detached: true });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const abort = () => killTree(child);
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		const finish = (result: { code: number; stdout: string; stderr: string; timedOut: boolean }) => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			if (signal?.aborted) reject(Object.assign(new Error('Hook stopped'), { name: 'AbortError' }));
			else resolve(result);
		};
		child.stdout.on('data', (c) => (stdout = (stdout + c).slice(-20_000)));
		child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-20_000)));
		const timer = setTimeout(() => {
			timedOut = true;
			killTree(child);
		}, hook.timeoutSec * 1000);
		child.on('error', (err) => {
			finish({ code: 1, stdout, stderr: err.message, timedOut });
		});
		child.on('close', (code) => {
			finish({ code: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
		});
		child.stdin.on('error', () => undefined);
		child.stdin.end(JSON.stringify(payload));
	});
}

function envFor(payload: Record<string, unknown>): NodeJS.ProcessEnv {
	return {
		...process.env,
		ZER0NE_EVENT: String(payload.event ?? ''),
		ZER0NE_TOOL: String(payload.tool_name ?? ''),
		ZER0NE_WORKSPACE: String(payload.workspace ?? '')
	};
}
