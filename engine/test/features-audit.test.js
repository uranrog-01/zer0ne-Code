'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const OUT = process.env.ZER0NE_TEST_ENGINE_OUT || path.resolve(__dirname,'../out');
const { createProjectPlan, runProjectPlan } = require(path.join(OUT,'tools/projectChecks'));
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-audit-')));
const requests = [];
const server = http.createServer((req,res) => {
	requests.push(req.url); req.resume();
	const data = req.url.includes('/security/advisories/bulk') ? {'fixture-dependency':[{id:12345678,url:'https://example.invalid/fixture',title:'Owned audit fixture',severity:'high',vulnerable_versions:'<=1.0.0',cwe:['CWE-79'],cvss:{score:7,vectorString:null},name:'fixture-dependency'}]} : {name:'fixture-dependency','dist-tags':{latest:'2.0.0'},versions:{'1.0.0':{name:'fixture-dependency',version:'1.0.0'},'2.0.0':{name:'fixture-dependency',version:'2.0.0'}}};
	res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(data));
});
async function main() {
	await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
	// npm lifecycle parents export prefix/workspace flags; fixtures must not inherit those projects or caches.
	for (const key of Object.keys(process.env)) if (/^npm_(config|package|lifecycle)_/i.test(key) || key === 'INIT_CWD') delete process.env[key];
	process.env.npm_config_registry='http://127.0.0.1:'+server.address().port;
	process.env.npm_config_cache=path.join(base,'.cache');
	process.env.npm_config_audit='true';
	process.env.npm_config_offline='false';
	process.env.npm_config_userconfig=path.join(base,'user.npmrc');
	process.env.npm_config_prefix=path.dirname(base);
	process.env.npm_config_local_prefix=path.dirname(base);
	fs.writeFileSync(path.join(base,'.npmrc'),'registry=http://127.0.0.1:'+server.address().port+'\nfund=false\nupdate-notifier=false\n');
	fs.writeFileSync(path.join(base,'package.json'),JSON.stringify({name:'owned-audit-fixture',version:'1.0.0',dependencies:{'fixture-dependency':'1.0.0'}}));
	fs.writeFileSync(path.join(base,'package-lock.json'),JSON.stringify({name:'owned-audit-fixture',version:'1.0.0',lockfileVersion:3,requires:true,packages:{'':{name:'owned-audit-fixture',version:'1.0.0',dependencies:{'fixture-dependency':'1.0.0'}},'node_modules/fixture-dependency':{version:'1.0.0',resolved:'http://127.0.0.1:'+server.address().port+'/fixture.tgz'}}}));
	const plan = await createProjectPlan(base,'audit'); let approvals=0;
	const report = await runProjectPlan(plan,{settings:{commandTool:true},signal:AbortSignal.timeout(30000),requestApproval:async()=>{approvals++;return {approved:true,auto:false,finish(){}};}},()=>{});
	assert.equal(approvals,1); assert(requests.some(url=>url.includes('/security/advisories/bulk')),JSON.stringify(report));
	assert.equal(report.stages[0].status,'findings',JSON.stringify(report.stages)); assert.equal(report.status,'failed');
	assert.equal(report.stages[0].findings[0].name,'fixture-dependency'); assert.equal(report.stages[0].findings[0].severity,'high');
	assert.deepEqual(report.stages[0].findings[0].versions,['1.0.0']); assert.equal(report.stale,false);
	console.log('ok real npm audit against an owned local registry: approved command, structured findings, installed versions and unchanged project');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(base,{recursive:true,force:true});});
