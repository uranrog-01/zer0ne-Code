'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { verifyRuntime } = require('../app/integrity');
const { snapshot, assertUnchanged, digest } = require('../scripts/release-inputs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-integrity-test-'));
try {
	fs.mkdirSync(path.join(base,'host')); fs.writeFileSync(path.join(base,'host/main.js'),'fixture');
	const manifest = {schema:1,files:{'host/main.js':digest('fixture')}};
	assert.equal(verifyRuntime(base,manifest),true);
	fs.writeFileSync(path.join(base,'host/main.js'),'modified');
	assert.throws(()=>verifyRuntime(base,manifest),/integrity check failed/);
	assert.throws(()=>verifyRuntime(base,{schema:1,files:{'../outside':digest('fixture')}}),/Invalid/);
	fs.renameSync(path.join(base,'host'),path.join(base,'original-host'));
	fs.symlinkSync(__dirname,path.join(base,'host'),process.platform === 'win32' ? 'junction' : 'dir');
	assert.throws(()=>verifyRuntime(base,{schema:1,files:{'host/app-units.js':digest('fixture')}}),/unexpected link/);
	fs.unlinkSync(path.join(base,'host')); fs.renameSync(path.join(base,'original-host'),path.join(base,'host'));
	fs.writeFileSync(path.join(base,'host/main.js'),'fixture');
	fs.mkdirSync(path.join(base,'engine/eval/cases/nested'),{recursive:true}); fs.writeFileSync(path.join(base,'engine/eval/cases/nested/task.json'),'case');
	const sealed = {schema:1,files:{'host/main.js':digest('fixture'),'engine/eval/cases/nested/task.json':digest('case')}};
	assert.equal(verifyRuntime(base,sealed),true);
	fs.writeFileSync(path.join(base,'engine/eval/cases/added.json'),'{}');
	assert.throws(()=>verifyRuntime(base,sealed),/unexpected file: engine\/eval\/cases\/added\.json/);
	assert.equal(verifyRuntime(base,manifest),true,'folders the manifest does not cover are not sealed');
	fs.rmSync(path.join(base,'engine'),{recursive:true,force:true});
	const before = snapshot(base); assertUnchanged(before,base);
	fs.writeFileSync(path.join(base,'host/main.js'),'changed during validation');
	assert.throws(()=>assertUnchanged(before,base),/Source changed during validation/);
	for (const relative of ['engine/test/example.test.js', 'engine/eval/cases/example.json', 'engine/eval/judge/example.json', 'engine/eval/reference.json']) {
		const file = path.join(base, relative);
		fs.mkdirSync(path.dirname(file), { recursive:true });
		fs.writeFileSync(file, 'original');
		const original = snapshot(base);
		assert.equal(original.files[relative], digest('original'), relative + ' belongs to the release inputs');
		fs.writeFileSync(file, 'modified');
		assert.throws(() => assertUnchanged(original, base), /Source changed during validation/, relative + ' edits invalidate validation');
		const modified = snapshot(base);
		fs.unlinkSync(file);
		assert.throws(() => assertUnchanged(modified, base), /Source changed during validation/, relative + ' deletion invalidates validation');
		const missing = snapshot(base);
		fs.writeFileSync(file, 'added');
		assert.throws(() => assertUnchanged(missing, base), /Source changed during validation/, relative + ' additions invalidate validation');
	}
	console.log('Release integrity passed: valid runtime, tampered files, escaped paths/links and source drift.');
} finally { if(path.dirname(base)===os.tmpdir()&&path.basename(base).startsWith('zer0ne-integrity-test-')) fs.rmSync(base,{recursive:true,force:true}); }
