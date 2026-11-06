'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-work-details-'));
const workspace = path.join(tmp, 'project');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'README.md'), '# Work Details protocol\n');
const child = spawn(process.execPath, [path.join(root, 'host/main.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', c => { stderr += c; });
const messages = [];
const listeners = new Set();
let stream;
let streamRequest;
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line);
  messages.push(m);
  if (m.t === 'req') send({ t: 'res', id: m.id, value: null });
  for (const fn of [...listeners]) fn();
});
const exited = new Promise(resolve => child.once('exit', resolve));
function next(pred) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Timed out: ' + pred + '\n' + stderr)); }, 20000);
    const check = () => {
      const index = messages.findIndex(pred);
      if (index < 0) return;
      clearTimeout(timer); listeners.delete(check);
      resolve(messages.splice(index, 1)[0]);
    };
    listeners.add(check); check();
  });
}
function post(url, message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(message);
    const req = http.request(new URL('/api/msg', url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': new URL(url).searchParams.get('t'), 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID(), 'Content-Length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.once('end', () => [202, 204].includes(res.statusCode) ? resolve() : reject(new Error('HTTP ' + res.statusCode)));
    });
    req.once('error', reject); req.end(body);
  });
}
(async () => {
  try {
    send({ t: 'init', engineDir: path.join(root, 'engine'), dataDir: path.join(tmp, 'data'), workspace });
    const ready = await next(m => m.t === 'ready');
    streamRequest = http.get(new URL('/api/events?t=' + new URL(ready.url).searchParams.get('t'), ready.url), res => {
      stream = res; res.setEncoding('utf8'); let buffer = '';
      res.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.startsWith('data: ')) continue;
          messages.push(JSON.parse(frame.slice(6)));
          for (const fn of [...listeners]) fn();
        }
      });
    });
    await next(m => m.type === 'state');
    await post(ready.url, { type: 'terminalInfo' });
    const info = await next(m => m.type === 'terminalInfo');
    assert.strictEqual(path.resolve(info.cwd), path.resolve(workspace));
    assert.strictEqual(info.running, false);
    await post(ready.url, { type: 'terminalRun', id: 9001, command: 'echo work-details-protocol-ok' });
    const chunk = await next(m => m.type === 'terminalChunk' && m.id === 9001 && m.text.includes('work-details-protocol-ok'));
    assert(chunk.text.includes('work-details-protocol-ok'));
    const done = await next(m => m.type === 'terminalDone' && m.id === 9001);
    assert.strictEqual(done.code, 0);
    await post(ready.url, { type: 'terminalInfo' });
    assert.strictEqual((await next(m => m.type === 'terminalInfo' && !m.running)).running, false);
    for (const request of ['getGitStatus', 'getWorktrees', 'getAgentRuns']) await post(ready.url, { type: request });
    const git = await next(m => m.type === 'gitStatus');
    assert(git.error, 'a non-Git project must not be reported as fully committed');
    await next(m => m.type === 'worktrees');
    const agents = await next(m => m.type === 'agentRuns');
    assert(Array.isArray(agents.items));
    await post(ready.url, { type: 'previewFile', path: 'README.md:1' });
    const preview = await next(m => m.type === 'filePreview' && m.path === 'README.md:1');
    assert.strictEqual(preview.content.trim(), '# Work Details protocol');
    console.log('Work Details desktop protocol passed: Terminal streaming/exit, non-Git Changes, Worktrees, Subagents, and File Preview');
  } finally {
    stream?.destroy(); streamRequest?.destroy();
    if (child.exitCode === null) { send({ t: 'shutdown' }); await exited; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
