// What the packaged app loads must be in the package (Pi's check:pinned-deps and check:runtime-deps,
// shaped for one Electron app with no runtime dependencies). Runs after the engine is built, because
// engine/out is what ships (npm run validate, npm test):
//   - every dependency in package.json and engine/package.json is an exact version;
//   - the app has no runtime dependencies: shipped code loads only Node built-ins, electron, the
//     vscode shim and its own files;
//   - every file a shipped file requires is itself shipped by package.json build.files. A file the
//     package leaves out may be required only behind a runtime check, listed in OPTIONAL with why.
'use strict';
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { specifiers } = require('./imports');

const root = path.join(__dirname, '..');
const EXACT = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Provided by the runtime, not by node_modules: Electron itself, and the vscode API (engine/vscode-shim.js).
const PROVIDED = new Set(['electron', 'vscode']);
// Shipped files that are never Node modules: page scripts and vendored bundles.
const NOT_MODULES = [/^engine\/media\//, /^ui\//, /^app\/desktop-(ui|glass)\.js$/, /^engine\/out\/vendor\//, /\.min\.js$/];
const OPTIONAL = {};

const posix = (p) => p.split(path.sep).join('/');

/** build.files glob → RegExp: **, *, {a,b}, and ${platform}-${arch} for this machine. */
function globRegex(glob) {
	const g = glob.replace(/\$\{platform\}/g, process.platform).replace(/\$\{arch\}/g, process.arch);
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*' && g[i + 1] === '*') {
			re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += g[i + 2] === '/' ? 2 : 1;
		} else if (c === '*') re += '[^/]*';
		else if (c === '{') {
			const end = g.indexOf('}', i);
			re += '(?:' + g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
			i = end;
		} else re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&');
	}
	return new RegExp('^' + re + '$');
}

function packager(files) {
	const include = files.filter((f) => !f.startsWith('!')).map(globRegex);
	const exclude = files.filter((f) => f.startsWith('!')).map((f) => globRegex(f.slice(1)));
	return (rel) => include.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel));
}

/** Exact versions only: ^, ~, ranges and tags let a fresh install ship code nobody reviewed. */
function checkPinned(manifests) {
	const problems = [];
	for (const [file, pkg] of manifests) {
		for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
			for (const [name, spec] of Object.entries(pkg[field] || {})) {
				if (/^(workspace:|file:|link:|git\+|https?:)/.test(spec)) continue;
				const alias = /^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@(.+)$/i.exec(spec);
				if (!EXACT.test(alias ? alias[1] : spec)) problems.push(`${file}: ${field}.${name} is "${spec}"; pin an exact version`);
			}
		}
	}
	for (const [file, pkg] of manifests) {
		if (file === 'package.json' && Object.keys(pkg.dependencies || {}).length) problems.push('package.json: the app has runtime dependencies; this check assumes none (node_modules is not shipped)');
	}
	return problems;
}

/** Every shipped helper binary carries its SHA-256 in SHA256SUMS beside it; the engine checks it before running. */
function checkBundledBinaries(shipped, bin = path.join(root, 'engine', 'bin')) {
	const problems = [];
	if (!fs.existsSync(bin)) return problems;
	for (const dir of fs.readdirSync(bin, { withFileTypes: true }).filter((d) => d.isDirectory())) {
		const folder = path.join(bin, dir.name), sums = path.join(folder, 'SHA256SUMS');
		const listed = new Map(fs.existsSync(sums) ? fs.readFileSync(sums, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim().split(/\s+/).reverse()) : []);
		for (const name of fs.readdirSync(folder, { recursive: true }).map(posix)) {
			const rel = `engine/bin/${dir.name}/${name}`;
			if (!fs.statSync(path.join(folder, name)).isFile() || name === 'SHA256SUMS' || /\.(LICENSE|txt|md)$/i.test(name) || !shipped(rel)) continue;
			const digest = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex');
			if (!listed.has(name)) problems.push(`${rel}: shipped without a SHA256SUMS entry`);
			else if (listed.get(name) !== digest) problems.push(`${rel}: does not match its SHA256SUMS digest`);
		}
	}
	return problems;
}

/** The packaged binary ignores NODE_OPTIONS and --inspect and encrypts its cookies (Electron fuses). */
function checkFuses(build) {
	const fuses = build.electronFuses || {};
	const want = { enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableCookieEncryption: true };
	return Object.entries(want).filter(([fuse, value]) => fuses[fuse] !== value).map(([fuse, value]) => `package.json: build.electronFuses.${fuse} must be ${value}`);
}

