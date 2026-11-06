import * as fs from 'fs';
import * as path from 'path';
import { ENGINE_PIN } from './localEngine';
import { hfCached } from './hfCache';
import { draftArchitecture } from './repoFiles';

export interface NativeSupport { version: string; architectures: string[]; exact: boolean; tensorTypes?: string[] }

/**
 * The tensor formats every llama.cpp build has carried since the K-quants
 * (the list of the b2300 sources, March 2024). When the engine's own
 * list of formats cannot be read — offline, or a build whose sources are not
 * reachable — only these may be offered: a format added later does not exist
 * in an older engine at all, and the model would then fail to load.
 * Everything outside this list stays unconfirmed and is not offered.
 */
const BASELINE_TENSORS: ReadonlySet<string> = new Set([
	'F32', 'F16',
	'Q4_0', 'Q4_1', 'Q5_0', 'Q5_1', 'Q8_0', 'Q8_1',
	'Q2_K', 'Q3_K', 'Q4_K', 'Q5_K', 'Q6_K', 'Q8_K',
	'IQ1_S', 'IQ2_S', 'IQ2_XS', 'IQ2_XXS', 'IQ3_S', 'IQ3_XXS', 'IQ4_NL', 'IQ4_XS'
]);

export function parseTensorTypes(text: string): string[] {
	const source = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
	return [...new Set([...source.matchAll(/GGML_TYPE_([A-Z0-9_]+)\s*=/g)].map(m => m[1]).filter(t => t !== 'COUNT'))];
}

export function quantizationReason(quant: string, support: NativeSupport): string | undefined {
	const name = quant.toUpperCase().replace(/^UD-/, '').replace(/^(Q[2-8]_K)_(S|M|L|XL)$/, '$1');
	if (support.tensorTypes) {
		if (!support.tensorTypes.includes(name)) return `The ${quant} tensor format is not available in engine ${support.version}. Update the engine or choose another GGUF build.`;
		return undefined;
	}
	// The engine's format list is unknown: only formats every llama.cpp build
	// carries may be offered, the rest is unverified and could not load.
	if (!BASELINE_TENSORS.has(name)) return `The ${quant} tensor format is not confirmed for engine ${support.version}. Update the engine, or refresh the runtime support information online, before using this build.`;
	return undefined;
}

export function parseArchitectures(text: string): string[] {
	return [...new Set([...text.matchAll(/\{ LLM_ARCH_[A-Z0-9_]+,\s*"([a-z0-9_-]+)"/g)].map((m) => m[1]))];
}

export function architectureReason(arch: string | undefined, support: NativeSupport): string | undefined {
	if (draftArchitecture(arch)) return `The ${arch} architecture is a draft helper, not a standalone chat model. It needs its matching main model; an engine update alone cannot make it run independently.`;
	if (!arch) return 'The GGUF architecture is unknown; engine compatibility cannot be confirmed yet.';
	if (!support.exact) return `Architecture support for engine ${support.version} is not cached yet. Refresh models while online.`;
	if (!support.architectures.includes(arch)) return `The ${arch} architecture is not supported by engine ${support.version}. Check Engine for an engine update.`;
	return undefined;
}

export async function nativeSupport(dir: string, version = ENGINE_PIN): Promise<NativeSupport> {
	let bundled: { version: string; architectures: string[]; tensorTypes?: string[] } = { version: ENGINE_PIN, architectures: [] };
	try { bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'vendor', 'llama-architectures.json'), 'utf8')); } catch { /* Unknown support must not become a positive match. */ }
	if (version === bundled.version && bundled.architectures.length) return { ...bundled, exact: true };
	if (/^b\d{4,8}$/.test(version)) {
		try {
			const result = await hfCached(dir, `engine-architecture|${version}`, async () => {
				const response = await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${version}/src/llama-arch.cpp`, { signal: AbortSignal.timeout(15_000) });
				if (!response.ok) throw new Error(`Engine architecture source HTTP ${response.status}`);
				const architectures = parseArchitectures(await response.text());
				if (architectures.length < 20) throw new Error('Incomplete engine architecture source.');
				return architectures;
			}, 30 * 86400_000, true);
			const tensors = await hfCached(dir, `engine-tensors|${version}`, async () => {
				// ggml.h moved: it was at the repository root until b2500 and lives under
				// ggml/include/ since. Both are tried so the format list is known for
				// as many engine builds as possible.
				const paths = ['ggml/include/ggml.h', 'ggml.h'];
				let last = '';
				for (const p of paths) {
					const response = await fetch(`https://raw.githubusercontent.com/ggml-org/llama.cpp/${version}/${p}`, { signal: AbortSignal.timeout(15_000) });
					if (!response.ok) {
						last = `HTTP ${response.status}`;
						continue;
					}
					const types = parseTensorTypes(await response.text());
					if (types.length < 15) {
						last = 'Incomplete tensor support source.';
						continue;
					}
					return types;
				}
				throw new Error(`Tensor support source unavailable (${last}).`);
			}, 30 * 86400_000, true).catch(() => undefined);
			return { version, architectures: result.value, exact: true, tensorTypes: tensors?.value };
		} catch { /* Keep local models usable; new downloads explain why support is unknown. */ }
	}
	return { version, architectures: [], exact: false };
}
