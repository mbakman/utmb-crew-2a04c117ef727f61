/* sw.js — offline service worker for the UTMB 2026 crew app.
 *
 * Registered by main.js (registerServiceWorker(), on window 'load', scope
 * "./"). Nothing outside this file needs to change to ship an update.
 *
 * Contract this worker implements
 * ------------------------------------------------------------------
 *  - Precaches every asset the app ships on 'install', so the very first
 *    online visit is the only one that ever needs a network.
 *  - Serves cache-first. The app has zero external dependencies and no
 *    server to talk to, so once precached it runs in airplane mode.
 *  - Navigations fall back to the cached index.html, which is what keeps a
 *    shared deep link working offline: the "#s=..." fragment is never sent
 *    to the worker (fragments are client-side only), so any in-scope
 *    navigation resolves to the app shell and share.js reads the hash from
 *    location once the page is up.
 *  - Versioned cache. Bumping CACHE_VERSION makes 'install' refetch every
 *    asset into a brand new cache, and 'activate' evicts the old cache
 *    entries via the Cache API. (Cache eviction, not file deletion.)
 *  - skipWaiting() + clients.claim().
 *
 * Why skipWaiting()/claim() is safe here even though it can normally mix an
 * old page's JS with new data files: this app loads all nine of its scripts
 * from <script> tags and fetches all four JSON payloads during boot, and the
 * worker is only registered on window 'load' — i.e. after that boot has
 * already run. On a first-ever visit the claim therefore lands after every
 * asset is in memory, and on every later visit the worker is already active
 * and controlling the page from the first byte, so a single page load is
 * always served entirely out of one CACHE_VERSION. Nothing in the app
 * lazy-loads code after boot.
 *
 * DEPLOY CHECKLIST: bump CACHE_VERSION whenever any file in docs/ changes,
 * and keep REQUIRED_ASSETS / OPTIONAL_ASSETS in step with the contents of
 * docs/. A path listed here that does not exist on the server makes the
 * install fail (required) or leaves a hole in the offline app (optional).
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Cache identity
 * ------------------------------------------------------------------ */

var CACHE_PREFIX = 'utmb-crew';
var CACHE_VERSION = 'v2';
var CACHE_NAME = CACHE_PREFIX + '-' + CACHE_VERSION;

/* Everything is resolved against the directory this worker lives in, so the
 * same file works at a domain root, under /utmb-crew/, or under
 * /utmb-crew/docs/ on GitHub Pages without edits. */
var SCOPE_URL = new URL('./', self.location.href);

function abs(path) {
  return new URL(path, SCOPE_URL).href;
}

/* ------------------------------------------------------------------ *
 * Precache manifest — mirrors the real contents of docs/
 * ------------------------------------------------------------------ */

/* Without any one of these the app cannot render at all, so a failure here
 * aborts the install: the worker does not activate, the previous version (if
 * any) keeps serving, and the browser retries on the next page load. Better
 * a retry than a half-cached worker that looks installed and dies on the
 * mountain. */
var REQUIRED_ASSETS = [
  './',
  'index.html',

  'css/app.css',
  'css/checklist.css',
  'css/share.css',

  'js/store.js',
  'js/data.js',
  'js/map.js',
  'js/profile.js',
  'js/drawer.js',
  'js/checklist.js',
  'js/share.js',
  'js/transport.js',
  'js/main.js',

  'course.json',
  'topo-meta.json'
];

/* Degrade rather than abort. topo.jpg is 2.1 MB and by far the most likely
 * fetch to die on a hotel wifi; losing it costs the map its background but
 * leaves the route, the profile, the checkpoints and the notes intact.
 * data.js already treats shuttles.json / checklists.json as optional. Any of
 * these that misses install is picked up by the runtime cache in the fetch
 * handler the next time the app is opened with a signal. */
var OPTIONAL_ASSETS = [
  'shuttles.json',
  'checklists.json',
  'topo.jpg',

  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png'
];

var INDEX_URL = abs('index.html');
var ROOT_URL = abs('./');

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/* Promise.allSettled is not available on every browser that supports service
 * workers (Safari shipped SW in 11.3, allSettled in 13), so settle by hand. */
function settle(promise) {
  return promise.then(
    function (value) { return { ok: true, value: value }; },
    function (reason) { return { ok: false, reason: reason }; }
  );
}

/* cache: 'reload' skips the HTTP cache, so bumping CACHE_VERSION really does
 * pull fresh bytes instead of whatever GitHub Pages last handed the browser.
 * Falls back to a plain request if RequestCache is unsupported. */
function precacheRequest(url) {
  try {
    return new Request(url, { cache: 'reload', credentials: 'same-origin' });
  } catch (err) {
    return new Request(url, { credentials: 'same-origin' });
  }
}

function precacheOne(cache, path) {
  var url = abs(path);
  return fetch(precacheRequest(url)).then(function (res) {
    if (!res || !res.ok) {
      throw new Error('HTTP ' + (res ? res.status : 'no response') + ' for ' + path);
    }
    /* Key on the resolved URL string so cache.match(request) finds it. */
    return cache.put(url, res).then(function () { return path; });
  });
}

function precacheAll(cache, paths) {
  return Promise.all(paths.map(function (path) {
    return settle(precacheOne(cache, path).then(
      function () { return path; },
      function (err) { throw new Error(path + ': ' + (err && err.message ? err.message : err)); }
    ));
  }));
}

