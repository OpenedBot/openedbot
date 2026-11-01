#!/usr/bin/env bash
# The installer (docs/public/install) must ask cosign for one exact
# certificate identity: the release workflow run on the tag of the version it
# installs (the pinned one, --version, --version= or EDGE_SETUP_VERSION, or
# LATEST once resolved), never a prefix or a pattern. A version that is not a
# plain vX.Y.Z is refused before anything is fetched. Offline: curl, cosign,
# uname and id are fakes on PATH, and the release origin is a directory.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
installer="$root/../docs/public/install"
[[ -f "$installer" ]] || { echo "install-identity test: no installer at $installer" >&2; exit 1; }
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-install-identity.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

prefix="https://github.com/OpenedBot/openedbot/.github/workflows/edge-setup-release.yml@refs/tags/edge-setup/"
issuer="https://token.actions.githubusercontent.com"
pinned="$(sed -n 's/^PINNED_VERSION="\(.*\)"$/\1/p' "$installer")"
[[ -n "$pinned" ]] || { echo "install-identity test: no PINNED_VERSION in the installer" >&2; exit 1; }

fail() { echo "install-identity test: $*" >&2; [[ -f "$tmp/out" ]] && cat "$tmp/out" >&2; exit 1; }

mkdir -p "$tmp/bin" "$tmp/origin"
# curl: serves https://releases.openedbot.app/edge-setup/<path> from origin/<path>.
cat > "$tmp/bin/curl" <<'FAKE'
#!/bin/sh
out=""
while [ "$#" -gt 1 ]; do
  [ "$1" = -o ] && out="$2"
  shift
done
echo "$1" >> "$FAKE_LOG/curl"
path="${1#https://releases.openedbot.app/edge-setup/}"
[ "$path" != "$1" ] && [ -f "$FAKE_ORIGIN/$path" ] || exit 22
cp "$FAKE_ORIGIN/$path" "$out"
FAKE
# cosign: the bundle holds the identity that signed; verify-blob passes only
# when the identity asked for is that one, character for character.
cat > "$tmp/bin/cosign" <<'FAKE'
#!/bin/sh
printf '%s\n' "$@" > "$FAKE_LOG/cosign"
identity=""; issuer=""; bundle=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --certificate-identity) identity="$2"; shift ;;
    --certificate-oidc-issuer) issuer="$2"; shift ;;
    --bundle) bundle="$2"; shift ;;
    --certificate-identity-regexp*|--certificate-oidc-issuer-regexp*) echo "pattern refused" >&2; exit 1 ;;
  esac
  shift
done
[ "$issuer" = "https://token.actions.githubusercontent.com" ] || { echo "wrong issuer" >&2; exit 1; }
[ "$identity" = "$(cat "$bundle")" ] || { echo "none of the expected identities matched" >&2; exit 1; }
FAKE
# shellcheck disable=SC2016 # a script, expanded when it runs
printf '#!/bin/sh\ncase "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac\n' > "$tmp/bin/uname"
printf '#!/bin/sh\necho 0\n' > "$tmp/bin/id"
chmod +x "$tmp/bin/"*

# release VERSION [SIGNED_FOR]: a release whose SHA256SUMS is signed by the
# workflow run on SIGNED_FOR (default: VERSION itself).
release() {
  local dir="$tmp/origin/$1"
  mkdir -p "$dir"
  printf '#!/bin/sh\necho "edge-setup %s"\n' "$1" > "$dir/edge-setup_linux_amd64"
  (cd "$dir" && sha256sum edge-setup_linux_amd64 > SHA256SUMS)
  printf '%s' "$prefix${2:-$1}" > "$dir/SHA256SUMS.sigstore.json"
}

# run [ENV=VALUE...] -- ARGS...: the installer with the fakes; exit code in $rc.
run() {
  local env=()
  while [[ "$1" != -- ]]; do env+=("$1"); shift; done
  shift
  rm -rf "$tmp/log" "$tmp/dest"; mkdir -p "$tmp/log" "$tmp/dest"
  rc=0
  env -u EDGE_SETUP_VERSION -u HERMES_SETUP_VERSION -u HERMES_SETUP_DEST \
    PATH="$tmp/bin:$PATH" FAKE_LOG="$tmp/log" FAKE_ORIGIN="$tmp/origin" \
    EDGE_SETUP_COSIGN="$tmp/bin/cosign" EDGE_SETUP_DEST="$tmp/dest/edge-setup" \
    "${env[@]}" sh "$installer" "$@" >"$tmp/out" 2>&1 || rc=$?
}

