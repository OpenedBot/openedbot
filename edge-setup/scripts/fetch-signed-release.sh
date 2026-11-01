#!/usr/bin/env bash
# Downloads what the release workflow built and signed for tag
# edge-setup/VERSION (the workflow artifact edge-setup-VERSION) into OUT_DIR.
# Publication uses these bytes, never a local rebuild: the signature binds the
# files the CI built from the tag. `make fetch-signed` then verifies every
# signature and checksum.
#
# Usage: fetch-signed-release.sh vX.Y.Z OUT_DIR
# Env:   GH_REPO (default OpenedBot/openedbot)
set -euo pipefail

die() { echo "fetch-signed-release: $*" >&2; exit 2; }

[[ $# -eq 2 ]] || die "usage: fetch-signed-release.sh vX.Y.Z OUT_DIR"
version="$1" out="$2"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be vX.Y.Z, got $version"
[[ -n "$out" && "$out" != / ]] || die "OUT_DIR must be a directory"
command -v gh >/dev/null || die "gh is required"
repo="${GH_REPO:-OpenedBot/openedbot}"
tag="edge-setup/$version"

commit="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")" || die "tag $tag is not in this clone (git fetch --tags)"
run_id="$(gh run list -R "$repo" --workflow edge-setup-release.yml --commit "$commit" --event push --status success --limit 1 --json databaseId --jq '.[0].databaseId // empty')"
[[ "$run_id" =~ ^[0-9]+$ ]] || die "no successful edge-setup-release run for $tag ($commit): wait for it, or re-run it"

rm -rf "$out"
mkdir -p "$out"
gh run download "$run_id" -R "$repo" -n "edge-setup-$version" -D "$out" || die "artifact edge-setup-$version of run $run_id could not be downloaded"

# Exactly the files of SHA256SUMS, each with its bundle, plus the manifest's
# own bundle: nothing missing, nothing extra.
[[ -f "$out/SHA256SUMS" && -f "$out/SHA256SUMS.sigstore.json" ]] || die "the artifact carries no signed SHA256SUMS"
expected=(SHA256SUMS SHA256SUMS.sigstore.json)
while read -r _ name; do
	name="${name#\*}"
	[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unexpected name in SHA256SUMS: $name"
	expected+=("$name" "$name.sigstore.json")
done < "$out/SHA256SUMS"
actual="$(cd "$out" && find . -type f | sed 's#^\./##' | LC_ALL=C sort)"
wanted="$(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)"
[[ "$actual" == "$wanted" ]] || die "artifact files differ from SHA256SUMS:
$(diff <(echo "$wanted") <(echo "$actual") || true)"
echo "fetch-signed-release: run $run_id, $tag -> $out"
