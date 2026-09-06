/* When a staged edit actually gets published.
 *
 * Both pages type into the database all day. A commit re-serializes the whole thing and writes it
 * to the shared working copy, so committing on the typing debounce is what made them hitch. The
 * arrangement now is: edits STAGE (an in-memory write, { defer: true }), and src/crmdb-commit-
 * cadence.js decides when to publish — on a slow cadence, or immediately on any deliberate exit.
 *
 * What must remain true:
 *   • typing costs no serialization at all
 *   • continuous typing cannot starve the cadence — it publishes on schedule, not "once you stop"
 *   • ONE page exit is ONE commit, even though a browser fires up to three teardown events for it
 *   • a page that does its own teardown work claims it, and isn't doubled up by the cadence
 *   • an exit with nothing staged costs nothing
 *   • the deferred write really is staged — readable immediately, and carried by the next commit
 *
 * The last point is the Schedule's path specifically: it writes schedule.json through the virtual
 * file handle, so createWritable({ defer: true }) has to honour the flag the same way writeFile's
 * option does.
 *
 * Run with:  node tests/crmdb-commit-cadence.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };

// A document/window pair we can fire teardown events at, the way a browser does on one page exit.
const listeners = { document: {}, window: {} };
function on(bag, type, fn) { (bag[type] || (bag[type] = [])).push(fn); }
global.document = {
  hidden: false,
  addEventListener: (t, f) => on(listeners.document, t, f),
  body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, click() {}, remove() {}, set href(v) {}, get href() { return ""; } })
};
global.window = global;
global.addEventListener = (t, f) => on(listeners.window, t, f);
// Chrome fires all three for a single close: visibilitychange (hidden), then pagehide, then
// beforeunload. Anything that only claims its work asynchronously will run three times.
function firePageExit() {
  global.document.hidden = true;
  (listeners.document.visibilitychange || []).forEach((f) => f());
  (listeners.window.pagehide || []).forEach((f) => f());
  (listeners.window.beforeunload || []).forEach((f) => f());
  global.document.hidden = false;
}
function resetListeners() { listeners.document = {}; listeners.window = {}; }

function installIndexedDB() {
  let failBundleWrite = false;
  const data = new Map([["kv", new Map()]]);
  function makeTx(storeName) {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { if (k === 'bundle' && failBundleWrite) throw new Error('disk quota'); data.get(storeName).set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      delete(k) { const rq = {}; ops.push(() => { data.get(storeName).delete(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; }
    };
    queueMicrotask(() => {
      try { while (ops.length) ops.shift()(); } catch (e) { tx.error = e; if (tx.onerror) tx.onerror(); return; }
      if (tx.oncomplete) tx.oncomplete();
    });
    return tx;
  }
  global.indexedDB = {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = { objectStoreNames: { contains: (n) => data.has(n) }, createObjectStore: (n) => { if (!data.has(n)) data.set(n, new Map()); return {}; }, transaction: (n) => makeTx(n), close() {} };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    }
  };
  return { wipe: () => data.get("kv").clear(), failWrites: (v) => { failBundleWrite = v; } };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const CRMCadence = require("../src/crmdb-commit-cadence.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// CRMDB.write is the synchronous heart of a serialization, so counting calls counts the expensive
// thing. (Same instrument as crmdb-deferred-write.test.js.)
const realWrite = global.CRMDB.write;
let serializations = 0;
global.CRMDB.write = function () { serializations++; return realWrite.apply(this, arguments); };

const settle = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Each case gets its OWN counter and its own cadence. They used to share one `commits`, and the
// first case's short timer would fire during a later one and be counted against it.
function makeCadence(everyMs) {
  const seen = { commits: 0 };
  seen.cadence = CRMCadence.create({ everyMs: everyMs, commit: () => { seen.commits++; return Promise.resolve(); } });
  return seen;
}

async function cadenceUnit() {
  // A failed publish stays pending, retries without another edit, and never announces success.
  let attempts = 0, successes = 0;
  const retry = CRMCadence.create({ everyMs: 25, commit: () => {
    if (++attempts === 1) throw new Error('temporary failure');
  }, onCommitted: () => successes++ });
  retry.stage();
  await retry.commitNow();
  assert.strictEqual(retry.pending(), true);
  assert.strictEqual(successes, 0);
  await wait(100);
  assert.strictEqual(attempts, 2);
  assert.strictEqual(successes, 1);
  assert.strictEqual(retry.pending(), false);
  // Persistent failures stop retrying but remain pending for explicit Save or another edit.
  let failures = 0;
  const bounded = CRMCadence.create({ everyMs: 20, maxRetries: 1, commit: () => {
    failures++; throw new Error('still unavailable');
  } });
  await assert.rejects(bounded.commitNow({ rethrow: true }), /still unavailable/);
  await wait(100);
  assert.strictEqual(failures, 2);
  assert.strictEqual(bounded.pending(), true);
  bounded.cancel();
  // An explicit cancellation must not be undone by an older in-flight failure.
  let rejectCommit;
  const cancelled = CRMCadence.create({ commit: () => new Promise((_, reject) => { rejectCommit = reject; }) });
  const flight = cancelled.commitNow();
  await settle(); cancelled.cancel(); rejectCommit(new Error('late failure')); await flight;
  assert.strictEqual(cancelled.pending(), false);
  /* ---- typing must not publish, and must not starve the cadence ----
     The upper bound is DERIVED from the clock, not hard-coded: setTimeout has a ~15.6ms floor on
     Windows, so 25 x wait(4) runs ~390ms there and ~100ms on a fast-timer platform. A fixed count
     only ever held on the latter. What the case actually guards is the shape — the cadence keeps
     publishing on schedule under continuous typing (never starved), and no more than about one
     publish per window (not one per keystroke, which is what a restarting timer would give). */
  resetListeners();
  const EVERY = 60;
  const A = makeCadence(EVERY);
  const c = A.cadence;
  const t0 = Date.now();
  for (let i = 0; i < 25; i++) { c.stage(); await wait(4); }   // continuous typing
  const elapsed = Date.now() - t0;
  const most = Math.ceil(elapsed / EVERY) + 1;                 // +1 for window-boundary alignment
  assert.ok(A.commits >= 1, "continuous typing starved the cadence — it never published");
  assert.ok(A.commits <= most,
    "cadence published " + A.commits + " times across " + elapsed + "ms of typing at a " +
    EVERY + "ms interval (at most " + most + " expected) — it is restarting per keystroke");
  c.cancel();   // don't leave a timer running into the cases below

  /* ---- one exit is one commit, across all three teardown events ---- */
  resetListeners();
  const B = makeCadence(100000), c2 = B.cadence;
  c2.attachLeaveHooks(() => false);
  c2.stage();
  firePageExit();
  await settle();
  assert.strictEqual(B.commits, 1, "one page exit produced " + B.commits + " commits");
  assert.strictEqual(c2.pending(), false, "the exit left work still pending");

  /* ---- a page that claims its own teardown work is not doubled up ---- */
  resetListeners();
  let rebuilds = 0;
  const C = makeCadence(100000), c3 = C.cadence;
  let dirty = true;
  c3.attachLeaveHooks(() => {
    if (!dirty) return false;
    dirty = false; c3.cancel(); rebuilds++;    // the synchronous claim both pages make
    return true;
  });
  c3.stage();
  firePageExit();
  await settle();
  assert.strictEqual(rebuilds, 1, "the page rebuilt " + rebuilds + " times for one exit");
  assert.strictEqual(C.commits, 0, "the cadence committed on top of the page's own rebuild");

  /* ---- a page that claims the work but commits ASYNCHRONOUSLY is also not doubled up.
     This is the Schedule's shape: its leave hook stages schedule.json and only reaches
     commitNow() in a .then, so `pending` is still set at the moment the hook returns. Trusting
     `pending` alone here — rather than the page's own answer — would commit twice for one exit. */
  resetListeners();
  const D = makeCadence(100000), c3b = D.cadence;
  let staged = true;
  c3b.attachLeaveHooks(() => {
    if (!staged) return false;
    staged = false;                                     // the synchronous claim
    Promise.resolve().then(() => c3b.commitNow());      // ...but the commit lands later
    return true;
  });
  c3b.stage();
  firePageExit();
  await settle();
  assert.strictEqual(D.commits, 1, "an asynchronously-committing leave hook produced " + D.commits + " commits");

  /* ---- hiding, coming back, editing, and hiding again is a FRESH exit.
     visibilitychange fires every time a tab is switched away from, so this is an ordinary clinic
     day, not an edge case. The claim that stops one exit committing twice must therefore be
     cleared by the next edit, or the second hide would silently commit nothing and the new edit
     would sit unpublished until the cadence got round to it. */
  resetListeners();
  const F = makeCadence(100000), c5 = F.cadence;
  let pageWork = true;
  c5.attachLeaveHooks(() => { if (!pageWork) return false; pageWork = false; c5.cancel(); return true; });
  c5.stage();
  firePageExit();                       // hidden: the page handles it
  await settle();
  assert.strictEqual(F.commits, 0, "the page claimed this exit; the cadence should not have committed");
  c5.stage();                           // ...shown again, edited again
  firePageExit();                       // hidden again, and now the page has nothing of its own
  await settle();
  assert.strictEqual(F.commits, 1, "a second exit after a new edit did not publish it");

  /* ---- leaving an untouched page must cost nothing ---- */
  resetListeners();
  const E = makeCadence(100000), c4 = E.cadence;
  c4.attachLeaveHooks(() => false);
  firePageExit();
  await settle();
  assert.strictEqual(E.commits, 0, "an idle exit committed anyway");
}

