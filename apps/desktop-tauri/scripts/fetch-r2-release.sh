#!/usr/bin/env bash
# Downloads files of desktop release VERSION from R2 (the public origin,
# https://releases.openedbot.app/desktop/vVERSION/) into DIR and checks each
# one against the release's SHA256SUMS. Used by every job of
# .github/workflows/desktop-release.yml instead of handing ~260 MB between
# jobs as a workflow artifact: R2 already serves these exact files, and the
# Actions artifact storage is a quota a release must not depend on.
#
# Usage: fetch-r2-release.sh VERSION DIR SUMS_DIGEST [NAME...]
#   SUMS_DIGEST  the SHA-256 the downloaded SHA256SUMS must have, as the
#                job `fetch` read and verified it (its output), or `-` in
#                that job, which pins it for the others: every job then
#                checks the very bytes `fetch` verified, even if R2 changed
#                in between.
#   NAME...      the files to download, each listed in SHA256SUMS; none:
#                every file it lists.
# Env: RELEASES_BASE (default https://releases.openedbot.app/desktop).
# Prints `sums=<digest>` on its last line.
set -euo pipefail

die() { echo "fetch-r2-release: $*" >&2; exit 2; }

[[ $# -ge 3 ]] || die "usage: fetch-r2-release.sh VERSION DIR SUMS_DIGEST [NAME...]"
version="$1" dir="$2" pinned="$3"
shift 3
[[ "$version" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || die "not a release version: '$version'"
[[ "$pinned" == - || "$pinned" =~ ^[0-9a-f]{64}$ ]] || die "SUMS_DIGEST must be a SHA-256 or -"
base="${RELEASES_BASE:-https://releases.openedbot.app/desktop}/v$version"

sha256() {
	if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$dir"
curl -fsS --proto '=https' --retry 3 -o "$dir/SHA256SUMS" "$base/SHA256SUMS" || die "$base/SHA256SUMS could not be downloaded"
digest="$(sha256 "$dir/SHA256SUMS")"
[[ "$pinned" == - || "$digest" == "$pinned" ]] || die "R2 now serves another SHA256SUMS for $version ($digest) than the one verified by the fetch job ($pinned)"

# Names come from the network: only the release's own shapes, never a path.
listed=()
while read -r sum name extra; do
	[[ -n "${sum:-}" ]] || continue
	[[ -z "${extra:-}" && "$sum" =~ ^[0-9a-f]{64}$ ]] || die "unexpected line in SHA256SUMS: $sum $name"
	[[ "$name" == "openedbot_${version}_"* && "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "unexpected name in SHA256SUMS: $name"
	listed+=("$name")
done < "$dir/SHA256SUMS"
((${#listed[@]} > 0)) || die "SHA256SUMS lists no file"
(($# > 0)) || set -- "${listed[@]}"

for name in "$@"; do
	want="$(awk -v n="$name" '$2 == n { print $1; exit }' "$dir/SHA256SUMS")"
	[[ -n "$want" ]] || die "$name is not listed in SHA256SUMS of $version"
	curl -fsS --proto '=https' --retry 3 -o "$dir/$name" "$base/$name" || die "$base/$name could not be downloaded"
	got="$(sha256 "$dir/$name")"
	[[ "$got" == "$want" ]] || die "$name does not match SHA256SUMS ($got, want $want)"
	echo "  $name OK"
done
echo "sums=$digest"
