/* transport.js — crew shuttles, passes and travel timings.
 *
 * Renders, for every checkpoint the drawer opens, the answer to the only
 * transport question this crew has: "how do we get there from Les Houches, and
 * how do we get home again?"
 *
 * Everything on screen is read out of docs/shuttles.json at run time. Nothing is
 * hardcoded — if a fact is not in that file it is not shown, and if a fact is
 * flagged `verified: false` it is shown wearing an UNVERIFIED badge. That rule
 * is the whole point of the file's verification contract: a crew standing in a
 * bus shelter at 01:00 has to be able to tell a timetable from a guess.
 *
 * Public surface
 *   UTMB.transport.renderFor(cpId, containerEl) -> true if something was drawn
 *   UTMB.transport.isCrewPoint(cpId)
 *   UTMB.transport.crewPointFor(cpId)
 *   UTMB.transport.lineFor(ref)
 *   UTMB.transport.data()
 *
 * Wiring: UTMB.ready() captures the parsed shuttles.json, then 'cp:open' /
 * 'cp:close' paint and clear #drawerTransportMount. index.html is untouched.
 *
 * Styles are injected from here (prefixed `tr-`) rather than added to app.css,
 * so this module owns its own presentation and cannot collide with the
 * checklist or share modules.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var shuttles = null;   /* parsed docs/shuttles.json, or null if it failed to load */
  var course = null;
  var idx = null;        /* lookup tables built once, in buildIndex() */

  /* ─────────────────────────────────────────────────────────────────────────
   * Text helpers
   * ───────────────────────────────────────────────────────────────────────── */

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Fold accents and punctuation so "Saint-Gervais" matches the poster's
   * "Saint Gervais" and "Orsières" matches "Orsieres". */
  function norm(s) {
    var t = String(s === null || s === undefined ? '' : s);
    if (typeof t.normalize === 'function') {
      t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }
    return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function fmtMinutes(m) {
    if (typeof m !== 'number' || !isFinite(m) || m <= 0) return null;
    if (m < 60) return m + ' min';
    var h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' h ' + r : h + ' h';
  }

  /* "2026-08-29" -> "Sat 29/08", using event.days so the labels stay in one place. */
  function fmtDay(dateStr) {
    if (!dateStr) return '';
    var d = idx && idx.days[dateStr];
    if (d) return (d.dow ? d.dow + ' ' : '') + (d.label || dateStr);
    return dateStr;
  }

  function fmtWhen(time, dateStr) {
    if (!time) return '';
    var day = fmtDay(dateStr);
    return day ? time + ' ' + day : time;
  }

  /* Comparable stamp for "which service dies first". Times after midnight
   * already carry the following date in shuttles.json, so a plain parse is
   * enough — no roll-over arithmetic needed here. */
  function stamp(dateStr, time) {
    if (!dateStr || !time) return null;
    var t = Date.parse(dateStr + 'T' + (time.length === 4 ? '0' + time : time) + ':00');
    return isNaN(t) ? null : t;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Index
   * ───────────────────────────────────────────────────────────────────────── */

  function buildIndex(s) {
    var lines = Object.create(null);   /* ref -> {ref, line, kind} — never mutates the JSON */
    var hubOf = Object.create(null);   /* line ref -> chamonix hub */

    function addLine(l, kind) {
      if (l && l.id && !lines[l.id]) lines[l.id] = { ref: l.id, line: l, kind: kind };
    }

    (s.followerShuttles || []).forEach(function (l) { addLine(l, 'follower'); });
    (s.startShuttles || []).forEach(function (l) { addLine(l, 'start'); });
    var other = s.otherRunnerShuttles || {};
    (other.start || []).forEach(function (l) { addLine(l, 'runner'); });
    (other.postRace || []).forEach(function (l) { addLine(l, 'runner'); });
    (s.localTransport || []).forEach(function (l) { addLine(l, 'local'); });

    var warnings = Object.create(null);
    (s.warnings || []).forEach(function (w) { if (w && w.id) warnings[w.id] = w; });

    var zones = Object.create(null);
    (s.zones || []).forEach(function (z) { if (z && z.id) zones[z.id] = z; });

    var days = Object.create(null);
    (s.event && s.event.days ? s.event.days : []).forEach(function (d) {
      if (d && d.date) days[d.date] = d;
    });

    var crewPoints = Object.create(null);
    (s.crewPoints || []).forEach(function (c) { if (c && c.cp) crewPoints[c.cp] = c; });

    ((s.chamonixHubs && s.chamonixHubs.hubs) || []).forEach(function (h) {
      (h.usedBy || []).forEach(function (ref) { if (!hubOf[ref]) hubOf[ref] = h; });
    });

    var closedVillages = Object.create(null);
    var rc = s.roadClosures || {};
    (rc.villages || []).concat(rc.additional || []).forEach(function (v) {
      if (v && v.name) closedVillages[norm(v.name)] = v;
    });

    return {
      lines: lines,
      warnings: warnings,
      zones: zones,
      days: days,
      crewPoints: crewPoints,
      hubOf: hubOf,
      closedVillages: closedVillages
    };
  }

  function lineFor(ref) {
    if (!ref || !idx) return null;
    return idx.lines[ref] || null;
  }

  function courseCp(cpId) {
    if (!course || !course.cps) return null;
    for (var i = 0; i < course.cps.length; i++) {
      if (course.cps[i].id === cpId) return course.cps[i];
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Line metadata
   * ───────────────────────────────────────────────────────────────────────── */

  /* localTransport entries carry their timetable inside the `facts` list rather
   * than in dedicated fields. The strings are written "Label: value", so lift
   * the two labels we can use into structured values; anything that does not
   * match is left alone and still gets rendered verbatim further down. */
  var FACT_LABEL_RE = /^([A-Za-z][^:]{0,30}):\s*([\s\S]+)$/;
  var SPAN_RE = /(\d{1,2}:\d{2})\s*(?:to|-|–|—|until)\s*(\d{1,2}:\d{2})/;

  function localMeta(line) {
    var m = { frequency: null, span: null, firstTime: null, lastTime: null, route: null };
    (line.facts || []).forEach(function (f) {
      var hit = FACT_LABEL_RE.exec(f && f.fact ? f.fact : '');
      if (!hit) return;
      var label = norm(hit[1]);
      var value = hit[2].trim();
      if (label === 'frequency') m.frequency = value;
      else if (label === 'route') m.route = value;
      else if (label === 'service span') {
        m.span = value;
        var t = SPAN_RE.exec(value);
        if (t) { m.firstTime = t[1]; m.lastTime = t[2]; }
      }
    });
    return m;
  }

  /* The stop a leg actually boards at, so "first departure" is the time printed
   * against that stop rather than against the head of the line. */
  function boardingStop(line, fromName) {
    var stops = line.stops || [];
    if (!stops.length) return null;
    var want = norm(fromName);
    for (var i = 0; i < stops.length; i++) {
      var sn = norm(stops[i].name);
      if (!sn) continue;
      if (sn === want || (want && want.indexOf(sn) >= 0)) return stops[i];
    }
    return stops[0];
  }

  function stopLabel(st) {
    if (!st) return '';
    return st.name + (st.sublabel ? ' (' + st.sublabel + ')' : '');
  }

  function zoneLabel(zoneId) {
    var z = idx && idx.zones[zoneId];
    return z ? z.label : (zoneId || '');
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * HTML fragments
   * ───────────────────────────────────────────────────────────────────────── */

  function unverifiedBadge(label) {
    return '<span class="tr-unv">' + esc(label || 'UNVERIFIED') + '</span>';
  }

  function chip(text, cls) {
    if (!text) return '';
    return '<span class="tr-chip' + (cls ? ' tr-chip-' + cls : '') + '">' + esc(text) + '</span>';
  }

  /* A chip that carries its own UNVERIFIED mark — used for the "last departure"
   * figures, every one of which is flagged lastSemanticsVerified: false. */
  function chipUnverified(text) {
    return '<span class="tr-chip tr-chip-warn">' + esc(text) + ' ' + unverifiedBadge('UNVERIFIED') + '</span>';
  }

  function note(text, cls) {
    if (!text) return '';
    return '<div class="tr-note' + (cls ? ' ' + cls : '') + '">' + esc(text) + '</div>';
  }

  function unverifiedNote(text, label) {
    return '<div class="tr-note tr-note-unv">' + unverifiedBadge(label) + ' ' + esc(text || '') + '</div>';
  }

  function sectionLabel(text, extra) {
    return '<div class="tr-sec">' + esc(text) +
      (extra ? '<span class="tr-sec-x">' + esc(extra) + '</span>' : '') + '</div>';
  }

  var MODE = {
    walk: 'Walk',
    train: 'Train',
    'utmb-shuttle': 'UTMB shuttle',
    line1: 'Line 1 bus',
    bus: 'Bus',
    transfer: 'Transfer',
    unresolved: 'No verified option'
  };

  function modeTag(mode) {
    var label = MODE[mode] || (mode ? String(mode) : 'Leg');
    return '<span class="tr-mode tr-mode-' + esc(mode || 'other') + '">' + esc(label) + '</span>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Legs
   * ───────────────────────────────────────────────────────────────────────── */

  function legChips(leg, entry) {
    var out = [];
    var mins = (typeof leg.durationMinutes === 'number' && leg.durationMinutes > 0)
      ? leg.durationMinutes
      : (entry && typeof entry.line.journeyMinutes === 'number' ? entry.line.journeyMinutes : null);
    var journey = fmtMinutes(mins);
    if (journey) out.push(chip(journey, 'time'));

    if (entry) {
      var line = entry.line;
      if (entry.kind === 'local') {
        var lm = localMeta(line);
        if (lm.frequency) out.push(chip(lm.frequency, 'freq'));
        if (lm.firstTime && lm.lastTime) {
          out.push(chip('first ' + lm.firstTime, 'first'));
          out.push(chip('last ' + lm.lastTime, 'last'));
        } else if (lm.span) {
          out.push(chip(lm.span, 'freq'));
        }
      } else {
        if (line.frequencyText) out.push(chip(line.frequencyText, 'freq'));
        else if (line.singleRun) out.push(chip('single run — one bus only', 'freq'));

        var st = boardingStop(line, leg.from);
        if (st && st.time) out.push(chip('first ' + st.time + ' from ' + stopLabel(st), 'first'));

        var lastLabel = line.lastTime
          ? 'last ' + fmtWhen(line.lastTime, line.lastDate)
          : (line.lastText ? 'last ' + line.lastText : null);
        if (lastLabel) {
          /* lastSemanticsVerified is false on every published line: nobody has
           * confirmed whether the poster figure is the last departure or the
           * end of service. Show that, every time. */
          out.push(line.lastSemanticsVerified === false ? chipUnverified(lastLabel) : chip(lastLabel, 'last'));
        }
        if (line.direction === 'oneway') out.push(chip('ONE WAY', 'oneway'));
        if (line.passZone) out.push(chip(zoneLabel(line.passZone) + ' pass', 'pass'));
        if (line.bookingRequired) out.push(chip('booking required', 'book'));
      }
    }
    if (!out.length) return '';
    return '<div class="tr-chips">' + out.join('') + '</div>';
  }

  function legHtml(leg, n) {
    var entry = lineFor(leg.ref);
    var unresolved = leg.mode === 'unresolved';
    var cls = 'tr-leg' + (unresolved ? ' tr-leg-unresolved' : '') +
      (leg.mode === 'transfer' ? ' tr-leg-transfer' : '');

    var html = '<li class="' + cls + '">';
    html += '<span class="tr-leg-n">' + esc(n) + '</span>';
    html += '<div class="tr-leg-body">';
    html += '<div class="tr-leg-route">' + modeTag(leg.mode) +
      '<span class="tr-leg-od">' + esc(leg.from) + ' <span class="tr-arrow">&rarr;</span> ' + esc(leg.to) + '</span></div>';

    if (entry) {
      html += '<div class="tr-leg-line">' + esc(entry.line.name) +
        (entry.line.operator ? ' <span class="tr-op">' + esc(entry.line.operator) + '</span>' : '') + '</div>';
    }

    html += legChips(leg, entry);

    if (leg.verified === false) {
      html += unverifiedNote(leg.note, unresolved ? 'NO VERIFIED OPTION' : 'UNVERIFIED');
    } else if (leg.note) {
      html += note(leg.note);
    }

    /* A claim the whole leg leans on but nobody has confirmed — the Le Fayet ->
     * Saint Gervais join is exactly this, and it is load-bearing for U3. */
    if (entry) {
      (entry.line.unverifiedClaims || []).forEach(function (c) {
        if (c.verified === false) {
          html += unverifiedNote(c.claim + ' ' + (c.note || ''), 'UNVERIFIED CLAIM');
        }
      });
      if (entry.line.zoneNote && entry.line.zoneNote.verified === false) {
        html += unverifiedNote(entry.line.zoneNote.note, 'PASS ZONE UNVERIFIED');
      }
    }

    html += '</div></li>';
    return html;
  }

  function legsHtml(legs) {
    if (!legs || !legs.length) return '';
    return '<ol class="tr-legs">' + legs.map(function (leg, i) {
      return legHtml(leg, typeof leg.seq === 'number' ? leg.seq : i + 1);
    }).join('') + '</ol>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Return journey
   * ───────────────────────────────────────────────────────────────────────── */

  /* The binding constraint on getting home: whichever service in the
   * recommended return chain shuts down first. For a return that involves
   * Chamonix Bus Line 1 that is 20:14, not the UTMB shuttle's headline time. */
  function bindingLast(option, assumedDate) {
    var best = null;
    (option.legs || []).forEach(function (leg) {
      var entry = lineFor(leg.ref);
      if (!entry) return;
      var line = entry.line, time = null, date = null, assumed = false;
      if (entry.kind === 'local') {
        var lm = localMeta(line);
        if (!lm.lastTime) return;
        time = lm.lastTime;
        date = assumedDate || null;
        assumed = true;
      } else {
        if (!line.lastTime) return;
        time = line.lastTime;
        date = line.lastDate || null;
      }
      var ts = stamp(date, time);
      if (ts === null) return;
      if (best === null || ts < best.ts) {
        best = { ts: ts, time: time, date: date, assumed: assumed, leg: leg, line: line, kind: entry.kind };
      }
    });
    return best;
  }

  function returnOptionHtml(option, isBest, assumedDate) {
    var html = '<div class="tr-ret' + (isBest ? ' tr-ret-best' : ' tr-ret-alt') + '">';
    html += '<div class="tr-ret-head">' +
      '<span class="tr-ret-tag">' + (isBest ? 'RECOMMENDED' : 'FALLBACK') + '</span>' +
      '<span class="tr-ret-label">' + esc(option.label || '') + '</span></div>';
    if (option.note) html += note(option.note);
    html += legsHtml(option.legs);

    if (isBest) {
      var b = bindingLast(option, assumedDate);
      if (b) {
        html += '<div class="tr-last">' +
          '<span class="tr-last-k">LAST RETURN</span>' +
          '<span class="tr-last-v">' + esc(fmtWhen(b.time, b.date)) + '</span>' +
          '<span class="tr-last-src">' + esc(b.line.name) + ' &middot; from ' + esc(b.leg.from) + '</span>' +
          (b.assumed
            ? ' ' + unverifiedBadge('DATE ASSUMED')
            : (b.line.lastSemanticsVerified === false ? ' ' + unverifiedBadge('UNVERIFIED') : '')) +
          '<div class="tr-last-why">Earliest closing service in this chain — everything else runs later, so this is the clock that matters.</div>' +
          '</div>';
      } else {
        html += '<div class="tr-last tr-last-none">' +
          '<span class="tr-last-k">LAST RETURN</span>' +
          '<span class="tr-last-v">not published</span> ' + unverifiedBadge('UNVERIFIED') +
          '<div class="tr-last-why">No timetable in the crew’s possession covers the return leg. Check it in person before you go.</div>' +
          '</div>';
      }
    }
    html += '</div>';
    return html;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Warnings
   * ───────────────────────────────────────────────────────────────────────── */

  var SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

  function warningHtml(w) {
    var sev = w.severity || 'medium';
    var html = '<div class="tr-warn tr-warn-' + esc(sev) + '">';
    html += '<div class="tr-warn-head"><span class="tr-sev">' + esc(sev.toUpperCase()) + '</span>' +
      '<span class="tr-warn-title">' + esc(w.title) + '</span></div>';
    html += '<div class="tr-warn-body">' + esc(w.body) + '</div>';
    if (w.verified === false) html += unverifiedNote(w.note || '', 'UNVERIFIED');
    else if (w.note) html += note(w.note);
    if (w.mitigations && w.mitigations.length) {
      html += '<ul class="tr-mit">' + w.mitigations.map(function (m) {
        return '<li>' + esc(m) + '</li>';
      }).join('') + '</ul>';
    }
    return html + '</div>';
  }

  function warningsHtml(ids) {
    var list = (ids || []).map(function (id) { return idx.warnings[id]; }).filter(Boolean);
    if (!list.length) return '';
    list.sort(function (a, b) {
      return (SEVERITY_RANK[a.severity] === undefined ? 9 : SEVERITY_RANK[a.severity]) -
        (SEVERITY_RANK[b.severity] === undefined ? 9 : SEVERITY_RANK[b.severity]);
    });
    var loud = list.filter(function (w) { return w.severity === 'critical' || w.severity === 'high'; });
    var quiet = list.filter(function (w) { return w.severity !== 'critical' && w.severity !== 'high'; });

    var html = sectionLabel('Warnings', list.length + ' for this checkpoint');
    html += loud.map(warningHtml).join('');
    if (quiet.length) {
      html += '<details class="tr-more"><summary>' + quiet.length + ' more warning' +
        (quiet.length === 1 ? '' : 's') + ' (' +
        esc(quiet.map(function (w) { return w.severity; }).join(', ')) + ')</summary>' +
        quiet.map(warningHtml).join('') + '</details>';
    }
    return html;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Passes, boarding, line detail
   * ───────────────────────────────────────────────────────────────────────── */

  function passHtml(cpt, usedRefs) {
    var passes = shuttles.passes || {};
    var html = sectionLabel('Pass & boarding');
    html += '<div class="tr-pass">';

    if (cpt.passRequired) {
      var z = idx.zones[cpt.passRequired];
      html += '<div class="tr-pass-need"><b>' + esc((z && z.passRequired) || cpt.passRequired) + '</b> — ' +
        esc(cpt.name) + ' is in the ' + esc(zoneLabel(cpt.zone)) + ' zone.</div>';
      if (z && z.verified === false) html += unverifiedNote('Zone definition unconfirmed.', 'UNVERIFIED');
    } else {
      html += '<div class="tr-pass-need tr-pass-free"><b>No UTMB pass needed</b> on the recommended route.</div>';
    }

    if (passes.crewStatus) html += note(passes.crewStatus);
    if (passes.boardingCredential) html += note(passes.boardingCredential);
    if (passes.verified === false) html += unverifiedNote('Pass rules unconfirmed.', 'UNVERIFIED');

    /* Chamonix has two UTMB hubs and boarding the wrong one costs an hour. */
    var hubs = [];
    usedRefs.forEach(function (ref) {
      var h = idx.hubOf[ref];
      if (!h) return;
      var e = lineFor(ref);
      hubs.push(esc(e ? e.line.name : ref) + ' &rarr; <b>' + esc(h.name) + '</b>');
    });
    if (hubs.length) {
      html += '<div class="tr-hub"><span class="tr-hub-k">Chamonix boarding point</span>' +
        '<ul class="tr-hub-l"><li>' + hubs.join('</li><li>') + '</li></ul></div>';
      var caveat = shuttles.chamonixHubs && shuttles.chamonixHubs.caveat;
      if (caveat && caveat.verified === false) html += unverifiedNote(caveat.note, 'UNVERIFIED');
    }

    return html + '</div>';
  }

  function lineDetailHtml(entry) {
    var line = entry.line;
    var html = '<div class="tr-line">';
    html += '<div class="tr-line-name">' + esc(line.name) +
      (line.verified === false ? ' ' + unverifiedBadge('UNVERIFIED LINE') : '') + '</div>';

    var chips = [];
    if (entry.kind === 'local') {
      var lm = localMeta(line);
      if (line.operator) chips.push(chip(line.operator));
      if (lm.frequency) chips.push(chip(lm.frequency, 'freq'));
      if (lm.span) chips.push(chip(lm.span, 'last'));
      if (lm.route) chips.push(chip(lm.route));
    } else {
      if (line.zone) chips.push(chip(zoneLabel(line.zone) + ' zone', 'pass'));
      if (line.direction) chips.push(chip(line.direction === 'both' ? 'both directions' : 'one way',
        line.direction === 'oneway' ? 'oneway' : null));
      if (line.frequencyText) chips.push(chip(line.frequencyText, 'freq'));
      var jm = fmtMinutes(line.journeyMinutes);
      if (jm) chips.push(chip(jm + ' end to end', 'time'));
      if (line.lastTime || line.lastText) {
        var lbl = 'last ' + (line.lastTime ? fmtWhen(line.lastTime, line.lastDate) : line.lastText);
        chips.push(line.lastSemanticsVerified === false ? chipUnverified(lbl) : chip(lbl, 'last'));
      }
      if (line.date) chips.push(chip('runs ' + fmtDay(line.date) +
        (line.dateEnd && line.dateEnd !== line.date ? ' → ' + fmtDay(line.dateEnd) : '')));
    }
    if (chips.length) html += '<div class="tr-chips">' + chips.join('') + '</div>';

    if (line.stops && line.stops.length) {
      html += '<ul class="tr-stops">' + line.stops.map(function (st) {
        return '<li><span class="tr-stop-t">' + esc(st.time || '') + '</span>' + esc(stopLabel(st)) + '</li>';
      }).join('') + '</ul>';
    }

    if (line.note) html += note(line.note);

    (line.facts || []).forEach(function (f) {
      if (f.verified === false) {
        html += unverifiedNote(f.fact + (f.note ? ' — ' + f.note : ''), 'UNVERIFIED');
      } else {
        html += '<div class="tr-fact">' + esc(f.fact) + '</div>';
      }
    });

    (line.unverifiedClaims || []).forEach(function (c) {
      if (c.verified === false) html += unverifiedNote(c.claim + ' ' + (c.note || ''), 'UNVERIFIED CLAIM');
    });
    if (line.zoneNote && line.zoneNote.verified === false) {
      html += unverifiedNote(line.zoneNote.note, 'PASS ZONE UNVERIFIED');
    }
    if (line.lastSourceNote) html += note(line.lastSourceNote);

    return html + '</div>';
  }

  function linesUsedHtml(refs) {
    var entries = refs.map(lineFor).filter(Boolean);
    if (!entries.length) return '';
    return '<details class="tr-more"><summary>Line details (' + entries.length + ')</summary>' +
      entries.map(lineDetailHtml).join('') + '</details>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * "Confirm before you go" — every open question in the file is flagged
   * verified:false with a null answer. Show the ones that name this checkpoint.
   * ───────────────────────────────────────────────────────────────────────── */

  function confirmHtml(cpt) {
    var items = (shuttles.confirmTomorrowChecklist || []).filter(function (it) {
      if (it.verified !== false) return false;
      var hay = norm((it.item || '') + ' ' + (it.why || ''));
      return hay.split(' ').indexOf(norm(cpt.cp)) >= 0 || hay.indexOf(norm(cpt.name)) >= 0;
    });
    if (!items.length) return '';
    items.sort(function (a, b) { return (a.priority || 9) - (b.priority || 9); });
    return '<details class="tr-more tr-more-open"><summary>Confirm before you go (' + items.length + ' open)</summary>' +
      items.map(function (it) {
        return '<div class="tr-confirm">' + unverifiedBadge('OPEN') +
          '<span class="tr-confirm-item">' + esc(it.item) + '</span>' +
          (it.why ? note(it.why) : '') + '</div>';
      }).join('') + '</details>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Crew checkpoint block
   * ───────────────────────────────────────────────────────────────────────── */

  function collectRefs(cpt, bestReturn) {
    var refs = [];
    function take(legs) {
      (legs || []).forEach(function (l) {
        if (l.ref && refs.indexOf(l.ref) < 0 && lineFor(l.ref)) refs.push(l.ref);
      });
    }
    take(cpt.legs);
    if (bestReturn) take(bestReturn.legs);
    return refs;
  }

  function crewPointHtml(cpt) {
    var origin = (shuttles.crewBase && shuttles.crewBase.village) || 'Les Houches';
    var returns = (cpt.returnOptions || []).slice().sort(function (a, b) {
      return (a.preference || 99) - (b.preference || 99);
    });
    var best = returns[0] || null;
    var refs = collectRefs(cpt, best);
    var assumedDate = cpt.cutoff && cpt.cutoff.date ? cpt.cutoff.date : null;

    var html = '<div class="tr-block">';

    html += '<div class="tr-head">' +
      '<span class="tr-head-t">Getting here from ' + esc(origin) + '</span>' +
      (cpt.difficulty
        ? '<span class="tr-diff tr-diff-' + esc(cpt.difficulty) + '">' + esc(cpt.difficulty.toUpperCase()) +
          (cpt.difficultyRating ? ' · ' + esc(cpt.difficultyRating) + '/5' : '') + '</span>'
        : '') +
      '</div>';

    if (cpt.cutoff && cpt.cutoff.time) {
      html += '<div class="tr-when">Be there before the <b>' +
        esc((cpt.cutoff.dow ? cpt.cutoff.dow + ' ' : '') + cpt.cutoff.time) + '</b> cutoff' +
        (typeof cpt.km === 'number' ? ' · km ' + esc(cpt.km) : '') + '</div>';
    }

    if (cpt.headline) html += '<div class="tr-headline">' + esc(cpt.headline) + '</div>';
    if (cpt.reasoning) html += '<div class="tr-why"><span class="tr-why-k">Why this way</span>' + esc(cpt.reasoning) + '</div>';

    html += sectionLabel('Route out', (cpt.legs || []).length + ' legs');
    html += legsHtml(cpt.legs);

    if (returns.length) {
      html += sectionLabel('Getting back');
      html += returnOptionHtml(returns[0], true, assumedDate);
      /* Lower-preference returns are real options but not the plan — one tap
       * away rather than another screen of scrolling past the plan itself. */
      returns.slice(1).forEach(function (opt) {
        html += '<details class="tr-more"><summary>Fallback: ' + esc(opt.label || 'other way back') +
          '</summary>' + returnOptionHtml(opt, false, assumedDate) + '</details>';
      });
    }

    if (cpt.alternatives && cpt.alternatives.length) {
      html += sectionLabel('Alternative route out');
      cpt.alternatives.forEach(function (alt) {
        var e = lineFor(alt.ref);
        html += '<div class="tr-alt"><div class="tr-alt-label">' + esc(alt.label) +
          (alt.verified === false ? ' ' + unverifiedBadge('UNVERIFIED') : '') + '</div>';
        if (e) html += legChips({ from: '', ref: alt.ref }, e);
        if (alt.note) html += note(alt.note);
        if (e && e.line.zoneNote && e.line.zoneNote.verified === false) {
          html += unverifiedNote(e.line.zoneNote.note, 'PASS ZONE UNVERIFIED');
        }
        html += '</div>';
      });
    }

    html += passHtml(cpt, refs);
    html += warningsHtml(cpt.warnings);

    if (cpt.notes) {
      html += sectionLabel('On the ground');
      html += '<div class="tr-onground">' + esc(cpt.notes) + '</div>';
    }

    html += confirmHtml(cpt);
    html += linesUsedHtml(refs);
    html += sourceHtml();
    html += '</div>';
    return html;
  }

  function sourceHtml() {
    var bits = [];
    if (shuttles.compiledAt) bits.push('shuttles.json compiled ' + shuttles.compiledAt);
    if (shuttles.schemaVersion) bits.push('v' + shuttles.schemaVersion);
    if (shuttles.timezone) bits.push('all times ' + shuttles.timezone);
    if (!bits.length) return '';
    return '<div class="tr-src">' + esc(bits.join(' · ')) + '</div>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Non-crew checkpoint block — deliberately short
   * ───────────────────────────────────────────────────────────────────────── */

  /* Follower lines that call at this place, so the crew know whether they could
   * at least stand there and cheer. Exact name match only — "Contamines" must
   * not be dragged in by "Les Contamines". */
  function spectatorLines(cpName) {
    var want = norm(cpName);
    if (!want) return [];
    var out = [];
    (shuttles.followerShuttles || []).forEach(function (l) {
      var hit = (l.stops || []).some(function (st) { return norm(st.name) === want; });
      if (hit && out.indexOf(l) < 0) out.push(l);
    });
    return out;
  }

  function noCrewHtml(cpId) {
    var cp = courseCp(cpId);
    var name = cp ? cp.name : cpId;
    var html = '<div class="tr-block tr-block-nocrew">';
    html += '<div class="tr-head"><span class="tr-head-t">Crew access</span>' +
      '<span class="tr-diff tr-diff-none">NO CREW ACCESS</span></div>';

    /* Les Houches is the crew's own village and the course runs through it —
     * worth its own sentence, because "we live here" reads like "we can crew
     * here" and it is not true. */
    var passage = shuttles.crewBase && shuttles.crewBase.coursePassage;
    if (passage && passage.checkpoint === cpId) {
      html += '<div class="tr-nocrew-lead">' + esc(passage.note) + '</div>';
      var w = passage.expectedWindow;
      if (w && w.from) {
        var win = 'Expect the runner ' + w.from + '–' + w.to + (w.date ? ' ' + fmtDay(w.date) : '');
        if (w.verified === false) html += unverifiedNote(win + '. ' + (w.note || ''), 'UNVERIFIED');
        else html += note(win + '.');
      }
    } else if (cpId === 'start') {
      html += '<div class="tr-nocrew-lead">The start line, not an assistance point. What matters here is getting the crew ' +
        'into Chamonix in time to watch it.</div>';
      (shuttles.startShuttles || []).forEach(function (l) {
        html += '<div class="tr-line">' +
          '<div class="tr-line-name">' + esc(l.name) + '</div>' +
          legChips({ from: 'Houches', ref: l.id }, lineFor(l.id)) +
          note(l.note) + '</div>';
      });
    } else if (cpId === 'finish') {
      html += '<div class="tr-nocrew-lead">The finish line. Nothing to hand over — just be there. ' +
        'Sunday daylight, so Chamonix Bus Line 1 is running normally.</div>';
    } else {
      html += '<div class="tr-nocrew-lead">' + esc(name) +
        ' is not a personal-assistance point. No gear, food or drink may be handed over here' +
        (cp && cp.support === 'water' ? ' — it is a water point only.' : '.') +
        ' The crew points are U3 Les Contamines, U7 Courmayeur, U11 Champex-Lac and U13 Vallorcine.</div>';

      var lines = spectatorLines(name);
      if (lines.length) {
        html += '<div class="tr-nocrew-spec">Spectating only, if you want to go anyway:</div>';
        html += '<ul class="tr-spec-l">' + lines.map(function (l) {
          var lastBit = l.lastTime ? ', last ' + fmtWhen(l.lastTime, l.lastDate) : '';
          return '<li><b>' + esc(l.name) + '</b> — ' + esc(l.frequencyText || 'see timetable') + esc(lastBit) +
            (l.passZone ? ' · ' + esc(zoneLabel(l.passZone)) + ' pass' : '') +
            (l.lastSemanticsVerified === false ? ' ' + unverifiedBadge('LAST TIME UNVERIFIED') : '') + '</li>';
        }).join('') + '</ul>';
      }
    }

    var noAssist = idx.warnings['no-assistance-les-houches'];
    if (cpId === 'U1' && noAssist) html += warningHtml(noAssist);

    html += sourceHtml();
    return html + '</div>';
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Public entry point
   * ───────────────────────────────────────────────────────────────────────── */

  function renderFor(cpId, containerEl) {
    var el = typeof containerEl === 'string' ? document.getElementById(containerEl) : containerEl;
    if (!el) return false;

    if (!shuttles || !idx) {
      el.innerHTML = '<div class="tr-block tr-block-empty">' +
        '<div class="tr-head"><span class="tr-head-t">Transport</span></div>' +
        '<div class="tr-nocrew-lead">Shuttle timetable unavailable on this device — shuttles.json did not load. ' +
        'Reload once while online; after that it works offline.</div></div>';
      return false;
    }

    var cpt = idx.crewPoints[cpId];
    el.innerHTML = cpt ? crewPointHtml(cpt) : noCrewHtml(cpId);
    return true;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Styles — injected here so this module owns its own presentation.
   * System fonts only; palette inherited from app.css :root.
   * ───────────────────────────────────────────────────────────────────────── */

  var CSS = [
    '.tr-block{margin:0 0 16px;padding:12px;border:1px solid var(--border);border-radius:12px;background:#151515;',
    '  font-family:-apple-system,"Avenir Next","Helvetica Neue",sans-serif}',
    '.tr-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
    '.tr-head-t{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted)}',
    '.tr-diff{font-size:10px;font-weight:700;letter-spacing:.4px;padding:3px 7px;border-radius:6px;white-space:nowrap;',
    '  background:#1c1c1c;color:var(--muted);border:1px solid #2e2e2e}',
    '.tr-diff-easy{background:#132a19;color:var(--food);border-color:#1d5233}',
    '.tr-diff-moderate{background:#2c2510;color:#facc15;border-color:#5c4d15}',
    '.tr-diff-hard{background:#2e1414;color:var(--hotmeal);border-color:#7f1d1d}',
    '.tr-diff-none{background:#1c1c1c;color:#8b8b8b}',
    '.tr-when{font-size:12px;color:var(--muted);margin-bottom:8px}',
    '.tr-when b{color:var(--text)}',
    '.tr-headline{font-size:14px;font-weight:700;line-height:1.35;color:#fff;background:#1e1a10;border-left:3px solid #facc15;',
    '  padding:8px 10px;border-radius:0 8px 8px 0;margin-bottom:8px}',
    '.tr-why{font-size:12.5px;line-height:1.5;color:#c8c8c8;margin-bottom:12px}',
    '.tr-why-k{display:block;font-size:10px;font-weight:700;letter-spacing:.5px;color:var(--muted);',
    '  text-transform:uppercase;margin-bottom:3px}',
    '.tr-sec{display:flex;align-items:baseline;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.7px;',
    '  text-transform:uppercase;color:var(--accent);margin:14px 0 7px;padding-top:8px;border-top:1px solid var(--border)}',
    '.tr-sec-x{font-weight:600;letter-spacing:.2px;color:var(--muted);text-transform:none}',
    /* legs */
    '.tr-legs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.tr-leg{display:flex;gap:9px;align-items:flex-start;background:#191919;border:1px solid #232323;',
    '  border-radius:10px;padding:8px 9px}',
    '.tr-leg-unresolved{background:#241010;border-color:#5b1d1d}',
    '.tr-leg-transfer{background:#241d10;border-color:#5c4a15}',
    '.tr-leg-n{flex:0 0 auto;width:20px;height:20px;border-radius:50%;background:#2b2b2b;color:#e5e5e5;',
    '  font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}',
    '.tr-leg-unresolved .tr-leg-n{background:#7f1d1d;color:#fff}',
    '.tr-leg-body{flex:1 1 auto;min-width:0}',
    '.tr-leg-route{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;line-height:1.35;color:var(--text)}',
    '.tr-leg-od{font-weight:600}',
    '.tr-arrow{color:var(--muted);font-weight:400}',
    '.tr-mode{font-size:9.5px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:2px 6px;',
    '  border-radius:5px;background:#2b2b2b;color:#cfcfcf;white-space:nowrap}',
    '.tr-mode-walk{background:#20262e;color:#9db6d6}',
    '.tr-mode-train{background:#152238;color:var(--water)}',
    '.tr-mode-utmb-shuttle{background:#132a19;color:var(--food)}',
    '.tr-mode-line1{background:#251a30;color:var(--accent)}',
    '.tr-mode-transfer{background:#3a2f10;color:#facc15}',
    '.tr-mode-unresolved{background:#5b1d1d;color:#fecaca}',
    '.tr-leg-line{font-size:11.5px;color:#9fb0c8;margin-top:3px}',
    '.tr-op{color:var(--muted)}',
    /* chips */
    '.tr-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
    '.tr-chip{font-size:10.5px;font-weight:600;line-height:1.35;padding:2px 6px;border-radius:5px;',
    '  background:#232323;color:#d4d4d4;border:1px solid #2e2e2e;white-space:nowrap}',
    '.tr-chip-time{color:#e5e5e5}',
    '.tr-chip-freq{color:#a7d8ff;border-color:#28394d}',
    '.tr-chip-first{color:#9ae6b4;border-color:#22402c}',
    '.tr-chip-last{color:#fca5a5;border-color:#4a2020}',
    '.tr-chip-oneway{color:#fbbf24;border-color:#5c4d15}',
    '.tr-chip-pass{color:var(--accent);border-color:#3c3060}',
    '.tr-chip-book{color:var(--muted)}',
    '.tr-chip-warn{white-space:normal;background:#2a1a1a;border-color:#5b2a2a;color:#fca5a5}',
    /* the UNVERIFIED badge — has to be impossible to miss */
    '.tr-unv{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.7px;padding:1px 5px;border-radius:4px;',
    '  background:var(--supporter);color:#fff;text-transform:uppercase;vertical-align:baseline;white-space:nowrap}',
    '.tr-note{font-size:11.5px;line-height:1.5;color:#a8a8a8;margin-top:5px}',
    '.tr-note-unv{color:#f0c9c9;background:#2a1414;border:1px solid #5b2a2a;border-radius:7px;padding:6px 8px}',
    '.tr-fact{font-size:11.5px;line-height:1.5;color:#a8a8a8;margin-top:4px;padding-left:12px;position:relative}',
    '.tr-fact:before{content:"\\2713";position:absolute;left:0;color:var(--food);font-size:10px}',
    /* return */
    '.tr-ret{border:1px solid #232323;border-radius:10px;padding:9px;margin-bottom:9px;background:#171717}',
    '.tr-ret-best{border-color:#1d5233}',
    '.tr-ret-alt{opacity:.9}',
    '.tr-ret-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:7px}',
    '.tr-ret-tag{font-size:9.5px;font-weight:800;letter-spacing:.6px;padding:2px 6px;border-radius:5px;',
    '  background:#2b2b2b;color:var(--muted)}',
    '.tr-ret-best .tr-ret-tag{background:#132a19;color:var(--food)}',
    '.tr-ret-label{font-size:12.5px;font-weight:700;color:var(--text)}',
    '.tr-last{margin-top:9px;padding:8px 9px;border-radius:8px;background:#111;border:1px solid #333;',
    '  display:flex;flex-wrap:wrap;align-items:baseline;gap:7px}',
    '.tr-last-k{font-size:9.5px;font-weight:800;letter-spacing:.7px;color:var(--muted)}',
    '.tr-last-v{font-size:15px;font-weight:800;color:#fff;letter-spacing:-.2px}',
    '.tr-last-src{font-size:11px;color:#9fb0c8;flex:1 1 100%}',
    '.tr-last-why{flex:1 1 100%;font-size:11px;line-height:1.45;color:var(--muted)}',
    '.tr-last-none .tr-last-v{color:#fca5a5}',
    /* alternatives */
    '.tr-alt{border:1px dashed #333;border-radius:10px;padding:9px;background:#171717}',
    '.tr-alt-label{font-size:12.5px;font-weight:700;color:var(--text)}',
    /* warnings */
    '.tr-warn{border-radius:10px;padding:9px;margin-bottom:8px;border:1px solid #2e2e2e;background:#181818}',
    '.tr-warn-critical{border-color:var(--supporter);background:#2a0f0f}',
    '.tr-warn-high{border-color:#7f1d1d;background:#221212}',
    '.tr-warn-medium{border-color:#5c4d15;background:#1e1a10}',
    '.tr-warn-low{border-color:#2e2e2e}',
    '.tr-warn-head{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;margin-bottom:5px}',
    '.tr-sev{font-size:9px;font-weight:800;letter-spacing:.7px;padding:2px 5px;border-radius:4px;background:#2b2b2b;color:#d4d4d4}',
    '.tr-warn-critical .tr-sev{background:var(--supporter);color:#fff}',
    '.tr-warn-high .tr-sev{background:#7f1d1d;color:#fecaca}',
    '.tr-warn-medium .tr-sev{background:#5c4d15;color:#fde68a}',
    '.tr-warn-title{font-size:12.5px;font-weight:700;color:#fff;line-height:1.3}',
    '.tr-warn-body{font-size:11.5px;line-height:1.5;color:#c9c9c9}',
    '.tr-mit{margin:6px 0 0;padding-left:16px;font-size:11.5px;line-height:1.5;color:#a8a8a8}',
    '.tr-mit li{margin-bottom:3px}',
    /* pass / hubs / lines */
    '.tr-pass{font-size:12px;line-height:1.5;color:#c9c9c9}',
    '.tr-pass-need{margin-bottom:5px;color:var(--text)}',
    '.tr-pass-free b{color:var(--food)}',
    '.tr-hub{margin-top:7px}',
    '.tr-hub-k{display:block;font-size:9.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--muted)}',
    '.tr-hub-l{margin:4px 0 0;padding-left:16px;font-size:11.5px;line-height:1.6;color:#c9c9c9}',
    '.tr-line{border-top:1px solid #232323;padding-top:8px;margin-top:8px}',
    '.tr-line:first-child{border-top:none;padding-top:0;margin-top:0}',
    '.tr-line-name{font-size:12.5px;font-weight:700;color:var(--text)}',
    '.tr-stops{list-style:none;margin:6px 0 0;padding:0;font-size:11.5px;line-height:1.6;color:#c9c9c9}',
    '.tr-stops li{display:flex;gap:8px}',
    '.tr-stop-t{flex:0 0 42px;color:#9ae6b4;font-weight:700;font-variant-numeric:tabular-nums}',
    /* disclosure blocks */
    '.tr-more{margin-top:10px;border:1px solid var(--border);border-radius:10px;background:#141414}',
    '.tr-more>summary{cursor:pointer;list-style:none;padding:8px 10px;font-size:11.5px;font-weight:700;',
    '  color:var(--muted);-webkit-tap-highlight-color:transparent}',
    '.tr-more>summary::-webkit-details-marker{display:none}',
    '.tr-more>summary:before{content:"\\25B8 ";color:var(--accent)}',
    '.tr-more[open]>summary:before{content:"\\25BE "}',
    '.tr-more[open]>summary{border-bottom:1px solid var(--border)}',
    '.tr-more>*:not(summary){margin-left:10px;margin-right:10px}',
    '.tr-more>*:last-child{margin-bottom:10px}',
    '.tr-more-open>summary{color:#fca5a5}',
    '.tr-confirm{padding-top:8px}',
    '.tr-confirm-item{font-size:12px;font-weight:600;color:var(--text);margin-left:6px;line-height:1.4}',
    /* non-crew */
    '.tr-block-nocrew,.tr-block-empty{background:#141414}',
    '.tr-nocrew-lead{font-size:12.5px;line-height:1.5;color:#c9c9c9}',
    '.tr-nocrew-spec{font-size:10.5px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;',
    '  color:var(--muted);margin-top:10px}',
    '.tr-spec-l{margin:5px 0 0;padding-left:16px;font-size:11.5px;line-height:1.6;color:#c9c9c9}',
    '.tr-onground{font-size:12px;line-height:1.55;color:#c9c9c9}',
    '.tr-src{margin-top:12px;padding-top:8px;border-top:1px solid var(--border);font-size:10px;color:#6f6f6f}'
  ].join('');

  function injectStyles() {
    if (document.getElementById('tr-styles')) return;
    var st = document.createElement('style');
    st.id = 'tr-styles';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * iOS: keep the drawer's notes textarea above the software keyboard.
   *
   * #dNotes belongs to drawer.js, which is not editable in this pass — and the
   * transport block above it is what pushes the textarea down far enough for
   * the keyboard to swallow it, so this module carries the fix. profile.js does
   * the same for its own #sectionNotesTa.
   * ───────────────────────────────────────────────────────────────────────── */
  function keepTextareaVisible(el) {
    if (!el || el._trKeyboardWired) return;
    el._trKeyboardWired = true;

    var timer = null;
    function reveal() {
      clearTimeout(timer);
      /* The keyboard animates in after focus; scrolling immediately scrolls to
       * a position that is wrong by the time it has finished. */
      timer = setTimeout(function () {
        if (document.activeElement !== el) return;
        if (typeof el.scrollIntoView === 'function') {
          try {
            el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
          } catch (err) {
            el.scrollIntoView(false);
          }
        }
      }, 300);
    }

    el.addEventListener('focus', reveal);

    /* iOS resizes the visual viewport when the keyboard opens or the accessory
     * bar changes height; re-run then so the caret never ends up underneath it. */
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', function () {
        if (document.activeElement === el) reveal();
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * Wiring
   * ───────────────────────────────────────────────────────────────────────── */

  injectStyles();

  UTMB.ready(function (ctx) {
    course = ctx && ctx.course ? ctx.course : null;
    shuttles = ctx && ctx.shuttles ? ctx.shuttles : null;
    idx = shuttles ? buildIndex(shuttles) : null;

    if (!shuttles) console.warn('[UTMB] transport: shuttles.json unavailable, drawer will say so');

    keepTextareaVisible(document.getElementById('dNotes'));

    /* The drawer may already be open (deep link, re-render) — paint it now. */
    var openCp = UTMB.drawer && typeof UTMB.drawer.activeCp === 'function' ? UTMB.drawer.activeCp() : null;
    if (openCp) renderFor(openCp, document.getElementById('drawerTransportMount'));
  });

  UTMB.on('cp:open', function (e) {
    renderFor(e && e.id, document.getElementById('drawerTransportMount'));
  });

  UTMB.on('cp:close', function () {
    var mount = document.getElementById('drawerTransportMount');
    /* Empty again so .mount:empty hides it and the next open starts clean. */
    if (mount) mount.innerHTML = '';
  });

  UTMB.transport = {
    renderFor: renderFor,
    isCrewPoint: function (cpId) { return !!(idx && idx.crewPoints[cpId]); },
    crewPointFor: function (cpId) { return (idx && idx.crewPoints[cpId]) || null; },
    lineFor: lineFor,
    data: function () { return shuttles; }
  };
})(window.UTMB);
