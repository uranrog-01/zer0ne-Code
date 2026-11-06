import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

/** Installation and cleanup in different project engines share one runtime directory. */
export function acquireRuntimeLease(dir: string): (() => void) | undefined {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, '.maintenance.lock'), token = randomUUID();
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
			return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); } catch { /* Already released. */ } };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			try {
				const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
				if (!Number.isInteger(owner.pid) || owner.pid <= 0) return undefined;
				try { process.kill(owner.pid, 0); return undefined; }
				catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') return undefined; }
				if (JSON.parse(fs.readFileSync(file, 'utf8')).token === owner.token) fs.unlinkSync(file);
			} catch (read) {
				if ((read as NodeJS.ErrnoException).code === 'ENOENT') continue;
				if (!(read instanceof SyntaxError)) return undefined;
				try {
					// A writer can die between exclusive creation and publishing its PID.
					const stat = fs.statSync(file);
					if (Date.now() - stat.mtimeMs < 30_000) return undefined;
					if (fs.statSync(file).mtimeMs === stat.mtimeMs) fs.unlinkSync(file);
				} catch { return undefined; }
			}
		}
	}
	return undefined;
}