function failuresOf(results) {
  var out = [];
  for (var i = 0; i < results.length; i++) {
    if (!results[i].ok) {
      out.push(String(results[i].reason && results[i].reason.message || results[i].reason));
    }
  }
  return out;
}

function isCacheableResponse(res) {
  return !!res &&
    res.ok &&
    res.status === 200 &&
    /* 'basic' == same-origin. We never touch cross-origin; there is none. */
    (res.type === 'basic' || res.type === 'default');
}

function offlineShellResponse() {
  var body =
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>UTMB 2026 — offline</title><style>' +
    'html,body{margin:0;height:100%;background:#0f0f0f;color:#e5e7eb;' +
    'font-family:-apple-system,"Avenir Next","Helvetica Neue",sans-serif;' +
    'display:flex;align-items:center;justify-content:center;text-align:center}' +
    'div{padding:24px;max-width:30em}h1{font-size:20px;color:#60a5fa;margin:0 0 12px}' +
    'p{font-size:15px;line-height:1.5;margin:0;color:#9ca3af}</style></head><body><div>' +
    '<h1>UTMB 2026 Crew</h1>' +
    '<p>This device has no signal and the app has not finished caching yet. ' +
    'Open it once with a connection and it will work offline from then on.</p>' +
    '</div></body></html>';
  return new Response(body, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* ------------------------------------------------------------------ *
 * install — precache everything
 * ------------------------------------------------------------------ */

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return precacheAll(cache, REQUIRED_ASSETS).then(function (results) {
        var failed = failuresOf(results);
        if (failed.length) {
          /* Abort the install. The old worker (if any) keeps serving and the
           * browser retries this install on a later page load. */
          throw new Error(
            'precache aborted, ' + failed.length + ' required asset(s) missing: ' +
            failed.join(' | ')
          );
        }
        return precacheAll(cache, OPTIONAL_ASSETS);
      }).then(function (results) {
        var failed = failuresOf(results);
        if (failed.length) {
          console.warn(
            '[UTMB sw] ' + CACHE_NAME + ' installed WITHOUT ' + failed.length +
            ' optional asset(s); they will be cached on the next online visit: ' +
            failed.join(' | ')
          );
        } else {
          console.log('[UTMB sw] ' + CACHE_NAME + ' precached ' +
            (REQUIRED_ASSETS.length + OPTIONAL_ASSETS.length) + ' entries; full offline ready.');
        }
        return self.skipWaiting();
      });
    })
  );
});

/* ------------------------------------------------------------------ *
 * activate — evict old cache entries, take over open pages
 * ------------------------------------------------------------------ */

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME && key.lastIndexOf(CACHE_PREFIX + '-', 0) === 0) {
          console.log('[UTMB sw] evicting stale cache ' + key);
          return caches.delete(key);
        }
        return Promise.resolve(false);
      }));
    }).then(function () {
      /* We answer every navigation out of the cache, so a preload response
       * would only ever be discarded. */
      if (self.registration.navigationPreload) {
        return self.registration.navigationPreload.disable().catch(function () {});
      }
      return undefined;
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ------------------------------------------------------------------ *
 * fetch — cache first, shell fallback for navigations
 * ------------------------------------------------------------------ */

/* Any in-scope navigation resolves to the app shell. index.html is a single
 * page and the "#s=..." share fragment is applied client-side, so a deep link
 * opened with no signal still restores the shared state. */
function handleNavigate(request) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(request, { ignoreSearch: true, ignoreVary: true })
      .then(function (hit) {
        if (hit) return hit;
        return cache.match(INDEX_URL, { ignoreVary: true });
      })
      .then(function (hit) {
        if (hit) return hit;
        return cache.match(ROOT_URL, { ignoreVary: true });
      })
      .then(function (hit) {
        if (hit) return hit;
        /* Cache is empty (install never completed) — try the wire. */
        return fetch(request).catch(function () { return offlineShellResponse(); });
      });
  }).catch(function () {
    return offlineShellResponse();
  });
}

/* Cache first for every other same-origin GET. A miss goes to the network and
 * the result is written back, which is how an asset that failed to precache
 * (topo.jpg on a bad connection) heals itself on the next online run. */
function handleAsset(request) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(request, { ignoreVary: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (!isCacheableResponse(res)) return res;
        var copy = res.clone();
        return cache.put(request, copy)
          .catch(function () { /* quota or opaque — still serve the response */ })
          .then(function () { return res; });
      }).catch(function () {
        /* Offline and not an exact match. Try harder before giving up: a
         * cache-busted query string on a precached file still resolves. */
        return cache.match(request, { ignoreSearch: true, ignoreVary: true })
          .then(function (loose) {
            if (loose) return loose;
            return new Response('', {
              status: 504,
              statusText: 'Offline and not cached',
              headers: { 'Cache-Control': 'no-store' }
            });
          });
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (request.method !== 'GET') return;

  /* Chrome DevTools issues these while a page is open; fetch() throws on
   * them. Let the browser handle it. */
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* Same-origin, in-scope only. The app ships no external dependency, so
   * anything else is not ours to answer. */
  if (url.origin !== self.location.origin) return;
  if (url.pathname.lastIndexOf(SCOPE_URL.pathname, 0) !== 0) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

/* ------------------------------------------------------------------ *
 * message — optional manual update trigger
 * ------------------------------------------------------------------ */

self.addEventListener('message', function (event) {
  var data = event.data;
  if (data && data.type === 'SKIP_WAITING') self.skipWaiting();
});
