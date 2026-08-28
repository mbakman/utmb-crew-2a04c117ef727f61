/* checklist.js — per-checkpoint CREW CHECKLIST.
 *
 * Renders the crew checklist for the open checkpoint into #drawerChecklistMount,
 * plus an at-a-glance progress board into #checklistMount. Item text is Turkish
 * and is rendered VERBATIM — this module never translates, normalises or
 * "corrects" it. Everything is written with textContent, never innerHTML, so a
 * quote or an angle bracket in a crew note can never break the page.
 *
 * STATE — one shared document. This changed for race day:
 *
 *   CONTENT (shared)      the items themselves: id, text, critical, draft, done,
 *                         lastModified, and their order inside a phase.
 *                         localStorage key  utmb_checklist
 *                         shape { version, baseVersion, savedAt,
 *                                 checkpoints: { <cpId>: { before:[], onArrival:[], beforeLeaving:[] } } }
 *                         Only checkpoints the user has actually edited are
 *                         stored; untouched ones fall through to checklists.json,
 *                         so a later content update still reaches them.
 *
 *   TICKS ARE NOW SHARED. A tick is a change to the ITEM (item.done), not a
 *   separate per-device map: someone ticks "poles packed" and the whole crew
 *   sees it. Every item carries `lastModified` (epoch ms), stamped on ANY
 *   change to that item — tick, text, critical/draft flag, add, move, DELETE.
 *   sync.js merges item by item: union of both sides, newer lastModified wins
 *   the whole item. No id is ever dropped by an automatic merge.
 *
 *   DELETES ARE SHARED TOO, and they are TOMBSTONES. Deleting an item does not
 *   remove it from the document — it sets `deleted:true` and stamps it, so the
 *   delete travels through exactly the same "newer lastModified wins" merge as
 *   any other edit. A tombstone is invisible to everything a crew member can
 *   see or touch: it does not render, does not count, is not in getTicks(), is
 *   not exported into a share link, and findItem() will not return it. The one
 *   place it is visible is getContent(), because that is the wire shape
 *   store.js flattens into the shared state — and it has to carry the
 *   tombstone or the delete could not propagate.
 *
 *   Consequences, all deliberate:
 *     - A newer edit on another phone RESURRECTS the item (that edit is newer
 *       than the delete, so it wins the whole item and it comes back live).
 *     - A newer delete beats an older edit.
 *     - Tombstones are never garbage-collected. This is one race weekend and a
 *       few hundred items; a tombstone costs about 100 bytes.
 *
 *   The one hard delete left is a brand-new empty draft — the row created by
 *   "+ Add item" that is cancelled before any text is typed. store.js does not
 *   put an empty-text item into the shared state at all, so that row has
 *   provably never left this phone and there is nothing to tell anyone about.
 *
 *   An item that has never been changed on this device carries lastModified 0,
 *   so any real edit from any device beats it. Nothing here ever stamps an item
 *   just because the page was loaded.
 *
 *   utmb_checklist_ticks is still written, as a flat {itemId:true} projection of
 *   item.done, so the old share-link plumbing keeps working. It is a MIRROR, not
 *   a source of truth: on load it is only consulted to migrate ticks made before
 *   this change (items with no stamp).
 *
 *   All persistence goes through UTMB.store.set — never localStorage directly —
 *   because sync.js is instrumented on those calls.
 *
 * Public API — window.UTMB.checklist
 * ----------------------------------
 * The five share.js depends on:
 *
 *   getContent()          -> {version, updated, phaseOrder:[...], phaseLabels:{p:{en,tr}},
 *                             checkpoints: { <cpId>: {
 *                               name, km, cutoff, support, edited,
 *                               before:[item], onArrival:[item], beforeLeaving:[item] } }}
 *                            item = {id, text, critical, draft, done, lastModified,
 *                                    deleted}.
 *                            INCLUDES TOMBSTONES (deleted:true) — this is the
 *                            sync wire shape. Use exportContent() for the
 *                            human-facing view.
 *                            Deep clone: mutating the result changes nothing.
 *   exportContent()       the same shape with tombstones filtered out. share.js
 *                         picks this up automatically (it is first in its
 *                         READ_ALIASES list), so a share link never carries a
 *                         deleted row.
 *   setContent(obj)       accepts the getContent() shape OR a bare {cpId:{phases}} map;
 *                         replaces the edit overlay wholesale and returns getContent().
 *                         setContent(null) drops every edit back to checklists.json.
 *                         Ignores unknown keys, drops malformed items, never throws.
 *                         Carries done/lastModified through when they are present.
 *   getTicks()            -> {itemId: true}, projection of item.done across every
 *                         checkpoint. Clone.
 *   setTicks(obj)         sets item.done from a flat {itemId:true} map (every item not
 *                         listed is unticked), stamping each item it changes.
 *                         Returns getTicks().
 *   reload()              re-read the shared state out of UTMB.store and repaint.
 *                         This is what runs when sync.js fires
 *                         window CustomEvent('utmb:remote-update').
 *   onChange(cb)          cb({reason, cpId, content, ticks}); returns an unsubscribe fn.
 *                         reason is one of: content:set / checkpoint:set / checklist:create /
 *                         item:add / item:update / item:remove / item:move / tick /
 *                         ticks:set / ticks:reset. The same payload also goes out on the
 *                         UTMB bus as 'checklist:change'.
 *
 * Lifecycle — main.js drives this, and it drives it BEFORE share.js:
 *
 *   init(ctx)             folds checklists.json + the stored edits in and paints.
 *                         Idempotent. Also runs off UTMB.ready() if some other
 *                         page bootstraps the module for us.
 *   isReady()             false until init() has run. share.js will not diff an
 *                         incoming link before this is true — diffing against an
 *                         empty module reports every existing item as "added".
 *                         'checklist:ready' goes out on the bus at the same moment.
 *
 * Also available: checkpointIds(), getCheckpoint(cpId), setCheckpoint(cpId, phases),
 * items(cpId), progress(cpId) -> {done,total,criticalOpen,drafts}, phaseOrder(),
 * phaseLabels(), isTicked(id), setTick(id,on), toggleTick(id), resetTicks(cpId),
 * addItem(cpId,phase,text,opts), updateItem(cpId,id,{text,critical,draft}),
 * removeItem(cpId,id) (tombstones it — see above), moveItem(cpId,id,delta),
 * isEditMode(), setEditMode(on), render(), STORAGE.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * constants + module state
   * ═══════════════════════════════════════════════════════════════════════ */
  var SLOT_CONTENT = 'checklist';         /* -> localStorage "utmb_checklist"       */
  var SLOT_TICKS = 'checklist_ticks';     /* -> localStorage "utmb_checklist_ticks" */
  var SLOT_MIGRATED = 'ticks_migrated';   /* -> localStorage "utmb_ticks_migrated"  */

  var FALLBACK_ORDER = ['before', 'onArrival', 'beforeLeaving'];
  var FALLBACK_LABELS = {
    before: { en: 'Before he arrives', tr: 'Gelmeden once' },
    onArrival: { en: 'On arrival', tr: 'Gelince' },
    beforeLeaving: { en: 'Before he leaves', tr: 'Ayrilmadan once' }
  };

  var seed = { version: '', updated: '', checkpoints: {}, crew: [] };
  var seedCache = Object.create(null);
  var phaseOrder = FALLBACK_ORDER.slice();
  var phaseLabels = FALLBACK_LABELS;

  var overrides = Object.create(null);    /* cpId -> {phase: [item]}  (edited only) */

  /* Ticks made BEFORE ticks became shared, read once out of utmb_checklist_ticks
   * and folded into the items in loadPersisted(). Kept afterwards only so a tick
   * whose item no longer exists cannot resurrect. item.done is the truth. */
  var legacyTicks = Object.create(null);  /* itemId -> true */
  var migratedLegacy = false;             /* the fold-in above runs once, at boot */

  var course = null;
  var booted = false;
  var listeners = [];

  var editMode = false;                   /* sticky for the session, never persisted */
  var editing = null;                     /* {cpId, phase, id, isNew}                */
  var confirming = null;                  /* {kind:'item'|'reset', cpId, id}         */
  var pendingFocus = null;                /* element to focus after a render         */
  var suppressBlurCommit = false;
  var viewportHandler = null;
  var idSeq = 0;

  /* ═══════════════════════════════════════════════════════════════════════
   * tiny helpers
   * ═══════════════════════════════════════════════════════════════════════ */
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function txt(v) { return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v)); }

  function trim(v) { return txt(v).replace(/^\s+|\s+$/g, ''); }

  function toast(msg) { if (typeof UTMB.toast === 'function') UTMB.toast(msg); }

  /* store.js owns the 12h -> 24h cutoff formatter; fall back to the raw string
   * if this file is ever loaded without it. Display only — the stored value and
   * everything getContent() hands to share.js are untouched. */
  function fmtCutoff(raw) {
    return typeof UTMB.fmtCutoff === 'function' ? UTMB.fmtCutoff(raw) : raw;
  }

  function mintId(cpId, phase) {
    idSeq += 1;
    return (cpId || 'cp') + '-' + (phase || 'item') + '-u' + Date.now().toString(36) +
      idSeq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
  }

  function emptyPhases() {
    var out = {};
    phaseOrder.forEach(function (p) { out[p] = []; });
    return out;
  }

  function labelFor(phase) {
    var l = phaseLabels[phase];
    return (l && l.en) || (FALLBACK_LABELS[phase] && FALLBACK_LABELS[phase].en) || phase;
  }

  function labelTr(phase) {
    var l = phaseLabels[phase];
    return (l && l.tr) || (FALLBACK_LABELS[phase] && FALLBACK_LABELS[phase].tr) || '';
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * normalisation — everything that enters the module goes through here, so a
   * hand-edited localStorage blob or a bad import can never poison the render.
   * ═══════════════════════════════════════════════════════════════════════ */
  /* An epoch-ms stamp, or 0 for "never explicitly changed here". Never invents
   * a stamp: a missing/garbage value must lose to any real edit from any device,
   * and must not make a page load look like a change. */
  function stampOf(raw) {
    var n = typeof raw === 'number' ? raw : parseInt(raw, 10);
    return (typeof n === 'number' && isFinite(n) && n > 0) ? n : 0;
  }

  function now() { return Date.now(); }

  function normalizeItem(raw, cpId, phase, seen) {
    var text = '', id = '', critical = false, draft = false, done = false, stamp = 0;
    var deleted = false;
    if (typeof raw === 'string') {
      text = raw;
    } else if (isObj(raw)) {
      text = txt(raw.text);
      id = trim(raw.id);
      critical = !!raw.critical;
      draft = !!raw.draft;
      done = !!raw.done;
      stamp = stampOf(raw.lastModified);
      /* Absent means live. An older server document, or a phone still running
       * the previous build, simply has no such field. */
      deleted = !!raw.deleted;
    } else {
      return null;
    }
    text = text.replace(/\s+$/, '');
    /* Empty text is a half-typed row, not data — EXCEPT on a tombstone, whose
     * whole job is to exist without content. Dropping those here would delete
     * the delete and the item would come straight back on the next merge. */
    if (!text && !deleted) return null;
    if (!id || seen[id]) id = mintId(cpId, phase);
    seen[id] = true;
    /* A tombstone is never ticked: getTicks() cannot see it, so a stale done
     * would only ever be noise on the wire. */
    if (deleted) done = false;
    return {
      id: id, text: text, critical: critical, draft: draft,
      done: done, lastModified: stamp, deleted: deleted
    };
  }

  function normalizePhases(cpId, raw) {
    var out = {};
    var seen = Object.create(null);
    phaseOrder.forEach(function (phase) {
      var arr = (isObj(raw) && Array.isArray(raw[phase])) ? raw[phase] : [];
      var list = [];
      arr.forEach(function (entry) {
        var item = normalizeItem(entry, cpId, phase, seen);
        if (item) list.push(item);
      });
      out[phase] = list;
    });
    return out;
  }

  function cloneItem(it) {
    return {
      id: it.id,
      text: it.text,
      critical: !!it.critical,
      draft: !!it.draft,
      done: !!it.done,
      lastModified: stampOf(it.lastModified),
      deleted: !!it.deleted
    };
  }

  function clonePhases(phases) {
    var out = {};
    phaseOrder.forEach(function (phase) {
      out[phase] = (phases[phase] || []).map(cloneItem);
    });
    return out;
  }

  /* ── tombstones ──────────────────────────────────────────────────────────
   * A deleted item stays in the array, flagged. `live` is the filter every
   * read path that a crew member can see goes through; the raw array is only
   * touched by persistence, getContent() (the sync wire shape) and the
   * mutations that have to keep the tombstone's position. */
  function isLive(it) { return !!it && !it.deleted; }

  function liveIn(phases, phase) {
    return (phases && Array.isArray(phases[phase]) ? phases[phase] : []).filter(isLive);
  }

  function livePhases(phases) {
    var out = {};
    phaseOrder.forEach(function (phase) {
      out[phase] = liveIn(phases, phase).map(cloneItem);
    });
    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * content model: seed (checklists.json)  <-overlaid by->  overrides (edits)
   * ═══════════════════════════════════════════════════════════════════════ */
  function seedFor(cpId) {
    if (!(cpId in seedCache)) {
      var raw = seed.checkpoints && seed.checkpoints[cpId];
      seedCache[cpId] = isObj(raw) ? normalizePhases(cpId, raw) : null;
    }
    return seedCache[cpId];
  }

  /* The live content for a checkpoint, or null when it has no checklist yet. */
  function effective(cpId) {
    if (overrides[cpId]) return overrides[cpId];
    return seedFor(cpId);
  }

  /* Promote a checkpoint into the editable overlay before mutating it. */
  function ensureOverride(cpId) {
    if (!overrides[cpId]) {
      var base = seedFor(cpId);
      overrides[cpId] = base ? clonePhases(base) : emptyPhases();
    }
    return overrides[cpId];
  }

  function meta(cpId) {
    var raw = seed.checkpoints && seed.checkpoints[cpId];
    var cp = null;
    if (course && Array.isArray(course.cps)) {
      cp = course.cps.filter(function (c) { return c.id === cpId; })[0] || null;
    }
    return {
      id: cpId,
      name: (cp && cp.name) || (isObj(raw) && txt(raw.name)) || cpId,
      km: cp ? cp.km : (isObj(raw) ? raw.km : null),
      cutoff: (cp && cp.cutoff) || (isObj(raw) && txt(raw.cutoff)) || '',
      support: (cp && cp.support) || (isObj(raw) && txt(raw.support)) || '',
      supporter: cp ? !!cp.supporter : (seed.crew.indexOf(cpId) >= 0)
    };
  }

  /* Every checkpoint that has a checklist, in course order. */
  function checkpointIds() {
    var set = Object.create(null);
    Object.keys(seed.checkpoints || {}).forEach(function (k) { set[k] = true; });
    Object.keys(overrides).forEach(function (k) { set[k] = true; });
    var ids = Object.keys(set);
    if (course && Array.isArray(course.cps)) {
      var order = {};
      course.cps.forEach(function (c, i) { order[c.id] = i; });
      ids.sort(function (a, b) {
        var oa = order[a] === undefined ? 9999 : order[a];
        var ob = order[b] === undefined ? 9999 : order[b];
        return oa - ob;
      });
    } else {
      ids.sort();
    }
    return ids;
  }

  /* Live items only. Everything that counts, renders or projects ticks starts
   * here, so a tombstone can never reach the screen or a total. */
  function itemsOf(cpId) {
    var phases = effective(cpId);
    if (!phases) return [];
    var out = [];
    phaseOrder.forEach(function (p) { out = out.concat(liveIn(phases, p)); });
    return out;
  }

  /* `index` is the position in the RAW array — tombstones included — because
   * that is what removeItem() and moveItem() splice against. A tombstone is
   * never returned: to the rest of the module the item is gone. */
  function findItem(cpId, itemId) {
    var phases = effective(cpId);
    if (!phases) return null;
    for (var i = 0; i < phaseOrder.length; i++) {
      var phase = phaseOrder[i];
      var list = phases[phase] || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === itemId) {
          return isLive(list[j]) ? { phase: phase, index: j, item: list[j] } : null;
        }
      }
    }
    return null;
  }

  /* An item id is unique across the whole board, and a tick arrives as a bare
   * id, so this is how a tick finds the checkpoint that owns it. */
  function findAnywhere(itemId) {
    if (!itemId) return null;
    var ids = checkpointIds();
    for (var i = 0; i < ids.length; i++) {
      var hit = findItem(ids[i], itemId);
      if (hit) return { cpId: ids[i], phase: hit.phase, index: hit.index, item: hit.item };
    }
    return null;
  }

  function isDone(itemId) {
    var hit = findAnywhere(itemId);
    return hit ? !!hit.item.done : !!legacyTicks[itemId];
  }

  function progressOf(cpId) {
    var all = itemsOf(cpId);
    var done = 0, critOpen = 0, drafts = 0;
    all.forEach(function (it) {
      if (it.done) done += 1;
      else if (it.critical) critOpen += 1;
      if (it.draft) drafts += 1;
    });
    return { done: done, total: all.length, criticalOpen: critOpen, drafts: drafts };
  }

  function phaseProgress(cpId, phase) {
    var list = liveIn(effective(cpId), phase);
    var done = 0;
    list.forEach(function (it) { if (it.done) done += 1; });
    return { done: done, total: list.length };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * persistence
   * ═══════════════════════════════════════════════════════════════════════ */
  function persistContent() {
    UTMB.store.set(SLOT_CONTENT, {
      version: 1,
      baseVersion: seed.version || null,
      savedAt: new Date().toISOString(),
      checkpoints: overrides
    });
  }

  /* The flat {itemId:true} mirror of item.done. Written for the older share-link
   * plumbing that still reads this slot; never read back as truth. */
  function persistTicks() {
    UTMB.store.set(SLOT_TICKS, getTicks());
  }

  /* Ticks taken before ticks were shared live in utmb_checklist_ticks and not on
   * the items. Fold them in ONCE, and only onto items that carry no stamp — an
   * item someone has actually edited since must not be overwritten by this
   * device's history. The stamp stays 0 so a real remote edit still wins.
   *
   * "ONCE" means once per DEVICE, not once per page load. migratedLegacy is
   * module state and a reload resets it, so the fact that it ran is recorded in
   * localStorage instead. Without that, the mirror slot — which is now written
   * from item.done on every content change — turns into a second source of
   * truth that a reload replays over the top of a remote UN-tick, resurrecting
   * the tick and pushing it back out to the whole crew. */
  function migrateLegacyTicks() {
    var ids = Object.keys(legacyTicks);
    if (!ids.length) return 0;
    var moved = 0;
    ids.forEach(function (itemId) {
      var hit = findAnywhere(itemId);
      if (!hit || hit.item.done || hit.item.lastModified) return;
      ensureOverride(hit.cpId);
      var live = findItem(hit.cpId, itemId);
      if (!live) return;
      live.item.done = true;
      moved += 1;
    });
    if (moved) persistContent();
    return moved;
  }

  function loadPersisted() {
    var rawContent = UTMB.store.get(SLOT_CONTENT, null);
    if (isObj(rawContent)) {
      var src = isObj(rawContent.checkpoints) ? rawContent.checkpoints : rawContent;
      Object.keys(src).forEach(function (cpId) {
        if (isObj(src[cpId])) overrides[cpId] = normalizePhases(cpId, src[cpId]);
      });
    }
    /* First boot on this device only. A remote update must never be
     * re-interpreted through this device's pre-sync tick history — and after
     * the first run the mirror slot is just a projection of item.done, so
     * replaying it can only ever undo somebody else's un-tick.
     *
     * The flag is written with writeJSON, not set(), because set() fires
     * 'utmb:local-change' and a bookkeeping flag is not a crew edit. */
    if (!migratedLegacy) {
      migratedLegacy = true;
      var alreadyRun = UTMB.store.readJSON('utmb_' + SLOT_MIGRATED, false) === true;
      if (!alreadyRun) {
        var rawTicks = UTMB.store.get(SLOT_TICKS, null);
        if (isObj(rawTicks)) {
          Object.keys(rawTicks).forEach(function (id) { if (rawTicks[id]) legacyTicks[id] = true; });
        }
        migrateLegacyTicks();
        UTMB.store.writeJSON('utmb_' + SLOT_MIGRATED, true);
      }
    }
  }

  /* A cheap value fingerprint of everything that is shared, used to decide
   * whether a reload actually changed anything. */
  function fingerprint() {
    var parts = [];
    checkpointIds().forEach(function (cpId) {
      itemsOf(cpId).forEach(function (it) {
        parts.push(cpId + '' + it.id + '' + it.text + '' +
          (it.critical ? 1 : 0) + (it.draft ? 1 : 0) + (it.done ? 1 : 0));
      });
    });
    return parts.join('');
  }

  /* Re-read the shared state out of the store and repaint. This is the whole
   * client half of the sync contract: sync.js merges, writes through the store,
   * then fires window CustomEvent('utmb:remote-update') and we come here.
   * Silent — no prompt, no diff sheet; that UI belongs to the share-link path.
   *
   * The change event is emitted ONLY if the reload actually moved something.
   * store.js turns 'checklist:change' into 'utmb:local-change', which sync.js
   * reads as "this device edited something, push it" — so an unconditional
   * notify here would bounce every remote update straight back at the server
   * and two phones would ping-pong versions at each other all night. When
   * sync.js has already landed the merge through setContent()/setTicks() the
   * repaint and the notify have happened; this is then a no-op by design. */
  function reload() {
    var before = fingerprint();
    overrides = Object.create(null);
    seedCache = Object.create(null);
    editing = null;
    confirming = null;
    loadPersisted();
    renderAll();
    if (fingerprint() !== before) notify('remote:update', null);
    return getContent();
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * change notification
   * ═══════════════════════════════════════════════════════════════════════ */
  function notify(reason, cpId) {
    var payload = {
      reason: reason,
      cpId: cpId || null,
      content: getContent(),
      ticks: getTicks()
    };
    listeners.slice().forEach(function (fn) {
      try { fn(payload); } catch (err) {
        console.error('[UTMB] checklist onChange listener threw', err);
      }
    });
    UTMB.emit('checklist:change', payload);
  }

  /* Content changed: write it, flag the header Save button, repaint, announce.
   *
   * persistTicks() is not optional here. A tick rides on the item now, so any
   * content write can change it — setContent() landing a merged state is the
   * common case, and it can un-tick without setTicks() seeing a diff to report.
   * Leaving the mirror behind would strand the OLD tick in localStorage, where
   * the next reload picks it up as "legacy" history and puts it back. */
  function afterContentChange(reason, cpId) {
    persistContent();
    persistTicks();
    UTMB.store.markDirty();
    renderAll();
    notify(reason, cpId);
  }

  /* A tick is content now, so it is written to the content slot as well as the
   * flat mirror. Deliberately does NOT markDirty: a tick is already saved the
   * instant it is made, and turning the header Save button red every time
   * someone ticks a box would make that warning meaningless on race day. */
  function afterTickChange(reason, cpId) {
    persistContent();
    persistTicks();
    renderAll();
    notify(reason, cpId);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * mutations
   * ═══════════════════════════════════════════════════════════════════════ */
  function addItem(cpId, phase, text, opts) {
    if (!cpId || phaseOrder.indexOf(phase) < 0) return null;
    opts = opts || {};
    var phases = ensureOverride(cpId);
    var item = {
      id: mintId(cpId, phase),
      text: txt(text),
      critical: !!opts.critical,
      draft: !!opts.draft,
      done: false,
      lastModified: now()
    };
    if (typeof opts.index === 'number' && opts.index >= 0 && opts.index < phases[phase].length) {
      phases[phase].splice(opts.index, 0, item);
    } else {
      phases[phase].push(item);
    }
    if (opts.silent !== true) afterContentChange('item:add', cpId);
    return item.id;
  }

  function updateItem(cpId, itemId, patch) {
    if (!findItem(cpId, itemId)) return false;
    ensureOverride(cpId);
    var hit = findItem(cpId, itemId);
    if (!hit) return false;
    if (patch && typeof patch.text === 'string') {
      var t = patch.text.replace(/\s+$/, '');
      if (!trim(t)) return false;
      hit.item.text = t;
    }
    if (patch && 'critical' in patch) hit.item.critical = !!patch.critical;
    if (patch && 'draft' in patch) hit.item.draft = !!patch.draft;
    if (patch && 'done' in patch) hit.item.done = !!patch.done;
    hit.item.lastModified = now();
    afterContentChange('item:update', cpId);
    return true;
  }

  /* DELETE = TOMBSTONE. The row leaves the screen, but the id stays in the
   * document flagged `deleted` and freshly stamped, so sync.js carries the
   * delete to the other phones through the same "newer lastModified wins"
   * rule as any other edit. Hard-removing it here instead would leave the
   * other phones holding a live copy with an older stamp, and the union merge
   * would seed it straight back.
   *
   * The single exception is a row that has provably never left this phone: an
   * empty-text item, which store.js keeps out of the shared state entirely.
   * That is the "+ Add item" row someone opened and cancelled, and there is
   * nobody to tell about it. */
  function removeItem(cpId, itemId, opts) {
    if (!findItem(cpId, itemId)) return false;
    ensureOverride(cpId);
    var hit = findItem(cpId, itemId);
    if (!hit) return false;

    if (!trim(hit.item.text)) {
      overrides[cpId][hit.phase].splice(hit.index, 1);
    } else {
      hit.item.deleted = true;
      hit.item.done = false;
      hit.item.lastModified = now();
    }

    /* The tick went with the item — it lives on the item now. Drop the stale
     * mirror entry so the boot migration cannot resurrect it. */
    if (legacyTicks[itemId]) delete legacyTicks[itemId];
    persistTicks();
    if (!opts || opts.silent !== true) afterContentChange('item:remove', cpId);
    return true;
  }

  /* Swap with the item `delta` places away among the LIVE items — tombstones
   * hold their slot and are stepped over, so a deleted row between two live
   * ones cannot swallow a tap on ▲/▼. Both items moved, so both are stamped:
   * stamping only one would let the other's older copy win the next merge and
   * put the pair back the way they were. */
  function moveItem(cpId, itemId, delta) {
    var hit = findItem(cpId, itemId);
    if (!hit) return false;
    ensureOverride(cpId);
    hit = findItem(cpId, itemId);
    if (!hit) return false;
    var list = overrides[cpId][hit.phase];
    var step = delta < 0 ? -1 : 1;
    var remaining = Math.abs(delta);
    if (!remaining) return false;

    var next = hit.index;
    while (remaining > 0) {
      do { next += step; } while (next >= 0 && next < list.length && !isLive(list[next]));
      if (next < 0 || next >= list.length) return false;
      remaining -= 1;
    }

    var stamp = now();
    var moved = list[hit.index];
    list[hit.index] = list[next];
    list[next] = moved;
    moved.lastModified = stamp;
    list[hit.index].lastModified = stamp;
    afterContentChange('item:move', cpId);
    return true;
  }

  /* A tick is a change to the item, and the item is shared: the whole crew sees
   * it. Promotes the checkpoint into the edit overlay first, because that is
   * where the shared document lives. */
  function setTick(itemId, on) {
    if (!itemId) return;
    var hit = findAnywhere(itemId);
    if (!hit) return;
    if (!!hit.item.done === !!on) return;
    ensureOverride(hit.cpId);
    var live = findItem(hit.cpId, itemId);
    if (!live) return;
    live.item.done = !!on;
    live.item.lastModified = now();
    afterTickChange('tick', hit.cpId);
  }

  function toggleTick(itemId) { setTick(itemId, !isDone(itemId)); }

  function resetTicks(cpId) {
    var cleared = 0;
    var stamp = now();
    if (itemsOf(cpId).some(function (it) { return it.done; })) ensureOverride(cpId);
    itemsOf(cpId).forEach(function (it) {
      if (it.done) { it.done = false; it.lastModified = stamp; cleared += 1; }
    });
    if (cleared) afterTickChange('ticks:reset', cpId);
    else renderAll();   /* nothing was ticked, but the confirm panel must close */
    return cleared;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * public API surface
   * ═══════════════════════════════════════════════════════════════════════ */
  /* The SYNC wire shape: tombstones included. store.js flattens this into the
   * shared state, so leaving a tombstone out here would mean the delete never
   * leaves the phone. Anything human-facing wants exportContent() instead. */
  function contentShape(project) {
    var out = {
      version: seed.version || '1.0.0',
      updated: seed.updated || '',
      phaseOrder: phaseOrder.slice(),
      phaseLabels: {},
      checkpoints: {}
    };
    phaseOrder.forEach(function (p) {
      out.phaseLabels[p] = { en: labelFor(p), tr: labelTr(p) };
    });
    checkpointIds().forEach(function (cpId) {
      var phases = effective(cpId);
      if (!phases) return;
      var m = meta(cpId);
      var entry = project(phases);
      entry.name = m.name;
      entry.km = m.km;
      entry.cutoff = m.cutoff;
      entry.support = m.support;
      entry.edited = !!overrides[cpId];
      out.checkpoints[cpId] = entry;
    });
    return out;
  }

  function getContent() { return contentShape(clonePhases); }

  /* The same document with the tombstones taken out — what a share link, a
   * file export or any other human-facing consumer should see. share.js tries
   * exportContent() before getContent(), so it picks this up on its own. */
  function exportContent() { return contentShape(livePhases); }

  /* Every tombstone in the document right now, by id, with where it sat. */
  function tombstoneIndex() {
    var out = Object.create(null);
    Object.keys(overrides).forEach(function (cpId) {
      phaseOrder.forEach(function (phase) {
        (overrides[cpId][phase] || []).forEach(function (it) {
          if (it && it.deleted && it.id) {
            out[it.id] = { cpId: cpId, phase: phase, item: cloneItem(it) };
          }
        });
      });
    });
    return out;
  }

  /* Raw lookup across the whole overlay — tombstones included, unlike
   * findItem(). Only carryTombstones() needs this. */
  function findRawAnywhere(itemId) {
    var cps = Object.keys(overrides);
    for (var i = 0; i < cps.length; i++) {
      for (var p = 0; p < phaseOrder.length; p++) {
        var list = overrides[cps[i]][phaseOrder[p]] || [];
        for (var j = 0; j < list.length; j++) {
          if (list[j].id === itemId) {
            return { cpId: cps[i], phase: phaseOrder[p], index: j, item: list[j] };
          }
        }
      }
    }
    return null;
  }

  /* Re-apply the tombstones a replacement document did not account for.
   *
   * Replacing the overlay wholesale is how a merged state, an accepted share
   * link and a reset-to-defaults all land, and the seed underneath the overlay
   * still contains every row the crew deleted. Without this, any of those
   * would quietly un-delete those rows — and then push the resurrection to the
   * whole crew, because a POST replaces the entire server document rather than
   * merging into it.
   *
   * The test is the app's one rule, newer lastModified wins: an incoming copy
   * stamped LATER than the delete is a genuine un-delete and is left alone
   * (that is how a newer edit on another phone brings a row back). Anything
   * older — seed content stamped 0, an unchanged share-link row — loses and is
   * put back under its tombstone. */
  function carryTombstones(index) {
    Object.keys(index).forEach(function (id) {
      var rec = index[id];
      ensureOverride(rec.cpId);
      var hit = findRawAnywhere(id);
      if (hit) {
        if (stampOf(hit.item.lastModified) > rec.item.lastModified) return;
        hit.item.deleted = true;
        hit.item.done = false;
        hit.item.lastModified = rec.item.lastModified;
        return;
      }
      var phases = overrides[rec.cpId];
      var phase = phaseOrder.indexOf(rec.phase) >= 0 ? rec.phase : phaseOrder[0];
      if (!Array.isArray(phases[phase])) phases[phase] = [];
      phases[phase].push(rec.item);
    });
  }

  /* Accepts either the full getContent() shape or a bare {cpId: {phases}} map.
   * Replaces the edit overlay wholesale. setContent(null) drops every edit and
   * falls back to checklists.json. Ticks are untouched — they are not content.
   * Tombstones survive: see carryTombstones() above. */
  function setContent(next) {
    var src = null;
    if (isObj(next)) src = isObj(next.checkpoints) ? next.checkpoints : next;
    var carried = tombstoneIndex();
    var fresh = Object.create(null);
    if (src) {
      Object.keys(src).forEach(function (cpId) {
        if (isObj(src[cpId])) fresh[cpId] = normalizePhases(cpId, src[cpId]);
      });
    }
    overrides = fresh;
    carryTombstones(carried);
    editing = null;
    confirming = null;
    afterContentChange('content:set', null);
    return getContent();
  }

  /* Flat {itemId:true} projection of item.done across every checkpoint. Kept for
   * share.js, which prunes ticks whose item an incoming link removed. */
  function getTicks() {
    var out = {};
    checkpointIds().forEach(function (cpId) {
      itemsOf(cpId).forEach(function (it) { if (it.done) out[it.id] = true; });
    });
    return out;
  }

  /* Applies a flat tick map onto the items: anything not listed is unticked.
   * Only items whose state actually changes are stamped. */
  function setTicks(next) {
    var want = Object.create(null);
    if (isObj(next)) {
      Object.keys(next).forEach(function (id) { if (next[id]) want[id] = true; });
    }
    var stamp = now();
    var changed = 0;
    checkpointIds().forEach(function (cpId) {
      var dirty = itemsOf(cpId).some(function (it) { return !!it.done !== !!want[it.id]; });
      if (!dirty) return;
      ensureOverride(cpId);
      itemsOf(cpId).forEach(function (it) {
        var target = !!want[it.id];
        if (!!it.done === target) return;
        it.done = target;
        it.lastModified = stamp;
        changed += 1;
      });
    });
    if (changed) afterTickChange('ticks:set', null);
    return getTicks();
  }

  /* One checkpoint's LIVE content, cloned. null when it has no checklist.
   * Tombstones are filtered: this is a consumer-facing read, not the sync
   * wire shape (that is getContent()). */
  function getCheckpoint(cpId) {
    var phases = effective(cpId);
    return phases ? livePhases(phases) : null;
  }

  /* Replace one checkpoint's content. setCheckpoint(cpId, null) drops the edit
   * overlay for it, so it falls back to checklists.json — but not so far back
   * that the seed's copy of a deleted row comes with it, so this carries the
   * tombstones the same way setContent() does. */
  function setCheckpoint(cpId, phases) {
    if (!cpId) return null;
    var carried = tombstoneIndex();
    if (phases === null) {
      delete overrides[cpId];
    } else if (isObj(phases)) {
      var src = isObj(phases.checkpoints) ? phases.checkpoints[cpId] : phases;
      if (!isObj(src)) return null;
      overrides[cpId] = normalizePhases(cpId, src);
    } else {
      return null;
    }
    carryTombstones(carried);
    editing = null;
    confirming = null;
    afterContentChange('checkpoint:set', cpId);
    return getCheckpoint(cpId);
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return function () {};
    listeners.push(cb);
    return function () {
      var i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * DOM helpers
   * ═══════════════════════════════════════════════════════════════════════ */
  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== null && text !== undefined) node.textContent = text;
    return node;
  }

  function mkBtn(cls, label, aria, fn, disabled) {
    var b = h('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    if (disabled) {
      b.disabled = true;
      b.setAttribute('aria-disabled', 'true');
    }
    if (fn) {
      b.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (b.disabled) return;
        fn(ev);
      });
    }
    return b;
  }

  /* iOS: keep a focused input above the on-screen keyboard. Runs a few times
   * because the keyboard animates in and the viewport keeps changing. */
  function keepVisible(node) {
    if (!node) return;
    var run = function () {
      if (!node.isConnected) return;
      try { node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      catch (err) { node.scrollIntoView(false); }
    };
    run();
    setTimeout(run, 180);
    setTimeout(run, 480);
  }

  function bindViewport(node) {
    unbindViewport();
    if (!window.visualViewport) return;
    viewportHandler = function () { keepVisible(node); };
    window.visualViewport.addEventListener('resize', viewportHandler);
  }

  function unbindViewport() {
    if (viewportHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', viewportHandler);
    }
    viewportHandler = null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * inline edit lifecycle
   * ═══════════════════════════════════════════════════════════════════════ */
  function startEdit(cpId, phase, itemId, isNew) {
    editing = { cpId: cpId, phase: phase, id: itemId, isNew: !!isNew };
    confirming = null;
    renderAll();
  }

  function commitEdit(value) {
    if (!editing) return;
    var cur = editing;
    editing = null;                    /* first, so the blur handler no-ops */
    unbindViewport();
    var text = trim(value);
    if (!text) {
      if (cur.isNew) {
        removeItem(cur.cpId, cur.id);  /* an empty brand-new item: nothing to lose */
      } else {
        renderAll();
        toast('Item text cannot be empty');
      }
      return;
    }
    /* Editing the wording of a generated item counts as reviewing it. */
    updateItem(cur.cpId, cur.id, { text: text, draft: false });
    if (cur.isNew) toast('Item added');
  }

  function cancelEdit() {
    if (!editing) return;
    var cur = editing;
    editing = null;
    unbindViewport();
    if (cur.isNew) { removeItem(cur.cpId, cur.id); return; }
    renderAll();
  }

  function buildEditor(cpId, item) {
    var wrap = h('div', 'ck-edit');

    var ta = document.createElement('textarea');
    ta.className = 'ck-ta';
    ta.value = item.text;
    ta.rows = Math.min(6, Math.max(2, Math.ceil((item.text.length || 1) / 34)));
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocapitalize', 'sentences');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('enterkeyhint', 'done');
    ta.setAttribute('aria-label', 'Item text');

    ta.addEventListener('focus', function () {
      keepVisible(wrap);
      bindViewport(wrap);
    });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        ev.stopPropagation();
        commitEdit(ta.value);
      } else if (ev.key === 'Escape') {
        /* stopPropagation so drawer.js does not close the whole drawer. */
        ev.preventDefault();
        ev.stopPropagation();
        suppressBlurCommit = true;
        cancelEdit();
      }
    });
    ta.addEventListener('blur', function () {
      if (suppressBlurCommit) { suppressBlurCommit = false; return; }
      commitEdit(ta.value);
    });
    wrap.appendChild(ta);

    var btns = h('div', 'ck-edit-btns');

    var critBtn = mkBtn(
      'ck-btn ck-btn-ghost ck-btn-crit' + (item.critical ? ' is-on' : ''),
      item.critical ? '! Critical' : '! Mark critical',
      'Toggle critical',
      function () {
        /* Persist the in-progress text before flipping the flag, so a half-typed
         * rename is not lost by the re-render. */
        var pending = trim(ta.value);
        ensureOverride(cpId);
        var hit = findItem(cpId, item.id);
        if (hit) {
          if (pending) hit.item.text = ta.value.replace(/\s+$/, '');
          hit.item.critical = !hit.item.critical;
        }
        suppressBlurCommit = true;
        persistContent();
        UTMB.store.markDirty();
        renderAll();
        notify('item:update', cpId);
      }
    );
    btns.appendChild(critBtn);

    var save = mkBtn('ck-btn ck-btn-primary', 'Save', 'Save item text', function () {
      commitEdit(ta.value);
    });
    btns.appendChild(save);

    var cancel = mkBtn('ck-btn ck-btn-ghost', 'Cancel', 'Cancel editing', function () {
      cancelEdit();
    });
    /* These fire before blur, so the blur handler knows not to commit. */
    ['pointerdown', 'mousedown', 'touchstart'].forEach(function (evt) {
      cancel.addEventListener(evt, function () { suppressBlurCommit = true; }, { passive: true });
      critBtn.addEventListener(evt, function () { suppressBlurCommit = true; }, { passive: true });
    });
    btns.appendChild(cancel);

    wrap.appendChild(btns);
    pendingFocus = ta;
    return wrap;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * item row
   * ═══════════════════════════════════════════════════════════════════════ */
  function buildItem(cpId, phase, item, index, count) {
    var done = !!item.done;
    var li = h('li', 'ck-item' +
      (done ? ' is-done' : '') +
      (item.critical ? ' is-critical' : '') +
      (item.draft ? ' is-draft' : ''));

    /* delete confirmation replaces the row entirely — nothing is ever removed
     * without the user reading the exact text they are about to lose. */
    if (confirming && confirming.kind === 'item' && confirming.cpId === cpId && confirming.id === item.id) {
      li.className += ' is-confirm';
      var cf = h('div', 'ck-confirm');
      cf.appendChild(h('div', 'ck-confirm-q', 'Delete this item?'));
      cf.appendChild(h('div', 'ck-confirm-txt', item.text));
      var cfb = h('div', 'ck-confirm-btns');
      cfb.appendChild(mkBtn('ck-btn ck-btn-danger', 'Delete', 'Confirm delete', function () {
        confirming = null;
        removeItem(cpId, item.id);
        toast('Item deleted');
      }));
      cfb.appendChild(mkBtn('ck-btn ck-btn-ghost', 'Keep it', 'Cancel delete', function () {
        confirming = null;
        renderAll();
      }));
      cf.appendChild(cfb);
      li.appendChild(cf);
      return li;
    }

    var row = h('div', 'ck-row');

    var tick = mkBtn('ck-tick' + (done ? ' is-on' : ''), done ? '✓' : '',
      (done ? 'Untick: ' : 'Tick off: ') + item.text, function () { toggleTick(item.id); });
    tick.setAttribute('role', 'checkbox');
    tick.setAttribute('aria-checked', done ? 'true' : 'false');
    row.appendChild(tick);

    var body = h('div', 'ck-body');

    if (editing && editing.cpId === cpId && editing.id === item.id) {
      body.appendChild(buildEditor(cpId, item));
    } else {
      var textNode = h('div', 'ck-text', item.text);   /* verbatim Turkish */
      body.appendChild(textNode);

      if (item.critical) {
        var chips = h('div', 'ck-chips');
        chips.appendChild(h('span', 'ck-chip ck-chip-crit', 'Critical'));
        body.appendChild(chips);
      }

      /* Draft = generated for the user, not written by them. One compact row:
       * a label that says why, and one button to accept it. Rewording goes
       * through Edit list > Rename, so there is only ever one way to do it. */
      if (item.draft) {
        var dr = h('div', 'ck-draft');
        dr.appendChild(h('span', 'ck-draft-label', 'Draft — review this'));
        dr.appendChild(mkBtn('ck-btn ck-btn-mini', 'Looks right', 'Mark as reviewed: ' + item.text, function () {
          updateItem(cpId, item.id, { draft: false });
        }));
        body.appendChild(dr);
      }
    }

    row.appendChild(body);
    li.appendChild(row);

    if (editMode && !(editing && editing.cpId === cpId && editing.id === item.id)) {
      var tools = h('div', 'ck-tools');
      tools.appendChild(mkBtn('ck-tool', '▲', 'Move up', function () {
        moveItem(cpId, item.id, -1);
      }, index === 0));
      tools.appendChild(mkBtn('ck-tool', '▼', 'Move down', function () {
        moveItem(cpId, item.id, 1);
      }, index === count - 1));
      tools.appendChild(mkBtn('ck-tool ck-tool-crit' + (item.critical ? ' is-on' : ''), '!',
        item.critical ? 'Unmark critical' : 'Mark critical', function () {
          updateItem(cpId, item.id, { critical: !item.critical });
        }));
      tools.appendChild(mkBtn('ck-tool ck-tool-wide', 'Rename', 'Rename item', function () {
        startEdit(cpId, phase, item.id, false);
      }));
      tools.appendChild(mkBtn('ck-tool ck-tool-wide ck-tool-del', 'Delete', 'Delete item', function () {
        confirming = { kind: 'item', cpId: cpId, id: item.id };
        renderAll();
      }));
      li.appendChild(tools);
    }

    /* Read mode: the whole row is one big tap target. No hover needed anywhere. */
    li.addEventListener('click', function (ev) {
      if (editMode) return;
      if (editing) return;
      var t = ev.target;
      if (t && t.closest && t.closest('button')) return;
      toggleTick(item.id);
    });

    return li;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * checklist for one checkpoint (drawer)
   * ═══════════════════════════════════════════════════════════════════════ */
  function buildEmpty(cpId) {
    var m = meta(cpId);
    var root = h('div', 'ck ck-empty');
    root.appendChild(h('div', 'ck-title', 'Crew checklist'));
    root.appendChild(h('p', 'ck-hint', m.supporter
      ? 'No checklist for this checkpoint yet.'
      : 'Crew cannot officially access this checkpoint — but you can still keep a list here.'));
    root.appendChild(mkBtn('ck-btn ck-btn-primary ck-btn-block', '+ Start a checklist',
      'Start a checklist for this checkpoint', function () {
        ensureOverride(cpId);
        editMode = true;
        afterContentChange('checklist:create', cpId);
      }));
    return root;
  }

  function buildChecklist(cpId) {
    var phases = effective(cpId);
    if (!phases) return buildEmpty(cpId);

    var root = h('div', 'ck');
    var pr = progressOf(cpId);
    var pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;

    /* ── header: title, progress, edit toggle ── */
    var head = h('div', 'ck-head');
    var headRow = h('div', 'ck-head-row');
    var titles = h('div', 'ck-head-titles');
    titles.appendChild(h('div', 'ck-title', 'Crew checklist'));
    titles.appendChild(h('div', 'ck-count' + (pr.total && pr.done === pr.total ? ' is-all' : ''),
      pr.done + '/' + pr.total + ' done'));
    headRow.appendChild(titles);
    headRow.appendChild(mkBtn('ck-mode-btn' + (editMode ? ' is-on' : ''),
      editMode ? 'Done editing' : 'Edit list',
      editMode ? 'Leave edit mode' : 'Edit this checklist',
      function () {
        editMode = !editMode;
        editing = null;
        confirming = null;
        renderAll();
      }));
    head.appendChild(headRow);

    var bar = h('div', 'ck-bar');
    var fill = h('i', pr.total && pr.done === pr.total ? 'is-all' : null);
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    head.appendChild(bar);

    if (pr.criticalOpen > 0) {
      head.appendChild(h('div', 'ck-crit-note',
        pr.criticalOpen === 1 ? '1 critical item still open' : pr.criticalOpen + ' critical items still open'));
    }
    if (pr.drafts > 0) {
      head.appendChild(h('div', 'ck-draft-note',
        (pr.drafts === 1 ? '1 item was' : pr.drafts + ' items were') +
        ' generated, not written by you — read each one and confirm it.'));
    }
    root.appendChild(head);

    /* ── phases ── */
    phaseOrder.forEach(function (phase) {
      /* Live only: a tombstone holds its slot in the stored array so the merge
       * stays stable, but it must never reach the screen. */
      var list = liveIn(phases, phase);
      var sec = h('section', 'ck-phase');
      sec.setAttribute('data-phase', phase);

      var ph = h('div', 'ck-phase-head');
      var phTitles = h('div', 'ck-phase-titles');
      phTitles.appendChild(h('h3', 'ck-phase-title', labelFor(phase)));
      var tr = labelTr(phase);
      if (tr) phTitles.appendChild(h('div', 'ck-phase-tr', tr));
      ph.appendChild(phTitles);
      var pp = phaseProgress(cpId, phase);
      ph.appendChild(h('span', 'ck-phase-count', pp.done + '/' + pp.total));
      sec.appendChild(ph);

      if (!list.length) {
        sec.appendChild(h('p', 'ck-phase-empty', 'Nothing here yet.'));
      } else {
        var ul = h('ul', 'ck-items');
        list.forEach(function (item, i) {
          ul.appendChild(buildItem(cpId, phase, item, i, list.length));
        });
        sec.appendChild(ul);
      }

      if (editMode) {
        sec.appendChild(mkBtn('ck-add', '+ Add item', 'Add an item to ' + labelFor(phase), function () {
          var newId = addItem(cpId, phase, '', { silent: true });
          persistContent();
          UTMB.store.markDirty();
          startEdit(cpId, phase, newId, true);
          notify('item:add', cpId);
        }));
      }
      root.appendChild(sec);
    });

    /* ── footer: reset ticks (never deletes items) ── */
    var foot = h('div', 'ck-foot');
    if (confirming && confirming.kind === 'reset' && confirming.cpId === cpId) {
      var rc = h('div', 'ck-confirm');
      rc.appendChild(h('div', 'ck-confirm-q', 'Clear all ticks here?'));
      rc.appendChild(h('div', 'ck-confirm-txt',
        'Unticks all ' + pr.total + ' items at this checkpoint. The items themselves are kept.'));
      var rcb = h('div', 'ck-confirm-btns');
      rcb.appendChild(mkBtn('ck-btn ck-btn-danger', 'Clear ticks', 'Confirm clearing ticks', function () {
        confirming = null;
        var n = resetTicks(cpId);
        toast(n ? 'Cleared ' + n + ' tick' + (n === 1 ? '' : 's') : 'Nothing was ticked');
      }));
      rcb.appendChild(mkBtn('ck-btn ck-btn-ghost', 'Cancel', 'Cancel clearing ticks', function () {
        confirming = null;
        renderAll();
      }));
      rc.appendChild(rcb);
      foot.appendChild(rc);
    } else {
      foot.appendChild(mkBtn('ck-btn ck-btn-ghost ck-btn-block', 'Reset ticks',
        'Reset ticks for this checkpoint', function () {
          confirming = { kind: 'reset', cpId: cpId, id: null };
          renderAll();
        }, pr.total === 0));
      foot.appendChild(h('p', 'ck-hint',
        'Ticks are shared with the whole crew — everyone sees this list. Items are never deleted by a reset.'));
    }
    root.appendChild(foot);

    return root;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * rendering
   * ═══════════════════════════════════════════════════════════════════════ */
  function activeCpId() {
    return (UTMB.drawer && typeof UTMB.drawer.activeCp === 'function') ? UTMB.drawer.activeCp() : null;
  }

  function renderDrawer() {
    var mount = document.getElementById('drawerChecklistMount');
    if (!mount) return;
    var cpId = activeCpId();
    if (!booted || !cpId) { mount.textContent = ''; return; }

    var scroller = mount.closest ? mount.closest('.drawer-body') : null;
    var keep = scroller ? scroller.scrollTop : 0;

    pendingFocus = null;
    mount.textContent = '';
    mount.appendChild(buildChecklist(cpId));

    if (scroller) scroller.scrollTop = keep;

    if (pendingFocus) {
      var node = pendingFocus;
      pendingFocus = null;
      try {
        node.focus();
        var end = node.value.length;
        node.setSelectionRange(end, end);
      } catch (err) { /* focus can be refused; the editor still works by tapping */ }
      keepVisible(node.parentNode || node);
    }
  }

  function renderOverview() {
    var mount = document.getElementById('checklistMount');
    if (!mount) return;
    if (!booted) { mount.textContent = ''; return; }

    var ids = checkpointIds();
    if (!ids.length) { mount.textContent = ''; return; }

    var wrap = h('div', 'ck-overview');
    var headWrap = h('div', 'ck-ov-head');
    headWrap.appendChild(h('div', 'ck-ov-title', 'Crew checklists'));
    var totals = { done: 0, total: 0 };
    ids.forEach(function (id) {
      var p = progressOf(id);
      totals.done += p.done;
      totals.total += p.total;
    });
    headWrap.appendChild(h('div', 'ck-ov-sum', totals.done + '/' + totals.total + ' done overall'));
    wrap.appendChild(headWrap);

    var grid = h('div', 'ck-ov-grid');
    ids.forEach(function (cpId) {
      var m = meta(cpId);
      var pr = progressOf(cpId);
      var pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
      var card = mkBtn('ck-ov-card' + (pr.total && pr.done === pr.total ? ' is-all' : ''), null,
        'Open the checklist for ' + m.name, function () {
          if (UTMB.drawer && typeof UTMB.drawer.open === 'function') UTMB.drawer.open(cpId);
        });

      var top = h('div', 'ck-ov-top');
      top.appendChild(h('span', 'ck-ov-cp', cpId));
      top.appendChild(h('span', 'ck-ov-name', m.name));
      card.appendChild(top);

      var metaBits = [];
      if (typeof m.km === 'number') metaBits.push(m.km + ' km');
      /* 24-hour, matching the transport board directly below this one.
       * See UTMB.fmtCutoff in store.js. */
      if (m.cutoff) metaBits.push('cutoff ' + fmtCutoff(m.cutoff));
      card.appendChild(h('div', 'ck-ov-meta', metaBits.join(' · ')));

      card.appendChild(h('div', 'ck-ov-count', pr.done + '/' + pr.total + ' done'));

      var ovBar = h('div', 'ck-ov-bar');
      var ovFill = h('i', pr.total && pr.done === pr.total ? 'is-all' : null);
      ovFill.style.width = pct + '%';
      ovBar.appendChild(ovFill);
      card.appendChild(ovBar);

      if (pr.criticalOpen > 0) {
        card.appendChild(h('div', 'ck-ov-crit', pr.criticalOpen + ' critical open'));
      }
      grid.appendChild(card);
    });
    wrap.appendChild(grid);
    mount.textContent = '';
    mount.appendChild(wrap);
  }

  function renderAll() {
    renderDrawer();
    renderOverview();
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * wiring
   * ═══════════════════════════════════════════════════════════════════════ */
  UTMB.on('cp:open', function () {
    editing = null;
    confirming = null;
    unbindViewport();
    renderDrawer();
  });

  UTMB.on('cp:close', function () {
    editing = null;
    confirming = null;
    unbindViewport();
    var mount = document.getElementById('drawerChecklistMount');
    if (mount) mount.textContent = '';
  });

  /* sync.js merged a remote change into the store and told us about it. Repaint
   * from the store, silently — the crew is not prompted mid-race. The one thing
   * we protect is a half-typed edit: if someone is in the middle of renaming an
   * item, the repaint waits until they are done rather than eating their words.
   * (The share-link path still shows its diff-and-review sheet; that is a
   * deliberate, user-initiated import, not this.) */
  var remoteRetry = null;

  function applyRemote() {
    if (!booted) return;
    if (editing) {
      /* Still typing. Come back for it — do not drop the update. */
      if (!remoteRetry) {
        remoteRetry = setInterval(function () {
          if (editing) return;
          clearInterval(remoteRetry);
          remoteRetry = null;
          reload();
        }, 1500);
      }
      return;
    }
    if (remoteRetry) { clearInterval(remoteRetry); remoteRetry = null; }
    reload();
  }

  window.addEventListener('utmb:remote-update', applyRemote);

  /* Bring the module up from a bootstrap context. main.js calls this FIRST of
   * all the feature modules, because share.js diffs an incoming link against
   * whatever this module holds — if it runs before the seed is in, every item
   * in the link looks new. Idempotent: calling it again only adopts a context
   * that is richer than the one already in hand.
   *
   * Also registered on UTMB.ready() below, so the module still comes up on its
   * own if it is ever loaded into a page whose bootstrap does not know it. */
  function initFromContext(ctx) {
    ctx = ctx || {};

    if (booted) {
      /* Already up. A later context can still supply the course (checkpoint
       * names, km, ordering) if the first one did not. */
      if (ctx.course && !course) {
        course = ctx.course;
        seedCache = Object.create(null);
        renderAll();
      }
      return UTMB.checklist;
    }

    course = ctx.course || null;

    var cl = ctx.checklists;
    if (isObj(cl)) {
      if (Array.isArray(cl.phaseOrder) && cl.phaseOrder.length) {
        var order = cl.phaseOrder.filter(function (p) { return typeof p === 'string' && p; });
        if (order.length) phaseOrder = order;
      }
      if (isObj(cl.phaseLabels)) {
        var labels = {};
        phaseOrder.forEach(function (p) {
          var raw = isObj(cl.phaseLabels[p]) ? cl.phaseLabels[p] : {};
          var fb = FALLBACK_LABELS[p] || {};
          labels[p] = { en: txt(raw.en) || fb.en || p, tr: txt(raw.tr) || fb.tr || '' };
        });
        phaseLabels = labels;
      }
      seed = {
        version: txt(cl.version) || '1.0.0',
        updated: txt(cl.updated) || '',
        checkpoints: isObj(cl.checkpoints) ? cl.checkpoints : {},
        crew: Array.isArray(cl.crewCheckpoints) ? cl.crewCheckpoints.slice() : []
      };
    } else {
      console.warn('[UTMB] checklists.json unavailable — checklists start empty and edits still persist');
    }

    loadPersisted();
    booted = true;
    renderAll();
    UTMB.emit('checklist:ready', { content: getContent(), ticks: getTicks() });
    return UTMB.checklist;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * public surface
   * ═══════════════════════════════════════════════════════════════════════ */
  UTMB.checklist = {
    /* --- lifecycle --- */
    init: initFromContext,
    /* True once checklists.json (or its absence) has been folded in and the
     * stored edits are loaded. share.js gates the receive path on this. */
    isReady: function () { return booted; },

    /* --- what share.js consumes --- */
    /* exportContent() is FIRST in share.js's READ_ALIASES, so the share-link
     * path gets the tombstone-free view without knowing this file changed. */
    exportContent: exportContent,
    getContent: getContent,
    setContent: setContent,
    getTicks: getTicks,
    setTicks: setTicks,
    onChange: onChange,

    /* --- per-checkpoint reads --- */
    checkpointIds: checkpointIds,
    getCheckpoint: getCheckpoint,
    setCheckpoint: setCheckpoint,
    items: function (cpId) { return itemsOf(cpId).map(cloneItem); },
    progress: progressOf,
    phaseOrder: function () { return phaseOrder.slice(); },
    phaseLabels: function () {
      var out = {};
      phaseOrder.forEach(function (p) { out[p] = { en: labelFor(p), tr: labelTr(p) }; });
      return out;
    },

    /* --- ticks (SHARED with the crew; a tick stamps the item) --- */
    isTicked: function (itemId) { return isDone(itemId); },
    setTick: setTick,
    toggleTick: toggleTick,
    resetTicks: resetTicks,

    /* --- shared-state sync --- */
    reload: reload,

    /* --- content edits --- */
    addItem: addItem,
    updateItem: updateItem,
    removeItem: function (cpId, itemId) { return removeItem(cpId, itemId); },
    moveItem: moveItem,

    /* --- ui --- */
    isEditMode: function () { return editMode; },
    setEditMode: function (on) { editMode = !!on; editing = null; confirming = null; renderAll(); return editMode; },
    render: renderAll,

    STORAGE: { content: 'utmb_checklist', ticks: 'utmb_checklist_ticks' }
  };

  /* Registered after the public surface exists so initFromContext() can return
   * it even if a context is already on hand when this file parses. */
  UTMB.ready(initFromContext);
})(window.UTMB);
