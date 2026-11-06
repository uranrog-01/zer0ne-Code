import { execFile, spawn } from 'child_process';
import { AcpClientHandlers, AcpError, AcpSessionInfo, applyPlanScope, authUrlIn, planModels, sessionModels } from './client';
import type { AcpAgentEntry, AcpPlanMeta } from './registry';
import { AcpRuntime, which } from './runtime';
import { loginTerminalSpec } from '../host/loginTerminal';
import { AgentOutputLines } from './verification';

/**
 * Signing in to an agent's plan (Claude Pro/Max, Antigravity, Gemini,
 * OpenCode…). The vendor's own software does the login: the agent's ACP
 * "Agent Auth" (it runs the OAuth flow and opens the browser), the vendor's
 * command-line login (`claude auth login`), or an interactive terminal login.
 * zer0ne shows the sign-in link, passes a pasted code along, checks the
 * result — and never sees a token. No vscode dependency (the host supplies
 * `open` and `terminal`).
 */

export interface SignInIo {
	/** Explicit account reconnect: use the agent's advertised logout before its browser login. */
	reauthenticate?: boolean;
	open(url: string): void | boolean | PromiseLike<void | boolean>;
	/** A visible terminal for interactive (TUI) logins. */
	terminal(title: string, command: string, args: string[], env?: NodeJS.ProcessEnv): void | Promise<void>;
	event(e: { stage: string; [k: string]: unknown }): void;
	signal: AbortSignal;
	/** The user pasted the code the sign-in page showed (remote machines cannot use the local callback). */
	code(): Promise<string>;
}

export interface SignInResult {
	agent: string;
	models: import('./client').AcpModel[];
	current?: string;
	email?: string;
	plan?: string;
}

const LOGIN_TIMEOUT = 10 * 60_000;
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
	const finish = () => { clearTimeout(t); signal.removeEventListener('abort', finish); r(); };
	const t = setTimeout(finish, ms);
	signal.addEventListener('abort', finish, { once: true });
	if (signal.aborted) finish();
});

const aborted = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

async function openSignInPage(io: SignInIo, url: string): Promise<void> {
	if (io.signal.aborted) return;
	try { if (await io.open(url) !== false) return; } catch { /* The link and copy action still allow a manual browser handoff. */ }
	if (!io.signal.aborted) io.event({ stage: 'browser-launch-error', url, browserError: 'Your browser did not open. Use Open the page again or copy the link into your browser.' });
}

/** Run a command and read its JSON output (a `… auth status` style command). */
export function readStatus(cmd: { command: string; args: string[] }, env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<{ loggedIn: boolean; email?: string; plan?: string; authMethod?: string; apiKeySource?: string; apiProvider?: string } | undefined> {
	const file = which(cmd.command, env);
	if (!file) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const spec = /\.(cmd|bat)$/i.test(file) ? loginTerminalSpec(file, cmd.args, 'win32') : { command: file, args: cmd.args, verbatim: false };
		execFile(spec.command, spec.args, { env, cwd, timeout: 20_000, windowsHide: true, windowsVerbatimArguments: spec.verbatim }, (_e, out) => {
			try {
				const j = JSON.parse(String(out).trim());
				resolve({ loggedIn: j.loggedIn === true, email: typeof j.email === 'string' ? j.email : undefined, plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : typeof j.plan === 'string' ? j.plan : undefined, authMethod: typeof j.authMethod === 'string' ? j.authMethod : undefined, apiKeySource: typeof j.apiKeySource === 'string' ? j.apiKeySource : undefined, apiProvider: typeof j.apiProvider === 'string' ? j.apiProvider : undefined });
			} catch {
				resolve(undefined);
			}
		});
	});
}

/**
 * The vendor's own login command with piped output: it prints (and opens) the
 * sign-in link and may ask for a pasted code. Resolves when it exits 0.
 */
