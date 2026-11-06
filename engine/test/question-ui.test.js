// Exercise the production popup lifecycle and events with an in-memory DOM.
// Browser rendering is outside this offline test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript-classic');

const source = require('./page-scripts').readPage('chat.js');
const ast = ts.createSourceFile('chat.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(['h', 'renderQuestion', 'closeQuestionPopup', 'positionQuestionPopup', 'answerQuestion', 'openQuestionPopup', 'syncQuestionPopup']);
const declarations = [];
const visit = (node) => {
	if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) declarations.push(node.getText(ast));
	if (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => ['questionUi', 'pendingQuestion'].includes(d.name.getText(ast)))) declarations.push(node.getText(ast));
	ts.forEachChild(node, visit);
};
visit(ast);
assert.equal(declarations.length, names.size + 2);

function fixture(options = ['First choice', 'Second choice'], viewport = null) {
	let document;
	class Element {
		constructor(tag, cls = '') { this.tag = tag; this.className = cls; this.dataset = {}; this.attrs = {}; this.events = {}; this.children = []; this.value = ''; this.isConnected = false; this.top = 0; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; }
		set innerHTML(value) {
			this.html = value;
			if (this.className !== 'question-popup') return;
			this.children = [];
			this.appendChild(new Element('textarea'));
			const send = new Element('button', 'q-send'); send.disabled = true; this.appendChild(send);
			this.appendChild(new Element('form'));
			const close = new Element('button'); close.dataset.questionClose = ''; this.appendChild(close);
			const skip = new Element('button'); skip.dataset.questionSkip = ''; this.appendChild(skip);
			for (const match of value.matchAll(/<button class="q-opt" data-question-option="(\d+)"/g)) {
				const option = new Element('button', 'q-opt'); option.dataset.questionOption = match[1]; this.appendChild(option);
			}
		}
		get innerHTML() { return this.html; }
		setAttribute(name, value) { this.attrs[name] = value; }
		appendChild(child) { child.parent = this; child.connect(this.isConnected); this.children.push(child); return child; }
		get parentElement() { return this.parent; }
		getBoundingClientRect() { return { top: this.top, bottom: this.top + (this.height || 0), left: this.left || 0, width: this.width || 0, right: (this.left || 0) + (this.width || 0) }; }
		contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
		connect(on) { this.isConnected = on; this.children.forEach((child) => child.connect(on)); }
		remove() { this.parent.children = this.parent.children.filter((child) => child !== this); this.connect(false); }
		matches(selector) {
			if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
			if (selector.startsWith('[data-')) return Object.hasOwn(this.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
			return this.tag === selector;
		}
		closest(selector) { return selector.split(',').some((s) => this.matches(s.trim())) ? this : this.parent?.closest(selector) || null; }
		querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
		querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
		addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
		fire(name, properties = {}) {
			const event = { target: this, defaultPrevented: false, propagationStopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
			for (const fn of this.events[name] || []) fn(event);
			return event;
		}
		focus() { document.activeElement = this; }
	}
	const body = new Element('body'); body.connect(true);
	const app = body.appendChild(new Element('div'));
	const composer = app.appendChild(new Element('footer'));
	const inputCard = composer.appendChild(new Element('div')); inputCard.top = 600; inputCard.height = 96; inputCard.left = 80; inputCard.width = 640;
	const input = inputCard.appendChild(new Element('textarea'));
	document = { body, activeElement: input, createElement: (tag) => new Element(tag), documentElement: {} };
	const question = { id: 'q1', text: 'Which **direction**?', options, status: 'pending' };
	const state = { messages: [{ id: 'm1', question, role: 'assistant', kind: 'tool' }] };
	const posts = [];
	const timers = [];
	class ResizeObserver {
		constructor(callback) { this.callback = callback; this.targets = []; }
		observe(target) { assert.ok(target); this.targets.push(target); }
		disconnect() { this.disconnected = true; }
	}
	const surface = (properties) => ({
		...properties, events: new Map(),
		addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); },
		removeEventListener(name, fn) { this.events.get(name)?.delete(fn); },
		fire(name) { for (const fn of this.events.get(name) || []) fn(); }
	});
	const window = surface({ Icons: { svg: () => '<svg/>' }, innerWidth: 1024, innerHeight: 800, visualViewport: viewport && surface(viewport) });
	const context = vm.createContext({ document, Element, ResizeObserver, state, el: { input, inputCard, app }, window, closeMenus() {}, closePopup() {}, setTimeout: (fn) => timers.push(fn), post: (msg) => posts.push(JSON.parse(JSON.stringify(msg))), renderMessages: () => context.syncQuestionPopup() });
	for (const file of ['markdown.js', 'i18n.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../media', file), 'utf8'), context);
	vm.runInContext('const MD = window.Markdown, esc = MD.escape, I = window.Icons.svg, t = window.t;\n' + declarations.join('\n') + '\nglobalThis.questionState = questionUi;', context);
	return { context, state, question, posts, timers, document, window, input, inputCard, app, get popup() { return context.questionState.popup?.dialog; }, type(value) { this.popup.querySelector('textarea').value = value; this.popup.querySelector('textarea').fire('input'); } };
}

