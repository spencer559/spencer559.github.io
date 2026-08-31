# Cardiac CRM Toolkit

A small suite of browser tools for a cardiac device clinic, served as a static site on **Cloudflare Pages** (`device-tech.pages.dev`). The repo name `spencer559.github.io` is a leftover from the original GitHub Pages hosting, which is being retired.

| Page | What it is |
|---|---|
| `index.html` | Public landing page — self-contained static page (own CSP, self-hosted fonts) |
| `protected/CRM_Report_Generator.html` | **The flagship** — CIED interrogation report generator (bulk of this README) |
| `mileage/index.html` | **Public** clinic-coverage mileage log → one-click expense-form .xlsx, optional cloud sync |
| `protected/index.html` | Developer deck — landing page for protected tools (`/protected/*` is gated by Cloudflare Access) |
| `protected/dashboard.html` | Command center: markets, device-check tally, clinical reference, notes/to-do |
| `protected/Patient_Schedule.html` | Daily clinic schedule — full patient names, zero network egress, print-formatted day sheet; stores the schedule **and** every patient's files in one portable `.crmdb` database (iPad-ready) |
| `mileage-backend/` | Cloudflare Worker + D1 backend for mileage cloud sync (see its `DEPLOY.md`) |

> This README doubles as a **project handoff / context document** — if you're an AI assistant (e.g. Claude in Cowork) being pointed here to continue the work, read the whole thing; it captures the architecture, conventions, and the vendor-specific gotchas that took real reports to discover.

---

## CRM Interrogation Report Generator

A browser-based tool for documenting **CIED** (cardiac implantable electronic device — pacemakers, ICDs, CRT) interrogation visits. It auto-fills a structured clinical form by reading the manufacturer's own export file locally in the browser, then produces a printable PDF report and a plain-text summary for pasting into an EHR. Everything runs **client-side** (no server, no upload).

### What it does

1. The user drops a vendor export onto the "Auto-fill" panel.
2. The right parser reads it and produces a normalized result.
3. The form is reset to a clean state and auto-filled; fields the parser is unsure about are flagged for review.
4. The user reviews/edits, then exports: **Save PDF** (printable, one-page-oriented), **Copy to Clipboard** / **Export .txt** (for the EHR).

Supported inputs:

| Vendor | Input | Notes |
|---|---|---|
| **Medtronic** | SmartSync **PDF** (text-based) | Quick Look / Session Summary / Parameters / Patient Info pages |
| **Boston Scientific** | LATITUDE **PDF** (text-based) | Quick Look / Combined Follow-up / Patient Data pages |
| **Abbott / St. Jude** | Merlin **.log** (text) | Their PDF is a scanned **image** with no selectable text → use the `.log` export instead |
| **Biotronik** | **PDF** (text-based) | Two report layouts handled: Home-Monitoring (per-character fragmented text) and Standard/BIOSTD (whole-word). See gotchas. |

---

## Project layout

```
index.html                          Public landing page (self-contained static page, single file)
_headers                            Cloudflare Pages security headers (frame-ancestors, HSTS, nosniff…)
assets/                             Background images for the landing pages
mileage/
  index.html                        Public mileage log → expense-form .xlsx (fully self-contained)
  mileage-sync.js                   Optional cloud-sync client; its login is not Cloudflare Access
protected/
  index.html                        Developer deck (Cloudflare Access gates /protected and /protected/*)
  CRM_Report_Generator.html         THE ACTIVE APP — edit this one
  PDF_Viewer.html                   Local PDF viewer used by the Schedule
  dashboard.html                    Command-center dashboard (single file)
  Patient_Schedule.html             Daily clinic schedule — the .crmdb's other page (see below)
  crmdb-container-design.md         Design note for the .crmdb container (written before the migration)
  auth-check.json                   Same-origin Access-session probe used by the landing page
mileage-backend/
  src/worker.js  wrangler.toml      Cloudflare Worker + D1 sync backend
  schema.sql  DEPLOY.md             (see DEPLOY.md for one-time setup)
src/
  crmdb-store.js                    Shared .crmdb database engine (CRMWorkspace API over an in-memory bundle; see below)
  crmdb-commit-cadence.js           WHEN a staged edit gets published — the shared commit timer + teardown hooks
  engine.js                         Shared PDF extraction engine + anchor helpers + cleaners
  parsers/
    medtronic.js                    Medtronic PDF parser  → window.MEDTRONIC.runMap(LINES, META)
    boston.js                       Boston Scientific PDF  → window.BOSTON.runMap(LINES, META)
    abbott.js                       Abbott Merlin .log     → window.ABBOTT.runLog(text)
    biotronik.js                    Biotronik PDF parser  → window.BIOTRONIK.runMap(LINES, META)
vendor/
  crmdb-zip.js                      Dependency-free ZIP reader/writer for the .crmdb container (CSP-safe, no CDN)
  pdf.min.js  pdf.worker.min.js     Vendored pdf.js 3.11.174 (self-hosted, not a CDN)
  jspdf.umd.min.js (+ autotable)    Vector-PDF export
  fonts/                            Self-hosted landing-page fonts
tools/
  CIED PDF Extraction Harness.html  Dump a PDF's text items (parser authoring/debugging)
  CIED Abbott Log Redactor.html     Locally inspect/redact Abbott .log files without damaging FS delimiters
  CIED PDF Redactor.html            Locally redact/flatten vendor PDFs before sharing samples
  CIED_Medtronic_Parser_Preview_v2.html   Older preview harness
tests/
  run.js                            Test runner — one child process per *.test.js (see Testing)
  *.test.js                         Node tests for the .crmdb engine + vendor detection
package.json                        No dependencies and no build step — it exists to give `npm test` an entrypoint
```

**Path conventions:** protected pages live together at one directory depth, so their includes are relative — `../src/engine.js`,
`../src/parsers/*.js`, `../vendor/pdf.min.js`, and `pdfjsLib.GlobalWorkerOptions.workerSrc =
'../vendor/pdf.worker.min.js'`. The standalone utilities in `tools/` use the same `../src` / `../vendor`
prefixes. Test fixtures
(`Abbott Test Cases/`) stay local and are git-ignored.

| Component | Role |
|---|---|
| `protected/CRM_Report_Generator.html` | **The active app.** Form UI, auto-fill drop panel, `prefillForm`, lead tables, report builders, save/restore, JSON import/export. |
| `src/engine.js` | Shared **PDF extraction engine** (pdf.js based) + anchor helpers + cleaners. |
| `src/parsers/medtronic.js` | Medtronic PDF parser → `window.MEDTRONIC.runMap(LINES, META)` |
| `src/parsers/boston.js` | Boston Scientific PDF parser → `window.BOSTON.runMap(LINES, META)` |
| `src/parsers/abbott.js` | Abbott Merlin **.log** parser → `window.ABBOTT.runLog(text)` |
| `src/parsers/biotronik.js` | Biotronik PDF parser (two report layouts) → `window.BIOTRONIK.runMap(LINES, META)` |
| `vendor/` | Self-hosted pdf.js **+ jsPDF/autotable** (no runtime CDN dependency). |

---

## How it works (data flow)

```
file dropped → handleFile(file)               [in protected/CRM_Report_Generator.html]
   ├─ .log / .txt  → ABBOTT.runLog(text)       (read as text, BOM/encoding-aware)
   └─ .pdf         → pdf.js → Engine.extractItems → Engine.normalize → Engine.tagSections
                     → Engine.guessVendor → PARSERS[vendor].runMap(LINES)
   → (unless "Merge" is ticked) resetFormState()   — clean "New Patient" slate
   → prefillForm(RESULT, LEADS, EPISODES, { merge })
```

Every parser returns the **same bundle** (`EPISODES` optional):

```js
{ RESULT, LEADS, ROUTE, ORDER, GOTCHAS, EPISODES? }
```

