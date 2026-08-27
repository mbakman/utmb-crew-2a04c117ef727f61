#!/usr/bin/env bash
#
# build.sh — render the UTMB Les Houches crew sheet to print-ready PDF and PNG.
#
#   ./transport/build.sh            # render both outputs
#   ./transport/build.sh pdf        # PDF only
#   ./transport/build.sh png        # PNG only
#   ./transport/build.sh --open     # render both, then open the PDF
#
# Inputs :  transport/crew-sheet.html   (self-contained; no network, no assets)
# Outputs:  transport/dist/utmb-crew-sheet-EN.pdf
#           transport/dist/utmb-crew-sheet-EN.png
#
# Renders with headless Chrome. Nothing is ever deleted: Chrome overwrites the
# two output files in place, and the scratch profile lives in a fresh mktemp -d
# that the OS reclaims.
#
set -euo pipefail

# ---------------------------------------------------------------- paths ----
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/crew-sheet.html"
DIST="$HERE/dist"
PDF="$DIST/utmb-crew-sheet-EN.pdf"
PNG="$DIST/utmb-crew-sheet-EN.png"

# A4 landscape at 2x: 2400 x 1697 device-independent pixels.
PNG_WINDOW="2400,1697"
PNG_SCALE="2"

# Minimum plausible output sizes, in bytes. A Chrome render that silently
# fails still produces a small well-formed file, so size is the cheapest
# guard against shipping a blank sheet.
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

render_png() {
  echo "==> PNG   $PNG"
  run_chrome "$PNG" "${COMMON[@]}" \
    --screenshot="$PNG" \
    --window-size="$PNG_WINDOW" \
    --force-device-scale-factor="$PNG_SCALE" \
    "$URL"
  check_size "$PNG" "$MIN_PNG_BYTES" "PNG"
  if command -v sips >/dev/null 2>&1; then
    echo "  ---- dimensions ----"
    sips -g pixelWidth -g pixelHeight "$PNG" 2>/dev/null | sed -n 's/^ *pixel/  pixel/p'
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
