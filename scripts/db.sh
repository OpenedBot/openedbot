#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  printf 'usage: scripts/db.sh --up | --migrate | --reset [--yes] [--dry-run]\n' >&2
  exit 2
}

if [ "$#" -lt 1 ]; then
  usage
fi

db_up() {
  # PostgreSQL only, and never created here. The development database lives in
  # the shared dev-infra container (OHB_POSTGRES_CONTAINER, default
  # infra-postgres) owned by another compose project: this script starts it when
  # it is stopped and waits for it, but refuses to invent one when it is absent.
  # Never starts Hermes: this repository does not provision one.

  container="${OHB_POSTGRES_CONTAINER:-infra-postgres}"

  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required. Install Docker Engine with the Compose plugin, then rerun make setup.\n' >&2
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    printf 'The Docker daemon is unavailable. Start Docker, then rerun make setup.\n' >&2
    exit 1
  fi

  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf 'PostgreSQL container %s does not exist. Start your shared dev-infra stack (the compose project that owns %s) first; this repository never creates PostgreSQL itself.\n' "$container" "$container" >&2
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
    printf 'Starting existing PostgreSQL container %s...\n' "$container"
    docker start "$container" >/dev/null
  else
    printf 'Reusing existing PostgreSQL container %s.\n' "$container"
  fi

  printf 'Waiting for PostgreSQL in %s...\n' "$container"
  for _ in $(seq 1 60); do
    if docker exec "$container" sh -ceu 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      printf 'PostgreSQL is ready.\n'
      break
    fi
    sleep 1
  done

  if ! docker exec "$container" sh -ceu 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    printf 'PostgreSQL did not become ready in %s within 60 seconds.\n' "$container" >&2
    docker logs --tail 20 "$container" >&2
    exit 1
  fi

  exit 0
}

db_migrate() {
  container="${OHB_POSTGRES_CONTAINER:-infra-postgres}"
  database="${OHB_DATABASE_NAME:-ohb}"

  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf 'PostgreSQL container %s is not available. Run make infra-up first.\n' "$container" >&2
    exit 1
  fi

  docker exec "$container" sh -ceu '
    psql -v ON_ERROR_STOP=1 -v database_name="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
select format('\''create database %I'\'', :'\''database_name'\'')
where not exists (select from pg_database where datname = :'\''database_name'\'')\gexec
do \$\$
begin
  if not exists (select from pg_roles where rolname = '\''ohb_api'\'') then
    create role ohb_api login password '\''ohb_api_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = '\''ohb_worker'\'') then
    create role ohb_worker login password '\''ohb_worker_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = '\''ohb_staff'\'') then
    create role ohb_staff login password '\''ohb_staff_dev'\'' nosuperuser nocreatedb nocreaterole;
  end if;
end
\$\$;
select format('\''grant connect on database %I to ohb_api, ohb_worker, ohb_staff'\'', :'\''database_name'\'')\gexec
SQL
  ' -- "$database"

  # The applied set is read ONCE. Asking the database file by file cost one
  # `docker exec` and one psql handshake per migration — around 50 ms each,
  # paid on every `make db-migrate` even when nothing is pending, and growing
  # linearly with the number of files. A missing `schema_migrations` (fresh
  # database) reads as the empty set, so everything is pending.
  applied="$(docker exec "$container" sh -ceu 'psql -At -U "$POSTGRES_USER" -d "$1" -c "select version from schema_migrations" 2>/dev/null || true' -- "$database")"

  # A literal newline, so a version is matched delimited on both sides:
  # `0055_x` must not answer for `0055_x_bis`. Command substitution would eat
  # the trailing one, hence the variable.
  newline='
