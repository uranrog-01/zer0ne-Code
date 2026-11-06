'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { worker } = require('./host-fixture');
const root = path.resolve(process.env.ZER0NE_PACKAGED_DIR || path.join(__dirname, '..'));
const node = process.env.ZER0NE_PACKAGED_DIR ? path.join(root, 'node.exe') : process.execPath;
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


async function main() {
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zer0ne-terminal-retention-'));
 const hosts = [], pids = [], releases = new Map();
 const projectA = path.join(tmp, 'a'), projectB = path.join(tmp, 'b');
 fs.mkdirSync(projectA); fs.mkdirSync(projectB);
 const script = path.join(tmp, 'command.js');
 fs.writeFileSync(script, `const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
console.log('terminal-ready');
setInterval(() => { if (fs.existsSync(process.argv[3])) { console.log('terminal-finished'); process.exit(0); } }, 30);
`);
 const command = (pidFile, release) => '"' + node + '" "' + script + '" "' + pidFile + '" "' + release + '"';
 async function start(host, id) {
  const pidFile = path.join(tmp, id + '.pid'), release = path.join(tmp, id + '.release');
  await host.post({ type: 'terminalRun', id, command: command(pidFile, release) });
  await host.retained(true);
  await host.next(m => m.type === 'terminalChunk' && m.id === id && m.text.includes('terminal-ready'));
  const pid = Number(fs.readFileSync(pidFile, 'utf8')); pids.push(pid);
  releases.set(pid, release);
  assert(alive(pid), 'A real command must be running');
  return { pid, release };
 }
 try {
  const a = await worker(projectA, path.join(tmp, 'data')); hosts.push(a);
  await a.post({ type: 'terminalRun', id: 1, command: 'cd .' });
  await a.next(m => m.type === 'terminalDone' && m.id === 1);
  assert.deepEqual(a.terminal, [], 'Changing directory does not retain an engine');
  const runA = await start(a, 2);
  const b = await worker(projectB, path.join(tmp, 'data')); hosts.push(b);
  b.send({ t: 'activate', handoff: null, activationId: 'project-b' });
  await b.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'project-b');
  assert(alive(runA.pid)); assert.deepEqual(a.terminal, [true]);
  a.send({ t: 'activate', handoff: null, activationId: 'return-a' });
  await a.next(m => m.type === 'zcDesktopActivated' && m.activationId === 'return-a');
  await a.post({ type: 'terminalInfo' });
  assert.equal((await a.next(m => m.type === 'terminalInfo')).running, true);
  await a.post({ type: 'terminalRun', id: 3, command: 'echo rejected' });
  assert.equal((await a.next(m => m.type === 'terminalDone' && m.id === 3)).code, -1);
  await a.post({ type: 'terminalStop', id: 3 });
  await a.post({ type: 'terminalInfo' });
  assert.equal((await a.next(m => m.type === 'terminalInfo' && m.id === 2)).running, true);
  assert.deepEqual(a.terminal, [true], 'Rejected commands and stale Stop cannot release retention');

  const runB = await start(b, 4);
  fs.writeFileSync(runB.release, 'exit');
  assert.equal((await b.next(m => m.type === 'terminalDone' && m.id === 4)).code, 0);
  await b.retained(false);
  assert(!alive(runB.pid)); assert(alive(runA.pid)); assert.deepEqual(a.terminal, [true]);
  await a.post({ type: 'terminalStop', id: 2 });
  const stopped = await a.next(m => m.type === 'terminalDone' && m.id === 2);
  assert.equal(stopped.code, 130); assert.equal(stopped.stopped, true);
  await a.retained(false);
  assert(!alive(runA.pid), 'Retention is released only after Stop kills the command');
  assert.deepEqual(a.terminal, [true, false]);
  await a.post({ type: 'terminalRun', id: 5, command: 'zer0ne_nonexistent_command_fixture' });
  await a.retained(true);
  assert.notEqual((await a.next(m => m.type === 'terminalDone' && m.id === 5)).code, 0);
  await a.retained(false);

  const runQuit = await start(a, 6);
  await a.stop();
  await until(() => !alive(runQuit.pid), 'Quit kills terminal descendants');
  for (const host of [a, b]) {
   assert(!host.protocol.some(m => m.op === 'busy' && m.on), 'Commands never create agent busy status');
   assert(!host.protocol.some(m => m.op === 'notify'), 'Commands never create agent completion notifications');
  }
  const missingShell = path.join(tmp, 'missing-shell.exe');
  const failed = await worker(projectA, path.join(tmp, 'failed-data'), process.platform === 'win32' ? { ComSpec: missingShell } : { SHELL: missingShell });
  hosts.push(failed);
  await failed.post({ type: 'terminalRun', id: 7, command: 'echo spawn-failure' });
  await failed.retained(true);
  assert.notEqual((await failed.next(m => m.type === 'terminalDone' && m.id === 7)).code, 0);
  await failed.retained(false);
  console.log('Terminal retention passed: real commands, two project hosts, activation refresh, stale Stop, rejected runs, normal exit, Stop, command/spawn failure, and Quit.');
 } finally {
  for (const host of hosts.reverse()) await host.stop();
  // Release only this test's fixtures if an assertion fails before shutdown completes.
  for (const pid of pids) if (alive(pid)) fs.writeFileSync(releases.get(pid), 'cleanup');
  await until(() => pids.every(pid => !alive(pid)), 'fixture cleanup');
  fs.rmSync(tmp, { recursive: true, force: true });
 }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
