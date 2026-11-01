# Changelog

All notable changes to the openedbot connector protocol. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the specification
uses [semantic versioning](https://semver.org/) as described in
[SPEC.md](SPEC.md#versioning).

## [Unreleased]

## [1.0.0] - 2026-10-28

First versioned release of the specification. Wire protocol `1`.

### Added
- Version table and versioning rules at the top of `SPEC.md`.
- Normative test vectors in `connector/fixtures/` (relay frames and gateway
  route allowlist), identical to the ones in edge-setup `test/golden/`.
- Self-contained TypeScript package: `bun install && bun run check` type-checks
  the codec and runs the vector, allowlist and fixture-schema tests.
- `scripts/sync-from-siblings.sh` to refresh sources, tests, vectors and the
  spec body from the two reference implementations.

### Changed
- Spec body and codec synced with the current implementations (product name
  openedbot, current frame set and allowlist).
- `isUuid` is vendored in `connector/src/uuid.ts`; the package no longer
  depends on a workspace package.
