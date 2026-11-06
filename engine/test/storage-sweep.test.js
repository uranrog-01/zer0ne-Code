// The startup storage sweep (src/host/storageSweep.ts): stale download and
// conversion leftovers and unreferenced runtime versions go; fresh ones — a
// resumable part, a conversion in progress, the current and rollback builds —
// stay. Complete model files are never touched.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const OUT = path.join(__dirname, '..', 'out');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const DAY = 24 * 3600 * 1000;
const now = 2_000_000_000_000; // fixed clock: deterministic staleness
const file = (root, rel, ageDays) => {
	const p = path.join(root, ...rel.split('/'));
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, rel);
	const age = ageDays === undefined ? 0 : ageDays * DAY;
	fs.utimesSync(p, new Date(now - age - 1000), new Date(now - age - 1000));
	return p;
};

test('stale download leftovers go, fresh ones and complete models stay', () => {
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		const stalePart = file(root, 'models/unsloth/Repo/model.gguf.part', 8);
		const staleVerify = file(root, 'models/unsloth/Repo/model.gguf.verify', 8);
		const staleVerifyPart = file(root, 'studio/models/owner--repo/sd.gguf.verify.part', 9);
		const freshPart = file(root, 'models/unsloth/Repo/resume.gguf.part', 1);
		const complete = file(root, 'models/unsloth/Repo/keep.gguf', 30);
		const stalePrivate = file(root, 'private-search/embed.gguf.part', 10);
		sweepStorage(root, now);
		assert.ok(!fs.existsSync(stalePart) && !fs.existsSync(staleVerify) && !fs.existsSync(staleVerifyPart) && !fs.existsSync(stalePrivate), 'stale leftovers removed');
		assert.ok(fs.existsSync(freshPart), 'resumable part kept');
		assert.ok(fs.existsSync(complete), 'complete model untouched');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stale .pending marker goes; a converter work dir goes only when nothing in it is fresh', () => {
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		const staleMarker = file(root, 'models/unsloth/Repo/.pending-model-00001-of-00002.gguf.json', 8);
		const freshMarker = file(root, 'models/unsloth/Repo2/.pending-model-00001-of-00002.gguf.json', 1);
		const deadWork = file(root, 'converter/work/owner--repo/weights.safetensors', 9);
		const liveWork = file(root, 'converter/work/owner--repo2/f16.gguf', 1);
		sweepStorage(root, now);
		assert.ok(!fs.existsSync(staleMarker) && !fs.existsSync(deadWork), 'stale marker and dead conversion removed');
		assert.ok(fs.existsSync(freshMarker) && fs.existsSync(liveWork), 'fresh marker and live conversion kept');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('unreferenced runtime version dirs and extra engine builds go; referenced ones stay', () => {
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		// voice: voice.json points into v2; v1 is unreferenced.
		const v2 = file(root, 'voice/engine/v2.0.0/bin/sherpa-onnx-offline-tts.exe');
		const v1 = file(root, 'voice/engine/v1.9.0/bin/sherpa-onnx-offline-tts.exe', 8);
		fs.writeFileSync(path.join(root, 'voice/engine/voice.json'), JSON.stringify({ version: 'v2.0.0', tts: v2 }));
		// engine: engine.json keeps current b200 + rollback b100; b150 is dead weight.
		const b200 = file(root, 'engine/b200-vulkan/llama-server.exe');
		const b100 = file(root, 'engine/b100-vulkan/llama-server.exe');
		const b150 = file(root, 'engine/b150-vulkan/llama-server.exe', 8);
		const staleArchive = file(root, 'engine/llama-b9999-bin-win-vulkan-x64.zip', 8);
		fs.writeFileSync(path.join(root, 'engine/engine.json'), JSON.stringify({ version: 'b200', backend: 'vulkan', server: b200, previous: { version: 'b100', backend: 'vulkan', server: b100 } }));
		// studio: studio.json points at the master build; an older tag is unreferenced.
		const current = file(root, 'studio/engine/master-929-vulkan/sd-server.exe');
		const old = file(root, 'studio/engine/master-800-vulkan/sd-server.exe', 8);
		fs.writeFileSync(path.join(root, 'studio/engine/studio.json'), JSON.stringify({ version: 'master-929', backend: 'vulkan', server: current }));
		sweepStorage(root, now);
		assert.ok(fs.existsSync(v2) && !fs.existsSync(v1), 'referenced voice version kept, unreferenced removed');
		assert.ok(fs.existsSync(b200) && fs.existsSync(b100) && !fs.existsSync(b150), 'current and rollback builds kept, extras removed');
		assert.ok(!fs.existsSync(staleArchive), 'stale runtime archive removed');
		assert.ok(fs.existsSync(current) && !fs.existsSync(old), 'referenced studio build kept, unreferenced removed');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fresh runtimes and a sibling installer survive cleanup before their install pointer is published', () => {
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const { acquireRuntimeLease } = require(OUT + '/runtimeLease.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		const fresh = file(root, 'engine/b999-cuda/unpacked.dll');
		const old = file(root, 'engine/b998-cuda/unused.dll', 9);
		const voice = file(root, 'voice/engine/v3/bin/tts.exe');
		fs.writeFileSync(path.join(root, 'voice/engine/voice.json'), JSON.stringify({ tts: file(root, 'voice/engine/v2/bin/tts.exe') }));
		sweepStorage(root, now);
		assert.ok(fs.existsSync(fresh) && fs.existsSync(voice), 'fresh unpublished versions survive');
		assert.ok(!fs.existsSync(old), 'abandoned old version is still reclaimed');
		const active = file(root, 'engine/b997-cuda/unpacked.dll', 9);
		const release = acquireRuntimeLease(path.join(root, 'engine'));
		assert.ok(release);
		try {
			const child = require('child_process').spawnSync(process.execPath, ['-e', 'const {acquireRuntimeLease}=require(process.argv[1]); const release=acquireRuntimeLease(process.argv[2]); if(release){release();process.exit(1)}', OUT + '/runtimeLease.js', path.join(root, 'engine')], { encoding:'utf8' });
			assert.equal(child.status, 0, child.stderr);
			sweepStorage(root, now);
			assert.ok(fs.existsSync(active), 'an active lease protects even an old directory');
		} finally { release(); }
		sweepStorage(root, now);
		assert.ok(!fs.existsSync(active), 'released abandoned version is reclaimed');
	} finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('runtime installers refuse a held maintenance lease and release it after failure', async () => {
	const { acquireRuntimeLease } = require(OUT + '/runtimeLease.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	const installers = [
		(dir, progress) => require(OUT + '/localEngine.js').installEngine(dir, 'cpu', progress, new AbortController().signal),
		(dir, progress) => require(OUT + '/localStudio.js').installStudio(dir, 'cpu', progress, new AbortController().signal),
		(dir, progress) => require(OUT + '/localVoice.js').installVoice(dir, progress, new AbortController().signal)
	];
	try {
		for (const install of installers) {
			const release = acquireRuntimeLease(root);
			try { await assert.rejects(install(root, () => {}), /another project/); }
			finally { release(); }
			await assert.rejects(install(root, () => { throw new Error('fixture interruption'); }), /fixture interruption|no build/);
			const next = acquireRuntimeLease(root);
			assert.ok(next, 'failed install releases its lease'); next();
		}
	} finally { fs.rmSync(root, { recursive:true, force:true }); }
});

test('runtime leases recover a crashed owner and fresh extraction protects old archive timestamps', () => {
	const { acquireRuntimeLease } = require(OUT + '/runtimeLease.js');
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		const dir = path.join(root, 'engine');
		const child = require('child_process').spawnSync(process.execPath, ['-e', 'if(!require(process.argv[1]).acquireRuntimeLease(process.argv[2]))process.exit(1)', OUT + '/runtimeLease.js', dir], {encoding:'utf8'});
		assert.equal(child.status, 0, child.stderr);
		const recovered = acquireRuntimeLease(dir);
		assert.ok(recovered, 'a dead installer cannot permanently block maintenance'); recovered();
		const target = path.join(dir, 'b999-cpu', 'old-from-archive.dll');
		fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, 'runtime');
		const old = new Date(Date.now() - 30 * DAY); fs.utimesSync(target, old, old);
		sweepStorage(root);
		assert.ok(fs.existsSync(target), 'new extraction directory protects old archived file mtimes');
	} finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('empty model directories left by deletions go away', () => {
	const { sweepStorage } = require(OUT + '/host/storageSweep.js');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
	try {
		fs.mkdirSync(path.join(root, 'models/unsloth/Repo'), { recursive: true });
		fs.mkdirSync(path.join(root, 'studio/models/owner--repo'), { recursive: true });
		const keepFile = file(root, 'models/unsloth/Live/model.gguf');
		sweepStorage(root, now);
		assert.ok(!fs.existsSync(path.join(root, 'models/unsloth/Repo')), 'empty model dir removed');
		assert.ok(!fs.existsSync(path.join(root, 'studio/models/owner--repo')), 'empty studio dir removed');
		assert.ok(fs.existsSync(keepFile), 'models with files untouched');
	} finally { fs.rmSync(root, { recursive: true, force: true }); }
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try { await fn(); console.log(`ok - ${name}`); } catch (e) { failed++; console.error(`FAIL - ${name}\n${e && e.stack || e}`); }
	}
	process.exitCode = failed ? 1 : 0;
})();
