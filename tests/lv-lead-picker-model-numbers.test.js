"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const page = fs.readFileSync(path.join(__dirname, "..", "protected", "LV_Lead_Testing.html"), "utf8");

/* The picker exists because a <select> cannot give an option a second, quieter line. If it
   ever goes back to being a <select>, the model numbers silently lose their styling. */
assert.doesNotMatch(page, /<select id="lead-preset"/,
  "the lead picker must not revert to a native <select> — options cannot carry a styled second line");
assert.match(page, /id="lead-preset-btn"[\s\S]{0,400}?class="pk-name" id="lead-preset-name"[\s\S]{0,200}?class="pk-num" id="lead-preset-num"/,
  "the picker button shows the lead name with the model numbers beneath it");
assert.match(page, /\.pk-num \{[\s\S]{0,200}?font-size: 10\.5px; font-weight: 400;[\s\S]{0,120}?color: var\(--text-faint\)/,
  "model numbers must render smaller, lighter and fainter than the lead name");

/* Every library entry carries a models field, even when it is empty — a missing one would
   read as undefined in the list. */
const lib = page.slice(page.indexOf("var LEAD_LIBRARY = ["), page.indexOf("/* ================================================================== STATE */"));
const entries = lib.match(/\{ id: "/g) || [];
/* "manual" and the two Generic geometry fallbacks name no product, so they carry no number. */
const named = entries.length - 3;
const models = lib.match(/models: "/g) || [];
assert.strictEqual(models.length, named,
  "every named lead needs a models field (\"\" when the number is not known)");
assert.match(lib, /label: "Attain Performa \(Straight \/ S-shape \/ Spiral\)", models: "4298 \/ 4398 \/ 4598"/,
  "families with several numbers list them separated by \" / \"");

/* The safety property the library's header comment claims: a number in the picker is for
   recognising the lead, never a value that can travel into a report. */
assert.doesNotMatch(page, /leadModel = [^\n]*\.models/, "the models field must never fill the lead-model input");
assert.doesNotMatch(page, /presetLabel[\s\S]{0,200}?\.models/, "the models field must never reach the report or print sheet");

console.log("PASS lv-lead-picker-model-numbers");