/** Specifiers a file loads at run time: static require() and import(); vendored or minified files are skipped. */
function loads(source) {
	return specifiers(source);
}

function resolveRelative(fromRel, spec, exists) {
	const base = posix(path.normalize(path.join(path.dirname(fromRel), spec)));
	return ['', '.js', '.json', '/index.js'].map((ext) => base + ext).find(exists);
}

/** Problems for one shipped file. `exists(rel)` and `shipped(rel)` describe the tree and the package. */
function checkFile(rel, source, { exists, shipped, used = new Set() }) {
	const problems = [];
	const builtins = new Set(builtinModules);
	for (const spec of loads(source)) {
		if (spec.startsWith('.')) {
			const target = resolveRelative(rel, spec, exists);
			if (!target) problems.push(`${rel}: requires ${spec}, which does not exist`);
			else if (!shipped(target) && OPTIONAL[target]) used.add(target);
			else if (!shipped(target)) problems.push(`${rel}: requires ${target}, which package.json build.files leaves out of the package`);
			continue;
		}
		const name = spec.replace(/^node:/, '');
		if (builtins.has(name) || builtins.has(name.split('/')[0]) || PROVIDED.has(spec)) continue;
		problems.push(`${rel}: requires the package ${spec}, which the app does not ship (node_modules is not packaged)`);
	}
	return problems;
}

function walk(rel, out = []) {
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs)) return out;
	if (fs.statSync(abs).isFile()) {
		if (rel.endsWith('.js')) out.push(rel);
		return out;
	}
	for (const name of fs.readdirSync(abs)) walk(rel + '/' + name, out);
	return out;
}

function run() {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const engineManifest = JSON.parse(fs.readFileSync(path.join(root, 'engine', 'package.json'), 'utf8'));
	const problems = checkPinned([['package.json', pkg], ['engine/package.json', engineManifest]]);
	problems.push(...require('./vendor-terminal').verify(path.join(root, 'engine', 'media', 'terminal')));
	if (!fs.existsSync(path.join(root, 'engine', 'out', 'chatController.js'))) {
		return [...problems, 'engine/out is missing: build the engine first (npm run engine)'];
	}
	const shipped = packager(pkg.build.files);
	problems.push(...checkFuses(pkg.build), ...checkBundledBinaries(shipped));
	// This manifest is generated by before-pack and read only by a packaged app.
	const exists =(rel) => rel === 'app/release-integrity.json' || (fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile());
	const desktop = require('./desktop-resources');
	const pageAssets = desktop.uiResources(fs.readFileSync(path.join(root, 'engine/out/remote.js'), 'utf8'));
	if (!pageAssets.includes('engine/media/chat.js')) problems.push('Desktop UI resource discovery did not find the chat entry point');
	problems.push(...desktop.checkDesktopResources(require(path.join(root, 'engine/out/host/capabilities')).DESKTOP_CAPABILITIES, { exists, shipped }, pageAssets));
	const used = new Set();
	let scanned = 0;
	for (const rel of ['app', 'host', 'engine/out', 'engine/vscode-shim.js'].flatMap((d) => walk(d))) {
		if (!shipped(rel) || NOT_MODULES.some((r) => r.test(rel))) continue;
		scanned++;
		problems.push(...checkFile(rel, fs.readFileSync(path.join(root, rel), 'utf8'), { exists, shipped, used }));
	}
	// A walk that finds almost nothing passes vacuously; the app ships hundreds of modules.
	if (scanned < 100) problems.push(`scripts/check-shipped.js: scanned only ${scanned} shipped modules; the file walk is broken`);
	for (const target of Object.keys(OPTIONAL)) {
		if (shipped(target)) problems.push(`scripts/check-shipped.js: ${target} is listed as optional but is shipped; remove it from OPTIONAL`);
		else if (!used.has(target)) problems.push(`scripts/check-shipped.js: no shipped file requires ${target}; remove it from OPTIONAL`);
	}
	return problems;
}

module.exports = { checkPinned, checkFile, checkFuses, checkBundledBinaries, globRegex, packager, OPTIONAL, run };

if (require.main === module) {
	const problems = run();
	if (problems.length) {
		for (const p of problems) console.error(p);
		console.error(`\n${problems.length} packaging rule(s) broken (scripts/check-shipped.js).`);
		process.exit(1);
	}
	console.log('shipped ok');
}
