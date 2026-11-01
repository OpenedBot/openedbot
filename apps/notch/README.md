# openedbot notch

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Swift](https://img.shields.io/badge/Swift-6.0-F05138?logo=swift&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-15%2B-000000?logo=apple)
![Status](https://img.shields.io/badge/status-prototype-orange)

A prototype macOS notch UI for [openedbot](https://openedbot.app): your bots live in a small
black notch attached to an edge of the screen. One ring per bot shows who is working and how far
along the run is, who is waiting for your approval, and which runtime went down. Hover for details,
click to open the agent window: read the thread, approve or deny, reply. No need to open the console.

> **Status: prototype.** Out of the box it runs on **mock data**: ten demo bots in three sections,
> two scripted runs that loop, and a runtime that drops. It is not a supported openedbot product.

| Sections, one tray per pile | Bot card (hover) | Agent window (click) |
|---|---|---|
| ![](docs/sections-tray.png) | ![](docs/card.png) | ![](docs/dialog.png) |

## Where it fits

| Component | Role |
|---|---|
| **openedbot-notch** (this repo) | Prototype macOS notch UI, runs standalone on mock data |
| openedbot desktop app | Embeds this bundle on macOS and runs it in hosted mode |
| openedbot console | The web console the notch can optionally sign in to |
| edge-setup | Host-side installer and connector for the agents openedbot drives |

## Features

- **One ring per bot**: avatar in the centre, run progress as an arc coloured by state
  (running, awaiting approval, completed, runtime offline), amber badge when an approval waits.
- **Hover card**: bot, runtime, model, permission mode, routines, current runs, pending approval
  with *Deny* / *Allow once*.
- **Agent window**: thread (messages, tool calls), inline approval, composer. One window per agent.
- **Many bots**: bots waiting for approval are promoted; sections collapse into piles that expand
  into a tray on hover; an "active only" mode.
- **Announcements**: the notch opens briefly and plays a sound when a run finishes, a bot waits,
  or a runtime drops.
- **Menu bar item**, four screen edges, settings window, English and French UI.

An interactive HTML mockup of the design lives in [`design/index.html`](design/index.html)
(open it in a browser, no build needed).

## Requirements

- macOS 15 or later
- Swift 6 toolchain (Xcode 16+; developed with Xcode 27 / Swift 6.4)
- No third-party dependencies

## Quick start

```sh
make dev     # swift run OHBPopup (fastest loop, no .app bundle)
make test    # swift test
make run     # release build, bundle dist/OHBPopup.app, open it
```

`make build` / `make bundle` sign the binary with a local self-signed identity created by
`scripts/dev-sign.sh` (stored in a dedicated keychain under `~/Library/Keychains`), so the
Keychain does not prompt again after every rebuild. The first run asks macOS to trust that
certificate for code signing. The app has no Dock icon (`LSUIElement`): use the notch and the
menu bar item.

| Command | What it does |
|---|---|
| `make dev` | `swift run OHBPopup`, no `.app` bundle |
| `make build` | Release build, signed with the local dev identity |
| `make bundle` | Build `dist/OHBPopup.app` |
| `make run` | Bundle and open the app |
| `make test` | `swift test` |
| `make clean` | Remove build artefacts |

## Connecting to openedbot (experimental)

Without an account the notch shows the demo bots. *Settings › Account* can sign in to an
openedbot server (default origin `https://openedbot.app`, HTTPS only except local/lab hosts)
with the native PKCE flow; the session is kept in the macOS Keychain, never in `UserDefaults`.
This path is experimental and not guaranteed to work against current servers.

The executable and module are still named `OHBPopup` internally (bundle id
`app.openedbot.popup`), because the openedbot desktop app embeds the bundle under that name and
launches it with `--hosted`.

## Configuration

No environment variables are needed to run it. In the app, *Settings* has pages for General, Account, Models, Journal,
Notch, Menu bar, Announcements and Demo. For tests, `OPENEDBOT_SNAPSHOT_DIR` enables the
PNG snapshots (see [Testing](#testing)).

## Testing

```sh
make test                                                  # swift test
OPENEDBOT_SNAPSHOT_DIR=/tmp/notch-ui swift test --filter Snapshot  # render views to PNG, no windows
```

## Project structure

```text
Sources/OHBPopup
├── App/     entry point, app delegate, menu bar, settings pages
├── Auth/    native sign-in client, Keychain session, token sources
├── Design/  metrics, palette, typography, Markdown rendering
├── Feed/    REST + SSE client, DTOs, mapping to notch models
├── Host/    hosted-mode stdio protocol
├── Model/   domain models, geometry, layout rules, mock feed
└── Notch/   notch panel, rings, cards, agent window
Tests/OHBPopupTests   unit tests (geometry, layout rules, mock feed, auth, host protocol)
Resources/            Info.plist, bot artworks, faces, provider marks
design/               static HTML mockup
```

## Documentation

- Website: <https://openedbot.app>
- Documentation: <https://docs.openedbot.app>

## Contributing

This is a prototype published for reference. Issues and pull requests are welcome; please keep
changes small and run `make test` before opening one.

## License

Licensed under the [Apache License 2.0](LICENSE). Copyright 2026 Kévin Aubrée.

Provider logos in `Resources/brand-marks.json` come from [Simple Icons](https://simpleicons.org)
(CC0-1.0); the brands themselves belong to their owners.
