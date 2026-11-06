import type { StoredMessage } from './providerStore';

/**
 * Chat export: a readable Markdown transcript (for sharing, Gists, notes)
 * and a JSON document (for tooling / re-import). Images are never embedded.
 */

export interface ExportMeta {
	title: string;
	workspace?: string;
	exportedAt?: number;
}

function fence(text: string, lang = ''): string {
	const ticks = (text.match(/`{3,}/g) ?? []).reduce((n, m) => Math.max(n, m.length + 1), 3);
	const bar = '`'.repeat(ticks);
	return `${bar}${lang}\n${text.replace(/\s+$/, '')}\n${bar}`;
}

function duration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function chatToMarkdown(messages: StoredMessage[], meta: ExportMeta): string {
	const out: string[] = [`# ${meta.title || 'Chat'}`, ''];
	const facts = [`Exported ${new Date(meta.exportedAt ?? Date.now()).toLocaleString()}`];
	if (meta.workspace) {
		facts.push(`workspace \`${meta.workspace}\``);
	}
	out.push(`_${facts.join(' · ')} · zer0ne coding_`, '');
	for (const m of messages) {
		if (m.compacted) {
			out.push('---', '', `_${m.content}_`, '');
			continue;
		}
		if (m.role === 'user' && !m.kind) {
			const when = m.at ? ` · ${new Date(m.at).toLocaleTimeString()}` : '';
			out.push(`## You${when}`, '', m.content, '');
			if (m.attachments?.length) {
				out.push(`_Attached: ${m.attachments.join(', ')}_`, '');
			}
			const turn = m.turn;
			if (turn?.endedAt) {
				const bits = [`worked for ${duration(turn.endedAt - turn.startedAt)}`];
				if (turn.provider || turn.model) {
					bits.push([turn.provider, turn.model].filter(Boolean).join(' / '));
				}
				if (turn.usage?.input) {
					bits.push(`${turn.usage.input} in / ${turn.usage.output} out${turn.usage.cached ? ` / ${Math.round((turn.usage.cached / turn.usage.input) * 1000) / 10}% cached` : ''}`);
				}
				if (turn.edits?.length) {
					bits.push(`edited ${turn.edits.map((e) => `\`${e.path}\` (+${e.added} −${e.removed})`).join(', ')}`);
				}
				out.push(`> ${bits.join(' · ')}`, '');
			}
			continue;
		}
		if (m.tool) {
			out.push(`- **${m.tool.name}** ${m.tool.arg ? `\`${m.tool.arg}\`` : ''} → ${m.tool.summary || m.tool.status}`);
			continue;
		}
		if (m.approval) {
			const a = m.approval;
			const status = a.status === 'pending' ? 'pending' : a.status === 'rejected' ? 'rejected' : a.failed ? 'failed' : a.auto ? 'auto-approved' : 'applied';
			if (a.kind === 'command') {
				out.push('', `**Ran command** (${status})`, '', fence(`$ ${a.command ?? ''}${a.result ? `\n${a.result}` : ''}`, 'text'), '');
			} else if (a.kind === 'mcp') {
				out.push('', `**MCP ${a.tool ?? ''}** (${status})`, '', fence(a.args ?? '{}', 'json'), '');
			} else if (a.kind === 'edit') {
				const diff = [...(a.find ?? '').split('\n').map((l) => `- ${l}`), ...(a.replace ?? '').split('\n').map((l) => `+ ${l}`)].join('\n');
				out.push('', `**Edited \`${a.path}\`** (${status})`, '', fence(diff, 'diff'), '');
			} else if (a.kind === 'write') {
				out.push('', `**${a.existed ? 'Overwrote' : 'Created'} \`${a.path}\`** (${status})`, '', fence(a.content ?? ''), '');
			} else {
				out.push('', `**Changes: ${a.path ?? ''}** (${status})`, '', fence(a.content ?? '', 'diff'), '');
			}
			continue;
		}
		if (m.question) {
			out.push('', `**Agent asked:** ${m.question.text}`, '', `**Answer:** ${m.question.answer ?? '(none)'}`, '');
			continue;
		}
		if (m.todos?.length) {
			out.push('', ...m.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`), '');
			continue;
		}
		if (m.role === 'assistant' && m.content.trim()) {
			out.push('', `## zer0ne${m.model ? ` · ${m.model}` : ''}`, '', m.content, '');
		}
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export function chatToJson(messages: StoredMessage[], meta: ExportMeta): string {
	return JSON.stringify(
		{
			format: 'zer0ne-chat',
			version: 1,
			title: meta.title,
			workspace: meta.workspace,
			exportedAt: new Date(meta.exportedAt ?? Date.now()).toISOString(),
			messages: messages.map((m) => ({ ...m, at: m.at ? new Date(m.at).toISOString() : undefined }))
		},
		null,
		2
	);
}

export function fileSlug(title: string): string {
	return (title || 'chat')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'chat';
}
