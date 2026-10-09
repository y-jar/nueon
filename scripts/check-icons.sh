#!/usr/bin/env sh
# Verify the generated icon set: expected size, a transparent top-left corner
# and an opaque centre for every file. Run by `loom-gates` so the icons cannot
# drift from the master logo.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Work with ImageMagick 7 (`magick`) or 6 (`convert`/`identify`).
if magick -version >/dev/null 2>&1; then
  image_magick="ImageMagick 7 (magick)"
  im_identify() { magick identify "$@"; }
  im_convert() { magick "$@"; }
elif convert -version >/dev/null 2>&1; then
  image_magick="ImageMagick 6 (convert)"
  im_identify() { identify "$@"; }
  im_convert() { convert "$@"; }
else
  echo "check-icons: need ImageMagick (magick or convert) on PATH" >&2
  exit 1
fi
echo "check-icons: using $image_magick"

failed=0
for entry in \
  "src-tauri/icons/32x32.png:32" \
  "src-tauri/icons/48x48.png:48" \
  "src-tauri/icons/64x64.png:64" \
  "src-tauri/icons/128x128.png:128" \
  "src-tauri/icons/icon.png:256"; do
  rel=${entry%:*}
  size=${entry##*:}
  file="$root/$rel"
  if [ ! -f "$file" ]; then
    echo "FAIL $rel: missing"
    failed=1
    continue
  fi
  got=$(im_identify -format '%wx%h' "$file")
  if [ "$got" != "${size}x${size}" ]; then
    echo "FAIL $rel: size $got, want ${size}x${size}"
    failed=1
    continue
  fi
  half=$((size / 2))
  corner=$(im_convert "$file" -format '%[fx:p{0,0}.a]' info:)
  centre=$(im_convert "$file" -format "%[fx:p{$half,$half}.a]" info:)
  ok_corner=$(awk "BEGIN { print ($corner <= 0.01) ? 1 : 0 }")
  ok_centre=$(awk "BEGIN { print ($centre >= 0.99) ? 1 : 0 }")
  if [ "$ok_corner" != "1" ] || [ "$ok_centre" != "1" ]; then
    echo "FAIL $rel: corner alpha=$corner centre alpha=$centre"
    failed=1
    continue
  fi
  echo "ok   $rel: ${got}, corner alpha=$corner, centre alpha=$centre"
done

# The in-app mark is the SVG source (ActivityBar / Onboarding import it
# directly); make sure it is present and actually an SVG.
svg="$root/assets/branding/nueon-logo-dark.svg"
if [ -s "$svg" ] && head -c 400 "$svg" | grep -q '<svg'; then
  echo "ok   assets/branding/nueon-logo-dark.svg: present"
else
  echo "FAIL assets/branding/nueon-logo-dark.svg: missing or not an SVG"
  failed=1
fi

if [ "$failed" != "0" ]; then
  echo "check-icons: FAILED"
  exit 1
fi
echo "check-icons: all icons present and valid"
