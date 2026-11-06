// The architecture rules of AGENTS.md, checked (npm run check):
//   - each part imports only from itself, plus the few contracts listed in POLICY;
//   - pages (the desktop layer, the start page, the engine UI) load no modules at all;
//   - only app/preload.js touches the IPC bridge, and it exposes nothing but window.__zcShell;
//   - every page view runs with context isolation and the sandbox;
//   - every command in app/permissions.js has a case in the shell's dispatch, and the reverse.
'use strict';
const fs = require('fs');
const path = require('path');
const { specifiers } = require('./imports');
// typescript/ast exists from TypeScript 7; the classic package exports the same kinds at its root.
let ast;
try {
	ast = require('typescript/ast');
} catch {
	ast = require('typescript');
}
const { SyntaxKind: K } = ast;

const root = path.join(__dirname, '..');

// `may` lists files outside the part's own roots that it may import (paths from the repository root).
const POLICY = [
	{ id: 'app', roots: ['app'], may: ['package.json', 'host/protocol.js'], packages: ['electron'] },
	{ id: 'host', roots: ['host'], may: [] },
	{ id: 'engine', roots: ['engine/src'], may: ['engine/package.json'], packages: ['vscode'] },
	{ id: 'engine-shim', roots: ['engine/vscode-shim.js'], may: [], packages: ['electron'] },
	{ id: 'scripts', roots: ['scripts', 'engine/scripts'], may: ['test/gui-lock.js', 'test/test-env.js', 'package.json', 'engine/package.json'], packages: ['typescript'] }
];
// Scripts that run in a page, never in Node.
const PAGES = ['app/desktop-ui.js', 'app/desktop-glass.js', 'ui', 'engine/media'];
// Under engine/media but not page code: files the engine copies into users' projects.
const NOT_PAGES = ['engine/media/cloud', 'engine/media/mods', 'engine/media/skills'];
const VENDORED = /\.min\.js$/;
const SOURCE = /\.(c|m)?[jt]s$/;

const posix = (p) => p.split(path.sep).join('/');
const inside = (rel, dir) => rel === dir || rel.startsWith(dir + '/');

function walk(rel, out = []) {
	const abs = path.join(root, rel);
	if (!fs.existsSync(abs)) return out;
	if (fs.statSync(abs).isFile()) {
		if (SOURCE.test(rel) && !rel.endsWith('.d.ts')) out.push(rel);
		return out;
	}
	for (const name of fs.readdirSync(abs)) {
		if (name === 'node_modules' || name.startsWith('.')) continue;
		walk(rel + '/' + name, out);
	}
	return out;
}


/** Where a relative specifier from `rel` points, as a repository path (extension-less is fine). */
function target(rel, spec) {
	return posix(path.relative(root, path.resolve(path.join(root, path.dirname(rel)), spec)));
}

function matches(file, candidates) {
	return candidates.some((c) => file === c || file === c.replace(/\.(js|json)$/, '') || inside(file, c));
}

/** Boundary violations in one file of a part. */
function checkImports(rel, source, part) {
	const problems = [];
	for (const spec of specifiers(source)) {
		if (spec.startsWith('.')) {
			const to = target(rel, spec);
			if (part.roots.some((r) => inside(to, r) || to === r.replace(/\.js$/, ''))) continue;
			if (matches(to, part.may)) continue;
			problems.push(`${rel}: imports ${spec} (${to}), outside ${part.id}`);
		} else if (spec === 'electron' || spec === 'vscode' || spec === 'typescript') {
			if (!(part.packages || []).includes(spec)) problems.push(`${rel}: imports ${spec}, which ${part.id} may not use`);
		}
	}
	return problems;
}

/** A page script loads no modules. */
function checkPage(rel, source) {
	return specifiers(source).map((spec) => `${rel}: a page script loads ${spec}; pages get only window.__zcShell`);
}

// The checks below read token streams rather than a parsed syntax tree: TypeScript 7 has no
// in-process parser (the tree lives behind the typescript/sync server), and each check only
// needs identifier/keyword neighbourhoods. The stream comes from scripts/imports.js, which
// also owns the per-flavor scanner call and the stall handling.
const { scanTokens } = require('./imports');

