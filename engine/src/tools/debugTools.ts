import * as vscode from 'vscode';
import type { ToolDef } from '../chatClient';

/**
 * Debugger control for the agent (like oh-my-pi's debugger tools), on top of
 * VS Code's Debug API and the Debug Adapter Protocol:
 *
 *   debug_start       start a launch.json configuration (or an inline one)  — approval
 *   debug_breakpoint  add / remove a (conditional) breakpoint
 *   debug_state       where it stopped: stack, locals, recent console output
 *   debug_control     continue / next / step_in / step_out / pause / restart / stop
 *   debug_evaluate    evaluate an expression in the paused frame          — approval
 *
 * A tracker on every debug adapter records `stopped` events and console output,
 * so the agent sees why and where the program paused.
 */

const OUTPUT_KEEP = 12_000;

interface SessionLog {
	output: string;
	stopped?: { reason: string; threadId?: number; text?: string; at: number };
	terminated?: boolean;
}

const logs = new Map<string, SessionLog>();
const waiters = new Set<() => void>();

function log(id: string): SessionLog {
	let l = logs.get(id);
	if (!l) {
		l = { output: '' };
		logs.set(id, l);
	}
	return l;
}

/** Register once at activation. */
export function registerDebugTracker(): vscode.Disposable {
	return vscode.Disposable.from(
		vscode.debug.registerDebugAdapterTrackerFactory('*', {
			createDebugAdapterTracker(session) {
				return {
					onDidSendMessage(m: any) {
						if (m?.type !== 'event') {
							return;
						}
						const l = log(session.id);
						if (m.event === 'output' && m.body?.output && m.body.category !== 'telemetry') {
							l.output = (l.output + m.body.output).slice(-OUTPUT_KEEP);
						} else if (m.event === 'stopped') {
							l.stopped = { reason: m.body?.reason ?? 'paused', threadId: m.body?.threadId, text: m.body?.text ?? m.body?.description, at: Date.now() };
							waiters.forEach((w) => w());
						} else if (m.event === 'continued') {
							l.stopped = undefined;
						} else if (m.event === 'terminated' || m.event === 'exited') {
							l.terminated = true;
							waiters.forEach((w) => w());
						}
					}
				};
			}
		}),
		vscode.debug.onDidTerminateDebugSession((s) => {
			log(s.id).terminated = true;
			waiters.forEach((w) => w());
		})
	);
}

/** Resolve after the next stop / termination, or after `ms`. */
function nextStop(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			waiters.delete(done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		waiters.add(done);
	});
}

function obj(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: 'object', properties, required, additionalProperties: false };
}

export const DEBUG_APPROVAL = new Set(['debug_start', 'debug_evaluate']);
export const DEBUG_READ_ONLY = new Set(['debug_state']);

export function debugToolDefs(): ToolDef[] {
	return [
		{
			name: 'debug_start',
			description: 'Start debugging: a configuration name from .vscode/launch.json, or an inline configuration ({ type, request, program, args, … }). Returns once the session starts (or stops at a breakpoint / entry).',
			parameters: obj({ name: { type: 'string', description: 'launch.json configuration name' }, config: { type: 'object', description: 'Inline debug configuration (when there is no launch.json entry)' }, stop_on_entry: { type: 'boolean' } })
		},
		{
			name: 'debug_breakpoint',
			description: 'Add or remove a source breakpoint (optionally conditional or a logpoint).',
			parameters: obj({ path: { type: 'string' }, line: { type: 'number', description: '1-based line' }, condition: { type: 'string' }, log_message: { type: 'string', description: 'Logpoint message instead of pausing, e.g. "x = {x}"' }, remove: { type: 'boolean' } }, ['path', 'line'])
		},
		{
			name: 'debug_state',
			description: 'Current debug session: why/where it stopped, the call stack, local variables of the top frame, breakpoints and recent debug-console output.',
			parameters: obj({ frames: { type: 'number', description: 'Stack frames to show (default 8)' } })
		},
		{
			name: 'debug_control',
			description: 'Drive the paused program: continue, next (step over), step_in, step_out, pause, restart or stop. Waits up to wait_seconds for the next stop and returns the new state.',
			parameters: obj({ action: { type: 'string', enum: ['continue', 'next', 'step_in', 'step_out', 'pause', 'restart', 'stop'] }, wait_seconds: { type: 'number' } }, ['action'])
		},
		{
			name: 'debug_evaluate',
			description: 'Evaluate an expression in the paused frame (can have side effects).',
			parameters: obj({ expression: { type: 'string' }, frame: { type: 'number', description: 'Frame index from debug_state (default 0 = top)' } }, ['expression'])
		}
	];
}

