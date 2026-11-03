#!/usr/bin/env bash
# Publishes a signed release (the CI artifact fetched by `make fetch-signed`:
# files, SHA256SUMS and one Sigstore bundle each) to the public origin: the R2
# bucket served read-only by https://releases.openedbot.app/edge-setup.
#
# Usage: publish-r2.sh vX.Y.Z DIST_DIR
# Env:   CLOUDFLARE_API_TOKEN (R2 write on the bucket; read from a 0600 header
#        file, never argv), CF_ACCOUNT_ID, R2_BUCKET (default openedbot-releases),
#        RELEASES_BASE (default https://releases.openedbot.app/edge-setup),
#        NOTES_FILE (optional, published as vX.Y.Z/RELEASE_NOTES.md).
#
# Order is the safety: the versioned tree vX.Y.Z/ is written first and never
# overwritten, its SHA256SUMS last; then the unversioned copies that hosts
# older than signed releases still read (binaries, then SHA256SUMS); then
# LATEST, the pointer signed hosts and the installer resolve, last of all. A
# host never reads a manifest that lists a file not yet served, and any failed
# write stops before LATEST moves. Manifests and LATEST are read back from the
# public origin.
set -euo pipefail

die() { echo "publish-r2: $*" >&2; exit 2; }

[[ $# -eq 2 ]] || die "usage: publish-r2.sh vX.Y.Z DIST_DIR"
version="$1" dist="$2"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "version must be vX.Y.Z, got $version"
[[ -f "$dist/SHA256SUMS" ]] || die "$dist/SHA256SUMS is missing: run make fetch-signed first"
[[ -f "$dist/SHA256SUMS.sigstore.json" ]] || die "$dist/SHA256SUMS.sigstore.json is missing: only a signed release is published"
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN is required"
[[ -n "${CF_ACCOUNT_ID:-}" ]] || die "CF_ACCOUNT_ID is required"
for tool in curl jq; do command -v "$tool" >/dev/null || die "$tool is required"; done
bucket="${R2_BUCKET:-openedbot-releases}"
base="${RELEASES_BASE:-https://releases.openedbot.app/edge-setup}"
api="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/r2/buckets/$bucket/objects"

# The manifest must describe the files exactly, before anything leaves.
assets=()
while IFS= read -r asset; do assets+=("$asset"); done < <(awk 'NF == 2 { sub(/^\*/, "", $2); print $2 }' "$dist/SHA256SUMS")
((${#assets[@]} > 0)) || die "SHA256SUMS lists no asset"
for asset in "${assets[@]}"; do
	[[ "$asset" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unexpected asset name in SHA256SUMS: $asset"
	[[ -f "$dist/$asset" ]] || die "SHA256SUMS lists $asset, absent from $dist"
	[[ -f "$dist/$asset.sigstore.json" ]] || die "$asset has no signature bundle in $dist"
done
if command -v sha256sum >/dev/null; then
	(cd "$dist" && sha256sum --check --quiet SHA256SUMS) || die "$dist does not match its SHA256SUMS"
else
	(cd "$dist" && shasum -a 256 --check --quiet SHA256SUMS) || die "$dist does not match its SHA256SUMS"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$work/auth")

content_type() {
	case "$1" in
		*SHA256SUMS|*/LATEST) echo "text/plain; charset=utf-8" ;;
		*.json) echo "application/json" ;;
		*.md) echo "text/markdown; charset=utf-8" ;;
		*) echo "application/octet-stream" ;;
	esac
}

put() { # put LOCAL_FILE OBJECT_KEY
	local body
	body="$(curl -sS -X PUT -H @"$work/auth" -H "Content-Type: $(content_type "$2")" --data-binary "@$1" "$api/$2")"
	[[ "$(jq -r '.success' <<<"$body" 2>/dev/null)" == true ]] || die "write of $2 failed: $(jq -c '.errors // .' <<<"$body" 2>/dev/null || echo "$body")"
	echo "  $2"
}

status="$(curl -sS -H @"$work/auth" -o "$work/existing" -w '%{http_code}' "$api/edge-setup/$version/SHA256SUMS")"
case "$status" in
	404) ;;
	200) die "$version is already published: a release is immutable, cut a new version" ;;
	*) die "could not check whether $version exists (HTTP $status)" ;;
esac

echo "publish-r2: $version -> $bucket"
for asset in "${assets[@]}"; do
	put "$dist/$asset" "edge-setup/$version/$asset"
	put "$dist/$asset.sigstore.json" "edge-setup/$version/$asset.sigstore.json"
done
if [[ -n "${NOTES_FILE:-}" ]]; then put "$NOTES_FILE" "edge-setup/$version/RELEASE_NOTES.md"; fi
put "$dist/SHA256SUMS.sigstore.json" "edge-setup/$version/SHA256SUMS.sigstore.json"
put "$dist/SHA256SUMS" "edge-setup/$version/SHA256SUMS"
for asset in "${assets[@]}"; do put "$dist/$asset" "edge-setup/$asset"; done
put "$dist/SHA256SUMS" "edge-setup/SHA256SUMS"
printf '%s\n' "$version" > "$work/LATEST"
put "$work/LATEST" "edge-setup/LATEST"

for manifest in "$version/SHA256SUMS" "SHA256SUMS"; do
	curl -fsS --proto '=https' -o "$work/readback" "$base/$manifest" || die "public read-back of $manifest failed"
	cmp -s "$work/readback" "$dist/SHA256SUMS" || die "public $manifest differs from the local one"
done
curl -fsS --proto '=https' -o "$work/readback" "$base/$version/SHA256SUMS.sigstore.json" || die "public read-back of the signature failed"
cmp -s "$work/readback" "$dist/SHA256SUMS.sigstore.json" || die "public signature differs from the local one"
curl -fsS --proto '=https' -o "$work/readback" "$base/LATEST" || die "public read-back of LATEST failed"
cmp -s "$work/readback" "$work/LATEST" || die "public LATEST differs from $version"
echo "publish-r2: $version served by $base"
