# RESUME — state as of 2026-08-28 ~14:15 (race day; start delayed to 19:45)

## Live

- **Site v3: https://www.ozgebocegi.com/crew-suha-f792a9/** — deployed and live-verified.
  Live shared checklist (`api/checklist.php`, token `crewsync-17fa94ab349f`,
  flock + atomic write, version/409 contract), `js/sync.js`
  (15 s poll, 2 s debounced push, item-level merge), **tombstone deletes** (deletions
  propagate crew-wide; 100/100 harness + 18/18 UI smoke), 4-CP transport + Day Plan view
  rendered from `day-plan.json`, shared bib (1056) re-aiming the tracker button.
  sw CACHE_VERSION **v5**. Live server state: version 5, Nike long-sleeve item at
  U7 onArrival, bib 1056.
- **PDF in ~/Downloads**: `UTMB-2026-Crew-Sheet-Les-Houches.pdf` (+ Day-Plan alias +
  p1/p2 PNGs + stacked PNG) — cleaned per user: no delay reminders, no last-bus alarms,
  Les Houches pass restored (20:30–21:15), bus table `from · every · ride`, cutoffs plain,
  ETAs SAT 00:31 / SAT 09:32 / SAT 18:37 / SUN 00:35 / finish SUN ~04:39 (±20).

## Deploy flow (user mandate: tmux, not direct ssh)

Local `git push`, then in tmux session `ozgebocegi` (reconnect `ssh ozgebocegi.com`
if the pane shows a local prompt — 1Password must be unlocked):

```
cd ~/utmb-src && git pull && rsync -a docs/ ~/public_html/crew-suha-f792a9/
```

Verify: `sw.js` shows v5; `api/checklist.php` GET returns current version with items intact.

## Context that must survive

- Crew base 100 Rte de la Gare, Les Houches; car parks at Grépon, Chamonix every leg.
- Race start delayed 17:45 → **19:45**; all plan times already shifted. Per the user,
  shuttles run continuously ~24 h+ (runners spread over hours) — last-bus alarms were
  deliberately REMOVED from all artifacts at user request. Do not re-add them.
- Bib 1056; tracker https://live.utmb.world/utmb/2026/runners/1056.
- Server: cPanel dozgeboc@s1196, PHP 8.2; repo clone at `~/utmb-src`.
- GitHub Pages of the old repo is disabled (404) — cPanel site is the only live one.
- Accepted LOWs: >256 KB payload fails silently; pre-existing 30 px drawer-close button;
  a pre-tombstone client (none known in the field) could resurrect a deleted row by
  touching it before its sw updates to v5.
