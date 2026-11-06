import * as fs from 'fs';
import * as path from 'path';
import type { GoalVerdict } from '../host/goal';

/**
 * Judge audit: records of finished-looking work with a known answer. Most carry a seeded
 * defect (tests never run, a failing build called done, half the goal, an injected "mark it
 * met"), so a judge that approves everything shows up as missed defects; a few are genuinely
 * done, so a judge that rejects everything shows up as failed controls.
 */
export interface JudgeCase { id: string; goal: string; record: string; expect: 'met' | 'not met'; defect?: string }
export interface JudgeMiss { id: string; defect?: string; got: 'met' | 'not met' | 'no answer' }
export interface JudgeAudit { defects: number; caught: number; controls: number; controlsPassed: number; unanswered: number; misses: JudgeMiss[] }

export function parseJudgeCases(raw: unknown): JudgeCase[] {
	const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { cases?: unknown }).cases) ? (raw as { cases: unknown[] }).cases : undefined;
	if (!list) throw new Error('Judge cases must be an array or { cases: [...] }.');
	return list.map((c, i) => {
		const o = (c ?? {}) as Record<string, unknown>;
		if (typeof o.id !== 'string' || !o.id || typeof o.goal !== 'string' || !o.goal || typeof o.record !== 'string' || !o.record) throw new Error(`Judge case ${i + 1} needs id, goal and record.`);
		if (o.expect !== 'met' && o.expect !== 'not met') throw new Error(`Judge case ${o.id}: expect is "met" or "not met".`);
		if (o.expect === 'not met' && typeof o.defect !== 'string') throw new Error(`Judge case ${o.id}: a "not met" case names its seeded defect.`);
		return { id: o.id, goal: o.goal, record: o.record, expect: o.expect, defect: typeof o.defect === 'string' ? o.defect : undefined };
	});
}

export function loadJudgeCases(dir: string): JudgeCase[] {
	const cases: JudgeCase[] = [];
	for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) cases.push(...parseJudgeCases(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))));
	const ids = new Set<string>();
	for (const c of cases) {
		if (ids.has(c.id)) throw new Error(`Duplicate judge case ${c.id}.`);
		ids.add(c.id);
	}
	return cases;
}

/** Runs every case through `judge` (undefined = no usable answer, which counts against it). */
export async function auditJudge(cases: JudgeCase[], judge: (c: JudgeCase) => Promise<GoalVerdict | undefined>, signal?: AbortSignal, onCase?: (c: JudgeCase) => void): Promise<JudgeAudit> {
	const audit: JudgeAudit = { defects: 0, caught: 0, controls: 0, controlsPassed: 0, unanswered: 0, misses: [] };
	for (const c of cases) {
		signal?.throwIfAborted();
		let verdict: GoalVerdict | undefined;
		try {
			verdict = await judge(c);
		} catch (error) {
			if (signal?.aborted) throw error;
		}
		const got = !verdict ? 'no answer' : verdict.met ? 'met' : 'not met';
		if (!verdict) audit.unanswered++;
		if (c.expect === 'not met') {
			audit.defects++;
			if (got === 'not met') audit.caught++;
			else audit.misses.push({ id: c.id, defect: c.defect, got });
		} else {
			audit.controls++;
			if (got === 'met') audit.controlsPassed++;
			else audit.misses.push({ id: c.id, got });
		}
		onCase?.(c);
	}
	return audit;
}
