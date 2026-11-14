#!/usr/bin/env bash
set -euo pipefail

# Offline contract for scripts/db-backup.sh, with fake PostgreSQL tools: the
# newest verified dump is the only copy kept, a failed or unreadable dump never
# replaces the previous one, nothing else in the directory is touched, and the
# refusals (name, path, space, concurrent run) write nothing.

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/scripts/db-backup.sh"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
fake_bin="$work/bin"
mkdir -p "$fake_bin"

fail() {
  printf 'db-backup contract failed: %s\n' "$1" >&2
  exit 1
}

# psql answers the database size and migration counts, tracks scratch cleanup;
# pg_dump writes a body or fails;
# pg_restore --list shows schema_migrations data unless told otherwise; df
# reports FAKE_FREE_KB free kilobytes.
cat > "$fake_bin/psql" <<'EOF'
#!/bin/bash
case "$*" in
  *'create database openedbot_restore_check'*)
    # Model the previous DROP+CREATE as well, so the collision regression
    # proves that neither the existing database nor its contents are replaced.
    [[ "$*" != *'drop database if exists openedbot_restore_check'* ]] || rm -f "$FAKE_SCRATCH"
    [ ! -e "$FAKE_SCRATCH" ] || exit 1
    touch "$FAKE_SCRATCH"
    ;;
  *'drop database if exists openedbot_restore_check'*) rm -f "$FAKE_SCRATCH" ;;
  *'select count(*) from schema_migrations'*)
    case "$*" in
      *'-d openedbot_restore_check '*) printf '%s\n' "${FAKE_RESTORED_MIGRATIONS:-10}" ;;
      *) printf '10\n' ;;
    esac
    ;;
  *) printf '%s\n' "${FAKE_DB_SIZE:-1000}" ;;
esac
EOF
cat > "$fake_bin/pg_dump" <<'EOF'
#!/bin/bash
[ "${FAKE_DUMP_FAILS:-0}" = 1 ] && { printf 'partial'; exit 1; }
printf 'dump-body'
EOF
cat > "$fake_bin/pg_restore" <<'EOF'
#!/bin/bash
if [ "$1" != --list ]; then
  [ -f "$FAKE_SCRATCH" ] || exit 1
  cat > /dev/null
  [ "${FAKE_RESTORE_FAILS:-0}" != 1 ] || exit 1
  exit 0
