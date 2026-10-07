#!/usr/bin/env sh
# Shared version helpers. Source this file; do not execute it.
#
# nueon's app version is the release date, YY.M.D, with no zero padding
# (e.g. 26.10.6). A tool that needs three parts still gets three: a "major
# update" label like 26.8 is written 26.8.0.

# YY.M.D: two-digit year, month 1-12, day 0-31, none zero-padded.
VERSION_RE='^[0-9]{2}\.([1-9]|1[0-2])\.(0|[1-9]|[12][0-9]|3[01])$'

# version_valid VERSION — true when VERSION is a well-formed YY.M.D.
version_valid() {
  printf '%s' "$1" | grep -Eq "$VERSION_RE"
}

# _version_part VERSION N — the Nth (1-based) dot-separated part.
_version_part() {
  printf '%s' "$1" | cut -d. -f"$2"
}

# _decimal N — strip leading zeros so `[` parses it as decimal, not octal.
_decimal() {
  stripped=$(printf '%s' "$1" | sed 's/^0*//')
  [ -n "$stripped" ] || stripped=0
  printf '%s' "$stripped"
}

# version_gt A B — true (exit 0) when A > B, comparing each part numerically.
version_gt() {
  a1=$(_decimal "$(_version_part "$1" 1)")
  a2=$(_decimal "$(_version_part "$1" 2)")
  a3=$(_decimal "$(_version_part "$1" 3)")
  b1=$(_decimal "$(_version_part "$2" 1)")
  b2=$(_decimal "$(_version_part "$2" 2)")
  b3=$(_decimal "$(_version_part "$2" 3)")
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -gt "$b3" ] && return 0
  return 1
}

# version_max — read versions on stdin, print the greatest (empty if none).
version_max() {
  max=""
  while IFS= read -r v; do
    [ -n "$v" ] || continue
    if [ -z "$max" ] || version_gt "$v" "$max"; then
      max=$v
    fi
  done
  printf '%s' "$max"
}