'
  skipped=0
  for migration in "$root"/db/migrations/*.sql; do
    version="$(basename "$migration" .sql)"
    case "$newline$applied$newline" in
      *"$newline$version$newline"*)
        skipped=$((skipped + 1))
        continue
        ;;
    esac
    docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"' -- "$database" < "$migration"
    printf 'Migration %s applied to %s.\n' "$version" "$database"
  done

  # Pro plug-in migrations, after every core one. Solo mode
  # (OHB_PRO_PLUGINS empty or unset) never gets here: nothing else runs.
  # scripts/pro-migrations.ts prints `<id>:<file>\t<path>` lines; the version
  # is recorded by this script, in the same transaction as the file, so a
  # plug-in migration needs no insert of its own.
  if [ -n "${OHB_PRO_PLUGINS:-}" ]; then
    pro_plan="$(cd "$root" && OHB_PRO_PLUGINS="$OHB_PRO_PLUGINS" bun scripts/pro-migrations.ts)"
    while IFS="$(printf '\t')" read -r version migration; do
      [ -n "$version" ] || continue
      if ! printf '%s' "$version" | grep -Eq '^[a-z][a-z0-9-]{1,39}:[0-9]{4}_[a-z0-9_]+$'; then
        printf 'Refusing pro migration with an unexpected version: %s\n' "$version" >&2
        exit 1
      fi
      case "$newline$applied$newline" in
        *"$newline$version$newline"*)
          skipped=$((skipped + 1))
          continue
          ;;
      esac
      {
        cat "$migration"
        printf "\ninsert into schema_migrations(version) values ('%s') on conflict (version) do nothing;\n" "$version"
      } | docker exec -i "$container" sh -ceu 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$1"' -- "$database"
      printf 'Migration %s applied to %s.\n' "$version" "$database"
    done <<EOF_PRO_PLAN
$pro_plan
EOF_PRO_PLAN
  fi
  printf '%s migration(s) already applied.\n' "$skipped"
}

db_reset() {
  # Drops and recreates the openedbot development database inside the shared
  # dev-infra PostgreSQL container (OHB_POSTGRES_CONTAINER, default
  # infra-postgres). Exactly one database is touched: the container, its volume
  # and every other database it hosts (other projects, the maintenance database)
  # are left alone. The roles are not dropped; scripts/db.sh --migrate recreates
  # them anyway and re-grants CONNECT.
  #
  # Refuses without --yes. --dry-run prints the SQL that would run and never
  # calls docker.

  container="${OHB_POSTGRES_CONTAINER:-infra-postgres}"
  database="${OHB_DATABASE_NAME:-ohb}"
  dry_run=0
  confirmed=0
  for flag in "$@"; do
    case "$flag" in
      --yes) confirmed=1 ;;
      --dry-run) dry_run=1 ;;
      *) usage ;;
    esac
  done

  if [ "$confirmed" != 1 ]; then
    printf 'Refusing to reset database %s: it destroys the local development data. Pass --yes (make db-reset CONFIRM=yes does).\n' "$database" >&2
    exit 1
  fi

  # The name is spliced into SQL as a quoted identifier: only plain identifiers
  # are accepted, and the databases every project depends on are never a target.
  case "$database" in
    postgres|template0|template1)
      printf 'Refusing to reset %s: it is a system database, not the openedbot one.\n' "$database" >&2
      exit 1
      ;;
  esac
  if ! printf '%s' "$database" | grep -Eq '^[a-z_][a-z0-9_]{0,62}$'; then
    printf 'OHB_DATABASE_NAME must be a plain lowercase identifier, not %s.\n' "$database" >&2
    exit 1
  fi

  # `with (force)` terminates the sessions the drop itself would otherwise
  # collide with (an API pool reconnecting between our terminate and our drop).
  # The explicit terminate stays for older servers and for a readable plan.
  sql_template="$(cat <<'SQL'
\set ON_ERROR_STOP on
do $reset$
declare
  role_name text;
begin
  if exists (select from pg_database where datname = '__DATABASE__') then
    execute 'revoke connect on database "__DATABASE__" from public';
    for role_name in
      select rolname from pg_roles where rolname in ('ohb_api', 'ohb_worker', 'ohb_staff')
    loop
      execute format('revoke connect on database "__DATABASE__" from %I', role_name);
    end loop;
  end if;
end
$reset$;
select pg_terminate_backend(pid) from pg_stat_activity
 where datname = '__DATABASE__' and pid <> pg_backend_pid();
drop database if exists "__DATABASE__" with (force);
create database "__DATABASE__" encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0;
do $reset$
declare
  role_name text;
begin
  for role_name in
    select rolname from pg_roles where rolname in ('ohb_api', 'ohb_worker', 'ohb_staff')
  loop
    execute format('grant connect on database "__DATABASE__" to %I', role_name);
  end loop;
end
$reset$;
SQL
)"
  sql="${sql_template//__DATABASE__/$database}"

  if [ "$dry_run" = "1" ]; then
    printf 'Dry run: the following SQL would run in container %s as $POSTGRES_USER, nothing is executed.\n' "$container" >&2
    printf '%s\n' "$sql"
    exit 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker is required to reach the PostgreSQL container %s.\n' "$container" >&2
    exit 1
  fi
  if ! docker inspect "$container" >/dev/null 2>&1; then
    printf 'PostgreSQL container %s does not exist. Start your shared dev-infra stack (the compose project that owns %s) first.\n' "$container" "$container" >&2
    exit 1
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
    printf 'PostgreSQL container %s is not running. Run make db-up first.\n' "$container" >&2
    exit 1
  fi

  printf 'Dropping and recreating database %s in container %s (other databases untouched)...\n' "$database" "$container"
  # The maintenance database we connect to is never the target: dropping it is
  # impossible from its own session and would also be somebody else's data.
  printf '%s\n' "$sql" | docker exec -i "$container" sh -ceu '
    if [ "$1" = "$POSTGRES_DB" ]; then
      printf "Refusing to reset %s: it is the maintenance database of the shared container.\n" "$1" >&2
      exit 1
    fi
    psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  ' -- "$database"
  printf 'Database %s is empty again.\n' "$database"
}

case "$1" in
  --up) [ "$#" -eq 1 ] || usage; db_up ;;
  --migrate) [ "$#" -eq 1 ] || usage; db_migrate ;;
  --reset) shift; db_reset "$@" ;;
  *) usage ;;
esac
