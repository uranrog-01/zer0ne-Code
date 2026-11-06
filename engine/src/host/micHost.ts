import { execFileSync } from 'child_process';
import type { AgentSettings } from '../providerStore';
import { Dictation } from '../speech';
import { WhisperDictation } from '../whisper';
import { HostContext, HostFeature, HostSurface } from './context';

export type MicState = { state: 'idle' | 'listening' | 'transcribing' | 'error'; error?: string; blocked?: boolean; owner?: 'composer'; stopped?: 'user' | 'ended' };

/** The event shape both dictation engines emit (level/provisional only come from the OS one). */
type MicEventLike = { state: string; text?: string; error?: string; provisional?: boolean; level?: number };

/**
 * Windows keeps microphone consent per app in the registry (no prompts for desktop
 * apps). `deny` for the machine, for desktop apps, or for PowerShell itself (the
 * dictation helper) means recording cannot hear anything — reported as blocked so
 * the UI can offer the way to fix it instead of just failing silently.
 */
function micConsent(): 'allow' | 'deny' | 'unknown' {
	if (process.platform !== 'win32') {
		return 'allow';
	}
	const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
	const read = (key: string): 'allow' | 'deny' | 'unknown' => {
		try {
			const out = execFileSync('reg.exe', ['query', key, '/v', 'Value'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
			return /REG_SZ\s+Allow/i.test(out) ? 'allow' : /REG_SZ\s+Deny/i.test(out) ? 'deny' : 'unknown';
		} catch {
			return 'unknown';
		}
	};
	if (read(root) === 'deny' || read(root + '\\NonPackaged') === 'deny') {
		return 'deny';
	}
	try {
		const out = execFileSync('reg.exe', ['query', root + '\\NonPackaged'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
		for (const line of out.split(/\r?\n/)) {
			const key = line.trim();
			if (key.startsWith(root + '\\NonPackaged\\') && /powershell\.exe/i.test(key) && read(key) === 'deny') {
				return 'deny';
			}
		}
	} catch {
		/* no per-app entries */
	}
	return 'allow';
}

/**
 * The composer's microphone: OS dictation or Whisper (an OpenAI-format
 * provider), streaming text into the input. Split out of ChatController.
 */
export class MicHost implements HostFeature {
	private mic: MicState = { state: 'idle' };
	private readonly whisper = new WhisperDictation();
	private readonly dictation = new Dictation();
	private generation = 0;

	constructor(
		private readonly ctx: HostContext,
		/** Debounced state push (the controller's scheduleState). */
		private readonly changed: () => void
	) {}

	async handle(_surface: HostSurface, msg: { type: string; owner?: string }): Promise<boolean> {
		if (msg.type === 'micStart') {
			if (this.mic.owner === 'composer' && (this.dictation.active || this.whisper.active)) return true;
			this.dictation.stop();
			this.whisper.stop();
			this.start();
			return true;
		}
		if (msg.type === 'micStop') {
			++this.generation;
			const wasActive = this.whisper.active || this.dictation.active;
			this.whisper.active ? this.whisper.stop() : this.dictation.stop();
			if (wasActive) {
				this.mic = { state: 'idle', stopped: 'user' };
				this.changed();
			}
			return true;
		}
		return false;
	}

	/** The mic part of the webview state. */
	state(settings: AgentSettings): MicState & { supported: boolean; engine: AgentSettings['dictationEngine'] } {
		return { ...this.mic, supported: settings.dictationEngine === 'whisper' || this.dictation.supported, engine: settings.dictationEngine };
	}

	private start(): void {
		const owner = 'composer';
		const generation = ++this.generation;
		if (micConsent() === 'deny') {
			this.fail('Windows is blocking microphone access for this app.', true);
			return;
		}
		this.mic = { state: 'listening', owner: 'composer' };
		this.changed();
		const onEvent = (e: MicEventLike) => {
			if (this.mic.owner !== owner || generation !== this.generation) return;
			if (typeof e.level === 'number') {
				this.ctx.postAll({ type: 'micLevel', level: e.level });
			}
			if (e.text) {
				this.ctx.postAll({ type: 'micText', text: e.text, provisional: !!e.provisional, owner });
			}
			if (e.state === 'error') {
				this.fail(e.error ?? 'Dictation failed.', false);
			} else if (e.state === 'stopped') {
				this.mic = { state: 'idle', stopped: 'ended' };
			} else if (e.state === 'transcribing') {
				this.mic = { state: 'transcribing' };
			}
			this.changed();
		};
		const settings = this.ctx.store.getSettings();
		if (settings.dictationEngine === 'whisper') {
			this.whisper.start(async () => {
				const providers = await this.ctx.store.list();
				const p = providers.find((x) => x.id === settings.whisperProvider) ?? providers.find((x) => x.apiFormat === 'openai' && /openai\.com|groq\.com/i.test(x.baseUrl));
				if (!p || p.apiFormat !== 'openai') {
					throw new Error('Pick an OpenAI-format provider for Whisper in Settings → General → Dictation.');
				}
				return { baseUrl: p.baseUrl, apiKey: (await this.ctx.store.getApiKey(p.id)) ?? '', model: settings.whisperModel.trim() || 'whisper-1' };
			}, onEvent);
			return;
		}
		this.dictation.start(onEvent);
	}

	/** One visible failure: the state, the toast and a message the chat turns into a dialog. */
	private fail(error: string, blocked: boolean): void {
		this.mic = { state: 'error', error, blocked };
		this.ctx.status(`Microphone: ${error}`, 'error');
		this.ctx.postAll({ type: 'micError', error, blocked });
		this.changed();
	}

	dispose(): void {
		++this.generation;
		this.dictation.stop();
		this.whisper.stop();
	}
}
