import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHash, randomUUID } from 'crypto';
import { compileDeny } from './deny';
import { approveCommand, executeCommand, type CommandContext } from './command';
import { redactSecrets } from './redact';
import type { AgentSettings } from '../providerStore';

export type CheckKind = 'verify' | 'audit';
export interface CheckStage { name: string; command: string; }
export interface ProjectPlan { id: string; kind: CheckKind; root: string; fingerprint: string; configuration?: string; createdAt: number; stages: CheckStage[]; scope: string; }
export interface StageResult extends CheckStage { status: 'passed' | 'failed' | 'cancelled' | 'findings'; code?: number | null; output: string; durationMs: number; findings?: Array<{ name: string; severity: string; direct: boolean; fixAvailable: boolean; versions?: string[] }>; }
export interface ProjectReport { id: string; kind: string; root: string; fingerprint: string; configuration?: string; startedAt: number; finishedAt?: number; status: 'running' | 'passed' | 'failed' | 'cancelled'; stale: boolean; stages: StageResult[]; scope: string; }

export function checkConfiguration(settings: Partial<AgentSettings>): string {
	return createHash('sha256').update(JSON.stringify([settings.commandTool,settings.sandbox,settings.sandboxNetwork,settings.denyPaths,settings.browserPath,settings.browserHeadless])).digest('hex');
}

/** Engines in separate windows share this lease; only its owner may release it. */
export function acquireProjectCheck(root: string): () => void {
	const canonical = fs.realpathSync(root), key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
	const dir = path.join(os.tmpdir(),'zer0ne-project-checks'); fs.mkdirSync(dir,{recursive:true});
	const file = path.join(dir,createHash('sha256').update(key).digest('hex')+'.json'), token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt++) {
		try { fs.writeFileSync(file,JSON.stringify({pid:process.pid,token}),{flag:'wx'}); return () => { try { if (JSON.parse(fs.readFileSync(file,'utf8')).token === token) fs.unlinkSync(file); } catch { /* already released */ } }; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			let pid: number; try { pid = JSON.parse(fs.readFileSync(file,'utf8')).pid; } catch { throw new Error('Another project check is starting. Retry shortly.'); }
			if (!Number.isInteger(pid) || pid <= 0) throw new Error('Project check lock is invalid. Restart the app before retrying.');
			try { process.kill(pid,0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { try { fs.unlinkSync(file); } catch { /* another owner reclaimed it */ } continue; } }
			throw new Error('A project check is already running in another window.');
		}
	}
	throw new Error('Could not acquire the project check lock.');
}

export const PROJECT_GENERATED_DIRECTORIES: ReadonlySet<string> = new Set(['.git','node_modules','dist','out','build','target','.next','coverage','.venv','__pycache__','.cache','.pytest_cache','.mypy_cache','.ruff_cache','.tox']);
export function projectFile(root: string, file: string, deny = ''): string {
	const base = fs.realpathSync(root), target = fs.realpathSync(path.resolve(base, file));
	const relative = path.relative(base, target);
	if (process.platform === 'win32' && /[:\x00-\x1f]/.test(relative)) throw new Error('Alternate streams and device paths are not project files.');
	if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || compileDeny(deny)(relative)) throw new Error('Choose an allowed file inside this project.');
	return target;
}

export async function projectFingerprint(root: string, deny = '', signal?: AbortSignal): Promise<string> {
	const base = fs.realpathSync(root), blocked = compileDeny(deny), hash = createHash('sha256');
	let files = 0, bytes = 0;
	const walk = async (dir: string): Promise<void> => {
		for (const entry of fs.readdirSync(dir, { withFileTypes:true }).sort((a,b) => a.name.localeCompare(b.name))) {
			signal?.throwIfAborted();
			const file = path.join(dir, entry.name), relative = path.relative(base, file).replace(/\\/g,'/');
			if (blocked(relative) || entry.isSymbolicLink() || entry.isDirectory() && PROJECT_GENERATED_DIRECTORIES.has(entry.name)) continue;
			if (entry.isDirectory()) { await walk(file); continue; }
			if (!entry.isFile()) continue;
			if (++files > 50000 || (bytes += fs.statSync(file).size) > 512 * 1024 * 1024) throw new Error('Project snapshot exceeds 50,000 files or 512 MiB. Exclude generated content using deny paths.');
			hash.update(relative + '\0');
			const content = createHash('sha256');
			for await (const chunk of fs.createReadStream(file, { signal })) content.update(chunk);
			hash.update(content.digest());
		}
	};
	await walk(base);
	return hash.digest('hex');
}

