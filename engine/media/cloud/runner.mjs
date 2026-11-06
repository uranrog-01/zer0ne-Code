#!/usr/bin/env node
/*
 * zer0ne cloud runner — the zer0ne agent, headless, inside a GitHub Actions VM.
 * Installed by zer0ne coding as .zer0ne/cloud/runner.mjs; started by
 * .github/workflows/zer0ne-cloud.yml. No dependencies (Node 20+).
 *
 * Environment:
 *   ZER0NE_TASK        what to do (required)
 *   ZER0NE_MODEL       model id (required)
 *   ZER0NE_BASE_URL    provider base URL (required)
 *   ZER0NE_FORMAT      openai | anthropic (default openai)
 *   ZER0NE_API_KEY     provider key (repository secret)
 *   ZER0NE_MAX_STEPS   tool round-trips (default 40)
 *   ZER0NE_OUT         folder for summary.md / commit.txt (default $RUNNER_TEMP/zer0ne)
 *
 * Log protocol (read back by the extension from the job log):
 *   ZER0NE_STEP {"tool":"read_file","arg":"src/a.ts","ok":true}
 *   ZER0NE_SUMMARY_BEGIN … ZER0NE_SUMMARY_END
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const TASK = env.ZER0NE_TASK || '';
const MODEL = env.ZER0NE_MODEL || '';
const BASE = (env.ZER0NE_BASE_URL || '').replace(/\/+$/, '');
const FORMAT = env.ZER0NE_FORMAT === 'anthropic' ? 'anthropic' : 'openai';
const KEY = env.ZER0NE_API_KEY || '';
const MAX_STEPS = Math.max(1, Math.min(200, Number(env.ZER0NE_MAX_STEPS) || 40));
const OUT = env.ZER0NE_OUT || path.join(env.RUNNER_TEMP || '/tmp', 'zer0ne');
const ROOT = process.cwd();
const SKIP = /(^|\/)(node_modules|\.git|dist|build|out|\.next|coverage|__pycache__|\.venv)(\/|$)/;

if (!TASK || !MODEL || !BASE) {
	console.error('zer0ne: ZER0NE_TASK, ZER0NE_MODEL and ZER0NE_BASE_URL are required.');
	process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- tools

const inRoot = (p) => {
	const abs = path.resolve(ROOT, String(p || '.'));
	if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('Path is outside the repository.');
	return abs;
};
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');
function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, e.name);
		const r = rel(abs);
		if (SKIP.test(r)) continue;
		if (e.isDirectory()) walk(abs, out);
		else out.push(r);
		if (out.length > 5000) break;
	}
	return out;
}
function globRe(glob) {
	const g = String(glob || '**/*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
	return new RegExp('^' + g + '$');
}
function sh(command, timeoutMs) {
	return new Promise((resolve) => {
		execFile('bash', ['-lc', command], { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...env, ZER0NE_API_KEY: '' } }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
			resolve({ code, out: (String(stdout) + (stderr ? '\n' + String(stderr) : '')).trim(), timedOut: !!(err && err.killed) });
		});
	});
}
const clip = (s, n = 30000) => (s.length > n ? s.slice(0, n * 0.4) + `\n[… ${s.length - n} chars trimmed …]\n` + s.slice(s.length - n * 0.6) : s);

const TOOLS = [
	{ name: 'list_files', description: 'List repository files matching a glob (e.g. "src/**/*.ts").', parameters: { type: 'object', properties: { glob: { type: 'string' } } } },
	{ name: 'read_file', description: 'Read a text file (optionally a line range).', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: '1-based first line' }, limit: { type: 'number' } }, required: ['path'] } },
	{ name: 'grep', description: 'Search file contents with a regular expression.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
	{ name: 'write_file', description: 'Create or overwrite a file with the full content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
	{ name: 'edit_file', description: 'Replace one exact, unique occurrence of `find` with `replace` in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } },
	{ name: 'run_command', description: 'Run a shell command in the repository (install, build, test…). Output is returned.', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'number' } }, required: ['command'] } },
	{ name: 'finish', description: 'Call when the task is done: a short summary of what changed and how it was verified.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }
];

