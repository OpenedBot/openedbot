#!/usr/bin/env bash
# Exercise scripts/publish-r2.sh against a fake curl that stands for both the
# Cloudflare API (object writes) and the public origin (read-back). No network.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-publish-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "publish-r2 test: $*" >&2; exit 1; }

setup() {
	rm -rf "$tmp/run" && mkdir -p "$tmp/run/bin" "$tmp/run/dist" "$tmp/run/store"
	for asset in edge-setup_linux_amd64 edge-setup_linux_arm64 hermes-setup_linux_amd64; do
		printf 'binary %s\n' "$asset" > "$tmp/run/dist/$asset"
	done
	(
		cd "$tmp/run/dist"
		if command -v sha256sum >/dev/null 2>&1; then sum=(sha256sum); else sum=(shasum -a 256); fi
		"${sum[@]}" edge-setup_linux_amd64 edge-setup_linux_arm64 hermes-setup_linux_amd64 > SHA256SUMS
	)
	for f in edge-setup_linux_amd64 edge-setup_linux_arm64 hermes-setup_linux_amd64 SHA256SUMS; do
		printf '{"bundle":"%s"}\n' "$f" > "$tmp/run/dist/$f.sigstore.json"
	done
	# The fake curl logs every call. A PUT stores the body under the object key;
	# a GET on the API answers 404 unless the key is stored; a GET on the public
	# origin returns the stored object (what the Worker would serve).
	cat > "$tmp/run/bin/curl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
method=GET url= data= out= header=
while (($#)); do
	case "$1" in
		-X) method="$2"; shift 2 ;;
		--data-binary) data="$2"; shift 2 ;;
		-o) out="$2"; shift 2 ;;
		-H) header="$header $2"; shift 2 ;;
		-w) shift 2 ;;
		-*) shift ;;
		*) url="$1"; shift ;;
	esac
done
printf '%s %s\n' "$method" "$url" >> "$FAKE_LOG"
case "$header" in *"@"*) ;; *) [[ "$url" != https://api.cloudflare.com/* ]] || { echo "token not read from a file" >&2; exit 97; } ;; esac
store="$FAKE_STORE"
case "$url" in
	https://api.cloudflare.com/client/v4/accounts/acct-1/r2/buckets/openedbot-releases/objects/*)
		key="${url#*/objects/}"
		file="$store/$(printf '%s' "$key" | tr '/' '%')"
		if [[ "$method" == PUT ]]; then
			[[ -n "${FAKE_FAIL_KEY:-}" && "$key" == "$FAKE_FAIL_KEY" ]] && { echo '{"success":false,"errors":[{"code":1,"message":"boom"}]}'; exit 0; }
			cp "${data#@}" "$file"; echo '{"success":true}'
		elif [[ -f "$file" ]]; then
			cp "$file" "${out:-/dev/stdout}"; [[ -z "$out" ]] || echo 200
		else
			[[ -z "$out" ]] || { : > "$out"; echo 404; }
		fi ;;
	https://releases.example.test/edge-setup/*)
		key="edge-setup/${url#https://releases.example.test/edge-setup/}"
		file="$store/$(printf '%s' "$key" | tr '/' '%')"
		[[ -f "$file" ]] || exit 22
		cp "$file" "${out:-/dev/stdout}" ;;
	*) echo "unexpected URL $url" >&2; exit 98 ;;
esac
FAKE
	chmod +x "$tmp/run/bin/curl"
	: > "$tmp/run/log"
}

run_publish() {
	PATH="$tmp/run/bin:$PATH" FAKE_LOG="$tmp/run/log" FAKE_STORE="$tmp/run/store" \
		CLOUDFLARE_API_TOKEN=test-token CF_ACCOUNT_ID=acct-1 R2_BUCKET=openedbot-releases \
		RELEASES_BASE=https://releases.example.test/edge-setup \
		bash "$root/scripts/publish-r2.sh" "$@" "$tmp/run/dist"
}

stored() { [[ -f "$tmp/run/store/$(printf '%s' "$1" | tr '/' '%')" ]]; }

# 1. A first publication writes the versioned tree with its signatures, then the
#    unversioned copies, LATEST last, and reads the result back.
setup
run_publish v0.0.1 > "$tmp/run/out" 2>&1 || { cat "$tmp/run/out"; fail "first publication failed"; }
for key in edge-setup/v0.0.1/SHA256SUMS edge-setup/v0.0.1/SHA256SUMS.sigstore.json edge-setup/v0.0.1/edge-setup_linux_amd64 \
	edge-setup/v0.0.1/edge-setup_linux_amd64.sigstore.json edge-setup/SHA256SUMS edge-setup/edge-setup_linux_arm64 edge-setup/hermes-setup_linux_amd64 edge-setup/LATEST; do
	stored "$key" || fail "missing $key"
