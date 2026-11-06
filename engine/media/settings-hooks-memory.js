(function () {
	'use strict';
	window.SettingsHooksMemory = { create({ S, h, header, capabilityTabs, hooksPage, memoryPage, persist, renderPage }) {
		let memoryDraft = '';
		function hooksMemoryPage() {
			const previous = document.querySelector('.hooks-memory-page #mem-add');
			if (previous) memoryDraft = previous.value;
			const tab = S.hooksMemoryTab === 'memory' ? 'memory' : 'hooks';
			S.hooksMemoryTab = tab;
			const root = h('div', 'page cap-page hooks-memory-page');
			root.appendChild(header('Hooks & Memory', 'Manage commands that run around agent work and the facts remembered in this workspace.'));
			const tabs = capabilityTabs([['hooks', 'Hooks'], ['memory', 'Memory']], tab, 'data-hooks-memory-tab', 'Hooks & Memory');
			const select = id => {
				if (id === S.hooksMemoryTab) return;
				S.hooksMemoryTab = id;
				persist();
				renderPage(true);
				document.getElementById('hooks-memory-tab-' + id)?.focus({ preventScroll: true });
			};
			const buttons = [...tabs.querySelectorAll('[data-hooks-memory-tab]')];
			for (const button of buttons) {
				button.type = 'button';
				button.id = 'hooks-memory-tab-' + button.dataset.hooksMemoryTab;
				button.setAttribute('aria-controls', 'hooks-memory-panel');
				button.addEventListener('click', () => select(button.dataset.hooksMemoryTab));
			}
			root.appendChild(tabs);
			const panel = h('section', 'hooks-memory-panel');
			panel.id = 'hooks-memory-panel';
			panel.setAttribute('role', 'tabpanel');
			panel.setAttribute('aria-labelledby', 'hooks-memory-tab-' + tab);
			const content = tab === 'hooks' ? hooksPage(true) : memoryPage();
			const title = content.querySelector('h1.page-title');
			if (title) {
				const heading = h('h2', title.className);
				heading.textContent = title.textContent;
				title.replaceWith(heading);
			}
			const draft = content.querySelector('#mem-add');
			if (draft) draft.value = memoryDraft;
			panel.appendChild(content);
			root.appendChild(panel);
			return root;
		}
		function hooksMemorySearchEntries() {
			return [
				{ label: 'Hooks', description: 'Commands, lifecycle events, templates and execution history', hooksMemoryTab: 'hooks' },
				{ label: 'Memory', description: 'Saved workspace facts, recall, pins and archived memories', hooksMemoryTab: 'memory' },
				{ label: 'Save memories from chats', key: 'agentMemory', hooksMemoryTab: 'memory' },
				{ label: 'Learn from chats automatically', key: 'memoryAutoSave', hooksMemoryTab: 'memory' },
				{ label: 'Search and reference chats', key: 'chatSearch', hooksMemoryTab: 'memory' },
				{ label: 'Include sensitive topics in memory', key: 'memorySensitive', hooksMemoryTab: 'memory' }
			].map(entry => ({ ...entry, section: 'hooks-memory', breadcrumb: 'Hooks & Memory' }));
		}
		return { hooksMemoryPage, hooksMemorySearchEntries };
	} };
})();
