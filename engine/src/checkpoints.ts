import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { acquireRuntimeLease } from './runtimeLease';

/**
 * Checkpoints: the before/after content of every file an agent turn
 * changed, saved to disk so Undo, Review and "Restore to here" keep working
 * after VS Code restarts. One JSON file per turn:
 *   <globalStorage>/checkpoints/<sessionId>/<userMessageId>.json
 */

export interface CheckpointFile {
	/** null = the file did not exist before the turn. */
	before: string | null;
	/** null = the turn deleted it — or (with `binary`) the content is binary and lives in a sidecar. */
	after: string | null;
	undone?: boolean;
	/** Hunk decisions refer to the immutable before/after snapshots. */
	review?: { kept: number[]; undone: number[] };
	/**
	 * A binary file (NUL byte or invalid UTF-8): the after content lives in a
	 * sidecar file named by its SHA-256, and Undo/Restore write whole bytes.
	 * `before` (a text snapshot, or null) still drives plain undo.
	 */
	binary?: { afterRef: string; size: number };
}

export interface Checkpoint {
	userId: string;
	at: number;
	files: Record<string, CheckpointFile>;
	/** Files too large to keep (not restorable). */
	skipped?: string[];
}

const MAX_FILE = 2_000_000;
const KEEP_PER_SESSION = 150;

/**
 * A text file is decodable UTF-8 without NUL: BOM, CRLF and any other
 * character are text. Everything else — images, archives, fonts — is kept as
 * bytes (pure; tested).
 */
export function isBinaryBytes(bytes: Uint8Array): boolean {
	const probe = bytes.subarray(0, 8000);
	for (let i = 0; i < probe.length; i++) {
		if (probe[i] === 0) return true;
	}
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(probe);
	} catch {
		return true;
	}
	return false;
}

const safe = (s: string) => s.replace(/[^\w.-]/g, '_');

export class CheckpointStore {
	constructor(private readonly dir: string) {}

	private sessionDir(session: string): string {
		return path.join(this.dir, safe(session));
	}

	private file(session: string, userId: string): string {
		return path.join(this.sessionDir(session), safe(userId) + '.json');
	}

	/** Multiple windows must not overwrite each other's hunk decisions. */
	acquireReview(session: string, userId: string): (() => void) | undefined {
		return acquireRuntimeLease(path.join(this.sessionDir(session), '.review-' + safe(userId)));
	}

	/**
	 * Write the checkpoint. Returns the files that were too large to keep:
	 * they are recorded but cannot be restored, so the caller has to say so
	 * instead of claiming the turn is fully undoable.
	 */
	save(session: string, cp: Checkpoint): string[] {
		const files: Record<string, CheckpointFile> = {};
		const skipped: string[] = [...(cp.skipped ?? [])];
		for (const [rel, f] of Object.entries(cp.files)) {
			if ((f.before?.length ?? 0) > MAX_FILE || (f.after?.length ?? 0) > MAX_FILE) {
				skipped.push(rel);
			} else {
				files[rel] = f;
			}
		}
		fs.mkdirSync(this.sessionDir(session), { recursive: true });
		const target = this.file(session, cp.userId), temporary = target + '.' + randomUUID() + '.tmp';
		try {
			fs.writeFileSync(temporary, JSON.stringify({ ...cp, files, skipped: skipped.length ? skipped : undefined }));
			fs.renameSync(temporary, target);
		} finally { fs.rmSync(temporary, { force: true }); }
		this.prune(session);
		return skipped;
	}

	load(session: string, userId: string): Checkpoint | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.file(session, userId), 'utf8')) as Checkpoint;
		} catch {
			return undefined;
		}
	}

	/** The sidecar folder holding this checkpoint's binary contents. */
	private binDir(session: string, userId: string): string {
		return path.join(this.sessionDir(session), safe(userId) + '.bin');
	}

	/** Keep one binary after-content under its SHA-256 (deduplicated across turns). */
	saveBinary(session: string, userId: string, ref: string, bytes: Uint8Array): void {
		if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error('A binary sidecar ref must be a SHA-256 hex digest.');
		const dir = this.binDir(session, userId);
		fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, ref), temporary = target + '.tmp';
		fs.writeFileSync(temporary, bytes);
		fs.renameSync(temporary, target);
	}

	readBinary(session: string, userId: string, ref: string): Buffer | undefined {
		if (!/^[0-9a-f]{64}$/.test(ref)) return undefined;
		try {
			return fs.readFileSync(path.join(this.binDir(session, userId), ref));
		} catch {
			return undefined;
		}
	}

	/** User-message ids that still have a checkpoint, oldest first. */
	list(session: string): string[] {
		try {
			return fs
				.readdirSync(this.sessionDir(session))
				.filter((f) => f.endsWith('.json'))
				.map((f) => ({ id: f.slice(0, -5), t: fs.statSync(path.join(this.sessionDir(session), f)).mtimeMs }))
				.sort((a, b) => a.t - b.t)
				.map((x) => x.id);
		} catch {
			return [];
		}
	}

	remove(session: string, userId: string): void {
		fs.rmSync(this.file(session, userId), { force: true });
		fs.rmSync(this.binDir(session, userId), { recursive: true, force: true });
	}

	removeSession(session: string): void {
		fs.rmSync(this.sessionDir(session), { recursive: true, force: true });
	}

	private prune(session: string): void {
		const ids = this.list(session);
		for (const id of ids.slice(0, Math.max(0, ids.length - KEEP_PER_SESSION))) {
			try { this.remove(session, id); } catch { /* An older file can be pruned on the next save; the new checkpoint is already durable. */ }
		}
	}
}
