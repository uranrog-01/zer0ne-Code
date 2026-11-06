(function (root) {
	'use strict';
	function create(o) {
		const doc = o.document || root.document;
		let active = null;
		return {
			show(id) {
				const state = o.state();
				if (state.isStreaming || state.isRemote || !state.currentSessionId) return;
				if (active) { active.focus(); return; }
				const sessionId = state.currentSessionId, previous = doc.activeElement;
				const dialog = doc.createElement('dialog');
				dialog.className = 'chat-branch-dialog';
				dialog.setAttribute('aria-labelledby', 'chat-branch-title');
				dialog.innerHTML = '<h2 id="chat-branch-title">Branch chat from here</h2><button type="button" class="chat-branch-choice" data-destination="workspace">' + o.icon('branchOut') + '<span>Branch in this workspace<small>Continue from this message in the current workspace</small></span></button><button type="button" class="chat-branch-choice" data-destination="worktree">' + o.icon('branchOut') + '<span>Branch in a new worktree<small>Continue from this message in a separate Git checkout, from the latest commit; uncommitted changes stay in this checkout</small></span></button><footer><button type="button" class="btn chat-branch-cancel">Cancel</button></footer>';
				const worktree = dialog.querySelector('[data-destination="worktree"]');
				worktree.disabled = !state.hasWorkspace || !state.workspace?.path;
				if (worktree.disabled) worktree.querySelector('small').textContent = 'Open a local project folder to use Git worktrees';
				dialog.querySelector('.chat-branch-cancel').onclick = () => dialog.close();
				for (const button of dialog.querySelectorAll('[data-destination]')) {
					button.onclick = () => {
						const current = o.state();
						dialog.close();
						if (current.currentSessionId === sessionId && !current.isStreaming && !current.isRemote) o.post({ type: 'branchChat', id, sessionId, destination: button.dataset.destination });
					};
				}
				dialog.addEventListener('keydown', event => event.stopPropagation());
				dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close(); } });
				dialog.addEventListener('close', () => { dialog.remove(); active = null; if (previous?.isConnected) previous.focus({ preventScroll: true }); });
				active = dialog;
				doc.body.appendChild(dialog);
				dialog.showModal();
				dialog.querySelector('[data-destination="workspace"]').focus();
			}
		};
	}
	root.ChatBranch = { create };
})(window);
