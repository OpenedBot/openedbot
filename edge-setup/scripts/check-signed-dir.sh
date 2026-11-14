#!/usr/bin/env bash
# Refuses a signed release directory unless it holds exactly the files of its
# SHA256SUMS, each with its Sigstore bundle, plus the manifest and its own
# bundle: nothing missing, nothing extra, no directory, no symlink. Run on the
# files handed from the build job to the publishing jobs of
# edge-setup-release.yml and on a manual download (fetch-signed-release.sh),
# before `make verify-signatures` checks every bundle and sum.
#
# Usage: check-signed-dir.sh DIR
set -euo pipefail

die() { echo "check-signed-dir: $*" >&2; exit 2; }

[[ $# -eq 1 ]] || die "usage: check-signed-dir.sh DIR"
dir="$1"
[[ -d "$dir" && ! -L "$dir" ]] || die "$dir is not a directory"
[[ -f "$dir/SHA256SUMS" && ! -L "$dir/SHA256SUMS" ]] || die "$dir has no SHA256SUMS"
[[ -f "$dir/SHA256SUMS.sigstore.json" ]] || die "$dir has no signed SHA256SUMS (SHA256SUMS.sigstore.json)"

expected=(SHA256SUMS SHA256SUMS.sigstore.json)
count=0
while IFS= read -r line; do
	[[ -n "$line" ]] || continue
	read -r sum name extra <<<"$line"
	[[ -z "${extra:-}" && "$sum" =~ ^[0-9a-f]{64}$ ]] || die "unexpected line in SHA256SUMS: $line"
	name="${name#\*}"
	[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "unexpected name in SHA256SUMS: $name"
	expected+=("$name" "$name.sigstore.json")
	count=$((count + 1))
done < "$dir/SHA256SUMS"
((count > 0)) || die "SHA256SUMS lists no file"

actual="$(cd "$dir" && find . -mindepth 1 -print | sed 's#^\./##' | LC_ALL=C sort)"
wanted="$(printf '%s\n' "${expected[@]}" | LC_ALL=C sort)"
[[ "$actual" == "$wanted" ]] || die "$dir differs from its SHA256SUMS (want < > have):
$(diff <(echo "$wanted") <(echo "$actual") || true)"
# find lists a symlink as a name like any other: refuse it explicitly.
for name in "${expected[@]}"; do
	[[ -f "$dir/$name" && ! -L "$dir/$name" ]] || die "$dir/$name is not a regular file"
done
echo "check-signed-dir: $dir holds exactly the $count signed files of its SHA256SUMS"
