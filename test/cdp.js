// A minimal DevTools-protocol client for the app tests: evaluate in a page and capture it.
'use strict';

async function targets(port) {
	const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
	return res.json();
}

/** Connect to the first page whose URL matches. */
async function connect(port, match, timeoutMs = 30000) {
	const until = Date.now() + timeoutMs;
	let target;
	while (!target) {
		try {
			target = (await targets(port)).find((t) => t.type === 'page' && match(t.url));
		} catch {
			// The app is still starting.
		}
		if (!target) {
			if (Date.now() > until) throw new Error('no page matched');
			await new Promise((r) => setTimeout(r, 300));
		}
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { ws.close(); reject(new Error('DevTools connection timed out')); }, 5000);
		ws.onopen = () => { clearTimeout(timer); resolve(); };
		ws.onerror = () => { clearTimeout(timer); reject(new Error('DevTools connection failed')); };
	});
	let id = 0;
	const waiting = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id && waiting.has(m.id)) {
			const { resolve, reject, timer } = waiting.get(m.id);
			clearTimeout(timer);
			waiting.delete(m.id);
			if (m.error) reject(new Error(m.error.message));
			else resolve(m.result);
		}
	};
	// A page that closes (or a call that closes its own page) fails its calls instead of hanging the test.
	ws.onclose = () => {
		for (const { reject, timer } of waiting.values()) {
			clearTimeout(timer);
			reject(new Error('page closed'));
		}
		waiting.clear();
	};
	const send = (method, params = {}, timeoutMs = 30000) =>
		new Promise((resolve, reject) => {
			if (ws.readyState !== WebSocket.OPEN) { reject(new Error('page closed')); return; }
			const n = ++id;
			const timer = setTimeout(() => {
				waiting.delete(n);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			waiting.set(n, { resolve, reject, timer });
			try {
				ws.send(JSON.stringify({ id: n, method, params }));
			} catch (e) {
				clearTimeout(timer);
				waiting.delete(n);
				reject(e);
			}
		});
	return {
		url: target.url,
		send,
		async eval(expression, timeoutMs) {
			const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
			return r.result.value;
		},
		async screenshot(file) {
			// Capturing transparent native views is unreliable on some Windows compositors.
			// Behavioral assertions still run when capture is disabled.
			if (process.env.ZER0NE_SMOKE_SCREENSHOTS === '0') return;
			await send('Page.bringToFront');
			const r = await send('Page.captureScreenshot', { format: 'png', fromSurface: process.env.ZER0NE_SMOKE_SURFACE === '1' });
			require('fs').writeFileSync(file, Buffer.from(r.data, 'base64'));
		},
		close: () => ws.close()
	};
}

module.exports = { connect, targets };

if (require.main === module) {
	const [port, match, expr, shot] = process.argv.slice(2);
	connect(Number(port), (u) => u.includes(match))
		.then(async (c) => {
			if (expr) console.log(JSON.stringify(await c.eval(expr), null, 1));
			if (shot) await c.screenshot(shot);
			c.close();
		})
		.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
}
