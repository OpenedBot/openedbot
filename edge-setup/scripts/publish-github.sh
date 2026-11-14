#!/usr/bin/env bash
# Publish only CI-verified signed files. An existing release is immutable:
# retries succeed only after its complete asset list and bytes are verified.
set -euo pipefail

die() { echo "publish-github: $*" >&2; exit 2; }
[[ $# -eq 3 ]] || die "usage: publish-github.sh vX.Y.Z SIGNED_DIR NOTES_FILE"
version="$1" dist="$2" notes="$3"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid release version"
repo="${GH_REPO:-OpenedBot/openedbot}"
tag="edge-setup/$version"
[[ -f "$dist/SHA256SUMS" && -f "$dist/SHA256SUMS.sigstore.json" && -s "$notes" ]] || die "signed manifest or notes missing"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Reject paths, symlinks and directories before passing filenames to gh.
for file in "$dist"/* "$dist"/.[!.]* "$dist"/..?*; do
	[[ -e "$file" || -L "$file" ]] || continue
	name="${file##*/}"
	[[ -f "$file" && ! -L "$file" && "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid signed asset: $name"
	printf '%s\n' "$name" >> "$work/expected"
done
LC_ALL=C sort -o "$work/expected" "$work/expected"

if ! gh api "repos/$repo/releases/tags/$tag" > "$work/release.json"; then
	# Authentication, transport and server errors must never mean "absent".
	jq -e '(.status == "404" or .status == 404)' "$work/release.json" >/dev/null 2>&1 || die "could not inspect release $tag"
	# Never Latest: that badge belongs to the desktop app.
	gh release create "$tag" "$dist"/* --repo "$repo" --verify-tag --latest=false --title "edge-setup $version" --notes-file "$notes"
	gh api "repos/$repo/releases/tags/$tag" > "$work/release.json"
fi
jq -e --arg tag "$tag" '.tag_name == $tag and .draft == false and .prerelease == false and (.id | type == "number" and . > 0)' "$work/release.json" >/dev/null || die "release metadata does not match published $tag"
id="$(jq -r .id "$work/release.json")"
# Paginate explicitly: extra assets must not be hidden on a later API page.
gh api --paginate --slurp "repos/$repo/releases/$id/assets" > "$work/pages.json"
jq -e 'all(.[][]; (.id | type == "number" and . > 0) and .state == "uploaded" and (.name | test("^[A-Za-z0-9][A-Za-z0-9._-]*$")))' "$work/pages.json" >/dev/null || die "invalid or unfinished release asset"
jq -r '.[][] | .name' "$work/pages.json" | LC_ALL=C sort > "$work/actual"
if ! diff -u "$work/expected" "$work/actual"; then
	die "release $tag has missing, extra or duplicate assets; nothing overwritten"
fi
jq -r '.[][] | [.id, .name] | @tsv' "$work/pages.json" > "$work/assets"
while IFS=$'\t' read -r asset_id name; do
	gh api -H 'Accept: application/octet-stream' "repos/$repo/releases/assets/$asset_id" > "$work/download"
	cmp -s "$dist/$name" "$work/download" || die "release $tag asset differs: $name; nothing overwritten"
done < "$work/assets"
echo "publish-github: $tag published; every asset matches the signed files"
