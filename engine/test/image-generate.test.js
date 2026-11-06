'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname, '../out');

// The tool modules load the editor API at require time; give them the desktop shim.
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-image-gen-')));
const project = path.join(base, 'project');
fs.mkdirSync(project);
const { createShim, install } = require('./vscode-shim');
install(createShim({ workspace: project, dataDir: path.join(base, 'data') }).vscode);

const spec = require(path.join(OUT, 'tools/imageSpec'));
const { imagesUrl } = require(path.join(OUT, 'chatClient'));
const { DEFAULT_SETTINGS } = require(path.join(OUT, 'providerStore'));
const { buildToolDefs } = require(path.join(OUT, 'tools/agentTools'));

const bundles = new Set(['sd15', 'flux2-klein-4b']);

test('parseImageTarget reads provider/model, local: and bare bundle ids', () => {
	assert.deepEqual(spec.parseImageTarget('openai/gpt-image-1', bundles), { kind: 'cloud', providerId: 'openai', modelId: 'gpt-image-1' });
	// Only the first slash separates provider from model, so slashed model ids survive.
	assert.deepEqual(spec.parseImageTarget('openrouter/google/gemini-2.5-flash-image', bundles), {
		kind: 'cloud',
		providerId: 'openrouter',
		modelId: 'google/gemini-2.5-flash-image'
	});
	assert.deepEqual(spec.parseImageTarget('local:flux2-klein-4b', bundles), { kind: 'local', bundleId: 'flux2-klein-4b' });
	assert.deepEqual(spec.parseImageTarget('local:', bundles), { kind: 'local', bundleId: undefined });
	assert.deepEqual(spec.parseImageTarget('sd15', bundles), { kind: 'local', bundleId: 'sd15' });
	assert.equal(spec.parseImageTarget('', bundles), undefined);
	assert.equal(spec.parseImageTarget(undefined, bundles), undefined);
	assert.equal(spec.parseImageTarget('  ', bundles), undefined);
	assert.equal(spec.parseImageTarget('not-a-model', bundles), undefined);
	assert.equal(spec.parseImageTarget('provider/', bundles), undefined);
});

test('imageSize accepts WxH (x or ×) and rejects nonsense', () => {
	assert.deepEqual(spec.imageSize('1024x1024'), { width: 1024, height: 1024 });
	assert.deepEqual(spec.imageSize(' 1536 × 1024 '), { width: 1536, height: 1024 });
	assert.deepEqual(spec.imageSize('64x64'), { width: 64, height: 64 });
	assert.equal(spec.imageSize('auto'), undefined);
	assert.equal(spec.imageSize(''), undefined);
	assert.equal(spec.imageSize('1024'), undefined);
	assert.equal(spec.imageSize('10x10'), undefined);
	assert.equal(spec.imageSize('5000x5000'), undefined);
	assert.equal(spec.sizeText({ width: 1024, height: 768 }), '1024x768');
	assert.equal(spec.sizeText(undefined), undefined);
});

test('defaultImageName is a workspace-relative images/ path', () => {
	const at = new Date('2026-10-30T14:05:09.123Z');
	assert.equal(spec.defaultImageName('A red fox in the snow!', at), 'images/2026-10-30T14-05-09-a-red-fox-in-the-snow.png');
	assert.equal(spec.defaultImageName('', at), 'images/2026-10-30T14-05-09-image.png');
	const long = spec.defaultImageName('x'.repeat(80), at);
	assert.ok(long.endsWith('-' + 'x'.repeat(40) + '.png'), long);
});

test('sniffImageMime and pngSize read the real bytes', () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 0x02, 0x58]);
	assert.equal(spec.sniffImageMime(png), 'image/png');
	assert.deepEqual(spec.pngSize(png), { width: 800, height: 600 });
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
	assert.equal(spec.sniffImageMime(jpeg), 'image/jpeg');
	const webp = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1');
	assert.equal(spec.sniffImageMime(webp), 'image/webp');
	assert.equal(spec.sniffImageMime(Buffer.from('not an image at all')), undefined);
	assert.equal(spec.pngSize(Buffer.from('nope')), undefined);
	assert.equal(spec.extensionForMime('image/jpeg'), '.jpg');
	assert.equal(spec.extensionForMime('image/webp'), '.webp');
	assert.equal(spec.extensionForMime('image/png'), '.png');
	assert.equal(spec.extensionForMime(undefined), '.png');
});

