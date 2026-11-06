'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { sharedGlobalMemento } = require('../host/storage');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-storage-cache-')), file = path.join(tmp, 'shared.json');
const original = fs.readFileSync; let reads = 0;
(async () => {
	try {
		fs.writeFileSync(file, JSON.stringify({ value: { count: 1 } }));
		fs.readFileSync = function(target, ...args) { if (target === file) reads++; return original.call(this, target, ...args); };
		const first = sharedGlobalMemento(file);
		for (let i = 0; i < 100; i++) { const value = first.get('value'); value.count = 99; assert.equal(first.get('value').count, 1); }
		assert.equal(reads, 1, 'Unchanged storage is parsed once, not once per engine state field');
		const peer = sharedGlobalMemento(file); await peer.update('value', { count: 2 });
		assert.equal(first.get('value').count, 2, 'Atomic peer writes invalidate the cache');
		await first.update('other', 'preserved'); assert.equal(peer.get('other'), 'preserved');
		console.log('Shared storage cache: one read for unchanged data, immutable getters and peer-write invalidation passed.');
	} finally { fs.readFileSync = original; fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