done
[[ "$(cat "$tmp/run/store/edge-setup%LATEST")" == v0.0.1 ]] || fail "LATEST does not name v0.0.1"
puts="$(grep '^PUT ' "$tmp/run/log" | sed 's#.*/objects/##')"
last_put="$(tail -n 1 <<<"$puts")"
[[ "$last_put" == edge-setup/LATEST ]] || fail "LATEST is not written last (last: $last_put)"
[[ "$(tail -n 2 <<<"$puts" | head -n 1)" == edge-setup/edge-setup.json ]] || fail "the anchor is not written right before LATEST"
[[ "$(tail -n 3 <<<"$puts" | head -n 1)" == edge-setup/SHA256SUMS ]] || fail "the unversioned manifest is not written right before the anchor"
anchor="$tmp/run/store/edge-setup%edge-setup.json"
[[ "$(jq -r '.tool.version' "$anchor")" == v0.0.1 ]] || fail "the anchor does not name v0.0.1"
[[ "$(jq -r '.tool.sha256["edge-setup_linux_amd64"]' "$anchor")" == "$(awk '$2 == "edge-setup_linux_amd64" { print $1 }' "$tmp/run/dist/SHA256SUMS")" ]] || fail "the anchor digest differs from SHA256SUMS"
[[ "$(jq '.tool.sha256 | length' "$anchor")" == "$(grep -c . "$tmp/run/dist/SHA256SUMS")" ]] || fail "the anchor does not list every file of SHA256SUMS"
grep -q '^GET https://releases.example.test/edge-setup/edge-setup.json' "$tmp/run/log" || fail "no public read-back of the anchor"
[[ "$(grep '^edge-setup/v0.0.1/' <<<"$puts" | tail -n 1)" == edge-setup/v0.0.1/SHA256SUMS ]] || fail "the versioned manifest is not the last versioned write"
grep -q '^GET https://releases.example.test/edge-setup/LATEST' "$tmp/run/log" || fail "no public read-back of LATEST"
first_latest="$(grep -n '^edge-setup/[^v]' <<<"$puts" | head -n 1 | cut -d: -f1)"
last_versioned="$(grep -n '^edge-setup/v0.0.1/' <<<"$puts" | tail -n 1 | cut -d: -f1)"
(( last_versioned < first_latest )) || fail "latest written before the versioned tree is complete"
grep -q '^GET https://releases.example.test/edge-setup/v0.0.1/SHA256SUMS' "$tmp/run/log" || fail "no public read-back of the versioned manifest"
grep -q '^GET https://releases.example.test/edge-setup/SHA256SUMS' "$tmp/run/log" || fail "no public read-back of the latest manifest"

# 2. A published version is immutable. The same files again only finish the
#    aliases and never rewrite the versioned tree; other files are refused
#    before any write.
: > "$tmp/run/log"
run_publish v0.0.1 > "$tmp/run/out" 2>&1 || { cat "$tmp/run/out"; fail "rerunning the same v0.0.1 failed"; }
! grep -q '^PUT .*/objects/edge-setup/v0.0.1/' "$tmp/run/log" || fail "a rerun rewrote the versioned tree"
echo changed >> "$tmp/run/dist/edge-setup_linux_amd64"
(
	cd "$tmp/run/dist"
	if command -v sha256sum >/dev/null 2>&1; then sum=(sha256sum); else sum=(shasum -a 256); fi
	"${sum[@]}" edge-setup_linux_amd64 edge-setup_linux_arm64 hermes-setup_linux_amd64 > SHA256SUMS
)
: > "$tmp/run/log"
if run_publish v0.0.1 > "$tmp/run/out" 2>&1; then fail "republishing v0.0.1 with other files was accepted"; fi
grep -q 'already published' "$tmp/run/out" || { cat "$tmp/run/out"; fail "no immutability message"; }
! grep -q '^PUT ' "$tmp/run/log" || fail "a refused republication still wrote objects"

