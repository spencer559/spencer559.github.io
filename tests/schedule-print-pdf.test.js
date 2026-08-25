/* "Print schedule" builds a two-line-per-appointment PDF, so the notes get a full-width line of
   their own instead of a sliver of a table column. These cover the two pieces that decide what
   lands on paper: the pure pagination plan, and the click path that has to open the viewer tab
   before it awaits anything. */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function functionSource(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notStrictEqual(start, -1, name + " must exist");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail("Could not find the end of " + name);
}

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "protected", "Patient_Schedule.html"), "utf8");

/* ---------- wiring ---------- */

assert.match(html, /onclick="printSchedule\(\)"/, "the button keeps calling printSchedule()");
assert.ok(fs.existsSync(path.join(root, "vendor", "jspdf.umd.min.js")),
  "the schedule PDF builder is vendored, never fetched from a CDN");
assert.match(functionSource(html, "ensureSchedulePdfBuilder"), /\.\.\/vendor\/jspdf\.umd\.min\.js/,
  "the builder must load the local jsPDF");

const click = html.slice(html.indexOf("window.printSchedule = function"),
  html.indexOf('window.addEventListener("beforeprint"'));
assert.ok(click.indexOf("reservePdfViewer(") < click.indexOf("ensureSchedulePdfBuilder()"),
  "the viewer tab must be opened from the click itself, before anything is awaited, or the " +
  "pop-up blocker eats it");
assert.match(click, /browserPrintFallback\(\)/,
  "a blocked viewer tab still has to produce the browser printout");
assert.match(html, /window\.addEventListener\("beforeprint", buildPrintView\)/,
  "Ctrl/Cmd-P keeps rendering the fallback print view");

const builder = functionSource(html, "buildSchedulePdfBlob");
assert.match(builder, /%%EOF/, "the bytes are validated before the viewer ever sees them");
assert.match(builder, /planSchedulePages\(/, "the draw loop must follow the pure plan");
assert.doesNotMatch(builder, /autoTable/,
  "the two-line block layout is hand-drawn; an autotable row would put notes back in a column");

/* ---------- filename ---------- */

const scheduleFilename = new Function("return " + functionSource(html, "scheduleFilename"))();
assert.strictEqual(scheduleFilename("2026-08-21", ""), "Schedule_2026-08-21.pdf");
assert.strictEqual(scheduleFilename("2026-08-21", "Dr. Ruiz"), "Schedule_2026-08-21_Dr_Ruiz.pdf");
assert.strictEqual(scheduleFilename("2026-08-21", "Núñez/Lee"), "Schedule_2026-08-21_Nunez_Lee.pdf",
  "a provider name still has to survive as a plain filename");

/* ---------- pagination ---------- */

const planSchedulePages = new Function("return " + functionSource(html, "planSchedulePages"))();

// Geometry with round numbers: a page holds 100pt of blocks, a bare appointment costs 27pt
// (row 20 + pad 7) and every note line 10pt more.
const geom = { top: 0, contTop: 0, bottom: 100, rowH: 20, contH: 10, noteH: 10, pad: 7, minSplit: 2 };
const plan = (lines) => planSchedulePages(lines.map((n) => ({ noteLines: n })), geom);

// Every note line is drawn exactly once, in order, and no page runs past its bottom.
function audit(pages, lines) {
  const seen = lines.map(() => []);
  pages.forEach((blocks) => {
    let last = -1;
    blocks.forEach((b) => {
      assert.ok(b.y >= geom.top && b.y + b.height <= geom.bottom + 0.001,
        "block " + b.index + " must stay inside the page");
      assert.ok(b.y > last, "blocks must run down the page in order");
      last = b.y;
      for (let i = b.noteFrom; i < b.noteTo; i++) seen[b.index].push(i);
    });
  });
  seen.forEach((got, i) => {
    assert.deepStrictEqual(got, Array.from({ length: lines[i] }, (_, k) => k),
      "appointment " + i + " must print each of its note lines once, in order");
  });
}

const three = plan([0, 0, 0]);
assert.strictEqual(three.length, 1, "three note-less appointments share a page");
assert.deepStrictEqual(three[0].map((b) => b.index), [0, 1, 2]);
assert.deepStrictEqual(three[0].map((b) => b.y), [0, 27, 54], "blocks stack by their own height");
audit(three, [0, 0, 0]);

// 27 + 37 = 64 used; the third needs 47 and only 36 is left — but it fits a fresh page, so it
// moves whole rather than leaving its notes orphaned behind it.
const spill = plan([0, 1, 2]);
assert.deepStrictEqual(spill.map((p) => p.map((b) => b.index)), [[0, 1], [2]],
  "an appointment that fits the next page moves there instead of splitting");
assert.strictEqual(spill[1][0].cont, false, "a moved appointment still prints its own line one");
audit(spill, [0, 1, 2]);

// A single appointment carrying more notes than a page can hold has nowhere to move to, so it
// splits — and the continuation says so instead of repeating line one.
const long = plan([20]);
assert.ok(long.length > 1, "notes longer than a page must split across pages");
assert.strictEqual(long[0][0].cont, false);
assert.ok(long.slice(1).every((p) => p.every((b) => b.cont)), "later pages carry continuations");
audit(long, [20]);

// Room for line one plus a single note line is not enough to start a block at the foot of a
// page: minSplit keeps at least two lines with the header.
const stranded = plan([3, 3]);
assert.deepStrictEqual(stranded.map((p) => p.map((b) => b.index)), [[0], [1]],
  "a header must not be stranded with a lone note line");
audit(stranded, [3, 3]);

assert.deepStrictEqual(planSchedulePages([], geom), [[]],
  "an empty day still gets one page to print its 'no appointments' line on");

/* Page one carries the title block and later pages a one-line continuation header, so the plan
   starts them at different heights instead of leaving a band of white on every page after the
   first. */
const tops = planSchedulePages([{ noteLines: 0 }, { noteLines: 0 }, { noteLines: 0 }],
  Object.assign({}, geom, { top: 40, contTop: 10, bottom: 100 }));
assert.deepStrictEqual(tops.map((p) => p.map((b) => b.y)), [[40, 67], [10]],
  "continuation pages start at contTop, not page one's top");

console.log("schedule print/PDF checks passed");
