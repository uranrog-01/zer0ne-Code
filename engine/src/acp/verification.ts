/** A stream chunk can end inside a signed URL; only complete diagnostic lines may publish links. */
export class AgentOutputLines {
	private pending = '';
	private dropping = false;
	tail = '';
	push(chunk: string, end = false): string[] {
		const lines = (this.pending + chunk).split(/\r?\n/);
		this.pending = end ? '' : lines.pop()!;
		const complete: string[] = [];
		for (const line of lines) {
			if (this.dropping) { this.dropping = false; continue; }
			if (line.length <= 64_000) complete.push(line);
		}
		if (this.pending.length > 64_000) { this.pending = ''; this.dropping = true; }
		if (complete.length) this.tail = (this.tail + '\n' + complete.join('\n')).slice(-64_000);
		return complete;
	}
}

/** Vendor diagnostics can carry a URL in JSON, Go-style maps or plain streamed text. */
export function verifyUrlIn(text: string): string | undefined {
	if (!/VALIDATION_REQUIRED|verify your account|account verification/i.test(text)) return undefined;
	const decoded = text.slice(0, 64_000).replace(/\\+u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(/\\+\//g, '/').replace(/&amp;/g, '&');
	for (const match of [...decoded.matchAll(/https:\/\/[^\s\]"'<>\x00-\x1f]+/g)].reverse()) {
		const candidate = match[0].replace(/[),.;]+$/, '');
		const trusted = googleVerificationUrl(candidate);
		if (trusted) return trusted;
	}
	return undefined;
}

/** Keep Google's signed query intact; neither repair nor substitute challenge parameters. */
export function googleVerificationUrl(candidate: string | undefined): string | undefined {
	if (!candidate || candidate.length > 8192 || /[\\\s\x00-\x1f]/.test(candidate)) return undefined;
	try {
		const url = new URL(candidate);
		if (url.protocol === 'https:' && url.hostname === 'accounts.google.com' && !url.username && !url.password && !url.port) return candidate;
	} catch { /* A malformed challenge requires a new link from the vendor. */ }
	return undefined;
}

/** A refusal emitted as an agent answer must not pass a greeting/model test. */
export function verificationFailureText(text: string): boolean {
	const plain = text.trimStart().replace(/^(?:\*\*|__)/, '');
	return /^(?:verify your account(?: to continue)?(?:\*\*|__)?(?:[.!:\s]|$)|account verification (?:is )?required\b|further action is required to use antigravity\b|VALIDATION_REQUIRED\b)/i.test(plain)
		|| /^\s*(?:agent execution error|error:|request failed)\b/i.test(plain) && /VALIDATION_REQUIRED|verify your account|account verification/i.test(text);
}
