#!/usr/bin/env bash
# Keeps on R2 only the two newest edge-setup releases: the one just published
# and the one before it (operator rule of 2026-11-13). Every older
# edge-setup/vX.Y.Z/ tree is deleted; the root files (LATEST, SHA256SUMS,
# edge-setup.json, install.sh, the unversioned binaries) are never touched.
# Older versions stay available as GitHub releases edge-setup/vX.Y.Z, with
# the same signed files.
#
# Usage: prune-r2.sh plan vX.Y.Z LATEST < PREFIXES
#          Pure selection, no network: reads one edge-setup/vX.Y.Z/ prefix
#          per line and prints the prefixes to delete (possibly none).
#        prune-r2.sh run vX.Y.Z [--dry-run]
#          Lists the bucket through the Cloudflare R2 API, plans, then deletes
#          (or, with --dry-run, prints what it would delete).
# Env:   CLOUDFLARE_API_TOKEN (Workers R2 Storage Edit, read from a 0600
#        header file, never argv), CF_ACCOUNT_ID, R2_BUCKET (default
#        openedbot-releases).
#
# Fail-safe: it refuses (exit 2, nothing deleted) rather than guess when
# LATEST does not name the version just published, when the listing fails, is
# truncated without a cursor or holds a prefix that is not vX.Y.Z, when fewer
# than two versions are listed, or when the version just published is not the
# highest one. The two highest versions by numeric semver are always kept,
# and so are the version LATEST names and the one being published (both the
# highest, or it refuses). Inside a deleted tree, SHA256SUMS goes first, so a
# half-deleted version never lists a file that is gone; running it again
# finishes the job (idempotent).
#
# publish-r2.sh calls `run` after the new version is served and read back,
# and only warns when it fails: the release itself succeeded.
set -euo pipefail

die() { echo "prune-r2: $*" >&2; exit 2; }

KEEP=2
semver='v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)'

