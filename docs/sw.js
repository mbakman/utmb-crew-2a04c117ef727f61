/* sw.js — offline service worker for the UTMB 2026 crew app.
 *
 * Registered by main.js (registerServiceWorker(), on window 'load', scope
 * "./"). Nothing outside this file needs to change to ship an update.
 *
 * Contract this worker implements
 * ------------------------------------------------------------------
 *  - Precaches every asset the app ships on 'install', so the very first
 *    online visit is the only one that ever needs a network.
 *  - Serves cache-first. The app has zero external dependencies, so once
 *    precached it runs in airplane mode.
 *  - EXCEPT anything under api/ — the live crew sync endpoint. Those requests
 *    are not intercepted at all: no cache read, no cache write, no fallback.
 *    They either reach the server or they fail, and js/sync.js treats a
 *    failure as "stay local and try again in 15 seconds".
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
 * old page's JS with new data files: this app loads all of its scripts
 * from <script> tags and fetches its JSON payloads during boot, and the
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
 * docs/api/ is the one exception: it is server-side and must never appear in
 * either manifest.
 */

'use strict';

/* ------------------------------------------------------------------ *
 * Cache identity
 * ------------------------------------------------------------------ */

var CACHE_PREFIX = 'utmb-crew';
/* v5: deletes propagate. Deleting a checklist item used to be local-only — the
 * union merge in js/sync.js re-seeded it from any phone that still held it,
 * which the crew asked to have fixed. A delete is now a TOMBSTONE on the item
 * ({deleted:true} plus a fresh lastModified), so it travels through the
 * existing "newer lastModified wins the whole item" rule: a delete beats an
 * older edit, a newer edit resurrects the row, and a phone that never held the
 * items still cannot wipe them. Touches js/checklist.js, js/store.js,
 * js/sync.js and js/share.js.
 *
 * v4: live crew sync, in one bump. v3 is what is deployed and this is the next
 * version anyone receives, so everything below ships together under the one
 * string — there is no intermediate release for a second number to name.
 *
 *   - js/sync.js and day-plan.json join the manifest, store.js grew the shared
 *     state layer, and anything under api/ is now excluded from this worker
 *     entirely (see the fetch handler).
 *   - Shared-tick correctness: an item's lastModified lives on the item and
 *     nowhere else, so a merged un-tick can no longer be resurrected by a
 *     reload, and share links preserve done/lastModified instead of wiping
 *     every tick in every checkpoint.
 *   - The Track button is aimed by day-plan.json + the shared bib.
 *   - Sync failures the crew cannot see are now visible: a rejected token and
 *     a server that will not save both raise a banner.
 *   - day-plan.json itself changed: it is now byte-identical to the verified
 *     source transport/day-plan-data.json (CP7 "Cutoff SAT 13:15", and the
 *     BUS REFERENCE rows got their first-departure times and SUN day markers
 *     back), and it moved from OPTIONAL_ASSETS to REQUIRED_ASSETS.
 *
 * The app is already live and this worker serves cache-first, so a phone that
 * installed v3 keeps serving v3 until this string changes — bumping it is what
 * makes an update reach anyone. */
var CACHE_VERSION = 'v5';
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
  'topo-meta.json',

  /* The day plan is the primary race-day view — index.html mounts
   * #transportMount first for exactly that reason — so a precache miss here
   * leaves the crew looking at a one-line notice where the whole plan should
   * be until the next online visit. That is a worse outcome than retrying the
   * install, and at 12 KB it is a far cheaper fetch to insist on than
   * course.json at 80 KB, which is already required. */
  'day-plan.json'
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

  /* Live sync. Optional on purpose: without it the app is exactly the
   * offline-first thing it was before, so a bad fetch here must never abort an
   * install and cost a crew member their whole offline copy on race day. The
   * runtime cache picks it up on the next online visit. */
  'js/sync.js',

  'manifest.webmanifest',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',

  /* Not used by the app — only crawlers ever ask for it. Listed so this
   * manifest still accounts for every file in docs/ except sw.js itself, which
   * is the check the deploy checklist above is verified against. */
  'robots.txt'
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

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  /* ── the live-sync API is off limits to this worker ──────────────────
   * Returning without calling respondWith() hands the request straight back
   * to the browser: network only, never written to the cache, never answered
   * from it. This has to come before everything else. A cached GET of
   * api/checklist.php would pin the crew to a stale version number forever
   * and quietly stop every phone from ever seeing an update again — the exact
   * failure a cache-first worker is built to cause. */
  if (url.pathname.indexOf('/api/') !== -1) return;

  if (request.method !== 'GET') return;

  /* Chrome DevTools issues these while a page is open; fetch() throws on
   * them. Let the browser handle it. */
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

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
