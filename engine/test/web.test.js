// Live check of the agent's browser tools (network required).
const web = require(require('path').join(__dirname, '..', 'out') + '/tools/web.js');
(async () => {
	const md = web.htmlToMarkdown('<html><head><title>T &amp; x</title></head><body><nav>menu</nav><h2>Hi</h2><p>Some <b>bold</b> <a href="/a">link</a></p><pre><code>x &lt; 1\n  y</code></pre><script>evil()</script></body></html>', 'https://e.com/p');
	console.log('--- htmlToMarkdown\n' + JSON.stringify(md));
	for (const engine of ['exa', 'duckduckgo']) {
		try {
			const r = await web.webSearch('vscode webview retainContextWhenHidden', { engine, count: 3 });
			console.log(`--- search (${engine} → used ${r.engine}) ${r.text.length} chars\n` + r.text.slice(0, 400));
		} catch (e) { console.log(`--- search ${engine} FAILED: ${e.message}`); }
	}
	try {
		const p = await web.webFetch('https://code.visualstudio.com/api/extension-guides/webview', 1500);
		console.log(`--- fetch: ${p.title} | ${p.url} | truncated=${p.truncated}\n${p.text.slice(0, 600)}`);
	} catch (e) { console.log('--- fetch FAILED: ' + e.message); }
})();
