#!/usr/bin/env sh
# Verify the generated icon set: expected size, a transparent top-left corner
# and an opaque centre for every file. Run by `loom-gates` so the icons cannot
# drift from the master logo.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if ! command -v magick >/dev/null 2>&1; then
  echo "check-icons: ImageMagick (magick) not found on PATH" >&2
  exit 1
fi

failed=0
for entry in \
  "src-tauri/icons/32x32.png:32" \
  "src-tauri/icons/48x48.png:48" \
  "src-tauri/icons/64x64.png:64" \
  "src-tauri/icons/128x128.png:128" \
  "src-tauri/icons/icon.png:256" \
  "src/assets/nueon-64.png:64"; do
  rel=${entry%:*}
  size=${entry##*:}
  file="$root/$rel"
  if [ ! -f "$file" ]; then
    echo "FAIL $rel: missing"
    failed=1
    continue
  fi
  got=$(magick identify -format '%wx%h' "$file")
  if [ "$got" != "${size}x${size}" ]; then
    echo "FAIL $rel: size $got, want ${size}x${size}"
    failed=1
    continue
  fi
  half=$((size / 2))
  corner=$(magick "$file" -format '%[fx:p{0,0}.a]' info:)
  centre=$(magick "$file" -format "%[fx:p{$half,$half}.a]" info:)
  ok_corner=$(awk "BEGIN { print ($corner <= 0.01) ? 1 : 0 }")
  ok_centre=$(awk "BEGIN { print ($centre >= 0.99) ? 1 : 0 }")
  if [ "$ok_corner" != "1" ] || [ "$ok_centre" != "1" ]; then
    echo "FAIL $rel: corner alpha=$corner centre alpha=$centre"
    failed=1
    continue
  fi
  echo "ok   $rel: ${got}, corner alpha=$corner, centre alpha=$centre"
done

if [ "$failed" != "0" ]; then
  echo "check-icons: FAILED"
  exit 1
fi
echo "check-icons: all icons present and valid"
