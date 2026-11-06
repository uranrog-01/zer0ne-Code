import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { acquireRuntimeLease } from '../runtimeLease';

export interface ComputerPolicy { epoch: string; paused: boolean; allowed: string[]; stop?: string; resumeOnStart?: boolean }
export interface ComputerActivity { id: string; pid: number; action: string; session: string; at: number; epoch: string }
export interface ComputerPresentation { id: string; pid: number; session: string; epoch: string; at: number; windowId: string; processId: number; action: string; x?: number; y?: number; theme?: string; reducedMotion?: boolean; effects?: string }
export function presentComputer(storage: string, value: Omit<ComputerPresentation, 'id' | 'pid' | 'at'>): ComputerPresentation {
	const p = { ...value, id: randomUUID(), pid: process.pid, at: Date.now() };
	const dir = computerDirectory(storage), temp = path.join(dir, randomUUID() + '.tmp');
	try { fs.writeFileSync(temp, JSON.stringify(p), {mode:0o600}); fs.renameSync(temp, path.join(dir, 'presentation.json')); }
	finally { fs.rmSync(temp, {force:true}); }
	return p;
}
export function endComputerSession(storage: string, session: string): void {
	const file = path.join(computerDirectory(storage), 'presentation.json');
	if (!fs.existsSync(file)) return;
	const release = acquireRuntimeLease(computerDirectory(storage));
	if (!release) return;
	try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p.pid === process.pid && p.session === session) fs.unlinkSync(file); }
	catch { /* A different project may own the desktop, or no computer action ran. */ }
	finally { release(); }
}
export async function awaitComputerMonitor(storage: string, id: string, epoch: string, signal: AbortSignal): Promise<void> {
	if (!fs.existsSync(path.join(computerDirectory(storage), 'monitor-required.json'))) return;
	const end = Date.now() + 5000;
	while (Date.now() < end) {
		signal.throwIfAborted();
		try {
			const p = JSON.parse(fs.readFileSync(path.join(computerDirectory(storage), 'monitor-ready.json'), 'utf8'));
			if (p.id === id && p.epoch === epoch && Number.isInteger(p.pid) && p.pid > 0 && Math.abs(Date.now() - p.at) < 1500) { process.kill(p.pid, 0); return; }
		} catch { /* Wait for this presentation to be visible and guarded. */ }
		await new Promise<void>(resolve => setTimeout(resolve, 40));
	}
	stopComputer(storage);
	throw new Error('Computer Use controls are unavailable. Control was paused; open app permissions to resume.');
}
export const computerDirectory = (storage: string) => path.join(storage, 'computer-use');
export const computerPolicyFile = (storage: string) => path.join(computerDirectory(storage), 'permissions.json');
export function stopComputer(storage: string): void {
	const dir = computerDirectory(storage); fs.mkdirSync(dir,{recursive:true});
	const temp = path.join(dir,randomUUID()+'.tmp');
	try { fs.writeFileSync(temp,'stop:' + randomUUID(),{mode:0o600}); fs.renameSync(temp,path.join(dir,'stop')); }
	finally { fs.rmSync(temp,{force:true}); }
}
function stopToken(storage: string): string { try { return fs.readFileSync(path.join(computerDirectory(storage),'stop'),'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } }
export function computerPolicy(storage: string): ComputerPolicy {
	try {
		const file = computerPolicyFile(storage);
		if (fs.statSync(file).size > 65536) throw new Error('Invalid Computer Use permissions.');
		const p = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (typeof p.epoch !== 'string' || !p.epoch || typeof p.paused !== 'boolean' || !Array.isArray(p.allowed) || p.allowed.length > 100 || !p.allowed.every((s: unknown) => typeof s === 'string' && s.length < 4096 && path.win32.isAbsolute(s) && !s.includes('\0'))) throw new Error('Invalid Computer Use permissions.');
		if ((p.stop || '') !== stopToken(storage)) p.paused = true;
		return p;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { epoch:'', paused:true, allowed:[] };
		throw new Error('Computer Use permissions could not be read. Open its permissions and try again.');
	}
}
export function changeComputerPolicy(storage: string, update: (p: ComputerPolicy) => void): ComputerPolicy {
	const dir = computerDirectory(storage), release = acquireRuntimeLease(path.join(dir, 'configuration'));
	if (!release) throw new Error('Computer Use permissions are being updated in another window. Try again.');
	const temp = path.join(dir, randomUUID() + '.tmp');
	try {
		const p = computerPolicy(storage), stop = stopToken(storage); update(p); p.epoch = randomUUID(); p.stop = stop;
		fs.writeFileSync(temp, JSON.stringify(p), { mode:0o600 }); fs.renameSync(temp, computerPolicyFile(storage));
		return p;
	} finally { fs.rmSync(temp, {force:true}); release(); }
}
export function computerActivity(storage: string): ComputerActivity | undefined {
	try {
		const dir = path.join(computerDirectory(storage), 'activity'), epoch = computerPolicy(storage).epoch;
		const live: ComputerActivity[] = [];
		for (const name of fs.readdirSync(dir)) {
			if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
			const file = path.join(dir,name);
			try {
				const a = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (typeof a.id !== 'string' || !Number.isInteger(a.pid) || a.pid <= 0 || typeof a.action !== 'string' || typeof a.session !== 'string' || !Number.isFinite(a.at) || a.epoch !== epoch) throw new Error('Stale activity');
				process.kill(a.pid, 0); live.push(a);
			} catch { fs.rmSync(file, {force:true}); }
		}
		return live.sort((a,b) => b.at-a.at)[0];
	} catch { return; }
}
export function beginComputerActivity(storage: string, action: string, session: string, signal: AbortSignal) {
	const p = computerPolicy(storage);
	// Only the user can allow an app or resume; say which of the two is missing.
	if (!p.allowed.length) throw new Error('No app is allowed for Computer Use yet. The user must open Computer Use permissions, allow the app, then choose Resume. The agent cannot do this.');
	if (p.paused) throw new Error('Computer Use is paused. The user must open Computer Use permissions and choose Resume. The agent cannot do this.');
	const id = randomUUID();
	const abort = new AbortController(), dir = path.join(computerDirectory(storage), 'activity'), file = path.join(dir, id + '.json');
	const check = () => {
		try { const current = computerPolicy(storage); if (current.paused || current.epoch !== p.epoch) abort.abort(new Error('Computer Use stopped or app permissions changed. Take a new screenshot after resuming.')); }
		catch (error) { abort.abort(error); }
	};
	const stopped = () => abort.abort(signal.reason);
	signal.addEventListener('abort', stopped, {once:true}); if (signal.aborted) stopped();
	fs.mkdirSync(dir, {recursive:true});
	fs.writeFileSync(file, JSON.stringify({id, pid:process.pid, action, session, at:Date.now(), epoch:p.epoch}), {mode:0o600});
	const timer = setInterval(check, 40); timer.unref();
	return { signal:abort.signal, epoch:p.epoch, check, close: () => {
		clearInterval(timer); signal.removeEventListener('abort', stopped);
		try { if (JSON.parse(fs.readFileSync(file,'utf8')).id === id) fs.unlinkSync(file); } catch { /* A newer operation owns the status. */ }
	} };
}
