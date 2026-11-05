#!/bin/sh
# Notarises a dmg signed with the Developer ID (make package-mac
# MAC_SIGN=developer-id), then staples the ticket so Gatekeeper accepts it
# offline. electron-builder has already notarised and stapled the app inside;
# this covers the container a user actually downloads.
#
# Reads APPLE_API_KEY (path of the App Store Connect .p8), APPLE_API_KEY_ID and
# APPLE_API_ISSUER, the same variables electron-builder uses.
set -eu

dmg="${1:?usage: notarize-dmg.sh <file.dmg>}"
: "${APPLE_API_KEY:?APPLE_API_KEY: path of the App Store Connect .p8}"
: "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is not set}"
: "${APPLE_API_ISSUER:?APPLE_API_ISSUER is not set}"
[ -f "$APPLE_API_KEY" ] || { echo "APPLE_API_KEY is not a file: $APPLE_API_KEY" >&2; exit 1; }

# Apple notarises an unsigned dmg, but cannot staple a ticket to it.
codesign --verify --strict --verbose=2 "$dmg"

auth() { "$@" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"; }

# --wait returns once Apple has decided, whatever the verdict: read it.
result="$(auth xcrun notarytool submit "$dmg" --wait --timeout 30m --output-format json)"
id="$(printf '%s' "$result" | plutil -extract id raw -o - -)"
status="$(printf '%s' "$result" | plutil -extract status raw -o - -)"
echo "notarisation $id: $status"
if [ "$status" != "Accepted" ]; then
  # The log names every file Apple rejected and why.
  auth xcrun notarytool log "$id" >&2 || true
  exit 1
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
