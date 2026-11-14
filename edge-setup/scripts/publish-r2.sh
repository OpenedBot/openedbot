#!/usr/bin/env bash
# Publishes a signed release (the files the release workflow signed, handed
# to its publish job, or fetched by `make fetch-signed`: files, SHA256SUMS and
# one Sigstore bundle each) to the public origin: the R2
# bucket served read-only by https://releases.openedbot.app/edge-setup.
#
# Usage: publish-r2.sh vX.Y.Z DIST_DIR
# Env:   CLOUDFLARE_API_TOKEN (R2 write on the bucket; read from a 0600 header
#        file, never argv), CF_ACCOUNT_ID, R2_BUCKET (default openedbot-releases),
#        RELEASES_BASE (default https://releases.openedbot.app/edge-setup),
#        NOTES_FILE (optional, published as vX.Y.Z/RELEASE_NOTES.md),
#        R2_PRUNE (default 1; 0 keeps every older version).
#
# Order is the safety: the versioned tree vX.Y.Z/ is written first and never
# overwritten, its SHA256SUMS last; then the unversioned copies that hosts
# older than signed releases still read (binaries, then SHA256SUMS); then
# LATEST, the pointer signed hosts and the installer resolve, last of all. A
# host never reads a manifest that lists a file not yet served, and any failed
# write stops before LATEST moves. Manifests and LATEST are read back from the
# public origin.
#
# A run that stopped after the versioned manifest (an alias or LATEST write
# failed) can be run again with the same files: the versioned tree is then
# checked object by object against the verified dist, never rewritten, and
# only the unversioned copies, the anchor and LATEST are written. Different
# files under a published version are refused, and so is moving LATEST back
# from a newer version, on a resume as on a first publication.
#
# Then only the two newest versions are kept on R2 (prune-r2.sh; R2_PRUNE=0
# skips it). A pruning refusal or failure only warns: the release succeeded.
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

get() { # get OBJECT_KEY LOCAL_FILE: prints the HTTP status
	curl -sS -H @"$work/auth" -o "$2" -w '%{http_code}' "$api/$1"
}

# same_as OBJECT_KEY LOCAL_FILE: the stored object has exactly these bytes.
same_as() {
	[[ "$(get "$1" "$work/stored")" == 200 ]] && cmp -s "$work/stored" "$2"
}

# version_ge A B: vX.Y.Z A is B or newer.
version_ge() {
	local -a a b
	local i
	IFS=. read -r -a a <<<"${1#v}"
	IFS=. read -r -a b <<<"${2#v}"
	for i in 0 1 2; do
		((10#${a[i]} > 10#${b[i]})) && return 0
		((10#${a[i]} < 10#${b[i]})) && return 1
	done
	return 0
}

# LATEST never moves back, on a first publication as on a resume: re-uploading
# an older release (e.g. one pruned from R2, fetched from its GitHub release)
# must not roll every host back.
status="$(get "edge-setup/LATEST" "$work/current")"
case "$status" in
	404) ;;
	200)
		current="$(tr -d '[:space:]' <"$work/current")"
		[[ "$current" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the published LATEST is not a version: $current"
		version_ge "$version" "$current" || die "LATEST already names $current, newer than $version: not moving it back"
		;;
	*) die "could not read the published LATEST (HTTP $status)" ;;
esac

status="$(get "edge-setup/$version/SHA256SUMS" "$work/existing")"
case "$status" in
	404) resume=false ;;
	200)
		cmp -s "$work/existing" "$dist/SHA256SUMS" || die "$version is already published with other files: a release is immutable, cut a new version"
		resume=true
		;;
	*) die "could not check whether $version exists (HTTP $status)" ;;
esac

if [[ "$resume" == true ]]; then
	# The versioned manifest is written last in its tree, but the objects it
	# lists are still compared to the verified files before anything points
	# at them.
	echo "publish-r2: $version is already in $bucket; checking it, then finishing the aliases"
	same_as "edge-setup/$version/SHA256SUMS.sigstore.json" "$dist/SHA256SUMS.sigstore.json" || die "the published $version/SHA256SUMS.sigstore.json differs from the verified one"
	for asset in "${assets[@]}"; do
		same_as "edge-setup/$version/$asset" "$dist/$asset" || die "the published $version/$asset differs from the verified one"
		same_as "edge-setup/$version/$asset.sigstore.json" "$dist/$asset.sigstore.json" || die "the published $version/$asset.sigstore.json differs from the verified one"
	done
else
	echo "publish-r2: $version -> $bucket"
	for asset in "${assets[@]}"; do
		put "$dist/$asset" "edge-setup/$version/$asset"
		put "$dist/$asset.sigstore.json" "edge-setup/$version/$asset.sigstore.json"
	done
	if [[ -n "${NOTES_FILE:-}" ]]; then put "$NOTES_FILE" "edge-setup/$version/RELEASE_NOTES.md"; fi
	put "$dist/SHA256SUMS.sigstore.json" "edge-setup/$version/SHA256SUMS.sigstore.json"
	put "$dist/SHA256SUMS" "edge-setup/$version/SHA256SUMS"
fi
for asset in "${assets[@]}"; do put "$dist/$asset" "edge-setup/$asset"; done
put "$dist/SHA256SUMS" "edge-setup/SHA256SUMS"
# The anchor the console's update feed reads (RUNTIME_CONNECTOR_RELEASES_URL):
# the version and the SHA-256 of each file, from the verified manifest. Written
# just before LATEST, so it never announces a release LATEST does not serve.
jq -n --arg version "$version" --rawfile sums "$dist/SHA256SUMS" '
	{tool: {version: $version, sha256: ($sums | split("\n") | map(select(length > 0) | split(" ") | map(select(length > 0)) | {key: (.[1] | ltrimstr("*")), value: .[0]}) | from_entries)}}
' > "$work/edge-setup.json"
put "$work/edge-setup.json" "edge-setup/edge-setup.json"
printf '%s\n' "$version" > "$work/LATEST"
put "$work/LATEST" "edge-setup/LATEST"

for manifest in "$version/SHA256SUMS" "SHA256SUMS"; do
	curl -fsS --proto '=https' -o "$work/readback" "$base/$manifest" || die "public read-back of $manifest failed"
	cmp -s "$work/readback" "$dist/SHA256SUMS" || die "public $manifest differs from the local one"
done
curl -fsS --proto '=https' -o "$work/readback" "$base/$version/SHA256SUMS.sigstore.json" || die "public read-back of the signature failed"
cmp -s "$work/readback" "$dist/SHA256SUMS.sigstore.json" || die "public signature differs from the local one"
curl -fsS --proto '=https' -o "$work/readback" "$base/edge-setup.json" || die "public read-back of the anchor failed"
cmp -s "$work/readback" "$work/edge-setup.json" || die "public anchor differs from $version"
curl -fsS --proto '=https' -o "$work/readback" "$base/LATEST" || die "public read-back of LATEST failed"
cmp -s "$work/readback" "$work/LATEST" || die "public LATEST differs from $version"
echo "publish-r2: $version served by $base"

# Only the two newest versions stay on R2 (prune-r2.sh). The release above is
# complete and read back: a pruning refusal or failure is a warning, never a
# failed release, and the next publication tries again.
if [[ "${R2_PRUNE:-1}" == 1 ]]; then
	if ! bash "$(dirname "$0")/prune-r2.sh" run "$version"; then
		echo "publish-r2: warning: older versions were not pruned (see above); $version is published" >&2
		[[ -z "${GITHUB_ACTIONS:-}" ]] || echo "::warning title=R2 not pruned::older edge-setup versions were not pruned; $version is published"
	fi
fi
