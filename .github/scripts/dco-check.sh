#!/usr/bin/env bash
# Developer Certificate of Origin check.
#
#   dco-check.sh <base-sha> <head-sha>
#
# Every non-merge commit in base..head must carry a `Signed-off-by:` trailer
# whose "Name <email>" equals the commit author's. Exits 1 and lists the
# offending commits otherwise; exits 2 on a usage or git error.
#
# Adoption baseline: history that predates the DCO requirement stays unsigned.
# .github/dco-baseline (override: DCO_BASELINE_FILE) holds one full commit SHA;
# every commit that is that commit or one of its ancestors is skipped. A
# missing, malformed or unknown baseline is an error, never a silent skip.
#
# The workflow runs this script through dco-run.sh, from the base revision, so
# a pull request cannot edit its own judge. CODEOWNERS must protect .github/.
# Authors are compared as written (%an/%ae), not through .mailmap.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: dco-check.sh <base-sha> <head-sha>" >&2
  exit 2
fi
base="$1"
head="$2"

baseline_file="${DCO_BASELINE_FILE:-$(dirname "$0")/../dco-baseline}"
if [ ! -f "$baseline_file" ]; then
  echo "dco-check: baseline file $baseline_file is missing" >&2
  exit 2
fi
baseline="$(tr -d '[:space:]' < "$baseline_file")"
if ! printf '%s' "$baseline" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "dco-check: $baseline_file must hold one full 40-character commit SHA" >&2
  exit 2
fi
if ! git cat-file -e "$baseline^{commit}" 2>/dev/null; then
  echo "dco-check: baseline commit $baseline is not in this history (is it fully fetched?)" >&2
  exit 2
fi

commits="$(git rev-list --no-merges "$base..$head")" || {
  echo "dco-check: cannot list commits in $base..$head (is the history fetched?)" >&2
  exit 2
}

bad=()
total=0
for sha in $commits; do
  if git merge-base --is-ancestor "$sha" "$baseline"; then
    continue
  fi
  total=$((total + 1))
  author="$(git log -1 --format='%an <%ae>' "$sha")"
  trailers="$(git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha")"
  if ! printf '%s\n' "$trailers" | grep -Fxq -- "$author"; then
    bad+=("$(git log -1 --format='%h %s (author: %an <%ae>)' "$sha")")
  fi
done

if [ "${#bad[@]}" -gt 0 ]; then
  echo "DCO check failed: these commits lack a matching Signed-off-by line:" >&2
  printf '  %s\n' "${bad[@]}" >&2
  cat >&2 <<'MSG'

Every commit must be signed off by its author (Developer Certificate of
Origin 1.1, https://developercertificate.org/). The name and email must match
the commit author. Fix it with:

  git commit --amend -s --no-edit       # last commit only
  git rebase --signoff <base-branch>    # every commit of the branch
  git push --force-with-lease           # your own branch only
MSG
  exit 1
fi

echo "DCO check passed: $total commit(s) signed off."
