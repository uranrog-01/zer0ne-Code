import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { newId } from '../providerStore';
import { isDesktopHost } from './capabilities';
import { HostContext, HostFeature, HostSurface } from './context';

/**
 * Cloud tasks — our free take on "Claude Code on the web": the agent runs in
 * a GitHub Actions VM (free on public repos, 2,000 min/month on private) on
 * its own branch, pushes it and opens a pull request, while you keep working.
 *
 *   setup     .github/workflows/zer0ne-cloud.yml + .zer0ne/cloud/runner.mjs
 *             (media/cloud/*) and the ZER0NE_API_KEY repository secret
 *   start     workflow_dispatch with the task and the chat's model
 *   follow    run status + steps; when it ends, the job log gives the
 *             summary and every tool step (ZER0NE_STEP lines)
 *   continue  a follow-up runs on the same branch
 *   teleport  fetch + check out the branch and open the result as a chat
 *
 * GitHub access uses VS Code's built-in GitHub sign-in (no token to paste); the desktop
 * app asks for a token once and keeps it in the OS key store, and both use the gh CLI
 * when it is signed in.
 */

const WORKFLOW = 'zer0ne-cloud.yml';
const TASKS_KEY = 'zer0ne.cloudTasks';
const API = 'https://api.github.com';

/**
 * The default cloud setup script. It is only ever pushed to the repository when the local file
 * still matches this text — a setup.sh that was edited (by the user, or by whoever wrote the
 * repository) is left alone rather than uploaded and run with the user's API key.
 */
const DEFAULT_SETUP_SH = '#!/usr/bin/env bash\n# Runs in the cloud VM before the agent starts: install what your project needs.\n# e.g.  npm ci   |   pip install -r requirements.txt\nif [ -f package-lock.json ]; then npm ci --no-audit --no-fund || true; fi\n';

export interface CloudTask {
	id: string;
	repo: string;
	task: string;
	branch: string;
	baseRef: string;
	model: string;
	provider: string;
	createdAt: number;
	runId?: number;
	runUrl?: string;
	status: 'dispatching' | 'queued' | 'in_progress' | 'completed' | 'failed';
	conclusion?: string;
	steps?: Array<{ tool: string; arg: string; ok: boolean; note?: string }>;
	summary?: string;
	result?: string;
	prUrl?: string;
	jobSteps?: Array<{ name: string; status: string; conclusion?: string | null }>;
	followUps?: number;
	/** When the latest run was dispatched (matches the run, also for follow-ups). */
	dispatchedAt?: number;
}

/** Provider format + base URL → what the runner speaks (openai | anthropic), or why it can't. */
export function cloudEndpoint(format: string, baseUrl: string): { format: 'openai' | 'anthropic'; baseUrl: string } | { error: string } {
	const base = baseUrl.replace(/\/+$/, '');
	if (format === 'anthropic') return { format: 'anthropic', baseUrl: base };
	if (format === 'gemini') return { format: 'openai', baseUrl: base.replace(/\/openai$/, '') + '/openai' };
	if (format === 'openai') return { format: 'openai', baseUrl: base };
	return { error: format === 'vscode-lm' ? 'GitHub Copilot models only run inside VS Code — pick an API provider for cloud tasks.' : `${format === 'responses' ? 'Responses API' : format} providers are not supported in the cloud runner yet — choose a hosted Chat Completions, Anthropic or Gemini API provider, then select its model in the chat.` };
}

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 400))) : resolve(String(out).trim())))
	);
}

/** "https://github.com/o/r(.git)" or "git@github.com:o/r.git" → "o/r". */
export function parseGithubRemote(url: string): string | undefined {
	const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
	return m ? `${m[1]}/${m[2]}` : undefined;
}

