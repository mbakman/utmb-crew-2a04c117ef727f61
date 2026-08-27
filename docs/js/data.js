/* data.js — async loaders for the JSON payloads that used to be inlined in the
 * single-file build.
 *
 *   course.json      COURSE  {total_km, total_gain, total_loss, cps[], sections[], viz[]}
 *   topo-meta.json   TOPO    {zoom, txmin, tymin, w, h}  (the image itself is topo.jpg)
 *   shuttles.json    crew shuttle timetable  (consumed by transport.js)
 *   checklists.json  per-checkpoint crew checklists  (consumed by checklist.js)
 *
 * Every loader caches its promise, so calling loadShuttles() from three modules
 * still results in exactly one network request.
 */
window.UTMB = window.UTMB || {};

(function (UTMB) {
  'use strict';

  var PATHS = {
    course: 'course.json',
    topo: 'topo-meta.json',
    shuttles: 'shuttles.json',
    checklists: 'checklists.json'
  };

  var cache = Object.create(null);

  function fetchJSON(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) {
        throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' for ' + url);
      }
      return res.json();
    });
  }

  function load(name) {
    if (!PATHS[name]) return Promise.reject(new Error('unknown data set "' + name + '"'));
    if (!cache[name]) {
      cache[name] = fetchJSON(PATHS[name]).catch(function (err) {
        /* Let the next caller retry rather than caching a failure forever. */
        delete cache[name];
        throw err;
      });
    }
    return cache[name];
  }

  /* Optional payloads: a missing shuttles.json must not take the map down. */
  function loadOptional(name) {
    return load(name).catch(function (err) {
      console.warn('[UTMB] optional data set "' + name + '" unavailable', err);
      return null;
    });
  }

  function validateCourse(course) {
    if (!course || !Array.isArray(course.cps) || !Array.isArray(course.sections) || !Array.isArray(course.viz)) {
      throw new Error('course.json is missing cps/sections/viz');
    }
    if (!course.viz.length) throw new Error('course.json has an empty viz track');
    return course;
  }

  function validateTopo(topo) {
    if (!topo || typeof topo.zoom !== 'number' || typeof topo.w !== 'number' || typeof topo.h !== 'number') {
      throw new Error('topo-meta.json is missing zoom/txmin/tymin/w/h');
    }
    return topo;
  }

  UTMB.data = {
    PATHS: PATHS,
    TOPO_IMAGE: 'topo.jpg',

    loadCourse: function () { return load('course').then(validateCourse); },
    loadTopo: function () { return load('topo').then(validateTopo); },
    loadShuttles: function () { return load('shuttles'); },
    loadChecklists: function () { return load('checklists'); },

    /* Course + topo are required (the app is nothing without them); shuttles and
     * checklists resolve to null if they fail so the core still renders. */
    loadAll: function () {
      return Promise.all([
        this.loadCourse(),
        this.loadTopo(),
        loadOptional('shuttles'),
        loadOptional('checklists')
      ]).then(function (r) {
        return { course: r[0], topo: r[1], shuttles: r[2], checklists: r[3] };
      });
    }
  };
})(window.UTMB);
