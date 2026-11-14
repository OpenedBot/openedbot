#!/usr/bin/env bash
set -euo pipefail

# Where the development PostgreSQL and Mailpit come from.
#
#   shared   (OPENEDBOT_DEV_INFRA unset or empty) containers owned by another
#            compose project on this machine (infra-postgres, infra-mailpit by
#            default). This repository starts them when stopped, never creates
#            them.
#   compose  the containers of compose.dev.yml (openedbot-dev-postgres,
#            openedbot-dev-mailpit), created with `docker compose up` when
#            absent. `make setup` chooses it for a new .env.local when no
#            infra-postgres container exists.
#
# usage: scripts/dev-infra.sh --detect
#          prints the mode a new .env.local should get: `shared` when the
#          infra-postgres container exists, `compose` otherwise.
#        scripts/dev-infra.sh --ensure <container>
#          compose mode only: creates the compose.dev.yml stack when
#          <container> does not exist. Does nothing in shared mode.
# Docker must be reachable; the callers check it first.

root="$(cd "$(dirname "$0")/.." && pwd)"
compose_file="$root/compose.dev.yml"
shared_postgres="infra-postgres"
compose_containers="openedbot-dev-postgres openedbot-dev-mailpit"

usage() {
  printf 'usage: scripts/dev-infra.sh --detect | --ensure <container>\n' >&2
  exit 2
}

case "${1:-}" in
  --detect)
    [ "$#" -eq 1 ] || usage
    if docker inspect "$shared_postgres" >/dev/null 2>&1; then
      printf 'shared\n'
    else
      printf 'compose\n'
    fi
    ;;
  --ensure)
    [ "$#" -eq 2 ] || usage
    container="$2"
    mode="${OPENEDBOT_DEV_INFRA:-}"
    case "$mode" in
      "" | shared) exit 0 ;;
      compose) ;;
      *)
        printf 'OPENEDBOT_DEV_INFRA must be compose, shared or empty, not %s.\n' "$mode" >&2
        exit 1
        ;;
    esac
    case " $compose_containers " in
      *" $container "*) ;;
      *)
        printf 'OPENEDBOT_DEV_INFRA=compose starts %s, not %s. Set OPENEDBOT_POSTGRES_CONTAINER=openedbot-dev-postgres and OPENEDBOT_MAILPIT_CONTAINER=openedbot-dev-mailpit in .env.local, or empty OPENEDBOT_DEV_INFRA to use your own containers.\n' \
          "${compose_containers// / and }" "$container" >&2
        exit 1
        ;;
    esac
    if docker inspect "$container" >/dev/null 2>&1; then
      exit 0
    fi
    if ! docker compose version >/dev/null 2>&1; then
      printf 'The Docker Compose plugin is required (docker compose). Install it, then rerun this target.\n' >&2
      exit 1
    fi
    printf 'Creating the development containers of compose.dev.yml (%s)...\n' "${compose_containers// /, }"
    docker compose -f "$compose_file" up -d --wait
    ;;
  *) usage ;;
esac