function packageData(root: string, deny: string): Record<string, any> | undefined {
	try {
		const file = projectFile(root, 'package.json', deny);
		if (fs.statSync(file).size > 1024 * 1024) throw new Error('package.json is too large.');
		return JSON.parse(fs.readFileSync(file,'utf8'));
	} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export function verificationStages(root: string, deny = ''): CheckStage[] {
	const pkg = packageData(root, deny);
	if (pkg) {
		// Commands reference fixed script names. Project-supplied script bodies never become shell arguments here.
		const manager = /^pnpm@/.test(pkg.packageManager ?? '') ? 'pnpm' : /^yarn@/.test(pkg.packageManager ?? '') ? 'yarn' : 'npm';
		return ['typecheck','check','lint','test','build'].filter(name => typeof pkg.scripts?.[name] === 'string' && !/no test specified/i.test(pkg.scripts[name])).map(name => ({ name, command:`${manager} run ${name}` }));
	}
	const has = (file: string) => { try { return !!projectFile(root,file,deny); } catch { return false; } };
	if (has('Cargo.toml')) return [{name:'typecheck',command:'cargo check'},{name:'test',command:'cargo test'}];
	if (has('go.mod')) return [{name:'test',command:'go test ./...'},{name:'lint',command:'go vet ./...'}];
	if (has('pyproject.toml') || has('pytest.ini')) return [{name:'test',command:'python -m pytest'}];
	return [];
}

export async function createProjectPlan(root: string, kind: CheckKind, deny = '', signal?: AbortSignal): Promise<ProjectPlan> {
	const base = fs.realpathSync(root);
	let stages: CheckStage[];
	if (kind === 'audit') {
		if (!packageData(base,deny)) throw new Error('Dependency audit currently supports npm projects with package.json.');
		projectFile(base,'package-lock.json',deny);
		stages = [{name:'npm audit',command:'npm audit --json --ignore-scripts'}];
	} else stages = verificationStages(base,deny);
	if (!stages.length) throw new Error('No supported verification stages found. Add project check, lint, test or build scripts.');
	return {id:randomUUID(),kind,root:base,createdAt:Date.now(),fingerprint:await projectFingerprint(base,deny,signal),stages,scope:'Project files, excluding dependency/generated folders, symbolic links and deny paths.'};
}

export function auditFindings(output: string, lock?: Record<string,any>): NonNullable<StageResult['findings']> {
	const start = output.indexOf('{'), end = output.lastIndexOf('}');
	if (start < 0 || end < start) throw new Error('The audit did not return a JSON report.');
	const data = JSON.parse(output.slice(start,end+1));
	if (data.error || !data.vulnerabilities || typeof data.vulnerabilities !== 'object') throw new Error(data.error?.summary || 'Unsupported audit report.');
	return Object.entries(data.vulnerabilities).slice(0,1000).map(([name, raw]) => {
		const item = raw as Record<string, unknown>;
		const nodes = Array.isArray(item.nodes) ? item.nodes.slice(0,100) : [];
		const versions = [...new Set([...nodes.map(node => typeof node === 'string' ? lock?.packages?.[node]?.version : undefined),lock?.dependencies?.[name]?.version].filter((version): version is string => typeof version === 'string'))].slice(0,5);
		return {name:name.slice(0,256),severity:String(item.severity || 'unknown').slice(0,32),direct:item.isDirect === true,fixAvailable:!!item.fixAvailable,versions:versions.map(version => version.slice(0,64))};
	});
}

export async function runProjectPlan(plan: ProjectPlan, ctx: CommandContext, update: (report: ProjectReport) => void, deny = ''): Promise<ProjectReport> {
	const release = acquireProjectCheck(plan.root);
	try { return await executeProjectPlan(plan,ctx,update,deny); } finally { release(); }
}

async function executeProjectPlan(plan: ProjectPlan, ctx: CommandContext, update: (report: ProjectReport) => void, deny = ''): Promise<ProjectReport> {
	if (plan.configuration && plan.configuration !== checkConfiguration(ctx.settings)) throw new Error('Execution settings changed after preview. Review a fresh plan.');
	if (Date.now() - plan.createdAt > 5 * 60_000) throw new Error('This plan expired. Preview the current project again.');
	if (await projectFingerprint(plan.root,deny,ctx.signal) !== plan.fingerprint) throw new Error('Project files changed after preview. Review a fresh plan.');
	const report: ProjectReport = {id:plan.id,kind:plan.kind,root:plan.root,fingerprint:plan.fingerprint,configuration:checkConfiguration(ctx.settings),startedAt:Date.now(),status:'running',stale:false,stages:[],scope:plan.scope};
	update(report);
	try {
		for (const stage of plan.stages) {
			ctx.signal.throwIfAborted();
			const started = Date.now();
			const approved = await approveCommand(stage.command,plan.root,plan.root,ctx);
			if (!approved.handle.approved) throw Object.assign(new Error('Project check was declined.'),{name:'AbortError'});
			const result = await executeCommand(stage.command,approved,120_000,ctx.signal);
			let findings: StageResult['findings'];
			let status: StageResult['status'] = result.code === 0 && !result.timedOut ? 'passed' : 'failed';
			if (plan.kind === 'audit' && !result.timedOut) {
				const lockFile = projectFile(plan.root,'package-lock.json',deny);
				if (fs.statSync(lockFile).size > 16*1024*1024) throw new Error('Audit lockfile exceeds 16 MiB.');
				findings = auditFindings(result.out,JSON.parse(fs.readFileSync(lockFile,'utf8')));
				status = findings.length ? 'findings' : result.code === 0 ? 'passed' : 'failed';
			}
			report.stages.push({...stage,status,code:result.code,output:redactSecrets(result.out).text.slice(-64000),durationMs:Date.now()-started,findings});
			update(report);
			if (status === 'failed') break;
		}
		report.status = report.stages.some(s => s.status === 'failed' || s.status === 'findings') ? 'failed' : 'passed';
	} catch (error) {
		report.status = ctx.signal.aborted || (error as Error).name === 'AbortError' ? 'cancelled' : 'failed';
		report.stages.push({name:'Run',command:'',status:report.status === 'cancelled' ? 'cancelled' : 'failed',output:redactSecrets(String((error as Error).message)).text,durationMs:0});
	} finally {
		report.finishedAt = Date.now();
		try { report.stale = await projectFingerprint(plan.root,deny,ctx.signal.aborted ? undefined : ctx.signal) !== plan.fingerprint; } catch { report.stale = true; }
		update(report);
	}
	return report;
}
