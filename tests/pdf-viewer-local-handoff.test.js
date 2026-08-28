/** Patient PDFs must bypass the custom pdf.js viewer and use the browser's native renderer. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const reportGenerator = fs.readFileSync(path.join(root, "protected", "CRM_Report_Generator.html"), "utf8");
const schedule = fs.readFileSync(path.join(root, "protected", "Patient_Schedule.html"), "utf8");

assert.doesNotMatch(reportGenerator, /PDF_Viewer\.html#|pdfviewer:doc/,
  "the Report Generator must not route patient PDFs through the custom pdf.js viewer");
assert.match(reportGenerator, /URL\.createObjectURL\(payload\)[\s\S]{0,250}?window\.open\(url \+ '#view=Fit'/,
  "the Report Generator should open the original PDF Blob in the native viewer");

assert.doesNotMatch(schedule, /PDF_Viewer\.html#|pdfviewer:doc/,
  "the Schedule must not route patient PDFs through the custom pdf.js viewer");
assert.match(schedule, /window\.open\("about:blank", "_blank"\)[\s\S]{0,900}?location\.replace\(url \+ "#view=Fit"\)/,
  "the Schedule should reserve a popup synchronously, then navigate it to the native PDF Blob");
assert.match(schedule, /panel\.viewUrl = URL\.createObjectURL\(payload\)[\s\S]{0,180}?<iframe[^>]+panel\.viewUrl/,
  "the inline split should also embed the native PDF Blob rather than the custom viewer");

console.log("native PDF viewer routing tests passed");
