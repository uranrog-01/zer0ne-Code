/** References belong to a document and an exact node; never retarget a removed node by selector. */
export function snapshotScript(firstRef: number, limit: number): string {
	return `(() => {
		const state = window.__zSnapshotRefs ||= { nodes: new Map(), ids: new WeakMap() };
		for (const [id, node] of state.nodes) if (!node.isConnected) state.nodes.delete(id);
		const selectors = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[contenteditable=""],[contenteditable=true],[onclick],summary';
		const roots = [document], lines = [], refs = [], texts = [];
		let next = ${firstRef};
		for (let i = 0; i < roots.length && i < 100; i++) {
			const root = roots[i];
			for (const host of root.querySelectorAll('*')) if (host.shadowRoot) roots.push(host.shadowRoot);
			if (i) texts.push(root.textContent || '');
			for (const el of root.querySelectorAll(selectors)) {
				if (refs.length >= ${limit}) break;
				const r = el.getBoundingClientRect(), css = getComputedStyle(el);
				if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth || css.visibility === 'hidden' || css.display === 'none' || Number(css.opacity) === 0) continue;
				let id = state.ids.get(el);
				if (!id) { id = ++next; state.ids.set(el, id); }
				state.nodes.set(id, el); refs.push(id);
				const tag = el.tagName.toLowerCase(), type = el.getAttribute('type') || '';
				const label = (el.getAttribute('aria-label') || [...(el.labels || [])].map(l => l.innerText).join(' ') || (tag === 'input' || tag === 'textarea' ? '' : el.innerText) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
				const value = ['input','textarea','select'].includes(tag) && el.value && type !== 'password' ? ' value=' + JSON.stringify(String(el.value).slice(0, 60)) : '';
				lines.push('[' + id + '] ' + tag + (type ? '[' + type + ']' : '') + ' ' + JSON.stringify(label) + value + (el.disabled ? ' (disabled)' : el.checked ? ' (checked)' : ''));
			}
		}
		return { url: location.href, title: document.title, elements: lines.join('\\n'),
			text: [(document.body?.innerText || ''), ...texts].join('\\n').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000),
			scroll: Math.round(scrollY) + '/' + Math.max(0, document.documentElement.scrollHeight - innerHeight) + 'px',
			refs, next, truncated: refs.length >= ${limit} || roots.length > 100 };
	})()`;
}

export function nodeExpression(ref: number): string {
	if (!Number.isSafeInteger(ref) || ref < 1) throw new Error('Use a positive integer ref from a browser snapshot.');
	return `window.__zSnapshotRefs?.nodes.get(${ref})`;
}

export function pointScript(ref: number): string {
	return `(() => {
		const el = ${nodeExpression(ref)};
		if (!el?.isConnected) throw new Error('Stale element ref. Take a new browser_snapshot.');
		if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('The element is disabled.');
		el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
		const r = el.getBoundingClientRect(), css = getComputedStyle(el);
		if (r.width < 2 || r.height < 2 || css.visibility === 'hidden' || css.display === 'none' || Number(css.opacity) === 0) throw new Error('The element is not visible.');
		const x = Math.max(0, r.left) + (Math.min(innerWidth, r.right) - Math.max(0, r.left)) / 2;
		const y = Math.max(0, r.top) + (Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) / 2;
		const hit = el.getRootNode().elementFromPoint(x, y);
		if (!hit || (hit !== el && !el.contains(hit))) throw new Error('The element is covered. Take a new snapshot after dismissing the overlay.');
		return { x, y, name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 60) };
	})()`;
}
