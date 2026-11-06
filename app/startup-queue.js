'use strict';

/** Bound expensive engine initialization across windows; cancelling a queued project consumes no slot. */
function startupQueue(limit = 2) {
	let active = 0;
	const queue = [];
	const drain = () => {
		while (active < limit && queue.length) {
			const item = queue.shift(); if (item.cancelled) continue;
			active++; item.started = true;
			item.start(item.release);
		}
	};
	return start => {
		const item = { start, cancelled: false, started: false, released: false, release: () => {
			if (item.released) return; item.released = true; item.cancelled = true;
			if (item.started) active--; else { const at = queue.indexOf(item); if (at >= 0) queue.splice(at, 1); }
			drain();
		} };
		queue.push(item); drain(); return item.release;
	};
}
module.exports = { startupQueue, queueEngineStartup: startupQueue() };
