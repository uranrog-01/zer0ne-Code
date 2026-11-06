import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { scrubEnv } from './tools/proc';

/**
 * Local models: what this machine can run, and running it through Ollama
 * (or any OpenAI-compatible local server — LM Studio, llama.cpp, vLLM).
 *
 * The fit check follows codex-router (MIT): weights + ~20% for the KV cache
 * and runtime must fit the GPU budget to run fast ("fits"), system RAM to run
 * at all ("tight"), else "too-large". Download size and tool support come
 * from the Ollama registry manifest — a few KB instead of a multi-GB pull.
 */

export type Fit = 'fits' | 'tight' | 'too-large';

export interface Machine {
	platform: string;
	cpu: string;
	cores: number;
	totalMemoryBytes: number;
	gpuName?: string;
	/** Dedicated GPU memory (NVIDIA / discrete). Undefined for integrated GPUs. */
	gpuMemoryBytes?: number;
	unifiedMemory: boolean;
	freeDiskBytes?: number;
	/** Runs at full speed below this. */
	fastBudgetBytes: number;
	/** Runs at all below this. */
	ceilingBytes: number;
}

export interface LocalModelInfo {
	tag: string;
	sizeGb: number;
	tools?: boolean;
	vision?: boolean;
	context?: number;
	family?: string;
	params?: string;
	quant?: string;
	fit?: Fit;
	note?: string;
	installed?: boolean;
}

export interface LocalServer {
	id: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'jan' | 'kobold' | 'gpt4all' | 'lemonade' | 'textgen';
	name: string;
	baseUrl: string;
	running: boolean;
	version?: string;
	models?: string[];
}

const OVERHEAD = 1.2;
const SYSTEM_HEADROOM = 0.8;
const UNIFIED_GPU_SHARE = 0.75;
const COMFORTABLE_CPU_SHARE = 0.6;
const GIB = 1024 ** 3;
export const OLLAMA_URL = process.env.OLLAMA_HOST ? normalizeHost(process.env.OLLAMA_HOST) : 'http://127.0.0.1:11434';
const REGISTRY = 'https://registry.ollama.ai';

function normalizeHost(h: string): string {
	const withScheme = /^https?:\/\//.test(h) ? h : `http://${h}`;
	return withScheme.replace(/\/+$/, '').replace('0.0.0.0', '127.0.0.1');
}

/**
 * Coding-capable models with tool calling, smallest first. Sizes are the
 * registry download sizes; they are re-read live before a download.
 * Notes on qwen2.5-coder / llama3.2 behaviour come from codex-router's runs.
 */
export const SUGGESTED: ReadonlyArray<Omit<LocalModelInfo, 'fit' | 'installed'>> = [
	{ tag: 'qwen2.5-coder:1.5b', sizeGb: 1, tools: true, context: 32768, note: 'Smallest coder — autocomplete and quick edits' },
	{ tag: 'llama3.2:3b', sizeGb: 2, tools: true, context: 131072, note: 'Makes real tool calls; too small for long agent prompts' },
	{ tag: 'qwen2.5-coder:3b', sizeGb: 1.9, tools: true, context: 32768, note: 'Small coder' },
	{ tag: 'qwen2.5-coder:7b', sizeGb: 4.7, tools: true, context: 32768, note: 'Practical floor for agent work' },
	{ tag: 'qwen3:8b', sizeGb: 5.2, tools: true, context: 40960, note: 'Thinking + tools, good all-rounder' },
	{ tag: 'llama3.1:8b', sizeGb: 4.9, tools: true, context: 131072, note: 'General purpose, long context' },
	{ tag: 'qwen2.5-coder:14b', sizeGb: 9, tools: true, context: 32768, note: 'Stronger coder' },
	{ tag: 'gpt-oss:20b', sizeGb: 13.8, tools: true, context: 131072, note: 'OpenAI open-weight reasoning model' },
	{ tag: 'devstral', sizeGb: 14.3, tools: true, context: 131072, note: 'Built for coding agents' },
	{ tag: 'qwen3-coder:30b', sizeGb: 19, tools: true, context: 262144, note: 'MoE coder — fast for its size' },
	{ tag: 'qwen2.5-coder:32b', sizeGb: 20, tools: true, context: 32768, note: 'Best dense Qwen coder' },
	{ tag: 'gpt-oss:120b', sizeGb: 65, tools: true, context: 131072, note: 'Workstation class' }
];

