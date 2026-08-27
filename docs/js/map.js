/* map.js — course map: Web Mercator projection onto the stitched OpenTopoMap
 * basemap, route paths, checkpoint markers, and viewBox zoom/pan.
 *
 * Ported from the single-file build. The one behavioural change: the basemap is
 * loaded from topo.jpg instead of a 2.8 MB base64 data: URI baked into the page.
 *
 * Public API (all no-ops before build()):
 *   UTMB.map.build({course, topo, onCpClick})
 *   UTMB.map.mapXY(lat, lon) -> [x, y]        image-pixel coords
 *   UTMB.map.routePathD(fromPos, toPos)       SVG path data for a viz range
 *   UTMB.map.highlightRange(fromPos, toPos)   red overlay on a section
 *   UTMB.map.clearHighlight()
 *   UTMB.map.zoomBtn(factor) / zoomAt(factor, clientX, clientY) / resetView()
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  var XLINKNS = 'http://www.w3.org/1999/xlink';

  var SUPPORT_COLOR = {
    water: 'var(--water)',
    food: 'var(--food)',
    hotmeal: 'var(--hotmeal)'
  };

  /* Vertical centring for the checkpoint number inside its dot. Shared with
   * profile.js, which draws the same marker. See app.css .cp-marker text. */
  var CP_LABEL_DY = '0.35em';

  /* Manual double-tap: iOS does not fire dblclick dependably (and never does
   * once touch-action:none suppresses the native double-tap gesture), so two
   * taps inside these bounds are treated as one. */
  var DBLTAP_MS = 300;
  var DBLTAP_PX = 30;

  var built = false;
  var course = null;
  var topo = null;
  var V = null;
  var TILE_N = 0;

  var mapSvg = null;
  var mapWrap = null;
  var mapMarkersG = null;
  var highlightRouteEl = null;

  /* fit box — the initial view, the whole route plus a 16% margin */
  var fitX = 0, fitY = 0, fitW = 0, fitH = 0;
  var view = { x: 0, y: 0, w: 0, h: 0 };
  var VIEW_MIN_W = 0, VIEW_MAX_W = 0;

  /* ── projection ───────────────────────────────────────────────────────────
   * Web Mercator pixel coords at TOPO.zoom, shifted so that the top-left tile
   * of the stitched image is the origin. */
  function mapXY(lat, lon) {
    var latRad = lat * Math.PI / 180;
    var px = (lon + 180) / 360 * TILE_N - topo.txmin * 256;
    var py = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * TILE_N - topo.tymin * 256;
    return [px, py];
  }

  function routePathD(fromPos, toPos) {
    var d = '';
    for (var i = fromPos; i <= toPos; i++) {
      var p = mapXY(V[i].lat, V[i].lon);
      d += (i === fromPos ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ' ';
    }
    return d;
  }

  function cpColor(cp) {
    return cp.support ? SUPPORT_COLOR[cp.support] : '#9ca3af';
  }

  function cpLabel(cp) {
    if (cp.id === 'start') return 'S';
    if (cp.id === 'finish') return 'F';
    return cp.id.replace('U', '');
  }

  /* ── viewBox zoom / pan ──────────────────────────────────────────────────── */
  function clampView(v) {
    v.w = Math.max(VIEW_MIN_W, Math.min(VIEW_MAX_W, v.w));
    v.h = v.w * (fitH / fitW);
    var marginX = Math.min(topo.w * 0.06, v.w * 0.3);
    var marginY = Math.min(topo.h * 0.06, v.h * 0.3);
    v.x = Math.max(-marginX, Math.min(topo.w + marginX - v.w, v.x));
    v.y = Math.max(-marginY, Math.min(topo.h + marginY - v.h, v.y));
    return v;
  }

  function applyView() {
    mapSvg.setAttribute('viewBox',
      view.x.toFixed(1) + ' ' + view.y.toFixed(1) + ' ' + view.w.toFixed(1) + ' ' + view.h.toFixed(1));
  }

  function resetView() {
    if (!built) return;
    view = { x: fitX, y: fitY, w: fitW, h: fitH };
    applyView();
  }

  function svgPointFromClient(clientX, clientY) {
    var rect = mapSvg.getBoundingClientRect();
    var relX = (clientX - rect.left) / rect.width;
    var relY = (clientY - rect.top) / rect.height;
    return { x: view.x + relX * view.w, y: view.y + relY * view.h, relX: relX, relY: relY };
  }

  function zoomAt(factor, clientX, clientY) {
    if (!built) return;
    var pt = svgPointFromClient(clientX, clientY);
    var newW = view.w * factor;
    var newH = view.h * factor;
    view = clampView({
      x: pt.x - pt.relX * newW,
      y: pt.y - pt.relY * newH,
      w: newW,
      h: newH
    });
    applyView();
  }

  function zoomBtn(factor) {
    if (!built) return;
    var rect = mapSvg.getBoundingClientRect();
    zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function touchDist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }

  function wireInteraction() {
    mapWrap.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });

    var dragging = false;
    var dragStart = null;
    var dragViewStart = null;

    function dragBegin(clientX, clientY) {
      dragging = true;
      mapSvg.classList.add('dragging');
      dragStart = { x: clientX, y: clientY };
      dragViewStart = { x: view.x, y: view.y, w: view.w, h: view.h };
    }

    function dragMove(clientX, clientY) {
      if (!dragging) return;
      var rect = mapSvg.getBoundingClientRect();
      var dx = (clientX - dragStart.x) / rect.width * view.w;
      var dy = (clientY - dragStart.y) / rect.height * view.h;
      view = clampView({ x: dragViewStart.x - dx, y: dragViewStart.y - dy, w: view.w, h: view.h });
      applyView();
    }

    function dragEnd() {
      dragging = false;
      mapSvg.classList.remove('dragging');
    }

    mapWrap.addEventListener('mousedown', function (e) { if (e.button === 0) dragBegin(e.clientX, e.clientY); });
    window.addEventListener('mousemove', function (e) { if (dragging) dragMove(e.clientX, e.clientY); });
    window.addEventListener('mouseup', dragEnd);

    var lastTouchDist = null;
    mapWrap.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        dragBegin(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        dragging = false;
        lastTouchDist = touchDist(e.touches);
      }
    }, { passive: true });

    mapWrap.addEventListener('touchmove', function (e) {
      if (e.touches.length === 1 && dragging) {
        dragMove(e.touches[0].clientX, e.touches[0].clientY);
      } else if (e.touches.length === 2) {
        var d = touchDist(e.touches);
        var factor = lastTouchDist / d;
        var cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        var cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        zoomAt(factor, cx, cy);
        lastTouchDist = d;
      }
    }, { passive: true });

    mapWrap.addEventListener('touchend', function () {
      dragging = false;
      lastTouchDist = null;
    });

    /* ── double-tap to zoom ──────────────────────────────────────────────────
     * iOS FIX: dblclick does not fire reliably on iOS, so the touch path gets
     * its own detector — two touchend events within DBLTAP_MS and DBLTAP_PX of
     * each other. Deliberately a SEPARATE passive listener: the drag/pinch
     * handling above is correct as it stands and is left untouched.
     *
     * lastTapAt also suppresses the dblclick handler for a moment afterwards,
     * because a browser that *does* synthesise dblclick from the same two taps
     * would otherwise zoom twice. */
    var lastTapAt = 0;
    var lastTapX = 0, lastTapY = 0;
    var handledTapZoomAt = 0;

    mapWrap.addEventListener('touchend', function (e) {
      /* Only a clean single-finger tap counts: no second finger still down (a
       * pinch) and no multi-finger lift. */
      if (!e.changedTouches || e.changedTouches.length !== 1) return;
      if (e.touches && e.touches.length !== 0) return;

      var t = e.changedTouches[0];
      var now = Date.now();

      if (now - lastTapAt < DBLTAP_MS &&
          Math.abs(t.clientX - lastTapX) < DBLTAP_PX &&
          Math.abs(t.clientY - lastTapY) < DBLTAP_PX) {
        handledTapZoomAt = now;
        lastTapAt = 0;                       /* a third tap starts a new pair */
        zoomAt(1 / 1.6, t.clientX, t.clientY);
        return;
      }

      lastTapAt = now;
      lastTapX = t.clientX;
      lastTapY = t.clientY;
    }, { passive: true });

    mapWrap.addEventListener('dblclick', function (e) {
      if (Date.now() - handledTapZoomAt < 700) return;   /* already zoomed on touchend */
      zoomAt(1 / 1.6, e.clientX, e.clientY);
    });
  }

  /* ── build ────────────────────────────────────────────────────────────────
   * opts: {course, topo, onCpClick(cpId), imageUrl} */
  function build(opts) {
    course = opts.course;
    topo = opts.topo;
    V = course.viz;
    TILE_N = Math.pow(2, topo.zoom) * 256;

    mapSvg = document.getElementById('mapSvg');
    mapWrap = document.getElementById('mapWrap');
    if (!mapSvg || !mapWrap) throw new Error('map container (#mapSvg / #mapWrap) missing from the page');

    var imageUrl = opts.imageUrl || (UTMB.data && UTMB.data.TOPO_IMAGE) || 'topo.jpg';

    /* route extent in image pixels, then the padded fit box */
    var routeXs = [];
    var routeYs = [];
    for (var i = 0; i < V.length; i++) {
      var pt = mapXY(V[i].lat, V[i].lon);
      routeXs.push(pt[0]);
      routeYs.push(pt[1]);
    }
    var routeMinX = Math.min.apply(null, routeXs);
    var routeMaxX = Math.max.apply(null, routeXs);
    var routeMinY = Math.min.apply(null, routeYs);
    var routeMaxY = Math.max.apply(null, routeYs);
    var routeW = routeMaxX - routeMinX;
    var routeH = routeMaxY - routeMinY;
    var FIT_PAD = 0.16;
    fitW = routeW * (1 + FIT_PAD * 2);
    fitH = routeH * (1 + FIT_PAD * 2);
    fitX = routeMinX - routeW * FIT_PAD;
    fitY = routeMinY - routeH * FIT_PAD;

    VIEW_MIN_W = fitW / 7;        /* max zoom-in  */
    VIEW_MAX_W = topo.w * 1.02;   /* max zoom-out (~whole stitched image) */

    /* marker / stroke sizing, scaled off the initial fit width so it reads well
     * at default zoom */
    var MK_R = fitW * 0.013;
    var MK_RING = fitW * 0.019;
    var MK_FONT = fitW * 0.017;
    var STROKE_ROUTE = fitW * 0.0035;
    var STROKE_HALO = STROKE_ROUTE * 2.2;
    var STROKE_HI = STROKE_ROUTE * 2.8;
    var MK_RING_STROKE = MK_R * 0.42;

    /* basemap */
    var bgImg = document.createElementNS(SVGNS, 'image');
    bgImg.setAttributeNS(XLINKNS, 'href', imageUrl);
    bgImg.setAttribute('href', imageUrl);
    bgImg.setAttribute('x', 0);
    bgImg.setAttribute('y', 0);
    bgImg.setAttribute('width', topo.w);
    bgImg.setAttribute('height', topo.h);
    bgImg.setAttribute('preserveAspectRatio', 'none');
    mapSvg.appendChild(bgImg);

    var fullD = routePathD(0, V.length - 1);

    var haloRouteEl = document.createElementNS(SVGNS, 'path');
    haloRouteEl.setAttribute('class', 'route-halo');
    haloRouteEl.setAttribute('stroke-width', STROKE_HALO);
    haloRouteEl.setAttribute('d', fullD);
    mapSvg.appendChild(haloRouteEl);

    var fullRouteEl = document.createElementNS(SVGNS, 'path');
    fullRouteEl.setAttribute('class', 'route-line');
    fullRouteEl.setAttribute('stroke-width', STROKE_ROUTE);
    fullRouteEl.setAttribute('d', fullD);
    mapSvg.appendChild(fullRouteEl);

    highlightRouteEl = document.createElementNS(SVGNS, 'path');
    highlightRouteEl.setAttribute('class', 'route-highlight');
    highlightRouteEl.setAttribute('stroke-width', STROKE_HI);
    highlightRouteEl.style.display = 'none';
    mapSvg.appendChild(highlightRouteEl);

    mapMarkersG = document.createElementNS(SVGNS, 'g');
    mapSvg.appendChild(mapMarkersG);

    /* checkpoint markers, sized in image-pixel units so they stay proportional
     * as the viewBox zooms */
    course.cps.forEach(function (cp) {
      var vp = V[cp.viz_pos];
      var p = mapXY(vp.lat, vp.lon);
      var g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('class', 'cp-marker');
      g.setAttribute('transform', 'translate(' + p[0] + ',' + p[1] + ')');
      g.dataset.cp = cp.id;
      g.innerHTML =
        (cp.supporter ? '<circle class="ring" r="' + MK_RING + '" stroke-width="' + MK_RING_STROKE + '"/>' : '') +
        '<circle class="base" r="' + MK_R + '" fill="' + cpColor(cp) + '" stroke-width="' + (MK_R * 0.25) + '"/>' +
        /* iOS FIX (WebKit bug 139258): dominant-baseline:central is unreliable in
         * Mobile Safari and would leave every checkpoint number sitting off its
         * dot. dy is a plain geometry attribute that every engine honours the
         * same way, so the vertical centring is done here instead; text-anchor
         * :middle still comes from .cp-marker text in app.css. */
        '<text dy="' + CP_LABEL_DY + '" style="font-size:' + MK_FONT + 'px">' + cpLabel(cp) + '</text>';
      g.addEventListener('click', function (e) {
        e.stopPropagation();
        if (typeof opts.onCpClick === 'function') opts.onCpClick(cp.id);
      });
      mapMarkersG.appendChild(g);
    });

    built = true;
    resetView();
    wireInteraction();

    return UTMB.map;
  }

  function highlightRange(fromPos, toPos) {
    if (!built) return;
    highlightRouteEl.setAttribute('d', routePathD(fromPos, toPos));
    highlightRouteEl.style.display = '';
  }

  function clearHighlight() {
    if (!built) return;
    highlightRouteEl.style.display = 'none';
  }

  UTMB.map = {
    build: build,
    isBuilt: function () { return built; },
    mapXY: function (lat, lon) { return built ? mapXY(lat, lon) : [0, 0]; },
    routePathD: function (a, b) { return built ? routePathD(a, b) : ''; },
    highlightRange: highlightRange,
    clearHighlight: clearHighlight,
    zoomAt: zoomAt,
    zoomBtn: zoomBtn,
    resetView: resetView,
    getView: function () { return { x: view.x, y: view.y, w: view.w, h: view.h }; },
    getFit: function () { return { x: fitX, y: fitY, w: fitW, h: fitH }; },
    svg: function () { return mapSvg; },
    SUPPORT_COLOR: SUPPORT_COLOR,
    cpColor: cpColor,
    cpLabel: cpLabel
  };
})(window.UTMB);
