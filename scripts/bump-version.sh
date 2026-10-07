#!/usr/bin/env sh
# Set the app version everywhere it is stored. Defaults to today's date as
# YY.M.D. Does not commit or tag; run `loom-gates`, then tag and push.
#
# Usage: bump-version.sh [YY.M.D]
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/version-lib.sh
. "$here/version-lib.sh"

root=${VERSION_ROOT:-$(CDPATH= cd -- "$here/.." && pwd)}
version=${1:-}
if [ -z "$version" ]; then
  version=$(date +%y.%-m.%-d)
fi
version_valid "$version" || {
  echo "bump-version: '$version' is not YY.M.D with no zero padding" >&2
  exit 1
}

cd "$root"

# Cargo.toml [workspace.package] version (the only version line there).
sed -i.bak 's/^version = "[^"]*"/version = "'"$version"'"/' Cargo.toml && rm -f Cargo.toml.bak

# Tauri config.
sed -i.bak 's/"version": "[^"]*"/"version": "'"$version"'"/' \
  src-tauri/tauri.conf.json && rm -f src-tauri/tauri.conf.json.bak

# package.json + package-lock.json (root and packages[""]). Prefer npm; fall
# back to a direct edit if npm refuses (e.g. a dirty tree without a git repo).
if ! npm version "$version" --no-git-tag-version --allow-same-version >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const version = process.argv[1];
    for (const file of ["package.json", "package-lock.json"]) {
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      json.version = version;
      if (json.packages && json.packages[""]) json.packages[""].version = version;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    }
  ' "$version"
fi

# Every version = "..." in flake.nix (frontend, packages.default, nueon-bin).
sed -i.bak 's/version = "[^"]*";/version = "'"$version"'";/' flake.nix && rm -f flake.nix.bak

# Let Cargo re-resolve the workspace members so Cargo.lock records the version.
cargo check --quiet

echo "bump-version: set the app version to $version"
echo "bump-version: updated Cargo.toml, Cargo.lock, package.json, package-lock.json, src-tauri/tauri.conf.json, flake.nix"
echo "bump-version: next run './scripts/check-version.sh', 'gates', then tag v$version"
