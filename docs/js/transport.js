/* transport.js — the crew's DAY PLAN.
 *
 * Rewritten for race day. The old version rendered 13 shuttle lines out of
 * shuttles.json; on the day itself the crew does not read a timetable, they
 * read their own plan. So this file now renders exactly two things:
 *
 *   1. the FOUR checkpoints the crew actually works
 *      (CP3 Les Contamines · CP7 Courmayeur · CP11 Champex-Lac · CP13 Vallorcine)
 *   2. the day plan itself, straight out of docs/day-plan.json —
 *      six legs as timeline cards, runner ETA chips with their ±20 windows and
 *      carb hand-over numbers, warning strips, "Navigate" links, the eight-row
 *      bus reference and the rules footer.
 *
 * EVERY time and label on screen is printed VERBATIM out of day-plan.json.
 * Nothing here computes, rounds, re-formats or "corrects" a time. If a figure
 * is wrong, it is wrong in the JSON and that is where it gets fixed — a crew
 * standing at a bus stop at 00:30 must be reading the same string that was
 * checked against the official poster.
 *
 * day-plan.json is fetched on a RELATIVE path (the site lives in an unguessable
 * subdirectory) and is precached by sw.js, so this works offline. If the fetch
 * fails the section degrades to a one-line notice and the rest of the app is
 * untouched.
 *
 * Everything is built with createElement + textContent — never innerHTML — so
 * an apostrophe or an angle bracket in the plan can never break the page.
 *
 * SHARED STATE: the runner's bib lives in the shared crew state (meta.bib) and
 * is read/written through UTMB.store, never through localStorage directly, so
 * sync.js sees every write. When sync.js lands a remote update it fires
 * window CustomEvent('utmb:remote-update'); we repaint the bib from the store.
 * The "Track runner" button is aimed by meta.liveTracking in day-plan.json with
 * that shared bib substituted in, so correcting the bib on any phone re-aims
 * the button on all of them.
 *
 * Public surface
 *   UTMB.transport.init(ctx)                     idempotent; main.js drives it
 *   UTMB.transport.isReady()
 *   UTMB.transport.renderOverview()              paints #transportMount
 *   UTMB.transport.renderFor(cpId, containerEl)  -> true if something was drawn
 *   UTMB.transport.renderBib()                   repaint bib field + track link from store
 *   UTMB.transport.getBib() / setBib(v)
 *   UTMB.transport.isCrewPoint(cpId)
 *   UTMB.transport.data()                        the parsed day plan
 *
 * Styles live in css/app.css (prefix `dp-`), not injected from here, so they
 * are precached with the rest of the stylesheet.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var PLAN_PATH = 'day-plan.json';

  /* Last-resort tracking URL. Only ever used if day-plan.json failed to load or
   * carries no meta.liveTracking — it is the generic UTMB live page, which is
   * of no use to a crew mid-race, so the real link always comes from the plan. */
  var TRACK_URL = 'https://live.utmb.world/utmb';

  /* The runner id inside a live.utmb.world URL: ".../runners/<id>[?#...]".
   * Matching it is what lets the shared bib field actually re-aim the button. */
  var RUNNER_SEG = /(\/runners\/)([^/?#]*)/;

  var SLOT_META = 'meta';                 /* -> localStorage "utmb_meta" */

  var plan = null;        /* parsed day-plan.json, or null if it failed to load */
  var course = null;
  var planPromise = null;
  var booted = false;
  var loadFailed = false;

  /* The four crew checkpoints, in course order. cp = course.json / drawer id,
   * key = the runner block in day-plan.json, leg = the leg that covers it. */
  var CREW_POINTS = [
    { cp: 'U3', key: 'cp3', leg: 'fri-cp3', label: 'CP3' },
    { cp: 'U7', key: 'cp7', leg: 'sat-cp7', label: 'CP7' },
    { cp: 'U11', key: 'cp11', leg: 'sat-cp11', label: 'CP11' },
    { cp: 'U13', key: 'cp13', leg: 'sat-cp13', label: 'CP13' }
  ];

  /* Checkpoints that are not crew points but still appear in the plan, so the
   * drawer can show the crew what happens there. */
  var EXTRA_LEG_FOR_CP = {
    start: 'fri-prerace',
    U1: 'fri-prerace',
    finish: 'sun-finish'
  };

  /* ─────────────────────────────────────────────────────────────────────────
   * tiny helpers
   * ───────────────────────────────────────────────────────────────────────── */

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  function txt(v) {
    return typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v));
  }

  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null && text !== '') node.textContent = text;
    return node;
  }

  function mkBtn(cls, aria, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    if (aria) b.setAttribute('aria-label', aria);
    if (fn) b.addEventListener('click', fn);
    return b;
  }

  /* An external map link. Always a real anchor (a phone must be able to long-press
   * it), always target=_blank + rel=noopener. */
  function mkLink(url, label, cls) {
    var a = document.createElement('a');
    a.className = cls || 'dp-nav';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    return a;
  }

  function crewFor(cpId) {
    for (var i = 0; i < CREW_POINTS.length; i++) {
      if (CREW_POINTS[i].cp === cpId) return CREW_POINTS[i];
    }
    return null;
  }

  function legById(id) {
    var legs = (plan && Array.isArray(plan.legs)) ? plan.legs : [];
    for (var i = 0; i < legs.length; i++) {
      if (legs[i] && legs[i].id === id) return legs[i];
    }
    return null;
  }

  function linkFor(ref) {
    if (!ref || !plan || !isObj(plan.links)) return null;
    var l = plan.links[ref];
    return (isObj(l) && l.url) ? l : null;
  }

  function runnerFor(key) {
    var r = plan && isObj(plan.runner) ? plan.runner[key] : null;
    return isObj(r) ? r : null;
  }

  function courseCp(cpId) {
    if (!course || !Array.isArray(course.cps)) return null;
    for (var i = 0; i < course.cps.length; i++) {
      if (course.cps[i].id === cpId) return course.cps[i];
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * bib — shared crew state, meta.bib
   *
   * Read and written through UTMB.store so the sync module sees every change.
   * Duck-typed: if store.js grows a dedicated bib/meta accessor we use it,
   * otherwise the generic slot API. Never touches localStorage directly.
   * ───────────────────────────────────────────────────────────────────────── */

  /* store.js owns meta.bib and exposes getBib()/setBib(); the generic slot read
   * below is only a fall-back for a build where it does not (the slot is the
   * same one store.js writes, so both paths agree). */
  function readMeta() {
    var s = UTMB.store;
    if (!s) return {};
    try {
      var slot = s.get(SLOT_META, null);
      return isObj(slot) ? slot : {};
    } catch (err) {
      console.warn('[UTMB] could not read shared meta', err);
      return {};
    }
  }

  /* Falls back to the bib baked into day-plan.json so the field is never blank
   * on a fresh device. */
  function getBib() {
    var s = UTMB.store;
    var stored = '';
    try {
      if (s && typeof s.getBib === 'function') stored = txt(s.getBib());
      else stored = txt(readMeta().bib);
    } catch (err) {
      console.warn('[UTMB] could not read the bib', err);
    }
    if (stored) return stored;
    return plan && isObj(plan.runner) ? txt(plan.runner.bib) : '';
  }

  function setBib(value) {
    var v = txt(value).replace(/^\s+|\s+$/g, '');
    var s = UTMB.store;
    if (!s) return v;
    try {
      if (typeof s.setBib === 'function') { s.setBib(v); return v; }
      var m = readMeta();
      if (m.bib === v) return v;
      m.bib = v;
      m.bibModified = Date.now();
      s.set(SLOT_META, m);
    } catch (err) {
      console.warn('[UTMB] could not write the bib', err);
    }
    return v;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * live tracking — meta.liveTracking in day-plan.json, aimed by the shared bib
   *
   * The bib field sits immediately left of the Track button and says it is
   * shared with the crew, so the button has to follow it. It does not compute a
   * URL: it takes the one the plan supplies and swaps the runner id in it for
   * whatever bib the crew has agreed on. If the plan's URL is not of the
   * ".../runners/<id>" form it is opened exactly as written — same rule as
   * every other time and link in this file, which are printed verbatim.
   * ───────────────────────────────────────────────────────────────────────── */
  function trackInfo() {
    var meta = (plan && isObj(plan.meta)) ? plan.meta : {};
    var live = isObj(meta.liveTracking) ? meta.liveTracking : {};
    var url = txt(live.url) || TRACK_URL;
    var label = txt(live.label);
    var bib = getBib();

    if (bib && RUNNER_SEG.test(url)) {
      url = url.replace(RUNNER_SEG, function (all, pre) {
        return pre + encodeURIComponent(bib);
      });
    }

    /* Keep the plan's own wording, but never let it advertise a bib the crew
     * has since corrected. */
    if (bib) {
      if (/\bbib\b/i.test(label)) label = label.replace(/(\bbib\s*#?\s*)\S+/i, '$1' + bib);
      else label = label ? (label + ' — bib ' + bib) : ('Track runner — bib ' + bib);
    }
    if (!label) label = 'Track runner';

    return { url: url, label: label };
  }

  /* Point the Track button (and the hint under it) at the current bib. The
   * nodes can be passed in so this also works while the header is still
   * detached, before it has been mounted and is findable by id. */
  function renderTrack(anchorEl, hintEl) {
    var a = anchorEl || document.getElementById('dayTrackLink');
    if (!a) return false;
    var info = trackInfo();
    if (a.getAttribute('href') !== info.url) a.href = info.url;
    a.title = info.label;
    a.setAttribute('aria-label', info.label);
    var hint = hintEl || document.getElementById('dayTrackHint');
    if (hint) {
      var text = info.label + ' · shared with the whole crew';
      if (hint.textContent !== text) hint.textContent = text;
    }
    return true;
  }

  /* Repaint the bib input from the store. Never clobbers what the user is
   * currently typing — but the Track button is repainted either way, so the
   * link is correct the moment the bib is, not one render later. */
  function renderBib() {
    renderTrack();
    var input = document.getElementById('dayBibInput');
    if (!input) return false;
    if (document.activeElement === input) return false;
    var v = getBib();
    if (input.value !== v) input.value = v;
    return true;
  }

  function buildLiveBox() {
    var box = h('div', 'dp-live');
    box.id = 'dayLive';

    var label = h('label', 'dp-bib-label', 'Runner bib');
    label.setAttribute('for', 'dayBibInput');
    box.appendChild(label);

    var row = h('div', 'dp-bib-row');

    var input = document.createElement('input');
    input.id = 'dayBibInput';
    input.className = 'dp-bib';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.spellcheck = false;
    input.maxLength = 12;
    input.placeholder = 'bib';
    input.value = getBib();
    input.setAttribute('aria-label', 'Runner bib number, shared with the crew');

    /* Debounced write, then a final write on blur/change. Both go through
     * UTMB.store.set so sync.js is notified. */
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var v = input.value;
      timer = setTimeout(function () { timer = null; setBib(v); renderTrack(); }, 300);
    });
    input.addEventListener('change', function () {
      clearTimeout(timer); timer = null;
      setBib(input.value);
      renderTrack();
    });
    input.addEventListener('blur', function () {
      clearTimeout(timer); timer = null;
      var v = setBib(input.value);
      input.value = v;
      renderTrack();
    });
    row.appendChild(input);

    /* Href is set by renderTrack() below, from the plan + the shared bib. The
     * button label stays short and fixed because .dp-track is white-space:nowrap
     * and shares a flex row with the input; the plan's own wording (and the live
     * bib) go to title, aria-label and the hint line, which wrap. */
    var track = mkLink(TRACK_URL, '📡 Track runner', 'dp-track');
    track.id = 'dayTrackLink';
    row.appendChild(track);
    box.appendChild(row);

    var hint = h('div', 'dp-bib-hint', 'Shared with the whole crew · opens live.utmb.world');
    hint.id = 'dayTrackHint';
    box.appendChild(hint);

    renderTrack(track, hint);
    return box;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * day-plan pieces
   * ───────────────────────────────────────────────────────────────────────── */

  function buildHead() {
    var meta = isObj(plan.meta) ? plan.meta : {};
    var head = h('header', 'dp-head');
    head.id = 'dayPlanHead';

    var main = h('div', 'dp-head-main');
    main.appendChild(h('h2', 'dp-title', txt(meta.title) || 'Crew Day Plan'));
    if (meta.subtitle) main.appendChild(h('div', 'dp-sub', txt(meta.subtitle)));
    head.appendChild(main);

    head.appendChild(buildLiveBox());
    return head;
  }

  /* One step row inside a leg. `eta:true` makes it the runner's own line;
   * `warn` hangs a warning strip under it; `link` adds a Navigate anchor. */
  function buildStep(step) {
    if (!isObj(step)) return null;
    var li = h('li', 'dp-step' + (step.eta ? ' is-eta' : '') + (step.warn ? ' has-warn' : ''));

    li.appendChild(h('span', 'dp-time', txt(step.time)));

    var body = h('span', 'dp-step-body');
    body.appendChild(h('span', 'dp-text', txt(step.text)));

    var link = linkFor(step.link);
    if (link) {
      var nav = mkLink(link.url, '📍 Navigate');
      nav.title = txt(link.label);
      nav.setAttribute('aria-label', 'Navigate to ' + txt(link.label));
      body.appendChild(nav);
    }

    if (step.warn) {
      var warn = h('span', 'dp-warn');
      warn.appendChild(h('b', 'dp-warn-icon', '⚠'));
      warn.appendChild(h('span', 'dp-warn-text', txt(step.warn)));
      body.appendChild(warn);
    }

    li.appendChild(body);
    return li;
  }

  function buildSteps(steps, cls) {
    var ol = h('ol', 'dp-steps' + (cls ? ' ' + cls : ''));
    (Array.isArray(steps) ? steps : []).forEach(function (s) {
      var row = buildStep(s);
      if (row) ol.appendChild(row);
    });
    return ol;
  }

  /* leg sat-cp13 carries planA / planB halves plus a shared steps array. */
  function buildPlanHalf(half, tag) {
    var box = h('div', 'dp-plan dp-plan-' + tag);
    box.appendChild(h('div', 'dp-plan-label', txt(half.label)));
    box.appendChild(buildSteps(half.steps));
    return box;
  }

  function buildLeg(leg) {
    var art = h('article', 'dp-leg');
    art.setAttribute('data-leg', txt(leg.id));

    var head = h('div', 'dp-leg-head');
    head.appendChild(h('span', 'dp-day', txt(leg.day)));
    head.appendChild(h('h3', 'dp-leg-title', txt(leg.title)));
    art.appendChild(head);

    var hasA = isObj(leg.planA), hasB = isObj(leg.planB);
    if (hasA || hasB) {
      var plans = h('div', 'dp-plans');
      if (hasA) plans.appendChild(buildPlanHalf(leg.planA, 'a'));
      if (hasB) plans.appendChild(buildPlanHalf(leg.planB, 'b'));
      art.appendChild(plans);
    }

    if (Array.isArray(leg.steps) && leg.steps.length) {
      art.appendChild(buildSteps(leg.steps, (hasA || hasB) ? 'dp-steps-shared' : ''));
    }
    return art;
  }

  /* The four crew checkpoint cards: ETA chip with its ±20 window, the cutoff,
   * what he eats there, what the crew hands over, and the next leg. */
  function buildCrewCard(pt) {
    var r = runnerFor(pt.key);
    var cp = courseCp(pt.cp);
    var card = h('div', 'dp-cp-card');
    card.setAttribute('data-cp', pt.cp);

    var open = mkBtn('dp-cp-open', 'Open the crew checklist for ' + (cp ? cp.name : pt.label), function () {
      if (UTMB.drawer && typeof UTMB.drawer.open === 'function') UTMB.drawer.open(pt.cp);
    });

    var top = h('span', 'dp-cp-top');
    top.appendChild(h('span', 'dp-cp-id', pt.label));
    top.appendChild(h('span', 'dp-cp-name', cp ? cp.name : pt.label));
    open.appendChild(top);

    if (r) {
      var eta = h('span', 'dp-cp-eta');
      eta.appendChild(h('b', 'dp-eta-time', txt(r.eta)));
      if (r.window) eta.appendChild(h('i', 'dp-eta-win', '±20 · ' + txt(r.window)));
      open.appendChild(eta);
    }

    var bits = [];
    if (cp && typeof cp.km === 'number') bits.push('km ' + cp.km);
    if (r && r.cutoff) bits.push('cutoff ' + txt(r.cutoff));
    if (bits.length) open.appendChild(h('span', 'dp-cp-meta', bits.join(' · ')));

    if (r && (r.eatHere || r.handOver)) {
      var carbs = h('span', 'dp-cp-carbs');
      if (r.eatHere) carbs.appendChild(h('b', 'dp-carb-eat', 'Eats ' + txt(r.eatHere)));
      if (r.handOver) carbs.appendChild(h('b', 'dp-carb-give', 'Hand over ' + txt(r.handOver)));
      open.appendChild(carbs);
    }

    if (r && r.nextLeg) open.appendChild(h('span', 'dp-cp-next', 'Then ' + txt(r.nextLeg)));

    card.appendChild(open);

    var link = linkFor(pt.key);
    if (link) {
      var nav = mkLink(link.url, '📍 Navigate');
      nav.title = txt(link.label);
      nav.setAttribute('aria-label', 'Navigate to ' + txt(link.label));
      card.appendChild(nav);
    }
    return card;
  }

  function buildCrewSection() {
    var sec = h('section', 'dp-cps');
    sec.id = 'dayCrewPoints';
    sec.appendChild(h('div', 'dp-sec-title', 'Your 4 checkpoints'));

    var grid = h('div', 'dp-cp-grid');
    CREW_POINTS.forEach(function (pt) { grid.appendChild(buildCrewCard(pt)); });
    sec.appendChild(grid);

    var meta = isObj(plan.meta) ? plan.meta : {};
    if (meta.etaNote) sec.appendChild(h('p', 'dp-note', txt(meta.etaNote)));
    sec.appendChild(h('p', 'dp-hint', 'Tap a checkpoint to open its crew checklist and notes.'));
    return sec;
  }

  function buildLegsSection() {
    var sec = h('section', 'dp-legs');
    sec.id = 'dayLegs';
    sec.appendChild(h('div', 'dp-sec-title', 'Day plan'));
    (Array.isArray(plan.legs) ? plan.legs : []).forEach(function (leg) {
      if (isObj(leg)) sec.appendChild(buildLeg(leg));
    });
    return sec;
  }

  function buildBusSection() {
    var rows = Array.isArray(plan.busReference) ? plan.busReference : [];
    if (!rows.length) return null;

    var sec = h('section', 'dp-bus');
    sec.id = 'dayBusRef';
    sec.appendChild(h('div', 'dp-sec-title', 'Bus reference'));

    var table = h('table', 'dp-table');
    var thead = h('thead');
    var hr = h('tr');
    ['Route', 'When', 'Detail'].forEach(function (t) { hr.appendChild(h('th', null, t)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = h('tbody');
    rows.forEach(function (row) {
      if (!isObj(row)) return;
      var tr = h('tr');
      var c1 = h('td', 'dp-td-route', txt(row.route)); c1.setAttribute('data-l', 'Route');
      var c2 = h('td', 'dp-td-when', txt(row.when)); c2.setAttribute('data-l', 'When');
      var c3 = h('td', 'dp-td-detail', txt(row.detail)); c3.setAttribute('data-l', 'Detail');
      tr.appendChild(c1); tr.appendChild(c2); tr.appendChild(c3);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    sec.appendChild(table);
    return sec;
  }

  function buildRulesSection() {
    var rules = Array.isArray(plan.rules) ? plan.rules : [];
    var meta = isObj(plan.meta) ? plan.meta : {};
    if (!rules.length && !meta.accuracyNote) return null;

    var foot = h('footer', 'dp-rules');
    foot.id = 'dayRules';
    foot.appendChild(h('div', 'dp-sec-title', 'Rules'));
    if (rules.length) {
      var ul = h('ul', 'dp-rule-list');
      rules.forEach(function (r) { ul.appendChild(h('li', 'dp-rule', txt(r))); });
      foot.appendChild(ul);
    }
    if (meta.accuracyNote) foot.appendChild(h('p', 'dp-accuracy', txt(meta.accuracyNote)));
    return foot;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * #transportMount — the whole day plan
   * ───────────────────────────────────────────────────────────────────────── */

  function renderOverview() {
    var mount = document.getElementById('transportMount');
    if (!mount) return false;

    if (!plan) {
      mount.textContent = '';
      if (loadFailed) {
        var box = h('div', 'dp dp-failed');
        box.id = 'dayPlan';
        box.appendChild(h('div', 'dp-sec-title', 'Day plan'));
        box.appendChild(h('p', 'dp-hint',
          'The day plan could not be loaded on this device. Open the app once with a ' +
          'signal and it is cached from then on.'));
        mount.appendChild(box);
      }
      return false;
    }

    var root = h('div', 'dp');
    root.id = 'dayPlan';
    root.appendChild(buildHead());
    root.appendChild(buildCrewSection());
    root.appendChild(buildLegsSection());
    var bus = buildBusSection(); if (bus) root.appendChild(bus);
    var rules = buildRulesSection(); if (rules) root.appendChild(rules);

    mount.textContent = '';
    mount.appendChild(root);
    return true;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * #drawerTransportMount — the crew's plan for the open checkpoint
   * ───────────────────────────────────────────────────────────────────────── */

  function buildDrawerCrew(pt) {
    var r = runnerFor(pt.key);
    var box = h('div', 'dp-d');
    box.appendChild(h('div', 'dp-d-head', 'Crew plan'));

    if (r) {
      var eta = h('div', 'dp-d-eta');
      eta.appendChild(h('b', 'dp-eta-time', txt(r.eta)));
      if (r.window) eta.appendChild(h('i', 'dp-eta-win', '±20 · ' + txt(r.window)));
      box.appendChild(eta);

      if (r.eatHere || r.handOver) {
        var carbs = h('div', 'dp-d-carbs');
        if (r.eatHere) carbs.appendChild(h('b', 'dp-carb-eat', 'Eats ' + txt(r.eatHere)));
        if (r.handOver) carbs.appendChild(h('b', 'dp-carb-give', 'Hand over ' + txt(r.handOver)));
        box.appendChild(carbs);
      }

      var tail = [];
      if (r.cutoff) tail.push('Cutoff ' + txt(r.cutoff));
      if (r.nextLeg) tail.push('Then ' + txt(r.nextLeg));
      if (tail.length) box.appendChild(h('div', 'dp-d-next', tail.join(' · ')));
    }

    var link = linkFor(pt.key);
    if (link) {
      var nav = mkLink(link.url, '📍 Navigate');
      nav.title = txt(link.label);
      nav.setAttribute('aria-label', 'Navigate to ' + txt(link.label));
      box.appendChild(nav);
    }

    var leg = legById(pt.leg);
    if (leg) {
      box.appendChild(h('div', 'dp-d-sub', txt(leg.title)));
      if (isObj(leg.planA)) box.appendChild(buildPlanHalf(leg.planA, 'a'));
      if (isObj(leg.planB)) box.appendChild(buildPlanHalf(leg.planB, 'b'));
      if (Array.isArray(leg.steps) && leg.steps.length) box.appendChild(buildSteps(leg.steps));
    }
    return box;
  }

  function buildDrawerOther(cpId) {
    var box = h('div', 'dp-d dp-d-none');
    box.appendChild(h('div', 'dp-d-head', 'Crew plan'));

    var legId = EXTRA_LEG_FOR_CP[cpId];
    var leg = legId ? legById(legId) : null;
    if (leg) {
      box.appendChild(h('div', 'dp-d-sub', txt(leg.title)));
      box.appendChild(buildSteps(leg.steps));
    } else {
      box.appendChild(h('p', 'dp-hint',
        'Not a crew checkpoint — no assistance and no crew access here. ' +
        'The crew works CP3, CP7, CP11 and CP13.'));
    }
    return box;
  }

  function renderFor(cpId, containerEl) {
    var el = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    if (!el) return false;
    el.textContent = '';
    if (!cpId) return false;

    if (!plan) {
      if (!loadFailed) return false;
      var warn = h('div', 'dp-d dp-d-none');
      warn.appendChild(h('div', 'dp-d-head', 'Crew plan'));
      warn.appendChild(h('p', 'dp-hint', 'Day plan not cached on this device yet.'));
      el.appendChild(warn);
      return false;
    }

    var pt = crewFor(cpId);
    el.appendChild(pt ? buildDrawerCrew(pt) : buildDrawerOther(cpId));
    return true;
  }

  function renderAll() {
    renderOverview();
    var active = (UTMB.drawer && typeof UTMB.drawer.activeCp === 'function') ? UTMB.drawer.activeCp() : null;
    if (active) renderFor(active, 'drawerTransportMount');
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * loading + wiring
   * ───────────────────────────────────────────────────────────────────────── */

  /* Relative path on purpose: the site is served from an unguessable
   * subdirectory, so an absolute path would 404. */
  function loadPlan() {
    if (planPromise) return planPromise;
    planPromise = fetch(PLAN_PATH, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + PLAN_PATH);
        return res.json();
      })
      .then(function (json) {
        if (!isObj(json)) throw new Error(PLAN_PATH + ' is not an object');
        plan = json;
        loadFailed = false;
        return json;
      })
      .catch(function (err) {
        console.warn('[UTMB] day plan unavailable', err);
        plan = null;
        loadFailed = true;
        planPromise = null;   /* let a later call retry */
        return null;
      });
    return planPromise;
  }

  UTMB.on('cp:open', function (e) {
    renderFor(e && e.id, 'drawerTransportMount');
  });

  UTMB.on('cp:close', function () {
    var el = document.getElementById('drawerTransportMount');
    if (el) el.textContent = '';
  });

  /* sync.js lands a merged remote state and fires this. Repaint the bib —
   * meta.bib is shared crew state like everything else. */
  window.addEventListener('utmb:remote-update', function () {
    renderBib();
  });

  function initFromContext(ctx) {
    ctx = ctx || {};
    if (ctx.course && !course) course = ctx.course;

    if (booted) {
      if (plan) renderAll();
      return UTMB.transport;
    }
    booted = true;

    loadPlan().then(function () {
      renderAll();
      UTMB.emit('transport:ready', { plan: plan });
    });
    return UTMB.transport;
  }

  UTMB.transport = {
    init: initFromContext,
    isReady: function () { return booted && !!plan; },
    renderOverview: renderOverview,
    renderFor: renderFor,
    render: renderAll,
    renderBib: renderBib,
    getBib: getBib,
    setBib: function (v) { var out = setBib(v); renderBib(); return out; },
    isCrewPoint: function (cpId) { return !!crewFor(cpId); },
    crewPoints: function () { return CREW_POINTS.map(function (p) { return p.cp; }); },
    legFor: function (cpId) {
      var pt = crewFor(cpId);
      return legById(pt ? pt.leg : EXTRA_LEG_FOR_CP[cpId]);
    },
    data: function () { return plan; },
    TRACK_URL: TRACK_URL,
    STORAGE: { meta: 'utmb_meta' }
  };

  UTMB.ready(initFromContext);
})(window.UTMB);
