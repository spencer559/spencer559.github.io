/**
 * Generated CRM reports use jsPDF's standard Helvetica fonts. The custom pdf.js previewer must
 * not ask Chromium to substitute/cache those as @font-face resources: that browser-only path can
 * display a valid downloaded PDF with scrambled glyphs. Programmer PDFs keep normal font loading.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "protected", "PDF_Viewer.html"),
  "utf8"
);

assert.match(source, /var isGeneratedCrmReport = \/_CRM_Report\\\.pdf\$\/i\.test\(docName\)/,
  "the viewer should recognize the chart filename used for generated CRM reports");
assert.match(source, /disableFontFace: isGeneratedCrmReport/,
  "generated reports should use pdf.js glyph paths instead of browser font-face substitution");
assert.match(source, /useSystemFonts: !isGeneratedCrmReport/,
  "generated reports must avoid system-font substitution while programmer PDFs retain it");

console.log("generated-report PDF font rendering checks passed");
