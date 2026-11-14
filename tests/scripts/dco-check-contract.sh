#!/usr/bin/env bash
set -euo pipefail

# Offline contract for .github/scripts/dco-check.sh on a throwaway repository:
#   - commits signed off by their author pass;
#   - an unsigned commit, a sign-off by someone else, a sign-off with another
#     email, or a "Signed-off-by" sentence in the body (not a trailer) fails,
#     and the error names the commit and the fix;
#   - merge commits are not checked;
#   - an empty range passes; a missing argument or an unknown SHA exits 2;
#   - dco.yml runs on pull requests, read-only, with the full history.

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/.github/scripts/dco-check.sh"
runner="$root/.github/scripts/dco-run.sh"
workflow="$root/.github/workflows/dco.yml"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
repo="$work/repo"
mkdir -p "$repo"

fail() {
  printf 'dco-check contract failed: %s\n' "$1" >&2
  exit 1
}

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME="Ada Dev" GIT_AUTHOR_EMAIL="ada@example.com"
export GIT_COMMITTER_NAME="Ada Dev" GIT_COMMITTER_EMAIL="ada@example.com"

git -C "$repo" init -q -b main
git -C "$repo" config commit.gpgsign false
n=0
# commit <message> [extra git commit args...]: a new file content each time.
commit() {
  n=$((n + 1))
  echo "$n" > "$repo/file-$n"
  git -C "$repo" add -A
  local msg="$1"
  shift
  git -C "$repo" commit -q -m "$msg" "$@"
}
head_sha() { git -C "$repo" rev-parse HEAD; }
run() { (cd "$repo" && bash "$script" "$@"); }

# Commits before the baseline are unsigned on purpose (case 0 below).
export DCO_BASELINE_FILE="$work/baseline"
commit "chore: base"
base="$(head_sha)"
commit "chore: old unsigned history"
printf '%s\n' "$(head_sha)" > "$DCO_BASELINE_FILE"
old_tip="$(head_sha)"

# 0. Unsigned commits at or before the baseline pass; one after it fails.
run "$(git -C "$repo" rev-list --max-parents=0 HEAD)" "$old_tip" > "$work/out" 2>&1 || fail "unsigned commits before the baseline were refused"
commit "feat: unsigned after the baseline"
if run "$old_tip" "$(head_sha)" > "$work/out" 2>&1; then fail "unsigned commit after the baseline was accepted"; fi
git -C "$repo" reset -q --hard "$old_tip"

# 1. Signed by the author: passes.
commit "feat: signed" -s
commit "fix: signed too" -s
run "$base" "$(head_sha)" > "$work/out" 2>&1 || fail "signed commits were refused"
grep -q "passed" "$work/out" || fail "no success line for signed commits"

# 2. Unsigned: fails, names the commit and the fix, spares the signed ones.
commit "feat: forgot the sign-off"
if run "$base" "$(head_sha)" > "$work/out" 2>&1; then fail "unsigned commit was accepted"; fi
grep -q "forgot the sign-off" "$work/out" || fail "offending commit not listed"
grep -q "git commit --amend -s" "$work/out" || fail "fix command not shown"
if grep -q "feat: signed" "$work/out"; then fail "a signed commit was listed as offending"; fi

# 3. Sign-off by someone else: fails.
commit "feat: someone else signed" --trailer "Signed-off-by: Bob Other <ada@example.com>"
if run "$(git -C "$repo" rev-parse HEAD~1)" "$(head_sha)" > "$work/out" 2>&1; then
  fail "a sign-off with another name was accepted"
fi

# 4. Same name, different email: fails.
commit "feat: other email" --trailer "Signed-off-by: Ada Dev <other@example.com>"
if run "$(git -C "$repo" rev-parse HEAD~1)" "$(head_sha)" > "$work/out" 2>&1; then
  fail "a sign-off with another email was accepted"
fi

# 5. A sentence in the body that merely starts like a sign-off is not a trailer.
commit "feat: prose" -m "Signed-off-by: Ada Dev <ada@example.com> is required, said the guide.
And more text after."
if run "$(git -C "$repo" rev-parse HEAD~1)" "$(head_sha)" > "$work/out" 2>&1; then
  fail "a non-trailer sign-off was accepted"
fi

# 6. Merge commits are not checked (the merge itself is unsigned here).
git -C "$repo" checkout -q -b side "$base"
commit "feat: side signed" -s
git -C "$repo" checkout -q -B main "$base"
commit "feat: main signed" -s
git -C "$repo" merge -q --no-ff --no-edit side -m "Merge side"
run "$base" "$(head_sha)" > "$work/out" 2>&1 || fail "an unsigned merge commit was refused"

# 7. Empty range passes; a missing argument or an unknown SHA exits 2.
run "$(head_sha)" "$(head_sha)" > "$work/out" 2>&1 || fail "an empty range was refused"
set +e
run "$base" > "$work/out" 2>&1
code=$?
[ "$code" = 2 ] || fail "missing argument exited $code, expected 2"
run "$base" 0000000000000000000000000000000000000000 > "$work/out" 2>&1
code=$?
[ "$code" = 2 ] || fail "unknown SHA exited $code, expected 2"
set -e

# 7b. A bad baseline is an error, not a skip.
set +e
rm -f "$DCO_BASELINE_FILE"
run "$base" "$(head_sha)" > "$work/out" 2>&1
[ "$?" = 2 ] || fail "a missing baseline file did not exit 2"
echo "not-a-sha" > "$DCO_BASELINE_FILE"
run "$base" "$(head_sha)" > "$work/out" 2>&1
[ "$?" = 2 ] || fail "a malformed baseline did not exit 2"
echo 1111111111111111111111111111111111111111 > "$DCO_BASELINE_FILE"
run "$base" "$(head_sha)" > "$work/out" 2>&1
[ "$?" = 2 ] || fail "an unknown baseline commit did not exit 2"
set -e

