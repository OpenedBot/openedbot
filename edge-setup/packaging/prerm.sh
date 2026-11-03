#!/bin/sh
# Refuse to remove the package while a hardening transaction is armed.
if [ -e /var/lib/hermes-host-hardening/active ]; then
  echo "edge-setup: a hardening transaction is active; wait for verify-access or the rollback" >&2
  exit 1
fi
exit 0
