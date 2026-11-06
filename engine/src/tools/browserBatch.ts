export type BrowserStep =
	| { action: 'click' | 'hover'; ref: number }
	| { action: 'type'; ref: number; text: string; clear?: boolean; submit?: boolean }
	| { action: 'select'; ref: number; value: string }
	| { action: 'press'; key: string }
	| { action: 'wait_for'; text?: string; gone?: string; seconds?: number };

/** Validate the whole sequence before the first action, including fields outside the public schema. */
export function browserSteps(value: unknown): BrowserStep[] {
	if (!Array.isArray(value) || !value.length || value.length > 12) throw new Error('A browser batch needs 1–12 steps.');
	return value.map((step, i) => {
		const fail = () => { throw new Error(`Invalid browser batch step ${i + 1}. Use click, hover, type, select, press or wait_for with the required fields.`); };
		if (!step || typeof step !== 'object' || Array.isArray(step)) return fail();
		const fields: Record<string, string[]> = { click: ['ref'], hover: ['ref'], type: ['ref', 'text', 'clear', 'submit'], select: ['ref', 'value'], press: ['key'], wait_for: ['text', 'gone', 'seconds'] };
		if (!Object.hasOwn(fields, step.action) || Object.keys(step).some(k => k !== 'action' && !fields[step.action].includes(k))) return fail();
		if (fields[step.action].includes('ref') && (!Number.isSafeInteger(step.ref) || step.ref < 1)) return fail();
		for (const key of ['text', 'value', 'key', 'gone']) if (key in step && (typeof step[key] !== 'string' || step[key].length > 10_000)) return fail();
		for (const key of ['clear', 'submit']) if (key in step && typeof step[key] !== 'boolean') return fail();
		if (step.action === 'type' && typeof step.text !== 'string') return fail();
		if (step.action === 'select' && typeof step.value !== 'string') return fail();
		if (step.action === 'press' && (typeof step.key !== 'string' || !step.key || step.key.length > 80)) return fail();
		if ('seconds' in step && (!Number.isFinite(step.seconds) || step.seconds < 0.1 || step.seconds > 15)) return fail();
		return { ...step } as BrowserStep;
	});
}
