'use strict';
// The Design cursor's pure parts: finding what to redraw in a window, what changed between two
// observations and the element under a point; and what its window may ask of the app.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { allowed, validated } = require('../app/permissions');

const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/computer-effects-geometry.js'), 'utf8'), { window, Math, Map });
const G = window.ZcEffectsGeometry;

// A 200 × 120 window: grey background, two buttons with a dark label each, and a line of text.
function image(extra) {
	const w = 200, h = 120, d = new Uint8ClampedArray(w * h * 4);
	const fill = (x0, y0, x1, y1, [r, g, b]) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } };
	fill(0, 0, w, h, [240, 240, 240]);
	fill(10, 60, 90, 100, [255, 255, 255]);
	fill(30, 76, 70, 84, [20, 20, 20]);
	fill(110, 60, 190, 100, [255, 255, 255]);
	fill(130, 76, 170, 84, [20, 20, 20]);
	// Letters one pixel apart, words two.
	for (let x = 10; x < 150; x += 4) fill(x, 20, x + (x % 20 === 18 ? 2 : 3), 30, [30, 30, 30]);
	if (extra) extra(fill);
	return { d, w, h };
}

const a = image();
const blocks = G.segment(a.d, a.w, a.h, { x: 0, y: 0, w: a.w, h: a.h }, 16);
const inside = (b, x0, y0, x1, y1) => b.x >= x0 - 1 && b.y >= y0 - 1 && b.x + b.w <= x1 + 1 && b.y + b.h <= y1 + 1;
assert(blocks.some((b) => inside(b, 10, 20, 150, 30) && b.w > 100), 'the text line is one block');
assert(blocks.some((b) => inside(b, 10, 60, 90, 100) && b.w > 60), 'the left button is its own block');
assert(blocks.some((b) => inside(b, 110, 60, 190, 100) && b.w > 60), 'the right button is its own block');
assert(blocks.every((b) => b.y + b.h <= 32 || b.y >= 58), 'nothing is cut out of the empty background');
assert.deepEqual(blocks.map((b) => b.y).slice().sort((x, y) => x - y), blocks.map((b) => b.y), 'blocks run top to bottom');
assert(G.segment(a.d, a.w, a.h, { x: 0, y: 0, w: a.w, h: a.h }, 2).length <= 2, 'the block limit holds');
assert.equal(G.segment(image().d, 200, 120, { x: 0, y: 105, w: 200, h: 15 }, 6).length, 0, 'a flat area has nothing to redraw');

assert.equal(G.diff(a.d, image().d, a.w, a.h), null, 'identical frames do not change');
const caret = image((fill) => fill(160, 20, 161, 30, [0, 0, 0]));
assert.equal(G.diff(a.d, caret.d, a.w, a.h), null, 'a blinking caret is not a change');
const changed = image((fill) => fill(110, 60, 190, 100, [40, 120, 220]));
const box = G.diff(a.d, changed.d, a.w, a.h);
assert(box && inside(box, 110, 60, 190, 100) && box.w > 70, 'the changed button is found');
assert.equal(G.diff(a.d, changed.d, a.w, a.h, [{ x: 108, y: 58, w: 84, h: 44 }]), null, 'a change inside the element just clicked (its hover tint) is ignored');

