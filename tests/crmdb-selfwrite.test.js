/* "Database changed elsewhere" must only fire for a change made ELSEWHERE.
 *
 * The freshness guard decides with the file's lastModified alone: anything newer than the mtime the
 * cache is pinned to counts as another station's edit, and — when this browser also holds unsaved
 * work — raises the three-way conflict prompt. That over-fires on the everyday Schedule -> Report
 * Generator handoff, because the newer mtime is often OUR OWN:
 *
 *   • an autosave whose bookkeeping never landed — the page navigated away between the file write
 *     and the IndexedDB metadata write, so the file moved forward while the recorded base did not;
 *   • OneDrive re-stamping the file after syncing it up, leaving the bytes identical.
 *
 * Both leave the file holding bytes THIS station put there, so there is nothing to reconcile. The
 * store now recognizes its own writes by content signature and re-pins silently, while a genuinely
 * foreign edit still reaches the prompt.
 *
 * Run with:  node tests/crmdb-selfwrite.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

global.showOpenFilePicker = function () {};
global.showSaveFilePicker = function () {};

Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  body: { appendChild: function () {}, removeChild: function () {} },
  createElement: function () { return { style: {}, click: function () {}, remove: function () {}, set href(v) {}, get href() { return ""; } }; }
};

function installIndexedDB() {
  const data = new Map([["kv", new Map()]]);
  function makeTx(storeName) {
    const ops = [];
    const tx = { oncomplete: null, onerror: null, error: null, objectStore: () => store };
    const store = {
      get(k) { const rq = {}; ops.push(() => { rq.result = data.get(storeName).get(k); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
      put(v, k) { const rq = {}; ops.push(() => { data.get(storeName).set(k, v); if (rq.onsuccess) rq.onsuccess(); }); return rq; },
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
  return { get: (k) => data.get("kv").get(k), set: (k, v) => data.get("kv").set(k, v), wipe: () => data.get("kv").clear() };
}
const shared = installIndexedDB();

require("../vendor/crmdb-zip.js");
const STORE = path.resolve(__dirname, "../src/crmdb-store.js");
// A fresh module instance is a fresh page load: new in-memory bundle, metadata reloaded from IndexedDB.
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// A file on OneDrive. `cutAfterWrite` models a page torn down mid-save: the bytes and mtime land,
// but the promise never resolves back into the store, so its metadata write never happens.
// `failWrite` models the file being momentarily unwritable (OneDrive holding it, permission lapsed),
// which is how a working copy comes to sit in IndexedDB with edits the file has never seen.
function makeHandle(bytes, mtime) {
  const h = {
    writes: 0,
    cutAfterWrite: false,
    failWrite: false,
    getFile() { return Promise.resolve({ lastModified: h._mtime, arrayBuffer: () => Promise.resolve(h._bytes.buffer.slice(h._bytes.byteOffset, h._bytes.byteOffset + h._bytes.byteLength)) }); },
    createWritable() {
      if (h.failWrite) return Promise.reject(new Error("the file is busy"));
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() {
          h._bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
          h._mtime += 1000; h.writes++;
          if (h.cutAfterWrite) throw new Error("page unloaded mid-save");
        }
      });
    },
    queryPermission() { return Promise.resolve("granted"); },
    requestPermission() { return Promise.resolve("granted"); }
  };
  h._bytes = bytes; h._mtime = mtime;
  return h;
}

const readSched = async (tab) => JSON.parse(await tab.readText({ prefix: "" }, "schedule.json"));
const writeSched = (tab, obj) => tab.writeFile({ prefix: "" }, "schedule.json", JSON.stringify(obj));

// Bring a station up exactly as a page load does: reopen the working copy, then verify it.
async function reopen(onConflict) {
  const s = newTab();
  let asked = null;
  s.onConflict = (d) => { asked = d; return onConflict || "file"; };
  await s.stored();
  const res = await s.verifyFreshness();
  return { s, res, asked: () => asked };
}

// A station that has opened the database and written to it at least once, so its metadata is
// pinned to the real file the way a working station's is.
async function station() {
  shared.wipe();
  const seed = newTab();
  seed._bundle.clear();
  seed._bundle.set("schedule.json", new Blob([JSON.stringify({ v: "ORIGINAL" })]));
  const h = makeHandle(new Uint8Array(await (await seed._serialize()).arrayBuffer()), 5000);
  shared.set("fileHandle", h);
  seed._setFileHandleForTest(h);
  seed._markAuthoritativeForTest();
  await seed.verifyFreshness();          // pins baseFileMod/signature to the file as an open would
  await writeSched(seed, { v: "ORIGINAL" });
  await seed.saveNow();
  return { h, seed };
}

// Leave the shared working copy holding an edit the file has never received — the state a page
// load has to reason about when it asks "does this browser have unsaved work?".
async function dirtyCache(h, tab, schedule) {
  h.failWrite = true;
  await writeSched(tab, schedule);
  await tab.flush();          // reaches IndexedDB...
  await tab._fileIdle();      // ...and the background write-through fails, so never the file
  h.failWrite = false;
}

// The station's OTHER tab (Schedule, while we sit on the Report Generator) completing a save: new
// bytes on the file, and the signature it recorded in the shared metadata both tabs read.
async function otherTabSaved(h, schedule) {
  const t = newTab();
  t._bundle.clear();
  t._bundle.set("schedule.json", new Blob([JSON.stringify(schedule)]));
  const blob = await t._serialize();
  const ab = await blob.arrayBuffer();
  h._bytes = new Uint8Array(ab);
  h._mtime += 1000;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ab));
  let sig = ""; for (const b of digest) sig += (b < 16 ? "0" : "") + b.toString(16);
  shared.set("fileMeta", { baseFileMod: h._mtime, cacheMatchesFile: true, baseSig: sig, pendingSig: null });
}

async function run() {
  // Background file failures must be visible, retain the working copy, and allow manual retry.
  {
    const { h, seed } = await station();
    const messages = [];
    seed.onStatus = (msg, kind) => messages.push({ msg, kind });
    await dirtyCache(h, seed, { v: 'RETRY-ME' });
    assert.ok(messages.some(m => m.kind === 'warn' && /File save failed/.test(m.msg)));
    assert.strictEqual(seed.hasPendingFileChanges(), true);
    assert.strictEqual((await readSched(seed)).v, 'RETRY-ME');
    await seed.saveNow();
    assert.strictEqual(seed.hasPendingFileChanges(), false);
    assert.ok(messages.some(m => m.kind === 'ok' && /Saved to/.test(m.msg)));
  }
  /* 1. An autosave interrupted before its bookkeeping landed is still OUR write — not a conflict. */
  {
    const { h, seed } = await station();
    await writeSched(seed, { v: "DELETED-A-PATIENT" });
    h.cutAfterWrite = true;
    await seed.flush();                   // returns as soon as IndexedDB has it — the file write runs on
    await seed._fileIdle();               // the background queue, and is cut short before it records itself
    assert.strictEqual(h.writes, 2, "the interrupted save must still have reached the file");

    const { res, asked } = await reopen("file");
    assert.strictEqual(asked(), null,
      "reopening after our own interrupted save must NOT ask which copy wins — the file holds this station's bytes");
    assert.strictEqual(res.decision, "cache");
  }

  /* 2. OneDrive re-stamping the file (identical bytes) while the cache has unsaved edits. */
  {
    const { h, seed } = await station();
    await dirtyCache(h, seed, { v: "UNSAVED-EDIT" });
    h._mtime += 60000;                               // sync engine touches the file, bytes unchanged

    const { s, res, asked } = await reopen("file");
    assert.strictEqual(asked(), null, "an mtime-only touch of identical bytes must not raise a conflict");
    assert.strictEqual(res.decision, "cache");
    assert.strictEqual((await readSched(s)).v, "UNSAVED-EDIT", "the unsaved edit must survive");
  }

  /* 3. Control: a genuinely different copy from another station still raises the prompt. */
  {
    const { h, seed } = await station();
    await dirtyCache(h, seed, { v: "UNSAVED-EDIT" });
    const other = newTab();
    other._bundle.clear();
    other._bundle.set("schedule.json", new Blob([JSON.stringify({ v: "OTHER-STATION" })]));
    h._bytes = new Uint8Array(await (await other._serialize()).arrayBuffer());
    h._mtime += 60000;

    const { s, res, asked } = await reopen("file");
    assert.ok(asked(), "a real cross-station edit must still ask which copy wins");
    assert.strictEqual(res.decision, "file");
    assert.strictEqual((await readSched(s)).v, "OTHER-STATION");
  }

  /* 4. Control: a foreign edit with a CLEAN cache still silently adopts the file. */
  {
    const { h } = await station();
    const other = newTab();
    other._bundle.clear();
    other._bundle.set("schedule.json", new Blob([JSON.stringify({ v: "OTHER-STATION" })]));
    h._bytes = new Uint8Array(await (await other._serialize()).arrayBuffer());
    h._mtime += 60000;

    const { s, res, asked } = await reopen();
    assert.strictEqual(asked(), null, "a clean cache needs no prompt");
    assert.strictEqual(res.decision, "file");
    assert.strictEqual((await readSched(s)).v, "OTHER-STATION");
  }

  /* 5. The two-tab station: the tab we are NOT looking at saves while this one holds edits. Its
        write is no more foreign than our own, and both tabs share the metadata that says so. */
  {
    const { h } = await station();
    const b = newTab();
    await b.stored();
    await b.verifyFreshness();                          // this tab loaded before the other tab saved
    await dirtyCache(h, b, { v: "MY-UNSAVED-EDIT" });
    await otherTabSaved(h, { v: "OTHER-TAB" });

    let asked = null;
    b.onConflict = (d) => { asked = d; return "file"; };
    const res = await b.verifyFreshness();
    assert.strictEqual(asked, null, "the other tab of this same station is not another station");
    assert.strictEqual(res.decision, "cache");
    assert.strictEqual((await readSched(b)).v, "MY-UNSAVED-EDIT", "this tab's unsaved edit must survive");
  }

  /* 6. Same two tabs, but this one has nothing unsaved: the other tab's newer copy is simply loaded,
        exactly as any newer copy would be. Recognizing our own bytes must not freeze a stale view. */
  {
    const { h } = await station();
    const b = newTab();
    await b.stored();
    await b.verifyFreshness();
    await otherTabSaved(h, { v: "OTHER-TAB" });

    let asked = null;
    b.onConflict = (d) => { asked = d; return "file"; };
    const res = await b.verifyFreshness();
    assert.strictEqual(asked, null, "a clean cache needs no prompt");
    assert.strictEqual(res.decision, "file");
    assert.strictEqual((await readSched(b)).v, "OTHER-TAB", "the other tab's newer copy should be loaded");
  }

  console.log("crmdb self-write: this station's own saves are no longer mistaken for another station's — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
