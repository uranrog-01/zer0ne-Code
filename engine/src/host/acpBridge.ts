import * as fs from 'fs';
import * as path from 'path';
import type { AcpPermissionRequest, AcpToolEvent, AcpTurnHooks } from '../acp/types';
import type { AgentSettings, StoredMessage } from '../providerStore';
import type { ApprovalHandle, ApprovalRequest } from '../tools/agentTools';
import { commandVerdict, readCommandRules, waitsForTrust } from '../tools/commandRules';

/**
 * What an ACP agent gets for one chat turn (see src/acp): zer0ne's approval
 * cards for the steps it asks about, file reads and writes inside the
 * workspace (writes are snapshotted for Undo / Review), and a card for
 * everything it does. Agents that edit on their own (OpenCode does not ask)
 * still get Undo: the file is read just before their edit tool runs.
 */

export interface AcpBridgeDeps {
	cwd: string;
	chatId: string;
	convo: StoredMessage[];
	settings: AgentSettings;
	planMode: boolean;
	/** No git tree tracker for this folder: fall back to reading a file when its edit starts (best effort, can race the write). */
	eventUndo: boolean;
	requestApproval(request: ApprovalRequest): Promise<ApprovalHandle>;
	/** The auto-approval rule for a request (Full access, edits, allowlist…), if any. */
	rule(request: ApprovalRequest): string | undefined;
	recordChange(relPath: string, before: string | null, after: string): void;
	scheduleState(): void;
	status(message: string): void;
	onTodos?(todos: Array<{ text: string; done: boolean }>): void;
}

/** Same shape as providerStore.newId (kept local so this module stays free of vscode). */
const newId = (prefix: string): string => prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** A path the agent gave (absolute or relative) as an absolute path inside the workspace, or undefined (pure enough; tested). */
export function insideWorkspace(cwd: string, p: string): string | undefined {
	const root = path.resolve(cwd);
	const full = path.resolve(root, p);
	if (norm(full) !== norm(root) && !norm(full).startsWith(norm(root) + path.sep)) return undefined;
	// A link inside the workspace must not lead out of it.
	let probe = full;
	while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
	try {
		const real = fs.realpathSync(probe);
		const realRoot = fs.realpathSync(root);
		if (norm(real) !== norm(realRoot) && !norm(real).startsWith(norm(realRoot) + path.sep)) return undefined;
	} catch {
		return undefined;
	}
	return full;
}

const readOrNull = (file: string): string | null => {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
};

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

