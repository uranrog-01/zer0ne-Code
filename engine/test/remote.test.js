const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { RemoteServer } = require(require('path').join(__dirname, '..', 'out') + '/remote.js');
// Desktop tokens must authenticate the very first SSE connection even when a
// different localhost engine has overwritten the shared cookie. Phones keep it.
const bridgeSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'media', 'bridge.js'), 'utf8');
for (const desktop of [true, false]) {
	const streams = [];
	const timers = [];
	const context = {
		window: { __REMOTE__: { token: 'own token', desktop } },
		document: { body: { classList: { add() {}, remove() {} } } },
		EventSource: class { constructor(url) { this.url = url; streams.push(this); } close() {} },
		setTimeout: fn => timers.push(fn)
	};
	require('vm').runInNewContext(bridgeSource, context);
	assert.strictEqual(streams[0].url, desktop ? '/api/events?t=own%20token&v=1' : '/api/events?v=1');
	streams[0].onerror(); timers.shift()();
	streams[1].onerror(); timers.shift()();
	assert.strictEqual(streams[2].url, '/api/events?t=own%20token&v=1', 'desktop keeps its token; phone falls back after cookie failure');
}
const received = [];
const decisions = [];
const devices = [];
let linkToken = 'tok123';
const server = new RemoteServer(require('path').join(__dirname, '..', 'media'), {
	token: () => linkToken,
	publicBases: () => ['http://127.0.0.1:7699'],
	mcpApp: (key) => (key === 'app1' ? '<!doctype html><p>mcp app</p>' : undefined),
	preview: (id) => (id === 'art1' ? '<!doctype html><h1>artifact preview</h1>' : undefined),
	decide: async (id, approve) => {
		decisions.push([id, approve]);
		return decisions.filter(([d]) => d === id).length === 1;
	},
	devices: { list: () => devices, save: (list) => { devices.splice(0, devices.length, ...list); } },
	attach: (post) => {
		return { dispose() {}, handle: async (msg) => { received.push(msg); if (msg.type === 'ready') post({ type: 'state', hello: 'phone' }); } };
	}
});
const get = (path, headers = {}) => new Promise((res) => http.get('http://127.0.0.1:7699' + path, { headers }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b, type: r.headers['content-type'], headers: r.headers })); }));
const cookieOf = (response) => String(response.headers['set-cookie']).split(';')[0];

// A pending command receipt is a transport warning, not desktop UI: the desktop page stays quiet,
// while a phone still sees the status. This keeps a normal desktop send free of "1 command awaiting…".
async function bridgeBanner(desktop) {
	const nodes = [];
	const makeNode = (tag) => ({
		tag,
		id: '',
		className: '',
		textContent: '',
		children: [],
		onclick: null,
		setAttribute() {},
		appendChild(child) {
			this.children.push(child);
			nodes.push(child);
		},
		replaceChildren() {
			this.children.length = 0;
		},
		remove() {
			const at = nodes.indexOf(this);
			if (at >= 0) nodes.splice(at, 1);
		}
	});
	const streams = [];
	const context = {
		window: { __REMOTE__: { token: 'own token', desktop } },
		document: {
			body: { classList: { add() {}, remove() {} }, appendChild(node) { nodes.push(node); } },
			createElement: makeNode,
			getElementById: (id) => nodes.find((node) => node.id === id) || null,
			hidden: false,
			hasFocus: () => true,
			addEventListener() {}
		},
		sessionStorage: {
			getItem: () => JSON.stringify([{ id: 'receipt-1', type: 'send' }]),
			setItem() {}
		},
		EventSource: class {
			constructor(url) {
				this.url = url;
				streams.push(this);
			}
			close() {}
		},
		fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'running' }) }),
		setTimeout: () => 0,
		clearTimeout() {},
		console
	};
	require('vm').runInNewContext(bridgeSource, context);
	streams[0].onmessage({ data: JSON.stringify({ type: 'transportHello', protocol: 1, capabilities: { receipts: true } }) });
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
	return nodes.filter((node) => node.id === 'command-state').length;
}

async function desktopBudget() {
	const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
	const desktop = new RemoteServer(require('path').join(__dirname, '..', 'media'), {
		token: () => 'desktop-budget-fixture',
		attach: () => ({ dispose() {}, handle: async () => {} })
	}, { desktop: true });
	try {
		await desktop.start(0);
		const port = desktop.info().port;
		const post = () => new Promise((resolve, reject) => {
			const request = http.request({ agent, hostname: '127.0.0.1', port, path: '/api/msg', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': 'desktop-budget-fixture', 'X-Zer0ne-Protocol': '1' } }, response => {
				response.resume(); response.on('end', () => resolve(response.statusCode));
			});
			request.on('error', reject); request.end(JSON.stringify({ type: 'getProjects' }));
		});
		const normal = [];
		for (let i = 0; i < 80; i++) normal.push(await post());
		assert.ok(normal.every(status => status === 204), 'desktop saves, receipts, polling and clicks fit within one normal activity burst');
		const flood = await Promise.all(Array.from({ length: 400 }, post));
		assert.ok(flood.includes(429), 'desktop traffic still has a bounded flood budget');
		console.log('desktop message budget: normal activity accepted, flooding limited');
	} finally { agent.destroy(); await desktop.stop(); }
}

