'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const ts = require('typescript-classic'), { JSDOM } = require('jsdom');
const source = require('./page-scripts').readPage('chat.js');
const markup = fs.readFileSync(path.join(__dirname, '../src/webviewMarkup.ts'), 'utf8').match(/CHAT_BODY = `([\s\S]*?)`;/)[1];
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = new Map();
function visit(node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(ast)); ts.forEachChild(node, visit); } visit(ast);
const dom = new JSDOM(markup, { runScripts: 'outside-only', pretendToBeVisual: true }), w = dom.window, d = w.document;
const resize = [], rendererErrors = [];
w.addEventListener('error', event => rendererErrors.push(event.error || event.message));
w.ResizeObserver = class { constructor(callback) { resize.push(callback); } observe() {} };
w.HTMLElement.prototype.scrollIntoView = function () {};
w.h = (tag, cls, html) => { const node = d.createElement(tag); node.className = cls || ''; if (html) node.innerHTML = html; return node; };
w.esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
w.I = name => '<svg aria-hidden="true" data-icon="' + name + '"></svg>';
w.t = key => key;
w.ui = { expanded: new Set(), composing: false, popup: null };
w.state = { settings: {}, messages: [], attachments: [] };
w.el = { input: d.getElementById('input'), popup: d.getElementById('mention-popup') };
w.ZcOrb = { html: kind => '<zc-orb kind="' + kind + '"></zc-orb>' };
w.basename = p => String(p || '').split(/[\\/]/).pop();
w.FILE_KINDS = [];
w.eval(['createImageViewer', 'approvalPhase', 'toolStatus', 'stepGlyph', 'fileBadge', 'renderApproval', 'approvalRow', 'diffLines', 'patchLines', 'bindMenuNavigation', 'renderPopup'].map(name => functions.get(name)).join('\n'));

