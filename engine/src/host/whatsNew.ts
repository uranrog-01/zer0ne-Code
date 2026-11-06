import * as fs from 'fs';
import * as path from 'path';

/**
 * "What's new" after an update: the app's own CHANGELOG.md section for the version now
 * running, shown once in the chat. A first install records the version without a card.
 */
export const SEEN_VERSION_KEY = 'zer0ne.whatsNew.seenVersion';
const MAX_NOTES = 8;

/** The bullets of `## <version>` in a changelog (top-level `- ` lines), shortened for a card. */
export function releaseNotes(changelog: string, version: string): string[] {
	const lines = changelog.split(/\r?\n/);
	const start = lines.findIndex((l) => l.trim() === `## ${version}`);
	if (start < 0) return [];
	const notes: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line)) break;
		const m = /^- (.+)$/.exec(line);
		if (m) notes.push(m[1].replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim());
	}
	return notes.slice(0, MAX_NOTES).map((n) => (n.length > 220 ? n.slice(0, 219).replace(/\s+\S*$/, '') + '…' : n));
}

export interface WhatsNew { version: string; notes: string[]; more: number }

/**
 * What to show for the app at `appRoot`, given the version last seen: nothing on a first
 * install or when the version is unchanged, else that version's notes.
 */
export function whatsNewFor(appRoot: string, seen: string | undefined): { show?: WhatsNew; version?: string } {
	let version: string | undefined;
	try {
		version = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version;
	} catch {
		return {};
	}
	if (typeof version !== 'string' || !version) return {};
	if (!seen || seen === version) return { version };
	let changelog = '';
	try { changelog = fs.readFileSync(path.join(appRoot, 'CHANGELOG.md'), 'utf8'); } catch { /* notes stay empty */ }
	const all = changelog.split(/\r?\n/);
	const notes = releaseNotes(changelog, version);
	const start = all.findIndex((l) => l.trim() === `## ${version}`);
	const end = start < 0 ? -1 : all.findIndex((l, i) => i > start && /^##\s/.test(l));
	const total = start < 0 ? 0 : all.slice(start + 1, end < 0 ? undefined : end).filter((l) => /^- /.test(l)).length;
	return { version, show: notes.length ? { version, notes, more: Math.max(0, total - notes.length) } : undefined };
}
