import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * A project's command rules, `.zer0ne/command-rules`: one rule per line,
 *
 *   allow: npm test        run without a card (a single simple command only)
 *   ask:   git push*       always show a card, even in Full access
 *   deny:  rm -rf *        never run, whatever the mode
 *
 * `*` matches anything; everything else is literal; `#` starts a comment.
 * Deny outranks ask, ask outranks allow. Deny and ask are checked against every
 * part of a chained, piped, backgrounded or substituted command, so
 * `npm test & rm -rf build` and `echo $(rm -rf build)` still hit `rm -rf *`.
 *
 * The file ships with the repository, so it cannot loosen anything on its own:
 * an allow line applies only once the user trusted it (Settings → Agent), and a
 * deny or ask line the user trusted keeps applying after the file drops it.
 * Tightening (new deny or ask lines) applies at once.
 */
export type CommandVerdict = 'allow' | 'ask' | 'deny';
export interface CommandRules { allow: RegExp[]; ask: RegExp[]; deny: RegExp[]; pending?: RegExp[]; reason: Map<RegExp, string> }
export type RuleLines = Record<CommandVerdict, string[]>;
/** Why each rule exists, keyed by its normalized text: `allow: npm test # runs the suite`. */
export type RuleReasons = Record<CommandVerdict, Record<string, string>>;

export const COMMAND_RULES_FILE = path.join('.zer0ne', 'command-rules');

/** Anything that chains, pipes, groups, substitutes or redirects: never allowed without a card. PowerShell runs `(…)` arguments as commands. */
export const COMPOUND = /[;&|`<>(){}]|\$\(|\r|\n/;

function pattern(glob: string): RegExp {
	const body = normalize(glob).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp(`^${body}$`, process.platform === 'win32' ? 'i' : '');
}

function normalize(text: string): string {
	return text.trim().replace(/\s+/g, ' ');
}

export function ruleLines(text: string): RuleLines {
	const lines: RuleLines = { allow: [], ask: [], deny: [] };
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/(^|\s)#.*$/, '').trim();
		const m = /^(allow|ask|deny)\s*:\s*(.+)$/i.exec(line);
		if (m) lines[m[1].toLowerCase() as CommandVerdict].push(normalize(m[2]));
	}
	return lines;
}

/** The ` # reason` tail of each rule line; a line without one has no recorded reason. */
export function ruleReasons(text: string): RuleReasons {
	const reasons: RuleReasons = { allow: {}, ask: {}, deny: {} };
	for (const raw of text.split(/\r?\n/)) {
		const hash = raw.search(/\s+#\s?/);
		const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
		const m = /^(allow|ask|deny)\s*:\s*(.+)$/i.exec(line);
		if (!m) continue;
		const why = hash >= 0 ? raw.slice(hash).replace(/^\s+#\s?/, '').trim() : '';
		if (why) reasons[m[1].toLowerCase() as CommandVerdict][normalize(m[2])] = why;
	}
	return reasons;
}

function compile(lines: RuleLines, reasons?: RuleReasons): CommandRules {
	const reason = new Map<RegExp, string>();
	const list = (verdict: CommandVerdict) =>
		lines[verdict].map((text) => {
			const re = pattern(text);
			const why = reasons?.[verdict][text];
			if (why) reason.set(re, why);
			return re;
		});
	return { allow: list('allow'), ask: list('ask'), deny: list('deny'), reason };
}

/** Rules exactly as written, trusted (the user's own text). */
export function parseCommandRules(text: string): CommandRules {
	return compile(ruleLines(text), ruleReasons(text));
}

// ---- trust: one small file per project under the engine's storage, outside any repository

let trustDir: string | undefined;

/** Where trusted rules are kept. Until it is set no allow line applies. */
export function setCommandRulesTrustDir(dir: string | undefined): void {
	trustDir = dir;
}

function projectKey(root: string): string {
	let real = root;
	try { real = fs.realpathSync(root); } catch { /* a missing folder has no rules */ }
	return process.platform === 'win32' ? real.toLowerCase() : real;
}

function trustFile(root: string): string | undefined {
	return trustDir && path.join(trustDir, crypto.createHash('sha256').update(projectKey(root)).digest('hex').slice(0, 32) + '.json');
}

function readTrusted(root: string): RuleLines | undefined {
	const file = trustFile(root);
	if (!file) return undefined;
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (data?.root !== projectKey(root)) return undefined;
		const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
		return { allow: list(data.allow), ask: list(data.ask), deny: list(data.deny) };
	} catch {
		return undefined;
	}
}

function readFileRules(root: string): { lines: RuleLines; reasons: RuleReasons } | undefined {
	try {
		const text = fs.readFileSync(path.join(root, COMMAND_RULES_FILE), 'utf8');
		return { lines: ruleLines(text), reasons: ruleReasons(text) };
	} catch {
		return undefined;
	}
}

function readLines(root: string): RuleLines | undefined {
	return readFileRules(root)?.lines;
}

const union = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];

/** The rules of the project at `root`, as far as the user trusted them; an absent or unreadable file means no rules. */
export function readCommandRules(root: string): CommandRules {
	const file = readFileRules(root);
	const current = file?.lines ?? { allow: [], ask: [], deny: [] };
	const trusted = readTrusted(root);
	const rules = compile(
		{
			allow: current.allow.filter((line) => trusted?.allow.includes(line)),
			ask: union(current.ask, trusted?.ask),
			deny: union(current.deny, trusted?.deny)
		},
		file?.reasons
	);
	const pending = current.allow.filter((line) => !trusted?.allow.includes(line));
	return pending.length ? { ...rules, pending: pending.map(pattern) } : rules;
}

export interface CommandRulesStatus {
	exists: boolean;
	rules: RuleLines;
	/** Allow lines waiting for the user's trust. */
	pendingAllow: string[];
	/** Deny and ask lines the file dropped since the user trusted it (they still apply). */
	kept: string[];
	trusted: boolean;
}

export function commandRulesStatus(root: string): CommandRulesStatus {
	const current = readLines(root);
	const trusted = readTrusted(root);
	const rules = current ?? { allow: [], ask: [], deny: [] };
	const kept = trusted ? [...trusted.deny.filter((l) => !rules.deny.includes(l)).map((l) => `deny: ${l}`), ...trusted.ask.filter((l) => !rules.ask.includes(l)).map((l) => `ask: ${l}`)] : [];
	return { exists: !!current, rules, pendingAllow: rules.allow.filter((l) => !trusted?.allow.includes(l)), kept, trusted: !!trusted };
}

/** Trust the file as it is now: its allow lines apply, and its deny and ask lines stay in force if the file later drops them. */
export function trustCommandRules(root: string): void {
	const file = trustFile(root);
	if (!file) throw new Error('Command rules cannot be trusted here.');
	const lines = readLines(root) ?? { allow: [], ask: [], deny: [] };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ root: projectKey(root), ...lines }, null, 2));
}