// Opens only pending requests, displays safe content, leaves a compact reopen card.
let f = fixture(['<script>unsafe</script>', 'Second choice']);
f.question.status = 'answered'; f.context.syncQuestionPopup(); assert.equal(f.popup, undefined);
f.question.status = 'pending'; f.context.syncQuestionPopup();
assert.equal(f.popup.parentElement, f.document.body, 'popup floats outside the chat column and prompt box');
assert.ok(!f.app.contains(f.popup));
assert.equal(f.popup.attrs['aria-modal'], 'false', 'chat stays usable');
assert.equal(f.popup.style.width, '420px', 'wide columns keep a compact popup');
assert.equal(f.popup.style.left, '400px', 'popup is centered on the prompt box');
assert.equal(f.popup.style.bottom, '104px', 'popup overlaps the prompt box in the foreground');
assert.equal(f.popup.style['--question-popup-max-height'], '320px');
assert.equal(f.window.events.get('resize').size, 1);
const observer = f.context.questionState.popup.observer;
assert.equal(observer.targets.length, 3);
f.inputCard.top = 180; observer.callback();
assert.equal(f.popup.style.bottom, '524px', 'popup follows the prompt box as its layout changes');
f.app.top = 30; f.context.positionQuestionPopup();
assert.equal(f.popup.style['--question-popup-max-height'], '268px', 'column boundaries do not clip the floating popup');
f.window.innerWidth = 320; f.window.fire('resize');
assert.equal(f.popup.style.width, '304px'); assert.equal(f.popup.style.left, '160px');
f.window.innerHeight = 140; f.window.fire('resize');
assert.equal(f.popup.style.bottom, '8px'); assert.equal(f.popup.style['--question-popup-max-height'], '124px');
assert.equal(f.document.activeElement, f.popup.querySelector('.q-opt'));
assert.equal(f.popup.attrs['aria-describedby'], 'question-popup-text');
assert.match(f.popup.innerHTML, /&lt;script&gt;unsafe&lt;\/script&gt;/);
assert.match(f.popup.innerHTML, /<strong>direction<\/strong>/);
assert.match(f.context.renderQuestion(f.state.messages[0]).innerHTML, /data-question-open="q1"/);
assert.ok(!f.context.renderQuestion(f.state.messages[0]).innerHTML.includes('class="q-opt"'));

// Repeated state updates preserve the exact field, value, selection and focus.
const popup = f.popup, field = popup.querySelector('textarea');
f.type('My draft'); field.selectionStart = 3; field.focus();
f.context.syncQuestionPopup();
assert.equal(f.popup, popup); assert.equal(field.value, 'My draft');
assert.equal(field.selectionStart, 3); assert.equal(f.document.activeElement, field);

// Escape dismisses without answering; dismissed prompts can reopen with their draft.
const escaped = popup.fire('keydown', { key: 'Escape', target: field });
assert.ok(escaped.defaultPrevented && escaped.propagationStopped);
assert.equal(f.popup, undefined); assert.deepEqual(f.posts, []);
assert.ok(observer.disconnected);
assert.equal(f.window.events.get('resize').size, 0);
assert.equal(f.document.activeElement, f.input);
f.context.syncQuestionPopup(); assert.equal(f.popup, undefined);
f.context.openQuestionPopup('q1'); assert.equal(f.popup.querySelector('textarea').value, 'My draft');
f.popup.fire('click', { target: f.popup.querySelector('[data-question-close]') });
f.context.syncQuestionPopup(); assert.equal(f.popup, undefined); assert.deepEqual(f.posts, []);

// Option navigation and number shortcuts submit once, even with delayed host state.
f.context.openQuestionPopup('q1');
const opts = f.popup.querySelectorAll('.q-opt');
f.popup.fire('keydown', { key: 'ArrowDown', target: opts[0] });
assert.equal(f.document.activeElement, opts[1]);
f.popup.fire('keydown', { key: '2', target: opts[1] });
f.context.answerQuestion('q1', 'duplicate'); f.context.syncQuestionPopup();
assert.deepEqual(f.posts, [{ type: 'answer', id: 'q1', answer: 'Second choice' }]);
assert.equal(f.popup, undefined);
assert.match(f.context.renderQuestion(f.state.messages[0]).innerHTML, /disabled/);

