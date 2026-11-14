#!/usr/bin/env bash
# Backs up the openedbot database before a deploy and keeps only that copy.
#
#   scripts/db-backup.sh --dir DIR --database NAME [--os-user USER] [--restore-check]
#
# Runs on the database host (or anywhere pg_dump reaches the database through
# the usual libpq variables: PGHOST, PGPORT, PGUSER, PGPASSWORD). It needs no
# deployment tool: a self-hosted install runs it before its migrations, and the
# hosted platform pipes it over SSH (`ssh host 'sudo -n bash -s -- ...' < this`).
#
# 1. Refuses when DIR's filesystem has less free space than the database.
# 2. Dumps NAME (pg_dump -Fc, one consistent snapshot) to DIR/NAME-<UTC>.dump,
#    written as a .partial file created 0600, checked with pg_restore --list,
#    then renamed. A failed or interrupted dump never replaces the last good one.
# 3. --restore-check restores the new copy into a scratch database
#    (NAME_restore_check), compares its migrations with the source, prints the
#    restore time, and drops the scratch database whatever happens.
# 4. Only after all requested checks pass, deletes every other NAME-*.dump
#    (and stale .partial) in DIR. Other files are not touched.
#
# --os-user runs pg_dump, psql and pg_restore as that system user (runuser),
# e.g. postgres with peer authentication, while the files stay owned by the
# caller. Two runs on the same DIR at once: the second one refuses.
set -euo pipefail

say() { printf '[db-backup] %s\n' "$*"; }
die() { printf '[db-backup] %s\n' "$*" >&2; exit 2; }
usage() { die "usage: scripts/db-backup.sh --dir DIR --database NAME [--os-user USER] [--restore-check]"; }

dir=""
database=""
os_user=""
restore_check=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) [ "$#" -ge 2 ] || usage; dir="$2"; shift 2 ;;
    --database) [ "$#" -ge 2 ] || usage; database="$2"; shift 2 ;;
    --os-user) [ "$#" -ge 2 ] || usage; os_user="$2"; shift 2 ;;
    --restore-check) restore_check=1; shift ;;
    *) usage ;;
  esac
done
[ -n "$dir" ] && [ -n "$database" ] || usage
case "$dir" in /*) ;; *) die "--dir must be an absolute path, not $dir" ;; esac
# The name reaches file globs and SQL identifiers: plain identifiers only, and
# short enough for the scratch database name (63 bytes) to stay distinct.
printf '%s' "$database" | grep -Eq '^[a-z_][a-z0-9_]{0,40}$' \
  || die "--database must be a plain lowercase identifier of at most 41 characters, not $database"
if [ -n "$os_user" ]; then
  printf '%s' "$os_user" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "unexpected --os-user: $os_user"
  command -v runuser >/dev/null 2>&1 || die "--os-user needs runuser (util-linux)"
fi
for tool in pg_dump pg_restore psql df; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
done

as_db() {
  if [ -n "$os_user" ]; then runuser -u "$os_user" -- "$@"; else "$@"; fi
}

umask 077
mkdir -p "$dir"

lock="$dir/.db-backup.lock"
mkdir "$lock" 2>/dev/null \
  || die "another backup holds $lock; if none is running (an interrupted run), remove that directory and retry"
partial=""
scratch=""
cleanup() {
  [ -z "$partial" ] || rm -f "$partial"
  if [ -n "$scratch" ]; then
    as_db psql -XqAt -d postgres -c "drop database if exists $scratch" >/dev/null 2>&1 \
      || printf '[db-backup] could not drop the scratch database %s: drop it by hand\n' "$scratch" >&2
  fi
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

source_size="$(as_db psql -XAt -v ON_ERROR_STOP=1 -d "$database" -c 'select pg_database_size(current_database())')" \
  || die "could not reach database $database"
free_bytes="$(df -Pk "$dir" | awk 'NR == 2 { printf "%.0f", $4 * 1024 }')"
[ -n "$free_bytes" ] || die "could not read the free space of $dir"
# A custom-format dump is compressed and smaller than the database: having the
# database's size free leaves room for the dump and for the previous copy,
# which is only deleted after the new one is verified.
if [ "$free_bytes" -le "$source_size" ]; then
  die "not enough space in $dir: $free_bytes bytes free, the database takes $source_size; nothing was written"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$dir/$database-$stamp.dump"
[ ! -e "$final" ] || die "$final already exists"
partial="$final.partial"

started="$(date +%s)"
# The redirection runs in this shell: the file belongs to the caller, 0600.
as_db pg_dump -Fc -d "$database" > "$partial" || die "pg_dump failed: the previous copies are kept"
dump_seconds=$(( $(date +%s) - started ))

contents="$(pg_restore --list "$partial")" || die "the new dump does not read back: the previous copies are kept"
# A here-string, not a pipe: grep -q stops at the first match, and under
# pipefail the writer's SIGPIPE would read as a failure.
grep -q 'TABLE DATA public schema_migrations ' <<<"$contents" \
  || die "the new dump holds no schema_migrations data: the previous copies are kept"
mv "$partial" "$final"
partial=""
say "saved $final ($(wc -c < "$final" | tr -d ' ') bytes, dumped in ${dump_seconds}s)"

if [ "$restore_check" = 1 ]; then
  restore_database="${database}_restore_check"
  # Never replace an existing database, and only clean up a database this
  # invocation successfully created. Another backup may own the same name.
  as_db psql -XqAt -v ON_ERROR_STOP=1 -d postgres -c "set client_min_messages = warning" \
    -c "create database $restore_database" >/dev/null \
    || die "could not create the scratch database $restore_database; existing databases are never replaced"
  scratch="$restore_database"
  started="$(date +%s)"
  # Through stdin: the file may be readable by the caller only.
  as_db pg_restore --exit-on-error -d "$scratch" < "$final" || die "restore into $scratch failed"
  restore_seconds=$(( $(date +%s) - started ))
  count='select count(*) from schema_migrations'
  expected="$(as_db psql -XAt -v ON_ERROR_STOP=1 -d "$database" -c "$count")"
  restored="$(as_db psql -XAt -v ON_ERROR_STOP=1 -d "$scratch" -c "$count")"
  # Run before the migrations, nothing changes schema_migrations in between.
  if [ "$restored" != "$expected" ] || [ "$restored" -lt 1 ]; then
    die "restored copy has $restored migrations, the source $expected"
  fi
  say "restore check passed: $restored migrations restored into $scratch in ${restore_seconds}s (dropped)"
fi

# Only rotate after all requested checks pass, so a failed restore check keeps
# the previous copies. The glob is anchored on the database name and the
# extensions this script writes, so nothing else in DIR is touched.
for old in "$dir/$database"-*.dump "$dir/$database"-*.dump.partial; do
  [ -e "$old" ] || continue
  [ "$old" = "$final" ] && continue
  rm -f "$old"
  say "removed $old"
done
