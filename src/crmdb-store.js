/* crmdb-store.js — shared persistence engine for the .crmdb container model.
 *
 * This is what backs window.CRMWorkspace — the API both the Patient Schedule and the CRM
 * Report Generator call (connect, slotDir, writeFile, readText, listFiles, moveSlot,
 * slotName, stored, permission, forget …). Rather than drive a live folder tree
 * through the File System Access directory API (which iPadOS doesn't have at all), every
 * one of those reads and writes an in-memory bundle:
 *
 *     bundle : Map<path, Blob>     e.g. "schedule.json", "patients/2026-07-13/0800_JS/report.pdf"
 *
 * The bundle is the one database. It is:
 *   • serialized to a single .crmdb file (a standard zip when password protection is
 *     off; an authenticated, locally-encrypted envelope when it is on);
 *   • mirrored to IndexedDB on every change, so navigating between the two pages carries
 *     the working copy across (this is what makes the two-page handoff work on iPad, which
 *     has no File System Access API);
 *   • on desktop (Chrome/Edge) additionally bound to a real .crmdb file handle and
 *     autosaved in place — no button required. On iPad the explicit "Save database
 *     updates" button writes the bundle out through the Files sheet.
 *
 * Requires vendor/crmdb-zip.js to be loaded first (window.CRMDB).
 */
