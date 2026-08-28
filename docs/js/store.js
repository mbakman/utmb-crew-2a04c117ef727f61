/* store.js — UTMB namespace bootstrap, event bus, and localStorage persistence.
 *
 * This is the FIRST script the page loads, so anything another module needs at
 * parse time (the namespace, UTMB.on/emit, UTMB.ready) lives here.
 *
 * Persistence model, unchanged from the single-file build:
 *   SEED (baked-in defaults, below)  <-  overlaid by  ->  localStorage
 * Writes are debounced (400 ms) while typing; the Save button flushes everything
 * synchronously and asks the browser to make the origin's storage persistent.
 *
 * Since the live-sync build this file also owns the SHARED state boundary — the
 * flat, timestamped view of the crew checklist that js/sync.js pushes to and
 * pulls from api/checklist.php. See the "SHARED LIVE STATE" block near the
 * bottom for the whole story; the short version is:
 *
 *   UTMB.store.getSharedState()      the wire shape
 *   UTMB.store.applyMergedState(s)   write a merged state back, no re-stamping
 *   UTMB.store.getBib() / setBib(v)  shared bib number
 *   window event 'utmb:local-change' fired after any local mutation
 *
 * Nothing above that block changed. Every existing export behaves exactly as it
 * did — share.js and checklist.js sit on this file and were not touched.
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
    /* Tapping Save is also "push whatever I have now" — sync.js debounces it
     * into the next POST. */
    emitLocalChange({ source: 'save' });
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
    var ok = writeJSON(PREFIX + name, value);
    emitLocalChange({ source: 'slot', slot: name });
    return ok;
  }

  function setDebounced(name, value, ms) {
    writeJSONDebounced(PREFIX + name, value, ms);
    emitLocalChange({ source: 'slot', slot: name });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * SHARED LIVE STATE — the slice of this app every crew phone sees
   * ═══════════════════════════════════════════════════════════════════════
   *
   * js/sync.js polls a tiny PHP endpoint and merges what it finds into here.
   * This block is the boundary between "checklist.js owns the model" and "sync
   * needs one flat, timestamped, mergeable object". It adds three things:
   *
   *   1. lastModified stamps.  Every checklist.js item carries its own stamp,
   *      set at the moment of the edit, and THAT is the authority. A side table
   *      (localStorage "utmb_item_mtime", {itemId: epochMs}) mirrors it so that
   *      items predating the field still have an age: those, and only those,
   *      are stamped by diffing the flattened view against the previous one.
   *      Anything that changed — text, critical, draft, phase, position, or the
   *      TICK — gets stamped.
   *
   *      Two independent timestamps for one item is a bug, not a design: when
   *      they disagreed, a merged un-tick arrived with a 0 stamp on the item
   *      while the side table still held the old tick's time, and the next
   *      reload replayed the tick back over the top of it. The item wins.
   *
   *   2. getSharedState() / applyMergedState().  The flat wire shape, and the
   *      way back in. applyMergedState() writes an already-merged state through
   *      checklist.js WITHOUT re-stamping: the incoming timestamps are the
   *      merge's whole basis, and refreshing them would make every merge look
   *      like a brand-new local edit and stop the crew ever converging.
   *
   *   3. 'utmb:local-change' on window after any local mutation, which is what
   *      sync.js debounces into a POST.
   *
   * TICKS ARE SHARED NOW. checklist.js still calls them "per-device" in its own
   * header and still stores them in its own slot — nothing there changed — but
   * they ride along in this state object, so ticking "poles packed" on one
   * phone shows up on all of them.
   *
   * First-run stamps: an item nobody has touched since sync existed gets 0
   * (oldest possible), so any real edit anywhere beats it. Items in a
   * checkpoint that already carried local edits get that blob's savedAt
   * instead, so work done before sync was deployed still outranks pristine
   * seed content from checklists.json.
   */
  var SLOT_STAMPS = PREFIX + 'item_mtime';   /* {itemId: epochMs}       */
  var SLOT_META = PREFIX + 'meta';           /* {bib, bibModified}      */
  var DEFAULT_PHASES = ['before', 'onArrival', 'beforeLeaving'];

  var stamps = readJSON(SLOT_STAMPS, null);
  if (!stamps || typeof stamps !== 'object' || Array.isArray(stamps)) stamps = {};

  var metaState = (function () {
    var raw = readJSON(SLOT_META, null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
    return {
      bib: typeof raw.bib === 'string' ? raw.bib : '',
      bibModified: (typeof raw.bibModified === 'number' && isFinite(raw.bibModified)) ? raw.bibModified : 0
    };
  })();

  var lastFlat = null;    /* the flat view the stamps were last reconciled to */
  var applying = false;   /* true while a remote merge is being written in    */
  var editedAt = null;    /* cached savedAt of the pre-sync edit blob         */

  function checklistApi() {
    return (UTMB.checklist && typeof UTMB.checklist.getContent === 'function') ? UTMB.checklist : null;
  }

  function phaseListOf(content) {
    if (content && Array.isArray(content.phaseOrder) && content.phaseOrder.length) {
      return content.phaseOrder;
    }
    var cl = checklistApi();
    if (cl && typeof cl.phaseOrder === 'function') {
      var order = cl.phaseOrder();
      if (Array.isArray(order) && order.length) return order;
    }
    return DEFAULT_PHASES;
  }

  /* getContent() + getTicks() -> {itemId: {cp, phase, order, text, critical,
   * draft, done, lastModified}}.
   *
   * lastModified is read straight off the item. checklist.js stamps every
   * mutation it makes (tick, text, flags, move, add) and the stamp survives the
   * localStorage round trip, so the item is the authority and the side table
   * below is only a fallback for items that predate the field. Carrying it here
   * is what stops the two from drifting apart. */
  function flattenContent(content, ticks) {
    var flat = {};
    if (!content || typeof content !== 'object' || !content.checkpoints) return flat;
    var order = phaseListOf(content);
    var marks = (ticks && typeof ticks === 'object') ? ticks : {};

    Object.keys(content.checkpoints).forEach(function (cpId) {
      var entry = content.checkpoints[cpId];
      if (!entry || typeof entry !== 'object') return;
      order.forEach(function (phase) {
        var list = Array.isArray(entry[phase]) ? entry[phase] : [];
        list.forEach(function (it, idx) {
          if (!it || typeof it !== 'object' || !it.id) return;
          var lm = Number(it.lastModified);
          flat[it.id] = {
            cp: cpId,
            phase: phase,
            order: idx,
            text: typeof it.text === 'string' ? it.text : String(it.text === undefined ? '' : it.text),
            critical: !!it.critical,
            draft: !!it.draft,
            /* it.done is the item's own state; marks is the flat mirror. Either
             * one saying "ticked" is enough — a caller that only has the mirror
             * (an older payload) still gets the right answer. */
            done: !!it.done || !!marks[it.id],
            lastModified: (lm === lm && isFinite(lm) && lm > 0) ? lm : 0
          };
        });
      });
    });
    return flat;
  }

  function sameFlatItem(a, b) {
    return a.cp === b.cp && a.phase === b.phase && a.order === b.order &&
      a.text === b.text && a.critical === b.critical &&
      a.draft === b.draft && a.done === b.done;
  }

  function currentFlat() {
    var cl = checklistApi();
    if (!cl) return { flat: {}, content: null };
    try {
      var content = cl.getContent();
      var ticks = typeof cl.getTicks === 'function' ? cl.getTicks() : {};
      return { flat: flattenContent(content, ticks), content: content };
    } catch (err) {
      console.warn('[UTMB] could not read checklist content for sync', err);
      return { flat: {}, content: null };
    }
  }

  /* When this device first met the checklist, before sync existed. */
  function editedBaseline() {
    if (editedAt !== null) return editedAt;
    editedAt = 0;
    var blob = readJSON(PREFIX + 'checklist', null);
    if (blob && typeof blob === 'object' && typeof blob.savedAt === 'string') {
      var t = Date.parse(blob.savedAt);
      if (t === t) editedAt = t;   /* NaN check */
    }
    return editedAt;
  }

  /* Reconcile the side table with the new flat view. The very first call only
   * establishes a baseline — it must never stamp, or opening the app would look
   * like every item was just edited.
   *
   * An item that carries its own lastModified simply hands it over: checklist.js
   * already stamped it at the moment of the edit, and that stamp is what the
   * merge in sync.js was decided on. Re-deriving one here by diffing produced a
   * SECOND, disagreeing timestamp for the same item (observed: side table
   * 1787906240853 vs item 0), which is what made a merged un-tick look like an
   * untouched item. Diffing is kept only for items with no stamp of their own —
   * seed content nobody has edited since sync came online. */
  function refreshStamps(next, content) {
    var initial = (lastFlat === null);
    var now = Date.now();
    var touched = false;

    Object.keys(next).forEach(function (id) {
      var own = next[id].lastModified;
      if (own > 0) {
        if (stamps[id] !== own) { stamps[id] = own; touched = true; }
        return;
      }
      var prev = lastFlat ? lastFlat[id] : null;
      if (!prev) {
        if (initial) {
          if (!(id in stamps)) {
            var cp = content && content.checkpoints ? content.checkpoints[next[id].cp] : null;
            stamps[id] = (cp && cp.edited) ? editedBaseline() : 0;
            touched = true;
          }
        } else {
          stamps[id] = now;         /* genuinely new item on this device */
          touched = true;
        }
        return;
      }
      if (!sameFlatItem(prev, next[id])) {
        stamps[id] = now;
        touched = true;
      }
    });

    /* Stamps for items that are gone are left alone. They cost a few bytes and
     * they are the only record of when the item last changed if another device
     * still holds it. Nothing here ever deletes state. */
    lastFlat = next;
    if (touched) writeJSON(SLOT_STAMPS, stamps);
  }

  /* The full shareable state: everything the crew has in common. */
  function getSharedState() {
    var snap = currentFlat();
    refreshStamps(snap.flat, snap.content);

    var items = {};
    Object.keys(snap.flat).forEach(function (id) {
      var e = snap.flat[id];
      items[id] = {
        cp: e.cp,
        phase: e.phase,
        order: e.order,
        text: e.text,
        critical: e.critical,
        draft: e.draft,
        done: e.done,
        /* The item's own stamp first; the side table only covers items that
         * have none. refreshStamps() has just reconciled the two, so this is
         * belt-and-braces against any future caller reaching in here directly. */
        lastModified: e.lastModified > 0 ? e.lastModified : ((id in stamps) ? stamps[id] : 0)
      };
    });

    return {
      v: 1,
      meta: { bib: metaState.bib, bibModified: metaState.bibModified },
      items: items
    };
  }

  /* Flat item map -> the nested shape checklist.setContent() wants, plus the
   * tick map. Items are grouped by checkpoint and phase and ordered by their
   * recorded position, with the timestamp and then the id as tie-breakers so
   * two phones rebuild the same list in the same order. */
  function rebuildFromItems(items) {
    var order = phaseListOf(null);
    var rows = [];

    Object.keys(items).forEach(function (id) {
      var e = items[id];
      if (!e || typeof e !== 'object') return;
      var text = typeof e.text === 'string' ? e.text : String(e.text === undefined || e.text === null ? '' : e.text);
      /* checklist.js drops empty-text items on the way in and on every reload,
       * so one here is a half-typed row, not data. Skipping it keeps the two
       * models from disagreeing about what exists. */
      if (!text.replace(/^\s+|\s+$/g, '')) return;

      var cp = (typeof e.cp === 'string' && e.cp) ? e.cp : 'unknown';
      /* An unknown phase (a device on a different checklists.json) lands in the
       * first phase rather than being dropped. Nothing is ever lost. */
      var phase = (order.indexOf(e.phase) >= 0) ? e.phase : order[0];
      var pos = Number(e.order);
      var lm = Number(e.lastModified);

      rows.push({
        id: id,
        cp: cp,
        phase: phase,
        pos: (pos === pos && isFinite(pos)) ? pos : 0,
        lm: (lm === lm && isFinite(lm)) ? lm : 0,
        text: text,
        critical: !!e.critical,
        draft: !!e.draft,
        done: !!e.done
      });
    });

    rows.sort(function (a, b) {
      if (a.pos !== b.pos) return a.pos - b.pos;
      if (a.lm !== b.lm) return a.lm - b.lm;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });

    var checkpoints = {};
    var ticks = {};
    rows.forEach(function (r) {
      if (!checkpoints[r.cp]) {
        checkpoints[r.cp] = {};
        order.forEach(function (p) { checkpoints[r.cp][p] = []; });
      }
      /* done and lastModified travel ON the item. checklist.js normalizeItem()
       * reads both, so a merged state lands complete in one setContent() call.
       * Emitting {id,text,critical,draft} only would hand checklist.js an item
       * with done=false and lastModified=0 — an un-tick would then leave no
       * trace on the item, and a 0 stamp reads as "never touched here", which
       * is what let a stale tick get replayed over a remote un-tick. */
      checkpoints[r.cp][r.phase].push({
        id: r.id, text: r.text, critical: r.critical, draft: r.draft,
        done: r.done, lastModified: r.lm
      });
      if (r.done) ticks[r.id] = true;
    });

    return { checkpoints: checkpoints, ticks: ticks };
  }

  /* Persist an already-merged state. Does NOT re-stamp: the timestamps that
   * came in are the truth the merge was decided on. Does NOT emit
   * 'utmb:local-change' either, or every remote update would bounce straight
   * back at the server as a "local edit". */
  function applyMergedState(state) {
    if (!state || typeof state !== 'object') return false;
    var cl = checklistApi();
    var wasDirty = dirty;
    var ok = true;

    applying = true;
    try {
      var m = (state.meta && typeof state.meta === 'object') ? state.meta : {};
      metaState = {
        bib: typeof m.bib === 'string' ? m.bib : '',
        bibModified: (typeof m.bibModified === 'number' && isFinite(m.bibModified)) ? m.bibModified : 0
      };
      writeJSON(SLOT_META, metaState);

      var items = (state.items && typeof state.items === 'object' && !Array.isArray(state.items))
        ? state.items : {};

      var nextStamps = {};
      Object.keys(items).forEach(function (id) {
        var lm = items[id] ? Number(items[id].lastModified) : 0;
        nextStamps[id] = (lm === lm && isFinite(lm)) ? lm : 0;
      });
      /* Keep stamps we already had for ids the merged state does not mention,
       * so a later merge still knows how old they are. */
      Object.keys(stamps).forEach(function (id) {
        if (!(id in nextStamps)) nextStamps[id] = stamps[id];
      });
      stamps = nextStamps;
      writeJSON(SLOT_STAMPS, stamps);

      if (cl && typeof cl.setContent === 'function') {
        var rebuilt = rebuildFromItems(items);
        cl.setContent({ checkpoints: rebuilt.checkpoints });
        if (typeof cl.setTicks === 'function') cl.setTicks(rebuilt.ticks);
      }
    } catch (err) {
      console.warn('[UTMB] could not apply merged state', err);
      ok = false;
    }
    applying = false;

    /* Re-baseline against what we just wrote, without stamping any of it. */
    lastFlat = currentFlat().flat;

    /* Writing through checklist.js flags the Save button dirty. Everything is
     * already on disk, so put it back the way we found it. */
    if (!wasDirty) markClean();
    return ok;
  }

  /* Suha's bib number — shared, so whoever finds it types it once. */
  function getBib() {
    return metaState.bib || '';
  }

  function setBib(value) {
    var next = typeof value === 'string' ? value
      : (value === null || value === undefined ? '' : String(value));
    next = next.replace(/^\s+|\s+$/g, '');
    if (next === metaState.bib) return metaState.bib;
    metaState = { bib: next, bibModified: Date.now() };
    writeJSON(SLOT_META, metaState);
    emitLocalChange({ source: 'bib' });
    return metaState.bib;
  }

  /* window event, not the UTMB bus: sync.js is a standalone IIFE with no
   * dependency on this file's internals beyond the documented API. */
  function emitLocalChange(detail) {
    if (applying) return;
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    var ev = null;
    try {
      ev = new CustomEvent('utmb:local-change', { detail: detail || null });
    } catch (err) {
      try {
        ev = document.createEvent('CustomEvent');
        ev.initCustomEvent('utmb:local-change', false, false, detail || null);
      } catch (err2) {
        return;
      }
    }
    try { window.dispatchEvent(ev); } catch (err3) { /* nothing sensible to do */ }
  }

  /* Baseline the stamps the moment the checklist has its content, so the first
   * real edit diffs against something. Registered here rather than in
   * checklist.js because store.js parses first and owns the bus. */
  UTMB.on('checklist:ready', function (payload) {
    if (lastFlat !== null) return;
    var content = payload && payload.content;
    if (content) refreshStamps(flattenContent(content, payload.ticks || {}), content);
    else {
      var snap = currentFlat();
      refreshStamps(snap.flat, snap.content);
    }
  });

  UTMB.on('checklist:change', function (payload) {
    if (applying) return;
    var content = payload && payload.content;
    if (content) refreshStamps(flattenContent(content, (payload && payload.ticks) || {}), content);
    else {
      var snap = currentFlat();
      refreshStamps(snap.flat, snap.content);
    }
    emitLocalChange({ source: 'checklist', reason: (payload && payload.reason) || '' });
  });

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
    writeJSON: writeJSON,

    /* ── shared live state, consumed by js/sync.js ──────────────────────
     * getSharedState()      -> {v:1, meta:{bib,bibModified},
     *                           items:{id:{cp,phase,order,text,critical,
     *                                      draft,done,lastModified}}}
     * applyMergedState(s)   writes a merged state back through checklist.js
     *                       without re-stamping. Returns false if it failed.
     * getBib() / setBib(v)  shared bib number; setBib fires the change event.
     * itemStamps()          clone of the {itemId: epochMs} side table.
     * isApplyingRemote()    true only inside applyMergedState().
     * emitLocalChange(d)    fire 'utmb:local-change' by hand, for a module
     *                       that mutates shared state some other way.
     */
    getSharedState: getSharedState,
    applyMergedState: applyMergedState,
    getBib: getBib,
    setBib: setBib,
    itemStamps: function () {
      var out = {};
      Object.keys(stamps).forEach(function (id) { out[id] = stamps[id]; });
      return out;
    },
    isApplyingRemote: function () { return applying; },
    emitLocalChange: emitLocalChange
  };

  /* ── cutoff display ───────────────────────────────────────────────────────
   * The same barrier time reaches the screen from two files: course.json /
   * checklists.json store it as a 12-hour string ("Sat 12:00 AM") and
   * shuttles.json stores it structured ("Sat" + "00:00"). Both end up on one
   * screen — the checklist board and the transport board sit next to each
   * other, and the drawer shows a cutoff badge directly above the transport
   * block — so they have to read the same way. "12:00 AM" is also the form
   * that gets misread as midday, and U3's barrier really is midnight.
   *
   * Presentation only: nothing rewrites the JSON, and a string that does not
   * match the 12-hour pattern is handed back untouched. */
  var CUTOFF_12H = /^(.*?)(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/;

  UTMB.fmtCutoff = function (raw) {
    if (typeof raw !== 'string') return raw;
    var m = CUTOFF_12H.exec(raw.replace(/^\s+|\s+$/g, ''));
    if (!m) return raw;
    var h = parseInt(m[2], 10);
    if (!(h >= 1 && h <= 12)) return raw;
    var pm = m[4].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    return (m[1] || '') + (h < 10 ? '0' : '') + h + ':' + m[3];
  };

  /* Convenience aliases used across modules. */
  UTMB.markDirty = markDirty;
  UTMB.markClean = markClean;
  UTMB.saveState = saveState;
})(window.UTMB);
