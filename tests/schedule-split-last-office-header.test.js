"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const schedule = fs.readFileSync(path.join(__dirname, "..", "protected", "Patient_Schedule.html"), "utf8");

const slotPos = schedule.indexOf('<span class="crm-panel-slot">');
const officePos = schedule.indexOf('<span class="crm-panel-last-office">');
const syncPos = schedule.indexOf('<span class="crm-panel-sync"');

assert.ok(slotPos >= 0 && slotPos < officePos && officePos < syncPos,
  "the split header should show Last Office immediately after the slot/file structure");
assert.match(schedule,
  /\(r\.lastOff \? '<span class="crm-panel-last-office">Last Office: ' \+ esc\(fmtDate\(r\.lastOff\)\) \+ '<\/span>' : ''\)/,
  "the header should format the open schedule row's Last Office date and omit an empty value");
assert.match(schedule,
  /\.crm-panel-last-office \{ flex:0 0 auto;[^}]*white-space:nowrap;/,
  "the Last Office header item should remain compact without changing the panel dimensions");

console.log("PASS schedule-split-last-office-header");
