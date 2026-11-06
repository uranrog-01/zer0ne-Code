(function () {
	'use strict';
	window.ChatRepository = { create({ I, esc, basename, fileBadge, shortPath }) {
		const button = (icon, label, attrs, cls = '') => '<button type="button" class="repo-button ' + cls + '" ' + attrs + '>' + I(icon) + '<span>' + esc(label) + '</span></button>';
		function heading(icon, eyebrow, title, description, actions) {
			return '<header class="repo-heading"><div class="repo-heading-icon">' + I(icon) + '</div><div class="repo-heading-copy"><span class="repo-eyebrow">' + esc(eyebrow) + '</span><h2>' + esc(title) + '</h2><p>' + esc(description) + '</p></div></header>' + (actions ? '<div class="repo-toolbar">' + actions + '</div>' : '');
		}
		function empty(icon, title, message, error) {
			return '<section class="repo-empty"><span class="repo-empty-icon">' + I(icon) + '</span><h3>' + esc(title) + '</h3><p>' + esc(message) + '</p>' + (error ? '<details class="repo-error"><summary>Technical details</summary><pre>' + esc(error) + '</pre></details>' : '') + '</section>';
		}
		function unavailable(error, worktrees) {
			const missing = /not a git repository|local (?:git project|folder)|no (?:git )?repository/i.test(error);
			return missing ? empty('folder', 'Git repository required', worktrees ? 'Open a Git project with at least one commit to work on separate branches here.' : 'This folder has no Git repository. Open a Git project to review changed files here.', error)
				: empty('alert', worktrees ? 'Could not load worktrees' : 'Could not load changes', 'Refresh to try again. Your project files have not been changed.', error);
		}
		function metric(value, label, tone = '') {
			return '<div class="repo-metric ' + tone + '"><strong>' + esc(value === null ? '—' : String(value)) + '</strong><span>' + esc(label) + '</span></div>';
		}
		function diff(value) {
			if (!value) return '';
			const title = '<div class="repo-diff-heading"><div><span class="repo-eyebrow">File comparison</span><h3 title="' + esc(value.path) + '">' + esc(value.path) + '</h3></div>' + button('close', 'Close diff', 'data-aux-close-diff') + '</div>';
			const contents = value.loading ? '<p class="repo-reading" role="status">Reading file comparison…</p>' : value.error ? '<p class="repo-reading">' + esc(value.error) + '</p>' :
				'<div class="repo-diff-grid"><section class="repo-diff-side before"><h4><span>Before</span><small>HEAD</small></h4><pre tabindex="0" aria-label="File at HEAD"><code>' + esc(value.original || '') + '</code></pre></section><section class="repo-diff-side after"><h4><span>After</span><small>Working tree</small></h4><pre tabindex="0" aria-label="Working tree file"><code>' + esc(value.modified || '') + '</code></pre></section></div>';
			return '<section class="repo-diff">' + title + contents + '</section>';
		}
		function changes(git, comparison) {
			const g = git || {}, files = g.changes || [];
			const refresh = button('refresh', 'Refresh', 'data-repo-refresh="changes"');
			const branch = g.branch ? '<span class="repo-branch" title="' + esc(g.branch) + '">' + I('branch') + '<span>' + esc(g.branch) + '</span></span>' : '<span class="repo-toolbar-label">Workspace changes</span>';
			let body;
			if (!git) body = empty('fileDiff', 'Reading repository…', 'Checking this project for changed files.');
			else if (g.error) body = unavailable(g.error, false);
			else {
				const tracked = files.filter(f => f.status !== '?');
				const known = !files.length || tracked.some(f => Number.isFinite(f.added) || Number.isFinite(f.removed));
				const added = known ? (g.added ?? files.reduce((n, f) => n + (f.added || 0), 0)) : null;
				const removed = known ? (g.removed ?? files.reduce((n, f) => n + (f.removed || 0), 0)) : null;
				body = '<div class="repo-metrics">' + metric(files.length, 'Changed files') + metric(added, 'Lines added', 'positive') + metric(removed, 'Lines removed', 'negative') + '</div>';
				if (!files.length) body += empty('check', 'Working tree clean', 'There are no uncommitted changes in this repository.');
				else {
					const names = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflicted', T: 'Type changed' };
					body += '<section class="repo-file-section"><div class="repo-section-label">Changed files<span>' + files.length + '</span></div><div class="aux-changes">' + files.map(f => {
						const st = f.status === '?' ? 'U' : String(f.status || 'M').slice(0, 1), label = f.status === '?' ? 'Untracked' : names[st] || 'Changed';
						const path = String(f.path || ''), dir = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
						return '<div class="aux-change"><span class="gtr-st s-' + esc(st === 'U' ? 'q' : st) + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + esc(st) + '</span>' + fileBadge(path) +
							'<button type="button" class="aux-change-name" data-aux-diff="' + esc(path) + '" title="Show diff: ' + esc(path) + '"><span>' + esc(basename(path)) + '</span><small>' + esc(dir || 'Project root') + '</small></button>' +
							(f.staged ? '<span class="repo-pill">Staged</span>' : '') +
							(Number.isFinite(f.added) || Number.isFinite(f.removed) ? '<span class="aux-diff-stat"><b class="add">+' + (f.added || 0) + '</b><b class="del">−' + (f.removed || 0) + '</b></span>' : '<span class="repo-file-status">' + esc(label) + '</span>') +
							'<span class="aux-change-acts"><button type="button" class="icon-btn" data-aux-file="' + esc(path) + '" title="Open file" aria-label="Open ' + esc(path) + '">' + I('file') + '</button><button type="button" class="icon-btn" data-aux-diff="' + esc(path) + '" title="Show diff" aria-label="Diff of ' + esc(path) + '">' + I('fileDiff') + '</button>' +
								(window.SideChat ? '<button type="button" class="icon-btn" data-side-ask="' + esc(path) + '" title="Ask Side Chat about this change" aria-label="Ask Side Chat about ' + esc(path) + '">' + I('chat') + '</button>' : '') + '</span></div>';
					}).join('') + '</div></section>';
					if (files.some(f => f.status === '?')) body += '<p class="repo-footnote">New files are listed before their line counts are available.</p>';
				}
			}
			return '<div class="repo-panel">' + heading('fileDiff', 'Version control', 'Changes', 'Review changes across your project, including edits outside this chat.', branch + refresh) + body + diff(comparison) + '</div>';
		}
		function worktrees(data, desktop) {
			const items = data.worktrees || [], error = data.worktreeError;
			const create = button('plus', 'New worktree', 'data-aux-create-worktree', 'primary');
			const toolbar = (!error ? create : '<span class="repo-toolbar-label">Repository checkouts</span>') + button('refresh', 'Refresh', 'data-repo-refresh="worktrees"');
			let body = error ? unavailable(error, true) : '<div class="repo-section-label">Checkouts<span>' + items.length + '</span></div>';
			if (!error) body += items.length ? '<div class="wt-list">' + items.map(w => {
				return '<article class="wt-card' + (w.current ? ' current' : '') + (w.locked ? ' locked' : '') + '" data-aux-worktree-card="' + esc(w.path || '') + '"><div class="wt-main"><div class="wt-head"><span class="wt-ico">' + I(w.main ? 'monitor' : 'branch') + '</span><span class="wt-branch">' + esc(w.branch || 'Detached checkout') + '</span></div>' +
					'<div class="repo-worktree-tags">' + (w.current ? '<span class="wt-tag">' + I('check') + 'This window</span>' : '') + (w.main ? '<span class="repo-pill">Main checkout</span>' : '') + (w.locked ? '<span class="repo-pill">' + I('lock') + 'Locked</span>' : '') + '</div>' +
					'<span class="wt-path" title="' + esc(w.path || '') + '">' + esc(shortPath(w.path)) + '</span><div class="repo-worktree-footer">' + (w.head ? '<span class="wt-commit">' + esc(String(w.head).slice(0, 7)) + '</span>' : '<span class="repo-toolbar-label">No commit yet</span>') +
					'<div class="wt-acts">' + button('copy', 'Copy path', 'data-aux-copy-path="' + esc(w.path || '') + '"') + button('monitor', desktop ? 'Switch project' : 'Open in new window', 'data-aux-worktree="' + esc(w.path || '') + '"') + (!w.main ? button('trash', 'Remove', 'data-aux-remove-worktree="' + esc(w.path || '') + '"' + (w.locked || data.worktreeBusy ? ' disabled title="' + (w.locked ? 'Unlock this checkout in Git first' : 'Wait for the current run and its agents to finish') + '"' : '')) : '') + '</div></div></div></article>';
			}).join('') + '</div>' : empty('branch', 'Room for your next task', 'Create an isolated checkout to work on another branch alongside this project.');
			if (data.worktreeEntry) body += '<section class="repo-task-entry"><span class="repo-eyebrow">New checkout</span><h3>What are you working on?</h3><p>A new branch and folder will be created from the latest commit; uncommitted changes stay in this checkout. ' + (desktop ? 'The app switches to that project.' : 'It opens in a new window.') + '</p><label for="repo-worktree-task">Task</label><input id="repo-worktree-task" class="input" data-aux-worktree-task aria-label="Worktree task" placeholder="Describe the task for this branch…" value="' + esc(data.worktreeTask || '') + '"><div class="repo-task-actions">' + button('close', 'Cancel', 'data-aux-cancel-worktree') + button('plus', 'Create and open', 'data-aux-submit-worktree', 'primary') + '</div></section>';
			return '<div class="repo-panel">' + heading('branch', 'Parallel work', 'Worktrees', 'Separate Git checkouts for work on another branch. A workflow chooses the agents; a worktree is the folder they run in.', toolbar) + body + '</div>';
		}
		return { changes, worktrees, diff };
	} };
})();