async function runTool(name, a) {
	switch (name) {
		case 'list_files': {
			const re = globRe(a.glob);
			const files = walk(ROOT).filter((f) => re.test(f));
			return [files.slice(0, 600).join('\n') || '(no files matched)', `${files.length} files`];
		}
		case 'read_file': {
			const text = fs.readFileSync(inRoot(a.path), 'utf8');
			const lines = text.split('\n');
			const start = Math.max(1, Number(a.offset) || 1);
			const end = Math.min(lines.length, start - 1 + (Number(a.limit) || 800));
			return [lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join('\n') + (end < lines.length ? `\n[… ${lines.length - end} more lines]` : ''), `${end - start + 1} lines`];
		}
		case 'grep': {
			const re = new RegExp(String(a.pattern), 'i');
			const gre = a.glob ? globRe(a.glob) : null;
			const hits = [];
			for (const f of walk(ROOT)) {
				if (gre && !gre.test(f)) continue;
				let text;
				try {
					text = fs.readFileSync(path.join(ROOT, f), 'utf8');
				} catch {
					continue;
				}
				if (text.includes('\u0000')) continue;
				text.split('\n').forEach((l, i) => re.test(l) && hits.length < 300 && hits.push(`${f}:${i + 1}: ${l.slice(0, 200)}`));
				if (hits.length >= 300) break;
			}
			return [hits.join('\n') || '(no matches)', `${hits.length} matches`];
		}
		case 'write_file': {
			const abs = inRoot(a.path);
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, String(a.content ?? ''));
			return [`Wrote ${rel(abs)}.`, 'written'];
		}
		case 'edit_file': {
			const abs = inRoot(a.path);
			const text = fs.readFileSync(abs, 'utf8');
			const find = String(a.find ?? '');
			const at = text.indexOf(find);
			if (!find || at < 0) throw new Error('`find` text not found — read the file again and copy it exactly.');
			if (text.indexOf(find, at + 1) >= 0) throw new Error('`find` matches more than once — include more surrounding lines.');
			fs.writeFileSync(abs, text.slice(0, at) + String(a.replace ?? '') + text.slice(at + find.length));
			return [`Edited ${rel(abs)}.`, 'edited'];
		}
		case 'run_command': {
			const r = await sh(String(a.command), Math.min(1800, Number(a.timeout_seconds) || 600) * 1000);
			return [clip(`exit code ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${r.out}`), r.code === 0 ? 'exit 0' : `exit ${r.code}`];
		}
		default:
			throw new Error(`Unknown tool ${name}`);
	}
}

// ---------------------------------------------------------------- model

async function http(url, headers, body) {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
		if (res.ok) return res.json();
		const text = await res.text();
		if ((res.status === 429 || res.status >= 500) && attempt < 4) {
			await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
			continue;
		}
		throw new Error(`Provider error ${res.status}: ${text.slice(0, 400)}`);
	}
}

async function callModel(system, messages) {
	if (FORMAT === 'anthropic') {
		const base = BASE.replace(/\/v1\/(messages|models)$/i, '').replace(/\/(messages|models)$/i, '');
		const url = /\/v1$/i.test(base) ? base + '/messages' : base + '/v1/messages';
		const json = await http(url, { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }, {
			model: MODEL,
			max_tokens: 8192,
			system,
			messages,
			tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
		});
		const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
		const calls = (json.content || []).filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
		return { text, calls, raw: json.content || [] };
	}
	const url = BASE.replace(/\/(chat\/completions|models)$/i, '') + '/chat/completions';
	const json = await http(url, KEY ? { Authorization: `Bearer ${KEY}` } : {}, {
		model: MODEL,
		messages: [{ role: 'system', content: system }, ...messages],
		tools: TOOLS.map((t) => ({ type: 'function', function: t }))
	});
	const msg = json.choices?.[0]?.message || {};
	const calls = (msg.tool_calls || []).map((c) => {
		let args = {};
		try {
			args = JSON.parse(c.function?.arguments || '{}');
		} catch {
			args = {};
		}
		return { id: c.id, name: c.function?.name, args };
	});
	return { text: msg.content || '', calls, raw: msg };
}

