#!/usr/bin/env bash
# Exercise scripts/check-signed-dir.sh: the hand-over between the jobs of
# edge-setup-release.yml holds exactly the signed files of its SHA256SUMS.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-signed-dir-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "check-signed-dir test: $*" >&2; exit 1; }

setup() {
	rm -rf "$tmp/d" && mkdir -p "$tmp/d"
	(
		cd "$tmp/d"
		printf 'a\n' > edge-setup_linux_amd64
		printf 'b\n' > install.sh
		if command -v sha256sum >/dev/null 2>&1; then sha256sum edge-setup_linux_amd64 install.sh > SHA256SUMS; else shasum -a 256 edge-setup_linux_amd64 install.sh > SHA256SUMS; fi
		for f in edge-setup_linux_amd64 install.sh SHA256SUMS; do printf '{}\n' > "$f.sigstore.json"; done
	)
}
check() { bash "$root/scripts/check-signed-dir.sh" "$tmp/d" > "$tmp/out" 2>&1; }
refused() {
	if check; then fail "accepted: $1"; fi
	grep -q "$2" "$tmp/out" || { cat "$tmp/out"; fail "no '$2' for: $1"; }
}

setup
check || { cat "$tmp/out"; fail "a complete signed directory was refused"; }

setup; rm "$tmp/d/install.sh.sigstore.json"; refused "a missing bundle" "differs from its SHA256SUMS"
setup; rm "$tmp/d/SHA256SUMS.sigstore.json"; refused "an unsigned manifest" "no signed SHA256SUMS"
setup; printf 'x\n' > "$tmp/d/extra"; refused "an extra file" "differs from its SHA256SUMS"
setup; mkdir "$tmp/d/sub"; refused "a directory" "differs from its SHA256SUMS"
setup; rm "$tmp/d/install.sh"; ln -s edge-setup_linux_amd64 "$tmp/d/install.sh"; refused "a symlink" "not a regular file"
setup; printf '%064d  ../escape\n' 0 >> "$tmp/d/SHA256SUMS"; refused "a path in SHA256SUMS" "unexpected name"
setup; : > "$tmp/d/SHA256SUMS"; refused "an empty manifest" "lists no file"

echo "check-signed-dir test: OK"
