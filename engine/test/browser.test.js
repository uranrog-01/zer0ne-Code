// Drives real Chrome through out/tools/browser.js against a local fixture page (npm run test:live).
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');
const { BrowserAgent } = require(require('path').join(__dirname, '..', 'out') + '/tools/browser.js');
const dir = path.join(os.tmpdir(), 'zer0ne-browser-test');
const lab = fs.readFileSync(path.join(__dirname, 'fixtures', 'browser-lab.html'));
const server = http.createServer((req, res) => (req.url.split('?')[0] === '/browser-lab.html' ? res.writeHead(200, { 'Content-Type': 'text/html' }).end(lab) : res.writeHead(404).end()));
(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = 'localhost:' + server.address().port;
	const agent = new BrowserAgent(dir, () => ({ path: '', headless: process.env.HEADLESS === '1' }));
	try {
		let s;
		const ok = (cond, label) => {
			if (!cond) throw new Error('check failed: ' + label);
			console.log('  ✓ ' + label);
		};
		const refOf = (snap, re) => Number((snap.elements.split('\n').find((l) => re.test(l)) || '').match(/\[(\d+)\]/)?.[1]);
		s = await agent.navigate(origin + '/browser-lab.html');
		s = await agent.select(refOf(s, /select/), 'Large');
		ok(s.text.includes('picked l'), 'select by label');
		s = await agent.click({ ref: refOf(s, /Show alert/) });
		ok(s.text.includes('alert closed') && /dialog alert\] Hello from alert/.test(agent.consoleLogs(false)), 'alert does not hang, is logged');
		s = await agent.hover(refOf(s, /"Menu"/));
		ok(s.text.includes('Hidden menu item'), 'hover opens the menu');
		s = await agent.click({ ref: refOf(s, /Load later/) });
		s = await agent.waitFor({ text: 'Loaded late', seconds: 5 });
		ok(s.text.includes('Loaded late'), 'wait_for text');
		s = await agent.type(refOf(s, /"Field"/), 'abc', { clear: true });
		await agent.press('Control+a', false);
		await agent.press('Backspace', false);
		ok((await agent.evaluate('document.getElementById("field").value')) === '', 'Control+a then Backspace clears');
		s = await agent.resize({ preset: 'mobile' });
		ok((await agent.evaluate('innerWidth')) === '390', 'mobile viewport');
		s = await agent.resize({ preset: 'desktop' });
		ok(/404 GET .*missing-endpoint/.test(agent.networkLog(true, false)), 'network log shows the 404');
		s = await agent.click({ ref: refOf(s, /Open in new tab/) });
		ok(s.url.includes('tab=2'), 'a link to a new tab is followed');
		const tabs = await agent.tabs('list');
		ok(tabs.split('\n').length >= 2 && /\(current\).*tab=2/.test(tabs), 'tabs listed, current marked');
		s = await agent.tabs('select', tabs.split('\n').findIndex((l) => !/tab=2/.test(l) && /Browser lab/.test(l)));
		ok(!s.url.includes('tab=2'), 'switched back to the first tab');
		s = await agent.reload();
		ok(s.title === 'Browser lab', 'reload');
		s = await agent.click({ ref: refOf(s, /Inside shadow/) });
		ok(s.text.includes('shadow clicked'), 'button inside a shadow root');
		console.log('\nBROWSER AGENT OK');
	} catch (e) {
		console.error('FAIL', e);
		process.exitCode = 1;
	} finally {
		if (!process.env.KEEP) await agent.close();
		server.close();
	}
})();
