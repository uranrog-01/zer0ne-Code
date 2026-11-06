import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import type { HostContext, HostFeature, HostSurface } from './context';
import { workspaceRoot } from '../tools/agentTools';
import { PROJECT_GENERATED_DIRECTORIES, acquireProjectCheck, checkConfiguration, createProjectPlan, runProjectPlan, projectFingerprint, type ProjectPlan, type ProjectReport } from '../tools/projectChecks';
import { browserScenarios, runBrowserScenarios, type BrowserScenario } from '../tools/browserChecks';
import { configuredLanguageService, closeLanguageServices, languageResult } from '../tools/languageService';
import { redactSecrets } from '../tools/redact';
import { denyReadPaths, sandboxDenyPaths, sandboxStatus } from '../tools/sandbox';

interface Preview { plan: ProjectPlan; owner: HostSurface; session: string; scenarios?: BrowserScenario[]; outsideSandbox?: boolean; }
export class FeatureToolsHost implements HostFeature {
	private previews = new Map<string, Preview>();
	private running?: {id:string;abort:AbortController;root:string;kind:string};
	private languageConfig = '';
	private reports: ProjectReport[] = [];
	private watcher?: vscode.FileSystemWatcher;
	private watchRoot?: string;
	private watchTimer?: ReturnType<typeof setTimeout>;
	private revision = 0;
	private disposed = false;
	private settingsSubscription: {dispose():void};
	constructor(private ctx: HostContext, private storage: string, private session: () => string, private busy: () => boolean, private invalidateIndex: () => void, private extensionDir = '') {
		this.load();
		this.settingsSubscription = ctx.store.onSettingsChanged(() => this.syncSettings());
		this.syncSettings();
	}
	private root(): string { const root = workspaceRoot(); if (root?.scheme !== 'file') throw new Error('Open a local project folder first.'); return fs.realpathSync(root.fsPath); }
	get storageDir(): string { return this.storage; }
	record(report: ProjectReport): void { this.update(report); }
	private load(): void {
		try {
			const reports: ProjectReport[] = [];
			for (const file of fs.readdirSync(path.join(this.storage,'reports'))) {
				if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
				const target = path.join(this.storage,'reports',file); if (fs.statSync(target).size > 10*1024*1024) continue;
				try {
					const raw = JSON.parse(fs.readFileSync(target,'utf8'));
					if (raw && raw.id+'.json' === file && typeof raw.root === 'string' && typeof raw.fingerprint === 'string' && typeof raw.scope === 'string' && ['verify','audit','browser'].includes(raw.kind) && ['passed','failed','cancelled'].includes(raw.status) && Number.isFinite(raw.startedAt) && Number.isFinite(raw.finishedAt) && Array.isArray(raw.stages) && raw.stages.length <= 21 && raw.stages.every((s: any) => s && typeof s.name === 'string' && typeof s.command === 'string' && typeof s.output === 'string' && (!s.findings || Array.isArray(s.findings) && s.findings.every((f: any) => f && typeof f.name === 'string' && typeof f.severity === 'string' && (!f.versions || Array.isArray(f.versions) && f.versions.every((v: unknown) => typeof v === 'string')))))) reports.push(raw);
				} catch { /* incomplete report */ }
			}
			reports.sort((a,b) => a.startedAt-b.startedAt);
			for (const old of reports.slice(0,-20)) {
				try {
					fs.unlinkSync(path.join(this.storage,'reports',old.id+'.json'));
					for (let i=0;i<20;i++) { const shot=path.join(this.storage,'feature-shots',old.id+'-'+i+'.jpg'); try { fs.unlinkSync(shot); } catch { /* no screenshot */ } }
				} catch { /* another window may already have pruned it */ }
			}
			this.reports = [...reports,...this.reports.filter(r => !r.finishedAt)].sort((a,b) => a.startedAt-b.startedAt).slice(-20);
		} catch { /* first run */ }
	}
	private save(only?: ProjectReport): void {
		const dir = path.join(this.storage,'reports'); fs.mkdirSync(dir,{recursive:true});
		for (const report of (only ? [only] : this.reports).filter(r => r.finishedAt)) {
			const target = path.join(dir,report.id+'.json'), temp = target+'.'+process.pid+'.tmp';
			try { if (JSON.parse(fs.readFileSync(target,'utf8')).stale) report.stale = true; } catch { /* new report */ }
			fs.writeFileSync(temp,JSON.stringify(report)); fs.renameSync(temp,target);
		}
	}
	private update = (report: ProjectReport): void => {
		if (report.configuration && report.configuration !== checkConfiguration(this.ctx.store.getSettings())) report.stale = true;
		this.reports = [...this.reports.filter(r => r.id !== report.id),JSON.parse(JSON.stringify(report))].slice(-20);
		if (report.finishedAt) { try { this.save(report); this.load(); } catch (error) { this.ctx.status('Could not save feature report: '+String(error),'error'); } }
		this.ctx.postAll({type:'featureReport',report});
	};
	private syncSettings(): void {
		const settings = this.ctx.store.getSettings(), config = JSON.stringify([settings.codeIntelligence,settings.languageServerCommand,settings.languageServerArgs,settings.denyPaths]);
		if (config !== this.languageConfig) { if (this.languageConfig) closeLanguageServices(); this.languageConfig = config; }
		if (this.running) { try { this.requireEnabled(this.running.kind); } catch { this.running.abort.abort(); } }
		this.syncWatcher();
	}
	private syncWatcher(): void {
		let root: string | undefined;
		try { if (this.ctx.store.getSettings().workspaceWatch) root = this.root(); } catch { /* no workspace */ }
		if (root === this.watchRoot) return;
		clearTimeout(this.watchTimer); this.watcher?.dispose(); this.watcher = undefined; this.watchRoot = root;
		if (!root || this.disposed) return;
		this.watcher = vscode.workspace.createFileSystemWatcher?.('**/*',false,false,false);
		const changed = (uri: vscode.Uri) => {
			const relative = path.relative(root!,uri.fsPath).replace(/\\/g,'/');
			if (!relative || relative.startsWith('../') || relative.split('/').some(part => PROJECT_GENERATED_DIRECTORIES.has(part))) return;
			clearTimeout(this.watchTimer);
			this.watchTimer = setTimeout(() => {
				if (this.disposed) return;
				this.revision++; this.invalidateIndex();
				this.reports.forEach(r => { if (r.root === root) r.stale = true; });
				try { this.save(); } catch { /* status still delivered */ }
				this.ctx.postAll({type:'featureWorkspace',root,revision:this.revision,at:Date.now(),reports:this.reports});
			},350);
		};
		this.watcher?.onDidCreate(changed); this.watcher?.onDidChange(changed); this.watcher?.onDidDelete(changed);
	}
	private requireEnabled(kind: string): void {
		const settings = this.ctx.store.getSettings();
		if (kind === 'verify' && !settings.projectVerification || kind === 'audit' && !settings.dependencyAudit || kind === 'browser' && !(settings.browserChecks && settings.browserAgent) || kind === 'language' && !settings.codeIntelligence) throw new Error('Enable this capability and its dependencies in Features first.');
		if (['verify','audit'].includes(kind) && !settings.commandTool) throw new Error('Enable terminal commands in Agent settings first.');
		if (this.ctx.store.getMode() === 'chat' && ['verify','audit','browser'].includes(kind)) throw new Error('Use Agent or Full access mode for project execution.');
	}
	async handle(surface: HostSurface, msg: {type:string;[key:string]:unknown}): Promise<boolean> {
		if (!['featureDashboard','featurePlan','featureRun','featureCancel','featureLanguage','featureImage'].includes(msg.type)) return false;
		const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0,128) : '';
		try {
			if (msg.type === 'featureDashboard' && workspaceRoot()?.scheme !== 'file') { surface.post({type:'featureToolsState',root:null,reports:[],running:null}); return true; }
			const root = this.root(); this.syncWatcher();
			if (msg.type === 'featureDashboard') {
				this.load();
				const reports = this.reports.filter(r => r.root === root);
				if (reports.some(r => !r.stale)) { try { const settings = this.ctx.store.getSettings(), fingerprint = await projectFingerprint(root,settings.denyPaths); reports.forEach(r => { if (r.fingerprint !== fingerprint || r.configuration !== checkConfiguration(settings)) r.stale = true; }); } catch { reports.forEach(r => { r.stale = true; }); } }
				surface.post({type:'featureToolsState',root,revision:this.revision,reports,running:this.running?.id}); return true;
			}
			if (msg.type === 'featureCancel') { if (msg.id === this.running?.id) this.running?.abort.abort(); return true; }
			if (msg.type === 'featureImage') {
				const file = String(msg.file ?? ''), id = /^([a-f0-9-]{36})-\d+\.jpg$/.exec(file)?.[1];
				if (!id || !this.reports.some(r => r.id === id && r.root === root)) throw new Error('Choose a screenshot from this project report.');
				const dir = fs.realpathSync(path.join(this.storage,'feature-shots')), target = fs.realpathSync(path.join(dir,file));
				if (path.dirname(target) !== dir || fs.statSync(target).size > 8*1024*1024) throw new Error('Screenshot unavailable.');
				surface.post({type:'featureImage',data:fs.readFileSync(target).toString('base64')}); return true;
			}
			if (msg.type === 'featureLanguage') {
				this.requireEnabled('language');
				const settings = this.ctx.store.getSettings(), service = configuredLanguageService(root,settings);
				const operation = String(msg.operation || 'connect'), abort = new AbortController();
				if (this.running || this.busy()) throw new Error('Wait for current work to finish.');
				const id = randomUUID(); this.running = {id,root,abort,kind:'language'};
				surface.post({type:'featureToolsState',root,running:id,reports:this.reports});
				try {
					const result = operation === 'connect' ? (await service.connect(abort.signal),{capabilities:service.describe()}) : await service.inspect(operation,String(msg.path || ''),{line:Number(msg.line || 1),character:Number(msg.character || 1),query:String(msg.query || '')},abort.signal);
					surface.post({type:'featureLanguage',requestId,result:languageResult(result)});
				} finally { this.running = undefined; surface.post({type:'featureToolsState',root,running:null,reports:this.reports}); }
				return true;
			}
			if (this.running || this.busy()) throw new Error('Wait for current project work to finish before running checks.');
			if (msg.type === 'featurePlan') {
				const kind = String(msg.kind);
				if (!['verify','audit','browser'].includes(kind)) throw new Error('Unknown project check.');
				this.requireEnabled(kind);
				const settings = this.ctx.store.getSettings();
				let plan: ProjectPlan, scenarios: BrowserScenario[] | undefined;
				if (kind === 'browser') { scenarios = browserScenarios(root,settings.denyPaths); plan = {id:randomUUID(),kind:'verify',root,createdAt:Date.now(),fingerprint:await projectFingerprint(root,settings.denyPaths),stages:scenarios.map(s => ({name:s.name,command:s.url})),scope:'Project-declared browser URLs and assertions; a separate browser profile.'}; }
				else plan = await createProjectPlan(root,kind as 'verify'|'audit',settings.denyPaths);
				plan.configuration = checkConfiguration(settings);
				const sandbox = kind === 'browser' || settings.sandbox === 'off' ? undefined : sandboxStatus(root,this.storage,path.join(this.extensionDir,'media','sandbox','lowil.cs'),sandboxDenyPaths(settings,this.storage),denyReadPaths(settings.sandboxDenyRead).length);
				const outsideSandbox = kind !== 'browser' && !sandbox?.available;
				const execution = kind === 'browser' ? 'Runs declared browser assertions in an isolated browser profile.' : outsideSandbox ? 'Runs outside an OS command sandbox with your user permissions. '+(sandbox?.detail || 'Command sandboxing is disabled in settings.') : 'Runs inside '+sandbox!.detail+'.';
				this.previews.clear(); this.previews.set(plan.id,{plan,owner:surface,session:this.session(),scenarios,outsideSandbox});
				surface.post({type:'featurePlan',requestId,plan:{...plan,kind,scenarios,execution,outsideSandbox}}); return true;
			}
			const preview = this.previews.get(String(msg.id));
			if (!preview || preview.owner !== surface || preview.session !== this.session() || preview.plan.root !== root || msg.approved !== true) throw new Error('Preview and approve a fresh plan in this view.');
			this.previews.delete(preview.plan.id);
			const kind = preview.scenarios ? 'browser' : preview.plan.kind; this.requireEnabled(kind);
			const settings = this.ctx.store.getSettings(), abort = new AbortController();
			if (preview.plan.configuration !== checkConfiguration(settings)) throw new Error('Execution settings changed after preview. Review a fresh plan.');
			this.running = {id:preview.plan.id,root,abort,kind};
			const timer = setTimeout(() => abort.abort(),10*60_000);
			let release: (() => void) | undefined;
			try {
				if (preview.scenarios) {
					release = acquireProjectCheck(root);
					if (Date.now()-preview.plan.createdAt > 300000 || await projectFingerprint(root,settings.denyPaths,abort.signal) !== preview.plan.fingerprint) throw new Error('Project changed or plan expired. Preview again.');
					const report: ProjectReport = {id:preview.plan.id,kind:'browser',root,fingerprint:preview.plan.fingerprint,configuration:preview.plan.configuration,startedAt:Date.now(),status:'running',stale:false,stages:[],scope:preview.plan.scope};
					this.update(report);
					try { await runBrowserScenarios(preview.scenarios,report,this.storage,{path:settings.browserPath,headless:settings.browserHeadless},abort.signal,this.update); report.status = report.stages.some(s => s.status !== 'passed') ? 'failed' : 'passed'; }
					catch (error) { report.status = abort.signal.aborted ? 'cancelled' : 'failed'; report.stages.push({name:'Run',command:'',status:abort.signal.aborted ? 'cancelled':'failed',output:redactSecrets(String(error)).text,durationMs:0}); }
					finally { report.finishedAt = Date.now(); try { report.stale = await projectFingerprint(root,settings.denyPaths) !== report.fingerprint; } catch { report.stale = true; } this.update(report); }
				} else {
					await runProjectPlan(preview.plan,{
						settings,signal:abort.signal,readOnly:false,
						sandbox:{mode:settings.sandbox === 'off' ? 'off' : 'always',network:settings.sandboxNetwork,storageDir:this.storage,sourceFile:path.join(this.extensionDir,'media','sandbox','lowil.cs')},
						requestApproval:async request => { if (request.escalate && !preview.outsideSandbox) throw new Error('The command sandbox became unavailable. Preview again to review execution outside the sandbox.'); return {approved:true,auto:false,finish:() => {}}; }
					},this.update,settings.denyPaths);
				}
			} finally { clearTimeout(timer); release?.(); this.running = undefined; this.ctx.postAll({type:'featureToolsState',root,running:null,reports:this.reports.filter(r => r.root === root)}); }
		} catch (error) { surface.post({type:'featureToolsError',requestId,running:this.running?.id ?? null,error:redactSecrets(String((error as Error).message)).text}); }
		return true;
	}
	dispose(): void { this.disposed = true; this.running?.abort.abort(); clearTimeout(this.watchTimer); this.watcher?.dispose(); this.settingsSubscription.dispose(); try { closeLanguageServices(this.root()); } catch { /* no root */ } this.previews.clear(); }
}
