(function (root) {
	'use strict';
	const labels = { running: 'Running', waiting: 'Needs your answer', unread: 'Unread', failed: 'Failed', stopped: 'Stopped', idle: '' };
	function activity(chat, live) {
		if (live === 'waiting' || live === 'running') return live;
		if (chat.outcome === 'failed') return 'failed';
		if (chat.unread) return 'unread';
		if (chat.outcome === 'stopped') return 'stopped';
		return 'idle';
	}
	function sections(items, order = []) {
		const ranks = new Map(order.map((id, index) => [id, index]));
		const compare = (a, b) => (ranks.get(a.chat.id) ?? Infinity) - (ranks.get(b.chat.id) ?? Infinity) || b.chat.updatedAt - a.chat.updatedAt;
		const buckets = { attention: [], running: [], pinned: [], recent: [], archived: [] };
		for (const item of items) {
			const key = item.chat.archived ? 'archived' : item.status === 'waiting' || item.chat.unread ? 'attention' : item.status === 'running' ? 'running' : item.chat.pinned ? 'pinned' : 'recent';
			buckets[key].push(item);
		}
		return Object.entries(buckets).filter(([, values]) => values.length).map(([key, values]) => ({
			key: 'section:' + key, title: { attention: 'Needs attention', running: 'Running', pinned: 'Pinned', recent: 'Recent', archived: 'Archived' }[key],
			items: values.sort(compare), open: key !== 'archived'
		}));
	}
	function create(o) {
		const doc = o.document || root.document;
		const content = doc.getElementById('sidebar-content');
		const search = doc.getElementById('project-search');
		const groups = new Map(), rows = new Map(), seen = new Map();
		let data = [], view = o.view === 'chats' ? 'chats' : 'projects', scrolls = {}, palette = null, previousFocus;
		let order = Array.isArray(o.order) ? [...new Set(o.order.filter(id => typeof id === 'string'))] : [], dragging = null;
		const make = (tag, cls, text) => { const n = doc.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; };
		const text = (node, value) => { value = String(value ?? ''); if (node.textContent !== value) node.textContent = value; };
		const attr = (node, name, value) => { value = String(value); if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
		function arrange(parent, children) {
			let at = parent.firstElementChild;
			for (const child of children) {
				if (child !== at) parent.insertBefore(child, at);
				at = child.nextElementSibling;
			}
			for (const child of [...parent.children]) if (!children.includes(child)) child.remove();
		}
		const controls = make('div', 'project-panel-controls');
		const views = make('div', 'project-panel-views'); views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Sidebar view');
		/** The panel remembers its last view across reopens. */
		function setView(next) {
			if (!['projects', 'chats'].includes(next) || next === view) return;
			scrolls[view] = content.scrollTop; view = next;
			o.persist?.({ projectPanelView: view }); o.refresh(); content.scrollTop = scrolls[view] || 0;
		}
		const viewButtons = ['projects', 'chats'].map(key => {
			const button = make('button', 'project-view', key === 'projects' ? 'Projects' : 'Chats'); button.type = 'button';
			button.dataset.view = key;
			button.addEventListener('click', () => setView(key)); views.appendChild(button); return button;
		});
		const command = make('button', 'project-command'); command.type = 'button'; command.innerHTML = o.icon('search');
		command.title = 'Search projects, chats and actions (Ctrl/Cmd+Shift+P)'; command.setAttribute('aria-label', 'Open command palette');
		command.addEventListener('click', openPalette);
		controls.append(views, command);
		doc.getElementById('project-search-box').before(controls);
		const orderStatus = make('span', 'project-order-status'); orderStatus.setAttribute('role', 'status'); controls.appendChild(orderStatus);
		function clearDrag() {
			dragging = null;
			for (const row of content.querySelectorAll('.project-chat')) row.classList.remove('reordering', 'drop-before', 'drop-after');
		}
		function saveOrder(ids, moved) {
			order = [...ids, ...order.filter(id => !ids.includes(id))];
			o.persist?.({ projectChatOrder: order }); render(data);
			orderStatus.textContent = (rows.get(moved)?.title.textContent || 'Chat') + ' moved to position ' + (ids.indexOf(moved) + 1) + ' of ' + ids.length + '.';
		}
		function siblings(row) { return [...row.parentElement.children].filter(node => node.classList.contains('project-chat') && !node.disabled); }
		content.addEventListener('dragstart', event => {
			const row = event.target.closest('.project-chat');
			if (!row || row.disabled || search.value.trim() || event.target.closest('.project-more')) { event.preventDefault(); return; }
			dragging = row; row.classList.add('reordering');
			event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.dataset.projectChat);
		});
		content.addEventListener('dragover', event => {
			const row = event.target.closest('.project-chat');
			for (const item of content.querySelectorAll('.drop-before, .drop-after')) item.classList.remove('drop-before', 'drop-after');
			if (!dragging || !row || row === dragging || row.disabled || row.parentElement !== dragging.parentElement) return;
			event.preventDefault(); event.dataTransfer.dropEffect = 'move';
			const bounds = row.getBoundingClientRect(); row.classList.add(event.clientY < bounds.top + bounds.height / 2 ? 'drop-before' : 'drop-after');
		});
		content.addEventListener('drop', event => {
			const row = event.target.closest('.project-chat');
			if (!dragging || !row || row === dragging || row.disabled || row.parentElement !== dragging.parentElement || search.value.trim()) { clearDrag(); return; }
			event.preventDefault();
			const id = dragging.dataset.projectChat, list = siblings(row).filter(node => node !== dragging);
			const bounds = row.getBoundingClientRect(), index = list.indexOf(row) + (event.clientY < bounds.top + bounds.height / 2 ? 0 : 1);
			list.splice(index, 0, dragging); clearDrag(); saveOrder(list.map(node => node.dataset.projectChat), id);
			rows.get(id)?.open.focus({ preventScroll: true });
		});
		content.addEventListener('dragend', clearDrag);
		content.addEventListener('keydown', event => {
			if (event.isComposing || event.keyCode === 229) return;
			const row = event.target.closest('.project-chat'), button = event.target.closest('.project-chat-open');
			if (event.key === 'Escape' && dragging) { event.preventDefault(); event.stopPropagation(); clearDrag(); return; }
			if (!row || !button || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
			if (event.altKey) {
				if (search.value.trim() || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
				const list = siblings(row), index = list.indexOf(row), next = index + (event.key === 'ArrowUp' ? -1 : 1);
				if (next < 0 || next >= list.length) return;
				event.preventDefault(); [list[index], list[next]] = [list[next], list[index]];
				saveOrder(list.map(node => node.dataset.projectChat), row.dataset.projectChat); button.focus({ preventScroll: true }); return;
			}
			if (event.ctrlKey || event.metaKey || event.shiftKey) return;
			const buttons = [...content.querySelectorAll('.project-chat-open:not(:disabled)')].filter(node => node.closest('details')?.open !== false);
			const index = buttons.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
			event.preventDefault(); buttons[next]?.focus();
		});
		root.addEventListener?.('blur', clearDrag);
		function liveFor(chat) {
			const state = o.state();
			if (state.runningSessionId === chat.id && state.isStreaming) return state.runState === 'waiting' ? 'waiting' : 'running';
			return root.__zcProjectActivity?.get(chat.id) || (root.__zcBusySessionIds?.has(chat.id) ? 'running' : undefined);
		}
		function allItems() {
			const state = o.state();
			return data.flatMap(project => (project.chats || []).filter(chat => !o.desktop() || chat.count || (chat.title && chat.title !== 'New chat') || liveFor(chat)).map(chat => ({ project, chat, status: activity(chat, liveFor(chat)), active: chat.id === state.currentSessionId })));
		}
		function makeGroup(key) {
			const group = make('details', 'project-group'); group.dataset.panelKey = key;
			const header = make('summary', 'project-row');
			const icon = make('i', 'project-folder-icon'); icon.innerHTML = o.icon('folder');
			const name = make('span', 'project-name');
			const tools = make('span', 'project-tools');
			const fresh = make('button', 'icon-btn'); fresh.type = 'button'; fresh.innerHTML = o.icon('newChat');
			tools.appendChild(fresh); header.append(icon, name, tools); group.appendChild(header);
			const record = { group, header, name, tools, fresh, empty: make('p', 'panel-note', 'No chats in this project yet.') };
			groups.set(key, record); return record;
		}
		function updateGroup(spec) {
			const record = groups.get(spec.key) || makeGroup(spec.key), { group, name, fresh, tools, header } = record;
			const project = spec.project;
			group.classList.toggle('zc-has-running', spec.items.some(item => item.status === 'running'));
			attr(name, 'title', project?.path || ''); text(name.querySelector('.zc-project-title') || name, spec.title);
			group.dataset.defaultOpen = spec.open ? 'true' : 'false';
			if (!group.dataset.panelInitialized) { group.open = !!spec.open; group.dataset.panelInitialized = 'true'; }
			group.classList.toggle('zc-current-project', !!project?.current);
			group.classList.toggle('project-section', !project);
			group.classList.toggle('project-pinned', !!project?.pinned);
			if (project?.path && o.desktop()) {
				let remove = tools.querySelector('.zc-delete-project');
				if (!remove) { remove = make('button', 'icon-btn zc-delete-project'); remove.type = 'button'; remove.innerHTML = o.icon('trash'); tools.appendChild(remove); }
				attr(remove, 'title', 'Delete project folder…'); attr(remove, 'aria-label', 'Delete project folder ' + project.name);
				remove.onclick = event => { event.preventDefault(); event.stopPropagation(); o.post({ type: 'projectDelete', path: project.path }); };
				let more = tools.querySelector('.project-folder-more');
				if (!more) {
					more = make('button', 'icon-btn project-folder-more'); more.type = 'button'; more.innerHTML = o.icon('more'); tools.appendChild(more);
					more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', 'false');
				}
				attr(more, 'title', 'More project actions'); attr(more, 'aria-label', 'More actions for ' + project.name);
				more.onclick = event => { event.preventDefault(); event.stopPropagation(); root.__zcProjectActions?.projectMenu(project, more); };
				const folder = header.querySelector('.project-folder-icon');
				const glyph = o.icon(project.pinned ? 'pin' : 'folder'); if (folder.innerHTML !== glyph) folder.innerHTML = glyph;
			}
			let badge = header.querySelector('.project-badge');
			if (project?.current && !badge) { badge = make('em', 'project-badge', 'Current'); header.insertBefore(badge, tools); }
			if (!project?.current && badge) badge.remove();
			fresh.hidden = !project?.path; fresh.disabled = project?.available === false;
			if (project?.path) { fresh.dataset.projectNew = project.path; attr(fresh, 'title', 'New chat in ' + project.name); attr(fresh, 'aria-label', 'New chat in ' + project.name); }
			if (project?.path && !o.desktop()) {
				let open = tools.querySelector('[data-project-open]');
				if (!open) { open = make('button', 'icon-btn'); open.type = 'button'; open.innerHTML = o.icon('expand'); tools.appendChild(open); }
				open.dataset.projectOpen = project.path; open.disabled = !project.available; attr(open, 'aria-label', 'Open ' + project.name + ' in a project window');
			}
			const parent = group.querySelector('.project-chats') || group;
			const desired = spec.items.map(updateRow);
			if (!desired.length) desired.push(record.empty);
			// The desktop decorator owns the header and its wrapper, so reconcile only its chat children.
			if (parent === group) arrange(group, [header, ...desired]); else arrange(parent, desired);
			return group;
		}
		function updateRow(item) {
			const { chat, project, status, active } = item;
			let record = rows.get(chat.id);
			if (!record) {
				const row = make('div', 'project-chat'); row.dataset.projectChat = chat.id;
				row.draggable = true;
				const open = make('button', 'project-chat-open'); open.type = 'button'; open.dataset.projectChat = chat.id;
				const glyph = make('i', 'project-chat-glyph'); glyph.setAttribute('aria-hidden', 'true');
				const body = make('span', 'project-chat-body'), title = make('span', 'project-chat-title'), projectLabel = make('small', 'project-chat-project'); body.append(title, projectLabel);
				const state = make('em', 'project-chat-state'), time = make('time');
				const more = make('button', 'project-more'); more.type = 'button'; more.innerHTML = o.icon('more');
				open.append(glyph, body, state, time); row.append(open, more);
				record = { row, open, glyph, title, projectLabel, state, time, more }; rows.set(chat.id, record);
			}
			const { row, open, glyph, title, projectLabel, state, time, more } = record;
			row.dataset.projectPath = open.dataset.projectPath = project.path || '';
			row.dataset.activity = status; row.disabled = open.disabled = more.disabled = project.available === false;
			row.classList.toggle('selected', active); row.classList.toggle('archived', !!chat.archived); row.classList.toggle('zc-pinned', !!chat.pinned);
			attr(open, 'aria-current', active ? 'page' : 'false');
			attr(open, 'aria-label', (chat.title || 'New chat') + ' · ' + project.name + (labels[status] ? ' · ' + labels[status] : ''));
			attr(open, 'title', 'Open chat · Drag to reorder in this group · Alt+↑ / Alt+↓ to move');
			text(title, chat.title || 'New chat'); text(projectLabel, project.name); projectLabel.hidden = view !== 'chats';
			const icon = status === 'running' ? 'orb' : status === 'waiting' ? 'shield' : status === 'failed' ? 'alert' : chat.pinned ? 'pin' : 'chat';
			// A running chat shows the live starburst orb (media/orbs.js) instead of an icon.
			if (glyph.dataset.icon !== icon) { glyph.innerHTML = icon === 'orb' ? '<zc-orb kind="spark"></zc-orb>' : o.icon(icon); glyph.dataset.icon = icon; }
			text(state, labels[status]); state.hidden = !labels[status];
			state.classList.toggle('shimmer', status === 'running');
			text(time, o.time(chat.updatedAt)); time.hidden = status !== 'idle';
			attr(more, 'aria-label', 'Manage ' + (chat.title || 'New chat')); attr(more, 'title', 'Manage chat');
			return row;
		}
		function acknowledge() {
			if (doc.hidden || !doc.hasFocus()) return;
			const item = allItems().find(item => item.active);
			if (!item?.chat.completedAt || !item.chat.unread || seen.get(item.chat.id) === item.chat.completedAt) return;
			seen.set(item.chat.id, item.chat.completedAt);
			o.post({ type: 'sessionSeen', id: item.chat.id, completedAt: item.chat.completedAt });
		}
		function render(projects) {
			data = projects;
			const scroll = content.scrollTop, focused = doc.activeElement, focusWasInside = content.contains(doc.activeElement);
			const query = search.value.trim().toLowerCase();
			const items = allItems().filter(({ chat, project }) => !query || (chat.title || '').toLowerCase().includes(query) || project.name.toLowerCase().includes(query) || project.path.toLowerCase().includes(query));
			o.chatMap.clear(); for (const item of items) o.chatMap.set(item.chat.id, item.chat);
			const ranks = new Map(order.map((id, index) => [id, index]));
			const specs = view === 'chats' ? sections(items, order) : data.filter(p => !query || items.some(i => i.project === p) || p.name.toLowerCase().includes(query) || p.path.toLowerCase().includes(query)).map(p => ({ key: p.id || p.path || p.name, title: p.name, project: p, items: items.filter(i => i.project === p).sort((a, b) => (ranks.get(a.chat.id) ?? Infinity) - (ranks.get(b.chat.id) ?? Infinity) || b.chat.updatedAt - a.chat.updatedAt), open: p.current }));
			const desired = specs.map(updateGroup);
			if (!desired.length) desired.push(make('div', 'aux-empty', query ? 'No matching projects or chats.' : 'No chats yet. Start a new conversation.'));
			arrange(content, desired);
			viewButtons.forEach((button, i) => attr(button, 'aria-pressed', (i === 1 ? 'chats' : 'projects') === view));
			const title = doc.querySelector('.sidebar-title'); if (title) text(title, view === 'chats' ? 'Chats' : 'Projects');
			if (root.__zcDecorateProjects) root.__zcDecorateProjects(content, scroll); else content.scrollTop = scroll;
			if (focused && !focused.isConnected && focusWasInside) search.focus({ preventScroll: true });
			else if (focusWasInside && focused?.isConnected && doc.activeElement !== focused) focused.focus({ preventScroll: true });
			for (const [id, record] of rows) if (!data.some(p => p.chats?.some(c => c.id === id))) { record.row.remove(); rows.delete(id); }
			if (palette) updatePalette();
			acknowledge();
		}
		function choices(query) {
			const state = o.state(), q = query.trim().toLowerCase();
			const items = [
				{ id: 'new-chat', title: 'New chat', detail: 'Current project', run: () => o.post({ type: 'newSession' }) },
				{ id: 'new-project', title: 'Create project…', detail: 'Choose and trust a folder', run: () => root.__zcCreateProject ? root.__zcCreateProject() : o.post({ type: 'projectPick' }) },
				{ id: 'settings', title: 'Open settings', detail: 'App action', run: o.settings },
				{ id: 'terminal', title: 'Open terminal', detail: 'Current project', run: o.terminal },
				{ id: 'sidebar', title: 'Show Projects & Chats', detail: 'App action', run: o.sidebar }
			];
			for (const project of data) {
				if (project.path) items.push({ id: 'p:' + (project.id || project.path), title: project.name, detail: project.path, disabled: !project.available, run: () => o.post({ type: 'projectOpen', path: project.path }) });
				for (const chat of project.chats || []) if (chat.count || chat.title && chat.title !== 'New chat' || liveFor(chat) || chat.id === state.currentSessionId) items.push({
					id: 'c:' + chat.id, title: chat.title || 'New chat', detail: project.name + (chat.archived ? ' · Archived' : '') + (labels[activity(chat, liveFor(chat))] ? ' · ' + labels[activity(chat, liveFor(chat))] : ''), disabled: !project.available,
					run: () => o.post({ type: 'switchSession', id: chat.id })
				});
			}
			return items.filter(item => !q || (item.title + ' ' + item.detail).toLowerCase().includes(q)).slice(0, 80);
		}
		function updatePalette() {
			if (!palette) return;
			const old = palette.items?.[palette.index]?.id;
			palette.items = choices(palette.input.value);
			const found = palette.items.findIndex(item => item.id === old);
			palette.index = found >= 0 ? found : Math.max(0, palette.items.findIndex(item => !item.disabled));
			palette.list.replaceChildren();
			palette.items.forEach((item, index) => {
				const button = make('button', 'project-palette-option'); button.type = 'button'; button.id = 'project-command-' + index; button.tabIndex = -1; button.disabled = !!item.disabled;
				button.setAttribute('role', 'option'); button.append(make('b', '', item.title), make('small', '', item.detail));
				button.addEventListener('mousedown', event => event.preventDefault());
				button.addEventListener('click', () => selectPalette(index)); palette.list.appendChild(button);
			});
			if (!palette.items.length) palette.list.appendChild(make('p', 'project-palette-empty', 'No matching projects, chats or actions.'));
			paintPalette();
		}
		function paintPalette() {
			const children = [...palette.list.querySelectorAll('button')];
			children.forEach((button, index) => attr(button, 'aria-selected', index === palette.index));
			if (children[palette.index]) { attr(palette.input, 'aria-activedescendant', children[palette.index].id); children[palette.index].scrollIntoView?.({ block: 'nearest' }); }
			else palette.input.removeAttribute('aria-activedescendant');
		}
		function selectPalette(index) {
			const choice = palette.items[index]; if (!choice || choice.disabled) return;
			closePalette(); choice.run();
		}
		function closePalette() {
			if (!palette) return; palette.backdrop.remove(); palette = null;
			if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
		}
		function openPalette() {
			if (palette) { palette.input.focus(); return; }
			previousFocus = doc.activeElement;
			const backdrop = make('div', 'project-palette-backdrop');
			const dialog = make('section', 'project-palette'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Command palette');
			const head = make('div', 'project-palette-head'), input = make('input', 'project-palette-input');
			input.type = 'search'; input.placeholder = 'Search projects, chats and actions…'; input.autocomplete = 'off'; input.setAttribute('role', 'combobox'); input.setAttribute('aria-label', input.placeholder); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'project-command-results'); input.setAttribute('aria-autocomplete', 'list');
			const close = make('button', 'project-palette-close', 'Esc'); close.type = 'button'; close.setAttribute('aria-label', 'Close command palette'); close.addEventListener('click', closePalette);
			const list = make('div', 'project-palette-results'); list.id = 'project-command-results'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Projects, chats and actions');
			head.append(input, close); dialog.append(head, list, make('p', 'project-palette-foot', '↑ ↓ Choose   ·   Enter Open   ·   Esc Close')); backdrop.appendChild(dialog); doc.body.appendChild(backdrop);
			palette = { backdrop, input, list, items: [], index: 0 };
			backdrop.addEventListener('click', event => { if (event.target === backdrop) closePalette(); });
			input.addEventListener('input', updatePalette);
			dialog.addEventListener('keydown', event => {
				if (event.isComposing) return;
				if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePalette(); }
				else if (event.key === 'Tab') { event.preventDefault(); (doc.activeElement === input ? close : input).focus(); }
				else if (event.key === 'Enter' && event.target === input) { event.preventDefault(); selectPalette(palette.index); }
				else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault(); const direction = event.key === 'ArrowDown' ? 1 : -1;
					for (let count = 0; count < palette.items.length; count++) { palette.index = (palette.index + direction + palette.items.length) % palette.items.length; if (!palette.items[palette.index].disabled) break; }
					paintPalette();
				}
			});
			updatePalette(); input.focus(); o.post({ type: 'getProjects' });
		}
		doc.addEventListener('keydown', event => {
			if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p' && !event.isComposing) { event.preventDefault(); openPalette(); }
		});
		doc.addEventListener('visibilitychange', () => { if (!doc.hidden) { acknowledge(); o.post({ type: 'getProjects' }); } });
		root.addEventListener?.('focus', acknowledge);
		return { render, openPalette, closePalette, acknowledge, setView, get view() { return view; } };
	}
	const api = { create, activity, sections };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	else root.ProjectPanel = api;
})(typeof window === 'undefined' ? globalThis : window);
