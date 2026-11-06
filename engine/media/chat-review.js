(function () {
	'use strict';
	window.ChatReview = { create({ I, el, esc, h, post, state, toast }) {
	function reviewDialog(className, title) {
		const previous = document.activeElement, dialog = h('dialog', 'dialog ' + className);
		dialog.setAttribute('aria-label', title);
		dialog.innerHTML = '<div class="dialog-head"><span class="dialog-title">' + esc(title) + '</span><button type="button" class="icon-btn" data-review-close aria-label="Close">' + I('close') + '</button></div><div class="dialog-body"></div>';
		dialog.querySelector('[data-review-close]').addEventListener('click', () => dialog.close());
		dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dialog.close(); } });
		dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected && previous !== document.body) previous.focus(); else el.input.focus(); }, { once: true });
		document.body.appendChild(dialog); dialog.showModal(); return dialog;
	}
	let hunkRequested = false;
	document.addEventListener('click', event => {
		const button = event.target.closest('[data-hunk-review]');
		if (!button) return;
		hunkRequested = true;
		post({ type: 'hunkReview', sessionId: state.currentSessionId, id: button.dataset.hunkReview, path: button.dataset.path });
	});
	function showHunkReview(msg) {
		if (msg.sessionId !== state.currentSessionId || !hunkRequested) return;
		let dialog = document.querySelector('.hunk-review-dialog');
		if (msg.error) {
			if (!dialog) { hunkRequested = false; toast(msg.error); return; }
			dialog.querySelector('[data-hunk-error]').textContent = msg.error;
			for (const button of dialog.querySelectorAll('[data-hunk-action]')) button.disabled = false;
			return;
		}
		if (!dialog) { dialog = reviewDialog('hunk-review-dialog', 'Review hunks'); dialog.addEventListener('close', () => { hunkRequested = false; [...document.querySelectorAll('[data-hunk-review]')].find(button => button.dataset.hunkReview === msg.id && button.dataset.path === msg.path)?.focus(); }); }
		const focused = dialog.querySelector(':focus')?.dataset.hunkIndex;
		const body = dialog.querySelector('.dialog-body');
		body.innerHTML = '<p><b>' + esc(msg.path) + '</b></p><p>Keep marks a block as reviewed. Undo removes just that block; Redo restores it. The original turn remains available in Undo.</p><p role="status" data-hunk-error></p>' + (msg.hunks.length ? msg.hunks.map(block => '<section class="change-review-block"><h3>Block ' + (block.index + 1) + ' · line ' + block.line + ' · ' + (block.undone ? 'Undone' : block.kept ? 'Kept' : 'Awaiting review') + '</h3><div class="change-review-columns"><div><b>Before</b><pre>' + esc(block.before || '(empty)') + '</pre></div><div><b>After</b><pre>' + esc(block.after || '(empty)') + '</pre></div></div><div class="change-review-actions">' + (block.truncated ? '<p>Preview truncated. Use full-file Review and Undo for this block.</p>' : block.undone ? '<button type="button" class="aux-btn" data-hunk-action="redo" data-hunk-index="' + block.index + '">Redo block</button>' : '<button type="button" class="aux-btn" data-hunk-action="keep" data-hunk-index="' + block.index + '">Keep</button><button type="button" class="aux-btn" data-hunk-action="undo" data-hunk-index="' + block.index + '">Undo block</button>') + '</div></section>').join('') : '<p>No changed blocks.</p>');
		for (const button of body.querySelectorAll('[data-hunk-action]')) button.addEventListener('click', () => {
			for (const control of body.querySelectorAll('[data-hunk-action]')) control.disabled = true;
			post({ type: 'hunkDecision', sessionId: msg.sessionId, reviewId: msg.reviewId, index: Number(button.dataset.hunkIndex), action: button.dataset.hunkAction });
		});
		if (focused !== undefined) body.querySelector('[data-hunk-index="' + focused + '"]')?.focus();
	}
	let comparisonSession = '';
	function openComparisons() {
		document.querySelector('.comparison-dialog')?.close();
		comparisonSession = state.currentSessionId;
		const dialog = reviewDialog('comparison-dialog', 'Compare models'), body = dialog.querySelector('.dialog-body');
		const options = state.providers.filter(p => p.enabled && p.apiFormat !== 'acp' && p.apiFormat !== 'vscode-lm').flatMap(p => p.models.filter(m => m.enabled && m.tools !== false).map(m => '<option value="' + esc(p.id + '::' + m.id) + '">' + esc(p.name + ' · ' + (m.name || m.id)) + '</option>')).join('');
		body.innerHTML = '<p>Run the same task with 2–4 models in separate worktrees from the same committed Git revision. Uncommitted project edits are not copied. Each run uses quota and shares your task budget. Choose a candidate to review and apply when all runs stop.</p><form data-comparison-form><label>Task<textarea name="prompt" rows="3" maxlength="40000" required placeholder="Describe the task and how to verify it"></textarea></label><div class="comparison-picks">' + [0, 1, 2, 3].map(i => '<label>Model ' + (i + 1) + (i > 1 ? ' (optional)' : '') + '<select name="model' + i + '"' + (i < 2 ? ' required' : '') + '><option value="">Choose a model</option>' + options + '</select></label>').join('') + '</div><button type="submit" class="aux-btn" data-comparison-start>Run comparison</button></form><p role="status" data-comparison-error></p><div data-comparison-groups>Loading comparisons…</div><div data-comparison-diff></div>';
		body.querySelector('form').addEventListener('submit', event => {
			event.preventDefault();
			const data = new FormData(event.target), models = [0, 1, 2, 3].map(i => data.get('model' + i)).filter(Boolean);
			if (new Set(models).size !== models.length) { body.querySelector('[data-comparison-error]').textContent = 'Choose distinct models.'; return; }
			body.querySelector('[data-comparison-start]').disabled = true;
			post({ type: 'comparisonStart', sessionId: comparisonSession, prompt: data.get('prompt'), models });
		});
		post({ type: 'comparisonList', sessionId: comparisonSession });
	}
	function comparisonMessage(msg) {
		const dialog = document.querySelector('.comparison-dialog');
		if (!dialog || msg.sessionId !== comparisonSession || comparisonSession !== state.currentSessionId) return;
		const error = dialog.querySelector('[data-comparison-error]');
		if (msg.type === 'comparisonError') {
			error.textContent = msg.error;
			for (const button of dialog.querySelectorAll('button')) button.disabled = false;
			return;
		}
		error.textContent = '';
		if (msg.type === 'comparisonApplied') { dialog.querySelector('[data-comparison-diff]').replaceChildren(); return; }
		if (msg.type === 'comparisonDiff') {
			const box = dialog.querySelector('[data-comparison-diff]');
			box.innerHTML = '<section class="change-review-block"><h3>Candidate changes · ' + esc(String(msg.files.length)) + ' files</h3><pre class="comparison-patch">' + esc(msg.patch || '(No file changes)') + '</pre>' + (msg.truncated ? '<p>Diff is too large for Apply or Discard here. Inspect the retained worktree.</p>' : '<div class="change-review-actions">' + (!msg.applied ? '<button type="button" class="aux-btn" data-comparison-action="apply">Apply this candidate</button>' : '') + '<button type="button" class="aux-btn" data-comparison-action="discard">Discard this candidate</button></div>') + '</section>';
			for (const button of box.querySelectorAll('[data-comparison-action]')) button.addEventListener('click', () => {
				for (const control of box.querySelectorAll('button')) control.disabled = true;
				post({ type: 'comparisonReview', sessionId: comparisonSession, groupId: msg.groupId, id: msg.id, reviewId: msg.reviewId, action: button.dataset.comparisonAction });
			});
			box.scrollIntoView({ block: 'nearest' }); return;
		}
		dialog.querySelector('[data-comparison-start]').disabled = msg.groups.some(g => g.active) || state.isStreaming;
		const groups = dialog.querySelector('[data-comparison-groups]');
		groups.innerHTML = msg.groups.length ? [...msg.groups].reverse().map(g => '<section class="comparison-group"><h3>' + esc(g.prompt.slice(0, 120)) + '</h3><p>Base ' + esc(g.base.slice(0, 12)) + (g.applied ? ' · Candidate applied' : '') + '</p>' + (g.error ? '<p>' + esc(g.error) + '</p>' : '') + (g.active ? '<button type="button" class="aux-btn" data-comparison-stop="' + esc(g.id) + '">Stop comparison</button>' : '') + (!g.active && !g.applied && g.candidates.length ? '<p class="comparison-pick">' + (g.recommended ? 'Recommended: <b>' + esc(g.candidates.find(c => c.id === g.recommended.id)?.spec || '') + '</b> — ' + esc(g.recommended.reason) + '. Review its diff before applying.' : 'No recommendation: no candidate finished with passing checks. Compare the diffs yourself.') + '</p>' : '') + '<div class="comparison-results">' + g.candidates.map(c => '<article class="change-review-block' + (g.recommended && g.recommended.id === c.id ? ' recommended' : '') + '"><h4>' + esc(c.spec) + (g.recommended && g.recommended.id === c.id ? ' <span class="comparison-badge">Recommended</span>' : '') + '</h4><p>' + esc(c.status) + ' · ' + Math.round(c.elapsedMs / 1000) + 's · ' + c.attempts + ' requests</p><p>' + c.input + ' input / ' + c.output + ' output tokens' + (c.unknownUsage ? ' (incomplete)' : '') + ' · ' + (c.unknownCost || !c.attempts ? 'Cost unavailable' : '$' + c.cost.toFixed(4)) + '</p><p>' + (c.stat ? c.stat.files + ' files · +' + c.stat.added + ' −' + c.stat.removed : 'No change summary') + '</p><p>' + (c.checks.length ? c.checks.map(v => esc(v.scope + ': ' + v.status + (v.stale ? ' (stale)' : ''))).join('<br>') : 'No verification recorded') + '</p>' + (c.error ? '<p>' + esc(c.error) + '</p>' : '') + (c.dir && !['merged','discarded'].includes(c.status) ? '<p class="comparison-worktree">' + esc(c.branch || '') + '<br>' + esc(c.dir) + '</p>' : '') + (c.report ? '<details><summary>Report</summary><pre>' + esc(c.report) + '</pre></details>' : '') + (!['starting', 'running', 'merged', 'discarded', 'unavailable'].includes(c.status) ? '<button type="button" class="aux-btn" data-comparison-review="' + esc(c.id) + '" data-group="' + esc(g.id) + '">View diff</button>' + (c.dir && !state.isRemote ? '<button type="button" class="aux-btn" data-comparison-open="' + esc(c.dir) + '">Open worktree</button>' : '') : '') + '</article>').join('') + '</div></section>').join('') : '<p>No comparisons in this chat yet.</p>';
		for (const button of groups.querySelectorAll('[data-comparison-review]')) button.addEventListener('click', () => post({ type: 'comparisonReview', sessionId: comparisonSession, groupId: button.dataset.group, id: button.dataset.comparisonReview, action: 'diff' }));
		for (const button of groups.querySelectorAll('[data-comparison-open]')) button.addEventListener('click', () => post({ type: 'openWorktree', path: button.dataset.comparisonOpen }));
		for (const button of groups.querySelectorAll('[data-comparison-stop]')) button.addEventListener('click', () => post({ type: 'comparisonStop', sessionId: comparisonSession, groupId: button.dataset.comparisonStop }));
	}

	/** Another chat opened: its review dialogs and a pending hunk request no longer apply. */
	function resetReviews() {
		hunkRequested = false;
		document.querySelector('.hunk-review-dialog')?.close();
		document.querySelector('.comparison-dialog')?.close();
	}
	return { showHunkReview, openComparisons, comparisonMessage, resetReviews };
	} };
})();
