// Local models by category (Coding / Images / Videos): the strict
// "fits my machine" ratings, the machine check, and the Studio's pure helpers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const OUT = path.join(__dirname, '..', 'out');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let failed = 0;

const GB = 1e9;
const GiB = 1024 ** 3;
const C = () => require(OUT + '/localCatalog.js');
const { machineCapacity } = require(OUT + '/localModels.js');
const machine = (o) => machineCapacity({ platform: 'win32', cpu: 'x', cores: 16, unifiedMemory: false, freeDiskBytes: 500 * GB, ...o });

// Machines this one is not.
const M = {
	cpu8: () => machine({ totalMemoryBytes: 8 * GiB, cores: 4 }),
	igpu32: () => machine({ totalMemoryBytes: 32 * GiB, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)' }),
	rtx4060: () => machine({ totalMemoryBytes: 32 * GiB, gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU', gpuMemoryBytes: 8 * GiB }),
	rtx4090: () => machine({ totalMemoryBytes: 64 * GiB, gpuName: 'NVIDIA GeForce RTX 4090', gpuMemoryBytes: 24 * GiB }),
	m3max: () => machine({ platform: 'darwin', totalMemoryBytes: 64 * GiB, gpuName: 'Apple M3 Max (unified memory)', unifiedMemory: true }),
	ws: () => machine({ totalMemoryBytes: 128 * GiB, gpuName: 'NVIDIA RTX PRO 6000', gpuMemoryBytes: 96 * GiB })
};

test('machine profile: where the weights live, measured bandwidth wins for shared memory', () => {
	const { machineProfile, integratedGpu } = C();
	assert.strictEqual(machineProfile(M.rtx4090()).gpu, 'dedicated');
	assert.strictEqual(machineProfile(M.m3max()).gpu, 'unified');
	assert.strictEqual(machineProfile(M.cpu8()).gpu, 'none');
	// The iGPU's driver reports 16 GB (llama.cpp sees the shared pool): still shared RAM, not VRAM.
	const ig = machine({ totalMemoryBytes: 32 * GiB, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)', gpuMemoryBytes: 16 * GiB });
	assert.strictEqual(machineProfile(ig).gpu, 'shared');
	assert.ok(integratedGpu('AMD Radeon(TM) Graphics') && integratedGpu('AMD Radeon 890M') && !integratedGpu('NVIDIA GeForce RTX 4090'));
	const est = machineProfile(M.igpu32());
	const meas = machineProfile(M.igpu32(), { at: 1, ramGBs: 90 });
	assert.ok(meas.measured && !est.measured);
	assert.ok(Math.abs(meas.gpuGBs - 104) <= 1, 'shared GPU bandwidth follows the RAM measurement: ' + meas.gpuGBs);
	assert.strictEqual(machineProfile(M.rtx4090(), { at: 1, ramGBs: 60 }).gpuGBs, 800, 'dedicated VRAM keeps the table value');
	assert.deepStrictEqual(['entry', 'standard', 'strong', 'workstation', 'powerhouse'].includes(machineProfile(M.ws()).tier.id), true);
	assert.strictEqual(machineProfile(M.cpu8()).tier.id, 'entry');
	assert.strictEqual(machineProfile(M.ws()).tier.id, 'powerhouse');
});

test('coding, strict: every shown model fits ≤85% of fast memory, runs ≥15 tok/s, and the list grows with the machine', () => {
	const { catalogFor, machineProfile, STRICT } = C();
	const sizes = {};
	for (const [name, mk] of Object.entries(M)) {
		const p = machineProfile(mk());
		const list = catalogFor('coding', p, { strict: true });
		sizes[name] = list.length;
		for (const x of list) {
			assert.ok(x.rating.strict && x.rating.util <= 0.85, `${name}: ${x.id} util ${x.rating.util}`);
			assert.ok(x.rating.tokS >= STRICT.coding.tokS, `${name}: ${x.id} ${x.rating.tokS} tok/s`);
			assert.strictEqual(x.kind, 'llm');
			assert.strictEqual(x.use, 'chat');
		}
		if (list.length) assert.ok(list[0].best && list.filter((x) => x.best).length === 1, name + ': exactly one best pick, first');
	}
	assert.ok(sizes.ws >= sizes.rtx4090 && sizes.rtx4090 >= sizes.rtx4060, JSON.stringify(sizes));
	assert.ok(sizes.rtx4060 >= 2, 'an 8 GB GPU gets real choices: ' + sizes.rtx4060);
	// Non-strict shows everything, with the reason the rest is hidden.
	const all = catalogFor('coding', machineProfile(M.rtx4060()), { strict: false });
	const hidden = all.filter((x) => !x.rating.strict);
	assert.ok(hidden.length && hidden.every((x) => x.rating.reason), 'hidden models say why');
	assert.ok(all.findIndex((x) => !x.rating.strict) >= all.filter((x) => x.rating.strict).length, 'strict matches come first');
});

test('coding: the quant is picked per machine — a big GPU gets a higher-quality file of the same model', () => {
	const { LLM_SEEDS, rateLlm, machineProfile } = C();
	const q35 = LLM_SEEDS.find((s) => s.id === 'qwen3.5-9b');
	const small = rateLlm(q35, 'coding', machineProfile(M.rtx4060()));
	const big = rateLlm(q35, 'coding', machineProfile(M.rtx4090()));
	const order = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'IQ4_XS', 'Q3_K_M'];
	assert.ok(order.indexOf(big.quant) <= order.indexOf(small.quant), `${big.quant} vs ${small.quant}`);
	assert.ok(big.tokS > small.tokS, 'a 4090 is faster');
	// Mixture of experts: 30B total, 3B active — fast wherever it fits.
	const coder = LLM_SEEDS.find((s) => s.id === 'qwen3-coder-30b-a3b');
	const r = rateLlm(coder, 'coding', machineProfile(M.rtx4090()));
	assert.ok(r.tokS > 60, 'MoE speed comes from the active parameters: ' + r.tokS);
	assert.ok(!rateLlm(coder, 'coding', machineProfile(M.rtx4060())).strict, 'but 19 GB does not fit an 8 GB GPU');
});

test('shared GPU memory is never counted twice in budgets, fit margins or Turbo Fit', () => {
	const { engineFit } = require(OUT + '/localModels.js');
	const { planTurbo } = require(OUT + '/turboFit.js');
	const raw = { totalMemoryBytes: 32 * GiB, gpuName: 'Intel(R) Arc(TM) 140T GPU (16GB)' };
	const without = machine(raw), reported = machine({ ...raw, gpuMemoryBytes: 16 * GiB });
	assert.strictEqual(reported.fastBudgetBytes, without.fastBudgetBytes);
	assert.strictEqual(reported.ceilingBytes, without.ceilingBytes);
	assert.deepStrictEqual(engineFit(reported), engineFit(without));
	assert.strictEqual(planTurbo({ name: 'Coder-60B-A3B', params: 60e9, sizeBytes: 34e9, machine: reported }).tier, 'disk', '34 GB cannot be declared a RAM fit on a 32 GB integrated-GPU laptop');
});

test('Coding includes text and screenshot models once; Design is removed', () => {
 const { catalogFor, machineProfile, CATEGORIES } = C();
 assert.deepStrictEqual(CATEGORIES.map(c => c.id), ['coding', 'images', 'videos', 'voice']);
 const code = catalogFor('coding', machineProfile(M.igpu32()));
 for (const id of ['qwen3-1.7b','granite-3.3-2b','qwen3-4b-instruct','granite-3.3-8b','qwen3-vl-2b','qwen3-vl-4b']) assert.strictEqual(code.filter(x=>x.id===id).length,1,id);
 assert.ok(code.find(x=>x.id==='qwen3-vl-2b').vision);
});

test('adaptive context admits larger models without exceeding the fast memory budget', () => {
	const { rateLlmAt, LLM_SEEDS, LLM_QUANTS, machineProfile, kvBytesPerToken } = C();
	const p = machineProfile(machine({ totalMemoryBytes: 32 * GiB, gpuName: 'NVIDIA GeForce RTX 4070', gpuMemoryBytes: 12 * GB })), seed = LLM_SEEDS.find((s) => s.id === 'qwen3-14b'), q = LLM_QUANTS.find((q) => q.q === 'Q4_K_M');
	const fullNeed = seed.q4Gb * GB + kvBytesPerToken(seed.params) * 32768 * 0.5 + 0.35 * GB;
	assert.ok(fullNeed > p.fastBytes * 0.85);
	const r = rateLlmAt(seed, 'coding', p, q);
	assert.ok(r.strict && r.contextReduced && r.ctx < 32768 && r.ctx >= 4096 && r.util <= 0.85, JSON.stringify(r));
	const f16 = rateLlmAt(seed, 'coding', p, q, { lightKv: false });
	assert.ok(f16.ctx <= r.ctx && f16.needBytes <= p.fastBytes * 0.85);
});

test('coding reserves vision-projector memory and coding requires confirmed tools', () => {
	const { rateLlmAt, LLM_SEEDS, LLM_QUANTS, machineProfile, seedFromHf } = C();
	const p = machineProfile(M.rtx4090()), seed = LLM_SEEDS.find((s) => s.id === 'qwen3.5-4b'), q = LLM_QUANTS[3];
	const code = rateLlmAt(seed, 'coding', p, q, { maxContext: 16384 });

	const text = rateLlmAt({ ...seed, mmprojGb: undefined }, 'coding', p, q, { maxContext: 16384 });
	assert.ok(Math.abs(code.needBytes - text.needBytes - seed.mmprojGb * GB) < 1);
	const unknown = seedFromHf({ id: 'Qwen/New-Coder-8B-GGUF', params: 8e9 }, 'coding');
	const r = rateLlmAt(unknown, 'coding', p, q);
	assert.ok(!r.strict && /not confirmed/.test(r.reason));
});

test('download selection checks actual files, projectors, disk and available quants', () => {
	const { pickLlmFile, LLM_SEEDS, machineProfile } = C();
	const p = machineProfile(M.igpu32()), seed = LLM_SEEDS.find((s) => s.id === 'qwen3-4b-instruct');
	const file = (quant, sizeBytes, name = 'model-' + quant + '.gguf') => ({ name, quant, sizeBytes });
	const files = [file('Q8_0', 40 * GB), file('Q4_K_M', 2.6 * GB)];
	const picked = pickLlmFile(seed, 'coding', p, files);
	assert.strictEqual(picked.file.quant, 'Q4_K_M');
	assert.strictEqual(picked.rating.downloadBytes, 2.6 * GB);
	assert.strictEqual(pickLlmFile(seed, 'coding', p, [files[0]]), undefined, 'no arbitrary oversized fallback');
	assert.strictEqual(pickLlmFile(seed, 'coding', { ...p, diskBytes: 2 * GB }, files), undefined);
	const vision = LLM_SEEDS.find((s) => s.id === 'qwen3-vl-4b');
	assert.strictEqual(pickLlmFile(vision, 'coding', p, files), undefined, 'missing projector');
	const projector = { ...file('Q8_0', 0.5 * GB, 'mmproj-Q8_0.gguf'), mmproj: true };
	assert.strictEqual(pickLlmFile(vision, 'coding', p, [...files, projector]).rating.downloadBytes, 3.1 * GB);
});

test('Auto loads at the context estimated from actual files and honors the 4K fit floor', () => {
	const { LocalCatalogHost } = require(OUT + '/host/localCatalogHost.js');
	const { EngineServer } = require(OUT + '/localEngine.js');
	const { LLM_SEEDS, machineProfile } = C();
	const seed = LLM_SEEDS.find((s) => s.id === 'qwen3-14b');
	const model = { id: 'Qwen3-14B-Q4_K_M', repo: seed.repo, quant: 'Q4_K_M', sizeBytes: 9.00175296 * GB, path: '/model.gguf', source: 'zer0ne' };
	const p = machineProfile(machine({ totalMemoryBytes: 32 * GiB, gpuName: 'NVIDIA GeForce RTX 4070', gpuMemoryBytes: 12 * GB }));
	const ctx = LocalCatalogHost.prototype.contextFor.call({ discovery: { current: () => [] }, profile: () => p }, model, 32768, true);
	assert.ok(ctx < 32768 && ctx >= 4096);
	const args = new EngineServer(() => {}).args(model, { context: 4096, port: 8181, gpu: 'auto', lightKv: true, fitMarginMiB: 2048, cacheRamMiB: 512 });
	assert.strictEqual(args[args.indexOf('-c') + 1], '4096');
	assert.strictEqual(args[args.indexOf('--fit-ctx') + 1], '4096');
});

test('calibration: measured speeds correct every estimate', () => {
	const { LLM_SEEDS, LLM_QUANTS, rateLlmAt, machineProfile } = C();
	const { calibration } = require(OUT + '/machineCheck.js');
	assert.deepStrictEqual(calibration([]), { samples: 0 });
	assert.strictEqual(calibration([{ measured: 10, estimated: 20 }, { measured: 30, estimated: 20 }, { measured: 9, estimated: 10 }]).factor, 0.9, 'median, not mean');
	assert.strictEqual(calibration([{ measured: 1, estimated: 100 }]).factor, 0.35, 'clamped');
	const s = LLM_SEEDS.find((x) => x.id === 'qwen3.5-4b');
	// One build under both: the recommended build itself moves when speeds change.
	const q4 = LLM_QUANTS.find((q) => q.q === 'Q4_K_M');
	const base = rateLlmAt(s, 'coding', machineProfile(M.igpu32()), q4);
	const slow = rateLlmAt(s, 'coding', machineProfile(M.igpu32(), { at: 1, llmFactor: 0.5 }), q4);
	assert.ok(slow.tokS < base.tokS * 0.6 && slow.measured);
});

test('images and videos: strict means quick here, sizes shrink to stay quick, no GPU = nothing strict', () => {
	const { catalogFor, machineProfile, STRICT, rateDiffusion, DIFFUSION_BUNDLES } = C();
	for (const [name, mk] of Object.entries(M)) {
		const p = machineProfile(mk());
		for (const cat of ['images', 'videos']) {
			for (const x of catalogFor(cat, p, { strict: true })) {
				assert.ok(x.rating.seconds <= (cat === 'videos' ? STRICT.videoSeconds : STRICT.imageSeconds), `${name} ${x.id} ${x.rating.seconds}s`);
				assert.strictEqual(x.use, 'studio');
				assert.strictEqual(x.kind, cat === 'videos' ? 'video' : 'image');
			}
		}
	}
	assert.strictEqual(catalogFor('images', machineProfile(M.cpu8()), { strict: true }).length, 0, 'CPU only: images take minutes');
	assert.ok(catalogFor('images', machineProfile(M.rtx4090()), { strict: true }).length >= 4, 'a 4090 runs the image models');
	assert.ok(catalogFor('videos', machineProfile(M.rtx4090()), { strict: true }).length >= 2, 'and video');
	const z = DIFFUSION_BUNDLES.find((b) => b.id === 'z-image-turbo');
	const fast = rateDiffusion(z, 'images', machineProfile(M.rtx4090()));
	const slow = rateDiffusion(z, 'images', machineProfile(M.igpu32()));
	assert.deepStrictEqual(fast.size, [1024, 1024]);
	assert.ok(slow.size[0] < 1024, 'an iGPU gets a smaller default size: ' + slow.size);
	assert.ok(slow.seconds > fast.seconds);
	// Calibration: a real run corrects the estimate — but only against the formula it was learned with.
	const { CALIBRATION } = C();
	const tuned = rateDiffusion(z, 'images', machineProfile(M.rtx4090(), { at: 1, calibV: CALIBRATION, diffFactor: { 'z-image-turbo': 3 } }));
	const stale = rateDiffusion(z, 'images', machineProfile(M.rtx4090(), { at: 1, calibV: CALIBRATION - 1, diffFactor: { 'z-image-turbo': 3 } }));
	assert.ok(tuned.seconds > fast.seconds * 1.5 && tuned.measured, 'measured slowness is applied');
	assert.strictEqual(stale.seconds, fast.seconds, 'factors from an older formula are ignored');
	const ltx = DIFFUSION_BUNDLES.find((b) => b.id === 'ltx-2.3');
	assert.strictEqual(rateDiffusion(ltx, 'videos', machineProfile(M.cpu8())).verdict, 'no', '25 GB of files cannot run in 8 GB');
});

test('Images retains image generators and has no duplicate language models', () => {
 const {catalogFor,machineProfile}=C();
 const list=catalogFor('images',machineProfile(M.rtx4090()),{strict:false});
 assert.ok(list.some(x=>x.id==='qwen-image2512') || list.length>0);
 assert.ok(list.every(x=>x.kind==='image'));
 assert.ok(list.some(x=>x.id==='sd15'));
 assert.strictEqual(list.filter(x=>x.best).length,1);
});

test('catalog data: valid repos and files, sizes positive, ids unique, no gated or HTTP sources', () => {
	const { LLM_SEEDS, DIFFUSION_BUNDLES, bundleBytes } = C();
	const { validRepoId } = require(OUT + '/localEngine.js');
	const ids = new Set();
	for (const s of LLM_SEEDS) {
		assert.ok(!ids.has(s.id) && ids.add(s.id), 'unique ' + s.id);
		assert.ok(validRepoId(s.repo), s.repo);
		assert.ok(s.q4Gb > 0 && s.params > 0 && (!s.active || s.active < s.params), s.id);
		assert.ok(Object.keys(s.quality).length, s.id);
	}
	for (const b of DIFFUSION_BUNDLES) {
		assert.ok(!ids.has(b.id) && ids.add(b.id), 'unique ' + b.id);
		assert.ok(b.files.some((f) => f.role === 'diffusion' || f.role === 'model'), b.id);
		for (const f of b.files) assert.ok(validRepoId(f.repo) && !f.file.includes('..') && !f.file.startsWith('/') && f.bytes > 1e8, b.id + ' ' + f.file);
		assert.ok(bundleBytes(b) > 1e9 && b.sizes.length && b.sizes.every(([w, h]) => w % 16 === 0 && h % 16 === 0), b.id);
	}
});

test('fresh Hugging Face models become seeds; quant files resolve by label', () => {
	const { seedFromHf, fileForQuant } = C();
	const s = seedFromHf({ id: 'unsloth/Foo-Coder-14B-GGUF', params: 14e9, updated: '2026-08-01', downloads: 120000 }, 'coding');
	assert.ok(s.fresh && s.quality.coding > 50 && s.repo === 'unsloth/Foo-Coder-14B-GGUF');
	assert.ok(seedFromHf({ id: 'a/VL-4B-GGUF', params: 4e9, vision: true }, 'coding').mmprojGb);
	assert.strictEqual(seedFromHf({ id: 'a/tiny', params: 0.5e9 }, 'coding'), undefined);
	assert.strictEqual(seedFromHf({ id: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF', params: 3e9, created: '2024-11-09', updated: '2026-09-01' }, 'coding', Date.parse('2026-10-05')), undefined, 'an old repo is not new');
	const moe = seedFromHf({ id: 'unsloth/Bar-30B-A3B-GGUF', params: 30e9, updated: '2026-01-01' }, 'coding');
	assert.ok(Math.abs(moe.active - 3) < 0.01);
	const files = [{ name: 'X-UD-Q4_K_M.gguf', quant: 'UD-Q4_K_M' }, { name: 'X-Q4_K_M.gguf', quant: 'Q4_K_M' }, { name: 'mmproj-F16.gguf', quant: 'F16', mmproj: true }, { name: 'X-Q8_0.gguf', quant: 'Q8_0' }];
	assert.strictEqual(fileForQuant(files, 'Q4_K_M').name, 'X-Q4_K_M.gguf');
	assert.strictEqual(fileForQuant([files[0]], 'Q4_K_M').name, 'X-UD-Q4_K_M.gguf', 'UD-only repos still resolve');
	assert.strictEqual(fileForQuant(files, 'Q6_K'), undefined);
	// A repo with a small multi-token-prediction head in the same quant (seen: unsloth/gemma-4-E2B-it-GGUF).
	const gemma = [{ name: 'mtp-gemma-4-E2B-it-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 0.1e9 }, { name: 'gemma-4-E2B-it-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 5.4e9 }];
	assert.strictEqual(fileForQuant(gemma, 'Q8_0').name, 'gemma-4-E2B-it-Q8_0.gguf');
});

test('studio: release asset per OS/GPU, unsupported systems say so', () => {
	const { pickStudioAsset, studioSupported } = require(OUT + '/localStudio.js');
	const names = ['cudart-sd-bin-win-cu12-x64.zip', 'sd-master-3f8527a-bin-Darwin-macOS-26.6.2-arm64.zip', 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip', 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip', 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip', 'sd-master-3f8527a-bin-win-cpu-x64.zip', 'sd-master-3f8527a-bin-win-cuda12-x64.zip', 'sd-master-3f8527a-bin-win-rocm-7.14.0-x64.zip', 'sd-master-3f8527a-bin-win-vulkan-x64.zip'];
	assert.strictEqual(pickStudioAsset(names, 'vulkan', 'win32', 'x64'), 'sd-master-3f8527a-bin-win-vulkan-x64.zip');
	assert.strictEqual(pickStudioAsset(names, 'cuda', 'win32', 'x64'), 'sd-master-3f8527a-bin-win-cuda12-x64.zip');
	assert.strictEqual(pickStudioAsset(names, 'cpu', 'win32', 'x64'), 'sd-master-3f8527a-bin-win-cpu-x64.zip');
	assert.strictEqual(pickStudioAsset(names, 'vulkan', 'linux', 'x64'), 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip');
	assert.strictEqual(pickStudioAsset(names, 'cpu', 'linux', 'x64'), 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip');
	assert.strictEqual(pickStudioAsset(names, 'rocm', 'linux', 'x64'), 'sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64-rocm-7.14.0.zip');
	assert.strictEqual(pickStudioAsset(names, 'metal', 'darwin', 'arm64'), 'sd-master-3f8527a-bin-Darwin-macOS-26.6.2-arm64.zip');
	assert.strictEqual(pickStudioAsset(names, 'metal', 'darwin', 'x64'), undefined, 'Intel Macs: no build');
	assert.strictEqual(pickStudioAsset(names, 'vulkan', 'linux', 'arm64'), undefined);
	assert.ok(studioSupported('win32', 'x64') && studioSupported('darwin', 'arm64') && !studioSupported('win32', 'arm64'));
});

test('studio: server arguments and job bodies per bundle', () => {
	const { serverArgs, jobBody, bundleFilePath, studioFailure } = require(OUT + '/localStudio.js');
	const { DIFFUSION_BUNDLES } = C();
	const z = DIFFUSION_BUNDLES.find((b) => b.id === 'z-image-turbo');
	const args = serverArgs(z, '/m', 8191, 'vulkan');
	assert.ok(args.includes('--diffusion-model') && args.includes('--vae') && args.includes('--llm'));
	assert.ok(!args.includes('--offload-to-cpu') && !args.includes('--vae-tiling'), 'auto-fit places weights; forcing these made a Wan decode run on the CPU for 20+ minutes');
	assert.strictEqual(args[args.indexOf('--listen-ip') + 1], '127.0.0.1', 'loopback only');
	assert.ok(!args.includes('--diffusion-fa'), 'no flash attention flag on Vulkan');
	assert.ok(serverArgs(z, '/m', 8191, 'cuda').includes('--diffusion-fa'));
	assert.strictEqual(args[args.indexOf('--diffusion-model') + 1], bundleFilePath('/m', z.files[0]));
	// Flat: no repo sub-folders (Windows' 260-character path limit), one folder per repo.
	const wanFile = DIFFUSION_BUNDLES.find((b) => b.id === 'wan2.1-1.3b').files[0];
	assert.strictEqual(path.relative('/m', bundleFilePath('/m', wanFile)).split(path.sep).length, 2);
	assert.ok(path.relative('/m', bundleFilePath('/m', wanFile)).startsWith('Comfy-Org--Wan_2.1_ComfyUI_repackaged'));
	assert.ok(/missing or cannot be read/.test(studioFailure("[ERROR] cannot inspect model source 'x': The system cannot find the path specified.")));
	const sd = DIFFUSION_BUNDLES.find((b) => b.id === 'sd15');
	assert.ok(serverArgs(sd, '/m', 1, 'cpu').includes('-m'));
	const wan = DIFFUSION_BUNDLES.find((b) => b.id === 'wan2.1-1.3b');
	const wargs = serverArgs(wan, '/m', 1, 'vulkan');
	assert.ok(wargs.includes('--t5xxl') && wargs.includes('--flow-shift'));
	const img = jobBody(z, { prompt: 'a cat', width: 768, height: 768 });
	assert.strictEqual(img.output_format, 'png');
	assert.strictEqual(img.sample_params.sample_steps, 8);
	assert.strictEqual(img.sample_params.guidance.txt_cfg, 1);
	assert.strictEqual(img.seed, -1);
	const vid = jobBody(wan, { prompt: 'a cat', width: 832, height: 480, seed: 7 });
	assert.strictEqual(vid.output_format, 'webm');
	assert.strictEqual(vid.video_frames, 33);
	assert.strictEqual(vid.seed, 7);
	assert.ok(vid.negative_prompt.length > 0 && vid.batch_count === undefined);
	assert.ok(/memory/.test(studioFailure('ggml_vulkan: ErrorOutOfDeviceMemory')));
	assert.ok(/Vulkan/.test(studioFailure('cannot load vulkan-1.dll')));
});

test('studio: Node unzip (Linux has no zip-reading tar) refuses paths outside the folder', () => {
	const { unzip } = require(OUT + '/localStudio.js');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zc-unzip-'));
	const mkZip = (entries) => {
		const locals = [];
		const centrals = [];
		let offset = 0;
		for (const [name, text, deflate] of entries) {
			const raw = Buffer.from(text);
			const data = deflate ? zlib.deflateRawSync(raw) : raw;
			const nameBuf = Buffer.from(name);
			const lh = Buffer.alloc(30);
			lh.writeUInt32LE(0x04034b50, 0);
			lh.writeUInt16LE(deflate ? 8 : 0, 8);
			lh.writeUInt32LE(data.length, 18);
			lh.writeUInt32LE(raw.length, 22);
			lh.writeUInt16LE(nameBuf.length, 26);
			const ch = Buffer.alloc(46);
			ch.writeUInt32LE(0x02014b50, 0);
			ch.writeUInt16LE(deflate ? 8 : 0, 10);
			ch.writeUInt32LE(data.length, 20);
			ch.writeUInt32LE(raw.length, 24);
			ch.writeUInt16LE(nameBuf.length, 28);
			ch.writeUInt32LE((0o100755 << 16) >>> 0, 38);
			ch.writeUInt32LE(offset, 42);
			locals.push(lh, nameBuf, data);
			centrals.push(ch, nameBuf);
			offset += 30 + nameBuf.length + data.length;
		}
		const cd = Buffer.concat(centrals);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(entries.length, 8);
		end.writeUInt16LE(entries.length, 10);
		end.writeUInt32LE(cd.length, 12);
		end.writeUInt32LE(offset, 16);
		return Buffer.concat([...locals, cd, end]);
	};
	const good = path.join(dir, 'good.zip');
	fs.writeFileSync(good, mkZip([['bin/sd-server', 'hello server', true], ['readme.txt', 'stored', false]]));
	const out = unzip(good, path.join(dir, 'x'));
	assert.strictEqual(out.length, 2);
	assert.strictEqual(fs.readFileSync(path.join(dir, 'x', 'bin', 'sd-server'), 'utf8'), 'hello server');
	assert.strictEqual(fs.readFileSync(path.join(dir, 'x', 'readme.txt'), 'utf8'), 'stored');
	const evil = path.join(dir, 'evil.zip');
	fs.writeFileSync(evil, mkZip([['../escape.txt', 'no', false]]));
	assert.throws(() => unzip(evil, path.join(dir, 'y')), /outside/);
	assert.ok(!fs.existsSync(path.join(dir, 'escape.txt')));
	fs.rmSync(dir, { recursive: true, force: true });
});

test('voice: sherpa-onnx build per OS, arguments per engine, strict = faster than real time', () => {
	const { pickVoiceAsset, voiceSupported, voiceArgs } = require(OUT + '/localVoice.js');
	const { VOICE_BUNDLES, rateVoice, catalogFor, machineProfile, voiceThreads } = C();
	const names = ['sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2', 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Debug.tar.bz2', 'sherpa-onnx-v1.13.8-osx-universal2-shared.tar.bz2', 'sherpa-onnx-v1.13.8-osx-arm64-shared.tar.bz2', 'sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2', 'sherpa-onnx-v1.13.8-linux-x64-shared-no-tts.tar.bz2', 'sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2'];
	assert.strictEqual(pickVoiceAsset(names, 'win32', 'x64'), 'sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2');
	assert.strictEqual(pickVoiceAsset(names, 'darwin', 'x64'), 'sherpa-onnx-v1.13.8-osx-universal2-shared.tar.bz2', 'Intel Macs get the universal build');
	assert.strictEqual(pickVoiceAsset(names, 'linux', 'x64'), 'sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2', 'never the no-tts build');
	assert.strictEqual(pickVoiceAsset(names, 'linux', 'arm64'), 'sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2');
	assert.strictEqual(pickVoiceAsset(names, 'win32', 'arm64'), undefined);
	assert.ok(voiceSupported('darwin', 'x64') && !voiceSupported('win32', 'arm64'));
	const kokoro = VOICE_BUNDLES.find((v) => v.id === 'kokoro');
	assert.ok(kokoro.speakers.length > 40 && !kokoro.speakers.some((s) => s.lang === 'ja'), 'Kokoro voices, no Japanese (no lexicon shipped)');
	const heart = kokoro.speakers.find((s) => s.name.startsWith('Heart'));
	const a1 = voiceArgs(kokoro, '/m', heart.id, 1, 4, '/o.wav');
	assert.ok(a1.some((x) => x.startsWith('--kokoro-model=')) && a1.some((x) => /--kokoro-lexicon=.*lexicon-us-en/.test(x)) && a1.includes('--sid=' + heart.id) && a1.includes('--num-threads=4'));
	const french = kokoro.speakers.find((s) => s.lang === 'fr');
	assert.ok(voiceArgs(kokoro, '/m', french.id, 1, 4, '/o.wav').includes('--kokoro-lang=fr'));
	const piper = VOICE_BUNDLES.find((v) => v.id === 'piper-lessac');
	const a2 = voiceArgs(piper, '/m', 0, 1.2, 2, '/o.wav');
	assert.ok(a2.some((x) => x.startsWith('--vits-model=')) && !a2.some((x) => x.startsWith('--sid')) && a2.includes('--vits-length-scale=0.83'));
	assert.strictEqual(voiceThreads(16), 8);
	assert.strictEqual(voiceThreads(4), 2);
	const fast = rateVoice(kokoro, { cores: 16, ramBytes: 32e9 });
	const slow = rateVoice(kokoro, { cores: 4, ramBytes: 8e9 });
	assert.ok(fast.strict && fast.rtf < 0.3, 'measured 0.22 on a 16-core laptop: ' + fast.rtf);
	assert.ok(slow.rtf > fast.rtf * 3 && !slow.strict, 'a 4-core machine is slower than real time');
	assert.ok(rateVoice(piper, { cores: 4, ramBytes: 8e9 }).strict, 'Piper is fast anywhere');
	const list = catalogFor('voice', machineProfile(M.igpu32()), { strict: false, cores: 16 });
	assert.strictEqual(list.length, VOICE_BUNDLES.length);
	assert.ok(list.every((x) => x.kind === 'voice' && x.use === 'studio'));
	assert.ok(list[0].best && list[0].id === 'kokoro', 'Kokoro is the best pick on a fast CPU');
});

test('machine check: bandwidth is measured with worker threads', async () => {
	const { measureBandwidth } = require(OUT + '/machineCheck.js');
	const r = await measureBandwidth({ threads: 2, ms: 150, mb: 8 });
	assert.ok(r && r.gbs > 0.5 && r.threads === 2, JSON.stringify(r));
});

test('setup: three picks are unique, mapped, and reuse installed models', () => {
	const { setupPicks } = require(OUT + '/localSetup.js');
	const item = (id, rating) => ({ id, kind: 'llm', name: id, blurb: '', repo: 'owner/' + id, license: '', released: '', tools: true, use: 'chat', speed: '', rating: { verdict: 'good', strict: true, util: 0.5, needBytes: 4 * GB, downloadBytes: 3 * GB, score: 80, quant: 'Q4_K_M', tokS: 20, ctx: 16384, ...rating } });
	const picks = setupPicks([item('a', { score: 90, tokS: 40 }), item('b', { score: 70, tokS: 10 })], new Map([['owner/a', 'a-q4']]), 500 * GB);
	assert.ok(picks.length >= 1 && picks.length <= 3);
	assert.equal(new Set(picks.map((p) => p.id)).size, picks.length, 'no model is offered twice');
	assert.ok(picks.every((p) => ['fast', 'balanced', 'quality'].includes(p.preset)));
	assert.ok(picks.every((p) => p.sizeGb === 3 && p.quant === 'Q4_K_M' && p.context === 16384));
	assert.equal(picks.find((p) => p.id === 'a').installedModelId, 'a-q4', 'an installed repository points at its GGUF');
	assert.deepEqual(setupPicks([item('a', {})]).map((p) => p.id), ['a'], 'one eligible model fills one card');
	assert.deepEqual(setupPicks([{ ...item('c', {}), tools: false }]), [], 'a model without tool calls is not a setup pick');
});

(async () => {
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log('ok  ' + name);
		} catch (e) {
			failed++;
			console.error('FAIL ' + name + '\n', e);
		}
	}
	console.log(failed ? `\n${failed} LOCAL CATALOG TEST(S) FAILED` : '\nALL LOCAL CATALOG TESTS PASSED');
	process.exitCode = failed ? 1 : 0;
})();