// A dropped remote request unlocks a manual retry without interrupting the chat.
f.timers[0](); assert.equal(f.popup, undefined);
assert.ok(!f.context.renderQuestion(f.state.messages[0]).innerHTML.includes('disabled'));
f.context.openQuestionPopup('q1'); assert.equal(f.popup.querySelector('textarea').value, 'My draft');

// Free-form questions accept multiline replies and respect IME / Shift+Enter.
f = fixture([]); f.context.syncQuestionPopup();
assert.equal(f.document.activeElement, f.popup.querySelector('textarea'));
assert.ok(f.popup.querySelector('.q-send').disabled);
f.type('   '); f.popup.querySelector('form').fire('submit'); assert.deepEqual(f.posts, []);
f.type('  My custom\nreply  ');
const answerField = f.popup.querySelector('textarea');
f.popup.fire('keydown', { key: 'Enter', target: answerField, isComposing: true });
f.popup.fire('keydown', { key: 'Enter', target: answerField, shiftKey: true });
f.popup.fire('keydown', { key: '1', target: answerField }); assert.deepEqual(f.posts, []);
f.popup.fire('keydown', { key: 'Enter', target: answerField });
assert.deepEqual(f.posts, [{ type: 'answer', id: 'q1', answer: 'My custom\nreply' }]);

// Buttons follow the same protocol; Skip sends an empty answer intentionally.
f = fixture(); f.context.syncQuestionPopup();
f.popup.fire('click', { target: f.popup.querySelectorAll('.q-opt')[0] });
assert.equal(f.posts[0].answer, 'First choice');
f = fixture(); f.context.syncQuestionPopup(); f.type('Use the send button');
f.popup.querySelector('form').fire('submit'); assert.equal(f.posts[0].answer, 'Use the send button');
f = fixture(); f.context.syncQuestionPopup();
f.popup.fire('click', { target: f.popup.querySelector('[data-question-skip]') });
assert.deepEqual(f.posts, [{ type: 'answer', id: 'q1', answer: '' }]);

// A remote answer, stopped run, or session change removes stale UI and drafts.
f = fixture(); f.context.syncQuestionPopup(); f.type('Old draft');
f.question.status = 'answered'; f.question.answer = 'Answered remotely'; f.context.syncQuestionPopup();
assert.equal(f.popup, undefined); assert.equal(f.context.questionState.drafts.size, 0);
assert.match(f.context.renderQuestion(f.state.messages[0]).innerHTML, /Answered remotely/);
f.state.messages = [{ question: { id: 'q2', text: 'Next?', options: [], status: 'pending' } }];
f.context.syncQuestionPopup(); assert.equal(f.popup.querySelector('textarea').value, '');
f.state.messages = []; f.context.syncQuestionPopup(); assert.equal(f.popup, undefined);
f.context.openQuestionPopup('q2'); f.context.answerQuestion('q2', 'stale'); assert.deepEqual(f.posts, []);

// Resolving the non-modal panel does not steal focus from a prompt being edited.
f = fixture(); f.context.syncQuestionPopup();
const outsideField = f.document.body.appendChild(f.document.createElement('textarea')); outsideField.focus();
f.question.status = 'answered'; f.context.syncQuestionPopup();
assert.equal(f.document.activeElement, outsideField);

// The detached popup stays visible when a mobile keyboard shrinks the viewport.
f = fixture(undefined, { offsetLeft: 0, offsetTop: 120, width: 390, height: 280 });
f.context.syncQuestionPopup();
assert.equal(f.popup.style.width, '374px'); assert.equal(f.popup.style.left, '195px');
assert.equal(f.popup.style.bottom, '408px'); assert.equal(f.popup.style['--question-popup-max-height'], '264px');
f.window.visualViewport.height = 160; f.window.visualViewport.fire('resize');
assert.equal(f.popup.style.bottom, '528px');
f.context.closeQuestionPopup(true);
assert.equal(f.window.visualViewport.events.get('resize').size, 0);
assert.equal(f.window.visualViewport.events.get('scroll').size, 0);

// Concurrent requests advance in arrival order instead of covering an open request.
f = fixture(); f.state.messages.push({ question: { id: 'q2', text: 'Another?', options: [], status: 'pending' } });
f.context.syncQuestionPopup(); assert.equal(f.context.questionState.popup.id, 'q1');
f.context.answerQuestion('q1', 'First choice'); assert.equal(f.context.questionState.popup.id, 'q2');
f.question.status = 'answered'; f.context.syncQuestionPopup(); assert.equal(f.context.questionState.submitted.size, 0);
console.log('Question popup checks passed (prompt overlap, viewport bounds, lifecycle, drafts, replies, focus).');
