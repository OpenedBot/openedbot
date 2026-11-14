#!/usr/bin/env bash
# A fake curl for the release tests: it stands for both the Cloudflare R2 API
# (object writes, reads, listing, deletes) and the public origin (read-back).
# No network. Installed as `curl` on PATH by the tests.
#
# Env: FAKE_LOG (every call, "METHOD URL"), FAKE_STORE (one file per object,
#      '/' written '%'), FAKE_FAIL_KEY (a PUT of that key fails),
#      FAKE_FAIL_DELETE (a DELETE of that key fails), FAKE_LIST_FAIL=1 (every
#      listing fails), FAKE_PAGE_SIZE (listing page size, default 1000),
#      FAKE_TRUNCATE_NO_CURSOR=1 (a truncated page carries no cursor).
set -euo pipefail
method=GET url='' data='' out='' header=''
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
api=https://api.cloudflare.com/client/v4/accounts/acct-1/r2/buckets/openedbot-releases/objects
urldecode() { local v="${1//+/ }"; printf '%b' "${v//%/\\x}"; }
case "$url" in
	"$api?"*)
		[[ "$method" == GET ]] || { echo "unexpected $method on a listing" >&2; exit 98; }
		if [[ "${FAKE_LIST_FAIL:-}" == 1 ]]; then
			echo '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' > "${out:-/dev/stdout}"
			exit 0
		fi
		prefix='' cursor=0
		IFS='&' read -r -a params <<<"${url#*\?}"
		for param in "${params[@]}"; do
			case "$param" in
				prefix=*) prefix="$(urldecode "${param#prefix=}")" ;;
				cursor=*) cursor="$(urldecode "${param#cursor=}")" ;;
			esac
		done
		size="${FAKE_PAGE_SIZE:-1000}"
		keys="$(find "$store" -type f -print | sed "s#^$store/##" | tr '%' '/' | LC_ALL=C sort | while IFS= read -r k; do [[ "$k" == "$prefix"* ]] && echo "$k"; done || true)"
		total="$(grep -c . <<<"$keys" || true)"
		page="$(sed -n "$((cursor + 1)),$((cursor + size))p" <<<"$keys")"
		next=$((cursor + size))
		truncated=false
		((next < total)) && truncated=true
		next_cursor="$next"
		[[ "${FAKE_TRUNCATE_NO_CURSOR:-}" != 1 ]] || next_cursor=""
		jq -n --arg keys "$page" --argjson truncated "$truncated" --arg cursor "$next_cursor" '
			{success: true, errors: [], result: ($keys | split("\n") | map(select(length > 0)) | map({key: ., size: 1, last_modified: "2026-11-13T00:00:00Z"})),
			 result_info: ({is_truncated: $truncated, per_page: 1000} + (if $truncated and $cursor != "" then {cursor: $cursor} else {} end))}' > "${out:-/dev/stdout}"
		;;
	"$api/"*)
		key="${url#"$api/"}"
		file="$store/$(printf '%s' "$key" | tr '/' '%')"
		if [[ "$method" == PUT ]]; then
			[[ -n "${FAKE_FAIL_KEY:-}" && "$key" == "$FAKE_FAIL_KEY" ]] && { echo '{"success":false,"errors":[{"code":1,"message":"boom"}]}'; exit 0; }
			cp "${data#@}" "$file"; echo '{"success":true}'
		elif [[ "$method" == DELETE ]]; then
			[[ -n "${FAKE_FAIL_DELETE:-}" && "$key" == "$FAKE_FAIL_DELETE" ]] && { echo '{"success":false,"errors":[{"code":1,"message":"boom"}]}'; exit 0; }
			rm -f "$file"; jq -n --arg key "$key" '{success: true, errors: [], messages: [], result: {key: $key}}'
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
