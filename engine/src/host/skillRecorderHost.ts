import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { ChildProcess, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import type { StreamOptions, StreamResult } from '../chatClient';
import type { ProviderConfig } from '../providerStore';
import { Dictation } from '../speech';
import { redactSecrets } from '../tools/redact';
import { scrubEnv } from '../tools/proc';
import { slugify, SkillStore } from '../tools/skills';
import type { PluginHost } from '../tools/plugins';
import { parseWorkflowDraft, reviewFrames, workflowDraft, workflowEvidence, WORKFLOW_SYSTEM, type WorkflowEvent, type WorkflowFrame } from '../core/recordedWorkflow';
import { HostContext, HostFeature, HostSurface } from './context';

const runFile = promisify(execFile);
type Recording = { id: string; dir: string; target: 'skill' | 'plugin'; name: string; goal: string; state: string; frames: WorkflowFrame[]; events: WorkflowEvent[]; started: number; voice: boolean; error?: string };
type RecorderDeps = {
	storageDir: string; sourceFile: string; skills: SkillStore; plugins: PluginHost;
	callModel(provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>): Promise<StreamResult>;
	/** Tests provide an inert child process; no test ever captures the desktop. */
	launch?: (dir: string, display: number) => ChildProcess;
};

/** An explicit, local-only recording session with a separate model-send and save boundary. */
export class SkillRecorderHost implements HostFeature {
	private session?: Recording;
	private proc?: ChildProcess;
	private voice = new Dictation();
	private generating?: AbortController;
	private watchdog?: ReturnType<typeof setTimeout>;
	private readonly sessionsRoot: string;
	constructor(private readonly ctx: HostContext, private readonly deps: RecorderDeps) {
		this.sessionsRoot = path.join(deps.storageDir, 'skill-recordings');
		// Other VS Code windows share storage: remove only abandoned sessions.
		for (const entry of fs.existsSync(this.sessionsRoot) ? fs.readdirSync(this.sessionsRoot, { withFileTypes: true }) : []) {
			if (!entry.isDirectory() || !/^[a-f0-9]{24}$/.test(entry.name)) continue;
			const dir = path.join(this.sessionsRoot, entry.name);
			try {
				const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
				if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) continue;
				try { process.kill(owner.pid, 0); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
				fs.rmSync(dir, { recursive: true, force: true });
			} catch { /* Unrecognized folders are not ours to remove. */ }
		}
	}
	private async helper(): Promise<string> {
		const hash = createHash('sha256').update(fs.readFileSync(this.deps.sourceFile)).digest('hex').slice(0, 16);
		const exe = path.join(this.deps.storageDir, 'sandbox', `zer0ne-recorder-${hash}.exe`);
		if (fs.existsSync(exe)) return exe;
		const win = process.env.SystemRoot || 'C:\\Windows';
		const compiler = ['Framework64', 'Framework'].map((p) => path.join(win, 'Microsoft.NET', p, 'v4.0.30319', 'csc.exe')).find(fs.existsSync);
		if (!compiler) throw new Error('Windows screen recording needs the built-in .NET Framework compiler.');
		fs.mkdirSync(path.dirname(exe), { recursive: true });
		const temp = exe + '.' + randomBytes(6).toString('hex') + '.exe';
		try {
			await runFile(compiler, ['-nologo', '-optimize', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Web.Extensions.dll', '-out:' + temp, this.deps.sourceFile], { encoding: 'utf8', timeout: 60000, windowsHide: true, env: scrubEnv() });
			if (!fs.existsSync(exe)) fs.renameSync(temp, exe);
		} catch { throw new Error('Could not build the Windows screen recorder. Check that .NET Framework is available.'); }
		finally { fs.rmSync(temp, { force: true }); }
		return exe;
	}
	private publish(surface: HostSurface): void {
		const s = this.session;
		surface.post({ type: 'skillRecording', recording: s ? { id: s.id, target: s.target, name: s.name, goal: s.goal, state: s.state, frames: s.frames.length, events: s.events.length, elapsedMs: Date.now() - s.started, error: s.error } : null });
	}
	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		if (!msg.type.startsWith('skillRecord')) return false;
		try { return await this.handleRecording(surface, msg); }
		catch (e) { surface.post({ type: 'skillRecordingNotice', text: (e as Error).message }); return true; }
	}
	private async handleRecording(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		if (surface.kind === 'remote') throw new Error('Screen recording is available only in local VS Code settings.');
		if (msg.type === 'skillRecorderInfo') {
			let displays: unknown[] = [];
			const supported = !!this.deps.launch || (process.platform === 'win32' && !vscode.env.remoteName);
			let error: string | undefined;
			if (supported && !this.deps.launch) {
				try {
					const r = await runFile(await this.helper(), ['--displays'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: scrubEnv() });
					displays = r.stdout.trim().split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s));
				} catch (e) { error = (e as Error).message; }
			}
			surface.post({ type: 'skillRecorderInfo', supported, displays, error });
			this.publish(surface);
			if (this.session && ['review', 'error'].includes(this.session.state) && !this.proc && !this.generating) await this.review(surface, this.session);
			return true;
		}
		if (msg.type === 'skillRecordStart') {
			if (this.session) throw new Error('Finish or discard your current recording first.');
			if (!this.deps.launch && (process.platform !== 'win32' || vscode.env.remoteName)) throw new Error('Native recording currently supports local Windows VS Code.');
			const goal = String(msg.goal || '').trim().slice(0, 2000);
			if (!goal) throw new Error('Describe the workflow you want to repeat.');
			const id = randomBytes(12).toString('hex');
			const dir = path.join(this.sessionsRoot, id);
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, created: Date.now() }));
			const s: Recording = { id, dir, goal, name: slugify(String(msg.name || 'recorded-workflow')), target: msg.target === 'plugin' ? 'plugin' : 'skill', state: 'starting', frames: [], events: [], started: Date.now(), voice: msg.voice === true };
			this.session = s;
			this.publish(surface);
			let proc: ChildProcess;
			try {
				const helper = this.deps.launch ? '' : await this.helper();
				if (this.session !== s) return true;
				proc = this.deps.launch ? this.deps.launch(dir, Number(msg.display) || 0) : spawn(helper, [dir, String(Number(msg.display) || 0)], { windowsHide: true, env: scrubEnv() });
			} catch (e) { if (this.session === s) { await this.clear(); this.publish(surface); } throw e; }
			this.proc = proc;
			let buffer = '';
			proc.stdout?.setEncoding('utf8');
			proc.stdin?.on('error', () => { /* The native helper may already have closed its pipe. */ });
			proc.stdout?.on('data', (chunk: string) => {
				if (this.session !== s) return;
				buffer += chunk;
				if (buffer.length > 65536) { s.error = 'Recorder output exceeded its limit.'; this.stop(); return; }
				let nl: number;
				while ((nl = buffer.indexOf('\n')) >= 0) {
					const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
					try { this.accept(surface, s, JSON.parse(line)); } catch { /* Ignore a malformed native status line. */ }
				}
			});
			proc.on('error', (e) => { if (this.session !== s) return; s.error = e.message; s.state = 'error'; this.voice.stop(); this.publish(surface); });
			proc.on('close', (code) => {
				if (this.session !== s) return;
				clearTimeout(this.watchdog); this.proc = undefined; this.voice.stop();
				if (code && !s.error) s.error = 'The recorder stopped unexpectedly. You can review the available frames or discard.';
				s.state = s.error ? 'error' : 'review';
				this.publish(surface);
				void this.review(surface, s);
			});
			this.watchdog = setTimeout(() => this.stop(), 310000);
			this.publish(surface);
			return true;
		}
		const s = this.session;
		if (!s || msg.id !== s.id) throw new Error('This recording has ended. Start a new recording.');
		if (msg.type === 'skillRecordDiscard') {
			const deleted = await this.clear(); this.publish(surface);
			if (!deleted) surface.post({ type: 'skillRecordingNotice', text: 'Recording stopped, but Windows could not delete all capture files. Remove the session folder: ' + s.dir });
			return true;
		}
		if (msg.type === 'skillRecordStop') {
			if (s.state === 'starting' && !this.proc) { await this.clear(); this.publish(surface); }
			else this.stop();
			return true;
		}
		if (msg.type === 'skillRecordPause') { this.proc?.stdin?.write(msg.paused ? 'pause\n' : 'resume\n'); return true; }
		if (msg.type === 'skillRecordGenerate') {
			if (this.proc || this.generating || !['review', 'error'].includes(s.state)) throw new Error('Finish recording before creating a draft.');
			const notes = String(msg.notes || '').slice(0, 12000);
			if (!msg.modelKey) {
				surface.post({ type: 'skillRecordingDraft', id: s.id, draft: workflowDraft(s.name, s.goal, notes, s.events), target: s.target, fromNotes: true });
				return true;
			}
			const abort = new AbortController(); this.generating = abort;
			const timer = setTimeout(() => abort.abort(), 90000);
			s.state = 'generating'; this.publish(surface);
			try {
				const [providerId, ...rest] = String(msg.modelKey).split('::');
				const provider = await this.ctx.store.get(providerId);
				const model = provider?.models.find((m) => m.id === rest.join('::') && m.enabled);
				if (this.session !== s || abort.signal.aborted) return true;
				if (!provider?.enabled || !model?.vision || provider.apiFormat === 'acp') throw new Error('Choose an enabled model with vision support.');
				const selected = new Set<number>((Array.isArray(msg.frames) ? msg.frames : []).filter((n: unknown) => Number.isSafeInteger(n)));
				const frames = reviewFrames(s.frames).filter((f) => selected.has(f.index));
				if (!frames.length || frames.length > 12) throw new Error('Choose between 1 and 12 reviewed frames to send.');
				const images = frames.map((f) => ({ mime: 'image/jpeg', base64: fs.readFileSync(path.join(s.dir, String(f.index).padStart(6, '0') + '.jpg')).toString('base64'), name: `frame-${f.index}-at-${f.at}ms.jpg` }));
				if (images.reduce((n, i) => n + i.base64.length, 0) > 12000000) throw new Error('Selected frames are too large. Choose fewer frames.');
				const apiKey = (await this.ctx.store.getApiKey(provider.id)) || '';
				if (this.session !== s || abort.signal.aborted) return true;
				const result = await this.deps.callModel(provider, apiKey, { model: model.id, system: WORKFLOW_SYSTEM, signal: abort.signal, maxTokens: Math.min(model.maxOutput || 8192, 8192), messages: [{ role: 'user', content: workflowEvidence(s.goal, notes, s.events) + '\nFrame timestamps: ' + frames.map((f) => `${f.index}: ${f.at}ms`).join(', '), images }] });
				if (this.session === s && !abort.signal.aborted) surface.post({ type: 'skillRecordingDraft', id: s.id, draft: parseWorkflowDraft(result.text), target: s.target });
			} catch (e) { if (this.session === s) surface.post({ type: 'skillRecordingNotice', text: (e as Error).message }); }
			finally { clearTimeout(timer); if (this.generating === abort) this.generating = undefined; if (this.session === s) { s.state = 'review'; this.publish(surface); } }
			return true;
		}
		if (msg.type === 'skillRecordSave') {
			if (this.proc || this.generating || !['review', 'error'].includes(s.state)) throw new Error('Finish recording and drafting first.');
			const draft = parseWorkflowDraft(JSON.stringify({ name: msg.name, description: msg.description, body: msg.body }));
			const scope = msg.scope === 'workspace' ? 'workspace' : 'user';
			if (this.deps.skills.list().some((x) => x.name === draft.name) || this.deps.plugins.plugins().some((x) => x.name === draft.name)) throw new Error('That name already exists. Choose a new name to keep the existing item.');
			if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace folder, or save for all workspaces.');
			if (s.target === 'plugin') {
				const stage = path.join(s.dir, 'plugin');
				fs.mkdirSync(path.join(stage, '.claude-plugin'), { recursive: true });
				fs.writeFileSync(path.join(stage, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: draft.name, version: '1.0.0', description: draft.description }, null, 2));
				const skills = new SkillStore(path.join(stage, 'skills'), () => undefined, () => []);
				skills.save({ ...draft, scope: 'user' });
				this.deps.plugins.installFromFolder(stage, scope);
			} else this.deps.skills.save({ ...draft, scope });
			const target = s.target;
			const deleted = await this.clear();
			await this.ctx.sendState();
			surface.post({ type: 'skillRecordingSaved', name: draft.name, target });
			this.ctx.status(`Saved ${target} "${draft.name}".${deleted ? ' Recording frames have been deleted.' : ''}`);
			if (!deleted) surface.post({ type: 'skillRecordingNotice', text: 'Saved successfully, but Windows could not delete all capture files. Remove the session folder: ' + s.dir });
			return true;
		}
		return false;
	}
	private accept(surface: HostSurface, s: Recording, raw: any): void {
		if (this.session !== s) return;
		if (raw.type === 'state') {
			s.state = raw.state === 'paused' ? 'paused' : 'recording';
			if (s.state === 'paused') this.voice.stop();
			else if (s.voice) this.voice.start((e) => {
				if (this.session !== s || s.state !== 'recording') return;
				if (e.text && s.events.length < 3000) s.events.push({ at: Date.now() - s.started, action: 'narration', text: redactSecrets(e.text).text });
				if (e.error) surface.post({ type: 'skillRecordingNotice', text: 'Voice narration is unavailable: ' + e.error });
			});
			this.publish(surface);
		}
		if (raw.type === 'event' && s.events.length < 3000 && Number.isFinite(raw.at) && ['click', 'right-click', 'scroll', 'typing', 'shortcut'].includes(raw.action)) {
			s.events.push({ at: raw.at, action: raw.action, app: String(raw.app || '').slice(0, 80), shortcut: raw.action === 'shortcut' ? String(raw.shortcut || '').slice(0, 80) : undefined, x: raw.x, y: raw.y });
		}
		if (raw.type === 'frame' && Number.isSafeInteger(raw.index) && raw.index > 0 && raw.index <= 300 && !s.frames.some((f) => f.index === raw.index)) {
			s.frames.push({ index: raw.index, at: Number(raw.at) || 0, width: Number(raw.width), height: Number(raw.height) }); this.publish(surface);
		}
		if (raw.type === 'error') { s.error = String(raw.error).slice(0, 300); this.stop(); }
		if (raw.type === 'done' && raw.cancelled) { void this.clear(); this.publish(surface); }
	}
	private async review(surface: HostSurface, s: Recording): Promise<void> {
		const frames = reviewFrames(s.frames).map((f) => {
			try { return { ...f, image: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(s.dir, String(f.index).padStart(6, '0') + '.jpg')).toString('base64') }; } catch { return null; }
		}).filter(Boolean);
		if (this.session === s) surface.post({ type: 'skillRecordingReview', id: s.id, frames, events: s.events.slice(0, 600), goal: s.goal, name: s.name, target: s.target });
	}
	private stop(): void { this.proc?.stdin?.write('stop\n'); this.voice.stop(); if (this.proc) { const proc = this.proc; setTimeout(() => { if (this.proc === proc) proc.kill(); }, 3000).unref(); } }
	private clear(): Promise<boolean> {
		this.generating?.abort(); this.generating = undefined;
		clearTimeout(this.watchdog); this.voice.stop();
		const proc = this.proc; this.proc = undefined;
		const s = this.session; this.session = undefined;
		const remove = async () => {
			try { if (s) await fs.promises.rm(s.dir, { recursive: true, force: true, maxRetries: 3 }); return true; }
			catch { return false; /* Dead-owner cleanup retries next launch. */ }
		};
		if (!proc) return remove();
		return new Promise<boolean>((resolve) => {
			let removed = false;
			const finish = () => { if (!removed) { removed = true; clearTimeout(timer); void remove().then(resolve); } };
			const timer = setTimeout(finish, 3000);
			proc.once('close', finish); proc.stdin?.write('cancel\n'); proc.kill();
		});
	}
	dispose(): void { void this.clear(); }
}
