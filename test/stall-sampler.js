'use strict';
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const path = require('path');
const sampler = path.join(__dirname, '../app/stall-sampler.js');
function run(source) {
	const result = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 15000, windowsHide: true });
	assert.equal(result.error, undefined);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
const load = `const sampler = require(${JSON.stringify(sampler)});`;
const idle = JSON.parse(run(`${load}
const monitor = sampler.start();
const before = process.cpuUsage();
setTimeout(() => {
	const used = process.cpuUsage(before);
	console.log(JSON.stringify({ cpuMs: (used.user + used.system) / 1000 }));
	monitor.stop();
}, 1500);`));
assert(idle.cpuMs < 600, `Idle sampler consumed ${idle.cpuMs}ms CPU in 1500ms`);
run(`${load}sampler.start();`);
const capture = JSON.parse(run(`${load}
const captures = [];
const monitor = sampler.start(value => captures.push(value));
setTimeout(() => {
	const end = Date.now() + 2000;
	while (Date.now() < end) { /* deliberately block the main thread */ }
	setTimeout(() => { monitor.stop(); console.log(JSON.stringify(captures)); }, 1000);
}, 500);`));
assert(capture.length > 0, 'The watcher must stay alive to detect a main-thread stall');
assert(capture[0].frames.some(frame => frame.selfMs > 0), 'A capture must include measured hot frames');
assert(capture[0].startLagMs >= 1000);
console.log(`Stall sampler passed: ${idle.cpuMs}ms idle CPU, process exit, and real stall capture.`);