# 7c. A .mailmap that rewrites the author does not break a valid sign-off.
git -C "$repo" reset -q --hard "$old_tip"
printf 'Ada Mapped <mapped@example.com> Ada Dev <ada@example.com>\n' > "$repo/.mailmap"
git -C "$repo" add .mailmap
git -C "$repo" commit -q -s -m "chore: mailmap" 
commit "feat: signed under a mailmap" -s
export DCO_BASELINE_FILE="$work/baseline"
printf '%s\n' "$old_tip" > "$DCO_BASELINE_FILE"
run "$old_tip" "$(head_sha)" > "$work/out" 2>&1 || fail "a .mailmap broke a valid sign-off"
rm -f "$repo/.mailmap"

# 7d. dco-run.sh judges with the checker and baseline of the base revision.
rr="$work/runrepo"
mkdir -p "$rr/.github/scripts"
git -C "$rr" init -q -b main
git -C "$rr" config commit.gpgsign false
echo old > "$rr/old"
git -C "$rr" add -A
git -C "$rr" commit -q -m "chore: old unsigned history"
rold="$(git -C "$rr" rev-parse HEAD)"
rcommit() { # rcommit <message> [git commit args]
  n=$((n + 1))
  echo "$n" > "$rr/f-$n"
  git -C "$rr" add -A
  local msg="$1"
  shift
  git -C "$rr" commit -q -m "$msg" "$@"
}
rrun() { (cd "$rr" && unset DCO_BASELINE_FILE && bash "$runner" "$@"); }
rhead() { git -C "$rr" rev-parse HEAD; }

# Bootstrap: the base has no checker, the pull request brings it.
rbase0="$rold"
cp "$script" "$rr/.github/scripts/dco-check.sh"
printf '%s\n' "$rold" > "$rr/.github/dco-baseline"
rcommit "ci: add the DCO check" -s
rrun "$rbase0" "$(rhead)" > "$work/out" 2>&1 || fail "the bootstrap pull request was refused"
grep -q "one-time" "$work/out" || fail "no bootstrap notice"
rcommit "feat: unsigned in the bootstrap pull request"
if rrun "$rbase0" "$(rhead)" > "$work/out" 2>&1; then fail "an unsigned bootstrap commit was accepted"; fi
git -C "$rr" reset -q --hard HEAD~1
rbase="$(rhead)" # from here on the base has a checker and a baseline

# A signed commit passes without any bootstrap notice.
rcommit "feat: signed" -s
rrun "$rbase" "$(rhead)" > "$work/out" 2>&1 || fail "a signed pull request was refused"
if grep -q "one-time" "$work/out"; then fail "bootstrap notice on a normal pull request"; fi
git -C "$rr" reset -q --hard "$rbase"

# An unsigned commit whitelisted by a signed commit that rewrites the baseline
# fails: the baseline of the base revision is the one that counts.
rcommit "feat: unsigned"
unsigned="$(rhead)"
printf '%s\n' "$unsigned" > "$rr/.github/dco-baseline"
rcommit "ci: move the baseline" -s
(cd "$rr" && DCO_BASELINE_FILE="$rr/.github/dco-baseline" bash "$script" "$rbase" "$(rhead)") > "$work/out" 2>&1 \
  || fail "setup: the rewritten baseline should fool the checker alone"
if rrun "$rbase" "$(rhead)" > "$work/out" 2>&1; then fail "a pull request passed by rewriting the baseline"; fi
git -C "$rr" reset -q --hard "$rbase"

# Likewise for a pull request that neuters the checker.
rcommit "feat: unsigned again"
printf '#!/usr/bin/env bash\nexit 0\n' > "$rr/.github/scripts/dco-check.sh"
rcommit "ci: neuter the checker" -s
if rrun "$rbase" "$(rhead)" > "$work/out" 2>&1; then fail "a pull request passed by editing the checker"; fi
git -C "$rr" reset -q --hard "$rbase"

# A base with a checker but no baseline is an error.
git -C "$rr" rm -q .github/dco-baseline
git -C "$rr" commit -q -m "chore: drop the baseline"
nobl="$(rhead)"
rcommit "feat: signed" -s
set +e
rrun "$nobl" "$(rhead)" > "$work/out" 2>&1
[ "$?" = 2 ] || fail "a base without baseline did not exit 2"
set -e

# 8. The workflow: pull requests, read-only, full history, no secrets, only
# actions/checkout pinned by full SHA.
grep -q '^  pull_request:' "$workflow" || fail "dco.yml must run on pull_request"
grep -q 'contents: read' "$workflow" || fail "dco.yml must be read-only"
grep -q 'dco-run.sh' "$workflow" || fail "dco.yml must go through dco-run.sh"
grep -q 'fetch-depth: 0' "$workflow" || fail "dco.yml must fetch the full history"
if grep -q 'secrets\.' "$workflow"; then fail "dco.yml must not use secrets"; fi
if grep -E '^[[:space:]]*-?[[:space:]]*uses:' "$workflow" | grep -vE 'actions/checkout@[0-9a-f]{40}' | grep -q .; then
  fail "dco.yml may only use actions/checkout, pinned by full SHA"
fi

echo "dco-check contract passed"