export function loginWithCommand(cmd: { command: string; args: string[] }, io: SignInIo, env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<void> {
	if (io.signal.aborted) return Promise.reject(aborted());
	const file = which(cmd.command, env);
	if (!file) return Promise.reject(new Error(`${cmd.command} is not installed. Install it first, then try again.`));
	return new Promise((resolve, reject) => {
		const spec = /\.(cmd|bat)$/i.test(file) ? loginTerminalSpec(file, cmd.args, 'win32') : { command: file, args: cmd.args, verbatim: false };
		const p = spawn(spec.command, spec.args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim });
		let sentUrl = false;
		let asked = false;
		let out = '';
		const stdout = new AgentOutputLines(), stderr = new AgentOutputLines();
		let finished = false;
		const kill = () => {
			if (process.platform === 'win32' && p.pid) execFile('taskkill.exe', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }, () => undefined);
			else p.kill();
		};
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			io.signal.removeEventListener('abort', onAbort);
			if (error) reject(error); else resolve();
		};
		const timer = setTimeout(() => { kill(); finish(new Error('The sign-in was not finished in 10 minutes.')); }, LOGIN_TIMEOUT);
		timer.unref?.();
		const onAbort = () => { kill(); finish(aborted()); };
		io.signal.addEventListener('abort', onAbort, { once: true });
		const publish = (lines: string[]) => {
			for (const line of lines) {
				const url = authUrlIn(line);
				if (url && !sentUrl) {
					sentUrl = true;
					io.event({ stage: 'browser', url });
					if (!/opening|opened/i.test(out)) void openSignInPage(io, url);
				}
			}
		};
		const feed = (d: Buffer | string, buffer: AgentOutputLines, end = false) => {
			if (finished || io.signal.aborted) return;
			const text = strip(String(d));
			out = (out + text).slice(-4000);
			publish(buffer.push(text, end));
			if (/paste (the )?code|enter (the )?code/i.test(out) && !asked) {
				asked = true;
				publish(stdout.push('', true)); publish(stderr.push('', true));
				io.event({ stage: 'code' });
				void io.code().then((c) => { if (!finished && !io.signal.aborted) p.stdin?.write(c.trim() + '\n'); }, () => undefined);
			}
		};
		p.stdout?.on('data', d => feed(d, stdout));
		p.stderr?.on('data', d => feed(d, stderr));
		p.stdout?.on('end', () => feed('', stdout, true));
		p.stderr?.on('end', () => feed('', stderr, true));
		p.stdin?.on('error', () => undefined);
		p.on('error', (e) => finish(e));
		p.on('close', (code) => {
			if (io.signal.aborted) return finish(aborted());
			if (code === 0) finish();
			else finish(new Error(`The sign-in did not finish${out.trim() ? ': ' + out.trim().split(/\r?\n/).pop()!.slice(0, 200) : '.'}`));
		});
		if (io.signal.aborted) onAbort();
	});
}

