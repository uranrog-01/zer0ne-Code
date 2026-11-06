// Pixel helpers for the Computer Use effects page, kept free of the page so they can be tested:
// the parts of a window worth redrawing, what changed between two observations, and the
// element under a point. Images are RGBA arrays (ImageData.data) of w × h pixels.
(function () {
	'use strict';

	/** The most common colour, coarsely bucketed, as [r, g, b]. */
	function dominant(d, w, h, area) {
		const a = area || { x: 0, y: 0, w, h };
		const tally = new Map();
		let best = 0, at = (a.y * w + a.x) * 4;
		const step = Math.max(1, Math.floor(Math.sqrt((a.w * a.h) / 4000)));
		for (let y = a.y; y < a.y + a.h; y += step) {
			for (let x = a.x; x < a.x + a.w; x += step) {
				const i = (y * w + x) * 4, key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3, n = (tally.get(key) || 0) + 1;
				tally.set(key, n);
				if (n > best) { best = n; at = i; }
			}
		}
		return [d[at], d[at + 1], d[at + 2]];
	}

	/** The background around an area: the commonest colour along its edge (a large card may cover more of it). */
	function rim(d, w, area) {
		const tally = new Map();
		let best = 0, out = [d[0], d[1], d[2]];
		const add = (x, y) => {
			const i = (y * w + x) * 4, key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | d[i + 2] >> 3, n = (tally.get(key) || 0) + 1;
			tally.set(key, n);
			if (n > best) { best = n; out = [d[i], d[i + 1], d[i + 2]]; }
		};
		for (let x = area.x; x < area.x + area.w; x++) { add(x, area.y); add(x, area.y + area.h - 1); }
		for (let y = area.y; y < area.y + area.h; y++) { add(area.x, y); add(area.x + area.w - 1, y); }
		return out;
	}
	const runs = (counts, noise, gap) => {
		const out = [];
		let start = -1, last = -1;
		for (let i = 0; i < counts.length; i++) {
			if (counts[i] <= noise) continue;
			if (start < 0) start = i;
			else if (i - last - 1 >= gap) { out.push([start, last + 1]); start = i; }
			last = i;
		}
		if (start >= 0) out.push([start, last + 1]);
		return out;
	};
	const apart = (d, i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
	/**
	 * Cuts block `b` along rows, then (for one band) columns, where no pixel is `set`; columns need
	 * `colGap` clear pixels, so the letters of a word stay together; a line with no more than
	 * `noise` of its pixels set (a window edge, a stray mark) still counts as clear. A single
	 * run both ways is the block trimmed to its content; an empty block gives nothing.
	 */
	function cutAt(d, w, b, set, colGap, noise = 0.008) {
		const off = (x, y) => set((y * w + x) * 4);
		const rows = new Int32Array(b.h);
		for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (off(b.x + x, b.y + y)) rows[y]++;
		const bands = runs(rows, Math.max(2, Math.floor(b.w * noise)), 1).map(([s, e]) => ({ x: b.x, y: b.y + s, w: b.w, h: e - s }));
		if (bands.length !== 1) return bands;
		const r = bands[0], cols = new Int32Array(r.w);
		for (let x = 0; x < r.w; x++) for (let y = 0; y < r.h; y++) if (off(r.x + x, r.y + y)) cols[x]++;
		return runs(cols, Math.max(2, Math.floor(r.h * noise)), colGap).map(([s, e]) => ({ x: r.x + s, y: r.y, w: e - s, h: r.h }));
	}
	const differs = (c, e) => Math.abs(c[0] - e[0]) + Math.abs(c[1] - e[1]) + Math.abs(c[2] - e[2]) > 36;

	/**
	 * Blocks of content inside `area`, found by cutting along rows and columns of background
	 * colour (the space between buttons, cards and lines of text). The largest block is cut first,
	 * until `limit` blocks; what stays uncut is redrawn whole. A large block with a fill of its own
	 * (a card, a panel) becomes a "panel" drawn before the blocks inside it. Ordered top to bottom.
	 */
	function segment(d, w, h, area, limit) {
		const cut = (b, bg) => cutAt(d, w, b, (i) => apart(d, i, bg) > 36, 3);
		// A window's own one-pixel border would make every row look busy.
		const inset = area.w > 40 && area.h > 40 ? 2 : 0;
		const root = { x: area.x + inset, y: area.y + inset, w: area.w - inset * 2, h: area.h - inset * 2 };
		const whole = area.w * area.h;
		const open = [{ ...root, bg: rim(d, w, root), depth: 0 }], done = [];
		while (open.length && open.length + done.length < limit) {
			open.sort((a, b) => b.w * b.h - a.w * a.h);
			const b = open.shift();
			if (b.w < 6 || b.h < 4) { done.push(b); continue; }
			let parts = cut(b, b.bg);
			if (parts.length > 1) {
				// More pieces than room left (or than half the limit, so the pieces can be cut
				// again across): join the closest neighbours until they fit.
				const room = Math.min(limit - open.length - done.length, Math.ceil(limit / 2));
				while (parts.length > Math.max(2, room)) {
					let at = 0, gap = Infinity;
					for (let i = 0; i < parts.length - 1; i++) { const g = parts[i].y === parts[i + 1].y ? parts[i + 1].x - (parts[i].x + parts[i].w) : parts[i + 1].y - (parts[i].y + parts[i].h); if (g < gap) { gap = g; at = i; } }
					const a = parts[at], c = parts[at + 1], x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
					parts.splice(at, 2, { x, y, w: Math.max(a.x + a.w, c.x + c.w) - x, h: Math.max(a.y + a.h, c.y + c.h) - y });
				}
				if (open.length + done.length + parts.length > limit) done.push(b);
				else for (const p of parts) open.push({ ...p, bg: b.bg, depth: b.depth });
				continue;
			}
			if (parts.length === 0) continue;
			const t = parts[0];
			if (t.w * t.h < b.w * b.h * 0.98) { open.push({ ...t, bg: b.bg, depth: b.depth }); continue; }
			const fill = dominant(d, w, h, b);
			if (differs(fill, b.bg) && b.depth < 2 && b.w * b.h >= whole * 0.08 && open.length + done.length + 2 <= limit) {
				const inner = cut(b, fill);
				if (inner.length > 1 || (inner.length === 1 && inner[0].w * inner[0].h < b.w * b.h * 0.9)) {
					done.push({ x: b.x, y: b.y, w: b.w, h: b.h, kind: 'panel', fill });
					for (const p of inner) open.push({ ...p, bg: fill, depth: b.depth + 1 });
					continue;
				}
			}
			done.push(b);
		}
		return [...done, ...open]
			.filter((b) => b.w >= 3 && b.h >= 3 && b.w * b.h >= 24)
			.map((b) => (b.kind === 'panel' ? b : { x: b.x, y: b.y, w: b.w, h: b.h }))
			.sort((a, b) => (Math.abs(a.y - b.y) < 2 ? (a.kind === 'panel' ? -1 : b.kind === 'panel' ? 1 : a.x - b.x) : a.y - b.y));
	}

	/** The box around everything that differs between two same-sized images outside `ignore` boxes, or null. */
	function diff(a, b, w, h, ignore = []) {
		let l = w, t = h, r = -1, u = -1, count = 0;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4;
				if (ignore.length && ignore.some((q) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h)) continue;
				if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) <= 48) continue;
				count++;
				if (x < l) l = x;
				if (x > r) r = x;
				if (y < t) t = y;
				if (y > u) u = y;
			}
		}
		// A blinking caret or a hover tint is not a change worth redrawing.
		if (count < 12 || (r - l + 1) * (u - t + 1) < 64) return null;
		return { x: l, y: t, w: r - l + 1, h: u - t + 1 };
	}

	/**
	 * The element under (x, y), within `reach` pixels: the area around it cut wherever a line has
	 * none of the element's own fill, which finds the gap between two light buttons however faint
	 * or tinted it is; text inside the element keeps its fill on every line. Null on plain
	 * background, where the fill is everywhere and nothing separates.
	 */
	function element(d, w, h, x, y, reach = 140) {
		const area = { x: Math.max(0, x - reach), y: Math.max(0, y - reach), w: 0, h: 0 };
		area.w = Math.min(w, x + reach + 1) - area.x; area.h = Math.min(h, y + reach + 1) - area.y;
		const x0 = Math.max(0, x - 12), y0 = Math.max(0, y - 12);
		const fill = dominant(d, w, h, { x: x0, y: y0, w: Math.min(25, w - x0), h: Math.min(25, h - y0) });
		let b = area;
		for (let i = 0; i < 10; i++) {
			const hit = cutAt(d, w, b, (j) => apart(d, j, fill) <= 12, 1, 0.05).find((p) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h);
			if (!hit || hit.w * hit.h >= b.w * b.h * 0.98) break;
			b = hit;
		}
		return b === area ? null : { x: b.x, y: b.y, w: b.w, h: b.h };
	}

	window.ZcEffectsGeometry = { dominant, rim, segment, diff, element };
})();
