import { ChildProcess, spawn } from 'child_process';

/**
 * Microphone dictation for the chat composer.
 *
 * VS Code webviews have no microphone permission, so audio is captured in
 * the extension host instead. On Windows this uses the built-in offline
 * System.Speech engine through PowerShell — no downloads, no cloud. While
 * you speak, hypotheses stream in (live text, marked provisional); after a
 * short pause each phrase finalizes. The script also reports the input
 * level twice a second, so the UI can notice a silent microphone instead of
 * listening forever with no feedback. (The modern Windows.Media recognizer
 * is unusable from PowerShell — its constraint collection projects as a raw
 * COM object — so the legacy engine is the one that works everywhere.)
 */

const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
	Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Speech.Recognition;
using System.Threading;
public static class Zer0neSpeech {
    static void Line(string value) { Console.WriteLine(value); Console.Out.Flush(); }
    public static void Run() {
        var installed = SpeechRecognitionEngine.InstalledRecognizers();
        if (installed.Count == 0) { Line("E No speech recognizer is installed (Windows Settings > Time & language > Speech)."); return; }
        var info = installed[0];
        foreach (var candidate in installed) if (candidate.Culture.Name == Thread.CurrentThread.CurrentCulture.Name) { info = candidate; break; }
        using (var recognizer = new SpeechRecognitionEngine(info)) {
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.EndSilenceTimeout = TimeSpan.FromMilliseconds(700);
            recognizer.SpeechHypothesized += (sender, e) => { if (e.Result != null) Line("H " + e.Result.Text); };
            recognizer.SpeechRecognized += (sender, e) => { if (e.Result != null) Line("R " + e.Result.Text); };
            recognizer.SetInputToDefaultAudioDevice();
            recognizer.RecognizeAsync(RecognizeMode.Multiple);
            Line("READY " + info.Culture.Name);
            while (true) { Line("L " + recognizer.AudioLevel); Thread.Sleep(500); }
        }
    }
}
'@
	[Zer0neSpeech]::Run()
} catch {
	[Console]::Out.WriteLine('E ' + $_.Exception.Message); exit 1
}`;

export type MicEvent = { state: 'listening' | 'stopped' | 'error'; text?: string; error?: string; language?: string; provisional?: boolean; level?: number };

export class Dictation {
	private proc?: ChildProcess;
	private stopping = false;

	get supported(): boolean {
		return process.platform === 'win32';
	}

	get active(): boolean {
		return !!this.proc;
	}

	start(onEvent: (e: MicEvent) => void): void {
		if (this.proc) {
			return;
		}
		if (!this.supported) {
			onEvent({ state: 'error', error: 'Built-in dictation is available on Windows. On macOS/Linux use your OS dictation shortcut (e.g. Fn Fn on macOS) in the chat box.' });
			return;
		}
		this.stopping = false;
		// Speech callbacks need C# handlers: PowerShell scriptblocks have no runspace on audio threads.
		const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { windowsHide: true });
		this.proc = proc;
		let buffer = '';
		let failed = false;
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line.startsWith('READY')) {
					onEvent({ state: 'listening', language: line.slice(6) });
				} else if (line.startsWith('L ')) {
					// Microphone input level (0–100), twice a second.
					onEvent({ state: 'listening', level: Number(line.slice(2)) || 0 });
				} else if (line.startsWith('H ')) {
					onEvent({ state: 'listening', text: line.slice(2), provisional: true });
				} else if (line.startsWith('R ')) {
					onEvent({ state: 'listening', text: line.slice(2) });
				} else if (line.startsWith('E ')) {
					failed = true;
					onEvent({ state: 'error', error: line.slice(2) });
				}
			}
		});
		proc.on('error', (err) => {
			failed = true;
			onEvent({ state: 'error', error: err.message });
		});
		proc.on('exit', () => {
			if (this.proc === proc) {
				this.proc = undefined;
			}
			if (failed || this.stopping) {
				return;
			}
			onEvent({ state: 'stopped' });
		});
	}

	stop(): void {
		this.stopping = true;
		const proc = this.proc;
		this.proc = undefined;
		proc?.kill();
	}
}
