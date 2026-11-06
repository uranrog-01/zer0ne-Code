import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import type { ToolContext, ApprovalHandle } from './agentTools';
import { killTree, psCommand, scrubEnv } from './proc';
import { denyReadPaths, sandboxSpawn, sandboxDenyPaths, type SandboxSpawn } from './sandbox';
import { COMMAND_RULES_FILE, commandRuleReason, commandVerdict, readCommandRules, waitsForTrust } from './commandRules';
import { encodeJobArgs, jobGuardExe } from './jobGuard';

export type CommandContext = Omit<Pick<ToolContext, 'settings' | 'signal' | 'requestApproval' | 'sandbox' | 'readOnly'>, 'settings'> & {
	settings: Pick<ToolContext['settings'], 'commandTool' | 'hideCommandSecrets' | 'sandboxDenyRead'>;
	/** Worktrees inherit the originating project's policy, rather than a worker-edited copy. */
	commandRulesRoot?: string;
	env?: NodeJS.ProcessEnv;
};
export interface CommandPlan { handle: ApprovalHandle; spec?: SandboxSpawn; root?: string; cwd: string; env: NodeJS.ProcessEnv; guard?: string; command?: string; used?: boolean }
export interface CommandResult { code: number | null; out: string; timedOut: boolean; movedTo?: string }
/**
 * A command still running after `afterMs` stops holding the step: `adopt` takes over the live process (its output so
 * far, its later output and its end) and returns the id it is followed by. Its timeout still applies.
 */
export interface CommandDetach { afterMs: number; adopt(child: import('child_process').ChildProcess, out: string): string }

const stopped = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });

function checkDirectory(root: string, cwd: string): void {
	if (fs.realpathSync(root) !== root || fs.realpathSync(cwd) !== cwd) throw new Error('The command directory changed after it was reviewed. Request approval again.');
	const relative = path.relative(root, cwd);
	if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Commands must run inside the workspace.');
}

