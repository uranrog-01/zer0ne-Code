(() => {
	'use strict';
	const B = window.Bridge;
	let state = {}, opened = new Map();
	const close = view => { view.container.remove(); B.post({ type: 'mcpAppClose', key: view.key }); opened.delete(view.key); };
	document.addEventListener('click', e => {
		const button = e.target.closest('[data-mcp-app]'); if (!button) return;
		B.post({ type: 'mcpAppOpen', id: button.dataset.mcpApp, sessionId: state.currentSessionId });
		button.textContent = 'Loading app…'; setTimeout(() => { if (button.isConnected) button.textContent = 'Open interactive app'; }, 5000);
	});
	window.addEventListener('message', e => {
		if (e.source && e.source !== window) {
			const view = [...opened.values()].find(v => v.frame.contentWindow === e.source); if (!view) return;
			const request = e.data;
			if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return;
			if (request.method === 'ui/notifications/size-changed') { const height = request.params?.height; if (Number.isFinite(height)) view.frame.style.height = Math.min(720, Math.max(160, height)) + 'px'; return; }
			if (JSON.stringify(request).length > 65536) return;
			B.post({ type: 'mcpAppRequest', key: view.key, request }); return;
		}
		const m = e.data || {};
		if (m.type === 'state') {
			state = m;
			for (const view of opened.values()) if (view.sessionId !== state.currentSessionId || !state.messages.some(message => message.id === view.id)) close(view);
			requestAnimationFrame(() => {
				for (const message of state.messages || []) {
					if (!message.mcpApp) continue;
					const card = document.getElementById('msg-' + message.id); if (!card) continue;
					if (!card.querySelector('[data-mcp-app]')) { const button = document.createElement('button'); button.className = 'btn btn-secondary btn-sm'; button.dataset.mcpApp = message.id; button.textContent = 'Open interactive app'; card.appendChild(button); }
				}
				for (const view of opened.values()) { const card = document.getElementById('msg-' + view.id); if (card && !card.contains(view.container)) card.appendChild(view.container); }
			});
		} else if (m.type === 'mcpAppOpened') {
			if (m.sessionId !== state.currentSessionId) { B.post({ type: 'mcpAppClose', key: m.key }); return; }
			for (const view of opened.values()) if (view.id === m.id) close(view);
			const card = document.getElementById('msg-' + m.id); if (!card) return;
			const container = document.createElement('section'); container.className = 'mcp-app-surface';
			const button = document.createElement('button'); button.className = 'btn btn-ghost btn-sm'; button.textContent = 'Close app';
			const frame = document.createElement('iframe'); frame.title = m.tool?.name || 'Interactive MCP App'; frame.sandbox = 'allow-scripts'; frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
			const view = { ...m, container, frame }; opened.set(m.key, view); button.onclick = () => close(view);
			container.append(button, frame); card.appendChild(container); frame.src = '/api/mcp-apps/' + encodeURIComponent(m.key);
		} else if (m.type === 'mcpAppResponse') opened.get(m.key)?.frame.contentWindow.postMessage(m.response, '*');
		else if (m.type === 'mcpAppReady') {
			const view = opened.get(m.key); if (!view) return;
			view.frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: view.input } }, '*');
			view.frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: view.result }, '*');
		}
	});
})();
