'use strict';
const assert = require('node:assert/strict');

module.exports = async function chatScrollSmoke(page, until) {
	await page.eval(`window.__scrollBaseline=null; window.__scrollStateListener=e=>{if(e.data?.type==='state'&&!window.__scrollBaseline)window.__scrollBaseline=e.data;}; window.addEventListener('message',window.__scrollStateListener); window.Bridge.post({type:'setMode',mode:'agent'});`);
	await until('chat scrolling baseline ready', () => page.eval('!!window.__scrollBaseline'));
	const fixture = {
		type: 'state', currentSessionId: 'scroll-fixture', sessions: [{ id: 'scroll-fixture', title: 'Scroll test' }],
		settings: { theme: 'claude-code', groupTerminal: false, groupChanges: false },
		messages: Array.from({ length: 20 }, (_, index) => [
			{ id: 'scroll-u-' + index, role: 'user', content: 'Question ' + index },
			{ id: 'scroll-a-' + index, role: 'assistant', content: 'Answer ' + index + '\n\n' + 'A paragraph of conversation history. '.repeat(20) }
		]).flat(), isStreaming: false, queue: [], providers: [], selection: {}
	};
	const bottom = () => page.eval(`(() => { const m=document.getElementById('messages'); return m.scrollHeight-m.scrollTop-m.clientHeight<2 && document.getElementById('btn-scroll-bottom').classList.contains('hidden'); })()`);
	const frames = () => page.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
	const emit = data => page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify(data) + '}))');
	await page.eval(`window.__scrollPost=window.Bridge.post; window.__scrollSends=[]; window.Bridge.post=m=>{if(m.type==='send')window.__scrollSends.push(m);}; window.__scrollErrors=[]; window.__scrollErrorListener=e=>window.__scrollErrors.push(e.message); window.addEventListener('error',window.__scrollErrorListener);`);
	try {
		await emit(fixture);
		await until('opened chat follows its latest answer', bottom);
		await page.eval(`(() => { const m=document.getElementById('messages'); m.dispatchEvent(new WheelEvent('wheel',{deltaY:-120})); m.scrollTop=200; })()`);
		await frames();
		assert.equal(await bottom(), false, 'the history fixture must be scrolled away from the latest answer');
		await page.eval(`document.getElementById('input').value='hi'; document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}))`);
		await frames();
		await page.eval(`document.getElementById('btn-send').click()`);
		assert.equal(await page.eval('window.__scrollSends.at(-1)?.text'), 'hi');
		await until('sending hi returns to latest immediately', bottom, 3000);
		const messages = [...fixture.messages, { id: 'scroll-hi', role: 'user', content: 'hi' }];
		await emit({ ...fixture, messages, isStreaming: true, streaming: { text: '', reasoning: '' } });
		await emit({ type: 'streamStart' });
		for (let index = 0; index < 6; index++) {
			await emit({ type: 'delta', text: 'Reply paragraph ' + index + '. ' + 'The latest answer stays visible as it arrives. '.repeat(12) + '\n\n' });
			await until('streamed paragraph ' + index + ' appears', () => page.eval(`document.querySelector('.msg.streaming .md')?.textContent.includes('Reply paragraph ${index}')`));
			await until('streamed paragraph ' + index + ' follows the bottom', bottom, 3000);
		}
		await page.eval(`(() => { const m=document.getElementById('messages'); m.scrollTop-=100; m.dispatchEvent(new Event('scroll')); })()`);
		await emit({ type: 'delta', text: 'The next chunk must recover from a layout scroll.\n\n' });
		await until('layout scroll does not disable following', bottom, 3000);
		const scrollbar = await page.eval(`(() => { const r=document.getElementById('messages').getBoundingClientRect(); return {x:r.right-5,y:r.top+60}; })()`);
		await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...scrollbar });
		await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...scrollbar });
		await until('scrollbar allows reading earlier messages', () => page.eval(`!document.getElementById('btn-scroll-bottom').classList.contains('hidden')`), 3000);
		await emit({ type: 'delta', text: 'A paragraph after using the scrollbar.\n\n' });
		await frames();
		assert.equal(await bottom(), false, 'using the scrollbar pauses following');
		await page.eval(`document.getElementById('btn-scroll-bottom').click()`);
		await until('Jump to latest resumes following', bottom, 3000).catch(async error => {
			throw new Error(error.message + ': ' + JSON.stringify(await page.eval(`(() => {const m=document.getElementById('messages');return {top:m.scrollTop,height:m.scrollHeight,client:m.clientHeight,button:document.getElementById('btn-scroll-bottom').className};})()`)));
		});
		await page.eval(`(() => { const m=document.getElementById('messages'); m.dispatchEvent(new WheelEvent('wheel',{deltaY:-120})); m.scrollTop=200; })()`);
		await frames();
		await emit({ type: 'delta', text: 'A new paragraph while the reader checks history.\n\n' });
		await frames();
		assert.equal(await bottom(), false, 'deliberate upward scrolling allows reading history while streaming');
		await emit({ ...fixture, messages: [...messages, { id: 'scroll-answer', role: 'assistant', content: 'Hi! Here is the completed answer.\n\n' + 'Final paragraph. '.repeat(100) }], isStreaming: false });
		await until('the completed answer returns to latest', bottom, 3000);
		await page.eval(`document.getElementById('input').value='A multiline draft\\n'.repeat(8); document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true}))`);
		await frames();
		await until('composer resizing keeps the answer visible', bottom, 3000);
		assert.deepEqual(await page.eval('window.__scrollErrors'), []);
		console.log('Chat scrolling passed: send from history, live chunks, layout scrolls, deliberate scrollback, completion and composer resizing.');
	} finally {
		await page.eval(`window.dispatchEvent(new MessageEvent('message',{data:window.__scrollBaseline})); window.Bridge.post=window.__scrollPost; window.removeEventListener('error',window.__scrollErrorListener); window.removeEventListener('message',window.__scrollStateListener); document.getElementById('input').value=''; document.getElementById('input').dispatchEvent(new Event('input',{bubbles:true})); delete window.__scrollPost; delete window.__scrollSends; delete window.__scrollErrors; delete window.__scrollErrorListener; delete window.__scrollStateListener; delete window.__scrollBaseline;`);
	}
};