fi
[ "${FAKE_LIST:-ok}" = broken ] && exit 1
[ "${FAKE_LIST:-ok}" = empty ] && { echo '1; 0 1 TABLE DATA public other x'; exit 0; }
echo '3843; 0 137094 TABLE DATA public schema_migrations test'
EOF
cat > "$fake_bin/df" <<'EOF'
#!/bin/bash
echo 'Filesystem 1024-blocks Used Available Capacity Mounted'
echo "fake 100 0 ${FAKE_FREE_KB:-1000000} 0% /"
EOF
chmod +x "$fake_bin"/*

backups="$work/backups"
run_backup() {
  FAKE_SCRATCH="$work/scratch" PATH="$fake_bin:/usr/bin:/bin" /bin/bash "$script" "$@"
}

reset_dir() {
  rm -rf "$backups"
  mkdir -p "$backups"
  printf 'old' > "$backups/openedbot-20200101T000000Z.dump"
  printf 'stale' > "$backups/openedbot-20200102T000000Z.dump.partial"
  printf 'other' > "$backups/otherdb-20200101T000000Z.dump"
  printf 'keep' > "$backups/notes.txt"
}

dumps_of_openedbot() {
  find "$backups" -maxdepth 1 -name 'openedbot-*' | sort
}

# 1. Success: one new dump, 0600, the older openedbot copies gone, the other
#    database's dump and the unrelated file kept, no lock left behind.
reset_dir
run_backup --dir "$backups" --database openedbot > "$work/out" 2>&1 || fail "a normal run failed: $(cat "$work/out")"
[ "$(dumps_of_openedbot | wc -l | tr -d ' ')" = 1 ] || fail "exactly one openedbot copy must stay; got: $(dumps_of_openedbot)"
kept="$(dumps_of_openedbot)"
[[ "$kept" =~ /openedbot-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || fail "unexpected kept file: $kept"
[ "$(cat "$kept")" = dump-body ] || fail "the kept copy is not the new dump"
mode="$(stat -c '%a' "$kept" 2>/dev/null || stat -f '%Lp' "$kept")"
[ "$mode" = 600 ] || fail "the dump must be 0600, got $mode"
[ -f "$backups/otherdb-20200101T000000Z.dump" ] || fail "another database's dump was deleted"
[ -f "$backups/notes.txt" ] || fail "an unrelated file was deleted"
[ ! -e "$backups/.db-backup.lock" ] || fail "the lock was left behind"

# 2. pg_dump fails: the previous copy stays, no partial file is left.
reset_dir
if FAKE_DUMP_FAILS=1 run_backup --dir "$backups" --database openedbot > "$work/out" 2>&1; then
  fail "a failed pg_dump must exit non-zero"
fi
[ -f "$backups/openedbot-20200101T000000Z.dump" ] || fail "a failed pg_dump deleted the previous copy"
[ "$(dumps_of_openedbot | wc -l | tr -d ' ')" = 2 ] || fail "a failed pg_dump left a file: $(dumps_of_openedbot)"
[ ! -e "$backups/.db-backup.lock" ] || fail "the lock was left behind after a failure"

# 3. The dump does not read back, or holds no schema_migrations: previous kept.
for listing in broken empty; do
  reset_dir
  if FAKE_LIST="$listing" run_backup --dir "$backups" --database openedbot > "$work/out" 2>&1; then
    fail "an unverifiable dump ($listing) must exit non-zero"
  fi
  [ -f "$backups/openedbot-20200101T000000Z.dump" ] || fail "an unverifiable dump ($listing) deleted the previous copy"
  [ "$(dumps_of_openedbot | wc -l | tr -d ' ')" = 2 ] || fail "an unverifiable dump ($listing) left a file: $(dumps_of_openedbot)"
done

# 4. Not enough free space: refused before anything is written.
reset_dir
if FAKE_DB_SIZE=5000000 FAKE_FREE_KB=1 run_backup --dir "$backups" --database openedbot > "$work/out" 2>&1; then
  fail "a full disk must be refused"
fi
grep -q 'not enough space' "$work/out" || fail "the space refusal must say so; got: $(cat "$work/out")"
[ "$(dumps_of_openedbot | wc -l | tr -d ' ')" = 2 ] || fail "the space refusal touched the copies"

# 5. A run already holds the lock: refused, the lock and copies untouched.
reset_dir
mkdir "$backups/.db-backup.lock"
if run_backup --dir "$backups" --database openedbot > "$work/out" 2>&1; then
  fail "a concurrent run must be refused"
fi
[ -d "$backups/.db-backup.lock" ] || fail "the refused run removed the other run's lock"
[ -f "$backups/openedbot-20200101T000000Z.dump" ] || fail "the refused run touched the copies"
rmdir "$backups/.db-backup.lock"

# 6. Arguments that could reach a glob or SQL are refused.
for args in "--dir $backups --database Bad-Name" "--dir $backups --database a;b" "--dir relative --database openedbot" "--database openedbot" "--dir $backups"; do
  # shellcheck disable=SC2086
  if run_backup $args > "$work/out" 2>&1; then
    fail "arguments must be refused: $args"
  fi
done

# 7. A failed restore or migration mismatch keeps all previous copies and
#    releases both the scratch database and the lock.
for failure in restore mismatch empty; do
  reset_dir
  restore_fails=0
  restored_migrations=10
  case "$failure" in
    restore) restore_fails=1 ;;
    mismatch) restored_migrations=9 ;;
    empty) restored_migrations=0 ;;
  esac
  if FAKE_RESTORE_FAILS="$restore_fails" FAKE_RESTORED_MIGRATIONS="$restored_migrations" \
    run_backup --dir "$backups" --database openedbot --restore-check > "$work/out" 2>&1; then
    fail "a failed restore check ($failure) must exit non-zero"
  fi
  if [ "$failure" = restore ]; then
    grep -q 'restore into openedbot_restore_check failed' "$work/out" || fail "restore failure was not reached"
  else
    grep -q "restored copy has $restored_migrations migrations, the source 10" "$work/out" || fail "migration check was not reached"
  fi
  [ "$(cat "$backups/openedbot-20200101T000000Z.dump")" = old ] || fail "a failed restore check ($failure) changed the previous copy"
  [ -f "$backups/openedbot-20200102T000000Z.dump.partial" ] || fail "a failed restore check ($failure) rotated stale copies"
  [ ! -e "$work/scratch" ] || fail "a failed restore check ($failure) left the scratch database"
  [ ! -e "$backups/.db-backup.lock" ] || fail "a failed restore check ($failure) left the lock"
done

# 8. A successful restore check rotates old copies and cleans scratch/lock.
reset_dir
run_backup --dir "$backups" --database openedbot --restore-check > "$work/out" 2>&1 \
  || fail "a restore check failed: $(cat "$work/out")"
grep -q 'restore check passed: 10 migrations' "$work/out" || fail "the restore check did not run"
[ "$(dumps_of_openedbot | wc -l | tr -d ' ')" = 1 ] || fail "a successful restore check must rotate old copies"
[ "$(cat "$(dumps_of_openedbot)")" = dump-body ] || fail "the restored copy is not the new dump"
[ -f "$backups/otherdb-20200101T000000Z.dump" ] || fail "restore rotation deleted another database's dump"
[ -f "$backups/notes.txt" ] || fail "restore rotation deleted an unrelated file"
[ ! -e "$work/scratch" ] || fail "a successful restore check left the scratch database"
[ ! -e "$backups/.db-backup.lock" ] || fail "a successful restore check left the lock"

# 9. A pre-existing scratch database belongs to someone else: refuse without
# deleting it during setup or EXIT cleanup, and retain the previous backup.
reset_dir
printf 'foreign scratch contents' > "$work/scratch"
if run_backup --dir "$backups" --database openedbot --restore-check > "$work/out" 2>&1; then
  fail "a scratch database collision must refuse the restore check"
fi
[ "$(cat "$work/scratch")" = 'foreign scratch contents' ] || fail "a scratch database collision deleted foreign data"
[ "$(cat "$backups/openedbot-20200101T000000Z.dump")" = old ] || fail "a scratch database collision rotated the previous backup"
[ ! -e "$backups/.db-backup.lock" ] || fail "a scratch database collision left the lock"

printf 'db-backup contract passed.\n'
