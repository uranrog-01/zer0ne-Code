// Published artifacts keep a sandboxed copy under a random id so a phone can preview them.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const panels = [];
const vscode = {
	ViewColumn: { Beside: 2 },
	commands: { executeCommand: async () => undefined },
	window: {
		createWebviewPanel: (_kind, title) => {
			const panel = { title, webview: { html: '' }, onDidDispose: () => {}, reveal: () => {}, dispose: () => {} };
			panels.push(panel);
			return panel;
		}
	}
};
const load = Module._load;
Module._load = function (request, ...rest) {
	return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const { ArtifactHost } = require(path.join(__dirname, '..', 'out', 'host', 'artifactsHost.js'));

(async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-artifact-'));
	try {
		const host = new ArtifactHost();
		const file = path.join(dir, 'report.html');
		fs.writeFileSync(file, '<h1>Report</h1>');
		await host.show(file, 'Report');
		const list = host.list();
		assert.equal(list.length, 1, 'a published artifact is listed');
		assert.equal(list[0].title, 'Report');
		assert.ok(list[0].id && list[0].id.length > 16, 'the preview id is unguessable');
		const html = host.get(list[0].id);
		assert.match(html, /Content-Security-Policy/, 'the phone preview keeps the artifact sandbox');
		assert.match(html, /<h1>Report<\/h1>/);
		assert.equal(host.get('nope'), undefined, 'unknown ids resolve to nothing');

		// Republishing the same file updates its panel but keeps the earlier previews addressable.
		await host.show(file, 'Report v2');
		assert.equal(host.list().length, 2);
		assert.equal(panels.length, 1, 'the panel is reused by path');

		// Only the newest previews are kept.
		for (let i = 0; i < 14; i++) {
			const next = path.join(dir, 'r' + i + '.html');
			fs.writeFileSync(next, '<p>' + i + '</p>');
			await host.show(next, 'R' + i);
		}
		assert.equal(host.list().length, 12, 'the store is bounded');
		assert.equal(host.list()[0].title, 'R13', 'newest first');
		assert.equal(host.list().at(-1).title, 'R2');

		// A file that disappears is not offered as a preview.
		const before = host.list().length;
		await host.show(path.join(dir, 'missing.html'), 'Missing');
		assert.equal(host.list().length, before, 'missing files publish nothing');

		console.log('Artifact previews passed: sandboxed copies, unguessable ids, panel reuse, newest 12 kept.');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})().catch((e) => {
	console.error('FAIL', e);
	process.exitCode = 1;
});
