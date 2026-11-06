/**
 * Which GGUF files of a repository are the model, and which only help one. Next to the
 * weights a repository often holds small files that load only beside the real model: a
 * vision projector (mmproj), a draft head that speeds generation up (mtp-…, draft, eagle),
 * an importance matrix, a bare vocabulary. Offered as "the build to download", a 0.5 GB
 * draft head made a 26B model look tiny and very fast.
 *
 * A full build can carry its draft layers inside and say so in its name
 * ("Qwen3.8-27B-…-MTP.gguf", 17 GB): a draft name makes a helper only when the file is too
 * small to be the model.
 *
 * Models Fit Studio applies the same rule (Core/RepoFiles.cs); the cases in
 * test/fixtures/fit-cases.json hold both to it. Pure; no vscode dependency.
 */

const HELPER = /mmproj|(^|\/)imatrix[^/]*$|(^|[-_./])(mtp|draft|eagle|dflash|dspark)([-_./]|$)|(^|\/)ggml-vocab[-_.]/i;
const SIDE = /mmproj|(^|\/)imatrix[^/]*$|(^|[-_./])(dflash|dspark)([-_./]|$)|(^|\/)ggml-vocab[-_.]/i;

/** These architectures verify or draft for another model; file size cannot make them standalone chat models. */
export function draftArchitecture(arch: string | undefined): boolean {
	return typeof arch === 'string' && /^(dflash|dspark|eagle[23]?)$|-assistant$/i.test(arch);
}

/**
 * GB per billion parameters no real build goes below. The smallest quants llama.cpp
 * makes store about 1.6 bits a weight (0.2); half of that leaves room for a count that
 * is a little off.
 */
export const FLOOR_GB_PER_B = 0.1;

/** Without a parameter count, a draft-named file this large is a build: draft heads seen so far are 0.1–1 GB. */
export const DRAFT_MAX_BYTES = 3e9;

/** "7B", "0.6b", "8x7B", "235B-A22B" in a repo or file name → parameter count. */
export function paramsFromName(id: string): number | undefined {
	const name = id.replace(/\\/g, '/').split('/').pop() ?? id;
	const moe = /(\d+)x(\d+(?:\.\d+)?)b\b/i.exec(name);
	if (moe) return Number(moe[1]) * Number(moe[2]) * 1e9;
	const m = /(?:^|[-_.])(\d+(?:\.\d+)?)([bm])(?=$|[-_.])/i.exec(name);
	if (!m) return undefined;
	return Number(m[1]) * (m[2].toLowerCase() === 'b' ? 1e9 : 1e6);
}

/**
 * The path names a draft head for multi-token prediction ("mtp-…"): a small network that guesses
 * the next few tokens for the model to confirm. The name only nominates it; the file's own header
 * decides (modelFit.ts).
 */
export function draftHeadName(file: string | undefined): boolean {
	return !!file && /(^|[-_./])mtp([-_./]|$)/i.test(file.replace(/\\/g, '/')) && !/mmproj/i.test(file);
}

/** The path names a helper file. Without a size this is the whole answer. */
export function helperFile(file: string | undefined): boolean {
	return !!file && HELPER.test(file.replace(/\\/g, '/'));
}

/**
 * A helper file, knowing its size: projectors, matrices and vocabularies always; a draft-named
 * file only when it is smaller than a build of the model could be (the parameter count, or the
 * count in the name, at FLOOR_GB_PER_B; DRAFT_MAX_BYTES when neither is known).
 */
export function helperBySize(file: string | undefined, sizeBytes: number, paramsB?: number): boolean {
	if (!helperFile(file)) return false;
	const f = file!.replace(/\\/g, '/');
	if (SIDE.test(f)) return true;
	const b = paramsB && paramsB > 0 ? paramsB : (paramsFromName(f) ?? 0) / 1e9;
	return sizeBytes < (b > 0 ? b * FLOOR_GB_PER_B * 1e9 : DRAFT_MAX_BYTES);
}

/**
 * The files that are the model itself: no helper, and none far smaller than the parameter
 * count allows. Without a count, or when the count would leave nothing (an adapter
 * repository, a wrong count), size is not used to drop plain-named files.
 */
export function modelFiles<F extends { name: string; sizeBytes?: number; parts?: string[] }>(files: F[], paramsB?: number): F[] {
	const named = files.filter((f) => !helperBySize(f.parts?.[0] ?? f.name, f.sizeBytes ?? 0, paramsB) && !helperBySize(f.name, f.sizeBytes ?? 0, paramsB));
	if (!paramsB || !(paramsB > 0)) return named;
	const sized = named.filter((f) => (f.sizeBytes ?? 0) >= paramsB * FLOOR_GB_PER_B * 1e9);
	return sized.length ? sized : named;
}
