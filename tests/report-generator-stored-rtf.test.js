"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "protected", "CRM_Report_Generator.html"),
  "utf8"
);

const finalizeStart = source.indexOf("function finalizeReports()");
const finalizeEnd = source.indexOf("document.addEventListener('input'", finalizeStart);
assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart,
  "the report finalizer should be extractable");
const finalizeSource = source.slice(finalizeStart, finalizeEnd);
assert.doesNotMatch(finalizeSource, /WS\.writeFile\(dir, 'report\.rtf'/,
  "RTF must stay out of the pre-existing PDF finalization pipeline");
assert.match(finalizeSource, /WS\.writeFile\(dir, 'report\.txt', summaryLines\.join\('\\n'\)\)/,
  "finalizing must retain the text snapshot used to derive a downloaded RTF");
assert.match(source, /n !== 'report\.rtf'/,
  "the generator's Files menu must hide RTF files left by the previous release");
assert.match(finalizeSource, /WS\.writeFile\(dir, 'report\.pdf', pdf\)/,
  "generated PDF storage must remain in the original finalization transaction");
assert.doesNotMatch(source, /Save all to patient folder/,
  "patient-folder export belongs to the Schedule, not the Report Generator Export menu");
assert.doesNotMatch(source, /Save database now \(autosaves anyway\)|Save database to USB/,
  "database saving belongs to the Schedule, not the Report Generator Export menu");

console.log("stored RTF report checks passed");
