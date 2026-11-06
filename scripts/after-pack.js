'use strict';
const fs = require('fs');
const path = require('path');
const { extractFile } = require('@electron/asar');
const { digest } = require('./release-inputs');
module.exports = async context => {
	const resources = path.join(context.appOutDir, 'resources');
	const manifest = JSON.parse(extractFile(path.join(resources, 'app.asar'), path.normalize('app/release-integrity.json')).toString('utf8'));
	for (const [file, expected] of Object.entries(manifest.files)) {
		if (digest(fs.readFileSync(path.join(resources, 'app.asar.unpacked', file))) !== expected) throw new Error('Packaged runtime differs from its integrity manifest: ' + file);
	}
	if (context.electronPlatformName === 'win32') require('./prepare-runtime').prepareRuntime(context.appOutDir);
};
