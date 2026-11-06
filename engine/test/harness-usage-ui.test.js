'use strict';
// Exercise production renderers and export handling without a browser or server.
const assert = require('node:assert/strict');


const vm = require('node:vm');
const ts = require('typescript-classic');
function extract(file, names) {
	const source = require('./page-scripts').readPage(file);
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const functions = [];
	function visit(node) {
		if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(ast));
		if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) functions.push('const ' + node.getText(ast) + ';');
		ts.forEachChild(node, visit);
	}
	visit(ast); assert.equal(functions.length, names.length);
	return { source, code: functions.join('\n') };
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
class Element {
	constructor(tag, className = '', innerHTML = '') { Object.assign(this, { tag, className, innerHTML, children: [], dataset: {}, attrs: {} }); }
	appendChild(node) { this.children.push(node); return node; }
	setAttribute(key, value) { this.attrs[key] = value; }
	insertAdjacentHTML(_, html) { this.innerHTML += html; }
	querySelector(selector) { return this.children.find((node) => node.className.split(' ').includes(selector.slice(1))); }
}
const html = (node) => node.innerHTML + node.children.map(html).join('');
const chat = extract('chat.js', ['usageHtml', 'fmtCacheRate', 'fmtCost', 'fmtK']);
const chatContext = vm.createContext({ esc, t: (s) => s });
vm.runInContext(chat.code, chatContext);
assert.match(chatContext.usageHtml({ input: 10000, output: 10, cached: 9999, attempts: 1, knownAttempts: 1 }), /99\.99%/);
assert.doesNotMatch(chatContext.usageHtml({ input: 1e9, output: 1, cached: 1e9 - 1, attempts: 1, knownAttempts: 1 }), />100%/);
assert.match(chatContext.usageHtml({ input: 0, output: 0, attempts: 1, knownAttempts: 0 }), /Usage not reported/);
assert.match(chatContext.usageHtml({ input: 100, output: 0, cached: 90, cacheWrite: 10, attempts: 2, knownAttempts: 1 }), /partial usage \(1\/2 requests\)/);
assert.doesNotMatch(chatContext.usageHtml({ input: 100, output: 0, cached: 90, attempts: 2, knownAttempts: 1 }), /%/);
const mixedCache = chatContext.usageHtml({ input: 200, output: 10, cached: 90, attempts: 2, knownAttempts: 2, cacheKnownAttempts: 1 });
assert.doesNotMatch(mixedCache, /%/); assert.match(mixedCache, /cache reads \(partial reporting\)/);
assert.match(chatContext.usageHtml({ input: 0, output: 0, attempts: 1, knownAttempts: 1, cost: 0 }), /\$0/);
const budgetRenderer = extract('chat.js', ['taskBudgetHtml']);
vm.runInContext(budgetRenderer.code, chatContext);
assert.equal(chatContext.taskBudgetHtml({ limits: {} }), '');
const budgetHtml = chatContext.taskBudgetHtml({ limits: { cost: 1, tokens: 1000, requests: 5 }, requests: 2, spentTokens: 100, reservedTokens: 300, uncertainTokens: 50, spentCost: 0.2, reservedCost: 0.1, uncertainCost: 0.05, unknownUsage: 1, stopped: '<stopped>' });
assert.match(budgetHtml, /550 tokens available/); assert.match(budgetHtml, /\$0\.6500 available/); assert.match(budgetHtml, /2\/5 requests/); assert.match(budgetHtml, /incomplete usage retained/); assert.doesNotMatch(budgetHtml, /<stopped>/);

const settings = extract('settings.js', ['usagePage', 'usageRangeButtons', 'usageCostCell', 'usageCostKind', 'usageMoney', 'usageCacheLabel']);
const S = { usageDays: 30, usageTab: 'overview', usageExporting: false, usage: null };
const posts = [];
const context = vm.createContext({ S, esc, I: () => '', h: (...args) => new Element(...args), fmtTokens: String, post: (m) => posts.push(m), renderPage: () => {} });
vm.runInContext(settings.code, context);
let page = context.usagePage();
let button = page.querySelector('.usage-tabbar').children[0];
assert.equal(button.dataset.act, 'usage-export-requests'); assert.equal(button.disabled, false);
S.usageExporting = true; assert.equal(context.usagePage().querySelector('.usage-tabbar').children[0].disabled, true);
assert.equal(context.usageCacheLabel({ cacheUsageKnown: 0 }), 'Unknown');
assert.equal(context.usageCacheLabel({ cacheUsageKnown: 2, cacheRate: 1 }), '100%');
assert.equal(context.usageCacheLabel({ cacheUsageKnown: 2, cacheRate: 0.999999 }), '99.9999%');
assert.notEqual(context.usageCacheLabel({ cacheUsageKnown: 2, cacheRate: 1 - 1e-12 }), '100%');
assert.match(context.usageCostCell({ costKind: 'estimated', cost: 0.01, unknownCost: 2 }), /Partial estimate · 2 unknown request/);
assert.doesNotMatch(context.usageCostCell({ costKind: 'free', cost: 0, unknownCost: 1 }), /\$0\.00/);
S.usage = { days: 30, models: [], daily: [], totals: { tokens: 0, tokensLabel: '0', cost: 0, requests: 50, cacheUsageKnown: 0, cached: 0, cacheRate: 0, costCoverage: { unknown: 50 } } };
page = context.usagePage();
assert.match(html(page), /Unknown/); assert.match(html(page), /unknown cost or usage excluded/);
assert.doesNotMatch(html(page), /Only 0.*prompt cache/);
const start = settings.source.indexOf("case 'usage-export':");
const end = settings.source.indexOf("case 'usage-page':", start);
assert(start > 0 && end > start);
vm.runInContext('function exportAction(act) { switch (act.dataset.act) { ' + settings.source.slice(start, end) + ' } }', context);
S.usageExporting = false; context.exportAction(button);
assert.equal(posts.at(-1).type, 'exportUsage'); assert.equal(posts.at(-1).attempts, true);
context.exportAction(button); assert.equal(posts.length, 1, 'in-flight export cannot be requested twice');
S.usageExporting = false; context.exportAction({ dataset: { act: 'usage-export' } }); assert.equal(posts.at(-1).attempts, false);
console.log('Harness usage UI passed: measured zero, incomplete counts/costs, cache precision, diagnostics export, and in-flight export guard.');
