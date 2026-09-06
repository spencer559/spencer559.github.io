"use strict";
const assert = require('assert');
const { reveal, focusRow, removeRow } = require('../src/crm-keyboard-focus.js');
global.getComputedStyle = pane => pane.style;
function rect(top, left, width, height) {
  return { top, left, width, height, bottom: top + height, right: left + width };
}
function setup(fieldRect, inputRect, horizontal = false) {
  const outer = { scrollTop: 90, scrollLeft: 50 };
  const main = {
    parentElement: outer, contains: () => true, style: { overflowY: 'auto', overflowX: 'hidden' },
    clientHeight: 300, clientWidth: 400, clientTop: 0, clientLeft: 0,
    scrollHeight: 1000, scrollWidth: 400, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => rect(44, 0, 400, 300)
  };
  const cellPane = {
    parentElement: main, style: { overflowY: 'auto', overflowX: 'auto' },
    clientHeight: 200, clientWidth: 400, clientTop: 0, clientLeft: 0,
    scrollHeight: 200, scrollWidth: horizontal ? 800 : 400, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => rect(100, 0, 400, 200)
  };
  const control = { parentElement: cellPane, closest: () => ({ getBoundingClientRect: () => fieldRect }),
    getBoundingClientRect: () => inputRect || fieldRect };
  return { main, outer, cellPane, control };
}
let s = setup(rect(100, 20, 160, 40));
reveal(s.control, s.main);
assert.strictEqual(s.main.scrollTop, 0, 'visible field should not cause a jump');
s = setup(rect(35, 20, 160, 40), rect(55, 20, 160, 20));
reveal(s.control, s.main);
assert.strictEqual(s.main.scrollTop, -17, 'include the label when tabbing backward');
assert.strictEqual(s.outer.scrollTop, 90, 'must not scroll the schedule');
s = setup(rect(320, 20, 160, 40));
reveal(s.control, s.main);
assert.strictEqual(s.main.scrollTop, 24, 'expose field below the pane');
s = setup(rect(150, 450, 100, 24), null, true);
reveal(s.control, s.main);
assert.strictEqual(s.cellPane.scrollLeft, 158, 'reveal a cell in a wide table');
assert.strictEqual(s.outer.scrollLeft, 50, 'must not scroll the source PDF/schedule');
// Added rows skip hidden/disabled fields. Removal prefers next, then previous, then Add.
let focused = null;
function field(name, visible = true, disabled = false) {
  return { disabled, getClientRects: () => visible ? [{}] : [], closest: () => null,
    focus: options => { assert.strictEqual(options.preventScroll, true); focused = name; } };
}
const next = { querySelectorAll: () => [field('next')] };
const previous = { querySelectorAll: () => [field('previous')] };
focusRow({ querySelectorAll: () => [field('hidden', false), field('disabled', true, true), field('new')] });
assert.strictEqual(focused, 'new');
for (const [nextRow, previousRow, expected] of [[next, previous, 'next'], [null, previous, 'previous'], [null, null, 'add']]) {
  let removed = false;
  removeRow({ nextElementSibling: nextRow, previousElementSibling: previousRow,
    closest: () => ({ parentElement: { querySelector: () => field('add') } }),
    remove: () => { removed = true; } });
  assert.ok(removed);
  assert.strictEqual(focused, expected);
}
console.log('PASS crm-keyboard-focus');
