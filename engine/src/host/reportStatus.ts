/**
 * Structured agent reports: how a subagent's work ended, and the one question it needs answered. The lead and the
 * user's attention depend on it — "dropped" (nothing to do) ends quietly, a question reaches the user as written,
 * and only "ready", "blocked" and "failed" are worth interrupting for.
 */

export type ReportState = 'ready' | 'blocked' | 'failed' | 'dropped';
export interface ReportOutcome { state?: ReportState; question?: string }

export const REPORT_STATUS_RULE = [
	'End your report with one status line: "STATUS: ready" (done and checked), "STATUS: blocked" (cannot go on until a person acts),',
	'"STATUS: failed" (it went wrong; say what you tried), or "STATUS: dropped" (nothing to do: it does not reproduce, it is already done, or nothing was asked).',
	'When the user must decide something before the work can go on, add one line "QUESTION: <one concrete question>" and nothing else for them: one question, not a list.'
].join(' ');

/** The status and question a report ends with; either is undefined when the report does not state it (pure; tested). */
export function reportOutcome(report: string | undefined): ReportOutcome {
	const out: ReportOutcome = {};
	for (const raw of String(report ?? '').split(/\r?\n/).reverse()) {
		const line = raw.trim().replace(/^[*_`>\s-]+|[*_`\s]+$/g, '');
		const status = /^STATUS\s*[:=-]\s*(ready|blocked|failed|dropped)\b/i.exec(line);
		if (status && !out.state) out.state = status[1].toLowerCase() as ReportState;
		const question = /^QUESTION\s*[:=-]\s*(.+)$/i.exec(line);
		if (question && !out.question) out.question = question[1].trim().slice(0, 500);
	}
	return out;
}
