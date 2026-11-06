import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { download, digestMatches, type DownloadProgress } from './localEngine';
import { ollamaBinary, freeDisk } from './localModels';

export function ollamaAsset(platform = process.platform as string, arch = process.arch as string): string | undefined {
	if (!['x64', 'arm64'].includes(arch)) return undefined;
	if (platform === 'win32') return `ollama-windows-${arch === 'x64' ? 'amd64' : 'arm64'}.zip`;
	if (platform === 'darwin') return 'ollama-darwin.tgz';
	if (platform === 'linux') return `ollama-linux-${arch === 'x64' ? 'amd64' : 'arm64'}.tar.zst`;
	return undefined;
}
const candidates = (dir: string) => [path.join(dir, 'ollama.exe'), path.join(dir, 'bin', 'ollama'), path.join(dir, 'ollama')];
export function managedOllama(dir: string): string | undefined {
	if (!fs.existsSync(path.join(dir, 'runtime', '.ready'))) return undefined;
	return candidates(path.join(dir, 'runtime')).find(f => fs.existsSync(f));
}
function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true, timeout: 300_000, maxBuffer: 8 * 1024 ** 2, signal }, (e, stdout) => e ? reject(e) : resolve(stdout)));
}

/** Official portable distribution: no system install, admin rights or shell installer. */
export async function ensureOllama(dir: string, progress: (p: DownloadProgress & { stage: string }) => void, signal: AbortSignal): Promise<string> {
	const existing = ollamaBinary() ?? managedOllama(dir);
	if (existing) return existing;
	const name = ollamaAsset();
	if (!name) throw new Error('No official Ollama build is available for this operating system and architecture. Use zer0ne Engine instead.');
	const response = await fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
	if (!response.ok) throw new Error(`Ollama release lookup HTTP ${response.status}`);
	const release = await response.json() as { assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string }> };
	const asset = release.assets?.find(a => a.name === name);
	if (!asset || !/^https:\/\/github\.com\/ollama\/ollama\/releases\/download\//.test(asset.browser_download_url)) throw new Error('The official release has no compatible portable Ollama build.');
	fs.mkdirSync(dir, { recursive: true });
	const disk = freeDisk(dir);
	if (disk !== undefined && disk < asset.size * 3 + 512e6) throw new Error('Not enough disk space to download and unpack Ollama.');
	const archive = path.join(dir, name), runtime = path.join(dir, 'runtime');
	await download(asset.browser_download_url, archive, p => progress({ ...p, stage: 'Installing Ollama · ' + name }), signal, asset.size);
	let digest = asset.digest;
	if (!digest) {
		const sums = release.assets.find(a => a.name === 'sha256sum.txt');
		if (sums && /^https:\/\/github\.com\/ollama\/ollama\/releases\/download\//.test(sums.browser_download_url)) {
			const result = await fetch(sums.browser_download_url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
			if (result.ok) {
				const line = (await result.text()).split(/\r?\n/).find(l => l.trim().split(/\s+/).pop()?.replace(/^\*/, '') === name);
				digest = line ? 'sha256:' + line.trim().split(/\s+/)[0] : undefined;
			}
		}
	}
	if (digestMatches(archive, digest) !== true) throw new Error('Ollama could not be verified against its official checksum; it was not installed.');
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	const entries = await run(tar, ['-tf', archive], signal);
	if (entries.split(/\r?\n/).some(e => /^[\/\\]|^[a-z]:/i.test(e) || e.split(/[\/\\]/).includes('..'))) throw new Error('The Ollama archive contains an unsafe path.');
	fs.mkdirSync(runtime, { recursive: true });
	progress({ received: asset.size, total: asset.size, bytesPerSec: 0, stage: 'Unpacking and verifying Ollama…' });
	await run(tar, ['-xf', archive, '-C', runtime], signal);
	const binary = candidates(runtime).find(f => fs.existsSync(f));
	if (!binary) throw new Error('The official archive contains no usable Ollama executable.');
	if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
	await run(binary, ['--version'], signal);
	fs.writeFileSync(path.join(runtime, '.ready'), name);
	fs.rmSync(archive, { force: true });
	return binary;
}
