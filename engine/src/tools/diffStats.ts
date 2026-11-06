/**
 * Added/removed line counts between two versions of a file (for the
 * "Edited 3 files +102 −79" card). Common prefix/suffix are trimmed, the
 * middle is diffed with an LCS table; very large middles fall back to a
 * multiset comparison, which is exact for pure additions/removals and a
 * close estimate otherwise.
 */
export function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
	const a = toLines(before);
	const b = toLines(after);
	if (before === null) {
		return { added: b.length, removed: 0 };
	}
	if (after === null) {
		return { added: 0, removed: a.length };
	}
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}
	const midA = a.slice(start, endA + 1);
	const midB = b.slice(start, endB + 1);
	if (!midA.length || !midB.length) {
		return { added: midB.length, removed: midA.length };
	}
	if (midA.length * midB.length > 4_000_000) {
		const counts = new Map<string, number>();
		for (const l of midA) {
			counts.set(l, (counts.get(l) ?? 0) + 1);
		}
		let common = 0;
		for (const l of midB) {
			const c = counts.get(l) ?? 0;
			if (c > 0) {
				common++;
				counts.set(l, c - 1);
			}
		}
		return { added: midB.length - common, removed: midA.length - common };
	}
	// LCS length with two rolling rows.
	let prev = new Uint32Array(midB.length + 1);
	let cur = new Uint32Array(midB.length + 1);
	for (let i = 1; i <= midA.length; i++) {
		for (let j = 1; j <= midB.length; j++) {
			cur[j] = midA[i - 1] === midB[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
		}
		[prev, cur] = [cur, prev];
	}
	const lcs = prev[midB.length];
	return { added: midB.length - lcs, removed: midA.length - lcs };
}

/** Split into lines; a trailing newline ends the last line rather than starting an empty one. */
function toLines(text: string | null): string[] {
	if (!text) {
		return [];
	}
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** A changed block: lines [aStart, aEnd) of the old text became [bStart, bEnd) of the new. */
export interface Hunk {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

/** Line-level change blocks between two texts (for per-hunk review). */
export function diffHunks(before: string, after: string): Hunk[] {
	const a = before.split('\n');
	const b = after.split('\n');
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const n = endA - start;
	const m = endB - start;
	if (!n && !m) {
		return [];
	}
	if (!n || !m || n * m > 4_000_000) {
		return [{ aStart: start, aEnd: endA, bStart: start, bEnd: endB }];
	}
	// LCS table over the changed middle, then walk it to find equal runs.
	const w = m + 1;
	const table = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
		}
	}
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	let open: Hunk | undefined;
	const close = () => {
		if (open) {
			open.aEnd = start + i;
			open.bEnd = start + j;
			hunks.push(open);
			open = undefined;
		}
	};
	while (i < n || j < m) {
		if (i < n && j < m && a[start + i] === b[start + j]) {
			close();
			i++;
			j++;
			continue;
		}
		open ??= { aStart: start + i, aEnd: 0, bStart: start + j, bEnd: 0 };
		if (j < m && (i >= n || table[i * w + j + 1] >= table[(i + 1) * w + j])) {
			j++;
		} else {
			i++;
		}
	}
	close();
	return hunks;
}

/** Rebuild the text keeping every hunk except the rejected ones (by index). */
export function applyHunks(before: string, after: string, hunks: Hunk[], rejected: Set<number>): string {
	const a = before.split('\n');
	const b = after.split('\n');
	const out: string[] = [];
	let pos = 0;
	hunks.forEach((h, k) => {
		out.push(...a.slice(pos, h.aStart));
		out.push(...(rejected.has(k) ? a.slice(h.aStart, h.aEnd) : b.slice(h.bStart, h.bEnd)));
		pos = h.aEnd;
	});
	out.push(...a.slice(pos));
	return out.join('\n');
}