// ---------------------------------------------------------------- loop

const system = [
	'You are zer0ne, an autonomous coding agent running in a cloud VM (GitHub Actions, Ubuntu) on a fresh checkout of this repository.',
	'Nobody can answer questions: make reasonable decisions and keep going. Work in small verified steps: explore, edit, then run the build/tests to verify.',
	'Use edit_file for targeted changes and write_file for new files. Never print or commit secrets. Do not push or open PRs — the workflow does that.',
	'When done, call finish with a concise summary (what changed, why, how it was verified).',
	`Date: ${new Date().toISOString().slice(0, 10)}. Repository root: ${ROOT}.`
].join('\n');

const messages = [{ role: 'user', content: TASK }];
let summary = '';
const steps = [];
const started = Date.now();
console.log(`zer0ne ▸ ${MODEL} (${FORMAT}) · task: ${TASK.slice(0, 200)}`);

for (let step = 0; step < MAX_STEPS && !summary; step++) {
	const r = await callModel(system, messages);
	if (r.text.trim()) console.log(`\n${r.text.trim()}\n`);
	if (!r.calls.length) {
		summary = r.text.trim() || 'Finished.';
		break;
	}
	if (FORMAT === 'anthropic') messages.push({ role: 'assistant', content: r.raw });
	else messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.raw.tool_calls });
	const results = [];
	for (const c of r.calls) {
		if (c.name === 'finish') {
			summary = String(c.args.summary || r.text || 'Finished.');
			results.push({ id: c.id, content: 'ok' });
			continue;
		}
		const arg = c.args.path || c.args.command || c.args.pattern || c.args.glob || '';
		let content;
		let ok = true;
		let note = '';
		try {
			[content, note] = await runTool(c.name, c.args);
		} catch (e) {
			ok = false;
			content = `Error: ${e instanceof Error ? e.message : String(e)}`;
			note = 'error';
		}
		steps.push({ tool: c.name, arg: String(arg).slice(0, 160), ok, note });
		console.log(`ZER0NE_STEP ${JSON.stringify(steps[steps.length - 1])}`);
		results.push({ id: c.id, content: clip(String(content)) });
	}
	if (FORMAT === 'anthropic') messages.push({ role: 'user', content: results.map((x) => ({ type: 'tool_result', tool_use_id: x.id, content: x.content })) });
	else for (const x of results) messages.push({ role: 'tool', tool_call_id: x.id, content: x.content });
}
if (!summary) summary = `Stopped after ${MAX_STEPS} steps. Continue with a follow-up to keep going.`;

const took = Math.round((Date.now() - started) / 1000);
const edited = [...new Set(steps.filter((s) => s.ok && (s.tool === 'edit_file' || s.tool === 'write_file')).map((s) => s.arg))];
const md = `${summary}\n\n---\n_zer0ne cloud · ${MODEL} · ${steps.length} steps · ${took}s_` + (edited.length ? `\n\nFiles: ${edited.map((f) => '`' + f + '`').join(', ')}` : '');
fs.writeFileSync(path.join(OUT, 'summary.md'), md);
const title = TASK.split('\n')[0].slice(0, 68);
fs.writeFileSync(path.join(OUT, 'commit.txt'), `zer0ne: ${title}\n\n${summary}\n`);
fs.writeFileSync(path.join(OUT, 'title.txt'), `zer0ne: ${title}`);
console.log('ZER0NE_SUMMARY_BEGIN');
console.log(summary);
console.log('ZER0NE_SUMMARY_END');
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## zer0ne cloud task\n\n**Task:** ${TASK}\n\n${md}\n`);
