'use strict';
const assert = require('node:assert/strict'), path = require('node:path');

module.exports = async function uiPolishSmoke(page, shots, until) {
	await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await page.eval(`window.__polishErrors=[];window.addEventListener('error',event=>window.__polishErrors.push(event.error?.stack||event.message))`);
	try {
		const code = '```javascript\n' + Array.from({ length: 35 }, (_, index) => 'const value' + index + ' = ' + index + ';').join('\n') + '\n```';
		const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="#f4f1e9"/><rect x="80" y="80" width="1440" height="840" rx="24" fill="#fff" stroke="#d97757" stroke-width="4"/><text x="140" y="200" font-family="sans-serif" font-size="48" fill="#292724">Image inspection</text><text x="140" y="300" font-family="monospace" font-size="24" fill="#57534e">Zoom around the pointer to inspect small details.</text><path d="M140 400h1320M140 500h1320M140 600h1320M140 700h1320" stroke="#e1ddd4" stroke-width="2"/></svg>');
		const settings = { theme: 'claude-code', accent: 'clay', glass: false, groupTerminal: false, groupChanges: false };
		const messages = [
			{ id: 'polish-user', role: 'user', content: 'Review the interface and inspect this screenshot.' },
			{ id: 'polish-running', role: 'assistant', kind: 'tool', content: '', approval: { id: 'polish-command', kind: 'command', status: 'applied', execution: 'running', command: 'npm run check' } },
			{ id: 'polish-pending', role: 'assistant', kind: 'tool', content: '', approval: { id: 'polish-permission', kind: 'mcp', status: 'pending', tool: 'filesystem.preview', args: '{"path":"src/app.js"}' } },
			{ id: 'polish-code', role: 'assistant', content: code },
			{ id: 'polish-image', role: 'assistant', kind: 'tool', content: '', tool: { name: 'browser_screenshot', status: 'done', arg: 'Preview', summary: 'Screenshot captured', image, url: 'https://example.test/preview' } }
		];
		const fixture = { type: 'state', currentSessionId: 'ui-polish-fixture', settings, messages, providers: [{ id: 'polish-provider', name: 'Fixture provider', enabled: true, efforts: {}, models: [{ id: 'fixture-model', name: 'Fixture model', enabled: true }] }], selection: { providerId: 'polish-provider', model: 'fixture-model' } };
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(fixture) + '}))');
		await until('polished tool cards', () => page.eval(`document.querySelector('.approval-row.running .tool-status')?.textContent === 'Running' && document.querySelector('.approval.pending .tool-status')?.textContent === 'Needs approval'`));
		assert(await page.eval(`!document.querySelector('.approval-row.running .tool-sum.good')`), 'approval alone cannot display successful execution');
		await page.eval(`(() => { const input = document.getElementById('input'); input.value = '/'; input.dispatchEvent(new Event('input')); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true, cancelable:true})); })()`);
		assert.equal(await page.eval(`document.getElementById('input').value`), '/');
		await until('batched slash suggestions', () => page.eval(`document.getElementById('input').getAttribute('aria-expanded') === 'true'`));
		await page.eval(`document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true})); document.getElementById('messages').scrollTo({top:0})`);
		await page.eval(`document.getElementById('input').value=''; document.getElementById('input').focus()`);
		await page.send('Input.imeSetComposition', { text: '未確定の入力', selectionStart: 6, selectionEnd: 6 });
		assert.equal(await page.eval(`document.getElementById('input').value`), '未確定の入力');
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify({ ...fixture, currentSessionId: 'ui-polish-destination' }) + '}))');
		assert.equal(await page.eval(`document.getElementById('input').value`), '', 'the destination chat has its own draft');
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(fixture) + '}))');
		assert.equal(await page.eval(`document.getElementById('input').value`), '未確定の入力', 'Blink IME draft survives switching chats');
		await page.eval(`document.getElementById('input').value=''; document.getElementById('input').dispatchEvent(new Event('input'))`);
		await page.eval(`(() => {
			window.__documentSmokePost = window.Bridge.post;
			window.__documentSmokeFiles = ['nested/document.txt','nested/src/main.ts','package.json','README.md','assets/icon.svg'];
			window.__documentSmokeGit = {type:'gitStatus',branch:'fixture-main',clean:false,changes:[{path:'nested/document.txt',status:'M',added:1,removed:0}],added:1,removed:0};
			window.Bridge.post = message => {
				if(message.type === 'getFiles') { setTimeout(() => window.dispatchEvent(new MessageEvent('message', {data:{type:'files',files:window.__documentSmokeFiles}})), 0); return; }
				if(message.type === 'getGitStatus') { setTimeout(() => window.dispatchEvent(new MessageEvent('message', {data:window.__documentSmokeGit})), 0); return; }
				if(message.type === 'previewFile') { setTimeout(() => window.dispatchEvent(new MessageEvent('message', {data:{type:'filePreview',sessionId:message.sessionId,path:message.path,content:'Saved document ' + message.sessionId,lines:1,size:40}})), 0); return; }
				return window.__documentSmokePost(message);
			};
			if(document.getElementById('auxiliary').classList.contains('hidden')) document.getElementById('btn-auxiliary').click();
			document.getElementById('aux-tab-explorer').click();
			window.dispatchEvent(new MessageEvent('message', {data:window.__documentSmokeGit}));
			window.dispatchEvent(new MessageEvent('message', {data:{type:'files',files:window.__documentSmokeFiles}}));
			document.querySelector('[data-aux-tree-dir="nested"]').click();
			document.querySelector('[data-aux-open-file="nested/document.txt"]').click();
		})()`);
		try {
			await until('document preview loaded', () => page.eval(`document.getElementById('aux-explorer-preview').textContent.includes('Saved document ui-polish-fixture')`));
			const savedWidth = await page.eval(`document.body.style.getPropertyValue('--zc-aux-w')`);
			try {
				for (const width of [360, 600]) {
					await page.eval(`document.body.style.setProperty('--zc-aux-w','${width}px'); document.querySelector('#git-tools [data-gt="mini"]')?.click()`);
					await until('Explorer adapts at ' + width, () => page.eval(`(() => { const t=document.getElementById('aux-explorer-tree').getBoundingClientRect(),p=document.getElementById('aux-explorer-preview').getBoundingClientRect();return t.width>0&&t.height>0&&p.width>0&&p.height>0&&${width < 560 ? 't.bottom<=p.top+1' : 't.right<=p.left+1'}; })()`));
					const layout = await page.eval(`(() => {const card=document.getElementById('git-tools'),chat=document.querySelector('.primary-chat'),aux=document.getElementById('auxiliary');return {owned:card.parentElement===chat,git:card.getBoundingClientRect().toJSON(),chat:chat.getBoundingClientRect().toJSON(),aux:aux.getBoundingClientRect().toJSON()};})()`);
					assert(layout.owned && layout.git.width>0 && layout.git.right<=layout.chat.right+1 && layout.git.left>=layout.chat.left-1 && layout.git.right<=layout.aux.left+1, 'Git stays inside the chat when Work Details resizes: ' + JSON.stringify(layout));
					await page.eval(`document.getElementById('sp-mini').click(); document.querySelector('#git-tools [data-gt="changes"]').click()`);
					const review = await page.eval(`(() => {const box=document.getElementById('git-review'),chat=document.querySelector('.primary-chat').getBoundingClientRect();return {shown:box.classList.contains('on'),owned:box.parentElement===document.querySelector('.primary-chat'),rect:box.getBoundingClientRect().toJSON(),chat:chat.toJSON()};})()`);
					assert(review.shown && review.owned && review.rect.left>=review.chat.left-1 && review.rect.right<=review.chat.right+1, 'Git changes review stays in the chat layer: ' + JSON.stringify(review));
					await page.eval(`document.querySelector('#git-review [data-gr="close"]').click(); document.querySelector('#git-tools [data-gt="mini"]').click()`);
					await page.screenshot(path.join(shots, 'work-details-explorer-' + width + '.png'));
				}
			} finally { await page.eval(`document.body.style.setProperty('--zc-aux-w',${JSON.stringify(savedWidth)})`); }
			await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify({ ...fixture, currentSessionId: 'ui-polish-destination' }) + '}))');
			assert(await page.eval(`!document.getElementById('aux-content-explorer').classList.contains('aux-previewing')`), JSON.stringify(await page.eval(`({errors:window.__polishErrors,views:window.Bridge.getState().documentViews})`)));
			await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(fixture) + '}))');
			await until('returning chat restores its document', () => page.eval(`document.getElementById('aux-explorer-preview').textContent.includes('Saved document ui-polish-fixture')`));
			assert(await page.eval(`!!document.querySelector('[data-aux-tree-dir="nested"].open') && !!document.querySelector('[data-aux-open-file="nested/document.txt"]')`), 'expanded subdirectories survive switching chats');
		} finally { await page.eval(`window.Bridge.post=window.__documentSmokePost; delete window.__documentSmokePost; delete window.__documentSmokeFiles; delete window.__documentSmokeGit`); }
		await page.screenshot(path.join(shots, 'chat-polish-dark.png'));
		await page.eval(`document.getElementById('btn-model').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true}))`);
		assert(await page.eval(`document.getElementById('model-menu').contains(document.activeElement)`));
		await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`);
		assert.equal(await page.eval(`document.activeElement.id`), 'btn-model');
		await page.eval(`document.querySelector('[data-wrap-code]').click(); document.querySelector('[data-expand-code]').click()`);
		assert(await page.eval(`document.querySelector('[data-wrap-code]').getAttribute('aria-pressed') === 'true' && document.querySelector('[data-expand-code]').getAttribute('aria-expanded') === 'true'`));
		await page.eval(`document.querySelector('[data-zoom]').click()`);
		await until('image fitted', () => page.eval(`document.getElementById('lightbox-img').naturalWidth === 1600 && document.querySelector('.lightbox-viewport').clientWidth > 0`));
		const zoom = await page.eval(`(() => { const root = document.getElementById('lightbox'), viewport = root.querySelector('.lightbox-viewport'), r = viewport.getBoundingClientRect(); viewport.dispatchEvent(new WheelEvent('wheel', {deltaY:-70, clientX:r.left+r.width*.6, clientY:r.top+r.height*.4, cancelable:true})); const image = root.querySelector('img'); return {transform:image.style.transform, width:image.getBoundingClientRect().width, zoomed:root.classList.contains('zoomed'), inside:root.contains(document.activeElement)}; })()`);
		assert(zoom.zoomed && zoom.inside && zoom.width > 0); assert.match(zoom.transform, /translate\(-/);
		await page.screenshot(path.join(shots, 'chat-image-zoom.png'));
		await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`);
		assert(await page.eval(`document.getElementById('lightbox').classList.contains('hidden') && !document.querySelector('.coding-workspace').inert && document.activeElement.hasAttribute('data-zoom')`));
		await page.eval(`if(!document.getElementById('auxiliary').classList.contains('hidden'))document.getElementById('btn-auxiliary').click();if(!document.getElementById('sidebar').classList.contains('hidden'))document.getElementById('btn-sidebar').click();`);
		const ledgerFixture = { ...fixture, undoable: ['ledger-one', 'ledger-two'], redoable: ['ledger-one', 'ledger-two'], messages: [
			{ id: 'ledger-one', role: 'user', content: 'Update the pricing page.', turn: { startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, model: 'Coding agent', edits: [{ path: 'src/pricing.ts', added: 1, removed: 1, previewBefore: 'price: 29', previewAfter: 'price: 34' }, { path: 'src/faq.md', added: 3, removed: 3, previewBefore: 'Previous pricing FAQ', previewAfter: 'Updated pricing FAQ' }] } },
			{ id: 'ledger-answer-one', role: 'assistant', content: 'Updated the price and the FAQ.' },
			{ id: 'ledger-two', role: 'user', content: 'Add the annual price and deploy.', turn: { startedAt: Date.now() - 20000, endedAt: Date.now() - 1000, model: 'Coding agent', edits: [{ path: 'src/pricing.ts', added: 1, removed: 0, previewBefore: 'annual: null', previewAfter: 'annual: 340' }] } },
			{ id: 'ledger-status', role: 'assistant', kind: 'tool', content: '', approval: { kind: 'command', status: 'applied', execution: 'done', command: 'git status', result: 'Working tree checked' } },
			{ id: 'ledger-deploy', role: 'assistant', kind: 'tool', content: '', approval: { kind: 'mcp', externalAction: true, status: 'applied', execution: 'done', tool: 'Hosting › deploy', result: 'Deployment completed' } },
			{ id: 'ledger-answer-two', role: 'assistant', content: 'Added annual pricing and deployed the site.' }
		] };
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(ledgerFixture) + '}));document.getElementById("messages").scrollTop=0');
		await until('compact changes rendered', () => page.eval(`document.querySelectorAll('.agent-ledger:not(.external-activity)').length === 2 && document.querySelectorAll('.external-activity').length === 1`));
		assert(await page.eval(`Array.from(document.querySelectorAll('.ledger-body')).every(body=>body.hidden) && document.querySelector('.ledger-disclosure').textContent.includes('2 files changed')`), 'summaries start collapsed and count files only');
		assert(await page.eval(`Math.abs(document.querySelector('.agent-ledger').getBoundingClientRect().left-document.querySelector('.msg.assistant').getBoundingClientRect().left)<1`), 'compact summaries align with the reply');
		await page.screenshot(path.join(shots, 'agent-changes-compact-dark.png'));
		await page.eval(`document.querySelectorAll('.ledger-disclosure').forEach(button=>button.click())`);
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(ledgerFixture) + '}))');
		assert(await page.eval(`Array.from(document.querySelectorAll('.ledger-body')).every(body=>!body.hidden)`), 'disclosure state survives chat updates');
		await page.eval(`document.querySelector('[data-ledger-preview]').focus()`);
		assert(await page.eval(`document.querySelectorAll('.ui-alc__row[data-chain="also"]').length === 1 && document.querySelectorAll('.ui-alc__row[data-chain="kept"]').length === 1`), 'keyboard focus previews later file edits and retained external actions');
		await page.eval(`new Promise(resolve=>setTimeout(resolve,600))`);
		await page.screenshot(path.join(shots, 'agent-ledger-dark.png'));
		await page.eval(`window.SideChat.show()`);
		await page.screenshot(path.join(shots, 'writing-assistant-dark.png'));
		await page.eval(`document.querySelector('[data-side-close]').click()`);
		await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 1, mobile: false });
		await page.eval(`window.applyAppearance({theme:'claude-light',accent:'clay',glass:false}); document.getElementById('messages').scrollTo({top:0})`);
		await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
		await until('narrow layout', () => page.eval(`innerWidth === 390`));
		assert(await page.eval(`document.documentElement.scrollWidth <= innerWidth && getComputedStyle(document.querySelector('.ui-alc__row')).animationName === 'none'`));
		assert(await page.eval(`Array.from(document.querySelectorAll('.agent-ledger .ui-alc__row')).every(row => {const r=row.getBoundingClientRect();return r.width>0 && r.left>=0 && r.right<=innerWidth;})`), 'ledger rows fit the narrow chat');
		await page.screenshot(path.join(shots, 'agent-ledger-light-narrow.png'));
		await page.eval(`(() => {
			window.__changeReviewPost=window.Bridge.post; window.__changeReviewMessages=[];
			window.Bridge.post=message=>{if(['hunkReview','hunkDecision','comparisonList','comparisonStart','comparisonReview','comparisonStop'].includes(message.type)){window.__changeReviewMessages.push(message);return;}return window.__changeReviewPost(message);};
			document.querySelector('[data-hunk-review="ledger-two"]').focus(); document.querySelector('[data-hunk-review="ledger-two"]').click();
			window.dispatchEvent(new MessageEvent('message',{data:{type:'hunkReviewResult',sessionId:'ui-polish-fixture',id:'ledger-two',path:'src/pricing.ts',reviewId:'fixture-review',hunks:[{index:0,line:2,before:'annual: null',after:'annual: 340',undone:false,kept:false}]}}));
		})()`);
		try {
			assert(await page.eval(`document.querySelector('.hunk-review-dialog:modal')?.textContent.includes('annual: 340')`));
			assert(await page.eval(`(() => {const r=document.querySelector('.hunk-review-dialog').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()`), 'hunk review fits the narrow viewport');
			await page.eval(`document.querySelector('[data-hunk-action="undo"]').click()`);
			assert.equal(await page.eval(`window.__changeReviewMessages.at(-1).action`), 'undo');
			await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:{type:'hunkReviewResult',sessionId:'ui-polish-fixture',error:'File changed outside this review'}}))`);
			assert(await page.eval(`!document.querySelector('[data-hunk-action]').disabled`));
			await page.screenshot(path.join(shots, 'hunk-review-light-narrow.png'));
			await page.eval(`document.querySelector('.hunk-review-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
			await until('hunk review closes and restores its trigger', () => page.eval(`!document.querySelector('.hunk-review-dialog') && document.activeElement.dataset.hunkReview==='ledger-two'`));
			await page.eval(`document.getElementById('input').value='Retain this comparison draft';document.getElementById('input').dispatchEvent(new Event('input'));document.getElementById('btn-plus').click();Array.from(document.querySelectorAll('#plus-menu button')).find(button=>button.textContent.includes('Compare models')).click()`);
			assert(await page.eval(`!!document.querySelector('.comparison-dialog:modal') && document.querySelectorAll('.comparison-dialog select').length===4`));
			await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:{type:'comparisonState',sessionId:'ui-polish-fixture',groups:[{id:'fixture-group',prompt:'Add annual pricing',base:'abcdef0123456789',active:false,candidates:[{id:'candidate-one',spec:'Fixture model',status:'done',attempts:2,input:100,output:20,cost:0,unknownCost:true,elapsedMs:1200,checks:[],report:'Added annual pricing',stat:{files:1,added:1,removed:0}}]}]}}))`);
			assert(await page.eval(`document.querySelector('.comparison-dialog').textContent.includes('Cost unavailable') && document.querySelector('.comparison-dialog').textContent.includes('No verification recorded')`));
			await page.eval(`document.querySelector('[data-comparison-review]').click();window.dispatchEvent(new MessageEvent('message',{data:{type:'comparisonDiff',sessionId:'ui-polish-fixture',groupId:'fixture-group',id:'candidate-one',reviewId:'comparison-review',files:['src/pricing.ts'],patch:'+ annual: 340',truncated:false,applied:false}}))`);
			const comparisonBounds = await page.eval(`(() => {const dialog=document.querySelector('.comparison-dialog'),r=dialog.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,hasApply:!!dialog.querySelector('[data-comparison-action="apply"]'),scrollHeight:dialog.scrollHeight,bodyHeight:dialog.querySelector('.dialog-body').clientHeight};})()`);
			assert(comparisonBounds.left>=0 && comparisonBounds.right<=comparisonBounds.width && comparisonBounds.bottom<=comparisonBounds.height && comparisonBounds.hasApply, JSON.stringify(comparisonBounds));
			await page.screenshot(path.join(shots, 'model-comparison-light-narrow.png'));
			await page.eval(`document.querySelector('.comparison-dialog').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
			await until('comparison review closes', () => page.eval(`!document.querySelector('.comparison-dialog')`));
			assert.equal(await page.eval(`document.getElementById('input').value`), 'Retain this comparison draft');
		} finally { await page.eval(`document.querySelector('.hunk-review-dialog')?.close();document.querySelector('.comparison-dialog')?.close();window.Bridge.post=window.__changeReviewPost;delete window.__changeReviewPost;document.getElementById('input').value='';document.getElementById('input').dispatchEvent(new Event('input'))`); }
		await page.eval(`window.SideChat.show()`);
		const sideChatState = { ...fixture, settings: { ...fixture.settings, theme: 'claude-light' }, providers: [...fixture.providers, { id: 'polish-local', name: 'Local Ollama', enabled: true, apiFormat: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'qwen3-8b', name: 'Qwen3 8B', enabled: true }] }] };
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(sideChatState) + '}))');
		await until('side chat local provider', () => page.eval(`[...document.querySelectorAll('#side-chat select option')].some(o => o.textContent === 'Qwen3 8B')`));
		assert(await page.eval(`(() => { const r=document.getElementById('side-chat').getBoundingClientRect(), send=document.querySelector('.side-chat-send').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && send.right<=r.right && send.bottom<=r.bottom; })()`), 'Side Chat controls fit a narrow viewport');
		await page.screenshot(path.join(shots, 'side-chat-light-narrow.png'));
		await page.eval(`document.querySelector('.side-chat-model-btn').click()`);
		await until('side chat provider menu', () => page.eval(`document.querySelectorAll('.side-chat-menu:not([hidden]) .side-chat-provider').length >= 2`));
		assert(await page.eval(`!!document.querySelector('.side-chat-menu .side-chat-menu-list .side-chat-opt')`), 'the provider side pane lists its models');
		assert(await page.eval(`(() => { const r=document.querySelector('.side-chat-menu').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })()`), 'the two-pane model menu fits the narrow window');
		await page.screenshot(path.join(shots, 'side-chat-models.png'));
		await page.eval(`document.querySelector('.side-chat-menu input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
		await until('side chat model menu closed', () => page.eval(`document.querySelector('.side-chat-menu').hidden`));
		await page.eval(`document.querySelector('[data-side-close]').click()`);
		const welcomeFixture = { ...ledgerFixture, messages: [], providers: [], selection: {}, sessions: [], agentRuns: [], isStreaming: false, streaming: null };
		await page.eval('window.dispatchEvent(new MessageEvent("message", {data:' + JSON.stringify(welcomeFixture) + '}))');
		await until('welcome without a setup guide', () => page.eval(`(() => { const w=document.querySelector('.welcome'); return !!w && !w.querySelector('.sgc') && !w.querySelector('.welcome-status') && !!w.querySelector('.welcome-hero'); })()`));
		assert(await page.eval(`document.querySelector('.welcome').textContent.includes('Connect your first model')`), 'the welcome screen leads with the connection action');
		assert(await page.eval(`document.querySelector('.welcome [data-open-setup]')?.textContent.includes('Start without an API key')`), 'the welcome offers the zero-key local setup');
		await page.screenshot(path.join(shots, 'welcome-light-narrow.png'));
		await require('./polish-pass-smoke')(page, shots, until, welcomeFixture);
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.eval(`window.__repositoryPost=window.Bridge.post;window.Bridge.post=m=>['getGitStatus','getWorktrees','gitOpenDiff'].includes(m.type)?undefined:window.__repositoryPost(m);window.__repositoryPanelStyle=document.getElementById('auxiliary').style.cssText;if(document.getElementById('auxiliary').classList.contains('hidden'))document.getElementById('btn-auxiliary').click();document.getElementById('auxiliary').style.setProperty('flex','0 0 620px','important');document.getElementById('auxiliary').style.width='620px'`);
		try {
			const gitError = 'fatal: not a git repository (or any of the parent directories): .git';
			const snapshots = [
				['files', 'changes-no-repository', {type:'gitStatus',changes:[],error:gitError}],
				['worktrees', 'worktrees-no-repository', {type:'worktrees',items:[],error:'This folder is not a Git repository. Initialize Git (and make a first commit) to use worktrees.'}],
				['files', 'changes-clean', {type:'gitStatus',branch:'main',changes:[],added:0,removed:0}],
				['files', 'changes-review', {type:'gitStatus',branch:'feature/work-details',added:42,removed:9,changes:[{path:'src/components/Workspace.tsx',status:'M',added:28,removed:7},{path:'src/styles/workspace.css',status:'M',added:14,removed:2,staged:true},{path:'docs/workspace-guide.md',status:'?'}]}],
				['worktrees', 'worktrees-checkouts', {type:'worktrees',items:[{path:'C:/Projects/zer0ne',branch:'main',head:'a01e9c23',main:true,current:true},{path:'C:/Projects/zer0ne.worktrees/work-details',branch:'feature/work-details',head:'93c4be1',main:false},{path:'C:/Projects/zer0ne.worktrees/release-check',head:'4e91d8f',locked:true}]}]
			];
			for (const [tab, name, data] of snapshots) {
				await page.eval('document.getElementById("aux-tab-' + tab + '").click();window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify(data) + '}))');
				await page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify({ ...welcomeFixture, settings:{...settings,theme:'claude-code'} }) + '}))');
				await page.screenshot(path.join(shots, name + '.png'));
			}
			const comparison = {type:'gitTextDiff',path:'src/components/Workspace.tsx',original:'export function Workspace() {\n  return <main>Project</main>;\n}',modified:'export function Workspace() {\n  return <main className="workspace">Project details</main>;\n}'};
			await page.eval('document.getElementById("aux-tab-files").click();document.querySelector("#aux-content-files [data-aux-diff]").click();window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify(comparison) + '}))');
			await page.screenshot(path.join(shots, 'changes-file-comparison.png'));
			await page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify({ ...welcomeFixture, settings:{...settings,theme:'github-light'} }) + '}));document.getElementById("auxiliary").style.setProperty("flex","0 0 300px","important");document.getElementById("auxiliary").style.width="300px"');
			await page.screenshot(path.join(shots, 'changes-light-narrow.png'));
		} finally {
			await page.eval(`window.Bridge.post=window.__repositoryPost;document.getElementById('auxiliary').style.cssText=window.__repositoryPanelStyle;window.Bridge.post({type:'getGitStatus'});window.Bridge.post({type:'getWorktrees'})`);
		}
		assert.deepEqual(await page.eval(`window.__polishErrors`), [], 'the fixture must finish without renderer errors');
	} finally {
		await page.send('Emulation.clearDeviceMetricsOverride');
		await page.send('Emulation.setEmulatedMedia', { features: [] });
		await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
		await page.eval(`document.querySelector('[data-image-action="close"]').click(); document.getElementById('input').value = '';`);
	}
};
