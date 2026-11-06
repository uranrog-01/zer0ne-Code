(() => {
	'use strict';
	function guidance(kind, text = '', name = '') {
		if (kind === 'command') return { next: 'Inspect the command output and current project files before running it again.', panel: 'terminal', label: 'Open Terminal' };
		if (kind === 'mcp' || name.startsWith('mcp__')) return { next: 'Check this server’s connection and permissions, then review the tool result before retrying.', section: 'mcp', label: 'MCP connections' };
		if (name.startsWith('browser_') || name === 'computer') return { next: 'Inspect the current page or desktop before repeating the action.', section: 'browser', label: 'Browser settings' };
		if (kind === 'tool') return { next: 'Inspect the reported output and affected files. Continue from the failed step after correcting the cause.', panel: 'explorer', label: 'Inspect project files' };
		if (/429|rate.?limit|quota|credits?|budget/i.test(text)) return { next: 'Check usage or reset windows, or choose a model with available capacity.', section: 'usage', label: 'Usage & limits' };
		if (/401|403|auth|api.?key|sign.?in|provider|model|connect|network|fetch/i.test(text)) return { next: 'Check the selected model, connection, and sign-in. Review completed tool results before retrying the response.', section: 'models', label: 'Providers & models' };
		return { next: 'Review the error and completed tool results, correct the cause, then retry or send a follow-up.', panel: 'explorer', label: 'Inspect project files' };
	}
	function html(kind, text, name) {
		const info = guidance(kind, text, name);
		return '<aside class="recovery-note" aria-label="Recovery guidance"><strong>Next step</strong><p>' + info.next + '</p>' + (kind === 'response' ? '<p>Earlier results remain in this chat. Check completed actions before retrying.</p>' : '') + '<div class="recovery-actions"><button type="button" class="btn btn-secondary btn-sm" ' + (info.section ? 'data-open-settings="' + info.section : 'data-recovery-panel="' + info.panel) + '">' + info.label + '</button></div></aside>';
	}
	window.RecoveryUI = { guidance, html };
})();
