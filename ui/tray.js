/*
 * The tray menu page: one floating glass panel with the app's fixed rows (tray.html).
 * The shell hands over the small data — version, theme, which way the panel opens, the
 * shortcut labels and the running count — on every open (window.__zcPull → tray_data);
 * every row sends its fixed key back (tray_action). Keyboard: arrows move, Enter runs,
 * Escape closes, and a click on the empty area around the panel closes it too.
 */
(function () {
	'use strict';
	const shell = window.__zcShell;
	if (!shell) return;
	const body = document.body;
	const panel = document.getElementById('panel');
	const version = document.getElementById('version');
	const status = document.getElementById('status');
	const statusText = status.lastElementChild;

	function el(tag, cls, text) {
		const n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text !== undefined) n.textContent = text;
		return n;
	}

	async function fire(key) {
		try { await shell.invoke('tray_action', { key }); } catch { /* the panel is closing anyway */ }
	}

	/** A row's shortcut hint: "Ctrl+Alt+Space" becomes kbd chips, whatever the platform labels. */
	function setHint(row, text) {
		const h = row && row.querySelector('.row-hint');
		if (!h || !text) return;
		h.replaceChildren(...String(text).split('+').flatMap((p, i) => i ? [el('i', 'plus', '+'), el('kbd', null, p)] : [el('kbd', null, p)]));
	}

	function render(data) {
		body.classList.toggle('light', data.theme === 'light');
		body.classList.toggle('below', data.side === 'below');
		version.textContent = 'v' + data.version;
		status.classList.toggle('busy', data.running > 0);
		statusText.textContent = data.running > 0 ? `${data.running} agent${data.running === 1 ? '' : 's'} running` : 'Ready';
		setHint(document.querySelector('[data-key="zc:quick"]'), data.quickKeys);
		setHint(document.querySelector('[data-key="zc:notch"]'), data.notchKeys);
		panel.classList.remove('in');
		void panel.offsetWidth;
		panel.classList.add('in');
		const first = panel.querySelector('button:not(:disabled)');
		if (first) first.focus();
	}

	let lastData = null;
	async function pull() {
		let d;
		try { d = await shell.invoke('tray_data'); } catch { return; }
		const key = JSON.stringify(d);
		if (key === lastData) return;
		lastData = key;
		render(d);
	}

	// The shell nudges on every open and while the panel shows.
	window.__zcPull = () => { void pull(); };

	panel.addEventListener('click', (e) => {
		const row = e.target.closest('button[data-key]');
		if (row && panel.contains(row) && !row.disabled) void fire(row.dataset.key);
	});

	document.addEventListener('mousedown', (e) => {
		if (!panel.contains(e.target)) void fire('zc:close');
	});
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') { e.preventDefault(); void fire('zc:close'); return; }
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
		const rows = [...panel.querySelectorAll('button:not(:disabled)')];
		if (!rows.length) return;
		e.preventDefault();
		const i = rows.indexOf(document.activeElement);
		const next = e.key === 'ArrowDown' ? rows[i + 1] || rows[0]
			: e.key === 'ArrowUp' ? rows[i > 0 ? i - 1 : rows.length - 1]
			: e.key === 'Home' ? rows[0] : rows[rows.length - 1];
		next.focus();
	});

	void pull();
})();
