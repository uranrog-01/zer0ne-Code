'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
module.exports = async function workbenchSmoke(page, until, shots) {
 await until('workbench UI',()=>page.eval('!!document.querySelector(".workbench")'));
 await page.eval(`window.__workbenchEvents=[];window.addEventListener('message',e=>{if(['ptySessions','ptyOutput','projectActions'].includes(e.data?.type))window.__workbenchEvents.push(e.data)});document.getElementById('btn-auxiliary').click();document.getElementById('aux-tab-terminal').click();document.getElementById('workbench-tab-commands').click();0`);
 await page.screenshot(path.join(shots,'workbench-commands-real.png'));
 await page.eval(`document.getElementById('workbench-tab-shells').click();0`);
 await page.eval(`[...document.querySelectorAll('.workbench button')].find(b=>b.textContent==='New terminal').click();0`);
 await until('interactive session',()=>page.eval(`window.__workbenchEvents.some(m=>m.type==='ptySessions'&&m.sessions.some(s=>!s.closed))`));
 await until('terminal renderer',()=>page.eval(`!!document.querySelector('.workbench .xterm-helper-textarea')`));
 try {
  await page.eval(`document.querySelector('.workbench .xterm-helper-textarea').focus();0`);
  await page.send('Input.insertText',{text:'echo UI_RESULT_%COMSPEC%'});
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until('keyboard input reached shell',()=>page.eval(`window.__workbenchEvents.filter(m=>m.type==='ptyOutput').map(m=>m.text).join('').includes('UI_RESULT_C:')`));
  assert(await page.eval(`!document.getElementById('command-state')`),'a normal command must not produce an uncertain-delivery banner');
  const dimensions=await page.eval(`(()=>{const p=document.querySelector('.workbench-terminal').getBoundingClientRect();return {width:p.width,height:p.height};})()`);
  assert(dimensions.width>100&&dimensions.height>100,JSON.stringify(dimensions));
  assert(await page.eval(`(()=>{const p=document.getElementById('auxiliary-content');return p.scrollWidth<=p.clientWidth+1 && p.scrollHeight<=p.clientHeight+1;})()`),'terminal views own their scrolling without overflowing the panel');
  await page.screenshot(path.join(shots,'workbench-terminal-real.png'));
  const originalTheme=await page.eval(`document.body.dataset.theme||'zcode'`);
  try {
   await page.eval(`window.Bridge.post({type:'updateSettings',patch:{theme:'paper'}});0`);
   await until('terminal follows light theme',()=>page.eval(`document.body.dataset.theme==='paper' && getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor===getComputedStyle(document.querySelector('.workbench-terminal')).backgroundColor`));
   await page.screenshot(path.join(shots,'workbench-terminal-light.png'));
  } finally {
   await page.eval(`window.Bridge.post({type:'updateSettings',patch:{theme:${JSON.stringify(originalTheme)}}});0`);
   await until('original terminal theme restored',()=>page.eval(`document.body.dataset.theme===${JSON.stringify(originalTheme)}`));
  }
 } finally {
  await page.eval(`document.querySelector('.workbench [aria-label="Close terminal"]').click();0`);
  await until('terminal closed',()=>page.eval(`window.__workbenchEvents.filter(m=>m.type==='ptySessions').at(-1)?.sessions.length===0`));
 }
 await page.eval(`(()=>{document.getElementById('workbench-tab-actions').click();const d=document.getElementById('workbench-view-actions');d.querySelector('details').open=true;const e=d.querySelector('textarea');e.value=JSON.stringify([{name:'Smoke check',command:'echo ACTION_UI_OK'}]);e.dispatchEvent(new Event('input'));[...d.querySelectorAll('button')].find(b=>b.textContent==='Save actions').click();})()`);
 await until('review project actions',()=>page.eval(`!!document.querySelector('.zc-dialog[open]')`));
 await page.eval(`document.querySelector('.zc-dialog[open] input[type=radio]').click();document.querySelector('.zc-dialog[open] button[type=submit]').click();0`);
 await until('saved action',()=>page.eval(`document.querySelector('.workbench-action-list')?.textContent.includes('Smoke check')`));
 await page.eval(`[...document.querySelectorAll('.workbench-action-list button')].find(b=>b.textContent==='Run').click();0`);
 await until('confirm action execution',()=>page.eval(`!!document.querySelector('.zc-dialog[open]')`));
 await page.eval(`document.querySelector('.zc-dialog[open] input[type=radio]').click();document.querySelector('.zc-dialog[open] button[type=submit]').click();0`);
 await until('action output',()=>page.eval(`document.querySelector('.workbench-action-output')?.textContent.includes('ACTION_UI_OK')`));
 await until('action complete',()=>page.eval(`window.__workbenchEvents.filter(m=>m.type==='projectActions').at(-1)?.last.status==='completed'`));
 await page.screenshot(path.join(shots,'workbench-actions-real.png'));
 await page.eval(`document.getElementById('workbench-tab-commands').click();0`);
 await page.eval(`document.getElementById('btn-auxiliary-close').click();0`);
};
