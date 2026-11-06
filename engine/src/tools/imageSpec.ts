/*
 * Pure helpers behind image_generate: which backend a model string names, how
 * a requested size is read, where a default file goes, and what bytes came
 * back. No vscode import, so the rules are unit-testable on their own.
 */

/** One image request, resolved to either the local Studio or an HTTP provider. */
export type ImageTarget = { kind: 'local'; bundleId?: string } | { kind: 'cloud'; providerId: string; modelId: string };

export interface LocalImageRequest {
	prompt: string;
	bundleId?: string;
	width?: number;
	height?: number;
	seed?: number;
}

export interface LocalImageResult {
	b64: string;
	mime: string;
	seconds: number;
	width: number;
	height: number;
	bundle: { id: string; name: string };
}

/**
 * `provider/model` (cloud), `local:<bundle>` or a bare bundle id (local).
 * Empty means "automatic", which the caller resolves to the local Studio.
 * `bundleIds` are the image bundles this build knows, not which are installed.
 */
export function parseImageTarget(raw: string | undefined, bundleIds: ReadonlySet<string>): ImageTarget | undefined {
	const value = (raw ?? '').trim();
	if (!value) return undefined;
	if (/^local:/i.test(value)) {
		return { kind: 'local', bundleId: value.slice(6).trim() || undefined };
	}
	const slash = value.indexOf('/');
	if (slash > 0) {
		const providerId = value.slice(0, slash).trim();
		const modelId = value.slice(slash + 1).trim();
		if (providerId && modelId) return { kind: 'cloud', providerId, modelId };
	}
	if (bundleIds.has(value)) return { kind: 'local', bundleId: value };
	return undefined;
}

/** `1024x1024` (or `1024×1024`); undefined for "auto" or anything unusable. */
export function imageSize(raw: unknown): { width: number; height: number } | undefined {
	if (typeof raw !== 'string') return undefined;
	const m = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(raw);
	if (!m) return undefined;
	const width = Number(m[1]);
	const height = Number(m[2]);
	if (width < 64 || height < 64 || width > 4096 || height > 4096) return undefined;
	return { width, height };
}

/** The model's requested size as the string image APIs take, or undefined. */
export function sizeText(size: { width: number; height: number } | undefined): string | undefined {
	return size ? `${size.width}x${size.height}` : undefined;
}

/** A workspace-relative default: images/<stamp>-<slug>.png. */
export function defaultImageName(prompt: string, at: Date = new Date()): string {
	const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const slug = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 40);
	return `images/${stamp}-${slug || 'image'}.png`;
}

/** The real format of the bytes, whatever the provider claimed. */
export function sniffImageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | undefined {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
		bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
	) {
		return 'image/webp';
	}
	return undefined;
}

export function extensionForMime(mime: string | undefined): string {
	if (mime === 'image/jpeg') return '.jpg';
	if (mime === 'image/webp') return '.webp';
	return '.png';
}

/** PNG dimensions from its IHDR, for providers that do not echo the size back. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (sniffImageMime(bytes) !== 'image/png' || bytes.length < 24) return undefined;
	const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
	const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
	return width > 0 && height > 0 ? { width, height } : undefined;
}
