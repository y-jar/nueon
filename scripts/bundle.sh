#!/usr/bin/env sh
# Build the Linux release bundles (AppImage, deb, rpm) and copy each package,
# separately, into an output directory (default ~/downloads/nueon-<version>).
# Prints the resulting paths so they can be copied/attached individually.
#
# .deb and .rpm build on any system; the .AppImage needs an FHS (with /bin/bash)
# that NixOS lacks, so it is attempted but a failure is reported, not fatal.
#
# Usage: bundle.sh [output-dir]
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=${BUNDLE_ROOT:-$(CDPATH= cd -- "$here/.." && pwd)}
cd "$root"

version=$(node -p "require('./src-tauri/tauri.conf.json').version")
out=${1:-$HOME/downloads/nueon-$version}

echo "bundle: building deb + rpm for v$version"
npm run tauri build -- --bundles deb,rpm

# The AppImage bundler shells out to linuxdeploy + plugin scripts that need an
# FHS (/bin/bash). NixOS only provides /bin/sh, so this step fails locally and
# is reported rather than aborting the run — CI's Ubuntu runner builds it.
echo "bundle: attempting AppImage (needs an FHS with /bin/bash)"
if APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri build -- --bundles appimage; then
  echo "bundle: AppImage built"
else
  echo "bundle: AppImage skipped — NixOS has no /bin/bash; CI builds it"
fi

mkdir -p "$out"

for dir in target/release/bundle src-tauri/target/release/bundle; do
  [ -d "$dir" ] || continue
  find "$dir" -type f \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
    -exec cp -v {} "$out/" \;
done

( cd "$out" && for p in *.AppImage *.deb *.rpm; do
    [ -f "$p" ] && sha256sum "$p"
  done > SHA256SUMS )

echo
echo "bundle: packages in $out"
for p in "$out"/*.AppImage "$out"/*.deb "$out"/*.rpm; do
  [ -f "$p" ] && echo "$p"
done
