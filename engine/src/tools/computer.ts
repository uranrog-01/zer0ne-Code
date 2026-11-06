import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import type { MessageImage, ToolDef } from '../chatClient';
import { acquireRuntimeLease } from '../runtimeLease';
import { awaitComputerMonitor, beginComputerActivity, computerPolicy, computerPolicyFile, presentComputer } from './computerControl';

const MAX_WIDTH = 1280;
const ACTIONS = ['apps', 'screenshot', 'click', 'double_click', 'right_click', 'move', 'type', 'key', 'scroll'];
interface Geometry { width: number; height: number; screenWidth: number; screenHeight: number; left: number; top: number; windowId?: string; processId?: number }
interface Shot extends Geometry { at: number; revision: string; epoch: string }
// Project engines share a revision and lease because they control the same desktop.
const shots = new Map<string, Shot>();
let busy = false;
interface Options {
	storageDir: string;
	sourceFile: string;
	sessionId: string;
	vision: boolean;
	signal: AbortSignal;
	approve: (what: string, signal: AbortSignal) => Promise<boolean>;
	epoch?: string;
	app?: string;
	theme?: string;
	reducedMotion?: boolean;
}

function desktopLease(opts: Options) {
	const dir = path.join(opts.storageDir, 'computer-use');
	const release = acquireRuntimeLease(dir);
	if (!release) throw new Error('Another project is using Computer Use. Wait, then take a new screenshot.');
	const file = path.join(dir, 'revision');
	return { release, read: () => {
		try { return fs.readFileSync(file, 'utf8'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
	}, invalidate: () => fs.writeFileSync(file, randomUUID(), { mode: 0o600 }) };
}

export function computerToolDef(): ToolDef {
	return {
		name: 'computer',
			description: 'See and control an app allowed by the user in Computer Use permissions. Windows only. Use apps to list allowed open windows, then screenshot with app set to its windowId. Take a screenshot before EVERY input action and use its pixel coordinates. Captures only that app window on the primary display. Full access skips action approvals but never app permissions or Stop. Prefer files, terminal or browser tools whenever they can do the job.',
		parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
			action: { type: 'string', enum: ACTIONS },
			app: { type:'string', maxLength:4096, description:'screenshot: windowId from apps, executable name, or exact executable path. Omit to capture the focused allowed app.' },
			x: { type: 'number', minimum: 0, description: 'X in the latest screenshot pixels' },
			y: { type: 'number', minimum: 0, description: 'Y in the latest screenshot pixels' },
			text: { type: 'string', maxLength: 20000, description: 'type: the exact text to type' },
			keys: { type: 'string', maxLength: 100, description: 'key: a combo like "ctrl+s", "alt+tab", "enter"' },
			amount: { type: 'integer', minimum: -100, maximum: 100, description: 'scroll: nonzero clicks, positive = up (default 3)' }
		} }
	};
}

function run(file: string, args: string[], signal: AbortSignal, input?: string, timeout = 30000): Promise<{ out: string; err: string }> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const p = spawn(file, args, { windowsHide: true, signal });
		let out = '', err = '';
		let failure: Error | undefined;
		const stop = (e: Error) => { failure ??= e; p.kill('SIGKILL'); };
		const timer = setTimeout(() => stop(new Error(`Computer use timed out after ${timeout / 1000}s.`)), timeout);
		p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
		p.stdout.on('data', c => { const next = out + c; out = next.slice(0, 65536); if (next.length > 65536) stop(new Error('Computer helper output exceeded its limit.')); });
		p.stderr.on('data', c => { const next = err + c; err = next.slice(0, 65536); if (next.length > 65536) stop(new Error('Computer helper output exceeded its limit.')); });
		p.on('error', e => { failure = e; });
		p.stdin.on('error', e => { failure ??= e; });
		p.on('close', code => {
			clearTimeout(timer);
			if (signal.aborted) { reject(signal.reason); return; }
			if (failure) reject(failure);
			else if (code !== 0) reject(new Error(err.trim().slice(0, 1000) || out.trim().slice(0, 1000) || `${path.basename(file)} failed (exit ${code}).`));
			else resolve({ out, err });
		});
		p.stdin.end(input, 'utf8');
	});
}

