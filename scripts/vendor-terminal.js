// Pass the unpacked @xterm/xterm 5.5.0 package from npm pack --ignore-scripts.
// Keep the browser bundle unchanged and verify the reviewed bytes before copying.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const target = path.resolve(__dirname, '../engine/media/terminal');
const pin = JSON.parse(fs.readFileSync(path.join(target, 'vendor.json'), 'utf8'));
function verify(directory, packageLayout = false) {
	const problems = [];
	for (const [name, entry] of Object.entries(pin.files)) {
		const file = path.join(directory, packageLayout ? entry.source : name);
		if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) problems.push('Terminal asset does not match its reviewed pin: ' + name);
	}
	return problems;
}
module.exports = { verify };
if (require.main === module) {
	if (process.argv.length !== 3) throw new Error('Usage: node scripts/vendor-terminal.js <unpacked-package>');
	const directory = path.resolve(process.argv[2]), pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
	if (pkg.name !== pin.package || pkg.version !== pin.version) throw new Error('Unexpected terminal package.');
	const problems = verify(directory, true); if (problems.length) throw new Error(problems.join('\n'));
	for (const [name, entry] of Object.entries(pin.files)) fs.copyFileSync(path.join(directory, entry.source), path.join(target, name));
	console.log('Vendored ' + pin.package + ' ' + pin.version + ' with matching hashes and license.');
}
