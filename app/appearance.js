'use strict';
const fs = require('fs');

/** Only Appearance values may cross the start page's synchronous boot bridge. */
function readAppearance(file) {
	try {
		const settings = JSON.parse(fs.readFileSync(file, 'utf8'))['aiChat.settings'];
		const appearance = {};
		for (const key of ['theme', 'themeBackground', 'themeForeground', 'accent', 'accentColor', 'accentColor2', 'fontUi', 'fontContent', 'fontCode', 'fontWeight', 'uiFontSize', 'motion']) {
			const value = settings?.[key];
			if (typeof value === 'string' && value.length <= 100 || typeof value === 'number' && Number.isFinite(value)) appearance[key] = value;
		}
		return appearance;
	} catch {
		return {};
	}
}

module.exports = { readAppearance };
