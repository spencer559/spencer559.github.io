"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "protected", "CRM_Report_Generator.html"),
  "utf8"
);

assert.match(source, /draggable="true" ondragstart="dragFormattedRtf\(event\)"/,
  "the formatted RTF export row should be directly draggable");
assert.match(source, /onclick="exportFormattedRtf\(\)"/,
  "the same export row should offer a saved-file fallback");

const start = source.indexOf("function formattedRtfFile()");
const end = source.indexOf("function exportJSON()", start);
assert.ok(start >= 0 && end > start, "RTF handoff functions should be extractable");
const handoff = source.slice(start, end);

assert.match(handoff, /buildSummaryRtf\(buildSummaryLines\(\)\)/,
  "the RTF file should be built from the current report at handoff time");
assert.match(handoff, /type: 'application\/rtf'/,
  "the dragged file should carry an RTF MIME type");
assert.match(handoff, /dt\.items\.add\(file\)/,
  "web drop targets should receive a File payload");
assert.match(handoff, /setData\('DownloadURL'/,
  "native drop targets should receive Chromium's DownloadURL payload");
assert.match(handoff, /saveFile\(file\.name, file, file\.type\)/,
  "clicking should save exactly the same generated RTF file");

console.log("formatted RTF drag-out regression tests passed");
