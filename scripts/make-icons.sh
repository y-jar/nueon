#!/usr/bin/env sh
# Regenerate the app icon set from the master logo in assets/branding/.
#
# Requires ImageMagick (`magick`). Downscales with Lanczos, keeps the alpha
# channel, and never upscales: a requested size larger than the master is
# skipped. The master is 512x512, so the largest output here is 256x256 and
# `icon.png` stays 256 (not 512). The in-app mark is the SVG source, imported
# directly by the app, so it is not regenerated here.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
master="$root/assets/branding/nueon-logo-dark.png"

if [ ! -f "$master" ]; then
  echo "make-icons: missing master $master" >&2
  exit 1
fi

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
  echo "make-icons: need ImageMagick (magick or convert) on PATH" >&2
  exit 1
fi
echo "make-icons: using $image_magick"

src_w=$(im_identify -format '%w' "$master")
src_h=$(im_identify -format '%h' "$master")

resize() {
  size=$1
  out=$2
  if [ "$size" -gt "$src_w" ] || [ "$size" -gt "$src_h" ]; then
    echo "skip $out: master is ${src_w}x${src_h} (< ${size})" >&2
    return 0
  fi
  mkdir -p "$(dirname -- "$out")"
  # PNG32 forces 8-bit RGBA so small sizes are not palettised (keeps alpha).
  im_convert "$master" -filter Lanczos -resize "${size}x${size}" "PNG32:$out"
  echo "wrote $out (${size}x${size})"
}

mkdir -p "$root/src-tauri/icons"

resize 32 "$root/src-tauri/icons/32x32.png"
resize 48 "$root/src-tauri/icons/48x48.png"
resize 64 "$root/src-tauri/icons/64x64.png"
resize 128 "$root/src-tauri/icons/128x128.png"
# `icon.png` is the 256px variant. Tauri's `128x128@2x.png` is deliberately
# not produced: its `@2x` suffix makes the deb bundler write an invalid
# `hicolor/256x256@2/` directory (verified), and `icon.png` already covers 256.
resize 256 "$root/src-tauri/icons/icon.png"
