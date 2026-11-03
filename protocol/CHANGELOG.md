# Changelog

All notable changes to the openedbot connector protocol. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the specification
uses [semantic versioning](https://semver.org/) as described in
[SPEC.md](SPEC.md#versioning).

## [Unreleased]

### Added
- `inventory.changed` (host → openedbot, no field): the host's inventory files
  moved, or a session starts. Sent only when `link.context.accepts` names it.
- `link.context.accepts`: the optional host frames this openedbot understands
  (at most 16 frame types). Older hosts ignore the field.
- Vectors for both.
- Host feature `skills_inventory` and host route `GET /hermes-setup/skills`:
  the root skills read by the host operator, same shape as `/v1/skills`. A
  fallback for Hermes builds whose `/v1/skills` fails.
- Host feature `profile_toolsets_batch` and host route
  `POST /hermes-setup/profiles/{slug}/toolsets`: several toolsets of one
  profile in one write (one process for both directions on the host), one
  read-back state per name. Without it openedbot writes them one request at
  a time.
- `POST /hermes-setup/profiles` accepts `bundledSkills: false` and answers the
  bundled-skills state when the creation turned them off. A host that ignores
  the field answers without it; openedbot then writes them through
  `POST /hermes-setup/profiles/{slug}/bundled-skills`.

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
