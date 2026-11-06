'use strict';
const assert = require('assert');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const root = process.env.ZER0NE_APP_EXE ? path.join(path.dirname(process.env.ZER0NE_APP_EXE), 'resources/app.asar.unpacked') : path.resolve(process.env.ZER0NE_PACKAGED_DIR || path.join(__dirname, '..'));
const node = process.env.ZER0NE_APP_EXE || (process.env.ZER0NE_PACKAGED_DIR ? path.join(root, 'node.exe') : process.execPath);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, description) {
 const end = Date.now() + 20000;
 while (Date.now() < end) {
  const result = predicate();
  if (result) return result;
  await delay(20);
 }
 throw Error('Timed out: ' + description);
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function worker(workspace, dataDir, env = {}) {
 // Windows environment names are case-insensitive: process.env carries "COMSPEC",
 // so an override written as "ComSpec" would arrive as a second key and the
 // inherited one would win. Replace the inherited key whatever its case.
 const childEnv = { ...process.env, ...(process.env.ZER0NE_APP_EXE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
 for (const key of Object.keys(env)) {
  for (const existing of Object.keys(childEnv)) if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete childEnv[existing];
  childEnv[key] = env[key];
 }
 const child = spawn(node, [path.join(root, 'host/main.js')], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv
 });
 const protocol = [], ui = [], terminal = [];
 let stderr = '', request, response;
 child.stderr.on('data', data => { stderr += data; });
 const send = m => child.stdin.write(JSON.stringify(m) + '\n');
 readline.createInterface({ input: child.stdout }).on('line', line => {
  const m = JSON.parse(line);
  protocol.push(m);
  if (m.op === 'retainTerminal') terminal.push(m.on);
  if (m.t === 'req') send({ t: 'res', id: m.id, value: null });
 });
 const wait = (items, predicate) => until(() => {
  if (child.exitCode !== null || child.signalCode !== null) throw Error('Host exited: ' + stderr);
  const i = items.findIndex(predicate);
  return i < 0 ? null : items.splice(i, 1)[0];
 }, String(predicate) + '\n' + stderr);
 const host = {
  child, protocol, ui, terminal, send, diagnostics: () => stderr + '\n' + JSON.stringify(ui.slice(-5).map(m => ({ type: m.type, message: m.message, currentSessionId: m.currentSessionId, isStreaming: m.isStreaming }))),
  async stop() {
   request?.destroy(); response?.destroy();
   if (child.exitCode === null && child.signalCode === null) {
    send({ t: 'shutdown' });
    await until(() => child.exitCode !== null || child.signalCode !== null, 'host shutdown');
    assert.equal(child.exitCode, 0, stderr);
   }
  },
  next: predicate => wait(ui, predicate),
  retained: on => wait(protocol, m => m.op === 'retainTerminal' && m.on === on),
  async post(message) {
   const res = await fetch(new URL('/api/msg', host.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zer0ne-Token': new URL(host.url).searchParams.get('t'), 'X-Zer0ne-Protocol': '1', 'X-Zer0ne-Command': require('crypto').randomUUID() },
    body: JSON.stringify(message)
   });
   assert.ok([202, 204].includes(res.status), String(res.status));
  }
 };
 try {
  send({ t: 'init', engineDir: path.join(root, 'engine'), dataDir, workspace, key: Buffer.alloc(32, 7).toString('base64') });
  host.url = (await wait(protocol, m => m.t === 'ready')).url;
  request = http.get(new URL('/api/events?t=' + new URL(host.url).searchParams.get('t'), host.url), res => {
   response = res; res.on('error', () => {}); res.setEncoding('utf8'); let buffer = '';
   res.on('data', chunk => {
    buffer += chunk; let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
     const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
     if (frame.startsWith('data: ')) ui.push(JSON.parse(frame.slice(6)));
    }
   });
  });
  request.on('error', () => {});
  assert.equal((await host.next(m => m.type === 'state')).isStreaming, false);
  return host;
 } catch (error) { await host.stop(); throw error; }
}

module.exports = { worker, until, alive, delay };
