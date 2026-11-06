/*
 * zer0ne Code host: the same ChatController the VS Code extension uses,
 * running on Node with the desktop `vscode` shim. Its UI is served on
 * 127.0.0.1 by the extension's own web server in desktop mode (full UI,
 * random token, localhost only) — the app window just shows that page.
 */
'use strict';
const os = require('os');
const path = require('path');
const { createDesktopShim } = require('./desktop-shim');
const { createPrompts } = require('./prompts');
const dialogScript = require('fs').readFileSync(path.join(__dirname, 'dialog-ui.js'), 'utf8');

/**
 * Inside the app (ZER0NE_DESKTOP=1), the desktop layer goes first in every engine page:
 * the boot values the shell's preload exposes (window.__zcShell), then the window frame,
 * sidebar extras and bell (app/desktop-ui.js) and Liquid Glass (app/desktop-glass.js).
 * Inlined with the page's nonce, they run before the page's own scripts.
 */
function desktopLayer() {
	if (process.env.ZER0NE_DESKTOP !== '1') return '';
	const read = (f) => require('fs').readFileSync(path.join(__dirname, '..', 'app', f), 'utf8');
	const boot = `(function(){var s=window.__zcShell;var b=(s&&s.boot)||{};if(typeof b.activationId==='string')window.__zcActivationId=b.activationId;window.__zgPrefs=b.prefs&&typeof b.prefs==='object'?b.prefs:null;if(b.support)window.__zgSupport=b.support;})();`;
	return [boot, read('desktop-ui.js'), read('desktop-glass.js')].map((code) => code.replace(/<\/script/gi, '<\\/script'));
}

/**
 * Notifications for the shell to show: when an agent run finishes while you are away
 * (and, during long runs, a heartbeat every few minutes). The engine's own state
 * messages mark a run starting and ending, so no polling and no engine changes; the
 * shell decides whether anything is shown — it knows the window's focus and the user's
 * choice. Run `notifier.observe(m)` where every engine post passes through.
 */
function createNotifier(rpc, heartbeatMs = 5 * 60_000, now = Date.now) {
	let busy = null; // last seen isStreaming (no feed yet before the first state)
	let runningSessionId = null;
	let since = 0; // when the current run started
	let beat = 0; // last heartbeat of this run
	const mins = (t) => Math.max(1, Math.round((t - since) / 60_000));
	const report = (kind, body) => void rpc('notify', { kind, title: 'zer0ne Code', body }).catch(() => undefined);
	const step = (streaming, t, completed) => {
		if (busy === null) {
			busy = streaming;
			since = beat = t;
			return;
		}
		if (streaming && !busy) {
			busy = true;
			since = beat = t;
			return;
		}
		if (!streaming && busy) {
			busy = false;
			if (completed) report('done', `The agent run finished (${mins(t)} min).`);
			return;
		}
		if (streaming && t - beat >= heartbeatMs) {
			beat = t;
			report('beat', `The agent is still working — ${mins(t)} min so far.`);
		}
	};
	return {
		observe(m) {
			if (m && m.type === 'state') {
				if (m.isStreaming) runningSessionId = m.runningSessionId || m.currentSessionId || runningSessionId;
				step(!!m.isStreaming, now(), !Array.isArray(m.messages) || !!completedRunSummary(m, runningSessionId));
			}
		}
	};
}

/**
 * Extracts a concise human-readable waiting reason when an action needs user input.
 */
function extractWaitingReason(messages) {
	if (!Array.isArray(messages) || !messages.length) return null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.approval && msg.approval.status === 'pending') {
			const a = msg.approval;
			if (a.kind === 'command' && a.command) {
				const cmd = String(a.command).trim().replace(/\s+/g, ' ');
				return `Approval needed: run "${cmd.length > 35 ? cmd.slice(0, 32) + '...' : cmd}"`;
			}
			if ((a.kind === 'edit' || a.kind === 'write') && a.path) {
				const base = path.basename(String(a.path));
				return `Approval needed: write to ${base}`;
			}
			if (a.kind === 'mcp' && a.tool) {
				return `Approval needed: ${a.tool}`;
			}
			return 'Approval needed for pending action';
		}
		if (msg.question && msg.question.status === 'pending') {
			const q = String(msg.question.text || '').trim();
			return `Question: "${q.length > 40 ? q.slice(0, 37) + '...' : q}"`;
		}
	}
	return null;
}

/**
 * Extracts a one-sentence deliverable / outcome summary for run finish notifications.
 */
function extractRunSummary(messages) {
	if (!Array.isArray(messages) || !messages.length) return null;
	let lastUser = null;
	let lastAssistant = null;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!lastAssistant && msg.role === 'assistant' && msg.content && !msg.local) {
			lastAssistant = msg;
		}
		if (msg.role === 'user' && msg.content && !msg.local) {
			lastUser = msg;
			break;
		}
	}
	if (!lastUser) return null;
	if (lastUser.turn && !['completed', 'failed'].includes(lastUser.turn.outcome)) return null;

	const failed = lastAssistant?.isError || lastUser.turn?.outcome === 'failed';
	let prompt = String(lastUser.content || '').trim().replace(/^<[^>]+>/g, '').trim();
	prompt = prompt.split('\n')[0].trim();
	if (prompt.length > 45) prompt = prompt.slice(0, 42).trim() + '...';

	const edits = lastUser.turn?.edits;
	const fileCount = Array.isArray(edits) ? edits.length : 0;
	const filesDesc = fileCount > 0 ? ` (${fileCount} file${fileCount > 1 ? 's' : ''} modified)` : '';

	if (failed) {
		return prompt ? `"${prompt}" failed` : 'Turn failed';
	}

	if (lastAssistant && typeof lastAssistant.content === 'string') {
		const text = lastAssistant.content.trim().replace(/^#+\s+/g, '').replace(/```[\s\S]*?```/g, '').trim();
		const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('>') && !l.startsWith('-')) || '';
		if (firstLine && firstLine.length <= 60 && !firstLine.endsWith(':') && !firstLine.startsWith('<')) {
			const sentence = firstLine.replace(/\.$/, '');
			return `${sentence}${filesDesc}`;
		}
	}

	if (prompt) {
		return `"${prompt}" completed${filesDesc}`;
	}
	return fileCount > 0 ? `Completed${filesDesc}` : 'Run finished';
}

function completedRunSummary(state, runningSessionId) {
	if (runningSessionId && state.currentSessionId && state.currentSessionId !== runningSessionId) {
		const outcome = state.sessions?.find(session => session.id === runningSessionId)?.outcome;
		return outcome === 'completed' ? 'Run completed' : outcome === 'failed' ? 'Turn failed' : null;
	}
	return extractRunSummary(state.messages);
}

/** Whether the run that just ended failed (the same reading as completedRunSummary). */
function runFailed(state, runningSessionId) {
	if (runningSessionId && state.currentSessionId && state.currentSessionId !== runningSessionId) {
		return state.sessions?.find(session => session.id === runningSessionId)?.outcome === 'failed';
	}
	const messages = Array.isArray(state.messages) ? state.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'assistant' && msg.content && !msg.local && msg.isError) return true;
		if (msg.role === 'user' && msg.content && !msg.local) return msg.turn?.outcome === 'failed';
	}
	return false;
}

