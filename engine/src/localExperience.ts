import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { Machine } from './localModels';
import type { HfModel, LocalGguf } from './localEngine';
import { ggufFiles } from './localEngine';
import { integratedGpu } from './localModels';

export interface ModelMeasurement {
	key: string; hardware: string; settings: string; model: string; repo?: string; file: string; quant?: string;
	bytes: number; stamp: string; at: number; context?: number; backend: string; engine: string;
	status: 'measured' | 'incomplete' | 'cancelled'; tokS?: number; promptTokS?: number; ttftMs?: number; processRamBytes?: number; error?: string;
}
export const experienceKey = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const hardwareKey = (m: Machine) => experienceKey([m.platform, m.cpu, m.cores, m.totalMemoryBytes, m.gpuName, m.unifiedMemory || integratedGpu(m.gpuName) ? undefined : m.gpuMemoryBytes, m.unifiedMemory]);
export function modelStamp(g: LocalGguf): string {
	let shards = [g.path];
	try { shards = ggufFiles(g.path, fs.readdirSync(path.dirname(g.path))); } catch { /* Missing files invalidate the saved result. */ }
	const files = [...shards, ...(g.mmproj ? [g.mmproj] : [])];
	return experienceKey(files.map(f => { try { const s = fs.statSync(f); return [f, s.size, s.mtimeMs]; } catch { return [f, 'missing']; } }));
}
export function currentMeasurement(records: ModelMeasurement[], g: LocalGguf, hardware: string, settings: string): ModelMeasurement | undefined {
	const stamp = modelStamp(g);
	return records.filter(r => r && Number.isFinite(r.at) && typeof r.key === 'string' && (r.status === 'incomplete' || r.status === 'cancelled' || r.status === 'measured' && Number.isFinite(r.tokS) && r.tokS! > 0 && Number.isFinite(r.ttftMs) && r.ttftMs! >= 0) && r.hardware === hardware && r.settings === settings && r.model === g.id && r.stamp === stamp && r.bytes === g.sizeBytes)
		.sort((a, b) => b.at - a.at)[0];
}

