#!/usr/bin/env bash
# Exercise scripts/prune-r2.sh: the pure selection (plan) and a run against
# the fake R2 API (fake-r2-curl.sh), seeded with the bucket as it stood on
# 2026-11-13 (fixtures/r2-edge-setup-2026-11-13.keys). No network.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-prune-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
fixture="$root/test/release/fixtures/r2-edge-setup-2026-11-13.keys"

fail() { echo "prune-r2 test: $*" >&2; exit 1; }

plan() { # plan VERSION LATEST PREFIX...: prints the plan, fails like the script
	local version="$1" latest="$2"
	shift 2
	printf '%s\n' "$@" | bash "$root/scripts/prune-r2.sh" plan "$version" "$latest"
}

refused() { # refused MESSAGE VERSION LATEST PREFIX...
	local message="$1"
	shift
	if plan "$@" > "$tmp/out" 2>&1; then fail "plan accepted: $*"; fi
	grep -q "$message" "$tmp/out" || { cat "$tmp/out"; fail "no '$message' for: $*"; }
}

# 1. Plan: the two highest versions by numeric semver stay, the rest goes.
[[ "$(plan v1.5.9 v1.5.9 edge-setup/v1.5.6/ edge-setup/v1.5.7/ edge-setup/v1.5.9/)" == edge-setup/v1.5.6/ ]] || fail "normal case"
[[ -z "$(plan v1.5.9 v1.5.9 edge-setup/v1.5.7/ edge-setup/v1.5.9/)" ]] || fail "two versions: something planned"
# Numeric, not lexical: v1.10.0 is newer than v1.9.0 and v1.2.0.
[[ "$(plan v1.10.0 v1.10.0 edge-setup/v1.2.0/ edge-setup/v1.9.0/ edge-setup/v1.10.0/ | tr '\n' ' ')" == "edge-setup/v1.2.0/ " ]] || fail "semver order"
[[ "$(plan v2.0.0 v2.0.0 edge-setup/v0.0.1/ edge-setup/v1.4.0/ edge-setup/v1.5.6/ edge-setup/v1.10.0/ edge-setup/v2.0.0/ | tr '\n' ' ')" == "edge-setup/v1.5.6/ edge-setup/v1.4.0/ edge-setup/v0.0.1/ " ]] || fail "several old versions"

# 2. Plan refusals: nothing is guessed.
refused 'fewer than 2' v1.5.9 v1.5.9 edge-setup/v1.5.9/
refused 'fewer than 2' v1.5.9 v1.5.9
refused 'unexpected prefix' v1.5.9 v1.5.9 edge-setup/v1.5.7/ edge-setup/v1.5.9/ edge-setup/v1.5.8-rc1/
refused 'unexpected prefix' v1.5.9 v1.5.9 edge-setup/v1.5.7/ edge-setup/v1.5.9/ edge-setup/v01.5.6/
refused 'unexpected prefix' v1.5.9 v1.5.9 edge-setup/v1.5.7/ edge-setup/v1.5.9/ edge-setup/old/
refused 'not v1.5.9 just published' v1.5.9 v1.5.7 edge-setup/v1.5.6/ edge-setup/v1.5.7/ edge-setup/v1.5.9/
refused 'not the highest' v1.5.9 v1.5.9 edge-setup/v1.5.6/ edge-setup/v1.5.9/ edge-setup/v1.6.0/
refused 'not the highest' v1.5.9 v1.5.9 edge-setup/v1.5.6/ edge-setup/v1.5.7/
refused 'twice' v1.5.9 v1.5.9 edge-setup/v1.5.7/ edge-setup/v1.5.9/ edge-setup/v1.5.9/
refused 'LATEST is not a version' v1.5.9 garbage edge-setup/v1.5.7/ edge-setup/v1.5.9/

# 3. Runs against the fake API, seeded with the bucket of 2026-11-13.
setup() {
	rm -rf "$tmp/run" && mkdir -p "$tmp/run/bin" "$tmp/run/store"
	cp "$root/test/release/fake-r2-curl.sh" "$tmp/run/bin/curl"
	chmod +x "$tmp/run/bin/curl"
	while IFS= read -r key; do printf '%s\n' "$key" > "$tmp/run/store/$(printf '%s' "$key" | tr '/' '%')"; done < "$fixture"
	printf 'v1.5.7\n' > "$tmp/run/store/edge-setup%LATEST"
	: > "$tmp/run/log"
}
add_version() { # add_version vX.Y.Z: a complete tree, then LATEST, as publish-r2.sh leaves it
	local f
	for f in edge-setup_linux_amd64 edge-setup_linux_arm64 edge-setup_darwin_amd64 edge-setup_darwin_arm64 install.sh SHA256SUMS; do
		printf '%s\n' "$1/$f" > "$tmp/run/store/edge-setup%$1%$f"
		printf '%s\n' "$1/$f" > "$tmp/run/store/edge-setup%$1%$f.sigstore.json"
	done
	printf '%s\n' "$1" > "$tmp/run/store/edge-setup%LATEST"
}
run_prune() {
	PATH="$tmp/run/bin:$PATH" FAKE_LOG="$tmp/run/log" FAKE_STORE="$tmp/run/store" \
		CLOUDFLARE_API_TOKEN=test-token CF_ACCOUNT_ID=acct-1 R2_BUCKET=openedbot-releases \
		bash "$root/scripts/prune-r2.sh" run "$@"
}
versions_stored() { find "$tmp/run/store" -name 'edge-setup%v*%SHA256SUMS' | sed 's#.*/edge-setup%##; s#%SHA256SUMS##' | LC_ALL=C sort | tr '\n' ' '; }
root_files() { find "$tmp/run/store" -type f | sed 's#.*/##' | grep -vc '^edge-setup%v' || true; }

