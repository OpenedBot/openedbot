#!/usr/bin/env bash
set -euo pipefail

# Offline contract: every db/migrations/NNNN_name.sql records its own version
# in schema_migrations. scripts/db.sh (like any deployment migrator) skips a file
# only when its version is there, so a migration that forgets the insert is
# replayed on every run and fails once its DDL already exists (0106 did).

root="$(cd "$(dirname "$0")/../.." && pwd)"
status=0

for migration in "$root"/db/migrations/*.sql; do
  version="$(basename "$migration" .sql)"
  # Whitespace is collapsed first: some files split the insert over two lines.
  if ! tr -s '[:space:]' ' ' < "$migration" \
    | grep -Eqi "insert into schema_migrations ?\(version\) values ?\('${version}'\)"; then
    printf 'migration record contract failed: %s does not insert its version %s into schema_migrations.\n' \
      "db/migrations/$version.sql" "$version" >&2
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  printf 'migration record contract: every migration records its own version.\n'
fi
exit "$status"