# installed VERSION: the run succeeded, cosign was asked for the exact
# identity of VERSION and the issuer, and the binary of VERSION is in place.
installed() {
  [[ "$rc" -eq 0 ]] || fail "$1: install failed (exit $rc)"
  grep -qxF -- "$prefix$1" "$tmp/log/cosign" || fail "$1: cosign was not asked for $prefix$1"
  grep -qxF -- "$issuer" "$tmp/log/cosign" || fail "$1: cosign was not asked for the issuer"
  [[ "$(grep -c -- '^--certificate-identity$' "$tmp/log/cosign")" -eq 1 ]] || fail "$1: not exactly one identity"
  if grep -q -- 'regexp' "$tmp/log/cosign"; then fail "$1: a pattern reached cosign"; fi
  grep -qF "signature verified: $prefix$1" "$tmp/out" || fail "$1: no verified identity printed"
  [[ "$("$tmp/dest/edge-setup")" == "edge-setup $1" ]] || fail "$1: not the binary of $1"
}

refused() {
  [[ "$rc" -ne 0 ]] || fail "$1: accepted"
  [[ ! -e "$tmp/dest/edge-setup" ]] || fail "$1: something was installed"
}

release "$pinned"
release v0.0.1
release v0.0.4
release v0.0.5 v0.0.4            # signed by the run on another tag
release v0.0.6 v0.0.60           # signed by a tag that only shares a prefix
release v0.0.7 v0.0.            # signed for the bare prefix
mkdir -p "$tmp/origin/v0.0.8"    # signed by no one
cp "$tmp/origin/v0.0.1/"edge-setup_linux_amd64 "$tmp/origin/v0.0.1/SHA256SUMS" "$tmp/origin/v0.0.8/"

run -- ;                                   installed "$pinned"
run -- --version v0.0.1;                   installed v0.0.1
run -- --version=v0.0.1;                   installed v0.0.1
run EDGE_SETUP_VERSION=v0.0.1 -- ;         installed v0.0.1
run EDGE_SETUP_VERSION=v0.0.4 -- --version v0.0.1; installed v0.0.1

printf 'v0.0.4\n' > "$tmp/origin/LATEST"
run -- --version latest;                   installed v0.0.4

for v in v0.0.5 v0.0.6 v0.0.7 v0.0.8; do
  run -- --version "$v"; refused "$v"
  grep -qF "does not verify for $prefix$v" "$tmp/out" ||
    [[ "$v" == v0.0.8 ]] || fail "$v: refused for another reason"
done

# Not a vX.Y.Z: refused before any download and before cosign runs. The
# octal escape is the case awk -v used to let through (awk expands it, the
# shell does not).
# shellcheck disable=SC2016 # literal $(id): it must never be expanded
bad=('v0.0.*' 'v0.0.?' 'v0.0.[1]' 'v0.0.1*' 'v0.0.\061' 'v0.0.1/../v0.0.4' '../v0.0.1'
  'v0.0.1;id' 'v0.0.1$(id)' 'v0.0.1 ' ' v0.0.1' $'v0.0.1\nv0.0.4' 'v01.0.0' 'v0.00.1' 'v0.0.01'
  'v0.0.1-rc1' 'v0.0.1+meta' 'v0.0' 'v0.0.1.2' 'v..1' 'v0..1' 'v0.0.' 'V0.0.1' '0.0.1' 'v' 'vlatest'
  'v99999999999999999999999999999.0.0')
for v in "${bad[@]}"; do
  run -- --version "$v"; refused "$v"
  grep -qF "invalid version" "$tmp/out" || fail "$v: refused for another reason"
  [[ ! -e "$tmp/log/curl" && ! -e "$tmp/log/cosign" ]] || fail "$v: something was fetched or verified"
  run EDGE_SETUP_VERSION="$v" -- ; refused "env $v"
  grep -qF "invalid version" "$tmp/out" || fail "env $v: refused for another reason"
done

# LATEST that is not a vX.Y.Z is refused after that one fetch, before any other.
for v in 'v0.0.*' 'v0.0.\061' '../v0.0.1'; do
  printf '%s\n' "$v" > "$tmp/origin/LATEST"
  run -- --version latest; refused "LATEST $v"
  grep -qF "invalid version" "$tmp/out" || fail "LATEST $v: refused for another reason"
  [[ "$(cat "$tmp/log/curl")" == "https://releases.openedbot.app/edge-setup/LATEST" ]] || fail "LATEST $v: fetched more than LATEST"
done

echo "install-identity test: OK"
