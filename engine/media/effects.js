/* Background pictures and the locally bundled MetalForge Filament preview. */
(function () {
	'use strict';
	const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
	/** Settings → Appearance → Motion → Calm stops decorative loops, like the system setting. */
	const reducedMotion = () => motion.matches || document.body.dataset.motion === 'calm';
	function drawImage(ctx, canvas, img, filter) {
		const { width: w, height: h } = canvas;
		const scale = Math.max(w / img.width, h / img.height);
		ctx.clearRect(0, 0, w, h);
		ctx.filter = filter === 'blur' ? 'blur(21px) saturate(1.2)' : 'none';
		ctx.drawImage(img, (w - img.width * scale) / 2, (h - img.height * scale) / 2, img.width * scale, img.height * scale);
		ctx.filter = 'none';
	}
	function resize(canvas, maxDpr = 2) {
		const box = canvas.getBoundingClientRect(), dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
		const w = Math.max(1, Math.round(box.width * dpr)), h = Math.max(1, Math.round(box.height * dpr));
		if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
	}
	function Picture(canvas) {
		const ctx = canvas.getContext('2d');
		let img = null, pending = null, filter = 'none', raf = 0, last = 0, active = false, generation = 0;
		function stop() { cancelAnimationFrame(raf); raf = 0; }
		function frame(now) {
			raf = 0;
			if (!active || document.hidden || !img) return;
			if (now - last >= 50) { drawImage(ctx, canvas, img, filter); last = now; }
			raf = requestAnimationFrame(frame);
		}
		function refresh() {
			stop();
			if (!active || !img) return;
			resize(canvas); drawImage(ctx, canvas, img, filter);
			if (img.__animated && !reducedMotion() && !document.hidden) raf = requestAnimationFrame(frame);
		}
		return {
			set(src, f) {
				const version = ++generation;
				stop(); img?.remove(); pending?.remove(); img = pending = null;
				if (!src) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
				const el = pending = new Image();
				filter = f || 'none';
				el.__animated = /^data:image\/(gif|apng|webp)/i.test(src);
				el.onload = () => { if (version === generation) { img = el; pending = null; refresh(); } else el.remove(); };
				el.onerror = () => { el.remove(); if (version === generation) pending = null; };
				if (el.__animated) {
					el.className = 'fx-anim-src'; el.alt = '';
					Object.assign(el.style, { position: 'fixed', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
					document.body.appendChild(el);
				}
				el.src = src;
			},
			active(on) { if (active !== on) { active = on; refresh(); } },
			refresh,
			dispose() { ++generation; stop(); img?.remove(); pending?.remove(); }
		};
	}
	function Filament(canvas) {
		let device, context, sim, initializing, raf = 0, lastFrame = -Infinity, active = false, disposed = false, failed = false;
		let hoverAt = null, hoverEnd = 0;
		function stop() { cancelAnimationFrame(raf); raf = 0; }
		function fail(error) {
			if (failed || disposed) return;
			stop(); failed = true; canvas.dataset.renderer = 'unavailable';
			console.warn('Filament background:', error?.message || error);
			sim?.dispose(); sim = null; context?.unconfigure(); device?.destroy(); device = null;
		}
		function render(now) {
			resize(canvas, 1.25);
			sim.frame({}, now / 1000, canvas.width, canvas.height, context.getCurrentTexture().createView());
		}
		function frame(now) {
			raf = 0;
			if (!active || disposed || failed || document.hidden || !document.hasFocus()) return;
			// Leave GPU time for local inference; ambient motion does not need display-rate simulation.
			if (now - lastFrame >= 1000 / 30 - 1 || reducedMotion()) {
				try { render(now); lastFrame = now; } catch (error) { fail(error); return; }
			}
			if (!reducedMotion()) raf = requestAnimationFrame(frame);
		}
		async function init() {
			if (!navigator.gpu || !window.MetalForgeFilament) throw new Error('WebGPU is unavailable');
			const adapter = await navigator.gpu.requestAdapter();
			if (!adapter) throw new Error('No WebGPU adapter');
			const gpu = await adapter.requestDevice();
			if (disposed) { gpu.destroy(); return; }
			device = gpu;
			device.addEventListener('uncapturederror', event => fail(event.error));
			device.lost.then(info => { if (!disposed && !failed && info.reason !== 'destroyed') fail(new Error(info.message)); });
			context = canvas.getContext('webgpu');
			if (!context) throw new Error('WebGPU canvas is unavailable');
			const format = navigator.gpu.getPreferredCanvasFormat();
			context.configure({ device, format, alphaMode: 'premultiplied' });
			const source = window.MetalForgeFilament;
			const shader = device.createShaderModule({ code: source.shader });
			const compilation = await shader.getCompilationInfo();
			if (compilation.messages.some(m => m.type === 'error')) throw new Error('Filament shader compilation failed');
			if (disposed) return;
			const binary = { ...source.base, particleCount: 1200, pointSize: 10, particleSpeed: 0.14, particleBrightness: 0.42, trailFade: 0.42, bloomIntensity: 0.08, bloomIterations: 4, pressureIterations: 12, p0: 0.8, timeScale: 0.55 };
			sim = new source.SimEngine(device, format, source.shader, { base: binary, displayEntry: 'display_filament_fragment', apply() {} });
			canvas.dataset.renderer = 'binary-filament';
			// A reduced-motion scene needs populated trails before its single still.
			if (reducedMotion() && active && !document.hidden) for (let i = 0; i < 60; i++) render(i * 1000 / 60);
		}
		function refresh() {
			stop();
			if (!active || disposed || failed || document.hidden || !document.hasFocus()) return;
			if (sim) { raf = requestAnimationFrame(frame); return; }
			if (!initializing) initializing = init().then(refresh).catch(fail);
		}
		return {
			active(on) { if (active !== on) { active = on; refresh(); } },
			refresh,
			pointer(event) {
				if (!active || !sim || reducedMotion()) return;
				const box = canvas.getBoundingClientRect();
				const x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
				// Mild parallax: the whole field leans a few pixels toward the cursor.
				canvas.style.transform = 'translate3d(' + ((x - 0.5) * 10).toFixed(1) + 'px,' + ((y - 0.5) * 8).toFixed(1) + 'px,0)';
				if (event.buttons) { hoverAt = null; sim.pointer(x, y); return; }
				// Hover is a light touch: the stroke follows only part of the way to the cursor,
				// so the digits drift with the mouse rather than being stirred by it.
				hoverAt = hoverAt ? [hoverAt[0] + (x - hoverAt[0]) * 0.3, hoverAt[1] + (y - hoverAt[1]) * 0.3] : [x, y];
				sim.pointer(hoverAt[0], hoverAt[1]);
				clearTimeout(hoverEnd);
				hoverEnd = setTimeout(() => { hoverAt = null; sim?.endStroke(); }, 140);
			},
			endStroke() { sim?.endStroke(); },
			dispose() { disposed = true; stop(); sim?.dispose(); context?.unconfigure(); device?.destroy(); }
		};
	}
	let picture, filament, pictureCanvas, filamentCanvas, current = '', options, glassState = '';
	function apply(o) {
		const solidity = document.body.classList.contains('zg-see') ? Number(document.body.style.getPropertyValue('--zg-o') || 1) : 1;
		const showFilament = !!o.filament && !!window.MetalForgeFilament && o.active !== false && solidity > 0;
		const showPicture = !!o.image && !o.filament && o.active !== false;
		pictureCanvas.hidden = !showPicture; filamentCanvas.hidden = !showFilament;
		pictureCanvas.style.opacity = String(Math.max(0, Math.min(1, (o.opacity ?? 60) / 100)));
		// Picture backgrounds own the frame treatments; the ambient binary layer doesn't.
		document.body.classList.toggle('fx-on', showPicture);
		document.body.classList.toggle('filament-on', showFilament);
		const key = o.image ? o.image + '|' + o.filter : '';
		if (key !== current) { current = key; picture.set(o.image, o.filter); }
		picture.active(showPicture); filament.active(showFilament);
	}
	window.Effects = {
		FILTERS: ['none', 'blur'],
		mount(canvas) {
			pictureCanvas = canvas; pictureCanvas.hidden = true;
			filamentCanvas = document.createElement('canvas');
			filamentCanvas.id = 'filament-canvas'; filamentCanvas.className = 'fx-canvas fx-filament';
			filamentCanvas.setAttribute('aria-hidden', 'true'); filamentCanvas.hidden = true;
			canvas.after(filamentCanvas);
			picture = Picture(canvas); filament = Filament(filamentCanvas);
			const refresh = () => { picture.refresh(); filament.refresh(); };
			window.addEventListener('resize', refresh);
			window.addEventListener('focus', refresh);
			window.addEventListener('blur', refresh);
			document.addEventListener('visibilitychange', refresh);
			motion.addEventListener('change', refresh);
			window.addEventListener('zc-motion-change', refresh);
			const observer = new ResizeObserver(refresh); observer.observe(canvas.parentElement);
			const glassObserver = new MutationObserver(() => {
				const state = [document.body.classList.contains('zg-see'), document.body.style.getPropertyValue('--zg-o')].join('|');
				if (state === glassState) return;
				glassState = state;
				if (options) apply(options);
			});
			glassObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
			canvas.parentElement.addEventListener('pointermove', event => {
				if (!event.target.closest('button, input, textarea, select, a, [role="button"], aside')) filament.pointer(event);
			});
			window.addEventListener('pointerup', filament.endStroke);
			window.addEventListener('blur', filament.endStroke);
			window.addEventListener('pagehide', () => { observer.disconnect(); glassObserver.disconnect(); picture.dispose(); filament.dispose(); });
		},
		set(o) {
			if (!picture) return;
			options = o;
			apply(o);
		}
	};
})();
