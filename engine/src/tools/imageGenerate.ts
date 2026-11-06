import * as path from 'path';
import * as vscode from 'vscode';
import { imagesUrl, post, type ToolDef } from '../chatClient';
import { DIFFUSION_BUNDLES } from '../localCatalog';
import type { ProviderConfig } from '../providerStore';
import { exists, rel, resolveInWorkspace, type ToolContext, type ToolOutcome } from './agentTools';
import {
	defaultImageName,
	extensionForMime,
	imageSize,
	parseImageTarget,
	pngSize,
	sizeText,
	sniffImageMime
} from './imageSpec';

/**
 * image_generate: one image per call, saved in the project and shown on the
 * tool card. The local Studio model is preferred when one is installed;
 * otherwise an OpenAI-compatible provider's images endpoint is used. Each call
 * needs the user's approval, because a generation takes minutes of GPU time or
 * spends money on the provider account.
 */

export const IMAGE_TOOL = 'image_generate';
const MAX_PROMPT_CHARS = 4000;
const MAX_IMAGE_BYTES = 25_000_000;
const THUMBNAIL_BYTES = 1_200_000;

export function imageGenerateDef(): ToolDef {
	return {
		name: IMAGE_TOOL,
		description: [
			'Generate one image from a text prompt and save it in the project.',
			'Only call this when the user asks you to create an image. If you think an image would help but the user did not ask for one, ask first instead of generating it.',
			'One call makes one image; for several images, call it once per image.',
			'It runs on the local Studio model when an image model is installed, otherwise on the configured image provider.',
			'The user approves each call.'
		].join('\n'),
		parameters: {
			type: 'object',
			properties: {
				prompt: {
					type: 'string',
					description: 'What to create. Be specific about subject, style, composition and any text that should appear in the image.'
				},
				path: {
					type: 'string',
					description: 'Where to save the image, relative to the workspace or absolute. Defaults to a new file under images/. The extension follows the real format.'
				},
				size: {
					type: 'string',
					description: 'WIDTHxHEIGHT, e.g. 1024x1024 or 1536x1024. Omit (or "auto") for the model default.'
				},
				model: {
					type: 'string',
					description: 'provider/model, local:<bundle> or a Studio bundle id. Omit to use the configured default.'
				}
			},
			required: ['prompt'],
			additionalProperties: false
		}
	};
}

type Local = { kind: 'local'; bundleId?: string; label: string };
type Cloud = { kind: 'cloud'; provider: ProviderConfig; key: string; modelId: string; label: string };

export async function runImageGenerate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
	const prompt = String(args.prompt ?? '').trim();
	if (!prompt) throw new Error('A prompt is required.');
	if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`The prompt is longer than ${MAX_PROMPT_CHARS} characters.`);

	const requestedSize = typeof args.size === 'string' ? args.size.trim() : '';
	const size = imageSize(requestedSize);
	if (requestedSize && !size && !/^auto$/i.test(requestedSize)) {
		throw new Error('size must be WIDTHxHEIGHT (for example 1024x1024) or auto.');
	}

	const target = await resolveTarget(typeof args.model === 'string' ? args.model : undefined, ctx);

	// The file is known before the call, so the approval names the exact path.
	const requested = typeof args.path === 'string' ? args.path.trim() : '';
	const wanted = resolveInWorkspace(requested || defaultImageName(prompt));
	const existed = await exists(wanted);
	const planned = rel(wanted);
	const details = [
		`Model: ${target.label}`,
		// The card is a preview; the full prompt goes to the model and into the tool detail.
		`Prompt: ${prompt.length > 1200 ? `${prompt.slice(0, 1200)}…` : prompt}`,
		`Size: ${size ? `${size.width}×${size.height}` : 'model default'}`,
		`Saves to: ${planned} (the extension follows the real format)`,
		target.kind === 'cloud' ? 'Cost: charged to your provider account.' : 'Runs on this computer.'
	].join('\n');
	const handle = await ctx.requestApproval({ kind: 'image', path: planned, content: details, existed, cost: target.kind === 'cloud' });
	if (!handle.approved) {
		return { api: 'The user rejected the image generation.', summary: 'rejected', error: true };
	}

	try {
		const made =
			target.kind === 'local'
				? await generateLocal(prompt, target, size, ctx)
				: await generateCloud(prompt, target, size, ctx);
		const mime = sniffImageMime(made.bytes) ?? made.mime;
		const file = withExtension(wanted, mime);
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
		await vscode.workspace.fs.writeFile(file, made.bytes);

		const saved = rel(file);
		const kb = Math.max(1, Math.round(made.bytes.length / 1024));
		const dimensions = made.width && made.height ? `${made.width}×${made.height}` : undefined;
		const note = `Saved ${saved} (${[dimensions, `${kb} KB`].filter(Boolean).join(', ')}) with ${target.label} in ${made.seconds} s.`;
		handle.finish(note);

		const base64 = made.bytes.toString('base64');
		const attached = ctx.vision && made.bytes.length <= 5_000_000;
		const api = attached
			? `${note} The image is attached.`
			: ctx.vision
				? `${note} The image is too large to attach; tell the user where the file is.`
				: `${note} The current model cannot see images; tell the user where the file is.`;
		return {
			api,
			summary: [target.label, dimensions, `${made.seconds} s`].filter(Boolean).join(' · '),
			detail: `Prompt: ${prompt}\nModel: ${target.label}\nSaved: ${saved}\nSize: ${dimensions ?? 'model default'}\nTime: ${made.seconds} s`,
			image: made.bytes.length <= THUMBNAIL_BYTES ? `data:${mime};base64,${base64}` : undefined,
			images: attached ? [{ mime, base64, name: path.basename(file.fsPath) }] : undefined
		};
	} catch (error) {
		handle.finish(error instanceof Error ? error.message : String(error), true);
		throw error;
	}
}

