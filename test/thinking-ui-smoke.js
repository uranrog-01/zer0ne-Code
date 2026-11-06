'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function thinkingUiSmoke(page, shots, until) {
	await page.eval(`window.__thinkingDispatch=window.dispatchEvent;window.__thinkingOriginal=window.__zcSmokeState||null;window.dispatchEvent=function(event){if(event.type==='message'&&event.data?.type==='state'&&!event.data.__thinkingFixture){window.__thinkingOriginal=event.data;return true;}return window.__thinkingDispatch.call(this,event);};window.Bridge.post({type:'setMode',mode:window.__thinkingOriginal?.mode||'agent'});0`);
	await until('thinking fixture baseline', () => page.eval(`!!window.__thinkingOriginal?.currentSessionId`));
	const shot = async (name) => { await page.screenshot(path.join(shots, name)); };
	const visible = (selector) => page.eval(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).filter(node=>node.getBoundingClientRect().width>0&&node.getBoundingClientRect().height>0&&node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).length`);
	const send = (data) => page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify(data) + '}))');
	const click = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	try {
		for (const theme of ['claude-code', 'claude-light', 'terminal']) {
			const id = 'thinking-' + theme;
			const reasoning = '**Reviewing the session**\r\n\r\nChecking the latest changes.\r\n\r\n**Comparing results**\r\nRead the tests.';
			await send({
				type: 'state', __thinkingFixture: true, currentSessionId: id,
				settings: { theme, showReasoning: true, glass: false }, providers: [], isStreaming: false,
				messages: [
					{ id: id + '-user', role: 'user', content: 'Review this session.', turn: { startedAt: 1, endedAt: 2001 } },
					{ id: id + '-answer', role: 'assistant', content: 'Review complete.', reasoning, reasoningMs: 2000 }
				]
			});
			await until('one reasoning block in ' + id, () => page.eval(`document.querySelectorAll('#messages .thinking').length===1`));
			const box = '#messages .thinking';
			assert.equal(await page.eval(`document.querySelector('${box}').classList.contains('open')`), false, id + ': the reasoning stays folded');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-head').getAttribute('aria-expanded')`), 'false', id + ': the header reports folded');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-body').inert`), true, id + ': the folded body is inert');
			assert.equal(await visible(`${box} .tk-item`), 0, id + ': steps stay out of sight until clicked');
			assert.equal(await page.eval(`document.querySelectorAll('${box} .tk-item').length`), 2, id + ': both steps are in the DOM');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-clock').textContent`), '2s', id + ': the header keeps how long it thought');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-title').textContent`), 'Thought for', id + ': the header names the finished thought');
			assert.ok(await page.eval(`document.querySelector('${box} .tk-text').textContent.includes('Checking the latest changes.')`), id + ': the reasoning text sits under the outline');
			assert.equal(await page.eval(`getComputedStyle(document.querySelector('${box} .tk-text')).maxHeight`), 'none', id + ': a finished thought shows all of its text');
			if (theme === 'claude-code') await shot('thinking-folded.png');
			await click(`${box} .tk-head`);
			await sleep(360);
			assert.equal(await page.eval(`document.querySelector('${box}').classList.contains('open')`), true, id + ': a click opens the trace');
			await until(id + ': steps show', () => visible(`${box} .tk-item`).then((count) => count === 2), 3000);
			if (theme === 'claude-code') await shot('thinking-expanded.png');
			assert.equal(await visible(`${box} .tk-item`), 2, id + ': both steps show');
			assert.equal(await page.eval(`document.querySelectorAll('${box} .tk-item[data-status="done"]').length`), 2, id + ': every step is done');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-item .tk-label').textContent`), 'Reviewing the session', id + ': the outline names the first step');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-head').getAttribute('aria-expanded')`), 'true');
			await click(`${box} .tk-head`);
			await sleep(320);
			assert.equal(await page.eval(`document.querySelector('${box}').classList.contains('open')`), false, id + ': a second click folds it again');
			assert.equal(await page.eval(`document.querySelector('${box} .tk-body').inert`), true);
		}

		const lifecycle = {
			type: 'state', __thinkingFixture: true, currentSessionId: 'thinking-live',
			settings: { theme: 'claude-code', showReasoning: true, glass: false }, providers: [], isStreaming: true, streaming: null,
			messages: [{ id: 'thinking-live-user', role: 'user', content: 'Review these changes.', turn: { startedAt: Date.now() } }]
		};
		await send(lifecycle);
		await send({ type: 'streamStart' });
		await until('live placeholder', () => page.eval(`!!document.querySelector('#messages .thinking.live[data-placeholder="1"]')`));
		assert.equal(await page.eval(`document.querySelector('#messages .thinking.live .tk-title').textContent`), 'Thinking', 'the waiting receipt uses the same Thinking header');
		assert.equal(await page.eval(`getComputedStyle(document.querySelector('#messages .thinking.live .tk-body')).display`), 'none', 'the waiting receipt has no empty body');
		assert.equal(await page.eval(`!!document.querySelector('#messages .thinking.live .tk-chev') && getComputedStyle(document.querySelector('#messages .thinking.live .tk-chev')).display === 'none'`), true, 'the waiting receipt has no chevron');
		await until('status line stays hidden', () => page.eval(`(() => { const s=document.querySelector('#messages .status-line'); return s ? s.hidden : false; })()`));
		await shot('thinking-live-placeholder.png');
		await send({ type: 'delta', reasoning: '**Reading files**\r\n\r\nReading the source.' });
		const live = '#messages .thinking.live';
		await until('live reasoning replaces placeholder', () => page.eval(`(() => { const d=document.querySelector('${live}'); return !!d && !d.dataset.placeholder && d.querySelectorAll('.tk-item').length === 1; })()`));
		await until('live trace', () => page.eval(`!!document.querySelector('${live}')`));
		assert.equal(await page.eval(`document.querySelector('${live}').classList.contains('open')`), false, 'a live trace starts folded');
		assert.equal(await page.eval(`document.querySelector('${live}').classList.contains('busy')`), true, 'a live trace carries the busy state');
		const liveMeta = await until('live receipt', () => page.eval(`document.querySelector('${live} .tk-clock').textContent`).then((text) => (/^\d+s$/.test(text) ? text : false)));
		assert.match(liveMeta, /^\d+s$/, 'the live receipt counts seconds: ' + liveMeta);
		assert.equal(await page.eval(`document.querySelectorAll('${live} .tk-item').length`), 1, 'the outline holds the current step');
		assert.ok(await page.eval(`document.querySelector('${live} .tk-text').textContent.includes('Reading the source.')`), 'the live reasoning text is carried in the trace');
		assert.equal(await page.eval(`document.querySelector('${live} .tk-count').textContent`), '1 step', 'the header counts the live step');
		await click(`${live} .tk-head`);
		await sleep(320);
		await until('live step shows', () => visible(`${live} .tk-item`).then((count) => count === 1), 3000);
		assert.equal(await visible(`${live} .tk-item`), 1, 'clicking a live trace shows the step');
		assert.equal(await page.eval(`document.querySelectorAll('${live} .tk-item[data-status="active"]').length`), 1, 'one step is active');
		assert.ok(await page.eval(`!!document.querySelector('${live} .tk-item[data-status="active"] .tk-glyph')`), 'the active step carries its status glyph');
		assert.ok(await page.eval(`!!document.querySelector('${live} .tk-item[data-status="active"] .tk-spin')`), 'the active glyph is the busy ring');
		assert.equal(await page.eval(`getComputedStyle(document.querySelector('${live} .tk-text')).maxHeight`), '128px', 'a live trace caps its text');
		assert.equal(await page.eval(`document.querySelector('${live} .tk-title').textContent`), 'Thinking', 'the live header says Thinking');
		await shot('thinking-live.png');
		const first = await page.eval(`document.querySelector('${live} .tk-duration').textContent`);
		await until('live step clock', () => page.eval(`document.querySelector('${live} .tk-duration').textContent !== ${JSON.stringify(first)}`), 5000);
		await send({ type: 'delta', reasoning: '\r\n\r\n**Checking the tests**\r\nCompare the expected behavior.' });
		await until('second live step', () => page.eval(`document.querySelectorAll('${live} .tk-item').length===2 && document.querySelector('${live} .tk-item[data-status="active"] .tk-label')?.textContent==='Checking the tests'`));
		assert.equal(await page.eval(`document.querySelector('${live} .tk-count').textContent`), '2 steps', 'the header counts the live steps');
		assert.equal(await page.eval(`document.querySelector('${live} .tk-kind').textContent`), 'think');
		assert.notEqual(await page.eval(`getComputedStyle(document.querySelector('${live} .tk-kind')).display`), 'none', 'the kind label appears at a wide container');
		assert.ok(await page.eval(`!!document.querySelector('${live} .tk-item[data-status="active"] .tk-spin')`), 'the active step uses the busy ring');
		assert.ok(await page.eval(`!!document.querySelector('${live} .tk-item:nth-child(1) .tk-rail-down.fill')`), 'the finished step fills the rail below it');
		assert.ok(await page.eval(`!!document.querySelector('${live} .tk-item:nth-child(2) .tk-rail-up.fill')`), 'the next step receives the filled rail above it');
		await send({ type: 'delta', text: 'Review complete.' });
		await until('status line follows the trace', () => page.eval(`(() => { const s=document.querySelector('#messages .status-line'); return !!s && s.hidden; })()`));
		await shot('thinking-live-answer.png');
		await until('live trace done', () => page.eval(`document.querySelector('${live}').classList.contains('done')`));
		await sleep(1100);
		assert.equal(await page.eval(`document.querySelector('${live}').classList.contains('open')`), false, 'a finished trace folds itself');
		assert.equal(await page.eval(`document.querySelectorAll('${live} .tk-item[data-status="active"]').length`), 0, 'no step stays active');

		const saved = {
			...lifecycle, isStreaming: false, streaming: null,
			messages: [
				{ ...lifecycle.messages[0], turn: { ...lifecycle.messages[0].turn, endedAt: Date.now() } },
				{ id: 'thinking-live-answer', role: 'assistant', content: 'Review complete.', reasoning: '**Reading files**\r\n\r\nReading the source.\r\n\r\n**Checking the tests**\r\nCompare the expected behavior. The redirect guard must read the cookie after it is written, not before the first navigation completes, and the checkout path must still restore the session.', reasoningMs: 2000 }
			]
		};
		await send(saved);
		await until('saved trace', () => page.eval(`document.querySelectorAll('#messages .thinking').length===1 && !document.querySelector('#messages .thinking').classList.contains('live')`));
		const savedBox = '#messages .thinking';
		assert.equal(await page.eval(`document.querySelector('${savedBox}').classList.contains('open')`), false, 'the saved trace stays folded');
		await click(`${savedBox} .tk-head`);
		await sleep(360);
		await until('saved steps show', () => visible(`${savedBox} .tk-item`).then((count) => count === 2), 3000);
		assert.equal(await visible(`${savedBox} .tk-item`), 2, 'the saved trace opens with both steps');
		assert.equal(await page.eval(`document.querySelector('${savedBox} .tk-title').textContent`), 'Thought for', 'the saved header names the thought');
		assert.equal(await page.eval(`document.querySelector('${savedBox} .tk-clock').textContent`), '2s', 'the saved header shows the final time');
		assert.equal(await page.eval(`document.querySelector('${savedBox} .tk-count').textContent`), '2 steps', 'the saved header shows the step count');
		assert.equal(await page.eval(`document.querySelector('${savedBox} .tk-kind').textContent`), 'think');
		assert.ok(await page.eval(`!!document.querySelector('${savedBox} .tk-glyph svg')`), 'finished steps show a status glyph');
		assert.ok(await page.eval(`!!document.querySelector('${savedBox} .tk-item:nth-child(1) .tk-rail-down.fill')`), 'the first finished step fills the rail below it');
		assert.ok(await page.eval(`!!document.querySelector('${savedBox} .tk-item:nth-child(2) .tk-rail-up.fill')`), 'the second step receives the filled rail above it');
		const detail = `${savedBox} .tk-item:nth-child(2) .tk-detail`;
		assert.equal(await page.eval(`document.querySelector('${detail}').dataset.expandable`), 'true', 'a long detail is a disclosure');
		await page.eval(`document.querySelector('${detail}').click()`);
		assert.equal(await page.eval(`document.querySelector('${detail}').dataset.open`), 'true', 'the detail expands');
		assert.equal(await page.eval(`getComputedStyle(document.querySelector('${detail}')).webkitLineClamp`), 'none');
		assert.equal(await page.eval(`getComputedStyle(document.querySelector('${savedBox} .tk-text')).maxHeight`), 'none', 'the saved trace shows all of its text');
		await shot('thinking-saved-open.png');
		await send(saved);
		await sleep(300);
		assert.equal(await page.eval(`document.querySelector('${savedBox}').classList.contains('open')`), true, 'a manually opened saved trace survives a refresh');

		const handoff = {
			...saved, isStreaming: true,
			messages: [
				saved.messages[0],
				{ id: 'thinking-live-saved-step', role: 'assistant', content: '', reasoning: '**Reading files**\r\n\r\nReading the source.', reasoningMs: 1000 },
				{ id: 'thinking-live-tool', role: 'assistant', kind: 'tool', content: '', tool: { name: 'read_file', arg: 'README.md', status: 'running', summary: '' } }
			]
		};
		await send(handoff);
		await until('reasoning handoff', () => page.eval(`document.querySelectorAll('#messages .thinking').length===1`));
		assert.equal(await visible('#messages .streaming .thinking'), 0, 'an explicit null clears the old live reasoning');
		assert.equal(await visible('#messages .thinking'), 1, 'a saved reasoning step is shown once');
		await page.screenshot(path.join(shots, 'thinking-state-completed.png'));
		console.log('Thinking UI passed: count and total, rail and status glyphs, kinds, step details, live clock, auto-fold and handoffs.');
	} finally {
		await page.eval(`window.dispatchEvent=window.__thinkingDispatch;if(window.__thinkingOriginal)window.dispatchEvent(new MessageEvent('message',{data:window.__thinkingOriginal}));delete window.__thinkingDispatch;delete window.__thinkingOriginal;`);
	}
};
