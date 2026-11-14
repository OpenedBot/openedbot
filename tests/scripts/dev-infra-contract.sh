#!/usr/bin/env bash
set -euo pipefail

# Offline contract for scripts/dev-infra.sh and its use by scripts/db.sh --up
# and scripts/setup.sh, against a fake docker:
#   - a workstation with its own containers (OPENEDBOT_DEV_INFRA empty) keeps
#     the old behaviour: nothing is created, an absent container is an error;
#   - OPENEDBOT_DEV_INFRA=compose creates compose.dev.yml only when the
#     expected container is absent, and refuses a container it does not define;
#   - setup only chooses the mode for an env file it has just created.

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"

test_directory="$(mktemp -d)"
trap 'rm -rf "$test_directory"' EXIT
fake_bin="$test_directory/bin"
mkdir -p "$fake_bin"
events="$test_directory/docker-events"
state="$test_directory/containers"

fail() {
  printf 'dev-infra contract failed: %s\n' "$1" >&2
  exit 1
}

# A docker that knows the containers listed in $FAKE_DOCKER_STATE (one name per
# line, all running and healthy) and records every call.
cat > "$fake_bin/docker" <<'FAKE'
#!/bin/bash
printf 'docker %s\n' "$*" >> "$FAKE_DOCKER_EVENTS"
case "$1" in
  info) exit 0 ;;
  inspect)
    name="${*: -1}"
    grep -qx "$name" "$FAKE_DOCKER_STATE" || exit 1
    [ "$2" = "-f" ] && printf 'true\n'
    exit 0
    ;;
  compose)
    [ "$2" = "version" ] && exit 0
    printf '%s\n' openedbot-dev-postgres openedbot-dev-mailpit >> "$FAKE_DOCKER_STATE"
    exit 0
    ;;
  exec | start | logs) exit 0 ;;
esac
exit 97
FAKE
chmod +x "$fake_bin/docker"

reset_docker() {
  : > "$events"
  printf '%s\n' "$@" > "$state"
}

run() {
  PATH="$fake_bin:/usr/bin:/bin" FAKE_DOCKER_EVENTS="$events" FAKE_DOCKER_STATE="$state" "$@"
}

compose_calls() {
  grep -c '^docker compose -f .* up -d --wait$' "$events" || true
}

# 1. Detection: a shared infra-postgres means `shared`, its absence `compose`.
reset_docker infra-postgres
[ "$(run bash scripts/dev-infra.sh --detect)" = shared ] || fail "--detect must answer shared when infra-postgres exists."
reset_docker
[ "$(run bash scripts/dev-infra.sh --detect)" = compose ] || fail "--detect must answer compose without infra-postgres."

# 2. Shared mode (unset or empty) never creates anything, even when absent.
reset_docker
run env -u OPENEDBOT_DEV_INFRA bash scripts/dev-infra.sh --ensure infra-postgres || fail "--ensure must succeed silently in shared mode."
run env OPENEDBOT_DEV_INFRA= bash scripts/dev-infra.sh --ensure openedbot-dev-postgres || fail "--ensure must succeed silently with an empty mode."
[ ! -s "$events" ] || fail "shared mode must not call docker: $(tr '\n' ';' < "$events")"

# 3. Compose mode creates the stack when the container is absent, once.
reset_docker
run env OPENEDBOT_DEV_INFRA=compose bash scripts/dev-infra.sh --ensure openedbot-dev-postgres >/dev/null || fail "--ensure must create the compose stack."
[ "$(compose_calls)" = 1 ] || fail "compose mode must run docker compose up -d --wait exactly once: $(tr '\n' ';' < "$events")"
grep -q "^docker compose -f $root/compose.dev.yml up -d --wait\$" "$events" || fail "the compose call must name compose.dev.yml at the repository root."

# 4. ... and leaves an existing container alone.
reset_docker openedbot-dev-postgres openedbot-dev-mailpit
run env OPENEDBOT_DEV_INFRA=compose bash scripts/dev-infra.sh --ensure openedbot-dev-mailpit || fail "--ensure must accept an existing container."
[ "$(compose_calls)" = 0 ] || fail "compose mode must not recreate an existing container."

# 5. Compose mode refuses a container compose.dev.yml does not define, and an unknown mode.
reset_docker
if run env OPENEDBOT_DEV_INFRA=compose bash scripts/dev-infra.sh --ensure infra-postgres 2>/dev/null; then
  fail "compose mode must refuse infra-postgres: compose.dev.yml never creates it."
fi
if run env OPENEDBOT_DEV_INFRA=docker bash scripts/dev-infra.sh --ensure openedbot-dev-postgres 2>/dev/null; then
  fail "an unknown OPENEDBOT_DEV_INFRA must be refused."
fi
[ "$(compose_calls)" = 0 ] || fail "a refused --ensure must not start anything."

# 6. db.sh --up: unchanged in shared mode, creates the stack in compose mode.
reset_docker
if run env -u OPENEDBOT_DEV_INFRA OPENEDBOT_POSTGRES_CONTAINER=infra-postgres bash scripts/db.sh --up >/dev/null 2>&1; then
  fail "db.sh --up must still refuse an absent shared container."
fi
[ "$(compose_calls)" = 0 ] || fail "db.sh --up in shared mode must never run docker compose."
reset_docker
run env OPENEDBOT_DEV_INFRA=compose OPENEDBOT_POSTGRES_CONTAINER=openedbot-dev-postgres bash scripts/db.sh --up >/dev/null \
  || fail "db.sh --up in compose mode must create then reuse openedbot-dev-postgres."
[ "$(compose_calls)" = 1 ] || fail "db.sh --up in compose mode must run docker compose up once."

# 7. setup.sh writes the mode only into the env file it has just created.
grep -q '^if \[ "$created_env_file" = 1 \] && \[ "$(bash scripts/dev-infra.sh --detect)" = compose \]; then$' scripts/setup.sh \
  || fail "setup.sh must choose OPENEDBOT_DEV_INFRA for a new env file only."
[ "$(grep -c 'created_env_file=1' scripts/setup.sh)" = 1 ] || fail "setup.sh must flag only the creation branch."

# 8. The compose file pins its images and keeps the names the scripts expect.
ci_image="$(sed -n 's/^ *image: \(postgres:[^ ]*\)$/\1/p' .github/workflows/core-ci.yml)"
grep -q "image: $ci_image\$" compose.dev.yml || fail "compose.dev.yml must use the PostgreSQL image of core-ci.yml ($ci_image)."
[ "$(grep -c '^    image: [^ ]*@sha256:[0-9a-f]\{64\}$' compose.dev.yml)" = 2 ] || fail "every compose.dev.yml image must be pinned by digest."
for name in openedbot-dev-postgres openedbot-dev-mailpit; do
  grep -q "container_name: $name\$" compose.dev.yml || fail "compose.dev.yml must name a container $name."
done

printf 'dev-infra contract: OK\n'
