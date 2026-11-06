'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const {spawn, spawnSync} = require('child_process');
const readline = require('readline');

async function main() {
 // The built app (build.bat): the executable, and the app files under resources/app.
 const packaged = path.resolve(process.env.ZER0NE_PACKAGED_DIR || path.join(__dirname,'../dist/win-unpacked'));
 const exe = path.join(packaged,'zer0ne Code.exe');
 const app = path.join(packaged,'resources','app.asar.unpacked');
 const archive = path.join(packaged,'resources','app.asar');
 const asar = require('@electron/asar');
 const read = file => asar.extractFile(archive, path.normalize(file));
 const exists = file => { try { asar.statFile(archive, path.normalize(file)); return true; } catch { return false; } };
 assert(fs.existsSync(archive), 'protected app archive');
 assert(exists('app/release-integrity.json'), 'external runtime integrity manifest');
 const integrity = JSON.parse(read('app/release-integrity.json').toString('utf8'));
 assert(integrity.source.files['engine/test/run.js'], 'release provenance includes the engine tests');
 assert(integrity.source.files['engine/eval/reference.json'], 'release provenance includes the grader references');
 for (const directory of ['engine/eval/cases', 'engine/eval/judge']) {
  const sourceDirectory = path.join(__dirname, '..', directory);
  for (const name of fs.readdirSync(sourceDirectory, { recursive:true })) {
   if (!fs.statSync(path.join(sourceDirectory, name)).isFile()) continue;
   const file = directory + '/' + String(name).split(path.sep).join('/');
   assert(exists(file), 'evaluation resource is packaged: ' + file);
   assert.equal(integrity.files[file], require('crypto').createHash('sha256').update(read(file)).digest('hex'), 'evaluation resource is integrity protected: ' + file);
  }
 }
 assert(fs.existsSync(exe),'zer0ne Code.exe');
 const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
 const fuseWire = await getCurrentFuseWire(exe);
 for (const fuse of [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseV1Options.OnlyLoadAppFromAsar]) assert.equal(fuseWire[fuse], '1'.charCodeAt(0), 'packaged archive integrity fuse');
 assert(!fs.existsSync(path.join(packaged,'resources/app')), 'no loose app entry point');
 for(const file of ['app/panel-glass.js','app/desktop-glass.js','app/site-permissions.js','app/startup-queue.js','engine/media/chat.js','engine/media/workflow-history.js','engine/media/mcp-apps.js','engine/media/side-chat.js','engine/media/side-chat.css','engine/out/host/sideChat.js','engine/out/host/mcpAppsHost.js','engine/out/messageValidation.js','engine/out/host/sessionsHost.js','engine/out/providerStore.js']) {
  assert(exists(file),file);
  assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))),`Packaged file is stale: ${file}`);
 }
 for (const file of ['engine/out/host/cloudHost.js', 'engine/media/cloud/workflow.yml', 'engine/media/cloud/runner.mjs', 'engine/media/agent-ledger.css']) assert(read(file).equals(fs.readFileSync(path.join(__dirname, '..', file))), `Packaged chat or Cloud support is stale: ${file}`);
 for (const file of ['engine/out/tools/extensionCatalog.js', 'engine/out/host/turnRecovery.js']) assert(exists(file), file);
 for (const file of ['app/ops.js', 'engine/media/settings.js', 'engine/out/acp/client.js', 'engine/out/acp/signIn.js', 'engine/out/acp/verification.js', 'engine/out/host/acpHost.js', 'engine/out/host/workspaceHost.js']) {
  assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))),`Packaged sign-in recovery is stale: ${file}`);
 }
 for (const file of ['app/main.js', 'app/engines.js']) assert(read(file).equals(fs.readFileSync(path.join(__dirname, '..', file))), `Packaged window restore is stale: ${file}`);
 for (const file of ['engine/media/workbench.js', 'engine/media/workbench.css', 'engine/media/terminal/xterm.min.js', 'engine/media/terminal/xterm.css']) assert(read(file).equals(fs.readFileSync(path.join(__dirname, '..', file))), `Packaged terminal is stale: ${file}`);
 for (const file of ['app/computer-visuals.js', 'app/computer-overlay.cs', 'engine/media/computer-history.js', 'engine/out/tools/computer.js', 'engine/out/tools/agentTools.js', 'engine/media/sandbox/input.cs']) assert(read(file).equals(fs.readFileSync(path.join(__dirname, '..', file))), `Packaged Computer Use is stale: ${file}`);
 for (const file of ['host/storage.js', 'engine/media/chat.css', 'engine/out/acp/stream.js', 'engine/out/host/turnRunner.js']) assert(read(file).equals(fs.readFileSync(path.join(__dirname, '..', file))), `Packaged model switching is stale: ${file}`);
 const runSuite = suite => {
  const result = spawnSync(exe, [path.join(__dirname, '../engine/test', suite)], { windowsHide: true, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_TEST_ENGINE_OUT: path.join(app, 'engine/out') } });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  console.log(result.stdout.trim());
 };
 for (const file of ['engine/out/core/executionJournal.js', 'engine/out/host/taskEvidence.js', 'engine/out/host/toolExecutor.js', 'engine/out/host/turnAgents.js', 'engine/out/host/verify.js', 'engine/out/host/writers.js']) assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))), `Packaged task evidence is stale: ${file}`);
 runSuite('task-evidence.test.js');
 for (const file of ['engine/out/tools/command.js','engine/out/tools/proc.js','engine/out/tools/jobGuard.js','engine/out/core/tools.js','engine/out/host/projectActions.js','engine/media/sandbox/job.cs']) assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))), `Packaged harness audit is stale: ${file}`);
 runSuite('harness-audit.test.js');
 for (const file of ['engine/out/host/hunkReview.js', 'engine/out/host/modelComparisons.js', 'engine/out/checkpoints.js', 'engine/out/worktrees.js', 'engine/media/chat.js', 'engine/media/chat.css']) assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))), `Packaged change review is stale: ${file}`);
 runSuite('change-review.test.js');
 for (const file of ['engine/media/chat.js','engine/media/chat.css','engine/media/markdown.js']) assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))), `Packaged streaming message is stale: ${file}`);
 runSuite('streaming-message.test.js');
 for (const file of ['engine/media/settings.css','engine/out/host/featureRegistry.js','engine/out/host/featureToolsHost.js','engine/out/host/featuresHealth.js','engine/out/tools/projectChecks.js','engine/out/tools/featureTools.js','engine/out/tools/browserChecks.js','engine/out/tools/languageService.js','engine/out/tools/moreTools.js','engine/out/tools/browser.js']) assert(read(file).equals(fs.readFileSync(path.join(__dirname,'..',file))),`Packaged Features implementation is stale: ${file}`);
 for (const suite of ['extension-catalog.test.js', 'turn-recovery.test.js', 'mcp-app-lifecycle.test.js', 'model-switching.test.js','provider-safety.test.js','features-dashboard.test.js','features-audit.test.js','features-browser.test.js']) runSuite(suite);
 for (const file of ['app/main.js','app/preload.js','app/desktop-ui.js','app/desktop-glass.js','ui/index.html','host/main.js','engine/out/chatController.js','engine/out/acp/runtime.js','engine/out/host/acpHost.js','engine/out/host/loginTerminal.js','engine/out/host/marketplaceHost.js','engine/out/tools/marketplace.js','engine/out/remote.js','engine/vscode-shim.js']) assert(exists(file),file);
 assert(exists('engine/out/tunnel.js'),'Phone connection helper is packaged');
 for (const file of ['engine/out/ollamaSetup.js','engine/out/localHostServer.js','engine/out/localLive.js']) assert(exists(file),file);
 for (const file of ['engine/out/vendor/js-yaml.js','engine/out/vendor/js-yaml.LICENSE']) assert(exists(file),file);
 for (const file of ['engine/out/modelDiscovery.js','engine/out/localAdvisor.js','engine/out/nativeSupport.js','engine/out/vendor/llama-architectures.json','engine/out/vendor/llama.LICENSE','engine/out/vendor/llmfit-catalog.json','engine/out/vendor/llmfit.LICENSE']) assert(exists(file),file);
 // engine/bin is not in the public source: without it the app downloads llmfit when it is needed.
 if (fs.existsSync(path.join(__dirname,'../engine/bin/win32-x64/llmfit.exe'))) for (const file of ['engine/bin/win32-x64/llmfit.exe','engine/bin/win32-x64/llmfit.LICENSE']) assert(exists(file),file);
 for (const file of ['engine/out/core/toolCalls.js','engine/out/host/turnAgents.js','engine/out/host/subagentRuntime.js','engine/out/host/writers.js']) assert(exists(file),file);
 const agentChecks = spawnSync(exe, [path.join(__dirname, '../engine/test/agents-regressions.test.js')], { windowsHide: true, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_TEST_ENGINE_OUT: path.join(app, 'engine/out') } });
 assert.equal(agentChecks.status, 0, `${agentChecks.error || ''}\n${agentChecks.stdout}\n${agentChecks.stderr}`);
 console.log('Packaged agent regressions passed on the app runtime: 24/24 cases.');
 const localChecks = spawnSync(exe, [path.join(__dirname, '../engine/test/local-router-protocols.test.js')], { windowsHide: true, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_TEST_ENGINE_OUT: path.join(app, 'engine/out') } });
 assert.equal(localChecks.status, 0, `${localChecks.error || ''}\n${localChecks.stdout}\n${localChecks.stderr}`);
 console.log('Packaged local router protocols, UI and agent benchmarks passed on the app runtime: 5/5 cases.');
 const modelChecks = spawnSync(exe, [path.join(__dirname, '../engine/test/model-discovery.test.js')], { windowsHide: true, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZER0NE_TEST_ENGINE_OUT: path.join(app, 'engine/out') } });
 assert.equal(modelChecks.status, 0, `${modelChecks.error || ''}\n${modelChecks.stdout}\n${modelChecks.stderr}`);
 console.log('Packaged model discovery, pre-download metadata scans and file verification passed on the app runtime: 16/16 cases.');
 assert(exists('engine/media/settings-remote.js'),'Remote settings module is packaged');
 for (const file of ['engine/out/host/feishuHost.js','node_modules/@larksuiteoapi','engine/src','engine/test','engine/demo','test','scripts','node_modules/electron','node_modules/electron-builder','node_modules/typescript','node_modules/jsdom','build.bat','engine/out/host/modsHost.js','engine/out/host/telegramHost.js','engine/out/host/channelsHost.js','engine/out/cli','engine/out/extension.js','engine/media/Inspiration .mp4','engine/media/mods','engine/media/skills/mod-authoring','engine/media/analysis.js','engine/bin/win32-x64/zer0ne-tools.exe']) assert(!exists(file),`Removed content still packaged: ${file}`);
 assert.deepStrictEqual(fs.readdirSync(path.join(packaged,'locales')),['en-US.pak'],'only the English UI locale ships');
 const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'zer0ne-packaged-'));
 const workspace = path.join(tmp,'project'); fs.mkdirSync(workspace);
 fs.mkdirSync(path.join(workspace,'.zer0ne','skills','yaml'),{recursive:true});
 fs.writeFileSync(path.join(workspace,'.zer0ne','skills','yaml','SKILL.md'),'---\nname: yaml\ndescription: >-\n  Packaged YAML\n  parser works\n---\nBODY');
 // The app runs its engine host on its own executable in Node mode (app/engines.js).
 const child = spawn(exe,[path.join(app,'host/main.js')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 const messages = []; let stderr = '';
 child.stderr.on('data',chunk=>stderr+=chunk);
 readline.createInterface({input:child.stdout}).on('line',line=>messages.push(JSON.parse(line)));
 const send = message=>child.stdin.write(JSON.stringify(message)+'\n');
 const wait = async predicate=>{const until=Date.now()+20000;while(Date.now()<until){const i=messages.findIndex(predicate);if(i>=0)return messages.splice(i,1)[0];if(child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,20));}throw Error('Packaged host timed out: '+stderr);};
 let eventRequest;
 try {
  send({t:'init',engineDir:path.join(app,'engine'),dataDir:path.join(tmp,'data'),workspace,key:Buffer.alloc(32,1).toString('base64')});
  const ready = await wait(m=>m.t==='ready');
  const page = await fetch(ready.url);assert.equal(page.status,200);
  const html = await page.text();assert(html.includes('zc-dialog'));assert(!html.includes('aux-tab-tasks'));
  assert(html.includes('settings-remote.js') && html.indexOf('settings-remote.js') < html.indexOf('settings.js'),'Remote settings load before the main settings module');
  for(const id of ['btn-mods','mods-popup','mod-band']) assert(!html.includes('id="'+id+'"'),'Removed composer control '+id);
  const uiMessages=[];
  eventRequest=http.get(new URL('/api/events?t='+new URL(ready.url).searchParams.get('t'),ready.url),response=>{
   let buffer='';response.setEncoding('utf8');response.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(frame.startsWith('data: '))uiMessages.push(JSON.parse(frame.slice(6)));}});
  });
  send({t:'activate',handoff:{kind:'session',sessionId:'missing'},activationId:'bad'});
  assert.equal((await wait(m=>m.t==='activationError')).activationId,'bad');
  send({t:'activate',handoff:null,activationId:'recovered'});
  const recoveryUntil=Date.now()+15000;while(!uiMessages.some(m=>m.type==='zcDesktopActivated'&&m.activationId==='recovered')&&Date.now()<recoveryUntil)await new Promise(r=>setTimeout(r,20));
  assert(uiMessages.some(m=>m.type==='zcDesktopActivated'&&m.activationId==='recovered'),'Packaged activation recovers after a failure');
  assert(uiMessages.some(m=>m.type==='state'&&m.capabilities.remoteTunnels===true&&m.capabilities.mods===false),'Packaged capability profile preserves phone tunnels without Mods');
  assert(uiMessages.some(m=>m.type==='state'&&m.skills?.some(s=>s.name==='yaml'&&s.description==='Packaged YAML parser works')),'Packaged YAML parser works without node_modules');
  eventRequest.destroy();
  send({t:'shutdown'});
  const until=Date.now()+10000;while(child.exitCode===null&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
  assert.equal(child.exitCode,0,stderr);
  console.log('Packaged host checks passed: the app executable as Node, trimmed resources, protocol, activation failure and shutdown.');
 } finally {
  eventRequest?.destroy();
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  fs.rmSync(tmp,{recursive:true,force:true});
 }
 // A covering desktop window must not prevent independent package checks.
 runSuite('computer.test.js');
 runSuite('computer-ui.test.js');
 console.log('Packaged smoke passed, including native Computer Use.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
