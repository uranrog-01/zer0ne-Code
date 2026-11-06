/**
 * Tool-call arguments as small local models tend to write them: wrapped in a
 * ```json fence or prose, with trailing commas, Python literals (True / None),
 * unquoted keys, or a missing closing brace. Valid JSON passes through
 * untouched; the repairs only run when strict parsing fails, and only ever
 * return an object (pure; tested).
 */
export function parseToolArgs(text: string | undefined): Record<string, unknown> | undefined {
	const raw = (text ?? '').trim();
	if (!raw) return {};
	const strict = tryObject(raw);
	if (strict !== undefined) return strict;
	let s = raw.replace(/^```(?:json|javascript|js)?\s*/i, '').replace(/\s*```$/, '').trim();
	// Prose around the object: keep from the first "{" to the matching last "}".
	const first = s.indexOf('{');
	if (first > 0) s = s.slice(first);
	const last = s.lastIndexOf('}');
	if (last >= 0 && last < s.length - 1 && balance(s.slice(0, last + 1)) === 0) s = s.slice(0, last + 1);
	const attempts = [
		s,
		closeBraces(s),
		closeBraces(outsideStrings(s, (seg) => seg.replace(/,\s*([}\]])/g, '$1').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')))
	];
	for (const a of attempts) {
		const v = tryObject(a);
		if (v !== undefined) return v;
	}
	return undefined;
}

function tryObject(s: string): Record<string, unknown> | undefined {
	try {
		const v = JSON.parse(s);
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Unclosed braces/brackets outside strings (negative = too many closers). */
function balance(s: string): number {
	let depth = 0;
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === '\\') i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === '{' || c === '[') depth++;
		else if (c === '}' || c === ']') depth--;
	}
	return depth;
}

/** Append the closers a truncated object is missing (and a closing quote for an open string). */
function closeBraces(s: string): string {
	const stack: string[] = [];
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === '\\') i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === '{') stack.push('}');
		else if (c === '[') stack.push(']');
		else if ((c === '}' || c === ']') && stack.length) stack.pop();
	}
	return (inStr ? s + '"' : s) + stack.reverse().join('');
}

/** Apply `fix` to the parts of `s` outside JSON strings only (code inside strings stays exact). */
function outsideStrings(s: string, fix: (seg: string) => string): string {
	let out = '';
	let seg = '';
	let inStr = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			out += c;
			if (c === '\\' && i + 1 < s.length) out += s[++i];
			else if (c === '"') inStr = false;
		} else if (c === '"') {
			out += fix(seg) + c;
			seg = '';
			inStr = true;
		} else seg += c;
	}
	return out + fix(seg);
}