// ---------------------------------------------------------------- machine

/** Driver-reported shared memory on an integrated GPU is part of system RAM. */
export function integratedGpu(name?: string): boolean {
	return /arc\S*\s*(\(tm\)\s*)?1[34]0[vt]|arc\(tm\) graphics|iris|uhd|hd graphics|integrated|radeon\(tm\)\s*graphics|radeon\s*\d{3}m|\b(890|880|860|780|760|740|680|660)m\b|80[56]0s|vega \d+ graphics|adreno|mali/i.test(name ?? '');
}

/** Pure: budgets from raw numbers (testable against machines this one is not). */
export function machineCapacity(m: Omit<Machine, 'fastBudgetBytes' | 'ceilingBytes'>): Machine {
	const system = Math.floor(m.totalMemoryBytes * SYSTEM_HEADROOM);
	const gpu = m.unifiedMemory ? Math.floor(m.totalMemoryBytes * UNIFIED_GPU_SHARE) : integratedGpu(m.gpuName) ? undefined : m.gpuMemoryBytes;
	return {
		...m,
		fastBudgetBytes: gpu || Math.floor(system * COMFORTABLE_CPU_SHARE),
		ceilingBytes: Math.max(gpu || 0, system)
	};
}

/**
 * Pure: the engine's fit defaults, scaled to the machine.
 *
 * - Auto context is tier-capped by RAM: llama.cpp's "largest that fits" reads
 *   like a memory leak on big-RAM machines and buys chat nothing past 64k.
 * - The fit margin leaves the OS room. GPUs that draw from system RAM —
 *   integrated ones, or none detected — keep ~10% of RAM free, never under
 *   2 GiB; dedicated VRAM keeps 1 GiB. NVIDIA names always mean dedicated
 *   cards (nvidia-smi reports real VRAM); other vendors reporting under
 *   8 GiB share memory or spill into it (WDDM) either way.
 * - The prompt-cache reserve is 4% of RAM (512 MiB – 4 GiB): agent turns
 *   resend a growing prompt, but 8% starved small machines.
 */
export function engineFit(m: { totalMemoryBytes: number; unifiedMemory: boolean; gpuName?: string; gpuMemoryBytes?: number }): { context: number; fitMarginMiB: number; cacheRamMiB: number } {
	const ramMiB = Math.round(m.totalMemoryBytes / 1048576);
	const shared = m.unifiedMemory || integratedGpu(m.gpuName) || !m.gpuMemoryBytes || (!/nvidia/i.test(m.gpuName ?? '') && m.gpuMemoryBytes < 8 * GIB);
	return {
		context: m.totalMemoryBytes <= 16 * GIB ? 16_384 : m.totalMemoryBytes <= 32 * GIB ? 32_768 : 65_536,
		fitMarginMiB: shared ? Math.max(2048, Math.round(ramMiB * 0.10)) : 1024,
		cacheRamMiB: Math.max(512, Math.min(4096, Math.round(ramMiB * 0.04)))
	};
}

export function rateFit(sizeGb: number, m: Machine): Fit | undefined {
	const need = sizeGb * 1e9 * OVERHEAD;
	if (!Number.isFinite(need) || need <= 0) {
		return undefined;
	}
	return need <= m.fastBudgetBytes ? 'fits' : need <= m.ceilingBytes ? 'tight' : 'too-large';
}

