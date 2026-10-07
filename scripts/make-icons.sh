#!/usr/bin/env sh
# Regenerate the app icon set from the master logo in assets/branding/.
#
# Requires ImageMagick (`magick`). Downscales with Lanczos, keeps the alpha
# channel, and never upscales: a requested size larger than the master is
# skipped. The master is 381x381, so the largest output here is 256x256 and
# `icon.png` stays 256 (not 512).
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
master="$root/assets/branding/nueon-logo.png"

if [ ! -f "$master" ]; then
  echo "make-icons: missing master $master" >&2
  exit 1
fi
if ! command -v magick >/dev/null 2>&1; then
  echo "make-icons: ImageMagick (magick) not found on PATH" >&2
  exit 1
fi

src_w=$(magick identify -format '%w' "$master")
src_h=$(magick identify -format '%h' "$master")

resize() {
  size=$1
  out=$2
  if [ "$size" -gt "$src_w" ] || [ "$size" -gt "$src_h" ]; then
    echo "skip $out: master is ${src_w}x${src_h} (< ${size})" >&2
    return 0
  fi
  mkdir -p "$(dirname -- "$out")"
  # PNG32 forces 8-bit RGBA so small sizes are not palettised (keeps alpha).
  magick "$master" -filter Lanczos -resize "${size}x${size}" "PNG32:$out"
  echo "wrote $out (${size}x${size})"
}

mkdir -p "$root/src-tauri/icons" "$root/src/assets"

resize 32 "$root/src-tauri/icons/32x32.png"
resize 48 "$root/src-tauri/icons/48x48.png"
resize 64 "$root/src-tauri/icons/64x64.png"
resize 128 "$root/src-tauri/icons/128x128.png"
# `icon.png` is the 256px variant. Tauri's `128x128@2x.png` is deliberately
# not produced: its `@2x` suffix makes the deb bundler write an invalid
# `hicolor/256x256@2/` directory (verified), and `icon.png` already covers 256.
resize 256 "$root/src-tauri/icons/icon.png"
# In-app mark (ActivityBar / Onboarding), kept small.
resize 64 "$root/src/assets/nueon-64.png"
