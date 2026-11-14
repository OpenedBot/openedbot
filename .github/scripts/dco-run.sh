#!/usr/bin/env bash
# Runs the DCO check with the enforcement code taken from the trusted base
# revision, so a pull request cannot pass by editing the checker or the
# adoption baseline it is judged by.
#
#   dco-run.sh <base-sha> <head-sha>      (from the repository root)
#
# Bootstrap: only when the base revision has no checker yet (the adoption pull
# request itself), the pull request's own copy is used, once, with a notice.
# CODEOWNERS must protect .github/, so changes to these files are reviewed.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: dco-run.sh <base-sha> <head-sha>" >&2
  exit 2
fi
base="$1"
head="$2"

if git cat-file -e "$base:.github/scripts/dco-check.sh" 2>/dev/null; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  git show "$base:.github/scripts/dco-check.sh" > "$tmp/dco-check.sh"
  if ! git show "$base:.github/dco-baseline" > "$tmp/dco-baseline" 2>/dev/null; then
    echo "dco-run: the base revision has a checker but no .github/dco-baseline" >&2
    exit 2
  fi
  DCO_BASELINE_FILE="$tmp/dco-baseline" bash "$tmp/dco-check.sh" "$base" "$head"
else
  echo "NOTICE: the base revision has no DCO checker yet. This is the one-time" \
    "bootstrap: using the checker and baseline of this pull request." >&2
  bash .github/scripts/dco-check.sh "$base" "$head"
fi
