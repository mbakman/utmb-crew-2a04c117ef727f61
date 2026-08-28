/* main.js — bootstrap. Loads the JSON payloads, builds the map, the elevation
 * profile and the drawer, brings up the feature modules in a defined order,
 * and registers the service worker.
 *
 * This file is the only place that orchestrates start-up. The order below is
 * not incidental — it is the contract:
 *
 *   1. data       course.json / topo-meta.json / shuttles.json / checklists.json.
 *                 Nothing else may run before this resolves.
 *   2. core       map -> profile -> drawer. profile.js reads UTMB.map.cpColor()
 *                 while building, and drawer.init() needs the course.
 *   3. _markReady sets UTMB.context() and releases every UTMB.ready() callback.
 *   4. checklist  BEFORE share: share.js diffs an incoming link against the
 *                 checklist's content, and an empty checklist makes every item
 *                 in that link look new.
 *   5. transport  the day plan. Needs the drawer to exist before it can paint
 *                 into it, and fetches docs/day-plan.json itself.
 *   6. share UI   the header button and the sheets.
 *   7. share RECEIVE  UTMB.share.receivePending() is what consumes a "#s=..."
 *                 link, and it must see loaded content or nothing.
 *   8. sync       crew state sync (js/sync.js). Loaded with `defer` and boots
 *                 itself — it waits for the checklist to have content before it
 *                 merges anything, so it cannot mistake "not loaded yet" for
 *                 "the crew deleted everything". Listed last here because that
 *                 is the order it comes up in, not because this file drives it.
 *
 * Every module init is idempotent, and each one also self-registers on
 * UTMB.ready(), so the app still comes up if this file is ever loaded out of
 * order — but this is the path that actually runs.
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

  /* ── service worker ───────────────────────────────────────────────────────
   * Registered here rather than inline in index.html so start-up lives in one
   * file. Deliberately on window 'load' and deliberately outside the data
   * promise chain: caching for the next visit must still happen even if this
   * visit's course.json is the thing that failed. */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var secure = window.isSecureContext ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) return;

    var go = function () {
      navigator.serviceWorker.register('sw.js', { scope: './' })['catch'](function (err) {
        console.warn('[UTMB] service worker registration failed', err);
      });
    };
    if (document.readyState === 'complete') go();
    else window.addEventListener('load', go);
  }

  /* ── core view ────────────────────────────────────────────────────────────
   * Map, profile and drawer. Throws if course/topo are unusable, which is what
   * puts the boot-error banner on screen. */
  function buildCore(ctx) {
    var course = ctx.course;

    document.getElementById('statKm').textContent = course.total_km;
    document.getElementById('statGain').textContent = course.total_gain.toLocaleString();
    document.getElementById('statLoss').textContent = course.total_loss.toLocaleString();

    function onCpClick(cpId) { UTMB.drawer.open(cpId); }

    UTMB.map.build({ course: course, topo: ctx.topo, onCpClick: onCpClick });
    UTMB.profile.build({ course: course, onCpClick: onCpClick });
    UTMB.drawer.init({ course: course });

    paintSaveBtn(UTMB.store.isDirty());
  }

  /* ── feature modules, in order ────────────────────────────────────────────
   * One module throwing must not take the rest of the app down with it, so
   * each step is isolated. The ORDER is the point; see the header comment. */
  function step(name, fn) {
    try {
      fn();
    } catch (err) {
      console.error('[UTMB] "' + name + '" failed during bootstrap', err);
    }
  }

  function bringUpModules(ctx) {
    /* Releases every UTMB.ready() callback and sets UTMB.context(). Modules
     * that self-register come up here, in <script> order; the explicit calls
     * below then guarantee the order regardless of how the page was assembled. */
    step('ready', function () { UTMB._markReady(ctx); });

    step('checklist', function () {
      if (UTMB.checklist && typeof UTMB.checklist.init === 'function') UTMB.checklist.init(ctx);
    });

    step('transport', function () {
      if (UTMB.transport && typeof UTMB.transport.init === 'function') UTMB.transport.init(ctx);
    });

    step('share', function () {
      if (UTMB.share && typeof UTMB.share.init === 'function') UTMB.share.init();
    });

    /* Anything earlier would diff an incoming crew link against a checklist
     * this phone has not finished loading. */
    step('share:receive', function () {
      if (UTMB.share && typeof UTMB.share.receivePending === 'function') UTMB.share.receivePending();
    });

    /* js/sync.js boots itself: it is a standalone IIFE that waits until the
     * checklist has content before it merges anything, which is exactly the
     * ordering constraint this function exists to enforce. Nothing to do here
     * unless a future build exposes an explicit entry point. A missing sync.js
     * is not an error — the app is fully usable without it. */
    step('sync', function () {
      if (UTMB.sync && typeof UTMB.sync.init === 'function') UTMB.sync.init(ctx);
    });
  }

  /* course.json or topo-meta.json died. The map and the profile are gone, but
   * the crew checklist, the notes and — crucially — an incoming shared link are
   * all still serviceable, so rebuild as much context as we can rather than
   * leaving UTMB.context() null forever (which is what would make share.js
   * refuse, or worse, diff against nothing). */
  function degradedContext() {
    function optional(load) {
      try { return load().catch(function () { return null; }); }
      catch (err) { return Promise.resolve(null); }
    }
    return Promise.all([
      optional(function () { return UTMB.data.loadChecklists(); }),
      optional(function () { return UTMB.data.loadShuttles(); })
    ]).then(function (r) {
      return { course: null, topo: null, checklists: r[0], shuttles: r[1] };
    });
  }

  function boot() {
    /* Ask for persistent storage early: the crew's notes must survive a browser
     * evicting "temporary" data on a phone that's low on space. */
    UTMB.store.requestPersistence();
    registerServiceWorker();

    return UTMB.data.loadAll()
      .then(function (ctx) {
        buildCore(ctx);
        return ctx;
      })
      .catch(function (err) {
        showBootError(err);
        return degradedContext();
      })
      .then(function (ctx) {
        bringUpModules(ctx);
        return ctx;
      });
  }

  UTMB.boot = boot;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window.UTMB);
