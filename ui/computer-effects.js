// The Computer Use "Design cursor": one design-tool cursor over the controlled app. The app passes
// on what app/computer-overlay.cs reports (the window, the action and its point, in this window's
// coordinates) and, with each observation, the window's pixels. The page redraws the window (all
// of it the first time, then only what changed), marks each action, and tells the app once the
// visual for an action is on screen: the overlay lets that action's input through only then.
(function () {
	'use strict';
	const G = window.ZcEffectsGeometry;
	const shell = window.__zcShell;
	const cv = document.getElementById('stage');
	const g = cv.getContext('2d');
	const bar = document.getElementById('bar');
	const BLUE = '#0D99FF', RED = '#F24822', RULER = 20;
	const { min, max, abs, hypot, sin, sqrt, round, PI, random } = Math;
	const clamp = (v, a, b) => max(a, min(b, v));
	const rand = (a, b) => a + random() * (b - a);
	const smooth = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
	const outCubic = (t) => 1 - (1 - t) ** 3;
	const LABELS = { screenshot: 'Checking the screen', approval: 'Waiting for approval', click: 'Clicking', double_click: 'Double-clicking', right_click: 'Right-clicking', move: 'Moving pointer', scroll: 'Scrolling', type: 'Typing', key: 'Pressing keys' };

	let D = window.devicePixelRatio || 1, W = 0, H = 0, raf = 0, last = 0, barAt = 0;
	const S = { view: null, frame: null, build: null, window: '', t: 0, tempo: 1, acked: '', ackTimer: 0, mark: null, lastBox: null, recent: [], fx: [], rulers: 0, label: '' };
	const C = { x: -100, y: -100, alpha: 0, want: 0, shape: 'arrow', press: 0, gen: null, ov: null, building: false };

	// ------------------------------------------------------------------ the cursor
	const PATHS = {
		arrow: new Path2D('M3.6 2.8 L21.6 10.2 L13.4 12.9 L10.5 21.2 Z'),
		cross: new Path2D('M12 3.5 V20.5 M3.5 12 H20.5'),
		ibeam: new Path2D('M8.6 4.4 C10.4 4.4 12 4.8 12 6.4 C12 4.8 13.6 4.4 15.4 4.4 M12 6.4 V17.6 M8.6 19.6 C10.4 19.6 12 19.2 12 17.6 C12 19.2 13.6 19.6 15.4 19.6'),
		ew: new Path2D('M2.6 12 L7.2 7.6 V10.4 H16.8 V7.6 L21.4 12 L16.8 16.4 V13.6 H7.2 V16.4 Z')
	};
	const HOT = { arrow: [3.6, 2.8], cross: [12, 12], ibeam: [12, 12], ew: [12, 12], ns: [12, 12] };
	const sprites = new Map();
	function sprite(shape) {
		const key = shape + D;
		if (sprites.has(key)) return sprites.get(key);
		const off = new OffscreenCanvas(round(36 * D), round(36 * D)), x = off.getContext('2d');
		x.scale(D, D); x.translate(5, 5); x.lineJoin = x.lineCap = 'round';
		x.shadowColor = 'rgba(0,0,0,.32)'; x.shadowBlur = 2.5 * D; x.shadowOffsetY = D;
		if (shape === 'cross' || shape === 'ibeam') {
			x.strokeStyle = '#fff'; x.lineWidth = 3.6; x.stroke(PATHS[shape]);
			x.shadowColor = 'transparent'; x.strokeStyle = BLUE; x.lineWidth = 1.5; x.stroke(PATHS[shape]);
		} else {
			if (shape === 'ns') { x.translate(12, 12); x.rotate(PI / 2); x.translate(-12, -12); }
			const p = shape === 'arrow' ? PATHS.arrow : PATHS.ew;
			x.fillStyle = BLUE; x.strokeStyle = '#fff'; x.lineWidth = 1.5; x.stroke(p); x.fill(p);
		}
		sprites.set(key, off);
		return off;
	}

	// ------------------------------------------------------------------ motion
	function* wait(s) { for (let n = 0; n < s;) n += (yield) * S.tempo; }
	function* rest(s) { for (let n = 0; n < s;) n += yield; }
	function* tween(s, fn) { for (let k = 0; k < 1;) { k = min(1, k + ((yield) * S.tempo) / s); fn(k); } }
	/** A slightly curved move; `seconds` is a fixed real duration (actions), else it follows the build's tempo. */
	function* go(tx, ty, o = {}) {
		const sx = C.x, sy = C.y, dist = hypot(tx - sx, ty - sy);
		if (dist < 0.5) { C.x = tx; C.y = ty; o.onStep?.(); return; }
		const T = o.seconds || clamp(0.1 + 0.022 * sqrt(dist), 0.14, 0.9) / (o.pace || 1);
		const arc = o.straight ? 0 : (random() < 0.5 ? -1 : 1) * rand(0.04, 0.12) * min(dist, 500);
		for (let t = 0; t < T;) {
			const dt = yield;
			t += o.seconds ? dt : dt * S.tempo;
			const k = min(1, t / T), e = o.straight || k < 0.15 ? smooth(k) : outCubic(k), n = sin(PI * e) * arc;
			C.x = sx + (tx - sx) * e - ((ty - sy) / dist) * n;
			C.y = sy + (ty - sy) * e + ((tx - sx) / dist) * n;
			o.onStep?.();
		}
		C.x = tx; C.y = ty; o.onStep?.();
	}

	// ------------------------------------------------------------------ pixels
	const px = (v) => round(v * S.frame.k);
	/** Copies part of the observed window (local DIPs) to `ctx` at its own pixels, offset by (ox, oy). */
	function cropTo(ctx, ox, oy, x, y, w, h) {
		const f = S.frame, sx = max(0, px(x)), sy = max(0, px(y)), ex = min(f.img.width, px(x + w)), ey = min(f.img.height, px(y + h));
		if (ex > sx && ey > sy) ctx.drawImage(f.img, sx, sy, ex - sx, ey - sy, ox + sx, oy + sy, ex - sx, ey - sy);
	}
	// Full pixels around the point: the gap between two light buttons is a pixel or two wide.
	function elementAt(point) {
		const v = S.view, f = S.frame;
		if (!f || !v) return null;
		const lx = point.x - v.rect.x, ly = point.y - v.rect.y, reach = 150;
		if (lx < 0 || ly < 0 || lx >= f.w || ly >= f.h) return null;
		const sx = max(0, px(lx - reach)), sy = max(0, px(ly - reach)), ex = min(f.img.width, px(lx + reach)), ey = min(f.img.height, px(ly + reach));
		const c = new OffscreenCanvas(ex - sx, ey - sy).getContext('2d', { willReadFrequently: true });
		c.drawImage(f.img, sx, sy, ex - sx, ey - sy, 0, 0, ex - sx, ey - sy);
		const e = G.element(c.getImageData(0, 0, ex - sx, ey - sy).data, ex - sx, ey - sy, px(lx) - sx, px(ly) - sy, px(reach));
		const box = e && { x: (sx + e.x) / f.k, y: (sy + e.y) / f.k, w: e.w / f.k, h: e.h / f.k };
		const sane = box && box.w >= 10 && box.h >= 10 && box.w <= f.w * 0.85 && box.h <= f.h * 0.6;
		return sane ? box : { x: lx - 18, y: ly - 18, w: 36, h: 36 };
	}

	// ------------------------------------------------------------------ rebuilding the window
	function startBuild(full, changed) {
		const f = S.frame, sm = f.small;
		const pad = 3, area = full ? { x: 0, y: 0, w: sm.w, h: sm.h } : { x: max(0, changed.x - pad), y: max(0, changed.y - pad), w: 0, h: 0 };
		if (!full) { area.w = min(sm.w - area.x, changed.w + pad * 2); area.h = min(sm.h - area.y, changed.h + pad * 2); }
		const local = (b) => ({ x: b.x / sm.s, y: b.y / sm.s, w: b.w / sm.s, h: b.h / sm.s });
		const blocks = G.segment(sm.d, sm.w, sm.h, area, full ? 16 : 6).map((b) => {
			const l = local(b), text = b.kind !== 'panel' && l.h <= 34 && l.w >= l.h * 1.8;
			if (b.kind === 'panel') return { ...l, kind: 'panel', fill: `rgb(${b.fill[0]},${b.fill[1]},${b.fill[2]})` };
			return { ...l, kind: text ? 'text' : 'box', chars: text ? clamp(round(l.w / max(5, l.h * 0.55)), 3, 120) : 0 };
		});
		if (!blocks.length) return;
		// Inside the window's own edge, which is a darker line.
		const inner = area.w > 40 && area.h > 40 ? { x: area.x + 2, y: area.y + 2, w: area.w - 4, h: area.h - 4 } : area;
		const [r, gr, bl] = G.rim(sm.d, sm.w, inner), dark = (0.2126 * r + 0.7152 * gr + 0.0722 * bl) / 255 < 0.45;
		const base = new OffscreenCanvas(f.img.width, f.img.height);
		const b = { full, area: local(area), bg: `rgb(${r},${gr},${bl})`, dark, ph: dark ? '#7B858E' : '#D9D9D9', blocks, done: 0, cover: 0, fade: 1, revealing: false, base, bx: base.getContext('2d'), active: null, guide: null, rulers: full };
		if (full) b.guide = guideFor(blocks);
		// The whole window takes about four seconds, a changed part about one (a block takes
		// about two seconds at normal pace: move, drag, then fill or type).
		S.tempo = clamp((blocks.length * 1.9 + (full ? 0.8 : 0)) / (full ? 4.2 : 1.2), 1.4, 8);
		S.build = b;
		C.want = 1;
		if (C.alpha < 0.01) enter();
		C.building = true;
		C.gen = buildGen(b);
		paintBar(true);
	}
	function guideFor(blocks) {
		const lefts = new Map();
		for (const b of blocks) if (b.kind === 'text') { const x = round(b.x / 2) * 2; lefts.set(x, (lefts.get(x) || 0) + 1); }
		const best = [...lefts].sort((a, b) => b[1] - a[1])[0];
		return best && best[1] >= 2 ? { x: best[0], cur: 0, op: 0, flash: 0, dragging: false } : null;
	}
	function* buildGen(b) {
		if (b.guide) yield* dragGuide(b);
		for (const blk of b.blocks) {
			if (S.build !== b) return;
			yield* blk.kind === 'text' ? drawText(b, blk) : drawBox(b, blk);
			b.done++;
		}
		C.shape = 'arrow'; C.ov = null;
		yield* wait(0.12);
		b.revealing = true; b.rulers = false;
		C.building = false;
	}
	function* dragGuide(b) {
		const R = S.view.rect, gd = b.guide;
		C.shape = 'arrow';
		yield* go(R.x + 10, R.y + R.h * 0.45);
		while (S.rulers < 0.95) yield;
		C.press = 1; C.shape = 'ew'; gd.dragging = true; gd.op = 1; gd.cur = C.x - R.x;
		yield* go(R.x + gd.x, R.y + R.h * 0.45 + 30, { pace: 0.55, straight: true, onStep() { gd.cur = C.x - R.x; } });
		gd.cur = gd.x; gd.dragging = false; gd.flash = 1;
		C.shape = 'arrow';
		yield* wait(0.15);
	}
	function* drawBox(b, blk) {
		const R = S.view.rect;
		C.shape = 'cross';
		yield* go(R.x + blk.x, R.y + blk.y);
		C.press = 1; blk.draw = { w: 0, h: 0 }; b.active = blk;
		C.ov = () => [select(blk)];
		yield* go(R.x + blk.x + blk.w, R.y + blk.y + blk.h, { pace: 0.75, straight: true, onStep() { blk.draw = { w: max(0, C.x - R.x - blk.x), h: max(0, C.y - R.y - blk.y) }; } });
		blk.draw = null; C.shape = 'arrow';
		yield* wait(0.1);
		yield* tween(0.32, (k) => { blk.sweep = outCubic(k); });
		commit(b, blk);
		C.ov = null;
	}
	function* drawText(b, blk) {
		const R = S.view.rect;
		C.shape = 'cross';
		yield* go(R.x + blk.x, R.y + blk.y);
		C.press = 1;
		const ghost = { x: blk.x, y: blk.y, w: 0, h: 0 };
		C.ov = () => [{ b: ghost, handles: true, badge: `${round(ghost.w)} × ${round(ghost.h)}`, rulerLines: true }];
		yield* go(R.x + blk.x + blk.w, R.y + blk.y + blk.h, { pace: 0.9, straight: true, onStep() { ghost.w = max(0, C.x - R.x - blk.x); ghost.h = max(0, C.y - R.y - blk.y); } });
		C.shape = 'ibeam'; blk.shown = 0; blk.typing = true; b.active = blk;
		C.ov = () => [{ b: blk }];
		yield* go(C.x + rand(-24, 8), C.y + rand(8, 22), { pace: 1.5 });
		const rate = clamp(60 / blk.chars, 0.08, 1);
		let budget = 0;
		while (blk.shown < blk.chars) {
			budget += (yield) * S.tempo;
			while (budget > 0 && blk.shown < blk.chars) { budget -= rand(0.012, 0.035) * rate; blk.shown++; }
		}
		blk.typing = false; C.shape = 'arrow'; C.ov = () => [select(blk)];
		yield* wait(0.15);
		commit(b, blk);
		C.ov = null;
	}
	// A panel is only its fill: what is inside it is drawn next.
	function commit(b, blk) {
		if (blk.kind === 'panel') { b.bx.fillStyle = blk.fill; b.bx.fillRect(px(blk.x), px(blk.y), px(blk.x + blk.w) - px(blk.x), px(blk.y + blk.h) - px(blk.y)); }
		else cropTo(b.bx, 0, 0, blk.x, blk.y, blk.w, blk.h);
		b.active = null;
	}
	const select = (blk) => {
		const w = blk.draw ? blk.draw.w : blk.w, h = blk.draw ? blk.draw.h : blk.h;
		return { b: { x: blk.x, y: blk.y, w, h }, handles: true, badge: `${round(w)} × ${round(h)}`, rulerLines: true };
	};
	/** Input never waits on a drawing: the real window shows again at once. */
	function finish() {
		if (S.build) { S.build = null; if (C.building) { C.gen = null; C.ov = null; C.shape = 'arrow'; } }
		C.building = false;
		S.tempo = 1;
	}

	// ------------------------------------------------------------------ actions
	function ack(id) {
		clearTimeout(S.ackTimer);
		if (!id || S.acked === id) return;
		S.acked = id;
		shell.invoke('effects_shown', { id }).catch(() => undefined);
	}
	function enter() {
		const R = S.view.rect;
		C.x = R.x - 30; C.y = R.y + R.h * 0.55; C.alpha = 0;
	}
	function* leave() {
		const R = S.lastRect || { x: 0, y: 0, w: W, h: H };
		C.want = 0;
		yield* go(C.x > R.x + R.w / 2 ? R.x + R.w + 50 : R.x - 50, C.y + rand(-30, 30), { seconds: 0.45 });
	}
	function* actionGen(v) {
		C.shape = v.action === 'scroll' ? 'ns' : 'arrow'; C.ov = null;
		const d = hypot(v.point.x - C.x, v.point.y - C.y);
		yield* go(v.point.x, v.point.y, { seconds: clamp(0.12 + 0.016 * sqrt(d), 0.14, 0.36) });
		ack(v.id);
		if (/click/.test(v.action)) { C.press = 1; S.fx.push({ x: v.point.x, y: v.point.y, t: 0 }); }
		const box = elementAt(v.point);
		if (box) { S.lastBox = box; S.recent = [box, ...S.recent].slice(0, 2); S.mark = { b: box, until: S.t + 1.2 }; }
		yield* rest(0.2);
		if (v.action === 'scroll') C.shape = 'arrow';
	}
	function act(v) {
		S.label = LABELS[v.action] || 'Working';
		if (C.alpha < 0.01 && !C.gen) enter();
		C.want = v.action === 'approval' ? 0.55 : 1;
		if (v.action === 'screenshot' || v.action === 'approval') {
			if (!S.build) { C.gen = null; C.shape = 'arrow'; }
			ack(v.id);
			return;
		}
		finish();
		if (v.action === 'type' || v.action === 'key' || !v.point) {
			C.gen = null; C.shape = v.action === 'type' ? 'ibeam' : 'arrow';
			if (v.action === 'type' && S.lastBox) S.mark = { b: S.lastBox, until: S.t + 1.6, caret: true };
			ack(v.id);
			return;
		}
		C.gen = actionGen(v);
		// The visual is a courtesy: a stalled frame never holds the action for long.
		S.ackTimer = setTimeout(() => ack(v.id), 600);
	}
	function onState(v) {
		const prev = S.view;
		if (v.mode === 'hidden' || !v.rect) {
			S.view = null; finish(); S.frame = null; S.mark = null; S.recent = [];
			if (C.alpha > 0.01 && prev) C.gen = leave(); else C.want = 0;
			paintBar(true); wake();
			return;
		}
		S.view = v; S.lastRect = v.rect;
		const moved = prev && prev.rect && (abs(prev.rect.x - v.rect.x) > 1 || abs(prev.rect.y - v.rect.y) > 1 || abs(prev.rect.w - v.rect.w) > 1 || abs(prev.rect.h - v.rect.h) > 1);
		if (v.window !== S.window || (moved && (abs(prev.rect.w - v.rect.w) > 1 || abs(prev.rect.h - v.rect.h) > 1))) { S.window = v.window; S.frame = null; S.recent = []; finish(); }
		else if (moved) finish();
		if (v.mode === 'paused') {
			finish(); S.frame = null; S.mark = null;
			if (prev?.mode !== 'paused' && C.alpha > 0.01) C.gen = leave(); else if (!C.gen) C.want = 0;
			paintBar(true); wake();
			return;
		}
		if (!v.focused) {
			finish(); C.gen = null; C.want = 0; S.mark = null;
			ack(v.id);
			paintBar(true); wake();
			return;
		}
		if (!(prev && prev.id === v.id && prev.mode === 'active' && prev.focused)) act(v);
		paintBar(true); wake();
	}
	async function onFrame(m) {
		const v = S.view;
		if (!v || v.mode !== 'active' || !v.focused || m.id !== v.id || S.build) return;
		const img = new Image();
		img.src = m.image;
		await img.decode();
		const bitmap = await createImageBitmap(img);
		if (S.view !== v || S.build || !v.focused) { bitmap.close(); return; }
		const s = min(1, 640 / max(bitmap.width, bitmap.height)), sw = max(1, round(bitmap.width * s)), sh = max(1, round(bitmap.height * s));
		const off = new OffscreenCanvas(sw, sh), c = off.getContext('2d', { willReadFrequently: true });
		c.drawImage(bitmap, 0, 0, sw, sh);
		const small = { d: c.getImageData(0, 0, sw, sh).data, w: sw, h: sh, s: sw / m.rect.w };
		const prev = S.frame;
		S.frame = { img: bitmap, k: bitmap.width / m.rect.w, w: m.rect.w, h: m.rect.h, small };
		if (!C.gen) {
			if (!prev || prev.small.w !== sw || prev.small.h !== sh) startBuild(true, null);
			else {
				// The element just clicked changes its own hover or pressed tint: not a change to redraw.
				const ignore = S.recent.map((b) => ({ x: round((b.x - 3) * small.s), y: round((b.y - 3) * small.s), w: round((b.w + 6) * small.s), h: round((b.h + 6) * small.s) }));
				const changed = G.diff(prev.small.d, small.d, sw, sh, ignore);
				if (changed) startBuild(false, changed);
			}
		}
		if (prev) prev.img.close();
		wake();
	}

	// ------------------------------------------------------------------ the bar
	function paintBar(force) {
		if (!force && S.t - barAt < 0.1) return;
		barAt = S.t;
		const v = S.view;
		bar.classList.toggle('on', !!v);
		if (!v) return;
		const paused = v.mode === 'paused';
		bar.classList.toggle('paused', paused);
		bar.querySelector('.title').textContent = paused ? (v.handoff ? "You're in control" : 'Computer Use paused') : `zer0ne controls ${v.title || 'this app'}`;
		bar.querySelector('.action').textContent = paused ? 'Resume in app permissions' : S.label;
		const b = S.build, layers = bar.querySelector('.layers');
		layers.hidden = !b || paused;
		if (b) { layers.querySelector('.count').textContent = `${b.done} / ${b.blocks.length} layers`; layers.querySelector('.meter i').style.width = `${(b.done / b.blocks.length) * 100}%`; }
		const pause = bar.querySelector('.pause');
		pause.textContent = paused ? 'Resume…' : 'Pause';
		pause.title = paused ? 'Open Computer Use permissions to resume' : 'Pause Computer Use';
		const R = v.rect, bw = bar.offsetWidth || 420, bh = 38, inside = R.w >= bw + 24 && R.h >= 220;
		let y = inside ? R.y + R.h - bh - 16 : R.y + R.h + 12 <= H - bh - 8 ? R.y + R.h + 12 : max(8, R.y - bh - 12);
		const p = v.point;
		if (inside && p && abs(p.y - (y + bh / 2)) < 44 && abs(p.x - (R.x + R.w / 2)) < bw / 2 + 30) y = R.y + 16;
		bar.style.left = `${clamp(R.x + R.w / 2, bw / 2 + 8, W - bw / 2 - 8)}px`;
		bar.style.top = `${y}px`;
	}
	bar.addEventListener('mouseenter', () => shell.invoke('effects_hover', { on: true }).catch(() => undefined));
	bar.addEventListener('mouseleave', () => shell.invoke('effects_hover', { on: false }).catch(() => undefined));
	bar.querySelector('.pause').addEventListener('click', () => shell.invoke('effects_control', { action: S.view?.mode === 'paused' ? 'resume' : 'pause' }).catch(() => undefined));
	bar.querySelector('.stop').addEventListener('click', () => shell.invoke('effects_control', { action: 'stop' }).catch(() => undefined));

	// ------------------------------------------------------------------ drawing
	const logical = () => g.setTransform(D, 0, 0, D, 0, 0);
	const device = () => g.setTransform(1, 0, 0, 1, 0, 0);
	const widths = new Map();
	const textWidth = (s) => { let w = widths.get(s); if (w === undefined) { w = g.measureText(s).width; if (widths.size > 300) widths.clear(); widths.set(s, w); } return w; };
	function badge(x, y, text, color) {
		g.font = '600 11px "Segoe UI", sans-serif';
		const w = textWidth(text) + 8, l = x - w / 2;
		g.fillStyle = color; g.beginPath(); g.roundRect(l, y, w, 17, 2); g.fill();
		g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(text, l + 4, y + 9);
	}
	function box(R, o, alpha = 1) {
		const x = R.x + o.b.x, y = R.y + o.b.y, w = o.b.w, h = o.b.h, col = o.color || BLUE;
		g.globalAlpha = alpha; g.strokeStyle = col; g.lineWidth = 1; g.strokeRect(x, y, w, h);
		if (o.rulerLines && S.rulers > 0.05) {
			g.save(); g.globalAlpha = alpha * S.rulers; g.setLineDash([2, 2]); g.beginPath();
			g.moveTo(R.x + RULER, y + h / 2); g.lineTo(x, y + h / 2); g.moveTo(x + w / 2, R.y + RULER); g.lineTo(x + w / 2, y); g.stroke(); g.restore();
		}
		if (o.handles) { g.fillStyle = '#fff'; for (const [a, b] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) { g.fillRect(a - 3.5, b - 3.5, 7, 7); g.strokeRect(a - 3.5, b - 3.5, 7, 7); } }
		if (o.badge && w > 0) badge(x + w / 2, min(y + h + 8, R.y + R.h - 20), o.badge, col);
		g.globalAlpha = 1;
	}
	let rulerCache = null;
	function rulers(R, spans) {
		const t = S.rulers;
		if (t <= 0.001) return;
		if (!rulerCache || rulerCache.w !== R.w || rulerCache.h !== R.h || rulerCache.d !== D) {
			const make = (w, h, vertical) => {
				const off = new OffscreenCanvas(max(1, round(w * D)), max(1, round(h * D))), c = off.getContext('2d');
				c.scale(D, D); c.fillStyle = '#2c2c2c'; c.fillRect(0, 0, w, h); c.strokeStyle = '#5e5e5e'; c.fillStyle = '#8c8c8c'; c.font = '500 9px "Segoe UI", sans-serif'; c.lineWidth = 1;
				for (let p = 0; p < (vertical ? h : w); p += 50) {
					const major = p % 100 === 0;
					c.beginPath();
					if (vertical) { c.moveTo(major ? 13 : 16, p + 0.5); c.lineTo(RULER, p + 0.5); } else { c.moveTo(p + 0.5, major ? 13 : 16); c.lineTo(p + 0.5, RULER); }
					c.stroke();
					if (major && vertical) { c.save(); c.translate(11, p - 3); c.rotate(-PI / 2); c.fillText(String(p), 0, 0); c.restore(); } else if (major) c.fillText(String(p), p + 3, 11);
				}
				c.fillStyle = '#3a3a3a'; if (vertical) c.fillRect(RULER - 1, 0, 1, h); else c.fillRect(0, RULER - 1, w, 1);
				return off;
			};
			rulerCache = { w: R.w, h: R.h, d: D, top: make(R.w, RULER, false), left: make(RULER, R.h, true) };
		}
		const off = (t - 1) * RULER;
		g.drawImage(rulerCache.top, R.x, R.y + off, R.w, RULER);
		g.drawImage(rulerCache.left, R.x + off, R.y, RULER, R.h);
		g.font = '500 9px "Segoe UI", sans-serif'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
		for (const s of spans) {
			g.fillStyle = 'rgba(13,153,255,.22)'; g.fillRect(R.x + s.x, R.y + off, s.w, RULER); g.fillRect(R.x + off, R.y + s.y, RULER, s.h);
			g.fillStyle = BLUE; g.fillText(String(round(s.x)), R.x + s.x + 3, R.y + off + 11);
		}
		const gd = S.build?.guide;
		if (gd?.dragging) { g.fillStyle = RED; g.fillRect(R.x + gd.cur, R.y + off, 1, RULER); g.fillText(String(round(gd.cur)), R.x + gd.cur + 4, R.y + off + 11); }
		g.fillStyle = '#2c2c2c'; g.globalAlpha = t; g.fillRect(R.x, R.y, RULER, RULER); g.globalAlpha = 1;
	}
	function paintBuild(b, R) {
		const ox = round(R.x * D), oy = round(R.y * D);
		if (b.cover > 0) { g.globalAlpha = b.cover * b.fade; g.fillStyle = b.bg; g.fillRect(R.x + b.area.x, R.y + b.area.y, b.area.w, b.area.h); }
		g.globalAlpha = b.fade;
		device(); g.drawImage(b.base, ox, oy); logical();
		const blk = b.active;
		if (blk && blk.kind === 'text' && blk.shown !== undefined) {
			const frac = blk.typing ? blk.shown / blk.chars : 1;
			device(); cropTo(g, ox, oy, blk.x, blk.y, blk.w * frac, blk.h); logical();
			if (blk.typing && (S.t * 2) % 1 < 0.6) { g.fillStyle = b.dark ? '#fff' : '#111'; g.fillRect(R.x + blk.x + blk.w * frac, R.y + blk.y + 2, 1.5, blk.h - 4); }
		} else if (blk && blk.kind === 'panel') {
			const w = blk.draw ? blk.draw.w : blk.w, h = blk.draw ? blk.draw.h : blk.h;
			g.fillStyle = b.ph; g.fillRect(R.x + blk.x, R.y + blk.y, w, h);
			if (blk.sweep) { g.globalAlpha = b.fade * blk.sweep; g.fillStyle = blk.fill; g.fillRect(R.x + blk.x, R.y + blk.y, blk.w, blk.h); g.globalAlpha = b.fade; }
		} else if (blk && blk.kind === 'box') {
			const w = blk.draw ? blk.draw.w : blk.w, h = blk.draw ? blk.draw.h : blk.h;
			g.fillStyle = b.ph; g.fillRect(R.x + blk.x, R.y + blk.y, w, h);
			if (!blk.draw && !blk.sweep && w > 60 && h > 44) {
				const a = R.x + blk.x + w / 2, c = R.y + blk.y + h / 2;
				g.strokeStyle = b.dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.35)'; g.lineWidth = 1.2; g.strokeRect(a - 9, c - 7, 18, 14);
			}
			if (blk.sweep) { device(); cropTo(g, ox, oy, blk.x, blk.y, blk.w, blk.h * blk.sweep); logical(); }
		}
		const gd = b.guide;
		if (gd && gd.op > 0) {
			g.globalAlpha = gd.op * b.fade;
			if (gd.flash > 0) { g.strokeStyle = 'rgba(242,72,34,.22)'; g.lineWidth = 2 + gd.flash * 3; g.beginPath(); g.moveTo(R.x + gd.cur, R.y); g.lineTo(R.x + gd.cur, R.y + R.h); g.stroke(); }
			g.strokeStyle = RED; g.lineWidth = 1 + gd.flash; g.beginPath(); g.moveTo(R.x + gd.cur, R.y); g.lineTo(R.x + gd.cur, R.y + R.h); g.stroke();
		}
		g.globalAlpha = 1;
	}
	function render() {
		device(); g.clearRect(0, 0, cv.width, cv.height); logical();
		const v = S.view, R = v?.rect;
		if (R) {
			g.save(); g.beginPath(); g.rect(R.x, R.y, R.w, R.h); g.clip();
			if (S.build) paintBuild(S.build, R);
			const overlays = C.ov ? C.ov() : [];
			for (const o of overlays) box(R, o);
			const mark = S.mark;
			if (mark) box(R, { b: mark.b, handles: true, badge: `${round(mark.b.w)} × ${round(mark.b.h)}`, rulerLines: true }, clamp((mark.until - S.t) / 0.25, 0, 1));
			rulers(R, [...overlays, ...(mark ? [{ b: mark.b, handles: true }] : [])].filter((o) => o.handles).map((o) => o.b));
			g.restore();
		}
		for (const f of S.fx) { const k = f.t / 0.6; g.globalAlpha = (1 - k) * 0.9; g.strokeStyle = BLUE; g.lineWidth = 2; g.beginPath(); g.arc(f.x, f.y, 10 + 26 * outCubic(k), 0, 7); g.stroke(); }
		g.globalAlpha = 1;
		if (C.alpha > 0.01) {
			const sp = sprite(C.shape), [hx, hy] = HOT[C.shape], s = 1 - C.press * 0.12;
			g.save(); g.globalAlpha = C.alpha; g.translate(round(C.x * D) / D, round(C.y * D) / D); if (s !== 1) g.scale(s, s);
			g.drawImage(sp, -hx - 5, -hy - 5, 36, 36); g.restore();
			const text = S.label ? `zer0ne · ${S.label}` : 'zer0ne';
			g.font = '600 11px "Segoe UI", sans-serif';
			const w = textWidth(text) + 12, x = clamp(C.x + 15, 4, W - w - 4), y = clamp(C.ov || S.mark ? C.y - 30 : C.y + 15, 4, H - 24);
			g.globalAlpha = C.alpha; g.fillStyle = BLUE; g.beginPath(); g.roundRect(x, y, w, 19, 5); g.fill();
			g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(text, x + 6, y + 10); g.globalAlpha = 1;
		}
	}
	function step(dt) {
		S.t += dt;
		C.press = max(0, C.press - dt * 6);
		C.alpha += clamp(C.want - C.alpha, -dt * 5, dt * 5);
		if (C.gen && C.gen.next(dt).done) { C.gen = null; if (C.building) C.building = false; }
		const b = S.build;
		const wantRulers = (b && b.rulers) || (S.mark && S.t < S.mark.until) ? 1 : 0;
		S.rulers += (wantRulers - S.rulers) * min(1, dt * 10);
		if (abs(wantRulers - S.rulers) < 0.002) S.rulers = wantRulers;
		if (b) {
			b.cover = min(1, b.cover + dt * (b.full ? 4 : 9));
			if (b.guide) b.guide.flash = max(0, b.guide.flash - dt * 1.5);
			if (b.revealing) { b.fade -= dt * 3; if (b.fade <= 0) { S.build = null; S.tempo = 1; paintBar(true); } }
		}
		for (let i = S.fx.length - 1; i >= 0; i--) { S.fx[i].t += dt; if (S.fx[i].t > 0.6) S.fx.splice(i, 1); }
		if (S.mark && S.t > S.mark.until) S.mark = null;
		if (S.build) paintBar();
	}
	const moving = () => C.gen || S.build || S.fx.length || S.mark || abs(C.alpha - C.want) > 0.001 || C.press > 0 || (S.rulers > 0 && S.rulers < 1);
	function frame(now) {
		raf = 0;
		const dt = last ? min(0.05, (now - last) / 1000) : 1 / 60;
		last = now;
		step(dt);
		render();
		if (moving()) raf = requestAnimationFrame(frame);
		else last = 0;
	}
	function wake() { if (!raf) raf = requestAnimationFrame(frame); }
	function resize() {
		D = window.devicePixelRatio || 1; W = window.innerWidth; H = window.innerHeight;
		cv.width = max(1, round(W * D)); cv.height = max(1, round(H * D));
		wake();
	}
	window.addEventListener('resize', resize);
	resize();

	window.__zcEffects = (m) => {
		try {
			if (m?.type === 'state') onState(m);
			else if (m?.type === 'frame') onFrame(m).catch(() => undefined);
		} catch {
			// Drawing failed: the action still goes ahead under the overlay's guard.
			if (m?.id) ack(m.id);
		}
	};
})();
