import { parseToolArgs } from './tools/argRepair';

/**
 * The on-machine benchmark (Settings → Local models): one speed run and four
 * agent checks against a model served on an OpenAI-compatible endpoint
 * (zer0ne Engine, Ollama, LM Studio…). llama.cpp reports exact timings; other
 * servers are timed from the outside. No vscode dependency (tested with a mock server).
 */

export interface BenchCheck {
	id: 'tool_pick' | 'tool_args' | 'restraint' | 'json';
	label: string;
	ok: boolean;
	note: string;
}

export interface BenchResult {
	at: number;
	backend?: string;
	/** Generation speed (tokens/s after the first token). */
	tokS?: number;
	/** Prompt processing speed (tokens/s). */
	promptTokS?: number;
	/** Time to the first token (ms). */
	ttftMs?: number;
	/** Agent readiness: share of the checks passed (0–100). */
	score: number;
	checks: BenchCheck[];
	error?: string;
}

const TOOLS = [
	{ type: 'function', function: { name: 'read_file', description: 'Read a file of the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'] } } },
	{ type: 'function', function: { name: 'grep', description: 'Search the workspace for a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
	{ type: 'function', function: { name: 'edit_file', description: 'Replace old_string with new_string in a file. old_string must match the file exactly.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } }
];
const SYSTEM = 'You are a coding agent. Use the tools when you need to look at or change files; answer directly when you do not. Tool arguments are one JSON object matching the schema.';

interface Reply {
	text: string;
	calls: Array<{ name: string; arguments: string }>;
	timings?: { prompt_per_second?: number; predicted_per_second?: number; prompt_ms?: number };
	usage?: { completion_tokens?: number };
	ms: number;
}

async function chat(base: string, model: string, body: Record<string, unknown>, apiKey: string | undefined, signal?: AbortSignal): Promise<Reply> {
	const started = Date.now();
	const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
		body: JSON.stringify({ model, temperature: 0, stream: false, ...body }),
		signal: signal ?? AbortSignal.timeout(180_000)
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
	const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>; timings?: Reply['timings']; usage?: Reply['usage'] };
	const msg = j.choices?.[0]?.message ?? {};
	return {
		text: String(msg.content ?? ''),
		calls: (msg.tool_calls ?? []).map((c) => ({ name: String(c.function?.name ?? ''), arguments: String(c.function?.arguments ?? '') })),
		timings: j.timings,
		usage: j.usage,
		ms: Date.now() - started
	};
}

const strictJson = (s: string) => {
	try {
		const v = JSON.parse(s);
		return !!v && typeof v === 'object' && !Array.isArray(v);
	} catch {
		return false;
	}
};

/** Run the benchmark against `base` (…/v1). Every step is independent: one failing check does not stop the rest. */
export async function benchmarkModel(base: string, model: string, o: { apiKey?: string; backend?: string; signal?: AbortSignal; onStage?: (s: string) => void } = {}): Promise<BenchResult> {
	const checks: BenchCheck[] = [];
	const result: BenchResult = { at: Date.now(), backend: o.backend, score: 0, checks };
	const calls: Array<{ name: string; arguments: string }> = [];
	// 1. Speed: a short, code-shaped answer (warm-up first, so loading is not counted).
	try {
		o.onStage?.('Warming up…');
		await chat(base, model, { messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 4 }, o.apiKey, o.signal);
		o.onStage?.('Measuring speed…');
		const r = await chat(base, model, { messages: [{ role: 'system', content: 'You are a helpful coding assistant.' }, { role: 'user', content: 'Write a TypeScript function debounce(fn, ms) with a short JSDoc comment. Code only.' }], max_tokens: 200 }, o.apiKey, o.signal);
		if (r.timings?.predicted_per_second) {
			result.tokS = Math.round(r.timings.predicted_per_second * 10) / 10;
			result.promptTokS = r.timings.prompt_per_second ? Math.round(r.timings.prompt_per_second) : undefined;
			result.ttftMs = r.timings.prompt_ms ? Math.round(r.timings.prompt_ms) : undefined;
		} else if (r.usage?.completion_tokens) {
			result.tokS = Math.round((r.usage.completion_tokens / (r.ms / 1000)) * 10) / 10; // wall clock: includes the prompt
		}
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
		return result; // the model does not answer at all: no point in the checks
	}
	// 2. Picks the right tool with the right argument.
	try {
		o.onStage?.('Checking tool calls…');
		const r = await chat(base, model, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Open src/server.ts and tell me which port it listens on.' }], tools: TOOLS, max_tokens: 300 }, o.apiKey, o.signal);
		calls.push(...r.calls);
		const c = r.calls[0];
		const args = c ? parseToolArgs(c.arguments) : undefined;
		const ok = r.calls.length === 1 && c?.name === 'read_file' && args?.path === 'src/server.ts';
		checks.push({ id: 'tool_pick', label: 'Picks the right tool', ok, note: c ? `${c.name}(${c.arguments.slice(0, 80)})` : r.text ? 'answered without a tool' : 'no reply' });
	} catch (e) {
		checks.push({ id: 'tool_pick', label: 'Picks the right tool', ok: false, note: e instanceof Error ? e.message.slice(0, 120) : String(e) });
	}
	// 3. Fills a multi-argument edit exactly.
	try {
		const r = await chat(base, model, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'The file src/config.ts contains exactly:\n```ts\nconst PORT = 3000;\nexport default PORT;\n```\nChange the port to 8080 with edit_file.' }], tools: TOOLS, max_tokens: 300 }, o.apiKey, o.signal);
		calls.push(...r.calls);
		const c = r.calls.find((x) => x.name === 'edit_file');
		const args = c ? parseToolArgs(c.arguments) : undefined;
		const original = 'const PORT = 3000;\nexport default PORT;';
		const expected = 'const PORT = 8080;\nexport default PORT;';
		// No tools execute: validate the proposed replacement against the synthetic file.
		const ok = r.calls.length === 1 && args?.path === 'src/config.ts' && typeof args.old_string === 'string' && !!args.old_string && typeof args.new_string === 'string'
			&& original.includes(args.old_string) && original.replace(args.old_string, args.new_string) === expected;
		checks.push({ id: 'tool_args', label: 'Fills edit arguments exactly', ok, note: c ? `edit_file ${String(args?.old_string ?? '?').slice(0, 30)} → ${String(args?.new_string ?? '?').slice(0, 30)}` : r.calls[0] ? `called ${r.calls[0].name} instead` : 'no edit_file call' });
	} catch (e) {
		checks.push({ id: 'tool_args', label: 'Fills edit arguments exactly', ok: false, note: e instanceof Error ? e.message.slice(0, 120) : String(e) });
	}
	// 4. Answers a plain question without reaching for a tool.
	try {
		const r = await chat(base, model, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'What does HTTP status 404 mean? One sentence.' }], tools: TOOLS, max_tokens: 120 }, o.apiKey, o.signal);
		calls.push(...r.calls);
		const ok = !r.calls.length && r.text.trim().length > 5;
		checks.push({ id: 'restraint', label: 'Answers without needless tools', ok, note: r.calls.length ? `called ${r.calls[0].name}` : r.text.trim().slice(0, 80) });
	} catch (e) {
		checks.push({ id: 'restraint', label: 'Answers without needless tools', ok: false, note: e instanceof Error ? e.message.slice(0, 120) : String(e) });
	}
	// 5. Its tool arguments are valid JSON as written (no repair needed).
	const strict = calls.filter((c) => strictJson(c.arguments)).length;
	checks.push({ id: 'json', label: 'Writes valid JSON arguments', ok: calls.length > 0 && strict === calls.length, note: calls.length ? `${strict} of ${calls.length} valid as written` : 'no tool calls to check' });
	result.score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
	return result;
}
