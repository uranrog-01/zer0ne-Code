'use strict';

function createPrompts() {
	let sequence = 0;
	let post;
	const pending = new Map();
	return {
		request(options) {
			const id = ++sequence;
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { pending.delete(id); post?.({ type: 'zcPromptClose', id }); reject(new Error('The dialog timed out. Try the action again.')); }, 5 * 60_000);
				pending.set(id, { options, resolve, reject, timer });
				post?.({ type: 'zcPrompt', id, options });
			});
		},
		options(id) { return pending.get(id)?.options; },
		attach(send) { post = send; },
		replay() { for (const [id, entry] of pending) post?.({ type: 'zcPrompt', id, options: entry.options }); },
		handle(message) {
			if (message?.type !== 'zcPromptReply') return false;
			const entry = pending.get(message.id);
			if (!entry) return true;
			pending.delete(message.id); clearTimeout(entry.timer);
			let value = message.value;
			if (entry.options.kind === 'pick') {
				const valid = index => Number.isInteger(index) && index >= 0 && index < entry.options.items.length && !entry.options.items[index].disabled;
				value = entry.options.many ? (Array.isArray(value) && value.every(valid) ? value : undefined) : (valid(value) ? value : undefined);
			} else value = typeof value === 'string' ? value : undefined;
			entry.resolve(value); return true;
		},
		dispose() { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(undefined); } pending.clear(); post = undefined; }
	};
}

module.exports = { createPrompts };