/** Job log → { steps, summary, result } using the runner's log protocol. */
export function parseRunLog(log: string): { steps: CloudTask['steps']; summary?: string; result?: string } {
	const steps: NonNullable<CloudTask['steps']> = [];
	let summary: string | undefined;
	let result: string | undefined;
	const lines = log.split(/\r?\n/).map((l) => l.replace(/^\S+Z\s/, ''));
	let inSummary = false;
	const buf: string[] = [];
	for (const l of lines) {
		if (l.startsWith('ZER0NE_STEP ')) {
			try {
				steps.push(JSON.parse(l.slice(12)));
			} catch {
				// partial line
			}
		} else if (l.startsWith('ZER0NE_SUMMARY_BEGIN')) {
			inSummary = true;
		} else if (l.startsWith('ZER0NE_SUMMARY_END')) {
			inSummary = false;
			summary = buf.join('\n').trim();
		} else if (inSummary) {
			buf.push(l);
		} else if (l.startsWith('ZER0NE_RESULT ')) {
			result = l.slice(14).trim();
		}
	}
	return { steps, summary, result };
}

export class CloudHost implements HostFeature {
	private poll?: NodeJS.Timeout;

	constructor(
		private readonly ctx: HostContext,
		private readonly memento: vscode.Memento,
		private readonly extensionPath: string,
		private readonly openSession: (id: string) => Promise<void>,
		private readonly secrets?: vscode.SecretStorage
	) {
		// Tasks still running when the project opens are followed without opening the page (the notch and bell show them).
		if (this.tasks.some((t) => t.status !== 'completed' && t.status !== 'failed')) this.schedulePoll(4000);
	}

	/** Live progress of "Set up everything" for the page. */
	private progress(surface: HostSurface | undefined, step: string, state: 'run' | 'ok' | 'err' | 'skip', note = ''): void {
		(surface ? surface.post.bind(surface) : this.ctx.postAll.bind(this.ctx))({ type: 'cloudProgress', step, state, note });
	}