/** What a running step is called while it runs, as the chat words it (TOOL_VERBS in engine/media/chat.js). */
const RUNNING_VERBS = {
	read_file: 'Reading', view_image: 'Viewing', list_files: 'Listing', grep: 'Searching', semantic_search: 'Searching',
	code_intel: 'Searching', session_search: 'Searching', web_search: 'Searching the web', web_fetch: 'Fetching',
	get_diagnostics: 'Checking', verify: 'Solving', todo_write: 'Planning', memory_recall: 'Recalling',
	memory_retain: 'Remembering', edit_lines: 'Editing', task: 'Delegating', delegate_to_helper: 'Delegating', run_script: 'Running'
};

function clip(text, max) {
	const s = String(text || '').trim().replace(/\s+/g, ' ');
	return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A path argument shows its file name; anything else (a query, a command) shows as it is. */
function shortArg(arg) {
	const s = String(arg || '').trim();
	return /[\\/]/.test(s) && !/\s/.test(s) ? path.basename(s) : s;
}

/**
 * How far the visible turn is: the agent's plan (its latest todo list this turn) and
 * the steps it has run so far.
 */
function runProgress(messages) {
	let plan = null;
	let steps = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) break;
		if (!plan && Array.isArray(msg.todos) && msg.todos.length) {
			const current = msg.todos.find((t) => !t.done);
			plan = { done: msg.todos.filter((t) => t.done).length, total: msg.todos.length, current: current ? clip(current.text, 60) : null };
		}
		if (msg.tool || (msg.approval && msg.approval.status !== 'pending')) steps++;
	}
	return { plan, steps };
}

/**
 * The phase of the visible run for the notch: waiting on you, running a step,
 * writing its reply or thinking, with its progress. A run in another chat or the
 * queue is just working.
 */
function runPhase(state) {
	const messages = Array.isArray(state.messages) ? state.messages : [];
	if (!state.isStreaming) return { phase: 'working', detail: null, plan: null, steps: 0, stuck: null, budget: null, agents: null, goal: null, health: null };
	const budget = runBudget(messages);
	// How much of the input the provider served from its prompt cache (the engine's measured share).
	const cache = state.context && typeof state.context.cacheRate === 'number' && Number.isFinite(state.context.cacheRate) ? Math.max(0, Math.min(100, Math.round(state.context.cacheRate))) : null;
	if (budget && cache !== null) budget.cache = cache;
	return { ...currentStep(state, messages), ...runProgress(messages), stuck: runStuck(messages), budget, agents: runAgents(state), goal: runGoal(state), ...runPending(messages), health: runHealth(state, messages) };
}

/**
 * What the run waits for, so the notch can answer it: the pending approval (what it would
 * run or change, sandboxed or not, what the project's rules say) or the agent's question.
 */
function runPending(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) break;
		const a = msg.approval;
		if (a && a.status === 'pending' && typeof a.id === 'string') {
			const what = a.kind === 'command' ? String(a.command || '').replace(/\s+# background$/, '') : a.kind === 'mcp' ? String(a.tool || '') : String(a.path || '');
			return { approval: { id: a.id, kind: ['command', 'mcp', 'write', 'edit', 'patch'].includes(a.kind) ? a.kind : 'edit', text: what.slice(0, 2000), sandboxed: a.sandboxed === true, escalate: a.escalate === true, rule: a.projectRule === 'ask' || a.projectRule === 'pending' ? a.projectRule : null } };
		}
		const q = msg.question;
		if (q && q.status === 'pending' && typeof q.id === 'string') {
			return { question: { id: q.id, text: String(q.text || '').slice(0, 600), options: (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o === 'string' && o.trim()).slice(0, 6).map((o) => o.slice(0, 120)) } };
		}
	}
	return {};
}

/** How the run is doing while it works: files changed so far, its latest checks, and how full the context is. */
function runHealth(state, messages) {
	const turn = latestTurn(messages);
	const edits = turn && Array.isArray(turn.edits) ? turn.edits.filter((e) => e && !e.undone) : [];
	let files = new Set(edits.map((e) => e.path)).size;
	if (!files) {
		const paths = new Set();
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === 'user' && !msg.local) break;
			const a = msg.approval;
			if (a && ['write', 'edit', 'patch'].includes(a.kind) && a.status !== 'pending' && a.status !== 'rejected' && a.path) paths.add(a.path);
		}
		files = paths.size;
	}
	const reports = turn && Array.isArray(turn.verification) ? turn.verification.filter((r) => r && r.kind === 'verify') : [];
	const last = reports[reports.length - 1];
	const checks = !last ? null : !last.finishedAt ? 'running' : last.status === 'passed' ? 'passed' : 'failed';
	const c = state.context;
	const context = c && Number(c.window) > 0 && Number(c.used) >= 0 ? Math.min(100, Math.round((Number(c.used) / Number(c.window)) * 100)) : null;
	return files || checks || context !== null ? { files, checks, context } : null;
}

/** A /goal the run works toward: its rounds so far, so the notch can say "round 2 of 5". */
function runGoal(state) {
	const g = state.goal;
	if (!g || g.status !== 'active' || typeof g.objective !== 'string') return null;
	return { objective: g.objective.slice(0, 160), rounds: Number(g.rounds) || 0, max: Number(g.maxRounds) || 0, check: typeof g.check === 'string' ? g.check.slice(0, 80) : null };
}

/** The steps of the visible turn that have ended, newest first, each with what it acted on and whether it failed. */
function endedSteps(messages) {
	const steps = [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) break;
		if (msg.tool && msg.tool.status !== 'running') {
			const subject = shortArg(msg.tool.arg) || String(msg.tool.name || '').replace(/_/g, ' ');
			steps.push({ key: `${msg.tool.name}\n${msg.tool.arg}`, subject, failed: msg.tool.status === 'error' });
		}
		const a = msg.approval;
		if (a && a.status !== 'pending' && a.execution !== 'running') {
			const subject = a.kind === 'command' ? String(a.command || '').replace(/\s+# background$/, '') : a.kind === 'mcp' ? String(a.tool || '') : shortArg(a.path);
			steps.push({ key: `${a.kind}\n${subject}`, subject, failed: a.failed === true });
		}
	}
	return steps;
}

/** In a row before the run counts as going in circles: the same step failing, or the same step at all. */
const STUCK_FAILS = 3;
const STUCK_REPEATS = 5;

/**
 * Why the visible run looks stuck, or null: the same step failed again and again with no
 * success in between, or the agent keeps repeating one step. (A run with no progress at all
 * is the busy reporter's to notice: it needs a clock.)
 */
