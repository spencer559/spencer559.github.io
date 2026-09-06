/* crmdb-commit-cadence.js — when a staged edit actually gets published.
 *
 * Committing is not free. It re-serializes the whole database and writes the result into the
 * shared IndexedDB working copy, so on a clinic-sized .crmdb it is a multi-megabyte round trip.
 * Running that on a typing debounce — every ~1.5s pause — is what made both pages hitch during a
 * visit, and it got worse the bigger the database grew.
 *
 * The fix is the same on every page, so it lives here instead of being reinvented per page:
 *
 *   • an edit STAGES into the in-memory bundle (CRMWorkspace's { defer: true } writes), which is
 *     cheap, and calls stage() to say "something is waiting";
 *   • stage() publishes at most once every `everyMs`;
 *   • every deliberate exit — navigating away, switching patient, tab-hide, pagehide, Save —
 *     commits immediately.
 *
 * Exit hooks make a best-effort commit; browsers may terminate asynchronous work on close.
 *
 *   var cadence = CRMCadence.create({
 *     everyMs: 30000,
 *     commit: function () { return CRMWorkspace.flush(); },
 *     onCommitted: function () { ...status... },
 *     onError: function (e) { ...status... }
 *   });
 *
 * Exposes: stage(), commitNow(), pending(), cancel(), attachLeaveHooks(onLeave).
 */
(function () {
  "use strict";

  function create(opts) {
    opts = opts || {};
    var everyMs = opts.everyMs || 30000;
    var commitFn = opts.commit;
    var onCommitted = opts.onCommitted;
    var onError = opts.onError;

    var timer = null, pending = false;
    var retries = 0, generation = 0;
    var maxRetries = opts.maxRetries == null ? 3 : opts.maxRetries;
    // Set once a page's own onLeave has taken responsibility for an exit, and cleared by the next
    // stage(). See attachLeaveHooks: it is what makes "one exit, one commit" true even when the
    // page commits asynchronously.
    var leftHandled = false;

    function report(cb, arg) { try { if (cb) cb(arg); } catch (e) {} }

    // Something is staged. Arm the countdown if it isn't already running — deliberately WITHOUT
    // restarting an in-flight one, or continuous typing would push the commit out forever and the
    // cadence would never fire at all.
    function stage() {
      retries = 0;
      pending = true;
      leftHandled = false;   // new work: a later exit is a fresh one, and may fall back again
      arm();
    }
    function arm() {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        if (pending) commitNow();
      }, everyMs);
    }

    // Publish whatever is staged. Used by the cadence timer and by every immediate-exit path.
    // Clears the pending flag FIRST, so a second call arriving before the commit resolves (three
    // teardown events for one page exit) doesn't repeat it.
    function commitNow(options) {
      cancel();
      var attemptGeneration = generation;
      if (!commitFn) return Promise.resolve();
      return Promise.resolve()
        .then(commitFn)
        .then(function (r) { retries = 0; report(onCommitted, r); return r; },
              function (e) {
                // Keep failed work pending. Never revive work cancelled by a later save/close.
                if (generation === attemptGeneration) {
                  pending = true; leftHandled = false;
                  if (retries++ < maxRetries) arm();
                }
                report(onError, e);
                if (options && options.rethrow) throw e;
              });
    }

    // Drop the pending flag and the timer without committing. For the case where something else
    // has already published everything staged (a full save, a finalize) and leaving the timer
    // armed would only buy a redundant commit.
    function cancel() {
      generation++;
      pending = false;
      clearTimeout(timer); timer = null;
    }

    /* Leaving the page, in every way a browser signals it.
     *
     * `onLeave` is the page's own teardown work (rebuilding a report, writing a data file). It
     * returns true to mean "I have taken responsibility and will commit myself", false to let the
     * cadence commit anything still pending.
     *
     * The important part is that all three events can fire for a SINGLE page exit, in one turn.
     * Anything that clears state in a .then lands far too late to stop the second and third from
     * repeating the work — so the claim has to be synchronous. Two things do that here:
     *
     *   • commitNow() clears `pending` before it awaits anything, so the fallback can't repeat;
     *   • `leftHandled` remembers that onLeave took the exit, so the fallback doesn't ALSO commit
     *     on the next event. Without it, a page that claims synchronously but only reaches its
     *     commit in a .then — staging a file first, which is exactly what the Schedule does —
     *     still has `pending` set when the second event arrives, and the exit commits twice.
     *
     * `leftHandled` is cleared by the next stage(), so a tab hidden, shown, edited and hidden
     * again is a fresh exit rather than a permanently disarmed one.
     */
    function attachLeaveHooks(onLeave) {
      function leave() {
        var handled = false;
        if (typeof onLeave === "function") { try { handled = !!onLeave(); } catch (e) { report(onError, e); } }
        if (handled) { leftHandled = true; return; }
        if (!leftHandled && pending) commitNow();
      }
      if (typeof document !== "undefined") {
        // Backgrounding / tab-hide. Also fires just before a tab close.
        document.addEventListener("visibilitychange", function () { if (document.hidden) leave(); });
      }
      if (typeof window !== "undefined") {
        // pagehide is the reliable teardown signal — it covers browser Back out of a page and a tab
        // close, which is exactly the path that used to leave the other page reading stale data.
        window.addEventListener("pagehide", leave);
        window.addEventListener("beforeunload", leave);
      }
      return leave;   // returned so a page can also invoke it directly (tests, explicit teardown)
    }

    return {
      stage: stage,
      commitNow: commitNow,
      cancel: cancel,
      pending: function () { return pending; },
      attachLeaveHooks: attachLeaveHooks
    };
  }

  var api = { create: create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;   // Node tests
  if (typeof window !== "undefined") window.CRMCadence = api;                  // browser
})();