# 3a. Today's bucket (v1.5.6, v1.5.7, LATEST v1.5.7): nothing to delete.
setup
run_prune v1.5.7 --dry-run > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "dry run on today's bucket failed"; }
grep -q 'nothing to delete' "$tmp/out" || { cat "$tmp/out"; fail "today's bucket: something planned"; }
! grep -q '^DELETE ' "$tmp/run/log" || fail "a dry run deleted"

# 3b. Once v1.5.9 is published: the dry run names v1.5.6 only, deletes nothing.
setup
add_version v1.5.9
roots="$(root_files)"
run_prune v1.5.9 --dry-run > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "dry run after v1.5.9 failed"; }
grep -q 'would delete edge-setup/v1.5.6/$' "$tmp/out" || { cat "$tmp/out"; fail "dry run does not name v1.5.6"; }
! grep -q 'v1.5.7/\|v1.5.9/' "$tmp/out" || { cat "$tmp/out"; fail "dry run names a kept version"; }
! grep -q '^DELETE ' "$tmp/run/log" || fail "a dry run deleted"

# 3c. The real run deletes v1.5.6 (its SHA256SUMS first) and nothing else.
run_prune v1.5.9 > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "pruning after v1.5.9 failed"; }
[[ "$(versions_stored)" == "v1.5.7 v1.5.9 " ]] || fail "kept: $(versions_stored)"
[[ -z "$(find "$tmp/run/store" -name 'edge-setup%v1.5.6%*')" ]] || fail "v1.5.6 left objects"
[[ "$(root_files)" == "$roots" ]] || fail "a root file was deleted"
[[ "$(grep '^DELETE ' "$tmp/run/log" | head -n 1)" == *"/objects/edge-setup/v1.5.6/SHA256SUMS" ]] || fail "SHA256SUMS is not deleted first"
! grep -q '^DELETE .*/edge-setup/v1.5.[79]/\|^DELETE .*/objects/edge-setup/[^v]' "$tmp/run/log" || fail "a kept object was deleted"
# Idempotent: again, nothing to do.
: > "$tmp/run/log"
run_prune v1.5.9 > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "second run failed"; }
grep -q 'nothing to delete' "$tmp/out" || { cat "$tmp/out"; fail "second run planned something"; }

# 3d. A delete that fails half-way stops (exit 2); the next run finishes it.
setup
add_version v1.5.9
if FAKE_FAIL_DELETE=edge-setup/v1.5.6/install.sh run_prune v1.5.9 > "$tmp/out" 2>&1; then fail "a failed delete was ignored"; fi
[[ ! -f "$tmp/run/store/edge-setup%v1.5.6%SHA256SUMS" ]] || fail "the manifest of the half-deleted version survived"
run_prune v1.5.9 > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "resuming the pruning failed"; }
[[ -z "$(find "$tmp/run/store" -name 'edge-setup%v1.5.6%*')" ]] || fail "the resumed run left v1.5.6 objects"

# 3e. Paginated listing: every page is read.
setup
add_version v1.5.9
FAKE_PAGE_SIZE=5 run_prune v1.5.9 > "$tmp/out" 2>&1 || { cat "$tmp/out"; fail "paginated pruning failed"; }
[[ "$(versions_stored)" == "v1.5.7 v1.5.9 " ]] || fail "paginated run kept: $(versions_stored)"
[[ -z "$(find "$tmp/run/store" -name 'edge-setup%v1.5.6%*')" ]] || fail "paginated run left v1.5.6 objects"

# 3f. Refusals of a run delete nothing.
refused_run() { # refused_run MESSAGE ENV=VALUE... -- ARGS
	local message="$1"
	shift
	: > "$tmp/run/log"
	if env "$@" PATH="$tmp/run/bin:$PATH" FAKE_LOG="$tmp/run/log" FAKE_STORE="$tmp/run/store" \
		CLOUDFLARE_API_TOKEN=test-token CF_ACCOUNT_ID=acct-1 R2_BUCKET=openedbot-releases \
		bash "$root/scripts/prune-r2.sh" run v1.5.9 > "$tmp/out" 2>&1; then fail "run accepted ($*)"; fi
	grep -q "$message" "$tmp/out" || { cat "$tmp/out"; fail "no '$message' ($*)"; }
	! grep -q '^DELETE ' "$tmp/run/log" || fail "a refused run deleted ($*)"
}
setup
add_version v1.5.9
refused_run 'listing edge-setup/ failed' FAKE_LIST_FAIL=1
refused_run 'truncated without a cursor' FAKE_PAGE_SIZE=5 FAKE_TRUNCATE_NO_CURSOR=1
printf 'x\n' > "$tmp/run/store/edge-setup%v1.5.8-rc1%SHA256SUMS"
refused_run 'unexpected prefix' FAKE_PAGE_SIZE=1000
rm "$tmp/run/store/edge-setup%v1.5.8-rc1%SHA256SUMS"
printf 'v1.5.7\n' > "$tmp/run/store/edge-setup%LATEST"
refused_run 'not v1.5.9 just published' FAKE_PAGE_SIZE=1000
printf 'v1.5.9\n' > "$tmp/run/store/edge-setup%LATEST"
rm "$tmp/run/store/edge-setup%v1.5.9%SHA256SUMS"
refused_run 'is not stored' FAKE_PAGE_SIZE=1000
[[ -f "$tmp/run/store/edge-setup%v1.5.6%SHA256SUMS" ]] || fail "a refused run lost v1.5.6"

echo "prune-r2 test: OK"
