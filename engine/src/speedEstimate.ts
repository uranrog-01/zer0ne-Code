/**
 * The speed Suggest shows: a range, corrected for the kind of GPU. The same estimate as
 * Models Fit Studio (Core/SpeedEstimate.cs and Core/MachineSpeed.cs); the cases in
 * test/fixtures/suggest-cases.json hold both apps to it. Pure; no vscode dependency.
 *
 * The raw estimate is the machine's decode rate (GB of weights a second, read from llmfit's
 * own rows) over the bytes read per token. It lands close on a card with its own memory and
 * too high on a GPU that shares system RAM: on an Arc 140T a 9B model said ~15 tok/s and
 * measured 7–10. A range is honest about that.
 */

export type GpuClass = 'cpu' | 'integrated' | 'discrete';

/** .NET's Math.Round: halves go to the even neighbour, so both apps round alike. */
export function roundEven(x: number, digits = 0): number {
	const f = 10 ** digits, v = x * f, r = Math.round(v);
	return (Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / f;
}

/** cpu | integrated | discrete, from the adapter name: Windows does not report shared memory reliably. */
export function gpuClass(gpuName: string | undefined, hasGpu: boolean, unifiedMemory = false): GpuClass {
	if (!hasGpu) return 'cpu';
	if (unifiedMemory) return 'integrated';
	const g = (gpuName ?? '').toLowerCase().replace(/\(r\)/g, '').replace(/\(tm\)/g, '');
	// Arc 140T / 130V are built into the CPU; Arc A770 / B580 are cards (letter first).
	if (/\barc\s*(pro\s*)?\d{3}[a-z]\b|arc\s*graphics/.test(g)) return 'integrated';
	if (/iris|uhd|hd graphics|radeon\s*graphics|radeon\s*\d{3}m\b|\b\d{4}s\b|vega|adreno|integrated/.test(g)) return 'integrated';
	return 'discrete';
}

/** What a raw estimate becomes in real use. Only the integrated pair is measured (Arc 140T, llama.cpp Vulkan). */
export function speedFactors(cls: GpuClass): [number, number] {
	return cls === 'integrated' ? [0.45, 0.65] : cls === 'cpu' ? [0.7, 1.0] : [0.75, 1.0];
}

/** How far a real run sits from a calibrated estimate: other models differ from the measured one. */
const CALIBRATED_SPREAD = 0.15;

/** The range to show for a raw estimate. A calibration (measured ÷ raw) replaces the per-class guess. */
export function speedRange(rawTps: number, cls: GpuClass, calibration = 0): [number, number] {
	if (!(rawTps > 0)) return [0, 0];
	const [low, high] = calibration > 0 ? [calibration * (1 - CALIBRATED_SPREAD), calibration * (1 + CALIBRATED_SPREAD)] : speedFactors(cls);
	return [roundEven(rawTps * low, 1), roundEven(rawTps * high, 1)];
}

/** One correction from real runs: the median of measured ÷ raw, without ratios no hardware gives. 0 when none. */
export function speedCalibration(runs: Array<{ measuredTps: number; rawTps: number }>): number {
	const ratios = runs.filter((r) => r.measuredTps > 0 && r.rawTps > 0).map((r) => r.measuredTps / r.rawTps).filter((x) => x >= 0.1 && x <= 3).sort((a, b) => a - b);
	if (!ratios.length) return 0;
	const mid = Math.floor(ratios.length / 2);
	return roundEven(ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2, 3);
}

/** The machine's decode rate: the median of tok/s × size over llmfit rows (the median shrugs off MoE and offload rows). */
export function machineGbPerSec(rows: Array<{ estimated_tps?: number; disk_size_gb?: number }>): number {
	const samples: number[] = [];
	for (const m of rows) {
		const tps = Number(m.estimated_tps) || 0, size = Number(m.disk_size_gb) || 0;
		if (tps <= 0 || size < 0.5) continue;
		samples.push(tps * size);
		if (samples.length >= 400) break;
	}
	if (samples.length < 5) return 0;
	samples.sort((a, b) => a - b);
	return roundEven(samples[Math.floor(samples.length / 2)], 1);
}

/** Raw speed for a file of this size. Small models do not scale linearly: the tail is damped. */
export function rawTps(gbPerSec: number, sizeGb: number): number {
	if (gbPerSec <= 0 || sizeGb <= 0) return 0;
	return roundEven(Math.min(220, Math.max(1.5, gbPerSec / (sizeGb + 0.4))), 1);
}
