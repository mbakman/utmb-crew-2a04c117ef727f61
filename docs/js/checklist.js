/* checklist.js — per-checkpoint CREW CHECKLIST.
 *
 * Renders the crew checklist for the open checkpoint into #drawerChecklistMount,
 * plus an at-a-glance progress board into #checklistMount. Item text is Turkish
 * and is rendered VERBATIM — this module never translates, normalises or
 * "corrects" it. Everything is written with textContent, never innerHTML, so a
 * quote or an angle bracket in a crew note can never break the page.
 *
 * TWO SEPARATE STATES — this distinction is the whole design:
 *
 *   CONTENT (shared)      the items themselves: id, text, critical, draft, and
 *                         their order inside a phase. Editable. Exportable.
 *                         localStorage key  utmb_checklist
 *                         shape { version, baseVersion, savedAt,
 *                                 checkpoints: { <cpId>: { before:[], onArrival:[], beforeLeaving:[] } } }
 *                         Only checkpoints the user has actually edited are
 *                         stored; untouched ones fall through to checklists.json,
 *                         so a later content update still reaches them.
 *
 *   TICKS (per-device)    which items are done, keyed by ITEM ID, flat.
 *                         localStorage key  utmb_checklist_ticks
 *                         shape { "<itemId>": true }
 *                         NOT part of shared content. Never exported as content,
 *                         never merged into it, and cleared independently by the
 *                         per-checkpoint "Reset ticks" action (which never
 *                         deletes an item).
 *
 * Public API — window.UTMB.checklist
 * ----------------------------------
 * The five share.js depends on:
 *
 *   getContent()          -> {version, updated, phaseOrder:[...], phaseLabels:{p:{en,tr}},
 *                             checkpoints: { <cpId>: {
 *                               name, km, cutoff, support, edited,
 *                               before:[item], onArrival:[item], beforeLeaving:[item] } }}
 *                            item = {id, text, critical, draft}. Deep clone: mutating the
 *                            result changes nothing. Contains no tick state at all.
 *   setContent(obj)       accepts the getContent() shape OR a bare {cpId:{phases}} map;
 *                         replaces the edit overlay wholesale and returns getContent().
 *                         setContent(null) drops every edit back to checklists.json.
 *                         Ignores unknown keys, drops malformed items, never throws.
 *                         Leaves ticks alone.
 *   getTicks()            -> {itemId: true}, clone, per-device only.
 *   setTicks(obj)         replaces the tick map (truthy values only). Returns getTicks().
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
 * removeItem(cpId,id), moveItem(cpId,id,delta), isEditMode(), setEditMode(on),
 * render(), STORAGE.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * constants + module state
   * ═══════════════════════════════════════════════════════════════════════ */
  var SLOT_CONTENT = 'checklist';         /* -> localStorage "utmb_checklist"       */
  var SLOT_TICKS = 'checklist_ticks';     /* -> localStorage "utmb_checklist_ticks" */

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
  var ticks = Object.create(null);        /* itemId -> true                          */

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
  function normalizeItem(raw, cpId, phase, seen) {
    var text = '', id = '', critical = false, draft = false;
    if (typeof raw === 'string') {
      text = raw;
    } else if (isObj(raw)) {
      text = txt(raw.text);
      id = trim(raw.id);
      critical = !!raw.critical;
      draft = !!raw.draft;
    } else {
      return null;
    }
    text = text.replace(/\s+$/, '');
    if (!text) return null;
    if (!id || seen[id]) id = mintId(cpId, phase);
    seen[id] = true;
    return { id: id, text: text, critical: critical, draft: draft };
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

  function clonePhases(phases) {
    var out = {};
    phaseOrder.forEach(function (phase) {
      out[phase] = (phases[phase] || []).map(function (it) {
        return { id: it.id, text: it.text, critical: !!it.critical, draft: !!it.draft };
      });
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

  function itemsOf(cpId) {
    var phases = effective(cpId);
    if (!phases) return [];
    var out = [];
    phaseOrder.forEach(function (p) { out = out.concat(phases[p] || []); });
    return out;
  }

  function findItem(cpId, itemId) {
    var phases = effective(cpId);
    if (!phases) return null;
    for (var i = 0; i < phaseOrder.length; i++) {
      var phase = phaseOrder[i];
      var list = phases[phase] || [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].id === itemId) return { phase: phase, index: j, item: list[j] };
      }
    }
    return null;
  }

  function progressOf(cpId) {
    var all = itemsOf(cpId);
    var done = 0, critOpen = 0, drafts = 0;
    all.forEach(function (it) {
      if (ticks[it.id]) done += 1;
      else if (it.critical) critOpen += 1;
      if (it.draft) drafts += 1;
    });
    return { done: done, total: all.length, criticalOpen: critOpen, drafts: drafts };
  }

  function phaseProgress(cpId, phase) {
    var phases = effective(cpId);
    var list = (phases && phases[phase]) || [];
    var done = 0;
    list.forEach(function (it) { if (ticks[it.id]) done += 1; });
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

  function persistTicks() {
    UTMB.store.set(SLOT_TICKS, ticks);
  }

  function loadPersisted() {
    var rawContent = UTMB.store.get(SLOT_CONTENT, null);
    if (isObj(rawContent)) {
      var src = isObj(rawContent.checkpoints) ? rawContent.checkpoints : rawContent;
      Object.keys(src).forEach(function (cpId) {
        if (isObj(src[cpId])) overrides[cpId] = normalizePhases(cpId, src[cpId]);
      });
    }
    var rawTicks = UTMB.store.get(SLOT_TICKS, null);
    if (isObj(rawTicks)) {
      Object.keys(rawTicks).forEach(function (id) { if (rawTicks[id]) ticks[id] = true; });
    }
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

  /* Content changed: write it, flag the header Save button, repaint, announce. */
  function afterContentChange(reason, cpId) {
    persistContent();
    UTMB.store.markDirty();
    renderAll();
    notify(reason, cpId);
  }

  /* Ticks changed: per-device only, so no markDirty — nothing to "commit". */
  function afterTickChange(reason, cpId) {
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
      draft: !!opts.draft
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
    afterContentChange('item:update', cpId);
    return true;
  }

  function removeItem(cpId, itemId, opts) {
    if (!findItem(cpId, itemId)) return false;
    ensureOverride(cpId);
    var hit = findItem(cpId, itemId);
    if (!hit) return false;
    overrides[cpId][hit.phase].splice(hit.index, 1);
    /* Drop the orphaned tick too — ids are never reused, so it could not come
     * back to haunt a future item. Ticks are per-device, so this is a silent
     * local write, not a content change. */
    if (ticks[itemId]) { delete ticks[itemId]; persistTicks(); }
    if (!opts || opts.silent !== true) afterContentChange('item:remove', cpId);
    return true;
  }

  function moveItem(cpId, itemId, delta) {
    var hit = findItem(cpId, itemId);
    if (!hit) return false;
    ensureOverride(cpId);
    hit = findItem(cpId, itemId);
    var list = overrides[cpId][hit.phase];
    var next = hit.index + delta;
    if (next < 0 || next >= list.length) return false;
    var moved = list.splice(hit.index, 1)[0];
    list.splice(next, 0, moved);
    afterContentChange('item:move', cpId);
    return true;
  }

  function setTick(itemId, on) {
    if (!itemId) return;
    if (on) ticks[itemId] = true;
    else delete ticks[itemId];
    afterTickChange('tick', null);
  }

  function toggleTick(itemId) { setTick(itemId, !ticks[itemId]); }

  function resetTicks(cpId) {
    var cleared = 0;
    itemsOf(cpId).forEach(function (it) {
      if (ticks[it.id]) { delete ticks[it.id]; cleared += 1; }
    });
    afterTickChange('ticks:reset', cpId);
    return cleared;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * public API surface
   * ═══════════════════════════════════════════════════════════════════════ */
  function getContent() {
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
      var entry = clonePhases(phases);
      entry.name = m.name;
      entry.km = m.km;
      entry.cutoff = m.cutoff;
      entry.support = m.support;
      entry.edited = !!overrides[cpId];
      out.checkpoints[cpId] = entry;
    });
    return out;
  }

  /* Accepts either the full getContent() shape or a bare {cpId: {phases}} map.
   * Replaces the edit overlay wholesale. setContent(null) drops every edit and
   * falls back to checklists.json. Ticks are untouched — they are not content. */
  function setContent(next) {
    var src = null;
    if (isObj(next)) src = isObj(next.checkpoints) ? next.checkpoints : next;
    var fresh = Object.create(null);
    if (src) {
      Object.keys(src).forEach(function (cpId) {
        if (isObj(src[cpId])) fresh[cpId] = normalizePhases(cpId, src[cpId]);
      });
    }
    overrides = fresh;
    editing = null;
    confirming = null;
    afterContentChange('content:set', null);
    return getContent();
  }

  function getTicks() {
    var out = {};
    Object.keys(ticks).forEach(function (id) { if (ticks[id]) out[id] = true; });
    return out;
  }

  function setTicks(next) {
    var fresh = Object.create(null);
    if (isObj(next)) {
      Object.keys(next).forEach(function (id) { if (next[id]) fresh[id] = true; });
    }
    ticks = fresh;
    afterTickChange('ticks:set', null);
    return getTicks();
  }

  /* One checkpoint's content, cloned. null when it has no checklist. */
  function getCheckpoint(cpId) {
    var phases = effective(cpId);
    return phases ? clonePhases(phases) : null;
  }

  /* Replace one checkpoint's content. setCheckpoint(cpId, null) drops the edit
   * overlay for it, so it falls back to checklists.json. */
  function setCheckpoint(cpId, phases) {
    if (!cpId) return null;
    if (phases === null) {
      delete overrides[cpId];
    } else if (isObj(phases)) {
      var src = isObj(phases.checkpoints) ? phases.checkpoints[cpId] : phases;
      if (!isObj(src)) return null;
      overrides[cpId] = normalizePhases(cpId, src);
    } else {
      return null;
    }
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
    var done = !!ticks[item.id];
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
      var list = phases[phase] || [];
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
        'Ticks are saved on this device only and are never shared. Items are never deleted by a reset.'));
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
    getContent: getContent,
    setContent: setContent,
    getTicks: getTicks,
    setTicks: setTicks,
    onChange: onChange,

    /* --- per-checkpoint reads --- */
    checkpointIds: checkpointIds,
    getCheckpoint: getCheckpoint,
    setCheckpoint: setCheckpoint,
    items: function (cpId) { return itemsOf(cpId).map(function (i) { return { id: i.id, text: i.text, critical: i.critical, draft: i.draft }; }); },
    progress: progressOf,
    phaseOrder: function () { return phaseOrder.slice(); },
    phaseLabels: function () {
      var out = {};
      phaseOrder.forEach(function (p) { out[p] = { en: labelFor(p), tr: labelTr(p) }; });
      return out;
    },

    /* --- ticks (per device) --- */
    isTicked: function (itemId) { return !!ticks[itemId]; },
    setTick: setTick,
    toggleTick: toggleTick,
    resetTicks: resetTicks,

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
