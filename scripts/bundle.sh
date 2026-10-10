#!/usr/bin/env sh
# Build the Linux release bundles (AppImage, deb, rpm) and copy each package,
# separately, into an output directory (default ~/downloads/nueon-<version>).
# Prints the resulting paths so they can be copied/attached individually.
#
# Usage: bundle.sh [output-dir]
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=${BUNDLE_ROOT:-$(CDPATH= cd -- "$here/.." && pwd)}
cd "$root"

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
out=${1:-$HOME/downloads/nueon-$version}

echo "bundle: building AppImage + deb + rpm for v$version"

# The AppImage toolchain is itself an AppImage; extract-and-run avoids needing
# FUSE in the sandbox.
APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri build -- --bundles appimage,deb,rpm

mkdir -p "$out"

for dir in target/release/bundle src-tauri/target/release/bundle; do
  [ -d "$dir" ] || continue
  find "$dir" -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
    -exec cp -v {} "$out/" \;
done

( cd "$out" && ls -- *.AppImage *.deb *.rpm 2>/dev/null | xargs -r sha256sum > SHA256SUMS )

echo
echo "bundle: packages in $out"
ls -1 "$out"/*.AppImage "$out"/*.deb "$out"/*.rpm 2>/dev/null