/** The environment agent commands run with; `hideSecrets` drops credential-shaped variables (API keys, tokens, passwords). */
export function commandEnv(hideSecrets = false, overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const inherited = { ...process.env, ...overrides };
	const home = inherited.HOME || inherited.USERPROFILE || '';
	const cargo = home ? path.join(home, '.cargo', 'bin') : '';
	const overridePath = Object.entries(overrides ?? {}).find(([key]) => process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH');
	const current = overridePath ? overridePath[1] ?? '' : process.env.PATH || '';
	const env = hideSecrets ? scrubEnv(inherited) : inherited;
	// Node selects only one case-insensitive key on Windows; never send both Path and PATH.
	if (process.platform === 'win32') for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
	return { ...env, PATH: cargo && !current.split(path.delimiter).includes(cargo) ? cargo + path.delimiter + current : current, CI: '1', NO_COLOR: '1', TERM: 'dumb' };
}

export function commandSpawn(command: string, env = commandEnv()): SandboxSpawn {
	return process.platform === 'win32'
		? { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', psCommand(command)], env }
		: { file: process.env.SHELL || '/bin/sh', args: ['-c', command], env };
}

/** Verification and model commands share this gate; a check never implies permission to execute. */
export async function approveCommand(command: string, root: string, cwd: string, ctx: CommandContext, background = false, escalate = false): Promise<CommandPlan> {
	if (!ctx.settings.commandTool) throw new Error('Terminal commands are disabled in settings.');
	if (ctx.readOnly) throw new Error('Commands are unavailable in read-only mode.');
	if (!command.trim() || command.includes('\0')) throw new Error('Choose a nonempty command without NUL characters.');
	if (ctx.signal.aborted) throw stopped();
	const approvedRoot = fs.realpathSync(root), approvedCwd = fs.realpathSync(cwd);
	const relative = path.relative(approvedRoot, approvedCwd);
	if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Commands must run inside the workspace.');
	// The project's command rules: deny never runs, ask always shows a card, allow skips it.
	const rules = readCommandRules(ctx.commandRulesRoot ?? root);
	const verdict = commandVerdict(rules, command) ?? (waitsForTrust(rules, command) ? 'pending' : undefined);
	// A rule can say why it exists; that reason follows the decision into the card or the refusal.
	const why = verdict && verdict !== 'pending' ? commandRuleReason(rules, command, verdict) : undefined;
	if (verdict === 'deny') throw new Error(`This project's command rules (${COMMAND_RULES_FILE.split(path.sep).join('/')}) block that command.${why ? ` Reason: ${why}` : ''} Do not retry it; ask the user if it is needed.`);
	const sb = ctx.sandbox;
	const env = commandEnv(ctx.settings.hideCommandSecrets !== false, ctx.env);
	const denyRead = sb && sb.mode !== 'off' && !escalate ? sandboxDenyPaths(ctx.settings, sb.storageDir) : [];
	const userDenyRead = sb && sb.mode !== 'off' && !escalate ? denyReadPaths(ctx.settings.sandboxDenyRead ?? '').length : 0;
	const spec = sb && sb.mode !== 'off' && !escalate ? sandboxSpawn(command, { root, storageDir: sb.storageDir, sourceFile: sb.sourceFile, network: sb.network, env, denyRead }) : undefined;
	// An unavailable sandbox cannot fall through an allowlist or auto-approval rule.
	const outsideSandbox = escalate || !!(sb && sb.mode !== 'off' && !spec);
	const handle = await ctx.requestApproval({ kind: 'command', command: background ? `${command}   # background` : command, sandboxed: spec ? true : undefined, escalate: outsideSandbox || undefined, projectRule: verdict, projectRuleReason: verdict === 'ask' ? why : undefined, sandboxReads: spec && userDenyRead === 0 ? 'all' : undefined });
	if (ctx.signal.aborted) { handle.finish('Stopped.', true); throw stopped(); }
	try { checkDirectory(approvedRoot, approvedCwd); } catch (error) { handle.finish(String(error), true); throw error; }
	// The job supervisor is prepared before the child starts (a compile must not
	// count against the command's own timeout) and rides with the same plan.
	// The Windows sandbox is the job supervisor itself (it applies the restricted token).
	const guard = spec && spec.env.ZER0NE_SANDBOX !== 'windows' ? undefined : await jobGuardExe({ storageDir: sb?.storageDir ?? path.join(os.tmpdir(), 'zer0ne-command-supervisor'), sourceFile: sb?.sourceFile ?? path.resolve(__dirname, '../../media/sandbox/lowil.cs'), signal: ctx.signal });
	if (ctx.signal.aborted) { handle.finish('Stopped.', true); throw stopped(); }
	// The approval is bound to this exact command (executeCommand refuses to run
	// anything else off this plan) and single-use (a plan cannot run twice).
	return { handle, spec: spec && (sb!.mode === 'always' || handle.auto) ? spec : undefined, root: approvedRoot, cwd: approvedCwd, env, guard, command };
}

export function commandLaunch(command: string, plan: Pick<CommandPlan, 'spec' | 'env' | 'guard'>): SandboxSpawn {
	const spec = plan.spec || commandSpawn(command, plan.env);
	// A sandboxed command never runs without its sandbox.
	if (spec.env.ZER0NE_SANDBOX === 'windows' && (!plan.guard || process.platform !== 'win32')) throw new Error('The command sandbox is unavailable: its helper could not be prepared. Request approval to run outside the sandbox.');
	return plan.guard && process.platform === 'win32' ? { file: plan.guard, args: [], env: { ...spec.env, ZER0NE_JOB_FILE: spec.file, ZER0NE_JOB_ARGS: encodeJobArgs(spec.args), ZER0NE_JOB_VERBATIM: spec.windowsVerbatimArguments ? '1' : '0' } } : spec;
}

export function executeCommand(command: string, plan: CommandPlan, timeoutMs: number, signal: AbortSignal, detach?: CommandDetach): Promise<CommandResult> {
	if (!plan.handle.approved) throw new Error('The command was not approved.');
	if (plan.used) throw new Error('This approval was already used. Request approval again to run the command.');
	if (plan.command !== undefined && plan.command !== command) throw new Error('The command changed after it was approved. Request approval again.');
	plan.used = true;
	if (signal.aborted) { plan.handle.finish('Stopped.', true); return Promise.reject(stopped()); }
	if (plan.root) { try { checkDirectory(plan.root, plan.cwd); } catch (error) { plan.handle.finish(String(error), true); return Promise.reject(error); } }
	let spec: SandboxSpawn;
	try { spec = commandLaunch(command, plan); } catch (error) { plan.handle.finish(String(error), true); return Promise.reject(error); }
	return new Promise((resolve, reject) => {
		const child = spawn(spec.file, spec.args, { cwd: plan.cwd, env: spec.env, windowsHide: true, detached: process.platform !== 'win32', windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '', stderr = '', timedOut = false, done = false;
		const cap = 16 * 1024 * 1024;
		child.stdout?.on('data', (c: Buffer) => { stdout = (stdout + c.toString('utf8')).slice(-cap); });
		child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString('utf8')).slice(-cap); });
		const onAbort = () => killTree(child);
		const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
		// The step moves on; the process, its timeout and its output go to the background registry.
		const moveTimer = detach && detach.afterMs < timeoutMs ? setTimeout(() => {
			if (done) return;
			done = true;
			signal.removeEventListener('abort', onAbort);
			const out = [stdout, stderr].filter(s => s.trim()).join('\n--- stderr ---\n');
			child.stdout?.removeAllListeners('data');
			child.stderr?.removeAllListeners('data');
			child.once('close', () => clearTimeout(timer));
			const id = detach.adopt(child, out);
			plan.handle.finish(`still running after ${Math.round(detach.afterMs / 1000)}s: moved to the background as ${id}\n${out.slice(-2000)}`, false);
			resolve({ code: null, out, timedOut: false, movedTo: id });
		}, detach.afterMs) : undefined;
		const finish = (code: number | null, extra = '') => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearTimeout(moveTimer);
			signal.removeEventListener('abort', onAbort);
			if (signal.aborted) { plan.handle.finish('Stopped.', true); reject(stopped()); return; }
			const out = [stdout, stderr + extra].filter(s => s.trim()).join('\n--- stderr ---\n');
			plan.handle.finish(`${timedOut ? 'timed out' : 'exit code ' + code}\n${out.slice(0, 4000)}`, code !== 0);
			resolve({ code, out, timedOut });
		};
		child.once('error', error => finish(1, '\n' + error.message));
		child.once('close', code => finish(code));
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}
