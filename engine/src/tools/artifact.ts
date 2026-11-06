/**
 * The artifact publish contract (adapted from Claude's artifact-type runbooks:
 * one file per artifact, a publish the verifier can refuse, and a preview
 * sandbox with no egress).
 *
 * An artifact is ONE self-contained HTML document. The publish step checks the
 * contract before anything is written; the preview panel's CSP enforces the
 * no-egress rule at runtime (connect-src 'none'), so even a violation that
 * slipped past validation cannot phone home.
 */

/** Script CDNs an artifact may load from (pinned, UMD builds). */
const SCRIPT_HOSTS = new Set(['cdnjs.cloudflare.com']);
/** Stylesheet hosts (CDNs + Google Fonts, Claude's only CSP font host). */
const STYLE_HOSTS = new Set(['cdnjs.cloudflare.com', 'fonts.googleapis.com']);

export const MAX_ARTIFACT_BYTES = 5_000_000;

/** The name the file is published under. */
export function artifactSlug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 60) || 'artifact'
	);
}

/**
 * Contract violations, as fixable one-liners. An empty list means the
 * publish may go through. Everything the CSP would block at runtime is
 * rejected here, so the agent learns the rule instead of shipping a blank
 * preview.
 */
export function validateArtifact(html: string): string[] {
	const problems: string[] = [];
	if (html.length > MAX_ARTIFACT_BYTES) {
		problems.push(`the document is ${Math.round(html.length / 1e6)} MB — keep artifacts under 5 MB`);
	}
	if (!/<\/html>/i.test(html)) {
		problems.push('publish the complete document, from <!doctype html> to </html>');
	}
	if (/<\s*iframe/i.test(html)) {
		problems.push('iframes are not allowed — the preview is sandboxed and embeds nothing');
	}
	for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
		const bad = externalHostProblem(m[1], SCRIPT_HOSTS);
		if (bad) {
			problems.push(`<script src="${m[1]}">: ${bad}`);
		}
	}
	for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
		const bad = externalHostProblem(m[1], STYLE_HOSTS);
		if (bad) {
			problems.push(`<link href="${m[1]}">: ${bad}`);
		}
	}
	if (/\b(import|fetch)\s*\(/.test(html) && /\bhttps?:\/\//.test(html) && !/cdnjs\.cloudflare\.com|fonts\.googleapis\.com/.test(html)) {
		problems.push('no network calls — the preview has no egress; inline the data you need');
	}
	return problems;
}

function externalHostProblem(url: string, allowed: Set<string>): string | undefined {
	if (/^(data:|blob:|#)/i.test(url)) {
		return undefined;
	}
	let host: string;
	try {
		const u = new URL(url, 'https://placeholder.local');
		if (u.hostname === 'placeholder.local') {
			return 'reference local files inline instead (the artifact is one self-contained document)';
		}
		if (u.protocol !== 'https:') {
			return 'only https:// library URLs are allowed';
		}
		host = u.hostname;
	} catch {
		return 'not a valid URL';
	}
	if (!allowed.has(host)) {
		return `libraries may only load from ${[...allowed].join(', ')}`;
	}
	return undefined;
}
