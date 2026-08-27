/* profile.js — elevation profile: axes, section hit-areas, terrain path,
 * checkpoint + landmark markers, horizontal zoom/pan with a scrollbar, section
 * selection (tooltip + notes), and the training-status overlay.
 *
 * Ported from the single-file build. Reads/writes practice, plan and
 * sectionNotes through UTMB.store, and drives the red section highlight on the
 * map through UTMB.map.highlightRange().
 *
 * Public API (all no-ops before build()):
 *   UTMB.profile.build({course, onCpClick})
 *   UTMB.profile.zoomProfile(factor) / resetProfZoom()
 *   UTMB.profile.selectSection(i) / clearSelection() / getSelected()
 *   UTMB.profile.togglePracticeDone(i) / togglePracticePlanned(i)
 *   UTMB.profile.toggleTrainingMode() / setTrainingMode(bool)
 *   UTMB.profile.profX(km) / profY(alt)
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ── geometry ─────────────────────────────────────────────────────────────
   * Fixed 900x738 coordinate space; the viewBox window narrows/slides over it
   * for zoom, so nothing else has to know about zoom state. */
  var PROF_W = 900, PROF_H = 738;
  var PROF_PADL = 42, PROF_PADR = 10, PROF_PADT = 248, PROF_PADB = 110;

  /* profile marker sizing — big enough that two-digit CP numbers fit and read */
  var PMK_R = 12.08, PMK_RING = 16.68, PMK_FONT = 12.65, PMK_RING_STROKE = 3.91;

  /* iOS FIX (WebKit bug 139258): Mobile Safari applies dominant-baseline
   * inconsistently, so every piece of SVG text that used to rely on it now
   * carries an explicit dy instead. Measured against Blink's own rendering:
   *   dominant-baseline:central == dy 0.32em   -> CP numbers, 0.35em
   *   dominant-baseline:middle  == dy 0.24em   -> rotated name labels
   * The matching dominant-baseline declarations were removed from app.css; do
   * not reinstate them or the offset is applied twice. */
  var CP_LABEL_DY = '0.35em';    /* centres the CP number inside its dot */
  var NAME_LABEL_DY = '0.24em';  /* centres a rotate(-90) label on its leader line */

  var EXTRA_DOT_R = 3.45;

  /* named peaks/cols/places along the route, between CPs.
   *   'peak'  — label only; the terrain's own summit shape is the marker
   *   'place' — a small dot plus a label, for spots that aren't the high point */
  var EXTRA_POINTS = [
    { type: 'peak',  d: 16.31,  alt: 1807, name: 'Bellevue' },
    { type: 'peak',  d: 46.13,  alt: 2484, name: 'Croix du Bonhomme' },
    { type: 'peak',  d: 62.31,  alt: 2509, name: 'Col de la Seigne' },
    { type: 'peak',  d: 64.96,  alt: 2571, name: 'Col des Pyramides Calcaires' },
    { type: 'peak',  d: 72.78,  alt: 2418, name: 'Arête du Mont Favre' },
    { type: 'peak',  d: 93.22,  alt: 2020, name: 'Refuge Bonatti' },
    { type: 'peak',  d: 104.61, alt: 2527, name: 'Grand Col Ferret' },
    { type: 'place', d: 139.99, alt: 1877, name: 'La Giete' },
    { type: 'place', d: 148.71, alt: 1925, name: 'Les Tseppes' }
  ];

  var built = false;
  var course = null;
  var V = null;
  var distMax = 0, altMin = 0, altMax = 0;

  var profSvg = null, profileWrap = null;
  var profScrollTrack = null, profScrollThumb = null;
  var sectionsG = null, secTooltip = null;
  var sectionNotesWrap = null, sectionNotesLabel = null, sectionNotesTa = null;

  var profView = { x: 0, w: PROF_W };
  var PROF_VIEW_MIN_W = PROF_W / 8;
  var LABEL_MAX_GROWTH = 0.8;   /* labels grow up to 80% larger at max zoom-in */

  var selectedSection = null;
  var trainingMode = false;

  /* Elements that must stay visually undistorted (not stretched into ellipses or
   * fat glyphs) as the viewBox narrows for zoom — each gets a counter scale-x
   * that exactly cancels the ambient horizontal stretch. el's transform must
   * start with translate(x,y) since applyProfView() overwrites the attribute. */
  var zoomStableEls = [];

  function registerZoomStable(el, x, y) {
    var entry = { el: el, x: x, y: y };
    zoomStableEls.push(entry);
    return entry;
  }

  function profX(km) {
    return PROF_PADL + (km / distMax) * (PROF_W - PROF_PADL - PROF_PADR);
  }

  function profY(alt) {
    return PROF_PADT + (1 - (alt - altMin) / (altMax - altMin)) * (PROF_H - PROF_PADT - PROF_PADB);
  }

  function sectionKey(s) {
    return s.from + '_' + s.to;
  }

  function cpColor(cp) {
    return UTMB.map.cpColor(cp);
  }

  function cpLabel(cp) {
    return UTMB.map.cpLabel(cp);
  }

  function cpShortName(cp) {
    return cp.name.replace(/\s*\((Start|Finish)\)/, '');
  }

  /* ── zoom / pan ───────────────────────────────────────────────────────────── */
  function clampProfView(v) {
    v.w = Math.max(PROF_VIEW_MIN_W, Math.min(PROF_W, v.w));
    v.x = Math.max(0, Math.min(PROF_W - v.w, v.x));
    return v;
  }

  function applyProfView() {
    profSvg.setAttribute('viewBox', profView.x.toFixed(2) + ' 0 ' + profView.w.toFixed(2) + ' ' + PROF_H);
    var sx = profView.w / PROF_W;
    var zoomT = Math.min(1, Math.max(0, (PROF_W - profView.w) / (PROF_W - PROF_VIEW_MIN_W)));
    var growth = 1 + LABEL_MAX_GROWTH * zoomT;
    zoomStableEls.forEach(function (e) {
      e.el.setAttribute('transform',
        'translate(' + e.x + ',' + e.y + ') scale(' + (sx * growth).toFixed(4) + ',' + growth.toFixed(4) + ')');
    });
    profScrollThumb.style.left = (profView.x / PROF_W) * 100 + '%';
    profScrollThumb.style.width = (profView.w / PROF_W) * 100 + '%';
    if (selectedSection !== null) renderSelection();
  }

  function profSvgXFromClient(clientX) {
    var rect = profSvg.getBoundingClientRect();
    return profView.x + ((clientX - rect.left) / rect.width) * profView.w;
  }

  function zoomProfileAt(factor, centerX) {
    if (!built) return;
    profView = clampProfView({ x: centerX - (centerX - profView.x) * factor, w: profView.w * factor });
    applyProfView();
  }

  function zoomProfile(factor) {
    if (!built) return;
    zoomProfileAt(factor, profView.x + profView.w / 2);
  }

  function resetProfZoom() {
    if (!built) return;
    profView = { x: 0, w: PROF_W };
    applyProfView();
  }

  function wireInteraction() {
    profileWrap.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomProfileAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, profSvgXFromClient(e.clientX));
    }, { passive: false });

    var profDragging = false, profDragStartX = null, profDragViewStartX = null;

    function profDragBegin(clientX) {
      profDragging = true;
      profDragStartX = clientX;
      profDragViewStartX = profView.x;
      profileWrap.classList.add('dragging');
    }

    function profDragMove(clientX) {
      if (!profDragging) return;
      var rect = profSvg.getBoundingClientRect();
      var dx = (clientX - profDragStartX) / rect.width * profView.w;
      profView = clampProfView({ x: profDragViewStartX - dx, w: profView.w });
      applyProfView();
    }

    function profDragEnd() {
      profDragging = false;
      profileWrap.classList.remove('dragging');
    }

    profileWrap.addEventListener('mousedown', function (e) { if (e.button === 0) profDragBegin(e.clientX); });
    window.addEventListener('mousemove', function (e) { if (profDragging) profDragMove(e.clientX); });
    window.addEventListener('mouseup', profDragEnd);

    var profLastTouchDist = null;
    profileWrap.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        profDragBegin(e.touches[0].clientX);
      } else if (e.touches.length === 2) {
        profDragging = false;
        profLastTouchDist = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
      }
    }, { passive: true });

    profileWrap.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1 && profDragging) {
        profDragMove(e.touches[0].clientX);
      } else if (e.touches.length === 2) {
        var d = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
        zoomProfileAt(profLastTouchDist / d,
          profSvgXFromClient((e.touches[0].clientX + e.touches[1].clientX) / 2));
        profLastTouchDist = d;
      }
    }, { passive: true });

    profileWrap.addEventListener('touchend', function () {
      profDragging = false;
      profLastTouchDist = null;
      profileWrap.classList.remove('dragging');
    });

    /* scrollbar — mirrors and controls profView */
    var thumbDragging = false, thumbStartX = null, thumbStartViewX = null;

    function thumbDragBegin(clientX) {
      thumbDragging = true;
      thumbStartX = clientX;
      thumbStartViewX = profView.x;
      profScrollThumb.classList.add('dragging');
    }

    function thumbDragMove(clientX) {
      if (!thumbDragging) return;
      var trackRect = profScrollTrack.getBoundingClientRect();
      var dx = (clientX - thumbStartX) / trackRect.width * PROF_W;
      profView = clampProfView({ x: thumbStartViewX + dx, w: profView.w });
      applyProfView();
    }

    function thumbDragEnd() {
      thumbDragging = false;
      profScrollThumb.classList.remove('dragging');
    }

    profScrollThumb.addEventListener('mousedown', function (e) { e.stopPropagation(); thumbDragBegin(e.clientX); });
    window.addEventListener('mousemove', function (e) { if (thumbDragging) thumbDragMove(e.clientX); });
    window.addEventListener('mouseup', thumbDragEnd);
    profScrollThumb.addEventListener('touchstart', function (e) { e.stopPropagation(); thumbDragBegin(e.touches[0].clientX); }, { passive: true });
    profScrollTrack.addEventListener('touchmove', function (e) { thumbDragMove(e.touches[0].clientX); }, { passive: true });
    profScrollTrack.addEventListener('touchend', thumbDragEnd);
    profScrollTrack.addEventListener('click', function (e) {
      if (e.target === profScrollThumb) return;
      var trackRect = profScrollTrack.getBoundingClientRect();
      var targetCenter = (e.clientX - trackRect.left) / trackRect.width * PROF_W;
      profView = clampProfView({ x: targetCenter - profView.w / 2, w: profView.w });
      applyProfView();
    });

    window.addEventListener('resize', function () { if (selectedSection !== null) renderSelection(); });
  }

  /* ── build ────────────────────────────────────────────────────────────────
   * opts: {course, onCpClick(cpId)} */
  function build(opts) {
    course = opts.course;
    V = course.viz;
    distMax = course.total_km;
    altMin = V.reduce(function (m, p) { return Math.min(m, p.a); }, Infinity);
    altMax = V.reduce(function (m, p) { return Math.max(m, p.a); }, -Infinity);

    profSvg = document.getElementById('profSvg');
    profileWrap = document.getElementById('profileWrap');
    profScrollTrack = document.getElementById('profScrollTrack');
    profScrollThumb = document.getElementById('profScrollThumb');
    secTooltip = document.getElementById('secTooltip');
    sectionNotesWrap = document.getElementById('sectionNotesWrap');
    sectionNotesLabel = document.getElementById('sectionNotesLabel');
    sectionNotesTa = document.getElementById('sectionNotesTa');
    if (!profSvg || !profileWrap) throw new Error('profile container (#profSvg / #profileWrap) missing from the page');

    built = true;
    applyProfView();

    /* gridlines + altitude axis labels */
    for (var a = 1000; a <= altMax; a += 500) {
      var gy = profY(a);
      var gl = document.createElementNS(SVGNS, 'line');
      gl.setAttribute('class', 'gridline');
      gl.setAttribute('x1', PROF_PADL);
      gl.setAttribute('x2', PROF_W - PROF_PADR);
      gl.setAttribute('y1', gy);
      gl.setAttribute('y2', gy);
      profSvg.appendChild(gl);

      var glg = document.createElementNS(SVGNS, 'g');
      glg.setAttribute('transform', 'translate(4,' + (gy + 3) + ')');
      var glbl = document.createElementNS(SVGNS, 'text');
      glbl.setAttribute('class', 'axis-label');
      glbl.setAttribute('x', 0);
      glbl.setAttribute('y', 0);
      glbl.textContent = a + 'm';
      glg.appendChild(glbl);
      profSvg.appendChild(glg);
      registerZoomStable(glg, 4, gy + 3);
    }

    /* distance labels — one per checkpoint, instead of even 25km ticks */
    var distLabelRefs = [];
    course.cps.forEach(function (cp) {
      var x = profX(cp.km);
      var anchor = cp.id === 'start' ? 'start' : cp.id === 'finish' ? 'end' : 'middle';
      var y = PROF_H - 8;
      var lg = document.createElementNS(SVGNS, 'g');
      lg.setAttribute('transform', 'translate(' + x + ',' + y + ')');
      var lbl = document.createElementNS(SVGNS, 'text');
      lbl.setAttribute('class', 'axis-label');
      lbl.setAttribute('x', 0);
      lbl.setAttribute('y', 0);
      lbl.setAttribute('text-anchor', anchor);
      lbl.textContent = cp.km.toFixed(1) + 'km';
      lg.appendChild(lbl);
      profSvg.appendChild(lg);
      var entry = registerZoomStable(lg, x, y);
      distLabelRefs.push({ cpId: cp.id, x: x, y: y, anchor: anchor, lbl: lbl, lg: lg, entry: entry });
    });

    /* checkpoints can sit as little as 5km apart (the U6/Courmayeur/U8 cluster),
     * too close for two "NN.Nkm" labels side by side at full zoom-out — bump the
     * closer one up onto a second row so they never overlap. distLabelRow is
     * consulted below when sizing each CP's leader-line guide. */
    var distLabelRow = {};
    (function () {
      var GAP = 4, ROW_H = 13;
      var rowRightEdge = [-Infinity, -Infinity];
      distLabelRefs.forEach(function (ref) {
        var w = ref.lbl.getComputedTextLength();
        var left = ref.anchor === 'start' ? ref.x : ref.anchor === 'end' ? ref.x - w : ref.x - w / 2;
        var row = (left > rowRightEdge[0] + GAP) ? 0 : 1;
        rowRightEdge[row] = left + w;
        distLabelRow[ref.cpId] = row;
        if (row === 1) {
          var y2 = ref.y - ROW_H;
          ref.lg.setAttribute('transform', 'translate(' + ref.x + ',' + y2 + ')');
          ref.entry.y = y2;
        }
      });
    })();

    /* section hit-areas (behind the area fill, so fill+line render on top) */
    var practice = UTMB.store.practice;
    var plan = UTMB.store.plan;
    sectionsG = document.createElementNS(SVGNS, 'g');
    profSvg.appendChild(sectionsG);
    var baseY = profY(altMin);
    course.sections.forEach(function (s, i) {
      var x1 = profX(V[s.viz_from].d);
      var x2 = profX(V[s.viz_to].d);
      var rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('class', 'section-hit');
      rect.setAttribute('x', x1);
      rect.setAttribute('y', PROF_PADT);
      rect.setAttribute('width', Math.max(0, x2 - x1));
      rect.setAttribute('height', PROF_H - PROF_PADT - PROF_PADB);
      rect.dataset.idx = i;
      if (practice[sectionKey(s)]) rect.classList.add('practice-done');
      else if (plan[sectionKey(s)]) rect.classList.add('practice-planned');
      rect.addEventListener('click', function () { toggleSection(i); });
      sectionsG.appendChild(rect);
    });

    /* area + line path */
    var areaD = 'M' + profX(V[0].d).toFixed(1) + ',' + baseY.toFixed(1) + ' ';
    V.forEach(function (p) { areaD += 'L' + profX(p.d).toFixed(1) + ',' + profY(p.a).toFixed(1) + ' '; });
    areaD += 'L' + profX(V[V.length - 1].d).toFixed(1) + ',' + baseY.toFixed(1) + ' Z';
    var areaEl = document.createElementNS(SVGNS, 'path');
    areaEl.setAttribute('class', 'area-fill');
    areaEl.setAttribute('d', areaD);
    profSvg.appendChild(areaEl);

    var lineD = '';
    V.forEach(function (p, i) { lineD += (i === 0 ? 'M' : 'L') + profX(p.d).toFixed(1) + ',' + profY(p.a).toFixed(1) + ' '; });
    var lineEl = document.createElementNS(SVGNS, 'path');
    lineEl.setAttribute('class', 'area-line');
    lineEl.setAttribute('d', lineD);
    profSvg.appendChild(lineEl);

    var cpGuideG = document.createElementNS(SVGNS, 'g');
    profSvg.appendChild(cpGuideG);
    var profMarkersG = document.createElementNS(SVGNS, 'g');
    profSvg.appendChild(profMarkersG);

    /* checkpoint markers, name labels, and the dashed guide down to the km row */
    course.cps.forEach(function (cp) {
      var vp = V[cp.viz_pos];
      var px = profX(vp.d), py = profY(vp.a);
      var pg = document.createElementNS(SVGNS, 'g');
      pg.setAttribute('class', 'cp-marker');
      pg.setAttribute('transform', 'translate(' + px + ',' + py + ')');
      pg.dataset.cp = cp.id;
      var nameOffset = PMK_RING + 4.6;
      pg.innerHTML =
        (cp.supporter ? '<circle class="ring" r="' + PMK_RING + '" stroke-width="' + PMK_RING_STROKE + '"/>' : '') +
        '<circle class="base" r="' + PMK_R + '" fill="' + cpColor(cp) + '" stroke-width="' + (PMK_R * 0.2) + '"/>' +
        '<text dy="' + CP_LABEL_DY + '" style="font-size:' + PMK_FONT + 'px">' + cpLabel(cp) + '</text>' +
        '<line class="cp-leader" x1="0" y1="' + PMK_RING + '" x2="0" y2="' + nameOffset + '"/>' +
        '<text class="cp-name" dy="' + NAME_LABEL_DY + '" transform="translate(0,' + nameOffset + ') rotate(-90)">' +
        cpShortName(cp) + '</text>';
      pg.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof opts.onCpClick === 'function') opts.onCpClick(cp.id);
      });
      profMarkersG.appendChild(pg);
      registerZoomStable(pg, px, py);

      /* dashed guide from the bottom of the name label down to the km row,
       * stopped short of both bits of text at either end */
      var nameLen = pg.querySelector('text.cp-name').getComputedTextLength();
      var guideTop = py + nameOffset + nameLen + 4;
      var guideBottom = (distLabelRow[cp.id] === 1 ? PROF_H - 8 - 13 : PROF_H - 8) - 10;
      if (guideTop < guideBottom) {
        var guide = document.createElementNS(SVGNS, 'line');
        guide.setAttribute('class', 'cp-guide');
        guide.setAttribute('x1', px);
        guide.setAttribute('x2', px);
        guide.setAttribute('y1', guideTop);
        guide.setAttribute('y2', guideBottom);
        cpGuideG.appendChild(guide);
      }
    });

    /* extra landmarks — both types grow upward off the terrain, first letter
     * nearest the point: same rotate(-90) as the CP-name labels, just anchored
     * at the string's start instead of its end. */
    var extraG = document.createElementNS(SVGNS, 'g');
    profSvg.appendChild(extraG);
    EXTRA_POINTS.forEach(function (p) {
      var x = profX(p.d), y = profY(p.alt);
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'extra-marker ' + p.type);
      g.setAttribute('transform', 'translate(' + x + ',' + y + ')');
      var isPlace = p.type === 'place';
      var nameOffset = isPlace ? EXTRA_DOT_R + 4.6 : 6.9;
      g.innerHTML = (isPlace ? '<circle class="extra-dot" r="' + EXTRA_DOT_R + '"/>' : '') +
        '<text class="extra-label" dy="' + NAME_LABEL_DY + '" transform="translate(0,' + (-nameOffset) + ') rotate(-90)">' +
        p.name + ' · ' + p.alt + 'm</text>';
      extraG.appendChild(g);
      registerZoomStable(g, x, y);
    });

    /* iOS FIX: the section-notes textarea sits at the bottom of a tall panel,
     * so the software keyboard covers it the moment it is focused. Scroll it
     * back into view once the keyboard has finished animating in, and again
     * whenever the visual viewport changes size underneath it (keyboard open /
     * close, accessory bar, predictive-text row). */
    var revealTimer = null;
    function revealNotes() {
      clearTimeout(revealTimer);
      revealTimer = setTimeout(function () {
        if (document.activeElement !== sectionNotesTa) return;
        try {
          sectionNotesTa.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        } catch (err) {
          sectionNotesTa.scrollIntoView(false);
        }
      }, 300);
    }
    sectionNotesTa.addEventListener('focus', revealNotes);
    if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
      window.visualViewport.addEventListener('resize', function () {
        if (document.activeElement === sectionNotesTa) revealNotes();
      });
    }

    /* section notes textarea */
    var sectionNoteTimer = null;
    sectionNotesTa.addEventListener('input', function (e) {
      if (selectedSection === null) return;
      var key = sectionKey(course.sections[selectedSection]);
      var v = e.target.value;
      if (v) UTMB.store.sectionNotes[key] = v;
      else delete UTMB.store.sectionNotes[key];
      UTMB.store.markDirty();
      clearTimeout(sectionNoteTimer);
      sectionNoteTimer = setTimeout(function () { UTMB.store.saveSectionNotes(); }, 400);
    });

    applyProfView();
    wireInteraction();

    return UTMB.profile;
  }

  /* ── section selection ───────────────────────────────────────────────────── */
  function toggleSection(i) {
    selectedSection = (selectedSection === i) ? null : i;
    renderSelection();
    if (selectedSection === null) {
      UTMB.emit('section:clear', {});
    } else {
      var s = course.sections[selectedSection];
      UTMB.emit('section:select', { index: selectedSection, section: s, from: s.from, to: s.to });
    }
  }

  function renderSelection() {
    document.querySelectorAll('.section-hit').forEach(function (el) { el.classList.remove('selected'); });
    if (selectedSection === null) {
      UTMB.map.clearHighlight();
      secTooltip.style.display = 'none';
      sectionNotesWrap.style.display = 'none';
      return;
    }
    var s = course.sections[selectedSection];
    sectionsG.children[selectedSection].classList.add('selected');

    UTMB.map.highlightRange(s.viz_from, s.viz_to);

    var x1 = profX(V[s.viz_from].d), x2 = profX(V[s.viz_to].d);
    var peakAlt = -Infinity;
    for (var i = s.viz_from; i <= s.viz_to; i++) peakAlt = Math.max(peakAlt, V[i].a);
    var tipX = (x1 + x2) / 2;
    var tipY = profY(peakAlt);

    var fromName = course.cps.find(function (c) { return c.id === s.from; }).name;
    var toName = course.cps.find(function (c) { return c.id === s.to; }).name;
    var isDone = !!UTMB.store.practice[sectionKey(s)];
    var isPlanned = !!UTMB.store.plan[sectionKey(s)];

    secTooltip.innerHTML =
      '<b>' + fromName + ' → ' + toName + '</b><br>' + s.dist_km + ' km · ' +
      '<span style="color:#4ade80">+' + s.gain + ' m</span> / ' +
      '<span style="color:#f87171">−' + s.loss + ' m</span>' +
      '<div class="sec-practice-row" onclick="UTMB.profile.togglePracticeDone(' + selectedSection + ')">' +
      '<span class="practice-check' + (isDone ? ' checked' : '') + '">' + (isDone ? '✓' : '') + '</span> Practice run done</div>' +
      '<div class="sec-practice-row" onclick="UTMB.profile.togglePracticePlanned(' + selectedSection + ')">' +
      '<span class="practice-check plan' + (isPlanned ? ' checked' : '') + '">' + (isPlanned ? '✓' : '') + '</span> Practice run planned</div>';
    secTooltip.style.display = 'block';
    positionTooltip(tipX, tipY);

    sectionNotesLabel.textContent = 'Notes for ' + fromName + ' → ' + toName;
    sectionNotesTa.value = UTMB.store.sectionNotes[sectionKey(s)] || '';
    sectionNotesWrap.style.display = 'block';
  }

  function positionTooltip(svgX, svgY) {
    var rect = profSvg.getBoundingClientRect();
    var wrapRect = profileWrap.getBoundingClientRect();
    var scaleX = rect.width / profView.w, scaleY = rect.height / PROF_H;
    var left = ((svgX - profView.x) * scaleX) + (rect.left - wrapRect.left);
    var top = (svgY * scaleY) + (rect.top - wrapRect.top);
    secTooltip.style.left = left + 'px';
    secTooltip.style.top = Math.max(top - 8, 10) + 'px';
  }

  /* ── training status (practice-run tracking) ──────────────────────────────
   * "done" always overrides "planned" for the highlight colour — a section
   * that's both planned and actually run shows green, never yellow — so only one
   * of the two classes is ever applied, regardless of stylesheet rule order. */
  function refreshSectionStatusClass(i) {
    var key = sectionKey(course.sections[i]);
    var el = sectionsG.children[i];
    var done = !!UTMB.store.practice[key], planned = !!UTMB.store.plan[key];
    el.classList.toggle('practice-done', done);
    el.classList.toggle('practice-planned', planned && !done);
  }

  function togglePracticeDone(i) {
    if (!built) return;
    var key = sectionKey(course.sections[i]);
    if (UTMB.store.practice[key]) delete UTMB.store.practice[key];
    else UTMB.store.practice[key] = true;
    refreshSectionStatusClass(i);
    UTMB.store.markDirty();
    UTMB.store.savePractice();
    renderSelection();
  }

  function togglePracticePlanned(i) {
    if (!built) return;
    var key = sectionKey(course.sections[i]);
    if (UTMB.store.plan[key]) delete UTMB.store.plan[key];
    else UTMB.store.plan[key] = true;
    refreshSectionStatusClass(i);
    UTMB.store.markDirty();
    UTMB.store.savePlan();
    renderSelection();
  }

  function setTrainingMode(on) {
    trainingMode = !!on;
    document.body.classList.toggle('training-mode', trainingMode);
    var btn = document.getElementById('trainingToggleBtn');
    if (btn) btn.classList.toggle('active', trainingMode);
    if (built && selectedSection !== null) {
      selectedSection = null;
      renderSelection();
      UTMB.emit('section:clear', {});
    }
    UTMB.emit('training:mode', trainingMode);
  }

  function toggleTrainingMode() {
    setTrainingMode(!trainingMode);
  }

  UTMB.profile = {
    build: build,
    isBuilt: function () { return built; },
    profX: function (km) { return built ? profX(km) : 0; },
    profY: function (alt) { return built ? profY(alt) : 0; },
    sectionKey: sectionKey,
    selectSection: function (i) { if (built && selectedSection !== i) toggleSection(i); },
    clearSelection: function () { if (built && selectedSection !== null) toggleSection(selectedSection); },
    getSelected: function () {
      return selectedSection === null ? null : { index: selectedSection, section: course.sections[selectedSection] };
    },
    refresh: function () { if (built) renderSelection(); },
    togglePracticeDone: togglePracticeDone,
    togglePracticePlanned: togglePracticePlanned,
    toggleTrainingMode: toggleTrainingMode,
    setTrainingMode: setTrainingMode,
    isTrainingMode: function () { return trainingMode; },
    zoomProfile: zoomProfile,
    zoomProfileAt: zoomProfileAt,
    resetProfZoom: resetProfZoom,
    getView: function () { return { x: profView.x, w: profView.w }; },
    EXTRA_POINTS: EXTRA_POINTS,
    DIMS: { W: PROF_W, H: PROF_H, PADL: PROF_PADL, PADR: PROF_PADR, PADT: PROF_PADT, PADB: PROF_PADB }
  };
})(window.UTMB);
