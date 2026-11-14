#!/usr/bin/env bash
# The Ubuntu packages the Linux shell needs, shared by the
# build image (Dockerfile next to this file) and the CI job (core-ci.yml), so
# both build against the same libraries.
#
#   install-deps.sh build   WebKitGTK 4.1, libsoup 3, appindicator, D-Bus
#                           (Secret Service through keyring), bundling tools
#   install-deps.sh test    + Xvfb, a D-Bus session, gnome-keyring, the
#                           WebKitGTK WebDriver, screenshots, fonts
#
# Runs as root (the image) or through sudo (the CI runner).
set -euo pipefail

want_test=false
for group in "$@"; do
  case "$group" in
    build) ;;
    test) want_test=true ;;
    *) echo "install-deps.sh: unknown group $group (build|test)" >&2; exit 2 ;;
  esac
done

packages=(
  # Toolchain and the Tauri 2 prerequisites (https://v2.tauri.app/start/prerequisites/#linux).
  build-essential pkg-config curl wget file unzip ca-certificates git xz-utils
  libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev libayatana-appindicator3-dev
  librsvg2-dev libssl-dev libxdo-dev
  # keyring's Secret Service backend links libdbus.
  libdbus-1-dev
  # The deep-link plugin registers the AppImage's scheme with xdg-mime.
  xdg-utils desktop-file-utils
)
if $want_test; then
  packages+=(
    xvfb xauth dbus dbus-x11 gnome-keyring libsecret-tools
    webkit2gtk-driver imagemagick x11-utils xdotool procps jq
    # An XEmbed tray, so the tray icon has somewhere to show under Xvfb.
    stalonetray
    fonts-dejavu-core fonts-noto-core fonts-noto-color-emoji
  )
fi

sudo_if_needed=()
if [ "$(id -u)" -ne 0 ]; then sudo_if_needed=(sudo); fi
export DEBIAN_FRONTEND=noninteractive
"${sudo_if_needed[@]}" apt-get update -qq
"${sudo_if_needed[@]}" apt-get install -y -qq --no-install-recommends "${packages[@]}"
