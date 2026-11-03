<div align="center">

<img src="apps/console/public/brand/ohb-icon.webp" width="72" height="72" alt="">

# openedbot

**Persistent AI teammates on your own server, driven from one console.**

[Website](https://openedbot.app) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![core-ci](https://github.com/OpenedBot/openedbot/actions/workflows/core-ci.yml/badge.svg)](https://github.com/OpenedBot/openedbot/actions/workflows/core-ci.yml)
[![edge-setup CI](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml/badge.svg)](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml)
![Bun](https://img.shields.io/badge/runtime-Bun%201.4-black?logo=bun)

</div>

![A room in the openedbot desktop app: three bots work on a product launch together](assets/readme/console-room-dark.webp)

openedbot is a console, on the web and on the desktop, for AI agents that run on **your**
machine: a VPS or a homelab box. You message your bots like teammates. They remember what you
tell them, run routines on a schedule, work together in rooms, and ask for your approval before
a sensitive action.

The agent and its data stay on your host. The console never connects into it: the host opens
one outbound link to the cloud, and only an allowlist of gateway routes may cross it.

This repository is the open core: the API, the worker, the link gateway, the web console, the
desktop app, the host installer (`edge-setup`), the connector protocol and the documentation
source.

## How it fits

The host dials out; the cloud answers on that link and nothing else.

```
  YOUR HOST (VPS or homelab)                     OPENEDBOT CLOUD

  ┌──────────────────────────────┐               ┌──────────────────────────────┐
  │                              │               │                              │
  │  Hermes agent runtime        │               │  apps/link-gateway           │
  │    gateway on 127.0.0.1      │               │    ends the hosts' links     │
  │                              │   outbound    │                              │
  │  hermes-connector            │  ───────────> │  apps/api   apps/worker      │
  │    installed by edge-setup   │   one wss     │    accounts, bots, runs      │
  │    no inbound port           │               │                              │
  │                              │               │  apps/console                │
  └──────────────────────────────┘               │    web and desktop UI        │
                                                 │                              │
                                                 └──────────────────────────────┘
```

The wire contract (relay frames, the route allowlist, operator verbs) is specified in
[`protocol/SPEC.md`](protocol/SPEC.md). [`edge-setup`](edge-setup/README.md) is its host-side
reference implementation, with a pinned [Hermes](https://github.com/NousResearch/hermes-agent)
runtime.

## Repository layout

| Path | What it holds | Toolchain |
|---|---|---|
| `apps/api` | HTTP API (Hono) | Bun workspace |
| `apps/worker` | Claims queued runs and executes them on the bot's runtime; maintenance jobs | Bun workspace |
| `apps/link-gateway` | Ends the outbound links that hosts open | Bun workspace |
| `apps/console` | Web console (React, Vite) | Bun workspace |
| `apps/desktop` | Desktop app for macOS, Windows and Linux; on macOS it embeds the notch popup from [openedbot-notch](https://github.com/OpenedBot/openedbot-notch) | Electron, own toolchain |
| `modules/` | One package per business context: `identity`, `roster`, `conversation`, `execution`, `runtimes`, … | Bun workspaces |
| `platform/` | Server foundations: database, configuration, observability, Hermes client, integrations | Bun workspaces |
| `contracts/` | Pure contracts shared by servers and browser: API DTOs, events, errors, i18n (`zod` only) | Bun workspaces |
| `browser/` | Browser-only packages: API client, UI kit, i18n, bot faces | Bun workspaces |
| `db/` | SQL migrations and table ownership | |
| `edge-setup/` | Host installer and connector, Go module `github.com/OpenedBot/openedbot/edge-setup` (tags `edge-setup/vX.Y.Z`) | Go 1.26 |
| `protocol/` | Versioned connector protocol: specification, reference TypeScript codec, test vectors | Bun |
| `docs/` | Documentation site (Astro Starlight) | Bun |
| `scripts/`, `tests/` | Development tooling, cross-package tests and structure contracts | Bun |

Packages are named `@openedbot/*`. The boundaries between layers (a contract imports nothing, a
module never imports an app, the browser never imports a server package) are enforced by
`.dependency-cruiser.cjs` through `make deps-check`.

## Develop locally

**Requirements**

- [Bun](https://bun.sh) 1.4, the version pinned in `package.json`. Use `bun` only, never npm,
  yarn or pnpm.
- Docker, with a running PostgreSQL container from your own development infrastructure
  (`infra-postgres` by default, `OPENEDBOT_POSTGRES_CONTAINER` to name another). This repository
  never creates PostgreSQL itself.
- OpenSSL and curl.
- Go 1.26, only to work on `edge-setup/`.

**First run**

```bash
make setup          # .env.local, dependencies, PostgreSQL schema and a development account
make fake-hermes    # terminal 1: a fake Hermes gateway on 127.0.0.1:18642
make dev            # terminal 2: API, worker and console on http://localhost:1420
make desktop        # optional, terminal 3: the desktop app on the local console
```

Sign-in sends a one-time code by e-mail: in development it lands in the Mailpit of your
development infrastructure (`make mailpit-up` checks it; messages on http://localhost:8025).

To work against a real agent instead of the fake gateway, link a host that runs edge-setup:
`make link-dev-up HOST=user@host` starts the gateway, the tunnel and the enrollment, and
`make link-dev-down` stops them.

`make help` lists the daily commands and `make help-all` all of them (their descriptions are in
French).

## Checks

```bash
make typecheck        # every workspace, tests/ and scripts/
make test-unit        # no network, no PostgreSQL
make test-integration # disposable PostgreSQL: migrations, row-level security, imports
make check            # environment audit, typecheck, boundaries, tests, cloud builds
make contract-check   # wire fixtures, then the Go and TypeScript halves of the connector

(cd edge-setup && make check)    # Go: lint, tests, release checks
(cd protocol && bun run check)
(cd docs && bun install && bun test)
```

## Plug-ins

The core runs fully on its own. Optional plug-ins (staff back office, billing, agency features)
live outside this repository: the API and the worker load them at run time from the list in
`OPENEDBOT_PLUGINS`, and an empty or unset list runs solo.

For local work, clone or symlink a plug-in checkout to `./plugins` (ignored by git):

- `make test-dual` runs the unit tests solo, then with the plug-ins;
- `make solo-check` proves the console ships no plug-in screen when solo;
- `make dev-admin` starts the staff back office (`ADMIN_DIR`, `plugins/admin` by default) on
  port 1421.

The Makefile also includes the checkout's `make/*.mk` fragments when there are any.

## Configuration names

Environment variables are named `OPENEDBOT_*` and request headers `X-OpenedBot-*`. The retired
`OHB_*` variables are no longer read: the apps and the Makefile refuse to start and name the
successor. The former `X-OHB-*` request headers are still accepted for one release.

## Security

Please report a vulnerability privately through GitHub Security Advisories, never in a public
issue: see [`SECURITY.md`](SECURITY.md). The host side has its own notes in
[`edge-setup/SECURITY.md`](edge-setup/SECURITY.md) and
[`edge-setup/SECURITY-AUDIT.md`](edge-setup/SECURITY-AUDIT.md).

## License

[Apache License 2.0](LICENSE), Copyright 2026 Kévin Aubrée. `edge-setup/` and `protocol/` carry
the same license in their own `LICENSE` files.

Third-party code: [`browser/face/src/bloub`](browser/face/src/bloub/LICENSE) stays under the MIT
license (© 2026 Jérémy Perret).
