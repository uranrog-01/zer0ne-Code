'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
require('../../test/gui-lock').acquire();
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname,'../out');
const { findBrowser } = require(path.join(OUT,'tools/browser'));
const { runBrowserScenarios } = require(path.join(OUT,'tools/browserChecks'));
const base = fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-browser-checks-'));
const server = http.createServer((req,res) => {
	res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><title>Fixture checks</title><main>Welcome to the fixture</main>'+(req.url === '/error' ? '<script>throw new Error("fixture-console-error")</script>' : ''));
});
async function main() {
	if (!findBrowser()) { console.log('SKIP real browser scenarios: no Chrome/Edge/Brave installed.'); return; }
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const url='http://127.0.0.1:'+server.address().port;
	const report = {id:require('node:crypto').randomUUID(),kind:'browser',root:base,fingerprint:'fixture',startedAt:Date.now(),status:'running',stale:false,stages:[],scope:'Owned local fixture'};
	await runBrowserScenarios([
		{name:'passes',url,assertions:[{kind:'title',value:'Fixture checks'},{kind:'url',value:'127.0.0.1'},{kind:'selector',value:'main'},{kind:'text',value:'Welcome'},{kind:'no-console-errors',value:''}]},
		{name:'missing selector',url,assertions:[{kind:'selector',value:'#missing'}]},
		{name:'uncaught error',url:url+'/error',assertions:[{kind:'no-console-errors',value:''}]}
	],report,base,{path:'',headless:true},new AbortController().signal,()=>{});
	assert.deepEqual(report.stages.map(s=>s.status),['passed','failed','failed']); assert.match(report.stages[2].output,/fixture-console-error/);
	const shots = fs.readdirSync(path.join(base,'feature-shots')); assert.equal(shots.length,3);
	for (const file of shots) assert(fs.statSync(path.join(base,'feature-shots',file)).size > 1000);
	console.log('ok real headless browser: five passing assertions, missing selector, uncaught error and three screenshots in an isolated profile');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(base,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
