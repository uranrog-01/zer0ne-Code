'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');
const root = path.resolve(__dirname,'..');
const source = fs.readFileSync(path.join(root,'app/desktop-glass.js'),'utf8');

function page(prefs, support={transparent:true,blur:true,colors:false,hideIcons:false}) {
 const dom = new JSDOM('<body class="desktop"><div id="app"><div class="topbar-right"></div><div id="messages"></div><textarea id="input"></textarea></div></body>',{url:'http://127.0.0.1:32123',runScripts:'outside-only',pretendToBeVisual:true});
 const w = dom.window; const calls=[];
 w.document.adoptedStyleSheets=[];
 w.CSSStyleSheet=class {replaceSync(){}};
 w.matchMedia=()=>({matches:true});
 w.__zgSupport=support;w.__zgPrefs=prefs;
 w.__zcShell={invoke:async(command,args)=>{calls.push({command,args});return true;}};
 const matches = w.Element.prototype.matches;
 w.Element.prototype.matches=function(selector){return selector===':popover-open'?!!this.open:matches.call(this,selector);};
 w.HTMLElement.prototype.showPopover=function(){this.open=true;const event=new w.Event('toggle');event.newState='open';this.dispatchEvent(event);};
 w.HTMLElement.prototype.hidePopover=function(){this.open=false;const event=new w.Event('toggle');event.newState='closed';this.dispatchEvent(event);};
 w.eval(source);w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
 return {dom,w,calls,close:()=>dom.window.close()};
}
async function main() {
 const first=page(null);
 try {
  const doc=first.w.document;
  assert(doc.querySelector('.zg-trigger'),'Glass controls return to the top bar');
  assert.equal(doc.querySelector('.zg-t').value,'0','New profiles keep the quiet solid default');
  doc.querySelector('.zg-trigger').click();assert(doc.getElementById('zg-options').open);
  doc.querySelector('[data-t="50"]').click();
  assert(doc.body.classList.contains('zg-see'));assert.equal(doc.body.style.getPropertyValue('--zg-o'),'0.500');
  assert.equal(doc.querySelector('.zg-trigger .zg-hint-val').textContent,'50%');
  assert(doc.querySelector('.zg-trigger').title.includes('50%'));
  const blur=doc.querySelector('.zg-blur-cb');blur.checked=true;blur.dispatchEvent(new first.w.Event('change'));
  assert(first.calls.some(c=>c.command==='glass_blur'&&c.args.on===true));
  doc.getElementById('input').dispatchEvent(new first.w.KeyboardEvent('keydown',{key:'a',bubbles:true}));
  assert(doc.body.classList.contains('zg-reading'));
  await new Promise(r=>setTimeout(r,250));
  const saved=first.calls.findLast(c=>c.command==='glass_prefs').args.prefs;
  assert.equal(saved.transparency,50);assert.equal(saved.blur,true);
  const second=page(saved);
  try {
   assert.equal(second.w.document.querySelector('.zg-t').value,'50','Saved Glass preferences survive a new project webview');
   second.w.__zgSync({...saved,transparency:75,at:saved.at+1});
   assert.equal(second.w.document.body.style.getPropertyValue('--zg-o'),'0.250','Another project can synchronize Glass settings');
  } finally {second.close();}
  first.w.__zgSync({...saved,transparency:0,at:saved.at+2});
  assert(!doc.body.classList.contains('zg-see'));assert(!doc.body.classList.contains('zg-reading'));
  assert(first.calls.some(c=>c.command==='glass_blur'&&c.args.on===false));
  first.w.__zgSync({...saved,transparency:100,blur:false,at:saved.at+3});
  assert(doc.body.classList.contains('zg-full'));
  assert.equal(first.calls.findLast(c=>c.command==='glass_blur').args.on,false,'Full transparency must not turn on whole-window blur');
  assert(!doc.querySelector('.zg-blur-cb').checked && !doc.querySelector('.zg-blur-cb').disabled);
  first.w.__zgSync({...saved,transparency:75,blur:false,at:saved.at+4});
  assert(!doc.body.classList.contains('zg-full')); assert(!doc.querySelector('.zg-blur-cb').disabled);
  assert.equal(first.calls.findLast(c=>c.command==='glass_blur').args.on,false,'Leaving full mode restores the saved blur preference');
 } finally {first.close();}
 const unsupported=page({transparency:80,blur:true,matchColors:false},{transparent:false,blur:false,colors:false,hideIcons:false});
 try {
  assert(!unsupported.w.document.body.classList.contains('zg-see'));
  assert(unsupported.w.document.querySelector('.zg-opt-blur').hidden);
 } finally {unsupported.close();}
 const failed=page(null);const notices=[];failed.w.UI={toast:message=>notices.push(message)};failed.w.__zcShell.invoke=async()=>false;
 try {
  failed.w.document.querySelector('[data-t="50"]').click();await new Promise(resolve=>setTimeout(resolve,250));assert.match(notices[0],/could not be saved/,'A failed native save is reported');
 } finally {failed.close();}
 const {allowed}=require('../app/permissions');
 for(const name of ['glass_prefs','glass_blur','glass_panels','desktop_wallpaper'])assert(allowed('engine',name)&&!allowed('start',name));
 const windows=page(null,{transparent:true,blur:true,colors:false,hideIcons:true});
 try { assert(windows.w.document.getElementById('zg-options').textContent.includes('Windows desktop icons hide while Glass is transparent')); } finally {windows.close();}
 const shellMain=fs.readFileSync(path.join(root,'app/main.js'),'utf8');
 assert(fs.existsSync(path.join(root,'app/desktop-icons.js')));
 assert(shellMain.slice(shellMain.indexOf('glassPrefs(sender, prefs) {')).includes('this.syncIcons()'),'saved transparency updates desktop icons');
 const {hideRequested, hideTaskbarRequested}=require('../app/desktop-icons');
 assert(hideRequested(true,false,true,50)&&!hideRequested(true,false,true,0)&&!hideRequested(false,false,true,50)&&!hideRequested(true,true,true,50)&&!hideRequested(true,false,false,50),'icons hide only for a visible, transparent project page');
 assert(hideTaskbarRequested(true,false,true,50,true)&&!hideTaskbarRequested(true,false,true,50,false)&&!hideTaskbarRequested(true,false,true,0,true)&&!hideTaskbarRequested(false,false,true,50,true)&&!hideTaskbarRequested(true,true,true,50,true),'taskbar hides only for a visible, transparent, fullscreen project page');
 console.log('Liquid Glass passed: controls, quiet default, transparency, blur, reading opacity, saved and synchronized preferences, compositor fallback and native permissions.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
