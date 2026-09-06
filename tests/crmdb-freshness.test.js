/* Cross-STATION freshness guard in crmdb-store.js.
 *
 * The .crmdb often lives on OneDrive and is edited from more than one workstation. Each station's
 * browser keeps its OWN IndexedDB working copy, which lingers between visits. Without a guard, a
 * station reopening with an OLD cache can flush it straight over the newer OneDrive file — which is
 * exactly what wiped a schedule moving Monterey Park -> Arcadia. This test pins the behavior:
 *
 *   • file unchanged since the cache's base            -> keep the cache (no needless reload);
 *   • file newer + cache has no unsaved edits          -> the file wins, silently;
 *   • file newer + cache HAS unsaved edits (conflict)  -> ask the page (file / local / backup);
 *   • an unverified session never writes to the file   -> a stale cache can't overwrite OneDrive.
 *
 * Run with:  node tests/crmdb-freshness.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");
if (!global.crypto) global.crypto = require("crypto").webcrypto;
global.window = global;

// canAutosave is computed at module load from these — define them BEFORE requiring the store so the
// desktop (bound-file) code path is exercised.
global.showOpenFilePicker = function () {};
global.showSaveFilePicker = function () {};

// Minimal DOM/nav stubs so the "backup" branch (shareOrDownload -> download) doesn't throw in Node.
// Node 20+ defines a getter-only global.navigator, so it must be replaced rather than assigned.
Object.defineProperty(global, "navigator", { value: {}, configurable: true, writable: true });
global.URL = { createObjectURL: function () { return "blob:x"; }, revokeObjectURL: function () {} };
global.document = {
  body: { appendChild: function () {}, removeChild: function () {} },
  createElement: function () { return { style: {}, click: function () {}, remove: function () {}, set href(v) {}, get href() { return ""; } }; }
};

/* Same tiny in-memory IndexedDB as the multi-tab test. */
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
function newTab() { delete require.cache[STORE]; delete global.CRMWorkspace; return require(STORE); }

// Serialize a schedule into a .crmdb blob using a throwaway module instance.
async function crmdbBlob(scheduleObj) {
  const t = newTab();
  t._bundle.clear();
  t._bundle.set("schedule.json", new Blob([JSON.stringify(scheduleObj)]));
  return t._serialize();
}
async function blobBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }

// A stand-in for a real FileSystemFileHandle bound to a file on OneDrive. Tracks its bytes and
// last-modified time, and bumps the mtime on every write so a write-through is observable.
function makeHandle(bytes, mtime) {
  const h = {
    name: "schedule.crmdb",
    writes: 0,
    getFile() { return Promise.resolve({ lastModified: h._mtime, arrayBuffer: () => Promise.resolve(h._bytes.buffer.slice(h._bytes.byteOffset, h._bytes.byteOffset + h._bytes.byteLength)) }); },
    createWritable() {
      const chunks = [];
      return Promise.resolve({
        write(d) { chunks.push(d); return Promise.resolve(); },
        async close() { h._bytes = new Uint8Array(await new Blob(chunks).arrayBuffer()); h._mtime += 1000; h.writes++; }
      });
    },
    queryPermission() { return Promise.resolve("granted"); },
    requestPermission() { return Promise.resolve("granted"); }
  };
  h._bytes = bytes; h._mtime = mtime;
  return h;
}

const schedOf = async (tab) => JSON.parse(await tab.readText({ prefix: "" }, "schedule.json"));

// Seed IndexedDB as if a station reopened: a stale working copy + its base metadata + a bound handle
// whose file holds a (possibly newer) copy.
async function seedStation({ cache, cacheMod, cacheMatchesFile, file, fileMod }) {
  shared.wipe();
  const cacheBlob = await crmdbBlob(cache);
  shared.set("bundle", cacheBlob);
  shared.set("rev", 1);
  shared.set("fileMeta", { baseFileMod: cacheMod, cacheMatchesFile: cacheMatchesFile });
  const handle = makeHandle(await blobBytes(await crmdbBlob(file)), fileMod);
  shared.set("fileHandle", handle);
  return handle;
}

