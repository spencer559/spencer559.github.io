"use strict";

/* The reminder list under the schedule.
 *
 * Two things matter and neither is obvious from reading a diff: reminders must live OUTSIDE
 * state.dates (so date navigation and the retention window can't hide or delete an outstanding
 * follow-up), and the ordering rule must keep open tasks in the order they were written while
 * sinking finished ones. The ordering comparator is lifted out of the page and actually run. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const schedule = fs.readFileSync(path.join(__dirname, "..", "protected", "Patient_Schedule.html"), "utf8");

/* ---------- the panel sits below the schedule, inside the scroller ---------- */
const schedPanel = schedule.indexOf('<div class="panel">');
const remPanel = schedule.indexOf('<div class="panel" id="remPanel">');
const scrollEnd = schedule.indexOf('<div id="allModal"');
assert.ok(schedPanel >= 0 && schedPanel < remPanel && remPanel < scrollEnd,
  "the reminders panel should render below the schedule panel and inside .main-scroll");
assert.ok(schedule.includes('<ul id="remList" class="rem-list">') &&
          schedule.includes('id="remInput"') &&
          schedule.includes('onclick="addReminder()"') &&
          schedule.includes('onclick="clearDoneReminders()"'),
  "the panel needs its list, its entry field, and both actions");

/* ---------- reminders are database-wide, not per-day ---------- */
assert.ok(schedule.includes('function blank() { return { type: "patient-schedule", version: 1, providers: ["Tech"], dates: {}, reminders: [] }; }'),
  "a fresh schedule should start with an empty reminder list");
assert.match(schedule, /function reminders\(\) \{ if \(!Array\.isArray\(state\.reminders\)\) state\.reminders = \[\]; return state\.reminders; \}/,
  "reminders should hang off state directly, not off state.dates");
const prune = schedule.match(/function pruneRowsBefore\([\s\S]*?\n(?=  function|  \/\/|  \/\*)/)[0];
assert.ok(!/reminder/i.test(prune),
  "retention pruning must not touch reminders — it only ever drops days out of state.dates");
assert.ok(/function migrate\(s\) \{[\s\S]{0,600}?if \(!Array\.isArray\(s\.reminders\)\) s\.reminders = \[\];/.test(schedule),
  "a database written before reminders existed should migrate to an empty list, not crash");

/* ---------- the list is rebuilt whenever adopted state replaces our own ---------- */
assert.match(schedule, /renderCounts\(\);[\s\S]{0,300}renderReminders\(\);[\s\S]{0,60}scanSlots\(\);/,
  "render() should refresh the reminder list too, or a loaded database would show the old one");

/* ---------- run the ordering rule ---------- */
const src = schedule.match(/  function sortedReminders\(\) \{[\s\S]*?\n  \}/)[0];
let list = [];
const sortedReminders = new Function("reminders", src + "; return sortedReminders;")(() => list);

list = [
  { id: "a", text: "first written",  done: false, created: 300, doneAt: 0 },
  { id: "b", text: "ticked early",   done: true,  created: 100, doneAt: 1000 },
  { id: "c", text: "second written", done: false, created: 200, doneAt: 0 },
  { id: "d", text: "ticked late",    done: true,  created: 400, doneAt: 2000 }
];
assert.deepStrictEqual(sortedReminders().map((m) => m.id), ["a", "c", "d", "b"],
  "open reminders keep their written order; done ones sink below, most recently ticked first");
assert.deepStrictEqual(list.map((m) => m.id), ["a", "b", "c", "d"],
  "sorting is for display only — it must not reorder the stored list");

list = [];
assert.deepStrictEqual(sortedReminders(), [], "an empty list sorts to an empty list");

console.log("PASS schedule-reminders");
