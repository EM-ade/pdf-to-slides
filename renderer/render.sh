#!/bin/sh
# Convert a PPTX to per-slide PNGs.
# Usage: render.sh <pptx> <out_dir> [dpi]
set -e

PPTX="${1:-deck.pptx}"
OUT="${2:-/out}"
DPI="${3:-150}"

mkdir -p "$OUT"
WORK=$(mktemp -d)
cp "$PPTX" "$WORK/input.pptx"

echo "[render] converting to PDF..."
libreoffice --headless --convert-to pdf --outdir "$WORK" "$WORK/input.pptx" >/dev/null 2>&1

PDF="$WORK/input.pdf"
if [ ! -f "$PDF" ]; then
  echo "[render] PDF not produced" >&2
  exit 1
fi

echo "[render] rasterizing to PNG @ ${DPI}dpi..."
pdftoppm -png -r "$DPI" "$PDF" "$WORK/slide"

# pdftoppm produces slide-1.png, slide-2.png, etc. (not zero-padded).
# Rename to zero-padded slide-01.png, slide-02.png, ...
i=1
for f in "$WORK"/slide-*.png; do
  [ -f "$f" ] || continue
  new=$(printf "%s/slide-%02d.png" "$OUT" "$i")
  cp "$f" "$new"
  i=$((i + 1))
done

COUNT=$(ls "$OUT"/slide-*.png 2>/dev/null | wc -l)
echo "[render] done: ${COUNT} slides"
rm -rf "$WORK"
