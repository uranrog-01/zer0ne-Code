/*
 * Activity orbs: <zc-orb kind="…"> draws a small animated particle orb for work in
 * progress (a running chat in the sidebar, a running tool step, the live status pill).
 *   spark   a glowing starburst (a chat session at work)
 *   sphere  a rotating sphere of dots (reading)
 *   bands   latitude rings that pulse in turn (listing, searching)
 *   scatter drifting, twinkling particles (editing, writing, working)
 *   ring    a spinning ring of dots (thinking)
 *   pixels  a glowing 3×3 grid that morphs between patterns (thinking); coloured by CSS color, or tone="think|read|search|edit|run|wait"
 * The phase comes from the clock, not from the element, so an orb that a re-render
 * replaces continues where the old one left off. One shared frame loop draws every
 * connected orb at 30 fps, skips hidden ones, and stops when none are on screen.
 */
(function () {
	'use strict';
	if (!window.customElements || customElements.get('zc-orb')) return;
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const live = new Set();
	const TAU = Math.PI * 2;
	let raf = 0;
	let last = 0;

	// A deterministic pseudo-random sequence: every orb of a kind shares one particle set.
	function rand(seed) {
		let s = seed >>> 0;
		return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
	}
	// Pixel-grid frames (bit k = cell k, row by row) and the two colours each tone blends between.
	const PATTERNS = [0b111001001, 0b011011000, 0b000111111, 0b101010101, 0b010111010, 0b110110000, 0b100100111, 0b010000000, 0b111101111, 0b001011110];
	const TONES = {
		think: [[255, 205, 160], [255, 110, 140]],
		read: [[255, 214, 170], [255, 150, 110]],
		search: [[205, 180, 255], [140, 120, 255]],
		edit: [[170, 220, 255], [90, 160, 255]],
		run: [[170, 245, 200], [70, 200, 150]],
		wait: [[255, 230, 150], [250, 190, 80]]
	};
	const cache = new Map();
	function particles(kind) {
		if (cache.has(kind)) return cache.get(kind);
		const r = rand(kind.length * 7919 + 17);
		let list = [];
		if (kind === 'spark') {
			for (let i = 0; i < 90; i++) list.push({ a: r() * TAU, z: r() * 2 - 1, speed: 0.35 + r() * 0.65, phase: r(), size: 0.5 + r() * 1.3 });
		} else if (kind === 'sphere' || kind === 'bands') {
			const n = kind === 'sphere' ? 96 : 0;
			// Fibonacci sphere: evenly spread dots.
			for (let i = 0; i < n; i++) {
				const y = 1 - (i / (n - 1)) * 2;
				const rad = Math.sqrt(1 - y * y);
				const th = i * 2.399963;
				list.push({ x: Math.cos(th) * rad, y, z: Math.sin(th) * rad });
			}
			if (kind === 'bands') {
				for (let b = 0; b < 7; b++) {
					const lat = -0.82 + (b / 6) * 1.64;
					const rad = Math.sqrt(1 - lat * lat);
					const count = Math.max(6, Math.round(rad * 18));
					for (let k = 0; k < count; k++) list.push({ band: b, th: (k / count) * TAU, y: lat, rad });
				}
			}
		} else if (kind === 'scatter') {
			for (let i = 0; i < 26; i++) list.push({ x: r() * 2 - 1, y: r() * 2 - 1, z: r() * 2 - 1, fx: 0.3 + r() * 0.9, fy: 0.3 + r() * 0.9, p: r() * TAU, tw: 1 + r() * 3 });
		} else {
			for (let i = 0; i < 28; i++) list.push({ th: (i / 28) * TAU, j: r() });
		}
		cache.set(kind, list);
		return list;
	}

	/** The orb's ink: its CSS color, and whether glow should add light (dark themes) or plain paint. */
	// Computed colours can come back as color(srgb …) (from color-mix); a 1×1 canvas resolves any form to RGB.
	const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
	function ink(el) {
		probe.clearRect(0, 0, 1, 1);
		probe.fillStyle = '#e6ecff';
		probe.fillStyle = getComputedStyle(el).color;
		probe.fillRect(0, 0, 1, 1);
		const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
		return { rgb: r + ',' + g + ',' + b, light: (r * 299 + g * 587 + b * 114) / 1000 > 140 };
	}

	function draw(el, t) {
		const canvas = el._canvas;
		const w = el.clientWidth || 16, h = el.clientHeight || w;
		const dpr = Math.min(2, window.devicePixelRatio || 1);
		const W = Math.round(w * dpr), H = Math.round(h * dpr);
		if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; el._ink = null; }
		const ctx = canvas.getContext('2d');
		if (!el._ink) el._ink = ink(el);
		const { rgb, light } = el._ink;
		const col = (a) => 'rgba(' + rgb + ',' + Math.max(0, Math.min(1, a)).toFixed(3) + ')';
		const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 * 0.9;
		ctx.clearRect(0, 0, W, H);
		ctx.globalCompositeOperation = light ? 'lighter' : 'source-over';
		const kind = el.getAttribute('kind') || 'sphere';
		const dot = (x, y, s, a) => { ctx.fillStyle = col(a); ctx.beginPath(); ctx.arc(x, y, Math.max(0.35 * dpr, s), 0, TAU); ctx.fill(); };

		if (kind === 'pixels') {
			// A 3×3 grid of glowing cells morphing between patterns, tinted by the tone attribute.
			// Without a tone, the theme's colour (CSS color, the accent) from a light tint to full strength.
			const ink3 = rgb.split(',').map(Number);
			const [a, b] = TONES[el.getAttribute('tone')] || [ink3.map((n) => Math.round(n + (255 - n) * 0.45)), ink3];
			const step = t * 2.4, i = Math.floor(step), f = step - i;
			const ease = f * f * (3 - 2 * f);
			const from = PATTERNS[i % PATTERNS.length], to = PATTERNS[(i + 1) % PATTERNS.length];
			const pad = W * 0.18, gap = W * 0.05, cell = (W - pad * 2 - gap * 2) / 3;
			ctx.globalCompositeOperation = 'source-over';
			for (let k = 0; k < 9; k++) {
				const v = ((from >> k) & 1) * (1 - ease) + ((to >> k) & 1) * ease;
				if (v < 0.02) continue;
				const x = pad + (k % 3) * (cell + gap), y = pad + Math.floor(k / 3) * (cell + gap);
				const mix = ((k % 3) + Math.floor(k / 3)) / 4;
				const c = a.map((n, j) => Math.round(n + (b[j] - n) * mix)).join(',');
				ctx.shadowColor = 'rgba(' + c + ',' + (0.9 * v).toFixed(3) + ')';
				ctx.shadowBlur = cell * 1.2;
				ctx.fillStyle = 'rgba(' + c + ',' + (0.2 + 0.8 * v).toFixed(3) + ')';
				ctx.fillRect(x, y, cell, cell);
			}
			ctx.shadowBlur = 0;
		} else if (kind === 'spark') {
			// Core glow, a soft halo and streaks flying out from the centre.
			const pulse = 0.85 + Math.sin(t * 2.4) * 0.15;
			const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
			halo.addColorStop(0, col(0.95 * pulse));
			halo.addColorStop(0.18, col(0.55 * pulse));
			halo.addColorStop(0.5, col(0.12));
			halo.addColorStop(1, col(0));
			ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, TAU); ctx.fill();
			ctx.lineCap = 'round';
			for (const p of particles('spark')) {
				const life = (t * p.speed * 0.55 + p.phase) % 1;
				const depth = Math.sqrt(1 - p.z * p.z);
				const d = (0.12 + life * 0.88) * R * depth;
				const x = cx + Math.cos(p.a + t * 0.15) * d, y = cy + Math.sin(p.a + t * 0.15) * d;
				const tail = Math.min(d, R * 0.22 * life);
				const a = Math.sin(life * Math.PI) * (0.55 + 0.45 * depth);
				ctx.strokeStyle = col(a * 0.8);
				ctx.lineWidth = p.size * dpr * 0.6;
				ctx.beginPath();
				ctx.moveTo(x - Math.cos(p.a + t * 0.15) * tail, y - Math.sin(p.a + t * 0.15) * tail);
				ctx.lineTo(x, y);
				ctx.stroke();
			}
			// The shell: a faint rim of dots that marks the sphere's edge.
			for (let i = 0; i < 36; i++) {
				const th = (i / 36) * TAU + t * 0.25;
				dot(cx + Math.cos(th) * R * 0.97, cy + Math.sin(th) * R * 0.97, 0.45 * dpr, 0.25 + 0.2 * Math.sin(th * 3 + t * 3));
			}
		} else if (kind === 'sphere') {
			const rot = t * 0.9, tilt = 0.42, ct = Math.cos(tilt), st = Math.sin(tilt);
			const cr = Math.cos(rot), sr = Math.sin(rot);
			for (const p of particles('sphere')) {
				const x = p.x * cr + p.z * sr, z0 = -p.x * sr + p.z * cr;
				const y = p.y * ct - z0 * st, z = p.y * st + z0 * ct;
				const near = (z + 1) / 2;
				dot(cx + x * R, cy + y * R, (0.45 + near * 0.75) * dpr, 0.12 + near * 0.85);
			}
		} else if (kind === 'bands') {
			const rot = t * 0.7;
			for (const p of particles('bands')) {
				const th = p.th + rot * (p.band % 2 ? 1 : -1) * 0.6;
				const x = Math.cos(th) * p.rad, z = Math.sin(th) * p.rad;
				const near = (z + 1) / 2;
				const wave = 0.35 + 0.65 * Math.max(0, Math.sin(t * 3.2 - p.band * 0.9));
				dot(cx + x * R, cy + p.y * R * 0.95, (0.4 + near * 0.6) * dpr, (0.1 + near * 0.6) * wave + 0.06);
			}
		} else if (kind === 'scatter') {
			for (const p of particles('scatter')) {
				const x = Math.sin(t * p.fx + p.p) * 0.55 + p.x * 0.45;
				const y = Math.cos(t * p.fy + p.p * 1.3) * 0.55 + p.y * 0.45;
				const z = Math.sin(t * 0.8 + p.p) * 0.5 + p.z * 0.5;
				const near = (z + 1) / 2;
				const tw = 0.5 + 0.5 * Math.sin(t * p.tw + p.p);
				dot(cx + x * R * 0.92, cy + y * R * 0.92, (0.5 + near * 0.9) * dpr, (0.2 + near * 0.7) * (0.35 + 0.65 * tw));
			}
		} else {
			// ring: two crossing rings of dots (a gyroscope) turning, each brightest at its leading edge.
			const spin = t * 2.6;
			for (let k = 0; k < 2; k++) {
				const tilt = (k ? -1 : 1) * (0.55 + Math.sin(t * 0.7) * 0.15), ct = Math.cos(tilt), st = Math.sin(tilt);
				const turn = t * 0.5 + k * Math.PI / 2, cr = Math.cos(turn), sr = Math.sin(turn);
				for (const p of particles('ring')) {
					const th = p.th + spin * (k ? -1 : 1);
					// A circle in the x-z plane, tilted about x, then turned about y.
					const x0 = Math.cos(th), z0 = Math.sin(th);
					const y1 = -z0 * st, z1 = z0 * ct;
					const x = x0 * cr + z1 * sr, z = -x0 * sr + z1 * cr;
					const head = ((p.th / TAU) + 1) % 1;
					const near = (z + 1) / 2;
					dot(cx + x * R * 0.9, cy + y1 * R * 0.9, (0.45 + near * 0.75) * dpr, (0.12 + head * 0.88) * (0.35 + near * 0.65));
				}
			}
		}
	}

	function frame(now) {
		raf = 0;
		if (!live.size || document.hidden) return;
		if (now - last >= 1000 / 30 - 1) {
			last = now;
			for (const el of live) if (el.offsetParent !== null || el.getClientRects().length) draw(el, now / 1000);
		}
		if (!motion.matches) raf = requestAnimationFrame(frame);
	}
	function kick() { if (!raf && live.size && !document.hidden) raf = requestAnimationFrame(frame); }

	class Orb extends HTMLElement {
		static get observedAttributes() { return ['kind', 'tone']; }
		connectedCallback() {
			if (!this._canvas) {
				this._canvas = document.createElement('canvas');
				this.setAttribute('aria-hidden', 'true');
				this.appendChild(this._canvas);
			}
			live.add(this);
			// A still frame right away (and the only one when motion is reduced).
			draw(this, performance.now() / 1000);
			kick();
		}
		disconnectedCallback() { live.delete(this); }
		attributeChangedCallback() { if (this._canvas) draw(this, performance.now() / 1000); }
	}
	customElements.define('zc-orb', Orb);
	document.addEventListener('visibilitychange', kick);
	motion.addEventListener?.('change', kick);
	// Themes change the ink colour: re-read it on the next frame.
	new MutationObserver(() => { for (const el of live) el._ink = null; }).observe(document.body || document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

	/** Markup for an orb (renderers build HTML strings). */
	window.ZcOrb = { html: (kind, cls) => '<zc-orb kind="' + kind + '"' + (cls ? ' class="' + cls + '"' : '') + '></zc-orb>' };
})();