function runStuck(messages) {
	const steps = endedSteps(messages);
	const last = steps.find((s) => s.failed);
	if (last) {
		let fails = 0;
		for (const s of steps) {
			if (s.key !== last.key) continue;
			if (!s.failed) break;
			fails++;
		}
		// Only while it is still at it: a few steps after the last failure it has moved on.
		if (fails >= STUCK_FAILS && steps.indexOf(last) < 3) return clip(`${last.subject} failed ${fails}×`, 60);
	}
	let repeats = 0;
	while (repeats < steps.length && steps[repeats].key === steps[0].key) repeats++;
	if (repeats >= STUCK_REPEATS) return clip(`Repeating ${steps[0].subject} (${repeats}×)`, 60);
	return null;
}

/** The latest turn's record (the user message that started the visible run). */
function latestTurnId(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) return msg.turn && typeof msg.id === 'string' ? msg.id : null;
	}
	return null;
}

function latestTurn(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) return msg.turn || null;
	}
	return null;
}

/**
 * What the visible run has spent against its task budget (Settings → Agent): its cost when a
 * cost limit is set or the cost is known, else its tokens when a token limit is set. Cents
 * and thousands of tokens, so the shell hears about it once per request at most.
 */
function runBudget(messages) {
	const b = latestTurn(messages)?.taskBudget;
	if (!b || !b.limits) return null;
	const cost = (b.spentCost || 0) + (b.uncertainCost || 0);
	if (b.limits.cost > 0 || (cost > 0 && !(b.limits.tokens > 0))) return { kind: 'cost', spent: Math.round(cost * 100) / 100, limit: b.limits.cost > 0 ? b.limits.cost : 0 };
	if (b.limits.tokens > 0) return { kind: 'tokens', spent: Math.round(((b.spentTokens || 0) + (b.uncertainTokens || 0)) / 1000) * 1000, limit: b.limits.tokens };
	return null;
}

/**
 * The helpers this turn started (a Workflow's workers and its reviewer, or subagents):
 * how many run, wait their turn, finished or failed, and the review's verdict.
 */
function runAgents(state) {
	const root = state.workflowTaskId;
	const runs = Array.isArray(state.agentRuns) && root ? state.agentRuns.filter((r) => r && r.rootTaskId === root) : [];
	if (!runs.length) return null;
	const workers = runs.filter((r) => r.workflowRole !== 'reviewer');
	const reviewer = runs.find((r) => r.workflowRole === 'reviewer');
	const count = (fn) => workers.filter(fn).length;
	return {
		workflow: runs.some((r) => r.workflow),
		total: workers.length,
		running: count((r) => r.status === 'running' && r.executionState !== 'queued'),
		queued: count((r) => r.status === 'running' && r.executionState === 'queued'),
		done: count((r) => r.status === 'completed'),
		failed: count((r) => r.status !== 'running' && r.status !== 'completed'),
		review: !reviewer ? null : reviewer.status === 'running' ? 'running' : reviewer.reviewVerdict || (reviewer.status === 'completed' ? 'pass' : 'failed')
	};
}

/**
 * What a finished turn did: the files it changed with their lines, whether its checks
 * passed (as the chat's evidence reads them: the latest report of each scope) and the
 * Workflow review's verdict.
 */
function runResult(messages) {
	const turn = latestTurn(messages);
	if (!turn) return null;
	const edits = (Array.isArray(turn.edits) ? turn.edits : []).filter((e) => e && !e.undone);
	const reports = [...new Map((Array.isArray(turn.verification) ? turn.verification : []).filter((r) => r && r.kind === 'verify').map((r) => [r.root + '\0' + r.scope, r])).values()];
	const tests = !reports.length ? null : reports.every((r) => r.finishedAt && r.status === 'passed' && Array.isArray(r.stages) && r.stages.length && r.stages.every((s) => s.status === 'passed' && s.code === 0)) ? 'passed' : 'failed';
	const result = {
		files: new Set(edits.map((e) => e.path)).size,
		added: edits.reduce((n, e) => n + (Number(e.added) || 0), 0),
		removed: edits.reduce((n, e) => n + (Number(e.removed) || 0), 0),
		tests,
		review: ['pass', 'changes', 'blocked'].includes(turn.review) ? turn.review : null
	};
	return result.files || tests || result.review ? result : null;
}

function currentStep(state, messages) {
	if (state.runState === 'waiting') return { phase: 'waiting', detail: extractWaitingReason(messages) };
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === 'user' && !msg.local) break;
		if (msg.tool && msg.tool.status === 'running') {
			const name = String(msg.tool.name || '');
			const verb = RUNNING_VERBS[name] || (name.startsWith('browser_') ? 'Browsing' : 'Using ' + name.replace(/_/g, ' '));
			return { phase: 'tool', detail: clip(`${verb} ${shortArg(msg.tool.arg)}`, 60) };
		}
		const a = msg.approval;
		if (a && a.status !== 'pending' && a.execution === 'running') {
			const detail = a.kind === 'command' ? `Running ${String(a.command || '').replace(/\s+# background$/, '')}` : a.kind === 'mcp' ? `Calling ${a.tool || ''}` : `${a.kind === 'write' ? 'Writing' : 'Editing'} ${shortArg(a.path)}`;
			return { phase: 'tool', detail: clip(detail, 60) };
		}
	}
	return { phase: String(state.streaming?.text || '').trim() ? 'writing' : 'thinking', detail: null };
}

/**
 * Tells the shell when a run starts or ends in this engine ("busy"), and which phase
 * it is in. The desktop keeps one engine alive per project, so a project in the
 * background can still be working: the shell marks it in the sidebar, the window
 * title and the notch. Changes only — state messages arrive on every stream tick.
 */
/** A run with nothing new for this long (no step, no text, no plan change) looks stuck. */
const STALL_MS = 5 * 60_000;

