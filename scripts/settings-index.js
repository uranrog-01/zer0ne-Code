'use strict';
const fs = require('fs'), path = require('path'), ts = require('typescript-classic');
const root = path.resolve(__dirname, '..');

function settingsIndex(source) {
	const ast = ts.createSourceFile('settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const functions = new Map(), routes = {
		generalPage: 'general', notchCard: 'general', appearancePage: 'appearance', modelsPage: 'models', browserPage: 'browser',
		agentPage: 'agent', subagentsPage: 'agent', featuresPage: 'features', localModelsPage: 'local', localMorePage: 'local',
		memoryPage: 'memory', pluginsSkillsPage: 'plugins', pluginsPage: 'plugins', skillsPage: 'skills', hooksPage: 'hooks',
		mcpPage: 'mcp', cloudPage: 'cloud', remotePage: 'remote', usagePage: 'usage', aboutPage: 'about'
	};
	function collect(n) { if (ts.isFunctionDeclaration(n) && n.name) functions.set(n.name.text, n); ts.forEachChild(n, collect); }
	collect(ast);
	const entries = [], seen = new Set();
	const literal = n => n && ts.isStringLiteralLike(n) ? n.text : '';
	function scan(name, section, trail = new Set()) {
		if (trail.has(name) || !functions.has(name)) return;
		const next = new Set([...trail, name]);
		function visit(n, route) {
			let current = route;
			if (ts.isIfStatement(n) && ts.isBinaryExpression(n.expression)) {
				const left = n.expression.left.getText(ast), value = literal(n.expression.right);
				const field = left === 'S.generalPage' ? 'generalPage' : left === 'S.localTab' || left === 'tab' && name === 'localMorePage' ? 'localTab' : left === 'tab' && name === 'agentPage' ? 'agentTab' : '';
				if (field && value && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
					visit(n.thenStatement, { ...route, [field]: value }); if (n.elseStatement) visit(n.elseStatement, route); return;
				}
			}
			if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
				const callee = n.expression.text;
				if (['switchRow', 'selectRow'].includes(callee)) {
					const key = literal(n.arguments[2]), labelNode = n.arguments[0];
					const label = literal(labelNode), labelKey = labelNode && ts.isCallExpression(labelNode) && labelNode.expression.getText(ast) === 'tr' ? literal(labelNode.arguments[0]) : '';
					if (key) add({ section, ...current, key, label: label || key.replace(/([a-z])([A-Z])/g, '$1 $2'), labelKey, description: literal(n.arguments[1]) });
				} else if (callee === 'runtimeNumber' && literal(n.arguments[0])) {
					add({ section, ...current, key: literal(n.arguments[0]), label: literal(n.arguments[1]), description: literal(n.arguments[2]) });
				} else if (functions.has(callee) && !['renderPage', 'navigate', 'mount'].includes(callee) && !routes[callee]) scan(callee, section, next);
			}
			if (ts.isStringLiteralLike(n)) {
				for (const match of n.text.matchAll(/data-setting="([A-Za-z][\w]*)"/g)) {
					const prefix = n.text.slice(0, match.index), names = [...prefix.matchAll(/class="name">([^<]+)</g)];
					add({ section, ...current, key: match[1], label: names.at(-1)?.[1] || match[1].replace(/([a-z])([A-Z])/g, '$1 $2') });
				}
			}
			ts.forEachChild(n, child => visit(child, current));
		}
		const extra = name === 'notchCard' ? { generalPage: 'notch' } : name === 'subagentsPage' ? { agentTab: 'subagents' } : {};
		visit(functions.get(name).body, extra);
	}
	function add(entry) { const id = entry.section + ':' + entry.key; if (!seen.has(id)) { seen.add(id); entries.push(entry); } }
	for (const [name, section] of Object.entries(routes)) scan(name, section);
	return entries;
}

function sources(directory = path.join(root, 'engine/media')) {
	return fs.readdirSync(directory).filter(name => /^settings(?:-[a-z0-9]+)?\.js$/.test(name) && !['settings-index.js', 'settings-search.js'].includes(name)).sort().map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
}
function build() {
	const entries = settingsIndex(sources());
	fs.writeFileSync(path.join(root, 'engine/media/settings-index.js'), '// Generated from Settings UI sources by scripts/settings-index.js.\nwindow.SettingsIndex = ' + JSON.stringify(entries) + ';\n');
	return entries;
}
module.exports = { settingsIndex, sources, build };
if (require.main === module) console.log('Settings index: ' + build().length + ' controls');
