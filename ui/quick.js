/*
 * The Quick window page: type, Enter sends to the project of the window used last
 * (window.__zcShell, as every page of the app), Escape closes. It plays the window's
 * motion: a springy entrance on every open, a one-shot gradient sweep while you type,
 * a green check and glow when a prompt is sent (then the page closes itself), and a
 * small shake when a send fails.
 */
(function () {
	'use strict';
	const shell = window.__zcShell;
	const form = document.getElementById('quick');
	const prompt = document.getElementById('prompt');
	const send = document.getElementById('send');
	const target = document.getElementById('target');
	const note = document.getElementById('note');

	const ICON_SEND = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
	const ICON_DONE = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 8.5 6.8 11.3 12.5 5.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	function autosize() {
		prompt.style.height = 'auto';
		prompt.style.height = Math.min(prompt.scrollHeight, 84) + 'px';
		send.disabled = !prompt.value.trim();
	}

	async function refresh() {
		note.textContent = '';
		try {
			const t = await shell.invoke('quick_target');
			target.classList.toggle('on', !!t.project);
			target.lastElementChild.textContent = t.project ? 'To ' + t.project : 'No project open';
		} catch {
			target.classList.remove('on');
		}
	}

	/** Sent: the button becomes a check, the panel glows once, and the page closes itself. */
	function sent() {
		send.classList.add('done');
		send.innerHTML = ICON_DONE;
		form.classList.add('sent');
		setTimeout(() => { void shell.invoke('quick_close'); }, 420);
	}

	/** Failed: the note explains, the row shakes once, and typing may try again. */
	function fail(message) {
		note.textContent = message;
		send.disabled = false;
		form.classList.add('error');
		setTimeout(() => form.classList.remove('error'), 320);
	}

	async function submit() {
		const text = prompt.value.trim();
		if (!text) return;
		send.disabled = true;
		try {
			const r = await shell.invoke('quick_send', { text });
			if (r && r.ok) {
				prompt.value = '';
				autosize();
				sent();
			} else {
				fail((r && r.error) || 'Could not send.');
			}
		} catch (e) {
			fail((e && e.message) || 'Could not send.');
		}
	}

	form.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
	prompt.addEventListener('input', () => {
		form.classList.remove('error');
		autosize();
	});
	prompt.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') { e.preventDefault(); void shell.invoke('quick_close'); }
	});
	// The shell calls this each time the window is shown.
	window.__zcQuickShown = () => {
		form.classList.remove('out', 'sent', 'error');
		send.classList.remove('done');
		send.innerHTML = ICON_SEND;
		// The springy entrance replays on every open, not only on the first.
		form.style.animation = 'none';
		void form.offsetWidth;
		form.style.animation = '';
		void refresh();
		prompt.focus();
		prompt.select();
	};
	// The shell calls this before the window hides: the panel plays its exit, then hides.
	window.__zcQuickHide = () => {
		form.classList.remove('sent', 'error');
		form.classList.add('out');
		return new Promise((done) => setTimeout(done, 150));
	};
	autosize();
	void refresh();
	prompt.focus();
})();
