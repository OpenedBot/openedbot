# Contributing to openedbot

Thanks for your interest. Pull requests are welcome everywhere in this
repository: the core (`apps/`, `modules/`, `platform/`, `contracts/`,
`browser/`), `edge-setup/`, `protocol/` and `docs/`. For anything larger than
a small fix, open an issue first so we can agree on the approach.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by:` line, which certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you
wrote the change or have the right to submit it. Add it with `-s`:

```bash
git commit -s -m "fix(scope): what changed"
```

The name and email in `Signed-off-by:` must match the commit author. A CI
check (`.github/workflows/dco.yml`) fails the pull request otherwise. To fix
it:

```bash
git commit --amend -s --no-edit              # the last commit only
git rebase --signoff origin/develop          # every commit of your branch
git push --force-with-lease                  # your own branch only
```

Maintainers: commits up to the SHA in `.github/dco-baseline` predate the DCO
and are not checked; do not move it forward.

## Licensing of contributions

- **Inbound: Apache-2.0.** By contributing, you license your contribution to
  the project under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
- **Outbound: AGPL-3.0-only.** The core is distributed under the
  [GNU AGPL v3.0 only](LICENSE). `edge-setup/` and `protocol/` stay under
  Apache-2.0.
- **Why.** The core is also offered under a commercial license
  ([COMMERCIAL.md](COMMERCIAL.md)). Receiving contributions under Apache-2.0
  lets the maintainer keep offering both without asking each contributor
  again. You keep your copyright. See [NOTICE](NOTICE), [OPEN-CORE.md](OPEN-CORE.md)
  and [TRADEMARKS.md](TRADEMARKS.md).

## Pull requests

- Target the `develop` branch, not `main`.
- Commit messages are in English, in the Conventional Commits form used by the
  history: `type(scope): what changed`.
- Run `make check` before opening the pull request. For a quicker loop,
  `make typecheck` and `make test-unit`.
- Add or update tests for every behavior change.
- Add one line to [`CHANGELOG.md`](CHANGELOG.md) under `## Non publié`. The
  changelog is in French; write it in English if you prefer and the
  maintainer will rewrite it.
- No real people or company names in code, tests or examples (`Acme`,
  `example.com`), and no real secrets.

## Where the guards live

The repository enforces its architecture with scripts and tests:

- `tests/scripts/` holds the contracts (`*-contract.ts`, `*-contract.sh`),
  wired into `make test-unit`.
- The file-size ratchet is `tests/scripts/code-size-debt.json`: files over
  600 lines are listed with their current size, may not grow, and leave the
  list once split.
- Module boundaries are checked by dependency-cruiser (`make deps-check`).

See [`docs/contributing/architecture.md`](docs/contributing/architecture.md)
for the architecture and the rules behind these guards.

`edge-setup/` and `protocol/` have their own guides:
[`edge-setup/CONTRIBUTING.md`](edge-setup/CONTRIBUTING.md) and
[`protocol/CONTRIBUTING.md`](protocol/CONTRIBUTING.md).

## Security

Never report a vulnerability in a public issue: follow
[`SECURITY.md`](SECURITY.md).

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
