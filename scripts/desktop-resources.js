'use strict';
const resources = {
	subscriptionAgents: ['engine/out/host/acpHost.js', 'engine/out/acp/runtime.js'],
	cloud: ['engine/out/host/cloudHost.js', 'engine/media/cloud/workflow.yml', 'engine/media/cloud/runner.mjs'],
	remote: ['engine/out/remote.js', 'engine/media/settings-remote.js'],
	remoteTunnels: ['engine/out/tunnel.js', 'engine/out/remote.js'],
	plugins: ['engine/out/tools/plugins.js', 'engine/out/tools/extensionCatalog.js'],
	hooks: ['engine/out/tools/hooks.js'],
	marketplace: ['engine/out/tools/extensionCatalog.js']
};
const startup = ['engine/out/chatController.js', 'engine/media/settings.js', 'engine/media/settings-index.js', 'engine/media/settings-search.js', 'engine/media/recovery.js', 'engine/media/polish.css'];
function uiResources(source) {
	const ts = require('typescript-classic'), ast = ts.createSourceFile('remote.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), files = new Set();
	const declarations = new Map();
	function collect(n) { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) declarations.set(n.name.text, n.initializer); ts.forEachChild(n, collect); }
	collect(ast);
	const resolving = new Set();
	function array(n) {
		if (!n) return undefined;
		if (ts.isArrayLiteralExpression(n)) return n;
		if (ts.isCallExpression(n) || ts.isPropertyAccessExpression(n)) return array(n.expression);
		return undefined;
	}
	function values(n) {
		if (ts.isParenthesizedExpression(n)) return values(n.expression);
		if (ts.isStringLiteralLike(n)) return [n.text];
		if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap(values);
		if (ts.isSpreadElement(n)) return values(n.expression);
		if (ts.isIdentifier(n) && declarations.has(n.text) && !resolving.has(n.text)) {
			resolving.add(n.text);
			try { return values(declarations.get(n.text)); } finally { resolving.delete(n.text); }
		}
		if (ts.isConditionalExpression(n) && n.condition.getText(ast) === 'desktopHost') return values(n.whenTrue);
		if (ts.isConditionalExpression(n)) {
			const condition = n.condition;
			const join = ts.isCallExpression(condition) && ts.isPropertyAccessExpression(condition.expression) && condition.expression.name.text === 'existsSync' && condition.arguments.length === 1 ? condition.arguments[0] : undefined;
			if (join && ts.isCallExpression(join) && ts.isPropertyAccessExpression(join.expression) && join.expression.name.text === 'join' && join.arguments.length === 2 && join.arguments[0].getText(ast) === 'this.mediaDir' && ts.isStringLiteralLike(join.arguments[1]) && /^[\w/-]+\.js$/.test(join.arguments[1].text)) {
				const present = require('fs').existsSync(require('path').join(__dirname, '../engine/media', join.arguments[1].text));
				return values(present ? n.whenTrue : n.whenFalse);
			}
		}
		throw new Error('Declare the desktop resources for this UI asset expression: ' + n.getText(ast));
	}
	function visit(n) {
		if (ts.isVariableDeclaration(n) && ['css', 'js'].includes(n.name.getText(ast))) {
			const list = array(n.initializer);
			if (list) for (const file of values(list)) if (/^[\w/-]+\.(?:css|js)$/.test(file)) files.add('engine/media/' + file);
		}
		ts.forEachChild(n, visit);
	}
	visit(ast); return [...files];
}
function checkDesktopResources(capabilities, { exists, shipped }, pageAssets = []) {
	const problems = [];
	for (const [capability, enabled] of Object.entries(capabilities)) {
		if (enabled !== true) continue;
		if (!resources[capability]) { problems.push(`Desktop capability ${capability}: declare its release resources in scripts/desktop-resources.js`); continue; }
		for (const file of resources[capability]) {
			if (!exists(file)) problems.push(`Desktop capability ${capability}: missing ${file}`);
			else if (!shipped(file)) problems.push(`Desktop capability ${capability}: package excludes required ${file}`);
		}
	}
	for (const file of new Set([...startup, ...pageAssets])) {
		if (!exists(file) || !shipped(file)) problems.push(`Desktop startup requires packaged ${file}`);
	}
	return problems;
}
module.exports = { resources, startup, uiResources, checkDesktopResources };
