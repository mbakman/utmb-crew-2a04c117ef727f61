#!/usr/bin/env bash
#
# build-dayplan.sh — render the UTMB 2026 race-day crew plan to a clickable
# PDF and per-page PNGs.
#
#   ./transport/build-dayplan.sh            # render every output
#   ./transport/build-dayplan.sh pdf        # PDF only
#   ./transport/build-dayplan.sh png        # PNGs only (needs the PDF to exist)
#   ./transport/build-dayplan.sh --open     # render everything, then open the PDF
#
# Inputs :  transport/day-plan.html   (self-contained; no network, no assets)
#           content is a verbatim transcription of transport/day-plan-data.json
# Outputs:  transport/dist/UTMB-2026-Day-Plan.pdf      2 pages, A4 PORTRAIT
#           transport/dist/UTMB-2026-Day-Plan-p1.png   page 1 alone, 300 dpi
#           transport/dist/UTMB-2026-Day-Plan-p2.png   page 2 alone, 300 dpi
#
# The PDF is rendered with headless Chrome so that every <a href> survives as
# a real PDF link annotation — the crew taps "Navigate" in WhatsApp's PDF
# viewer and Google Maps opens. The PNGs are rasterised FROM THAT PDF with
# pdftoppm, one image per page: Chrome's --screenshot only ever captures the
# first viewport, so screenshotting would silently ship page 1 and drop the
# whole Saturday.
#
# Nothing is ever deleted: every output file is overwritten in place by the
# renderer, and the scratch Chrome profile lives in a fresh mktemp -d that the
# OS reclaims.
#
set -euo pipefail

# ---------------------------------------------------------------- paths ----
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/day-plan.html"
DIST="$HERE/dist"
PDF="$DIST/UTMB-2026-Day-Plan.pdf"
PNG_P1="$DIST/UTMB-2026-Day-Plan-p1.png"
PNG_P2="$DIST/UTMB-2026-Day-Plan-p2.png"

# Raster resolution for the page PNGs. 300 dpi on A4 portrait gives
# 2480 x 3508 px per page — plenty for reading the sheet zoomed on a phone.
PNG_DPI="${PNG_DPI:-300}"

# Seconds to allow one Chrome render before giving up on it.
CHROME_TIMEOUT="${CHROME_TIMEOUT:-90}"

# Minimum plausible output sizes, in bytes. A render that silently fails still
# produces a small well-formed file, so size is the cheapest guard against
# shipping a blank sheet.
MIN_PDF_BYTES=40000
MIN_PNG_BYTES=150000

# Expected clickable-link count in the finished PDF (9 distinct map/tracking
# URLs, several reused across both pages). Guards against a refactor that
# turns the Navigate pills into plain text.
MIN_URI=10

# --------------------------------------------------------------- chrome ----
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ ! -x "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)"
  do
    [ -n "$c" ] && [ -x "$c" ] && CHROME="$c" && break
  done
fi
[ -x "$CHROME" ] || { echo "build-dayplan.sh: no Chrome binary found. Set CHROME_BIN." >&2; exit 1; }

[ -f "$SRC" ] || { echo "build-dayplan.sh: missing source $SRC" >&2; exit 1; }
mkdir -p "$DIST"

# file:// URL for the source.
URL="file://$SRC"

# Throwaway profile dir; unique per run, reclaimed by the OS. Never removed here.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/utmb-dayplan-chrome.XXXXXXXX")"

COMMON=(
  --headless
  --disable-gpu
  --no-sandbox
  --no-first-run
  --no-default-browser-check
  --disable-extensions
  --hide-scrollbars
  --user-data-dir="$PROFILE"
)

# ------------------------------------------------------------- helpers ----
bytes() { /usr/bin/stat -f%z "$1" 2>/dev/null || /usr/bin/stat -c%s "$1" 2>/dev/null || echo 0; }

# Headless Chrome on macOS reliably WRITES its output and then fails to exit:
# the browser process lingers after the renderer is gone, so a plain
# foreground call never returns. run_chrome() therefore backgrounds Chrome,
# waits for the target file to appear and stop growing, and then asks that
# one process to quit. Nothing is deleted; the output file is overwritten in
# place by Chrome itself.
run_chrome() { # outfile arg...
  local outfile="$1"; shift
  local pid deadline stable=0 last=-1 now ref fresh=0
  # Timestamp reference created BEFORE Chrome starts. An output file older
  # than this is a leftover from a previous build and must not be mistaken
  # for this run's result — that is what makes the wait loop below correct
  # when dist/ is already populated.
  ref="$(mktemp "${TMPDIR:-/tmp}/utmb-dayplan-ref.XXXXXX")"
  "$CHROME" "$@" >/dev/null 2>&1 &
  pid=$!
  deadline=$(( SECONDS + CHROME_TIMEOUT ))
  while kill -0 "$pid" 2>/dev/null; do
    if [ -f "$outfile" ] && [ "$outfile" -nt "$ref" ]; then
      fresh=1
      now="$(bytes "$outfile")"
      if [ "$now" -gt 0 ] && [ "$now" = "$last" ]; then
        stable=$(( stable + 1 ))
        [ "$stable" -ge 3 ] && break        # size held steady ~1.5 s: render done
      else
        stable=0
      fi
      last="$now"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "  WARN  Chrome exceeded ${CHROME_TIMEOUT}s — stopping it." >&2
      break
    fi
    sleep 0.5
  done
  [ "$fresh" = "1" ] || echo "  WARN  $outfile was not rewritten by this run." >&2
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    local n=0
    while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 20 ]; do sleep 0.25; n=$(( n + 1 )); done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
}

