<div align="center">

# openedbot

**The cloud console for AI agents running on your own servers.**

[Website](https://openedbot.app) · [Documentation](https://docs.openedbot.app)

![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Bun](https://img.shields.io/badge/runtime-Bun%201.4-black?logo=bun)
[![edge-setup CI](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml/badge.svg)](https://github.com/OpenedBot/openedbot/actions/workflows/edge-setup-ci.yml)

</div>

openedbot is a cloud console (web and desktop) to chat with, approve and audit AI agents
that run on **your** infrastructure. The agent never leaves your server: `edge-setup` keeps its
gateway on `127.0.0.1` and opens a single outbound WebSocket to the openedbot link gateway.

This monorepo holds the open core and its clients. Optional plug-ins (staff back office,
billing, agency features) and deployment code are not part of it: the core loads plug-ins from
an external directory at run time (`OPENEDBOT_PLUGINS`) and runs fully without them.

## Layout

```text
apps/api, apps/worker,        open core: API, worker, link gateway, web console
apps/link-gateway, apps/console   (Bun workspaces, with modules/, platform/, contracts/,
                                   browser/, db/, scripts/, tests/)
edge-setup/     Go installer and connector run on the customer's server (module
                github.com/OpenedBot/openedbot/edge-setup, tags edge-setup/vX.Y.Z)
protocol/       versioned connector protocol specification and reference connector
docs/           documentation site (Astro Starlight), docs.openedbot.app
apps/desktop/   desktop client (Electron)
apps/notch/     macOS notch UI prototype (Swift)
```

`edge-setup/`, `protocol/`, `docs/` and `apps/{desktop,notch}` were imported with their
full history (`git subtree`) from their former repositories. They keep their own toolchains
(Go, Swift, Electron, Astro) and are not Bun workspaces of the core.

## Build and test

```bash
make setup          # .env.local, dependencies, migrations, seed data
make dev            # API + worker + console (http://localhost:1420)
make check          # env audit, typecheck, boundaries, tests, cloud builds
make test-dual      # unit tests solo, then with the external plug-ins in ./plugins
make contract-check # link contract, Go (edge-setup/) and TypeScript halves

(cd edge-setup && make check)       # Go: lint, tests, release checks
(cd protocol && bun run check)
(cd docs && bun install && bun test)
```

`make help` lists the daily commands, `make help-all` all of them. The `make` targets that use
external plug-ins (`test-dual`, `solo-check`, `dev-admin`) find them in `./plugins`, a
directory ignored by git: clone or symlink the plug-in checkout there
(`ln -s <plugins checkout> plugins`). Without it the core runs solo. `ADMIN_DIR` defaults to
`plugins/admin`, and the checkout's `make/*.mk` fragments, if any, are included by the
Makefile.

> The packages are named `@openedbot/*` and the variables `OPENEDBOT_*` (the legacy `OHB_*`
> names are still read for one release, with a warning); `X-OHB-*` headers are technical
> names kept for compatibility.

## License

Apache License 2.0, Copyright 2026 Kévin Aubrée. See [`LICENSE`](LICENSE).

Third-party code: [`browser/face/src/bloub`](browser/face/src/bloub/LICENSE) stays under MIT (© 2026 Jérémy Perret).
