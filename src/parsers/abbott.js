/* =====================================================================
   ABBOTT / ST. JUDE MEDICAL (Merlin .log)  ->  CRM field map
   ---------------------------------------------------------------------
   Abbott's PDF is a scanned IMAGE (no selectable text), so the PDF path
   can't read it. Merlin can instead export a ".log" — a flat key-value
   text dump, one parameter per line:

       <code><Parameter Name><Value>
       301ModeDDD
       512Atrial Pacing Lead Impedance325.0Ohm

   The stable key is the leading numeric CODE (301 = Mode, 512 = Atrial
   impedance, …). There is no delimiter, and some parameter NAMES start
   with a digit ("2:1 Block Rate"), so we can't split on "leading digits"
   alone. Instead each field is looked up by its exact code+name PREFIX
   and the trailing text is the value.

   Entry point is runLog(text) (not runMap(LINES) — the input is text, not
   a coordinate PDF). It returns the same bundle the form/auto-fill expects:
       { RESULT, GOTCHAS, LEADS, ROUTE, ORDER }
   FIELD KEYS match the other vendors; the manufacturer radio value is "Abbott".
   ===================================================================== */
(function (global) {
  'use strict';

  var DROPDOWN_MODES = ['AAI', 'AAIR', 'VVI', 'VVIR', 'DDD', 'DDDR', 'DDI', 'DDIR', 'VDI', 'VDIR', 'AOO', 'VOO', 'DOO', 'OOO'];
  var ORDER_DUAL = ['pt-name', 'pt-dob', 'pt-mrn', 'pt-date', 'dev-implant', 'pt-provider', 'mfr', 'dtype', 'dev-model', 'dev-serial', 'bat-lon-cur', 'bat-lon-unit', 'bat-cc-cur', 'pct-a', 'pct-v', 'pct-lv', 'pct-biv', 'p-mode', 'p-lrl', 'p-utr', 'p-usr', 'dyn-av', 'p-sav', 'p-sav-hi', 'p-pav', 'p-pav-hi', 'p-ms', 'p-msrate', 'lead-ra-imp', 'lead-ra-sens', 'lead-ra-thr', 'lead-ra-pw', 'lead-rv-imp', 'lead-rv-sens', 'lead-rv-thr', 'lead-rv-pw', 'lead-rv-coil-imp', 'lead-svc-coil-imp', 'ep-since-date', 'ep-af-burden', 'ep-ahr', 'ep-hvr', 'obs-yn', 'obs-text', 'rp-chg', 'sig-date'];

  // strip a BOM and any null bytes (UTF-16 leftovers). Built from escaped strings so the source
  // stays pure ASCII — no literal control characters.
  var JUNK = new RegExp('[\\uFEFF\\u0000]', 'g');

  function num(s) { var m = String(s == null ? '' : s).match(/-?\d+\.?\d*/); return m ? m[0] : ''; }
  // Abbott dates are "MM/DD/YYYY 00:00:00".
  function aToISO(s) { var m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? (m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0')) : ''; }
  function aDate(s) { var m = String(s).match(/\d{1,2}\/\d{1,2}\/\d{4}/); return m ? m[0] : ''; }   // raw date (no time) for the lead table

  /* ---------- device routing ----------
     Decided structurally, not by model name (which is unreliable): an LV lead => CRT, and shock
     evidence (HV-lead impedance / shock configuration / capacitor charge) => defibrillator. So
     CRT + shock = CRT-D, CRT without shock = CRT-P; non-CRT + shock = ICD, else pacemaker. */
  function detectDevice(model, hasA, hasV, hasLV, hasShock) {
    var m = model || '';
    if (/Aveir/i.test(m)) return { family: 'leadless', dtype: 'Aveir', label: 'Leadless (Aveir)' };
    if (hasLV) return hasShock ? { family: 'crt', dtype: 'CRT-D', label: 'CRT-D (BiV ICD)' } : { family: 'crt', dtype: 'CRT-P', label: 'CRT-P (BiV pacemaker)' };
    var dual = hasA && hasV;
    if (hasShock) return dual ? { family: 'dual', dtype: 'ICD-DC', label: 'Dual-chamber ICD' } : { family: 'single', dtype: 'ICD-SC', label: 'Single-chamber ICD' };
    return dual ? { family: 'dual', dtype: 'PPM-DC', label: 'Dual-chamber PPM' } : { family: 'single', dtype: 'PPM-SC', label: 'Single-chamber PPM' };
  }

  function runLog(text) {
    // Merlin .log is FS-DELIMITED: each line is
    //     code <FS> name <FS> value <FS> unit <FS>
    // where <FS> is the ASCII File Separator (0x1C). (Pasted into a normal editor those
    // separators are invisible, which is why "2.0V" looked concatenated — it's "2.0<FS>V".)
    // Strip BOM/null bytes, split into lines, split each line on <FS>, and key the value (field 3)
    // by its numeric CODE, which is unique per line.
    var FS = String.fromCharCode(28);
    var MAP = {};
    String(text).replace(JUNK, '').split(/\r\n|\r|\n/).forEach(function (line) {
      var p = line.split(FS);
      if (p.length < 3) return;                    // need at least code, name, value
      var code = p[0].trim();
      if (!/^\d+$/.test(code)) return;
      MAP[code] = { v: (p[2] || '').trim(), u: (p[3] || '').trim() };
    });
    // value for a parameter code. (The `name` arg just documents what the code is — lookup is by code.)
    function field(code, name) { return MAP[code] ? MAP[code].v : ''; }
    function unit(code) { return MAP[code] ? MAP[code].u : ''; }
    // first non-empty value among candidate codes — Abbott uses different codes for, e.g., an
    // SJM RV pace/sense lead (2461) vs its "Other" model (2462) vs a defib RV lead (2449/2450).
    function first() { for (var i = 0; i < arguments.length; i++) { var r = MAP[arguments[i]]; if (r && r.v) return r.v; } return ''; }

    var RESULT = {}, LEADS = [], EPISODES = [], GOTCHAS = [], ROUTE = {};
    function set(f, label, v, status, note) {
      RESULT[f] = { label: label, field: f, v: (v == null ? '' : String(v)), src: '.log', status: v ? (status || 'auto') : 'empty', note: note || '' };
    }

    /* ---------- routing ---------- */
    var model = field(200, 'Device Model Name');
    var mode = field(301, 'Mode');
    var hasA = !!field(2468, 'Atrial Lead Serial Number') || /^(A|D)/.test(mode);
    var hasV = !!first(2470, 2469) || /^(D|V)/.test(mode);                 // RV serial: pace/sense (2470) or defib (2469)
    var hasLV = !!field(2471, 'LV Lead Serial Number') || !!field(2720, 'LV Pacing Lead Impedance');
    var hasShock = !!field(2730, 'HV Lead Impedance') || !!field(2265, 'Shock Configuration') || !!field(2745, 'Last HV Cap Charge Duration');
    ROUTE = detectDevice(model, hasA, hasV, hasLV, hasShock);

    /* ---------- identity ---------- */
    set('pt-name', 'Patient Name', field(2430, 'Patient Name'));
    set('pt-dob', 'Date of Birth', aToISO(field(2431, 'Patient Date of Birth')));
    set('pt-mrn', 'MRN / ID', field(204, 'Patient ID'), 'review', 'Blank in export — pull from EHR.');
    set('pt-date', 'Interrogation Date', aToISO(field(203, 'Device Last Interrogation Date and Time')));
    set('dev-implant', 'Implant Date', aToISO(field(2442, 'Implant Date: Device')));
    set('pt-provider', 'Provider / Physician', field(2432, 'Follow-up Physician'));
    RESULT['mfr'] = { label: 'Manufacturer', field: 'mfr', v: 'Abbott', src: 'vendor', status: 'auto', note: '' };
    RESULT['dtype'] = { label: 'Device Type', field: 'dtype', v: ROUTE.dtype, src: 'from model', status: ROUTE.dtype ? 'auto' : 'review', note: ROUTE.dtype ? '' : 'Set device type manually.' };
    set('dev-model', 'Model', model);
    set('dev-serial', 'Serial #', field(202, 'Device Serial Number'));
    var lon = field(533, 'Longevity Estimate');
    set('bat-lon-cur', 'Battery Longevity', num(lon));
    RESULT['bat-lon-unit'] = { label: 'Longevity Unit', field: 'bat-lon-unit', v: /mo/i.test(unit(533)) ? 'months' : 'years', src: '.log', status: lon ? 'auto' : 'empty', note: '' };
    var chg = field(2745, 'Last HV Cap Charge Duration');                  // ICD/CRT-D only
    if (chg) set('bat-cc-cur', 'Cap. Charge Time (s)', num(chg), 'review', 'Last HV capacitor charge — confirm the charge date in the report.');

    /* ---------- pacing % ---------- */
    var pa = field(2682, 'Event Histogram Percent Paced In Atrium');
    var pv = field(2681, 'Event Histogram Percent Paced In Ventricle');
    set('pct-a', 'A Paced %', num(pa), 'review', 'Event Histogram % (recent). Lifetime A-paced = ' + (field(2708, 'Atrial Paced - Lifetime') || 'n/a') + '.');
    if (ROUTE.family === 'crt') {
      // Abbott splits CRT ventricular pacing into mutually exclusive lifetime event classes:
      // right-ventricular-only (RVP), left-ventricular-only (LVP), and biventricular (BP).
      // The generic Event Histogram ventricular value is their combined total and must not be
      // copied into the form's RV-only field.
      set('pct-v', 'RV Paced %', num(field(2709, 'Ventricular Paced - Lifetime (RVP)')), 'review', 'Abbott lifetime RVP compartment.');
      set('pct-lv', 'LV Paced %', num(field(2710, 'Ventricular Paced - Lifetime (LVP)')), 'review', 'Abbott lifetime LVP-only compartment.');
      set('pct-biv', 'BiV Paced %', num(field(2711, 'Ventricular Paced - Lifetime (BP)')), 'review', 'Abbott lifetime biventricular-paced compartment.');
    } else {
      set('pct-v', 'V Paced %', num(pv), 'review', 'Event Histogram % (recent). Lifetime RVP = ' + (field(2709, 'Ventricular Paced - Lifetime (RVP)') || 'n/a') + '.');
    }

    /* ---------- mode & rates ---------- */
    set('p-mode', 'Mode', mode);
    set('p-lrl', 'Lower Rate (LRL)', num(field(302, 'Base Rate')));          // Abbott "Base Rate" = LRL
    set('p-utr', 'Upper Track (UTR)', num(field(323, 'Maximum Tracking Rate')));
    set('p-usr', 'Upper Sensor (USR)', num(field(406, 'Maximum Sensor Rate')));
    set('p-sav', 'Sensed AV', num(field(337, 'Sensed AV Delay')));
    set('p-pav', 'Paced AV', num(field(322, 'Paced AV Delay')));
    var rrav = field(320, 'Rate Responsive AV Delay');
    RESULT['dyn-av'] = { label: 'Dynamic AV?', field: 'dyn-av', v: /on/i.test(rrav) ? 'Yes' : 'No', src: '.log', status: 'auto', note: /on/i.test(rrav) ? 'Rate-Responsive AV Delay is On (dynamic).' : '' };
    var ams = field(339, 'Auto Mode Switch');
    RESULT['p-ms'] = { label: 'Mode Switch', field: 'p-ms', v: ams ? 'On' : '', src: '.log', status: ams ? 'auto' : 'empty', note: ams ? ('Auto Mode Switch to ' + ams + '.') : '' };
    set('p-msrate', 'Mode Switch Rate', num(field(340, 'Atrial Tachycardia Detection Rate')), 'review', 'Atrial Tachycardia Detection Rate (AMS trigger). Verify.');

    /* ---------- lead measurements ---------- */
    set('lead-ra-imp', 'RA Impedance (Ω)', num(field(512, 'Atrial Pacing Lead Impedance')), 'review', 'Verify against report.');
    set('lead-ra-sens', 'RA Sensing P-wave (mV)', num(field(2721, 'Atrial Signal Amplitude')), 'review', 'Verify against report.');
    set('lead-ra-thr', 'RA Threshold (V)', num(field(1610, 'A. Capture Test Threshold Amplitude')), 'review', 'Capture-test threshold. Verify.');
    RESULT['lead-ra-pw'] = { label: 'RA Pulse Width (ms)', field: 'lead-ra-pw', v: num(field(1611, 'A. Capture Test Pulse Width')), src: '.log', status: 'auto', note: '' };
    set('lead-rv-imp', 'RV Impedance (Ω)', num(field(507, 'RV Pacing Lead Impedance')), 'review', 'Verify against report.');
    set('lead-rv-sens', 'RV Sensing R-wave (mV)', num(field(2722, 'Ventricular Signal Amplitude')), 'review', 'Verify against report.');
    set('lead-rv-thr', 'RV Threshold (V)', num(field(1606, 'RV. Capture Test Threshold Amplitude')), 'review', 'Capture-test threshold. Verify.');
    RESULT['lead-rv-pw'] = { label: 'RV Pulse Width (ms)', field: 'lead-rv-pw', v: num(field(1607, 'RV. Capture Test Pulse Width')), src: '.log', status: 'auto', note: '' };
    // ICD/CRT-D shock coil impedance (HV Lead Impedance) — Abbott reports a raw float; round it.
    var hv = field(2730, 'HV Lead Impedance');
    if (hv) {
      var hvNum = parseFloat(num(hv));
      var cfg = field(2265, 'Shock Configuration');
      set('lead-rv-coil-imp', 'RV Defib / Coil Impedance (Ω)', isNaN(hvNum) ? num(hv) : String(Math.round(hvNum)), 'review', 'Shock-coil (HV) impedance' + (cfg ? ' — ' + cfg : '') + '. Verify.');
    }
    // CRT LV pacing lead measurements
    var lvImp = field(2720, 'LV Pacing Lead Impedance');
    if (lvImp) {
      set('lead-lv-imp', 'LV Impedance (Ω)', num(lvImp), 'review', 'Verify against report.');
      set('lead-lv-thr', 'LV Threshold (V)', num(field(1616, 'LV. Capture Test Threshold Amplitude')), 'review', 'Capture-test threshold. Verify.');
      RESULT['lead-lv-pw'] = { label: 'LV Pulse Width (ms)', field: 'lead-lv-pw', v: num(field(1617, 'LV. Capture Test Pulse Width')), src: '.log', status: 'auto', note: '' };
    }

    /* ---------- lead inventory (verbatim) ----------
       Abbott uses different codes depending on lead type. RV especially: a pace/sense lead
       (PPM / CRT-P) uses 2460/2461or2462/2470/2463, while a defib lead (ICD / CRT-D) uses
       2448/2449or2450/2469/2451. Model can also be "SJM …" (2461) vs "Other …" (2462), and a
       non-SJM lead only ever fills the "Other" code. Resolve each cell from
       its candidate codes. */
    function pushLead(loc, mfr, model, serial, date) {
      if (!model && !serial) return;
      LEADS.push({ location: loc, manufacturer: mfr, model: model, serial: serial, date: aDate(date) });
    }
    pushLead('Atrial', field(2456), first(2457, 2458), field(2468), field(2459));
    pushLead('RV',     first(2460, 2448), first(2461, 2462, 2449, 2450), first(2470, 2469), first(2463, 2451));
    pushLead('LV',     field(2464), first(2465, 2466), field(2471), field(2467));

    /* ---------- stored-episode summary ----------
       The .log contains aggregate counters and diagnostic-clear dates, but none of the individual
       log rows (episode date/time, duration, or peak rate). Therefore EPISODES intentionally stays
       empty: choosing a recent/longest episode from these exports would require inventing data. */
    var ahr = field(2754, 'Total Number of AT/AF Episodes Since Last Cleared');
    if (ahr !== '') set('ep-ahr', 'AHR (AT/AF/AFl)', num(ahr), 'review', 'Total AT/AF episodes since diagnostics were last cleared.');
    var hvr = field(2630, 'Total Number of VT/VF Episodes');
    if (hvr !== '') set('ep-hvr', 'HVR (VT/VF/NS-VT)', num(hvr), 'review', 'Total VT/VF episodes since tachy diagnostics were last cleared; NSVT is not included in this export counter.');

    var atrialClear = aToISO(field(2750, 'AT/AF Last Cleared Date'));
    var tachyClear = aToISO(field(2642, 'Tachy Episodal Diagnostic Date and Time Last Cleared'));
    // The form has one shared Since field. Fill it only when the available atrial and ventricular
    // diagnostic intervals agree (or when only one interval is exported).
    var episodeSince = atrialClear && tachyClear && atrialClear !== tachyClear ? '' : (atrialClear || tachyClear);
    if (episodeSince) set('ep-since-date', 'Stored Episodes Since', episodeSince, 'auto', 'Abbott diagnostic last-cleared date.');

    // Code 2755 is a raw, unitless "Total Time in AT/AF Recent Week", not the device's displayed
    // since-clear burden percentage. Zero time proves a 0% burden; a nonzero value cannot safely be
    // converted without a dependable unit and denominator, so leave it for manual entry.
    var afRecentRaw = field(2755, 'Total Time in AT/AF Recent Week');
    if (afRecentRaw !== '' && parseFloat(afRecentRaw) === 0) {
      set('ep-af-burden', 'AF Burden (%)', '0', 'auto', 'No AT/AF time recorded in the recent-week diagnostic field.');
    }

    /* ---------- observations / changes ---------- */
    RESULT['obs-yn'] = { label: 'Observations?', field: 'obs-yn', v: 'N/A', src: '', status: 'auto', note: '' };
    RESULT['rp-chg'] = { label: 'Parameter changes?', field: 'rp-chg', v: '', src: '', status: 'review', note: 'Not recorded in the .log — review.' };
    RESULT['sig-date'] = { label: 'Date Completed', field: 'sig-date', v: RESULT['pt-date'].v, src: 'visit date', status: RESULT['pt-date'].v ? 'auto' : 'empty', note: '' };
    GOTCHAS = [
      { tag: 'LOG', body: '<b>Abbott exports a scanned-image PDF</b> (no selectable text). Use the Merlin <b>.log</b> export instead — a flat key/value text dump this parser reads.' },
      { tag: 'CODE', body: '<b>The .log is FS-delimited</b> (ASCII 0x1C between code / name / value / unit). Values are keyed by their numeric code. Routing is structural — LV lead = CRT, shock evidence (HV impedance / charge) = defib.' },
      { tag: 'PACE%', body: '<b>% paced</b> uses recent Event Histogram values for non-CRT devices. CRT ventricular pacing uses Abbott\'s lifetime RVP / LVP / BP compartments so the combined ventricular total is not mistaken for RV-only pacing.' },
      { tag: 'EPISODES', body: '<b>Aggregate episode data only.</b> AHR, ICD VT/VF counts, and the common last-cleared date are imported. Individual episode timestamps/durations/rates and a dependable nonzero AF burden percentage are not present in these .log exports.' },
      { tag: 'THR', body: '<b>Thresholds</b> come from the Capture Test results (atrial / RV), with the matching test pulse widths.' }
    ];

    return { RESULT: RESULT, GOTCHAS: GOTCHAS, LEADS: LEADS, ROUTE: ROUTE, ORDER: ORDER_DUAL, EPISODES: EPISODES };
  }

  global.ABBOTT = {
    name: 'Abbott',
    // no `sig` here — vendor detection lives in engine.js (Engine.VENDORS) so the lists can't drift.
    dropdownModes: DROPDOWN_MODES,
    detectDevice: detectDevice,
    runLog: runLog
  };
})(window);
