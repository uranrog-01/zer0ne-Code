import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export const BROWSER_PROTOCOL = 1;
export const RECEIPTED_COMMANDS = new Set(['send', 'retry', 'approve', 'reject', 'answer', 'stop', 'stopAgent', 'sendAgentMessage', 'resumeAgent', 'writerReview', 'undoTurn', 'restoreTo', 'rewindTo', 'projectActionRun', 'projectActionStop', 'ptyOpen', 'ptyClose']);
/** Completion describes request handling; task progress and verification have their own state. */
export interface CommandReceipt {
	id: string; type: string; digest: string; owner: number; epoch: string; at: number; updated: number;
	status: 'accepted' | 'running' | 'completed' | 'failed' | 'uncertain';
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

/** Receipts contain identity and outcome, never prompts, credentials or tool arguments.
 * An interrupted process is not replayable: it may have performed an external effect. */
export class CommandLedger {
	constructor(private readonly dir: string, readonly epoch = randomUUID()) { fs.mkdirSync(dir, { recursive: true }); }
	private file(scope: string, id: string): string {
		if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('Invalid command identity.');
		return path.join(this.dir, hash(scope + '\0' + id) + '.json');
	}
	get(scope: string, id: string): CommandReceipt | undefined {
		const file = this.file(scope, id);
		let receipt: CommandReceipt;
		try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('Command receipt is unavailable; inspect current work before retrying.'); }
		if (receipt.status === 'accepted' || receipt.status === 'running') {
			try { process.kill(receipt.owner, 0); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') receipt = { ...receipt, status: 'uncertain' }; }
		}
		return receipt;
	}
	begin(scope: string, id: string, message: Record<string, unknown>): { receipt: CommandReceipt; fresh: boolean } {
		const file = this.file(scope, id);
		const digest = hash(JSON.stringify(message));
		const receipt: CommandReceipt = { id, type: String(message.type), digest, owner: process.pid, epoch: this.epoch, at: Date.now(), updated: Date.now(), status: 'accepted' };
		let fd: number;
		try { fd = fs.openSync(file, 'wx'); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			const existing = this.get(scope, id);
			if (!existing || existing.digest !== digest) throw new Error('Command identity was already used for different content.');
			return { receipt: existing, fresh: false };
		}
		try { fs.writeFileSync(fd, JSON.stringify(receipt)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		return { receipt, fresh: true };
	}
	update(scope: string, receipt: CommandReceipt, status: CommandReceipt['status']): CommandReceipt {
		const next = { ...receipt, status, updated: Date.now() };
		const file = this.file(scope, receipt.id), temp = file + '.' + randomUUID() + '.tmp';
		const fd = fs.openSync(temp, 'wx');
		try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
		try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
		return next;
	}
}

export class EventReplay {
	readonly epoch = randomUUID();
	private sequence = 0;
	private bytes = 0;
	private readonly events: Array<{ id: string; line: string }> = [];
	get cursor(): string { return this.epoch + ':' + this.sequence; }
	append(message: Record<string, unknown>): string {
		const id = this.epoch + ':' + ++this.sequence;
		const line = `id: ${id}\ndata: ${JSON.stringify(message)}\n\n`;
		this.events.push({ id, line }); this.bytes += Buffer.byteLength(line);
		while (this.events.length > 512 || this.bytes > 2 * 1024 * 1024) this.bytes -= Buffer.byteLength(this.events.shift()!.line);
		return line;
	}
	since(cursor: string): string[] | undefined {
		if (cursor === this.cursor) return [];
		const index = this.events.findIndex(e => e.id === cursor);
		return index < 0 ? undefined : this.events.slice(index + 1).map(e => e.line);
	}
}
