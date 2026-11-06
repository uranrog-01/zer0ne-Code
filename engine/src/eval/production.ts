import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AgentSettings, ProviderConfig } from '../providerStore';
import type { RequestAttempt } from '../requestDiagnostics';
import type { ReasoningEffort } from '../reasoning';
import type { SubagentWorkflow } from '../host/subagentWorkflow';
import { redactSecrets } from '../tools/redact';

export interface ProductionConfiguration {
	providers: Array<{ provider: ProviderConfig; apiKey: string }>;
	primary: string;
	model: string;
	effort?: ReasoningEffort;
	settings?: Partial<AgentSettings>;
	workflow?: SubagentWorkflow;
	memories?: string[];
}
export interface ProductionResult {
	outcome: string;
	text: string;
	files: string[];
	sessionId: string;
	attempts: RequestAttempt[];
	tools: Array<{ name: string; failed?: boolean }>;
	steps: number;
	verification?: unknown[];
}

/** The real desktop controller runs in a disposable host, with credentials sent only over stdin. */
export async function runProduction(root: string, prompt: string, configuration: ProductionConfiguration, options: { engineDir: string; signal?: AbortSignal; timeoutSeconds?: number; followUps?: string[] }): Promise<ProductionResult> {
	options.signal?.throwIfAborted();
	const data = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-eval-data-'));
	const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_DATA_DIR: data, ZER0NE_ENGINE_DIR: options.engineDir };
	for (const key of Object.keys(env)) if (/(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH)(_|$)/i.test(key) || /^NODE_OPTIONS$/i.test(key)) delete env[key];
	const child = spawn(process.execPath, [path.resolve(options.engineDir, '../host/main.js'), '--headless', '--json', '--eval-stdin', '--project', root, '--timeout-sec', String(options.timeoutSeconds ?? 180)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
	let output = '', diagnostic = '';
	const stop = () => child.kill();
	const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
	const watchdog = setTimeout(stop, ((options.timeoutSeconds ?? 180) * (1 + (options.followUps?.length ?? 0)) + 30) * 1000);
	options.signal?.addEventListener('abort', stop, { once: true });
	const clean = (text: string) => {
		for (const item of configuration.providers) if (item.apiKey) text = text.split(item.apiKey).join('[redacted]');
		return redactSecrets(text).text;
	};
	try {
		const result = await new Promise<ProductionResult>((resolve, reject) => {
			child.on('error', reject);
			child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 16 * 1024 * 1024) { stop(); reject(new Error('Production benchmark output exceeded its limit.')); } });
			child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4096); });
			child.on('close', code => {
				if (options.signal?.aborted) { reject(options.signal.reason ?? new Error('Benchmark stopped.')); return; }
				try {
					const report = JSON.parse(clean(output));
					if (!report || typeof report.text !== 'string' || !Array.isArray(report.attempts)) throw new Error('Invalid production benchmark report.');
					resolve(report);
				} catch { reject(new Error(`Production benchmark host failed (${code}): ${clean(diagnostic).slice(-800)}`)); }
			});
			child.stdin.on('error', () => undefined);
			child.stdin.end(JSON.stringify({ prompt, configuration, followUps: options.followUps }));
		});
		return result;
	} finally {
		clearTimeout(watchdog);
		options.signal?.removeEventListener('abort', stop);
		if (child.exitCode === null && child.signalCode === null) stop();
		await closed;
		await fs.promises.rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
	}
}

/** Service integrations and live user memories are isolated; execution settings remain comparable. */
export function productionSettings(settings: Partial<AgentSettings>): Partial<AgentSettings> {
	const keys = ['customInstructions', 'includeAgentsMd', 'skills', 'subagents', 'browserTools', 'browserAgent', 'commandTool', 'exactHistory', 'tokenSaver', 'cacheTtl', 'autoCompact', 'compactThreshold', 'compactMaxTokens', 'repoMap', 'localTuned', 'codeIndex', 'replyLanguage', 'verifyCommand', 'projectVerification', 'taskBudgetCost', 'taskBudgetTokens', 'taskBudgetRequests', 'taskBudgetSeconds', 'modelConcurrency', 'toolConcurrency', 'mcpConcurrency', 'childConcurrency', 'maxSteps', 'deferredTools', 'toolProfile', 'strictTools', 'openaiCache', 'openaiCacheTtl'] as const;
	return { ...Object.fromEntries(keys.filter(key => key in settings).map(key => [key, (settings as Record<string, unknown>)[key]])), cacheWarm: false, noModelFallback: true, sandbox: settings.sandbox ?? 'auto' };
}
