#!/usr/bin/env sh
# Unit-style tests for the version parsing and ordering helpers. Run by
# loom-gates and CI.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=scripts/version-lib.sh
. "$here/version-lib.sh"

failures=0

check_valid() { # version expected(0/1)
  if version_valid "$1"; then got=1; else got=0; fi
  if [ "$got" = "$2" ]; then
    echo "ok   valid($1) = $got"
  else
    echo "FAIL valid($1) = $got, want $2"
    failures=$((failures + 1))
  fi
}

check_gt() { # a b expected(0/1)
  if version_gt "$1" "$2"; then got=1; else got=0; fi
  if [ "$got" = "$3" ]; then
    echo "ok   gt($1, $2) = $got"
  else
    echo "FAIL gt($1, $2) = $got, want $3"
    failures=$((failures + 1))
  fi
}

# valid date versions (no zero padding on month/day)
check_valid "26.10.6" 1
check_valid "26.8.0" 1
check_valid "26.12.31" 1
check_valid "26.1.1" 1
check_valid "26.1.0" 1
# invalid
check_valid "26.08.6" 0
check_valid "26.10.06" 0
check_valid "26.13.1" 0
check_valid "26.0.1" 0
check_valid "26.10.32" 0
check_valid "0.1.0" 0
check_valid "v26.10.6" 0
check_valid "" 0

# ordering (numeric per part, not as strings)
check_gt "26.10.6" "26.8.19" 1
check_gt "27.1.1" "26.12.31" 1
check_gt "26.8.0" "26.8.19" 0
check_gt "26.10.6" "26.10.6" 0
check_gt "26.12.31" "26.9.1" 1

if [ "$failures" != "0" ]; then
  echo "test-version: FAILED ($failures)"
  exit 1
fi
echo "test-version: all cases passed"
