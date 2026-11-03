#!/usr/bin/env bash
# Runs shellcheck on every shell script edge-setup ships or runs: the install
# bootstrap served by the documentation site, and every file of edge-setup/
# tracked by git whose first line is a sh or bash shebang. Any finding, down
# to the style level, fails. SHELLCHECK overrides the command, e.g.
#   SHELLCHECK="docker run --rm -v $PWD/..:$PWD/.. -w $PWD/.. koalaman/shellcheck:v0.11.0"
set -euo pipefail

root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$root"

scripts=(docs/public/install)
while IFS= read -r -d '' f; do
	if head -n 1 "$f" | grep -qE '^#!(/usr)?/bin/(env )?(ba|da)?sh([[:space:]]|$)'; then
		scripts+=("$f")
	fi
done < <(git ls-files -z -- edge-setup)

read -r -a cmd <<<"${SHELLCHECK:-shellcheck}"
"${cmd[@]}" --version | sed -n 2p
"${cmd[@]}" -S style "${scripts[@]}"
echo "shellcheck: ${#scripts[@]} scripts, no finding"
