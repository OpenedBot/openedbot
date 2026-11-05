#!/usr/bin/env bash
set -euo pipefail

# Mailpit is the SMTP of DEVELOPMENT, and nothing else: it accepts every
# message and delivers none. The worker points at it through
# TRANSACTIONAL_EMAIL_SMTP_URL (smtp://127.0.0.1:1025) and the messages are
# read in its web interface on http://127.0.0.1:8025.
#
# Same rule as PostgreSQL (scripts/db.sh): the container lives in the shared
# dev-infra compose project (OPENEDBOT_MAILPIT_CONTAINER, default infra-mailpit).
# This script starts it when it is stopped and waits for it; it never creates
# one, and it never touches a production mail transport. On the hosted tiers
# the transport is Brevo, never this.

container="${OPENEDBOT_MAILPIT_CONTAINER:-infra-mailpit}"
ui_url="${E2E_MAILPIT_URL:-http://127.0.0.1:8025}"

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is required to reach the Mailpit container %s.\n' "$container" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf 'Docker does not answer. Start the Docker daemon, then rerun this target.\n' >&2
  exit 1
fi

if ! docker inspect "$container" >/dev/null 2>&1; then
  printf 'Mailpit container %s does not exist. Start your shared dev-infra stack (the compose project that owns %s) first; this repository never creates it.\n' "$container" "$container" >&2
  exit 1
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != "true" ]; then
  printf 'Starting existing Mailpit container %s...\n' "$container"
  docker start "$container" >/dev/null
else
  printf 'Reusing existing Mailpit container %s.\n' "$container"
fi

printf 'Waiting for Mailpit in %s...\n' "$container"
for _ in $(seq 1 30); do
  if curl -fsS "$ui_url/api/v1/messages" >/dev/null 2>&1; then
    printf 'Mailpit is ready: SMTP smtp://127.0.0.1:1025, messages on %s\n' "$ui_url"
    exit 0
  fi
  sleep 1
done

printf 'Mailpit did not answer on %s within 30 seconds.\n' "$ui_url" >&2
docker logs --tail 20 "$container" >&2
exit 1