export function fitAdvice(tag: string, sizeGb: number, m: Machine): string | undefined {
	const fit = rateFit(sizeGb, m);
	if (fit === 'tight') {
		return `${tag} (${sizeGb} GB) is near this machine's limit (${describeMachine(m)}) — it will spill onto the CPU and run slowly.`;
	}
	if (fit === 'too-large') {
		return `${tag} needs about ${Math.ceil(sizeGb * OVERHEAD)} GB to run; this machine has ${describeMachine(m)}.`;
	}
	return undefined;
}

export function describeMachine(m: Machine): string {
	const gb = (b: number) => (b / 1e9).toFixed(1) + ' GB';
	const mem = m.unifiedMemory ? `${gb(m.totalMemoryBytes)} unified memory` : `${gb(m.totalMemoryBytes)} RAM`;
	const gpu = m.unifiedMemory ? `GPU budget ~${gb(m.fastBudgetBytes)}` : m.gpuMemoryBytes ? `${gb(m.gpuMemoryBytes)} GPU memory` : 'no dedicated GPU memory — models run on the CPU';
	return `${mem} · ${gpu}`;
}

function nvidia(): { name?: string; bytes?: number } {
	try {
		const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
		if (r.status !== 0 || !r.stdout) {
			return {};
		}
		const best = r.stdout
			.split(/\r?\n/)
			.map((l) => l.split(',').map((x) => x.trim()))
			.filter((p) => p.length >= 2 && Number(p[1]) > 0)
			.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
		return best ? { name: best[0], bytes: Number(best[1]) * 1048576 } : {};
	} catch {
		return {};
	}
}

/** Windows: the display adapter's name and (when the driver records it) its dedicated memory. */
function windowsGpu(): { name?: string; bytes?: number } {
	try {
		const ps =
			"Get-ItemProperty -Path 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ n = $_.DriverDesc; m = $_.'HardwareInformation.qwMemorySize' } } | ConvertTo-Json -Compress";
		const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 6000, windowsHide: true });
		if (r.status !== 0 || !r.stdout.trim()) {
			return {};
		}
		const raw = JSON.parse(r.stdout.trim());
		const list: Array<{ n?: string; m?: number }> = Array.isArray(raw) ? raw : [raw];
		const real = list.filter((g) => g.n && !/basic display|remote display|virtual/i.test(g.n));
		const best = real.sort((a, b) => (Number(b.m) || 0) - (Number(a.m) || 0))[0];
		// Integrated GPUs report no dedicated memory (or a token amount): treat as CPU.
		const bytes = Number(best?.m) || 0;
		return { name: best?.n, bytes: bytes >= 2 * 1024 ** 3 ? bytes : undefined };
	} catch {
		return {};
	}
}

/** Linux without nvidia-smi: AMD (amdgpu) cards report VRAM in sysfs; Intel iGPUs share RAM. */
function linuxGpu(): { name?: string; bytes?: number } {
	try {
		let best: { name?: string; bytes?: number } = {};
		for (const card of fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c))) {
			const dev = path.join('/sys/class/drm', card, 'device');
			const read = (f: string) => {
				try {
					return fs.readFileSync(path.join(dev, f), 'utf8').trim();
				} catch {
					return '';
				}
			};
			const vendor = read('vendor');
			const vram = Number(read('mem_info_vram_total')) || 0;
			const name = vendor === '0x1002' ? 'AMD Radeon GPU' : vendor === '0x8086' ? 'Intel GPU' : vendor === '0x10de' ? 'NVIDIA GPU' : undefined;
			if (name && vram > (best.bytes || 0)) best = { name, bytes: vram >= 2 * 1024 ** 3 ? vram : undefined };
			else if (name && !best.name) best = { name };
		}
		return best;
	} catch {
		return {};
	}
}

