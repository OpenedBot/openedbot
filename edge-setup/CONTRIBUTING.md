# Contributing to edge-setup

Thanks for your interest! edge-setup runs as root on other people's servers,
so we favour small, well-tested, well-explained changes.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on
  the approach.
- Security issues: follow [SECURITY.md](SECURITY.md), never a public issue.
- Be kind: this project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

You need Go (version in `go.mod`) and `make`. Tests are offline and run on
macOS or Linux; nothing touches the host you develop on.

```bash
make check     # gofmt, go vet and the offline unit tests (golden files included)
make build     # dist/edge-setup for this machine
```

Some targets need the rest of the OpenedBot/openedbot monorepo:
`make contract-check` (root, `..`) and `make check-docs`
(`../docs`). They fail rather than skip when one is missing.

## Rules of the codebase

- **Never accept a secret in argv.** Tickets, tokens and keys come from stdin,
  a hidden prompt or a `0600` file, and are never printed or logged.
- **Every mutation requires `--yes`**; access-changing options also require
  `--console-confirmed` and a rollback path.
- **Optional hardening stays optional.** Minimal `up` must not change SSH,
  UFW, PAM, journald or the update policy.
- **Pins are pins.** Anything downloaded is pinned by commit or checksum in
  `internal/pins`.
- **The wire contract is shared.** A change to relay frames, the gateway
  allowlist or operator verbs must update `docs/CONNECTOR.md`, the golden
  vectors in `test/golden/relay-frames`, and the
  [protocol](../protocol/SPEC.md) SPEC.
- Rendered files are frozen under `test/golden/render/`: update the golden
  file in the same commit as the renderer.
- No real people or company names in code, tests or examples (`Acme`,
  `example.com`, `203.0.113.0/24`). Avoid the em dash character in code,
  docs and commit messages.

## Commits and pull requests

- One logical change per commit, with a message that explains *why*
  (Conventional Commits style is welcome: `fix(link): ...`).
- `make check` must pass. Add or update tests for every behaviour change.
- Update `README.md`, `docs/` and `CHANGELOG.md` when flags or behaviour
  change.
- Sign every commit with `git commit -s`: the `Signed-off-by:` line certifies
  the [Developer Certificate of Origin 1.1](https://developercertificate.org/)
  and must match the commit author. To fix a missing sign-off, run
  `git commit --amend -s --no-edit` (last commit) or
  `git rebase --signoff <base>` (whole branch).
- By contributing you agree that your contribution is licensed under the
  [Apache License 2.0](LICENSE).
