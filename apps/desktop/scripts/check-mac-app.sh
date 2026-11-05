#!/bin/sh
# Checks a macOS build of make package-mac before it ships: the seal, the
# embedded notch popup, the version, the dmg, and the signature the mode
# promises. adhoc: an ad hoc signature (Gatekeeper refuses it until Open
# Anyway). developer-id: Developer ID of the team, hardened runtime and secure
# timestamp on the app and on the popup, both notarised, tickets stapled on the
# app and on the dmg, so a downloaded copy opens without a warning.
set -eu

mode="${1:?usage: check-mac-app.sh adhoc|developer-id <version>}"
version="${2:?usage: check-mac-app.sh adhoc|developer-id <version>}"
team=QDC76LMF29
app=release/mac-arm64/openedbot.app
popup="$app/Contents/Helpers/OpenedbotPopup.app"
dmg="release/openedbot-$version-mac-arm64.dmg"

fail() { echo "check-mac-app: $*" >&2; exit 1; }
# codesign -d writes its report on stderr.
info() { codesign -dv --verbose=2 "$1" 2>&1; }

codesign --verify --deep --strict --verbose=2 "$app"
[ -x "$popup/Contents/MacOS/OpenedbotPopup" ] || fail "popup missing: $popup"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")" = "$version" ] ||
  fail "$app is not version $version"
hdiutil verify "$dmg"

case "$mode" in
  adhoc)
    info "$app" | grep -q '^Signature=adhoc$' || fail "$app is not signed ad hoc"
    ;;
  developer-id)
    for code in "$app" "$popup"; do
      report="$(info "$code")"
      printf '%s\n' "$report" | grep -q '^Authority=Developer ID Application: ' || fail "$code is not signed with a Developer ID"
      printf '%s\n' "$report" | grep -q "^TeamIdentifier=$team\$" || fail "$code is not signed by team $team"
      printf '%s\n' "$report" | grep -Eq '^CodeDirectory .*flags=.*runtime' || fail "$code lacks the hardened runtime"
      printf '%s\n' "$report" | grep -q '^Timestamp=' || fail "$code has no secure timestamp"
    done
    # spctl answers for Gatekeeper: "accepted", source=Notarized Developer ID.
    spctl -a -vvv -t exec "$app" 2>&1 | tee /dev/stderr | grep -q 'source=Notarized Developer ID' || fail "Gatekeeper rejects $app"
    xcrun stapler validate "$app"
    spctl -a -vvv -t open --context context:primary-signature "$dmg" 2>&1 | tee /dev/stderr | grep -q 'source=Notarized Developer ID' ||
      fail "Gatekeeper rejects $dmg"
    xcrun stapler validate "$dmg"
    ;;
  *) fail "unknown mode: $mode (adhoc or developer-id)" ;;
esac
echo "check-mac-app: $mode build $version OK"
