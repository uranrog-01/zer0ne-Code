(() => {
	'use strict';
	const B = window.Bridge, esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
	let state = {}, dialog = null, runs = [];
	const post = m => B.post(m);
	const close = () => { dialog?.remove(); dialog = null; };
	function open() {
		close(); runs = []; dialog = document.createElement('dialog'); dialog.className = 'dialog workflow-history';
		dialog.setAttribute('aria-label', 'Saved workflow runs');
		dialog.innerHTML = '<div class="dialog-head"><b>Saved workflow runs</b><button class="icon-btn" data-close aria-label="Close">×</button></div><div class="dialog-body"><p>Each workflow run is saved with its chat. Replay starts a new chat with new inputs; Continue includes the previous report.</p><div data-runs>Loading…</div><form class="hidden" data-replay><label>Prompt / new inputs<textarea class="textarea" name="prompt" rows="6" required></textarea></label><div data-inputs></div><label>Parallel workers<input class="input" name="limit" type="number" min="1" max="10" required></label><label><input type="checkbox" name="resume"> Continue from the previous report</label><p class="muted">Uses the saved team and main model. Completed actions are not replayed as tool calls.</p><button class="btn btn-primary" type="submit">Start new run</button></form></div>';
		document.getElementById('dialog-root').appendChild(dialog); dialog.showModal();
		dialog.querySelector('[data-close]').onclick = close;
		dialog.addEventListener('cancel', close);
		dialog.addEventListener('click', e => {
			const button = e.target.closest('[data-run]'); if (!button) return;
			const record = runs.find(r => r.id === button.dataset.run); if (!record || record.status === 'running') return;
			const form = dialog.querySelector('form'); form.classList.remove('hidden'); form.dataset.run = record.id;
			form.elements.prompt.value = record.prompt; form.elements.limit.value = record.profile.maxConcurrency;
			const variables = [...new Set([...record.prompt.matchAll(/\{\{([\w.-]+)\}\}/g)].map(m => m[1]))];
			form.querySelector('[data-inputs]').innerHTML = variables.map(name => '<label>' + esc(name) + '<input class="input" data-variable="' + esc(name) + '" required></label>').join('');
			form.elements.prompt.focus();
		});
		dialog.querySelector('form').onsubmit = e => {
			e.preventDefault(); const form = e.target, record = runs.find(r => r.id === form.dataset.run); if (!record) return;
			let prompt = form.elements.prompt.value;
			for (const input of form.querySelectorAll('[data-variable]')) prompt = prompt.split('{{' + input.dataset.variable + '}}').join(input.value);
			form.querySelector('[type="submit"]').disabled = true;
			post({ type: 'replayWorkflow', id: record.id, sessionId: record.sessionId, prompt, profile: { maxConcurrency: Number(form.elements.limit.value) }, resume: form.elements.resume.checked });
		};
		post({ type: 'workflowRuns' });
	}
	document.addEventListener('click', e => { if (e.target.closest('[data-workflow-history]')) open(); });
	window.WorkflowHistory = { open };
	window.addEventListener('message', e => {
		if (e.source && e.source !== window) return;
		if (e.data?.type === 'state') state = e.data;
		if (e.data?.type === 'workflowReplayStarted') close();
		if (e.data?.type === 'workflowReplayFailed' && dialog) {
			dialog.querySelector('[type="submit"]').disabled = false;
			let error = dialog.querySelector('[data-replay-error]');
			if (!error) { error = document.createElement('p'); error.dataset.replayError = ''; error.setAttribute('role', 'alert'); dialog.querySelector('form').appendChild(error); }
			error.textContent = e.data.message;
		}
		if (e.data?.type === 'workflowRuns' && dialog) {
			runs = e.data.items || [];
			dialog.querySelector('[data-runs]').innerHTML = runs.length ? runs.map(r => '<article class="workflow-run"><div><b>' + esc(r.title) + '</b><small>' + esc(r.status) + ' · ' + esc(new Date(r.startedAt).toLocaleString()) + '</small></div><button class="btn btn-secondary btn-sm" data-run="' + esc(r.id) + '"' + (r.status === 'running' || state.isStreaming ? ' disabled' : '') + '>Replay / Continue</button></article>').join('') : '<p>No saved runs yet. Enable a workflow and send its first task.</p>';
		}
	});
})();