function createBusyReporter(rpc, stallMs = STALL_MS, now = Date.now) {
	let busy = null;
	let sessionId = null;
	let sent = null;
	let foreground = null;
	let remote = null;
	let terminal = null;
	const terminalSources = new Map();
	let router = null;
	/** The last state seen, what it showed and when that last changed: the clock behind "no progress". */
	let last = null;
	let motion = null;
	let movedAt = 0;
	let stallTimer = null;

	const report = (m) => {
		const active = foreground;
		const finishedSessionId = sessionId;
		const on = !!active;
		const nextSessionId = active?.sessionId ?? null;
		const nextActivity = active ? active.status : 'idle';
		const next = on ? runPhase(m) : { phase: 'idle', detail: null, plan: null, steps: 0, stuck: null, budget: null, agents: null, goal: null, health: null };
		const t = now();
		// Movement is anything new on screen, including the output of a long command as it runs.
		const latest = Array.isArray(m.messages) && m.messages.length ? m.messages[m.messages.length - 1] : null;
		const moving = JSON.stringify([nextSessionId, nextActivity, next.phase, next.detail, next.plan, next.steps, String(m.streaming?.text || '').length, String(m.streaming?.reasoning || '').length, latest?.id, String(latest?.tool?.detail || latest?.approval?.result || '').length]);
		if (moving !== motion) {
			motion = moving;
			movedAt = t;
		}
		clearTimeout(stallTimer);
		stallTimer = null;
		let stuck = next.stuck;
		if (on && nextActivity === 'running' && !stuck) {
			const still = t - movedAt;
			if (still >= stallMs) stuck = `No progress for ${Math.floor(still / 60_000)} min`;
			// Look again when the next whole period of stillness is up.
			stallTimer = setTimeout(() => last && report(last), stallMs - (still % stallMs));
			stallTimer.unref?.();
		}
		const payload = { on, sessionId: nextSessionId, activity: nextActivity, phase: next.phase, detail: next.detail };
		if (next.plan) payload.plan = next.plan;
		if (next.steps) payload.steps = next.steps;
		if (stuck) payload.stuck = stuck;
		if (next.budget) payload.budget = next.budget;
		if (next.agents) payload.agents = next.agents;
		if (next.goal) payload.goal = next.goal;
		if (next.approval) payload.approval = next.approval;
		if (next.question) payload.question = next.question;
		if (next.health) payload.health = next.health;
		// The notch may stop or steer only the run in the chat the engine has open.
		if (on && nextSessionId && nextSessionId === m.currentSessionId) payload.current = true;
		const key = JSON.stringify(payload);
		if (busy === on && key === sent) return;
		busy = on;
		sessionId = nextSessionId;
		sent = key;
		if (nextActivity === 'waiting' && Array.isArray(m.messages) && m.messages.length) {
			const reason = extractWaitingReason(m.messages);
			if (reason) payload.waitingReason = reason;
		}
		if (!on && Array.isArray(m.messages) && m.messages.length) {
			const summary = completedRunSummary(m, finishedSessionId);
			if (summary) payload.summary = summary;
			if (runFailed(m, finishedSessionId)) payload.failed = true;
			// The numbers belong to the chat on screen: a run that ended in another chat has none here.
			const here = !finishedSessionId || !m.currentSessionId || m.currentSessionId === finishedSessionId;
			const result = here ? runResult(m.messages) : null;
			if (result) payload.result = result;
			// The finished turn, for the notch's Undo: still the chat on screen.
			const turnId = here ? latestTurnId(m.messages) : null;
			if (turnId) payload.turn = turnId;
		}
		void rpc('busy', payload).catch(() => undefined);
	};

	return {
		observe(m) {
			if (!m) return;
			if (m.type === 'localPlus' && m.data?.host) {
				const on = !!m.data.host.running;
				if (router !== on) {
					router = on;
					void rpc('retainRouter', { on }).catch(() => undefined);
				}
				return;
			}
			if (['terminalActivity', 'ptyActivity', 'projectActionActivity'].includes(m.type)) {
				terminalSources.set(m.type, !!m.running);
				const on = [...terminalSources.values()].some(Boolean);
				if (terminal !== on) {
					terminal = on;
					void rpc('retainTerminal', { on }).catch(() => undefined);
				}
				return;
			}
			if (m.type === 'state' && m.remote && remote !== !!m.remote.running) {
				remote = !!m.remote?.running;
				void rpc('retainRemote', { on: remote }).catch(() => undefined);
			}
			if (m.type !== 'state') return;
			foreground = m.isStreaming ? { sessionId: m.runningSessionId ?? null, status: m.runState === 'waiting' ? 'waiting' : 'running' } : (m.desktopBackgroundRuns || []).find(run => run.status === 'running') || (m.queue?.length ? { sessionId:m.currentSessionId ?? null, status:'running' } : null);
			last = m;
			report(m);
		},
		dispose() {
			clearTimeout(stallTimer);
			last = null;
		}
	};
}

/** The notch settings (Settings → Notch), as the shell keeps them. */
function notchPrefs(settings) {
	const s = settings && typeof settings === 'object' ? settings : {};
	return {
		on: s.notch !== false,
		thinking: s.notchThinking !== false,
		writing: s.notchWriting !== false,
		tools: s.notchTools !== false,
		waiting: s.notchWaiting !== false,
		finished: s.notchFinished !== false,
		presence: ['background', 'activity', 'always'].includes(s.notchPresence) ? s.notchPresence : 'background',
		covered: s.notchCovered === 'pill' ? 'pill' : 'line',
		fullscreen: s.notchFullscreen !== false,
		alerts: s.notchAlerts === 'notch' ? 'notch' : 'both',
		keepAwake: s.notchKeepAwake !== false,
		battery: s.notchBattery === true,
		network: s.notchNetwork === true,
		mic: s.notchMic === true,
		welcome: s.notchWelcome === true,
		stuck: s.notchStuck !== false,
		results: s.notchResults !== false,
		agents: s.notchAgents !== false,
		cost: s.notchCost !== false,
		shortcut: s.notchShortcut !== false,
		private: s.notchPrivate === true,
		actions: s.notchActions !== false,
		steer: s.notchSteer !== false,
		drop: s.notchDrop !== false,
		discreet: s.notchDiscreet !== false,
		health: s.notchHealth !== false,
		next: s.notchNext !== false,
		keys: s.notchKeys !== false,
		display: s.notchDisplay === 'primary' ? 'primary' : 'active',
		sound: s.notchSound === true,
		// Settings → Appearance → Motion: calm keeps only the motion that shows work happening.
		calm: s.motion === 'calm'
	};
}

/** The project's cloud tasks the notch follows: running ones and the latest few, newest first. */
function cloudLanes(tasks) {
	const list = Array.isArray(tasks) ? tasks.filter((t) => t && typeof t.id === 'string') : [];
	const ended = (t) => t.status === 'completed' || t.status === 'failed';
	return list
		.filter((t) => !ended(t) || Date.now() - (t.dispatchedAt || t.createdAt || 0) < 24 * 3600_000)
		.sort((a, b) => (b.dispatchedAt || b.createdAt || 0) - (a.dispatchedAt || a.createdAt || 0))
		.slice(0, 5)
		.map((t) => {
			const steps = Array.isArray(t.jobSteps) ? t.jobSteps : [];
			return {
				id: t.id,
				task: clip(t.task, 80),
				status: ['dispatching', 'queued', 'in_progress', 'completed', 'failed'].includes(t.status) ? t.status : 'queued',
				done: steps.filter((x) => x && x.status === 'completed').length,
				total: steps.length,
				since: t.dispatchedAt || t.createdAt || 0,
				prUrl: typeof t.prUrl === 'string' ? t.prUrl : null,
				runUrl: typeof t.runUrl === 'string' ? t.runUrl : null
			};
		});
}

/**
 * The shell draws the notch for every project, so it keeps its own copy of the settings, and
 * learns when this engine's dictation has the microphone open. Both are sent on change.
 */
