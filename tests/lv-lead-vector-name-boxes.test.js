"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const page = fs.readFileSync(path.join(__dirname, "..", "protected", "LV_Lead_Testing.html"), "utf8");

/* The arrow is the clearest part of a vector name and the worst character to reach on a phone
   keyboard, so it is furniture between two boxes — never something anyone has to type. */
assert.match(page, /electrodeInput\(v\.cathode, "Cathode", "vn-cath"[\s\S]{0,220}?el\("span", "vn-arrow"\)[\s\S]{0,200}?electrodeInput\(v\.anode, "Anode", "vn-anode"/,
  "the vector name is a cathode box, a fixed arrow, then an anode box, in that order");
assert.match(page, /arrow\.textContent = "\\u2192"/, "the arrow between the boxes is rendered, not typed");
assert.doesNotMatch(page, /val\.split\(\/→\|->\|\\\/\//,
  "with two boxes there is no arrow to parse back out of a single field");

/* Each box writes its own half of the vector, so nothing downstream has to re-split a label. */
assert.match(page, /v\.cathode = val; markDirty\(\)/, "the cathode box writes cathode directly");
assert.match(page, /v\.anode = val; markDirty\(\)/, "the anode box writes anode directly");

/* A phone keyboard left alone turns "D1" into "Di". */
assert.match(page, /function electrodeInput[\s\S]{0,420}?i\.autocomplete = "off"; i\.spellcheck = false;[\s\S]{0,80}?setAttribute\("autocorrect", "off"\)/,
  "electrode boxes must switch off autocorrect, autocomplete and spellcheck");
assert.match(page, /i\.setAttribute\("aria-label", placeholder\)/,
  "each box needs its own label — the arrow between them is decoration");

/* + Add vector should land in the first box of the new row, not the last box on the page. */
assert.match(page, /function addVector[\s\S]{0,220}?querySelectorAll\("#vec-list \.vn-cath"\)/,
  "adding a vector focuses the new row's cathode box");

console.log("PASS lv-lead-vector-name-boxes");