**Merge import.** Merge is a **toggle at the bottom of the Import menu** (`Import ▸ Merge — keep
what I've entered`) that governs **every** import path: `Import PDF / .log…`, and the
`Auto-fill from <file>` items under **Import Database** (a programmer export attached to the
patient's slot in the Schedule). It works because `#pdp-merge` — the checkbox in the hidden
auto-fill panel — is the single source of truth that `handleFile` reads, and the database items go
through `handleFile` too; the toggle just drives that checkbox. (It replaced a separate
`Merge PDF / .log…` menu item, which only ever covered the file-picker path — there was no way to
merge a database import.) Merge is a **sticky mode**, so note the safety property: `openSlot()`
calls `resetFormState()`, which unchecks every checkbox including `#pdp-merge` — opening a patient
turns Merge back **off**, so it can't leak across patients and merge one patient's export into
another's form. Don't make `#pdp-merge` survive a patient switch.

With it off (default), import resets the form and fills fresh. With it on, `resetFormState()` is skipped and
`prefillForm(..., { merge:true })`: scalar fields fill **only where blank** (your typed values are
kept), the lead table is left alone if you've already started one, and parser `EPISODES` are
**appended** as new logbook rows instead of overwriting. Use it to chart episodes live, then drop the
PDF later to fill in the rest.

### The `RESULT` contract

`RESULT` is an object keyed by **form field id/name**. Each value:

```js
{ label, field, v, src, status, note }
//  v      = the string value to put in the field
//  status = 'auto' (confident) | 'review' (flagged for the tech to verify) | 'empty'
//  note   = short explanation, shown on review items
```

`prefillForm` sets manufacturer + device type first (they rebuild the lead rows and toggles), then loops the rest and calls `setField(key, v)`, counting fills and collecting review labels.

### The `LEADS` contract (verbatim lead inventory)

`LEADS` is an array, one entry per **physical lead**, captured **exactly as the report prints it** (no chamber normalization, duplicates/typos preserved):

```js
{ location, manufacturer, model, serial, date }
```

`setLeadInfoRows(LEADS)` rebuilds the form's lead-information table with one editable row per lead. Location/Manufacturer/Model/Serial/Implant-Date are all free-text so the table reads exactly like the source.

Parsers capture **every** lead the report prints, including abandoned/capped ones (a CRT-P with 5 leads is a real case) — deciding which are still in use is the tech's job, not the parser's, so each row has an **×** to remove it and a **+ Add Lead** button for one the importer missed. All three report builders read the table through `leadInfoRows()`, which drops rows whose cells are all blank; clearing a row is equivalent to ×-ing it. Don't reintroduce a `data-loc` fallback that fires on a fully-blank row — that's what used to keep a cleared row (and once, a literal `RV#0`) on the PDF.

### Field keys used by `RESULT`

`pt-name, pt-dob, pt-mrn, pt-date, dev-implant, pt-provider, mfr, dtype, dev-model, dev-serial,
bat-lon-cur, bat-lon-unit, bat-cc-cur, bat-status, pct-a, pct-v, pct-lv, pct-biv, p-mode, p-lrl, p-utr, p-usr,
dyn-av, p-sav, p-sav-hi, p-pav, p-pav-hi, p-ms, p-msrate,
lead-ra-{imp,sens,thr,pw}, lead-rv-{imp,sens,thr,pw}, lead-lv-{imp,sens,thr,pw},
lead-rv-coil-imp, lead-svc-coil-imp, ep-since-date, ep-af-burden, ep-ahr, ep-hvr, ep-pmt, obs-yn, obs-text, rp-chg, sig-date`

**Conventions:**
- `mfr` radio values: `Medtronic`, `Abbott`, `BSci`, `Biotronik`. (boston.js still returns the legacy `BSc`; `prefillForm` maps it to `BSci` — don't "fix" the parser, it would break nothing but it's shared history with older saves.)
- `dtype` radio values: `PPM-SC`, `PPM-DC`, `CRT-P`, `ICD-SC`, `ICD-DC`, `CRT-D`, `S-ICD`, `Leadless`, `Aveir`.
- Discrete date fields (`pt-dob`, `pt-date`, `dev-implant`) are `<input type="date">` → need ISO `yyyy-mm-dd`. The lead-table dates are free text → kept as printed.
- **Aveir (leadless)** has its own UI mode keyed off the `aveir-chamber` RA/RV checkboxes: the lead-info columns relabel "Lead …" → "Module …", the single Longevity row is replaced by per-module rows (`bat-lon-ra-cur`/`-unit`, `bat-lon-rv-cur`/`-unit`) shown only for implanted chambers, and A/V Paced % show only when the RA/RV module is present. There is no Aveir importer — it's filled manually.

### Optional bundle keys
Besides `RESULT`/`LEADS`, a parser may return `EPISODES` — an array of arrhythmia-log rows `{dt, dur, rate, types[], flags?, notes?}` that `prefillForm` writes into the logbook via `setEpisodeRows`. Boston populates its "Longest" AT/AF episode; Biotronik Home-Monitoring selects the most recent AHR, longest AHR, and fastest non-AHR recording (deduplicating an AHR that satisfies both criteria). Each logbook row has **flag checkboxes** (`Longest` / `Recent` / `Fastest`, name `ep{n}-flag`) that replaced the old "Approp.?" radios; a parser `notes` value that is *exactly* a flag name (e.g. Boston's `Longest`) checks the flag instead of filling Notes.

---

## `engine.js` (shared PDF helpers)

- `extractItems(pdf)` → `[{page,x,y,w,str}]`; `normalize(items)` → reading-order `LINES` (each line = `{page,y,items:[{x,str}]}`); `tagSections` marks each line `secType: 'initial'|'final'|'other'`.
- Anchor helpers: `findRight(LINES, re, {match, prefer, notLabel})`, `colsRightOf`, `twoCol` (split a row into A/RV[/LV] columns), `lineWith`.
- Cleaners: `toISO` (Medtronic `Mon/DD/YYYY`), `num`, **`cmpNum`** (keeps comparator values like `<1`, `>99`, `<0.1` instead of flattening them — used so "% paced / AF burden" can show `<1`).
- `guessVendor(items)` matches vendor signatures.

---

## Vendor specifics & hard-won gotchas

### Medtronic (`medtronic.js`)
- Routes by model + lead evidence into leadless / dual / CRT / single, then a CRT safety-net upgrade if an LV/CS lead or AdaptivCRT text is present.
- **Generator implant date** must come from device-level anchors ("Device … Implanted:" / "Device Status (Implanted: …)"), **not** the first "Implant Date" line — that one is the *first lead's* date.
- **Two-column lead measurements**: the Atrial/RV[/LV] column x-positions differ between the Quick Look and the (compressed) Session Summary, so the column split is **derived dynamically from the chamber header row** (`Atrial(####) RV(####) [LV]`), not a fixed x. **Single-chamber** reports have just one chamber token (`RV(####)` only); the split then routes that lone column to RV (or RA for an atrial-only device) so the values don't fall into the wrong chamber. Single-chamber RV reports also label sensing **"R Wave"** (not "P/R Wave"), so the sensing match accepts both.
  - The `(####)` model number is **optional**: a conduction-system implant has no lead registered to the RV port, so the header prints a bare `RV` (e.g. `Atrial(4076)  RV`). Requiring `RV(` read that as an atrial-only header and pushed every cell into the atrial column, blanking all four `lead-rv-*` fields. Header rows are now identified as **lines made up entirely of chamber tokens** (bare or parenthesized), preferring the Final section and then the row with the most chambers — that keeps decoys out (the EGM-source row `EGM2  RVtip to RVring  ±8 mV  RV  0.9 mV`, `Pacing Details  Atrial  RV`, and the Patient-Information implant table's `ATRIAL  RV`).
- **MVP (Managed Ventricular Pacing)** prints two mode tokens (e.g. `AAIR  DDDR`); record the pair verbatim as `AAIR/DDDR`, don't collapse to `DDD`.
- **Pacing % comes from the "Therapy Summary" block on the Quick Look page** (`therapySummaryVal()`), which lists single, since-last-session values: dual chamber → `VP` / `AP`; CRT → `Total VP*` / `AP` plus an `Effective` row (Total VP Effective → **BiV Paced %**). Scoping to that block is essential — the Rate-Histogram pages repeat `Total VP` / `VP` as **two-column** rows (`prior | since-last`) and as a `% of AT/AF` metric, so a document-wide search grabbed the wrong number (a prior-session value, or the AT/AF-paced VP). `pct-v` ← Total VP/VP, `pct-a` ← AP/Total AP, `pct-biv` ← Effective (CRT only). Fallback when no Therapy Summary: sum the four pacing states (`AS-VP + AP-VP`, etc.).
- ICD coil impedance / charge time come from single-value rows (RV Defib / SVC Defib / Charge Time).
- Lead inventory: from the "Device Information" rows; **de-dup by serial** (the rows repeat across pages) — never by chamber (two same-chamber leads must both survive).
- **Conduction-system pacing (LBB / His)**: the lead row is labeled by implant *site* (`LBB  Medtronic  3830 SelectSecure™  …`), not `RV`, so a chamber-only match dropped it and the report came out with no ventricular lead at all. The inventory accepts `LBB/LBBAP/LBBP/His/HB/HBP` (plus `RA`), keeps `location` verbatim, and normalizes `chamber` to **RV** — the lead is on the RV port, which is why its measurements are in the RV column. Those `lead-rv-*` fields get a note naming the actual lead so the report doesn't read as a conventional RV lead.

### Boston Scientific (`boston.js`)
- **Stacked header fields**: "Last Office Interrogation" and "Implant Date" print the value on the line *below* the label → `valueBelow()`. Interrogation date = the **"Report Created"** stamp (parsed out of that token), not "Last Office Interrogation".
- Dates are `D Mon YYYY` → vendor-local `bToISO`.
- Lead measurements are a 3-column table (Implant | Previous | **Most Recent**); read the Most-Recent column (`x ≥ ~470`).
- Quadripolar LV prints `Left Ventricular (LVa)` / `(LVb)`; LVa is the active vector. Pace-impedance rows are `Pace Impedance LVa/LVb` — keep the first (LVa).
- Dynamic AV delays print as a range (`260 - 300 ms`) → fills both bounds and flips the form's **Dynamic AV** toggle to Yes. A fixed range like `170 - 170` collapses to a single value.
- Programmed parameters are read only from Boston's **Brady Settings** / **Brady → Normal Settings** blocks. This prevents the Heart Rate Variability page's historical/reference **Sensed AV Delay** from being imported as active programming (notably in DDI reports, where the active block contains only Paced AV Delay).
- **Routing by shock evidence**, not model name (VISIONIST is CRT-P, not CRT-D!): CRT + shock = CRT-D, CRT without shock = CRT-P.
- Lead inventory is **verbatim** and read from the Patient-Data **"Leads" table column header** (`Implant Date | Manufacturer | Model | Serial | Polarity | Position`): each row's cells are assigned to the nearest header column by x, real rows are those whose Manufacturer isn't `N/R`. This captures **any** manufacturer verbatim (e.g. a legacy **Guidant** or St. Jude lead), not just Boston's own, and never pulls in the `Boston Scientific Corporation` footer (it's outside the table). (Earlier this matched the manufacturer cell exactly against `Boston Scientific`, which silently dropped non-Boston leads.)
- **Episode / arrhythmia-log mapping** — both values come from the *Since Last Reset* column, but **that column is in a different position in two adjacent blocks**, which is the subtle trap:
  - `ep-hvr` ← **Total Episodes**, which lives in the *Ventricular Tachy Counters* block laid out `Since Last Reset | Device Totals` → Since-Last-Reset is the **first/left** value (`findRight` returns it).
  - `ep-ahr` ← **prefer the device's own pre-totaled `AT/AF Events: N`** value, which prints inside the *AT/AF Overview: Since Last Reset* block (`atafEventsTotal()`). It's a **mid-row token** (e.g. `AT/AF: <1 %` | `AT/AF Events: 139` | `Total Time…`), not the first cell, so the scan checks **every** token on each line of that block. When that line is absent, **fall back** to `sumByDuration()` — the **sum of the "Episodes by Duration" buckets** (<1m + 1m–1h + 1h–24h + 24h–48h + >48h, walking to "Total PACs" which is **excluded**). Those rows are in the *Brady / Atrial Arrhythmia* block laid out `Reset Before Last | Since Last Reset` → Since-Last-Reset is the **rightmost** value, so `sumByDuration()` takes the rightmost numeric cell on each row, **not** the first (the first is Reset Before Last — often 0, which was the bug that returned AHR = 0). The two agree when both are present (the total == the bucket sum); the source note records which path filled the field.
  - The **"Longest"** episode under *AT/AF Overview: Since Last Reset* (not *Reset Before Last*) is pushed to the logbook as one row (date/time, duration, avg V rate, type AF/AHR, note "Longest").
  - (There is no `ep-total` — that field was removed; episodes are entered/typed, and HVR/AHR are the counters.)

### Biotronik (`biotronik.js`)
Biotronik exports come in (at least) **two very different templates**, and the parser handles both:
- **(A) Home-Monitoring report** — text fragmented into per-character tokens (`"R"+"ecent"`), bold headers drawn 2–4× (duplicate tokens), values in far-right columns (A ~x407, V ~x485), device on a `… S/N: …` line.
- **(B) Standard / BIOSTD report** — whole-word tokens, a clean first line `PDF: BIOTRONIK - <model> - <serial> - <Last, First> - p/N`, values closer in (A/V ~x315/x406 or x334/x378/x400), leads as an A|V table (no per-lead serials), and different labels (`Atrial burden`, `P/R wave amplitude`, fixed `AV delay`).

Unifying tricks:
- **Dynamic label/value split** at `VSPLIT≈305`: tokens left of it are the (joined, de-spaced) label — so both fragmentation styles normalize to the same key (`leftStr`); tokens right of it are values. A value row's **first** value token = Atrial, **second** = Ventricular (`avField`); `-----` = not measured.
- **Header** is read from the clean `PDF: BIOTRONIK - …` line when present, else from the `S/N:` line (model from the fragmented header tokens → flagged review).
- **Leads**: Home-Monitoring uses either per-lead blocks or a horizontal Lead Model / Manufacturer / Serial / Implantation / Channel inventory (with serials, deduped); Standard lists an A|V table (Type/Manufacturer/Position, no serials → uses the device implant date).
- Dates `MM/DD/YYYY` → `bToISO`. Longevity from "Calculated/Expected ERI N Y. M Mo." → years. AV is dynamic (`300/260` → min–max + Dynamic AV = Yes) or fixed (`AV delay [ms] 240`). Multiple interrogations/test runs appear, so values come from the **last (non-empty)** matching row.
- **Home-Monitoring diagnostics** map battery status, mode-switch state/rate, AHR/HVR/PMT counters, plus a focused `EPISODES` summary: most recent AHR, longest AHR, and fastest non-AHR recording (date/time, duration, mean ventricular rate). HVR rows stay explicitly flagged for rhythm classification instead of being guessed as VT/VF/NS-VT.
- **Lead measurements (impedance / sensing / threshold / pulse width) are scoped to the last "Test results" block** (`avScoped`): if a chamber's row there shows `-----` (not measured), the field stays **blank**. Without this, the label "Pulse width [ms]" also appears in the programmed-output and test-program sections, and a whole-document "keep last non-empty" search leaked the *programmed* atrial pulse width (e.g. `1.0`) into a chamber whose measured value was `-----`. Fields whose row is genuinely absent from the block fall back to the wider search (e.g. the Home-Monitoring threshold lives in a different section).
- **Validated against one dual-chamber PPM in each layout** — ICD/CRT and single-chamber Biotronik are unverified.

### Abbott / St. Jude (`abbott.js`)
- Input is the Merlin **.log**, which is **FS-delimited**: each line is `code <FS> name <FS> value <FS> unit <FS>` where `<FS>` = ASCII `0x1C`. Pasted into an editor the separators are invisible (so `2.0V` looks concatenated — it's `2.0<FS>V`). Values are keyed by the **numeric code** (unique per line).
- The reader is **encoding-aware**: `handleFile` decodes with a BOM-sniffing `TextDecoder` (UTF-16/UTF-8); `runLog` also strips stray BOM/null bytes and accepts any line ending.
- **Routing is structural**: an LV lead ⇒ CRT; shock evidence (HV-lead impedance / shock config / capacitor charge) ⇒ defibrillator. So CRT+shock = CRT-D, CRT no-shock = CRT-P, non-CRT+shock = ICD, else PPM.
- Abbott uses **different codes for different lead types** — e.g. RV pace/sense lead (`2461|2462/2470/2463/2460`) vs RV defib lead (`2448/2449|2450/2469/2451`); model can be "SJM …" vs "Other …", and a lead entered as "Other" fills only the Other code (RV `2462`, atrial `2458`, LV `2466`) — even when its manufacturer reads St. Jude Medical. A `first(...candidates)` helper resolves each cell.
- Key codes: `200/201` model, `202` serial, `203` interrogation, `2442` implant, `2430/2431` name/DOB, `301` mode, `302/323/406` LRL/UTR/USR, `337/322` sensed/paced AV, `320` rate-responsive AV (dynamic), `339` AMS, `512/507/2720` RA/RV/LV impedance, `2721/2722` RA/RV sensing, `1610/1606/1616` RA/RV/LV capture-test thresholds, `2730` HV (coil) impedance, `2745` charge time, `533` longevity. CRT pacing compartments are `2709/2710/2711` (RVP/LVP/BP); episode aggregates are `2754` (AT/AF count), `2630` (ICD VT/VF count), and `2750/2642` (atrial/tachy last-cleared dates).
- **Episode limits:** these `.log` exports contain aggregate counters but no individual episode timestamps, durations, or peak rates, so the parser cannot populate recent/longest logbook rows. Code `2755` is a raw unitless recent-week AT/AF time rather than the displayed since-clear burden percentage; only an unambiguous zero is auto-filled.
- **Redacting samples:** `tools/CIED Abbott Log Redactor.html` accepts multiple logs entirely client-side, detects UTF-8/UTF-16LE/UTF-16BE, exposes the invisible FS-delimited fields in a table, and preselects common PHI plus device/lead serial numbers. Only selected value byte ranges are replaced; BOM, encoding, line endings, FS delimiters and all unselected bytes are retained. It can download one redacted `.log` or all loaded samples as a ZIP.
- **Redacting vendor PDFs:** `tools/CIED PDF Redactor.html` handles Medtronic, Boston Scientific, Biotronik, and scanned Abbott PDFs entirely client-side. On load it scans **every page before enabling download**, auto-boxing common identifiers (including names, MRNs, providers/facilities, contacts, device/lead serials, and patient-related dates); the all-page rescan preserves click-drag manual boxes. Its taller preview fits one complete page using both available width and height, refits on resize, and wheel-navigates one page at a time like `protected/PDF_Viewer.html`. It exports generic filenames. The output is rebuilt from page pixels plus a new selectable text layer made from pdf.js items that do **not** intersect any redaction. Automatic boxes contribute structure-preserving synthetic values: serials/MRNs retain character counts and punctuation (`ABC-12345` -> `XXX-00000`), dates retain ordering, separators, month-word style, and time punctuation (`Aug/16/2026` -> `Jan/01/2000`), and phone numbers retain their displayed pattern. An inline label/value item is rebuilt as the original label plus the synthetic value instead of a generic token. This keeps regex anchors and realistic value formats available to the extraction harness while preventing source selectable/hidden PHI, metadata, annotations, attachments, and layers from surviving. Automatic detection is only a first pass; every page must be reviewed, and scanned PDFs need manual boxes.

---

## Form / UI features (in `protected/CRM_Report_Generator.html`)

- **Auto-fill drop panel** accepts PDF (Medtronic/Boston) and `.log` (Abbott). Its `#pdp-merge` checkbox is hidden but live — it's the state behind the Import menu's **Merge** toggle (see the data-flow section).
- **Import toast** (`#pdp-status`, a fixed-position card under the app bar) — after a successful import it shows route/model/`N fields filled`, then after `PDP_LINGER` (6 s) **collapses to just the parser's `Verify:` list**, which stays until the **×** dismisses it. It obstructed the form at some window sizes, and the summary has no use once read. Hovering pauses the collapse and leaving re-arms it (never leave it paused — a stray hover stranding the card is the bug this fixed). **Errors never auto-clear**, and the transient "Reading…" line gets no ×. `setStatus(html, cls, keep)` — `keep` is the HTML that outlives the timeout.
  - **Nothing in the form is actually highlighted.** `setField` has never applied a review class, so that `Verify:` list is the *only* surface for parser uncertainty — which is why it survives the collapse. (The old copy said "review highlighted ones"; it was never true and was dropped.) If per-field highlighting is ever added, the list can safely go.
- **Force "New Patient" on every import** — `resetFormState()` clears the form in-memory (no page reload, which would abort the file read) so nothing from a prior patient lingers. (Skipped in merge mode.)
- **Lead-info table is verbatim**: editable Location, a **Manufacturer** column, free-text model/serial/implant-date; one row per scraped lead. (Aveir relabels these columns "Module …".) Rows are **removable** (× per row, `delLeadRow`) and addable (**+ Add Lead**, `addLeadRow`) — the importer scrapes abandoned leads too, and only the tech knows which are live.
- **Dynamic AV** Yes/No toggle with min/max fields (defaults No; importer flips it for true ranges).
- **% paced & AF burden are text inputs** and comparator-aware (`<1` survives instead of becoming `1`).
- **Aveir leadless mode** — picking the `Aveir` device type reveals RA/RV chamber checkboxes that drive the lead-info rows, per-module Longevity rows, and which pacing-% fields show (see Conventions above).
- **Episode logbook** — a **"Logbook / Free text"** radio (`ep-mode`, default Logbook) lets you either use the row-based table or type a single free-text block (`ep-freetext`). The logbook defaults to 1 row ("+ Add Episode" for more); a parser's `EPISODES` rows are written in automatically. **Observations** (`obs-yn` + `obs-text`) live at the bottom of this section.
  - Its section header carries a persistent **Since** date (`ep-since-date`) for the start of the interval represented by the episode counters/log. It is included in JSON, text, print and PDF outputs and can be filled by a future vendor parser through the normal `RESULT` contract.
- **Section layout — follows the in-room device-check flow:** Patient & Device · Battery / Device Status · Stored Episodes / Arrhythmia Log (+ Observations) · Lead / Electrode Measurements · Programmed Parameters · **Final Session Summary** (a merge of Reprogramming changes + Remote Monitoring + the Device Technician / Date-Completed sign-off, all under one header). Rationale: interrogate → review counters/episodes → run lead tests → confirm/adjust programming → sign off. Sidebar groups mirror this (Interrogation / Testing / Programming / Documentation).
- **Export buttons:** New Patient · Copy to Clipboard · Export .txt · **JSON** (a dropdown: Import / Export) · **PDF** (a dropdown: **Print** = browser print, **Save (PDF file)** = a real vector PDF built with jsPDF and saved like the JSON exports).
  - **JSON export/import** round-trips the whole form via `collectFormData()` / `applyFormData()`. It serializes the dynamic lead-table rows separately as `__leadinfo` (the cells have no id/name; blank rows aren't persisted — `setLeadInfoRows` would relabel a location-less row "Lead N" on restore and print it) and **excludes file inputs / auto-fill tool controls** (`pdp-*`, `json-import-file`) — those threw on import (you can't set `input[type=file].value`), which used to abort the whole restore. Import does a clean reset first.
  - **Save-location aware** — `saveFile()` uses `showSaveFilePicker` (desktop/Android Chrome → pick folder/USB), else `navigator.share` (iOS Safari → share sheet → "Save to Files"; shares the file **only**, no title/text, or iOS writes a stray `.txt`), else a classic download. The same path saves both JSON and the vector PDF; the export menu is closed in a `finally` (after the picker/share resolves) so the trigger element survives until the sheet presents.
  - **iPad share-sheet caveat** — on **iPad Safari**, `navigator.share` is a *popover* whose anchor iPadOS controls; with nothing focused it falls back to the page body (top-left, scrolling off as you scroll down). Mitigation: on iPad (`isIPad()`), focus a visible top-toolbar button right before sharing so the popover anchors on-screen. This is a Safari limitation, not web-fixable in general — **Chrome on iPad** wraps the sheet in its own centered UI and works regardless; iPhone shows a bottom sheet regardless. If reliable placement is ever required on iPad Safari, the fallback is a direct download (no popover).
- **Text/clipboard report** (`buildSummaryLines`) — a single **compact** format (the older labeled "Full" format was removed): single-space ` | ` pipes, no blank lines between sections, no `Mfr:`/`Model:` labels (manufacturer + model are joined), `SN:`/`Impl:` shorthand. BATTERY / STATUS folds onto ≤4 lines — Longevity|Battery · Function|Dependency|Rhythm · Mode|LRL|UTR|USR · pacing-% (BiV only when present). MEASUREMENTS are one line per lead: `RA Lead: 512 Ω | 2.9 mV | 0.7 V @ 0.4 ms` (Thr+PW merged). Empty AF Burden is omitted (no `—%` placeholder). FINAL SESSION SUMMARY carries Changes+Provider on one line and Remote Monitoring on one line. The *Device Technician* block is intentionally omitted (the EHR stamps it); the **PDF keeps it**.
  - **Episode rows** print tight under the counter line, unnumbered; each row is one pipe-separated line ending with any checked **flags** (`Longest, Fastest` …). **Notes print on their own line below the episode** as `    Notes: <text>` (4-space indent, like reprogramming rows), word-wrapped to ~78 cols with continuation lines aligned.
  - **Observations** render only when `obs-yn` = **Yes** (`N/A` is omitted entirely) as `Obs: <free text>`, word-wrapped by `wrapLines()` to the same right margin.
  - **Import-time normalizers** (in the app, *not* the parsers): lead-info implant dates from any vendor are normalized to `MM/DD/YYYY` (unparseable → verbatim), and all numeric measurement fields pass through one cleaner (units stripped, comparators like `<1` kept, `3,2`→`3.2`, `1,045`→`1045`).
- **PDF report** (vector, jsPDF): compact one-page-oriented layout; Provider on the patient line; Stored Episodes omitted when empty; renders the episode free-text block when that mode is active. The key/value `grid()` takes a **column count** — Patient & Device renders at **5 columns** and Programmed Parameters at **4** so each fits in 2 rows. Its `val()` looks up by `id` **then `name`**, so the battery-table inputs (Longevity, per-module RA/RV longevity, charge time) — which carry only a `name` — are no longer dropped from the PDF.
- Generated PDFs keep the stable internal database key `report.pdf`, but save/open/drag operations present them as **`LASTNAME_YYYY-MM-DD_CRM_Report.pdf`**, using the appointment date from the Schedule (and the form's interrogation date as the standalone-export fallback).
- Autosave to `localStorage` (key `crm-digital`, auto-expires after 24 h) — now including the lead table (`__leadinfo`); "New Patient" button clears + reloads.
- **Responsive layout** — below 820px the sidebar collapses, the auto-fill panel flows inline at the top of the form, dense field grids reflow, and wide tables scroll horizontally. The JSON/PDF menus live at body level (the app bar gets `overflow:auto` on mobile, which would clip them) and are **`position:fixed`, anchored in viewport coordinates** under the (fixed) app-bar button — `r.bottom + 4` with **no** scroll offset. (An earlier version used `position:absolute` + `pageYOffset`; mixing document coordinates with the share popover is what pushed the iOS share sheet off-screen when scrolled.)

---

## The other tools

### Landing pages (`index.html`, `protected/index.html`)

Both landing pages are **single self-contained static pages**: cards are hardcoded in the HTML, inline styles, and fonts are self-hosted in `vendor/fonts` (no Google Fonts at runtime). The public index has one small same-origin Access-session probe; the protected deck needs no auth script because Cloudflare gates the whole namespace. **Adding/editing a tool card is an edit in the page itself.** The old shared renderer (`home.js`) and theme (`assets/site.css`) were removed with this redesign (git history has them).

- `index.html` — public index (Public Sans + JetBrains Mono). The Mileage card is always public; the CRM and Developer Deck cards unlock together after the single protected-session probe succeeds.
- `protected/index.html` — developer deck, pirate-themed (Pirata One / Cinzel / Spectral, background `assets/dev-bg-crew.webp`). Lists all four tools. The `/protected` and `/protected/*` gates are Cloudflare Access, configured in the Cloudflare dashboard — nothing in this repo enforces them.

### Mileage Calculator (`mileage/index.html` + `mileage/mileage-sync.js`)

Logs clinic-coverage days (AM clinic → PM clinic) and computes reimbursable miles by the home-adjustment method: `(home→AM) + (AM↔PM leg) + (PM→home) − normal round-trip commute to the base clinic`, floored at 0. Up to 5 locations with per-user distances, drag-to-reorder log, config/profile JSON import-export, and a one-click **expense-form .xlsx** (xlsx-js-style embedded inline — no CDN). State lives in localStorage (`mileageToolV1`); new rows default to the **local** date (not UTC — that bug put evening entries on tomorrow).

**Cloud sync** is an optional layer in `mileage-sync.js`: username/passphrase accounts (invite-code gated), 12-hour JWT sessions, offline-first with a debounced push on every save, pull-then-reconcile on load, and last-write-wins conflict resolution keyed off a server-side version number. If `WORKER_URL` is blank the file does nothing and the page stays local-only.

The calculator deliberately lives outside `protected/`. Its optional Worker login belongs only to mileage sync and must never be replaced by or placed behind Cloudflare Access; the calculator remains usable without signing in and when the Worker is unavailable.

### Mileage sync backend (`mileage-backend/`)

Cloudflare Worker + D1 (`mileage-sync.spencer559.workers.dev`). One JSON blob per user, PBKDF2-SHA256 password hashing, HS256 JWTs, optimistic-concurrency writes (stale version → 409 with the server copy; `force:true` for a client-resolved LWW push), CORS restricted to the origins in `wrangler.toml` `ALLOWED_ORIGIN`. Secrets (`JWT_SECRET`, `INVITE_CODE`) are set with `wrangler secret put`; setup steps are in `DEPLOY.md`. **It only ever touches mileage data — no PHI.** The local `.wrangler/` cache is git-ignored.

### Developer dashboard (`protected/dashboard.html`)

Single-file command center behind the `/protected/` gate: clock + Open-Meteo weather (currently hard-coded to LA coords); Finnhub-powered watchlist, index strip and sector heatmap (bring your own free key, stored locally; requests are queued/paced/cached to respect the 60-calls-per-minute free tier); a device-check tally with 7-day history; clinical reference tabs (portals, a **Timing Lab** — ms⇄bpm + TARP/upper-rate calculators, EGM gain/sweep box-scale calculators, and a DDD timing-cycle simulator (static canvas marker-channel strip — simulates to steady state and redraws on any change — showing 1:1 tracking / pseudo-Wenckebach / 2:1 block / LRL pacing) — a **Tachy Lab** (zone/therapy planner: VT-1/VT/VF boundaries with detection and therapy sequences, SVT-discriminator limit, a color-banded rate ladder in bpm+ms, and a rate probe reporting zone / discriminator status / time-to-detect / therapy path) — measurement ranges, SVT–VT discriminators, patient alerts, troubleshooting, MRI lookups, magnet rates) plus an EGM marker glossary; notes and a to-do list. A **Modules** dropdown in the header (left of the panel filter) links to the other tools so the dashboard can serve as home base.

Persistence details worth knowing before editing:

- All state is localStorage. An optional **portable data file** (File System Access API, with the handle remembered in IndexedDB) mirrors it to a JSON file — e.g. on a USB stick — and auto-reconnects on load.
- The snapshot/restore is **whitelisted** to dashboard-owned keys (`watchlist`, `finnhubKey`, `notes`, `todos`, `viewMode`, `refTab`, `tachyLab`, `tally-*`). This matters: the dashboard shares an origin — and therefore localStorage — with the CRM tool's PHI autosave (`crm-digital`) and the mileage auth token, so an unfiltered mirror would write PHI into the data file. Don't widen the whitelist casually.
- Tally keys use **local** dates (`localISO()`), not `toISOString()` (UTC), so evening checks don't land on tomorrow's tally.
- Its CSP allows egress only to `api.open-meteo.com` and `finnhub.io`, and no third-party scripts run (TradingView widgets were removed for exactly this reason).

### Patient Schedule (`protected/Patient_Schedule.html`)

A daily device-clinic schedule behind the `/protected/` Cloudflare Access gate. Rows hold time, the patient's **full name**, manufacturer, device type, check type (in-clinic / remote / pre-op), a **last in-office check** date, a remote-monitoring connection status (Connected / Not connected / External clinic / N/A — "Not connected" rows are tallied in the count line and the printed header), and a notes line. A **"Move day…" dropdown** beside the date picker contains the destination date and confirmation controls; it reassigns an entire day to a different date (merge-confirm if the target day already has rows, and it moves that day's patient files too) — the fix for a schedule accidentally entered under the wrong date. Its CSP is `connect-src 'none'` like the CRM tool — nothing typed on the page can reach a network.

Workflow/storage: the schedule **and every patient's files** now live in a **single `.crmdb` database file** — see *The `.crmdb` database container* below for the full model. On Mac/PC it auto-saves in place as you edit; on iPad you press **Save** to write it back through the Files sheet. Data-lifetime is user-controlled **per database** via the **Memory** menu (retention window + Clear-all-past + a size readout; default is keep-everything — the old fixed 7-day purge is gone). Also: a header **All patients** overview, a manual **+ PDF** attach chip per row (for device types with no parser), plain JSON export/import, a dedicated **print view** (`@media print` day sheet — sorted by time, serif, count summary, "shred after use" footer), and a **"Leave Station"** action (now inside the Memory menu) that saves the database, wipes localStorage, and forgets the connection — the file keeps the data; only the browser is cleaned. Optional per-database password protection encrypts both the `.crmdb` file and its IndexedDB working copy entirely on-device; protected databases suppress the plaintext schedule localStorage mirror. There is deliberately no password recovery or server involvement. Never wire this page to the mileage sync Worker or any other backend.

**Reminders** (Aug 2026) is a second panel directly under the schedule: a running list of follow-ups the day generates — *"Call Doe, Jane about her ERI battery"*, *"Tell Dr. Smith that Roe, John stopped his blood thinners"*. Type it, press Enter, tick it off when it's done. Each entry is editable in place (a follow-up gets rewritten far more often than retyped), carries an age label once it's older than today (`yesterday`, `3d ago`, then a date), and completed ones sink to the bottom struck through — with a *Show completed* toggle and *Clear completed*. **Deliberately not per-day:** the list lives at `state.reminders`, *outside* `state.dates`, so stepping to another date never hides an outstanding task and the Memory retention window — which only ever prunes `state.dates` — can never quietly delete one. It rides in the same `schedule.json`, so it travels between stations with the rest of the database and syncs across tabs on the existing revision/broadcast path. It is also **not printed**: the day sheet is what goes out to the clinic, the reminder list is the tech's own. Covered by `tests/schedule-reminders.test.js`.

**Download patients** (beside *Print schedule*) is the bulk way out of the container. Nothing inside a `.crmdb` is reachable from a native file dialog — it is one ZIP — so a stored file used to leave only by being dragged out one at a time, which is impractical when a whole day has to be attached in Cerner. The button opens the OS **directory picker** (so the destination can be a USB stick or a network share as easily as Downloads) and writes:

```
<chosen folder>/<YYYY-MM-DD>/<Patient name>/<file>
```

Details worth keeping: the picker is opened **synchronously on the click**, before anything is awaited — awaiting first spends the transient user activation the File System Access API requires and the dialog never appears. Scope follows *Print schedule* (the current provider filter). Only the files the **Files** menu lists travel — the generated report plus raw programmer exports; `report.json` / `report.txt` stay behind as support files. `report.pdf` leaves under its chart name (`LASTNAME_<date>_CRM_Report.pdf`, the shared `chartReportFilename` rule); programmer exports keep their own filenames and their exact bytes. A patient whose report is open in the panel is finalized first, because their stored `report.pdf` is only as new as the last finalize. Folder names are sanitized for Explorer/Finder, patients with no files get no folder, and a name that appears twice in one day carries its appointment time so the two visits cannot overwrite each other. Firefox and iPad have no directory picker: there the identical tree is delivered as one `.zip` (`vendor/crmdb-zip.js`, STORE-only). Covered by `tests/patient-folder-export.test.js`.

### The `.crmdb` database container (`src/crmdb-store.js` + `vendor/crmdb-zip.js`)

Jul 2026 the shared USB workspace moved from a **live folder tree** (the old `src/workspace.js`,
which drove the File System Access **directory** API and was Chrome/Edge-desktop only) to a
**single portable file** — `schedule.crmdb` — so the same database works on **iPad** too
(iPadOS has no directory API at all). `workspace.js` is retired; both the Schedule and the CRM
tool now load `crmdb-store.js`. The original trigger was an NTFS bug — see the caveat at the end.

**Format.** An unprotected `.crmdb` is a standard **ZIP** (rename it to `.zip` and Finder/Explorer
opens it — fully recoverable without the app), written by `vendor/crmdb-zip.js`, a dependency-free
reader/writer (STORE on write with correct CRC-32s; inflates DEFLATE on read via the browser's
`DecompressionStream`). It's self-hosted because the pages run under `connect-src 'none'` /
`script-src 'self'` — no CDN allowed. The internal layout mirrors the old folder tree, so it's
still inspectable:

```
schedule.crmdb  (zip)
  manifest.json                                    {type, version, modified, fileCount}
  schedule.json                                    the Patient Schedule data (+ retentionDays — see Memory)
  patients/<YYYY-MM-DD>/<HHMM>_<NORMALIZED_PATIENT_NAME>/
    report.json  report.txt  report.pdf            CRM tool exports
    <vendor export>.pdf / .log                     raw programmer files (optional)
```

When password protection is enabled, the complete ZIP bytes are wrapped in a versioned binary
envelope and authenticated/encrypted with **AES-256-GCM**. The key is derived locally from the
password with **PBKDF2-HMAC-SHA-256** (unique 16-byte salt, 600,000 iterations); every save uses
a new random 12-byte IV, and the envelope header is authenticated as additional data. This uses
only the browser's built-in Web Crypto API: no password, key, or database content is uploaded.
The password is never stored. After a successful unlock, a temporary derived key is kept in
that tab's `sessionStorage`, allowing Schedule / Report Generator navigation without another
prompt. **Lock database**, closing the database, or closing the tab clears that session unlock;
the next open requires the password. Encrypted files cannot be recovered by renaming them to
`.zip`.

**Engine (`crmdb-store.js`).** It exposes the **same `window.CRMWorkspace` API the two pages
already called** (`connect`, `slotDir`, `readText`, `writeFile`, `listFiles`, `moveSlot`, `moveDate`,
`slotName`, `stored`, `permission`, `forget` …) but backed by an **in-memory
`bundle` = `Map<path, Blob>`** instead of live directory handles. Slot/file ops became map
reads/writes; `moveSlot` (renaming a slot when a row's time/patient name changes) and `moveDate`
(relocating every patient-folder prefix when Move Day changes the schedule date) became key
relabel; `readText` on a missing file rejects (so the CRM "new patient" catch still fires).
Because the API surface is unchanged, migrating the 2500-line CRM tool was mostly a script-swap.
**Cross-tab writes (`journal` + revision CAS).** Each tab holds its **own** `bundle`, and a save
serializes the **whole** bundle — so a plain write replaces whatever another tab committed. Two
tabs on one database (typically Schedule + Report Generator, the normal way this gets used) could
therefore silently revert a schedule edit, revert a report, or **delete a file** the other tab
attached (`serialize` only emits the paths the saving tab happens to hold). Every commit is now a
**compare-and-swap** against a `rev` counter stored beside the `bundle` key:

- `journal` (`path → Blob | null`) records what **this** tab changed since its last commit. All
  mutations go through `bset`/`bdel` — never `bundle.set`/`.delete` directly, or the change becomes
  invisible to the merge.
- Commit reads `rev` (one small key, **~0.3 ms**). Unchanged → straight write, the normal case and
  always true with one tab open. Moved → another tab wrote, so `adoptShared()` pulls the shared copy
  and replays **only journalled paths** on top. Replaying only touched paths is what stops a stale
  tab resurrecting a deleted file or deleting one it never saw.
- The re-read and both puts ride in **one** IDB transaction, so a tab that commits while we were
  serializing loses the CAS and retries instead of clobbering.
- **Nothing journalled and not `authoritative` → the commit is skipped entirely.** This is what
  stops an idle tab's `flush()` (e.g. on navigation) from republishing its stale bundle.
- `authoritative` (via `markAuthoritative()`) means "our bundle is a whole database we just
  opened/created/re-encrypted" — overwrite the shared copy rather than merge into it. Without it,
  opening a `.crmdb` would rebase onto, and therefore keep, the working copy it was meant to
  replace. The three protection paths set it too, and must `adoptShared()` **before** installing a
  new key (`ingest()` resets `protection` from the envelope it reads).
- Cost, measured in-browser on a 10.6 MB / 12-patient database: **43.2 ms** fast path (the serialize
  the code already paid, plus the 0.3 ms revision read) vs **63.5 ms** when a rebase is actually
  needed. The pre-existing whole-bundle serialize — ~95 ms on a 35 MB database, on a 1.2 s debounce
  while typing — is the real cost here, and is what to optimize if this ever gets slow.

**Cross-station freshness (`fileMeta`).** The revision CAS above only orders two **tabs on one
machine**. It says nothing about the other half of the problem: the same `.crmdb` sits on OneDrive
and gets edited from a second workstation, while each station's IndexedDB working copy lingers
between visits. A station reopening with an **older** cache used to flush it straight over the newer
file — which is how a day's schedule was lost moving Monterey Park → Arcadia. So the cache is pinned
to the file it came from (`baseFileMod`, `cacheMatchesFile`, persisted beside the bundle), and a
bound-file session starts **unverified**: until `verifyFreshness()` has compared the file to the
cache, `writeThroughToFile` refuses to write at all. File unchanged → keep the cache; file newer +
clean cache → the file silently wins; file newer + unsaved edits → the page's `onConflict` asks
which copy wins (file / keep mine / save mine aside then take the file).

- **A newer mtime does not mean someone else wrote it.** Chasing a "Database changed elsewhere"
  prompt that fired on the ordinary Schedule → Report Generator handoff: the newer file was **this**
  station's own autosave. A save is `commit` → file write → metadata write, and navigation tears the
  page down mid-chain, so the file moves forward while the recorded base does not. (OneDrive
  re-stamping the file after syncing it up does the same with identical bytes.) The store now
  **signs the bytes it puts on the file** — `pendingSig` written *before* the file write so even an
  interrupted save is recognizable, `baseSig` after it. On reconnect, a newer file whose content
  matches either signature is our own work: re-pin and carry on, local edits still pending. Only
  genuinely foreign bytes reach the conflict prompt.
- **One save at a time** (`enqueue`). Two overlapping save chains — the Schedule deletes a patient's
  files *and* writes `schedule.json` — interleaved their metadata writes, so IndexedDB could end up
  describing a state that never existed. `persist`/`flush`/`saveNow`/`verifyFreshness` now run one
  after another, and a navigation that waits on `flush()` waits for everything queued ahead of it.
- **`cacheMatchesFile` is earned, not assumed.** A write-through marks the cache clean only if the
  bundle's mutation counter hasn't moved since the snapshot was serialized; an edit made *during*
  the write stays unsaved work rather than being written off as already on disk.

The bundle **is** the one database, and it is:
- **serialized to the `.crmdb`** on save;
- **mirrored to IndexedDB immediately when opened and again on every change** (`crmdbStore` db,
  `bundle` + `rev` keys; edits are debounced) — this
  working copy is what carries state **across the two pages** on a full navigation, which is
  what makes the two-page handoff work on iPad (there's no persistent file handle there);
- on **desktop** (Chrome/Edge) additionally bound to a real `.crmdb` **file handle** (also stored
  in IndexedDB, so both same-origin pages share it) and **autosaved in place** — no button.

**Capability split.** `WS.canAutosave = !!showSaveFilePicker` (true on desktop Chromium). Desktop:
silent debounced autosave to the file + IndexedDB. iPad: the green **Save** button (`saveNow`)
hands the whole `.crmdb` to `navigator.share` → "Save to Files → USB" (falls back to a download),
and a `flush()` (IndexedDB-only, no download) runs before every cross-page navigation so the other
page opens the latest bundle. MIME types are re-assigned by extension on read, so a `report.pdf`
chip still opens inline after a round-trip strips the raw blob's type.

The custom PDF viewer's **Download** button uses the system **Save As** picker on supported
Chromium browsers, allowing a USB drive or any other folder to be selected. Browsers without the
File System Access picker retain the standard download-to-default-folder behavior.

**Schedule-side features built on the container:**
- **Database menu** (replaces the old dual "schedule file" + "USB workspace" menus): Open / New
  database, reconnect the remembered file, add/change/remove password protection, and Close
  database. A separate **Save** button
  ("Save now" on desktop, "Save database" on iPad) sits in the header; **Leave Station** moved
  into the **Memory** menu. Header order: Modules · All patients · Memory · Database · Save.
- **Memory menu** — a **per-database retention window** (`state.retentionDays`, stored **inside**
  the `.crmdb` so it travels with that specific file; `0`/absent = never). Options 1 / 3 / 7 /
  30 days / Never; on selection and on every open, rows **and their files** older than the cutoff
  are pruned (`WS.pruneFilesBefore` also catches orphaned files, so the file stays bounded). Plus
  a one-off **Clear all past data** and a live **size readout** (`WS.stats`). The old hard-coded
  7-day `purge()` on load was removed in favor of this.
- **All patients** overview (header button) — a searchable modal listing every appointment across
  all dates with a green file-count badge (`WS.slotFileCounts`); click a row to jump to that day.
- **Provider roster and day filter** — the schedule stores an ordered provider list inside the
  database, starting with **Tech**. The All Providers menu supports add, drag-to-reorder, and
  accessible up/down controls, plus deletion of non-Tech providers. **Tech cannot be deleted**;
  appointments assigned to a deleted provider automatically fall back to Tech. Each appointment
  has a Provider field between Device and Check type.
  The table gives provider names extra width and shortens display labels after 17 characters with
  an ellipsis (the stored name, roster, and printout remain complete). Filtering changes the visible
  day, counts, and printout without deleting or moving appointments.
- **Multi-tab schedule safety** — schedule revisions are announced across same-origin tabs. A tab
  with an older revision skips its pending write instead of replacing newer Cerner/provider/row
  edits, then reloads the committed IndexedDB working bundle from the tab that saved most recently.
  This is the *Schedule-side* guard (page-level, keyed on `schedule.json`'s own `_updatedAt`); the
  database-level guard that protects **any** two tabs — including CRM ↔ Schedule — lives in
  `crmdb-store.js`, below.
- **Files menu** on each row condenses the old chip list into one status button. It exposes only
  the two useful clinical links — the generated `report.pdf` and the raw programmer report — while
  JSON/TXT support files stay hidden. **Report ✓** appears in green only when a programmer report
  is attached; a generated report by itself reads **Generated**. The menu retains remove controls
  and the manual attach action for loop recorders, Aveir, S-ICD, or anything with no parser. Its
  **↓ Save original** control exports the stored `File` bytes directly (desktop save picker, iPad
  share sheet, or classic download fallback), so Abbott `.log` control delimiters and encoding are
  preserved byte-for-byte rather than passing through a text decoder.
  Won't clobber a generated `report.*` (an upload named `report.pdf` is stored `prog-report.pdf`).
- **Delete a patient** (the row ×) confirms only when the row is substantially filled
  (time + patient name + manufacturer + device + check all set) and **also removes that slot's files**
  from the database (`WS.removeSlotFiles`); a mostly-blank new row still deletes silently.
- UI: the page is a **scroll-locked shell** (`body{overflow:hidden}` + a `.main-scroll` pane) so
  the iPad share popover never drifts off-screen no matter how many rows exist; the table was
  compacted and **Notes is a wrapping, auto-growing textarea spanning the visible schedule width**;
  the header divider spans that same visible pane, and each row's delete control aligns with the
  Notes field's right edge. Each patient has a separate narrow
  **CRM** column for opening the Report Generator, while the compact Files status/menu preserves
  horizontal room on an iPad and leaves space for future columns.

**CRM-tool-side:** **Export ▸ Save database** force-rebuilds json+txt+pdf, then writes/downloads
the whole database as a backup (label follows the platform: "Save database now" on desktop, "Save
database to USB…" on iPad). It was a standalone app-bar button; it moved into the Export menu to
free the top-right slot for **Files**.

The app-bar **Files** menu lists the active patient's saved files and opens one in a new tab, so a
programmer PDF can be read side-by-side while the rest of the form is filled in. It mirrors the
Schedule's Files menu: only `report.pdf` (**Generated**) and the raw programmer export
(**Programmer**, listed first) — `report.json`/`.txt` are support files and stay hidden. It needs a
selected patient, not just an open database, so `updateFilesBtn()` hangs off `setPatientBtn()` (the
hook every slot change runs through).

**Drag-out to Cerner (why it exists).** A `.crmdb` is one ZIP, so **no native file dialog can see
the reports inside it** — Cerner's document upload can't browse to `report.pdf`. That's the
inherent cost of the single-file container. Rather than export PDFs to a folder and then have to
purge plaintext PHI, the Files rows are **draggable straight onto Cerner's upload** (`attachDragOut`).
Each drag sets **two** payloads because the plausible targets read different things: `items.add(File)`
populates `DataTransfer.files` (what a web drop zone reads) and `DownloadURL` is what the OS shell
honours when dropping on the desktop/Explorer. Verified under a real trusted dragstart:
`items.add` succeeds and `dataTransfer.types` becomes `["Files"]`. Nothing is written to disk, so
there is nothing to clean up. **If Cerner's uploader turns out to be an `<input type=file>` with no
drop zone**, drag can't help and the fallback is a remembered export folder (`showDirectoryPicker`
+ handle in IndexedDB — the pattern the retired `src/workspace.js` used) with an auto-purge, since
those exports are unencrypted PHI at rest. **`openStoredFile` must stay synchronous:** `window.open`
called from a promise callback has lost the click's user activation and gets popup-blocked (Safari
is strictest, and this runs on iPad), so `buildFilesMenu` resolves every `File` up front — the
bytes are already in memory, `getFile()` is only nominally async — and the click handler just does
`createObjectURL` + `window.open`. `getFile()` re-assigns the MIME by extension, which is what makes
a PDF render inline instead of downloading.

On **leave** (the Schedule button),
**patient-switch**, and **backgrounding** — whenever edits are pending (a `dirty` flag) —
`finalizeReports()` rebuilds the full report set (`report.json` + `report.txt` + `report.pdf`)
from the current form so the Schedule's chips are never stale; the cheap 1.5s live sync still
writes only `report.json` mid-edit. Patient List / Import / Export menus are otherwise unchanged,
now sourcing the patient list from the bundle's `schedule.json`. A `.crmdb` opened directly on the
CRM tool works the same as opening it on the Schedule (shared IndexedDB working copy + file handle).
When a scheduled patient has a pre-charted **Last Office** date, the Report Generator shows it in
the fixed app bar between the patient name and save status, including in the full split view.
When the Schedule opens a patient in a fresh browser session and the encrypted working copy is not
yet unlocked, the Report Generator now places a blocking **Patient database is locked** guard over
the form. Password entry happens directly in that guard (including an inline incorrect-password
retry), avoiding unreliable startup password popups on iPad. Unlocking uses the encrypted local
working copy directly; external-file permission affects desktop autosave but never blocks patient
loading. It also offers **Open database…** and
**Return to Schedule**, and does not allow report entry to begin against an unlinked blank form.

**NTFS caveat** — the bug that started all this: macOS and
iPadOS mount **NTFS read-only**, so *every* write fails there regardless of mechanism (the original
"could not be modified due to the state of the underlying filesystem" error). Format the stick
**exFAT** for cross-device read-write. A single `.crmdb` (vs. thousands of loose files) is also far
friendlier to USB/sync filesystems. The Schedule's **Leave Station** saves the database, wipes
localStorage, and forgets the connection.

---

## Security / hosting

- **Self-hosted libraries** — `vendor/pdf.min.js` + `pdf.worker.min.js` (pdf.js v3.11.174) **and** `jspdf.umd.min.js` + `jspdf.plugin.autotable.min.js` (the vector-PDF generator) are committed to the repo; nothing is pulled from a CDN at runtime. `engine.js` derives the worker URL from the page's own `pdf.min.js` `<script>` tag (and respects a `workerSrc` the page set explicitly), so no third-party script ever runs in the same context as PHI.
- **Content-Security-Policy** — the app HTML ships a `<meta http-equiv="Content-Security-Policy">` whose key directive is `connect-src 'none'`: the page cannot make *any* network request, so PHI cannot be exfiltrated. `script-src`/`style-src` keep `'unsafe-inline'` only because the form uses inline handlers + `<script>` blocks (that allowance grants no network egress); `worker-src 'self' blob:` lets the local pdf.js worker run.
- **Per-page CSPs across the origin** — every page on this origin shares localStorage with the CRM autosave, so each ships its own CSP: the Mileage Calculator's `connect-src` permits only the sync Worker, and the dashboard's only its two data feeds (Open-Meteo, Finnhub). No page may load third-party scripts.
- **HTTP security headers** — the root `_headers` file makes Cloudflare Pages send real headers on every response: `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` (the Schedule embeds the CRM and PDF viewer from the same origin), `nosniff`, `Referrer-Policy: no-referrer` (outbound portal clicks don't leak URLs), a locked-down `Permissions-Policy`, and HSTS. The per-page meta CSPs remain as defense-in-depth.
- **CRM autosave retention** — the `crm-digital` autosave carries a `__savedAt` stamp; saves older than **24 h** are cleared on load instead of restored (the autosave exists to survive a refresh mid-visit, not to store records).
- **Hosting** — Cloudflare Pages (`device-tech.pages.dev`), with only `/protected` and `/protected/*` behind Cloudflare Access. `/mileage/` must remain outside every Access application. The old GitHub Pages origin is kept in the Worker's `ALLOWED_ORIGIN` during the transition; drop it once disabled. Exact dashboard steps are in `docs/cloudflare-access.md`.
- **Still out of scope (deployment-level):** access controls on the public tools, audit logging, encryption at rest (localStorage + downloaded files are plaintext), and the fact that a public static host is not automatically HIPAA-eligible. See any compliance review before clinical use.

---

## Current status

**Working & verified against real (redacted) reports:**
- Medtronic PPM / ICD / CRT (incl. MVP, dynamic two-column split, verbatim inventory, Therapy-Summary-scoped pacing % with CRT `Total VP` / `Effective`→BiV; validated on Azure dual + Cobalt XT CRT).
- Boston PPM-DC / ICD-DC / CRT-D / CRT-P (incl. quadripolar LV, dynamic AV, comparators, shock-based routing, and episode/arrhythmia-log mapping → HVR / AHR (prefers the `AT/AF Events` total, falls back to the bucket sum) + Longest AT/AF row).
- Abbott PPM-DC / ICD-DC / CRT-D / CRT-P via `.log` (Fortify / Gallant DR/HF / Quadra Allure/Assure families).
- Biotronik dual-chamber **PPM** via both report layouts (Home-Monitoring + Standard/BIOSTD); per-character text handling, horizontal lead inventory, diagnostics/episode import, A/V column split, and lead measurements scoped to the "Test results" block so an unmeasured (`-----`) chamber stays blank instead of inheriting the programmed pulse width.
- **Aveir** dual-chamber leadless — manual entry only (no importer), with per-module lead rows, longevity, and pacing % driven by the RA/RV chamber checkboxes.
- **JSON export/import** round-trips a full record (incl. the lead table); **pdf.js self-hosted** under a strict CSP (no network egress).
- **Workflow / UI:** merge-import (keep live-typed data), episode logbook ↔ free-text toggle, merged **Final Session Summary** section, save-location-aware exports (desktop picker / iOS share sheet), and a mobile-fixed JSON menu.
- **Patient Schedule** (full-name day sheet, print view, walk-away wipe) behind the `/protected/` gate — now backed by the `.crmdb` container (below) with per-database Memory retention, an All-patients overview, and manual PDF attach.
- **`.crmdb` single-file database (Jul 2026):** the shared USB workspace was rebuilt from a live folder tree into one portable ZIP (`schedule.crmdb`) so the Schedule **and** the CRM Report Generator work on **iPad** as well as desktop. New `src/crmdb-store.js` (CRMWorkspace API over an in-memory bundle + IndexedDB cross-page copy + desktop file-handle autosave / iPad share-sheet save) and `vendor/crmdb-zip.js` (dependency-free, CSP-safe ZIP). Verified headlessly in Node: bundle round-trips (valid zip per `unzip -t`), slot moves/renames, file counts, retention pruning, per-database `retentionDays` persistence, delete-with-files, and the two-page handoff sequence. Browser click-through (iPad share sheet, desktop reconnect) has since been confirmed on real hardware.
- **Vendor detection rewritten (Jul 2026):** a Boston Scientific report carrying an **Abbott / St. Jude RV lead** was detected as Abbott and refused to import — `guessVendor` joined every page into one string and took the *first* matching signature, and `boston.js` reads the Leads table verbatim by design, so one foreign lead row decided the routing (Abbott sits higher in the list, and Abbott has no PDF parser → hard dead end). `Engine.scoreVendors` now ranks vendors by **page spread**: a report's own brand repeats in the page furniture on every page, a foreign lead is one cell on one page. The importer also gained a **"Parse as:" override** (buttons in the status box that re-parse the cached text) so no misdetect can wall off the auto-fill again, the Abbott dead end now points at the Merlin `.log` export, and the parsers' dead `sig` regexes — which had drifted a full 10 Boston families ahead of the engine — are gone. Covered by `tests/vendor-detect.test.js`.
- **Latency overhaul (Jul 2026):** committing re-serialized the **whole** database and wrote it into the shared IndexedDB working copy, and both pages did that on their typing debounce — so every ~1.5s pause cost a multi-megabyte round trip, and it got worse the bigger the `.crmdb` grew. Four changes, all of them about *when* and *how much*: (1) an edit now **stages** into the in-memory bundle (`{ defer: true }` on `writeFile` / `createWritable`), which is free; (2) new `src/crmdb-commit-cadence.js` owns **when** staged edits publish — at most once every 30s, plus an immediate commit on every deliberate exit (patient switch, Save, tab-hide, pagehide, unload). Continuous typing can't starve it, because `stage()` deliberately does *not* restart an in-flight timer; and one page exit is **one** commit even though a browser fires up to three teardown events for it, so a page that claims its own teardown work isn't doubled up. The cadence window is therefore only ever exposed by a hard crash, never a normal close. (3) a commit costs the **delta** rather than the whole database — unchanged entries are carried by reference instead of re-deflated; (4) `CRMDB.readBlob` reads a container we wrote ourselves **by reference** — nothing but the central directory is parsed and each entry comes back as a `blob.slice()` view, so a page load holds one copy of the database instead of the two or three `read()` materialized. Anything unfamiliar (a DEFLATE entry, a layout whose local headers don't tile) falls back to `read()`. Covered by `tests/crmdb-commit-cadence.test.js`, `crmdb-commit-cost.test.js`, `crmdb-deferred-write.test.js`, `crmdb-zero-copy-read.test.js`.
- **Remote-monitoring status shared between the two pages (Jul 2026):** the Schedule's **Remote** precharting column and the Report Generator's Final Session Summary **Status** dropdown are one field, not two — it travels in the schedule row (`r.rm`) inside `schedule.json`. Opening a patient pulls the precharted value into the form (the schedule wins, since that's where precharting happens; if it's blank and the report has a value, the schedule is seeded instead so the two never disagree), and changing it in the report writes back, bumps `schedule.json`'s revision stamp and broadcasts a `committed` message — otherwise an open Schedule tab would treat its own copy as newer and put the old value straight back. Covered by `tests/crmdb-schedule-rm-share.test.js`. **Coupling to keep in mind:** the `RMS` list in `protected/Patient_Schedule.html` and the `#rm-status` `<select>` in `protected/CRM_Report_Generator.html` must stay in step (both carry a comment saying so).
- **Site passover (Jul 2026):** dashboard data-file snapshot/restore whitelisted to dashboard-owned keys (a full-localStorage mirror was writing the CRM PHI autosave into exports); tally + mileage "Add day" switched to local dates (UTC `toISOString` rolled evening entries to tomorrow); Mileage Calculator got a CSP matching the other pages; `mileage-backend/.wrangler/` untracked and git-ignored.

**Known gaps / TODO ideas:**
- Abbott PDF (scanned image) is **not** supported — `.log` only. (OCR would be the only PDF route.)
- Abbott individual episode rows and nonzero AF burden cannot be derived from the tested `.log` exports. AHR and ICD VT/VF aggregate counters, zero burden, and a common last-cleared date are supported.
- Abbott CRT ventricular percentages use the lifetime RVP/LVP/BP compartments; non-CRT V paced uses the recent Event-Histogram value.
- A few Abbott edge cases (legacy/other-manufacturer leads) may leave a lead model blank (serial still captured).
- Boston **single-chamber** and several less-common families are scaffolded but not validated with real exports.
- **Biotronik** parser handles two report layouts (Home-Monitoring + Standard/BIOSTD), each validated against a dual-chamber PPM; ICD/CRT and single-chamber Biotronik are unverified.
- Lead-table cells have no `id`/`name`, so they're saved/restored via the dedicated `__leadinfo` array (handled — autosave + JSON now persist the lead table). Anything else without an id/name would still be missed by the generic serializer.

---

## Testing / continuing the work

- **Manual:** open `protected/CRM_Report_Generator.html` locally (or on the Pages site) and drop a vendor PDF or Abbott `.log` on the "Auto-fill" panel.
- **PDF authoring:** use `tools/CIED PDF Extraction Harness.html` to dump a PDF's text items, then write/adjust anchors in the vendor parser under `src/parsers/`.
- **Node tests:** `npm test` (or `node tests/run.js`) runs the whole suite. The runner gives each
  `tests/*.test.js` its **own child process** on purpose — every file installs its own fake
  `window` / `document` / `indexedDB` into the Node global scope and re-`require`s
  `src/crmdb-store.js` to simulate a separate tab, so they cannot share a process without
  contaminating each other. Run a single file directly (`node tests/crmdb-multitab.test.js`) when
  you're iterating on one.

  | Test | What it pins down |
  |---|---|
  | `crmdb-encryption` | password round-trips |
  | `crmdb-multitab` | two tabs sharing one working copy — the journal/revision-CAS guard |
  | `crmdb-freshness` | a stale station cache must never overwrite a newer OneDrive file |
  | `crmdb-selfwrite` | the other direction: this station's own saves — including one interrupted by navigation — must never be *mistaken* for another station's, while a real foreign edit still raises the conflict prompt |
  | `crmdb-handoff` | the two-page handoff: what one page commits, the other reads |
  | `crmdb-deferred-write` | a staged (`{ defer: true }`) write costs no serialization, and is readable immediately |
  | `crmdb-commit-cadence` | *when* staged edits publish — typing can't starve the cadence, one page exit is one commit across all three teardown events, an idle exit costs nothing |
  | `crmdb-commit-cost` | a commit re-deflates only what changed, not the whole database |
  | `crmdb-zero-copy-read` | `readBlob` hands back `blob.slice()` views, and falls back to `read()` on any layout it didn't write |
  | `crmdb-schedule-rm-share` | the remote-status field stays one value across both pages |
  | `vendor-detect` | `Engine.scoreVendors` / `guessVendor` — a foreign lead row can't outvote the report's own brand |

  No npm install: `crmdb-store.js` exports itself under `module.exports`, a fresh `require` is a
  fresh "tab" (or a fresh page load), and the tests ship a ~40-line in-memory IndexedDB shim to keep
  the repo dependency-free. Each fails loudly against the store it was written for.

  One thing to know when writing a *timing* test here: `setTimeout` has a ~15.6ms floor on Windows,
  so a loop of `await wait(4)` takes roughly four times as long as it reads. Derive any bound on
  "how many times did this fire" from a measured `Date.now()` delta rather than from the nominal
  delay — see the top case in `crmdb-commit-cadence.test.js`.
- **Headless checks:** the parser logic is plain JS and can be exercised in Node by `eval`-ing the vendor file (with `globalThis.window = globalThis`) and feeding it a reconstructed `LINES` array (PDF) or raw `.log` text — the fastest way to verify a change against a sample before clicking through the form. UI-logic changes can be checked with jsdom (load the app HTML, stub `IntersectionObserver`, drive the functions).

### To add a new vendor
1. Add a parser file under `src/parsers/` exposing `runMap(LINES)` (PDF) or a text entry point (like Abbott's `runLog`), returning the `{RESULT, LEADS, ROUTE, ORDER, GOTCHAS}` bundle (optionally `EPISODES`) with the field keys above.
2. Register it: PDF vendors go in `Engine.VENDORS` + the `PARSERS` map in the app HTML; a text format gets its own branch in `handleFile`. `engine.js` is the **only** detection list — parser modules deliberately carry no signature of their own (two lists drift, and they did). A `VENDORS` entry is `{ name, strong, weak }`: `strong` = company / remote-system names that print in the page header or footer, written as separate `|` alternatives (`scoreVendors` counts how many distinct ones matched); `weak` = device family names, which are only suggestive because a family name can also appear in a lead row.
3. Add the `<script src="../src/parsers/yourvendor.js">` include in `protected/CRM_Report_Generator.html` (after `../src/engine.js`).

---

## Privacy note

This repo is **public** and the site is served from Cloudflare Pages (`device-tech.pages.dev`); only `/protected` and `/protected/*` sit behind Cloudflare Access.
- Keep patient data (names, DOBs, device serial numbers, raw vendor exports) out of anything committed. Sample/scratch files used for testing should stay local or be `.gitignore`d (currently `Info.txt`, `Abbott Test Cases/`, and `mileage-backend/.wrangler/`).
- The app itself never transmits data — all parsing happens in the browser, pdf.js is self-hosted, and the CSP's `connect-src 'none'` blocks every network request (see **Security / hosting**).
- This covers only what the page controls. Hosting, access control, audit logging, and encryption at rest are deployment concerns a compliance review must address before clinical use.