const mentionsTerminal = (m: { type?: string; description?: string; name?: string }) => m.type === 'terminal' || /\bin the terminal\b|run `[^`]+` in/i.test(`${m.description ?? ''} ${m.name ?? ''}`);
const wantsSecret = (m: { id: string; name: string }) => {
	const label = `${m.id} ${m.name}`;
	return /(^|[-_ ])(api[-_ ]?key|env)([-_ ]|$)/i.test(label) || (!/oauth|browser|device[-_ ]?(code|flow)/i.test(label) && /(^|[-_ ])token([-_ ]|$)/i.test(label));
};

/** A CLI can hold a subscription and still bill an API key or an external backend. */
export function claudePlanStatusIssue(status: { loggedIn: boolean; plan?: string; authMethod?: string; apiKeySource?: string; apiProvider?: string }): string | undefined {
	if ((status.apiKeySource && !/^(none|oauth)$/i.test(status.apiKeySource)) || (status.apiProvider && status.apiProvider !== 'firstParty') || /api[-_ ]?key|console/i.test(status.authMethod ?? '')) return 'Claude is configured to use API or external-cloud billing. This subscription card needs your Claude account login. Use the dedicated API provider for that billing method, or remove the CLI’s key/backend override and sign in with your Claude plan.';
	// OAuth-token logins can omit subscriptionType. The agent's session and actual response decide account access; missing metadata cannot establish ineligibility.
	return undefined;
}

/** Try to open a session until it works (a terminal login finishes in another window). */
async function waitForSession(open: () => Promise<AcpSessionInfo>, io: SignInIo): Promise<AcpSessionInfo> {
	const until = Date.now() + LOGIN_TIMEOUT;
	for (;;) {
		try {
			if (io.signal.aborted) throw aborted();
			return await open();
		} catch (e) {
			if (io.signal.aborted) throw aborted();
			if (!(e instanceof AcpError && e.authRequired) || Date.now() > until) throw e instanceof AcpError && e.authRequired ? new Error('The sign-in was not finished in 10 minutes.') : e;
			await sleep(3000, io.signal);
		}
	}
}

export async function signInAgent(rt: AcpRuntime, entry: AcpAgentEntry, meta: AcpPlanMeta | undefined, cwd: string, io: SignInIo): Promise<SignInResult> {
	if (io.signal.aborted) throw aborted();
	let account: { email?: string; plan?: string } = {};
	// The agent has no login of its own (Claude): the vendor's command-line login does it, and the agent reads the same credentials.
	if (meta?.statusCommand && meta.loginCommand) {
		io.event({ stage: 'waiting', text: 'Checking your sign-in…' });
		const env = { ...process.env };
		if (meta.planOnly?.dropEnv) for (const key of Object.keys(env)) if (meta.planOnly.dropEnv.test(key)) delete env[key];
		if (!which(meta.statusCommand.command, env)) throw new Error(`${meta.name} signs in through its command-line app, which was not found. Install “${meta.statusCommand.command}” first (see ${meta.manageUrl ?? 'the vendor\'s site'}), then try again.`);
		let st = await readStatus(meta.statusCommand, env, cwd);
		if (io.signal.aborted) throw aborted();
		if (!st) throw new Error(`${meta.name} could not report its sign-in status. Update ${meta.statusCommand.command}, then run “${meta.statusCommand.command} ${meta.statusCommand.args.join(' ')}” in a terminal to check your login.`);
		if (!st.loggedIn) {
			await loginWithCommand(meta.loginCommand, io, env, cwd);
			st = await readStatus(meta.statusCommand, env, cwd);
			if (io.signal.aborted) throw aborted();
			if (!st?.loggedIn) throw new Error('The sign-in finished but the account is still signed out. Try again.');
		}
		if (entry.id === 'claude-acp') { const issue = claudePlanStatusIssue(st); if (issue) throw new Error(issue); }
		account = { email: st.email, plan: st.plan };
	}
	io.event({ stage: 'waiting', text: `Starting ${entry.name}…` });
	// Some agents (Antigravity) print a sign-in link on every start, signed in or not: it is opened only once a login is really needed.
	let urlSent = false;
	let pendingUrl: string | undefined;
	let needsLogin = false;
	const sendUrl = () => {
		if (!pendingUrl || urlSent || !needsLogin) return;
		urlSent = true;
		io.event({ stage: 'browser', url: pendingUrl });
		void openSignInPage(io, pendingUrl);
	};
	const handlers: AcpClientHandlers = {
		requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		sessionUpdate: () => undefined,
		log: (line) => {
			const url = authUrlIn(line);
			if (url && entry.id === 'antigravity-acp') {
				// Verification diagnostics can precede OAuth and must not occupy the one login-link slot.
				try {
					const parsed = new URL(url);
					if (parsed.origin !== 'https://accounts.google.com' || parsed.username || parsed.password || !/^\/o\/oauth2\/(?:v2\/)?auth$/.test(parsed.pathname)) return;
				} catch { return; }
			}
			if (url && !pendingUrl) {
				pendingUrl = url;
				sendUrl();
			}
		}
	};
	let conn = await rt.connect(entry, handlers, { cwd, fs: false, authTerminal: true, signal: io.signal });
	const stop = () => conn.close();
	io.signal.addEventListener('abort', stop, { once: true });
	try {
		let session: AcpSessionInfo;
		if (io.reauthenticate) {
			const methods = conn.authMethods.filter(m => (!m.type || m.type === 'agent') && !wantsSecret(m) && !mentionsTerminal(m));
			const method = meta?.planScope?.authMethod ? methods.find(m => m.id === meta.planScope!.authMethod) : methods[0];
			if (!method) throw new Error(`${entry.name} does not advertise the browser sign-in required for this plan.`);
			const logout = conn.capabilities?.auth?.logout;
			if (!logout || typeof logout !== 'object' || Array.isArray(logout)) throw new Error(`${entry.name} cannot restart its saved login from here. Sign out through the vendor's agent, then try signing in again.`);
			io.signal.throwIfAborted();
			io.event({ stage: 'waiting', text: `Restarting ${entry.name}'s saved sign-in…` });
			let timer: NodeJS.Timeout | undefined;
			try { await Promise.race([conn.request('logout', {}, io.signal), new Promise((_, no) => { timer = setTimeout(() => no(new Error('The agent did not finish signing out. Try again.')), 30_000); timer.unref?.(); })]); }
			finally { clearTimeout(timer); }
			io.signal.throwIfAborted();
			pendingUrl = undefined; urlSent = false; needsLogin = true;
			io.event({ stage: 'browser-wait', text: 'Choose your account in the new Google sign-in page…' });
			try { await Promise.race([conn.authenticate(method.id, io.signal), new Promise((_, no) => { timer = setTimeout(() => no(new Error('The sign-in was not finished in 10 minutes.')), LOGIN_TIMEOUT); timer.unref?.(); })]); }
			finally { clearTimeout(timer); }
			session = await conn.newSession(cwd, io.signal);
		} else {
			try {
				session = await conn.newSession(cwd, io.signal);
			} catch (e) {
				if (!(e instanceof AcpError && e.authRequired)) throw e;
				needsLogin = true;
				sendUrl();
				const browserMethods = conn.authMethods.filter(m => (!m.type || m.type === 'agent') && !wantsSecret(m) && !mentionsTerminal(m));
				const method = meta?.planScope?.authMethod ? browserMethods.find((m) => m.id === meta.planScope!.authMethod) : browserMethods[0];
				const terminalMethod = conn.authMethods.find((m) => !wantsSecret(m) && mentionsTerminal(m));
				if (method) {
					io.event({ stage: 'browser-wait', text: `Approve the sign-in in your browser…` });
					let timer: NodeJS.Timeout | undefined;
					try { await Promise.race([conn.authenticate(method.id, io.signal), new Promise((_, no) => { timer = setTimeout(() => no(new Error('The sign-in was not finished in 10 minutes.')), LOGIN_TIMEOUT); timer.unref?.(); })]); }
					finally { clearTimeout(timer); }
					session = await conn.newSession(cwd, io.signal);
				} else if (terminalMethod || meta?.loginCommand) {
					// The advertised terminal descriptor is authoritative: it keeps the configured program, arguments and environment intact.
					const spec = rt.spawnSpec(entry, cwd, terminalMethod?.args ?? [], terminalMethod?.env ?? {});
					const command = !terminalMethod && meta?.loginCommand ? { command: which(meta.loginCommand.command) ?? (rt.launch(entry)?.kind === 'binary' ? spec.command : meta.loginCommand.command), args: meta.loginCommand.args } : spec;
					io.event({ stage: 'terminal', text: `Finish signing in in the terminal window that opened.` });
					await io.terminal(`${entry.name} sign-in`, command.command, command.args, spec.env);
					session = await waitForSession(async () => {
						conn.close();
						conn = await rt.connect(entry, handlers, { cwd, fs: false, authTerminal: true, signal: io.signal });
						return conn.newSession(cwd, io.signal);
					}, io);
				} else {
					throw new Error(`${entry.name} offers no sign-in that works from here${conn.authMethods.length ? ' (it only offers: ' + conn.authMethods.map((m) => m.name).join(', ') + ')' : ''}. Use its API key instead.`);
				}
			}
		}
		if (io.signal.aborted) throw aborted();
		const scope = meta?.planScope;
		session = await applyPlanScope(conn, session, scope);
		if (io.signal.aborted) throw aborted();
		const found = planModels(sessionModels(session), scope);
		if (scope?.models?.length && !found.models.length) throw new Error(`${meta?.name ?? entry.name} signed in, but the account has no ${scope.option?.value ?? meta?.plans ?? 'subscription'} plan models. Check the plan on the vendor's site, or connect its dedicated key.`);
		return { agent: conn.agentName || entry.name, models: found.models, current: found.current, ...account };
	} finally {
		io.signal.removeEventListener('abort', stop);
		conn.close();
	}
}
