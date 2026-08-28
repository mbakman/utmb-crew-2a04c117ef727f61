/* sync.js — live crew sync for the shared checklist.
 *
 * Frictionless by design: nobody taps anything. Open the page and it starts
 * polling; tick a box and everyone else has it inside ~15 seconds. There is no
 * prompt, no review sheet and no "push/pull" button anywhere in this file. The
 * share-link review UI in share.js stays exactly as it is — that is the manual
 * fallback for when there is no signal at all.
 *
 * TRANSPORT
 *   GET  api/checklist.php -> {version, data, updatedAt}
 *   POST api/checklist.php  {token, baseVersion, data} -> 200 / 400 / 403 / 409
 *   Paths are relative on purpose: the site lives in an unguessable
 *   subdirectory and must keep working wherever it is dropped.
 *
 * STATE SHAPE (the "data" object, produced by UTMB.store.getSharedState())
 *   { v:1,
 *     meta:  { bib:"", bibModified:0 },
 *     items: { "<itemId>": { cp, phase, order, text, critical, draft,
 *                            done, lastModified } } }
 *   Flat by item id, because that is the granularity the merge works at.
 *   "done" is in there: tick state is SHARED now, not per device.
 *
 * MERGE RULE (silent, never prompts)
 *   Union of both item sets. An item on one side only is kept as is. An item on
 *   both sides is taken WHOLE from whichever side has the newer lastModified —
 *   no field-level interleaving, so an item can never end up half from one
 *   phone and half from another. Nothing is ever dropped by an automatic merge.
 *
 *   Consequence, deliberate and documented: deleting an item does not
 *   propagate. Another device still holding it re-seeds it on the next poll.
 *   On race day a resurrected line is a nuisance; a silently vanished one is a
 *   missed bottle swap. Use the share-link flow for a real content purge.
 *
 *   Equal timestamps resolve to the SERVER copy. That is what makes the crew
 *   converge in one round instead of two phones ping-ponging their own copies
 *   at each other every 15 seconds forever. Timestamps only tie for items that
 *   have never been edited since sync came online, where both sides are
 *   identical anyway.
 *
 * FAILURE POSTURE
 *   Every network path is wrapped. A dead endpoint, a 500, a captive portal, a
 *   404 because api/ was never uploaded — all of it degrades to "the app is
 *   exactly what it was before this file existed", plus a small banner. This
 *   file never throws into the app and never blocks a render.
 *
 *   Two failures are NOT self-healing, and both get a persistent amber banner
 *   rather than a console warning nobody reads on a phone. Silence in either
 *   would mean a crew member ticking boxes all night that no one else ever
 *   sees:
 *
 *     1. A rejected token (403 x3). Sending stops; reading carries on.
 *     2. A write the server will not perform (500/503 x3, a 404 because api/
 *        was never uploaded, a 200 whose body a PHP notice made unparseable,
 *        or a single deterministic 400). The likeliest cause on a first deploy
 *        is api/ not being writable by PHP, so the very first POST cannot
 *        create api/checklist-live.json. GET keeps answering 200 the whole
 *        time, so nothing else about the phone looks wrong. Sending keeps
 *        retrying here — unlike a rotated token, this one can heal on its own,
 *        and the banner clears the moment a write is accepted.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
   * config
   * ═══════════════════════════════════════════════════════════════════════ */
  var ENDPOINT = 'api/checklist.php';
  var TOKEN = 'crewsync-17fa94ab349f';

  var POLL_MS = 15000;          /* foreground poll cadence                   */
  var PUSH_DEBOUNCE_MS = 2000;  /* quiet period after a local edit           */
  var MAX_PUSH_ATTEMPTS = 3;    /* 409 -> merge -> repost, this many times   */
  var FORBIDDEN_LIMIT = 3;      /* consecutive 403s before sending stops      */
  var WRITE_FAIL_LIMIT = 3;     /* consecutive unusable POST replies before   */
                                /* we tell the crew the server is not saving  */
  var REQUEST_TIMEOUT_MS = 12000;
  var MAX_BODY_BYTES = 262144;  /* mirrors the server's limit                */
  var BOOT_POLL_MS = 500;       /* how often to check whether the app is up  */
  var BOOT_GIVEUP = 240;        /* ...for two minutes, then stop looking     */

  var VERSION_KEY = 'utmb_sync_version';

  /* Field separators for the fingerprint below. Control characters, so they
   * cannot collide with anything a crew member could type into an item. */
  var SEP_FIELD = String.fromCharCode(1);
  var SEP_ITEM = String.fromCharCode(2);

  /* ═══════════════════════════════════════════════════════════════════════
   * module state
   * ═══════════════════════════════════════════════════════════════════════ */
  var started = false;
  var inFlight = false;         /* one request at a time, always             */
  var needPush = false;         /* local edits not yet accepted by the server*/
  var pushTimer = null;
  var pollTimer = null;
  var forbiddenHits = 0;        /* consecutive 403s                          */
  var pushDisabled = false;     /* set after repeated 403s; GET keeps working*/
  var writeFailHits = 0;        /* consecutive POST replies we cannot use    */
  var writeStuck = false;       /* the server is reachable but not saving    */
  var lastPushedCanon = null;
  var lastPushedVersion = -1;
  var bannerEl = null;
  var bannerMsg = null;         /* current banner text, or null when hidden   */
  var bannerWarn = false;       /* true = the amber "not sending" variant     */

  var MSG_OFFLINE = 'Offline — changes will sync';
  var MSG_BLOCKED = 'Not syncing — this phone was rejected. Ticks stay here.';
  var MSG_STUCK = 'Not syncing — the server is not saving. Ticks stay here.';

  /* ═══════════════════════════════════════════════════════════════════════
   * tiny helpers
   * ═══════════════════════════════════════════════════════════════════════ */
  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (typeof n === 'number' && n === n && isFinite(n)) ? n : 0;
  }

  function str(v) {
    return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v));
  }

  function isObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function warn(msg, err) {
    try {
      console.warn('[UTMB sync] ' + msg, err === undefined ? '' : err);
    } catch (e) { /* no console */ }
  }

  function store() {
    var U = window.UTMB;
    return (U && U.store && typeof U.store.getSharedState === 'function') ? U.store : null;
  }

  /* The app is usable before this is true; sync just waits quietly. */
  function appReady() {
    var U = window.UTMB;
    if (!U || !store()) return false;
    if (!U.checklist || typeof U.checklist.isReady !== 'function') return false;
    return !!U.checklist.isReady();
  }

  function readVersion() {
    try {
      var raw = window.localStorage.getItem(VERSION_KEY);
      if (raw === null || raw === undefined) return 0;
      var n = parseInt(raw, 10);
      return (n === n && n >= 0) ? n : 0;
    } catch (err) {
      return 0;
    }
  }

  function writeVersion(n) {
    try {
      window.localStorage.setItem(VERSION_KEY, String(num(n)));
    } catch (err) { /* private mode / quota — sync still works this session */ }
  }

  function canSync() {
    if (typeof window.fetch !== 'function') return false;
    if (navigator && navigator.onLine === false) return false;
    return true;
  }

  function visible() {
    return typeof document === 'undefined' ||
      document.visibilityState === undefined ||
      document.visibilityState === 'visible';
  }

  function dispatch(name, detail) {
    var ev = null;
    try {
      ev = new CustomEvent(name, { detail: detail || null });
    } catch (err) {
      try {
        ev = document.createEvent('CustomEvent');
        ev.initCustomEvent(name, false, false, detail || null);
      } catch (err2) {
        return;
      }
    }
    try {
      window.dispatchEvent(ev);
    } catch (err3) { /* nothing to do */ }
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * offline banner — this file owns no stylesheet, so it brings its own
   * ═══════════════════════════════════════════════════════════════════════ */
  var CSS =
    '.utmb-sync-banner{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);' +
    'z-index:9990;max-width:calc(100vw - 28px);box-sizing:border-box;' +
    'padding:7px 15px;border-radius:999px;' +
    'background:rgba(24,24,27,.94);color:#e5e7eb;' +
    'border:1px solid rgba(148,163,184,.35);box-shadow:0 6px 22px rgba(0,0,0,.45);' +
    'font:500 13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;' +
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
    'pointer-events:none;opacity:0;visibility:hidden;transition:opacity .18s ease}' +
    '.utmb-sync-banner.is-on{opacity:1;visibility:visible}' +
    /* "not sending" is a different kind of bad from "offline": offline fixes
     * itself when the signal comes back, this one never does without someone
     * doing something about it. Amber, so it does not read as transient. */
    '.utmb-sync-banner.is-warn{background:rgba(69,26,3,.96);color:#fed7aa;' +
    'border-color:rgba(251,146,60,.55);white-space:normal}' +
    '@supports (padding: max(0px)) {.utmb-sync-banner{bottom:max(14px,env(safe-area-inset-bottom))}}' +
    '@media (prefers-reduced-motion: reduce) {.utmb-sync-banner{transition:none}}';

  function ensureBanner() {
    if (bannerEl) return bannerEl;
    if (typeof document === 'undefined' || !document.body) return null;
    try {
      var style = document.createElement('style');
      style.setAttribute('data-utmb', 'sync');
      style.appendChild(document.createTextNode(CSS));
      (document.head || document.documentElement).appendChild(style);

      bannerEl = document.createElement('div');
      bannerEl.className = 'utmb-sync-banner';
      bannerEl.setAttribute('role', 'status');
      bannerEl.setAttribute('aria-live', 'polite');
      bannerEl.textContent = MSG_OFFLINE;
      document.body.appendChild(bannerEl);
    } catch (err) {
      bannerEl = null;
    }
    return bannerEl;
  }

  /* setBanner(null) hides it; setBanner('text', true) shows the amber variant.
   * The message matters: this used to be a bare boolean, so the only state it
   * could express was "offline", and a phone whose pushes were being refused
   * looked completely healthy while none of its ticks reached anyone. */
  function setBanner(msg, warn) {
    var next = msg || null;
    var nextWarn = !!warn;
    if (next === bannerMsg && nextWarn === bannerWarn) return;
    bannerMsg = next;
    bannerWarn = nextWarn;
    var el = ensureBanner();
    if (!el) return;
    if (bannerMsg) el.textContent = bannerMsg;
    el.className = 'utmb-sync-banner' + (bannerMsg ? ' is-on' : '') +
      (bannerMsg && bannerWarn ? ' is-warn' : '');
  }

  /* The banner the current state deserves, worst first.
   *
   * Both "not sending" states outrank `offline` on purpose. Offline says
   * "changes will sync", and once we have watched the server refuse three
   * writes in a row that sentence is a lie — a phone that loses signal for a
   * minute must not get a reassuring message back just because the amber one
   * was about the server rather than the radio. Neither of them can be reached
   * while offline anyway: they are only ever set by an actual HTTP reply. */
  function refreshBanner(offline) {
    if (pushDisabled) setBanner(MSG_BLOCKED, true);
    else if (writeStuck) setBanner(MSG_STUCK, true);
    else setBanner(offline ? MSG_OFFLINE : null, false);
  }

  /* A write landed. Whatever we thought was wrong with the server is over. */
  function clearWriteFailure() {
    writeFailHits = 0;
    writeStuck = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * state normalisation + merge
   * ═══════════════════════════════════════════════════════════════════════ */

  /* Coerce anything (a server payload, a localStorage blob, undefined) into the
   * canonical shape. Everything downstream can then stop defending itself. */
  function normState(s) {
    var out = { v: 1, meta: { bib: '', bibModified: 0 }, items: {} };
    if (!isObj(s)) return out;

    var m = isObj(s.meta) ? s.meta : {};
    out.meta.bib = str(m.bib);
    out.meta.bibModified = num(m.bibModified);

    var items = isObj(s.items) ? s.items : {};
    Object.keys(items).forEach(function (id) {
      var it = items[id];
      if (!isObj(it)) return;
      out.items[id] = {
        cp: str(it.cp),
        phase: str(it.phase),
        order: num(it.order),
        text: str(it.text),
        critical: !!it.critical,
        draft: !!it.draft,
        done: !!it.done,
        lastModified: num(it.lastModified)
      };
    });
    return out;
  }

  function sameItem(a, b) {
    return a.cp === b.cp && a.phase === b.phase && a.order === b.order &&
      a.text === b.text && a.critical === b.critical && a.draft === b.draft &&
      a.done === b.done && a.lastModified === b.lastModified;
  }

  /* Order-independent fingerprint. Object key order differs between a freshly
   * built local state and a JSON payload off the wire, so JSON.stringify is not
   * usable for equality here. */
  function canon(s) {
    var parts = ['bib' + SEP_FIELD + s.meta.bib + SEP_FIELD + s.meta.bibModified];
    Object.keys(s.items).sort().forEach(function (id) {
      var it = s.items[id];
      parts.push(
        id + SEP_FIELD + it.cp + SEP_FIELD + it.phase + SEP_FIELD + it.order +
        SEP_FIELD + it.text +
        SEP_FIELD + (it.critical ? 1 : 0) + (it.draft ? 1 : 0) + (it.done ? 1 : 0) +
        SEP_FIELD + it.lastModified
      );
    });
    return parts.join(SEP_ITEM);
  }

  function itemCount(s) {
    return Object.keys(s.items).length;
  }

  /* The merge. `theirs` is the server side — it wins ties, which is what makes
   * the crew converge instead of oscillating. */
  function merge(mine, theirs) {
    var a = normState(mine);
    var b = normState(theirs);
    var out = { v: 1, meta: null, items: {} };

    if (b.meta.bibModified > a.meta.bibModified) {
      out.meta = { bib: b.meta.bib, bibModified: b.meta.bibModified };
    } else if (a.meta.bibModified > b.meta.bibModified) {
      out.meta = { bib: a.meta.bib, bibModified: a.meta.bibModified };
    } else if (b.meta.bib !== '') {
      /* Tie: take the server's, unless the server has nothing and we do. An
       * empty bib must never overwrite a real one just because both are
       * unstamped. */
      out.meta = { bib: b.meta.bib, bibModified: b.meta.bibModified };
    } else {
      out.meta = { bib: a.meta.bib, bibModified: a.meta.bibModified };
    }

    var ids = Object.create(null);
    Object.keys(a.items).forEach(function (id) { ids[id] = true; });
    Object.keys(b.items).forEach(function (id) { ids[id] = true; });

    Object.keys(ids).forEach(function (id) {
      var mineIt = a.items[id];
      var theirsIt = b.items[id];
      if (!mineIt) { out.items[id] = theirsIt; return; }
      if (!theirsIt) { out.items[id] = mineIt; return; }
      if (theirsIt.lastModified > mineIt.lastModified) out.items[id] = theirsIt;
      else if (mineIt.lastModified > theirsIt.lastModified) out.items[id] = mineIt;
      else out.items[id] = sameItem(mineIt, theirsIt) ? mineIt : theirsIt;
    });

    var merged = canon(out);
    return {
      state: out,
      changedLocal: merged !== canon(a),
      changedRemote: merged !== canon(b)
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * local state bridge
   * ═══════════════════════════════════════════════════════════════════════ */
  function localState() {
    var st = store();
    if (!st) return null;
    try {
      return normState(st.getSharedState());
    } catch (err) {
      warn('could not read local state', err);
      return null;
    }
  }

  /* Write a merged state back into the app. store.applyMergedState() keeps the
   * incoming lastModified stamps as they are — re-stamping here would make
   * every merge look like a fresh local edit and the crew would never
   * converge. */
  function applyLocally(state, version) {
    var st = store();
    if (!st || typeof st.applyMergedState !== 'function') return false;
    var ok = false;
    try {
      ok = st.applyMergedState(state) !== false;
    } catch (err) {
      warn('could not apply merged state', err);
      return false;
    }
    if (!ok) return false;
    dispatch('utmb:remote-update', { version: num(version) });
    return true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * transport
   * ═══════════════════════════════════════════════════════════════════════ */
  function request(method, bodyObj) {
    var init = { method: method, cache: 'no-store', credentials: 'same-origin' };
    var ctrl = null;
    var timer = null;

    if (typeof window.AbortController === 'function') {
      try {
        ctrl = new window.AbortController();
        init.signal = ctrl.signal;
      } catch (err) { ctrl = null; }
    }

    if (bodyObj) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(bodyObj);
    }

    if (ctrl) {
      timer = setTimeout(function () {
        try { ctrl.abort(); } catch (err) { /* already settled */ }
      }, REQUEST_TIMEOUT_MS);
    }

    return window.fetch(ENDPOINT, init).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
        return { status: res.status, ok: res.ok, body: body };
      });
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function onNetworkOk() {
    refreshBanner(false);
  }

  function onNetworkFail(err) {
    refreshBanner(true);
    warn('endpoint unreachable; staying local', err);
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * pull
   * ═══════════════════════════════════════════════════════════════════════ */
  function pull() {
    if (inFlight || !started || !canSync() || !appReady()) return;
    inFlight = true;

    request('GET', null).then(function (res) {
      inFlight = false;

      if (!res.ok || !isObj(res.body)) {
        /* A reachable server answering something we cannot use (404 page, PHP
         * error, proxy interstitial) is not "offline" — it is misconfigured.
         * Say so in the console and leave the banner alone. */
        warn('unexpected GET response: HTTP ' + res.status);
        return;
      }

      onNetworkOk();

      var serverVersion = num(res.body.version);
      var serverData = isObj(res.body.data) ? res.body.data : null;
      var known = readVersion();

      /* Nothing stored yet: seed it from this device if we have anything. */
      if (serverVersion === 0 && serverData === null) {
        writeVersion(0);
        var mine = localState();
        if (mine && itemCount(mine) > 0) {
          needPush = true;
          schedulePush(0);
        }
        return;
      }

      if (serverVersion < known) {
        /* The live file was reset or restored from an older copy. Trust the
         * server's counter (it is the one the API compares against) and push
         * our copy back up so nothing is lost. */
        writeVersion(serverVersion);
        needPush = true;
        schedulePush(0);
        return;
      }

      if (serverVersion > known) {
        var local = localState();
        var m = merge(local, serverData);
        if (m.changedLocal) applyLocally(m.state, serverVersion);
        writeVersion(serverVersion);
        if (m.changedRemote) {
          needPush = true;
          schedulePush(0);
        }
        return;
      }

      /* Up to date. Flush anything that failed to post earlier. */
      if (needPush) schedulePush(0);
    })['catch'](function (err) {
      inFlight = false;
      onNetworkFail(err);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * push
   * ═══════════════════════════════════════════════════════════════════════ */
  function schedulePush(delay) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = null;
      push(0);
    }, typeof delay === 'number' ? delay : PUSH_DEBOUNCE_MS);
  }

  function push(attempt) {
    if (!started || pushDisabled || !appReady()) return;

    if (!canSync()) {
      refreshBanner(true);
      return;                       /* the next successful poll retries it */
    }

    if (inFlight) {
      schedulePush(1000);
      return;
    }

    var local = localState();
    if (!local) return;

    var base = readVersion();

    /* Never let a device that came up with an empty checklist (checklists.json
     * failed to load, storage was cleared) overwrite the crew's live state. */
    if (itemCount(local) === 0 && base > 0) {
      needPush = false;
      return;
    }

    var fingerprint = canon(local);
    if (fingerprint === lastPushedCanon && base === lastPushedVersion) {
      needPush = false;
      return;                       /* already up there, byte for byte */
    }

    var payload = { token: TOKEN, baseVersion: base, data: local };
    var encoded;
    try {
      encoded = JSON.stringify(payload);
    } catch (err) {
      warn('could not serialise local state', err);
      return;
    }

    /* Byte length, not string length — the checklist text is Turkish. */
    var bytes = encoded.length;
    try {
      bytes = new Blob([encoded]).size;
    } catch (err) { /* Blob-less browser: the length estimate will do */ }
    if (bytes > MAX_BODY_BYTES) {
      warn('local state is ' + bytes + ' bytes, over the ' + MAX_BODY_BYTES +
        ' byte limit; not pushing');
      needPush = false;
      return;
    }

    inFlight = true;
    request('POST', payload).then(function (res) {
      inFlight = false;

      if (res.status === 200 && isObj(res.body)) {
        /* Clear before the banner is recomputed, not after: onNetworkOk() is
         * what repaints it, and writeStuck outranks everything it knows. */
        forbiddenHits = 0;
        clearWriteFailure();
        onNetworkOk();
        writeVersion(num(res.body.version));
        lastPushedCanon = fingerprint;
        lastPushedVersion = readVersion();
        needPush = false;
        return;
      }

      if (res.status === 409 && isObj(res.body)) {
        /* Not a write we wanted, but proof the server read the live file and
         * is answering the contract, so it is not the stuck-write case. */
        forbiddenHits = 0;
        clearWriteFailure();
        onNetworkOk();
        var serverVersion = num(res.body.version);
        var serverData = isObj(res.body.data) ? res.body.data : null;
        var m = merge(localState(), serverData);
        if (m.changedLocal) applyLocally(m.state, serverVersion);
        writeVersion(serverVersion);

        if (!m.changedRemote) {          /* the server already has everything */
          needPush = false;
          return;
        }
        needPush = true;
        if (attempt + 1 < MAX_PUSH_ATTEMPTS) {
          push(attempt + 1);
        } else {
          warn('gave up after ' + MAX_PUSH_ATTEMPTS +
            ' conflicting pushes; retrying on the next poll');
        }
        return;
      }

      /* The server is up and refusing us — most likely the token was rotated
       * without this phone being reloaded. onNetworkOk() would clear the banner
       * and leave the phone looking perfectly healthy while nothing it ticks
       * ever reaches the crew, so pushDisabled has to be set BEFORE the banner
       * is recomputed, and it has to survive that recompute. */
      if (res.status === 403) {
        forbiddenHits += 1;
        if (forbiddenHits >= FORBIDDEN_LIMIT) {
          pushDisabled = true;
          warn('the server rejected our token three times; sending stopped. Reading still works.');
        } else {
          warn('token rejected by the server (403)');
        }
        onNetworkOk();
        return;
      }

      /* Deterministic refusal of this exact payload: the contract only returns
       * 400 for malformed JSON, a missing field or an over-size body, none of
       * which a retry changes, so we do not retry. That makes one 400 as final
       * as three 403s, and it gets the same visible treatment instead of one
       * console line. A later edit produces a different payload and can still
       * clear it. */
      if (res.status === 400) {
        needPush = false;
        writeFailHits = WRITE_FAIL_LIMIT;
        writeStuck = true;
        warn('the server rejected the payload (400); not retrying this one. ' +
          'Ticks are staying on this phone.');
        onNetworkOk();
        return;
      }

      /* Everything else is a write that did not happen: 500/503 from a host
       * that cannot create or replace api/checklist-live.json (api/ not
       * writable by PHP, disk quota, hardened perms), a 404 because api/ was
       * never uploaded, a 200 whose body a PHP notice made unparseable. GET
       * keeps answering 200 through all of it, so without this the phone looks
       * perfectly healthy while every tick stays on it.
       *
       * A 5xx really can be a momentary blip, so spend the same three
       * consecutive strikes on it that a 403 gets before saying anything.
       * Then keep retrying — needPush stays true and the next poll reschedules
       * the push — because unlike a rotated token this can come back on its
       * own, and clearWriteFailure() takes the banner down when it does. */
      needPush = true;
      writeFailHits += 1;
      if (writeFailHits >= WRITE_FAIL_LIMIT) {
        writeStuck = true;
        warn('the server has refused ' + writeFailHits + ' writes in a row ' +
          '(last: HTTP ' + res.status + '); ticks are staying on this phone. ' +
          'Still retrying.');
      } else {
        warn('unexpected POST response: HTTP ' + res.status);
      }
      onNetworkOk();
    })['catch'](function (err) {
      inFlight = false;
      needPush = true;
      onNetworkFail(err);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
   * wiring
   * ═══════════════════════════════════════════════════════════════════════ */
  function onLocalChange() {
    if (!started) return;
    needPush = true;
    schedulePush();
  }

  function tick() {
    if (!visible() || !canSync()) return;
    pull();
  }

  function start() {
    if (started) return;
    started = true;

    try {
      window.addEventListener('utmb:local-change', onLocalChange);

      window.addEventListener('online', function () {
        refreshBanner(false);
        pull();
        if (needPush) schedulePush(0);
      });

      window.addEventListener('offline', function () {
        if (needPush || pushDisabled) refreshBanner(true);
      });

      document.addEventListener('visibilitychange', function () {
        if (visible()) tick();
      });

      /* A phone coming out of a pocket often fires pageshow rather than
       * visibilitychange (bfcache restore). */
      window.addEventListener('pageshow', function () { tick(); });
    } catch (err) {
      warn('could not attach listeners', err);
    }

    pollTimer = setInterval(tick, POLL_MS);
    pull();
  }

  /* The app boots asynchronously (main.js fetches four JSON files first) and
   * this script may be parsed before or after that finishes. Wait for the
   * checklist to actually have its content — merging against an empty module
   * would look like "everything was deleted". */
  function boot() {
    if (appReady()) { start(); return; }
    var tries = 0;
    var probe = setInterval(function () {
      tries += 1;
      if (appReady()) {
        clearInterval(probe);
        start();
        return;
      }
      if (tries >= BOOT_GIVEUP) {
        clearInterval(probe);
        warn('checklist never came up; live sync stays off for this page load');
      }
    }, BOOT_POLL_MS);
  }

  if (typeof window.fetch !== 'function') {
    warn('this browser has no fetch(); live sync is off, the app is unaffected');
  } else if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
