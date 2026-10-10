#!/usr/bin/env sh
# Every frontend source file must carry a one-line module header — `//!` for
# TypeScript and `<!-- -->` for Svelte — so that `docs/MAP.md` stays complete.
# Fails when a file is missing one.

fail=0

for f in $(find src -type f -name '*.svelte' | sort); do
  head -n 1 "$f" | grep -q '^<!--' || { echo "check-headers: missing <!-- header: $f"; fail=1; }
done

for f in $(find src -type f -name '*.ts' ! -name '*.test.ts' | sort); do
  head -n 1 "$f" | grep -q '^//!' || { echo "check-headers: missing //! header: $f"; fail=1; }
done

if [ "$fail" -ne 0 ]; then
  echo "check-headers: run 'nix-shell --run \"node scripts/gen-map.mjs\"' after adding headers"
  exit 1
fi

echo "check-headers: every source file has a module header"