try {
	w.eval(functions.get('buildTurns'));
	const summaryMessages = [
		{ id:'u', role:'user', content:'Review', turn:{ model:'fixture' } },
		{ id:'a', role:'assistant', content:'Reviewed.' },
		{ id:'c', role:'assistant', compacted:true, content:'Context compacted', reasoning:'Saved decisions.' },
		{ id:'next', role:'user', content:'Continue' }
	];
	const summaryTurns = w.buildTurns(summaryMessages);
	assert.equal(summaryTurns.length, 3);
	assert.equal(summaryTurns[0].items.at(-1).id, 'a', 'compaction cannot become a completed turn step');
	assert.equal(summaryTurns[1].user, null);
	assert.equal(summaryTurns[1].items[0].id, 'c', 'the summary is a visible conversation boundary');
	assert.equal(summaryTurns[2].user.id, 'next');
	console.log('ok compaction summaries stay outside collapsed completed turns');

	const root = d.getElementById('lightbox'), image = d.getElementById('lightbox-img'), viewport = root.querySelector('.lightbox-viewport');
	Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
	viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
	Object.defineProperties(image, { naturalWidth: { value: 1600 }, offsetWidth: { value: 400 }, offsetHeight: { value: 300 } });
	let captured = null;
	viewport.setPointerCapture = id => { captured = id; }; viewport.hasPointerCapture = id => captured === id; viewport.releasePointerCapture = () => { captured = null; };
	const trigger = d.createElement('button'); trigger.textContent = 'Preview'; d.getElementById('messages').appendChild(trigger); trigger.focus();
	const viewer = w.createImageViewer(root);
	const key = (target, key, extra = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
	const pointer = (name, x, y) => { const event = new w.MouseEvent(name, { clientX: x, clientY: y, button: 0, bubbles: true }); Object.defineProperty(event, 'pointerId', { value: 9 }); return viewport.dispatchEvent(event); };
	viewer.open('data:image/png;base64,fixture', 'A screenshot', trigger); image.dispatchEvent(new w.Event('load'));
	assert.equal(d.activeElement.dataset.imageAction, 'close'); assert.equal(d.querySelector('.coding-workspace').inert, true);
	viewport.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -70, clientX: 500, clientY: 300, cancelable: true }));
	assert(root.classList.contains('zoomed')); assert.match(image.style.transform, /translate\(-[\d.]+px/);
	key(d.activeElement, '0'); assert.equal(root.querySelector('output').textContent, '100%');
	key(d.activeElement, '+'); key(d.activeElement, '+'); key(d.activeElement, '+'); key(d.activeElement, '+'); key(d.activeElement, '+');
	const before = image.style.transform; pointer('pointerdown', 400, 300); pointer('pointermove', 402, 300); assert.equal(image.style.transform, before);
	pointer('pointermove', 450, 300); assert.notEqual(image.style.transform, before); pointer('pointercancel', 450, 300); assert.equal(captured, null); assert(!root.classList.contains('panning'));
	key(d.activeElement, 'Tab'); assert(root.contains(d.activeElement)); key(d.activeElement, 'Escape'); assert(root.classList.contains('hidden')); assert.equal(d.activeElement, trigger); assert.equal(d.querySelector('.coding-workspace').inert, undefined);
	viewer.open('data:image/png;base64,fixture', '', trigger); assert.equal(root.querySelector('output').textContent, '100%');
	image.dispatchEvent(new w.Event('error')); assert(!root.querySelector('.lightbox-error').classList.contains('hidden')); key(d.activeElement, 'Escape');
	console.log('ok image viewer anchors zoom, clamps pan, filters jitter, cancels capture, traps focus, resets and recovers from loading errors');

	for (const [a, expected] of [
		[{ status: 'pending' }, 'pending'], [{ status: 'applied', execution: 'running' }, 'running'],
		[{ status: 'applied', execution: 'done', result: '' }, 'success'], [{ status: 'applied', result: 'exit code 0' }, 'success'],
		[{ status: 'applied' }, 'unknown'], [{ status: 'applied', execution: 'error' }, 'error'], [{ status: 'rejected', execution: 'done' }, 'rejected']
	]) assert.equal(w.approvalPhase(a), expected);
	const message = { id: 'command', approval: { id: 'approval', kind: 'command', command: '<unsafe>', status: 'applied', execution: 'running' } };
	let row = w.approvalRow(message); assert.equal(row.getAttribute('aria-busy'), 'true'); assert.equal(row.querySelector('.tool-status').textContent, 'Running'); assert(!row.querySelector('.tool-sum.good')); assert(!row.querySelector('unsafe'));
	assert.equal(row.querySelector('zc-orb').getAttribute('kind'), 'spark', 'a running command shows its live orb'); assert.equal(row.querySelector('.tool-name').textContent, 'Running');
	message.approval.execution = 'error'; message.approval.failed = true; message.approval.result = 'Permission denied';
	row = w.approvalRow(message); assert.equal(row.querySelector('.tool-status').textContent, 'Failed'); assert(!row.querySelector('.tool-sum.good'));
	message.approval = { ...message.approval, kind: 'write', path: 'x.txt', execution: 'done', failed: false, result: '', content: 'hello' };
	row = w.approvalRow(message); assert.equal(row.querySelector('.tool-status').textContent, 'Completed'); assert(row.querySelector('.tool-sum.diff .plus'));
	assert.equal(row.querySelector('.tool-name').textContent, 'Wrote'); assert.equal(row.querySelector('.tool-file').textContent, 'x.txt'); assert(!row.querySelector('zc-orb'));
	console.log('ok approval rendering distinguishes permission from real execution, including empty output, errors and legacy records');

	const applied = []; let sent = 0;
	w.applyPopup = item => applied.push(item); w.autosize = () => {}; w.detectPopup = () => {}; w.queueComposerInput = () => {}; w.saveUi = () => {}; w.send = () => { sent++; };
	w.closePopup = () => { w.ui.popup = null; w.renderPopup(); };
	const begin = source.indexOf("\tel.input.addEventListener('compositionstart'"), end = source.indexOf("\n\tel.input.addEventListener('paste'", begin);
	assert(begin > 0 && end > begin); w.eval(source.slice(begin, end));
	const suggest = () => { w.ui.popup = { kind: 'file', index: 0, items: [{ label: 'a.ts', sub: 'src', icon: 'file' }, { label: 'b.ts', sub: 'src', icon: 'file' }] }; w.renderPopup(); };
	suggest(); w.el.input.focus(); key(w.el.input, 'Enter', { isComposing: true }); key(w.el.input, 'Enter', { keyCode: 229 }); assert.equal(applied.length, 0); assert.equal(sent, 0);
	w.el.input.dispatchEvent(new w.CompositionEvent('compositionstart')); assert.equal(w.el.input.getAttribute('aria-expanded'), 'false'); key(w.el.input, 'Enter'); assert.equal(sent, 0);
	w.el.input.dispatchEvent(new w.CompositionEvent('compositionend')); suggest(); key(w.el.input, 'End'); assert.equal(w.el.input.getAttribute('aria-activedescendant'), 'composer-option-1');
	assert.equal(w.el.popup.querySelectorAll('[aria-selected="true"]').length, 1); key(w.el.input, 'Enter'); assert.equal(applied[0].label, 'b.ts');
	suggest(); let escaped = 0; d.addEventListener('keydown', event => { if (event.key === 'Escape') escaped++; }); key(w.el.input, 'Escape'); assert.equal(escaped, 0); assert.equal(w.el.input.getAttribute('aria-expanded'), 'false');
	key(w.el.input, 'Enter', { shiftKey: true }); assert.equal(sent, 0); key(w.el.input, 'Enter'); assert.equal(sent, 1);
	console.log('ok composer preserves IME input and multiline entry, exposes active suggestions and consumes popup Escape');

	const menu = d.createElement('div'), opener = d.createElement('button'); menu.innerHTML = '<input><button>A</button><button disabled>B</button><div class="hidden"><button>C</button></div><button>D</button>';
	d.body.append(opener, menu); let closed = false; w.closeMenus = () => { closed = true; }; w.bindMenuNavigation(menu, opener);
	const input = menu.querySelector('input'), buttons = menu.querySelectorAll('button'); input.focus(); key(input, 'ArrowDown'); assert.equal(d.activeElement, buttons[0]); key(buttons[0], 'ArrowDown'); assert.equal(d.activeElement, buttons[3]); key(buttons[3], 'Home'); assert.equal(d.activeElement, buttons[0]);
	key(buttons[0], 'Escape'); assert(closed); assert.equal(d.activeElement, opener);
	console.log('ok menus skip unavailable entries, support arrow/Home navigation and restore the trigger on Escape');

	w.el.messages = d.getElementById('messages'); w.el.scrollBottom = d.getElementById('btn-scroll-bottom'); w.ui.stick = true;
	let transcriptHeight = 1000;
	Object.defineProperties(w.el.messages, { clientWidth: { value: 400 }, clientHeight: { value: 200 }, scrollHeight: { get: () => transcriptHeight } });
	w.el.messages.getBoundingClientRect = () => ({ top: 0 }); w.el.messages.scrollTop = 800;
	let scrolls = 0; w.el.messages.scrollTo = options => { scrolls++; w.el.messages.scrollTop = Math.min(transcriptHeight - 200, options.top); };
	const scrollStart = source.indexOf('\tconst atBottom ='), scrollEnd = source.indexOf('// ------------------------------------------------------------ prompt navigation', scrollStart);
	let completionScroll;
	function findCompletionScroll(node) {
		if (ts.isIfStatement(node) && node.expression.getText(ast) === 'sessionChanged || wasStreaming && !state.isStreaming') completionScroll = node.getText(ast);
		ts.forEachChild(node, findCompletionScroll);
	}
	findCompletionScroll(ast); assert(completionScroll);
	assert(scrollStart > 0 && scrollEnd > scrollStart);
	w.eval(source.slice(scrollStart, scrollEnd) + '\nwindow.applyCompletionScroll = function(wasStreaming, sessionChanged) { ' + completionScroll + ' };');
	w.el.messages.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -1 }));
	w.el.messages.dispatchEvent(new w.Event('scroll')); w.restoreReadingPosition();
	assert.equal(w.ui.stick, false); assert.equal(scrolls, 0, 'streaming cannot recapture a viewport immediately after upward input');
	w.el.scrollBottom.click(); assert.equal(w.ui.stick, true); assert.equal(scrolls, 1);
	w.el.messages.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -1 }));
	w.el.messages.scrollTop = 0; w.el.messages.dispatchEvent(new w.Event('scroll'));
	assert.equal(w.el.messages.style.getPropertyValue('--scroll-fade-top'), '0px'); assert.equal(w.el.messages.style.getPropertyValue('--scroll-fade-bottom'), '12px');
	console.log('ok streaming releases the viewport before an upward scroll settles and resumes only when requested');
	w.el.messages.innerHTML = '<article class="msg" id="reading-message"><div class="md"><p>Keep reading this paragraph.</p></div></article>';
	const paragraph = w.el.messages.querySelector('p'); let paragraphTop = 0;
	paragraph.getBoundingClientRect = () => ({ top: paragraphTop - w.el.messages.scrollTop, bottom: paragraphTop + 600 - w.el.messages.scrollTop });
	w.el.messages.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -1 }));
	w.el.messages.scrollTop = 150; w.el.messages.dispatchEvent(new w.Event('scroll'));
	paragraphTop = 20; w.restoreReadingPosition(); assert.equal(w.el.messages.scrollTop, 170);
	// A user scroll can arrive before the animation frame clears a restoration guard.
	w.el.messages.scrollTop = 300; w.el.messages.dispatchEvent(new w.Event('scroll'));
	paragraphTop = 40; w.restoreReadingPosition(); assert.equal(w.el.messages.scrollTop, 320, 'a later resize must preserve the new user position');
	console.log('ok reading restoration ignores its own scroll event while retaining user movement before the next frame');
	w.state.isStreaming = true;
	w.el.messages.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -1 }));
	w.applyCompletionScroll(true, false); w.restoreReadingPosition();
	assert.equal(w.ui.stick, false); assert.equal(w.el.messages.scrollTop, 320, 'ongoing responses keep the reading position');
	w.state.isStreaming = false;
	w.applyCompletionScroll(true, false); w.restoreReadingPosition();
	w.el.messages.dispatchEvent(new w.Event('scroll'));
	assert.equal(w.el.messages.scrollTop, 800, 'completion reaches the end even immediately after upward input');
	assert.equal(w.ui.stick, true); assert(w.el.scrollBottom.classList.contains('hidden'));
	transcriptHeight += 200;
	w.el.messages.dispatchEvent(new w.Event('load')); assert.equal(w.el.messages.scrollTop, 1000, 'late content loads keep following the completed answer');
	w.el.messages.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -1 }));
	w.el.messages.scrollTop = 150; w.el.messages.dispatchEvent(new w.Event('scroll'));
	w.applyCompletionScroll(false, false); w.restoreReadingPosition();
	assert.equal(w.el.messages.scrollTop, 150, 'later idle updates allow reading older messages');
	w.applyCompletionScroll(false, true); w.restoreReadingPosition();
	assert.equal(w.el.messages.scrollTop, 1000, 'opening a session also clears the previous reading position');
	console.log('ok completed answers and opened sessions resume bottom following without disturbing later scrollback');
	assert.deepEqual(rendererErrors, [], 'isolated UI fixtures must finish without renderer errors');
} finally { dom.window.close(); }