function createNotchSync(rpc) {
	let sent = null;
	let mic = null;
	let cloud = null;
	return {
		observe(m) {
			if (!m) return;
			const tasks = m.type === 'cloudTasks' ? m.tasks : m.type === 'cloudStatus' ? m.data?.tasks : undefined;
			if (tasks) {
				const lanes = cloudLanes(tasks);
				const text = JSON.stringify(lanes);
				if (text !== cloud) {
					cloud = text;
					void rpc('notchCloud', { tasks: lanes }).catch(() => undefined);
				}
				return;
			}
			if (m.type !== 'state') return;
			const listening = m.mic?.state === 'listening';
			if (m.mic && listening !== mic) {
				mic = listening;
				void rpc('notchMic', { on: listening }).catch(() => undefined);
			}
			if (!m.settings) return;
			const prefs = notchPrefs(m.settings);
			const text = JSON.stringify(prefs);
			if (text === sent) return;
			sent = text;
			void rpc('setNotch', { prefs }).catch(() => undefined);
		}
	};
}

/**
 * @param {{ engineDir: string, workspace?: string, dataDir: string, rpc: Function, key?: Buffer, port?: number }} o
 * @returns {Promise<{ url: string, activate(handoff: object | null): Promise<void>, stop(): Promise<void> }>}
 */
