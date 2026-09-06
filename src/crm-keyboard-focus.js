/* Keep keyboard focus readable inside the report's own scroll panes. Native Tab, arrows,
 * Space and Enter retain their browser behavior; never scroll the parent Schedule/PDF pane.
 */
(function () {
  "use strict";

  function reveal(control, main) {
    if (!main.contains(control)) return;
    var context = control.closest('.field, .cbl, td') || control;
    // Work inside-out, so horizontally scrolling table cells and the main vertical pane
    // each expose the focused control without scrollIntoView moving ancestor frames.
    for (var pane = control.parentElement; pane; pane = pane.parentElement) {
      var style = getComputedStyle(pane);
      var vertical = /^(auto|scroll)$/.test(style.overflowY) && pane.scrollHeight > pane.clientHeight;
      var horizontal = /^(auto|scroll)$/.test(style.overflowX) && pane.scrollWidth > pane.clientWidth;
      if (vertical || horizontal) {
        var bounds = pane.getBoundingClientRect();
        var field = context.getBoundingClientRect();
        var input = control.getBoundingClientRect();
        var top = bounds.top + pane.clientTop + 8;
        var left = bounds.left + pane.clientLeft + 8;
        var bottom = bounds.top + pane.clientTop + pane.clientHeight - 8;
        var right = bounds.left + pane.clientLeft + pane.clientWidth - 8;
        // A tall notes field/wide cell may not fit: keep its actual control in view instead.
        if (field.height > bottom - top) field = input;
        if (vertical) {
          if (field.top < top) pane.scrollTop += field.top - top;
          else if (field.bottom > bottom) pane.scrollTop += field.bottom - bottom;
        }
        if (horizontal) {
          var horizontalField = field.width <= right - left ? field : input;
          if (horizontalField.left < left) pane.scrollLeft += horizontalField.left - left;
          else if (horizontalField.right > right) pane.scrollLeft += horizontalField.right - right;
        }
      }
      if (pane === main) break;
    }
  }

  function firstField(row) {
    if (!row) return null;
    return Array.from(row.querySelectorAll('input:not([type=hidden]), select, textarea'))
      .find(function (field) { return !field.disabled && field.getClientRects().length; }) || null;
  }
  function focusControl(control) {
    if (!control) return;
    control.focus({ preventScroll: true });
    var main = control.closest('.main');
    if (main) reveal(control, main);
  }
  function focusRow(row) { focusControl(firstField(row)); }
  function removeRow(row) {
    var table = row.closest('table');
    var target = firstField(row.nextElementSibling) || firstField(row.previousElementSibling) ||
      (table && table.parentElement.querySelector('.add-btn'));
    row.remove();
    focusControl(target);
  }
  var api = { reveal: reveal, focusRow: focusRow, removeRow: removeRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CRMKeyboardFocus = api;
  if (typeof document === 'undefined') return;
  var main = document.querySelector('.main');
  if (!main) return;
  main.addEventListener('focusin', function (event) {
    var control = event.target;
    if (!control.matches('input, select, textarea, button, a')) return;
    requestAnimationFrame(function () {
      if (document.activeElement !== control || !control.matches(':focus-visible')) return;
      reveal(control, main);
    });
  });
})();
