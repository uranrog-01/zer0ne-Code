import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ToolDef } from '../chatClient';
import type { AgentSettings } from '../providerStore';
import { workspaceRoot, type ToolContext, type ToolOutcome } from './agentTools';
import { acquireProjectCheck, checkConfiguration, createProjectPlan, projectFingerprint, runProjectPlan, type ProjectReport } from './projectChecks';
import { browserScenarios, runBrowserScenarios } from './browserChecks';
import { configuredLanguageService, languageResult } from './languageService';

const empty = {type:'object',properties:{},additionalProperties:false};
export function featureToolDefs(settings: AgentSettings): ToolDef[] {
	const defs: ToolDef[] = [];
	if (settings.projectVerification && settings.commandTool) defs.push({name:'project_verify',description:'Detect and run project typecheck, check, lint, test and build stages, with existing command approvals. Stops at a failed stage. Returns a dated report tied to a project snapshot; scripts can write files.',parameters:empty});
	if (settings.dependencyAudit && settings.commandTool) defs.push({name:'dependency_audit',description:'Run npm audit --json --ignore-scripts using existing command approvals. Requires package-lock.json. Sends dependency metadata to the configured npm registry; reports findings without applying fixes.',parameters:empty});
	if (settings.browserChecks && settings.browserAgent) defs.push({name:'browser_regression',description:'Review and run the project scenarios in .zer0ne/browser-checks.json. Uses a separate browser profile, assertions and saved screenshots. No app server is started automatically.',parameters:empty});
	if (settings.codeIntelligence) defs.push({name:'project_code_intel',description:'Read-only diagnostics and semantic navigation using the locally configured language server. Positions are 1-based; workspace_symbols uses query. Unsupported operations return an explicit error.',parameters:{type:'object',properties:{operation:{type:'string',enum:['diagnostics','definition','references','implementation','document_symbols','workspace_symbols','hover']},path:{type:'string'},line:{type:'integer',minimum:1},character:{type:'integer',minimum:1},symbol:{type:'string'},query:{type:'string'}},required:['operation'],additionalProperties:false}});
	return defs;
}

export async function runFeatureTool(name: string, args: Record<string,unknown>, ctx: ToolContext): Promise<ToolOutcome | undefined> {
	if (!['project_verify','dependency_audit','browser_regression','project_code_intel'].includes(name)) return undefined;
	if (!featureToolDefs(ctx.settings).some(d => d.name === name)) throw new Error('Enable this capability and its dependencies in Settings → Features.');
	const uri = workspaceRoot(); if (uri?.scheme !== 'file') throw new Error('Open a local project folder.');
	const root = fs.realpathSync(uri.fsPath);
	if (name === 'project_code_intel') {
		const service = configuredLanguageService(root,ctx.settings);
		const value = await service.inspect(String(args.operation),String(args.path || ''),{line:args.line === undefined ? 1 : Number(args.line),character:args.character === undefined ? 1 : Number(args.character),symbol:args.symbol === undefined ? undefined : String(args.symbol),query:String(args.query || '')},ctx.signal);
		return {api:languageResult(value),summary:String(args.operation)+' · '+String(args.path || 'workspace')};
	}
	if (ctx.readOnly) throw new Error('Project execution is unavailable in read-only mode.');
	const update = (report: ProjectReport) => ctx.onFeatureReport?.(report);
	if (name !== 'browser_regression') {
		const plan = await createProjectPlan(root,name === 'dependency_audit' ? 'audit' : 'verify',ctx.settings.denyPaths,ctx.signal);
		const report = await runProjectPlan(plan,ctx,update,ctx.settings.denyPaths);
		return {api:languageResult(report),summary:report.kind+' · '+report.status,error:report.status !== 'passed'};
	}
	if (!ctx.storageDir) throw new Error('Browser checks require local report storage.');
	const scenarios = browserScenarios(root,ctx.settings.denyPaths), fingerprint = await projectFingerprint(root,ctx.settings.denyPaths,ctx.signal);
	const approval = await ctx.requestApproval({kind:'command',command:'Browser regression scenarios (URLs and assertions):\n'+JSON.stringify(scenarios,null,2)});
	if (!approval.approved) return {api:'Browser checks declined.',summary:'declined',error:true};
	let release: (() => void) | undefined;
	const report: ProjectReport = {id:randomUUID(),kind:'browser',root,fingerprint,configuration:checkConfiguration(ctx.settings),startedAt:Date.now(),status:'running',stale:false,stages:[],scope:'Project-declared browser URLs and assertions; a separate browser profile.'};
	const abort = new AbortController(), stop = () => abort.abort(), timer = setTimeout(stop,10*60_000);
	ctx.signal.addEventListener('abort',stop,{once:true});
	try {
		ctx.signal.throwIfAborted(); release = acquireProjectCheck(root);
		if (await projectFingerprint(root,ctx.settings.denyPaths,ctx.signal) !== fingerprint) throw new Error('Project changed during review. Run browser_regression again.');
		update(report);
		await runBrowserScenarios(scenarios,report,ctx.featureStorageDir || path.join(ctx.storageDir,'features'),{path:ctx.settings.browserPath,headless:ctx.settings.browserHeadless},abort.signal,update);
		report.status = report.stages.some(s => s.status !== 'passed') ? 'failed' : 'passed';
	} catch (error) { report.status = abort.signal.aborted ? 'cancelled' : 'failed'; report.stages.push({name:'Run',command:'',status:report.status,output:String((error as Error).message),durationMs:0}); }
	finally { clearTimeout(timer); ctx.signal.removeEventListener('abort',stop); release?.(); report.finishedAt = Date.now(); try { report.stale = await projectFingerprint(root,ctx.settings.denyPaths) !== fingerprint; } catch { report.stale = true; } update(report); approval.finish(report.status,report.status !== 'passed'); }
	return {api:languageResult(report),summary:'browser · '+report.status,error:report.status !== 'passed'};
}
