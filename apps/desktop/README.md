# openedbot Desktop

**The openedbot console in a native desktop window, for macOS and Windows.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)

## Overview

openedbot is the cloud console that drives AI agents installed on your own servers. This
repository is a thin Electron shell around it; it re-implements **nothing** of the product. It:

- loads the full openedbot web console (`OHB_CONSOLE_URL`);
- handles native sign-in, always with PKCE: Google through the system browser, or e-mail and
  password;
- exposes a minimal bridge to the page, `window.__OHB_NATIVE__`;
- on macOS, hosts the native notch popup (openedbot-notch).

The whole UI (bots, threads, settings) comes from the console. Only the sign-in page is local
(`src/renderer/signin.html`).

**Scope:** macOS (Apple Silicon) first, Windows x64 always built, sideloaded. Out of scope: Linux,
auto-update, code signing and notarisation (Gatekeeper / SmartScreen warn on first launch).

## Where it fits

| Repository | Role |
|---|---|
| [openedbot-main](https://github.com/OpenedBot/openedbot) | Console and API (open core, Apache-2.0) loaded by this shell |
| **openedbot-desktop** (this repo) | Electron shell, native sign-in, popup host |
| [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | Native notch popup embedded in the macOS build |
| [edge-setup](https://github.com/OpenedBot/openedbot) | Server-side installer and connector |

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
- For `make package-mac`: a Mac and the popup bundle built in `../notch`
  (`make -C ../notch bundle`)

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

| Command | What it does |
|---|---|
| `make dev` | Electron with reload (electron-vite) against production |
| `make dev-local` | Same, against the local console on :1420 |
| `make start` | Compile once and launch, no reload |
| `make compile` | Bundle main and preload into `dist/` |
| `make logs` | Latest events from the shell's SQLite diagnostics log |
| `make lab` | Design lab for the sign-in page (<http://localhost:5317>) |
| `make popup-check` | Check the popup bundle to embed |
| `make package-mac` | Unsigned dmg + zip, macOS arm64, into `release/` (on a Mac) |
| `make package-win` | Unsigned portable zip, Windows x64, into `release/` |
| `make package-win-installer` | Unsigned NSIS installer (Wine required from Linux) |
| `make clean` | Remove `dist/` and `release/` |

`make help` lists every target.

## Configuration

Precedence: environment variable, then `config.json`, then build-time defaults
(`make package-* CONSOLE_URL=…`), then the built-in default.

| Setting | Variable | `config.json` key | Default |
|---|---|---|---|
| Web console | `OHB_CONSOLE_URL` | `consoleUrl` | `https://console.openedbot.app` |
| API origin | `OHB_API_ORIGIN` | `apiOrigin` | `https://api.openedbot.app` |
| OAuth client id | `OHB_CLIENT_ID` | `clientId` | `ohb-desktop-windows` |
| Sign-in template | `OHB_SIGNIN_TEMPLATE` | `signinTemplate` | `console-split` |

Development-only variables: `OHB_TARGET` (`prod` or an API URL), `OHB_POPUP_APP` (path to a popup bundle),
`OHB_REMOTE_DEBUGGING_PORT`.

`config.json` lives in `%APPDATA%\openedbot\` (Windows) or
`~/Library/Application Support/openedbot/` (macOS). Plain `http://` is accepted only for
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
- Tokens are encrypted with the OS vault (DPAPI on Windows, Keychain on macOS) in `tokens.bin`.
  Without a vault the session stays in memory; nothing is written in clear.
- The access token is renewed 60 s before expiry; a refused refresh shows the sign-in page again.
- Browser callback: `ohb://auth/callback`, falling back to `http://127.0.0.1:47813/callback`.

## Notch popup (macOS)

`make package-mac` embeds the built popup as `openedbot.app/Contents/Helpers/OHBPopup.app` and
runs it with `--hosted`. The shell stays the only session holder: the hosted popup asks it for
tokens over stdin/stdout (one JSON line per message, protocol in
[`src/shared/popup-protocol.ts`](src/shared/popup-protocol.ts)). If the popup crashes it is
restarted with backoff; after 5 failures in a row the shell falls back to *Window* mode.

## Testing

```sh
make typecheck   # tsc --noEmit
make test        # bun test: popup protocol, theme IPC, target, diagnostics
```

## Project structure

```text
src/main/       main process: lifecycle, config, auth, token store, window, tray, popup host
src/preload/    window.__OHB_NATIVE__ bridge
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

Names such as `OHB_*`, `ohb://`, `window.__OHB_NATIVE__` and `OHBPopup.app` are technical
identifiers kept for compatibility.

## License

Copyright 2026 Kévin Aubrée. Licensed under the [Apache License, Version 2.0](LICENSE), like the
openedbot core. The bundled fonts (Inter, JetBrains Mono, Source Serif 4) stay under the SIL
Open Font License 1.1: see [`NOTICE`](NOTICE) and
[`src/renderer/assets/fonts/OFL.txt`](src/renderer/assets/fonts/OFL.txt).
