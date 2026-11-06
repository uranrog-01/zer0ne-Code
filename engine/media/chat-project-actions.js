(function (root) {
	'use strict';
	function create(o) {
		const doc = o.document || root.document;
		let active = null;
		let projectMenu = null, menuAnchor = null;
		let filesActivation = null;
		root.addEventListener('message', event => {
			if (event.source && event.source !== root) return;
			const msg = event.data;
			if (msg?.type !== 'zcDesktopActivated' || msg.view !== 'files' || typeof msg.activationId !== 'string' || msg.activationId === filesActivation) return;
			filesActivation = msg.activationId;
			o.files();
		});
		function dialog(title, detail, accept, submit, value) {
			if (active) { active.focus(); return; }
			const previous = doc.activeElement;
			const node = doc.createElement('dialog');
			node.className = 'project-action-dialog';
			node.setAttribute('aria-labelledby', 'project-action-title');
			node.setAttribute('aria-describedby', 'project-action-detail');
			node.innerHTML = '<form><h2 id="project-action-title"></h2><p id="project-action-detail"></p><div class="project-action-field" hidden><label for="project-action-name">Project name</label><input id="project-action-name" maxlength="100" required autocomplete="off"></div><footer><button type="button" class="btn project-action-no" autofocus></button><button type="submit" class="btn btn-primary"></button></footer></form>';
			node.querySelector('h2').textContent = title;
			node.querySelector('p').textContent = detail;
			node.querySelector('[type="submit"]').textContent = accept;
			const cancel = node.querySelector('.project-action-no'), input = node.querySelector('input');
			cancel.textContent = value === undefined ? 'No' : 'Cancel';
			cancel.onclick = () => node.close();
			if (value !== undefined) {
				node.querySelector('.project-action-field').hidden = false;
				input.value = value;
			} else input.disabled = true;
			node.addEventListener('keydown', event => event.stopPropagation());
			node.addEventListener('close', () => { node.remove(); active = null; if (previous?.isConnected) previous.focus({ preventScroll: true }); });
			node.querySelector('form').onsubmit = event => {
				event.preventDefault();
				if (value !== undefined && !input.value.trim()) { input.focus(); return; }
				node.close(); submit(input.value.trim());
			};
			active = node; doc.body.appendChild(node); node.showModal();
			if (value !== undefined) { input.focus(); input.select(); } else cancel.focus();
		}
		function renameProject(path, name) {
			dialog('Rename project', 'Choose the name shown in the project list. The folder on disk keeps its current name.', 'Save', value => o.post({ type: 'projectRename', path, name: value }), name);
		}
		return {
			projectMenu(project, anchor) {
				if (projectMenu?.isConnected && menuAnchor === anchor) { projectMenu.remove(); anchor.focus(); return; }
				const run = action => () => { projectMenu.remove(); anchor.focus({ preventScroll: true }); action(); };
				const entries = [
					o.item('folder', 'Show Files', { cls: 'project-show-files', disabled: project.available === false, onClick: run(() => o.post({ type: 'projectShowFiles', path: project.path })) }),
					o.item('pencil', 'Rename project…', { cls: 'project-rename', onClick: run(() => renameProject(project.path, project.name)) }),
					o.item('pin', project.pinned ? 'Unpin project' : 'Pin to top', { cls: 'project-pin', onClick: run(() => o.post({ type: 'projectPin', path: project.path, pinned: !project.pinned })) })
				];
				if (!project.current) entries.push(o.item('close', 'Remove from list…', { cls: 'project-remove', onClick: run(() => dialog('Remove project from list?', 'The project folder and its saved chats will be kept. You can add the project again later.', 'Yes', () => o.post({ type: 'projectRemove', path: project.path }))) }));
				const menu = o.menu(anchor, entries);
				projectMenu = menu; menuAnchor = anchor;
				menu.classList.add('project-folder-menu'); menu.id = 'project-folder-menu';
				menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Actions for ' + project.name);
				anchor.setAttribute('aria-expanded', 'true'); anchor.setAttribute('aria-controls', menu.id);
				const remove = menu.remove.bind(menu);
				menu.remove = () => { remove(); anchor.setAttribute('aria-expanded', 'false'); anchor.removeAttribute('aria-controls'); if (projectMenu === menu) { projectMenu = null; menuAnchor = null; } };
				for (const entry of entries) { entry.type = 'button'; entry.setAttribute('role', 'menuitem'); entry.tabIndex = -1; }
				o.navigate(menu, anchor);
				menu.addEventListener('keydown', event => { if (event.key === 'Tab') { menu.remove(); anchor.focus(); event.stopPropagation(); } });
				entries.find(entry => !entry.disabled)?.focus();
			},
			showFiles(path) { o.post({ type: 'projectShowFiles', path }); },
			deleteChat(id) {
				const chat = o.session(id);
				if (!chat) return;
				dialog('Delete chat?', 'Are you sure you want to delete “' + (chat.title || 'New chat') + '”? This permanently deletes the saved chat. Project files are kept.', 'Yes', () => o.post({ type: 'deleteSession', id }));
			},
			renameProject
		};
	}
	root.ChatProjectActions = { create };
})(window);
