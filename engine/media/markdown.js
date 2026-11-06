/*
 * Safe, dependency-free markdown renderer for chat messages.
 *
 * Everything is HTML-escaped before any markup is produced, so model
 * output can never inject elements or attributes. Links only become
 * clickable for http(s)/mailto (opened by the extension host), and
 * inline `path/to/file.ts:12` code spans open the file in the editor.
 *
 * Supports: fenced code (with highlighting, copy button; an unclosed
 * fence while streaming renders as code), headings, lists (nested,
 * ordered, task items), blockquotes, tables, hr, bold/italic/strike,
 * inline code, links and autolinks.
 */
(function () {
	'use strict';

	const svg = (d) => '<svg class="i" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
	const ALERT_ICON = {
		tip: svg('<path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5z"/>'),
		note: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.5v3.5M8 5h.01"/>'),
		important: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M8 5.5v2.5M8 9.5h.01"/>'),
		warning: svg('<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5h.01"/>'),
		caution: svg('<path d="M5.5 1.5h5l4 4v5l-4 4h-5l-4-4v-5z"/><path d="M8 5v3.5M8 10.5h.01"/>')
	};

	function esc(s) {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	// ---------------------------------------------------------------- highlighter

	const KW_JS = 'const|let|var|function|return|if|else|for|while|do|class|new|import|export|from|async|await|try|catch|finally|throw|typeof|instanceof|switch|case|break|continue|default|extends|super|this|null|undefined|true|false|of|in|interface|type|enum|implements|public|private|protected|readonly|static|as';
	const RULES = {
		js: [
			['com', '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'],
			['str', '`(?:\\\\[\\s\\S]|[^\\\\`])*`|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\''],
			['kw', '\\b(?:' + KW_JS + ')\\b'],
			['num', '\\b\\d+(?:\\.\\d+)?\\b'],
			['fn', '[A-Za-z_$][\\w$]*(?=\\s*\\()']
		],
		py: [
			['com', '#[^\\n]*'],
			['str', '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\''],
			['kw', '\\b(?:def|class|import|from|return|if|elif|else|for|while|try|except|finally|with|as|lambda|pass|raise|yield|True|False|None|self|and|or|not|in|is|async|await)\\b'],
			['num', '\\b\\d+(?:\\.\\d+)?\\b'],
			['fn', '[A-Za-z_]\\w*(?=\\s*\\()']
		],
		c: [
			['com', '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'],
			['str', '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\''],
			['kw', '\\b(?:int|char|float|double|void|bool|long|short|unsigned|struct|class|public|private|protected|static|const|return|if|else|for|while|do|switch|case|break|continue|new|delete|namespace|using|template|typename|fn|let|mut|impl|pub|use|mod|match|func|package|import|var|type|interface|go|defer|true|false|null|nil|None|self|string)\\b'],
			['num', '\\b\\d+(?:\\.\\d+)?\\b'],
			['fn', '[A-Za-z_]\\w*(?=\\s*\\()']
		],
		markup: [
			['com', '<!--[\\s\\S]*?-->'],
			['str', '"[^"\\n]*"|\'[^\'\\n]*\''],
			['kw', '</?[A-Za-z][\\w:-]*|/?>']
		],
		css: [
			['com', '\\/\\*[\\s\\S]*?\\*\\/'],
			['str', '"[^"\\n]*"|\'[^\'\\n]*\''],
			['fn', '[\\w-]+(?=\\s*:)'],
			['kw', '[.#][A-Za-z][\\w-]*|@[\\w-]+'],
			['num', '\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|vh|vw|s|ms)?\\b']
		],
		sh: [
			['com', '(?:^|\\s)#[^\\n]*'],
			['str', '"(?:\\\\.|[^"\\\\])*"|\'[^\']*\''],
			['kw', '\\b(?:npm|npx|pnpm|yarn|node|git|cd|ls|echo|sudo|curl|mkdir|rm|cp|mv|cat|pip|python|docker|chmod|export|source|if|then|fi|for|do|done|Get-ChildItem|Set-Location|Remove-Item)\\b'],
			['num', '(?:^|\\s)--?[A-Za-z][\\w-]*'],
			['fn', '\\$[\\w{}]+']
		]
	};
	const COMPILED = {};

	function family(lang) {
		const l = (lang || '').toLowerCase();
		if (/^(js|ts|jsx|tsx|javascript|typescript|mjs|cjs|json|jsonc)$/.test(l)) return 'js';
		if (/^(py|python)$/.test(l)) return 'py';
		if (/^(c|h|cpp|c\+\+|cc|hpp|cs|csharp|java|kotlin|kt|go|rust|rs|swift|php|dart|scala)$/.test(l)) return 'c';
		if (/^(html|xml|svg|vue|svelte)$/.test(l)) return 'markup';
		if (/^(css|scss|less)$/.test(l)) return 'css';
		if (/^(sh|bash|shell|zsh|console|cmd|bat|ps|ps1|powershell|pwsh)$/.test(l)) return 'sh';
		return null;
	}

	function highlight(code, lang) {
		const fam = family(lang);
		if (!fam || code.length > 60000) {
			return esc(code);
		}
		const rules = RULES[fam];
		const master = (COMPILED[fam] = COMPILED[fam] || new RegExp(rules.map((r) => '(' + r[1] + ')').join('|'), 'gm'));
		master.lastIndex = 0;
		let out = '';
		let last = 0;
		let m;
		while ((m = master.exec(code)) !== null) {
			if (!m[0].length) {
				master.lastIndex++;
				continue;
			}
			out += esc(code.slice(last, m.index));
			const g = m.slice(1).findIndex((x) => x !== undefined);
			out += '<span class="tok-' + rules[g][0] + '">' + esc(m[0]) + '</span>';
			last = m.index + m[0].length;
		}
		return out + esc(code.slice(last));
	}

	// ---------------------------------------------------------------- inline

	const FILE_REF = /^(?:\.{0,2}\/)?[\w@.-]+(?:[\\/][\w@.-]+)*\.[A-Za-z0-9]{1,8}(?::(\d+)(?::\d+)?)?$/;

	/** True while rendering a user bubble: @path mentions become chips. */
	let mentionMode = false;
	const fileIcon = () => (window.Icons ? window.Icons.svg('file') : '');

	/** A markdown link target that points at a workspace file: path, ./path, file:///abs, with optional #L12 / :12. */
	function fileTarget(url) {
		if (/^[a-z][a-z0-9+.-]+:/i.test(url) && !/^file:/i.test(url)) return undefined;
		if (url.startsWith('#')) return undefined;
		let p = url.replace(/^file:\/\/\/?/i, '');
		try {
			p = decodeURIComponent(p);
		} catch {
			// keep as is
		}
		const m = p.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?)$/);
		const line = m ? m[2] || m[3] : undefined;
		if (m) p = m[1];
		if (!/[\w-]\.[A-Za-z0-9]{1,8}$|[\\/]/.test(p)) return undefined;
		return { path: p, line };
	}

	function inline(text) {
		const slots = [];
		const hold = (html) => '\u0001' + (slots.push(html) - 1) + '\u0001';
		let s = text;

		// code spans first — their content is literal
		s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => {
			const c = code.trim();
			const ref = c.match(FILE_REF);
			if (ref && /[\\/.]/.test(c) && !/^\d/.test(c) && !/^https?:/.test(c)) {
				const path = c.replace(/:\d+(?::\d+)?$/, '');
				return hold('<code class="file-ref" data-open="' + esc(path) + '"' + (ref[1] ? ' data-line="' + ref[1] + '"' : '') + ' title="Open file">' + esc(c) + '</code>');
			}
			return hold('<code>' + esc(c) + '</code>');
		});
		// [text](url)
		s = s.replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label, url) => {
			if (/^(https?:|mailto:)/i.test(url)) {
				return hold('<a class="md-link" href="#" data-href="' + esc(url) + '" title="' + esc(url) + '">' + inlineBasic(esc(label)) + '</a>');
			}
			const f = fileTarget(url);
			if (f) {
				return hold('<a class="file-link" href="#" data-open="' + esc(f.path) + '"' + (f.line ? ' data-line="' + f.line + '"' : '') + ' title="' + esc(f.path + (f.line ? ':' + f.line : '')) + '">' + fileIcon() + '<span>' + inlineBasic(esc(label.replace(/^`|`$/g, ''))) + '</span></a>');
			}
			return esc(label);
		});
		// bare URLs
		s = s.replace(/\bhttps?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?]/g, (url) =>
			hold('<a class="md-link" href="#" data-href="' + esc(url) + '" title="' + esc(url) + '">' + esc(url) + '</a>')
		);
		// @file mentions (user messages only)
		if (mentionMode) {
			s = s.replace(/(^|[\s(])@([\w.\-/\\]*[\w/])/g, (_m, pre, p) =>
				pre + hold('<span class="mention" data-open="' + esc(p) + '" title="' + esc(p) + '">' + fileIcon() + '<span>' + esc(p.split(/[\\/]/).filter(Boolean).pop() || p) + '</span></span>')
			);
		}
		s = inlineBasic(esc(s));
		return s.replace(/\u0001(\d+)\u0001/g, (_m, i) => slots[Number(i)]);
	}

	/** Emphasis on already-escaped text. */
	function inlineBasic(s) {
		return s
			.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
			.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
			.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
			.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>')
			.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
	}

	// ---------------------------------------------------------------- blocks

	const RE = {
		fence: /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/,
		heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
		hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
		quote: /^\s{0,3}>\s?/,
		list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
		tableSep: /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/
	};

	function isBlockStart(line, next) {
		return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.list.test(line) || (line.includes('|') && next !== undefined && RE.tableSep.test(next));
	}

	function splitRow(line) {
		let row = line.trim();
		if (row.startsWith('|')) row = row.slice(1);
		if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
		return row.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
	}

	function codeBlock(lang, code, open) {
		// Mermaid diagrams: the source block is shown until chat.js renders it.
		if (/^mermaid$/i.test(lang)) {
			return '<div class="mermaid-block" data-src="' + esc(code) + '">' + codeBlockHtml(lang, code, open) + '</div>';
		}
		return codeBlockHtml(lang, code, open);
	}

	const LANG_NAMES = {
		js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', javascript: 'JavaScript', typescript: 'TypeScript',
		py: 'Python', python: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', rust: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', csharp: 'C#', cpp: 'C++', 'c++': 'C++', c: 'C', h: 'C',
		php: 'PHP', swift: 'Swift', dart: 'Dart', scala: 'Scala', html: 'HTML', xml: 'XML', svg: 'SVG', vue: 'Vue', svelte: 'Svelte', css: 'CSS', scss: 'SCSS', less: 'Less',
		json: 'JSON', jsonc: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', md: 'Markdown', markdown: 'Markdown', sql: 'SQL', graphql: 'GraphQL',
		sh: 'Shell', bash: 'Bash', zsh: 'Zsh', shell: 'Shell', console: 'Console', ps1: 'PowerShell', powershell: 'PowerShell', pwsh: 'PowerShell', bat: 'Batch', cmd: 'Batch',
		dockerfile: 'Dockerfile', diff: 'Diff', text: 'Plain text', txt: 'Plain text', plaintext: 'Plain text', mermaid: 'Mermaid'
	};
	const COPY_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6H5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
	const WRAP_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h9.5a2.25 2.25 0 010 4.5H8m0 0l1.6-1.6M8 12.5l1.6 1.6M2 12h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	function codeBlockHtml(lang, code, open) {
		const raw = (lang || '').replace(/[{].*$/, '');
		// ```ts:src/app.ts or ```ts title="src/app.ts" → a file label.
		const file = (/^[\w+#.-]+:(\S+)$/.exec(lang || '') || /title="([^"]+)"/.exec(lang || '') || [])[1];
		const id = raw.split(':')[0].toLowerCase();
		const name = LANG_NAMES[id] || (id ? id : 'Plain text');
		const lines = code ? code.split('\n').length : 0;
		return (
			'<div class="code-block' + (lines > 28 ? ' long' : '') + '" data-lang="' + esc(family(id) || id || 'text') + '"' + (open ? ' data-open="1"' : '') + '>' +
			'<div class="code-head"><span class="code-lang"><span class="code-dot"></span>' + esc(name) + (file ? '<span class="code-file">' + esc(file) + '</span>' : '') +
			(open ? '<span class="code-writing">· writing</span>' : '') + '</span>' +
			'<span class="code-actions">' + (lines > 1 ? '<span class="code-lines">' + lines + ' lines</span>' : '') +
			'<button class="code-btn icon-only" data-wrap-code aria-label="Toggle word wrap" aria-pressed="false" title="Toggle word wrap">' + WRAP_SVG + '</button>' +
			'<button class="code-btn" data-copy-code title="Copy code">' + COPY_SVG + '<span>Copy</span></button></span></div>' +
			'<pre><code>' + highlight(code, lang) + '</code></pre>' +
			(lines > 28 ? '<button class="code-expand" data-expand-code aria-expanded="false">Show all ' + lines + ' lines</button>' : '') +
			'</div>'
		);
	}

	function renderList(items) {
		let html = '';
		const stack = [];
		for (const item of items) {
			while (stack.length && item.indent < stack[stack.length - 1].indent) {
				html += '</li></' + stack.pop().tag + '>';
			}
			const top = stack[stack.length - 1];
			let body = item.text;
			let cls = '';
			const task = body.match(/^\[([ xX])\]\s+(.*)$/);
			if (task) {
				cls = ' class="task' + (task[1] !== ' ' ? ' done' : '') + '"';
				body = '<span class="task-box">' + (task[1] !== ' ' ? '✓' : '') + '</span>' + inline(task[2]);
			} else {
				body = inline(body);
			}
			if (!top || item.indent > top.indent) {
				const tag = item.ordered ? 'ol' : 'ul';
				html += '<' + tag + (item.ordered && item.start !== 1 ? ' start="' + item.start + '"' : '') + '><li' + cls + '>' + body;
				stack.push({ indent: item.indent, tag });
			} else {
				html += '</li><li' + cls + '>' + body;
			}
		}
		while (stack.length) {
			html += '</li></' + stack.pop().tag + '>';
		}
		return html;
	}

	function render(src, opts) {
		if (opts && opts.mentions) {
			mentionMode = true;
			try {
				return render(src);
			} finally {
				mentionMode = false;
			}
		}
		const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
		let out = '';
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (!line.trim()) {
				i++;
				continue;
			}
			let m;
			// fenced code (unclosed fence = rest of the message, for streaming)
			if ((m = line.match(RE.fence))) {
				const marker = m[1];
				const lang = m[2];
				const close = new RegExp('^\\s{0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
				const body = [];
				i++;
				while (i < lines.length && !close.test(lines[i])) {
					body.push(lines[i]);
					i++;
				}
				// No closing fence yet: the block is still being written.
				const open = i >= lines.length;
				if (!open) i++;
				out += codeBlock(lang, body.join('\n'), open);
				continue;
			}
			if ((m = line.match(RE.heading))) {
				const level = Math.min(6, m[1].length);
				out += '<h' + level + '>' + inline(m[2]) + '</h' + level + '>';
				i++;
				continue;
			}
			if (RE.hr.test(line)) {
				out += '<hr>';
				i++;
				continue;
			}
			if (RE.quote.test(line)) {
				const body = [];
				while (i < lines.length && lines[i].trim() && (RE.quote.test(lines[i]) || !isBlockStart(lines[i], lines[i + 1]))) {
					body.push(lines[i].replace(RE.quote, ''));
					i++;
				}
				// GitHub alerts: > [!TIP] / [!NOTE] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
				const alert = /^\s*\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(body[0] || '');
				if (alert) {
					const kind = alert[1].toLowerCase();
					out += '<div class="md-alert md-alert-' + kind + '" role="note"><div class="md-alert-title">' + ALERT_ICON[kind] + '<span>' + alert[1].toUpperCase() + '</span></div>' + render(body.slice(1).join('\n')) + '</div>';
					continue;
				}
				out += '<blockquote>' + render(body.join('\n')) + '</blockquote>';
				continue;
			}
			if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
				const head = splitRow(line);
				const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : ''));
				i += 2;
				let rows = '';
				while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
					const cells = splitRow(lines[i]);
					rows += '<tr>' + head.map((_h, c) => '<td' + (aligns[c] ? ' class="al-' + aligns[c] + '"' : '') + '>' + inline(cells[c] || '') + '</td>').join('') + '</tr>';
					i++;
				}
				out +=
					'<div class="table-wrap"><table><thead><tr>' +
					head.map((h, c) => '<th' + (aligns[c] ? ' class="al-' + aligns[c] + '"' : '') + '>' + inline(h) + '</th>').join('') +
					'</tr></thead><tbody>' + rows + '</tbody></table></div>';
				continue;
			}
			if (RE.list.test(line)) {
				const items = [];
				while (i < lines.length) {
					const l = lines[i];
					const lm = l.match(RE.list);
					if (lm) {
						items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), start: parseInt(lm[2], 10) || 1, text: lm[3] });
						i++;
					} else if (l.trim() && items.length && !isBlockStart(l, lines[i + 1])) {
						items[items.length - 1].text += '\n' + l.trim(); // continuation line
						i++;
					} else if (!l.trim() && i + 1 < lines.length && RE.list.test(lines[i + 1])) {
						i++; // loose list: blank line between items
					} else {
						break;
					}
				}
				out += renderList(items.map((it) => ({ ...it, text: it.text })));
				continue;
			}
			// paragraph
			const para = [];
			while (i < lines.length && lines[i].trim() && (para.length === 0 || !isBlockStart(lines[i], lines[i + 1]))) {
				para.push(lines[i]);
				i++;
			}
			out += '<p>' + para.map((p) => inline(p)).join('<br>') + '</p>';
		}
		return out;
	}

	function partialSource(source) {
		const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
		let fence = null;
		for (const line of lines) {
			if (fence) { if (new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$').test(line)) fence = null; }
			else { const match = line.match(RE.fence); if (match) fence = match[1]; }
		}
		if (fence) return lines.join('\n');
		let tail = lines.pop() || '';
		if (/^\s*(#{1,6}|[-*+>]|[-*_]{2}|\d{1,9}[.)]?|`{1,2}|~{1,2}|\|)\s*$/.test(tail)) return lines.join('\n');
		// A partial URL stays text until its closing parenthesis arrives.
		tail = tail.replace(/\[([^\]\n]*)\]\([^\)\n]*$/, '$1').replace(/\[([^\]\n]*)\]?$/, '$1');
		const stack = [];
		for (let i = 0; i < tail.length; i++) {
			if (tail[i] === '\\') { i++; continue; }
			const marker = tail[i] === '`' ? '`' : tail.startsWith('**', i) || tail.startsWith('__', i) ? tail.slice(i, i + 2) : /[*_]/.test(tail[i]) ? tail[i] : '';
			if (!marker || stack.at(-1) === '`' && marker !== '`' || marker === '_' && stack.at(-1) !== marker && /\w/.test(tail[i - 1] || '')) continue;
			if (stack.at(-1) === marker) stack.pop(); else if (/\S/.test(tail[i + marker.length] || '')) stack.push(marker);
			i += marker.length - 1;
		}
		const space = tail.match(/\s*$/)[0];
		lines.push(tail.slice(0, tail.length - space.length) + stack.reverse().join('') + space);
		return lines.join('\n');
	}

	const painted = new WeakMap();
	const sameNode = (a, b) => a && a.nodeType === b.nodeType && a.nodeName === b.nodeName && ['data-copy-code', 'data-wrap-code', 'data-expand-code'].every(key => a.nodeType !== 1 || a.hasAttribute(key) === b.hasAttribute(key));
	function patchNode(node, next) {
		if (node.nodeType === 3) { if (node.data !== next.data) node.data = next.data; return; }
		if (node.nodeType !== 1) return;
		// Copy feedback, keyboard focus and the user's code controls outlive incoming chunks.
		if (node.matches('[data-copy-code], [data-wrap-code]') || node.matches('[data-expand-code]') && node.closest('.code-block.open')) return;
		const keep = ['stream-block', 'stream-enter', ...(node.classList.contains('code-block') ? ['wrap', 'open'] : [])].filter(cls => node.classList.contains(cls));
		for (const attr of [...node.attributes]) if (attr.name !== 'class' && !next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
		for (const attr of [...next.attributes]) if (attr.name !== 'class' && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
		const classes = [...new Set([...(next.getAttribute('class') || '').split(/\s+/).filter(Boolean), ...keep])].join(' ');
		if (node.className !== classes) node.className = classes;
		let cursor = node.firstChild;
		for (const child of [...next.childNodes]) {
			if (sameNode(cursor, child)) { patchNode(cursor, child); cursor = cursor.nextSibling; }
			else {
				const match = [...node.childNodes].slice(cursor ? [...node.childNodes].indexOf(cursor) : node.childNodes.length).find(candidate => sameNode(candidate, child));
				if (match) { node.insertBefore(match, cursor); patchNode(match, child); }
				else node.insertBefore(child.cloneNode(true), cursor);
			}
		}
		while (cursor) { const after = cursor.nextSibling; cursor.remove(); cursor = after; }
	}

	/** Completed blocks keep their DOM, selection and code controls while only the tail changes. */
	function paint(root, source, options = {}) {
		for (const caret of root.querySelectorAll('.ans-caret, .ans-caret-line')) caret.remove();
		const template = document.createElement('template');
		template.innerHTML = render(options.streaming ? partialSource(source) : source);
		const previous = [...root.children];
		let index = 0;
		for (const next of [...template.content.children]) {
			const html = next.outerHTML;
			let node = previous[index];
			if (sameNode(node, next)) { if (painted.get(node) !== html) patchNode(node, next); }
			else {
				const replacement = next.cloneNode(true);
				if (node) node.replaceWith(replacement); else root.appendChild(replacement);
				node = replacement;
				if (options.streaming && options.animate !== false) node.classList.add('stream-enter');
			}
			if (!node.classList.contains('stream-block')) node.classList.add('stream-block');
			painted.set(node, html); index++;
		}
		for (const old of previous.slice(index)) old.remove();
		root.setAttribute('aria-busy', String(!!options.streaming));
	}

	window.Markdown = { render, paint, escape: esc, highlight };
})();