async function startHost(o) {
	const prompts = createPrompts();
	const viewStateKey = 'zer0neDesktop.viewState.' + (process.env.ZER0NE_WINDOW_ID || 'standalone');
	const ownership = require('./ownership').projectServiceOwner(o.dataDir, o.workspace);
	try {
	try {
	const artifacts = new Map();
	let token;
	const previewArtifact = async (file, title) => {
		const fs = require('fs');
		const folder = fs.realpathSync(path.join(o.workspace, '.zer0ne', 'artifacts'));
		const resolved = fs.realpathSync(file);
		const relative = path.relative(folder, resolved);
		if (relative.startsWith('..') || path.isAbsolute(relative) || !/\.html$/i.test(resolved)) throw new Error('Choose a saved project artifact.');
		if (fs.statSync(resolved).size > 2_000_000) throw new Error('This artifact is too large to preview. Open the saved file.');
		const id = require('crypto').randomBytes(18).toString('hex');
		const { sandboxHtml } = require(path.join(o.engineDir, 'out', 'host', 'artifactsHost.js'));
		artifacts.set(id, sandboxHtml(fs.readFileSync(resolved, 'utf8'), title));
		if (artifacts.size > 12) artifacts.delete(artifacts.keys().next().value);
		void prompts.request({ kind: 'artifact', title, url: `/api/artifacts/${id}` }).catch(() => undefined);
	};
	const { shim, install } = createDesktopShim({ ...o, serviceOwner: ownership.owned, previewArtifact, prompt: options => prompts.request(options) });
	install(shim.vscode);
	const out = path.join(o.engineDir, 'out');
	const { ChatController } = require(path.join(out, 'chatController.js'));
	const { ProviderStore } = require(path.join(out, 'providerStore.js'));
	const { ModelCatalog } = require(path.join(out, 'modelCatalog.js'));
	const { RemoteServer, newRemoteToken } = require(path.join(out, 'remote.js'));
	const ctx = shim.context(o.engineDir);
	const store = new ProviderStore(ctx);
	const catalog = new ModelCatalog(ctx);
	const controller = new ChatController(ctx, store, catalog, () => undefined);
	const { projectPathKey } = require(path.join(out, 'providerStore.js'));
	const projects = desktopProjects(ctx, projectPathKey, o.rpc);
	let deletingProject = false;
	const preferences = desktopPreferences(ctx, o.rpc);
	const openin = desktopOpenIn(o.rpc);
	const notifier = createNotifier(o.rpc);
	const busyReport = createBusyReporter(o.rpc);
	const notchSync = createNotchSync(o.rpc);

	controller.fullscreenToggler = (on) => {
		// Fullscreen belongs to the shared native window, not one project's page.
		void o.rpc('fullscreen', { on }).catch(() => undefined);
	};
	const layer = desktopLayer();
	class DesktopServer extends RemoteServer {
		page(token, nonce) {
			let html = super.page(token, nonce).replace('history.replaceState', `window.__REMOTE__.viewState = ${JSON.stringify(ctx.workspaceState.get(viewStateKey, {})).replace(/</g, '\\u003c')}; history.replaceState`).replace('</body>', `<script nonce="${nonce}">${dialogScript}</script></body>`);
			if (layer) html = html.replace('<head><meta charset="UTF-8">', () => `<head><meta charset="UTF-8">${layer.map((code) => `<script nonce="${nonce}">${code}</script>`).join('')}`);
			return html;
		}
	}

	token = newRemoteToken();
	let chatSurface;
	let activationId;
	let activationView;
	let activating = Promise.resolve();
	const activated = () => {
		if (typeof activationId === 'string') chatSurface.post({ type: 'zcDesktopActivated', activationId, ...(activationView ? { view: activationView } : {}) });
	};
	const server = new DesktopServer(
		path.join(o.engineDir, 'media'),
		{
			token: () => token,
			preview: id => artifacts.get(id),
			mcpApp: key => controller.mcpAppDocument(key),
			attach: (post) => {
				const surface = {
					kind: 'chat',
					// Every engine post passes here: the notifier watches the state messages
					// for a run starting and finishing (see createNotifier), the busy
					// reporter tells the shell which project is working (transitions only).
					post: (m) => {
						notifier.observe(m);
						busyReport.observe(m);
						notchSync.observe(m);
						return post(projects.filter(m));
					},
					visible: () => true
				};
				chatSurface = surface;
				prompts.attach(surface.post);
				const attachment = controller.attach(surface);
				const handle = async (msg) => {
					if (prompts.handle(msg)) return;
					if (deletingProject) { surface.post({ type: 'status', kind: 'error', message: 'Finish the project deletion dialog before starting another action.' }); return; }
					if (msg?.type === 'projectDelete') {
						deletingProject = true;
						const cwd = process.cwd();
						try {
							// Windows cannot recycle a directory held as the host's working directory.
							process.chdir(path.dirname(o.engineDir));
							await projects.handle(msg, m => controller.handle(surface, m));
						} catch (error) { surface.post({ type: 'status', kind: 'error', message: error.message || String(error) }); }
						finally { deletingProject = false; try { process.chdir(cwd); } catch { /* The folder was recycled. */ } }
						return;
					}
					if (msg?.type === 'zcViewState' && msg.state && typeof msg.state === 'object' && JSON.stringify(msg.state).length < 150000) {
						await ctx.workspaceState.update(viewStateKey, msg.state); ctx.workspaceState.flush(); return;
					}
					if (msg?.type === 'zcNotchPreview') { await o.rpc('notchPreview', {}).catch(() => undefined); return; }
					if (msg?.type === 'zcReportAction') {
						const report = prompts.options(msg.id);
						if (report?.kind === 'report') {
							if (msg.action === 'copy') await o.rpc('clipboardWrite', { text: report.content });
							if (msg.action === 'save') {
								const file = await o.rpc('saveDialog', { title: 'Save problem report', filters: [{ name: 'Text', extensions: ['txt'] }] });
								if (typeof file === 'string' && file) await require('fs').promises.writeFile(file, report.content, 'utf8');
							}
						} return;
					}
					const opened = openin.handle(msg, surface.post);
					if (opened) return opened;
					const ours = preferences.handle(msg, surface.post);
					if (ours) return ours;
					// The current folder button is an Explorer action, not a project switch.
					// Activation calls controller.handle directly and never takes this path.
					if (msg && msg.type === 'projectOpen' && msg.sessionId === undefined &&
						typeof msg.path === 'string' && path.isAbsolute(msg.path) && o.workspace &&
						projectPathKey(msg.path) === projectPathKey(o.workspace)) {
						const stat = await require('fs').promises.stat(o.workspace).catch(() => null);
						if (stat && stat.isDirectory()) await o.rpc('openPath', { path: o.workspace });
						return;
					}
					if (msg && msg.type === 'ready') await activating;
					await projects.handle(msg, (m) => controller.handle(surface, m));
					if (msg && msg.type === 'ready') {
						prompts.replay();
						// Cold activation can finish before SSE connects; ready replays both
						// authoritative preferences and its completion marker after controller state.
						await preferences.handle({ type: 'zcDesktopPrefs' }, surface.post);
						activated();
					}
				};
				return { dispose: () => { chatSurface = undefined; attachment.dispose(); }, handle };
			}
		},
		{ desktop: true, commandDir: path.join(o.dataDir, 'command-receipts', require('crypto').createHash('sha256').update(o.workspace || 'start').digest('hex').slice(0, 24)) }
	);
	await server.start(o.port || 0);
	const port = server.info().port;
	return {
		url: `http://127.0.0.1:${port}/?t=${token}`,
		async activate(handoff, id) {
			const attempt = activating.then(async () => {
				if (handoff?.kind === 'session') {
					const session = await store.getSession(handoff.sessionId);
					if (!session || (session.projectPath && o.workspace && projectPathKey(session.projectPath) !== projectPathKey(o.workspace))) throw new Error('This chat is unavailable in the selected project. Choose another chat.');
				}
				// RemoteServer attaches before start returns, even without an SSE client.
				if (o.workspace && handoff?.kind === 'project') await projects.register(o.workspace, handoff.name);
				if (o.workspace && handoff && handoff.kind === 'create') {
					await controller.handle(chatSurface, { type: 'projectNewChat', path: o.workspace });
				} else if (o.workspace && handoff && handoff.kind === 'session' && typeof handoff.sessionId === 'string') {
					await controller.handle(chatSurface, { type: 'projectOpen', path: o.workspace, sessionId: handoff.sessionId });
				}
				// Never synthesize ready: it routes worktree handoffs and page lifecycle.
				if (typeof controller.refreshDesktop === 'function') await controller.refreshDesktop(chatSurface);
				else await controller.sendState(chatSurface);
				await preferences.handle({ type: 'zcDesktopPrefs' }, chatSurface.post);
				await controller.handle(chatSurface, { type: 'getProjects' });
				activationId = id;
				activationView = handoff?.kind === 'files' ? 'files' : undefined;
				activated();
			// The notch's "Open changes": the chat opens on its working-tree changes.
			if (handoff?.kind === 'session' && handoff.review === true) chatSurface?.post({ type: 'zcDesktopReview' });
			});
			activating = attempt.catch(() => undefined);
			await attempt;
		},
		/**
		 * What the notch asks of this project's agent (see app/notch.js act()). Approvals and
		 * answers go by their id, which the controller only honours while that card waits;
		 * stopping, steering, checking, undoing and continuing need the run's chat to be the one
		 * open here; a rule only ever adds ask or deny lines.
		 */
		async notchAct(act) {
			const a = act && typeof act === 'object' ? act : {};
			const surface = chatSurface || { kind: 'chat', post: () => undefined, visible: () => false };
			const handle = (msg) => controller.handle(surface, msg);
			const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : '');
			const here = () => !!a.session && a.session === controller.sessionId;
			switch (a.action) {
				case 'approve':
				case 'reject':
					if (str(a.id, 200)) await handle({ type: a.action, id: a.id });
					return;
				case 'deny':
					if (str(a.id, 200)) await handle({ type: 'reject', id: a.id });
					if (str(a.pattern, 500)) await handle({ type: 'addCommandRule', verdict: 'deny', pattern: a.pattern });
					return;
				case 'ask':
					if (str(a.pattern, 500)) await handle({ type: 'addCommandRule', verdict: 'ask', pattern: a.pattern });
					return;
				case 'answer':
					if (str(a.id, 200)) await handle({ type: 'answer', id: a.id, answer: str(a.answer, 2000) });
					return;
				case 'stop':
					if (here()) await handle({ type: 'stop' });
					return;
				case 'steer':
					if (here() && str(a.text, 4000).trim()) await handle({ type: 'send', text: a.text.trim() });
					return;
				case 'continue':
					if (here()) await handle({ type: 'send', text: 'Continue.' });
					return;
				case 'check':
					if (here()) await handle({ type: 'send', text: 'Run the project\'s checks (tests, build, lint) for the changes you just made, and fix anything that fails.' });
					return;
				case 'undo':
					if (here() && str(a.turn, 200)) await handle({ type: 'undoTurn', id: a.turn });
					return;
				case 'prompt': {
					// Dropped or copied material joins the composer's attachments, then the prompt is sent.
					for (const f of Array.isArray(a.files) ? a.files.slice(0, 8) : []) {
						if (!f || typeof f !== 'object') continue;
						const name = str(f.name, 200) || 'dropped';
						if (typeof f.base64 === 'string' && /^image\/(png|jpeg|gif|webp)$/.test(f.mime) && f.base64.length <= 14_000_000) await handle({ type: 'addImage', name, mime: f.mime, base64: f.base64 });
						else if (typeof f.text === 'string' && f.text.length <= 400_000) await handle({ type: 'addText', name, content: f.text });
					}
					const text = str(a.text, 8000).trim();
					if (text) await handle({ type: 'send', text });
					return;
				}
			}
		},
		/**
		 * One headless turn — `host/main.js --headless`. No page ever attaches, so a
		 * private surface collects the posts; the call resolves with the finished
		 * turn (assistant text, files the turn changed, outcome). `mode` ('full' |
		 * 'agent') decides what runs without approval: 'agent' still asks per tool,
		 * and with nobody to ask, an approval waits forever — 'full' is the default.
		 */
		async headlessRun(text, { mode = 'full', timeoutMs = 0, plan = false, configuration, providerIds = new Map() } = {}) {
			if (configuration) {
				const temporary = path.relative(os.tmpdir(), path.resolve(o.dataDir));
				if (temporary.startsWith('..') || path.isAbsolute(temporary) || !path.basename(o.dataDir).startsWith('zer0ne-eval-data-')) throw new Error('Evaluation configuration requires an isolated temporary data folder.');
				if (!Array.isArray(configuration.providers) || !configuration.providers.length || configuration.providers.length > 8) throw new Error('Evaluation requires 1–8 configured providers.');
				for (const item of configuration.providers) {
					const provider = await store.add(item.provider);
					providerIds.set(item.provider.id, provider.id);
					await store.setApiKey(provider.id, String(item.apiKey || ''));
				}
				const primary = providerIds.get(configuration.primary);
				if (!primary) throw new Error('Evaluation primary provider is missing.');
				await store.updateSettings(configuration.settings || {});
				await store.setSelection(primary, configuration.model);
				if (configuration.effort) await store.setEffort(primary, configuration.model, configuration.effort);
				for (const memory of (configuration.memories || []).slice(0, 20)) await store.retainMemory(String(memory), { source: 'user' });
			}
			if (o.workspace && (store.getSession ? !(await store.getSession(controller.sessionId).catch(() => undefined))?.projectPath : true)) {
				// A fresh host has no chat yet: start one for this workspace.
				try { await controller.handle(chatSurface, { type: 'projectNewChat', path: o.workspace }); } catch { /* an existing chat is fine */ }
			}
			if (mode === 'full' && store.getMode() !== 'full' || mode === 'agent' && store.getMode() !== 'agent') await store.setMode(mode);
			if (configuration?.workflow?.enabled) {
				const remap = spec => { const [id, model] = String(spec || '').split('::'); const mapped = providerIds.get(id); if (!mapped) throw new Error('A workflow provider is missing from the evaluation profile.'); return mapped + '::' + model; };
				await store.setSubagentWorkflow(controller.sessionId, { ...configuration.workflow, workerModel: remap(configuration.workflow.workerModel), reviewerModel: configuration.workflow.review === false ? '' : remap(configuration.workflow.reviewerModel) });
			}
			const usageBefore = new Set(store.getUsageEvents().map(event => event.attemptId));
			const headlessSurface = { kind: 'chat', post: () => undefined, visible: () => false };
			const seen = { state: null };
			const attachment = controller.attach({
				kind: 'chat',
				post: (m) => { if (m && m.type === 'state') seen.state = m; },
				visible: () => false
			});
			try {
				const run = controller.handle(headlessSurface, { type: 'send', text, plan });
				const finished = timeoutMs > 0 ? Promise.race([
					run,
					new Promise((_, reject) => {
						const t = setTimeout(() => {
							try { controller.handle(headlessSurface, { type: 'stop' }); } catch { /* already settled */ }
							reject(new Error(`The headless turn exceeded ${Math.round(timeoutMs / 1000)} s and was stopped.`));
						}, timeoutMs);
						t.unref?.();
					})
				]) : run;
				await finished;
			} finally {
				attachment.dispose();
			}
		const messages = Array.isArray(seen.state?.messages) ? seen.state.messages : [];
		const turns = messages.filter((m) => m.role === 'user' && m.turn);
		const last = turns[turns.length - 1] ?? {};
		const edits = [];
		for (const t of turns) for (const e of t.turn?.edits ?? []) edits.push(e.path);
		// A pre-turn failure (no provider, a blocked hook) is an error message with no turn
		// outcome attached: read it, and never guess success for a turn without an outcome.
		const failure = [...messages].reverse().find((m) => m.role === 'assistant' && m.isError);
		const answer = [...messages].reverse().find((m) => m.role === 'assistant' && !m.kind && !m.local && !m.isError && String(m.content || '').trim()) ?? failure;
		const originals = new Map([...providerIds].map(([original, created]) => [created, original]));
		const attempts = store.getUsageEvents().filter(event => event.attemptId && !usageBefore.has(event.attemptId)).flatMap(event => event.request ? [{ ...event.request, providerId: originals.get(event.request.providerId) || event.request.providerId }] : []);
		return {
			outcome: last.turn?.outcome ?? (failure ? 'failed' : 'unknown'),
			text: String(answer?.content ?? '').trim(),
			files: [...new Set(edits)],
			sessionId: controller.sessionId,
			usage: last.turn?.attempts?.reduce((n, a) => n + (a.usage?.input ?? 0) + (a.usage?.output ?? 0), 0) ?? undefined,
			attempts,
			steps: last.turn?.attempts?.filter(a => a.purpose === 'main' && a.outcome === 'completed').length || 0,
			tools: messages.flatMap(m => m.tool ? [{ name: m.tool.name, failed: m.tool.status === 'error' }] : m.approval ? [{ name: m.approval.kind === 'command' ? 'run_command' : m.approval.kind === 'write' ? 'write_file' : m.approval.kind === 'edit' ? 'edit_file' : m.approval.kind, failed: m.approval.execution === 'error' || m.approval.status === 'rejected' }] : []),
			verification: last.turn?.verification || []
		};
		},
		async stop() {
			prompts.dispose();
			busyReport.dispose();
			await server.stop().catch(() => undefined);
			try {
				// The stdio host exits immediately after stop; await Windows taskkill first.
				await controller.stopTerminal();
				controller.dispose();
			} catch {
				/* best effort */
			}
			shim.dispose?.();
			ownership.release();
			for (const m of [ctx.globalState, ctx.workspaceState]) {
				try {
					m.flush();
				} catch {
					/* best effort */
				}
			}
		}
	};
	} catch (error) { ownership.release(); prompts.dispose(); throw error; }
	} catch (error) { ownership.release(); prompts.dispose(); throw error; }
}