const button = G.element(a.d, a.w, a.h, 50, 80);
assert(inside(button, 10, 60, 90, 100) && button.w >= 76 && button.h >= 36, 'a click on a label finds its whole button: ' + JSON.stringify(button));
assert.deepEqual([...G.dominant(a.d, a.w, a.h)], [240, 240, 240], 'the background is the most common colour');
// A keypad: a framed window of buttons two pixels apart, as in Calculator.
const pad = image((fill) => {
	fill(0, 0, 200, 120, [228, 240, 234]);
	for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { fill(10 + c * 46, 10 + r * 34, 54 + c * 46, 42 + r * 34, [251, 252, 252]); fill(24 + c * 46, 22 + r * 34, 34 + c * 46, 30 + r * 34, [30, 30, 30]); }
	for (let i = 0; i < 200; i++) { fill(i, 0, i + 1, 1, [120, 120, 120]); fill(i, 119, i + 1, 120, [120, 120, 120]); }
	for (let i = 0; i < 120; i++) { fill(0, i, 1, i + 1, [120, 120, 120]); fill(199, i, 200, i + 1, [120, 120, 120]); }
});
const keys = G.segment(pad.d, pad.w, pad.h, { x: 0, y: 0, w: pad.w, h: pad.h }, 16);
assert(keys.length >= 3, 'a framed window still splits into rows of keys: ' + JSON.stringify(keys));
const key = G.element(pad.d, pad.w, pad.h, 72, 60);
assert(key.w <= 46 && key.h <= 34 && inside(key, 56, 44, 100, 76), 'a click finds one key, not the keypad: ' + JSON.stringify(key));
// Calculator's keys are barely lighter than its background, and it has more rows than the limit.
const faint = image((fill) => {
	fill(0, 0, 200, 120, [242, 243, 245]);
	for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { fill(10 + c * 46, 10 + r * 34, 54 + c * 46, 42 + r * 34, [251, 251, 251]); fill(26 + c * 46, 22 + r * 34, 29 + c * 46, 30 + r * 34, [26, 26, 26]); fill(33 + c * 46, 22 + r * 34, 36 + c * 46, 30 + r * 34, [26, 26, 26]); }
});
const faintKey = G.element(faint.d, faint.w, faint.h, 72, 60);
assert(faintKey.w <= 46 && faintKey.h <= 34 && inside(faintKey, 56, 44, 100, 76), 'a faint key is still one key: ' + JSON.stringify(faintKey));
const lines = image((fill) => { for (let r = 0; r < 24; r++) fill(10, 2 + r * 5, 60 + (r % 5) * 20, 5 + r * 5, [30, 30, 30]); });
const many = G.segment(lines.d, lines.w, lines.h, { x: 0, y: 0, w: lines.w, h: lines.h }, 16);
assert(many.length > 4 && many.length <= 16, 'more rows than the limit are joined, not dropped: ' + many.length);
// A card with its own fill is drawn first as a panel, then what is inside it.
const card = image((fill) => { fill(0, 0, 200, 120, [240, 240, 240]); fill(20, 10, 180, 110, [60, 60, 70]); fill(40, 30, 120, 40, [250, 250, 250]); fill(40, 70, 160, 90, [250, 250, 250]); });
const parts = G.segment(card.d, card.w, card.h, { x: 0, y: 0, w: card.w, h: card.h }, 16);
assert.equal(parts[0].kind, 'panel', 'the card comes first: ' + JSON.stringify(parts));
assert(parts.length >= 3 && parts.slice(1).every((b) => inside(b, 20, 10, 180, 110) && b.kind !== 'panel'), 'its contents follow');

// The effects window may draw and report, and pause, stop or ask to resume; nothing else.
for (const cmd of ['effects_hover', 'effects_shown', 'effects_control']) assert(allowed('effects', cmd), cmd);
for (const cmd of ['create_project', 'tray_action', 'notch_act', 'glass_prefs']) assert(!allowed('effects', cmd), cmd);
for (const page of ['engine', 'start', 'notch', 'tray', 'quick']) assert(!allowed(page, 'effects_control'), page);
assert.deepEqual(validated('effects_shown', { id: 'a1b2-c3' }), { id: 'a1b2-c3' });
assert.equal(validated('effects_shown', { id: '../stop' }), undefined);
assert.equal(validated('effects_shown', {}), undefined);
assert.deepEqual(validated('effects_control', { action: 'resume' }), { action: 'resume' });
assert.equal(validated('effects_control', { action: 'allow' }), undefined);
assert.deepEqual(validated('effects_hover', { on: 'yes' }), { on: false });
console.log('Computer Use effects: redraw blocks, change detection, element boxes and window permissions.');
