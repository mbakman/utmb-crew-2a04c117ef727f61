#!/usr/bin/env bash
#
# build.sh — render the UTMB Les Houches crew sheet to print-ready PDF and PNGs.
#
#   ./transport/build.sh            # render every output
#   ./transport/build.sh pdf        # PDF only
#   ./transport/build.sh png        # PNGs only (needs the PDF to exist)
#   ./transport/build.sh --open     # render everything, then open the PDF
#
# Inputs :  transport/crew-sheet.html   (self-contained; no network, no assets)
# Outputs:  transport/dist/utmb-crew-sheet-EN.pdf      2 pages, A4 landscape
#           transport/dist/utmb-crew-sheet-EN-p1.png   page 1 alone
#           transport/dist/utmb-crew-sheet-EN-p2.png   page 2 alone
#           transport/dist/utmb-crew-sheet-EN.png      both pages stacked
#
# The PDF is rendered with headless Chrome. The PNGs are rasterised FROM THAT
# PDF with pdftoppm, one image per page. That matters: the sheet is two A4
# pages, and Chrome's --screenshot only ever captures the first viewport, so
# the old single-screenshot route silently shipped page 1 and dropped all 13
# shuttle line cards. Going through the PDF also sidesteps the in-page fit()
# script, which scales each .page to the viewport height on screen.
#
# Nothing is ever deleted: every output file is overwritten in place by the
# renderer, and the scratch Chrome profile lives in a fresh mktemp -d that the
# OS reclaims.
#
set -euo pipefail

# ---------------------------------------------------------------- paths ----
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/crew-sheet.html"
DIST="$HERE/dist"
PDF="$DIST/utmb-crew-sheet-EN.pdf"
PNG="$DIST/utmb-crew-sheet-EN.png"          # both pages, stacked vertically
PNG_P1="$DIST/utmb-crew-sheet-EN-p1.png"
PNG_P2="$DIST/utmb-crew-sheet-EN-p2.png"
PNG_PREFIX="$DIST/utmb-crew-sheet-EN"       # pdftoppm writes <prefix>-N.png

# Raster resolution for the page PNGs. 300 dpi on A4 landscape gives
# 3508 x 2481 px per page — the same pixel size as the official posters, and
# comfortably legible for the 6-7 px body type on this sheet.
PNG_DPI="${PNG_DPI:-300}"

# Minimum plausible output sizes, in bytes. A render that silently fails still
# produces a small well-formed file, so size is the cheapest guard against
# shipping a blank sheet.
# Seconds to allow one Chrome render before giving up on it.
CHROME_TIMEOUT="${CHROME_TIMEOUT:-90}"

MIN_PDF_BYTES=40000
MIN_PNG_BYTES=150000

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
[ -x "$CHROME" ] || { echo "build.sh: no Chrome binary found. Set CHROME_BIN." >&2; exit 1; }

[ -f "$SRC" ] || { echo "build.sh: missing source $SRC" >&2; exit 1; }
mkdir -p "$DIST"

# file:// URL for the source.
URL="file://$SRC"

# Throwaway profile dir; unique per run, reclaimed by the OS. Never removed here.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/utmb-crew-chrome.XXXXXXXX")"

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
  ref="$(mktemp "${TMPDIR:-/tmp}/utmb-build-ref.XXXXXX")"
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
  else
    echo "  note: pdfinfo not installed — skipping page-count check."
  fi
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
  [ -f "$PDF" ] || { echo "  FAIL  $PDF does not exist — run 'build.sh pdf' first." >&2; return 1; }

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

  # Combined two-page image, purely for convenience. Optional: it needs an
  # ImageMagick binary, and its absence must not fail the build now that the
  # per-page PNGs are the real deliverable.
  local im=""
  for c in magick convert; do command -v "$c" >/dev/null 2>&1 && { im="$c"; break; }; done
  if [ -n "$im" ]; then
    echo "==> PNG   $PNG   (both pages stacked)"
    "$im" "$PNG_P1" "$PNG_P2" -append "$PNG"
    check_size "$PNG" "$MIN_PNG_BYTES" "PNG combined"
    dims "$PNG"
  else
    echo "  note: no ImageMagick binary — skipping the combined two-page PNG."
    echo "        The per-page files $PNG_P1 and $PNG_P2 are the deliverable."
  fi
}

# ----------------------------------------------------------------- main ----
TARGET="${1:-all}"
OPEN_AFTER=0
[ "$TARGET" = "--open" ] && { TARGET="all"; OPEN_AFTER=1; }

echo "UTMB crew sheet — build"
echo "  chrome: $CHROME"
echo "  source: $SRC"
echo

case "$TARGET" in
  pdf) render_pdf ;;
  png) render_png ;;
  all) render_pdf; echo; render_png ;;
  *)   echo "usage: build.sh [pdf|png|all|--open]" >&2; exit 2 ;;
esac

echo
echo "Done. Outputs in $DIST"
[ "$OPEN_AFTER" = "1" ] && command -v open >/dev/null 2>&1 && open "$PDF"
exit 0
