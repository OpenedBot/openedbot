#!/usr/bin/env bash
set -euo pipefail

# Offline contract for `backdrop-filter` declarations.
#
# Tailwind 4 minifies the bundle with Lightning CSS (targets safari 16.4,
# chrome 111, firefox 128). When `backdrop-filter` is declared BEFORE
# `-webkit-backdrop-filter` in the same rule, Lightning CSS keeps only the
# prefixed one, and Chromium and Firefox ignore `-webkit-backdrop-filter`:
# the blur vanishes on Android and desktop Chrome, and a translucent surface
# (menu sheet, mobile header, toaster) shows the page ghosted through it.
# Declared the other way round, both survive. Proven on lightningcss 1.32.0
# (2026-10-06); this contract keeps the order, without a build.
#
# Rule: in every shipped stylesheet, `-webkit-backdrop-filter` precedes
# `backdrop-filter` inside a rule, or `backdrop-filter` stands alone (Lightning
# CSS then adds the prefix itself).

root="$(cd "$(dirname "$0")/../.." && pwd)"
errors=0

fail() { printf 'css-backdrop-order-contract: %s\n' "$1" >&2; errors=$((errors + 1)); }

checked=0
while IFS= read -r file; do
  checked=$((checked + 1))
  # The unprefixed line immediately followed by the prefixed one, inside a rule.
  if awk '
    /^[[:space:]]*backdrop-filter[[:space:]]*:/ { pending = NR; next }
    /^[[:space:]]*-webkit-backdrop-filter[[:space:]]*:/ { if (pending == NR - 1) { print pending; bad = 1 } }
    /}/ { pending = 0 }
    END { exit bad ? 0 : 1 }
  ' "$file" >/tmp/css-backdrop-order.$$ 2>/dev/null; then
    while IFS= read -r line; do
      fail "${file#"$root"/}:$line : backdrop-filter precede -webkit-backdrop-filter ; inverser (le minifieur supprime la version non prefixee)"
    done </tmp/css-backdrop-order.$$
  fi
done < <(find "$root/apps" "$root/browser" "$root/modules" "$root/platform" \
  -type f -name '*.css' -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null)
rm -f /tmp/css-backdrop-order.$$

[[ $checked -gt 0 ]] || fail "aucune feuille de style trouvee"

if [[ $errors -gt 0 ]]; then
  printf 'css-backdrop-order-contract: %d erreur(s)\n' "$errors" >&2
  exit 1
fi
printf 'css-backdrop-order-contract: OK (%d feuilles)\n' "$checked"
