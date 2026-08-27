/* drawer.js — the checkpoint detail drawer: badges, description, and the
 * "notes for your supporters" textarea.
 *
 * Ported from the single-file build. Notes live in UTMB.store.notes and are
 * debounce-persisted to localStorage as the user types.
 *
 * The drawer body carries three empty mount points that other modules fill in
 * (they are in index.html already — do not add more):
 *   #drawerChecklistMount   checklist.js
 *   #drawerTransportMount   transport.js
 *   #drawerShareMount       share.js
 * Each of those modules should listen for 'cp:open' / 'cp:close' and render
 * into its own mount. UTMB.drawer.cp() returns the checkpoint currently shown.
 *
 * Public API:
 *   UTMB.drawer.init({course})
 *   UTMB.drawer.open(cpId) / UTMB.drawer.close()
 *   UTMB.drawer.activeCp() -> cp id or null
 *   UTMB.drawer.cp()       -> the cp object or null
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var SUPPORT_LABEL = {
    water: 'Water only',
    food: 'Food + drink',
    hotmeal: 'Hot meal'
  };

  var course = null;
  var activeCp = null;
  var drawer = null, overlay = null, notesTa = null;
  var inited = false;

  function findCp(cpId) {
    return course ? course.cps.find(function (c) { return c.id === cpId; }) : null;
  }

  /* store.js owns the 12h -> 24h cutoff formatter; fall back to the raw string
   * if this file is ever loaded without it. */
  function fmtCutoff(raw) {
    return typeof UTMB.fmtCutoff === 'function' ? UTMB.fmtCutoff(raw) : raw;
  }

  function init(opts) {
    course = opts.course;
    drawer = document.getElementById('drawer');
    overlay = document.getElementById('overlay');
    notesTa = document.getElementById('dNotes');
    if (!drawer || !overlay || !notesTa) throw new Error('drawer markup (#drawer / #overlay / #dNotes) missing from the page');

    var noteTimer = null;
    notesTa.addEventListener('input', function (e) {
      if (!activeCp) return;
      var v = e.target.value;
      if (v) UTMB.store.notes[activeCp] = v;
      else delete UTMB.store.notes[activeCp];
      UTMB.store.markDirty();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(function () { UTMB.store.saveNotes(); }, 400);
    });

    overlay.addEventListener('click', close);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && activeCp) close();
    });

    inited = true;
    return UTMB.drawer;
  }

  function open(cpId) {
    if (!inited) return;
    var cp = findCp(cpId);
    if (!cp) {
      console.warn('[UTMB] no checkpoint with id "' + cpId + '"');
      return;
    }
    activeCp = cpId;

    document.querySelectorAll('.cp-marker').forEach(function (el) {
      el.classList.toggle('active', el.dataset.cp === cpId);
    });

    document.getElementById('dName').textContent =
      (cp.id !== 'start' && cp.id !== 'finish' ? cp.id + ' — ' : '') + cp.name;
    document.getElementById('dSub').textContent = cp.km + ' km into the course';

    var badges = '';
    if (cp.support) badges += '<span class="badge badge-' + cp.support + '">' + SUPPORT_LABEL[cp.support] + '</span>';
    if (cp.supporter) badges += '<span class="badge badge-supporter">Supporter access</span>';
    /* 24-hour, so this badge reads the same as the cutoff in the transport
     * block a few lines below it. See UTMB.fmtCutoff in store.js. */
    if (cp.cutoff) badges += '<span class="badge badge-cutoff">Cutoff ' + fmtCutoff(cp.cutoff) + '</span>';
    document.getElementById('dBadges').innerHTML = badges;
    document.getElementById('dDesc').textContent = cp.desc || '';

    notesTa.value = UTMB.store.notes[cpId] || '';

    drawer.classList.add('open');
    overlay.classList.add('open');

    UTMB.emit('cp:open', { id: cpId, cp: cp });
  }

  function close() {
    if (!inited || !activeCp) {
      if (drawer) drawer.classList.remove('open');
      if (overlay) overlay.classList.remove('open');
      return;
    }
    var closed = activeCp;
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    document.querySelectorAll('.cp-marker').forEach(function (el) { el.classList.remove('active'); });
    activeCp = null;
    UTMB.emit('cp:close', { id: closed });
  }

  UTMB.drawer = {
    init: init,
    open: open,
    close: close,
    isOpen: function () { return activeCp !== null; },
    activeCp: function () { return activeCp; },
    cp: function () { return activeCp ? findCp(activeCp) : null; },
    SUPPORT_LABEL: SUPPORT_LABEL
  };
})(window.UTMB);
