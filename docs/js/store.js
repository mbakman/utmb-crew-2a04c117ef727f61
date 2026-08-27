/* store.js — UTMB namespace bootstrap, event bus, and localStorage persistence.
 *
 * This is the FIRST script the page loads, so anything another module needs at
 * parse time (the namespace, UTMB.on/emit, UTMB.ready) lives here.
 *
 * Persistence model, unchanged from the single-file build:
 *   SEED (baked-in defaults, below)  <-  overlaid by  ->  localStorage
 * Writes are debounced (400 ms) while typing; the Save button flushes everything
 * synchronously and asks the browser to make the origin's storage persistent.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
   * Event bus. Core events emitted by the app:
   *   'ready'          {course, topo, shuttles, checklists}
   *   'cp:open'        {id, cp}
   *   'cp:close'       {id}
   *   'section:select' {index, section, from, to}
   *   'section:clear'  {}
   *   'state:dirty'    true|false
   *   'state:save'     {n, p, pl, sn, ts}
   *   'training:mode'  true|false
   *
   * Feature-module events (see the module that owns each):
   *   'checklist:ready'   {content, ticks}                     checklist.js
   *   'checklist:change'  {reason, cpId, content, ticks}       checklist.js
   *   'checklist:content' {content, removedIds, source}        share.js
   *   'transport:ready'   {shuttles}                           transport.js
   * ───────────────────────────────────────────────────────────────────────── */
  var listeners = Object.create(null);

  UTMB.on = function (evt, fn) {
    (listeners[evt] || (listeners[evt] = [])).push(fn);
    return fn;
  };
  UTMB.off = function (evt, fn) {
    var arr = listeners[evt];
    if (!arr) return;
    var i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  UTMB.emit = function (evt, payload) {
    var arr = listeners[evt];
    if (!arr) return;
    arr.slice().forEach(function (fn) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[UTMB] listener for "' + evt + '" threw', err);
      }
    });
  };

  /* ── ready hook ───────────────────────────────────────────────────────────
   * UTMB.ready(fn) runs fn({course, topo, shuttles, checklists}) once the data
   * is loaded and the map/profile/drawer are built. Registering before or after
   * bootstrap both work. This is the extension point for checklist.js,
   * share.js and transport.js — none of them should need to touch main.js.
   */
  var readyCtx = null;
  var readyQueue = [];

  function runReady(fn) {
    try {
      fn(readyCtx);
    } catch (err) {
      console.error('[UTMB] ready() callback threw', err);
    }
  }

  UTMB.ready = function (fn) {
    if (typeof fn !== 'function') return;
    if (readyCtx) runReady(fn);
    else readyQueue.push(fn);
  };

  /* Called once by main.js when bootstrap finishes. */
  UTMB._markReady = function (ctx) {
    readyCtx = ctx || {};
    var q = readyQueue;
    readyQueue = [];
    q.forEach(runReady);
    UTMB.emit('ready', readyCtx);
  };

  UTMB.context = function () {
    return readyCtx;
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * Baked-in default state, lifted verbatim from the STATE block of the
   * original single-file build. localStorage wins over these on a per-key
   * basis; a browser with nothing saved still sees Suha's notes.
   *   n  = checkpoint notes        (keyed by cp id)
   *   p  = practice runs done      (keyed by "<from>_<to>")
   *   pl = practice runs planned   (keyed by "<from>_<to>")
   *   sn = section notes           (keyed by "<from>_<to>")
   * ───────────────────────────────────────────────────────────────────────── */
  var SEED = /* STATE */{"n":{"U7":"Gelmeden Once:\nOturtucak yer bulunacak. Maurten 320 mix 1 flaska koyulacak ustu su ile doldurulup iyice calkalanacak.\nGelince ILK IS -> Saati ve nabız bandını sarj etmek icin kolumdan cikarin (BEN UNUTURUM, SIZ DIREKT BENI YONLENDIRIN YA DA KENDINIZ CIKARIN) \nKafa lambasi alinacak, sarj edilecek, bir sonraki bulusmada geri verilecek\n\n","U3":"Gelmeden once:\nMaurten Mix ile 1 sise su hazirlanacak. Iyice calkalanacak erimesi icin toz.\nOturtacak yer bulunacak \nGelince: Suha oturulacak yere yonlendirilecek.\nOturduktan sonra:\nExtra Jel verilecek. Su yenilenecek. Maurten mix verilecek.\n\n"},"p":{"U1_U2":true,"U7_U8":true,"U8_U9":true,"U3_U4":true,"U5_U6":true,"U6_U7":true,"U12_U13":true,"start_U1":true},"pl":{"U12_U13":true,"U5_U6":true,"U6_U7":true,"start_U1":true},"sn":{"U4_U5":"normal climb till the first peak (Col de la Seigne - France Italy border). Then 1 k down then leave the TMB trail to the tiny trail climb to Pyramide Calcaire (2600m). A lot of stones and rocks (careful with poles). On the downhill BE VERY CAREFUL not to twist ankle because of rocks ","U11_U12":"after peak La Giete, technical down hill roots and rocks and steep around 20-25%. Especially the last part after Col de la Forclaz (water fountain). 1 km flat then very steep down hill 30+% before Trient","U12_U13":"before Vallorcine technical steep downhill with roots"},"ts":"2026-08-25T18:56:42.241Z"}/* /STATE */;

  var PREFIX = 'utmb_';
  var KEY = {
    notes: 'utmb_notes',
    practice: 'utmb_practice',
    plan: 'utmb_plan',
    sectionNotes: 'utmb_section_notes'
  };

  function readJSON(key, fallback) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      var val = JSON.parse(raw);
      return val === null || val === undefined ? fallback : val;
    } catch (err) {
      console.warn('[UTMB] could not read "' + key + '" from localStorage', err);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[UTMB] could not write "' + key + '" to localStorage', err);
      return false;
    }
  }

  var timers = Object.create(null);

  function writeJSONDebounced(key, value, ms) {
    clearTimeout(timers[key]);
    timers[key] = setTimeout(function () {
      delete timers[key];
      writeJSON(key, value);
    }, typeof ms === 'number' ? ms : 400);
  }

  function flushPending() {
    Object.keys(timers).forEach(function (key) {
      clearTimeout(timers[key]);
      delete timers[key];
    });
  }

  /* ── live buckets ─────────────────────────────────────────────────────────
   * These objects are mutated in place by drawer.js / profile.js, so anything
   * holding a reference always sees current values.
   */
  var notes = Object.assign({}, SEED.n || {}, readJSON(KEY.notes, {}));
  var practice = Object.assign({}, SEED.p || {}, readJSON(KEY.practice, {}));
  var plan = Object.assign({}, SEED.pl || {}, readJSON(KEY.plan, {}));
  var sectionNotes = Object.assign({}, SEED.sn || {}, readJSON(KEY.sectionNotes, {}));

  var dirty = false;

  function markDirty() {
    if (dirty) return;
    dirty = true;
    UTMB.emit('state:dirty', true);
  }

  function markClean() {
    if (!dirty) return;
    dirty = false;
    UTMB.emit('state:dirty', false);
  }

  function snapshot() {
    return {
      n: notes,
      p: practice,
      pl: plan,
      sn: sectionNotes,
      ts: new Date().toISOString()
    };
  }

  /* Flush every bucket now, no debounce. Returns the snapshot that was saved. */
  function saveAll() {
    flushPending();
    writeJSON(KEY.notes, notes);
    writeJSON(KEY.practice, practice);
    writeJSON(KEY.plan, plan);
    writeJSON(KEY.sectionNotes, sectionNotes);
    var snap = snapshot();
    markClean();
    UTMB.emit('state:save', snap);
    return snap;
  }

  /* Wired to the header Save button. In the single-file build this rewrote the
   * HTML file through the File System Access API; a deployed static site has no
   * such file, so Save now means "commit everything to this device and ask the
   * browser not to evict it". */
  function saveState() {
    saveAll();
    requestPersistence();
    if (typeof UTMB.toast === 'function') UTMB.toast('Saved on this device');
  }

  /* navigator.storage.persist() — best effort. Chrome may grant silently, deny
   * silently, or not implement it at all; none of those are errors. */
  var persistPromise = null;

  function requestPersistence() {
    if (persistPromise) return persistPromise;
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
      persistPromise = Promise.resolve(false);
      return persistPromise;
    }
    persistPromise = navigator.storage
      .persisted()
      .then(function (already) {
        return already ? true : navigator.storage.persist();
      })
      .catch(function (err) {
        console.warn('[UTMB] storage persistence request failed', err);
        return false;
      });
    return persistPromise;
  }

  /* ── generic slots, for checklist.js / share.js / transport.js ─────────────
   * UTMB.store.get('checklist', {}) reads localStorage key "utmb_checklist".
   * Use set() for one-off writes and setDebounced() while a user is typing.
   */
  function get(name, fallback) {
    return readJSON(PREFIX + name, fallback);
  }

  function set(name, value) {
    return writeJSON(PREFIX + name, value);
  }

  function setDebounced(name, value, ms) {
    writeJSONDebounced(PREFIX + name, value, ms);
  }

  UTMB.store = {
    SEED: SEED,
    KEY: KEY,

    /* live state objects — mutate in place, then call the matching save */
    notes: notes,
    practice: practice,
    plan: plan,
    sectionNotes: sectionNotes,

    saveNotes: function () { writeJSONDebounced(KEY.notes, notes); },
    savePractice: function () { writeJSONDebounced(KEY.practice, practice); },
    savePlan: function () { writeJSONDebounced(KEY.plan, plan); },
    saveSectionNotes: function () { writeJSONDebounced(KEY.sectionNotes, sectionNotes); },

    snapshot: snapshot,
    saveAll: saveAll,
    saveState: saveState,

    markDirty: markDirty,
    markClean: markClean,
    isDirty: function () { return dirty; },

    requestPersistence: requestPersistence,

    get: get,
    set: set,
    setDebounced: setDebounced,
    readJSON: readJSON,
    writeJSON: writeJSON
  };

  /* Convenience aliases used across modules. */
  UTMB.markDirty = markDirty;
  UTMB.markClean = markClean;
  UTMB.saveState = saveState;
})(window.UTMB);
