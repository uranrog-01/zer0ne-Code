import { execFile } from 'child_process';
import * as path from 'path';
import { createHash } from 'crypto';
import type { McpServerConfig, ModelEntry, ProviderConfig } from '../providerStore';
import type { McpManager } from '../tools/mcp';

import type { SkillStore } from '../tools/skills';
import { workspaceRoot } from '../tools/agentTools';
import { findBrowser } from '../tools/browser';
import { ripgrepPath } from '../tools/ripgrep';
import { sandboxStatus } from '../tools/sandbox';
import { scriptSandboxAvailable } from '../tools/script';
import { saverTotals } from '../tools/tokenSaver';
import { verificationStages, projectFile } from '../tools/projectChecks';
import { browserScenarios } from '../tools/browserChecks';
import { FEATURE_REGISTRY, featureCatalog } from './featureRegistry';
import { installedStudio, bundleState } from '../localStudio';
import { DIFFUSION_BUNDLES } from '../localCatalog';
import { denyReadPaths, sandboxDenyPaths } from '../tools/sandbox';
import { isDesktopHost } from './capabilities';
import type { HostContext, HostFeature, HostSurface } from './context';

export type HealthItem = { id:string; label:string; state:'ok'|'warn'|'fail'|'off'; detail:string; evidence?:'configuration'|'discovery'|'measurement'|'local probe'|'reachability'; readiness?:'available'|'setup'|'problem'|'off'; checkedAt?:number; scope?:string };
export interface HealthSources {
 checkReady(provider?:ProviderConfig,model?:ModelEntry):Promise<string|undefined>;
 storageDir:string; extensionDir:string; codeIndexStats():{files:number;chunks:number;embedded?:number}|undefined;
 mcp:McpManager; mcpConfigs():McpServerConfig[]; skills:SkillStore;
 cacheStats:{input:number;cached:number};  sessionId?():string;
}