/** A source hash prevents an installed app from reusing an older input protocol. */
async function winHelper(opts: Options): Promise<string> {
	const hash = createHash('sha256').update(fs.readFileSync(opts.sourceFile)).digest('hex').slice(0, 20);
	const exe = path.join(opts.storageDir, 'sandbox', `zer0ne-input-${hash}.exe`);
	if (fs.existsSync(exe)) return exe;
	const win = process.env.SystemRoot || 'C:\\Windows';
	const csc = ['Framework64', 'Framework'].map(f => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(p => fs.existsSync(p));
	if (!csc) throw new Error('Computer use needs the .NET Framework C# compiler (csc.exe), which was not found.');
	fs.mkdirSync(path.dirname(exe), { recursive: true });
	const temp = path.join(path.dirname(exe), `input-${randomUUID()}.exe`);
	try {
		await run(csc, ['-nologo', '-optimize', '-r:System.Drawing.dll', '-r:System.Windows.Forms.dll', '-r:System.Web.Extensions.dll', `-out:${temp}`, opts.sourceFile], opts.signal, undefined, 60000);
		opts.signal.throwIfAborted();
		// Another engine may have finished compiling the same version while this one waited.
		try { fs.renameSync(temp, exe); } catch (e) { if (!fs.existsSync(exe)) throw e; }
	} finally { fs.rmSync(temp, { force: true }); }
	return exe;
}

function geometry(value: Geometry): Geometry {
	if (![value.width, value.height, value.screenWidth, value.screenHeight].every(n => Number.isInteger(n) && n > 0 && n <= 100000) || ![value.left, value.top].every(Number.isInteger)) {
		throw new Error('Screenshot returned invalid display geometry. Take another screenshot.');
	}
	return value;
}

async function screenshot(opts: Options): Promise<{ image: MessageImage; geometry: Geometry }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-screen-')), jpg = path.join(dir, 'screen.jpg');
	try {
		const target: string[] = [];
		if (opts.app) {
			const allowed = computerPolicy(opts.storageDir).allowed;
			const matches = (await computerWindows(opts)).filter(w => allowed.some(file => file.toLowerCase() === w.path.toLowerCase()) && [w.windowId,w.path.toLowerCase(),w.name.toLowerCase()].includes(opts.app!.toLowerCase()));
			if (matches.length !== 1) throw new Error('Choose one allowed open windowId from computer apps, then take a screenshot.');
			target.push('--focus',`${matches[0].windowId},${matches[0].processId}`);
		}
		const r = await run(await winHelper(opts), ['screenshot', jpg, String(MAX_WIDTH), '--policy', computerPolicyFile(opts.storageDir), '--epoch', opts.epoch!, ...target], opts.signal);
		const dims = geometry(JSON.parse(r.out));
		if (typeof dims.windowId !== 'string' || !/^[1-9]\d*$/.test(dims.windowId) || typeof dims.processId !== 'number' || !Number.isInteger(dims.processId) || dims.processId <= 0) throw new Error('Screenshot returned no active window. Take a new screenshot.');
		opts.signal.throwIfAborted();
		return { image: { mime:'image/jpeg', base64:fs.readFileSync(jpg).toString('base64'), name:'app window' }, geometry:dims };
	} finally { fs.rmSync(jpg, {force:true}); fs.rmdirSync(dir); }
}

async function act(action: string, x: number, y: number, text: string, keys: string, amount: number, shot: Shot, opts: Options): Promise<void> {
	const exe = await winHelper(opts);
	const args = action === 'type' ? ['type'] : action === 'key' ? ['key', keys] : action === 'scroll' ? ['scroll', String(x), String(y), String(amount)] : action === 'move' ? ['move', String(x), String(y)] : ['click', String(x), String(y), action === 'right_click' ? 'right' : 'left', action === 'double_click' ? '2' : '1'];
	args.push('--bounds', [shot.left, shot.top, shot.screenWidth, shot.screenHeight].join(','));
	args.push('--focus', `${shot.windowId},${shot.processId}`);
	args.push('--policy', computerPolicyFile(opts.storageDir), '--epoch', opts.epoch!);
	await run(exe, args, opts.signal, action === 'type' ? text : undefined);
}

