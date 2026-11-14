# Contributing to openedbot-protocol

This repository holds the wire contract between openedbot (cloud) and
edge-setup (host). A change here changes what a remote cloud may ask of
someone's server, so changes are deliberate, small and tested on both sides.

## Before you start

- Open an issue describing the protocol change before writing code. Typos and clarifications can go straight to a pull request.
- Security issues: follow [SECURITY.md](SECURITY.md), never a public issue.
- This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

You need [Bun](https://bun.sh) 1.4.4 (the version pinned by `packageManager` in the root `package.json`).

```bash
bun install
bun run check      # tsc type-check + codec, allowlist and fixture-schema tests
```

The codec in `connector/src` is edited here: it is the source the monorepo
re-exports. The reference implementations live in the same monorepo (the
root and `../edge-setup`); `bun run sync` refreshes the tests, vectors and spec
body from them, never the codec.

## Rules

- **Vectors first.** Every new or changed frame or route comes with test
  vectors in `connector/fixtures/` (accepted and refused cases).
- **Version every change.** Update the version table in `SPEC.md`,
  `package.json` and `CHANGELOG.md` following [SPEC.md](SPEC.md#versioning).
  `bun run check` fails when they disagree.
- **Default deny.** The allowlist only grows with a written reason; no
  administration verb is ever relayed.
- No real people or company names in examples (`Acme`, `example.com`,
  `203.0.113.0/24`), no real secrets in fixtures, and no em dash character.

## Commits and pull requests

One logical change per commit, with a message that explains why. Sign every
commit with `git commit -s`: the `Signed-off-by:` line certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) and
must match the commit author. To fix a missing sign-off, run
`git commit --amend -s --no-edit` (last commit) or
`git rebase --signoff <base>` (whole branch). By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