const unquote = (text) => text.replace(/^['"]|['"]$/g, '');
const lineAt = (source, start) => source.slice(0, start).split('\n').length;

/** Only the preload touches the bridge, and it exposes one name. */
function checkBridge(rel, source) {
	const problems = [];
	const toks = scanTokens(source);
	for (let i = 0; i < toks.length; i++) {
		const [kind, , text] = toks[i];
		if (kind === K.Identifier && (text === 'ipcRenderer' || text === 'contextBridge') && rel !== 'app/preload.js') {
			problems.push(`${rel}: uses ${text}; only app/preload.js may`);
		}
		// contextBridge.exposeInMainWorld('name', …): a member named exposeInMainWorld that is called
		if (kind === K.Identifier && text === 'exposeInMainWorld' && rel === 'app/preload.js' && toks[i - 1] && toks[i + 1]
			&& (toks[i - 1][0] === K.DotToken || toks[i - 1][0] === K.QuestionDotToken) && toks[i + 1][0] === K.OpenParenToken) {
			const arg = toks[i + 2];
			const exposed = arg && arg[0] === K.StringLiteral ? unquote(arg[2]) : '?';
			if (exposed !== '__zcShell') problems.push(`${rel}: exposes ${exposed}; pages get only window.__zcShell`);
		}
	}
	return problems;
}

/** Every page view: contextIsolation and sandbox on, nodeIntegration never on. */
function checkWebPreferences(rel, source) {
	const problems = [];
	const toks = scanTokens(source);
	for (let i = 0; i < toks.length; i++) {
		if (toks[i][0] !== K.Identifier || toks[i][2] !== 'webPreferences') continue;
		if (!toks[i + 1] || toks[i + 1][0] !== K.ColonToken) continue; // a property assignment, not a mention
		const line = lineAt(source, toks[i][1]);
		if (!toks[i + 2] || toks[i + 2][0] !== K.OpenBraceToken) {
			problems.push(`${rel}:${line}: webPreferences must be written inline so it can be checked`);
			continue;
		}
		// Top-level `key: value` pairs of the inline literal; nested objects are skipped.
		const props = new Map();
		let depth = 0;
		for (let j = i + 3; j < toks.length; j++) {
			const k = toks[j][0];
			if (k === K.OpenBraceToken) depth++;
			else if (k === K.CloseBraceToken) {
				if (depth === 0) break;
				depth--;
			} else if (depth === 0 && (k === K.Identifier || k === K.StringLiteral) && toks[j + 1] && toks[j + 1][0] === K.ColonToken && toks[j + 2]) {
				props.set(unquote(toks[j][2]), toks[j + 2][0]);
			}
		}
		for (const key of ['contextIsolation', 'sandbox']) {
			if (props.get(key) !== K.TrueKeyword) problems.push(`${rel}:${line}: webPreferences needs ${key}: true`);
		}
		if (props.has('nodeIntegration') && props.get('nodeIntegration') !== K.FalseKeyword) problems.push(`${rel}:${line}: webPreferences may not enable nodeIntegration`);
	}
	return problems;
}

/** The commands app/permissions.js allows and the cases the shell's invoke() handles must be the same set. */
function checkCommands(allowedCommands, mainSource) {
	const cases = new Set();
	const toks = scanTokens(mainSource);
	// A member declaration: the name sits directly or after `async` in member position — after
	// the class's opening brace, another member's closing brace, a separator, or a field's `;`.
	const memberBefore = (tok) => tok && (tok[0] === K.OpenBraceToken || tok[0] === K.CloseBraceToken || tok[0] === K.CommaToken || tok[0] === K.SemicolonToken);
	for (let i = 0; i < toks.length; i++) {
		if (toks[i][0] !== K.Identifier || toks[i][2] !== 'invoke') continue;
		// A method declaration, not a this.invoke(… ) call: the name sits in member position,
		// directly or after `async`, and takes a parameter list.
		if (!toks[i + 1] || toks[i + 1][0] !== K.OpenParenToken) continue;
		if (!(memberBefore(toks[i - 1]) || (toks[i - 1] && toks[i - 1][0] === K.AsyncKeyword && memberBefore(toks[i - 2])))) continue;
		// The method body: everything to its closing brace; `case 'x':` strings at any depth.
		let paren = 0;
		let body = -1;
		for (let j = i + 1; j < toks.length; j++) {
			const k = toks[j][0];
			if (k === K.OpenParenToken) paren++;
			else if (k === K.CloseParenToken && --paren === 0) {
				body = j + 1;
				break;
			}
		}
		if (body < 0 || !toks[body] || toks[body][0] !== K.OpenBraceToken) continue;
		let depth = 0;
		for (let m = body + 1; m < toks.length; m++) {
			const k = toks[m][0];
			if (k === K.OpenBraceToken) depth++;
			else if (k === K.CloseBraceToken) {
				if (depth === 0) break;
				depth--;
			} else if (k === K.CaseKeyword && toks[m + 1] && toks[m + 1][0] === K.StringLiteral) cases.add(unquote(toks[m + 1][2]));
		}
	}
	const problems = [];
	for (const c of allowedCommands) if (!cases.has(c)) problems.push(`app/permissions.js: ${c} is allowed but app/main.js invoke() has no case for it`);
	for (const c of cases) if (!allowedCommands.has(c)) problems.push(`app/main.js: invoke() handles ${c}, which no page is allowed in app/permissions.js`);
	return problems;
}

function run() {
	const problems = [];
	const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
	for (const part of POLICY) {
		for (const rel of part.roots.flatMap((r) => walk(r))) {
			if (PAGES.some((p) => inside(rel, p))) continue;
			problems.push(...checkImports(rel, read(rel), part));
		}
	}
	for (const rel of PAGES.flatMap((p) => walk(p))) {
		if (!VENDORED.test(rel) && !NOT_PAGES.some((p) => inside(rel, p))) problems.push(...checkPage(rel, read(rel)));
	}
	for (const rel of [...walk('app'), ...walk('host'), ...walk('ui')]) {
		const source = read(rel);
		problems.push(...checkBridge(rel, source));
		if (inside(rel, 'app')) problems.push(...checkWebPreferences(rel, source));
	}
	const { ALLOWED } = require(path.join(root, 'app', 'permissions.js'));
	problems.push(...checkCommands(new Set(Object.values(ALLOWED).flatMap((s) => [...s])), read('app/main.js')));
	return problems;
}

module.exports = { POLICY, checkImports, checkPage, checkBridge, checkWebPreferences, checkCommands, run };

if (require.main === module) {
	const problems = run();
	if (problems.length) {
		for (const p of problems) console.error(p);
		console.error(`\n${problems.length} architecture rule(s) broken (scripts/check-architecture.js).`);
		process.exit(1);
	}
	console.log('architecture ok');
}
