'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
module.exports = async function streamingMessageSmoke(page, shots, until) {
 await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
 const first = 'Use a trailing debounce for writes. Keep reads immediate.';
 const initial = first + '\n\n### Save changes\n\n```ts\n' + Array.from({ length: 30 }, (_, i) => 'const value' + i + ' = ' + i + ';').join('\n');
 const fixture = { type: 'state', currentSessionId: 'stream-style-fixture', mode: 'full', isStreaming: true, streaming: { text: initial, reasoning: '' }, settings: { theme: 'claude-code', accent: 'clay', glass: false }, messages: [{ id: 'stream-user', role: 'user', content: 'Explain how to save editor changes, with a small example.' }], providers: [{ id: 'fixture', name: 'Fixture', enabled: true, efforts: {}, models: [{ id: 'fixture', enabled: true }] }], selection: { providerId: 'fixture', model: 'fixture' } };
 const delta = text => page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify({ type: 'delta', text }) + '}))');
 try {
  await page.eval(`window.__streamStyleErrors=[];window.addEventListener('error',e=>window.__streamStyleErrors.push(e.error?.stack||e.message));window.__streamClipboard=navigator.clipboard.writeText;navigator.clipboard.writeText=async text=>{window.__streamCopied=text;}`);
  await page.eval(`if(!document.getElementById('sidebar').classList.contains('hidden'))document.getElementById('btn-sidebar').click();if(!document.getElementById('auxiliary').classList.contains('hidden'))document.getElementById('btn-auxiliary').click();`);
  await page.eval('window.dispatchEvent(new MessageEvent("message",{data:' + JSON.stringify(fixture) + '}))');
  await until('styled streaming response', () => page.eval(`!!document.querySelector('.msg.streaming .code-block[data-open="1"]') && !!document.querySelector('.msg.streaming .ans-caret')`));
  const start = await page.eval(`(() => {const md=document.querySelector('.msg.streaming .md'),p=md.querySelector('p'),code=md.querySelector('.code-block');window.__streamFirst=p;window.__streamCode=code;window.__streamCopy=code.querySelector('[data-copy-code]');const range=document.createRange();range.setStart(p.firstChild,6);range.setEnd(p.firstChild,14);getSelection().removeAllRanges();getSelection().addRange(range);code.querySelector('[data-wrap-code]').click();window.__streamCopy.click();const caret=md.querySelector('.ans-caret'),style=getComputedStyle(caret);return {caretWidth:style.width,caretHeight:style.height,busy:md.getAttribute('aria-busy')};})()`);
  assert.deepEqual(start, { caretWidth: '7px', caretHeight: '15px', busy: 'true' });
  await until('code copied', () => page.eval(`window.__streamCopy.textContent.includes('Copied')`));
  await delta('\nconst saved = true;');
  await until('code delta', () => page.eval(`document.querySelector('.msg.streaming code').textContent.includes('saved = true')`));
  assert(await page.eval(`document.querySelector('.msg.streaming p')===window.__streamFirst && document.querySelector('.msg.streaming .code-block')===window.__streamCode && window.__streamCode.classList.contains('wrap') && window.__streamCode.querySelector('[data-copy-code]')===window.__streamCopy && window.__streamCopy.textContent.includes('Copied') && getSelection().toString()==='trailing'`), 'stream chunks preserve selection and active code controls');
  assert(await page.eval(`!window.__streamCopied.includes('· writing') && window.__streamCopied.includes('const value29')`), 'copy contains code rather than its header or caret');
  await delta('\n```\n\n> Flush pending writes before closing.\n\n| Action | Timing |\n| --- | --- |\n| Read | Immediate |\n| Write | Debounced |');
  await until('table streaming caret', () => page.eval(`!!document.querySelector('.msg.streaming tbody tr:last-child td:last-child .ans-caret')`));
  await delta('\n\nFinish with **a bounded');
  await until('partial emphasis', () => page.eval(`document.querySelector('.msg.streaming .md strong')?.textContent==='a bounded'`));
  assert(await page.eval(`!window.__streamCode.hasAttribute('data-open') && !!document.querySelector('.msg.streaming table') && !!document.querySelector('.msg.streaming blockquote')`));
  await page.screenshot(path.join(shots, 'streaming-message-dark.png'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 720, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await page.eval(`window.applyAppearance({theme:'claude-light',accent:'clay',glass:false})`);
  await delta(' queue**.\n\nA quiet final paragraph.');
  await until('reduced motion final block', () => page.eval(`document.querySelector('.msg.streaming .md').textContent.includes('quiet final paragraph')`));
  assert(await page.eval(`(() => {const md=document.querySelector('.msg.streaming .md'),caret=md.querySelector('.ans-caret'),r=md.getBoundingClientRect();return getComputedStyle(caret).animationName==='none' && r.left>=0 && r.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth;})()`), 'the response fits a narrow viewport and honors reduced motion');
  await page.screenshot(path.join(shots, 'streaming-message-light-narrow.png'));
  assert.deepEqual(await page.eval('window.__streamStyleErrors'), []);
 } finally {
  await page.eval(`navigator.clipboard.writeText=window.__streamClipboard;getSelection().removeAllRanges()`);
  await page.send('Emulation.clearDeviceMetricsOverride');
  await page.send('Emulation.setEmulatedMedia', { features: [] });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: false });
 }
};
