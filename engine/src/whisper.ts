import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { scrubEnv } from './tools/proc';

/**
 * Whisper dictation: record a short WAV clip on this machine, then send it
 * to an OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI
 * `whisper-1` / `gpt-4o-transcribe`, Groq `whisper-large-v3`, a local
 * whisper server …). Much more accurate than the Windows offline engine and
 * works in any language.
 *
 * Recording (webviews have no microphone access):
 *   Windows  → the built-in winmm sound API via PowerShell (no installs)
 *   Linux    → arecord (ALSA), else ffmpeg / sox
 *   macOS    → ffmpeg or sox (e.g. `brew install sox`)
 */

export type WhisperEvent = { state: 'listening' | 'transcribing' | 'stopped' | 'error'; text?: string; error?: string };

const MAX_SECONDS = 300;

const WIN_SCRIPT = (file: string) => `
$ErrorActionPreference = 'Stop'
try {
	Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class ZMci {
	[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, StringBuilder ret, int len, IntPtr cb);
	[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern bool mciGetErrorString(int err, StringBuilder buf, int len);
	public static void Run(string cmd) {
		int e = mciSendString(cmd, null, 0, IntPtr.Zero);
		if (e != 0) { var b = new StringBuilder(256); mciGetErrorString(e, b, 256); throw new Exception(b.ToString()); }
	}
}
'@
	[ZMci]::Run('open new type waveaudio alias zrec')
	[ZMci]::Run('set zrec bitspersample 16 channels 1 samplespersec 16000 bytespersec 32000 alignment 2')
	[ZMci]::Run('record zrec')
	[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
	[void][Console]::In.ReadLine()
	[ZMci]::Run('stop zrec')
	[ZMci]::Run('save zrec "${file.replace(/"/g, '')}"')
	[ZMci]::Run('close zrec')
	[Console]::Out.WriteLine('SAVED'); [Console]::Out.Flush()
} catch {
	[Console]::Out.WriteLine('E ' + $_.Exception.Message)
	exit 1
}`;

/** Turn Windows MCI errors into something actionable. */
function recordingHint(message: string): string {
	if (/in use|no wave device/i.test(message)) {
		return 'Windows would not give access to a microphone. Check Settings → Privacy & security → Microphone (“Let desktop apps access your microphone” must be on), make sure a microphone is connected and not used exclusively by another app.';
	}
	return message.replace(/^Exception calling "Run" with "1" argument(s): /, '').replace(/^"|"$/g, '');
}

function onPath(bin: string): boolean {
	try {
		execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore', windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

export interface WhisperTarget {
	baseUrl: string;
	apiKey: string;
	model: string;
	language?: string;
}

export class WhisperDictation {
	private proc?: ChildProcess;
	private stopper?: () => void;
	private timer?: NodeJS.Timeout;

	get active(): boolean {
		return !!this.proc;
	}

	start(target: () => Promise<WhisperTarget>, onEvent: (e: WhisperEvent) => void): void {
		if (this.proc) {
			return;
		}
		const file = path.join(os.tmpdir(), `zer0ne-dictation-${Date.now()}.wav`);
		let proc: ChildProcess;
		if (process.platform === 'win32') {
			proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT(file)], { windowsHide: true, env: scrubEnv() });
			this.stopper = () => proc.stdin?.write('stop\n');
		} else if (process.platform === 'linux' && onPath('arecord')) {
			proc = spawn('arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-d', String(MAX_SECONDS), file], { env: scrubEnv() });
			this.stopper = () => proc.kill('SIGINT');
			setTimeout(() => onEvent({ state: 'listening' }), 200);
		} else if (onPath('ffmpeg')) {
			const input = process.platform === 'darwin' ? ['-f', 'avfoundation', '-i', ':0'] : ['-f', 'pulse', '-i', 'default'];
			proc = spawn('ffmpeg', ['-loglevel', 'error', '-y', ...input, '-ac', '1', '-ar', '16000', '-t', String(MAX_SECONDS), file], { env: scrubEnv() });
			this.stopper = () => proc.stdin?.write('q');
			setTimeout(() => onEvent({ state: 'listening' }), 300);
		} else if (onPath('rec')) {
			proc = spawn('rec', ['-q', '-c', '1', '-r', '16000', '-b', '16', file, 'trim', '0', String(MAX_SECONDS)], { env: scrubEnv() });
			this.stopper = () => proc.kill('SIGINT');
			setTimeout(() => onEvent({ state: 'listening' }), 200);
		} else {
			onEvent({ state: 'error', error: 'No audio recorder found. Install ffmpeg or sox (macOS: brew install sox; Linux: alsa-utils), or switch dictation to the system engine.' });
			return;
		}
		this.proc = proc;
		let failed = false;
		let out = '';
		proc.stdout?.setEncoding('utf8');
		proc.stdout?.on('data', (chunk: string) => {
			out += chunk;
			if (/READY/.test(chunk)) {
				onEvent({ state: 'listening' });
			}
			const err = out.match(/^E (.*)$/m);
			if (err && !failed) {
				failed = true;
				onEvent({ state: 'error', error: `Recording failed: ${recordingHint(err[1].trim())}` });
			}
		});
		proc.on('error', (e) => {
			failed = true;
			onEvent({ state: 'error', error: e.message });
		});
		this.timer = setTimeout(() => this.stop(), MAX_SECONDS * 1000);
		proc.on('exit', () => {
			clearTimeout(this.timer);
			this.proc = undefined;
			if (failed) {
				fs.rmSync(file, { force: true });
				return;
			}
			void this.transcribe(file, target, onEvent);
		});
	}

	stop(): void {
		this.stopper?.();
		this.stopper = undefined;
		// Recorders that ignore the polite stop are ended after a grace period.
		const proc = this.proc;
		setTimeout(() => proc?.exitCode === null && proc.kill(), 4000);
	}

	private async transcribe(file: string, target: () => Promise<WhisperTarget>, onEvent: (e: WhisperEvent) => void): Promise<void> {
		try {
			const stat = fs.existsSync(file) ? fs.statSync(file) : undefined;
			if (!stat || stat.size < 2000) {
				onEvent({ state: 'stopped' });
				return;
			}
			onEvent({ state: 'transcribing' });
			const text = await transcribeFile(file, await target());
			if (text) {
				onEvent({ state: 'listening', text });
			}
			onEvent({ state: 'stopped' });
		} catch (e) {
			onEvent({ state: 'error', error: e instanceof Error ? e.message : String(e) });
		} finally {
			fs.rmSync(file, { force: true });
		}
	}
}

/** POST a WAV file to {baseUrl}/audio/transcriptions (OpenAI format). */
export async function transcribeFile(file: string, t: WhisperTarget): Promise<string> {
	const base = t.baseUrl.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|models|audio\/transcriptions)$/i, '');
	const form = new FormData();
	form.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/wav' }), 'dictation.wav');
	form.append('model', t.model);
	form.append('response_format', 'json');
	if (t.language) {
		form.append('language', t.language);
	}
	const res = await fetch(`${base}/audio/transcriptions`, {
		method: 'POST',
		headers: t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {},
		body: form,
		signal: AbortSignal.timeout(120_000)
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`Transcription failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
	}
	try {
		return String(JSON.parse(body).text ?? '').trim();
	} catch {
		return body.trim();
	}
}
