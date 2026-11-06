/*
 * Transport bridge shared by chat.js and settings.js.
 *
 *  - Inside VS Code: acquireVsCodeApi() (callable once per page).
 *  - Mobile Remote (phone browser): POST /api/msg + Server-Sent Events
 *    from /api/events, both authenticated by the pairing token.
 *
 * Host messages are re-dispatched as window "message" events in both
 * cases, so the UI code is identical everywhere.
 */
(function () {
	'use strict';
	const remote = window.__REMOTE__;
	let api;
	if (!remote && typeof acquireVsCodeApi === 'function') {
		const vs = acquireVsCodeApi();
		api = {
			remote: false,
			post: (m) => vs.postMessage(m),
			getState: () => vs.getState() || {},
			setState: (s) => vs.setState(s)
		};
	} else if (remote) {
		const protocol = 1;
		const receipted = new Set(['send','retry','approve','reject','answer','stop','stopAgent','sendAgentMessage','resumeAgent','writerReview','undoTurn','restoreTo','rewindTo','projectActionRun','projectActionStop','ptyOpen','ptyClose']);
		let negotiated = false, compatible = true, synced = false, replaying = false, cursor = '', epoch = '', polling = false, receiptsEnabled = false, session = '';
		const pendingKey = 'zer0ne.pending.' + String(remote.token).slice(-12);
		let desktopState = remote.viewState || {};
		let pending = [];
		const transmitting = new Set();
		let saved = remote.desktop ? desktopState.transportPending : [];
		try { const value = sessionStorage.getItem(pendingKey); if (value) saved = JSON.parse(value); } catch { /* unavailable storage */ }
		if (Array.isArray(saved)) pending = saved.filter(p => p && typeof p.id === 'string' && typeof p.type === 'string').slice(-30);
		const savePending = () => { try { sessionStorage.setItem(pendingKey, JSON.stringify(pending)); } catch { /* memory still retains identities */ } if (remote.desktop) { desktopState = { ...desktopState, transportPending:pending }; api?.setState(desktopState); } };
		const commandBanner = (detail) => {
			if (!document.createElement || !document.body?.appendChild) return;
			let banner = document.getElementById('command-state');
			if (!pending.length && !detail) { banner?.remove(); return; }
			// The desktop page posts over loopback and its receipts settle in the same process.
			// A routine pending receipt is not UI there — only an unconfirmed outcome is worth
			// a banner, so a normal send never leaves a "1 command awaiting…" notice behind.
			if (!detail && remote.desktop) return;
			if (!banner) { banner = document.createElement('div'); banner.id = 'command-state'; banner.className = 'command-state'; banner.setAttribute('role', 'status'); document.body.appendChild(banner); }
			banner.replaceChildren();
			const label = document.createElement('span'); label.textContent = detail || `${pending.length} command${pending.length === 1 ? '' : 's'} awaiting a confirmed outcome…`; banner.appendChild(label);
			if (detail) { const close = document.createElement('button'); close.textContent = 'Dismiss'; close.onclick = () => banner.remove(); banner.appendChild(close); }
		};
		const headers = () => ({ 'Content-Type':'application/json', 'X-Zer0ne-Token':remote.token, 'X-Zer0ne-Protocol':String(protocol) });
		const pollReceipts = async () => {
			if (polling || !negotiated || !pending.length) return;
			polling = true;
			let detail = '';
			try {
				for (const item of pending.filter(p => !transmitting.has(p.id)).slice(0, 3)) {
					const response = await fetch('/api/receipt?id=' + encodeURIComponent(item.id), { headers: headers() });
					if (response.status === 404) { pending = pending.filter(p => p.id !== item.id); detail = 'Acceptance could not be confirmed. Inspect the saved chat and execution history before submitting again.'; continue; }
					if (!response.ok) continue;
					const receipt = await response.json();
					if (['completed','failed','uncertain'].includes(receipt.status)) {
						pending = pending.filter(p => p.id !== item.id);
						if (receipt.status !== 'completed') detail = receipt.status === 'failed' ? 'Command handling failed. Inspect the chat status and saved work before retrying.' : 'Command outcome is uncertain after interruption. Inspect saved work and execution history before submitting again.';
					} else { pending = [...pending.filter(p => p.id !== item.id), item]; }
				}
			} catch { /* Reconnect resumes receipt lookup, never mutation replay. */ }
			finally { polling = false; savePending(); commandBanner(detail); if (pending.length) setTimeout(pollReceipts, 3000); }
		};
		// The desktop app runs one server per project and they share cookies, so its pages and the phones it
		// pairs authenticate each stream with their own token. Other phones use the HttpOnly cookie first,
		// keeping the token out of URLs; the query is the fallback below.
		let q = remote.desktop || remote.desktopHost ? '?t=' + encodeURIComponent(remote.token) : '';
		let failures = 0;
		let authBlocked = false;
		// The stream can deliver state before chat.js listens; hold it until the UI posts 'ready'.
		let uiReady = false;
		const early = [];
		let earlyBytes = 0;
		let latestState;
		const emit = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
		const applied = (data, id) => {
			if (data.type === 'transportSynced') { replaying = false; synced = true; failures = 0; linkBanner(false); emit({ type:'transportReady' }); return; }
			if (data.type === 'statePatch') {
				if (!latestState) return;
				latestState = { ...latestState, ...data.patch }; for (const key of data.removed || []) delete latestState[key]; data = latestState;
			} else if (data.type === 'state') latestState = data;
			emit(data);
			if (data.type === 'state') { session = data.currentSessionId || ''; if (!synced && !replaying) { synced = true; failures = 0; linkBanner(false); emit({ type:'transportReady' }); } }
			if (id) cursor = id;
		};
		const dispatch = (data, id) => {
			if (uiReady) { applied(data, id); return; }
			earlyBytes += JSON.stringify(data).length;
			if (early.length >= 512 || earlyBytes > 8 * 1024 * 1024) {
				early.length = 0; earlyBytes = 0; cursor = ''; latestState = undefined; negotiated = false;
				es.close(); retry = setTimeout(connect, 1000); return;
			}
			early.push({ data, id });
		};
		let es;
		let retry = 0;
		// A phone drops its stream when the screen locks or the network changes; say so
		// plainly instead of leaving a silent, frozen chat behind the scene.
		const linkBanner = (on, text) => {
			if (typeof document.createElement !== 'function' || !document.body || typeof document.body.appendChild !== 'function') return;
			const existing = typeof document.getElementById === 'function' ? document.getElementById('link-state') : null;
			if (on && !existing) {
				const el = document.createElement('div');
				el.id = 'link-state';
				el.className = 'link-state';
				el.setAttribute('role', 'status');
				el.innerHTML = '<i></i><span></span>'; el.querySelector('span').textContent = text || 'Reconnecting…';
				document.body.appendChild(el);
			} else if (on && existing && text) existing.querySelector('span').textContent = text;
			else if (!on && existing) existing.remove();
		};
		const connect = () => {
			if (authBlocked) return;
			retry = 0;
			es = new EventSource('/api/events' + q + (q ? '&' : '?') + 'v=' + protocol + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
			es.onmessage = (e) => {
				try {
					const data = JSON.parse(e.data);
					if (data.type === 'transportHello') {
						compatible = data.protocol === protocol; negotiated = compatible; synced = false; replaying = data.replaying === true;
						if (!compatible) { linkBanner(true, 'Update zer0ne Code and reload this page: incompatible protocol.'); es.close(); return; }
						if (epoch && epoch !== data.epoch) cursor = '';
						epoch = data.epoch; receiptsEnabled = data.capabilities?.receipts === true; commandBanner(); void pollReceipts(); return;
					}
					if (data.type === 'transportSynced') { dispatch(data); return; }
					dispatch(data, e.lastEventId);
				} catch {
					/* ignore */
				}
			};
			es.onerror = () => {
				negotiated = false; synced = false;
				document.body.classList.add('offline');
				linkBanner(true);
				es.close();
				if (++failures >= 2 && !q) q = '?t=' + encodeURIComponent(remote.token);
				retry = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) * (0.8 + Math.random() * 0.4));
				if (failures >= 2 && typeof fetch === 'function') {
					const stream = es;
					void fetch('/api/protocol', { headers:headers() }).then(response => {
						if (response.status === 401 && es === stream) { authBlocked = true; clearTimeout(retry); linkBanner(true, remote.desktop ? 'Reload this page to reconnect to the engine.' : 'Access expired or was revoked. Pair this device again.'); }
					}).catch(() => undefined);
				}
			};
			es.onopen = () => {
				document.body.classList.remove('offline');
				linkBanner(!synced, 'Connected, syncing…');
			};
		};
		// Coming back to the tab (or the network) reconnects at once instead of waiting out the retry.
		const wake = () => {
			if (document.hidden || authBlocked) return;
			if (!es || es.readyState === 2) {
				if (retry && typeof clearTimeout === 'function') clearTimeout(retry);
				connect();
			}
		};
		connect();
		// Only a phone browses away and back; the desktop page's stream is local and must
		// never restart from a visibility change mid-render.
		if (!remote.desktop) {
			window.addEventListener?.('online', wake);
			document.addEventListener?.('visibilitychange', wake);
		}
		// The desktop app uses the same HTTP transport but is the full app, not a phone.
		let stateWrite = Promise.resolve();
		let stateTimer;
		const send = async m => {
			if (!compatible || !negotiated || receipted.has(m.type) && !synced) { commandBanner('Wait for the engine connection to synchronize before sending an action.'); setTimeout(() => emit({ type:'transportRejected', action:m }), 0); return; }
			const h = headers();
			if (['ptyInput','ptyResize'].includes(m.type)) h['X-Zer0ne-Channel'] = 'terminal';
			if (receipted.has(m.type) && session) m = { ...m, zcSession: session };
			if (receiptsEnabled && receipted.has(m.type)) {
				h['X-Zer0ne-Command'] = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
				transmitting.add(h['X-Zer0ne-Command']); pending.push({ id: h['X-Zer0ne-Command'], type: m.type }); savePending(); commandBanner();
			}
			try {
				if (remote.desktop && h['X-Zer0ne-Command'] && !(await flushState())?.ok) { pending = pending.filter(p => p.id !== h['X-Zer0ne-Command']); savePending(); commandBanner('Command was not submitted because its recovery record could not be saved.'); setTimeout(() => emit({ type:'transportRejected', action:m }), 0); return; }
				const response = await fetch('/api/msg', { method:'POST', headers:h, body:JSON.stringify(m) });
				if (!response.ok) {
					if (response.status < 500) {
						if (h['X-Zer0ne-Command']) { pending = pending.filter(p => p.id !== h['X-Zer0ne-Command']); savePending(); }
						setTimeout(() => emit({ type:'transportRejected', action:m }), 0);
					}
					if (response.status === 426) { compatible = false; linkBanner(true, 'Reload this page to use the current engine protocol.'); }
					commandBanner('Action was not accepted (' + response.status + '). Inspect the chat before retrying.');
				}
				return response;
			} catch { document.body.classList.add('offline'); commandBanner('Delivery is unconfirmed. Reconnecting will check its receipt; the action will not be submitted again automatically.'); }
			finally { if (h['X-Zer0ne-Command']) { transmitting.delete(h['X-Zer0ne-Command']); void pollReceipts(); } }
		};
		const flushState = () => { clearTimeout(stateTimer); const state = desktopState; stateWrite = stateWrite.catch(() => undefined).then(() => send({type:'zcViewState',state})); return stateWrite; };
		api = {
			remote: !remote.desktop,
			desktop: !!remote.desktop,
			desktopHost: !!remote.desktop || !!remote.desktopHost,
			flushState: remote.desktop ? flushState : undefined,
			post: (m) => {
				if (m && m.type === 'ready') {
					// The event stream sends state on connect; release what arrived before the UI listened.
					if (!uiReady) {
						uiReady = true;
						early.splice(0).forEach(item => applied(item.data, item.id));
						earlyBytes = 0;
						if (negotiated && !synced) linkBanner(true, 'Connected, syncing…');
					}
					return;
				}
				if (remote.desktop && ['projectOpen','projectNewChat','projectPick'].includes(m?.type)) return flushState().then(() => send(m)).catch(() => document.body.classList.add('offline'));
				return send(m);
			},
			getState: () => {
				if (remote.desktop) return desktopState;
				try {
					return JSON.parse(localStorage.getItem('zer0ne-ui') || '{}');
				} catch {
					return {};
				}
			},
			setState: (s) => {
				if (remote.desktop) { desktopState = { ...s, transportPending:pending }; clearTimeout(stateTimer); stateTimer = setTimeout(() => { void flushState().catch(() => document.body.classList.add('offline')); }, 75); return; }
				try {
					localStorage.setItem('zer0ne-ui', JSON.stringify(s));
				} catch {
					/* private mode */
				}
			}
		};
	} else {
		// Plain browser without a host (demo pages provide acquireVsCodeApi).
		api = { remote: false, post: () => undefined, getState: () => ({}), setState: () => undefined };
	}
	// Both scripts share one persisted state object.
	api.patchState = (patch) => api.setState(Object.assign({}, api.getState(), patch));
	window.Bridge = api;
})();
