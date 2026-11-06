(function () {
	'use strict';
	const B = window.Bridge, pane = document.getElementById('aux-content-terminal');
	if (!B || !pane) return;
	const make = (tag, text, parent) => { const node = document.createElement(tag); if (text) node.textContent = text; if (parent) parent.appendChild(node); return node; };
	const button = (text, parent, fn) => { const node = make('button', text, parent); node.type = 'button'; node.onclick = fn; return node; };
	const commandNodes = [...pane.childNodes];
	const root = make('div'); root.className = 'workbench'; pane.appendChild(root);
	const navigation = make('div', '', root); navigation.className = 'workbench-tabs'; navigation.setAttribute('role', 'tablist'); navigation.setAttribute('aria-label', 'Terminal views');
	const views = new Map(), tabs = new Map();
	let activeView = '';
	for (const [id, label] of [['commands','Commands'], ['shells','Shells'], ['actions','Actions']]) {
		const tab = button(label, navigation, () => showView(id)); tab.id = 'workbench-tab-' + id; tab.setAttribute('role', 'tab');
		const view = make('section', '', root); view.id = 'workbench-view-' + id; view.className = 'workbench-view workbench-' + id; view.setAttribute('role', 'tabpanel'); view.setAttribute('aria-labelledby', tab.id); view.hidden = true;
		tab.setAttribute('aria-controls', view.id); tabs.set(id, tab); views.set(id, view);
		tab.addEventListener('keydown', event => {
			const keys = [...tabs.keys()], index = keys.indexOf(id);
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : event.key === 'ArrowRight' ? (index + 1) % keys.length : event.key === 'ArrowLeft' ? (index + keys.length - 1) % keys.length : -1;
			if (next < 0) return; event.preventDefault(); showView(keys[next]); tabs.get(keys[next]).focus();
		});
	}
	views.get('commands').append(...commandNodes);
	const commandHint = document.getElementById('term-hint');
	if (commandHint) commandHint.textContent = 'Enter to run · ↑ ↓ history · Ctrl+C to stop';
	function showView(id, persist = true) {
		if (!views.has(id)) id = 'commands';
		activeView = id;
		for (const [key, view] of views) { view.hidden = key !== id; const tab = tabs.get(key); tab.setAttribute('aria-selected', String(key === id)); tab.tabIndex = key === id ? 0 : -1; }
		if (persist) B.patchState?.({ terminalView:id });
		if (id === 'shells') { B.post({ type:'ptyList' }); void showSession(); }
		if (id === 'actions') B.post({ type:'projectActionsList' });
	}
	const interactive = views.get('shells');
	const controls = make('div', '', interactive); controls.className = 'workbench-controls workbench-shell-toolbar';
	const promptMark = make('span', '>_', controls); promptMark.className = 'workbench-prompt-mark'; promptMark.setAttribute('aria-hidden', 'true');
	const select = make('select', '', controls); select.setAttribute('aria-label', 'Interactive terminal session');
	let focusNewTerminal = false;
	const newTerminal = button('New terminal', controls, () => { focusNewTerminal = true; B.post({ type:'ptyOpen' }); }); newTerminal.className = 'workbench-primary'; newTerminal.disabled = !!B.remote;
	const closeTerminal = button('Close terminal', controls, () => { if (select.value) B.post({ type:'ptyClose', id:select.value }); }); closeTerminal.disabled = !!B.remote;
	closeTerminal.textContent = '×'; closeTerminal.className = 'workbench-close-terminal'; closeTerminal.setAttribute('aria-label', 'Close terminal');
	closeTerminal.title = 'Close this shell and its running processes';
	const empty = make('div', '', interactive); empty.className = 'workbench-empty';
	make('span', '>_', empty).className = 'workbench-empty-glyph';
	make('strong', B.remote ? 'No shared terminals' : 'Your workspace shell', empty);
	make('p', B.remote ? 'Terminals opened on the desktop appear here.' : 'Open a terminal for interactive commands, development servers, and REPLs.', empty);
	const terminalBox = make('div', '', interactive); terminalBox.className = 'workbench-terminal'; terminalBox.hidden = true;
	const terminalFooter = make('div', '', interactive); terminalFooter.className = 'workbench-shell-footer';
	const terminalStatus = make('span', B.remote ? 'Read only' : 'No active session', terminalFooter); terminalStatus.className = 'workbench-shell-status'; terminalStatus.setAttribute('role', 'status');
	const dimensions = make('span', '', terminalFooter); dimensions.className = 'workbench-dimensions';
	const attachSelection = button('Attach selection', terminalFooter, () => {
		const entry = sessions.get(select.value), text = entry?.term?.getSelection()?.slice(0, 16000);
		if (!text) { terminalStatus.textContent = 'Select terminal output first (maximum 16,000 characters per attachment).'; return; }
		const range = entry.term.getSelectionPosition();
		const input = document.getElementById('input') || document.querySelector('textarea');
		if (!input) return;
		const context = `\n\n[Selected terminal output: ${entry.name}; session ${select.value}; lines ${(range?.start.y ?? 0) + 1}–${(range?.end.y ?? 0) + 1}]\n${text}\n[End terminal output]\n`;
		input.value += context; input.dispatchEvent(new Event('input', { bubbles:true })); input.focus();
	});
	attachSelection.title = 'Add selected terminal output to your prompt'; attachSelection.disabled = true;
	const cell = make('span', 'WWWWWWWWWW', root); cell.className = 'workbench-cell-measure'; cell.setAttribute('aria-hidden', 'true');
	const sessions = new Map();
	// xterm creates style elements through its documented documentOverride option.
	// Give only those elements the page nonce; keep the real document API unchanged.
	const nonce = document.querySelector('script[nonce]')?.nonce || '';
	const terminalDocument = new Proxy(document, { get(target, key) {
		if (key === 'createElement') return (tag, ...args) => { const node = target.createElement(tag, ...args); if (tag === 'style') node.nonce = nonce; return node; };
		const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
	} });
	let library;
	const loadTerminal = () => library || (library = new Promise((resolve, reject) => {
		if (window.Terminal) { resolve(); return; }
		const script = document.createElement('script'); script.src = '/media/terminal/xterm.min.js'; script.onload = resolve; script.onerror = () => { library = null; reject(new Error('Terminal renderer could not load.')); }; document.head.appendChild(script);
	}));
	const chrome = () => {
		const entry = sessions.get(select.value);
		empty.hidden = !!entry; terminalBox.hidden = !entry; select.disabled = !sessions.size;
		closeTerminal.disabled = !!B.remote || !entry || entry.closing;
		attachSelection.disabled = !entry?.term?.getSelection();
		terminalStatus.textContent = !entry ? B.remote ? 'Read only' : 'No active session' : entry.closed ? 'Session ended' : entry.closing ? 'Closing…' : B.remote ? 'Read only' : 'Connected';
		terminalStatus.dataset.state = entry && !entry.closed && !entry.closing ? 'connected' : 'idle';
		dimensions.textContent = entry?.term ? entry.term.cols + ' × ' + entry.term.rows : '';
	};
	const terminalTheme = () => {
		const style = getComputedStyle(terminalBox), accent = getComputedStyle(cell).color;
		const light = document.body.classList.contains('is-light');
		const colors = light ? ['#242424', '#a33530', '#286b36', '#765607', '#245f98', '#78458f', '#17686b', '#dedbd5', '#68635d', '#b5342e', '#26743a', '#826006', '#256da8', '#854b9d', '#12767b', '#ffffff'] : ['#262421', '#e0746a', '#7fb77e', '#d8b56a', '#9ab8d8', '#c4a0ce', '#82c1c1', '#d9d3ca', '#aaa397', '#f09286', '#a1ce99', '#ead091', '#b4ceeb', '#d8b5e2', '#a2dada', '#f4eee5'];
		const names = ['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
		const theme = Object.fromEntries(names.map((name, i) => [name, colors[i]]));
		return { ...theme, background:style.backgroundColor, foreground:style.color, cursor:accent, cursorAccent:style.backgroundColor, selectionBackground:light ? '#b9d1e8' : '#48596c', selectionInactiveBackground:light ? '#d3d8de' : '#3d4148', selectionForeground:light ? '#111111' : '#ffffff' };
	};
	const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
	const terminalOptions = () => {
		const style = getComputedStyle(cell), fontSize = parseFloat(style.fontSize) || 13;
		const reduced = motion?.matches || document.body.dataset.terminalScreenReader === 'true';
		return { theme:terminalTheme(), fontFamily:style.fontFamily, fontSize, lineHeight:(parseFloat(style.lineHeight) || fontSize * 1.3) / fontSize,
			cursorStyle:document.body.dataset.terminalCursor || 'block', cursorBlink:!reduced && document.body.dataset.terminalBlink !== 'off', smoothScrollDuration:reduced ? 0 : 90, screenReaderMode:document.body.dataset.terminalScreenReader === 'true' };
	};
	const resize = () => {
		// Hidden project views can be parked at 1×1; keep their shells at the last usable size.
		const entry = sessions.get(select.value); if (document.hidden || !entry?.term || activeView !== 'shells' || !terminalBox.clientWidth || !terminalBox.clientHeight) return;
		const measured = cell.getBoundingClientRect(), cellWidth = measured.width / 10 || 8, cellHeight = measured.height || 17;
		const cols = Math.max(10, Math.min(400, Math.floor((terminalBox.clientWidth - 24) / cellWidth)));
		const rows = Math.max(2, Math.min(200, Math.floor((terminalBox.clientHeight - 16) / cellHeight)));
		if (entry.term.cols !== cols || entry.term.rows !== rows) {
			entry.term.resize(cols, rows);
			if (!B.remote && !entry.closed && !entry.closing) B.post({ type:'ptyResize', id:select.value, cols, rows });
		}
		chrome();
	};
	let resizeTimer;
	if (window.ResizeObserver) {
		const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 60); });
		observer.observe(terminalBox); observer.observe(cell);
	}
	let writeFrame = 0;
	const flushWrites = () => {
		writeFrame = 0;
		for (const entry of sessions.values()) if (entry.term && (entry.pending || entry.redraw)) {
			if (entry.redraw) { entry.term.reset(); entry.term.write(entry.output); }
			else entry.term.write(entry.pending);
			entry.pending = ''; entry.redraw = false;
		}
	};
	const queueWrite = entry => {
		if (!entry.term || writeFrame) return;
		writeFrame = document.hidden ? setTimeout(flushWrites, 60) : requestAnimationFrame(flushWrites);
	};
	const showSession = async () => {
		for (const [id, entry] of sessions) entry.box.hidden = id !== select.value;
		chrome();
		const entry = sessions.get(select.value); if (!entry || activeView !== 'shells') return;
		try {
			await loadTerminal();
			if (select.value !== entry.id || activeView !== 'shells') return;
			if (!sessions.has(entry.id) || entry.term) { resize(); return; }
			entry.term = new window.Terminal({ ...terminalOptions(), documentOverride:terminalDocument, cols:100, rows:28, scrollback:5000, minimumContrastRatio:4.5, disableStdin:!!B.remote || entry.closed || entry.closing, convertEol:false });
			entry.term.open(entry.box); entry.term.write(entry.output);
			entry.pending = ''; entry.redraw = false;
			entry.term.onData(text => { if (!B.remote && !entry.closed && !entry.closing) B.post({ type:'ptyInput', id:entry.id, text }); });
			entry.term.onSelectionChange(chrome);
			resize();
			if (focusNewTerminal && !B.remote) { focusNewTerminal = false; entry.term.focus(); }
		} catch (error) { terminalStatus.textContent = error.message; }
	};
	select.onchange = () => void showSession();
	let themeSignature = '';
	const refreshOptions = () => {
		const options = terminalOptions(), signature = JSON.stringify(options);
		if (signature === themeSignature) return; themeSignature = signature;
		for (const entry of sessions.values()) if (entry.term) entry.term.options = options;
		resize();
	};
	if (window.MutationObserver) new MutationObserver(refreshOptions).observe(document.body, { attributes:true, attributeFilter:['class','style','data-theme','data-mode','data-terminal-cursor','data-terminal-blink','data-terminal-screen-reader'] });
	motion?.addEventListener?.('change', refreshOptions);
	window.addEventListener('pagehide', () => motion?.removeEventListener?.('change', refreshOptions));
	const project = views.get('actions');
	const actionsHead = make('div', '', project); actionsHead.className = 'workbench-actions-head';
	make('strong', 'Project actions', actionsHead);
	const stopAction = button('Stop action', actionsHead, () => B.post({ type:'projectActionStop' })); stopAction.disabled = true;
	const actionsStatus = make('p', 'Reusable commands for this workspace.', project); actionsStatus.className = 'workbench-action-status'; actionsStatus.setAttribute('role', 'status');
	const actionList = make('div', '', project); actionList.className = 'workbench-action-list';
	const configure = make('details', '', project); make('summary', 'Configure actions', configure);
	configure.className = 'workbench-configure';
	const editor = make('textarea', '', configure); editor.setAttribute('aria-label', 'Project actions JSON'); editor.spellcheck = false;
	editor.value = JSON.stringify([{ name:'Start app', command:'npm run dev', cwd:'.', previewUrl:'http://localhost:3000' }, { name:'Check project', command:'npm run check' }, { name:'Prepare worktree', command:'npm ci', prepareWorktree:true }], null, 2);
	let dirty = false; editor.oninput = () => { dirty = true; };
	const configControls = make('div', '', configure); configControls.className = 'workbench-controls';
	button('Save actions', configControls, () => B.post({ type:'projectActionsSave', json:editor.value })).disabled = !!B.remote;
	button('Import zer0ne.actions.json', configControls, () => B.post({ type:'projectActionsImport' })).disabled = !!B.remote;
	button('Refresh', configControls, () => B.post({ type:'projectActionsList' }));
	const actionOutput = make('pre', '', project); actionOutput.className = 'workbench-action-output'; actionOutput.setAttribute('aria-label', 'Project action output');
	let currentSession = '';
	window.addEventListener('message', event => {
		if (event.source !== null || event.origin !== '') return;
		const msg = event.data; if (!msg || typeof msg.type !== 'string') return;
		if (msg.type === 'ptySessions') {
			const keep = new Set(msg.sessions.map(s => s.id)), chosen = select.value, known = new Set(sessions.keys());
			for (const [id, entry] of sessions) if (!keep.has(id)) { entry.term?.dispose(); entry.box.remove(); sessions.delete(id); }
			select.replaceChildren();
			for (const snapshot of msg.sessions) {
				let entry = sessions.get(snapshot.id);
				if (!entry) { entry = { ...snapshot, box:make('div', '', terminalBox) }; sessions.set(snapshot.id, entry); }
				else if (snapshot.sequence > entry.sequence || entry.desynced) { entry.output = snapshot.output; entry.sequence = snapshot.sequence; entry.pending = ''; entry.redraw = true; entry.desynced = false; queueWrite(entry); }
				entry.closed = snapshot.closed; entry.closing = snapshot.closing; if (entry.term) entry.term.options.disableStdin = !!B.remote || entry.closed || entry.closing;
				const option = make('option', snapshot.name + (snapshot.closed ? ' (closed)' : snapshot.closing ? ' (closing)' : ''), select); option.value = snapshot.id;
			}
			const opened = focusNewTerminal ? msg.sessions.filter(s => !known.has(s.id)).at(-1) : undefined;
			select.value = opened?.id || (keep.has(chosen) ? chosen : msg.sessions.at(-1)?.id || '');
			void showSession();
		} else if (msg.type === 'ptyOutput') {
			const entry = sessions.get(msg.id); if (!entry) { B.post({ type:'ptyList' }); return; }
			if (msg.sequence <= entry.sequence) return;
			if (msg.sequence !== entry.sequence + 1) { if (!entry.desynced) { entry.desynced = true; B.post({ type:'ptyList' }); } return; }
			entry.sequence = msg.sequence; entry.output = (entry.output + msg.text).slice(-256 * 1024);
			if (entry.term) { entry.pending = (entry.pending || '') + msg.text; if (entry.pending.length > 256 * 1024) { entry.pending = ''; entry.redraw = true; } queueWrite(entry); }
		} else if (msg.type === 'projectActions') {
			if (typeof msg.output === 'string') actionOutput.textContent = msg.output;
			actionList.replaceChildren();
			for (const action of msg.actions) {
				const row = make('div', '', actionList), description = make('div', '', row); description.className = 'workbench-action-description'; make('strong', action.name, description); make('code', action.command, description);
				button('Run', row, () => { actionOutput.textContent = ''; B.post({ type:'projectActionRun', name:action.name }); }).disabled = !!B.remote || msg.running;
				if (action.previewUrl) button('Open preview', row, () => B.post({ type:'projectActionPreview', name:action.name })).disabled = !!B.remote;
				if (action.prepareWorktree) make('small', 'Prepare each new worktree before its task starts', row);
			}
			if (!msg.actions.length) { const message = make('div', '', actionList); message.className = 'workbench-action-empty'; make('strong', 'Your shortcuts live here', message); make('p', 'Save a build, check, or preview command under Configure actions.', message); }
			stopAction.disabled = !!B.remote || !msg.running;
			if (!dirty && msg.actions.length) editor.value = JSON.stringify(msg.actions, null, 2);
			actionsStatus.textContent = msg.running ? 'Project action running…' : msg.last.name ? msg.last.name + ': ' + msg.last.status : 'Actions run only when requested; new-worktree preparation asks permission before execution.';
		} else if (msg.type === 'projectActionOutput') actionOutput.textContent = (actionOutput.textContent + msg.text).slice(-256 * 1024);
		else if (msg.type === 'transportReady') { B.post({ type:'ptyList' }); B.post({ type:'projectActionsList' }); }
		else if (msg.type === 'transportRejected' && msg.action?.type === 'send') {
			const input = document.getElementById('input'); if (input && !input.value) { input.value = msg.action.text || ''; input.dispatchEvent(new Event('input', { bubbles:true })); }
		} else if (msg.type === 'state') {
			currentSession = msg.currentSessionId;
			const messages = document.getElementById('messages');
			if (messages && msg.historyWindow?.hasMore && !document.getElementById('history-more')) {
				const older = button('Load older messages', null, () => { older.disabled = true; B.post({ type:'historyMore', sessionId:currentSession }); }); older.id = 'history-more'; messages.prepend(older);
			}
			for (const restore of document.querySelectorAll('[data-restore]')) {
				restore.title = 'Restore files; retain the conversation. Commands and connected-system effects remain.';
				const label = restore.querySelector('span'); if (label) label.textContent = 'Restore files';
			}
			for (const actions of document.querySelectorAll('.msg.user .user-actions')) {
				const id = actions.closest('.msg.user')?.dataset.turnId;
				if (!id || !msg.messages?.some(message => message.id === id && !message.local)) continue;
				let rewind = actions.querySelector('[data-rewind]');
				if (!rewind) { rewind = button('Rewind in new chat', actions, () => B.post({ type:'rewindTo', id })); rewind.className = 'chip-btn'; rewind.dataset.rewind = id; }
				rewind.disabled = !!msg.isStreaming;
			}
		}
	});
	showView((B.getState?.() || {}).terminalView || 'commands', false);
	chrome();
	B.post({ type:'ptyList' }); B.post({ type:'projectActionsList' });
})();
