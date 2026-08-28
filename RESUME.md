# RESUME — state as of 2026-08-28 ~12:50 (race day, start 17:45)

## Shipped

- **`~/Downloads/UTMB-2026-Crew-Sheet-Les-Houches.pdf`** — 2-page A4 day-plan
  infographic (also `UTMB-2026-Day-Plan.pdf` + per-page PNGs). Verified: 42 clickable
  link annotations (Google Maps dir links + bib-1056 tracker), ETAs 22:31/07:32/16:37/22:35
  ±20, carb hand-overs, SUN qualifiers on Sunday service-ends, 00:30-vs-01:00 hedge.
  Source: `transport/day-plan.html` + `build-dayplan.sh`, data `transport/day-plan-data.json`.
- **Site v2 committed + pushed** (`f446910`): live shared checklist
  (`docs/api/checklist.php`, token `crewsync-17fa94ab349f`, flock + atomic write,
  version/409 contract) + `docs/js/sync.js` (15 s poll, 2 s debounced push, item-level
  merge, never drops items, offline banner) + transport view rewritten to the 4 crew CPs
  + Day Plan view from `docs/day-plan.json` + shared bib field re-aiming the tracker
  button. sw CACHE_VERSION v4. All adversarially verified: offline ✓ two-client sync ✓
  409 merge ✓ (7 agents, 2 fix rounds).

## Deployed

- **https://www.ozgebocegi.com/crew-suha-f792a9/** — currently serving site **v1**
  (pre-sync version, deployed morning). v2 deploy is STAGED, blocked on SSH auth.

## Deploy v2 (the only remaining step)

Unlock 1Password (Touch ID), then in the `ozgebocegi` tmux session:

```
ssh ozgebocegi.com
cd ~/utmb-src && git pull && rsync -a docs/ ~/public_html/crew-suha-f792a9/
```

Then verify live: GET https://www.ozgebocegi.com/crew-suha-f792a9/api/checklist.php
(expect `{"version":0,...}`), POST round-trip, and sw.js shows v4.

Known LOWs (accepted): >256 KB payload fails silently (impossible with 31 items);
pre-existing 30 px drawer-close button; deletions never propagate (by design — union merge).

## Facts that must survive

- Crew base: 100 Rte de la Gare, Les Houches. Car parks at Grépon, Chamonix for every leg.
- The 01:00 NDG closing figure is UNVERIFIED as a departure — plan on the 00:30 bus.
- 20:30 Grépon→Contamines is the LAST bus Friday; crew aims for 20:15.
- No UTMB shuttle ever runs Chamonix→Les Houches.
- Bib 1056; tracker https://live.utmb.world/utmb/2026/runners/1056.
- Server: cPanel, dozgeboc@s1196, PHP 8.2.31; repo clone at ~/utmb-src on the server;
  deploy = git pull + server-local rsync. ALL server ops via the ozgebocegi tmux session
  (user mandate); direct ssh only as emergency fallback.
- GitHub Pages (mbakman.github.io/utmb-crew-2a04c117ef727f61) still serves the OLD site —
  disable Pages once v2 is verified live, so two checklist versions don't coexist.