async function run() {
  assert.strictEqual(newTab().canAutosave, true, "test harness must exercise the desktop autosave path");

  /* 1. File unchanged since the cache's base → keep the cache, don't reload. */
  {
    const h = await seedStation({ cache: { v: "CACHE" }, cacheMod: 5000, cacheMatchesFile: true, file: { v: "FILE" }, fileMod: 5000 });
    const s = newTab(); await s.stored();
    assert.strictEqual(s.isVerified(), false, "a bound-file reopen must start unverified");
    const res = await s.verifyFreshness();
    assert.strictEqual(res.decision, "cache", "unchanged file should keep the cache");
    assert.strictEqual((await schedOf(s)).v, "CACHE");
    assert.strictEqual(s.isVerified(), true);
    assert.strictEqual(h.writes, 0, "verify must never write to the file");
  }

  /* A remembered handle reconnect restores permission and verifies the SAME file without invoking
     the open-file picker. This is the lock/sleep recovery path used by Patient Schedule. */
  {
    const h = await seedStation({ cache: { v: "CACHE" }, cacheMod: 5000, cacheMatchesFile: true, file: { v: "FILE" }, fileMod: 5000 });
    let permissionRequests = 0, pickerCalls = 0;
    h.queryPermission = () => Promise.resolve("prompt");
    h.requestPermission = () => { permissionRequests++; return Promise.resolve("granted"); };
    global.showOpenFilePicker = () => { pickerCalls++; return Promise.reject(new Error("picker should not open")); };
    const s = newTab(); await s.stored();
    assert.strictEqual(s.canReconnect(), true, "remembered desktop handle should be reconnectable");
    const result = await s.reconnect();
    assert.strictEqual(result.decision, "cache", "same unchanged file should keep the working copy");
    assert.strictEqual(permissionRequests, 1, "reconnect should restore permission once");
    assert.strictEqual(pickerCalls, 0, "same-file reconnect must not show the file picker");
  }

  /* 2. File is NEWER and the cache is clean → the file wins, silently. */
  {
    const h = await seedStation({ cache: { v: "STALE" }, cacheMod: 1000, cacheMatchesFile: true, file: { v: "NEWER-ELSEWHERE" }, fileMod: 9000 });
    const s = newTab(); await s.stored();
    const res = await s.verifyFreshness();
    assert.strictEqual(res.decision, "file", "a newer file must win over a clean stale cache");
    assert.strictEqual((await schedOf(s)).v, "NEWER-ELSEWHERE", "the OneDrive file's data should now be loaded");
    assert.strictEqual(h.writes, 0, "adopting the file must not write the stale cache back");
  }

  /* 3. Unverified session must NOT write to the file (the core anti-clobber guard). */
  {
    const h = await seedStation({ cache: { v: "STALE" }, cacheMod: 1000, cacheMatchesFile: true, file: { v: "NEWER" }, fileMod: 9000 });
    const s = newTab(); await s.stored();
    let warning = ""; s.onStatus = (msg, cls) => { if (cls === "warn") warning = msg; };
    await assert.rejects(s.saveNow(), /Reconnect the database/); // before verifyFreshness
    assert.strictEqual(h.writes, 0, "an unverified session wrote to the file — this is the OneDrive-clobber bug");
    assert.match(warning, /only in this browser/i,
      "a blocked explicit save must say that the edits have not reached the database file");
    // After verifying (file wins) and a real edit, a save DOES write through.
    await s.verifyFreshness();
    await s.writeFile({ prefix: "" }, "schedule.json", JSON.stringify({ v: "EDIT-HERE" }));
    await s.saveNow();
    assert.strictEqual(h.writes, 1, "a verified session must write through on save");
  }

  /* 4. Conflict: newer file AND unsaved local edits → ask the page. */
  for (const [choice, expectVal, expectWrites] of [["file", "FILE", 0], ["local", "LOCAL", 0]]) {
    const h = await seedStation({ cache: { v: "LOCAL" }, cacheMod: 1000, cacheMatchesFile: false, file: { v: "FILE" }, fileMod: 9000 });
    const s = newTab();
    let asked = null; s.onConflict = (d) => { asked = d; return choice; };
    await s.stored();
    const res = await s.verifyFreshness();
    assert.ok(asked && asked.fileModified === 9000, "conflict handler should receive the file details for choice=" + choice);
    assert.strictEqual(res.decision, choice);
    assert.strictEqual((await schedOf(s)).v, expectVal, "conflict choice=" + choice + " loaded the wrong copy");
    assert.strictEqual(h.writes, expectWrites, "verify must not write during conflict resolution for choice=" + choice);
    assert.strictEqual(s.isVerified(), true);
  }

  /* 4b. Conflict → "backup": save the local copy aside, then take the file. */
  {
    const h = await seedStation({ cache: { v: "LOCAL" }, cacheMod: 1000, cacheMatchesFile: false, file: { v: "FILE" }, fileMod: 9000 });
    const s = newTab();
    s.onConflict = () => "backup";
    await s.stored();
    const res = await s.verifyFreshness();
    assert.strictEqual(res.decision, "backup");
    assert.strictEqual((await schedOf(s)).v, "FILE", "after a backup, the file should be loaded");
  }

  /* 5. No conflict handler wired → default to the file (never silently keep a stale local copy). */
  {
    await seedStation({ cache: { v: "LOCAL" }, cacheMod: 1000, cacheMatchesFile: false, file: { v: "FILE" }, fileMod: 9000 });
    const s = newTab(); await s.stored();
    const res = await s.verifyFreshness();
    assert.strictEqual(res.decision, "file", "with no handler, a conflict must default to the file");
    assert.strictEqual((await schedOf(s)).v, "FILE");
  }

  /* 6. Manual reconnect with browser-only edits must ask instead of silently ingesting the picked
        file. This is the Schedule startup case: Save was blocked while OneDrive/file permission
        was unavailable, then Open database used to erase the checked Cerner boxes. */
  for (const [choice, expected, pending] of [
    ["file", "PICKED-FILE", false],
    ["backup", "PICKED-FILE", false],
    ["local", "BROWSER-ONLY", true]
  ]) {
    await seedStation({ cache: { v: "BROWSER-ONLY" }, cacheMod: 1000, cacheMatchesFile: false, file: { v: "BOUND-OLD" }, fileMod: 9000 });
    const picked = makeHandle(await blobBytes(await crmdbBlob({ v: "PICKED-FILE" })), 10000);
    global.showOpenFilePicker = () => Promise.resolve([picked]);

    const s = newTab();
    let details = null;
    s.onConflict = (d) => { details = d; return choice; };
    await s.stored();
    await s.connect();

    assert.strictEqual(details && details.reason, "reconnect",
      "manual reconnect must identify the browser-only conflict for choice=" + choice);
    assert.strictEqual((await schedOf(s)).v, expected,
      "manual reconnect loaded the wrong copy for choice=" + choice);
    assert.strictEqual(s.hasPendingFileChanges(), pending,
      "manual reconnect reported the wrong file-save state for choice=" + choice);
    if (choice === "local") {
      assert.strictEqual(picked.writes, 0, "keeping the browser copy must wait for an explicit save before overwriting the file");
      await s.saveNow();
      assert.strictEqual(picked.writes, 1, "Save now must write the kept browser copy after reconnect");
      const checkFile = await picked.getFile();
      const check = newTab(); await check._ingest(new Blob([await checkFile.arrayBuffer()]));
      assert.strictEqual((await schedOf(check)).v, "BROWSER-ONLY", "the post-reconnect save wrote the wrong database");
    }
  }

  console.log("crmdb freshness: a stale station cache can no longer overwrite a newer OneDrive file — passed");
}

run().catch((e) => { console.error(e); process.exit(1); });