/** Appends an ask or deny line (only tightening: allow lines are written by hand and then trusted). Returns false when the rule was already there. */
export function addCommandRule(root: string, verdict: 'ask' | 'deny', glob: string): boolean {
	const line = normalize(glob);
	if (!line || line.length > 500 || /[\r\n#]/.test(glob)) throw new Error('A rule is one line without #.');
	const file = path.join(root, COMMAND_RULES_FILE);
	const current = readLines(root);
	if (current?.[verdict].includes(line)) return false;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let text = '';
	try { text = fs.readFileSync(file, 'utf8'); } catch { text = '# Command rules: allow / ask / deny, one per line (see the zer0ne README).\n'; }
	fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${verdict}: ${line}\n`);
	return true;
}

export function untrustCommandRules(root: string): void {
	const file = trustFile(root);
	if (file) fs.rmSync(file, { force: true });
}

// ---- matching

// Wrappers that run the rest of the line as a command of its own.
const WRAPPER = /^(?:&|\.|!|call|exec|nohup|time|sudo|command|builtin|iex|invoke-expression|start-process|start|cmd(?:\.exe)?\s+\/[ck]|(?:powershell|pwsh)(?:\.exe)?(?:\s+-(?!c\b|command\b|e\b|encodedcommand\b)\w+)*\s+-c(?:ommand)?|(?:ba|z|da|k)?sh\s+-c|env(?:\s+\w+=\S*)*)\s+/i;

/** Every command the line can run: the whole line, each chained part, each substitution's body, each without its quotes or wrapper. */
export function commandParts(command: string): string[] {
	const whole = command.trim();
	const pieces = [whole];
	// Substitutions run their bodies: $(…), `…`, <(…), and PowerShell's (…), @(…), {…}.
	for (const m of whole.matchAll(/`([^`]*)`/g)) pieces.push(m[1]);
	pieces.push(...whole.split(/&&|\|\||[;&|\r\n()`{}]|\$\(|@\(|<\(/));
	const out = new Set<string>();
	for (let piece of pieces) {
		piece = normalize(piece);
		for (let i = 0; piece && i < 4; i++) {
			out.add(piece);
			const unquoted = normalize(piece.replace(/["']/g, ''));
			out.add(unquoted);
			const first = unquoted.replace(/^(\S+?)\.exe\b/i, '$1');
			out.add(first);
			const inner = first.replace(WRAPPER, '');
			if (inner === first) break;
			piece = inner;
		}
	}
	out.delete('');
	return [...out];
}

export function commandVerdict(rules: CommandRules, command: string): CommandVerdict | undefined {
	const whole = command.trim();
	const parts = commandParts(whole);
	if (rules.deny.some((r) => parts.some((p) => r.test(p)))) return 'deny';
	if (rules.ask.some((r) => parts.some((p) => r.test(p)))) return 'ask';
	if (!COMPOUND.test(whole) && rules.allow.some((r) => r.test(normalize(whole)))) return 'allow';
	return undefined;
}

/** A single simple command an allow line would run without a card, once the user trusts the file. */
export function waitsForTrust(rules: CommandRules, command: string): boolean {
	const whole = command.trim();
	return !!rules.pending?.length && !COMPOUND.test(whole) && rules.pending.some((r) => r.test(normalize(whole)));
}

/** The reason recorded on the rule that produced `verdict`, if the rule line carries one. */
export function commandRuleReason(rules: CommandRules, command: string, verdict: CommandVerdict): string | undefined {
	const list = verdict === 'deny' ? rules.deny : verdict === 'ask' ? rules.ask : rules.allow;
	const whole = command.trim();
	const parts = verdict === 'allow' ? [normalize(whole)] : commandParts(whole);
	for (const rule of list) {
		if (parts.some((part) => rule.test(part))) return rules.reason.get(rule);
	}
	return undefined;
}
