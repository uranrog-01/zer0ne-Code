/*
 * Inline SVG icon set (lucide-style strokes, 16×16 grid). Exposed as
 * window.Icons.svg(name) and auto-applied to [data-icon] elements.
 */
(function () {
	'use strict';
	const P = {
		plus: '<path d="M8 3.5v9M3.5 8h9"/>',
		record: '<rect x="2" y="3" width="9" height="10" rx="2"/><path d="M11 6l3-2v8l-3-2"/><circle cx="6.5" cy="8" r="2" fill="currentColor" stroke="none"/>',
		sidebar: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
		panelRight: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M10 2.5v11"/>',
		pause: '<path d="M5 3v10M11 3v10" stroke-width="3"/>',
		close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
		minus: '<path d="M4 8h8"/>',
		check: '<path d="M3.5 8.5l3 3 6-6.5"/>',
		chevronDown: '<path d="M4.5 6.5L8 10l3.5-3.5"/>',
		chevronRight: '<path d="M6.5 4.5L10 8l-3.5 3.5"/>',
		arrowUp: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
		arrowDown: '<path d="M8 3v9.5M4 8.5l4 4 4-4"/>',
		stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="currentColor" stroke="none"/>',
		history: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2.8v2.5H5"/><path d="M8 5.2V8l2 1.3"/>',
		newChat: '<path d="M13.5 8.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.5"/><path d="M11.8 2.2a1.2 1.2 0 0 1 1.7 1.7L8.2 9.2 6 9.8l.6-2.2z"/>',
		gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"/>',
		search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.2 10.2l3.3 3.3"/>',
		paperclip: '<path d="M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.2 11.3a1.1 1.1 0 0 1-1.5-1.5l5-5"/>',
		at: '<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v1a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.4 4.8"/>',
		image: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><circle cx="6" cy="6.5" r="1.1"/><path d="M13.5 10.5l-3-3-6 5.5"/>',
		file: '<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/><path d="M9 2v4h4"/>',
		chat: '<path d="M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v6A1.5 1.5 0 0 1 12 11.5H6.5L3.5 14v-2.5h-.1A1.5 1.5 0 0 1 2.5 10z"/>',
		agent: '<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 5V2.5M6 8.5v1M10 8.5v1M1.5 8.5v2M14.5 8.5v2"/>',
		shield: '<path d="M8 1.8l5 1.9v4c0 3-2.1 5.3-5 6.5-2.9-1.2-5-3.5-5-6.5v-4z"/><path d="M5.8 8l1.6 1.6 2.9-3"/>',
		effort: '<path d="M2.5 13.5h11"/><path d="M4 11V8.5M8 11V5M12 11V2.5"/>',
		copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
		retry: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v2.8h-2.8"/>',
		brain: '<path d="M6 2.8a2 2 0 0 0-2 2 2 2 0 0 0-1.4 3.4A2.2 2.2 0 0 0 4.5 12a2 2 0 0 0 3.5 1V3.8A2 2 0 0 0 6 2.8z"/><path d="M10 2.8a2 2 0 0 1 2 2 2 2 0 0 1 1.4 3.4 2.2 2.2 0 0 1-1.9 3.8 2 2 0 0 1-3.5 1"/>',
		globe: '<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.8 1.6 2.7 3.5 2.7 5.8S9.8 12.2 8 13.8C6.2 12.2 5.3 10.3 5.3 8S6.2 3.8 8 2.2z"/>',
		link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7"/>',
		terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M4.8 6.5L6.8 8l-2 1.5M8.5 10h2.7"/>',
		pencil: '<path d="M10.8 2.7a1.5 1.5 0 0 1 2.1 2.1L5.5 12.2 2.8 13l.8-2.7z"/>',
		trash: '<path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.6 8.6a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.6"/>',
		plug: '<path d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0zM8 11.5V14"/>',
		refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v2.8h-2.8"/>',
		eye: '<path d="M1.5 8S3.9 3.5 8 3.5 14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
		eyeOff: '<path d="M2 2l12 12M6.6 3.7A6.4 6.4 0 0 1 8 3.5C12.1 3.5 14.5 8 14.5 8a11 11 0 0 1-1.8 2.4M4.2 4.9A10.6 10.6 0 0 0 1.5 8S3.9 12.5 8 12.5a6.3 6.3 0 0 0 3.1-.8"/><path d="M6.6 6.6a1.9 1.9 0 0 0 2.8 2.7"/>',
		more: '<circle cx="3.5" cy="8" r=".9" fill="currentColor"/><circle cx="8" cy="8" r=".9" fill="currentColor"/><circle cx="12.5" cy="8" r=".9" fill="currentColor"/>',
		cube: '<path d="M8 1.8l5.3 2.9v6.6L8 14.2l-5.3-2.9V4.7z"/><path d="M2.8 4.8L8 7.6l5.2-2.8M8 7.6v6.5"/>',
		chart: '<path d="M2.5 13.5h11M4.5 11V7.5M8 11V4M11.5 11V9"/>',
		memory: '<path d="M4 2.5h8A1.5 1.5 0 0 1 13.5 4v8A1.5 1.5 0 0 1 12 13.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5z"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/>',
		sliders: '<path d="M3 4.5h6M12 4.5h1M3 11.5h1M7 11.5h6"/><circle cx="10.5" cy="4.5" r="1.5"/><circle cx="5.5" cy="11.5" r="1.5"/>',
		list: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="3" cy="4" r=".8" fill="currentColor"/><circle cx="3" cy="8" r=".8" fill="currentColor"/><circle cx="3" cy="12" r=".8" fill="currentColor"/>',
		folder: '<path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/>',
		alert: '<circle cx="8" cy="8" r="5.8"/><path d="M8 5v3.4M8 10.8v.1"/>',
		help: '<circle cx="8" cy="8" r="5.8"/><path d="M6.2 6.2a2 2 0 0 1 3.5 1.2c0 1.2-1.7 1.5-1.7 2.6M8 12.2v.1"/>',
		info: '<circle cx="8" cy="8" r="5.8"/><path d="M8 7.3v3.5M8 5.2v.1"/>',
		sparkle: '<path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/>',
		todo: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5.3 8l1.8 1.8 3.6-3.6"/>',
		back: '<path d="M9.5 3.5L5 8l4.5 4.5"/>',
		mic: '<rect x="5.8" y="1.8" width="4.4" height="8" rx="2.2"/><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.2M5.8 14.2h4.4"/>',
		folderPlus: '<path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/><path d="M8 7v4M6 9h4"/>',
		archive: '<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6M6.5 8.8h3"/>',
		pin: '<path d="M9.5 2l4.5 4.5-2.2.6-2.6 2.6-.4 3-2.5-2.5L3 13.5M6.3 10.2L3.8 7.7l3-.4 2.6-2.6z"/>',
		phone: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.8"/><path d="M7 12.3h2"/>',
		puzzle: '<path d="M6 2.5h2.2a1.3 1.3 0 1 1 2.6 0H13v3.2a1.3 1.3 0 1 0 0 2.6v3.2A1.5 1.5 0 0 1 11.5 13H8.3a1.3 1.3 0 1 0-2.6 0H3V9.8a1.3 1.3 0 1 0 0-2.6V4A1.5 1.5 0 0 1 4.5 2.5z"/>',
		wand: '<path d="M2.5 13.5l7-7M9.5 3.5v-1M12.5 6.5h1M11.8 4.2l.8-.8M8.2 4.2l-.6-.6M11.8 8.8l.6.6"/><path d="M8.3 5.3l2.4 2.4"/>',
		zap: '<path d="M9 1.8L3.5 9h4l-1 5.2L12.5 7h-4z"/>',
		palette: '<path d="M8 2a6 6 0 1 0 0 12c1 0 1.4-.7 1.2-1.4-.3-.9.3-1.6 1.2-1.6H12a2 2 0 0 0 2-2A6 6 0 0 0 8 2z"/><circle cx="5" cy="7.5" r=".8" fill="currentColor"/><circle cx="7" cy="5" r=".8" fill="currentColor"/><circle cx="10.2" cy="5.3" r=".8" fill="currentColor"/>',
		server: '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1.2"/><rect x="2.5" y="9" width="11" height="4.5" rx="1.2"/><path d="M5 4.8h.1M5 11.2h.1"/>',
		book: '<path d="M3 3.2A1.2 1.2 0 0 1 4.2 2H13v10H4.2A1.2 1.2 0 0 0 3 13.2zM3 13.2A1.2 1.2 0 0 0 4.2 14.4H13"/><path d="M6 5h4.5"/>',
		bell: '<path d="M4 10.5V7a4 4 0 0 1 8 0v3.5l1.2 1.5H2.8zM6.6 13.8a1.5 1.5 0 0 0 2.8 0"/>',
		key: '<circle cx="5.5" cy="10.5" r="2.8"/><path d="M7.5 8.5L13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/>',
		qr: '<rect x="2.5" y="2.5" width="4" height="4" rx=".6"/><rect x="9.5" y="2.5" width="4" height="4" rx=".6"/><rect x="2.5" y="9.5" width="4" height="4" rx=".6"/><path d="M9.5 9.5h1.5v1.5M13.5 9.5v4h-2M9.5 12v1.5"/>',
		command: '<path d="M5.5 2.5a1.5 1.5 0 1 0 0 3h5a1.5 1.5 0 1 0 0-3v11a1.5 1.5 0 1 0 0-3h-5a1.5 1.5 0 1 0 0 3z"/>',
		send: '<path d="M8 13V3.5M4 7.5l4-4 4 4"/>',
		image2: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M13.5 10.5l-3-3-6 5.5"/>',
		branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-5.5 4"/>',
		minimize: '<path d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4.5-4.5M6.5 9.5L2 14"/>',
		cpu: '<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6 1.8V4M10 1.8V4M6 12v2.2M10 12v2.2M1.8 6H4M1.8 10H4M12 6h2.2M12 10h2.2"/>',
		live: '<circle cx="8" cy="8" r="1.6" fill="currentColor"/><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.2 3.2a6.8 6.8 0 0 0 0 9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6"/>',
		activity: '<path d="M1.5 8h3l2-4.5 3 9 2-4.5h3"/>',
		expand: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5L9 7M2.5 13.5L7 9"/>',
		volume: '<path d="M2.5 6v4h2.5l3.5 3V3L5 6z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>',
		branchOut: '<path d="M3.5 13.5v-3a4 4 0 0 1 4-4h6"/><path d="M10.5 3.5l3 3-3 3"/>',
		laptop: '<rect x="3" y="3.5" width="10" height="7" rx="1"/><path d="M1.5 12.5h13"/>',
		cloud: '<path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9 3 3 0 0 1 .7 6.9z"/>',
		collapse: '<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5L14 2M6.5 9.5L2 14"/>',
		layers: '<path d="M8 2.5l6 3-6 3-6-3z"/><path d="M2 8.5l6 3 6-3"/><path d="M2 11l6 3 6-3"/>',
		lightbulb: '<path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.5 8.2V11h5V9.7A4.5 4.5 0 0 0 8 1.5z"/>',
		sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/>',
		moon: '<path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/>',
		monitor: '<rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5.5 14.5h5M8 11.5v3"/>',
		lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
		code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
		clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
		gauge: '<path d="M2.5 11a5.5 5.5 0 1 1 11 0"/><path d="M8 11l2.6-3.4"/>',
		database: '<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v8.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V3.5M2.5 7.5c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>',
		swap: '<path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/>',
		film: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M5 3v10M11 3v10M2 6h3M2 10h3M11 6h3M11 10h3"/>',
		eyeWatch: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
		fileDiff: '<path d="M9.5 1.8H4.2A1.2 1.2 0 0 0 3 3v10a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 13V5.3z"/><path d="M8 5.6v3.6M6.2 7.4h3.6M6.2 11.2h3.6"/>',
		commit: '<circle cx="8" cy="8" r="2.4"/><path d="M1.5 8h4.1M10.4 8h4.1"/>',
		target: '<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="3.2"/><circle cx="8" cy="8" r=".8" fill="currentColor"/>',
		listTree: '<path d="M2.5 3.5h4M5 8h8.5M5 12.5h8.5M3.5 3.5v9h1.5M3.5 8h1.5"/>',
		workflow: '<rect x="1.8" y="2.3" width="4.4" height="3.4" rx="1"/><rect x="9.8" y="6.3" width="4.4" height="3.4" rx="1"/><rect x="1.8" y="10.3" width="4.4" height="3.4" rx="1"/><path d="M6.2 4h1.3a1.5 1.5 0 0 1 1.5 1.5V6.5a1.5 1.5 0 0 0 .8 1.3M6.2 12h1.3A1.5 1.5 0 0 0 9 10.5V9.5a1.5 1.5 0 0 1 .8-1.3"/>',
		grip: '<circle cx="6" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="12" r=".9" fill="currentColor" stroke="none"/>'
	};

	function svg(name, cls) {
		const body = P[name] || P.info;
		return '<svg class="i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" aria-hidden="true">' + body + '</svg>';
	}

	function apply(root) {
		for (const el of (root || document).querySelectorAll('[data-icon]')) {
			if (!el.dataset.iconApplied) {
				el.insertAdjacentHTML('afterbegin', svg(el.dataset.icon));
				el.dataset.iconApplied = '1';
			}
		}
	}

	window.Icons = { svg, apply };
	apply(document);
})();
