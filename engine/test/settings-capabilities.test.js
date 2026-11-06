// Production settings renderers exercised with an in-memory DOM, no browser/network.
const assert = require('node:assert/strict');


const vm = require('node:vm');
const ts = require('typescript-classic');
const source = require('./page-scripts').readPage('settings.js');
const ast = ts.createSourceFile('settings.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['capabilityHeader', 'capabilityStats', 'capabilitySearch', 'capabilityTabs', 'recordingBanner', 'pluginsPage', 'mcpPage', 'skillsPage', 'pluginsSkillsPage']);
const functions = [];
function visit(node) {
	if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(ast));
	ts.forEachChild(node, visit);
}
visit(ast); assert.equal(functions.length, names.size);
class Element {
	constructor(tag, cls = '', html = '') { this.tag = tag; this.className = cls; this.innerHTML = html; this.children = []; this.attrs = {}; this.dataset = {}; }
	appendChild(n) { this.children.push(n); return n; }
	setAttribute(k, v) { this.attrs[k] = v; }
	addEventListener() {}
	get outerHTML() { return '<' + this.tag + '>' + this.innerHTML + '</' + this.tag + '>'; }
}
const h = (...args) => new Element(...args);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const S = { settings: { mcp: true, skills: true }, plugins: [], skills: [], mcp: [] };
const context = { S, h, esc, desktopHost: () => false, I: () => '', tr: (s) => s, marketplaceTab: () => h('div', 'marketplace'), pluginsSection: () => h('div', 'installed'), skillCatalogView: () => h('div', 'catalog'), mcpDiscoverView: () => h('div', 'discover'), hooksPage: () => h('div', 'hooks-embed'), cloudPage: () => h('div', 'cloud-embed'), post: () => {}, header: (title) => h('div', 'settings-header', title), switchRow: (name, d, key) => '<div class="setting-row" data-key="' + key + '"><b>' + name + '</b>' + d + '</div>', since: () => '3h ago' };
vm.createContext(context); vm.runInContext(functions.join('\n'), context);
const child = (root, cls) => root.children.find((n) => n.className.split(' ').includes(cls));
const html = (root) => root.innerHTML + root.children.map(html).join('');

let page = context.pluginsPage();
const tabs = child(page, 'cap-tabs');
assert.equal(tabs.attrs.role, 'tablist');
assert(tabs.innerHTML.indexOf('Installed') < tabs.innerHTML.indexOf('Marketplace'));
assert.match(tabs.innerHTML, /aria-selected="true"[^>]*data-plugin-tab="installed"/);
assert(child(page, 'installed')); assert.match(html(page), /Record workflow/);
S.pluginTab = 'market'; assert(child(context.pluginsPage(), 'marketplace'));
S.isRemote = true; assert(!html(context.pluginsPage()).includes('Record workflow')); S.isRemote = false;

S.skills = [
	{ name: 'report', description: 'Export weekly totals', source: 'user', editable: true, enabled: true, path: '/report/SKILL.md' },
	{ name: '<private>', description: '<script>alert(1)</script>', source: 'plugin', editable: false, enabled: false, path: '/plugin/SKILL.md' }
];
page = context.skillsPage(); assert.match(html(page), /Record a skill/);
assert.match(html(child(page, 'cap-library')), /&lt;private&gt;/); assert(!html(page).includes('<script>'));
S.skillInstalledQ = 'weekly'; page = context.skillsPage(); assert(!html(child(page, 'cap-library')).includes('&lt;private&gt;'));
S.skillInstalledQ = ''; S.skillSourceFilter = 'plugin'; page = context.skillsPage();
assert(!html(child(page, 'cap-library')).includes('data-skill="report"')); assert(html(child(page, 'cap-library')).includes('&lt;private&gt;'));
S.skillInstalledQ = 'missing'; assert(html(context.skillsPage()).includes('No skills match'));
S.skillTab = 'catalog'; assert(child(context.skillsPage(), 'catalog'));

S.mcp = [
	{ id: 'a', name: 'Docs', enabled: true, command: 'node', args: ['docs.js'], transport: 'stdio', status: { state: 'ready', tools: [{ name: 'read', description: 'Read docs' }, { name: 'write', description: 'Write docs' }] }, disabledTools: ['write', 'tool-that-no-longer-exists'] },
	{ id: 'b', name: 'Database', enabled: true, command: 'node', args: [], transport: 'stdio', status: { state: 'error', tools: [], error: 'Connection refused' } },
	{ id: 'c', name: 'Offline', enabled: false, command: 'node', args: [], transport: 'stdio', status: { state: 'stopped', tools: [] } }
];
page = context.mcpPage(); const summary = html(child(page, 'mcp-summary'));
assert.match(summary, /<b>1<\/b> tool available/); assert(summary.includes('needs attention'));
assert.match(html(child(page, 'mcp-list')), /Configured<span>3<\/span>/);
assert(html(child(page, 'mcp-list')).includes('Connection refused'), 'a failing server shows its error');
S.mcpStateFilter = 'attention'; page = context.mcpPage(); assert(html(child(page, 'mcp-list')).includes('Database')); assert(!html(child(page, 'mcp-list')).includes('Docs'));
S.mcpStateFilter = 'off'; page = context.mcpPage(); assert(html(child(page, 'mcp-list')).includes('Offline')); assert(!html(child(page, 'mcp-list')).includes('Database'));
S.mcpInstalledQ = 'missing'; assert(html(context.mcpPage()).includes('No servers match'));
S.mcpTab = 'discover'; assert(child(context.mcpPage(), 'discover'));
S.mcpTab = 'connected'; S.mcp = []; assert(html(context.mcpPage()).includes('No MCP servers yet'));

// Plugins and Skills retain their shared page.
S.psTab = 'plugins'; S.pluginTab = 'market';
page = context.pluginsSkillsPage();
assert(child(child(page, 'page'), 'marketplace'), 'Plugins & Skills opens on the Plugins tab');
assert.match(html(page), /data-ps-tab="skills">Skills/);
S.psTab = 'skills'; S.skillTab = 'installed'; S.skillInstalledQ = ''; S.skillSourceFilter = '';
page = context.pluginsSkillsPage();
assert(html(page).includes('Record a skill') && child(child(page, 'page'), 'cap-library'), 'the Skills tab shows the skills page');
assert(!functions.join('\n').includes('modsHooksPage'));
// Appearance// Appearance uses the same palette and Terminal theme picker on every surface.
assert(!source.includes('data-desktop-mode'));
const modeStart = source.indexOf("\t\tif ((n = t.closest('[data-theme-pick]')))");
const modeEnd = source.indexOf("\n\t\tif ((n = t.closest('[data-mkt-remove]')))", modeStart);
vm.runInContext('function themeClick(t) { let n; ' + source.slice(modeStart, modeEnd) + '\n}', context);
const picked = [];
context.flushColourPatch = () => {};
context.post = m => picked.push(m.patch.theme);
for (const theme of ['dark', 'terminal', 'dracula']) context.themeClick({ closest: () => ({ dataset: { themePick: theme } }) });
assert.deepEqual(picked, ['dark', 'terminal', 'dracula']);
console.log('Merged pages and appearance controls passed.');
