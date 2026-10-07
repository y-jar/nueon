#!/usr/bin/env sh
# Verify the app version is consistent and sane across every file that holds
# it. Run by CI (release.yml with the tag, ci.yml without) and by loom-gates.
#
# Usage: check-version.sh [vTAG]
#   With a tag argument the tag must equal "v" + version (release only).
#
# Set VERSION_ROOT to check a copy elsewhere (used by the self-tests).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/version-lib.sh
. "$here/version-lib.sh"

root=${VERSION_ROOT:-$(CDPATH= cd -- "$here/.." && pwd)}
tag=${1:-}

fail() {
  echo "check-version: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node is required to read the JSON versions"
cd "$root"

# -- read every version ------------------------------------------------------
cargo=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml)
[ -n "$cargo" ] || fail "no [workspace.package] version in Cargo.toml"

pkg=$(node -p "require('./package.json').version")
lock=$(node -p "require('./package-lock.json').version")
lock_pkg=$(node -p "require('./package-lock.json').packages[''].version")
tauri=$(node -p "require('./src-tauri/tauri.conf.json').version")
lock_core=$(awk '$1 == "name" && $3 == "\"nueon-core\"" { getline; gsub(/[",]/, "", $3); print $3; exit }' Cargo.lock)
lock_tauri=$(awk '$1 == "name" && $3 == "\"nueon-tauri\"" { getline; gsub(/[",]/, "", $3); print $3; exit }' Cargo.lock)

[ -n "$lock_core" ] || fail "no nueon-core entry in Cargo.lock"
[ -n "$lock_tauri" ] || fail "no nueon-tauri entry in Cargo.lock"

flake_versions=$(grep -oE 'version = "[^"]*"' flake.nix | sed 's/^version = "//; s/"$//')
[ -n "$flake_versions" ] || fail "no version = \"...\" lines in flake.nix"

# -- all fields must agree ---------------------------------------------------
for field in \
  "package.json:$pkg" \
  "package-lock.json:$lock" \
  "package-lock.json (packages[\"\"]):$lock_pkg" \
  "tauri.conf.json:$tauri" \
  "Cargo.lock nueon-core:$lock_core" \
  "Cargo.lock nueon-tauri:$lock_tauri"; do
  name=${field%%:*}
  value=${field#*:}
  [ "$value" = "$cargo" ] || fail "$name has '$value', expected '$cargo'"
done
for value in $flake_versions; do
  [ "$value" = "$cargo" ] || fail "flake.nix has '$value', expected '$cargo'"
done

# -- pre-release placeholder -------------------------------------------------
# 0.1.0 is allowed only before the first release: no tag argument, and no v*
# tag in the repo yet. Any mismatch above already failed.
if [ "$cargo" = "0.1.0" ]; then
  [ -z "$tag" ] || fail "0.1.0 is the pre-release placeholder; a release tag requires a real date version"
  if [ -n "$(git tag --list 'v*' 2>/dev/null || true)" ]; then
    fail "0.1.0 is the pre-release placeholder but v* tags already exist"
  fi
  echo "check-version: 0.1.0 is the pre-release placeholder (OK until the first bump)"
  exit 0
fi

# -- date form ---------------------------------------------------------------
version_valid "$cargo" || fail "'$cargo' is not YY.M.D with no zero padding"

if [ -n "$tag" ]; then
  [ "$tag" = "v$cargo" ] || fail "tag '$tag' does not match v$cargo"
fi

# -- never go backwards ------------------------------------------------------
highest=$(
  git tag --list 'v*' 2>/dev/null | sed 's/^v//' |
    while IFS= read -r candidate; do
      if version_valid "$candidate"; then printf '%s\n' "$candidate"; fi
    done | version_max
)
if [ -n "$highest" ] && [ "$cargo" != "$highest" ]; then
  version_gt "$cargo" "$highest" ||
    fail "$cargo is not greater than the highest existing tag v$highest"
fi

echo "check-version: $cargo OK (highest v* tag: ${highest:-none})"
