# openedbot Desktop

**The openedbot console in a native desktop window, for macOS, Windows and Linux.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)

## Overview

openedbot is the cloud console that drives AI agents installed on your own servers. This
app is a thin Electron shell around it; it re-implements **nothing** of the product. It:

- loads the full openedbot web console (`OPENEDBOT_CONSOLE_URL`);
- handles native sign-in, always with PKCE: a one-time e-mail code, or Google through the system
  browser;
- exposes a minimal bridge to the page, `window.__OPENEDBOT_NATIVE__`;
- on macOS, hosts the native notch popup (openedbot-notch).

The whole UI (bots, threads, settings) comes from the console, sign-in included: signed out, the
window shows the console's `/login`, which signs in through `__OPENEDBOT_NATIVE__.auth`. The local page
(`src/renderer/signin.html`) is only a fallback for a console that predates that screen.

**Scope:** macOS (Apple Silicon) first, Windows x64 and Linux x64 also built, sideloaded. Out of
scope: auto-update. Released macOS builds are signed with a Developer ID and notarised by Apple
([macOS signing](#macos-signing)); Windows and Linux builds are unsigned (SmartScreen warns on
first launch).

## Download and install

Releases are GitHub releases of this repository, built by
[`.github/workflows/desktop-release.yml`](../../.github/workflows/desktop-release.yml) from a
`desktop/vX.Y.Z` tag. Each one carries `SHA256SUMS`. The latest build is always at
`https://github.com/OpenedBot/openedbot/releases/latest/download/<file>`:

| System | File | Install |
|---|---|---|
| macOS, Apple Silicon | `openedbot-mac-arm64.dmg` | Drag *openedbot* to *Applications* and open it: signed and notarised, it opens without a warning |
| Debian, Ubuntu (x64) | `openedbot-linux-amd64.deb` | `sudo apt install ./openedbot-linux-amd64.deb`, then *openedbot* in the applications menu |
| Other Linux (x64) | `openedbot-linux-x86_64.AppImage` | `chmod +x openedbot-linux-x86_64.AppImage` and run it (needs FUSE 2: `libfuse2`) |

On Linux, the session is kept across launches only with a system vault (GNOME Keyring /
libsecret or KWallet); without one, the app signs in again at each launch. Ubuntu 24.04 and
later restrict the sandbox of AppImages: prefer the `.deb` there.

## Where it fits

| Part | Role |
|---|---|
| [`apps/console`, `apps/api`](../../README.md) | Console and API (open core, Apache-2.0) loaded by this shell |
| **`apps/desktop`** (this app) | Electron shell, native sign-in, popup host |
| [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | Native notch popup embedded in the macOS build (its own repository) |
| [`edge-setup/`](../../edge-setup/README.md) | Server-side installer and connector |

## Features

- Desktop window (1280×820 on first launch), position and size remembered
- No system title bar: the console's top bar drags the window (traffic lights on macOS, window
  controls on Windows)
- "Always on top", remembered across launches
- Global shortcut `Cmd+Shift+O` (macOS) / `Ctrl+Shift+O` (Windows) to show or hide the window
- macOS Dock menu / Windows tray icon: always on top, display mode, sign out, quit
- Closing hides the window; only *Quit* stops the app. Single instance.
- On sign-out or session loss, console storage for that origin is cleared (language, theme and
  sidebar state are kept)
- macOS: hosted notch popup, with *Window*, *Popup* or *Window and popup* display modes

## Requirements

- [Bun](https://bun.sh) for dependencies and scripts (no npm / yarn / pnpm)
- No Node install needed to run the app: Electron ships its own
- An openedbot console to target (see [Configuration](#configuration))
- For `make package-mac`: a Mac and the popup bundle built in an
  [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) checkout, next to the
  openedbot checkout by default (`make -C ../openedbot-notch bundle` from the monorepo root;
  `NOTCH_DIR=/path/to/openedbot-notch` otherwise)

## Quick start

```sh
make install     # bun install
make dev         # Electron with reload, against production (console.openedbot.app)
```

Develop against a local console from `../..`:

```sh
cd ../.. && make dev   # API :8790, console :1420
cd ../desktop && make dev-local
```

From the repository root, `make desktop` does the same in one step (it installs the
dependencies and the Electron binary first when needed), and `make stop` also stops it.

| Command | What it does |
|---|---|
| `make dev` | Electron with reload (electron-vite) against production |
| `make dev-local` | Same, against the local console on :1420 |
| `make start` | Compile once and launch, no reload |
| `make compile` | Bundle main and preload into `dist/` |
| `make logs` | Latest events from the shell's SQLite diagnostics log |
| `make lab` | Design lab for the sign-in page (<http://localhost:5317>) |
| `make popup-check` | Check the popup bundle to embed |
| `make package-mac` | Dmg + zip, macOS arm64, into `release/` (on a Mac): signed ad hoc, or `MAC_SIGN=developer-id` signed and notarised ([macOS signing](#macos-signing)) |
| `make check-mac` | Checks that build against `MAC_SIGN`: seal, popup, version, dmg; Gatekeeper and stapled tickets for `developer-id` |
| `make package-linux` | Unsigned AppImage + deb, Linux x64, into `release/` |
| `make package-win` | Unsigned portable zip, Windows x64, into `release/` |
| `make package-win-installer` | Unsigned NSIS installer (Wine required from Linux) |
| `make clean` | Remove `dist/` and `release/` |

`make help` lists every target.

## Configuration

Precedence: environment variable, then `config.json`, then build-time defaults
(`make package-* CONSOLE_URL=…`), then the built-in default.

| Setting | Variable | `config.json` key | Default |
|---|---|---|---|
| Web console | `OPENEDBOT_CONSOLE_URL` | `consoleUrl` | `https://console.openedbot.app` |
| API origin | `OPENEDBOT_API_ORIGIN` | `apiOrigin` | `https://api.openedbot.app` |
| OAuth client id | — (no override) | `clientId` | `openedbot-desktop-windows` |
| Sign-in template | `OPENEDBOT_SIGNIN_TEMPLATE` | `signinTemplate` | `console-split` |

Development-only variables: `OPENEDBOT_TARGET` (`prod` or an API URL), `OPENEDBOT_POPUP_APP` (path to a popup bundle),
`OPENEDBOT_REMOTE_DEBUGGING_PORT`.

`config.json` lives in `%APPDATA%\openedbot\` (Windows),
`~/Library/Application Support/openedbot/` (macOS) or `~/.config/openedbot/` (Linux). Plain `http://` is accepted only for
`localhost`, loopback, private networks and `.local` / `.lan` / `.test` hosts; everything else
must be `https://`. The API must list the redirect URI in its native redirect URIs.

The production console moved from `https://openedbot.app` to `https://console.openedbot.app`
on 2026-10-29 (the apex now serves the public site). For production, the shell trusts both
origins as its console, whichever one is configured: the apex keeps serving the console to the
desktop shell, then redirects its app paths to `console.`, for a transition window, and an
older `config.json` or build that names the apex keeps working (`src/main/target.ts`,
`trustedConsoleOrigins`).

## Sign-in and session

- Google opens the system browser (PKCE S256) while the shell polls the API every 1.5 s (5 min
  max). E-mail and password go through `POST /api/auth/native/authorize`; in production only
  Google is offered.
- Tokens are encrypted with the OS vault (DPAPI on Windows, Keychain on macOS, libsecret or
  KWallet on Linux) in `tokens.bin`. Without a vault the session stays in memory; nothing is
  written in clear. Linux's `basic_text` fallback (a key built into Chromium) counts as no vault
  (`src/main/vault.ts`).
- The access token is renewed 60 s before expiry; a refused refresh shows the sign-in page again.
- Browser callback: `openedbot://auth/callback`, falling back to `http://127.0.0.1:47813/callback`.

## Notch popup (macOS)

`make package-mac` embeds the built popup as `openedbot.app/Contents/Helpers/OpenedbotPopup.app` and
runs it with `--hosted`. The shell stays the only session holder: the hosted popup asks it for
tokens over stdin/stdout (one JSON line per message, protocol in
[`src/shared/popup-protocol.ts`](src/shared/popup-protocol.ts)). If the popup crashes it is
restarted with backoff; after 5 failures in a row the shell falls back to *Window* mode.

## macOS signing

`make package-mac` has two modes, `MAC_SIGN=adhoc` (the default) and `MAC_SIGN=developer-id`:

| | `adhoc` | `developer-id` |
|---|---|---|
| Config | `electron-builder.yml` | `electron-builder.developer-id.yml` on top of it |
| Signature | ad hoc, no hardened runtime | *Developer ID Application: kevin aubrée (QDC76LMF29)*, hardened runtime, secure timestamp, on the app and every nested binary (notch popup included) |
| Notarisation | none | the app, then the signed dmg (`scripts/notarize-dmg.sh`), tickets stapled |
| Downloaded copy | refused, then *System Settings › Privacy & Security › Open Anyway* | opens without a warning |
| Used by | pull requests, forks, a Mac without the certificate | releases (`desktop/vX.Y.Z` tags), manual runs of the workflow |

Entitlements (`build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`): JIT and
writable executable memory for V8, nothing else.

`developer-id` needs the certificate and an App Store Connect API key with the *Developer* role:

- On a Mac: the *Developer ID Application* identity in the login keychain, and
  `APPLE_API_KEY` (path of the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` in the
  environment. The Makefile refuses to start without them: electron-builder would otherwise
  skip notarisation with a mere warning.
- In the CI (`.github/workflows/desktop-release.yml`), repository secrets: `MACOS_CSC_LINK`
  (the `.p12`, base64), `MACOS_CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8` (the `.p8` content),
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. A tag without them fails instead of publishing a
  build Gatekeeper refuses.

```sh
APPLE_API_KEY=~/path/AuthKey_XXXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=... \
  make package-mac MAC_SIGN=developer-id && make check-mac MAC_SIGN=developer-id
```

The certificate expires on 2027-12-04: create a new one (developer.apple.com, *Certificates*,
*Developer ID Application*, account holder only) and replace the two `MACOS_CSC_*` secrets
before then. Apps signed and notarised earlier keep opening after it expires.

## Testing

```sh
make typecheck   # tsc --noEmit
make test        # bun test: popup protocol, theme IPC, target, diagnostics
```

## Project structure

```text
src/main/       main process: lifecycle, config, auth, token store, window, tray, popup host
src/preload/    window.__OPENEDBOT_NATIVE__ bridge
src/renderer/   local sign-in page, templates, assets
src/shared/     pure contracts: bridge, host <-> popup protocol
test/           bun tests
design-lab/     sign-in page design lab (not shipped)
build/          packaging resources
scripts/        dev and packaging scripts
docs/           developer notes (Windows workstation)
```

## Security

- `contextIsolation` on, `nodeIntegration` off, `sandbox` on, no `remote`, no `webview`
- The window only navigates to the console origin; other links open in the system browser
- The refresh token never leaves the main process; no token, code, verifier or callback URL is
  logged

## Documentation

- Product documentation: <https://docs.openedbot.app>
- [`docs/WINDOWS_DEV.md`](docs/WINDOWS_DEV.md): developing from a Windows workstation

Variables are named `OPENEDBOT_*`.

## License

Copyright 2026 Kévin Aubrée. Licensed under the [Apache License, Version 2.0](LICENSE), like the
openedbot core. The bundled fonts (Inter, JetBrains Mono, Source Serif 4) stay under the SIL
Open Font License 1.1: see [`NOTICE`](NOTICE) and
[`src/renderer/assets/fonts/OFL.txt`](src/renderer/assets/fonts/OFL.txt).
