/**
 * Memory vectors and ranking, without state or I/O (pure; tested).
 *
 *  - semantic recall fuses keyword and embedding ranks, so a prompt written
 *    in different words still finds a saved fact;
 *  - duplicate groups are proposals for the Memory page, never automatic
 *    deletions;
 *  - the extraction filter keeps automatic capture to durable statements.
 */

/** A float32 vector as the base64 string stored with a memory. */
export function encodeVector(values: readonly number[]): string {
	return Buffer.from(new Float32Array(values).buffer).toString('base64');
}

/** Decode a stored vector. Copied out of Node's shared buffer pool first. */
export function decodeVector(value: string): Float32Array {
	return new Float32Array(new Uint8Array(Buffer.from(value, 'base64')).buffer);
}

/** Cosine similarity in [-1, 1]; 0 for empty or mismatched vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (!a.length || a.length !== b.length) return 0;
	let dot = 0, an = 0, bn = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		an += a[i] * a[i];
		bn += b[i] * b[i];
	}
	const denominator = Math.sqrt(an) * Math.sqrt(bn);
	return denominator ? dot / denominator : 0;
}

export interface RankedEntry<T> {
	item: T;
	score: number;
	via: string[];
}

/**
 * Reciprocal rank fusion: each list is best-first, and `1 / (60 + rank)`
 * keeps one list from dominating. The same item found by several lists rises.
 */
export function fuseRanks<T>(lists: ReadonlyArray<{ via: string; items: readonly T[] }>, key: (item: T) => string): Array<RankedEntry<T>> {
	const fused = new Map<string, { item: T; score: number; via: Set<string> }>();
	for (const list of lists) {
		list.items.forEach((item, rank) => {
			const id = key(item);
			const entry = fused.get(id) ?? { item, score: 0, via: new Set<string>() };
			entry.score += 1 / (60 + rank);
			entry.via.add(list.via);
			fused.set(id, entry);
		});
	}
	return [...fused.values()].sort((a, b) => b.score - a.score).map((e) => ({ item: e.item, score: e.score, via: [...e.via] }));
}

export interface DuplicateGroup<T> {
	/** The first item of the group in the caller's order (pinned, then oldest). */
	keep: T;
	others: T[];
	similarity: number;
}

/** Connected groups whose stored vectors are at least `threshold` similar. */
export function groupDuplicates<T>(items: readonly T[], vector: (item: T) => Float32Array | undefined, threshold = 0.9): Array<DuplicateGroup<T>> {
	const parent = items.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};
	const strongest = new Map<number, number>();
	for (let i = 0; i < items.length; i++) {
		const a = vector(items[i]);
		if (!a?.length) continue;
		for (let j = i + 1; j < items.length; j++) {
			const b = vector(items[j]);
			if (!b || b.length !== a.length) continue;
			const similarity = cosineSimilarity(a, b);
			if (similarity < threshold) continue;
			union(i, j);
			const root = find(i);
			strongest.set(root, Math.max(strongest.get(root) ?? 0, similarity));
		}
	}
	const groups = new Map<number, T[]>();
	items.forEach((item, i) => {
		const root = find(i);
		groups.set(root, [...(groups.get(root) ?? []), item]);
	});
	return [...groups.entries()]
		.filter(([, group]) => group.length > 1)
		.map(([root, group]) => ({ keep: group[0], others: group.slice(1), similarity: strongest.get(root) ?? 0 }))
		.sort((a, b) => b.similarity - a.similarity);
}

const TRANSIENT = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[A-Za-z]:\\Users\\|\/home\/[^/\s]+\/|\/tmp\/|\btmp[\\/]|\bexit code\b|\bstdout\b|\bstderr\b|\bthis session\b|\bjust now\b|\bworkdir\b|\bcleanup token\b|\bthrowaway\b)/i;
const AGENT_ACTION = /^(?:the agent|the assistant|i)\s+(?:created|implemented|built|ran|tested|verified|fixed|wrote|generated|saved|cleaned|inspected|restarted|committed|staged|opened|reported|showed)\b/i;
const COMMAND_LOG = /\b(?:ran|executed)\s+[`'"]?[\w./\\-]+|\bterminal command\b|\bcommand output\b/i;
const SENSITIVE = /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret|credential|social security|ssn|health|diagnosis|religion|religious|political)\b/i;

/** Details the Memory setting keeps out of automatic capture unless it is enabled. */
export function looksSensitive(text: string): boolean {
	return SENSITIVE.test(text);
}

/**
 * A durable statement worth keeping automatically: long enough to mean
 * something, not a machine-local path/port, not a log of what the agent did.
 * User-stated preferences and project facts pass; "I created the file" does not.
 */
export function worthRemembering(text: string): boolean {
	const value = text.trim();
	if (value.length < 20 || value.length > 500 || value.split('\n').length > 6) return false;
	if (TRANSIENT.test(value) || COMMAND_LOG.test(value)) return false;
	if (AGENT_ACTION.test(value)) return false;
	return true;
}

export interface ExtractedMemory {
	text: string;
	area: 'fact' | 'solution';
}

/** Parse the helper model's extraction reply: an array or { facts: [...] }. */
export function parseMemoryExtraction(raw: string): ExtractedMemory[] {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		// Small local models often wrap the object in a sentence; take the JSON block.
		const block = text.match(/\{[\s\S]*\}/)?.[0] ?? text.match(/\[[\s\S]*\]/)?.[0];
		if (!block) return [];
		try {
			value = JSON.parse(block);
		} catch {
			return [];
		}
	}
	const rows = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? ((value as { facts?: unknown; memories?: unknown }).facts ?? (value as { memories?: unknown }).memories) : undefined;
	if (!Array.isArray(rows)) return [];
	const out: ExtractedMemory[] = [];
	for (const row of rows) {
		const textValue = typeof row === 'string' ? row : typeof row === 'object' && row !== null ? String((row as { text?: unknown }).text ?? '') : '';
		const area = typeof row === 'object' && row !== null && (row as { area?: unknown }).area === 'solution' ? 'solution' : 'fact';
		const clean = textValue.replace(/\s+/g, ' ').trim();
		if (clean && !out.some((x) => x.text.toLowerCase() === clean.toLowerCase())) out.push({ text: clean.slice(0, 500), area });
	}
	return out.slice(0, 3);
}
