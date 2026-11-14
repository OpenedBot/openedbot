#!/usr/bin/env bash
# A headless desktop session for the Linux shell: an Xvfb
# display, a private D-Bus session bus, and optionally a Secret Service.
#
#   session.sh [--keyring | --no-secret-service] <command> [args…]
#
#   --keyring            GNOME Keyring on the bus, its login collection
#                        created and unlocked with a throwaway password (the
#                        Secret Service of a usual desktop)
#   --no-secret-service  a bus that cannot start any service: what a minimal
#                        window manager without keyring gives the app
#   (neither)            the system's session bus configuration
#
# Used by the Docker runs (scripts/linux-docker.ts) and the CI job. Xvfb and
# the bus stop with the command.
set -euo pipefail

mode=default
case "${1:-}" in
  --keyring) mode=keyring; shift ;;
  --no-secret-service) mode=bare; shift ;;
esac
[ $# -gt 0 ] || { echo "usage: session.sh [--keyring|--no-secret-service] <command>…" >&2; exit 2; }

xvfb_pid=
stop_xvfb() {
  if [ -n "$xvfb_pid" ]; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
}
if [ -z "${DISPLAY:-}" ]; then
  # Xvfb picks a free display and writes its number: two sessions in a row
  # (or side by side) never collide on a lock left behind.
  displayfd=$(mktemp)
  Xvfb -displayfd 3 -screen 0 "${OPENEDBOT_XVFB_SCREEN:-1280x800x24}" -nolisten tcp 3>"$displayfd" >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  trap stop_xvfb EXIT
  # A loaded runner can take well over 5 s to start Xvfb (an empty log then
  # meant "still starting"): wait up to 30 s, but stop at once if it died.
  wait_ticks=$(( ${OPENEDBOT_XVFB_WAIT_SECONDS:-30} * 10 ))
  for _ in $(seq 1 "$wait_ticks"); do
    [ -s "$displayfd" ] && break
    kill -0 "$xvfb_pid" 2>/dev/null || break
    sleep 0.1
  done
  number=$(tr -dc 0-9 <"$displayfd")
  rm -f "$displayfd"
  if [ -z "$number" ]; then
    if kill -0 "$xvfb_pid" 2>/dev/null; then
      echo "session.sh: Xvfb announced no display within ${OPENEDBOT_XVFB_WAIT_SECONDS:-30} s" >&2
    else
      echo "session.sh: Xvfb exited before announcing a display" >&2
    fi
    cat /tmp/xvfb.log >&2
    exit 1
  fi
  export DISPLAY=":$number"
  xdpyinfo >/dev/null 2>&1 || { echo "session.sh: Xvfb display $DISPLAY unreachable" >&2; exit 1; }
fi

case "$mode" in
  keyring)
    # The password only unlocks a keyring that lives as long as this session.
    dbus-run-session -- bash -c '
      set -euo pipefail
      eval "$(printf "openedbot-session\n" | gnome-keyring-daemon --unlock --components=secrets)"
      export GNOME_KEYRING_CONTROL SSH_AUTH_SOCK 2>/dev/null || true
      exec "$@"' session "$@"
    ;;
  bare)
    config=$(mktemp)
    trap 'rm -f "$config"; stop_xvfb' EXIT
    # No <servicedir>: nothing is activated on demand, org.freedesktop.secrets included.
    cat >"$config" <<'XML'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
XML
    dbus-run-session --config-file="$config" -- "$@"
    ;;
  default)
    dbus-run-session -- "$@"
    ;;
esac
