'use strict';
const fs = require('fs');
const path = require('path');
function readPage(file, directory) {
	const media = directory || (process.env.ZER0NE_TEST_ENGINE_OUT ? path.resolve(process.env.ZER0NE_TEST_ENGINE_OUT, '../media') : path.join(__dirname, '../media'));
	const dependencies = file === 'settings.js' ? ['computer-history.js', 'computer-use.js','settings-general.js','settings-usage.js','settings-benchmark-profiles.js', 'settings-features.js','settings-hooks-memory.js'] : file === 'chat.js' ? ['computer-history.js', 'computer-use.js','chat-stats.js','chat-review.js','chat-project-actions.js','chat-repository.js','chat-branch.js','setup.js'] : [];
	return [...dependencies, file].map(name => fs.readFileSync(path.join(media, name), 'utf8')).join('\n');
}
module.exports = { readPage };
