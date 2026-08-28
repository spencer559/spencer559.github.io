/**
 * The app is commonly opened straight from disk. A file:// document has the opaque origin
 * "null", which postMessage does not accept as targetOrigin. Both pages that host PDF_Viewer
 * must therefore use "*" for that one case while retaining an exact origin when hosted.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const reportGenerator = fs.readFileSync(path.join(root, "protected", "CRM_Report_Generator.html"), "utf8");
const schedule = fs.readFileSync(path.join(root, "protected", "Patient_Schedule.html"), "utf8");

function assertOpaqueOriginFallback(source, label) {
  assert.match(
    source,
    /var targetOrigin = location\.origin === ["']null["'] \? ["']\*["'] : location\.origin;[\s\S]{0,300}?postMessage\(\{ type: ["']pdfviewer:doc["']/,
    label + " must use a wildcard target only when the page has a file:// opaque origin"
  );
}

assertOpaqueOriginFallback(reportGenerator, "Report Generator");
assertOpaqueOriginFallback(schedule, "Schedule");

console.log("pdf-viewer-local-handoff tests passed");
