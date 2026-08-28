"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "protected", "CRM_Report_Generator.html"),
  "utf8"
);

assert.match(source, /WS\.writeFile\(dir, 'report\.rtf', new Blob\(\[buildSummaryRtf\(summaryLines\)\], \{ type: 'application\/rtf' \}\)\)/,
  "finalizing a report should store a native RTF from the same summary snapshot");
assert.match(source, /n !== 'report\.rtf'/,
  "the generator's Files menu must hide the derived RTF");
assert.match(source, /WS\.writeFile\(dir, 'report\.pdf', pdf\)/,
  "the RTF addition must preserve generated PDF storage");
assert.doesNotMatch(source, /Save all to patient folder/,
  "patient-folder export belongs to the Schedule, not the Report Generator Export menu");
assert.doesNotMatch(source, /Save database now \(autosaves anyway\)|Save database to USB/,
  "database saving belongs to the Schedule, not the Report Generator Export menu");

console.log("stored RTF report checks passed");
