import * as vscode from 'vscode';
import { hostSettings } from './capabilities';
import * as fs from 'fs';
import * as path from 'path';
import { newId } from '../providerStore';
import type { AgentSettings, StoredMessage } from '../providerStore';
import { resolveInWorkspace, workspaceRoot } from '../tools/agentTools';
import { approveCommand, executeCommand, type CommandContext } from '../tools/command';
import { compressOutput } from '../tools/tokenSaver';
import { randomUUID } from 'crypto';
import { checkConfiguration, projectFingerprint } from '../tools/projectChecks';
import type { ToolContext } from '../tools/agentTools';
import { beginExecution } from '../core/executionJournal';
import { redactSecrets } from '../tools/redact';
import { fenceToolOutput } from '../core/untrusted';

export interface VerifyDeps {
	scheduleState(): void;
}

export interface DetectedCommand {
	command: string;
	cwd?: string;
}

/**
 * Intelligently detect the project check/build/test command based on
 * project structure and edited file types.
 */
export function detectVerifyCommand(root: string, files: string[]): DetectedCommand | undefined {
	const has = (rel: string) => {
		try {
			return fs.existsSync(path.join(root, rel));
		} catch {
			return false;
		}
	};

	// 1. Rust / Cargo
	const hasRustFile = files.some((f) => f.endsWith('.rs') || f.startsWith('src-tauri/') || f.startsWith('src-tauri\\'));
	if (hasRustFile && has(path.join('src-tauri', 'Cargo.toml'))) {
		return { command: 'cargo check', cwd: path.join(root, 'src-tauri') };
	}
	if (has('Cargo.toml') && (hasRustFile || !files.length || files.some((f) => !f.endsWith('.md')))) {
		return { command: 'cargo check' };
	}

	// 2. Node / TypeScript / JavaScript
	const hasJsTs = files.some((f) => /\.[jt]sx?$/.test(f) || f.endsWith('.json') || f.endsWith('.vue') || f.endsWith('.svelte'));
	if (has('package.json')) {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
			const scripts = pkg.scripts || {};
			if (scripts.test && !/no test specified/i.test(scripts.test)) {
				return { command: 'npm test' };
			}
			if (scripts.check) {
				return { command: 'npm run check' };
			}
			if (scripts.typecheck) {
				return { command: 'npm run typecheck' };
			}
			if (has('tsconfig.json') && (hasJsTs || !files.length)) {
				return { command: 'npx tsc --noEmit' };
			}
			if (scripts.build) {
				return { command: 'npm run build' };
			}
		} catch {
			/* ignore read/parse errors */
		}
	}

	// 3. Python
	const hasPy = files.some((f) => f.endsWith('.py'));
	if (hasPy || has('pyproject.toml') || has('pytest.ini') || has('setup.cfg')) {
		if (has('pyproject.toml') || has('pytest.ini') || has('setup.cfg') || has('tests') || has('test')) {
			return { command: 'pytest' };
		}
	}

	// 4. Go
	const hasGo = files.some((f) => f.endsWith('.go'));
	if (hasGo || has('go.mod')) {
		if (has('go.mod')) {
			return { command: 'go test ./...' };
		}
	}

	return undefined;
}

/** Check if process failure was caused by a missing binary on PATH rather than code issues. */
export function isMissingBinary(output: string, command: string): boolean {
	const bin = command.split(/\s+/)[0].toLowerCase();
	const out = output.toLowerCase();
	return (
		out.includes(`'${bin}' is not recognized`) ||
		out.includes(`the term '${bin}' is not recognized`) ||
		out.includes(`command not found: ${bin}`) ||
		out.includes(`${bin}: command not found`) ||
		out.includes(`${bin}: not found`) ||
		out.includes(`no such file or directory: ${bin}`)
	);
}

/**
 * Auto-verify after edits: VS Code errors in the changed files and/or the
 * configured command (or intelligent auto-detected project checks like cargo check,
 * npm test, tsc, pytest, go test). Returns feedback for the model when something
 * fails (and fix rounds remain), undefined when everything passed.
 */
export class Verifier {
	constructor(private readonly d: VerifyDeps) {}