export async function computerWindows(opts: Pick<Options, 'storageDir' | 'sourceFile' | 'signal'>): Promise<Array<{path:string;name:string;title:string;windowId:string;processId:number}>> {
	if (process.platform !== 'win32') throw new Error('App permissions currently require Windows.');
	const helper = await winHelper({...opts, sessionId:'', vision:false, approve:async () => false});
	const result = await run(helper, ['windows'], opts.signal);
	const windows = JSON.parse(result.out);
	if (!Array.isArray(windows) || windows.length > 500) throw new Error('Windows app list is unavailable.');
	return windows.filter(w => w && typeof w.path === 'string' && typeof w.name === 'string' && typeof w.title === 'string' && typeof w.windowId === 'string' && Number.isInteger(w.processId));
}

export async function runComputer(args: Record<string, unknown>, opts: Options) {
	opts.signal.throwIfAborted();
	if (!opts.vision) return { api:'Computer use needs a vision model. Switch to a model that can see images.', summary:'no vision', error:true };
	if (process.platform !== 'win32') throw new Error('Computer Use app permissions currently require Windows. macOS and Linux control is unavailable.');
	if (typeof args.action !== 'string' || !ACTIONS.includes(args.action)) throw new Error('Unknown computer action.');
	if (args.action === 'apps') {
		const policy = computerPolicy(opts.storageDir), windows = (await computerWindows(opts)).filter(w => policy.allowed.some(file => file.toLowerCase() === w.path.toLowerCase()));
		return {api:JSON.stringify({paused:policy.paused,windows}),summary:'allowed apps'};
	}
	if (args.app !== undefined && (typeof args.app !== 'string' || !args.app || args.app.length > 4096 || args.app.includes('\0'))) throw new Error('Choose an allowed app name or windowId.');
	const activity = beginComputerActivity(opts.storageDir, String(args.action), opts.sessionId, opts.signal);
	try { const result = await runComputerAction(args, {...opts, signal:activity.signal, epoch:activity.epoch, app:args.app as string | undefined}); activity.check(); activity.signal.throwIfAborted(); return result; }
	finally { activity.close(); }
}

