/* main.js — bootstrap. Loads the JSON payloads, builds the map, the elevation
 * profile and the drawer, wires the header, then releases every UTMB.ready()
 * callback registered by checklist.js / share.js / transport.js.
 *
 * This file is the only place that orchestrates start-up. Feature modules should
 * hook in with UTMB.ready(fn) or UTMB.on(event, fn) rather than editing it.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  /* ── toast ────────────────────────────────────────────────────────────────
   * Available to every module: UTMB.toast('...'). */
  var toastTimer = null;

  UTMB.toast = function (msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2400);
  };

  /* ── header save button reflects dirty state ─────────────────────────────── */
  function paintSaveBtn(isDirty) {
    var btn = document.getElementById('saveBtn');
    if (!btn) return;
    btn.classList.toggle('dirty', !!isDirty);
    btn.textContent = isDirty ? '💾 Save*' : '💾 Save';
  }

  UTMB.on('state:dirty', paintSaveBtn);

  function showBootError(err) {
    console.error('[UTMB] bootstrap failed', err);
    var box = document.getElementById('bootError');
    if (box) {
      box.textContent = 'Could not load the course data (' + (err && err.message ? err.message : err) +
        '). Reload the page while online — after the first load it works offline.';
      box.style.display = 'block';
    }
  }

  function boot() {
    /* Ask for persistent storage early: the crew's notes must survive a browser
     * evicting "temporary" data on a phone that's low on space. */
    UTMB.store.requestPersistence();

    return UTMB.data.loadAll().then(function (ctx) {
      var course = ctx.course;

      document.getElementById('statKm').textContent = course.total_km;
      document.getElementById('statGain').textContent = course.total_gain.toLocaleString();
      document.getElementById('statLoss').textContent = course.total_loss.toLocaleString();

      function onCpClick(cpId) { UTMB.drawer.open(cpId); }

      UTMB.map.build({ course: course, topo: ctx.topo, onCpClick: onCpClick });
      UTMB.profile.build({ course: course, onCpClick: onCpClick });
      UTMB.drawer.init({ course: course });

      paintSaveBtn(UTMB.store.isDirty());

      /* Releases checklist.js / share.js / transport.js. */
      UTMB._markReady(ctx);
      return ctx;
    }).catch(showBootError);
  }

  UTMB.boot = boot;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.UTMB);