async function resolveTarget(choice: string | undefined, ctx: ToolContext): Promise<Local | Cloud> {
	const configured = (choice ?? '').trim() || ctx.settings.imageGenModel.trim();
	const bundles = new Set(DIFFUSION_BUNDLES.filter((b) => b.kind === 'image').map((b) => b.id));
	const parsed = parseImageTarget(configured, bundles);
	if (configured && !parsed) {
		throw new Error(`"${configured}" is not an image model. Use provider/model, local:<bundle>, or a Studio bundle id.`);
	}
	if (!parsed) {
		const images = ctx.imageGen?.installed() ?? [];
		if (!images.length) {
			throw new Error(
				'No image model is available. Download an image model in Settings → Local models, or set one (provider/model) in Settings → Features → Image generation.'
			);
		}
		return { kind: 'local', label: `Local Studio · ${images[0].name}` };
	}
	if (parsed.kind === 'local') {
		const images = ctx.imageGen?.installed() ?? [];
		const hit = parsed.bundleId ? images.find((b) => b.id === parsed.bundleId) : images[0];
		if (!hit) {
			const available = images.map((b) => b.id).join(', ') || 'none';
			throw new Error(
				parsed.bundleId
					? `"${parsed.bundleId}" is not an installed image model. Installed: ${available}.`
					: `No local image model is installed. Installed: ${available}.`
			);
		}
		return { kind: 'local', bundleId: hit.id, label: `Local Studio · ${hit.name}` };
	}
	const provider = await ctx.store.get(parsed.providerId);
	if (!provider) throw new Error(`No provider "${parsed.providerId}" is configured.`);
	if (provider.apiFormat !== 'openai' && provider.apiFormat !== 'responses') {
		throw new Error(`${provider.name} is not an OpenAI-compatible provider, so it cannot serve an images endpoint.`);
	}
	if (!provider.baseUrl?.trim()) throw new Error(`${provider.name} has no Base URL.`);
	const key = await ctx.store.getApiKey(provider.id);
	if (!key) throw new Error(`No API key for ${provider.name}. Add one in Providers & models.`);
	return { kind: 'cloud', provider, key, modelId: parsed.modelId, label: `${provider.name} · ${parsed.modelId}` };
}

async function generateLocal(
	prompt: string,
	target: Local,
	size: { width: number; height: number } | undefined,
	ctx: ToolContext
): Promise<{ bytes: Buffer; mime: string; seconds: number; width?: number; height?: number }> {
	if (!ctx.imageGen) throw new Error('Local image generation is not available in this host.');
	const result = await ctx.imageGen.local(
		{ prompt, bundleId: target.bundleId, width: size?.width, height: size?.height },
		// The tool card has no progress channel; the signal still cancels the job.
		() => undefined
	);
	const bytes = Buffer.from(result.b64, 'base64');
	if (!bytes.length) throw new Error('The Studio returned an empty image.');
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The Studio returned an image larger than 25 MB.');
	return { bytes, mime: result.mime, seconds: Math.round(result.seconds), width: result.width, height: result.height };
}

async function generateCloud(
	prompt: string,
	target: Cloud,
	size: { width: number; height: number } | undefined,
	ctx: ToolContext
): Promise<{ bytes: Buffer; mime: string; seconds: number; width?: number; height?: number }> {
	const started = Date.now();
	const response = await post(
		imagesUrl(target.provider.baseUrl!),
		{ Authorization: `Bearer ${target.key}` },
		{ model: target.modelId, prompt, n: 1, ...(size ? { size: sizeText(size) } : {}) },
		ctx.signal,
		target.modelId
	);
	const payload = (await response.json().catch(() => undefined)) as { data?: Array<{ b64_json?: unknown; url?: unknown }> } | undefined;
	const item = payload?.data?.[0];
	const base64 =
		typeof item?.b64_json === 'string'
			? item.b64_json
			: typeof item?.url === 'string'
				? await downloadImage(item.url, ctx.signal)
				: undefined;
	if (!base64) throw new Error(`${target.label} returned no image.`);
	const bytes = Buffer.from(base64, 'base64');
	if (!bytes.length) throw new Error(`${target.label} returned an empty image.`);
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The provider returned an image larger than 25 MB.');
	const png = pngSize(bytes);
	return {
		bytes,
		mime: sniffImageMime(bytes) ?? 'image/png',
		seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
		width: size?.width ?? png?.width,
		height: size?.height ?? png?.height
	};
}

/** OpenAI returns a URL for some models instead of base64. */
async function downloadImage(url: string, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) });
	if (!response.ok) throw new Error(`Could not download the generated image (HTTP ${response.status}).`);
	const declared = Number(response.headers.get('content-length') ?? 0);
	if (declared > MAX_IMAGE_BYTES) throw new Error('The provider returned an image larger than 25 MB.');
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_IMAGE_BYTES) throw new Error('The provider returned an image larger than 25 MB.');
	return bytes.toString('base64');
}

/** The approved path keeps its name; only the extension follows the real format. */
function withExtension(uri: vscode.Uri, mime: string): vscode.Uri {
	const ext = path.extname(uri.fsPath);
	const stem = ext ? uri.fsPath.slice(0, -ext.length) : uri.fsPath;
	return vscode.Uri.file(stem + extensionForMime(mime));
}
