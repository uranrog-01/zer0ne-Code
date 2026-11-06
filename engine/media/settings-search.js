(() => {
	'use strict';
	function create(entries, choose) {
		const box = document.createElement('div'); box.className = 'settings-search';
		box.innerHTML = '<label class="settings-search-field"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search all settings…" aria-label="Search all settings" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="settings-search-results"><kbd>Ctrl F</kbd></label><div id="settings-search-results" class="settings-search-results" role="listbox" aria-label="Settings results" hidden></div><span class="sr-only" role="status" data-search-count></span>';
		const input = box.querySelector('input'), list = box.querySelector('[role="listbox"]');
		let results = [], selected = -1, composing = false;
		function close() { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
		function select(index) {
			selected = index;
			for (const [i, row] of [...list.querySelectorAll('[role="option"]')].entries()) row.setAttribute('aria-selected', String(i === selected));
			if (selected >= 0) { input.setAttribute('aria-activedescendant', 'setting-result-' + selected); list.children[selected]?.scrollIntoView?.({ block: 'nearest' }); }
			else input.removeAttribute('aria-activedescendant');
		}
		function paint() {
			if (composing) return;
			const tokens = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
			if (!tokens.length) { close(); return; }
			results = entries().map(entry => ({ ...entry, score: (entry.label.toLocaleLowerCase().startsWith(tokens[0]) ? 3 : 0) + (entry.key === tokens.join('') ? 5 : 0) })).filter(entry => tokens.every(term => [entry.label, entry.description, entry.breadcrumb, entry.key].join(' ').toLocaleLowerCase().includes(term))).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 24);
			list.replaceChildren();
			for (const [index, entry] of results.entries()) {
				const row = document.createElement('div'); row.id = 'setting-result-' + index; row.role = 'option'; row.setAttribute('aria-selected', 'false');
				const title = document.createElement('strong'), trail = document.createElement('span'); title.textContent = entry.label; trail.textContent = entry.breadcrumb;
				row.append(title, trail); row.addEventListener('mousedown', event => event.preventDefault()); row.addEventListener('click', () => { close(); choose(entry); }); list.appendChild(row);
			}
			if (!results.length) { const empty = document.createElement('p'); empty.textContent = 'No matching settings. Try a feature or control name.'; list.appendChild(empty); }
			box.querySelector('[data-search-count]').textContent = results.length + ' matching settings';
			list.hidden = false; input.setAttribute('aria-expanded', 'true'); select(results.length ? 0 : -1);
		}
		input.addEventListener('input', paint); input.addEventListener('focus', paint);
		input.addEventListener('compositionstart', () => { composing = true; }); input.addEventListener('compositionend', () => { composing = false; paint(); });
		input.addEventListener('keydown', event => {
			if (event.isComposing || composing) return;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (list.hidden) { input.value = ''; } close(); }
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (list.hidden) { paint(); if (results.length) select(event.key === 'ArrowDown' ? 0 : results.length - 1); } else if (results.length) select((selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length); }
			if (event.key === 'Enter' && selected >= 0 && !list.hidden) { event.preventDefault(); const entry = results[selected]; close(); choose(entry); }
		});
		box.addEventListener('focusout', event => { if (!box.contains(event.relatedTarget)) close(); });
		return box;
	}
	window.SettingsFinder = { create };
})();