async function runComputerAction(args: Record<string, unknown>, opts: Options): Promise<{ api: string; summary: string; images?: MessageImage[]; error?: boolean }> {
	opts.signal.throwIfAborted();
	if (!opts.vision) return { api: 'Computer use needs a vision model. Switch to a model that can see images.', summary: 'no vision', error: true };
	if (!opts.sessionId) throw new Error('Computer use needs an active chat.');
	const action = args.action;
	if (typeof action !== 'string' || !ACTIONS.includes(action)) throw new Error('Unknown computer action.');
	const scope = `${opts.storageDir}\0${opts.sessionId}`;
	if (busy) throw new Error('Another computer action is running. Wait, then take a new screenshot.');
	if (action === 'screenshot') {
		busy = true;
		shots.delete(scope);
		let desktop: ReturnType<typeof desktopLease> | undefined;
		try {
			desktop = desktopLease(opts);
			const shot = await screenshot(opts);
			if (shots.size >= 128) shots.delete(shots.keys().next().value!);
			shots.set(scope, { ...shot.geometry, at: Date.now(), revision: desktop.read(), epoch:opts.epoch! });
			const presentation = presentComputer(opts.storageDir, { session:opts.sessionId, epoch:opts.epoch!, windowId:shot.geometry.windowId!, processId:shot.geometry.processId!, action:'screenshot', theme:opts.theme, reducedMotion:opts.reducedMotion });
			await awaitComputerMonitor(opts.storageDir, presentation.id, opts.epoch!, opts.signal);
			return { api: `Screenshot (${shot.geometry.width}×${shot.geometry.height}) attached. Use its pixel coordinates.`, summary: 'screenshot', images: [shot.image] };
		} finally { desktop?.release(); busy = false; }
	}
	const shot = shots.get(scope);
	if (!shot || shot.epoch !== opts.epoch || Date.now() - shot.at > 5 * 60000) throw new Error('Take a new screenshot in this chat before each computer action.');
	const needsXY = !['type', 'key'].includes(action);
	const x = args.x, y = args.y;
	if (needsXY && (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= shot.width || y >= shot.height)) throw new Error('Coordinates must be inside the latest screenshot.');
	const text = args.text, keys = args.keys;
	if (action === 'type' && (typeof text !== 'string' || !text.length || text.length > 20000 || text.includes('\0'))) throw new Error('Type requires 1–20000 characters without NUL.');
	if (action === 'key' && (typeof keys !== 'string' || !keys.length || keys.length > 100 || !/^[a-z0-9]+(?:\+[a-z0-9]+)*$/i.test(keys))) throw new Error('Key requires a combo such as ctrl+s or enter.');
	const amount = args.amount === undefined ? 3 : args.amount;
	if (action === 'scroll' && (typeof amount !== 'number' || !Number.isInteger(amount) || !amount || Math.abs(amount) > 100)) throw new Error('Scroll amount must be a nonzero integer between -100 and 100.');
	const label = action === 'type' ? `computer: type ${JSON.stringify((text as string).slice(0, 60))}${(text as string).length > 60 ? '…' : ''}` : action === 'key' ? `computer: press ${keys}` : `computer: ${action.replace('_', ' ')} at ${x},${y}${action === 'scroll' ? ` (${amount})` : ''}`;
	// Approval uses the user's physical pointer. Arm handoff again only after the
	// approval has completed, with a fresh visual acknowledgement before input.
	const approvalLease = desktopLease(opts);
	let approvalPresentation: ReturnType<typeof presentComputer>;
	try { approvalPresentation = presentComputer(opts.storageDir, { session:opts.sessionId, epoch:opts.epoch!, windowId:shot.windowId!, processId:shot.processId!, action:'approval', theme:opts.theme, reducedMotion:opts.reducedMotion }); }
	finally { approvalLease.release(); }
	await awaitComputerMonitor(opts.storageDir, approvalPresentation.id, opts.epoch!, opts.signal);
	let abortApproval!: () => void;
	const stopped = new Promise<never>((_resolve,reject) => { abortApproval = () => reject(opts.signal.reason); opts.signal.addEventListener('abort', abortApproval, {once:true}); });
	let approved: boolean;
	try { opts.signal.throwIfAborted(); approved = await Promise.race([opts.approve(label, opts.signal), stopped]); }
	finally { opts.signal.removeEventListener('abort', abortApproval); }
	if (!approved) return { api: 'The user declined this computer action.', summary: 'rejected', error: true };
	opts.signal.throwIfAborted();
	if (busy || shots.get(scope) !== shot || Date.now() - shot.at > 5 * 60000) throw new Error('The desktop observation changed or expired while waiting for approval. Take a new screenshot.');
	busy = true;
	shots.clear();
	let desktop: ReturnType<typeof desktopLease> | undefined;
	try {
		desktop = desktopLease(opts);
		if (desktop.read() !== shot.revision) throw new Error('Another project changed the desktop. Take a new screenshot before acting.');
		desktop.invalidate();
		const px = shot.left + Math.min(shot.screenWidth - 1, Math.round((x as number) * shot.screenWidth / shot.width));
		const py = shot.top + Math.min(shot.screenHeight - 1, Math.round((y as number) * shot.screenHeight / shot.height));
		const presentation = presentComputer(opts.storageDir, { session:opts.sessionId, epoch:opts.epoch!, windowId:shot.windowId!, processId:shot.processId!, action, x:needsXY ? px : undefined, y:needsXY ? py : undefined, theme:opts.theme, reducedMotion:opts.reducedMotion });
		await awaitComputerMonitor(opts.storageDir, presentation.id, opts.epoch!, opts.signal);
		await act(action, px, py, text as string, keys as string, amount as number, shot, opts);
		await delay(350, undefined, { signal: opts.signal });
		return { api: 'Computer action completed. Take a screenshot to check the result.', summary: action.replace('_', ' ') };
	} finally { desktop?.release(); busy = false; }
}
