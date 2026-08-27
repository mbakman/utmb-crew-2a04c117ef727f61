# RESUME — where we stopped

Paused 2026-08-27 ~11:30 (internet disconnect). Race: **Fri 28 Aug 17:45**.

## State

Ultracode workflow ran phases 1–5. Phase 6 (adversarial verify) was mid-run and died
with the connection. All phase 1–5 output is committed.

- `transport/dist/utmb-crew-sheet-EN.pdf` — 2pp A4 landscape. **Usable as-is.** If nothing
  else happens, AirDrop this to the crew; it solves the transport problem on its own.
- `docs/` — PWA, loads with zero console errors, SW precache validated 24/24.
  NOT deployed. NOT fully verified.

## Resume the workflow

```
Workflow({
  scriptPath: "/Users/bakman/.claude/projects/-Users-bakman-LocalRepos-Personal-utmb-crew/2e1d840d-854b-4ed5-b47c-be8e15567125/workflows/scripts/utmb-crew-kit-wf_7c23157d-dd9.js",
  resumeFromRunId: "wf_7c23157d-dd9"
})
```
Completed agents return cached results; only phase 6 re-runs. Check
`<transcriptDir>/journal.jsonl` before assuming a cached result was non-empty.

## Two known defects — fix before deploy

1. **Header reads `174 km`, should be `176.8`.** Source: `docs/course.json` `total_km`.
2. **Horizontal overflow at 390px** clips the map and puts the zoom controls off-screen.
   Pre-existing in the original file, NOT a split regression. Cause: `min-width:auto`.
   ```css
   .layout           { grid-template-columns: minmax(0, 1fr); }
   .header-top > div { min-width: 0; }
   .panel            { min-width: 0; }
   ```

## Still to do

- [ ] Fix the two defects above
- [ ] Confirm the service worker registers over HTTP (a `file://` registration failure was
      seen in an agent log — expected there, but unconfirmed over http)
- [ ] Verify share round-trip end to end (84K of hand-rolled compression in `docs/js/share.js`)
- [ ] Strip the street address from `docs/` (keep it on the PDF — user confirmed)
- [ ] Add UTMB Live tracking panel + bib-number field (user has no splits; will track online)
- [ ] Deploy: GitHub Pages, `main`/`docs`, **unguessable repo name** under `mbakman`.
      Caveat: free accounts need a PUBLIC repo, which is listed on the profile and so
      discoverable. Try private repo first; if GitHub rejects it, say so rather than
      silently shipping something less private than asked for.

## Decisions locked

- Crew base Les Houches, 100 Rte de la Gare — address stays on the PDF, out of `docs/`.
- Checklist items stay Turkish verbatim; UI chrome English.
- Tick state per-device; checklist CONTENT is what gets shared.
- Sharing via URL fragment (`#s=`), never sent to the server. No backend.
- Use 176.8 km.
