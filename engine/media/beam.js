/**
 * Handoff beam: a short light along the bottom edge of a host (the composer, the Glow preview).
 *
 * Ported from the HandoffBeam reference to plain canvas 2D. Four phase weights (idle, listening,
 * thinking, speaking) glide on the same critically damped spring, so the light morphs instead of
 * switching; a level envelope shapes the curve, a shimmer travels the thinking line, and a colour
 * ramp tints the white mask. It runs for 2.6 s per flash (focus: listening → thinking → speaking;
 * Enter: thinking → speaking), then clears itself. Reduced motion gets one static pose.
 *
 * Triggers live in chat.js and settings.js; this file owns only the canvas and the simulation.
 */
(() => {
	'use strict';

	const TAU = Math.PI * 2;
	const POINTS = 96;
	const RAMP = 96;
	const DURATION = 2600;
	const SHIMMER_S = 1.5;
	const SHIMMER_W = 0.22;
	const DPR_CAP = 2;
	const ATTACK = 0.07;
	const RELEASE = 0.26;
	const REDUCE = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
	const HOSTS = new WeakMap();
	const PHASES = ['idle', 'listening', 'thinking', 'speaking'];
	const SPAN = { idle: 0.16, listening: 0.6, thinking: 0.3, speaking: 0.5 };
	const BRIGHT = { idle: 0.42, listening: 0.55, thinking: 0.85, speaking: 0.62 };
	/** Height above the bottom edge the light may use, in px. */
	const REACH = 24;

	const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
	const smooth = (u) => {
		const c = clamp01(u);
		return c * c * (3 - 2 * c);
	};
	const bump = (p) => 0.5 + 0.5 * Math.cos(TAU * p);
	const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

	/** Any CSS colour (including color-mix) resolved to RGB through a 1×1 canvas. */
	function rgb(value, fallback) {
		if (!probe) return fallback;
		probe.clearRect(0, 0, 1, 1);
		probe.fillStyle = fallback;
		probe.fillStyle = value || fallback;
		probe.fillRect(0, 0, 1, 1);
		const d = probe.getImageData(0, 0, 1, 1).data;
		return [d[0], d[1], d[2]];
	}

	/** The configured glow pair (metallic / custom) or the accent, as four phase colours. */
	function palette(host) {
		const body = document.body;
		const css = getComputedStyle(host);
		const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
		const light = body.classList.contains('is-light');
		const accent = read('--accent', '#f7931e');
		const strong = read('--accent-strong', accent);
		const g1 = read('--glow-1', '#0b0b0d');
		const g2 = read('--glow-2', '#e3e7ec');
		const g3 = read('--glow-3', '#7d8591');
		const accentMode = body.dataset.glowColor === 'accent';
		const core = accentMode ? [accent, strong, strong, accent] : [g2, g3, g2, g3];
		const edge = accentMode ? [accent, accent, accent, accent] : [g1, g3, g1, g3];
		return {
			core: core.map((c) => rgb(c, [227, 231, 236])),
			edge: edge.map((c) => rgb(c, [125, 133, 145])),
			glow: light ? 0.65 : 1.25,
			gain: light ? 1.7 : 1
		};
	}

	/** Critically damped step, integrated at the frame rate. */
	function spring(s, target, dt) {
		s.v += (-64 * (s.x - target) - 16 * s.v) * dt;
		s.x += s.v * dt;
	}

	/** A syllable-like level source for the demo; the clock is seconds since the flash began. */
	function voice(t, seed) {
		const carrier = 0.5 + 0.5 * Math.sin(TAU * 3.1 * t + 1.7 * Math.sin(t * 1.1 + seed));
		const phrase = clamp01(0.45 + 0.55 * Math.sin(t * 1.3 + seed * 2.1));
		const env = clamp01(carrier * carrier * phrase);
		return [env * (0.9 + 0.1 * Math.sin(t * 2.3)), env * (0.7 + 0.2 * Math.sin(t * 1.7)), env * 0.45];
	}

	function phaseAt(kind, ms) {
		if (kind === 'sweep') return ms < 650 ? 'thinking' : 'speaking';
		if (ms < 900) return 'listening';
		if (ms < 1800) return 'thinking';
		return 'speaking';
	}

	function clearCanvas(state) {
		const { ctx, canvas } = state;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
	}

	function finish(state) {
		cancelAnimationFrame(state.raf);
		state.raf = 0;
		clearTimeout(state.timer);
		state.timer = 0;
		clearCanvas(state);
		delete state.host.dataset.beam;
	}

	function resize(state) {
		const host = state.host;
		const cssW = host.clientWidth || 0;
		const cssH = Math.max(12, Math.min(state.reach, host.clientHeight || state.reach));
		state.cssW = cssW;
		state.cssH = cssH;
		state.canvas.style.height = cssH + 'px';
		const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
		const bw = Math.max(1, Math.round(cssW * dpr));
		const bh = Math.max(1, Math.round(cssH * dpr));
		if (state.canvas.width !== bw) state.canvas.width = bw;
		if (state.canvas.height !== bh) state.canvas.height = bh;
		if (!state.raf) clearCanvas(state);
	}

	function attach(host, opts = {}) {
		if (!host) return null;
		const existing = HOSTS.get(host);
		if (existing) return existing;
		const canvas = document.createElement('canvas');
		canvas.className = 'beam-canvas';
		canvas.setAttribute('aria-hidden', 'true');
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
		host.appendChild(canvas);
		const state = {
			host,
			canvas,
			ctx,
			cssW: 0,
			cssH: 0,
			reach: opts.reach || REACH,
			springs: PHASES.map(() => ({ x: 0, v: 0 })),
			env: [0, 0, 0],
			lvl: [0, 0, 0],
			clock: 0,
			shimmer: 0,
			lastPhase: '',
			start: 0,
			last: 0,
			raf: 0,
			timer: 0,
			kind: '',
			palette: null,
			strength: 0.35,
			ys: new Float32Array(POINTS + 1),
			ramp: null,
			rampData: null,
			observer: null
		};
		if (window.ResizeObserver) {
			state.observer = new ResizeObserver(() => resize(state));
			state.observer.observe(host);
		}
		HOSTS.set(host, state);
		document.body.classList.add('beam-ready');
		resize(state);
		return state;
	}

	function ensureRamp(state) {
		if (state.ramp) return;
		const ramp = document.createElement('canvas');
		ramp.width = RAMP;
		ramp.height = 1;
		const ctx = ramp.getContext('2d');
		if (!ctx) return;
		state.ramp = ramp;
		state.rampData = ctx.createImageData(RAMP, 1);
	}

	function ribbon(ctx, state, x0, dx, base, half, shimmerAt) {
		ctx.beginPath();
		for (let i = 0; i <= POINTS; i++) {
			const u = (i / POINTS) * 2 - 1;
			const q = 1 - u * u;
			const win = q * q;
			let thickness;
			if (Number.isNaN(shimmerAt)) thickness = 0.25 + 0.75 * Math.sqrt(win);
			else thickness = Math.exp(-(((u - shimmerAt) / SHIMMER_W) ** 2)) * win;
			const y = base - state.ys[i] - half * thickness;
			if (i === 0) ctx.moveTo(x0, y);
			else ctx.lineTo(x0 + i * dx, y);
		}
		for (let i = POINTS; i >= 0; i--) {
			const u = (i / POINTS) * 2 - 1;
			const q = 1 - u * u;
			const win = q * q;
			let thickness;
			if (Number.isNaN(shimmerAt)) thickness = 0.25 + 0.75 * Math.sqrt(win);
			else thickness = Math.exp(-(((u - shimmerAt) / SHIMMER_W) ** 2)) * win;
			ctx.lineTo(x0 + i * dx, base - state.ys[i] + half * thickness);
		}
		ctx.closePath();
		ctx.fill();
	}

	function draw(state, elapsed, dt, still) {
		const cssW = state.cssW;
		const cssH = state.cssH;
		if (cssW <= 0 || cssH <= 0) return;
		const pal = state.palette || palette(state.host);
		const kind = state.kind;
		const phase = still ? 'listening' : phaseAt(kind, elapsed);

		// One slide of the shimmer per thought; a calm breath while idle.
		if (!still) {
			if (phase === 'thinking' && state.lastPhase !== 'thinking') state.shimmer = 0;
			state.lastPhase = phase;
			state.clock += dt;
			const target = PHASES.indexOf(phase);
			for (let i = 0; i < 4; i++) spring(state.springs[i], i === target ? 1 : 0, dt);
			state.shimmer += dt * (0.35 + 0.65 * clamp01(state.springs[2].x));
		} else {
			state.springs.forEach((s, i) => {
				s.x = i === 1 ? 1 : 0;
				s.v = 0;
			});
			state.clock = 0.8;
		}
		const wI = clamp01(state.springs[0].x);
		const wL = clamp01(state.springs[1].x);
		const wT = clamp01(state.springs[2].x);
		const wS = clamp01(state.springs[3].x);

		// Levels enter through one attack/release envelope, then one more smoothing pass.
		let raw;
		if (still) raw = [0.6, 0.45, 0.3];
		else if (phase === 'listening') {
			const v = voice(state.clock, 11);
			raw = [0.12 + v[0] * 0.4, 0.06 + v[1] * 0.25, 0.03 + v[2] * 0.15];
		} else if (phase === 'thinking') raw = [0.36, 0.3, 0.18];
		else if (phase === 'speaking') raw = voice(state.clock, 29);
		else raw = [0.05, 0.03, 0.02];
		for (let b = 0; b < 3; b++) {
			const r = clamp01(raw[b]);
			if (still) {
				state.env[b] = r;
				state.lvl[b] = r;
			} else {
				const tau = r > state.env[b] ? ATTACK : RELEASE;
				state.env[b] += (r - state.env[b]) * (1 - Math.exp(-dt / tau));
				state.lvl[b] += (state.env[b] - state.lvl[b]) * (1 - Math.exp(-dt / (0.07 + 0.2 * wS)));
			}
		}
		const low = state.lvl[0];
		const mid = state.lvl[1];
		const high = state.lvl[2];
		const energy = clamp01(low * 0.5 + mid * 0.3 + high * 0.2);
		const shimmerAt = still ? 0 : -1.4 + 2.8 * ((state.shimmer / SHIMMER_S) % 1);
		const breath = still ? 0 : Math.sin(TAU * 0.2 * state.clock);

		const span = wI * SPAN.idle + wL * SPAN.listening + wT * SPAN.thinking + wS * SPAN.speaking;
		const bright =
			wI * (BRIGHT.idle + 0.1 * breath) +
			wL * (BRIGHT.listening + 0.45 * energy) +
			wT * BRIGHT.thinking +
			wS * (BRIGHT.speaking + 0.35 * energy);
		const amp = cssH * 0.9;
		const speakAmp = 0.28 + 0.72 * energy;
		const held = 0.45;

		// Curve: listening crests travel inwards, speaking crests outwards.
		for (let i = 0; i <= POINTS; i++) {
			const u = (i / POINTS) * 2 - 1;
			const q = 1 - u * u;
			const win = q * q;
			const d = Math.sqrt(u * u + 0.004);
			const listen =
				0.1 * bump(1.1 * d + 0.55 * state.clock) +
				low * 0.9 * bump(1.1 * d + 0.55 * state.clock) +
				mid * 0.4 * bump(2.3 * d + 0.95 * state.clock + 0.18 * u) +
				high * 0.24 * bump(3.8 * d + 1.5 * state.clock - 0.3 * u);
			const speak = speakAmp * (0.22 + 0.5 * bump(1.25 * d - 0.62 * state.clock) + 0.12 * bump(2.6 * d - 1.24 * state.clock));
			const sd = (u - shimmerAt) / (SHIMMER_W * 1.6);
			const think = held * (0.12 + 0.4 * Math.exp(-sd * sd));
			state.ys[i] = amp * win * (wL * listen + wS * speak + wT * think);
		}

		// Colour ramp: weighted core in the middle, edge at the ends, a lift at the shimmer.
		ensureRamp(state);
		if (!state.ramp || !state.rampData) return;
		const C = pal.core;
		const E = pal.edge;
		let cr = 0;
		let cg = 0;
		let cb = 0;
		let er = 0;
		let eg = 0;
		let eb = 0;
		for (let k = 0; k < 4; k++) {
			const wk = clamp01(state.springs[k].x);
			cr += wk * C[k][0];
			cg += wk * C[k][1];
			cb += wk * C[k][2];
			er += wk * E[k][0];
			eg += wk * E[k][1];
			eb += wk * E[k][2];
		}
		const data = state.rampData.data;
		for (let j = 0; j < RAMP; j++) {
			const u = ((j + 0.5) / RAMP) * 2 - 1;
			const d = u < 0 ? -u : u;
			const m = smooth((d - 0.15) / 0.75);
			const sd = (u - shimmerAt) / SHIMMER_W;
			const lift = wT * Math.exp(-sd * sd);
			const q = 1 - d * d;
			const a = clamp01(bright * pal.gain * state.strength * q * Math.sqrt(q) * (1 + 0.55 * lift));
			const o = j * 4;
			data[o] = cr + (er - cr) * m;
			data[o + 1] = cg + (eg - cg) * m;
			data[o + 2] = cb + (eb - cb) * m;
			data[o + 3] = a * 255;
		}
		const rctx = state.ramp.getContext('2d');
		if (!rctx) return;
		rctx.putImageData(state.rampData, 0, 0);

		// Canvas scaling and a soft in/out envelope over the 2.6 s run.
		const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
		const bw = Math.max(1, Math.round(cssW * dpr));
		const bh = Math.max(1, Math.round(cssH * dpr));
		if (state.canvas.width !== bw) state.canvas.width = bw;
		if (state.canvas.height !== bh) state.canvas.height = bh;
		const ctx = state.ctx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, bw, bh);
		ctx.setTransform(bw / cssW, 0, 0, bh / cssH, 0, 0);
		const fade = still ? 1 : Math.min(smooth(elapsed / 160), smooth((DURATION - elapsed) / 420));
		if (fade <= 0) return;
		const glow = pal.glow;
		const spanPx = Math.max(8, span * cssW);
		const x0 = Math.min(cssW - spanPx, Math.max(0, cssW / 2 - spanPx / 2));
		const dx = spanPx / POINTS;
		const base = cssH - 1;

		ctx.globalCompositeOperation = 'source-over';
		ctx.fillStyle = '#fff';
		// A blurred under-ribbon turns the hairline into light; canvas filters are ignored where absent.
		if (typeof ctx.filter === 'string') {
			ctx.save();
			ctx.filter = 'blur(5px)';
			ctx.globalAlpha = 0.3 * glow * fade;
			ribbon(ctx, state, x0, dx, base, 10, Number.NaN);
			ctx.restore();
		}
		for (let layer = 1; layer <= 3; layer++) {
			const f = layer / 3;
			ctx.globalAlpha = 0.08 * glow * fade;
			ctx.beginPath();
			ctx.moveTo(x0, base);
			for (let i = 0; i <= POINTS; i++) ctx.lineTo(x0 + i * dx, base - state.ys[i] * f);
			ctx.lineTo(x0 + spanPx, base);
			ctx.closePath();
			ctx.fill();
		}
		ctx.globalAlpha = 0.14 * glow * fade;
		ribbon(ctx, state, x0, dx, base, 7.5, Number.NaN);
		ctx.globalAlpha = 0.4 * glow * fade;
		ribbon(ctx, state, x0, dx, base, 3, Number.NaN);
		ctx.globalAlpha = fade;
		ribbon(ctx, state, x0, dx, base, 1.05, Number.NaN);
		if (wT > 0.01) {
			ctx.globalAlpha = 0.6 * wT * fade;
			ribbon(ctx, state, x0, dx, base, 1.8, shimmerAt);
		}

		// Tint the white mask with the ramp, keeping its alpha.
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-in';
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(state.ramp, x0, 0, spanPx, cssH);
		ctx.globalCompositeOperation = 'source-over';
	}

	window.ComposerBeam = {
		attach,
		flash(host, kind = 'touch') {
			if (!host || document.body.dataset.glow === 'off') return;
			const state = attach(host);
			if (!state) return;
			resize(state);
			if (state.cssW <= 0) return;
			cancelAnimationFrame(state.raf);
			clearTimeout(state.timer);
			state.timer = 0;
			state.raf = 0;
			state.kind = kind === 'sweep' ? 'sweep' : 'touch';
			state.start = performance.now();
			state.last = state.start;
			state.clock = 0;
			state.shimmer = 0;
			state.lastPhase = '';
			state.env.fill(0);
			state.lvl.fill(0);
			state.palette = palette(host);
			const strength = parseFloat(getComputedStyle(document.body).getPropertyValue('--glow-strength')) || 0.35;
			state.strength = 0.9 + strength * 1.2;
			const first = state.kind === 'sweep' ? 2 : 1;
			state.springs.forEach((s, i) => {
				s.x = i === first ? 1 : 0;
				s.v = 0;
			});
			state.canvas.style.mixBlendMode = document.body.classList.contains('is-light') ? 'normal' : 'screen';
			host.dataset.beam = state.kind;
			// A hidden or reduced-motion page gets one still pose: requestAnimationFrame is
			// paused in a background window, and an invisible light has nothing to animate.
			if (REDUCE.matches || document.hidden) {
				draw(state, 0, 1 / 60, true);
				state.raf = 1;
				state.timer = setTimeout(() => finish(state), DURATION);
				return;
			}
			const step = (now) => {
				if (!state.raf) return;
				const dt = Math.min(0.05, Math.max(0, (now - state.last) / 1000));
				state.last = now;
				const elapsed = now - state.start;
				if (elapsed >= DURATION) {
					finish(state);
					return;
				}
				draw(state, elapsed, dt || 1 / 60, false);
				state.raf = requestAnimationFrame(step);
			};
			state.raf = requestAnimationFrame((now) => {
				state.last = now;
				step(now);
			});
		},
		clear(host) {
			const state = host && HOSTS.get(host);
			if (state) finish(state);
		},
		refresh(host) {
			const state = host && HOSTS.get(host);
			if (!state) return;
			state.palette = palette(host);
			if (!state.raf) clearCanvas(state);
		}
	};
})();
