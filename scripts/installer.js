'use strict';
// Wraps the validated build in dist/win-unpacked into dist/zer0ne-Code-Setup-<version>.exe.
// node scripts/installer.js [--signed]
// The installer holds exactly the folder that was validated: its release.json checksums are
// verified first, and electron-builder only adds the setup program around it (--prepackaged).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { digest } = require('./release-inputs');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const unpacked = path.join(root, 'dist', 'win-unpacked');
const setup = path.join(root, 'dist', `zer0ne-Code-Setup-${pkg.version}.exe`);
const strict = process.argv.includes('--signed') || process.env.ZER0NE_REQUIRE_SIGNED === '1';

function fail(message) {
	console.error(message);
	process.exit(1);
}

function verifyBuild() {
	const file = path.join(unpacked, 'resources', 'release.json');
	if (!fs.existsSync(file)) fail('No validated build in dist/win-unpacked. Run build.bat (or npm run validate) first.');
	const release = JSON.parse(fs.readFileSync(file, 'utf8'));
	if (release.version !== pkg.version) fail(`dist/win-unpacked is version ${release.version}, package.json is ${pkg.version}. Build again.`);
	for (const [relative, expected] of Object.entries(release.files || {})) {
		const absolute = path.join(unpacked, relative);
		if (!fs.existsSync(absolute) || digest(fs.readFileSync(absolute)) !== expected) fail(`dist/win-unpacked/${relative} changed after it was built. Build again.`);
	}
	if (!Object.keys(release.files || {}).length) fail('dist/win-unpacked/resources/release.json lists no files. Build again.');
	return release;
}

function authenticode(file) {
	const check = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; if($s.Status -ne 'Valid'){throw ('Signature is not valid: ' + $s.Status)}`], { stdio: 'inherit', windowsHide: true });
	if (check.status !== 0) fail('Refusing an unsigned or invalid release: ' + path.relative(root, file));
}

const release = verifyBuild();
if (strict && !process.env.CSC_LINK && !process.env.WIN_CSC_LINK && !process.env.ZER0NE_SIGN_CERT_SHA1) fail('Signed installers need CSC_LINK and CSC_KEY_PASSWORD (or ZER0NE_SIGN_CERT_SHA1 for a local certificate).');
if (strict && process.platform === 'win32') authenticode(path.join(unpacked, 'zer0ne Code.exe'));
const certificate = process.env.ZER0NE_SIGN_CERT_SHA1;
if (certificate && !/^[a-f0-9]{40}$/i.test(certificate)) fail('ZER0NE_SIGN_CERT_SHA1 must be a certificate thumbprint.');

fs.rmSync(setup, { force: true });
const args = [
	'node_modules/electron-builder/out/cli/cli.js', '--win', 'nsis', '--x64', '--prepackaged', unpacked, '--publish', 'never',
	...(strict ? ['--config.forceCodeSigning=true'] : []),
	...(certificate ? ['--config.win.signtoolOptions.certificateSha1=' + certificate] : [])
];
const env = { ...process.env, ...(strict ? { CSC_IDENTITY_AUTO_DISCOVERY: 'true' } : {}) };
const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
if (result.status !== 0) fail('The installer was not built.');
if (!fs.existsSync(setup)) fail('electron-builder finished without producing ' + path.relative(root, setup));
// No auto-update channel: drop electron-builder's update metadata and its debug log.
for (const extra of ['latest.yml', 'builder-debug.yml']) fs.rmSync(path.join(root, 'dist', extra), { force: true });
if (strict && process.platform === 'win32') authenticode(setup);

const hash = digest(fs.readFileSync(setup));
fs.writeFileSync(setup + '.sha256', `${hash}  ${path.basename(setup)}\n`);
console.log(`\nInstaller: dist/${path.basename(setup)}`);
console.log(`SHA-256:   ${hash}`);
console.log(`Contents:  dist/win-unpacked, source ${release.sourceHash.slice(0, 12)}${release.dirty ? ' (uncommitted changes)' : ''}${strict ? ', signed' : ', unsigned'}`);