async function deferredHandleWrite() {
  shared.wipe();
  resetListeners();
  const tab = newTab();
  await tab.newDatabase();
  await settle();

  // The Schedule's path: schedule.json through the virtual file handle, staged not committed.
  const root = await tab.stored() || (await tab.newDatabase());
  const handle = await root.getFileHandle("schedule.json", { create: true });

  serializations = 0;
  for (let i = 0; i < 12; i++) {
    const w = await handle.createWritable({ defer: true });
    await w.write(JSON.stringify({ dates: { "2026-07-29": [{ pt: "typing " + i }] } }));
    await w.close();
  }
  await wait(1500);   // well past persist()'s own debounce
  assert.strictEqual(serializations, 0,
    "a deferred schedule.json write serialized " + serializations + " times — typing still commits");

  // Staged, therefore readable right away.
  const text = await tab.readText({ prefix: "" }, "schedule.json");
  assert.ok(text.indexOf("typing 11") !== -1, "the staged bytes are not in the working copy");

  // And carried out by the next commit, exactly once.
  shared.failWrites(true);
  await assert.rejects(tab.flush(), /disk quota/);
  assert.ok(tab._journal.size, 'failed IndexedDB commit discarded pending edits');
  shared.failWrites(false);
  serializations = 0;
  await tab.flush();
  await settle();
  assert.strictEqual(serializations, 1, "flush serialized " + serializations + " times, expected 1");

  // An ordinary (non-deferred) write through the same handle must still persist as it always did.
  serializations = 0;
  const w = await handle.createWritable();
  await w.write(JSON.stringify({ dates: {} }));
  await w.close();
  await wait(1500);
  assert.ok(serializations >= 1, "a non-deferred write no longer commits");
}

async function run() {
  await cadenceUnit();
  await deferredHandleWrite();
  console.log("PASS crmdb-commit-cadence");
}

run().catch((e) => { console.error(e); process.exit(1); });
