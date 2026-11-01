#!/usr/bin/env bash
# Signe un binaire avec une identité locale et STABLE.
#
# Pourquoi : un binaire signé ad hoc change de signature à chaque compilation, donc macOS
# le prend pour une autre app et redemande le mot de passe du trousseau pour lire la session.
# Signé par la même identité, il garde la même exigence de signature : « Toujours autoriser »
# tient d'un build à l'autre.
#
# L'identité est auto-signée, rangée dans un trousseau dédié (pas dans « session ») dont le
# mot de passe aléatoire est gardé en 0600 sous ~/.config/ohb-notch. Elle ne signe que cette app.
set -euo pipefail

target="${1:?usage: dev-sign.sh <binaire ou .app>}"
name="OHB Notch Dev"
dir="$HOME/.config/ohb-notch"
keychain="$HOME/Library/Keychains/ohb-notch-dev.keychain-db"
passfile="$dir/dev-keychain-pass"

mkdir -p "$dir"
chmod 700 "$dir"

if [[ ! -f "$keychain" ]]; then
  umask 077
  openssl rand -hex 24 > "$passfile"
  pass="$(cat "$passfile")"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$name" \
    -keyout "$work/key.pem" -out "$work/cert.pem" \
    -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" \
    -addext "basicConstraints=critical,CA:false" 2>/dev/null
  openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -name "$name" \
    -out "$work/id.p12" -passout "pass:$pass"
  security create-keychain -p "$pass" "$keychain"
  security set-keychain-settings "$keychain"          # sans verrouillage automatique
  security import "$work/id.p12" -k "$keychain" -P "$pass" -T /usr/bin/codesign >/dev/null
  # codesign lit la clé sans boîte de dialogue.
  security set-key-partition-list -S apple-tool:,apple: -s -k "$pass" "$keychain" >/dev/null
  # Une seule fois par machine : macOS tue un binaire signé par un certificat non approuvé,
  # et approuver un certificat demande le mot de passe de session.
  openssl x509 -in "$work/cert.pem" -out "$dir/dev-cert.pem"
  security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$dir/dev-cert.pem"
fi

# codesign ne trouve une identité que dans un trousseau de la liste de recherche.
if ! security list-keychains -d user | grep -q "ohb-notch-dev.keychain-db"; then
  # shellcheck disable=SC2046
  security list-keychains -d user -s $(security list-keychains -d user | tr -d '"') "$keychain"
fi
security unlock-keychain -p "$(cat "$passfile")" "$keychain"
codesign --force --sign "$name" --keychain "$keychain" --identifier OHBPopup "$target"
