/*
 * The utility worker: heavy work off the main process (wallpaper reads run
 * `reg` synchronously and can stall a busy event loop). Plain request/response
 * over the utility process's parentPort:
 *   in:  { type: 'job', id, op, args }
 *   out: { type: 'result', id, value } / { type: 'error', id, message }
 * An unknown op is answered with an error, never silently dropped. No Electron
 * imports here — a utility process is a plain Node environment.
 */
'use strict';

const handlers = {
	/** Wallpaper as a data URL for the glass pages; `since` skips an unchanged file. */
	wallpaper: (args) => require('../wallpaper').wallpaper(args && args.since),
	/** The desktop's fill / fit / stretch / tile / center / span setting. */
	'wallpaper-style': () => require('../wallpaper').wallpaperStyle()
};

process.parentPort.on('message', (e) => {
	const msg = e.data;
	if (!msg || typeof msg !== 'object') return;
	if (msg.type === 'job' && typeof msg.id === 'number') {
		const handler = handlers[msg.op];
		if (!handler) {
			process.parentPort.postMessage({ type: 'error', id: msg.id, message: `unknown op: ${msg.op}` });
			return;
		}
		Promise.resolve()
			.then(() => handler(msg.args))
			.then(
				(value) => process.parentPort.postMessage({ type: 'result', id: msg.id, value: value === undefined ? null : value }),
				(error) => process.parentPort.postMessage({ type: 'error', id: msg.id, message: error instanceof Error ? error.message : String(error) })
			);
	}
});