(async () => {
	try {
		await desktopBudget();
		assert.strictEqual(await bridgeBanner(true), 0, 'a desktop pending receipt does not paint a banner');
		assert.strictEqual(await bridgeBanner(false), 1, 'a phone still sees its pending command');
		console.log('command banner: desktop quiet, phone visible');
		await server.start(7699);
		const info = server.info();
		assert.ok(info.running && info.urls.length && info.qr.startsWith('<svg'), 'info has urls + qr');
		assert.ok(Array.isArray(info.devices), 'info lists paired phones');
		console.log('urls:', info.urls.map((u) => u.replace(/t=.*/, 't=•••')).join(', '));
		assert.strictEqual((await get('/')).status, 401, 'no token → 401');
		assert.strictEqual((await get('/', { Cookie: 'zr=%' })).status, 401, 'malformed cookie receives a normal unauthorized response');
		assert.strictEqual((await get('/?t=tok123', { Cookie: 'zr=%' })).status, 200, 'malformed cookie does not override a valid explicit token');
		assert.strictEqual((await get('/?t=wrong')).status, 401, 'bad token → 401');
		const page = await get('/?t=tok123', { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
		assert.strictEqual(page.status, 200);
		assert.ok(page.body.includes('window.__REMOTE__') && page.body.includes('id="messages"') && page.body.includes('/media/chat.js'));
		const cookie = cookieOf(page);
		assert.match(String(page.headers['set-cookie']), /^zr=[^;]+; HttpOnly; SameSite=Strict/, 'the session moves into an HttpOnly cookie');
		assert.ok(!cookie.includes('tok123'), 'the phone never keeps the link token, only its own session');
		assert.match(page.body, /history\.replaceState\(null, '', '\/'\)/, 'token stripped from the address bar');
		const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(page.headers['content-security-policy'])[1];
		assert.ok(page.body.includes('<script nonce="' + nonce + '">'), 'inline bootstrap allowed only by nonce');
		const first = server.info().devices;
		assert.ok(first.length >= 1, 'the link visit pairs a phone');
		assert.ok(first.some((d) => /iPhone · Safari/.test(d.name)), 'paired phones are named by device and browser');
		assert.strictEqual((await get('/api/events-nope', { Cookie: cookie })).status, 404, 'the device session authenticates');
		const js = await get('/media/chat.js');
		assert.strictEqual(js.status, 200); assert.match(js.type, /javascript/);
		for (const p of ['/media/../../package.json', '/media/..%2F..%2Fpackage.json', '/media/%2e%2e/out/extension.js']) { const s = (await get(p)).status; assert.ok(s === 401 || s === 404, p + ' -> ' + s); }
		// SSE: connecting triggers ready → state streamed to the phone
		const sse = await new Promise((resolve) => {
			const req = http.get('http://127.0.0.1:7699/api/events?t=tok123', (r) => {
				let b = '';
				r.on('data', (c) => { b += c; if (b.includes('"hello"')) { req.destroy(); resolve(b); } });
			});
		});
		assert.match(sse, /data: \{"type":"state","hello":"phone"\}/);
		// Long chats over mobile data: the event stream is gzip when the phone asks.
		const gz = await new Promise((resolve) => {
			const req = http.get('http://127.0.0.1:7699/api/events?t=tok123', { headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
				const gun = zlib.createGunzip(); let b = '';
				r.pipe(gun);
				gun.on('data', (c) => { b += c; if (b.includes('"hello"')) { req.destroy(); resolve({ body: b, headers: r.headers }); } });
			});
		});
		assert.strictEqual(gz.headers['content-encoding'], 'gzip', 'the phone stream is compressed');
		assert.match(gz.body, /"hello":"phone"/, 'gzip keeps the SSE payload intact');
		// POST from phone reaches the controller; desktop-only messages are dropped
		const postMsg = (m) => new Promise((res) => { const r = http.request('http://127.0.0.1:7699/api/msg?t=tok123', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Protocol': '1' } }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.end(JSON.stringify(m)); });
		assert.strictEqual(await postMsg({ type: 'send', text: 'from phone' }), 204);
		assert.strictEqual(await postMsg({ type: 'addImage', name: 'photo.png', mime: 'image/png', base64: 'aGk=' }), 204);
		assert.strictEqual(await postMsg({ type: 'addText', name: 'notes.txt', content: 'hi' }), 204);
		assert.strictEqual(await postMsg({ type: 'pickAttachment' }), 204);
		await new Promise((r) => setTimeout(r, 50));
		assert.ok(received.some((m) => m.type === 'send' && m.text === 'from phone'));
		assert.ok(received.some((m) => m.type === 'addImage' && m.name === 'photo.png'), 'phone photos reach the composer');
		assert.ok(received.some((m) => m.type === 'addText' && m.content === 'hi'), 'phone text files reach the composer');
		assert.ok(!received.some((m) => m.type === 'pickAttachment'), 'desktop-only message ignored');
		// Header auth (what the page uses) and flood protection on /api/msg.
		const postH = (m) => new Promise((res) => { const r = http.request('http://127.0.0.1:7699/api/msg', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': 'tok123', 'X-Zer0ne-Protocol': '1' } }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.end(JSON.stringify(m)); });
		assert.strictEqual(await postH({ type: 'noop' }), 204);
		const codes = await Promise.all(Array.from({ length: 60 }, () => postH({ type: 'noop' })));
		assert.ok(codes.includes(429) && codes.includes(204), 'bursts pass, floods get 429');
		// v0.13: installable web app + 6-digit pairing for home-screen apps (their own cookie jar).
		const man = await get('/manifest.webmanifest');
		assert.strictEqual(man.status, 200, 'manifest is public');
		assert.strictEqual(JSON.parse(man.body).display, 'standalone');
		assert.ok(!man.body.includes('tok123'), 'manifest never carries the token');
		assert.ok(page.body.includes('rel="manifest"'), 'chat page links the manifest');
		const pairPage = await get('/pair');
		assert.strictEqual(pairPage.status, 200);
		assert.ok(pairPage.body.includes('Connect this phone') && !pairPage.body.includes('tok123'), 'pair page, no token');
		const noAuth = await get('/');
		assert.strictEqual(noAuth.status, 401);
		assert.ok(noAuth.body.includes('6-digit code'), 'unauthenticated visits get the pairing form');
		const postPair = (code) => new Promise((res) => { const r = http.request('http://127.0.0.1:7699/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36' } }, (x) => { x.resume(); x.on('end', () => res({ status: x.statusCode, headers: x.headers })); }); r.end(JSON.stringify({ code })); });
		assert.strictEqual((await postPair('123456')).status, 403, 'no code issued yet');
		const code = server.newPairCode();
		assert.match(code, /^\d{6}$/);
		assert.strictEqual(server.info().pairCode, code);
		const beforePair = server.info().devices.length;
		const paired = await postPair(code);
		assert.strictEqual(paired.status, 200, 'right code pairs');
		const pairCookie = cookieOf(paired);
		assert.match(String(paired.headers['set-cookie']), /^zr=[^;]+; HttpOnly/, 'pairing sets the device cookie');
		assert.ok(!pairCookie.includes('tok123'), 'pairing mints a device session, not the link token');
		assert.strictEqual((await get('/api/events-nope', { Cookie: pairCookie })).status, 404, 'the paired phone authenticates');
		const openSubmission = async (headers = { Cookie:pairCookie }) => {
			let request;
			const result = new Promise((resolve, reject) => {
				request = http.request('http://127.0.0.1:7699/api/msg', { method:'POST', headers:{ ...headers, 'Content-Type':'application/json', 'X-Zer0ne-Protocol':'1', 'CF-Connecting-IP':'198.51.100.75' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
				request.on('error', reject);
			});
			request.write('{"type":"send",');
			const until = Date.now() + 2000;
			while (!server.pendingMessages.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
			assert.equal(server.pendingMessages.size, 1);
			return { request, result };
		};
		const pending = await openSubmission();
		const pairedDevices = server.info().devices;
		assert.strictEqual(pairedDevices.length, beforePair + 1, 'the code adds exactly one phone');
		assert.ok(pairedDevices.some((d) => /Android · Chrome/.test(d.name)), 'the paired phone is named from its browser');
		assert.strictEqual((await postPair(code)).status, 403, 'a code works once');
		assert.strictEqual(server.info().pairCode, undefined);
		// Signing one phone out keeps the other one working.
		const android = pairedDevices.find((d) => /Android/.test(d.name));
		assert.strictEqual(server.revokeDevice(android.id), true);
		assert.equal(await pending.result, 401, 'revocation cancels a submission before its body finishes');
		pending.request.end('"text":"revoked submission"}');
		await new Promise(resolve => setTimeout(resolve, 10));
		assert.ok(!received.some(message => message.text === 'revoked submission'));
		assert.equal(server.pendingMessages.size, 0);
		const oldLink = await openSubmission({ 'X-Zer0ne-Token':linkToken });
		linkToken = 'replacement-test-token';
		oldLink.request.end('"text":"rotated link submission"}');
		assert.equal(await oldLink.result, 401, 'access is rechecked after reading the body even without explicit cancellation');
		assert.ok(!received.some(message => message.text === 'rotated link submission'));
		linkToken = 'tok123';
		assert.strictEqual((await get('/api/events-nope', { Cookie: pairCookie })).status, 401, 'the revoked phone is signed out');
		assert.strictEqual((await get('/api/events-nope', { Cookie: cookie })).status, 404, 'the other phone is untouched');
		assert.strictEqual(server.revokeDevice('nope'), false);
		// A signed-out phone cannot silently pair again from its history entry.
		const afterRevoke = server.info().devices.length;
		assert.strictEqual((await get('/?t=tok123', { Cookie: pairCookie })).status, 401, 'the revoked phone gets the pairing page');
		assert.strictEqual(server.info().devices.length, afterRevoke, 'and no new device is minted for it');
		// Notification actions: a signed, short-lived Approve/Reject link.
		const approveUrl = server.actionUrl('ap1', true);
		assert.ok(approveUrl && approveUrl.startsWith('http://127.0.0.1:7699/api/action?'), 'approval links point at this server');
		const approved = await get(approveUrl.slice('http://127.0.0.1:7699'.length));
		assert.strictEqual(approved.status, 200);
		assert.match(approved.body, /Approved/, 'the action page confirms the decision');
		assert.deepStrictEqual(decisions.at(-1), ['ap1', true], 'the decision reached the controller');
		const again = await get(approveUrl.slice('http://127.0.0.1:7699'.length));
		assert.match(again.body, /Already answered/, 'a second tap says so instead of changing the answer');
		const tampered = await get(approveUrl.slice('http://127.0.0.1:7699'.length).replace(/sig=..../, 'sig=AAAA'));
		assert.strictEqual(tampered.status, 401, 'a tampered link is refused');
		assert.ok(!server.actionUrl('ap1', true).includes('tok123'), 'action links never carry the token');
		// Inline MCP apps render on the phone too (same sandbox), keyed by an unguessable id.
		assert.strictEqual((await get('/api/mcp-apps/app1', { Cookie: cookie })).status, 200, 'the paired phone can open an app');
		assert.strictEqual((await get('/api/mcp-apps/app1')).status, 401, 'the document also needs the session: the id is a second barrier');
		assert.strictEqual((await get('/api/mcp-apps/gone', { Cookie: cookie })).status, 404, 'expired apps are gone');
		// Published artifacts: the same sandbox the desktop panel gets, by capability id plus the session.
		const art = await get('/api/artifacts/art1', { Cookie: cookie });
		assert.strictEqual(art.status, 200, 'a published preview opens on the phone');
		assert.match(String(art.headers['content-security-policy']), /sandbox allow-scripts/, 'artifact documents stay sandboxed');
		assert.match(art.body, /artifact preview/);
		assert.strictEqual((await get('/api/artifacts/art1')).status, 401, 'artifact documents need the session too');
		assert.strictEqual((await get('/api/artifacts/forged-id', { Cookie: cookie })).status, 404, 'unknown preview ids 404');
		// Behind the secure link (cloudflared on 127.0.0.1), lockouts follow the real client.
		for (let i = 0; i < 10; i++) await get('/?t=guess' + i, { 'CF-Connecting-IP': '203.0.113.9' });
		assert.strictEqual((await get('/?t=tok123', { 'CF-Connecting-IP': '203.0.113.9' })).status, 429, 'the guessing client is locked out');
		assert.strictEqual((await get('/?t=tok123', { 'CF-Connecting-IP': '198.51.100.4' })).status, 200, 'other phones behind the tunnel are not');
		const secure = await get('/?t=tok123', { 'CF-Connecting-IP': '198.51.100.4', 'X-Forwarded-Proto': 'https' });
		assert.match(String(secure.headers['set-cookie']), /; Secure/, 'Secure cookie over https');
		// Guessing the token locks the address out.
		for (let i = 0; i < 10; i++) await get('/?t=guess' + i);
		assert.strictEqual((await get('/?t=tok123')).status, 429, 'locked out even with the right token');
		console.log('\nREMOTE SERVER OK');
	} catch (e) {
		console.error('FAIL', e);
		process.exitCode = 1;
	} finally {
		await server.stop();
	}
})();
