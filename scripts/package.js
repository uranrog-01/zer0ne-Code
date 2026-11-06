'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { snapshot, assertUnchanged, digest } = require('./release-inputs');
const { outputLock, retryPackaging } = require('./package-retry');
require('../test/gui-lock').acquire();
const root = path.resolve(__dirname, '..');
function assertAppClosed() {
	if (process.platform === 'win32' && /^"zer0ne Code\.exe"/im.test(execFileSync('tasklist.exe', ['/FI','IMAGENAME eq zer0ne Code.exe','/FO','CSV','/NH'], { encoding:'utf8', windowsHide:true }))) throw new Error('Quit zer0ne Code from the tray before packaging.');
}
assertAppClosed();
const inputs = snapshot(root);
const strict = process.argv.includes('--signed');
const env = { ...process.env, ...(strict ? { CSC_IDENTITY_AUTO_DISCOVERY:'true', ZER0NE_REQUIRE_SIGNED:'1' } : {}) };
const certificate = process.env.ZER0NE_SIGN_CERT_SHA1;
if (certificate && !/^[a-f0-9]{40}$/i.test(certificate)) throw new Error('ZER0NE_SIGN_CERT_SHA1 must be a certificate thumbprint.');
const args = ['node_modules/electron-builder/out/cli/cli.js', '--win', 'dir', ...(strict ? ['--config.forceCodeSigning=true'] : []), ...(certificate ? ['--config.win.signtoolOptions.certificateSha1=' + certificate] : [])];
const output = path.join(root, 'dist/win-unpacked');
function runBuilder() {
	assertAppClosed();
	assertUnchanged(inputs, root);
	return new Promise(resolve => {
		let tail = '';
		const child = spawn(process.execPath, args, { cwd:root, env, stdio:['inherit','pipe','pipe'], windowsHide:true });
		for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
			stream.setEncoding('utf8');
			stream.on('data', chunk => { destination.write(chunk); tail = (tail + chunk).slice(-65536); });
		}
		child.once('error', error => { console.error(error.message); resolve({ status:1, output:'' }); });
		child.once('close', status => resolve({ status:status ?? 1, output:tail }));
	});
}

async function main() {
	const result = await retryPackaging(runBuilder, output, { beforeRetry: () => { assertAppClosed(); assertUnchanged(inputs, root); } });
	if (result.status !== 0) {
		if (outputLock(result.output, output)) console.error('The build output is still locked. Quit zer0ne Code from the tray and close any Explorer preview of dist/win-unpacked, then run build.bat again.');
		process.exitCode = result.status || 1;
		return;
	}
	assertUnchanged(inputs, root);
	const files = {};
	for (const relative of ['zer0ne Code.exe', 'resources/app.asar', 'resources/app.asar.unpacked/engine/engine.json']) files[relative] = digest(fs.readFileSync(path.join(output, relative)));
	fs.writeFileSync(path.join(output, 'resources/release.json'), JSON.stringify({ schema:1, version:require('../package.json').version, sourceHash:inputs.sourceHash, revision:inputs.revision, dirty:inputs.dirty, node:process.version, electron:require('electron/package.json').version, files }, null, 2) + '\n');
	if (strict) {
		const check = spawnSync('powershell.exe', ['-NoProfile','-Command', "$s=Get-AuthenticodeSignature -LiteralPath 'dist/win-unpacked/zer0ne Code.exe'; if($s.Status -ne 'Valid'){throw 'Release signature is not valid'}"], { cwd:root, stdio:'inherit', windowsHide:true });
		if (check.status !== 0) process.exit(1);
	}
	console.log('Release provenance: dist/win-unpacked/resources/release.json');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
