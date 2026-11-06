import type { AcpPermissionOption } from './client';

/** What the turn runner gives an ACP agent for one chat turn: the workspace, and zer0ne's own approval, file and card machinery. */
export interface AcpToolEvent {
	id: string;
	title: string;
	kind: string;
	status: 'pending' | 'running' | 'done' | 'error';
	/** Short outcome / first line of the output. */
	detail?: string;
	path?: string;
}

export interface AcpPermissionRequest {
	toolCallId: string;
	title: string;
	kind: string;
	path?: string;
	command?: string;
	oldText?: string | null;
	newText?: string;
	options: AcpPermissionOption[];
}

export interface AcpTurnHooks {
	/** Workspace folder the agent works in. */
	cwd: string;
	/** Stable per chat: an agent session lives as long as its chat. */
	chatId: string;
	/** The agent asks before a risky step; true = the user (or an auto-approve rule) said yes. */
	permission(req: AcpPermissionRequest): Promise<boolean>;
	readFile(path: string, line?: number, limit?: number): Promise<string>;
	/** A write the agent asked us to do: approval (skipped when `approved`: the user already allowed this edit), snapshot for Undo, then the file. */
	writeFile(path: string, content: string, approved: boolean): Promise<void>;
	/** Cards for what the agent is doing. */
	tool(event: AcpToolEvent): void;
	plan?(entries: Array<{ content: string; status: string }>): void;
	status?(message: string): void;
	/** Plan mode: the agent should only read and think. */
	planMode?: boolean;
}
