/**
 * Secret redaction, in two confidence tiers.
 *
 * High tier = recognisable token *shapes*: provider key prefixes, whole
 * private-key blocks, JWTs, `Authorization: Bearer …`, credentials in URLs and
 * UPPER_CASE env-style assignments. Low tier = a quoted JSON field whose *name*
 says secret — safe for code contexts only because the name is quoted.
 *
 * Tool output (file reads, command output, MCP results) and attached files are
 masked with both tiers before they are sent to a model provider; diagnostics
 reports use the tiers plus their own extra catches. Display paths can run the
 engine separately over already-fetched strings cheaply (the cache below).
 *
 * The marker is deliberately distinctive: writing tools refuse content that
 * contains it, so a masked file can never be saved back over the real one.
 */

export const REDACTED = '«redacted-secret»';

export type RedactTier = 'high' | 'both';

export interface RedactOptions {
	tier?: RedactTier;
}

interface Detector {
	id: string;
	tier: 'high' | 'low';
	re: RegExp;
	rep: string | ((...m: string[]) => string);
}

const DETECTORS: Detector[] = [
	{ id: 'private-key', tier: 'high', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, rep: REDACTED },
	{ id: 'anthropic-api-key', tier: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	// sk-proj-…, sk-svcacct-…, sk-or-v1-… and any OpenAI-shaped key
	{ id: 'openai-api-key', tier: 'high', re: /\bsk-(?:proj-|svcacct-|or-v1-)?[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	{ id: 'github-classic-token', tier: 'high', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, rep: REDACTED },
	{ id: 'github-fine-grained-pat', tier: 'high', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, rep: REDACTED },
	{ id: 'gitlab-pat', tier: 'high', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, rep: REDACTED },
	{ id: 'gitlab-deploy-token', tier: 'high', re: /\bgldt-[A-Za-z0-9_-]{20,}\b/g, rep: REDACTED },
	{ id: 'gitlab-runner-token', tier: 'high', re: /\bglrt-[A-Za-z0-9_-]{20,}\b/g, rep: REDACTED },
	{ id: 'aws-access-key', tier: 'high', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, rep: REDACTED },
	{ id: 'google-api-key', tier: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, rep: REDACTED },
	{ id: 'google-oauth-token', tier: 'high', re: /\bya29\.[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	{ id: 'slack-token', tier: 'high', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, rep: REDACTED },
	{ id: 'slack-webhook-url', tier: 'high', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g, rep: REDACTED },
	{ id: 'stripe-live-key', tier: 'high', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/g, rep: REDACTED },
	{ id: 'stripe-webhook-secret', tier: 'high', re: /\bwhsec_[A-Za-z0-9]{20,}\b/g, rep: REDACTED },
	{ id: 'huggingface-token', tier: 'high', re: /\bhf_[A-Za-z0-9]{30,}\b/g, rep: REDACTED },
	{ id: 'npm-access-token', tier: 'high', re: /\bnpm_[A-Za-z0-9]{36}\b/g, rep: REDACTED },
	{ id: 'jwt', tier: 'high', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, rep: REDACTED },
	{ id: 'sendgrid-api-token', tier: 'high', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	{ id: 'databricks-api-token', tier: 'high', re: /\bdapi[0-9a-f]{32}\b/g, rep: REDACTED },
	{ id: 'digitalocean-token', tier: 'high', re: /\b(?:dop|doo)_v1_[a-f0-9]{32,}\b/g, rep: REDACTED },
	{ id: 'grafana-service-account-token', tier: 'high', re: /\bglsa_[A-Za-z0-9]{30,}\b/g, rep: REDACTED },
	{ id: 'grafana-cloud-token', tier: 'high', re: /\bglc_[A-Za-z0-9_-]{30,}\b/g, rep: REDACTED },
	{ id: 'sentry-org-token', tier: 'high', re: /\bsntrys_[A-Za-z0-9+/=]{40,}\b/g, rep: REDACTED },
	{ id: 'pypi-upload-token', tier: 'high', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	{ id: 'postman-api-token', tier: 'high', re: /\bPMAK-[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	{ id: 'pulumi-api-token', tier: 'high', re: /\bpul-[A-Za-z0-9]{36}\b/g, rep: REDACTED },
	{ id: 'terraform-cloud-token', tier: 'high', re: /\b[A-Za-z0-9]{14,16}\.atlasv1\.[A-Za-z0-9_-]{26,}/g, rep: REDACTED },
	{ id: 'vault-token', tier: 'high', re: /\bhvs\.[A-Za-z0-9_-]{20,}/g, rep: REDACTED },
	// Inside connection strings: AccountKey=…, SharedAccessKey=…
	{
		id: 'azure-storage-key',
		tier: 'high',
		re: /\b((?:AccountKey|SharedAccessKey)=)([A-Za-z0-9+/=]{40,})/g,
		rep: (_m, head) => head + REDACTED
	},
	// Authorization headers
	{
		id: 'http-auth-scheme',
		tier: 'high',
		re: /\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
		rep: (...m: string[]) => m[1] + REDACTED
	},
	// user:password@ inside URLs / connection strings
	{
		id: 'url-userinfo',
		tier: 'high',
		re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]+:)([^\s@/"'`]{3,})@/gi,
		rep: (...m: string[]) => m[1] + REDACTED + '@'
	},
	// UPPER_CASE env assignments whose name says secret (KEY / SECRET / TOKEN / PASSWORD …)
	{
		id: 'sensitive-env-assignment',
		tier: 'high',
		re: /^(\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PASS|CREDENTIALS?|PRIVATE)[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"'#]{6,})/gm,
		rep: (...m: string[]) => m[1] + REDACTED
	},
	// A quoted JSON field whose name IS the secret's name: "apiKey": "…".
	// Guard on the quote marks keeps source code (`const password = …`) untouched.
	{
		id: 'sensitive-json-field',
		tier: 'low',
		re: /("(?:apiKey|api_key|apiToken|clientSecret|client_secret|secretKey|secret_key|accessToken|access_token|refreshToken|refresh_token|privateKey|private_key|passphrase)"\s*:?\s*)("[^"\n]{10,}")/gi,
		rep: (...m: string[]) => m[1] + REDACTED
	}
];

/** Every detector id, in run order — the redaction surface, documented and tested. */
export const DETECTOR_IDS: Array<Detector['id']> = DETECTORS.map((d) => d.id);

function tierMask(tier: RedactTier, d: Detector['tier']): boolean {
	return tier === 'both' || d === 'high';
}

/** Redaction results for short strings repeat constantly (prompt lines, headers) — cache them. */
const cache = new Map<string, { text: string; count: number }>();
const CACHE_TEXT_LIMIT = 512;
const CACHE_ENTRIES = 512;

export function redactSecrets(text: string, options?: RedactOptions): { text: string; count: number } {
	const tier: RedactTier = options?.tier ?? 'both';
	const key = `${tier}\u0000${text}`;
	const hit = text.length <= CACHE_TEXT_LIMIT ? cache.get(key) : undefined;
	if (hit) return hit;
	let count = 0;
	let out = text;
	for (const d of DETECTORS) {
		if (!tierMask(tier, d.tier)) continue;
		out = out.replace(d.re, (...m: string[]) => {
			// A match may span an already-masked value (JWT inside a PEM block): keep the first mask.
			if (m[0].includes(REDACTED)) return m[0];
			count++;
			return typeof d.rep === 'string' ? d.rep : d.rep(...m);
		});
	}
	const result = { text: out, count };
	if (text.length <= CACHE_TEXT_LIMIT) {
		if (cache.size >= CACHE_ENTRIES) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(key, result);
	}
	return result;
}

/** Writing tools call this so a masked value is never written back to disk. */
export function assertNoRedaction(content: string, file: string): void {
	if (content.includes(REDACTED)) {
		throw new Error(
			`The new content for ${file} contains ${REDACTED} — a secret that was hidden from you. Do not rewrite the whole file; use edit_file on the specific lines you need to change and leave secret values untouched.`
		);
	}
}
