/*
 * Static checks for the webview scripts (they are plain JS, outside tsc):
 * every media/*.js must parse, and no file may reference a media asset that
 * is not in media/ (a renamed icon or stylesheet fails here, not in a user's
 * VS Code). Part of `npm run check`, which CI runs before the test suites.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MEDIA = path.join(__dirname, '..', 'media');
let failed = 0;
for (const f of fs.readdirSync(MEDIA).filter((f) => f.endsWith('.js'))) {
	try {
		execFileSync(process.execPath, ['--check', path.join(MEDIA, f)], { stdio: 'pipe' });
	} catch (e) {
		failed++;
		console.error(`media/${f} does not parse:\n${String(e.stderr || e.message).trim()}`);
	}
}
// Assets the extension host loads by name (src/webviewMarkup.ts, src/*.ts).
const src = path.join(__dirname, '..', 'src');
const wanted = new Set();
const scan = (dir) => {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) scan(p);
		else if (/(webviewMarkup|settingsPanel|chatViewProvider|fullscreenChat|remote)\.ts$/.test(e.name))
			for (const m of fs.readFileSync(p, 'utf8').matchAll(/['"`]([\w-]+\.(?:js|css))['"`]/g)) wanted.add(m[1]);
	}
};
scan(src);
// Loaded only when present: it is not part of the public source (see THIRD_PARTY_NOTICES.md).
wanted.delete('filament.js');
for (const w of wanted) {
	if (!fs.existsSync(path.join(MEDIA, w))) {
		failed++;
		console.error(`src/ references media/${w}, which does not exist`);
	}
}
console.log(failed ? `\n${failed} media check(s) failed` : `media ok (${wanted.size} referenced assets present)`);
process.exitCode = failed ? 1 : 0;