test('imagesUrl accepts a base URL or a pasted endpoint', () => {
	assert.equal(imagesUrl('https://api.openai.com/v1'), 'https://api.openai.com/v1/images/generations');
	assert.equal(imagesUrl('https://api.openai.com/v1/'), 'https://api.openai.com/v1/images/generations');
	assert.equal(imagesUrl('https://api.openai.com/v1/images/generations'), 'https://api.openai.com/v1/images/generations');
	assert.equal(imagesUrl('https://proxy.example/v1/chat/completions'), 'https://proxy.example/v1/images/generations');
});

test('image_generate is offered only when the setting is on', () => {
	const off = buildToolDefs({ ...DEFAULT_SETTINGS, imageGenerate: false });
	assert.equal(off.some((tool) => tool.name === 'image_generate'), false);
	const on = buildToolDefs({ ...DEFAULT_SETTINGS, imageGenerate: true });
	const def = on.find((tool) => tool.name === 'image_generate');
	assert.ok(def);
	assert.deepEqual(def.parameters.required, ['prompt']);
	assert.equal(def.parameters.additionalProperties, false);
	assert.equal(def.parameters.properties.prompt.type, 'string');
});

// A 24-byte PNG header is enough: the tool reads the format and dimensions, not the pixels.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x02, 0x58]);

function imageServer(reply) {
	return new Promise((resolve) => {
		const server = require('node:http').createServer(reply);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

function cloudContext(port, extra = {}) {
	return {
		settings: { ...DEFAULT_SETTINGS, imageGenerate: true, imageGenModel: 'fake/painter' },
		signal: new AbortController().signal,
		vision: false,
		requestApproval: async () => ({ approved: true, finish() {} }),
		store: {
			get: async () => ({ id: 'fake', name: 'Fake', apiFormat: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` }),
			getApiKey: async () => 'test-key'
		},
		...extra
	};
}

test('image_generate saves a provider image and reports it', async () => {
	let seen;
	const server = await imageServer((req, res) => {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
		});
	});
	try {
		const port = server.address().port;
		let approval;
		const ctx = cloudContext(port, {
			requestApproval: async (request) => {
				approval = request;
				return { approved: true, finish() {} };
			}
		});
		const { runImageGenerate } = require(path.join(OUT, 'tools/imageGenerate'));
		const out = await runImageGenerate({ prompt: 'a red fox', size: '800x600' }, ctx);
		assert.equal(out.error, undefined);
		assert.equal(approval.kind, 'image');
		assert.equal(approval.cost, true);
		assert.match(approval.content, /Fake · painter/);
		assert.match(out.api, /Saved images[\\/]/);
		assert.match(out.summary, /Fake · painter · 800×600/);
		assert.ok(out.image.startsWith('data:image/png;base64,'));
		assert.equal(out.images, undefined, 'no image is attached for a model without vision');
		assert.equal(seen.url, '/v1/images/generations');
		assert.equal(seen.auth, 'Bearer test-key');
		assert.deepEqual(seen.body, { model: 'painter', prompt: 'a red fox', n: 1, size: '800x600' });
		const saved = out.detail.match(/Saved: (.+)\n/)[1];
		const bytes = fs.readFileSync(path.isAbsolute(saved) ? saved : path.join(project, saved));
		assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
	} finally {
		server.close();
	}
});

test('a rejected image call generates nothing', async () => {
	let requests = 0;
	const server = await imageServer((req, res) => {
		requests++;
		res.writeHead(500).end();
	});
	try {
		const ctx = cloudContext(server.address().port, {
			requestApproval: async () => ({ approved: false, finish() {} })
		});
		const { runImageGenerate } = require(path.join(OUT, 'tools/imageGenerate'));
		const out = await runImageGenerate({ prompt: 'a red fox' }, ctx);
		assert.equal(out.error, true);
		assert.match(out.api, /rejected/);
		assert.equal(requests, 0);
	} finally {
		server.close();
	}
});
