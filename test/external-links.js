'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const calls = [];
let behavior = 'ok';
const electron = { shell: { openExternal: url => { calls.push(url); if (behavior === 'throw') throw Error('fixture launch error'); return behavior === 'reject' ? Promise.reject(Error('fixture no browser')) : Promise.resolve(); } } };
const context = { module: { exports: {} }, require: name => name === 'electron' ? electron : require(name), process, Buffer, URL };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/ops.js'), 'utf8'), context);
const open = context.module.exports.openExternal;
(async () => {
	const url = 'https://accounts.google.com/signin/continue?plt=fixture%2Bsignature&continue=https%3A%2F%2Fexample.test%2Fdone';
	assert.equal(await open(url), true); assert.equal(calls.at(-1), url);
	behavior = 'reject'; assert.equal(await open(url), false);
	behavior = 'throw'; assert.equal(await open(url), false);
	const count = calls.length; assert.equal(await open('javascript:alert(1)'), false); assert.equal(await open('not a URL'), false); assert.equal(calls.length, count);
	console.log('External links passed: exact signed URLs, real launch outcomes, rejected/synchronous failures and denied protocols.');
})().catch(error => { console.error(error); process.exitCode = 1; });