export class FeaturesHealthHost implements HostFeature {
 private jobs = new Map<string,Promise<HealthItem[]>>();
 private requests = new Map<HostSurface,AbortController>();
 private stopped = new AbortController();
 constructor(private ctx:HostContext,private src:HealthSources) {}
 async handle(surface:HostSurface,msg:{type:string;[key:string]:unknown}):Promise<boolean> {
  if (msg.type === 'featuresCancel') { this.requests.get(surface)?.abort(); return true; }
  if (msg.type !== 'featuresCheck') return false;
  this.requests.get(surface)?.abort();
  const abort = new AbortController(); this.requests.set(surface,abort);
  const requestId = typeof msg.requestId === 'string' ? msg.requestId.slice(0,128) : '';
  const startedAt = Date.now(), contextFingerprint = createHash('sha256').update(JSON.stringify([this.ctx.store.getSettings(),workspaceRoot()?.toString(),this.src.sessionId?.()])).digest('hex');
  try {
   const work = this.check(msg.manual === true,msg.revision);
   const items = await new Promise<HealthItem[]>((resolve,reject) => {
    const cancel = () => reject(Object.assign(new Error('Check cancelled.'),{name:'AbortError'}));
    abort.signal.addEventListener('abort',cancel,{once:true});
    work.then(resolve,reject).finally(() => abort.signal.removeEventListener('abort',cancel));
    if (abort.signal.aborted) cancel();
   });
   if (!abort.signal.aborted) surface.post({type:'featuresHealth',requestId,revision:msg.revision,contextFingerprint,startedAt,at:Date.now(),items});
  } catch (error) {
   surface.post({type:'featuresHealth',requestId,revision:msg.revision,at:Date.now(),items:[],error:String((error as Error).message),cancelled:abort.signal.aborted});
  } finally { if (this.requests.get(surface) === abort) this.requests.delete(surface); }
  return true;
 }
 async check(manual=false,revision?:unknown):Promise<HealthItem[]> {
  const settings = this.ctx.store.getSettings(), root = workspaceRoot();
  const selected = await this.ctx.store.resolveSelection(this.src.sessionId?.());
  const key = createHash('sha256').update(JSON.stringify([settings,selected.provider,selected.model,root?.toString(),manual,revision])).digest('hex');
  const active = this.jobs.get(key); if (active) return active;
  const work = this.inspect(settings,selected.provider,selected.model,root?.scheme === 'file' ? root.fsPath : undefined,manual);
  this.jobs.set(key,work); void work.finally(() => { if (this.jobs.get(key) === work) this.jobs.delete(key); }).catch(() => {});
  return work;
 }
 private async inspect(s:ReturnType<HostContext['store']['getSettings']>,provider:ProviderConfig|undefined,model:ModelEntry|undefined,root:string|undefined,manual:boolean):Promise<HealthItem[]> {
  const at = Date.now(), out:HealthItem[] = [];
  const add = (id:string,label:string,state:HealthItem['state'],detail:string,evidence:HealthItem['evidence']='configuration',readiness:HealthItem['readiness']=state==='fail'?'problem':state==='off'?'off':'available') => out.push({id,label,state,detail,evidence,readiness,checkedAt:at,scope:root||'No project'});
  const bounded = async <T>(work:Promise<T>):Promise<T> => {
   let timer:ReturnType<typeof setTimeout>;
   try { return await Promise.race([work,new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error('Check timed out.')),7000); })]); }
   finally { clearTimeout(timer!); }
  };
  try { const problem=await bounded(this.src.checkReady(provider,model)); add('model','Chat model',problem?'fail':'warn',problem?problem.replace(/\*\*/g,''):`Configured: ${provider?.name} · ${model?.name||model?.id}. Generation has not been tested here.`); }
  catch(error) { add('model','Chat model','fail',String((error as Error).message)); }
  const rg=ripgrepPath(); add('search','Code search',rg?'ok':'warn',rg?'ripgrep detected; search execution not tested.':'Using the built-in search fallback.','discovery');
  await Promise.all([
   (async()=>{ if(!s.gitTools){add('git','Git tools','off','Disabled.');return;} const version=await new Promise<string>(resolve=>execFile('git',['--version'],{timeout:5000,windowsHide:true,signal:this.stopped.signal},(error,stdout)=>resolve(error?'':String(stdout).trim()))); add('git','Git tools',version?'ok':'fail',version||'Git is unavailable on PATH.','local probe'); })(),
   (async()=>{ if(!s.browserTools){add('web','Web research','off','Disabled.');return;} if(!manual||s.disableNonessentialNetwork){add('web','Web research','warn',s.disableNonessentialNetwork?'Background network checks are disabled.':'Configured. Run check explicitly to test service reachability.');return;} const ok=await fetch(s.searchEngine==='duckduckgo'?'https://duckduckgo.com':'https://exa.ai',{method:'HEAD',signal:AbortSignal.any([this.stopped.signal,AbortSignal.timeout(5000)])}).then(r=>r.status<500,()=>false); add('web','Web research',ok?'ok':'warn',ok?'Service reachable; search results and authentication are not tested.':'Service did not respond.','reachability',ok?'available':'problem'); })()
  ]);
  if(s.commandTool){const sb=sandboxStatus(root,this.src.storageDir,path.join(this.src.extensionDir,'media','sandbox','lowil.cs'),sandboxDenyPaths(s,this.src.storageDir),denyReadPaths(s.sandboxDenyRead).length);add('sandbox','Command sandbox',s.sandbox==='off'?'off':sb.available?'ok':'warn',s.sandbox==='off'?'Disabled.':sb.detail,'discovery',s.sandbox==='off'?'off':sb.available?'available':'setup');}
  add('script','Read-only scripts',!s.runScript?'off':scriptSandboxAvailable()?'ok':'fail',!s.runScript?'Disabled.':scriptSandboxAvailable()?'Node permission model is available; script execution is not tested.':'This runtime lacks the required Node permission model.','discovery');
  const browser=findBrowser(s.browserPath);add('browser','Browser agent',!s.browserAgent?'off':browser?'warn':'fail',!s.browserAgent?'Disabled.':browser?'Browser detected. Use Browser settings to test launch.':'Choose an installed browser in Browser settings.','discovery',!s.browserAgent?'off':browser?'available':'setup');
  const index=this.src.codeIndexStats();add('index','Code index',!s.codeIndex?'off':index?'ok':'warn',!s.codeIndex?'Disabled.':index?`${index.files} files · ${index.chunks} chunks${index.embedded?' · '+index.embedded+' embedded':''}`:root?'Not built yet; builds on search.':'Open a project to build its index.',index?'measurement':'configuration',!s.codeIndex?'off':root?'available':'setup');
  const statuses=s.mcp?this.src.mcp.statuses(this.src.mcpConfigs().filter(c=>c.enabled)):[],ready=statuses.filter(x=>x.state==='ready').length;
  add('mcp','MCP tools',!s.mcp?'off':statuses.length&&ready===statuses.length?'ok':'warn',!s.mcp?'Disabled.':!statuses.length?'No enabled servers.':`${ready} of ${statuses.length} ready. Discovery does not test tool execution. ${statuses.filter(x=>x.state==='error'||x.state==='auth').map(x=>x.name+': '+(x.error||x.state)).join('; ')}`,'discovery',!s.mcp?'off':!statuses.length?'setup':ready===statuses.length?'available':'problem');
  const skills=s.skills?this.src.skills.list():[];add('skills','Skills',!s.skills?'off':skills.length?'ok':'warn',!s.skills?'Disabled.':`${skills.filter(x=>x.enabled).length} enabled of ${skills.length}; playbook execution is not tested.`,'discovery');
  const saved=saverTotals();add('saver','Token Saver',!s.tokenSaver?'off':saved.before?'ok':'warn',!s.tokenSaver?'Disabled.':saved.before?`${saved.before-saved.after} tokens removed from tool output.`:'Enabled; no output samples yet.',saved.before?'measurement':'configuration');
  const cache=this.src.cacheStats;add('cache','Exact history / cache',!s.exactHistory?'off':cache.input?'ok':'warn',!s.exactHistory?'Disabled.':cache.input?`${Math.round(100*cache.cached/cache.input)}% input reported cached. This is not a provider guarantee.`:'Enabled; no request measurements yet.',cache.input?'measurement':'configuration');
  for(const [id,detail] of [['autoCompact',`Enabled at ${s.compactThreshold}%${s.compactMaxTokens ? ` or ${Math.round(s.compactMaxTokens / 1000)}k tokens, whichever comes first` : ''}. No compaction is run by this check.`],['deferTools','Enabled; tool discovery is used on demand.'],['repoMap','Enabled; a compact map of folders and main symbols joins the agent prompt and is rebuilt only when files are added or removed.'],['cacheWarm',provider?.apiFormat==='anthropic'?'Configured; actual refreshes are paid and governed by estimated savings.':'This selection is not a direct Anthropic connection; warming is inactive.'],['subagents',model?.tools===false&&provider?.apiFormat!=='acp'?'The selected model does not support tool calls.':`Configured for at most ${s.childConcurrency} concurrent children; no worker is launched.`]] as const){const enabled=!!s[id];add(id,FEATURE_REGISTRY.find(f=>f.key===id)!.name,enabled?'warn':'off',enabled?detail:'Disabled.','configuration',!enabled?'off':id==='subagents'&&model?.tools===false&&provider?.apiFormat!=='acp'?'setup':'available');}
  add('computerUse','Computer Use',!s.computerUse?'off':!model?.vision?'fail':'warn',!s.computerUse?'Disabled.':!model?.vision?'Choose a vision-capable model.':'Vision configured. The agent asks in the chat to allow an app (Full access allows it without asking). Stop and Pause are only resumed by you. No screenshot or input is sent by this check.','configuration',!s.computerUse?'off':model?.vision?'available':'setup');
  const localChecks:Record<string,()=>string>={
   commandNotices:()=>{if(!s.commandTool)throw Error('Enable terminal commands.');return 'Background commands report when they end. Commands you stop yourself stay silent.';},
   agentWatchdog:()=>{if(!s.subagents)throw Error('Enable Subagents.');return `Checks running agents every 30 s: three identical steps in a row, or ${s.watchdogStallMinutes} min without a finished step.`;},
   agentDriftCheck:()=>{if(!s.agentWatchdog)throw Error('Enable the agent watchdog.');return 'Background agents are checked by the chat model every 10 minutes while they work. No check has been run by this test.';},
   recallTool:()=>'The main agent can look up agents, commands, conversations and events by id.',
   threadRouting:()=>{if(!s.subagents)throw Error('Enable Subagents.');return 'Replies in a Telegram or Discord conversation reach the agent that owns it. Pair a channel in Mobile remote.';},
   eventSources:()=>{if(!root)throw Error('Open a project.');if(!s.gitTools)throw Error('Enable Git tools.');return `Checks every ${s.eventPollMinutes} min with the GitHub CLI (gh, signed in). The first check only notes what already exists. ${s.eventAutoAct?'Events your policy asks for reach the agent.':'Observing: events your policy asks for are recorded, not handed over.'}`;},imageGenerate:()=>{if(s.imageGenModel.trim())return `Image model: ${s.imageGenModel.trim()}. Generation has not been tested here.`;const studioDir=path.join(this.src.storageDir,'studio');if(!installedStudio(path.join(studioDir,'engine')))throw Error('No image model is set and the image & video engine is not installed.');const models=DIFFUSION_BUNDLES.filter(x=>x.kind==='image'&&bundleState(path.join(studioDir,'models'),x).installed);if(!models.length)throw Error('No image model is downloaded in Local models.');return `Local Studio: ${models[0].name}${models.length>1?` (+${models.length-1} more)`:''}.`;},projectVerification:()=>{if(!root)throw Error('Open a project.');if(!s.commandTool)throw Error('Enable terminal commands.');const stages=verificationStages(root,s.denyPaths);if(!stages.length)throw Error('Add supported project check scripts.');return `${stages.length} stages detected. Preview before executing.`;},dependencyAudit:()=>{if(!root)throw Error('Open a project.');if(!s.commandTool)throw Error('Enable terminal commands.');projectFile(root,'package-lock.json',s.denyPaths);return 'npm lockfile detected. Audit uses the registry; preview before running.';},browserChecks:()=>{if(!root)throw Error('Open a project.');if(!s.browserAgent||!browser)throw Error('Enable and configure the browser agent.');return `${browserScenarios(root,s.denyPaths).length} scenarios detected; no browser test executed.`;},codeIntelligence:()=>{if(!root)throw Error('Open a project.');if(!s.languageServerCommand.trim())throw Error('Configure a local language server.');const args=JSON.parse(s.languageServerArgs||'[]');if(!Array.isArray(args)||args.some(a=>typeof a!=='string'))throw Error('Arguments must be a JSON string array.');return 'Server configured. Test connection to discover actual capabilities.';},workspaceWatch:()=>{if(!root)throw Error('Open a project.');return 'File-change invalidation enabled; no commands run automatically.';},remote:()=>s.remoteEnabled?'Configured for this project. Inspect Mobile remote for its live connection.':'Disabled.'};
  for(const [id,inspect]of Object.entries(localChecks)){const definition=featureCatalog(isDesktopHost()).find(f=>f.check===id)!;if(!s[definition.key]){add(id,definition.name,'off','Disabled.');continue;}try{add(id,definition.name,'warn',inspect());}catch(error){add(id,definition.name,'warn',String((error as Error).message),'configuration','setup');}}
  for(const feature of featureCatalog(isDesktopHost()).filter(f=>f.editorOnly)){add(feature.check,feature.name,s[feature.key]?'warn':'off',s[feature.key]?'Configured; use its editor integration to test operation.':'Disabled.');}
  this.stopped.signal.throwIfAborted();return out.sort((a,b)=>a.id.localeCompare(b.id));
 }
 dispose():void{this.stopped.abort();for(const request of this.requests.values())request.abort();this.requests.clear();this.jobs.clear();}
}