# plan VERSION LATEST < prefixes: prints the prefixes to delete, newest first.
plan() {
	local version="$1" latest="$2" line count=0 kept=0
	[[ "$version" =~ ^${semver}$ ]] || die "version must be vX.Y.Z, got $version"
	[[ "$latest" =~ ^${semver}$ ]] || die "LATEST is not a version: '$latest'"
	[[ "$latest" == "$version" ]] || die "LATEST names $latest, not $version just published: not pruning"
	local versions=()
	while IFS= read -r line; do
		[[ -n "$line" ]] || continue
		[[ "$line" =~ ^edge-setup/(${semver})/$ ]] || die "unexpected prefix in the listing: '$line'"
		versions+=("${BASH_REMATCH[1]}")
	done
	count=${#versions[@]}
	((count >= KEEP)) || die "the listing holds $count version(s), fewer than $KEEP: not pruning"
	local sorted
	sorted="$(printf '%s\n' "${versions[@]}" | sed 's/^v//' | LC_ALL=C sort -t. -k1,1nr -k2,2nr -k3,3nr | uniq)"
	[[ "$(grep -c . <<<"$sorted")" -eq "$count" ]] || die "the listing names a version twice: not pruning"
	[[ "v$(head -n 1 <<<"$sorted")" == "$version" ]] || die "$version is not the highest version listed (v$(head -n 1 <<<"$sorted")): not pruning"
	while IFS= read -r line; do
		kept=$((kept + 1))
		((kept > KEEP)) || continue
		# Belt and braces: the published version and LATEST are never deleted.
		[[ "v$line" != "$version" && "v$line" != "$latest" ]] || die "refusing to delete v$line"
		printf 'edge-setup/v%s/\n' "$line"
	done <<<"$sorted"
}

case "${1:-}" in
	plan)
		[[ $# -eq 3 ]] || die "usage: prune-r2.sh plan vX.Y.Z LATEST < PREFIXES"
		plan "$2" "$3"
		exit 0
		;;
	run)
		[[ $# -eq 2 || ($# -eq 3 && "$3" == --dry-run) ]] || die "usage: prune-r2.sh run vX.Y.Z [--dry-run]"
		version="$2"
		dry_run=false
		[[ "${3:-}" != --dry-run ]] || dry_run=true
		;;
	*) die "usage: prune-r2.sh plan vX.Y.Z LATEST < PREFIXES | run vX.Y.Z [--dry-run]" ;;
esac

[[ "$version" =~ ^${semver}$ ]] || die "version must be vX.Y.Z, got $version"
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || die "CLOUDFLARE_API_TOKEN is required"
[[ -n "${CF_ACCOUNT_ID:-}" ]] || die "CF_ACCOUNT_ID is required"
for tool in curl jq; do command -v "$tool" >/dev/null || die "$tool is required"; done
bucket="${R2_BUCKET:-openedbot-releases}"
api="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/r2/buckets/$bucket/objects"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(umask 077 && printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$work/auth")

# The version is fully served before anything goes: LATEST names it and its
# manifest is stored (publish-r2.sh read both back from the public origin).
status="$(curl -sS -H @"$work/auth" -o "$work/latest" -w '%{http_code}' "$api/edge-setup/LATEST")" || die "could not read LATEST"
[[ "$status" == 200 ]] || die "could not read LATEST (HTTP $status)"
latest="$(tr -d '[:space:]' < "$work/latest")"
status="$(curl -sS -H @"$work/auth" -o /dev/null -w '%{http_code}' "$api/edge-setup/$version/SHA256SUMS")" || die "could not read $version/SHA256SUMS"
[[ "$status" == 200 ]] || die "$version/SHA256SUMS is not stored (HTTP $status): not pruning"

# list PREFIX: every object key under PREFIX, one per line, every page.
list() {
	local prefix="$1" cursor="" page=0 url
	: > "$work/keys"
	while :; do
		page=$((page + 1))
		((page <= 1000)) || die "listing $prefix never ends"
		url="$api?prefix=$(jq -rn --arg v "$prefix" '$v | @uri')&per_page=1000"
		[[ -z "$cursor" ]] || url="$url&cursor=$(jq -rn --arg v "$cursor" '$v | @uri')"
		curl -sS -H @"$work/auth" -o "$work/page" "$url" || die "listing $prefix failed"
		jq -e '.success == true and (.result | type == "array") and all(.result[]; .key | type == "string")' "$work/page" >/dev/null 2>&1 \
			|| die "listing $prefix failed: $(jq -c '.errors // .' "$work/page" 2>/dev/null || head -c 300 "$work/page")"
		jq -r '.result[].key' "$work/page" >> "$work/keys"
		[[ "$(jq -r '.result_info.is_truncated // false' "$work/page")" == true ]] || break
		cursor="$(jq -r '.result_info.cursor // empty' "$work/page")"
		[[ -n "$cursor" ]] || die "listing $prefix is truncated without a cursor"
	done
}

list edge-setup/
while IFS= read -r key; do
	[[ "$key" == edge-setup/* ]] || die "the listing returned a key outside edge-setup/: $key"
	rest="${key#edge-setup/}"
	# A root file has no slash: never a candidate.
	[[ "$rest" == */* ]] || continue
	printf 'edge-setup/%s/\n' "${rest%%/*}"
done < "$work/keys" | LC_ALL=C sort -u > "$work/prefixes"

doomed="$(plan "$version" "$latest" < "$work/prefixes")"
if [[ -z "$doomed" ]]; then
	echo "prune-r2: $(grep -c . "$work/prefixes") version(s) on R2, nothing to delete"
	exit 0
fi

while IFS= read -r prefix; do
	list "$prefix"
	# SHA256SUMS first: a half-deleted version never lists a file that is gone.
	{ grep -Fx "${prefix}SHA256SUMS" "$work/keys" || true; grep -Fvx "${prefix}SHA256SUMS" "$work/keys" || true; } > "$work/doomed-keys"
	while IFS= read -r key; do
		[[ "$key" == "$prefix"* ]] || die "the listing of $prefix returned $key"
		if [[ "$dry_run" == true ]]; then
			echo "  would delete $key"
			continue
		fi
		body="$(curl -sS -X DELETE -H @"$work/auth" "$api/$key")" || die "delete of $key failed"
		[[ "$(jq -r '.success' <<<"$body" 2>/dev/null)" == true ]] || die "delete of $key failed: $(jq -c '.errors // .' <<<"$body" 2>/dev/null || echo "$body")"
		echo "  deleted $key"
	done < "$work/doomed-keys"
	if [[ "$dry_run" == true ]]; then echo "prune-r2: would delete $prefix"; else echo "prune-r2: deleted $prefix"; fi
done <<<"$doomed"