	/** A goal's acceptance command: one card, the usual approval, no fix rounds of its own. */
	async runGoalCheck(
		command: string,
		convo: StoredMessage[],
		settings: AgentSettings,
		signal: AbortSignal,
		commandContext?: CommandContext
	): Promise<{ status: 'passed' | 'failed' | 'skipped'; output: string }> {
		settings = hostSettings(settings);
		const mask = (text: string) => settings.redactSecrets ? redactSecrets(text).text : text;
		const root = workspaceRoot();
		if (root?.scheme !== 'file') return { status: 'skipped', output: 'no local project folder' };
		if (!settings.commandTool || !commandContext) return { status: 'skipped', output: !settings.commandTool ? 'terminal commands are disabled' : 'command permissions are unavailable' };
		const card: StoredMessage = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', tool: { name: 'verify', arg: mask(`goal check: ${command}`), status: 'running', summary: `checking the goal (${mask(command)})…` } };
		convo.push(card);
		this.d.scheduleState();
		try {
			const plan = await approveCommand(command, root.fsPath, root.fsPath, { ...commandContext, settings, signal });
			if (!plan.handle.approved) {
				card.tool = { ...card.tool!, status: 'error', summary: 'Goal check skipped — permission was declined' };
				return { status: 'skipped', output: 'permission was declined' };
			}
			const res = await executeCommand(command, plan, 300_000, signal);
			const passed = res.code === 0 && !res.timedOut, output = mask(compressOutput(res.out, 8_000).text);
			card.tool = { ...card.tool!, status: passed ? 'done' : 'error', summary: passed ? `Goal check passed (${mask(command)})` : `Goal check failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`})`, detail: passed ? undefined : output.slice(0, 4000) };
			return { status: passed ? 'passed' : 'failed', output: `${res.timedOut ? 'timed out' : `exit code ${res.code}`}\n${output}` };
		} catch (error) {
			card.tool = { ...card.tool!, status: 'error', summary: signal.aborted ? 'Goal check stopped' : 'Goal check could not run', detail: mask(String(error)) };
			if (signal.aborted) throw error;
			return { status: 'skipped', output: mask(String(error)).slice(0, 300) };
		} finally {
			this.d.scheduleState();
		}
	}

	async verifyTurn(
		convo: StoredMessage[],
		files: string[],
		settings: AgentSettings,
		state: { edits: number; checked: number; rounds: number },
		signal: AbortSignal,
		commandContext?: CommandContext & Pick<ToolContext, 'onFeatureReport' | 'storageDir' | 'sessionId' | 'taskId'>
	): Promise<string | undefined> {
		settings = hostSettings(settings);
		const mask = (text: string) => settings.redactSecrets ? redactSecrets(text).text : text;
		state.checked = state.edits;
		const root = workspaceRoot();

		let command = settings.verifyCommand.trim();
		let commandCwd = root?.fsPath;
		let isAuto = false;

		if (!command && root?.scheme === 'file' && settings.verifyAutoDetect !== false) {
			const detected = detectVerifyCommand(root.fsPath, files);
			if (detected) {
				command = detected.command;
				if (detected.cwd) commandCwd = detected.cwd;
				isAuto = true;
			}
		}

		if (!settings.verifyDiagnostics && !command) {
			return undefined;
		}

		const cardArg = mask(command ? (isAuto ? `${command} (auto)` : command) : 'diagnostics');
		const card: StoredMessage = {
			id: newId('t'),
			role: 'assistant',
			kind: 'tool',
			content: '',
			tool: {
				name: 'verify',
				arg: cardArg,
				status: 'running',
				summary: command ? `checking (${command})…` : 'checking…'
			}
		};

		// Shown before the answer it checks (the answer was already streamed).
		const answerAt = convo.map((m) => m.role === 'assistant' && !m.kind && !m.isError && !m.local).lastIndexOf(true);
		const answer = answerAt >= 0 ? convo[answerAt] : undefined;
		convo.splice(answerAt >= 0 ? answerAt : convo.length, 0, card);
		this.d.scheduleState();

		const problems: string[] = [];
		const notes: string[] = [];
		let completed = 0;
		let skipped = false;

		if (settings.verifyDiagnostics && files.length) {
			completed++;
			await new Promise((r) => setTimeout(r, 1200)); // let language servers catch up with the writes
			const errors: string[] = [];
			for (const rel of files) {
				let uri: vscode.Uri;
				try {
					uri = resolveInWorkspace(rel);
				} catch {
					continue;
				}
				for (const d of vscode.languages.getDiagnostics(uri) ?? []) {
					if (d.severity === vscode.DiagnosticSeverity.Error) {
						errors.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ${d.source ? `[${d.source}] ` : ''}${d.message}`);
					}
				}
			}
			if (errors.length) {
				problems.push(`VS Code reports ${errors.length} error${errors.length > 1 ? 's' : ''} in the files you changed:\n${errors.slice(0, 40).join('\n')}`);
			} else {
				notes.push(`no errors in ${files.length} changed file${files.length > 1 ? 's' : ''}`);
			}
		}

		if (signal.aborted) {
			card.tool = { ...card.tool!, status: 'error', summary: 'Verification stopped' };
			this.d.scheduleState();
			signal.throwIfAborted();
		}

		if (command && commandCwd) {
			if (!settings.commandTool || !commandContext) {
				notes.push(!settings.commandTool ? 'Command verification skipped — terminal commands are disabled' : 'Command verification skipped — command permissions are unavailable');
				skipped = true;
			} else {
				const journal = commandContext.storageDir && commandContext.sessionId && commandContext.taskId ? beginExecution(commandContext.storageDir, { sessionId: commandContext.sessionId, taskId: commandContext.taskId, callId: 'auto-verify-' + randomUUID(), tool: 'verify' }, command) : undefined;
				try {
					const plan = await approveCommand(command, root!.fsPath, commandCwd, {
						...commandContext, settings, signal,
						requestApproval: async request => {
							const existing = new Set(convo.map(m => m.id));
							try { const handle = await commandContext.requestApproval(request); journal?.approval(handle.approved, handle.auto); return handle; }
							finally {
								// Keep the streamed answer below the checks and their permission cards.
								if (answer && convo.includes(answer)) {
									for (const row of convo.filter(m => !existing.has(m.id) && m.approval?.kind === request.kind && m.approval.command === request.command)) {
										convo.splice(convo.indexOf(row), 1);
										convo.splice(convo.indexOf(answer), 0, row);
									}
								}
								this.d.scheduleState();
							}
						}
					});
					if (!plan.handle.approved) {
						journal?.finish('refused');
						notes.push('Command verification skipped — permission was declined');
						skipped = true;
					} else {
						const startedAt = Date.now();
						let fingerprint = '';
						try { fingerprint = await projectFingerprint(root!.fsPath, settings.denyPaths, signal); } catch { signal.throwIfAborted(); }
						const res = await executeCommand(command, plan, 300_000, signal);
						journal?.finish(res.code === 0 && !res.timedOut ? 'completed' : 'failed');
						let stale = true;
						try { if (fingerprint) stale = await projectFingerprint(root!.fsPath, settings.denyPaths, signal) !== fingerprint; } catch { /* interrupted evidence remains stale */ }
						commandContext.onFeatureReport?.({ id: randomUUID(), kind: 'verify', root: root!.fsPath, fingerprint, configuration: checkConfiguration(settings), startedAt, finishedAt: Date.now(), stale,
							status: res.code === 0 && !res.timedOut ? 'passed' : 'failed', scope: 'Automatic command check: ' + command,
							stages: [{ name: 'Automatic check', command, status: res.code === 0 && !res.timedOut ? 'passed' : 'failed', code: res.code, durationMs: Date.now() - startedAt, output: '' }] });
						if (res.code !== 0 || res.timedOut) {
							if (isAuto && isMissingBinary(res.out, command)) {
								notes.push(`\`${command}\` not available on PATH (skipped)`);
								skipped = true;
							} else {
								completed++;
								problems.push(`\`${command}\` failed (${res.timedOut ? 'timed out' : `exit code ${res.code}`}):\n${compressOutput(res.out, 12_000).text}`);
							}
						} else {
							completed++;
							notes.push(`\`${command}\` passed`);
						}
					}
				} catch (error) {
					journal?.finish('unknown');
					card.tool = { ...card.tool!, status: 'error', summary: signal.aborted ? 'Verification stopped' : 'Verification could not run', detail: mask(String(error)) };
					this.d.scheduleState();
					throw error;
				}
			}
		}

		for (let i = 0; i < problems.length; i++) problems[i] = mask(problems[i]);
		for (let i = 0; i < notes.length; i++) notes[i] = mask(notes[i]);
		const failed = problems.length > 0;
		card.tool = {
			...card.tool!,
			status: failed || skipped || !completed ? 'error' : 'done',
			summary: failed ? `${problems.length} check${problems.length > 1 ? 's' : ''} failed` : notes.join(' · ') || 'Not checked — no check completed',
			detail: failed ? problems.join('\n\n').slice(0, 4000) : undefined
		};
		this.d.scheduleState();

		if (!failed) {
			return undefined;
		}

		if (state.rounds >= 2) {
			convo.push({ id: newId('m'), role: 'assistant', content: '_Checks still fail after 2 automatic fix attempts — see the Verify step above._' });
			return undefined;
		}

		state.rounds++;
		return `[Automatic check after your edits]\n${fenceToolOutput('verify', problems.join('\n\n'))}\n\nFix these problems (they may come from your changes), then give your final answer again.`;
	}
}
