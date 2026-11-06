import * as path from 'path';
import * as fs from 'fs';
import type { HostContext, HostFeature, HostSurface } from './context';
import { computerWindows } from '../tools/computer';
import { changeComputerPolicy, computerActivity, computerPolicy, stopComputer } from '../tools/computerControl';

export class ComputerUseHost implements HostFeature {
	private surfaces = new Set<HostSurface>();
	private abort = new AbortController();
	private timer: ReturnType<typeof setInterval>;
	private subscription: {dispose():void};
	private signature = '';
	private enabled: boolean;
	constructor(private ctx: HostContext, private storage: string, private source: string) {
		this.enabled = ctx.store.getSettings().computerUse;
		this.subscription = ctx.store.onSettingsChanged(() => {
			const enabled = ctx.store.getSettings().computerUse;
			if (!enabled && this.enabled) stopComputer(storage);
			this.enabled = enabled; this.publish();
		});
		this.timer = setInterval(() => this.publish(), 250); this.timer.unref();
	}
	private view() {
		const policy = computerPolicy(this.storage), active = computerActivity(this.storage);
		let shortcut = false;
		try { const value = JSON.parse(fs.readFileSync(path.join(this.storage,'computer-use','shortcut.json'),'utf8')); if (value.registered && Number.isInteger(value.pid) && value.pid > 0) { process.kill(value.pid,0); shortcut = true; } } catch { /* Editor hosts and unavailable shortcuts use the visible Stop button. */ }
		return {type:'computerUseState', supported:process.platform === 'win32', enabled:this.enabled, history:this.ctx.store.getSettings().computerScreenshotHistory, effects:this.ctx.store.getSettings().computerEffects === 'design' ? 'design' : 'classic', stayReady:policy.resumeOnStart === true, paused:policy.paused, shortcut, apps:policy.allowed.map(file => ({path:file,name:path.win32.basename(file,'.exe')})), active:active ? {action:active.action,at:active.at} : null};
	}
	private publish() {
		if (!this.surfaces.size) return;
		try {
			const state = this.view(), signature = JSON.stringify(state);
			if (signature === this.signature) return;
			this.signature = signature; for (const surface of this.surfaces) surface.post(state);
		} catch (error) { for (const surface of this.surfaces) surface.post({type:'computerUseState',enabled:this.enabled,paused:true,apps:[],error:String(error)}); }
	}
	async handle(surface: HostSurface, msg: {type:string;[key:string]:unknown}): Promise<boolean> {
		if (!['computerUseState','computerUseApps','computerUseAllow','computerUseRevoke','computerUseStop','computerUseResume','computerUseStayReady'].includes(msg.type)) return false;
		if (surface.kind === 'remote') { surface.post({type:'computerUseError',message:'Computer Use permissions are managed on this computer.'}); return true; }
		this.surfaces.add(surface);
		try {
			if (msg.type === 'computerUseApps' || msg.type === 'computerUseAllow') {
				const windows = await computerWindows({storageDir:this.storage,sourceFile:this.source,signal:this.abort.signal});
				if (msg.type === 'computerUseApps') { surface.post({type:'computerUseApps',apps:windows,requestId:msg.requestId}); return true; }
				const app = windows.find(w => w.windowId === msg.windowId && w.processId === msg.processId);
				if (!app) throw new Error('That app window closed or changed. Refresh the app list.');
				changeComputerPolicy(this.storage,p => { if (!p.allowed.some(s => s.toLowerCase() === app.path.toLowerCase())) { if (p.allowed.length >= 100) throw new Error('Remove an app before adding another.'); p.allowed.push(app.path); } p.paused = true; });
			} else if (msg.type === 'computerUseRevoke') {
				changeComputerPolicy(this.storage,p => { p.allowed = p.allowed.filter(file => file !== msg.path); p.paused = true; });
			} else if (msg.type === 'computerUseStop') {
				stopComputer(this.storage);
			} else if (msg.type === 'computerUseStayReady') {
				// Only the choice changes: whether control is paused right now stays as it is.
				changeComputerPolicy(this.storage,p => { p.resumeOnStart = msg.on === true; });
			} else if (msg.type === 'computerUseResume') {
				if (process.platform !== 'win32') throw new Error('App permissions currently require Windows.');
				if (!this.ctx.store.getSettings().computerUse) throw new Error('Enable Computer Use first.');
				changeComputerPolicy(this.storage,p => { if (!p.allowed.length) throw new Error('Allow at least one app first.'); p.paused = false; });
			}
			surface.post({...this.view(),requestId:msg.requestId}); this.publish();
		} catch (error) { surface.post({type:'computerUseError',message:error instanceof Error ? error.message : String(error),requestId:msg.requestId}); }
		return true;
	}
	dispose(): void { clearInterval(this.timer); this.abort.abort(); this.subscription.dispose(); this.surfaces.clear(); }
}
