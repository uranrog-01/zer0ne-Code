(function () {
	'use strict';
	window.ComputerUse = { create({ B, I }) {
		if (window.__zcComputerUse) return window.__zcComputerUse;
		if (B.remote && !B.desktop && !B.desktopHost) return;
		const esc = value => String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
		let state = {enabled:false,paused:true,apps:[]}, windows = [], dialog, origin, busy = false, error = '', query = '', request = '';
		const history = window.ComputerHistory?.create();
		const pill = document.createElement('div'); pill.className = 'cu-status'; pill.hidden = true;
		pill.innerHTML = '<button type="button" class="cu-status-open" aria-label="Computer Use permissions">' + I('eye') + '<span></span></button><button type="button" class="cu-stop" title="Stop Computer Use across all projects">Stop</button>';
		const mount = () => { const bar = document.querySelector('.topbar-right'); if (bar && !pill.isConnected) bar.prepend(pill); };
		pill.querySelector('.cu-status-open').onclick = () => open();
		pill.querySelector('.cu-stop').onclick = () => send('computerUseStop');
		function send(type, rest) { busy = true; error = ''; request = String(Date.now()) + Math.random(); B.post({type,requestId:request,...rest}); paint(); }
		function paint() {
			mount(); pill.hidden = !state.enabled && !state.active;
			pill.classList.toggle('is-active',!!state.active && !state.paused);
			pill.querySelector('.cu-status-open span').textContent = state.active && !state.paused ? 'Computer Use · Active' : state.paused ? 'Computer Use · Paused' : 'Computer Use · Ready';
			pill.querySelector('.cu-stop').hidden = state.paused;
			if (!dialog) return;
			const status = !state.supported ? 'Windows required' : !state.enabled ? 'Off' : state.paused ? 'Paused' : state.active ? 'Active' : 'Ready';
			dialog.querySelector('[data-cu-status]').textContent = status;
			dialog.querySelector('[data-cu-shortcut]').textContent = state.shortcut && !state.paused ? 'Stop from any app: Ctrl + Alt + Esc' : 'Stop pauses Computer Use across all projects.';
			dialog.querySelector('[data-cu-status]').classList.toggle('is-ready',state.enabled && !state.paused);
			const toggle = dialog.querySelector('[data-cu-enable]'); toggle.checked = !!state.enabled; toggle.disabled = !state.supported || busy;
			dialog.querySelector('[data-cu-history]').checked = !!state.history;
			const design = state.effects === 'design', effects = dialog.querySelector('[data-cu-effects]');
			effects.checked = design; effects.disabled = !state.supported;
			const stay = dialog.querySelector('[data-cu-stay]'); stay.checked = !!state.stayReady; stay.disabled = !state.supported || busy;
			dialog.querySelector('[data-cu-effects-note]').textContent = design ? 'On: one design-tool cursor redraws the controlled window, then marks each click with a box, its size and rulers. A bar on the window keeps Pause and Stop. Reduced motion and high contrast still use the classic outline.' : 'Off: the classic blue outline and pointer, with Pause and Stop above the window.';
			const resume = dialog.querySelector('[data-cu-resume]'); resume.textContent = state.paused ? 'Resume Computer Use' : 'Pause Computer Use'; resume.disabled = busy || !state.supported || !state.enabled || !state.apps.length;
			dialog.querySelector('[data-cu-error]').textContent = error || state.error || '';
			dialog.querySelector('[data-cu-refresh]').disabled = busy || !state.supported;
			dialog.querySelector('[data-cu-allowed]').innerHTML = state.apps.length ? state.apps.map(app => '<div class="cu-app"><span class="cu-app-icon">' + I('monitor') + '</span><div><b>' + esc(app.name) + '</b><small title="' + esc(app.path) + '">' + esc(app.path) + '</small></div><button type="button" class="btn btn-secondary btn-sm" data-cu-revoke="' + esc(app.path) + '"' + (busy ? ' disabled' : '') + '>Remove</button></div>').join('') : '<div class="cu-empty">No apps allowed yet.<small>Add an open app below to get started.</small></div>';
			const allowed = new Set(state.apps.map(a => a.path.toLowerCase())), seen = new Set();
			const shown = windows.filter(app => { const key = app.path.toLowerCase(); if (seen.has(key) || allowed.has(key)) return false; seen.add(key); return (app.name + ' ' + app.title).toLowerCase().includes(query.toLowerCase()); });
			dialog.querySelector('[data-cu-apps]').innerHTML = shown.length ? shown.map(app => '<div class="cu-app"><span class="cu-app-icon">' + I('monitor') + '</span><div><b>' + esc(app.name) + '</b><small title="' + esc(app.path) + '">' + esc(app.title) + '</small></div><button type="button" class="btn btn-secondary btn-sm" data-cu-allow="' + esc(app.windowId) + '" data-cu-pid="' + app.processId + '"' + (busy ? ' disabled' : '') + '>Allow app</button></div>').join('') : '<div class="cu-empty">' + (busy ? 'Finding open apps…' : query ? 'No matching apps.' : 'Open an app, then refresh the list.') + '</div>';
		}
		function close() { if (!dialog) return; const old = dialog; dialog = null; old.remove(); origin?.focus(); }
		function open() {
			if (dialog) { dialog.focus(); return; }
			origin = document.activeElement;
			dialog = document.createElement('dialog'); dialog.className = 'cu-dialog'; dialog.setAttribute('aria-labelledby','cu-title');
			dialog.innerHTML = '<header class="cu-header"><span class="cu-hero-icon">' + I('eye') + '</span><div><h2 id="cu-title">Computer Use</h2><p>Your apps. Your control.</p></div><button type="button" class="icon-btn" data-cu-close aria-label="Close Computer Use">' + I('close') + '</button></header><div class="cu-body"><section class="cu-session"><div><b>Allow computer control</b><p>A vision model can see and interact with apps you choose.</p></div><input type="checkbox" role="switch" aria-label="Enable Computer Use" data-cu-enable></section><section class="cu-session"><div><b>Design cursor effects</b><p data-cu-effects-note></p></div><input type="checkbox" role="switch" aria-label="Use design cursor effects" data-cu-effects></section><section class="cu-session"><div><b>Stay ready after restart</b><p>Resume by itself when zer0ne starts, for the apps you allowed. Moving your mouse or typing still pauses it, and Stop still stops it.</p></div><input type="checkbox" role="switch" aria-label="Stay ready after restart" data-cu-stay></section><div class="cu-control-row"><span class="cu-badge" data-cu-status></span><button type="button" class="btn btn-primary btn-sm" data-cu-resume>Resume Computer Use</button></div><p class="cu-shortcut" data-cu-shortcut></p><p class="cu-error" role="alert" data-cu-error></p><section><div class="cu-section-heading"><h3>Allowed apps</h3><span>Saved on this computer</span></div><div data-cu-allowed></div></section><section><div class="cu-section-heading"><h3>Add an app</h3><button type="button" class="link-btn" data-cu-refresh>Refresh</button></div><input type="search" class="input cu-search" placeholder="Search open apps" aria-label="Search open apps"><div class="cu-available" data-cu-apps></div></section><p class="cu-note">Only the focused allowed app is captured, on the primary display. Permissions cover all windows of that app. Stop pauses control across every project. Full access still respects these permissions.</p><p class="cu-note">Actions inside an allowed app can affect files, websites or other apps. These permissions do not sandbox the app.</p></div><footer class="cu-footer"><span>App changes pause control until you resume.</span><button type="button" class="btn btn-secondary btn-sm" data-cu-close>Done</button></footer>';
			const review = document.createElement('section'); review.className = 'cu-history-settings';
			review.innerHTML = '<label><input type="checkbox" data-cu-history> Keep screenshots in chat</label><p class="cu-note">Off by default. Saved screenshots become part of this chat and may contain app content. The latest eight remain available for review. Turning this off stops saving new screenshots.</p><button type="button" class="btn btn-secondary btn-sm" data-cu-review>Review screenshots</button><p class="cu-note">Moving your mouse or typing pauses control. Resume explicitly in these permissions.</p>';
			dialog.querySelector('.cu-body').appendChild(review);
			dialog.querySelector('[data-cu-stay]').onchange = event => send('computerUseStayReady',{on:event.target.checked});
			dialog.querySelector('[data-cu-effects]').onchange = event => B.post({type:'updateSettings',patch:{computerEffects:event.target.checked ? 'design' : 'classic'}});
			review.querySelector('[data-cu-history]').onchange = event => B.post({type:'updateSettings',patch:{computerScreenshotHistory:event.target.checked}});
			review.querySelector('[data-cu-review]').onclick = () => { close(); history?.open(); };
			dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
			dialog.addEventListener('click',event => {
				const target = event.target.closest('button'); if (!target) return;
				if (target.hasAttribute('data-cu-close')) close();
				else if (target.hasAttribute('data-cu-refresh')) send('computerUseApps');
				else if (target.hasAttribute('data-cu-resume')) send(state.paused ? 'computerUseResume' : 'computerUseStop');
				else if (target.hasAttribute('data-cu-revoke')) send('computerUseRevoke',{path:target.dataset.cuRevoke});
				else if (target.hasAttribute('data-cu-allow')) send('computerUseAllow',{windowId:target.dataset.cuAllow,processId:Number(target.dataset.cuPid)});
			});
			dialog.querySelector('[data-cu-enable]').onchange = event => { B.post({type:'updateSettings',patch:{computerUse:event.target.checked}}); };
			dialog.querySelector('.cu-search').addEventListener('input',event => { if (!event.isComposing) { query = event.target.value; paint(); } });
			dialog.querySelector('.cu-search').addEventListener('compositionend',event => { query = event.target.value; paint(); });
			document.body.appendChild(dialog); dialog.showModal(); paint(); send('computerUseApps');
		}
		document.addEventListener('click',event => { if (event.target.closest('[data-computer-use]')) { event.preventDefault(); open(); } });
		window.addEventListener('message',event => {
			const m = event.data;
			if (m?.type === 'computerUseState') { state = m; if (m.requestId === request) busy = false; paint(); }
			else if (m?.type === 'computerUseApps') { windows = m.apps || []; if (m.requestId === request) busy = false; paint(); }
			else if (m?.type === 'computerUseError') { if (m.requestId === request) busy = false; error = m.message; paint(); }
			else if (m?.type === 'state') { mount(); B.post({type:'computerUseState'}); }
		});
		B.post({type:'computerUseState'});
		window.__zcComputerUse = {open}; return window.__zcComputerUse;
	} };
})();
