#!/usr/bin/env bash
#
# build-nightplan.sh — render the UTMB 2026 night plan (CP11 → CP13 → Finish)
# to a clickable one-page PDF and a single 300 dpi PNG.
#
#   ./transport/build-nightplan.sh            # render everything
#   ./transport/build-nightplan.sh pdf        # PDF only
#   ./transport/build-nightplan.sh png        # PNG only (needs the PDF to exist)
#   ./transport/build-nightplan.sh --open     # render everything, then open the PDF
#
# Inputs :  transport/night-plan.html   (self-contained; no network, no assets)
#           content is a verbatim transcription of transport/night-plan-data.json
# Outputs:  transport/dist/UTMB-2026-Night-Plan.pdf   1 page, A4 PORTRAIT
#           transport/dist/UTMB-2026-Night-Plan.png   that page, 300 dpi
#
# The PDF is rendered with headless Chrome so that every <a href> survives as
# a real PDF link annotation — the crew taps a Navigate pill in WhatsApp's PDF
# viewer and Google Maps opens. The PNG (the thing actually pasted into the
# WhatsApp thread) is rasterised FROM THAT PDF with pdftoppm rather than with
# Chrome's --screenshot, which only ever captures the first viewport.
#
# Nothing is ever deleted: every output file is overwritten in place by the
# renderer, and the scratch Chrome profile lives in a fresh mktemp -d that the
# OS reclaims.
#
set -euo pipefail

# ---------------------------------------------------------------- paths ----
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/night-plan.html"
DIST="$HERE/dist"
PDF="$DIST/UTMB-2026-Night-Plan.pdf"
PNG="$DIST/UTMB-2026-Night-Plan.png"

# Raster resolution for the page PNG. 300 dpi on A4 portrait gives
# 2480 x 3508 px — plenty for reading the sheet zoomed on a phone at night.
PNG_DPI="${PNG_DPI:-300}"

# Seconds to allow one Chrome render before giving up on it.
CHROME_TIMEOUT="${CHROME_TIMEOUT:-90}"

# Minimum plausible output sizes, in bytes. A render that silently fails still
# produces a small well-formed file, so size is the cheapest guard against
# shipping a blank sheet.
MIN_PDF_BYTES=25000
MIN_PNG_BYTES=150000

# This sheet is exactly one page — a second page means content overflowed the
# .page box and the layout has to be tightened, not accepted.
EXPECT_PAGES=1

# Expected clickable-link count in the finished PDF: live tracking + three ETA
# chips + CP11 pill + CP13 pill + Grépon + finish + base = 9 anchors. Guards
# against a refactor that turns the Navigate pills into plain text.
MIN_URI=6

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
[ -x "$CHROME" ] || { echo "build-nightplan.sh: no Chrome binary found. Set CHROME_BIN." >&2; exit 1; }

[ -f "$SRC" ] || { echo "build-nightplan.sh: missing source $SRC" >&2; exit 1; }
mkdir -p "$DIST"

# file:// URL for the source.
URL="file://$SRC"

# Throwaway profile dir; unique per run, reclaimed by the OS. Never removed here.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/utmb-nightplan-chrome.XXXXXXXX")"

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
  ref="$(mktemp "${TMPDIR:-/tmp}/utmb-nightplan-ref.XXXXXX")"
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
    if [ "$pages" = "$EXPECT_PAGES" ]; then
      echo "  OK    ${pages} page (expected ${EXPECT_PAGES})"
    else
      echo "  FAIL  expected ${EXPECT_PAGES} page, got ${pages:-?} — content overflows the .page box." >&2
      return 1
    fi
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

# -singlefile makes pdftoppm write exactly <base>.png with no page-number
# suffix, so the output name is deterministic and the sheet stays one image.
render_png() {
  command -v pdftoppm >/dev/null 2>&1 || {
    echo "  FAIL  pdftoppm not found — cannot rasterise the page. Install poppler." >&2
    return 1
  }
  [ -f "$PDF" ] || { echo "  FAIL  $PDF does not exist — run 'build-nightplan.sh pdf' first." >&2; return 1; }

  if command -v pdfinfo >/dev/null 2>&1; then
    local pages
    pages="$(pdfinfo "$PDF" | awk '/^Pages:/{print $2}')"
    [ "$pages" = "$EXPECT_PAGES" ] \
      || echo "  WARN  PDF reports ${pages:-?} page(s); expected ${EXPECT_PAGES}." >&2
  fi

  echo "==> PNG   $PNG   (page 1 @ ${PNG_DPI} dpi)"
  pdftoppm -r "$PNG_DPI" -png -f 1 -l 1 -singlefile "$PDF" "${PNG%.png}"
  check_size "$PNG" "$MIN_PNG_BYTES" "PNG"
  dims "$PNG"
}

# ----------------------------------------------------------------- main ----
TARGET="${1:-all}"
OPEN_AFTER=0
[ "$TARGET" = "--open" ] && { TARGET="all"; OPEN_AFTER=1; }

echo "UTMB 2026 crew night plan — build"
echo "  chrome: $CHROME"
echo "  source: $SRC"
echo

case "$TARGET" in
  pdf) render_pdf ;;
  png) render_png ;;
  all) render_pdf; echo; render_png ;;
  *)   echo "usage: build-nightplan.sh [pdf|png|all|--open]" >&2; exit 2 ;;
esac

echo
echo "Done. Outputs in $DIST"
[ "$OPEN_AFTER" = "1" ] && command -v open >/dev/null 2>&1 && open "$PDF"
exit 0