async function processRam(pid?: number, signal?: AbortSignal): Promise<number | undefined> {
	if (!pid || !Number.isSafeInteger(pid) || pid < 1) return undefined;
	try {
		if (process.platform === 'linux') {
			const kb = /^VmRSS:\s*(\d+)\s*kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
			return kb ? Number(kb[1]) * 1024 : undefined;
		}
		const win = process.platform === 'win32';
		const output = await new Promise<string>((resolve, reject) => execFile(win ? 'powershell.exe' : 'ps', win ? ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`] : ['-o', 'rss=', '-p', String(pid)], { windowsHide: true, timeout: 2000, signal }, (e, stdout) => e ? reject(e) : resolve(stdout)));
		const n = Number(output.trim()) * (win ? 1 : 1024);
		return Number.isFinite(n) && n > 0 ? n : undefined;
	} catch { return undefined; }
}

/** The probe uses synthetic text only; it never includes the transcript or project files. */
export async function measureLocalModel(base: string, signal: AbortSignal, pid?: number) {
	const ramBefore = await processRam(pid, signal);
	signal.throwIfAborted();
	const nonce = randomBytes(12).toString('hex');
	// Chat requests, so the model answers through its own template: asked bare, a chat model can end
	// after a token or two (Gemma 4 did, three times out of four) and the check came back "incomplete".
	const ask = (content: string, more: Record<string, unknown>) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
		body: JSON.stringify({ messages: [{ role: 'user', content }], temperature: 0, cache_prompt: false, chat_template_kwargs: { enable_thinking: false }, ...more }) });
	const warm = await ask(`Check ${nonce}. Say ready.`, { max_tokens: 8 });
	if (!warm.ok) throw new Error(`Warm-up HTTP ${warm.status}`);
	await warm.arrayBuffer();
	const started = Date.now();
	const res = await ask(`Check ${nonce}-speed. Explain in detail how a TypeScript Map lookup differs from Array.find. Include a code example and describe time complexity.`, { max_tokens: 96, seed: 42, stream: true });
	if (!res.ok || !res.body) throw new Error(`Speed check HTTP ${res.status}`);
	const reader = res.body.getReader(), decoder = new TextDecoder();
	let pending = '', ttftMs: number | undefined, timings: any, content = '';
	const line = (value: string) => {
		if (!value.startsWith('data:')) return;
		const raw = value.slice(5).trim(); if (!raw || raw === '[DONE]') return;
		const j = JSON.parse(raw);
		if (j.error) throw new Error('The engine could not complete the speed check.');
		const delta = j.choices?.[0]?.delta;
		const text = delta ? `${delta.reasoning_content ?? ''}${delta.content ?? ''}` : '';
		if (text.length) { ttftMs ??= Date.now() - started; content += text; }
		if (j.timings) timings = j.timings;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read(); pending += decoder.decode(value, { stream: !done });
			const lines = pending.split('\n'); pending = lines.pop()!; lines.forEach(l => line(l.trim()));
			if (done) { line(pending.trim()); break; }
		}
	} finally { await reader.cancel().catch(() => undefined); }
	if (!content.trim() || ttftMs === undefined || !Number.isFinite(timings?.predicted_n) || timings.predicted_n < 32 || !(timings.predicted_per_second > 0 && timings.predicted_per_second < 5000) || !Number.isFinite(timings.prompt_per_second) || !(timings.prompt_per_second > 0)) throw new Error('The response was too short or its timings were unavailable.');
	const ramAfter = await processRam(pid, signal);
	signal.throwIfAborted();
	return { tokS: Math.round(timings.predicted_per_second * 10) / 10, promptTokS: Math.round(timings.prompt_per_second), ttftMs,
		processRamBytes: ramBefore || ramAfter ? Math.max(ramBefore ?? 0, ramAfter ?? 0) : undefined };
}

export interface ExperienceCandidate {
	id: string; tools?: boolean; runtimeReason?: string; quality?: number; measurement?: ModelMeasurement;
	rating?: { verdict: string; tokS?: number; needBytes: number; downloadBytes: number; ctx?: number; strict: boolean; score: number };
}
export function modelStatus(x: ExperienceCandidate, disk?: number) {
	if (x.runtimeReason) return /not supported/.test(x.runtimeReason) ? 'Needs engine update' : 'Compatibility unconfirmed';
	if (!x.rating) return 'Compatibility unconfirmed';
	if (x.rating.verdict === 'no') return 'Too large';
	if (disk !== undefined && x.rating.downloadBytes + .25e9 > disk) return 'Not enough disk space';
	// Past fast memory a build still runs, slower: it can be downloaded, and is never a recommendation.
	if (x.rating.verdict === 'slow') return 'Runs slower';
	return x.measurement?.status === 'measured' ? 'Tested successfully' : 'Fits memory';
}
export function recommendModels<T extends ExperienceCandidate>(items: T[], disk?: number) {
	const eligible = items.filter(x => x.tools === true && ['Fits memory', 'Tested successfully'].includes(modelStatus(x, disk)) && x.measurement?.status !== 'incomplete');
	const speed = (x: T) => x.measurement?.tokS ?? x.rating?.tokS ?? 0;
	const latency = (x: T) => x.measurement?.ttftMs ? Math.min(1, 1500 / x.measurement.ttftMs) : 1;
	const quality = (x: T) => x.quality ?? x.rating?.score ?? 0;
	const tested = eligible.filter(x => x.measurement?.status === 'measured');
	const pick = (score: (x: T) => number, pool = eligible) => [...pool].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
	const reliable = tested.length ? tested : eligible;
	return { fast: pick(x => speed(x) * latency(x), reliable), balanced: pick(x => quality(x) * .6 + Math.min(60, speed(x)) * .4 * latency(x), reliable), quality: pick(x => quality(x)) };
}
export function recommendationReason(x: ExperienceCandidate, preset: string) {
	const speed = x.measurement?.status === 'measured' ? `${x.measurement.tokS?.toFixed(1)} tok/s measured at ${Math.round((x.measurement.context ?? 0) / 1024)}K context` : `about ${Math.round(x.rating?.tokS ?? 0)} tok/s estimated`;
	const choice = preset === 'fast' ? 'Prioritizes response speed' : preset === 'quality' ? 'Prioritizes estimated coding capability' : 'Balances estimated coding capability and speed';
	return `${choice}. Fits the current memory budget, supports coding tools, and runs at ${speed}.`;
}

export function modelGroupKey(m: HfModel): string {
	const name = (s: string) => s.toLowerCase().replace(/[-_.](?:i1-)?gguf$/i, '').replace(/[-_.](?:ud-)?(?:q[2-8]_[a-z0-9_]+|iq[1-4]_[a-z0-9_]+|bf16|f16)$/i, '').replace(/[-_.]/g, '');
	const trusted = /^(unsloth|bartowski|lmstudio-community|ggml-org|Qwen|google|microsoft|ibm-granite)\//i;
	if (m.format === 'gguf' && trusted.test(m.id) && m.baseModel?.includes('/')) {
		const [owner, base] = m.baseModel.split('/'), build = name(m.id.split('/')[1]);
		if (build === name(base) || build === name(owner) + name(base)) return m.baseModel.toLowerCase();
	}
	return m.id.toLowerCase();
}
export function groupHubModels<T extends HfModel>(models: T[]): Array<T & { groupKey: string; variants: T[] }> {
	const groups = new Map<string, T & { groupKey: string; variants: T[] }>();
	for (const m of models) {
		const key = modelGroupKey(m), existing = groups.get(key);
		if (existing) {
			if (!existing.variants.some(v => v.id.toLowerCase() === m.id.toLowerCase())) existing.variants.push(m);
			const rank = (v: T) => { const x = v as T & { fit?: string; measurement?: ModelMeasurement }; return x.fit !== 'fits' && x.fit !== 'tight' ? 3 : x.measurement?.status === 'measured' ? 0 : x.fit === 'fits' ? 1 : 2; };
			if (rank(m) < rank(existing)) groups.set(key, { ...m, groupKey: key, variants: existing.variants });
		}
		else groups.set(key, { ...m, groupKey: key, variants: [m] });
	}
	return [...groups.values()];
}
