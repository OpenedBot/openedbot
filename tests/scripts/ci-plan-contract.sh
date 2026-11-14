#!/usr/bin/env bash
set -euo pipefail

# Offline contract for .github/scripts/ci-plan.sh and the two workflows that
# call it, on a throwaway repository and a fake `gh`:
#   - a scope is true only when a changed file matches it, a rename counting
#     on both sides;
#   - a push is `validated` only by the newest pull request run on its tree,
#     green, whose head contains the commit the push started from;
#   - whatever cannot be diffed or looked up falls back to a full run;
#   - the scopes written in core-ci.yml and edge-setup-ci.yml send each kind
#     of change to the jobs it can break;
#   - the verdict of each `ci-ok` job fails whenever a job the plan asked for
#     did not succeed.

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/ci-plan.sh"
workflows="$root/.github/workflows"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fake_bin="$work/bin"
repo="$work/repo"
mkdir -p "$fake_bin" "$repo"

fail() {
  printf 'ci-plan contract failed: %s\n' "$1" >&2
  exit 1
}

command -v jq >/dev/null || fail "jq is required (the ci-ok jobs run it)"

# gh api: the run list answers FAKE_RUNS (one "sha<TAB>conclusion<TAB>url" per
# line, newest first) or fails with FAKE_RUNS_FAIL=1; a commit lookup answers
# FAKE_TREE_<sha>; a comparison answers FAKE_BEHIND_<sha>. Unset: failure.
cat > "$fake_bin/gh" <<'GH'
#!/bin/bash
[ "$1" = api ] || exit 64
case "$2" in
  repos/acme/app/actions/workflows/core-ci.yml/runs\?event=pull_request\&per_page=30)
    [ "${FAKE_RUNS_FAIL:-0}" = 0 ] || exit 1
    printf '%s' "${FAKE_RUNS:-}"
    ;;
  repos/acme/app/git/commits/*)
    var="FAKE_TREE_${2##*/}"
    [ -n "${!var:-}" ] || exit 1
    printf '%s\n' "${!var}"
    ;;
  repos/acme/app/compare/*...*)
    var="FAKE_BEHIND_${2##*...}"
    [ -n "${!var:-}" ] || exit 1
    printf '%s\n' "${!var}"
    ;;
  *) exit 64 ;;
esac
GH
chmod +x "$fake_bin/gh"

git_repo() {
  git -C "$repo" -c user.name=ci -c user.email=ci@example.invalid -c commit.gpgsign=false "$@"
}

commit_file() {
  mkdir -p "$repo/$(dirname "$1")"
  printf '%s\n' "$2" > "$repo/$1"
  git_repo add -A
  git_repo commit -q -m "$1"
  git_repo rev-parse HEAD
}

git_repo init -q -b main
base="$(commit_file README.md base)"

git_repo checkout -q -b feature
console="$(commit_file apps/console/src/app.tsx one)"
desktop="$(commit_file apps/desktop-tauri/src-tauri/src/main.rs two)"
mkdir -p "$repo/tools"
git_repo mv apps/desktop-tauri/src-tauri/src/main.rs tools/main.rs
git_repo commit -q -m "move out of the shell"
moved="$(git_repo rev-parse HEAD)"

# The squash of `feature` (up to `desktop`) on main: another commit, the same tree.
git_repo checkout -q main
squash="$(git_repo commit-tree "$desktop^{tree}" -p "$base" -m squash)"
tree="$(git_repo rev-parse "$squash^{tree}")"

# main moved on its own, then a commit brought it to the tree of `feature`,
# whose head never contained that move.
git_repo checkout -q -b drift "$base"
aside="$(commit_file hotfix.txt aside)"
reverted="$(git_repo commit-tree "$desktop^{tree}" -p "$aside" -m "back to the feature tree")"
git_repo checkout -q main

run_url=https://example.invalid/runs
row() { printf '%s\t%s\t%s/%s\n' "$1" "$2" "$run_url" "$3"; }

scopes=('desktop=^apps/desktop-tauri/' 'edge=^edge-setup/')

plan() {
  (
    cd "$repo"
    PATH="$fake_bin:$PATH" GITHUB_OUTPUT="$work/output" WORKFLOW=core-ci.yml GH_REPO=acme/app \
      "$script" "$@" > "$work/log" 2>&1
  )
}

expect() {
  local label="$1"
  shift
  local want
  want="$(printf '%s\n' "$@")"
  [ "$(cat "$work/output")" = "$want" ] || {
    cat "$work/log" >&2
    fail "$label: got $(tr '\n' ' ' < "$work/output"), want $*"
  }
}

run() {
  : > "$work/output"
  plan "${scopes[@]}" || { cat "$work/log" >&2; fail "exit status $?"; }
}

# ── Scopes ───────────────────────────────────────────────────────────────────

# A pull request touching the console only: no scope.
EVENT=pull_request BASE="$base" HEAD="$console" run
expect "console pull request" validated=false desktop=false edge=false

# A pull request reaching the desktop shell.
EVENT=pull_request BASE="$base" HEAD="$desktop" run
expect "desktop pull request" validated=false desktop=true edge=false

# A file moved out of the shell changed the shell.
EVENT=pull_request BASE="$desktop" HEAD="$moved" run
expect "rename out of a scope" validated=false desktop=true edge=false

# A pull request whose base commit is not in the clone: everything.
EVENT=pull_request BASE=1111111111111111111111111111111111111111 HEAD="$desktop" run
expect "missing base" validated=false desktop=true edge=true

# A manual run: everything.
EVENT=workflow_dispatch run
expect "manual run" validated=false desktop=true edge=true

# ── Validated trees ──────────────────────────────────────────────────────────

# A push no pull request passed on: the diff of the push decides.
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$base" success 1)" run
expect "unvalidated push" validated=false desktop=true edge=false

# The first push of a branch, nothing to start from: everything, no lookup.
EVENT=push BEFORE=0000000000000000000000000000000000000000 AFTER="$squash" FAKE_RUNS="$(row "$desktop" success 1)" run
expect "first push" validated=false desktop=true edge=true

# The squash of a head the newest run on that tree passed on: validated.
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$base" failure 3; row "$desktop" success 2; row "$desktop" failure 1)" run
expect "validated push" validated=true desktop=false edge=false
grep -q "already validated by $run_url/2 (head $desktop)" "$work/log" || fail "validated push: the log does not give the run"

# An older green run does not outlive a newer red or unfinished one.
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$desktop" failure 2; row "$desktop" success 1)" run
expect "newer red run" validated=false desktop=true edge=false
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$desktop" unfinished 2; row "$desktop" success 1)" run
expect "newer unfinished run" validated=false desktop=true edge=false

# The same tree, but the head never contained where main was: it was tested
# merged into something else.
EVENT=push BEFORE="$aside" AFTER="$reverted" FAKE_RUNS="$(row "$desktop" success 1)" run
expect "head without the previous commit" validated=false desktop=true edge=false
grep -q "does not contain $aside" "$work/log" || fail "head without the previous commit: the log does not say why"

# A head known through the API only: its tree and its ancestry both asked.
gone=2222222222222222222222222222222222222222
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$gone" success 1)" \
  FAKE_TREE_2222222222222222222222222222222222222222="$tree" FAKE_BEHIND_2222222222222222222222222222222222222222=0 run
expect "validated push through the API" validated=true desktop=false edge=false
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$gone" success 1)" \
  FAKE_TREE_2222222222222222222222222222222222222222="$tree" FAKE_BEHIND_2222222222222222222222222222222222222222=2 run
expect "API head behind the previous commit" validated=false desktop=true edge=false
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$gone" success 1)" \
  FAKE_TREE_2222222222222222222222222222222222222222="$tree" run
expect "API ancestry unavailable" validated=false desktop=true edge=false

# A newer head whose tree cannot be read hides nothing: not validated.
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS="$(row "$gone" failure 2; row "$desktop" success 1)" run
expect "unknown newer head" validated=false desktop=true edge=false

# The run list is unreachable: not validated, the diff decides.
EVENT=push BEFORE="$base" AFTER="$squash" FAKE_RUNS_FAIL=1 run
expect "unreachable API" validated=false desktop=true edge=false

# A pull request event never looks validated trees up.
EVENT=pull_request BASE="$base" HEAD="$desktop" FAKE_RUNS="$(row "$desktop" success 1)" run
expect "pull request with a matching tree" validated=false desktop=true edge=false

# ── Refusals ─────────────────────────────────────────────────────────────────

for bad in 'desktop' 'validated=x' 'Desk=x' '9a=x'; do
  : > "$work/output"
  status=0
  EVENT=workflow_dispatch plan "$bad" || status=$?
  [ "$status" = 2 ] || fail "'$bad' accepted (exit $status)"
  [ ! -s "$work/output" ] || fail "'$bad' wrote an output"
done
: > "$work/output"
status=0
EVENT=pull_request BASE="$base" HEAD="$desktop" plan 'desktop=(' || status=$?
[ "$status" = 2 ] || fail "bad regex accepted (exit $status)"

# ── The scopes the workflows really pass ─────────────────────────────────────

# The 'name=regex' arguments of the ci-plan.sh call, one per line.
workflow_scopes() {
  sed -n "s/^ *'\([a-z_]*=.*\)'\$/\1/p" "$workflows/$1"
}

# scope_of WORKFLOW PATH: the scopes a change to PATH turns on, space separated.
scope_of() {
  local specs=() spec head
  while IFS= read -r spec; do specs+=("$spec"); done < <(workflow_scopes "$1")
  [ "${#specs[@]}" -gt 0 ] || fail "$1: no scope found"
  git_repo checkout -q -B probe "$base"
  head="$(commit_file "$2" probe)"
  git_repo checkout -q main
  : > "$work/output"
  EVENT=pull_request BASE="$base" HEAD="$head" plan "${specs[@]}" || { cat "$work/log" >&2; fail "$1 scopes rejected"; }
  sed -n 's/^\(.*\)=true$/\1/p' "$work/output" | tr '\n' ' ' | sed 's/ $//'
}

expect_scopes() {
  local got
  got="$(scope_of "$1" "$2")"
  [ "$got" = "$3" ] || fail "$1: $2 turns on '$got', want '$3'"
}

expect_scopes core-ci.yml apps/desktop-tauri/src-tauri/src/main.rs "desktop_mac desktop_linux"
expect_scopes core-ci.yml contracts/native-bridge/src/bindings.ts "desktop_mac desktop_linux"
expect_scopes core-ci.yml .github/workflows/core-ci.yml "desktop_mac desktop_linux"
expect_scopes core-ci.yml apps/console/src/screens/auth/login.tsx "desktop_linux"
expect_scopes core-ci.yml browser/ui-kit/src/button.tsx "desktop_linux"
expect_scopes core-ci.yml contracts/i18n/src/messages/fr/auth.ts "desktop_linux"
expect_scopes core-ci.yml bun.lock "desktop_linux"
expect_scopes core-ci.yml Makefile "desktop_linux"
expect_scopes core-ci.yml apps/api/src/server.ts ""
expect_scopes core-ci.yml edge-setup/cmd/edge-setup/main.go ""
expect_scopes core-ci.yml docs/src/content/docs/fr/index.mdx ""

expect_scopes edge-setup-ci.yml edge-setup/internal/connector/client.go "go contract"
expect_scopes edge-setup-ci.yml .github/workflows/edge-setup-ci.yml "go contract"
expect_scopes edge-setup-ci.yml docs/public/install "docs"
expect_scopes edge-setup-ci.yml platform/hermes/src/transport/relay.ts "contract"
expect_scopes edge-setup-ci.yml contracts/connector/src/features.ts "contract"
expect_scopes edge-setup-ci.yml protocol/connector/src/allowlist.ts "contract"
expect_scopes edge-setup-ci.yml bun.lock "contract"
expect_scopes edge-setup-ci.yml apps/console/src/app.tsx ""
expect_scopes edge-setup-ci.yml apps/desktop-tauri/src-tauri/src/main.rs ""

# ── The verdict of each ci-ok job ────────────────────────────────────────────

# The jq program between `jq -e '` and `' > /dev/null` in a workflow.
verdict_program() {
  sed -n "/jq -e '\$/,/' > \/dev\/null\$/p" "$workflows/$1" | sed "1d;s/' > \/dev\/null\$//"
}

# needs JOB RESULT [OUTPUT=VALUE,...] ...: the `needs` context as JSON.
needs() {
  local json='{}' job result outputs
  while [ "$#" -gt 0 ]; do
    job="$1" result="$2" outputs="$3"
    shift 3
    json="$(jq -c --arg job "$job" --arg result "$result" --arg outputs "$outputs" \
      '.[$job] = {result: $result, outputs: ($outputs | split(",") | map(select(length > 0) | split("=") | {(.[0]): .[1]}) | add // {})}' <<<"$json")"
  done
  printf '%s\n' "$json"
}

verdict() {
  local workflow="$1" want="$2" label="$3" program got=pass
  shift 3
  program="$(verdict_program "$workflow")"
  [ -n "$program" ] || fail "$workflow: no ci-ok verdict found"
  needs "$@" | jq -e "$program" > /dev/null 2>&1 || got=fail
  [ "$got" = "$want" ] || fail "$workflow verdict, $label: $got, want $want"
}

core="core-ci.yml"
verdict "$core" pass "nothing desktop" plan success validated=false,desktop_mac=false,desktop_linux=false \
  checks success "" integration success "" desktop-tauri skipped "" desktop-linux skipped ""
verdict "$core" pass "console change" plan success validated=false,desktop_mac=false,desktop_linux=true \
  checks success "" integration success "" desktop-tauri skipped "" desktop-linux success ""
verdict "$core" pass "shell change" plan success validated=false,desktop_mac=true,desktop_linux=true \
  checks success "" integration success "" desktop-tauri success "" desktop-linux success ""
verdict "$core" fail "macOS asked for, skipped" plan success validated=false,desktop_mac=true,desktop_linux=true \
  checks success "" integration success "" desktop-tauri skipped "" desktop-linux success ""
verdict "$core" fail "Linux asked for, failed" plan success validated=false,desktop_mac=false,desktop_linux=true \
  checks success "" integration success "" desktop-tauri skipped "" desktop-linux failure ""
verdict "$core" fail "checks failed" plan success validated=false,desktop_mac=false,desktop_linux=false \
  checks failure "" integration success "" desktop-tauri skipped "" desktop-linux skipped ""
verdict "$core" fail "integration cancelled" plan success validated=false,desktop_mac=false,desktop_linux=false \
  checks success "" integration cancelled "" desktop-tauri skipped "" desktop-linux skipped ""
verdict "$core" fail "checks skipped" plan success validated=false,desktop_mac=false,desktop_linux=false \
  checks skipped "" integration success "" desktop-tauri skipped "" desktop-linux skipped ""
verdict "$core" fail "plan failed" plan failure "" \
  checks skipped "" integration skipped "" desktop-tauri skipped "" desktop-linux skipped ""
verdict "$core" fail "a scope missing from the plan" plan success validated=false,desktop_mac=false \
  checks success "" integration success "" desktop-tauri skipped "" desktop-linux skipped ""

edge="edge-setup-ci.yml"
verdict "$edge" pass "nothing relevant" changes success validated=false,go=false,docs=false,contract=false \
  checks skipped "" contract skipped "" e2e skipped ""
verdict "$edge" pass "Go change" changes success validated=false,go=true,docs=false,contract=true \
  checks success "" contract success "" e2e success ""
verdict "$edge" pass "docs only" changes success validated=false,go=false,docs=true,contract=false \
  checks success "" contract skipped "" e2e skipped ""
verdict "$edge" pass "contract only" changes success validated=false,go=false,docs=false,contract=true \
  checks skipped "" contract success "" e2e skipped ""
verdict "$edge" fail "E2E skipped behind failed checks" changes success validated=false,go=true,docs=false,contract=true \
  checks failure "" contract success "" e2e skipped ""
verdict "$edge" fail "E2E failed" changes success validated=false,go=true,docs=false,contract=true \
  checks success "" contract success "" e2e failure ""
verdict "$edge" fail "contract asked for, skipped" changes success validated=false,go=false,docs=false,contract=true \
  checks skipped "" contract skipped "" e2e skipped ""
verdict "$edge" fail "changes failed" changes failure "" \
  checks skipped "" contract skipped "" e2e skipped ""
verdict "$edge" fail "a scope missing" changes success validated=false,go=true,docs=false \
  checks success "" contract skipped "" e2e success ""

printf 'ci-plan contract held.\n'
