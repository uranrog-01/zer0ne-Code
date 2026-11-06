'use strict';
const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { spawn, execFile } = require('child_process');
const { requestStop } = require('./computer-stop');

class ComputerVisuals {
	constructor(directory, source, onResume) {
		this.directory = directory;
		this.source = source;
		this.onResume = onResume;
		this.disposed = false;
		this.retryAt = 0;
		// What the overlay reports (one JSON object per line) goes to these listeners.
		this.listeners = new Set();
		this.design = false;
		this.pending = null;
		if (process.platform !== 'win32') return;
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, 'monitor-required.json'), JSON.stringify({ pid: process.pid }));
		this.timer = setInterval(() => this.refresh(), 500);
		this.timer.unref();
		this.refresh();
	}
	refresh() {
		if (this.disposed || this.child || this.starting || Date.now() < this.retryAt) return;
		try {
			const policy = JSON.parse(fs.readFileSync(path.join(this.directory, 'permissions.json'), 'utf8'));
			if (!policy.allowed?.length) return;
		} catch { return; }
		this.starting = true;
		void this.launch().catch(error => {
			this.fail();
			console.error('Computer Use visuals:', error.message);
		}).finally(() => { this.starting = false; });
	}
	async launch() {
		const hash = createHash('sha256').update(fs.readFileSync(this.source)).digest('hex').slice(0, 20);
		const file = path.join(this.directory, `overlay-${hash}.exe`);
		if (!fs.existsSync(file)) {
			const win = process.env.SystemRoot || 'C:\\Windows';
			const compiler = ['Framework64', 'Framework'].map(f => path.join(win, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe')).find(p => fs.existsSync(p));
			if (!compiler) throw new Error('The Windows C# compiler was not found.');
			const temp = path.join(this.directory, `overlay-${randomUUID()}.exe`);
			try {
				await new Promise((resolve, reject) => execFile(compiler, ['/nologo', '/optimize', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/out:${temp}`, this.source], { windowsHide: true, timeout: 60000 }, (error, stdout) => error ? reject(new Error(stdout || error.message)) : resolve()));
				fs.renameSync(temp, file);
			} finally { fs.rmSync(temp, { force: true }); }
		}
		if (this.disposed) return;
		const child = this.child = spawn(file, [this.directory, String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		let buffer = '';
		child.stdout.on('data', chunk => {
			buffer = (buffer + String(chunk)).slice(-65536);
			let end;
			while ((end = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
				if (line === 'resume' && !this.disposed) this.onResume();
				else if (line.startsWith('{')) this.report(line);
			}
		});
		child.stderr.on('data', chunk => console.error('Computer Use overlay:', String(chunk).slice(0, 1000)));
		child.on('error', () => this.fail());
		child.on('exit', () => { if (this.child === child) { this.child = null; this.publish({ t: 'state', mode: 'hidden' }); } if (!this.disposed) this.fail(); });
		child.stdin.on('error', () => {});
		if (this.design) this.send('effects on');
	}
	report(line) {
		let message;
		try { message = JSON.parse(line); } catch { return; }
		if (message?.t === 'capture') { const done = this.pending; this.pending = null; done?.(message); }
		else if (message?.t === 'state') this.publish(message);
	}
	publish(message) { for (const listener of this.listeners) { try { listener(message); } catch (error) { console.error('Computer Use effects:', error.message); } } }
	send(line) { if (this.child?.stdin.writable) this.child.stdin.write(line + '\n'); }
	/** Whether the design window can draw: the overlay keeps its own outline and pill until it can. */
	setDesign(on) { this.design = !!on; this.send(on ? 'effects on' : 'effects off'); }
	shown(id) { this.send('shown ' + id); }
	/** The presented window's pixels, or null; the file is read and deleted at once. */
	capture() {
		if (!this.child || this.pending) return Promise.resolve(null);
		const file = path.join(this.directory, `frame-${randomUUID()}.png`);
		return new Promise(resolve => {
			const done = message => {
				clearTimeout(timer);
				let image = null;
				try { if (message?.ok && path.resolve(String(message.file)) === path.resolve(file)) image = fs.readFileSync(file); } catch { image = null; }
				fs.rmSync(file, { force: true });
				resolve(image && message.rect ? { image, rect: message.rect } : null);
			};
			const timer = setTimeout(() => { if (this.pending === done) this.pending = null; done(null); }, 3000);
			this.pending = done;
			this.send('capture ' + file);
		});
	}
	fail() {
		this.retryAt = Date.now() + 10000;
		try { requestStop(this.directory); } catch { /* The input helper also refuses a stale monitor heartbeat. */ }
	}
	dispose() {
		this.disposed = true;
		clearInterval(this.timer);
		try { requestStop(this.directory); } catch { /* Shutdown also kills all engine processes. */ }
		if (this.child) { this.child.stdin.end(); this.child.kill(); }
	}
}
module.exports = { ComputerVisuals };
