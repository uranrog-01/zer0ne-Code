import { createHash } from 'crypto';

/**
 * Read-before-edit and write-if-unchanged for the agent's file tools.
 *
 * Each chat remembers a hash of every file's text as the agent last saw it
 * (its read, or its own write). An edit needs that observation and is refused
 * when the file changed since — the user typed in it, a formatter ran, git
 * switched branches — instead of overwriting work the model never saw.
 * Content, not mtime: reads return an open editor's unsaved buffer, which no
 * file stat reflects. (DeepSeek Harness's observation policy, compared by
 * content like OpenCode and Gemini CLI.)
 *
 * Kept apart from the transcript's `reads` map: that one is reset when the
 * model is merely told a file changed, which must not count as a read.
 */

export function textHash(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

const MAX_SCOPES = 64;
const MAX_FILES = 5000;

export class FileGuard {
	private readonly scopes = new Map<string, Map<string, string>>();
	private readonly locks = new Map<string, Promise<void>>();

	/** Map key for a file: case-insensitive where the file system is. */
	key(file: string): string {
		return process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file;
	}

	/** The agent saw `text` as the current content of `file` (a read or its own write). */
	observe(scope: string | undefined, file: string, text: string): void {
		if (!scope) return;
		let files = this.scopes.get(scope);
		if (!files) {
			if (this.scopes.size >= MAX_SCOPES) this.scopes.delete(this.scopes.keys().next().value as string);
			this.scopes.set(scope, (files = new Map()));
		} else {
			// Most recently used last, so the oldest chat is the one dropped.
			this.scopes.delete(scope);
			this.scopes.set(scope, files);
		}
		const k = this.key(file);
		files.delete(k);
		if (files.size >= MAX_FILES) files.delete(files.keys().next().value as string);
		files.set(k, textHash(text));
	}

	/** Forget a chat (deleted, or compacted: the model no longer holds the file text). */
	forget(scope: string): void {
		this.scopes.delete(scope);
	}

	/** Throws the model-facing reason when an edit would act on a version the agent has not seen. */
	assertSeen(scope: string | undefined, file: string, current: string, display: string): void {
		if (!scope) return;
		const seen = this.scopes.get(scope)?.get(this.key(file));
		if (seen === undefined) {
			throw new Error(`${display} has not been read in this chat. Read it first (read_file), then edit — edits only apply to text you have seen.`);
		}
		if (seen !== textHash(current)) {
			throw new Error(`${display} changed since you last read it (the user, a formatter or another tool edited it). Read it again before editing.`);
		}
	}

	/** apply_patch: context lines verify the text, so no read is needed — but a read file must not have changed since. */
	assertUnchangedIfSeen(scope: string | undefined, file: string, current: string, display: string): void {
		const seen = scope ? this.scopes.get(scope)?.get(this.key(file)) : undefined;
		if (seen !== undefined && seen !== textHash(current)) {
			throw new Error(`${display} changed since you last read it (the user, a formatter or another tool edited it). Read it again before patching it.`);
		}
	}

	/** write_file: a new file needs nothing; overwriting an existing one needs a current read. */
	assertOverwrite(scope: string | undefined, file: string, current: string | null, display: string): void {
		if (current === null || !scope) return;
		const seen = this.scopes.get(scope)?.get(this.key(file));
		if (seen === undefined) {
			throw new Error(`${display} already exists and has not been read in this chat. Read it first, or use edit_file for a partial change — overwriting a file you have not seen is refused.`);
		}
		if (seen !== textHash(current)) {
			throw new Error(`${display} changed since you last read it (the user, a formatter or another tool edited it). Read it again before overwriting it.`);
		}
	}

	/** Mutations of one file run one at a time (read → compare → write is never interleaved). */
	async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
		const k = this.key(file);
		const prior = this.locks.get(k) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((resolve) => (release = resolve));
		const tail = prior.then(() => mine);
		this.locks.set(k, tail);
		await prior;
		try {
			return await fn();
		} finally {
			release();
			if (this.locks.get(k) === tail) this.locks.delete(k);
		}
	}
}

/** One guard per extension host: chats are told apart by session id. */
export const fileGuard = new FileGuard();
