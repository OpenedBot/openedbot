#!/usr/bin/env bash
set -euo pipefail

# Decides what a CI run has to do, so that a run only pays for what the change
# can break (core-ci.yml, edge-setup-ci.yml).
#
#   ci-plan.sh NAME=REGEX [NAME=REGEX...]
#
# Each NAME is a scope: it comes out `true` when a changed file matches REGEX
# (grep -E, one path per line), `false` otherwise. `validated` comes out too:
#
#   validated=true   a push whose tree is exactly the head tree of a pull
#                    request this workflow already passed on (a squash merge of
#                    an up-to-date branch). Nothing is left to prove: every
#                    scope is false and the workflow stops there.
#   validated=false  everything else.
#
# A pull request run tests its head merged into the base, and reports on the
# head. Its result stands for the pushed tree only when all of this holds:
#   - the head has the pushed tree, and so the same workflow definition;
#   - the head contains the commit the push started from, so the merge it was
#     tested as had that very tree;
#   - it is the newest pull request run on that tree, and it succeeded: an
#     older green run never outlives a newer red or unfinished one.
#
# Whatever cannot be diffed (manual run, new branch, missing commit, failing
# diff) makes every scope true, and an unreachable API leaves `validated`
# false: in doubt, the run is a full one.
#
# Renames count on both sides (a file moved out of a scope changed it), and
# paths are compared unquoted.
#
# Environment: EVENT (github.event_name); BASE and HEAD (pull request SHAs);
# BEFORE and AFTER (push SHAs); WORKFLOW (the workflow file name), GH_REPO and
# GH_TOKEN for the lookup of validated trees (`actions: read`); GITHUB_OUTPUT.

zero=0000000000000000000000000000000000000000

emit() {
  printf '%s=%s\n' "$1" "$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  fi
}

has_commit() {
  [ -n "$1" ] && [ "$1" != "$zero" ] && git cat-file -e "$1^{commit}" 2>/dev/null
}

# The tree of a commit: from the local clone when the commit is there, from
# the API otherwise (a squashed branch head is not an ancestor of main).
tree_of() {
  git rev-parse -q --verify "$1^{tree}" 2>/dev/null \
    || gh api "repos/$GH_REPO/git/commits/$1" --jq '.tree.sha'
}

# Whether the commit the push started from is an ancestor of this head.
contains_previous() {
  if git cat-file -e "$1^{commit}" 2>/dev/null; then
    git merge-base --is-ancestor "$BEFORE" "$1"
  else
    [ "$(gh api "repos/$GH_REPO/compare/$BEFORE...$1" --jq '.behind_by')" = 0 ]
  fi
}

validated_tree() {
  local tree runs sha conclusion url other
  if [ -z "${WORKFLOW:-}" ] || [ -z "${GH_REPO:-}" ]; then
    echo "WORKFLOW or GH_REPO missing: validated trees not looked up" >&2
    return 1
  fi
  if ! has_commit "${BEFORE:-}" || ! has_commit "${AFTER:-}"; then
    echo "no previous commit to start from: validated trees not looked up"
    return 1
  fi
  tree="$(git rev-parse "$AFTER^{tree}")"
  # Newest first, whatever the outcome.
  if ! runs="$(gh api "repos/$GH_REPO/actions/workflows/$WORKFLOW/runs?event=pull_request&per_page=30" \
    --jq '.workflow_runs[] | [.head_sha, (.conclusion // "unfinished"), .html_url] | @tsv')"; then
    echo "pull request runs unavailable: validated trees not looked up" >&2
    return 1
  fi
  while IFS=$'\t' read -r sha conclusion url; do
    [ -n "$sha" ] || continue
    if ! other="$(tree_of "$sha")"; then
      echo "tree of $sha unknown ($url): not validated"
      return 1
    fi
    [ "$other" = "$tree" ] || continue
    # The newest run on this tree decides.
    if [ "$conclusion" != success ]; then
      echo "the newest pull request run on tree $tree is $conclusion ($url): not validated"
      return 1
    fi
    if ! contains_previous "$sha"; then
      echo "head $sha does not contain $BEFORE, it was tested merged into another tree ($url): not validated"
      return 1
    fi
    echo "tree $tree of $AFTER was already validated by $url (head $sha)"
    return 0
  done <<<"$runs"
  return 1
}

for spec in "$@"; do
  case "$spec" in
    *=*) ;;
    *) echo "ci-plan: '$spec' is not NAME=REGEX" >&2; exit 2 ;;
  esac
  name="${spec%%=*}"
  if [[ ! "$name" =~ ^[a-z][a-z0-9_]*$ ]] || [ "$name" = validated ]; then
    echo "ci-plan: invalid scope name '$name'" >&2
    exit 2
  fi
done

event="${EVENT:-}"
validated=false
everything=false
range=""

case "$event" in
  pull_request)
    if has_commit "${BASE:-}" && has_commit "${HEAD:-}"; then
      range="$BASE...$HEAD"
    fi
    ;;
  push)
    if validated_tree; then
      validated=true
    elif has_commit "${BEFORE:-}" && has_commit "${AFTER:-}"; then
      range="$BEFORE..$AFTER"
    fi
    ;;
esac

files=""
if [ "$validated" = false ]; then
  if [ -z "$range" ]; then
    echo "no diffable range (${event:-no event}): every scope runs"
    everything=true
  elif files="$(git -c core.quotePath=false diff --name-only --no-renames "$range")"; then
    echo "changed files ($range):"
    printf '%s\n' "$files"
  else
    echo "git diff $range failed: every scope runs"
    everything=true
  fi
fi

emit validated "$validated"
for spec in "$@"; do
  name="${spec%%=*}"
  regex="${spec#*=}"
  if [ "$validated" = true ]; then
    emit "$name" false
  elif [ "$everything" = true ]; then
    emit "$name" true
  else
    # Here-string, not a pipe: under pipefail, grep -q closing early could
    # fail the producer and turn a match into "not relevant".
    status=0
    grep -qE -- "$regex" <<<"$files" || status=$?
    case "$status" in
      0) emit "$name" true ;;
      1) emit "$name" false ;;
      *) echo "ci-plan: invalid regex for '$name'" >&2; exit 2 ;;
    esac
  fi
done
