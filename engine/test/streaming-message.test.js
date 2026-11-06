'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM } = require('jsdom');
function fixture(t) {
 const dom = new JSDOM('<div class="session-text"></div>', { runScripts: 'outside-only' });
 t.after(() => dom.window.close());
 dom.window.eval(fs.readFileSync(path.join(__dirname, '../media/markdown.js'), 'utf8'));
 return { window: dom.window, root: dom.window.document.querySelector('div'), md: dom.window.Markdown };
}
test('streaming holds incomplete markers and safely renders partial emphasis, code and links', t => {
 const { root, md } = fixture(t);
 for (const [text, selector, visible] of [['**Hello', 'strong', 'Hello'], ['_Hello', 'em', 'Hello'], ['`value', 'code', 'value']]) {
  md.paint(root, text, { streaming: true }); assert.equal(root.querySelector(selector).textContent, visible);
 }
 md.paint(root, 'Complete paragraph\n\n##', { streaming: true }); assert.equal(root.textContent, 'Complete paragraph');
 md.paint(root, 'Read [the guide](https://exam', { streaming: true }); assert.equal(root.textContent, 'Read the guide'); assert.equal(root.querySelector('a'), null);
 md.paint(root, '[bad](javascript:alert(1)) <img src=x onerror=alert(1)>', { streaming: true }); assert.equal(root.querySelector('img,script,[onclick],a[data-href^="javascript"]'), null);
 md.paint(root, '**unfinished', { streaming: false }); assert.equal(root.textContent, '**unfinished', 'saved text retains its exact formatting semantics');
});
test('completed blocks retain DOM and text selection while new blocks enter once', t => {
 const { root, md, window } = fixture(t);
 md.paint(root, 'A stable first paragraph.\n\nNext', { streaming: true });
 const first = root.firstElementChild, tail = root.lastElementChild, firstText = first.firstChild;
 const selection = window.getSelection(), range = window.document.createRange(); range.setStart(firstText, 2); range.setEnd(firstText, 8); selection.addRange(range);
 md.paint(root, 'A stable first paragraph.\n\nNext paragraph grows.', { streaming: true });
 assert.equal(root.firstElementChild, first); assert.equal(first.firstChild, firstText); assert.equal(root.lastElementChild, tail); assert.equal(selection.toString(), 'stable');
 const changes = new window.MutationObserver(() => {}); changes.observe(tail, { attributes: true, attributeFilter: ['class'] });
 md.paint(root, 'A stable first paragraph.\n\nNext paragraph grows again.', { streaming: true });
 assert.equal(changes.takeRecords().length, 0, 'a new chunk cannot restart the block entrance animation'); changes.disconnect();
 md.paint(root, 'A stable first paragraph.\n\nNext paragraph grows again.\n\n### New section', { streaming: true });
 assert(root.lastElementChild.classList.contains('stream-enter'));
 md.paint(root, 'Saved reply', { streaming: false }); assert.equal(root.getAttribute('aria-busy'), 'false');
});
test('an open fenced block preserves its controls, copy feedback and scroll as code arrives', t => {
 const { root, md } = fixture(t);
 md.paint(root, '```ts\nconst a = 1;', { streaming: true });
 const block = root.querySelector('.code-block'), code = block.querySelector('code'), copy = block.querySelector('[data-copy-code]'), wrap = block.querySelector('[data-wrap-code]');
 block.classList.add('wrap'); wrap.classList.add('active'); wrap.setAttribute('aria-pressed', 'true'); copy.textContent = 'Copied'; copy.classList.add('copied'); block.querySelector('pre').scrollLeft = 37;
 md.paint(root, '```ts\nconst a = 1;\nconst b = 2;', { streaming: true });
 assert.equal(root.querySelector('.code-block'), block); assert.equal(block.querySelector('code'), code); assert.equal(block.querySelector('[data-copy-code]'), copy); assert.equal(copy.textContent, 'Copied'); assert(block.classList.contains('wrap')); assert.equal(wrap.getAttribute('aria-pressed'), 'true'); assert.equal(block.querySelector('pre').scrollLeft, 37);
 md.paint(root, '```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.', { streaming: true });
 assert.equal(block.hasAttribute('data-open'), false); assert.equal(block.querySelector('.code-writing'), null); assert.equal(root.lastElementChild.textContent, 'Done.');
});
test('reduced motion keeps streaming content visible without an entrance effect', t => {
 const { root, md } = fixture(t); md.paint(root, '# Heading\n\nVisible reply', { streaming: true, animate: false });
 assert.equal(root.querySelector('.stream-enter'), null); assert.equal(root.children.length, 2);
});
