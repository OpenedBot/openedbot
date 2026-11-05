#!/usr/bin/env bash
# make notes-check must refuse public release notes that expose a ticket, an
# internal route, an error code, a host path or an em dash, and accept product
# copy. It must fail closed: a missing regex engine is an error, not a pass.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/edge-notes-test.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

check() { NOTES_FILE="$1" make -s -C "$root" notes-check >"$tmp/out" 2>&1; }

# Literal backticks: the release notes show the command as code.
# shellcheck disable=SC2016
printf '### Nouveautés\n\n- Vos bots répondent plus vite.\n\nMise à jour : `sudo edge-setup upgrade --yes`.\n' > "$tmp/good.md"
check "$tmp/good.md" || { cat "$tmp/out"; echo "notes-check test: product copy refused" >&2; exit 1; }

for bad in 'Corrige DEV-OPS-247.' 'Nouvelle route /hermes-setup/providers.' 'Code RUNTIME_NOT_FOUND.' 'Fichier /etc/hermes/runtime.env.' "Rapide $(printf '\xe2\x80\x94') vraiment."; do
	printf '%s\n' "$bad" > "$tmp/bad.md"
	if check "$tmp/bad.md"; then echo "notes-check test: accepted: $bad" >&2; exit 1; fi
done
echo "notes-check test: OK"
