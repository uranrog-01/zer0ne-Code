/*
 * The shell commands each page may invoke (window.__zcShell.invoke). The start page
 * may restart the engine, pick a folder and open the logs; engine pages (served on
 * 127.0.0.1) may only manage their own window, acknowledge readiness, read the bell
 * and status, open Help, and use Liquid Glass. Both page kinds may select a project
 * folder and create it after trust confirmation. The Quick window may only read its target,
 * send its prompt and close. The notch may only read what it shows, say whether the pointer
 * is over it, open or dismiss one of its items, mark the bell's notifications read, take one of
 * a row's fixed actions (answer, stop, steer, check, undo, continue), ask about what was dropped
 * on it or copied, and pin the open panel (keyboard focus and drops) while you work there.
 * The tray panel may only pull its menu's data and send back one of its fixed keys.
 * The Computer Use effects window may only say whether the pointer is over its bar, report
 * that the visual for an action is on screen, and pause, stop or ask to resume (which opens the
 * permissions; it never resumes by itself).
 * Anything else is refused.
 *
 * ARGUMENTS adds per-command argument checks (a command the page may call still
 * rejects malformed arguments): each validator gets the args object and returns
 * a sanitized copy or undefined to refuse. Values crossing to the app are coerced
 * here, so the dispatch switch can trust their types.
 */
'use strict';

const WINDOW = ['plugin:window|minimize', 'plugin:window|toggle_maximize', 'plugin:window|close', 'plugin:window|is_maximized', 'plugin:window|is_fullscreen', 'plugin:window|start_dragging'];
const PROJECT = ['pick_project_folder', 'create_project'];

const ALLOWED = Object.freeze({
	start: new Set([...WINDOW, ...PROJECT, 'show_help', 'restart_engine', 'choose_folder', 'open_logs', 'host_status', 'notify_feed', 'notify_read']),
	engine: new Set([...WINDOW, ...PROJECT, 'show_help', 'host_status', 'notify_feed', 'notify_read', 'zc_page_ready', 'glass_blur', 'glass_panels', 'desktop_wallpaper', 'glass_prefs', 'profile_backup', 'profile_restore']),
	quick: new Set(['quick_target', 'quick_send', 'quick_close']),
	notch: new Set(['notch_state', 'notch_hover', 'notch_open', 'notch_dismiss', 'notch_read', 'notch_act', 'notch_ask', 'notch_pin']),
	tray: new Set(['tray_data', 'tray_action']),
	effects: new Set(['effects_hover', 'effects_shown', 'effects_control'])
});

const NOTCH_ACTIONS = new Set(['approve', 'reject', 'deny', 'ask', 'answer', 'stop', 'steer', 'check', 'undo', 'continue']);

/** Small validators: a field of an expected shape, or undefined when absent/refused. */
const v = {
	str: (max) => (x) => (typeof x === 'string' && x.length <= max ? x : undefined),
	bool: (x) => (typeof x === 'boolean' ? x : undefined),
	/** A finite number in [min, max], else undefined. */
	num: (min, max) => (x) => (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : undefined)
};

const ARGUMENTS = Object.freeze({
	// create_project: `selection`/`trusted` bind the call to a folder the user picked
	// in a dialog (never a page-supplied path); the name is re-checked by the app.
	create_project: (args) => ({
		selection: v.str(64)(args.selection),
		trusted: args.trusted === true ? true : undefined,
		name: v.str(100)(args.name) ?? ''
	}),
	show_help: (args) => ({ action: args.action === undefined ? undefined : v.str(40)(args.action) }),
	zc_page_ready: (args) => ({ activationId: v.str(200)(args.activationId) ?? '' }),
	notify_read: (args) => ({ id: typeof args.id === 'number' && Number.isFinite(args.id) ? args.id : null }),
	glass_blur: (args) => ({ on: args.on === true }),
	glass_prefs: (args) => ({ prefs: args.prefs && typeof args.prefs === 'object' && !Array.isArray(args.prefs) ? args.prefs : undefined }),
	desktop_wallpaper: (args) => ({ since: v.num(0, 8.64e15)(args.since) ?? null }),
	glass_panels: (args) => (args && typeof args === 'object' && !Array.isArray(args) ? args : undefined),
	quick_send: (args) => ({ text: v.str(20_000)(args.text) ?? '' }),
	notch_hover: (args) => ({ on: args.on === true }),
	// A notch item's key; the app looks it up among its own items, never as a path.
	notch_open: (args) => (v.str(4096)(args.key) && (args.to === undefined || args.to === 'chat' || args.to === 'changes') ? { key: args.key, to: args.to === 'changes' ? 'changes' : 'chat' } : undefined),
	notch_dismiss: (args) => (v.str(4096)(args.key) ? { key: args.key } : undefined),
	notch_read: (args) => ({ id: typeof args.id === 'number' && Number.isFinite(args.id) ? args.id : null }),
	// One of a row's fixed actions; the app resolves the key to its own item and the engine checks the ids.
	notch_act: (args) => (v.str(4096)(args.key) && NOTCH_ACTIONS.has(args.action) ? { key: args.key, action: args.action, answer: v.str(2000)(args.answer) ?? '', text: v.str(4000)(args.text) ?? '' } : undefined),
	// Dropped files arrive as content the page read (images as base64, text as text), never as paths.
	notch_ask: (args) => {
		const files = Array.isArray(args.files) ? args.files : [];
		if (files.length > 8) return undefined;
		const clean = files.map((f) => f && typeof f === 'object' ? { name: v.str(200)(f.name) ?? 'dropped', mime: v.str(40)(f.mime) ?? '', base64: v.str(14_000_000)(f.base64), text: v.str(400_000)(f.text) } : null);
		if (clean.some((f) => !f || (f.base64 === undefined && f.text === undefined))) return undefined;
		return { text: v.str(8000)(args.text) ?? '', files: clean, clipboard: args.clipboard === true };
	},
	notch_pin: (args) => ({ on: args.on === true, height: v.num(0, 2000)(args.height) ?? 0 }),
	// An action key the app minted with the panel's data; the app resolves it, never a path.
	tray_action: (args) => (v.str(200)(args.key) ? { key: args.key } : undefined),
	effects_hover: (args) => ({ on: args.on === true }),
	// The id of the action the page drew; the app passes it on only when it is the current one.
	effects_shown: (args) => (typeof args.id === 'string' && /^[\w-]{1,100}$/.test(args.id) ? { id: args.id } : undefined),
	effects_control: (args) => (['pause', 'stop', 'resume'].includes(args.action) ? { action: args.action } : undefined)
});

/**
 * @param {'start' | 'engine' | 'quick' | 'notch' | 'tray' | 'effects'} page
 * @returns {boolean} whether the page may call the command
 */
function allowed(page, command) {
	return !!ALLOWED[page] && ALLOWED[page].has(command);
}

/**
 * Validate and sanitize arguments for a command. Returns the cleaned object, or
 * undefined when a required argument is malformed (the caller refuses the call).
 * Commands without an entry pass their (already object-checked) args through.
 */
function validated(command, args) {
	const check = ARGUMENTS[command];
	if (!check) return args;
	const clean = check(args);
	// A validator that dropped a caller-supplied field refuses the whole call —
	// except `name` (create_project: '' is re-checked by the app) and the
	// explicitly-optional ones the dispatch itself defaults.
	if (command === 'create_project' && (clean.selection === undefined || (args.trusted === true && clean.trusted === undefined))) return undefined;
	return clean;
}

module.exports = { ALLOWED, allowed, validated };
