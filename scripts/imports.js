/*
 * Module specifiers a source file names, for the architecture and shipped-files checks:
 * import/export … from, bare and dynamic import, import = require, and require() — the set
 * ts.preProcessFile(source, true, true) reported as importedFiles before TypeScript 7 dropped
 * the JavaScript compiler API. Ported from that function onto the compiler's scanner
 * (typescript/ast): the walk keeps a stack through template substitutions and rescans template
 * tails (reScanTemplateToken), because a plain token scan loses its place on nested template
 * literals — code after them would silently never be checked.
 */
'use strict';
// typescript/ast exists from TypeScript 7; the classic package exports the same scanner at
// its root. Both work here — the tree must keep checking while either is installed.
let ast;
try {
	ast = require('typescript/ast');
} catch {
	ast = require('typescript');
}
const { createScanner, LanguageVariant, SyntaxKind: K, tokenIsIdentifierOrKeyword } = ast;
const EOF = K.EndOfFile ?? K.EndOfFileToken;

/** Every module specifier a file loads: import, export … from, require(), import(). */
function specifiers(source) {
	// The classic compiler's preProcessFile reports exactly this set. TypeScript 7 dropped the
	// JavaScript compiler API, so only the scanner port below runs there; under the classic
	// package its scanner's stream differs enough that require() calls go unseen.
	if (typeof ast.preProcessFile === 'function') {
		return ast.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
	}
	const scanner = createScanner(true, LanguageVariant.Standard, source);
	const out = [];
	let last = 0;
	let current = 0;
	// Without parser context the scanner cannot lex everything: `#` inside a regex literal
	// (old TypeScript's scanner emitted a plain hash token) makes it return a zero-length
	// token forever. On such a stall, restart the text one character in so the walk survives.
	const scan = () => {
		const before = scanner.getTokenStart();
		const kind = scanner.scan();
		if (kind !== EOF && scanner.getTokenStart() === before && String(scanner.getTokenText()).length === 0) {
			scanner.setText(source, scanner.getTokenStart() + 1);
			return scanner.scan();
		}
		return kind;
	};
	const next = () => {
		last = current;
		current = scan();
		return current;
	};
	const record = () => out.push(scanner.getTokenValue());

	// import 'x'; import('x'); import [type] name from 'x'; import [type] * as name from 'x'
	function importClause() {
		if (last === K.DotToken) return; // obj.import is a property access
		if (next() === K.OpenParenToken) {
			if (next() === K.StringLiteral) record();
		} else if (current === K.StringLiteral) {
			record();
		} else {
			if (current === K.TypeKeyword) next();
			if (current === K.OpenBraceToken) {
				// import { a as b, … } from 'x'
				while (next() !== K.CloseBraceToken && current !== EOF);
				if (current === K.CloseBraceToken && next() === K.FromKeyword && next() === K.StringLiteral) record();
			} else if (tokenIsIdentifierOrKeyword(current)) {
				if (next() === K.FromKeyword && next() === K.StringLiteral) record();
			} else if (current === K.AsteriskToken) {
				if (next() === K.AsKeyword && tokenIsIdentifierOrKeyword(next()) && next() === K.FromKeyword && next() === K.StringLiteral) record();
			}
		}
	}

	// export {} from 'x'; export * from 'x'; export import name = require('x')
	function exportClause() {
		next();
		if (current === K.TypeKeyword) next();
		if (current === K.OpenBraceToken) {
			while (next() !== K.CloseBraceToken && current !== EOF);
			if (current === K.CloseBraceToken && next() === K.FromKeyword && next() === K.StringLiteral) record();
		} else if (current === K.AsteriskToken) {
			if (next() === K.FromKeyword && next() === K.StringLiteral) record();
		} else if (current === K.ImportKeyword) {
			if (next() === K.TypeKeyword) next();
			if (tokenIsIdentifierOrKeyword(current) && next() === K.EqualsToken && next() === K.RequireKeyword) requireAfter();
		}
	}

	// require('x') and require(`x`), with current on the RequireKeyword
	function requireAfter() {
		if (next() === K.OpenParenToken) {
			next();
			if (current === K.StringLiteral || current === K.NoSubstitutionTemplateLiteral) record();
		}
	}

	next();
	// Same bound as the template walk below: a scanner that stops advancing on malformed
	// input returns the same zero-length token forever, and every real token spans at
	// least one character.
	for (let at = 0; current !== EOF && at < source.length; at++) {
		if (current === K.TemplateHead) {
			// A template with substitutions: the scanner stops at its head, and the
			// substitution expressions are ordinary tokens. Nested templates and braces
			// need the stack, and each `}` closing a template head must be rescanned into
			// the template's middle or tail to keep what follows in step.
			const stack = [K.TemplateHead];
			// Bounded like the outer walk: every step consumes at least one character, so
			// a rescanned `}` that refuses to advance cannot spin here forever.
			for (let at = 0; stack.length && at < source.length; at++) {
				const token = scan();
				if (token === EOF) break;
				current = token;
				if (token === K.ImportKeyword) importClause();
				else if (token === K.TemplateHead || token === K.OpenBraceToken) stack.push(token);
				else if (token === K.CloseBraceToken) {
					if (stack[stack.length - 1] === K.TemplateHead) {
						current = scanner.reScanTemplateToken(false);
						if (current === K.TemplateTail) stack.pop();
					} else stack.pop();
				}
			}
		} else if (current === K.ImportKeyword) importClause();
		else if (current === K.ExportKeyword) exportClause();
		else if (current === K.RequireKeyword) requireAfter();
		next();
	}
	return out;
}

/** Every non-trivia token as [kind, start, text]: the same stream both scanner flavors emit. */
function scanTokens(source) {
	// The classic scanner takes (languageVersion, skipTrivia, variant, text); the TypeScript 7
	// ast scanner takes (skipTrivia, variant, text). Calling either with the other's shape
	// silently scans empty text and yields nothing.
	const scanner = typeof ast.preProcessFile === 'function'
		? createScanner(ast.ScriptTarget.Latest, true, LanguageVariant.Standard, source)
		: createScanner(true, LanguageVariant.Standard, source);
	const out = [];
	// A plain scan() cannot step out of a template substitution: at the `}` after ${…} it must
	// reScanTemplateToken, or the rest of the file comes back as one giant tail. One interleaved
	// stack holds brace opens and substitution-opening template heads, so the top always says
	// what a `}` closes — braces opened outside a template stay beneath it. A template without a
	// substitution scans as one head-shaped token and never enters the stack.
	const stack = [];
	const push = (kind) => out.push([kind, scanner.getTokenStart(), String(scanner.getTokenText())]);
	for (let at = 0; at < source.length; at++) {
		const before = scanner.getTokenStart();
		let kind = scanner.scan();
		if (kind === EOF) break;
		if (scanner.getTokenStart() === before && String(scanner.getTokenText()).length === 0) {
			scanner.setText(source, scanner.getTokenStart() + 1);
			continue;
		}
		if (kind === K.TemplateHead) {
			if (String(scanner.getTokenText()).endsWith('${')) stack.push('t');
		} else if (kind === K.OpenBraceToken) stack.push('b');
		else if (kind === K.CloseBraceToken) {
			if (stack[stack.length - 1] === 't') {
				kind = scanner.reScanTemplateToken(false);
				if (kind === K.TemplateTail) stack.pop();
			} else if (stack.length) stack.pop();
		}
		push(kind);
	}
	return out;
}

module.exports = { scanTokens, specifiers };