check_size() { # path minimum label
  local f="$1" min="$2" label="$3" n
  [ -f "$f" ] || { echo "  FAIL  $label was not created: $f" >&2; return 1; }
  n="$(bytes "$f")"
  if [ "$n" -lt "$min" ]; then
    echo "  FAIL  $label is only ${n} bytes (expected >= ${min}) — render probably produced a blank page." >&2
    return 1
  fi
  echo "  OK    $label  ${n} bytes  $f"
}

# The whole point of going through Chrome rather than a rasteriser: the map
# pills must stay tappable in the PDF the crew opens on their phones.
check_links() {
  command -v qpdf >/dev/null 2>&1 || {
    echo "  note: qpdf not installed — skipping the clickable-link check."
    return 0
  }
  # grep -a: the --qdf stream still contains binary chunks, and BSD grep
  # silently reports zero matches on input it decides is binary.
  local n
  n="$(qpdf --qdf --object-streams=disable "$PDF" - 2>/dev/null | grep -ac '/URI' || true)"
  if [ "${n:-0}" -lt "$MIN_URI" ]; then
    echo "  FAIL  only ${n:-0} /URI link annotations in the PDF (expected >= ${MIN_URI})." >&2
    return 1
  fi
  echo "  OK    ${n} /URI link annotations (expected >= ${MIN_URI})"
}

render_pdf() {
  echo "==> PDF   $PDF"
  run_chrome "$PDF" "${COMMON[@]}" \
    --no-pdf-header-footer \
    --print-to-pdf="$PDF" \
    "$URL"
  check_size "$PDF" "$MIN_PDF_BYTES" "PDF"
  if command -v pdfinfo >/dev/null 2>&1; then
    echo "  ---- pdfinfo ----"
    pdfinfo "$PDF" | grep -E '^(Pages|Page size|Page rot|Producer|File size|PDF version):' | sed 's/^/  /'
    local pages
    pages="$(pdfinfo "$PDF" | awk '/^Pages:/{print $2}')"
    [ "$pages" = "2" ] || echo "  WARN  expected 2 pages, got ${pages:-?}" >&2
    # A4 portrait is ~595 x ~842 pt (Skia reports 594.96 x 841.92). If the
    # @page rule were lost we would see those two numbers swapped.
    pdfinfo "$PDF" | grep -Eq 'Page size: *59[45](\.[0-9]+)? x 84[12](\.[0-9]+)? pts' \
      || echo "  WARN  page size is not A4 portrait (expected ~595 x ~842 pts)." >&2
  else
    echo "  note: pdfinfo not installed — skipping the page-count check."
  fi
  check_links
}

dims() { # path
  command -v sips >/dev/null 2>&1 || return 0
  sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null | sed -n 's/^ *pixel/    pixel/p'
}

# One PNG per PDF page. -singlefile makes pdftoppm write exactly <base>.png
# with no page-number suffix, so the output names are deterministic.
render_png() {
  command -v pdftoppm >/dev/null 2>&1 || {
    echo "  FAIL  pdftoppm not found — cannot rasterise the pages. Install poppler." >&2
    return 1
  }
  [ -f "$PDF" ] || { echo "  FAIL  $PDF does not exist — run 'build-dayplan.sh pdf' first." >&2; return 1; }

  local pages=2
  if command -v pdfinfo >/dev/null 2>&1; then
    pages="$(pdfinfo "$PDF" | awk '/^Pages:/{print $2}')"
  fi
  [ "$pages" -ge 2 ] 2>/dev/null || echo "  WARN  PDF reports ${pages:-?} page(s); expected 2." >&2

  local n out
  for n in 1 2; do
    case "$n" in 1) out="${PNG_P1%.png}" ;; 2) out="${PNG_P2%.png}" ;; esac
    echo "==> PNG   ${out}.png   (page $n @ ${PNG_DPI} dpi)"
    pdftoppm -r "$PNG_DPI" -png -f "$n" -l "$n" -singlefile "$PDF" "$out"
    check_size "${out}.png" "$MIN_PNG_BYTES" "PNG page $n"
    dims "${out}.png"
  done
}

# ----------------------------------------------------------------- main ----
TARGET="${1:-all}"
OPEN_AFTER=0
[ "$TARGET" = "--open" ] && { TARGET="all"; OPEN_AFTER=1; }

echo "UTMB 2026 crew day plan — build"
echo "  chrome: $CHROME"
echo "  source: $SRC"
echo

case "$TARGET" in
  pdf) render_pdf ;;
  png) render_png ;;
  all) render_pdf; echo; render_png ;;
  *)   echo "usage: build-dayplan.sh [pdf|png|all|--open]" >&2; exit 2 ;;
esac

echo
echo "Done. Outputs in $DIST"
[ "$OPEN_AFTER" = "1" ] && command -v open >/dev/null 2>&1 && open "$PDF"
exit 0