	/** The gh CLI's token, if gh is installed and signed in (fast, no dialog). */
	private ghCliToken(): Promise<string | undefined> {
		return new Promise((resolve) =>
			execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 8000 }, (err, out) => resolve(!err && /^gh[opsu]_|^github_pat_/.test(String(out).trim()) ? String(out).trim() : undefined))
		);
	}

	private async loginOf(token: string): Promise<string> {
		try {
			const r = await fetch(API + '/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'zer0ne-coding' }, signal: AbortSignal.timeout(15_000) });
			if (r.ok) return String(((await r.json()) as { login?: string }).login ?? 'github');
			if (r.status === 401) throw new Error('That GitHub token is not valid (401).');
		} catch (e) {
			if (e instanceof Error && /401/.test(e.message)) throw e;
		}
		return 'github';
	}

	dispose(): void {
		if (this.poll) {
			clearTimeout(this.poll);
		}
	}

	private get tasks(): CloudTask[] {
		return this.memento.get<CloudTask[]>(TASKS_KEY, []);
	}
	private async save(list: CloudTask[]): Promise<void> {
		await this.memento.update(TASKS_KEY, list.slice(0, 60));
	}
	private async patch(id: string, patch: Partial<CloudTask>): Promise<CloudTask | undefined> {
		const list = this.tasks;
		const i = list.findIndex((t) => t.id === id);
		if (i < 0) {
			return undefined;
		}
		list[i] = { ...list[i], ...patch };
		await this.save(list);
		return list[i];
	}

	private tokenCache?: { token: string; login: string; via: string };

	/**
	 * GitHub access, fastest first: a token you pasted (OS keychain) → the gh CLI's
	 * token → VS Code's GitHub account (silent) → VS Code sign-in (interactive, with
	 * a timeout so the page never hangs on a hidden consent prompt).
	 */
	private async token(create: boolean): Promise<{ token: string; login: string; via?: string } | undefined> {
		if (this.tokenCache) return this.tokenCache;
		const pat = await this.secrets?.get('zer0ne.cloud.githubToken');
		if (pat) return (this.tokenCache = { token: pat, login: await this.loginOf(pat).catch(() => 'token'), via: 'token' });
		const gh = await this.ghCliToken();
		if (gh) return (this.tokenCache = { token: gh, login: await this.loginOf(gh).catch(() => 'gh'), via: 'gh CLI' });
		const silent = await vscode.authentication.getSession('github', ['repo', 'workflow'], { silent: true }).then(undefined, () => undefined);
		const host = isDesktopHost() ? 'zer0ne' : 'VS Code';
		if (silent) return (this.tokenCache = { token: silent.accessToken, login: silent.account.label, via: host });
		if (!create) return undefined;
		const session = await Promise.race([
			vscode.authentication.getSession('github', ['repo', 'workflow'], { createIfNone: true }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(isDesktopHost() ? 'GitHub sign-in did not finish within 2 minutes. Use "Paste a token" or sign in to the gh CLI instead.' : 'GitHub sign-in did not finish within 2 minutes. Finish it in the browser window VS Code opened (or the Accounts menu at the bottom left), or use "Paste a token" / the gh CLI instead.')), 120_000))
		]);
		return (this.tokenCache = { token: session.accessToken, login: session.account.label, via: host });
	}

	private async gh(method: string, url: string, body?: unknown, accept = 'application/vnd.github+json'): Promise<Response> {
		const auth = await this.token(false);
		if (!auth) {
			throw new Error('Sign in to GitHub first (Settings → Cloud tasks).');
		}
		return fetch(url.startsWith('http') ? url : API + url, {
			method,
			headers: { Authorization: `Bearer ${auth.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'zer0ne-coding', ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(20_000)
		});
	}
	private async ghJson<T>(method: string, url: string, body?: unknown): Promise<T> {
		const res = await this.gh(method, url, body);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			let msg = text;
			try {
				msg = JSON.parse(text).message ?? text;
			} catch {
				// raw
			}
			throw new Error(`GitHub ${res.status}: ${String(msg).slice(0, 240)}`);
		}
		return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
	}

	private root(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	/** Everything the Cloud page shows: sign-in, repo, setup checks, the chat model, tasks. */
	private async status(surface: HostSurface, deep: boolean): Promise<void> {
		const root = this.root();
		const auth = await this.token(false).catch(() => undefined);
		let repo: string | undefined;
		let branch: string | undefined;
		let dirty = false;
		let localFiles = false;
		if (root) {
			try {
				repo = parseGithubRemote(await git(root, ['remote', 'get-url', 'origin']));
				branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
				dirty = !!(await git(root, ['status', '--porcelain']));
			} catch {
				// not a git repository
			}
			localFiles = fs.existsSync(path.join(root, '.github', 'workflows', WORKFLOW)) && fs.existsSync(path.join(root, '.zer0ne', 'cloud', 'runner.mjs'));
		}
		let remoteWorkflow: boolean | undefined;
		let secret: boolean | undefined;
		let visibility: string | undefined;
		let defaultBranch: string | undefined;
		let branchPushed: boolean | undefined;
		if (deep && auth && repo) {
			try {
				const info = await this.ghJson<{ private: boolean; default_branch: string }>('GET', `/repos/${repo}`);
				visibility = info.private ? 'private' : 'public';
				defaultBranch = info.default_branch;
				// workflow_dispatch only runs workflows that exist on the default branch.
				const workflow = await this.gh('GET', `/repos/${repo}/contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(info.default_branch)}`);
				remoteWorkflow = workflow.ok ? true : workflow.status === 404 ? false : undefined;
				branchPushed = branch && branch !== 'HEAD' ? (await this.gh('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`)).ok : undefined;
				const s = await this.gh('GET', `/repos/${repo}/actions/secrets/ZER0NE_API_KEY`);
				secret = s.ok ? true : s.status === 404 ? false : undefined;
			} catch {
				// offline / no access
			}
		}
		const sel = await this.chatModel();
		// Undefined is dropped by the desktop JSON transport; null clears a previous deep check.
		surface.post({
			type: 'cloudStatus',
			data: { signedIn: !!auth, login: auth?.login, via: auth?.via, repo: repo ?? null, workspacePath: root ?? null, branch, dirty, localFiles, ...(deep ? { remoteWorkflow: remoteWorkflow ?? null, secret: secret ?? null, visibility: visibility ?? null, defaultBranch: defaultBranch ?? null, branchPushed: branchPushed ?? null } : {}), model: sel ? { provider: sel.provider, model: sel.model, local: sel.local, unsupported: 'error' in cloudEndpoint(sel.format, sel.baseUrl) ? (cloudEndpoint(sel.format, sel.baseUrl) as { error: string }).error : undefined } : null, ghCli: await this.hasGhCli(), tasks: this.tasks }
		});
	}

	private async chatModel(): Promise<{ provider: string; model: string; baseUrl: string; format: string; local: boolean } | undefined> {
		const pid = await this.ctx.store.getSelectedProviderId();
		const mid = await this.ctx.store.getSelectedModel();
		const p = pid ? await this.ctx.store.get(pid) : undefined;
		if (!p || !mid) {
			return undefined;
		}
		return { provider: p.name, model: mid, baseUrl: p.baseUrl, format: p.apiFormat, local: /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(p.baseUrl) || p.apiFormat === 'vscode-lm' };
	}

	private hasGhCli(): Promise<boolean> {
		return new Promise((resolve) => execFile('gh', ['--version'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err)));
	}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: unknown }): Promise<boolean> {
		switch (msg.type) {
			case 'cloudStatus':
				await this.status(surface, msg.deep !== false);
				this.schedulePoll();
				return true;
			case 'cloudSignIn':
				this.progress(surface, 'signin', 'run', 'Waiting for GitHub — approve in the browser window');
				try {
					await this.token(true);
					this.progress(surface, 'signin', 'ok');
				} catch (e) {
					this.progress(surface, 'signin', 'err', e instanceof Error ? e.message : String(e));
					throw e;
				}
				await this.status(surface, true);
				return true;
			case 'cloudToken': {
				const token = String(msg.token ?? '').trim();
				if (!token) {
					await this.secrets?.delete('zer0ne.cloud.githubToken');
					this.tokenCache = undefined;
					this.ctx.status('GitHub token removed.');
				} else {
					const login = await this.loginOf(token);
					await this.secrets?.store('zer0ne.cloud.githubToken', token);
					this.tokenCache = { token, login, via: 'token' };
					this.ctx.status(`GitHub token saved in the OS keychain — signed in as ${login}.`, 'ok');
				}
				await this.status(surface, true);
				return true;
			}
			case 'cloudSignOut':
				this.tokenCache = undefined;
				await this.secrets?.delete('zer0ne.cloud.githubToken');
				await this.status(surface, true);
				return true;
			case 'cloudSetup':
				await this.setup(surface);
				return true;
			case 'cloudPushSetup':
				await this.pushSetup(surface);
				return true;
			case 'cloudAutoSetup':
				await this.autoSetup(surface);
				return true;
			case 'cloudSecret':
				await this.setSecret(surface);
				return true;
			case 'cloudStart':
				await this.start(surface, String(msg.task ?? ''), msg.openPr !== false);
				return true;
			case 'cloudFollowUp':
				await this.followUp(surface, String(msg.id), String(msg.text ?? ''));
				return true;
			case 'cloudCancel': {
				const t = this.tasks.find((x) => x.id === msg.id);
				if (t?.runId) {
					await this.ghJson('POST', `/repos/${t.repo}/actions/runs/${t.runId}/cancel`).catch((e) => this.ctx.status(String(e.message ?? e), 'error'));
				}
				await this.refresh(true);
				await this.status(surface, false);
				return true;
			}
			case 'cloudRemove':
				await this.save(this.tasks.filter((t) => t.id !== msg.id));
				await this.status(surface, false);
				return true;
			case 'cloudTeleport':
				await this.teleport(surface, String(msg.id));
				return true;
			case 'cloudRefresh':
				await this.refresh(true);
				await this.status(surface, true);
				return true;
		}
		return false;
	}

	/** Write the workflow and the runner into the workspace (the user commits them). */
	private async setup(surface: HostSurface, quiet = false): Promise<void> {
		const root = this.root();
		if (!root) {
			throw new Error('Open a folder first.');
		}
		const wf = path.join(root, '.github', 'workflows', WORKFLOW);
		const runner = path.join(root, '.zer0ne', 'cloud', 'runner.mjs');
		fs.mkdirSync(path.dirname(wf), { recursive: true });
		fs.mkdirSync(path.dirname(runner), { recursive: true });
		// Always restore our own copies: a repository can ship files at these paths, and that copy
		// would otherwise be pushed to the default branch and run with the user's API key.
		fs.copyFileSync(path.join(this.extensionPath, 'media', 'cloud', 'workflow.yml'), wf);
		fs.copyFileSync(path.join(this.extensionPath, 'media', 'cloud', 'runner.mjs'), runner);
		const setupSh = path.join(root, '.zer0ne', 'cloud', 'setup.sh');
		if (!fs.existsSync(setupSh)) {
			fs.writeFileSync(setupSh, DEFAULT_SETUP_SH);
		}
		if (!quiet) {
			this.ctx.status('Cloud task files added: .github/workflows/zer0ne-cloud.yml and .zer0ne/cloud/. Press "Commit to GitHub" to enable cloud tasks.');
			await this.status(surface, true);
		}
	}

	/**
	 * Put the setup files on the repository's default branch through the GitHub
	 * contents API — GitHub only dispatches workflows that live there, whatever
	 * branch you work on locally. One commit per file; unchanged files are skipped.
	 * (The user clicked the button and confirmed it in the UI.)
	 */
	private async pushSetup(surface: HostSurface): Promise<void> {
		const root = this.root();
		if (!root) {
			throw new Error('Open a folder first.');
		}
		const repo = parseGithubRemote(await git(root, ['remote', 'get-url', 'origin']).catch(() => ''));
		if (!repo) {
			throw new Error('This folder has no GitHub remote (origin).');
		}
		// Always restore our own workflow and runner before pushing: a repository can ship a file
		// at these paths, and that copy would otherwise be uploaded to the default branch and run
		// with the user's API key. setup.sh is only pushed when it is still our untouched default.
		await this.setup(surface, true);
		const info = await this.ghJson<{ default_branch: string }>('GET', `/repos/${repo}`);
		const branch = info.default_branch;
		let changed = 0;
		const skipped: string[] = [];
		for (const file of ['.github/workflows/' + WORKFLOW, '.zer0ne/cloud/runner.mjs', '.zer0ne/cloud/setup.sh']) {
			const local = fs.readFileSync(path.join(root, ...file.split('/')));
			if (file.endsWith('setup.sh') && local.toString('utf8') !== DEFAULT_SETUP_SH) {
				skipped.push(file);
				continue;
			}
			const current = await this.gh('GET', `/repos/${repo}/contents/${file}?ref=${encodeURIComponent(branch)}`);
			const existing = current.ok ? ((await current.json()) as { sha: string; content?: string }) : undefined;
			if (existing?.content && Buffer.from(existing.content, 'base64').equals(local)) {
				continue;
			}
			await this.ghJson('PUT', `/repos/${repo}/contents/${file}`, { message: `Add zer0ne cloud tasks (${path.posix.basename(file)})`, content: local.toString('base64'), branch, ...(existing ? { sha: existing.sha } : {}) });
			changed++;
		}
		if (skipped.length) {
			this.ctx.status(`${skipped.join(', ')} was edited, so it was not uploaded. Review it and commit it yourself if it is what you want to run.`, 'warn');
		}
		this.ctx.status(changed ? `Cloud task setup committed to ${repo}@${branch} (${changed} file${changed > 1 ? 's' : ''}). Pull to get it locally.` : `The setup is already on ${repo}@${branch}.`, 'ok');
		await this.status(surface, true);
	}

	/** One button: sign in → files → upload to the default branch → API key secret — with live progress. */
	private async autoSetup(surface: HostSurface): Promise<void> {
		const step = async (id: string, note: string, fn: () => Promise<string | void>) => {
			this.progress(surface, id, 'run', note);
			try {
				const done = await fn();
				this.progress(surface, id, 'ok', done || '');
			} catch (e) {
				this.progress(surface, id, 'err', e instanceof Error ? e.message : String(e));
				throw e;
			}
		};
		const root = this.root();
		if (!root) {
			throw new Error('Open a folder first.');
		}
		await step('signin', 'Signing in to GitHub…', async () => {
			const t = await this.token(true);
			return t ? `${t.login} · via ${t.via ?? 'GitHub'}` : '';
		});
		await step('files', 'Adding the workflow and runner…', async () => {
			if (!fs.existsSync(path.join(root, '.github', 'workflows', WORKFLOW))) await this.setup(surface, true);
			return '.github/workflows/zer0ne-cloud.yml';
		});
		await step('push', 'Committing to the default branch on GitHub…', async () => {
			await this.pushSetup(surface);
		});
		await step('secret', 'Saving your API key as a repository secret…', async () => {
			const repo = parseGithubRemote(await git(root, ['remote', 'get-url', 'origin']).catch(() => ''));
			const s = repo ? await this.gh('GET', `/repos/${repo}/actions/secrets/ZER0NE_API_KEY`) : undefined;
			if (s?.ok) return 'already set';
			await this.setSecret(surface);
			return (await this.hasGhCli()) ? 'saved with gh' : 'finish on the GitHub page that opened';
		});
		await this.status(surface, true);
	}

	/** ZER0NE_API_KEY via the gh CLI (it encrypts the secret); otherwise open GitHub's secrets page. */
	private async setSecret(surface: HostSurface): Promise<void> {
		const st = await this.chatModel();
		const pid = await this.ctx.store.getSelectedProviderId();
		const root = this.root();
		const repo = root ? parseGithubRemote(await git(root, ['remote', 'get-url', 'origin']).catch(() => '')) : undefined;
		if (!repo) {
			throw new Error('This folder has no GitHub remote.');
		}
		// An account sign-in's access token is renewable and grants the whole
		// account. A repository secret is read by every workflow run and by
		// everyone with repository access: never store one there.
		if (pid && (await this.ctx.store.isAccountCredential(pid))) {
			throw new Error('This provider is signed in as an account. Its access token is not a static API key and must not be stored as a repository secret — add a separate API key as ZER0NE_API_KEY.');
		}
		const key = pid ? await this.ctx.store.getApiKey(pid) : undefined;
		if (key && (await this.hasGhCli())) {
			await new Promise<void>((resolve, reject) => {
				const child = execFile('gh', ['secret', 'set', 'ZER0NE_API_KEY', '--repo', repo], { windowsHide: true, timeout: 30_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 300))) : resolve()));
				child.stdin?.end(key);
			});
			this.ctx.status(`Saved the ${st?.provider ?? 'provider'} API key as the ZER0NE_API_KEY secret of ${repo}.`);
		} else {
			await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${repo}/settings/secrets/actions/new`));
			this.ctx.status('Add a repository secret named ZER0NE_API_KEY with your provider API key, then press Check again.', '');
		}
		await this.status(surface, true);
	}

	private async start(surface: HostSurface, task: string, openPr: boolean): Promise<void> {
		if (!task.trim()) {
			throw new Error('Describe the task first.');
		}
		const root = this.root();
		const repo = root ? parseGithubRemote(await git(root, ['remote', 'get-url', 'origin']).catch(() => '')) : undefined;
		if (!repo) {
			throw new Error('Cloud tasks need a folder with a GitHub remote (origin).');
		}
		const sel = await this.chatModel();
		if (!sel) {
			throw new Error('Pick a model in the chat first — the cloud task uses it.');
		}
		if (sel.local) {
			throw new Error(`${sel.provider} runs on this computer; the cloud VM cannot reach it. Pick a hosted provider for cloud tasks.`);
		}
		const ep = cloudEndpoint(sel.format, sel.baseUrl);
		if ('error' in ep) {
			throw new Error(ep.error);
		}
		let branch = await git(root!, ['rev-parse', '--abbrev-ref', 'HEAD']);
		// The VM checks out a branch that exists on GitHub; an unpushed branch starts from the default one.
		const onGithub = branch !== 'HEAD' && (await this.gh('GET', `/repos/${repo}/branches/${encodeURIComponent(branch)}`).then((r) => r.ok, () => false));
		if (!onGithub) {
			const info = await this.ghJson<{ default_branch: string }>('GET', `/repos/${repo}`);
			this.ctx.status(`Branch ${branch} is not on GitHub — the cloud task starts from ${info.default_branch}. Push your branch to start from it.`, '');
			branch = info.default_branch;
		}
		const ahead = await git(root!, ['rev-list', '--count', `@{u}..HEAD`]).catch(() => '0');
		if (Number(ahead) > 0) {
			this.ctx.status(`Note: ${ahead} local commit(s) are not pushed — the cloud VM starts from ${branch} on GitHub.`, '');
		}
		const id = newId('c').slice(0, 12);
		const t: CloudTask = { id, repo, task, branch: `zer0ne/${id}`, baseRef: branch, model: sel.model, provider: sel.provider, createdAt: Date.now(), status: 'dispatching' };
		await this.save([t, ...this.tasks]);
		await this.status(surface, false);
		try {
			await this.dispatch(t, task, '', openPr);
			await this.patch(id, { status: 'queued' });
			this.ctx.status('Cloud task started on GitHub Actions.');
		} catch (e) {
			await this.patch(id, { status: 'failed', conclusion: e instanceof Error ? e.message : String(e) });
			throw e;
		}
		await this.status(surface, false);
		this.schedulePoll(4000);
	}

	private async dispatch(t: CloudTask, task: string, branch: string, openPr: boolean): Promise<void> {
		const sel = await this.chatModel();
		const ep = sel ? cloudEndpoint(sel.format, sel.baseUrl) : { error: 'Pick a model in the chat first.' };
		if ('error' in ep) {
			throw new Error(ep.error);
		}
		await this.patch(t.id, { dispatchedAt: Date.now() });
		try {
			// Workflow inputs travel as strings (booleans included).
			await this.ghJson('POST', `/repos/${t.repo}/actions/workflows/${WORKFLOW}/dispatches`, {
				ref: t.baseRef,
				inputs: { task: task.slice(0, 60_000), session: t.id, model: t.model, base_url: ep.baseUrl, api_format: ep.format, branch, open_pr: openPr ? 'true' : 'false' }
			});
		} catch (e) {
			const m = e instanceof Error ? e.message : String(e);
			if (/GitHub 404/.test(m)) throw new Error(`GitHub can't find the zer0ne workflow on ${t.repo}'s default branch — press "Set up everything" (or "Commit to GitHub") first.`);
			if (/GitHub 422/.test(m) && /ref/i.test(m)) throw new Error(`Branch ${t.baseRef} is not on GitHub — push it, or switch to the default branch.`);
			if (/GitHub 403/.test(m)) throw new Error('GitHub refused (403): Actions may be disabled for this repository, or your account lacks write access.');
			throw e;
		}
	}

	private async followUp(surface: HostSurface, id: string, text: string): Promise<void> {
		const t = this.tasks.find((x) => x.id === id);
		if (!t || !text.trim()) {
			return;
		}
		const pushed = /^pushed /.test(t.result ?? '');
		const task = `${text}\n\n(Context: this continues an earlier cloud task on this branch — "${t.task.slice(0, 300)}". Earlier summary: ${String(t.summary ?? '').slice(0, 1200)})`;
		await this.patch(id, { status: 'queued', conclusion: undefined, runId: undefined, runUrl: undefined, jobSteps: undefined, followUps: (t.followUps ?? 0) + 1, dispatchedAt: Date.now() });
		await this.dispatch(t, task, pushed ? t.branch : '', true);
		this.ctx.status('Follow-up sent to the cloud task.');
		await this.status(surface, false);
		this.schedulePoll(4000);
	}

	/** Update running tasks from GitHub; when a run ends, read its log for the steps and summary. */
	private async refresh(force = false): Promise<boolean> {
		let active = false;
		for (const t of this.tasks) {
			if (t.status === 'completed' || t.status === 'failed') {
				if (!force || t.prUrl || !/^pushed /.test(t.result ?? '')) {
					continue;
				}
			}
			try {
				if (!t.runId) {
					const runs = await this.ghJson<{ workflow_runs: Array<{ id: number; html_url: string; display_title: string; created_at: string }> }>('GET', `/repos/${t.repo}/actions/workflows/${WORKFLOW}/runs?per_page=15&event=workflow_dispatch`);
					// The newest run for this task that started after the latest dispatch (follow-ups reuse the id).
					const since = (t.dispatchedAt ?? t.createdAt) - 15_000;
					const run = runs.workflow_runs.find((r) => r.display_title.includes(t.id) && Date.parse(r.created_at) >= since);
					if (!run) {
						if (Date.now() - (t.dispatchedAt ?? t.createdAt) > 10 * 60_000) {
							await this.patch(t.id, { status: 'failed', conclusion: 'GitHub never started the run — check the Actions tab (Actions disabled, or no runner minutes left).' });
							continue;
						}
						active = true;
						continue;
					}
					await this.patch(t.id, { runId: run.id, runUrl: run.html_url });
					t.runId = run.id;
				}
				const run = await this.ghJson<{ status: string; conclusion: string | null; html_url: string }>('GET', `/repos/${t.repo}/actions/runs/${t.runId}`);
				const jobs = await this.ghJson<{ jobs: Array<{ id: number; steps?: Array<{ name: string; status: string; conclusion: string | null }> }> }>('GET', `/repos/${t.repo}/actions/runs/${t.runId}/jobs`);
				const job = jobs.jobs[0];
				const patch: Partial<CloudTask> = { runUrl: run.html_url, jobSteps: job?.steps?.map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion })) };
				if (run.status === 'completed') {
					patch.status = run.conclusion === 'success' ? 'completed' : 'failed';
					patch.conclusion = run.conclusion ?? undefined;
					if (job) {
						const log = await this.gh('GET', `/repos/${t.repo}/actions/jobs/${job.id}/logs`);
						if (log.ok) {
							const parsed = parseRunLog(await log.text());
							Object.assign(patch, { steps: parsed.steps, summary: parsed.summary, result: parsed.result });
						}
					}
					const pr = await this.ghJson<Array<{ html_url: string }>>('GET', `/repos/${t.repo}/pulls?head=${encodeURIComponent(t.repo.split('/')[0] + ':' + t.branch)}&state=all`).catch(() => []);
					if (pr[0]) {
						patch.prUrl = pr[0].html_url;
					}
				} else {
					patch.status = run.status === 'queued' ? 'queued' : 'in_progress';
					active = true;
				}
				await this.patch(t.id, patch);
			} catch {
				active = active || t.status !== 'failed';
			}
		}
		return active;
	}

	private schedulePoll(ms = 15_000): void {
		if (this.poll) {
			clearTimeout(this.poll);
		}
		if (!this.tasks.some((t) => t.status !== 'completed' && t.status !== 'failed')) {
			return;
		}
		this.poll = setTimeout(async () => {
			this.poll = undefined;
			const more = await this.refresh().catch(() => true);
			this.ctx.postAll({ type: 'cloudTasks', tasks: this.tasks });
			if (more) {
				this.schedulePoll();
			}
		}, ms);
	}

	/** Bring a finished cloud task home: check out its branch and open the result as a chat. */
	private async teleport(surface: HostSurface, id: string): Promise<void> {
		const t = this.tasks.find((x) => x.id === id);
		const root = this.root();
		if (!t || !root) {
			return;
		}
		if (/^pushed /.test(t.result ?? '')) {
			if (await git(root, ['status', '--porcelain'])) {
				throw new Error('You have uncommitted changes — commit or stash them before teleporting.');
			}
			await git(root, ['fetch', 'origin', t.branch]);
			await git(root, ['checkout', '-B', t.branch, `origin/${t.branch}`]);
		}
		const session = await this.ctx.store.createSession();
		const steps = (t.steps ?? []).map((s) => `- ${s.ok ? '✓' : '✗'} \`${s.tool}\` ${s.arg}`).join('\n');
		await this.ctx.store.saveMessages(session.id, [
			{ id: newId('m'), role: 'user', content: `☁ Cloud task: ${t.task}` },
			{
				id: newId('m'),
				role: 'assistant',
				content:
					`**Cloud run ${t.conclusion ?? t.status}** on \`${t.repo}\` · ${t.model}` +
					(/^pushed /.test(t.result ?? '') ? ` — branch \`${t.branch}\` is checked out here.` : ' — no file changes.') +
					`\n\n${t.summary ?? '_No summary._'}` +
					(steps ? `\n\n<details><summary>${t.steps!.length} steps</summary>\n\n${steps}\n\n</details>` : '') +
					(t.prUrl ? `\n\nPull request: ${t.prUrl}` : '') +
					'\n\nAsk a follow-up here to keep working on it locally.',
				model: t.model
			}
		]);
		await this.openSession(session.id);
		this.ctx.status(`Teleported "${t.task.slice(0, 40)}" to this workspace.`);
		await this.status(surface, false);
	}
}
