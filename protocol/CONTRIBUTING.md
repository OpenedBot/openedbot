# Contributing to openedbot-protocol

This repository holds the wire contract between openedbot (cloud) and
edge-setup (host). A change here changes what a remote cloud may ask of
someone's server, so changes are deliberate, small and tested on both sides.

## Before you start

- Open an issue with the "Protocol change proposal" template before writing
  code. Typos and clarifications can go straight to a pull request.
- Security issues: follow [SECURITY.md](SECURITY.md), never a public issue.
- This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun run check      # tsc type-check + codec, allowlist and fixture-schema tests
```

The reference implementations live in sibling repositories. With
`../openedbot-main` and `../edge-setup` checked out next to this one,
`bun run sync` refreshes the codec, tests, vectors and spec body from them.

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

One logical change per commit, with a message that explains why. By
contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).