# 2b. A run that failed after the versioned manifest resumes: the versioned
#     tree is checked, not rewritten, and the aliases and LATEST are finished.
setup
if FAKE_FAIL_KEY=edge-setup/LATEST run_publish v0.0.5 > "$tmp/run/out" 2>&1; then fail "a failed LATEST write was ignored"; fi
stored edge-setup/v0.0.5/SHA256SUMS || fail "the versioned manifest was not written before LATEST"
! stored edge-setup/LATEST || fail "LATEST written by the failed run"
: > "$tmp/run/log"
run_publish v0.0.5 > "$tmp/run/out" 2>&1 || { cat "$tmp/run/out"; fail "resuming v0.0.5 failed"; }
! grep -q '^PUT .*/objects/edge-setup/v0.0.5/' "$tmp/run/log" || fail "the resume rewrote the versioned tree"
[[ "$(cat "$tmp/run/store/edge-setup%LATEST")" == v0.0.5 ]] || fail "the resume did not move LATEST"
grep -q '^GET https://releases.example.test/edge-setup/LATEST' "$tmp/run/log" || fail "the resume did not read LATEST back"

# 2c. A resume whose stored binary differs from the verified one, or that would
#     move LATEST back from a newer release, writes nothing.
setup
if FAKE_FAIL_KEY=edge-setup/SHA256SUMS run_publish v0.0.6 > "$tmp/run/out" 2>&1; then fail "a failed alias write was ignored"; fi
printf 'other\n' > "$tmp/run/store/edge-setup%v0.0.6%edge-setup_linux_arm64"
: > "$tmp/run/log"
if run_publish v0.0.6 > "$tmp/run/out" 2>&1; then fail "a resume over a different stored binary was accepted"; fi
grep -q 'differs from the verified one' "$tmp/run/out" || { cat "$tmp/run/out"; fail "no mismatch message"; }
! grep -q '^PUT ' "$tmp/run/log" || fail "a refused resume still wrote objects"
cp "$tmp/run/dist/edge-setup_linux_arm64" "$tmp/run/store/edge-setup%v0.0.6%edge-setup_linux_arm64"
printf 'v0.0.10\n' > "$tmp/run/store/edge-setup%LATEST"
: > "$tmp/run/log"
if run_publish v0.0.6 > "$tmp/run/out" 2>&1; then fail "a resume moved LATEST back"; fi
grep -q 'newer than v0.0.6' "$tmp/run/out" || { cat "$tmp/run/out"; fail "no rollback message"; }
! grep -q '^PUT ' "$tmp/run/log" || fail "a refused rollback still wrote objects"

# 3. A failed write stops before latest moves: hosts keep the previous release.
setup
if FAKE_FAIL_KEY=edge-setup/v0.0.2/edge-setup_linux_arm64 run_publish v0.0.2 > "$tmp/run/out" 2>&1; then fail "a failed write was ignored"; fi
! stored edge-setup/SHA256SUMS || fail "latest manifest written after a failed versioned write"
! stored edge-setup/edge-setup.json || fail "anchor written after a failed versioned write"
! stored edge-setup/LATEST || fail "LATEST written after a failed versioned write"

# 3b. An unsigned dist is refused before any call.
setup
rm "$tmp/run/dist/SHA256SUMS.sigstore.json"
if run_publish v0.0.4 > "$tmp/run/out" 2>&1; then fail "a dist without a manifest signature was accepted"; fi
[[ ! -s "$tmp/run/log" ]] || fail "an unsigned dist still reached the network"
setup
rm "$tmp/run/dist/edge-setup_linux_arm64.sigstore.json"
if run_publish v0.0.4 > "$tmp/run/out" 2>&1; then fail "a dist with an unsigned binary was accepted"; fi
[[ ! -s "$tmp/run/log" ]] || fail "a dist with an unsigned binary still reached the network"

# 4. Bad input is refused before any call.
setup
if run_publish 1.0 > "$tmp/run/out" 2>&1; then fail "a non vX.Y.Z version was accepted"; fi
[[ ! -s "$tmp/run/log" ]] || fail "a bad version still reached the network"
rm "$tmp/run/dist/SHA256SUMS"
if run_publish v0.0.3 > "$tmp/run/out" 2>&1; then fail "a dist without SHA256SUMS was accepted"; fi
setup
echo tampered >> "$tmp/run/dist/edge-setup_linux_amd64"
if run_publish v0.0.3 > "$tmp/run/out" 2>&1; then fail "a dist that does not match its SHA256SUMS was accepted"; fi
[[ ! -s "$tmp/run/log" ]] || fail "a tampered dist still reached the network"

echo "publish-r2 test: OK"
