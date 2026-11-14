#!/usr/bin/env bash
# Downloads the signed files of tag edge-setup/VERSION from its GitHub release
# into OUT_DIR. That release carries the very bytes the release workflow built,
# signed and published to R2 (its `github` job refuses any other ones), and it
# stays when R2 keeps only the two newest versions. Publication uses these
# bytes, never a local rebuild: the signature binds the files the CI built
# from the tag. `make fetch-signed` then verifies every signature and checksum.
#
# The workflow keeps no artifact (signed files travel through the run's cache): a
# release whose run failed before its GitHub release is finished by re-running
# that run, not from here.
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

git rev-parse --verify --quiet "refs/tags/$tag^{commit}" >/dev/null || die "tag $tag is not in this clone (git fetch --tags)"

rm -rf "$out"
mkdir -p "$out"
gh release download "$tag" -R "$repo" -D "$out" || die "the GitHub release $tag could not be downloaded: it only exists once its release run published to R2; re-run that run instead"

# Exactly the files of SHA256SUMS, each with its bundle, plus the manifest's
# own bundle: nothing missing, nothing extra.
bash "$(dirname "$0")/check-signed-dir.sh" "$out" >/dev/null || die "the GitHub release $tag does not hold exactly its signed files"
echo "fetch-signed-release: $tag -> $out"
