#!/usr/bin/env bash
# Exercise the release asset contract with a fake Go compiler in a temp tree.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
make_bin="$(command -v make)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-release-build-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

arches=(amd64 arm64)
oses=(linux darwin)
expected_assets=()
for goos in "${oses[@]}"; do
	for arch in "${arches[@]}"; do
		expected_assets+=("edge-setup_${goos}_${arch}")
	done
done
expected_assets+=(install.sh)
expected_sorted="$(printf '%s\n' "${expected_assets[@]}" | LC_ALL=C sort)"
install_fixture="$tmp/install"
printf '#!/bin/sh\nPINNED_VERSION="v1.2.3"\n' > "$install_fixture"

write_fake_go() {
	local bin="$1"
	mkdir -p "$bin"
	cat > "$bin/go" <<'FAKE_GO'
#!/usr/bin/env bash
set -euo pipefail
case "${GOOS:-}:${GOARCH:-}" in
	linux:amd64|linux:arm64|darwin:amd64|darwin:arm64) ;;
	*) echo "unexpected target" >&2; exit 91 ;;
esac
out=
while (($#)); do
	if [[ "$1" == -o ]]; then
		(($# >= 2)) || exit 92
		out="$2"
		shift 2
	else
		shift
	fi
done
[[ "$out" == dist/edge-setup_* ]] || { echo "unexpected output path" >&2; exit 93; }
printf '%s/%s\n' "$GOOS" "$GOARCH" > "$out"
FAKE_GO
	chmod +x "$bin/go"
}

verify_build() {
	local work="$1"
	local manifest="$work/dist/SHA256SUMS"
	local names expected_line canonical
	[[ -f "$manifest" ]] || { echo "missing SHA256SUMS" >&2; return 1; }
	names="$(awk '{print $2}' "$manifest" | LC_ALL=C sort)"
	[[ "$names" == "$expected_sorted" ]] || {
		echo "SHA256SUMS names differ from the expected five assets" >&2
		printf 'actual:\n%s\nexpected:\n%s\n' "$names" "$expected_sorted" >&2
		return 1
	}
	[[ "$(wc -l < "$manifest" | tr -d '[:space:]')" == 5 ]] || {
		echo "SHA256SUMS must have exactly five entries" >&2
		return 1
	}
	if command -v sha256sum >/dev/null 2>&1; then
		(cd "$work/dist" && sha256sum --check --quiet SHA256SUMS)
	elif command -v shasum >/dev/null 2>&1; then
		(cd "$work/dist" && shasum -a 256 --check SHA256SUMS)
	else
		echo "no checksum verifier available" >&2
		return 1
	fi
	for goos in "${oses[@]}"; do
		for arch in "${arches[@]}"; do
			canonical="edge-setup_${goos}_${arch}"
			expected_line="$(awk -v name="$canonical" '$2 == name { print $1; exit }' "$manifest")"
			[[ -n "$expected_line" ]]
			[[ "$(cat "$work/dist/$canonical")" == "$goos/$arch" ]]
		done
	done
}

verify_release_assets() {
	local work="$1"
	local output actual expected
	output="$(cd "$work" && "$make_bin" --no-print-directory release-assets VERSION=fixture INSTALL_SCRIPT="$install_fixture")"
	actual="$(printf '%s\n' "$output" | LC_ALL=C sort)"
	expected="$(printf '%s\n' "${expected_assets[@]/#/dist/}" dist/SHA256SUMS | LC_ALL=C sort)"
	[[ "$actual" == "$expected" ]] || {
		echo "release-assets output differs from the expected paths" >&2
		printf 'actual:\n%s\nexpected:\n%s\n' "$actual" "$expected" >&2
		return 1
	}
}

primary="$tmp/primary"
primary_bin="$tmp/primary-bin"
mkdir -p "$primary"
cp "$root/Makefile" "$primary/Makefile"
write_fake_go "$primary_bin"
PATH="$primary_bin:$PATH" "$make_bin" --no-print-directory -C "$primary" build-all VERSION=fixture INSTALL_SCRIPT="$install_fixture"
verify_build "$primary"
verify_release_assets "$primary"
cmp -s "$install_fixture" "$primary/dist/install.sh" || { echo "dist/install.sh is not the bootstrap" >&2; exit 1; }

# A release build refuses an installer that does not pin that very release,
# and accepts the one that does.
if PATH="$primary_bin:$PATH" "$make_bin" --no-print-directory -C "$primary" build-all VERSION=v9.9.9 INSTALL_SCRIPT="$install_fixture" >/dev/null 2>&1; then
	echo "a v9.9.9 release was built with an installer pinned to v1.2.3" >&2; exit 1
fi
PATH="$primary_bin:$PATH" "$make_bin" --no-print-directory -C "$primary" build-all VERSION=v1.2.3 INSTALL_SCRIPT="$install_fixture" >/dev/null

# Exercise the fallback by removing sha256sum from PATH while retaining the
# real shasum and only the small set of commands build-all needs.
shasum_bin="$(command -v shasum || true)"
if [[ -n "$shasum_bin" ]]; then
	fallback="$tmp/fallback"
	fallback_bin="$tmp/fallback-bin"
	mkdir -p "$fallback" "$fallback_bin"
	cp "$root/Makefile" "$fallback/Makefile"
	write_fake_go "$fallback_bin"
	for tool in env bash cp mkdir rm shasum; do
		tool_path="$(command -v "$tool" || true)"
		if [[ -n "$tool_path" ]]; then ln -s "$tool_path" "$fallback_bin/$tool"; fi
	done
	[[ -x "$fallback_bin/env" && -x "$fallback_bin/bash" && -x "$fallback_bin/cp" && \
		-x "$fallback_bin/mkdir" && -x "$fallback_bin/rm" && -x "$fallback_bin/shasum" ]] || {
		echo "cannot prepare controlled PATH for shasum fallback" >&2
		exit 1
	}
	PATH="$fallback_bin" "$make_bin" --no-print-directory -C "$fallback" build-all VERSION=fixture INSTALL_SCRIPT="$install_fixture"
	verify_build "$fallback"
fi

echo "release build contract passed"