function active(): vscode.DebugSession {
	const s = vscode.debug.activeDebugSession;
	if (!s) {
		throw new Error('No debug session is running. Start one with debug_start.');
	}
	return s;
}

async function threadId(s: vscode.DebugSession): Promise<number> {
	const stopped = logs.get(s.id)?.stopped?.threadId;
	if (stopped !== undefined) {
		return stopped;
	}
	const r = await s.customRequest('threads');
	const id = r?.threads?.[0]?.id;
	if (id === undefined) {
		throw new Error('The debug adapter reported no threads.');
	}
	return id;
}

async function frameIds(s: vscode.DebugSession, count: number): Promise<Array<{ id: number; name: string; where: string }>> {
	const r = await s.customRequest('stackTrace', { threadId: await threadId(s), startFrame: 0, levels: count });
	return (r?.stackFrames ?? []).map((f: any) => ({
		id: f.id,
		name: f.name,
		where: f.source?.path ? `${vscode.workspace.asRelativePath(f.source.path)}:${f.line}` : f.source?.name ? `${f.source.name}:${f.line}` : `line ${f.line}`
	}));
}

async function describe(frames = 8): Promise<string> {
	const s = vscode.debug.activeDebugSession;
	const bps = vscode.debug.breakpoints
		.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint)
		.map((b) => `${vscode.workspace.asRelativePath(b.location.uri)}:${b.location.range.start.line + 1}${b.condition ? ` if ${b.condition}` : ''}${b.logMessage ? ` log "${b.logMessage}"` : ''}${b.enabled ? '' : ' (disabled)'}`);
	if (!s) {
		return `No active debug session.${bps.length ? `\nBreakpoints: ${bps.join(', ')}` : ''}`;
	}
	const l = log(s.id);
	const out: string[] = [`Session: ${s.name} (${s.type})`];
	if (l.terminated) {
		out.push('State: terminated');
	} else if (l.stopped) {
		out.push(`State: paused (${l.stopped.reason}${l.stopped.text ? `: ${l.stopped.text}` : ''})`);
		try {
			const stack = await frameIds(s, frames);
			out.push('', 'Call stack:', ...stack.map((f, i) => `  #${i} ${f.name} — ${f.where}`));
			if (stack[0]) {
				const scopes = await s.customRequest('scopes', { frameId: stack[0].id });
				for (const scope of (scopes?.scopes ?? []).slice(0, 2)) {
					if (scope.expensive) {
						continue;
					}
					const vars = await s.customRequest('variables', { variablesReference: scope.variablesReference });
					const lines = (vars?.variables ?? []).slice(0, 40).map((v: any) => `  ${v.name}: ${String(v.value).slice(0, 200)}${v.type ? ` (${v.type})` : ''}`);
					out.push('', `${scope.name}:`, ...(lines.length ? lines : ['  (none)']));
				}
			}
		} catch (e) {
			out.push(`(could not read the stack: ${e instanceof Error ? e.message : String(e)})`);
		}
	} else {
		out.push('State: running');
	}
	if (bps.length) {
		out.push('', `Breakpoints: ${bps.join(', ')}`);
	}
	const tail = l.output.trim().split('\n').slice(-40).join('\n');
	if (tail) {
		out.push('', 'Debug console (latest):', tail);
	}
	return out.join('\n');
}

