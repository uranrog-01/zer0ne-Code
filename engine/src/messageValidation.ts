import type { StoredMessage } from './providerStore';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown, max = 1000): string[] => Array.isArray(value) ? value.filter(v => typeof v === 'string').slice(0, max) : [];
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
function numeric<T extends Record<string, any>>(value: T, fields: string[]): T {
	const result = { ...value };
	for (const field of fields) if (field in result) (result as any)[field] = number(result[field]);
	return result;
}
function usage(value: any) {
	return object(value) ? { ...numeric(value, ['input', 'output', 'cached', 'cacheWrite', 'cost', 'attempts', 'knownAttempts', 'cacheKnownAttempts']), input: number(value.input), output: number(value.output) } : undefined;
}

/** Saved cards are untrusted data. Drop damaged fields without deleting the source file. */
export function validMessages(raw: unknown): StoredMessage[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	return raw.filter(m => object(m) && typeof m.content === 'string' && !('dual' in m)).map((value, index) => {
		const m = { ...value } as StoredMessage;
		m.role = m.role === 'user' ? 'user' : 'assistant';
		if (typeof m.id !== 'string' || !m.id || seen.has(m.id)) m.id = `recovered-${index}`;
		while (seen.has(m.id)) m.id += '-';
		seen.add(m.id);
		if ('attachments' in m) m.attachments = strings(m.attachments);
		if (Array.isArray(m.memoryRecall)) m.memoryRecall = m.memoryRecall.filter(r => object(r) && typeof r.id === 'string' && typeof r.text === 'string' && typeof r.reason === 'string').slice(0, 200);
		else delete m.memoryRecall;
		for (const field of ['apiContent', 'reasoning', 'model', 'rootTaskId'] as const) if (typeof m[field] !== 'string') delete m[field];
		if (m.at !== undefined) m.at = number(m.at);
		if (typeof m.reasoningMs !== 'number' || !Number.isFinite(m.reasoningMs) || m.reasoningMs < 0) delete m.reasoningMs;
		if (typeof m.retryAt !== 'number' || !Number.isFinite(m.retryAt) || m.retryAt <= 0) delete m.retryAt;
		if (!object(m.mcpApp) || typeof m.mcpApp.toolName !== 'string' || typeof m.mcpApp.resourceUri !== 'string' || !m.mcpApp.resourceUri.startsWith('ui://') || !object(m.mcpApp.input) || !object(m.mcpApp.result)) delete m.mcpApp;
		if (m.kind !== 'tool') delete m.kind;
		if (object(m.tool) && typeof m.tool.name === 'string') {
			m.tool = { ...m.tool, arg: typeof m.tool.arg === 'string' ? m.tool.arg : '', summary: typeof m.tool.summary === 'string' ? m.tool.summary : '', status: ['running', 'done', 'error'].includes(m.tool.status) ? m.tool.status : 'error' };
			for (const field of ['detail', 'image', 'url'] as const) if (typeof m.tool[field] !== 'string') delete m.tool[field];
		} else delete m.tool;
		if (object(m.question) && typeof m.question.id === 'string' && typeof m.question.text === 'string') m.question = { ...m.question, options: strings(m.question.options, 30), status: ['pending', 'answered', 'skipped'].includes(m.question.status) ? m.question.status : 'skipped', answer: typeof m.question.answer === 'string' ? m.question.answer : undefined };
		else delete m.question;
		if (object(m.approval) && typeof m.approval.id === 'string' && ['edit', 'write', 'command', 'mcp', 'patch'].includes(m.approval.kind)) {
			m.approval = { ...m.approval, status: ['pending', 'applied', 'rejected'].includes(m.approval.status) ? m.approval.status : 'rejected' };
			if (!['running', 'done', 'error'].includes(m.approval.execution as string)) delete m.approval.execution;
			for (const field of ['path', 'find', 'replace', 'content', 'command', 'result', 'tool', 'args'] as const) if (typeof m.approval[field] !== 'string') delete m.approval[field];
		} else delete m.approval;
		m.todos = Array.isArray(m.todos) ? m.todos.filter(t => object(t) && typeof t.text === 'string').map(t => ({ text: t.text, done: t.done === true })) : undefined;
		if (object(m.turn)) {
			m.turn = { ...m.turn, startedAt: number(m.turn.startedAt) };
			if (m.turn.endedAt !== undefined) m.turn.endedAt = number(m.turn.endedAt);
			m.turn.edits = Array.isArray(m.turn.edits) ? m.turn.edits.filter(e => object(e) && typeof e.path === 'string').map(e => ({ ...e, added: number(e.added), removed: number(e.removed) })) : undefined;
			m.turn.attempts = Array.isArray(m.turn.attempts) ? m.turn.attempts.filter(a => object(a) && typeof a.id === 'string' && typeof a.model === 'string' && typeof a.format === 'string').map(a => ({ ...numeric(a, ['startedAt', 'durationMs', 'step', 'cost', 'prepareMs', 'responseMs', 'firstTextMs', 'firstToolMs', 'firstEventMs', 'firstReasoningMs']), startedAt: number(a.startedAt), durationMs: number(a.durationMs), usage: usage(a.usage), outcome: ['completed', 'failed', 'cancelled'].includes(a.outcome) ? a.outcome : 'failed' })) : undefined;
			m.turn.toolTimings = Array.isArray(m.turn.toolTimings) ? m.turn.toolTimings.filter(a => object(a) && typeof a.callId === 'string' && typeof a.name === 'string').map(a => ({ ...numeric(a, ['step', 'startedAt', 'durationMs', 'queueMs', 'runMs']), step: number(a.step), startedAt: number(a.startedAt), durationMs: number(a.durationMs) })) : undefined;
			m.turn.usage = usage(m.turn.usage);
			m.turn.undoSkipped = Array.isArray(m.turn.undoSkipped) ? strings(m.turn.undoSkipped, 500) : undefined;
			for (const edit of m.turn.edits ?? []) {
				for (const field of ['previewBefore', 'previewAfter'] as const) if (typeof edit[field] !== 'string') delete edit[field];
				edit.undone = edit.undone === true || undefined;
			}
			if (object(m.turn.taskBudget) && object(m.turn.taskBudget.limits) && typeof m.turn.taskBudget.rootTaskId === 'string') m.turn.taskBudget = { ...numeric(m.turn.taskBudget, ['requests', 'spentTokens', 'reservedTokens', 'uncertainTokens', 'spentCost', 'reservedCost', 'uncertainCost', 'unknownUsage', 'unknownCost']), limits: { cost: number(m.turn.taskBudget.limits.cost), tokens: number(m.turn.taskBudget.limits.tokens), requests: number(m.turn.taskBudget.limits.requests), seconds: number(m.turn.taskBudget.limits.seconds) } };
			else delete m.turn.taskBudget;
			for (const field of ['model', 'provider', 'providerId'] as const) if (typeof m.turn[field] !== 'string') delete m.turn[field];
			if (!['completed', 'failed', 'stopped'].includes(m.turn.outcome || '')) delete m.turn.outcome;
		} else delete m.turn;
		for (const [field, value] of Object.entries(m)) if (value === undefined) delete (m as any)[field];
		if (m.turn) for (const [field, value] of Object.entries(m.turn)) if (value === undefined) delete (m.turn as any)[field];
		return m;
	});
}