export function makeAcpHooks(d: AcpBridgeDeps): AcpTurnHooks {
	const cards = new Map<string, StoredMessage>();
	/** Approval cards of permission requests, finished when the tool ends. */
	const finish = new Map<string, ApprovalHandle['finish']>();
	/** Steps whose approval card stands for them: no activity card, ever. */
	const approvedIds = new Set<string>();
	/** File contents from just before an agent edit (for Undo), keyed by absolute path. */
	const before = new Map<string, string | null>();
	const rel = (abs: string) => path.relative(path.resolve(d.cwd), abs).split(path.sep).join('/');

	const snapshot = (p: string | undefined) => {
		if (!d.eventUndo) return;
		const abs = p && insideWorkspace(d.cwd, p);
		if (abs && !before.has(abs)) before.set(abs, readOrNull(abs));
	};
	const conclude = (p: string | undefined) => {
		if (!d.eventUndo) return;
		const abs = p && insideWorkspace(d.cwd, p);
		if (!abs || !before.has(abs)) return;
		const was = before.get(abs)!;
		const now = readOrNull(abs);
		if (now !== null && now !== was) d.recordChange(rel(abs), was, now);
		before.delete(abs);
	};

	return {
		cwd: d.cwd,
		chatId: d.chatId,
		planMode: d.planMode,
		status: d.status,
		plan: (entries) => d.onTodos?.(entries.map((e) => ({ text: e.content, done: e.status === 'completed' }))),

		async permission(req: AcpPermissionRequest): Promise<boolean> {
			const isEdit = EDIT_KINDS.has(req.kind);
			if (isEdit) snapshot(req.path);
			let request: ApprovalRequest;
			if (req.kind === 'execute') {
				// Agents from other makers (Claude Code, Codex…) answer to the same project command rules.
				const command = req.command ?? req.title;
				const rules = readCommandRules(d.cwd);
				const verdict = commandVerdict(rules, command) ?? (waitsForTrust(rules, command) ? 'pending' : undefined);
				if (verdict === 'deny') return false;
				request = { kind: 'command', command, projectRule: verdict };
			} else if (isEdit && req.path) {
				const abs = insideWorkspace(d.cwd, req.path);
				const now = abs ? readOrNull(abs) : null;
				request = req.newText !== undefined
					? { kind: 'write', path: abs ? rel(abs) : req.path, content: req.newText, existed: (req.oldText ?? now) !== null, review: { before: req.oldText ?? now ?? '', after: req.newText } }
					: { kind: 'write', path: abs ? rel(abs) : req.path, existed: now !== null };
			} else {
				request = { kind: 'mcp', tool: req.title, args: req.command ?? req.path ?? '' };
			}
			// The activity card would only repeat the approval card.
			const dup = cards.get(req.toolCallId);
			if (dup) {
				const i = d.convo.indexOf(dup);
				if (i >= 0) d.convo.splice(i, 1);
				cards.delete(req.toolCallId);
			}
			const handle = await d.requestApproval(request);
			if (handle.approved) {
				finish.set(req.toolCallId, handle.finish);
				approvedIds.add(req.toolCallId);
			}
			else handle.finish('rejected');
			return handle.approved;
		},

		async readFile(p: string, line?: number, limit?: number): Promise<string> {
			const abs = insideWorkspace(d.cwd, p);
			if (!abs) throw new Error('That file is outside the workspace.');
			let text = fs.readFileSync(abs, 'utf8');
			if (line || limit) {
				const lines = text.split('\n');
				text = lines.slice(Math.max(0, (line ?? 1) - 1), limit ? Math.max(0, (line ?? 1) - 1) + limit : undefined).join('\n');
			}
			return text;
		},

		async writeFile(p: string, content: string, approved: boolean): Promise<void> {
			const abs = insideWorkspace(d.cwd, p);
			if (!abs) throw new Error('That file is outside the workspace.');
			if (d.planMode) throw new Error('Read-only mode: the agent may not change files.');
			const old = readOrNull(abs);
			let text = content;
			if (!approved) {
				const request: ApprovalRequest = { kind: 'write', path: rel(abs), content, existed: old !== null, review: { before: old ?? '', after: content } };
				const handle = await d.requestApproval(request);
				if (!handle.approved) {
					handle.finish('rejected');
					throw new Error('The user rejected this change.');
				}
				text = handle.content ?? content;
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, text);
				handle.finish(`wrote ${rel(abs)}`);
			} else {
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, text);
			}
			d.recordChange(rel(abs), old, text);
		},

		tool(ev: AcpToolEvent): void {
			if (EDIT_KINDS.has(ev.kind) && (ev.status === 'pending' || ev.status === 'running')) snapshot(ev.path);
			if (ev.status === 'done' || ev.status === 'error') {
				if (ev.status === 'done' && EDIT_KINDS.has(ev.kind)) conclude(ev.path);
				finish.get(ev.id)?.(ev.detail ?? (ev.status === 'done' ? 'done' : 'failed'), ev.status === 'error');
				finish.delete(ev.id);
			}
			if (ev.kind === 'think') return;
			let card = cards.get(ev.id);
			// A card exists only for steps that did not ask (approved ones are the approval card).
			if (!card && approvedIds.has(ev.id)) return;
			if (!card) {
				card = { id: newId('t'), role: 'assistant', kind: 'tool', content: '', tool: { name: ev.kind === 'execute' ? 'run_command' : ev.kind === 'read' ? 'read_file' : ev.kind === 'search' ? 'search' : ev.kind === 'fetch' ? 'web_fetch' : ev.kind, arg: ev.title, status: 'running', summary: '' } };
				cards.set(ev.id, card);
				d.convo.push(card);
			}
			if (card.tool) card.tool = { ...card.tool, arg: ev.title || card.tool.arg, status: ev.status === 'done' ? 'done' : ev.status === 'error' ? 'error' : 'running', summary: ev.detail ?? card.tool.summary };
			d.scheduleState();
		}
	};
}