function resolvePath(p: string): vscode.Uri {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!root) {
		throw new Error('Open a folder first.');
	}
	return /^([a-zA-Z]:[\\/]|\/)/.test(p) ? vscode.Uri.file(p) : vscode.Uri.joinPath(root, p.replace(/^\.?\//, ''));
}

export async function runDebugTool(name: string, args: Record<string, unknown>, approve: (what: string) => Promise<boolean>): Promise<{ api: string; summary: string; error?: boolean } | undefined> {
	switch (name) {
		case 'debug_start': {
			const folder = vscode.workspace.workspaceFolders?.[0];
			const config = args.config && typeof args.config === 'object' ? (args.config as vscode.DebugConfiguration) : undefined;
			const label = typeof args.name === 'string' && args.name ? args.name : config ? `${config.type ?? '?'} ${config.program ?? config.module ?? ''}`.trim() : '';
			if (!label) {
				throw new Error('Give a launch.json configuration name or an inline config.');
			}
			if (!(await approve(`debug: start "${label}"`))) {
				return { api: 'The user declined to start the debugger.', summary: 'rejected', error: true };
			}
			const cfg = config ? { ...config, name: config.name ?? label, ...(args.stop_on_entry ? { stopOnEntry: true } : {}) } : label;
			const waiting = nextStop(8000);
			const ok = await vscode.debug.startDebugging(folder, cfg as any);
			if (!ok) {
				return { api: `The debugger did not start "${label}". Check the configuration (debug_state shows console output).`, summary: 'failed', error: true };
			}
			await waiting;
			return { api: await describe(), summary: `started ${label}` };
		}
		case 'debug_breakpoint': {
			const uri = resolvePath(String(args.path ?? ''));
			const line = Math.max(1, Math.floor(Number(args.line) || 1));
			const existing = vscode.debug.breakpoints.filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === uri.toString() && b.location.range.start.line === line - 1);
			if (args.remove === true) {
				vscode.debug.removeBreakpoints(existing);
				return { api: `Removed ${existing.length} breakpoint(s) at ${vscode.workspace.asRelativePath(uri)}:${line}.`, summary: `removed :${line}` };
			}
			vscode.debug.removeBreakpoints(existing);
			const cond = typeof args.condition === 'string' && args.condition ? args.condition : undefined;
			const logMsg = typeof args.log_message === 'string' && args.log_message ? args.log_message : undefined;
			vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)), true, cond, undefined, logMsg)]);
			return { api: `Breakpoint set at ${vscode.workspace.asRelativePath(uri)}:${line}${cond ? ` when ${cond}` : ''}${logMsg ? ` (logpoint "${logMsg}")` : ''}.`, summary: `${vscode.workspace.asRelativePath(uri)}:${line}` };
		}
		case 'debug_state':
			return { api: await describe(Math.min(30, Number(args.frames) || 8)), summary: vscode.debug.activeDebugSession?.name ?? 'no session' };
		case 'debug_control': {
			const s = active();
			const action = String(args.action);
			const wait = Math.min(30, Math.max(0, Number(args.wait_seconds) || 5)) * 1000;
			if (action === 'stop') {
				await vscode.debug.stopDebugging(s);
				return { api: 'Debug session stopped.', summary: 'stopped' };
			}
			if (action === 'restart') {
				await vscode.commands.executeCommand('workbench.action.debug.restart');
				await nextStop(wait);
				return { api: await describe(), summary: 'restarted' };
			}
			const req = { continue: 'continue', next: 'next', step_in: 'stepIn', step_out: 'stepOut', pause: 'pause' }[action];
			if (!req) {
				throw new Error(`Unknown action "${action}".`);
			}
			const tid = await threadId(s);
			const l = log(s.id);
			l.stopped = undefined;
			const waiting = nextStop(wait);
			await s.customRequest(req, { threadId: tid });
			await waiting;
			return { api: await describe(), summary: action };
		}
		case 'debug_evaluate': {
			const s = active();
			const expression = String(args.expression ?? '');
			if (!(await approve(`debug: evaluate ${expression}`))) {
				return { api: 'The user declined the evaluation.', summary: 'rejected', error: true };
			}
			const frames = await frameIds(s, Math.max(1, (Number(args.frame) || 0) + 1));
			const frame = frames[Math.min(frames.length - 1, Number(args.frame) || 0)];
			const r = await s.customRequest('evaluate', { expression, frameId: frame?.id, context: 'repl' });
			return { api: `${expression} = ${r?.result ?? '(no result)'}${r?.type ? ` (${r.type})` : ''}`, summary: String(r?.result ?? '').slice(0, 80) };
		}
	}
	return undefined;
}
