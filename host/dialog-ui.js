(function () {
	'use strict';
	const queue = new Map();
	let active;
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(`
	.zc-dialog { width:min(460px, calc(100vw - 40px)); max-height:calc(100vh - 48px); padding:0; border:1px solid var(--color-border-strong,#444); border-radius:14px; background:var(--color-panel,#18181b); color:var(--color-foreground,#fafafa); box-shadow:0 20px 70px #0008; font:13px/1.5 var(--font-sans,system-ui); }
	.zc-dialog::backdrop { background:#0007; }
	.zc-dialog form { display:flex; flex-direction:column; max-height:calc(100vh - 50px); padding:20px; gap:14px; }
	.zc-dialog h2 { margin:0; font-size:16px; font-weight:600; }
	.zc-dialog p { margin:0; color:var(--color-foreground-muted,#aaa); white-space:pre-wrap; }
	.zc-dialog input[type=text],.zc-dialog input[type=password] { width:100%; box-sizing:border-box; padding:9px 10px; border:1px solid var(--color-border-strong,#444); border-radius:7px; background:var(--color-background,#111); color:inherit; font:inherit; }
	.zc-dialog input:focus-visible,.zc-dialog button:focus-visible { outline:2px solid var(--accent,#f7931e); outline-offset:2px; }
	.zc-dialog-list { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:4px; }
	.zc-dialog-item { display:flex; align-items:flex-start; gap:10px; padding:9px; border-radius:7px; cursor:pointer; }
	.zc-dialog-item:hover { background:var(--color-secondary,#333); }
	.zc-dialog-item div { min-width:0; overflow-wrap:anywhere; }
	.zc-dialog-item small { display:block; color:var(--color-foreground-muted,#aaa); }
	.zc-dialog-foot { display:flex; justify-content:flex-end; gap:8px; }
	.zc-dialog button { border:1px solid var(--color-border-strong,#444); border-radius:7px; padding:7px 13px; background:var(--color-secondary,#333); color:inherit; font:inherit; cursor:pointer; }
	.zc-dialog button[type=submit] { background:var(--accent,#f7931e); color:var(--color-background,#111); border-color:transparent; font-weight:600; }
	.zc-dialog a { color:var(--accent-strong,#f7931e); }
	.zc-dialog.zc-viewer { width:min(1100px, calc(100vw - 40px)); }
	.zc-dialog iframe { width:100%; height:70vh; border:0; background:white; }
	.zc-review { overflow:auto; min-height:0; }
	.zc-review-columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
	.zc-review-columns pre { padding:10px; background:var(--color-background,#111); border:1px solid #555; }
	.zc-dialog pre { overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; min-height:120px; margin:0; font:12px/1.6 monospace; }
	`);
	document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	const node = (tag, text, cls) => { const el = document.createElement(tag); if (text) el.textContent = text; if (cls) el.className = cls; return el; };
	function next() {
		if (active || !queue.size) return;
		const [id, options] = queue.entries().next().value;
		const previous = document.activeElement;
		const dialog = node('dialog', '', 'zc-dialog');
		if (['artifact','review','report'].includes(options.kind)) dialog.classList.add('zc-viewer');
		active = { id, dialog };
		const form = node('form'); const heading = node('h2', options.title || 'Choose'); heading.id = 'zc-dialog-title';
		dialog.setAttribute('aria-labelledby', heading.id); form.appendChild(heading);
		if (options.prompt) form.appendChild(node('p', options.prompt));
		const finish = value => {
			window.Bridge.post({ type: 'zcPromptReply', id, value });
			dialog.close(); dialog.remove(); queue.delete(id); active = undefined;
			if (previous?.isConnected) previous.focus(); next();
		};
		let input;
		let selected = new Set();
		if (options.kind === 'pick') {
			input = node('input'); input.type = 'text'; input.placeholder = options.placeholder || 'Filter choices'; input.setAttribute('aria-label', 'Filter choices'); form.appendChild(input);
			const list = node('div', '', 'zc-dialog-list');
			const render = () => {
				list.replaceChildren();
				options.items.forEach((item, index) => {
					if (item.disabled || ![item.label,item.description,item.detail].join(' ').toLowerCase().includes(input.value.toLowerCase())) return;
					const label = node('label', '', 'zc-dialog-item');
					const control = node('input'); control.type = options.many ? 'checkbox' : 'radio'; control.name = 'choice'; control.checked = selected.has(index);
					control.onchange = () => { if (!options.many) selected.clear(); if (control.checked) selected.add(index); else selected.delete(index); };
					const body = node('div'); body.appendChild(node('span', item.label));
					if (item.description) body.appendChild(node('small', item.description)); if (item.detail) body.appendChild(node('small', item.detail));
					label.append(control,body); list.appendChild(label);
				});
				if (!list.children.length) list.appendChild(node('p','No matching choices.'));
			}; input.oninput = render; render(); form.appendChild(list);
		} else if (options.kind === 'artifact') {
			const frame = node('iframe'); frame.setAttribute('sandbox','allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.title = options.title || 'Artifact preview'; frame.src = options.url; form.appendChild(frame); input = frame;
		} else if (options.kind === 'review') {
			const list = node('div','','zc-review');
			for (const file of options.files || []) {
				list.appendChild(node('h3',file.path));
				const columns = node('div','','zc-review-columns');
				for (const [label,value] of [['Before',file.before],['Current',file.after]]) {
					const column = node('div'); column.append(node('h4',label),node('pre',value === null ? '(file absent)' : value || '(empty file)')); columns.appendChild(column);
				} list.appendChild(columns);
			} form.appendChild(list); input = list; input.tabIndex = 0;
		} else if (options.kind === 'log' || options.kind === 'report') {
			const log = node('pre', options.content || 'No diagnostics yet.'); log.tabIndex = 0; form.appendChild(log); input = log;
		} else {
			input = node('input'); input.type = options.password ? 'password' : 'text'; input.value = options.value || ''; input.placeholder = options.placeholder || ''; input.autocomplete = 'off'; input.setAttribute('aria-label', options.prompt || options.title || 'Value'); form.appendChild(input);
			if (options.link) { const link = node('a', options.linkLabel || 'Create a token'); link.href = options.link; link.onclick = e => { e.preventDefault(); window.Bridge.post({type:'openExternal',url:options.link}); }; form.appendChild(link); }
		}
		const foot = node('div', '', 'zc-dialog-foot'); const cancel = node('button', ['log','report','review','artifact'].includes(options.kind) ? 'Close' : 'Cancel'); cancel.type = 'button'; cancel.onclick = () => finish(undefined);
		const submit = node('button', options.accept || 'Continue'); submit.type = 'submit'; foot.append(cancel,submit); form.appendChild(foot);
		if (['log','report','review','artifact'].includes(options.kind)) submit.remove();
		if (options.kind === 'report') {
			for (const [label,action] of [['Copy','copy'],['Save…','save']]) {
				const button = node('button',label); button.type = 'button'; button.onclick = () => window.Bridge.post({ type:'zcReportAction', id, action }); foot.prepend(button);
			}
		}
		form.onsubmit = e => { e.preventDefault(); if (options.kind === 'pick') { if (!selected.size && !options.many) return; finish(options.many ? [...selected] : [...selected][0]); } else finish(input.value); };
		dialog.oncancel = e => { e.preventDefault(); finish(undefined); }; dialog.appendChild(form); document.body.appendChild(dialog); dialog.showModal(); input.focus();
	}
	window.addEventListener('message', e => {
		const m = e.data;
		if (m?.type === 'zcCheckpointReview') { queue.set(-Date.now(), {kind:'review',title:'Checkpoint changes',files:m.files}); next(); }
		if (m?.type === 'zcPrompt') { queue.set(m.id,m.options); next(); }
		if (m?.type === 'zcPromptClose') { queue.delete(m.id); if (active?.id === m.id) { active.dialog.close(); active.dialog.remove(); active = undefined; next(); } }
	});
})();