/** Intel Macs: a discrete AMD GPU (system_profiler reports its VRAM). */
function macIntelGpu(): { name?: string; bytes?: number } {
	try {
		const r = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], { encoding: 'utf8', timeout: 8000 });
		const cards: any[] = JSON.parse(r.stdout || '{}')?.SPDisplaysDataType ?? [];
		const withVram = cards
			.map((c) => ({ name: String(c.sppci_model || c._name || ''), gb: parseFloat(String(c.spdisplays_vram || c.spdisplays_vram_shared || '0')) }))
			.sort((a, b) => b.gb - a.gb)[0];
		return withVram ? { name: withVram.name, bytes: withVram.gb >= 2 ? withVram.gb * 1024 ** 3 : undefined } : {};
	} catch {
		return {};
	}
}

export function freeDisk(dir: string): number | undefined {
	let d = dir;
	for (let i = 0; i < 6; i++) {
		try {
			const s = fs.statfsSync(d);
			return Number(s.bavail) * Number(s.bsize);
		} catch {
			const up = path.dirname(d);
			if (up === d) {
				break;
			}
			d = up;
		}
	}
	return undefined;
}

let machineCache: Machine | undefined;
export function detectMachine(refresh = false): Machine {
	if (machineCache && !refresh) {
		return machineCache;
	}
	const unified = process.platform === 'darwin' && process.arch === 'arm64';
	let gpu: { name?: string; bytes?: number } = {};
	if (!unified) {
		gpu = nvidia();
		if (!gpu.bytes) {
			const other = process.platform === 'win32' ? windowsGpu() : process.platform === 'linux' ? linuxGpu() : process.platform === 'darwin' ? macIntelGpu() : {};
			gpu = { name: gpu.name || other.name, bytes: other.bytes };
		}
	}
	const cpus = os.cpus();
	machineCache = machineCapacity({
		platform: process.platform,
		cpu: cpus[0]?.model?.trim() || process.arch,
		cores: cpus.length,
		totalMemoryBytes: os.totalmem(),
		// The chip name ("Apple M3 Max") is what tells a 100 GB/s base chip from a 400 GB/s Max in the speed estimates.
		gpuName: unified ? `${/^apple\s/i.test(cpus[0]?.model?.trim() ?? '') ? cpus[0].model.trim() : 'Apple Silicon'} (unified memory)` : gpu.name,
		gpuMemoryBytes: gpu.bytes,
		unifiedMemory: unified,
		freeDiskBytes: freeDisk(process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models'))
	});
	return machineCache;
}

// ---------------------------------------------------------------- servers

async function getJson(url: string, ms = 1200, init?: RequestInit): Promise<any> {
	const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}`);
	}
	return res.json();
}

/** Where the Ollama binary lives, if installed (for "Start Ollama"). */
export function ollamaBinary(): string | undefined {
	const candidates =
		process.platform === 'win32'
			? [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), 'C:\\Program Files\\Ollama\\ollama.exe']
			: process.platform === 'darwin'
				? ['/Applications/Ollama.app/Contents/Resources/ollama', '/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']
				: ['/usr/local/bin/ollama', '/usr/bin/ollama', path.join(os.homedir(), '.local', 'bin', 'ollama')];
	const found = candidates.find((c) => c && fs.existsSync(c));
	if (found) {
		return found;
	}
	const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', timeout: 2000, windowsHide: true });
	return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

/** Start `ollama serve` in the background and wait until it answers (≤10 s). */
export async function startOllama(binary?: string): Promise<boolean> {
	const bin = binary ?? ollamaBinary();
	if (!bin) {
		return false;
	}
	const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...scrubEnv(), OLLAMA_HOST: OLLAMA_URL } });
	child.on('error', () => undefined);
	child.unref();
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			await getJson(`${OLLAMA_URL}/api/version`, 500);
			return true;
		} catch {
			/* not up yet */
		}
	}
	return false;
}

/** Probe the usual local servers in parallel (≈1 s worst case). */
export async function detectServers(): Promise<LocalServer[]> {
	const probes: Array<Promise<LocalServer>> = [
		getJson(`${OLLAMA_URL}/api/version`, 800).then(
			(v) => ({ id: 'ollama' as const, name: 'Ollama', baseUrl: `${OLLAMA_URL}/v1`, running: true, version: v?.version }),
			() => ({ id: 'ollama' as const, name: 'Ollama', baseUrl: `${OLLAMA_URL}/v1`, running: false })
		),
		...([
			['lmstudio', 'LM Studio', 'http://127.0.0.1:1234/v1'],
			['llamacpp', 'llama.cpp server', 'http://127.0.0.1:8080/v1'],
			['vllm', 'vLLM', 'http://127.0.0.1:8000/v1'],
			['jan', 'Jan', 'http://127.0.0.1:1337/v1'],
			['kobold', 'KoboldCpp', 'http://127.0.0.1:5001/v1'],
			['gpt4all', 'GPT4All', 'http://127.0.0.1:4891/v1'],
			// AMD's Lemonade Server (Ryzen AI, llama.cpp Vulkan): its OpenAI API lives under /api/v1.
			['lemonade', 'Lemonade', 'http://127.0.0.1:8000/api/v1'],
			['textgen', 'text-generation-webui', 'http://127.0.0.1:5000/v1']
		] as const).map(([id, name, baseUrl]) =>
			getJson(`${baseUrl}/models`, 2000).then((j) => {
				if (!Array.isArray(j?.data)) throw new Error('Not an OpenAI-compatible model list');
				return { id, name, baseUrl, running: true, models: [...new Set<string>(j.data.map((m: any) => m?.id).filter((id: unknown): id is string => typeof id === 'string' && !!id.trim()))] };
			}).catch(() => ({ id, name, baseUrl, running: false }))
		)
	];
	return Promise.all(probes);
}

/** Installed Ollama models with tools / vision / context from /api/show. */
export async function listInstalled(m: Machine): Promise<LocalModelInfo[]> {
	const tags = await getJson(`${OLLAMA_URL}/api/tags`, 3000);
	const models: Array<{ name: string; size: number; details?: { family?: string; parameter_size?: string; quantization_level?: string } }> = tags?.models ?? [];
	return Promise.all(
		models.map(async (x) => {
			const info: LocalModelInfo = {
				tag: x.name,
				sizeGb: Math.round((x.size / 1e9) * 10) / 10,
				family: x.details?.family,
				params: x.details?.parameter_size,
				quant: x.details?.quantization_level,
				installed: true
			};
			try {
				const show = await getJson(`${OLLAMA_URL}/api/show`, 4000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: x.name }) });
				const caps: string[] = Array.isArray(show?.capabilities) ? show.capabilities : [];
				info.tools = caps.includes('tools') || /\.Tools/.test(show?.template ?? '');
				info.vision = caps.includes('vision');
				const ctxKey = Object.keys(show?.model_info ?? {}).find((k) => k.endsWith('.context_length'));
				if (ctxKey) {
					info.context = Number(show.model_info[ctxKey]) || undefined;
				}
			} catch {
				/* older Ollama: leave unknown */
			}
			info.fit = rateFit(info.sizeGb, m);
			return info;
		})
	);
}

/** Registry lookup before downloading: size and whether the chat template supports tools. */
export async function inspectTag(tag: string, m: Machine): Promise<LocalModelInfo | undefined> {
	const [rawName, variant = 'latest'] = tag.trim().replace(/^https?:\/\/ollama\.com\/(library\/)?/, '').split(':');
	const name = rawName.includes('/') ? rawName : `library/${rawName}`;
	if (!/^[\w.-]+\/[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(variant)) {
		return undefined;
	}
	const base = `${REGISTRY}/v2/${name}`;
	try {
		const manifest = await getJson(`${base}/manifests/${variant}`, 8000, { headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
		const layers: Array<{ mediaType?: string; size?: number; digest?: string }> = manifest?.layers ?? [];
		const sizeGb = Math.round((layers.reduce((n, l) => n + (l.size || 0), 0) / 1e9) * 10) / 10;
		let tools = false;
		const template = layers.find((l) => l.mediaType?.endsWith('.template'));
		if (template?.digest) {
			const res = await fetch(`${base}/blobs/${template.digest}`, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
			tools = res.ok && /\{\{[^}]*\.Tools/i.test(await res.text());
		} else if (manifest?.config?.digest) {
			// Newer models (qwen3-coder…) have no template layer: Ollama's built-in
			// renderer/parser handles tool calls, declared in the config blob.
			const res = await fetch(`${base}/blobs/${manifest.config.digest}`, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
			tools = res.ok && typeof ((await res.json()) as { parser?: unknown })?.parser === 'string';
		}
		const known = SUGGESTED.find((s) => s.tag === tag);
		return { tag, sizeGb, tools, context: known?.context, note: known?.note, fit: rateFit(sizeGb, m) };
	} catch {
		return undefined;
	}
}

export interface PullProgress {
	status: string;
	completed: number;
	total: number;
}

/** Stream `POST /api/pull`; progress is summed across layers. */
export async function pullModel(tag: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
	const res = await fetch(`${OLLAMA_URL}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: tag, stream: true }), signal });
	if (!res.ok || !res.body) {
		throw new Error(`Ollama refused the download (HTTP ${res.status}).`);
	}
	const layers = new Map<string, { total: number; completed: number }>();
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let finished = false;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buf += dec.decode(value, { stream: true });
		let nl: number;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) {
				continue;
			}
			let j: any;
			try {
				j = JSON.parse(line);
			} catch {
				continue; // a proxy or a partial line: not progress
			}
			if (j.error) {
				throw new Error(String(j.error));
			}
			if (j.status === 'success') {
				finished = true;
			}
			if (j.digest && j.total) {
				layers.set(j.digest, { total: j.total, completed: j.completed || 0 });
			}
			let total = 0;
			let completed = 0;
			for (const l of layers.values()) {
				total += l.total;
				completed += l.completed;
			}
			onProgress({ status: String(j.status || ''), completed, total });
		}
	}
	// A stream that ends without Ollama's "success" (server restarted, connection cut) is not a finished download.
	if (!finished && !signal?.aborted) {
		throw new Error('The download was interrupted before Ollama finished it — press Download again; it resumes where it stopped.');
	}
}

export async function removeModel(tag: string): Promise<void> {
	const res = await fetch(`${OLLAMA_URL}/api/delete`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: tag }), signal: AbortSignal.timeout(15000) });
	if (!res.ok) {
		throw new Error(`Could not remove ${tag} (HTTP ${res.status}).`);
	}
}

/**
 * Ollama's OpenAI endpoint runs every model at its small default context and
 * silently cuts longer prompts. An agent prompt needs more, so we create a
 * weight-sharing alias with a bigger num_ctx (no extra disk). Returns the
 * alias and its window; falls back to the plain tag on old servers.
 */
export async function contextAlias(tag: string, fit: Fit | undefined): Promise<{ model: string; context: number }> {
	const ctx = fit === 'fits' ? 32768 : 16384;
	const [name, variant = 'latest'] = tag.split(':');
	const alias = `${name}-zer0ne${ctx / 1024}k:${variant}`;
	try {
		const res = await fetch(`${OLLAMA_URL}/api/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: alias, from: tag, parameters: { num_ctx: ctx }, stream: false }),
			signal: AbortSignal.timeout(30000)
		});
		if (res.ok) {
			return { model: alias, context: ctx };
		}
	} catch {
		/* fall through */
	}
	return { model: tag, context: 4096 };
}