(function () {
  "use strict";

  // The inline Report Generator is a same-origin child of the Schedule. Reuse the host's live
  // workspace instead of ingesting a second complete database bundle into the iframe. Standalone
  // pages and cross-origin/locked-down embeds keep the independent-store path unchanged.
  try {
    if (typeof window !== "undefined" && window.CRM_EMBED === true && window.parent !== window && window.parent.CRMWorkspace) {
      window.CRMWorkspace = window.parent.CRMWorkspace;
      window.CRMWorkspaceUsesHost = true;
      return;
    }
  } catch (e) {}

  var FOLDER = "CRM Toolkit";                 // kept for message continuity
  var DEFAULT_NAME = "schedule.crmdb";
  var hasFSopen = typeof window !== "undefined" && !!window.showOpenFilePicker;
  var hasFSsave = typeof window !== "undefined" && !!window.showSaveFilePicker;
  var canAutosave = hasFSopen && hasFSsave;   // desktop Chrome/Edge

  /* ------------------------------------------------------------------ state */
  var bundle = new Map();     // path -> Blob
  var fileHandle = null;      // desktop FSA handle to the .crmdb, or null (iPad)
  var opened = false;
  var suggestedName = DEFAULT_NAME;
  var persistTimer = null;
  var statusCb = null;        // pages set CRMWorkspace.onStatus = fn(msg, cls)
  var passwordCb = null;      // pages set CRMWorkspace.onPasswordRequest = fn(details)
  var conflictCb = null;      // pages set CRMWorkspace.onConflict = fn(details) -> "file"|"local"|"backup"
  var protection = null;      // { key: CryptoKey, salt: Uint8Array, iterations: number }
  var lastOpenError = null;   // retained so pages can explain a cancelled/failed quiet reopen

  // ---- cross-STATION freshness guard (the OneDrive stale-cache problem) ---------------------
  // The IndexedDB working copy is per-machine and lingers between visits. When the SAME .crmdb
  // lives on OneDrive and is edited from another station, the browser here can reopen holding a
  // cache that is OLDER than the file — and, left unchecked, flush that stale cache straight over
  // the newer file (silently reverting a day's work; this actually happened moving MP → Arcadia).
  //
  // The revision CAS above only orders two TABS on one machine; it says nothing about how this
  // machine's cache compares to a file touched elsewhere. So we additionally pin the cache to the
  // real file's last-modified time:
  //   • baseFileMod       — file.lastModified the cache is based on (persisted with the bundle);
  //   • cacheMatchesFile  — the cache equals what is on the bound file right now (no unsaved edits);
  //   • freshnessVerified — this session has compared the bound file to the cache. Until it is true
  //                         (desktop, file bound) NOTHING is written to the file, so a stale cache
  //                         can never overwrite a newer OneDrive copy before we've looked.
  // On reconnect: file newer than base + clean cache → the file wins; file newer + unsaved edits →
  // a real conflict handed to the page's onConflict.
  //
  // An mtime alone cannot tell WHOSE change it was, and a newer mtime is very often OUR OWN: the
  // page navigates between the file write and the metadata write (the Schedule → Report Generator
  // handoff does this constantly), or OneDrive re-stamps the file after syncing it up. Both used to
  // surface as "Database changed elsewhere" on the very next page. So we also record a content
  // signature of the bytes this station put on the file — before the write (pendingSig, so an
  // interrupted save is still recognizable) and after it (baseSig). A newer file whose bytes we
  // signed is our own work: re-pin and carry on silently. Anything else is a real foreign edit.
  var META_KEY = "fileMeta";
  var baseFileMod = null;         // file.lastModified our cache is based on, or null when unknown
  var cacheMatchesFile = false;   // cache byte-for-byte equals the bound file (no unsaved edits)
  var freshnessVerified = false;  // desktop only: bound file compared to the cache this session
  var baseSig = null;             // signature of what we last read from / wrote to the file ("m2:" manifest sig, or legacy full-byte SHA-256)
  var pendingSig = null;          // signature of bytes a save was about to write when it could be cut short
  var mutSeq = 0;                 // bumped on every bundle mutation, to date a serialized snapshot

  // ---- cross-tab safety ------------------------------------------------------
  // Two same-origin tabs (typically Schedule + Report Generator) each hold their OWN in-memory
  // `bundle`, and a save serializes the WHOLE bundle. A plain write therefore replaces whatever
  // the other tab committed — silently reverting schedule edits, reverting a report, or outright
  // DELETING a file the other tab attached (serialize only emits paths this tab happens to hold).
  //
  // So every commit is a compare-and-swap against a revision counter stored beside the bundle:
  //   • revision unchanged (the normal case, and always when only one tab is open) → straight
  //     write, costing one extra ~0.3ms read of a tiny key;
  //   • revision moved → another tab wrote, so adopt the shared copy and replay only the paths
  //     THIS tab actually touched (`journal`) on top of it.
  // The journal is what makes the merge safe: replaying only touched paths means we never
  // resurrect a file another tab deleted, nor delete one it added.
  var journal = new Map();     // path -> Blob (written) | null (deleted), since the last commit
  var myRev = 0;               // the shared revision this tab's bundle is based on
  var authoritative = false;   // our bundle is a whole new database (opened/created) — overwrite
  var REV_KEY = "rev", BUNDLE_KEY = "bundle", CRC_KEY = "crcs";
  // Record a mutation as well as applying it, so a later rebase can replay it. Any edit means the
  // cache no longer matches the bound file until the next successful write-through.
  function bset(path, blob) { bundle.set(path, blob); journal.set(path, blob); cacheMatchesFile = false; mutSeq++; }
  function bdel(path) { var had = bundle.delete(path); journal.set(path, null); cacheMatchesFile = false; mutSeq++; return had; }
  function applyJournal() {
    journal.forEach(function (blob, path) {
      if (blob === null) bundle.delete(path); else bundle.set(path, blob);
    });
  }
  // Our bundle is a whole database we just opened / created / re-encrypted, so it supersedes the
  // shared copy wholesale instead of merging into it. (Without this, opening a .crmdb would
  // rebase onto — and therefore keep — the working copy it was meant to replace.)
  function markAuthoritative() { journal.clear(); authoritative = true; }

  // Encrypted .crmdb envelope (all fixed-width fields are authenticated as AES-GCM AAD):
  // magic[8] + version[1] + PBKDF2 iterations[4] + salt[16] + iv[12] + ciphertext/tag.
  var ENC_MAGIC = new Uint8Array([67, 82, 77, 68, 66, 69, 78, 67]); // "CRMDBENC"
  var ENC_VERSION = 1;
  var ENC_ITERATIONS = 600000;
  var ENC_HEADER_SIZE = 41;
  var SESSION_UNLOCK_KEY = "crmdbSessionUnlockV1";

  function status(msg, cls) { try { if (statusCb) statusCb(msg, cls); } catch (e) {} }

  function abortError(message) {
    var e = new Error(message || "Password entry cancelled"); e.name = "AbortError"; return e;
  }
  function cryptoApi() {
    var c = (typeof globalThis !== "undefined" && globalThis.crypto) || (typeof window !== "undefined" && window.crypto);
    if (!c || !c.subtle || !c.getRandomValues) throw new Error("Password protection is not supported by this browser");
    return c;
  }
  function isEncryptedBytes(bytes) {
    if (!bytes || bytes.byteLength < ENC_MAGIC.length) return false;
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (var i = 0; i < ENC_MAGIC.length; i++) if (u[i] !== ENC_MAGIC[i]) return false;
    return true;
  }
  // Content signature of one .crmdb's bytes — how we tell our own writes from another station's.
  // Best-effort: a browser without SubtleCrypto simply falls back to the mtime-only comparison.
  // Prefer containerSig below: this one materializes the whole container on the heap to hash it.
  function sigOf(data) {
    var c;
    try { c = cryptoApi(); } catch (e) { return Promise.resolve(null); }
    return Promise.resolve(data instanceof Blob ? data.arrayBuffer() : data)
      .then(function (ab) { return c.subtle.digest("SHA-256", ab); })
      .then(function (digest) {
        var u = new Uint8Array(digest), s = "";
        for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? "0" : "") + u[i].toString(16);
        return s;
      })
      .catch(function () { return null; });
  }
  // The signature every write and reconnect actually uses. Same question as sigOf — "did this
  // machine put these bytes there?" — answered from the container's central directory instead of
  // its bytes: CRMDB.manifest reads a few KB of tail/CD slices, and hashing the per-entry
  // name/crc/size claims identifies the container without ever pulling it onto the JS heap. On a
  // clinic-sized database that turns every autosave's whole-file arrayBuffer() into kilobytes.
  // "m2:"-prefixed so it can never be mistaken for (or collide with) a legacy full-byte sig.
  // Falls back to sigOf for anything the manifest can't describe: an encrypted envelope (its
  // ciphertext has no readable CD — and differs every save anyway, thanks to the random IV), a
  // non-Blob source, or a container we didn't write. NOT a security boundary either way — the
  // sig only recognizes our own writes; confidentiality/integrity stay with AES-GCM.
  function containerSig(blob) {
    if (typeof Blob === "undefined" || !(blob instanceof Blob) || !window.CRMDB || !window.CRMDB.manifest) return sigOf(blob);
    return blob.slice(0, ENC_MAGIC.length).arrayBuffer().then(function (head) {
      if (isEncryptedBytes(new Uint8Array(head))) return sigOf(blob);
      return window.CRMDB.manifest(blob).then(function (entries) {
        if (!entries) return sigOf(blob);
        // Sorted canonical form: identical contents must sign identically regardless of the order
        // the CD happened to list them in. NUL field separators, because attached programmer
        // files keep their original names — which may contain spaces or any other printable
        // character, but never a NUL — so no name can smudge a field boundary.
        var canon = entries.map(function (e) { return e.name + "\u0000" + e.crc + "\u0000" + e.size; }).sort().join("\n");
        return sigOf(new TextEncoder().encode(canon)).then(function (hex) { return hex ? "m2:" + hex : null; });
      });
    }).catch(function () { return sigOf(blob); });
  }
  function deriveMaterial(password, salt, iterations) {
    var c = cryptoApi();
    var encoded = new TextEncoder().encode(String(password));
    return c.subtle.importKey("raw", encoded, "PBKDF2", false, ["deriveBits"]).then(function (baseKey) {
      return c.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt, iterations: iterations }, baseKey, 256);
    }).then(function (raw) {
      return c.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
        .then(function (key) { return { key: key, raw: new Uint8Array(raw) }; });
    });
  }
  function deriveKey(password, salt, iterations) {
    return deriveMaterial(password, salt, iterations).then(function (m) { return m.key; });
  }
  function b64(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function fromB64(value) {
    var s = atob(value), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function rememberSessionKey(raw, salt, iterations) {
    try { sessionStorage.setItem(SESSION_UNLOCK_KEY, JSON.stringify({ key: b64(raw), salt: b64(salt), iterations: iterations })); } catch (e) {}
  }
  function clearSessionKey() { try { sessionStorage.removeItem(SESSION_UNLOCK_KEY); } catch (e) {} }
  function sessionKey(salt, iterations) {
    try {
      var saved = JSON.parse(sessionStorage.getItem(SESSION_UNLOCK_KEY) || "null");
      if (!saved || saved.salt !== b64(salt) || saved.iterations !== iterations) return Promise.resolve(null);
      return cryptoApi().subtle.importKey("raw", fromB64(saved.key), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    } catch (e) { clearSessionKey(); return Promise.resolve(null); }
  }
  function requestPassword(details) {
    if (passwordCb) return Promise.resolve().then(function () { return passwordCb(details); });
    if (typeof window !== "undefined" && window.prompt) return Promise.resolve(window.prompt(details.message || "Database password:"));
    return Promise.reject(new Error("A password is required to open this database"));
  }

  /* ---------------------------------------------------------- small helpers */
  // The embedded Report Generator shares the Schedule's workspace, but values selected or built
  // inside that iframe belong to a different JavaScript realm. `iframeFile instanceof Blob` is
  // false when `Blob` is the parent window's constructor, even though iframeFile is a genuine
  // browser File. Without the brand fallback below, importing a programmer report from the inline
  // editor stores the string "[object File]" and pdf.js later reports "Invalid PDF structure".
  function isBlobLike(data) {
    if (!data) return false;
    if (typeof Blob !== "undefined" && data instanceof Blob) return true;
    var tag;
    try { tag = Object.prototype.toString.call(data); } catch (e) { return false; }
    return (tag === "[object Blob]" || tag === "[object File]")
      && typeof data.size === "number" && typeof data.slice === "function";
  }
  function toBlob(data) {
    if (typeof Blob !== "undefined" && data instanceof Blob) return data;
    // Blob's constructor recognizes genuine Blob/File parts across realms and produces a Blob
    // owned by this (workspace/parent) realm, so it remains safe after the iframe is removed.
    if (isBlobLike(data)) return new Blob([data], { type: data.type || "" });
    if (typeof data === "string") return new Blob([data]);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return new Blob([data]);
    return new Blob([String(data)]);
  }
  function baseName(p) { var i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
  function mimeFor(name) {
    var e = (String(name).split(".").pop() || "").toLowerCase();
    return ({ pdf: "application/pdf", rtf: "application/rtf", txt: "text/plain", log: "text/plain", csv: "text/csv",
      json: "application/json", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", html: "text/html" })[e] || "";
  }

  function slotName(time, pt) {
    var t = String(time || "").replace(/[^0-9]/g, "").slice(0, 4) || "0000";
    if (t.length === 3) t = "0" + t;
    while (t.length < 4) t = t + "0";
    // Patient names remain human-readable in schedule.json. Only the internal folder key is
    // normalized so punctuation, spaces and very long names cannot create unsafe ZIP paths.
    var p = String(pt || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 48) || "XX";
    return t + "_" + p;
  }
  function slotPrefix(date, slot) { return "patients/" + date + "/" + slot + "/"; }

  /* --------------------------------------------------- bundle <-> .crmdb bytes */
  // CRC-32 of a stored file, memoized on the Blob that holds it.
  //
  // A commit re-serializes the WHOLE database, and the ZIP format needs a CRC-32 per entry. Doing
  // that the obvious way — read every Blob, run the JS crc32 loop over every byte — is where
  // essentially all of a commit's main-thread time went: at 53 MB, ~135 ms of a ~145 ms serialize,
  // every time, even when a single note changed. Nothing about an unchanged file's CRC changes
  // between commits, so we only ever compute one once.
  //
  // Keyed on the Blob rather than the path, which is what makes a hit safe to trust:
  //   • Blobs are immutable, so a given Blob's bytes (and CRC) can never change underneath us;
  //   • bset() installs a NEW Blob whenever a file's content changes, so changed content always
  //     misses and is re-CRC'd;
  //   • moveSlot/moveDate re-key the SAME Blob under a new path, and a CRC covers content only,
  //     so a rename correctly keeps its memo instead of paying for the file again.
  // A WeakMap means pruned or replaced files drop out of the memo on their own.
  var crcCache = (typeof WeakMap !== "undefined") ? new WeakMap() : null;
  // The memoized CRC, or null when this Blob has not been hashed yet. Separate from crcOf because
  // the answer being available WITHOUT a promise is the whole point on the common path — see
  // serializeZip. (0 is a real CRC — the empty file's — so null, not falsiness, is the sentinel.)
  function crcHit(blob) { return (crcCache && crcCache.has(blob)) ? crcCache.get(blob) : null; }
  function crcOf(blob) {
    var hit = crcHit(blob);
    if (hit !== null) return Promise.resolve(hit);
    return blob.arrayBuffer().then(function (ab) {
      var crc = window.CRMDB.crc32(new Uint8Array(ab));
      if (crcCache) crcCache.set(blob, crc);
      return crc;
    });
  }
  // Restore the CRC memo for a bundle we have just ingested. `crcs` was written in the SAME
  // IndexedDB transaction as the bytes it describes, so path -> crc is exactly right for these
  // entries. Without it the first commit after every page load re-hashes the whole database:
  // ingest hands back fresh Blob objects and the memo is keyed on Blob identity, so every entry
  // would miss. (Skipped for an encrypted container, which never round-trips these bytes.)
  function seedCrcs(crcs) {
    if (!crcCache || !crcs) return;
    bundle.forEach(function (blob, path) {
      var c = crcs[path];
      if (typeof c === "number") crcCache.set(blob, c);
    });
  }
  function buildZip() {
    var entries = [
      { name: "manifest.json", data: JSON.stringify({ type: "crm-workspace-bundle", version: 1, modified: new Date().toISOString(), fileCount: bundle.size }, null, 2) }
    ];
    if (!bundle.has("schedule.json")) entries.push({ name: "schedule.json", data: JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2) });
    // Walk the bundle ONCE, synchronously, capturing each Blob as we go. Each entry hands
    // CRMDB.write the Blob ITSELF plus its CRC, so the bytes are never read or copied here — the
    // output Blob just references them.
    //
    // Taking the Blobs up front also snapshots the bundle: the CRC pass below can await, and an
    // edit landing mid-serialize must not change what this snapshot contains (commit() dates it
    // with mutSeq on exactly that assumption).
    var misses = [];
    bundle.forEach(function (blob, path) {
      var entry = { name: path, data: blob, crc: crcHit(blob) };
      entries.push(entry);
      if (entry.crc === null) misses.push(entry);
    });
    function finish() {
      // The CRCs of exactly the entries this container holds, so an ingest of these same bytes can
      // restore the memo rather than re-hash the database. Built from `entries`, not from the live
      // bundle, so an edit landing during the CRC pass above can't put a wrong CRC under a path.
      var crcs = {};
      entries.forEach(function (e) { if (typeof e.crc === "number") crcs[e.name] = e.crc; });
      return { blob: window.CRMDB.write(entries), crcs: crcs };
    }
    // Every CRC already memoized — the overwhelmingly common case, since only changed content
    // misses — so there is nothing to await and the whole serialize stays in one synchronous turn.
    if (!misses.length) return Promise.resolve(finish());
    return misses.reduce(function (p, entry) {
      return p.then(function () { return crcOf(entry.data).then(function (crc) { entry.crc = crc; }); });
    }, Promise.resolve()).then(finish);
  }
  function serializeZip() { return buildZip().then(function (r) { return r.blob; }); }
  function encryptZip(blob) {
    if (!protection) return Promise.resolve(blob);
    var c = cryptoApi(), iv = new Uint8Array(12); c.getRandomValues(iv);
    var header = new Uint8Array(ENC_HEADER_SIZE);
    header.set(ENC_MAGIC, 0); header[8] = ENC_VERSION;
    new DataView(header.buffer).setUint32(9, protection.iterations, false);
    header.set(protection.salt, 13); header.set(iv, 29);
    return blob.arrayBuffer().then(function (plain) {
      return c.subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: header, tagLength: 128 }, protection.key, plain);
    }).then(function (ciphertext) { return new Blob([header, ciphertext], { type: "application/octet-stream" }); });
  }
  function serialize() { return serializeZip().then(encryptZip); }
  // serialize() plus the CRC map for the container it produced — what commit() publishes.
  function serializeForCommit() {
    return buildZip().then(function (r) {
      return encryptZip(r.blob).then(function (out) {
        // An encrypted container is re-read by decrypting it whole, never through the by-reference
        // path, so a stored memo would only ever be dead weight there.
        return { blob: out, crcs: protection ? null : r.crcs };
      });
    });
  }

  function decryptEnvelope(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    if (bytes.length <= ENC_HEADER_SIZE || bytes[8] !== ENC_VERSION) return Promise.reject(new Error("Unsupported encrypted database format"));
    var iterations = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(9, false);
    if (iterations < 10000 || iterations > 10000000) return Promise.reject(new Error("Invalid encrypted database header"));
    var salt = bytes.slice(13, 29), iv = bytes.slice(29, 41), header = bytes.slice(0, ENC_HEADER_SIZE);
    var ciphertext = bytes.slice(ENC_HEADER_SIZE), retry = false;
    function decryptWith(key) {
      return cryptoApi().subtle.decrypt({ name: "AES-GCM", iv: iv, additionalData: header, tagLength: 128 }, key, ciphertext)
        .then(function (plain) { protection = { key: key, salt: salt, iterations: iterations }; return plain; });
    }
    function attempt() {
      return requestPassword({ action: "unlock", retry: retry, fileName: suggestedName,
        message: retry ? "Incorrect password. Try again:" : "Enter the password for " + (suggestedName || "this database") + ":" })
        .then(function (password) {
          if (password === null || password === undefined) throw abortError();
          return deriveMaterial(password, salt, iterations).then(function (material) {
            return decryptWith(material.key).then(function (plain) {
              rememberSessionKey(material.raw, salt, iterations);
              return plain;
            });
          });
        }).catch(function (e) {
          if (e && e.name === "AbortError") throw e;
          if (e && (e.name === "OperationError" || e.name === "DataError")) { retry = true; return attempt(); }
          throw e;
        });
    }
    return sessionKey(salt, iterations).then(function (key) {
      if (!key) return attempt();
      return decryptWith(key).catch(function () { clearSessionKey(); return attempt(); });
    });
  }
  // A Blob source goes through CRMDB.readBlob, which hands back each entry as a view onto the SAME
  // backing bytes instead of a copy — so re-reading the working copy costs a couple of kilobytes
  // rather than the database three times over (once as an ArrayBuffer, once per entry's copy, once
  // per entry's Blob). An ArrayBuffer source still uses read(); by then the bytes are in memory
  // anyway, which is exactly the decrypted-envelope case.
  function ingestZip(source) {
    var isBlob = (typeof Blob !== "undefined") && (source instanceof Blob);
    return (isBlob ? window.CRMDB.readBlob(source) : window.CRMDB.read(source)).then(function (entries) {
      bundle.clear();
      entries.forEach(function (e) {
        if (e.name === "manifest.json") return;
        bundle.set(e.name, e.blob || new Blob([e.data]));
      });
      if (!bundle.has("schedule.json")) bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
      opened = true;
    });
  }
  function ingest(source) {
    if ((typeof Blob !== "undefined") && (source instanceof Blob)) {
      // Only the magic is needed to tell the two container shapes apart — a few bytes, not the file.
      return source.slice(0, ENC_MAGIC.length).arrayBuffer().then(function (head) {
        if (!isEncryptedBytes(new Uint8Array(head))) { protection = null; return ingestZip(source); }
        // Encrypted: AES-GCM has to authenticate the whole envelope at once, so there is nothing to
        // stream here and nothing the by-reference path could save.
        return source.arrayBuffer().then(decryptEnvelope).then(ingestZip);
      });
    }
    var bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (isEncryptedBytes(bytes)) return decryptEnvelope(ab).then(ingestZip);
    protection = null;
    return ingestZip(ab);
  }

  function verifyPassword(password) {
    if (!protection) return Promise.resolve(true);
    return deriveKey(password, protection.salt, protection.iterations).then(function (candidate) {
      var c = cryptoApi(), iv = new Uint8Array(12), sample = new Uint8Array([67, 82, 77, 68, 66]); c.getRandomValues(iv);
      return c.subtle.encrypt({ name: "AES-GCM", iv: iv }, candidate, sample)
        .then(function (cipher) { return c.subtle.decrypt({ name: "AES-GCM", iv: iv }, protection.key, cipher); })
        .then(function () { return true; }, function () { throw new Error("Incorrect password"); });
    });
  }

  // Re-encryption rewrites the whole database, so these three adopt any other tab's work first
  // and then publish authoritatively. Order matters: ingest() resets `protection` from the
  // envelope it reads, so the new key can only be installed AFTER adopting.
  function enableProtection(password) {
    if (!opened) return Promise.reject(new Error("Open a database first"));
    if (!password) return Promise.reject(new Error("Password cannot be empty"));
    var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
    return adoptShared()
      .then(function () { return deriveMaterial(password, salt, ENC_ITERATIONS); })
      .then(function (material) {
        protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
        rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
        markAuthoritative();
        return flush();
      }).then(function () { status("Password protection enabled · save the database", "ok"); return true; });
  }
  function changePassword(currentPassword, newPassword) {
    if (!protection) return Promise.reject(new Error("This database is not password protected"));
    if (!newPassword) return Promise.reject(new Error("New password cannot be empty"));
    return verifyPassword(currentPassword).then(function () {
      var c = cryptoApi(), salt = new Uint8Array(16); c.getRandomValues(salt);
      return adoptShared()
        .then(function () { return deriveMaterial(newPassword, salt, ENC_ITERATIONS); })
        .then(function (material) {
          protection = { key: material.key, salt: salt, iterations: ENC_ITERATIONS };
          rememberSessionKey(material.raw, salt, ENC_ITERATIONS);
          markAuthoritative();
          return flush();
        });
    }).then(function () { status("Database password changed · save the database", "ok"); return true; });
  }
  function disableProtection(password) {
    if (!protection) return Promise.resolve(false);
    return verifyPassword(password).then(function () {
      return adoptShared().then(function () {
        protection = null;
        clearSessionKey();
        markAuthoritative();
        return flush();
      });
    }).then(function () { status("Password protection removed · save the database", "ok"); return true; });
  }

  /* -------------------------------------------------------------- IndexedDB */
  function idb() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === "undefined") return rej(new Error("no idb"));
      var r = indexedDB.open("crmdbStore", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("kv"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbSet(k, v) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(v, k);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () {});
  }
  function idbGet(k) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readonly"); var rq = tx.objectStore("kv").get(k);
        rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); };
      });
    }).catch(function () { return undefined; });
  }
  function idbDel(k) {
    return idb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").delete(k);
        tx.oncomplete = function () { res(); }; tx.onerror = function () { res(); };
      });
    }).catch(function () {});
  }
  // Persist the freshness metadata beside the bundle so a later session (a reopen at this station)
  // can tell whether its cache is stale relative to the file.
  //
  // The signature list is MERGED inside the transaction rather than overwritten. Commits and file
  // writes now run on separate queues, so their metadata writes can land in either order; losing a
  // signature that way would make one of this station's own writes look foreign on the next open.
  // The scalars stay last-write-wins: a stale mtime only costs a content check, and a wrongly-clean
  // cacheMatchesFile is already prevented by the mutation-counter check in writeThroughToFile.
  var SIG_RING = 8;
  function mergeSigs(prev) {
    var out = [];
    [baseSig, pendingSig].concat(Array.isArray(prev) ? prev : []).forEach(function (s) {
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out.slice(0, SIG_RING);
  }
  function persistMeta() {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
        var rq = st.get(META_KEY);
        rq.onsuccess = function () {
          var prev = (rq.result && typeof rq.result === "object") ? rq.result : {};
          st.put({
            baseFileMod: baseFileMod, cacheMatchesFile: cacheMatchesFile,
            baseSig: baseSig, pendingSig: pendingSig,
            sigs: mergeSigs(prev.sigs || [prev.baseSig, prev.pendingSig])
          }, META_KEY);
        };
        tx.oncomplete = function () { res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    }).catch(function () {});
  }
  function loadMeta() {
    return idbGet(META_KEY).then(function (m) {
      if (m && typeof m === "object") {
        baseFileMod = (m.baseFileMod == null ? null : m.baseFileMod);
        cacheMatchesFile = !!m.cacheMatchesFile;
        baseSig = m.baseSig || null;
        pendingSig = m.pendingSig || null;
      } else { baseFileMod = null; cacheMatchesFile = false; baseSig = null; pendingSig = null; }
    });
  }

  // Publish the bundle only if the shared revision is still what we based our work on. The
  // re-read and both puts ride in ONE readwrite transaction, so a tab that commits while we were
  // busy serializing loses the race here rather than silently clobbering.
  //   → { ok:true, rev }        committed
  //   → { ok:false }            another tab moved the revision; caller rebases and retries
  //   → { ok:true, noIdb:true } no IndexedDB (Node / private mode) — nothing to race with
  function idbCas(expectedRev, blob, crcs) {
    if (typeof indexedDB === "undefined") return Promise.resolve({ ok: true, noIdb: true });
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
        var rq = st.get(REV_KEY), wrote = false;
        rq.onsuccess = function () {
          if ((Number(rq.result) || 0) !== expectedRev) return;   // conflict: complete without writing
          st.put(blob, BUNDLE_KEY);
          // Same transaction as the bytes, deliberately: a CRC map that could outlive the bundle it
          // describes would hand a later ingest the wrong CRC for a path, and silently corrupt the
          // container it writes next.
          st.put(crcs || {}, CRC_KEY);
          st.put(expectedRev + 1, REV_KEY);
          wrote = true;
        };
        tx.oncomplete = function () { res(wrote ? { ok: true, rev: expectedRev + 1 } : { ok: false }); };
        tx.onerror = function () { rej(tx.error); };
        tx.onabort = function () { rej(tx.error || new Error("Browser database save was aborted")); };
      });
    });
  }

  /* ------------------------------------------------------------- persistence */
  // Replace our bundle with the shared working copy, then replay this tab's un-committed edits
  // on top so adopting another tab's work never drops our own.
  function adoptShared() {
    return idbGet(REV_KEY).then(function (r) {
      return idbGet(BUNDLE_KEY).then(function (blob) {
        if (!blob) return ROOT;
        return idbGet(CRC_KEY).then(function (crcs) {
          return ingest(blob).then(function () {     // the Blob itself: by-reference, no full read
            // Strictly BEFORE applyJournal. The map describes the shared bundle's blobs; replaying
            // the journal first would put this tab's own (different) blob under a path the map has
            // a CRC for, and seeding that CRC onto it would write a container whose checksums lie.
            seedCrcs(crcs);
            applyJournal();
            myRev = Number(r) || 0;
            opened = true;
            return ROOT;
          });
        });
      });
    });
  }

  // Saving is commit → file write → metadata write, and two of those running at once interleave
  // their metadata writes: the Schedule's patient-file delete and its schedule.json save both
  // flush, and the slower one's "unsaved edits" flag could land AFTER the faster one's "saved, file
  // is at mtime N" — leaving IndexedDB describing a state that never existed. So each half runs
  // strictly serially. They are separate queues because only one of them is worth waiting for:
  //
  //   • commitChain — serialize + publish to IndexedDB. This is the entire handoff between the two
  //     pages, so it is what a navigation waits on.
  //   • fileChain  — the write-through to the .crmdb itself: a multi-megabyte write to a synced
  //     OneDrive file. Nothing a user is waiting on needs it to have finished. A write cut short by
  //     navigation is recognized by signature on the next open rather than mistaken for another
  //     station's, and verifyFreshness catches the file up as soon as any page comes back.
  //
  // Keeping them apart is what stops a background file write from delaying the next page.
  var commitChain = Promise.resolve(), fileChain = Promise.resolve();
  function noop() {}
  function enqueueCommit(fn) {
    var run = commitChain.then(fn, fn);
    commitChain = run.then(noop, noop);
    return run;
  }
  function enqueueFile(fn) {
    var run = fileChain.then(fn, fn);
    fileChain = run.then(noop, noop);
    return run;
  }

  // The one write path. Rebases onto the shared copy when another tab has committed, then
  // compare-and-swaps. Returns { blob, seq } for the committed copy, or null when there was
  // nothing to write. `seq` dates the snapshot, so a later write-through can tell whether the
  // bundle moved on while it was busy.
  var COMMIT_RETRIES = 3;
  function commit() {
    // Nothing of ours to publish: don't touch the shared copy at all. This is what stops an
    // idle tab's flush (e.g. on navigation) from re-publishing its stale bundle over newer work.
    if (!opened) return Promise.resolve(null);
    if (!journal.size && !authoritative) return Promise.resolve(null);
    var tries = 0;
    function attempt() {
      return idbGet(REV_KEY).then(function (r) {
        var shared = Number(r) || 0;
        // authoritative = we just opened/created a whole database; ours is the truth by intent.
        var stale = !authoritative && journal.size && shared !== myRev;
        return (stale ? adoptShared() : Promise.resolve()).then(function () {
          var seq = mutSeq;                        // what this snapshot contains
          return serializeForCommit().then(function (s) {
            var blob = s.blob;
            return idbCas(shared, blob, s.crcs).then(function (res) {
              if (!res.ok) {                       // another tab committed mid-serialize
                if (++tries >= COMMIT_RETRIES) throw new Error("Database is busy in another tab. Save again.");
                return attempt();
              }
              if (!res.noIdb) myRev = res.rev;
              journal.clear();
              authoritative = false;
              // Persist the freshness flags alongside the committed bundle so a later reopen knows
              // whether this cache carries edits the bound file doesn't have yet.
              return persistMeta().then(function () { return { blob: blob, seq: seq }; });
            });
          });
        });
      });
    }
    return attempt();
  }

  // Write the committed bytes out to the bound .crmdb (desktop autosave only).
  // opts: { loud } narrates through onStatus, { rethrow } lets the caller report the failure.
  // Resolves true when the bytes actually reached the file.
  function writeThroughToFile(blob, seq, opts) {
    opts = opts || {};
    if (!blob || !fileHandle || !canAutosave) return Promise.resolve(false);
    // Never write to the file until this session has confirmed our cache isn't an older copy than
    // what's on disk. This is the guard that stops a stale station cache clobbering newer OneDrive
    // data before the reconnect freshness check has had a chance to run.
    if (!freshnessVerified) {
      status("Save blocked — these edits are only in this browser. Reconnect the database and choose which copy to keep.", "warn");
      if (opts.rethrow) return Promise.reject(new Error("Reconnect the database before saving"));
      return Promise.resolve(false);
    }
    return containerSig(blob).then(function (sig) {
      // Sign the bytes BEFORE they go out. If this page is torn down between the file write and the
      // metadata write below — which is exactly what navigating to the other page does — the next
      // session still recognizes the file as our own doing instead of another station's edit.
      pendingSig = sig;
      return persistMeta();
    })
      .then(function () { return fileHandle.createWritable(); })
      .then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
      .then(function () { return fileHandle.getFile(); })
      // We are now the file's contents, so pin the base to the file's fresh mtime.
      .then(function (f) {
        baseFileMod = f.lastModified;
        baseSig = pendingSig; pendingSig = null;
        // Only clean if nothing edited the bundle while we were serializing and writing; otherwise
        // those edits are real unsaved work and the next save must carry them out.
        cacheMatchesFile = (seq == null || seq === mutSeq);
        return persistMeta();
      })
      .then(function () { if (opts.loud && cacheMatchesFile) status("Saved to " + suggestedName + " ✓", "ok"); return true; })
      .catch(function (e) {
        // pendingSig deliberately survives a failure: the write may still have landed, and it only
        // ever serves to recognize our own bytes.
        if (opts.rethrow) throw e;
        status("File save failed — changes remain in this browser. Reconnect the database or try Save now. " + e.message, "warn");
        return false;
      });
  }

  // Every write goes here: commit to the shared IndexedDB copy and, on desktop, autosave to the
  // bound .crmdb file — both debounced so bursts of edits coalesce.
  function persist() {
    if (!opened) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      enqueueCommit(function () {
        return commit().then(function (c) {
          if (!c) return;
          if (fileHandle && canAutosave) { writeToFileInBackground(c); return; }
          status("Unsaved — tap Save database updates", "warn");
        });
      }).catch(function (e) { status("Browser save failed — keep this page open and try Save now. " + e.message, "warn"); });
    }, 1200);
  }

  // Hand the committed bytes to the file queue and DON'T wait: autosave and page handoffs have no
  // reason to block on a multi-megabyte OneDrive write. Losing it to a page teardown is safe — the
  // signature written before the write identifies it on the next open, and catchUpFile finishes the
  // job when a page comes back.
  var pendingBackgroundWrite = null, backgroundWriteQueued = false;
  function writeToFileInBackground(c, loud) {
    if (!c || !c.blob || !fileHandle || !canAutosave) return;
    // Every blob is a complete database snapshot. If OneDrive is slower than the edit cadence,
    // intermediate snapshots have no value yet retain one database-sized Blob each. Keep only the
    // newest pending snapshot; the active write finishes, then the queue catches up once.
    pendingBackgroundWrite = { blob: c.blob, seq: c.seq, loud: true };
    if (backgroundWriteQueued) return;
    backgroundWriteQueued = true;
    enqueueFile(function drainBackgroundWrites() {
      var next = pendingBackgroundWrite;
      pendingBackgroundWrite = null;
      if (!next) { backgroundWriteQueued = false; return false; }
      return writeThroughToFile(next.blob, next.seq, { loud: next.loud })
        .then(drainBackgroundWrites, drainBackgroundWrites);
    });
  }

  // Flush the working copy to IndexedDB immediately, and start (but don't await) the file write —
  // NO download. Used before navigating between the two pages: the shared IndexedDB copy IS the
  // handoff, so that is all the navigation has to wait for.
  function flush() {
    clearTimeout(persistTimer);
    if (!opened) return Promise.resolve();
    return enqueueCommit(function () {
      return commit().then(function (c) {
        if (!c) return false;
        writeToFileInBackground(c);
        return true;
      });
    });
  }

  // The file can legitimately be behind the working copy: a write cut short by navigation, or one
  // still queued when the page went away. Any page that has just verified itself finishes the job,
  // in the background, so the .crmdb never stays behind for long.
  function catchUpFile() {
    if (!opened || cacheMatchesFile || !freshnessVerified || !fileHandle || !canAutosave) return;
    enqueueFile(function () {
      var seq = mutSeq;
      return serialize().then(function (blob) { return writeThroughToFile(blob, seq, {}); })
        .catch(function () { return false; });
    });
  }

  // Refresh this tab's in-memory bundle from the latest IndexedDB working copy. Schedule uses
  // this after another open tab commits a newer revision, preventing stale-tab overwrites.
  function reloadWorkingCopy() { return adoptShared(); }

  /* -------------------------------------------------- cross-station freshness check */
  function backupStamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  // Serialize the CURRENT cache (before we discard it) and hand it to the user as a separate file,
  // so a conflicting local copy is never simply thrown away.
  function backupCurrentCache() {
    return serialize().then(function (blob) {
      var base = (suggestedName || DEFAULT_NAME).replace(/\.crmdb$/i, "");
      return shareOrDownload(blob, base + ".conflict-" + backupStamp() + ".crmdb");
    });
  }
  // Every signature that means "this machine put those bytes there": ours, plus whatever is on the
  // shared metadata right now. The other tab may have saved since we loaded, and its write is no
  // more foreign than our own — reading the shared copy is what keeps a two-tab station from
  // reporting its own saves as another station's edits.
  function knownSigs() {
    return idbGet(META_KEY).then(function (m) {
      var sigs = [baseSig, pendingSig];
      if (m && typeof m === "object") sigs = sigs.concat(m.baseSig, m.pendingSig, m.sigs || []);
      return sigs.filter(Boolean);
    });
  }
  // Work out whose bytes are on the bound file: `own` when some save from this machine produced
  // them (including one cut short before it could record itself), false when this is a copy no
  // station of ours has ever written — i.e. genuinely someone else's. `src` is what an adopt
  // should ingest — the File itself when it is a real Blob, so ingest can go by reference (the
  // same zero-copy path the iPad open uses) instead of materializing the whole database.
  function readFile(f) {
    // No Blob constructor at all (bare runtime): the old full-read path, bytes and all.
    if (typeof Blob === "undefined") {
      return f.arrayBuffer().then(function (ab) {
        return sigOf(ab).then(function (sig) {
          return knownSigs().then(function (sigs) {
            return { src: ab, sig: sig, own: !!sig && sigs.indexOf(sig) >= 0 };
          });
        });
      });
    }
    // A handle whose getFile() gives something Blob-less (the Node tests' stand-ins) is wrapped
    // into one, so it signs IDENTICALLY to the write side — which always signs a real Blob. Two
    // formats for the same bytes would make a station disown its own save.
    var asBlob = (f instanceof Blob) ? Promise.resolve(f)
               : f.arrayBuffer().then(function (ab) { return new Blob([ab]); });
    return asBlob.then(function (b) { return readBlobFile(b); });
  }
  function readBlobFile(f) {
    return containerSig(f).then(function (sig) {
      return knownSigs().then(function (sigs) {
        if (sig && sigs.indexOf(sig) >= 0) return { src: f, sig: sig, own: true };
        // Migration: metadata written before manifest signatures existed holds full-byte sigs
        // (bare hex, no "m2:"). A mismatch against those proves nothing, so pay for one legacy
        // hash of the file and compare again. Skipped once the ring holds only m2 sigs — and
        // skipped when OUR sig is already legacy-format (encrypted container), because then the
        // comparison above was legacy-vs-legacy and the answer is final.
        var hasLegacy = sigs.some(function (s) { return !/^m2:/.test(s); });
        if (!hasLegacy || !/^m2:/.test(sig || "")) return { src: f, sig: sig, own: false };
        return sigOf(f).then(function (old) {
          return { src: f, sig: sig, own: !!old && sigs.indexOf(old) >= 0 };
        });
      });
    });
  }
  // Replace our cache with the file's bytes and publish it as the authoritative working copy.
  function adoptFile(f, info) {
    return (info ? Promise.resolve(info) : readFile(f)).then(function (i) {
      return ingest(i.src).then(function () {
        markAuthoritative();
        baseFileMod = f.lastModified; cacheMatchesFile = true; freshnessVerified = true;
        baseSig = i.sig; pendingSig = null;
        return persistMeta().then(function () { return commit(); });
      });
    });
  }
  // A true conflict: the file moved AND our cache has unsaved edits. Ask the page which wins.
  function resolveConflict(f, info, reason) {
    var details = { fileName: suggestedName, fileModified: f.lastModified, reason: reason || "freshness" };
    var ask = conflictCb ? Promise.resolve().then(function () { return conflictCb(details); })
                         : Promise.resolve("file");   // no handler wired → safest default is the file
    return ask.then(function (choice) {
      if (choice === "local") {
        // Keep our cache and let it overwrite the file on the next save. Reconcile the base so we
        // don't re-prompt, and leave it marked dirty-vs-file so a save is actually written out.
        baseFileMod = f.lastModified; cacheMatchesFile = false; freshnessVerified = true;
        baseSig = (info && info.sig) || null; pendingSig = null;
        markAuthoritative();
        return persistMeta().then(function () { return { decision: "local" }; });
      }
      if (choice === "backup") {
        return backupCurrentCache().then(function () { return adoptFile(f, info); }).then(function () { return { decision: "backup" }; });
      }
      return adoptFile(f, info).then(function () { return { decision: "file" }; });   // "file" / anything else
    });
  }
  // Compare the bound file to our cache and settle who is authoritative. Desktop-only; everything
  // without a real file handle (iPad, Node) is trivially "fresh" — the cache IS the database there.
  // Rejects if the file can't be read yet (permission not granted), leaving freshnessVerified false
  // so autosave stays blocked until a real reconnect.
  function verifyFreshness() {
    if (!fileHandle || !canAutosave) { freshnessVerified = true; return Promise.resolve({ decision: "cache" }); }
    // Queued behind any file write still in flight, so we never compare against a file mid-write.
    return enqueueFile(function () {
      return fileHandle.getFile().then(function (f) {
        // File unchanged since our cache was based on it → the cache is at least as new. Trust it.
        if (baseFileMod != null && f.lastModified <= baseFileMod) {
          freshnessVerified = true;
          if (!pendingSig) return { decision: "cache" };
          pendingSig = null;                                  // that save never reached the file
          return persistMeta().then(function () { return { decision: "cache" }; });
        }
        // The mtime moved. Before calling that another station's work, check whose bytes are there.
        return readFile(f).then(function (info) {
          if (info.own) {
            // Bytes this machine put there: an autosave whose bookkeeping was cut short by
            // navigation, the other tab's save, or OneDrive re-stamping the file after syncing it
            // up. Never a conflict — but if they came from the other tab (a signature we know that
            // isn't the one our cache is pinned to) and we hold nothing unsaved, load them, the way
            // any newer copy would be loaded.
            if (info.sig !== baseSig && cacheMatchesFile) {
              return adoptFile(f, info).then(function () { return { decision: "file" }; });
            }
            // Otherwise just re-pin. Local edits stay pending (cacheMatchesFile untouched) so the
            // next save still carries them out to the file.
            baseFileMod = f.lastModified;
            baseSig = info.sig; pendingSig = null;
            freshnessVerified = true;
            return persistMeta().then(function () { return { decision: "cache" }; });
          }
          // File is newer than the state our cache was based on (edited from another station, or a
          // OneDrive sync brought a newer copy down). No unsaved edits here → the file simply wins.
          if (cacheMatchesFile) return adoptFile(f, info).then(function () { return { decision: "file" }; });
          // Newer file AND unsaved local edits → real conflict.
          return resolveConflict(f, info);
        });
      });
    }).then(function (res) {
      catchUpFile();   // outside the queued step: it enqueues its own write behind this one
      return res;
    });
  }

  // Explicit save (the separate button). Desktop: flush to file now. iPad: download.
  function saveNow() {
    if (!opened) return Promise.resolve();
    clearTimeout(persistTimer);
    // Goes through the same rebase + compare-and-swap as any other save. When we have nothing of
    // our own to publish, adopt the shared copy first so Save writes the NEWEST bytes to the
    // USB/file rather than this tab's possibly-stale ones.
    // Unlike a navigation flush, this one is AWAITED all the way to the file: pressing Save (or
    // Leave Station) is a promise that the bytes are on disk before it reports success.
    return enqueueCommit(function () {
      return commit().then(function (c) {
        if (c) return c;
        var seq = mutSeq;
        return adoptShared().then(serialize).then(function (blob) { return { blob: blob, seq: seq }; });
      });
    }).then(function (c) {
      if (fileHandle && canAutosave) {
        return enqueueFile(function () {
          // Same guard as the autosave path (inside writeThroughToFile): an unverified session must
          // not write to the file, and must not claim it saved.
          return writeThroughToFile(c.blob, c.seq, { rethrow: true }).then(function (written) {
            if (written) status("Saved to " + (suggestedName) + " ✓", "ok");
          });
        });
      }
      return shareOrDownload(c.blob, suggestedName || DEFAULT_NAME);
    });
  }
  // iPad has no showSaveFilePicker; the ONLY way a web page can write to an external USB is the
  // native share sheet ("Save to Files → <USB>"). Fall back to a plain download if unavailable.
  // Must be called from a user gesture (the Save button) so the share sheet is allowed.
  function shareOrDownload(blob, name) {
    try {
      if (navigator.canShare) {
        var file = new File([blob], name, { type: "application/octet-stream" });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file] })
            .then(function () { status("Saved — pick your USB in the Files sheet ✓", "ok"); })
            .catch(function (e) {
              if (e && e.name === "AbortError") { status("Save cancelled", "warn"); return; }
              download(blob, name); status("Exported to Downloads — move it to the USB", "ok");
            });
        }
      }
    } catch (e) { /* fall through to download */ }
    download(blob, name);
    status("Exported to Downloads — move it to the USB", "ok");
    return Promise.resolve();
  }
  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* -------------------------------------------------- hidden input for iPad open */
  var openInput = null;
  function ensureInput() {
    if (openInput || typeof document === "undefined") return openInput;
    openInput = document.createElement("input");
    openInput.type = "file"; openInput.accept = ".crmdb,.zip,application/octet-stream";
    openInput.style.display = "none";
    document.body.appendChild(openInput);
    return openInput;
  }

  /* ------------------------------------------------------- virtual FS handles */
  function fileHandleFor(path) {
    return {
      kind: "file",
      name: baseName(path),
      getFile: function () { var b = bundle.get(path) || new Blob([]); return Promise.resolve(new File([b], baseName(path), { type: mimeFor(path) })); },
      // opts.defer stages without scheduling a commit, exactly as writeFile's does — the Schedule
      // writes schedule.json through this handle on a typing debounce, and a commit re-serializes
      // the whole database. The bytes are in the bundle either way; a later commit carries them.
      createWritable: function (opts) {
        var chunks = [], defer = !!(opts && opts.defer);
        return Promise.resolve({
          write: function (d) { chunks.push(d); return Promise.resolve(); },
          truncate: function () { return Promise.resolve(); },
          close: function () { bset(path, new Blob(chunks)); if (!defer) persist(); return Promise.resolve(); }
        });
      }
    };
  }
  function dirHandleFor(prefix) {
    return {
      kind: "directory",
      prefix: prefix,
      getFileHandle: function (name) { return Promise.resolve(fileHandleFor(prefix + name)); }
    };
  }
  // the "root": the only bit the pages call on it is getFileHandle('schedule.json')
  var ROOT = {
    kind: "directory",
    name: FOLDER,
    getFileHandle: function (name) { return Promise.resolve(fileHandleFor(name)); },
    getDirectoryHandle: function (name) { return Promise.resolve(dirHandleFor(name.replace(/\/?$/, "/"))); }
  };

  /* --------------------------------------------------------- CRMWorkspace API */
  function initScaffold(root) {
    if (!bundle.has("schedule.json")) bset("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    return Promise.resolve(root || ROOT);
  }

  // Open an EXISTING database. Desktop: file picker (handle kept for autosave).
  // iPad: hidden file input. Either way the bytes populate the bundle.
  function connect() {
    if (canAutosave) {
      return window.showOpenFilePicker({ types: [{ description: "CRM database", accept: { "application/octet-stream": [".crmdb", ".zip"] } }] })
        .then(function (hs) {
          // Switching from an already-open database: write its latest edits back to its own
          // file BEFORE we clear the bundle to load the newly-picked one, so nothing is lost.
          // BUT only when this session is verified — an unverified cache may be an old station copy,
          // and writing it back here is exactly how a stale reconnect overwrote OneDrive before.
          var prev = fileHandle, prevName = suggestedName, prevProtection = protection;
          var next = hs[0];
          // A blocked Save can still commit edits into this browser's working copy. Reopening the
          // file used to ingest it unconditionally here, silently erasing those edits. Treat that
          // as the same three-way conflict as automatic freshness verification.
          var reconnectConflict = opened && !freshnessVerified && !cacheMatchesFile;
          var saveOld = (opened && prev && canAutosave && freshnessVerified)
            ? serialize().then(function (blob) {
                return prev.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); });
              }).catch(function () {})
            : Promise.resolve();
          return saveOld.then(function () {
            clearTimeout(persistTimer);
            suggestedName = next.name;
            return next.getFile();
          }).then(function (f) {
            var mod = f.lastModified;
            return readFile(f).then(function (info) {
              fileHandle = next;
              if (reconnectConflict) {
                return resolveConflict(f, info, "reconnect").then(function (res) {
                  return { decision: res.decision, resolved: true };
                });
              }
              return ingest(info.src).then(function () {
                // We just read the file, so the cache equals it exactly and this session is verified.
                baseFileMod = mod; cacheMatchesFile = true; freshnessVerified = true;
                baseSig = info.sig; pendingSig = null;
                return { decision: "file", resolved: false };
              });
            }).catch(function (e) { fileHandle = prev; suggestedName = prevName; protection = prevProtection; throw e; });
          })
            .then(function (result) {
              return idbSet("fileHandle", fileHandle).then(function () { return result; });
            })
            // Keep an immediately reopenable working copy. Waiting for the next edit used to
            // leave refresh/page handoff with only a permission-gated file handle and no data.
            .then(function (result) {
              opened = true;
              // adoptFile already published the file/backup choices. A local choice is marked
              // authoritative by resolveConflict but still needs publishing into IndexedDB.
              if (result.resolved) return result.decision === "local" ? commit() : null;
              markAuthoritative(); return persistMeta().then(commit);
            })
            .then(function () { return ROOT; });
        });
    }
    // iPad
    var inp = ensureInput();
    return new Promise(function (res, rej) {
      inp.value = "";
      inp.onchange = function () {
        var f = inp.files && inp.files[0];
        if (!f) { rej(Object.assign(new Error("cancelled"), { name: "AbortError" })); return; }
        var prev = fileHandle, prevName = suggestedName, prevProtection = protection;
        suggestedName = f.name;
        // The File itself, not its bytes: iPad keeps no content signature (baseSig stays null), so
        // nothing here needs the whole thing in memory and ingest can go by reference.
        ingest(f).then(function () {
          fileHandle = null; opened = true;
          freshnessVerified = true; baseFileMod = null; cacheMatchesFile = true;  // iPad: the cache IS the database
          baseSig = null; pendingSig = null;
          markAuthoritative();
          return commit();
        }).then(function () { res(ROOT); })
          .catch(function (e) { fileHandle = prev; suggestedName = prevName; protection = prevProtection; rej(e); });
      };
      inp.click();
    });
  }

  // Create a NEW empty database.
  function newDatabase() {
    if (canAutosave) {
      return window.showSaveFilePicker({ suggestedName: DEFAULT_NAME, types: [{ description: "CRM database", accept: { "application/octet-stream": [".crmdb"] } }] })
        .then(function (h) {
          protection = null; bundle.clear();
          bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
          opened = true; fileHandle = h; suggestedName = h.name;
          // Brand-new file we are about to author: verified by construction, so saveNow may write it.
          freshnessVerified = true; baseFileMod = null; cacheMatchesFile = false;
          baseSig = null; pendingSig = null;
          markAuthoritative();                  // a brand-new database replaces the working copy
          return idbSet("fileHandle", h);
        })
        .then(function () { return saveNow(); })
        .then(function () { return ROOT; });
    }
    protection = null;
    bundle.clear();
    bundle.set("schedule.json", new Blob([JSON.stringify({ type: "patient-schedule", version: 1, dates: {} }, null, 2)]));
    fileHandle = null; suggestedName = DEFAULT_NAME;
    opened = true;
    freshnessVerified = true; baseFileMod = null; cacheMatchesFile = true;
    baseSig = null; pendingSig = null;
    markAuthoritative();
    return commit().then(function () { return ROOT; });
  }

  // Auto-reconnect on page load: pull the working copy out of IndexedDB (both platforms),
  // and re-bind the desktop file handle if one was remembered. Returns ROOT or null.
  function stored() {
    lastOpenError = null;
    return idbGet("fileHandle").then(function (h) {
      if (h && canAutosave) fileHandle = h;
      return loadMeta().then(function () {
        // Desktop with a bound file must prove its cache isn't stale (verifyFreshness) before any
        // save; iPad/no-handle has no file to compare against, so its copy is trivially current.
        freshnessVerified = !(fileHandle && canAutosave);
        return idbGet(BUNDLE_KEY).then(function (blob) {
          if (blob) {
            // Adopting the shared copy: record which revision we're based on, so the first save
            // knows whether anyone else has moved since.
            return idbGet(REV_KEY).then(function (r) {
              return idbGet(CRC_KEY).then(function (crcs) {
                return ingest(blob).then(function () {
                  seedCrcs(crcs);
                  opened = true; myRev = Number(r) || 0; journal.clear(); authoritative = false;
                  return ROOT;
                });
              });
            });
          }
          // no working copy yet, but a desktop handle may still let us open the file later
          return (h && canAutosave) ? ROOT : null;
        });
      });
    }).catch(function (e) { lastOpenError = e; return null; });
  }

  // Load the bound file as the working copy (used when permission is (re)granted and we had no
  // cache). Reading the file is itself a verification, so this pins the base and clears the gate.
  function readFromFile() {
    return fileHandle.getFile().then(function (f) {
      // adoptFile publishes through commit(), which intentionally ignores a closed workspace.
      // Mark this handle-only reopen as open before adopting so its restored working copy is kept.
      opened = true;
      return adoptFile(f).catch(function (e) { opened = false; throw e; });
    });
  }

  function permission(root, ask) {
    if (fileHandle && canAutosave && fileHandle.queryPermission) {
      return fileHandle.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p !== "granted" && ask && fileHandle.requestPermission) {
          return fileHandle.requestPermission({ mode: "readwrite" }).then(function (p2) {
            if (p2 === "granted" && !opened) return readFromFile().then(function () { return "granted"; });
            return p2;
          });
        }
        if (p === "granted" && !opened) return readFromFile().then(function () { return "granted"; });
        return p;
      });
    }
    return Promise.resolve(opened ? "granted" : "granted");   // iPad: the in-memory bundle is the copy
  }

  // Re-use the FileSystemFileHandle remembered in IndexedDB. This is deliberately separate from
  // connect(): reconnect may restore browser permission, but it never opens a file-selection
  // prompt or asks the user to find the same .crmdb again.
  function reconnect() {
    if (!fileHandle || !canAutosave) {
      return Promise.reject(new Error("No previously opened database is available to reconnect"));
    }
    return permission(ROOT, true).then(function (p) {
      if (p !== "granted") {
        var e = new Error("Access to " + (suggestedName || DEFAULT_NAME) + " was not granted");
        e.name = "NotAllowedError";
        throw e;
      }
      return verifyFreshness();
    }).then(function (result) {
      return { root: ROOT, decision: result && result.decision };
    });
  }

  function forget() {
    clearTimeout(persistTimer);
    fileHandle = null; opened = false; protection = null; clearSessionKey(); bundle.clear();
    // Drop any pending edits with the database — nothing may be replayed into the next one.
    journal.clear(); authoritative = false; myRev = 0;
    baseFileMod = null; cacheMatchesFile = false; freshnessVerified = false;
    baseSig = null; pendingSig = null;
    return Promise.all([idbDel("fileHandle"), idbDel(BUNDLE_KEY), idbDel(REV_KEY), idbDel(META_KEY), idbDel(CRC_KEY)]).then(function () {});
  }

  /* slot / file operations over the bundle */
  function slotDir(root, date, slot, create) { return Promise.resolve(dirHandleFor(slotPrefix(date, slot))); }
  function readText(dir, name) {
    var path = dir.prefix + name;
    if (!bundle.has(path)) return Promise.reject(new Error("not found: " + name));
    return bundle.get(path).text();
  }
  // opts.defer stages the write in the working copy WITHOUT scheduling a commit. A commit
  // re-serializes the WHOLE database — serializeZip CRC-32s every byte of every file and
  // concatenates the result — which on a clinic-sized bundle is a multi-hundred-millisecond
  // block of the main thread. Writes that fire on a typing debounce (the report generator's
  // live sync) therefore stage here and let their caller commit on a much slower cadence;
  // the staged bytes are in the bundle either way, so any later commit or flush carries them.
  // Every other caller persists as before.
  function writeFile(dir, name, data, opts) {
    bset(dir.prefix + name, toBlob(data));
    if (!opts || !opts.defer) persist();
    return Promise.resolve();
  }
  function listFiles(dir) {
    var pre = dir.prefix, out = [];
    bundle.forEach(function (blob, path) {
      if (path.indexOf(pre) === 0 && path.indexOf("/", pre.length) === -1) {
        out.push(fileHandleFor(path));
      }
    });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return Promise.resolve(out);
  }
  // One-pass index for the Schedule's Files column. Calling listFiles once per patient makes a
  // redraw O(visible patients * every file in the database); grouping the current date here makes
  // it O(every file + visible patients) without changing the virtual-handle API used elsewhere.
  function filesBySlot(date) {
    var pre = "patients/" + String(date || "") + "/", out = {};
    bundle.forEach(function (_blob, path) {
      if (path.indexOf(pre) !== 0) return;
      var rest = path.slice(pre.length), slash = rest.indexOf("/");
      if (slash <= 0 || rest.indexOf("/", slash + 1) !== -1) return;
      var slot = rest.slice(0, slash), name = rest.slice(slash + 1);
      (out[slot] = out[slot] || []).push(name);
    });
    Object.keys(out).forEach(function (slot) { out[slot].sort(function (a, b) { return a.localeCompare(b); }); });
    return out;
  }
  function removeFile(root, date, slot, name) {
    var had = bdel(slotPrefix(date, slot) + name);
    if (had) persist();
    return Promise.resolve(had);
  }
  // Remove every file in one patient's slot (used when a patient is deleted from the schedule).
  function removeSlotFiles(root, date, slot) {
    var pre = slotPrefix(date, slot), removed = 0;
    Array.from(bundle.keys()).forEach(function (k) { if (k.indexOf(pre) === 0) { bdel(k); removed++; } });
    if (removed) persist();
    return Promise.resolve(removed);
  }
  // Retention: drop every patient file whose date is strictly before cutISO (YYYY-MM-DD).
  // Catches orphaned files too (dates no longer in the schedule), so the database stays bounded.
  function pruneFilesBefore(cutISO) {
    var removed = 0, bytes = 0;
    Array.from(bundle.keys()).forEach(function (path) {
      var m = /^patients\/(\d{4}-\d{2}-\d{2})\//.exec(path);
      if (m && m[1] < cutISO) { var b = bundle.get(path); bytes += (b && b.size) || 0; bdel(path); removed++; }
    });
    if (removed) persist();
    return Promise.resolve({ files: removed, bytes: bytes });
  }
  // Map of "<date>/<slot>" -> number of files, for the All-patients overview.
  function slotFileCounts() {
    var counts = {};
    bundle.forEach(function (_b, path) {
      var m = /^patients\/(\d{4}-\d{2}-\d{2})\/([^/]+)\//.exec(path);
      if (m) { var k = m[1] + "/" + m[2]; counts[k] = (counts[k] || 0) + 1; }
    });
    return counts;
  }
  // Current size of the open database (patient files + schedule), for the Memory readout.
  function stats() {
    var files = 0, bytes = 0;
    bundle.forEach(function (b, path) {
      bytes += (b && b.size) || 0;
      if (path.indexOf("patients/") === 0) files++;
    });
    return { files: files, bytes: bytes };
  }
  function moveSlot(root, date, oldSlot, newSlot) {
    if (!oldSlot || !newSlot || oldSlot === newSlot) return Promise.resolve(false);
    var op = slotPrefix(date, oldSlot), np = slotPrefix(date, newSlot), moved = false;
    Array.from(bundle.keys()).forEach(function (k) {
      if (k.indexOf(op) === 0) { bset(np + k.slice(op.length), bundle.get(k)); bdel(k); moved = true; }
    });
    if (moved) persist();
    return Promise.resolve(moved);
  }
  // Move every patient folder for one schedule date to another date. This is deliberately a
  // bundle-prefix move (rather than looping over the visible rows) so orphaned/manual attachments
  // follow too. When merging into an existing day, the moving day's same-path file wins.
  function moveDate(root, oldDate, newDate) {
    if (!oldDate || !newDate || oldDate === newDate) return Promise.resolve({ files: 0, overwritten: 0 });
    var op = "patients/" + oldDate + "/", np = "patients/" + newDate + "/";
    var files = 0, overwritten = 0;
    Array.from(bundle.keys()).forEach(function (k) {
      if (k.indexOf(op) !== 0) return;
      var target = np + k.slice(op.length);
      if (bundle.has(target)) overwritten++;
      bset(target, bundle.get(k));
      bdel(k);
      files++;
    });
    if (files) persist();
    return Promise.resolve({ files: files, overwritten: overwritten });
  }

  var api = {
    supported: true,           // open(file input)+save(download) work everywhere; autosave is desktop-only
    canAutosave: canAutosave,
    FOLDER: FOLDER,
    slotName: slotName,
    connect: connect,
    newDatabase: newDatabase,
    initScaffold: initScaffold,
    stored: stored,
    permission: permission,
    reconnect: reconnect,
    canReconnect: function () { return !!(fileHandle && canAutosave); },
    forget: forget,
    slotDir: slotDir,
    moveSlot: moveSlot,
    moveDate: moveDate,
    listFiles: listFiles,
    filesBySlot: filesBySlot,
    readText: readText,
    writeFile: writeFile,
    removeFile: removeFile,
    removeSlotFiles: removeSlotFiles,
    pruneFilesBefore: pruneFilesBefore,
    slotFileCounts: slotFileCounts,
    stats: stats,
    saveNow: saveNow,
    flush: flush,
    reloadWorkingCopy: reloadWorkingCopy,
    verifyFreshness: verifyFreshness,
    isVerified: function () { return freshnessVerified; },
    hasPendingFileChanges: function () { return opened && !cacheMatchesFile; },
    lastOpenError: function () { return lastOpenError; },
    enableProtection: enableProtection,
    changePassword: changePassword,
    disableProtection: disableProtection,
    lockSession: function () { clearSessionKey(); return true; },
    isEncrypted: function () { return !!protection; },
    isOpen: function () { return opened; },
    currentRoot: function () { return opened ? ROOT : null; },
    // Filename of the bound database, or null when nothing is open. Browsers do NOT
    // expose the parent folder path through the File System Access API, so this is the
    // filename only (e.g. "schedule.crmdb") — the most a web page is allowed to know.
    fileName: function () { return opened ? suggestedName : null; },
    set onStatus(fn) { statusCb = fn; },
    get onStatus() { return statusCb; },
    set onPasswordRequest(fn) { passwordCb = fn; },
    get onPasswordRequest() { return passwordCb; },
    // Pages set this to resolve a true reconnect conflict (newer file AND unsaved local edits).
    // fn(details) -> "file" (take OneDrive), "local" (keep this station), "backup" (save local
    // copy aside, then take the file). Returning nothing defaults to "file".
    set onConflict(fn) { conflictCb = fn; },
    get onConflict() { return conflictCb; },
    // test hooks (used by the Node unit test; harmless in the browser)
    _bundle: bundle, _serialize: serialize, _serializeZip: serializeZip, _ingest: ingest,
    _containerSig: containerSig, _sigOf: sigOf,
    _isBlobLikeForTest: isBlobLike, _toBlobForTest: toBlob,
    _markAuthoritativeForTest: markAuthoritative, _journal: journal,
    _setFileHandleForTest: function (h) { fileHandle = h; },
    // Resolves when every queued write-through has finished. Tests use it to observe the file
    // writes that flush()/persist() now deliberately leave running in the background.
    _fileIdle: function () { return fileChain.then(noop, noop); },
    _metaForTest: function () { return { baseFileMod: baseFileMod, cacheMatchesFile: cacheMatchesFile, freshnessVerified: freshnessVerified, baseSig: baseSig, pendingSig: pendingSig }; }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.CRMWorkspace = api;
})();
