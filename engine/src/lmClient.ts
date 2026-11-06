import * as vscode from 'vscode';
import type { ChatMessage, StreamOptions, StreamResult } from './chatClient';

/**
 * Provider backed by VS Code's Language Model API (`vscode.lm`). This is
 * the officially supported way for an extension to use models from a
 * subscription the user already has in VS Code — e.g. Claude, GPT and
 * Gemini through GitHub Copilot. VS Code asks the user for consent on
 * first use; no API key or token ever passes through this extension.
 */

export interface LmModelInfo {
	id: string;
	name: string;
	vendor: string;
	family: string;
	contextWindow?: number;
}

function lmAvailable(): boolean {
	return typeof (vscode as { lm?: unknown }).lm !== 'undefined';
}

export async function listLmModels(): Promise<LmModelInfo[]> {
	if (!lmAvailable()) {
		throw new Error('This editor does not expose the VS Code Language Model API.');
	}
	const models = await vscode.lm.selectChatModels({});
	const seen = new Set<string>();
	return models
		.filter((m) => !seen.has(m.id) && seen.add(m.id))
		.map((m) => ({ id: m.id, name: m.name, vendor: m.vendor, family: m.family, contextWindow: m.maxInputTokens || undefined }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function toLmMessages(system: string, messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
	const out: vscode.LanguageModelChatMessage[] = [];
	// The LM API has no system role — instructions ride on the first user turn.
	let pendingSystem = system;
	for (const m of messages) {
		if (m.role === 'user') {
			const text = pendingSystem ? `<instructions>\n${pendingSystem}\n</instructions>\n\n${m.content}` : m.content;
			pendingSystem = '';
			out.push(vscode.LanguageModelChatMessage.User(text));
		} else if (m.role === 'assistant') {
			const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
			if (m.content.trim()) {
				parts.push(new vscode.LanguageModelTextPart(m.content));
			}
			for (const call of m.toolCalls ?? []) {
				let input: object = {};
				try {
					input = JSON.parse(call.arguments || '{}');
				} catch {
					input = {};
				}
				parts.push(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
			}
			if (parts.length) {
				out.push(vscode.LanguageModelChatMessage.Assistant(parts));
			}
		} else {
			out.push(
				vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(m.toolCallId, [new vscode.LanguageModelTextPart(m.content || '(empty)')])
				])
			);
		}
	}
	return out;
}

export async function streamLm(options: StreamOptions): Promise<StreamResult> {
	if (!lmAvailable()) {
		throw new Error('This editor does not expose the VS Code Language Model API.');
	}
	const [model] = await vscode.lm.selectChatModels({ id: options.model });
	if (!model) {
		throw new Error(`VS Code has no language model "${options.model}". Is GitHub Copilot signed in? Open Providers & models → Fetch models.`);
	}
	const cts = new vscode.CancellationTokenSource();
	const onAbort = () => cts.cancel();
	options.signal.addEventListener('abort', onAbort);
	let text = '';
	const toolCalls: StreamResult['toolCalls'] = [];
	try {
		const response = await model.sendRequest(
			toLmMessages(options.system, options.messages),
			{
				justification: 'zer0ne coding uses this model to answer your chat and agent requests.',
				tools: options.tools?.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
				toolMode: vscode.LanguageModelChatToolMode.Auto
			},
			cts.token
		);
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
				options.onText?.(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({ id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
			}
		}
	} catch (error) {
		if (options.signal.aborted) {
			throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
		}
		if (error instanceof vscode.LanguageModelError) {
			throw new Error(`VS Code language model error (${error.code}): ${error.message}`);
		}
		throw error;
	} finally {
		options.signal.removeEventListener('abort', onAbort);
		cts.dispose();
	}
	return { text, reasoning: '', toolCalls };
}
