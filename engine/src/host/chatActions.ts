import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { StreamOptions, StreamResult } from '../chatClient';
import { chatToJson, chatToMarkdown, fileSlug } from '../chatExport';
import type { ProviderConfig, StoredMessage } from '../providerStore';
import { workspaceRoot } from '../tools/agentTools';
import { HostContext, HostFeature, HostSurface } from './context';
import { localHelper } from './localRouting';

/**
 * The header "…" menu (copy the working folder, copy / export the chat,
 * share it as a secret Gist) and the composer's right-click writing help.
 * Split out of ChatController.
 */
export class ChatActionsHost implements HostFeature {
	constructor(
		private readonly ctx: HostContext,
		private readonly chat: () => { sessionId: string; messages: StoredMessage[] },
		private readonly callModel: (provider: ProviderConfig, apiKey: string, options: Omit<StreamOptions, 'baseUrl' | 'apiKey' | 'apiFormat'>) => Promise<StreamResult>
	) {}

	async handle(surface: HostSurface, msg: { type: string; [k: string]: any }): Promise<boolean> {
		switch (msg.type) {
			case 'chatAction':
				await this.chatAction(String(msg.action), msg.format === 'json' ? 'json' : 'md');
				return true;
			case 'copyText':
				await vscode.env.clipboard.writeText(String(msg.text ?? ''));
				this.ctx.status('Copied.');
				return true;
			case 'textAssist':
				surface.post({ type: 'textAssistResult', requestId: msg.requestId, ...(await this.textAssist(String(msg.action), String(msg.text ?? ''), String(msg.context ?? ''))) });
				return true;
		}
		return false;
	}

	private async chatAction(action: string, format: 'md' | 'json'): Promise<void> {
		const { sessionId, messages } = this.chat();
		const meta = (await this.ctx.store.listSessions()).find((s) => s.id === sessionId);
		const root = workspaceRoot();
		const info = { title: meta?.title || 'Chat', workspace: root ? (root.scheme === 'file' ? root.fsPath : root.toString()) : undefined };
		const visible = messages.filter((m) => !m.isError);
		switch (action) {
			case 'copyWorkdir':
				if (!info.workspace) {
					this.ctx.status('No workspace folder is open.', 'error');
					return;
				}
				await vscode.env.clipboard.writeText(info.workspace);
				this.ctx.status('Copied the working directory.');
				return;
			case 'copyMarkdown':
				await vscode.env.clipboard.writeText(chatToMarkdown(visible, info));
				this.ctx.status('Copied the chat as Markdown.');
				return;
			case 'export': {
				const ext = format === 'json' ? 'json' : 'md';
				const base = root && root.scheme === 'file' ? root : vscode.Uri.file(os.homedir());
				const target = await vscode.window.showSaveDialog({
					defaultUri: vscode.Uri.joinPath(base, `${fileSlug(info.title)}.${ext}`),
					filters: ext === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] },
					title: 'Export chat'
				});
				if (!target) {
					return;
				}
				const text = ext === 'json' ? chatToJson(visible, info) : chatToMarkdown(visible, info);
				await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
				this.ctx.status(`Exported to ${path.basename(target.fsPath)}.`);
				return;
			}
			case 'shareGist': {
				const ok = await vscode.window.showWarningMessage(
					'Share this chat as a secret GitHub Gist? Anyone with the link can read it — check it contains no secrets.',
					{ modal: true },
					'Create secret Gist'
				);
				if (!ok) {
					return;
				}
				const session = await vscode.authentication.getSession('github', ['gist'], { createIfNone: true });
				const res = await fetch('https://api.github.com/gists', {
					method: 'POST',
					headers: { Authorization: `Bearer ${session.accessToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'zer0ne-coding' },
					body: JSON.stringify({ description: `zer0ne chat: ${info.title}`, public: false, files: { [`${fileSlug(info.title)}.md`]: { content: chatToMarkdown(visible, info) } } }),
					signal: AbortSignal.timeout(30_000)
				});
				if (!res.ok) {
					throw new Error(`GitHub refused the Gist (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
				}
				const url = String(((await res.json()) as { html_url?: string }).html_url ?? '');
				await vscode.env.clipboard.writeText(url);
				this.ctx.status('Secret Gist created — link copied.');
				return;
			}
		}
	}

	private async textAssist(action: string, text: string, context: string): Promise<{ text?: string; suggestions?: string[]; error?: string }> {
		// Hybrid routing: text tools run on the local helper model when one is set.
		const helper = await localHelper(this.ctx.store, 'text');
		const { provider, model } = helper ?? (await this.ctx.store.resolveSelection());
		if (!provider || !model || !text.trim()) {
			return { error: 'Pick a model first.' };
		}
		const prompts: Record<string, string> = {
			fix: 'Correct spelling, grammar, and wrong-word (semantic/contextual) errors in the text. Keep the meaning, tone, language, formatting, @mentions, file paths and code exactly. Return only the corrected text.',
			improve: 'Rewrite the text to be clearer and more professional while keeping its meaning, language, @mentions, file paths and code. Return only the rewritten text.',
			shorter: 'Make the text shorter and more direct without losing meaning. Keep @mentions, file paths and code. Return only the result.',
			english: 'Translate the text to natural English. Keep @mentions, file paths and code unchanged. Return only the translation.',
			suggest: 'The user selected a word or short phrase inside a sentence. Give up to 6 better alternatives that fit the sentence context (fixing spelling or wrong-word errors first). Answer ONLY with a JSON array of strings.',
		};
		const system = prompts[action];
		if (!system) {
			return { error: 'Unknown action.' };
		}
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 45_000);
		try {
			const result = await this.callModel(provider, (await this.ctx.store.getApiKey(provider.id)) ?? '', {
				model: model.id,
				system,
				messages: [
					{
						role: 'user',
						content:
							action === 'suggest'
								? `Sentence: ${context}\nSelected: ${text}`
								: context && context !== text
										? `Full message (for context only; do not return it):\n${context}\n\nText to transform (return only this part, transformed):\n${text}`
										: text
					}
				],
				signal: abort.signal,
				maxTokens: 2000
			});
			const out = result.text.trim().replace(/^```\w*\n?|\n?```$/g, '');
			if (action === 'suggest') {
				const match = out.match(/\[[\s\S]*\]/);
				const list = match ? (JSON.parse(match[0]) as unknown[]).map(String).filter(Boolean).slice(0, 6) : [];
				return { suggestions: list };
			}
			return { text: out };
		} catch (error) {
			return { error: abort.signal.aborted ? 'Timed out.' : error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	}
}
