import type { AgentSettings } from '../providerStore';
import { checkConfiguration, projectFingerprint, type ProjectReport } from '../tools/projectChecks';
import { redactSecrets } from '../tools/redact';

export type VerificationReceipt = Omit<ProjectReport, 'stages'> & {
	sessionId: string; taskId: string; checkedAt?: number;
	stages: Array<Omit<ProjectReport['stages'][number], 'output' | 'findings'>>;
};

export function recordEvidence(receipts: VerificationReceipt[], report: ProjectReport, sessionId: string, taskId: string): VerificationReceipt[] {
	const receipt: VerificationReceipt = { ...report, sessionId, taskId, scope: redactSecrets(report.scope).text,
		stages: report.stages.map(({ name, command, status, code, durationMs }) => ({ name, command: redactSecrets(command).text, status, code, durationMs })) };
	return [...receipts.filter(r => r.id !== report.id), receipt].slice(-20);
}

export async function refreshEvidence(receipts: VerificationReceipt[], settings: Partial<AgentSettings>): Promise<void> {
	const fingerprints = new Map<string, string | undefined>();
	for (const receipt of receipts) {
		if (!fingerprints.has(receipt.root)) {
			try { fingerprints.set(receipt.root, await projectFingerprint(receipt.root, settings.denyPaths)); }
			catch { fingerprints.set(receipt.root, undefined); }
		}
		receipt.stale ||= receipt.fingerprint !== fingerprints.get(receipt.root) || receipt.configuration !== checkConfiguration(settings);
		receipt.checkedAt = Date.now();
	}
}

export function evidenceStatus(receipts: VerificationReceipt[]): 'passed' | 'failed' | 'stale' | 'not-run' {
	const reports = [...new Map(receipts.filter(r => r.kind === 'verify').map(r => [r.root + '\0' + r.scope, r])).values()];
	if (!reports.length) return 'not-run';
	if (reports.some(r => r.stale)) return 'stale';
	return reports.every(r => r.finishedAt && r.status === 'passed' && r.stages.length > 0 && r.stages.every(s => s.status === 'passed' && s.code === 0)) ? 'passed' : 'failed';
}