/**
 * "Remove from the list" for the desktop sidebar: the project is hidden (its chats stay
 * saved) until it is added again. The current project always shows.
 */
const PROJECTS_KEY = 'aiChat.projects';
const HIDDEN_KEY = 'zer0neDesktop.hiddenProjects';
function desktopProjects(ctx, projectPathKey, rpc) {
	const state = ctx.globalState;
	let known = new Map();
	const hidden = () => new Set(state.get(HIDDEN_KEY, []));
	const recorded = () => {
		const raw = state.get(PROJECTS_KEY, []);
		return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string') : [];
	};
	return {
		async register(folder, name) {
			const key = projectPathKey(folder);
			if (!recorded().some(p => projectPathKey(p) === key)) await state.update(PROJECTS_KEY, [...recorded(), folder]);
			await state.update('zer0neDesktop.projectName.' + key, name);
			await state.update(HIDDEN_KEY, [...hidden()].filter(id => id !== key));
			state.flush?.();
		},
		filter(m) {
			if (!m || m.type !== 'projects' || !Array.isArray(m.projects)) return m;
			const h = hidden();
			const order = new Map(recorded().map((p, i) => [projectPathKey(p), i]));
			const projects = m.projects.filter((p) => p.current || !h.has(p.id)).sort((a, b) => {
				if (!a.path || !b.path) return Number(!a.path) - Number(!b.path);
				const pins = Number(state.get('zer0neDesktop.projectPinned.' + b.id, false) === true) - Number(state.get('zer0neDesktop.projectPinned.' + a.id, false) === true);
				if (pins) return pins;
				return (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.id.localeCompare(b.id);
			});
			known = new Map(projects.filter(p => p.path && path.isAbsolute(p.path)).map(p => [projectPathKey(p.path), p.path]));
			return { ...m, projects: projects.map(p => ({ ...p, name: state.get('zer0neDesktop.projectName.' + p.id, p.name), pinned: state.get('zer0neDesktop.projectPinned.' + p.id, false) === true })) };
		},
		async handle(msg, send) {
			if (msg?.type === 'projectShowFiles') {
				const folder = typeof msg.path === 'string' && path.isAbsolute(msg.path) && known.get(projectPathKey(msg.path));
				if (!folder || typeof rpc !== 'function') throw new Error('Choose a project from the project list.');
				if (!(await require('fs').promises.stat(folder).catch(() => null))?.isDirectory()) throw new Error('This project folder is unavailable.');
				await rpc('openFolder', { path: folder, newWindow: false, handoff: { kind: 'files' } });
				return;
			}
			if (msg?.type === 'projectRename' || msg?.type === 'projectPin') {
				const folder = typeof msg.path === 'string' && path.isAbsolute(msg.path) && known.get(projectPathKey(msg.path));
				if (!folder) throw new Error('Choose a project from the project list.');
				const key = projectPathKey(folder);
				if (msg.type === 'projectRename') {
					const name = typeof msg.name === 'string' ? msg.name.trim() : '';
					if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Enter a project name of 1–100 characters.');
					await state.update('zer0neDesktop.projectName.' + key, name);
				} else {
					if (typeof msg.pinned !== 'boolean') throw new Error('Choose whether to pin this project.');
					await state.update('zer0neDesktop.projectPinned.' + key, msg.pinned);
				}
				state.flush?.();
				await send({ type: 'getProjects' });
				return;
			}
			if (msg?.type === 'projectDelete') {
				const folder = typeof msg.path === 'string' && path.isAbsolute(msg.path) && known.get(projectPathKey(msg.path));
				if (!folder || typeof rpc !== 'function') throw new Error('Choose a project from the project list.');
				if (!await rpc('deleteProjectFolder', { path: folder })) return;
				const key = projectPathKey(folder);
				await state.update(PROJECTS_KEY, recorded().filter(p => projectPathKey(p) !== key));
				await state.update(HIDDEN_KEY, [...new Set([...hidden(), key])]);
				state.flush?.();
				await send({ type: 'getProjects' });
				await rpc('projectFolderDeleted', { path: folder });
				return;
			}
			if (msg && msg.type === 'projectRemove' && typeof msg.path === 'string' && msg.path) {
				const key = projectPathKey(msg.path);
				await state.update(PROJECTS_KEY, recorded().filter((p) => projectPathKey(p) !== key));
				await state.update(HIDDEN_KEY, [...new Set([...hidden(), key])]);
				await send({ type: 'getProjects' });
				return;
			}
			if (msg && msg.type === 'projectPick') {
				// A folder added again comes back with its chats.
				const before = new Set(recorded().map(projectPathKey));
				await send(msg);
				const added = recorded().map(projectPathKey).filter((k) => !before.has(k));
				if (added.length) {
					const h = hidden();
					added.forEach((k) => h.delete(k));
					await state.update(HIDDEN_KEY, [...h]);
					await send({ type: 'getProjects' });
				}
				return;
			}
			return send(msg);
		}
	};
}

/** Notification preferences follow the latest engine write across project pages. */
const PREFS_KEY = 'zer0neDesktop.preferences';
function desktopPreferences(ctx, rpc) {
	const state = ctx.globalState;
	const clean = (p) => {
		const out = {};
		if (p && typeof p.notify === 'boolean') out.notify = p.notify;
		if (p && p.widths && typeof p.widths === 'object') {
			out.widths = Object.fromEntries(['sidebar', 'auxiliary'].map(id => [id, Number.isFinite(p.widths[id]) && p.widths[id] > 0 ? Math.round(Math.max(280, Math.min(620, p.widths[id]))) : 0]));
		}
		if (p && p.panel && typeof p.panel === 'object') {
			const folds = Object.entries(p.panel.folds || {}).filter(([key, value]) => key.length <= 2048 && typeof value === 'boolean').slice(0, 500);
			out.panel = { scroll: Number.isFinite(p.panel.scroll) ? Math.max(0, Math.min(1e7, p.panel.scroll)) : 0, folds: Object.fromEntries(folds) };
		}
		return out;
	};
	// The shell keeps its own copy (it rings the OS notification); sync it whenever the
	// saved preference differs from what we last told it. The shell link is optional
	// (tests, callers without one).
	let sent = null;
	const sync = (prefs) => {
		if (typeof rpc !== 'function') return;
		const on = prefs.notify !== false;
		if (on === sent) return;
		sent = on;
		void rpc('setNotify', { on }).catch(() => undefined);
	};
	const defaults = { notify: true };
	// Preserve the bell setting while dropping the removed layout's saved controls.
	const legacy = state.get('zer0neDesktop.layout');
	const background = state.get('zer0neDesktop.background');
	const migrated = (async () => {
		if (legacy !== undefined) {
			await state.update(PREFS_KEY, clean(state.get(PREFS_KEY, legacy)));
			await state.update('zer0neDesktop.layout', undefined);
		}
		if (background !== undefined) await state.update('zer0neDesktop.background', undefined);
		if ((legacy !== undefined || background !== undefined) && typeof state.flush === 'function') state.flush();
	})();
	const read = () => ({ ...defaults, ...clean(state.get(PREFS_KEY, {})) });
	let updates = migrated;
	return {
		read,
		/** A promise when the message was a preferences request; false to pass it on. */
		handle(msg, post) {
			if (!msg || msg.type !== 'zcDesktopPrefs') return false;
			const result = updates.then(async () => {
				if (msg.prefs) {
					await state.update(PREFS_KEY, { ...clean(state.get(PREFS_KEY, {})), ...clean(msg.prefs) });
					if (typeof state.flush === 'function') state.flush();
				}
				const prefs = read();
				sync(prefs);
				post({ type: 'zcDesktopPrefs', prefs });
			});
			updates = result.catch(() => undefined);
			return result;
		}
	};
}

/**
 * "Open this folder in…" (the desktop top bar): the page only names a target,
 * the shell owns the folder path and launches the tool. The folder's name and
 * what is installed come back once, so the menu can disable what is missing.
 */
function desktopOpenIn(rpc) {
	return {
		handle(msg, post) {
			if (!msg || !msg.type) return false;
			if (msg.type === 'zcOpenTargets') {
				void rpc('openInTargets')
					.then((info) => post({ type: 'zcOpenTargets', info: info || null }))
					.catch(() => post({ type: 'zcOpenTargets', info: null }));
				return Promise.resolve();
			}
			if (msg.type === 'zcOpenIn' && typeof msg.target === 'string') {
				void rpc('openIn', { target: msg.target }).catch(error => post({ type: 'status', kind: 'error', message: error.message || String(error) }));
				return true;
			}
			if (msg.type === 'zcCopyFolder' && typeof msg.path === 'string') {
				void rpc('clipboardWrite', { text: msg.path }).catch(() => undefined);
				return true;
			}
			return false;
		}
	};
}

module.exports = { startHost, desktopProjects, desktopPreferences, desktopOpenIn, createNotifier, createBusyReporter, createNotchSync, notchPrefs, runPhase, runStuck, runBudget, runAgents, runResult, runGoal, cloudLanes };
